import type {
  AnnotationDocument,
  AnnotationFormat,
  AnnotationRecord,
} from '../types/annotations.js';
import type {
  AiAnalyzeRequest,
  AiAnalyzeResponse,
  AudioFileInfo,
  BrowseEntry,
  ClipSaveRequest,
  ClipSaveResponse,
  CreateSourceRequest,
  DataSourceInfo,
  DetectSoundsRequest,
  DetectSoundsResponse,
  DisplaySettings,
  MeasureSelectionRequest,
  SelectionMeasurements,
  SpectrogramMatrix,
  SpectrogramParams,
  WaveformOverview,
} from '../types/audio.js';

export interface EngineConfig {
  baseUrl: string;
  token?: string;
}

export interface AudioEngineClient {
  health(): Promise<{ status: string; version: string }>;
  listSources(): Promise<DataSourceInfo[]>;
  addSource(req: CreateSourceRequest): Promise<DataSourceInfo>;
  removeSource(sourceId: string): Promise<{ removed: string }>;
  browseSource(sourceId: string, prefix?: string, limit?: number): Promise<BrowseEntry[]>;
  openAudio(
    sourceId: string,
    uri: string,
    options?: { startSec?: number; maxDurationSec?: number },
  ): Promise<AudioFileInfo>;
  openAudioUrl(
    url: string,
    options?: { startSec?: number; maxDurationSec?: number },
  ): Promise<AudioFileInfo>;
  uploadAudio(file: File): Promise<AudioFileInfo>;
  measureSelection(fileId: string, req: MeasureSelectionRequest): Promise<SelectionMeasurements>;
  analyzeWithAi(req: AiAnalyzeRequest): Promise<AiAnalyzeResponse>;
  getWaveform(
    fileId: string,
    channel: number,
    numBins?: number,
    startSec?: number,
    endSec?: number,
  ): Promise<WaveformOverview>;
  getSpectrogram(
    fileId: string,
    params: SpectrogramParams,
    range?: { startSec?: number; endSec?: number; minFreqHz?: number; maxFreqHz?: number },
  ): Promise<SpectrogramMatrix>;
  getSpectrogramBitmapUrl(
    fileId: string,
    params: SpectrogramParams,
    display: DisplaySettings,
    range?: { startSec?: number; endSec?: number; minFreqHz?: number; maxFreqHz?: number },
  ): string;
  getAudioStreamUrl(fileId: string): string;
  fetchAudioArrayBuffer(fileId: string): Promise<ArrayBuffer>;
  exportSpectrogramTsv(
    fileId: string,
    params: SpectrogramParams,
    range?: { startSec?: number; endSec?: number; minFreqHz?: number; maxFreqHz?: number },
  ): Promise<string>;
  detectSounds(fileId: string, req: DetectSoundsRequest): Promise<DetectSoundsResponse>;
  clipAndSave(req: ClipSaveRequest): Promise<ClipSaveResponse>;
  importAnnotationsText(content: string, format: AnnotationFormat): Promise<AnnotationDocument>;
  importAnnotationsFromSource(
    sourceId: string,
    uri: string,
    format?: AnnotationFormat,
  ): Promise<AnnotationDocument>;
  exportAnnotationsText(
    annotations: AnnotationRecord[],
    format: AnnotationFormat,
    nonAnnotationLines?: string[],
  ): Promise<string>;
  saveAnnotationsToSource(
    sourceId: string,
    uri: string,
    annotations: AnnotationRecord[],
    format: AnnotationFormat,
    nonAnnotationLines?: string[],
  ): Promise<{ savedUri: string; count: number }>;
}

export class HttpAudioEngineClient implements AudioEngineClient {
  private baseUrl: string;
  private token?: string;

  constructor(config: EngineConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
  }

  public setConfig(config: EngineConfig): void {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) };
    if (this.token) {
      h['Authorization'] = `Bearer ${this.token}`;
    }
    return h;
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers({
        ...(init?.body && !(init.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...((init?.headers as Record<string, string>) ?? {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Engine request failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  async health(): Promise<{ status: string; version: string }> {
    return this.requestJson('/api/health');
  }

  async listSources(): Promise<DataSourceInfo[]> {
    return this.requestJson('/api/sources');
  }

  async addSource(req: CreateSourceRequest): Promise<DataSourceInfo> {
    return this.requestJson('/api/sources', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async removeSource(sourceId: string): Promise<{ removed: string }> {
    return this.requestJson(`/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'DELETE',
    });
  }

  async browseSource(sourceId: string, prefix = '', limit = 250): Promise<BrowseEntry[]> {
    const q = new URLSearchParams({ prefix, limit: String(limit) });
    return this.requestJson(`/api/sources/${encodeURIComponent(sourceId)}/browse?${q.toString()}`);
  }

  async openAudio(
    sourceId: string,
    uri: string,
    options?: { startSec?: number; maxDurationSec?: number },
  ): Promise<AudioFileInfo> {
    return this.requestJson('/api/audio/open', {
      method: 'POST',
      body: JSON.stringify({
        sourceId,
        uri,
        ...(options?.startSec !== undefined ? { startSec: options.startSec } : {}),
        ...(options?.maxDurationSec !== undefined
          ? { maxDurationSec: options.maxDurationSec }
          : {}),
      }),
    });
  }

  async openAudioUrl(
    url: string,
    options?: { startSec?: number; maxDurationSec?: number },
  ): Promise<AudioFileInfo> {
    return this.openAudio('http', url, options);
  }

  async uploadAudio(file: File): Promise<AudioFileInfo> {
    const form = new FormData();
    form.append('file', file);
    return this.requestJson('/api/audio/upload', {
      method: 'POST',
      body: form,
    });
  }

  async measureSelection(
    fileId: string,
    req: MeasureSelectionRequest,
  ): Promise<SelectionMeasurements> {
    return this.requestJson(`/api/audio/${encodeURIComponent(fileId)}/measure`, {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async analyzeWithAi(req: AiAnalyzeRequest): Promise<AiAnalyzeResponse> {
    return this.requestJson('/api/ai/analyze', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async getWaveform(
    fileId: string,
    channel: number,
    numBins = 2000,
    startSec?: number,
    endSec?: number,
  ): Promise<WaveformOverview> {
    const q = new URLSearchParams({
      channel: String(channel),
      num_bins: String(numBins),
    });
    if (startSec !== undefined) q.set('start_sec', String(startSec));
    if (endSec !== undefined) q.set('end_sec', String(endSec));
    return this.requestJson(`/api/audio/${encodeURIComponent(fileId)}/waveform?${q.toString()}`);
  }

  async getSpectrogram(
    fileId: string,
    params: SpectrogramParams,
    range?: { startSec?: number; endSec?: number; minFreqHz?: number; maxFreqHz?: number },
  ): Promise<SpectrogramMatrix> {
    const q = new URLSearchParams({
      channel: String(params.channel),
      fft_size: String(params.fftSize),
      hop_size: String(params.hopSize),
      window_type: params.windowType,
      dsp_mode: params.dspMode,
      pop_filter: String(params.popFilter),
      classic_gain: String(params.classicGain),
      classic_white_thresh: String(params.classicWhiteThresh),
    });
    if (range?.startSec !== undefined) q.set('start_sec', String(range.startSec));
    if (range?.endSec !== undefined) q.set('end_sec', String(range.endSec));
    if (range?.minFreqHz !== undefined) q.set('min_freq_hz', String(range.minFreqHz));
    if (range?.maxFreqHz !== undefined) q.set('max_freq_hz', String(range.maxFreqHz));

    const res = await fetch(
      `${this.baseUrl}/api/audio/${encodeURIComponent(fileId)}/spectrogram?${q.toString()}`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Spectrogram request failed (${res.status}): ${text}`);
    }
    const buf = await res.arrayBuffer();
    const numTimeBins = Number(res.headers.get('X-Spec-Time-Bins') ?? '0');
    const numFreqBins = Number(res.headers.get('X-Spec-Freq-Bins') ?? '0');
    const timeStepSec = Number(res.headers.get('X-Spec-Time-Step') ?? '0');
    const freqStepHz = Number(res.headers.get('X-Spec-Freq-Step') ?? '0');
    const startSec = Number(res.headers.get('X-Spec-Start-Sec') ?? '0');
    const endSec = Number(res.headers.get('X-Spec-End-Sec') ?? '0');
    const minFreqHz = Number(res.headers.get('X-Spec-Min-Freq') ?? '0');
    const maxFreqHz = Number(res.headers.get('X-Spec-Max-Freq') ?? '0');
    const minValue = Number(res.headers.get('X-Spec-Min-Val') ?? '-120');
    const maxValue = Number(res.headers.get('X-Spec-Max-Val') ?? '0');

    return {
      fileId,
      channel: params.channel,
      numTimeBins,
      numFreqBins,
      timeStepSec,
      freqStepHz,
      startSec,
      endSec,
      minFreqHz,
      maxFreqHz,
      minValue,
      maxValue,
      dspMode: params.dspMode,
      data: new Float32Array(buf),
    };
  }

  getSpectrogramBitmapUrl(
    fileId: string,
    params: SpectrogramParams,
    display: DisplaySettings,
    range?: { startSec?: number; endSec?: number; minFreqHz?: number; maxFreqHz?: number },
  ): string {
    const q = new URLSearchParams({
      channel: String(params.channel),
      fft_size: String(params.fftSize),
      hop_size: String(params.hopSize),
      window_type: params.windowType,
      dsp_mode: params.dspMode,
      pop_filter: String(params.popFilter),
      classic_gain: String(params.classicGain),
      classic_white_thresh: String(params.classicWhiteThresh),
      colormap: display.colormap,
      gain_db: String(display.gainDb),
      threshold_db: String(display.thresholdDb),
      dynamic_range_db: String(display.dynamicRangeDb),
    });
    if (range?.startSec !== undefined) q.set('start_sec', String(range.startSec));
    if (range?.endSec !== undefined) q.set('end_sec', String(range.endSec));
    if (range?.minFreqHz !== undefined) q.set('min_freq_hz', String(range.minFreqHz));
    if (range?.maxFreqHz !== undefined) q.set('max_freq_hz', String(range.maxFreqHz));
    if (this.token) q.set('token', this.token);
    return `${this.baseUrl}/api/audio/${encodeURIComponent(fileId)}/spectrogram.png?${q.toString()}`;
  }

  getAudioStreamUrl(fileId: string): string {
    const q = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    return `${this.baseUrl}/api/audio/${encodeURIComponent(fileId)}/stream${q}`;
  }

  async fetchAudioArrayBuffer(fileId: string): Promise<ArrayBuffer> {
    const res = await fetch(`${this.baseUrl}/api/audio/${encodeURIComponent(fileId)}/stream`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Audio stream fetch failed (${res.status})`);
    }
    return res.arrayBuffer();
  }

  async exportSpectrogramTsv(
    fileId: string,
    params: SpectrogramParams,
    range?: { startSec?: number; endSec?: number; minFreqHz?: number; maxFreqHz?: number },
  ): Promise<string> {
    const q = new URLSearchParams({
      channel: String(params.channel),
      fft_size: String(params.fftSize),
      hop_size: String(params.hopSize),
      window_type: params.windowType,
      dsp_mode: params.dspMode,
      pop_filter: String(params.popFilter),
    });
    if (range?.startSec !== undefined) q.set('start_sec', String(range.startSec));
    if (range?.endSec !== undefined) q.set('end_sec', String(range.endSec));
    if (range?.minFreqHz !== undefined) q.set('min_freq_hz', String(range.minFreqHz));
    if (range?.maxFreqHz !== undefined) q.set('max_freq_hz', String(range.maxFreqHz));
    const res = await fetch(
      `${this.baseUrl}/api/audio/${encodeURIComponent(fileId)}/spectrogram.tsv?${q.toString()}`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`Spectrogram TSV export failed (${res.status})`);
    }
    return res.text();
  }

  async detectSounds(fileId: string, req: DetectSoundsRequest): Promise<DetectSoundsResponse> {
    return this.requestJson(`/api/audio/${encodeURIComponent(fileId)}/detect`, {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async clipAndSave(req: ClipSaveRequest): Promise<ClipSaveResponse> {
    return this.requestJson('/api/audio/clip-save', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async importAnnotationsText(
    content: string,
    format: AnnotationFormat,
  ): Promise<AnnotationDocument> {
    return this.requestJson('/api/annotations/import-text', {
      method: 'POST',
      body: JSON.stringify({ content, format }),
    });
  }

  async importAnnotationsFromSource(
    sourceId: string,
    uri: string,
    format?: AnnotationFormat,
  ): Promise<AnnotationDocument> {
    return this.requestJson('/api/annotations/import-source', {
      method: 'POST',
      body: JSON.stringify({ sourceId, uri, format }),
    });
  }

  async exportAnnotationsText(
    annotations: AnnotationRecord[],
    format: AnnotationFormat,
    nonAnnotationLines: string[] = [],
  ): Promise<string> {
    const res = await this.requestJson<{ content: string }>('/api/annotations/export-text', {
      method: 'POST',
      body: JSON.stringify({ annotations, format, nonAnnotationLines }),
    });
    return res.content;
  }

  async saveAnnotationsToSource(
    sourceId: string,
    uri: string,
    annotations: AnnotationRecord[],
    format: AnnotationFormat,
    nonAnnotationLines: string[] = [],
  ): Promise<{ savedUri: string; count: number }> {
    return this.requestJson('/api/annotations/save-source', {
      method: 'POST',
      body: JSON.stringify({ sourceId, uri, annotations, format, nonAnnotationLines }),
    });
  }
}
