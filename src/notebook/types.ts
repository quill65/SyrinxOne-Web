export type NotebookCellKind = 'markdown' | 'python' | 'ai';

export type NotebookScope = 'selection' | 'view' | 'recording' | 'folder';

export type NotebookParamType = 'number' | 'string' | 'boolean';

export interface NotebookParameter {
  name: string;
  label: string;
  type: NotebookParamType;
  defaultValue: string | number | boolean;
}

export interface NotebookFigure {
  label: string;
  base64Png: string;
}

export interface ProposedAnnotation {
  id: string;
  soundfile: string;
  channel: number;
  startTimeSec: number;
  endTimeSec: number;
  lowFreqHz: number;
  highFreqHz: number;
  comment: string;
  notes?: string;
  sourceCellId: string;
  accepted: boolean;
}

export interface CellOutput {
  status: 'idle' | 'running' | 'done' | 'error';
  stdout?: string;
  markdown?: string;
  error?: string;
  figures?: NotebookFigure[];
  variables?: Record<string, unknown>;
  proposedAnnotations?: ProposedAnnotation[];
  durationMs?: number;
  modelUsed?: string;
  executionMode?:
    | 'python-kernel'
    | 'local-python-kernel'
    | 'dsp-preview'
    | 'gemini-ai'
    | 'markdown';
}

export interface NotebookCell {
  id: string;
  kind: NotebookCellKind;
  title?: string;
  source: string;
  enabled: boolean;
  output?: CellOutput;
}

export interface SyrinxNotebook {
  id: string;
  title: string;
  description: string;
  scope: NotebookScope;
  pinToTools: boolean;
  parameters: NotebookParameter[];
  cells: NotebookCell[];
  createdAt: number;
  updatedAt: number;
  isBuiltIn?: boolean;
}

export interface NotebookContextSummary {
  fileName: string;
  fileId: string;
  sampleRate: number;
  numChannels: number;
  durationSec: number;
  scopeLabel: string;
  hasSelection: boolean;
}

export interface ScriptCellRunItem {
  cellId: string;
  cellKind: NotebookCellKind;
  cellTitle: string;
  source: string;
  output: CellOutput;
}

export interface ScriptRunResult {
  runId: string;
  notebookId: string;
  notebookTitle: string;
  scope: NotebookScope;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'error';
  currentStepIndex: number;
  totalSteps: number;
  contextSummary: NotebookContextSummary | null;
  cellResults: ScriptCellRunItem[];
  proposedAnnotations: ProposedAnnotation[];
  appliedCount?: number;
  error?: string;
}
