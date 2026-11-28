import React, { useState } from 'react';
import { BookOpen, CheckCircle2, Code2, Loader2, Sparkles, Tag, X } from 'lucide-react';
import { SimpleMarkdown } from './SimpleMarkdown';
import { commitProposedAnnotationsToWorkspace } from './notebookRunner';
import { useNotebookStore } from './notebookStore';

interface ScriptOutputModalProps {
  onOpenInNotebook: (notebookId: string) => void;
}

export const ScriptOutputModal: React.FC<ScriptOutputModalProps> = ({ onOpenInNotebook }) => {
  const run = useNotebookStore((s) => s.activeScriptRun);
  const isOpen = useNotebookStore((s) => s.isScriptModalOpen);
  const setModalOpen = useNotebookStore((s) => s.setScriptModalOpen);
  const toggleProposed = useNotebookStore((s) => s.toggleScriptProposedAnnotation);
  const markApplied = useNotebookStore((s) => s.markScriptAnnotationsApplied);
  const setActiveNotebook = useNotebookStore((s) => s.setActiveNotebook);

  const [showCode, setShowCode] = useState(false);

  if (!isOpen || !run) return null;

  const acceptedCount = run.proposedAnnotations.filter((a) => a.accepted).length;

  return (
    <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
      <div className="modal-panel nb-script-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="nb-script-title-wrap">
            <strong>{run.notebookTitle}</strong>
            {run.contextSummary && (
              <span className="nb-script-subtitle">
                {run.contextSummary.fileName} · {run.contextSummary.scopeLabel}
              </span>
            )}
          </div>
          <div className="nb-script-header-actions">
            <button
              type="button"
              className={`btn-small ${showCode ? 'btn-active' : ''}`}
              onClick={() => setShowCode((v) => !v)}
              title="Toggle Python & prompt step source"
            >
              <Code2 size={13} /> {showCode ? 'Hide Code' : 'Show Code'}
            </button>
            <button
              type="button"
              className="btn-small"
              onClick={() => {
                setActiveNotebook(run.notebookId);
                setModalOpen(false);
                onOpenInNotebook(run.notebookId);
              }}
            >
              <BookOpen size={13} /> Open in Notebook
            </button>
            <button
              type="button"
              className="btn-small"
              onClick={() => setModalOpen(false)}
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="modal-body nb-script-body">
          {run.status === 'running' && (
            <div className="nb-script-progress">
              <Loader2 size={15} className="nb-spin" />
              <span>
                Running step {run.currentStepIndex} of {run.totalSteps}...
              </span>
            </div>
          )}

          {run.error && (
            <div className="nb-cell-error">
              <strong>Execution stopped:</strong> {run.error}
            </div>
          )}

          {run.cellResults.map((step) => (
            <div key={step.cellId} className="nb-script-step">
              <div className="nb-script-step-head">
                <span className={`nb-kind-badge nb-kind-${step.cellKind}`}>
                  {step.cellKind === 'ai' ? (
                    <>
                      <Sparkles size={11} /> Gemini
                    </>
                  ) : step.cellKind === 'python' ? (
                    'Python'
                  ) : (
                    'Notes'
                  )}
                </span>
                <strong>{step.cellTitle}</strong>
                {step.output.durationMs !== undefined && (
                  <span className="nb-step-time">{step.output.durationMs} ms</span>
                )}
              </div>

              {showCode && step.cellKind !== 'markdown' && (
                <pre className="nb-script-source">
                  <code>{step.source}</code>
                </pre>
              )}

              {step.output.error && <div className="nb-cell-error">{step.output.error}</div>}

              {step.output.markdown && <SimpleMarkdown text={step.output.markdown} />}

              {step.output.figures && step.output.figures.length > 0 && (
                <div className="nb-figures-grid">
                  {step.output.figures.map((fig, idx) => (
                    <figure key={idx} className="nb-figure-card">
                      <img
                        src={`data:image/png;base64,${fig.base64Png}`}
                        alt={fig.label}
                      />
                      <figcaption>{fig.label}</figcaption>
                    </figure>
                  ))}
                </div>
              )}

              {step.output.stdout && (
                <pre className="nb-cell-stdout">{step.output.stdout}</pre>
              )}
            </div>
          ))}

          {run.proposedAnnotations.length > 0 && (
            <div className="nb-proposals-box">
              <div className="nb-proposals-head">
                <div>
                  <Tag size={13} />{' '}
                  <strong>
                    Proposed Log Annotations ({acceptedCount}/{run.proposedAnnotations.length} selected)
                  </strong>
                </div>
                <button
                  type="button"
                  className="btn-small btn-primary"
                  disabled={acceptedCount === 0}
                  onClick={() => {
                    const n = commitProposedAnnotationsToWorkspace(run.proposedAnnotations);
                    markApplied(n);
                  }}
                >
                  <CheckCircle2 size={13} />{' '}
                  {run.appliedCount
                    ? `Applied ${run.appliedCount} to Log`
                    : `Apply ${acceptedCount} to Log`}
                </button>
              </div>
              <div className="nb-proposals-list">
                {run.proposedAnnotations.map((ann) => (
                  <label key={ann.id} className="nb-proposal-row">
                    <input
                      type="checkbox"
                      checked={ann.accepted}
                      onChange={() => toggleProposed(ann.id)}
                    />
                    <span className="mono">
                      Ch {ann.channel} · {ann.startTimeSec.toFixed(2)}–{ann.endTimeSec.toFixed(2)}s ·{' '}
                      {Math.round(ann.lowFreqHz)}–{Math.round(ann.highFreqHz)} Hz
                    </span>
                    <strong>{ann.comment || '(blank)'}</strong>
                    {ann.notes && <span className="nb-proposal-notes">{ann.notes}</span>}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
