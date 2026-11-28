import {
  DEFAULT_DISPLAY_SETTINGS,
  DEFAULT_HOTKEY_BINDINGS,
  DEFAULT_SPECTROGRAM_PARAMS,
  SPECTROGRAM_FLOOR_MAX,
  SPECTROGRAM_FLOOR_MIN,
  SPECTROGRAM_GAIN_MAX_DB,
  SPECTROGRAM_GAIN_MIN_DB,
  type AnnotationRecord,
  type DisplaySettings,
  type HotkeyBinding,
  type SpectrogramParams,
} from '@syrinxone/shared';
import { normalizeAutoGainMode, type AutoGainMode } from '../utils/spectrogramFetch';

export const HOTKEYS_STORAGE_KEY = 'syrinxone.hotkeys.v1';
export const DEFAULTS_STORAGE_KEY = 'syrinxone.windowDefaults.v1';
export const ANNOTATIONS_STORAGE_KEY = 'syrinxone.annotations.v1';
export const ENGINE_STORAGE_KEY = 'syrinxone.engineConfig.v1';
export const ACTIVE_SOURCE_STORAGE_KEY = 'syrinxone.activeSource.v1';

export function loadSavedActiveSource(): { sourceId: string; displayName: string } {
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

export function persistActiveSource(sourceId: string, displayName: string): void {
  try {
    localStorage.setItem(
      ACTIVE_SOURCE_STORAGE_KEY,
      JSON.stringify({ sourceId, displayName }),
    );
  } catch {
    // ignore storage errors
  }
}

export function loadSavedEngineConfig(): { baseUrl: string; token: string } {
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

export function persistEngineConfig(baseUrl: string, token: string): void {
  try {
    localStorage.setItem(
      ENGINE_STORAGE_KEY,
      JSON.stringify({ baseUrl, token }),
    );
  } catch {
    // ignore
  }
}

export function isNarrowMobileViewport(): boolean {
  try {
    return typeof window !== 'undefined' && window.innerWidth <= 768;
  } catch {
    return false;
  }
}

export function loadSavedAnnotations(): {
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

export function persistAnnotations(
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

export function loadSavedHotkeys(): HotkeyBinding[] {
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

export function persistHotkeys(bindings: HotkeyBinding[]): void {
  try {
    localStorage.setItem(HOTKEYS_STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // ignore
  }
}

export function sanitizeDisplaySettings(raw?: Partial<DisplaySettings>): DisplaySettings {
  const merged = { ...DEFAULT_DISPLAY_SETTINGS, ...(raw ?? {}) };
  const rawRows = Number(merged.splitTimeRows);
  const rawGain = Number(merged.gainDb);
  const rawFloor = Number(merged.floor);
  return {
    colormap: merged.colormap,
    gainDb: Number.isFinite(rawGain)
      ? Math.max(SPECTROGRAM_GAIN_MIN_DB, Math.min(SPECTROGRAM_GAIN_MAX_DB, Math.round(rawGain)))
      : DEFAULT_DISPLAY_SETTINGS.gainDb,
    floor: Number.isFinite(rawFloor)
      ? Math.max(SPECTROGRAM_FLOOR_MIN, Math.min(SPECTROGRAM_FLOOR_MAX, Math.round(rawFloor)))
      : DEFAULT_DISPLAY_SETTINGS.floor,
    renderMode: merged.renderMode,
    timeScaleMode: merged.timeScaleMode,
    msPerPixel: merged.msPerPixel,
    showWaveform: Boolean(merged.showWaveform),
    showAxes: Boolean(merged.showAxes),
    showGrid: Boolean(merged.showGrid),
    showAnnotations: Boolean(merged.showAnnotations),
    showCursors: Boolean(merged.showCursors),
    lockSettings: Boolean(merged.lockSettings),
    interpolation: merged.interpolation,
    splitTimeRows: Number.isFinite(rawRows) ? Math.max(1, Math.min(10, Math.round(rawRows))) : 1,
    stackAllChannels: Boolean(merged.stackAllChannels),
  };
}

export function sanitizeSpecParams(raw?: Partial<SpectrogramParams>): SpectrogramParams {
  return {
    ...DEFAULT_SPECTROGRAM_PARAMS,
    ...(raw ?? {}),
    dspMode: 'modern_stft',
  };
}

export function loadSavedDefaults(): {
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
        specParams: sanitizeSpecParams(parsed.specParams),
        displaySettings: sanitizeDisplaySettings(parsed.displaySettings),
        autoGainMode,
      };
    }
  } catch {
    // ignore
  }
  return {
    specParams: sanitizeSpecParams(),
    displaySettings: { ...DEFAULT_DISPLAY_SETTINGS },
    autoGainMode: 'manual',
  };
}

export function persistWindowDefaults(
  specParams: SpectrogramParams,
  displaySettings: DisplaySettings,
  autoGainMode: AutoGainMode,
): void {
  try {
    localStorage.setItem(
      DEFAULTS_STORAGE_KEY,
      JSON.stringify({ specParams, displaySettings, autoGainMode }),
    );
  } catch {
    // ignore
  }
}

export function makeSpecCacheKey(fileId: string, params: SpectrogramParams): string {
  return [
    fileId,
    params.channel,
    params.fftSize,
    params.hopSize,
    params.windowType,
    params.dspMode,
    params.popFilter ? 1 : 0,
  ].join('|');
}

export function parentPrefix(uri: string): string {
  const norm = uri.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  if (idx <= 0) return '';
  const dir = uri.slice(0, idx);
  return dir.endsWith(':') ? `${dir}\\` : dir;
}
