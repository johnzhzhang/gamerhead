/**
 * Tests for lib/compose.js — the server-side port of the browser compositor.
 *
 * Two layers:
 *   1. computeLayout is pure maths, so the expected boxes are hand-derived from
 *      the browser formulas and asserted directly.
 *   2. composeVideo is then run on synthetic footage and the *rendered pixels*
 *      are sampled at those coordinates. That is what actually proves the port:
 *      the gameplay colour must appear where the background is meant to be, the
 *      streamer colour inside the PiP box, and white on its border.
 *
 * Run: npm test
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    computeLayout,
    coverBox,
    probeMedia,
    composeVideo,
    measureGreenScreen,
    constants,
} from '../lib/compose.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-compose-test-'));

const RED = [255, 0, 0];      // gameplay
const BLUE = [0, 0, 255];     // streamer

const run = (bin, args) => new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (c) => (c === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`${bin} exited ${c}: ${err.slice(-800)}`))));
});

/** Solid-colour clip with a tone, so audio mixing is exercised too. */
const makeClip = async (name, { color, width, height, seconds, freq }) => {
    const file = path.join(TMP, name);
    await run('ffmpeg', [
        '-hide_banner', '-y',
        '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:r=30:d=${seconds}`,
        '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', file,
    ]);
    return file;
};

/**
 * Read one pixel as [r,g,b] from a rendered frame.
 *
 * format=rgb24 has to come before crop: cropping yuv420p at an odd offset is
 * rejected by ffmpeg because of chroma subsampling.
 */
const samplePixel = async (file, x, y, at = 1.0) => {
    const buf = await run('ffmpeg', [
        '-hide_banner', '-ss', String(at), '-i', file,
        '-vf', `format=rgb24,crop=1:1:${Math.round(x)}:${Math.round(y)}`,
        '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ]);
    if (buf.length < 3) throw new Error(`Sampling (${Math.round(x)},${Math.round(y)}) returned no pixel`);
    return [buf[0], buf[1], buf[2]];
};

const near = (actual, expected, tol, label) => {
    assert.ok(
        Math.abs(actual - expected) <= tol,
        `${label}: got ${actual}, expected ~${expected} (±${tol})`
    );
};

/** Colour comparison has to tolerate yuv420p round-tripping. */
const assertColour = (got, want, label, tol = 40) => {
    const [r, g, b] = got;
    const [wr, wg, wb] = want;
    assert.ok(
        Math.abs(r - wr) <= tol && Math.abs(g - wg) <= tol && Math.abs(b - wb) <= tol,
        `${label}: got rgb(${r},${g},${b}), expected ~rgb(${wr},${wg},${wb})`
    );
};

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ── 1. geometry, hand-derived from the browser formulas ──────────────────────

test('canvas size follows the target ratio', () => {
    const wide = computeLayout({
        layout: 'classic-pip', targetRatio: '16:9',
        gameplayWidth: 1280, gameplayHeight: 720,
        streamerWidth: 1280, streamerHeight: 720,
    });
    assert.strictEqual(wide.width, 1920);
    assert.strictEqual(wide.height, 1080);

    const tall = computeLayout({
        layout: 'classic-pip', targetRatio: '9:16',
        gameplayWidth: 1280, gameplayHeight: 720,
        streamerWidth: 720, streamerHeight: 1280,
    });
    assert.strictEqual(tall.width, 1080);
    assert.strictEqual(tall.height, 1920);
});

test('classic-pip box is 10% of canvas area with 2% padding', () => {
    const geo = computeLayout({
        layout: 'classic-pip', targetRatio: '16:9', pipPlacement: 'bottom-left',
        gameplayWidth: 1280, gameplayHeight: 720,
        streamerWidth: 1280, streamerHeight: 720,
    });

    // browser: targetArea = 1920*1080*0.1 = 207360; w = sqrt(area*ratio)
    const ratio = 1280 / 720;
    const expectW = Math.sqrt(1920 * 1080 * constants.PIP_AREA_FRACTION * ratio);
    const expectH = expectW / ratio;
    near(geo.streamer.w, expectW, 0.01, 'pip width');
    near(geo.streamer.h, expectH, 0.01, 'pip height');

    // area really is 10%
    near((geo.streamer.w * geo.streamer.h) / (1920 * 1080), 0.1, 1e-6, 'pip area fraction');

    const padding = 1920 * constants.PIP_PADDING_RATIO;
    near(geo.streamer.x, padding, 0.01, 'pip x');
    near(geo.streamer.y, 1080 - expectH - padding, 0.01, 'pip y');
});

test('classic-pip honours every placement corner', () => {
    const base = {
        layout: 'classic-pip', targetRatio: '16:9',
        gameplayWidth: 1280, gameplayHeight: 720,
        streamerWidth: 1280, streamerHeight: 720,
    };
    const padding = 1920 * constants.PIP_PADDING_RATIO;
    const { w, h } = computeLayout({ ...base, pipPlacement: 'top-left' }).streamer;

    const tl = computeLayout({ ...base, pipPlacement: 'top-left' }).streamer;
    near(tl.x, padding, 0.01, 'top-left x');
    near(tl.y, padding, 0.01, 'top-left y');

    const tr = computeLayout({ ...base, pipPlacement: 'top-right' }).streamer;
    near(tr.x, 1920 - w - padding, 0.01, 'top-right x');
    near(tr.y, padding, 0.01, 'top-right y');

    const br = computeLayout({ ...base, pipPlacement: 'bottom-right' }).streamer;
    near(br.x, 1920 - w - padding, 0.01, 'bottom-right x');
    near(br.y, 1080 - h - padding, 0.01, 'bottom-right y');

    // browser defaults an unknown placement to bottom-left
    const fallback = computeLayout({ ...base, pipPlacement: 'nonsense' }).streamer;
    near(fallback.x, padding, 0.01, 'fallback x');
    near(fallback.y, 1080 - h - padding, 0.01, 'fallback y');
});

test('background is cover-fitted and centred, cropping the overflow', () => {
    // A 21:9 source in a 16:9 canvas must overflow horizontally and be centred.
    const geo = computeLayout({
        layout: 'classic-pip', targetRatio: '16:9',
        gameplayWidth: 2560, gameplayHeight: 1080,
        streamerWidth: 1280, streamerHeight: 720,
    });
    near(geo.background.h, 1080, 0.01, 'bg height fills canvas');
    near(geo.background.w, 1080 * (2560 / 1080), 0.01, 'bg width overflows');
    near(geo.background.x, (1920 - geo.background.w) / 2, 0.01, 'bg centred horizontally');
    assert.ok(geo.background.x < 0, 'bg should overflow to the left (negative offset)');
    near(geo.background.y, 0, 0.01, 'bg y');
});

test('stacked 16:9 splits 30% of the width', () => {
    const split = 1920 * constants.STACK_SPLIT_16_9;

    const left = computeLayout({
        layout: 'stacked', targetRatio: '16:9', stackedPlacement: 'left',
        gameplayWidth: 1280, gameplayHeight: 720,
        streamerWidth: 720, streamerHeight: 1280,
    });
    near(left.streamer.x, 0, 0.01, 'streamer-left x');
    near(left.streamer.w, split, 0.01, 'streamer-left width');
    near(left.streamer.h, 1080, 0.01, 'streamer-left height');
    // gameplay occupies the remaining 70%, cover-fitted inside it
    assert.ok(left.background.x >= split - 1e-6 || left.background.w > 1920 - split,
        'gameplay should sit in or overflow the right-hand area');

    const right = computeLayout({
        layout: 'stacked', targetRatio: '16:9', stackedPlacement: 'right',
        gameplayWidth: 1280, gameplayHeight: 720,
        streamerWidth: 720, streamerHeight: 1280,
    });
    near(right.streamer.x, 1920 - split, 0.01, 'streamer-right x');
});

test('stacked 9:16 splits 35% of the height', () => {
    const split = 1920 * constants.STACK_SPLIT_9_16;

    const top = computeLayout({
        layout: 'stacked', targetRatio: '9:16', stackedPlacement: 'top',
        gameplayWidth: 1280, gameplayHeight: 720,
        streamerWidth: 1280, streamerHeight: 720,
    });
    near(top.streamer.y, 0, 0.01, 'streamer-top y');
    near(top.streamer.h, split, 0.01, 'streamer-top height');
    near(top.streamer.w, 1080, 0.01, 'streamer-top width');

    const bottom = computeLayout({
        layout: 'stacked', targetRatio: '9:16', stackedPlacement: 'bottom',
        gameplayWidth: 1280, gameplayHeight: 720,
        streamerWidth: 1280, streamerHeight: 720,
    });
    near(bottom.streamer.y, 1920 - split, 0.01, 'streamer-bottom y');
});

test('streamer-only reports no composite boxes', () => {
    const geo = computeLayout({
        layout: 'streamer-only', targetRatio: '16:9',
        gameplayWidth: 1280, gameplayHeight: 720,
        streamerWidth: 1280, streamerHeight: 720,
    });
    assert.strictEqual(geo.background, null);
    assert.strictEqual(geo.streamer, null);
});

test('coverBox never letterboxes', () => {
    const wide = coverBox(21 / 9, 0, 0, 100, 100);
    assert.ok(wide.w >= 100 && wide.h >= 100, 'wide source still covers');
    const tall = coverBox(9 / 21, 0, 0, 100, 100);
    assert.ok(tall.w >= 100 && tall.h >= 100, 'tall source still covers');
});

test('unsupported layout is rejected', () => {
    assert.throws(() => computeLayout({
        layout: 'mosaic', targetRatio: '16:9',
        gameplayWidth: 1280, gameplayHeight: 720,
        streamerWidth: 1280, streamerHeight: 720,
    }), /Unsupported layout/);
});

// ── 2. rendered output: pixels must land where the geometry says ─────────────

test('classic-pip renders the streamer in the right corner, with a white border', async (t) => {
    t.diagnostic('generating synthetic gameplay + streamer');
    const gameplay = await makeClip('gp.mp4', { color: 'red', width: 1280, height: 720, seconds: 6, freq: 220 });
    const streamer = await makeClip('st.mp4', { color: 'blue', width: 1280, height: 720, seconds: 4, freq: 660 });
    const out = path.join(TMP, 'pip.mp4');

    const result = await composeVideo({
        gameplayPath: gameplay, streamerPath: streamer, outputPath: out,
        layout: 'classic-pip', targetRatio: '16:9', pipPlacement: 'bottom-left',
        volumes: { gameplay: 0.4, streamer: 1.0 },
    });

    assert.strictEqual(result.width, 1920);
    assert.strictEqual(result.height, 1080);
    assert.ok(result.hasAudio, 'composite keeps an audio track');
    // browser semantics: output length is the gameplay length, not the streamer's
    near(result.duration, 6, 0.5, 'output duration follows gameplay');

    const { streamer: box } = result.geometry;

    // Inside the PiP box → streamer colour.
    assertColour(
        await samplePixel(out, box.x + box.w / 2, box.y + box.h / 2),
        BLUE, 'pip centre is the streamer'
    );

    // Well outside the box → gameplay colour.
    assertColour(await samplePixel(out, 1600, 200), RED, 'background is the gameplay');

    // On the stroke → white. Sample mid-edge to avoid the corner radius.
    const edge = await samplePixel(out, box.x + box.w / 2, box.y + 1);
    assert.ok(edge[0] > 150 && edge[1] > 150 && edge[2] > 150,
        `pip border should be white-ish, got rgb(${edge.join(',')})`);

    // Just outside the rounded corner the background must show through, proving
    // the corners really are rounded rather than square.
    const corner = await samplePixel(out, box.x + 2, box.y + 2);
    assertColour(corner, RED, 'rounded corner lets the background through', 60);
});

test('pip slot goes black once the streamer ends', async () => {
    const gameplay = await makeClip('gp2.mp4', { color: 'red', width: 1280, height: 720, seconds: 6, freq: 220 });
    const streamer = await makeClip('st2.mp4', { color: 'blue', width: 1280, height: 720, seconds: 2, freq: 660 });
    const out = path.join(TMP, 'pip-tail.mp4');

    const result = await composeVideo({
        gameplayPath: gameplay, streamerPath: streamer, outputPath: out,
        layout: 'classic-pip', targetRatio: '16:9', pipPlacement: 'top-right',
    });
    const { streamer: box } = result.geometry;

    // while the streamer plays
    assertColour(
        await samplePixel(out, box.x + box.w / 2, box.y + box.h / 2, 1.0),
        BLUE, 'streamer visible at t=1s'
    );
    // after it ends the browser paints the slot black
    const after = await samplePixel(out, box.x + box.w / 2, box.y + box.h / 2, 4.5);
    assert.ok(after[0] < 60 && after[1] < 60 && after[2] < 60,
        `pip slot should be black at t=4.5s, got rgb(${after.join(',')})`);
});

test('stacked 16:9 puts the streamer in its slot and gameplay beside it', async () => {
    const gameplay = await makeClip('gp3.mp4', { color: 'red', width: 1280, height: 720, seconds: 5, freq: 220 });
    const streamer = await makeClip('st3.mp4', { color: 'blue', width: 720, height: 1280, seconds: 5, freq: 660 });
    const out = path.join(TMP, 'stack.mp4');

    const result = await composeVideo({
        gameplayPath: gameplay, streamerPath: streamer, outputPath: out,
        layout: 'stacked', targetRatio: '16:9', stackedPlacement: 'left',
    });
    const split = 1920 * constants.STACK_SPLIT_16_9;

    assertColour(await samplePixel(out, split / 2, 540), BLUE, 'left slot is the streamer');
    assertColour(await samplePixel(out, split + (1920 - split) / 2, 540), RED, 'right area is the gameplay');
});

test('stacked 9:16 splits vertically', async () => {
    const gameplay = await makeClip('gp4.mp4', { color: 'red', width: 1280, height: 720, seconds: 5, freq: 220 });
    const streamer = await makeClip('st4.mp4', { color: 'blue', width: 1280, height: 720, seconds: 5, freq: 660 });
    const out = path.join(TMP, 'stack916.mp4');

    const result = await composeVideo({
        gameplayPath: gameplay, streamerPath: streamer, outputPath: out,
        layout: 'stacked', targetRatio: '9:16', stackedPlacement: 'top',
    });
    assert.strictEqual(result.width, 1080);
    assert.strictEqual(result.height, 1920);

    const split = 1920 * constants.STACK_SPLIT_9_16;
    assertColour(await samplePixel(out, 540, split / 2), BLUE, 'top band is the streamer');
    assertColour(await samplePixel(out, 540, split + (1920 - split) / 2), RED, 'lower area is the gameplay');
});

test('composite works when the gameplay has no audio', async () => {
    const silent = path.join(TMP, 'silent.mp4');
    await run('ffmpeg', [
        '-hide_banner', '-y',
        '-f', 'lavfi', '-i', 'color=c=red:s=1280x720:r=30:d=4',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silent,
    ]);
    const streamer = await makeClip('st5.mp4', { color: 'blue', width: 1280, height: 720, seconds: 4, freq: 660 });
    const out = path.join(TMP, 'noaudio.mp4');

    const result = await composeVideo({
        gameplayPath: silent, streamerPath: streamer, outputPath: out,
        layout: 'classic-pip', targetRatio: '16:9', pipPlacement: 'bottom-left',
    });
    assert.ok(result.hasAudio, 'streamer audio still reaches the output');
});

test('streamer-only is rejected by composeVideo', async () => {
    const gameplay = await makeClip('gp6.mp4', { color: 'red', width: 1280, height: 720, seconds: 3, freq: 220 });
    const streamer = await makeClip('st6.mp4', { color: 'blue', width: 1280, height: 720, seconds: 3, freq: 660 });
    await assert.rejects(
        () => composeVideo({
            gameplayPath: gameplay, streamerPath: streamer,
            outputPath: path.join(TMP, 'never.mp4'),
            layout: 'streamer-only', targetRatio: '16:9',
        }),
        /does not handle streamer-only/
    );
});

test('probeMedia reports dimensions, duration and audio', async () => {
    const clip = await makeClip('probe.mp4', { color: 'green', width: 640, height: 480, seconds: 3, freq: 440 });
    const meta = await probeMedia(clip);
    assert.strictEqual(meta.width, 640);
    assert.strictEqual(meta.height, 480);
    assert.ok(meta.hasAudio);
    near(meta.duration, 3, 0.3, 'probed duration');
});

// ── background removal (cutout mode) ─────────────────────────────────────────
// There is no alpha route: the image model returns RGB PNG even when asked for
// transparency, and the video models output h264 yuv420p. So the streamer is
// generated on flat green and keyed here. These tests use synthetic green-screen
// footage and then sample the composite, which is the only way to show that the
// background really went away and the subject really survived.

/** A "streamer" clip: solid subject block centred on a flat green field. */
const makeGreenScreenClip = async (name, {
    green = '0x14E016', subject = 'red', width = 1280, height = 720, seconds = 4,
} = {}) => {
    const file = path.join(TMP, name);
    await run('ffmpeg', [
        '-hide_banner', '-y',
        '-f', 'lavfi', '-i', `color=c=${green}:s=${width}x${height}:r=30:d=${seconds}`,
        '-f', 'lavfi', '-i', `color=c=${subject}:s=${Math.round(width / 3)}x${Math.round(height / 2)}:r=30:d=${seconds}`,
        '-f', 'lavfi', '-i', `sine=frequency=660:duration=${seconds}`,
        '-filter_complex', '[0:v][1:v]overlay=x=(W-w)/2:y=(H-h)/2[v]',
        '-map', '[v]', '-map', '2:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', file,
    ]);
    return file;
};

test('measureGreenScreen recognises a green-screen clip', async () => {
    const clip = await makeGreenScreenClip('key-probe.mp4');
    const m = await measureGreenScreen(clip);
    assert.strictEqual(m.isGreenScreen, true, `expected a green screen, got ${(m.fraction * 100).toFixed(1)}%`);
    // The synthetic clip is a green field with a subject block covering a sixth of
    // the area, so most of the frame must read as green.
    assert.ok(m.fraction > 0.5, `green fraction ${m.fraction.toFixed(2)} is too low`);
});

test('measureGreenScreen rejects footage that is not a green screen', async () => {
    const clip = await makeClip('notgreen.mp4', { color: 'blue', width: 640, height: 360, seconds: 2, freq: 300 });
    const m = await measureGreenScreen(clip);
    assert.strictEqual(m.isGreenScreen, false);
    assert.ok(m.fraction < 0.05);
});

test('the key is scale-invariant, so a shaded green field still keys', async () => {
    // The real failure mode: generated backgrounds carry the subject's lighting, so
    // the field ramps from near-black green to bright green. A distance-to-one-colour
    // key leaves one end behind; a ratio test must not.
    const dark = path.join(TMP, 'darkgreen.mp4');
    await run('ffmpeg', ['-hide_banner', '-y',
        '-f', 'lavfi', '-i', 'color=c=0x017B02:s=640x360:r=30:d=2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', dark]);
    const bright = path.join(TMP, 'brightgreen.mp4');
    await run('ffmpeg', ['-hide_banner', '-y',
        '-f', 'lavfi', '-i', 'color=c=0x50DD4C:s=640x360:r=30:d=2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', bright]);

    for (const [label, file] of [['shadowed', dark], ['bright', bright]]) {
        const m = await measureGreenScreen(file);
        assert.strictEqual(m.isGreenScreen, true,
            `${label} green should still be recognised, got ${(m.fraction * 100).toFixed(1)}%`);
    }
});

test('cutout mode removes the streamer background and keeps the subject', async () => {
    const gameplay = await makeClip('cut-gp.mp4', { color: 'blue', width: 1280, height: 720, seconds: 5, freq: 220 });
    const streamer = await makeGreenScreenClip('cut-st.mp4');
    const out = path.join(TMP, 'cutout.mp4');

    const result = await composeVideo({
        gameplayPath: gameplay, streamerPath: streamer, outputPath: out,
        layout: 'classic-pip', targetRatio: '16:9', pipPlacement: 'bottom-left',
        removeBackground: true,
    });

    assert.ok(result.key, 'the green-screen measurement is reported back');
    assert.strictEqual(result.key.isGreenScreen, true);

    const { streamer: box } = result.geometry;
    // Centre of the PiP box is the subject block → must survive the key.
    assertColour(
        await samplePixel(out, box.x + box.w / 2, box.y + box.h / 2),
        RED, 'subject survives the key'
    );
    // Just inside the box corner is green field → must be keyed away, revealing
    // the gameplay underneath.
    assertColour(
        await samplePixel(out, box.x + 4, box.y + 4),
        [0, 0, 255], 'streamer background is keyed out, gameplay shows through', 60
    );
});

test('cutout mode draws no webcam frame around the streamer', async () => {
    const gameplay = await makeClip('nf-gp.mp4', { color: 'blue', width: 1280, height: 720, seconds: 4, freq: 220 });
    const streamer = await makeGreenScreenClip('nf-st.mp4');
    const out = path.join(TMP, 'noframe.mp4');

    const result = await composeVideo({
        gameplayPath: gameplay, streamerPath: streamer, outputPath: out,
        layout: 'classic-pip', targetRatio: '16:9', pipPlacement: 'bottom-left',
        removeBackground: true,
    });
    const { streamer: box } = result.geometry;

    // The framed mode paints a white stroke here. A keyed cutout must not: a
    // person inside a webcam frame is the thing this mode exists to avoid.
    const edge = await samplePixel(out, box.x + box.w / 2, box.y + 1);
    const isWhite = edge[0] > 150 && edge[1] > 150 && edge[2] > 150;
    assert.ok(!isWhite, `no white border expected in cutout mode, got rgb(${edge.join(',')})`);
});

test('cutout mode refuses footage that is not a green screen', async () => {
    const gameplay = await makeClip('bad-gp.mp4', { color: 'blue', width: 1280, height: 720, seconds: 3, freq: 220 });
    // A normal avatar clip with a real background: keying it would punch holes in
    // the picture, so this has to fail loudly instead of producing a mess.
    const streamer = await makeClip('bad-st.mp4', { color: 'orange', width: 1280, height: 720, seconds: 3, freq: 660 });
    await assert.rejects(
        () => composeVideo({
            gameplayPath: gameplay, streamerPath: streamer,
            outputPath: path.join(TMP, 'bad.mp4'),
            layout: 'classic-pip', targetRatio: '16:9',
            removeBackground: true,
        }),
        /needs a green-screen streamer clip/
    );
});

test('background removal is ignored for layouts where it makes no sense', async () => {
    // stacked fills its whole slot with the streamer; keying would leave a hole.
    const gameplay = await makeClip('st-gp.mp4', { color: 'blue', width: 1280, height: 720, seconds: 3, freq: 220 });
    const streamer = await makeGreenScreenClip('st-st.mp4', { width: 720, height: 1280 });
    const out = path.join(TMP, 'stacked-nokey.mp4');

    const result = await composeVideo({
        gameplayPath: gameplay, streamerPath: streamer, outputPath: out,
        layout: 'stacked', targetRatio: '16:9', stackedPlacement: 'left',
        removeBackground: true,
    });
    assert.strictEqual(result.key, null, 'no keying is attempted outside classic-pip');
    // The slot still shows the streamer's green field, unkeyed.
    const split = 1920 * constants.STACK_SPLIT_16_9;
    const px = await samplePixel(out, split / 2, 200);
    assert.ok(px[1] > px[0] + 40 && px[1] > px[2] + 40,
        `stacked slot should keep its background, got rgb(${px.join(',')})`);
});

test('framed mode is untouched by the new option', async () => {
    const gameplay = await makeClip('fr-gp.mp4', { color: 'red', width: 1280, height: 720, seconds: 4, freq: 220 });
    const streamer = await makeClip('fr-st.mp4', { color: 'blue', width: 1280, height: 720, seconds: 4, freq: 660 });
    const out = path.join(TMP, 'framed.mp4');

    const result = await composeVideo({
        gameplayPath: gameplay, streamerPath: streamer, outputPath: out,
        layout: 'classic-pip', targetRatio: '16:9', pipPlacement: 'bottom-left',
        // default: removeBackground not set
    });
    assert.strictEqual(result.key, null);
    const { streamer: box } = result.geometry;
    const edge = await samplePixel(out, box.x + box.w / 2, box.y + 1);
    assert.ok(edge[0] > 150 && edge[1] > 150 && edge[2] > 150,
        'the white webcam border still renders when background removal is off');
});
