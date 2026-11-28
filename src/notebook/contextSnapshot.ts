import type {
  AnnotationRecord,
  AudioFileInfo,
  MDIWindowState,
  SpectrogramMatrix,
  WaveformOverview,
} from '@syrinxone/shared';
import { getCachedSpectrogram, useWorkspaceStore } from '../store/workspaceStore';
import { summarizeSpectrogramMatrix, summarizeWaveform } from '../utils/acousticContext';
import { renderSpectrogramPngBase64 } from '../utils/exportImage';
import type { NotebookContextSummary, NotebookFigure, NotebookScope } from './types';
import { getSyncedRemoteContext } from './notebookSync';

export interface ActiveAcousticSnapshot {
  summary: NotebookContextSummary | null;
  win: MDIWindowState | null;
  file: AudioFileInfo | null;
  matrix: SpectrogramMatrix | null;
  waveform: WaveformOverview | null;
  spectrogramImageBase64?: string;
  contextPayload: Record<string, unknown>;
}

export function captureActiveAcousticSnapshot(scope: NotebookScope): ActiveAcousticSnapshot {
  const ws = useWorkspaceStore.getState();
  const win = ws.windows.find((w) => w.windowId === ws.activeWindowId) ?? ws.windows[0] ?? null;
  const file = win ? ws.files[win.fileId] ?? null : null;

  if (!win || !file) {
    const synced = getSyncedRemoteContext();
    if (synced && synced.contextPayload?.hasOpenRecording) {
      return {
        summary: synced.summary,
        win: null,
        file: null,
        matrix: null,
        waveform: null,
        spectrogramImageBase64: synced.spectrogramImageBase64,
        contextPayload: {
          ...synced.contextPayload,
          scope,
          syncedFromMainTab: true,
        },
      };
    }

    return {
      summary: null,
      win: null,
      file: null,
      matrix: null,
      waveform: null,
      contextPayload: {
        hasOpenRecording: false,
        scope,
        annotationsCount: ws.annotations.length,
      },
    };
  }

  const ch = win.specParams.channel;
  const matrix = getCachedSpectrogram(ws.spectrogramCache, file.fileId, win.specParams) ?? null;
  const waveKey = `${file.fileId}::ch${ch}`;
  const waveform = ws.waveformCache[waveKey] ?? null;

  const targetRange =
    scope === 'selection' && win.selection
      ? {
          startSec: Math.min(win.selection.startSec, win.selection.endSec),
          endSec: Math.max(win.selection.startSec, win.selection.endSec),
          minFreqHz: Math.min(win.selection.lowFreqHz, win.selection.highFreqHz),
          maxFreqHz: Math.max(win.selection.lowFreqHz, win.selection.highFreqHz),
        }
      : win.viewRange;

  const spectrogramImageBase64 = matrix
    ? renderSpectrogramPngBase64(matrix, targetRange, win.displaySettings, 900, 380)
    : undefined;

  const matchingAnnotations: AnnotationRecord[] = ws.annotations
    .filter((a) => !a.soundfile || a.soundfile.toLowerCase() === file.name.toLowerCase())
    .slice(0, 60);

  const specSummary = matrix ? summarizeSpectrogramMatrix(matrix) : null;
  const waveSummary = waveform ? summarizeWaveform(waveform) : null;

  const scopeLabel =
    scope === 'selection' && win.selection
      ? `Selection (${targetRange.startSec.toFixed(2)}–${targetRange.endSec.toFixed(2)}s, ${Math.round(targetRange.minFreqHz)}–${Math.round(targetRange.maxFreqHz)} Hz)`
      : scope === 'view'
        ? `Viewport (${win.viewRange.startSec.toFixed(2)}–${win.viewRange.endSec.toFixed(2)}s)`
        : `Full Loaded Window (${file.durationSec.toFixed(2)}s)`;

  return {
    summary: {
      fileName: file.name,
      fileId: file.fileId,
      sampleRate: file.sampleRate,
      numChannels: file.numChannels,
      durationSec: file.durationSec,
      scopeLabel,
      hasSelection: Boolean(win.selection),
    },
    win,
    file,
    matrix,
    waveform,
    spectrogramImageBase64,
    contextPayload: {
      hasOpenRecording: true,
      scope,
      file: {
        fileId: file.fileId,
        sourceId: file.sourceId,
        uri: file.uri,
        name: file.name,
        sampleRate: file.sampleRate,
        numChannels: file.numChannels,
        durationSec: file.durationSec,
        totalDurationSec: file.totalDurationSec ?? file.durationSec,
        windowStartSec: file.windowStartSec ?? 0,
        startDateTimeIso: file.startDateTimeIso ?? null,
      },
      channel: ch,
      specParams: win.specParams,
      viewRange: win.viewRange,
      selection: win.selection,
      spectrogramSummary: specSummary,
      waveformSummary: waveSummary,
      annotations: matchingAnnotations.map((a) => ({
        channel: a.channel,
        startTimeSec: a.startTimeSec,
        endTimeSec: a.endTimeSec,
        lowFreqHz: a.lowFreqHz,
        highFreqHz: a.highFreqHz,
        comment: a.comment,
        notes: a.notes,
      })),
    },
  };
}

/**
 * Generates clean diagnostic plots directly from cached DSP matrices when running without
 * a remote Python kernel endpoint, so notebooks & tools produce visual figures out of the box.
 */
export function buildDspPreviewDiagnostics(
  snapshot: ActiveAcousticSnapshot,
  code: string,
): {
  stdout: string;
  figures: NotebookFigure[];
  variables: Record<string, unknown>;
} {
  const { file, win, matrix } = snapshot;
  if (!file || !win) {
    return {
      stdout: 'No active recording is currently open in the spectrogram workspace.',
      figures: [],
      variables: {},
    };
  }

  const ws = useWorkspaceStore.getState();
  const figures: NotebookFigure[] = [];
  const variables: Record<string, unknown> = {
    file_name: file.name,
    sample_rate_hz: file.sampleRate,
    num_channels: file.numChannels,
    duration_sec: Number(file.durationSec.toFixed(3)),
  };

  const lines: string[] = [
    `Recording: ${file.name} (${file.sampleRate} Hz, ${file.numChannels} ch, ${file.durationSec.toFixed(2)} s)`,
  ];

  // If code looks channel-RMS focused and waveforms are cached, plot channel comparison
  const wantsChannels = /numChannels|channel_rms|Ch\s|bar\(/i.test(code);
  if (wantsChannels && file.numChannels > 1) {
    const chRms: number[] = [];
    for (let ch = 0; ch < file.numChannels; ch++) {
      const wf = ws.waveformCache[`${file.fileId}::ch${ch}`];
      if (wf && wf.minValues.length > 0 && wf.maxValues.length > 0) {
        const len = Math.min(wf.minValues.length, wf.maxValues.length);
        let sumSq = 0;
        for (let i = 0; i < len; i++) {
          const a = Math.max(Math.abs(wf.minValues[i]), Math.abs(wf.maxValues[i]));
          sumSq += a * a;
        }
        chRms.push(Number(Math.sqrt(sumSq / len).toFixed(5)));
      } else {
        chRms.push(0);
      }
    }
    variables.channel_rms = chRms;
    lines.push(`Channel RMS estimates: [${chRms.join(', ')}]`);

    const barPng = renderBarFigurePng('Multi-Channel RMS Level Balance', chRms);
    if (barPng) {
      figures.push({ label: 'Channel RMS Comparison', base64Png: barPng });
    }
  }

  if (matrix && matrix.numTimeBins > 0 && matrix.numFreqBins > 0) {
    const summary = summarizeSpectrogramMatrix(matrix);
    if (summary) {
      variables.peak_freq_hz = summary.globalPeakFreqHz;
      variables.peak_time_sec = summary.globalPeakTimeSec;
      variables.noise_floor_db = summary.noiseFloorP20;
      variables.max_db = summary.maxVal;
      variables.active_cell_pct = summary.activeCellPct;
      lines.push(
        `Peak P95/Global energy at ${summary.globalPeakFreqHz} Hz (${summary.globalPeakTimeSec}s) | P20 noise floor: ${summary.noiseFloorP20} dB | Max: ${summary.maxVal} dB`,
      );
    }

    const specProfilePng = renderSpectralProfilePng(file.name, matrix);
    if (specProfilePng) {
      figures.push({ label: 'Spectral Band Profile (Mean vs P95)', base64Png: specProfilePng });
    }
  } else {
    lines.push('Spectrogram matrix not yet cached for this channel.');
  }

  return {
    stdout: lines.join('\n'),
    figures,
    variables,
  };
}

function renderSpectralProfilePng(title: string, matrix: SpectrogramMatrix): string | undefined {
  try {
    const w = 720;
    const h = 280;
    const padL = 52;
    const padR = 18;
    const padT = 30;
    const padB = 36;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    ctx.fillStyle = '#0f141b';
    ctx.fillRect(0, 0, w, h);

    const nF = matrix.numFreqBins;
    const nT = matrix.numTimeBins;
    const meanArr = new Float32Array(nF);
    const p95Arr = new Float32Array(nF);
    let minDb = Infinity;
    let maxDb = -Infinity;

    const colBuf = new Float32Array(nT);
    for (let f = 0; f < nF; f++) {
      let sum = 0;
      for (let t = 0; t < nT; t++) {
        const v = matrix.data[t * nF + f];
        colBuf[t] = v;
        sum += v;
      }
      colBuf.sort();
      const mean = sum / nT;
      const p95 = colBuf[Math.min(nT - 1, Math.floor(0.95 * (nT - 1)))];
      meanArr[f] = mean;
      p95Arr[f] = p95;
      if (mean < minDb) minDb = mean;
      if (p95 > maxDb) maxDb = p95;
    }

    const dbSpan = Math.max(10, maxDb - minDb);
    ctx.strokeStyle = '#263244';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, plotW, plotH);

    const drawCurve = (arr: Float32Array, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let f = 0; f < nF; f++) {
        const x = padL + (f / Math.max(1, nF - 1)) * plotW;
        const y = padT + (1 - (arr[f] - minDb) / dbSpan) * plotH;
        if (f === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    drawCurve(meanArr, '#94a3b8');
    drawCurve(p95Arr, '#38bdf8');

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(`${title} — Spectral Energy (Mean gray / P95 cyan)`, padL, 19);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`${(matrix.minFreqHz / 1000).toFixed(1)} kHz`, padL, h - 12);
    ctx.fillText(
      `${(matrix.maxFreqHz / 1000).toFixed(1)} kHz`,
      w - padR - 46,
      h - 12,
    );
    ctx.fillText(`${Math.round(maxDb)} dB`, 6, padT + 10);
    ctx.fillText(`${Math.round(minDb)} dB`, 6, padT + plotH);

    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl.split(',')[1];
  } catch {
    return undefined;
  }
}

function renderBarFigurePng(title: string, values: number[]): string | undefined {
  try {
    const w = 640;
    const h = 230;
    const padL = 52;
    const padR = 18;
    const padT = 30;
    const padB = 34;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    ctx.fillStyle = '#0f141b';
    ctx.fillRect(0, 0, w, h);

    const maxV = Math.max(1e-6, ...values);
    const barSlot = plotW / Math.max(1, values.length);
    const barW = Math.max(12, Math.min(54, barSlot * 0.55));

    ctx.strokeStyle = '#263244';
    ctx.strokeRect(padL, padT, plotW, plotH);

    values.forEach((v, idx) => {
      const bh = (v / maxV) * (plotH - 12);
      const bx = padL + idx * barSlot + (barSlot - barW) / 2;
      const by = padT + plotH - bh;
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(bx, by, barW, bh);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`Ch ${idx + 1}`, bx + barW / 2, h - 14);
    });

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(title, padL, 19);

    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl.split(',')[1];
  } catch {
    return undefined;
  }
}
