import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useWorkspaceStore } from '../../store/workspaceStore';

export const KlipnSaveModal: React.FC = () => {
  const show = useWorkspaceStore((s) => s.showKlipModal);
  const windows = useWorkspaceStore((s) => s.windows);
  const activeWindowId = useWorkspaceStore((s) => s.activeWindowId);
  const files = useWorkspaceStore((s) => s.files);
  const engine = useWorkspaceStore((s) => s.engine);
  const openAudioInfoInWindow = useWorkspaceStore((s) => s.openAudioInfoInWindow);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const setStatus = useWorkspaceStore((s) => s.setStatus);
  const setError = useWorkspaceStore((s) => s.setError);

  const [nameTemplate, setNameTemplate] = useState('%f_%c_%ch');
  const [comment, setComment] = useState('clip');
  const [targetDir, setTargetDir] = useState('');
  const [openInWindow, setOpenInWindow] = useState(true);
  const [busy, setBusy] = useState(false);

  if (!show) return null;

  const activeWin = windows.find((w) => w.windowId === activeWindowId);
  const activeFile = activeWin ? files[activeWin.fileId] : undefined;
  const sel = activeWin?.selection;

  const handleSave = async () => {
    if (!activeWin || !activeFile || !sel) return;
    setBusy(true);
    try {
      const resp = await engine.clipAndSave({
        fileId: activeFile.fileId,
        startSec: Math.min(sel.startSec, sel.endSec),
        endSec: Math.max(sel.startSec, sel.endSec),
        channels: [activeWin.specParams.channel],
        targetSourceId: activeFile.sourceId === 'upload' ? 'local' : activeFile.sourceId,
        targetDirectory: targetDir,
        nameTemplate,
        comment,
        openInWindow,
      });
      setStatus(`Saved clip: ${resp.savedUri}`);
      if (resp.fileInfo && openInWindow) {
        await openAudioInfoInWindow(resp.fileInfo);
      }
      setModalState('showKlipModal', false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clip-and-Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => setModalState('showKlipModal', false)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Clip &amp; Save Selection (KlipnSave)</span>
          <button className="mdi-icon-btn" onClick={() => setModalState('showKlipModal', false)}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          {!sel || !activeFile ? (
            <p>Draw a selection box on an active spectrogram window first.</p>
          ) : (
            <>
              <p className="modal-hint">
                Source: <strong>{activeFile.name}</strong> · Selection:{' '}
                {Math.min(sel.startSec, sel.endSec).toFixed(3)}s –{' '}
                {Math.max(sel.startSec, sel.endSec).toFixed(3)}s (
                {Math.abs(sel.endSec - sel.startSec).toFixed(3)}s)
              </p>

              <div className="field-group">
                <label>Filename Template (%f=source, %c=comment, %ch=channel, %d=date, %t=time)</label>
                <input
                  type="text"
                  value={nameTemplate}
                  onChange={(e) => setNameTemplate(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label>Comment Token (%c)</label>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label>Target Directory (blank = alongside source file)</label>
                <input
                  type="text"
                  value={targetDir}
                  placeholder="Default source directory"
                  onChange={(e) => setTargetDir(e.target.value)}
                />
              </div>

              <label className="inline-check" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={openInWindow}
                  onChange={(e) => setOpenInWindow(e.target.checked)}
                />
                Open saved clip in a new MDI window
              </label>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-small" onClick={() => setModalState('showKlipModal', false)}>
            Cancel
          </button>
          <button
            className="btn-small btn-primary"
            disabled={!sel || busy}
            onClick={() => void handleSave()}
          >
            {busy ? 'Saving...' : 'Save Clip (.wav)'}
          </button>
        </div>
      </div>
    </div>
  );
};
