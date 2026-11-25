import type { AudioFileInfo } from '@syrinxone/shared';

export interface RecordingSegmentTimeSpan {
  timelineStartSec: number;
  timelineEndSec: number;
  startDateTimeIso?: string | null;
  name?: string;
}

export interface RecordingTimeContext {
  totalDurationSec?: number;
  startDateTimeIso?: string | null;
  name?: string;
  uri?: string;
  segments?: RecordingSegmentTimeSpan[];
}

export interface ParsedNameTimestamp {
  ms: number;
  hasTime: boolean;
  reason: 'timestamp' | 'date';
  rawToken: string;
  skeleton: string;
}

function isValidYmdHms(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false;
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Extract an embedded UTC timestamp or date from a recording filename or folder name.
 */
export function parseTimestampFromName(name: string): ParsedNameTimestamp | null {
  if (!name) return null;
  const extMatch = !name.endsWith('/') ? name.match(/(\.[a-z0-9]{2,5})$/i) : null;
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  const stem = ext ? name.slice(0, -ext.length) : name.replace(/\/+$/, '');

  // Pattern 1: YYYY[-_]?MM[-_]?DD [T_\s-]? HH[:_-]?MM[:_-]?SS (optional .ms / Z)
  const fullRe =
    /(?:^|(?<=[^0-9]))(20\d{2}|19\d{2})[-_]?([01]\d)[-_]?([0-3]\d)[T_\s-]?([0-2]\d)[:_-]?([0-5]\d)[:_-]?([0-5]\d)(?:\.\d+)?Z?(?=[^0-9]|$)/i;
  const mFull = fullRe.exec(stem);
  if (mFull && mFull.index !== undefined) {
    const [, y, mo, d, h, mi, s] = mFull;
    const yr = Number(y);
    const mn = Number(mo);
    const dy = Number(d);
    const hr = Number(h);
    const min = Number(mi);
    const sec = Number(s);
    if (isValidYmdHms(yr, mn, dy, hr, min, sec)) {
      const ms = Date.UTC(yr, mn - 1, dy, hr, min, sec);
      const skel = `${stem.slice(0, mFull.index)}<TS>${stem.slice(mFull.index + mFull[0].length)}${ext}`;
      return {
        ms,
        hasTime: true,
        reason: 'timestamp',
        rawToken: mFull[0],
        skeleton: skel.toLowerCase(),
      };
    }
  }

  // Pattern 2: 6-digit YYMMDD [T_-]? HHMMSS (e.g., Soundtrap / SanctSound 181101T000000)
  const shortTsRe =
    /(?:^|(?<=[^0-9]))(\d{2})([01]\d)([0-3]\d)[T_-]?([0-2]\d)([0-5]\d)([0-5]\d)(?=[^0-9]|$)/;
  const mShort = shortTsRe.exec(stem);
  if (mShort && mShort.index !== undefined) {
    const [, yy, mo, d, h, mi, s] = mShort;
    const yr = Number(yy) >= 70 ? 1900 + Number(yy) : 2000 + Number(yy);
    const mn = Number(mo);
    const dy = Number(d);
    const hr = Number(h);
    const min = Number(mi);
    const sec = Number(s);
    if (isValidYmdHms(yr, mn, dy, hr, min, sec)) {
      const ms = Date.UTC(yr, mn - 1, dy, hr, min, sec);
      const skel = `${stem.slice(0, mShort.index)}<TS6>${stem.slice(mShort.index + mShort[0].length)}${ext}`;
      return {
        ms,
        hasTime: true,
        reason: 'timestamp',
        rawToken: mShort[0],
        skeleton: skel.toLowerCase(),
      };
    }
  }

  // Pattern 3: Date only YYYY[-_]?MM[-_]?DD
  const dateRe = /(?:^|(?<=[^0-9]))(20\d{2}|19\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?=[^0-9]|$)/;
  const mDate = dateRe.exec(stem);
  if (mDate && mDate.index !== undefined) {
    const [, y, mo, d] = mDate;
    const yr = Number(y);
    const mn = Number(mo);
    const dy = Number(d);
    if (isValidYmdHms(yr, mn, dy)) {
      const ms = Date.UTC(yr, mn - 1, dy);
      const skel = `${stem.slice(0, mDate.index)}<DATE>${stem.slice(mDate.index + mDate[0].length)}${ext}`;
      return {
        ms,
        hasTime: false,
        reason: 'date',
        rawToken: mDate[0],
        skeleton: skel.toLowerCase(),
      };
    }
  }

  return null;
}

/**
 * Parse an ISO datetime string preserving its literal wall-clock date & time as UTC epoch ms
 * so timestamps never shift across browser timezones.
 */
export function parseIsoWallClockUtcMs(iso: string | null | undefined): number | null {
  if (!iso || typeof iso !== 'string') return null;
  const trimmed = iso.trim();
  if (!trimmed) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?/.exec(trimmed);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '0'] = m;
    const yr = Number(y);
    const mn = Number(mo);
    const dy = Number(d);
    const hr = Number(h);
    const min = Number(mi);
    const sec = Number(s);
    if (!isValidYmdHms(yr, mn, dy, hr, min, sec)) return null;
    const msPart = Math.round(Number(`0.${frac}`) * 1000);
    return Date.UTC(yr, mn - 1, dy, hr, min, sec, msPart);
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolve the starting UTC wall-clock ms for a recording from metadata or filename/URI.
 */
export function resolveRecordingStartMs(
  ctx?: RecordingTimeContext | Pick<AudioFileInfo, 'startDateTimeIso' | 'name' | 'uri'> | null,
): number | null {
  if (!ctx) return null;
  const isoMs = parseIsoWallClockUtcMs(ctx.startDateTimeIso);
  if (isoMs !== null) return isoMs;
  if ('segments' in ctx && ctx.segments && ctx.segments.length > 0) {
    const seg0 = ctx.segments[0];
    const s0Iso = parseIsoWallClockUtcMs(seg0.startDateTimeIso);
    if (s0Iso !== null) return s0Iso;
    if (seg0.name) {
      const p = parseTimestampFromName(seg0.name);
      if (p) return p.ms;
    }
  }
  if (ctx.name) {
    const p = parseTimestampFromName(ctx.name);
    if (p) return p.ms;
  }
  if (ctx.uri) {
    const base = ctx.uri.split(/[\\/]/).pop() ?? ctx.uri;
    const p = parseTimestampFromName(base);
    if (p) return p.ms;
  }
  return null;
}

export function buildRecordingTimeContext(
  file?: AudioFileInfo | null,
  segments?: RecordingSegmentTimeSpan[],
): RecordingTimeContext {
  if (!file) return { segments };
  return {
    totalDurationSec: file.totalDurationSec ?? file.durationSec,
    startDateTimeIso: file.startDateTimeIso,
    name: file.name,
    uri: file.uri,
    segments,
  };
}

/**
 * True when a recording spans >= 24h (or crosses a calendar day when dated & >= 1h).
 */
export function isLongRecording(
  totalDurationSec?: number,
  startMs?: number | null,
): boolean {
  const dur = totalDurationSec ?? 0;
  if (dur >= 86400) return true;
  if (startMs !== null && startMs !== undefined && dur >= 3600) {
    const d0 = Math.floor(startMs / 86400000);
    const d1 = Math.floor((startMs + dur * 1000 - 1) / 86400000);
    if (d1 > d0) return true;
  }
  return false;
}

export function formatUtcDate(utcMs: number): string {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

export function formatUtcShortDate(utcMs: number): string {
  const d = new Date(utcMs);
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${mo}-${da}`;
}

export function formatUtcTime(
  utcMs: number,
  options?: { includeSeconds?: boolean; fractionalDigits?: number },
): string {
  const d = new Date(utcMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (options?.includeSeconds === false) {
    return `${hh}:${mm}`;
  }
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const fracDigits = options?.fractionalDigits ?? 0;
  if (fracDigits > 0) {
    const frac = (d.getUTCMilliseconds() / 1000).toFixed(fracDigits).slice(1); // ".xxx"
    return `${hh}:${mm}:${ss}${frac}`;
  }
  return `${hh}:${mm}:${ss}`;
}

export function formatDateTimeUtc(
  utcMs: number,
  options?: { includeYear?: boolean; includeSeconds?: boolean; fractionalDigits?: number },
): string {
  const datePart = options?.includeYear === false ? formatUtcShortDate(utcMs) : formatUtcDate(utcMs);
  return `${datePart} ${formatUtcTime(utcMs, options)}`;
}

export function formatDateTimeLocalInput(utcMs: number): string {
  return `${formatUtcDate(utcMs)}T${formatUtcTime(utcMs, { includeSeconds: true })}`;
}

/**
 * Map a recording timeline offset (seconds) to its UTC wall-clock ms,
 * using segment timestamps when available (so duty-cycled archives map cleanly).
 */
export function recordingOffsetToDateMs(
  offsetSec: number,
  ctx?: RecordingTimeContext | null,
): number | null {
  const baseMs = resolveRecordingStartMs(ctx);
  if (ctx?.segments && ctx.segments.length > 0) {
    const seg =
      ctx.segments.find(
        (s) => offsetSec >= s.timelineStartSec - 1e-4 && offsetSec <= s.timelineEndSec + 1e-4,
      ) ??
      (offsetSec < ctx.segments[0].timelineStartSec
        ? ctx.segments[0]
        : ctx.segments[ctx.segments.length - 1]);
    if (seg) {
      const segStartMs =
        parseIsoWallClockUtcMs(seg.startDateTimeIso) ??
        (seg.name ? parseTimestampFromName(seg.name)?.ms ?? null : null);
      if (segStartMs !== null) {
        const localSec = Math.max(0, offsetSec - seg.timelineStartSec);
        return segStartMs + Math.round(localSec * 1000);
      }
    }
  }
  if (baseMs === null) return null;
  return baseMs + Math.round(Math.max(0, offsetSec) * 1000);
}

/**
 * Map a target UTC wall-clock ms back to a recording timeline offset (seconds).
 */
export function dateMsToRecordingOffset(
  targetMs: number,
  ctx?: RecordingTimeContext | null,
): number | null {
  if (ctx?.segments && ctx.segments.length > 0) {
    let bestSec: number | null = null;
    let bestDist = Infinity;
    for (const seg of ctx.segments) {
      const segStartMs =
        parseIsoWallClockUtcMs(seg.startDateTimeIso) ??
        (seg.name ? parseTimestampFromName(seg.name)?.ms ?? null : null);
      if (segStartMs === null) continue;
      const segDur = Math.max(0.05, seg.timelineEndSec - seg.timelineStartSec);
      const segEndMs = segStartMs + segDur * 1000;
      if (targetMs >= segStartMs && targetMs <= segEndMs) {
        return seg.timelineStartSec + (targetMs - segStartMs) / 1000;
      }
      const dist = targetMs < segStartMs ? segStartMs - targetMs : targetMs - segEndMs;
      if (dist < bestDist) {
        bestDist = dist;
        bestSec = targetMs < segStartMs ? seg.timelineStartSec : seg.timelineEndSec;
      }
    }
    if (bestSec !== null) return bestSec;
  }
  const baseMs = resolveRecordingStartMs(ctx);
  if (baseMs === null) return null;
  return Math.max(0, (targetMs - baseMs) / 1000);
}

/**
 * Format elapsed seconds cleanly:
 * - < 10s fractional -> "X.XXs"
 * - < 24h -> "HH:MM:SS"
 * - >= 24h -> "Xd HH:MM:SS" (instead of overflowing into 100+ total hours)
 */
export function formatHms(totalSec: number, fractionalDigits = 0): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '00:00:00';
  if (fractionalDigits === 0 && totalSec < 60 && totalSec % 1 !== 0 && totalSec < 10) {
    return `${totalSec.toFixed(2)}s`;
  }
  const whole = fractionalDigits > 0 ? Math.floor(totalSec) : Math.floor(totalSec);
  const days = Math.floor(whole / 86400);
  const rem = whole % 86400;
  const hrs = Math.floor(rem / 3600);
  const mins = Math.floor((rem % 3600) / 60);
  const secs = rem % 60;
  const base = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const fracStr =
    fractionalDigits > 0 ? (totalSec - whole).toFixed(fractionalDigits).slice(1) : '';
  const hms = `${base}${fracStr}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}

/**
 * Format a duration compactly, scaling from seconds -> minutes -> hours -> days.
 */
export function formatDurationCompact(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  if (sec < 120) return `${sec.toFixed(sec < 10 ? 2 : 1)}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    if (s === 60) return `${m + 1}m`;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (sec < 86400) {
    const totalMin = Math.round(sec / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const totalHours = Math.round(sec / 3600);
  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Format a position in a recording: automatically scales up to Date + Time (YYYY-MM-DD HH:MM:SS)
 * or Day + Time (Xd HH:MM:SS) for long/multi-day recordings.
 */
export function formatRecordingTime(
  offsetSec: number,
  ctx?: RecordingTimeContext | null,
  options?: { forceDateTime?: boolean; includeYear?: boolean; fractionalDigits?: number },
): string {
  const safeOffset = Math.max(0, Number.isFinite(offsetSec) ? offsetSec : 0);
  const startMs = resolveRecordingStartMs(ctx);
  const totalDur = ctx?.totalDurationSec ?? safeOffset;
  const long = isLongRecording(totalDur, startMs) || safeOffset >= 86400;

  if (startMs !== null && (long || options?.forceDateTime)) {
    const dtMs = recordingOffsetToDateMs(safeOffset, ctx);
    if (dtMs !== null) {
      return formatDateTimeUtc(dtMs, {
        includeYear: options?.includeYear ?? true,
        includeSeconds: true,
        fractionalDigits: options?.fractionalDigits ?? 0,
      });
    }
  }

  if (long) {
    const whole = Math.floor(safeOffset);
    const days = Math.floor(whole / 86400);
    const rem = whole % 86400;
    const hrs = Math.floor(rem / 3600);
    const mins = Math.floor((rem % 3600) / 60);
    const secs = rem % 60;
    const fracStr =
      (options?.fractionalDigits ?? 0) > 0
        ? (safeOffset - whole).toFixed(options?.fractionalDigits ?? 0).slice(1)
        : '';
    return `${days}d ${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}${fracStr}`;
  }

  return formatHms(safeOffset, options?.fractionalDigits ?? 0);
}

/**
 * Format start-end range + total duration cleanly for timeline bars & headers.
 */
export function formatRecordingRange(
  startSec: number,
  endSec: number,
  totalSec: number,
  ctx?: RecordingTimeContext | null,
): { startLabel: string; endLabel: string; totalLabel: string; isDated: boolean; isLong: boolean } {
  const startMs = resolveRecordingStartMs(ctx);
  const long = isLongRecording(totalSec, startMs);

  if (startMs !== null && long) {
    const sMs = recordingOffsetToDateMs(startSec, ctx) ?? startMs + startSec * 1000;
    const eMs = recordingOffsetToDateMs(endSec, ctx) ?? startMs + endSec * 1000;
    const sameDay = formatUtcDate(sMs) === formatUtcDate(eMs);
    return {
      startLabel: formatDateTimeUtc(sMs, { includeYear: true, includeSeconds: true }),
      endLabel: sameDay
        ? formatUtcTime(eMs, { includeSeconds: true })
        : formatDateTimeUtc(eMs, { includeYear: true, includeSeconds: true }),
      totalLabel: formatDurationCompact(totalSec),
      isDated: true,
      isLong: true,
    };
  }

  return {
    startLabel: formatRecordingTime(startSec, ctx),
    endLabel: formatRecordingTime(endSec, ctx),
    totalLabel: long ? formatRecordingTime(totalSec, ctx) : formatHms(totalSec),
    isDated: false,
    isLong: long,
  };
}

/**
 * Format spectrogram X-axis tick labels.
 * Short clips keep crisp seconds; long/multi-day recordings show Date + Time or Xd HH:MM:SS.
 */
export function formatAxisTickTime(
  absOffsetSec: number,
  spanSec: number,
  ctx?: RecordingTimeContext | null,
): string {
  const startMs = resolveRecordingStartMs(ctx);
  const totalDur = ctx?.totalDurationSec ?? absOffsetSec;
  const long = isLongRecording(totalDur, startMs) || absOffsetSec >= 86400;

  if (long && startMs !== null) {
    const dtMs = recordingOffsetToDateMs(absOffsetSec, ctx);
    if (dtMs !== null) {
      const fractionalDigits = spanSec < 10 ? 1 : 0;
      const includeSeconds = spanSec < 1800;
      return formatDateTimeUtc(dtMs, {
        includeYear: false,
        includeSeconds,
        fractionalDigits,
      });
    }
  }

  if (long) {
    const fractionalDigits = spanSec < 10 ? 1 : 0;
    const whole = Math.floor(Math.max(0, absOffsetSec));
    const days = Math.floor(whole / 86400);
    const rem = whole % 86400;
    const hrs = Math.floor(rem / 3600);
    const mins = Math.floor((rem % 3600) / 60);
    const secs = rem % 60;
    if (spanSec >= 1800 && secs === 0) {
      return `${days}d ${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    }
    const fracStr =
      fractionalDigits > 0 ? (absOffsetSec - whole).toFixed(fractionalDigits).slice(1) : '';
    return `${days}d ${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}${fracStr}`;
  }

  if (absOffsetSec >= 180 || spanSec >= 180) {
    return formatHms(absOffsetSec, spanSec < 10 ? 1 : 0);
  }
  return `${absOffsetSec.toFixed(spanSec < 2 ? 2 : 1)}s`;
}

/**
 * Parse strings like "06:30:00", "2d 06:30:00", "15:30", or "3600" into seconds.
 */
export function parseHmsOrSeconds(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const v = Number(trimmed);
    return Number.isFinite(v) && v >= 0 ? v : null;
  }

  // Match "2d 14:30:00", "2d 14:30", "2d", "Day 2 14:30:00"
  const dayMatch = /^(?:day\s*)?(\d+)\s*(?:d|days?)(?:\s+(.+))?$/i.exec(trimmed);
  if (dayMatch) {
    const days = Number(dayMatch[1]);
    if (!Number.isFinite(days) || days < 0) return null;
    const rest = (dayMatch[2] ?? '').trim();
    if (!rest) return days * 86400;
    const restParts = rest.split(':').map((p) => Number(p.trim()));
    if (restParts.some((p) => !Number.isFinite(p) || p < 0)) return null;
    if (restParts.length === 2) {
      return days * 86400 + restParts[0] * 3600 + restParts[1] * 60;
    }
    if (restParts.length === 3) {
      return days * 86400 + restParts[0] * 3600 + restParts[1] * 60 + restParts[2];
    }
    return null;
  }

  const parts = trimmed.split(':').map((p) => Number(p.trim()));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

/**
 * Parse either a calendar date/time ("2018-08-03 14:30:00", "2018-08-03", "20180803T143000"),
 * a day offset ("2d 14:30:00"), or an elapsed offset ("14:30:00", "3600") into recording offset seconds.
 */
export function parseTimeOrDateInput(
  input: string,
  ctx?: RecordingTimeContext | null,
): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. YYYY-MM-DD[T ]HH:MM[:SS] or YYYY/MM/DD[ HH:MM[:SS]] or date only
  const isoMatch =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?Z?)?$/i.exec(
      trimmed,
    );
  if (isoMatch) {
    const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '0'] = isoMatch;
    const yr = Number(y);
    const mn = Number(mo);
    const dy = Number(d);
    const hr = Number(h);
    const min = Number(mi);
    const sec = Number(s);
    if (isValidYmdHms(yr, mn, dy, hr, min, sec)) {
      const targetMs = Date.UTC(
        yr,
        mn - 1,
        dy,
        hr,
        min,
        sec,
        Math.round(Number(`0.${frac}`) * 1000),
      );
      const off = dateMsToRecordingOffset(targetMs, ctx);
      if (off !== null) return off;
    }
  }

  // 2. Compact YYYYMMDDTHHMMSS
  const compactMatch = /^(\d{4})(\d{2})(\d{2})[T_\s-]?(\d{2})(\d{2})(\d{2})Z?$/i.exec(trimmed);
  if (compactMatch) {
    const [, y, mo, d, h, mi, s] = compactMatch;
    const yr = Number(y);
    const mn = Number(mo);
    const dy = Number(d);
    const hr = Number(h);
    const min = Number(mi);
    const sec = Number(s);
    if (isValidYmdHms(yr, mn, dy, hr, min, sec)) {
      const targetMs = Date.UTC(yr, mn - 1, dy, hr, min, sec);
      const off = dateMsToRecordingOffset(targetMs, ctx);
      if (off !== null) return off;
    }
  }

  return parseHmsOrSeconds(trimmed);
}
