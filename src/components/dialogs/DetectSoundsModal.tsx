import React, { useEffect, useState } from 'react';
import { Radar, X } from 'lucide-react';
import { useWorkspaceStore } from '../../store/workspaceStore';

export const DetectSoundsModal: React.FC = () => {
  const show = useWorkspaceStore((s) => s.showDetectModal);
  const suggestedDetectParams = useWorkspaceStore((s) => s.suggestedDetectParams);
  const clearSuggestedDetectParams = useWorkspaceStore((s) => s.clearSuggestedDetectParams);
  const windows = useWorkspaceStore((s) => s.windows);
  const activeWindowId = useWorkspaceStore((s) => s.activeWindowId);
  const files = useWorkspaceStore((s) => s.files);
  const engine = useWorkspaceStore((s) => s.engine);
  const addDetectedAnnotations = useWorkspaceStore((s) => s.addDetectedAnnotations);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const setStatus = useWorkspaceStore((s) => s.setStatus);
  const setError = useWorkspaceStore((s) => s.setError);

  const activeWin = windows.find((w) => w.windowId === activeWindowId);
  const activeFile = activeWin ? files[activeWin.fileId] : undefined;

  const [minFreqHz, setMinFreqHz] = useState(1500);
  const [maxFreqHz, setMaxFreqHz] = useState(9000);
  const [triggerThresholdDb, setTriggerThresholdDb] = useState(14);
  const [minTriggerDurSec, setMinTriggerDurSec] = useState(0.015);
  const [minSoundDurSec, setMinSoundDurSec] = useState(0.08);
  const [maxSilenceGapSec, setMaxSilenceGapSec] = useState(0.25);
  const [preBufferSec, setPreBufferSec] = useState(0.03);
  const [postBufferSec, setPostBufferSec] = useState(0.05);
  const [popFilter, setPopFilter] = useState(true);
  const [comment, setComment] = useState('Detected');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [saveClips, setSaveClips] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    if (!show || !suggestedDetectParams) return;
    setMinFreqHz(Math.round(suggestedDetectParams.minFreqHz));
    setMaxFreqHz(Math.round(suggestedDetectParams.maxFreqHz));
    setTriggerThresholdDb(suggestedDetectParams.triggerThresholdDb);
    setMinSoundDurSec(suggestedDetectParams.minSoundDurSec);
    setMaxSilenceGapSec(suggestedDetectParams.maxSilenceGapSec);
    if (suggestedDetectParams.comment) {
      setComment(suggestedDetectParams.comment);
    }
    clearSuggestedDetectParams();
  }, [show, suggestedDetectParams, clearSuggestedDetectParams]);

  if (!show) return null;

  const handleRun = async () => {
    if (!activeWin || !activeFile) return;
    setBusy(true);
    setSummary(null);
    try {
      const resp = await engine.detectSounds(activeFile.fileId, {
        channel: activeWin.specParams.channel,
        fftSize: activeWin.specParams.fftSize,
        hopSize: activeWin.specParams.hopSize,
        minFreqHz,
        maxFreqHz,
        triggerThresholdDb,
        minTriggerDurSec,
        minSoundDurSec,
        maxSilenceGapSec,
        preBufferSec,
        postBufferSec,
        popFilter,
        comment,
        saveClips,
        targetSourceId: activeFile.sourceId === 'upload' ? 'local' : activeFile.sourceId,
      });
      addDetectedAnnotations(resp.detections, replaceExisting ? activeFile.name : undefined);
      const msg = `Detected ${resp.detections.length} sound(s) (noise floor ${resp.noiseFloorDb.toFixed(1)} dB)${
        resp.savedClips.length > 0 ? ` · saved ${resp.savedClips.length} WAV clips` : ''
      }`;
      setSummary(msg);
      setStatus(msg);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sound detection failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => setModalState('showDetectModal', false)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Radar size={14} /> Detect Sounds in Recording (Offline Detector)
          </span>
          <button className="mdi-icon-btn" onClick={() => setModalState('showDetectModal', false)}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          {!activeFile ? (
            <p>Open an audio file first.</p>
          ) : (
            <>
              <p className="modal-hint">
                Target: <strong>{activeFile.name}</strong> (Ch {(activeWin?.specParams.channel ?? 0) + 1},{' '}
                {activeFile.durationSec.toFixed(2)}s). Detections are added as editable annotation
                boxes on the spectrogram.
              </p>

              <div className="detect-grid">
                <div className="field-group">
                  <label>Min Frequency (Hz)</label>
                  <input
                    type="number"
                    value={minFreqHz}
                    onChange={(e) => setMinFreqHz(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <label>Max Frequency (Hz)</label>
                  <input
                    type="number"
                    value={maxFreqHz}
                    onChange={(e) => setMaxFreqHz(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <label>Threshold Above Noise (dB)</label>
                  <input
                    type="number"
                    step={1}
                    value={triggerThresholdDb}
                    onChange={(e) => setTriggerThresholdDb(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <label>Min Trigger Event (s)</label>
                  <input
                    type="number"
                    step={0.005}
                    value={minTriggerDurSec}
                    onChange={(e) => setMinTriggerDurSec(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <label>Min Total Sound Dur (s)</label>
                  <input
                    type="number"
                    step={0.01}
                    value={minSoundDurSec}
                    onChange={(e) => setMinSoundDurSec(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <label>Max Silence Gap (s)</label>
                  <input
                    type="number"
                    step={0.05}
                    value={maxSilenceGapSec}
                    onChange={(e) => setMaxSilenceGapSec(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <label>Pre-Buffer (s)</label>
                  <input
                    type="number"
                    step={0.01}
                    value={preBufferSec}
                    onChange={(e) => setPreBufferSec(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <label>Post-Buffer (s)</label>
                  <input
                    type="number"
                    step={0.01}
                    value={postBufferSec}
                    onChange={(e) => setPostBufferSec(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="field-group">
                <label>Annotation Comment Label</label>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
              </div>

              <div className="checkbox-grid">
                <label>
                  <input
                    type="checkbox"
                    checked={popFilter}
                    onChange={(e) => setPopFilter(e.target.checked)}
                  />
                  Apply broadband pop filter
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={replaceExisting}
                    onChange={(e) => setReplaceExisting(e.target.checked)}
                  />
                  Replace existing annotations on this file
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={saveClips}
                    onChange={(e) => setSaveClips(e.target.checked)}
                  />
                  Also extract each detection as a WAV clip file
                </label>
              </div>

              {summary && <div className="detect-summary">{summary}</div>}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-small" onClick={() => setModalState('showDetectModal', false)}>
            Close
          </button>
          <button
            className="btn-small btn-primary"
            disabled={!activeFile || busy}
            onClick={() => void handleRun()}
          >
            {busy ? 'Detecting...' : 'Run Detector'}
          </button>
        </div>
      </div>
    </div>
  );
};
