import { create } from 'zustand';
import {
  DEFAULT_ANNOTATION_FILTER,
  HttpAudioEngineClient,
  SPECTROGRAM_FLOOR_MAX,
  SPECTROGRAM_FLOOR_MIN,
  SPECTROGRAM_GAIN_MAX_DB,
  SPECTROGRAM_GAIN_MIN_DB,
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
  MAX_WEBGL_TIME_BINS,
  computeAutoGain,
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
import type { ArchiveTargetInput } from '../utils/archiveDocs';
import {
  isNarrowMobileViewport,
  loadSavedActiveSource,
  loadSavedAnnotations,
  loadSavedDefaults,
  loadSavedEngineConfig,
  loadSavedHotkeys,
  makeSpecCacheKey,
  parentPrefix,
  persistActiveSource,
  persistAnnotations,
  persistEngineConfig,
  persistHotkeys,
  persistWindowDefaults,
  sanitizeDisplaySettings,
  sanitizeSpecParams,
} from './persistence';

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

  mobilePane: 0 | 1 | 2 | 3;
  setMobilePane: (pane: 0 | 1 | 2 | 3) => void;
  touchMode: 'select' | 'pan';
  setTouchMode: (mode: 'select' | 'pan') => void;

  showAnnotationDrawer: boolean;
  showSpecPanel: boolean;
  showAiPanel: boolean;
  showEngineModal: boolean;
  showSourceModal: boolean;
  showFileBrowser: boolean;
  showHotkeyModal: boolean;
  showKlipModal: boolean;
  showDetectModal: boolean;
  showArchiveAboutModal: boolean;
  aboutArchiveTarget: ArchiveTargetInput | null;
  sourceReturnToBrowser: boolean;
  openSourceSelector: (returnToBrowser?: boolean) => void;
  openAboutArchive: (target: ArchiveTargetInput) => void;
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
    options?: {
      startSec?: number;
      maxDurationSec?: number;
      fullTimeline?: boolean;
      sizeBytes?: number;
      name?: string;
      restoreSaved?: boolean;
    },
  ) => Promise<void>;
  openCombinedArchive: (
    specs: SegmentSourceSpec[],
    title: string,
    options?: {
      startSec?: number;
      maxDurationSec?: number;
      fullTimeline?: boolean;
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
  autoGainWindow: (
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
  nudgeWindowFloor: (windowId: string, deltaPct: number) => void;
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
      | 'showDetectModal'
      | 'showArchiveAboutModal',
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
    persistActiveSource(cleanId, cleanLabel);
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
  touchMode: 'select',
  setTouchMode: (mode) => set({ touchMode: mode }),

  showAnnotationDrawer: !startMobile,
  showSpecPanel: !startMobile,
  showAiPanel: false,
  showEngineModal: false,
  showSourceModal: false,
  showFileBrowser: false,
  showHotkeyModal: false,
  showKlipModal: false,
  showDetectModal: false,
  showArchiveAboutModal: false,
  aboutArchiveTarget: null,
  sourceReturnToBrowser: false,
  openSourceSelector: (returnToBrowser = false) =>
    set({
      showSourceModal: true,
      showFileBrowser: false,
      sourceReturnToBrowser: returnToBrowser,
    }),
  openAboutArchive: (target) =>
    set({ aboutArchiveTarget: target, showArchiveAboutModal: true }),
  suggestedDetectParams: null,

  googleUser: null,
  hasDriveToken: false,
  setGoogleAuthState: (googleUser, hasDriveToken) => set({ googleUser, hasDriveToken }),

  setBackendConfig: (baseUrl, token) => {
    const cleanUrl = baseUrl.trim().replace(/\/+$/, '');
    const cleanToken = (token ?? '').trim();
    get().engine.setConfig({ baseUrl: cleanUrl, token: cleanToken || undefined });
    persistEngineConfig(cleanUrl, cleanToken);
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
      const savedIsPartial =
        saved &&
        saved.totalDurationSec !== undefined &&
        saved.windowDurationSec !== undefined &&
        saved.windowDurationSec < saved.totalDurationSec - 0.5;
      const useSavedSlice =
        saved &&
        (saved.windowStartSec > 0 || savedIsPartial) &&
        options?.fullTimeline !== true;
      const openOpts = useSavedSlice
        ? {
            startSec: saved.windowStartSec,
            ...(saved.windowDurationSec !== undefined
              ? { maxDurationSec: saved.windowDurationSec }
              : {}),
            fullTimeline: false,
            sizeBytes: options?.sizeBytes,
            name: options?.name,
          }
        : {
            ...(options?.startSec !== undefined ? { startSec: options.startSec } : {}),
            ...(options?.maxDurationSec !== undefined
              ? { maxDurationSec: options.maxDurationSec }
              : {}),
            fullTimeline: options?.fullTimeline ?? options?.maxDurationSec === undefined,
            sizeBytes: options?.sizeBytes,
            name: options?.name,
          };

      set({ statusMessage: `Opening ${options?.name || uri}...`, errorMessage: null });
      const rawInfo = await get().engine.openCompleteAudio(sourceId, uri, recKey, openOpts);
      const preferredName = options?.name?.trim();
      const info =
        preferredName && preferredName.length > 0 && rawInfo.name !== preferredName
          ? { ...rawInfo, name: preferredName }
          : rawInfo;
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
    const hasMultiChannels = specs.some((s) => (s.channelFiles?.length ?? 0) > 1);
    if (specs.length === 1 && !hasMultiChannels) {
      await get().openAudioFromSource(specs[0].sourceId, specs[0].uri, {
        startSec: options?.startSec,
        maxDurationSec: options?.maxDurationSec,
        fullTimeline: options?.fullTimeline,
        sizeBytes: specs[0].sizeBytes,
        name: specs[0].name,
        restoreSaved: options?.restoreSaved,
      });
      return;
    }
    try {
      const recKey =
        options?.recordingKey ?? makeCombinedRecordingKey(specs[0].sourceId, specs);
      const saved = options?.restoreSaved !== false ? getRecordingViewState(recKey) : null;
      const savedIsPartial =
        saved &&
        saved.totalDurationSec !== undefined &&
        saved.windowDurationSec !== undefined &&
        saved.windowDurationSec < saved.totalDurationSec - 0.5;
      const useSavedSlice =
        saved &&
        options?.startSec === undefined &&
        options?.maxDurationSec === undefined &&
        savedIsPartial &&
        options?.fullTimeline !== true;
      const openOpts = useSavedSlice
        ? {
            startSec: saved.windowStartSec,
            ...(saved.windowDurationSec !== undefined
              ? { maxDurationSec: saved.windowDurationSec }
              : {}),
            fullTimeline: false,
          }
        : options
          ? {
              ...(options.startSec !== undefined ? { startSec: options.startSec } : {}),
              ...(options.maxDurationSec !== undefined
                ? { maxDurationSec: options.maxDurationSec }
                : {}),
              ...(options.fullTimeline !== undefined
                ? { fullTimeline: options.fullTimeline }
                : {}),
            }
          : undefined;

      set({
        statusMessage: `Indexing ${specs.length} contiguous recordings (${title})...`,
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
    const hasMulti =
      saved.segments &&
      (saved.segments.length > 1 || (saved.segments[0]?.channelFiles?.length ?? 0) > 1);
    if (saved.kind === 'combined' && saved.segments && hasMulti) {
      await get().openCombinedArchive(saved.segments, saved.label, {
        recordingKey: saved.recordingKey,
        restoreSaved: true,
      });
    } else {
      await get().openAudioFromSource(saved.sourceId, saved.uri, {
        name: saved.label,
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
    const wantsFull = requestedLen >= totalDur - 0.5;
    const nextLen = wantsFull
      ? totalDur
      : Math.max(5, Math.min(totalDur, safeMax, Math.round(requestedLen)));
    const nextStart = wantsFull
      ? 0
      : Math.max(0, Math.min(Math.max(0, totalDur - nextLen), startSec));

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
      const rawInfo = await get().engine.uploadAudio(file);
      const info = file.name && rawInfo.name !== file.name ? { ...rawInfo, name: file.name } : rawInfo;
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
    const disp: DisplaySettings = sanitizeDisplaySettings({
      ...state.defaultDisplaySettings,
      ...(info.numChannels > 1 && saved?.displaySettings?.stackAllChannels === undefined
        ? { stackAllChannels: true }
        : {}),
      ...(saved?.displaySettings ?? {}),
      lockSettings: false,
    });
    const spec: SpectrogramParams = sanitizeSpecParams({
      ...state.defaultSpecParams,
      ...(saved?.specParams ?? {}),
      channel: Math.min(
        saved?.channel ?? saved?.specParams?.channel ?? state.defaultSpecParams.channel,
        Math.max(0, info.numChannels - 1),
      ),
    });
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
      specParams: sanitizeSpecParams(src.specParams),
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

    const targetChannels =
      win.displaySettings.stackAllChannels && file.numChannels > 1
        ? Array.from({ length: file.numChannels }, (_, idx) => idx)
        : [win.specParams.channel];

    let primaryMatrix: SpectrogramMatrix | undefined;
    const missing: number[] = [];
    for (const ch of targetChannels) {
      const chParams = { ...win.specParams, channel: ch };
      const key = makeSpecCacheKey(win.fileId, chParams);
      const cached = state.spectrogramCache[key];
      if (cached) {
        if (ch === win.specParams.channel || !primaryMatrix) primaryMatrix = cached;
      } else {
        missing.push(ch);
      }
    }

    if (missing.length === 0) {
      const mode = normalizeAutoGainMode(state.windowAutoGainMode[windowId]);
      if (mode === 'auto' && primaryMatrix) {
        get().autoGainWindow(windowId, {
          scope: 'view',
          matrix: primaryMatrix,
          silent: true,
        });
      }
      return;
    }

    try {
      const isSparse = isCombinedFileId(file.fileId) && file.durationSec > 1800;
      if (isSparse) {
        set({
          statusMessage: `Sampling sparse spectral lines across ${formatDurationCompact(file.durationSec)}...`,
        });
      }
      const fetched = await Promise.all(
        missing.map(async (ch) => {
          const chParams = { ...win.specParams, channel: ch };
          const key = makeSpecCacheKey(win.fileId, chParams);
          const mat = await fetchSpectrogramAdaptive(
            state.engine,
            file,
            chParams,
            undefined,
            MAX_WEBGL_TIME_BINS,
            {
              onProgress: (partialMat) => {
                set((s) => ({
                  spectrogramCache: { ...s.spectrogramCache, [key]: partialMat },
                }));
              },
            },
          );
          return { ch, key, mat };
        }),
      );
      set((s) => {
        const nextCache = { ...s.spectrogramCache };
        for (const item of fetched) {
          nextCache[item.key] = item.mat;
        }
        return {
          spectrogramCache: nextCache,
          ...(isSparse
            ? {
                statusMessage: `Ready · Sparse view (${formatDurationCompact(file.durationSec)}) — zoom anywhere for full resolution`,
              }
            : {}),
        };
      });
      const normMat =
        fetched.find((f) => f.ch === win.specParams.channel)?.mat ??
        primaryMatrix ??
        fetched[0]?.mat;
      const mode = normalizeAutoGainMode(get().windowAutoGainMode[windowId]);
      if (mode === 'auto' && normMat) {
        get().autoGainWindow(windowId, {
          scope: 'view',
          matrix: normMat,
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
    const file = state.files[win.fileId];
    const targetChannels =
      win.displaySettings.stackAllChannels && file && file.numChannels > 1
        ? Array.from({ length: file.numChannels }, (_, idx) => idx)
        : [win.specParams.channel];
    const missing = targetChannels.filter((ch) => !state.waveformCache[`${win.fileId}|${ch}`]);
    if (missing.length === 0) return;

    try {
      const fetched = await Promise.all(
        missing.map(async (ch) => ({
          key: `${win.fileId}|${ch}`,
          wf: await state.engine.getWaveform(win.fileId, ch, 2000),
        })),
      );
      set((s) => {
        const nextCache = { ...s.waveformCache };
        for (const item of fetched) {
          nextCache[item.key] = item.wf;
        }
        return { waveformCache: nextCache };
      });
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
        w.windowId === windowId
          ? { ...w, specParams: sanitizeSpecParams({ ...w.specParams, ...patch }) }
          : w,
      ),
    }));
    schedulePersistView(get, windowId);
    await Promise.all([get().ensureSpectrogram(windowId), get().ensureWaveform(windowId)]);
  },

  updateWindowDisplaySettings: (windowId, patch) => {
    const manualLevelEdit = patch.gainDb !== undefined || patch.floor !== undefined;
    const cleanPatch = { ...patch };
    if (cleanPatch.splitTimeRows !== undefined) {
      cleanPatch.splitTimeRows = Math.max(1, Math.min(10, Math.round(cleanPatch.splitTimeRows)));
    }
    set((s) => {
      const nextModes = manualLevelEdit
        ? { ...s.windowAutoGainMode, [windowId]: 'manual' as AutoGainMode }
        : s.windowAutoGainMode;
      return {
        windowAutoGainMode: nextModes,
        windows: s.windows.map((w) => {
          if (w.windowId !== windowId) return w;
          const nextDisp = sanitizeDisplaySettings({ ...w.displaySettings, ...cleanPatch });
          let nextRange = w.viewRange;
          const file = s.files[w.fileId];
          if (
            file &&
            (cleanPatch.timeScaleMode !== undefined || cleanPatch.msPerPixel !== undefined)
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
    if (cleanPatch.stackAllChannels) {
      void Promise.all([get().ensureSpectrogram(windowId), get().ensureWaveform(windowId)]);
    } else if (cleanPatch.showWaveform) {
      void get().ensureWaveform(windowId);
    }
    schedulePersistView(get, windowId);
  },

  setWindowAutoGainMode: (windowId, mode) => {
    const cleanMode = normalizeAutoGainMode(mode);
    set((s) => ({
      windowAutoGainMode: { ...s.windowAutoGainMode, [windowId]: cleanMode },
    }));
    if (cleanMode === 'manual') {
      set({ statusMessage: 'Auto Gain turned off (Manual Gain & Floor)' });
      schedulePersistView(get, windowId);
      return;
    }
    get().autoGainWindow(windowId, { scope: 'view' });
    schedulePersistView(get, windowId);
  },

  autoGainWindow: (windowId, options) => {
    const state = get();
    const win = state.windows.find((w) => w.windowId === windowId);
    if (!win) return;
    const matrix =
      options?.matrix ?? getCachedSpectrogram(state.spectrogramCache, win.fileId, win.specParams);
    if (!matrix) {
      if (!options?.silent) {
        set({ statusMessage: 'Spectrogram data still loading — cannot run Auto Gain yet' });
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

    const result = computeAutoGain(matrix, win.displaySettings, region);
    const changed =
      result.gainDb !== win.displaySettings.gainDb || result.floor !== win.displaySettings.floor;
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
                    gainDb: result.gainDb,
                    floor: result.floor,
                  },
                }
              : w,
          )
        : s.windows,
      statusMessage: options?.silent
        ? s.statusMessage
        : `Auto Gain: Gain ${signGain} dB · Floor ${result.floor}% (noise ${result.noiseDb.toFixed(1)} dB, peak ${result.peakDb.toFixed(1)} dB)`,
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
          specParams: sanitizeSpecParams({ ...src.specParams, channel: safeChan }),
          viewRange: nextRange,
        };
      });
      return {
        windows: nextWindows,
        windowAutoGainMode: nextModes,
        statusMessage: `Applied settings from "${src.title}" to all unlocked windows`,
      };
    });

    await Promise.all(
      targetIds.flatMap((id) => [get().ensureSpectrogram(id), get().ensureWaveform(id)]),
    );
  },

  makeActiveSettingsDefault: (sourceWindowId) => {
    const state = get();
    const src = state.windows.find((w) => w.windowId === sourceWindowId);
    if (!src) return;
    const specParams = sanitizeSpecParams(src.specParams);
    const displaySettings = { ...src.displaySettings, lockSettings: false };
    const autoGainMode = state.windowAutoGainMode[sourceWindowId] ?? 'manual';
    persistWindowDefaults(specParams, displaySettings, autoGainMode);
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
    const next = Math.max(
      SPECTROGRAM_GAIN_MIN_DB,
      Math.min(SPECTROGRAM_GAIN_MAX_DB, Math.round(win.displaySettings.gainDb + deltaDb)),
    );
    get().updateWindowDisplaySettings(windowId, { gainDb: next });
    const sign = next >= 0 ? `+${next}` : `${next}`;
    set({ statusMessage: `Gain: ${sign} dB` });
  },

  nudgeWindowFloor: (windowId, deltaPct) => {
    const win = get().windows.find((w) => w.windowId === windowId);
    if (!win) return;
    const next = Math.max(
      SPECTROGRAM_FLOOR_MIN,
      Math.min(SPECTROGRAM_FLOOR_MAX, Math.round(win.displaySettings.floor + deltaPct)),
    );
    get().updateWindowDisplaySettings(windowId, { floor: next });
    set({ statusMessage: `Floor: ${next}%` });
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
          defaultSpecParams: sanitizeSpecParams({
            ...s.defaultSpecParams,
            ...(parsed.defaultSpecParams ?? {}),
          }),
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
            specParams: sanitizeSpecParams(savedWin.specParams),
            displaySettings: sanitizeDisplaySettings(savedWin.displaySettings),
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
    const winOff = file.windowStartSec ?? 0;
    return state.addAnnotation({
      soundfile: file.name,
      channel: sel.channel,
      startTimeSec: winOff + Math.min(sel.startSec, sel.endSec),
      endTimeSec: winOff + Math.max(sel.startSec, sel.endSec),
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
    const winOff = file.windowStartSec ?? 0;
    return state.addAnnotation({
      soundfile: file.name,
      channel: sel.channel,
      startTimeSec: winOff + Math.min(sel.startSec, sel.endSec),
      endTimeSec: winOff + Math.max(sel.startSec, sel.endSec),
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

    const applyJump = (curFile: AudioFileInfo, curWin: MDIWindowState) => {
      const winOff = curFile.windowStartSec ?? 0;
      const relStart = ann.startTimeSec - winOff;
      const relEnd = ann.endTimeSec - winOff;
      const currentSpan = curWin.viewRange.endSec - curWin.viewRange.startSec;
      const span =
        curWin.displaySettings.timeScaleMode === 'fixed'
          ? currentSpan
          : Math.max(0.25, (relEnd - relStart) * 3.0);
      const center = 0.5 * (relStart + relEnd);
      const startSec = Math.max(0, Math.min(Math.max(0, curFile.durationSec - span), center - span / 2));
      const endSec = Math.min(curFile.durationSec, startSec + span);
      get().focusWindow(curWin.windowId);
      get().updateWindowViewRange(curWin.windowId, {
        ...curWin.viewRange,
        startSec,
        endSec,
      });
    };

    const winOff = file.windowStartSec ?? 0;
    const winEnd = winOff + file.durationSec;
    if (file.isPartialWindow && (ann.endTimeSec < winOff || ann.startTimeSec > winEnd)) {
      const targetStart = Math.max(0, ann.startTimeSec - file.durationSec * 0.25);
      void state.setArchiveWindow(matchingWin.windowId, targetStart, file.durationSec).then(() => {
        const s2 = get();
        const w2 = s2.windows.find((w) => w.windowId === matchingWin.windowId);
        const f2 = w2 ? s2.files[w2.fileId] : undefined;
        if (w2 && f2) applyJump(f2, w2);
      });
      return;
    }

    applyJump(file, matchingWin);
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
    persistHotkeys(bindings);
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
