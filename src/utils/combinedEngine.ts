import type {
  AiAnalyzeRequest,
  AiAnalyzeResponse,
  AnnotationDocument,
  AnnotationFormat,
  AnnotationRecord,
  AudioEngineClient,
  AudioFileInfo,
  BrowseEntry,
  ClipSaveRequest,
  ClipSaveResponse,
  CreateSourceRequest,
  DataSourceInfo,
  DetectSoundsRequest,
  DetectSoundsResponse,
  DiscoveryProviderInfo,
  DiscoverSourcesRequest,
  DiscoverSourcesResponse,
  DisplaySettings,
  HttpAudioEngineClient,
  MeasureSelectionRequest,
  SelectionMeasurements,
  SourceVerificationResult,
  SpectrogramMatrix,
  SpectrogramParams,
  WaveformOverview,
} from '@syrinxone/shared';
import type { SegmentSourceSpec } from './contiguousArchive';
import {
  downsampleSpectrogramTime,
  fetchSpectrogramAdaptive,
  getSafeMaxWindowSec,
  getSmartArchiveWindowSec,
  MAX_WEBGL_TIME_BINS,
} from './spectrogramFetch';
import {
  fetchSparseSpectrogram,
  fetchSparseWaveform,
  shouldUseSparseSpectrogram,
} from './sparseSpectrogram';
import { parseTimestampFromName } from './timeFormat';

function inferIsoFromSpec(name: string, folderName?: string): string | null {
  const p = parseTimestampFromName(name) ?? (folderName ? parseTimestampFromName(folderName) : null);
  return p ? new Date(p.ms).toISOString() : null;
}

export interface CombinedSegment {
  index: number;
  sourceId: string;
  uri: string;
  name: string;
  folderName?: string;
  sizeBytes?: number;
  /** Parallel per-channel source files stacked as virtual channels 0..K-1. */
  channelFiles?: SegmentSourceSpec[];
  durationSec: number;
  probed: boolean;
  sampleRate: number;
  numChannels: number;
  format: string;
  subtype: string;
  startDateTimeIso?: string | null;
  timelineStartSec: number;
  timelineEndSec: number;
}

interface OpenedSliceCache {
  fileInfo: AudioFileInfo;
  sliceStartSec: number;
  sliceEndSec: number;
  lastUsedAt: number;
}

export interface CombinedRecording {
  combinedId: string;
  recordingKey: string;
  title: string;
  sourceId: string;
  uri: string;
  sampleRate: number;
  numChannels: number;
  hasVirtualChannels?: boolean;
  format: string;
  subtype: string;
  startDateTimeIso?: string | null;
  segments: CombinedSegment[];
  totalDurationSec: number;
  windowStartSec: number;
  windowDurationSec: number;
  isPartialWindow: boolean;
  openSlices: Map<string, OpenedSliceCache>;
}

const MAX_OPEN_SLICES_PER_COMBINED = 12;

export function isCombinedFileId(fileId: string | null | undefined): boolean {
  return typeof fileId === 'string' && fileId.startsWith('combined::');
}

function bytesPerSampleFromSubtype(subtype: string): number {
  const s = (subtype || '').toUpperCase();
  if (s.includes('24')) return 3;
  if (s.includes('32') || s.includes('FLOAT')) return 4;
  if (s.includes('DOUBLE') || s.includes('64')) return 8;
  if (s.includes('U8') || s.includes('S8') || s.includes('PCM_8')) return 1;
  return 2;
}

function isUncompressedFormat(format: string, name: string): boolean {
  const f = (format || '').toUpperCase();
  const n = name.toLowerCase();
  return f.includes('WAV') || f.includes('AIFF') || n.endsWith('.wav') || n.endsWith('.aif') || n.endsWith('.aiff');
}

function recomputeTimelines(rec: CombinedRecording): void {
  let cursor = 0;
  for (const seg of rec.segments) {
    seg.timelineStartSec = cursor;
    seg.timelineEndSec = cursor + Math.max(0.05, seg.durationSec);
    cursor = seg.timelineEndSec;
  }
  rec.totalDurationSec = cursor;
  if (!rec.isPartialWindow) {
    rec.windowStartSec = 0;
    rec.windowDurationSec = rec.totalDurationSec;
  } else {
    rec.windowStartSec = Math.max(
      0,
      Math.min(Math.max(0, rec.totalDurationSec - rec.windowDurationSec), rec.windowStartSec),
    );
  }
}

function encodeWavPcm16(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numCh = Math.max(1, channels.length);
  const numFrames = channels[0]?.length ?? 1;
  const dataBytes = numFrames * numCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(off + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  let ptr = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0));
      view.setInt16(ptr, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true);
      ptr += 2;
    }
  }
  return buf;
}

function tryParseWavPcmChannels(
  arrayBuf: ArrayBuffer,
): { channels: Float32Array[]; sampleRate: number } | null {
  if (arrayBuf.byteLength < 44) return null;
  const view = new DataView(arrayBuf);
  const ascii = (off: number, len: number) => {
    let s = '';
    for (let i = 0; i < len && off + i < view.byteLength; i++) {
      s += String.fromCharCode(view.getUint8(off + i));
    }
    return s;
  };
  const riff = ascii(0, 4);
  const wave = ascii(8, 4);
  if ((riff !== 'RIFF' && riff !== 'RF64') || wave !== 'WAVE') return null;

  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkId = ascii(offset, 4);
    const rawSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;
    if (chunkId === 'fmt ' && chunkDataStart + 16 <= view.byteLength) {
      audioFormat = view.getUint16(chunkDataStart, true);
      numChannels = view.getUint16(chunkDataStart + 2, true);
      sampleRate = view.getUint32(chunkDataStart + 4, true);
      bitsPerSample = view.getUint16(chunkDataStart + 14, true);
      if (audioFormat === 0xfffe && rawSize >= 40 && chunkDataStart + 26 <= view.byteLength) {
        audioFormat = view.getUint16(chunkDataStart + 24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = chunkDataStart;
      const available = Math.max(0, view.byteLength - chunkDataStart);
      dataSize = rawSize === 0xffffffff || rawSize === 0 ? available : Math.min(rawSize, available);
      break;
    }
    const paddedSize = rawSize + (rawSize & 1);
    const nextOffset = chunkDataStart + paddedSize;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (dataOffset < 0 || numChannels <= 0 || sampleRate <= 0 || (audioFormat !== 1 && audioFormat !== 3)) {
    return null;
  }
  const bytesPerSample = Math.floor(bitsPerSample / 8);
  if (bytesPerSample <= 0) return null;
  const frameBytes = bytesPerSample * numChannels;
  const numFrames = Math.floor(dataSize / frameBytes);
  if (numFrames <= 0) return null;

  const channels = Array.from({ length: numChannels }, () => new Float32Array(numFrames));
  for (let i = 0; i < numFrames; i++) {
    const base = dataOffset + i * frameBytes;
    for (let c = 0; c < numChannels; c++) {
      const p = base + c * bytesPerSample;
      let sample = 0;
      if (audioFormat === 3) {
        if (bitsPerSample === 32) sample = view.getFloat32(p, true);
        else if (bitsPerSample === 64) sample = view.getFloat64(p, true);
        else return null;
      } else if (bitsPerSample === 8) {
        sample = (view.getUint8(p) - 128) / 128;
      } else if (bitsPerSample === 16) {
        sample = view.getInt16(p, true) / 32768;
      } else if (bitsPerSample === 24) {
        let v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
        if (v & 0x800000) v |= ~0xffffff;
        sample = v / 8388608;
      } else if (bitsPerSample === 32) {
        sample = view.getInt32(p, true) / 2147483648;
      } else {
        return null;
      }
      channels[c][i] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
    }
  }
  return { channels, sampleRate };
}

function resampleLinear(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate || input.length <= 1) return input;
  const outLen = Math.max(1, Math.round((input.length * dstRate) / srcRate));
  const out = new Float32Array(outLen);
  const ratio = (input.length - 1) / Math.max(1, outLen - 1);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[Math.min(input.length - 1, idx + 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export class CombinedEngineProxy implements AudioEngineClient {
  private inner: HttpAudioEngineClient;
  private combinedMap = new Map<string, CombinedRecording>();
  private onDurationUpdatedCallback?: (fileInfo: AudioFileInfo) => void;

  constructor(inner: HttpAudioEngineClient) {
    this.inner = inner;
  }

  public setOnDurationUpdated(cb: (fileInfo: AudioFileInfo) => void): void {
    this.onDurationUpdatedCallback = cb;
  }

  public getCombinedRecording(fileId: string): CombinedRecording | undefined {
    return this.combinedMap.get(fileId);
  }

  public getCombinedInfo(fileId: string): AudioFileInfo | undefined {
    const rec = this.combinedMap.get(fileId);
    return rec ? this.toAudioFileInfo(rec) : undefined;
  }

  public getActiveSegmentsInWindow(fileId: string): CombinedSegment[] {
    const rec = this.combinedMap.get(fileId);
    if (!rec) return [];
    const wStart = rec.windowStartSec;
    const wEnd = wStart + this.getActiveWindowDuration(rec);
    return rec.segments.filter(
      (s) => s.timelineEndSec > wStart + 1e-4 && s.timelineStartSec < wEnd - 1e-4,
    );
  }

  private getActiveWindowDuration(rec: CombinedRecording): number {
    if (!rec.isPartialWindow) return rec.totalDurationSec;
    return Math.max(
      0.05,
      Math.min(rec.windowDurationSec, Math.max(0.05, rec.totalDurationSec - rec.windowStartSec)),
    );
  }

  public toAudioFileInfo(rec: CombinedRecording): AudioFileInfo {
    const activeDur = this.getActiveWindowDuration(rec);
    return {
      fileId: rec.combinedId,
      sourceId: rec.sourceId,
      uri: rec.uri,
      name: rec.title,
      sampleRate: rec.sampleRate,
      numChannels: rec.numChannels,
      numFrames: Math.round(activeDur * rec.sampleRate),
      durationSec: activeDur,
      format: rec.format,
      subtype: rec.subtype,
      startDateTimeIso: rec.startDateTimeIso,
      windowStartSec: rec.windowStartSec,
      totalDurationSec: rec.totalDurationSec,
      isPartialWindow: rec.isPartialWindow,
    };
  }

  public setCombinedWindow(
    fileId: string,
    startSec: number,
    maxDurationSec?: number,
  ): AudioFileInfo | undefined {
    const rec = this.combinedMap.get(fileId);
    if (!rec) return undefined;
    const reqLen = maxDurationSec ?? rec.windowDurationSec;
    if (reqLen >= rec.totalDurationSec - 0.5) {
      rec.isPartialWindow = false;
      rec.windowStartSec = 0;
      rec.windowDurationSec = rec.totalDurationSec;
      return this.toAudioFileInfo(rec);
    }
    const safeMax = getSafeMaxWindowSec(rec.sampleRate, rec.numChannels);
    const nextLen = Math.max(5, Math.min(rec.totalDurationSec, safeMax, Math.round(reqLen)));
    const nextStart = Math.max(0, Math.min(Math.max(0, rec.totalDurationSec - nextLen), startSec));
    rec.isPartialWindow = nextLen < rec.totalDurationSec - 0.5;
    rec.windowDurationSec = nextLen;
    rec.windowStartSec = rec.isPartialWindow ? nextStart : 0;
    return this.toAudioFileInfo(rec);
  }

  public async openCompleteAudio(
    sourceId: string,
    uri: string,
    recordingKey: string,
    options?: {
      startSec?: number;
      maxDurationSec?: number;
      fullTimeline?: boolean;
      sizeBytes?: number;
      name?: string;
    },
  ): Promise<AudioFileInfo> {
    const smartWin = getSmartArchiveWindowSec(options?.name ?? uri, options?.sizeBytes);
    const wantsFull = options?.fullTimeline !== false && options?.maxDurationSec === undefined;
    const openOpts = wantsFull
      ? smartWin !== undefined
        ? { startSec: 0, maxDurationSec: 1 }
        : undefined
      : options?.startSec !== undefined || options?.maxDurationSec !== undefined
        ? {
            ...(options.startSec !== undefined ? { startSec: options.startSec } : {}),
            ...(options.maxDurationSec !== undefined ? { maxDurationSec: options.maxDurationSec } : {}),
          }
        : undefined;

    const rawInfo = await this.inner.openAudio(sourceId, uri, openOpts);
    const preferredName = options?.name?.trim();
    const info: AudioFileInfo =
      preferredName && preferredName.length > 0 && rawInfo.name !== preferredName
        ? { ...rawInfo, name: preferredName }
        : rawInfo;
    const totalDur = Math.max(0.05, info.totalDurationSec ?? info.durationSec);
    const safeMax = getSafeMaxWindowSec(info.sampleRate, info.numChannels);

    // Small file that loaded completely in one call: return directly
    if (!info.isPartialWindow && totalDur <= safeMax) {
      return info;
    }

    // Explicit partial slice requested and user opted out of full timeline
    if (!wantsFull && info.isPartialWindow) {
      return info;
    }

    // Wrap large archive file as a single-segment Random-Access Complete Recording
    const seg: CombinedSegment = {
      index: 0,
      sourceId,
      uri,
      name: info.name,
      sizeBytes: options?.sizeBytes,
      durationSec: totalDur,
      probed: true,
      sampleRate: info.sampleRate,
      numChannels: info.numChannels,
      format: info.format,
      subtype: info.subtype,
      startDateTimeIso: info.startDateTimeIso ?? inferIsoFromSpec(info.name),
      timelineStartSec: 0,
      timelineEndSec: totalDur,
    };

    const combinedId = `combined::${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const rec: CombinedRecording = {
      combinedId,
      recordingKey,
      title: info.name,
      sourceId,
      uri,
      sampleRate: info.sampleRate,
      numChannels: info.numChannels,
      format: info.format,
      subtype: info.subtype,
      startDateTimeIso: seg.startDateTimeIso,
      segments: [seg],
      totalDurationSec: totalDur,
      windowStartSec: 0,
      windowDurationSec: totalDur,
      isPartialWindow: false,
      openSlices: new Map(),
    };
    const sliceStart = info.windowStartSec ?? 0;
    rec.openSlices.set('0:0', {
      fileInfo: info,
      sliceStartSec: sliceStart,
      sliceEndSec: sliceStart + info.durationSec,
      lastUsedAt: Date.now(),
    });

    this.combinedMap.set(combinedId, rec);
    return this.toAudioFileInfo(rec);
  }

  private resolveSegmentTarget(
    rec: CombinedRecording,
    seg: CombinedSegment,
    virtualChannel: number,
  ): { sourceId: string; uri: string; name: string; sizeBytes?: number; innerChannel: number; cacheKey: string } {
    if (rec.hasVirtualChannels && seg.channelFiles && seg.channelFiles.length > 0) {
      const chIdx = Math.max(0, Math.min(seg.channelFiles.length - 1, virtualChannel));
      const cf = seg.channelFiles[chIdx];
      return {
        sourceId: cf.sourceId,
        uri: cf.uri,
        name: cf.name,
        sizeBytes: cf.sizeBytes,
        innerChannel: 0,
        cacheKey: `${seg.index}:${chIdx}`,
      };
    }
    return {
      sourceId: seg.sourceId,
      uri: seg.uri,
      name: seg.name,
      sizeBytes: seg.sizeBytes,
      innerChannel: virtualChannel,
      cacheKey: `${seg.index}:0`,
    };
  }

  public async openCombinedArchive(
    specs: SegmentSourceSpec[],
    title: string,
    recordingKey: string,
    options?: { startSec?: number; maxDurationSec?: number; fullTimeline?: boolean },
  ): Promise<AudioFileInfo> {
    if (specs.length === 0) {
      throw new Error('No audio segments selected to combine.');
    }
    const maxVirtualCh = specs.reduce((m, s) => Math.max(m, s.channelFiles?.length ?? 0), 0);
    const hasVirtualChannels = maxVirtualCh > 1;

    if (specs.length === 1 && !hasVirtualChannels) {
      return this.openCompleteAudio(specs[0].sourceId, specs[0].uri, recordingKey, {
        ...options,
        sizeBytes: specs[0].sizeBytes,
        name: specs[0].name,
      });
    }

    // Probe segment 0 (channel 0) with a minimal 1s slice for large files to minimize startup I/O
    const firstSpec = specs[0];
    const firstTarget = firstSpec.channelFiles?.[0] ?? firstSpec;
    const smartFirstMax = getSmartArchiveWindowSec(firstTarget.name, firstTarget.sizeBytes);
    const firstProbeOpt =
      smartFirstMax !== undefined ? { startSec: 0, maxDurationSec: 1 } : undefined;
    const firstInfo = await this.inner.openAudio(firstTarget.sourceId, firstTarget.uri, firstProbeOpt);
    const firstTotalDur = Math.max(0.05, firstInfo.totalDurationSec ?? firstInfo.durationSec);
    const bps = bytesPerSampleFromSubtype(firstInfo.subtype);
    const pcmBytesPerSec = Math.max(1, firstInfo.sampleRate * firstInfo.numChannels * bps);
    const firstSize = firstTarget.sizeBytes;
    const effectiveNumChannels = hasVirtualChannels ? maxVirtualCh : firstInfo.numChannels;

    const segments: CombinedSegment[] = specs.map((spec, idx) => {
      const refTarget = spec.channelFiles?.[0] ?? spec;
      let dur = firstTotalDur;
      if (idx === 0) {
        dur = firstTotalDur;
      } else if (refTarget.sizeBytes && refTarget.sizeBytes > 64) {
        if (isUncompressedFormat(firstInfo.format, refTarget.name)) {
          dur = Math.max(0.1, (refTarget.sizeBytes - 44) / pcmBytesPerSec);
        } else if (firstSize && firstSize > 64) {
          dur = Math.max(0.1, firstTotalDur * (refTarget.sizeBytes / firstSize));
        }
      }
      return {
        index: idx,
        sourceId: refTarget.sourceId,
        uri: refTarget.uri,
        name: refTarget.name,
        folderName: spec.folderName ?? refTarget.folderName,
        sizeBytes: refTarget.sizeBytes,
        channelFiles: spec.channelFiles,
        durationSec: dur,
        probed: idx === 0,
        sampleRate: firstInfo.sampleRate,
        numChannels: effectiveNumChannels,
        format: firstInfo.format,
        subtype: firstInfo.subtype,
        startDateTimeIso:
          idx === 0
            ? firstInfo.startDateTimeIso ?? inferIsoFromSpec(refTarget.name, spec.folderName)
            : inferIsoFromSpec(refTarget.name, spec.folderName),
        timelineStartSec: 0,
        timelineEndSec: 0,
      };
    });

    const combinedId = `combined::${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const resolvedStartIso =
      firstInfo.startDateTimeIso ?? inferIsoFromSpec(firstTarget.name, firstSpec.folderName);

    const rec: CombinedRecording = {
      combinedId,
      recordingKey,
      title,
      sourceId: firstTarget.sourceId,
      uri:
        specs.length > 1
          ? `${firstTarget.uri}..${specs[specs.length - 1].name} (${specs.length} segments)`
          : `${firstTarget.uri} (${effectiveNumChannels} ch)`,
      sampleRate: firstInfo.sampleRate,
      numChannels: effectiveNumChannels,
      hasVirtualChannels,
      format: firstInfo.format,
      subtype: firstInfo.subtype,
      startDateTimeIso: resolvedStartIso,
      segments,
      totalDurationSec: 0,
      windowStartSec: 0,
      windowDurationSec: 900,
      isPartialWindow: false,
      openSlices: new Map(),
    };
    recomputeTimelines(rec);

    // Seed segment 0 / channel 0 open slice
    const sliceStart0 = firstInfo.windowStartSec ?? 0;
    rec.openSlices.set('0:0', {
      fileInfo: firstInfo,
      sliceStartSec: sliceStart0,
      sliceEndSec: sliceStart0 + firstInfo.durationSec,
      lastUsedAt: Date.now(),
    });

    const explicitPartial =
      options?.fullTimeline === false && options?.maxDurationSec !== undefined;
    if (explicitPartial) {
      const safeMax = getSafeMaxWindowSec(rec.sampleRate, rec.numChannels);
      const winLen = Math.max(
        5,
        Math.min(rec.totalDurationSec, safeMax, Math.round(options.maxDurationSec!)),
      );
      const isPartial = winLen < rec.totalDurationSec - 0.5;
      rec.isPartialWindow = isPartial;
      rec.windowDurationSec = winLen;
      rec.windowStartSec = isPartial
        ? Math.max(0, Math.min(Math.max(0, rec.totalDurationSec - winLen), options?.startSec ?? 0))
        : 0;
    } else {
      // Complete-Recording random-access mode: view & address 0 .. totalDurationSec via sparse reads
      rec.isPartialWindow = false;
      rec.windowDurationSec = rec.totalDurationSec;
      rec.windowStartSec = 0;
    }

    this.combinedMap.set(combinedId, rec);
    return this.toAudioFileInfo(rec);
  }

  private async ensureSegmentSlice(
    rec: CombinedRecording,
    segIndex: number,
    segLocalStart: number,
    segLocalEnd: number,
    virtualChannel = 0,
  ): Promise<{ slice: OpenedSliceCache; innerChannel: number }> {
    const seg = rec.segments[segIndex];
    if (!seg) throw new Error(`Missing combined segment #${segIndex}`);

    const target = this.resolveSegmentTarget(rec, seg, virtualChannel);
    const existing = rec.openSlices.get(target.cacheKey);
    if (
      existing &&
      existing.sliceStartSec <= segLocalStart + 0.005 &&
      existing.sliceEndSec >= segLocalEnd - 0.005
    ) {
      existing.lastUsedAt = Date.now();
      return { slice: existing, innerChannel: target.innerChannel };
    }

    const perFileCh = rec.hasVirtualChannels ? 1 : seg.numChannels;
    const safeMax = getSafeMaxWindowSec(seg.sampleRate, perFileCh);
    const reqSpan = Math.max(5, segLocalEnd - segLocalStart);
    const openFull =
      seg.durationSec <= safeMax &&
      (target.sizeBytes === undefined || target.sizeBytes <= 25 * 1024 * 1024);

    let opened: AudioFileInfo;
    if (openFull) {
      opened = await this.inner.openAudio(target.sourceId, target.uri);
    } else {
      const targetLen = Math.min(seg.durationSec, safeMax, Math.max(reqSpan + 30, 300));
      const padStart = Math.max(0, Math.min(Math.max(0, seg.durationSec - targetLen), segLocalStart - 5));
      opened = await this.inner.openAudio(target.sourceId, target.uri, {
        startSec: padStart,
        maxDurationSec: Math.ceil(targetLen),
      });
    }

    const exactDur = Math.max(0.05, opened.totalDurationSec ?? opened.durationSec);
    if (!seg.probed || Math.abs(exactDur - seg.durationSec) > 0.25) {
      seg.probed = true;
      seg.durationSec = exactDur;
      seg.sampleRate = opened.sampleRate;
      if (!rec.hasVirtualChannels) {
        seg.numChannels = opened.numChannels;
      }
      if (opened.startDateTimeIso) {
        seg.startDateTimeIso = opened.startDateTimeIso;
        if (segIndex === 0) rec.startDateTimeIso = opened.startDateTimeIso;
      }
      recomputeTimelines(rec);
      this.onDurationUpdatedCallback?.(this.toAudioFileInfo(rec));
    }

    const sliceStart = opened.windowStartSec ?? 0;
    const entry: OpenedSliceCache = {
      fileInfo: opened,
      sliceStartSec: sliceStart,
      sliceEndSec: sliceStart + opened.durationSec,
      lastUsedAt: Date.now(),
    };
    rec.openSlices.set(target.cacheKey, entry);

    if (rec.openSlices.size > MAX_OPEN_SLICES_PER_COMBINED) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of rec.openSlices.entries()) {
        if (k !== target.cacheKey && v.lastUsedAt < oldestTime) {
          oldestTime = v.lastUsedAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) rec.openSlices.delete(oldestKey);
    }

    return { slice: entry, innerChannel: target.innerChannel };
  }

  private resolveOverlappingSegments(
    rec: CombinedRecording,
    relStartSec: number,
    relEndSec: number,
  ): Array<{ seg: CombinedSegment; segLocalStart: number; segLocalEnd: number; winOffsetStart: number }> {
    const activeDur = this.getActiveWindowDuration(rec);
    const s = Math.max(0, Math.min(activeDur, relStartSec));
    const e = Math.max(s + 1e-4, Math.min(activeDur, relEndSec));
    const absStart = rec.windowStartSec + s;
    const absEnd = rec.windowStartSec + e;

    const out: Array<{
      seg: CombinedSegment;
      segLocalStart: number;
      segLocalEnd: number;
      winOffsetStart: number;
    }> = [];

    for (const seg of rec.segments) {
      if (seg.timelineEndSec <= absStart + 1e-6 || seg.timelineStartSec >= absEnd - 1e-6) continue;
      const segLocalStart = Math.max(0, absStart - seg.timelineStartSec);
      const segLocalEnd = Math.min(seg.durationSec, absEnd - seg.timelineStartSec);
      if (segLocalEnd <= segLocalStart + 1e-5) continue;
      out.push({
        seg,
        segLocalStart,
        segLocalEnd,
        winOffsetStart: seg.timelineStartSec - rec.windowStartSec,
      });
    }
    return out;
  }

  // ---- Delegated engine management methods ----
  setConfig(config: { baseUrl: string; token?: string }): void {
    this.inner.setConfig(config);
  }
  health(): Promise<{ status: string; version: string }> {
    return this.inner.health();
  }
  listSources(): Promise<DataSourceInfo[]> {
    return this.inner.listSources();
  }
  listDiscoveryProviders(): Promise<DiscoveryProviderInfo[]> {
    return this.inner.listDiscoveryProviders();
  }
  discoverSources(req: DiscoverSourcesRequest): Promise<DiscoverSourcesResponse> {
    return this.inner.discoverSources(req);
  }
  verifySource(req: CreateSourceRequest): Promise<SourceVerificationResult> {
    return this.inner.verifySource(req);
  }
  addSource(req: CreateSourceRequest): Promise<DataSourceInfo> {
    return this.inner.addSource(req);
  }
  removeSource(sourceId: string): Promise<{ removed: string }> {
    return this.inner.removeSource(sourceId);
  }
  browseSource(sourceId: string, prefix?: string, limit?: number): Promise<BrowseEntry[]> {
    return this.inner.browseSource(sourceId, prefix, limit);
  }
  openAudio(
    sourceId: string,
    uri: string,
    options?: { startSec?: number; maxDurationSec?: number },
  ): Promise<AudioFileInfo> {
    return this.inner.openAudio(sourceId, uri, options);
  }
  openAudioUrl(
    url: string,
    options?: { startSec?: number; maxDurationSec?: number },
  ): Promise<AudioFileInfo> {
    return this.inner.openAudioUrl(url, options);
  }
  uploadAudio(file: File): Promise<AudioFileInfo> {
    return this.inner.uploadAudio(file);
  }

  // ---- Combined-aware DSP & data methods ----

  async getSpectrogram(
    fileId: string,
    params: SpectrogramParams,
    range?: { startSec?: number; endSec?: number; minFreqHz?: number; maxFreqHz?: number },
    sparseOpts?: {
      targetBins?: number;
      onProgress?: (partial: SpectrogramMatrix) => void;
      signal?: AbortSignal;
    },
  ): Promise<SpectrogramMatrix> {
    const rec = this.combinedMap.get(fileId);
    if (!rec) {
      return this.inner.getSpectrogram(fileId, params, range);
    }

    const activeDur = this.getActiveWindowDuration(rec);
    const relStart = Math.max(0, range?.startSec ?? 0);
    const relEnd = Math.max(relStart + 0.01, Math.min(activeDur, range?.endSec ?? activeDur));
    const spanSec = relEnd - relStart;
    const minFreqHz = range?.minFreqHz ?? 0;
    const maxFreqHz = range?.maxFreqHz ?? rec.sampleRate / 2;

    const overlaps = this.resolveOverlappingSegments(rec, relStart, relEnd);
    if (overlaps.length === 0) {
      throw new Error('Requested spectrogram range falls outside combined recording bounds.');
    }

    const mapSegmentsForChannel = (virtualCh: number) =>
      rec.hasVirtualChannels
        ? rec.segments.map((seg) => {
            const target = this.resolveSegmentTarget(rec, seg, virtualCh);
            return {
              ...seg,
              sourceId: target.sourceId,
              uri: target.uri,
              name: target.name,
              sizeBytes: target.sizeBytes,
            };
          })
        : rec.segments;

    if (
      shouldUseSparseSpectrogram(
        spanSec,
        rec.sampleRate,
        rec.hasVirtualChannels ? 1 : rec.numChannels,
        params.fftSize,
        overlaps.length,
      )
    ) {
      const winOff = rec.windowStartSec;
      const sparseParams = rec.hasVirtualChannels ? { ...params, channel: 0 } : params;
      const mat = await fetchSparseSpectrogram(
        this.inner,
        fileId,
        mapSegmentsForChannel(params.channel),
        sparseParams,
        rec.sampleRate,
        {
          startSec: winOff + relStart,
          endSec: winOff + relEnd,
          minFreqHz,
          maxFreqHz,
        },
        {
          targetSamples: sparseOpts?.targetBins ?? (spanSec > 43200 ? 128 : 96),
          signal: sparseOpts?.signal,
          onProgress: sparseOpts?.onProgress
            ? (partial) =>
                sparseOpts.onProgress?.({
                  ...partial,
                  channel: params.channel,
                  startSec: Math.max(0, partial.startSec - winOff),
                  endSec: Math.max(0.01, partial.endSec - winOff),
                })
            : undefined,
          onSegmentProbed: (segIdx, exactDur, opened) => {
            const seg = rec.segments[segIdx];
            if (!seg) return;
            if (!seg.probed || Math.abs(exactDur - seg.durationSec) > 0.5) {
              seg.probed = true;
              seg.durationSec = exactDur;
              seg.sampleRate = opened.sampleRate;
              if (!rec.hasVirtualChannels) {
                seg.numChannels = opened.numChannels;
              }
              if (opened.startDateTimeIso) {
                seg.startDateTimeIso = opened.startDateTimeIso;
                if (segIdx === 0) rec.startDateTimeIso = opened.startDateTimeIso;
              }
              recomputeTimelines(rec);
              this.onDurationUpdatedCallback?.(this.toAudioFileInfo(rec));
            }
          },
        },
      );
      return {
        ...mat,
        channel: params.channel,
        startSec: relStart,
        endSec: relEnd,
      };
    }

    const matrices: SpectrogramMatrix[] = [];
    for (const ov of overlaps) {
      const { slice, innerChannel } = await this.ensureSegmentSlice(
        rec,
        ov.seg.index,
        ov.segLocalStart,
        ov.segLocalEnd,
        params.channel,
      );
      const hStart = Math.max(0, ov.segLocalStart - slice.sliceStartSec);
      const hEnd = Math.min(slice.fileInfo.durationSec, ov.segLocalEnd - slice.sliceStartSec);
      if (hEnd <= hStart + 1e-4) continue;

      const sliceInfo: AudioFileInfo = {
        ...slice.fileInfo,
        durationSec: slice.fileInfo.durationSec,
      };
      const targetBins = Math.max(
        16,
        Math.round(((hEnd - hStart) / Math.max(1e-6, spanSec)) * MAX_WEBGL_TIME_BINS),
      );
      const partMat = await fetchSpectrogramAdaptive(
        this.inner,
        sliceInfo,
        { ...params, channel: innerChannel },
        { startSec: hStart, endSec: hEnd, minFreqHz, maxFreqHz },
        targetBins,
      );
      matrices.push({ ...partMat, channel: params.channel });
    }

    if (matrices.length === 0) {
      throw new Error('No spectrogram data returned across combined segments.');
    }
    if (matrices.length === 1) {
      const single = matrices[0];
      return {
        ...single,
        fileId,
        startSec: relStart,
        endSec: relEnd,
      };
    }

    const freqBins = matrices[0].numFreqBins;
    const totalBins = matrices.reduce((acc, m) => acc + m.numTimeBins, 0);
    const stitched = new Float32Array(totalBins * freqBins);
    let minValue = Infinity;
    let maxValue = -Infinity;
    let tCursor = 0;

    for (const m of matrices) {
      if (m.numFreqBins === freqBins) {
        const count = Math.min(m.data.length, m.numTimeBins * freqBins);
        stitched.set(m.data.subarray(0, count), tCursor * freqBins);
        tCursor += m.numTimeBins;
      } else {
        // Resample frequency axis if edge segment differs cleanly
        for (let t = 0; t < m.numTimeBins; t++) {
          for (let f = 0; f < freqBins; f++) {
            const srcF = Math.min(
              m.numFreqBins - 1,
              Math.round((f / Math.max(1, freqBins - 1)) * (m.numFreqBins - 1)),
            );
            stitched[(tCursor + t) * freqBins + f] = m.data[t * m.numFreqBins + srcF];
          }
        }
        tCursor += m.numTimeBins;
      }
      if (m.minValue < minValue) minValue = m.minValue;
      if (m.maxValue > maxValue) maxValue = m.maxValue;
    }

    const combinedMat: SpectrogramMatrix = {
      fileId,
      channel: params.channel,
      numTimeBins: tCursor,
      numFreqBins: freqBins,
      timeStepSec: spanSec / Math.max(1, tCursor),
      freqStepHz: matrices[0].freqStepHz,
      startSec: relStart,
      endSec: relEnd,
      minFreqHz: matrices[0].minFreqHz,
      maxFreqHz: matrices[0].maxFreqHz,
      minValue: Number.isFinite(minValue) ? minValue : matrices[0].minValue,
      maxValue: Number.isFinite(maxValue) ? maxValue : matrices[0].maxValue,
      dspMode: params.dspMode,
      data: stitched,
    };

    return downsampleSpectrogramTime(combinedMat, MAX_WEBGL_TIME_BINS);
  }

  async getWaveform(
    fileId: string,
    channel: number,
    numBins = 2000,
    startSec?: number,
    endSec?: number,
  ): Promise<WaveformOverview> {
    const rec = this.combinedMap.get(fileId);
    if (!rec) {
      return this.inner.getWaveform(fileId, channel, numBins, startSec, endSec);
    }

    const activeDur = this.getActiveWindowDuration(rec);
    const relStart = Math.max(0, startSec ?? 0);
    const relEnd = Math.max(relStart + 0.01, Math.min(activeDur, endSec ?? activeDur));
    const span = relEnd - relStart;
    const overlaps = this.resolveOverlappingSegments(rec, relStart, relEnd);

    if (
      overlaps.length > 4 ||
      shouldUseSparseSpectrogram(
        span,
        rec.sampleRate,
        rec.hasVirtualChannels ? 1 : rec.numChannels,
        512,
        overlaps.length,
      )
    ) {
      const winOff = rec.windowStartSec;
      const mappedSegments = rec.hasVirtualChannels
        ? rec.segments.map((seg) => {
            const target = this.resolveSegmentTarget(rec, seg, channel);
            return {
              ...seg,
              sourceId: target.sourceId,
              uri: target.uri,
              name: target.name,
              sizeBytes: target.sizeBytes,
            };
          })
        : rec.segments;
      const wf = await fetchSparseWaveform(
        this.inner,
        fileId,
        mappedSegments,
        rec.hasVirtualChannels ? 0 : channel,
        numBins,
        winOff + relStart,
        winOff + relEnd,
        32,
      );
      return {
        ...wf,
        channel,
        startSec: relStart,
        endSec: relEnd,
      };
    }

    const minValues: number[] = [];
    const maxValues: number[] = [];

    for (const ov of overlaps) {
      const { slice, innerChannel } = await this.ensureSegmentSlice(
        rec,
        ov.seg.index,
        ov.segLocalStart,
        ov.segLocalEnd,
        channel,
      );
      const hStart = Math.max(0, ov.segLocalStart - slice.sliceStartSec);
      const hEnd = Math.min(slice.fileInfo.durationSec, ov.segLocalEnd - slice.sliceStartSec);
      if (hEnd <= hStart + 1e-4) continue;
      const partBins = Math.max(8, Math.round(((hEnd - hStart) / Math.max(1e-6, span)) * numBins));
      const wf = await this.inner.getWaveform(
        slice.fileInfo.fileId,
        innerChannel,
        partBins,
        hStart,
        hEnd,
      );
      minValues.push(...wf.minValues);
      maxValues.push(...wf.maxValues);
    }

    return {
      fileId,
      channel,
      numBins: minValues.length,
      startSec: relStart,
      endSec: relEnd,
      minValues,
      maxValues,
    };
  }

  async measureSelection(
    fileId: string,
    req: MeasureSelectionRequest,
  ): Promise<SelectionMeasurements> {
    const rec = this.combinedMap.get(fileId);
    if (!rec) {
      return this.inner.measureSelection(fileId, req);
    }

    const overlaps = this.resolveOverlappingSegments(rec, req.startSec, req.endSec);
    if (overlaps.length === 0) {
      throw new Error('Selection falls outside loaded combined recording bounds.');
    }

    const selSpan = Math.max(0.01, req.endSec - req.startSec);
    if (selSpan > getSafeMaxWindowSec(rec.sampleRate, rec.numChannels) || overlaps.length > 6) {
      const mat = await this.getSpectrogram(
        fileId,
        {
          channel: req.channel,
          fftSize: req.fftSize ?? 512,
          hopSize: req.fftSize ?? 512,
          windowType: 'hann',
          dspMode: 'modern_stft',
          popFilter: false,
        },
        {
          startSec: req.startSec,
          endSec: req.endSec,
          minFreqHz: req.lowFreqHz,
          maxFreqHz: req.highFreqHz,
        },
        { targetBins: 24 },
      );

      let peakDb = -Infinity;
      let peakFreqHz = (req.lowFreqHz + req.highFreqHz) * 0.5;
      let timeOfPeakSec = req.startSec + selSpan * 0.5;
      const freqTotals = new Float64Array(mat.numFreqBins);
      const dbValues: number[] = [];
      let linearSum = 0;
      let cellCount = 0;

      for (let t = 0; t < mat.numTimeBins; t++) {
        for (let f = 0; f < mat.numFreqBins; f++) {
          const valDb = mat.data[t * mat.numFreqBins + f];
          if (!Number.isFinite(valDb)) continue;
          const lin = Math.pow(10, valDb / 10);
          freqTotals[f] += lin;
          linearSum += lin;
          cellCount++;
          dbValues.push(valDb);
          if (valDb > peakDb) {
            peakDb = valDb;
            peakFreqHz = mat.minFreqHz + f * mat.freqStepHz;
            timeOfPeakSec = mat.startSec + (t + 0.5) * mat.timeStepSec;
          }
        }
      }

      dbValues.sort((a, b) => a - b);
      const noiseFloorDb =
        dbValues.length > 0 ? dbValues[Math.floor(dbValues.length * 0.35)] : -80;
      const rmsDb = cellCount > 0 && linearSum > 0 ? 10 * Math.log10(linearSum / cellCount) : noiseFloorDb;
      if (!Number.isFinite(peakDb)) peakDb = rmsDb;

      let weightedFreqSum = 0;
      let totalPower = 0;
      for (let f = 0; f < mat.numFreqBins; f++) {
        const hz = mat.minFreqHz + f * mat.freqStepHz;
        weightedFreqSum += hz * freqTotals[f];
        totalPower += freqTotals[f];
      }
      const centroidFreqHz = totalPower > 0 ? weightedFreqSum / totalPower : peakFreqHz;
      const findQuantileFreq = (q: number): number => {
        if (totalPower <= 0) return centroidFreqHz;
        let acc = 0;
        const target = totalPower * q;
        for (let f = 0; f < mat.numFreqBins; f++) {
          acc += freqTotals[f];
          if (acc >= target) return mat.minFreqHz + f * mat.freqStepHz;
        }
        return mat.maxFreqHz;
      };
      const q5FreqHz = findQuantileFreq(0.05);
      const q50FreqHz = findQuantileFreq(0.5);
      const q95FreqHz = findQuantileFreq(0.95);

      return {
        durationSec: selSpan,
        lowFreqHz: req.lowFreqHz,
        highFreqHz: req.highFreqHz,
        bandwidthHz: Math.max(0, req.highFreqHz - req.lowFreqHz),
        peakFreqHz,
        centroidFreqHz,
        q5FreqHz,
        q50FreqHz,
        q95FreqHz,
        bw90Hz: Math.max(0, q95FreqHz - q5FreqHz),
        timeOfPeakSec,
        rmsDb,
        peakDb,
        noiseFloorDb,
        snrDb: peakDb - noiseFloorDb,
      };
    }

    const parts: Array<{ m: SelectionMeasurements; winBaseSec: number }> = [];
    for (const ov of overlaps) {
      const { slice, innerChannel } = await this.ensureSegmentSlice(
        rec,
        ov.seg.index,
        ov.segLocalStart,
        ov.segLocalEnd,
        req.channel,
      );
      const hStart = Math.max(0, ov.segLocalStart - slice.sliceStartSec);
      const hEnd = Math.min(slice.fileInfo.durationSec, ov.segLocalEnd - slice.sliceStartSec);
      if (hEnd <= hStart + 1e-4) continue;
      const m = await this.inner.measureSelection(slice.fileInfo.fileId, {
        ...req,
        channel: innerChannel,
        startSec: hStart,
        endSec: hEnd,
      });
      parts.push({
        m,
        winBaseSec: ov.seg.timelineStartSec + slice.sliceStartSec - rec.windowStartSec,
      });
    }

    if (parts.length === 0) {
      throw new Error('Unable to measure combined selection.');
    }
    if (parts.length === 1) {
      const only = parts[0];
      return {
        ...only.m,
        timeOfPeakSec: only.winBaseSec + only.m.timeOfPeakSec,
      };
    }

    const totalDur = parts.reduce((acc, p) => acc + Math.max(0.001, p.m.durationSec), 0);
    const loudest = parts.reduce((best, p) => (p.m.peakDb > best.m.peakDb ? p : best), parts[0]);
    const weightedAvg = (fn: (m: SelectionMeasurements) => number) =>
      parts.reduce((acc, p) => acc + fn(p.m) * Math.max(0.001, p.m.durationSec), 0) / totalDur;

    const rmsLinearPower =
      parts.reduce(
        (acc, p) => acc + Math.pow(10, p.m.rmsDb / 10) * Math.max(0.001, p.m.durationSec),
        0,
      ) / totalDur;
    const rmsDb = rmsLinearPower > 0 ? 10 * Math.log10(rmsLinearPower) : loudest.m.rmsDb;
    const peakDb = loudest.m.peakDb;
    const noiseFloorDb = weightedAvg((m) => m.noiseFloorDb);
    const q5 = weightedAvg((m) => m.q5FreqHz);
    const q50 = weightedAvg((m) => m.q50FreqHz);
    const q95 = weightedAvg((m) => m.q95FreqHz);

    return {
      durationSec: totalDur,
      lowFreqHz: req.lowFreqHz,
      highFreqHz: req.highFreqHz,
      bandwidthHz: Math.max(0, req.highFreqHz - req.lowFreqHz),
      peakFreqHz: loudest.m.peakFreqHz,
      centroidFreqHz: weightedAvg((m) => m.centroidFreqHz),
      q5FreqHz: q5,
      q50FreqHz: q50,
      q95FreqHz: q95,
      bw90Hz: Math.max(0, q95 - q5),
      timeOfPeakSec: loudest.winBaseSec + loudest.m.timeOfPeakSec,
      rmsDb,
      peakDb,
      noiseFloorDb,
      snrDb: peakDb - noiseFloorDb,
    };
  }

  async detectSounds(fileId: string, req: DetectSoundsRequest): Promise<DetectSoundsResponse> {
    const rec = this.combinedMap.get(fileId);
    if (!rec) {
      return this.inner.detectSounds(fileId, req);
    }

    const activeDur = this.getActiveWindowDuration(rec);
    const scanStart = Math.max(0, req.startSec ?? 0);
    const scanEnd = Math.min(activeDur, req.endSec ?? activeDur);
    const overlaps = this.resolveOverlappingSegments(rec, scanStart, scanEnd);

    const safeMax = getSafeMaxWindowSec(rec.sampleRate, rec.numChannels);
    if (scanEnd - scanStart > safeMax || overlaps.length > 16) {
      throw new Error(
        `Exhaustive Detect Sounds spans too much audio (${overlaps.length} segments). Zoom or select a region within ${Math.round(safeMax / 60)} min first.`,
      );
    }

    const allDetections: AnnotationRecord[] = [];
    const savedClips: string[] = [];
    let noiseFloorWeighted = 0;
    let totalWeight = 0;

    for (const ov of overlaps) {
      const { slice, innerChannel } = await this.ensureSegmentSlice(
        rec,
        ov.seg.index,
        ov.segLocalStart,
        ov.segLocalEnd,
        req.channel ?? 0,
      );
      const hStart = Math.max(0, ov.segLocalStart - slice.sliceStartSec);
      const hEnd = Math.min(slice.fileInfo.durationSec, ov.segLocalEnd - slice.sliceStartSec);
      if (hEnd <= hStart + 0.02) continue;

      const resp = await this.inner.detectSounds(slice.fileInfo.fileId, {
        ...req,
        channel: innerChannel,
        startSec: hStart,
        endSec: hEnd,
      });

      const winBaseSec = ov.seg.timelineStartSec + slice.sliceStartSec - rec.windowStartSec;
      const weight = hEnd - hStart;
      noiseFloorWeighted += resp.noiseFloorDb * weight;
      totalWeight += weight;
      savedClips.push(...resp.savedClips);

      for (const det of resp.detections) {
        allDetections.push({
          ...det,
          id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          soundfile: rec.title,
          startTimeSec: Math.max(0, winBaseSec + det.startTimeSec),
          endTimeSec: Math.min(activeDur, winBaseSec + det.endTimeSec),
          extraFields: {
            ...det.extraFields,
            SegmentFile: ov.seg.name,
          },
        });
      }
    }

    allDetections.sort((a, b) => a.startTimeSec - b.startTimeSec);
    // Merge events across segment boundaries if their gap is <= maxSilenceGapSec
    const merged: AnnotationRecord[] = [];
    const maxGap = Math.max(0, req.maxSilenceGapSec ?? 0.25);
    for (const det of allDetections) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.channel === det.channel &&
        det.startTimeSec - prev.endTimeSec <= maxGap + 0.02 &&
        prev.extraFields?.SegmentFile !== det.extraFields?.SegmentFile
      ) {
        prev.endTimeSec = Math.max(prev.endTimeSec, det.endTimeSec);
        prev.lowFreqHz = Math.min(prev.lowFreqHz, det.lowFreqHz);
        prev.highFreqHz = Math.max(prev.highFreqHz, det.highFreqHz);
      } else {
        merged.push(det);
      }
    }

    return {
      detections: merged,
      noiseFloorDb: totalWeight > 0 ? noiseFloorWeighted / totalWeight : -80,
      savedClips,
    };
  }

  async analyzeWithAi(req: AiAnalyzeRequest): Promise<AiAnalyzeResponse> {
    const rec = this.combinedMap.get(req.fileId);
    if (!rec) {
      return this.inner.analyzeWithAi(req);
    }

    const activeDur = this.getActiveWindowDuration(rec);
    const nyquist = rec.sampleRate / 2;
    const focus = req.selection ?? {
      startSec: req.viewRange?.startSec ?? 0,
      endSec: req.viewRange?.endSec ?? activeDur,
      lowFreqHz: req.viewRange?.minFreqHz ?? 0,
      highFreqHz: req.viewRange?.maxFreqHz ?? nyquist,
    };

    const measurements = await this.measureSelection(rec.combinedId, {
      channel: req.channel,
      startSec: focus.startSec,
      endSec: focus.endSec,
      lowFreqHz: focus.lowFreqHz,
      highFreqHz: focus.highFreqHz,
      fftSize: req.specParams?.fftSize,
      hopSize: req.specParams?.hopSize,
    });

    const summaryAnswer = [
      `### Offline Acoustic Analysis (Combined Recording · ${rec.segments.length} segments)`,
      `- **Recording**: \`${rec.title}\` (${rec.sampleRate.toLocaleString()} Hz, ${activeDur.toFixed(2)}s window / ${rec.totalDurationSec.toFixed(1)}s total)`,
      `- **Peak Frequency**: **${measurements.peakFreqHz.toFixed(1)} Hz** (Centroid: ${measurements.centroidFreqHz.toFixed(1)} Hz)`,
      `- **90% Energy Band**: ${measurements.q5FreqHz.toFixed(1)} – ${measurements.q95FreqHz.toFixed(1)} Hz (BW90: ${measurements.bw90Hz.toFixed(1)} Hz)`,
      `- **Duration**: ${measurements.durationSec.toFixed(3)} s (Peak at ${measurements.timeOfPeakSec.toFixed(3)} s)`,
      `- **Amplitude / SNR**: RMS ${measurements.rmsDb.toFixed(1)} dBFS, Peak ${measurements.peakDb.toFixed(1)} dBFS, Est. SNR **${measurements.snrDb.toFixed(1)} dB**`,
      '',
      '> *Add a Gemini API key (in the AI Explorer settings or `GEMINI_API_KEY` env var) to enable multimodal spectrogram interpretation, taxonomic hypotheses, and interactive Q&A.*',
    ].join('\n');

    return {
      answer: summaryAnswer,
      modelUsed: 'offline-dsp',
      measurements,
      suggestedDetectParams: {
        minFreqHz: Math.max(0, Math.round(measurements.q5FreqHz * 0.85)),
        maxFreqHz: Math.min(nyquist, Math.round(measurements.q95FreqHz * 1.15)),
        triggerThresholdDb: Math.max(6, Math.min(24, Math.round(measurements.snrDb * 0.55))),
        minSoundDurSec: Math.max(0.02, Math.min(1, Number((measurements.durationSec * 0.4).toFixed(2)))),
        maxSilenceGapSec: 0.25,
        comment: 'Detected',
      },
      suggestedLabels: ['Vocalization', 'Call', 'Ambient'],
    };
  }

  getSpectrogramBitmapUrl(
    fileId: string,
    params: SpectrogramParams,
    display: DisplaySettings,
    range?: { startSec?: number; endSec?: number; minFreqHz?: number; maxFreqHz?: number },
  ): string {
    if (this.combinedMap.has(fileId)) {
      return '';
    }
    return this.inner.getSpectrogramBitmapUrl(fileId, params, display, range);
  }

  getAudioStreamUrl(fileId: string): string {
    return this.inner.getAudioStreamUrl(fileId);
  }

  async fetchCombinedAudioRange(
    fileId: string,
    startSec: number,
    endSec: number,
    channel?: number,
  ): Promise<ArrayBuffer> {
    const rec = this.combinedMap.get(fileId);
    if (!rec) {
      return this.inner.fetchAudioArrayBuffer(fileId);
    }

    const overlaps = this.resolveOverlappingSegments(rec, startSec, endSec);
    if (overlaps.length === 0) {
      throw new Error('Requested playback range falls outside combined recording.');
    }

    const sampleRate = rec.sampleRate;
    const numCh = Math.max(1, rec.numChannels);
    const singleChannel =
      channel !== undefined && Number.isFinite(channel)
        ? Math.max(0, Math.min(numCh - 1, Math.floor(channel)))
        : undefined;
    const outChCount = singleChannel !== undefined ? 1 : numCh;
    const decodedChunks: Float32Array[][] = [];

    const decodeTargetSlice = async (
      target: { sourceId: string; uri: string; cacheKey: string },
      segLocalStart: number,
      segLocalEnd: number,
    ): Promise<{ channels: Float32Array[]; sampleRate: number }> => {
      const segSpan = segLocalEnd - segLocalStart;
      let targetFileId: string;
      let sliceOffset = 0;

      const existing = rec.openSlices.get(target.cacheKey);
      if (
        existing &&
        existing.sliceStartSec <= segLocalStart + 0.005 &&
        existing.sliceEndSec >= segLocalEnd - 0.005 &&
        existing.fileInfo.durationSec <= Math.max(600, segSpan + 120)
      ) {
        targetFileId = existing.fileInfo.fileId;
        sliceOffset = existing.sliceStartSec;
      } else {
        const openedPlay = await this.inner.openAudio(target.sourceId, target.uri, {
          startSec: segLocalStart,
          maxDurationSec: Math.max(5, Math.ceil(segSpan + 1)),
        });
        targetFileId = openedPlay.fileId;
        sliceOffset = openedPlay.windowStartSec ?? 0;
      }

      const rawBuf = await this.inner.fetchAudioArrayBuffer(targetFileId);
      const parsed = tryParseWavPcmChannels(rawBuf);
      let segChannels: Float32Array[];
      let segRate = sampleRate;

      if (parsed) {
        segChannels = parsed.channels;
        segRate = parsed.sampleRate;
      } else {
        const AudioCtx = window.AudioContext;
        const tmpCtx = new AudioCtx();
        try {
          const decoded = await tmpCtx.decodeAudioData(rawBuf.slice(0));
          segRate = decoded.sampleRate;
          segChannels = Array.from({ length: decoded.numberOfChannels }, (_, c) =>
            decoded.getChannelData(c).slice(),
          );
        } finally {
          await tmpCtx.close().catch(() => undefined);
        }
      }

      const hStart = Math.max(0, segLocalStart - sliceOffset);
      const hEnd = Math.max(hStart + 0.01, segLocalEnd - sliceOffset);
      const i0 = Math.max(0, Math.floor(hStart * segRate));
      const i1 = Math.min(segChannels[0]?.length ?? 0, Math.ceil(hEnd * segRate));
      return {
        sampleRate: segRate,
        channels: segChannels.map((src) => {
          const sub = src.subarray(i0, Math.max(i0, i1));
          return segRate === sampleRate ? sub.slice() : resampleLinear(sub, segRate, sampleRate);
        }),
      };
    };

    for (const ov of overlaps) {
      if (rec.hasVirtualChannels && ov.seg.channelFiles && ov.seg.channelFiles.length > 1) {
        if (singleChannel !== undefined) {
          const target = this.resolveSegmentTarget(rec, ov.seg, singleChannel);
          const dec = await decodeTargetSlice(target, ov.segLocalStart, ov.segLocalEnd);
          const srcCh = dec.channels[Math.min(target.innerChannel, dec.channels.length - 1)] ?? new Float32Array(0);
          decodedChunks.push([srcCh]);
        } else {
          const chTracks = await Promise.all(
            Array.from({ length: numCh }, (_, c) => {
              const target = this.resolveSegmentTarget(rec, ov.seg, c);
              return decodeTargetSlice(target, ov.segLocalStart, ov.segLocalEnd);
            }),
          );
          const maxLen = chTracks.reduce((m, t) => Math.max(m, t.channels[0]?.length ?? 0), 0);
          const sliced: Float32Array[] = chTracks.map((t) => {
            const ch0 = t.channels[0] ?? new Float32Array(0);
            if (ch0.length === maxLen) return ch0;
            const padded = new Float32Array(maxLen);
            padded.set(ch0);
            return padded;
          });
          decodedChunks.push(sliced);
        }
      } else {
        const target = this.resolveSegmentTarget(rec, ov.seg, singleChannel ?? 0);
        const dec = await decodeTargetSlice(target, ov.segLocalStart, ov.segLocalEnd);
        if (singleChannel !== undefined) {
          const srcCh = dec.channels[Math.min(singleChannel, dec.channels.length - 1)] ?? new Float32Array(0);
          decodedChunks.push([srcCh]);
        } else {
          const sliced: Float32Array[] = [];
          for (let c = 0; c < numCh; c++) {
            sliced.push(dec.channels[Math.min(c, dec.channels.length - 1)] ?? new Float32Array(0));
          }
          decodedChunks.push(sliced);
        }
      }
    }

    const totalFrames = decodedChunks.reduce((acc, chs) => acc + (chs[0]?.length ?? 0), 0);
    const outChannels = Array.from({ length: outChCount }, () => new Float32Array(Math.max(1, totalFrames)));
    let cursor = 0;
    for (const chs of decodedChunks) {
      const len = chs[0]?.length ?? 0;
      for (let c = 0; c < outChCount; c++) {
        outChannels[c].set(chs[c], cursor);
      }
      cursor += len;
    }

    return encodeWavPcm16(outChannels, sampleRate);
  }

  async fetchAudioArrayBuffer(fileId: string): Promise<ArrayBuffer> {
    const rec = this.combinedMap.get(fileId);
    if (!rec) {
      return this.inner.fetchAudioArrayBuffer(fileId);
    }
    const activeDur = this.getActiveWindowDuration(rec);
    return this.fetchCombinedAudioRange(fileId, 0, Math.min(activeDur, 300));
  }

  async exportSpectrogramTsv(
    fileId: string,
    params: SpectrogramParams,
    range?: { startSec?: number; endSec?: number; minFreqHz?: number; maxFreqHz?: number },
  ): Promise<string> {
    const rec = this.combinedMap.get(fileId);
    if (!rec) {
      return this.inner.exportSpectrogramTsv(fileId, params, range);
    }
    const mat = await this.getSpectrogram(fileId, params, range);
    const header = [
      'time_sec',
      ...Array.from({ length: mat.numFreqBins }, (_, fi) =>
        (mat.minFreqHz + fi * mat.freqStepHz).toFixed(1),
      ),
    ].join('\t');
    const rows: string[] = [header];
    for (let ti = 0; ti < mat.numTimeBins; ti++) {
      const t = mat.startSec + ti * mat.timeStepSec;
      const vals = [t.toFixed(4)];
      for (let fi = 0; fi < mat.numFreqBins; fi++) {
        vals.push(mat.data[ti * mat.numFreqBins + fi].toFixed(2));
      }
      rows.push(vals.join('\t'));
    }
    return rows.join('\n');
  }

  async clipAndSave(req: ClipSaveRequest): Promise<ClipSaveResponse> {
    const rec = this.combinedMap.get(req.fileId);
    if (!rec) {
      return this.inner.clipAndSave(req);
    }

    const overlaps = this.resolveOverlappingSegments(rec, req.startSec, req.endSec);
    if (overlaps.length === 1 && !rec.hasVirtualChannels) {
      const ov = overlaps[0];
      const { slice } = await this.ensureSegmentSlice(rec, ov.seg.index, ov.segLocalStart, ov.segLocalEnd, 0);
      const hStart = Math.max(0, ov.segLocalStart - slice.sliceStartSec);
      const hEnd = Math.min(slice.fileInfo.durationSec, ov.segLocalEnd - slice.sliceStartSec);
      return this.inner.clipAndSave({
        ...req,
        fileId: slice.fileInfo.fileId,
        startSec: hStart,
        endSec: hEnd,
      });
    }

    // Cross-boundary combined clip: synthesize stitched WAV & trigger download
    const wavBuf = await this.fetchCombinedAudioRange(req.fileId, req.startSec, req.endSec);
    const safeName = `${rec.title.replace(/[^a-z0-9._-]+/gi, '_')}_${req.comment || 'clip'}.wav`;
    const blob = new Blob([wavBuf], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    a.click();
    URL.revokeObjectURL(url);
    return {
      savedUri: `download://${safeName}`,
      savedName: safeName,
    };
  }

  importAnnotationsText(content: string, format: AnnotationFormat): Promise<AnnotationDocument> {
    return this.inner.importAnnotationsText(content, format);
  }
  importAnnotationsFromSource(
    sourceId: string,
    uri: string,
    format?: AnnotationFormat,
  ): Promise<AnnotationDocument> {
    return this.inner.importAnnotationsFromSource(sourceId, uri, format);
  }
  exportAnnotationsText(
    annotations: AnnotationRecord[],
    format: AnnotationFormat,
    nonAnnotationLines?: string[],
  ): Promise<string> {
    return this.inner.exportAnnotationsText(annotations, format, nonAnnotationLines);
  }
  saveAnnotationsToSource(
    sourceId: string,
    uri: string,
    annotations: AnnotationRecord[],
    format: AnnotationFormat,
    nonAnnotationLines?: string[],
  ): Promise<{ savedUri: string; count: number }> {
    return this.inner.saveAnnotationsToSource(sourceId, uri, annotations, format, nonAnnotationLines);
  }
}
