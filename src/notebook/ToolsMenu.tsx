import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronDown, Play, Plus, Upload, Wrench } from 'lucide-react';
import { useNotebookStore } from './notebookStore';
import { runNotebookAsScript } from './notebookRunner';

interface ToolsMenuProps {
  onOpenNotebooks: () => void;
  compact?: boolean;
}

export const ToolsMenu: React.FC<ToolsMenuProps> = ({ onOpenNotebooks, compact }) => {
  const notebooks = useNotebookStore((s) => s.notebooks);
  const createNotebook = useNotebookStore((s) => s.createNotebook);
  const importIpynb = useNotebookStore((s) => s.importIpynb);
  const setActiveNotebook = useNotebookStore((s) => s.setActiveNotebook);

  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const pinnedTools = notebooks.filter((n) => n.pinToTools);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handleOutside);
    return () => window.removeEventListener('mousedown', handleOutside);
  }, [open]);

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      importIpynb(text, file.name.replace(/\.ipynb$/i, ''));
      setOpen(false);
      onOpenNotebooks();
    } catch (err) {
      console.error('Failed to import .ipynb:', err);
    }
  };

  return (
    <div className="nb-tools-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`btn-small ${open ? 'btn-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Run saved Notebook Analytic Tools or manage Notebooks"
      >
        <Wrench size={13} />
        {!compact && <span>Tools</span>}
        <ChevronDown size={11} />
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept=".ipynb,.json"
        style={{ display: 'none' }}
        onChange={(e) => void handleImportFile(e)}
      />

      {open && (
        <div className="nb-tools-dropdown">
          <div className="nb-tools-header">Analytic Tools (Notebooks)</div>
          {pinnedTools.length === 0 ? (
            <div className="nb-tools-empty">
              No pinned notebooks. Pin any notebook to run it here as a tool.
            </div>
          ) : (
            pinnedTools.map((nb) => (
              <button
                key={nb.id}
                type="button"
                className="nb-tools-item"
                onClick={() => {
                  setOpen(false);
                  void runNotebookAsScript(nb.id);
                }}
                title={nb.description}
              >
                <Play size={12} className="nb-tools-play-icon" />
                <div className="nb-tools-item-text">
                  <span className="nb-tools-item-title">{nb.title}</span>
                  <span className="nb-tools-item-meta">
                    Scope: {nb.scope} · {nb.cells.filter((c) => c.enabled).length} steps
                  </span>
                </div>
              </button>
            ))
          )}

          <hr />

          <button
            type="button"
            className="nb-tools-action"
            onClick={() => {
              setOpen(false);
              onOpenNotebooks();
            }}
          >
            <BookOpen size={13} /> Open Notebook Studio
          </button>
          <button
            type="button"
            className="nb-tools-action"
            onClick={() => {
              const nb = createNotebook();
              setActiveNotebook(nb.id);
              setOpen(false);
              onOpenNotebooks();
            }}
          >
            <Plus size={13} /> New Analytic Notebook
          </button>
          <button
            type="button"
            className="nb-tools-action"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={13} /> Import .ipynb Notebook...
          </button>
        </div>
      )}
    </div>
  );
};
