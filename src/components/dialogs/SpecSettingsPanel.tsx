import React from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import type { ColormapName, DspMode, RenderMode, TimeScaleMode, WindowType } from '@syrinxone/shared';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { MeasurementInspector } from '../panels/MeasurementInspector';

export const SpecSettingsPanel: React.FC = () => {
  const windows = useWorkspaceStore((s) => s.windows);
  const activeWindowId = useWorkspaceStore((s) => s.activeWindowId);
  const files = useWorkspaceStore((s) => s.files);
  const updateWindowDisplaySettings = useWorkspaceStore((s) => s.updateWindowDisplaySettings);
  const updateWindowSpecParams = useWorkspaceStore((s) => s.updateWindowSpecParams);
  const applySettingsToAllWindows = useWorkspaceStore((s) => s.applySettingsToAllWindows);
  const makeActiveSettingsDefault = useWorkspaceStore((s) => s.makeActiveSettingsDefault);
  const setWindowAutoGainMode = useWorkspaceStore((s) => s.setWindowAutoGainMode);
  const normalizeWindowGain = useWorkspaceStore((s) => s.normalizeWindowGain);
  const windowAutoGainMode = useWorkspaceStore((s) => s.windowAutoGainMode);
  const setModalState = useWorkspaceStore((s) => s.setModalState);

  const activeWin = windows.find((w) => w.windowId === activeWindowId);
  const activeFile = activeWin ? files[activeWin.fileId] : undefined;
  if (!activeWin) {
    return (
      <aside className="side-panel">
        <div className="panel-header ai-panel-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <SlidersHorizontal size={13} color="#38bdf8" /> Spectrogram Settings
          </span>
          <button
            className="mdi-icon-btn desktop-only"
            onClick={() => setModalState('showSpecPanel', false)}
            title="Close Settings panel"
          >
            <X size={13} />
          </button>
        </div>
        <div className="panel-empty">Open a recording to adjust spectrogram &amp; FFT settings.</div>
      </aside>
    );
  }

  const { displaySettings: disp, specParams: spec } = activeWin;
  const autoGainMode = windowAutoGainMode[activeWin.windowId] ?? 'manual';

  return (
    <aside className="side-panel">
      <div className="panel-header ai-panel-header">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <SlidersHorizontal size={13} color="#38bdf8" /> Spectrogram Settings
        </span>
        <button
          className="mdi-icon-btn desktop-only"
          onClick={() => setModalState('showSpecPanel', false)}
          title="Close Settings panel"
        >
          <X size={13} />
        </button>
      </div>
      <div className="panel-body">
        <MeasurementInspector />

        <div className="panel-btn-row">
          <button
            className="btn-small"
            onClick={() => void applySettingsToAllWindows(activeWin.windowId)}
            title="Apply active window settings to all unlocked windows"
          >
            Apply to All
          </button>
          <button
            className="btn-small"
            onClick={() => makeActiveSettingsDefault(activeWin.windowId)}
            title="Save active settings as default"
          >
            Make Default
          </button>
        </div>

        <hr className="panel-divider" />

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
            <option value="grayscale_bow">Grayscale (Black on White)</option>
            <option value="grayscale_wob">Grayscale (White on Black)</option>
            <option value="viridis">Viridis</option>
            <option value="magma">Magma</option>
            <option value="inferno">Inferno</option>
            <option value="turbo">Turbo</option>
          </select>
        </div>

        <div className="field-group">
          <label>Contrast Normalization</label>
          <div className="field-inline-row" style={{ justifyContent: 'space-between' }}>
            <button
              type="button"
              className={`btn-small ${autoGainMode === 'auto' ? 'btn-active' : 'btn-primary'}`}
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={() =>
                normalizeWindowGain(activeWin.windowId, {
                  scope: activeWin.selection ? 'selection' : 'view',
                })
              }
            >
              {activeWin.selection ? 'Normalize Selection' : 'Normalize View'}
            </button>
            <label
              className="inline-check"
              style={{ fontSize: 12, color: 'var(--text)', flexShrink: 0 }}
              title="Auto-normalize contrast on load, zoom & pan"
            >
              <input
                type="checkbox"
                checked={autoGainMode === 'auto'}
                onChange={(e) =>
                  setWindowAutoGainMode(activeWin.windowId, e.target.checked ? 'auto' : 'manual')
                }
              />
              Auto
            </label>
          </div>
        </div>

        <div className="field-group">
          <label>
            Gain
            <span>
              {disp.gainDb.toFixed(0)} dB{autoGainMode === 'auto' ? ' · Auto' : ''}
            </span>
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

        <div className="settings-pair-grid">
          <div className="field-group">
            <label>
              Floor <span>{disp.thresholdDb.toFixed(0)} dB</span>
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
              Range <span>{disp.dynamicRangeDb.toFixed(0)} dB</span>
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
        </div>

        <hr className="panel-divider" />

        <div className="settings-pair-grid">
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
            <label>Window</label>
            <select
              value={spec.windowType}
              onChange={(e) =>
                void updateWindowSpecParams(activeWin.windowId, {
                  windowType: e.target.value as WindowType,
                })
              }
            >
              <option value="hann">Hann</option>
              <option value="blackman">Blackman</option>
              <option value="hamming">Hamming</option>
              <option value="rect">Rectangular</option>
            </select>
          </div>

          <div className="field-group">
            <label>DSP Engine</label>
            <select
              value={spec.dspMode}
              onChange={(e) =>
                void updateWindowSpecParams(activeWin.windowId, {
                  dspMode: e.target.value as DspMode,
                })
              }
            >
              <option value="modern_stft">Modern STFT</option>
              <option value="classic_syrinx">Classic Syrinx</option>
            </select>
          </div>

          <div className="field-group">
            <label>Time Scale</label>
            <select
              value={disp.timeScaleMode}
              onChange={(e) =>
                updateWindowDisplaySettings(activeWin.windowId, {
                  timeScaleMode: e.target.value as TimeScaleMode,
                })
              }
            >
              <option value="stretch">Stretch</option>
              <option value="fixed">Fixed (ms/px)</option>
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
              <option value="webgl_float32">WebGL2 GPU</option>
              <option value="server_bitmap">Bitmap PNG</option>
            </select>
          </div>
        </div>

        {disp.timeScaleMode === 'fixed' && (
          <div className="field-group">
            <label>
              ms per pixel <span>{disp.msPerPixel.toFixed(1)} ms/px</span>
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
          <label>
            Split Time Rows <span>{disp.splitTimeRows ?? 1} / 10</span>
          </label>
          <div className="field-inline-row">
            <button
              type="button"
              className="btn-small"
              disabled={(disp.splitTimeRows ?? 1) <= 1}
              onClick={() =>
                updateWindowDisplaySettings(activeWin.windowId, {
                  splitTimeRows: Math.max(1, (disp.splitTimeRows ?? 1) - 1),
                })
              }
              title="Decrease contiguous time rows"
            >
              −
            </button>
            <select
              value={disp.splitTimeRows ?? 1}
              onChange={(e) =>
                updateWindowDisplaySettings(activeWin.windowId, {
                  splitTimeRows: Number(e.target.value),
                })
              }
              title="Split spectrogram into up to 10 contiguous time rows"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? '1 Row (Single View)' : `${n} Contiguous Time Rows`}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-small"
              disabled={(disp.splitTimeRows ?? 1) >= 10}
              onClick={() =>
                updateWindowDisplaySettings(activeWin.windowId, {
                  splitTimeRows: Math.min(10, (disp.splitTimeRows ?? 1) + 1),
                })
              }
              title="Increase contiguous time rows"
            >
              +
            </button>
          </div>
        </div>

        <div className="field-group">
          <label>
            Channel Display{' '}
            <span>{activeFile && activeFile.numChannels > 1 ? `${activeFile.numChannels} ch` : 'Mono'}</span>
          </label>
          <select
            disabled={!activeFile || activeFile.numChannels <= 1}
            value={
              activeFile && activeFile.numChannels > 1 && disp.stackAllChannels
                ? -1
                : spec.channel
            }
            onChange={(e) => {
              const val = Number(e.target.value);
              if (val === -1) {
                updateWindowDisplaySettings(activeWin.windowId, { stackAllChannels: true });
              } else {
                if (disp.stackAllChannels) {
                  updateWindowDisplaySettings(activeWin.windowId, { stackAllChannels: false });
                }
                void updateWindowSpecParams(activeWin.windowId, { channel: val });
              }
            }}
            title="Select single channel or stack all channels as separate rows"
          >
            {activeFile && activeFile.numChannels > 1 ? (
              <>
                <option value={-1}>Stack All {activeFile.numChannels} Channels</option>
                {Array.from({ length: activeFile.numChannels }, (_, idx) => (
                  <option key={idx} value={idx}>
                    Channel {idx + 1} only
                  </option>
                ))}
              </>
            ) : (
              <option value={0}>Channel 1 (Mono recording)</option>
            )}
          </select>
        </div>

        <hr className="panel-divider" />

        <div className="checkbox-grid compact-checkbox-grid">
          <label>
            <input
              type="checkbox"
              checked={disp.showWaveform}
              onChange={(e) =>
                updateWindowDisplaySettings(activeWin.windowId, { showWaveform: e.target.checked })
              }
            />
            Waveform
          </label>
          <label>
            <input
              type="checkbox"
              checked={disp.showAxes}
              onChange={(e) =>
                updateWindowDisplaySettings(activeWin.windowId, { showAxes: e.target.checked })
              }
            />
            Axes
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
            Annotations
          </label>
          <label>
            <input
              type="checkbox"
              checked={disp.showCursors}
              onChange={(e) =>
                updateWindowDisplaySettings(activeWin.windowId, { showCursors: e.target.checked })
              }
            />
            Cursors
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
            Lock window
          </label>
        </div>
      </div>
    </aside>
  );
};
