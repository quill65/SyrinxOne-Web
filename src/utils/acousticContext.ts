import type {
  AudioFileInfo,
  SpectrogramMatrix,
  WaveformOverview,
} from '@syrinxone/shared';

export interface TemporalSliceSummary {
  startSec: number;
  endSec: number;
  meanDb: number;
  peakDb: number;
  peakFreqHz: number;
  centroidFreqHz: number;
  activePct: number;
}

export interface SpectralBandSummary {
  lowFreqHz: number;
  highFreqHz: number;
  meanDb: number;
  peakDb: number;
  floorP20Db: number;
  peakTimeSec: number;
}

export interface AcousticPeakEvent {
  timeSec: number;
  freqHz: number;
  peakDb: number;
}

export interface SpectrogramAcousticSummary {
  durationSec: number;
  minFreqHz: number;
  maxFreqHz: number;
  numTimeBins: number;
  numFreqBins: number;
  dspMode: string;
  minVal: number;
  maxVal: number;
  noiseFloorP20: number;
  medianVal: number;
  p95Val: number;
  activeCellPct: number;
  globalPeakTimeSec: number;
  globalPeakFreqHz: number;
  temporalProfile: TemporalSliceSummary[];
  spectralBands: SpectralBandSummary[];
  topEvents: AcousticPeakEvent[];
}

export interface WaveformSegmentSummary {
  startSec: number;
  endSec: number;
  peakAbs: number;
  rmsApprox: number;
}

export interface WaveformAcousticSummary {
  durationSec: number;
  peakAbs: number;
  rmsApprox: number;
  loudestSliceStartSec: number;
  quietestSliceStartSec: number;
  segments: WaveformSegmentSummary[];
}

function round1(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(1)) : 0;
}

function round3(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(3)) : 0;
}

export function parentDirectoryUri(uri: string): string {
  if (!uri) return '';
  const trimmed = uri.replace(/[/\\]+$/, '');
  const fwd = trimmed.lastIndexOf('/');
  const bwd = trimmed.lastIndexOf('\\');
  const idx = Math.max(fwd, bwd);
  if (idx <= 0) return '';
  const dir = trimmed.slice(0, idx);
  return dir.endsWith(':') ? `${dir}\\` : dir;
}

export function summarizeSpectrogramMatrix(
  matrix: SpectrogramMatrix,
  targetTimeSlices = 14,
  targetFreqBands = 10,
): SpectrogramAcousticSummary | null {
  const { numTimeBins, numFreqBins, data, startSec, endSec, minFreqHz, maxFreqHz } = matrix;
  if (!numTimeBins || !numFreqBins || !data || data.length === 0) return null;

  const totalCells = Math.min(data.length, numTimeBins * numFreqBins);
  const sampleTarget = 768;
  const stride = Math.max(1, Math.floor(totalCells / sampleTarget));
  const sampled: number[] = [];
  let minVal = Infinity;
  let maxVal = -Infinity;
  let globalPeakT = 0;
  let globalPeakF = 0;

  for (let t = 0; t < numTimeBins; t++) {
    const rowOff = t * numFreqBins;
    for (let f = 0; f < numFreqBins; f++) {
      const idx = rowOff + f;
      if (idx >= totalCells) break;
      const v = data[idx];
      if (!Number.isFinite(v)) continue;
      if (v < minVal) minVal = v;
      if (v > maxVal) {
        maxVal = v;
        globalPeakT = t;
        globalPeakF = f;
      }
      if (idx % stride === 0) {
        sampled.push(v);
      }
    }
  }

  if (!Number.isFinite(minVal) || sampled.length === 0) return null;

  sampled.sort((a, b) => a - b);
  const p20 = sampled[Math.min(sampled.length - 1, Math.floor(sampled.length * 0.2))];
  const p50 = sampled[Math.min(sampled.length - 1, Math.floor(sampled.length * 0.5))];
  const p95 = sampled[Math.min(sampled.length - 1, Math.floor(sampled.length * 0.95))];
  const activeThreshold = p20 + 8;

  let activeCount = 0;
  for (let i = 0; i < totalCells; i++) {
    if (data[i] > activeThreshold) activeCount++;
  }

  const timeSpan = Math.max(1e-6, endSec - startSec);
  const freqSpan = Math.max(1e-6, maxFreqHz - minFreqHz);
  const binTimeStep = matrix.timeStepSec > 0 ? matrix.timeStepSec : timeSpan / Math.max(1, numTimeBins);
  const binFreqStep = matrix.freqStepHz > 0 ? matrix.freqStepHz : freqSpan / Math.max(1, numFreqBins);

  // Temporal slices
  const sliceCount = Math.max(1, Math.min(targetTimeSlices, numTimeBins));
  const temporalProfile: TemporalSliceSummary[] = [];
  const sliceFramePeaks: Array<{ timeSec: number; freqHz: number; peakDb: number }> = [];

  for (let s = 0; s < sliceCount; s++) {
    const t0 = Math.floor((s * numTimeBins) / sliceCount);
    const t1 = Math.max(t0 + 1, Math.floor(((s + 1) * numTimeBins) / sliceCount));
    let sum = 0;
    let count = 0;
    let sliceActive = 0;
    let slicePeak = -Infinity;
    let slicePeakT = t0;
    let slicePeakF = 0;
    let weightSum = 0;
    let freqWeightSum = 0;

    for (let t = t0; t < t1; t++) {
      const rowOff = t * numFreqBins;
      for (let f = 0; f < numFreqBins; f++) {
        const idx = rowOff + f;
        if (idx >= totalCells) break;
        const v = data[idx];
        if (!Number.isFinite(v)) continue;
        sum += v;
        count++;
        if (v > activeThreshold) sliceActive++;
        if (v > slicePeak) {
          slicePeak = v;
          slicePeakT = t;
          slicePeakF = f;
        }
        const lin = Math.max(0, v - p20);
        if (lin > 0) {
          const freqHz = minFreqHz + f * binFreqStep;
          weightSum += lin;
          freqWeightSum += lin * freqHz;
        }
      }
    }

    const sStart = startSec + (t0 / numTimeBins) * timeSpan;
    const sEnd = startSec + (t1 / numTimeBins) * timeSpan;
    const peakFreqHz = minFreqHz + slicePeakF * binFreqStep;
    const peakTimeSec = startSec + slicePeakT * binTimeStep;
    const centroidHz = weightSum > 0 ? freqWeightSum / weightSum : peakFreqHz;

    temporalProfile.push({
      startSec: round3(sStart),
      endSec: round3(sEnd),
      meanDb: round1(count > 0 ? sum / count : p20),
      peakDb: round1(Number.isFinite(slicePeak) ? slicePeak : p20),
      peakFreqHz: round1(peakFreqHz),
      centroidFreqHz: round1(centroidHz),
      activePct: round1(count > 0 ? (sliceActive / count) * 100 : 0),
    });

    if (Number.isFinite(slicePeak)) {
      sliceFramePeaks.push({
        timeSec: round3(peakTimeSec),
        freqHz: round1(peakFreqHz),
        peakDb: round1(slicePeak),
      });
    }
  }

  // Spectral frequency bands
  const bandCount = Math.max(1, Math.min(targetFreqBands, numFreqBins));
  const spectralBands: SpectralBandSummary[] = [];

  for (let b = 0; b < bandCount; b++) {
    const f0 = Math.floor((b * numFreqBins) / bandCount);
    const f1 = Math.max(f0 + 1, Math.floor(((b + 1) * numFreqBins) / bandCount));
    let sum = 0;
    let count = 0;
    let bandPeak = -Infinity;
    let bandPeakT = 0;
    const bandSamples: number[] = [];
    const bandStride = Math.max(1, Math.floor((numTimeBins * (f1 - f0)) / 180));

    for (let t = 0; t < numTimeBins; t++) {
      const rowOff = t * numFreqBins;
      for (let f = f0; f < f1; f++) {
        const idx = rowOff + f;
        if (idx >= totalCells) break;
        const v = data[idx];
        if (!Number.isFinite(v)) continue;
        sum += v;
        count++;
        if (v > bandPeak) {
          bandPeak = v;
          bandPeakT = t;
        }
        if (count % bandStride === 0) {
          bandSamples.push(v);
        }
      }
    }

    bandSamples.sort((a, bVal) => a - bVal);
    const bandFloor =
      bandSamples.length > 0
        ? bandSamples[Math.min(bandSamples.length - 1, Math.floor(bandSamples.length * 0.2))]
        : p20;

    spectralBands.push({
      lowFreqHz: round1(minFreqHz + f0 * binFreqStep),
      highFreqHz: round1(Math.min(maxFreqHz, minFreqHz + f1 * binFreqStep)),
      meanDb: round1(count > 0 ? sum / count : p20),
      peakDb: round1(Number.isFinite(bandPeak) ? bandPeak : p20),
      floorP20Db: round1(bandFloor),
      peakTimeSec: round3(startSec + bandPeakT * binTimeStep),
    });
  }

  // Top distinct acoustic peaks across time
  const minSeparationSec = timeSpan / Math.max(8, sliceCount);
  const sortedPeaks = [...sliceFramePeaks].sort((a, b) => b.peakDb - a.peakDb);
  const topEvents: AcousticPeakEvent[] = [];
  for (const cand of sortedPeaks) {
    if (topEvents.every((e) => Math.abs(e.timeSec - cand.timeSec) >= minSeparationSec * 0.75)) {
      topEvents.push(cand);
      if (topEvents.length >= 6) break;
    }
  }

  return {
    durationSec: round3(timeSpan),
    minFreqHz: round1(minFreqHz),
    maxFreqHz: round1(maxFreqHz),
    numTimeBins,
    numFreqBins,
    dspMode: matrix.dspMode,
    minVal: round1(minVal),
    maxVal: round1(maxVal),
    noiseFloorP20: round1(p20),
    medianVal: round1(p50),
    p95Val: round1(p95),
    activeCellPct: round1((activeCount / Math.max(1, totalCells)) * 100),
    globalPeakTimeSec: round3(startSec + globalPeakT * binTimeStep),
    globalPeakFreqHz: round1(minFreqHz + globalPeakF * binFreqStep),
    temporalProfile,
    spectralBands,
    topEvents,
  };
}

export function summarizeWaveform(
  waveform: WaveformOverview,
  targetSegments = 14,
): WaveformAcousticSummary | null {
  const n = Math.min(waveform.minValues.length, waveform.maxValues.length);
  if (n === 0) return null;

  const startSec = waveform.startSec;
  const endSec = waveform.endSec;
  const span = Math.max(1e-6, endSec - startSec);
  const segCount = Math.max(1, Math.min(targetSegments, n));

  let globalPeak = 0;
  let globalSqSum = 0;
  let loudestSegStart = startSec;
  let loudestPeak = -1;
  let quietestSegStart = startSec;
  let quietestRms = Infinity;
  const segments: WaveformSegmentSummary[] = [];

  for (let s = 0; s < segCount; s++) {
    const i0 = Math.floor((s * n) / segCount);
    const i1 = Math.max(i0 + 1, Math.floor(((s + 1) * n) / segCount));
    let segPeak = 0;
    let segSqSum = 0;
    for (let i = i0; i < i1; i++) {
      const a = Math.max(Math.abs(waveform.minValues[i] ?? 0), Math.abs(waveform.maxValues[i] ?? 0));
      if (a > segPeak) segPeak = a;
      if (a > globalPeak) globalPeak = a;
      segSqSum += a * a;
      globalSqSum += a * a;
    }
    const segRms = Math.sqrt(segSqSum / Math.max(1, i1 - i0));
    const sStart = startSec + (i0 / n) * span;
    const sEnd = startSec + (i1 / n) * span;
    if (segPeak > loudestPeak) {
      loudestPeak = segPeak;
      loudestSegStart = sStart;
    }
    if (segRms < quietestRms) {
      quietestRms = segRms;
      quietestSegStart = sStart;
    }
    segments.push({
      startSec: round3(sStart),
      endSec: round3(sEnd),
      peakAbs: Number(segPeak.toFixed(4)),
      rmsApprox: Number(segRms.toFixed(4)),
    });
  }

  return {
    durationSec: round3(span),
    peakAbs: Number(globalPeak.toFixed(4)),
    rmsApprox: Number(Math.sqrt(globalSqSum / n).toFixed(4)),
    loudestSliceStartSec: round3(loudestSegStart),
    quietestSliceStartSec: round3(quietestSegStart),
    segments,
  };
}

export function formatFileSummaryLine(f: AudioFileInfo): string {
  const partial = f.isPartialWindow
    ? ` | Archive Window: ${(f.windowStartSec ?? 0).toFixed(1)}s–${((f.windowStartSec ?? 0) + f.durationSec).toFixed(1)}s of ${(f.totalDurationSec ?? f.durationSec).toFixed(1)}s total`
    : '';
  return `${f.name} (${f.sourceId}:${f.uri}) | ${f.sampleRate} Hz, ${f.numChannels} ch, ${f.durationSec.toFixed(2)}s, ${f.format}/${f.subtype}${partial}`;
}
