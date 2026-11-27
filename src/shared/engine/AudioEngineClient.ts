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

class EngineHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'EngineHttpError';
    this.status = status;
    this.body = body;
  }
}

interface RegisteredAudioMeta {
  sourceId: string;
  uri: string;
  options?: { startSec?: number; maxDurationSec?: number };
}

export class HttpAudioEngineClient implements AudioEngineClient {
  private baseUrl: string;
  private token?: string;
  private sourceRegistry = new Map<string, CreateSourceRequest>();
  private fileRegistry = new Map<string, RegisteredAudioMeta>();
  private uploadedFileRegistry = new Map<string, File>();
  private fileIdAliases = new Map<string, string>();
  private reopenPromises = new Map<string, Promise<string | null>>();
  private restoreSourcePromises = new Map<string, Promise<boolean>>();

  constructor(config: EngineConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
  }

  public setConfig(config: EngineConfig): void {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
  }

  private resolveFileId(fileId: string): string {
    let cur = fileId;
    const seen = new Set<string>();
    while (this.fileIdAliases.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.fileIdAliases.get(cur)!;
    }
    return cur;
  }

  private isSessionMissingError(err: unknown): boolean {
    if (err instanceof EngineHttpError) {
      return err.status === 404;
    }
    if (err instanceof Error) {
      return /\(404\)/.test(err.message) && /not loaded in session|not found/i.test(err.message);
    }
    return false;
  }

  private async ensureSourceRestored(sourceId: string): Promise<boolean> {
    const savedReq = this.sourceRegistry.get(sourceId);
    if (!savedReq) return false;
    const existing = this.restoreSourcePromises.get(sourceId);
    if (existing) return existing;

    const p = (async () => {
      try {
        await this.requestJson<DataSourceInfo>('/api/sources', {
          method: 'POST',
          body: JSON.stringify(savedReq),
        });
        return true;
      } catch {
        return false;
      } finally {
        this.restoreSourcePromises.delete(sourceId);
      }
    })();

    this.restoreSourcePromises.set(sourceId, p);
    return p;
  }

  private async reopenFileSession(originalFileId: string, currentFileId: string): Promise<string | null> {
    const key = currentFileId || originalFileId;
    const inflight = this.reopenPromises.get(key) ?? this.reopenPromises.get(originalFileId);
    if (inflight) return inflight;

    const p = (async (): Promise<string | null> => {
      const uploadedFile =
        this.uploadedFileRegistry.get(currentFileId) ?? this.uploadedFileRegistry.get(originalFileId);
      if (uploadedFile) {
        const info = await this.uploadAudio(uploadedFile);
        this.fileIdAliases.set(originalFileId, info.fileId);
        this.fileIdAliases.set(currentFileId, info.fileId);
        return info.fileId;
      }

      const meta = this.fileRegistry.get(currentFileId) ?? this.fileRegistry.get(originalFileId);
      if (!meta || meta.sourceId === 'upload' || !meta.uri) {
        return null;
      }

      const info = await this.openAudio(meta.sourceId, meta.uri, meta.options);
      this.fileIdAliases.set(originalFileId, info.fileId);
      this.fileIdAliases.set(currentFileId, info.fileId);
      return info.fileId;
    })().finally(() => {
      this.reopenPromises.delete(key);
      this.reopenPromises.delete(originalFileId);
    });

    this.reopenPromises.set(key, p);
    return p;
  }

  private async withFileSessionRetry<T>(
    fileId: string,
    op: (resolvedFileId: string) => Promise<T>,
  ): Promise<T> {
    const currentId = this.resolveFileId(fileId);
    try {
      return await op(currentId);
    } catch (err) {
      if (!this.isSessionMissingError(err)) {
        throw err;
      }
      const reopenedId = await this.reopenFileSession(fileId, currentId);
      if (!reopenedId) {
        throw err;
      }
      return await op(reopenedId);
    }
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
      throw new EngineHttpError(`Engine request failed (${res.status}): ${text}`, res.status, text);
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
    const created = await this.requestJson<DataSourceInfo>('/api/sources', {
      method: 'POST',
      body: JSON.stringify(req),
    });
    this.sourceRegistry.set(created.sourceId, { ...req, sourceId: created.sourceId });
    return created;
  }

  async removeSource(sourceId: string): Promise<{ removed: string }> {
    this.sourceRegistry.delete(sourceId);
    return this.requestJson(`/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'DELETE',
    });
  }

  async browseSource(sourceId: string, prefix = '', limit = 1000): Promise<BrowseEntry[]> {
    const q = new URLSearchParams({ prefix, limit: String(limit) });
    const url = `/api/sources/${encodeURIComponent(sourceId)}/browse?${q.toString()}`;
    try {
      return await this.requestJson(url);
    } catch (err) {
      if (this.isSessionMissingError(err) && (await this.ensureSourceRestored(sourceId))) {
        return await this.requestJson(url);
      }
      throw err;
    }
  }

  async openAudio(
    sourceId: string,
    uri: string,
    options?: { startSec?: number; maxDurationSec?: number },
  ): Promise<AudioFileInfo> {
    const payload = JSON.stringify({
      sourceId,
      uri,
      ...(options?.startSec !== undefined ? { startSec: options.startSec } : {}),
      ...(options?.maxDurationSec !== undefined
        ? { maxDurationSec: options.maxDurationSec }
        : {}),
    });
    let info: AudioFileInfo;
    try {
      info = await this.requestJson<AudioFileInfo>('/api/audio/open', {
        method: 'POST',
        body: payload,
      });
    } catch (err) {
      if (this.isSessionMissingError(err) && (await this.ensureSourceRestored(sourceId))) {
        info = await this.requestJson<AudioFileInfo>('/api/audio/open', {
          method: 'POST',
          body: payload,
        });
      } else {
        throw err;
      }
    }
    this.fileRegistry.set(info.fileId, { sourceId, uri, options });
    return info;
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
    const info = await this.requestJson<AudioFileInfo>('/api/audio/upload', {
      method: 'POST',
      body: form,
    });
    this.uploadedFileRegistry.set(info.fileId, file);
    return info;
  }

  async measureSelection(
    fileId: string,
    req: MeasureSelectionRequest,
  ): Promise<SelectionMeasurements> {
    return this.withFileSessionRetry(fileId, (fid) =>
      this.requestJson(`/api/audio/${encodeURIComponent(fid)}/measure`, {
        method: 'POST',
        body: JSON.stringify(req),
      }),
    );
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
    return this.withFileSessionRetry(fileId, async (fid) => {
      const wf = await this.requestJson<WaveformOverview>(
        `/api/audio/${encodeURIComponent(fid)}/waveform?${q.toString()}`,
      );
      return { ...wf, fileId };
    });
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
      dsp_mode: 'modern_stft',
      pop_filter: String(params.popFilter),
    });
    if (range?.startSec !== undefined) q.set('start_sec', String(range.startSec));
    if (range?.endSec !== undefined) q.set('end_sec', String(range.endSec));
    if (range?.minFreqHz !== undefined) q.set('min_freq_hz', String(range.minFreqHz));
    if (range?.maxFreqHz !== undefined) q.set('max_freq_hz', String(range.maxFreqHz));

    return this.withFileSessionRetry(fileId, async (fid) => {
      const res = await fetch(
        `${this.baseUrl}/api/audio/${encodeURIComponent(fid)}/spectrogram?${q.toString()}`,
        { headers: this.headers() },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new EngineHttpError(
          `Spectrogram request failed (${res.status}): ${text}`,
          res.status,
          text,
        );
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
        dspMode: 'modern_stft',
        data: new Float32Array(buf),
      };
    });
  }

  getSpectrogramBitmapUrl(
    fileId: string,
    params: SpectrogramParams,
    display: DisplaySettings,
    range?: { startSec?: number; endSec?: number; minFreqHz?: number; maxFreqHz?: number },
  ): string {
    const fid = this.resolveFileId(fileId);
    const q = new URLSearchParams({
      channel: String(params.channel),
      fft_size: String(params.fftSize),
      hop_size: String(params.hopSize),
      window_type: params.windowType,
      dsp_mode: 'modern_stft',
      pop_filter: String(params.popFilter),
      colormap: display.colormap,
      gain_db: String(display.gainDb),
      floor: String(display.floor),
    });
    if (range?.startSec !== undefined) q.set('start_sec', String(range.startSec));
    if (range?.endSec !== undefined) q.set('end_sec', String(range.endSec));
    if (range?.minFreqHz !== undefined) q.set('min_freq_hz', String(range.minFreqHz));
    if (range?.maxFreqHz !== undefined) q.set('max_freq_hz', String(range.maxFreqHz));
    if (this.token) q.set('token', this.token);
    return `${this.baseUrl}/api/audio/${encodeURIComponent(fid)}/spectrogram.png?${q.toString()}`;
  }

  getAudioStreamUrl(fileId: string): string {
    const fid = this.resolveFileId(fileId);
    const q = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    return `${this.baseUrl}/api/audio/${encodeURIComponent(fid)}/stream${q}`;
  }

  async fetchAudioArrayBuffer(fileId: string): Promise<ArrayBuffer> {
    return this.withFileSessionRetry(fileId, async (fid) => {
      const res = await fetch(`${this.baseUrl}/api/audio/${encodeURIComponent(fid)}/stream`, {
        headers: this.headers(),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new EngineHttpError(`Audio stream fetch failed (${res.status}): ${text}`, res.status, text);
      }
      return res.arrayBuffer();
    });
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
      dsp_mode: 'modern_stft',
      pop_filter: String(params.popFilter),
    });
    if (range?.startSec !== undefined) q.set('start_sec', String(range.startSec));
    if (range?.endSec !== undefined) q.set('end_sec', String(range.endSec));
    if (range?.minFreqHz !== undefined) q.set('min_freq_hz', String(range.minFreqHz));
    if (range?.maxFreqHz !== undefined) q.set('max_freq_hz', String(range.maxFreqHz));
    return this.withFileSessionRetry(fileId, async (fid) => {
      const res = await fetch(
        `${this.baseUrl}/api/audio/${encodeURIComponent(fid)}/spectrogram.tsv?${q.toString()}`,
        { headers: this.headers() },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new EngineHttpError(
          `Spectrogram TSV export failed (${res.status}): ${text}`,
          res.status,
          text,
        );
      }
      return res.text();
    });
  }

  async detectSounds(fileId: string, req: DetectSoundsRequest): Promise<DetectSoundsResponse> {
    return this.withFileSessionRetry(fileId, (fid) =>
      this.requestJson(`/api/audio/${encodeURIComponent(fid)}/detect`, {
        method: 'POST',
        body: JSON.stringify(req),
      }),
    );
  }

  async clipAndSave(req: ClipSaveRequest): Promise<ClipSaveResponse> {
    const resp = await this.withFileSessionRetry(req.fileId, (fid) =>
      this.requestJson<ClipSaveResponse>('/api/audio/clip-save', {
        method: 'POST',
        body: JSON.stringify({ ...req, fileId: fid }),
      }),
    );
    if (resp.fileInfo) {
      this.fileRegistry.set(resp.fileInfo.fileId, {
        sourceId: resp.fileInfo.sourceId,
        uri: resp.fileInfo.uri,
      });
    }
    return resp;
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
