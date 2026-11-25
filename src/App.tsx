import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Camera,
  ChevronLeft,
  ChevronRight,
  Columns,
  Database,
  FolderOpen,
  Grid,
  Keyboard,
  Layers,
  LogOut,
  Maximize,
  MoreHorizontal,
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
import { SourceModal } from './components/dialogs/SourceModal';
import { FileBrowserModal } from './components/dialogs/FileBrowserModal';
import { DetectSoundsModal } from './components/dialogs/DetectSoundsModal';
import { EngineConnectionModal } from './components/dialogs/EngineConnectionModal';
import { AiExplorerPanel } from './components/panels/AiExplorerPanel';
import { ArchiveTimelineBar } from './components/mdi/ArchiveTimelineBar';
import { GoogleSignInButton } from './components/auth/GoogleSignInButton';
import { googleSignIn, initAuth, logout, toGoogleUserProfile } from './auth/googleAuth';

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
  const errorMessage = useWorkspaceStore((s) => s.errorMessage);
  const setError = useWorkspaceStore((s) => s.setError);
  const setStatus = useWorkspaceStore((s) => s.setStatus);
  const engine = useWorkspaceStore((s) => s.engine);
  const windows = useWorkspaceStore((s) => s.windows);
  const activeWindowId = useWorkspaceStore((s) => s.activeWindowId);
  const files = useWorkspaceStore((s) => s.files);
  const specCache = useWorkspaceStore((s) => s.spectrogramCache);
  const selectedAnnotationId = useWorkspaceStore((s) => s.selectedAnnotationId);

  const activeSourceDisplayName = useWorkspaceStore((s) => s.activeSourceDisplayName);
  const mobilePane = useWorkspaceStore((s) => s.mobilePane);
  const setMobilePane = useWorkspaceStore((s) => s.setMobilePane);
  const openSourceSelector = useWorkspaceStore((s) => s.openSourceSelector);

  const showSpecPanel = useWorkspaceStore((s) => s.showSpecPanel);
  const showAiPanel = useWorkspaceStore((s) => s.showAiPanel);
  const showAnnotationDrawer = useWorkspaceStore((s) => s.showAnnotationDrawer);
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
  const googleUser = useWorkspaceStore((s) => s.googleUser);
  const hasDriveToken = useWorkspaceStore((s) => s.hasDriveToken);
  const setGoogleAuthState = useWorkspaceStore((s) => s.setGoogleAuthState);

  const [playback, setPlayback] = useState<PlaybackState>(() => audioPlayer.getState());
  const [googleSigningIn, setGoogleSigningIn] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 768 : false,
  );
  const [showMobileTools, setShowMobileTools] = useState(false);
  const [dragOffsetPx, setDragOffsetPx] = useState(0);

  const shellRef = useRef<HTMLDivElement | null>(null);
  const displayInputRef = useRef<HTMLInputElement | null>(null);
  const mergeDisplayFlagRef = useRef(false);
  const swipeTouchRef = useRef<{
    startX: number;
    startY: number;
    startTime: number;
    locked: 'horizontal' | 'vertical' | null;
    eligible: boolean;
  } | null>(null);

  useEffect(() => audioPlayer.subscribe(setPlayback), []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = () => setIsMobileViewport(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Keep mobile visualViewport synced when soft keyboard opens (keeps 3-screen swipe intact)
  useEffect(() => {
    const syncVv = () => {
      const el = shellRef.current;
      if (!el) return;
      if (!isMobileViewport) {
        el.style.removeProperty('--app-vv-height');
        return;
      }
      const vv = window.visualViewport;
      if (vv) {
        el.style.setProperty('--app-vv-height', `${Math.max(240, Math.round(vv.height))}px`);
      } else {
        el.style.setProperty('--app-vv-height', `${window.innerHeight}px`);
      }
    };
    syncVv();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', syncVv);
    window.addEventListener('resize', syncVv);
    return () => {
      vv?.removeEventListener('resize', syncVv);
      window.removeEventListener('resize', syncVv);
    };
  }, [isMobileViewport]);

  useEffect(() => {
    return initAuth(
      (user) => {
        setGoogleAuthState(toGoogleUserProfile(user), true);
      },
      (user) => {
        setGoogleAuthState(user ? toGoogleUserProfile(user) : null, false);
      },
    );
  }, [setGoogleAuthState]);

  const handleGoogleSignIn = async () => {
    setGoogleSigningIn(true);
    setError(null);
    try {
      const res = await googleSignIn();
      setGoogleAuthState(toGoogleUserProfile(res.user), true);
      setStatus(`Signed in with Google (${res.user.email ?? res.user.displayName ?? 'Drive ready'})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setGoogleSigningIn(false);
    }
  };

  const handleGoogleSignOut = async () => {
    await logout();
    setGoogleAuthState(null, false);
    setStatus('Signed out of Google');
  };

  const handleOpenRecordings = async () => {
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
    const start = activeWin.selection
      ? Math.min(activeWin.selection.startSec, activeWin.selection.endSec)
      : activeWin.viewRange.startSec;
    const end = activeWin.selection
      ? Math.max(activeWin.selection.startSec, activeWin.selection.endSec)
      : activeWin.viewRange.endSec;
    void audioPlayer.play(state.engine, file.fileId, start, end).catch((err) => {
      setError(err instanceof Error ? err.message : 'Unable to play audio');
    });
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
            void handleOpenRecordings();
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

  const handleSwipeTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMobileViewport || e.touches.length !== 1) return;
    const t = e.touches[0];
    const target = e.target as HTMLElement | null;

    if (
      target &&
      (target.closest('input, select, textarea') ||
        target.closest('.mobile-tab-strip') ||
        target.closest('.archive-bar-scrubber') ||
        target.closest('.spec-scrollbar-wrap'))
    ) {
      swipeTouchRef.current = null;
      return;
    }

    const inCanvas = Boolean(target?.closest('.spec-view-root canvas'));
    const inEdgeZone = t.clientX <= 24 || t.clientX >= window.innerWidth - 24;
    if (mobilePane === 1 && inCanvas && !inEdgeZone) {
      swipeTouchRef.current = null;
      return;
    }

    swipeTouchRef.current = {
      startX: t.clientX,
      startY: t.clientY,
      startTime: Date.now(),
      locked: null,
      eligible: true,
    };
  };

  const handleSwipeTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const st = swipeTouchRef.current;
    if (!st || !st.eligible || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - st.startX;
    const dy = t.clientY - st.startY;

    if (st.locked === null) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.25) {
        st.locked = 'horizontal';
      } else {
        st.locked = 'vertical';
        return;
      }
    }
    if (st.locked !== 'horizontal') return;

    // Dampen overscroll at screen edges (pane 0 right / pane 2 left)
    let clamped = dx;
    if ((mobilePane === 0 && dx > 0) || (mobilePane === 2 && dx < 0)) {
      clamped = dx * 0.25;
    }
    setDragOffsetPx(clamped);
  };

  const handleSwipeTouchEnd = () => {
    const st = swipeTouchRef.current;
    swipeTouchRef.current = null;
    if (!st || st.locked !== 'horizontal') {
      setDragOffsetPx(0);
      return;
    }
    const elapsed = Math.max(1, Date.now() - st.startTime);
    const velocity = Math.abs(dragOffsetPx) / elapsed;
    const threshold = Math.min(80, window.innerWidth * 0.2);

    let nextPane: 0 | 1 | 2 = mobilePane;
    if ((dragOffsetPx > threshold || (dragOffsetPx > 28 && velocity > 0.35)) && mobilePane > 0) {
      nextPane = (mobilePane - 1) as 0 | 1 | 2;
    } else if (
      (dragOffsetPx < -threshold || (dragOffsetPx < -28 && velocity > 0.35)) &&
      mobilePane < 2
    ) {
      nextPane = (mobilePane + 1) as 0 | 1 | 2;
    }
    setDragOffsetPx(0);
    if (nextPane !== mobilePane) {
      setMobilePane(nextPane);
    }
  };

  const activeWin = windows.find((w) => w.windowId === activeWindowId);
  const activeFile = activeWin ? files[activeWin.fileId] : undefined;
  const activeSpecReady = Boolean(
    activeWin && getCachedSpectrogram(specCache, activeWin.fileId, activeWin.specParams),
  );

  return (
    <div className="app-shell" ref={shellRef}>
      <header className="top-toolbar">
        <button
          className="brand brand-btn"
          onClick={() => setModalState('showEngineModal', true)}
          title="Configure Python Engine URL (Cloud Run / Local)"
        >
          <span className="brand-mark">S1</span>
          <span className="brand-name desktop-only">SyrinxOne</span>
          <span
            className={`conn-dot ${backendConnected ? 'ok' : 'down'}`}
            title={backendConnected ? `Engine v${backendVersion}` : 'Engine offline — click to configure URL'}
          />
        </button>

        {/* Primary Separated Flows: Source + Recordings */}
        <div className="toolbar-group">
          <button
            className="btn-small"
            onClick={() => openSourceSelector(false)}
            title={`Active Source: ${activeSourceDisplayName} — click to change or connect sources`}
          >
            <Database size={13} />
            <span>Source</span>
            <span className="desktop-only toolbar-source-name">· {activeSourceDisplayName}</span>
          </button>
          <button
            className="btn-small btn-primary"
            onClick={() => void handleOpenRecordings()}
            title="Browse & select single or combined recordings from the active source"
          >
            <FolderOpen size={13} />
            <span>Recordings</span>
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

        {/* Transport: Single compact Play/Stop toggle on mobile, full transport on desktop */}
        <div className="toolbar-group">
          {isMobileViewport ? (
            <button
              className={`btn-small ${playback.isPlaying ? 'btn-active' : ''}`}
              disabled={!activeWin}
              onClick={() => (playback.isPlaying ? audioPlayer.stop() : handlePlayActive())}
              title={playback.isPlaying ? 'Stop playback' : 'Play active view or selection'}
            >
              {playback.isPlaying ? <Square size={12} /> : <Play size={13} />}
            </button>
          ) : (
            <>
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
            </>
          )}
        </div>

        <div className="toolbar-group desktop-only">
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

        <div className="toolbar-group desktop-only">
          {hasDriveToken ? (
            <>
              <button
                className="btn-small gsi-account-chip"
                onClick={() => openSourceSelector(false)}
                title={`Signed in as ${googleUser?.email ?? 'Google User'}`}
              >
                <span className="gsi-account-dot" />
                <span className="gsi-account-label">
                  {googleUser?.email ?? googleUser?.displayName ?? 'Google Drive'}
                </span>
              </button>
              <button
                className="btn-small"
                onClick={() => void handleGoogleSignOut()}
                title="Sign out of Google"
              >
                <LogOut size={12} />
              </button>
            </>
          ) : (
            <GoogleSignInButton
              compact
              disabled={googleSigningIn}
              label={googleSigningIn ? 'Signing in...' : googleUser ? 'Reconnect Google' : 'Sign in with Google'}
              onClick={() => void handleGoogleSignIn()}
            />
          )}
        </div>

        <div className="toolbar-group desktop-only">
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

        {/* Mobile Compact Overflow Menu */}
        {isMobileViewport && (
          <div className="mobile-tools-wrap">
            <button
              className={`btn-small ${showMobileTools ? 'btn-active' : ''}`}
              onClick={() => setShowMobileTools((v) => !v)}
              title="Playback, Detector, Clip & Tools"
            >
              <MoreHorizontal size={15} />
            </button>

            {showMobileTools && (
              <>
                <div className="mobile-tools-backdrop" onClick={() => setShowMobileTools(false)} />
                <div className="mobile-tools-menu" onClick={(e) => e.stopPropagation()}>
                  <div className="mobile-tools-row">
                    <button
                      className={`btn-small ${playback.loop ? 'btn-active' : ''}`}
                      onClick={() => audioPlayer.setLoop(!playback.loop)}
                    >
                      <Repeat size={12} /> Loop
                    </button>
                    <select
                      className="rate-select"
                      value={playback.playbackRate}
                      onChange={(e) => audioPlayer.setPlaybackRate(Number(e.target.value))}
                    >
                      <option value={0.25}>0.25×</option>
                      <option value={0.5}>0.5×</option>
                      <option value={1}>1.0×</option>
                      <option value={1.5}>1.5×</option>
                      <option value={2}>2.0×</option>
                    </select>
                  </div>

                  <button
                    disabled={!activeWin}
                    onClick={() => {
                      setShowMobileTools(false);
                      setModalState('showDetectModal', true);
                    }}
                  >
                    <Radar size={13} /> Detect Sounds
                  </button>
                  <button
                    disabled={!activeWin?.selection}
                    onClick={() => {
                      setShowMobileTools(false);
                      setModalState('showKlipModal', true);
                    }}
                  >
                    <Scissors size={13} /> Clip Selection
                  </button>
                  <button
                    onClick={() => {
                      setShowMobileTools(false);
                      setMobilePane(1);
                      setModalState('showAnnotationDrawer', !showAnnotationDrawer);
                    }}
                  >
                    <PanelBottom size={13} /> {showAnnotationDrawer ? 'Hide Annotations' : 'Annotations'}
                  </button>
                  <button
                    disabled={!activeSpecReady}
                    onClick={() => {
                      setShowMobileTools(false);
                      void handleCopyActiveImage();
                    }}
                  >
                    <Camera size={13} /> Copy Spectrogram PNG
                  </button>
                  <button
                    onClick={() => {
                      setShowMobileTools(false);
                      setModalState('showHotkeyModal', true);
                    }}
                  >
                    <Keyboard size={13} /> Annotation Hotkeys
                  </button>
                  <hr />
                  {hasDriveToken ? (
                    <button
                      onClick={() => {
                        setShowMobileTools(false);
                        void handleGoogleSignOut();
                      }}
                    >
                      <LogOut size={13} /> Sign out ({googleUser?.email ?? 'Google'})
                    </button>
                  ) : (
                    <button
                      disabled={googleSigningIn}
                      onClick={() => {
                        setShowMobileTools(false);
                        void handleGoogleSignIn();
                      }}
                    >
                      Sign in with Google
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </header>

      {errorMessage && (
        <div className="error-banner">
          <span>{errorMessage}</span>
          <button className="btn-small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {isMobileViewport ? (
        <>
          <nav className="mobile-pane-bar" aria-label="Workspace Views">
            <button
              type="button"
              className={`mobile-pane-tab ${mobilePane === 0 ? 'active' : ''}`}
              onClick={() => setMobilePane(0)}
            >
              <SlidersHorizontal size={13} />
              <span>Settings</span>
            </button>
            <button
              type="button"
              className={`mobile-pane-tab ${mobilePane === 1 ? 'active' : ''}`}
              onClick={() => setMobilePane(1)}
            >
              <Activity size={13} />
              <span>Spectrogram</span>
            </button>
            <button
              type="button"
              className={`mobile-pane-tab ${mobilePane === 2 ? 'active' : ''}`}
              onClick={() => setMobilePane(2)}
            >
              <Sparkles size={13} />
              <span>AI</span>
            </button>
            <div
              className="mobile-pane-indicator"
              style={{ transform: `translate3d(${mobilePane * 100}%, 0, 0)` }}
            />
          </nav>

          <div
            className="mobile-swipe-viewport"
            onTouchStart={handleSwipeTouchStart}
            onTouchMove={handleSwipeTouchMove}
            onTouchEnd={handleSwipeTouchEnd}
            onTouchCancel={handleSwipeTouchEnd}
          >
            <div
              className={`mobile-swipe-track ${dragOffsetPx !== 0 ? 'dragging' : ''}`}
              style={{
                transform: `translate3d(calc(-${mobilePane * 100}% + ${dragOffsetPx}px), 0, 0)`,
              }}
            >
              <div className="mobile-swipe-pane">
                <SpecSettingsPanel />
              </div>

              <div className="mobile-swipe-pane mobile-center-pane">
                {activeWin && activeFile?.isPartialWindow && (
                  <ArchiveTimelineBar win={activeWin} file={activeFile} />
                )}
                <div className="workspace-center">
                  <MDIWorkspace />
                  {showAnnotationDrawer && <AnnotationDrawer />}
                </div>
              </div>

              <div className="mobile-swipe-pane">
                <AiExplorerPanel />
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          {activeWin && activeFile?.isPartialWindow && (
            <ArchiveTimelineBar win={activeWin} file={activeFile} />
          )}

          <div className="workspace-main">
            <div className="workspace-center">
              <MDIWorkspace />
              {showAnnotationDrawer && <AnnotationDrawer />}
            </div>
            {showSpecPanel && <SpecSettingsPanel />}
            {showAiPanel && <AiExplorerPanel />}
          </div>
        </>
      )}

      <SourceModal />
      <FileBrowserModal />
      <EngineConnectionModal />
      <HotkeyConfigModal />
      <KlipnSaveModal />
      <DetectSoundsModal />
    </div>
  );
};
