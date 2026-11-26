import type {
  AudioFileInfo,
  HttpAudioEngineClient,
  SpectrogramMatrix,
  SpectrogramParams,
  WaveformOverview,
} from '@syrinxone/shared';
import { getSafeMaxWindowSec } from './spectrogramFetch';

export interface SegmentLocation {
  index: number;
  sourceId: string;
  uri: string;
  name?: string;
  sizeBytes?: number;
  durationSec: number;
  timelineStartSec: number;
  timelineEndSec: number;
}

export interface SparseSpectrogramOptions {
  targetSamples?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (partial: SpectrogramMatrix) => void;
  onSegmentProbed?: (segmentIndex: number, exactDurationSec: number, info: AudioFileInfo) => void;
}

interface SampleTarget {
  colIdx: number;
  absTimeSec: number;
  segIdx: number;
  segLocalSec: number;
}

interface CoalescedReadTask {
  seg: SegmentLocation;
  sliceStartSec: number;
  sliceEndSec: number;
  targets: SampleTarget[];
  priorityWave: 0 | 1;
}

/**
 * Determine when sparse spectral-line sampling should be used instead of
 * downloading dense contiguous STFTs across an entire time span.
 */
export function shouldUseSparseSpectrogram(
  spanSec: number,
  sampleRate: number,
  numChannels: number,
  fftSize: number,
  segmentCount = 1,
): boolean {
  const safeMax = getSafeMaxWindowSec(sampleRate, numChannels);
  const frameDur = fftSize / Math.max(1000, sampleRate);
  // If we only need a tiny fraction of frames across a long span or many files,
  // sparse window access avoids reading unused wave data.
  if (spanSec > Math.min(safeMax, 1800)) {
    return spanSec / Math.max(0.01, frameDur) > 256;
  }
  if (segmentCount > 3 && spanSec > 300) {
    return true;
  }
  return false;
}

function findSegmentIndexAtTime(segments: SegmentLocation[], absTimeSec: number): number {
  if (segments.length === 0) return -1;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    if (absTimeSec < seg.timelineStartSec) {
      hi = mid - 1;
    } else if (absTimeSec >= seg.timelineEndSec) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return Math.max(0, Math.min(segments.length - 1, lo));
}

function buildPartialMatrix(
  fileId: string,
  channel: number,
  dspMode: SpectrogramParams['dspMode'],
  startSec: number,
  endSec: number,
  numSamples: number,
  freqBins: number,
  freqStepHz: number,
  minFreqHz: number,
  maxFreqHz: number,
  columns: Array<Float32Array | null>,
  fallbackFloor: number,
): SpectrogramMatrix {
  const data = new Float32Array(numSamples * freqBins);
  let minValue = Infinity;
  let maxValue = -Infinity;

  // Fill any unpopulated columns in Wave 1 with nearest populated neighbor for clean preview
  const populatedIndices: number[] = [];
  for (let i = 0; i < numSamples; i++) {
    if (columns[i] !== null) populatedIndices.push(i);
  }

  let popPtr = 0;
  for (let i = 0; i < numSamples; i++) {
    let col = columns[i];
    if (!col && populatedIndices.length > 0) {
      while (
        popPtr + 1 < populatedIndices.length &&
        Math.abs(populatedIndices[popPtr + 1] - i) <= Math.abs(populatedIndices[popPtr] - i)
      ) {
        popPtr++;
      }
      col = columns[populatedIndices[popPtr]];
    }

    const rowOff = i * freqBins;
    if (col) {
      const copyLen = Math.min(freqBins, col.length);
      for (let f = 0; f < copyLen; f++) {
        const v = col[f];
        data[rowOff + f] = v;
        if (v < minValue) minValue = v;
        if (v > maxValue) maxValue = v;
      }
      for (let f = copyLen; f < freqBins; f++) {
        data[rowOff + f] = fallbackFloor;
      }
    } else {
      for (let f = 0; f < freqBins; f++) {
        data[rowOff + f] = fallbackFloor;
      }
    }
  }

  if (!Number.isFinite(minValue)) minValue = fallbackFloor;
  if (!Number.isFinite(maxValue)) maxValue = fallbackFloor + 60;

  return {
    fileId,
    channel,
    numTimeBins: numSamples,
    numFreqBins: freqBins,
    timeStepSec: Math.max(1e-6, endSec - startSec) / Math.max(1, numSamples),
    freqStepHz,
    startSec,
    endSec,
    minFreqHz,
    maxFreqHz,
    minValue,
    maxValue,
    dspMode,
    data,
  };
}

/**
 * Sparse Wave-Segment Spectrogram Reader:
 * Reads ONLY the small wave windows needed to compute spectral lines across [startSec, endSec],
 * coalescing nearby reads within the same file and skipping untouched files completely.
 */
export async function fetchSparseSpectrogram(
  inner: HttpAudioEngineClient,
  fileId: string,
  segments: SegmentLocation[],
  params: SpectrogramParams,
  sampleRate: number,
  range: { startSec: number; endSec: number; minFreqHz?: number; maxFreqHz?: number },
  options?: SparseSpectrogramOptions,
): Promise<SpectrogramMatrix> {
  if (segments.length === 0) {
    throw new Error('No audio segments available for sparse spectrogram read.');
  }

  const startSec = Math.max(0, range.startSec);
  const endSec = Math.max(startSec + 0.05, range.endSec);
  const spanSec = endSec - startSec;
  const nyquist = sampleRate / 2;
  const minFreqHz = Math.max(0, range.minFreqHz ?? 0);
  const maxFreqHz = Math.max(minFreqHz + 1, Math.min(nyquist, range.maxFreqHz ?? nyquist));

  const numSamples = Math.max(16, Math.min(192, options?.targetSamples ?? 96));
  const concurrency = Math.max(1, Math.min(10, options?.concurrency ?? 8));
  const frameDur = params.fftSize / Math.max(1000, sampleRate);
  // Just enough wave data to yield 1..2 complete FFT frames per sample point
  const microDurSec = Math.max(0.32, Math.min(3.0, frameDur * 1.35));
  const coalesceGapSec = Math.max(2.5, microDurSec * 4);

  const targets: SampleTarget[] = [];
  for (let i = 0; i < numSamples; i++) {
    const absTimeSec = startSec + ((i + 0.5) / numSamples) * spanSec;
    const segIdx = findSegmentIndexAtTime(segments, absTimeSec);
    if (segIdx < 0) continue;
    const seg = segments[segIdx];
    const segLocalSec = Math.max(
      0,
      Math.min(Math.max(0, seg.durationSec - microDurSec), absTimeSec - seg.timelineStartSec),
    );
    targets.push({ colIdx: i, absTimeSec, segIdx, segLocalSec });
  }

  // Group adjacent targets in the same segment within coalesceGapSec
  const tasks: CoalescedReadTask[] = [];
  for (const t of targets) {
    const seg = segments[t.segIdx];
    const prev = tasks[tasks.length - 1];
    const reqEnd = Math.min(seg.durationSec, t.segLocalSec + microDurSec);
    if (
      prev &&
      prev.seg.index === seg.index &&
      t.segLocalSec - prev.sliceEndSec <= coalesceGapSec &&
      reqEnd - prev.sliceStartSec <= 30
    ) {
      prev.sliceEndSec = Math.max(prev.sliceEndSec, reqEnd);
      prev.targets.push(t);
    } else {
      tasks.push({
        seg,
        sliceStartSec: t.segLocalSec,
        sliceEndSec: Math.max(t.segLocalSec + microDurSec, reqEnd),
        targets: [t],
        priorityWave: t.colIdx % 4 === 0 ? 0 : 1,
      });
    }
  }

  const wave0 = tasks.filter((t) => t.priorityWave === 0);
  const wave1 = tasks.filter((t) => t.priorityWave === 1);

  const columns: Array<Float32Array | null> = new Array(numSamples).fill(null);
  let resolvedFreqBins = Math.floor(params.fftSize / 2) + 1;
  let resolvedFreqStepHz = nyquist / Math.max(1, resolvedFreqBins - 1);
  let resolvedMinFreqHz = minFreqHz;
  let resolvedMaxFreqHz = maxFreqHz;
  let fallbackFloor = -100;

  const sparseParams: SpectrogramParams = {
    ...params,
    hopSize: params.fftSize,
  };

  const runTask = async (task: CoalescedReadTask): Promise<void> => {
    if (options?.signal?.aborted) return;
    const seg = task.seg;
    const reqDur = Math.max(0.28, task.sliceEndSec - task.sliceStartSec);

    let info: AudioFileInfo;
    try {
      info = await inner.openAudio(seg.sourceId, seg.uri, {
        startSec: task.sliceStartSec,
        maxDurationSec: reqDur,
      });
    } catch {
      // Retry near start of segment if estimated duration overshot actual file duration
      try {
        info = await inner.openAudio(seg.sourceId, seg.uri, {
          startSec: 0,
          maxDurationSec: Math.min(reqDur, 1),
        });
      } catch {
        return;
      }
    }

    if (options?.signal?.aborted) return;

    const exactTotal = info.totalDurationSec ?? info.durationSec;
    if (exactTotal > 0.05 && Math.abs(exactTotal - seg.durationSec) > 0.5) {
      options?.onSegmentProbed?.(seg.index, exactTotal, info);
    }

    // If openAudio clamped near EOF, fetch within the actually returned slice
    const sliceStart = info.windowStartSec ?? 0;
    const sliceDur = Math.max(0.05, info.durationSec);
    if (sliceDur < frameDur * 0.5) return;

    try {
      const mat = await inner.getSpectrogram(info.fileId, sparseParams, {
        startSec: 0,
        endSec: sliceDur,
        minFreqHz,
        maxFreqHz,
      });
      if (mat.numTimeBins <= 0 || mat.numFreqBins <= 0) return;

      resolvedFreqBins = mat.numFreqBins;
      resolvedFreqStepHz = mat.freqStepHz;
      resolvedMinFreqHz = mat.minFreqHz;
      resolvedMaxFreqHz = mat.maxFreqHz;
      if (Number.isFinite(mat.minValue)) {
        fallbackFloor = Math.min(fallbackFloor, mat.minValue);
      }

      for (const target of task.targets) {
        const relInSlice = target.segLocalSec - sliceStart;
        const frac = Math.max(0, Math.min(1, relInSlice / Math.max(1e-4, sliceDur)));
        const frameIdx = Math.min(
          mat.numTimeBins - 1,
          Math.max(0, Math.round(frac * (mat.numTimeBins - 1))),
        );
        const off = frameIdx * mat.numFreqBins;
        columns[target.colIdx] = mat.data.slice(off, off + mat.numFreqBins);
      }
    } catch {
      // Ignore individual micro-slice failures cleanly
    }
  };

  const executeBatch = async (batch: CoalescedReadTask[]) => {
    let cursor = 0;
    const workers = Math.min(concurrency, batch.length);
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (cursor < batch.length) {
          if (options?.signal?.aborted) return;
          const idx = cursor++;
          await runTask(batch[idx]);
        }
      }),
    );
  };

  if (wave0.length > 0) {
    await executeBatch(wave0);
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted sparse spectrogram fetch', 'AbortError');
    }
    if (options?.onProgress && columns.some((c) => c !== null)) {
      options.onProgress(
        buildPartialMatrix(
          fileId,
          params.channel,
          params.dspMode,
          startSec,
          endSec,
          numSamples,
          resolvedFreqBins,
          resolvedFreqStepHz,
          resolvedMinFreqHz,
          resolvedMaxFreqHz,
          columns,
          fallbackFloor,
        ),
      );
    }
  }

  if (wave1.length > 0) {
    await executeBatch(wave1);
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted sparse spectrogram fetch', 'AbortError');
    }
  }

  if (!columns.some((c) => c !== null)) {
    throw new Error('Unable to read sparse spectral lines from recording.');
  }

  return buildPartialMatrix(
    fileId,
    params.channel,
    params.dspMode,
    startSec,
    endSec,
    numSamples,
    resolvedFreqBins,
    resolvedFreqStepHz,
    resolvedMinFreqHz,
    resolvedMaxFreqHz,
    columns,
    fallbackFloor,
  );
}

/**
 * Sparse Waveform Envelope Reader:
 * Samples a bounded number of short micro-windows across a long recording
 * without opening every underlying segment.
 */
export async function fetchSparseWaveform(
  inner: HttpAudioEngineClient,
  fileId: string,
  segments: SegmentLocation[],
  channel: number,
  numBins: number,
  startSec: number,
  endSec: number,
  probeCount = 32,
): Promise<WaveformOverview> {
  const s = Math.max(0, startSec);
  const e = Math.max(s + 0.05, endSec);
  const span = e - s;
  const count = Math.max(8, Math.min(48, probeCount));
  const binsPerProbe = Math.max(2, Math.ceil(numBins / count));

  const sampledMins: Array<number[] | null> = new Array(count).fill(null);
  const sampledMaxs: Array<number[] | null> = new Array(count).fill(null);

  let cursor = 0;
  const workers = Math.min(8, count);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < count) {
        const i = cursor++;
        const absTime = s + ((i + 0.5) / count) * span;
        const segIdx = findSegmentIndexAtTime(segments, absTime);
        if (segIdx < 0) continue;
        const seg = segments[segIdx];
        const segLocal = Math.max(
          0,
          Math.min(Math.max(0, seg.durationSec - 0.5), absTime - seg.timelineStartSec),
        );
        try {
          const info = await inner.openAudio(seg.sourceId, seg.uri, {
            startSec: segLocal,
            maxDurationSec: 0.4,
          });
          const wf = await inner.getWaveform(info.fileId, channel, binsPerProbe, 0, info.durationSec);
          sampledMins[i] = wf.minValues;
          sampledMaxs[i] = wf.maxValues;
        } catch {
          sampledMins[i] = new Array(binsPerProbe).fill(0);
          sampledMaxs[i] = new Array(binsPerProbe).fill(0);
        }
      }
    }),
  );

  const minValues: number[] = [];
  const maxValues: number[] = [];
  for (let i = 0; i < count; i++) {
    const mins = sampledMins[i] ?? new Array(binsPerProbe).fill(0);
    const maxs = sampledMaxs[i] ?? new Array(binsPerProbe).fill(0);
    minValues.push(...mins);
    maxValues.push(...maxs);
  }

  return {
    fileId,
    channel,
    numBins: minValues.length,
    startSec: s,
    endSec: e,
    minValues,
    maxValues,
  };
}
