import React, { useRef } from 'react';
import { Link2, Maximize2, Minimize2, Minus, Play, Sparkles, Square, X, ZoomIn } from 'lucide-react';
import {
  SPECTROGRAM_GAIN_MAX_DB,
  SPECTROGRAM_GAIN_MIN_DB,
  type AudioFileInfo,
  type MDIWindowState,
} from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { audioPlayer } from '../../audio/WebAudioPlayer';
import { formatDurationCompact } from '../../utils/spectrogramFetch';
import { SpectrogramView } from '../spectrogram/SpectrogramView';

interface Props {
  win: MDIWindowState;
  file: AudioFileInfo;
  isActive: boolean;
}

const TITLEBAR_HEIGHT = 28;

export const MDIChildWindow: React.FC<Props> = ({ win, file, isActive }) => {
  const engine = useWorkspaceStore((s) => s.engine);
  const canvasBounds = useWorkspaceStore((s) => s.canvasBounds);
  const focusWindow = useWorkspaceStore((s) => s.focusWindow);
  const closeWindow = useWorkspaceStore((s) => s.closeWindow);
  const updateWindowGeometry = useWorkspaceStore((s) => s.updateWindowGeometry);
  const updateWindowSpecParams = useWorkspaceStore((s) => s.updateWindowSpecParams);
  const updateWindowDisplaySettings = useWorkspaceStore((s) => s.updateWindowDisplaySettings);
  const updateWindowViewRange = useWorkspaceStore((s) => s.updateWindowViewRange);
  const toggleWindowLinkGroup = useWorkspaceStore((s) => s.toggleWindowLinkGroup);
  const autoGainMode = useWorkspaceStore((s) => s.windowAutoGainMode[win.windowId] ?? 'manual');
  const setWindowAutoGainMode = useWorkspaceStore((s) => s.setWindowAutoGainMode);

  const actionRef = useRef<{
    kind: 'move' | 'resize';
    edge?: string;
    startX: number;
    startY: number;
    orig: { x: number; y: number; width: number; height: number };
  } | null>(null);

  if (win.minimized) return null;

  const boxX = win.maximized ? 0 : win.x;
  const boxY = win.maximized ? 0 : win.y;
  const boxW = win.maximized ? canvasBounds.width : win.width;
  const boxH = win.maximized ? canvasBounds.height : win.height;
  const titleH = win.showTitlebar ? TITLEBAR_HEIGHT : 0;
  const bodyW = Math.max(120, boxW - 2);
  const bodyH = Math.max(100, boxH - titleH - 2);

  const startPointerDrag = (kind: 'move' | 'resize', e: React.MouseEvent, edge?: string) => {
    if (win.maximized) return;
    e.preventDefault();
    e.stopPropagation();
    focusWindow(win.windowId);
    actionRef.current = {
      kind,
      edge,
      startX: e.clientX,
      startY: e.clientY,
      orig: { x: win.x, y: win.y, width: win.width, height: win.height },
    };

    const onMove = (ev: MouseEvent) => {
      const act = actionRef.current;
      if (!act) return;
      const dx = ev.clientX - act.startX;
      const dy = ev.clientY - act.startY;
      if (act.kind === 'move') {
        updateWindowGeometry(win.windowId, {
          x: Math.max(-act.orig.width + 80, act.orig.x + dx),
          y: Math.max(0, act.orig.y + dy),
        });
      } else {
        const edgeName = act.edge || 'se';
        let { x, y, width, height } = act.orig;
        if (edgeName.includes('e')) width = Math.max(280, act.orig.width + dx);
        if (edgeName.includes('s')) height = Math.max(200, act.orig.height + dy);
        if (edgeName.includes('w')) {
          const nw = Math.max(280, act.orig.width - dx);
          x = act.orig.x + (act.orig.width - nw);
          width = nw;
        }
        if (edgeName.includes('n')) {
          const nh = Math.max(200, act.orig.height - dy);
          y = Math.max(0, act.orig.y + (act.orig.height - nh));
          height = nh;
        }
        updateWindowGeometry(win.windowId, { x, y, width, height });
      }
    };

    const onUp = () => {
      actionRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const s = win.selection
      ? Math.min(win.selection.startSec, win.selection.endSec)
      : win.viewRange.startSec;
    const en = win.selection
      ? Math.max(win.selection.startSec, win.selection.endSec)
      : win.viewRange.endSec;
    void audioPlayer.play(engine, file.fileId, s, en).catch((err) => {
      useWorkspaceStore
        .getState()
        .setError(err instanceof Error ? err.message : 'Unable to play audio');
    });
  };

  const handleZoomToSelection = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!win.selection) return;
    updateWindowViewRange(win.windowId, {
      startSec: Math.min(win.selection.startSec, win.selection.endSec),
      endSec: Math.max(win.selection.startSec, win.selection.endSec),
      minFreqHz: Math.min(win.selection.lowFreqHz, win.selection.highFreqHz),
      maxFreqHz: Math.max(win.selection.lowFreqHz, win.selection.highFreqHz),
    });
  };

  return (
    <div
      className={`mdi-window ${isActive ? 'mdi-window-active' : ''}`}
      style={{
        left: `${boxX}px`,
        top: `${boxY}px`,
        width: `${boxW}px`,
        height: `${boxH}px`,
        zIndex: win.zIndex,
      }}
      onMouseDown={() => focusWindow(win.windowId)}
    >
      {win.showTitlebar && (
        <div
          className="mdi-titlebar"
          onMouseDown={(e) => startPointerDrag('move', e)}
          onDoubleClick={() => updateWindowGeometry(win.windowId, { maximized: !win.maximized })}
        >
          <span className="mdi-title" title={file.uri}>
            {win.title}
            <span className="mdi-meta">
              {' '}
              ({(file.sampleRate / 1000).toFixed(1)}kHz,{' '}
              {file.isPartialWindow && file.totalDurationSec
                ? `${formatDurationCompact(file.durationSec)} of ${formatDurationCompact(file.totalDurationSec)}`
                : formatDurationCompact(file.durationSec)}
              )
            </span>
          </span>

          <div className="mdi-titlebar-actions" onMouseDown={(e) => e.stopPropagation()}>
            <div
              className="mdi-gain-control"
              title="Spectrogram Gain (Alt+↑ darker/brighter, Alt+↓ lighter)"
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <span className="mdi-gain-label">Gain</span>
              <input
                type="range"
                className="mdi-gain-slider"
                min={SPECTROGRAM_GAIN_MIN_DB}
                max={SPECTROGRAM_GAIN_MAX_DB}
                step={1}
                value={win.displaySettings.gainDb}
                onChange={(e) =>
                  updateWindowDisplaySettings(win.windowId, { gainDb: Number(e.target.value) })
                }
                aria-label="Spectrogram Gain"
              />
              <span className="mdi-gain-val">
                {win.displaySettings.gainDb >= 0
                  ? `+${win.displaySettings.gainDb.toFixed(0)}`
                  : win.displaySettings.gainDb.toFixed(0)}
              </span>
              <button
                className={`mdi-icon-btn ${autoGainMode === 'auto' ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setWindowAutoGainMode(win.windowId, autoGainMode === 'auto' ? 'manual' : 'auto');
                }}
                title={autoGainMode === 'auto' ? 'Auto Gain: ON (Alt+A)' : 'Auto Gain: OFF (Alt+A)'}
              >
                <Sparkles size={11} />
              </button>
            </div>

            {file.numChannels > 1 && (
              <select
                className="mdi-chan-select"
                value={win.displaySettings.stackAllChannels ? -1 : win.specParams.channel}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (val === -1) {
                    updateWindowDisplaySettings(win.windowId, { stackAllChannels: true });
                  } else {
                    if (win.displaySettings.stackAllChannels) {
                      updateWindowDisplaySettings(win.windowId, { stackAllChannels: false });
                    }
                    void updateWindowSpecParams(win.windowId, { channel: val });
                  }
                }}
                title="Active Channel or Stack All Channels"
              >
                <option value={-1}>All {file.numChannels} Ch (Stacked)</option>
                {Array.from({ length: file.numChannels }, (_, idx) => (
                  <option key={idx} value={idx}>
                    Ch {idx + 1}
                  </option>
                ))}
              </select>
            )}

            <button
              className={`mdi-icon-btn ${win.linkGroupId ? 'active' : ''}`}
              onClick={() => toggleWindowLinkGroup(win.windowId)}
              title="Link scroll/zoom with other linked windows"
            >
              <Link2 size={12} />
            </button>

            <button className="mdi-icon-btn" onClick={handlePlay} title="Play selection or visible view">
              <Play size={12} />
            </button>

            <button
              className="mdi-icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                audioPlayer.stop();
              }}
              title="Stop playback"
            >
              <Square size={11} />
            </button>

            {win.selection && (
              <button
                className="mdi-icon-btn"
                onClick={handleZoomToSelection}
                title="Zoom to selection box"
              >
                <ZoomIn size={12} />
              </button>
            )}

            <button
              className="mdi-icon-btn"
              onClick={() => updateWindowGeometry(win.windowId, { minimized: true })}
              title="Minimize"
            >
              <Minus size={12} />
            </button>

            <button
              className="mdi-icon-btn"
              onClick={() => updateWindowGeometry(win.windowId, { maximized: !win.maximized })}
              title={win.maximized ? 'Restore' : 'Maximize'}
            >
              {win.maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>

            <button
              className="mdi-icon-btn mdi-close-btn"
              onClick={() => closeWindow(win.windowId)}
              title="Close window"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      <div className="mdi-body" style={{ width: `${bodyW}px`, height: `${bodyH}px` }}>
        <SpectrogramView win={win} file={file} width={bodyW} height={bodyH} />
      </div>

      {!win.maximized && (
        <>
          <div className="mdi-resize mdi-resize-e" onMouseDown={(e) => startPointerDrag('resize', e, 'e')} />
          <div className="mdi-resize mdi-resize-s" onMouseDown={(e) => startPointerDrag('resize', e, 's')} />
          <div className="mdi-resize mdi-resize-w" onMouseDown={(e) => startPointerDrag('resize', e, 'w')} />
          <div className="mdi-resize mdi-resize-se" onMouseDown={(e) => startPointerDrag('resize', e, 'se')} />
        </>
      )}
    </div>
  );
};
