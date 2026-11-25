import React, { useEffect, useState } from 'react';
import { Activity, Plus, Sparkles } from 'lucide-react';
import type { SelectionMeasurements } from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { isCombinedFileId } from '../../utils/combinedEngine';
import {
  buildRecordingTimeContext,
  formatDurationCompact,
  formatRecordingTime,
  isLongRecording,
  resolveRecordingStartMs,
} from '../../utils/timeFormat';

export const MeasurementInspector: React.FC = () => {
  const engine = useWorkspaceStore((s) => s.engine);
  const windows = useWorkspaceStore((s) => s.windows);
  const activeWindowId = useWorkspaceStore((s) => s.activeWindowId);
  const files = useWorkspaceStore((s) => s.files);
  const logSelectionWithMeasurements = useWorkspaceStore((s) => s.logSelectionWithMeasurements);
  const setModalState = useWorkspaceStore((s) => s.setModalState);

  const activeWin = windows.find((w) => w.windowId === activeWindowId);
  const activeFile = activeWin ? files[activeWin.fileId] : undefined;
  const sel = activeWin?.selection ?? null;

  const [metrics, setMetrics] = useState<SelectionMeasurements | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!activeWin || !activeFile || !sel) {
      setMetrics(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setBusy(true);
      void engine
        .measureSelection(activeFile.fileId, {
          channel: activeWin.specParams.channel,
          startSec: Math.min(sel.startSec, sel.endSec),
          endSec: Math.max(sel.startSec, sel.endSec),
          lowFreqHz: Math.min(sel.lowFreqHz, sel.highFreqHz),
          highFreqHz: Math.max(sel.lowFreqHz, sel.highFreqHz),
          fftSize: activeWin.specParams.fftSize,
          hopSize: activeWin.specParams.hopSize,
        })
        .then((res) => {
          if (!cancelled) setMetrics(res);
        })
        .catch(() => {
          if (!cancelled) setMetrics(null);
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    engine,
    activeFile?.fileId,
    activeWin?.specParams.channel,
    activeWin?.specParams.fftSize,
    activeWin?.specParams.hopSize,
    sel?.startSec,
    sel?.endSec,
    sel?.lowFreqHz,
    sel?.highFreqHz,
  ]);

  if (!sel || !activeFile) {
    return (
      <div className="measure-card">
        <div className="measure-header">
          <Activity size={13} /> Selection Measurements
        </div>
        <div className="measure-empty">
          Drag a box on the spectrogram to inspect peak frequency, bandwidth, SNR, and dBFS metrics.
        </div>
      </div>
    );
  }

  return (
    <div className="measure-card">
      <div className="measure-header">
        <span>
          <Activity size={13} /> Selection Measurements
        </span>
        {busy && <span className="measure-busy">…</span>}
      </div>

      {metrics && (
        <>
          <div className="measure-grid mono">
            <div>
              <span>Peak Freq</span>
              <strong>{metrics.peakFreqHz.toFixed(1)} Hz</strong>
            </div>
            <div>
              <span>Centroid</span>
              <strong>{metrics.centroidFreqHz.toFixed(1)} Hz</strong>
            </div>
            <div>
              <span>BW 90%</span>
              <strong>{metrics.bw90Hz.toFixed(1)} Hz</strong>
            </div>
            <div>
              <span>Duration</span>
              <strong>
                {metrics.durationSec >= 120
                  ? formatDurationCompact(metrics.durationSec)
                  : `${metrics.durationSec.toFixed(3)} s`}
              </strong>
            </div>
            <div>
              <span>Q5 / Q50 / Q95</span>
              <strong>
                {Math.round(metrics.q5FreqHz)} / {Math.round(metrics.q50FreqHz)} /{' '}
                {Math.round(metrics.q95FreqHz)}
              </strong>
            </div>
            <div>
              <span>Est. SNR</span>
              <strong>{metrics.snrDb.toFixed(1)} dB</strong>
            </div>
            <div>
              <span>RMS / Peak</span>
              <strong>
                {metrics.rmsDb.toFixed(1)} / {metrics.peakDb.toFixed(1)} dBFS
              </strong>
            </div>
            <div>
              <span>Time of Peak</span>
              <strong>
                {(() => {
                  const segs = isCombinedFileId(activeFile.fileId)
                    ? engine.getCombinedRecording(activeFile.fileId)?.segments
                    : undefined;
                  const ctx = buildRecordingTimeContext(activeFile, segs);
                  const totalDur = activeFile.totalDurationSec ?? activeFile.durationSec;
                  const startMs = resolveRecordingStartMs(ctx);
                  const absPeak = (activeFile.windowStartSec ?? 0) + metrics.timeOfPeakSec;
                  if (isLongRecording(totalDur, startMs) || (activeFile.windowStartSec ?? 0) > 0) {
                    return formatRecordingTime(absPeak, ctx, { fractionalDigits: 2 });
                  }
                  return `${metrics.timeOfPeakSec.toFixed(3)} s`;
                })()}
              </strong>
            </div>
          </div>

          <div className="panel-btn-row" style={{ marginTop: 6 }}>
            <button
              className="btn-small btn-primary"
              onClick={() => logSelectionWithMeasurements(metrics, '')}
              title="Save selection as annotation with spectral measurements stored in extra fields"
            >
              <Plus size={12} /> Log + Metrics
            </button>
            <button
              className="btn-small"
              onClick={() => setModalState('showAiPanel', true)}
              title="Open AI Bioacoustic Explorer on this selection"
            >
              <Sparkles size={12} /> Ask AI
            </button>
          </div>
        </>
      )}
    </div>
  );
};
