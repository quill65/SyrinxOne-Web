import type { NotebookCell, NotebookParameter, NotebookScope, SyrinxNotebook } from './types';

interface IpynbOutput {
  output_type: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
}

interface IpynbCell {
  cell_type: 'markdown' | 'code' | 'raw';
  metadata?: Record<string, unknown>;
  source: string | string[];
  execution_count?: number | null;
  outputs?: IpynbOutput[];
}

interface IpynbDocument {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: IpynbCell[];
}

function joinSource(src: string | string[] | undefined): string {
  if (Array.isArray(src)) return src.join('');
  return typeof src === 'string' ? src : '';
}

function splitLinesPreserve(src: string): string[] {
  if (!src) return [];
  return src.split(/(?<=\n)/);
}

export function exportNotebookToIpynb(nb: SyrinxNotebook): string {
  const cells: IpynbCell[] = nb.cells.map((cell) => {
    if (cell.kind === 'markdown') {
      return {
        cell_type: 'markdown',
        metadata: {
          syrinxone: {
            id: cell.id,
            title: cell.title ?? '',
            enabled: cell.enabled,
            cell_kind: 'markdown',
          },
        },
        source: splitLinesPreserve(cell.source),
      };
    }

    if (cell.kind === 'ai') {
      const outputs: IpynbOutput[] = [];
      if (cell.output?.markdown) {
        outputs.push({
          output_type: 'display_data',
          data: { 'text/markdown': splitLinesPreserve(cell.output.markdown) },
        });
      }
      return {
        cell_type: 'raw',
        metadata: {
          syrinxone: {
            id: cell.id,
            title: cell.title ?? '',
            enabled: cell.enabled,
            cell_kind: 'ai',
          },
          outputs,
        },
        source: splitLinesPreserve(cell.source),
      };
    }

    const outputs: IpynbOutput[] = [];
    if (cell.output?.stdout) {
      outputs.push({
        output_type: 'stream',
        name: 'stdout',
        text: splitLinesPreserve(cell.output.stdout),
      });
    }
    if (cell.output?.figures) {
      for (const fig of cell.output.figures) {
        outputs.push({
          output_type: 'display_data',
          data: {
            'image/png': fig.base64Png,
            'text/plain': [fig.label],
          },
        });
      }
    }
    if (cell.output?.error) {
      outputs.push({
        output_type: 'error',
        ename: 'ExecutionError',
        evalue: cell.output.error,
      });
    }

    return {
      cell_type: 'code',
      execution_count: cell.output?.status === 'done' ? 1 : null,
      metadata: {
        syrinxone: {
          id: cell.id,
          title: cell.title ?? '',
          enabled: cell.enabled,
          cell_kind: 'python',
        },
      },
      source: splitLinesPreserve(cell.source),
      outputs,
    };
  });

  const doc: IpynbDocument = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: 'SyrinxOne Python + Gemini',
        language: 'python',
        name: 'syrinxone',
      },
      language_info: {
        name: 'python',
        version: '3.11',
      },
      syrinxone_tool: {
        title: nb.title,
        description: nb.description,
        scope: nb.scope,
        pinToTools: nb.pinToTools,
        parameters: nb.parameters,
      },
    },
    cells,
  };

  return JSON.stringify(doc, null, 2);
}

export function importNotebookFromIpynb(
  rawJson: string,
  fallbackTitle = 'Imported Notebook',
): SyrinxNotebook {
  const parsed = JSON.parse(rawJson) as Partial<IpynbDocument>;
  if (!parsed || !Array.isArray(parsed.cells)) {
    throw new Error('Invalid .ipynb file: missing cells array.');
  }

  const toolMeta = (parsed.metadata?.syrinxone_tool ?? {}) as {
    title?: unknown;
    description?: unknown;
    scope?: unknown;
    pinToTools?: unknown;
    parameters?: unknown;
  };

  const scope: NotebookScope =
    toolMeta.scope === 'selection' ||
    toolMeta.scope === 'view' ||
    toolMeta.scope === 'recording' ||
    toolMeta.scope === 'folder'
      ? toolMeta.scope
      : 'recording';

  const parameters: NotebookParameter[] = Array.isArray(toolMeta.parameters)
    ? toolMeta.parameters
        .filter((p): p is NotebookParameter => Boolean(p && typeof p === 'object' && 'name' in p))
        .map((p) => ({
          name: String(p.name),
          label: typeof p.label === 'string' ? p.label : String(p.name),
          type: p.type === 'number' || p.type === 'boolean' ? p.type : 'string',
          defaultValue: p.defaultValue ?? '',
        }))
    : [];

  const cells: NotebookCell[] = parsed.cells.map((rawCell, idx) => {
    const syx = (rawCell.metadata?.syrinxone ?? {}) as {
      id?: unknown;
      title?: unknown;
      enabled?: unknown;
      cell_kind?: unknown;
    };

    let kind: NotebookCell['kind'] = 'python';
    if (syx.cell_kind === 'ai' || rawCell.cell_type === 'raw') {
      kind = 'ai';
    } else if (syx.cell_kind === 'markdown' || rawCell.cell_type === 'markdown') {
      kind = 'markdown';
    }

    const figures = Array.isArray(rawCell.outputs)
      ? rawCell.outputs
          .map((out, fIdx) => {
            const img = out.data?.['image/png'];
            const b64 = Array.isArray(img) ? img.join('') : typeof img === 'string' ? img : '';
            if (!b64) return null;
            const txt = out.data?.['text/plain'];
            const label = Array.isArray(txt) ? txt.join('') : typeof txt === 'string' ? txt : `Figure ${fIdx + 1}`;
            return { label, base64Png: b64.replace(/\s+/g, '') };
          })
          .filter((x): x is { label: string; base64Png: string } => x !== null)
      : undefined;

    const stdout = Array.isArray(rawCell.outputs)
      ? rawCell.outputs
          .filter((o) => o.output_type === 'stream')
          .map((o) => joinSource(o.text))
          .join('')
      : undefined;

    return {
      id: typeof syx.id === 'string' && syx.id ? syx.id : `cell_${Date.now()}_${idx}`,
      kind,
      title: typeof syx.title === 'string' && syx.title ? syx.title : undefined,
      source: joinSource(rawCell.source),
      enabled: syx.enabled !== false,
      output:
        stdout || (figures && figures.length > 0)
          ? {
              status: 'done',
              stdout: stdout || undefined,
              figures: figures && figures.length > 0 ? figures : undefined,
            }
          : undefined,
    };
  });

  const now = Date.now();
  return {
    id: `nb_${now}_${Math.random().toString(36).slice(2, 7)}`,
    title: typeof toolMeta.title === 'string' && toolMeta.title.trim() ? toolMeta.title.trim() : fallbackTitle,
    description:
      typeof toolMeta.description === 'string'
        ? toolMeta.description
        : 'Imported Jupyter notebook',
    scope,
    pinToTools: Boolean(toolMeta.pinToTools),
    parameters,
    cells,
    createdAt: now,
    updatedAt: now,
  };
}
