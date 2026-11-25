import type {
  AudioEngineClient,
  AudioFileInfo,
  DisplaySettings,
  SpectrogramMatrix,
  SpectrogramParams,
} from '@syrinxone/shared';

export type AutoGainMode = 'manual' | 'auto';

export function normalizeAutoGainMode(mode: unknown): AutoGainMode {
  return mode === 'auto' || mode === 'auto_full' || mode === 'auto_view' ? 'auto' : 'manual';
}

export interface NormalizedGainResult {
  thresholdDb: number;
  dynamicRangeDb: number;
  gainDb: number;
  floorDb: number;
  peakDb: number;
}

export const MAX_WEBGL_TIME_BINS = 8192;
const MAX_SINGLE_REQ_BYTES = 14 * 1024 * 1024;
const TARGET_CHUNK_BYTES = 10 * 1024 * 1024;

export {
  formatDurationCompact,
  formatHms,
  parseHmsOrSeconds,
} from './timeFormat';

/**
 * Estimate a safe maximum partial window duration (in seconds) that stays comfortably
 * within remote engine RAM limits (~160 MB raw PCM/bytes per opened window).
 */
export function getSafeMaxWindowSec(sampleRate: number, numChannels = 1): number {
  const sr = Math.max(1000, sampleRate || 16000);
  const ch = Math.max(1, numChannels || 1);
  const bytesPerSec = sr * ch * 3; // 24-bit WAV upper bound
  const safeBytes = 160 * 1024 * 1024;
  return Math.max(60, Math.min(28800, Math.floor(safeBytes / bytesPerSec)));
}

/**
 * Pick a smart default archive window length for large remote files (>20 MB)
 * so multi-hour recordings open substantially more than 60s without exceeding engine RAM.
 */
export function getSmartArchiveWindowSec(
  fileName: string,
  sizeBytes?: number,
): number | undefined {
  if (sizeBytes !== undefined && sizeBytes <= 20 * 1024 * 1024) {
    return undefined; // Small enough to load the entire file directly
  }
  const lower = fileName.toLowerCase();
  if (/256k|192k|96k/.test(lower)) {
    return 180; // 3 min for ultrasonic hydrophones (~138 MB)
  }
  if (/1khz|2khz|4khz|8khz/.test(lower) || (sizeBytes !== undefined && sizeBytes <= 600_000_000)) {
    return 3600; // 1 hour for low-sample-rate 24h whale archives (~21 MB at 2kHz)
  }
  return 900; // 15 min smart default for 16-48 kHz archives (~43-130 MB)
}

/**
 * Max-pool downsample a SpectrogramMatrix along the time axis so numTimeBins <= maxTimeBins.
 * Uses max-pooling per bin so transient calls and tonal peaks are never averaged away.
 */
export function downsampleSpectrogramTime(
  matrix: SpectrogramMatrix,
  maxTimeBins: number,
): SpectrogramMatrix {
  const { numTimeBins, numFreqBins, data } = matrix;
  if (numTimeBins <= maxTimeBins || numTimeBins <= 0 || numFreqBins <= 0) {
    return matrix;
  }

  const outBins = Math.max(1, maxTimeBins);
  const out = new Float32Array(outBins * numFreqBins);
  let minValue = Infinity;
  let maxValue = -Infinity;

  for (let ot = 0; ot < outBins; ot++) {
    const t0 = Math.floor((ot * numTimeBins) / outBins);
    const t1 = Math.max(t0 + 1, Math.floor(((ot + 1) * numTimeBins) / outBins));
    const outRow = ot * numFreqBins;

    for (let f = 0; f < numFreqBins; f++) {
      let best = -Infinity;
      for (let t = t0; t < t1; t++) {
        const v = data[t * numFreqBins + f];
        if (v > best) best = v;
      }
      if (!Number.isFinite(best)) best = matrix.minValue;
      out[outRow + f] = best;
      if (best < minValue) minValue = best;
      if (best > maxValue) maxValue = best;
    }
  }

  const spanSec = Math.max(1e-6, matrix.endSec - matrix.startSec);
  return {
    ...matrix,
    numTimeBins: outBins,
    timeStepSec: spanSec / outBins,
    minValue: Number.isFinite(minValue) ? minValue : matrix.minValue,
    maxValue: Number.isFinite(maxValue) ? maxValue : matrix.maxValue,
    data: out,
  };
}

/**
 * Fetch a SpectrogramMatrix for any duration (seconds to hours) without hitting
 * HTTP payload limits or exceeding WebGL texture limits.
 */
export async function fetchSpectrogramAdaptive(
  engine: AudioEngineClient,
  file: AudioFileInfo,
  params: SpectrogramParams,
  range?: { startSec?: number; endSec?: number; minFreqHz?: number; maxFreqHz?: number },
  targetMaxTimeBins = MAX_WEBGL_TIME_BINS,
): Promise<SpectrogramMatrix> {
  const startSec = Math.max(0, range?.startSec ?? 0);
  const endSec = Math.max(startSec + 0.01, Math.min(file.durationSec, range?.endSec ?? file.durationSec));
  const spanSec = endSec - startSec;
  const minFreqHz = range?.minFreqHz;
  const maxFreqHz = range?.maxFreqHz;

  // Engine clamps hopSize <= fftSize. When viewing very long spans (> targetMaxTimeBins),
  // bump hopSize up to fftSize if the output pixels are coarser anyway to minimize HTTP traffic.
  const outStepSamples = (spanSec / targetMaxTimeBins) * file.sampleRate;
  const adaptiveHop =
    outStepSamples > params.hopSize * 2
      ? Math.min(params.fftSize, Math.max(params.hopSize, Math.floor(outStepSamples * 0.5)))
      : params.hopSize;
  const fetchParams: SpectrogramParams = { ...params, hopSize: adaptiveHop };

  const effHop = Math.max(1, Math.min(fetchParams.hopSize, fetchParams.fftSize));
  const freqBins = Math.floor(fetchParams.fftSize / 2) + 1;
  const binsPerSec = file.sampleRate / effHop;
  const bytesPerSec = binsPerSec * freqBins * 4;
  const estTotalBytes = spanSec * bytesPerSec;
  const estTotalBins = spanSec * binsPerSec;

  if (estTotalBytes <= MAX_SINGLE_REQ_BYTES && estTotalBins <= targetMaxTimeBins * 1.15) {
    const mat = await engine.getSpectrogram(
      file.fileId,
      fetchParams,
      range ? { startSec, endSec, minFreqHz, maxFreqHz } : undefined,
    );
    return downsampleSpectrogramTime(mat, targetMaxTimeBins);
  }

  // Split into safe chunks under ~10 MB each and downsample each chunk on arrival
  const maxChunkDur = Math.max(2, TARGET_CHUNK_BYTES / Math.max(1, bytesPerSec));
  const numChunks = Math.max(1, Math.ceil(spanSec / maxChunkDur));
  const chunkDur = spanSec / numChunks;

  const ranges: Array<{ s: number; e: number; targetBins: number }> = [];
  for (let i = 0; i < numChunks; i++) {
    const s = startSec + i * chunkDur;
    const e = i === numChunks - 1 ? endSec : Math.min(endSec, startSec + (i + 1) * chunkDur);
    const targetBins = Math.max(4, Math.round(((e - s) / spanSec) * targetMaxTimeBins));
    ranges.push({ s, e, targetBins });
  }

  // Fetch chunks with bounded concurrency (3) to avoid overwhelming Cloud Run
  const results: SpectrogramMatrix[] = new Array(ranges.length);
  let cursor = 0;
  const workerCount = Math.min(3, ranges.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < ranges.length) {
        const idx = cursor++;
        const r = ranges[idx];
        const chunkMat = await engine.getSpectrogram(file.fileId, fetchParams, {
          startSec: r.s,
          endSec: r.e,
          minFreqHz,
          maxFreqHz,
        });
        results[idx] = downsampleSpectrogramTime(chunkMat, r.targetBins);
      }
    }),
  );

  const first = results[0];
  const actualFreqBins = first.numFreqBins;
  const totalOutBins = results.reduce((acc, m) => acc + m.numTimeBins, 0);
  const stitched = new Float32Array(totalOutBins * actualFreqBins);
  let minValue = Infinity;
  let maxValue = -Infinity;
  let offsetBins = 0;

  for (const m of results) {
    const count = Math.min(m.data.length, m.numTimeBins * actualFreqBins);
    stitched.set(m.data.subarray(0, count), offsetBins * actualFreqBins);
    if (m.minValue < minValue) minValue = m.minValue;
    if (m.maxValue > maxValue) maxValue = m.maxValue;
    offsetBins += m.numTimeBins;
  }

  const combined: SpectrogramMatrix = {
    fileId: file.fileId,
    channel: fetchParams.channel,
    numTimeBins: offsetBins,
    numFreqBins: actualFreqBins,
    timeStepSec: spanSec / Math.max(1, offsetBins),
    freqStepHz: first.freqStepHz,
    startSec,
    endSec,
    minFreqHz: first.minFreqHz,
    maxFreqHz: first.maxFreqHz,
    minValue: Number.isFinite(minValue) ? minValue : first.minValue,
    maxValue: Number.isFinite(maxValue) ? maxValue : first.maxValue,
    dspMode: fetchParams.dspMode,
    data: stitched,
  };

  return downsampleSpectrogramTime(combined, targetMaxTimeBins);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Compute optimal display contrast & gain (thresholdDb, dynamicRangeDb, gainDb)
 * mapping the background noise floor cleanly to 0.0 and vocalization peaks near 1.0.
 */
export function computeNormalizedGainDb(
  matrix: SpectrogramMatrix,
  display: Pick<DisplaySettings, 'gainDb' | 'thresholdDb' | 'dynamicRangeDb'>,
  region?: { startSec: number; endSec: number; minFreqHz: number; maxFreqHz: number },
): NormalizedGainResult {
  const { numTimeBins, numFreqBins, data } = matrix;
  const fallback: NormalizedGainResult = {
    thresholdDb: Math.round(Math.max(-120, Math.min(-10, display.thresholdDb))),
    dynamicRangeDb: Math.round(Math.max(15, Math.min(120, display.dynamicRangeDb))),
    gainDb: Math.round(Math.max(-40, Math.min(60, display.gainDb))),
    floorDb: matrix.minValue,
    peakDb: matrix.maxValue,
  };
  if (numTimeBins <= 0 || numFreqBins <= 0 || !data || data.length === 0) {
    return fallback;
  }

  let t0 = 0;
  let t1 = numTimeBins;
  let f0 = 0;
  let f1 = numFreqBins;

  if (region) {
    const matSpanT = Math.max(1e-6, matrix.endSec - matrix.startSec);
    const matSpanF = Math.max(1e-6, matrix.maxFreqHz - matrix.minFreqHz);
    const rStartT = Math.min(region.startSec, region.endSec);
    const rEndT = Math.max(region.startSec, region.endSec);
    const rMinF = Math.min(region.minFreqHz, region.maxFreqHz);
    const rMaxF = Math.max(region.minFreqHz, region.maxFreqHz);

    t0 = Math.max(0, Math.min(numTimeBins - 1, Math.floor(((rStartT - matrix.startSec) / matSpanT) * numTimeBins)));
    t1 = Math.max(t0 + 1, Math.min(numTimeBins, Math.ceil(((rEndT - matrix.startSec) / matSpanT) * numTimeBins)));
    f0 = Math.max(0, Math.min(numFreqBins - 1, Math.floor(((rMinF - matrix.minFreqHz) / matSpanF) * numFreqBins)));
    f1 = Math.max(f0 + 1, Math.min(numFreqBins, Math.ceil(((rMaxF - matrix.minFreqHz) / matSpanF) * numFreqBins)));
  }

  const subT = t1 - t0;
  const subF = f1 - f0;
  const totalCells = subT * subF;
  if (totalCells <= 0) return fallback;

  const targetSamples = 12288;
  const tStep = Math.max(1, Math.floor(Math.sqrt(totalCells / targetSamples) * (subT / Math.max(1, subF)) ** 0.25));
  const fStep = Math.max(1, Math.floor(totalCells / (targetSamples * Math.ceil(subT / tStep))));

  const samples: number[] = [];
  for (let t = t0; t < t1; t += tStep) {
    const rowOff = t * numFreqBins;
    for (let f = f0; f < f1; f += fStep) {
      const idx = rowOff + f;
      if (idx >= data.length) break;
      const v = data[idx];
      if (Number.isFinite(v)) {
        samples.push(v);
      }
    }
  }

  if (samples.length === 0) return fallback;
  samples.sort((a, b) => a - b);

  // p35 places quiet ambient background cleanly at the colormap zero-point without turning it muddy gray,
  // while p99.85 captures vocalization peaks cleanly with 1.5 dB headroom.
  const floorDb = quantile(samples, 0.35);
  const peakSignalDb = quantile(samples, 0.9985);
  const peakDb = Math.max(floorDb + 15, peakSignalDb + 1.5);

  const desiredFloor = Math.min(floorDb, peakDb - 15);
  const thresholdDb = Math.round(Math.max(-120, Math.min(-10, desiredFloor)));
  const gainDb = Math.round(Math.max(-40, Math.min(60, thresholdDb - desiredFloor)));
  const dynamicRangeDb = Math.round(Math.max(15, Math.min(120, peakDb - desiredFloor)));

  return {
    thresholdDb,
    dynamicRangeDb,
    gainDb,
    floorDb,
    peakDb: peakSignalDb,
  };
}
