import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  FileAudio,
  Layers,
  Loader2,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import {
  analyzeRecordingStructure,
  buildDefinedRecordings,
  type CombineStructureMode,
  type RecordingStructureDefinition,
  type ScannedAudioFile,
} from '../../utils/recordingStructure';

function formatBytesCompact(bytes: number): string {
  if (bytes <= 0) return '';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export interface DefineRecordingsPanelProps {
  sourceLabel: string;
  scannedFiles: ScannedAudioFile[];
  scanState: {
    scanning: boolean;
    filesFound: number;
    foldersScanned: number;
    truncated: boolean;
    error: string | null;
  };
  includeSubfolders: boolean;
  onToggleSubfolders: (next: boolean) => void;
  docText: string;
  initialDefinition: RecordingStructureDefinition | null;
  rootPrefix: string;
  onSave: (definition: RecordingStructureDefinition) => void;
  onReset: () => void;
  onCancel: () => void;
}

export const DefineRecordingsPanel: React.FC<DefineRecordingsPanelProps> = ({
  sourceLabel,
  scannedFiles,
  scanState,
  includeSubfolders,
  onToggleSubfolders,
  docText,
  initialDefinition,
  rootPrefix,
  onSave,
  onReset,
  onCancel,
}) => {
  const analysis = useMemo(
    () =>
      analyzeRecordingStructure(scannedFiles, {
        docText,
        sourceLabel,
        rootPrefix,
        includeSubfolders,
      }),
    [scannedFiles, docText, sourceLabel, rootPrefix, includeSubfolders],
  );

  const [draft, setDraft] = useState<RecordingStructureDefinition | null>(initialDefinition);
  const [userTouched, setUserTouched] = useState(Boolean(initialDefinition));
  const [showCustomRule, setShowCustomRule] = useState(false);

  const recommendedDefinition = useMemo(
    () =>
      analysis.suggestions.find((s) => s.recommended)?.definition ??
      analysis.suggestions[0]?.definition ??
      null,
    [analysis.suggestions],
  );

  const activeDraft = userTouched && draft ? draft : recommendedDefinition;

  const effectiveDraft: RecordingStructureDefinition | null = useMemo(() => {
    if (!activeDraft) return null;
    return {
      ...activeDraft,
      rootPrefix,
      includeSubfolders,
    };
  }, [activeDraft, rootPrefix, includeSubfolders]);

  const previewRecordings = useMemo(
    () => (effectiveDraft ? buildDefinedRecordings(scannedFiles, effectiveDraft) : []),
    [scannedFiles, effectiveDraft],
  );

  const selectableFields = useMemo(
    () =>
      analysis.fields.filter((f) => {
        if (f.role === 'constant' || f.role === 'channel') return false;
        if (
          !analysis.allowTimeSlices &&
          f.source === 'derived_date' &&
          !(effectiveDraft?.groupByFieldIds.includes(f.id) ?? false)
        ) {
          return false;
        }
        return true;
      }),
    [analysis.fields, analysis.allowTimeSlices, effectiveDraft?.groupByFieldIds],
  );

  const channelFields = useMemo(
    () => analysis.fields.filter((f) => f.role === 'channel'),
    [analysis.fields],
  );

  const selectSuggestion = (def: RecordingStructureDefinition) => {
    setUserTouched(true);
    setDraft({ ...def, rootPrefix, includeSubfolders });
  };

  const toggleGroupField = (fieldId: string) => {
    if (!effectiveDraft) return;
    setUserTouched(true);
    const exists = effectiveDraft.groupByFieldIds.includes(fieldId);
    const nextIds = exists
      ? effectiveDraft.groupByFieldIds.filter((id) => id !== fieldId)
      : [...effectiveDraft.groupByFieldIds, fieldId];
    const nextMode: CombineStructureMode =
      effectiveDraft.combineMode === 'individual'
        ? analysis.detectedChannelFieldId
          ? 'channels_and_time'
          : 'time'
        : effectiveDraft.combineMode;
    setDraft({
      ...effectiveDraft,
      id: 'custom',
      granularity: 'custom',
      combineMode: nextMode,
      groupByFieldIds: nextIds,
      label: buildCustomLabel(nextIds, nextMode, analysis.fields),
      updatedAt: Date.now(),
    });
  };

  const updateCombineMode = (mode: CombineStructureMode) => {
    if (!effectiveDraft) return;
    setUserTouched(true);
    const nextChannelId =
      mode === 'channels' || mode === 'channels_and_time'
        ? effectiveDraft.channelFieldId ?? analysis.detectedChannelFieldId ?? channelFields[0]?.id ?? null
        : null;
    setDraft({
      ...effectiveDraft,
      id: mode === 'individual' ? 'individual' : 'custom',
      granularity: mode === 'individual' ? 'individual' : 'custom',
      combineMode: mode,
      channelFieldId: nextChannelId,
      label: buildCustomLabel(effectiveDraft.groupByFieldIds, mode, analysis.fields),
      updatedAt: Date.now(),
    });
  };

  const updateChannelField = (channelFieldId: string) => {
    if (!effectiveDraft) return;
    setUserTouched(true);
    const nextId = channelFieldId || null;
    setDraft({
      ...effectiveDraft,
      id: 'custom',
      granularity: 'custom',
      channelFieldId: nextId,
      updatedAt: Date.now(),
    });
  };

  const updateSortBy = (sortBy: 'timestamp' | 'name') => {
    if (!effectiveDraft) return;
    setUserTouched(true);
    setDraft({ ...effectiveDraft, sortBy, updatedAt: Date.now() });
  };

  return (
    <div className="structure-panel">
      <div className="structure-head">
        <div>
          <div className="structure-title">
            <Sparkles size={14} color="#38bdf8" />
            <span>Define Recording Structure — {sourceLabel}</span>
          </div>
          <div className="structure-sub">
            {scanState.scanning ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Loader2 size={12} className="spin" />
                Scanning folders &amp; documentation... ({scanState.filesFound} audio files across{' '}
                {scanState.foldersScanned} folder{scanState.foldersScanned === 1 ? '' : 's'})
              </span>
            ) : (
              <span>
                Analyzed <strong>{scannedFiles.length}</strong> audio file
                {scannedFiles.length === 1 ? '' : 's'} across {scanState.foldersScanned} folder
                {scanState.foldersScanned === 1 ? '' : 's'}
                {scanState.truncated ? ' (sample cap reached — filter or open a subfolder for full scope)' : ''}
              </span>
            )}
          </div>
        </div>

        <label className="inline-check" style={{ fontSize: 11.5 }}>
          <input
            type="checkbox"
            checked={includeSubfolders}
            disabled={scanState.scanning}
            onChange={(e) => onToggleSubfolders(e.target.checked)}
          />
          Include subfolders
        </label>
      </div>

      {scanState.error && <div className="inline-error">{scanState.error}</div>}

      {/* Section 1: Parsed Structure & Documentation Insights */}
      {!scanState.scanning && scannedFiles.length > 0 && (
        <div className="structure-insights-box">
          <div className="structure-section-label">Parsed File &amp; Folder Structure</div>
          <div className="structure-field-chips">
            {analysis.fields
              .filter((f) => f.role !== 'constant')
              .map((f) => {
                const notes = f.valueNotes
                  ? Object.entries(f.valueNotes)
                      .slice(0, 3)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(', ')
                  : '';
                return (
                  <span
                    key={f.id}
                    className={`structure-field-chip role-${f.role}`}
                    title={
                      notes
                        ? `Values: ${f.sampleValues.join(', ')} (${notes})`
                        : `Sample values: ${f.sampleValues.join(', ')}`
                    }
                  >
                    <strong>{f.label}</strong>
                    <span className="structure-field-count">{f.uniqueCount}</span>
                  </span>
                );
              })}
            {analysis.fields.filter((f) => f.role !== 'constant').length === 0 && (
              <span className="structure-muted">No repeating multi-file tokens detected.</span>
            )}
          </div>

          {analysis.docInsights.length > 0 && (
            <div className="structure-doc-notes">
              <BookOpen size={12} color="#7dd3fc" />
              <span>{analysis.docInsights.join(' · ')}</span>
            </div>
          )}
          {analysis.timeSliceNote && (
            <div className="structure-doc-notes" style={{ opacity: 0.85 }}>
              <SlidersHorizontal size={11} color="#94a3b8" />
              <span>{analysis.timeSliceNote}</span>
            </div>
          )}
        </div>
      )}

      {/* Section 2: Suggested Granularities */}
      {!scanState.scanning && analysis.suggestions.length > 0 && (
        <div className="structure-section">
          <div className="structure-section-label">
            Suggested Combining Rules (Choose Granularity)
          </div>
          <div className="structure-suggestions-grid">
            {analysis.suggestions.map((sugg) => {
              const isSelected = effectiveDraft?.id === sugg.definition.id;
              return (
                <button
                  key={sugg.id}
                  type="button"
                  className={`structure-sugg-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => selectSuggestion(sugg.definition)}
                >
                  <div className="structure-sugg-top">
                    <span className="structure-sugg-title">{sugg.title}</span>
                    <div className="structure-sugg-badges">
                      {sugg.recommended && <span className="structure-rec-pill">Recommended</span>}
                      <span className="structure-count-pill">
                        {sugg.recordingCount} rec{sugg.recordingCount === 1 ? '' : 's'}
                      </span>
                    </div>
                  </div>
                  <div className="structure-sugg-desc">{sugg.description}</div>
                  {sugg.rationale && <div className="structure-sugg-rationale">{sugg.rationale}</div>}
                  {sugg.sampleRecordings.length > 0 && (
                    <div className="structure-sugg-samples">
                      {sugg.sampleRecordings.map((sr, i) => (
                        <span key={i} className="structure-sample-chip">
                          {sr.title}
                          {sr.channelCount > 1 ? ` · ${sr.channelCount} ch` : ''}
                          {sr.fileCount > 1 ? ` · ${sr.fileCount} files` : ''}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Section 3: Custom Rule Builder */}
      {!scanState.scanning && effectiveDraft && scannedFiles.length > 0 && (
        <div className="structure-section">
          <button
            type="button"
            className="source-collapse-btn"
            onClick={() => setShowCustomRule((v) => !v)}
          >
            {showCustomRule ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <SlidersHorizontal size={12} />
            <span>Customize Grouping Fields &amp; Combine Mode</span>
          </button>

          {showCustomRule && (
            <div className="structure-custom-box">
              <div className="detect-grid">
                <div className="field-group">
                  <label>Combine Mode</label>
                  <select
                    value={effectiveDraft.combineMode}
                    onChange={(e) => updateCombineMode(e.target.value as CombineStructureMode)}
                  >
                    <option value="channels">Stack parallel channels (CH1..CHn)</option>
                    <option value="channels_and_time">
                      Stack parallel channels + concatenate in time
                    </option>
                    <option value="time">Concatenate files sequentially in time</option>
                    <option value="individual">Individual files (no combining)</option>
                  </select>
                </div>

                {(effectiveDraft.combineMode === 'channels' ||
                  effectiveDraft.combineMode === 'channels_and_time') && (
                  <div className="field-group">
                    <label>Channel Identifier Field</label>
                    <select
                      value={effectiveDraft.channelFieldId ?? ''}
                      onChange={(e) => updateChannelField(e.target.value)}
                    >
                      <option value="">None</option>
                      {analysis.fields
                        .filter((f) => f.role !== 'constant')
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label} ({f.uniqueCount} values)
                          </option>
                        ))}
                    </select>
                  </div>
                )}

                <div className="field-group">
                  <label>Sort Segments By</label>
                  <select
                    value={effectiveDraft.sortBy}
                    onChange={(e) => updateSortBy(e.target.value as 'timestamp' | 'name')}
                  >
                    <option value="timestamp">Chronological timestamp</option>
                    <option value="name">Natural filename order</option>
                  </select>
                </div>
              </div>

              {effectiveDraft.combineMode !== 'individual' && selectableFields.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="structure-section-label" style={{ marginBottom: 5 }}>
                    Separate Recordings By (Checked fields define distinct recordings):
                  </div>
                  <div className="structure-checkbox-grid">
                    {selectableFields.map((f) => (
                      <label key={f.id} className="inline-check structure-field-check">
                        <input
                          type="checkbox"
                          checked={effectiveDraft.groupByFieldIds.includes(f.id)}
                          onChange={() => toggleGroupField(f.id)}
                        />
                        <span>{f.label}</span>
                        <span className="structure-field-count">{f.uniqueCount}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Section 4: Live Preview of Resulting Recordings */}
      {!scanState.scanning && effectiveDraft && previewRecordings.length > 0 && (
        <div className="structure-section">
          <div className="structure-section-label">
            Live Preview — {previewRecordings.length} Recording
            {previewRecordings.length === 1 ? '' : 's'} (from {scannedFiles.length} files)
          </div>
          <div className="structure-preview-list">
            {previewRecordings.slice(0, 6).map((rec) => (
              <div key={rec.recordingId} className="structure-preview-row">
                {rec.fileCount > 1 || rec.channelCount > 1 ? (
                  <Layers size={12} color="#38bdf8" />
                ) : (
                  <FileAudio size={12} color="#4ade80" />
                )}
                <span className="structure-preview-title">{rec.title}</span>
                <span className="structure-preview-meta mono">
                  {rec.channelCount > 1 && (
                    <span className="rec-ch-badge">{rec.channelCount} ch</span>
                  )}
                  <span>{rec.subtitle}</span>
                  {rec.totalSizeBytes > 0 && <span>· {formatBytesCompact(rec.totalSizeBytes)}</span>}
                </span>
              </div>
            ))}
            {previewRecordings.length > 6 && (
              <div className="structure-preview-more">
                + {previewRecordings.length - 6} more recording
                {previewRecordings.length - 6 === 1 ? '' : 's'}
              </div>
            )}
          </div>
        </div>
      )}

      {!scanState.scanning && scannedFiles.length === 0 && !scanState.error && (
        <div className="panel-empty">
          No audio files found in this location. Try enabling &ldquo;Include subfolders&rdquo; or
          navigating to a folder containing recordings.
        </div>
      )}

      {/* Footer Actions */}
      <div className="structure-footer">
        <button type="button" className="btn-small" onClick={onCancel}>
          Cancel
        </button>
        {initialDefinition && (
          <button
            type="button"
            className="btn-small"
            onClick={onReset}
            title="Forget saved structure and show individual files"
          >
            <RotateCcw size={11} /> Reset to Raw Files
          </button>
        )}
        <button
          type="button"
          className="btn-small btn-primary"
          disabled={scanState.scanning || !effectiveDraft || scannedFiles.length === 0}
          style={{ marginLeft: 'auto' }}
          onClick={() => {
            if (effectiveDraft) onSave(effectiveDraft);
          }}
        >
          <Check size={12} /> Save &amp; Show {previewRecordings.length} Recording
          {previewRecordings.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
};

function buildCustomLabel(
  groupIds: string[],
  mode: CombineStructureMode,
  fields: Array<{ id: string; label: string }>,
): string {
  if (mode === 'individual') return 'Individual Files';
  const labels = groupIds
    .map((id) => fields.find((f) => f.id === id)?.label.split(' (')[0] ?? id)
    .slice(0, 3);
  const chTag = mode === 'channels' || mode === 'channels_and_time' ? ' (Multi-Ch)' : '';
  if (labels.length === 0) return `All Combined${chTag}`;
  return `By ${labels.join(' + ')}${chTag}`;
}
