import React, { useEffect, useRef, useState } from 'react';
import { Radar, Send, Settings2, Sparkles, Tag, X } from 'lucide-react';
import type {
  AiChatMessage,
  SelectionMeasurements,
  SuggestedDetectParams,
} from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';

const AI_KEY_STORAGE = 'syrinxone.geminiApiKey.v1';
const AI_MODEL_STORAGE = 'syrinxone.geminiModel.v1';

interface ExplorerEntry extends AiChatMessage {
  id: string;
  modelUsed?: string;
  measurements?: SelectionMeasurements;
  suggestedDetectParams?: SuggestedDetectParams;
  suggestedLabels?: string[];
}

const QUICK_PROMPTS = [
  'Analyze the acoustic structure and likely sound source in this selection.',
  'Suggest optimal Detect Sounds parameters to find similar events in this recording.',
  'Summarize the frequency bands, SNR, and signal characteristics.',
  'Review my current annotations and suggest consistent labels or groupings.',
];

export const AiExplorerPanel: React.FC = () => {
  const engine = useWorkspaceStore((s) => s.engine);
  const windows = useWorkspaceStore((s) => s.windows);
  const activeWindowId = useWorkspaceStore((s) => s.activeWindowId);
  const files = useWorkspaceStore((s) => s.files);
  const annotations = useWorkspaceStore((s) => s.annotations);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const logActiveSelection = useWorkspaceStore((s) => s.logActiveSelection);
  const applySuggestedDetectParams = useWorkspaceStore((s) => s.applySuggestedDetectParams);

  const activeWin = windows.find((w) => w.windowId === activeWindowId);
  const activeFile = activeWin ? files[activeWin.fileId] : undefined;

  const [entries, setEntries] = useState<ExplorerEntry[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [includeSpecImg, setIncludeSpecImg] = useState(true);
  const [apiKey, setApiKey] = useState(() => {
    try {
      return localStorage.getItem(AI_KEY_STORAGE) || '';
    } catch {
      return '';
    }
  });
  const [model, setModel] = useState(() => {
    try {
      return localStorage.getItem(AI_MODEL_STORAGE) || 'gemini-2.5-flash';
    } catch {
      return 'gemini-2.5-flash';
    }
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(AI_KEY_STORAGE, apiKey);
      localStorage.setItem(AI_MODEL_STORAGE, model);
    } catch {
      // ignore storage errors
    }
  }, [apiKey, model]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, busy]);

  const handleSend = async (customPrompt?: string) => {
    const q = (customPrompt ?? prompt).trim();
    if (!q || !activeWin || !activeFile || busy) return;

    const userMsg: ExplorerEntry = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: q,
    };
    const history: AiChatMessage[] = entries.slice(-8).map((e) => ({
      role: e.role,
      content: e.content,
    }));

    setEntries((prev) => [...prev, userMsg]);
    if (!customPrompt) setPrompt('');
    setBusy(true);
    setError(null);

    try {
      const sel = activeWin.selection;
      const resp = await engine.analyzeWithAi({
        fileId: activeFile.fileId,
        channel: activeWin.specParams.channel,
        prompt: q,
        history,
        selection: sel
          ? {
              startSec: Math.min(sel.startSec, sel.endSec),
              endSec: Math.max(sel.startSec, sel.endSec),
              lowFreqHz: Math.min(sel.lowFreqHz, sel.highFreqHz),
              highFreqHz: Math.max(sel.lowFreqHz, sel.highFreqHz),
            }
          : undefined,
        viewRange: activeWin.viewRange,
        specParams: activeWin.specParams,
        displaySettings: activeWin.displaySettings,
        annotations: annotations.filter(
          (a) => a.soundfile.toLowerCase() === activeFile.name.toLowerCase(),
        ),
        includeSpectrogramImage: includeSpecImg,
        apiKey: apiKey.trim() || undefined,
        model: model.trim() || 'gemini-2.5-flash',
      });

      const assistantMsg: ExplorerEntry = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: resp.answer,
        modelUsed: resp.modelUsed,
        measurements: resp.measurements,
        suggestedDetectParams: resp.suggestedDetectParams,
        suggestedLabels: resp.suggestedLabels,
      };
      setEntries((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI analysis failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="ai-panel">
      <div className="panel-header">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Sparkles size={14} color="#38bdf8" /> AI Bioacoustic Explorer
        </span>
        <div style={{ display: 'inline-flex', gap: 4 }}>
          <button
            className={`mdi-icon-btn ${showSettings ? 'btn-active' : ''}`}
            onClick={() => setShowSettings((v) => !v)}
            title="AI Model & Gemini API Key Settings"
          >
            <Settings2 size={13} />
          </button>
          <button
            className="mdi-icon-btn"
            onClick={() => setModalState('showAiPanel', false)}
            title="Close AI Explorer"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="ai-settings-box">
          <div className="field-group">
            <label>Gemini API Key (optional if server GEMINI_API_KEY is set)</label>
            <input
              type="password"
              value={apiKey}
              placeholder="AIza... (blank = offline DSP summary)"
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div className="field-group">
            <label>Gemini Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="gemini-2.5-flash">gemini-2.5-flash (Fast Multimodal)</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro (Deep Reasoning)</option>
              <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
            </select>
          </div>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={includeSpecImg}
              onChange={(e) => setIncludeSpecImg(e.target.checked)}
            />
            Send active selection spectrogram PNG to Gemini
          </label>
        </div>
      )}

      <div className="ai-context-bar">
        {activeFile ? (
          <>
            <strong className="mono">{activeFile.name}</strong>
            <span>
              {activeWin?.selection
                ? `Selection: ${Math.min(activeWin.selection.startSec, activeWin.selection.endSec).toFixed(2)}s–${Math.max(activeWin.selection.startSec, activeWin.selection.endSec).toFixed(2)}s · ${Math.round(Math.min(activeWin.selection.lowFreqHz, activeWin.selection.highFreqHz))}–${Math.round(Math.max(activeWin.selection.lowFreqHz, activeWin.selection.highFreqHz))} Hz`
                : `Viewport: ${activeWin?.viewRange.startSec.toFixed(1)}s–${activeWin?.viewRange.endSec.toFixed(1)}s (${activeFile.sampleRate} Hz)`}
            </span>
          </>
        ) : (
          <span>Open an audio file to explore its acoustics with AI.</span>
        )}
      </div>

      <div className="ai-messages" ref={scrollRef}>
        {entries.length === 0 && (
          <div className="ai-welcome">
            <p>
              Inspect selections with grounded Python DSP measurements + multimodal spectrogram
              analysis. Draw a selection box on any spectrogram, or pick a prompt:
            </p>
            <div className="ai-quick-prompts">
              {QUICK_PROMPTS.map((qp) => (
                <button
                  key={qp}
                  className="ai-prompt-chip"
                  disabled={!activeFile || busy}
                  onClick={() => void handleSend(qp)}
                >
                  {qp}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((msg) => (
          <div key={msg.id} className={`ai-msg ai-msg-${msg.role}`}>
            <div className="ai-msg-meta">
              <span>{msg.role === 'user' ? 'You' : `Explorer (${msg.modelUsed ?? 'ai'})`}</span>
            </div>
            <div className="ai-msg-body">{msg.content}</div>

            {msg.measurements && (
              <div className="ai-meas-strip mono">
                Peak {msg.measurements.peakFreqHz.toFixed(0)} Hz · BW90{' '}
                {msg.measurements.bw90Hz.toFixed(0)} Hz · SNR {msg.measurements.snrDb.toFixed(1)} dB
              </div>
            )}

            {msg.suggestedLabels && msg.suggestedLabels.length > 0 && activeWin?.selection && (
              <div className="ai-action-row">
                {msg.suggestedLabels.map((lbl) => (
                  <button
                    key={lbl}
                    className="btn-small"
                    onClick={() => logActiveSelection(lbl)}
                    title={`Stamp active selection with "${lbl}"`}
                  >
                    <Tag size={11} /> {lbl}
                  </button>
                ))}
              </div>
            )}

            {msg.suggestedDetectParams && (
              <div className="ai-action-row">
                <button
                  className="btn-small btn-primary"
                  onClick={() => applySuggestedDetectParams(msg.suggestedDetectParams!)}
                >
                  <Radar size={12} /> Apply to Detect Sounds (
                  {Math.round(msg.suggestedDetectParams.minFreqHz)}–
                  {Math.round(msg.suggestedDetectParams.maxFreqHz)} Hz)
                </button>
              </div>
            )}
          </div>
        ))}

        {busy && <div className="ai-msg ai-msg-assistant">Analyzing spectrogram &amp; DSP metrics...</div>}
        {error && <div className="inline-error">{error}</div>}
      </div>

      <div className="ai-input-bar">
        <input
          type="text"
          value={prompt}
          disabled={!activeFile || busy}
          placeholder={
            activeFile
              ? 'Ask about call type, harmonics, noise floor, detection settings...'
              : 'Open a recording first...'
          }
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSend();
          }}
        />
        <button
          className="btn-small btn-primary"
          disabled={!activeFile || !prompt.trim() || busy}
          onClick={() => void handleSend()}
        >
          <Send size={13} />
        </button>
      </div>
    </aside>
  );
};
