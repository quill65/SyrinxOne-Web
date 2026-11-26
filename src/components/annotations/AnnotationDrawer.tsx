import React, { useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Plus, Trash2, Upload, X } from 'lucide-react';
import type { AnnotationFormat } from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';

export const AnnotationDrawer: React.FC = () => {
  const annotations = useWorkspaceStore((s) => s.annotations);
  const selectedAnnotationId = useWorkspaceStore((s) => s.selectedAnnotationId);
  const annotationFilter = useWorkspaceStore((s) => s.annotationFilter);
  const windows = useWorkspaceStore((s) => s.windows);
  const activeWindowId = useWorkspaceStore((s) => s.activeWindowId);
  const files = useWorkspaceStore((s) => s.files);

  const addAnnotation = useWorkspaceStore((s) => s.addAnnotation);
  const updateAnnotation = useWorkspaceStore((s) => s.updateAnnotation);
  const deleteAnnotation = useWorkspaceStore((s) => s.deleteAnnotation);
  const selectAnnotation = useWorkspaceStore((s) => s.selectAnnotation);
  const setAnnotationFilter = useWorkspaceStore((s) => s.setAnnotationFilter);
  const importAnnotationsFromText = useWorkspaceStore((s) => s.importAnnotationsFromText);
  const exportAnnotationsAsText = useWorkspaceStore((s) => s.exportAnnotationsAsText);
  const setModalState = useWorkspaceStore((s) => s.setModalState);

  const [exportFmt, setExportFmt] = useState<AnnotationFormat>('syrinx_txt');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeWin = windows.find((w) => w.windowId === activeWindowId);
  const activeFile = activeWin ? files[activeWin.fileId] : undefined;

  const filtered = useMemo(() => {
    return annotations
      .filter((a) => {
        if (annotationFilter.excludeEmpty && !a.comment.trim()) return false;
        if (annotationFilter.includeFilter && !a.comment.includes(annotationFilter.includeText)) {
          return false;
        }
        if (
          annotationFilter.excludeFilter &&
          annotationFilter.excludeText &&
          a.comment.includes(annotationFilter.excludeText)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.startTimeSec - b.startTimeSec);
  }, [annotations, annotationFilter]);

  const handleLogCurrentSelection = () => {
    if (!activeWin || !activeWin.selection || !activeFile) return;
    const sel = activeWin.selection;
    const winOff = activeFile.windowStartSec ?? 0;
    addAnnotation({
      soundfile: activeFile.name,
      channel: sel.channel,
      startTimeSec: winOff + Math.min(sel.startSec, sel.endSec),
      endTimeSec: winOff + Math.max(sel.startSec, sel.endSec),
      lowFreqHz: Math.min(sel.lowFreqHz, sel.highFreqHz),
      highFreqHz: Math.max(sel.lowFreqHz, sel.highFreqHz),
      comment: '',
      notes: '',
      extraFields: {},
    });
  };

  const handleNavigate = (dir: -1 | 1) => {
    if (filtered.length === 0) return;
    const curIdx = filtered.findIndex((a) => a.id === selectedAnnotationId);
    const nextIdx =
      curIdx < 0
        ? dir > 0
          ? 0
          : filtered.length - 1
        : (curIdx + dir + filtered.length) % filtered.length;
    selectAnnotation(filtered[nextIdx].id, true);
  };

  const handleExportDownload = async () => {
    const text = await exportAnnotationsAsText(exportFmt);
    const ext = exportFmt === 'json' ? 'json' : exportFmt === 'csv' ? 'csv' : 'txt';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `syrinx_annotations.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    const lower = file.name.toLowerCase();
    const fmt: AnnotationFormat = lower.endsWith('.json')
      ? 'json'
      : lower.endsWith('.csv')
        ? 'csv'
        : content.includes('Begin Time (s)')
          ? 'raven_txt'
          : 'syrinx_txt';
    await importAnnotationsFromText(content, fmt);
    e.target.value = '';
  };

  return (
    <section className="annotation-drawer">
      <div className="drawer-toolbar">
        <span className="drawer-title">Annotations ({filtered.length})</span>

        <button
          className="btn-small btn-primary"
          disabled={!activeWin?.selection}
          onClick={handleLogCurrentSelection}
          title="Log current selection box as annotation"
        >
          <Plus size={12} /> Log Selection
        </button>

        <button className="btn-small" onClick={() => handleNavigate(-1)} title="Previous annotation">
          <ChevronLeft size={13} /> Prev
        </button>
        <button className="btn-small" onClick={() => handleNavigate(1)} title="Next annotation">
          Next <ChevronRight size={13} />
        </button>

        <input
          className="filter-input"
          type="text"
          placeholder="Filter comment..."
          value={annotationFilter.includeText}
          onChange={(e) =>
            setAnnotationFilter({
              includeText: e.target.value,
              includeFilter: e.target.value.length > 0,
            })
          }
        />

        <label className="inline-check">
          <input
            type="checkbox"
            checked={annotationFilter.excludeEmpty}
            onChange={(e) => setAnnotationFilter({ excludeEmpty: e.target.checked })}
          />
          Non-empty
        </label>

        <div className="drawer-spacer" />

        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.log,.csv,.json,.tsv"
          style={{ display: 'none' }}
          onChange={(e) => void handleImportFile(e)}
        />
        <button className="btn-small" onClick={() => fileInputRef.current?.click()}>
          <Upload size={12} /> Import Log
        </button>

        <select
          className="fmt-select"
          value={exportFmt}
          onChange={(e) => setExportFmt(e.target.value as AnnotationFormat)}
        >
          <option value="syrinx_txt">Syrinx Log (.txt)</option>
          <option value="raven_txt">Raven Table (.txt)</option>
          <option value="csv">CSV (.csv)</option>
          <option value="json">JSON (.json)</option>
        </select>
        <button className="btn-small" onClick={() => void handleExportDownload()}>
          <Download size={12} /> Export
        </button>
        <button
          className="mdi-win-btn"
          onClick={() => setModalState('showAnnotationDrawer', false)}
          title="Close Annotations drawer"
        >
          <X size={13} />
        </button>
      </div>

      <div className="drawer-table-wrap">
        <table className="ann-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Ch</th>
              <th>Start (s)</th>
              <th>End (s)</th>
              <th>Dur (s)</th>
              <th>Low (Hz)</th>
              <th>High (Hz)</th>
              <th>Comment</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((ann) => (
              <tr
                key={ann.id}
                className={ann.id === selectedAnnotationId ? 'selected-row' : ''}
                onClick={() => selectAnnotation(ann.id, true)}
              >
                <td className="mono">{ann.soundfile}</td>
                <td className="mono">{ann.channel}</td>
                <td className="mono">{ann.startTimeSec.toFixed(3)}</td>
                <td className="mono">{ann.endTimeSec.toFixed(3)}</td>
                <td className="mono">{(ann.endTimeSec - ann.startTimeSec).toFixed(3)}</td>
                <td className="mono">{Math.round(ann.lowFreqHz)}</td>
                <td className="mono">{Math.round(ann.highFreqHz)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    className="cell-input"
                    value={ann.comment}
                    onChange={(e) => updateAnnotation(ann.id, { comment: e.target.value })}
                  />
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    className="cell-input"
                    value={ann.notes}
                    onChange={(e) => updateAnnotation(ann.id, { notes: e.target.value })}
                  />
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button
                    className="icon-danger"
                    onClick={() => deleteAnnotation(ann.id)}
                    title="Delete annotation"
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="empty-table-cell">
                  No annotations yet — draw a selection box on a spectrogram and press a hotkey (e.g.
                  1–4) or click &ldquo;Log Selection&rdquo;.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};
