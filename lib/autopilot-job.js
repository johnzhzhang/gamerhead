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
    if (variantCount > maxBatch) {
        return fail(`variantCount ${variantCount} exceeds the maximum of ${maxBatch}`);
    }

    // streamer-only never composites, so it needs no gameplay footage. Every
    // other layout does.
    const needsGameplay = spec.layoutType !== 'streamer-only';
    if (needsGameplay) {
        const uri = spec.gameplayGcsUri;
        if (!uri || typeof uri !== 'string' || !uri.startsWith(`gs://${ownBucket}/`)) {
            return fail('gameplayGcsUri must be an object in the application bucket '
                      + '(upload it first via /api/autopilot/upload-url)');
        }
    }

    if (!String(spec.avatarPrompt || '').trim()) {
        return fail('avatarPrompt is required — it describes the streamer to confirm');
    }

    // Cost circuit breaker, applied on the assumed shot count. Re-checked for
    // real once the first script comes back.
    const assumedClips = variantCount * ASSUMED_SEGMENTS;
    if (assumedClips > maxClipsPerJob) {
        return fail(`${variantCount} variants would need roughly ${assumedClips} clips, `
                  + `over the ${maxClipsPerJob} limit for one job`);
    }

    return {
        ok: true,
        spec: {
            gameTitle,
            gameUrl: String(spec.gameUrl || '').trim(),
            callToAction: String(spec.callToAction || '').trim(),
            gamingDevice: String(spec.gamingDevice || '').trim(),
            dialoguePacing: String(spec.dialoguePacing || '').trim(),
            extraInstructions: String(spec.extraInstructions || '').trim(),
            targetRatio: spec.targetRatio,
            layoutType: spec.layoutType,
            pipPlacement: spec.pipPlacement || 'bottom-left',
            stackedPlacement: spec.stackedPlacement
                || (spec.targetRatio === '9:16' ? 'top' : 'left'),
            subtitles: Boolean(spec.subtitles),
            variantCount,
            variantMode: 'vary-script', // the only mode implemented; see the plan
            gameplayGcsUri: needsGameplay ? spec.gameplayGcsUri : null,
            avatarPrompt: String(spec.avatarPrompt).trim(),
            avatarRefGcsUri: typeof spec.avatarRefGcsUri === 'string' ? spec.avatarRefGcsUri : null,
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
    variants: Array.from({ length: spec.variantCount }, (_, idx) => ({
        idx,
        stage: VARIANT_STAGE.PENDING,
        scriptSegments: null,
        clipUris: [],
        finalUri: null,
        error: null,
        veoClips: 0,
    })),
    counters: { veoUsed: 0 },
    veoBudget: veoBudgetFor(spec.variantCount * ASSUMED_SEGMENTS),
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
 * about to perform, and the next worker skips over it. Without this every worker
 * would be handed the same first outstanding clip and the batch would run
 * strictly serially.
 */
export const nextAction = (job, { exclude } = {}) => {
    if (!job || isTerminal(job)) return { type: ACTION.NOTHING };
    const taken = exclude instanceof Set ? exclude : new Set(exclude || []);
    const free = (action) => !taken.has(actionKey(action));

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

    const projected = segments.length * job.spec.variantCount;
    if (maxClipsPerJob && projected > maxClipsPerJob) {
        return {
            ok: false,
            fatal: true,
            error: `Script has ${segments.length} shots; ${job.spec.variantCount} variants `
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
export const canUseVeo = (job) => (job.counters?.veoUsed || 0) < (job.veoBudget || 0);

/** Record a finished clip; the variant advances to compose once all are in. */
export const applyClip = (job, variantIdx, clipIdx, gcsUri, { usedVeo = false, now = new Date() } = {}) => {
    if (isTerminal(job)) return job;
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
        counters: { ...job.counters, veoUsed: (job.counters.veoUsed || 0) + (usedVeo ? 1 : 0) },
    }, now);
};

/** Record the delivered video for a variant. */
export const applyCompose = (job, variantIdx, finalUri, { now = new Date() } = {}) => {
    if (isTerminal(job)) return job;
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
        awaitingApproval: job.status === JOB_STATUS.AWAITING_AVATAR,
        variantCount: job.spec.variantCount,
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
            stage: v.stage,
            shots: v.scriptSegments?.length || 0,
            clipsReady: v.clipUris.filter(Boolean).length,
            error: v.error,
            hasOutput: Boolean(v.finalUri),
        })),
    };
};
