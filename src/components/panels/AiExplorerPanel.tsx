import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Radar, Send, Settings2, Sparkles, Tag, X } from 'lucide-react';
import type {
  AiChatMessage,
  AudioFileInfo,
  DataSourceInfo,
  DisplaySettings,
  SelectionMeasurements,
  SpectrogramMatrix,
  SpectrogramParams,
  SuggestedDetectParams,
} from '@syrinxone/shared';
import { getCachedSpectrogram, useWorkspaceStore } from '../../store/workspaceStore';
import {
  parentDirectoryUri,
  summarizeSpectrogramMatrix,
  summarizeWaveform,
} from '../../utils/acousticContext';
import { isCombinedFileId, type CombinedEngineProxy } from '../../utils/combinedEngine';
import { renderSpectrogramPngBase64 } from '../../utils/exportImage';
import {
  fetchSpectrogramAdaptive,
  formatDurationCompact,
} from '../../utils/spectrogramFetch';
import {
  buildRecordingTimeContext,
  formatRecordingRange,
  formatRecordingTime,
} from '../../utils/timeFormat';

const AI_MODEL_STORAGE = 'syrinxone.geminiModel.v1';
const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';
const AVAILABLE_MODELS = new Set([
  'gemini-4-hydrogen',
  'gemini-4-neon',
  'gemini-3.1-flash-lite',
]);

interface ExplorerEntry extends AiChatMessage {
  id: string;
  modelUsed?: string;
  measurements?: SelectionMeasurements;
  suggestedDetectParams?: SuggestedDetectParams;
  suggestedLabels?: string[];
  inspectedTools?: string[];
}

interface ToolCallInstruction {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface LocalAiResponse {
  status?: 'tool_calls' | 'done';
  sessionId?: string;
  toolCalls?: ToolCallInstruction[];
  answer?: string;
  modelUsed?: string;
  suggestedLabels?: string[];
  suggestedDetectParams?: SuggestedDetectParams;
  error?: string;
}

const QUICK_PROMPTS = [
  'Analyze the acoustic structure and likely sound source in this selection.',
  'Scan the full recording & compare acoustic events outside my current selection.',
  'Browse & inspect other recordings in this sound source and summarize differences.',
  'Suggest optimal Detect Sounds parameters to find similar events across this source.',
  'Review workspace annotations and summarize frequency bands, SNR, and call classes.',
];

async function fetchPngBase64(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  } catch {
    return undefined;
  }
}

async function postLocalAi(payload: unknown): Promise<{ ok: boolean; status: number; body: LocalAiResponse | null }> {
  const localRes = await fetch('/api/local/ai/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const rawBody = await localRes.text();
  let parsedBody: LocalAiResponse | null = null;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed && typeof parsed === 'object') {
      parsedBody = parsed as LocalAiResponse;
    }
  } catch {
    parsedBody = null;
  }
  return { ok: localRes.ok, status: localRes.status, body: parsedBody };
}

function isSameRange(
  a: { startSec: number; endSec: number; minFreqHz: number; maxFreqHz: number },
  b: { startSec: number; endSec: number; minFreqHz: number; maxFreqHz: number },
): boolean {
  return (
    Math.abs(a.startSec - b.startSec) < 0.05 &&
    Math.abs(a.endSec - b.endSec) < 0.05 &&
    Math.abs(a.minFreqHz - b.minFreqHz) < 5 &&
    Math.abs(a.maxFreqHz - b.maxFreqHz) < 5
  );
}

async function captureSpectrogramPngBase64(
  engine: CombinedEngineProxy,
  fileInfo: AudioFileInfo | undefined,
  specParams: SpectrogramParams,
  displaySettings: DisplaySettings,
  range: { startSec: number; endSec: number; minFreqHz: number; maxFreqHz: number },
  cachedMatrix?: SpectrogramMatrix,
): Promise<string | undefined> {
  if (!fileInfo) return undefined;
  if (!isCombinedFileId(fileInfo.fileId)) {
    const bitmapUrl = engine.getSpectrogramBitmapUrl(
      fileInfo.fileId,
      specParams,
      displaySettings,
      range,
    );
    if (bitmapUrl) {
      const remotePng = await fetchPngBase64(bitmapUrl);
      if (remotePng) return remotePng;
    }
  }
  try {
    let matrix = cachedMatrix;
    const matchesFullCached =
      matrix &&
      Math.abs(matrix.startSec - range.startSec) < 0.05 &&
      Math.abs(matrix.endSec - range.endSec) < 0.05 &&
      range.endSec - range.startSec >= fileInfo.durationSec * 0.45;
    if (!matchesFullCached) {
      matrix = await fetchSpectrogramAdaptive(engine, fileInfo, specParams, range);
    }
    return matrix ? renderSpectrogramPngBase64(matrix, range, displaySettings) : undefined;
  } catch {
    return cachedMatrix ? renderSpectrogramPngBase64(cachedMatrix, range, displaySettings) : undefined;
  }
}

export const AiExplorerPanel: React.FC = () => {
  const engine = useWorkspaceStore((s) => s.engine);
  const windows = useWorkspaceStore((s) => s.windows);
  const activeWindowId = useWorkspaceStore((s) => s.activeWindowId);
  const files = useWorkspaceStore((s) => s.files);
  const spectrogramCache = useWorkspaceStore((s) => s.spectrogramCache);
  const waveformCache = useWorkspaceStore((s) => s.waveformCache);
  const annotations = useWorkspaceStore((s) => s.annotations);
  const setModalState = useWorkspaceStore((s) => s.setModalState);
  const logActiveSelection = useWorkspaceStore((s) => s.logActiveSelection);
  const applySuggestedDetectParams = useWorkspaceStore((s) => s.applySuggestedDetectParams);

  const activeWin = windows.find((w) => w.windowId === activeWindowId);
  const activeFile = activeWin ? files[activeWin.fileId] : undefined;

  const [entries, setEntries] = useState<ExplorerEntry[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyStatus, setBusyStatus] = useState('Analyzing spectrogram & DSP metrics...');
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [includeSpecImg, setIncludeSpecImg] = useState(true);
  const [includeSourceContext, setIncludeSourceContext] = useState(true);
  const [model, setModel] = useState(() => {
    try {
      const saved = localStorage.getItem(AI_MODEL_STORAGE);
      return saved && AVAILABLE_MODELS.has(saved) ? saved : DEFAULT_GEMINI_MODEL;
    } catch {
      return DEFAULT_GEMINI_MODEL;
    }
  });

  const panelRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inspectedFilesRef = useRef<Record<string, AudioFileInfo>>({});

  useEffect(() => {
    const syncScroll = () => {
      if (window.innerWidth <= 768 && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    };
    const vv = window.visualViewport;
    vv?.addEventListener('resize', syncScroll);
    return () => {
      vv?.removeEventListener('resize', syncScroll);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(AI_MODEL_STORAGE, model);
    } catch {
      // ignore storage errors
    }
  }, [model]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, busy, busyStatus]);

  const contextSummary = useMemo(() => {
    if (!activeFile || !activeWin) return '';
    const combinedRec = isCombinedFileId(activeFile.fileId)
      ? engine.getCombinedRecording(activeFile.fileId)
      : undefined;
    const timeCtx = buildRecordingTimeContext(activeFile, combinedRec?.segments);
    const winOff = activeFile.windowStartSec ?? 0;
    const focusPart = activeWin.selection
      ? `Sel ${formatRecordingTime(winOff + Math.min(activeWin.selection.startSec, activeWin.selection.endSec), timeCtx)}–${formatRecordingTime(winOff + Math.max(activeWin.selection.startSec, activeWin.selection.endSec), timeCtx)} (${Math.round(Math.min(activeWin.selection.lowFreqHz, activeWin.selection.highFreqHz))}–${Math.round(Math.max(activeWin.selection.lowFreqHz, activeWin.selection.highFreqHz))} Hz)`
      : `View ${activeWin.viewRange.startSec.toFixed(1)}–${activeWin.viewRange.endSec.toFixed(1)}s`;
    const rng = formatRecordingRange(
      winOff,
      winOff + activeFile.durationSec,
      activeFile.totalDurationSec ?? activeFile.durationSec,
      timeCtx,
    );
    const archivePart = activeFile.isPartialWindow
      ? ` · Slice ${rng.startLabel}–${rng.endLabel} / ${rng.totalLabel}`
      : ` · Full ${formatDurationCompact(activeFile.durationSec)}`;
    const scopePart = includeSourceContext ? ` · Source: ${activeFile.sourceId}` : '';
    return `${focusPart}${archivePart}${scopePart}`;
  }, [activeFile, activeWin, engine, includeSourceContext]);

  const executeToolCall = async (
    tc: ToolCallInstruction,
    defaultSpecParams: SpectrogramParams,
    defaultDisplay: typeof activeWin extends undefined ? never : NonNullable<typeof activeWin>['displaySettings'],
  ): Promise<{
    id: string;
    name: string;
    response: Record<string, unknown>;
    imageBase64?: string;
    imageLabel?: string;
  }> => {
    const args = tc.args ?? {};
    const resolveFileInfo = (fid: string): AudioFileInfo | undefined =>
      files[fid] ?? inspectedFilesRef.current[fid];

    try {
      if (tc.name === 'browse_sound_source') {
        const sourceId = String(args.sourceId || activeFile?.sourceId || 'local');
        const prefix = typeof args.prefix === 'string' ? args.prefix : '';
        const limit =
          typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.max(1, Math.min(300, Math.round(args.limit)))
            : 120;
        const listed = await engine.browseSource(sourceId, prefix, limit);
        return {
          id: tc.id,
          name: tc.name,
          response: {
            sourceId,
            prefix,
            totalReturned: listed.length,
            entries: listed.slice(0, 120),
          },
        };
      }

      if (tc.name === 'inspect_recording_region') {
        const fid = String(args.fileId || activeFile?.fileId || '');
        const fInfo = resolveFileInfo(fid);
        const maxDur = fInfo?.durationSec ?? Math.max(0.01, Number(args.endSec ?? 60));
        const nyquist = fInfo ? fInfo.sampleRate / 2 : 128000;
        const ch =
          typeof args.channel === 'number'
            ? Math.max(0, Math.min((fInfo?.numChannels ?? 1) - 1, Math.round(args.channel)))
            : defaultSpecParams.channel;
        const startSec = Math.max(0, Math.min(maxDur - 0.005, Number(args.startSec ?? 0)));
        const endSec = Math.max(startSec + 0.005, Math.min(maxDur, Number(args.endSec ?? maxDur)));
        const lowFreqHz = Math.max(0, Math.min(nyquist - 1, Number(args.lowFreqHz ?? 0)));
        const highFreqHz = Math.max(
          lowFreqHz + 1,
          Math.min(nyquist, Number(args.highFreqHz ?? nyquist)),
        );

        const meas = await engine.measureSelection(fid, {
          channel: ch,
          startSec,
          endSec,
          lowFreqHz,
          highFreqHz,
          fftSize: defaultSpecParams.fftSize,
          hopSize: defaultSpecParams.hopSize,
        });

        let imageBase64: string | undefined;
        if (args.includeImage !== false && includeSpecImg) {
          imageBase64 = await captureSpectrogramPngBase64(
            engine,
            fInfo,
            { ...defaultSpecParams, channel: ch },
            defaultDisplay,
            { startSec, endSec, minFreqHz: lowFreqHz, maxFreqHz: highFreqHz },
          );
        }

        return {
          id: tc.id,
          name: tc.name,
          response: {
            fileId: fid,
            fileName: fInfo?.name,
            channel: ch,
            region: { startSec, endSec, lowFreqHz, highFreqHz },
            measurements: meas,
          },
          imageBase64,
          imageLabel: `Spectrogram PNG for ${fInfo?.name ?? fid} [ch${ch}, ${startSec.toFixed(2)}–${endSec.toFixed(2)}s, ${Math.round(lowFreqHz)}–${Math.round(highFreqHz)} Hz]`,
        };
      }

      if (tc.name === 'inspect_source_file') {
        const sourceId = String(args.sourceId || activeFile?.sourceId || '');
        const uri = String(args.uri || '');
        const startOpt =
          typeof args.startSec === 'number' && Number.isFinite(args.startSec)
            ? Math.max(0, args.startSec)
            : undefined;
        const maxDurOpt =
          typeof args.maxDurationSec === 'number' && Number.isFinite(args.maxDurationSec)
            ? Math.max(5, Math.min(21600, args.maxDurationSec))
            : undefined;

        const opened = await engine.openAudio(
          sourceId,
          uri,
          startOpt !== undefined || maxDurOpt !== undefined
            ? { startSec: startOpt, maxDurationSec: maxDurOpt }
            : undefined,
        );
        inspectedFilesRef.current[opened.fileId] = opened;

        const ch =
          typeof args.channel === 'number'
            ? Math.max(0, Math.min(Math.max(0, opened.numChannels - 1), Math.round(args.channel)))
            : 0;
        const nyquist = opened.sampleRate / 2;
        const specParams: SpectrogramParams = { ...defaultSpecParams, channel: ch };

        const [measRes, specRes, wfRes, imgRes] = await Promise.allSettled([
          engine.measureSelection(opened.fileId, {
            channel: ch,
            startSec: 0,
            endSec: opened.durationSec,
            lowFreqHz: 0,
            highFreqHz: nyquist,
            fftSize: specParams.fftSize,
            hopSize: specParams.hopSize,
          }),
          fetchSpectrogramAdaptive(engine, opened, specParams),
          engine.getWaveform(opened.fileId, ch, 1200),
          args.includeImage !== false && includeSpecImg
            ? fetchPngBase64(
                engine.getSpectrogramBitmapUrl(opened.fileId, specParams, defaultDisplay, {
                  startSec: 0,
                  endSec: opened.durationSec,
                  minFreqHz: 0,
                  maxFreqHz: nyquist,
                }),
              )
            : Promise.resolve(undefined),
        ]);

        const specSummary =
          specRes.status === 'fulfilled' ? summarizeSpectrogramMatrix(specRes.value) : null;
        const wfSummary = wfRes.status === 'fulfilled' ? summarizeWaveform(wfRes.value) : null;
        const imageBase64 = imgRes.status === 'fulfilled' ? imgRes.value : undefined;

        return {
          id: tc.id,
          name: tc.name,
          response: {
            fileInfo: opened,
            channel: ch,
            measurements: measRes.status === 'fulfilled' ? measRes.value : null,
            spectrogramSummary: specSummary,
            waveformSummary: wfSummary,
          },
          imageBase64,
          imageLabel: `Full-window Spectrogram PNG for ${opened.name} (${opened.sourceId}:${opened.uri}${opened.isPartialWindow ? `, window ${opened.windowStartSec?.toFixed(0)}–${((opened.windowStartSec ?? 0) + opened.durationSec).toFixed(0)}s/${opened.totalDurationSec?.toFixed(0)}s` : ''})`,
        };
      }

      if (tc.name === 'detect_sound_events') {
        const fid = String(args.fileId || activeFile?.fileId || '');
        const fInfo = resolveFileInfo(fid);
        const nyquist = fInfo ? fInfo.sampleRate / 2 : 128000;
        const maxDur = fInfo?.durationSec ?? 60;
        const ch =
          typeof args.channel === 'number'
            ? Math.max(0, Math.min(Math.max(0, (fInfo?.numChannels ?? 1) - 1), Math.round(args.channel)))
            : defaultSpecParams.channel;
        const minFreqHz = Math.max(0, Number(args.minFreqHz ?? 0));
        const maxFreqHz = Math.max(minFreqHz + 1, Math.min(nyquist, Number(args.maxFreqHz ?? nyquist)));
        const triggerThresholdDb =
          typeof args.triggerThresholdDb === 'number' ? args.triggerThresholdDb : 10;
        const minSoundDurSec =
          typeof args.minSoundDurSec === 'number' ? args.minSoundDurSec : 0.05;
        const maxSilenceGapSec =
          typeof args.maxSilenceGapSec === 'number' ? args.maxSilenceGapSec : 0.25;

        const res = await engine.detectSounds(fid, {
          channel: ch,
          fftSize: defaultSpecParams.fftSize,
          hopSize: defaultSpecParams.hopSize,
          minFreqHz,
          maxFreqHz,
          triggerThresholdDb,
          minTriggerDurSec: Math.min(0.05, minSoundDurSec),
          minSoundDurSec,
          maxSilenceGapSec,
          preBufferSec: 0.02,
          postBufferSec: 0.02,
          popFilter: defaultSpecParams.popFilter,
          startSec:
            typeof args.startSec === 'number' ? Math.max(0, args.startSec) : 0,
          endSec:
            typeof args.endSec === 'number' ? Math.min(maxDur, args.endSec) : maxDur,
          comment: 'ai_scan',
        });

        return {
          id: tc.id,
          name: tc.name,
          response: {
            fileId: fid,
            eventCount: res.detections.length,
            noiseFloorDb: res.noiseFloorDb,
            detectionsSample: res.detections.slice(0, 30).map((d) => ({
              startTimeSec: d.startTimeSec,
              endTimeSec: d.endTimeSec,
              lowFreqHz: d.lowFreqHz,
              highFreqHz: d.highFreqHz,
              comment: d.comment,
            })),
          },
        };
      }

      return {
        id: tc.id,
        name: tc.name,
        response: { error: `Unknown tool: ${tc.name}` },
      };
    } catch (err) {
      return {
        id: tc.id,
        name: tc.name,
        response: { error: err instanceof Error ? err.message : 'Tool execution failed' },
      };
    }
  };

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
    setBusyStatus('Measuring selection, full recording & sound source...');
    setError(null);

    try {
      const sel = activeWin.selection;
      const selectionBounds = sel
        ? {
            startSec: Math.min(sel.startSec, sel.endSec),
            endSec: Math.max(sel.startSec, sel.endSec),
            lowFreqHz: Math.min(sel.lowFreqHz, sel.highFreqHz),
            highFreqHz: Math.max(sel.lowFreqHz, sel.highFreqHz),
          }
        : undefined;
      const combinedRec = isCombinedFileId(activeFile.fileId)
        ? engine.getCombinedRecording(activeFile.fileId)
        : undefined;
      const fileAnnotations = annotations.filter(
        (a) =>
          a.soundfile.toLowerCase() === activeFile.name.toLowerCase() ||
          (combinedRec?.segments.some(
            (seg) => seg.name.toLowerCase() === a.soundfile.toLowerCase(),
          ) ??
            false),
      );

      // 1. Query the live Python DSP engine for grounded measurements & suggested parameters
      const engineResp = await engine.analyzeWithAi({
        fileId: activeFile.fileId,
        channel: activeWin.specParams.channel,
        prompt: q,
        history,
        selection: selectionBounds,
        viewRange: activeWin.viewRange,
        specParams: activeWin.specParams,
        displaySettings: activeWin.displaySettings,
        annotations: fileAnnotations,
        includeSpectrogramImage: includeSpecImg,
        model: model.trim() || 'gemini-4-hydrogen',
      });

      const needsServerGemini =
        engineResp.answer.includes('Add a Gemini API key') ||
        engineResp.modelUsed.toLowerCase().includes('offline') ||
        engineResp.modelUsed.toLowerCase().includes('dsp-only');

      let finalAnswer = engineResp.answer;
      let finalModelUsed = engineResp.modelUsed;
      let finalSuggestedLabels = engineResp.suggestedLabels;
      let finalDetectParams = engineResp.suggestedDetectParams;
      const usedToolNames: string[] = [];

      // 2. Gather full-recording & sound-source context and invoke server-side Gemini proxy
      if (needsServerGemini) {
        const nyquist = activeFile.sampleRate / 2;
        const fullRange = {
          startSec: 0,
          endSec: activeFile.durationSec,
          minFreqHz: 0,
          maxFreqHz: nyquist,
        };
        const imgRange = selectionBounds
          ? {
              startSec: selectionBounds.startSec,
              endSec: selectionBounds.endSec,
              minFreqHz: selectionBounds.lowFreqHz,
              maxFreqHz: selectionBounds.highFreqHz,
            }
          : activeWin.viewRange;

        const needSeparateFull = includeSourceContext && !isSameRange(imgRange, fullRange);

        const activeMatrix = getCachedSpectrogram(
          spectrogramCache,
          activeFile.fileId,
          activeWin.specParams,
        );
        const activeWaveform =
          waveformCache[`${activeFile.fileId}|${activeWin.specParams.channel}`];

        const otherChannels =
          includeSourceContext && activeFile.numChannels > 1
            ? Array.from({ length: Math.min(4, activeFile.numChannels) }, (_, i) => i).filter(
                (ch) => ch !== activeWin.specParams.channel,
              )
            : [];

        const siblingPrefix = parentDirectoryUri(activeFile.uri);

        const [
          focusedImgRes,
          fullImgRes,
          fullMeasRes,
          sourcesRes,
          browseRes,
          otherChRes,
        ] = await Promise.all([
          includeSpecImg
            ? captureSpectrogramPngBase64(
                engine,
                activeFile,
                activeWin.specParams,
                activeWin.displaySettings,
                imgRange,
                activeMatrix,
              )
            : Promise.resolve(undefined),
          includeSpecImg && needSeparateFull
            ? captureSpectrogramPngBase64(
                engine,
                activeFile,
                activeWin.specParams,
                activeWin.displaySettings,
                fullRange,
                activeMatrix,
              )
            : Promise.resolve(undefined),
          needSeparateFull
            ? engine
                .measureSelection(activeFile.fileId, {
                  channel: activeWin.specParams.channel,
                  startSec: 0,
                  endSec: activeFile.durationSec,
                  lowFreqHz: 0,
                  highFreqHz: nyquist,
                  fftSize: activeWin.specParams.fftSize,
                  hopSize: activeWin.specParams.hopSize,
                })
                .catch(() => undefined)
            : Promise.resolve(undefined),
          includeSourceContext
            ? engine.listSources().catch(() => [] as DataSourceInfo[])
            : Promise.resolve([] as DataSourceInfo[]),
          includeSourceContext && activeFile.sourceId !== 'upload'
            ? engine.browseSource(activeFile.sourceId, siblingPrefix, 250).catch(() => [])
            : Promise.resolve([]),
          Promise.all(
            otherChannels.map(async (ch) => {
              try {
                const m = await engine.measureSelection(activeFile.fileId, {
                  channel: ch,
                  startSec: 0,
                  endSec: activeFile.durationSec,
                  lowFreqHz: 0,
                  highFreqHz: nyquist,
                  fftSize: activeWin.specParams.fftSize,
                  hopSize: activeWin.specParams.hopSize,
                });
                return { channel: ch, measurements: m };
              } catch {
                return null;
              }
            }),
          ),
        ]);

        const activeSource = sourcesRes.find((s) => s.sourceId === activeFile.sourceId) ?? null;

        const otherOpenWindows = includeSourceContext
          ? windows
              .filter((w) => w.windowId !== activeWin.windowId)
              .map((w) => {
                const wfFile = files[w.fileId];
                const wfMat = wfFile
                  ? getCachedSpectrogram(spectrogramCache, wfFile.fileId, w.specParams)
                  : undefined;
                return {
                  windowId: w.windowId,
                  fileId: w.fileId,
                  name: wfFile?.name ?? w.title,
                  sourceId: wfFile?.sourceId,
                  uri: wfFile?.uri,
                  sampleRate: wfFile?.sampleRate,
                  numChannels: wfFile?.numChannels,
                  durationSec: wfFile?.durationSec,
                  isPartialWindow: wfFile?.isPartialWindow,
                  windowStartSec: wfFile?.windowStartSec,
                  totalDurationSec: wfFile?.totalDurationSec,
                  viewRange: w.viewRange,
                  selection: w.selection,
                  summary: wfMat ? summarizeSpectrogramMatrix(wfMat, 8, 6) : null,
                };
              })
          : [];

        const acousticProfile = includeSourceContext
          ? {
              spectrogramSummary: activeMatrix ? summarizeSpectrogramMatrix(activeMatrix) : null,
              waveformSummary: activeWaveform ? summarizeWaveform(activeWaveform) : null,
            }
          : undefined;

        setBusyStatus('Querying Gemini Bioacoustic Explorer...');

        let resp = await postLocalAi({
          prompt: q,
          model: model.trim() || 'gemini-4-hydrogen',
          enableTools: includeSourceContext,
          history,
          fileInfo: {
            fileId: activeFile.fileId,
            sourceId: activeFile.sourceId,
            uri: activeFile.uri,
            name: activeFile.name,
            sampleRate: activeFile.sampleRate,
            durationSec: activeFile.durationSec,
            numChannels: activeFile.numChannels,
            numFrames: activeFile.numFrames,
            format: activeFile.format,
            subtype: activeFile.subtype,
            startDateTimeIso: activeFile.startDateTimeIso,
            isPartialWindow: activeFile.isPartialWindow,
            windowStartSec: activeFile.windowStartSec,
            totalDurationSec: activeFile.totalDurationSec,
            isCombined: Boolean(combinedRec),
            combinedSegmentCount: combinedRec?.segments.length,
            combinedSegments: combinedRec
              ? combinedRec.segments.slice(0, 60).map((seg) => ({
                  index: seg.index,
                  name: seg.name,
                  folderName: seg.folderName,
                  uri: seg.uri,
                  timelineStartSec: Number(seg.timelineStartSec.toFixed(2)),
                  timelineEndSec: Number(seg.timelineEndSec.toFixed(2)),
                  durationSec: Number(seg.durationSec.toFixed(2)),
                }))
              : undefined,
          },
          specParams: {
            channel: activeWin.specParams.channel,
            fftSize: activeWin.specParams.fftSize,
            hopSize: activeWin.specParams.hopSize,
            windowType: activeWin.specParams.windowType,
            dspMode: activeWin.specParams.dspMode,
            popFilter: activeWin.specParams.popFilter,
          },
          selection: selectionBounds,
          viewRange: activeWin.viewRange,
          measurements: engineResp.measurements,
          fullRecordingMeasurements: fullMeasRes,
          channelMeasurements: otherChRes.filter(
            (x): x is NonNullable<typeof x> => x !== null,
          ),
          acousticProfile,
          sourceContext: includeSourceContext
            ? {
                activeSource,
                allSources: sourcesRes,
                siblingPrefix,
                siblingEntries: browseRes,
                otherOpenWindows,
              }
            : undefined,
          annotations: fileAnnotations,
          allWorkspaceAnnotations: includeSourceContext ? annotations.slice(0, 80) : undefined,
          spectrogramImageBase64: focusedImgRes,
          fullSpectrogramImageBase64: fullImgRes,
        });

        let round = 0;
        while (
          resp.ok &&
          resp.body?.status === 'tool_calls' &&
          resp.body.sessionId &&
          Array.isArray(resp.body.toolCalls) &&
          resp.body.toolCalls.length > 0 &&
          round < 5
        ) {
          round++;
          const calls = resp.body.toolCalls;
          for (const tc of calls) {
            if (!usedToolNames.includes(tc.name)) {
              usedToolNames.push(tc.name);
            }
          }
          const labels = calls.map((c) => {
            if (c.name === 'browse_sound_source') return 'browsing sound source';
            if (c.name === 'inspect_source_file') return 'opening & analyzing source file';
            if (c.name === 'inspect_recording_region') return 'measuring acoustic region';
            if (c.name === 'detect_sound_events') return 'scanning sound events';
            return c.name;
          });
          setBusyStatus(`Exploring sound source (${Array.from(new Set(labels)).join(', ')})...`);

          const toolResults = await Promise.all(
            calls.map((tc) =>
              executeToolCall(tc, activeWin.specParams, activeWin.displaySettings),
            ),
          );

          setBusyStatus('Synthesizing findings across sound source...');
          resp = await postLocalAi({
            sessionId: resp.body.sessionId,
            enableTools: includeSourceContext && round < 5,
            toolResults,
          });
        }

        if (resp.ok && resp.body?.answer) {
          finalAnswer = resp.body.answer;
          finalModelUsed = resp.body.modelUsed ?? finalModelUsed;
          if (resp.body.suggestedLabels && resp.body.suggestedLabels.length > 0) {
            finalSuggestedLabels = resp.body.suggestedLabels;
          }
          if (resp.body.suggestedDetectParams?.minFreqHz !== undefined) {
            finalDetectParams = resp.body.suggestedDetectParams;
          }
        } else {
          finalAnswer = finalAnswer
            .replace(/\n*>?\s*\*?Add a Gemini API key[^\n]*\n*/i, '\n')
            .trim();
          setError(
            resp.body?.error ||
              (resp.ok
                ? 'Local AI endpoint returned an unexpected non-JSON response. Please refresh the page.'
                : `AI Explorer server request failed (${resp.status}).`),
          );
        }
      }

      const assistantMsg: ExplorerEntry = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: finalAnswer,
        modelUsed: finalModelUsed,
        measurements: engineResp.measurements,
        suggestedDetectParams: finalDetectParams,
        suggestedLabels: finalSuggestedLabels,
        inspectedTools: usedToolNames.length > 0 ? usedToolNames : undefined,
      };
      setEntries((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI analysis failed');
    } finally {
      setBusy(false);
      setBusyStatus('Analyzing spectrogram & DSP metrics...');
    }
  };

  return (
    <aside className="ai-panel" ref={panelRef}>
      <div className="panel-header">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Sparkles size={14} color="#38bdf8" /> AI Bioacoustic Explorer
        </span>
        <div style={{ display: 'inline-flex', gap: 4 }}>
          <button
            className={`mdi-icon-btn ${showSettings ? 'btn-active' : ''}`}
            onClick={() => setShowSettings((v) => !v)}
            title="AI Model & Sound Source Context Settings"
          >
            <Settings2 size={13} />
          </button>
          <button
            className="mdi-icon-btn desktop-only"
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
            <label>Gemini Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="gemini-4-hydrogen">gemini-4-hydrogen (Fast Multimodal)</option>
              <option value="gemini-4-neon">gemini-4-neon (Deep Bioacoustic Reasoning)</option>
              <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (Lightweight)</option>
            </select>
          </div>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={includeSpecImg}
              onChange={(e) => setIncludeSpecImg(e.target.checked)}
            />
            Send spectrogram PNGs to Gemini
          </label>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={includeSourceContext}
              onChange={(e) => setIncludeSourceContext(e.target.checked)}
            />
            Access full recording &amp; sound source files
          </label>
        </div>
      )}

      <div className="ai-context-bar">
        {activeFile ? (
          <>
            <strong className="mono">{activeFile.name}</strong>
            <span>{contextSummary}</span>
          </>
        ) : (
          <span>Open an audio file to explore its acoustics with AI.</span>
        )}
      </div>

      <div className="ai-messages" ref={scrollRef}>
        {entries.length === 0 && (
          <div className="ai-welcome">
            <p>
              Inspect selections, full recordings, multi-channel acoustics, archive time slices, and
              sibling files across your sound source. Draw a box or ask a question:
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
              <span>
                {msg.role === 'user' ? 'You' : `Explorer (${msg.modelUsed ?? 'ai'})`}
                {msg.inspectedTools && msg.inspectedTools.length > 0
                  ? ` · ${msg.inspectedTools.length} source query${msg.inspectedTools.length > 1 ? 's' : ''}`
                  : ''}
              </span>
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

        {busy && <div className="ai-msg ai-msg-assistant">{busyStatus}</div>}
        {error && <div className="inline-error">{error}</div>}
      </div>

      <div className="ai-input-bar">
        <input
          type="text"
          value={prompt}
          disabled={!activeFile || busy}
          placeholder={
            activeFile
              ? 'Ask about this selection, full file, or other source files...'
              : 'Open a recording first...'
          }
          onFocus={() => {
            window.setTimeout(() => {
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
            }, 150);
          }}
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
