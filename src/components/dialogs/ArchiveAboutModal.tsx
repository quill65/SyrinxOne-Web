import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Cloud,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe,
  HardDrive,
  Link2,
  X,
} from 'lucide-react';
import { useWorkspaceStore } from '../../store/workspaceStore';
import {
  buildStaticArchiveAbout,
  discoverArchiveDocumentation,
  fetchDocTextPreview,
  type ArchiveAboutSpec,
  type DiscoveredDocFile,
} from '../../utils/archiveDocs';

function formatBytes(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export const ArchiveAboutModal: React.FC = () => {
  const show = useWorkspaceStore((s) => s.showArchiveAboutModal);
  const target = useWorkspaceStore((s) => s.aboutArchiveTarget);
  const engine = useWorkspaceStore((s) => s.engine);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const setActiveSource = useWorkspaceStore((s) => s.setActiveSource);
  const setStatus = useWorkspaceStore((s) => s.setStatus);

  const [about, setAbout] = useState<ArchiveAboutSpec | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<DiscoveredDocFile | null>(null);
  const [docText, setDocText] = useState<string | null>(null);
  const [loadingDocText, setLoadingDocText] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!show || !target) return;
    let cancelled = false;
    setActionError(null);
    setSelectedDoc(null);
    setDocText(null);
    setAbout(buildStaticArchiveAbout(target));
    setLoadingDocs(true);

    void discoverArchiveDocumentation(engine, target, { readText: true })
      .then((spec) => {
        if (cancelled) return;
        setAbout(spec);
        const focusDoc =
          (target.focusDocUri
            ? spec.readmeFiles.find((d) => d.uri === target.focusDocUri)
            : undefined) ??
          spec.readmeFiles.find((d) => d.name === spec.primaryReadmeName) ??
          spec.readmeFiles[0] ??
          null;
        setSelectedDoc(focusDoc);
        if (spec.primaryReadmeText && focusDoc?.kind !== 'pdf') {
          setDocText(spec.primaryReadmeText);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDocs(false);
      });

    return () => {
      cancelled = true;
    };
  }, [show, target, engine]);

  if (!show || !target || !about) return null;

  const handleSelectDoc = async (doc: DiscoveredDocFile) => {
    if (!target) return;
    setSelectedDoc(doc);
    if (doc.kind === 'pdf') {
      setDocText(null);
      return;
    }
    setLoadingDocText(true);
    try {
      const txt = await fetchDocTextPreview(engine, target, doc);
      setDocText(txt);
    } finally {
      setLoadingDocText(false);
    }
  };

  const handleOpenInBrowser = async () => {
    setActionError(null);
    setBrowseBusy(true);
    try {
      let sourceId = target.sourceId;
      let label = target.displayName;
      if (target.connectReq) {
        const sources = await engine.listSources();
        const existing = sources.find((s) => s.sourceId === target.connectReq?.sourceId);
        if (!existing) {
          const created = await engine.addSource(target.connectReq);
          sourceId = created.sourceId;
          label = created.displayName;
        }
      }
      setActiveSource(sourceId, label);
      setStatus(`Active source: ${label}`);
      setModalState('showArchiveAboutModal', false);
      setModalState('showSourceModal', false);
      setModalState('showFileBrowser', true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to open archive source');
    } finally {
      setBrowseBusy(false);
    }
  };

  const kindIcon =
    target.kind === 'local_fs' ? (
      <HardDrive size={16} color="#4ade80" />
    ) : target.kind === 'http' ? (
      <Link2 size={16} color="#38bdf8" />
    ) : target.kind === 'gdrive' || target.sourceId === 'gdrive_oauth' ? (
      <Globe size={16} color="#facc15" />
    ) : (
      <Cloud size={16} color="#60a5fa" />
    );

  return (
    <div
      className="modal-backdrop about-archive-backdrop"
      onClick={() => setModalState('showArchiveAboutModal', false)}
    >
      <div className="modal-card modal-wide about-archive-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <BookOpen size={15} color="#38bdf8" />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              About Archive · {about.title}
            </span>
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <button
              className="btn-small"
              onClick={() => setModalState('showArchiveAboutModal', false)}
              title="Back"
            >
              <ArrowLeft size={12} /> Back
            </button>
            <button
              className="mdi-icon-btn"
              onClick={() => setModalState('showArchiveAboutModal', false)}
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="modal-body about-archive-body">
          {actionError && <div className="inline-error">{actionError}</div>}

          <div className="about-hero-box">
            <div className="about-hero-top">
              <span className="about-hero-icon">{kindIcon}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="about-hero-title">{about.title}</div>
                <div className="about-hero-meta mono">
                  <span>{about.kindLabel}</span>
                  {about.storageUri && <span> · {about.storageUri}</span>}
                  {target.currentPrefix && <span> · Folder: /{target.currentPrefix}</span>}
                </div>
              </div>
            </div>
            <div className="about-hero-brief">{about.briefDescription}</div>
          </div>

          {about.highlights.length > 0 && (
            <div className="about-highlights-grid">
              {about.highlights.map((h) => (
                <div key={h.label} className="about-highlight-cell">
                  <div className="about-highlight-label">{h.label}</div>
                  <div className="about-highlight-value">{h.value}</div>
                </div>
              ))}
            </div>
          )}

          <div className="about-section">
            <div className="connect-section-title">Detailed Overview</div>
            <div className="about-prose">
              {about.deepDescription.map((p, idx) => (
                <p key={idx}>{p}</p>
              ))}
            </div>
          </div>

          <div className="about-section">
            <div className="connect-section-title">
              Discovered README &amp; Archive Files
              {loadingDocs && <span className="about-loading-pill">Scanning…</span>}
            </div>

            {about.readmeFiles.length === 0 ? (
              <div className="about-empty-note">
                {loadingDocs
                  ? 'Checking archive directories for README or documentation files…'
                  : 'No standalone README/documentation files were listed in the scanned root folder of this source.'}
              </div>
            ) : (
              <div className="about-readme-files">
                {about.readmeFiles.map((doc) => {
                  const isSel = selectedDoc?.uri === doc.uri;
                  return (
                    <div key={doc.uri} className={`about-doc-row ${isSel ? 'active' : ''}`}>
                      <button
                        type="button"
                        className="about-doc-select"
                        onClick={() => void handleSelectDoc(doc)}
                      >
                        <FileText size={13} color={doc.kind === 'pdf' ? '#f59e0b' : '#38bdf8'} />
                        <span className="about-doc-name mono">{doc.name}</span>
                        {doc.locationLabel && (
                          <span className="about-doc-loc">({doc.locationLabel})</span>
                        )}
                        {doc.sizeBytes != null && (
                          <span className="about-doc-size mono">{formatBytes(doc.sizeBytes)}</span>
                        )}
                      </button>
                      {doc.externalUrl && (
                        <a
                          href={doc.externalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-small about-ext-btn"
                          title={`Open ${doc.name} in new tab`}
                        >
                          <ExternalLink size={11} /> Open
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {selectedDoc && selectedDoc.kind === 'pdf' && (
              <div className="about-pdf-callout">
                <div>
                  <strong>{selectedDoc.name}</strong> is a PDF document inside this archive.
                </div>
                {selectedDoc.externalUrl && (
                  <a
                    href={selectedDoc.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-small btn-primary"
                  >
                    <ExternalLink size={12} /> Open PDF Documentation
                  </a>
                )}
              </div>
            )}

            {loadingDocText && (
              <div className="about-empty-note">Loading {selectedDoc?.name} contents…</div>
            )}

            {!loadingDocText && docText && (
              <div className="about-readme-viewer">
                <div className="about-readme-viewer-head mono">
                  <span>{selectedDoc?.name ?? about.primaryReadmeName ?? 'README'}</span>
                </div>
                <pre className="about-readme-pre">{docText}</pre>
              </div>
            )}
          </div>

          <div className="about-section">
            <div className="connect-section-title">Documentation &amp; Reference Links</div>
            {about.documentationLinks.length === 0 ? (
              <div className="about-empty-note">
                No external documentation URLs registered for this custom/local source.
              </div>
            ) : (
              <div className="about-links-list">
                {about.documentationLinks.map((lnk) => (
                  <a
                    key={lnk.url}
                    href={lnk.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="about-link-card"
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="about-link-title">{lnk.label}</div>
                      {lnk.description && <div className="about-link-desc">{lnk.description}</div>}
                      <div className="about-link-url mono">{lnk.url}</div>
                    </div>
                    <ExternalLink size={13} color="#38bdf8" style={{ flexShrink: 0 }} />
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button
            className="btn-small"
            onClick={() => setModalState('showArchiveAboutModal', false)}
          >
            Close
          </button>
          <button
            className="btn-small btn-primary"
            disabled={browseBusy}
            onClick={() => void handleOpenInBrowser()}
          >
            <FolderOpen size={13} /> {browseBusy ? 'Opening…' : 'Select Recordings'}
          </button>
        </div>
      </div>
    </div>
  );
};
