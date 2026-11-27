import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  Database,
  ExternalLink,
  FlaskConical,
  FolderOpen,
  Globe,
  HardDrive,
  Info,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  LogOut,
  Package,
  Plus,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import type {
  CreateSourceRequest,
  DataSourceInfo,
  DiscoveredSourceCandidate,
  DiscoveryProviderInfo,
  SourceVerificationResult,
} from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';
import {
  getAccessToken,
  googleSignIn,
  logout,
  toGoogleUserProfile,
} from '../../auth/googleAuth';
import {
  DataSourceToArchiveTarget,
  buildStaticArchiveAbout,
  type ArchiveTargetInput,
} from '../../utils/archiveDocs';

const PROVIDER_KEYS_STORAGE_KEY = 'syrinxone.providerKeys.v1';
const RECENT_SOURCES_STORAGE_KEY = 'syrinxone.recentSources.v1';
const MAX_RECENT_SOURCES = 16;

const QUICK_SEARCH_CHIPS = [
  'distributed microphone array',
  'DEMAND 16-channel',
  'OpenSoundscape localization',
  'terrestrial birdsong',
  'marine mammal passive acoustics',
];

interface RecentSourceEntry {
  sourceId: string;
  displayName: string;
  kind: string;
  description?: string;
  rootPath?: string;
  anonymous?: boolean;
  connectRequest?: CreateSourceRequest;
  providerId?: string;
  homepageUrl?: string;
  license?: string;
  lastUsedAt: number;
}

function loadSavedProviderKeys(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(PROVIDER_KEYS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) out[k] = v.trim();
      }
      return out;
    }
  } catch {
    // ignore storage errors
  }
  return {};
}

function persistProviderKeys(keys: Record<string, string>): void {
  try {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys)) {
      if (v.trim()) cleaned[k] = v.trim();
    }
    window.localStorage.setItem(PROVIDER_KEYS_STORAGE_KEY, JSON.stringify(cleaned));
  } catch {
    // ignore storage errors
  }
}

function loadRecentSources(): RecentSourceEntry[] {
  try {
    const raw = window.localStorage.getItem(RECENT_SOURCES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return (parsed as RecentSourceEntry[])
        .filter((r) => r && typeof r.sourceId === 'string' && typeof r.displayName === 'string')
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .slice(0, MAX_RECENT_SOURCES);
    }
  } catch {
    // ignore storage errors
  }
  return [];
}

function persistRecentSources(list: RecentSourceEntry[]): void {
  try {
    window.localStorage.setItem(
      RECENT_SOURCES_STORAGE_KEY,
      JSON.stringify(list.slice(0, MAX_RECENT_SOURCES)),
    );
  } catch {
    // ignore storage errors
  }
}

function upsertRecentSource(
  current: RecentSourceEntry[],
  entry: Omit<RecentSourceEntry, 'lastUsedAt'>,
): RecentSourceEntry[] {
  // Never store raw API keys or OAuth tokens in recent history (keys live in providerKeys vault)
  const safeReq = entry.connectRequest
    ? { ...entry.connectRequest, apiKey: undefined, oauthToken: undefined }
    : undefined;
  const nextItem: RecentSourceEntry = {
    ...entry,
    connectRequest: safeReq,
    lastUsedAt: Date.now(),
  };
  const filtered = current.filter((item) => item.sourceId !== entry.sourceId);
  const next = [nextItem, ...filtered].slice(0, MAX_RECENT_SOURCES);
  persistRecentSources(next);
  return next;
}

function formatSampleRate(hz?: number): string | null {
  if (!hz || hz <= 0) return null;
  if (hz >= 1000) {
    const khz = hz / 1000;
    return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
  }
  return `${hz} Hz`;
}

function CompactStatusPill({ verification }: { verification: SourceVerificationResult }) {
  const srText = formatSampleRate(verification.sampleRateHz);
  const chText =
    verification.numChannels && verification.numChannels > 1
      ? `${verification.numChannels} ch`
      : null;

  if (verification.status === 'verified') {
    return (
      <span className="ver-badge ver-badge-verified" title={verification.message}>
        <CheckCircle2 size={10} />
        <span>Verified</span>
        {srText && <span>· {srText}</span>}
        {chText && <span>· {chText}</span>}
      </span>
    );
  }
  if (verification.status === 'zipped_only') {
    return (
      <span className="ver-badge ver-badge-zipped" title={verification.message}>
        <Package size={10} />
        <span>Archive Only</span>
      </span>
    );
  }
  if (verification.status === 'auth_required') {
    return (
      <span className="ver-badge ver-badge-auth" title={verification.message}>
        <Lock size={10} />
        <span>API Key</span>
      </span>
    );
  }
  if (verification.status === 'incompatible' || verification.status === 'error') {
    return (
      <span className="ver-badge ver-badge-error" title={verification.message}>
        <AlertTriangle size={10} />
        <span>{verification.status === 'incompatible' ? 'No Audio' : 'Error'}</span>
      </span>
    );
  }
  return (
    <span className="ver-badge ver-badge-untested" title={verification.message || 'Not tested yet'}>
      <FlaskConical size={10} />
      <span>Untested</span>
    </span>
  );
}

function SourceKindIcon({ kind }: { kind: string }) {
  if (kind === 'local_fs') return <HardDrive size={14} color="#4ade80" />;
  if (kind === 'gdrive') return <Globe size={14} color="#facc15" />;
  if (kind === 'http' || kind === 'archive') return <Link2 size={14} color="#38bdf8" />;
  return <Cloud size={14} color="#60a5fa" />;
}

export const SourceModal: React.FC = () => {
  const show = useWorkspaceStore((s) => s.showSourceModal);
  const sourceReturnToBrowser = useWorkspaceStore((s) => s.sourceReturnToBrowser);
  const engine = useWorkspaceStore((s) => s.engine);
  const activeSourceId = useWorkspaceStore((s) => s.activeSourceId);
  const setActiveSource = useWorkspaceStore((s) => s.setActiveSource);
  const openAboutArchive = useWorkspaceStore((s) => s.openAboutArchive);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const setStatus = useWorkspaceStore((s) => s.setStatus);
  const googleUser = useWorkspaceStore((s) => s.googleUser);
  const hasDriveToken = useWorkspaceStore((s) => s.hasDriveToken);
  const setGoogleAuthState = useWorkspaceStore((s) => s.setGoogleAuthState);

  const [engineSources, setEngineSources] = useState<DataSourceInfo[]>([]);
  const [recentSources, setRecentSources] = useState<RecentSourceEntry[]>(() =>
    typeof window !== 'undefined' ? loadRecentSources() : [],
  );
  const [error, setError] = useState<string | null>(null);
  const [driveBusyAuth, setDriveBusyAuth] = useState(false);

  // Collapsible drawers
  const [showFilters, setShowFilters] = useState(false);
  const [showApiKeysDrawer, setShowApiKeysDrawer] = useState(false);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [expandedInfoId, setExpandedInfoId] = useState<string | null>(null);

  // Custom source form
  const [newKind, setNewKind] = useState<
    'gdrive' | 's3' | 'gcs' | 'zenodo' | 'figshare' | 'huggingface' | 'archive' | 'http'
  >('zenodo');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newBucket, setNewBucket] = useState('');
  const [newPrefix, setNewPrefix] = useState('');
  const [newRegion, setNewRegion] = useState('us-west-2');
  const [newAnonymous, setNewAnonymous] = useState(true);
  const [newFolderOrUrl, setNewFolderOrUrl] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newOauthToken, setNewOauthToken] = useState('');
  const [connectBusy, setConnectBusy] = useState(false);
  const [customVerifyBusy, setCustomVerifyBusy] = useState(false);
  const [customVerification, setCustomVerification] = useState<SourceVerificationResult | null>(null);

  // Generic Discovery & Provider API Keys
  const [providers, setProviders] = useState<DiscoveryProviderInfo[]>([]);
  const [selectedProviderIds, setSelectedProviderIds] = useState<string[]>([]);
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>(() =>
    typeof window !== 'undefined' ? loadSavedProviderKeys() : {},
  );
  const [discoverPrompt, setDiscoverPrompt] = useState('');
  const [autoVerify, setAutoVerify] = useState(true);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [discoverWarnings, setDiscoverWarnings] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<DiscoveredSourceCandidate[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [verifyingCandidateId, setVerifyingCandidateId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [inlineKeyCandidateId, setInlineKeyCandidateId] = useState<string | null>(null);
  const [inlineKeyDraft, setInlineKeyDraft] = useState('');

  const providerMap = useMemo(() => {
    const map: Record<string, DiscoveryProviderInfo> = {};
    for (const p of providers) map[p.providerId] = p;
    return map;
  }, [providers]);

  const authCapableProviders = useMemo(
    () => providers.filter((p) => p.authKind !== 'none'),
    [providers],
  );

  const configuredKeyCount = useMemo(
    () =>
      authCapableProviders.filter(
        (p) => p.authConfiguredOnServer || Boolean(providerKeys[p.providerId]?.trim()),
      ).length,
    [authCapableProviders, providerKeys],
  );

  const hasLocalEngineSource = useMemo(
    () => engineSources.some((s) => s.sourceId === 'local'),
    [engineSources],
  );

  // Merge user-saved recent sources with any currently connected removable session sources
  const displayedRecentSources = useMemo<RecentSourceEntry[]>(() => {
    const byId = new Map<string, RecentSourceEntry>();
    for (const r of recentSources) {
      byId.set(r.sourceId, r);
    }
    for (const src of engineSources) {
      if (!src.removable) continue;
      if (!byId.has(src.sourceId)) {
        byId.set(src.sourceId, {
          sourceId: src.sourceId,
          displayName: src.displayName,
          kind: src.kind,
          description: src.description,
          rootPath: src.rootPath,
          anonymous: src.anonymous,
          lastUsedAt: Date.now() - 1000,
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }, [recentSources, engineSources]);

  const loadEngineSources = async () => {
    try {
      const list = await engine.listSources();
      setEngineSources(list);
    } catch {
      setEngineSources([]);
    }
  };

  const loadProviders = async () => {
    try {
      const list = await engine.listDiscoveryProviders();
      setProviders(list);
    } catch {
      setProviders([]);
    }
  };

  useEffect(() => {
    if (!show) return;
    setError(null);
    setRecentSources(loadRecentSources());
    void loadEngineSources();
    void loadProviders();
  }, [show, engine]);

  if (!show) return null;

  const activateAndRecord = (
    entry: Omit<RecentSourceEntry, 'lastUsedAt'>,
    openBrowserAfter = sourceReturnToBrowser,
  ) => {
    setRecentSources((prev) => upsertRecentSource(prev, entry));
    setActiveSource(entry.sourceId, entry.displayName);
    setStatus(`Active source: ${entry.displayName}`);
    setModalState('showSourceModal', false);
    if (openBrowserAfter) {
      setModalState('showFileBrowser', true);
    }
  };

  const handleSelectRecent = async (item: RecentSourceEntry) => {
    setError(null);
    const isBuiltInTransport =
      item.sourceId === 'local' || item.sourceId === 'gdrive_oauth' || item.sourceId === 'http';
    const isRegistered = engineSources.some((s) => s.sourceId === item.sourceId);

    if (isBuiltInTransport || isRegistered) {
      activateAndRecord(item, true);
      return;
    }

    // Auto-reconnect previously used source if engine restarted (e.g. Cloud Run cold start)
    if (item.connectRequest) {
      setConnectingId(item.sourceId);
      try {
        const key = item.providerId ? providerKeys[item.providerId]?.trim() : undefined;
        const created = await engine.addSource({
          ...item.connectRequest,
          ...(key ? { apiKey: key } : {}),
        });
        await loadEngineSources();
        activateAndRecord(
          {
            ...item,
            sourceId: created.sourceId,
            displayName: created.displayName,
            kind: created.kind,
            rootPath: created.rootPath,
            description: created.description ?? item.description,
            anonymous: created.anonymous,
          },
          true,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to reconnect ${item.displayName}`);
      } finally {
        setConnectingId(null);
      }
      return;
    }

    setError(`Source "${item.displayName}" is no longer connected on this engine session. Search or reconnect it.`);
  };

  const handleRemoveRecent = async (e: React.MouseEvent, item: RecentSourceEntry) => {
    e.stopPropagation();
    const next = recentSources.filter((r) => r.sourceId !== item.sourceId);
    setRecentSources(next);
    persistRecentSources(next);

    const registered = engineSources.find((s) => s.sourceId === item.sourceId && s.removable);
    if (registered) {
      try {
        await engine.removeSource(item.sourceId);
        await loadEngineSources();
      } catch {
        // ignore if already gone
      }
    }
    if (activeSourceId === item.sourceId) {
      setActiveSource(hasLocalEngineSource ? 'local' : 'http', hasLocalEngineSource ? 'Local Files' : 'Direct Audio URL');
    }
  };

  const updateProviderKey = (providerId: string, value: string) => {
    setProviderKeys((prev) => {
      const next = { ...prev };
      if (value.trim()) next[providerId] = value;
      else delete next[providerId];
      persistProviderKeys(next);
      return next;
    });
  };

  const toggleProviderFilter = (providerId: string) => {
    setSelectedProviderIds((prev) =>
      prev.includes(providerId) ? prev.filter((id) => id !== providerId) : [...prev, providerId],
    );
  };

  const buildCandidateConnectRequest = (
    cand: DiscoveredSourceCandidate,
    overrideKey?: string,
  ): CreateSourceRequest => {
    const key =
      overrideKey?.trim() ||
      cand.connectRequest.apiKey?.trim() ||
      providerKeys[cand.providerId]?.trim() ||
      undefined;
    return {
      ...cand.connectRequest,
      apiKey: key,
    };
  };

  const handleDiscover = async (overridePrompt?: string) => {
    const query = (overridePrompt ?? discoverPrompt).trim();
    if (!query) return;
    if (overridePrompt !== undefined) setDiscoverPrompt(overridePrompt);
    setDiscoverBusy(true);
    setError(null);
    setDiscoverWarnings([]);
    setInlineKeyCandidateId(null);
    setExpandedInfoId(null);
    try {
      const cleanedKeys: Record<string, string> = {};
      for (const [k, v] of Object.entries(providerKeys)) {
        if (v.trim()) cleanedKeys[k] = v.trim();
      }
      const res = await engine.discoverSources({
        prompt: query,
        providerIds: selectedProviderIds.length > 0 ? selectedProviderIds : undefined,
        providerKeys: Object.keys(cleanedKeys).length > 0 ? cleanedKeys : undefined,
        verifyTopN: autoVerify ? 8 : 0,
        limit: 18,
      });
      setCandidates(res.candidates);
      setDiscoverWarnings(res.warnings);
      setHasSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Archive search failed');
    } finally {
      setDiscoverBusy(false);
    }
  };

  const handleVerifyCandidate = async (
    e: React.MouseEvent,
    cand: DiscoveredSourceCandidate,
  ) => {
    e.stopPropagation();
    setVerifyingCandidateId(cand.candidateId);
    setError(null);
    try {
      const verification = await engine.verifySource(buildCandidateConnectRequest(cand));
      setCandidates((prev) =>
        prev.map((c) => (c.candidateId === cand.candidateId ? { ...c, verification } : c)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compatibility check failed');
    } finally {
      setVerifyingCandidateId(null);
    }
  };

  const handleConnectCandidate = async (
    cand: DiscoveredSourceCandidate,
    overrideKey?: string,
  ) => {
    const prov = providerMap[cand.providerId];
    const effectiveKey =
      overrideKey?.trim() ||
      cand.connectRequest.apiKey?.trim() ||
      providerKeys[cand.providerId]?.trim();
    const needsKey = cand.authRequired && !effectiveKey && !prov?.authConfiguredOnServer;

    if (needsKey) {
      setInlineKeyCandidateId(cand.candidateId);
      setInlineKeyDraft(providerKeys[cand.providerId] ?? '');
      return;
    }

    if (overrideKey?.trim()) {
      updateProviderKey(cand.providerId, overrideKey.trim());
    }

    setConnectingId(cand.candidateId);
    setError(null);
    try {
      const req = buildCandidateConnectRequest(cand, overrideKey);
      const created = await engine.addSource(req);
      setInlineKeyCandidateId(null);
      setInlineKeyDraft('');
      await loadEngineSources();
      activateAndRecord(
        {
          sourceId: created.sourceId,
          displayName: created.displayName,
          kind: created.kind,
          description: cand.description || created.description,
          rootPath: created.rootPath,
          anonymous: created.anonymous,
          connectRequest: req,
          providerId: cand.providerId,
          homepageUrl: cand.homepageUrl,
          license: cand.license,
        },
        true,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect archive');
    } finally {
      setConnectingId(null);
    }
  };

  const buildCustomRequest = async (): Promise<CreateSourceRequest> => {
    const activeOauthToken =
      newKind === 'gdrive'
        ? newOauthToken.trim() || (await getAccessToken()) || undefined
        : undefined;
    return {
      kind: newKind,
      displayName: newDisplayName.trim() || undefined,
      bucket: newKind === 's3' || newKind === 'gcs' ? newBucket.trim() : undefined,
      prefix:
        newKind === 's3' || newKind === 'gcs' || newKind === 'huggingface'
          ? newPrefix.trim()
          : undefined,
      region: newKind === 's3' ? newRegion.trim() || undefined : undefined,
      anonymous: newKind === 'gdrive' && activeOauthToken ? false : newAnonymous,
      folderOrUrl:
        newKind === 'gdrive' ||
        newKind === 'http' ||
        newKind === 'zenodo' ||
        newKind === 'figshare' ||
        newKind === 'huggingface' ||
        newKind === 'archive'
          ? newFolderOrUrl.trim()
          : undefined,
      apiKey: newKind === 'gdrive' || newKind === 'huggingface' ? newApiKey.trim() || undefined : undefined,
      oauthToken: activeOauthToken,
      readOnly: true,
    };
  };

  const handleTestCustom = async () => {
    setCustomVerifyBusy(true);
    setCustomVerification(null);
    setError(null);
    try {
      const req = await buildCustomRequest();
      setCustomVerification(await engine.verifySource(req));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compatibility test failed');
    } finally {
      setCustomVerifyBusy(false);
    }
  };

  const handleConnectCustom = async () => {
    setConnectBusy(true);
    setError(null);
    try {
      const req = await buildCustomRequest();
      const created = await engine.addSource(req);
      setNewDisplayName('');
      setNewFolderOrUrl('');
      setCustomVerification(null);
      setShowCustomForm(false);
      await loadEngineSources();
      activateAndRecord(
        {
          sourceId: created.sourceId,
          displayName: created.displayName,
          kind: created.kind,
          description: created.description,
          rootPath: created.rootPath,
          anonymous: created.anonymous,
          connectRequest: req,
        },
        true,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect custom source');
    } finally {
      setConnectBusy(false);
    }
  };

  const handleDriveQuickClick = async () => {
    if (hasDriveToken) {
      activateAndRecord(
        {
          sourceId: 'gdrive_oauth',
          displayName: 'My Google Drive',
          kind: 'gdrive',
          description: googleUser?.email ? `Google Drive (${googleUser.email})` : 'Private & shared Drive folders',
          anonymous: false,
        },
        true,
      );
      return;
    }
    setDriveBusyAuth(true);
    setError(null);
    try {
      const res = await googleSignIn();
      setGoogleAuthState(toGoogleUserProfile(res.user), true);
      activateAndRecord(
        {
          sourceId: 'gdrive_oauth',
          displayName: 'My Google Drive',
          kind: 'gdrive',
          description: res.user.email ? `Google Drive (${res.user.email})` : 'Private & shared Drive folders',
          anonymous: false,
        },
        true,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setDriveBusyAuth(false);
    }
  };

  const handleDriveSignOut = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await logout();
    setGoogleAuthState(null, false);
    if (activeSourceId === 'gdrive_oauth') {
      setActiveSource(hasLocalEngineSource ? 'local' : 'http', hasLocalEngineSource ? 'Local Files' : 'Direct Audio URL');
    }
    setStatus('Signed out of Google');
  };

  const openAboutForRecent = (e: React.MouseEvent, item: RecentSourceEntry) => {
    e.stopPropagation();
    const matched = engineSources.find((s) => s.sourceId === item.sourceId);
    const target: ArchiveTargetInput = matched
      ? DataSourceToArchiveTarget(matched)
      : {
          sourceId: item.sourceId,
          displayName: item.displayName,
          kind: item.kind,
          rootPath: item.rootPath,
          description: item.description,
          anonymous: item.anonymous,
          connectReq: item.connectRequest,
        };
    openAboutArchive(target);
  };

  return (
    <div className="modal-backdrop" onClick={() => setModalState('showSourceModal', false)}>
      <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Database size={15} color="#38bdf8" /> Sound Sources
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <button
              className="btn-small"
              onClick={() => {
                setModalState('showSourceModal', false);
                setModalState('showEngineModal', true);
              }}
              title="Configure Python Audio Engine URL"
            >
              <Server size={12} /> Engine
            </button>
            <button className="mdi-icon-btn" onClick={() => setModalState('showSourceModal', false)}>
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {error && <div className="inline-error">{error}</div>}

          {/* Primary Search Bar */}
          <form
            className="discover-search-row"
            onSubmit={(e) => {
              e.preventDefault();
              void handleDiscover();
            }}
          >
            <div className="discover-input-wrap">
              <Search size={14} className="discover-input-icon" />
              <input
                type="text"
                value={discoverPrompt}
                onChange={(e) => setDiscoverPrompt(e.target.value)}
                placeholder="Search acoustic archives (e.g., distributed microphone array, DEMAND, birdsong, AudioMoth)..."
              />
            </div>
            <button
              type="submit"
              className="btn-small btn-primary"
              disabled={discoverBusy || !discoverPrompt.trim()}
            >
              {discoverBusy ? (
                <>
                  <Loader2 size={12} className="spin" /> Searching
                </>
              ) : (
                <>
                  <Search size={12} /> Search
                </>
              )}
            </button>
          </form>

          {/* Compact Utility Strip: Personal Access + Filters + API Keys + Custom */}
          <div className="src-utility-bar">
            <div className="src-utility-group">
              {hasLocalEngineSource && (
                <button
                  type="button"
                  className={`btn-small ${activeSourceId === 'local' ? 'btn-active' : ''}`}
                  onClick={() =>
                    activateAndRecord(
                      {
                        sourceId: 'local',
                        displayName: 'Local Files',
                        kind: 'local_fs',
                        description: 'Local disk & file upload',
                      },
                      true,
                    )
                  }
                >
                  <HardDrive size={11} color="#4ade80" /> Local
                </button>
              )}
              <button
                type="button"
                className={`btn-small ${activeSourceId === 'gdrive_oauth' ? 'btn-active' : ''}`}
                disabled={driveBusyAuth}
                onClick={() => void handleDriveQuickClick()}
                title={hasDriveToken ? `Google Drive (${googleUser?.email ?? 'Signed in'})` : 'Sign in to Google Drive'}
              >
                <Globe size={11} color="#facc15" /> {driveBusyAuth ? 'Signing in...' : 'Google Drive'}
              </button>
              {hasDriveToken && (
                <button
                  type="button"
                  className="mdi-icon-btn"
                  title="Sign out of Google Drive"
                  onClick={(e) => void handleDriveSignOut(e)}
                >
                  <LogOut size={11} />
                </button>
              )}
              <button
                type="button"
                className={`btn-small ${activeSourceId === 'http' ? 'btn-active' : ''}`}
                onClick={() =>
                  activateAndRecord(
                    {
                      sourceId: 'http',
                      displayName: 'Direct Audio URL',
                      kind: 'http',
                      description: 'Stream direct .wav / .flac / .ogg / .mp3 links',
                    },
                    true,
                  )
                }
              >
                <Link2 size={11} color="#38bdf8" /> URL
              </button>
              <button
                type="button"
                className={`btn-small ${showCustomForm ? 'btn-active' : ''}`}
                onClick={() => setShowCustomForm((v) => !v)}
              >
                <Plus size={11} /> Custom
              </button>
            </div>

            <div className="src-utility-group">
              <button
                type="button"
                className={`btn-small ${showFilters ? 'btn-active' : ''}`}
                onClick={() => setShowFilters((v) => !v)}
                title="Filter discovery providers and live verification"
              >
                <SlidersHorizontal size={11} />
                {selectedProviderIds.length > 0 ? `Providers (${selectedProviderIds.length})` : 'Providers'}
              </button>
              {authCapableProviders.length > 0 && (
                <button
                  type="button"
                  className={`btn-small ${showApiKeysDrawer ? 'btn-active' : ''}`}
                  onClick={() => setShowApiKeysDrawer((v) => !v)}
                  title="Manage optional or required provider API keys"
                >
                  <KeyRound size={11} /> Keys ({configuredKeyCount}/{authCapableProviders.length})
                </button>
              )}
            </div>
          </div>

          {/* Example Search Chips (shown before first search to keep dialog inviting & compact) */}
          {!hasSearched && (
            <div className="discover-chips-row">
              {QUICK_SEARCH_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className="discover-prompt-chip"
                  disabled={discoverBusy}
                  onClick={() => void handleDiscover(chip)}
                >
                  {chip}
                </button>
              ))}
            </div>
          )}

          {/* Collapsible Provider Filters */}
          {showFilters && providers.length > 0 && (
            <div className="src-compact-drawer">
              <div className="discover-provider-filters">
                <button
                  type="button"
                  className={`discover-provider-pill ${selectedProviderIds.length === 0 ? 'active' : ''}`}
                  onClick={() => setSelectedProviderIds([])}
                >
                  All ({providers.length})
                </button>
                {providers.map((p) => {
                  const isSelected = selectedProviderIds.includes(p.providerId);
                  const hasKey =
                    p.authConfiguredOnServer || Boolean(providerKeys[p.providerId]?.trim());
                  return (
                    <button
                      key={p.providerId}
                      type="button"
                      className={`discover-provider-pill ${isSelected ? 'active' : ''}`}
                      title={p.description}
                      onClick={() => toggleProviderFilter(p.providerId)}
                    >
                      <span>{p.displayName}</span>
                      {p.authRequired && !hasKey && <Lock size={10} />}
                      {p.authKind !== 'none' && hasKey && <Check size={10} color="#4ade80" />}
                    </button>
                  );
                })}
              </div>
              <label className="inline-check" style={{ fontSize: 11.5, marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={autoVerify}
                  onChange={(e) => setAutoVerify(e.target.checked)}
                />
                Auto-verify top results (browse &amp; WAV header probe)
              </label>
            </div>
          )}

          {/* Collapsible Provider API Keys Drawer */}
          {showApiKeysDrawer && authCapableProviders.length > 0 && (
            <div className="discover-keys-drawer">
              <div className="discover-keys-head">
                <strong>Provider API Keys</strong>
                <span>Stored locally in your browser; server-configured keys work automatically.</span>
              </div>
              <div className="discover-keys-list">
                {authCapableProviders.map((p) => {
                  const localVal = providerKeys[p.providerId] ?? '';
                  const statusText = p.authConfiguredOnServer
                    ? 'Server active'
                    : localVal.trim()
                      ? 'Saved locally'
                      : p.authRequired
                        ? 'Required'
                        : 'Optional';
                  return (
                    <div key={p.providerId} className="discover-key-row">
                      <div className="discover-key-title">
                        <span>{p.displayName}</span>
                        <span
                          className={`discover-key-status ${
                            p.authConfiguredOnServer || localVal.trim() ? 'ready' : ''
                          }`}
                        >
                          {statusText}
                        </span>
                        {p.authDocsUrl && (
                          <a
                            className="src-inline-link"
                            href={p.authDocsUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Get key <ExternalLink size={10} />
                          </a>
                        )}
                      </div>
                      <div className="discover-key-controls">
                        <input
                          type="password"
                          value={localVal}
                          placeholder={p.authHint || 'Paste API key or token'}
                          onChange={(e) => updateProviderKey(p.providerId, e.target.value)}
                        />
                        {localVal && (
                          <button
                            type="button"
                            className="btn-small"
                            onClick={() => updateProviderKey(p.providerId, '')}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Collapsible Custom Source Form */}
          {showCustomForm && (
            <div className="connect-source-panel">
              <div className="detect-grid">
                <div className="field-group">
                  <label>Source Type</label>
                  <select
                    value={newKind}
                    onChange={(e) => {
                      setNewKind(e.target.value as typeof newKind);
                      setCustomVerification(null);
                    }}
                  >
                    <option value="zenodo">Zenodo Record / DOI</option>
                    <option value="figshare">Figshare Article ID / URL</option>
                    <option value="huggingface">Hugging Face Audio Dataset</option>
                    <option value="archive">Remote .zip / .tar Archive URL</option>
                    <option value="s3">Amazon S3 / AWS Open Data</option>
                    <option value="gcs">Google Cloud Storage (GCS)</option>
                    <option value="gdrive">Google Drive Shared Folder / File</option>
                    <option value="http">HTTP Audio URLs</option>
                  </select>
                </div>

                <div className="field-group">
                  <label>Display Name (optional)</label>
                  <input
                    type="text"
                    value={newDisplayName}
                    placeholder="e.g., Field Array 2025"
                    onChange={(e) => setNewDisplayName(e.target.value)}
                  />
                </div>

                {(newKind === 's3' || newKind === 'gcs') && (
                  <>
                    <div className="field-group">
                      <label>Bucket Name</label>
                      <input
                        type="text"
                        value={newBucket}
                        placeholder={newKind === 's3' ? 'bucket-name' : 'gcs-bucket-name'}
                        onChange={(e) => setNewBucket(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label>Prefix / Subfolder (optional)</label>
                      <input
                        type="text"
                        value={newPrefix}
                        placeholder="recordings/"
                        onChange={(e) => setNewPrefix(e.target.value)}
                      />
                    </div>
                  </>
                )}

                {newKind === 's3' && (
                  <div className="field-group">
                    <label>Region (optional)</label>
                    <input
                      type="text"
                      value={newRegion}
                      placeholder="us-west-2"
                      onChange={(e) => setNewRegion(e.target.value)}
                    />
                  </div>
                )}

                {(newKind === 's3' || newKind === 'gcs') && (
                  <div className="field-group" style={{ justifyContent: 'flex-end' }}>
                    <label className="inline-check">
                      <input
                        type="checkbox"
                        checked={newAnonymous}
                        onChange={(e) => setNewAnonymous(e.target.checked)}
                      />
                      Anonymous public read
                    </label>
                  </div>
                )}
              </div>

              {(newKind === 'zenodo' ||
                newKind === 'figshare' ||
                newKind === 'huggingface' ||
                newKind === 'archive' ||
                newKind === 'gdrive') && (
                <div className="field-group" style={{ marginTop: 8 }}>
                  <label>
                    {newKind === 'zenodo'
                      ? 'Zenodo Record ID, DOI, or URL'
                      : newKind === 'figshare'
                        ? 'Figshare Article ID or URL'
                        : newKind === 'huggingface'
                          ? 'Hugging Face Dataset Repo (e.g., org/dataset)'
                          : newKind === 'archive'
                            ? 'Direct HTTPS URL to .zip or .tar archive'
                            : 'Google Drive Shared Folder / File URL or ID'}
                  </label>
                  <input
                    type="text"
                    value={newFolderOrUrl}
                    placeholder={
                      newKind === 'zenodo'
                        ? '1227121 or https://zenodo.org/records/1227121'
                        : newKind === 'figshare'
                          ? 'https://figshare.com/articles/dataset/.../1234567'
                          : newKind === 'huggingface'
                            ? 'philgzl/demand'
                            : newKind === 'archive'
                              ? 'https://example.org/dataset.zip'
                              : 'https://drive.google.com/drive/folders/...'
                    }
                    onChange={(e) => setNewFolderOrUrl(e.target.value)}
                  />
                </div>
              )}

              {newKind === 'huggingface' && (
                <div className="detect-grid" style={{ marginTop: 8 }}>
                  <div className="field-group">
                    <label>Subfolder Prefix (optional)</label>
                    <input
                      type="text"
                      value={newPrefix}
                      placeholder="optional subpath"
                      onChange={(e) => setNewPrefix(e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label>HF Token (optional)</label>
                    <input
                      type="password"
                      value={newApiKey}
                      placeholder="hf_..."
                      onChange={(e) => setNewApiKey(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {newKind === 'gdrive' && (
                <div className="detect-grid" style={{ marginTop: 8 }}>
                  <div className="field-group">
                    <label>Drive API Key (optional)</label>
                    <input
                      type="password"
                      value={newApiKey}
                      placeholder="Optional"
                      onChange={(e) => setNewApiKey(e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label>OAuth Token {hasDriveToken ? '(auto)' : '(optional)'}</label>
                    <input
                      type="password"
                      value={newOauthToken}
                      placeholder={hasDriveToken ? 'Signed-in session' : 'ya29....'}
                      onChange={(e) => setNewOauthToken(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {newKind === 'http' && (
                <div className="field-group" style={{ marginTop: 8 }}>
                  <label>Audio URLs (one per line or comma-separated)</label>
                  <textarea
                    rows={2}
                    value={newFolderOrUrl}
                    placeholder="https://example.org/recordings/clip_01.wav"
                    onChange={(e) => setNewFolderOrUrl(e.target.value)}
                  />
                </div>
              )}

              {customVerification && (
                <div className="custom-verify-banner">
                  <CompactStatusPill verification={customVerification} />
                  <span>{customVerification.message}</span>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn-small"
                  disabled={customVerifyBusy || connectBusy}
                  onClick={() => void handleTestCustom()}
                >
                  {customVerifyBusy ? <Loader2 size={11} className="spin" /> : <FlaskConical size={11} />} Test
                </button>
                <button
                  type="button"
                  className="btn-small btn-primary"
                  disabled={connectBusy}
                  onClick={() => void handleConnectCustom()}
                >
                  {connectBusy ? 'Connecting...' : 'Connect'}
                </button>
              </div>
            </div>
          )}

          {/* Warnings */}
          {discoverWarnings.length > 0 && (
            <div className="discover-warnings">
              {discoverWarnings.map((w, idx) => (
                <div key={idx} className="discover-warning-item">
                  <AlertTriangle size={12} /> <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {/* SEARCH RESULTS — Strictly 2 compact rows per source + on-demand Info drawer */}
          {(hasSearched || discoverBusy) && (
            <div className="source-section">
              <div className="connect-section-title">
                <span>Search Results {!discoverBusy ? `(${candidates.length})` : ''}</span>
                {hasSearched && !discoverBusy && (
                  <button
                    type="button"
                    className="btn-small"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => {
                      setHasSearched(false);
                      setCandidates([]);
                      setDiscoverWarnings([]);
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>

              {discoverBusy && candidates.length === 0 && (
                <div className="panel-empty">Searching providers &amp; verifying streamability...</div>
              )}

              {!discoverBusy && hasSearched && candidates.length === 0 && (
                <div className="panel-empty">
                  No matching archives found. Try broader terms like &ldquo;microphone array&rdquo;,
                  &ldquo;birdsong&rdquo;, or &ldquo;bioacoustics&rdquo;.
                </div>
              )}

              <div className="src-compact-list">
                {candidates.map((cand) => {
                  const prov = providerMap[cand.providerId];
                  const isVerifying = verifyingCandidateId === cand.candidateId;
                  const isConnecting = connectingId === cand.candidateId;
                  const isExpanded = expandedInfoId === cand.candidateId;
                  const isInlineKeyOpen = inlineKeyCandidateId === cand.candidateId;
                  const hasSavedKey =
                    Boolean(prov?.authConfiguredOnServer) ||
                    Boolean(providerKeys[cand.providerId]?.trim()) ||
                    Boolean(cand.connectRequest.apiKey?.trim());
                  const canConnect =
                    cand.verification.status !== 'zipped_only' &&
                    cand.verification.status !== 'incompatible';

                  const row2Parts = [
                    cand.providerLabel,
                    cand.connectRequest.kind.toUpperCase(),
                    cand.license,
                    cand.verification.audioFileCount > 0
                      ? `${cand.verification.audioFileCount}+ files`
                      : null,
                    cand.verification.formats.length > 0
                      ? cand.verification.formats.slice(0, 3).join('/')
                      : null,
                    cand.verification.supportsRange ? 'Range' : null,
                  ].filter(Boolean);

                  return (
                    <div key={cand.candidateId} className="src-row-card">
                      {/* Row 1: Title + Status + Compact Actions */}
                      <div className="src-row-1">
                        <span className="src-row-icon">
                          <SourceKindIcon kind={cand.connectRequest.kind} />
                        </span>
                        <span className="src-row-title" title={cand.title}>
                          {cand.title}
                        </span>
                        <CompactStatusPill verification={cand.verification} />
                        <div className="src-row-actions">
                          <button
                            type="button"
                            className={`mdi-icon-btn ${isExpanded ? 'btn-active' : ''}`}
                            title="More info"
                            onClick={() =>
                              setExpandedInfoId((prev) =>
                                prev === cand.candidateId ? null : cand.candidateId,
                              )
                            }
                          >
                            {isExpanded ? <ChevronUp size={13} /> : <Info size={13} />}
                          </button>
                          <button
                            type="button"
                            className="mdi-icon-btn"
                            disabled={isVerifying || isConnecting}
                            title="Test live compatibility"
                            onClick={(e) => void handleVerifyCandidate(e, cand)}
                          >
                            {isVerifying ? (
                              <Loader2 size={12} className="spin" />
                            ) : (
                              <FlaskConical size={12} />
                            )}
                          </button>
                          <button
                            type="button"
                            className={`btn-small ${canConnect ? 'btn-primary' : ''}`}
                            disabled={isConnecting || !canConnect}
                            onClick={() => void handleConnectCandidate(cand)}
                          >
                            {isConnecting ? (
                              <Loader2 size={11} className="spin" />
                            ) : cand.authRequired && !hasSavedKey ? (
                              <>
                                <KeyRound size={11} /> Key
                              </>
                            ) : (
                              'Connect'
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Row 2: Concise single-line metadata */}
                      <div className="src-row-2" title={row2Parts.join(' · ')}>
                        {row2Parts.join(' · ')}
                      </div>

                      {/* Expandable Info Drawer (only shown on user click) */}
                      {isExpanded && (
                        <div className="src-row-details">
                          {cand.description && <div className="src-detail-desc">{cand.description}</div>}
                          {cand.verification.message && (
                            <div className="src-detail-meta">
                              <strong>Probe:</strong> {cand.verification.message}
                              {cand.verification.sampleFileName
                                ? ` · Sample: ${cand.verification.sampleFileName}`
                                : ''}
                            </div>
                          )}
                          <div className="src-detail-footer">
                            {cand.tags.slice(0, 5).map((tag) => (
                              <span key={tag} className="discover-tag">
                                {tag}
                              </span>
                            ))}
                            {cand.homepageUrl && (
                              <a
                                className="src-inline-link"
                                style={{ marginLeft: 'auto' }}
                                href={cand.homepageUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Source Page <ExternalLink size={10} />
                              </a>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Inline Generic API Key Prompt */}
                      {isInlineKeyOpen && (
                        <div className="discover-inline-key-box" style={{ marginTop: 4 }}>
                          <div className="discover-inline-key-row">
                            <input
                              type="password"
                              value={inlineKeyDraft}
                              placeholder={cand.authHint ?? prov?.authHint ?? `Enter ${cand.providerLabel} API key`}
                              onChange={(e) => setInlineKeyDraft(e.target.value)}
                            />
                            <button
                              type="button"
                              className="btn-small btn-primary"
                              disabled={!inlineKeyDraft.trim() || isConnecting}
                              onClick={() => void handleConnectCandidate(cand, inlineKeyDraft)}
                            >
                              Save &amp; Connect
                            </button>
                            <button
                              type="button"
                              className="btn-small"
                              onClick={() => setInlineKeyCandidateId(null)}
                            >
                              Cancel
                            </button>
                            {(cand.authDocsUrl ?? prov?.authDocsUrl) && (
                              <a
                                className="src-inline-link"
                                href={cand.authDocsUrl ?? prov?.authDocsUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Get key <ExternalLink size={10} />
                              </a>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* RECENT SOURCES — Only user-selected sources (no hardcoded presets), strictly 2 compact rows */}
          <div className="source-section">
            <div className="connect-section-title">
              <span>Recent Sources ({displayedRecentSources.length})</span>
            </div>

            {displayedRecentSources.length === 0 ? (
              <div className="src-empty-recent">
                No recent sources yet. Search above or open Local / Google Drive / Custom to add a source.
              </div>
            ) : (
              <div className="src-compact-list">
                {displayedRecentSources.map((item) => {
                  const isActive = activeSourceId === item.sourceId;
                  const isBusy = connectingId === item.sourceId;
                  const isExpanded = expandedInfoId === `recent:${item.sourceId}`;
                  const row2Parts = [
                    item.kind === 'local_fs' ? 'Local disk & upload' : item.kind.toUpperCase(),
                    item.anonymous ? 'Public' : null,
                    item.license,
                    item.rootPath || null,
                  ].filter(Boolean);
                  const fallbackBrief =
                    item.description ||
                    buildStaticArchiveAbout({
                      sourceId: item.sourceId,
                      displayName: item.displayName,
                      kind: item.kind,
                      rootPath: item.rootPath,
                      anonymous: item.anonymous,
                    }).briefDescription;

                  return (
                    <div
                      key={item.sourceId}
                      className={`src-row-card clickable ${isActive ? 'active' : ''}`}
                      onClick={() => void handleSelectRecent(item)}
                    >
                      {/* Row 1: Icon + Title + Active + Compact Actions */}
                      <div className="src-row-1">
                        <span className="src-row-icon">
                          <SourceKindIcon kind={item.kind} />
                        </span>
                        <span className="src-row-title" title={item.displayName}>
                          {item.displayName}
                        </span>
                        {isActive && (
                          <span className="source-active-mark">
                            <Check size={11} /> Active
                          </span>
                        )}
                        {isBusy && <Loader2 size={12} className="spin" />}
                        <div className="src-row-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className={`mdi-icon-btn ${isExpanded ? 'btn-active' : ''}`}
                            title="More info"
                            onClick={() =>
                              setExpandedInfoId((prev) =>
                                prev === `recent:${item.sourceId}` ? null : `recent:${item.sourceId}`,
                              )
                            }
                          >
                            {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                          </button>
                          <button
                            type="button"
                            className="mdi-icon-btn"
                            title="Archive docs & README"
                            onClick={(e) => openAboutForRecent(e, item)}
                          >
                            <BookOpen size={12} />
                          </button>
                          <button
                            type="button"
                            className="mdi-icon-btn"
                            title="Remove from recent sources"
                            onClick={(e) => void handleRemoveRecent(e, item)}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>

                      {/* Row 2: Single-line metadata */}
                      <div className="src-row-2" title={row2Parts.join(' · ')}>
                        {row2Parts.join(' · ')}
                      </div>

                      {/* Expandable Info Drawer */}
                      {isExpanded && (
                        <div className="src-row-details" onClick={(e) => e.stopPropagation()}>
                          <div className="src-detail-desc">{fallbackBrief}</div>
                          <div className="src-detail-footer">
                            <button
                              type="button"
                              className="btn-small"
                              onClick={(e) => openAboutForRecent(e, item)}
                            >
                              <BookOpen size={11} /> Docs &amp; README
                            </button>
                            {item.homepageUrl && (
                              <a
                                className="src-inline-link"
                                href={item.homepageUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Source Page <ExternalLink size={10} />
                              </a>
                            )}
                            <button
                              type="button"
                              className="btn-small btn-primary"
                              style={{ marginLeft: 'auto' }}
                              disabled={isBusy}
                              onClick={() => void handleSelectRecent(item)}
                            >
                              Open
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-small" onClick={() => setModalState('showSourceModal', false)}>
            Done
          </button>
          <button
            className="btn-small btn-primary"
            onClick={() => {
              setModalState('showSourceModal', false);
              setModalState('showFileBrowser', true);
            }}
          >
            <FolderOpen size={13} /> Select Recordings
          </button>
        </div>
      </div>
    </div>
  );
};
