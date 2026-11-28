import { create } from 'zustand';
import { createStarterNotebooks } from './starterNotebooks';
import { exportNotebookToIpynb, importNotebookFromIpynb } from './ipynb';
import type {
  CellOutput,
  NotebookCell,
  NotebookCellKind,
  NotebookParameter,
  NotebookScope,
  ScriptRunResult,
  SyrinxNotebook,
} from './types';

const NOTEBOOKS_STORAGE_KEY = 'syrinxone.notebooks.v1';
const ACTIVE_NOTEBOOK_STORAGE_KEY = 'syrinxone.activeNotebookId.v1';

function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function loadSavedNotebooks(): SyrinxNotebook[] {
  try {
    const raw = localStorage.getItem(NOTEBOOKS_STORAGE_KEY);
    if (!raw) return createStarterNotebooks();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return createStarterNotebooks();
    }
    return parsed as SyrinxNotebook[];
  } catch {
    return createStarterNotebooks();
  }
}

function persistNotebooks(notebooks: SyrinxNotebook[]): void {
  try {
    // Strip large binary PNG outputs when persisting to localStorage to stay within quota
    const lightweight = notebooks.map((nb) => ({
      ...nb,
      cells: nb.cells.map((c) => ({
        ...c,
        output: c.output
          ? {
              ...c.output,
              figures: undefined,
            }
          : undefined,
      })),
    }));
    localStorage.setItem(NOTEBOOKS_STORAGE_KEY, JSON.stringify(lightweight));
  } catch {
    // ignore storage quota errors
  }
}

function loadActiveNotebookId(notebooks: SyrinxNotebook[]): string {
  try {
    const saved = localStorage.getItem(ACTIVE_NOTEBOOK_STORAGE_KEY);
    if (saved && notebooks.some((n) => n.id === saved)) return saved;
  } catch {
    // ignore
  }
  return notebooks[0]?.id ?? '';
}

interface NotebookStoreState {
  notebooks: SyrinxNotebook[];
  activeNotebookId: string;
  paramOverrides: Record<string, Record<string, string | number | boolean>>;
  activeScriptRun: ScriptRunResult | null;
  isScriptModalOpen: boolean;

  setActiveNotebook: (id: string) => void;
  createNotebook: (partial?: Partial<Pick<SyrinxNotebook, 'title' | 'description' | 'scope' | 'pinToTools'>>) => SyrinxNotebook;
  duplicateNotebook: (id: string) => SyrinxNotebook | null;
  deleteNotebook: (id: string) => void;
  resetStarterNotebooks: () => void;
  updateNotebookMeta: (
    id: string,
    patch: Partial<Pick<SyrinxNotebook, 'title' | 'description' | 'scope' | 'pinToTools' | 'parameters'>>,
  ) => void;

  addCell: (
    notebookId: string,
    kind: NotebookCellKind,
    options?: { afterCellId?: string; title?: string; source?: string },
  ) => NotebookCell;
  updateCell: (
    notebookId: string,
    cellId: string,
    patch: Partial<Pick<NotebookCell, 'kind' | 'title' | 'source' | 'enabled'>>,
  ) => void;
  deleteCell: (notebookId: string, cellId: string) => void;
  moveCell: (notebookId: string, cellId: string, direction: -1 | 1) => void;
  setCellOutput: (notebookId: string, cellId: string, output: CellOutput) => void;
  clearNotebookOutputs: (notebookId: string) => void;
  toggleProposedAnnotationInCell: (notebookId: string, cellId: string, annId: string) => void;

  setParamOverride: (notebookId: string, name: string, value: string | number | boolean) => void;
  getEffectiveParams: (notebookId: string) => Record<string, string | number | boolean>;

  importIpynb: (rawJson: string, fallbackTitle?: string) => SyrinxNotebook;
  exportIpynb: (notebookId: string) => string;

  setActiveScriptRun: (run: ScriptRunResult | null, openModal?: boolean) => void;
  setScriptModalOpen: (open: boolean) => void;
  toggleScriptProposedAnnotation: (annId: string) => void;
  markScriptAnnotationsApplied: (appliedCount: number) => void;
}

const initialNotebooks = loadSavedNotebooks();

export const useNotebookStore = create<NotebookStoreState>((set, get) => ({
  notebooks: initialNotebooks,
  activeNotebookId: loadActiveNotebookId(initialNotebooks),
  paramOverrides: {},
  activeScriptRun: null,
  isScriptModalOpen: false,

  setActiveNotebook: (id) => {
    try {
      localStorage.setItem(ACTIVE_NOTEBOOK_STORAGE_KEY, id);
    } catch {
      // ignore
    }
    set({ activeNotebookId: id });
  },

  createNotebook: (partial) => {
    const now = Date.now();
    const nb: SyrinxNotebook = {
      id: uid('nb'),
      title: partial?.title?.trim() || 'Untitled Analysis Notebook',
      description: partial?.description || 'Custom Python + Gemini bioacoustic notebook',
      scope: partial?.scope ?? ('recording' as NotebookScope),
      pinToTools: partial?.pinToTools ?? true,
      parameters: [] as NotebookParameter[],
      cells: [
        {
          id: uid('cell'),
          kind: 'markdown',
          title: 'Notes',
          enabled: true,
          source: '## Acoustic Analysis Notebook\nDescribe your workflow goal here.',
        },
        {
          id: uid('cell'),
          kind: 'python',
          title: 'Inspect Recording Data',
          enabled: true,
          source: `import numpy as np\nctx = syrinx.context\nprint(f"Loaded {ctx['name']} ({ctx['sampleRate']} Hz, {ctx['numChannels']} ch)")`,
        },
        {
          id: uid('cell'),
          kind: 'ai',
          title: 'Gemini Interpretation',
          enabled: true,
          source:
            'Summarize the acoustic structure of this recording and propose annotation boxes if clear calls are present.',
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    set((s) => {
      const notebooks = [nb, ...s.notebooks];
      persistNotebooks(notebooks);
      try {
        localStorage.setItem(ACTIVE_NOTEBOOK_STORAGE_KEY, nb.id);
      } catch {
        // ignore
      }
      return { notebooks, activeNotebookId: nb.id };
    });
    return nb;
  },

  duplicateNotebook: (id) => {
    const src = get().notebooks.find((n) => n.id === id);
    if (!src) return null;
    const now = Date.now();
    const copy: SyrinxNotebook = {
      ...src,
      id: uid('nb'),
      title: `${src.title} (Copy)`,
      isBuiltIn: false,
      createdAt: now,
      updatedAt: now,
      cells: src.cells.map((c) => ({ ...c, id: uid('cell'), output: undefined })),
    };
    set((s) => {
      const notebooks = [copy, ...s.notebooks];
      persistNotebooks(notebooks);
      return { notebooks, activeNotebookId: copy.id };
    });
    return copy;
  },

  deleteNotebook: (id) => {
    set((s) => {
      const remaining = s.notebooks.filter((n) => n.id !== id);
      const nextList = remaining.length > 0 ? remaining : createStarterNotebooks();
      persistNotebooks(nextList);
      const nextActive =
        s.activeNotebookId === id ? nextList[0]?.id ?? '' : s.activeNotebookId;
      return { notebooks: nextList, activeNotebookId: nextActive };
    });
  },

  resetStarterNotebooks: () => {
    const starters = createStarterNotebooks();
    set((s) => {
      const custom = s.notebooks.filter((n) => !n.isBuiltIn);
      const notebooks = [...starters, ...custom];
      persistNotebooks(notebooks);
      return { notebooks, activeNotebookId: notebooks[0]?.id ?? s.activeNotebookId };
    });
  },

  updateNotebookMeta: (id, patch) => {
    set((s) => {
      const notebooks = s.notebooks.map((nb) =>
        nb.id === id ? { ...nb, ...patch, updatedAt: Date.now() } : nb,
      );
      persistNotebooks(notebooks);
      return { notebooks };
    });
  },

  addCell: (notebookId, kind, options) => {
    const defaultSource =
      kind === 'markdown'
        ? '### Section Title\nAdd notes or methodology here.'
        : kind === 'ai'
          ? 'Analyze the preceding Python metrics, figures, and spectrogram. Highlight key bioacoustic findings.'
          : 'import numpy as np\nctx = syrinx.context\nprint(ctx["name"])';

    const newCell: NotebookCell = {
      id: uid('cell'),
      kind,
      title: options?.title,
      source: options?.source ?? defaultSource,
      enabled: true,
    };

    set((s) => {
      const notebooks = s.notebooks.map((nb) => {
        if (nb.id !== notebookId) return nb;
        const cells = [...nb.cells];
        if (options?.afterCellId) {
          const idx = cells.findIndex((c) => c.id === options.afterCellId);
          if (idx >= 0) {
            cells.splice(idx + 1, 0, newCell);
          } else {
            cells.push(newCell);
          }
        } else {
          cells.push(newCell);
        }
        return { ...nb, cells, updatedAt: Date.now() };
      });
      persistNotebooks(notebooks);
      return { notebooks };
    });

    return newCell;
  },

  updateCell: (notebookId, cellId, patch) => {
    set((s) => {
      const notebooks = s.notebooks.map((nb) => {
        if (nb.id !== notebookId) return nb;
        return {
          ...nb,
          updatedAt: Date.now(),
          cells: nb.cells.map((c) => (c.id === cellId ? { ...c, ...patch } : c)),
        };
      });
      persistNotebooks(notebooks);
      return { notebooks };
    });
  },

  deleteCell: (notebookId, cellId) => {
    set((s) => {
      const notebooks = s.notebooks.map((nb) => {
        if (nb.id !== notebookId) return nb;
        return {
          ...nb,
          updatedAt: Date.now(),
          cells: nb.cells.filter((c) => c.id !== cellId),
        };
      });
      persistNotebooks(notebooks);
      return { notebooks };
    });
  },

  moveCell: (notebookId, cellId, direction) => {
    set((s) => {
      const notebooks = s.notebooks.map((nb) => {
        if (nb.id !== notebookId) return nb;
        const idx = nb.cells.findIndex((c) => c.id === cellId);
        const target = idx + direction;
        if (idx < 0 || target < 0 || target >= nb.cells.length) return nb;
        const nextCells = [...nb.cells];
        const [item] = nextCells.splice(idx, 1);
        nextCells.splice(target, 0, item);
        return { ...nb, cells: nextCells, updatedAt: Date.now() };
      });
      persistNotebooks(notebooks);
      return { notebooks };
    });
  },

  setCellOutput: (notebookId, cellId, output) => {
    set((s) => ({
      notebooks: s.notebooks.map((nb) =>
        nb.id === notebookId
          ? {
              ...nb,
              cells: nb.cells.map((c) => (c.id === cellId ? { ...c, output } : c)),
            }
          : nb,
      ),
    }));
  },

  clearNotebookOutputs: (notebookId) => {
    set((s) => ({
      notebooks: s.notebooks.map((nb) =>
        nb.id === notebookId
          ? { ...nb, cells: nb.cells.map((c) => ({ ...c, output: undefined })) }
          : nb,
      ),
    }));
  },

  toggleProposedAnnotationInCell: (notebookId, cellId, annId) => {
    set((s) => ({
      notebooks: s.notebooks.map((nb) => {
        if (nb.id !== notebookId) return nb;
        return {
          ...nb,
          cells: nb.cells.map((c) => {
            if (c.id !== cellId || !c.output?.proposedAnnotations) return c;
            return {
              ...c,
              output: {
                ...c.output,
                proposedAnnotations: c.output.proposedAnnotations.map((a) =>
                  a.id === annId ? { ...a, accepted: !a.accepted } : a,
                ),
              },
            };
          }),
        };
      }),
    }));
  },

  setParamOverride: (notebookId, name, value) => {
    set((s) => ({
      paramOverrides: {
        ...s.paramOverrides,
        [notebookId]: {
          ...(s.paramOverrides[notebookId] ?? {}),
          [name]: value,
        },
      },
    }));
  },

  getEffectiveParams: (notebookId) => {
    const nb = get().notebooks.find((n) => n.id === notebookId);
    const overrides = get().paramOverrides[notebookId] ?? {};
    const out: Record<string, string | number | boolean> = {};
    if (nb) {
      for (const p of nb.parameters) {
        out[p.name] = p.name in overrides ? overrides[p.name] : p.defaultValue;
      }
    }
    return out;
  },

  importIpynb: (rawJson, fallbackTitle) => {
    const nb = importNotebookFromIpynb(rawJson, fallbackTitle);
    set((s) => {
      const notebooks = [nb, ...s.notebooks];
      persistNotebooks(notebooks);
      return { notebooks, activeNotebookId: nb.id };
    });
    return nb;
  },

  exportIpynb: (notebookId) => {
    const nb = get().notebooks.find((n) => n.id === notebookId);
    if (!nb) throw new Error('Notebook not found');
    return exportNotebookToIpynb(nb);
  },

  setActiveScriptRun: (run, openModal) => {
    set((s) => ({
      activeScriptRun: run,
      isScriptModalOpen: openModal !== undefined ? openModal : s.isScriptModalOpen,
    }));
  },

  setScriptModalOpen: (open) => set({ isScriptModalOpen: open }),

  toggleScriptProposedAnnotation: (annId) => {
    set((s) => {
      if (!s.activeScriptRun) return {};
      return {
        activeScriptRun: {
          ...s.activeScriptRun,
          proposedAnnotations: s.activeScriptRun.proposedAnnotations.map((a) =>
            a.id === annId ? { ...a, accepted: !a.accepted } : a,
          ),
        },
      };
    });
  },

  markScriptAnnotationsApplied: (appliedCount) => {
    set((s) => {
      if (!s.activeScriptRun) return {};
      return {
        activeScriptRun: {
          ...s.activeScriptRun,
          appliedCount,
        },
      };
    });
  },
}));
