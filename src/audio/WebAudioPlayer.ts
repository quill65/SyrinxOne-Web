import type { AudioEngineClient } from '@syrinxone/shared';

export interface PlaybackState {
  isPlaying: boolean;
  fileId: string | null;
  currentTimeSec: number;
  startSec: number;
  endSec: number;
  playbackRate: number;
  loop: boolean;
}

type Listener = (state: PlaybackState) => void;

function readAscii(view: DataView, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && offset + i < view.byteLength; i++) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}

function resampleChannelLinear(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
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

function buildAudioBufferFromChannels(
  ctx: AudioContext,
  channels: Float32Array[],
  sampleRate: number,
): AudioBuffer {
  const safeChannels = channels.length > 0 ? channels : [new Float32Array(1)];
  // Browsers guarantee createBuffer support in [8000, 192000] Hz (e.g. MBARI 256kHz or 1kHz hydrophones).
  let targetRate = sampleRate;
  if (sampleRate < 8000) {
    targetRate = 48000;
  } else if (sampleRate > 192000) {
    targetRate = 96000;
  }

  const resampled =
    targetRate === sampleRate
      ? safeChannels
      : safeChannels.map((ch) => resampleChannelLinear(ch, sampleRate, targetRate));

  const length = Math.max(1, resampled[0].length);
  const maxCh = Math.min(resampled.length, 32);
  const buf = ctx.createBuffer(maxCh, length, targetRate);
  for (let c = 0; c < maxCh; c++) {
    buf.getChannelData(c).set(resampled[c]);
  }
  return buf;
}

function tryDecodeWavFallback(ctx: AudioContext, arrayBuf: ArrayBuffer): AudioBuffer | null {
  if (arrayBuf.byteLength < 44) return null;
  const view = new DataView(arrayBuf);
  const riffId = readAscii(view, 0, 4);
  const waveId = readAscii(view, 8, 4);
  if ((riffId !== 'RIFF' && riffId !== 'RF64') || waveId !== 'WAVE') {
    return null;
  }

  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
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

  if (
    dataOffset < 0 ||
    numChannels <= 0 ||
    sampleRate <= 0 ||
    (audioFormat !== 1 && audioFormat !== 3)
  ) {
    return null;
  }

  const bytesPerSample = Math.floor(bitsPerSample / 8);
  if (bytesPerSample <= 0) return null;
  const frameBytes = bytesPerSample * numChannels;
  const numFrames = Math.floor(dataSize / frameBytes);
  if (numFrames <= 0) return null;

  const channels: Float32Array[] = Array.from(
    { length: numChannels },
    () => new Float32Array(numFrames),
  );

  for (let i = 0; i < numFrames; i++) {
    const frameBase = dataOffset + i * frameBytes;
    for (let c = 0; c < numChannels; c++) {
      const p = frameBase + c * bytesPerSample;
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
        const b0 = view.getUint8(p);
        const b1 = view.getUint8(p + 1);
        const b2 = view.getUint8(p + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
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

  return buildAudioBufferFromChannels(ctx, channels, sampleRate);
}

function parseIeeeExtended80(view: DataView, offset: number): number {
  const expon = view.getUint16(offset, false);
  const hiMant = view.getUint32(offset + 2, false);
  const loMant = view.getUint32(offset + 6, false);
  if (expon === 0 && hiMant === 0 && loMant === 0) return 0;
  const exp = (expon & 0x7fff) - 16383;
  const f = hiMant * Math.pow(2, exp - 31) + loMant * Math.pow(2, exp - 63);
  return expon & 0x8000 ? -f : f;
}

function tryDecodeAiffFallback(ctx: AudioContext, arrayBuf: ArrayBuffer): AudioBuffer | null {
  if (arrayBuf.byteLength < 54) return null;
  const view = new DataView(arrayBuf);
  const formId = readAscii(view, 0, 4);
  const aiffId = readAscii(view, 8, 4);
  if (formId !== 'FORM' || (aiffId !== 'AIFF' && aiffId !== 'AIFC')) return null;

  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let ssndOffset = -1;
  let ssndSize = 0;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, false);
    const chunkStart = offset + 8;

    if (chunkId === 'COMM' && chunkStart + 18 <= view.byteLength) {
      numChannels = view.getInt16(chunkStart, false);
      bitsPerSample = view.getInt16(chunkStart + 6, false);
      sampleRate = Math.round(parseIeeeExtended80(view, chunkStart + 8));
      if (aiffId === 'AIFC' && chunkSize >= 22) {
        const comp = readAscii(view, chunkStart + 18, 4);
        if (comp !== 'NONE' && comp !== 'sowt') return null;
      }
    } else if (chunkId === 'SSND' && chunkStart + 8 <= view.byteLength) {
      const innerOffset = view.getUint32(chunkStart, false);
      ssndOffset = chunkStart + 8 + innerOffset;
      ssndSize = Math.max(0, Math.min(chunkSize - 8 - innerOffset, view.byteLength - ssndOffset));
      break;
    }

    const padded = chunkSize + (chunkSize & 1);
    const next = chunkStart + padded;
    if (next <= offset) break;
    offset = next;
  }

  if (ssndOffset < 0 || numChannels <= 0 || sampleRate <= 0) return null;
  const bytesPerSample = Math.floor(bitsPerSample / 8);
  if (bytesPerSample <= 0) return null;
  const frameBytes = bytesPerSample * numChannels;
  const numFrames = Math.floor(ssndSize / frameBytes);
  if (numFrames <= 0) return null;

  const channels: Float32Array[] = Array.from(
    { length: numChannels },
    () => new Float32Array(numFrames),
  );

  for (let i = 0; i < numFrames; i++) {
    const frameBase = ssndOffset + i * frameBytes;
    for (let c = 0; c < numChannels; c++) {
      const p = frameBase + c * bytesPerSample;
      let sample = 0;
      if (bitsPerSample === 8) sample = view.getInt8(p) / 128;
      else if (bitsPerSample === 16) sample = view.getInt16(p, false) / 32768;
      else if (bitsPerSample === 24) {
        const b0 = view.getUint8(p);
        const b1 = view.getUint8(p + 1);
        const b2 = view.getUint8(p + 2);
        let v = (b0 << 16) | (b1 << 8) | b2;
        if (v & 0x800000) v |= ~0xffffff;
        sample = v / 8388608;
      } else if (bitsPerSample === 32) sample = view.getInt32(p, false) / 2147483648;
      else return null;
      channels[c][i] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
    }
  }

  return buildAudioBufferFromChannels(ctx, channels, sampleRate);
}

export class WebAudioPlayer {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private sourceNode: AudioBufferSourceNode | null = null;
  private auxNodes: AudioNode[] = [];
  private mediaEl: HTMLAudioElement | null = null;
  private mediaBlobUrl: string | null = null;
  private rafId: number | null = null;
  private startedAtCtxTime = 0;
  private playSeq = 0;
  private listeners = new Set<Listener>();

  private state: PlaybackState = {
    isPlaying: false,
    fileId: null,
    currentTimeSec: 0,
    startSec: 0,
    endSec: 0,
    playbackRate: 1.0,
    loop: false,
  };

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snap = { ...this.state };
    for (const fn of this.listeners) fn(snap);
  }

  public getState(): PlaybackState {
    return { ...this.state };
  }

  public setPlaybackRate(rate: number): void {
    const clamped = Math.max(0.1, Math.min(4.0, rate));
    this.state.playbackRate = clamped;
    if (this.sourceNode) {
      this.sourceNode.playbackRate.value = clamped;
    }
    if (this.mediaEl) {
      this.mediaEl.playbackRate = clamped;
    }
    this.emit();
  }

  public setLoop(loop: boolean): void {
    this.state.loop = loop;
    if (this.sourceNode) {
      this.sourceNode.loop = loop;
    }
    this.emit();
  }

  private async loadBuffer(
    engine: AudioEngineClient,
    fileId: string,
    rangeStartSec?: number,
    rangeEndSec?: number,
    channel?: number,
  ): Promise<{ buffer?: AudioBuffer; rawBytes?: ArrayBuffer; bufferStartOffsetSec: number }> {
    const isCombined = fileId.startsWith('combined::');
    const rStart = Math.max(0, rangeStartSec ?? 0);
    const rEnd = Math.max(rStart + 0.05, rangeEndSec ?? rStart + 60);
    const cleanCh =
      channel !== undefined && Number.isFinite(channel) ? Math.max(0, Math.floor(channel)) : undefined;
    const cacheKey = isCombined
      ? `${fileId}|ch${cleanCh ?? 'all'}|${rStart.toFixed(3)}|${rEnd.toFixed(3)}`
      : fileId;

    const cached = this.buffers.get(cacheKey);
    if (cached) {
      return { buffer: cached, bufferStartOffsetSec: isCombined ? rStart : 0 };
    }

    const ctx = this.ensureContext();
    const rangeEngine = engine as AudioEngineClient & {
      fetchCombinedAudioRange?: (fid: string, s: number, e: number, ch?: number) => Promise<ArrayBuffer>;
    };
    const arrayBuf =
      isCombined && typeof rangeEngine.fetchCombinedAudioRange === 'function'
        ? await rangeEngine.fetchCombinedAudioRange(fileId, rStart, rEnd, cleanCh)
        : await engine.fetchAudioArrayBuffer(fileId);

    if (arrayBuf.byteLength === 0) {
      throw new Error('Audio stream returned empty data.');
    }

    const bufferStartOffsetSec = isCombined ? rStart : 0;

    try {
      const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
      this.buffers.set(cacheKey, decoded);
      return { buffer: decoded, bufferStartOffsetSec };
    } catch {
      const wavBuf = tryDecodeWavFallback(ctx, arrayBuf);
      if (wavBuf) {
        this.buffers.set(cacheKey, wavBuf);
        return { buffer: wavBuf, bufferStartOffsetSec };
      }
      const aiffBuf = tryDecodeAiffFallback(ctx, arrayBuf);
      if (aiffBuf) {
        this.buffers.set(cacheKey, aiffBuf);
        return { buffer: aiffBuf, bufferStartOffsetSec };
      }

      // Check if server accidentally sent JSON or HTML error text instead of binary audio
      const head = readAscii(new DataView(arrayBuf), 0, Math.min(256, arrayBuf.byteLength)).trim();
      if (head.startsWith('{') || head.startsWith('<')) {
        throw new Error('Engine returned non-audio response for playback.');
      }

      return { rawBytes: arrayBuf, bufferStartOffsetSec };
    }
  }

  private async playViaMediaElement(
    rawBytes: ArrayBuffer,
    fileId: string,
    startSec?: number,
    endSec?: number,
  ): Promise<void> {
    const blobUrl = URL.createObjectURL(new Blob([rawBytes]));
    const audio = new Audio(blobUrl);
    audio.playbackRate = this.state.playbackRate;

    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Browser could not decode this audio format for playback.'));
      };
      const cleanup = () => {
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('error', onError);
      };
      audio.addEventListener('loadedmetadata', onLoaded);
      audio.addEventListener('error', onError);
    }).catch((err) => {
      URL.revokeObjectURL(blobUrl);
      throw err;
    });

    const totalDur = Number.isFinite(audio.duration) ? audio.duration : 0;
    const s = Math.max(0, totalDur > 0 ? Math.min(totalDur, startSec ?? 0) : (startSec ?? 0));
    const e = Math.max(
      s + 0.005,
      totalDur > 0 ? Math.min(totalDur, endSec ?? totalDur) : (endSec ?? s + 60),
    );

    audio.currentTime = s;
    this.mediaEl = audio;
    this.mediaBlobUrl = blobUrl;
    this.state = {
      ...this.state,
      isPlaying: true,
      fileId,
      startSec: s,
      endSec: e,
      currentTimeSec: s,
    };

    audio.onended = () => {
      if (this.mediaEl === audio) {
        if (this.state.loop) {
          audio.currentTime = s;
          void audio.play().catch(() => this.stop());
        } else {
          this.stop();
        }
      }
    };

    await audio.play();
    this.emit();

    const tick = () => {
      if (!this.state.isPlaying || this.mediaEl !== audio) return;
      const cur = audio.currentTime;
      if (cur >= this.state.endSec) {
        if (this.state.loop) {
          audio.currentTime = this.state.startSec;
        } else {
          this.stop();
          return;
        }
      }
      this.state.currentTimeSec = Math.min(this.state.endSec, cur);
      this.emit();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  public async play(
    engine: AudioEngineClient,
    fileId: string,
    startSec?: number,
    endSec?: number,
    channel?: number,
  ): Promise<void> {
    const seq = ++this.playSeq;
    this.stop(false);
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    const loaded = await this.loadBuffer(engine, fileId, startSec, endSec, channel);
    if (seq !== this.playSeq) return;

    const offsetSec = loaded.bufferStartOffsetSec;

    if (!loaded.buffer) {
      if (loaded.rawBytes) {
        await this.playViaMediaElement(
          loaded.rawBytes,
          fileId,
          startSec !== undefined ? Math.max(0, startSec - offsetSec) : undefined,
          endSec !== undefined ? Math.max(0.01, endSec - offsetSec) : undefined,
        );
        return;
      }
      throw new Error('Unable to decode audio data.');
    }

    const buffer = loaded.buffer;
    const relStart = Math.max(0, (startSec ?? offsetSec) - offsetSec);
    const relEnd = Math.max(
      relStart + 0.005,
      Math.min(buffer.duration, (endSec ?? offsetSec + buffer.duration) - offsetSec),
    );
    const s = Math.max(0, Math.min(buffer.duration, relStart));
    const e = Math.max(s + 0.005, Math.min(buffer.duration, relEnd));
    const duration = e - s;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = this.state.playbackRate;
    src.loop = this.state.loop;
    if (this.state.loop) {
      src.loopStart = s;
      src.loopEnd = e;
    }

    if (channel !== undefined && Number.isFinite(channel) && buffer.numberOfChannels > 1) {
      const ch = Math.max(0, Math.min(buffer.numberOfChannels - 1, Math.floor(channel)));
      const splitter = ctx.createChannelSplitter(buffer.numberOfChannels);
      const merger = ctx.createChannelMerger(2);
      src.connect(splitter);
      splitter.connect(merger, ch, 0);
      splitter.connect(merger, ch, 1);
      merger.connect(ctx.destination);
      this.auxNodes = [splitter, merger];
    } else {
      src.connect(ctx.destination);
      this.auxNodes = [];
    }

    this.sourceNode = src;
    this.startedAtCtxTime = ctx.currentTime;
    this.state = {
      ...this.state,
      isPlaying: true,
      fileId,
      startSec: offsetSec + s,
      endSec: offsetSec + e,
      currentTimeSec: offsetSec + s,
    };

    src.onended = () => {
      if (this.sourceNode === src && !this.state.loop) {
        this.stop();
      }
    };

    if (this.state.loop) {
      src.start(0, s);
    } else {
      src.start(0, s, duration);
    }

    this.emit();
    this.startTicker();
  }

  private startTicker(): void {
    const tick = () => {
      if (!this.state.isPlaying || !this.ctx) return;
      const elapsed = (this.ctx.currentTime - this.startedAtCtxTime) * this.state.playbackRate;
      const span = Math.max(1e-6, this.state.endSec - this.state.startSec);
      const pos = this.state.loop
        ? this.state.startSec + (elapsed % span)
        : Math.min(this.state.endSec, this.state.startSec + elapsed);
      this.state.currentTimeSec = pos;
      this.emit();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  public stop(bumpSeq = true): void {
    if (bumpSeq) this.playSeq++;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.onended = null;
        this.sourceNode.stop();
        this.sourceNode.disconnect();
      } catch {
        // ignore if already stopped
      }
      this.sourceNode = null;
    }
    if (this.auxNodes.length > 0) {
      for (const n of this.auxNodes) {
        try {
          n.disconnect();
        } catch {
          // ignore
        }
      }
      this.auxNodes = [];
    }
    if (this.mediaEl) {
      try {
        this.mediaEl.onended = null;
        this.mediaEl.pause();
        this.mediaEl.src = '';
      } catch {
        // ignore
      }
      this.mediaEl = null;
    }
    if (this.mediaBlobUrl) {
      URL.revokeObjectURL(this.mediaBlobUrl);
      this.mediaBlobUrl = null;
    }
    this.state = {
      ...this.state,
      isPlaying: false,
    };
    this.emit();
  }
}

export const audioPlayer = new WebAudioPlayer();
