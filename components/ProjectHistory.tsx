import React, { useCallback, useEffect, useState } from 'react';
import { ProjectSummary } from '../types';
import { listProjects, deleteProject } from '../services/projects';

interface ProjectHistoryProps {
    open: boolean;
    onClose: () => void;
    /** Id of the project currently loaded in the editor, if any. */
    currentProjectId: string | null;
    onLoad: (id: string) => Promise<void> | void;
}

const formatWhen = (ts: number | null): string => {
    if (!ts) return '—';
    const d = new Date(ts);
    const diffMin = Math.floor((Date.now() - ts) / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin} min ago`;
    if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)} h ago`;
    return d.toLocaleDateString();
};

const ProjectHistory: React.FC<ProjectHistoryProps> = ({ open, onClose, currentProjectId, onLoad }) => {
    const [projects, setProjects] = useState<ProjectSummary[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setProjects(await listProjects());
        } catch (e: any) {
            setError(e.message || 'Failed to load history.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (open) refresh();
    }, [open, refresh]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const handleLoad = async (id: string) => {
        setBusyId(id);
        setError(null);
        try {
            await onLoad(id);
            onClose();
        } catch (e: any) {
            setError(e.message || 'Failed to open project.');
        } finally {
            setBusyId(null);
        }
    };

    const handleDelete = async (id: string, name: string) => {
        if (!window.confirm(`Delete "${name}"? Generated videos already in cloud storage are kept, but this project entry is removed.`)) return;
        setBusyId(id);
        setError(null);
        try {
            await deleteProject(id);
            setProjects(prev => prev.filter(p => p.id !== id));
        } catch (e: any) {
            setError(e.message || 'Failed to delete project.');
        } finally {
            setBusyId(null);
        }
    };

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-history-title"
        >
            <div className="w-full max-w-3xl bg-[#1c1c1c] border border-gray-700 rounded-2xl shadow-2xl">
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
                    <div>
                        <h2 id="project-history-title" className="text-lg font-bold text-white">Project history</h2>
                        <p className="text-xs text-gray-500 mt-0.5">
                            Reopen a past project to reuse its title, store link, CTA and generated clips.
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-white px-3 py-1.5 rounded-lg border border-gray-700 hover:bg-gray-700 text-xs"
                    >
                        Close
                    </button>
                </div>

                <div className="p-4 sm:p-6">
                    {error && (
                        <div className="mb-4 text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-4 py-2">
                            {error}
                        </div>
                    )}

                    {loading && (
                        <div className="py-10 flex justify-center">
                            <div className="w-6 h-6 border-2 border-google-blue border-t-transparent rounded-full animate-spin" />
                        </div>
                    )}

                    {!loading && projects.length === 0 && !error && (
                        <p className="py-10 text-center text-sm text-gray-500">
                            No saved projects yet. Your work is saved automatically once you enter a game title.
                        </p>
                    )}

                    {!loading && projects.length > 0 && (
                        <ul className="flex flex-col gap-2">
                            {projects.map(p => (
                                <li
                                    key={p.id}
                                    className={`rounded-xl border px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 ${
                                        p.id === currentProjectId
                                            ? 'border-google-blue bg-blue-900/10'
                                            : 'border-gray-700 bg-[#232323]'
                                    }`}
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-bold text-white truncate">{p.name}</span>
                                            {p.id === currentProjectId && (
                                                <span className="text-[10px] font-bold text-google-blue border border-google-blue/50 rounded px-1.5 py-0.5">
                                                    OPEN
                                                </span>
                                            )}
                                        </div>
                                        {p.gameUrl && (
                                            <p className="text-[11px] text-gray-500 truncate mt-0.5">{p.gameUrl}</p>
                                        )}
                                        <p className="text-[11px] text-gray-500 mt-1 flex flex-wrap gap-x-3">
                                            <span>{formatWhen(p.updatedAt)}</span>
                                            {p.targetAspectRatio && <span>{p.targetAspectRatio}</span>}
                                            {p.hasScript && <span>script ✓</span>}
                                            <span>{p.segmentCount} clip{p.segmentCount === 1 ? '' : 's'}</span>
                                            <span>{p.exportCount} export{p.exportCount === 1 ? '' : 's'}</span>
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <button
                                            onClick={() => handleLoad(p.id)}
                                            disabled={busyId === p.id}
                                            className="text-xs font-bold text-white bg-google-blue/80 hover:bg-google-blue px-3 py-1.5 rounded-lg disabled:opacity-50"
                                        >
                                            {busyId === p.id ? 'Opening…' : 'Open'}
                                        </button>
                                        <button
                                            onClick={() => handleDelete(p.id, p.name)}
                                            disabled={busyId === p.id}
                                            className="text-xs text-gray-400 hover:text-red-400 px-2 py-1.5 rounded-lg border border-gray-700 hover:border-red-800 disabled:opacity-50"
                                            aria-label={`Delete ${p.name}`}
                                        >
                                            Delete
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ProjectHistory;
