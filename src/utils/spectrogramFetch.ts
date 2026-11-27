import {
  SPECTROGRAM_BASE_FLOOR_DB,
  SPECTROGRAM_FLOOR_MAX,
  SPECTROGRAM_FLOOR_MIN,
  SPECTROGRAM_GAIN_MAX_DB,
  SPECTROGRAM_GAIN_MIN_DB,
  SPECTROGRAM_SPAN_DB,
  type AudioEngineClient,
  type AudioFileInfo,
  type DisplaySettings,
  type SpectrogramMatrix,
  type SpectrogramParams,
} from '@syrinxone/shared';

export type AutoGainMode = 'manual' | 'auto';

export function normalizeAutoGainMode(mode: unknown): AutoGainMode {
  return mode === 'auto' || mode === 'auto_full' || mode === 'auto_view' ? 'auto' : 'manual';
}

export interface AutoGainResult {
  gainDb: number;
  floor: number;
  noiseDb: number;
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
  sparseOpts?: {
    targetBins?: number;
    onProgress?: (partial: SpectrogramMatrix) => void;
    signal?: AbortSignal;
  },
): Promise<SpectrogramMatrix> {
  const startSec = Math.max(0, range?.startSec ?? 0);
  const endSec = Math.max(startSec + 0.01, Math.min(file.durationSec, range?.endSec ?? file.durationSec));
  const spanSec = endSec - startSec;
  const minFreqHz = range?.minFreqHz;
  const maxFreqHz = range?.maxFreqHz;

  const safeMax = getSafeMaxWindowSec(file.sampleRate, file.numChannels);
  if (file.fileId.startsWith('combined::') && spanSec > Math.min(safeMax, 1800)) {
    const getSpecFn = engine.getSpectrogram as (
      fid: string,
      p: SpectrogramParams,
      r?: { startSec?: number; endSec?: number; minFreqHz?: number; maxFreqHz?: number },
      opts?: typeof sparseOpts,
    ) => Promise<SpectrogramMatrix>;
    return getSpecFn.call(
      engine,
      file.fileId,
      params,
      { startSec, endSec, minFreqHz, maxFreqHz },
      sparseOpts,
    );
  }

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
 * Auto Gain: compute optimal Gain (dB) and Floor (%) for a bioacoustic spectrogram
 * so target signals reach high clarity while stationary background noise snaps cleanly away.
 */
export function computeAutoGain(
  matrix: SpectrogramMatrix,
  display: Pick<DisplaySettings, 'gainDb' | 'floor'>,
  region?: { startSec: number; endSec: number; minFreqHz: number; maxFreqHz: number },
): AutoGainResult {
  const { numTimeBins, numFreqBins, data } = matrix;
  const fallback: AutoGainResult = {
    gainDb: Math.round(
      Math.max(SPECTROGRAM_GAIN_MIN_DB, Math.min(SPECTROGRAM_GAIN_MAX_DB, display.gainDb)),
    ),
    floor: Math.round(
      Math.max(SPECTROGRAM_FLOOR_MIN, Math.min(SPECTROGRAM_FLOOR_MAX, display.floor)),
    ),
    noiseDb: matrix.minValue,
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

  // Skip DC bin (f === 0) when viewing a multi-bin band so DC offset / hydrophone rumble
  // does not skew peak signal or gain estimation.
  if (f0 === 0 && f1 - f0 > 8) {
    f0 = 1;
  }

  const subT = t1 - t0;
  const subF = f1 - f0;
  const totalCells = subT * subF;
  if (totalCells <= 0) return fallback;

  const targetSamples = 16384;
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

  // Robust background noise model from the lower half (unaffected by sparse vocalizations)
  const q25 = quantile(samples, 0.25);
  const noiseMed = quantile(samples, 0.5);
  const q75 = quantile(samples, 0.75);
  const noiseSigma = Math.max(1.5, (noiseMed - q25) / 0.6745);
  const noiseCeilingDb = Math.max(q75 + 1.0, noiseMed + 2.0 * noiseSigma);

  // Target signal peak (99.6th percentile ignores isolated single-pixel clicks while capturing calls)
  const peakSignalDb = quantile(samples, 0.996);

  // 1. Anchor Gain to the background noise ceiling so noise sits naturally at ~2% (level ≈ 0.02)
  //    instead of lifting noise high and forcing a harsh speckled Floor cutoff.
  //    Only lift Gain further on low-SNR recordings so target peaks reach at least 0.55 clarity,
  //    and cap so peaks stay below 0.92 (preventing over-saturation).
  const targetNoiseNorm = 0.02;
  const gainFromNoise =
    targetNoiseNorm * SPECTROGRAM_SPAN_DB + SPECTROGRAM_BASE_FLOOR_DB - noiseCeilingDb;
  const minGainForSignal =
    0.55 * SPECTROGRAM_SPAN_DB + SPECTROGRAM_BASE_FLOOR_DB - peakSignalDb;
  const maxGainNoClip =
    0.92 * SPECTROGRAM_SPAN_DB + SPECTROGRAM_BASE_FLOOR_DB - peakSignalDb;

  const rawGainDb = Math.min(maxGainNoClip, Math.max(minGainForSignal, gainFromNoise));
  const gainDb = Math.round(
    Math.max(SPECTROGRAM_GAIN_MIN_DB, Math.min(SPECTROGRAM_GAIN_MAX_DB, rawGainDb)),
  );

  // 2. Place Floor gently right at the gained noise ceiling (~2% for normal/high-SNR recordings,
  //    higher only when low-SNR gain boost lifts background noise above zero).
  const peakLevel = Math.max(
    0,
    Math.min(1, (peakSignalDb + gainDb - SPECTROGRAM_BASE_FLOOR_DB) / SPECTROGRAM_SPAN_DB),
  );
  const noiseLevel = Math.max(
    0,
    Math.min(1, (noiseCeilingDb + gainDb - SPECTROGRAM_BASE_FLOOR_DB) / SPECTROGRAM_SPAN_DB),
  );
  const maxSafeFloorNorm = Math.max(0, Math.min(0.75, peakLevel - 0.18));
  const desiredFloorNorm = noiseLevel <= 0.005 ? 0 : Math.min(noiseLevel, maxSafeFloorNorm);
  const floor = Math.round(
    Math.max(SPECTROGRAM_FLOOR_MIN, Math.min(SPECTROGRAM_FLOOR_MAX, desiredFloorNorm * 100)),
  );

  return {
    gainDb,
    floor,
    noiseDb: noiseMed,
    peakDb: peakSignalDb,
  };
}
