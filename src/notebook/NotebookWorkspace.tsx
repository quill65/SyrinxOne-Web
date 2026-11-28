import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  FolderOpen,
  Loader2,
  MoreVertical,
  Pin,
  Play,
  PlayCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Tag,
  Trash2,
  Upload,
  Wrench,
} from 'lucide-react';
import { SimpleMarkdown } from './SimpleMarkdown';
import { captureActiveAcousticSnapshot } from './contextSnapshot';
import {
  commitProposedAnnotationsToWorkspace,
  fetchNotebookKernelStatus,
  interruptNotebookKernel,
  restartNotebookKernel,
  runNotebookAllCells,
  runNotebookAsScript,
  runNotebookCell,
} from './notebookRunner';
import { useNotebookStore } from './notebookStore';
import { startDetachedTabSyncClient, type SyncedAcousticContext } from './notebookSync';
import type { NotebookCell, NotebookCellKind, NotebookParameter, NotebookScope } from './types';

interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  reply: string;
  suggestedCells?: Array<{ kind: NotebookCellKind; title?: string; source: string }>;
}

interface CellFixSuggestion {
  cellId: string;
  reply: string;
  kind: NotebookCellKind;
  title?: string;
  source: string;
}

interface NotebookWorkspaceProps {
  onBackToSpectrogram: () => void;
  hideBackButton?: boolean;
  detached?: boolean;
}

type CompactPane = 'library' | 'cells' | 'copilot';

export const NotebookWorkspace: React.FC<NotebookWorkspaceProps> = ({
  onBackToSpectrogram,
  hideBackButton = false,
  detached = false,
}) => {
  const notebooks = useNotebookStore((s) => s.notebooks);
  const activeNotebookId = useNotebookStore((s) => s.activeNotebookId);
  const setActiveNotebook = useNotebookStore((s) => s.setActiveNotebook);
  const createNotebook = useNotebookStore((s) => s.createNotebook);
  const duplicateNotebook = useNotebookStore((s) => s.duplicateNotebook);
  const deleteNotebook = useNotebookStore((s) => s.deleteNotebook);
  const updateNotebookMeta = useNotebookStore((s) => s.updateNotebookMeta);
  const addCell = useNotebookStore((s) => s.addCell);
  const updateCell = useNotebookStore((s) => s.updateCell);
  const deleteCell = useNotebookStore((s) => s.deleteCell);
  const moveCell = useNotebookStore((s) => s.moveCell);
  const clearNotebookOutputs = useNotebookStore((s) => s.clearNotebookOutputs);
  const toggleProposedInCell = useNotebookStore((s) => s.toggleProposedAnnotationInCell);
  const setParamOverride = useNotebookStore((s) => s.setParamOverride);
  const getEffectiveParams = useNotebookStore((s) => s.getEffectiveParams);
  const importIpynb = useNotebookStore((s) => s.importIpynb);
  const exportIpynb = useNotebookStore((s) => s.exportIpynb);

  const [isCompact, setIsCompact] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 900 : false,
  );
  const [compactPane, setCompactPane] = useState<CompactPane>('cells');
  const [showLibraryDesktop, setShowLibraryDesktop] = useState(true);
  const [showCopilotDesktop, setShowCopilotDesktop] = useState(true);
  const [showNbActionsMenu, setShowNbActionsMenu] = useState(false);
  const [openCellMenuId, setOpenCellMenuId] = useState<string | null>(null);
  const [editingMarkdownIds, setEditingMarkdownIds] = useState<Record<string, boolean>>({});
  const [copilotInput, setCopilotInput] = useState('');
  const [copilotBusy, setCopilotBusy] = useState(false);
  const [copilotError, setCopilotError] = useState<string | null>(null);
  const [copilotMsgs, setCopilotMsgs] = useState<CopilotMessage[]>([]);

  const [, setSyncedCtx] = useState<SyncedAcousticContext | null>(null);
  const [kernelStatus, setKernelStatus] = useState<{
    mode: 'remote' | 'local' | 'preview';
    pythonVersion?: string;
    packages?: Record<string, boolean>;
  } | null>(null);
  const [kernelBusy, setKernelBusy] = useState(false);
  const [cellFixBusyId, setCellFixBusyId] = useState<string | null>(null);
  const [cellFixSuggestion, setCellFixSuggestion] = useState<CellFixSuggestion | null>(null);

  const importRef = useRef<HTMLInputElement | null>(null);
  const nbMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onResize = () => setIsCompact(window.innerWidth <= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const closeMenus = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (nbMenuRef.current && target && !nbMenuRef.current.contains(target)) {
        setShowNbActionsMenu(false);
      }
      if (target && !target.closest('.nb-cell-menu-wrap')) {
        setOpenCellMenuId(null);
      }
    };
    window.addEventListener('mousedown', closeMenus);
    return () => window.removeEventListener('mousedown', closeMenus);
  }, []);

  useEffect(() => {
    if (!detached) return;
    return startDetachedTabSyncClient((ctx) => {
      setSyncedCtx(ctx);
    });
  }, [detached]);

  const activeNb = notebooks.find((n) => n.id === activeNotebookId) ?? notebooks[0] ?? null;
  const activeSnap = captureActiveAcousticSnapshot(activeNb?.scope ?? 'recording');

  const refreshKernelStatus = async (notebookId: string) => {
    const st = await fetchNotebookKernelStatus(notebookId);
    setKernelStatus(st);
  };

  useEffect(() => {
    if (!activeNb) return;
    void refreshKernelStatus(activeNb.id);
  }, [activeNb?.id]);

  const handleRestartKernel = async () => {
    if (!activeNb || kernelBusy) return;
    setKernelBusy(true);
    try {
      await restartNotebookKernel(activeNb.id);
      await refreshKernelStatus(activeNb.id);
    } finally {
      setKernelBusy(false);
    }
  };

  const handleInterruptKernel = async () => {
    if (!activeNb || kernelBusy) return;
    setKernelBusy(true);
    try {
      await interruptNotebookKernel(activeNb.id);
      await refreshKernelStatus(activeNb.id);
    } finally {
      setKernelBusy(false);
    }
  };

  const handleGeminiCellAssist = async (cell: NotebookCell, mode: 'fix' | 'improve') => {
    if (!activeNb || cellFixBusyId) return;
    setCellFixBusyId(cell.id);
    setCopilotError(null);
    const instruction =
      mode === 'fix'
        ? `Fix the error in cell "${cell.title || cell.kind}" (${cell.kind}).\n\nError:\n${cell.output?.error || 'Execution failed'}\n\nCell Source:\n${cell.source}\n\nReturn exactly 1 replacement cell of kind "${cell.kind}" with corrected source.`
        : `Improve and refine cell "${cell.title || cell.kind}" (${cell.kind}) for bioacoustic analysis using the active SyrinxOne context and syrinx helpers. Keep it clean and concise.\n\nCurrent Source:\n${cell.source}\n\nReturn exactly 1 updated cell of kind "${cell.kind}".`;

    try {
      const res = await fetch('/api/local/ai/notebook-copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction,
          notebookTitle: activeNb.title,
          notebookDescription: activeNb.description,
          scope: activeNb.scope,
          cells: activeNb.cells.map((c) => ({
            kind: c.kind,
            title: c.title,
            source: c.source,
          })),
          acousticContext: activeSnap.contextPayload,
        }),
      });
      const body = (await res.json()) as {
        reply?: string;
        suggestedCells?: Array<{ kind: NotebookCellKind; title?: string; source: string }>;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || `Copilot error (${res.status})`);
      }
      const first = body.suggestedCells?.[0];
      if (!first) {
        throw new Error(body.reply || 'Gemini did not return an updated cell.');
      }
      setCellFixSuggestion({
        cellId: cell.id,
        reply: body.reply || 'Suggested updated cell ready.',
        kind: first.kind || cell.kind,
        title: first.title ?? cell.title,
        source: first.source,
      });
    } catch (err) {
      setCopilotError(err instanceof Error ? err.message : 'Gemini cell assist failed');
    } finally {
      setCellFixBusyId(null);
    }
  };

  const handleExportIpynb = () => {
    if (!activeNb) return;
    const json = exportIpynb(activeNb.id);
    const blob = new Blob([json], { type: 'application/x-ipynb+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeNb.title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.ipynb`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const txt = await f.text();
      importIpynb(txt, f.name.replace(/\.ipynb$/i, ''));
      if (isCompact) setCompactPane('cells');
    } catch (err) {
      setCopilotError(err instanceof Error ? err.message : 'Failed to import .ipynb');
    }
  };

  const handleAddParam = () => {
    if (!activeNb) return;
    const name = `param_${activeNb.parameters.length + 1}`;
    const next: NotebookParameter[] = [
      ...activeNb.parameters,
      { name, label: 'Parameter', type: 'string', defaultValue: '' },
    ];
    updateNotebookMeta(activeNb.id, { parameters: next });
  };

  const handleAskCopilot = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!activeNb || !copilotInput.trim() || copilotBusy) return;
    const instruction = copilotInput.trim();
    setCopilotInput('');
    setCopilotError(null);
    setCopilotMsgs((prev) => [
      ...prev,
      { id: `u_${Date.now()}`, role: 'user', reply: instruction },
    ]);
    setCopilotBusy(true);

    try {
      const res = await fetch('/api/local/ai/notebook-copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction,
          notebookTitle: activeNb.title,
          notebookDescription: activeNb.description,
          scope: activeNb.scope,
          cells: activeNb.cells.map((c) => ({
            kind: c.kind,
            title: c.title,
            source: c.source,
          })),
          acousticContext: activeSnap.contextPayload,
        }),
      });
      const body = (await res.json()) as {
        reply?: string;
        suggestedCells?: Array<{ kind: NotebookCellKind; title?: string; source: string }>;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || `Copilot error (${res.status})`);
      }
      setCopilotMsgs((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}`,
          role: 'assistant',
          reply: body.reply || 'Generated cells below.',
          suggestedCells: body.suggestedCells,
        },
      ]);
    } catch (err) {
      setCopilotError(err instanceof Error ? err.message : 'Copilot failed');
    } finally {
      setCopilotBusy(false);
    }
  };

  const effectiveParams = activeNb ? getEffectiveParams(activeNb.id) : {};
  const showSidebar = isCompact ? compactPane === 'library' : showLibraryDesktop;
  const showMain = isCompact ? compactPane === 'cells' : true;
  const showCopilot = isCompact ? compactPane === 'copilot' : showCopilotDesktop;
  const kernelLabel =
    kernelStatus?.mode === 'remote'
      ? `Remote Py ${kernelStatus.pythonVersion || ''}`.trim()
      : kernelStatus?.mode === 'local'
        ? `Py ${kernelStatus.pythonVersion || '3'}`
        : 'DSP Preview';

  return (
    <div className="nb-workspace">
      <input
        ref={importRef}
        type="file"
        accept=".ipynb,.json"
        style={{ display: 'none' }}
        onChange={(e) => void handleImportFile(e)}
      />

      {/* Unified Top Notebook Bar (pinned cleanly on both mobile & desktop) */}
      <div className="nb-toolbar">
        <div className="nb-toolbar-left">
          {!hideBackButton && (
            <button
              type="button"
              className="btn-small"
              onClick={onBackToSpectrogram}
              title="Return to Spectrogram Workspace"
            >
              <ArrowLeft size={13} />
              <span>Spectrogram</span>
            </button>
          )}

          {!isCompact && (
            <button
              type="button"
              className={`btn-small ${showLibraryDesktop ? 'btn-active' : ''}`}
              onClick={() => setShowLibraryDesktop((v) => !v)}
              title="Toggle Notebook Library & Tool Settings"
            >
              <FolderOpen size={13} />
            </button>
          )}

          {activeNb && (
            <input
              type="text"
              className="nb-title-input"
              value={activeNb.title}
              aria-label="Notebook title"
              onChange={(e) =>
                updateNotebookMeta(activeNb.id, { title: e.target.value })
              }
            />
          )}

          {!isCompact && (
            <>
              <span className="nb-context-chip">
                {activeSnap.summary
                  ? `${activeSnap.summary.fileName} · ${activeSnap.summary.scopeLabel}`
                  : 'No recording open'}
              </span>
              <span
                className={`nb-kernel-pill nb-kernel-${kernelStatus?.mode ?? 'preview'}`}
                title="Active Python execution runtime"
              >
                {kernelLabel}
              </span>
            </>
          )}
        </div>

        <div className="nb-toolbar-actions">
          {activeNb && (
            <button
              type="button"
              className="btn-small btn-primary"
              onClick={() => {
                if (isCompact) setCompactPane('cells');
                void runNotebookAllCells(activeNb.id);
              }}
              title="Run all enabled cells"
            >
              <PlayCircle size={13} />
              <span>Run</span>
            </button>
          )}

          {!isCompact && (
            <button
              type="button"
              className={`btn-small ${showCopilotDesktop ? 'btn-active' : ''}`}
              onClick={() => setShowCopilotDesktop((v) => !v)}
              title="Toggle Gemini Notebook Copilot"
            >
              <Sparkles size={13} />
              <span>Copilot</span>
            </button>
          )}

          <div className="nb-submenu-wrap" ref={nbMenuRef}>
            <button
              type="button"
              className={`btn-small ${showNbActionsMenu ? 'btn-active' : ''}`}
              onClick={() => setShowNbActionsMenu((v) => !v)}
              title="Notebook & Tool Actions"
            >
              <MoreVertical size={14} />
            </button>

            {showNbActionsMenu && activeNb && (
              <div className="nb-submenu">
                <button
                  type="button"
                  onClick={() => {
                    setShowNbActionsMenu(false);
                    void runNotebookAsScript(activeNb.id);
                  }}
                >
                  <Wrench size={13} /> Run as Tool (Report)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowNbActionsMenu(false);
                    clearNotebookOutputs(activeNb.id);
                  }}
                >
                  <RotateCcw size={13} /> Clear Cell Outputs
                </button>
                <button
                  type="button"
                  disabled={kernelBusy}
                  onClick={() => {
                    setShowNbActionsMenu(false);
                    void handleRestartKernel();
                  }}
                >
                  <RefreshCw size={13} /> Restart Python Kernel
                </button>
                <button
                  type="button"
                  disabled={kernelBusy}
                  onClick={() => {
                    setShowNbActionsMenu(false);
                    void handleInterruptKernel();
                  }}
                >
                  <Square size={13} /> Interrupt Kernel
                </button>
                {!detached && (
                  <a
                    href={`?view=notebook&notebookId=${encodeURIComponent(activeNb.id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setShowNbActionsMenu(false)}
                  >
                    <ExternalLink size={13} /> Open in Separate Tab
                  </a>
                )}
                <hr />
                <button
                  type="button"
                  onClick={() => {
                    setShowNbActionsMenu(false);
                    createNotebook();
                    if (isCompact) setCompactPane('cells');
                  }}
                >
                  <Plus size={13} /> New Notebook
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowNbActionsMenu(false);
                    duplicateNotebook(activeNb.id);
                  }}
                >
                  <Copy size={13} /> Duplicate Notebook
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowNbActionsMenu(false);
                    importRef.current?.click();
                  }}
                >
                  <Upload size={13} /> Import .ipynb...
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowNbActionsMenu(false);
                    handleExportIpynb();
                  }}
                >
                  <Download size={13} /> Export .ipynb
                </button>
                <hr />
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    setShowNbActionsMenu(false);
                    deleteNotebook(activeNb.id);
                  }}
                >
                  <Trash2 size={13} /> Delete Notebook
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Compact Mobile Single-Pane Switcher */}
      {isCompact && (
        <nav className="nb-mobile-tabs" aria-label="Notebook Views">
          <button
            type="button"
            className={`nb-mobile-tab ${compactPane === 'library' ? 'active' : ''}`}
            onClick={() => setCompactPane('library')}
          >
            <FolderOpen size={13} />
            <span>Notebooks</span>
          </button>
          <button
            type="button"
            className={`nb-mobile-tab ${compactPane === 'cells' ? 'active' : ''}`}
            onClick={() => setCompactPane('cells')}
          >
            <BookOpen size={13} />
            <span>Cells ({activeNb?.cells.length ?? 0})</span>
          </button>
          <button
            type="button"
            className={`nb-mobile-tab ${compactPane === 'copilot' ? 'active' : ''}`}
            onClick={() => setCompactPane('copilot')}
          >
            <Sparkles size={13} />
            <span>Copilot</span>
          </button>
        </nav>
      )}

      {/* Body Panes (3 columns on desktop, single full-height pane on mobile) */}
      <div className="nb-body">
        {showSidebar && (
          <aside className={`nb-sidebar ${isCompact ? 'nb-pane-full' : ''}`}>
            <div className="nb-sidebar-head">
              <strong>Saved Notebooks</strong>
              <div className="nb-sidebar-btns">
                <button
                  type="button"
                  className="btn-small btn-primary"
                  onClick={() => {
                    createNotebook();
                    if (isCompact) setCompactPane('cells');
                  }}
                  title="New Notebook"
                >
                  <Plus size={12} /> New
                </button>
                <button
                  type="button"
                  className="btn-small"
                  onClick={() => importRef.current?.click()}
                  title="Import .ipynb"
                >
                  <Upload size={12} />
                </button>
              </div>
            </div>

            <div className="nb-list">
              {notebooks.map((nb) => (
                <button
                  key={nb.id}
                  type="button"
                  className={`nb-list-item ${nb.id === activeNb?.id ? 'active' : ''}`}
                  onClick={() => {
                    setActiveNotebook(nb.id);
                    if (isCompact) setCompactPane('cells');
                  }}
                >
                  <div className="nb-list-title">
                    <span>{nb.title}</span>
                    {nb.pinToTools && (
                      <span className="nb-pin-badge" title="Pinned to Tools Menu">
                        <Wrench size={10} />
                      </span>
                    )}
                  </div>
                  <div className="nb-list-meta">
                    {nb.scope} · {nb.cells.length} cells
                  </div>
                </button>
              ))}
            </div>

            {activeNb && (
              <div className="nb-tool-config">
                <div className="nb-config-title">Script / Tool Settings</div>
                <label className="nb-toggle-row">
                  <input
                    type="checkbox"
                    checked={activeNb.pinToTools}
                    onChange={(e) =>
                      updateNotebookMeta(activeNb.id, { pinToTools: e.target.checked })
                    }
                  />
                  <span>
                    <Pin size={12} /> Pin to Tools menu
                  </span>
                </label>
                <label className="nb-field">
                  <span>Target Scope</span>
                  <select
                    value={activeNb.scope}
                    onChange={(e) =>
                      updateNotebookMeta(activeNb.id, {
                        scope: e.target.value as NotebookScope,
                      })
                    }
                  >
                    <option value="selection">Active Selection</option>
                    <option value="view">Current Viewport</option>
                    <option value="recording">Full Recording</option>
                    <option value="folder">Source Folder</option>
                  </select>
                </label>

                <div className="nb-params-section">
                  <div className="nb-params-head">
                    <span>Parameters</span>
                    <button type="button" className="btn-small" onClick={handleAddParam}>
                      <Plus size={11} />
                    </button>
                  </div>
                  {activeNb.parameters.map((p, idx) => (
                    <div key={p.name} className="nb-param-item">
                      <input
                        type="text"
                        value={p.name}
                        placeholder="var_name"
                        onChange={(e) => {
                          const next = [...activeNb.parameters];
                          next[idx] = { ...p, name: e.target.value.replace(/\s+/g, '_') };
                          updateNotebookMeta(activeNb.id, { parameters: next });
                        }}
                      />
                      <input
                        type="text"
                        value={String(effectiveParams[p.name] ?? p.defaultValue)}
                        placeholder="value"
                        onChange={(e) => setParamOverride(activeNb.id, p.name, e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn-small"
                        title="Remove parameter"
                        onClick={() => {
                          updateNotebookMeta(activeNb.id, {
                            parameters: activeNb.parameters.filter((_, j) => j !== idx),
                          });
                        }}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>
        )}

        {showMain && (
          <main className="nb-main">
            {activeNb ? (
              <div className="nb-cells-scroll">
                <div className="nb-cells-col">
                  {activeNb.cells.map((cell, idx) => {
                    const isMdEditing = Boolean(editingMarkdownIds[cell.id]);
                    const isRunning = cell.output?.status === 'running';
                    const isMenuOpen = openCellMenuId === cell.id;

                    return (
                      <div
                        key={cell.id}
                        className={`nb-cell nb-cell-${cell.kind} ${cell.enabled ? '' : 'nb-cell-disabled'}`}
                      >
                        <div className="nb-cell-header">
                          <span className={`nb-kind-badge nb-kind-${cell.kind}`}>
                            {cell.kind === 'ai' ? (
                              <>
                                <Sparkles size={11} /> AI
                              </>
                            ) : cell.kind === 'python' ? (
                              <>
                                <FileCode2 size={11} /> Py
                              </>
                            ) : (
                              'MD'
                            )}
                          </span>

                          <input
                            type="text"
                            className="nb-cell-title-input"
                            value={cell.title ?? ''}
                            placeholder={`Step ${idx + 1}`}
                            onChange={(e) =>
                              updateCell(activeNb.id, cell.id, { title: e.target.value })
                            }
                          />

                          <div className="nb-cell-controls">
                            <button
                              type="button"
                              className="btn-small"
                              disabled={isRunning}
                              onClick={() => void runNotebookCell(activeNb.id, cell.id)}
                              title="Run this cell"
                            >
                              {isRunning ? (
                                <Loader2 size={12} className="nb-spin" />
                              ) : (
                                <Play size={12} />
                              )}
                            </button>

                            <div className="nb-submenu-wrap nb-cell-menu-wrap">
                              <button
                                type="button"
                                className={`btn-small ${isMenuOpen ? 'btn-active' : ''}`}
                                onClick={() =>
                                  setOpenCellMenuId(isMenuOpen ? null : cell.id)
                                }
                                title="Cell options"
                              >
                                <MoreVertical size={12} />
                              </button>

                              {isMenuOpen && (
                                <div className="nb-submenu">
                                  {cell.kind === 'markdown' && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setOpenCellMenuId(null);
                                        setEditingMarkdownIds((prev) => ({
                                          ...prev,
                                          [cell.id]: !isMdEditing,
                                        }));
                                      }}
                                    >
                                      {isMdEditing ? 'Preview Markdown' : 'Edit Markdown'}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    disabled={cellFixBusyId === cell.id}
                                    onClick={() => {
                                      setOpenCellMenuId(null);
                                      void handleGeminiCellAssist(cell, 'improve');
                                    }}
                                  >
                                    <Sparkles size={12} /> Improve with Gemini
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setOpenCellMenuId(null);
                                      updateCell(activeNb.id, cell.id, {
                                        enabled: !cell.enabled,
                                      });
                                    }}
                                  >
                                    {cell.enabled ? (
                                      <>
                                        <EyeOff size={12} /> Skip in Tool Runs
                                      </>
                                    ) : (
                                      <>
                                        <Eye size={12} /> Include in Tool Runs
                                      </>
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={idx === 0}
                                    onClick={() => {
                                      setOpenCellMenuId(null);
                                      moveCell(activeNb.id, cell.id, -1);
                                    }}
                                  >
                                    <ArrowUp size={12} /> Move Up
                                  </button>
                                  <button
                                    type="button"
                                    disabled={idx === activeNb.cells.length - 1}
                                    onClick={() => {
                                      setOpenCellMenuId(null);
                                      moveCell(activeNb.id, cell.id, 1);
                                    }}
                                  >
                                    <ArrowDown size={12} /> Move Down
                                  </button>
                                  <hr />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setOpenCellMenuId(null);
                                      addCell(activeNb.id, 'python', { afterCellId: cell.id });
                                    }}
                                  >
                                    <Plus size={12} /> Insert Python Below
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setOpenCellMenuId(null);
                                      addCell(activeNb.id, 'ai', { afterCellId: cell.id });
                                    }}
                                  >
                                    <Plus size={12} /> Insert AI Prompt Below
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setOpenCellMenuId(null);
                                      addCell(activeNb.id, 'markdown', {
                                        afterCellId: cell.id,
                                      });
                                    }}
                                  >
                                    <Plus size={12} /> Insert Markdown Below
                                  </button>
                                  <hr />
                                  <button
                                    type="button"
                                    className="danger"
                                    onClick={() => {
                                      setOpenCellMenuId(null);
                                      deleteCell(activeNb.id, cell.id);
                                    }}
                                  >
                                    <Trash2 size={12} /> Delete Cell
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {cell.kind === 'markdown' && !isMdEditing ? (
                          <div
                            className="nb-md-click"
                            onDoubleClick={() =>
                              setEditingMarkdownIds((prev) => ({ ...prev, [cell.id]: true }))
                            }
                          >
                            <SimpleMarkdown text={cell.source} />
                          </div>
                        ) : (
                          <textarea
                            className={`nb-cell-editor ${cell.kind === 'python' ? 'mono' : ''}`}
                            rows={Math.min(16, Math.max(3, cell.source.split('\n').length))}
                            value={cell.source}
                            onChange={(e) =>
                              updateCell(activeNb.id, cell.id, { source: e.target.value })
                            }
                          />
                        )}

                        {cell.output && cell.output.status !== 'idle' && (
                          <div className="nb-cell-output">
                            <div className="nb-output-meta">
                              <span>
                                {cell.output.executionMode === 'python-kernel'
                                  ? 'Remote Python Kernel'
                                  : cell.output.executionMode === 'local-python-kernel'
                                    ? 'Local Python 3 Kernel'
                                    : cell.output.executionMode === 'dsp-preview'
                                      ? 'DSP Cache Preview'
                                      : cell.output.executionMode === 'gemini-ai'
                                        ? `Gemini (${cell.output.modelUsed || 'hydrogen'})`
                                        : 'Rendered'}
                              </span>
                              {cell.output.durationMs !== undefined && (
                                <span>{cell.output.durationMs} ms</span>
                              )}
                            </div>

                            {cell.output.error && (
                              <div className="nb-cell-error nb-cell-error-row">
                                <span>{cell.output.error}</span>
                                <button
                                  type="button"
                                  className="btn-small nb-cell-fix-btn"
                                  disabled={cellFixBusyId === cell.id}
                                  onClick={() => void handleGeminiCellAssist(cell, 'fix')}
                                >
                                  {cellFixBusyId === cell.id ? (
                                    <Loader2 size={12} className="nb-spin" />
                                  ) : (
                                    <Sparkles size={12} />
                                  )}
                                  <span>Fix with Gemini</span>
                                </button>
                              </div>
                            )}
                            {cell.output.markdown && <SimpleMarkdown text={cell.output.markdown} />}
                            {cell.output.figures && cell.output.figures.length > 0 && (
                              <div className="nb-figures-grid">
                                {cell.output.figures.map((fig, fIdx) => (
                                  <figure key={fIdx} className="nb-figure-card">
                                    <img
                                      src={`data:image/png;base64,${fig.base64Png}`}
                                      alt={fig.label}
                                    />
                                    <figcaption>{fig.label}</figcaption>
                                  </figure>
                                ))}
                              </div>
                            )}
                            {cell.output.stdout && (
                              <pre className="nb-cell-stdout">{cell.output.stdout}</pre>
                            )}

                            {cell.output.proposedAnnotations &&
                              cell.output.proposedAnnotations.length > 0 && (
                                <div className="nb-proposals-box">
                                  <div className="nb-proposals-head">
                                    <span>
                                      <Tag size={12} /> Proposed Annotations (
                                      {
                                        cell.output.proposedAnnotations.filter(
                                          (a) => a.accepted,
                                        ).length
                                      }
                                      )
                                    </span>
                                    <button
                                      type="button"
                                      className="btn-small btn-primary"
                                      onClick={() =>
                                        commitProposedAnnotationsToWorkspace(
                                          cell.output!.proposedAnnotations!,
                                        )
                                      }
                                    >
                                      <CheckCircle2 size={12} /> Apply to Log
                                    </button>
                                  </div>
                                  <div className="nb-proposals-list">
                                    {cell.output.proposedAnnotations.map((ann) => (
                                      <label key={ann.id} className="nb-proposal-row">
                                        <input
                                          type="checkbox"
                                          checked={ann.accepted}
                                          onChange={() =>
                                            toggleProposedInCell(
                                              activeNb.id,
                                              cell.id,
                                              ann.id,
                                            )
                                          }
                                        />
                                        <span className="mono">
                                          Ch {ann.channel} · {ann.startTimeSec.toFixed(2)}–
                                          {ann.endTimeSec.toFixed(2)}s
                                        </span>
                                        <strong>{ann.comment}</strong>
                                      </label>
                                    ))}
                                  </div>
                                </div>
                              )}
                          </div>
                        )}

                        {cellFixSuggestion && cellFixSuggestion.cellId === cell.id && (
                          <div className="nb-cell-fix-preview">
                            <div className="nb-cell-fix-head">
                              <span>
                                <Sparkles size={12} /> Gemini Suggestion: {cellFixSuggestion.reply}
                              </span>
                              <div className="nb-cell-controls">
                                <button
                                  type="button"
                                  className="btn-small btn-primary"
                                  onClick={() => {
                                    updateCell(activeNb.id, cell.id, {
                                      source: cellFixSuggestion.source,
                                      ...(cellFixSuggestion.title
                                        ? { title: cellFixSuggestion.title }
                                        : {}),
                                    });
                                    setCellFixSuggestion(null);
                                  }}
                                >
                                  Apply to Cell
                                </button>
                                <button
                                  type="button"
                                  className="btn-small"
                                  onClick={() => {
                                    addCell(activeNb.id, cellFixSuggestion.kind, {
                                      afterCellId: cell.id,
                                      title: cellFixSuggestion.title,
                                      source: cellFixSuggestion.source,
                                    });
                                    setCellFixSuggestion(null);
                                  }}
                                >
                                  Insert Below
                                </button>
                                <button
                                  type="button"
                                  className="btn-small"
                                  onClick={() => setCellFixSuggestion(null)}
                                >
                                  Dismiss
                                </button>
                              </div>
                            </div>
                            <pre className="nb-cell-stdout">{cellFixSuggestion.source}</pre>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div className="nb-bottom-add-bar">
                    <button
                      type="button"
                      className="btn-small"
                      onClick={() => addCell(activeNb.id, 'python')}
                    >
                      <Plus size={12} /> Python
                    </button>
                    <button
                      type="button"
                      className="btn-small"
                      onClick={() => addCell(activeNb.id, 'ai')}
                    >
                      <Plus size={12} /> AI Prompt
                    </button>
                    <button
                      type="button"
                      className="btn-small"
                      onClick={() => addCell(activeNb.id, 'markdown')}
                    >
                      <Plus size={12} /> Markdown
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="nb-empty-cells">Create a notebook to get started.</div>
            )}
          </main>
        )}

        {showCopilot && activeNb && (
          <aside className={`nb-copilot ${isCompact ? 'nb-pane-full' : ''}`}>
            <div className="nb-copilot-head">
              <Sparkles size={13} />
              <strong>Gemini Notebook Copilot</strong>
            </div>
            <div className="nb-copilot-msgs">
              {copilotMsgs.length === 0 && (
                <div className="nb-copilot-hint">
                  Ask Gemini to write Python DSP/plotting cells or AI analysis prompts for this
                  notebook—for example:{' '}
                  <em>&ldquo;Add cells to detect harmonic peaks and log candidate species.&rdquo;</em>
                </div>
              )}
              {copilotMsgs.map((m) => (
                <div key={m.id} className={`nb-copilot-msg nb-copilot-${m.role}`}>
                  <SimpleMarkdown text={m.reply} />
                  {m.suggestedCells && m.suggestedCells.length > 0 && (
                    <div className="nb-copilot-suggestions">
                      <div className="nb-copilot-sug-head">
                        <span>{m.suggestedCells.length} suggested cell(s)</span>
                        <button
                          type="button"
                          className="btn-small btn-primary"
                          onClick={() => {
                            for (const c of m.suggestedCells!) {
                              addCell(activeNb.id, c.kind, {
                                title: c.title,
                                source: c.source,
                              });
                            }
                            if (isCompact) setCompactPane('cells');
                          }}
                        >
                          <Plus size={12} /> Append All
                        </button>
                      </div>
                      {m.suggestedCells.map((sc, sIdx) => (
                        <div key={sIdx} className="nb-copilot-sug-item">
                          <span className={`nb-kind-badge nb-kind-${sc.kind}`}>{sc.kind}</span>
                          <span>{sc.title || sc.source.slice(0, 48)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {copilotError && <div className="nb-cell-error">{copilotError}</div>}
            </div>
            <form className="nb-copilot-form" onSubmit={(e) => void handleAskCopilot(e)}>
              <textarea
                rows={3}
                value={copilotInput}
                onChange={(e) => setCopilotInput(e.target.value)}
                placeholder="Ask Gemini to draft Python or AI cells..."
              />
              <button
                type="submit"
                className="btn-small btn-primary"
                disabled={copilotBusy || !copilotInput.trim()}
              >
                {copilotBusy ? <Loader2 size={12} className="nb-spin" /> : <Send size={12} />}
                <span>Generate Cells</span>
              </button>
            </form>
          </aside>
        )}
      </div>
    </div>
  );
};
