import type { AudioEngineClient, BrowseEntry } from '@syrinxone/shared';
import { listDriveItems, type DriveItem } from '../auth/googleDrive';
import {
  isDocumentationEntryName,
  isStructuredMetadataEntryName,
} from './archiveDocs';
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

export interface ScannedDocEntry {
  sourceId: string;
  uri: string;
  name: string;
  dirParts: string[];
  sizeBytes?: number;
}

export interface StructureScanResult {
  files: ScannedAudioFile[];
  docEntries: ScannedDocEntry[];
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
  hasDiscreteTimeFolders: boolean;
  allowTimeSlices: boolean;
  timeSliceNote: string;
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

interface DocResearchSignals {
  mentionsTimeAligned: boolean;
  mentionsPerFileChannel: boolean;
  mentionsLongCadence: boolean;
  mentionedChannelCount: number | null;
}

const CHANNEL_TOKEN_RE = /^(?:ch|chan|channel|mic|hydrophone|trk|track)[-_]?0*(\d+)$/i;
const ARRAY_UNIT_TOKEN_RE = /^(?:r|rec|receiver|aru|node|sensor|unit|station)[-_]?0*(\d+)$/i;
const STORAGE_KEY = 'syrinxone.recordingDefinitions.v1';

export function isDiscreteTimeFolderName(seg: string): boolean {
  const s = (seg || '').trim();
  if (!s) return false;
  if (/^(19\d{2}|20\d{2})$/.test(s)) return true;
  if (/^(19\d{2}|20\d{2})[-_](0[1-9]|1[0-2])$/.test(s)) return true;
  if (/^(19\d{2}|20\d{2})[-_]?(0[1-9]|1[0-2])[-_]?(0[1-9]|[12]\d|3[01])$/.test(s)) return true;
  if (/^(?:hour|hr|day|wk|week|month|mo|yr|year)[-_]?\d{1,4}$/i.test(s)) return true;
  if (/^(?:hourly|daily|weekly|monthly|yearly)$/i.test(s)) return true;
  if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|tember|ober|ember)?$/i.test(s)) {
    return true;
  }
  return false;
}

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

function parseChannelToken(
  token: string,
  allowArrayUnit = false,
): { label: string; sortNum: number; confidence: 'explicit' | 'array' } | null {
  const m = token.match(CHANNEL_TOKEN_RE);
  if (m) {
    const num = Number(m[1]);
    if (Number.isFinite(num) && num >= 0 && num <= 256) {
      return { label: token.toUpperCase(), sortNum: num, confidence: 'explicit' };
    }
  }
  if (allowArrayUnit) {
    const am = token.match(ARRAY_UNIT_TOKEN_RE);
    if (am) {
      const num = Number(am[1]);
      if (Number.isFinite(num) && num >= 0 && num <= 256) {
        return { label: token.toUpperCase(), sortNum: num, confidence: 'array' };
      }
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
  allowArrayUnit = false,
): {
  fieldId: string;
  label: string;
  sortNum: number;
  confidence: 'explicit' | 'array';
  tokenIndex?: number;
  dirIndex?: number;
} | null {
  // Pass 1: Prefer explicit channel tokens (rightmost first, e.g., BGD_150203_010_CAF.CH1.wav)
  for (let i = tokens.length - 1; i >= 0; i--) {
    const ch = parseChannelToken(tokens[i], false);
    if (ch) {
      return {
        fieldId: `tok:${i}`,
        label: ch.label,
        sortNum: ch.sortNum,
        confidence: ch.confidence,
        tokenIndex: i,
      };
    }
  }
  for (let i = dirParts.length - 1; i >= 0; i--) {
    const ch = parseChannelToken(dirParts[i], false);
    if (ch) {
      return {
        fieldId: `dir:${i}`,
        label: ch.label,
        sortNum: ch.sortNum,
        confidence: ch.confidence,
        dirIndex: i,
      };
    }
  }

  // Pass 2: Array receiver / node tokens (e.g., R1..R9, ARU1..ARU4, Node1..Node4)
  if (allowArrayUnit) {
    for (let i = 0; i < tokens.length; i++) {
      const ch = parseChannelToken(tokens[i], true);
      if (ch) {
        return {
          fieldId: `tok:${i}`,
          label: ch.label,
          sortNum: ch.sortNum,
          confidence: ch.confidence,
          tokenIndex: i,
        };
      }
    }
    for (let i = dirParts.length - 1; i >= 0; i--) {
      const ch = parseChannelToken(dirParts[i], true);
      if (ch) {
        return {
          fieldId: `dir:${i}`,
          label: ch.label,
          sortNum: ch.sortNum,
          confidence: ch.confidence,
          dirIndex: i,
        };
      }
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

function analyzeDocSignals(docText: string): DocResearchSignals {
  const clean = (docText || '').trim();
  if (!clean) {
    return {
      mentionsTimeAligned: false,
      mentionsPerFileChannel: false,
      mentionsLongCadence: false,
      mentionedChannelCount: null,
    };
  }
  const chMatch = clean.match(
    /(\b\d{1,2})\s*[-]?\s*(?:channel|ch\b|mic(?:rophone)?s?|hydrophones?|receivers?|arus?)\b/i,
  );
  const rangeMatch = clean.match(/\b([Rr]|CH|ARU)[-_]?0*1\s*[-–—to]+\s*\1[-_]?0*(\d{1,2})\b/);
  const mentionedChannelCount = chMatch
    ? Number(chMatch[1])
    : rangeMatch
      ? Number(rangeMatch[2])
      : null;

  const mentionsTimeAligned =
    /\b(?:time[- ]?aligned|time[- ]?sync(?:hronized)?|synchronized|simultaneous|concurrent|tdoa|acoustic localization|localization array|synchronizedrecorderarray)\b/i.test(
      clean,
    );
  const mentionsPerFileChannel =
    /\b(?:each file|one (?:audio )?file per|1 from each receiver|separate (?:file|wav)s? for each|each receiver|per[- ]channel files?|aru[_ ]?coords)\b/i.test(
      clean,
    ) || Boolean(rangeMatch);
  const mentionsLongCadence =
    /\b(?:continuous monitoring|24\/7|duty[- ]cycle|24[- ]?hour|multi[- ]?day|daily wav|hourly wav|long[- ]?term archive)\b/i.test(
      clean,
    );

  return {
    mentionsTimeAligned,
    mentionsPerFileChannel,
    mentionsLongCadence,
    mentionedChannelCount:
      mentionedChannelCount !== null && Number.isFinite(mentionedChannelCount)
        ? mentionedChannelCount
        : null,
  };
}

function extractDocumentationInsights(
  docText: string,
  categoricalValues: Set<string>,
  signals: DocResearchSignals,
): { insights: string[]; codeGlossary: Record<string, string> } {
  const insights: string[] = [];
  const codeGlossary: Record<string, string> = {};
  const clean = (docText || '').trim();
  if (!clean) return { insights, codeGlossary };

  if (signals.mentionsTimeAligned && signals.mentionsPerFileChannel) {
    insights.push(
      `Docs state recordings are time-aligned across ${signals.mentionedChannelCount ? `${signals.mentionedChannelCount} receivers/channels` : 'array receivers'} — each file maps to a parallel channel`,
    );
  } else if (signals.mentionsTimeAligned) {
    insights.push(
      `Docs describe a time-synchronized / localization array${signals.mentionedChannelCount ? ` (${signals.mentionedChannelCount} mics/receivers)` : ''}`,
    );
  } else if (signals.mentionedChannelCount) {
    insights.push(`Docs reference ${signals.mentionedChannelCount}-channel / receiver recordings`);
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

function parseAllFiles(
  files: ScannedAudioFile[],
  docSignals?: DocResearchSignals,
): {
  parsed: ParsedFileMetadata[];
  fields: DiscoveredField[];
  detectedChannelFieldId: string | null;
  perChannelFieldIds: Set<string>;
  hasDates: boolean;
  hasTimes: boolean;
  hasDiscreteTimeFolders: boolean;
} {
  if (files.length === 0) {
    return {
      parsed: [],
      fields: [],
      detectedChannelFieldId: null,
      perChannelFieldIds: new Set<string>(),
      hasDates: false,
      hasTimes: false,
      hasDiscreteTimeFolders: false,
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

  // Detect channel field across files (first explicit CH/MIC/HYDROPHONE, plus array receiver tokens R1..R9)
  const channelHits = new Map<
    string,
    { files: number; distinctLabels: Set<string>; confidence: 'explicit' | 'array' }
  >();
  const rawChannels = tokenized.map((item) => {
    const ch = extractChannelFromFile(item.tokens, item.dirParts, true);
    if (ch) {
      const rec = channelHits.get(ch.fieldId) ?? {
        files: 0,
        distinctLabels: new Set<string>(),
        confidence: ch.confidence,
      };
      rec.files++;
      rec.distinctLabels.add(ch.label);
      if (ch.confidence === 'explicit') rec.confidence = 'explicit';
      channelHits.set(ch.fieldId, rec);
    }
    return ch;
  });

  // Also check if a channel token exists across variable positions (use virtual field 'channel:auto')
  let detectedChannelFieldId: string | null = null;
  let detectedConfidence: 'explicit' | 'array' = 'explicit';
  let bestChannelScore = 0;
  for (const [fid, stats] of channelHits.entries()) {
    if (stats.distinctLabels.size >= 2 && stats.files >= 2) {
      const weightedScore = stats.files + (stats.confidence === 'explicit' ? 1000 : 0);
      if (weightedScore > bestChannelScore) {
        bestChannelScore = weightedScore;
        detectedChannelFieldId = fid;
        detectedConfidence = stats.confidence;
      }
    }
  }
  const totalWithAnyChannel = rawChannels.filter(Boolean).length;
  const allDistinctChannels = new Set(rawChannels.filter(Boolean).map((c) => c!.label));
  if (!detectedChannelFieldId && allDistinctChannels.size >= 2 && totalWithAnyChannel >= 2) {
    detectedChannelFieldId = 'channel:auto';
    detectedConfidence = rawChannels.some((c) => c?.confidence === 'explicit') ? 'explicit' : 'array';
  }

  // Parse each file into values + timestamp + nonChannelStem
  let hasDates = false;
  let hasTimes = false;
  const discreteTimeFolderVals = new Set<string>();
  const parsed: ParsedFileMetadata[] = tokenized.map((item, idx) => {
    const values: Record<string, string> = {};
    let parentWasTime = false;
    for (let d = 0; d < item.dirParts.length; d++) {
      const seg = item.dirParts[d];
      values[`dir:${d}`] = seg;
      const isSegTime: boolean =
        isDiscreteTimeFolderName(seg) ||
        (parentWasTime && /^(0?[1-9]|[12]\d|3[01])$/.test(seg));
      if (isSegTime) {
        discreteTimeFolderVals.add(`${d}:${seg}`);
      }
      parentWasTime = isSegTime;
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

  const hasDiscreteTimeFolders = discreteTimeFolderVals.size >= 2;

  // Validate channel grouping:
  // 1) Matched nonChannelStem pairs >= 2 channels (e.g. CHiME-3 CH1..CH6)
  // 2) OR synchronized/time-aligned array where receiver tokens (R1..R9) span files with per-device IDs/offsets
  if (detectedChannelFieldId) {
    const stemChannels = new Map<string, Set<string>>();
    const channelCounts = new Map<string, number>();
    for (const p of parsed) {
      if (!p.channelLabel) continue;
      const set = stemChannels.get(p.nonChannelStem) ?? new Set<string>();
      set.add(p.channelLabel);
      stemChannels.set(p.nonChannelStem, set);
      channelCounts.set(p.channelLabel, (channelCounts.get(p.channelLabel) ?? 0) + 1);
    }
    const hasPairedMultiCh = Array.from(stemChannels.values()).some((s) => s.size >= 2);
    const coverage = totalWithAnyChannel / Math.max(1, parsed.length);
    const docsSupportArray = Boolean(
      docSignals?.mentionsTimeAligned || docSignals?.mentionsPerFileChannel,
    );
    const looksLikeSynchronizedArray =
      allDistinctChannels.size >= 2 &&
      coverage >= 0.75 &&
      (docsSupportArray ||
        detectedConfidence === 'explicit' ||
        Array.from(channelCounts.values()).every((cnt) => cnt === 1));

    if (!hasPairedMultiCh && !looksLikeSynchronizedArray) {
      detectedChannelFieldId = null;
    }
  }

  // Detect fields whose values are 1-to-1 with individual channels (e.g., per-receiver serial numbers or clock offsets)
  const perChannelFieldIds = new Set<string>();
  if (detectedChannelFieldId) {
    const checkIds: string[] = [];
    for (let d = 0; d < maxDirLen; d++) checkIds.push(`dir:${d}`);
    for (let t = 0; t < maxTokLen; t++) checkIds.push(`tok:${t}`);
    for (const fid of checkIds) {
      if (fid === detectedChannelFieldId) continue;
      const valToChannels = new Map<string, Set<string>>();
      let rowsWithBoth = 0;
      for (const p of parsed) {
        const v = p.values[fid];
        const ch = p.values[detectedChannelFieldId] ?? p.channelLabel;
        if (!v || !ch) continue;
        rowsWithBoth++;
        const chSet = valToChannels.get(v) ?? new Set<string>();
        chSet.add(ch);
        valToChannels.set(v, chSet);
      }
      if (rowsWithBoth >= 2 && valToChannels.size >= 2) {
        const singleChannelVals = Array.from(valToChannels.values()).filter((s) => s.size === 1).length;
        if (singleChannelVals / valToChannels.size >= 0.85) {
          perChannelFieldIds.add(fid);
        }
      }
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
        sampleValues: vals.slice(0, 16),
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
      sampleValues: vals.slice(0, 16),
      uniqueCount: vals.length,
    });
  }

  return {
    parsed,
    fields,
    detectedChannelFieldId,
    perChannelFieldIds,
    hasDates,
    hasTimes,
    hasDiscreteTimeFolders,
  };
}

function buildRecordingTitle(
  groupValues: Record<string, string>,
  groupByFieldIds: string[],
  items: ParsedFileMetadata[],
  fallbackLabel: string,
  channelLabels: string[] = [],
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
  if (channelLabels.length >= 2) {
    const chRange = `${channelLabels[0]}–${channelLabels[channelLabels.length - 1]}`;
    return fallbackLabel.includes(chRange) ? fallbackLabel : `${fallbackLabel} (${chRange})`;
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
        startDateTimeIso:
          p.timestampMs !== null && Number.isFinite(p.timestampMs)
            ? new Date(p.timestampMs).toISOString()
            : null,
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

  let stemHasMultiChPairs = false;
  if (definition.combineMode === 'channels' && definition.groupByFieldIds.length === 0) {
    const stemCounts = new Map<string, number>();
    for (const p of parsed) {
      stemCounts.set(p.nonChannelStem, (stemCounts.get(p.nonChannelStem) ?? 0) + 1);
    }
    stemHasMultiChPairs = Array.from(stemCounts.values()).some((c) => c >= 2);
  }

  for (const p of parsed) {
    const gv: Record<string, string> = {};
    let keyParts: string[];

    if (definition.combineMode === 'channels' && definition.groupByFieldIds.length === 0) {
      if (stemHasMultiChPairs) {
        // Pair files sharing identical non-channel stem (e.g., CHiME-3 CH1..CH6 per utterance)
        keyParts = [p.nonChannelStem];
        gv['stem'] = p.nonChannelStem.split('::').pop()?.replace(/_/g, ' ') || p.file.name;
      } else {
        // Synchronized array whose per-receiver stems differ (e.g., R1..R9 with device serials/clock offsets)
        keyParts = [];
      }
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
      const chFieldId = definition.channelFieldId!;
      // 1. Try pairing items by shared nonChannelStem (e.g., CHiME-3 F01_...CH1..CH6)
      const stemSliceMap = new Map<string, ParsedFileMetadata[]>();
      for (const item of items) {
        const list = stemSliceMap.get(item.nonChannelStem) ?? [];
        list.push(item);
        stemSliceMap.set(item.nonChannelStem, list);
      }

      const stemPairsMultiple = Array.from(stemSliceMap.values()).some((list) => list.length >= 2);
      let sliceGroups: ParsedFileMetadata[][];

      if (stemPairsMultiple) {
        sliceGroups = Array.from(stemSliceMap.values());
      } else {
        // 2. Fallback for synchronized/time-aligned arrays (e.g., R1..R9 with distinct logger IDs/clock offsets):
        // group by channel label, sort each channel's segments, and zip slice-by-slice across channels
        const byChannel = new Map<string, ParsedFileMetadata[]>();
        for (const item of items) {
          const chKey = item.values[chFieldId] ?? item.channelLabel ?? item.file.name;
          const list = byChannel.get(chKey) ?? [];
          list.push(item);
          byChannel.set(chKey, list);
        }
        for (const list of byChannel.values()) {
          list.sort((a, b) => {
            if (definition.sortBy === 'timestamp' && a.timestampMs !== null && b.timestampMs !== null) {
              if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
            }
            return naturalCompareNames(a.file.name, b.file.name);
          });
        }
        const maxSlices = Math.max(1, ...Array.from(byChannel.values()).map((l) => l.length));
        sliceGroups = [];
        for (let i = 0; i < maxSlices; i++) {
          const parallel: ParsedFileMetadata[] = [];
          for (const list of byChannel.values()) {
            if (list[i]) parallel.push(list[i]);
          }
          if (parallel.length > 0) sliceGroups.push(parallel);
        }
      }

      const slices = sliceGroups.map((chItems) => {
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
          const chLbl = c.values[chFieldId] ?? c.channelLabel ?? `CH${idx + 1}`;
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
      .filter((ms): ms is number => ms !== null && Number.isFinite(ms))
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
      channelLabels,
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
  const docSignals = analyzeDocSignals(options?.docText ?? '');
  const {
    parsed,
    fields,
    detectedChannelFieldId,
    perChannelFieldIds,
    hasDates,
    hasTimes,
    hasDiscreteTimeFolders,
  } = parseAllFiles(files, docSignals);

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
    docSignals,
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

  // Filter out per-channel hardware serials / clock-offset tokens from recording-splitting fields
  const categoryFields = fields.filter(
    (f) => f.role === 'category' && !perChannelFieldIds.has(f.id),
  );
  const folderFields = fields.filter(
    (f) => f.role === 'folder' && !perChannelFieldIds.has(f.id),
  );
  const sessionFields = fields.filter(
    (f) => f.role === 'session' && !perChannelFieldIds.has(f.id),
  );
  const hasChannelField = Boolean(detectedChannelFieldId);
  const baseCombineMode: CombineStructureMode = hasChannelField ? 'channels_and_time' : 'time';
  const rootPrefix = options?.rootPrefix ?? '';
  const includeSubfolders = options?.includeSubfolders ?? true;
  const now = Date.now();

  // Evaluate whether time-increment slicing / grouping (hour, day, month, year) is applicable:
  // ONLY offer time slices when the recording will be long OR files live in discrete time folders.
  const chField = hasChannelField
    ? fields.find((f) => f.id === detectedChannelFieldId)
    : undefined;
  const estChannels = Math.max(1, chField?.uniqueCount ?? 1);
  const totalSizeBytes = files.reduce((acc, f) => acc + (f.sizeBytes ?? 0), 0);
  const maxSingleFileBytes = files.reduce((m, f) => Math.max(m, f.sizeBytes ?? 0), 0);
  const perTimelineBytes = totalSizeBytes / estChannels;

  const dayCount = fields.find((f) => f.id === 'date:day')?.uniqueCount ?? 0;
  const monthCount = fields.find((f) => f.id === 'date:month')?.uniqueCount ?? 0;
  const yearCount = fields.find((f) => f.id === 'date:year')?.uniqueCount ?? 0;
  const hourCount = fields.find((f) => f.id === 'date:hour')?.uniqueCount ?? 0;
  const isSingleSynchronizedArray =
    hasChannelField &&
    estChannels >= 2 &&
    files.length <= estChannels &&
    !hasDiscreteTimeFolders;

  const isLongArchive =
    maxSingleFileBytes > 20 * 1024 * 1024 ||
    perTimelineBytes > 60 * 1024 * 1024 ||
    dayCount >= 2 ||
    (!docSignals.mentionsTimeAligned && !isSingleSynchronizedArray && hourCount >= 2) ||
    (docSignals.mentionsLongCadence && Math.ceil(files.length / estChannels) >= 2);

  const allowTimeSlices = hasDiscreteTimeFolders || isLongArchive;
  const timeSliceNote = allowTimeSlices
    ? hasDiscreteTimeFolders
      ? 'Discrete time-increment folders detected — hour/day/month/year grouping available.'
      : 'Long or multi-period recording detected — time-increment grouping available.'
    : files.length > 0
      ? 'Short recording without discrete time-increment folders — time slices omitted.'
      : '';

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
    ...(allowTimeSlices && dayCount >= 2 ? ['date:day'] : []),
    ...folderFields.map((f) => f.id),
    ...categoryFields.map((f) => f.id),
    ...sessionFields.map((f) => f.id),
  ];

  // 1. Multi-channel per-session / synchronized-array combining
  //    (e.g., OpenSoundscape R1..R9 -> 1 9-channel recording; CHiME-3 CH1..CH6 -> 1 recording per session)
  if (hasChannelField && detectedChannelFieldId) {
    const chRangeText =
      chField && chField.sampleValues.length >= 2
        ? `${chField.sampleValues[0]}–${chField.sampleValues[chField.sampleValues.length - 1]}`
        : 'multi-channel';
    const isSyncArray =
      docSignals.mentionsTimeAligned ||
      docSignals.mentionsPerFileChannel ||
      (nonChannelIdentityIds.length === 0 && estChannels >= 2);
    const def: RecordingStructureDefinition = {
      id: 'channel_group',
      label: isSyncArray
        ? `Synchronized ${estChannels}-Channel Array`
        : `Combined Channels per Session (${chRangeText})`,
      granularity: 'channel_group',
      combineMode: 'channels',
      groupByFieldIds: isSyncArray && dayCount <= 1 ? [] : nonChannelIdentityIds,
      channelFieldId: detectedChannelFieldId,
      sortBy: hasDates ? 'timestamp' : 'name',
      rootPrefix,
      includeSubfolders,
      updatedAt: now,
    };
    rawSuggestions.push({
      id: 'channel_group',
      title: isSyncArray
        ? `Stack Synchronized Array Channels (${chRangeText})`
        : `Combine Channels per Recording (${chRangeText})`,
      description: isSyncArray
        ? `Combines time-aligned ${chRangeText} files into a single ${estChannels}-channel recording.`
        : `Stacks synchronized ${chRangeText} files into a single multi-channel recording for each session.`,
      granularity: 'channel_group',
      recommended: true,
      rationale: docSignals.mentionsTimeAligned
        ? `Documentation confirms files are time-aligned across ${chField?.uniqueCount ?? estChannels} receivers (${chRangeText}).`
        : `Detected ${chField?.uniqueCount ?? 'multiple'} paired channel/receiver tracks (${chRangeText}).`,
      definition: def,
    });
  }

  const siteContextIds = [
    ...folderFields.slice(0, 1).map((f) => f.id),
    ...categoryFields.slice(0, 1).map((f) => f.id),
  ];

  // 2. Time granularities: ONLY offer when recording is long OR stored in discrete time folders
  if (allowTimeSlices) {
    if (hasTimes && (hourCount >= 2 || hasDiscreteTimeFolders)) {
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

    if (hasDates && (dayCount >= 2 || hasDiscreteTimeFolders || maxSingleFileBytes > 20 * 1024 * 1024)) {
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
          ? 'Long or time-organized recordings detected — daily groups balance overview and navigation.'
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
    }

    if (hasDates && (monthCount >= 2 || hasDiscreteTimeFolders)) {
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
    }

    if (hasDates && (yearCount >= 2 || hasDiscreteTimeFolders)) {
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
  }

  // 3. Categorical / Site / Folder grouping (e.g., CAF, BUS, PED, STR or deployment folders)
  if (categoryFields.length > 0) {
    const cf = categoryFields[0];
    rawSuggestions.push({
      id: `by_${cf.id}`,
      title: `Separate by ${cf.label}`,
      description: `Combines all files sharing each ${cf.label.toLowerCase()} value into one recording.`,
      granularity: 'category',
      recommended: !hasChannelField && !allowTimeSlices,
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
      recommended: !hasChannelField && !allowTimeSlices,
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

  // 4. All files combined as one continuous/multi-channel recording (when not already covered cleanly)
  if (files.length >= 2) {
    rawSuggestions.push({
      id: 'all_combined',
      title: hasChannelField
        ? 'Single Multi-Channel Recording (All Files)'
        : 'Single Continuous Recording (All Files)',
      description: hasChannelField
        ? 'Combines every scanned audio file into one synchronized multi-channel recording.'
        : 'Combines every scanned audio file in this source into one continuous timeline.',
      granularity: 'all',
      recommended: false,
      definition: {
        id: 'all_combined',
        label: options?.sourceLabel ? `${options.sourceLabel} (Combined)` : 'All Files Combined',
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
    recommended:
      !hasChannelField &&
      !allowTimeSlices &&
      categoryFields.length === 0 &&
      folderFields.length === 0,
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
    hasDiscreteTimeFolders,
    allowTimeSlices,
    timeSliceNote,
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
  const maxFolders = 120;
  const files: ScannedAudioFile[] = [];
  const docEntries: ScannedDocEntry[] = [];
  const seenUris = new Set<string>();
  const seenDocUris = new Set<string>();
  const visitedPrefixes = new Set<string>([rootPrefix]);
  let scannedFolders = 0;
  let truncated = false;

  const queue: Array<{ prefix: string; dirParts: string[]; depth: number; preloaded?: BrowseEntry[] }> = [
    { prefix: rootPrefix, dirParts: [], depth: 0, preloaded: options?.seedEntries },
  ];

  while (queue.length > 0 && files.length < maxFiles && scannedFolders < maxFolders) {
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
          if (node.depth < maxDepth && !visitedPrefixes.has(entry.uri)) {
            visitedPrefixes.add(entry.uri);
            const folderName = entry.name.replace(/\/+$/, '');
            queue.push({
              prefix: entry.uri,
              dirParts: [...node.dirParts, folderName],
              depth: node.depth + 1,
            });
          } else if (node.depth >= maxDepth) {
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
        } else if (
          docEntries.length < 16 &&
          !seenDocUris.has(entry.uri) &&
          (isDocumentationEntryName(entry.name) || isStructuredMetadataEntryName(entry.name))
        ) {
          seenDocUris.add(entry.uri);
          docEntries.push({
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

  if (queue.length > 0 && (files.length >= maxFiles || scannedFolders >= maxFolders)) {
    truncated = true;
  }

  return {
    files,
    docEntries,
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
  const maxFolders = 120;
  const files: ScannedAudioFile[] = [];
  const docEntries: ScannedDocEntry[] = [];
  const seenIds = new Set<string>();
  const seenDocIds = new Set<string>();
  const visitedFolders = new Set<string>([rootFolderId]);
  let scannedFolders = 0;
  let truncated = false;

  const queue: Array<{ folderId: string; dirParts: string[]; depth: number; preloaded?: DriveItem[] }> = [
    { folderId: rootFolderId, dirParts: [], depth: 0, preloaded: options?.seedItems },
  ];

  while (queue.length > 0 && files.length < maxFiles && scannedFolders < maxFolders) {
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
          if (node.depth < maxDepth && !visitedFolders.has(item.id)) {
            visitedFolders.add(item.id);
            queue.push({
              folderId: item.id,
              dirParts: [...node.dirParts, item.name],
              depth: node.depth + 1,
            });
          } else if (node.depth >= maxDepth) {
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
        } else if (
          docEntries.length < 16 &&
          !seenDocIds.has(item.id) &&
          (item.isDoc ||
            isDocumentationEntryName(item.name) ||
            isStructuredMetadataEntryName(item.name))
        ) {
          seenDocIds.add(item.id);
          docEntries.push({
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

  if (queue.length > 0 && (files.length >= maxFiles || scannedFolders >= maxFolders)) {
    truncated = true;
  }

  return {
    files,
    docEntries,
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
