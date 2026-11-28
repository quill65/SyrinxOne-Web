import type { AnnotationRecord, DisplaySettings, SelectionBox } from '@syrinxone/shared';
import {
  formatAxisTickTime,
  isLongRecording,
  resolveRecordingStartMs,
  type RecordingTimeContext,
} from '../../utils/timeFormat';

export const AXIS_LEFT = 54;
export const AXIS_BOTTOM = 26;
export const COMPACT_AXIS_BOTTOM = 18;
export const SCROLLBAR_HEIGHT = 12;
export const WAVEFORM_HEIGHT = 54;
export const ROW_GAP = 4;
export const CHANNEL_GAP = 2;
export const HANDLE_RADIUS = 6;

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface RowLayout {
  rowIndex: number;
  timeRowIndex: number;
  channel: number;
  startSec: number;
  endSec: number;
  minFreqHz: number;
  maxFreqHz: number;
  rowTop: number;
  waveTop: number;
  waveH: number;
  plotTop: number;
  plotH: number;
  axisBottomH: number;
  rowBottom: number;
  gapAfter: number;
  isChannelSeparator: boolean;
  badgeText: string;
}

export function computeNiceTicks(min: number, max: number, approxCount: number): number[] {
  const span = max - min;
  if (span <= 0 || !Number.isFinite(span)) return [];
  const rawStep = span / Math.max(2, approxCount);
  const pow10 = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / pow10;
  let nice = 1;
  if (norm >= 5) nice = 5;
  else if (norm >= 2) nice = 2;
  const step = nice * pow10;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    ticks.push(v);
    if (ticks.length > 40) break;
  }
  return ticks;
}

export function getBoxHandles(
  x0: number,
  yTop: number,
  x1: number,
  yBot: number,
): Array<{ id: HandleId; x: number; y: number; cursor: string }> {
  const xm = 0.5 * (x0 + x1);
  const ym = 0.5 * (yTop + yBot);
  return [
    { id: 'nw', x: x0, y: yTop, cursor: 'nwse-resize' },
    { id: 'n', x: xm, y: yTop, cursor: 'ns-resize' },
    { id: 'ne', x: x1, y: yTop, cursor: 'nesw-resize' },
    { id: 'e', x: x1, y: ym, cursor: 'ew-resize' },
    { id: 'se', x: x1, y: yBot, cursor: 'nwse-resize' },
    { id: 's', x: xm, y: yBot, cursor: 'ns-resize' },
    { id: 'sw', x: x0, y: yBot, cursor: 'nesw-resize' },
    { id: 'w', x: x0, y: ym, cursor: 'ew-resize' },
  ];
}

export function applyHandleDrag(
  orig: { startSec: number; endSec: number; lowFreqHz: number; highFreqHz: number },
  handle: HandleId,
  t: number,
  f: number,
  maxDur: number,
  nyquist: number,
): { startSec: number; endSec: number; lowFreqHz: number; highFreqHz: number } {
  let s = orig.startSec;
  let e = orig.endSec;
  let lo = orig.lowFreqHz;
  let hi = orig.highFreqHz;

  const ct = Math.max(0, Math.min(maxDur, t));
  const cf = Math.max(0, Math.min(nyquist, f));

  if (handle.includes('w')) s = Math.min(e - 0.002, ct);
  if (handle.includes('e')) e = Math.max(s + 0.002, ct);
  if (handle.includes('n')) hi = Math.max(lo + 10, cf);
  if (handle.includes('s')) lo = Math.min(hi - 10, cf);
  return { startSec: s, endSec: e, lowFreqHz: lo, highFreqHz: hi };
}

export function rowTimeToX(row: RowLayout, t: number, leftPad: number, plotW: number): number {
  return leftPad + ((t - row.startSec) / Math.max(1e-6, row.endSec - row.startSec)) * plotW;
}

export function rowFreqToY(row: RowLayout, f: number): number {
  return (
    row.plotTop +
    (1 - (f - row.minFreqHz) / Math.max(1e-6, row.maxFreqHz - row.minFreqHz)) * row.plotH
  );
}

export interface DrawSpectrogramOverlayParams {
  canvas: HTMLCanvasElement;
  rows: RowLayout[];
  stageW: number;
  stageH: number;
  leftPad: number;
  plotW: number;
  showAxes: boolean;
  displaySettings: DisplaySettings;
  selection: SelectionBox | null;
  visibleAnnotations: AnnotationRecord[];
  selectedAnnotationId: string | null;
  playheadSec: number | null;
  stackChannels: boolean;
  windowOffsetSec: number;
  totalDurationSec: number;
  timeCtx: RecordingTimeContext;
  hasChannelSelectionHighlight: boolean;
  selectedChannelNum: number | undefined;
}

export function drawSpectrogramOverlay({
  canvas,
  rows,
  stageW,
  stageH,
  leftPad,
  plotW,
  showAxes,
  displaySettings,
  selection,
  visibleAnnotations,
  selectedAnnotationId,
  playheadSec,
  stackChannels,
  windowOffsetSec,
  totalDurationSec,
  timeCtx,
  hasChannelSelectionHighlight,
  selectedChannelNum,
}: DrawSpectrogramOverlayParams): void {
  if (stageW <= 0 || stageH <= 0) return;

  const baseDpr = window.devicePixelRatio || 1;
  const effDpr = Math.min(baseDpr, 4096 / Math.max(1, stageH), 4096 / Math.max(1, stageW));
  const pxW = Math.max(1, Math.round(stageW * effDpr));
  const pxH = Math.max(1, Math.round(stageH * effDpr));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(pxW / stageW, 0, 0, pxH / stageH, 0, 0);
  ctx.clearRect(0, 0, stageW, stageH);

  const startMs = resolveRecordingStartMs(timeCtx);
  const longRec = isLongRecording(totalDurationSec, startMs);
  const tickSpacing = longRec ? (startMs !== null ? 116 : 98) : 80;
  const edgePad = longRec ? 36 : 20;
  const isMulti = rows.length > 1;

  for (const row of rows) {
    const rSpanT = Math.max(1e-6, row.endSec - row.startSec);

    if (showAxes) {
      ctx.fillStyle = '#0f141b';
      ctx.fillRect(0, row.rowTop, leftPad, row.rowBottom + row.gapAfter - row.rowTop);
      if (row.axisBottomH > 0) {
        ctx.fillRect(0, row.plotTop + row.plotH, stageW, row.axisBottomH);
      }

      ctx.strokeStyle = '#293548';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(leftPad + 0.5, row.rowTop);
      ctx.lineTo(leftPad + 0.5, row.plotTop + row.plotH);
      if (row.axisBottomH > 0) {
        ctx.lineTo(stageW, row.plotTop + row.plotH + 0.5);
      }
      ctx.stroke();

      const fTicks = computeNiceTicks(
        row.minFreqHz,
        row.maxFreqHz,
        Math.max(2, Math.floor(row.plotH / (isMulti ? 36 : 42))),
      );
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      for (const f of fTicks) {
        const y = rowFreqToY(row, f);
        if (y < row.plotTop + 7 || y > row.plotTop + row.plotH - 7) continue;
        const label = f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`;
        ctx.fillText(label, leftPad - 6, y);
        ctx.strokeStyle = '#475569';
        ctx.beginPath();
        ctx.moveTo(leftPad - 4, y);
        ctx.lineTo(leftPad, y);
        ctx.stroke();

        if (displaySettings.showGrid) {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
          ctx.beginPath();
          ctx.moveTo(leftPad, y);
          ctx.lineTo(leftPad + plotW, y);
          ctx.stroke();
        }
      }

      const tTicks = computeNiceTicks(row.startSec, row.endSec, Math.floor(plotW / tickSpacing));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const labelTopY = row.plotTop + row.plotH + (row.axisBottomH <= COMPACT_AXIS_BOTTOM ? 3 : 6);
      for (const t of tTicks) {
        const x = rowTimeToX(row, t, leftPad, plotW);
        if (x < leftPad + edgePad || x > stageW - edgePad) continue;

        if (row.axisBottomH > 0) {
          ctx.fillStyle = '#94a3b8';
          const label = formatAxisTickTime(windowOffsetSec + t, rSpanT, timeCtx);
          ctx.fillText(label, x, labelTopY);
          ctx.strokeStyle = '#475569';
          ctx.beginPath();
          ctx.moveTo(x, row.plotTop + row.plotH);
          ctx.lineTo(x, row.plotTop + row.plotH + 3);
          ctx.stroke();
        }

        if (displaySettings.showGrid) {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
          ctx.beginPath();
          ctx.moveTo(x, row.plotTop);
          ctx.lineTo(x, row.plotTop + row.plotH);
          ctx.stroke();
        }
      }
    }

    // Clip to this row's plot rectangle
    ctx.save();
    ctx.beginPath();
    ctx.rect(leftPad, row.plotTop, plotW, row.plotH);
    ctx.clip();

    if (displaySettings.showAnnotations && displaySettings.showCursors) {
      for (const ann of visibleAnnotations) {
        if (stackChannels && ann.channel && ann.channel !== row.channel + 1) continue;
        const relStart = ann.startTimeSec - windowOffsetSec;
        const relEnd = ann.endTimeSec - windowOffsetSec;
        if (relEnd < row.startSec || relStart > row.endSec) continue;

        const x0 = rowTimeToX(row, relStart, leftPad, plotW);
        const x1 = rowTimeToX(row, relEnd, leftPad, plotW);
        const yTop = rowFreqToY(row, ann.highFreqHz);
        const yBot = rowFreqToY(row, ann.lowFreqHz);
        const isSel = ann.id === selectedAnnotationId;

        ctx.strokeStyle = isSel ? '#f59e0b' : '#22c55e';
        ctx.fillStyle = isSel ? 'rgba(245, 158, 11, 0.18)' : 'rgba(34, 197, 94, 0.12)';
        ctx.lineWidth = isSel ? 2 : 1.25;
        ctx.fillRect(x0, yTop, Math.max(2, x1 - x0), Math.max(2, yBot - yTop));
        ctx.strokeRect(x0, yTop, Math.max(2, x1 - x0), Math.max(2, yBot - yTop));

        if (ann.comment) {
          ctx.font = 'bold 11px system-ui, sans-serif';
          const textW = ctx.measureText(ann.comment).width;
          const labelY = Math.max(row.plotTop + 13, yTop - 3);
          ctx.fillStyle = isSel ? 'rgba(180, 83, 9, 0.92)' : 'rgba(15, 23, 42, 0.82)';
          ctx.fillRect(x0, labelY - 12, textW + 8, 14);
          ctx.fillStyle = '#f8fafc';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(ann.comment, x0 + 4, labelY);
        }

        if (isSel) {
          ctx.fillStyle = '#fbbf24';
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1;
          for (const h of getBoxHandles(x0, yTop, x1, yBot)) {
            ctx.fillRect(h.x - 3, h.y - 3, 6, 6);
            ctx.strokeRect(h.x - 3, h.y - 3, 6, 6);
          }
        }
      }
    }

    if (selection && displaySettings.showCursors) {
      const s0 = Math.min(selection.startSec, selection.endSec);
      const s1 = Math.max(selection.startSec, selection.endSec);
      const isSelectedChannel = !stackChannels || selection.channel === row.channel + 1;
      if (s1 >= row.startSec && s0 <= row.endSec) {
        const x0 = rowTimeToX(row, s0, leftPad, plotW);
        const x1 = rowTimeToX(row, s1, leftPad, plotW);
        const yTop = rowFreqToY(row, Math.max(selection.lowFreqHz, selection.highFreqHz));
        const yBot = rowFreqToY(row, Math.min(selection.lowFreqHz, selection.highFreqHz));
        ctx.fillStyle = isSelectedChannel
          ? 'rgba(56, 189, 248, 0.16)'
          : 'rgba(56, 189, 248, 0.10)';
        ctx.strokeStyle = isSelectedChannel ? '#38bdf8' : 'rgba(56, 189, 248, 0.85)';
        ctx.lineWidth = isSelectedChannel ? 1.5 : 1.25;
        ctx.setLineDash([4, 3]);
        ctx.fillRect(x0, yTop, Math.max(2, x1 - x0), Math.max(2, yBot - yTop));
        ctx.strokeRect(x0, yTop, Math.max(2, x1 - x0), Math.max(2, yBot - yTop));
        ctx.setLineDash([]);

        if (isSelectedChannel) {
          ctx.fillStyle = '#38bdf8';
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1;
          for (const h of getBoxHandles(x0, yTop, x1, yBot)) {
            ctx.fillRect(h.x - 3, h.y - 3, 6, 6);
            ctx.strokeRect(h.x - 3, h.y - 3, 6, 6);
          }
        }
      }
    }

    if (playheadSec !== null && playheadSec >= row.startSec && playheadSec <= row.endSec) {
      const px = rowTimeToX(row, playheadSec, leftPad, plotW);
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, row.plotTop);
      ctx.lineTo(px, row.plotTop + row.plotH);
      ctx.stroke();
    }

    // Row identification badge when viewing split time rows or stacked channels
    if (isMulti && row.badgeText) {
      const isActiveRow =
        hasChannelSelectionHighlight && selectedChannelNum === row.channel + 1;
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      const padX = 5;
      const textW = ctx.measureText(row.badgeText).width;
      const boxW = Math.min(plotW - 12, textW + padX * 2);
      const bx = leftPad + 5;
      const by = row.plotTop + 4;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
      ctx.strokeStyle = isActiveRow
        ? 'rgba(56, 189, 248, 0.9)'
        : 'rgba(71, 85, 105, 0.75)';
      ctx.lineWidth = 1;
      ctx.fillRect(bx, by, boxW, 15);
      ctx.strokeRect(bx, by, boxW, 15);
      ctx.fillStyle = isActiveRow ? '#bae6fd' : '#e2e8f0';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(row.badgeText, bx + padX, by + 7.5, Math.max(10, boxW - padX * 2));
    }

    ctx.restore();

    // Subtle border between a channel's waveform strip and spectrogram plot
    if (row.waveH > 0) {
      ctx.strokeStyle = '#263244';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(leftPad, row.plotTop + 0.5);
      ctx.lineTo(stageW, row.plotTop + 0.5);
      ctx.stroke();
    }

    // Inter-row separator line (narrow 1px divider between stacked channels)
    if (row.gapAfter > 0) {
      const sepY = row.rowBottom + row.gapAfter / 2;
      ctx.fillStyle = '#0b1017';
      ctx.fillRect(leftPad, row.rowBottom, plotW, row.gapAfter);
      ctx.strokeStyle = row.isChannelSeparator ? '#334155' : '#1e293b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, sepY);
      ctx.lineTo(stageW, sepY);
      ctx.stroke();
    }
  }
}
