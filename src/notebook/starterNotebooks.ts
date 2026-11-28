import type { SyrinxNotebook } from './types';

export function createStarterNotebooks(): SyrinxNotebook[] {
  const now = Date.now();
  return [
    {
      id: 'starter-bioacoustic-eda',
      title: 'Acoustic EDA & Band Report',
      description:
        'Summarizes spectral band energy, temporal peaks, SNR, and generates an EDA report with Gemini.',
      scope: 'recording',
      pinToTools: true,
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
      parameters: [
        {
          name: 'snr_threshold_db',
          label: 'Active Band SNR (dB)',
          type: 'number',
          defaultValue: 8,
        },
        {
          name: 'habitat_note',
          label: 'Site / Array Context',
          type: 'string',
          defaultValue: 'Field recording',
        },
      ],
      cells: [
        {
          id: 'eda-md-1',
          kind: 'markdown',
          title: 'Overview',
          enabled: true,
          source:
            '## Exploratory Acoustic Data Analysis\nEvaluates full-window spectral band power, temporal energy peaks, and noise floor, then asks **Gemini** to document key bioacoustic activity and detector settings.',
        },
        {
          id: 'eda-py-1',
          kind: 'python',
          title: 'Compute Spectral Band & Temporal Profile',
          enabled: true,
          source: `import numpy as np
import matplotlib.pyplot as plt

ctx = syrinx.context
spec = syrinx.spectrogram(channel=ctx["channel"])
S = spec["data"]  # shape: (time_bins, freq_bins) in dB
freqs = np.linspace(spec["minFreqHz"], spec["maxFreqHz"], S.shape[1])

band_mean = np.mean(S, axis=0)
band_p95 = np.percentile(S, 95, axis=0)
noise_floor = float(np.percentile(S, 20))
peak_freq = float(freqs[int(np.argmax(band_p95))])

fig, ax = plt.subplots(figsize=(7.5, 3.0), dpi=130)
ax.plot(freqs / 1000.0, band_p95, label="95th pct (dB)", color="#38bdf8")
ax.plot(freqs / 1000.0, band_mean, label="Mean (dB)", color="#94a3b8")
ax.axhline(noise_floor + float(ctx["params"]["snr_threshold_db"]), ls="--", color="#f59e0b", label="SNR Gate")
ax.set_xlabel("Frequency (kHz)")
ax.set_ylabel("Power (dB)")
ax.set_title(f"{ctx['name']} — Spectral Profile")
ax.legend()
syrinx.emit_figure(fig, "Spectral Energy Distribution")
syrinx.set_var("peak_freq_hz", round(peak_freq, 1))
syrinx.set_var("noise_floor_db", round(noise_floor, 1))
print(f"Peak P95 energy at {peak_freq:.1f} Hz | P20 noise floor: {noise_floor:.1f} dB")`,
        },
        {
          id: 'eda-ai-1',
          kind: 'ai',
          title: 'Gemini EDA Narrative & Detector Guidance',
          enabled: true,
          source: `Using the attached spectrogram, spectral distribution plot, DSP summaries, and script parameters (site context: "{{habitat_note}}", SNR threshold: {{snr_threshold_db}} dB), write a concise scientific EDA summary covering:
1. Dominant frequency bands and active acoustic windows.
2. Noise floor and background characteristics (wind/rain/anthropogenic/biophony).
3. Recommended Detect Sounds frequency bounds and threshold settings to isolate the main biological signals.`,
        },
      ],
    },
    {
      id: 'starter-selection-species-id',
      title: 'Selection Species ID & Log Proposal',
      description:
        'Analyzes the active selection box with DSP metrics + Gemini and proposes structured log annotations.',
      scope: 'selection',
      pinToTools: true,
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
      parameters: [
        {
          name: 'taxa_focus',
          label: 'Taxonomic Group Hint',
          type: 'string',
          defaultValue: 'Avian / bioacoustic calls',
        },
      ],
      cells: [
        {
          id: 'id-py-1',
          kind: 'python',
          title: 'Extract Selection Contour & Band Metrics',
          enabled: true,
          source: `import numpy as np
import matplotlib.pyplot as plt

ctx = syrinx.context
sel = ctx["selection"] or ctx["viewRange"]
spec = syrinx.spectrogram(
    channel=ctx["channel"],
    start_sec=sel["startSec"],
    end_sec=sel["endSec"],
)
S = spec["data"]
freqs = np.linspace(spec["minFreqHz"], spec["maxFreqHz"], S.shape[1])
times = np.linspace(spec["startSec"], spec["endSec"], S.shape[0])

fig, ax = plt.subplots(figsize=(7.5, 3.0), dpi=130)
ax.imshow(S.T, origin="lower", aspect="auto", extent=[times[0], times[-1], freqs[0]/1000, freqs[-1]/1000], cmap="magma")
ax.set_xlabel("Time (s)")
ax.set_ylabel("Frequency (kHz)")
ax.set_title("Focused Selection Spectrogram")
syrinx.emit_figure(fig, "Selection Time-Frequency Contour")`,
        },
        {
          id: 'id-ai-1',
          kind: 'ai',
          title: 'Identify Candidate Species & Propose Log Entry',
          enabled: true,
          source: `Focus on the active selection (or current view if no selection box is active). Taxonomic context: "{{taxa_focus}}".
Analyze modulation shape, harmonics, bandwidth, peak frequency, and duration from the spectrogram and metrics.
Provide:
- Candidate species or call-class hypotheses with acoustic rationale and confidence.
- A <syrinx_notebook_actions> block proposing a refined annotation log entry with concise label and diagnostic notes.`,
        },
      ],
    },
    {
      id: 'starter-array-localization-prep',
      title: 'Multi-Channel Array Check & TDOA Prep',
      description:
        'Compares energy and peak SNR across stacked array channels and guides cross-channel localization.',
      scope: 'recording',
      pinToTools: true,
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
      parameters: [
        {
          name: 'speed_of_sound_mps',
          label: 'Speed of Sound (m/s)',
          type: 'number',
          defaultValue: 343,
        },
      ],
      cells: [
        {
          id: 'arr-py-1',
          kind: 'python',
          title: 'Compare Channel RMS & Cross-Correlation Lag',
          enabled: true,
          source: `import numpy as np
import matplotlib.pyplot as plt

ctx = syrinx.context
n_ch = int(ctx["numChannels"])
rms_by_ch = []
for ch in range(n_ch):
    wav = syrinx.audio(channel=ch)
    rms_by_ch.append(float(np.sqrt(np.mean(np.square(wav)))))

fig, ax = plt.subplots(figsize=(7.0, 2.6), dpi=130)
ax.bar([f"Ch {i+1}" for i in range(n_ch)], rms_by_ch, color="#38bdf8")
ax.set_ylabel("RMS Amplitude")
ax.set_title("Multi-Channel Array Level Balance")
syrinx.emit_figure(fig, "Channel RMS Comparison")
syrinx.set_var("channel_rms", rms_by_ch)
print("Channel RMS:", [round(x, 5) for x in rms_by_ch])`,
        },
        {
          id: 'arr-ai-1',
          kind: 'ai',
          title: 'Gemini Array Quality & Localization Assessment',
          enabled: true,
          source: `Review the multi-channel RMS profile, channel metrics, and spectrogram (speed of sound = {{speed_of_sound_mps}} m/s).
Assess:
1. Whether all array channels are healthy or any channel has gain mismatch / clipping / drop-out.
2. Which channel has the clearest SNR for primary species classification.
3. Concrete localization steps (TDOA cross-correlation window & bandpass range) for the detected vocalizations.`,
        },
      ],
    },
  ];
}
