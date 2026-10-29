/**
 * Autopilot job state machine.
 *
 * Deliberately pure: every transition is a function of the job document and the
 * result of one unit of work. The executor in server.js does the I/O and then
 * asks this module what changed and what to do next. That split is what makes
 * the machine testable — including the parts that matter most (the human gate
 * and the cost ceilings) without generating a single billable clip.
 *
 * Lifecycle:
 *
 *   created
 *      │ avatar candidates rendered
 *      ▼
 *   awaiting_avatar  ⏸  ──(regenerate, any number of times)──┐
 *      │                                                      └→ awaiting_avatar
 *      │ approve  ← the ONLY way out; no automatic path crosses this line
 *      ▼
 *   running ──→ completed             every variant delivered
 *      │    └─→ partially_completed   some delivered, some failed
 *      │    └─→ failed                nothing delivered
 *      └──(cancel, from any state)──→ cancelled
 *
 * Per variant: pending → script → clips → compose → done | failed
 */

import { veoBudgetFor } from './autopilot.js';

export const JOB_STATUS = {
    CREATED: 'created',
    AWAITING_AVATAR: 'awaiting_avatar',
    RUNNING: 'running',
    COMPLETED: 'completed',
    PARTIAL: 'partially_completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
};

export const VARIANT_STAGE = {
    PENDING: 'pending',
    SCRIPT: 'script',
    CLIPS: 'clips',
    COMPOSE: 'compose',
    DONE: 'done',
    FAILED: 'failed',
};

export const ACTION = {
    GENERATE_AVATAR: 'generate_avatar',
    WAIT_APPROVAL: 'wait_approval',
    GENERATE_SCRIPT: 'generate_script',
    GENERATE_CLIP: 'generate_clip',
    COMPOSE: 'compose',
    FINALISE: 'finalise',
    NOTHING: 'nothing',
};

const TERMINAL = [JOB_STATUS.COMPLETED, JOB_STATUS.PARTIAL, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED];

export const isTerminal = (job) => TERMINAL.includes(job?.status);

/** Segments assumed per variant before any script exists, for early budgeting. */
const ASSUMED_SEGMENTS = 4;

const LAYOUTS = ['classic-pip', 'stacked', 'streamer-only'];

/**
 * Fixed option sets, matching the wizard.
 *
 * These are not free text: the device decides how the streamer is described
 * holding (or not holding) a controller, and the pacing selects a word-count
 * table. A typo would silently produce a worse script, so the values are
 * whitelisted and anything unknown falls back to the default.
 */
export const GAMING_DEVICES = [
    'PC', 'Console', 'Mobile (Vertical)', 'Mobile (Horizontal)', 'Hands-free (No device)',
];
export const DIALOGUE_PACING = ['Slow', 'Normal', 'Fast'];
const RATIOS = ['16:9', '9:16'];
const PIP_PLACEMENTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * Validate the spec a client submits. Everything the pipeline will rely on is
 * checked here so a job never starts on inputs that cannot finish.
 */
export const validateJobSpec = (input, { maxBatch, maxClipsPerJob, ownBucket }) => {
    const spec = input || {};
    const fail = (error) => ({ ok: false, status: 400, error });

    const gameTitle = String(spec.gameTitle || '').trim();
    if (!gameTitle) return fail('gameTitle is required');

    if (!RATIOS.includes(spec.targetRatio)) {
        return fail(`targetRatio must be one of ${RATIOS.join(', ')}`);
    }
    if (!LAYOUTS.includes(spec.layoutType)) {
        return fail(`layoutType must be one of ${LAYOUTS.join(', ')}`);
    }
    if (spec.layoutType === 'classic-pip'
        && spec.pipPlacement
        && !PIP_PLACEMENTS.includes(spec.pipPlacement)) {
        return fail(`pipPlacement must be one of ${PIP_PLACEMENTS.join(', ')}`);
    }
    if (spec.layoutType === 'stacked') {
        const allowed = spec.targetRatio === '9:16' ? ['top', 'bottom'] : ['left', 'right'];
        if (spec.stackedPlacement && !allowed.includes(spec.stackedPlacement)) {
            return fail(`stackedPlacement for ${spec.targetRatio} must be one of ${allowed.join(', ')}`);
        }
    }

    const variantCount = Number(spec.variantCount);
    if (!Number.isInteger(variantCount) || variantCount < 1) {
        return fail('variantCount must be a positive integer');
    }

    // streamer-only never composites, so it needs no gameplay footage. Every
    // other layout does.
    const needsGameplay = spec.layoutType !== 'streamer-only';

    // One or more recordings. `gameplays` is the multi-recording form; a lone
    // `gameplayGcsUri` is the original single-recording form and means exactly
    // one entry with no overrides, so existing clients keep working unchanged.
    // Each recording may override the game it shows — a batch can mix games.
    let gameplays = [];
    if (needsGameplay) {
        const raw = Array.isArray(spec.gameplays) && spec.gameplays.length
            ? spec.gameplays
            : [{ gcsUri: spec.gameplayGcsUri }];
        if (raw.length > maxBatch) {
            return fail(`${raw.length} recordings exceed the maximum of ${maxBatch} videos per batch`);
        }
        for (let i = 0; i < raw.length; i += 1) {
            const uri = raw[i]?.gcsUri;
            if (!uri || typeof uri !== 'string' || !uri.startsWith(`gs://${ownBucket}/`)) {
                return fail(`${raw.length > 1 ? `Recording ${i + 1}: ` : ''}gameplayGcsUri must be an `
                          + 'object in the application bucket (upload it first via /api/autopilot/upload-url)');
            }
        }
        if (new Set(raw.map((g) => g.gcsUri)).size !== raw.length) {
            return fail('The same recording is listed more than once');
        }
        gameplays = raw.map((g) => ({
            gcsUri: g.gcsUri,
            gameTitle: String(g.gameTitle || '').trim(),
            gameUrl: String(g.gameUrl || '').trim(),
            callToAction: String(g.callToAction || '').trim(),
            label: String(g.label || '').trim().slice(0, 120),
        }));
    }

    // The batch ceiling is on finished videos, which is what costs money:
    // recordings × variants per recording.
    const totalVideos = variantCount * Math.max(1, gameplays.length);
    if (totalVideos > maxBatch) {
        return fail(gameplays.length > 1
            ? `${gameplays.length} recordings × ${variantCount} variants = ${totalVideos} videos, `
              + `over the maximum of ${maxBatch} per batch`
            : `variantCount ${variantCount} exceeds the maximum of ${maxBatch}`);
    }

    // Either describe the streamer, or supply a finished image of one.
    const suppliedStreamer = spec.avatarImageGcsUri;
    if (!String(spec.avatarPrompt || '').trim() && !suppliedStreamer) {
        return fail('Either avatarPrompt or avatarImageGcsUri is required — '
                  + 'the streamer has to come from somewhere');
    }

    // Image URIs must be objects this app wrote. They arrive from the upload
    // endpoint, so anything else is either a mistake or an attempt to point the
    // pipeline at a foreign object.
    for (const [field, uri] of [
        ['avatarRefGcsUri', spec.avatarRefGcsUri],
        ['avatarImageGcsUri', suppliedStreamer],
    ]) {
        if (uri === undefined || uri === null || uri === '') continue;
        if (typeof uri !== 'string' || !uri.startsWith(`gs://${ownBucket}/`)) {
            return fail(`${field} must be an object in the application bucket `
                      + '(upload it first via /api/autopilot/image-upload-url)');
        }
    }

    // Cost circuit breaker, applied on the assumed shot count. Re-checked for
    // real once the first script comes back.
    const assumedClips = totalVideos * ASSUMED_SEGMENTS;
    if (assumedClips > maxClipsPerJob) {
        return fail(`${totalVideos} videos would need roughly ${assumedClips} clips, `
                  + `over the ${maxClipsPerJob} limit for one job`);
    }

    return {
        ok: true,
        spec: {
            gameTitle,
            gameUrl: String(spec.gameUrl || '').trim(),
            callToAction: String(spec.callToAction || '').trim(),
            gamingDevice: GAMING_DEVICES.includes(spec.gamingDevice) ? spec.gamingDevice : 'PC',
            dialoguePacing: DIALOGUE_PACING.includes(spec.dialoguePacing) ? spec.dialoguePacing : 'Normal',
            extraInstructions: String(spec.extraInstructions || '').trim(),
            targetRatio: spec.targetRatio,
            layoutType: spec.layoutType,
            pipPlacement: spec.pipPlacement || 'bottom-left',
            stackedPlacement: spec.stackedPlacement
                || (spec.targetRatio === '9:16' ? 'top' : 'left'),
            subtitles: Boolean(spec.subtitles),
            // Cutout mode only makes sense over gameplay in a picture-in-picture
            // box: stacked fills its whole slot with the streamer, and
            // streamer-only has nothing to sit on.
            removeBackground: Boolean(spec.removeBackground) && spec.layoutType === 'classic-pip',
            // Grounding needs somewhere to look. Without a store URL the flag is
            // meaningless, so it is dropped rather than silently ignored later.
            // A store URL may now come from the job or from any recording's own
            // brief; grounding is checked per variant against the URL it ends up
            // with (see briefForVariant).
            searchGrounding: Boolean(spec.searchGrounding)
                && (Boolean(String(spec.gameUrl || '').trim()) || gameplays.some((g) => g.gameUrl)),
            // Variants per recording. The job holds variantCount × recordings.
            variantCount,
            variantMode: 'vary-script', // the only mode implemented; see the plan
            gameplays,
            // Kept for anything that still reads the single-recording field; it is
            // always the first recording.
            gameplayGcsUri: gameplays[0]?.gcsUri || null,
            avatarPrompt: String(spec.avatarPrompt || '').trim(),
            avatarRefGcsUri: typeof spec.avatarRefGcsUri === 'string' && spec.avatarRefGcsUri
                ? spec.avatarRefGcsUri : null,
            // When set, generation is skipped entirely and this image goes straight
            // to the confirmation gate.
            avatarImageGcsUri: typeof suppliedStreamer === 'string' && suppliedStreamer
                ? suppliedStreamer : null,
            volumes: {
                gameplay: Number.isFinite(Number(spec.volumes?.gameplay))
                    ? Number(spec.volumes.gameplay) : 0.4,
                streamer: Number.isFinite(Number(spec.volumes?.streamer))
                    ? Number(spec.volumes.streamer) : 1,
            },
        },
    };
};

/** A fresh job document, ready for the avatar stage. */
// ── recordings ────────────────────────────────────────────────────────────────

/**
 * The recordings a job composites over, normalised. Jobs created before
 * multi-recording support carry only `gameplayGcsUri`; they read as one recording
 * with no overrides, so no stored job needs migrating.
 */
export const gameplaysOf = (spec) => {
    if (Array.isArray(spec?.gameplays) && spec.gameplays.length) return spec.gameplays;
    return spec?.gameplayGcsUri
        ? [{ gcsUri: spec.gameplayGcsUri, gameTitle: '', gameUrl: '', callToAction: '', label: '' }]
        : [];
};

/** Finished videos in the batch: variants per recording × recordings. */
export const totalVariants = (spec) => spec.variantCount * Math.max(1, gameplaysOf(spec).length);

/** The recording a variant is composited over, or null for streamer-only. */
export const gameplayForVariant = (job, variantIdx) => {
    const v = job.variants.find((x) => x.idx === variantIdx);
    const list = gameplaysOf(job.spec);
    return list[v?.gameplayIdx ?? 0] || null;
};

/**
 * The brief a variant's script is written from: the recording's own game, store
 * page and call to action where it sets them, the job's otherwise. This is what
 * lets one batch carry recordings of different games.
 */
export const briefForVariant = (job, variantIdx) => {
    const s = job.spec;
    const v = job.variants.find((x) => x.idx === variantIdx);
    const g = gameplayForVariant(job, variantIdx);
    const gameUrl = g?.gameUrl || s.gameUrl || '';
    return {
        gameTitle: g?.gameTitle || s.gameTitle,
        gameUrl,
        callToAction: g?.callToAction || s.callToAction || '',
        searchGrounding: Boolean(s.searchGrounding) && Boolean(gameUrl),
        gameplayGcsUri: g?.gcsUri || null,
        gameplayIdx: v?.gameplayIdx ?? 0,
        // Legacy variants have no angleIdx; their idx was the angle.
        angleIdx: v?.angleIdx ?? variantIdx,
    };
};

export const createJob = ({ id, ownerEmail, spec, now = new Date() }) => ({
    id,
    ownerEmail,
    status: JOB_STATUS.CREATED,
    createdAt: now,
    updatedAt: now,
    spec,
    avatar: {
        candidates: [],
        approvedIdx: [],
        approvedAt: null,
        regenCount: 0,
        source: null,
    },
    // Variants are laid out recording by recording: recording 0's variants first,
    // then recording 1's. `angleIdx` is the variant's position within its
    // recording, so every recording gets the same spread of creative angles.
    variants: Array.from({ length: totalVariants(spec) }, (_, idx) => ({
        idx,
        gameplayIdx: Math.floor(idx / spec.variantCount),
        angleIdx: idx % spec.variantCount,
        stage: VARIANT_STAGE.PENDING,
        scriptSegments: null,
        clipUris: [],
        finalUri: null,
        error: null,
        veoClips: 0,
    })),
    counters: { veoUsed: 0 },
    veoBudget: veoBudgetFor(totalVariants(spec) * ASSUMED_SEGMENTS),
    error: null,
});

/** Stable identity for an action, so concurrent workers can avoid colliding. */
export const actionKey = (action) => [
    action.type,
    action.variantIdx ?? '-',
    action.clipIdx ?? '-',
].join(':');

/**
 * Decide the next unit of work.
 *
 * `awaiting_avatar` resolves to WAIT_APPROVAL, never to work. The executor, the
 * poll-driven tick and the resume sweep all consult this function, so the human
 * gate is enforced in one place for every caller.
 *
 * `exclude` lets several workers run on one job: each claims the action it is
 * about to perform, and the next worker skips over it. `skipTypes` passes over
 * whole kinds of work the caller cannot take on, so it is handed the next kind
 * instead of waiting on a full queue. Without this every worker
 * would be handed the same first outstanding clip and the batch would run
 * strictly serially.
 */
export const nextAction = (job, { exclude, skipTypes } = {}) => {
    if (!job || isTerminal(job)) return { type: ACTION.NOTHING };
    const taken = exclude instanceof Set ? exclude : new Set(exclude || []);
    // Action types the caller has no capacity for right now. Without this a worker
    // was always handed the first outstanding clip while clip slots were full, and
    // a variant whose clips were done waited for every other variant's clips to be
    // handed out before it could composite — measured as 2.5 idle minutes on a
    // 6-video batch.
    const skip = skipTypes instanceof Set ? skipTypes : new Set(skipTypes || []);
    const free = (action) => !taken.has(actionKey(action)) && !skip.has(action.type);

    if (job.status === JOB_STATUS.CREATED) {
        const action = job.avatar?.candidates?.length
            ? { type: ACTION.WAIT_APPROVAL }
            : { type: ACTION.GENERATE_AVATAR };
        return free(action) ? action : { type: ACTION.NOTHING };
    }
    if (job.status === JOB_STATUS.AWAITING_AVATAR) {
        return { type: ACTION.WAIT_APPROVAL };
    }

    // running — scripts first so every variant gets its shot list early, then
    // clips, then composites.
    for (const v of job.variants) {
        if (v.stage !== VARIANT_STAGE.PENDING) continue;
        const action = { type: ACTION.GENERATE_SCRIPT, variantIdx: v.idx };
        if (free(action)) return action;
    }
    // Clips are handed out variant-by-variant rather than round-robin: finishing
    // one variant early means the user has a watchable video while the rest are
    // still rendering, which matters more than every variant landing together.
    for (const v of job.variants) {
        if (v.stage !== VARIANT_STAGE.CLIPS) continue;
        for (let i = 0; i < v.clipUris.length; i += 1) {
            if (v.clipUris[i]) continue;
            const action = { type: ACTION.GENERATE_CLIP, variantIdx: v.idx, clipIdx: i };
            if (free(action)) return action;
        }
    }
    for (const v of job.variants) {
        if (v.stage !== VARIANT_STAGE.COMPOSE) continue;
        const action = { type: ACTION.COMPOSE, variantIdx: v.idx };
        if (free(action)) return action;
    }
    const settled = job.variants.every(
        (v) => v.stage === VARIANT_STAGE.DONE || v.stage === VARIANT_STAGE.FAILED
    );
    if (!settled) return { type: ACTION.NOTHING };
    const action = { type: ACTION.FINALISE };
    return free(action) ? action : { type: ACTION.NOTHING };
};

const touch = (job, now) => ({ ...job, updatedAt: now || new Date() });

/** Record rendered avatar candidates and stop at the gate. */
export const setAvatarCandidates = (job, candidates, { now = new Date() } = {}) => {
    if (isTerminal(job)) return job;
    return touch({
        ...job,
        status: JOB_STATUS.AWAITING_AVATAR,
        avatar: {
            ...job.avatar,
            candidates: candidates.map((c, i) => ({ idx: i, gcsUri: c.gcsUri })),
            source: 'generated',
        },
    }, now);
};

/** Replace the candidates after a regenerate. The job stays at the gate. */
export const regenerateAvatar = (job, candidates, { prompt, refGcsUri, now = new Date() } = {}) => {
    if (isTerminal(job)) return job;
    return touch({
        ...job,
        status: JOB_STATUS.AWAITING_AVATAR,
        spec: {
            ...job.spec,
            avatarPrompt: prompt ? String(prompt).trim() : job.spec.avatarPrompt,
            avatarRefGcsUri: refGcsUri !== undefined ? refGcsUri : job.spec.avatarRefGcsUri,
        },
        avatar: {
            ...job.avatar,
            candidates: candidates.map((c, i) => ({ idx: i, gcsUri: c.gcsUri })),
            regenCount: (job.avatar.regenCount || 0) + 1,
            source: 'generated',
        },
    }, now);
};

/** Accept a streamer image the user supplied instead of a generated one. */
export const useUploadedAvatar = (job, gcsUri, { now = new Date() } = {}) => {
    if (isTerminal(job)) return job;
    return touch({
        ...job,
        status: JOB_STATUS.AWAITING_AVATAR,
        avatar: {
            ...job.avatar,
            candidates: [{ idx: 0, gcsUri }],
            source: 'uploaded',
        },
    }, now);
};

/**
 * Cross the gate.
 *
 * The single transition into `running`, and therefore the single point at which
 * the job becomes able to spend money on clips.
 */
export const approveAvatar = (job, selectedIdx = [0], { now = new Date() } = {}) => {
    if (isTerminal(job)) {
        return { ok: false, error: `Job is already ${job.status}`, job };
    }
    if (job.status !== JOB_STATUS.AWAITING_AVATAR) {
        return { ok: false, error: 'No avatar is waiting for approval', job };
    }
    const available = job.avatar.candidates.map((c) => c.idx);
    const chosen = (Array.isArray(selectedIdx) && selectedIdx.length ? selectedIdx : [0])
        .map(Number)
        .filter((i) => available.includes(i));
    if (!chosen.length) {
        return { ok: false, error: 'Selected avatar index does not exist', job };
    }
    return {
        ok: true,
        job: touch({
            ...job,
            status: JOB_STATUS.RUNNING,
            avatar: { ...job.avatar, approvedIdx: chosen, approvedAt: now },
        }, now),
    };
};

/** The gs:// URI a variant should build on. */
export const avatarUriForVariant = (job, variantIdx) => {
    const chosen = job.avatar.approvedIdx;
    if (!chosen?.length) return null;
    // vary-script locks one avatar for the whole batch; the modulo keeps the
    // helper correct if the avatar-varying modes are enabled later.
    const pick = chosen[variantIdx % chosen.length];
    return job.avatar.candidates.find((c) => c.idx === pick)?.gcsUri || null;
};

/**
 * Attach a generated script and size the clip slots.
 *
 * This is where the real clip count becomes known, so the per-job ceiling and
 * the Veo budget are recomputed against it rather than the assumption.
 */
export const applyScript = (job, variantIdx, segments, { maxClipsPerJob, now = new Date() } = {}) => {
    if (isTerminal(job)) return { ok: false, error: `Job is already ${job.status}`, job };
    if (!Array.isArray(segments) || !segments.length) {
        return { ok: false, error: 'Script produced no segments', job };
    }

    const projected = segments.length * job.variants.length;
    if (maxClipsPerJob && projected > maxClipsPerJob) {
        return {
            ok: false,
            fatal: true,
            error: `Script has ${segments.length} shots; ${job.variants.length} videos `
                 + `would need ${projected} clips, over the ${maxClipsPerJob} limit`,
            job: touch({ ...job, status: JOB_STATUS.FAILED, error: 'clip budget exceeded' }, now),
        };
    }

    const variants = job.variants.map((v) => (v.idx === variantIdx
        ? {
            ...v,
            stage: VARIANT_STAGE.CLIPS,
            scriptSegments: segments,
            clipUris: new Array(segments.length).fill(null),
        }
        : v));

    return {
        ok: true,
        job: touch({
            ...job,
            variants,
            veoBudget: veoBudgetFor(projected),
        }, now),
    };
};

/** True while the batch may still fall through to pay-as-you-go Veo. */
// ── cross-instance work leases ────────────────────────────────────────────────
//
// Cloud Run runs several instances, and every poll schedules workers on whichever
// instance it lands on. An in-process claim set cannot see the other instances, so
// the same clip and the same composite used to run several times over: one measured
// batch delivered 15 composites for 3 variants across 6 instances, and another
// sent 72 Omni requests in a minute for 12 clips, tripping the quota.
//
// A lease is recorded on the job itself and taken inside the same transaction that
// guards every other write, so exactly one worker anywhere can hold an action. It
// expires, so a vanished instance does not strand its work; the holder renews it
// while the action runs.

export const LEASE_TTL_MS = 3 * 60 * 1000;

const nowMs = (now) => (now instanceof Date ? now.getTime() : Number(now ?? Date.now()));

/** Keys of leases that are still live, whoever holds them. */
export const activeLeaseKeys = (job, { now = Date.now() } = {}) => {
    const t = nowMs(now);
    return new Set(Object.entries(job?.leases || {})
        .filter(([, l]) => l && Number(l.until) > t)
        .map(([k]) => k));
};

const liveLeases = (job, t) => Object.fromEntries(
    Object.entries(job?.leases || {}).filter(([, l]) => l && Number(l.until) > t)
);

/**
 * Whether an action still needs doing on this state of the job. A worker's view
 * can be stale by the time it commits, so a lease is only granted, and a failure
 * only recorded, for work that is genuinely outstanding.
 */
export const isActionOutstanding = (job, action) => {
    if (!job || isTerminal(job) || !action) return false;
    const v = action.variantIdx === undefined ? null : job.variants.find((x) => x.idx === action.variantIdx);
    switch (action.type) {
        case ACTION.GENERATE_AVATAR:
            return job.status === JOB_STATUS.CREATED && !job.avatar?.candidates?.length;
        case ACTION.GENERATE_SCRIPT:
            return job.status === JOB_STATUS.RUNNING && v?.stage === VARIANT_STAGE.PENDING;
        case ACTION.GENERATE_CLIP:
            return job.status === JOB_STATUS.RUNNING && v?.stage === VARIANT_STAGE.CLIPS
                && !v.clipUris[action.clipIdx];
        case ACTION.COMPOSE:
            return job.status === JOB_STATUS.RUNNING && v?.stage === VARIANT_STAGE.COMPOSE;
        case ACTION.FINALISE:
            return job.status === JOB_STATUS.RUNNING
                && job.variants.every((x) => x.stage === VARIANT_STAGE.DONE || x.stage === VARIANT_STAGE.FAILED);
        default:
            return false;
    }
};

/** Take the lease for an action. Fails if someone else holds it or the work is gone. */
export const acquireLease = (job, action, owner, { now = Date.now(), ttlMs = LEASE_TTL_MS } = {}) => {
    const t = nowMs(now);
    const key = actionKey(action);
    const held = job?.leases?.[key];
    if (held && Number(held.until) > t && held.owner !== owner) {
        return { ok: false, reason: 'leased', job };
    }
    if (!isActionOutstanding(job, action)) return { ok: false, reason: 'not-needed', job };
    return {
        ok: true,
        job: touch({ ...job, leases: { ...liveLeases(job, t), [key]: { owner, until: t + ttlMs } } }, new Date(t)),
    };
};

/** Extend a lease this owner still holds. `ok: false` means it was lost. */
export const renewLease = (job, action, owner, { now = Date.now(), ttlMs = LEASE_TTL_MS } = {}) => {
    const t = nowMs(now);
    const key = actionKey(action);
    if (job?.leases?.[key]?.owner !== owner) return { ok: false, job };
    return {
        ok: true,
        job: touch({ ...job, leases: { ...liveLeases(job, t), [key]: { owner, until: t + ttlMs } } }, new Date(t)),
    };
};

/** Drop a lease this owner holds; anyone else's is left alone. */
export const releaseLease = (job, action, owner, { now = Date.now() } = {}) => {
    const t = nowMs(now);
    const key = actionKey(action);
    const leases = liveLeases(job, t);
    if (leases[key]?.owner === owner) delete leases[key];
    return { ...job, leases };
};

/**
 * Record a failure only if this worker's action is still the live one. Without the
 * guard a duplicate worker's error overwrote a variant another worker had already
 * carried into compose — observed as a whole batch failing with "Veo returned no
 * video" after its clips had in fact all been produced.
 */
export const failAction = (job, action, owner, error, { now = new Date() } = {}) => {
    const held = job?.leases?.[actionKey(action)];
    if (held && held.owner !== owner && Number(held.until) > nowMs(now)) return null;
    if (!isActionOutstanding(job, action)) return null;
    return failVariant(job, action.variantIdx, error, { now });
};

/**
 * Reserve one pay-as-you-go Veo clip against the batch budget *before* calling Veo.
 * Checking a stale copy and counting afterwards let every concurrent worker see
 * budget left: a batch with a budget of 4 started 13 Veo jobs in the same second.
 */
export const reserveVeo = (job, { now = new Date() } = {}) => {
    if (!canUseVeo(job)) return { ok: false, job };
    return {
        ok: true,
        job: touch({ ...job, counters: { ...job.counters, veoUsed: (job.counters?.veoUsed || 0) + 1 } }, now),
    };
};

export const canUseVeo = (job) => (job.counters?.veoUsed || 0) < (job.veoBudget || 0);

/** Record a finished clip; the variant advances to compose once all are in. */
export const applyClip = (job, variantIdx, clipIdx, gcsUri, {
    usedVeo = false,
    // The Veo clip was already counted by reserveVeo; do not count it twice.
    veoReserved = false,
    now = new Date(),
} = {}) => {
    if (isTerminal(job)) return job;
    // First result wins. A late duplicate must not replace a clip the variant may
    // already have been composited from.
    const target = job.variants.find((v) => v.idx === variantIdx);
    if (!target || target.stage !== VARIANT_STAGE.CLIPS || target.clipUris[clipIdx]) return job;
    const countVeo = usedVeo && !veoReserved;
    const variants = job.variants.map((v) => {
        if (v.idx !== variantIdx) return v;
        const clipUris = [...v.clipUris];
        clipUris[clipIdx] = gcsUri;
        const complete = clipUris.every(Boolean);
        return {
            ...v,
            clipUris,
            veoClips: v.veoClips + (usedVeo ? 1 : 0),
            stage: complete
                // streamer-only has nothing to composite; the concatenation is
                // the deliverable, so it goes straight to compose which the
                // executor handles as "stitch only".
                ? VARIANT_STAGE.COMPOSE
                : VARIANT_STAGE.CLIPS,
        };
    });
    return touch({
        ...job,
        variants,
        counters: { ...job.counters, veoUsed: (job.counters.veoUsed || 0) + (countVeo ? 1 : 0) },
    }, now);
};

/** Record the delivered video for a variant. */
export const applyCompose = (job, variantIdx, finalUri, { now = new Date() } = {}) => {
    if (isTerminal(job)) return job;
    // A duplicate composite arriving late must not overwrite the delivered one.
    if (job.variants.find((v) => v.idx === variantIdx)?.stage !== VARIANT_STAGE.COMPOSE) return job;
    const variants = job.variants.map((v) => (v.idx === variantIdx
        ? { ...v, stage: VARIANT_STAGE.DONE, finalUri, error: null }
        : v));
    return touch({ ...job, variants }, now);
};

/**
 * Fail one variant without touching the others.
 *
 * Partial delivery is intentional: in a batch the odd failure is normal and must
 * not cost the user the variants that did succeed.
 */
export const failVariant = (job, variantIdx, error, { now = new Date() } = {}) => {
    if (isTerminal(job)) return job;
    const variants = job.variants.map((v) => (v.idx === variantIdx
        ? { ...v, stage: VARIANT_STAGE.FAILED, error: String(error || 'unknown error').slice(0, 500) }
        : v));
    return touch({ ...job, variants }, now);
};

/** Roll the settled variants up into a terminal job status. */
export const finalise = (job, { now = new Date() } = {}) => {
    if (isTerminal(job)) return job;
    const done = job.variants.filter((v) => v.stage === VARIANT_STAGE.DONE).length;
    const failed = job.variants.filter((v) => v.stage === VARIANT_STAGE.FAILED).length;
    let status = JOB_STATUS.COMPLETED;
    if (done === 0) status = JOB_STATUS.FAILED;
    else if (failed > 0) status = JOB_STATUS.PARTIAL;
    return touch({ ...job, status }, now);
};

export const cancelJob = (job, { now = new Date() } = {}) => {
    if (isTerminal(job)) return job;
    return touch({ ...job, status: JOB_STATUS.CANCELLED }, now);
};

/** Client-facing view: progress plus whatever has already been delivered. */
export const summarise = (job) => {
    const done = job.variants.filter((v) => v.stage === VARIANT_STAGE.DONE).length;
    const failed = job.variants.filter((v) => v.stage === VARIANT_STAGE.FAILED).length;
    const totalClips = job.variants.reduce((n, v) => n + v.clipUris.length, 0);
    const readyClips = job.variants.reduce((n, v) => n + v.clipUris.filter(Boolean).length, 0);
    return {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        // Enough to recognise a batch in a list. Without it the history is a
        // column of opaque ids and reopening the right one is guesswork.
        gameTitle: job.spec?.gameTitle || '',
        layoutType: job.spec?.layoutType || null,
        targetRatio: job.spec?.targetRatio || null,
        awaitingApproval: job.status === JOB_STATUS.AWAITING_AVATAR,
        // Total videos in the batch (variants per recording × recordings).
        variantCount: job.variants.length,
        variantsPerGameplay: job.spec.variantCount,
        gameplays: gameplaysOf(job.spec).map((g, i) => ({
            idx: i,
            label: g.label || '',
            gameTitle: g.gameTitle || job.spec.gameTitle || '',
        })),
        doneCount: done,
        failedCount: failed,
        clipProgress: { ready: readyClips, total: totalClips },
        veo: { used: job.counters?.veoUsed || 0, budget: job.veoBudget || 0 },
        error: job.error || null,
        avatar: {
            source: job.avatar.source,
            regenCount: job.avatar.regenCount,
            approvedIdx: job.avatar.approvedIdx,
            candidateCount: job.avatar.candidates.length,
        },
        variants: job.variants.map((v) => ({
            idx: v.idx,
            gameplayIdx: v.gameplayIdx ?? 0,
            stage: v.stage,
            shots: v.scriptSegments?.length || 0,
            clipsReady: v.clipUris.filter(Boolean).length,
            error: v.error,
            hasOutput: Boolean(v.finalUri),
        })),
    };
};
