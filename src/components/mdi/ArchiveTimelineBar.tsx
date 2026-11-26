import React, { useEffect, useMemo, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Clock, Search } from 'lucide-react';
import type { AudioFileInfo, MDIWindowState } from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { isCombinedFileId } from '../../utils/combinedEngine';
import {
  formatDurationCompact,
  getSafeMaxWindowSec,
} from '../../utils/spectrogramFetch';
import {
  buildRecordingTimeContext,
  dateMsToRecordingOffset,
  formatDateTimeLocalInput,
  formatRecordingRange,
  formatRecordingTime,
  parseIsoWallClockUtcMs,
  parseTimeOrDateInput,
  recordingOffsetToDateMs,
  resolveRecordingStartMs,
} from '../../utils/timeFormat';

interface Props {
  win: MDIWindowState;
  file: AudioFileInfo;
}

const PRESET_DURATIONS = [
  { sec: 60, label: '1 min' },
  { sec: 300, label: '5 min' },
  { sec: 900, label: '15 min' },
  { sec: 1800, label: '30 min' },
  { sec: 3600, label: '1 hour' },
  { sec: 10800, label: '3 hours' },
  { sec: 21600, label: '6 hours' },
  { sec: 28800, label: '8 hours' },
];

export const ArchiveTimelineBar: React.FC<Props> = ({ win, file }) => {
  const engine = useWorkspaceStore((s) => s.engine);
  const windowCombinedSegments = useWorkspaceStore((s) => s.windowCombinedSegments);
  const shiftArchiveWindow = useWorkspaceStore((s) => s.shiftArchiveWindow);
  const setArchiveWindow = useWorkspaceStore((s) => s.setArchiveWindow);

  const curStart = file.windowStartSec ?? 0;
  const curLen = Math.max(5, Math.round(file.durationSec));
  const totalDur = Math.max(curStart + curLen, file.totalDurationSec ?? file.durationSec);
  const maxStart = Math.max(0, totalDur - curLen);
  const safeMax = getSafeMaxWindowSec(file.sampleRate, file.numChannels);

  const isCombined = isCombinedFileId(file.fileId);
  const combinedRec = isCombined ? engine.getCombinedRecording(file.fileId) : undefined;
  const activeSegments = isCombined ? engine.getActiveSegmentsInWindow(file.fileId) : [];
  const totalSegCount = combinedRec?.segments.length ?? windowCombinedSegments[win.windowId]?.length ?? 0;

  const timeCtx = useMemo(
    () => buildRecordingTimeContext(file, combinedRec?.segments),
    [file, combinedRec?.segments],
  );
  const startMs = useMemo(() => resolveRecordingStartMs(timeCtx), [timeCtx]);

  const [scrubStart, setScrubStart] = useState<number | null>(null);
  const [jumpInput, setJumpInput] = useState<string>(() => formatRecordingTime(curStart, timeCtx));
  const [showMobileJump, setShowMobileJump] = useState(false);

  useEffect(() => {
    setScrubStart(null);
    setJumpInput(formatRecordingTime(curStart, timeCtx));
  }, [file.fileId, curStart, timeCtx]);

  const effectiveStart = scrubStart ?? curStart;
  const rangeFmt = useMemo(
    () =>
      formatRecordingRange(
        effectiveStart,
        Math.min(totalDur, effectiveStart + curLen),
        totalDur,
        timeCtx,
      ),
    [effectiveStart, curLen, totalDur, timeCtx],
  );

  const pickerBounds = useMemo(() => {
    if (startMs === null || !rangeFmt.isDated) return null;
    const minMs = recordingOffsetToDateMs(0, timeCtx) ?? startMs;
    const maxMs = recordingOffsetToDateMs(maxStart, timeCtx) ?? startMs + maxStart * 1000;
    const curMs = recordingOffsetToDateMs(effectiveStart, timeCtx) ?? startMs + effectiveStart * 1000;
    return {
      min: formatDateTimeLocalInput(minMs),
      max: formatDateTimeLocalInput(Math.max(minMs, maxMs)),
      value: formatDateTimeLocalInput(curMs),
    };
  }, [startMs, rangeFmt.isDated, timeCtx, maxStart, effectiveStart]);

  const isFullTimeline = !file.isPartialWindow && curLen >= totalDur - 1;

  const lengthOptions = useMemo(() => {
    const valid = PRESET_DURATIONS.filter((p) => p.sec <= Math.min(totalDur, safeMax));
    if (valid.length === 0) {
      valid.push({
        sec: Math.min(60, Math.round(totalDur)),
        label: formatDurationCompact(Math.min(60, totalDur)),
      });
    }
    if (!isFullTimeline && !valid.some((p) => Math.abs(p.sec - curLen) <= 2)) {
      valid.push({ sec: curLen, label: formatDurationCompact(curLen) });
      valid.sort((a, b) => a.sec - b.sec);
    }
    const fullSec = Math.max(1, Math.round(totalDur));
    if (isCombined && (totalDur > safeMax || totalSegCount > 1)) {
      valid.push({ sec: fullSec, label: `Full (${formatDurationCompact(totalDur)} · Sparse)` });
    }
    return valid;
  }, [totalDur, safeMax, curLen, isFullTimeline, isCombined, totalSegCount]);

  const commitScrub = () => {
    if (scrubStart === null) return;
    const target = scrubStart;
    setScrubStart(null);
    if (Math.abs(target - curStart) >= 1) {
      void setArchiveWindow(win.windowId, target, curLen);
    }
  };

  const handleJump = () => {
    const sec = parseTimeOrDateInput(jumpInput, timeCtx);
    if (sec === null) return;
    setShowMobileJump(false);
    const jumpLen = isFullTimeline
      ? Math.max(5, Math.min(900, safeMax, Math.round(totalDur)))
      : curLen;
    void setArchiveWindow(win.windowId, sec, jumpLen);
  };

  const handleDatePickerChange = (rawVal: string) => {
    const pickedMs = parseIsoWallClockUtcMs(rawVal);
    if (pickedMs === null) return;
    const offsetSec = dateMsToRecordingOffset(pickedMs, timeCtx);
    if (offsetSec === null) return;
    setJumpInput(formatRecordingTime(offsetSec, timeCtx));
    const jumpLen = isFullTimeline
      ? Math.max(5, Math.min(900, safeMax, Math.round(totalDur)))
      : curLen;
    void setArchiveWindow(win.windowId, offsetSec, jumpLen);
  };

  const jumpInputWidth = rangeFmt.isDated ? 138 : rangeFmt.isLong ? 92 : 70;
  const jumpPlaceholder = rangeFmt.isDated
    ? 'YYYY-MM-DD HH:MM:SS'
    : rangeFmt.isLong
      ? 'Xd HH:MM:SS'
      : 'HH:MM:SS';

  const rangeTooltip =
    startMs !== null
      ? `Full archive: ${formatRecordingTime(0, timeCtx, { forceDateTime: true })} → ${formatRecordingTime(totalDur, timeCtx, { forceDateTime: true })} (${formatDurationCompact(totalDur)})`
      : `Total duration: ${formatDurationCompact(totalDur)}`;

  return (
    <div className="archive-bar" title="Navigate across recording timeline">
      <div className="archive-bar-top">
        <span className="archive-bar-label mono" title={rangeTooltip}>
          <Clock size={11} color="#38bdf8" />
          <strong>{rangeFmt.startLabel}</strong>
          <span>–</span>
          <strong>{rangeFmt.endLabel}</strong>
          <span className="archive-bar-total">
            · {rangeFmt.totalLabel}
            {isCombined && totalSegCount > 0 ? ` · ${totalSegCount} files` : ''}
          </span>
        </span>

        {activeSegments.length > 0 && (
          <span
            className="archive-segment-inline desktop-only"
            title={activeSegments.map((s) => s.name).join('\n')}
          >
            · {activeSegments[0].name}
          </span>
        )}

        <div className="archive-bar-controls">
          <button
            className="btn-small archive-nav-btn"
            disabled={curStart <= 0.5}
            onClick={() => void shiftArchiveWindow(win.windowId, -1)}
            title="Previous window"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            className="btn-small archive-nav-btn"
            disabled={curStart + curLen >= totalDur - 0.5}
            onClick={() => void shiftArchiveWindow(win.windowId, 1)}
            title="Next window"
          >
            <ChevronRight size={13} />
          </button>

          <select
            className="rate-select"
            value={isFullTimeline ? Math.max(1, Math.round(totalDur)) : curLen}
            onChange={(e) => void setArchiveWindow(win.windowId, curStart, Number(e.target.value))}
            title="View window duration (Full uses sparse spectral-line sampling)"
          >
            {lengthOptions.map((opt) => (
              <option key={opt.sec} value={opt.sec}>
                {opt.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            className={`btn-small mobile-only-inline ${showMobileJump ? 'btn-active' : ''}`}
            onClick={() => setShowMobileJump((v) => !v)}
            title="Jump to date or time"
          >
            <Search size={12} />
          </button>

          <div className={`archive-jump-wrap ${showMobileJump ? 'mobile-open' : 'desktop-only-flex'}`}>
            {pickerBounds && (
              <span className="btn-small archive-date-picker-btn" title="Pick calendar date & time">
                <Calendar size={12} />
                <input
                  type="datetime-local"
                  step={1}
                  min={pickerBounds.min}
                  max={pickerBounds.max}
                  value={pickerBounds.value}
                  onChange={(e) => handleDatePickerChange(e.target.value)}
                  aria-label="Pick calendar date and time"
                />
              </span>
            )}
            <input
              type="text"
              value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleJump();
              }}
              style={{ width: jumpInputWidth }}
              placeholder={jumpPlaceholder}
              title="Jump to date/time or offset"
            />
            <button className="btn-small" onClick={handleJump} title="Jump to time">
              Go
            </button>
          </div>
        </div>
      </div>

      <div className="archive-bar-scrubber">
        <input
          type="range"
          min={0}
          max={Math.max(1, maxStart)}
          step={Math.max(1, Math.round(curLen / 10))}
          value={Math.min(maxStart, effectiveStart)}
          disabled={maxStart <= 0}
          onChange={(e) => setScrubStart(Number(e.target.value))}
          onMouseUp={commitScrub}
          onTouchEnd={commitScrub}
          onKeyUp={commitScrub}
          title="Scrub across recording"
        />
      </div>
    </div>
  );
};
