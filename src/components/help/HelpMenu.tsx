import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  Cpu,
  ExternalLink,
  HelpCircle,
  Layers,
  Wrench,
} from 'lucide-react';
import { HELP_DOCUMENTS, type HelpDocId } from '../../help/helpDocs';

interface HelpMenuProps {
  onOpenDoc: (docId: HelpDocId) => void;
  compact?: boolean;
}

function docIcon(id: HelpDocId): React.ReactNode {
  if (id === 'overview') return <BookOpen size={13} className="nb-tools-play-icon" />;
  if (id === 'subsystems') return <Layers size={13} className="nb-tools-play-icon" />;
  return <Wrench size={13} className="nb-tools-play-icon" />;
}

export const HelpMenu: React.FC<HelpMenuProps> = ({ onOpenDoc, compact }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handleOutside);
    return () => window.removeEventListener('mousedown', handleOutside);
  }, [open]);

  return (
    <div className="nb-tools-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`btn-small ${open ? 'btn-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Documentation, Subsystems & Setup Guides"
      >
        <HelpCircle size={13} />
        {!compact && <span>Help</span>}
        <ChevronDown size={11} />
      </button>

      {open && (
        <div className="nb-tools-dropdown help-menu-dropdown">
          <div className="nb-tools-header">SyrinxOne Documentation</div>

          {HELP_DOCUMENTS.map((doc) => (
            <div key={doc.id} className="help-menu-row">
              <button
                type="button"
                className="nb-tools-item help-menu-open-btn"
                onClick={() => {
                  setOpen(false);
                  onOpenDoc(doc.id);
                }}
                title={doc.subtitle}
              >
                {docIcon(doc.id)}
                <div className="nb-tools-item-text">
                  <span className="nb-tools-item-title">{doc.title}</span>
                  <span className="nb-tools-item-meta help-menu-subtitle">{doc.subtitle}</span>
                </div>
              </button>
              <a
                href={`?help=${doc.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="help-menu-tab-link"
                title={`Open "${doc.title}" in a separate tab`}
                onClick={() => setOpen(false)}
              >
                <ExternalLink size={12} />
              </a>
            </div>
          ))}

          <hr />

          <button
            type="button"
            className="nb-tools-action"
            onClick={() => {
              setOpen(false);
              onOpenDoc('setup');
            }}
          >
            <Cpu size={13} /> Gemini, Engine &amp; Drive Setup
          </button>
        </div>
      )}
    </div>
  );
};
