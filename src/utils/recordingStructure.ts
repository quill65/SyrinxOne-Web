import type { AudioEngineClient, BrowseEntry } from '@syrinxone/shared';
import { listDriveItems, type DriveItem } from '../auth/googleDrive';
import {
  makeCombinedRecordingKey,
  makeSingleRecordingKey,
  naturalCompareNames,
  stripFileExtension,
  type SegmentSourceSpec,
} from './contiguousArchive';
import { parseTimestampFromName } from './timeFormat';

export interface ScannedAudioFile {
  sourceId: string;
  uri: string;
  name: string;
  /** Relative folder segments from the scanned root (e.g., ['2022', '04']) */
  dirParts: string[];
  sizeBytes?: number;
}

export interface StructureScanResult {
  files: ScannedAudioFile[];
  scannedFolders: number;
  truncated: boolean;
  rootPrefix: string;
}

export type StructureFieldRole =
  | 'channel'
  | 'year'
  | 'month'
  | 'day'
  | 'hour'
  | 'session'
  | 'category'
  | 'folder'
  | 'constant';

export interface DiscoveredField {
  id: string;
  label: string;
  role: StructureFieldRole;
  source: 'filename' | 'directory' | 'derived_date';
  sampleValues: string[];
  uniqueCount: number;
  /** Optional glossary descriptions extracted from archive documentation/README */
  valueNotes?: Record<string, string>;
}

export type CombineStructureMode = 'individual' | 'time' | 'channels' | 'channels_and_time';

export type RecordingGranularity =
  | 'individual'
  | 'channel_group'
  | 'session'
  | 'hour'
  | 'day'
  | 'month'
  | 'year'
  | 'category'
  | 'folder'
  | 'all'
  | 'custom';

export interface RecordingStructureDefinition {
  id: string;
  label: string;
  granularity: RecordingGranularity;
  combineMode: CombineStructureMode;
  /** Field IDs whose combined values separate distinct recordings. */
  groupByFieldIds: string[];
  /** Field ID representing synchronized parallel channel tracks (e.g., CH1..CH6), if any. */
  channelFieldId?: string | null;
  sortBy: 'timestamp' | 'name';
  /** Scanned root prefix when the definition was created (reused when reopening the source). */
  rootPrefix?: string;
  includeSubfolders: boolean;
  updatedAt: number;
}

export interface DefinedRecording {
  recordingId: string;
  recordingKey: string;
  title: string;
  subtitle: string;
  sourceId: string;
  fileCount: number;
  segmentCount: number;
  channelCount: number;
  channelLabels: string[];
  totalSizeBytes: number;
  startDateTimeIso?: string | null;
  dateSpanLabel?: string;
  /** Ready to open via openCombinedArchive (or openAudioFromSource when 1 file & 1 ch). */
  specs: SegmentSourceSpec[];
  groupValues: Record<string, string>;
}

export interface RecordingStructureSuggestion {
  id: string;
  title: string;
  description: string;
  granularity: RecordingGranularity;
  recommended: boolean;
  rationale?: string;
  definition: RecordingStructureDefinition;
  recordingCount: number;
  sampleRecordings: Array<{
    title: string;
    fileCount: number;
    channelCount: number;
    segmentCount: number;
  }>;
}

export interface StructureAnalysisResult {
  totalAudioFiles: number;
  fields: DiscoveredField[];
  detectedChannelFieldId: string | null;
  hasDates: boolean;
  hasTimes: boolean;
  docInsights: string[];
  suggestions: RecordingStructureSuggestion[];
}

interface ParsedFileMetadata {
  file: ScannedAudioFile;
  values: Record<string, string>;
  timestampMs: number | null;
  hasTime: boolean;
  channelLabel: string | null;
  channelSortNum: number;
  nonChannelStem: string;
}

const CHANNEL_TOKEN_RE = /^(?:ch|chan|channel|mic|hydrophone|trk|track)[-_]?0*(\d+)$/i;
const STORAGE_KEY = 'syrinxone.recordingDefinitions.v1';

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function tryParseSixDigitYyMmDd(token: string): { y: number; m: number; d: number } | null {
  if (!/^\d{6}$/.test(token)) return null;
  const yy = Number(token.slice(0, 2));
  const mm = Number(token.slice(2, 4));
  const dd = Number(token.slice(4, 6));
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  if (year < 1970 || year > 2039) return null;
  if (!isValidYmd(year, mm, dd)) return null;
  return { y: year, m: mm, d: dd };
}

function tryParseEightDigitYyyyMmDd(token: string): { y: number; m: number; d: number } | null {
  const m = token.match(/^(19\d{2}|20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!isValidYmd(y, mo, d)) return null;
  return { y, m: mo, d };
}

function parseChannelToken(token: string): { label: string; sortNum: number } | null {
  const m = token.match(CHANNEL_TOKEN_RE);
  if (m) {
    const num = Number(m[1]);
    if (Number.isFinite(num) && num >= 0 && num <= 256) {
      return { label: token.toUpperCase(), sortNum: num };
    }
  }
  return null;
}

function tokenizeStem(filename: string): string[] {
  const stem = stripFileExtension(filename);
  return stem
    .split(/[_\-.\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function extractChannelFromFile(
  tokens: string[],
  dirParts: string[],
): { fieldId: string; label: string; sortNum: number; tokenIndex?: number; dirIndex?: number } | null {
  // Prefer rightmost channel token in filename (e.g., BGD_150203_010_CAF.CH1.wav)
  for (let i = tokens.length - 1; i >= 0; i--) {
    const ch = parseChannelToken(tokens[i]);
    if (ch) {
      return { fieldId: `tok:${i}`, label: ch.label, sortNum: ch.sortNum, tokenIndex: i };
    }
  }
  // Fallback: channel folder (e.g., ch1/20230101.wav)
  for (let i = dirParts.length - 1; i >= 0; i--) {
    const ch = parseChannelToken(dirParts[i]);
    if (ch) {
      return { fieldId: `dir:${i}`, label: ch.label, sortNum: ch.sortNum, dirIndex: i };
    }
  }
  return null;
}

function extractDateFromDirs(dirParts: string[]): { ms: number; hasTime: boolean } | null {
  let y: number | null = null;
  let mo: number | null = null;
  let d: number | null = null;

  for (const seg of dirParts) {
    const full = parseTimestampFromName(seg);
    if (full) return { ms: full.ms, hasTime: full.hasTime };
    const ymd = tryParseEightDigitYyyyMmDd(seg);
    if (ymd) return { ms: Date.UTC(ymd.y, ymd.m - 1, ymd.d), hasTime: false };
    const ym = seg.match(/^(19\d{2}|20\d{2})[-_]([01]\d)$/);
    if (ym) {
      y = Number(ym[1]);
      mo = Number(ym[2]);
      continue;
    }
    if (/^(19\d{2}|20\d{2})$/.test(seg) && y === null) {
      y = Number(seg);
      continue;
    }
    if (y !== null && mo === null && /^(0[1-9]|1[0-2])$/.test(seg)) {
      mo = Number(seg);
      continue;
    }
    if (y !== null && mo !== null && d === null && /^(0[1-9]|[12]\d|3[01])$/.test(seg)) {
      d = Number(seg);
    }
  }

  if (y !== null) {
    const monthVal = mo ?? 1;
    const dayVal = d ?? 1;
    if (isValidYmd(y, monthVal, dayVal)) {
      return { ms: Date.UTC(y, monthVal - 1, dayVal), hasTime: false };
    }
  }
  return null;
}

function formatUtcDateParts(ms: number): {
  year: string;
  month: string;
  day: string;
  hour: string;
} {
  const dt = new Date(ms);
  const y = String(dt.getUTCFullYear());
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  const h = String(dt.getUTCHours()).padStart(2, '0');
  return {
    year: y,
    month: `${y}-${mo}`,
    day: `${y}-${mo}-${d}`,
    hour: `${y}-${mo}-${d} ${h}:00`,
  };
}

function extractDocumentationInsights(
  docText: string,
  categoricalValues: Set<string>,
): { insights: string[]; codeGlossary: Record<string, string> } {
  const insights: string[] = [];
  const codeGlossary: Record<string, string> = {};
  const clean = (docText || '').trim();
  if (!clean) return { insights, codeGlossary };

  // Detect channel / microphone array hints in documentation
  const chMention = clean.match(
    /(\b\d{1,2})\s*[-]?\s*(?:channel|ch\b|mic(?:rophone)?s?|hydrophones?)\b/i,
  );
  if (chMention) {
    insights.push(`Docs mention ${chMention[0].trim()} recordings`);
  }

  // Detect cadence/organization keywords in docs
  const cadenceMatches: string[] = [];
  if (/\b(?:continuous|24\/7|duty[- ]cycle)\b/i.test(clean)) cadenceMatches.push('continuous/scheduled');
  if (/\b(?:daily|per[- ]day|24[- ]hour)\b/i.test(clean)) cadenceMatches.push('daily files');
  if (/\b(?:hourly|per[- ]hour|1[- ]hour)\b/i.test(clean)) cadenceMatches.push('hourly files');
  if (/\b(?:session|sessions|deployment|deployments)\b/i.test(clean)) cadenceMatches.push('sessions/deployments');
  if (/\b(?:environment|environments|habitat|habitats|site|sites)\b/i.test(clean)) {
    cadenceMatches.push('sites/environments');
  }
  if (cadenceMatches.length > 0) {
    insights.push(`Docs reference ${cadenceMatches.slice(0, 3).join(', ')}`);
  }

  // Match uppercase code definitions in README against actual discovered token values
  // e.g. "CAF: cafe", "BUS - bus", "STR (street)", "BGD = background"
  if (categoricalValues.size > 0) {
    const upperLookup = new Map<string, string>();
    for (const v of categoricalValues) {
      if (v.length >= 2 && v.length <= 12) {
        upperLookup.set(v.toUpperCase(), v);
      }
    }
    const lines = clean.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(
        /(?:^|[\s*\-|•])([A-Za-z][A-Za-z0-9]{1,10})\s*(?:[:=\-–—]|\()\s*([A-Za-z][A-Za-z0-9 ,/'-]{2,42})/,
      );
      if (!m) continue;
      const keyUpper = m[1].toUpperCase();
      const matchedVal = upperLookup.get(keyUpper);
      if (matchedVal && !codeGlossary[matchedVal]) {
        const gloss = m[2].replace(/\).*$/, '').trim();
        if (gloss && gloss.toLowerCase() !== matchedVal.toLowerCase()) {
          codeGlossary[matchedVal] = gloss;
        }
      }
    }
    const matchedEntries = Object.entries(codeGlossary);
    if (matchedEntries.length > 0) {
      const summary = matchedEntries
        .slice(0, 4)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      insights.push(`Docs explain filename codes: ${summary}`);
    }
  }

  return { insights, codeGlossary };
}

function parseAllFiles(files: ScannedAudioFile[]): {
  parsed: ParsedFileMetadata[];
  fields: DiscoveredField[];
  detectedChannelFieldId: string | null;
  hasDates: boolean;
  hasTimes: boolean;
} {
  if (files.length === 0) {
    return {
      parsed: [],
      fields: [],
      detectedChannelFieldId: null,
      hasDates: false,
      hasTimes: false,
    };
  }

  const tokenized = files.map((file) => ({
    file,
    tokens: tokenizeStem(file.name),
    dirParts: file.dirParts.filter(Boolean),
  }));

  const maxTokLen = tokenized.reduce((m, x) => Math.max(m, x.tokens.length), 0);
  const maxDirLen = tokenized.reduce((m, x) => Math.max(m, x.dirParts.length), 0);

  // Detect if any token slot is consistently a 6-digit YYMMDD date (e.g., CHiME-3 `150203`)
  const yymmddSlots = new Set<number>();
  for (let i = 0; i < maxTokLen; i++) {
    let present = 0;
    let validDate = 0;
    for (const item of tokenized) {
      const t = item.tokens[i];
      if (!t) continue;
      present++;
      if (tryParseSixDigitYyMmDd(t)) validDate++;
    }
    if (present >= 2 && validDate / present >= 0.6) {
      yymmddSlots.add(i);
    }
  }

  // Detect channel field across files
  const channelHits = new Map<string, { files: number; distinctLabels: Set<string> }>();
  const rawChannels = tokenized.map((item) => {
    const ch = extractChannelFromFile(item.tokens, item.dirParts);
    if (ch) {
      const rec = channelHits.get(ch.fieldId) ?? { files: 0, distinctLabels: new Set<string>() };
      rec.files++;
      rec.distinctLabels.add(ch.label);
      channelHits.set(ch.fieldId, rec);
    }
    return ch;
  });

  // Also check if a channel token exists across variable positions (use virtual field 'channel:auto')
  let detectedChannelFieldId: string | null = null;
  let bestChannelScore = 0;
  for (const [fid, stats] of channelHits.entries()) {
    if (stats.distinctLabels.size >= 2 && stats.files >= 2 && stats.files > bestChannelScore) {
      bestChannelScore = stats.files;
      detectedChannelFieldId = fid;
    }
  }
  const totalWithAnyChannel = rawChannels.filter(Boolean).length;
  const allDistinctChannels = new Set(rawChannels.filter(Boolean).map((c) => c!.label));
  if (!detectedChannelFieldId && allDistinctChannels.size >= 2 && totalWithAnyChannel >= 2) {
    detectedChannelFieldId = 'channel:auto';
  }

  // Parse each file into values + timestamp + nonChannelStem
  let hasDates = false;
  let hasTimes = false;
  const parsed: ParsedFileMetadata[] = tokenized.map((item, idx) => {
    const values: Record<string, string> = {};
    for (let d = 0; d < item.dirParts.length; d++) {
      values[`dir:${d}`] = item.dirParts[d];
    }
    for (let t = 0; t < item.tokens.length; t++) {
      values[`tok:${t}`] = item.tokens[t];
    }

    const ch = rawChannels[idx];
    if (ch) {
      values['channel:auto'] = ch.label;
    }

    // Extract timestamp from filename, YYMMDD slot, or directory path
    let tsMs: number | null = null;
    let hasTime = false;
    const directTs = parseTimestampFromName(item.file.name);
    if (directTs) {
      tsMs = directTs.ms;
      hasTime = directTs.hasTime;
    } else {
      for (const slot of yymmddSlots) {
        const tok = item.tokens[slot];
        const ymd = tok ? tryParseSixDigitYyMmDd(tok) : null;
        if (ymd) {
          tsMs = Date.UTC(ymd.y, ymd.m - 1, ymd.d);
          hasTime = false;
          break;
        }
      }
      if (tsMs === null) {
        const dirDate = extractDateFromDirs(item.dirParts);
        if (dirDate) {
          tsMs = dirDate.ms;
          hasTime = dirDate.hasTime;
        }
      }
    }

    if (tsMs !== null) {
      hasDates = true;
      if (hasTime) hasTimes = true;
      const parts = formatUtcDateParts(tsMs);
      values['date:year'] = parts.year;
      values['date:month'] = parts.month;
      values['date:day'] = parts.day;
      if (hasTime) {
        values['date:hour'] = parts.hour;
      }
    }

    // Build non-channel stem (used to pair parallel channel files into a single time slice)
    const stemParts: string[] = [];
    for (let d = 0; d < item.dirParts.length; d++) {
      if (ch?.dirIndex === d) continue;
      stemParts.push(item.dirParts[d]);
    }
    const nameTokens: string[] = [];
    for (let t = 0; t < item.tokens.length; t++) {
      if (ch?.tokenIndex === t) continue;
      nameTokens.push(item.tokens[t]);
    }
    const nonChannelStem = `${stemParts.join('/')}::${nameTokens.join('_')}`;

    return {
      file: item.file,
      values,
      timestampMs: tsMs,
      hasTime,
      channelLabel: ch?.label ?? null,
      channelSortNum: ch?.sortNum ?? 0,
      nonChannelStem,
    };
  });

  // Verify channel grouping actually pairs >= 2 channels for at least one stem
  if (detectedChannelFieldId) {
    const stemChannels = new Map<string, Set<string>>();
    for (const p of parsed) {
      if (!p.channelLabel) continue;
      const set = stemChannels.get(p.nonChannelStem) ?? new Set<string>();
      set.add(p.channelLabel);
      stemChannels.set(p.nonChannelStem, set);
    }
    const hasPairedMultiCh = Array.from(stemChannels.values()).some((s) => s.size >= 2);
    if (!hasPairedMultiCh) {
      detectedChannelFieldId = null;
    }
  }

  // Classify fields cleanly
  const fields: DiscoveredField[] = [];
  const collectUnique = (fieldId: string): string[] => {
    const set = new Set<string>();
    for (const p of parsed) {
      const v = p.values[fieldId];
      if (v) set.add(v);
    }
    return Array.from(set).sort(naturalCompareNames);
  };

  // 1. Derived date granularity fields (Year / Month / Day / Hour)
  if (hasDates) {
    const addDateField = (
      id: 'date:year' | 'date:month' | 'date:day' | 'date:hour',
      label: string,
      role: StructureFieldRole,
    ) => {
      const vals = collectUnique(id);
      if (vals.length === 0) return;
      fields.push({
        id,
        label,
        role,
        source: 'derived_date',
        sampleValues: vals.slice(0, 6),
        uniqueCount: vals.length,
      });
    };
    addDateField('date:year', 'Year', 'year');
    addDateField('date:month', 'Month', 'month');
    addDateField('date:day', 'Day', 'day');
    if (hasTimes) {
      addDateField('date:hour', 'Hour', 'hour');
    }
  }

  // 2. Directory fields
  for (let d = 0; d < maxDirLen; d++) {
    const fid = `dir:${d}`;
    const vals = collectUnique(fid);
    if (vals.length === 0) continue;
    const isChannel = detectedChannelFieldId === fid;
    const isConstant = vals.length <= 1;
    // Skip directory levels that are pure YYYY / MM / DD already captured by derived date fields
    const isPureDateDir =
      hasDates &&
      vals.every(
        (v) =>
          /^(19\d{2}|20\d{2})$/.test(v) ||
          /^(0[1-9]|1[0-2])$/.test(v) ||
          /^(0[1-9]|[12]\d|3[01])$/.test(v) ||
          Boolean(tryParseEightDigitYyyyMmDd(v)),
      );
    if (isPureDateDir && !isChannel) continue;

    fields.push({
      id: fid,
      label: isChannel
        ? `Channel Folder (${vals[0]}–${vals[vals.length - 1]})`
        : `Folder Level ${d + 1}`,
      role: isChannel ? 'channel' : isConstant ? 'constant' : 'folder',
      source: 'directory',
      sampleValues: vals.slice(0, 6),
      uniqueCount: vals.length,
    });
  }

  // 3. Filename token fields
  for (let t = 0; t < maxTokLen; t++) {
    const fid = `tok:${t}`;
    const vals = collectUnique(fid);
    if (vals.length === 0) continue;
    const isChannel = detectedChannelFieldId === fid;

    if (isChannel) {
      fields.push({
        id: fid,
        label: `Channel (${vals[0]}–${vals[vals.length - 1]})`,
        role: 'channel',
        source: 'filename',
        sampleValues: vals.slice(0, 8),
        uniqueCount: vals.length,
      });
      continue;
    }

    // Skip raw date/timestamp token slots if already represented by Year/Month/Day/Hour
    const isDateSlot =
      yymmddSlots.has(t) ||
      vals.every((v) => Boolean(parseTimestampFromName(v)) || Boolean(tryParseEightDigitYyyyMmDd(v)));
    if (isDateSlot && hasDates) {
      continue;
    }

    // Skip pure HHMMSS time tokens if already folded into Hour/Timestamp
    const isPureTimeSlot =
      hasTimes && vals.every((v) => /^[0-2]\d[0-5]\d[0-5]\d(?:Z)?$/i.test(v));
    if (isPureTimeSlot) continue;

    if (vals.length <= 1) {
      fields.push({
        id: fid,
        label: `Prefix (${vals[0]})`,
        role: 'constant',
        source: 'filename',
        sampleValues: vals,
        uniqueCount: 1,
      });
      continue;
    }

    const allAlphaCode = vals.every((v) => /^[A-Za-z][A-Za-z0-9]{1,16}$/.test(v) && /[A-Za-z]/.test(v));
    const allNumeric = vals.every((v) => /^\d+$/.test(v));
    const role: StructureFieldRole = allAlphaCode
      ? 'category'
      : allNumeric
        ? 'session'
        : vals.length <= Math.max(8, Math.floor(files.length * 0.35))
          ? 'category'
          : 'session';

    const label =
      role === 'category'
        ? `Category / Site (${vals.slice(0, 3).join(', ')}${vals.length > 3 ? '…' : ''})`
        : `Session / Sequence (${vals.slice(0, 3).join(', ')}${vals.length > 3 ? '…' : ''})`;

    fields.push({
      id: fid,
      label,
      role,
      source: 'filename',
      sampleValues: vals.slice(0, 6),
      uniqueCount: vals.length,
    });
  }

  if (detectedChannelFieldId === 'channel:auto') {
    const vals = collectUnique('channel:auto');
    fields.push({
      id: 'channel:auto',
      label: `Channel (${vals[0]}–${vals[vals.length - 1]})`,
      role: 'channel',
      source: 'filename',
      sampleValues: vals.slice(0, 8),
      uniqueCount: vals.length,
    });
  }

  return { parsed, fields, detectedChannelFieldId, hasDates, hasTimes };
}

function buildRecordingTitle(
  groupValues: Record<string, string>,
  groupByFieldIds: string[],
  items: ParsedFileMetadata[],
  fallbackLabel: string,
): string {
  const parts: string[] = [];
  for (const fid of groupByFieldIds) {
    const v = groupValues[fid];
    if (v && !parts.includes(v)) parts.push(v);
  }
  if (parts.length > 0) {
    return parts.join(' · ');
  }
  if (items.length === 1) {
    return items[0].file.name;
  }
  return fallbackLabel;
}

/**
 * Evaluates a RecordingStructureDefinition over scanned audio files, returning
 * first-class virtual recordings (supporting parallel channels, time-concatenation, or both).
 */
export function buildDefinedRecordings(
  files: ScannedAudioFile[],
  definition: RecordingStructureDefinition,
): DefinedRecording[] {
  if (files.length === 0) return [];

  const { parsed } = parseAllFiles(files);

  if (definition.combineMode === 'individual') {
    const sorted = [...parsed].sort((a, b) => {
      if (definition.sortBy === 'timestamp' && a.timestampMs !== null && b.timestampMs !== null) {
        if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
      }
      return naturalCompareNames(a.file.name, b.file.name);
    });

    return sorted.map((p) => {
      const spec: SegmentSourceSpec = {
        sourceId: p.file.sourceId,
        uri: p.file.uri,
        name: p.file.name,
        sizeBytes: p.file.sizeBytes,
        folderName: p.file.dirParts.join('/') || undefined,
      };
      const recKey = makeSingleRecordingKey(p.file.sourceId, p.file.uri);
      return {
        recordingId: recKey,
        recordingKey: recKey,
        title: p.file.name,
        subtitle: p.file.dirParts.length > 0 ? p.file.dirParts.join(' / ') : 'Single file',
        sourceId: p.file.sourceId,
        fileCount: 1,
        segmentCount: 1,
        channelCount: 1,
        channelLabels: [],
        totalSizeBytes: p.file.sizeBytes ?? 0,
        startDateTimeIso: p.timestampMs !== null ? new Date(p.timestampMs).toISOString() : null,
        dateSpanLabel: p.values['date:day'],
        specs: [spec],
        groupValues: {},
      };
    });
  }

  // Group parsed files according to groupByFieldIds
  const groups = new Map<string, { groupValues: Record<string, string>; items: ParsedFileMetadata[] }>();
  const useChannelStacking =
    (definition.combineMode === 'channels' || definition.combineMode === 'channels_and_time') &&
    Boolean(definition.channelFieldId);

  for (const p of parsed) {
    const gv: Record<string, string> = {};
    let keyParts: string[];

    if (definition.combineMode === 'channels' && definition.groupByFieldIds.length === 0) {
      // Default channel grouping pairs files with identical non-channel stem
      keyParts = [p.nonChannelStem];
      gv['stem'] = p.nonChannelStem.split('::').pop()?.replace(/_/g, ' ') || p.file.name;
    } else {
      keyParts = definition.groupByFieldIds.map((fid) => {
        const val = p.values[fid] ?? '';
        if (val) gv[fid] = val;
        return `${fid}=${val}`;
      });
    }

    const key = keyParts.join('|') || '__all__';
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(p);
    } else {
      groups.set(key, { groupValues: gv, items: [p] });
    }
  }

  const recordings: DefinedRecording[] = [];
  const sourceId = files[0].sourceId;

  for (const [gKey, { groupValues, items }] of groups.entries()) {
    const sortItems = (arr: ParsedFileMetadata[]) =>
      [...arr].sort((a, b) => {
        if (definition.sortBy === 'timestamp' && a.timestampMs !== null && b.timestampMs !== null) {
          if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
        }
        return naturalCompareNames(a.file.name, b.file.name);
      });

    let specs: SegmentSourceSpec[] = [];
    let channelCount = 1;
    let channelLabels: string[] = [];

    if (useChannelStacking) {
      // Sub-group items within this recording by nonChannelStem (each time slice has 1..K parallel channel files)
      const sliceMap = new Map<string, ParsedFileMetadata[]>();
      for (const item of items) {
        const list = sliceMap.get(item.nonChannelStem) ?? [];
        list.push(item);
        sliceMap.set(item.nonChannelStem, list);
      }

      const slices = Array.from(sliceMap.values()).map((chItems) => {
        const chFieldId = definition.channelFieldId!;
        const sortedCh = [...chItems].sort((a, b) => {
          if (a.channelSortNum !== b.channelSortNum) return a.channelSortNum - b.channelSortNum;
          const va = a.values[chFieldId] ?? a.file.name;
          const vb = b.values[chFieldId] ?? b.file.name;
          return naturalCompareNames(va, vb);
        });
        const first = sortedCh[0];
        return { first, sortedCh };
      });

      slices.sort((a, b) => {
        if (
          definition.sortBy === 'timestamp' &&
          a.first.timestampMs !== null &&
          b.first.timestampMs !== null &&
          a.first.timestampMs !== b.first.timestampMs
        ) {
          return a.first.timestampMs - b.first.timestampMs;
        }
        return naturalCompareNames(a.first.file.name, b.first.file.name);
      });

      const distinctChLabels = new Map<number, string>();
      specs = slices.map(({ first, sortedCh }) => {
        const chSpecs: SegmentSourceSpec[] = sortedCh.map((c, idx) => {
          const chLbl = c.values[definition.channelFieldId!] ?? c.channelLabel ?? `CH${idx + 1}`;
          if (!distinctChLabels.has(idx)) distinctChLabels.set(idx, chLbl);
          return {
            sourceId: c.file.sourceId,
            uri: c.file.uri,
            name: c.file.name,
            sizeBytes: c.file.sizeBytes,
            folderName: c.file.dirParts.join('/') || undefined,
          };
        });
        return {
          sourceId: first.file.sourceId,
          uri: first.file.uri,
          name: first.file.name,
          sizeBytes: first.file.sizeBytes,
          folderName: first.file.dirParts.join('/') || undefined,
          ...(chSpecs.length > 1 ? { channelFiles: chSpecs } : {}),
        };
      });

      channelCount = Math.max(1, ...specs.map((s) => s.channelFiles?.length ?? 1));
      channelLabels = Array.from(distinctChLabels.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, lbl]) => lbl);
    } else {
      const sorted = sortItems(items);
      specs = sorted.map((p) => ({
        sourceId: p.file.sourceId,
        uri: p.file.uri,
        name: p.file.name,
        sizeBytes: p.file.sizeBytes,
        folderName: p.file.dirParts.join('/') || undefined,
      }));
    }

    const totalSizeBytes = items.reduce((acc, p) => acc + (p.file.sizeBytes ?? 0), 0);
    const validTs = items
      .map((p) => p.timestampMs)
      .filter((ms): ms is number => ms !== null)
      .sort((a, b) => a - b);
    const startDateTimeIso = validTs.length > 0 ? new Date(validTs[0]).toISOString() : null;
    let dateSpanLabel: string | undefined;
    if (validTs.length > 0) {
      const d0 = formatUtcDateParts(validTs[0]).day;
      const d1 = formatUtcDateParts(validTs[validTs.length - 1]).day;
      dateSpanLabel = d0 === d1 ? d0 : `${d0} – ${d1}`;
    }

    const title = buildRecordingTitle(
      groupValues,
      definition.groupByFieldIds.length > 0 ? definition.groupByFieldIds : Object.keys(groupValues),
      items,
      definition.label || 'Combined Recording',
    );

    const subParts: string[] = [];
    if (channelCount > 1) {
      const chRange =
        channelLabels.length >= 2
          ? `${channelLabels[0]}–${channelLabels[channelLabels.length - 1]}`
          : `${channelCount} ch`;
      subParts.push(`${channelCount} ch (${chRange})`);
    }
    if (specs.length > 1) {
      subParts.push(`${specs.length} sequential segments`);
    }
    subParts.push(`${items.length} file${items.length === 1 ? '' : 's'}`);
    if (dateSpanLabel && !title.includes(dateSpanLabel)) {
      subParts.push(dateSpanLabel);
    }

    const recordingKey =
      specs.length === 1 && channelCount === 1
        ? makeSingleRecordingKey(specs[0].sourceId, specs[0].uri)
        : makeCombinedRecordingKey(sourceId, specs);

    recordings.push({
      recordingId: `${definition.id}::${gKey}`,
      recordingKey,
      title,
      subtitle: subParts.join(' · '),
      sourceId,
      fileCount: items.length,
      segmentCount: specs.length,
      channelCount,
      channelLabels,
      totalSizeBytes,
      startDateTimeIso,
      dateSpanLabel,
      specs,
      groupValues,
    });
  }

  recordings.sort((a, b) => {
    if (definition.sortBy === 'timestamp' && a.startDateTimeIso && b.startDateTimeIso) {
      if (a.startDateTimeIso !== b.startDateTimeIso) {
        return a.startDateTimeIso.localeCompare(b.startDateTimeIso);
      }
    }
    return naturalCompareNames(a.title, b.title);
  });

  return recordings;
}

/**
 * Analyzes filenames, directory structures, and documentation text to infer fields
 * and generate multi-granularity combining suggestions.
 */
export function analyzeRecordingStructure(
  files: ScannedAudioFile[],
  options?: {
    docText?: string;
    sourceLabel?: string;
    rootPrefix?: string;
    includeSubfolders?: boolean;
  },
): StructureAnalysisResult {
  const { fields, detectedChannelFieldId, hasDates, hasTimes } = parseAllFiles(files);

  // Collect categorical values to cross-reference against README / documentation
  const catValues = new Set<string>();
  for (const f of fields) {
    if (f.role === 'category' || f.role === 'folder') {
      for (const v of f.sampleValues) catValues.add(v);
    }
  }
  const { insights: docInsights, codeGlossary } = extractDocumentationInsights(
    options?.docText ?? '',
    catValues,
  );

  // Attach README glosses onto matching fields
  for (const f of fields) {
    const notes: Record<string, string> = {};
    for (const v of f.sampleValues) {
      if (codeGlossary[v]) notes[v] = codeGlossary[v];
    }
    if (Object.keys(notes).length > 0) {
      f.valueNotes = notes;
    }
  }

  const categoryFields = fields.filter((f) => f.role === 'category');
  const folderFields = fields.filter((f) => f.role === 'folder');
  const sessionFields = fields.filter((f) => f.role === 'session');
  const hasChannelField = Boolean(detectedChannelFieldId);
  const baseCombineMode: CombineStructureMode = hasChannelField ? 'channels_and_time' : 'time';
  const rootPrefix = options?.rootPrefix ?? '';
  const includeSubfolders = options?.includeSubfolders ?? true;
  const now = Date.now();

  const rawSuggestions: Array<{
    id: string;
    title: string;
    description: string;
    granularity: RecordingGranularity;
    recommended: boolean;
    rationale?: string;
    definition: RecordingStructureDefinition;
  }> = [];

  const nonChannelIdentityIds = [
    ...(hasDates ? ['date:day'] : []),
    ...folderFields.map((f) => f.id),
    ...categoryFields.map((f) => f.id),
    ...sessionFields.map((f) => f.id),
  ];

  // 1. Multi-channel per-session / per-stem combining (e.g., CHiME-3 CH1..CH6 -> 1 recording per session)
  if (hasChannelField && detectedChannelFieldId) {
    const chField = fields.find((f) => f.id === detectedChannelFieldId);
    const chRangeText =
      chField && chField.sampleValues.length >= 2
        ? `${chField.sampleValues[0]}–${chField.sampleValues[chField.sampleValues.length - 1]}`
        : 'multi-channel';
    const def: RecordingStructureDefinition = {
      id: 'channel_group',
      label: `Combined Channels per Session (${chRangeText})`,
      granularity: 'channel_group',
      combineMode: 'channels',
      groupByFieldIds: nonChannelIdentityIds,
      channelFieldId: detectedChannelFieldId,
      sortBy: hasDates ? 'timestamp' : 'name',
      rootPrefix,
      includeSubfolders,
      updatedAt: now,
    };
    rawSuggestions.push({
      id: 'channel_group',
      title: `Combine Channels per Recording (${chRangeText})`,
      description: `Stacks synchronized ${chRangeText} files into a single multi-channel recording for each session.`,
      granularity: 'channel_group',
      recommended: true,
      rationale: `Detected ${chField?.uniqueCount ?? 'multiple'} paired channel tracks (${chRangeText}) sharing identical recording stems.`,
      definition: def,
    });
  }

  const siteContextIds = [
    ...folderFields.slice(0, 1).map((f) => f.id),
    ...categoryFields.slice(0, 1).map((f) => f.id),
  ];

  // 2. Time granularities: Hour -> Day -> Month -> Year
  if (hasTimes) {
    rawSuggestions.push({
      id: 'by_hour',
      title: hasChannelField ? 'Separate by Hour (Multi-Channel)' : 'Separate by Hour',
      description: 'Combines all files within each hour into one continuous recording.',
      granularity: 'hour',
      recommended: false,
      definition: {
        id: 'by_hour',
        label: hasChannelField ? 'By Hour (Multi-Channel)' : 'By Hour',
        granularity: 'hour',
        combineMode: baseCombineMode,
        groupByFieldIds: [...siteContextIds, 'date:hour'],
        channelFieldId: detectedChannelFieldId,
        sortBy: 'timestamp',
        rootPrefix,
        includeSubfolders,
        updatedAt: now,
      },
    });
  }

  if (hasDates) {
    rawSuggestions.push({
      id: 'by_day',
      title: hasChannelField ? 'Separate by Day (Multi-Channel)' : 'Separate by Day',
      description:
        siteContextIds.length > 0
          ? 'Groups files by date and site/category into one continuous recording per day.'
          : 'Combines all files recorded on the same calendar day into one recording.',
      granularity: 'day',
      recommended: !hasChannelField,
      rationale: !hasChannelField
        ? 'Timestamped files detected — daily recordings balance overview and quick navigation.'
        : undefined,
      definition: {
        id: 'by_day',
        label: hasChannelField ? 'By Day (Multi-Channel)' : 'By Day',
        granularity: 'day',
        combineMode: baseCombineMode,
        groupByFieldIds: [...siteContextIds, 'date:day'],
        channelFieldId: detectedChannelFieldId,
        sortBy: 'timestamp',
        rootPrefix,
        includeSubfolders,
        updatedAt: now,
      },
    });

    rawSuggestions.push({
      id: 'by_month',
      title: hasChannelField ? 'Separate by Month (Multi-Channel)' : 'Separate by Month',
      description: 'Combines all recordings within each calendar month into one long timeline.',
      granularity: 'month',
      recommended: false,
      definition: {
        id: 'by_month',
        label: hasChannelField ? 'By Month (Multi-Channel)' : 'By Month',
        granularity: 'month',
        combineMode: baseCombineMode,
        groupByFieldIds: [...siteContextIds, 'date:month'],
        channelFieldId: detectedChannelFieldId,
        sortBy: 'timestamp',
        rootPrefix,
        includeSubfolders,
        updatedAt: now,
      },
    });

    rawSuggestions.push({
      id: 'by_year',
      title: hasChannelField ? 'Separate by Year (Multi-Channel)' : 'Separate by Year',
      description: 'Combines all recordings within each year into a single archive timeline.',
      granularity: 'year',
      recommended: false,
      definition: {
        id: 'by_year',
        label: hasChannelField ? 'By Year (Multi-Channel)' : 'By Year',
        granularity: 'year',
        combineMode: baseCombineMode,
        groupByFieldIds: ['date:year'],
        channelFieldId: detectedChannelFieldId,
        sortBy: 'timestamp',
        rootPrefix,
        includeSubfolders,
        updatedAt: now,
      },
    });
  }

  // 3. Categorical / Site / Folder grouping (e.g., CAF, BUS, PED, STR or deployment folders)
  if (categoryFields.length > 0) {
    const cf = categoryFields[0];
    rawSuggestions.push({
      id: `by_${cf.id}`,
      title: `Separate by ${cf.label}`,
      description: `Combines all files sharing each ${cf.label.toLowerCase()} value into one recording.`,
      granularity: 'category',
      recommended: !hasChannelField && !hasDates,
      definition: {
        id: `by_${cf.id}`,
        label: `By ${cf.label}`,
        granularity: 'category',
        combineMode: baseCombineMode,
        groupByFieldIds: [cf.id],
        channelFieldId: detectedChannelFieldId,
        sortBy: hasDates ? 'timestamp' : 'name',
        rootPrefix,
        includeSubfolders,
        updatedAt: now,
      },
    });
  } else if (folderFields.length > 0) {
    const ff = folderFields[0];
    rawSuggestions.push({
      id: `by_${ff.id}`,
      title: `Separate by Folder (${ff.sampleValues.slice(0, 3).join(', ')})`,
      description: 'Combines all audio files inside each top-level folder into one recording.',
      granularity: 'folder',
      recommended: !hasChannelField && !hasDates,
      definition: {
        id: `by_${ff.id}`,
        label: 'By Folder',
        granularity: 'folder',
        combineMode: baseCombineMode,
        groupByFieldIds: [ff.id],
        channelFieldId: detectedChannelFieldId,
        sortBy: hasDates ? 'timestamp' : 'name',
        rootPrefix,
        includeSubfolders,
        updatedAt: now,
      },
    });
  }

  // 4. All files combined as one continuous recording
  if (files.length >= 2) {
    rawSuggestions.push({
      id: 'all_combined',
      title: hasChannelField
        ? 'Single Continuous Recording (All Files, Multi-Channel)'
        : 'Single Continuous Recording (All Files)',
      description: 'Combines every scanned audio file in this source into one continuous timeline.',
      granularity: 'all',
      recommended: false,
      definition: {
        id: 'all_combined',
        label: options?.sourceLabel ? `${options.sourceLabel} (All Combined)` : 'All Files Combined',
        granularity: 'all',
        combineMode: baseCombineMode,
        groupByFieldIds: [],
        channelFieldId: detectedChannelFieldId,
        sortBy: hasDates ? 'timestamp' : 'name',
        rootPrefix,
        includeSubfolders,
        updatedAt: now,
      },
    });
  }

  // 5. Individual files (no combining)
  rawSuggestions.push({
    id: 'individual',
    title: 'Individual Files (No Combining)',
    description: 'Treat each audio file as a separate recording.',
    granularity: 'individual',
    recommended: !hasChannelField && !hasDates && categoryFields.length === 0 && folderFields.length === 0,
    definition: {
      id: 'individual',
      label: 'Individual Files',
      granularity: 'individual',
      combineMode: 'individual',
      groupByFieldIds: [],
      channelFieldId: null,
      sortBy: hasDates ? 'timestamp' : 'name',
      rootPrefix,
      includeSubfolders: false,
      updatedAt: now,
    },
  });

  // Evaluate each suggestion to compute exact preview counts & deduplicate identical groupings
  const evaluated: RecordingStructureSuggestion[] = [];
  const seenSignatures = new Set<string>();

  for (const cand of rawSuggestions) {
    const recs = buildDefinedRecordings(files, cand.definition);
    const sig = `${cand.definition.combineMode}::${recs.map((r) => `${r.fileCount}x${r.channelCount}`).join(',')}`;
    // Always keep 'channel_group', 'by_day', 'by_month', 'by_year', and 'individual' visible when dates exist;
    // skip redundant intermediate suggestions only if identical to an earlier non-date suggestion
    const isTemporalPreset =
      cand.granularity === 'hour' ||
      cand.granularity === 'day' ||
      cand.granularity === 'month' ||
      cand.granularity === 'year';
    if (seenSignatures.has(sig) && !isTemporalPreset && cand.granularity !== 'individual') {
      continue;
    }
    seenSignatures.add(sig);
    evaluated.push({
      ...cand,
      recordingCount: recs.length,
      sampleRecordings: recs.slice(0, 3).map((r) => ({
        title: r.title,
        fileCount: r.fileCount,
        channelCount: r.channelCount,
        segmentCount: r.segmentCount,
      })),
    });
  }

  // Ensure exactly one recommended suggestion
  if (!evaluated.some((s) => s.recommended) && evaluated.length > 0) {
    evaluated[0].recommended = true;
  }

  return {
    totalAudioFiles: files.length,
    fields,
    detectedChannelFieldId,
    hasDates,
    hasTimes,
    docInsights,
    suggestions: evaluated,
  };
}

/**
 * Recursively scans a source (bounded by maxFiles and maxDepth) to collect audio files
 * along with their relative directory hierarchy for structure analysis and recording grouping.
 */
export async function scanSourceFilesForStructure(
  engine: AudioEngineClient,
  sourceId: string,
  rootPrefix = '',
  options?: {
    maxFiles?: number;
    maxDepth?: number;
    includeSubfolders?: boolean;
    seedEntries?: BrowseEntry[];
    onProgress?: (info: { filesFound: number; foldersScanned: number }) => void;
  },
): Promise<StructureScanResult> {
  const maxFiles = options?.maxFiles ?? 600;
  const maxDepth = options?.includeSubfolders === false ? 0 : (options?.maxDepth ?? 4);
  const files: ScannedAudioFile[] = [];
  const seenUris = new Set<string>();
  let scannedFolders = 0;
  let truncated = false;

  const queue: Array<{ prefix: string; dirParts: string[]; depth: number; preloaded?: BrowseEntry[] }> = [
    { prefix: rootPrefix, dirParts: [], depth: 0, preloaded: options?.seedEntries },
  ];

  while (queue.length > 0 && files.length < maxFiles) {
    const batch = queue.splice(0, 4);
    const results = await Promise.all(
      batch.map(async (node) => {
        scannedFolders++;
        if (node.preloaded) return { node, entries: node.preloaded };
        try {
          const entries = await engine.browseSource(sourceId, node.prefix, 1000);
          return { node, entries };
        } catch {
          return { node, entries: [] as BrowseEntry[] };
        }
      }),
    );

    for (const { node, entries } of results) {
      const sorted = [...entries]
        .filter((e) => e.name !== '..')
        .sort((a, b) => naturalCompareNames(a.name, b.name));

      for (const entry of sorted) {
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        if (entry.isDir) {
          if (node.depth < maxDepth) {
            const folderName = entry.name.replace(/\/+$/, '');
            queue.push({
              prefix: entry.uri,
              dirParts: [...node.dirParts, folderName],
              depth: node.depth + 1,
            });
          } else {
            truncated = true;
          }
        } else if (entry.kind === 'audio' && !seenUris.has(entry.uri)) {
          seenUris.add(entry.uri);
          files.push({
            sourceId,
            uri: entry.uri,
            name: entry.name,
            dirParts: node.dirParts,
            sizeBytes: entry.sizeBytes,
          });
        }
      }
    }

    options?.onProgress?.({ filesFound: files.length, foldersScanned: scannedFolders });
  }

  if (queue.length > 0 && files.length >= maxFiles) {
    truncated = true;
  }

  return {
    files,
    scannedFolders,
    truncated,
    rootPrefix,
  };
}

/**
 * Recursively scans a Google Drive folder for structure analysis and recording grouping.
 */
export async function scanDriveFilesForStructure(
  connectedSourceId: string,
  rootFolderId: string,
  options?: {
    maxFiles?: number;
    maxDepth?: number;
    includeSubfolders?: boolean;
    seedItems?: DriveItem[];
    onProgress?: (info: { filesFound: number; foldersScanned: number }) => void;
  },
): Promise<StructureScanResult> {
  const maxFiles = options?.maxFiles ?? 600;
  const maxDepth = options?.includeSubfolders === false ? 0 : (options?.maxDepth ?? 4);
  const files: ScannedAudioFile[] = [];
  const seenIds = new Set<string>();
  let scannedFolders = 0;
  let truncated = false;

  const queue: Array<{ folderId: string; dirParts: string[]; depth: number; preloaded?: DriveItem[] }> = [
    { folderId: rootFolderId, dirParts: [], depth: 0, preloaded: options?.seedItems },
  ];

  while (queue.length > 0 && files.length < maxFiles) {
    const batch = queue.splice(0, 3);
    const results = await Promise.all(
      batch.map(async (node) => {
        scannedFolders++;
        if (node.preloaded) return { node, items: node.preloaded };
        try {
          const items = await listDriveItems(node.folderId);
          return { node, items };
        } catch {
          return { node, items: [] as DriveItem[] };
        }
      }),
    );

    for (const { node, items } of results) {
      const sorted = [...items].sort((a, b) => naturalCompareNames(a.name, b.name));
      for (const item of sorted) {
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        if (item.isFolder) {
          if (node.depth < maxDepth) {
            queue.push({
              folderId: item.id,
              dirParts: [...node.dirParts, item.name],
              depth: node.depth + 1,
            });
          } else {
            truncated = true;
          }
        } else if (item.kind === 'audio' && !seenIds.has(item.id)) {
          seenIds.add(item.id);
          files.push({
            sourceId: connectedSourceId,
            uri: item.id,
            name: item.name,
            dirParts: node.dirParts,
            sizeBytes: item.sizeBytes,
          });
        }
      }
    }

    options?.onProgress?.({ filesFound: files.length, foldersScanned: scannedFolders });
  }

  return {
    files,
    scannedFolders,
    truncated,
    rootPrefix: rootFolderId,
  };
}

// ---- Persistent Per-Source Recording Definitions ----

export function makeStructureSourceKey(sourceId: string, driveFolderId?: string): string {
  if (sourceId === 'gdrive_oauth' && driveFolderId) {
    return `gdrive_oauth::${driveFolderId}`;
  }
  return sourceId;
}

function loadAllDefinitions(): Record<string, RecordingStructureDefinition> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, RecordingStructureDefinition>;
    }
  } catch {
    // Ignore storage errors
  }
  return {};
}

function writeAllDefinitions(map: Record<string, RecordingStructureDefinition>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota errors
  }
}

export function getSavedRecordingDefinition(
  sourceKey: string,
): RecordingStructureDefinition | null {
  const all = loadAllDefinitions();
  return all[sourceKey] ?? null;
}

export function saveRecordingDefinition(
  sourceKey: string,
  definition: RecordingStructureDefinition,
): void {
  const all = loadAllDefinitions();
  all[sourceKey] = {
    ...definition,
    updatedAt: Date.now(),
  };
  writeAllDefinitions(all);
}

export function clearSavedRecordingDefinition(sourceKey: string): void {
  const all = loadAllDefinitions();
  if (sourceKey in all) {
    delete all[sourceKey];
    writeAllDefinitions(all);
  }
}
