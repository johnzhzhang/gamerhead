/**
 * Tests for lib/autopilot-job.js — the job state machine.
 *
 * The two properties worth the most here are the ones that cost money if wrong:
 *   - no automatic path may cross the avatar approval gate
 *   - the clip ceiling and the Veo budget must actually bound spending
 * Both are asserted directly, with no generation involved.
 *
 * Run: npm test
 */

import test from 'node:test';
import assert from 'node:assert';

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
} from '../lib/autopilot-job.js';

const BUCKET = 'test-bucket';
const LIMITS = { maxBatch: 10, maxClipsPerJob: 60, ownBucket: BUCKET };

const goodSpec = (over = {}) => ({
    gameTitle: 'Blockfall',
    gameUrl: 'https://example.com/blockfall',
    callToAction: 'Play free now',
    targetRatio: '16:9',
    layoutType: 'classic-pip',
    pipPlacement: 'bottom-left',
    variantCount: 2,
    gameplayGcsUri: `gs://${BUCKET}/autopilot/uploads/u1/gameplay.mp4`,
    avatarPrompt: 'An energetic streamer in a neon room',
    ...over,
});

const makeJob = (over = {}) => {
    const v = validateJobSpec(goodSpec(over), LIMITS);
    assert.strictEqual(v.ok, true, `spec should validate: ${v.error || ''}`);
    return createJob({ id: 'job-1', ownerEmail: 'a@b.c', spec: v.spec });
};

const segments = (n) => Array.from({ length: n }, (_, i) => ({
    id: i + 1, startTime: '0:00', endTime: '0:08', duration: 8,
    prompt: 'waves', dialogue: 'hello',
}));

/** Drive a job to the point where clips are being produced. */
const runningJob = (variantCount = 2, shots = 3) => {
    let job = makeJob({ variantCount });
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/a.png` }]);
    const app = approveAvatar(job, [0]);
    job = app.job;
    for (let i = 0; i < variantCount; i += 1) {
        const r = applyScript(job, i, segments(shots), { maxClipsPerJob: 60 });
        assert.strictEqual(r.ok, true);
        job = r.job;
    }
    return job;
};

// ── spec validation ──────────────────────────────────────────────────────────

test('a complete spec validates and is normalised', () => {
    const r = validateJobSpec(goodSpec(), LIMITS);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.spec.variantMode, 'vary-script');
    assert.strictEqual(r.spec.pipPlacement, 'bottom-left');
    assert.strictEqual(r.spec.volumes.gameplay, 0.4, 'gameplay defaults to being ducked');
    assert.strictEqual(r.spec.volumes.streamer, 1);
});

test('gameTitle and avatarPrompt are mandatory', () => {
    assert.match(validateJobSpec(goodSpec({ gameTitle: '  ' }), LIMITS).error, /gameTitle/);
    assert.match(validateJobSpec(goodSpec({ avatarPrompt: '' }), LIMITS).error, /avatarPrompt/);
});

test('ratio and layout are constrained', () => {
    assert.match(validateJobSpec(goodSpec({ targetRatio: '4:3' }), LIMITS).error, /targetRatio/);
    assert.match(validateJobSpec(goodSpec({ layoutType: 'mosaic' }), LIMITS).error, /layoutType/);
    assert.match(
        validateJobSpec(goodSpec({ pipPlacement: 'middle' }), LIMITS).error,
        /pipPlacement/
    );
});

test('stacked placement must match the orientation', () => {
    const wide = validateJobSpec(
        goodSpec({ layoutType: 'stacked', targetRatio: '16:9', stackedPlacement: 'top' }), LIMITS
    );
    assert.strictEqual(wide.ok, false, '16:9 stacked splits left/right, not top/bottom');

    const tall = validateJobSpec(
        goodSpec({ layoutType: 'stacked', targetRatio: '9:16', stackedPlacement: 'top' }), LIMITS
    );
    assert.strictEqual(tall.ok, true);

    // defaults are filled per orientation
    const wideDefault = validateJobSpec(
        goodSpec({ layoutType: 'stacked', targetRatio: '16:9' }), LIMITS
    );
    assert.strictEqual(wideDefault.spec.stackedPlacement, 'left');
});

test('variantCount is bounded by the configured batch maximum', () => {
    assert.match(validateJobSpec(goodSpec({ variantCount: 0 }), LIMITS).error, /positive integer/);
    assert.match(validateJobSpec(goodSpec({ variantCount: 2.5 }), LIMITS).error, /positive integer/);
    assert.match(validateJobSpec(goodSpec({ variantCount: 11 }), LIMITS).error, /exceeds the maximum/);
    assert.strictEqual(validateJobSpec(goodSpec({ variantCount: 10 }), LIMITS).ok, true);
});

test('gameplay must live in the application bucket', () => {
    assert.match(
        validateJobSpec(goodSpec({ gameplayGcsUri: 'gs://other/x.mp4' }), LIMITS).error,
        /application bucket/
    );
    assert.match(
        validateJobSpec(goodSpec({ gameplayGcsUri: undefined }), LIMITS).error,
        /gameplayGcsUri/
    );
});

test('streamer-only needs no gameplay footage', () => {
    const r = validateJobSpec(
        goodSpec({ layoutType: 'streamer-only', gameplayGcsUri: undefined }), LIMITS
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.spec.gameplayGcsUri, null);
});

test('the clip ceiling rejects a batch that is too large up front', () => {
    // 10 variants x 4 assumed shots = 40 clips; a ceiling of 20 must refuse it.
    const r = validateJobSpec(goodSpec({ variantCount: 10 }), { ...LIMITS, maxClipsPerJob: 20 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /over the 20 limit/);
});

// ── the human gate ───────────────────────────────────────────────────────────

test('a new job asks for an avatar first', () => {
    const job = makeJob();
    assert.strictEqual(job.status, JOB_STATUS.CREATED);
    assert.strictEqual(nextAction(job).type, ACTION.GENERATE_AVATAR);
});

test('once candidates exist the job waits for a human', () => {
    let job = makeJob();
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/a.png` }]);
    assert.strictEqual(job.status, JOB_STATUS.AWAITING_AVATAR);
    assert.strictEqual(nextAction(job).type, ACTION.WAIT_APPROVAL);
});

test('NO automatic action crosses the gate, however many times it is asked', () => {
    let job = makeJob();
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/a.png` }]);

    // This is the property that protects the expensive half of the pipeline:
    // tick / resume / the in-process worker all route through nextAction.
    for (let i = 0; i < 50; i += 1) {
        assert.strictEqual(
            nextAction(job).type, ACTION.WAIT_APPROVAL,
            'the gate must never resolve to work'
        );
    }
    assert.strictEqual(job.status, JOB_STATUS.AWAITING_AVATAR);
    assert.strictEqual(job.counters.veoUsed, 0);
    assert.ok(job.variants.every((v) => v.stage === VARIANT_STAGE.PENDING),
        'no variant may start before approval');
});

test('regenerating keeps the job at the gate and can change the prompt', () => {
    let job = makeJob();
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/a1.png` }]);
    job = regenerateAvatar(job, [{ gcsUri: `gs://${BUCKET}/a2.png` }], { prompt: 'calmer streamer' });

    assert.strictEqual(job.status, JOB_STATUS.AWAITING_AVATAR);
    assert.strictEqual(job.avatar.regenCount, 1);
    assert.strictEqual(job.avatar.candidates[0].gcsUri, `gs://${BUCKET}/a2.png`);
    assert.strictEqual(job.spec.avatarPrompt, 'calmer streamer');
    assert.strictEqual(nextAction(job).type, ACTION.WAIT_APPROVAL);
});

test('regenerating any number of times costs no clips', () => {
    let job = makeJob();
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/a0.png` }]);
    for (let i = 1; i <= 25; i += 1) {
        job = regenerateAvatar(job, [{ gcsUri: `gs://${BUCKET}/a${i}.png` }]);
    }
    assert.strictEqual(job.avatar.regenCount, 25);
    assert.strictEqual(job.counters.veoUsed, 0);
    assert.strictEqual(nextAction(job).type, ACTION.WAIT_APPROVAL);
});

test('a user-supplied streamer image can replace the generated one', () => {
    let job = makeJob();
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/gen.png` }]);
    job = useUploadedAvatar(job, `gs://${BUCKET}/mine.png`);
    assert.strictEqual(job.avatar.source, 'uploaded');
    assert.strictEqual(job.avatar.candidates.length, 1);
    assert.strictEqual(nextAction(job).type, ACTION.WAIT_APPROVAL, 'still needs confirming');
});

test('approval is the only transition into running', () => {
    let job = makeJob();
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/a.png` }]);
    const r = approveAvatar(job, [0]);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.job.status, JOB_STATUS.RUNNING);
    assert.ok(r.job.avatar.approvedAt, 'approval is timestamped');
    assert.strictEqual(nextAction(r.job).type, ACTION.GENERATE_SCRIPT);
});

test('approval is refused when nothing is waiting', () => {
    const fresh = makeJob();
    const r = approveAvatar(fresh, [0]);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /No avatar is waiting/);
    assert.strictEqual(r.job.status, JOB_STATUS.CREATED, 'job is unchanged');
});

test('approval is refused for a candidate that does not exist', () => {
    let job = makeJob();
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/a.png` }]);
    const r = approveAvatar(job, [7]);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /does not exist/);
});

test('approval is refused on a cancelled job', () => {
    let job = makeJob();
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/a.png` }]);
    job = cancelJob(job);
    const r = approveAvatar(job, [0]);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /already cancelled/);
});

test('vary-script gives every variant the same approved avatar', () => {
    let job = makeJob({ variantCount: 3 });
    job = setAvatarCandidates(job, [
        { gcsUri: `gs://${BUCKET}/a.png` },
        { gcsUri: `gs://${BUCKET}/b.png` },
    ]);
    job = approveAvatar(job, [1]).job;
    for (let i = 0; i < 3; i += 1) {
        assert.strictEqual(avatarUriForVariant(job, i), `gs://${BUCKET}/b.png`);
    }
});

// ── pipeline progression ─────────────────────────────────────────────────────

test('a script sizes the clip slots and clips are then requested in order', () => {
    let job = makeJob({ variantCount: 1 });
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/a.png` }]);
    job = approveAvatar(job, [0]).job;

    const r = applyScript(job, 0, segments(3), { maxClipsPerJob: 60 });
    assert.strictEqual(r.ok, true);
    job = r.job;
    assert.strictEqual(job.variants[0].stage, VARIANT_STAGE.CLIPS);
    assert.strictEqual(job.variants[0].clipUris.length, 3);

    let a = nextAction(job);
    assert.strictEqual(a.type, ACTION.GENERATE_CLIP);
    assert.strictEqual(a.clipIdx, 0);

    job = applyClip(job, 0, 0, `gs://${BUCKET}/c0.mp4`);
    a = nextAction(job);
    assert.strictEqual(a.clipIdx, 1, 'the next missing clip is picked up');

    job = applyClip(job, 0, 1, `gs://${BUCKET}/c1.mp4`);
    job = applyClip(job, 0, 2, `gs://${BUCKET}/c2.mp4`);
    assert.strictEqual(job.variants[0].stage, VARIANT_STAGE.COMPOSE);
    assert.strictEqual(nextAction(job).type, ACTION.COMPOSE);

    job = applyCompose(job, 0, `gs://${BUCKET}/final.mp4`);
    assert.strictEqual(job.variants[0].stage, VARIANT_STAGE.DONE);
    assert.strictEqual(nextAction(job).type, ACTION.FINALISE);
});

test('an empty script is rejected rather than producing a zero-clip variant', () => {
    const job = runningJob(1, 3);
    const r = applyScript(job, 0, [], { maxClipsPerJob: 60 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /no segments/);
});

test('a script whose real shot count blows the ceiling fails the whole job', () => {
    let job = makeJob({ variantCount: 10 });
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/a.png` }]);
    job = approveAvatar(job, [0]).job;

    // Validation assumed 4 shots (40 clips, under 60). A 9-shot script would mean
    // 90 clips, so the breaker has to trip now that the truth is known.
    const r = applyScript(job, 0, segments(9), { maxClipsPerJob: 60 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.fatal, true);
    assert.strictEqual(r.job.status, JOB_STATUS.FAILED);
    assert.match(r.error, /over the 60 limit/);
});

test('resume picks up exactly where the job stopped', () => {
    let job = runningJob(2, 2);
    job = applyClip(job, 0, 0, `gs://${BUCKET}/v0c0.mp4`);

    // Simulate an instance dying and the document being reloaded verbatim.
    const reloaded = JSON.parse(JSON.stringify(job));
    const a = nextAction(reloaded);
    assert.strictEqual(a.type, ACTION.GENERATE_CLIP);
    assert.strictEqual(a.variantIdx, 0);
    assert.strictEqual(a.clipIdx, 1, 'the finished clip is not produced twice');
});

test('work is spread over variants before any is composed', () => {
    let job = runningJob(2, 1);
    // variant 0 finishes its only clip
    job = applyClip(job, 0, 0, `gs://${BUCKET}/v0.mp4`);
    // variant 1 still needs a clip, and clips come before compose
    const a = nextAction(job);
    assert.strictEqual(a.type, ACTION.GENERATE_CLIP);
    assert.strictEqual(a.variantIdx, 1);
});

// ── partial delivery ─────────────────────────────────────────────────────────

test('one failed variant does not stop the others', () => {
    let job = runningJob(2, 1);
    job = failVariant(job, 0, 'content blocked every time');
    job = applyClip(job, 1, 0, `gs://${BUCKET}/v1c0.mp4`);
    job = applyCompose(job, 1, `gs://${BUCKET}/v1.mp4`);

    assert.strictEqual(nextAction(job).type, ACTION.FINALISE);
    const done = finalise(job);
    assert.strictEqual(done.status, JOB_STATUS.PARTIAL);

    const view = summarise(done);
    assert.strictEqual(view.doneCount, 1);
    assert.strictEqual(view.failedCount, 1);
    assert.strictEqual(view.variants[0].error, 'content blocked every time');
    assert.strictEqual(view.variants[1].hasOutput, true);
});

test('all variants succeeding gives completed', () => {
    let job = runningJob(2, 1);
    for (const i of [0, 1]) {
        job = applyClip(job, i, 0, `gs://${BUCKET}/c${i}.mp4`);
        job = applyCompose(job, i, `gs://${BUCKET}/f${i}.mp4`);
    }
    assert.strictEqual(finalise(job).status, JOB_STATUS.COMPLETED);
});

test('all variants failing gives failed', () => {
    let job = runningJob(2, 1);
    job = failVariant(job, 0, 'x');
    job = failVariant(job, 1, 'y');
    assert.strictEqual(finalise(job).status, JOB_STATUS.FAILED);
});

test('a long error is truncated before it reaches storage', () => {
    let job = runningJob(1, 1);
    job = failVariant(job, 0, 'e'.repeat(5000));
    assert.ok(job.variants[0].error.length <= 500);
});

// ── Veo budget enforcement ───────────────────────────────────────────────────

test('the Veo budget is recomputed from the real shot count', () => {
    let job = makeJob({ variantCount: 10 });
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/a.png` }]);
    job = approveAvatar(job, [0]).job;
    // 10 variants x 4 assumed shots = 40 → budget 10
    assert.strictEqual(job.veoBudget, 10);

    // real script has 2 shots → 20 clips → budget 5
    const r = applyScript(job, 0, segments(2), { maxClipsPerJob: 60 });
    assert.strictEqual(r.job.veoBudget, 5);
});

test('Veo use is counted and the budget eventually closes', () => {
    let job = runningJob(1, 3);
    job.veoBudget = 2;
    assert.strictEqual(canUseVeo(job), true);

    job = applyClip(job, 0, 0, `gs://${BUCKET}/c0.mp4`, { usedVeo: true });
    assert.strictEqual(job.counters.veoUsed, 1);
    assert.strictEqual(canUseVeo(job), true);

    job = applyClip(job, 0, 1, `gs://${BUCKET}/c1.mp4`, { usedVeo: true });
    assert.strictEqual(job.counters.veoUsed, 2);
    assert.strictEqual(canUseVeo(job), false, 'budget exhausted, no more pay-as-you-go');

    // Omni clips still count towards nothing
    job = applyClip(job, 0, 2, `gs://${BUCKET}/c2.mp4`, { usedVeo: false });
    assert.strictEqual(job.counters.veoUsed, 2);
    assert.strictEqual(job.variants[0].veoClips, 2);
});

test('a zero budget refuses Veo outright', () => {
    const job = runningJob(1, 1);
    assert.strictEqual(canUseVeo({ ...job, veoBudget: 0 }), false);
});

// ── cancellation and terminal safety ─────────────────────────────────────────

test('cancelling stops all further work', () => {
    let job = runningJob(2, 2);
    job = cancelJob(job);
    assert.strictEqual(job.status, JOB_STATUS.CANCELLED);
    assert.strictEqual(isTerminal(job), true);
    assert.strictEqual(nextAction(job).type, ACTION.NOTHING);
});

test('transitions on a terminal job are inert', () => {
    let job = runningJob(1, 1);
    job = applyClip(job, 0, 0, `gs://${BUCKET}/c.mp4`);
    job = applyCompose(job, 0, `gs://${BUCKET}/f.mp4`);
    const done = finalise(job);

    assert.strictEqual(applyClip(done, 0, 0, 'gs://x/y.mp4').status, JOB_STATUS.COMPLETED);
    assert.strictEqual(failVariant(done, 0, 'late').variants[0].stage, VARIANT_STAGE.DONE);
    assert.strictEqual(finalise(done).status, JOB_STATUS.COMPLETED);
    assert.strictEqual(cancelJob(done).status, JOB_STATUS.COMPLETED);
    assert.strictEqual(setAvatarCandidates(done, [{ gcsUri: 'gs://x/a.png' }]).status, JOB_STATUS.COMPLETED);
});

test('summarise exposes progress without leaking internals', () => {
    let job = runningJob(2, 2);
    job = applyClip(job, 0, 0, `gs://${BUCKET}/c.mp4`);
    const view = summarise(job);

    assert.strictEqual(view.clipProgress.total, 4);
    assert.strictEqual(view.clipProgress.ready, 1);
    assert.strictEqual(view.awaitingApproval, false);
    assert.ok(!('spec' in view), 'the raw spec is not part of the client view');
    assert.ok(!JSON.stringify(view).includes('gameplay.mp4'), 'no storage paths leak');
});

test('summarise flags the gate so the UI knows to stop and ask', () => {
    let job = makeJob();
    job = setAvatarCandidates(job, [{ gcsUri: `gs://${BUCKET}/a.png` }]);
    const view = summarise(job);
    assert.strictEqual(view.awaitingApproval, true);
    assert.strictEqual(view.status, JOB_STATUS.AWAITING_AVATAR);
    assert.strictEqual(view.avatar.candidateCount, 1);
});
