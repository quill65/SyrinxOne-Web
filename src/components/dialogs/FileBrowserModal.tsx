import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Calendar,
  FileAudio,
  FileText,
  Folder,
  FolderOpen,
  History,
  Layers,
  Link2,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';
import type { BrowseEntry, DataSourceInfo } from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { googleSignIn, toGoogleUserProfile } from '../../auth/googleAuth';
import { getAccessToken } from '../../auth/googleAuth';
import {
  DriveAuthExpiredError,
  listDriveItems,
  resolveDriveFolderId,
  type DriveItem,
} from '../../auth/googleDrive';
import {
  collectAudioSpecsFromDrive,
  collectAudioSpecsFromSource,
  detectContiguousGroups,
  formatCombinedRecordingTitle,
  getArchiveCombinePref,
  getRecordingViewState,
  listRecentRecordingViewStates,
  makeArchiveSeriesKey,
  makeCombinedRecordingKey,
  makeSingleRecordingKey,
  removeRecordingViewState,
  setArchiveCombinePref,
  splitFolderAndFile,
  type ArchiveEntryLike,
  type ContiguousGroup,
  type SavedRecordingViewState,
} from '../../utils/contiguousArchive';
import { getSmartArchiveWindowSec } from '../../utils/spectrogramFetch';
import {
  formatDateTimeLocalInput,
  formatRecordingTime,
  parseIsoWallClockUtcMs,
  parseTimeOrDateInput,
  parseTimestampFromName,
  type RecordingTimeContext,
} from '../../utils/timeFormat';
import { GoogleSignInButton } from '../auth/GoogleSignInButton';
import {
  buildStaticArchiveAbout,
  discoverArchiveDocumentation,
  isDocumentationEntryName,
  type ArchiveTargetInput,
} from '../../utils/archiveDocs';

interface PendingCombinePrompt {
  origin: 'source' | 'drive';
  seriesKey: string;
  group: ContiguousGroup;
  clickedSourceEntry?: BrowseEntry;
  clickedDriveItem?: DriveItem;
}

function formatBytes(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export const FileBrowserModal: React.FC = () => {
  const show = useWorkspaceStore((s) => s.showFileBrowser);
  const activeSourceId = useWorkspaceStore((s) => s.activeSourceId);
  const activeSourceDisplayName = useWorkspaceStore((s) => s.activeSourceDisplayName);
  const setActiveSource = useWorkspaceStore((s) => s.setActiveSource);
  const openSourceSelector = useWorkspaceStore((s) => s.openSourceSelector);
  const openAboutArchive = useWorkspaceStore((s) => s.openAboutArchive);
  const engine = useWorkspaceStore((s) => s.engine);
  const openAudioFromSource = useWorkspaceStore((s) => s.openAudioFromSource);
  const openCombinedArchive = useWorkspaceStore((s) => s.openCombinedArchive);
  const restoreSavedRecordingView = useWorkspaceStore((s) => s.restoreSavedRecordingView);
  const openAudioUrl = useWorkspaceStore((s) => s.openAudioUrl);
  const importAnnotationsFromSource = useWorkspaceStore((s) => s.importAnnotationsFromSource);
  const openUploadedFile = useWorkspaceStore((s) => s.openUploadedFile);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const setStatus = useWorkspaceStore((s) => s.setStatus);
  const googleUser = useWorkspaceStore((s) => s.googleUser);
  const hasDriveToken = useWorkspaceStore((s) => s.hasDriveToken);
  const setGoogleAuthState = useWorkspaceStore((s) => s.setGoogleAuthState);

  const [sources, setSources] = useState<DataSourceInfo[]>([]);
  const [prefix, setPrefix] = useState<string>('');
  const [filterText, setFilterText] = useState<string>('');
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  // Multi-select & contiguous combine state
  const [selectedUris, setSelectedUris] = useState<string[]>([]);
  const [selectedDriveIds, setSelectedDriveIds] = useState<string[]>([]);
  const [combiningBusy, setCombiningBusy] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<PendingCombinePrompt | null>(null);
  const [rememberCombineChoice, setRememberCombineChoice] = useState(true);
  const [prefsVersion, setPrefsVersion] = useState(0);

  // Optional slice controls (hidden behind compact toggle to keep UI tidy)
  const [showSliceOptions, setShowSliceOptions] = useState(false);
  const [directUrl, setDirectUrl] = useState('');
  const [windowStartInput, setWindowStartInput] = useState<string>('00:00:00');
  const [windowPreset, setWindowPreset] = useState<string>('auto');
  const [customWindowSec, setCustomWindowSec] = useState<number>(1800);

  // Google Drive folder navigation
  const [driveScopeRoot, setDriveScopeRoot] = useState<'root' | 'sharedWithMe'>('root');
  const [driveBreadcrumbs, setDriveBreadcrumbs] = useState<Array<{ id: string; name: string }>>([
    { id: 'root', name: 'My Drive' },
  ]);
  const [driveItems, setDriveItems] = useState<DriveItem[]>([]);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [driveBusyAuth, setDriveBusyAuth] = useState(false);

  const isDriveSource = activeSourceId === 'gdrive_oauth';
  const isHttpSource = activeSourceId === 'http';

  const refresh = async (srcId: string, pfx: string) => {
    setLoading(true);
    setBrowseError(null);
    setSelectedUris([]);
    try {
      const list = await engine.browseSource(srcId, pfx, 1000);
      setEntries(list);
    } catch (err) {
      setEntries([]);
      setBrowseError(err instanceof Error ? err.message : 'Failed to list recordings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!show) return;
    setPendingPrompt(null);
    setFilterText('');
    setSelectedUris([]);
    setSelectedDriveIds([]);
    setPrefsVersion((v) => v + 1);

    if (isDriveSource || isHttpSource) {
      void engine
        .listSources()
        .then(setSources)
        .catch(() => setSources([]));
      return;
    }

    void (async () => {
      try {
        const srcs = await engine.listSources();
        setSources(srcs);
        const match = srcs.find((s) => s.sourceId === activeSourceId) ?? srcs[0];
        if (match) {
          if (match.sourceId !== activeSourceId) {
            setActiveSource(match.sourceId, match.displayName);
          }
          const initPrefix = match.rootPath || '';
          setPrefix(initPrefix);
          await refresh(match.sourceId, initPrefix);
        }
      } catch (err) {
        setEntries([]);
        setBrowseError(err instanceof Error ? err.message : 'Failed to load recordings from source');
      }
    })();
  }, [show, activeSourceId, engine]);

  const currentDriveFolder = driveBreadcrumbs[driveBreadcrumbs.length - 1] ?? {
    id: driveScopeRoot,
    name: driveScopeRoot === 'root' ? 'My Drive' : 'Shared with me',
  };

  const loadDriveFolder = async (folderId: string, searchQuery?: string) => {
    setDriveLoading(true);
    setDriveError(null);
    setSelectedDriveIds([]);
    try {
      const items = await listDriveItems(folderId, searchQuery);
      setDriveItems(items);
    } catch (err) {
      setDriveItems([]);
      if (err instanceof DriveAuthExpiredError) {
        setGoogleAuthState(googleUser, false);
      }
      setDriveError(err instanceof Error ? err.message : 'Failed to list Google Drive files');
    } finally {
      setDriveLoading(false);
    }
  };

  useEffect(() => {
    if (!show || !isDriveSource || !hasDriveToken) return;
    void loadDriveFolder(currentDriveFolder.id);
  }, [show, isDriveSource, hasDriveToken, currentDriveFolder.id]);

  const activeSourceInfo = useMemo(
    () => sources.find((s) => s.sourceId === activeSourceId),
    [sources, activeSourceId],
  );

  const currentAboutTarget = useMemo<ArchiveTargetInput>(
    () => ({
      sourceId: activeSourceId,
      displayName: activeSourceInfo?.displayName || activeSourceDisplayName || activeSourceId,
      kind: activeSourceInfo?.kind ?? (isDriveSource ? 'gdrive' : isHttpSource ? 'http' : undefined),
      rootPath: activeSourceInfo?.rootPath,
      description: activeSourceInfo?.description,
      anonymous: activeSourceInfo?.anonymous,
      currentPrefix: isDriveSource
        ? currentDriveFolder.id === 'root' || currentDriveFolder.id === 'sharedWithMe'
          ? ''
          : currentDriveFolder.name
        : prefix,
      currentEntries: isDriveSource ? undefined : entries,
      currentDriveItems: isDriveSource ? driveItems : undefined,
    }),
    [
      activeSourceId,
      activeSourceInfo,
      activeSourceDisplayName,
      isDriveSource,
      isHttpSource,
      currentDriveFolder,
      prefix,
      entries,
      driveItems,
    ],
  );

  const [browserAboutBrief, setBrowserAboutBrief] = useState<string>('');
  const [browserDocCount, setBrowserDocCount] = useState<number>(0);

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    const staticSpec = buildStaticArchiveAbout(currentAboutTarget);
    setBrowserAboutBrief(staticSpec.briefDescription);
    setBrowserDocCount(staticSpec.readmeFiles.length + staticSpec.documentationLinks.length);

    void discoverArchiveDocumentation(engine, currentAboutTarget, { readText: true }).then((spec) => {
      if (cancelled) return;
      setBrowserAboutBrief(spec.briefDescription);
      setBrowserDocCount(spec.readmeFiles.length + spec.documentationLinks.length);
    });
    return () => {
      cancelled = true;
    };
  }, [show, engine, currentAboutTarget]);

  const visibleEntries = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const list = !q
      ? entries
      : entries.filter((e) => e.name === '..' || e.name.toLowerCase().includes(q));
    return [...list].sort((a, b) => {
      if (a.name === '..') return -1;
      if (b.name === '..') return 1;
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return 0;
    });
  }, [entries, filterText]);

  const visibleDriveItems = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const list = !q
      ? driveItems
      : driveItems.filter((item) => item.name.toLowerCase().includes(q));
    return [...list].sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return 0;
    });
  }, [driveItems, filterText]);

  const sourceContiguous = useMemo(() => detectContiguousGroups(entries), [entries]);
  const allSourceGroups = useMemo(
    () => [...sourceContiguous.fileGroups, ...sourceContiguous.folderGroups],
    [sourceContiguous],
  );

  const driveAsEntries = useMemo<ArchiveEntryLike[]>(
    () =>
      driveItems.map((d) => ({
        name: d.name,
        uri: d.id,
        isDir: d.isFolder,
        sizeBytes: d.sizeBytes,
        kind: d.kind === 'folder' ? 'other' : d.kind,
      })),
    [driveItems],
  );
  const driveContiguous = useMemo(() => detectContiguousGroups(driveAsEntries), [driveAsEntries]);
  const allDriveGroups = useMemo(
    () => [...driveContiguous.fileGroups, ...driveContiguous.folderGroups],
    [driveContiguous],
  );

  const recentViews = useMemo(
    () => listRecentRecordingViewStates(6),
    [show, prefsVersion],
  );

  const browserTimeCtx = useMemo<RecordingTimeContext | null>(() => {
    const sampleName = !isDriveSource
      ? allSourceGroups[0]?.entries[0]?.name ??
        entries.find((e) => !e.isDir && e.kind === 'audio')?.name
      : allDriveGroups[0]?.entries[0]?.name ??
        driveItems.find((d) => !d.isFolder && d.kind === 'audio')?.name;
    if (!sampleName) return null;
    const p = parseTimestampFromName(sampleName);
    if (!p) return null;
    return {
      startDateTimeIso: new Date(p.ms).toISOString(),
      name: sampleName,
    };
  }, [isDriveSource, allSourceGroups, allDriveGroups, entries, driveItems]);

  const browserSeriesBaseMs = useMemo(
    () =>
      browserTimeCtx?.startDateTimeIso
        ? parseIsoWallClockUtcMs(browserTimeCtx.startDateTimeIso)
        : null,
    [browserTimeCtx],
  );

  const folderBreadcrumbLabel = useMemo(() => {
    if (isDriveSource) {
      return driveBreadcrumbs.map((c) => c.name).join(' / ');
    }
    const clean = prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return clean ? `${activeSourceDisplayName} / ${clean}` : `${activeSourceDisplayName} /`;
  }, [isDriveSource, driveBreadcrumbs, prefix, activeSourceDisplayName]);

  const currentFolderName = useMemo(() => {
    if (isDriveSource) return currentDriveFolder.name;
    const parts = prefix.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] ?? activeSourceDisplayName;
  }, [isDriveSource, currentDriveFolder.name, prefix, activeSourceDisplayName]);

  if (!show) return null;

  const trimmedStartInput = windowStartInput.trim();
  const parsedStartDefault = parseTimeOrDateInput(windowStartInput, browserTimeCtx) ?? 0;
  const hasManualWindowOverride =
    windowPreset !== 'auto' ||
    (trimmedStartInput !== '' && trimmedStartInput !== '00:00:00' && parsedStartDefault > 0);

  const resolveOpenOptions = (
    fileName?: string,
    sizeBytes?: number,
    existingKey?: string,
  ): {
    startSec?: number;
    maxDurationSec?: number;
    fullTimeline?: boolean;
    sizeBytes?: number;
    name?: string;
    restoreSaved?: boolean;
  } | undefined => {
    const itemCtx: RecordingTimeContext | null = fileName
      ? {
          name: fileName,
          ...(browserTimeCtx?.startDateTimeIso && !parseTimestampFromName(fileName)
            ? { startDateTimeIso: browserTimeCtx.startDateTimeIso }
            : {}),
        }
      : browserTimeCtx;
    const parsedStart = parseTimeOrDateInput(windowStartInput, itemCtx) ?? parsedStartDefault;
    const manualStartOverride =
      trimmedStartInput !== '' && trimmedStartInput !== '00:00:00' && parsedStart > 0;

    if (
      windowPreset === 'auto' &&
      !manualStartOverride &&
      existingKey &&
      getRecordingViewState(existingKey)
    ) {
      return {
        restoreSaved: true,
        fullTimeline: true,
        sizeBytes,
        name: fileName,
      };
    }
    if (windowPreset === 'auto') {
      if (manualStartOverride) {
        const smartLen = fileName ? getSmartArchiveWindowSec(fileName, sizeBytes) : 900;
        return {
          startSec: parsedStart,
          ...(smartLen !== undefined ? { maxDurationSec: smartLen } : {}),
          fullTimeline: false,
          sizeBytes,
          name: fileName,
        };
      }
      return {
        fullTimeline: true,
        sizeBytes,
        name: fileName,
      };
    }
    const len =
      windowPreset === 'custom'
        ? Math.max(5, Math.min(86400, Math.round(customWindowSec || 900)))
        : Math.max(5, Number(windowPreset) || 900);
    return {
      startSec: parsedStart,
      maxDurationSec: len,
      fullTimeline: false,
      sizeBytes,
      name: fileName,
    };
  };

  const combineSourceItems = async (items: ArchiveEntryLike[], explicitTitle?: string) => {
    if (items.length === 0 || combiningBusy) return;
    setCombiningBusy(true);
    setBrowseError(null);
    try {
      setStatus(`Scanning ${items.length} selected recording item(s)...`);
      const specs = await collectAudioSpecsFromSource(engine, activeSourceId, items);
      if (specs.length === 0) {
        setBrowseError('No audio files were found in the selected items.');
        return;
      }
      const title =
        explicitTitle && !explicitTitle.includes('…')
          ? explicitTitle
          : formatCombinedRecordingTitle(specs, currentFolderName);
      const recKey = makeCombinedRecordingKey(activeSourceId, specs);
      const openOpts = resolveOpenOptions(specs[0].name, specs[0].sizeBytes, recKey);
      await openCombinedArchive(specs, title, {
        ...openOpts,
        recordingKey: recKey,
        restoreSaved: !hasManualWindowOverride,
      });
      setPrefsVersion((v) => v + 1);
      setModalState('showFileBrowser', false);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : 'Failed to combine recordings');
    } finally {
      setCombiningBusy(false);
    }
  };

  const openMultipleSourceItemsSeparately = async (items: ArchiveEntryLike[]) => {
    if (items.length === 0 || combiningBusy) return;
    setCombiningBusy(true);
    setBrowseError(null);
    try {
      const specs = await collectAudioSpecsFromSource(engine, activeSourceId, items, 12, 2);
      if (specs.length === 0) {
        setBrowseError('No audio files found in selection.');
        return;
      }
      for (const spec of specs) {
        const recKey = makeSingleRecordingKey(spec.sourceId, spec.uri);
        await openAudioFromSource(
          spec.sourceId,
          spec.uri,
          resolveOpenOptions(spec.name, spec.sizeBytes, recKey),
        );
      }
      setPrefsVersion((v) => v + 1);
      setModalState('showFileBrowser', false);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : 'Failed to open selected recordings');
    } finally {
      setCombiningBusy(false);
    }
  };

  const connectOrReuseDriveFolder = async (folderId: string, folderName: string): Promise<string> => {
    const token = await getAccessToken();
    if (!token) {
      setGoogleAuthState(googleUser, false);
      throw new Error('Google Drive session expired. Please sign in again.');
    }
    const resolvedId = await resolveDriveFolderId(folderId);
    const folderUrl = `https://drive.google.com/drive/folders/${resolvedId}`;
    const existing = sources.find(
      (s) => s.kind === 'gdrive' && (s.rootPath === resolvedId || s.displayName === `Drive: ${folderName}`),
    );
    if (existing) return existing.sourceId;
    const created = await engine.addSource({
      kind: 'gdrive',
      displayName: `Drive: ${folderName}`,
      folderOrUrl: folderUrl,
      oauthToken: token,
      anonymous: false,
      readOnly: true,
    });
    return created.sourceId;
  };

  const combineDriveItems = async (items: DriveItem[], explicitTitle?: string) => {
    if (items.length === 0 || combiningBusy) return;
    setCombiningBusy(true);
    setDriveError(null);
    try {
      setStatus(`Scanning ${items.length} Google Drive item(s)...`);
      const targetFolderId =
        currentDriveFolder.id !== 'sharedWithMe'
          ? currentDriveFolder.id
          : items.find((i) => i.isFolder)?.id ?? 'root';
      const targetFolderName =
        currentDriveFolder.id !== 'sharedWithMe'
          ? currentDriveFolder.name
          : items.find((i) => i.isFolder)?.name ?? 'Drive Archive';

      const existingDriveSrc =
        sources.find((s) => s.kind === 'gdrive' && s.rootPath === targetFolderId)?.sourceId ?? null;

      const { specs, connectedSourceId } = await collectAudioSpecsFromDrive(
        items,
        connectOrReuseDriveFolder,
        existingDriveSrc,
        targetFolderId,
        targetFolderName,
      );
      if (specs.length === 0) {
        setDriveError('No audio files were found in the selected Drive items.');
        return;
      }
      const title =
        explicitTitle && !explicitTitle.includes('…')
          ? explicitTitle
          : formatCombinedRecordingTitle(specs, targetFolderName);
      const recKey = makeCombinedRecordingKey(connectedSourceId, specs);
      const openOpts = resolveOpenOptions(specs[0].name, specs[0].sizeBytes, recKey);
      await openCombinedArchive(specs, title, {
        ...openOpts,
        recordingKey: recKey,
        restoreSaved: !hasManualWindowOverride,
      });
      setPrefsVersion((v) => v + 1);
      setModalState('showFileBrowser', false);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        setGoogleAuthState(googleUser, false);
      }
      setDriveError(err instanceof Error ? err.message : 'Failed to combine Drive recordings');
    } finally {
      setCombiningBusy(false);
    }
  };

  const openMultipleDriveItemsSeparately = async (items: DriveItem[]) => {
    if (items.length === 0 || combiningBusy) return;
    setCombiningBusy(true);
    setDriveError(null);
    try {
      const targetFolderId =
        currentDriveFolder.id !== 'sharedWithMe'
          ? currentDriveFolder.id
          : items.find((i) => i.isFolder)?.id ?? 'root';
      const targetFolderName =
        currentDriveFolder.id !== 'sharedWithMe'
          ? currentDriveFolder.name
          : items.find((i) => i.isFolder)?.name ?? 'Drive Archive';
      const existingDriveSrc =
        sources.find((s) => s.kind === 'gdrive' && s.rootPath === targetFolderId)?.sourceId ?? null;

      const { specs } = await collectAudioSpecsFromDrive(
        items,
        connectOrReuseDriveFolder,
        existingDriveSrc,
        targetFolderId,
        targetFolderName,
        12,
        2,
      );
      if (specs.length === 0) {
        setDriveError('No audio files found in selection.');
        return;
      }
      for (const spec of specs) {
        const recKey = makeSingleRecordingKey(spec.sourceId, spec.uri);
        await openAudioFromSource(
          spec.sourceId,
          spec.uri,
          resolveOpenOptions(spec.name, spec.sizeBytes, recKey),
        );
      }
      setPrefsVersion((v) => v + 1);
      setModalState('showFileBrowser', false);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        setGoogleAuthState(googleUser, false);
      }
      setDriveError(err instanceof Error ? err.message : 'Failed to open Drive recordings');
    } finally {
      setCombiningBusy(false);
    }
  };

  const openSingleSourceEntry = async (entry: BrowseEntry) => {
    if (entry.isDir) {
      setPrefix(entry.uri);
      setFilterText('');
      await refresh(activeSourceId, entry.uri);
    } else if (entry.kind === 'audio') {
      const recKey = makeSingleRecordingKey(activeSourceId, entry.uri);
      await openAudioFromSource(
        activeSourceId,
        entry.uri,
        resolveOpenOptions(entry.name, entry.sizeBytes, recKey),
      );
      setPrefsVersion((v) => v + 1);
      setModalState('showFileBrowser', false);
    } else if (isDocumentationEntryName(entry.name)) {
      openAboutArchive({ ...currentAboutTarget, focusDocUri: entry.uri });
    } else if (entry.kind === 'annotation') {
      await importAnnotationsFromSource(activeSourceId, entry.uri);
      setModalState('showFileBrowser', false);
    }
  };

  const handleEntryClick = async (entry: BrowseEntry) => {
    if (entry.name !== '..' && (entry.isDir || entry.kind === 'audio')) {
      const group = sourceContiguous.entryToGroup.get(entry.uri);
      if (group) {
        const seriesKey = makeArchiveSeriesKey(activeSourceId, prefix, group.groupId);
        const pref = getArchiveCombinePref(seriesKey);
        if (pref === 'combine') {
          await combineSourceItems(group.entries, group.label);
          return;
        }
        if (pref === null) {
          setRememberCombineChoice(true);
          setPendingPrompt({
            origin: 'source',
            seriesKey,
            group,
            clickedSourceEntry: entry,
          });
          return;
        }
      }
    }
    await openSingleSourceEntry(entry);
  };

  const openSingleDriveItem = async (item: DriveItem) => {
    if (item.isFolder) {
      setFilterText('');
      setDriveBreadcrumbs((prev) => [...prev, { id: item.id, name: item.name }]);
      return;
    }

    if (item.isDoc || isDocumentationEntryName(item.name)) {
      openAboutArchive({ ...currentAboutTarget, focusDocUri: item.id });
      return;
    }

    const token = await getAccessToken();
    if (!token) {
      setGoogleAuthState(googleUser, false);
      setDriveError('Google Drive session expired. Please sign in again.');
      return;
    }

    setDriveLoading(true);
    setDriveError(null);
    try {
      const fileUrl = `https://drive.google.com/file/d/${item.id}/view`;
      const created = await engine.addSource({
        kind: 'gdrive',
        displayName: item.name,
        folderOrUrl: fileUrl,
        oauthToken: token,
        anonymous: false,
        readOnly: true,
      });
      let targetUri = item.id;
      try {
        const listed = await engine.browseSource(created.sourceId, created.rootPath || '', 50);
        const matched =
          listed.find((e) => !e.isDir && (e.name === item.name || e.uri.includes(item.id))) ??
          listed.find((e) => !e.isDir);
        if (matched?.uri) targetUri = matched.uri;
      } catch {
        // Fallback to Drive ID
      }

      if (item.kind === 'audio') {
        const recKey = makeSingleRecordingKey(created.sourceId, targetUri);
        await openAudioFromSource(
          created.sourceId,
          targetUri,
          resolveOpenOptions(item.name, item.sizeBytes, recKey),
        );
        setPrefsVersion((v) => v + 1);
        setModalState('showFileBrowser', false);
      } else if (item.kind === 'annotation') {
        await importAnnotationsFromSource(created.sourceId, targetUri);
        setModalState('showFileBrowser', false);
      }
    } catch (err) {
      setDriveError(err instanceof Error ? err.message : 'Failed to open Google Drive file');
    } finally {
      setDriveLoading(false);
    }
  };

  const handleDriveItemClick = async (item: DriveItem) => {
    if (item.isFolder || item.kind === 'audio') {
      const group = driveContiguous.entryToGroup.get(item.id);
      if (group) {
        const seriesKey = makeArchiveSeriesKey('gdrive_oauth', currentDriveFolder.id, group.groupId);
        const pref = getArchiveCombinePref(seriesKey);
        if (pref === 'combine') {
          const itemMap = new Map(driveItems.map((d) => [d.id, d]));
          const matched = group.entries
            .map((e) => itemMap.get(e.uri))
            .filter((d): d is DriveItem => Boolean(d));
          await combineDriveItems(matched, group.label);
          return;
        }
        if (pref === null) {
          setRememberCombineChoice(true);
          setPendingPrompt({
            origin: 'drive',
            seriesKey,
            group,
            clickedDriveItem: item,
          });
          return;
        }
      }
    }
    await openSingleDriveItem(item);
  };

  const handleResolvePendingPrompt = async (decision: 'combine' | 'single') => {
    if (!pendingPrompt) return;
    const promptState = pendingPrompt;
    setPendingPrompt(null);

    if (rememberCombineChoice) {
      setArchiveCombinePref(promptState.seriesKey, decision);
      setPrefsVersion((v) => v + 1);
    }

    if (decision === 'combine') {
      if (promptState.origin === 'source') {
        await combineSourceItems(promptState.group.entries, promptState.group.label);
      } else {
        const itemMap = new Map(driveItems.map((d) => [d.id, d]));
        const matched = promptState.group.entries
          .map((e) => itemMap.get(e.uri))
          .filter((d): d is DriveItem => Boolean(d));
        await combineDriveItems(matched, promptState.group.label);
      }
    } else {
      if (promptState.origin === 'source' && promptState.clickedSourceEntry) {
        await openSingleSourceEntry(promptState.clickedSourceEntry);
      } else if (promptState.origin === 'drive' && promptState.clickedDriveItem) {
        await openSingleDriveItem(promptState.clickedDriveItem);
      }
    }
  };

  const handleOpenDirectUrl = async () => {
    const url = directUrl.trim();
    if (!url) return;
    const recKey = makeSingleRecordingKey('http', url);
    await openAudioUrl(url, resolveOpenOptions(url, undefined, recKey));
    setModalState('showFileBrowser', false);
  };

  const handleDriveSignIn = async () => {
    setDriveBusyAuth(true);
    setDriveError(null);
    try {
      const res = await googleSignIn();
      setGoogleAuthState(toGoogleUserProfile(res.user), true);
      setStatus(`Signed in as ${res.user.email ?? 'Google Drive user'}`);
    } catch (err) {
      setDriveError(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setDriveBusyAuth(false);
    }
  };

  const handleSwitchDriveRoot = (nextRoot: 'root' | 'sharedWithMe') => {
    setDriveScopeRoot(nextRoot);
    setFilterText('');
    setSelectedDriveIds([]);
    setDriveBreadcrumbs([
      {
        id: nextRoot,
        name: nextRoot === 'root' ? 'My Drive' : 'Shared with me',
      },
    ]);
  };

  const toggleSourceSelect = (uri: string) => {
    setSelectedUris((prev) =>
      prev.includes(uri) ? prev.filter((u) => u !== uri) : [...prev, uri],
    );
  };

  const toggleDriveSelect = (id: string) => {
    setSelectedDriveIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleRestoreRecent = async (saved: SavedRecordingViewState) => {
    await restoreSavedRecordingView(saved);
    setModalState('showFileBrowser', false);
  };

  const activeSelectionCount = isDriveSource ? selectedDriveIds.length : selectedUris.length;
  const activeGroups = isDriveSource ? allDriveGroups : allSourceGroups;

  return (
    <div className="modal-backdrop" onClick={() => setModalState('showFileBrowser', false)}>
      <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FolderOpen size={15} color="#38bdf8" /> Select Recordings
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <button
              className="btn-small"
              onClick={() => openAboutArchive(currentAboutTarget)}
              title="View archive details, READMEs & documentation links"
            >
              <BookOpen size={12} /> About Archive{browserDocCount > 0 ? ` (${browserDocCount})` : ''}
            </button>
            <button
              className="btn-small"
              onClick={() => openSourceSelector(true)}
              title="Switch active acoustic data source"
            >
              Change Source
            </button>
            <button className="mdi-icon-btn" onClick={() => setModalState('showFileBrowser', false)}>
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="modal-body" style={{ position: 'relative' }}>
          {/* Active Source Location & Search Row */}
          <div className="recordings-source-bar">
            <span className="recordings-path-label" title={folderBreadcrumbLabel}>
              {folderBreadcrumbLabel}
            </span>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              {activeSourceId === 'local' && (
                <label className="btn-small btn-primary" style={{ cursor: 'pointer' }}>
                  <Upload size={12} /> Upload
                  <input
                    type="file"
                    multiple
                    accept=".wav,.flac,.aif,.aiff,.ogg,.mp3,.m4a"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const list = Array.from(e.target.files ?? []);
                      void Promise.all(list.map((f) => openUploadedFile(f)));
                      setModalState('showFileBrowser', false);
                    }}
                  />
                </label>
              )}
              <button
                className={`btn-small ${showSliceOptions ? 'btn-active' : ''}`}
                onClick={() => setShowSliceOptions((v) => !v)}
                title="Set start offset or slice duration for long recordings"
              >
                <SlidersHorizontal size={12} /> Slice
              </button>
              {!isHttpSource && (
                <button
                  className="btn-small"
                  onClick={() =>
                    isDriveSource
                      ? void loadDriveFolder(currentDriveFolder.id, filterText)
                      : void refresh(activeSourceId, prefix)
                  }
                  title="Refresh folder contents"
                >
                  <RefreshCw size={12} />
                </button>
              )}
            </div>
          </div>

          {browserAboutBrief && (
            <div className="browser-about-strip">
              <span className="browser-about-brief">{browserAboutBrief}</span>
              <button
                type="button"
                className="browser-about-link"
                onClick={() => openAboutArchive(currentAboutTarget)}
              >
                <BookOpen size={11} /> Docs &amp; README
              </button>
            </div>
          )}

          {recentViews.length > 0 && (
            <div className="recent-views-strip">
              <div className="recent-views-head">
                <History size={12} color="#38bdf8" />
                <span>Previously Viewed</span>
              </div>
              <div className="recent-views-list">
                {recentViews.map((rv) => {
                  const rvPos = rv.windowStartSec + (rv.viewRange?.startSec ?? 0);
                  const rvCtx: RecordingTimeContext = {
                    totalDurationSec: rv.totalDurationSec ?? rvPos,
                    startDateTimeIso: rv.startDateTimeIso,
                    name: rv.segments?.[0]?.name ?? rv.label,
                    uri: rv.uri,
                  };
                  const rvLabel = formatRecordingTime(rvPos, rvCtx);
                  const displayTitle =
                    rv.kind === 'combined' && rv.segments && rv.segments.length > 1
                      ? formatCombinedRecordingTitle(rv.segments, rv.label)
                      : rv.label;
                  return (
                    <div key={rv.recordingKey} className="recent-view-chip">
                      <button
                        className="recent-view-open"
                        onClick={() => void handleRestoreRecent(rv)}
                        title={`Restore ${displayTitle} at ${rvLabel}`}
                      >
                        {rv.kind === 'combined' ? (
                          <Layers size={11} color="#38bdf8" />
                        ) : (
                          <FileAudio size={11} color="#4ade80" />
                        )}
                        <span className="recent-view-name">{displayTitle}</span>
                        <span className="recent-view-pos mono">· {rvLabel}</span>
                      </button>
                      <button
                        className="recent-view-del"
                        title="Forget saved view"
                        onClick={() => {
                          removeRecordingViewState(rv.recordingKey);
                          setPrefsVersion((v) => v + 1);
                        }}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {showSliceOptions && (
            <div className="window-inputs slice-options-bar">
              <span>View</span>
              <select
                value={windowPreset}
                onChange={(e) => setWindowPreset(e.target.value)}
                style={{ width: 'auto', minWidth: 110 }}
              >
                <option value="auto">Auto (Full / Saved)</option>
                <option value="60">1 min</option>
                <option value="300">5 min</option>
                <option value="900">15 min</option>
                <option value="1800">30 min</option>
                <option value="3600">1 hour</option>
                <option value="10800">3 hours</option>
                <option value="21600">6 hours</option>
                <option value="custom">Custom (s)</option>
              </select>
              <span>Start</span>
              <input
                type="text"
                value={windowStartInput}
                onChange={(e) => setWindowStartInput(e.target.value)}
                placeholder={browserSeriesBaseMs !== null ? 'YYYY-MM-DD HH:MM:SS' : '00:00:00'}
                style={{ width: browserSeriesBaseMs !== null ? 136 : 82 }}
              />
              {browserSeriesBaseMs !== null && (
                <span className="btn-small archive-date-picker-btn" title="Pick start date & time">
                  <Calendar size={12} />
                  <input
                    type="datetime-local"
                    step={1}
                    min={formatDateTimeLocalInput(browserSeriesBaseMs)}
                    value={formatDateTimeLocalInput(
                      browserSeriesBaseMs + Math.max(0, parsedStartDefault) * 1000,
                    )}
                    onChange={(e) => {
                      const ms = parseIsoWallClockUtcMs(e.target.value);
                      if (ms !== null) {
                        const off = Math.max(0, (ms - browserSeriesBaseMs) / 1000);
                        setWindowStartInput(
                          formatRecordingTime(off, browserTimeCtx, { forceDateTime: true }),
                        );
                      }
                    }}
                  />
                </span>
              )}
              {windowPreset === 'custom' && (
                <>
                  <span>Len</span>
                  <input
                    type="number"
                    min={5}
                    max={86400}
                    step={60}
                    value={customWindowSec}
                    onChange={(e) => setCustomWindowSec(Number(e.target.value))}
                    style={{ width: 64 }}
                  />
                  <span>s</span>
                </>
              )}
            </div>
          )}

          {isHttpSource ? (
            <div className="connect-source-panel">
              <div className="url-quick-bar">
                <Link2 size={13} color="#38bdf8" />
                <input
                  type="text"
                  value={directUrl}
                  placeholder="Paste audio URL (.wav / .flac / .ogg / .mp3)..."
                  onChange={(e) => setDirectUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleOpenDirectUrl();
                  }}
                />
                <button
                  className="btn-small btn-primary"
                  disabled={!directUrl.trim()}
                  onClick={() => void handleOpenDirectUrl()}
                >
                  Open URL
                </button>
              </div>
              {activeSourceInfo?.description && (
                <div className="source-desc-hint">{activeSourceInfo.description}</div>
              )}
            </div>
          ) : isDriveSource && !hasDriveToken ? (
            <div className="gdrive-auth-card">
              <div className="preset-title">Sign in to Google Drive</div>
              <p className="modal-hint">
                Sign in with Google to browse your folders and select single or combined recordings.
              </p>
              <div>
                <GoogleSignInButton
                  disabled={driveBusyAuth}
                  label={driveBusyAuth ? 'Signing in...' : 'Sign in with Google'}
                  onClick={() => void handleDriveSignIn()}
                />
              </div>
              {driveError && <div className="inline-error">{driveError}</div>}
            </div>
          ) : (
            <>
              {/* Navigation & Filter Row */}
              <div className="browser-subbar">
                {isDriveSource ? (
                  <div className="gdrive-root-switch">
                    <button
                      className={`btn-small ${driveScopeRoot === 'root' ? 'btn-active' : ''}`}
                      onClick={() => handleSwitchDriveRoot('root')}
                    >
                      My Drive
                    </button>
                    <button
                      className={`btn-small ${driveScopeRoot === 'sharedWithMe' ? 'btn-active' : ''}`}
                      onClick={() => handleSwitchDriveRoot('sharedWithMe')}
                    >
                      Shared
                    </button>
                    {driveBreadcrumbs.length > 1 && (
                      <button
                        className="btn-small"
                        onClick={() => {
                          setFilterText('');
                          setDriveBreadcrumbs((prev) => prev.slice(0, -1));
                        }}
                      >
                        <ArrowLeft size={12} /> Up
                      </button>
                    )}
                  </div>
                ) : (
                  prefix &&
                  prefix !== (activeSourceInfo?.rootPath || '') && (
                    <button
                      className="btn-small"
                      onClick={() => {
                        const upEntry = entries.find((e) => e.name === '..');
                        if (upEntry) {
                          void openSingleSourceEntry(upEntry);
                        } else {
                          const rootPfx = activeSourceInfo?.rootPath || '';
                          setPrefix(rootPfx);
                          void refresh(activeSourceId, rootPfx);
                        }
                      }}
                    >
                      <ArrowLeft size={12} /> Up
                    </button>
                  )
                )}

                <div className="browser-filter">
                  <Search size={12} />
                  <input
                    type="text"
                    value={filterText}
                    placeholder={
                      isDriveSource ? 'Filter or press Enter to search...' : 'Filter folders & files...'
                    }
                    onChange={(e) => setFilterText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && isDriveSource) {
                        void loadDriveFolder(currentDriveFolder.id, filterText);
                      }
                    }}
                  />
                </div>
              </div>

              {activeGroups.length > 0 && (
                <div className="contiguous-banner">
                  <div className="contiguous-banner-info">
                    <Layers size={14} color="#38bdf8" />
                    <div style={{ minWidth: 0 }}>
                      <strong className="contiguous-banner-title">{activeGroups[0].label}</strong>
                      <div className="contiguous-banner-sub">
                        {activeGroups[0].entries.length} contiguous {activeGroups[0].targetKind}
                        {(() => {
                          const sk = isDriveSource
                            ? makeArchiveSeriesKey(
                                'gdrive_oauth',
                                currentDriveFolder.id,
                                activeGroups[0].groupId,
                              )
                            : makeArchiveSeriesKey(
                                activeSourceId,
                                prefix,
                                activeGroups[0].groupId,
                              );
                          const savedPref = getArchiveCombinePref(sk);
                          return savedPref
                            ? ` · Remembered: ${savedPref === 'combine' ? 'Combine' : 'Single'}`
                            : '';
                        })()}
                      </div>
                    </div>
                  </div>
                  <div className="contiguous-banner-actions">
                    {(() => {
                      const sk = isDriveSource
                        ? makeArchiveSeriesKey(
                            'gdrive_oauth',
                            currentDriveFolder.id,
                            activeGroups[0].groupId,
                          )
                        : makeArchiveSeriesKey(
                            activeSourceId,
                            prefix,
                            activeGroups[0].groupId,
                          );
                      const savedPref = getArchiveCombinePref(sk);
                      return savedPref ? (
                        <button
                          className="btn-small"
                          title="Clear remembered choice"
                          onClick={() => {
                            setArchiveCombinePref(sk, null);
                            setPrefsVersion((v) => v + 1);
                          }}
                        >
                          <RotateCcw size={11} />
                        </button>
                      ) : null;
                    })()}
                    <button
                      className="btn-small btn-primary"
                      disabled={combiningBusy}
                      onClick={() => {
                        if (isDriveSource) {
                          const itemMap = new Map(driveItems.map((d) => [d.id, d]));
                          const matched = activeGroups[0].entries
                            .map((e) => itemMap.get(e.uri))
                            .filter((d): d is DriveItem => Boolean(d));
                          void combineDriveItems(matched, activeGroups[0].label);
                        } else {
                          void combineSourceItems(
                            activeGroups[0].entries,
                            activeGroups[0].label,
                          );
                        }
                      }}
                    >
                      <Layers size={12} />{' '}
                      {combiningBusy ? 'Combining...' : 'Open Combined'}
                    </button>
                  </div>
                </div>
              )}

              {activeSelectionCount > 0 && (
                <div className="selection-combine-bar">
                  <span>{activeSelectionCount} selected</span>
                  <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      className="btn-small"
                      onClick={() =>
                        isDriveSource ? setSelectedDriveIds([]) : setSelectedUris([])
                      }
                    >
                      Clear
                    </button>
                    <button
                      className="btn-small"
                      disabled={combiningBusy}
                      onClick={() => {
                        if (isDriveSource) {
                          const chosen = driveItems.filter((d) =>
                            selectedDriveIds.includes(d.id),
                          );
                          void openMultipleDriveItemsSeparately(chosen);
                        } else {
                          const chosen = entries.filter((e) => selectedUris.includes(e.uri));
                          void openMultipleSourceItemsSeparately(chosen);
                        }
                      }}
                    >
                      Open ({activeSelectionCount})
                    </button>
                    <button
                      className="btn-small btn-primary"
                      disabled={combiningBusy}
                      onClick={() => {
                        if (isDriveSource) {
                          const chosen = driveItems.filter((d) =>
                            selectedDriveIds.includes(d.id),
                          );
                          void combineDriveItems(chosen);
                        } else {
                          const chosen = entries.filter((e) => selectedUris.includes(e.uri));
                          void combineSourceItems(chosen);
                        }
                      }}
                    >
                      <Layers size={12} />{' '}
                      {combiningBusy ? 'Combining...' : `Combine (${activeSelectionCount})`}
                    </button>
                  </div>
                </div>
              )}

              {(browseError || driveError) && (
                <div className="inline-error">{browseError || driveError}</div>
              )}

              <div className="browser-list">
                {(loading || driveLoading) && (
                  <div className="panel-empty">Loading recordings...</div>
                )}

                {!isDriveSource &&
                  !loading &&
                  visibleEntries.map((entry) => {
                    if (entry.name === '..') {
                      return (
                        <div key={entry.uri} className="browser-row-wrap">
                          <span className="browser-row-check-spacer" />
                          <button
                            className="browser-row"
                            onClick={() => void handleEntryClick(entry)}
                          >
                            <span className="browser-icon">
                              <ArrowLeft size={14} color="#94a3b8" />
                            </span>
                            <span className="browser-name">.. (Parent folder)</span>
                          </button>
                        </div>
                      );
                    }

                    const canSelect = entry.isDir || entry.kind === 'audio';
                    const checked = selectedUris.includes(entry.uri);
                    const singleKey = makeSingleRecordingKey(activeSourceId, entry.uri);
                    const wasViewed = !entry.isDir && Boolean(getRecordingViewState(singleKey));
                    const parts = splitFolderAndFile(entry.name, entry.uri, prefix);

                    return (
                      <div key={entry.uri} className="browser-row-wrap">
                        {canSelect ? (
                          <input
                            type="checkbox"
                            className="browser-row-check"
                            checked={checked}
                            onChange={() => toggleSourceSelect(entry.uri)}
                            title="Select recording or folder"
                          />
                        ) : (
                          <span className="browser-row-check-spacer" />
                        )}
                        <button
                          className="browser-row"
                          onClick={() => void handleEntryClick(entry)}
                        >
                          <span className="browser-icon">
                            {entry.isDir ? (
                              <Folder size={14} color="#60a5fa" />
                            ) : entry.kind === 'audio' ? (
                              <FileAudio size={14} color="#4ade80" />
                            ) : (
                              <FileText size={14} color="#facc15" />
                            )}
                          </span>
                          <span className="browser-name">
                            {entry.isDir ? (
                              <span className="browser-file-strong">{parts.file}/</span>
                            ) : (
                              <>
                                {parts.folder && (
                                  <span className="browser-folder-pfx">{parts.folder} / </span>
                                )}
                                <span className="browser-file-strong">{parts.file}</span>
                              </>
                            )}
                          </span>
                          <span className="browser-meta-inline mono">
                            {wasViewed ? 'Viewed' : ''}
                            {wasViewed && entry.sizeBytes != null ? ' · ' : ''}
                            {entry.isDir ? 'Folder' : formatBytes(entry.sizeBytes)}
                          </span>
                        </button>
                      </div>
                    );
                  })}

                {isDriveSource &&
                  !driveLoading &&
                  visibleDriveItems.map((item) => {
                    const canSelect = item.isFolder || item.kind === 'audio';
                    const checked = selectedDriveIds.includes(item.id);
                    const parts = splitFolderAndFile(
                      item.name,
                      item.id,
                      currentDriveFolder.id === 'root' || currentDriveFolder.id === 'sharedWithMe'
                        ? ''
                        : currentDriveFolder.name,
                    );

                    return (
                      <div key={item.id} className="browser-row-wrap">
                        {canSelect ? (
                          <input
                            type="checkbox"
                            className="browser-row-check"
                            checked={checked}
                            onChange={() => toggleDriveSelect(item.id)}
                            title="Select recording or folder"
                          />
                        ) : (
                          <span className="browser-row-check-spacer" />
                        )}
                        <button
                          className="browser-row"
                          onClick={() => void handleDriveItemClick(item)}
                        >
                          <span className="browser-icon">
                            {item.isFolder ? (
                              <Folder size={14} color="#60a5fa" />
                            ) : item.kind === 'audio' ? (
                              <FileAudio size={14} color="#4ade80" />
                            ) : (
                              <FileText size={14} color="#facc15" />
                            )}
                          </span>
                          <span className="browser-name">
                            {item.isFolder ? (
                              <span className="browser-file-strong">{parts.file}/</span>
                            ) : (
                              <>
                                {parts.folder && (
                                  <span className="browser-folder-pfx">{parts.folder} / </span>
                                )}
                                <span className="browser-file-strong">{parts.file}</span>
                              </>
                            )}
                          </span>
                          <span className="browser-meta-inline mono">
                            {item.isFolder ? 'Folder' : formatBytes(item.sizeBytes)}
                          </span>
                        </button>
                      </div>
                    );
                  })}

                {!loading &&
                  !driveLoading &&
                  (isDriveSource ? visibleDriveItems.length === 0 : visibleEntries.length === 0) &&
                  !browseError &&
                  !driveError && (
                    <div className="panel-empty">
                      No matching folders or recordings in {currentFolderName}.
                    </div>
                  )}
              </div>
            </>
          )}

          {pendingPrompt && (
            <div className="combine-confirm-overlay" onClick={() => setPendingPrompt(null)}>
              <div className="combine-confirm-card" onClick={(e) => e.stopPropagation()}>
                <div className="combine-confirm-title">
                  <Layers size={15} color="#38bdf8" /> Combine Contiguous Recordings?
                </div>
                <div className="combine-confirm-sample">
                  <strong>{pendingPrompt.group.label}</strong>
                  <span className="mono" style={{ marginLeft: 8, color: '#94a3b8' }}>
                    {pendingPrompt.group.entries.length} {pendingPrompt.group.targetKind}
                    {pendingPrompt.group.totalSizeBytes > 0
                      ? ` · ${formatBytes(pendingPrompt.group.totalSizeBytes)}`
                      : ''}
                  </span>
                </div>
                <p className="modal-hint">
                  Combine these {pendingPrompt.group.targetKind} into a single continuous recording
                  for spectrogram view, detectors, and AI analysis?
                  {(() => {
                    const previewSaved = getRecordingViewState(
                      makeCombinedRecordingKey(
                        pendingPrompt.origin === 'source' ? activeSourceId : 'gdrive_oauth',
                        pendingPrompt.group.entries.map((e) => ({ uri: e.uri })),
                      ),
                    );
                    return previewSaved
                      ? ` Restores at ${formatRecordingTime(previewSaved.windowStartSec + (previewSaved.viewRange?.startSec ?? 0), { totalDurationSec: previewSaved.totalDurationSec, startDateTimeIso: previewSaved.startDateTimeIso, name: previewSaved.segments?.[0]?.name ?? previewSaved.label, uri: previewSaved.uri })}.`
                      : '';
                  })()}
                </p>

                <label className="inline-check" style={{ fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={rememberCombineChoice}
                    onChange={(e) => setRememberCombineChoice(e.target.checked)}
                  />
                  Remember my choice for this archive
                </label>

                <div className="combine-confirm-actions">
                  <button className="btn-small" onClick={() => setPendingPrompt(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn-small"
                    onClick={() => void handleResolvePendingPrompt('single')}
                  >
                    Open Single
                  </button>
                  <button
                    className="btn-small btn-primary"
                    onClick={() => void handleResolvePendingPrompt('combine')}
                  >
                    <Layers size={12} /> Combine &amp; Open
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-small" onClick={() => setModalState('showFileBrowser', false)}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
