import { useWorkspaceStore } from '../store/workspaceStore';
import {
  buildDspPreviewDiagnostics,
  captureActiveAcousticSnapshot,
  type ActiveAcousticSnapshot,
} from './contextSnapshot';
import { useNotebookStore } from './notebookStore';
import {
  isDetachedNotebookTab,
  sendCommitAnnotationsToMainTab,
} from './notebookSync';
import type {
  CellOutput,
  NotebookCell,
  NotebookFigure,
  ProposedAnnotation,
  ScriptCellRunItem,
  ScriptRunResult,
  SyrinxNotebook,
} from './types';

interface AccumulatedRunState {
  variables: Record<string, unknown>;
  stdoutHistory: string[];
  markdownHistory: string[];
  figures: NotebookFigure[];
  proposedAnnotations: ProposedAnnotation[];
}

function interpolateTemplate(
  text: string,
  params: Record<string, string | number | boolean>,
  variables: Record<string, unknown>,
): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    if (key in params) return String(params[key]);
    if (key in variables) {
      const val = variables[key];
      return typeof val === 'string' ? val : JSON.stringify(val);
    }
    return `{{${key}}}`;
  });
}

async function tryRemotePythonKernel(
  notebookId: string,
  cell: NotebookCell,
  code: string,
  params: Record<string, string | number | boolean>,
  snapshot: ActiveAcousticSnapshot,
): Promise<CellOutput | null> {
  const { backendUrl, backendToken } = useWorkspaceStore.getState();
  if (!backendUrl) return null;

  try {
    const res = await fetch(`${backendUrl}/api/python/kernel/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(backendToken ? { Authorization: `Bearer ${backendToken}` } : {}),
      },
      body: JSON.stringify({
        notebookId,
        cellId: cell.id,
        code,
        context: {
          ...snapshot.contextPayload,
          params,
        },
      }),
    });

    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return null;
    }

    const body = (await res.json()) as {
      stdout?: string;
      stderr?: string;
      error?: string;
      figures?: Array<{ label?: string; base64Png?: string; data?: string }>;
      variables?: Record<string, unknown>;
      proposedAnnotations?: Array<{
        soundfile?: string;
        channel?: number;
        startTimeSec: number;
        endTimeSec: number;
        lowFreqHz: number;
        highFreqHz: number;
        comment?: string;
        notes?: string;
      }>;
    };

    if (!res.ok) {
      return {
        status: 'error',
        error: body.error || body.stderr || `Python kernel error (${res.status})`,
        stdout: body.stdout,
        executionMode: 'python-kernel',
      };
    }

    const figures: NotebookFigure[] = Array.isArray(body.figures)
      ? body.figures
          .map((f, idx) => ({
            label: f.label || `Figure ${idx + 1}`,
            base64Png: f.base64Png || f.data || '',
          }))
          .filter((f) => Boolean(f.base64Png))
      : [];

    const proposedAnnotations: ProposedAnnotation[] = Array.isArray(body.proposedAnnotations)
      ? body.proposedAnnotations.map((a, idx) => ({
          id: `prop_${cell.id}_${idx}_${Date.now()}`,
          soundfile: a.soundfile || snapshot.file?.name || '',
          channel: a.channel ?? 1,
          startTimeSec: a.startTimeSec,
          endTimeSec: a.endTimeSec,
          lowFreqHz: a.lowFreqHz,
          highFreqHz: a.highFreqHz,
          comment: a.comment ?? '',
          notes: a.notes,
          sourceCellId: cell.id,
          accepted: true,
        }))
      : [];

    return {
      status: 'done',
      stdout: [body.stdout, body.stderr].filter(Boolean).join('\n'),
      figures,
      variables: body.variables ?? {},
      proposedAnnotations,
      executionMode: 'python-kernel',
    };
  } catch {
    return null;
  }
}

async function tryLocalPythonKernel(
  notebookId: string,
  cell: NotebookCell,
  code: string,
  params: Record<string, string | number | boolean>,
  snapshot: ActiveAcousticSnapshot,
): Promise<{ output: CellOutput | null; missingScientificPkg: boolean }> {
  const { backendUrl, backendToken } = useWorkspaceStore.getState();

  try {
    const res = await fetch('/api/local/python/kernel/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebookId,
        code,
        engineUrl: backendUrl || '',
        engineToken: backendToken || '',
        context: {
          ...snapshot.contextPayload,
          params,
        },
      }),
    });

    if (res.status === 404 || res.status === 501) {
      return { output: null, missingScientificPkg: false };
    }

    const body = (await res.json()) as {
      ok?: boolean;
      stdout?: string;
      stderr?: string;
      error?: string;
      figures?: Array<{ label?: string; base64Png?: string; data?: string }>;
      variables?: Record<string, unknown>;
      proposedAnnotations?: Array<{
        soundfile?: string;
        channel?: number;
        startTimeSec: number;
        endTimeSec: number;
        lowFreqHz: number;
        highFreqHz: number;
        comment?: string;
        notes?: string;
      }>;
    };

    if (
      body.ok === false &&
      typeof body.error === 'string' &&
      /ModuleNotFoundError:\s+No module named ['"](?:numpy|scipy|matplotlib)['"]/i.test(body.error)
    ) {
      return { output: null, missingScientificPkg: true };
    }

    if (!res.ok || body.ok === false) {
      return {
        missingScientificPkg: false,
        output: {
          status: 'error',
          error: body.error || body.stderr || `Python kernel error (${res.status})`,
          stdout: body.stdout,
          executionMode: 'local-python-kernel',
        },
      };
    }

    const figures: NotebookFigure[] = Array.isArray(body.figures)
      ? body.figures
          .map((f, idx) => ({
            label: f.label || `Figure ${idx + 1}`,
            base64Png: f.base64Png || f.data || '',
          }))
          .filter((f) => Boolean(f.base64Png))
      : [];

    const fallbackSoundfile =
      snapshot.file?.name ||
      (snapshot.contextPayload?.file as { name?: string } | undefined)?.name ||
      '';

    const proposedAnnotations: ProposedAnnotation[] = Array.isArray(body.proposedAnnotations)
      ? body.proposedAnnotations.map((a, idx) => ({
          id: `prop_${cell.id}_${idx}_${Date.now()}`,
          soundfile: a.soundfile || fallbackSoundfile,
          channel: a.channel ?? 1,
          startTimeSec: a.startTimeSec,
          endTimeSec: a.endTimeSec,
          lowFreqHz: a.lowFreqHz,
          highFreqHz: a.highFreqHz,
          comment: a.comment ?? '',
          notes: a.notes,
          sourceCellId: cell.id,
          accepted: true,
        }))
      : [];

    return {
      missingScientificPkg: false,
      output: {
        status: 'done',
        stdout: [body.stdout, body.stderr].filter(Boolean).join('\n'),
        figures,
        variables: body.variables ?? {},
        proposedAnnotations,
        executionMode: 'local-python-kernel',
      },
    };
  } catch {
    return { output: null, missingScientificPkg: false };
  }
}

async function executeSingleCellInternal(
  nb: SyrinxNotebook,
  cell: NotebookCell,
  params: Record<string, string | number | boolean>,
  snapshot: ActiveAcousticSnapshot,
  acc: AccumulatedRunState,
): Promise<CellOutput> {
  const started = performance.now();

  if (cell.kind === 'markdown') {
    const rendered = interpolateTemplate(cell.source, params, acc.variables);
    acc.markdownHistory.push(rendered);
    return {
      status: 'done',
      markdown: rendered,
      durationMs: Math.round(performance.now() - started),
      executionMode: 'markdown',
    };
  }

  if (cell.kind === 'python') {
    const code = interpolateTemplate(cell.source, params, acc.variables);
    const remoteOut = await tryRemotePythonKernel(nb.id, cell, code, params, snapshot);
    if (remoteOut) {
      if (remoteOut.variables) Object.assign(acc.variables, remoteOut.variables);
      if (remoteOut.stdout) acc.stdoutHistory.push(remoteOut.stdout);
      if (remoteOut.figures) acc.figures.push(...remoteOut.figures);
      if (remoteOut.proposedAnnotations) acc.proposedAnnotations.push(...remoteOut.proposedAnnotations);
      return {
        ...remoteOut,
        durationMs: Math.round(performance.now() - started),
      };
    }

    const localRes = await tryLocalPythonKernel(nb.id, cell, code, params, snapshot);
    if (localRes.output) {
      if (localRes.output.variables) Object.assign(acc.variables, localRes.output.variables);
      if (localRes.output.stdout) acc.stdoutHistory.push(localRes.output.stdout);
      if (localRes.output.figures) acc.figures.push(...localRes.output.figures);
      if (localRes.output.proposedAnnotations) {
        acc.proposedAnnotations.push(...localRes.output.proposedAnnotations);
      }
      return {
        ...localRes.output,
        durationMs: Math.round(performance.now() - started),
      };
    }

    // Fallback: synthesize real DSP metrics & diagnostic plots from cached SyrinxOne workspace data
    const preview = buildDspPreviewDiagnostics(snapshot, code);
    Object.assign(acc.variables, preview.variables);
    const note = localRes.missingScientificPkg
      ? '[DSP Preview Mode — local Python 3 kernel lacks numpy/matplotlib; connect /api/python/kernel/exec on your DSP server for full numpy/scipy plots]'
      : '[DSP Preview Mode — connect /api/python/kernel/exec on your DSP server for full scientific Python libraries]';
    const stdout = [preview.stdout, note].filter(Boolean).join('\n\n');
    acc.stdoutHistory.push(stdout);
    acc.figures.push(...preview.figures);

    return {
      status: 'done',
      stdout,
      figures: preview.figures,
      variables: preview.variables,
      durationMs: Math.round(performance.now() - started),
      executionMode: 'dsp-preview',
    };
  }

  // AI Prompt Cell
  const prompt = interpolateTemplate(cell.source, params, acc.variables);
  const res = await fetch('/api/local/ai/notebook-cell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      notebookTitle: nb.title,
      cellTitle: cell.title,
      scope: nb.scope,
      parameters: params,
      acousticContext: snapshot.contextPayload,
      priorVariables: acc.variables,
      priorStdout: acc.stdoutHistory.join('\n\n'),
      priorMarkdown: acc.markdownHistory,
      spectrogramImageBase64: snapshot.spectrogramImageBase64,
      figuresBase64: acc.figures.slice(-4).map((f) => ({ label: f.label, data: f.base64Png })),
    }),
  });

  const body = (await res.json()) as {
    markdown?: string;
    modelUsed?: string;
    error?: string;
    variables?: Record<string, unknown>;
    proposedAnnotations?: Array<{
      soundfile?: string;
      channel?: number;
      startTimeSec: number;
      endTimeSec: number;
      lowFreqHz: number;
      highFreqHz: number;
      comment?: string;
      notes?: string;
    }>;
  };

  if (!res.ok) {
    return {
      status: 'error',
      error: body.error || `Gemini AI cell failed (${res.status})`,
      durationMs: Math.round(performance.now() - started),
      executionMode: 'gemini-ai',
    };
  }

  if (body.variables) Object.assign(acc.variables, body.variables);
  if (body.markdown) acc.markdownHistory.push(body.markdown);

  const proposedAnnotations: ProposedAnnotation[] = Array.isArray(body.proposedAnnotations)
    ? body.proposedAnnotations.map((a, idx) => ({
        id: `prop_${cell.id}_${idx}_${Date.now()}`,
        soundfile: a.soundfile || snapshot.file?.name || '',
        channel: a.channel ?? 1,
        startTimeSec: a.startTimeSec,
        endTimeSec: a.endTimeSec,
        lowFreqHz: a.lowFreqHz,
        highFreqHz: a.highFreqHz,
        comment: a.comment ?? '',
        notes: a.notes,
        sourceCellId: cell.id,
        accepted: true,
      }))
    : [];

  acc.proposedAnnotations.push(...proposedAnnotations);

  return {
    status: 'done',
    markdown: body.markdown,
    variables: body.variables,
    proposedAnnotations,
    modelUsed: body.modelUsed,
    durationMs: Math.round(performance.now() - started),
    executionMode: 'gemini-ai',
  };
}

function collectPriorState(nb: SyrinxNotebook, stopBeforeCellId: string): AccumulatedRunState {
  const acc: AccumulatedRunState = {
    variables: {},
    stdoutHistory: [],
    markdownHistory: [],
    figures: [],
    proposedAnnotations: [],
  };
  for (const c of nb.cells) {
    if (c.id === stopBeforeCellId) break;
    if (!c.enabled || !c.output) continue;
    if (c.output.variables) Object.assign(acc.variables, c.output.variables);
    if (c.output.stdout) acc.stdoutHistory.push(c.output.stdout);
    if (c.output.markdown) acc.markdownHistory.push(c.output.markdown);
    if (c.output.figures) acc.figures.push(...c.output.figures);
  }
  return acc;
}

export async function runNotebookCell(notebookId: string, cellId: string): Promise<void> {
  const store = useNotebookStore.getState();
  const nb = store.notebooks.find((n) => n.id === notebookId);
  const cell = nb?.cells.find((c) => c.id === cellId);
  if (!nb || !cell) return;

  store.setCellOutput(notebookId, cellId, { status: 'running' });

  const snapshot = captureActiveAcousticSnapshot(nb.scope);
  const params = store.getEffectiveParams(notebookId);
  const acc = collectPriorState(nb, cellId);

  try {
    const output = await executeSingleCellInternal(nb, cell, params, snapshot, acc);
    useNotebookStore.getState().setCellOutput(notebookId, cellId, output);
  } catch (err) {
    useNotebookStore.getState().setCellOutput(notebookId, cellId, {
      status: 'error',
      error: err instanceof Error ? err.message : 'Cell execution failed',
    });
  }
}

export async function runNotebookAllCells(notebookId: string): Promise<void> {
  const store = useNotebookStore.getState();
  const nb = store.notebooks.find((n) => n.id === notebookId);
  if (!nb) return;

  const snapshot = captureActiveAcousticSnapshot(nb.scope);
  const params = store.getEffectiveParams(notebookId);
  const acc: AccumulatedRunState = {
    variables: {},
    stdoutHistory: [],
    markdownHistory: [],
    figures: [],
    proposedAnnotations: [],
  };

  for (const cell of nb.cells) {
    if (!cell.enabled) continue;
    useNotebookStore.getState().setCellOutput(notebookId, cell.id, { status: 'running' });
    try {
      const output = await executeSingleCellInternal(nb, cell, params, snapshot, acc);
      useNotebookStore.getState().setCellOutput(notebookId, cell.id, output);
      if (output.status === 'error') break;
    } catch (err) {
      useNotebookStore.getState().setCellOutput(notebookId, cell.id, {
        status: 'error',
        error: err instanceof Error ? err.message : 'Cell execution failed',
      });
      break;
    }
  }
}

export async function runNotebookAsScript(notebookId: string): Promise<void> {
  const store = useNotebookStore.getState();
  const nb = store.notebooks.find((n) => n.id === notebookId);
  if (!nb) return;

  const enabledCells = nb.cells.filter((c) => c.enabled);
  const snapshot = captureActiveAcousticSnapshot(nb.scope);
  const params = store.getEffectiveParams(notebookId);
  const acc: AccumulatedRunState = {
    variables: {},
    stdoutHistory: [],
    markdownHistory: [],
    figures: [],
    proposedAnnotations: [],
  };

  const runId = `run_${Date.now()}`;
  const initialRun: ScriptRunResult = {
    runId,
    notebookId: nb.id,
    notebookTitle: nb.title,
    scope: nb.scope,
    startedAt: Date.now(),
    status: 'running',
    currentStepIndex: 0,
    totalSteps: enabledCells.length,
    contextSummary: snapshot.summary,
    cellResults: [],
    proposedAnnotations: [],
  };

  store.setActiveScriptRun(initialRun, true);

  const items: ScriptCellRunItem[] = [];
  let failedError: string | undefined;

  for (let idx = 0; idx < enabledCells.length; idx++) {
    const cell = enabledCells[idx];
    useNotebookStore.getState().setActiveScriptRun(
      {
        ...initialRun,
        currentStepIndex: idx + 1,
        cellResults: [...items],
        proposedAnnotations: [...acc.proposedAnnotations],
      },
      true,
    );

    try {
      const output = await executeSingleCellInternal(nb, cell, params, snapshot, acc);
      items.push({
        cellId: cell.id,
        cellKind: cell.kind,
        cellTitle: cell.title || `Step ${idx + 1} (${cell.kind})`,
        source: cell.source,
        output,
      });
      if (output.status === 'error') {
        failedError = output.error || 'Step failed';
        break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Step execution failed';
      items.push({
        cellId: cell.id,
        cellKind: cell.kind,
        cellTitle: cell.title || `Step ${idx + 1} (${cell.kind})`,
        source: cell.source,
        output: { status: 'error', error: msg },
      });
      failedError = msg;
      break;
    }
  }

  useNotebookStore.getState().setActiveScriptRun(
    {
      ...initialRun,
      finishedAt: Date.now(),
      status: failedError ? 'error' : 'done',
      currentStepIndex: enabledCells.length,
      cellResults: items,
      proposedAnnotations: acc.proposedAnnotations,
      error: failedError,
    },
    true,
  );
}

export async function restartNotebookKernel(notebookId: string): Promise<void> {
  const { backendUrl, backendToken } = useWorkspaceStore.getState();
  if (backendUrl) {
    try {
      const r = await fetch(`${backendUrl}/api/python/kernel/restart`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(backendToken ? { Authorization: `Bearer ${backendToken}` } : {}),
        },
        body: JSON.stringify({ notebookId }),
      });
      if (r.ok) return;
    } catch {
      // fall through to local kernel
    }
  }
  await fetch('/api/local/python/kernel/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notebookId }),
  });
}

export async function interruptNotebookKernel(notebookId: string): Promise<void> {
  const { backendUrl, backendToken } = useWorkspaceStore.getState();
  if (backendUrl) {
    try {
      const r = await fetch(`${backendUrl}/api/python/kernel/interrupt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(backendToken ? { Authorization: `Bearer ${backendToken}` } : {}),
        },
        body: JSON.stringify({ notebookId }),
      });
      if (r.ok) return;
    } catch {
      // fall through
    }
  }
  await fetch('/api/local/python/kernel/interrupt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notebookId }),
  });
}

export async function fetchNotebookKernelStatus(notebookId: string): Promise<{
  mode: 'remote' | 'local' | 'preview';
  pythonVersion?: string;
  packages?: Record<string, boolean>;
}> {
  const { backendUrl, backendToken } = useWorkspaceStore.getState();
  if (backendUrl) {
    try {
      const r = await fetch(
        `${backendUrl}/api/python/kernel/status?notebookId=${encodeURIComponent(notebookId)}`,
        {
          headers: backendToken ? { Authorization: `Bearer ${backendToken}` } : undefined,
        },
      );
      if (r.ok) {
        const b = (await r.json()) as { pythonVersion?: string; packages?: Record<string, boolean> };
        return { mode: 'remote', pythonVersion: b.pythonVersion, packages: b.packages };
      }
    } catch {
      // fall through
    }
  }
  try {
    const r = await fetch(
      `/api/local/python/kernel/status?notebookId=${encodeURIComponent(notebookId)}`,
    );
    if (r.ok) {
      const b = (await r.json()) as { pythonVersion?: string; packages?: Record<string, boolean> };
      return { mode: 'local', pythonVersion: b.pythonVersion, packages: b.packages };
    }
  } catch {
    // ignore
  }
  return { mode: 'preview' };
}

export function commitProposedAnnotationsToWorkspace(items: ProposedAnnotation[]): number {
  const accepted = items.filter((a) => a.accepted);
  if (accepted.length === 0) return 0;

  const ws = useWorkspaceStore.getState();
  const activeWin = ws.windows.find((w) => w.windowId === ws.activeWindowId) ?? ws.windows[0];
  const activeFile = activeWin ? ws.files[activeWin.fileId] : undefined;

  if (!activeFile && isDetachedNotebookTab()) {
    if (sendCommitAnnotationsToMainTab(accepted)) {
      return accepted.length;
    }
  }

  let count = 0;
  for (const ann of accepted) {
    ws.addAnnotation({
      soundfile: ann.soundfile || activeFile?.name || '',
      channel: ann.channel || 1,
      startTimeSec: ann.startTimeSec,
      endTimeSec: ann.endTimeSec,
      lowFreqHz: ann.lowFreqHz,
      highFreqHz: ann.highFreqHz,
      comment: ann.comment,
      notes: ann.notes ?? '',
      extraFields: {},
    });
    count++;
  }

  ws.setStatus(`Added ${count} annotation${count === 1 ? '' : 's'} from notebook output.`);
  return count;
}
