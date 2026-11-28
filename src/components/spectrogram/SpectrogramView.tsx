import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnnotationRecord,
  AudioFileInfo,
  MDIWindowState,
  SelectionBox,
  SpectrogramMatrix,
} from '@syrinxone/shared';
import { getCachedSpectrogram, useWorkspaceStore } from '../../store/workspaceStore';
import { audioPlayer, type PlaybackState } from '../../audio/WebAudioPlayer';
import { copySpectrogramImageToClipboard } from '../../utils/exportImage';
import { isCombinedFileId } from '../../utils/combinedEngine';
import { fetchSpectrogramAdaptive } from '../../utils/spectrogramFetch';
import {
  buildRecordingTimeContext,
  formatAxisTickTime,
  formatRecordingRange,
  isLongRecording,
  resolveRecordingStartMs,
} from '../../utils/timeFormat';
import { WaveformCanvas } from './WaveformCanvas';
import {
  WebGLSpectrogramCanvas,
  type SpectrogramRenderRow,
} from './WebGLSpectrogramCanvas';

interface Props {
  win: MDIWindowState;
  file: AudioFileInfo;
  width: number;
  height: number;
}

const AXIS_LEFT = 54;
const AXIS_BOTTOM = 26;
const COMPACT_AXIS_BOTTOM = 18;
const SCROLLBAR_HEIGHT = 12;
const WAVEFORM_HEIGHT = 54;
const ROW_GAP = 4;
const CHANNEL_GAP = 2;
const HANDLE_RADIUS = 6;

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface ContextMenuState {
  x: number;
  y: number;
  rowChannel: number;
  annotation: AnnotationRecord | null;
}

interface RowLayout {
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

function computeNiceTicks(min: number, max: number, approxCount: number): number[] {
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

function getBoxHandles(
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

function applyHandleDrag(
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

export const SpectrogramView: React.FC<Props> = ({ win, file, width, height }) => {
  const engine = useWorkspaceStore((s) => s.engine);
  const specCache = useWorkspaceStore((s) => s.spectrogramCache);
  const waveformCache = useWorkspaceStore((s) => s.waveformCache);
  const annotations = useWorkspaceStore((s) => s.annotations);
  const selectedAnnotationId = useWorkspaceStore((s) => s.selectedAnnotationId);
  const redefineAnnotationId = useWorkspaceStore((s) => s.redefineAnnotationId);
  const annotationFilter = useWorkspaceStore((s) => s.annotationFilter);

  const updateWindowViewRange = useWorkspaceStore((s) => s.updateWindowViewRange);
  const resetWindowZoom = useWorkspaceStore((s) => s.resetWindowZoom);
  const updateWindowSelection = useWorkspaceStore((s) => s.updateWindowSelection);
  const updateAnnotation = useWorkspaceStore((s) => s.updateAnnotation);
  const deleteAnnotation = useWorkspaceStore((s) => s.deleteAnnotation);
  const selectAnnotation = useWorkspaceStore((s) => s.selectAnnotation);
  const setRedefineAnnotationId = useWorkspaceStore((s) => s.setRedefineAnnotationId);
  const logActiveSelection = useWorkspaceStore((s) => s.logActiveSelection);
  const stepFileInFolder = useWorkspaceStore((s) => s.stepFileInFolder);
  const duplicateWindow = useWorkspaceStore((s) => s.duplicateWindow);
  const setCursorReadout = useWorkspaceStore((s) => s.setCursorReadout);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const setStatus = useWorkspaceStore((s) => s.setStatus);
  const setError = useWorkspaceStore((s) => s.setError);
  const autoGainMode = useWorkspaceStore((s) => s.windowAutoGainMode[win.windowId] ?? 'manual');
  const autoGainWindow = useWorkspaceStore((s) => s.autoGainWindow);
  const touchMode = useWorkspaceStore((s) => s.touchMode);

  const [playback, setPlayback] = useState<PlaybackState>(() => audioPlayer.getState());
  const [cursorStyle, setCursorStyle] = useState<string>('crosshair');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [zoomMatrices, setZoomMatrices] = useState<Record<number, SpectrogramMatrix>>({});
  const zoomMatricesRef = useRef<Record<number, SpectrogramMatrix>>({});
  zoomMatricesRef.current = zoomMatrices;

  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const lastTapRef = useRef<number>(0);
  const pinchRef = useRef<{
    distX: number;
    distY: number;
    midX: number;
    midY: number;
    origRange: MDIWindowState['viewRange'];
    rowSpanT: number;
  } | null>(null);
  const dragModeRef = useRef<
    | { kind: 'select'; anchorRowIndex: number; channel: number; startT: number; startF: number }
    | {
        kind: 'pan';
        anchorRowIndex: number;
        startX: number;
        startY: number;
        origRange: MDIWindowState['viewRange'];
      }
    | {
        kind: 'scroll_outside';
        startX: number;
        startY: number;
        lastY: number;
        startScrollTop: number;
        origRange: MDIWindowState['viewRange'];
        zone: 'gutter' | 'wave' | 'axis';
      }
    | {
        kind: 'resize_sel';
        anchorRowIndex: number;
        handle: HandleId;
        orig: SelectionBox;
      }
    | {
        kind: 'resize_ann';
        anchorRowIndex: number;
        annId: string;
        handle: HandleId;
        orig: { startSec: number; endSec: number; lowFreqHz: number; highFreqHz: number };
      }
    | null
  >(null);

  useEffect(() => audioPlayer.subscribe(setPlayback), []);

  // Dismiss context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const splitTimeRows = Math.max(1, Math.min(10, Math.round(win.displaySettings.splitTimeRows ?? 1)));
  const stackChannels = Boolean(win.displaySettings.stackAllChannels) && file.numChannels > 1;
  const displayedChannels = useMemo(
    () =>
      stackChannels
        ? Array.from({ length: file.numChannels }, (_, idx) => idx)
        : [win.specParams.channel],
    [stackChannels, file.numChannels, win.specParams.channel],
  );
  const totalRows = splitTimeRows * displayedChannels.length;

  const primaryOverviewMatrix = getCachedSpectrogram(specCache, file.fileId, win.specParams);

  const spanT = Math.max(1e-6, win.viewRange.endSec - win.viewRange.startSec);
  const needsScrollbar =
    win.displaySettings.timeScaleMode === 'fixed' || spanT < file.durationSec - 0.005;

  useEffect(() => {
    setZoomMatrices({});
  }, [
    file.fileId,
    file.windowStartSec,
    file.durationSec,
    win.specParams.fftSize,
    win.specParams.hopSize,
    win.specParams.dspMode,
    win.specParams.windowType,
    win.specParams.popFilter,
  ]);

  // Automatically fetch sharper/high-resolution STFT slice(s) when zooming into a downsampled or sparse recording
  useEffect(() => {
    if (win.displaySettings.renderMode === 'server_bitmap') {
      setZoomMatrices({});
      return;
    }

    const nativeStep =
      Math.min(win.specParams.hopSize, win.specParams.fftSize) / Math.max(1, file.sampleRate);

    const channelsNeedingZoom: number[] = [];
    for (const ch of displayedChannels) {
      const ovMat = getCachedSpectrogram(specCache, file.fileId, {
        ...win.specParams,
        channel: ch,
      });
      if (!ovMat) continue;
      const isDownsampledOverview = ovMat.timeStepSec > nativeStep * 1.5;
      if (!isDownsampledOverview || spanT >= file.durationSec * 0.45) continue;

      const existing = zoomMatricesRef.current[ch];
      const existingCovers =
        existing &&
        existing.fileId === file.fileId &&
        existing.channel === ch &&
        existing.startSec <= win.viewRange.startSec + 0.01 &&
        existing.endSec >= win.viewRange.endSec - 0.01;
      const existingSpan = existing ? existing.endSec - existing.startSec : Infinity;
      const zoomedMuchCloser =
        existing &&
        existing.timeStepSec > nativeStep * 1.5 &&
        spanT < existingSpan * 0.35;

      if (existingCovers && !zoomedMuchCloser && existingSpan <= spanT * 2.5) {
        continue;
      }
      channelsNeedingZoom.push(ch);
    }

    if (channelsNeedingZoom.length === 0) {
      if (spanT >= file.durationSec * 0.45 && Object.keys(zoomMatricesRef.current).length > 0) {
        setZoomMatrices({});
      }
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const pad = spanT * 0.25;
      const reqStart = Math.max(0, win.viewRange.startSec - pad);
      const reqEnd = Math.min(file.durationSec, win.viewRange.endSec + pad);
      void Promise.all(
        channelsNeedingZoom.map(async (ch) => {
          const hiRes = await fetchSpectrogramAdaptive(
            engine,
            file,
            { ...win.specParams, channel: ch },
            { startSec: reqStart, endSec: reqEnd },
            undefined,
            {
              onProgress: (partial) => {
                if (cancelled) return;
                setZoomMatrices((prev) => ({ ...prev, [ch]: partial }));
              },
            },
          );
          return { ch, hiRes };
        }),
      )
        .then((items) => {
          if (cancelled) return;
          setZoomMatrices((prev) => {
            const next = { ...prev };
            for (const item of items) {
              next[item.ch] = item.hiRes;
            }
            return next;
          });
        })
        .catch(() => {
          // keep overview matrix cleanly if zoom fetch fails
        });
    }, 240);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    engine,
    file,
    specCache,
    displayedChannels,
    win.specParams,
    win.viewRange.startSec,
    win.viewRange.endSec,
    win.displaySettings.renderMode,
    spanT,
  ]);

  const activeMatricesByChannel = useMemo(() => {
    const out: Record<number, SpectrogramMatrix | undefined> = {};
    for (const ch of displayedChannels) {
      const zm = zoomMatrices[ch];
      const ov = getCachedSpectrogram(specCache, file.fileId, {
        ...win.specParams,
        channel: ch,
      });
      out[ch] =
        zm &&
        zm.fileId === file.fileId &&
        zm.channel === ch &&
        zm.startSec <= win.viewRange.startSec + 0.05 &&
        zm.endSec >= win.viewRange.endSec - 0.05
          ? zm
          : ov;
    }
    return out;
  }, [
    displayedChannels,
    zoomMatrices,
    specCache,
    file.fileId,
    win.specParams,
    win.viewRange.startSec,
    win.viewRange.endSec,
  ]);

  const primaryRenderMatrix =
    activeMatricesByChannel[win.specParams.channel] ??
    activeMatricesByChannel[displayedChannels[0]] ??
    primaryOverviewMatrix;

  // Keep Gain & Floor tuned to visible viewport when Auto Gain is enabled
  useEffect(() => {
    if (autoGainMode !== 'auto' || !primaryRenderMatrix) return;
    autoGainWindow(win.windowId, {
      scope: 'view',
      matrix: primaryRenderMatrix,
      silent: true,
    });
  }, [
    autoGainMode,
    primaryRenderMatrix,
    autoGainWindow,
    win.windowId,
    win.viewRange.startSec,
    win.viewRange.endSec,
    win.viewRange.minFreqHz,
    win.viewRange.maxFreqHz,
  ]);

  const timeCtx = useMemo(() => {
    const combinedSegs = isCombinedFileId(file.fileId)
      ? engine.getCombinedRecording(file.fileId)?.segments
      : undefined;
    return buildRecordingTimeContext(file, combinedSegs);
  }, [file, engine]);

  const showAxes = win.displaySettings.showAxes;
  const showWave = win.displaySettings.showWaveform;
  const leftPad = showAxes ? AXIS_LEFT : 0;
  const scrollH = needsScrollbar ? SCROLLBAR_HEIGHT : 0;
  const viewportH = Math.max(60, height - scrollH);

  // Compute single or stacked row layout geometry
  const { rows, stageW, stageH, plotW, isVertScrollable } = useMemo(() => {
    const isMulti = totalRows > 1;
    const chPerTimeGroup = Math.max(1, displayedChannels.length);
    const perRowWaveH = showWave
      ? isMulti
        ? totalRows <= 4
          ? 26
          : 20
        : WAVEFORM_HEIGHT
      : 0;
    const groupAxisBottomH = showAxes
      ? splitTimeRows > 1
        ? COMPACT_AXIS_BOTTOM
        : AXIS_BOTTOM
      : 0;

    const totalOverhead =
      totalRows * perRowWaveH +
      splitTimeRows * (groupAxisBottomH + (chPerTimeGroup - 1) * CHANNEL_GAP) +
      Math.max(0, splitTimeRows - 1) * ROW_GAP;

    let perRowPlotH: number;
    let totalStageH: number;
    if (!isMulti) {
      perRowPlotH = Math.max(40, viewportH - totalOverhead);
      totalStageH = viewportH;
    } else {
      const minPlotH = totalRows <= 3 ? 88 : totalRows <= 6 ? 68 : 56;
      const fitPlotH = Math.floor((viewportH - totalOverhead) / totalRows);
      perRowPlotH = Math.max(minPlotH, fitPlotH);
      totalStageH = Math.max(viewportH, totalRows * perRowPlotH + totalOverhead);
    }

    const vertScroll = totalStageH > viewportH + 1;
    const effectiveStageW = Math.max(80, vertScroll ? width - 10 : width);
    const effectivePlotW = Math.max(40, effectiveStageW - leftPad);

    const { startSec, minFreqHz, maxFreqHz } = win.viewRange;
    const windowOffsetSec = file.windowStartSec ?? 0;
    const totalDur = file.totalDurationSec ?? file.durationSec;

    const list: RowLayout[] = [];
    let cursorY = 0;

    for (let r = 0; r < splitTimeRows; r++) {
      const rStart = startSec + (r / splitTimeRows) * spanT;
      const rEnd = startSec + ((r + 1) / splitTimeRows) * spanT;
      const rangeFmt =
        splitTimeRows > 1
          ? formatRecordingRange(windowOffsetSec + rStart, windowOffsetSec + rEnd, totalDur, timeCtx)
          : null;

      for (let chIdx = 0; chIdx < displayedChannels.length; chIdx++) {
        const ch = displayedChannels[chIdx];
        const idx = list.length;
        const isLastInGroup = chIdx === displayedChannels.length - 1;
        const rowWaveH = perRowWaveH;
        const rowAxisBottomH = isLastInGroup ? groupAxisBottomH : 0;
        const gapAfter =
          idx === totalRows - 1 ? 0 : isLastInGroup ? ROW_GAP : CHANNEL_GAP;

        const rowTop = cursorY;
        const waveTop = rowTop;
        const plotTop = rowTop + rowWaveH;
        const rowBottom = plotTop + perRowPlotH + rowAxisBottomH;

        const parts: string[] = [];
        if (stackChannels) parts.push(`Ch ${ch + 1}`);
        if (splitTimeRows > 1 && rangeFmt) {
          parts.push(`#${r + 1}/${splitTimeRows} · ${rangeFmt.startLabel}–${rangeFmt.endLabel}`);
        }

        list.push({
          rowIndex: idx,
          timeRowIndex: r,
          channel: ch,
          startSec: rStart,
          endSec: rEnd,
          minFreqHz,
          maxFreqHz,
          rowTop,
          waveTop,
          waveH: rowWaveH,
          plotTop,
          plotH: perRowPlotH,
          axisBottomH: rowAxisBottomH,
          rowBottom,
          gapAfter,
          isChannelSeparator: !isLastInGroup,
          badgeText: parts.join(' · '),
        });

        cursorY = rowBottom + gapAfter;
      }
    }

    return {
      rows: list,
      stageW: effectiveStageW,
      stageH: totalStageH,
      plotW: effectivePlotW,
      isVertScrollable: vertScroll,
    };
  }, [
    totalRows,
    showWave,
    showAxes,
    viewportH,
    width,
    leftPad,
    win.viewRange,
    spanT,
    splitTimeRows,
    displayedChannels,
    stackChannels,
    file.windowStartSec,
    file.totalDurationSec,
    file.durationSec,
    timeCtx,
  ]);

  const visibleAnnotations = useMemo(() => {
    const fname = file.name.toLowerCase();
    return annotations.filter((a) => {
      if (a.soundfile && a.soundfile.toLowerCase() !== fname) return false;
      if (annotationFilter.channels.length > 0 && !annotationFilter.channels.includes(a.channel)) {
        return false;
      }
      if (annotationFilter.excludeEmpty && !a.comment.trim()) return false;
      if (annotationFilter.includeFilter && !a.comment.includes(annotationFilter.includeText)) {
        return false;
      }
      if (
        annotationFilter.excludeFilter &&
        annotationFilter.excludeText &&
        a.comment.includes(annotationFilter.excludeText)
      ) {
        return false;
      }
      return true;
    });
  }, [annotations, file.name, annotationFilter]);

  const hasChannelSelectionHighlight = Boolean(
    stackChannels && win.selection && win.displaySettings.showCursors,
  );
  const selectedChannelNum = win.selection?.channel;

  const webglRows: SpectrogramRenderRow[] = useMemo(() => {
    return rows.map((row) => {
      const mat = activeMatricesByChannel[row.channel];
      const rowView = {
        startSec: row.startSec,
        endSec: row.endSec,
        minFreqHz: row.minFreqHz,
        maxFreqHz: row.maxFreqHz,
      };
      const bitmapFallbackUrl =
        win.displaySettings.renderMode === 'server_bitmap'
          ? engine.getSpectrogramBitmapUrl(
              file.fileId,
              { ...win.specParams, channel: row.channel },
              win.displaySettings,
              rowView,
            )
          : undefined;
      return {
        key: `${row.rowIndex}-${row.channel}-${row.timeRowIndex}`,
        matrix: mat,
        viewRange: rowView,
        topPx: row.plotTop,
        heightPx: row.plotH,
        bitmapFallbackUrl,
      };
    });
  }, [
    rows,
    activeMatricesByChannel,
    win.displaySettings,
    win.specParams,
    engine,
    file.fileId,
  ]);

  const playheadSec =
    playback.isPlaying && playback.fileId === file.fileId ? playback.currentTimeSec : null;

  const { startSec, endSec, minFreqHz, maxFreqHz } = win.viewRange;
  const spanF = Math.max(1e-6, maxFreqHz - minFreqHz);

  const rowTimeToX = (row: RowLayout, t: number) =>
    leftPad + ((t - row.startSec) / Math.max(1e-6, row.endSec - row.startSec)) * plotW;

  const rowFreqToY = (row: RowLayout, f: number) =>
    row.plotTop + (1 - (f - row.minFreqHz) / Math.max(1e-6, row.maxFreqHz - row.minFreqHz)) * row.plotH;

  // Draw overlay: per-row axes, grid, annotations + handles, selection box + handles, playhead, row badges
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || stageW <= 0 || stageH <= 0) return;

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

    const windowOffsetSec = file.windowStartSec ?? 0;
    const startMs = resolveRecordingStartMs(timeCtx);
    const longRec = isLongRecording(file.totalDurationSec ?? file.durationSec, startMs);
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

          if (win.displaySettings.showGrid) {
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
          const x = rowTimeToX(row, t);
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

          if (win.displaySettings.showGrid) {
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

      if (win.displaySettings.showAnnotations && win.displaySettings.showCursors) {
        for (const ann of visibleAnnotations) {
          if (stackChannels && ann.channel && ann.channel !== row.channel + 1) continue;
          const relStart = ann.startTimeSec - windowOffsetSec;
          const relEnd = ann.endTimeSec - windowOffsetSec;
          if (relEnd < row.startSec || relStart > row.endSec) continue;

          const x0 = rowTimeToX(row, relStart);
          const x1 = rowTimeToX(row, relEnd);
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

      if (win.selection && win.displaySettings.showCursors) {
        const s = win.selection;
        const s0 = Math.min(s.startSec, s.endSec);
        const s1 = Math.max(s.startSec, s.endSec);
        const isSelectedChannel = !stackChannels || s.channel === row.channel + 1;
        if (s1 >= row.startSec && s0 <= row.endSec) {
          const x0 = rowTimeToX(row, s0);
          const x1 = rowTimeToX(row, s1);
          const yTop = rowFreqToY(row, Math.max(s.lowFreqHz, s.highFreqHz));
          const yBot = rowFreqToY(row, Math.min(s.lowFreqHz, s.highFreqHz));
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
        const px = rowTimeToX(row, playheadSec);
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
  }, [
    rows,
    stageW,
    stageH,
    leftPad,
    plotW,
    showAxes,
    win.displaySettings,
    win.selection,
    visibleAnnotations,
    selectedAnnotationId,
    playheadSec,
    stackChannels,
    file.windowStartSec,
    file.totalDurationSec,
    file.durationSec,
    timeCtx,
  ]);

  const findRowAtY = (rawY: number, anchorRowIndex?: number): RowLayout | null => {
    if (rows.length === 0) return null;
    if (anchorRowIndex !== undefined && rows[anchorRowIndex]) {
      return rows[anchorRowIndex];
    }
    for (const r of rows) {
      if (rawY >= r.rowTop && rawY <= r.rowBottom + r.gapAfter) {
        return r;
      }
    }
    if (rawY < rows[0].rowTop) return rows[0];
    return rows[rows.length - 1];
  };

  const coordsToRowTimeFreq = (clientX: number, clientY: number, anchorRowIndex?: number) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rows.length === 0) return null;
    const rawX = clientX - rect.left;
    const rawY = clientY - rect.top;
    const row = findRowAtY(rawY, anchorRowIndex);
    if (!row) return null;

    const x = rawX - leftPad;
    const y = rawY - row.plotTop;
    const tFrac = Math.max(0, Math.min(1, x / Math.max(1, plotW)));
    const fFrac = Math.max(0, Math.min(1, 1 - y / Math.max(1, row.plotH)));
    const rSpanT = Math.max(1e-6, row.endSec - row.startSec);
    const rSpanF = Math.max(1e-6, row.maxFreqHz - row.minFreqHz);
    const timeSec = row.startSec + tFrac * rSpanT;
    const freqHz = row.minFreqHz + fFrac * rSpanF;
    return {
      row,
      rawX,
      rawY,
      x,
      y,
      inPlot: x >= 0 && x <= plotW && y >= 0 && y <= row.plotH,
      timeSec,
      freqHz,
    };
  };

  const hitTestHandle = (
    rawX: number,
    rawY: number,
  ):
    | { target: 'sel'; rowIndex: number; handle: HandleId; cursor: string }
    | { target: 'ann'; rowIndex: number; ann: AnnotationRecord; handle: HandleId; cursor: string }
    | null => {
    if (!win.displaySettings.showCursors) return null;
    const row = findRowAtY(rawY);
    if (!row) return null;

    if (win.selection) {
      const s = win.selection;
      const channelMatch = !stackChannels || s.channel === row.channel + 1;
      const s0 = Math.min(s.startSec, s.endSec);
      const s1 = Math.max(s.startSec, s.endSec);
      if (channelMatch && s1 >= row.startSec && s0 <= row.endSec) {
        const x0 = rowTimeToX(row, s0);
        const x1 = rowTimeToX(row, s1);
        const yTop = rowFreqToY(row, Math.max(s.lowFreqHz, s.highFreqHz));
        const yBot = rowFreqToY(row, Math.min(s.lowFreqHz, s.highFreqHz));
        for (const h of getBoxHandles(x0, yTop, x1, yBot)) {
          if (Math.abs(rawX - h.x) <= HANDLE_RADIUS && Math.abs(rawY - h.y) <= HANDLE_RADIUS) {
            return { target: 'sel', rowIndex: row.rowIndex, handle: h.id, cursor: h.cursor };
          }
        }
      }
    }

    const winOff = file.windowStartSec ?? 0;
    const selAnn = visibleAnnotations.find((a) => a.id === selectedAnnotationId);
    if (
      selAnn &&
      win.displaySettings.showAnnotations &&
      (!stackChannels || !selAnn.channel || selAnn.channel === row.channel + 1)
    ) {
      const relStart = selAnn.startTimeSec - winOff;
      const relEnd = selAnn.endTimeSec - winOff;
      if (relEnd >= row.startSec && relStart <= row.endSec) {
        const x0 = rowTimeToX(row, relStart);
        const x1 = rowTimeToX(row, relEnd);
        const yTop = rowFreqToY(row, selAnn.highFreqHz);
        const yBot = rowFreqToY(row, selAnn.lowFreqHz);
        for (const h of getBoxHandles(x0, yTop, x1, yBot)) {
          if (Math.abs(rawX - h.x) <= HANDLE_RADIUS && Math.abs(rawY - h.y) <= HANDLE_RADIUS) {
            return {
              target: 'ann',
              rowIndex: row.rowIndex,
              ann: selAnn,
              handle: h.id,
              cursor: h.cursor,
            };
          }
        }
      }
    }
    return null;
  };

  const sampleMagnitudeAt = (
    channel: number,
    timeSec: number,
    freqHz: number,
  ): number | undefined => {
    const mat =
      activeMatricesByChannel[channel] ??
      getCachedSpectrogram(specCache, file.fileId, { ...win.specParams, channel });
    if (!mat || mat.numTimeBins === 0 || mat.numFreqBins === 0) return undefined;
    const tNorm = (timeSec - mat.startSec) / Math.max(1e-6, mat.endSec - mat.startSec);
    const fNorm = (freqHz - mat.minFreqHz) / Math.max(1e-6, mat.maxFreqHz - mat.minFreqHz);
    if (tNorm < 0 || tNorm > 1 || fNorm < 0 || fNorm > 1) return undefined;
    const ti = Math.min(mat.numTimeBins - 1, Math.max(0, Math.round(tNorm * (mat.numTimeBins - 1))));
    const fi = Math.min(mat.numFreqBins - 1, Math.max(0, Math.round(fNorm * (mat.numFreqBins - 1))));
    return mat.data[ti * mat.numFreqBins + fi];
  };

  const findAnnotationAt = (
    channel: number,
    timeSec: number,
    freqHz: number,
  ): AnnotationRecord | undefined => {
    const absTime = (file.windowStartSec ?? 0) + timeSec;
    return visibleAnnotations.find(
      (a) =>
        (!stackChannels || !a.channel || a.channel === channel + 1) &&
        absTime >= a.startTimeSec &&
        absTime <= a.endTimeSec &&
        freqHz >= a.lowFreqHz &&
        freqHz <= a.highFreqHz,
    );
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setContextMenu(null);
    const pt = coordsToRowTimeFreq(e.clientX, e.clientY);
    if (!pt || !pt.inPlot) return;

    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      e.preventDefault();
      dragModeRef.current = {
        kind: 'pan',
        anchorRowIndex: pt.row.rowIndex,
        startX: e.clientX,
        startY: e.clientY,
        origRange: { ...win.viewRange },
      };
      return;
    }

    if (e.button === 0) {
      const handleHit = hitTestHandle(pt.rawX, pt.rawY);
      if (handleHit) {
        e.preventDefault();
        if (handleHit.target === 'sel' && win.selection) {
          dragModeRef.current = {
            kind: 'resize_sel',
            anchorRowIndex: handleHit.rowIndex,
            handle: handleHit.handle,
            orig: {
              startSec: Math.min(win.selection.startSec, win.selection.endSec),
              endSec: Math.max(win.selection.startSec, win.selection.endSec),
              lowFreqHz: Math.min(win.selection.lowFreqHz, win.selection.highFreqHz),
              highFreqHz: Math.max(win.selection.lowFreqHz, win.selection.highFreqHz),
              channel: win.selection.channel,
            },
          };
          return;
        }
        if (handleHit.target === 'ann') {
          const winOff = file.windowStartSec ?? 0;
          dragModeRef.current = {
            kind: 'resize_ann',
            anchorRowIndex: handleHit.rowIndex,
            annId: handleHit.ann.id,
            handle: handleHit.handle,
            orig: {
              startSec: handleHit.ann.startTimeSec - winOff,
              endSec: handleHit.ann.endTimeSec - winOff,
              lowFreqHz: handleHit.ann.lowFreqHz,
              highFreqHz: handleHit.ann.highFreqHz,
            },
          };
          return;
        }
      }

      const hit = findAnnotationAt(pt.row.channel, pt.timeSec, pt.freqHz);
      if (hit && !e.altKey && !redefineAnnotationId) {
        selectAnnotation(hit.id, false);
      }
      dragModeRef.current = {
        kind: 'select',
        anchorRowIndex: pt.row.rowIndex,
        channel: pt.row.channel,
        startT: pt.timeSec,
        startF: pt.freqHz,
      };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const drag = dragModeRef.current;
    const pt = coordsToRowTimeFreq(
      e.clientX,
      e.clientY,
      drag && drag.kind !== 'scroll_outside' ? drag.anchorRowIndex : undefined,
    );

    if (pt && pt.inPlot) {
      setCursorReadout({
        timeSec: pt.timeSec,
        freqHz: pt.freqHz,
        valueDb: sampleMagnitudeAt(pt.row.channel, pt.timeSec, pt.freqHz),
        channel: pt.row.channel + 1,
      });
      if (!drag) {
        const hit = hitTestHandle(pt.rawX, pt.rawY);
        setCursorStyle(hit ? hit.cursor : 'crosshair');
      }
    }

    if (!drag || !pt) return;
    const nyquist = file.sampleRate / 2;

    if (drag.kind === 'select') {
      updateWindowSelection(win.windowId, {
        startSec: drag.startT,
        endSec: pt.timeSec,
        lowFreqHz: Math.min(drag.startF, pt.freqHz),
        highFreqHz: Math.max(drag.startF, pt.freqHz),
        channel: drag.channel + 1,
      });
    } else if (drag.kind === 'resize_sel') {
      const next = applyHandleDrag(drag.orig, drag.handle, pt.timeSec, pt.freqHz, file.durationSec, nyquist);
      updateWindowSelection(win.windowId, { ...next, channel: drag.orig.channel });
    } else if (drag.kind === 'resize_ann') {
      const next = applyHandleDrag(drag.orig, drag.handle, pt.timeSec, pt.freqHz, file.durationSec, nyquist);
      const winOff = file.windowStartSec ?? 0;
      updateAnnotation(drag.annId, {
        startTimeSec: winOff + next.startSec,
        endTimeSec: winOff + next.endSec,
        lowFreqHz: next.lowFreqHz,
        highFreqHz: next.highFreqHz,
      });
    } else if (drag.kind === 'pan') {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const orig = drag.origRange;
      const rowSpanT = (orig.endSec - orig.startSec) / splitTimeRows;
      const oSpanF = orig.maxFreqHz - orig.minFreqHz;
      const dt = (-dx / Math.max(1, plotW)) * rowSpanT;
      const df = (dy / Math.max(1, pt.row.plotH)) * oSpanF;

      let nextStartT = orig.startSec + dt;
      let nextEndT = orig.endSec + dt;
      if (nextStartT < 0) {
        nextEndT -= nextStartT;
        nextStartT = 0;
      }
      if (nextEndT > file.durationSec) {
        nextStartT = Math.max(0, nextStartT - (nextEndT - file.durationSec));
        nextEndT = file.durationSec;
      }

      let nextMinF = orig.minFreqHz + df;
      let nextMaxF = orig.maxFreqHz + df;
      if (nextMinF < 0) {
        nextMaxF -= nextMinF;
        nextMinF = 0;
      }
      if (nextMaxF > nyquist) {
        nextMinF = Math.max(0, nextMinF - (nextMaxF - nyquist));
        nextMaxF = nyquist;
      }

      updateWindowViewRange(win.windowId, {
        startSec: nextStartT,
        endSec: nextEndT,
        minFreqHz: nextMinF,
        maxFreqHz: nextMaxF,
      });
    }
  };

  const handleMouseUp = () => {
    const drag = dragModeRef.current;
    if (drag?.kind === 'select' && win.selection) {
      const s0 = Math.min(win.selection.startSec, win.selection.endSec);
      const s1 = Math.max(win.selection.startSec, win.selection.endSec);
      const f0 = Math.min(win.selection.lowFreqHz, win.selection.highFreqHz);
      const f1 = Math.max(win.selection.lowFreqHz, win.selection.highFreqHz);

      if (s1 - s0 < 0.002 && f1 - f0 < 10) {
        updateWindowSelection(win.windowId, null);
      } else if (redefineAnnotationId) {
        const winOff = file.windowStartSec ?? 0;
        updateAnnotation(redefineAnnotationId, {
          startTimeSec: winOff + s0,
          endTimeSec: winOff + s1,
          lowFreqHz: f0,
          highFreqHz: f1,
        });
        setRedefineAnnotationId(null);
        setStatus('Updated annotation box boundaries');
      }
    }
    dragModeRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent) => {
    const pt = coordsToRowTimeFreq(e.clientX, e.clientY);
    if (!pt) return;
    // Allow normal vertical wheel scrolling when mouse is outside plot gutter in multi-row scroll mode
    if (isVertScrollable && pt.x < 0 && !e.ctrlKey && !e.altKey) {
      return;
    }
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 0.8 : 1.25;
    const nyquist = file.sampleRate / 2;

    if (e.altKey) {
      const newSpanF = Math.max(100, Math.min(nyquist, spanF * zoomFactor));
      const frac = (pt.freqHz - minFreqHz) / spanF;
      const nextMin = Math.max(0, pt.freqHz - frac * newSpanF);
      const nextMax = Math.min(nyquist, nextMin + newSpanF);
      updateWindowViewRange(win.windowId, {
        ...win.viewRange,
        minFreqHz: nextMin,
        maxFreqHz: nextMax,
      });
    } else {
      const newSpanT = Math.max(0.02 * splitTimeRows, Math.min(file.durationSec, spanT * zoomFactor));
      const frac = (pt.timeSec - startSec) / spanT;
      const nextStart = Math.max(0, pt.timeSec - frac * newSpanT);
      const nextEnd = Math.min(file.durationSec, nextStart + newSpanT);
      updateWindowViewRange(win.windowId, {
        ...win.viewRange,
        startSec: nextStart,
        endSec: nextEnd,
      });
    }
  };

  const playRange = (s?: number, e?: number, ch?: number) => {
    void audioPlayer.play(engine, file.fileId, s, e, ch).catch((err) => {
      setError(err instanceof Error ? err.message : 'Unable to play audio');
    });
  };

  // Classic Syrinx: double-click plays annotation under cursor or the row/window view
  const handleDoubleClick = (e: React.MouseEvent) => {
    const pt = coordsToRowTimeFreq(e.clientX, e.clientY);
    if (!pt) return;
    const hit = findAnnotationAt(pt.row.channel, pt.timeSec, pt.freqHz);
    if (hit) {
      const winOff = file.windowStartSec ?? 0;
      selectAnnotation(hit.id, false);
      playRange(
        Math.max(0, hit.startTimeSec - winOff),
        Math.max(0.05, hit.endTimeSec - winOff),
        hit.channel ? Math.max(0, hit.channel - 1) : pt.row.channel,
      );
    } else if (splitTimeRows > 1) {
      playRange(pt.row.startSec, pt.row.endSec, pt.row.channel);
    } else {
      playRange(win.viewRange.startSec, win.viewRange.endSec, pt.row.channel);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const pt = coordsToRowTimeFreq(e.clientX, e.clientY);
    const hit = pt ? findAnnotationAt(pt.row.channel, pt.timeSec, pt.freqHz) ?? null : null;
    if (hit) selectAnnotation(hit.id, false);
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      rowChannel: pt?.row.channel ?? win.specParams.channel,
      annotation: hit,
    });
  };

  const handleCopyImage = async () => {
    if (!primaryRenderMatrix) return;
    try {
      const mode = await copySpectrogramImageToClipboard(
        primaryRenderMatrix,
        win.viewRange,
        win.displaySettings,
        file.name,
        Math.max(800, Math.round(plotW * 1.5)),
        Math.max(360, Math.round((rows[0]?.plotH ?? 300) * Math.min(4, rows.length) * 1.4)),
        activeMatricesByChannel,
        displayedChannels,
      );
      setStatus(
        mode === 'clipboard'
          ? 'Copied clean spectrogram PNG to clipboard'
          : 'Downloaded spectrogram PNG',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Image export failed');
    }
  };

  const handleExportMatrixTsv = async () => {
    try {
      const tsv = await engine.exportSpectrogramTsv(file.fileId, win.specParams, win.viewRange);
      const blob = new Blob([tsv], { type: 'text/tab-separated-values;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${file.name.replace(/\.[^.]+$/, '')}_spectrogram.tsv`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus('Exported spectrogram magnitude matrix (.tsv)');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'TSV export failed');
    }
  };

  const maxScrollStart = Math.max(0, file.durationSec - spanT);
  const nyquist = file.sampleRate / 2;

  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const [t0, t1] = [e.touches[0], e.touches[1]];
      dragModeRef.current = null;
      pinchRef.current = {
        distX: Math.max(12, Math.abs(t1.clientX - t0.clientX)),
        distY: Math.max(12, Math.abs(t1.clientY - t0.clientY)),
        midX: 0.5 * (t0.clientX + t1.clientX),
        midY: 0.5 * (t0.clientY + t1.clientY),
        origRange: { ...win.viewRange },
        rowSpanT: (win.viewRange.endSec - win.viewRange.startSec) / splitTimeRows,
      };
      return;
    }
    if (e.touches.length !== 1) return;

    const touch = e.touches[0];
    if (window.innerWidth <= 768 && (touch.clientX <= 16 || touch.clientX >= window.innerWidth - 16)) {
      return;
    }
    const pt = coordsToRowTimeFreq(touch.clientX, touch.clientY);

    // Outside the spectrogram plot area where cursors/selections are drawn:
    // allow scrolling (vertical across channels/containers + horizontal along time axes).
    if (!pt || !pt.inPlot) {
      lastTapRef.current = 0;
      const zone: 'gutter' | 'wave' | 'axis' =
        pt && pt.x < 0 ? 'gutter' : pt && pt.y < 0 ? 'wave' : 'axis';
      dragModeRef.current = {
        kind: 'scroll_outside',
        startX: touch.clientX,
        startY: touch.clientY,
        lastY: touch.clientY,
        startScrollTop: stageRef.current?.scrollTop ?? 0,
        origRange: { ...win.viewRange },
        zone,
      };
      return;
    }

    const now = Date.now();
    if (now - lastTapRef.current < 280) {
      lastTapRef.current = 0;
      if (win.selection) {
        playRange(
          Math.min(win.selection.startSec, win.selection.endSec),
          Math.max(win.selection.startSec, win.selection.endSec),
          Math.max(0, win.selection.channel - 1),
        );
      } else {
        playRange(startSec, endSec, pt.row.channel);
      }
      return;
    }
    lastTapRef.current = now;

    if (touchMode === 'pan') {
      dragModeRef.current = {
        kind: 'pan',
        anchorRowIndex: pt.row.rowIndex,
        startX: touch.clientX,
        startY: touch.clientY,
        origRange: { ...win.viewRange },
      };
    } else {
      dragModeRef.current = {
        kind: 'select',
        anchorRowIndex: pt.row.rowIndex,
        channel: pt.row.channel,
        startT: pt.timeSec,
        startF: pt.freqHz,
      };
      updateWindowSelection(win.windowId, {
        startSec: pt.timeSec,
        endSec: pt.timeSec,
        lowFreqHz: pt.freqHz,
        highFreqHz: pt.freqHz,
        channel: pt.row.channel + 1,
      });
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault();
      const [t0, t1] = [e.touches[0], e.touches[1]];
      const curDistX = Math.max(12, Math.abs(t1.clientX - t0.clientX));
      const curMidX = 0.5 * (t0.clientX + t1.clientX);
      const { distX, midX, origRange, rowSpanT } = pinchRef.current;

      const origSpanT = Math.max(0.02, origRange.endSec - origRange.startSec);
      const zoomFactor = Math.max(0.25, Math.min(4.0, distX / curDistX));
      const newSpanT = Math.max(0.02 * splitTimeRows, Math.min(file.durationSec, origSpanT * zoomFactor));
      const rect = overlayRef.current?.getBoundingClientRect();
      const anchorFrac = rect
        ? Math.max(0, Math.min(1, (midX - rect.left - leftPad) / plotW))
        : 0.5;
      const anchorT = origRange.startSec + anchorFrac * origSpanT;
      const panDt = ((midX - curMidX) / plotW) * (rowSpanT * zoomFactor);

      let ns = anchorT - anchorFrac * newSpanT + panDt;
      ns = Math.max(0, Math.min(Math.max(0, file.durationSec - newSpanT), ns));
      updateWindowViewRange(win.windowId, {
        ...origRange,
        startSec: ns,
        endSec: Math.min(file.durationSec, ns + newSpanT),
      });
      return;
    }

    if (e.touches.length !== 1 || !dragModeRef.current) return;
    e.preventDefault();
    const touch = e.touches[0];
    const mode = dragModeRef.current;

    if (mode.kind === 'scroll_outside') {
      const dx = touch.clientX - mode.startX;
      const dy = touch.clientY - mode.startY;
      const stepY = touch.clientY - mode.lastY;
      mode.lastY = touch.clientY;

      const orig = mode.origRange;
      const oSpanT = orig.endSec - orig.startSec;
      const canScrollHoriz =
        oSpanT < file.durationSec - 0.005 &&
        mode.zone !== 'gutter' &&
        Math.abs(dx) > Math.abs(dy) * 1.15 &&
        Math.abs(dx) > 6;

      if (canScrollHoriz) {
        const rowSpanT = oSpanT / splitTimeRows;
        const dt = -(dx / Math.max(1, plotW)) * rowSpanT;
        const ns = Math.max(0, Math.min(Math.max(0, file.durationSec - oSpanT), orig.startSec + dt));
        updateWindowViewRange(win.windowId, {
          ...orig,
          startSec: ns,
          endSec: Math.min(file.durationSec, ns + oSpanT),
        });
        return;
      }

      const stage = stageRef.current;
      let consumed = false;
      if (stage && stage.scrollHeight > stage.clientHeight + 1) {
        const maxTop = stage.scrollHeight - stage.clientHeight;
        const targetTop = Math.max(0, Math.min(maxTop, mode.startScrollTop - dy));
        if (Math.abs(targetTop - stage.scrollTop) >= 0.5) {
          stage.scrollTop = targetTop;
          consumed = true;
        }
      }
      if (!consumed && Math.abs(stepY) >= 0.5) {
        let el: HTMLElement | null = stage?.parentElement ?? null;
        while (el) {
          if (el.scrollHeight > el.clientHeight + 1) {
            const ov = window.getComputedStyle(el).overflowY;
            if (ov === 'auto' || ov === 'scroll') {
              const before = el.scrollTop;
              el.scrollTop = Math.max(
                0,
                Math.min(el.scrollHeight - el.clientHeight, before - stepY),
              );
              if (Math.abs(el.scrollTop - before) >= 0.5) {
                consumed = true;
                break;
              }
            }
          }
          el = el.parentElement;
        }
        if (!consumed) {
          window.scrollBy(0, -stepY);
        }
      }
      return;
    }

    const pt = coordsToRowTimeFreq(touch.clientX, touch.clientY, mode.anchorRowIndex);
    if (!pt) return;

    if (mode.kind === 'pan') {
      const orig = mode.origRange;
      const oSpanT = orig.endSec - orig.startSec;
      const rowSpanT = oSpanT / splitTimeRows;
      const oSpanF = orig.maxFreqHz - orig.minFreqHz;
      const dt = -((touch.clientX - mode.startX) / plotW) * rowSpanT;
      const df = ((touch.clientY - mode.startY) / Math.max(1, pt.row.plotH)) * oSpanF;
      const ns = Math.max(0, Math.min(Math.max(0, file.durationSec - oSpanT), orig.startSec + dt));
      const nf = Math.max(0, Math.min(Math.max(0, nyquist - oSpanF), orig.minFreqHz + df));
      updateWindowViewRange(win.windowId, {
        startSec: ns,
        endSec: Math.min(file.durationSec, ns + oSpanT),
        minFreqHz: nf,
        maxFreqHz: Math.min(nyquist, nf + oSpanF),
      });
    } else if (mode.kind === 'select') {
      updateWindowSelection(win.windowId, {
        startSec: Math.min(mode.startT, pt.timeSec),
        endSec: Math.max(mode.startT, pt.timeSec),
        lowFreqHz: Math.min(mode.startF, pt.freqHz),
        highFreqHz: Math.max(mode.startF, pt.freqHz),
        channel: mode.channel + 1,
      });
    }
  };

  const handleTouchEnd = () => {
    dragModeRef.current = null;
    pinchRef.current = null;
  };

  return (
    <div
      className="spec-view-root"
      style={{ position: 'relative', width: `${width}px`, height: `${height}px` }}
      onMouseLeave={() => {
        setCursorReadout(null);
        dragModeRef.current = null;
      }}
    >
      <div
        ref={stageRef}
        className="spec-rows-stage"
        style={{
          position: 'relative',
          width: `${width}px`,
          height: `${viewportH}px`,
          overflowY: isVertScrollable ? 'auto' : 'hidden',
          overflowX: 'hidden',
        }}
      >
        <div
          style={{
            position: 'relative',
            width: `${stageW}px`,
            height: `${stageH}px`,
            background: '#0b0f14',
          }}
        >
          <div style={{ position: 'absolute', left: leftPad, top: 0, zIndex: 1 }}>
            <WebGLSpectrogramCanvas
              rows={webglRows}
              displaySettings={win.displaySettings}
              width={plotW}
              height={stageH}
            />
          </div>

          {showWave &&
            rows.map((row) => {
              if (row.waveH <= 0) return null;
              const wf = waveformCache[`${file.fileId}|${row.channel}`];
              const rowSel = win.displaySettings.showCursors ? win.selection : null;
              return (
                <div
                  key={`wf-${row.rowIndex}`}
                  style={{ position: 'absolute', left: leftPad, top: row.waveTop, zIndex: 2 }}
                >
                  <WaveformCanvas
                    waveform={wf}
                    viewRange={{
                      startSec: row.startSec,
                      endSec: row.endSec,
                      minFreqHz: row.minFreqHz,
                      maxFreqHz: row.maxFreqHz,
                    }}
                    selection={rowSel}
                    playheadSec={playheadSec}
                    width={plotW}
                    height={row.waveH}
                  />
                </div>
              );
            })}

          <canvas
            ref={overlayRef}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: `${stageW}px`,
              height: `${stageH}px`,
              zIndex: 3,
              cursor: cursorStyle,
              touchAction: isVertScrollable && touchMode === 'pan' ? 'pan-y' : 'none',
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onWheel={handleWheel}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleContextMenu}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          />
        </div>
      </div>

      {needsScrollbar && (
        <div
          className="spec-scrollbar-wrap"
          style={{
            position: 'absolute',
            left: leftPad,
            bottom: 0,
            width: `${plotW}px`,
            height: `${scrollH}px`,
          }}
        >
          <input
            className="spec-scrollbar"
            type="range"
            min={0}
            max={maxScrollStart}
            step={Math.max(0.001, maxScrollStart / 500)}
            value={Math.min(maxScrollStart, startSec)}
            onChange={(e) => {
              const s = Number(e.target.value);
              updateWindowViewRange(win.windowId, {
                ...win.viewRange,
                startSec: s,
                endSec: Math.min(file.durationSec, s + spanT),
              });
            }}
            title={`Scroll time (${startSec.toFixed(2)}s – ${endSec.toFixed(2)}s of ${file.durationSec.toFixed(2)}s)`}
          />
        </div>
      )}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.annotation && (
            <>
              <div className="context-menu-label">
                Annotation: {contextMenu.annotation.comment || '(blank)'}
              </div>
              <button
                onClick={() => {
                  const a = contextMenu.annotation!;
                  const winOff = file.windowStartSec ?? 0;
                  playRange(
                    Math.max(0, a.startTimeSec - winOff),
                    Math.max(0.05, a.endTimeSec - winOff),
                    a.channel ? Math.max(0, a.channel - 1) : contextMenu.rowChannel,
                  );
                  setContextMenu(null);
                }}
              >
                Play Selected Annotation
              </button>
              <button
                onClick={() => {
                  const a = contextMenu.annotation!;
                  const next = window.prompt('Edit annotation comment:', a.comment);
                  if (next !== null) updateAnnotation(a.id, { comment: next });
                  setContextMenu(null);
                }}
              >
                Edit Annotation Comment...
              </button>
              <button
                onClick={() => {
                  setRedefineAnnotationId(contextMenu.annotation!.id);
                  setContextMenu(null);
                }}
              >
                Redefine Box on Next Drag
              </button>
              <button
                onClick={() => {
                  const a = contextMenu.annotation!;
                  updateWindowSelection(win.windowId, {
                    startSec: a.startTimeSec,
                    endSec: a.endTimeSec,
                    lowFreqHz: a.lowFreqHz,
                    highFreqHz: a.highFreqHz,
                    channel: a.channel,
                  });
                  setModalState('showKlipModal', true);
                  setContextMenu(null);
                }}
              >
                Clip &amp; Save Annotation...
              </button>
              <button
                className="danger"
                onClick={() => {
                  deleteAnnotation(contextMenu.annotation!.id);
                  setContextMenu(null);
                }}
              >
                Delete Annotation (Del)
              </button>
              <hr />
            </>
          )}

          <button
            onClick={() => {
              if (win.selection) {
                playRange(
                  Math.min(win.selection.startSec, win.selection.endSec),
                  Math.max(win.selection.startSec, win.selection.endSec),
                  Math.max(0, win.selection.channel - 1),
                );
              } else {
                playRange(startSec, endSec, contextMenu.rowChannel);
              }
              setContextMenu(null);
            }}
          >
            Play Selection / View (P)
          </button>

          {win.selection && (
            <>
              <button
                onClick={() => {
                  const s = win.selection!;
                  updateWindowViewRange(win.windowId, {
                    startSec: Math.min(s.startSec, s.endSec),
                    endSec: Math.max(s.startSec, s.endSec),
                    minFreqHz: Math.min(s.lowFreqHz, s.highFreqHz),
                    maxFreqHz: Math.max(s.lowFreqHz, s.highFreqHz),
                  });
                  setContextMenu(null);
                }}
              >
                Zoom to Selection
              </button>
              <button
                onClick={() => {
                  logActiveSelection('');
                  setContextMenu(null);
                }}
              >
                Log Selection as Annotation (Enter)
              </button>
              <button
                onClick={() => {
                  setModalState('showKlipModal', true);
                  setContextMenu(null);
                }}
              >
                Clip &amp; Save Selection (Ctrl+K)
              </button>
            </>
          )}

          <button
            onClick={() => {
              resetWindowZoom(win.windowId);
              setContextMenu(null);
            }}
          >
            Reset Full View (Ctrl+0)
          </button>
          <button
            onClick={() => {
              autoGainWindow(win.windowId, {
                scope: win.selection ? 'selection' : 'view',
                matrix: primaryRenderMatrix,
              });
              setContextMenu(null);
            }}
          >
            {win.selection ? 'Auto Gain (Selection)' : 'Auto Gain (View)'}
          </button>

          <hr />

          <button
            onClick={() => {
              void handleCopyImage();
              setContextMenu(null);
            }}
          >
            Copy Spectrogram Image (PNG)
          </button>
          <button
            onClick={() => {
              void handleExportMatrixTsv();
              setContextMenu(null);
            }}
          >
            Export Spectrogram Matrix (.tsv)
          </button>
          <button
            onClick={() => {
              setModalState('showDetectModal', true);
              setContextMenu(null);
            }}
          >
            Detect Sounds in Recording...
          </button>

          <hr />

          <button
            onClick={() => {
              void stepFileInFolder(win.windowId, -1);
              setContextMenu(null);
            }}
          >
            Previous File in Folder (Alt+←)
          </button>
          <button
            onClick={() => {
              void stepFileInFolder(win.windowId, 1);
              setContextMenu(null);
            }}
          >
            Next File in Folder (Alt+→)
          </button>
          <button
            onClick={() => {
              void duplicateWindow(win.windowId);
              setContextMenu(null);
            }}
          >
            Duplicate Window
          </button>
        </div>
      )}
    </div>
  );
};
