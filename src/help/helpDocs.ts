export type HelpDocId = 'overview' | 'subsystems' | 'setup';

export interface HelpDocument {
  id: HelpDocId;
  title: string;
  shortTitle: string;
  subtitle: string;
  markdown: string;
}

export function getHelpDocIdFromUrl(): HelpDocId | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('help');
  if (raw === 'overview' || raw === 'subsystems' || raw === 'setup') {
    return raw;
  }
  return null;
}

export const HELP_DOCUMENTS: HelpDocument[] = [
  {
    id: 'overview',
    title: 'SyrinxOne Overview & Quick Start',
    shortTitle: '1. Overview',
    subtitle: 'What SyrinxOne is, core workflow, workspace views, and shortcuts.',
    markdown: `# SyrinxOne Overview

**SyrinxOne** is a bioacoustics inspection, annotation, and analytic notebook workstation inspired by classic Syrinx-PC. It brings together real-time spectrogram rendering, multi-source cloud and local archive browsing, rapid event logging, multimodal **Gemini AI** interpretation, and **Python + AI analytic notebooks**.

---

## Core Workflow

1. **Choose a Data Source (\`Source\`)** — Connect local folders (desktop sidecar), public cloud bioacoustic archives (AWS S3 / GCS / HTTP), or your personal **Google Drive**.
2. **Open Recordings (\`Recordings\`)** — Browse folders, inspect archive READMEs (\`About\`), and open single files or time-aligned combined streams in the MDI workspace.
3. **Inspect & Tune Spectrograms** — Pan, zoom, drag time-frequency selections, stack multi-channel recordings, and adjust FFT size, hop size, colormap, gain, and floor.
4. **Play, Measure & Annotate** — Listen at \`0.25×\`–\`2.0×\` speed, view calibrated band measurements, run automated sound detection, or stamp labeled annotations with single-key hotkeys.
5. **Analyze with AI & Notebooks** — Ask the **AI Explorer** about your active view, or build and pin Python + Gemini **Analytic Notebooks** inside the **Tools** menu for repeatable scripts.

---

## Desktop & Mobile Workspaces

- **Desktop**: Multi-Document Interface (MDI) spectrogram canvas paired with toggleable **Settings & Measurements**, **AI Explorer**, and **Annotation Drawer** panels, plus a dedicated **Notebooks** view (or separate browser tab via \`?view=notebook\`).
- **Mobile**: Clean 4-tab swipeable workspace across the top bar:
  - **Settings** — Spectrogram DSP controls and acoustic measurements.
  - **Spectrogram** — Touch zoom/pan/selection canvas and timeline scrubber.
  - **AI** — Multimodal Gemini bioacoustic assistant.
  - **Notebooks** — Single-pane mobile editor switcher (**Notebooks** / **Cells** / **Copilot**).

---

## Essential Keyboard & Mouse Shortcuts

| Action | Shortcut |
| --- | --- |
| Play / Stop active view or selection | \`Space\` or \`P\` |
| Log active selection to annotation table | \`Enter\` |
| Stamp selection with custom label hotkey | Mapped character key (\`Hotkeys\`) |
| Step to previous / next annotation | \`ArrowLeft\` / \`ArrowRight\` |
| Delete selected annotation | \`Delete\` |
| Auto-adjust Gain & Floor to view or selection | \`Alt + A\` |
| Nudge Gain up / down | \`Alt + ArrowUp\` / \`Alt + ArrowDown\` |
| Nudge Floor up / down | \`Alt + Shift + ArrowUp\` / \`Alt + Shift + ArrowDown\` |
| Previous / Next recording in folder | \`Alt + ArrowLeft\` / \`Alt + ArrowRight\` |
| Toggle relative vs. wall-clock timescale | \`Alt + T\` |
| Clip & save active selection (\`Clip\`) | \`Ctrl + K\` |
| Jump to specific timestamp | \`Ctrl + G\` |
| Reset full spectrogram zoom | \`Ctrl + 0\` |

---

## Related Guides

- Next: [2. Subsystems & Features](?help=subsystems)
- Setup: [3. Capabilities & Setup Guide](?help=setup)`,
  },
  {
    id: 'subsystems',
    title: 'Subsystems & Features Guide',
    shortTitle: '2. Subsystems',
    subtitle: 'Architecture and features of every SyrinxOne module.',
    markdown: `# Subsystems & Features

SyrinxOne is organized into seven cooperating subsystems that share live recording state, selections, and annotation tables.

---

## 1. Data Sources & Archive Browser

- **Unified Source Selector (\`Source\`)**: Switch between the local desktop filesystem, anonymous public S3/GCS/HTTP bioacoustic buckets (such as MBARI Pacific Sound and NOAA NCEI presets), and **Google Drive**.
- **Archive Documentation (\`About\`)**: Automatically scans archive roots and current folders for \`README\`, Markdown, text, and PDF files and links official dataset portals.
- **Large & Combined Streams (\`Recordings\`)**: Supports long archive files via windowed loading (\`ArchiveTimelineBar\`) and lets you combine contiguous or multi-channel recordings into a single synchronized timeline.

---

## 2. MDI Spectrogram Workspace & DSP Controls

- **Multi-Window Layouts**: Open multiple recordings side by side with \`Grid\`, \`Tile Horizontal\`, \`Tile Vertical\`, \`Cascade\`, \`Match\`, and titlebar toggles.
- **DSP Parameters**: Configure FFT size, hop size / overlap, window function (\`Hann\`, \`Hamming\`, \`Blackman\`), frequency bounds, DSP power mode, and colormaps inside the **Settings** panel.
- **Multi-Channel Stacking**: Toggle stacked channel rendering for array or hydrophone recordings while preserving per-channel waveforms and selections.
- **Display Persistence & Export**: Save/load complete multi-window workspace layouts (\`.json\`), or copy/download clean PNG spectrogram renders (\`Copy PNG\`).

---

## 3. WebAudio Playback, Detection & Annotations

- **WebAudio Player**: Stream active viewports or frequency-bounded selections with variable playback rate (\`0.25×\`–\`2.0×\`) and loop mode.
- **Measurements & Detector (\`Detect\`)**: Inspect real-time acoustic metrics (duration, low/high/peak/centroid Hz, \`Q5\`/\`Q50\`/\`Q95\` bandwidth, RMS/peak/noise-floor/SNR dB) or run automated threshold-based sound event detection.
- **Annotation Drawer & Hotkeys (\`Hotkeys\`)**: Configure single-key species/call stamps, navigate selections, edit comments/notes, and export structured annotation tables.
- **Audio Clipping (\`Clip\`)**: Extract and save trimmed audio clips from the active time selection.

---

## 4. AI Bioacoustic Explorer

- Located in the **AI Explorer** panel (or **AI** swipe tab on mobile).
- Attaches live spectrogram PNG renders, active spectral/waveform summaries, selection measurements, and matching annotations to **Gemini** requests.
- Supports interactive tool-calling rounds where Gemini can propose candidate annotations for user review, suggest display adjustments, or summarize acoustic activity grounded strictly in computed metrics.

---

## 5. Analytic Notebooks & Python Kernel

- Open from the **Notebooks** toolbar button, the **Notebooks** mobile tab, or **Open in Separate Tab** (\`?view=notebook\`).
- **Three Cell Types**:
  - **Python** — Runs in a persistent per-notebook Python 3 worker with injected \`syrinx\` SDK helpers (\`syrinx.context\`, \`syrinx.measurements()\`, \`syrinx.detect()\`, \`syrinx.spectrogram()\`, \`syrinx.emit_figure()\`, \`syrinx.propose_annotation()\`, \`syrinx.set_var()\`). Automatically falls back to client DSP cache diagnostic plots if a plotting package is unavailable locally.
  - **AI Prompt** — Sends custom natural-language instructions plus prior Python variables, stdout, figures, and live spectrogram PNGs to Gemini, returning structured Markdown and optional proposed annotations.
  - **Markdown** — Parameterized scientific notes with \`{{variable}}\` template interpolation.
- **Jupyter Compatibility**: Import and export standard \`.ipynb\` notebook files.

---

## 6. Gemini Notebook Copilot & Cell Assist

- **Side Copilot Pane**: Describe an analysis goal in plain English to generate sequences of Python + AI cells ready to append into your notebook.
- **Inline Cell Repair & Improvement**: Failed cells display **Fix with Gemini**, and every cell's \`⋮\` menu offers **Improve with Gemini** with a one-click diff preview (**Apply to Cell** or **Insert Below**).

---

## 7. User Tools Menu & Multi-Tab Sync

- **Pin to Tools Menu**: Mark any notebook as a reusable script tool with custom **Target Scope** (\`selection\`, \`view\`, \`recording\`, \`folder\`) and editable runtime **Parameters**.
- **Headless Report Runner (\`Tools\`)**: Execute pinned notebooks from the main Spectrogram view in a clean **Script Output Modal** showing step progress, figures, and proposed annotations ready to commit to your log.
- **Multi-Tab \`BroadcastChannel\` Sync**: When a notebook is opened in its own browser tab (\`?view=notebook\`), recording context, selections, and committed annotations stay synchronized with the main Spectrogram tab automatically.

---

## Related Guides

- Back: [1. Overview & Quick Start](?help=overview)
- Setup: [3. Capabilities & Setup Guide](?help=setup)`,
  },
  {
    id: 'setup',
    title: 'Capabilities & Setup Guide',
    shortTitle: '3. Setup',
    subtitle: 'How to configure Gemini AI, Python DSP Engine, Kernels, Drive OAuth & Sources.',
    markdown: `# Capabilities & Setup Guide

SyrinxOne splits lightweight UI hosting (Vite + Express) from heavy scientific DSP, cloud archive streaming, and Gemini AI endpoints. Use this guide to configure each capability cleanly.

---

## 1. Gemini AI Capabilities (\`GEMINI_API_KEY\`)

Gemini powers three features in SyrinxOne:
- **AI Bioacoustic Explorer** (\`/api/local/ai/*\`)
- **Notebook AI Prompt Cells** (\`/api/local/ai/notebook-cell\`)
- **Notebook Copilot & Inline Cell Fix/Improve** (\`/api/local/ai/notebook-copilot\`)

### Setup Steps
1. Obtain a Gemini API key from Google AI Studio.
2. Configure \`GEMINI_API_KEY\` in your server environment:
   - In **AI Studio / Cloud Hosting**: Add \`GEMINI_API_KEY\` under **Settings > Secrets** (or Cloud Run environment variables).
   - In **Local Development**: Copy \`.env.example\` to \`.env\` and set:
     \`\`\`bash
     GEMINI_API_KEY=your_api_key_here
     \`\`\`
3. Restart the dev/Node server if adding the secret outside hot config reload.

### Security & Model Notes
- **Server-side only**: \`GEMINI_API_KEY\` is read strictly on the Express backend and is never sent to browser clients.
- **Subprocess isolation**: Python notebook kernel subprocesses are spawned with a stripped environment that explicitly excludes \`GEMINI_API_KEY\`.
- **Selectable Models**: \`gemini-4-hydrogen\` (default), \`gemini-4-neon\`, and \`gemini-3.1-flash-lite\`.

---

## 2. Python DSP Engine (\`VITE_API_URL\`)

The external Python DSP Engine provides fast FFT spectrograms, WAV/FLAC streaming, sound detection, acoustic measurements, and S3/GCS archive browsing.

### Ways to Connect
- **Default Build / Env Var**: Set \`VITE_API_URL\` in \`.env\` before starting or building:
  \`\`\`bash
  VITE_API_URL=https://syrinx-engine-466330924576.us-west1.run.app
  \`\`\`
- **Runtime Switcher**: Click the **S1** badge (green/red status dot) at the top-left of the toolbar to enter any Cloud Run or local engine URL (plus optional Bearer token) without rebuilding.
- **URL Override**: Append \`?api=https://your-engine-url\` to the browser URL on load.

---

## 3. Python Notebook Kernel Setup

SyrinxOne uses a 3-tier execution strategy for Python notebook cells:

1. **Remote Scientific Kernel (\`{VITE_API_URL}/api/python/kernel/exec\`)** — If your connected DSP Engine exposes a scientific Python kernel endpoint with \`numpy\`, \`scipy\`, and \`matplotlib\`, SyrinxOne routes Python cells there first.
2. **Local Persistent Python 3 Kernel (\`/api/local/python/kernel/exec\`)** — Built into \`server.ts\` via \`python3\`. Preserves variables across cells per notebook and exposes \`syrinx.context\`, \`syrinx.measurements()\`, \`syrinx.detect()\`, \`syrinx.spectrogram()\`, \`syrinx.emit_figure()\`, and \`syrinx.propose_annotation()\`.
3. **DSP Cache Preview Fallback** — If a local container lacks \`numpy\`/\`scipy\`/\`matplotlib\` and no remote kernel is active, cells referencing scientific plotting packages automatically synthesize diagnostic figures from cached workspace DSP matrices so notebooks remain immediately usable.

### Installing Full Scientific Libraries Locally
If self-hosting on a VM or workstation where you control Python 3, install scientific packages in the environment running \`python3\`:
\`\`\`bash
pip install numpy scipy matplotlib
\`\`\`
Use **Restart Python Kernel** inside the notebook \`⋮\` menu after installing packages to pick them up immediately.

---

## 4. Google Drive OAuth Integration

SyrinxOne supports browsing private Google Drive folders and opening audio files or READMEs directly in the browser using **in-memory-only OAuth tokens**.

### Setup Steps
1. Ensure Firebase Authentication with the **Google** provider is enabled in your project (\`firebase-applet-config.json\`).
2. In **Google Cloud Console > OAuth Consent Screen**, make sure the \`https://www.googleapis.com/auth/drive.readonly\` scope is permitted for your app.
3. Click **Sign in with Google** in the top-right toolbar (or inside **Source** / mobile \`···\` menu).
4. Once signed in, choose **Google Drive** in \`Source\` -> \`Recordings\` to browse folders and load recordings.

*(Note: Access tokens stay strictly in JavaScript memory and are never saved to \`localStorage\`; after a full page reload, click **Reconnect Google** to refresh your Drive session.)*

---

## 5. Connecting Public Cloud & HTTP Archives

- Click **Source** in the top-left toolbar to connect:
  - **Built-in Bioacoustic Presets** (e.g. MBARI Pacific Sound, NOAA passive acoustic archives).
  - **Custom AWS S3 / Google Cloud Storage Buckets** (anonymous public buckets via \`s3://bucket/prefix\` or \`gs://bucket/prefix\`).
  - **HTTP/HTTPS Archive Indexes**.
- Click **About** beside any source to inspect discovered \`README.md\`/PDF docs and external documentation portals before loading recordings.

---

## Related Guides

- Start here: [1. Overview & Quick Start](?help=overview)
- Explore modules: [2. Subsystems & Features](?help=subsystems)`,
  },
];

export function getHelpDocument(id: HelpDocId): HelpDocument {
  return HELP_DOCUMENTS.find((d) => d.id === id) ?? HELP_DOCUMENTS[0];
}
