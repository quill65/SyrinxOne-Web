import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AnnotationRecord, AudioFileInfo, MDIWindowState, SelectionBox } from '@syrinxone/shared';
import { getCachedSpectrogram, useWorkspaceStore } from '../../store/workspaceStore';
import { audioPlayer, type PlaybackState } from '../../audio/WebAudioPlayer';
import { copySpectrogramImageToClipboard } from '../../utils/exportImage';
import { WaveformCanvas } from './WaveformCanvas';
import { WebGLSpectrogramCanvas } from './WebGLSpectrogramCanvas';

interface Props {
  win: MDIWindowState;
  file: AudioFileInfo;
  width: number;
  height: number;
}

const AXIS_LEFT = 54;
const AXIS_BOTTOM = 26;
const SCROLLBAR_HEIGHT = 12;
const WAVEFORM_HEIGHT = 54;
const HANDLE_RADIUS = 6;

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface ContextMenuState {
  x: number;
  y: number;
  annotation: AnnotationRecord | null;
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

  const [playback, setPlayback] = useState<PlaybackState>(() => audioPlayer.getState());
  const [cursorStyle, setCursorStyle] = useState<string>('crosshair');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [touchMode, setTouchMode] = useState<'select' | 'pan'>('select');

  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const lastTapRef = useRef<number>(0);
  const pinchRef = useRef<{
    distX: number;
    distY: number;
    midX: number;
    midY: number;
    origRange: MDIWindowState['viewRange'];
  } | null>(null);
  const dragModeRef = useRef<
    | { kind: 'select'; startT: number; startF: number }
    | { kind: 'pan'; startX: number; startY: number; origRange: MDIWindowState['viewRange'] }
    | {
        kind: 'resize_sel';
        handle: HandleId;
        orig: SelectionBox;
      }
    | {
        kind: 'resize_ann';
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

  const matrix = getCachedSpectrogram(specCache, file.fileId, win.specParams);
  const waveform = waveformCache[`${file.fileId}|${win.specParams.channel}`];

  const spanT = Math.max(1e-6, win.viewRange.endSec - win.viewRange.startSec);
  const needsScrollbar =
    win.displaySettings.timeScaleMode === 'fixed' || spanT < file.durationSec - 0.005;

  const showAxes = win.displaySettings.showAxes;
  const showWave = win.displaySettings.showWaveform;
  const leftPad = showAxes ? AXIS_LEFT : 0;
  const scrollH = needsScrollbar ? SCROLLBAR_HEIGHT : 0;
  const bottomPad = (showAxes ? AXIS_BOTTOM : 0) + scrollH;
  const waveH = showWave ? WAVEFORM_HEIGHT : 0;
  const plotW = Math.max(40, width - leftPad);
  const plotH = Math.max(40, height - bottomPad - waveH);

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

  const bitmapFallbackUrl = useMemo(() => {
    if (win.displaySettings.renderMode !== 'server_bitmap') return undefined;
    return engine.getSpectrogramBitmapUrl(
      file.fileId,
      win.specParams,
      win.displaySettings,
      win.viewRange,
    );
  }, [engine, file.fileId, win.specParams, win.displaySettings, win.viewRange]);

  const playheadSec =
    playback.isPlaying && playback.fileId === file.fileId ? playback.currentTimeSec : null;

  const { startSec, endSec, minFreqHz, maxFreqHz } = win.viewRange;
  const spanF = Math.max(1e-6, maxFreqHz - minFreqHz);
  const timeToX = (t: number) => leftPad + ((t - startSec) / spanT) * plotW;
  const freqToY = (f: number) => waveH + (1 - (f - minFreqHz) / spanF) * plotH;

  // Draw overlay: axes, grid, annotations + handles, selection box + handles, playhead
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    if (showAxes) {
      ctx.fillStyle = '#0f141b';
      ctx.fillRect(0, 0, leftPad, height - scrollH);
      ctx.fillRect(0, waveH + plotH, width, AXIS_BOTTOM);
      ctx.strokeStyle = '#293548';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(leftPad + 0.5, 0);
      ctx.lineTo(leftPad + 0.5, waveH + plotH);
      ctx.lineTo(width, waveH + plotH + 0.5);
      ctx.stroke();

      const fTicks = computeNiceTicks(minFreqHz, maxFreqHz, Math.floor(plotH / 42));
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const f of fTicks) {
        const y = freqToY(f);
        if (y < waveH + 6 || y > waveH + plotH - 6) continue;
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

      const tTicks = computeNiceTicks(startSec, endSec, Math.floor(plotW / 75));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const t of tTicks) {
        const x = timeToX(t);
        if (x < leftPad + 16 || x > width - 16) continue;
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(`${t.toFixed(spanT < 2 ? 2 : 1)}s`, x, waveH + plotH + 6);
        ctx.strokeStyle = '#475569';
        ctx.beginPath();
        ctx.moveTo(x, waveH + plotH);
        ctx.lineTo(x, waveH + plotH + 4);
        ctx.stroke();

        if (win.displaySettings.showGrid) {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
          ctx.beginPath();
          ctx.moveTo(x, waveH);
          ctx.lineTo(x, waveH + plotH);
          ctx.stroke();
        }
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(leftPad, waveH, plotW, plotH);
    ctx.clip();

    if (win.displaySettings.showAnnotations && win.displaySettings.showCursors) {
      for (const ann of visibleAnnotations) {
        const x0 = timeToX(ann.startTimeSec);
        const x1 = timeToX(ann.endTimeSec);
        const yTop = freqToY(ann.highFreqHz);
        const yBot = freqToY(ann.lowFreqHz);
        const isSel = ann.id === selectedAnnotationId;

        ctx.strokeStyle = isSel ? '#f59e0b' : '#22c55e';
        ctx.fillStyle = isSel ? 'rgba(245, 158, 11, 0.18)' : 'rgba(34, 197, 94, 0.12)';
        ctx.lineWidth = isSel ? 2 : 1.25;
        ctx.fillRect(x0, yTop, Math.max(2, x1 - x0), Math.max(2, yBot - yTop));
        ctx.strokeRect(x0, yTop, Math.max(2, x1 - x0), Math.max(2, yBot - yTop));

        if (ann.comment) {
          ctx.font = 'bold 11px system-ui, sans-serif';
          const textW = ctx.measureText(ann.comment).width;
          const labelY = Math.max(waveH + 13, yTop - 3);
          ctx.fillStyle = isSel ? 'rgba(180, 83, 9, 0.92)' : 'rgba(15, 23, 42, 0.82)';
          ctx.fillRect(x0, labelY - 12, textW + 8, 14);
          ctx.fillStyle = '#f8fafc';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(ann.comment, x0 + 4, labelY);
        }

        // Draw 8 resize handles on the selected annotation box
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
      const x0 = timeToX(Math.min(s.startSec, s.endSec));
      const x1 = timeToX(Math.max(s.startSec, s.endSec));
      const yTop = freqToY(Math.max(s.lowFreqHz, s.highFreqHz));
      const yBot = freqToY(Math.min(s.lowFreqHz, s.highFreqHz));
      ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(x0, yTop, Math.max(2, x1 - x0), Math.max(2, yBot - yTop));
      ctx.strokeRect(x0, yTop, Math.max(2, x1 - x0), Math.max(2, yBot - yTop));
      ctx.setLineDash([]);

      // Draw 8 resize handles on the active selection box
      ctx.fillStyle = '#38bdf8';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1;
      for (const h of getBoxHandles(x0, yTop, x1, yBot)) {
        ctx.fillRect(h.x - 3, h.y - 3, 6, 6);
        ctx.strokeRect(h.x - 3, h.y - 3, 6, 6);
      }
    }

    if (playheadSec !== null) {
      const px = timeToX(playheadSec);
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, waveH);
      ctx.lineTo(px, waveH + plotH);
      ctx.stroke();
    }

    ctx.restore();
  }, [
    width,
    height,
    leftPad,
    scrollH,
    waveH,
    plotW,
    plotH,
    showAxes,
    win.viewRange,
    win.displaySettings,
    win.selection,
    visibleAnnotations,
    selectedAnnotationId,
    playheadSec,
  ]);

  const coordsToTimeFreq = (clientX: number, clientY: number) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const rawX = clientX - rect.left;
    const rawY = clientY - rect.top;
    const x = rawX - leftPad;
    const y = rawY - waveH;
    const tFrac = Math.max(0, Math.min(1, x / Math.max(1, plotW)));
    const fFrac = Math.max(0, Math.min(1, 1 - y / Math.max(1, plotH)));
    const timeSec = startSec + tFrac * spanT;
    const freqHz = minFreqHz + fFrac * spanF;
    return { rawX, rawY, x, y, timeSec, freqHz };
  };

  const hitTestHandle = (
    rawX: number,
    rawY: number,
  ):
    | { target: 'sel'; handle: HandleId; cursor: string }
    | { target: 'ann'; ann: AnnotationRecord; handle: HandleId; cursor: string }
    | null => {
    if (!win.displaySettings.showCursors) return null;
    if (win.selection) {
      const s = win.selection;
      const x0 = timeToX(Math.min(s.startSec, s.endSec));
      const x1 = timeToX(Math.max(s.startSec, s.endSec));
      const yTop = freqToY(Math.max(s.lowFreqHz, s.highFreqHz));
      const yBot = freqToY(Math.min(s.lowFreqHz, s.highFreqHz));
      for (const h of getBoxHandles(x0, yTop, x1, yBot)) {
        if (Math.abs(rawX - h.x) <= HANDLE_RADIUS && Math.abs(rawY - h.y) <= HANDLE_RADIUS) {
          return { target: 'sel', handle: h.id, cursor: h.cursor };
        }
      }
    }
    const selAnn = visibleAnnotations.find((a) => a.id === selectedAnnotationId);
    if (selAnn && win.displaySettings.showAnnotations) {
      const x0 = timeToX(selAnn.startTimeSec);
      const x1 = timeToX(selAnn.endTimeSec);
      const yTop = freqToY(selAnn.highFreqHz);
      const yBot = freqToY(selAnn.lowFreqHz);
      for (const h of getBoxHandles(x0, yTop, x1, yBot)) {
        if (Math.abs(rawX - h.x) <= HANDLE_RADIUS && Math.abs(rawY - h.y) <= HANDLE_RADIUS) {
          return { target: 'ann', ann: selAnn, handle: h.id, cursor: h.cursor };
        }
      }
    }
    return null;
  };

  const sampleMagnitudeAt = (timeSec: number, freqHz: number): number | undefined => {
    if (!matrix || matrix.numTimeBins === 0 || matrix.numFreqBins === 0) return undefined;
    const tNorm = (timeSec - matrix.startSec) / Math.max(1e-6, matrix.endSec - matrix.startSec);
    const fNorm = (freqHz - matrix.minFreqHz) / Math.max(1e-6, matrix.maxFreqHz - matrix.minFreqHz);
    if (tNorm < 0 || tNorm > 1 || fNorm < 0 || fNorm > 1) return undefined;
    const ti = Math.min(matrix.numTimeBins - 1, Math.max(0, Math.round(tNorm * (matrix.numTimeBins - 1))));
    const fi = Math.min(matrix.numFreqBins - 1, Math.max(0, Math.round(fNorm * (matrix.numFreqBins - 1))));
    return matrix.data[ti * matrix.numFreqBins + fi];
  };

  const findAnnotationAt = (timeSec: number, freqHz: number): AnnotationRecord | undefined => {
    return visibleAnnotations.find(
      (a) =>
        timeSec >= a.startTimeSec &&
        timeSec <= a.endTimeSec &&
        freqHz >= a.lowFreqHz &&
        freqHz <= a.highFreqHz,
    );
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setContextMenu(null);
    const pt = coordsToTimeFreq(e.clientX, e.clientY);
    if (!pt || pt.x < 0 || pt.y < 0 || pt.x > plotW || pt.y > plotH) return;

    // Middle click or Shift+Left drag pans
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      e.preventDefault();
      dragModeRef.current = {
        kind: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        origRange: { ...win.viewRange },
      };
      return;
    }

    if (e.button === 0) {
      // Check draggable resize handles on selection or selected annotation
      const handleHit = hitTestHandle(pt.rawX, pt.rawY);
      if (handleHit) {
        e.preventDefault();
        if (handleHit.target === 'sel' && win.selection) {
          dragModeRef.current = {
            kind: 'resize_sel',
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
          dragModeRef.current = {
            kind: 'resize_ann',
            annId: handleHit.ann.id,
            handle: handleHit.handle,
            orig: {
              startSec: handleHit.ann.startTimeSec,
              endSec: handleHit.ann.endTimeSec,
              lowFreqHz: handleHit.ann.lowFreqHz,
              highFreqHz: handleHit.ann.highFreqHz,
            },
          };
          return;
        }
      }

      const hit = findAnnotationAt(pt.timeSec, pt.freqHz);
      if (hit && !e.altKey && !redefineAnnotationId) {
        selectAnnotation(hit.id, false);
      }
      dragModeRef.current = {
        kind: 'select',
        startT: pt.timeSec,
        startF: pt.freqHz,
      };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const pt = coordsToTimeFreq(e.clientX, e.clientY);
    if (pt && pt.x >= 0 && pt.x <= plotW && pt.y >= 0 && pt.y <= plotH) {
      setCursorReadout({
        timeSec: pt.timeSec,
        freqHz: pt.freqHz,
        valueDb: sampleMagnitudeAt(pt.timeSec, pt.freqHz),
        channel: win.specParams.channel + 1,
      });
      if (!dragModeRef.current) {
        const hit = hitTestHandle(pt.rawX, pt.rawY);
        setCursorStyle(hit ? hit.cursor : 'crosshair');
      }
    }

    const drag = dragModeRef.current;
    if (!drag || !pt) return;
    const nyquist = file.sampleRate / 2;

    if (drag.kind === 'select') {
      updateWindowSelection(win.windowId, {
        startSec: drag.startT,
        endSec: pt.timeSec,
        lowFreqHz: Math.min(drag.startF, pt.freqHz),
        highFreqHz: Math.max(drag.startF, pt.freqHz),
        channel: win.specParams.channel + 1,
      });
    } else if (drag.kind === 'resize_sel') {
      const next = applyHandleDrag(drag.orig, drag.handle, pt.timeSec, pt.freqHz, file.durationSec, nyquist);
      updateWindowSelection(win.windowId, { ...next, channel: drag.orig.channel });
    } else if (drag.kind === 'resize_ann') {
      const next = applyHandleDrag(drag.orig, drag.handle, pt.timeSec, pt.freqHz, file.durationSec, nyquist);
      updateAnnotation(drag.annId, {
        startTimeSec: next.startSec,
        endTimeSec: next.endSec,
        lowFreqHz: next.lowFreqHz,
        highFreqHz: next.highFreqHz,
      });
    } else if (drag.kind === 'pan') {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const orig = drag.origRange;
      const oSpanT = orig.endSec - orig.startSec;
      const oSpanF = orig.maxFreqHz - orig.minFreqHz;
      const dt = (-dx / Math.max(1, plotW)) * oSpanT;
      const df = (dy / Math.max(1, plotH)) * oSpanF;

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
        updateAnnotation(redefineAnnotationId, {
          startTimeSec: s0,
          endTimeSec: s1,
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
    e.preventDefault();
    const pt = coordsToTimeFreq(e.clientX, e.clientY);
    if (!pt) return;
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
      const newSpanT = Math.max(0.02, Math.min(file.durationSec, spanT * zoomFactor));
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

  // Classic Syrinx: double-click plays annotation under cursor or the file
  const handleDoubleClick = (e: React.MouseEvent) => {
    const pt = coordsToTimeFreq(e.clientX, e.clientY);
    if (!pt) return;
    const hit = findAnnotationAt(pt.timeSec, pt.freqHz);
    if (hit) {
      selectAnnotation(hit.id, false);
      void audioPlayer.play(engine, file.fileId, hit.startTimeSec, hit.endTimeSec);
    } else {
      void audioPlayer.play(engine, file.fileId, win.viewRange.startSec, win.viewRange.endSec);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const pt = coordsToTimeFreq(e.clientX, e.clientY);
    const hit = pt ? findAnnotationAt(pt.timeSec, pt.freqHz) ?? null : null;
    if (hit) selectAnnotation(hit.id, false);
    setContextMenu({ x: e.clientX, y: e.clientY, annotation: hit });
  };

  const handleCopyImage = async () => {
    if (!matrix) return;
    try {
      const mode = await copySpectrogramImageToClipboard(
        matrix,
        win.viewRange,
        win.displaySettings,
        file.name,
        Math.max(800, Math.round(plotW * 1.5)),
        Math.max(360, Math.round(plotH * 1.5)),
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

  const clientToPlot = (clientX: number, clientY: number) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    const x = rect ? clientX - rect.left : 0;
    const y = rect ? clientY - rect.top : 0;
    const t = Math.max(0, Math.min(file.durationSec, startSec + ((x - leftPad) / plotW) * spanT));
    const f = Math.max(
      0,
      Math.min(nyquist, minFreqHz + (1 - (y - waveH) / plotH) * spanF),
    );
    return { x, y, t, f };
  };

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
      };
      return;
    }
    if (e.touches.length !== 1) return;

    const now = Date.now();
    if (now - lastTapRef.current < 280) {
      lastTapRef.current = 0;
      if (win.selection) {
        void audioPlayer.play(
          engine,
          file.fileId,
          Math.min(win.selection.startSec, win.selection.endSec),
          Math.max(win.selection.startSec, win.selection.endSec),
        );
      } else {
        void audioPlayer.play(engine, file.fileId, startSec, endSec);
      }
      return;
    }
    lastTapRef.current = now;

    const touch = e.touches[0];
    const { x, y, t, f } = clientToPlot(touch.clientX, touch.clientY);
    if (x < leftPad || y < waveH || y > waveH + plotH) return;

    if (touchMode === 'pan') {
      dragModeRef.current = {
        kind: 'pan',
        startX: touch.clientX,
        startY: touch.clientY,
        origRange: { ...win.viewRange },
      };
    } else {
      dragModeRef.current = { kind: 'select', startT: t, startF: f };
      updateWindowSelection(win.windowId, {
        startSec: t,
        endSec: t,
        lowFreqHz: f,
        highFreqHz: f,
        channel: win.specParams.channel + 1,
      });
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault();
      const [t0, t1] = [e.touches[0], e.touches[1]];
      const curDistX = Math.max(12, Math.abs(t1.clientX - t0.clientX));
      const curMidX = 0.5 * (t0.clientX + t1.clientX);
      const { distX, midX, origRange } = pinchRef.current;

      const origSpanT = Math.max(0.02, origRange.endSec - origRange.startSec);
      const zoomFactor = Math.max(0.25, Math.min(4.0, distX / curDistX));
      const newSpanT = Math.max(0.02, Math.min(file.durationSec, origSpanT * zoomFactor));
      const rect = overlayRef.current?.getBoundingClientRect();
      const anchorFrac = rect
        ? Math.max(0, Math.min(1, (midX - rect.left - leftPad) / plotW))
        : 0.5;
      const anchorT = origRange.startSec + anchorFrac * origSpanT;
      const panDt = ((midX - curMidX) / plotW) * newSpanT;

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
    if (mode.kind === 'pan') {
      const orig = mode.origRange;
      const oSpanT = orig.endSec - orig.startSec;
      const oSpanF = orig.maxFreqHz - orig.minFreqHz;
      const dt = -((touch.clientX - mode.startX) / plotW) * oSpanT;
      const df = ((touch.clientY - mode.startY) / plotH) * oSpanF;
      const ns = Math.max(0, Math.min(Math.max(0, file.durationSec - oSpanT), orig.startSec + dt));
      const nf = Math.max(0, Math.min(Math.max(0, nyquist - oSpanF), orig.minFreqHz + df));
      updateWindowViewRange(win.windowId, {
        startSec: ns,
        endSec: Math.min(file.durationSec, ns + oSpanT),
        minFreqHz: nf,
        maxFreqHz: Math.min(nyquist, nf + oSpanF),
      });
    } else if (mode.kind === 'select') {
      const { t, f } = clientToPlot(touch.clientX, touch.clientY);
      updateWindowSelection(win.windowId, {
        startSec: Math.min(mode.startT, t),
        endSec: Math.max(mode.startT, t),
        lowFreqHz: Math.min(mode.startF, f),
        highFreqHz: Math.max(mode.startF, f),
        channel: win.specParams.channel + 1,
      });
    }
  };

  const handleTouchEnd = () => {
    dragModeRef.current = null;
    pinchRef.current = null;
  };

  const zoomTimeBy = (factor: number) => {
    const mid = 0.5 * (startSec + endSec);
    const nextSpan = Math.max(0.02, Math.min(file.durationSec, spanT * factor));
    const ns = Math.max(0, Math.min(Math.max(0, file.durationSec - nextSpan), mid - nextSpan / 2));
    updateWindowViewRange(win.windowId, {
      ...win.viewRange,
      startSec: ns,
      endSec: Math.min(file.durationSec, ns + nextSpan),
    });
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
      {showWave && (
        <div style={{ position: 'absolute', left: leftPad, top: 0 }}>
          <WaveformCanvas
            waveform={waveform}
            viewRange={win.viewRange}
            selection={win.displaySettings.showCursors ? win.selection : null}
            playheadSec={playheadSec}
            width={plotW}
            height={waveH}
          />
        </div>
      )}

      <div style={{ position: 'absolute', left: leftPad, top: waveH }}>
        <WebGLSpectrogramCanvas
          matrix={matrix}
          viewRange={win.viewRange}
          displaySettings={win.displaySettings}
          bitmapFallbackUrl={bitmapFallbackUrl}
          width={plotW}
          height={plotH}
        />
      </div>

      <canvas
        ref={overlayRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: `${width}px`,
          height: `${height - scrollH}px`,
          cursor: cursorStyle,
          touchAction: 'none',
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

      <div className="mobile-touch-hud">
        <button
          className={`btn-small ${touchMode === 'select' ? 'btn-active' : ''}`}
          onClick={() => setTouchMode('select')}
        >
          Select
        </button>
        <button
          className={`btn-small ${touchMode === 'pan' ? 'btn-active' : ''}`}
          onClick={() => setTouchMode('pan')}
        >
          Pan
        </button>
        <button className="btn-small" onClick={() => zoomTimeBy(0.6)} title="Zoom in">
          +
        </button>
        <button className="btn-small" onClick={() => zoomTimeBy(1.6)} title="Zoom out">
          −
        </button>
        <button className="btn-small" onClick={() => resetWindowZoom(win.windowId)} title="Reset zoom">
          Fit
        </button>
        {win.selection && (
          <button
            className="btn-small btn-primary"
            onClick={() => logActiveSelection('')}
            title="Log current selection"
          >
            +Log
          </button>
        )}
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
                  void audioPlayer.play(engine, file.fileId, a.startTimeSec, a.endTimeSec);
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
                void audioPlayer.play(
                  engine,
                  file.fileId,
                  Math.min(win.selection.startSec, win.selection.endSec),
                  Math.max(win.selection.startSec, win.selection.endSec),
                );
              } else {
                void audioPlayer.play(engine, file.fileId, startSec, endSec);
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
