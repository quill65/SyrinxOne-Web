import {
  SPECTROGRAM_BASE_FLOOR_DB,
  SPECTROGRAM_SPAN_DB,
  type DisplaySettings,
  type SpectrogramMatrix,
  type TimeFreqRange,
} from '@syrinxone/shared';
import { buildColormapRGBA } from '../components/spectrogram/colormaps';

function renderSingleRowIntoCanvas(
  ctx: CanvasRenderingContext2D,
  imgData: ImageData,
  matrix: SpectrogramMatrix,
  viewRange: TimeFreqRange,
  display: DisplaySettings,
  lut: Uint8Array,
  leftPad: number,
  topY: number,
  plotW: number,
  plotH: number,
): void {
  const floorNorm = Math.max(0, Math.min(0.95, display.floor / 100));
  const totalT = Math.max(1e-6, matrix.endSec - matrix.startSec);
  const totalF = Math.max(1e-6, matrix.maxFreqHz - matrix.minFreqHz);

  for (let py = 0; py < plotH; py++) {
    const fFrac = 1 - py / Math.max(1, plotH - 1);
    const freqHz = viewRange.minFreqHz + fFrac * (viewRange.maxFreqHz - viewRange.minFreqHz);
    const fNorm = (freqHz - matrix.minFreqHz) / totalF;
    const fi = Math.max(0, Math.min(matrix.numFreqBins - 1, Math.round(fNorm * (matrix.numFreqBins - 1))));

    for (let px = 0; px < plotW; px++) {
      const tFrac = px / Math.max(1, plotW - 1);
      const timeSec = viewRange.startSec + tFrac * (viewRange.endSec - viewRange.startSec);
      const tNorm = (timeSec - matrix.startSec) / totalT;
      const ti = Math.max(0, Math.min(matrix.numTimeBins - 1, Math.round(tNorm * (matrix.numTimeBins - 1))));

      const val = matrix.data[ti * matrix.numFreqBins + fi];
      const level = Math.max(
        0,
        Math.min(1, (val + display.gainDb - SPECTROGRAM_BASE_FLOOR_DB) / SPECTROGRAM_SPAN_DB),
      );
      const norm = floorNorm > 0 && level < floorNorm ? 0 : level;
      const lutIdx = Math.round(norm * 255) * 4;
      const dstIdx = (py * plotW + px) * 4;
      imgData.data[dstIdx] = lut[lutIdx];
      imgData.data[dstIdx + 1] = lut[lutIdx + 1];
      imgData.data[dstIdx + 2] = lut[lutIdx + 2];
      imgData.data[dstIdx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, leftPad, topY);
}

export function renderSpectrogramToCanvas(
  canvas: HTMLCanvasElement,
  matrix: SpectrogramMatrix,
  viewRange: TimeFreqRange,
  display: DisplaySettings,
  width = 1000,
  height = 460,
  matricesByChannel?: Record<number, SpectrogramMatrix | undefined>,
  displayedChannels?: number[],
): void {
  const splitRows = Math.max(1, Math.min(10, Math.round(display.splitTimeRows ?? 1)));
  const channels =
    displayedChannels && displayedChannels.length > 0 ? displayedChannels : [matrix.channel];
  const rowCount = splitRows * channels.length;
  const isMulti = rowCount > 1;

  const leftPad = display.showAxes ? 58 : 0;
  const rowBottomPad = display.showAxes ? (isMulti ? 20 : 28) : 0;
  const rowGap = isMulti ? 4 : 0;
  const plotW = Math.max(40, width - leftPad);

  const rowPlotH = isMulti
    ? Math.max(
        110,
        Math.floor((height - rowCount * rowBottomPad - (rowCount - 1) * rowGap) / rowCount),
      )
    : Math.max(40, height - rowBottomPad);
  const finalHeight = isMulti
    ? rowCount * (rowPlotH + rowBottomPad) + (rowCount - 1) * rowGap
    : height;

  canvas.width = width;
  canvas.height = finalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create offscreen 2D canvas');

  const isLight = display.colormap === 'grayscale_bow';
  ctx.fillStyle = isLight ? '#ffffff' : '#0f141b';
  ctx.fillRect(0, 0, width, finalHeight);

  const lut = buildColormapRGBA(display.colormap);
  const imgData = ctx.createImageData(plotW, rowPlotH);
  const spanT = Math.max(1e-6, viewRange.endSec - viewRange.startSec);

  let rowTop = 0;
  for (let r = 0; r < splitRows; r++) {
    const rStart = viewRange.startSec + (r / splitRows) * spanT;
    const rEnd = viewRange.startSec + ((r + 1) / splitRows) * spanT;

    for (const ch of channels) {
      const rowMat = matricesByChannel?.[ch] ?? matrix;
      const rowView: TimeFreqRange = {
        ...viewRange,
        startSec: rStart,
        endSec: rEnd,
      };
      if (rowMat && rowMat.numTimeBins > 0 && rowMat.numFreqBins > 0) {
        renderSingleRowIntoCanvas(
          ctx,
          imgData,
          rowMat,
          rowView,
          display,
          lut,
          leftPad,
          rowTop,
          plotW,
          rowPlotH,
        );
      }

      if (display.showAxes) {
        ctx.strokeStyle = isLight ? '#1e293b' : '#94a3b8';
        ctx.fillStyle = isLight ? '#0f172a' : '#e2e8f0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(leftPad + 0.5, rowTop);
        ctx.lineTo(leftPad + 0.5, rowTop + rowPlotH);
        ctx.lineTo(width, rowTop + rowPlotH + 0.5);
        ctx.stroke();

        ctx.font = '11px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const fSteps = isMulti ? 3 : 5;
        for (let i = 0; i <= fSteps; i++) {
          const f = viewRange.minFreqHz + (i / fSteps) * (viewRange.maxFreqHz - viewRange.minFreqHz);
          const y = rowTop + (1 - i / fSteps) * rowPlotH;
          const clampedY = Math.max(rowTop + 8, Math.min(rowTop + rowPlotH - 8, y));
          const label = f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`;
          ctx.fillText(label, leftPad - 6, clampedY);
        }

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const tSteps = 6;
        for (let i = 0; i <= tSteps; i++) {
          const t = rStart + (i / tSteps) * (rEnd - rStart);
          const x = leftPad + (i / tSteps) * plotW;
          const clampedX = Math.max(leftPad + 16, Math.min(width - 18, x));
          ctx.fillText(`${t.toFixed(2)}s`, clampedX, rowTop + rowPlotH + 4);
        }
      }

      if (isMulti) {
        const parts: string[] = [];
        if (channels.length > 1) parts.push(`Ch ${ch + 1}`);
        if (splitRows > 1) parts.push(`Row ${r + 1}/${splitRows}`);
        const tag = parts.join(' · ');
        if (tag) {
          ctx.font = 'bold 10px ui-monospace, monospace';
          const tw = ctx.measureText(tag).width;
          ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
          ctx.fillRect(leftPad + 6, rowTop + 5, tw + 10, 15);
          ctx.fillStyle = '#f8fafc';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(tag, leftPad + 11, rowTop + 12.5);
        }
      }

      rowTop += rowPlotH + rowBottomPad + rowGap;
    }
  }
}

export function renderSpectrogramPngBase64(
  matrix: SpectrogramMatrix,
  viewRange: TimeFreqRange,
  display: DisplaySettings,
  width = 960,
  height = 420,
): string | undefined {
  try {
    const canvas = document.createElement('canvas');
    renderSpectrogramToCanvas(canvas, matrix, viewRange, display, width, height);
    const dataUrl = canvas.toDataURL('image/png');
    const comma = dataUrl.indexOf(',');
    return comma >= 0 ? dataUrl.slice(comma + 1) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Renders a clean, cursor-free publication PNG of the active spectrogram (classic Syrinx
 * "Copy Bitmap of Current Window") and copies it to clipboard (with PNG download fallback).
 */
export async function copySpectrogramImageToClipboard(
  matrix: SpectrogramMatrix,
  viewRange: TimeFreqRange,
  display: DisplaySettings,
  title: string,
  width = 1000,
  height = 460,
  matricesByChannel?: Record<number, SpectrogramMatrix | undefined>,
  displayedChannels?: number[],
): Promise<'clipboard' | 'download'> {
  const canvas = document.createElement('canvas');
  renderSpectrogramToCanvas(
    canvas,
    matrix,
    viewRange,
    display,
    width,
    height,
    matricesByChannel,
    displayedChannels,
  );

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
  });

  try {
    if (navigator.clipboard && 'ClipboardItem' in window) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return 'clipboard';
    }
  } catch {
    // fallback to file download if clipboard permissions unavailable
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/\.[^.]+$/, '')}_spectrogram.png`;
  a.click();
  URL.revokeObjectURL(url);
  return 'download';
}
