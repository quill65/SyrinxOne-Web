import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionDeclaration,
  type Part,
} from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const ALLOWED_MODELS = new Set([
  'gemini-4-hydrogen',
  'gemini-4-neon',
  'gemini-3.1-flash-lite',
]);

const MAX_TOOL_ROUNDS = 6;
const SESSION_TTL_MS = 5 * 60 * 1000;

interface PendingSession {
  model: string;
  systemInstruction: string;
  contents: Content[];
  round: number;
  createdAt: number;
}

const pendingSessions = new Map<string, PendingSession>();

function sweepExpiredSessions(): void {
  const now = Date.now();
  for (const [id, sess] of pendingSessions.entries()) {
    if (now - sess.createdAt > SESSION_TTL_MS) {
      pendingSessions.delete(id);
    }
  }
}

interface MeasurementsPayload {
  durationSec?: number;
  lowFreqHz?: number;
  highFreqHz?: number;
  bandwidthHz?: number;
  peakFreqHz?: number;
  centroidFreqHz?: number;
  q5FreqHz?: number;
  q50FreqHz?: number;
  q95FreqHz?: number;
  bw90Hz?: number;
  timeOfPeakSec?: number;
  rmsDb?: number;
  peakDb?: number;
  noiseFloorDb?: number;
  snrDb?: number;
}

interface AnnotationPayload {
  soundfile?: string;
  channel?: number;
  startTimeSec?: number;
  endTimeSec?: number;
  lowFreqHz?: number;
  highFreqHz?: number;
  comment?: string;
  notes?: string;
}

interface AcousticProfilePayload {
  spectrogramSummary?: {
    durationSec?: number;
    minFreqHz?: number;
    maxFreqHz?: number;
    dspMode?: string;
    minVal?: number;
    maxVal?: number;
    noiseFloorP20?: number;
    medianVal?: number;
    p95Val?: number;
    activeCellPct?: number;
    globalPeakTimeSec?: number;
    globalPeakFreqHz?: number;
    temporalProfile?: Array<{
      startSec: number;
      endSec: number;
      meanDb: number;
      peakDb: number;
      peakFreqHz: number;
      centroidFreqHz: number;
      activePct: number;
    }>;
    spectralBands?: Array<{
      lowFreqHz: number;
      highFreqHz: number;
      meanDb: number;
      peakDb: number;
      floorP20Db: number;
      peakTimeSec: number;
    }>;
    topEvents?: Array<{
      timeSec: number;
      freqHz: number;
      peakDb: number;
    }>;
  } | null;
  waveformSummary?: {
    durationSec?: number;
    peakAbs?: number;
    rmsApprox?: number;
    loudestSliceStartSec?: number;
    quietestSliceStartSec?: number;
    segments?: Array<{
      startSec: number;
      endSec: number;
      peakAbs: number;
      rmsApprox: number;
    }>;
  } | null;
}

interface SourceContextPayload {
  activeSource?: {
    sourceId?: string;
    displayName?: string;
    kind?: string;
    rootPath?: string;
    description?: string;
  } | null;
  allSources?: Array<{
    sourceId?: string;
    displayName?: string;
    kind?: string;
    rootPath?: string;
    description?: string;
  }>;
  siblingPrefix?: string;
  siblingEntries?: Array<{
    name?: string;
    uri?: string;
    isDir?: boolean;
    sizeBytes?: number;
    kind?: string;
  }>;
  otherOpenWindows?: Array<{
    windowId?: string;
    fileId?: string;
    name?: string;
    sourceId?: string;
    uri?: string;
    sampleRate?: number;
    numChannels?: number;
    durationSec?: number;
    isPartialWindow?: boolean;
    windowStartSec?: number;
    totalDurationSec?: number;
    viewRange?: {
      startSec?: number;
      endSec?: number;
      minFreqHz?: number;
      maxFreqHz?: number;
    };
    selection?: {
      startSec?: number;
      endSec?: number;
      lowFreqHz?: number;
      highFreqHz?: number;
    } | null;
    summary?: AcousticProfilePayload['spectrogramSummary'];
  }>;
}

interface ToolResultItem {
  id?: string;
  name: string;
  response: Record<string, unknown>;
  imageBase64?: string;
  imageLabel?: string;
}

interface AnalyzeBody {
  sessionId?: string;
  toolResults?: ToolResultItem[];
  enableTools?: boolean;
  prompt?: string;
  model?: string;
  history?: Array<{ role?: string; content?: string }>;
  fileInfo?: {
    fileId?: string;
    sourceId?: string;
    uri?: string;
    name?: string;
    sampleRate?: number;
    durationSec?: number;
    numChannels?: number;
    numFrames?: number;
    format?: string;
    subtype?: string;
    startDateTimeIso?: string | null;
    isPartialWindow?: boolean;
    windowStartSec?: number;
    totalDurationSec?: number;
    isCombined?: boolean;
    combinedSegmentCount?: number;
    combinedSegments?: Array<{
      index?: number;
      name?: string;
      folderName?: string;
      uri?: string;
      timelineStartSec?: number;
      timelineEndSec?: number;
      durationSec?: number;
    }>;
  };
  specParams?: {
    channel?: number;
    fftSize?: number;
    hopSize?: number;
    windowType?: string;
    dspMode?: string;
    popFilter?: boolean;
  };
  selection?: {
    startSec?: number;
    endSec?: number;
    lowFreqHz?: number;
    highFreqHz?: number;
  };
  viewRange?: {
    startSec?: number;
    endSec?: number;
    minFreqHz?: number;
    maxFreqHz?: number;
  };
  measurements?: MeasurementsPayload;
  fullRecordingMeasurements?: MeasurementsPayload;
  channelMeasurements?: Array<{
    channel: number;
    measurements: MeasurementsPayload;
  }>;
  acousticProfile?: AcousticProfilePayload;
  sourceContext?: SourceContextPayload;
  annotations?: AnnotationPayload[];
  allWorkspaceAnnotations?: AnnotationPayload[];
  spectrogramImageBase64?: string;
  fullSpectrogramImageBase64?: string;
}

const SOUND_SOURCE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'browse_sound_source',
    description:
      'List folders, audio recordings, and annotation files in any connected acoustic data source (local filesystem, S3, GCS, Google Drive, HTTP). Use this to discover additional files or subdirectories in a sound source.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        sourceId: {
          type: Type.STRING,
          description: 'ID of the data source (e.g. from allSources or fileInfo.sourceId).',
        },
        prefix: {
          type: Type.STRING,
          description: 'Folder path or cloud prefix to browse (omit or empty string for root).',
        },
        limit: {
          type: Type.INTEGER,
          description: 'Maximum entries to return (default 500, max 1000).',
        },
      },
      required: ['sourceId'],
    },
  },
  {
    name: 'inspect_recording_region',
    description:
      'Run Python DSP spectral & amplitude measurements on ANY time/frequency region (0..totalDurationSec) or channel of an opened single or combined recording—automatically using sparse spectral-line sampling on wide multi-hour/multi-day intervals and full-resolution STFT on focused regions—and optionally fetch its spectrogram PNG and spectral summary.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        fileId: {
          type: Type.STRING,
          description: 'Engine fileId of an open or previously inspected recording.',
        },
        channel: {
          type: Type.INTEGER,
          description: '0-based audio channel index (default 0).',
        },
        startSec: {
          type: Type.NUMBER,
          description: 'Start time in seconds within the complete recording (0..totalDurationSec).',
        },
        endSec: {
          type: Type.NUMBER,
          description: 'End time in seconds within the complete recording (0..totalDurationSec).',
        },
        lowFreqHz: {
          type: Type.NUMBER,
          description: 'Lower frequency bound in Hz (default 0).',
        },
        highFreqHz: {
          type: Type.NUMBER,
          description: 'Upper frequency bound in Hz (defaults to Nyquist).',
        },
        includeImage: {
          type: Type.BOOLEAN,
          description: 'Whether to also capture a PNG spectrogram of this region.',
        },
      },
      required: ['fileId', 'startSec', 'endSec'],
    },
  },
  {
    name: 'inspect_source_file',
    description:
      'Open and analyze ANY other audio recording in a sound source, OR open a different time window (startSec, maxDurationSec) of a large partial archive recording (when totalDurationSec > durationSec). Returns metadata, full-window Python DSP measurements, temporal/spectral spectrogram summaries, waveform envelope, and optionally a spectrogram PNG.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        sourceId: {
          type: Type.STRING,
          description: 'Data source ID containing the file.',
        },
        uri: {
          type: Type.STRING,
          description: 'File URI/path inside that sound source.',
        },
        startSec: {
          type: Type.NUMBER,
          description: 'Optional start offset in seconds for inspecting a specific slice of a long archive file.',
        },
        maxDurationSec: {
          type: Type.NUMBER,
          description: 'Optional max duration in seconds to load (e.g. 60s window for large cloud WAVs).',
        },
        channel: {
          type: Type.INTEGER,
          description: '0-based channel index to analyze (default 0).',
        },
        includeImage: {
          type: Type.BOOLEAN,
          description: 'Whether to capture a full-window spectrogram PNG (default true).',
        },
      },
      required: ['sourceId', 'uri'],
    },
  },
  {
    name: 'detect_sound_events',
    description:
      'Run automated energy/band acoustic event detection across a loaded recording to count events, measure noise floor, and list event timestamps.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        fileId: {
          type: Type.STRING,
          description: 'Engine fileId to scan for acoustic events.',
        },
        channel: {
          type: Type.INTEGER,
          description: '0-based channel index (default 0).',
        },
        minFreqHz: {
          type: Type.NUMBER,
          description: 'Minimum frequency bound in Hz.',
        },
        maxFreqHz: {
          type: Type.NUMBER,
          description: 'Maximum frequency bound in Hz.',
        },
        triggerThresholdDb: {
          type: Type.NUMBER,
          description: 'Detection threshold in dB relative to noise floor (typically 6 to 20).',
        },
        minSoundDurSec: {
          type: Type.NUMBER,
          description: 'Minimum event duration in seconds (e.g. 0.05).',
        },
        maxSilenceGapSec: {
          type: Type.NUMBER,
          description: 'Maximum gap in seconds before splitting events (e.g. 0.25).',
        },
        startSec: {
          type: Type.NUMBER,
          description: 'Optional scan start time in seconds.',
        },
        endSec: {
          type: Type.NUMBER,
          description: 'Optional scan end time in seconds.',
        },
      },
      required: ['fileId', 'minFreqHz', 'maxFreqHz'],
    },
  },
];

function formatMeasurementsLine(label: string, m: MeasurementsPayload): string {
  return `${label}: duration=${m.durationSec?.toFixed(3) ?? '?'}s, freqRange=${Math.round(m.lowFreqHz ?? 0)}–${Math.round(m.highFreqHz ?? 0)}Hz, peakFreq=${m.peakFreqHz?.toFixed(1) ?? '?'}Hz (at ${m.timeOfPeakSec?.toFixed(3) ?? '?'}s), centroid=${m.centroidFreqHz?.toFixed(1) ?? '?'}Hz, Q5=${m.q5FreqHz?.toFixed(1) ?? '?'}Hz, Q50=${m.q50FreqHz?.toFixed(1) ?? '?'}Hz, Q95=${m.q95FreqHz?.toFixed(1) ?? '?'}Hz, BW90=${m.bw90Hz?.toFixed(1) ?? '?'}Hz, RMS=${m.rmsDb?.toFixed(1) ?? '?'}dB, Peak=${m.peakDb?.toFixed(1) ?? '?'}dB, NoiseFloor=${m.noiseFloorDb?.toFixed(1) ?? '?'}dB, SNR=${m.snrDb?.toFixed(1) ?? '?'}dB`;
}

function isValidBase64Png(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length < 8_000_000 && /^[A-Za-z0-9+/=]+$/.test(s);
}

function extractActionsFromText(rawText: string): {
  answer: string;
  suggestedLabels: string[];
  suggestedDetectParams?: Record<string, unknown>;
} {
  let text = (rawText ?? '').trim();
  let suggestedLabels: string[] = [];
  let suggestedDetectParams: Record<string, unknown> | undefined;

  const actionMatch = text.match(/<syrinx_actions>\s*([\s\S]*?)\s*<\/syrinx_actions>/i);
  if (actionMatch) {
    text = text.replace(actionMatch[0], '').trim();
    try {
      const parsed = JSON.parse(actionMatch[1]) as {
        suggestedLabels?: unknown;
        suggestedDetectParams?: unknown;
      };
      if (Array.isArray(parsed.suggestedLabels)) {
        suggestedLabels = parsed.suggestedLabels
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .slice(0, 5);
      }
      if (
        parsed.suggestedDetectParams &&
        typeof parsed.suggestedDetectParams === 'object' &&
        !Array.isArray(parsed.suggestedDetectParams)
      ) {
        const dp = parsed.suggestedDetectParams as Record<string, unknown>;
        if (typeof dp.minFreqHz === 'number' && typeof dp.maxFreqHz === 'number') {
          suggestedDetectParams = dp;
        }
      }
    } catch {
      // ignore malformed optional action JSON block
    }
  }

  return {
    answer: text || 'No analysis returned.',
    suggestedLabels,
    suggestedDetectParams,
  };
}

function buildInitialParts(body: AnalyzeBody): Part[] {
  const contextLines: string[] = [];

  if (body.fileInfo) {
    const f = body.fileInfo;
    const partialText = f.isPartialWindow
      ? ` | PARTIAL ARCHIVE WINDOW: ${f.windowStartSec?.toFixed(1) ?? 0}s–${((f.windowStartSec ?? 0) + (f.durationSec ?? 0)).toFixed(1)}s out of ${f.totalDurationSec?.toFixed(1) ?? '?'}s total archive duration`
      : '';
    const combinedTag = f.isCombined
      ? ` | COMBINED ARCHIVE (${f.combinedSegmentCount ?? f.combinedSegments?.length ?? '?'} contiguous segments)`
      : '';
    contextLines.push(
      `Active Recording: name="${f.name ?? 'unknown'}" | fileId="${f.fileId ?? ''}" | sourceId="${f.sourceId ?? ''}" | uri="${f.uri ?? ''}" | format=${f.format ?? '?'}/${f.subtype ?? '?'} | sampleRate=${f.sampleRate ?? '?'} Hz | Nyquist=${f.sampleRate ? Math.round(f.sampleRate / 2) : '?'} Hz | loadedDuration=${f.durationSec?.toFixed(2) ?? '?'} s | channels=${f.numChannels ?? '?'} | frames=${f.numFrames ?? '?'}${f.startDateTimeIso ? ` | startISO=${f.startDateTimeIso}` : ''}${partialText}${combinedTag}`,
    );
    if (f.isCombined && Array.isArray(f.combinedSegments) && f.combinedSegments.length > 0) {
      contextLines.push(
        `Combined Archive Segments (showing ${f.combinedSegments.length} of ${f.combinedSegmentCount ?? f.combinedSegments.length}):\n` +
          f.combinedSegments
            .map(
              (seg) =>
                `  [${seg.index ?? '?'}] ${seg.folderName ? `${seg.folderName}/` : ''}${seg.name ?? seg.uri ?? '?'} | timeline=${seg.timelineStartSec?.toFixed(1) ?? '?'}–${seg.timelineEndSec?.toFixed(1) ?? '?'}s (${seg.durationSec?.toFixed(1) ?? '?'}s) | uri="${seg.uri ?? ''}"`,
            )
            .join('\n'),
      );
    }
  }

  if (body.specParams) {
    const sp = body.specParams;
    contextLines.push(
      `Active Spectrogram Settings: channel=${sp.channel ?? 0}, fftSize=${sp.fftSize ?? '?'}, hopSize=${sp.hopSize ?? '?'}, window=${sp.windowType ?? '?'}, dspMode=${sp.dspMode ?? '?'}, popFilter=${Boolean(sp.popFilter)}`,
    );
  }

  if (body.selection) {
    contextLines.push(
      `Active Selection Box: ${body.selection.startSec?.toFixed(3)}s to ${body.selection.endSec?.toFixed(3)}s, ${Math.round(body.selection.lowFreqHz ?? 0)}–${Math.round(body.selection.highFreqHz ?? 0)} Hz`,
    );
  }
  if (body.viewRange) {
    contextLines.push(
      `Active Viewport: ${body.viewRange.startSec?.toFixed(2)}s to ${body.viewRange.endSec?.toFixed(2)}s, ${Math.round(body.viewRange.minFreqHz ?? 0)}–${Math.round(body.viewRange.maxFreqHz ?? 0)} Hz`,
    );
  }

  if (body.measurements) {
    contextLines.push(
      formatMeasurementsLine(
        body.selection ? 'Focused Selection Python DSP Measurements' : 'Viewport Python DSP Measurements',
        body.measurements,
      ),
    );
  }

  if (body.fullRecordingMeasurements) {
    contextLines.push(
      formatMeasurementsLine(
        'Full Loaded Recording Python DSP Measurements (0..duration, 0..Nyquist)',
        body.fullRecordingMeasurements,
      ),
    );
  }

  if (Array.isArray(body.channelMeasurements) && body.channelMeasurements.length > 0) {
    const chLines = body.channelMeasurements.map((cm) =>
      formatMeasurementsLine(`Other Channel ${cm.channel} Full-Recording DSP`, cm.measurements),
    );
    contextLines.push(`Additional Channels:\n${chLines.join('\n')}`);
  }

  if (body.acousticProfile?.spectrogramSummary) {
    const ss = body.acousticProfile.spectrogramSummary;
    const lines: string[] = [
      `Full-Recording Spectrogram Matrix Profile (${ss.durationSec ?? '?'}s, ${ss.minFreqHz ?? 0}–${ss.maxFreqHz ?? '?'} Hz, mode=${ss.dspMode ?? '?'}): min=${ss.minVal} dB, p20NoiseFloor=${ss.noiseFloorP20} dB, median=${ss.medianVal} dB, p95=${ss.p95Val} dB, max=${ss.maxVal} dB (global peak at ${ss.globalPeakTimeSec}s, ${ss.globalPeakFreqHz} Hz), activeCells=${ss.activeCellPct}%`,
    ];
    if (Array.isArray(ss.spectralBands) && ss.spectralBands.length > 0) {
      lines.push(
        `Frequency Band Breakdown (full recording):\n` +
          ss.spectralBands
            .map(
              (b) =>
                `  ${Math.round(b.lowFreqHz)}–${Math.round(b.highFreqHz)} Hz: mean=${b.meanDb} dB, peak=${b.peakDb} dB (at ${b.peakTimeSec}s), floorP20=${b.floorP20Db} dB`,
            )
            .join('\n'),
      );
    }
    if (Array.isArray(ss.temporalProfile) && ss.temporalProfile.length > 0) {
      lines.push(
        `Temporal Timeline Slices (full recording):\n` +
          ss.temporalProfile
            .map(
              (t) =>
                `  ${t.startSec.toFixed(2)}–${t.endSec.toFixed(2)}s: mean=${t.meanDb} dB, peak=${t.peakDb} dB @ ${Math.round(t.peakFreqHz)} Hz, centroid=${Math.round(t.centroidFreqHz)} Hz, active=${t.activePct}%`,
            )
            .join('\n'),
      );
    }
    if (Array.isArray(ss.topEvents) && ss.topEvents.length > 0) {
      lines.push(
        `Prominent Peak Events Across Recording: ` +
          ss.topEvents.map((e) => `${e.timeSec.toFixed(2)}s @ ${Math.round(e.freqHz)} Hz (${e.peakDb} dB)`).join('; '),
      );
    }
    contextLines.push(lines.join('\n'));
  }

  if (body.acousticProfile?.waveformSummary) {
    const ws = body.acousticProfile.waveformSummary;
    const segText = Array.isArray(ws.segments)
      ? ws.segments
          .map((s) => `${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}s(pk=${s.peakAbs},rms=${s.rmsApprox})`)
          .join(', ')
      : '';
    contextLines.push(
      `Waveform Envelope (full recording): peakAbs=${ws.peakAbs}, rmsApprox=${ws.rmsApprox}, loudestAt=${ws.loudestSliceStartSec}s, quietestAt=${ws.quietestSliceStartSec}s | Segments: ${segText}`,
    );
  }

  if (body.sourceContext) {
    const sc = body.sourceContext;
    if (sc.activeSource) {
      contextLines.push(
        `Active Sound Source: id="${sc.activeSource.sourceId ?? ''}", name="${sc.activeSource.displayName ?? ''}", kind=${sc.activeSource.kind ?? '?'}${sc.activeSource.rootPath ? `, root="${sc.activeSource.rootPath}"` : ''}${sc.activeSource.description ? `, desc="${sc.activeSource.description}"` : ''}`,
      );
    }
    if (Array.isArray(sc.allSources) && sc.allSources.length > 0) {
      contextLines.push(
        `Connected Sound Sources (${sc.allSources.length}): ` +
          sc.allSources
            .map((s) => `${s.sourceId} ("${s.displayName}", ${s.kind}${s.rootPath ? `, root=${s.rootPath}` : ''})`)
            .join('; '),
      );
    }
    if (Array.isArray(sc.siblingEntries) && sc.siblingEntries.length > 0) {
      const dirs = sc.siblingEntries.filter((e) => e.isDir);
      const audioFiles = sc.siblingEntries.filter((e) => !e.isDir && e.kind === 'audio');
      const annFiles = sc.siblingEntries.filter((e) => !e.isDir && e.kind === 'annotation');
      const lines: string[] = [
        `Sound Source Folder Contents (prefix="${sc.siblingPrefix ?? ''}"): ${audioFiles.length} audio files, ${annFiles.length} annotation files, ${dirs.length} subfolders.`,
      ];
      if (audioFiles.length > 0) {
        lines.push(
          `Audio files in source folder (showing up to 50):\n` +
            audioFiles
              .slice(0, 50)
              .map(
                (e) =>
                  `  - ${e.name} (uri="${e.uri}"${e.sizeBytes ? `, ${(e.sizeBytes / (1024 * 1024)).toFixed(2)} MB` : ''})`,
              )
              .join('\n'),
        );
      }
      if (dirs.length > 0) {
        lines.push(
          `Subfolders: ` +
            dirs
              .slice(0, 20)
              .map((d) => `${d.name} (uri="${d.uri}")`)
              .join(', '),
        );
      }
      if (annFiles.length > 0) {
        lines.push(
          `Annotation files: ` +
            annFiles
              .slice(0, 20)
              .map((a) => `${a.name} (uri="${a.uri}")`)
              .join(', '),
        );
      }
      contextLines.push(lines.join('\n'));
    }
    if (Array.isArray(sc.otherOpenWindows) && sc.otherOpenWindows.length > 0) {
      const winLines = sc.otherOpenWindows.map((w) => {
        const summaryStr = w.summary
          ? ` | floor=${w.summary.noiseFloorP20}dB, max=${w.summary.maxVal}dB, globalPeak=${w.summary.globalPeakTimeSec}s@${Math.round(w.summary.globalPeakFreqHz ?? 0)}Hz`
          : '';
        return `  - "${w.name}" (fileId="${w.fileId}", sourceId="${w.sourceId}", uri="${w.uri}", ${w.sampleRate} Hz, ${w.numChannels} ch, ${w.durationSec?.toFixed(2)}s${w.isPartialWindow ? `, window ${w.windowStartSec?.toFixed(0)}s/${w.totalDurationSec?.toFixed(0)}s` : ''}${summaryStr})`;
      });
      contextLines.push(`Other Open Windows in Workspace:\n${winLines.join('\n')}`);
    }
  }

  const allAnns =
    Array.isArray(body.allWorkspaceAnnotations) && body.allWorkspaceAnnotations.length > 0
      ? body.allWorkspaceAnnotations
      : body.annotations;
  if (Array.isArray(allAnns) && allAnns.length > 0) {
    const summary = allAnns
      .slice(0, 60)
      .map(
        (a) =>
          `[${a.soundfile || 'active'} ch${a.channel ?? 1} ${a.startTimeSec?.toFixed(2)}-${a.endTimeSec?.toFixed(2)}s, ${Math.round(a.lowFreqHz ?? 0)}-${Math.round(a.highFreqHz ?? 0)}Hz]: ${a.comment || '(unlabeled)'}`,
      )
      .join('\n');
    contextLines.push(`Workspace Annotations (${allAnns.length} total, showing up to 60):\n${summary}`);
  }

  if (Array.isArray(body.history) && body.history.length > 0) {
    const histText = body.history
      .slice(-8)
      .map((h) => `${h.role === 'assistant' ? 'Explorer' : 'User'}: ${h.content ?? ''}`)
      .join('\n');
    contextLines.push(`Recent Conversation:\n${histText}`);
  }

  contextLines.push(`User Question: ${body.prompt ?? ''}`);

  const parts: Part[] = [{ text: contextLines.join('\n\n') }];

  const hasFocusedImg = isValidBase64Png(body.spectrogramImageBase64);
  const hasFullImg = isValidBase64Png(body.fullSpectrogramImageBase64);

  if (hasFocusedImg) {
    parts.push({
      text: body.selection
        ? '[Image 1: Active Selection Box Spectrogram PNG]'
        : '[Image 1: Active Viewport Spectrogram PNG]',
    });
    parts.push({
      inlineData: {
        mimeType: 'image/png',
        data: body.spectrogramImageBase64!,
      },
    });
  }

  if (hasFullImg) {
    parts.push({
      text: '[Image 2: Full Loaded Recording Overview Spectrogram PNG (0..duration, 0..Nyquist)]',
    });
    parts.push({
      inlineData: {
        mimeType: 'image/png',
        data: body.fullSpectrogramImageBase64!,
      },
    });
  }

  return parts;
}

const SYSTEM_INSTRUCTION = [
  'You are SyrinxOne AI Bioacoustic Explorer, an expert bioacoustics and underwater/terrestrial acoustic analyst.',
  'You have access to BOTH the focused selection/viewport AND the rest of the acoustic data in the recording and sound source (full-recording DSP metrics, temporal timeline slices, frequency band distribution, additional channels, sibling files in the sound source, other open windows, and workspace annotations).',
  'When the user asks about acoustic content that has not yet been measured in detail—such as other files in the sound source, subfolders, later time windows of a partial archive file, specific frequency bands/times outside the selection, other channels, or automated sound event counts—proactively call the provided tools (`browse_sound_source`, `inspect_recording_region`, `inspect_source_file`, `detect_sound_events`) to fetch real DSP evidence before answering.',
  'Ground all quantitative statements strictly in the provided DSP measurements, spectral/temporal profiles, tool outputs, and spectrogram images. Never fabricate values.',
  'Be scientifically cautious with taxonomic hypotheses (offer candidate taxa or call classes with acoustic rationale, not false certainty).',
  'If helpful, you may optionally end your response with a single `<syrinx_actions>{"suggestedLabels":["label_1","label_2"],"suggestedDetectParams":{"minFreqHz":100,"maxFreqHz":2000,"triggerThresholdDb":12,"minSoundDurSec":0.1,"maxSilenceGapSec":0.25,"comment":"label_1"}}</syrinx_actions>` block when proposing concrete annotation labels or Detect Sounds parameters.',
].join('\n');

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '16mb' }));

  app.post('/api/local/ai/analyze', async (req, res) => {
    sweepExpiredSessions();

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      res.status(400).json({
        code: 'MISSING_GEMINI_API_KEY',
        error:
          'GEMINI_API_KEY is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets (or on the Cloud Run engine) to enable multimodal AI analysis.',
      });
      return;
    }

    const body = (req.body ?? {}) as AnalyzeBody;
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    try {
      let session: PendingSession;

      if (body.sessionId) {
        const existing = pendingSessions.get(body.sessionId);
        if (!existing) {
          res.status(400).json({ error: 'AI exploration session expired. Please resend your question.' });
          return;
        }
        pendingSessions.delete(body.sessionId);

        if (!Array.isArray(body.toolResults) || body.toolResults.length === 0) {
          res.status(400).json({ error: 'Tool results are required to continue AI exploration.' });
          return;
        }

        const toolParts: Part[] = [];
        for (const tr of body.toolResults) {
          toolParts.push({
            functionResponse: {
              ...(tr.id ? { id: tr.id } : {}),
              name: tr.name,
              response: tr.response ?? {},
            },
          });
          if (isValidBase64Png(tr.imageBase64)) {
            toolParts.push({
              text: tr.imageLabel || `Spectrogram PNG returned by ${tr.name}:`,
            });
            toolParts.push({
              inlineData: {
                mimeType: 'image/png',
                data: tr.imageBase64,
              },
            });
          }
        }

        session = {
          ...existing,
          contents: [...existing.contents, { role: 'user', parts: toolParts }],
          round: existing.round + 1,
          createdAt: Date.now(),
        };
      } else {
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt) {
          res.status(400).json({ error: 'Prompt is required.' });
          return;
        }

        const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
        const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : 'gemini-4-hydrogen';

        session = {
          model,
          systemInstruction: SYSTEM_INSTRUCTION,
          contents: [{ role: 'user', parts: buildInitialParts(body) }],
          round: 0,
          createdAt: Date.now(),
        };
      }

      const allowMoreTools = body.enableTools !== false && session.round < MAX_TOOL_ROUNDS;

      const response = await ai.models.generateContent({
        model: session.model,
        contents: session.contents,
        config: {
          systemInstruction: session.systemInstruction,
          ...(allowMoreTools ? { tools: [{ functionDeclarations: SOUND_SOURCE_TOOLS }] } : {}),
        },
      });

      const functionCalls = response.functionCalls;
      const candidateContent = response.candidates?.[0]?.content;

      if (allowMoreTools && functionCalls && functionCalls.length > 0 && candidateContent) {
        const nextSessionId = crypto.randomUUID();
        pendingSessions.set(nextSessionId, {
          ...session,
          contents: [...session.contents, candidateContent],
          createdAt: Date.now(),
        });

        res.json({
          status: 'tool_calls',
          sessionId: nextSessionId,
          modelUsed: session.model,
          toolCalls: functionCalls.map((fc, idx) => ({
            id: fc.id || `call_${session.round}_${idx}`,
            name: fc.name ?? '',
            args: (fc.args ?? {}) as Record<string, unknown>,
          })),
        });
        return;
      }

      const extracted = extractActionsFromText(response.text ?? '');
      res.json({
        status: 'done',
        answer: extracted.answer,
        modelUsed: session.model,
        suggestedLabels: extracted.suggestedLabels,
        suggestedDetectParams: extracted.suggestedDetectParams,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gemini API request failed';
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/archive-docs/read', async (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!rawUrl) {
      res.status(400).json({ error: 'Missing url query parameter' });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      res.status(400).json({ error: 'Invalid URL' });
      return;
    }

    if (parsed.protocol !== 'https:') {
      res.status(400).json({ error: 'Only https:// documentation URLs are supported' });
      return;
    }

    const host = parsed.hostname.toLowerCase();
    const isPrivateOrLiteral =
      host === 'localhost' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      host.includes(':');
    if (isPrivateOrLiteral) {
      res.status(403).json({ error: 'Disallowed host' });
      return;
    }

    try {
      const upstream = await fetch(parsed.toString(), {
        redirect: 'error',
        signal: AbortSignal.timeout(6000),
        headers: {
          Accept: 'text/plain, text/markdown, text/*, application/json, application/xml;q=0.9',
        },
      });
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
        return;
      }
      const ct = (upstream.headers.get('content-type') || '').toLowerCase();
      const looksTextPath = /\.(md|markdown|txt|rst|csv|tsv|json|xml|yaml|yml)$/i.test(
        parsed.pathname,
      );
      if (
        !ct.startsWith('text/') &&
        !ct.includes('json') &&
        !ct.includes('xml') &&
        !looksTextPath
      ) {
        res.status(415).json({ error: `Non-text content-type (${ct || 'unknown'})`, contentType: ct });
        return;
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      const maxBytes = 131072;
      const truncated = buf.byteLength > maxBytes;
      const text = buf.subarray(0, maxBytes).toString('utf8');
      res.json({
        url: parsed.toString(),
        contentType: ct || 'text/plain',
        truncated,
        text,
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to fetch document' });
    }
  });

  // Never let unknown /api/* paths fall through to Vite/SPA index.html HTML responses
  app.use('/api', (_req, res) => {
    res.status(404).json({
      error:
        'Unknown local API route. Set Engine URL in SyrinxOne settings to your Cloud Run or local Python DSP server.',
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
        watch: {
          ignored: ['**/dist/**', '**/.git/**'],
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`SyrinxOne web server listening on http://0.0.0.0:${PORT}`);
  });
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  httpServer.on('error', (err) => {
    console.error('[server] HTTP server error:', err);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
});

void startServer().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
