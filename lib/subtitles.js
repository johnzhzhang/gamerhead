/**
 * Burned-in subtitle layout: size, line breaking, timing and placement.
 *
 * Shared by every subtitle pass — the wizard's burn of the composited mix, the
 * stitch-only export and Autopilot's compositor — so captions look the same
 * whichever path produced the video.
 *
 * Three rules, from user feedback on real output:
 *   1. Sized to the width. The old style sized type to ~4.2% of the frame height,
 *      which on a 1080x1920 portrait frame is 64 px — a 15-word line wrapped to four
 *      or five lines and covered a third of the picture.
 *   2. One line where possible, never more than two. A shot's dialogue is split
 *      into consecutive captions, each timed in proportion to its length, rather
 *      than shown as one paragraph for the whole shot.
 *   3. Never over the streamer. Captions sit in the part of the frame the streamer
 *      does not occupy: above a bottom picture-in-picture box on portrait, beside it
 *      on landscape, and clear of a stacked layout's streamer slot.
 *
 * libass does the actual drawing, but it cannot be asked how wide a string is, so
 * widths are estimated from Arial Bold advance widths. The container installs
 * Liberation Sans, which is metric-compatible with Arial, so the estimate holds for
 * what is actually rendered (verified by measuring rendered output; see tests).
 */

// Arial Bold / Liberation Sans Bold advance widths, in 1/1000 em.
const ADVANCE = {
    ' ': 278, '!': 333, '"': 474, '#': 556, '$': 556, '%': 889, '&': 722, "'": 238,
    '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
    ':': 333, ';': 333, '<': 584, '=': 584, '>': 584, '?': 611, '@': 975,
    A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556,
    K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
    U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
    a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278,
    k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333,
    u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
};
for (let d = 0; d <= 9; d += 1) ADVANCE[String(d)] = 556;

const isWide = (ch) => /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch);

// libass renders Liberation Sans Bold narrower than the nominal Arial advances:
// measured on 84 real captions, rendered width was 0.883–0.894 of the table's
// prediction, outline included. Applied so lines fill the width they are given.
const RENDER_SCALE = 0.9;

/** Estimated rendered width of `text`, in em. */
export const textWidthEm = (text) => {
    let units = 0;
    for (const ch of String(text || '')) {
        units += ADVANCE[ch] ?? (isWide(ch) ? 1000 : 600);
    }
    return (units / 1000) * RENDER_SCALE;
};

// Target characters per line. ~36 is the usual ceiling for comfortable captions;
// fewer and the type gets large, more and a line becomes hard to take in at once.
const TARGET_CPL = 36;
// Average em width of English dialogue in this face, for turning TARGET_CPL into a
// font size, before the render scale. Measured on this project's scripts: 0.53–0.56.
const AVG_EM_PER_CHAR = 0.55 * RENDER_SCALE;
// Headroom for the estimate and for the outline, so a line judged to fit does.
const FIT = 0.92;
// Shortest a caption may stay on screen before two lines are preferred over a
// faster sequence of single lines.
const MIN_CAPTION_SECONDS = 1.4;

/**
 * Where captions may go, given the streamer's box in frame coordinates (or null
 * when the whole frame is the streamer, as in a streamer-only export).
 *
 * Returns ASS margins: captions are bottom-centred (alignment 2) within the
 * horizontal band [marginL, width - marginR], with their baseline marginV above
 * the bottom edge.
 */
export const captionRegion = ({ width, height, avoid = null }) => {
    const side = Math.round(width * 0.05);
    const bottom = Math.round(height * 0.06);
    const gap = Math.round(height * 0.02);
    const region = { marginL: side, marginR: side, marginV: bottom };
    if (!avoid || !(avoid.w > 0) || !(avoid.h > 0)) return region;

    const left = avoid.x;
    const right = avoid.x + avoid.w;
    const top = avoid.y;
    const centreX = left + avoid.w / 2;
    const centreY = top + avoid.h / 2;

    // A full-height slot (stacked, landscape): keep to the other side of it.
    if (avoid.h >= height * 0.9) {
        if (centreX < width / 2) region.marginL = Math.round(right + side);
        else region.marginR = Math.round(width - left + side);
        return region;
    }
    // Streamer in the top half: the bottom is free.
    if (centreY < height / 2) return region;

    // Streamer at the bottom. On a landscape frame there is room beside it at the
    // bottom; on a portrait frame the width beside a corner box is too narrow, so
    // captions go above it instead.
    const besideWidth = centreX < width / 2 ? width - right - 2 * side : left - 2 * side;
    if (width > height && besideWidth >= width * 0.45) {
        if (centreX < width / 2) region.marginL = Math.round(right + side);
        else region.marginR = Math.round(width - left + side);
        return region;
    }
    region.marginV = Math.round(height - top + gap);
    return region;
};

/** Font size for a region, in ASS units (= pixels, PlayRes matches the frame). */
export const captionFontSize = ({ width, height, region }) => {
    const available = width - region.marginL - region.marginR;
    const byWidth = available / (TARGET_CPL * AVG_EM_PER_CHAR);
    const byHeight = height * (width > height ? 0.05 : 0.032);
    return Math.max(24, Math.round(Math.min(byWidth, byHeight)));
};

const words = (text) => String(text || '').trim().split(/\s+/).filter(Boolean);

/**
 * Split `text` into `k` runs of near-equal width at word boundaries, preferring
 * to break after punctuation when it is close to the ideal point.
 */
export const splitBalanced = (text, k) => {
    const w = words(text);
    if (k <= 1 || w.length <= 1) return [w.join(' ')];
    k = Math.min(k, w.length);
    const widths = w.map((x) => textWidthEm(x + ' '));
    const total = widths.reduce((a, b) => a + b, 0);
    const out = [];
    let start = 0;
    let acc = 0;
    for (let part = 1; part < k; part += 1) {
        const ideal = (total * part) / k;
        const remainingParts = k - part;
        let best = -1;
        let bestScore = Infinity;
        let run = acc;
        for (let i = start; i < w.length - remainingParts; i += 1) {
            run += widths[i];
            const punct = /[.,!?;:—–]$/.test(w[i]) ? 0.6 : 1;
            const score = Math.abs(run - ideal) * punct;
            if (score < bestScore) { bestScore = score; best = i; }
            if (run > ideal * 1.3) break;
        }
        const end = best < start ? start : best;
        out.push(w.slice(start, end + 1).join(' '));
        acc = widths.slice(0, end + 1).reduce((a, b) => a + b, 0);
        start = end + 1;
    }
    out.push(w.slice(start).join(' '));
    return out.filter(Boolean);
};

/**
 * Turn one cue into captions that each fit on one line, or two when single lines
 * would flash past too quickly. Each caption's time is proportional to its width,
 * a fair stand-in for how long it takes to say.
 */
export const fitCue = ({ start, end, text }, { lineEm }) => {
    const clean = words(text).join(' ');
    if (!clean) return [];
    const duration = Math.max(0.01, end - start);
    const total = textWidthEm(clean);
    const usable = lineEm * FIT;

    let lines = 1;
    let k = Math.max(1, Math.ceil(total / usable));
    if (k > 1 && duration / k < MIN_CAPTION_SECONDS) {
        lines = 2;
        k = Math.max(1, Math.ceil(total / (2 * usable)));
    }
    const chunks = splitBalanced(clean, k);

    const widths = chunks.map(textWidthEm);
    const sum = widths.reduce((a, b) => a + b, 0) || 1;
    let t = start;
    return chunks.map((chunk, i) => {
        const next = i === chunks.length - 1 ? end : t + (duration * widths[i]) / sum;
        let shown = chunk;
        // Two-line captions get an explicit, balanced break rather than being left
        // to the renderer, which would fill the first line and leave a stub.
        if (lines === 2 && textWidthEm(chunk) > usable) shown = splitBalanced(chunk, 2).join('\n');
        const caption = { start: t, end: next, text: shown };
        t = next;
        return caption;
    });
};

const toSeconds = (raw) => {
    const m = String(raw).trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
    if (!m) return null;
    const [, h, mm, ss, ms] = m;
    return Number(h) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0')) / 1000;
};

/** Parse SRT into [{ start, end, text }] in seconds. */
export const parseSrt = (srt) => {
    const cues = [];
    for (const block of String(srt || '').replace(/\r\n/g, '\n').split(/\n{2,}/)) {
        const parts = block.trim().split('\n');
        const timeIdx = parts.findIndex((l) => l.includes('-->'));
        if (timeIdx < 0) continue;
        const [a, b] = parts[timeIdx].split('-->');
        const start = toSeconds(a);
        const end = toSeconds(b);
        const text = parts.slice(timeIdx + 1).join(' ').trim();
        if (start === null || end === null || !text) continue;
        cues.push({ start, end, text });
    }
    return cues;
};

const assTime = (secs) => {
    const cs = Math.max(0, Math.round(secs * 100));
    const h = Math.floor(cs / 360000);
    const m = Math.floor((cs % 360000) / 6000);
    const s = Math.floor((cs % 6000) / 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

const escapeAss = (text) => text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');

/**
 * Build a complete ASS file for `srt` on a `width` x `height` frame, keeping clear
 * of `avoid` (the streamer's box in frame coordinates, or null).
 *
 * PlayResX/Y are pinned to the real frame size so every number here is a pixel.
 * Without that libass converts SRT at PlayResY=288 and scales pixel font sizes by
 * height/288 — 6.7x on a portrait frame.
 */
export const buildSubtitleAss = (srt, { width = 1920, height = 1080, avoid = null } = {}) => {
    const region = captionRegion({ width, height, avoid });
    const fontSize = captionFontSize({ width, height, region });
    const outline = Math.max(2, Math.round(fontSize * 0.09));
    const shadow = Math.max(1, Math.round(fontSize * 0.05));
    const lineEm = (width - region.marginL - region.marginR - 2 * outline) / fontSize;

    const captions = parseSrt(srt).flatMap((cue) => fitCue(cue, { lineEm }));

    const style = `Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,`
        + `1,0,0,0,100,100,0,0,1,${outline},${shadow},2,${region.marginL},${region.marginR},${region.marginV},1`;
    return [
        '[Script Info]',
        'ScriptType: v4.00+',
        `PlayResX: ${width}`,
        `PlayResY: ${height}`,
        'ScaledBorderAndShadow: yes',
        // Smart wrapping stays on as a safety net; the explicit breaks above mean it
        // should never need to act.
        'WrapStyle: 0',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        style,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ...captions.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${escapeAss(c.text)}`),
        '',
    ].join('\n');
};
