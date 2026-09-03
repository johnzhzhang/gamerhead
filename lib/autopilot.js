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
