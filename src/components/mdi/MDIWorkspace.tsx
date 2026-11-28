import React, { useEffect, useRef } from 'react';
import { Database, FolderOpen, Plus, Sparkles, X } from 'lucide-react';
import { SPECTROGRAM_GAIN_MAX_DB, SPECTROGRAM_GAIN_MIN_DB } from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { MDIChildWindow } from './MDIChildWindow';
import { SpectrogramView } from '../spectrogram/SpectrogramView';

const MOBILE_TAB_HEIGHT = 32;
const MOBILE_GAIN_BAR_HEIGHT = 32;

export const MDIWorkspace: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const windows = useWorkspaceStore((s) => s.windows);
  const files = useWorkspaceStore((s) => s.files);
  const activeWindowId = useWorkspaceStore((s) => s.activeWindowId);
  const activeSourceDisplayName = useWorkspaceStore((s) => s.activeSourceDisplayName);
  const canvasBounds = useWorkspaceStore((s) => s.canvasBounds);
  const setCanvasBounds = useWorkspaceStore((s) => s.setCanvasBounds);
  const focusWindow = useWorkspaceStore((s) => s.focusWindow);
  const closeWindow = useWorkspaceStore((s) => s.closeWindow);
  const updateWindowDisplaySettings = useWorkspaceStore((s) => s.updateWindowDisplaySettings);
  const updateWindowViewRange = useWorkspaceStore((s) => s.updateWindowViewRange);
  const resetWindowZoom = useWorkspaceStore((s) => s.resetWindowZoom);
  const logActiveSelection = useWorkspaceStore((s) => s.logActiveSelection);
  const windowAutoGainMode = useWorkspaceStore((s) => s.windowAutoGainMode);
  const setWindowAutoGainMode = useWorkspaceStore((s) => s.setWindowAutoGainMode);
  const touchMode = useWorkspaceStore((s) => s.touchMode);
  const setTouchMode = useWorkspaceStore((s) => s.setTouchMode);
  const openUploadedFile = useWorkspaceStore((s) => s.openUploadedFile);
  const importAnnotationsFromText = useWorkspaceStore((s) => s.importAnnotationsFromText);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const openSourceSelector = useWorkspaceStore((s) => s.openSourceSelector);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setCanvasBounds({ width: el.clientWidth, height: el.clientHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [setCanvasBounds]);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files);
    for (const file of dropped) {
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.txt') || lower.endsWith('.log') || lower.endsWith('.csv') || lower.endsWith('.json')) {
        const text = await file.text();
        const fmt = lower.endsWith('.json')
          ? 'json'
          : lower.endsWith('.csv')
            ? 'csv'
            : text.includes('Begin Time (s)')
              ? 'raven_txt'
              : 'syrinx_txt';
        await importAnnotationsFromText(text, fmt);
      } else {
        await openUploadedFile(file);
      }
    }
  };

  const minimizedWindows = windows.filter((w) => w.minimized);
  const isMobileSinglePane = canvasBounds.width > 0 && canvasBounds.width <= 768;
  const activeMobileWin =
    windows.find((w) => w.windowId === activeWindowId) ?? windows[windows.length - 1];
  const activeMobileFile = activeMobileWin ? files[activeMobileWin.fileId] : undefined;

  const zoomMobileTimeBy = (factor: number) => {
    if (!activeMobileWin || !activeMobileFile) return;
    const splitRows = Math.max(
      1,
      Math.min(10, Math.round(activeMobileWin.displaySettings.splitTimeRows ?? 1)),
    );
    const s = activeMobileWin.viewRange.startSec;
    const e = activeMobileWin.viewRange.endSec;
    const span = Math.max(1e-6, e - s);
    const mid = 0.5 * (s + e);
    const nextSpan = Math.max(
      0.02 * splitRows,
      Math.min(activeMobileFile.durationSec, span * factor),
    );
    const ns = Math.max(
      0,
      Math.min(Math.max(0, activeMobileFile.durationSec - nextSpan), mid - nextSpan / 2),
    );
    updateWindowViewRange(activeMobileWin.windowId, {
      ...activeMobileWin.viewRange,
      startSec: ns,
      endSec: Math.min(activeMobileFile.durationSec, ns + nextSpan),
    });
  };

  return (
    <div
      ref={containerRef}
      className="mdi-workspace"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void handleDrop(e)}
    >
      {windows.length === 0 && (
        <div className="mdi-empty-state">
          <h2>SyrinxOne Bioacoustics</h2>
          <p className="mdi-empty-source-note">
            Active Source: <strong>{activeSourceDisplayName}</strong>
          </p>
          <div className="mdi-empty-actions">
            <button className="btn-small" onClick={() => openSourceSelector(false)}>
              <Database size={13} /> Select Source
            </button>
            <button className="btn-primary" onClick={() => setModalState('showFileBrowser', true)}>
              <FolderOpen size={14} /> Select Recordings
            </button>
          </div>
          <p className="mdi-empty-hint">
            Swipe left for Settings · Swipe right for AI Explorer
          </p>
        </div>
      )}

      {isMobileSinglePane && windows.length > 0 && activeMobileWin && activeMobileFile ? (
        <div className="mobile-single-pane">
          <div className="mobile-tab-strip">
            {windows.map((w) => (
              <div
                key={w.windowId}
                className={`mobile-tab ${w.windowId === activeMobileWin.windowId ? 'active' : ''}`}
                onClick={() => focusWindow(w.windowId)}
              >
                <span className="mobile-tab-title">{w.title}</span>
                <button
                  className="mobile-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeWindow(w.windowId);
                  }}
                  title="Close tab"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <button
              className="mobile-tab-add"
              onClick={() => setModalState('showFileBrowser', true)}
              title="Add recordings"
            >
              <Plus size={13} />
            </button>
          </div>
          <div className="mobile-gain-bar">
            <div className="mobile-gain-group">
              <span className="mobile-gain-label">Gain</span>
              <input
                type="range"
                className="mobile-gain-slider"
                min={SPECTROGRAM_GAIN_MIN_DB}
                max={SPECTROGRAM_GAIN_MAX_DB}
                step={1}
                value={activeMobileWin.displaySettings.gainDb}
                onChange={(e) =>
                  updateWindowDisplaySettings(activeMobileWin.windowId, {
                    gainDb: Number(e.target.value),
                  })
                }
                aria-label="Spectrogram Gain"
              />
              <span className="mobile-gain-val">
                {activeMobileWin.displaySettings.gainDb >= 0
                  ? `+${activeMobileWin.displaySettings.gainDb.toFixed(0)}`
                  : activeMobileWin.displaySettings.gainDb.toFixed(0)}
              </span>
              <button
                type="button"
                className={`mobile-auto-gain-btn ${(windowAutoGainMode[activeMobileWin.windowId] ?? 'manual') === 'auto' ? 'btn-active' : ''}`}
                onClick={() => {
                  const cur = windowAutoGainMode[activeMobileWin.windowId] ?? 'manual';
                  setWindowAutoGainMode(activeMobileWin.windowId, cur === 'auto' ? 'manual' : 'auto');
                }}
                title="Toggle Auto Gain"
              >
                <Sparkles size={11} /> Auto
              </button>
            </div>
            <div className="mobile-bar-actions">
              <button
                type="button"
                className={`btn-small ${touchMode === 'select' ? 'btn-active' : ''}`}
                onClick={() => setTouchMode('select')}
              >
                Select
              </button>
              <button
                type="button"
                className={`btn-small ${touchMode === 'pan' ? 'btn-active' : ''}`}
                onClick={() => setTouchMode('pan')}
              >
                Pan
              </button>
              <button
                type="button"
                className="btn-small"
                onClick={() => zoomMobileTimeBy(0.6)}
                title="Zoom in"
              >
                +
              </button>
              <button
                type="button"
                className="btn-small"
                onClick={() => zoomMobileTimeBy(1.6)}
                title="Zoom out"
              >
                −
              </button>
              <button
                type="button"
                className="btn-small"
                onClick={() => resetWindowZoom(activeMobileWin.windowId)}
                title="Reset zoom"
              >
                Fit
              </button>
              {activeMobileWin.selection && (
                <button
                  type="button"
                  className="btn-small btn-primary"
                  onClick={() => logActiveSelection('')}
                  title="Log current selection"
                >
                  +Log
                </button>
              )}
            </div>
          </div>
          <div className="mobile-spec-stage">
            <SpectrogramView
              win={activeMobileWin}
              file={activeMobileFile}
              width={Math.max(240, canvasBounds.width)}
              height={Math.max(200, canvasBounds.height - MOBILE_TAB_HEIGHT - MOBILE_GAIN_BAR_HEIGHT)}
            />
          </div>
        </div>
      ) : (
        <>
          {windows.map((win) => {
            const file = files[win.fileId];
            if (!file) return null;
            return (
              <MDIChildWindow
                key={win.windowId}
                win={win}
                file={file}
                isActive={win.windowId === activeWindowId}
              />
            );
          })}

          {minimizedWindows.length > 0 && (
            <div className="mdi-minimized-tray">
              {minimizedWindows.map((w) => (
                <button
                  key={w.windowId}
                  className="mdi-minimized-pill"
                  onClick={() => focusWindow(w.windowId)}
                >
                  {w.title}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
