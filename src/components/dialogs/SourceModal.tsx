import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cloud,
  Compass,
  Database,
  ExternalLink,
  FileText,
  FlaskConical,
  FolderOpen,
  Globe,
  HardDrive,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  LogOut,
  Package,
  Plus,
  Search,
  Server,
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
import { GoogleSignInButton } from '../auth/GoogleSignInButton';
import {
  DataSourceToArchiveTarget,
  buildStaticArchiveAbout,
  discoverArchiveDocumentation,
  type ArchiveAboutSpec,
  type ArchiveTargetInput,
} from '../../utils/archiveDocs';

const PROVIDER_KEYS_STORAGE_KEY = 'syrinxone.providerKeys.v1';

const EXAMPLE_DISCOVERY_PROMPTS = [
  'terrestrial birdsong clips',
  'multi-channel microphone array',
  'rainforest elephants and primates',
  'frog and insect vocalizations',
  'marine mammal passive acoustics',
];

interface ArchivePreset {
  label: string;
  subtitle: string;
  req: CreateSourceRequest;
}

const ARCHIVE_PRESETS: ArchivePreset[] = [
  {
    label: 'MBARI Pacific Ocean Sound (256 kHz, 2022)',
    subtitle: 's3://pacific-sound-256khz-2022 · AWS Open Data',
    req: {
      kind: 's3',
      sourceId: 'mbari_256khz_2022',
      displayName: 'MBARI Pacific 2022',
      bucket: 'pacific-sound-256khz-2022',
      region: 'us-west-2',
      anonymous: true,
      readOnly: true,
    },
  },
  {
    label: 'MBARI Pacific Ocean Sound (256 kHz, 2023)',
    subtitle: 's3://pacific-sound-256khz-2023 · AWS Open Data',
    req: {
      kind: 's3',
      sourceId: 'mbari_256khz_2023',
      displayName: 'MBARI Pacific 2023',
      bucket: 'pacific-sound-256khz-2023',
      region: 'us-west-2',
      anonymous: true,
      readOnly: true,
    },
  },
  {
    label: 'NOAA NCEI SanctSound Audio (GCS)',
    subtitle: 'gs://noaa-passive-bioacoustic/sanctsound · US Marine Sanctuaries',
    req: {
      kind: 'gcs',
      sourceId: 'noaa_sanctsound',
      displayName: 'NOAA SanctSound',
      bucket: 'noaa-passive-bioacoustic',
      prefix: 'sanctsound',
      anonymous: true,
      readOnly: true,
    },
  },
];

function loadSavedProviderKeys(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(PROVIDER_KEYS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) {
          out[k] = v.trim();
        }
      }
      return out;
    }
  } catch {
    // Ignore storage read errors (e.g. private browsing)
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
    // Ignore storage quota/permission errors
  }
}

function formatSampleRate(hz?: number): string | null {
  if (!hz || hz <= 0) return null;
  if (hz >= 1000) {
    const khz = hz / 1000;
    return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
  }
  return `${hz} Hz`;
}

function VerificationBadge({ verification }: { verification: SourceVerificationResult }) {
  const srText = formatSampleRate(verification.sampleRateHz);
  const chText =
    verification.numChannels && verification.numChannels > 0
      ? verification.numChannels === 1
        ? '1 ch'
        : `${verification.numChannels} ch`
      : null;

  if (verification.status === 'verified') {
    return (
      <span className="ver-badge ver-badge-verified" title={verification.message}>
        <CheckCircle2 size={11} />
        <span>Verified</span>
        {verification.audioFileCount > 0 && <span>· {verification.audioFileCount}+ files</span>}
        {srText && <span>· {srText}</span>}
        {chText && <span>· {chText}</span>}
        {verification.supportsRange && <span>· Range</span>}
      </span>
    );
  }
  if (verification.status === 'zipped_only') {
    return (
      <span className="ver-badge ver-badge-zipped" title={verification.message}>
        <Package size={11} />
        <span>
          Zipped Only
          {verification.formats.length > 0 ? ` (${verification.formats.join(', ')})` : ''}
        </span>
      </span>
    );
  }
  if (verification.status === 'auth_required') {
    return (
      <span className="ver-badge ver-badge-auth" title={verification.message}>
        <Lock size={11} />
        <span>API Key Required</span>
      </span>
    );
  }
  if (verification.status === 'incompatible' || verification.status === 'error') {
    return (
      <span className="ver-badge ver-badge-error" title={verification.message}>
        <AlertTriangle size={11} />
        <span>{verification.status === 'incompatible' ? 'Not Streamable' : 'Check Failed'}</span>
      </span>
    );
  }
  return (
    <span className="ver-badge ver-badge-untested" title={verification.message || 'Click Test to probe live compatibility'}>
      <FlaskConical size={11} />
      <span>Untested</span>
    </span>
  );
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

  const [activeTab, setActiveTab] = useState<'connected' | 'discover'>('connected');

  // Connected sources state
  const [sources, setSources] = useState<DataSourceInfo[]>([]);
  const [archiveDocsMap, setArchiveDocsMap] = useState<Record<string, ArchiveAboutSpec>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [driveBusyAuth, setDriveBusyAuth] = useState(false);
  const [showCustomForm, setShowCustomForm] = useState(false);

  const [newKind, setNewKind] = useState<'s3' | 'gcs' | 'gdrive' | 'http'>('gdrive');
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

  // Generic Discovery & Provider API Keys state
  const [providers, setProviders] = useState<DiscoveryProviderInfo[]>([]);
  const [selectedProviderIds, setSelectedProviderIds] = useState<string[]>([]);
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>(() =>
    typeof window !== 'undefined' ? loadSavedProviderKeys() : {},
  );
  const [showApiKeysDrawer, setShowApiKeysDrawer] = useState(false);
  const [discoverPrompt, setDiscoverPrompt] = useState('');
  const [autoVerify, setAutoVerify] = useState(true);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [discoverWarnings, setDiscoverWarnings] = useState<string[]>([]);
  const [discoverTerms, setDiscoverTerms] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<DiscoveredSourceCandidate[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [verifyingCandidateId, setVerifyingCandidateId] = useState<string | null>(null);
  const [connectingCandidateId, setConnectingCandidateId] = useState<string | null>(null);
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

  const loadSources = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await engine.listSources();
      setSources(list);
      const initialMap: Record<string, ArchiveAboutSpec> = {};
      for (const s of list) {
        initialMap[s.sourceId] = buildStaticArchiveAbout(DataSourceToArchiveTarget(s));
      }
      for (const p of ARCHIVE_PRESETS) {
        const pid = p.req.sourceId ?? p.label;
        initialMap[pid] = buildStaticArchiveAbout({
          sourceId: pid,
          displayName: p.label,
          kind: p.req.kind,
          rootPath: p.req.prefix,
          connectReq: p.req,
          anonymous: p.req.anonymous,
        });
      }
      setArchiveDocsMap((prev) => ({ ...initialMap, ...prev }));

      // Discover README / doc files across connected sources in parallel
      void Promise.all(
        list.map(async (s) => {
          const spec = await discoverArchiveDocumentation(
            engine,
            DataSourceToArchiveTarget(s),
            { readText: true },
          );
          return [s.sourceId, spec] as const;
        }),
      ).then((entries) => {
        setArchiveDocsMap((prev) => {
          const next = { ...prev };
          for (const [id, spec] of entries) {
            next[id] = spec;
          }
          return next;
        });
      });
    } catch (err) {
      setSources([]);
      setError(err instanceof Error ? err.message : 'Failed to list connected sources');
    } finally {
      setLoading(false);
    }
  };

  const loadProviders = async () => {
    try {
      const list = await engine.listDiscoveryProviders();
      setProviders(list);
    } catch {
      // Engine may not support discovery yet; stay graceful
      setProviders([]);
    }
  };

  useEffect(() => {
    if (!show) return;
    void loadSources();
    void loadProviders();
  }, [show, engine]);

  if (!show) return null;

  const chooseSource = (sourceId: string, label: string, openBrowserAfter = sourceReturnToBrowser) => {
    setActiveSource(sourceId, label);
    setStatus(`Active source: ${label}`);
    setModalState('showSourceModal', false);
    if (openBrowserAfter) {
      setModalState('showFileBrowser', true);
    }
  };

  const handleOpenAbout = (e: React.MouseEvent, target: ArchiveTargetInput) => {
    e.stopPropagation();
    openAboutArchive(target);
  };

  const updateProviderKey = (providerId: string, value: string) => {
    setProviderKeys((prev) => {
      const next = { ...prev };
      if (value.trim()) {
        next[providerId] = value;
      } else {
        delete next[providerId];
      }
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
    if (overridePrompt !== undefined) {
      setDiscoverPrompt(overridePrompt);
    }
    setDiscoverBusy(true);
    setError(null);
    setDiscoverWarnings([]);
    setInlineKeyCandidateId(null);
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
      setDiscoverTerms(res.normalizedTerms);
      setHasSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Archive discovery search failed');
    } finally {
      setDiscoverBusy(false);
    }
  };

  const handleVerifyCandidate = async (
    cand: DiscoveredSourceCandidate,
    overrideKey?: string,
  ) => {
    setVerifyingCandidateId(cand.candidateId);
    setError(null);
    try {
      const req = buildCandidateConnectRequest(cand, overrideKey);
      const verification = await engine.verifySource(req);
      setCandidates((prev) =>
        prev.map((c) => (c.candidateId === cand.candidateId ? { ...c, verification } : c)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compatibility verification failed');
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
    const needsKey =
      cand.authRequired && !effectiveKey && !prov?.authConfiguredOnServer;

    if (needsKey) {
      setInlineKeyCandidateId(cand.candidateId);
      setInlineKeyDraft(providerKeys[cand.providerId] ?? '');
      return;
    }

    if (overrideKey?.trim()) {
      updateProviderKey(cand.providerId, overrideKey.trim());
    }

    setConnectingCandidateId(cand.candidateId);
    setError(null);
    try {
      const req = buildCandidateConnectRequest(cand, overrideKey);
      const created = await engine.addSource(req);
      setInlineKeyCandidateId(null);
      setInlineKeyDraft('');
      await loadSources();
      chooseSource(created.sourceId, created.displayName, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect discovered archive');
    } finally {
      setConnectingCandidateId(null);
    }
  };

  const handleConnectPreset = async (preset: ArchivePreset) => {
    setConnectBusy(true);
    setError(null);
    try {
      const created = await engine.addSource(preset.req);
      await loadSources();
      chooseSource(created.sourceId, created.displayName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect archive preset');
    } finally {
      setConnectBusy(false);
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
      prefix: newKind === 's3' || newKind === 'gcs' ? newPrefix.trim() : undefined,
      region: newKind === 's3' ? newRegion.trim() || undefined : undefined,
      anonymous: newKind === 'gdrive' && activeOauthToken ? false : newAnonymous,
      folderOrUrl: newKind === 'gdrive' || newKind === 'http' ? newFolderOrUrl.trim() : undefined,
      apiKey: newKind === 'gdrive' ? newApiKey.trim() || undefined : undefined,
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
      const res = await engine.verifySource(req);
      setCustomVerification(res);
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
      await loadSources();
      chooseSource(created.sourceId, created.displayName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect custom source');
    } finally {
      setConnectBusy(false);
    }
  };

  const handleRemoveSource = async (e: React.MouseEvent, src: DataSourceInfo) => {
    e.stopPropagation();
    if (!src.removable) return;
    try {
      await engine.removeSource(src.sourceId);
      if (activeSourceId === src.sourceId) {
        setActiveSource('local', 'Local Files');
      }
      await loadSources();
      setStatus(`Disconnected source: ${src.displayName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect source');
    }
  };

  const handleDriveSignIn = async () => {
    setDriveBusyAuth(true);
    setError(null);
    try {
      const res = await googleSignIn();
      setGoogleAuthState(toGoogleUserProfile(res.user), true);
      setStatus(`Signed in as ${res.user.email ?? 'Google Drive user'}`);
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
      setActiveSource('local', 'Local Files');
    }
    setStatus('Signed out of Google');
  };

  const hasHttpSource = sources.some((s) => s.sourceId === 'http');
  const gdriveAboutTarget: ArchiveTargetInput = {
    sourceId: 'gdrive_oauth',
    displayName: 'My Google Drive',
    kind: 'gdrive',
  };
  const gdriveAbout = archiveDocsMap.gdrive_oauth ?? buildStaticArchiveAbout(gdriveAboutTarget);

  return (
    <div className="modal-backdrop" onClick={() => setModalState('showSourceModal', false)}>
      <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header modal-header-wrap">
          <div className="modal-tab-row">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 6 }}>
              <Database size={15} color="#38bdf8" /> Sound Sources
            </span>
            <button
              type="button"
              className={`btn-small ${activeTab === 'connected' ? 'btn-active' : ''}`}
              onClick={() => setActiveTab('connected')}
            >
              <Cloud size={12} /> Connected ({sources.length})
            </button>
            <button
              type="button"
              className={`btn-small ${activeTab === 'discover' ? 'btn-active' : ''}`}
              onClick={() => setActiveTab('discover')}
            >
              <Compass size={12} /> Discover Archives
            </button>
          </div>
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

        <div className="modal-body">
          {error && <div className="inline-error">{error}</div>}

          {activeTab === 'discover' ? (
            <div className="discover-panel">
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
                    placeholder="Describe acoustic archives to find (e.g., terrestrial birdsong, multi-channel array, frog clips)..."
                  />
                </div>
                <button
                  type="submit"
                  className="btn-small btn-primary"
                  disabled={discoverBusy || !discoverPrompt.trim()}
                >
                  {discoverBusy ? (
                    <>
                      <Loader2 size={12} className="spin" /> Searching...
                    </>
                  ) : (
                    <>
                      <Search size={12} /> Search &amp; Verify
                    </>
                  )}
                </button>
              </form>

              <div className="discover-chips-row">
                {EXAMPLE_DISCOVERY_PROMPTS.map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    className="discover-prompt-chip"
                    disabled={discoverBusy}
                    onClick={() => void handleDiscover(sample)}
                  >
                    {sample}
                  </button>
                ))}
              </div>

              <div className="discover-controls-bar">
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={autoVerify}
                    onChange={(e) => setAutoVerify(e.target.checked)}
                  />
                  Live-test top results (browse &amp; WAV header probe)
                </label>

                {authCapableProviders.length > 0 && (
                  <button
                    type="button"
                    className={`btn-small ${showApiKeysDrawer ? 'btn-active' : ''}`}
                    onClick={() => setShowApiKeysDrawer((v) => !v)}
                    title="Manage optional or required API keys for authenticated archive providers"
                  >
                    <KeyRound size={12} /> API Keys ({configuredKeyCount}/{authCapableProviders.length})
                  </button>
                )}
              </div>

              {providers.length > 0 && (
                <div className="discover-provider-filters">
                  <span className="discover-filter-label">Providers:</span>
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
              )}

              {showApiKeysDrawer && authCapableProviders.length > 0 && (
                <div className="discover-keys-drawer">
                  <div className="discover-keys-head">
                    <strong>Provider API Keys</strong>
                    <span>
                      Keys entered here are stored locally in your browser and sent only when
                      querying or connecting that provider. Server-configured keys work automatically.
                    </span>
                  </div>
                  <div className="discover-keys-list">
                    {authCapableProviders.map((p) => {
                      const localVal = providerKeys[p.providerId] ?? '';
                      const statusText = p.authConfiguredOnServer
                        ? 'Server key active'
                        : localVal.trim()
                          ? 'Saved locally'
                          : p.authRequired
                            ? 'Key required'
                            : 'Optional (higher quota)';
                      return (
                        <div key={p.providerId} className="discover-key-row">
                          <div className="discover-key-meta">
                            <div className="discover-key-title">
                              <span>{p.displayName}</span>
                              <span
                                className={`discover-key-status ${
                                  p.authConfiguredOnServer || localVal.trim() ? 'ready' : ''
                                }`}
                              >
                                {statusText}
                              </span>
                            </div>
                            {p.authHint && <div className="discover-key-hint">{p.authHint}</div>}
                          </div>
                          <div className="discover-key-controls">
                            <input
                              type="password"
                              value={localVal}
                              placeholder={
                                p.authConfiguredOnServer
                                  ? 'Override server key (optional)'
                                  : 'Paste API key or token'
                              }
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
                            {p.authDocsUrl && (
                              <a
                                className="btn-small about-ext-btn"
                                href={p.authDocsUrl}
                                target="_blank"
                                rel="noreferrer"
                                title={`Get API key for ${p.displayName}`}
                              >
                                <ExternalLink size={11} /> Docs
                              </a>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {discoverWarnings.length > 0 && (
                <div className="discover-warnings">
                  {discoverWarnings.map((w, idx) => (
                    <div key={idx} className="discover-warning-item">
                      <AlertTriangle size={12} /> <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {discoverTerms.length > 0 && (
                <div className="discover-terms-strip">
                  <span>Matched terms:</span>
                  {discoverTerms.map((t) => (
                    <span key={t} className="discover-term-tag">
                      {t}
                    </span>
                  ))}
                </div>
              )}

              <div className="discover-results-list">
                {discoverBusy && candidates.length === 0 && (
                  <div className="panel-empty">
                    Searching archive providers and testing live stream compatibility...
                  </div>
                )}

                {!discoverBusy && !hasSearched && (
                  <div className="discover-empty-guide">
                    <p>
                      Search across open acoustic repositories, cloud buckets, and authenticated
                      sound libraries using plain language. SyrinxOne probes candidate archives to
                      check whether audio files can be browsed and streamed directly—flagging
                      zip-only bundles or API-key-protected catalogs before you connect.
                    </p>
                  </div>
                )}

                {!discoverBusy && hasSearched && candidates.length === 0 && (
                  <div className="panel-empty">
                    No matching acoustic archives found. Try broader terms (e.g., &ldquo;birdsong&rdquo;,
                    &ldquo;bioacoustics&rdquo;, &ldquo;multi-channel&rdquo;, or &ldquo;rainforest&rdquo;).
                  </div>
                )}

                {candidates.map((cand) => {
                  const prov = providerMap[cand.providerId];
                  const isVerifying = verifyingCandidateId === cand.candidateId;
                  const isConnecting = connectingCandidateId === cand.candidateId;
                  const isInlineKeyOpen = inlineKeyCandidateId === cand.candidateId;
                  const hasSavedKey =
                    Boolean(prov?.authConfiguredOnServer) ||
                    Boolean(providerKeys[cand.providerId]?.trim()) ||
                    Boolean(cand.connectRequest.apiKey?.trim());
                  const canConnect =
                    cand.verification.status !== 'zipped_only' &&
                    cand.verification.status !== 'incompatible';

                  return (
                    <div key={cand.candidateId} className="discover-card">
                      <div className="discover-card-top">
                        <div className="discover-card-head">
                          <div className="discover-card-title">{cand.title}</div>
                          <div className="discover-card-meta">
                            <span>{cand.providerLabel}</span>
                            <span>· {cand.connectRequest.kind.toUpperCase()}</span>
                            {cand.license && <span>· {cand.license}</span>}
                          </div>
                        </div>
                        <VerificationBadge verification={cand.verification} />
                      </div>

                      {cand.description && (
                        <div className="discover-card-desc">{cand.description}</div>
                      )}

                      {(cand.verification.message || cand.verification.sampleFileName) && (
                        <div className="discover-card-probe">
                          {cand.verification.message}
                          {cand.verification.formats.length > 0 && (
                            <span> · Formats: {cand.verification.formats.join(', ')}</span>
                          )}
                          {cand.verification.sampleFileName && (
                            <span> · Sample: {cand.verification.sampleFileName}</span>
                          )}
                        </div>
                      )}

                      {cand.tags.length > 0 && (
                        <div className="discover-card-tags">
                          {cand.tags.slice(0, 6).map((tag) => (
                            <span key={tag} className="discover-tag">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}

                      {isInlineKeyOpen && (
                        <div className="discover-inline-key-box">
                          <div className="discover-inline-key-label">
                            <KeyRound size={12} />
                            <span>
                              Enter API key for <strong>{cand.providerLabel}</strong>
                              {(cand.authHint ?? prov?.authHint)
                                ? ` — ${cand.authHint ?? prov?.authHint}`
                                : ''}
                            </span>
                          </div>
                          <div className="discover-inline-key-row">
                            <input
                              type="password"
                              value={inlineKeyDraft}
                              placeholder="Paste API key"
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
                                className="btn-small about-ext-btn"
                                href={cand.authDocsUrl ?? prov?.authDocsUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <ExternalLink size={11} /> Get Key
                              </a>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="discover-card-actions">
                        <button
                          type="button"
                          className="btn-small"
                          disabled={isVerifying || isConnecting}
                          onClick={() => void handleVerifyCandidate(cand)}
                          title="Run live listing and WAV header compatibility check"
                        >
                          {isVerifying ? (
                            <>
                              <Loader2 size={11} className="spin" /> Testing...
                            </>
                          ) : (
                            <>
                              <FlaskConical size={11} /> Test
                            </>
                          )}
                        </button>

                        {cand.homepageUrl && (
                          <a
                            className="btn-small about-ext-btn"
                            href={cand.homepageUrl}
                            target="_blank"
                            rel="noreferrer"
                            title="Open archive homepage / metadata"
                          >
                            <ExternalLink size={11} /> Source Page
                          </a>
                        )}

                        <button
                          type="button"
                          className={`btn-small ${canConnect ? 'btn-primary' : ''}`}
                          disabled={isConnecting || !canConnect}
                          onClick={() => void handleConnectCandidate(cand)}
                          style={{ marginLeft: 'auto' }}
                        >
                          {isConnecting ? (
                            <>
                              <Loader2 size={11} className="spin" /> Connecting...
                            </>
                          ) : cand.authRequired && !hasSavedKey ? (
                            <>
                              <KeyRound size={11} /> Enter Key &amp; Connect
                            </>
                          ) : (
                            <>
                              <Plus size={11} /> Connect &amp; Browse
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <>
              <div className="source-section">
                <div className="connect-section-title">Available Sources</div>
                <div className="source-cards-list">
                  {/* Built-in & Engine Connected Sources */}
                  {loading && sources.length === 0 && (
                    <div className="panel-empty">Loading sources...</div>
                  )}

                  {sources.map((src) => {
                    const isActive = activeSourceId === src.sourceId;
                    const target = DataSourceToArchiveTarget(src);
                    const docInfo = archiveDocsMap[src.sourceId] ?? buildStaticArchiveAbout(target);
                    const readmeBadge = docInfo.readmeFiles[0]?.name;
                    return (
                      <div
                        key={src.sourceId}
                        className={`source-card ${isActive ? 'active' : ''}`}
                        onClick={() => chooseSource(src.sourceId, src.displayName)}
                      >
                        <span className="source-card-icon">
                          {src.kind === 'local_fs' ? (
                            <HardDrive size={15} color="#4ade80" />
                          ) : src.kind === 'http' ? (
                            <Link2 size={15} color="#38bdf8" />
                          ) : (
                            <Cloud size={15} color="#60a5fa" />
                          )}
                        </span>
                        <div className="source-card-meta">
                          <div className="source-card-title">{src.displayName}</div>
                          <div className="source-card-sub">
                            {src.kind === 'local_fs'
                              ? 'Device upload & engine folder'
                              : src.kind.toUpperCase()}
                            {src.anonymous ? ' · Public' : ''}
                            {src.rootPath ? ` · ${src.rootPath}` : ''}
                            {readmeBadge && (
                              <span
                                className="source-doc-badge"
                                title="Documentation file found in archive"
                              >
                                <FileText size={10} /> {readmeBadge}
                              </span>
                            )}
                          </div>
                          <div className="source-card-desc">{docInfo.briefDescription}</div>
                        </div>
                        <div
                          className="source-card-actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="btn-small source-about-btn"
                            title={`Read detailed info & documentation links for ${src.displayName}`}
                            onClick={(e) => handleOpenAbout(e, target)}
                          >
                            <BookOpen size={12} /> About
                          </button>
                          {isActive && (
                            <span className="source-active-mark">
                              <Check size={13} /> Active
                            </span>
                          )}
                          {src.removable && (
                            <button
                              className="mdi-icon-btn"
                              title="Remove source"
                              onClick={(e) => void handleRemoveSource(e, src)}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Google Drive OAuth Source */}
                  <div
                    className={`source-card ${activeSourceId === 'gdrive_oauth' ? 'active' : ''}`}
                    onClick={() => chooseSource('gdrive_oauth', 'Google Drive')}
                  >
                    <span className="source-card-icon">
                      <Globe size={15} color="#facc15" />
                    </span>
                    <div className="source-card-meta">
                      <div className="source-card-title">My Google Drive</div>
                      <div className="source-card-sub">
                        {hasDriveToken
                          ? `Signed in · ${googleUser?.email ?? googleUser?.displayName ?? 'Ready'}`
                          : 'Private & shared folders via Google account'}
                      </div>
                      <div className="source-card-desc">{gdriveAbout.briefDescription}</div>
                    </div>
                    <div
                      className="source-card-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="btn-small source-about-btn"
                        title="About Google Drive archive access"
                        onClick={(e) => handleOpenAbout(e, gdriveAboutTarget)}
                      >
                        <BookOpen size={12} /> About
                      </button>
                      {hasDriveToken ? (
                        <>
                          {activeSourceId === 'gdrive_oauth' && (
                            <span className="source-active-mark">
                              <Check size={13} /> Active
                            </span>
                          )}
                          <button
                            className="btn-small"
                            onClick={(e) => void handleDriveSignOut(e)}
                            title="Sign out of Google"
                          >
                            <LogOut size={12} />
                          </button>
                        </>
                      ) : (
                        <GoogleSignInButton
                          compact
                          disabled={driveBusyAuth}
                          label={driveBusyAuth ? 'Signing in...' : 'Sign in'}
                          onClick={() => void handleDriveSignIn()}
                        />
                      )}
                    </div>
                  </div>

                  {/* Direct URL Source fallback */}
                  {!hasHttpSource && (
                    <div
                      className={`source-card ${activeSourceId === 'http' ? 'active' : ''}`}
                      onClick={() => chooseSource('http', 'Direct Audio URL')}
                    >
                      <span className="source-card-icon">
                        <Link2 size={15} color="#38bdf8" />
                      </span>
                      <div className="source-card-meta">
                        <div className="source-card-title">Direct Audio URL</div>
                        <div className="source-card-sub">
                          Stream .wav / .flac / .ogg / .mp3 links
                        </div>
                        <div className="source-card-desc">
                          {buildStaticArchiveAbout({
                            sourceId: 'http',
                            displayName: 'Direct Audio URL',
                            kind: 'http',
                          }).briefDescription}
                        </div>
                      </div>
                      <div className="source-card-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="btn-small source-about-btn"
                          onClick={(e) =>
                            handleOpenAbout(e, {
                              sourceId: 'http',
                              displayName: 'Direct Audio URL',
                              kind: 'http',
                            })
                          }
                        >
                          <BookOpen size={12} /> About
                        </button>
                        {activeSourceId === 'http' && (
                          <span className="source-active-mark">
                            <Check size={13} /> Active
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="source-section">
                <div className="connect-section-title">
                  <span>Public Ocean &amp; Bioacoustic Archives</span>
                  <button
                    type="button"
                    className="btn-small"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => setActiveTab('discover')}
                  >
                    <Compass size={11} /> Find More Online...
                  </button>
                </div>
                <div className="preset-cards">
                  {ARCHIVE_PRESETS.map((p) => {
                    const pid = p.req.sourceId ?? p.label;
                    const alreadyConnected = sources.some((s) => s.sourceId === pid);
                    const isActive = activeSourceId === pid;
                    const presetTarget: ArchiveTargetInput = {
                      sourceId: pid,
                      displayName: p.label,
                      kind: p.req.kind,
                      rootPath: p.req.prefix,
                      connectReq: p.req,
                      anonymous: p.req.anonymous,
                    };
                    const presetDoc = archiveDocsMap[pid] ?? buildStaticArchiveAbout(presetTarget);
                    return (
                      <div key={p.label} className="preset-card">
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="preset-title">{p.label}</div>
                          <div className="preset-sub">{p.subtitle}</div>
                          <div className="source-card-desc">{presetDoc.briefDescription}</div>
                        </div>
                        <div className="source-card-actions">
                          <button
                            type="button"
                            className="btn-small source-about-btn"
                            title={`About ${p.label}`}
                            onClick={(e) => handleOpenAbout(e, presetTarget)}
                          >
                            <BookOpen size={12} /> About
                          </button>
                          <button
                            className={`btn-small ${isActive ? 'btn-active' : 'btn-primary'}`}
                            disabled={connectBusy}
                            onClick={() => void handleConnectPreset(p)}
                          >
                            {isActive ? 'Active' : alreadyConnected ? 'Use' : 'Connect'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="source-section">
                <button
                  type="button"
                  className="source-collapse-btn"
                  onClick={() => setShowCustomForm((v) => !v)}
                >
                  {showCustomForm ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Plus size={13} />
                  <span>Add Custom Cloud / S3 / GCS / Folder Source</span>
                </button>

                {showCustomForm && (
                  <div className="connect-source-panel" style={{ marginTop: 8 }}>
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
                          <option value="gdrive">Google Drive Shared Folder / File</option>
                          <option value="s3">Amazon S3 / AWS Open Data</option>
                          <option value="gcs">Google Cloud Storage (GCS)</option>
                          <option value="http">HTTP Audio URLs</option>
                        </select>
                      </div>

                      <div className="field-group">
                        <label>Display Name (optional)</label>
                        <input
                          type="text"
                          value={newDisplayName}
                          placeholder="e.g., Hydrophone Array 2024"
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
                              placeholder={
                                newKind === 's3'
                                  ? 'pacific-sound-16khz'
                                  : 'noaa-passive-bioacoustic'
                              }
                              onChange={(e) => setNewBucket(e.target.value)}
                            />
                          </div>
                          <div className="field-group">
                            <label>Prefix / Subfolder (optional)</label>
                            <input
                              type="text"
                              value={newPrefix}
                              placeholder="e.g., 2023/ or sanctsound/"
                              onChange={(e) => setNewPrefix(e.target.value)}
                            />
                          </div>
                        </>
                      )}

                      {newKind === 's3' && (
                        <div className="field-group">
                          <label>AWS Region (optional)</label>
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

                    {newKind === 'gdrive' && (
                      <>
                        <div className="field-group" style={{ marginTop: 8 }}>
                          <label>Google Drive Shared Folder / File URL or ID</label>
                          <input
                            type="text"
                            value={newFolderOrUrl}
                            placeholder="https://drive.google.com/drive/folders/..."
                            onChange={(e) => setNewFolderOrUrl(e.target.value)}
                          />
                        </div>
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
                            <label>
                              OAuth Token {hasDriveToken ? '(auto-filled)' : '(optional)'}
                            </label>
                            <input
                              type="password"
                              value={newOauthToken}
                              placeholder={hasDriveToken ? 'Signed-in session' : 'ya29....'}
                              onChange={(e) => setNewOauthToken(e.target.value)}
                            />
                          </div>
                        </div>
                      </>
                    )}

                    {newKind === 'http' && (
                      <div className="field-group" style={{ marginTop: 8 }}>
                        <label>Audio URLs (one per line or comma-separated)</label>
                        <textarea
                          rows={3}
                          value={newFolderOrUrl}
                          placeholder="https://example.org/recordings/whale_01.wav"
                          onChange={(e) => setNewFolderOrUrl(e.target.value)}
                        />
                      </div>
                    )}

                    {customVerification && (
                      <div className="custom-verify-banner">
                        <VerificationBadge verification={customVerification} />
                        <span>{customVerification.message}</span>
                      </div>
                    )}

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'flex-end',
                        gap: 8,
                        marginTop: 10,
                      }}
                    >
                      <button
                        type="button"
                        className="btn-small"
                        disabled={customVerifyBusy || connectBusy}
                        onClick={() => void handleTestCustom()}
                      >
                        {customVerifyBusy ? (
                          <>
                            <Loader2 size={11} className="spin" /> Testing...
                          </>
                        ) : (
                          <>
                            <FlaskConical size={11} /> Test Compatibility
                          </>
                        )}
                      </button>
                      <button
                        className="btn-small btn-primary"
                        disabled={connectBusy}
                        onClick={() => void handleConnectCustom()}
                      >
                        {connectBusy ? 'Connecting...' : 'Connect & Use Source'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
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
