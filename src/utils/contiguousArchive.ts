import type {
  AudioEngineClient,
  DisplaySettings,
  SpectrogramParams,
  TimeFreqRange,
} from '@syrinxone/shared';
import { listDriveItems, type DriveItem } from '../auth/googleDrive';
import type { AutoGainMode } from './spectrogramFetch';
import { parseTimestampFromName } from './timeFormat';

export interface ArchiveEntryLike {
  name: string;
  uri: string;
  isDir: boolean;
  sizeBytes?: number;
  kind?: 'audio' | 'annotation' | 'other';
}

export interface ContiguousGroup {
  groupId: string;
  targetKind: 'files' | 'folders';
  label: string;
  seriesSkeleton: string;
  reason: 'timestamp' | 'date' | 'sequence';
  entries: ArchiveEntryLike[];
  totalSizeBytes: number;
}

export interface SegmentSourceSpec {
  sourceId: string;
  uri: string;
  name: string;
  sizeBytes?: number;
  folderName?: string;
  /** Optional synchronized per-channel files (e.g. CH1..CH6) stacked as virtual channels 0..K-1. */
  channelFiles?: SegmentSourceSpec[];
}

export interface SavedRecordingViewState {
  recordingKey: string;
  kind: 'single' | 'combined';
  sourceId: string;
  uri: string;
  label: string;
  segments?: SegmentSourceSpec[];
  windowStartSec: number;
  windowDurationSec?: number;
  viewRange?: TimeFreqRange;
  channel?: number;
  specParams?: Partial<SpectrogramParams>;
  displaySettings?: Partial<DisplaySettings>;
  autoGainMode?: AutoGainMode;
  startDateTimeIso?: string | null;
  totalDurationSec?: number;
  lastViewedAt: number;
}

export type CombineDecision = 'combine' | 'single';

interface ArchivePrefsStorage {
  combineChoices: Record<string, { decision: CombineDecision; updatedAt: number }>;
  viewStates: Record<string, SavedRecordingViewState>;
}

const ARCHIVE_PREFS_KEY = 'syrinxone.archivePrefs.v1';
const MAX_SAVED_VIEWS = 40;

interface ParsedSeriesToken {
  skeleton: string;
  sortValue: number;
  reason: 'timestamp' | 'date' | 'sequence';
  rawToken: string;
}

function parseTimestampToken(name: string): ParsedSeriesToken | null {
  const ts = parseTimestampFromName(name);
  if (ts) {
    return {
      skeleton: ts.skeleton,
      sortValue: ts.ms,
      reason: ts.reason,
      rawToken: ts.rawToken,
    };
  }

  // Strip extension for files (keep case-insensitive ext in skeleton)
  const extMatch = !name.endsWith('/') ? name.match(/(\.[a-z0-9]{2,5})$/i) : null;
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  const stem = ext ? name.slice(0, -ext.length) : name.replace(/\/+$/, '');

  // Pattern 4: Numeric sequence token (e.g., "01", "02", "rec_001.wav", "part-12.flac")
  const seqMatches = Array.from(stem.matchAll(/(\d+)/g));
  if (seqMatches.length > 0) {
    const last = seqMatches[seqMatches.length - 1];
    if (last.index !== undefined) {
      const skel = `${stem.slice(0, last.index)}<SEQ>${stem.slice(last.index + last[0].length)}${ext}`;
      return {
        skeleton: skel.toLowerCase(),
        sortValue: Number(last[0]),
        reason: 'sequence',
        rawToken: last[0],
      };
    }
  }

  return null;
}

export function naturalCompareNames(a: string, b: string): number {
  const ta = parseTimestampToken(a);
  const tb = parseTimestampToken(b);
  if (ta && tb && ta.reason === tb.reason && ta.skeleton === tb.skeleton) {
    return ta.sortValue - tb.sortValue;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function stripFileExtension(name: string): string {
  return name.replace(/\/+$/, '').replace(/\.[a-z0-9]{2,5}$/i, '');
}

function extractCleanSeriesStem(name: string): string {
  const stem = stripFileExtension(name);
  const parsed = parseTimestampFromName(name);
  let cleaned = stem;
  if (parsed?.rawToken) {
    cleaned = cleaned.replace(parsed.rawToken, ' ');
  }
  // Remove trailing/orphaned sequence numbers or UTC 'Z' markers left behind
  cleaned = cleaned
    .replace(/(?:^|[-_\s])Z(?=$|[-_\s])/gi, ' ')
    .replace(/[-_\s]+/g, ' ')
    .trim();
  return cleaned;
}

function formatShortDateSpan(startMs: number, endMs: number, includeTime: boolean): string {
  const s = new Date(startMs);
  const e = new Date(endMs);
  const sy = s.getUTCFullYear();
  const sm = String(s.getUTCMonth() + 1).padStart(2, '0');
  const sd = String(s.getUTCDate()).padStart(2, '0');
  const sh = String(s.getUTCHours()).padStart(2, '0');
  const smi = String(s.getUTCMinutes()).padStart(2, '0');

  const ey = e.getUTCFullYear();
  const em = String(e.getUTCMonth() + 1).padStart(2, '0');
  const ed = String(e.getUTCDate()).padStart(2, '0');
  const eh = String(e.getUTCHours()).padStart(2, '0');
  const emi = String(e.getUTCMinutes()).padStart(2, '0');

  const sameDay = sy === ey && sm === em && sd === ed;
  if (sameDay) {
    if (includeTime) {
      return `${sy}-${sm}-${sd} ${sh}:${smi}–${eh}:${emi}`;
    }
    return `${sy}-${sm}-${sd}`;
  }
  if (sy === ey && sm === em) {
    return `${sy}-${sm}-${sd}–${ed}`;
  }
  if (sy === ey) {
    return `${sy}-${sm}-${sd}–${em}-${ed}`;
  }
  return `${sy}-${sm}-${sd}–${ey}-${em}-${ed}`;
}

/**
 * Generates a single concise, human-readable recording title for a combined recording
 * instead of concatenating long first/last filenames.
 */
export function formatCombinedRecordingTitle(
  items: Array<{ name: string; folderName?: string; uri?: string }>,
  fallbackFolder?: string,
): string {
  if (items.length === 0) return 'Combined Recording';
  const firstRaw = items[0].name.replace(/\/+$/, '');
  if (items.length === 1) return firstRaw;

  const lastRaw = items[items.length - 1].name.replace(/\/+$/, '');
  const pFirst = parseTimestampFromName(firstRaw);
  const pLast = parseTimestampFromName(lastRaw);

  if (pFirst && pLast && pFirst.reason === pLast.reason && pFirst.skeleton === pLast.skeleton) {
    const stem = extractCleanSeriesStem(firstRaw);
    const span = formatShortDateSpan(
      Math.min(pFirst.ms, pLast.ms),
      Math.max(pFirst.ms, pLast.ms),
      pFirst.hasTime && pLast.hasTime,
    );
    const base = stem || fallbackFolder?.replace(/\/+$/, '') || 'Recording';
    return `${base} (${span})`;
  }

  const seqFirst = parseTimestampToken(firstRaw);
  const seqLast = parseTimestampToken(lastRaw);
  if (
    seqFirst?.reason === 'sequence' &&
    seqLast?.reason === 'sequence' &&
    seqFirst.skeleton === seqLast.skeleton
  ) {
    const stem = stripFileExtension(firstRaw)
      .replace(new RegExp(`${seqFirst.rawToken}$`), '')
      .replace(/[-_\s]+$/g, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    const base = stem || fallbackFolder?.replace(/\/+$/, '') || 'Recording';
    return `${base} (${seqFirst.rawToken}–${seqLast.rawToken})`;
  }

  const uniqueFolders = Array.from(
    new Set(items.map((i) => i.folderName?.replace(/\/+$/, '').trim()).filter(Boolean)),
  ) as string[];
  if (uniqueFolders.length === 1) {
    return `${uniqueFolders[0]} (${items.length} files)`;
  }

  const cleanFallback = fallbackFolder?.replace(/\/+$/, '').trim();
  if (cleanFallback) {
    return `${cleanFallback} (${items.length} files)`;
  }

  // Fallback: clean stem of first item + count
  const s1 = stripFileExtension(firstRaw);
  const s2 = stripFileExtension(lastRaw);
  let commonLen = 0;
  const maxCommon = Math.min(s1.length, s2.length);
  while (commonLen < maxCommon && s1[commonLen].toLowerCase() === s2[commonLen].toLowerCase()) {
    commonLen++;
  }
  const commonPrefix = s1
    .slice(0, commonLen)
    .replace(/[-_\s.]+$/g, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (commonPrefix.length >= 4) {
    return `${commonPrefix} (${items.length} files)`;
  }
  return `${s1} (+${items.length - 1})`;
}

/**
 * Normalizes a file entry into separate folder and filename display parts.
 */
export function splitFolderAndFile(
  entryName: string,
  entryUri: string,
  activePrefix = '',
): { folder: string; file: string } {
  const cleanName = entryName.replace(/\/+$/, '');
  if (cleanName.includes('/')) {
    const idx = cleanName.lastIndexOf('/');
    return {
      folder: cleanName.slice(0, idx),
      file: cleanName.slice(idx + 1),
    };
  }
  const normUri = entryUri.replace(/\\/g, '/').replace(/\/+$/, '');
  const normPfx = activePrefix.replace(/\\/g, '/').replace(/\/+$/, '');
  let folder = '';
  if (normPfx) {
    const pfxTail = normPfx.split('/').filter(Boolean).pop() ?? '';
    folder = pfxTail;
  } else if (normUri.includes('/')) {
    const parts = normUri.split('/').filter(Boolean);
    if (parts.length >= 2) {
      folder = parts[parts.length - 2];
    }
  }
  return { folder, file: cleanName };
}

function buildGroupLabel(entries: ArchiveEntryLike[], kind: 'files' | 'folders'): string {
  if (entries.length === 0) return '';
  void kind;
  return formatCombinedRecordingTitle(entries);
}

/**
 * Detects contiguous recording sequences among BOTH audio files and subfolders
 * inside the current directory listing.
 */
export function detectContiguousGroups(entries: ArchiveEntryLike[]): {
  fileGroups: ContiguousGroup[];
  folderGroups: ContiguousGroup[];
  entryToGroup: Map<string, ContiguousGroup>;
} {
  const valid = entries.filter((e) => e.name !== '..');
  const audioFiles = valid.filter((e) => !e.isDir && e.kind === 'audio');
  const folders = valid.filter((e) => e.isDir);

  const clusterEntries = (
    items: ArchiveEntryLike[],
    targetKind: 'files' | 'folders',
  ): ContiguousGroup[] => {
    const buckets = new Map<
      string,
      Array<{ entry: ArchiveEntryLike; parsed: ParsedSeriesToken }>
    >();

    for (const entry of items) {
      const parsed = parseTimestampToken(entry.name);
      if (!parsed) continue;
      const key = `${parsed.reason}::${parsed.skeleton}`;
      const list = buckets.get(key) ?? [];
      list.push({ entry, parsed });
      buckets.set(key, list);
    }

    const groups: ContiguousGroup[] = [];
    for (const [key, list] of buckets.entries()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.parsed.sortValue - b.parsed.sortValue);

      // For generic pure sequence numbers, make sure there are adjacent / closely spaced steps
      if (list[0].parsed.reason === 'sequence') {
        let contiguousPairs = 0;
        for (let i = 1; i < list.length; i++) {
          const diff = list[i].parsed.sortValue - list[i - 1].parsed.sortValue;
          if (diff >= 1 && diff <= 2) contiguousPairs++;
        }
        if (contiguousPairs === 0) continue;
      }

      const sortedEntries = list.map((x) => x.entry);
      const totalSizeBytes = sortedEntries.reduce((acc, e) => acc + (e.sizeBytes ?? 0), 0);
      groups.push({
        groupId: `${targetKind}:${key}`,
        targetKind,
        label: buildGroupLabel(sortedEntries, targetKind),
        seriesSkeleton: list[0].parsed.skeleton,
        reason: list[0].parsed.reason,
        entries: sortedEntries,
        totalSizeBytes,
      });
    }

    // Put largest / timestamped groups first
    groups.sort((a, b) => {
      if (a.reason !== b.reason) {
        if (a.reason === 'timestamp') return -1;
        if (b.reason === 'timestamp') return 1;
      }
      return b.entries.length - a.entries.length;
    });
    return groups;
  };

  const fileGroups = clusterEntries(audioFiles, 'files');
  const folderGroups = clusterEntries(folders, 'folders');

  const entryToGroup = new Map<string, ContiguousGroup>();
  for (const g of [...fileGroups, ...folderGroups]) {
    for (const e of g.entries) {
      entryToGroup.set(e.uri, g);
    }
  }

  return { fileGroups, folderGroups, entryToGroup };
}

/**
 * Recursively gather audio files from a user selection mixing files and/or folders
 * on an AudioEngineClient source, ordered chronologically / naturally.
 */
export async function collectAudioSpecsFromSource(
  engine: AudioEngineClient,
  sourceId: string,
  selected: ArchiveEntryLike[],
  maxFiles = Number.POSITIVE_INFINITY,
  maxDepth = 16,
): Promise<SegmentSourceSpec[]> {
  const out: SegmentSourceSpec[] = [];
  const seenUris = new Set<string>();

  const walk = async (items: ArchiveEntryLike[], depth: number, folderLabel?: string) => {
    const sorted = [...items].sort((a, b) => naturalCompareNames(a.name, b.name));
    for (const item of sorted) {
      if (out.length >= maxFiles) break;
      if (item.name === '..') continue;
      if (!item.isDir) {
        if (item.kind === 'audio' && !seenUris.has(item.uri)) {
          seenUris.add(item.uri);
          out.push({
            sourceId,
            uri: item.uri,
            name: item.name,
            sizeBytes: item.sizeBytes,
            folderName: folderLabel,
          });
        }
      } else if (depth < maxDepth) {
        const subEntries = await engine.browseSource(sourceId, item.uri, 1000);
        await walk(
          subEntries.filter((e) => e.name !== '..'),
          depth + 1,
          item.name.replace(/\/+$/, ''),
        );
      }
    }
  };

  await walk(selected, 0);
  out.sort((a, b) => naturalCompareNames(a.name, b.name));
  return out;
}

/**
 * Recursively gather audio files from selected Google Drive items (files and/or folders).
 */
export async function collectAudioSpecsFromDrive(
  selected: DriveItem[],
  connectFolderFn: (folderId: string, folderName: string) => Promise<string>,
  rootFolderSourceId: string | null,
  currentFolderId: string,
  currentFolderName: string,
  maxFiles = Number.POSITIVE_INFINITY,
  maxDepth = 16,
): Promise<{ specs: SegmentSourceSpec[]; connectedSourceId: string }> {
  const activeSourceId =
    rootFolderSourceId || (await connectFolderFn(currentFolderId, currentFolderName));

  const out: SegmentSourceSpec[] = [];
  const seenIds = new Set<string>();

  const walkDrive = async (items: DriveItem[], depth: number, folderLabel?: string) => {
    const sorted = [...items].sort((a, b) => naturalCompareNames(a.name, b.name));
    for (const item of sorted) {
      if (out.length >= maxFiles) break;
      if (!item.isFolder) {
        if (item.kind === 'audio' && !seenIds.has(item.id)) {
          seenIds.add(item.id);
          out.push({
            sourceId: activeSourceId,
            uri: item.id,
            name: item.name,
            sizeBytes: item.sizeBytes,
            folderName: folderLabel,
          });
        }
      } else if (depth < maxDepth) {
        const subItems = await listDriveItems(item.id);
        // If subfolder needs its own connection when browsing outside current folder,
        // connect it if current folder is sharedWithMe root
        await walkDrive(subItems, depth + 1, item.name);
      }
    }
  };

  await walkDrive(selected, 0);
  out.sort((a, b) => naturalCompareNames(a.name, b.name));
  return { specs: out, connectedSourceId: activeSourceId };
}

function loadStorage(): ArchivePrefsStorage {
  try {
    const raw = localStorage.getItem(ARCHIVE_PREFS_KEY);
    if (!raw) return { combineChoices: {}, viewStates: {} };
    const parsed = JSON.parse(raw) as Partial<ArchivePrefsStorage>;
    return {
      combineChoices: parsed.combineChoices ?? {},
      viewStates: parsed.viewStates ?? {},
    };
  } catch {
    return { combineChoices: {}, viewStates: {} };
  }
}

function saveStorage(data: ArchivePrefsStorage): void {
  try {
    // Trim oldest view states if over limit
    const entries = Object.entries(data.viewStates);
    if (entries.length > MAX_SAVED_VIEWS) {
      entries.sort((a, b) => b[1].lastViewedAt - a[1].lastViewedAt);
      data.viewStates = Object.fromEntries(entries.slice(0, MAX_SAVED_VIEWS));
    }
    localStorage.setItem(ARCHIVE_PREFS_KEY, JSON.stringify(data));
  } catch {
    // ignore storage quota errors
  }
}

export function makeArchiveSeriesKey(sourceId: string, folderPrefix: string, groupId?: string): string {
  const normPfx = (folderPrefix || '').replace(/[/\\]+$/, '');
  return groupId ? `${sourceId}::${normPfx}::${groupId}` : `${sourceId}::${normPfx}`;
}

export function makeSingleRecordingKey(sourceId: string, uri: string): string {
  return `single::${sourceId}::${uri}`;
}

export function makeCombinedRecordingKey(
  sourceId: string,
  specs: Array<{ uri: string; channelFiles?: Array<{ uri: string }> }>,
): string {
  if (specs.length === 0) return `combined::${sourceId}::empty`;
  const first = specs[0].uri;
  const last = specs[specs.length - 1].uri;
  const chCount = specs[0].channelFiles?.length ?? 0;
  const chTag = chCount > 1 ? `::ch${chCount}` : '';
  return `combined::${sourceId}::${specs.length}${chTag}::${first}..${last}`;
}

export function getArchiveCombinePref(seriesKey: string): CombineDecision | null {
  const store = loadStorage();
  return store.combineChoices[seriesKey]?.decision ?? null;
}

export function setArchiveCombinePref(
  seriesKey: string,
  decision: CombineDecision | null,
): void {
  const store = loadStorage();
  if (decision === null) {
    delete store.combineChoices[seriesKey];
  } else {
    store.combineChoices[seriesKey] = { decision, updatedAt: Date.now() };
  }
  saveStorage(store);
}

export function getRecordingViewState(recordingKey: string): SavedRecordingViewState | null {
  const store = loadStorage();
  return store.viewStates[recordingKey] ?? null;
}

export function saveRecordingViewState(state: SavedRecordingViewState): void {
  const store = loadStorage();
  store.viewStates[state.recordingKey] = {
    ...state,
    lastViewedAt: Date.now(),
  };
  saveStorage(store);
}

export function listRecentRecordingViewStates(limit = 10): SavedRecordingViewState[] {
  const store = loadStorage();
  return Object.values(store.viewStates)
    .sort((a, b) => b.lastViewedAt - a.lastViewedAt)
    .slice(0, limit);
}

export function removeRecordingViewState(recordingKey: string): void {
  const store = loadStorage();
  delete store.viewStates[recordingKey];
  saveStorage(store);
}
