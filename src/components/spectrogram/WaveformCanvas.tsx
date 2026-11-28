import React, { useEffect, useRef } from 'react';
import type { SelectionBox, TimeFreqRange, WaveformOverview } from '@syrinxone/shared';

interface Props {
  waveform: WaveformOverview | undefined;
  viewRange: TimeFreqRange;
  selection: SelectionBox | null;
  playheadSec: number | null;
  muted?: boolean;
  width: number;
  height: number;
}

export const WaveformCanvas: React.FC<Props> = ({
  waveform,
  viewRange,
  selection,
  playheadSec,
  muted = false,
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
    ctx.fillStyle = muted ? '#0c1016' : '#0f151d';
    ctx.fillRect(0, 0, width, height);

    // Center zero line
    const midY = height / 2;
    ctx.strokeStyle = muted ? '#1c2431' : '#263447';
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
      ctx.fillStyle = muted ? 'rgba(56, 189, 248, 0.13)' : 'rgba(56, 189, 248, 0.26)';
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
    }

    if (waveform && waveform.numBins > 0) {
      const wfSpan = Math.max(1e-6, waveform.endSec - waveform.startSec);
      ctx.strokeStyle = muted ? '#4b6859' : '#9cffb8';
      ctx.lineWidth = 1;
      ctx.beginPath();

      const ampScale = height * 0.46;
      const lastBin = waveform.numBins - 1;
      const colCount = Math.max(1, Math.floor(width));

      for (let px = 0; px < colCount; px++) {
        const t0 = viewRange.startSec + (px / colCount) * spanT;
        const t1 = viewRange.startSec + ((px + 1) / colCount) * spanT;
        const b0 = Math.max(
          0,
          Math.min(lastBin, Math.floor(((t0 - waveform.startSec) / wfSpan) * lastBin)),
        );
        const b1 = Math.max(
          b0,
          Math.min(lastBin, Math.ceil(((t1 - waveform.startSec) / wfSpan) * lastBin)),
        );
        let vMax = -Infinity;
        let vMin = Infinity;
        for (let b = b0; b <= b1; b++) {
          if (waveform.maxValues[b] > vMax) vMax = waveform.maxValues[b];
          if (waveform.minValues[b] < vMin) vMin = waveform.minValues[b];
        }
        if (!Number.isFinite(vMax) || !Number.isFinite(vMin)) continue;
        let yMax = midY - vMax * ampScale;
        let yMin = midY - vMin * ampScale;
        if (yMin - yMax < 1) {
          const yc = 0.5 * (yMax + yMin);
          yMax = yc - 0.5;
          yMin = yc + 0.5;
        }
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
  }, [waveform, viewRange, selection, playheadSec, muted, width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: `${width}px`, height: `${height}px`, display: 'block' }}
    />
  );
};
