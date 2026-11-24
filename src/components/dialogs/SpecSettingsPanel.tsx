import React from 'react';
import { X } from 'lucide-react';
import type { ColormapName, DspMode, RenderMode, TimeScaleMode, WindowType } from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { MeasurementInspector } from '../panels/MeasurementInspector';

export const SpecSettingsPanel: React.FC = () => {
  const windows = useWorkspaceStore((s) => s.windows);
  const activeWindowId = useWorkspaceStore((s) => s.activeWindowId);
  const updateWindowDisplaySettings = useWorkspaceStore((s) => s.updateWindowDisplaySettings);
  const updateWindowSpecParams = useWorkspaceStore((s) => s.updateWindowSpecParams);
  const applySettingsToAllWindows = useWorkspaceStore((s) => s.applySettingsToAllWindows);
  const makeActiveSettingsDefault = useWorkspaceStore((s) => s.makeActiveSettingsDefault);
  const setModalState = useWorkspaceStore((s) => s.setModalState);

  const activeWin = windows.find((w) => w.windowId === activeWindowId);
  if (!activeWin) {
    return (
      <aside className="side-panel">
        <div className="panel-header ai-panel-header">
          <span>Spectrogram Settings</span>
          <button
            className="mdi-win-btn"
            onClick={() => setModalState('showSpecPanel', false)}
            title="Close Settings panel"
          >
            <X size={13} />
          </button>
        </div>
        <div className="panel-empty">Select a window to adjust display &amp; FFT settings.</div>
      </aside>
    );
  }

  const { displaySettings: disp, specParams: spec } = activeWin;

  return (
    <aside className="side-panel">
      <div className="panel-header ai-panel-header">
        <span>Spectrogram Settings</span>
        <button
          className="mdi-win-btn"
          onClick={() => setModalState('showSpecPanel', false)}
          title="Close Settings panel"
        >
          <X size={13} />
        </button>
      </div>
      <div className="panel-body">
        <MeasurementInspector />
        <hr className="panel-divider" />
        <div className="panel-btn-row">
          <button
            className="btn-small"
            onClick={() => void applySettingsToAllWindows(activeWin.windowId)}
            title="Apply active window display & FFT settings to all unlocked windows"
          >
            Apply to All
          </button>
          <button
            className="btn-small"
            onClick={() => makeActiveSettingsDefault(activeWin.windowId)}
            title="Save active window display & FFT settings as default for new windows"
          >
            Make Default
          </button>
        </div>

        <div className="field-group">
          <label>Colormap</label>
          <select
            value={disp.colormap}
            onChange={(e) =>
              updateWindowDisplaySettings(activeWin.windowId, {
                colormap: e.target.value as ColormapName,
              })
            }
          >
            <option value="grayscale_bow">Grayscale (Black on White — Classic)</option>
            <option value="grayscale_wob">Grayscale (White on Black)</option>
            <option value="viridis">Viridis</option>
            <option value="magma">Magma</option>
            <option value="inferno">Inferno</option>
            <option value="turbo">Turbo</option>
          </select>
        </div>

        <div className="field-group">
          <label>
            Gain (Alt+↑/↓): <span>{disp.gainDb.toFixed(0)} dB</span>
          </label>
          <input
            type="range"
            min={-40}
            max={60}
            step={1}
            value={disp.gainDb}
            onChange={(e) =>
              updateWindowDisplaySettings(activeWin.windowId, { gainDb: Number(e.target.value) })
            }
          />
        </div>

        <div className="field-group">
          <label>
            Floor Threshold: <span>{disp.thresholdDb.toFixed(0)} dB</span>
          </label>
          <input
            type="range"
            min={-120}
            max={-10}
            step={1}
            value={disp.thresholdDb}
            onChange={(e) =>
              updateWindowDisplaySettings(activeWin.windowId, {
                thresholdDb: Number(e.target.value),
              })
            }
          />
        </div>

        <div className="field-group">
          <label>
            Dynamic Range: <span>{disp.dynamicRangeDb.toFixed(0)} dB</span>
          </label>
          <input
            type="range"
            min={15}
            max={120}
            step={1}
            value={disp.dynamicRangeDb}
            onChange={(e) =>
              updateWindowDisplaySettings(activeWin.windowId, {
                dynamicRangeDb: Number(e.target.value),
              })
            }
          />
        </div>

        <hr className="panel-divider" />

        <div className="field-group">
          <label>Time Scale Mode (Alt+T)</label>
          <select
            value={disp.timeScaleMode}
            onChange={(e) =>
              updateWindowDisplaySettings(activeWin.windowId, {
                timeScaleMode: e.target.value as TimeScaleMode,
              })
            }
          >
            <option value="stretch">Stretch to Window</option>
            <option value="fixed">Fixed Scale (ms / px)</option>
          </select>
        </div>

        {disp.timeScaleMode === 'fixed' && (
          <div className="field-group">
            <label>
              ms per pixel: <span>{disp.msPerPixel.toFixed(1)} ms/px</span>
            </label>
            <input
              type="range"
              min={0.5}
              max={25}
              step={0.5}
              value={disp.msPerPixel}
              onChange={(e) =>
                updateWindowDisplaySettings(activeWin.windowId, {
                  msPerPixel: Number(e.target.value),
                })
              }
            />
          </div>
        )}

        <hr className="panel-divider" />

        <div className="field-group">
          <label>FFT Size</label>
          <select
            value={spec.fftSize}
            onChange={(e) => {
              const fftSize = Number(e.target.value);
              void updateWindowSpecParams(activeWin.windowId, {
                fftSize,
                hopSize: Math.max(16, Math.floor(fftSize / 4)),
              });
            }}
          >
            {[128, 256, 512, 1024, 2048, 4096].map((n) => (
              <option key={n} value={n}>
                {n} pts
              </option>
            ))}
          </select>
        </div>

        <div className="field-group">
          <label>Overlap</label>
          <select
            value={Math.round((1 - spec.hopSize / spec.fftSize) * 100)}
            onChange={(e) => {
              const pct = Number(e.target.value);
              const hopSize = Math.max(8, Math.round(spec.fftSize * (1 - pct / 100)));
              void updateWindowSpecParams(activeWin.windowId, { hopSize });
            }}
          >
            {[50, 75, 87, 94].map((p) => (
              <option key={p} value={p}>
                {p}%
              </option>
            ))}
          </select>
        </div>

        <div className="field-group">
          <label>Window Function</label>
          <select
            value={spec.windowType}
            onChange={(e) =>
              void updateWindowSpecParams(activeWin.windowId, {
                windowType: e.target.value as WindowType,
              })
            }
          >
            <option value="hann">Hann (Hanning)</option>
            <option value="blackman">Blackman</option>
            <option value="hamming">Hamming</option>
            <option value="rect">Rectangular (Square)</option>
          </select>
        </div>

        <div className="field-group">
          <label>DSP Engine Mode</label>
          <select
            value={spec.dspMode}
            onChange={(e) =>
              void updateWindowSpecParams(activeWin.windowId, {
                dspMode: e.target.value as DspMode,
              })
            }
          >
            <option value="modern_stft">Modern STFT (SciPy dB)</option>
            <option value="classic_syrinx">Classic Syrinx (FFTTools)</option>
          </select>
        </div>

        <div className="field-group">
          <label>Renderer</label>
          <select
            value={disp.renderMode}
            onChange={(e) =>
              updateWindowDisplaySettings(activeWin.windowId, {
                renderMode: e.target.value as RenderMode,
              })
            }
          >
            <option value="webgl_float32">WebGL2 GPU Shader (60fps)</option>
            <option value="server_bitmap">Python Bitmap Fallback (PNG)</option>
          </select>
        </div>

        <hr className="panel-divider" />

        <div className="checkbox-grid">
          <label>
            <input
              type="checkbox"
              checked={disp.showWaveform}
              onChange={(e) =>
                updateWindowDisplaySettings(activeWin.windowId, { showWaveform: e.target.checked })
              }
            />
            Waveform strip
          </label>
          <label>
            <input
              type="checkbox"
              checked={disp.showAxes}
              onChange={(e) =>
                updateWindowDisplaySettings(activeWin.windowId, { showAxes: e.target.checked })
              }
            />
            Time/Freq axes
          </label>
          <label>
            <input
              type="checkbox"
              checked={disp.showGrid}
              onChange={(e) =>
                updateWindowDisplaySettings(activeWin.windowId, { showGrid: e.target.checked })
              }
            />
            Grid lines
          </label>
          <label>
            <input
              type="checkbox"
              checked={disp.showAnnotations}
              onChange={(e) =>
                updateWindowDisplaySettings(activeWin.windowId, {
                  showAnnotations: e.target.checked,
                })
              }
            />
            Annotation boxes
          </label>
          <label>
            <input
              type="checkbox"
              checked={disp.showCursors}
              onChange={(e) =>
                updateWindowDisplaySettings(activeWin.windowId, { showCursors: e.target.checked })
              }
            />
            Show cursors (Shift+H)
          </label>
          <label>
            <input
              type="checkbox"
              checked={spec.popFilter}
              onChange={(e) =>
                void updateWindowSpecParams(activeWin.windowId, { popFilter: e.target.checked })
              }
            />
            Pop filter
          </label>
          <label>
            <input
              type="checkbox"
              checked={disp.lockSettings}
              onChange={(e) =>
                updateWindowDisplaySettings(activeWin.windowId, { lockSettings: e.target.checked })
              }
            />
            Lock window settings
          </label>
        </div>
      </div>
    </aside>
  );
};
