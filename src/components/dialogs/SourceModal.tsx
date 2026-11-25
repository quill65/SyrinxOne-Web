import React, { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Database,
  FolderOpen,
  Globe,
  HardDrive,
  Link2,
  LogOut,
  Plus,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import type { CreateSourceRequest, DataSourceInfo } from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';
import {
  getAccessToken,
  googleSignIn,
  logout,
  toGoogleUserProfile,
} from '../../auth/googleAuth';
import { GoogleSignInButton } from '../auth/GoogleSignInButton';

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

export const SourceModal: React.FC = () => {
  const show = useWorkspaceStore((s) => s.showSourceModal);
  const sourceReturnToBrowser = useWorkspaceStore((s) => s.sourceReturnToBrowser);
  const engine = useWorkspaceStore((s) => s.engine);
  const activeSourceId = useWorkspaceStore((s) => s.activeSourceId);
  const setActiveSource = useWorkspaceStore((s) => s.setActiveSource);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const setStatus = useWorkspaceStore((s) => s.setStatus);
  const googleUser = useWorkspaceStore((s) => s.googleUser);
  const hasDriveToken = useWorkspaceStore((s) => s.hasDriveToken);
  const setGoogleAuthState = useWorkspaceStore((s) => s.setGoogleAuthState);

  const [sources, setSources] = useState<DataSourceInfo[]>([]);
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

  const loadSources = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await engine.listSources();
      setSources(list);
    } catch (err) {
      setSources([]);
      setError(err instanceof Error ? err.message : 'Failed to list connected sources');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!show) return;
    void loadSources();
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

  const handleConnectCustom = async () => {
    setConnectBusy(true);
    setError(null);
    try {
      const activeOauthToken =
        newKind === 'gdrive'
          ? newOauthToken.trim() || (await getAccessToken()) || undefined
          : undefined;
      const req: CreateSourceRequest = {
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
      const created = await engine.addSource(req);
      setNewDisplayName('');
      setNewFolderOrUrl('');
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

  return (
    <div className="modal-backdrop" onClick={() => setModalState('showSourceModal', false)}>
      <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Database size={15} color="#38bdf8" /> Select Sound Source
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

        <div className="modal-body">
          {error && <div className="inline-error">{error}</div>}

          <div className="source-section">
            <div className="connect-section-title">Available Sources</div>
            <div className="source-cards-list">
              {/* Built-in & Engine Connected Sources */}
              {loading && sources.length === 0 && (
                <div className="panel-empty">Loading sources...</div>
              )}

              {sources.map((src) => {
                const isActive = activeSourceId === src.sourceId;
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
                        {src.kind === 'local_fs' ? 'Device upload & engine folder' : src.kind.toUpperCase()}
                        {src.anonymous ? ' · Public' : ''}
                        {src.rootPath ? ` · ${src.rootPath}` : ''}
                      </div>
                    </div>
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
                </div>
                <div
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  onClick={(e) => e.stopPropagation()}
                >
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
                    <div className="source-card-sub">Stream .wav / .flac / .ogg / .mp3 links</div>
                  </div>
                  {activeSourceId === 'http' && (
                    <span className="source-active-mark">
                      <Check size={13} /> Active
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="source-section">
            <div className="connect-section-title">Public Ocean &amp; Bioacoustic Archives</div>
            <div className="preset-cards">
              {ARCHIVE_PRESETS.map((p) => {
                const alreadyConnected = sources.some((s) => s.sourceId === p.req.sourceId);
                const isActive = activeSourceId === p.req.sourceId;
                return (
                  <div key={p.label} className="preset-card">
                    <div style={{ minWidth: 0 }}>
                      <div className="preset-title">{p.label}</div>
                      <div className="preset-sub">{p.subtitle}</div>
                    </div>
                    <button
                      className={`btn-small ${isActive ? 'btn-active' : 'btn-primary'}`}
                      disabled={connectBusy}
                      onClick={() => void handleConnectPreset(p)}
                    >
                      {isActive ? 'Active' : alreadyConnected ? 'Use' : 'Connect'}
                    </button>
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
                      onChange={(e) => setNewKind(e.target.value as typeof newKind)}
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
                            newKind === 's3' ? 'pacific-sound-16khz' : 'noaa-passive-bioacoustic'
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
                        <label>OAuth Token {hasDriveToken ? '(auto-filled)' : '(optional)'}</label>
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

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
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
