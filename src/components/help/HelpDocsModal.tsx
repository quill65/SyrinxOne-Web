import React, { useEffect, useState } from 'react';
import {
  Activity,
  BookOpen,
  ExternalLink,
  HelpCircle,
  Layers,
  Wrench,
  X,
} from 'lucide-react';
import {
  getHelpDocument,
  HELP_DOCUMENTS,
  type HelpDocId,
} from '../../help/helpDocs';
import { SimpleMarkdown } from '../../notebook/SimpleMarkdown';

function parseInternalHelpHref(href: string): HelpDocId | null {
  const m = href.match(/help=(overview|subsystems|setup)/i);
  if (!m) return null;
  return m[1].toLowerCase() as HelpDocId;
}

function docNavIcon(id: HelpDocId): React.ReactNode {
  if (id === 'overview') return <BookOpen size={14} />;
  if (id === 'subsystems') return <Layers size={14} />;
  return <Wrench size={14} />;
}

interface HelpReaderBodyProps {
  activeDocId: HelpDocId;
  onSelectDoc: (id: HelpDocId) => void;
}

const HelpReaderBody: React.FC<HelpReaderBodyProps> = ({
  activeDocId,
  onSelectDoc,
}) => {
  const doc = getHelpDocument(activeDocId);

  return (
    <div className="help-reader-layout">
      <nav className="help-nav" aria-label="Documentation Sections">
        {HELP_DOCUMENTS.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`help-nav-item ${d.id === activeDocId ? 'active' : ''}`}
            onClick={() => onSelectDoc(d.id)}
          >
            {docNavIcon(d.id)}
            <div className="help-nav-item-text">
              <span className="help-nav-item-title">{d.shortTitle}</span>
              <span className="help-nav-item-sub">{d.subtitle}</span>
            </div>
          </button>
        ))}
      </nav>

      <article className="help-article-scroll">
        <div className="help-article-inner">
          <SimpleMarkdown
            text={doc.markdown}
            onInternalLinkClick={(href) => {
              const target = parseInternalHelpHref(href);
              if (target) onSelectDoc(target);
            }}
          />
        </div>
      </article>
    </div>
  );
};

interface HelpDocsModalProps {
  docId: HelpDocId | null;
  onSelectDoc: (docId: HelpDocId) => void;
  onClose: () => void;
}

export const HelpDocsModal: React.FC<HelpDocsModalProps> = ({
  docId,
  onSelectDoc,
  onClose,
}) => {
  useEffect(() => {
    if (!docId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [docId, onClose]);

  if (!docId) return null;
  const activeDoc = getHelpDocument(docId);

  return (
    <div className="modal-backdrop help-modal-backdrop" onClick={onClose}>
      <div
        className="modal-card modal-wide help-modal-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <HelpCircle size={15} color="#38bdf8" />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              SyrinxOne Help · {activeDoc.title}
            </span>
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <a
              href={`?help=${activeDoc.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-small"
              title="Open this guide in a separate browser tab"
              style={{ textDecoration: 'none' }}
            >
              <ExternalLink size={12} /> Open Tab
            </a>
            <button className="mdi-icon-btn" onClick={onClose} title="Close">
              <X size={14} />
            </button>
          </div>
        </div>

        <HelpReaderBody activeDocId={docId} onSelectDoc={onSelectDoc} />

        <div className="modal-footer">
          <button type="button" className="btn-small btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

interface StandaloneHelpShellProps {
  initialDocId: HelpDocId;
}

export const StandaloneHelpShell: React.FC<StandaloneHelpShellProps> = ({
  initialDocId,
}) => {
  const [activeDocId, setActiveDocId] = useState<HelpDocId>(initialDocId);

  const handleSelectDoc = (id: HelpDocId) => {
    setActiveDocId(id);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('help', id);
      window.history.replaceState(null, '', url.toString());
    }
  };

  return (
    <div className="app-shell nb-detached-shell">
      <header className="top-toolbar nb-detached-header">
        <a href="/" className="brand brand-btn" title="Open SyrinxOne App">
          <span className="brand-mark">S1</span>
          <span className="brand-name">SyrinxOne Documentation</span>
        </a>
        <div className="toolbar-spacer" />
        <div className="toolbar-group">
          <a href="/" className="btn-small btn-primary">
            <Activity size={13} />
            <span>Open SyrinxOne App</span>
          </a>
        </div>
      </header>
      <div className="help-standalone-body">
        <HelpReaderBody activeDocId={activeDocId} onSelectDoc={handleSelectDoc} />
      </div>
    </div>
  );
};
