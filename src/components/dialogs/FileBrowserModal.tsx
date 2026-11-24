import React, { useEffect, useMemo, useState } from 'react';
import {
  Cloud,
  FileAudio,
  FileText,
  Folder,
  Globe,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { BrowseEntry, CreateSourceRequest, DataSourceInfo } from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';

interface ArchivePreset {
  label: string;
  subtitle: string;
  req: CreateSourceRequest;
}

const ARCHIVE_PRESETS: ArchivePreset[] = [
  {
    label: 'MBARI Pacific Ocean Sound (256 kHz, 2022)',
    subtitle: 's3://pacific-sound-256khz-2022 · High-bandwidth odontocete & dolphin clicks (AWS Open Data)',
    req: {
      kind: 's3',
      sourceId: 'mbari_256khz_2022',
      displayName: 'MBARI Pacific Ocean Sound (256 kHz, 2022)',
      bucket: 'pacific-sound-256khz-2022',
      region: 'us-west-2',
      anonymous: true,
      readOnly: true,
    },
  },
  {
    label: 'MBARI Pacific Ocean Sound (256 kHz, 2023)',
    subtitle: 's3://pacific-sound-256khz-2023 · High-bandwidth hydrophone recordings (AWS Open Data)',
    req: {
      kind: 's3',
      sourceId: 'mbari_256khz_2023',
      displayName: 'MBARI Pacific Ocean Sound (256 kHz, 2023)',
      bucket: 'pacific-sound-256khz-2023',
      region: 'us-west-2',
      anonymous: true,
      readOnly: true,
    },
  },
  {
    label: 'NOAA NCEI SanctSound Audio (GCS)',
    subtitle: 'gs://noaa-passive-bioacoustic/sanctsound · US National Marine Sanctuaries archive',
    req: {
      kind: 'gcs',
      sourceId: 'noaa_sanctsound',
      displayName: 'NOAA NCEI SanctSound (GCS)',
      bucket: 'noaa-passive-bioacoustic',
      prefix: 'sanctsound',
      anonymous: true,
      readOnly: true,
    },
  },
];

function formatBytes(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export const FileBrowserModal: React.FC = () => {
  const show = useWorkspaceStore((s) => s.showFileBrowser);
  const engine = useWorkspaceStore((s) => s.engine);
  const openAudioFromSource = useWorkspaceStore((s) => s.openAudioFromSource);
  const openAudioUrl = useWorkspaceStore((s) => s.openAudioUrl);
  const importAnnotationsFromSource = useWorkspaceStore((s) => s.importAnnotationsFromSource);
  const openUploadedFile = useWorkspaceStore((s) => s.openUploadedFile);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const setStatus = useWorkspaceStore((s) => s.setStatus);

  const [tab, setTab] = useState<'browse' | 'connect'>('browse');
  const [sources, setSources] = useState<DataSourceInfo[]>([]);
  const [selectedSource, setSelectedSource] = useState<string>('local');
  const [prefix, setPrefix] = useState<string>('');
  const [filterText, setFilterText] = useState<string>('');
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  // Quick URL / Google Drive shared file opener
  const [directUrl, setDirectUrl] = useState('');
  const [windowStartSec, setWindowStartSec] = useState<number>(0);
  const [windowMaxSec, setWindowMaxSec] = useState<number>(60);
  const [useWindowing, setUseWindowing] = useState<boolean>(false);

  // Connect new source form state
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
  const [connectError, setConnectError] = useState<string | null>(null);

  const refresh = async (srcId: string, pfx: string) => {
    setLoading(true);
    setBrowseError(null);
    try {
      const list = await engine.browseSource(srcId, pfx, 300);
      setEntries(list);
    } catch (err) {
      setEntries([]);
      setBrowseError(err instanceof Error ? err.message : 'Failed to list source contents');
    } finally {
      setLoading(false);
    }
  };

  const loadSources = async (selectId?: string) => {
    try {
      const srcs = await engine.listSources();
      setSources(srcs);
      const chosen =
        srcs.find((s) => s.sourceId === selectId) ??
        srcs.find((s) => s.sourceId === selectedSource) ??
        srcs[0];
      if (chosen) {
        setSelectedSource(chosen.sourceId);
        const initPrefix = chosen.rootPath || '';
        setPrefix(initPrefix);
        await refresh(chosen.sourceId, initPrefix);
      }
    } catch (err) {
      setSources([]);
      setBrowseError(err instanceof Error ? err.message : 'Failed to load data sources');
    }
  };

  useEffect(() => {
    if (!show) return;
    void loadSources();
  }, [show, engine]);

  const activeSourceInfo = useMemo(
    () => sources.find((s) => s.sourceId === selectedSource),
    [sources, selectedSource],
  );

  const visibleEntries = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.name === '..' || e.name.toLowerCase().includes(q));
  }, [entries, filterText]);

  if (!show) return null;

  const openOptions = useWindowing
    ? { startSec: Math.max(0, windowStartSec), maxDurationSec: Math.max(5, windowMaxSec) }
    : undefined;

  const handleEntryClick = async (entry: BrowseEntry) => {
    if (entry.isDir) {
      setPrefix(entry.uri);
      setFilterText('');
      await refresh(selectedSource, entry.uri);
    } else if (entry.kind === 'audio') {
      await openAudioFromSource(selectedSource, entry.uri, openOptions);
    } else if (entry.kind === 'annotation') {
      await importAnnotationsFromSource(selectedSource, entry.uri);
    }
  };

  const handleOpenDirectUrl = async () => {
    const url = directUrl.trim();
    if (!url) return;
    await openAudioUrl(url, openOptions);
    setModalState('showFileBrowser', false);
  };

  const handleConnectPreset = async (preset: ArchivePreset) => {
    setConnectBusy(true);
    setConnectError(null);
    try {
      const created = await engine.addSource(preset.req);
      setStatus(`Connected source: ${created.displayName}`);
      setTab('browse');
      await loadSources(created.sourceId);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to connect archive');
    } finally {
      setConnectBusy(false);
    }
  };

  const handleConnectCustom = async () => {
    setConnectBusy(true);
    setConnectError(null);
    try {
      const req: CreateSourceRequest = {
        kind: newKind,
        displayName: newDisplayName.trim() || undefined,
        bucket: newKind === 's3' || newKind === 'gcs' ? newBucket.trim() : undefined,
        prefix: newKind === 's3' || newKind === 'gcs' ? newPrefix.trim() : undefined,
        region: newKind === 's3' ? newRegion.trim() || undefined : undefined,
        anonymous: newAnonymous,
        folderOrUrl: newKind === 'gdrive' || newKind === 'http' ? newFolderOrUrl.trim() : undefined,
        apiKey: newKind === 'gdrive' ? newApiKey.trim() || undefined : undefined,
        oauthToken: newKind === 'gdrive' ? newOauthToken.trim() || undefined : undefined,
        readOnly: true,
      };
      const created = await engine.addSource(req);
      setStatus(`Connected source: ${created.displayName}`);
      setNewDisplayName('');
      setNewFolderOrUrl('');
      setTab('browse');
      await loadSources(created.sourceId);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to connect source');
    } finally {
      setConnectBusy(false);
    }
  };

  const handleRemoveSource = async () => {
    if (!activeSourceInfo?.removable) return;
    try {
      await engine.removeSource(activeSourceInfo.sourceId);
      setStatus(`Removed source: ${activeSourceInfo.displayName}`);
      await loadSources('local');
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : 'Failed to remove source');
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => setModalState('showFileBrowser', false)}>
      <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Cloud size={15} /> Acoustic Data Sources &amp; Cloud Archives
          </span>
          <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <button
              className={`btn-small ${tab === 'browse' ? 'btn-active' : ''}`}
              onClick={() => setTab('browse')}
            >
              Browse Sources ({sources.length})
            </button>
            <button
              className={`btn-small ${tab === 'connect' ? 'btn-active' : ''}`}
              onClick={() => setTab('connect')}
            >
              <Plus size={12} /> Connect Source
            </button>
            <button className="mdi-icon-btn" onClick={() => setModalState('showFileBrowser', false)}>
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="modal-body">
          {tab === 'browse' ? (
            <>
              <div className="url-quick-bar">
                <Link2 size={13} color="#38bdf8" />
                <input
                  type="text"
                  value={directUrl}
                  placeholder="Paste direct audio URL (.wav/.flac/.ogg/.mp3) or shared Google Drive file link..."
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

              <div className="browser-bar">
                <select
                  value={selectedSource}
                  onChange={(e) => {
                    const next = e.target.value;
                    const meta = sources.find((s) => s.sourceId === next);
                    const nextPfx = meta?.rootPath || '';
                    setSelectedSource(next);
                    setPrefix(nextPfx);
                    setFilterText('');
                    void refresh(next, nextPfx);
                  }}
                >
                  {sources.map((s) => (
                    <option key={s.sourceId} value={s.sourceId}>
                      {s.displayName} ({s.kind}
                      {s.anonymous ? ' · public' : ''})
                    </option>
                  ))}
                </select>

                <input
                  type="text"
                  value={prefix}
                  placeholder="Folder path or cloud prefix..."
                  onChange={(e) => setPrefix(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void refresh(selectedSource, prefix);
                  }}
                />

                <button className="btn-small" onClick={() => void refresh(selectedSource, prefix)}>
                  <RefreshCw size={12} /> Go
                </button>

                {activeSourceInfo?.removable && (
                  <button
                    className="btn-small"
                    title="Disconnect this source"
                    onClick={() => void handleRemoveSource()}
                  >
                    <Trash2 size={12} />
                  </button>
                )}

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
              </div>

              <div className="browser-subbar">
                <div className="browser-filter">
                  <Search size={12} />
                  <input
                    type="text"
                    value={filterText}
                    placeholder="Filter listed files..."
                    onChange={(e) => setFilterText(e.target.value)}
                  />
                </div>

                <label className="inline-check" title="Load a bounded time window from huge WAV archive recordings via HTTP Range">
                  <input
                    type="checkbox"
                    checked={useWindowing}
                    onChange={(e) => setUseWindowing(e.target.checked)}
                  />
                  Window slice:
                </label>
                {useWindowing && (
                  <div className="window-inputs">
                    <span>Start</span>
                    <input
                      type="number"
                      min={0}
                      step={10}
                      value={windowStartSec}
                      onChange={(e) => setWindowStartSec(Number(e.target.value))}
                    />
                    <span>s · Len</span>
                    <input
                      type="number"
                      min={5}
                      max={600}
                      step={10}
                      value={windowMaxSec}
                      onChange={(e) => setWindowMaxSec(Number(e.target.value))}
                    />
                    <span>s</span>
                  </div>
                )}
              </div>

              {activeSourceInfo?.description && (
                <div className="source-desc-hint">
                  <Globe size={12} /> {activeSourceInfo.description}
                  {activeSourceInfo.kind !== 'local_fs' &&
                    ' · Remote WAVs >24 MB auto-load a fast 60s preview window via HTTP Range.'}
                </div>
              )}

              {browseError && <div className="inline-error">{browseError}</div>}

              <div className="browser-list">
                {loading && <div className="panel-empty">Loading archive entries...</div>}
                {!loading &&
                  visibleEntries.map((entry) => (
                    <button
                      key={entry.uri}
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
                      <span className="browser-name">{entry.name}</span>
                      <span className="browser-size mono">{formatBytes(entry.sizeBytes)}</span>
                    </button>
                  ))}
                {!loading && visibleEntries.length === 0 && !browseError && (
                  <div className="panel-empty">No matching files found in this location.</div>
                )}
              </div>
            </>
          ) : (
            <div className="connect-source-panel">
              <div className="connect-section-title">1-Click Public Bioacoustic Archives</div>
              <div className="preset-cards">
                {ARCHIVE_PRESETS.map((p) => (
                  <div key={p.label} className="preset-card">
                    <div>
                      <div className="preset-title">{p.label}</div>
                      <div className="preset-sub">{p.subtitle}</div>
                    </div>
                    <button
                      className="btn-small btn-primary"
                      disabled={connectBusy}
                      onClick={() => void handleConnectPreset(p)}
                    >
                      Connect
                    </button>
                  </div>
                ))}
              </div>

              <hr className="panel-divider" />
              <div className="connect-section-title">Connect Custom Cloud / Google Drive Source</div>

              <div className="detect-grid">
                <div className="field-group">
                  <label>Source Type</label>
                  <select
                    value={newKind}
                    onChange={(e) => setNewKind(e.target.value as typeof newKind)}
                  >
                    <option value="gdrive">Google Drive (Shared Folder or File)</option>
                    <option value="s3">Amazon S3 / AWS Open Data</option>
                    <option value="gcs">Google Cloud Storage (GCS)</option>
                    <option value="http">HTTP / Presigned Audio URLs</option>
                  </select>
                </div>

                <div className="field-group">
                  <label>Display Name (optional)</label>
                  <input
                    type="text"
                    value={newDisplayName}
                    placeholder="e.g., My Field Recordings"
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
                      Anonymous public read (no credentials needed)
                    </label>
                  </div>
                )}
              </div>

              {newKind === 'gdrive' && (
                <>
                  <div className="field-group">
                    <label>Google Drive Shared Folder/File URL or ID</label>
                    <input
                      type="text"
                      value={newFolderOrUrl}
                      placeholder="https://drive.google.com/drive/folders/... or https://drive.google.com/file/d/..."
                      onChange={(e) => setNewFolderOrUrl(e.target.value)}
                    />
                  </div>
                  <div className="detect-grid">
                    <div className="field-group">
                      <label>Google Drive API Key (optional, for large public folders)</label>
                      <input
                        type="password"
                        value={newApiKey}
                        placeholder="Leave blank for public link browsing"
                        onChange={(e) => setNewApiKey(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label>OAuth Bearer Token (optional, for private Drive folders)</label>
                      <input
                        type="password"
                        value={newOauthToken}
                        placeholder="ya29...."
                        onChange={(e) => setNewOauthToken(e.target.value)}
                      />
                    </div>
                  </div>
                </>
              )}

              {newKind === 'http' && (
                <div className="field-group">
                  <label>Audio URLs (one per line or comma-separated)</label>
                  <textarea
                    rows={3}
                    value={newFolderOrUrl}
                    placeholder="https://example.org/recordings/whale_01.wav"
                    onChange={(e) => setNewFolderOrUrl(e.target.value)}
                  />
                </div>
              )}

              {connectError && <div className="inline-error">{connectError}</div>}

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                <button
                  className="btn-small btn-primary"
                  disabled={connectBusy}
                  onClick={() => void handleConnectCustom()}
                >
                  {connectBusy ? 'Connecting...' : 'Connect & Browse'}
                </button>
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
