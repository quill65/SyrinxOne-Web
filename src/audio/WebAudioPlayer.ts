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

export class WebAudioPlayer {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private sourceNode: AudioBufferSourceNode | null = null;
  private rafId: number | null = null;
  private startedAtCtxTime = 0;
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
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
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
    this.emit();
  }

  public setLoop(loop: boolean): void {
    this.state.loop = loop;
    if (this.sourceNode) {
      this.sourceNode.loop = loop;
    }
    this.emit();
  }

  private async loadBuffer(engine: AudioEngineClient, fileId: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(fileId);
    if (cached) return cached;
    const ctx = this.ensureContext();
    const arrayBuf = await engine.fetchAudioArrayBuffer(fileId);
    const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
    this.buffers.set(fileId, decoded);
    return decoded;
  }

  public async play(
    engine: AudioEngineClient,
    fileId: string,
    startSec?: number,
    endSec?: number,
  ): Promise<void> {
    this.stop();
    const ctx = this.ensureContext();
    const buffer = await this.loadBuffer(engine, fileId);
    const s = Math.max(0, Math.min(buffer.duration, startSec ?? 0));
    const e = Math.max(s + 0.005, Math.min(buffer.duration, endSec ?? buffer.duration));
    const duration = e - s;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = this.state.playbackRate;
    src.loop = this.state.loop;
    if (this.state.loop) {
      src.loopStart = s;
      src.loopEnd = e;
    }
    src.connect(ctx.destination);

    this.sourceNode = src;
    this.startedAtCtxTime = ctx.currentTime;
    this.state = {
      ...this.state,
      isPlaying: true,
      fileId,
      startSec: s,
      endSec: e,
      currentTimeSec: s,
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

  public stop(): void {
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
    this.state = {
      ...this.state,
      isPlaying: false,
    };
    this.emit();
  }
}

export const audioPlayer = new WebAudioPlayer();
