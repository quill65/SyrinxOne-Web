import type { DisplaySettings, SpectrogramParams } from './audio.js';

export interface TimeFreqRange {
  startSec: number;
  endSec: number;
  minFreqHz: number;
  maxFreqHz: number;
}

export interface SelectionBox {
  startSec: number;
  endSec: number;
  lowFreqHz: number;
  highFreqHz: number;
  channel: number; // 1-based
}

export interface CursorReadout {
  timeSec: number;
  freqHz: number;
  valueDb?: number;
  channel: number;
}

export interface MDIWindowState {
  windowId: string;
  fileId: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  showTitlebar: boolean;
  linkGroupId: string | null;
  viewRange: TimeFreqRange;
  specParams: SpectrogramParams;
  displaySettings: DisplaySettings;
  selection: SelectionBox | null;
}

export interface SavedDisplayWindow {
  sourceId: string;
  uri: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  showTitlebar: boolean;
  linkGroupId: string | null;
  viewRange: TimeFreqRange;
  specParams: SpectrogramParams;
  displaySettings: DisplaySettings;
}

export interface SavedDisplayFile {
  version: 1;
  savedAtIso: string;
  windows: SavedDisplayWindow[];
  defaultSpecParams?: SpectrogramParams;
  defaultDisplaySettings?: DisplaySettings;
}

export type LayoutCommand =
  | 'tile_grid'
  | 'tile_horizontal'
  | 'tile_vertical'
  | 'cascade'
  | 'resize_all_to_active'
  | 'fit_screen';

export interface DesktopBridge {
  getBackendConfig: () => Promise<{ baseUrl: string; token: string }>;
  openAudioFilesDialog: () => Promise<string[]>;
  openAnnotationFileDialog: () => Promise<string | null>;
  saveFileDialog: (options: {
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<string | null>;
  onMenuCommand: (handler: (command: string) => void) => () => void;
}
