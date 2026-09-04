/**
 * Autopilot — one page, one submit, N finished videos.
 *
 * Four sections stack on the same page as the job progresses:
 *   1. brief      — everything the pipeline needs, filled once
 *   2. ⏸ confirm  — the streamer image; the only place a human is required
 *   3. progress   — per-variant status while the batch renders
 *   4. results    — playable previews and download links
 *
 * The confirmation gate is not just a preview. Crossing it is what authorises the
 * expensive half of the run (a 10-variant batch is roughly 40 video generations),
 * and a streamer image cannot be reproduced once regenerated — so it is confirmed
 * before anything is spent, and the cost is stated on the button.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NeonButton from './NeonButton';
import { TextField, TextArea } from './TextInput';
import type { LayoutType, PipPlacement, StackedPlacement, TargetAspectRatio } from '../types';
import {
  approveAvatar,
  cancelJob,
  createJob,
  fetchAutopilotConfig,
  getJob,
  isTerminalStatus,
  listJobs,
  regenerateAvatar,
  uploadGameplay,
  uploadImage,
  uploadOwnAvatar,
  useUploadedAvatar,
  type AutopilotConfig,
  type AutopilotJobView,
} from '../services/autopilot';

const POLL_MS = 6000;

/**
 * The id of the batch last opened in this browser.
 *
 * A batch runs server-side and outlives the tab, so without this the work would
 * be unreachable after a reload — the console would claim you can come back and
 * then offer no way to do it.
 */
const LAST_JOB_KEY = 'gh_autopilot_last_job';

const readLastJobId = (): string | null => {
  try { return localStorage.getItem(LAST_JOB_KEY); } catch { return null; }
};
const writeLastJobId = (id: string | null) => {
  try {
    if (id) localStorage.setItem(LAST_JOB_KEY, id);
    else localStorage.removeItem(LAST_JOB_KEY);
  } catch { /* private mode: recovery falls back to the batch list */ }
};

const relativeTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

const STAGE_LABEL: Record<string, string> = {
  pending: 'Queued',
  script: 'Writing script',
  clips: 'Rendering clips',
  compose: 'Compositing',
  done: 'Ready',
  failed: 'Failed',
};

const STATUS_LABEL: Record<string, string> = {
  created: 'Preparing',
  awaiting_avatar: 'Waiting for your confirmation',
  running: 'Producing',
  completed: 'All videos ready',
  partially_completed: 'Finished with some failures',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const Section: React.FC<{ step: string; title: string; hint?: string; children: React.ReactNode }> = ({
  step, title, hint, children,
}) => (
  <section className="bg-google-gray border border-gray-700 rounded-2xl p-6 mb-6">
    <header className="mb-5">
      <div className="flex items-center gap-3">
        <span className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-700 text-gray-200 text-xs font-bold flex items-center justify-center">
          {step}
        </span>
        <h2 className="text-lg font-medium text-gray-100">{title}</h2>
      </div>
      {hint && <p className="text-xs text-gray-400 mt-2 ml-10">{hint}</p>}
    </header>
    {children}
  </section>
);

const INPUT_CLASS = 'w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm '
  + 'text-gray-200 placeholder-gray-500 focus:ring-2 focus:ring-google-blue focus:border-transparent '
  + 'outline-none transition-all disabled:opacity-50';

/**
 * Label + IME-safe input. TextField/TextArea are unstyled and report changes as
 * (name, value), so the label and class live here rather than being repeated.
 */
const Field: React.FC<{
  name: string;
  label: string;
  value: string;
  onCommit: (name: string, value: string) => void;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  multiline?: boolean;
  rows?: number;
  inputMode?: 'text' | 'url';
  disabled?: boolean;
}> = ({ name, label, value, onCommit, placeholder, hint, required, multiline, rows, inputMode, disabled }) => (
  <div>
    <label htmlFor={`ap-${name}`} className="block text-xs text-gray-400 mb-1.5">
      {label}{required && <span className="text-google-red ml-1" aria-hidden="true">*</span>}
    </label>
    {multiline ? (
      <TextArea id={`ap-${name}`} name={name} value={value} onCommit={onCommit}
                rows={rows ?? 2} placeholder={placeholder} disabled={disabled}
                className={INPUT_CLASS} aria-label={label} />
    ) : (
      <TextField id={`ap-${name}`} name={name} value={value} onCommit={onCommit}
                 inputMode={inputMode} placeholder={placeholder} disabled={disabled}
                 className={INPUT_CLASS} aria-label={label} />
    )}
    {hint && <p className="text-[11px] text-gray-500 mt-1.5">{hint}</p>}
  </div>
);

/**
 * A file picker with a thumbnail. Images go through an upload, never a URI the
 * user has to construct.
 */
const ImagePicker: React.FC<{
  id: string;
  label: string;
  hint?: string;
  file: File | null;
  preview: string | null;
  accept: string;
  disabled?: boolean;
  disabledNote?: string;
  onPick: (f: File | null) => void;
}> = ({ id, label, hint, file, preview, accept, disabled, disabledNote, onPick }) => (
  <div className={disabled ? 'opacity-50' : ''}>
    <label htmlFor={id} className="block text-xs text-gray-400 mb-1.5">{label}</label>
    <div className="flex items-start gap-3">
      {preview && (
        <img src={preview} alt={`${label} preview`}
             className="w-16 h-16 rounded-lg object-cover border border-gray-600 flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <input id={id} type="file" accept={accept} disabled={disabled}
               onChange={(e) => onPick(e.target.files?.[0] || null)}
               className="w-full text-xs text-gray-400 file:mr-2 file:py-1.5 file:px-3 file:rounded-full file:border-0 file:text-xs file:bg-gray-700 file:text-gray-200 hover:file:bg-gray-600 disabled:cursor-not-allowed" />
        {file && (
          <p className="text-[11px] text-gray-500 mt-1 truncate">
            {file.name} — {(file.size / 1024).toFixed(0)} KB
            <button type="button" onClick={() => onPick(null)} disabled={disabled}
                    className="ml-2 text-gray-500 hover:text-gray-300">remove</button>
          </p>
        )}
        {disabledNote
          ? <p className="text-[11px] text-gray-500 mt-1">{disabledNote}</p>
          : hint && <p className="text-[11px] text-gray-500 mt-1">{hint}</p>}
      </div>
    </div>
  </div>
);

const STATUS_TONE: Record<string, string> = {
  completed: 'text-google-blue',
  partially_completed: 'text-google-yellow',
  failed: 'text-google-red',
  cancelled: 'text-gray-500',
  awaiting_avatar: 'text-google-yellow',
  running: 'text-gray-200',
  created: 'text-gray-400',
};

/**
 * Batches this user has run.
 *
 * The console exists to let people walk away, so there has to be a way back:
 * reopening a batch shows live progress, and for a finished one it re-signs the
 * download links (they expire after an hour).
 */
const BatchList: React.FC<{
  jobs: AutopilotJobView[];
  activeId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
}> = ({ jobs, activeId, busy, onOpen }) => {
  if (!jobs.length) return null;
  return (
    <section className="bg-google-gray border border-gray-700 rounded-2xl p-5 mb-6">
      <h2 className="text-sm font-medium text-gray-200 mb-1">Your batches</h2>
      <p className="text-[11px] text-gray-500 mb-4">
        Batches keep running after you close this page. Open one to see progress or
        get fresh download links.
      </p>
      <ul className="divide-y divide-gray-700/60">
        {jobs.map((j) => {
          const isActive = j.id === activeId;
          return (
            <li key={j.id} className="py-2.5 flex items-center gap-3 flex-wrap">
              <span className="text-sm text-gray-200 flex-1 min-w-[8rem] truncate">
                {j.gameTitle || 'Untitled'}
                {isActive && <span className="ml-2 text-[10px] text-google-blue">open</span>}
              </span>
              <span className={`text-xs w-40 ${STATUS_TONE[j.status] || 'text-gray-400'}`}>
                {STATUS_LABEL[j.status] || j.status}
              </span>
              <span className="text-xs text-gray-500 w-24">
                {j.doneCount}/{j.variantCount} ready
              </span>
              <span className="text-xs text-gray-500 w-20">{relativeTime(j.updatedAt)}</span>
              <button
                type="button"
                disabled={busy || isActive}
                onClick={() => onOpen(j.id)}
                className="text-xs text-google-blue hover:underline disabled:opacity-40 disabled:no-underline"
              >
                {isActive ? '—' : 'Open'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

const Bar: React.FC<{ value: number; total: number }> = ({ value, total }) => {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden" role="progressbar"
         aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-google-blue transition-all duration-500" style={{ width: `${pct}%` }} />
    </div>
  );
};

const Autopilot: React.FC = () => {
  const [config, setConfig] = useState<AutopilotConfig | null>(null);
  const [configChecked, setConfigChecked] = useState(false);

  // brief — one object so the IME-safe inputs can share a single commit handler
  const [brief, setBrief] = useState({
    gameTitle: '',
    gameUrl: '',
    callToAction: '',
    gamingDevice: '',
    dialoguePacing: '',
    extraInstructions: '',
    avatarPrompt: '',
  });
  const commitField = useCallback((name: string, value: string) => {
    setBrief((prev) => (prev[name as keyof typeof prev] === value ? prev : { ...prev, [name]: value }));
  }, []);
  const [targetRatio, setTargetRatio] = useState<TargetAspectRatio>('16:9');
  const [layoutType, setLayoutType] = useState<LayoutType>('classic-pip');
  const [pipPlacement, setPipPlacement] = useState<PipPlacement>('bottom-left');
  const [stackedPlacement, setStackedPlacement] = useState<StackedPlacement>('left');
  const [subtitles, setSubtitles] = useState(false);
  const [searchGrounding, setSearchGrounding] = useState(false);
  const [variantCount, setVariantCount] = useState(3);
  const [gameplayFile, setGameplayFile] = useState<File | null>(null);
  // Two optional images, both uploaded rather than referenced by URI:
  //   reference — pins the streamer's look while it is generated
  //   streamer  — a finished streamer, which skips generation altogether
  const [refFile, setRefFile] = useState<File | null>(null);
  const [refPreview, setRefPreview] = useState<string | null>(null);
  const [ownFile, setOwnFile] = useState<File | null>(null);
  const [ownPreview, setOwnPreview] = useState<string | null>(null);
  const [gateRefFile, setGateRefFile] = useState<File | null>(null);
  const gateRefInput = useRef<HTMLInputElement>(null);

  // job
  const [job, setJob] = useState<AutopilotJobView | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [regenPrompt, setRegenPrompt] = useState('');
  const [jobs, setJobs] = useState<AutopilotJobView[]>([]);
  const [restoring, setRestoring] = useState(true);
  const commitRegen = useCallback((_n: string, v: string) => setRegenPrompt(v), []);
  const ownAvatarInput = useRef<HTMLInputElement>(null);

  // Object URLs have to be revoked or the blob leaks for the page's lifetime.
  useEffect(() => {
    if (!refFile) { setRefPreview(null); return undefined; }
    const url = URL.createObjectURL(refFile);
    setRefPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [refFile]);

  useEffect(() => {
    if (!ownFile) { setOwnPreview(null); return undefined; }
    const url = URL.createObjectURL(ownFile);
    setOwnPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [ownFile]);

  const refreshJobs = useCallback(async () => {
    try {
      setJobs(await listJobs());
    } catch { /* the list is a convenience; failing to load it is not fatal */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let cfg: AutopilotConfig | null = null;
      try { cfg = await fetchAutopilotConfig(); } catch { cfg = null; }
      if (cancelled) return;
      setConfig(cfg);
      setConfigChecked(true);
      if (!cfg) { setRestoring(false); return; }

      // Reopen whatever this browser was last looking at, then fall back to the
      // newest batch that is still running so an interrupted run is never lost.
      let list: AutopilotJobView[] = [];
      try { list = await listJobs(); } catch { list = []; }
      if (cancelled) return;
      setJobs(list);

      const remembered = readLastJobId();
      const target = list.find((j) => j.id === remembered)
        || list.find((j) => !isTerminalStatus(j.status))
        || null;
      if (target) {
        setJob(target);
        setJobId(target.id);
      } else if (remembered) {
        writeLastJobId(null);
      }
      setRestoring(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // A stacked layout needs the streamer in the opposite orientation, so the
  // placement options change with the aspect ratio.
  useEffect(() => {
    setStackedPlacement((prev) => (targetRatio === '9:16'
      ? (prev === 'top' || prev === 'bottom' ? prev : 'top')
      : (prev === 'left' || prev === 'right' ? prev : 'left')));
  }, [targetRatio]);

  useEffect(() => { writeLastJobId(jobId); }, [jobId]);

  // Poll while the job is live. The GET also nudges the server-side pipeline, so
  // an instance with no background CPU still makes progress while this is open.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const fresh = await getJob(jobId);
        if (cancelled) return;
        setJob(fresh);
        if (!isTerminalStatus(fresh.status)) timer = window.setTimeout(poll, POLL_MS);
        else refreshJobs();
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Lost contact with the job');
          timer = window.setTimeout(poll, POLL_MS * 2);
        }
      }
    };
    poll();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [jobId, refreshJobs]);

  const needsGameplay = layoutType !== 'streamer-only';
  const imageAccept = (config?.allowedImageTypes || ['image/png', 'image/jpeg', 'image/webp']).join(',');
  // Grounding has nothing to search without a store page, so the toggle follows it.
  const groundingAvailable = brief.gameUrl.trim().length > 0;
  const estimatedClips = variantCount * 4;

  // A streamer has to come from somewhere: either a description to generate from,
  // or a finished image the user supplies.
  const hasStreamerSource = brief.avatarPrompt.trim().length > 0 || !!ownFile;
  const formValid = useMemo(() => (
    brief.gameTitle.trim().length > 0
    && hasStreamerSource
    && (!needsGameplay || !!gameplayFile)
    && variantCount >= 1
    && (!config || variantCount <= config.maxBatch)
  ), [brief.gameTitle, hasStreamerSource, needsGameplay, gameplayFile, variantCount, config]);

  const submit = useCallback(async () => {
    setError(null);
    setBusy('Preparing');
    setUploadPct(0);
    try {
      let gameplayGcsUri: string | null = null;
      if (needsGameplay && gameplayFile) {
        setBusy('Uploading gameplay');
        gameplayGcsUri = await uploadGameplay(gameplayFile, setUploadPct);
      }

      let avatarRefGcsUri: string | null = null;
      let avatarImageGcsUri: string | null = null;
      if (ownFile) {
        setBusy('Uploading your streamer image');
        avatarImageGcsUri = await uploadImage(ownFile, 'streamer');
      } else if (refFile) {
        setBusy('Uploading the reference image');
        avatarRefGcsUri = await uploadImage(refFile, 'reference');
      }

      setBusy(ownFile ? 'Preparing' : 'Generating the streamer');
      const created = await createJob({
        gameTitle: brief.gameTitle.trim(),
        gameUrl: brief.gameUrl.trim(),
        callToAction: brief.callToAction.trim(),
        gamingDevice: brief.gamingDevice.trim(),
        dialoguePacing: brief.dialoguePacing.trim(),
        extraInstructions: brief.extraInstructions.trim(),
        targetRatio,
        layoutType,
        pipPlacement,
        stackedPlacement,
        subtitles,
        searchGrounding: searchGrounding && groundingAvailable,
        variantCount,
        gameplayGcsUri,
        avatarPrompt: brief.avatarPrompt.trim(),
        avatarRefGcsUri,
        avatarImageGcsUri,
      });
      setJob(created);
      setJobId(created.jobId || created.id);
      refreshJobs();
    } catch (err: any) {
      setError(err.message || 'Could not start the batch');
    } finally {
      setBusy(null);
    }
  }, [
    needsGameplay, gameplayFile, refFile, ownFile, brief, targetRatio, layoutType,
    pipPlacement, stackedPlacement, subtitles, searchGrounding, groundingAvailable,
    variantCount, refreshJobs,
  ]);

  const act = useCallback(async (label: string, fn: () => Promise<AutopilotJobView>) => {
    setError(null);
    setBusy(label);
    try {
      setJob(await fn());
    } catch (err: any) {
      setError(err.message || `${label} failed`);
    } finally {
      setBusy(null);
    }
  }, []);

  const onPickOwnAvatar = useCallback(async (file: File) => {
    if (!jobId) return;
    await act('Uploading your image', async () => {
      const gcsUri = await uploadOwnAvatar(jobId, file);
      return useUploadedAvatar(jobId, gcsUri);
    });
  }, [jobId, act]);

  const openJob = useCallback(async (id: string) => {
    setError(null);
    setBusy('Opening');
    try {
      // Re-fetching also re-signs the download links, which expire after an hour.
      const fresh = await getJob(id);
      setJob(fresh);
      setJobId(id);
    } catch (err: any) {
      setError(err.message || 'Could not open that batch');
    } finally {
      setBusy(null);
    }
  }, []);

  /** Back to a blank brief. The batch itself is untouched and stays in the list. */
  const reset = useCallback(() => {
    setJob(null);
    setJobId(null);
    setError(null);
    setUploadPct(0);
    setRegenPrompt('');
    setGateRefFile(null);
    setRefFile(null);
    setOwnFile(null);
    refreshJobs();
  }, [refreshJobs]);

  if (!configChecked || (config && restoring)) {
    return (
      <div className="max-w-4xl mx-auto py-16 text-center text-gray-500 text-sm">
        {configChecked ? 'Looking for batches you left running…' : 'Checking availability…'}
      </div>
    );
  }

  if (!config) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <h2 className="text-lg text-gray-200 mb-2">Autopilot is not enabled</h2>
        <p className="text-sm text-gray-400">
          Batch production is switched off for this deployment. Enable it with{' '}
          <code className="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded">./deploy.sh</code> → mode 4.
        </p>
      </div>
    );
  }

  const awaiting = job?.status === 'awaiting_avatar';
  const running = job?.status === 'running';
  const finished = job ? isTerminalStatus(job.status) : false;
  const candidateUrl = job?.avatarCandidateUrls?.[0] || null;
  const maxMb = Math.round(config.uploadMaxBytes / 1048576);

  return (
    <div className="max-w-4xl mx-auto w-full animate-fade-in pb-16">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-light text-gray-100">Autopilot</h1>
          <p className="text-sm text-gray-400 mt-1">
            Fill this in once, confirm the streamer, and collect the finished videos.
            Script, shot list, clips and compositing all run unattended.
          </p>
        </div>
        {job && (
          <NeonButton variant="secondary" onClick={reset} disabled={!!busy}>
            New batch
          </NeonButton>
        )}
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-google-red/10 border border-google-red/40 text-sm text-google-red" role="alert">
          {error}
        </div>
      )}

      <BatchList jobs={jobs} activeId={jobId} busy={!!busy} onOpen={openJob} />

      {/* ── 1. brief ─────────────────────────────────────────────────── */}
      {!job && (
        <Section step="1" title="The brief" hint="Everything the pipeline needs. You will not be asked again.">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field name="gameTitle" label="Game title" value={brief.gameTitle} onCommit={commitField}
                   placeholder="Blockfall" required disabled={!!busy} />
            <Field name="gameUrl" label="Store page URL" value={brief.gameUrl} onCommit={commitField}
                   inputMode="url" disabled={!!busy}
                   placeholder="https://store.steampowered.com/app/123456/Your_Game/"
                   hint="The game's official store or product page. Needed if you want the script grounded in real facts." />
            <Field name="callToAction" label="Call to action" value={brief.callToAction} onCommit={commitField}
                   placeholder="Play free now" disabled={!!busy} />
            <Field name="gamingDevice" label="Device / platform" value={brief.gamingDevice} onCommit={commitField}
                   placeholder="PC, Switch, mobile…" disabled={!!busy} />
            <Field name="dialoguePacing" label="Dialogue pacing" value={brief.dialoguePacing} onCommit={commitField}
                   placeholder="Punchy, fast" disabled={!!busy} />
            <div className="md:col-span-2">
              <Field name="extraInstructions" label="Extra direction (optional)" multiline
                     value={brief.extraInstructions} onCommit={commitField} disabled={!!busy}
                     placeholder="Anything the script should mention or avoid" />
            </div>
            <div className="md:col-span-2">
              <Field name="avatarPrompt" label="Streamer appearance and background"
                     multiline required={!ownFile}
                     value={brief.avatarPrompt} onCommit={commitField} disabled={!!busy || !!ownFile}
                     placeholder="An energetic streamer with headphones in a neon-lit room"
                     hint={ownFile
                       ? 'Ignored while you are supplying your own streamer image.'
                       : 'This is what gets rendered next for your confirmation.'} />
            </div>
          </div>

          {/* Two optional images. Both are uploaded — the API never asks the user
              for a storage URI. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
            <ImagePicker
              id="ap-ref"
              label="Reference image (optional)"
              hint="Pins the streamer's look. Generation follows this face or character instead of inventing one."
              file={refFile}
              preview={refPreview}
              accept={imageAccept}
              disabled={!!busy || !!ownFile}
              disabledNote={ownFile ? 'Not needed — you are supplying the streamer directly.' : undefined}
              onPick={setRefFile}
            />
            <ImagePicker
              id="ap-own"
              label="Or use my own streamer image (optional)"
              hint="Skips generation entirely. You will still confirm it before any video is produced."
              file={ownFile}
              preview={ownPreview}
              accept={imageAccept}
              disabled={!!busy}
              onPick={(f) => { setOwnFile(f); if (f) setRefFile(null); }}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
            <div>
              <label htmlFor="ap-ratio" className="block text-xs text-gray-400 mb-1.5">Aspect ratio</label>
              <select id="ap-ratio" value={targetRatio}
                      onChange={(e) => setTargetRatio(e.target.value as TargetAspectRatio)}
                      className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200">
                <option value="16:9">16:9 landscape</option>
                <option value="9:16">9:16 portrait</option>
              </select>
            </div>
            <div>
              <label htmlFor="ap-layout" className="block text-xs text-gray-400 mb-1.5">Layout</label>
              <select id="ap-layout" value={layoutType}
                      onChange={(e) => setLayoutType(e.target.value as LayoutType)}
                      className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200">
                <option value="classic-pip">Picture in picture</option>
                <option value="stacked">Stacked</option>
                <option value="streamer-only">Streamer only</option>
              </select>
            </div>
            <div>
              {layoutType === 'classic-pip' && (
                <>
                  <label htmlFor="ap-pip" className="block text-xs text-gray-400 mb-1.5">Streamer corner</label>
                  <select id="ap-pip" value={pipPlacement}
                          onChange={(e) => setPipPlacement(e.target.value as PipPlacement)}
                          className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200">
                    <option value="bottom-left">Bottom left</option>
                    <option value="bottom-right">Bottom right</option>
                    <option value="top-left">Top left</option>
                    <option value="top-right">Top right</option>
                  </select>
                </>
              )}
              {layoutType === 'stacked' && (
                <>
                  <label htmlFor="ap-stack" className="block text-xs text-gray-400 mb-1.5">Streamer position</label>
                  <select id="ap-stack" value={stackedPlacement}
                          onChange={(e) => setStackedPlacement(e.target.value as StackedPlacement)}
                          className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200">
                    {targetRatio === '9:16'
                      ? [<option key="t" value="top">Top</option>, <option key="b" value="bottom">Bottom</option>]
                      : [<option key="l" value="left">Left</option>, <option key="r" value="right">Right</option>]}
                  </select>
                </>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6 items-end">
            <div>
              <label htmlFor="ap-count" className="block text-xs text-gray-400 mb-1.5">
                How many videos ({config.maxBatch} max)
              </label>
              <input id="ap-count" type="number" min={1} max={config.maxBatch} value={variantCount}
                     onChange={(e) => setVariantCount(Math.max(1, Math.min(config.maxBatch, Number(e.target.value) || 1)))}
                     className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200" />
              <p className="text-[11px] text-gray-500 mt-1.5">
                Each gets its own script and angle; they share the streamer you confirm next.
              </p>
            </div>
            <div className="flex flex-col gap-3 pb-1">
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)}
                       className="w-4 h-4 accent-google-blue" />
                Burn in subtitles
              </label>
              <label className={`flex items-start gap-2 text-sm ${groundingAvailable ? 'text-gray-300' : 'text-gray-500'}`}>
                <input type="checkbox" checked={searchGrounding && groundingAvailable}
                       disabled={!groundingAvailable}
                       onChange={(e) => setSearchGrounding(e.target.checked)}
                       className="w-4 h-4 accent-google-blue mt-0.5" />
                <span>
                  Look the game up with Google Search
                  <span className="block text-[11px] text-gray-500">
                    {groundingAvailable
                      ? 'Scripts cite real mechanics and features instead of guessing. Adds a few seconds per variant.'
                      : 'Add the store page URL above to enable this.'}
                  </span>
                </span>
              </label>
            </div>
          </div>

          {needsGameplay && (
            <div className="mt-6">
              <label htmlFor="ap-file" className="block text-xs text-gray-400 mb-1.5">
                Gameplay footage (up to {maxMb} MB)
              </label>
              <input id="ap-file" type="file" accept={config.allowedGameplayTypes.join(',')}
                     onChange={(e) => setGameplayFile(e.target.files?.[0] || null)}
                     className="w-full text-sm text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:bg-gray-700 file:text-gray-200 hover:file:bg-gray-600" />
              {gameplayFile && (
                <p className="text-[11px] text-gray-500 mt-1.5">
                  {gameplayFile.name} — {(gameplayFile.size / 1048576).toFixed(1)} MB.
                  Uploaded straight to storage, not through the app.
                </p>
              )}
            </div>
          )}

          {busy === 'Uploading gameplay' && (
            <div className="mt-4">
              <p className="text-xs text-gray-400 mb-1.5">Uploading… {Math.round(uploadPct * 100)}%</p>
              <Bar value={uploadPct * 100} total={100} />
            </div>
          )}

          <div className="mt-8 flex items-center gap-4">
            <NeonButton onClick={submit} disabled={!formValid || !!busy} isLoading={!!busy}>
              Generate the streamer
            </NeonButton>
            <p className="text-xs text-gray-500">
              Nothing is rendered yet beyond one streamer image — you confirm it before any video is produced.
            </p>
          </div>
        </Section>
      )}

      {/* ── 2. the confirmation gate ──────────────────────────────────── */}
      {job && (awaiting || job.status === 'created') && (
        <Section step="2" title="Confirm your streamer"
                 hint="This is the one step that needs you. The same streamer appears in every video, and regenerating never returns the same person — so it is settled before anything is spent.">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden flex items-center justify-center min-h-[240px]">
              {candidateUrl
                ? <img src={candidateUrl} alt="Generated streamer" className="w-full h-auto" />
                : <p className="text-sm text-gray-500 p-6 text-center">
                    {job.error || 'No image yet — try regenerating.'}
                  </p>}
            </div>

            <div className="flex flex-col">
              <Field name="regenPrompt" label="Adjust the description and try again" multiline rows={3}
                     value={regenPrompt} onCommit={commitRegen} disabled={!!busy}
                     placeholder="Leave blank to reuse the description you gave" />
              <div className="mt-3">
                <button type="button" disabled={!!busy}
                        onClick={() => gateRefInput.current?.click()}
                        className="text-xs text-google-blue hover:underline disabled:opacity-50">
                  {gateRefFile ? `Reference: ${gateRefFile.name} (change)` : 'Attach a reference image'}
                </button>
                {gateRefFile && (
                  <button type="button" disabled={!!busy} onClick={() => setGateRefFile(null)}
                          className="text-xs text-gray-500 hover:text-gray-300 ml-3">
                    remove
                  </button>
                )}
                <input id="ap-gate-ref" ref={gateRefInput} type="file" accept={imageAccept}
                       className="hidden" aria-hidden="true"
                       onChange={(e) => { setGateRefFile(e.target.files?.[0] || null); e.target.value = ''; }} />
                <p className="text-[11px] text-gray-500 mt-1">
                  A reference image makes the next attempt follow that look instead of inventing a new person.
                </p>
              </div>

              <div className="flex flex-wrap gap-3 mt-4">
                <NeonButton variant="secondary" disabled={!!busy}
                            onClick={() => act('Regenerating', async () => {
                              const refUri = gateRefFile ? await uploadImage(gateRefFile, 'reference') : undefined;
                              return regenerateAvatar(jobId!, {
                                avatarPrompt: regenPrompt.trim() || undefined,
                                ...(refUri ? { avatarRefGcsUri: refUri } : {}),
                              });
                            })}>
                  Regenerate
                </NeonButton>
                <NeonButton variant="secondary" disabled={!!busy}
                            onClick={() => ownAvatarInput.current?.click()}>
                  Upload my own
                </NeonButton>
                <input id="ap-gate-own" ref={ownAvatarInput} type="file" accept={imageAccept}
                       className="hidden" aria-hidden="true"
                       onChange={(e) => {
                         const f = e.target.files?.[0];
                         if (f) onPickOwnAvatar(f);
                         e.target.value = '';
                       }} />
              </div>

              <p className="text-[11px] text-gray-500 mt-3">
                Regenerated {job.avatar.regenCount} time{job.avatar.regenCount === 1 ? '' : 's'}.
                Images are cheap — videos are not, so take your time here.
              </p>

              <div className="mt-auto pt-6">
                <div className="p-3 rounded-lg bg-gray-800/60 border border-gray-700 mb-4">
                  <p className="text-xs text-gray-300">
                    Confirming starts <strong className="text-gray-100">{job.variantCount} video{job.variantCount === 1 ? '' : 's'}</strong>,
                    roughly <strong className="text-gray-100">{job.costPreview?.estimatedClips ?? estimatedClips} clip generations</strong>.
                  </p>
                  {job.costPreview?.veoSafetyNet && (
                    <p className="text-[11px] text-gray-500 mt-1">
                      Up to {job.costPreview.veoBudget} may fall back to Veo (pay-as-you-go) if a clip is safety-blocked.
                    </p>
                  )}
                </div>
                <div className="flex gap-3">
                  <NeonButton disabled={!!busy || !candidateUrl} isLoading={busy === 'Starting'}
                              onClick={() => act('Starting', () => approveAvatar(jobId!, [0]))}>
                    Confirm and produce {job.variantCount} video{job.variantCount === 1 ? '' : 's'}
                  </NeonButton>
                  <NeonButton variant="danger" disabled={!!busy}
                              onClick={() => act('Cancelling', () => cancelJob(jobId!))}>
                    Cancel
                  </NeonButton>
                </div>
              </div>
            </div>
          </div>
        </Section>
      )}

      {/* ── 3. progress ──────────────────────────────────────────────── */}
      {job && (running || finished) && (
        <Section step="3" title={STATUS_LABEL[job.status] || job.status}
                 hint={running
                   ? 'Running server-side — you can close this tab and come back.'
                   : undefined}>
          <div className="mb-5">
            <div className="flex justify-between text-xs text-gray-400 mb-2">
              <span>{job.doneCount} of {job.variantCount} ready{job.failedCount ? ` · ${job.failedCount} failed` : ''}</span>
              <span>{job.clipProgress.ready}/{job.clipProgress.total} clips</span>
            </div>
            <Bar value={job.clipProgress.ready} total={job.clipProgress.total} />
          </div>

          <ul className="divide-y divide-gray-700/60">
            {job.variants.map((v) => (
              <li key={v.idx} className="py-3 flex items-center gap-4">
                <span className="text-xs text-gray-500 w-16 flex-shrink-0">Video {v.idx + 1}</span>
                <span className={`text-sm flex-shrink-0 w-32 ${
                  v.stage === 'done' ? 'text-google-blue'
                    : v.stage === 'failed' ? 'text-google-red' : 'text-gray-300'
                }`}>
                  {STAGE_LABEL[v.stage] || v.stage}
                </span>
                <span className="text-xs text-gray-500 flex-shrink-0 w-20">
                  {v.shots > 0 ? `${v.clipsReady}/${v.shots}` : '—'}
                </span>
                <span className="text-xs text-gray-500 truncate flex-1" title={v.error || undefined}>
                  {v.error || ''}
                </span>
              </li>
            ))}
          </ul>

          {job.veo.used > 0 && (
            <p className="text-[11px] text-gray-500 mt-4">
              {job.veo.used} of {job.veo.budget} Veo fallbacks used.
            </p>
          )}

          {running && (
            <div className="mt-6">
              <NeonButton variant="danger" disabled={!!busy}
                          onClick={() => act('Cancelling', () => cancelJob(jobId!))}>
                Stop this batch
              </NeonButton>
            </div>
          )}
        </Section>
      )}

      {/* ── 4. results ───────────────────────────────────────────────── */}
      {job && (job.outputs?.length || 0) > 0 && (
        <Section step="4" title="Your videos"
                 hint="Links stay valid for an hour; reload this page to refresh them.">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {job.outputs!.map((o) => (
              <div key={o.idx} className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
                <video src={o.url} controls preload="metadata" className="w-full bg-black" />
                <div className="p-3 flex items-center justify-between gap-3">
                  <span className="text-xs text-gray-400">Video {o.idx + 1}</span>
                  <a href={o.url} download={o.downloadName || `video-${o.idx + 1}.mp4`}
                     className="text-xs text-google-blue hover:underline">
                    Download
                  </a>
                </div>
              </div>
            ))}
          </div>

          {finished && (
            <div className="mt-8 flex items-center gap-4">
              <NeonButton variant="secondary" onClick={reset}>Start another batch</NeonButton>
              {job.status === 'partially_completed' && (
                <p className="text-xs text-gray-500">
                  {job.failedCount} video{job.failedCount === 1 ? '' : 's'} could not be produced.
                  The ones above are unaffected.
                </p>
              )}
            </div>
          )}
        </Section>
      )}

      {job && finished && (job.outputs?.length || 0) === 0 && (
        <Section step="4" title="Nothing was produced">
          <p className="text-sm text-gray-400 mb-6">
            {job.error || 'Every video failed. The per-video reasons are listed above.'}
          </p>
          <NeonButton variant="secondary" onClick={reset}>Try again</NeonButton>
        </Section>
      )}
    </div>
  );
};

export default Autopilot;
