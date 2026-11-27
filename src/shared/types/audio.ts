export type WindowType = 'blackman' | 'hamming' | 'hann' | 'rect';
export type DspMode = 'modern_stft';
export type RenderMode = 'webgl_float32' | 'server_bitmap';
export type TimeScaleMode = 'stretch' | 'fixed';
export type ColormapName =
  | 'grayscale_bow'
  | 'grayscale_wob'
  | 'viridis'
  | 'magma'
  | 'inferno'
  | 'turbo';

export type DataSourceKind = 'local_fs' | 's3' | 'gcs' | 'gdrive' | 'http' | 'custom';

export interface DataSourceInfo {
  sourceId: string;
  displayName: string;
  kind: DataSourceKind;
  readOnly: boolean;
  rootPath?: string;
  description?: string;
  anonymous?: boolean;
  removable?: boolean;
}

export interface CreateSourceRequest {
  kind: 's3' | 'gcs' | 'gdrive' | 'http';
  sourceId?: string;
  displayName?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  endpointUrl?: string;
  anonymous?: boolean;
  folderOrUrl?: string;
  apiKey?: string;
  oauthToken?: string;
  readOnly?: boolean;
}

export interface BrowseEntry {
  name: string;
  uri: string;
  isDir: boolean;
  sizeBytes?: number;
  kind?: 'audio' | 'annotation' | 'other';
}

export interface AudioFileInfo {
  fileId: string;
  sourceId: string;
  uri: string;
  name: string;
  sampleRate: number;
  numChannels: number;
  numFrames: number;
  durationSec: number;
  format: string;
  subtype: string;
  startDateTimeIso?: string | null;
  windowStartSec?: number;
  totalDurationSec?: number;
  isPartialWindow?: boolean;
}

export interface MeasureSelectionRequest {
  channel: number;
  startSec: number;
  endSec: number;
  lowFreqHz: number;
  highFreqHz: number;
  fftSize?: number;
  hopSize?: number;
}

export interface SelectionMeasurements {
  durationSec: number;
  lowFreqHz: number;
  highFreqHz: number;
  bandwidthHz: number;
  peakFreqHz: number;
  centroidFreqHz: number;
  q5FreqHz: number;
  q50FreqHz: number;
  q95FreqHz: number;
  bw90Hz: number;
  timeOfPeakSec: number;
  rmsDb: number;
  peakDb: number;
  noiseFloorDb: number;
  snrDb: number;
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SuggestedDetectParams {
  minFreqHz: number;
  maxFreqHz: number;
  triggerThresholdDb: number;
  minSoundDurSec: number;
  maxSilenceGapSec: number;
  comment: string;
}

export interface AiAnalyzeRequest {
  fileId: string;
  channel: number;
  prompt: string;
  history?: AiChatMessage[];
  selection?: {
    startSec: number;
    endSec: number;
    lowFreqHz: number;
    highFreqHz: number;
  };
  viewRange?: {
    startSec: number;
    endSec: number;
    minFreqHz: number;
    maxFreqHz: number;
  };
  specParams?: SpectrogramParams;
  displaySettings?: DisplaySettings;
  annotations?: import('./annotations.js').AnnotationRecord[];
  includeSpectrogramImage?: boolean;
  apiKey?: string;
  model?: string;
}

export interface AiAnalyzeResponse {
  answer: string;
  modelUsed: string;
  measurements?: SelectionMeasurements;
  suggestedDetectParams?: SuggestedDetectParams;
  suggestedLabels: string[];
}

export interface SpectrogramParams {
  channel: number; // 0-based internal channel index
  fftSize: number;
  hopSize: number;
  windowType: WindowType;
  dspMode: DspMode;
  popFilter: boolean;
}

export const SPECTROGRAM_BASE_FLOOR_DB = -80;
export const SPECTROGRAM_SPAN_DB = 60;
export const SPECTROGRAM_GAIN_MIN_DB = -60;
export const SPECTROGRAM_GAIN_MAX_DB = 80;
export const SPECTROGRAM_FLOOR_MIN = 0;
export const SPECTROGRAM_FLOOR_MAX = 95;

export interface DisplaySettings {
  colormap: ColormapName;
  /** Gain shift in dB (-60..+80) moving target signal across the display window */
  gainDb: number;
  /** Background cutoff threshold (0..95%): levels below Floor snap cleanly to pure background */
  floor: number;
  renderMode: RenderMode;
  timeScaleMode: TimeScaleMode;
  /** Milliseconds per horizontal pixel when timeScaleMode === 'fixed' */
  msPerPixel: number;
  showWaveform: boolean;
  showAxes: boolean;
  showGrid: boolean;
  showAnnotations: boolean;
  showCursors: boolean;
  lockSettings: boolean;
  interpolation: 'nearest' | 'linear';
  /** Number of contiguous horizontal time-split rows (1..10) */
  splitTimeRows: number;
  /** When true, display all audio channels as stacked rows */
  stackAllChannels: boolean;
}

export interface SpectrogramMatrix {
  fileId: string;
  channel: number;
  numTimeBins: number;
  numFreqBins: number;
  timeStepSec: number;
  freqStepHz: number;
  startSec: number;
  endSec: number;
  minFreqHz: number;
  maxFreqHz: number;
  minValue: number;
  maxValue: number;
  dspMode: DspMode;
  /** Row-major [timeIndex * numFreqBins + freqIndex] Float32 values (dB or classic scaled) */
  data: Float32Array;
}

export interface WaveformOverview {
  fileId: string;
  channel: number;
  numBins: number;
  startSec: number;
  endSec: number;
  minValues: number[];
  maxValues: number[];
}

export interface ClipSaveRequest {
  fileId: string;
  startSec: number;
  endSec: number;
  channels?: number[];
  targetSourceId: string;
  targetDirectory: string;
  nameTemplate: string;
  comment?: string;
  openInWindow?: boolean;
}

export interface ClipSaveResponse {
  savedUri: string;
  savedName: string;
  fileInfo?: AudioFileInfo;
}

export interface DetectSoundsRequest {
  channel?: number;
  fftSize?: number;
  hopSize?: number;
  minFreqHz: number;
  maxFreqHz: number;
  triggerThresholdDb: number;
  minTriggerDurSec: number;
  minSoundDurSec: number;
  maxSilenceGapSec: number;
  preBufferSec: number;
  postBufferSec: number;
  popFilter: boolean;
  startSec?: number;
  endSec?: number;
  comment: string;
  saveClips?: boolean;
  targetSourceId?: string;
  targetDirectory?: string;
  clipNameTemplate?: string;
}

export interface DetectSoundsResponse {
  detections: import('./annotations.js').AnnotationRecord[];
  noiseFloorDb: number;
  savedClips: string[];
}

export const DEFAULT_SPECTROGRAM_PARAMS: SpectrogramParams = {
  channel: 0,
  fftSize: 512,
  hopSize: 128,
  windowType: 'hann',
  dspMode: 'modern_stft',
  popFilter: false,
};

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  colormap: 'grayscale_bow',
  gainDb: 0,
  floor: 0,
  renderMode: 'webgl_float32',
  timeScaleMode: 'stretch',
  msPerPixel: 4.0,
  showWaveform: true,
  showAxes: true,
  showGrid: false,
  showAnnotations: true,
  showCursors: true,
  lockSettings: false,
  interpolation: 'linear',
  splitTimeRows: 1,
  stackAllChannels: false,
};
