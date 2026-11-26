import type { AudioEngineClient, BrowseEntry, CreateSourceRequest, DataSourceInfo } from '@syrinxone/shared';
import { readDriveTextFile, type DriveItem } from '../auth/googleDrive';

export interface ArchiveDocLink {
  label: string;
  url: string;
  description?: string;
}

export interface DiscoveredDocFile {
  name: string;
  uri: string;
  sizeBytes?: number;
  kind: 'pdf' | 'text' | 'link';
  externalUrl?: string;
  driveFileId?: string;
  locationLabel?: string;
}

export interface ArchiveAboutSpec {
  sourceId: string;
  title: string;
  kindLabel: string;
  storageUri?: string;
  briefDescription: string;
  deepDescription: string[];
  highlights: Array<{ label: string; value: string }>;
  documentationLinks: ArchiveDocLink[];
  readmeFiles: DiscoveredDocFile[];
  primaryReadmeText?: string;
  primaryReadmeName?: string;
  connectReq?: CreateSourceRequest;
  discoveredFromLive: boolean;
}

export interface ArchiveTargetInput {
  sourceId: string;
  displayName: string;
  kind?: string;
  rootPath?: string;
  description?: string;
  anonymous?: boolean;
  connectReq?: CreateSourceRequest;
  currentPrefix?: string;
  currentEntries?: BrowseEntry[];
  currentDriveItems?: DriveItem[];
  focusDocUri?: string;
}

interface CuratedArchiveMeta {
  title?: string;
  kindLabel?: string;
  storageUri?: string;
  bucket?: string;
  cloudType?: 's3' | 'gcs';
  region?: string;
  briefDescription: string;
  deepDescription: string[];
  highlights: Array<{ label: string; value: string }>;
  documentationLinks: ArchiveDocLink[];
}

const MBARI_BASE_LINKS: ArchiveDocLink[] = [
  {
    label: 'MBARI Pacific Sound Documentation Portal',
    url: 'https://docs.mbari.org/pacific-sound/',
    description: 'Dataset overview, folder layout, hydrophone calibration, and signal processing guide',
  },
  {
    label: 'AWS Registry of Open Data — Pacific Sound',
    url: 'https://registry.opendata.aws/pacific-sound/',
    description: 'Bucket endpoints, update frequency, CC-BY 4.0 license, and citation info',
  },
  {
    label: 'Pacific Sound Jupyter Notebooks (GitHub)',
    url: 'https://github.com/mbari-org/pacific-sound-notebooks',
    description: 'Official Python tutorials for calibrated spectrograms, whale calls, and ambient noise',
  },
  {
    label: 'MBARI MARS Cabled Hydrophone Project',
    url: 'https://www.mbari.org/mars-hydrophone/',
    description: 'Observatory hardware, deep-sea site context (891 m), and scientific background',
  },
];

const NOAA_NCEI_LINKS: ArchiveDocLink[] = [
  {
    label: 'NOAA NCEI Archive Root README (PDF)',
    url: 'https://storage.googleapis.com/noaa-passive-bioacoustic/README.pdf',
    description: 'Bucket root documentation covering organization, metadata standards, and usage',
  },
  {
    label: 'NOAA NCEI Passive Acoustic Data Archive',
    url: 'https://www.ncei.noaa.gov/products/passive-acoustic-data',
    description: 'Official archive home, Tethys / ASA metadata standards, and dataset catalog',
  },
  {
    label: 'NCEI Passive Acoustic Interactive Map',
    url: 'https://www.ncei.noaa.gov/maps/passive-acoustic-data/',
    description: 'Interactive map to browse U.S. & international passive acoustic deployments by site/date',
  },
  {
    label: 'SanctSound Project Portal',
    url: 'https://sanctsound.ioos.us/',
    description: 'NOAA & U.S. Navy Sanctuary Soundscape Monitoring project overview and sound products',
  },
];

const CURATED_ARCHIVES: Record<string, CuratedArchiveMeta> = {
  mbari_2khz: {
    kindLabel: 'AWS S3 Open Data',
    storageUri: 's3://pacific-sound-2khz (us-west-2)',
    bucket: 'pacific-sound-2khz',
    cloudType: 's3',
    region: 'us-west-2',
    briefDescription:
      'MBARI Monterey Bay 2 kHz decimated MARS cabled hydrophone archive (blue, fin & humpback whales; 2015–present; CC-BY 4.0).',
    deepDescription: [
      'Deep-sea passive acoustic monitoring dataset from the Monterey Accelerated Research System (MARS) cabled seafloor observatory in Monterey Bay, California (891 m water depth, operating continuously at ~95% uptime since July 2015).',
      'Audio is decimated from the original 256 kHz hydrophone stream to 2 kHz daily WAV files, specifically optimized for low-frequency bioacoustics (blue whale A/B/D calls, fin whale 20 Hz pulses, humpback whale song), seismic events, and regional shipping noise.',
      'For the 2 kHz product, sensitivity calibration is flat across frequency, enabling direct conversion to calibrated sound pressure levels (dB re 1 µPa) using the published MBARI calibration constants.',
    ],
    highlights: [
      { label: 'Sample Rate', value: '2,000 Hz (0–1,000 Hz Nyquist)' },
      { label: 'Coverage', value: 'July 2015 – present (~24h WAV/day)' },
      { label: 'Location', value: 'Monterey Bay, CA · 891 m depth' },
      { label: 'License', value: 'CC-BY 4.0 · Public anonymous S3' },
    ],
    documentationLinks: MBARI_BASE_LINKS,
  },
  mbari_16khz: {
    kindLabel: 'AWS S3 Open Data',
    storageUri: 's3://pacific-sound-16khz (us-west-2)',
    bucket: 'pacific-sound-16khz',
    cloudType: 's3',
    region: 'us-west-2',
    briefDescription:
      'MBARI Monterey Bay 16 kHz decimated MARS hydrophone archive (whales, dolphins, fish & ocean soundscape; CC-BY 4.0).',
    deepDescription: [
      'Continuous 16 kHz decimated passive acoustic recordings from MBARI’s MARS cabled hydrophone at 891 m depth in Monterey Bay, California (July 2015–present).',
      'With an 8 kHz Nyquist ceiling, the 16 kHz archive captures baleen whales alongside humpback whale harmonics, killer whale pulsed calls, delphinid whistles, pinnipeds, snapping/biological choruses, wind/rain soundscapes, and commercial vessel signatures.',
    ],
    highlights: [
      { label: 'Sample Rate', value: '16,000 Hz (0–8,000 Hz Nyquist)' },
      { label: 'Coverage', value: 'July 2015 – present (24h WAV/day)' },
      { label: 'Location', value: 'Monterey Bay, CA · 891 m depth' },
      { label: 'License', value: 'CC-BY 4.0 · Public anonymous S3' },
    ],
    documentationLinks: MBARI_BASE_LINKS,
  },
  mbari_256khz_2022: {
    kindLabel: 'AWS S3 Open Data',
    storageUri: 's3://pacific-sound-256khz-2022 (us-west-2)',
    bucket: 'pacific-sound-256khz-2022',
    cloudType: 's3',
    region: 'us-west-2',
    briefDescription:
      'Full-bandwidth 256 kHz MARS cabled hydrophone recordings from 2022 (echolocation clicks & full-spectrum soundscape; CC-BY 4.0).',
    deepDescription: [
      'Uncompressed full-rate 256 kHz acoustic telemetry from MBARI’s MARS observatory for 2022 (~128 kHz Nyquist).',
      'Essential for high-frequency odontocete biosonar (harbor porpoises, beaked whales, Risso’s & Pacific white-sided dolphins, sperm whales) and broadband transient studies; requires frequency-dependent hydrophone sensitivity curves published in MBARI’s documentation.',
    ],
    highlights: [
      { label: 'Sample Rate', value: '256,000 Hz (0–128 kHz Nyquist)' },
      { label: 'Year', value: '2022 · Annual S3 Bucket' },
      { label: 'Location', value: 'Monterey Bay, CA · 891 m depth' },
      { label: 'License', value: 'CC-BY 4.0 · Public anonymous S3' },
    ],
    documentationLinks: MBARI_BASE_LINKS,
  },
  mbari_256khz_2023: {
    kindLabel: 'AWS S3 Open Data',
    storageUri: 's3://pacific-sound-256khz-2023 (us-west-2)',
    bucket: 'pacific-sound-256khz-2023',
    cloudType: 's3',
    region: 'us-west-2',
    briefDescription:
      'Full-bandwidth 256 kHz MARS cabled hydrophone recordings from 2023 (echolocation clicks & full-spectrum soundscape; CC-BY 4.0).',
    deepDescription: [
      'Uncompressed full-rate 256 kHz acoustic telemetry from MBARI’s MARS observatory for 2023 (~128 kHz Nyquist).',
      'Captures high-frequency odontocete echolocation clicks, whistles, marine mammal vocalizations, and ocean ambient noise across the full 0–128 kHz acoustic band.',
    ],
    highlights: [
      { label: 'Sample Rate', value: '256,000 Hz (0–128 kHz Nyquist)' },
      { label: 'Year', value: '2023 · Annual S3 Bucket' },
      { label: 'Location', value: 'Monterey Bay, CA · 891 m depth' },
      { label: 'License', value: 'CC-BY 4.0 · Public anonymous S3' },
    ],
    documentationLinks: MBARI_BASE_LINKS,
  },
  noaa_ncei: {
    kindLabel: 'Google Cloud Storage (Public)',
    storageUri: 'gs://noaa-passive-bioacoustic',
    bucket: 'noaa-passive-bioacoustic',
    cloudType: 'gcs',
    briefDescription:
      'NOAA NCEI Passive Acoustic Data Archive on GCS (SanctSound, SoundCoop, DCLDE, ADEON, Arctic/Pacific ocean deployments).',
    deepDescription: [
      'Public cloud repository curated by NOAA’s National Centers for Environmental Information (NCEI), hosting multi-agency passive acoustic monitoring deployments across U.S. coastal waters, National Marine Sanctuaries, Arctic/Pacific observatories, and DCLDE benchmark datasets.',
      'Contains root and project-level README documentation (such as README.pdf and SanctSound deployment READMEs) describing hydrophone instrumentation, duty cycling, calibration, Tethys/ASA metadata, and required dataset citations.',
    ],
    highlights: [
      { label: 'Bucket', value: 'gs://noaa-passive-bioacoustic' },
      { label: 'Collections', value: 'SanctSound, SoundCoop, DCLDE, ADEON, MBARC…' },
      { label: 'Formats', value: 'FLAC, WAV & derived NetCDF/CSV products' },
      { label: 'Docs', value: 'Includes bucket & project README.pdf files' },
    ],
    documentationLinks: NOAA_NCEI_LINKS,
  },
  noaa_sanctsound: {
    kindLabel: 'Google Cloud Storage (Public)',
    storageUri: 'gs://noaa-passive-bioacoustic/sanctsound',
    bucket: 'noaa-passive-bioacoustic',
    cloudType: 'gcs',
    briefDescription:
      'NOAA & U.S. Navy Sanctuary Soundscape Monitoring Project (SanctSound) across 7 U.S. National Marine Sanctuaries (2018–2022).',
    deepDescription: [
      'Standardized acoustic monitoring across seven U.S. National Marine Sanctuaries (Channel Islands, Cordell Bank, Florida Keys, Gray’s Reef, Hawaiian Islands Humpback Whale, Monterey Bay, Olympic Coast, and Stellwagen Bank), using calibrated SoundTrap recorders.',
      'Documents biological soundscapes (whales, dolphins, fish choruses), physical weather events, and vessel traffic across multi-year deployments, paired with project-level README.pdf guides.',
    ],
    highlights: [
      { label: 'Coverage', value: '2018 – 2022 · 7 Marine Sanctuaries' },
      { label: 'Bucket Path', value: 'gs://noaa-passive-bioacoustic/sanctsound' },
      { label: 'Metadata', value: 'Tethys / ASA acoustic metadata standards' },
      { label: 'Docs', value: 'Includes sanctsound/README.pdf & products/README.pdf' },
    ],
    documentationLinks: [
      {
        label: 'SanctSound Bucket README (PDF)',
        url: 'https://storage.googleapis.com/noaa-passive-bioacoustic/sanctsound/README.pdf',
        description: 'SanctSound folder structure, station codes, audio formats, and usage notes',
      },
      {
        label: 'SanctSound Products README (PDF)',
        url: 'https://storage.googleapis.com/noaa-passive-bioacoustic/sanctsound/products/README.pdf',
        description: 'Documentation for SPL, PSD, and biological detection products',
      },
      ...NOAA_NCEI_LINKS.filter((l) => !l.url.endsWith('/README.pdf')),
    ],
  },
  local: {
    kindLabel: 'Local Engine & Device Upload',
    briefDescription:
      'Upload audio files from your browser or browse local folders mounted on the connected SyrinxOne DSP engine.',
    deepDescription: [
      'Direct access to audio recordings stored locally on the machine running the SyrinxOne Python DSP engine, plus drag-and-drop or file-picker uploads from your local browser device.',
      'If a connected folder includes a README.md, README.txt, or notes file alongside recordings, it will appear in the Archive Documentation view.',
    ],
    highlights: [
      { label: 'Supported Formats', value: 'WAV, FLAC, AIFF, OGG, MP3, M4A' },
      { label: 'Access', value: 'Read/Write local clips & annotations' },
    ],
    documentationLinks: [],
  },
  gdrive_oauth: {
    kindLabel: 'Google Drive (OAuth 2.0)',
    briefDescription:
      'Browse and combine personal or shared bioacoustic recording folders from your Google Drive account.',
    deepDescription: [
      'Direct authenticated access to My Drive and Shared With Me folders using your Google account. Supports combining multi-file hydrophone or field-recorder sequences and reading folder-level README.md / README.txt / README.pdf documentation.',
    ],
    highlights: [
      { label: 'Auth', value: 'Google OAuth 2.0 (session Bearer token)' },
      { label: 'Capabilities', value: 'Full folder pagination, multi-file combine, README preview' },
    ],
    documentationLinks: [],
  },
  http: {
    kindLabel: 'Direct HTTPS Audio Stream',
    briefDescription:
      'Open any publicly accessible HTTPS audio recording URL (.wav, .flac, .ogg, .mp3) or shared audio link.',
    deepDescription: [
      'Stream or inspect individual remote audio files by URL with HTTP range requests for partial slices and sparse spectrogram viewing on large remote WAVs.',
    ],
    highlights: [
      { label: 'Supported Input', value: 'Direct https:// WAV / FLAC / OGG / MP3 URLs' },
    ],
    documentationLinks: [],
  },
};

const AUDIO_EXT_RE = /\.(wav|flac|aif|aiff|ogg|mp3|m4a|opus)$/i;
const DOC_NAME_RE =
  /^(readme|about|metadata|notes?|doc(s|umentation)?|citation|license|changelog|manifest|calibration|guide)([._-].*)?$/i;
const DOC_EXT_RE = /\.(md|markdown|pdf|txt|rst|html?)$/i;

export function isDocumentationEntryName(name: string): boolean {
  const clean = name.replace(/\/+$/, '').trim();
  if (!clean || clean === '..' || AUDIO_EXT_RE.test(clean)) return false;
  const base = clean.includes('/') ? clean.slice(clean.lastIndexOf('/') + 1) : clean;
  const stem = base.replace(/\.[a-z0-9]{1,8}$/i, '');
  if (DOC_NAME_RE.test(stem) || DOC_NAME_RE.test(base)) return true;
  if (/\.(md|markdown|pdf|rst)$/i.test(base)) return true;
  return false;
}

export function buildPublicObjectUrl(
  target: ArchiveTargetInput,
  uri: string,
): string | undefined {
  if (/^https?:\/\//i.test(uri)) return uri;
  const curated = resolveCuratedMeta(target);
  const bucket = target.connectReq?.bucket ?? curated?.bucket;
  const cloudType =
    target.connectReq?.kind ??
    curated?.cloudType ??
    (target.kind === 's3' || target.kind === 'gcs' ? target.kind : undefined);
  const region = target.connectReq?.region ?? curated?.region ?? 'us-west-2';
  const cleanUri = uri.replace(/^\/+/, '');
  if (!bucket || !cleanUri) return undefined;

  if (cloudType === 'gcs') {
    return `https://storage.googleapis.com/${bucket}/${cleanUri}`;
  }
  if (cloudType === 's3') {
    return `https://${bucket}.s3.${region}.amazonaws.com/${cleanUri}`;
  }
  return undefined;
}

function resolveCuratedMeta(target: ArchiveTargetInput): CuratedArchiveMeta | undefined {
  if (CURATED_ARCHIVES[target.sourceId]) return CURATED_ARCHIVES[target.sourceId];
  const bucket = target.connectReq?.bucket?.toLowerCase() ?? '';
  const idLower = target.sourceId.toLowerCase();
  if (bucket.includes('pacific-sound-256khz') || idLower.includes('mbari_256khz')) {
    return CURATED_ARCHIVES.mbari_256khz_2022;
  }
  if (bucket === 'pacific-sound-2khz' || idLower.includes('mbari_2khz')) {
    return CURATED_ARCHIVES.mbari_2khz;
  }
  if (bucket === 'pacific-sound-16khz' || idLower.includes('mbari_16khz')) {
    return CURATED_ARCHIVES.mbari_16khz;
  }
  if (bucket === 'noaa-passive-bioacoustic' || idLower.includes('noaa')) {
    if (
      (target.rootPath ?? target.connectReq?.prefix ?? target.currentPrefix ?? '').startsWith('sanctsound') ||
      idLower.includes('sanctsound')
    ) {
      return CURATED_ARCHIVES.noaa_sanctsound;
    }
    return CURATED_ARCHIVES.noaa_ncei;
  }
  return undefined;
}

export function extractBriefSummary(rawText: string, maxChars = 190): string | undefined {
  const lines = rawText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const prose = lines.filter(
    (l) =>
      !l.startsWith('#') &&
      !l.startsWith('```') &&
      !l.startsWith('---') &&
      !l.startsWith('===') &&
      !l.startsWith('![') &&
      !l.startsWith('[!') &&
      l.length > 20,
  );
  const candidate = prose[0] ?? lines[0];
  if (!candidate) return undefined;
  const cleaned = candidate
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

function toDiscoveredDoc(
  name: string,
  uri: string,
  sizeBytes: number | undefined,
  target: ArchiveTargetInput,
  driveFileId?: string,
  locationLabel?: string,
): DiscoveredDocFile {
  const lower = name.toLowerCase();
  const kind: DiscoveredDocFile['kind'] = lower.endsWith('.pdf')
    ? 'pdf'
    : DOC_EXT_RE.test(lower) || !lower.includes('.')
      ? 'text'
      : 'link';
  return {
    name,
    uri,
    sizeBytes,
    kind,
    externalUrl: buildPublicObjectUrl(target, uri),
    driveFileId,
    locationLabel,
  };
}

const discoveryCache = new Map<string, ArchiveAboutSpec>();
const readmeTextCache = new Map<string, string>();

export function buildStaticArchiveAbout(target: ArchiveTargetInput): ArchiveAboutSpec {
  const curated = resolveCuratedMeta(target);
  const storageUri =
    curated?.storageUri ??
    (target.connectReq?.bucket
      ? `${target.connectReq.kind === 'gcs' ? 'gs' : 's3'}://${target.connectReq.bucket}${target.connectReq.prefix ? `/${target.connectReq.prefix}` : ''}`
      : target.rootPath || undefined);

  const brief =
    curated?.briefDescription ??
    target.description?.trim() ??
    (target.kind === 's3'
      ? 'Amazon S3 passive acoustic archive source.'
      : target.kind === 'gcs'
        ? 'Google Cloud Storage bioacoustic archive source.'
        : target.kind === 'gdrive'
          ? 'Google Drive acoustic recording folder.'
          : 'Connected sound source.');

  const deep =
    curated?.deepDescription ??
    (target.description
      ? [target.description]
      : ['Browse audio recordings and any README or metadata documentation files stored in this source.']);

  return {
    sourceId: target.sourceId,
    title: target.displayName || curated?.title || target.sourceId,
    kindLabel:
      curated?.kindLabel ??
      (target.kind === 's3'
        ? 'Amazon S3'
        : target.kind === 'gcs'
          ? 'Google Cloud Storage'
          : target.kind === 'gdrive' || target.sourceId === 'gdrive_oauth'
            ? 'Google Drive'
            : target.kind === 'local_fs'
              ? 'Local Storage'
              : 'Remote Source'),
    storageUri,
    briefDescription: brief,
    deepDescription: deep,
    highlights: curated?.highlights ?? [],
    documentationLinks: [...(curated?.documentationLinks ?? [])],
    readmeFiles: [],
    discoveredFromLive: false,
  };
}

export async function fetchDocTextPreview(
  engine: AudioEngineClient,
  target: ArchiveTargetInput,
  doc: DiscoveredDocFile,
): Promise<string | null> {
  const cacheKey = `${target.sourceId}::${doc.driveFileId ?? doc.uri}`;
  if (readmeTextCache.has(cacheKey)) {
    return readmeTextCache.get(cacheKey)!;
  }

  if (doc.kind === 'pdf') return null;

  // 1. Google Drive authenticated read
  if (doc.driveFileId) {
    try {
      const txt = await readDriveTextFile(doc.driveFileId);
      if (txt.trim()) {
        readmeTextCache.set(cacheKey, txt);
        return txt;
      }
    } catch {
      // fall through
    }
  }

  // 2. Public HTTPS S3/GCS/URL via same-origin CORS-safe proxy
  if (doc.externalUrl && doc.externalUrl.startsWith('https://')) {
    try {
      const res = await fetch(
        `/api/archive-docs/read?url=${encodeURIComponent(doc.externalUrl)}`,
      );
      if (res.ok) {
        const data = (await res.json()) as { text?: string };
        if (data.text && data.text.trim()) {
          const text = data.text.trim();
          readmeTextCache.set(cacheKey, text);
          return text;
        }
      }
    } catch {
      // fall through
    }
  }

  // 3. Fallback for local/connected engine text files via importAnnotationsFromSource nonAnnotationLines
  if (target.sourceId && target.sourceId !== 'gdrive_oauth') {
    try {
      const parsed = await engine.importAnnotationsFromSource(target.sourceId, doc.uri);
      const rawLines = parsed.nonAnnotationLines ?? [];
      if (rawLines.length > 0) {
        const joined = rawLines.join('\n').trim();
        if (joined) {
          readmeTextCache.set(cacheKey, joined);
          return joined;
        }
      }
    } catch {
      // ignore if endpoint only handles structured annotations
    }
  }

  return null;
}

export async function discoverArchiveDocumentation(
  engine: AudioEngineClient,
  target: ArchiveTargetInput,
  options?: { force?: boolean; readText?: boolean },
): Promise<ArchiveAboutSpec> {
  const cacheKey = `${target.sourceId}::${target.currentPrefix ?? target.rootPath ?? ''}::${target.currentEntries?.length ?? 0}::${target.currentDriveItems?.length ?? 0}`;
  if (!options?.force && discoveryCache.has(cacheKey)) {
    const cached = discoveryCache.get(cacheKey)!;
    if (!options?.readText || cached.primaryReadmeText || cached.readmeFiles.every((f) => f.kind === 'pdf')) {
      return cached;
    }
  }

  const base = buildStaticArchiveAbout(target);
  const discovered: DiscoveredDocFile[] = [];
  const seenUri = new Set<string>();

  const pushDoc = (doc: DiscoveredDocFile) => {
    if (seenUri.has(doc.uri)) return;
    seenUri.add(doc.uri);
    discovered.push(doc);
  };

  // Scan already-loaded Drive items if viewing a Drive folder
  if (target.currentDriveItems && target.currentDriveItems.length > 0) {
    for (const item of target.currentDriveItems) {
      if (!item.isFolder && (item.isDoc || isDocumentationEntryName(item.name))) {
        pushDoc(
          toDiscoveredDoc(
            item.name,
            item.id,
            item.sizeBytes,
            target,
            item.id,
            target.currentPrefix || 'Current folder',
          ),
        );
      }
    }
  }

  // Scan already-loaded folder entries (e.g. sanctsound/README.pdf)
  if (target.currentEntries && target.currentEntries.length > 0) {
    for (const entry of target.currentEntries) {
      if (!entry.isDir && isDocumentationEntryName(entry.name)) {
        pushDoc(
          toDiscoveredDoc(
            entry.name,
            entry.uri,
            entry.sizeBytes,
            target,
            undefined,
            target.currentPrefix || 'Current folder',
          ),
        );
      }
    }
  }

  // Also scan source root when connected on engine (non-upload, non-http, non-gdrive_oauth)
  if (
    target.sourceId &&
    target.sourceId !== 'http' &&
    target.sourceId !== 'gdrive_oauth' &&
    target.sourceId !== 'upload'
  ) {
    const rootPfx = target.rootPath ?? target.connectReq?.prefix ?? '';
    try {
      const rootEntries = await engine.browseSource(target.sourceId, rootPfx, 200);
      for (const entry of rootEntries) {
        if (!entry.isDir && isDocumentationEntryName(entry.name)) {
          pushDoc(
            toDiscoveredDoc(
              entry.name,
              entry.uri,
              entry.sizeBytes,
              target,
              undefined,
              rootPfx ? `/${rootPfx}` : 'Archive root',
            ),
          );
        }
      }
    } catch {
      // source might not be connected yet (e.g. unconnected preset) or root unavailable
    }
  }

  // Sort READMEs first
  discovered.sort((a, b) => {
    const aIsReadme = /^readme/i.test(a.name) ? 0 : 1;
    const bIsReadme = /^readme/i.test(b.name) ? 0 : 1;
    if (aIsReadme !== bIsReadme) return aIsReadme - bIsReadme;
    return a.name.localeCompare(b.name);
  });

  // Add discovered PDF / external doc links that aren't already listed
  const existingUrls = new Set(base.documentationLinks.map((l) => l.url));
  const mergedLinks: ArchiveDocLink[] = [...base.documentationLinks];
  for (const doc of discovered) {
    if (doc.externalUrl && !existingUrls.has(doc.externalUrl)) {
      existingUrls.add(doc.externalUrl);
      mergedLinks.unshift({
        label: doc.locationLabel ? `${doc.name} (${doc.locationLabel})` : doc.name,
        url: doc.externalUrl,
        description: `Discovered documentation file in ${target.displayName}`,
      });
    }
  }

  let primaryReadmeText: string | undefined;
  let primaryReadmeName: string | undefined;
  const textCandidate =
    (target.focusDocUri
      ? discovered.find((d) => d.uri === target.focusDocUri && d.kind !== 'pdf')
      : undefined) ?? discovered.find((d) => d.kind === 'text');

  if (textCandidate && options?.readText) {
    const txt = await fetchDocTextPreview(engine, target, textCandidate);
    if (txt) {
      primaryReadmeText = txt;
      primaryReadmeName = textCandidate.name;
    }
  }

  let briefDescription = base.briefDescription;
  if (primaryReadmeText) {
    const summary = extractBriefSummary(primaryReadmeText);
    if (summary && !CURATED_ARCHIVES[target.sourceId]) {
      briefDescription = summary;
    }
  }

  const result: ArchiveAboutSpec = {
    ...base,
    briefDescription,
    documentationLinks: mergedLinks,
    readmeFiles: discovered,
    primaryReadmeText,
    primaryReadmeName,
    discoveredFromLive: true,
  };

  discoveryCache.set(cacheKey, result);
  return result;
}

export function DataSourceToArchiveTarget(
  src: DataSourceInfo,
  extra?: Partial<ArchiveTargetInput>,
): ArchiveTargetInput {
  return {
    sourceId: src.sourceId,
    displayName: src.displayName,
    kind: src.kind,
    rootPath: src.rootPath,
    description: src.description,
    anonymous: src.anonymous,
    ...extra,
  };
}
