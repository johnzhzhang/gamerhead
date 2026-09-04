/**
 * Autopilot client — typed wrappers over /api/autopilot/*.
 *
 * The gameplay file is the one thing that does not go through the app: it is PUT
 * straight to Cloud Storage with a signed URL, because Cloud Run caps an HTTP/1
 * request body at 32 MiB and the UI accepts gameplay up to 250 MB.
 */

import { apiFetch } from './auth';
import type { LayoutType, TargetAspectRatio } from '../types';

export type AutopilotStage = 'pending' | 'script' | 'clips' | 'compose' | 'done' | 'failed';

export type AutopilotStatus =
  | 'created'
  | 'awaiting_avatar'
  | 'running'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'cancelled';

export interface AutopilotConfig {
  maxBatch: number;
  maxClipsPerJob: number;
  uploadMaxBytes: number;
  allowedGameplayTypes: string[];
  imageUploadMaxBytes?: number;
  allowedImageTypes?: string[];
  veoSafetyNet: boolean;
}

export interface AutopilotVariantView {
  idx: number;
  stage: AutopilotStage;
  shots: number;
  clipsReady: number;
  error: string | null;
  hasOutput: boolean;
}

export interface AutopilotOutput {
  idx: number;
  url: string;
  downloadName: string | null;
}

export interface AutopilotJobView {
  id: string;
  status: AutopilotStatus;
  createdAt: string;
  updatedAt: string;
  /** Enough to recognise a batch in the list; ids alone are unusable. */
  gameTitle: string;
  layoutType: string | null;
  targetRatio: string | null;
  awaitingApproval: boolean;
  variantCount: number;
  doneCount: number;
  failedCount: number;
  clipProgress: { ready: number; total: number };
  veo: { used: number; budget: number };
  error: string | null;
  avatar: {
    source: 'generated' | 'uploaded' | null;
    regenCount: number;
    approvedIdx: number[];
    candidateCount: number;
  };
  variants: AutopilotVariantView[];
  avatarCandidateUrls?: (string | null)[];
  outputs?: AutopilotOutput[];
  costPreview?: {
    estimatedClips: number;
    veoBudget: number;
    veoSafetyNet: boolean;
  };
  jobId?: string;
}

export interface AutopilotSubmitSpec {
  gameTitle: string;
  gameUrl?: string;
  callToAction?: string;
  gamingDevice?: string;
  dialoguePacing?: string;
  extraInstructions?: string;
  targetRatio: TargetAspectRatio;
  layoutType: LayoutType;
  pipPlacement?: string;
  stackedPlacement?: string;
  subtitles?: boolean;
  /** Look the game up with Google Search; needs gameUrl to be set. */
  searchGrounding?: boolean;
  variantCount: number;
  gameplayGcsUri?: string | null;
  avatarPrompt: string;
  avatarRefGcsUri?: string | null;
  /** Supply a finished streamer image instead of generating one. */
  avatarImageGcsUri?: string | null;
  volumes?: { gameplay: number; streamer: number };
}

const json = async (res: Response) => {
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
};

/** Autopilot is opt-in; when the server has it off every route 404s. */
export const fetchAutopilotConfig = async (): Promise<AutopilotConfig | null> => {
  const res = await apiFetch('/api/autopilot/config');
  if (res.status === 404) return null;
  return json(res);
};

/**
 * Upload gameplay footage directly to Cloud Storage.
 *
 * `onProgress` reports 0..1. XMLHttpRequest is used rather than fetch because it
 * is the only way to observe upload progress in the browser.
 */
export const uploadGameplay = async (
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<string> => {
  const { uploadUrl, gcsUri, requiredHeaders } = await json(
    await apiFetch('/api/autopilot/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: file.type || 'video/mp4', sizeBytes: file.size }),
    }),
  );

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    Object.entries(requiredHeaders || {}).forEach(([k, v]) => xhr.setRequestHeader(k, String(v)));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve()
      : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error(
      'Upload failed. If this persists the bucket may be missing its CORS rule '
      + '(deploy.sh → mode 4 configures it).',
    ));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(file);
  });

  if (onProgress) onProgress(1);
  return gcsUri as string;
};

/**
 * Upload an image before any job exists.
 *
 * `kind: 'reference'` pins the streamer's look for generation; `kind: 'streamer'`
 * supplies a finished streamer and skips generation entirely. Both need a real
 * upload path — a caller cannot be expected to produce a gs:// URI by hand.
 */
export const uploadImage = async (
  file: File,
  kind: 'reference' | 'streamer',
): Promise<string> => {
  const { uploadUrl, gcsUri, requiredHeaders } = await json(
    await apiFetch('/api/autopilot/image-upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: file.type || 'image/png', sizeBytes: file.size, kind }),
    }),
  );
  const res = await fetch(uploadUrl, { method: 'PUT', headers: requiredHeaders || {}, body: file });
  if (!res.ok) throw new Error(`Image upload failed (${res.status})`);
  return gcsUri as string;
};

/** Upload a streamer image the user supplies instead of generating one. */
export const uploadOwnAvatar = async (jobId: string, file: File): Promise<string> => {
  const { uploadUrl, gcsUri, requiredHeaders } = await json(
    await apiFetch(`/api/autopilot/jobs/${jobId}/avatar/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: file.type || 'image/png' }),
    }),
  );
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: requiredHeaders || {},
    body: file,
  });
  if (!res.ok) throw new Error(`Avatar upload failed (${res.status})`);
  return gcsUri as string;
};

export const createJob = async (spec: AutopilotSubmitSpec): Promise<AutopilotJobView> =>
  json(await apiFetch('/api/autopilot/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  }));

export const getJob = async (jobId: string): Promise<AutopilotJobView> =>
  json(await apiFetch(`/api/autopilot/jobs/${jobId}`));

export const listJobs = async (): Promise<AutopilotJobView[]> => {
  const data = await json(await apiFetch('/api/autopilot/jobs'));
  return data?.jobs || [];
};

export const regenerateAvatar = async (
  jobId: string,
  body: { avatarPrompt?: string; avatarRefGcsUri?: string | null },
): Promise<AutopilotJobView> =>
  json(await apiFetch(`/api/autopilot/jobs/${jobId}/avatar/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

export const useUploadedAvatar = async (jobId: string, gcsUri: string): Promise<AutopilotJobView> =>
  json(await apiFetch(`/api/autopilot/jobs/${jobId}/avatar/use-uploaded`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gcsUri }),
  }));

/** Cross the confirmation gate. Everything expensive happens after this call. */
export const approveAvatar = async (jobId: string, selected: number[] = [0]): Promise<AutopilotJobView> =>
  json(await apiFetch(`/api/autopilot/jobs/${jobId}/avatar/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selected }),
  }));

export const cancelJob = async (jobId: string): Promise<AutopilotJobView> =>
  json(await apiFetch(`/api/autopilot/jobs/${jobId}/cancel`, { method: 'POST' }));

export const TERMINAL_STATUSES: AutopilotStatus[] = [
  'completed', 'partially_completed', 'failed', 'cancelled',
];

export const isTerminalStatus = (s: AutopilotStatus) => TERMINAL_STATUSES.includes(s);
