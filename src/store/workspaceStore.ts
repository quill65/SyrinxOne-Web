import { create } from 'zustand';
import {
  DEFAULT_ANNOTATION_FILTER,
  DEFAULT_DISPLAY_SETTINGS,
  DEFAULT_HOTKEY_BINDINGS,
  DEFAULT_SPECTROGRAM_PARAMS,
  HttpAudioEngineClient,
  type AnnotationFilter,
  type AnnotationFormat,
  type AnnotationRecord,
  type AudioFileInfo,
  type CursorReadout,
  type DisplaySettings,
  type HotkeyBinding,
  type LayoutCommand,
  type MDIWindowState,
  type SavedDisplayFile,
  type SelectionBox,
  type SelectionMeasurements,
  type SpectrogramMatrix,
  type SpectrogramParams,
  type SuggestedDetectParams,
  type TimeFreqRange,
  type WaveformOverview,
} from '@syrinxone/shared';
import type { GoogleUserProfile } from '../auth/googleAuth';
import { applyMdiLayout, type CanvasBounds } from '../utils/mdiLayout';
import {
  computeNormalizedGainDb,
  fetchSpectrogramAdaptive,
  formatDurationCompact,
  getSafeMaxWindowSec,
  normalizeAutoGainMode,
  type AutoGainMode,
} from '../utils/spectrogramFetch';
import {
  buildRecordingTimeContext,
  formatRecordingRange,
} from '../utils/timeFormat';
import { CombinedEngineProxy, isCombinedFileId } from '../utils/combinedEngine';
import {
  getRecordingViewState,
  makeCombinedRecordingKey,
  makeSingleRecordingKey,
  saveRecordingViewState,
  type SavedRecordingViewState,
  type SegmentSourceSpec,
} from '../utils/contiguousArchive';

const HOTKEYS_STORAGE_KEY = 'syrinxone.hotkeys.v1';
const DEFAULTS_STORAGE_KEY = 'syrinxone.windowDefaults.v1';
const ANNOTATIONS_STORAGE_KEY = 'syrinxone.annotations.v1';
const ENGINE_STORAGE_KEY = 'syrinxone.engineConfig.v1';
const ACTIVE_SOURCE_STORAGE_KEY = 'syrinxone.activeSource.v1';

function loadSavedActiveSource(): { sourceId: string; displayName: string } {
  try {
    const raw = localStorage.getItem(ACTIVE_SOURCE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { sourceId?: string; displayName?: string };
      if (typeof parsed.sourceId === 'string' && parsed.sourceId.trim()) {
        return {
          sourceId: parsed.sourceId.trim(),
          displayName:
            typeof parsed.displayName === 'string' && parsed.displayName.trim()
              ? parsed.displayName.trim()
              : parsed.sourceId.trim(),
        };
      }
    }
  } catch {
    // ignore storage errors
  }
  return { sourceId: 'local', displayName: 'Local Files' };
}

function loadSavedEngineConfig(): { baseUrl: string; token: string } {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  const envUrl = env?.VITE_API_URL || '';
  const envToken = env?.VITE_API_TOKEN || '';
  try {
    const params = new URLSearchParams(window.location.search);
    const queryApi = params.get('api');
    const queryToken = params.get('token');
    if (queryApi || queryToken) {
      const cfg = {
        baseUrl: (queryApi ?? envUrl).trim(),
        token: (queryToken ?? envToken).trim(),
      };
      localStorage.setItem(ENGINE_STORAGE_KEY, JSON.stringify(cfg));
      // Strip sensitive token query parameter from the visible URL bar after persisting
      if (queryToken && window.history?.replaceState) {
        params.delete('token');
        const nextSearch = params.toString();
        const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
        window.history.replaceState({}, '', nextUrl);
      }
      return cfg;
    }
    const raw = localStorage.getItem(ENGINE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { baseUrl?: string; token?: string };
      return {
        baseUrl:
          typeof parsed.baseUrl === 'string' && parsed.baseUrl.length > 0
            ? parsed.baseUrl
            : envUrl,
        token: typeof parsed.token === 'string' ? parsed.token : envToken,
      };
    }
  } catch {
    // ignore storage/window errors (e.g., SSR/tests)
  }
  return { baseUrl: envUrl, token: envToken };
}

function isNarrowMobileViewport(): boolean {
  try {
    return typeof window !== 'undefined' && window.innerWidth <= 768;
  } catch {
    return false;
  }
}

function loadSavedAnnotations(): {
  annotations: AnnotationRecord[];
  nonAnnotationLines: string[];
} {
  try {
    const raw = localStorage.getItem(ANNOTATIONS_STORAGE_KEY);
    if (!raw) return { annotations: [], nonAnnotationLines: [] };
    const parsed = JSON.parse(raw) as {
      annotations?: AnnotationRecord[];
      nonAnnotationLines?: string[];
    };
    return {
      annotations: Array.isArray(parsed.annotations) ? parsed.annotations : [],
      nonAnnotationLines: Array.isArray(parsed.nonAnnotationLines)
        ? parsed.nonAnnotationLines
        : [],
    };
  } catch {
    return { annotations: [], nonAnnotationLines: [] };
  }
}

function persistAnnotations(
  annotations: AnnotationRecord[],
  nonAnnotationLines: string[],
): void {
  try {
    localStorage.setItem(
      ANNOTATIONS_STORAGE_KEY,
      JSON.stringify({ annotations, nonAnnotationLines }),
    );
  } catch {
    // ignore storage quota errors
  }
}

function loadSavedHotkeys(): HotkeyBinding[] {
  try {
    const raw = localStorage.getItem(HOTKEYS_STORAGE_KEY);
    if (!raw) return DEFAULT_HOTKEY_BINDINGS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as HotkeyBinding[];
  } catch {
    // ignore storage errors
  }
  return DEFAULT_HOTKEY_BINDINGS;
}

function loadSavedDefaults(): {
  specParams: SpectrogramParams;
  displaySettings: DisplaySettings;
  autoGainMode: AutoGainMode;
} {
  try {
    const raw = localStorage.getItem(DEFAULTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        specParams?: Partial<SpectrogramParams>;
        displaySettings?: Partial<DisplaySettings>;
        autoGainMode?: AutoGainMode;
      };
      const autoGainMode = normalizeAutoGainMode(parsed.autoGainMode);
      return {
        specParams: { ...DEFAULT_SPECTROGRAM_PARAMS, ...(parsed.specParams ?? {}) },
        displaySettings: { ...DEFAULT_DISPLAY_SETTINGS, ...(parsed.displaySettings ?? {}) },
        autoGainMode,
      };
    }
  } catch {
    // ignore
  }
  return {
    specParams: { ...DEFAULT_SPECTROGRAM_PARAMS },
    displaySettings: { ...DEFAULT_DISPLAY_SETTINGS },
    autoGainMode: 'manual',
  };
}

function makeSpecCacheKey(fileId: string, params: SpectrogramParams): string {
  return [
    fileId,
    params.channel,
    params.fftSize,
    params.hopSize,
    params.windowType,
    params.dspMode,
    params.popFilter ? 1 : 0,
    params.classicGain,
    params.classicWhiteThresh,
  ].join('|');
}

function parentPrefix(uri: string): string {
  const norm = uri.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  if (idx <= 0) return '';
  const dir = uri.slice(0, idx);
  return dir.endsWith(':') ? `${dir}\\` : dir;
}

const viewSaveTimers = new Map<string, number>();

export interface WorkspaceStore {
  engine: CombinedEngineProxy;
  backendUrl: string;
  backendToken: string;
  backendConnected: boolean;
  backendVersion: string;
  statusMessage: string;
  errorMessage: string | null;

  files: Record<string, AudioFileInfo>;
  spectrogramCache: Record<string, SpectrogramMatrix>;
  waveformCache: Record<string, WaveformOverview>;

  windows: MDIWindowState[];
  activeWindowId: string | null;
  nextZIndex: number;
  canvasBounds: CanvasBounds;
  cursorReadout: CursorReadout | null;

  defaultSpecParams: SpectrogramParams;
  defaultDisplaySettings: DisplaySettings;
  defaultAutoGainMode: AutoGainMode;
  windowAutoGainMode: Record<string, AutoGainMode>;
  windowRecordingKeys: Record<string, string>;
  windowCombinedSegments: Record<string, SegmentSourceSpec[]>;

  annotations: AnnotationRecord[];
  nonAnnotationLines: string[];
  selectedAnnotationId: string | null;
  redefineAnnotationId: string | null;
  annotationFilter: AnnotationFilter;
  hotkeys: HotkeyBinding[];

  activeSourceId: string;
  activeSourceDisplayName: string;
  setActiveSource: (sourceId: string, displayName?: string) => void;

  mobilePane: 0 | 1 | 2;
  setMobilePane: (pane: 0 | 1 | 2) => void;

  showAnnotationDrawer: boolean;
  showSpecPanel: boolean;
  showAiPanel: boolean;
  showEngineModal: boolean;
  showSourceModal: boolean;
  showFileBrowser: boolean;
  showHotkeyModal: boolean;
  showKlipModal: boolean;
  showDetectModal: boolean;
  sourceReturnToBrowser: boolean;
  openSourceSelector: (returnToBrowser?: boolean) => void;
  suggestedDetectParams: SuggestedDetectParams | null;

  googleUser: GoogleUserProfile | null;
  hasDriveToken: boolean;
  setGoogleAuthState: (user: GoogleUserProfile | null, hasDriveToken: boolean) => void;

  setBackendConfig: (baseUrl: string, token?: string) => void;
  checkBackendHealth: () => Promise<void>;
  setCanvasBounds: (bounds: CanvasBounds) => void;
  setStatus: (msg: string) => void;
  setError: (err: string | null) => void;
  setCursorReadout: (readout: CursorReadout | null) => void;

  openAudioFromSource: (
    sourceId: string,
    uri: string,
    options?: { startSec?: number; maxDurationSec?: number; restoreSaved?: boolean },
  ) => Promise<void>;
  openCombinedArchive: (
    specs: SegmentSourceSpec[],
    title: string,
    options?: {
      startSec?: number;
      maxDurationSec?: number;
      recordingKey?: string;
      restoreSaved?: boolean;
    },
  ) => Promise<void>;
  restoreSavedRecordingView: (saved: SavedRecordingViewState) => Promise<void>;
  openAudioUrl: (
    url: string,
    options?: { startSec?: number; maxDurationSec?: number },
  ) => Promise<void>;
  loadAudioIntoWindow: (
    windowId: string,
    sourceId: string,
    uri: string,
    options?: { startSec?: number; maxDurationSec?: number },
  ) => Promise<void>;
  shiftArchiveWindow: (windowId: string, deltaWindows: -1 | 1) => Promise<void>;
  setArchiveWindow: (windowId: string, startSec: number, maxDurationSec?: number) => Promise<void>;
  stepFileInFolder: (windowId: string, delta: -1 | 1) => Promise<void>;
  openUploadedFile: (file: File) => Promise<void>;
  openAudioInfoInWindow: (
    info: AudioFileInfo,
    meta?: {
      recordingKey?: string;
      segments?: SegmentSourceSpec[];
      restoreState?: SavedRecordingViewState | null;
    },
  ) => Promise<string>;
  duplicateWindow: (windowId: string) => Promise<void>;

  ensureSpectrogram: (windowId: string) => Promise<void>;
  ensureWaveform: (windowId: string) => Promise<void>;

  focusWindow: (windowId: string) => void;
  closeWindow: (windowId: string) => void;
  updateWindowGeometry: (
    windowId: string,
    patch: Partial<
      Pick<MDIWindowState, 'x' | 'y' | 'width' | 'height' | 'minimized' | 'maximized' | 'showTitlebar'>
    >,
  ) => void;
  updateWindowViewRange: (windowId: string, range: TimeFreqRange) => void;
  resetWindowZoom: (windowId: string) => void;
  gotoTimeInWindow: (windowId: string, timeSec: number) => void;
  updateWindowSelection: (windowId: string, selection: SelectionBox | null) => void;
  updateWindowSpecParams: (windowId: string, patch: Partial<SpectrogramParams>) => Promise<void>;
  updateWindowDisplaySettings: (windowId: string, patch: Partial<DisplaySettings>) => void;
  setWindowAutoGainMode: (windowId: string, mode: AutoGainMode) => void;
  normalizeWindowGain: (
    windowId: string,
    options?: {
      scope?: 'full' | 'view' | 'selection';
      matrix?: SpectrogramMatrix;
      silent?: boolean;
    },
  ) => void;
  applySettingsToAllWindows: (sourceWindowId: string) => Promise<void>;
  makeActiveSettingsDefault: (sourceWindowId: string) => void;
  toggleTimeScaleMode: (windowId: string) => void;
  nudgeWindowGain: (windowId: string, deltaDb: number) => void;
  toggleAllCursors: () => void;
  toggleWindowLinkGroup: (windowId: string) => void;
  toggleAllTitlebars: () => void;
  applyLayout: (command: LayoutCommand) => void;

  exportDisplayJson: () => string;
  importDisplayJson: (jsonText: string, merge?: boolean) => Promise<void>;

  addAnnotation: (ann: Omit<AnnotationRecord, 'id'>) => AnnotationRecord;
  addDetectedAnnotations: (detections: AnnotationRecord[], replaceForSoundfile?: string) => void;
  stampSelectionWithHotkey: (key: string) => AnnotationRecord | null;
  logActiveSelection: (comment?: string) => AnnotationRecord | null;
  logSelectionWithMeasurements: (
    measurements: SelectionMeasurements,
    comment?: string,
  ) => AnnotationRecord | null;
  applySuggestedDetectParams: (params: SuggestedDetectParams) => void;
  clearSuggestedDetectParams: () => void;
  updateAnnotation: (id: string, patch: Partial<AnnotationRecord>) => void;
  deleteAnnotation: (id: string) => void;
  selectAnnotation: (id: string | null, jumpToView?: boolean) => void;
  navigateAnnotation: (dir: -1 | 1) => void;
  setRedefineAnnotationId: (id: string | null) => void;
  setAnnotationFilter: (patch: Partial<AnnotationFilter>) => void;
  setHotkeys: (bindings: HotkeyBinding[]) => void;

  importAnnotationsFromText: (content: string, format: AnnotationFormat) => Promise<void>;
  importAnnotationsFromSource: (
    sourceId: string,
    uri: string,
    format?: AnnotationFormat,
  ) => Promise<void>;
  exportAnnotationsAsText: (format: AnnotationFormat) => Promise<string>;
  saveAnnotationsToSource: (
    sourceId: string,
    uri: string,
    format: AnnotationFormat,
  ) => Promise<void>;

  setModalState: (
    key:
      | 'showAnnotationDrawer'
      | 'showSpecPanel'
      | 'showAiPanel'
      | 'showEngineModal'
      | 'showSourceModal'
      | 'showFileBrowser'
      | 'showHotkeyModal'
      | 'showKlipModal'
      | 'showDetectModal',
    value: boolean,
  ) => void;
}

const initialEngineConfig = loadSavedEngineConfig();
const initialDefaults = loadSavedDefaults();
const initialAnnotations = loadSavedAnnotations();
const initialActiveSource = loadSavedActiveSource();
const startMobile = isNarrowMobileViewport();

const initialHttpClient = new HttpAudioEngineClient({
  baseUrl: initialEngineConfig.baseUrl,
  token: initialEngineConfig.token || undefined,
});
const initialEngineProxy = new CombinedEngineProxy(initialHttpClient);

function schedulePersistView(getState: () => WorkspaceStore, windowId: string): void {
  const prevTimer = viewSaveTimers.get(windowId);
  if (prevTimer !== undefined) {
    window.clearTimeout(prevTimer);
  }
  const timer = window.setTimeout(() => {
    viewSaveTimers.delete(windowId);
    const s = getState();
    const win = s.windows.find((w) => w.windowId === windowId);
    if (!win) return;
    const file = s.files[win.fileId];
    if (!file || file.sourceId === 'upload') return;
    const segments = s.windowCombinedSegments[windowId];
    const recKey =
      s.windowRecordingKeys[windowId] ??
      (isCombinedFileId(file.fileId) && segments
        ? makeCombinedRecordingKey(file.sourceId, segments)
        : makeSingleRecordingKey(file.sourceId, file.uri));

    saveRecordingViewState({
      recordingKey: recKey,
      kind: isCombinedFileId(file.fileId) ? 'combined' : 'single',
      sourceId: file.sourceId,
      uri: file.uri,
      label: file.name,
      segments,
      windowStartSec: file.windowStartSec ?? 0,
      windowDurationSec: file.isPartialWindow ? Math.round(file.durationSec) : undefined,
      viewRange: { ...win.viewRange },
      channel: win.specParams.channel,
      specParams: { ...win.specParams },
      displaySettings: { ...win.displaySettings },
      autoGainMode: s.windowAutoGainMode[windowId] ?? 'manual',
      startDateTimeIso: file.startDateTimeIso ?? null,
      totalDurationSec: file.totalDurationSec ?? file.durationSec,
      lastViewedAt: Date.now(),
    });
  }, 260);
  viewSaveTimers.set(windowId, timer);
}

function formatWindowRangeTitle(info: AudioFileInfo, engine: CombinedEngineProxy): string {
  if (!info.isPartialWindow) return info.name;
  const combinedRec = isCombinedFileId(info.fileId)
    ? engine.getCombinedRecording(info.fileId)
    : undefined;
  const ctx = buildRecordingTimeContext(info, combinedRec?.segments);
  const s = info.windowStartSec ?? 0;
  const rng = formatRecordingRange(
    s,
    s + info.durationSec,
    info.totalDurationSec ?? info.durationSec,
    ctx,
  );
  return `${info.name} [${rng.startLabel}–${rng.endLabel}]`;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => {
  initialEngineProxy.setOnDurationUpdated((updatedInfo) => {
    set((s) => {
      if (!s.files[updatedInfo.fileId]) return s;
      return {
        files: { ...s.files, [updatedInfo.fileId]: updatedInfo },
      };
    });
  });

  return {
  engine: initialEngineProxy,
  backendUrl: initialEngineConfig.baseUrl,
  backendToken: initialEngineConfig.token,
  backendConnected: false,
  backendVersion: '',
  statusMessage: 'Ready — open a local file or browse MBARI / NOAA / Google Drive archives',
  errorMessage: null,

  files: {},
  spectrogramCache: {},
  waveformCache: {},

  windows: [],
  activeWindowId: null,
  nextZIndex: 1,
  canvasBounds: { width: 1200, height: 700 },
  cursorReadout: null,

  defaultSpecParams: initialDefaults.specParams,
  defaultDisplaySettings: initialDefaults.displaySettings,
  defaultAutoGainMode: initialDefaults.autoGainMode,
  windowAutoGainMode: {},
  windowRecordingKeys: {},
  windowCombinedSegments: {},

  annotations: initialAnnotations.annotations,
  nonAnnotationLines: initialAnnotations.nonAnnotationLines,
  selectedAnnotationId: null,
  redefineAnnotationId: null,
  annotationFilter: { ...DEFAULT_ANNOTATION_FILTER },
  hotkeys: loadSavedHotkeys(),

  activeSourceId: initialActiveSource.sourceId,
  activeSourceDisplayName: initialActiveSource.displayName,
  setActiveSource: (sourceId, displayName) => {
    const cleanId = sourceId.trim() || 'local';
    const cleanLabel =
      displayName?.trim() ||
      (cleanId === 'local'
        ? 'Local Files'
        : cleanId === 'gdrive_oauth'
          ? 'Google Drive'
          : cleanId === 'http'
            ? 'Direct URL'
            : cleanId);
    try {
      localStorage.setItem(
        ACTIVE_SOURCE_STORAGE_KEY,
        JSON.stringify({ sourceId: cleanId, displayName: cleanLabel }),
      );
    } catch {
      // ignore storage errors
    }
    set({ activeSourceId: cleanId, activeSourceDisplayName: cleanLabel });
  },

  mobilePane: 1,
  setMobilePane: (pane) =>
    set({
      mobilePane: pane,
      ...(isNarrowMobileViewport()
        ? { showAnnotationDrawer: false }
        : {}),
    }),

  showAnnotationDrawer: !startMobile,
  showSpecPanel: !startMobile,
  showAiPanel: false,
  showEngineModal: false,
  showSourceModal: false,
  showFileBrowser: false,
  showHotkeyModal: false,
  showKlipModal: false,
  showDetectModal: false,
  sourceReturnToBrowser: false,
  openSourceSelector: (returnToBrowser = false) =>
    set({
      showSourceModal: true,
      showFileBrowser: false,
      sourceReturnToBrowser: returnToBrowser,
    }),
  suggestedDetectParams: null,

  googleUser: null,
  hasDriveToken: false,
  setGoogleAuthState: (googleUser, hasDriveToken) => set({ googleUser, hasDriveToken }),

  setBackendConfig: (baseUrl, token) => {
    const cleanUrl = baseUrl.trim().replace(/\/+$/, '');
    const cleanToken = (token ?? '').trim();
    get().engine.setConfig({ baseUrl: cleanUrl, token: cleanToken || undefined });
    try {
      localStorage.setItem(
        ENGINE_STORAGE_KEY,
        JSON.stringify({ baseUrl: cleanUrl, token: cleanToken }),
      );
    } catch {
      // ignore
    }
    set({ backendUrl: cleanUrl, backendToken: cleanToken });
  },

  checkBackendHealth: async () => {
    try {
      const h = await get().engine.health();
      set({
        backendConnected: true,
        backendVersion: h.version,
        errorMessage: null,
      });
    } catch (err) {
      set({
        backendConnected: false,
        errorMessage: err instanceof Error ? err.message : 'Backend unreachable',
      });
    }
  },

  setCanvasBounds: (bounds) => set({ canvasBounds: bounds }),
  setStatus: (msg) => set({ statusMessage: msg }),
  setError: (err) => set({ errorMessage: err }),
  setCursorReadout: (cursorReadout) => set({ cursorReadout }),

  openAudioFromSource: async (sourceId, uri, options) => {
    try {
      const recKey = makeSingleRecordingKey(sourceId, uri);
      const saved =
        options?.restoreSaved !== false &&
        options?.startSec === undefined &&
        options?.maxDurationSec === undefined
          ? getRecordingViewState(recKey)
          : null;
      const openOpts =
        saved && (saved.windowStartSec > 0 || saved.windowDurationSec !== undefined)
          ? {
              startSec: saved.windowStartSec,
              ...(saved.windowDurationSec !== undefined
                ? { maxDurationSec: saved.windowDurationSec }
                : {}),
            }
          : options
            ? {
                ...(options.startSec !== undefined ? { startSec: options.startSec } : {}),
                ...(options.maxDurationSec !== undefined
                  ? { maxDurationSec: options.maxDurationSec }
                  : {}),
              }
            : undefined;

      set({ statusMessage: `Opening ${uri}...`, errorMessage: null });
      const info = await get().engine.openAudio(sourceId, uri, openOpts);
      await get().openAudioInfoInWindow(info, {
        recordingKey: recKey,
        restoreState: options?.restoreSaved !== false ? (saved ?? getRecordingViewState(recKey)) : null,
      });
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : 'Failed to open audio file',
      });
    }
  },

  openCombinedArchive: async (specs, title, options) => {
    if (specs.length === 0) return;
    if (specs.length === 1) {
      await get().openAudioFromSource(specs[0].sourceId, specs[0].uri, {
        startSec: options?.startSec,
        maxDurationSec: options?.maxDurationSec,
        restoreSaved: options?.restoreSaved,
      });
      return;
    }
    try {
      const recKey =
        options?.recordingKey ?? makeCombinedRecordingKey(specs[0].sourceId, specs);
      const saved = options?.restoreSaved !== false ? getRecordingViewState(recKey) : null;
      const useSavedSlice =
        saved &&
        options?.startSec === undefined &&
        options?.maxDurationSec === undefined;
      const openOpts = useSavedSlice
        ? {
            startSec: saved.windowStartSec,
            ...(saved.windowDurationSec !== undefined
              ? { maxDurationSec: saved.windowDurationSec }
              : {}),
          }
        : options
          ? {
              ...(options.startSec !== undefined ? { startSec: options.startSec } : {}),
              ...(options.maxDurationSec !== undefined
                ? { maxDurationSec: options.maxDurationSec }
                : {}),
            }
          : undefined;

      set({
        statusMessage: `Combining ${specs.length} contiguous recordings (${title})...`,
        errorMessage: null,
      });
      const info = await get().engine.openCombinedArchive(specs, title, recKey, openOpts);
      await get().openAudioInfoInWindow(info, {
        recordingKey: recKey,
        segments: specs,
        restoreState: options?.restoreSaved !== false ? saved : null,
      });
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : 'Failed to open combined archive',
      });
    }
  },

  restoreSavedRecordingView: async (saved) => {
    if (saved.kind === 'combined' && saved.segments && saved.segments.length > 1) {
      await get().openCombinedArchive(saved.segments, saved.label, {
        recordingKey: saved.recordingKey,
        restoreSaved: true,
      });
    } else {
      await get().openAudioFromSource(saved.sourceId, saved.uri, {
        restoreSaved: true,
      });
    }
  },

  openAudioUrl: async (url, options) => {
    await get().openAudioFromSource('http', url, options);
  },

  loadAudioIntoWindow: async (windowId, sourceId, uri, options) => {
    try {
      set({ statusMessage: `Loading ${uri} into active window...`, errorMessage: null });
      const info = await get().engine.openAudio(sourceId, uri, options);
      const nyquist = info.sampleRate / 2;
      const recKey = makeSingleRecordingKey(sourceId, uri);
      set((s) => {
        const nextSegments = { ...s.windowCombinedSegments };
        delete nextSegments[windowId];
        return {
          files: { ...s.files, [info.fileId]: info },
          windowRecordingKeys: { ...s.windowRecordingKeys, [windowId]: recKey },
          windowCombinedSegments: nextSegments,
          windows: s.windows.map((w) => {
            if (w.windowId !== windowId) return w;
            const safeChannel = Math.min(w.specParams.channel, Math.max(0, info.numChannels - 1));
            const plotW = Math.max(200, w.width - (w.displaySettings.showAxes ? 54 : 0));
            const fixedEnd =
              w.displaySettings.timeScaleMode === 'fixed'
                ? Math.min(info.durationSec, (plotW * w.displaySettings.msPerPixel) / 1000)
                : info.durationSec;
            return {
              ...w,
              fileId: info.fileId,
              title: formatWindowRangeTitle(info, s.engine),
              selection: null,
              specParams: { ...w.specParams, channel: safeChannel },
              viewRange: {
                startSec: 0,
                endSec: Math.max(0.01, fixedEnd),
                minFreqHz: Math.min(w.viewRange.minFreqHz, nyquist * 0.9),
                maxFreqHz: Math.min(nyquist, Math.max(w.viewRange.maxFreqHz, nyquist)),
              },
            };
          }),
          statusMessage: `Loaded ${info.name} (${info.sampleRate} Hz, ${formatDurationCompact(info.durationSec)})`,
          mobilePane: 1,
        };
      });
      schedulePersistView(get, windowId);
      await Promise.all([get().ensureSpectrogram(windowId), get().ensureWaveform(windowId)]);
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : 'Failed to load file' });
    }
  },

  shiftArchiveWindow: async (windowId, deltaWindows) => {
    const state = get();
    const win = state.windows.find((w) => w.windowId === windowId);
    if (!win) return;
    const file = state.files[win.fileId];
    if (!file || !file.isPartialWindow) return;
    const winLen = Math.max(5, Math.round(file.durationSec));
    const curStart = file.windowStartSec ?? 0;
    const totalDur = file.totalDurationSec ?? curStart + winLen;
    const nextStart = Math.max(0, Math.min(Math.max(0, totalDur - winLen), curStart + deltaWindows * winLen));
    if (Math.abs(nextStart - curStart) < 0.01) {
      set({ statusMessage: deltaWindows < 0 ? 'Already at start of recording' : 'Already at end of recording' });
      return;
    }
    await get().setArchiveWindow(windowId, nextStart, winLen);
  },

  setArchiveWindow: async (windowId, startSec, maxDurationSec) => {
    const state = get();
    const win = state.windows.find((w) => w.windowId === windowId);
    if (!win) return;
    const file = state.files[win.fileId];
    if (!file) return;
    const totalDur = file.totalDurationSec ?? file.durationSec;
    const safeMax = getSafeMaxWindowSec(file.sampleRate, file.numChannels);
    const requestedLen = maxDurationSec ?? file.durationSec;
    const nextLen = Math.max(5, Math.min(totalDur, safeMax, Math.round(requestedLen)));
    const nextStart = Math.max(0, Math.min(Math.max(0, totalDur - nextLen), startSec));

    if (isCombinedFileId(file.fileId)) {
      const nextInfo = state.engine.setCombinedWindow(file.fileId, nextStart, nextLen);
      if (!nextInfo) return;
      const nyquist = nextInfo.sampleRate / 2;
      set((s) => {
        const nextSpecCache: Record<string, SpectrogramMatrix> = {};
        for (const [k, v] of Object.entries(s.spectrogramCache)) {
          if (!k.startsWith(`${file.fileId}|`)) nextSpecCache[k] = v;
        }
        const nextWaveCache: Record<string, WaveformOverview> = {};
        for (const [k, v] of Object.entries(s.waveformCache)) {
          if (!k.startsWith(`${file.fileId}|`)) nextWaveCache[k] = v;
        }
        return {
          files: { ...s.files, [nextInfo.fileId]: nextInfo },
          spectrogramCache: nextSpecCache,
          waveformCache: nextWaveCache,
          windows: s.windows.map((w) => {
            if (w.windowId !== windowId) return w;
            const plotW = Math.max(200, w.width - (w.displaySettings.showAxes ? 54 : 0));
            const fixedEnd =
              w.displaySettings.timeScaleMode === 'fixed'
                ? Math.min(nextInfo.durationSec, (plotW * w.displaySettings.msPerPixel) / 1000)
                : nextInfo.durationSec;
            return {
              ...w,
              title: formatWindowRangeTitle(nextInfo, state.engine),
              selection: null,
              viewRange: {
                startSec: 0,
                endSec: Math.max(0.01, fixedEnd),
                minFreqHz: Math.min(w.viewRange.minFreqHz, nyquist * 0.9),
                maxFreqHz: Math.min(nyquist, Math.max(w.viewRange.maxFreqHz, nyquist)),
              },
            };
          }),
          statusMessage: `Loaded ${formatWindowRangeTitle(nextInfo, state.engine)}`,
        };
      });
      schedulePersistView(get, windowId);
      await Promise.all([get().ensureSpectrogram(windowId), get().ensureWaveform(windowId)]);
      return;
    }

    await get().loadAudioIntoWindow(windowId, file.sourceId, file.uri, {
      startSec: nextStart,
      maxDurationSec: nextLen,
    });
  },

  stepFileInFolder: async (windowId, delta) => {
    const state = get();
    const win = state.windows.find((w) => w.windowId === windowId);
    if (!win) return;
    const file = state.files[win.fileId];
    if (!file || file.sourceId === 'upload' || isCombinedFileId(file.fileId)) {
      set({
        statusMessage: isCombinedFileId(file?.fileId)
          ? 'Use the Archive Timeline bar above to scrub across combined segments'
          : 'Folder stepping requires a local or cloud source file',
      });
      return;
    }
    try {
      const folder = parentPrefix(file.uri);
      const entries = await state.engine.browseSource(file.sourceId, folder);
      const audioFiles = entries
        .filter((e) => !e.isDir && e.kind === 'audio')
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      if (audioFiles.length < 2) {
        set({ statusMessage: 'No other audio files in this folder' });
        return;
      }
      const curIdx = audioFiles.findIndex(
        (e) => e.uri.toLowerCase() === file.uri.toLowerCase() || e.name.toLowerCase() === file.name.toLowerCase(),
      );
      const nextIdx =
        curIdx < 0
          ? 0
          : (curIdx + delta + audioFiles.length) % audioFiles.length;
      await get().loadAudioIntoWindow(windowId, file.sourceId, audioFiles[nextIdx].uri);
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : 'Failed to step folder' });
    }
  },

  openUploadedFile: async (file) => {
    try {
      set({ statusMessage: `Loading ${file.name}...`, errorMessage: null });
      const info = await get().engine.uploadAudio(file);
      await get().openAudioInfoInWindow(info);
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : 'Failed to upload audio file',
      });
    }
  },

  openAudioInfoInWindow: async (info, meta) => {
    const state = get();
    const winId = `win-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const offset = (state.windows.length % 8) * 28;
    const nyquist = info.sampleRate / 2;
    const width = Math.min(760, Math.max(480, state.canvasBounds.width - 80));
    const height = Math.min(440, Math.max(300, state.canvasBounds.height - 80));

    const saved = meta?.restoreState ?? null;
    const disp: DisplaySettings = {
      ...state.defaultDisplaySettings,
      ...(saved?.displaySettings ?? {}),
      lockSettings: false,
    };
    const spec: SpectrogramParams = {
      ...state.defaultSpecParams,
      ...(saved?.specParams ?? {}),
      channel: Math.min(
        saved?.channel ?? saved?.specParams?.channel ?? state.defaultSpecParams.channel,
        Math.max(0, info.numChannels - 1),
      ),
    };
    const autoMode: AutoGainMode = normalizeAutoGainMode(
      saved?.autoGainMode ?? state.defaultAutoGainMode,
    );

    const plotW = Math.max(200, width - (disp.showAxes ? 54 : 0));
    const defaultEndSec =
      disp.timeScaleMode === 'fixed'
        ? Math.min(info.durationSec, Math.max(0.05, (plotW * disp.msPerPixel) / 1000))
        : info.durationSec;

    let restoredRange: TimeFreqRange = {
      startSec: 0,
      endSec: defaultEndSec,
      minFreqHz: 0,
      maxFreqHz: nyquist,
    };
    if (saved?.viewRange) {
      const sT = Math.max(0, Math.min(Math.max(0, info.durationSec - 0.05), saved.viewRange.startSec));
      const eT = Math.max(sT + 0.05, Math.min(info.durationSec, saved.viewRange.endSec));
      const minF = Math.max(0, Math.min(Math.max(0, nyquist - 10), saved.viewRange.minFreqHz));
      const maxF = Math.max(minF + 10, Math.min(nyquist, saved.viewRange.maxFreqHz));
      restoredRange = { startSec: sT, endSec: eT, minFreqHz: minF, maxFreqHz: maxF };
    }

    const recKey =
      meta?.recordingKey ??
      (info.sourceId !== 'upload' ? makeSingleRecordingKey(info.sourceId, info.uri) : undefined);

    const newWin: MDIWindowState = {
      windowId: winId,
      fileId: info.fileId,
      title: formatWindowRangeTitle(info, state.engine),
      x: 16 + offset,
      y: 16 + offset,
      width,
      height,
      zIndex: state.nextZIndex,
      minimized: false,
      maximized: false,
      showTitlebar: true,
      linkGroupId: null,
      viewRange: restoredRange,
      specParams: spec,
      displaySettings: disp,
      selection: null,
    };

    set({
      files: { ...state.files, [info.fileId]: info },
      windows: [...state.windows, newWin],
      windowAutoGainMode: {
        ...state.windowAutoGainMode,
        [winId]: autoMode,
      },
      windowRecordingKeys: recKey
        ? { ...state.windowRecordingKeys, [winId]: recKey }
        : state.windowRecordingKeys,
      windowCombinedSegments: meta?.segments
        ? { ...state.windowCombinedSegments, [winId]: meta.segments }
        : state.windowCombinedSegments,
      activeWindowId: winId,
      nextZIndex: state.nextZIndex + 1,
      mobilePane: 1,
      statusMessage: saved
        ? `Restored "${info.name}" as previously viewed (${info.sampleRate} Hz, ${formatDurationCompact(info.durationSec)})`
        : `Opened ${info.name} (${info.sampleRate} Hz, ${info.numChannels} ch, ${formatDurationCompact(info.durationSec)})`,
    });

    schedulePersistView(get, winId);
    await Promise.all([get().ensureSpectrogram(winId), get().ensureWaveform(winId)]);
    return winId;
  },

  duplicateWindow: async (windowId) => {
    const state = get();
    const src = state.windows.find((w) => w.windowId === windowId);
    if (!src) return;
    const winId = `win-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const copy: MDIWindowState = {
      ...src,
      windowId: winId,
      x: src.x + 28,
      y: src.y + 28,
      zIndex: state.nextZIndex,
      maximized: false,
      minimized: false,
      selection: null,
      viewRange: { ...src.viewRange },
      specParams: { ...src.specParams },
      displaySettings: { ...src.displaySettings },
    };
    const recKey = state.windowRecordingKeys[windowId];
    const segs = state.windowCombinedSegments[windowId];
    set({
      windows: [...state.windows, copy],
      windowAutoGainMode: {
        ...state.windowAutoGainMode,
        [winId]: state.windowAutoGainMode[windowId] ?? state.defaultAutoGainMode,
      },
      windowRecordingKeys: recKey
        ? { ...state.windowRecordingKeys, [winId]: recKey }
        : state.windowRecordingKeys,
      windowCombinedSegments: segs
        ? { ...state.windowCombinedSegments, [winId]: segs }
        : state.windowCombinedSegments,
      activeWindowId: winId,
      nextZIndex: state.nextZIndex + 1,
      statusMessage: `Duplicated window: ${src.title}`,
    });
    await Promise.all([get().ensureSpectrogram(winId), get().ensureWaveform(winId)]);
  },

  ensureSpectrogram: async (windowId) => {
    const state = get();
    const win = state.windows.find((w) => w.windowId === windowId);
    if (!win) return;
    const file = state.files[win.fileId];
    if (!file) return;
    const key = makeSpecCacheKey(win.fileId, win.specParams);
    const cached = state.spectrogramCache[key];
    if (cached) {
      const mode = normalizeAutoGainMode(state.windowAutoGainMode[windowId]);
      if (mode === 'auto') {
        get().normalizeWindowGain(windowId, {
          scope: 'view',
          matrix: cached,
          silent: true,
        });
      }
      return;
    }
    try {
      const mat = await fetchSpectrogramAdaptive(state.engine, file, win.specParams);
      set((s) => ({
        spectrogramCache: { ...s.spectrogramCache, [key]: mat },
      }));
      const mode = normalizeAutoGainMode(get().windowAutoGainMode[windowId]);
      if (mode === 'auto') {
        get().normalizeWindowGain(windowId, {
          scope: 'view',
          matrix: mat,
          silent: true,
        });
      }
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : 'Spectrogram compute failed' });
    }
  },

  ensureWaveform: async (windowId) => {
    const state = get();
    const win = state.windows.find((w) => w.windowId === windowId);
    if (!win) return;
    const key = `${win.fileId}|${win.specParams.channel}`;
    if (state.waveformCache[key]) return;
    try {
      const wf = await state.engine.getWaveform(win.fileId, win.specParams.channel, 2000);
      set((s) => ({
        waveformCache: { ...s.waveformCache, [key]: wf },
      }));
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : 'Waveform fetch failed' });
    }
  },

  focusWindow: (windowId) =>
    set((s) => ({
      activeWindowId: windowId,
      nextZIndex: s.nextZIndex + 1,
      windows: s.windows.map((w) =>
        w.windowId === windowId ? { ...w, zIndex: s.nextZIndex, minimized: false } : w,
      ),
    })),

  closeWindow: (windowId) => {
    const prevTimer = viewSaveTimers.get(windowId);
    if (prevTimer !== undefined) {
      window.clearTimeout(prevTimer);
      viewSaveTimers.delete(windowId);
    }
    const curState = get();
    const closingWin = curState.windows.find((w) => w.windowId === windowId);
    const closingFile = closingWin ? curState.files[closingWin.fileId] : undefined;
    if (closingWin && closingFile && closingFile.sourceId !== 'upload') {
      const segments = curState.windowCombinedSegments[windowId];
      const recKey =
        curState.windowRecordingKeys[windowId] ??
        (isCombinedFileId(closingFile.fileId) && segments
          ? makeCombinedRecordingKey(closingFile.sourceId, segments)
          : makeSingleRecordingKey(closingFile.sourceId, closingFile.uri));
      saveRecordingViewState({
        recordingKey: recKey,
        kind: isCombinedFileId(closingFile.fileId) ? 'combined' : 'single',
        sourceId: closingFile.sourceId,
        uri: closingFile.uri,
        label: closingFile.name,
        segments,
        windowStartSec: closingFile.windowStartSec ?? 0,
        windowDurationSec: closingFile.isPartialWindow ? Math.round(closingFile.durationSec) : undefined,
        viewRange: { ...closingWin.viewRange },
        channel: closingWin.specParams.channel,
        specParams: { ...closingWin.specParams },
        displaySettings: { ...closingWin.displaySettings },
        autoGainMode: curState.windowAutoGainMode[windowId] ?? 'manual',
        lastViewedAt: Date.now(),
      });
    }

    set((s) => {
      const remaining = s.windows.filter((w) => w.windowId !== windowId);
      const nextActive =
        s.activeWindowId === windowId
          ? remaining.length > 0
            ? remaining.reduce((a, b) => (a.zIndex > b.zIndex ? a : b)).windowId
            : null
          : s.activeWindowId;
      const nextModes = { ...s.windowAutoGainMode };
      delete nextModes[windowId];
      const nextKeys = { ...s.windowRecordingKeys };
      delete nextKeys[windowId];
      const nextSegments = { ...s.windowCombinedSegments };
      delete nextSegments[windowId];
      return {
        windows: remaining,
        activeWindowId: nextActive,
        windowAutoGainMode: nextModes,
        windowRecordingKeys: nextKeys,
        windowCombinedSegments: nextSegments,
      };
    });
  },

  updateWindowGeometry: (windowId, patch) =>
    set((s) => ({
      windows: s.windows.map((w) => {
        if (w.windowId !== windowId) return w;
        const nextWin = { ...w, ...patch };
        const file = s.files[w.fileId];
        if (
          file &&
          nextWin.displaySettings.timeScaleMode === 'fixed' &&
          (patch.width !== undefined || patch.maximized !== undefined)
        ) {
          const effW = nextWin.maximized ? s.canvasBounds.width : nextWin.width;
          const plotW = Math.max(100, effW - (nextWin.displaySettings.showAxes ? 54 : 0));
          const span = Math.min(file.durationSec, Math.max(0.05, (plotW * nextWin.displaySettings.msPerPixel) / 1000));
          const startSec = Math.max(0, Math.min(file.durationSec - span, nextWin.viewRange.startSec));
          nextWin.viewRange = { ...nextWin.viewRange, startSec, endSec: startSec + span };
        }
        return nextWin;
      }),
    })),

  updateWindowViewRange: (windowId, range) => {
    const linkedIds: string[] = [];
    set((s) => {
      const target = s.windows.find((w) => w.windowId === windowId);
      if (!target) return s;
      const group = target.linkGroupId;
      return {
        windows: s.windows.map((w) => {
          if (w.windowId === windowId) return { ...w, viewRange: range };
          if (group && w.linkGroupId === group) {
            linkedIds.push(w.windowId);
            const file = s.files[w.fileId];
            const maxT = file ? file.durationSec : range.endSec;
            const maxF = file ? file.sampleRate / 2 : range.maxFreqHz;
            return {
              ...w,
              viewRange: {
                startSec: Math.max(0, Math.min(maxT, range.startSec)),
                endSec: Math.max(0.01, Math.min(maxT, range.endSec)),
                minFreqHz: Math.max(0, Math.min(maxF, range.minFreqHz)),
                maxFreqHz: Math.max(10, Math.min(maxF, range.maxFreqHz)),
              },
            };
          }
          return w;
        }),
      };
    });
    schedulePersistView(get, windowId);
    for (const lid of linkedIds) schedulePersistView(get, lid);
  },

  resetWindowZoom: (windowId) => {
    set((s) => ({
      windows: s.windows.map((w) => {
        if (w.windowId !== windowId) return w;
        const file = s.files[w.fileId];
        if (!file) return w;
        return {
          ...w,
          displaySettings: { ...w.displaySettings, timeScaleMode: 'stretch' },
          viewRange: {
            startSec: 0,
            endSec: file.durationSec,
            minFreqHz: 0,
            maxFreqHz: file.sampleRate / 2,
          },
        };
      }),
    }));
    schedulePersistView(get, windowId);
  },

  gotoTimeInWindow: (windowId, timeSec) => {
    set((s) => ({
      windows: s.windows.map((w) => {
        if (w.windowId !== windowId) return w;
        const file = s.files[w.fileId];
        if (!file) return w;
        const span = Math.max(0.05, w.viewRange.endSec - w.viewRange.startSec);
        const startSec = Math.max(0, Math.min(file.durationSec - span, timeSec - span / 2));
        return {
          ...w,
          viewRange: { ...w.viewRange, startSec, endSec: Math.min(file.durationSec, startSec + span) },
        };
      }),
      statusMessage: `Jumped to ${timeSec.toFixed(3)}s`,
    }));
    schedulePersistView(get, windowId);
  },

  updateWindowSelection: (windowId, selection) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.windowId === windowId ? { ...w, selection } : w)),
    })),

  updateWindowSpecParams: async (windowId, patch) => {
    set((s) => ({
      windows: s.windows.map((w) =>
        w.windowId === windowId ? { ...w, specParams: { ...w.specParams, ...patch } } : w,
      ),
    }));
    schedulePersistView(get, windowId);
    await Promise.all([get().ensureSpectrogram(windowId), get().ensureWaveform(windowId)]);
  },

  updateWindowDisplaySettings: (windowId, patch) => {
    const manualLevelEdit =
      patch.gainDb !== undefined ||
      patch.thresholdDb !== undefined ||
      patch.dynamicRangeDb !== undefined;
    set((s) => {
      const nextModes = manualLevelEdit
        ? { ...s.windowAutoGainMode, [windowId]: 'manual' as AutoGainMode }
        : s.windowAutoGainMode;
      return {
        windowAutoGainMode: nextModes,
        windows: s.windows.map((w) => {
          if (w.windowId !== windowId) return w;
          const nextDisp = { ...w.displaySettings, ...patch };
          let nextRange = w.viewRange;
          const file = s.files[w.fileId];
          if (
            file &&
            (patch.timeScaleMode !== undefined || patch.msPerPixel !== undefined)
          ) {
            if (nextDisp.timeScaleMode === 'stretch') {
              nextRange = { ...w.viewRange, startSec: 0, endSec: file.durationSec };
            } else {
              const effW = w.maximized ? s.canvasBounds.width : w.width;
              const plotW = Math.max(100, effW - (nextDisp.showAxes ? 54 : 0));
              const span = Math.min(
                file.durationSec,
                Math.max(0.05, (plotW * nextDisp.msPerPixel) / 1000),
              );
              const startSec = Math.max(0, Math.min(file.durationSec - span, w.viewRange.startSec));
              nextRange = { ...w.viewRange, startSec, endSec: startSec + span };
            }
          }
          return { ...w, displaySettings: nextDisp, viewRange: nextRange };
        }),
      };
    });
    schedulePersistView(get, windowId);
  },

  setWindowAutoGainMode: (windowId, mode) => {
    const cleanMode = normalizeAutoGainMode(mode);
    set((s) => ({
      windowAutoGainMode: { ...s.windowAutoGainMode, [windowId]: cleanMode },
    }));
    if (cleanMode === 'manual') {
      set({ statusMessage: 'Auto-normalization turned off (Manual levels)' });
      schedulePersistView(get, windowId);
      return;
    }
    get().normalizeWindowGain(windowId, { scope: 'view' });
    schedulePersistView(get, windowId);
  },

  normalizeWindowGain: (windowId, options) => {
    const state = get();
    const win = state.windows.find((w) => w.windowId === windowId);
    if (!win) return;
    const matrix =
      options?.matrix ?? getCachedSpectrogram(state.spectrogramCache, win.fileId, win.specParams);
    if (!matrix) {
      if (!options?.silent) {
        set({ statusMessage: 'Spectrogram data still loading — cannot normalize yet' });
      }
      return;
    }

    const scope = options?.scope ?? 'view';
    const region =
      scope === 'full'
        ? undefined
        : scope === 'selection' && win.selection
          ? {
              startSec: win.selection.startSec,
              endSec: win.selection.endSec,
              minFreqHz: win.selection.lowFreqHz,
              maxFreqHz: win.selection.highFreqHz,
            }
          : win.viewRange;

    const result = computeNormalizedGainDb(matrix, win.displaySettings, region);
    const changed =
      result.thresholdDb !== win.displaySettings.thresholdDb ||
      result.dynamicRangeDb !== win.displaySettings.dynamicRangeDb ||
      result.gainDb !== win.displaySettings.gainDb;
    if (!changed && options?.silent) return;

    const signGain = result.gainDb >= 0 ? `+${result.gainDb}` : `${result.gainDb}`;
    set((s) => ({
      windows: changed
        ? s.windows.map((w) =>
            w.windowId === windowId
              ? {
                  ...w,
                  displaySettings: {
                    ...w.displaySettings,
                    thresholdDb: result.thresholdDb,
                    dynamicRangeDb: result.dynamicRangeDb,
                    gainDb: result.gainDb,
                  },
                }
              : w,
          )
        : s.windows,
      statusMessage: options?.silent
        ? s.statusMessage
        : `Normalized: Floor ${result.thresholdDb} dB · Range ${result.dynamicRangeDb} dB · Gain ${signGain} dB (signal ${result.floorDb.toFixed(1)} to ${result.peakDb.toFixed(1)} dB)`,
    }));
    schedulePersistView(get, windowId);
  },

  applySettingsToAllWindows: async (sourceWindowId) => {
    const state = get();
    const src = state.windows.find((w) => w.windowId === sourceWindowId);
    if (!src) return;
    const srcMode = state.windowAutoGainMode[sourceWindowId] ?? 'manual';

    const targetIds: string[] = [];
    set((s) => {
      const nextModes = { ...s.windowAutoGainMode };
      const nextWindows = s.windows.map((w) => {
        if (w.windowId === sourceWindowId || w.displaySettings.lockSettings) return w;
        targetIds.push(w.windowId);
        nextModes[w.windowId] = srcMode;
        const file = s.files[w.fileId];
        const nextDisp = { ...src.displaySettings, lockSettings: false };
        const safeChan = file
          ? Math.min(src.specParams.channel, Math.max(0, file.numChannels - 1))
          : w.specParams.channel;
        let nextRange = w.viewRange;
        if (file) {
          if (nextDisp.timeScaleMode === 'stretch') {
            nextRange = { ...w.viewRange, startSec: 0, endSec: file.durationSec };
          } else {
            const effW = w.maximized ? s.canvasBounds.width : w.width;
            const plotW = Math.max(100, effW - (nextDisp.showAxes ? 54 : 0));
            const span = Math.min(
              file.durationSec,
              Math.max(0.05, (plotW * nextDisp.msPerPixel) / 1000),
            );
            const startSec = Math.max(0, Math.min(file.durationSec - span, w.viewRange.startSec));
            nextRange = { ...w.viewRange, startSec, endSec: startSec + span };
          }
        }
        return {
          ...w,
          displaySettings: nextDisp,
          specParams: { ...src.specParams, channel: safeChan },
          viewRange: nextRange,
        };
      });
      return {
        windows: nextWindows,
        windowAutoGainMode: nextModes,
        statusMessage: `Applied settings from "${src.title}" to all unlocked windows`,
      };
    });

    await Promise.all(targetIds.map((id) => get().ensureSpectrogram(id)));
  },

  makeActiveSettingsDefault: (sourceWindowId) => {
    const state = get();
    const src = state.windows.find((w) => w.windowId === sourceWindowId);
    if (!src) return;
    const specParams = { ...src.specParams };
    const displaySettings = { ...src.displaySettings, lockSettings: false };
    const autoGainMode = state.windowAutoGainMode[sourceWindowId] ?? 'manual';
    try {
      localStorage.setItem(
        DEFAULTS_STORAGE_KEY,
        JSON.stringify({ specParams, displaySettings, autoGainMode }),
      );
    } catch {
      // ignore
    }
    set({
      defaultSpecParams: specParams,
      defaultDisplaySettings: displaySettings,
      defaultAutoGainMode: autoGainMode,
      statusMessage: 'Saved current display & FFT settings as default for new windows',
    });
  },

  toggleTimeScaleMode: (windowId) => {
    const win = get().windows.find((w) => w.windowId === windowId);
    if (!win) return;
    const nextMode = win.displaySettings.timeScaleMode === 'stretch' ? 'fixed' : 'stretch';
    get().updateWindowDisplaySettings(windowId, { timeScaleMode: nextMode });
    set({
      statusMessage:
        nextMode === 'fixed'
          ? `Fixed time scale (${win.displaySettings.msPerPixel} ms/px)`
          : 'Stretch time scale to window',
    });
  },

  nudgeWindowGain: (windowId, deltaDb) => {
    const win = get().windows.find((w) => w.windowId === windowId);
    if (!win) return;
    const next = Math.max(-40, Math.min(60, win.displaySettings.gainDb + deltaDb));
    get().updateWindowDisplaySettings(windowId, { gainDb: next });
    set({ statusMessage: `Spectrogram gain: ${next.toFixed(0)} dB` });
  },

  toggleAllCursors: () =>
    set((s) => {
      const anyShown = s.windows.some((w) => w.displaySettings.showCursors);
      return {
        windows: s.windows.map((w) => ({
          ...w,
          displaySettings: { ...w.displaySettings, showCursors: !anyShown },
        })),
        statusMessage: anyShown ? 'Hid all cursors & boxes' : 'Showing cursors & boxes',
      };
    }),

  toggleWindowLinkGroup: (windowId) =>
    set((s) => ({
      windows: s.windows.map((w) =>
        w.windowId === windowId
          ? { ...w, linkGroupId: w.linkGroupId ? null : 'group-1' }
          : w,
      ),
    })),

  toggleAllTitlebars: () =>
    set((s) => {
      const anyShown = s.windows.some((w) => w.showTitlebar);
      return {
        windows: s.windows.map((w) => ({ ...w, showTitlebar: !anyShown })),
      };
    }),

  applyLayout: (command) =>
    set((s) => ({
      windows: applyMdiLayout(s.windows, command, s.canvasBounds, s.activeWindowId),
      statusMessage: `Applied layout: ${command.replace(/_/g, ' ')}`,
    })),

  exportDisplayJson: () => {
    const s = get();
    const payload: SavedDisplayFile = {
      version: 1,
      savedAtIso: new Date().toISOString(),
      defaultSpecParams: s.defaultSpecParams,
      defaultDisplaySettings: s.defaultDisplaySettings,
      windows: s.windows
        .map((w) => {
          const f = s.files[w.fileId];
          if (!f || f.sourceId === 'upload') return null;
          return {
            sourceId: f.sourceId,
            uri: f.uri,
            title: w.title,
            x: w.x,
            y: w.y,
            width: w.width,
            height: w.height,
            zIndex: w.zIndex,
            minimized: w.minimized,
            maximized: w.maximized,
            showTitlebar: w.showTitlebar,
            linkGroupId: w.linkGroupId,
            viewRange: w.viewRange,
            specParams: w.specParams,
            displaySettings: w.displaySettings,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    };
    return JSON.stringify(payload, null, 2);
  },

  importDisplayJson: async (jsonText, merge = false) => {
    try {
      const parsed = JSON.parse(jsonText) as SavedDisplayFile;
      if (!parsed || !Array.isArray(parsed.windows)) {
        throw new Error('Invalid SyrinxOne display file');
      }
      if (!merge) {
        set({ windows: [], activeWindowId: null });
      }
      if (parsed.defaultSpecParams || parsed.defaultDisplaySettings) {
        set((s) => ({
          defaultSpecParams: { ...s.defaultSpecParams, ...(parsed.defaultSpecParams ?? {}) },
          defaultDisplaySettings: {
            ...s.defaultDisplaySettings,
            ...(parsed.defaultDisplaySettings ?? {}),
          },
        }));
      }

      let restored = 0;
      for (const savedWin of parsed.windows) {
        try {
          const info = await get().engine.openAudio(savedWin.sourceId, savedWin.uri);
          const state = get();
          const winId = `win-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const newWin: MDIWindowState = {
            windowId: winId,
            fileId: info.fileId,
            title: savedWin.title || info.name,
            x: savedWin.x,
            y: savedWin.y,
            width: savedWin.width,
            height: savedWin.height,
            zIndex: state.nextZIndex,
            minimized: Boolean(savedWin.minimized),
            maximized: Boolean(savedWin.maximized),
            showTitlebar: savedWin.showTitlebar ?? true,
            linkGroupId: savedWin.linkGroupId ?? null,
            viewRange: savedWin.viewRange,
            specParams: { ...DEFAULT_SPECTROGRAM_PARAMS, ...savedWin.specParams },
            displaySettings: { ...DEFAULT_DISPLAY_SETTINGS, ...savedWin.displaySettings },
            selection: null,
          };
          set((s) => ({
            files: { ...s.files, [info.fileId]: info },
            windows: [...s.windows, newWin],
            activeWindowId: winId,
            nextZIndex: s.nextZIndex + 1,
          }));
          await Promise.all([get().ensureSpectrogram(winId), get().ensureWaveform(winId)]);
          restored++;
        } catch {
          // skip unavailable linked files gracefully
        }
      }
      set({
        statusMessage: `${merge ? 'Merged' : 'Loaded'} display (${restored}/${parsed.windows.length} windows restored)`,
      });
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : 'Failed to load display file' });
    }
  },

  addAnnotation: (ann) => {
    const rec: AnnotationRecord = {
      ...ann,
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      modified: true,
    };
    set((s) => {
      const next = [...s.annotations, rec];
      persistAnnotations(next, s.nonAnnotationLines);
      return {
        annotations: next,
        selectedAnnotationId: rec.id,
        statusMessage: `Logged annotation "${rec.comment || '(blank)'}" [${rec.startTimeSec.toFixed(3)}s – ${rec.endTimeSec.toFixed(3)}s]`,
      };
    });
    return rec;
  },

  addDetectedAnnotations: (detections, replaceForSoundfile) =>
    set((s) => {
      const base = replaceForSoundfile
        ? s.annotations.filter(
            (a) => a.soundfile.toLowerCase() !== replaceForSoundfile.toLowerCase(),
          )
        : s.annotations;
      const next = [...base, ...detections];
      persistAnnotations(next, s.nonAnnotationLines);
      return {
        annotations: next,
        selectedAnnotationId: detections[0]?.id ?? s.selectedAnnotationId,
        statusMessage: `Added ${detections.length} detected sound annotations`,
      };
    }),

  stampSelectionWithHotkey: (key) => {
    const state = get();
    const binding = state.hotkeys.find((h) => h.key.toLowerCase() === key.toLowerCase());
    if (!binding) return null;
    return state.logActiveSelection(binding.comment);
  },

  logActiveSelection: (comment = '') => {
    const state = get();
    const win = state.windows.find((w) => w.windowId === state.activeWindowId);
    if (!win || !win.selection) return null;
    const file = state.files[win.fileId];
    if (!file) return null;
    const sel = win.selection;
    return state.addAnnotation({
      soundfile: file.name,
      channel: sel.channel,
      startTimeSec: Math.min(sel.startSec, sel.endSec),
      endTimeSec: Math.max(sel.startSec, sel.endSec),
      lowFreqHz: Math.min(sel.lowFreqHz, sel.highFreqHz),
      highFreqHz: Math.max(sel.lowFreqHz, sel.highFreqHz),
      comment,
      notes: '',
      extraFields: {},
    });
  },

  logSelectionWithMeasurements: (measurements, comment = '') => {
    const state = get();
    const win = state.windows.find((w) => w.windowId === state.activeWindowId);
    if (!win || !win.selection) return null;
    const file = state.files[win.fileId];
    if (!file) return null;
    const sel = win.selection;
    return state.addAnnotation({
      soundfile: file.name,
      channel: sel.channel,
      startTimeSec: Math.min(sel.startSec, sel.endSec),
      endTimeSec: Math.max(sel.startSec, sel.endSec),
      lowFreqHz: Math.min(sel.lowFreqHz, sel.highFreqHz),
      highFreqHz: Math.max(sel.lowFreqHz, sel.highFreqHz),
      comment,
      notes: `Peak ${Math.round(measurements.peakFreqHz)} Hz, BW90 ${Math.round(measurements.bw90Hz)} Hz, SNR ${measurements.snrDb.toFixed(1)} dB`,
      extraFields: {
        PeakFreqHz: Number(measurements.peakFreqHz.toFixed(1)),
        CentroidHz: Number(measurements.centroidFreqHz.toFixed(1)),
        BW90Hz: Number(measurements.bw90Hz.toFixed(1)),
        Q5FreqHz: Number(measurements.q5FreqHz.toFixed(1)),
        Q50FreqHz: Number(measurements.q50FreqHz.toFixed(1)),
        Q95FreqHz: Number(measurements.q95FreqHz.toFixed(1)),
        RMSdB: Number(measurements.rmsDb.toFixed(1)),
        PeakdB: Number(measurements.peakDb.toFixed(1)),
        SNRdB: Number(measurements.snrDb.toFixed(1)),
      },
    });
  },

  applySuggestedDetectParams: (params) =>
    set({
      suggestedDetectParams: params,
      showDetectModal: true,
      statusMessage: `Loaded AI-suggested Detect Sounds parameters (${Math.round(params.minFreqHz)}–${Math.round(params.maxFreqHz)} Hz)`,
    }),

  clearSuggestedDetectParams: () => set({ suggestedDetectParams: null }),

  updateAnnotation: (id, patch) =>
    set((s) => {
      const next = s.annotations.map((a) =>
        a.id === id ? { ...a, ...patch, modified: true } : a,
      );
      persistAnnotations(next, s.nonAnnotationLines);
      return { annotations: next };
    }),

  deleteAnnotation: (id) =>
    set((s) => {
      const next = s.annotations.filter((a) => a.id !== id);
      persistAnnotations(next, s.nonAnnotationLines);
      return {
        annotations: next,
        selectedAnnotationId: s.selectedAnnotationId === id ? null : s.selectedAnnotationId,
        redefineAnnotationId: s.redefineAnnotationId === id ? null : s.redefineAnnotationId,
      };
    }),

  selectAnnotation: (id, jumpToView = false) => {
    set({ selectedAnnotationId: id });
    if (!id || !jumpToView) return;
    const state = get();
    const ann = state.annotations.find((a) => a.id === id);
    if (!ann) return;
    const matchingWin =
      state.windows.find(
        (w) => state.files[w.fileId]?.name.toLowerCase() === ann.soundfile.toLowerCase(),
      ) ?? state.windows.find((w) => w.windowId === state.activeWindowId);
    if (!matchingWin) return;
    const file = state.files[matchingWin.fileId];
    if (!file) return;

    const currentSpan = matchingWin.viewRange.endSec - matchingWin.viewRange.startSec;
    const span =
      matchingWin.displaySettings.timeScaleMode === 'fixed'
        ? currentSpan
        : Math.max(0.25, (ann.endTimeSec - ann.startTimeSec) * 3.0);
    const center = 0.5 * (ann.startTimeSec + ann.endTimeSec);
    const startSec = Math.max(0, Math.min(file.durationSec - span, center - span / 2));
    const endSec = Math.min(file.durationSec, startSec + span);
    state.focusWindow(matchingWin.windowId);
    state.updateWindowViewRange(matchingWin.windowId, {
      ...matchingWin.viewRange,
      startSec,
      endSec,
    });
  },

  navigateAnnotation: (dir) => {
    const s = get();
    const sorted = [...s.annotations].sort((a, b) => a.startTimeSec - b.startTimeSec);
    if (sorted.length === 0) return;
    const curIdx = sorted.findIndex((a) => a.id === s.selectedAnnotationId);
    const nextIdx =
      curIdx < 0
        ? dir > 0
          ? 0
          : sorted.length - 1
        : (curIdx + dir + sorted.length) % sorted.length;
    s.selectAnnotation(sorted[nextIdx].id, true);
  },

  setRedefineAnnotationId: (redefineAnnotationId) =>
    set({
      redefineAnnotationId,
      statusMessage: redefineAnnotationId
        ? 'Drag a new box on the spectrogram to redefine the selected annotation'
        : 'Ready',
    }),

  setAnnotationFilter: (patch) =>
    set((s) => ({ annotationFilter: { ...s.annotationFilter, ...patch } })),

  setHotkeys: (bindings) => {
    try {
      localStorage.setItem(HOTKEYS_STORAGE_KEY, JSON.stringify(bindings));
    } catch {
      // ignore
    }
    set({ hotkeys: bindings });
  },

  importAnnotationsFromText: async (content, format) => {
    const doc = await get().engine.importAnnotationsText(content, format);
    set({
      annotations: doc.annotations,
      nonAnnotationLines: doc.nonAnnotationLines,
      statusMessage: `Imported ${doc.annotations.length} annotations (${format})`,
    });
  },

  importAnnotationsFromSource: async (sourceId, uri, format) => {
    const doc = await get().engine.importAnnotationsFromSource(sourceId, uri, format);
    set({
      annotations: doc.annotations,
      nonAnnotationLines: doc.nonAnnotationLines,
      statusMessage: `Loaded ${doc.annotations.length} annotations from ${uri}`,
    });
  },

  exportAnnotationsAsText: async (format) => {
    const s = get();
    return s.engine.exportAnnotationsText(s.annotations, format, s.nonAnnotationLines);
  },

  saveAnnotationsToSource: async (sourceId, uri, format) => {
    const s = get();
    const res = await s.engine.saveAnnotationsToSource(
      sourceId,
      uri,
      s.annotations,
      format,
      s.nonAnnotationLines,
    );
    set({ statusMessage: `Saved ${res.count} annotations to ${res.savedUri}` });
  },

  setModalState: (key, value) => {
    if (isNarrowMobileViewport()) {
      if (key === 'showSpecPanel' && value) {
        set({ mobilePane: 0, showSpecPanel: true, showAnnotationDrawer: false });
        return;
      }
      if (key === 'showAiPanel' && value) {
        set({ mobilePane: 2, showAiPanel: true, showAnnotationDrawer: false });
        return;
      }
      if ((key === 'showSpecPanel' || key === 'showAiPanel') && !value) {
        set({ mobilePane: 1, [key]: false });
        return;
      }
    }
    if (key === 'showSourceModal' && !value) {
      set({ showSourceModal: false, sourceReturnToBrowser: false });
      return;
    }
    set({ [key]: value });
  },
};
});

export function getCachedSpectrogram(
  cache: Record<string, SpectrogramMatrix>,
  fileId: string,
  params: SpectrogramParams,
): SpectrogramMatrix | undefined {
  return cache[makeSpecCacheKey(fileId, params)];
}
