/**
 * Tests for lib/autopilot.js — upload validation and cost policy.
 *
 * These are the checks that guard a signed-URL upload. Once the URL is issued the
 * object reaches the bucket without passing through any application code, so a
 * gap here cannot be caught later.
 *
 * Run: npm test
 */

import test from 'node:test';
import assert from 'node:assert';

import {
    ALLOWED_GAMEPLAY_MIME,
    extFromMime,
    veoBudgetFor,
    validateUploadRequest,
    parseOwnBucketUri,
} from '../lib/autopilot.js';

const MAX = 250 * 1024 * 1024;
const opts = { maxBytes: MAX };

// ── upload validation ────────────────────────────────────────────────────────

test('accepts every allowed gameplay container', () => {
    for (const mime of ALLOWED_GAMEPLAY_MIME) {
        const r = validateUploadRequest({ contentType: mime, sizeBytes: 1024 }, opts);
        assert.strictEqual(r.ok, true, `${mime} should be accepted`);
        assert.ok(r.ext, `${mime} should map to an extension`);
    }
});

test('rejects a non-video content type', () => {
    const r = validateUploadRequest({ contentType: 'application/zip', sizeBytes: 1024 }, opts);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 400);
    assert.match(r.error, /Unsupported gameplay type/);
});

test('rejects a missing content type', () => {
    for (const body of [{}, { sizeBytes: 10 }, { contentType: '', sizeBytes: 10 }, { contentType: 42, sizeBytes: 10 }]) {
        const r = validateUploadRequest(body, opts);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 400);
        assert.match(r.error, /contentType is required/);
    }
});

test('rejects a non-positive or unparsable size', () => {
    for (const size of [undefined, null, 0, -1, 'abc', NaN, Infinity]) {
        const r = validateUploadRequest({ contentType: 'video/mp4', sizeBytes: size }, opts);
        assert.strictEqual(r.ok, false, `size ${String(size)} should be rejected`);
        assert.strictEqual(r.status, 400);
        assert.match(r.error, /positive number/);
    }
});

test('accepts a file exactly on the limit and rejects one byte over', () => {
    const atLimit = validateUploadRequest({ contentType: 'video/mp4', sizeBytes: MAX }, opts);
    assert.strictEqual(atLimit.ok, true, 'a file exactly at the limit is fine');

    const over = validateUploadRequest({ contentType: 'video/mp4', sizeBytes: MAX + 1 }, opts);
    assert.strictEqual(over.ok, false);
    assert.strictEqual(over.status, 413);
    assert.match(over.error, /over the 250 MB limit/);
});

test('the size limit sits far above the Cloud Run request cap', () => {
    // The whole reason for signed-URL uploads: Cloud Run refuses an HTTP/1 body
    // over 32 MiB and that cannot be raised. Verified against production: a 40 MB
    // POST returns 413 from the Google front end.
    const CLOUD_RUN_CAP = 32 * 1024 * 1024;
    assert.ok(MAX > CLOUD_RUN_CAP, 'gameplay limit must exceed what a POST could carry');

    const tooBigForCloudRun = validateUploadRequest(
        { contentType: 'video/mp4', sizeBytes: CLOUD_RUN_CAP * 2 }, opts
    );
    assert.strictEqual(tooBigForCloudRun.ok, true,
        'a file Cloud Run could not accept must still be uploadable via signed URL');
});

test('extFromMime falls back to mp4 for anything unknown', () => {
    assert.strictEqual(extFromMime('video/mp4'), 'mp4');
    assert.strictEqual(extFromMime('video/quicktime'), 'mov');
    assert.strictEqual(extFromMime('video/x-matroska'), 'mkv');
    assert.strictEqual(extFromMime('video/unknown'), 'mp4');
    assert.strictEqual(extFromMime(undefined), 'mp4');
});

// ── Veo budget ───────────────────────────────────────────────────────────────

test('Veo budget defaults to a quarter of the batch', () => {
    assert.strictEqual(veoBudgetFor(40), 10);
    assert.strictEqual(veoBudgetFor(60), 15);
});

test('Veo budget never drops below 4, so small batches keep a rescue', () => {
    assert.strictEqual(veoBudgetFor(4), 4);
    assert.strictEqual(veoBudgetFor(1), 4);
    assert.strictEqual(veoBudgetFor(0), 4);
});

test('Veo budget caps a full batch well under the total', () => {
    // The tail risk being bounded is the point: if Omni collapses, a 40-clip
    // batch must not turn into 40 billable Veo renders.
    const total = 40;
    assert.ok(veoBudgetFor(total) < total, 'budget must be less than the batch');
});

test('Veo budget honours an explicit override, including zero', () => {
    assert.strictEqual(veoBudgetFor(40, 3), 3);
    assert.strictEqual(veoBudgetFor(40, 0), 0, 'zero disables the net entirely');
    assert.strictEqual(veoBudgetFor(40, -5), 0, 'a negative override clamps to zero');
    assert.strictEqual(veoBudgetFor(40, null), 10, 'null falls back to the default');
    assert.strictEqual(veoBudgetFor(40, 'nonsense'), 10, 'garbage falls back to the default');
});

// ── bucket scoping ───────────────────────────────────────────────────────────

test('parses a URI inside the application bucket', () => {
    const r = parseOwnBucketUri('gs://my-bucket/autopilot/uploads/abc/gameplay.mp4', 'my-bucket');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.bucket, 'my-bucket');
    assert.strictEqual(r.object, 'autopilot/uploads/abc/gameplay.mp4');
});

test('refuses a URI in a bucket this app does not own', () => {
    const r = parseOwnBucketUri('gs://other-bucket/secret.mp4', 'my-bucket');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /outside the configured application bucket/);
});

test('refuses malformed URIs', () => {
    for (const uri of [undefined, null, '', 'not-a-uri', 'https://x/y', 'gs://', 'gs://bucket-only']) {
        const r = parseOwnBucketUri(uri, 'my-bucket');
        assert.strictEqual(r.ok, false, `${String(uri)} should be refused`);
    }
});

test('refuses any URI when no bucket is configured', () => {
    const r = parseOwnBucketUri('gs://my-bucket/a.mp4', '');
    assert.strictEqual(r.ok, false);
});
