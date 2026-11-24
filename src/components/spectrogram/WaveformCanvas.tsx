import React, { useEffect, useRef } from 'react';
import type { SelectionBox, TimeFreqRange, WaveformOverview } from '@syrinxone/shared';

interface Props {
  waveform: WaveformOverview | undefined;
  viewRange: TimeFreqRange;
  selection: SelectionBox | null;
  playheadSec: number | null;
  width: number;
  height: number;
}

export const WaveformCanvas: React.FC<Props> = ({
  waveform,
  viewRange,
  selection,
  playheadSec,
  width,
  height,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#11161d';
    ctx.fillRect(0, 0, width, height);

    // Center zero line
    const midY = height / 2;
    ctx.strokeStyle = '#253041';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    const spanT = Math.max(1e-6, viewRange.endSec - viewRange.startSec);

    // Selection highlight
    if (selection) {
      const x0 = ((Math.min(selection.startSec, selection.endSec) - viewRange.startSec) / spanT) * width;
      const x1 = ((Math.max(selection.startSec, selection.endSec) - viewRange.startSec) / spanT) * width;
      ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
    }

    if (waveform && waveform.numBins > 0) {
      const wfSpan = Math.max(1e-6, waveform.endSec - waveform.startSec);
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth = 1;
      ctx.beginPath();

      for (let px = 0; px < width; px++) {
        const t = viewRange.startSec + (px / Math.max(1, width - 1)) * spanT;
        const binFloat = ((t - waveform.startSec) / wfSpan) * (waveform.numBins - 1);
        const bin = Math.max(0, Math.min(waveform.numBins - 1, Math.round(binFloat)));
        const yMax = midY - waveform.maxValues[bin] * (height * 0.45);
        const yMin = midY - waveform.minValues[bin] * (height * 0.45);
        ctx.moveTo(px + 0.5, yMax);
        ctx.lineTo(px + 0.5, yMin);
      }
      ctx.stroke();
    }

    if (playheadSec !== null && playheadSec >= viewRange.startSec && playheadSec <= viewRange.endSec) {
      const x = ((playheadSec - viewRange.startSec) / spanT) * width;
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }, [waveform, viewRange, selection, playheadSec, width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: `${width}px`, height: `${height}px`, display: 'block' }}
    />
  );
};
