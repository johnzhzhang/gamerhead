// Project history — persists a working session server-side so that a lost
// login, a closed tab, or a new browser does not mean re-entering the game
// title / store URL / CTA and regenerating everything.

import { apiFetch } from './auth';
import { ProjectPayload, ProjectSummary, CurrentUserInfo, GameInfo, AvatarConfig } from '../types';

const json = async (res: Response) => {
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
    }
    return res.json();
};

export const fetchCurrentUser = async (): Promise<CurrentUserInfo> =>
    json(await apiFetch('/api/me'));

export const listProjects = async (): Promise<ProjectSummary[]> => {
    const data = await json(await apiFetch('/api/projects'));
    return data.projects || [];
};

export const loadProject = async (id: string): Promise<ProjectPayload> =>
    json(await apiFetch(`/api/projects/${encodeURIComponent(id)}`));

export const saveProject = async (
    payload: ProjectPayload
): Promise<{ id: string; updatedAt: number; createdAt: number }> =>
    json(await apiFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }));

export const deleteProject = async (id: string): Promise<void> => {
    await json(await apiFetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }));
};

/** Signed URL for previewing a stored export (app bucket only, 1 hour). */
export const getExportPreviewUrl = async (gcsUri: string): Promise<string> => {
    const data = await json(await apiFetch(`/api/media/export-url?uri=${encodeURIComponent(gcsUri)}`));
    return data.url;
};

/**
 * `File` objects cannot be serialised, so the uploaded gameplay video is never
 * part of a saved project. Everything else in the form is.
 */
export const stripGameInfo = (form: GameInfo): Omit<GameInfo, 'videoFile'> => {
    const { videoFile, ...rest } = form;
    return rest;
};

/**
 * `referenceImage` is an inline base64 image — megabytes in the worst case, and
 * over Datastore's 1500-byte indexed-property limit in every case. Drop it
 * before saving instead of re-uploading it on every autosave tick.
 */
export const stripAvatarConfig = (config: AvatarConfig | null): AvatarConfig | null => {
    if (!config) return null;
    const { referenceImage, ...rest } = config;
    return rest as AvatarConfig;
};

/** Human-friendly default name for a new project. */
export const deriveProjectName = (form: GameInfo): string => {
    const title = (form.title || '').trim();
    if (title) return title.slice(0, 120);
    return `Untitled — ${new Date().toLocaleDateString()}`;
};
