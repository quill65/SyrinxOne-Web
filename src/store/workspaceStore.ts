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
import { applyMdiLayout, type CanvasBounds } from '../utils/mdiLayout';

const HOTKEYS_STORAGE_KEY = 'syrinxone.hotkeys.v1';
const DEFAULTS_STORAGE_KEY = 'syrinxone.windowDefaults.v1';
const ANNOTATIONS_STORAGE_KEY = 'syrinxone.annotations.v1';
const ENGINE_STORAGE_KEY = 'syrinxone.engineConfig.v1';

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
} {
  try {
    const raw = localStorage.getItem(DEFAULTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        specParams?: Partial<SpectrogramParams>;
        displaySettings?: Partial<DisplaySettings>;
      };
      return {
        specParams: { ...DEFAULT_SPECTROGRAM_PARAMS, ...(parsed.specParams ?? {}) },
        displaySettings: { ...DEFAULT_DISPLAY_SETTINGS, ...(parsed.displaySettings ?? {}) },
      };
    }
  } catch {
    // ignore
  }
  return {
    specParams: { ...DEFAULT_SPECTROGRAM_PARAMS },
    displaySettings: { ...DEFAULT_DISPLAY_SETTINGS },
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

export interface WorkspaceStore {
  engine: HttpAudioEngineClient;
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

  annotations: AnnotationRecord[];
  nonAnnotationLines: string[];
  selectedAnnotationId: string | null;
  redefineAnnotationId: string | null;
  annotationFilter: AnnotationFilter;
  hotkeys: HotkeyBinding[];

  showAnnotationDrawer: boolean;
  showSpecPanel: boolean;
  showAiPanel: boolean;
  showEngineModal: boolean;
  showFileBrowser: boolean;
  showHotkeyModal: boolean;
  showKlipModal: boolean;
  showDetectModal: boolean;
  suggestedDetectParams: SuggestedDetectParams | null;

  setBackendConfig: (baseUrl: string, token?: string) => void;
  checkBackendHealth: () => Promise<void>;
  setCanvasBounds: (bounds: CanvasBounds) => void;
  setStatus: (msg: string) => void;
  setError: (err: string | null) => void;
  setCursorReadout: (readout: CursorReadout | null) => void;

  openAudioFromSource: (
    sourceId: string,
    uri: string,
    options?: { startSec?: number; maxDurationSec?: number },
  ) => Promise<void>;
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
  stepFileInFolder: (windowId: string, delta: -1 | 1) => Promise<void>;
  openUploadedFile: (file: File) => Promise<void>;
  openAudioInfoInWindow: (info: AudioFileInfo) => Promise<string>;
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
const startMobile = isNarrowMobileViewport();

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  engine: new HttpAudioEngineClient({
    baseUrl: initialEngineConfig.baseUrl,
    token: initialEngineConfig.token || undefined,
  }),
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

  annotations: initialAnnotations.annotations,
  nonAnnotationLines: initialAnnotations.nonAnnotationLines,
  selectedAnnotationId: null,
  redefineAnnotationId: null,
  annotationFilter: { ...DEFAULT_ANNOTATION_FILTER },
  hotkeys: loadSavedHotkeys(),

  showAnnotationDrawer: !startMobile,
  showSpecPanel: !startMobile,
  showAiPanel: false,
  showEngineModal: false,
  showFileBrowser: false,
  showHotkeyModal: false,
  showKlipModal: false,
  showDetectModal: false,
  suggestedDetectParams: null,

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
      set({ statusMessage: `Opening ${uri}...`, errorMessage: null });
      const info = await get().engine.openAudio(sourceId, uri, options);
      await get().openAudioInfoInWindow(info);
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : 'Failed to open audio file',
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
      set((s) => ({
        files: { ...s.files, [info.fileId]: info },
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
            title: info.isPartialWindow
              ? `${info.name} [${Math.round(info.windowStartSec ?? 0)}s–${Math.round(
                  (info.windowStartSec ?? 0) + info.durationSec,
                )}s]`
              : info.name,
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
        statusMessage: `Loaded ${info.name} (${info.sampleRate} Hz, ${info.durationSec.toFixed(2)}s)`,
      }));
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
    await get().loadAudioIntoWindow(windowId, file.sourceId, file.uri, {
      startSec: nextStart,
      maxDurationSec: winLen,
    });
  },

  stepFileInFolder: async (windowId, delta) => {
    const state = get();
    const win = state.windows.find((w) => w.windowId === windowId);
    if (!win) return;
    const file = state.files[win.fileId];
    if (!file || file.sourceId === 'upload') {
      set({ statusMessage: 'Folder stepping requires a local or cloud source file' });
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

  openAudioInfoInWindow: async (info) => {
    const state = get();
    const winId = `win-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const offset = (state.windows.length % 8) * 28;
    const nyquist = info.sampleRate / 2;
    const width = Math.min(760, Math.max(480, state.canvasBounds.width - 80));
    const height = Math.min(440, Math.max(300, state.canvasBounds.height - 80));
    const disp = { ...state.defaultDisplaySettings };
    const spec = {
      ...state.defaultSpecParams,
      channel: Math.min(state.defaultSpecParams.channel, Math.max(0, info.numChannels - 1)),
    };

    const plotW = Math.max(200, width - (disp.showAxes ? 54 : 0));
    const endSec =
      disp.timeScaleMode === 'fixed'
        ? Math.min(info.durationSec, Math.max(0.05, (plotW * disp.msPerPixel) / 1000))
        : info.durationSec;

    const newWin: MDIWindowState = {
      windowId: winId,
      fileId: info.fileId,
      title: info.name,
      x: 16 + offset,
      y: 16 + offset,
      width,
      height,
      zIndex: state.nextZIndex,
      minimized: false,
      maximized: false,
      showTitlebar: true,
      linkGroupId: null,
      viewRange: {
        startSec: 0,
        endSec,
        minFreqHz: 0,
        maxFreqHz: nyquist,
      },
      specParams: spec,
      displaySettings: disp,
      selection: null,
    };

    set({
      files: { ...state.files, [info.fileId]: info },
      windows: [...state.windows, newWin],
      activeWindowId: winId,
      nextZIndex: state.nextZIndex + 1,
      statusMessage: `Opened ${info.name} (${info.sampleRate} Hz, ${info.numChannels} ch, ${info.durationSec.toFixed(2)} s)`,
    });

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
    set({
      windows: [...state.windows, copy],
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
    const key = makeSpecCacheKey(win.fileId, win.specParams);
    if (state.spectrogramCache[key]) return;
    try {
      const mat = await state.engine.getSpectrogram(win.fileId, win.specParams);
      set((s) => ({
        spectrogramCache: { ...s.spectrogramCache, [key]: mat },
      }));
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

  closeWindow: (windowId) =>
    set((s) => {
      const remaining = s.windows.filter((w) => w.windowId !== windowId);
      const nextActive =
        s.activeWindowId === windowId
          ? remaining.length > 0
            ? remaining.reduce((a, b) => (a.zIndex > b.zIndex ? a : b)).windowId
            : null
          : s.activeWindowId;
      return { windows: remaining, activeWindowId: nextActive };
    }),

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

  updateWindowViewRange: (windowId, range) =>
    set((s) => {
      const target = s.windows.find((w) => w.windowId === windowId);
      if (!target) return s;
      const group = target.linkGroupId;
      return {
        windows: s.windows.map((w) => {
          if (w.windowId === windowId) return { ...w, viewRange: range };
          if (group && w.linkGroupId === group) {
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
    }),

  resetWindowZoom: (windowId) =>
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
    })),

  gotoTimeInWindow: (windowId, timeSec) =>
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
    })),

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
    await Promise.all([get().ensureSpectrogram(windowId), get().ensureWaveform(windowId)]);
  },

  updateWindowDisplaySettings: (windowId, patch) =>
    set((s) => ({
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
    })),

  applySettingsToAllWindows: async (sourceWindowId) => {
    const state = get();
    const src = state.windows.find((w) => w.windowId === sourceWindowId);
    if (!src) return;

    const targetIds: string[] = [];
    set((s) => ({
      windows: s.windows.map((w) => {
        if (w.windowId === sourceWindowId || w.displaySettings.lockSettings) return w;
        targetIds.push(w.windowId);
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
      }),
      statusMessage: `Applied settings from "${src.title}" to all unlocked windows`,
    }));

    await Promise.all(targetIds.map((id) => get().ensureSpectrogram(id)));
  },

  makeActiveSettingsDefault: (sourceWindowId) => {
    const state = get();
    const src = state.windows.find((w) => w.windowId === sourceWindowId);
    if (!src) return;
    const specParams = { ...src.specParams };
    const displaySettings = { ...src.displaySettings, lockSettings: false };
    try {
      localStorage.setItem(
        DEFAULTS_STORAGE_KEY,
        JSON.stringify({ specParams, displaySettings }),
      );
    } catch {
      // ignore
    }
    set({
      defaultSpecParams: specParams,
      defaultDisplaySettings: displaySettings,
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
    // On mobile viewports, keep only one drawer/panel open at a time so the screen stays usable
    if (
      value &&
      isNarrowMobileViewport() &&
      (key === 'showSpecPanel' || key === 'showAiPanel' || key === 'showAnnotationDrawer')
    ) {
      set({
        showSpecPanel: key === 'showSpecPanel',
        showAiPanel: key === 'showAiPanel',
        showAnnotationDrawer: key === 'showAnnotationDrawer',
      });
      return;
    }
    set({ [key]: value });
  },
}));

export function getCachedSpectrogram(
  cache: Record<string, SpectrogramMatrix>,
  fileId: string,
  params: SpectrogramParams,
): SpectrogramMatrix | undefined {
  return cache[makeSpecCacheKey(fileId, params)];
}
