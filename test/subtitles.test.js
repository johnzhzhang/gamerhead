/**
 * Tests for lib/subtitles.js.
 *
 * Two layers, like the compositor tests: the layout rules are checked directly, and
 * then real dialogue is rendered through libass and the *pixels* are measured —
 * line count, width and whether any caption lands on the streamer. That is what
 * actually proves the width estimate holds for the font that gets drawn.
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    textWidthEm, captionRegion, captionFontSize, splitBalanced, fitCue, parseSrt, buildSubtitleAss,
} from '../lib/subtitles.js';
import { computeLayout } from '../lib/compose.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-subs-test-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Real shot dialogue from this project's scripts, at the lengths the script model
// produces for 4, 6 and 8 second shots.
const LINES = [
    'Dragging and merging two simple coffee cups gives you fancy lattes to satisfy your impatient beachside customers!',
    'Pick your favorite furniture, customize the flooring, and transform this ruined diner into a luxury island hotspot.',
    'Tap below to download Gossip Harbor and get your new player package for free right now.',
    'Are you ready?',
    'Every order you complete unlocks custom restaurant decor and reveals juicy island gossip about who really caused all the drama on Brimwave Island this summer.',
];
const srtOf = (lines, secs = 6) => lines.map((l, i) => {
    const t = (s) => `00:00:${String(s).padStart(2, '0')},000`;
    return `${i + 1}\n${t(i * secs)} --> ${t((i + 1) * secs)}\n${l}\n`;
}).join('\n');

const LAYOUTS = [
    ['classic-pip', '9:16', 'bottom-left'],
    ['classic-pip', '9:16', 'bottom-right'],
    ['classic-pip', '9:16', 'top-left'],
    ['classic-pip', '16:9', 'bottom-left'],
    ['classic-pip', '16:9', 'bottom-right'],
    ['stacked', '9:16', 'bottom'],
    ['stacked', '9:16', 'top'],
    ['stacked', '16:9', 'left'],
    ['stacked', '16:9', 'right'],
];
// The streamer clip's orientation follows the layout (picture-in-picture matches the
// output, stacked is the opposite), and the PiP box keeps that aspect ratio — so the
// box captions must avoid depends on it.
const portraitClip = (layout, ratio) => (layout === 'stacked' ? ratio === '16:9' : ratio === '9:16');
const geoFor = ([layout, ratio, place]) => computeLayout({
    layout, targetRatio: ratio,
    pipPlacement: layout === 'classic-pip' ? place : undefined,
    stackedPlacement: layout === 'stacked' ? place : undefined,
    gameplayWidth: 720, gameplayHeight: 1280,
    streamerWidth: portraitClip(layout, ratio) ? 720 : 1280,
    streamerHeight: portraitClip(layout, ratio) ? 1280 : 720,
});

// ── layout rules ─────────────────────────────────────────────────────────────

test('captions go above a bottom PiP on portrait and beside it on landscape', () => {
    const tall = geoFor(['classic-pip', '9:16', 'bottom-left']);
    const r1 = captionRegion({ width: tall.width, height: tall.height, avoid: tall.streamer });
    assert.ok(tall.height - r1.marginV < tall.streamer.y, 'baseline sits above the PiP box');
    const wide = geoFor(['classic-pip', '16:9', 'bottom-left']);
    const r2 = captionRegion({ width: wide.width, height: wide.height, avoid: wide.streamer });
    assert.ok(r2.marginL > wide.streamer.x + wide.streamer.w, 'band starts right of the PiP box');
});

test('captions stay clear of a stacked streamer slot', () => {
    const side = geoFor(['stacked', '16:9', 'left']);
    const r = captionRegion({ width: side.width, height: side.height, avoid: side.streamer });
    assert.ok(r.marginL >= side.streamer.x + side.streamer.w);
    const under = geoFor(['stacked', '9:16', 'bottom']);
    const r2 = captionRegion({ width: under.width, height: under.height, avoid: under.streamer });
    assert.ok(under.height - r2.marginV < under.streamer.y);
});

test('without a streamer box captions use the full width at the bottom', () => {
    const r = captionRegion({ width: 1080, height: 1920, avoid: null });
    assert.strictEqual(r.marginL, r.marginR);
    assert.ok(r.marginV < 1920 * 0.1);
});

test('type is sized to the width, far smaller than the old height-based 64 px', () => {
    const r = captionRegion({ width: 1080, height: 1920 });
    const size = captionFontSize({ width: 1080, height: 1920, region: r });
    assert.ok(size >= 40 && size <= 60, `portrait size ${size}`);
});

test('dialogue is split into single-line captions, timed by length', () => {
    const out = fitCue({ start: 0, end: 6, text: LINES[0] }, { lineEm: 18 });
    assert.ok(out.length >= 2);
    assert.ok(out.every((c) => !c.text.includes('\n')), 'all single line');
    assert.strictEqual(out[0].start, 0);
    assert.strictEqual(out.at(-1).end, 6);
    for (let i = 1; i < out.length; i += 1) assert.strictEqual(out[i].start, out[i - 1].end);
    assert.strictEqual(out.map((c) => c.text).join(' '), LINES[0], 'no words lost or reordered');
});

test('two lines are used only when single lines would flash past', () => {
    const out = fitCue({ start: 0, end: 2, text: LINES[4] }, { lineEm: 18 });
    assert.ok(out.some((c) => c.text.includes('\n')));
    assert.ok(out.every((c) => c.text.split('\n').length <= 2));
});

test('a short line stays one caption', () => {
    assert.deepStrictEqual(fitCue({ start: 0, end: 4, text: LINES[3] }, { lineEm: 18 }).map((c) => c.text), [LINES[3]]);
});

test('balanced splits keep every word, in order', () => {
    for (let k = 1; k <= 5; k += 1) {
        assert.strictEqual(splitBalanced(LINES[1], k).join(' '), LINES[1]);
    }
});

test('SRT round-trips into cues', () => {
    const cues = parseSrt(srtOf(LINES.slice(0, 2)));
    assert.deepStrictEqual(cues.map((c) => [c.start, c.end]), [[0, 6], [6, 12]]);
});

test('ASS control characters in dialogue are escaped', () => {
    const ass = buildSubtitleAss(srtOf(['Use {braces} and a \\ backslash']), { width: 1080, height: 1920 });
    assert.ok(ass.includes('\\{braces\\}'));
});

// ── rendered pixels ──────────────────────────────────────────────────────────

const hasLibass = spawnSync('ffmpeg', ['-hide_banner', '-filters']).stdout.toString().includes(' ass ');

/** Render one frame of an ASS file over black and return text-line bands. */
const measure = (assFile, W, H, at, fontSize) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=40:r=5`,
        '-vf', `ass=${assFile}`, '-ss', String(at), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 1 << 27 }).stdout;
    const rows = [];
    for (let y = 0; y < H; y += 1) {
        let a = -1; let b = -1;
        for (let x = 0; x < W; x += 1) if (r[y * W + x] > 100) { if (a < 0) a = x; b = x; }
        rows.push(a < 0 ? null : [a, b]);
    }
    // Lines are separated by their leading; anything thinner than a quarter of the
    // type size is a gap inside a line (descenders, punctuation).
    const bands = [];
    let cur = null;
    let gap = 0;
    for (let y = 0; y < H; y += 1) {
        if (rows[y]) {
            if (!cur) cur = { y0: y, y1: y, x0: rows[y][0], x1: rows[y][1] };
            else { cur.y1 = y; cur.x0 = Math.min(cur.x0, rows[y][0]); cur.x1 = Math.max(cur.x1, rows[y][1]); }
            gap = 0;
        } else if (cur && ++gap > fontSize * 0.12) { bands.push(cur); cur = null; }
    }
    if (cur) bands.push(cur);
    return bands.filter((b) => b.y1 - b.y0 > fontSize * 0.45);
};

for (const L of LAYOUTS) {
    test(`rendered: ${L.join(' ')} — at most two lines, inside the frame, clear of the streamer`, { skip: !hasLibass }, () => {
        const geo = geoFor(L);
        const W = geo.width; const H = geo.height; const box = geo.streamer;
        const ass = buildSubtitleAss(srtOf(LINES), { width: W, height: H, avoid: box });
        const file = path.join(TMP, `${L.join('-').replace(/:/g, 'x')}.ass`);
        fs.writeFileSync(file, ass);
        const font = Number(ass.match(/Style: Default,Arial,(\d+)/)[1]);
        const toS = (x) => { const [h, m, s] = x.split(':'); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
        const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
        assert.ok(events.length >= LINES.length);
        let single = 0;
        for (const ev of events) {
            const [, a, b] = ev.split(',');
            const bands = measure(file, W, H, ((toS(a) + toS(b)) / 2).toFixed(2), font);
            assert.ok(bands.length >= 1 && bands.length <= 2, `${bands.length} lines: ${ev}`);
            if (bands.length === 1) single += 1;
            const x0 = Math.min(...bands.map((q) => q.x0)); const x1 = Math.max(...bands.map((q) => q.x1));
            const y0 = Math.min(...bands.map((q) => q.y0)); const y1 = Math.max(...bands.map((q) => q.y1));
            assert.ok(x0 > 0 && x1 < W - 1, `inside the frame horizontally: ${x0}..${x1}`);
            const clear = x1 < box.x || x0 > box.x + box.w || y1 < box.y || y0 > box.y + box.h;
            assert.ok(clear, `caption ${x0},${y0}–${x1},${y1} overlaps the streamer ${JSON.stringify(box)}`);
        }
        assert.ok(single / events.length >= 0.75, `mostly single lines: ${single}/${events.length}`);
    });
}

test('rendered width matches the estimate the line breaking relies on', { skip: !hasLibass }, () => {
    const W = 1920; const H = 1080; const size = 54;
    for (const s of LINES.slice(0, 3)) {
        const ass = [
            '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
            `Style: Default,Arial,${size},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
            '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
            `Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,${s.slice(0, 40)}`, '',
        ].join('\n');
        const file = path.join(TMP, 'w.ass');
        fs.writeFileSync(file, ass);
        const [band] = measure(file, W, H, 1, size);
        const ratio = (band.x1 - band.x0) / (textWidthEm(s.slice(0, 40)) * size);
        assert.ok(ratio > 0.9 && ratio < 1.06, `rendered/estimated width ${ratio.toFixed(3)} for "${s.slice(0, 40)}"`);
    }
});

// ── the wizard path derives the streamer box from the layout alone ───────────

test('the box derived from a layout matches the compositor, in every layout', () => {
    // server.js has no exports; take the function verbatim so the test checks the
    // code that runs.
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const i = src.indexOf('const streamerBoxFor = ');
    const j = src.indexOf('\n};\n', i) + 3;
    const streamerBoxFor = new Function('computeLayout', `${src.slice(i, j)}\nreturn streamerBoxFor;`)(computeLayout);
    for (const L of LAYOUTS) {
        const [layoutType, targetRatio, place] = L;
        const real = geoFor(L);
        const truth = real.streamer;
        const got = streamerBoxFor({ layoutType, targetRatio, pipPlacement: place, stackedPlacement: place }, real.width, real.height);
        for (const k of ['x', 'y', 'w', 'h']) {
            assert.ok(Math.abs(got[k] - truth[k]) < 1, `${L.join(' ')} ${k}: ${got[k]} vs ${truth[k]}`);
        }
    }
});
