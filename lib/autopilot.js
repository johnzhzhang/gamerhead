/**
 * Autopilot pure logic — validation and policy decisions with no I/O, so they
 * can be unit-tested without standing up the server or touching Cloud Storage.
 *
 * server.js imports these; the HTTP layer stays a thin wrapper that turns the
 * results into status codes.
 */

/** Gameplay containers the pipeline is willing to accept. */
export const ALLOWED_GAMEPLAY_MIME = [
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-matroska',
    'video/x-msvideo',
];

/**
 * Images the console may upload: a reference image that pins the streamer's look,
 * or a finished streamer image supplied instead of generating one.
 *
 * Both need a real upload path. Accepting a caller-supplied gs:// URI alone is
 * not usable — nobody can be expected to hand-craft a storage URI — and it would
 * also mean trusting a pointer we never wrote.
 */
export const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'];

/** 12 MB is generous for a reference photo and keeps a stray upload bounded. */
export const IMAGE_UPLOAD_MAX_BYTES = 12 * 1024 * 1024;

const IMAGE_MIME_TO_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
};

export const extFromImageMime = (mime) => IMAGE_MIME_TO_EXT[mime] || 'png';

/** What the image is for; decides where it lands and how it is used. */
export const IMAGE_KINDS = ['reference', 'streamer'];

/**
 * Validate an image upload request.
 *
 * @returns {{ok: true, contentType: string, size: number, ext: string, kind: string}
 *          | {ok: false, status: number, error: string}}
 */
export const validateImageUploadRequest = ({ contentType, sizeBytes, kind }) => {
    if (!contentType || typeof contentType !== 'string') {
        return { ok: false, status: 400, error: 'contentType is required' };
    }
    if (!ALLOWED_IMAGE_MIME.includes(contentType)) {
        return {
            ok: false,
            status: 400,
            error: `Unsupported image type "${contentType}". Allowed: ${ALLOWED_IMAGE_MIME.join(', ')}`,
        };
    }
    const resolvedKind = kind || 'reference';
    if (!IMAGE_KINDS.includes(resolvedKind)) {
        return { ok: false, status: 400, error: `kind must be one of ${IMAGE_KINDS.join(', ')}` };
    }
    // Size is optional here: unlike gameplay, an image small enough to matter is
    // hard to get wrong. When it is supplied it is still enforced.
    if (sizeBytes !== undefined && sizeBytes !== null) {
        const size = Number(sizeBytes);
        if (!Number.isFinite(size) || size <= 0) {
            return { ok: false, status: 400, error: 'sizeBytes must be a positive number' };
        }
        if (size > IMAGE_UPLOAD_MAX_BYTES) {
            return {
                ok: false,
                status: 413,
                error: `Image is ${(size / 1048576).toFixed(1)} MB, over the `
                     + `${(IMAGE_UPLOAD_MAX_BYTES / 1048576).toFixed(0)} MB limit.`,
            };
        }
        return { ok: true, contentType, size, ext: extFromImageMime(contentType), kind: resolvedKind };
    }
    return { ok: true, contentType, size: null, ext: extFromImageMime(contentType), kind: resolvedKind };
};

const MIME_TO_EXT = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/x-msvideo': 'avi',
};

export const extFromMime = (mime) => MIME_TO_EXT[mime] || 'mp4';

/**
 * How many clips of a batch may fall through to Veo.
 *
 * Veo is the only rescue for Omni's non-deterministic block on photorealistic
 * people, so it stays enabled — but it is pay-as-you-go. Without a cap, "Omni is
 * out of quota" quietly becomes a whole batch of billable Veo renders. The
 * default leaves room for the occasional rescue while keeping the tail bounded.
 */
export const veoBudgetFor = (totalClips, override = null) => {
    if (override !== null && override !== undefined && Number.isFinite(Number(override))) {
        return Math.max(0, Number(override));
    }
    return Math.max(4, Math.ceil(Number(totalClips || 0) * 0.25));
};

/**
 * Validate an upload-url request.
 *
 * Signed-URL uploads bypass the application entirely, so everything that can be
 * checked has to be checked before the URL is handed out.
 *
 * @returns {{ok: true, contentType: string, size: number, ext: string}
 *          | {ok: false, status: number, error: string}}
 */
export const validateUploadRequest = ({ contentType, sizeBytes }, { maxBytes }) => {
    if (!contentType || typeof contentType !== 'string') {
        return { ok: false, status: 400, error: 'contentType is required' };
    }
    if (!ALLOWED_GAMEPLAY_MIME.includes(contentType)) {
        return {
            ok: false,
            status: 400,
            error: `Unsupported gameplay type "${contentType}". `
                 + `Allowed: ${ALLOWED_GAMEPLAY_MIME.join(', ')}`,
        };
    }
    const size = Number(sizeBytes);
    if (!Number.isFinite(size) || size <= 0) {
        return { ok: false, status: 400, error: 'sizeBytes must be a positive number' };
    }
    if (size > maxBytes) {
        return {
            ok: false,
            status: 413,
            error: `Gameplay file is ${(size / 1048576).toFixed(0)} MB, over the `
                 + `${(maxBytes / 1048576).toFixed(0)} MB limit.`,
        };
    }
    return { ok: true, contentType, size, ext: extFromMime(contentType) };
};

/**
 * Split a gs:// URI, refusing anything outside the application bucket.
 *
 * Autopilot accepts a caller-supplied gameplay URI when a job is created, so the
 * same rule the signed-URL endpoints follow applies here: never touch an object
 * in a bucket this app does not own.
 */
export const parseOwnBucketUri = (uri, ownBucket) => {
    if (!uri || typeof uri !== 'string' || !uri.startsWith('gs://')) {
        return { ok: false, error: 'Invalid or missing gs:// uri' };
    }
    const withoutScheme = uri.slice(5);
    const slashIdx = withoutScheme.indexOf('/');
    if (slashIdx === -1) return { ok: false, error: 'Invalid GCS URI' };
    const bucket = withoutScheme.slice(0, slashIdx);
    const object = withoutScheme.slice(slashIdx + 1);
    if (!object) return { ok: false, error: 'Invalid GCS URI' };
    if (!ownBucket || bucket !== ownBucket) {
        return { ok: false, error: 'URI is outside the configured application bucket.' };
    }
    return { ok: true, bucket, object };
};

/**
 * Build a Content-Disposition value that survives an awkward filename.
 *
 * The ASCII form is what every client understands; filename* carries the real
 * name so a non-Latin title still saves sensibly. Quotes, backslashes and line
 * breaks must go, or the header itself is malformed.
 */
export const attachmentDisposition = (filename) => {
    const raw = String(filename ?? '').slice(0, 120);
    const safe = raw
        .replace(/[\r\n"\\]/g, '')
        .replace(/[^\x20-\x7E]/g, '_')
        .trim() || 'download';
    const encoded = encodeURIComponent(raw || 'download');
    return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
};

// ── script length follows the gameplay ───────────────────────────────────────
//
// The composite lasts exactly as long as the gameplay, so the streamer's script has
// to as well. Without the gameplay length the script model was told only "16 to 40
// seconds": a 31 s recording got 22–24 s scripts and the streamer fell silent for
// the last third, while a 14.6 s recording got 24 s scripts and the call to action
// — always the last shot — was cut off.

/** Clip lengths the video models accept. */
export const SHOT_DURATIONS = [4, 6, 8];

/**
 * The script length to aim for, in seconds. Shots are 4, 6 or 8 s, so only even
 * totals are reachable. Rounding up would cut the end of the last shot, which is
 * the call to action; rounding down leaves the slot briefly empty. A cut CTA is the
 * worse failure, so the target never runs more than half a second past the
 * gameplay.
 */
export const scriptTargetSeconds = (gameplaySeconds) => {
    const d = Number(gameplaySeconds);
    if (!(d > 0)) return null;
    return Math.max(4, Math.floor((d + 0.5) / 2) * 2);
};

const fmtClock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
const wordCount = (s) => String(s || '').replace(/[[(][^\])]*[\])]/g, ' ').split(/\s+/).filter(Boolean).length;

/**
 * Bring a shot list's total to `target` by moving shot lengths between 4, 6 and 8.
 *
 * The model is told the target and usually hits it; this makes it exact when it
 * does not. Lengthening is always safe — a shot with spare time just breathes — so
 * the shortest shots grow first. Shortening can clip a line, so it takes from the
 * shot with the least dialogue per second, and never from the last shot (the call
 * to action) while another shot can give. If there are more shots than the target
 * can hold at 4 s each, middle shots are dropped first. Start and end times are
 * rewritten to match; if the target is unreachable the closest total is kept.
 */
export const fitSegmentsToTotal = (segments, target) => {
    if (!Array.isArray(segments) || !segments.length || !(target > 0)) return segments;
    let segs = segments.map((s) => ({ ...s }));
    // Too many shots to fit even at 4 s each: drop from the middle, keeping the
    // opening hook and the call to action, rather than squeezing the last line.
    while (segs.length > 2 && segs.length * 4 > target) {
        segs = [...segs.slice(0, segs.length - 2), segs[segs.length - 1]];
    }
    const sum = () => segs.reduce((n, s) => n + s.duration, 0);
    const last = segs.length - 1;

    while (sum() < target) {
        let pick = -1;
        segs.forEach((s, i) => {
            if (s.duration < 8 && (pick < 0 || s.duration < segs[pick].duration)) pick = i;
        });
        if (pick < 0) break;
        segs[pick].duration += 2;
    }
    while (sum() > target) {
        const density = (i) => wordCount(segs[i].dialogue) / segs[i].duration;
        let pick = -1;
        segs.forEach((s, i) => {
            if (s.duration <= 4) return;
            if (pick < 0) { pick = i; return; }
            // Prefer anything over the last shot, then the sparsest line.
            const better = (pick === last && i !== last)
                || ((i === last) === (pick === last) && density(i) < density(pick));
            if (better) pick = i;
        });
        if (pick < 0) break;
        segs[pick].duration -= 2;
    }

    let t = 0;
    return segs.map((s, i) => {
        const out = { ...s, id: i + 1, startTime: fmtClock(t), endTime: fmtClock(t + s.duration) };
        t += s.duration;
        return out;
    });
};
