/**
 * Server-side video composition — the ffmpeg counterpart of the browser's
 * `compositePipVideo` (utils/videoUtils.ts).
 *
 * Autopilot cannot use the browser path: a batch of N finished videos has to be
 * produced without a tab open, so the picture-in-picture composite moves into
 * ffmpeg. The geometry here is a deliberate 1:1 port of the Canvas maths so that
 * an Autopilot render and a Studio render of the same inputs look the same.
 *
 * Ported semantics, all verified against the browser source:
 *   - canvas is 1920x1080 (16:9) or 1080x1920 (9:16)
 *   - the gameplay layer is scaled "cover" and centred, then cropped by the canvas
 *   - classic-pip: streamer occupies 10% of the canvas area, 2% padding,
 *     20px rounded corners, 6px white stroke centred on the path
 *   - stacked: 30% width split (16:9) or 35% height split (9:16); the streamer
 *     covers its slot
 *   - output duration is the *gameplay* duration; the streamer does not loop and
 *     its slot turns black once it ends
 *   - audio is gameplay and streamer mixed at the caller's volumes
 *
 * Not ported: the drop shadow behind the PiP box (rgba(0,0,0,.5), blur 20).
 * ffmpeg has no cheap equivalent and it is barely visible over gameplay footage.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PIP_AREA_FRACTION = 0.1;    // browser: totalArea * 0.1
const PIP_PADDING_RATIO = 0.02;   // browser: width * 0.02
const PIP_CORNER_RADIUS = 20;     // browser: radius = 20
const PIP_BORDER_WIDTH = 6;       // browser: ctx.lineWidth = 6 (centred on path)
const STACK_SPLIT_16_9 = 0.30;    // browser: width * 0.30
const STACK_SPLIT_9_16 = 0.35;    // browser: height * 0.35
const OUTPUT_FPS = 30;

/** Canvas size for a target ratio. Mirrors the browser's 1080p reference. */
const canvasFor = (targetRatio) =>
    targetRatio === '9:16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };

/**
 * "Cover" fit: scale srcRatio to fill dstW x dstH, centred, overflow cropped.
 * Returns the draw box in canvas coordinates, exactly like ctx.drawImage would
 * receive it (offsets may be negative — that is the crop).
 */
const coverBox = (srcRatio, dstX, dstY, dstW, dstH) => {
    const dstRatio = dstW / dstH;
    if (srcRatio > dstRatio) {
        const h = dstH;
        const w = dstH * srcRatio;
        return { x: dstX + (dstW - w) / 2, y: dstY, w, h };
    }
    const w = dstW;
    const h = dstW / srcRatio;
    return { x: dstX, y: dstY + (dstH - h) / 2, w, h };
};

/**
 * Resolve every box needed to draw one frame.
 *
 * Pure function of the inputs, which is what makes the port testable: the same
 * numbers can be asserted here and observed in the rendered pixels.
 */
const computeLayout = ({
    layout,
    targetRatio,
    pipPlacement = 'bottom-left',
    stackedPlacement,
    gameplayWidth,
    gameplayHeight,
    streamerWidth,
    streamerHeight,
}) => {
    if (!gameplayWidth || !gameplayHeight) throw new Error('gameplay dimensions are required');
    if (!streamerWidth || !streamerHeight) throw new Error('streamer dimensions are required');

    const { width, height } = canvasFor(targetRatio);
    const bgRatio = gameplayWidth / gameplayHeight;
    const streamerRatio = streamerWidth / streamerHeight;

    // streamer-only never composites; the caller just concatenates the clips.
    if (layout === 'streamer-only') {
        return { width, height, layout, background: null, streamer: null };
    }

    if (layout === 'classic-pip') {
        // Background covers the whole canvas.
        const background = coverBox(bgRatio, 0, 0, width, height);

        // 10% of the canvas area, keeping the streamer's own aspect ratio.
        const targetArea = width * height * PIP_AREA_FRACTION;
        const pipW = Math.sqrt(targetArea * streamerRatio);
        const pipH = pipW / streamerRatio;
        const padding = width * PIP_PADDING_RATIO;

        let x;
        let y;
        switch (pipPlacement) {
            case 'top-left':     x = padding;                  y = padding;                    break;
            case 'top-right':    x = width - pipW - padding;   y = padding;                    break;
            case 'bottom-right': x = width - pipW - padding;   y = height - pipH - padding;    break;
            case 'bottom-left':
            default:             x = padding;                  y = height - pipH - padding;    break;
        }

        return {
            width, height, layout,
            background,
            streamer: { x, y, w: pipW, h: pipH, fit: 'stretch', rounded: true },
        };
    }

    if (layout === 'stacked') {
        if (targetRatio === '9:16') {
            const split = height * STACK_SPLIT_9_16;
            const streamerTop = stackedPlacement === 'top';
            const slot = { x: 0, y: streamerTop ? 0 : height - split, w: width, h: split };
            const gameArea = { x: 0, y: streamerTop ? split : 0, w: width, h: height - split };
            return {
                width, height, layout,
                background: coverBox(bgRatio, gameArea.x, gameArea.y, gameArea.w, gameArea.h),
                streamer: { ...slot, fit: 'cover', rounded: false, streamerRatio },
            };
        }

        const split = width * STACK_SPLIT_16_9;
        const streamerLeft = stackedPlacement === 'left';
        const slot = { x: streamerLeft ? 0 : width - split, y: 0, w: split, h: height };
        const gameArea = { x: streamerLeft ? split : 0, y: 0, w: width - split, h: height };
        return {
            width, height, layout,
            background: coverBox(bgRatio, gameArea.x, gameArea.y, gameArea.w, gameArea.h),
            streamer: { ...slot, fit: 'cover', rounded: false, streamerRatio },
        };
    }

    throw new Error(`Unsupported layout: ${layout}`);
};

// ── ffprobe helpers ──────────────────────────────────────────────────────────

const run = (bin, args, { capture = true } = {}) => new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let out = '';
    let err = '';
    if (capture) {
        p.stdout.on('data', (d) => { out += d.toString(); });
        p.stderr.on('data', (d) => { err += d.toString(); });
    }
    p.on('error', reject);
    p.on('close', (code) => {
        if (code === 0) return resolve(out);
        reject(new Error(`${path.basename(bin)} exited ${code}: ${(err || out).slice(-1500)}`));
    });
});

/** Dimensions, duration and audio presence of a media file. */
const probeMedia = async (file) => {
    const raw = await run('ffprobe', [
        '-v', 'error', '-show_entries',
        'stream=codec_type,width,height:format=duration',
        '-of', 'json', file,
    ]);
    const data = JSON.parse(raw);
    const video = (data.streams || []).find((s) => s.codec_type === 'video');
    if (!video) throw new Error(`No video stream in ${path.basename(file)}`);
    return {
        width: Number(video.width),
        height: Number(video.height),
        duration: Number(data.format?.duration) || 0,
        hasAudio: (data.streams || []).some((s) => s.codec_type === 'audio'),
    };
};

// ── filter graph ─────────────────────────────────────────────────────────────

/**
 * geq alpha expression for a rounded rectangle of w x h with corner radius r.
 * Commas are escaped for ffmpeg's option parser (the graph goes through
 * -filter_complex_script, so no shell escaping is involved).
 */
const roundedAlphaExpr = (w, h, r) => {
    const dx = `max(0\\,max(${r}-X\\,X-${w - 1 - r}))`;
    const dy = `max(0\\,max(${r}-Y\\,Y-${h - 1 - r}))`;
    return `if(lte(hypot(${dx}\\,${dy})\\,${r})\\,255\\,0)`;
};

/**
 * geq alpha for the white stroke: inside the outer rounded rect but outside the
 * inset one. The browser strokes 6px centred on the path, so the ring spans 3px
 * either side; reproducing that keeps the outer bounding box identical.
 */
const ringAlphaExpr = (w, h, r, bw) => {
    const half = bw / 2;
    const outer = `lte(hypot(max(0\\,max(${r}-X\\,X-${w - 1 - r}))\\,max(0\\,max(${r}-Y\\,Y-${h - 1 - r})))\\,${r})`;
    const iw = w - bw;
    const ih = h - bw;
    const ir = Math.max(1, r - half);
    const ix = `(X-${half})`;
    const iy = `(Y-${half})`;
    const insideInnerBox = `gte(${ix}\\,0)*gte(${iy}\\,0)*lte(${ix}\\,${iw - 1})*lte(${iy}\\,${ih - 1})`;
    const innerRound = `lte(hypot(max(0\\,max(${ir}-${ix}\\,${ix}-${iw - 1 - ir}))\\,max(0\\,max(${ir}-${iy}\\,${iy}-${ih - 1 - ir})))\\,${ir})`;
    return `if(${outer}*(1-(${insideInnerBox}*${innerRound}))\\,255\\,0)`;
};

const r0 = (n) => Math.round(n);

/**
 * Build the filter_complex for one composite.
 *
 * Input 0 is the gameplay, input 1 the streamer. The canvas is a black colour
 * source so that a background which does not cover the whole frame (stacked)
 * letterboxes to black exactly like the Canvas version, and so that negative
 * draw offsets (cover crop) work through overlay.
 */
const buildFilterGraph = ({ geo, duration, gameplayHasAudio, streamerHasAudio, volumes }) => {
    const { width, height, background, streamer } = geo;
    const chains = [];

    chains.push(`color=c=black:s=${width}x${height}:r=${OUTPUT_FPS}:d=${duration.toFixed(3)}[canvas]`);

    // Gameplay layer.
    chains.push(`[0:v]scale=${r0(background.w)}:${r0(background.h)},setsar=1[bgscaled]`);
    chains.push(`[canvas][bgscaled]overlay=x=${r0(background.x)}:y=${r0(background.y)}:eof_action=pass[bg]`);

    // Streamer layer. tpad turns the tail into black frames so the slot goes
    // black when the streamer ends, matching the browser's fillRect fallback.
    const sw = r0(streamer.w);
    const sh = r0(streamer.h);
    if (streamer.fit === 'cover') {
        const box = coverBox(streamer.streamerRatio, 0, 0, streamer.w, streamer.h);
        chains.push(
            `[1:v]scale=${r0(box.w)}:${r0(box.h)},setsar=1,`
            + `crop=${sw}:${sh}:${r0(-(box.x))}:${r0(-(box.y))},`
            + `tpad=stop_mode=add:stop_duration=${duration.toFixed(3)}:color=black[st]`
        );
        chains.push(`[bg][st]overlay=x=${r0(streamer.x)}:y=${r0(streamer.y)}:eof_action=pass[vout]`);
    } else {
        chains.push(
            `[1:v]scale=${sw}:${sh},setsar=1,`
            + `tpad=stop_mode=add:stop_duration=${duration.toFixed(3)}:color=black,`
            + `format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='${roundedAlphaExpr(sw, sh, PIP_CORNER_RADIUS)}'[st]`
        );
        chains.push(`[bg][st]overlay=x=${r0(streamer.x)}:y=${r0(streamer.y)}:eof_action=pass[withpip]`);
        chains.push(
            `color=c=white:s=${sw}x${sh}:r=${OUTPUT_FPS}:d=${duration.toFixed(3)},`
            + `format=rgba,geq=r='255':g='255':b='255':a='${ringAlphaExpr(sw, sh, PIP_CORNER_RADIUS, PIP_BORDER_WIDTH)}'[ring]`
        );
        chains.push(`[withpip][ring]overlay=x=${r0(streamer.x)}:y=${r0(streamer.y)}:eof_action=pass[vout]`);
    }

    // Audio: mix at the caller's volumes, tied to the gameplay duration.
    let audioLabel = null;
    const gv = Number.isFinite(volumes?.gameplay) ? volumes.gameplay : 1;
    const sv = Number.isFinite(volumes?.streamer) ? volumes.streamer : 1;
    if (gameplayHasAudio && streamerHasAudio) {
        chains.push(`[0:a]volume=${gv}[a0]`);
        chains.push(`[1:a]volume=${sv},apad[a1]`);
        chains.push(`[a0][a1]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[aout]`);
        audioLabel = '[aout]';
    } else if (gameplayHasAudio) {
        chains.push(`[0:a]volume=${gv}[aout]`);
        audioLabel = '[aout]';
    } else if (streamerHasAudio) {
        chains.push(`[1:a]volume=${sv},apad[aout]`);
        audioLabel = '[aout]';
    }

    return { graph: chains.join(';\n'), audioLabel };
};

/**
 * Composite a streamer track over gameplay footage.
 *
 * `streamerPath` is the already-concatenated streamer video (the Autopilot
 * pipeline stitches the clips first, reusing the existing concat path).
 */
const composeVideo = async ({
    gameplayPath,
    streamerPath,
    outputPath,
    layout,
    targetRatio,
    pipPlacement,
    stackedPlacement,
    volumes = { gameplay: 1, streamer: 1 },
    onProgress,
}) => {
    const [gameplay, streamerMeta] = await Promise.all([
        probeMedia(gameplayPath),
        probeMedia(streamerPath),
    ]);

    const geo = computeLayout({
        layout,
        targetRatio,
        pipPlacement,
        stackedPlacement,
        gameplayWidth: gameplay.width,
        gameplayHeight: gameplay.height,
        streamerWidth: streamerMeta.width,
        streamerHeight: streamerMeta.height,
    });

    if (!geo.streamer) {
        throw new Error('composeVideo does not handle streamer-only; concatenate the clips instead');
    }

    // Browser semantics: recording stops when the gameplay ends.
    const duration = gameplay.duration;
    if (!(duration > 0)) throw new Error('Could not determine the gameplay duration');

    const { graph, audioLabel } = buildFilterGraph({
        geo,
        duration,
        gameplayHasAudio: gameplay.hasAudio,
        streamerHasAudio: streamerMeta.hasAudio,
        volumes,
    });

    const scriptFile = path.join(
        os.tmpdir(),
        `gh-filter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
    );
    fs.writeFileSync(scriptFile, graph);

    const args = [
        '-hide_banner', '-y',
        '-i', gameplayPath,
        '-i', streamerPath,
        '-filter_complex_script', scriptFile,
        '-map', '[vout]',
    ];
    if (audioLabel) args.push('-map', audioLabel, '-c:a', 'aac', '-b:a', '192k');
    else args.push('-an');
    args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-r', String(OUTPUT_FPS),
        '-t', duration.toFixed(3),
        '-movflags', '+faststart',
        outputPath
    );

    try {
        if (onProgress) onProgress('compositing');
        await run('ffmpeg', args);
    } finally {
        fs.unlink(scriptFile, () => {});
    }

    const result = await probeMedia(outputPath);

    // Validation gate: the composite must match the canvas and the gameplay length.
    if (result.width !== geo.width || result.height !== geo.height) {
        throw new Error(
            `Composite has wrong dimensions: ${result.width}x${result.height}, expected ${geo.width}x${geo.height}`
        );
    }
    if (Math.abs(result.duration - duration) > 0.5) {
        throw new Error(
            `Composite duration ${result.duration.toFixed(2)}s does not match gameplay ${duration.toFixed(2)}s`
        );
    }
    if (audioLabel && !result.hasAudio) throw new Error('Composite lost its audio track');

    return { ...result, geometry: geo };
};

export const constants = {
    PIP_AREA_FRACTION,
    PIP_PADDING_RATIO,
    PIP_CORNER_RADIUS,
    PIP_BORDER_WIDTH,
    STACK_SPLIT_16_9,
    STACK_SPLIT_9_16,
    OUTPUT_FPS,
};

export {
    canvasFor,
    coverBox,
    computeLayout,
    probeMedia,
    buildFilterGraph,
    composeVideo,
};
