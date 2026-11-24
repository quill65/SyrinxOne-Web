import React, { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { HotkeyBinding } from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';

export const HotkeyConfigModal: React.FC = () => {
  const show = useWorkspaceStore((s) => s.showHotkeyModal);
  const hotkeys = useWorkspaceStore((s) => s.hotkeys);
  const setHotkeys = useWorkspaceStore((s) => s.setHotkeys);
  const setModalState = useWorkspaceStore((s) => s.setModalState);

  const [draft, setDraft] = useState<HotkeyBinding[]>(hotkeys);

  if (!show) return null;

  const updateRow = (idx: number, patch: Partial<HotkeyBinding>) => {
    setDraft((prev) => prev.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  };

  const addRow = () => {
    setDraft((prev) => [...prev, { key: '', comment: '' }]);
  };

  const removeRow = (idx: number) => {
    setDraft((prev) => prev.filter((_, i) => i !== idx));
  };

  const save = () => {
    const cleaned = draft
      .map((d) => ({ ...d, key: d.key.trim().slice(0, 1).toLowerCase() }))
      .filter((d) => d.key.length === 1);
    setHotkeys(cleaned);
    setModalState('showHotkeyModal', false);
  };

  return (
    <div className="modal-backdrop" onClick={() => setModalState('showHotkeyModal', false)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Annotation Hotkeys (Classic EditLogKeys)</span>
          <button className="mdi-icon-btn" onClick={() => setModalState('showHotkeyModal', false)}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-hint">
            Draw a selection box on any spectrogram and press a single key below to immediately log
            an annotation with its mapped comment.
          </p>
          <table className="hotkey-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Comment Label</th>
                <th>Default Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.map((row, idx) => (
                <tr key={idx}>
                  <td>
                    <input
                      className="key-box"
                      maxLength={1}
                      value={row.key}
                      onChange={(e) => updateRow(idx, { key: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      value={row.comment}
                      onChange={(e) => updateRow(idx, { comment: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      value={row.notes ?? ''}
                      onChange={(e) => updateRow(idx, { notes: e.target.value })}
                    />
                  </td>
                  <td>
                    <button className="icon-danger" onClick={() => removeRow(idx)}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn-small" onClick={addRow} style={{ marginTop: 8 }}>
            <Plus size={12} /> Add Hotkey
          </button>
        </div>

        <div className="modal-footer">
          <button className="btn-small" onClick={() => setModalState('showHotkeyModal', false)}>
            Cancel
          </button>
          <button className="btn-small btn-primary" onClick={save}>
            Save Hotkeys
          </button>
        </div>
      </div>
    </div>
  );
};
