import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs, { createReadStream } from 'fs';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { Datastore } from '@google-cloud/datastore';
import { Storage } from '@google-cloud/storage';
import compression from 'compression';
import { GoogleGenAI, Type } from '@google/genai';
import {
    ALLOWED_GAMEPLAY_MIME,
    extFromMime,
    veoBudgetFor,
    validateUploadRequest,
    parseOwnBucketUri,
} from './lib/autopilot.js';
import {
    JOB_STATUS,
    VARIANT_STAGE,
    ACTION,
    validateJobSpec,
    createJob,
    nextAction,
    isTerminal,
    setAvatarCandidates,
    regenerateAvatar,
    useUploadedAvatar,
    approveAvatar,
    avatarUriForVariant,
    applyScript,
    applyClip,
    applyCompose,
    failVariant,
    finalise,
    cancelJob,
    canUseVeo,
    summarise,
    actionKey,
} from './lib/autopilot-job.js';
import { composeVideo, probeMedia } from './lib/compose.js';

const require = createRequire(import.meta.url);
const multer = require('multer');
const execFileAsync = promisify(execFile);

// --- CONFIGURATION ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8080;

// Default to PRODUCTION unless explicitly 'development'
// This ensures Cloud Run behaves like production even if NODE_ENV is missing
const IS_PRODUCTION = process.env.NODE_ENV !== 'development';

console.log(`[Init] Starting server. Production Mode: ${IS_PRODUCTION}`);

// --- DATABASE SETUP ---
let dbInstance = null;
const mockDbStore = { logs: [] };

const getDb = () => {
    if (dbInstance) return dbInstance;
    try {
        const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
        const databaseId = process.env.DATASTORE_DATABASE || 'gamerhead';
        const opts = { databaseId };
        if (projectId) opts.projectId = projectId;
        console.log(`🔌 [DB] Initializing Datastore — project: ${projectId || 'auto'}, database: ${databaseId}`);
        dbInstance = new Datastore(opts);
        return dbInstance;
    } catch (error) {
        console.warn("⚠️ [DB] Connection failed (using mock):", error.message);
        return null;
    }
};

// --- EXPRESS APP SETUP ---
const app = express();

// 1. TOP LEVEL REQUEST LOGGER
app.use((req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.url}`);
    next();
});

app.set('trust proxy', true);
app.use(compression());
app.use(express.json({ limit: '50mb' }));

// --- AUTHENTICATION & USER IDENTITY MIDDLEWARE ---
const basicAuthUsersStr = process.env.BASIC_AUTH_USERS;

if (basicAuthUsersStr) {
    // Parse "user1:pass1,user2:pass2" into an array of objects
    const validUsers = basicAuthUsersStr.split(',').map(pair => {
        const [u, p] = pair.split(':');
        return { user: u, pass: p };
    }).filter(u => u.user && u.pass);

    console.log(`🔒 [Auth] Basic Authentication enabled for ${validUsers.length} user(s).`);
    
    app.use((req, res, next) => {
        // Skip auth for health checks
        if (req.path === '/healthz' || req.path === '/api/health') {
            return next();
        }
        
        const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
        const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

        if (login && password) {
            const isValid = validUsers.some(u => u.user === login && u.pass === password);
            if (isValid) {
                // Set the user identity for logging
                req.userEmail = login;
                return next();
            }
        }

        res.set('WWW-Authenticate', 'Basic realm="GamerHeads Login"');
        res.status(401).send('Authentication required.');
    });
} else {
    console.log(`🔓 [Auth] No Basic Auth configured. Relying on IAP or public access.`);
    
    // IAP Identity Extraction Middleware
    app.use((req, res, next) => {
        const iapEmail = req.headers['x-goog-authenticated-user-email'];
        if (iapEmail) {
            req.userEmail = iapEmail.replace('accounts.google.com:', '');
        }
        next();
    });
}

// --- GOOGLE SIGN-IN CONFIG ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const AUTHORIZED_USERS = (process.env.AUTHORIZED_USERS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const AUTHORIZED_DOMAIN = (process.env.AUTHORIZED_DOMAIN || '').trim().toLowerCase();

// --- ADMIN AUTHORIZATION ---
// Explicit admin allowlist. If unset, fall back to AUTHORIZED_USERS (every
// whitelisted user is an admin — the historical behaviour). If neither is set
// the app is open to any authenticated identity, so admin access is DENIED
// rather than left wide open.
const ADMIN_USERS = (process.env.ADMIN_USERS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const adminAllowlist = ADMIN_USERS.length ? ADMIN_USERS : AUTHORIZED_USERS;

const isAdminEmail = (email) => {
    if (!email) return false;
    if (!adminAllowlist.length) return false;
    return adminAllowlist.includes(String(email).trim().toLowerCase());
};

if (ADMIN_USERS.length) {
    console.log(`👑 [Auth] Admins: ${ADMIN_USERS.join(', ')}`);
} else if (AUTHORIZED_USERS.length) {
    console.log(`👑 [Auth] ADMIN_USERS unset — falling back to AUTHORIZED_USERS for admin access.`);
} else {
    console.warn(`⚠️  [Auth] Neither ADMIN_USERS nor AUTHORIZED_USERS is set — /api/admin/* is disabled.`);
}

// Gate for /api/admin/* — must run after identity has been resolved.
const adminOnly = (req, res, next) => {
    if (isAdminEmail(req.userEmail)) return next();
    console.warn(`[Auth] Admin access denied for ${req.userEmail || 'anonymous'} → ${req.originalUrl}`);
    return res.status(403).json({
        error: adminAllowlist.length
            ? 'Admin access required.'
            : 'Admin access is disabled. Set ADMIN_USERS to enable the dashboard.'
    });
};

if (GOOGLE_CLIENT_ID) {
    console.log(`🔐 [Auth] Google Sign-In enabled. Client ID: ${GOOGLE_CLIENT_ID.slice(0, 12)}...`);
    if (AUTHORIZED_USERS.length) console.log(`   Authorized users: ${AUTHORIZED_USERS.join(', ')}`);
    else if (AUTHORIZED_DOMAIN) console.log(`   Authorized domain: ${AUTHORIZED_DOMAIN}`);
    else console.log(`   Any Google account can access.`);
}

// Verify Google ID token using google-auth-library (transitive dep via @google-cloud/datastore)
const verifyGoogleToken = async (idToken) => {
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    return ticket.getPayload(); // { email, name, picture, ... }
};

// --- ROUTES ---

// Health Check (Root) - Useful for load balancers
app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

// Health Check (API) - Used by Dashboard
app.get('/api/health', (req, res) => {
    const db = getDb();
    res.json({
        status: 'ok',
        route: '/api/health',
        database: db ? 'connected' : 'mock',
        env: IS_PRODUCTION ? 'production' : 'development',
        timestamp: Date.now()
    });
});

// Public config endpoint — returns non-secret settings needed by the frontend
app.get('/api/config', (req, res) => {
    res.json({ googleClientId: GOOGLE_CLIENT_ID || null });
});

// Token verification endpoint — called by frontend after Google Sign-In
app.post('/api/auth/verify', async (req, res) => {
    if (!GOOGLE_CLIENT_ID) return res.json({ email: null, name: null, picture: null });

    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });

    try {
        const payload = await verifyGoogleToken(idToken);
        const email = (payload.email || '').toLowerCase();

        // Check authorization
        if (AUTHORIZED_USERS.length && !AUTHORIZED_USERS.includes(email)) {
            console.warn(`[Auth] Unauthorized login attempt: ${email}`);
            return res.status(403).json({ error: `Access denied. ${email} is not on the authorized users list.` });
        }
        if (AUTHORIZED_DOMAIN && !email.endsWith(`@${AUTHORIZED_DOMAIN}`)) {
            console.warn(`[Auth] Unauthorized domain login attempt: ${email}`);
            return res.status(403).json({ error: `Access denied. Only @${AUTHORIZED_DOMAIN} accounts are allowed.` });
        }

        console.log(`[Auth] Signed in: ${email}`);
        res.json({ email: payload.email, name: payload.name, picture: payload.picture });
    } catch (err) {
        console.error('[Auth] Token verification failed:', err.message);
        res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
    }
});

// Google token verification middleware for all /api/* routes (when enabled)
const googleAuthMiddleware = async (req, res, next) => {
    if (!GOOGLE_CLIENT_ID) return next(); // Auth not configured, skip

    // Skip public endpoints
    const publicPaths = ['/api/health', '/api/config', '/api/auth/verify'];
    if (publicPaths.includes(req.path)) return next();

    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!idToken) {
        return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    }

    try {
        const payload = await verifyGoogleToken(idToken);
        const email = (payload.email || '').toLowerCase();

        if (AUTHORIZED_USERS.length && !AUTHORIZED_USERS.includes(email)) {
            return res.status(403).json({ error: 'Access denied.' });
        }
        if (AUTHORIZED_DOMAIN && !email.endsWith(`@${AUTHORIZED_DOMAIN}`)) {
            return res.status(403).json({ error: 'Access denied.' });
        }

        req.userEmail = payload.email;
        next();
    } catch (err) {
        console.warn('[Auth] Invalid token on API call:', err.message);
        res.status(401).json({ error: 'Token expired or invalid. Please sign in again.' });
    }
};

// API Router
const apiRouter = express.Router();
apiRouter.use(googleAuthMiddleware);

// Identity of the caller. Falls back to a browser-generated id so that
// deployments without any auth still keep each browser's history separate.
const ownerKeyOf = (req) => {
    if (req.userEmail) return String(req.userEmail).toLowerCase();
    const clientId = req.headers['x-gh-user-id'];
    if (typeof clientId === 'string' && clientId.trim()) return `anon:${clientId.trim()}`;
    return null;
};

// GET /api/me — who am I, and am I an admin?
apiRouter.get('/me', (req, res) => {
    res.json({
        email: req.userEmail || null,
        isAdmin: isAdminEmail(req.userEmail),
        adminEnabled: adminAllowlist.length > 0,
    });
});

// ── PROJECT HISTORY ────────────────────────────────────────────────────────
// Datastore kind 'Project' — one entity per saved project, scoped to its owner.
const PROJECT_KIND = 'Project';

// Datastore indexes every property by default and caps indexed values at 1500
// bytes. `excludeFromIndexes` only accepts explicit leaf paths, so listing the
// top-level object name does NOT cover nested fields — a base64
// `avatarConfig.referenceImage` blew up every save with
// `INVALID_ARGUMENT: The value of property "referenceImage" is longer than 1500 bytes`.
// The working set is therefore stored as one unindexed JSON string, and only
// the small fields the history list actually needs stay indexed.
const PROJECT_PAYLOAD_PROPERTY = 'payload';

// Datastore's hard entity limit is ~1 MiB; stay clear of it.
const MAX_PAYLOAD_BYTES = 900 * 1024;

// A gs:// URI is at most bucket(63) + a fixed path, so ~200 bytes is generous.
// This matters because avatarImageGcsUri is client-supplied and gets written to
// an INDEXED property, where Datastore rejects anything over 1500 bytes — the
// same failure class that made every save fail when a base64 reference image
// ended up indexed.
const MAX_GCS_URI_LENGTH = 500;

const isSaneGcsUri = (value) =>
    typeof value === 'string' &&
    value.startsWith('gs://') &&
    value.length <= MAX_GCS_URI_LENGTH;

/**
 * Remove data that must never be persisted in Datastore: inline base64 images
 * and blob/data URLs. They are either huge or meaningless outside the tab that
 * produced them.
 */
const stripHeavyFields = (payload) => {
    const clone = JSON.parse(JSON.stringify(payload ?? {}));

    if (clone.avatarConfig && typeof clone.avatarConfig === 'object') {
        // The inline base64 goes; the gs:// URI it was uploaded to stays, so a
        // restored project can put the reference image back.
        delete clone.avatarConfig.referenceImage;
    }
    if (Array.isArray(clone.avatarHistory)) {
        clone.avatarHistory = clone.avatarHistory
            .filter(a => a && isSaneGcsUri(a.gcsUri))
            .slice(0, 24)
            .map(a => ({
                gcsUri: a.gcsUri,
                prompt: typeof a.prompt === 'string' ? a.prompt.slice(0, 500) : '',
                aspectRatio: a.aspectRatio || null,
                createdAt: a.createdAt || null,
            }));
    }
    if (clone.avatarImageGcsUri !== undefined && clone.avatarImageGcsUri !== null
        && !isSaneGcsUri(clone.avatarImageGcsUri)) {
        console.warn('[Projects] Dropping implausible avatarImageGcsUri');
        delete clone.avatarImageGcsUri;
    }
    if (clone.avatarConfig && clone.avatarConfig.referenceImageGcsUri !== undefined
        && !isSaneGcsUri(clone.avatarConfig.referenceImageGcsUri)) {
        delete clone.avatarConfig.referenceImageGcsUri;
    }
    if (Array.isArray(clone.segments)) {
        clone.segments = clone.segments.map(seg => {
            const s = { ...seg };
            delete s.videoUrl;
            delete s.videoOptions;
            delete s.isGenerating;
            delete s.generatedUsingPrevUrl;
            // A data: URL here means the clip was returned inline and never
            // reached GCS — it cannot be restored, so don't store megabytes of it.
            if (s.videoGcsUri !== undefined && !isSaneGcsUri(s.videoGcsUri)) {
                delete s.videoGcsUri;
            }
            if (Array.isArray(s.videoOptionGcsUris)) {
                s.videoOptionGcsUris = s.videoOptionGcsUris.map(u => (isSaneGcsUri(u) ? u : null));
            }
            return s;
        });
    }
    return clone;
};

const projectToJson = (entity, database) => {
    const key = entity[database.KEY];
    let payload = {};
    try {
        payload = entity[PROJECT_PAYLOAD_PROPERTY] ? JSON.parse(entity[PROJECT_PAYLOAD_PROPERTY]) : {};
    } catch (err) {
        console.warn('[Projects] Corrupt payload, returning empty project body:', err.message);
    }
    return {
        id: String(key.id || key.name),
        name: entity.name || 'Untitled project',
        ownerEmail: entity.ownerEmail,
        gameInfo: payload.gameInfo || null,
        avatarConfig: payload.avatarConfig || null,
        scriptText: payload.scriptText || null,
        segments: payload.segments || [],
        exports: payload.exports || [],
        avatarImageGcsUri: payload.avatarImageGcsUri || null,
        avatarHistory: payload.avatarHistory || [],
        gameplayFileMeta: payload.gameplayFileMeta || null,
        createdAt: entity.createdAt ? new Date(entity.createdAt).getTime() : null,
        updatedAt: entity.updatedAt ? new Date(entity.updatedAt).getTime() : null,
    };
};

// GET /api/projects — list the caller's projects, newest first (summaries only)
apiRouter.get('/projects', async (req, res) => {
    const owner = ownerKeyOf(req);
    if (!owner) return res.status(401).json({ error: 'Cannot determine caller identity.' });

    const database = getDb();
    if (!database) return res.json({ projects: [] });

    try {
        const query = database.createQuery(PROJECT_KIND).filter('ownerEmail', '=', owner);
        const [entities] = await database.runQuery(query);
        const projects = entities
            .map(e => ({
                id: String(e[database.KEY].id || e[database.KEY].name),
                name: e.name || 'Untitled project',
                gameTitle: e.gameTitle || null,
                gameUrl: e.gameUrl || null,
                targetAspectRatio: e.targetAspectRatio || null,
                layoutType: e.layoutType || null,
                segmentCount: e.segmentCount || 0,
                exportCount: e.exportCount || 0,
                hasScript: Boolean(e.hasScript),
                hasAvatar: Boolean(e.hasAvatar),
                avatarImageGcsUri: e.avatarImageGcsUri || null,
                createdAt: e.createdAt ? new Date(e.createdAt).getTime() : null,
                updatedAt: e.updatedAt ? new Date(e.updatedAt).getTime() : null,
            }))
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, 100);
        res.json({ projects });
    } catch (err) {
        console.error('[Projects] list failed:', err);
        res.status(500).json({ error: 'Failed to list projects: ' + err.message });
    }
});

// GET /api/projects/:id — full project payload (owner only)
apiRouter.get('/projects/:id', async (req, res) => {
    const owner = ownerKeyOf(req);
    if (!owner) return res.status(401).json({ error: 'Cannot determine caller identity.' });

    const database = getDb();
    if (!database) return res.status(404).json({ error: 'Project not found' });

    try {
        const key = database.key([PROJECT_KIND, database.int(req.params.id)]);
        const [entity] = await database.get(key);
        if (!entity) return res.status(404).json({ error: 'Project not found' });
        if (entity.ownerEmail !== owner) {
            console.warn(`[Projects] ${owner} tried to read project owned by ${entity.ownerEmail}`);
            return res.status(404).json({ error: 'Project not found' });
        }
        res.json(projectToJson(entity, database));
    } catch (err) {
        console.error('[Projects] get failed:', err);
        res.status(500).json({ error: 'Failed to load project: ' + err.message });
    }
});

// POST /api/projects — create or update. Body: { id?, name, gameInfo, avatarConfig,
// scriptText, segments, exports, avatarImageGcsUri }
apiRouter.post('/projects', async (req, res) => {
    const owner = ownerKeyOf(req);
    if (!owner) return res.status(401).json({ error: 'Cannot determine caller identity.' });

    const database = getDb();
    if (!database) return res.status(503).json({ error: 'Datastore unavailable; project not saved.' });

    const { id, name, gameInfo, avatarConfig, scriptText, segments,
            exports: exportList, avatarImageGcsUri, avatarHistory,
            gameplayFileMeta } = req.body || {};

    try {
        const now = new Date();
        let key;
        let createdAt = now;

        if (id) {
            key = database.key([PROJECT_KIND, database.int(id)]);
            const [existing] = await database.get(key);
            if (!existing) return res.status(404).json({ error: 'Project not found' });
            if (existing.ownerEmail !== owner) {
                console.warn(`[Projects] ${owner} tried to overwrite project owned by ${existing.ownerEmail}`);
                return res.status(404).json({ error: 'Project not found' });
            }
            createdAt = existing.createdAt ? new Date(existing.createdAt) : now;
        } else {
            key = database.key([PROJECT_KIND]);
        }

        const body = stripHeavyFields({
            gameInfo: gameInfo || null,
            avatarConfig: avatarConfig || null,
            scriptText: typeof scriptText === 'string' ? scriptText : null,
            segments: Array.isArray(segments) ? segments : [],
            exports: Array.isArray(exportList) ? exportList : [],
            avatarImageGcsUri: avatarImageGcsUri || null,
            avatarHistory: Array.isArray(avatarHistory) ? avatarHistory : [],
            gameplayFileMeta: gameplayFileMeta || null,
        });

        const payload = JSON.stringify(body);
        if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
            return res.status(413).json({
                error: 'Project is too large to save. Try trimming the script or the number of clips.'
            });
        }

        const data = {
            ownerEmail: owner,
            name: (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 200) : 'Untitled project',
            // Indexed summary fields for the history list. Truncated so they can
            // never trip the 1500-byte index limit.
            gameTitle: (body.gameInfo?.title || '').slice(0, 300) || null,
            gameUrl: (body.gameInfo?.url || '').slice(0, 500) || null,
            targetAspectRatio: body.gameInfo?.targetAspectRatio || null,
            layoutType: body.gameInfo?.layoutType || null,
            segmentCount: body.segments.length,
            exportCount: body.exports.length,
            hasScript: Boolean(body.scriptText),
            hasAvatar: Boolean(body.avatarImageGcsUri),
            avatarImageGcsUri: body.avatarImageGcsUri || null,
            createdAt,
            updatedAt: now,
            [PROJECT_PAYLOAD_PROPERTY]: payload,
        };

        await database.save({ key, data, excludeFromIndexes: [PROJECT_PAYLOAD_PROPERTY] });
        const savedId = String(key.id || key.name);
        console.log(`[Projects] Saved ${savedId} for ${owner} (${Buffer.byteLength(payload, 'utf8')} bytes)`);
        res.json({ id: savedId, updatedAt: now.getTime(), createdAt: createdAt.getTime() });
    } catch (err) {
        console.error('[Projects] save failed:', err);
        res.status(500).json({ error: 'Failed to save project: ' + err.message });
    }
});

// DELETE /api/projects/:id — owner only
apiRouter.delete('/projects/:id', async (req, res) => {
    const owner = ownerKeyOf(req);
    if (!owner) return res.status(401).json({ error: 'Cannot determine caller identity.' });

    const database = getDb();
    if (!database) return res.status(503).json({ error: 'Datastore unavailable.' });

    try {
        const key = database.key([PROJECT_KIND, database.int(req.params.id)]);
        const [entity] = await database.get(key);
        if (!entity) return res.status(404).json({ error: 'Project not found' });
        if (entity.ownerEmail !== owner) {
            return res.status(404).json({ error: 'Project not found' });
        }
        await database.delete(key);
        res.json({ deleted: true });
    } catch (err) {
        console.error('[Projects] delete failed:', err);
        res.status(500).json({ error: 'Failed to delete project: ' + err.message });
    }
});

apiRouter.post('/log', async (req, res) => {
    const entry = {
        ...req.body,
        userEmail: req.userEmail || req.body.userEmail || null,
        timestamp: req.body.timestamp ? new Date(req.body.timestamp) : new Date(),
        _serverTime: new Date()
    };

    const database = getDb();
    try {
        if (database) {
            try {
                // Datastore API: Create a key and entity
                const key = database.key('GenerationLog');
                const entity = {
                    key: key,
                    data: entry
                };
                await database.save(entity);
            } catch (dbErr) {
                console.warn("⚠️ [API] Datastore save failed, falling back to mock storage:", dbErr.message);
                mockDbStore.logs.unshift(entry);
                if (mockDbStore.logs.length > 2000) mockDbStore.logs.pop();
            }
        } else {
            mockDbStore.logs.unshift(entry);
            // Limit mock storage to prevent overflow during long dev sessions
            if (mockDbStore.logs.length > 2000) mockDbStore.logs.pop();
        }
        res.status(200).json({ saved: true });
    } catch (e) {
        console.error("❌ [API] Log save failed:", e);
        res.status(500).json({ error: "Failed to save log" });
    }
});

apiRouter.get('/admin/stats', adminOnly, async (req, res) => {
    const database = getDb();
    const startTimeStr = req.query.from;
    const endTimeStr = req.query.to;

    let startDate = new Date();
    startDate.setDate(startDate.getDate() - 30); // Default to 30 days if not provided
    if (startTimeStr) startDate = new Date(startTimeStr);

    let endDate = new Date();
    if (endTimeStr) endDate = new Date(endTimeStr);

    // Limit query range to prevent massive data fetch if not using DB cursor
    // Max 100 days for safety if using full fetch
    const MAX_DAYS = 120;
    const diffTime = Math.abs(endDate - startDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
    
    if (diffDays > MAX_DAYS) {
        startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - MAX_DAYS);
    }

    try {
        let rawLogs = [];

        if (database) {
            console.log(`[Admin] Fetching logs from ${startDate.toISOString()} to ${endDate.toISOString()}`);
            
            try {
                const query = database.createQuery('GenerationLog')
                    .order('timestamp', { descending: true })
                    .limit(2000);
                
                const [entities] = await database.runQuery(query);
                
                console.log(`[Admin] Retrieved ${entities.length} documents from Datastore`);
                
                // Client-side filtering by date range
                rawLogs = entities
                    .map(entity => {
                        const id = entity[database.KEY].id || entity[database.KEY].name;
                        return { id, ...entity };
                    })
                    .filter(log => {
                        const ts = log.timestamp?.toDate ? log.timestamp.toDate() : new Date(log.timestamp);
                        return ts >= startDate && ts <= endDate;
                    });
                    
                console.log(`[Admin] Filtered to ${rawLogs.length} logs in date range`);
                
            } catch (dbError) {
                console.error("❌ [Admin] Datastore query failed:", dbError.message);
                // Fallback: try without orderBy if index is missing
                console.log("[Admin] Attempting fallback query without orderBy...");
                const query = database.createQuery('GenerationLog').limit(2000);
                const [entities] = await database.runQuery(query);
                
                rawLogs = entities
                    .map(entity => {
                        const id = entity[database.KEY].id || entity[database.KEY].name;
                        return { id, ...entity };
                    })
                    .filter(log => {
                        const ts = log.timestamp?.toDate ? log.timestamp.toDate() : new Date(log.timestamp);
                        return ts >= startDate && ts <= endDate;
                    });

                console.log(`[Admin] Fallback query returned ${rawLogs.length} filtered logs`);
            }
        } else {
            console.log("[Admin] Using mock store (no database connection)");
            // Mock Store Filter
            rawLogs = mockDbStore.logs.filter(l => {
                const ts = new Date(l.timestamp);
                return ts >= startDate && ts <= endDate;
            });
        }
        
        // Normalize Timestamps for Frontend
        const cleanedLogs = rawLogs.map(log => {
            let ts = log.timestamp;
            if (ts && typeof ts.toDate === 'function') ts = ts.toDate().getTime();
            else if (ts instanceof Date) ts = ts.getTime();
            else if (typeof ts === 'string') ts = new Date(ts).getTime();
            return { ...log, timestamp: ts };
        });

        console.log(`[Admin] Returning ${cleanedLogs.length} cleaned logs`);
        res.json({ logs: cleanedLogs });
    } catch (e) {
        console.error("❌ [API] Stats error:", e);
        console.error("Stack trace:", e.stack);
        res.status(500).json({ 
            error: e.message || "Failed to fetch logs",
            details: IS_PRODUCTION ? undefined : e.stack
        });
    }
});

// ============================================================
// VERTEX AI GEMINI PROXY ROUTES
// ============================================================

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
const GCP_LOCATION = process.env.GCP_LOCATION || 'us-central1';

// Regional client — for text/multimodal Gemini models
const getVertexAIClient = () => {
    if (!GCP_PROJECT_ID) {
        throw new Error('GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT environment variable is not set.');
    }
    return new GoogleGenAI({
        vertexai: true,
        project: GCP_PROJECT_ID,
        location: GCP_LOCATION   // e.g. us-central1
    });
};

// Veo client — always uses us-central1 regardless of Cloud Run deployment region
// Veo models are only available in us-central1
const getVeoClient = () => {
    if (!GCP_PROJECT_ID) {
        throw new Error('GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT environment variable is not set.');
    }
    return new GoogleGenAI({
        vertexai: true,
        project: GCP_PROJECT_ID,
        location: 'us-central1'
    });
};

// Global client — required for gemini-3.1-flash-image and Veo models
const getVertexAIGlobalClient = () => {
    if (!GCP_PROJECT_ID) {
        throw new Error('GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT environment variable is not set.');
    }
    return new GoogleGenAI({
        vertexai: true,
        project: GCP_PROJECT_ID,
        location: 'global'
    });
};

// ── VIDEO GENERATION MODELS ────────────────────────────────────────────────
//
// Default is Gemini Omni 1.1 Flash (Preview), which does NOT use the Veo
// long-running-prediction API. It is served by the Interactions API:
//
//   POST https://aiplatform.googleapis.com/v1beta1/projects/<p>/locations/global/interactions
//
// Differences that drive the code below
// (https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/omni-1-1-flash):
//   * Region: `global` only — there is no regional host, unlike Veo's us-central1.
//   * Image input is documented as a Cloud Storage `uri`, so the start frame is
//     uploaded to the bucket first rather than sent as inline base64.
//   * `duration` is a string in seconds, "3s".."10s" (Veo took an integer 4/6/8).
//   * `resolution` accepts 360p/720p/1080p/4k and defaults to 720p.
//   * System instructions are NOT supported, so any caller-supplied one is dropped.
//   * Output arrives in `steps[]` as a `model_output` step containing a `video`
//     content item — not in `response.videos[]`.
//   * Preview + fixed-quota only: no PayGo, no Provisioned Throughput. A project
//     without quota gets an error, which is why the Veo path is kept selectable.
// Two Gemini Omni video models exist, both on the Interactions API:
//   * gemini-omni-1.1-flash-preview — 360p/720p/1080p/4k, needs fixed quota
//   * gemini-omni-flash-preview     — 720p only, has quota by default
// The 1.1 model is the primary; if the project has not been granted quota for
// it, the server transparently falls back to gemini-omni-flash-preview.
// Script / shot-list model. Gemini 3.7 Flash (GA, released 2026-08-13) supports
// everything this app needs: system instructions, structured output
// (responseMimeType + responseSchema), Google Search grounding, and video input,
// on the `global` endpoint. Note it is a thinking model with MEDIUM by default;
// thinking_level="MINIMAL" is rejected, so we simply never set it.
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-7-flash
const GEMINI_SCRIPT_MODEL = process.env.SCRIPT_MODEL || 'gemini-3.7-flash';

const GEMINI_VIDEO_MODEL = 'gemini-omni-1.1-flash-preview';
const GEMINI_VIDEO_FALLBACK = 'gemini-omni-flash-preview';
const VIDEO_MODEL_DEFAULT = process.env.VIDEO_MODEL || GEMINI_VIDEO_MODEL;
const VIDEO_MODEL_FALLBACK = process.env.VIDEO_MODEL_FALLBACK || GEMINI_VIDEO_FALLBACK;
// Last-resort safety net when every Gemini Omni model is out of quota. Veo is
// pay-as-you-go, so it is always available. Deliberately not exposed in the UI —
// set to an empty string to disable the net entirely.
const VIDEO_MODEL_LAST_RESORT = process.env.VIDEO_MODEL_LAST_RESORT ?? 'veo-3.1-fast-generate-001';
const VIDEO_RESOLUTION_DEFAULT = process.env.VIDEO_RESOLUTION || '720p';

// ── Autopilot (batch one-shot production) ────────────────────────────────────
// Autopilot turns one brief into N finished videos without per-step operation.
// It is additive: when AUTOPILOT_ENABLED is unset every /api/autopilot/* route
// 404s and the existing wizard is untouched.
const AUTOPILOT_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.AUTOPILOT_ENABLED || ''));
const AUTOPILOT_MAX_BATCH = Math.max(1, Number(process.env.AUTOPILOT_MAX_BATCH) || 10);
const AUTOPILOT_CONCURRENCY = Math.max(1, Number(process.env.AUTOPILOT_CONCURRENCY) || 4);
const AUTOPILOT_COMPOSE_CONCURRENCY = Math.max(1, Number(process.env.AUTOPILOT_COMPOSE_CONCURRENCY) || 2);
const AUTOPILOT_MAX_CLIPS_PER_JOB = Math.max(1, Number(process.env.AUTOPILOT_MAX_CLIPS_PER_JOB) || 60);
// Veo is kept as the safety net (it honours personGeneration: allow_adult, the
// only rescue for Omni's non-deterministic block on photorealistic people), but
// it is pay-as-you-go. Cap how much of a batch may fall through to it so that
// "Omni is down" cannot silently turn into 40 billable Veo clips.
const AUTOPILOT_VEO_CLIP_BUDGET = process.env.AUTOPILOT_VEO_CLIP_BUDGET
    ? Math.max(0, Number(process.env.AUTOPILOT_VEO_CLIP_BUDGET))
    : null; // null → derive per job: max(4, ceil(totalClips * 0.25))

// Gameplay footage is uploaded straight to Cloud Storage with a signed URL.
// Cloud Run caps an HTTP/1 request body at 32 MiB and that limit cannot be
// raised, while the UI accepts gameplay up to 250 MB — so proxying the upload
// through the app is not an option.
const AUTOPILOT_UPLOAD_MAX_BYTES = Math.max(
    1,
    Number(process.env.AUTOPILOT_UPLOAD_MAX_BYTES) || 250 * 1024 * 1024
);
const AUTOPILOT_UPLOAD_TTL_MS = 60 * 60 * 1000; // 1 h: a 250 MB upload needs room
const AUTOPILOT_UPLOAD_PREFIX = 'autopilot/uploads';

const OMNI_ALLOWED_RESOLUTIONS = ['360p', '720p', '1080p', '4k'];
// gemini-omni-flash-preview only supports 720p; 1.1 supports the full set.
const OMNI_720P_ONLY_MODELS = ['gemini-omni-flash-preview'];

/** True when the model id is served by the Interactions API rather than Veo. */
const isInteractionsModel = (modelId) => !String(modelId || '').startsWith('veo-');

const interactionsUrl = (suffix = '') => {
    if (!GCP_PROJECT_ID) {
        throw new Error('GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT environment variable is not set.');
    }
    return `https://aiplatform.googleapis.com/v1beta1/projects/${GCP_PROJECT_ID}/locations/global/interactions${suffix}`;
};

/** Call the Interactions API with ADC credentials. POST to create, GET to read. */
const callInteractions = async (suffix, body, method = 'POST') => {
    const token = await getAccessToken();
    const url = interactionsUrl(suffix);
    const options = {
        method,
        headers: { 'Authorization': `Bearer ${token}` },
    };
    if (method === 'POST') {
        options.headers['Content-Type'] = 'application/json; charset=utf-8';
        options.body = JSON.stringify(body ?? {});
    }
    const resp = await fetch(url, options);
    const text = await resp.text();
    if (!resp.ok) {
        throw new Error(`Interactions API ${resp.status} on ${suffix || '/'}: ${text.slice(0, 600)}`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Interactions API returned non-JSON: ${text.slice(0, 300)}`);
    }
};

/**
 * Pull the generated video out of an interaction. The payload is a list of
 * `steps`; the one we want is `type: "model_output"` with a `video` content item
 * carrying either a `uri` (when response_format.gcs_uri was set) or inline `data`.
 */
const extractInteractionVideo = (interaction) => {
    const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
    for (const step of steps) {
        if (step?.type !== 'model_output') continue;
        for (const item of (Array.isArray(step.content) ? step.content : [])) {
            if (item?.type !== 'video') continue;
            if (typeof item.uri === 'string' && item.uri) return { uri: item.uri };
            if (typeof item.data === 'string' && item.data) return { data: item.data, mimeType: item.mime_type || 'video/mp4' };
        }
    }
    return null;
};

/**
 * Pull the failure reason out of a failed interaction.
 *
 * The payload carries it in a top-level `errors` ARRAY, e.g.
 *   { "errors": [ { "message": "...", "code": "content_blocked" } ] }
 * and mirrors it on the `model_output` step as `{ error: { code, message } }`.
 * There is no singular top-level `error` field.
 */
const extractInteractionError = (interaction) => {
    const first = Array.isArray(interaction?.errors) ? interaction.errors[0] : null;
    if (first?.message) return { code: first.code || null, message: String(first.message) };

    for (const step of (Array.isArray(interaction?.steps) ? interaction.steps : [])) {
        if (step?.error?.message) return { code: step.error.code || null, message: String(step.error.message) };
    }
    return { code: null, message: interaction?.status ? `status=${interaction.status}` : 'unknown failure' };
};

/** Model thoughts, useful when a generation comes back empty. */const extractInteractionThoughts = (interaction) => {
    const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
    for (const step of steps) {
        if (step?.type !== 'thought') continue;
        const texts = (Array.isArray(step.summary) ? step.summary : [])
            .filter(s => s?.type === 'text' && typeof s.text === 'string')
            .map(s => s.text);
        if (texts.length) return texts.join(' ').slice(0, 400);
    }
    return null;
};

// Get ADC access token for authenticated video download
// Works on Cloud Run (metadata server) and local dev (ADC / GOOGLE_APPLICATION_CREDENTIALS)
const getAccessToken = async () => {
    // 1. Try GCE/Cloud Run metadata server first
    try {
        const resp = await fetch(
            'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
            { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) }
        );
        if (resp.ok) {
            const { access_token } = await resp.json();
            return access_token;
        }
    } catch (_) { /* not on GCE, try ADC */ }

    // 2. Fallback: google-auth-library (transitive dep from @google-cloud/datastore)
    try {
        const { GoogleAuth } = await import('google-auth-library');
        const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const token = await auth.getAccessToken();
        return token;
    } catch (e) {
        throw new Error('Cannot obtain access token. Ensure ADC is configured: ' + e.message);
    }
};

// GCS Storage client (lazy init)
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || '';
let storageInstance = null;

const getStorage = () => {
    if (!storageInstance) {
        storageInstance = new Storage();
    }
    return storageInstance;
};

/**
 * Copy a Veo-generated video (gs:// URI) into the customer bucket.
 * Downloads via ADC bearer token (same approach as download-video),
 * then streams the upload to GCS using the Storage client.
 * Returns the new gs://bucket/object URI.
 */
const copyVideoToBucket = async (sourceUri) => {
    const token = await getAccessToken();

    // Download from Veo temp storage
    const resp = await fetch(sourceUri, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`Failed to download video from Veo (${resp.status}): ${errText}`);
    }

    // Build destination object name: videos/<timestamp>-<random>.mp4
    const objectName = `videos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;

    const storage = getStorage();
    const bucket = storage.bucket(GCS_BUCKET_NAME);
    const file = bucket.file(objectName);

    // Stream upload
    await new Promise((resolve, reject) => {
        const writeStream = file.createWriteStream({
            contentType: resp.headers.get('content-type') || 'video/mp4',
            resumable: false,
        });
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        resp.body.pipeTo(new WritableStream({
            write(chunk) { writeStream.write(chunk); },
            close() { writeStream.end(); },
            abort(err) { writeStream.destroy(err); }
        })).catch(reject);
    });

    const destUri = `gs://${GCS_BUCKET_NAME}/${objectName}`;
    console.log(`[GCS] Video copied to ${destUri}`);
    return destUri;
};

/**
 * Persist an image (data: URL or raw base64) to the customer bucket.
 * Used for generated avatars and for user-supplied reference images, so that a
 * restored project can put the streamer back on screen instead of forcing a
 * paid regeneration. Best-effort: returns null instead of throwing.
 */
const uploadImageToBucket = async ({ dataUrl, base64, mimeType = 'image/png', label = 'image', prefix = 'avatars' }) => {
    if (!GCS_BUCKET_NAME) {
        console.log('[GCS] No bucket configured — image not persisted.');
        return null;
    }

    let raw = base64;
    let mime = mimeType;
    if (dataUrl) {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
        if (!m) {
            console.warn('[GCS] uploadImageToBucket: unrecognised data URL');
            return null;
        }
        mime = m[1];
        raw = m[2];
    }
    if (!raw) return null;

    const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg'
              : mime.includes('webp') ? 'webp'
              : 'png';
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'image';
    const objectName = `${prefix}/${yyyy}/${mm}/${safeLabel}-${now.getTime()}-${randomUUID().slice(0, 8)}.${ext}`;

    try {
        await getStorage().bucket(GCS_BUCKET_NAME).file(objectName).save(Buffer.from(raw, 'base64'), {
            contentType: mime,
            resumable: false,
        });
        const uri = `gs://${GCS_BUCKET_NAME}/${objectName}`;
        console.log(`[GCS] Image saved to ${uri}`);
        return uri;
    } catch (err) {
        console.error('[GCS] Failed to persist image:', err.message);
        return null;
    }
};

/**
 * Persist a finished export (stitched / composited / subtitled video) to the
 * customer bucket under exports/YYYY/MM/. Returns the gs:// URI, or null when
 * no bucket is configured or the upload fails — callers must stay best-effort
 * so a storage hiccup never costs the user their render.
 */
const uploadExportToBucket = async ({ localPath, buffer, ext = 'mp4', contentType = 'video/mp4', label = 'export' }) => {
    if (!GCS_BUCKET_NAME) {
        console.log('[GCS] No bucket configured — export not persisted.');
        return null;
    }
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const objectName = `exports/${yyyy}/${mm}/${label}-${now.getTime()}-${randomUUID().slice(0, 8)}.${ext}`;

    try {
        const bucket = getStorage().bucket(GCS_BUCKET_NAME);
        if (localPath) {
            await bucket.upload(localPath, { destination: objectName, contentType, resumable: false });
        } else if (buffer) {
            await bucket.file(objectName).save(buffer, { contentType, resumable: false });
        } else {
            throw new Error('uploadExportToBucket requires localPath or buffer');
        }
        const uri = `gs://${GCS_BUCKET_NAME}/${objectName}`;
        console.log(`[GCS] Export saved to ${uri}`);
        return uri;
    } catch (err) {
        console.error('[GCS] Failed to persist export:', err.message);
        return null;
    }
};

// GET /api/admin/signed-url?uri=gs://bucket/path/file
// Returns a short-lived signed URL for a GCS object (admin only)
apiRouter.get('/admin/signed-url', adminOnly, async (req, res) => {
    const { uri } = req.query;
    if (!uri || !uri.startsWith('gs://')) {
        return res.status(400).json({ error: 'Invalid or missing gs:// uri' });
    }
    try {
        const withoutScheme = uri.slice(5); // remove "gs://"
        const slashIdx = withoutScheme.indexOf('/');
        if (slashIdx === -1) return res.status(400).json({ error: 'Invalid GCS URI' });
        const bucketName = withoutScheme.slice(0, slashIdx);

        // Only ever sign objects in this app's own bucket. Without this check the
        // endpoint can mint read URLs for any object the service account can see.
        if (!GCS_BUCKET_NAME || bucketName !== GCS_BUCKET_NAME) {
            console.warn(`[Admin] signed-url refused for foreign bucket: ${bucketName}`);
            return res.status(403).json({ error: 'URI is outside the configured application bucket.' });
        }
        const objectName = withoutScheme.slice(slashIdx + 1);

        const storage = getStorage();
        const [signedUrl] = await storage.bucket(bucketName).file(objectName).getSignedUrl({
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000, // 15 minutes
        });
        res.json({ url: signedUrl });
    } catch (err) {
        console.error('[Admin] signed-url error:', err);
        res.status(500).json({ error: 'Failed to generate signed URL: ' + err.message });
    }
});

// Safety settings for image generation
const SAFETY_SETTINGS_BLOCK_NONE = [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
];

// POST /api/gemini/generate-script
// Body: { prompt: string, inlineData?: { data: string, mimeType: string }, videoMimeType?: string, searchGrounding?: boolean, gameUrl?: string }
apiRouter.post('/gemini/generate-script', async (req, res) => {
    const { prompt, inlineData, videoMimeType, searchGrounding, gameUrl } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    try {
        const ai = getVertexAIGlobalClient();
        const parts = [{ text: prompt }];
        if (inlineData) parts.push({ inlineData });

        const response = await ai.models.generateContent({
            model: GEMINI_SCRIPT_MODEL,
            contents: [{ role: 'user', parts }],
            config: {
                systemInstruction: 'You are an expert content creator scriptwriter. You must strictly adhere to the provided pacing and word count rules (ranges per segment duration) to generate the script.',
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            id: { type: Type.INTEGER },
                            startTime: { type: Type.STRING },
                            endTime: { type: Type.STRING },
                            duration: { type: Type.INTEGER },
                            prompt: { type: Type.STRING },
                            dialogue: { type: Type.STRING }
                        },
                        required: ['id', 'startTime', 'endTime', 'duration', 'prompt', 'dialogue']
                    }
                },
                tools: searchGrounding ? [{ googleSearch: {} }] : undefined
            }
        });

        const rawSegments = JSON.parse(response.text || '[]');
        const validatedSegments = rawSegments.map(seg => {
            let d = seg.duration;
            if (d <= 4) d = 4;
            else if (d <= 6) d = 6;
            else d = 8;
            return { ...seg, duration: d };
        });

        const fullText = validatedSegments.map(s =>
            `[${s.startTime}]\n[Duration: ${s.duration}s]\n[Streamer Action: ${s.prompt}]\n[Streamer Dialogue: ${s.dialogue || '(No Dialogue)'}]\n`
        ).join('\n');

        const groundingUrls = [];
        if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
            response.candidates[0].groundingMetadata.groundingChunks.forEach(chunk => {
                if (chunk.web?.uri) groundingUrls.push(chunk.web.uri);
            });
        }

        res.json({ fullText, segments: validatedSegments, groundingUrls, inlineData: inlineData || null });
    } catch (err) {
        console.error('[Gemini] generate-script error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/gemini/analyze-script
// Body: { prompt: string }
apiRouter.post('/gemini/analyze-script', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    try {
        const ai = getVertexAIGlobalClient();
        const response = await ai.models.generateContent({
            model: GEMINI_SCRIPT_MODEL,
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            id: { type: Type.INTEGER },
                            startTime: { type: Type.STRING },
                            endTime: { type: Type.STRING },
                            duration: { type: Type.INTEGER },
                            prompt: { type: Type.STRING },
                            dialogue: { type: Type.STRING }
                        },
                        required: ['id', 'startTime', 'endTime', 'duration', 'prompt', 'dialogue']
                    }
                }
            }
        });

        const rawSegments = JSON.parse(response.text || '[]');
        const validatedSegments = rawSegments.map(seg => {
            let d = seg.duration;
            if (d <= 4) d = 4;
            else if (d <= 6) d = 6;
            else d = 8;
            return { ...seg, duration: d };
        });

        res.json(validatedSegments);
    } catch (err) {
        console.error('[Gemini] analyze-script error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/gemini/generate-avatar
// Body: { prompt: string, model: string, aspectRatio: string, referenceImageData?: string, referenceImageMime?: string }
apiRouter.post('/gemini/generate-avatar', async (req, res) => {
    const { prompt, model, aspectRatio, referenceImageData, referenceImageMime } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    try {
        const parts = [{ text: prompt }];
        if (referenceImageData) {
            parts.push({ inlineData: { mimeType: referenceImageMime || 'image/png', data: referenceImageData } });
        }

        const ai = getVertexAIGlobalClient();   // Image model requires global endpoint
        const resolvedModel = model || 'gemini-3.1-flash-image';
        console.log(`[Gemini] Avatar model: ${resolvedModel} (global endpoint)`);
        const response = await ai.models.generateContent({
            model: resolvedModel,
            contents: [{ role: 'user', parts }],
            config: {
                temperature: 0.5,
                responseModalities: ['IMAGE', 'TEXT'],
                imageConfig: {
                    aspectRatio: aspectRatio || '16:9',
                    imageSize: '1K'
                },
                safetySettings: SAFETY_SETTINGS_BLOCK_NONE
            }
        });

        if (response.candidates?.[0]?.content?.parts) {
            for (const part of response.candidates[0].content.parts) {
                if (part.inlineData) {
                    const imageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                    // Persist it: a generated avatar cannot be reproduced, and
                    // without a durable copy a restored project has no streamer
                    // and the Studio tab stays locked.
                    const gcsUri = await uploadImageToBucket({
                        base64: part.inlineData.data,
                        mimeType: part.inlineData.mimeType,
                        label: 'avatar',
                    });
                    return res.json({ imageData, gcsUri });
                }
            }
        }
        res.status(500).json({ error: 'No image generated in response' });
    } catch (err) {
        console.error('[Gemini] generate-avatar error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Start an image-to-video interaction on a Gemini Omni model. Returns the
 * interaction id, or throws. Quota errors are recognisable via err.isQuota.
 */
const startOmniInteraction = async ({ modelId, prompt, frameUri, ratio, secs, resolution }) => {
    let outResolution = OMNI_ALLOWED_RESOLUTIONS.includes(resolution) ? resolution : '720p';
    if (OMNI_720P_ONLY_MODELS.includes(modelId)) outResolution = '720p';

    const body = {
        model: modelId,
        // Asynchronous: the interaction is retained for 14 days and read back by
        // id. NOTE: the docs show `background` inside input[0], but the API
        // rejects that (400 invalid_request Unknown parameter 'background' at
        // 'input[0]'). It has to be top-level. Verified against the live API.
        background: true,
        input: [
            { type: 'text', text: prompt },
            { type: 'image', uri: frameUri, mime_type: 'image/png' },
        ],
        response_format: [{
            type: 'video',
            delivery: 'uri',
            gcs_uri: `gs://${GCS_BUCKET_NAME}/videos/`,
            aspect_ratio: ratio,
            resolution: outResolution,
            duration: `${secs}s`,
        }],
        generation_config: { video_config: { task: 'image_to_video' } },
    };

    console.log(`[Omni] interactions request — model=${modelId} ratio=${ratio} res=${outResolution} duration=${secs}s frame=${frameUri}`);
    try {
        const interaction = await callInteractions('', body);
        if (!interaction?.id) {
            throw new Error('Interactions API did not return an interaction id: ' + JSON.stringify(interaction).slice(0, 300));
        }
        return interaction.id;
    } catch (err) {
        if (/too_many_requests|Quota exceeded/i.test(err.message)) err.isQuota = true;
        throw err;
    }
};

/** Start a Veo long-running video generation. Returns the operation name. */
const startVeoOperation = async ({ modelId, prompt, imageBase64, ratio, durationSeconds }) => {
    const ai = getVeoClient();  // Veo is only available in us-central1
    const operation = await ai.models.generateVideos({
        model: modelId,
        prompt,
        image: { imageBytes: imageBase64, mimeType: 'image/png' },
        config: {
            numberOfVideos: 1,
            resolution: '720p',
            aspectRatio: ratio,
            durationSeconds: durationSeconds || 6,
            personGeneration: 'allow_adult',
        },
    });
    if (!operation?.name) throw new Error('Veo did not return an operation name');
    return operation.name;
};

// ── Content-blocked retry / Veo fallback plumbing ──────────────────────────
//
// The Interactions API only reveals a content_blocked failure at POLL time, by
// which point the poll request no longer has the prompt or the start frame. So
// the generation context is persisted (Datastore, keyed by the handle) when the
// job starts, and the poll endpoint looks it up to resubmit. Cloud Run runs
// multiple instances, so an in-memory map would not survive a poll landing on a
// different instance — Datastore is the safe store.
const VIDEO_JOB_KIND = 'VideoJob';
// The RAI filter is non-deterministic, so a plain retry on the same Omni model
// often passes. After this many blocked retries, fall through to Veo.
const VIDEO_BLOCK_RETRIES = Number(process.env.VIDEO_BLOCK_RETRIES ?? 1);

const saveVideoJob = async (handle, ctx) => {
    const db = getDb();
    if (!db) return; // best-effort; without it, retry just won't fire
    try {
        await db.save({
            key: db.key([VIDEO_JOB_KIND, handle]),
            data: {
                prompt: ctx.prompt,
                frameUri: ctx.frameUri || null,
                ratio: ctx.ratio,
                secs: ctx.secs,
                wantedResolution: ctx.wantedResolution,
                durationSeconds: ctx.durationSeconds ?? null,
                blockRetries: ctx.blockRetries || 0,
                createdAt: new Date(),
            },
            excludeFromIndexes: ['prompt'],
        });
    } catch (err) {
        console.warn('[VideoJob] save failed (retry disabled for this job):', err.message);
    }
};

const loadVideoJob = async (handle) => {
    const db = getDb();
    if (!db) return null;
    try {
        const [entity] = await db.get(db.key([VIDEO_JOB_KIND, handle]));
        return entity || null;
    } catch (err) {
        console.warn('[VideoJob] load failed:', err.message);
        return null;
    }
};

/** Download a gs:// object and return its base64 (for Veo's inline image input). */
const gcsObjectToBase64 = async (gcsUri) => {
    const withoutScheme = gcsUri.slice(5);
    const slashIdx = withoutScheme.indexOf('/');
    const bucketName = withoutScheme.slice(0, slashIdx);
    const objectName = withoutScheme.slice(slashIdx + 1);
    const [buf] = await getStorage().bucket(bucketName).file(objectName).download();
    return buf.toString('base64');
};

/**
 * Start a video generation and persist its context for retry. Walks the Omni
 * chain (primary → fallback), then Veo on quota exhaustion. Returns
 * { operationName, api, model, fallback }.
 */
const beginVideoJob = async (ctx) => {
    const { prompt, frameUri, ratio, secs, wantedResolution } = ctx;

    const chain = [ctx.primaryModel || VIDEO_MODEL_DEFAULT];
    if (VIDEO_MODEL_FALLBACK && VIDEO_MODEL_FALLBACK !== chain[0] && isInteractionsModel(VIDEO_MODEL_FALLBACK)) {
        chain.push(VIDEO_MODEL_FALLBACK);
    }

    let interactionId = null;
    let usedModel = null;
    let lastQuotaErr = null;
    for (const candidate of chain) {
        try {
            interactionId = await startOmniInteraction({ modelId: candidate, prompt, frameUri, ratio, secs, resolution: wantedResolution });
            usedModel = candidate;
            break;
        } catch (err) {
            if (err.isQuota) { lastQuotaErr = err; continue; }
            throw err;
        }
    }

    if (interactionId) {
        await saveVideoJob(interactionId, ctx);
        return { operationName: interactionId, api: 'interactions', model: usedModel, fallback: usedModel !== chain[0] };
    }

    // Every Omni candidate is out of quota → Veo safety net.
    if (VIDEO_MODEL_LAST_RESORT) {
        const imageBase64 = ctx.rawImageBase64 || (frameUri ? await gcsObjectToBase64(frameUri) : null);
        if (!imageBase64) throw new Error('No image available for Veo fallback');
        const veoOp = await startVeoOperation({
            modelId: VIDEO_MODEL_LAST_RESORT, prompt, imageBase64, ratio, durationSeconds: ctx.durationSeconds,
        });
        console.log(`[Veo] quota fallback operation ${veoOp}`);
        return { operationName: veoOp, api: 'veo', model: VIDEO_MODEL_LAST_RESORT, fallback: true };
    }

    const quotaErr = new Error(lastQuotaErr ? lastQuotaErr.message : 'no Omni quota');
    quotaErr.allQuota = true;
    throw quotaErr;
};

// POST /api/gemini/generate-video// Body: { prompt, imageBase64, aspectRatio, durationSeconds, model, resolution }
// Returns: { operationName: string, api: 'interactions' | 'veo' }
//
// `operationName` is an opaque handle the client hands back to
// /api/gemini/video-operation. For Gemini Omni it is an interaction id; for Veo
// it is a long-running-operation name.
apiRouter.post('/gemini/generate-video', async (req, res) => {
    const { prompt, imageBase64, aspectRatio, durationSeconds, model, resolution } = req.body;
    if (!prompt || !imageBase64) return res.status(400).json({ error: 'prompt and imageBase64 are required' });

    const modelId = model || VIDEO_MODEL_DEFAULT;
    const ratio = aspectRatio === '9:16' ? '9:16' : '16:9';
    // Callers may send either raw base64 or a full data: URL. Strip the prefix
    // once here: Veo rejects a data URL with "Invalid base64 encoded bytes", and
    // both paths (plus the Veo safety net) need the same normalised value.
    const rawImageBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

    try {
        // ── Gemini Omni via the Interactions API ────────────────────────────
        if (isInteractionsModel(modelId)) {
            if (!GCS_BUCKET_NAME) {
                return res.status(503).json({
                    error: 'GCS_BUCKET_NAME is required for Gemini Omni video generation: '
                         + 'the start frame is passed to the model as a Cloud Storage URI.'
                });
            }

            // The documented image input is a gs:// URI, so persist the start
            // frame first. It doubles as a record of what each clip was seeded from.
            const frameUri = await uploadImageToBucket({
                base64: rawImageBase64,
                mimeType: 'image/png',
                label: 'startframe',
                prefix: 'frames',
            });
            if (!frameUri) {
                return res.status(500).json({ error: 'Failed to stage the start frame in Cloud Storage.' });
            }

            // duration: integer 3..10 followed by "s"
            const secs = Math.min(10, Math.max(3, Math.round(Number(durationSeconds) || 8)));
            const wantedResolution = String(resolution || VIDEO_RESOLUTION_DEFAULT);

            try {
                const result = await beginVideoJob({
                    primaryModel: modelId,
                    prompt, frameUri, ratio, secs, wantedResolution,
                    durationSeconds, rawImageBase64,
                    blockRetries: 0,
                });
                if (result.fallback) console.log(`[Omni] started via fallback → ${result.model}`);
                console.log(`[Omni] ${result.api} handle ${result.operationName} (model=${result.model})`);
                return res.json(result);
            } catch (err) {
                if (err.allQuota) {
                    return res.status(429).json({
                        error: `No Gemini Omni model has quota in this project. These are Preview models with `
                             + `fixed quota only, so quota must be granted per base model. Original error: ${err.message}`
                    });
                }
                throw err;
            }
        }

        // ── Veo via predictLongRunning (reachable via VIDEO_MODEL) ──────────
        const veoOperation = await startVeoOperation({ modelId, prompt, imageBase64: rawImageBase64, ratio, durationSeconds });
        res.json({ operationName: veoOperation, api: 'veo', model: modelId });
    } catch (err) {
        console.error('[Gemini] generate-video error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/gemini/video-operation?name=xxx
// Returns: { done: bool, videoUri?: string, videoBase64?: string, error?: string }
//
// `name` is either a Gemini Omni interaction id or a Veo long-running-operation
// name; they are told apart by whether the value looks like an LRO path.
apiRouter.get('/gemini/video-operation', async (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const isVeoOperation = typeof name === 'string' && name.includes('/operations/');

    try {
        // ── Gemini Omni: read the interaction by id ─────────────────────────
        if (!isVeoOperation) {
            // Read with GET. The docs show POST for the retrieval call, but that
            // returns 404 against the live API; GET returns the interaction.
            const interaction = await callInteractions(`/${encodeURIComponent(name)}`, null, 'GET');
            const status = interaction?.status;
            console.log(`[Omni] interaction ${name} status=${status}`);

            if (status === 'in_progress' || status === 'queued' || status === 'pending') {
                return res.json({ done: false });
            }
            if (status && status !== 'completed') {
                // The failure detail lives in a top-level `errors` ARRAY (and is
                // mirrored on the model_output step) — not a singular `error`.
                // Reading the wrong shape is why this used to surface as a bare
                // "Video generation failed: failed" with no reason.
                const failure = extractInteractionError(interaction);
                console.warn(`[Omni] interaction ${name} ${status}: ${failure.code || 'unknown'} — ${failure.message}`);

                // The RAI filter rejects photorealistic people fairly often, and
                // this app's whole premise is a photorealistic streamer. The
                // filter is non-deterministic, so on a block we resubmit: retry
                // Omni a few times, then fall through to Veo (more permissive via
                // personGeneration: allow_adult). The client keeps polling the
                // handle we hand back, so the whole retry is transparent.
                const isBlocked = failure.code === 'content_blocked' || /Responsible AI|content_blocked/i.test(failure.message);
                if (isBlocked) {
                    const job = await loadVideoJob(name);
                    if (job) {
                        try {
                            const retries = job.blockRetries || 0;
                            if (retries < VIDEO_BLOCK_RETRIES) {
                                console.warn(`[Omni] ${name} content_blocked; retry ${retries + 1}/${VIDEO_BLOCK_RETRIES} on Omni`);
                                const r = await beginVideoJob({
                                    primaryModel: VIDEO_MODEL_DEFAULT,
                                    prompt: job.prompt, frameUri: job.frameUri,
                                    ratio: job.ratio, secs: job.secs, wantedResolution: job.wantedResolution,
                                    durationSeconds: job.durationSeconds,
                                    blockRetries: retries + 1,
                                });
                                return res.json({ done: false, operationName: r.operationName });
                            }
                            if (VIDEO_MODEL_LAST_RESORT && job.frameUri) {
                                console.warn(`[Omni] ${name} content_blocked after ${retries} retries; falling back to ${VIDEO_MODEL_LAST_RESORT}`);
                                const imageBase64 = await gcsObjectToBase64(job.frameUri);
                                const veoOp = await startVeoOperation({
                                    modelId: VIDEO_MODEL_LAST_RESORT, prompt: job.prompt, imageBase64,
                                    ratio: job.ratio, durationSeconds: job.durationSeconds,
                                });
                                return res.json({ done: false, operationName: veoOp });
                            }
                        } catch (retryErr) {
                            console.error('[Omni] content_blocked retry failed:', retryErr.message);
                            // fall through to the blocked message below
                        }
                    }
                    return res.json({
                        done: true,
                        error: 'Blocked by the Vertex AI safety filter: the generated video was judged to contain '
                             + 'reputational harm to a photorealistic person, and automatic retries did not clear it. '
                             + 'Try regenerating, or soften the shot description (less close-up, less identifiable). '
                             + `Original message: ${failure.message}`,
                    });
                }
                return res.json({ done: true, error: `Video generation ${status}: ${failure.message}` });
            }

            const video = extractInteractionVideo(interaction);
            if (!video) {
                const thoughts = extractInteractionThoughts(interaction);
                return res.json({
                    done: true,
                    error: 'The model returned no video. This is usually a safety filter or an unsupported prompt.'
                         + (thoughts ? ` Model notes: ${thoughts}` : ''),
                });
            }

            // response_format.gcs_uri points at our own bucket, so a returned URI
            // normally needs no copy. Copy only if it landed somewhere else.
            if (video.uri) {
                let finalUri = video.uri;
                if (GCS_BUCKET_NAME && !finalUri.startsWith(`gs://${GCS_BUCKET_NAME}/`)) {
                    try {
                        finalUri = await copyVideoToBucket(finalUri);
                    } catch (copyErr) {
                        console.error('[GCS] Copy to customer bucket failed, using original URI:', copyErr.message);
                    }
                }
                return res.json({ done: true, videoUri: finalUri });
            }

            // Inline bytes (no gcs_uri honoured): persist, else hand back base64.
            if (GCS_BUCKET_NAME) {
                try {
                    const objectName = `videos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
                    await getStorage().bucket(GCS_BUCKET_NAME).file(objectName)
                        .save(Buffer.from(video.data, 'base64'), { contentType: 'video/mp4', resumable: false });
                    const uri = `gs://${GCS_BUCKET_NAME}/${objectName}`;
                    console.log(`[Omni] inline video uploaded to ${uri}`);
                    return res.json({ done: true, videoUri: uri });
                } catch (uploadErr) {
                    console.error('[GCS] Failed to upload inline video bytes:', uploadErr.message);
                }
            }
            return res.json({ done: true, videoBase64: `data:${video.mimeType};base64,${video.data}` });
        }

        // ── Veo: poll via fetchPredictOperation ─────────────────────────────
        const token = await getAccessToken();

        // Veo operations must be polled via fetchPredictOperation (not standard GET /operations/{id})
        // name = "projects/.../locations/global/publishers/google/models/veo-xxx/operations/yyy"
        // Extract model path: "projects/.../locations/global/publishers/google/models/veo-xxx"
        const modelPathMatch = name.match(/^(.*\/models\/[^/]+)\/operations\//);
        if (!modelPathMatch) {
            throw new Error(`Cannot parse operation name: ${name}`);
        }
        const modelPath = modelPathMatch[1];
        const fetchOpUrl = `https://us-central1-aiplatform.googleapis.com/v1/${modelPath}:fetchPredictOperation`;
        console.log(`[Gemini] fetchPredictOperation: ${fetchOpUrl}`);

        const opResp = await fetch(fetchOpUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ operationName: name })
        });

        if (!opResp.ok) {
            const errText = await opResp.text().catch(() => opResp.statusText);
            throw new Error(`fetchPredictOperation failed (${opResp.status}): ${errText}`);
        }

        const operation = await opResp.json();
        console.log(`[Gemini] Operation status: done=${operation.done}`);

        if (!operation.done) {
            return res.json({ done: false });
        }
        if (operation.error) {
            return res.json({ done: true, error: operation.error.message || 'Video generation failed' });
        }

        // Log full response to understand URI structure
        console.log('[Gemini] Operation response:', JSON.stringify(operation.response));

        // Check for RAI (Responsible AI) content filter — video blocked by safety policy
        const raiFilteredCount = operation.response?.raiMediaFilteredCount;
        if (raiFilteredCount && raiFilteredCount > 0) {
            const reasons = operation.response?.raiMediaFilteredReasons || [];
            const reason = reasons[0] || 'Content policy violation';
            console.warn(`[Gemini] Video blocked by RAI filter: ${reason}`);
            return res.json({ done: true, error: `Video blocked by Vertex AI safety filter. Try rephrasing the prompt. (${reason})` });
        }

        // Try multiple possible response paths for video URI
        // GenerateVideoResponse uses: response.videos[0].gcsUri
        const videoUri = operation.response?.videos?.[0]?.gcsUri
                      || operation.response?.videos?.[0]?.uri
                      || operation.response?.generatedVideos?.[0]?.video?.uri
                      || operation.response?.generatedVideos?.[0]?.video?.gcsUri
                      || operation.response?.generatedSamples?.[0]?.video?.uri
                      || operation.response?.generatedSamples?.[0]?.video?.gcsUri;

        // Veo may return video bytes directly (bytesBase64Encoded) instead of a GCS URI
        const videoBase64 = operation.response?.videos?.[0]?.bytesBase64Encoded
                         || operation.response?.generatedVideos?.[0]?.video?.bytesBase64Encoded
                         || operation.response?.generatedSamples?.[0]?.video?.bytesBase64Encoded;

        if (!videoUri && !videoBase64) {
            return res.json({ done: true, error: 'No video URI returned. Response: ' + JSON.stringify(operation.response) });
        }

        let finalVideoUri = videoUri || null;

        if (videoBase64) {
            // Video returned as raw bytes — upload to customer bucket if configured,
            // otherwise stream directly to the frontend as a base64 data URL.
            if (GCS_BUCKET_NAME) {
                try {
                    console.log(`[GCS] Uploading inline video bytes to customer bucket: ${GCS_BUCKET_NAME}`);
                    const objectName = `videos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
                    const storage = getStorage();
                    const file = storage.bucket(GCS_BUCKET_NAME).file(objectName);
                    await file.save(Buffer.from(videoBase64, 'base64'), { contentType: 'video/mp4', resumable: false });
                    finalVideoUri = `gs://${GCS_BUCKET_NAME}/${objectName}`;
                    console.log(`[GCS] Inline video uploaded to ${finalVideoUri}`);
                } catch (uploadErr) {
                    console.error('[GCS] Failed to upload inline video bytes:', uploadErr.message);
                    // Fall back: send base64 directly so frontend can still play it
                    return res.json({ done: true, videoBase64: `data:video/mp4;base64,${videoBase64}` });
                }
            } else {
                // No bucket configured — send base64 directly to frontend
                console.log('[Gemini] No bucket configured, returning inline video as base64');
                return res.json({ done: true, videoBase64: `data:video/mp4;base64,${videoBase64}` });
            }
        }

        // If a customer bucket is configured and we have a GCS URI, copy the video there.
        if (GCS_BUCKET_NAME && finalVideoUri && !finalVideoUri.startsWith(`gs://${GCS_BUCKET_NAME}/`)) {
            try {
                console.log(`[GCS] Copying video to customer bucket: ${GCS_BUCKET_NAME}`);
                finalVideoUri = await copyVideoToBucket(finalVideoUri);
            } catch (copyErr) {
                console.error('[GCS] Failed to copy video to customer bucket, falling back to Veo URI:', copyErr.message);
            }
        }

        res.json({ done: true, videoUri: finalVideoUri });
    } catch (err) {
        console.error('[Gemini] video-operation error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/gemini/download-video?uri=xxx
// Streams video to client.
// - gs://bucket/object  → read via Storage SDK (customer bucket or Veo bucket)
// - https://...         → fetch with ADC Bearer token (legacy Veo HTTP URIs)
apiRouter.get('/gemini/download-video', async (req, res) => {
    const { uri } = req.query;
    if (!uri) return res.status(400).json({ error: 'uri is required' });

    try {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'no-store');

        if (uri.startsWith('gs://')) {
            // Parse gs://bucket/object
            const withoutScheme = uri.slice(5);
            const slashIdx = withoutScheme.indexOf('/');
            if (slashIdx === -1) return res.status(400).json({ error: 'Invalid GCS URI' });
            const bucketName = withoutScheme.slice(0, slashIdx);
            const objectName = withoutScheme.slice(slashIdx + 1);

            console.log(`[GCS] Streaming gs://${bucketName}/${objectName}`);
            const storage = getStorage();
            const readStream = storage.bucket(bucketName).file(objectName).createReadStream();
            readStream.on('error', (err) => {
                console.error('[GCS] Read stream error:', err);
                if (!res.headersSent) res.status(500).json({ error: err.message });
            });
            readStream.pipe(res);
        } else {
            // Legacy: HTTP URI from Veo temp storage — fetch with Bearer token
            const token = await getAccessToken();
            const videoResp = await fetch(uri, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!videoResp.ok) {
                const errText = await videoResp.text().catch(() => videoResp.statusText);
                console.error(`[Gemini] Video download failed (${videoResp.status}):`, errText);
                return res.status(videoResp.status).json({ error: `Download failed: ${errText}` });
            }

            const reader = videoResp.body.getReader();
            const pump = async () => {
                const { done, value } = await reader.read();
                if (done) { res.end(); return; }
                res.write(Buffer.from(value));
                await pump();
            };
            await pump();
        }
    } catch (err) {
        console.error('[Gemini] download-video error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// POST /api/gemini/stitch-clips
// Body: multipart/form-data
//   - clips: video files (one or more)
//   - subtitleSrt: SRT text (optional) — if present, burned into the stitched video
// Returns: video/mp4 stream.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 } // 200MB per file
});

const escapeSubtitleFilterPath = (p) => p.replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:');

// Parse SRT timestamps (HH:MM:SS,mmm) into ASS timestamps (H:MM:SS.cc).
const srtTimeToAss = (t) => {
    const m = t.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
    if (!m) return '0:00:00.00';
    const [, h, mm, ss, ms] = m;
    const cs = Math.round(parseInt(ms.padEnd(3, '0'), 10) / 10);
    return `${parseInt(h, 10)}:${mm}:${ss}.${String(cs).padStart(2, '0')}`;
};

// Convert SRT text to ASS dialogue lines. Uses \N for line breaks.
const srtToAssDialogues = (srt) => {
    const blocks = srt.replace(/\r\n/g, '\n').split(/\n{2,}/);
    const lines = [];
    for (const block of blocks) {
        const parts = block.trim().split('\n');
        if (parts.length < 2) continue;
        const timeLine = parts.find(l => l.includes('-->'));
        if (!timeLine) continue;
        const timeIdx = parts.indexOf(timeLine);
        const [startRaw, endRaw] = timeLine.split('-->').map(s => s.trim());
        const text = parts.slice(timeIdx + 1).join('\\N').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
        if (!text.trim()) continue;
        lines.push(`Dialogue: 0,${srtTimeToAss(startRaw)},${srtTimeToAss(endRaw)},Default,,0,0,0,,${text}`);
    }
    return lines.join('\n');
};

/**
 * Build a complete ASS subtitle file with the video's real dimensions as
 * PlayResX/Y. This bypasses the SRT→ASS conversion inside libass that would
 * otherwise use PlayResY=288 and blow up our pixel-sized FontSize.
 *
 * Rules of thumb for streaming-variety look, all in pixels:
 *   fontSize = ~4.2% of height (clamped 26..64)
 *   outline  = ~10% of fontSize (min 3)
 *   shadow   = ~6% of fontSize  (min 2)
 *   marginV  = ~7% of height    (min 40)
 */
const buildAssFromSrt = (srt, dimensions) => {
    const width = dimensions?.width || 1920;
    const height = dimensions?.height || 1080;
    const fontSize = Math.max(26, Math.min(64, Math.round(height * 0.042)));
    const outline = Math.max(3, Math.round(fontSize * 0.10));
    const shadow = Math.max(2, Math.round(fontSize * 0.06));
    const marginV = Math.max(40, Math.round(height * 0.07));

    const styleLine = `Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,` +
        `&H00000000,&H80000000,1,0,0,0,100,100,0.4,0,1,${outline},${shadow},` +
        `2,80,80,${marginV},1`;

    return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLine}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${srtToAssDialogues(srt)}
`;
};

/**
 * Probe a video's width/height via ffprobe.
 * Returns { width, height } or null if the probe fails.
 */
const probeVideoDimensions = async (videoPath) => {
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'csv=p=0:s=x',
            videoPath,
        ]);
        const [w, h] = stdout.trim().split('x').map(n => parseInt(n, 10));
        if (!w || !h) return null;
        return { width: w, height: h };
    } catch (err) {
        console.warn('[FFprobe] Failed to probe dimensions:', err.message);
        return null;
    }
};

/**
 * Burn an SRT into a video, re-encoding once. Style adapts to the video's height.
 * Returns the output file path.
 *
 * We generate an ASS file directly (rather than SRT + force_style) so we can
 * pin PlayResX/Y to the real video dimensions. Otherwise libass converts SRT
 * with PlayResY=288, and our pixel-scaled FontSize gets multiplied by
 * (video_height / 288) → 3.75x at 1080p, 6.67x at 1920p, wrapping text and
 * blowing letters off-screen.
 */
const burnSrtIntoVideo = async (inputPath, srt, tmpDir, outputName = 'final.mp4') => {
    const dimensions = await probeVideoDimensions(inputPath);
    const assContent = buildAssFromSrt(srt, dimensions);
    const assPath = path.join(tmpDir, `subs-${randomUUID()}.ass`);
    await writeFile(assPath, assContent, 'utf8');

    console.log(`[Subtitles] Burning subtitles — dimensions=${dimensions ? `${dimensions.width}x${dimensions.height}` : 'unknown'}`);

    const outputPath = path.join(tmpDir, outputName);
    const filterArg = `ass='${escapeSubtitleFilterPath(assPath)}'`;
    await execFileAsync('ffmpeg', [
        '-i', inputPath,
        '-vf', filterArg,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        '-y',
        outputPath,
    ]);
    return outputPath;
};

/**
 * Stream a finished file to the client and resolve only once the response is
 * fully flushed. The caller can then safely delete the temp directory — piping
 * alone returns immediately and the old code raced the cleanup.
 */
const streamFileToResponse = (filePath, res) => new Promise((resolve) => {
    const stream = createReadStream(filePath);
    stream.on('error', (err) => {
        console.error('[Stream] Read error:', err.message);
        if (!res.headersSent) res.status(500).end();
        else res.end();
        resolve();
    });
    res.on('close', resolve);
    res.on('finish', resolve);
    stream.pipe(res);
});

apiRouter.post('/gemini/stitch-clips', upload.any(), async (req, res) => {
    const files = (req.files || []).filter(f => f.fieldname === 'clips');
    if (files.length === 0) {
        return res.status(400).json({ error: 'No clip files provided' });
    }

    const subtitleSrt = (req.body && typeof req.body.subtitleSrt === 'string')
        ? req.body.subtitleSrt.trim()
        : '';
    const saveToGcs = String(req.body?.saveToGcs || '') === 'true';

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'stitch-'));
    try {
        // 写入各片段到临时目录
        const clipPaths = [];
        for (let i = 0; i < files.length; i++) {
            const p = path.join(tmpDir, `clip_${i}.mp4`);
            await writeFile(p, files[i].buffer);
            clipPaths.push(p);
        }

        // 生成 FFmpeg concat filelist
        const fileListContent = clipPaths.map(p => `file '${p}'`).join('\n');
        const fileListPath = path.join(tmpDir, 'filelist.txt');
        await writeFile(fileListPath, fileListContent);

        // 运行 FFmpeg 无损拼接
        const concatPath = path.join(tmpDir, 'concat.mp4');
        await execFileAsync('ffmpeg', [
            '-f', 'concat',
            '-safe', '0',
            '-i', fileListPath,
            '-c', 'copy',
            '-y',
            concatPath
        ]);

        console.log(`[FFmpeg] Stitched ${files.length} clips → ${concatPath}`);

        // 有字幕：按视频尺寸自适应样式，烧入字幕
        let outPath = concatPath;
        let downloadName = 'stitched.mp4';
        if (subtitleSrt) {
            outPath = await burnSrtIntoVideo(concatPath, subtitleSrt, tmpDir, 'final.mp4');
            downloadName = 'stitched_subtitled.mp4';
            console.log(`[Subtitles] Burned subtitles → ${outPath}`);
        }

        // 成品落 GCS（best-effort，失败不影响下载）。必须在写响应头之前完成。
        if (saveToGcs) {
            const gcsUri = await uploadExportToBucket({
                localPath: outPath,
                ext: 'mp4',
                contentType: 'video/mp4',
                label: subtitleSrt ? 'streamer-subtitled' : 'streamer',
            });
            if (gcsUri) {
                res.setHeader('X-Gcs-Uri', gcsUri);
                res.setHeader('Access-Control-Expose-Headers', 'X-Gcs-Uri');
            }
        }

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
        await streamFileToResponse(outPath, res);
    } catch (err) {
        console.error('[FFmpeg] stitch-clips error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Stitch failed: ' + err.message });
        }
    } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
});

// POST /api/gemini/burn-subtitles
// Body: multipart/form-data
//   - video: single video file (the final composite)
//   - srt: SRT text (form field)
// Returns: video/mp4 stream with subtitles burned in.
//
// Used after the browser finishes the PiP composite: the client sends the
// composite blob and a client-built SRT, so subtitles land on the final
// full-frame video, not on the tiny streamer PiP.
apiRouter.post('/gemini/burn-subtitles', upload.any(), async (req, res) => {
    const videoFile = (req.files || []).find(f => f.fieldname === 'video');
    if (!videoFile) {
        return res.status(400).json({ error: 'No video file provided' });
    }
    const srt = (req.body && typeof req.body.srt === 'string') ? req.body.srt : '';
    if (!srt.trim()) {
        return res.status(400).json({ error: 'srt field is required and non-empty' });
    }
    const saveToGcs = String(req.body?.saveToGcs || '') === 'true';

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'burn-'));

    try {
        const ext = videoFile.mimetype && videoFile.mimetype.includes('webm') ? 'webm' : 'mp4';
        const inputPath = path.join(tmpDir, `input.${ext}`);
        await writeFile(inputPath, videoFile.buffer);

        const finalPath = await burnSrtIntoVideo(inputPath, srt, tmpDir, 'final.mp4');

        if (saveToGcs) {
            const gcsUri = await uploadExportToBucket({
                localPath: finalPath,
                ext: 'mp4',
                contentType: 'video/mp4',
                label: 'mix-subtitled',
            });
            if (gcsUri) {
                res.setHeader('X-Gcs-Uri', gcsUri);
                res.setHeader('Access-Control-Expose-Headers', 'X-Gcs-Uri');
            }
        }

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="subtitled.mp4"');
        await streamFileToResponse(finalPath, res);
    } catch (err) {
        console.error('[FFmpeg] burn-subtitles error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Burn failed: ' + err.message });
        }
    } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
});

// POST /api/gemini/save-export
// Body: multipart/form-data
//   - video: the finished export produced in the browser (Canvas + MediaRecorder
//     composite). The server never sees this render otherwise, so it has to be
//     uploaded explicitly to be persisted.
//   - label: optional short name used in the object path
// Returns: { gcsUri }
apiRouter.post('/gemini/save-export', upload.any(), async (req, res) => {
    const videoFile = (req.files || []).find(f => f.fieldname === 'video');
    if (!videoFile) {
        return res.status(400).json({ error: 'No video file provided' });
    }
    if (!GCS_BUCKET_NAME) {
        return res.status(503).json({ error: 'No GCS bucket configured on this deployment.' });
    }

    const rawLabel = typeof req.body?.label === 'string' ? req.body.label : 'export';
    const label = rawLabel.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'export';
    const isWebm = Boolean(videoFile.mimetype && videoFile.mimetype.includes('webm'));

    try {
        const gcsUri = await uploadExportToBucket({
            buffer: videoFile.buffer,
            ext: isWebm ? 'webm' : 'mp4',
            contentType: isWebm ? 'video/webm' : 'video/mp4',
            label,
        });
        if (!gcsUri) return res.status(500).json({ error: 'Upload to GCS failed.' });
        res.json({ gcsUri });
    } catch (err) {
        console.error('[GCS] save-export error:', err);
        res.status(500).json({ error: 'Failed to save export: ' + err.message });
    }
});

// GET /api/media/export-url?uri=gs://appbucket/...
// Short-lived signed URL for any authenticated user, but ONLY for objects in
// this deployment's own bucket. Used by <video> preview, which cannot attach an
// Authorization header to its src.
apiRouter.get('/media/export-url', async (req, res) => {
    const { uri } = req.query;
    if (!uri || typeof uri !== 'string' || !uri.startsWith('gs://')) {
        return res.status(400).json({ error: 'Invalid or missing gs:// uri' });
    }
    const withoutScheme = uri.slice(5);
    const slashIdx = withoutScheme.indexOf('/');
    if (slashIdx === -1) return res.status(400).json({ error: 'Invalid GCS URI' });
    const bucketName = withoutScheme.slice(0, slashIdx);
    const objectName = withoutScheme.slice(slashIdx + 1);

    if (!GCS_BUCKET_NAME || bucketName !== GCS_BUCKET_NAME) {
        return res.status(403).json({ error: 'URI is outside the configured application bucket.' });
    }

    try {
        const [url] = await getStorage().bucket(bucketName).file(objectName).getSignedUrl({
            action: 'read',
            expires: Date.now() + 60 * 60 * 1000, // 1 hour — long enough to watch
        });
        res.json({ url });
    } catch (err) {
        console.error('[Media] export-url error:', err);
        res.status(500).json({ error: 'Failed to generate URL: ' + err.message });
    }
});

// POST /api/media/save-image
// Body: { dataUrl: "data:image/png;base64,...", label?: string }
// Returns: { gcsUri }
// For images the server did not produce itself — currently the avatar reference
// image the user picks from disk.
apiRouter.post('/media/save-image', async (req, res) => {
    const { dataUrl, label } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return res.status(400).json({ error: 'dataUrl (data: URL) is required' });
    }
    if (!GCS_BUCKET_NAME) {
        return res.status(503).json({ error: 'No GCS bucket configured on this deployment.' });
    }
    const gcsUri = await uploadImageToBucket({ dataUrl, label: label || 'reference' });
    if (!gcsUri) return res.status(500).json({ error: 'Upload to GCS failed.' });
    res.json({ gcsUri });
});

// GET /api/media/object?uri=gs://appbucket/...
// Streams an object from this deployment's own bucket, same-origin and
// authenticated.
//
// Why this exists rather than reusing a signed URL: the bucket has no CORS
// configuration, so a cross-origin `fetch()` of a signed URL is blocked and a
// <video crossOrigin="anonymous"> will not load at all. Restored clips have to
// behave exactly like freshly generated ones — playable, fetchable for
// stitching, and safe to draw on a canvas for last-frame extraction — so the
// client pulls them through here and wraps them in blob: URLs.
apiRouter.get('/media/object', async (req, res) => {
    const { uri } = req.query;
    if (!uri || typeof uri !== 'string' || !uri.startsWith('gs://')) {
        return res.status(400).json({ error: 'Invalid or missing gs:// uri' });
    }
    const withoutScheme = uri.slice(5);
    const slashIdx = withoutScheme.indexOf('/');
    if (slashIdx === -1) return res.status(400).json({ error: 'Invalid GCS URI' });
    const bucketName = withoutScheme.slice(0, slashIdx);
    const objectName = withoutScheme.slice(slashIdx + 1);

    if (!GCS_BUCKET_NAME || bucketName !== GCS_BUCKET_NAME) {
        return res.status(403).json({ error: 'URI is outside the configured application bucket.' });
    }

    try {
        const file = getStorage().bucket(bucketName).file(objectName);
        const [exists] = await file.exists();
        if (!exists) return res.status(404).json({ error: 'Object not found' });

        const [metadata] = await file.getMetadata();
        res.setHeader('Content-Type', metadata.contentType || 'application/octet-stream');
        if (metadata.size) res.setHeader('Content-Length', metadata.size);
        res.setHeader('Cache-Control', 'private, max-age=300');

        const stream = file.createReadStream();
        stream.on('error', (err) => {
            console.error('[Media] object stream error:', err.message);
            if (!res.headersSent) res.status(500).json({ error: err.message });
            else res.end();
        });
        stream.pipe(res);
    } catch (err) {
        console.error('[Media] object error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to read object: ' + err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTOPILOT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every Autopilot route is invisible unless the feature is switched on, so an
 * existing deployment that has not opted in behaves exactly as before.
 */
const autopilotOnly = (req, res, next) => {
    if (!AUTOPILOT_ENABLED) {
        return res.status(404).json({ error: 'API endpoint not found', path: req.originalUrl });
    }
    if (!GCS_BUCKET_NAME) {
        return res.status(503).json({
            error: 'Autopilot requires GCS_BUCKET_NAME: gameplay footage and finished '
                 + 'videos are held in Cloud Storage.',
        });
    }
    next();
};

// ── shared media plumbing ────────────────────────────────────────────────────
// Autopilot needs the same primitives the interactive endpoints use inline;
// factoring them out keeps one implementation rather than a divergent copy.

const VIDEO_BLOCK_RETRIES_DEFAULT = VIDEO_BLOCK_RETRIES;

/** Poll a Veo long-running operation. Veo requires fetchPredictOperation. */
const fetchVeoOperation = async (name) => {
    const token = await getAccessToken();
    const modelPathMatch = String(name).match(/^(.*\/models\/[^/]+)\/operations\//);
    if (!modelPathMatch) throw new Error(`Cannot parse operation name: ${name}`);
    const url = `https://us-central1-aiplatform.googleapis.com/v1/${modelPathMatch[1]}:fetchPredictOperation`;

    const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationName: name }),
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => resp.statusText);
        throw new Error(`fetchPredictOperation failed (${resp.status}): ${text}`);
    }
    return resp.json();
};

/** Human-readable reason a Veo operation produced nothing. */
const extractVeoError = (operation) => {
    if (operation?.error?.message) return operation.error.message;
    const filtered = operation?.response?.raiMediaFilteredReasons;
    if (Array.isArray(filtered) && filtered.length) return filtered.join('; ');
    return null;
};

/** Stream a gs:// object to a local path. */
const downloadGcsToFile = async (gcsUri, destPath) => {
    const withoutScheme = String(gcsUri).slice(5);
    const slashIdx = withoutScheme.indexOf('/');
    if (!String(gcsUri).startsWith('gs://') || slashIdx === -1) {
        throw new Error(`Not a gs:// URI: ${gcsUri}`);
    }
    await getStorage()
        .bucket(withoutScheme.slice(0, slashIdx))
        .file(withoutScheme.slice(slashIdx + 1))
        .download({ destination: destPath });
    return destPath;
};

/**
 * Concatenate clips without re-encoding.
 *
 * Stream copy works because every clip comes from the same model at the same
 * resolution; it also keeps the streamer track pristine for the composite.
 */
const concatClipFiles = async (clipPaths, outPath, tmpDir) => {
    if (!clipPaths.length) throw new Error('No clips to concatenate');
    if (clipPaths.length === 1) {
        await execFileAsync('ffmpeg', ['-hide_banner', '-y', '-i', clipPaths[0], '-c', 'copy', outPath]);
        return outPath;
    }
    const listPath = path.join(tmpDir, 'filelist.txt');
    await writeFile(listPath, clipPaths.map((p) => `file '${p}'`).join('\n'));
    await execFileAsync('ffmpeg', [
        '-hide_banner', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', outPath,
    ]);
    return outPath;
};

const srtPad = (n, w = 2) => String(n).padStart(w, '0');

const secondsToSrtTime = (total) => {
    const t = Number.isFinite(total) && total > 0 ? total : 0;
    const ms = Math.floor((t - Math.floor(t)) * 1000);
    return `${srtPad(Math.floor(t / 3600))}:${srtPad(Math.floor(t / 60) % 60)}`
         + `:${srtPad(Math.floor(t) % 60)},${srtPad(ms, 3)}`;
};

/**
 * Build an SRT from a shot list. Server-side port of utils/subtitles.ts, needed
 * because Autopilot has no browser to build it.
 *
 * Bracketed vocal cues such as "[shouting]" are prompt directives for the video
 * model, not spoken words, so they must never be burned in.
 */
const segmentsToSrt = (segments) => {
    const lines = [];
    let cursor = 0;
    let idx = 1;
    for (const seg of segments || []) {
        const text = String(seg.dialogue || '')
            .replace(/\[[^\]]*\]/g, '')
            .replace(/\([^)]*\)/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const dur = Number(seg.duration) || 0;
        const start = cursor;
        cursor += dur;
        if (!text || dur <= 0) continue;
        lines.push(String(idx++));
        lines.push(`${secondsToSrtTime(start)} --> ${secondsToSrtTime(cursor)}`);
        lines.push(text);
        lines.push('');
    }
    return lines.join('\n');
};

// ── generation helpers ───────────────────────────────────────────────────────
// Autopilot drives the same models the wizard does, so these wrap the exact
// calls the interactive endpoints make rather than introducing a second recipe.

const AVATAR_IMAGE_MODEL = process.env.AVATAR_MODEL || 'gemini-3.1-flash-image';

/** Render one streamer image. Returns raw base64 (no data: prefix). */
const generateAvatarImage = async ({ prompt, aspectRatio, referenceGcsUri }) => {
    const parts = [{ text: prompt }];
    if (referenceGcsUri) {
        // A reference image is how the user pins the character's look; without it
        // every regeneration returns a different person.
        const base64 = await gcsObjectToBase64(referenceGcsUri);
        parts.push({ inlineData: { mimeType: 'image/png', data: base64 } });
    }

    const ai = getVertexAIGlobalClient();
    const response = await ai.models.generateContent({
        model: AVATAR_IMAGE_MODEL,
        contents: [{ role: 'user', parts }],
        config: {
            temperature: 0.5,
            responseModalities: ['IMAGE', 'TEXT'],
            imageConfig: { aspectRatio: aspectRatio || '16:9', imageSize: '1K' },
            safetySettings: SAFETY_SETTINGS_BLOCK_NONE,
        },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
            return { imageData: part.inlineData.data, mimeType: part.inlineData.mimeType };
        }
    }
    throw new Error('The image model returned no image');
};

/**
 * Write one variant's shot list.
 *
 * Variants differ by script, so the temperature climbs with the index and the
 * prompt asks for a distinct angle. That is what makes ten renders worth having
 * instead of ten copies.
 */
const generateAutopilotScript = async (job, variantIdx) => {
    const s = job.spec;
    const angles = [
        'lead with the core gameplay hook',
        'lead with a bold claim about how it feels to play',
        'lead with a question aimed straight at the viewer',
        'lead with the single most impressive visual moment',
        'lead with what makes this different from similar games',
        'lead with a short personal reaction',
        'lead with the reward or progression the player chases',
        'lead with urgency about trying it today',
        'lead with the atmosphere and mood',
        'lead with a surprising detail a new player would miss',
    ];
    const angle = angles[variantIdx % angles.length];

    const promptText = [
        `You are scripting a short promotional video for the game "${s.gameTitle}".`,
        s.gameUrl ? `Store link: ${s.gameUrl}` : '',
        s.gamingDevice ? `Platform / device: ${s.gamingDevice}` : '',
        s.callToAction ? `The video must end on this call to action: ${s.callToAction}` : '',
        s.dialoguePacing ? `Dialogue pacing: ${s.dialoguePacing}` : '',
        s.extraInstructions ? `Additional direction: ${s.extraInstructions}` : '',
        '',
        `Creative direction for this version: ${angle}.`,
        'Produce a timed shot list for an on-camera streamer.',
        'Each shot needs: id, startTime, endTime, duration (4, 6 or 8 seconds),',
        'prompt (what the streamer physically does on camera), and dialogue (what they say).',
        'Keep the whole video between 16 and 40 seconds. Return JSON only.',
    ].filter(Boolean).join('\n');

    const ai = getVertexAIGlobalClient();
    const response = await ai.models.generateContent({
        model: GEMINI_SCRIPT_MODEL,
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        config: {
            // Nudge each variant apart; index 0 stays the most predictable.
            temperature: Math.min(1.3, 0.7 + variantIdx * 0.12),
            systemInstruction: 'You are an expert content creator scriptwriter. '
                + 'Adhere strictly to the duration rules.',
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        id: { type: Type.INTEGER },
                        startTime: { type: Type.STRING },
                        endTime: { type: Type.STRING },
                        duration: { type: Type.INTEGER },
                        prompt: { type: Type.STRING },
                        dialogue: { type: Type.STRING },
                    },
                    required: ['id', 'startTime', 'endTime', 'duration', 'prompt', 'dialogue'],
                },
            },
        },
    });

    const raw = JSON.parse(response.text || '[]');
    if (!Array.isArray(raw) || !raw.length) throw new Error('Script model returned no shots');

    // Validation gate: snap durations to what the video models accept and drop
    // anything without dialogue, which would render a silent talking head.
    const segments = raw
        .filter((seg) => seg && String(seg.dialogue || '').trim())
        .map((seg, i) => {
            let d = Number(seg.duration) || 8;
            d = d <= 4 ? 4 : (d <= 6 ? 6 : 8);
            return {
                id: i + 1,
                startTime: String(seg.startTime || '0:00'),
                endTime: String(seg.endTime || '0:08'),
                duration: d,
                prompt: String(seg.prompt || '').slice(0, 1000),
                dialogue: String(seg.dialogue || '').slice(0, 1000),
            };
        });
    if (!segments.length) throw new Error('Every shot came back without dialogue');
    return segments;
};

/** Poll a video handle until it resolves, reusing the interactive read paths. */
const awaitVideoHandle = async ({ operationName, api }, { timeoutMs = 10 * 60 * 1000 } = {}) => {
    const started = Date.now();
    let delay = 8000;
    for (;;) {
        if (Date.now() - started > timeoutMs) throw new Error('Video generation timed out');
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(15000, delay + 1000);

        if (api === 'veo') {
            const op = await fetchVeoOperation(operationName);
            if (!op.done) continue;
            const uri = op.response?.videos?.[0]?.gcsUri;
            if (uri) return { gcsUri: uri };
            throw new Error(extractVeoError(op) || 'Veo returned no video');
        }

        const interaction = await callInteractions(`/${operationName}`, undefined, 'GET');
        const status = interaction?.status;
        if (status === 'completed') {
            const video = extractInteractionVideo(interaction);
            if (video?.uri) return { gcsUri: video.uri };
            throw new Error('Interaction completed without a video');
        }
        if (status === 'failed' || status === 'cancelled') {
            const err = extractInteractionError(interaction);
            const e = new Error(err?.message || `Interaction ${status}`);
            e.code = err?.code;
            throw e;
        }
    }
};

/**
 * Produce one clip for a variant.
 *
 * Chains from the previous clip's last frame when there is one, so the streamer
 * stays continuous — the same trick the Studio offers manually. On a safety block
 * it retries, then falls through to Veo only while the batch's Veo budget lasts.
 */
const produceAutopilotClip = async (job, variantIdx, clipIdx) => {
    const variant = job.variants.find((v) => v.idx === variantIdx);
    const segment = variant.scriptSegments[clipIdx];
    const avatarUri = avatarUriForVariant(job, variantIdx);
    if (!avatarUri) throw new Error('No approved avatar for this variant');

    const ratio = job.spec.layoutType === 'stacked'
        ? (job.spec.targetRatio === '9:16' ? '16:9' : '9:16')
        : job.spec.targetRatio;

    const prompt = `${segment.prompt}. The streamer says: "${segment.dialogue}"`;
    const frameUri = avatarUri;   // always seed from the approved streamer image
    const secs = Math.min(10, Math.max(3, segment.duration));

    let attempt = 0;
    let lastErr = null;
    // Omni's RAI filter rejects photorealistic people non-deterministically, so a
    // plain retry usually clears it.
    const maxOmniAttempts = 1 + VIDEO_BLOCK_RETRIES_DEFAULT;
    while (attempt < maxOmniAttempts) {
        attempt += 1;
        try {
            const started = await beginVideoJob({
                primaryModel: VIDEO_MODEL_DEFAULT,
                prompt,
                frameUri,
                ratio,
                secs,
                wantedResolution: VIDEO_RESOLUTION_DEFAULT,
                durationSeconds: segment.duration,
                blockRetries: 0,
            });
            const { gcsUri } = await awaitVideoHandle(started);
            return { gcsUri, usedVeo: started.api === 'veo' };
        } catch (err) {
            lastErr = err;
            const blocked = err.code === 'content_blocked'
                || /content_blocked|safety/i.test(err.message || '');
            if (!blocked) break;
            console.warn(`[Autopilot] ${job.id} v${variantIdx} clip ${clipIdx} blocked, attempt ${attempt}`);
        }
    }

    // Veo honours personGeneration: allow_adult, which is why it is kept as the
    // rescue — but it is pay-as-you-go, so the batch budget gates it.
    if (VIDEO_MODEL_LAST_RESORT && canUseVeo(job)) {
        console.log(`[Autopilot] ${job.id} v${variantIdx} clip ${clipIdx} → Veo rescue `
            + `(${job.counters.veoUsed + 1}/${job.veoBudget})`);
        const imageBase64 = await gcsObjectToBase64(frameUri);
        const op = await startVeoOperation({
            modelId: VIDEO_MODEL_LAST_RESORT,
            prompt,
            imageBase64,
            ratio,
            durationSeconds: segment.duration,
        });
        const { gcsUri } = await awaitVideoHandle({ operationName: op, api: 'veo' });
        return { gcsUri, usedVeo: true };
    }

    if (VIDEO_MODEL_LAST_RESORT && !canUseVeo(job)) {
        throw new Error(`${lastErr?.message || 'clip failed'} — the Veo budget for this batch `
            + `(${job.veoBudget} clips) is spent, so no further pay-as-you-go retries were made`);
    }
    throw lastErr || new Error('Clip generation failed');
};

/**
 * Turn a variant's clips into the deliverable: concatenate, burn subtitles if
 * asked, composite over the gameplay unless the layout is streamer-only, and
 * persist the result.
 */
const deliverAutopilotVariant = async (job, variantIdx) => {
    const variant = job.variants.find((v) => v.idx === variantIdx);
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), `gh-ap-${job.id}-${variantIdx}-`));
    try {
        // 1. clips → local files
        const localClips = [];
        for (let i = 0; i < variant.clipUris.length; i += 1) {
            const p = path.join(tmpDir, `clip-${String(i).padStart(3, '0')}.mp4`);
            await downloadGcsToFile(variant.clipUris[i], p);
            localClips.push(p);
        }

        // 2. concatenate
        let streamerTrack = path.join(tmpDir, 'streamer.mp4');
        await concatClipFiles(localClips, streamerTrack, tmpDir);

        // 3. optional burned-in subtitles, built server-side from the shot list
        if (job.spec.subtitles) {
            const srt = segmentsToSrt(variant.scriptSegments);
            streamerTrack = await burnSrtIntoVideo(streamerTrack, srt, tmpDir, 'streamer-sub.mp4');
        }

        // 4. composite (or not, for streamer-only)
        let deliverable = streamerTrack;
        if (job.spec.layoutType !== 'streamer-only') {
            const gameplayLocal = path.join(tmpDir, 'gameplay.src');
            await downloadGcsToFile(job.spec.gameplayGcsUri, gameplayLocal);
            deliverable = path.join(tmpDir, 'final.mp4');
            await composeVideo({
                gameplayPath: gameplayLocal,
                streamerPath: streamerTrack,
                outputPath: deliverable,
                layout: job.spec.layoutType,
                targetRatio: job.spec.targetRatio,
                pipPlacement: job.spec.pipPlacement,
                stackedPlacement: job.spec.stackedPlacement,
                volumes: job.spec.volumes,
            });
        } else {
            // Validation gate still applies: the concatenation must be playable.
            const meta = await probeMedia(deliverable);
            if (!(meta.duration > 0)) throw new Error('Concatenated video has no duration');
        }

        // 5. persist
        const gcsUri = await uploadExportToBucket({
            localPath: deliverable,
            ext: 'mp4',
            contentType: 'video/mp4',
            label: `autopilot-${job.id}-v${variantIdx}`,
        });
        if (!gcsUri) throw new Error('Failed to store the finished video');
        console.log(`[Autopilot] ${job.id} v${variantIdx} delivered → ${gcsUri}`);
        return gcsUri;
    } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
};

// ── job store ────────────────────────────────────────────────────────────────
// Datastore is the source of truth rather than process memory: Cloud Run is
// multi-instance and an instance can disappear mid-batch. Everything needed to
// resume sits in the entity, and the heavy fields are unindexed to stay clear of
// the 1500-byte limit on indexed properties.
const AUTOPILOT_JOB_KIND = 'AutopilotJob';

const jobToEntity = (job) => ({
    key: getDb().key([AUTOPILOT_JOB_KIND, job.id]),
    data: {
        ownerEmail: job.ownerEmail,
        status: job.status,
        variantCount: job.spec.variantCount,
        doneCount: job.variants.filter((v) => v.stage === VARIANT_STAGE.DONE).length,
        failedCount: job.variants.filter((v) => v.stage === VARIANT_STAGE.FAILED).length,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        // One JSON blob per section. Naming a parent in excludeFromIndexes does
        // not cover its children, so keeping them as strings sidesteps the whole
        // class of "property is longer than 1500 bytes" failures.
        spec: JSON.stringify(job.spec),
        avatar: JSON.stringify(job.avatar),
        variants: JSON.stringify(job.variants),
        counters: JSON.stringify(job.counters || {}),
        veoBudget: job.veoBudget || 0,
        error: job.error ? String(job.error).slice(0, 500) : null,
    },
    excludeFromIndexes: ['spec', 'avatar', 'variants', 'counters', 'error'],
});

const entityToJob = (entity) => {
    if (!entity) return null;
    const key = entity[Datastore.KEY];
    const parse = (v, dflt) => {
        try { return v ? JSON.parse(v) : dflt; } catch { return dflt; }
    };
    return {
        id: String(key?.name || ''),
        ownerEmail: entity.ownerEmail,
        status: entity.status,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        spec: parse(entity.spec, {}),
        avatar: parse(entity.avatar, { candidates: [], approvedIdx: [], regenCount: 0 }),
        variants: parse(entity.variants, []),
        counters: parse(entity.counters, { veoUsed: 0 }),
        veoBudget: Number(entity.veoBudget) || 0,
        error: entity.error || null,
    };
};

const saveJob = async (job) => {
    const db = getDb();
    if (!db) throw new Error('Datastore is not configured; Autopilot needs it to resume jobs');
    await db.save(jobToEntity(job));
    return job;
};

/**
 * Apply a change to a job inside a transaction, retrying on contention.
 *
 * Necessary because several workers progress one batch at once and the entity is
 * written whole. A plain load → mutate → save loses updates: an observed run had
 * the clip count going backwards (11/12 → 10/12) and a failed variant reverting
 * to running, because the last writer clobbered its peers.
 *
 * The expensive generation happens *outside* this call; only the short checkpoint
 * is transactional. `mutate` receives freshly-read state and must be a pure
 * function of it, so a retry re-derives the same delta safely.
 */
const commitJobUpdate = async (jobId, mutate, { attempts = 6 } = {}) => {
    const db = getDb();
    if (!db) throw new Error('Datastore is not configured');
    let lastErr = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const tx = db.transaction();
        try {
            await tx.run();
            const [entity] = await tx.get(db.key([AUTOPILOT_JOB_KIND, jobId]));
            const current = entityToJob(entity);
            if (!current) { await tx.rollback(); return null; }

            const next = mutate(current);
            if (!next) { await tx.rollback(); return current; }

            tx.save(jobToEntity(next));
            await tx.commit();
            return next;
        } catch (err) {
            lastErr = err;
            await tx.rollback().catch(() => {});
            // Contention is expected with a full worker pool; back off and re-read.
            const wait = 60 * (2 ** attempt) + Math.floor(Math.random() * 80);
            await new Promise((r) => setTimeout(r, wait));
        }
    }
    throw lastErr || new Error('Could not commit the job update');
};

const loadJob = async (id) => {
    const db = getDb();
    if (!db) return null;
    const [entity] = await db.get(db.key([AUTOPILOT_JOB_KIND, id]));
    return entityToJob(entity);
};

/** Jobs belong to their creator; a foreign id is reported as missing, not denied. */
const loadOwnedJob = async (id, ownerEmail) => {
    const job = await loadJob(id);
    if (!job || job.ownerEmail !== ownerEmail) return null;
    return job;
};

const listJobs = async (ownerEmail, limit = 50) => {
    const db = getDb();
    if (!db) return [];
    const query = db.createQuery(AUTOPILOT_JOB_KIND).filter('ownerEmail', '=', ownerEmail);
    const [entities] = await db.runQuery(query);
    return entities
        .map(entityToJob)
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        .slice(0, limit);
};

// ── executor ─────────────────────────────────────────────────────────────────
// One tick performs at most one unit of work and then checkpoints. Keeping the
// unit small is what makes a lost instance cheap: at worst one clip is redone.

/**
 * Actions currently being executed in this instance, keyed jobId + action.
 *
 * Claiming at action granularity (not per job) is what allows several workers on
 * one batch: an earlier attempt locked per job and silently serialised the whole
 * pipeline — 12 clips took 608 s because only one ever ran at a time.
 */
const claimedActions = new Set();
const claimKey = (jobId, action) => `${jobId}#${actionKey(action)}`;

const renderAvatarCandidates = async (job, count = 1) => {
    const ratio = avatarRatioFor(job.spec);
    const out = [];
    for (let i = 0; i < count; i += 1) {
        const { imageData } = await generateAvatarImage({
            prompt: job.spec.avatarPrompt,
            aspectRatio: ratio,
            referenceGcsUri: job.spec.avatarRefGcsUri,
        });
        const gcsUri = await uploadImageToBucket({
            base64: imageData,
            mimeType: 'image/png',
            label: 'autopilot-avatar',
            prefix: `autopilot/${job.id}`,
        });
        if (!gcsUri) throw new Error('Failed to store the avatar candidate');
        out.push({ gcsUri });
    }
    return out;
};

/**
 * The avatar aspect ratio is dictated by the layout: a stacked layout needs the
 * streamer in the opposite orientation to the finished video.
 */
const avatarRatioFor = (spec) => {
    if (spec.layoutType === 'stacked') return spec.targetRatio === '9:16' ? '16:9' : '9:16';
    return spec.targetRatio;
};

/**
 * Advance a job by one step.
 *
 * Returns the (possibly unchanged) job. `awaiting_avatar` returns immediately —
 * nextAction never yields work at the gate, so this function is safe to call
 * from the poll endpoint and the resume sweep alike.
 */
const tickJob = async (jobId, presetAction = null) => {
    let job = await loadJob(jobId);
    if (!job) return { skipped: 'missing' };

    const claimedForJob = new Set(
        [...claimedActions]
            .filter((k) => k.startsWith(`${jobId}#`))
            .map((k) => k.slice(jobId.length + 1))
    );
    const action = presetAction || nextAction(job, { exclude: claimedForJob });
    if (action.type === ACTION.WAIT_APPROVAL || action.type === ACTION.NOTHING) {
        return { action: action.type, job };
    }

    const key = claimKey(jobId, action);
    if (claimedActions.has(key)) return { skipped: 'in-flight' };
    claimedActions.add(key);
    try {
        if (action.type === ACTION.GENERATE_AVATAR) {
            const candidates = await renderAvatarCandidates(job, 1);
            const updated = await commitJobUpdate(jobId, (cur) => setAvatarCandidates(cur, candidates));
            return { action: action.type, job: updated };
        }

        if (action.type === ACTION.FINALISE) {
            const updated = await commitJobUpdate(jobId, (cur) => finalise(cur));
            if (updated) console.log(`[Autopilot] ${updated.id} → ${updated.status}`);
            return { action: action.type, job: updated };
        }

        const idx = action.variantIdx;
        try {
            if (action.type === ACTION.GENERATE_SCRIPT) {
                const segments = await generateAutopilotScript(job, idx);
                let scriptError = null;
                const updated = await commitJobUpdate(jobId, (cur) => {
                    const r = applyScript(cur, idx, segments, {
                        maxClipsPerJob: AUTOPILOT_MAX_CLIPS_PER_JOB,
                    });
                    if (r.ok) return r.job;
                    scriptError = r.error;
                    // A fatal result already carries the failed job (clip ceiling).
                    return r.fatal ? r.job : failVariant(cur, idx, r.error);
                });
                return { action: action.type, job: updated, error: scriptError };
            }

            if (action.type === ACTION.GENERATE_CLIP) {
                const { gcsUri, usedVeo } = await produceAutopilotClip(job, idx, action.clipIdx);
                const updated = await commitJobUpdate(
                    jobId,
                    (cur) => applyClip(cur, idx, action.clipIdx, gcsUri, { usedVeo })
                );
                return { action: action.type, job: updated };
            }

            if (action.type === ACTION.COMPOSE) {
                const finalUri = await deliverAutopilotVariant(job, idx);
                const updated = await commitJobUpdate(jobId, (cur) => applyCompose(cur, idx, finalUri));
                return { action: action.type, job: updated };
            }
        } catch (err) {
            console.error(`[Autopilot] ${jobId} variant ${idx} failed:`, err.message);
            const updated = await commitJobUpdate(jobId, (cur) => failVariant(cur, idx, err.message));
            return { action: action.type, job: updated, error: err.message };
        }

        return { action: action.type, job };
    } finally {
        claimedActions.delete(key);
    }
};

// POST /api/autopilot/upload-url
// Body: { contentType: string, sizeBytes: number }
// Returns: { uploadUrl, gcsUri, uploadId, expiresAt, requiredHeaders }
//
// The browser PUTs the gameplay file straight to Cloud Storage with this URL.
// That is not an optimisation: Cloud Run's HTTP/1 request body limit is 32 MiB
// and cannot be raised, so a 250 MB upload can never transit the app.
apiRouter.post('/autopilot/upload-url', autopilotOnly, async (req, res) => {
    // Signed-URL uploads bypass the app entirely, so validate before handing the
    // URL out — afterwards the object lands in the bucket without touching our code.
    const check = validateUploadRequest(req.body || {}, { maxBytes: AUTOPILOT_UPLOAD_MAX_BYTES });
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    const { contentType, size } = check;

    try {
        const uploadId = randomUUID();
        const objectName = `${AUTOPILOT_UPLOAD_PREFIX}/${uploadId}/gameplay.${check.ext}`;
        const expiresAt = Date.now() + AUTOPILOT_UPLOAD_TTL_MS;

        // v4 signing binds the method and content type: the URL cannot be reused
        // to write anything else, and the client must echo the same header.
        const [uploadUrl] = await getStorage()
            .bucket(GCS_BUCKET_NAME)
            .file(objectName)
            .getSignedUrl({
                version: 'v4',
                action: 'write',
                expires: expiresAt,
                contentType,
            });

        console.log(`[Autopilot] upload URL for ${objectName} (${(size / 1048576).toFixed(1)} MB)`);
        res.json({
            uploadUrl,
            gcsUri: `gs://${GCS_BUCKET_NAME}/${objectName}`,
            uploadId,
            expiresAt,
            requiredHeaders: { 'Content-Type': contentType },
        });
    } catch (err) {
        console.error('[Autopilot] upload-url error:', err);
        res.status(500).json({ error: 'Failed to create upload URL: ' + err.message });
    }
});

// ── concurrency ──────────────────────────────────────────────────────────────
// A batch is mostly waiting on the video models, so several clips are kept in
// flight. The ceilings are separate because the constraints are:
//   * clips  — Omni's 50 requests/minute quota
//   * compose — CPU; ffmpeg saturates the container's 2 vCPU

const activeClipWork = new Map();     // jobId → count of in-flight clip actions
const activeComposeWork = new Map();  // jobId → count of in-flight composites

const bump = (map, key, delta) => {
    const next = (map.get(key) || 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
    return next;
};

const totalOf = (map) => [...map.values()].reduce((a, b) => a + b, 0);

/**
 * Drive one job with several workers until it can make no further progress.
 *
 * Safe to call repeatedly: workers claim distinct actions through nextAction on
 * freshly loaded state, and every unit checkpoints before the next is chosen.
 * `awaiting_avatar` returns at once because nextAction yields no work there.
 */
const driveJob = async (jobId) => {
    for (;;) {
        const job = await loadJob(jobId);
        if (!job || isTerminal(job)) return;

        // Skip whatever peers are already doing so each worker takes fresh work.
        const claimedForJob = new Set(
            [...claimedActions]
                .filter((k) => k.startsWith(`${jobId}#`))
                .map((k) => k.slice(jobId.length + 1))
        );
        const action = nextAction(job, { exclude: claimedForJob });
        if (action.type === ACTION.WAIT_APPROVAL || action.type === ACTION.NOTHING) return;

        const isCompose = action.type === ACTION.COMPOSE;
        const limit = isCompose ? AUTOPILOT_COMPOSE_CONCURRENCY : AUTOPILOT_CONCURRENCY;
        const map = isCompose ? activeComposeWork : activeClipWork;
        if (totalOf(map) >= limit) {
            // Saturated for this kind of work; whoever frees a slot carries on.
            // Yield rather than spin.
            await new Promise((r) => setTimeout(r, 1500));
            continue;
        }

        bump(map, jobId, 1);
        try {
            const result = await tickJob(jobId, action);
            if (result?.skipped === 'missing') return;
        } finally {
            bump(map, jobId, -1);
        }
    }
};

/** Start up to `n` cooperating workers on a job without blocking the caller. */
const scheduleJob = (jobId, n = AUTOPILOT_CONCURRENCY) => {
    for (let i = 0; i < n; i += 1) {
        driveJob(jobId).catch((err) => console.error(`[Autopilot] worker error on ${jobId}:`, err.message));
    }
};

/**
 * Pick up jobs that stopped making progress.
 *
 * Needed because an instance can vanish mid-batch. Jobs at the approval gate are
 * skipped: they are not stalled, they are waiting for a person, and sweeping them
 * must never be what starts the expensive work.
 */
const resumeStalledJobs = async ({ olderThanMs = 90 * 1000, limit = 20 } = {}) => {
    const db = getDb();
    if (!db) return { resumed: 0 };
    const [entities] = await db.runQuery(
        db.createQuery(AUTOPILOT_JOB_KIND).filter('status', '=', JOB_STATUS.RUNNING).limit(limit)
    );
    const cutoff = Date.now() - olderThanMs;
    let resumed = 0;
    for (const entity of entities) {
        const job = entityToJob(entity);
        if (!job) continue;
        if (new Date(job.updatedAt).getTime() > cutoff) continue; // still moving
        console.log(`[Autopilot] resuming stalled job ${job.id}`);
        scheduleJob(job.id);
        resumed += 1;
    }
    return { resumed, scanned: entities.length };
};

// POST /api/autopilot/resume
// Sweep for stalled jobs. Intended for a Cloud Scheduler cron so a batch keeps
// moving after the user closes the tab; harmless to call by hand.
apiRouter.post('/autopilot/resume', autopilotOnly, async (req, res) => {
    try {
        const result = await resumeStalledJobs();
        res.json(result);
    } catch (err) {
        console.error('[Autopilot] resume error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/autopilot/jobs
// Body: the job spec (see validateJobSpec). Returns { jobId, status }.
// Renders the avatar candidate synchronously so the client lands straight on the
// confirmation gate.
apiRouter.post('/autopilot/jobs', autopilotOnly, async (req, res) => {
    const owner = ownerKeyOf(req);
    const check = validateJobSpec(req.body || {}, {
        maxBatch: AUTOPILOT_MAX_BATCH,
        maxClipsPerJob: AUTOPILOT_MAX_CLIPS_PER_JOB,
        ownBucket: GCS_BUCKET_NAME,
    });
    if (!check.ok) return res.status(check.status).json({ error: check.error });

    // The gameplay object is validated for real before anything is spent: a URI
    // that does not resolve, or is not decodable video, fails the job now.
    if (check.spec.gameplayGcsUri) {
        const parsed = parseOwnBucketUri(check.spec.gameplayGcsUri, GCS_BUCKET_NAME);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        try {
            const [exists] = await getStorage().bucket(parsed.bucket).file(parsed.object).exists();
            if (!exists) {
                return res.status(400).json({ error: 'gameplayGcsUri does not exist — finish the upload first' });
            }
        } catch (err) {
            return res.status(400).json({ error: 'Could not read gameplayGcsUri: ' + err.message });
        }
    }

    try {
        let job = createJob({ id: `ap-${randomUUID()}`, ownerEmail: owner, spec: check.spec });
        await saveJob(job);

        // Render the first candidate now; on failure the job survives so the user
        // can regenerate rather than losing the whole submission.
        try {
            const candidates = await renderAvatarCandidates(job, 1);
            job = setAvatarCandidates(job, candidates);
        } catch (err) {
            console.error('[Autopilot] initial avatar failed:', err.message);
            job = { ...job, status: JOB_STATUS.AWAITING_AVATAR, error: `Avatar generation failed: ${err.message}` };
        }
        await saveJob(job);

        const plannedClips = check.spec.variantCount * 4;
        console.log(`[Autopilot] created ${job.id} (${check.spec.variantCount} variants) for ${owner}`);
        res.status(201).json({
            jobId: job.id,
            ...summarise(job),
            // Surfaced so the confirmation gate can state the cost before the
            // user unlocks the expensive half of the pipeline.
            costPreview: {
                estimatedClips: plannedClips,
                veoBudget: job.veoBudget,
                veoSafetyNet: Boolean(VIDEO_MODEL_LAST_RESORT),
            },
        });
    } catch (err) {
        console.error('[Autopilot] create job error:', err);
        res.status(500).json({ error: 'Failed to create job: ' + err.message });
    }
});

/** Signed read URLs for whatever the job has produced so far. */
const signJobMedia = async (job) => {
    const sign = async (gcsUri) => {
        if (!gcsUri) return null;
        const parsed = parseOwnBucketUri(gcsUri, GCS_BUCKET_NAME);
        if (!parsed.ok) return null;
        try {
            const [url] = await getStorage().bucket(parsed.bucket).file(parsed.object).getSignedUrl({
                action: 'read',
                expires: Date.now() + 60 * 60 * 1000,
            });
            return url;
        } catch { return null; }
    };
    const avatarUrls = await Promise.all(job.avatar.candidates.map((c) => sign(c.gcsUri)));
    const outputUrls = await Promise.all(job.variants.map((v) => sign(v.finalUri)));
    return {
        avatarCandidateUrls: avatarUrls,
        outputs: job.variants.map((v, i) => ({
            idx: v.idx,
            url: outputUrls[i],
            downloadName: outputUrls[i] ? `${job.spec.gameTitle || 'video'}-v${v.idx + 1}.mp4` : null,
        })).filter((o) => o.url),
    };
};

// GET /api/autopilot/jobs
apiRouter.get('/autopilot/jobs', autopilotOnly, async (req, res) => {
    try {
        const jobs = await listJobs(ownerKeyOf(req));
        res.json({ jobs: jobs.map(summarise) });
    } catch (err) {
        console.error('[Autopilot] list error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/autopilot/jobs/:id
// Also advances the job by one step, so a polling client keeps the pipeline
// moving even on an instance with no background CPU. The gate is unaffected:
// nextAction returns WAIT_APPROVAL there and no work is done.
apiRouter.get('/autopilot/jobs/:id', autopilotOnly, async (req, res) => {
    try {
        const owner = ownerKeyOf(req);
        let job = await loadOwnedJob(req.params.id, owner);
        if (!job) return res.status(404).json({ error: 'Job not found' });

        if (!isTerminal(job) && job.status === JOB_STATUS.RUNNING) {
            // Fire and forget: the response reflects the state we already have,
            // the next poll picks up whatever these workers complete. This is what
            // keeps a batch moving on an instance with no background CPU.
            scheduleJob(job.id);
        }

        const media = await signJobMedia(job);
        res.json({ ...summarise(job), ...media });
    } catch (err) {
        console.error('[Autopilot] get job error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/autopilot/jobs/:id/avatar/regenerate
// Body: { avatarPrompt?, avatarRefGcsUri? }
apiRouter.post('/autopilot/jobs/:id/avatar/regenerate', autopilotOnly, async (req, res) => {
    try {
        const job = await loadOwnedJob(req.params.id, ownerKeyOf(req));
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (job.status !== JOB_STATUS.AWAITING_AVATAR && job.status !== JOB_STATUS.CREATED) {
            return res.status(409).json({ error: `Cannot regenerate the avatar while the job is ${job.status}` });
        }

        const { avatarPrompt, avatarRefGcsUri } = req.body || {};
        if (avatarRefGcsUri) {
            const parsed = parseOwnBucketUri(avatarRefGcsUri, GCS_BUCKET_NAME);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        }
        const staged = {
            ...job,
            spec: {
                ...job.spec,
                avatarPrompt: avatarPrompt ? String(avatarPrompt).trim() : job.spec.avatarPrompt,
                avatarRefGcsUri: avatarRefGcsUri !== undefined ? avatarRefGcsUri : job.spec.avatarRefGcsUri,
            },
        };
        const candidates = await renderAvatarCandidates(staged, 1);
        const updated = await commitJobUpdate(job.id, (cur) => ({
            ...regenerateAvatar(cur, candidates, {
                prompt: avatarPrompt,
                refGcsUri: avatarRefGcsUri,
            }),
            error: null,
        }));

        const media = await signJobMedia(updated);
        res.json({ ...summarise(updated), ...media });
    } catch (err) {
        console.error('[Autopilot] regenerate error:', err);
        res.status(500).json({ error: 'Avatar regeneration failed: ' + err.message });
    }
});

// POST /api/autopilot/jobs/:id/avatar/upload-url
// Returns a signed PUT URL for a streamer image the user supplies themselves.
apiRouter.post('/autopilot/jobs/:id/avatar/upload-url', autopilotOnly, async (req, res) => {
    try {
        const job = await loadOwnedJob(req.params.id, ownerKeyOf(req));
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (isTerminal(job)) return res.status(409).json({ error: `Job is already ${job.status}` });

        const contentType = String(req.body?.contentType || 'image/png');
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) {
            return res.status(400).json({ error: 'Streamer image must be PNG, JPEG or WebP' });
        }
        const ext = contentType === 'image/png' ? 'png' : (contentType === 'image/jpeg' ? 'jpg' : 'webp');
        const objectName = `autopilot/${job.id}/avatar-supplied-${Date.now()}.${ext}`;
        const [uploadUrl] = await getStorage().bucket(GCS_BUCKET_NAME).file(objectName).getSignedUrl({
            version: 'v4', action: 'write', expires: Date.now() + 15 * 60 * 1000, contentType,
        });
        res.json({
            uploadUrl,
            gcsUri: `gs://${GCS_BUCKET_NAME}/${objectName}`,
            requiredHeaders: { 'Content-Type': contentType },
        });
    } catch (err) {
        console.error('[Autopilot] avatar upload-url error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/autopilot/jobs/:id/avatar/use-uploaded
// Body: { gcsUri }
apiRouter.post('/autopilot/jobs/:id/avatar/use-uploaded', autopilotOnly, async (req, res) => {
    try {
        const job = await loadOwnedJob(req.params.id, ownerKeyOf(req));
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (isTerminal(job)) return res.status(409).json({ error: `Job is already ${job.status}` });

        const parsed = parseOwnBucketUri(req.body?.gcsUri, GCS_BUCKET_NAME);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        const [exists] = await getStorage().bucket(parsed.bucket).file(parsed.object).exists();
        if (!exists) return res.status(400).json({ error: 'That image has not been uploaded yet' });

        const updated = await commitJobUpdate(job.id, (cur) => ({
            ...useUploadedAvatar(cur, req.body.gcsUri),
            error: null,
        }));
        const media = await signJobMedia(updated);
        res.json({ ...summarise(updated), ...media });
    } catch (err) {
        console.error('[Autopilot] use-uploaded error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/autopilot/jobs/:id/avatar/approve
// Body: { selected?: number[] }
//
// The only transition out of the gate. Everything expensive happens after this
// call, which is why it is an explicit user action and never inferred.
apiRouter.post('/autopilot/jobs/:id/avatar/approve', autopilotOnly, async (req, res) => {
    try {
        const job = await loadOwnedJob(req.params.id, ownerKeyOf(req));
        if (!job) return res.status(404).json({ error: 'Job not found' });

        // Transactional: a worker or a concurrent request must not clobber the
        // transition that unlocks the expensive half of the pipeline.
        let approveError = null;
        const updated = await commitJobUpdate(job.id, (cur) => {
            const r = approveAvatar(cur, req.body?.selected, {});
            if (!r.ok) { approveError = r.error; return null; }
            return r.job;
        });
        if (approveError) return res.status(409).json({ error: approveError });
        const result = { ok: true, job: updated };
        console.log(`[Autopilot] ${job.id} avatar approved → running`);

        // Kick the pipeline immediately with the full worker pool; polling and
        // the resume sweep carry it from here.
        scheduleJob(job.id);
        res.json(summarise(result.job));
    } catch (err) {
        console.error('[Autopilot] approve error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/autopilot/jobs/:id/tick
// Idempotent single-step advance. Exposed so the UI can drive the pipeline.
apiRouter.post('/autopilot/jobs/:id/tick', autopilotOnly, async (req, res) => {
    try {
        const job = await loadOwnedJob(req.params.id, ownerKeyOf(req));
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const result = await tickJob(job.id);
        const fresh = result.job || await loadJob(job.id);
        res.json({
            action: result.action || result.skipped || 'nothing',
            ...(fresh ? summarise(fresh) : {}),
        });
    } catch (err) {
        console.error('[Autopilot] tick endpoint error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/autopilot/jobs/:id/cancel
apiRouter.post('/autopilot/jobs/:id/cancel', autopilotOnly, async (req, res) => {
    try {
        const job = await loadOwnedJob(req.params.id, ownerKeyOf(req));
        if (!job) return res.status(404).json({ error: 'Job not found' });
        const cancelled = await commitJobUpdate(job.id, (cur) => cancelJob(cur));
        console.log(`[Autopilot] ${job.id} cancelled by ${job.ownerEmail}`);
        res.json(summarise(cancelled));
    } catch (err) {
        console.error('[Autopilot] cancel error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/autopilot/config
// Returns the caller-visible limits so the UI can validate before uploading.
apiRouter.get('/autopilot/config', autopilotOnly, (req, res) => {
    res.json({
        maxBatch: AUTOPILOT_MAX_BATCH,
        maxClipsPerJob: AUTOPILOT_MAX_CLIPS_PER_JOB,
        uploadMaxBytes: AUTOPILOT_UPLOAD_MAX_BYTES,
        allowedGameplayTypes: ALLOWED_GAMEPLAY_MIME,
        veoSafetyNet: Boolean(VIDEO_MODEL_LAST_RESORT),
    });
});

app.use('/api', apiRouter);

// Catch-all for API 404s
app.use('/api/*', (req, res) => {
    console.warn(`⚠️  [404] API route not found: ${req.originalUrl}`);
    res.status(404).json({ error: "API endpoint not found", path: req.originalUrl });
});


// --- SERVER STARTUP ---

const startServer = async () => {
    if (!IS_PRODUCTION) {
        console.log("⚡ [Server] Configuring Vite middleware (Development)...");
        try {
            const vite = await import('vite');
            const viteServer = await vite.createServer({
                server: { middlewareMode: true },
                appType: 'spa',
            });
            app.use(viteServer.middlewares);
        } catch (e) {
            console.error("❌ [Server] Failed to start Vite middleware:", e);
        }
    } 
    else {
        console.log("🚀 [Server] Configuring Static Serving (Production)...");
        const distPath = path.join(__dirname, 'dist');
        const indexHtmlPath = path.join(distPath, 'index.html');

        if (!fs.existsSync(indexHtmlPath)) {
            console.error(`❌ [Server] CRITICAL: 'dist/index.html' not found.`);
            console.error(`   Ensure 'vite' is in 'dependencies' in package.json so Cloud Run builds it.`);
        }

        // Serve static files
        app.use(express.static(distPath, {
            index: false,
            immutable: true,
            maxAge: '1y',
            fallthrough: true 
        }));

        // SPA Fallback
        app.get('*', (req, res) => {
            if (fs.existsSync(indexHtmlPath)) {
                // No API key injection needed — using Vertex AI via server-side proxy
                res.sendFile(indexHtmlPath);
            } else {
                res.status(500).send("Server Error: Build Output Missing. Check build logs.");
            }
        });
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n==================================================`);
        console.log(`✅ [Server] Listening on port ${PORT}`);
        console.log(`==================================================\n`);
    });
};

startServer().catch(e => {
    console.error("❌ [Server] Fatal startup error:", e);
    process.exit(1);
});
