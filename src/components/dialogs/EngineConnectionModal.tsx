import React, { useEffect, useState } from 'react';
import { CheckCircle2, Server, X, XCircle } from 'lucide-react';
import { useWorkspaceStore } from '../../store/workspaceStore';

export const EngineConnectionModal: React.FC = () => {
  const show = useWorkspaceStore((s) => s.showEngineModal);
  const backendUrl = useWorkspaceStore((s) => s.backendUrl);
  const backendToken = useWorkspaceStore((s) => s.backendToken);
  const backendConnected = useWorkspaceStore((s) => s.backendConnected);
  const backendVersion = useWorkspaceStore((s) => s.backendVersion);
  const setBackendConfig = useWorkspaceStore((s) => s.setBackendConfig);
  const checkBackendHealth = useWorkspaceStore((s) => s.checkBackendHealth);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const setStatus = useWorkspaceStore((s) => s.setStatus);

  const [urlInput, setUrlInput] = useState(backendUrl);
  const [tokenInput, setTokenInput] = useState(backendToken);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (show) {
      setUrlInput(backendUrl);
      setTokenInput(backendToken);
    }
  }, [show, backendUrl, backendToken]);

  if (!show) return null;

  const handleConnect = async () => {
    setTesting(true);
    setBackendConfig(urlInput, tokenInput);
    await checkBackendHealth();
    setTesting(false);
    const nowConnected = useWorkspaceStore.getState().backendConnected;
    if (nowConnected) {
      setStatus(`Connected to SyrinxOne Engine (${urlInput || 'same origin'})`);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => setModalState('showEngineModal', false)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Server size={14} /> Python Engine Connection (Cloud Run / Local)
          </span>
          <button className="mdi-icon-btn" onClick={() => setModalState('showEngineModal', false)}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-hint">
            Point the Web App (or Google AI Studio preview / mobile browser) at your deployed{' '}
            <strong>Google Cloud Run</strong> Python backend URL, or leave blank to use the local
            Vite proxy.
          </p>

          <div className="field-group">
            <label>Engine Base URL</label>
            <input
              type="url"
              value={urlInput}
              placeholder="https://syrinx-engine-xxxx.run.app (blank = same origin)"
              onChange={(e) => setUrlInput(e.target.value)}
            />
          </div>

          <div className="panel-btn-row" style={{ marginBottom: 8 }}>
            <button
              className="btn-small"
              onClick={() =>
                setUrlInput(
                  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_URL ||
                    'https://syrinx-engine-466330924576.us-west1.run.app',
                )
              }
            >
              Cloud Run (Default)
            </button>
            <button className="btn-small" onClick={() => setUrlInput('')}>
              Same Origin / Proxy
            </button>
            <button className="btn-small" onClick={() => setUrlInput('http://localhost:8765')}>
              localhost:8765
            </button>
          </div>

          <div className="field-group">
            <label>Bearer API Token (optional — if SYRINX_API_TOKEN is set on Cloud Run)</label>
            <input
              type="password"
              value={tokenInput}
              placeholder="Leave blank if unauthenticated"
              onChange={(e) => setTokenInput(e.target.value)}
            />
          </div>

          <div className="engine-status-row">
            {backendConnected ? (
              <span style={{ color: '#4ade80', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={14} /> Connected — Engine v{backendVersion || '0.1.0'}
              </span>
            ) : (
              <span style={{ color: '#f87171', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <XCircle size={14} /> Offline — check Engine URL &amp; CORS
              </span>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-small" onClick={() => setModalState('showEngineModal', false)}>
            Close
          </button>
          <button
            className="btn-small btn-primary"
            disabled={testing}
            onClick={() => void handleConnect()}
          >
            {testing ? 'Testing...' : 'Save & Test Connection'}
          </button>
        </div>
      </div>
    </div>
  );
};
