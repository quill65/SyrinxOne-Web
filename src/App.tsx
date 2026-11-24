import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Columns,
  FolderOpen,
  Grid,
  Keyboard,
  Layers,
  Maximize,
  PanelBottom,
  PanelRight,
  Play,
  Radar,
  Repeat,
  Rows,
  Save,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Square,
  Upload,
} from 'lucide-react';
import type { DesktopBridge } from '@syrinxone/shared';
import { getCachedSpectrogram, useWorkspaceStore } from './store/workspaceStore';
import { audioPlayer, type PlaybackState } from './audio/WebAudioPlayer';
import { copySpectrogramImageToClipboard } from './utils/exportImage';
import { MDIWorkspace } from './components/mdi/MDIWorkspace';
import { SpecSettingsPanel } from './components/dialogs/SpecSettingsPanel';
import { AnnotationDrawer } from './components/annotations/AnnotationDrawer';
import { HotkeyConfigModal } from './components/annotations/HotkeyConfigModal';
import { KlipnSaveModal } from './components/dialogs/KlipnSaveModal';
import { FileBrowserModal } from './components/dialogs/FileBrowserModal';
import { DetectSoundsModal } from './components/dialogs/DetectSoundsModal';
import { EngineConnectionModal } from './components/dialogs/EngineConnectionModal';
import { AiExplorerPanel } from './components/panels/AiExplorerPanel';

declare global {
  interface Window {
    syrinxDesktop?: DesktopBridge;
  }
}

export const App: React.FC = () => {
  const setBackendConfig = useWorkspaceStore((s) => s.setBackendConfig);
  const checkBackendHealth = useWorkspaceStore((s) => s.checkBackendHealth);
  const backendConnected = useWorkspaceStore((s) => s.backendConnected);
  const backendVersion = useWorkspaceStore((s) => s.backendVersion);
  const statusMessage = useWorkspaceStore((s) => s.statusMessage);
  const errorMessage = useWorkspaceStore((s) => s.errorMessage);
  const setError = useWorkspaceStore((s) => s.setError);
  const setStatus = useWorkspaceStore((s) => s.setStatus);
  const cursorReadout = useWorkspaceStore((s) => s.cursorReadout);
  const engine = useWorkspaceStore((s) => s.engine);
  const windows = useWorkspaceStore((s) => s.windows);
  const activeWindowId = useWorkspaceStore((s) => s.activeWindowId);
  const files = useWorkspaceStore((s) => s.files);
  const specCache = useWorkspaceStore((s) => s.spectrogramCache);
  const selectedAnnotationId = useWorkspaceStore((s) => s.selectedAnnotationId);

  const showSpecPanel = useWorkspaceStore((s) => s.showSpecPanel);
  const showAiPanel = useWorkspaceStore((s) => s.showAiPanel);
  const showAnnotationDrawer = useWorkspaceStore((s) => s.showAnnotationDrawer);
  const shiftArchiveWindow = useWorkspaceStore((s) => s.shiftArchiveWindow);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const applyLayout = useWorkspaceStore((s) => s.applyLayout);
  const toggleAllTitlebars = useWorkspaceStore((s) => s.toggleAllTitlebars);
  const toggleAllCursors = useWorkspaceStore((s) => s.toggleAllCursors);
  const toggleTimeScaleMode = useWorkspaceStore((s) => s.toggleTimeScaleMode);
  const nudgeWindowGain = useWorkspaceStore((s) => s.nudgeWindowGain);
  const resetWindowZoom = useWorkspaceStore((s) => s.resetWindowZoom);
  const gotoTimeInWindow = useWorkspaceStore((s) => s.gotoTimeInWindow);
  const stepFileInFolder = useWorkspaceStore((s) => s.stepFileInFolder);
  const stampSelectionWithHotkey = useWorkspaceStore((s) => s.stampSelectionWithHotkey);
  const logActiveSelection = useWorkspaceStore((s) => s.logActiveSelection);
  const deleteAnnotation = useWorkspaceStore((s) => s.deleteAnnotation);
  const navigateAnnotation = useWorkspaceStore((s) => s.navigateAnnotation);
  const openAudioFromSource = useWorkspaceStore((s) => s.openAudioFromSource);
  const importAnnotationsFromSource = useWorkspaceStore((s) => s.importAnnotationsFromSource);
  const exportDisplayJson = useWorkspaceStore((s) => s.exportDisplayJson);
  const importDisplayJson = useWorkspaceStore((s) => s.importDisplayJson);

  const [playback, setPlayback] = useState<PlaybackState>(() => audioPlayer.getState());
  const displayInputRef = useRef<HTMLInputElement | null>(null);
  const mergeDisplayFlagRef = useRef(false);

  useEffect(() => audioPlayer.subscribe(setPlayback), []);

  const handleOpenAudio = async () => {
    if (window.syrinxDesktop) {
      const paths = await window.syrinxDesktop.openAudioFilesDialog();
      for (const p of paths) {
        await openAudioFromSource('local', p);
      }
    } else {
      setModalState('showFileBrowser', true);
    }
  };

  const handleSaveDisplay = () => {
    const json = exportDisplayJson();
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'syrinxone_display.json';
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Saved workspace display file (syrinxone_display.json)');
  };

  const handleTriggerLoadDisplay = (merge: boolean) => {
    mergeDisplayFlagRef.current = merge;
    displayInputRef.current?.click();
  };

  const handleDisplayFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await importDisplayJson(text, mergeDisplayFlagRef.current);
    e.target.value = '';
  };

  const handleCopyActiveImage = async () => {
    const state = useWorkspaceStore.getState();
    const win = state.windows.find((w) => w.windowId === state.activeWindowId);
    if (!win) return;
    const file = state.files[win.fileId];
    const mat = getCachedSpectrogram(state.spectrogramCache, win.fileId, win.specParams);
    if (!file || !mat) return;
    try {
      const mode = await copySpectrogramImageToClipboard(
        mat,
        win.viewRange,
        win.displaySettings,
        file.name,
      );
      setStatus(
        mode === 'clipboard'
          ? 'Copied clean spectrogram PNG to clipboard'
          : 'Downloaded spectrogram PNG',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy spectrogram image');
    }
  };

  const handlePlayActive = () => {
    const state = useWorkspaceStore.getState();
    const activeWin = state.windows.find((w) => w.windowId === state.activeWindowId);
    if (!activeWin) return;
    const file = state.files[activeWin.fileId];
    if (!file) return;
    if (activeWin.selection) {
      const s = Math.min(activeWin.selection.startSec, activeWin.selection.endSec);
      const en = Math.max(activeWin.selection.startSec, activeWin.selection.endSec);
      void audioPlayer.play(state.engine, file.fileId, s, en);
    } else {
      void audioPlayer.play(
        state.engine,
        file.fileId,
        activeWin.viewRange.startSec,
        activeWin.viewRange.endSec,
      );
    }
  };

  // Initialize backend connection (Electron local sidecar OR Web server)
  useEffect(() => {
    let cleanupMenu: (() => void) | undefined;

    void (async () => {
      if (window.syrinxDesktop) {
        const cfg = await window.syrinxDesktop.getBackendConfig();
        setBackendConfig(cfg.baseUrl, cfg.token);
        cleanupMenu = window.syrinxDesktop.onMenuCommand((cmd) => {
          const curWinId = useWorkspaceStore.getState().activeWindowId;
          if (cmd === 'open-audio') {
            void handleOpenAudio();
          } else if (cmd === 'open-annotations') {
            void (async () => {
              const path = await window.syrinxDesktop?.openAnnotationFileDialog();
              if (path) await importAnnotationsFromSource('local', path);
            })();
          } else if (cmd === 'save-display') {
            handleSaveDisplay();
          } else if (cmd === 'load-display') {
            handleTriggerLoadDisplay(false);
          } else if (cmd === 'merge-display') {
            handleTriggerLoadDisplay(true);
          } else if (cmd === 'copy-image') {
            void handleCopyActiveImage();
          } else if (cmd === 'detect-sounds') {
            setModalState('showDetectModal', true);
          } else if (cmd === 'prev-file' && curWinId) {
            void stepFileInFolder(curWinId, -1);
          } else if (cmd === 'next-file' && curWinId) {
            void stepFileInFolder(curWinId, 1);
          } else if (cmd === 'toggle-timescale' && curWinId) {
            toggleTimeScaleMode(curWinId);
          } else if (
            cmd === 'tile_grid' ||
            cmd === 'tile_horizontal' ||
            cmd === 'tile_vertical' ||
            cmd === 'cascade' ||
            cmd === 'resize_all_to_active'
          ) {
            applyLayout(cmd);
          } else if (cmd === 'toggle_titlebars') {
            toggleAllTitlebars();
          } else if (cmd === 'clip_save') {
            setModalState('showKlipModal', true);
          } else if (cmd === 'hotkeys') {
            setModalState('showHotkeyModal', true);
          }
        });
      }
      await checkBackendHealth();
    })();

    return () => {
      if (cleanupMenu) cleanupMenu();
    };
  }, []);

  // Classic Syrinx keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const curWinId = activeWindowId;

      if (e.code === 'Space') {
        e.preventDefault();
        if (audioPlayer.getState().isPlaying) audioPlayer.stop();
        else handlePlayActive();
        return;
      }

      if (e.ctrlKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'k' && curWinId) {
          e.preventDefault();
          setModalState('showKlipModal', true);
          return;
        }
        if (k === 'g' && curWinId) {
          e.preventDefault();
          const val = window.prompt('Go to time (seconds):', '0');
          if (val !== null && !Number.isNaN(Number(val))) {
            gotoTimeInWindow(curWinId, Number(val));
          }
          return;
        }
        if (k === '0' && curWinId) {
          e.preventDefault();
          resetWindowZoom(curWinId);
          return;
        }
        return;
      }

      if (e.altKey && !e.ctrlKey && curWinId) {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          nudgeWindowGain(curWinId, 4);
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          nudgeWindowGain(curWinId, -4);
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          void stepFileInFolder(curWinId, -1);
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          void stepFileInFolder(curWinId, 1);
          return;
        }
        if (e.key.toLowerCase() === 't') {
          e.preventDefault();
          toggleTimeScaleMode(curWinId);
          return;
        }
        return;
      }

      if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        toggleAllCursors();
        return;
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'Enter') {
          const logged = logActiveSelection('');
          if (logged) e.preventDefault();
          return;
        }
        if (e.key === 'Delete' && selectedAnnotationId) {
          e.preventDefault();
          deleteAnnotation(selectedAnnotationId);
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          navigateAnnotation(-1);
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          navigateAnnotation(1);
          return;
        }
        if (e.key.toLowerCase() === 'p') {
          e.preventDefault();
          handlePlayActive();
          return;
        }
        if (e.key.length === 1) {
          const created = stampSelectionWithHotkey(e.key);
          if (created) e.preventDefault();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeWindowId,
    selectedAnnotationId,
    stampSelectionWithHotkey,
    logActiveSelection,
    deleteAnnotation,
    navigateAnnotation,
    nudgeWindowGain,
    stepFileInFolder,
    toggleTimeScaleMode,
    toggleAllCursors,
    resetWindowZoom,
    gotoTimeInWindow,
    windows,
    files,
    engine,
  ]);

  const activeWin = windows.find((w) => w.windowId === activeWindowId);
  const activeFile = activeWin ? files[activeWin.fileId] : undefined;
  const activeSpecReady = Boolean(
    activeWin && getCachedSpectrogram(specCache, activeWin.fileId, activeWin.specParams),
  );

  return (
    <div className="app-shell">
      <header className="top-toolbar">
        <button
          className="brand brand-btn"
          onClick={() => setModalState('showEngineModal', true)}
          title="Configure Python Engine URL (Cloud Run / Local)"
        >
          <span className="brand-mark">S1</span>
          <span className="brand-name">SyrinxOne</span>
          <span
            className={`conn-dot ${backendConnected ? 'ok' : 'down'}`}
            title={backendConnected ? `Engine v${backendVersion}` : 'Engine offline — click to configure URL'}
          />
        </button>

        <div className="toolbar-group">
          <button className="btn-small btn-primary" onClick={() => void handleOpenAudio()}>
            <FolderOpen size={13} /> Open
          </button>
          <button className="btn-small" onClick={() => setModalState('showFileBrowser', true)}>
            Sources
          </button>
          <button
            className="btn-small desktop-only"
            disabled={!activeWin}
            onClick={() => activeWin && void stepFileInFolder(activeWin.windowId, -1)}
            title="Previous audio file in folder (Alt+←)"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            className="btn-small desktop-only"
            disabled={!activeWin}
            onClick={() => activeWin && void stepFileInFolder(activeWin.windowId, 1)}
            title="Next audio file in folder (Alt+→)"
          >
            <ChevronRight size={13} />
          </button>
        </div>

        <div className="toolbar-group desktop-only" title="Workspace Display Files (.json)">
          <button
            className="btn-small"
            disabled={windows.length === 0}
            onClick={handleSaveDisplay}
            title="Save Entire Display layout to JSON"
          >
            <Save size={12} /> Display
          </button>
          <button
            className="btn-small"
            onClick={() => handleTriggerLoadDisplay(false)}
            title="Load saved Display layout"
          >
            <Upload size={12} /> Load
          </button>
          <input
            ref={displayInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={(e) => void handleDisplayFileChosen(e)}
          />
        </div>

        <div className="toolbar-group desktop-only" title="Classic Syrinx MDI Window Layouts">
          <button className="btn-small" onClick={() => applyLayout('tile_grid')} title="Tile Grid (R x C)">
            <Grid size={13} /> Grid
          </button>
          <button className="btn-small" onClick={() => applyLayout('tile_horizontal')} title="Tile Horizontal">
            <Rows size={13} />
          </button>
          <button className="btn-small" onClick={() => applyLayout('tile_vertical')} title="Tile Vertical">
            <Columns size={13} />
          </button>
          <button className="btn-small" onClick={() => applyLayout('cascade')} title="Cascade Windows">
            <Layers size={13} />
          </button>
          <button
            className="btn-small"
            onClick={() => applyLayout('resize_all_to_active')}
            title="Resize all windows to active window size"
          >
            Match
          </button>
          <button className="btn-small" onClick={() => toggleAllTitlebars()} title="Toggle child window titlebars">
            Bars
          </button>
          <button
            className="btn-small"
            disabled={!activeWin}
            onClick={() => activeWin && resetWindowZoom(activeWin.windowId)}
            title="Reset Full View (Ctrl+0)"
          >
            <Maximize size={12} />
          </button>
        </div>

        <div className="toolbar-group">
          <button className="btn-small" onClick={handlePlayActive} title="Play active view or selection (Space / P)">
            <Play size={13} />
          </button>
          <button className="btn-small" onClick={() => audioPlayer.stop()} title="Stop playback">
            <Square size={12} />
          </button>
          <button
            className={`btn-small ${playback.loop ? 'btn-active' : ''}`}
            onClick={() => audioPlayer.setLoop(!playback.loop)}
            title="Toggle loop playback"
          >
            <Repeat size={12} />
          </button>
          <select
            className="rate-select"
            value={playback.playbackRate}
            onChange={(e) => audioPlayer.setPlaybackRate(Number(e.target.value))}
            title="Playback Speed"
          >
            <option value={0.25}>0.25×</option>
            <option value={0.5}>0.5×</option>
            <option value={1}>1.0×</option>
            <option value={1.5}>1.5×</option>
            <option value={2}>2.0×</option>
          </select>
        </div>

        <div className="toolbar-group">
          <button
            className="btn-small"
            disabled={!activeWin?.selection}
            onClick={() => setModalState('showKlipModal', true)}
            title="Clip & Save Selection (Ctrl+K)"
          >
            <Scissors size={13} /> Clip
          </button>
          <button
            className="btn-small"
            disabled={!activeWin}
            onClick={() => setModalState('showDetectModal', true)}
            title="Detect Sounds in Recording"
          >
            <Radar size={13} /> Detect
          </button>
          <button
            className="btn-small"
            disabled={!activeSpecReady}
            onClick={() => void handleCopyActiveImage()}
            title="Copy Clean Spectrogram PNG to Clipboard"
          >
            <Camera size={13} /> Copy PNG
          </button>
          <button
            className="btn-small"
            onClick={() => setModalState('showHotkeyModal', true)}
            title="Configure Annotation Hotkeys"
          >
            <Keyboard size={13} /> Hotkeys
          </button>
        </div>

        <div className="toolbar-spacer" />

        {activeWin && activeFile?.isPartialWindow && (
          <div className="toolbar-group" title="Navigate time slices of a large cloud archive recording">
            <span className="window-badge mono">
              {Math.round(activeFile.windowStartSec ?? 0)}–
              {Math.round((activeFile.windowStartSec ?? 0) + activeFile.durationSec)}s /{' '}
              {Math.round(activeFile.totalDurationSec ?? activeFile.durationSec)}s
            </span>
            <button
              className="btn-small"
              onClick={() => void shiftArchiveWindow(activeWin.windowId, -1)}
              title="Load previous time window"
            >
              <ChevronLeft size={12} /> Win
            </button>
            <button
              className="btn-small"
              onClick={() => void shiftArchiveWindow(activeWin.windowId, 1)}
              title="Load next time window"
            >
              Win <ChevronRight size={12} />
            </button>
          </div>
        )}

        <div className="toolbar-group">
          <button
            className={`btn-small ${showAiPanel ? 'btn-active' : ''}`}
            onClick={() => setModalState('showAiPanel', !showAiPanel)}
            title="Toggle AI Bioacoustic Explorer Panel"
          >
            <Sparkles size={13} /> AI Explorer
          </button>
          <button
            className={`btn-small ${showSpecPanel ? 'btn-active' : ''}`}
            onClick={() => setModalState('showSpecPanel', !showSpecPanel)}
            title="Toggle Spectrogram Settings & Measurements Panel"
          >
            <SlidersHorizontal size={13} /> <PanelRight size={13} />
          </button>
          <button
            className={`btn-small ${showAnnotationDrawer ? 'btn-active' : ''}`}
            onClick={() => setModalState('showAnnotationDrawer', !showAnnotationDrawer)}
            title="Toggle Annotation Drawer"
          >
            <PanelBottom size={13} />
          </button>
        </div>
      </header>

      {errorMessage && (
        <div className="error-banner">
          <span>{errorMessage}</span>
          <button className="btn-small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="workspace-main">
        <div className="workspace-center">
          <MDIWorkspace />
          {showAnnotationDrawer && <AnnotationDrawer />}
        </div>
        {showSpecPanel && <SpecSettingsPanel />}
        {showAiPanel && <AiExplorerPanel />}
      </div>

      <footer className="status-bar">
        <span className="status-msg">{statusMessage}</span>
        <div className="cursor-readout mono">
          {cursorReadout ? (
            <>
              <span>Ch {cursorReadout.channel}</span>
              <span>t = {cursorReadout.timeSec.toFixed(4)} s</span>
              <span>f = {Math.round(cursorReadout.freqHz)} Hz</span>
              {cursorReadout.valueDb !== undefined && (
                <span>{cursorReadout.valueDb.toFixed(1)} dB</span>
              )}
            </>
          ) : (
            <span>Right-click spectrogram for tools · Double-click to play · Alt+←/→ prev/next file</span>
          )}
          {activeWin?.selection && (
            <span className="sel-readout">
              Sel: Δt = {Math.abs(activeWin.selection.endSec - activeWin.selection.startSec).toFixed(3)}s,
              Δf = {Math.round(Math.abs(activeWin.selection.highFreqHz - activeWin.selection.lowFreqHz))}Hz
            </span>
          )}
        </div>
      </footer>

      <FileBrowserModal />
      <EngineConnectionModal />
      <HotkeyConfigModal />
      <KlipnSaveModal />
      <DetectSoundsModal />
    </div>
  );
};
