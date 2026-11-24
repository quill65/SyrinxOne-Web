export type AnnotationFormat = 'syrinx_txt' | 'raven_txt' | 'csv' | 'json';

export interface AnnotationRecord {
  id: string;
  soundfile: string;
  /** 1-based channel number matching classic Syrinx CAnnotation */
  channel: number;
  startTimeSec: number;
  endTimeSec: number;
  lowFreqHz: number;
  highFreqHz: number;
  comment: string;
  notes: string;
  extraFields: Record<string, string | number>;
  modified?: boolean;
}

export interface AnnotationDocument {
  annotations: AnnotationRecord[];
  nonAnnotationLines: string[];
  sourceUri?: string;
  addTime?: boolean;
  addDate?: boolean;
}

export interface AnnotationFilter {
  includeFilter: boolean;
  includeText: string;
  excludeFilter: boolean;
  excludeText: string;
  excludeEmpty: boolean;
  channels: number[]; // empty means all channels
}

export interface HotkeyBinding {
  key: string; // single lowercase character e.g. 'a', '1'
  comment: string;
  notes?: string;
}

export const DEFAULT_ANNOTATION_FILTER: AnnotationFilter = {
  includeFilter: false,
  includeText: '',
  excludeFilter: false,
  excludeText: '',
  excludeEmpty: false,
  channels: [],
};

export const DEFAULT_HOTKEY_BINDINGS: HotkeyBinding[] = [
  { key: '1', comment: 'Call A' },
  { key: '2', comment: 'Call B' },
  { key: '3', comment: 'Song' },
  { key: '4', comment: 'Noise' },
];
