import type { DisplaySettings, SpectrogramMatrix, TimeFreqRange } from '@syrinxone/shared';
import { buildColormapRGBA } from '../components/spectrogram/colormaps';

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
): Promise<'clipboard' | 'download'> {
  const leftPad = display.showAxes ? 58 : 0;
  const bottomPad = display.showAxes ? 28 : 0;
  const plotW = Math.max(100, width - leftPad);
  const plotH = Math.max(80, height - bottomPad);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create offscreen 2D canvas');

  const isLight = display.colormap === 'grayscale_bow';
  ctx.fillStyle = isLight ? '#ffffff' : '#0f141b';
  ctx.fillRect(0, 0, width, height);

  // Render spectrogram pixels directly from Float32 matrix using the exact colormap LUT
  const imgData = ctx.createImageData(plotW, plotH);
  const lut = buildColormapRGBA(display.colormap);
  const dyn = Math.max(1, display.dynamicRangeDb);
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
      const norm = Math.max(0, Math.min(1, (val + display.gainDb - display.thresholdDb) / dyn));
      const lutIdx = Math.round(norm * 255) * 4;
      const dstIdx = (py * plotW + px) * 4;
      imgData.data[dstIdx] = lut[lutIdx];
      imgData.data[dstIdx + 1] = lut[lutIdx + 1];
      imgData.data[dstIdx + 2] = lut[lutIdx + 2];
      imgData.data[dstIdx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, leftPad, 0);

  if (display.showAxes) {
    ctx.strokeStyle = isLight ? '#1e293b' : '#94a3b8';
    ctx.fillStyle = isLight ? '#0f172a' : '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftPad + 0.5, 0);
    ctx.lineTo(leftPad + 0.5, plotH);
    ctx.lineTo(width, plotH + 0.5);
    ctx.stroke();

    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const fSteps = 5;
    for (let i = 0; i <= fSteps; i++) {
      const f = viewRange.minFreqHz + (i / fSteps) * (viewRange.maxFreqHz - viewRange.minFreqHz);
      const y = (1 - i / fSteps) * plotH;
      const clampedY = Math.max(8, Math.min(plotH - 8, y));
      const label = f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`;
      ctx.fillText(label, leftPad - 6, clampedY);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tSteps = 6;
    for (let i = 0; i <= tSteps; i++) {
      const t = viewRange.startSec + (i / tSteps) * (viewRange.endSec - viewRange.startSec);
      const x = leftPad + (i / tSteps) * plotW;
      const clampedX = Math.max(leftPad + 16, Math.min(width - 18, x));
      ctx.fillText(`${t.toFixed(2)}s`, clampedX, plotH + 6);
    }
  }

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
