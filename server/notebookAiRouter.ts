import { Router } from 'express';
import { GoogleGenAI, Type, type Part } from '@google/genai';

const ALLOWED_MODELS = new Set([
  'gemini-4-hydrogen',
  'gemini-4-neon',
  'gemini-3.1-flash-lite',
]);

function isValidBase64Png(val: unknown): val is string {
  return typeof val === 'string' && val.length > 0 && val.length <= 6_000_000;
}

interface ProposedAnnotationRaw {
  soundfile?: unknown;
  channel?: unknown;
  startTimeSec?: unknown;
  endTimeSec?: unknown;
  lowFreqHz?: unknown;
  highFreqHz?: unknown;
  comment?: unknown;
  notes?: unknown;
}

interface NotebookCellRequestBody {
  prompt?: string;
  model?: string;
  notebookTitle?: string;
  cellTitle?: string;
  scope?: string;
  parameters?: Record<string, unknown>;
  acousticContext?: Record<string, unknown>;
  priorVariables?: Record<string, unknown>;
  priorStdout?: string;
  priorMarkdown?: string[];
  spectrogramImageBase64?: string;
  figuresBase64?: Array<{ label?: string; data?: string }>;
}

interface NotebookCopilotRequestBody {
  instruction?: string;
  model?: string;
  notebookTitle?: string;
  notebookDescription?: string;
  scope?: string;
  cells?: Array<{ kind?: string; title?: string; source?: string }>;
  acousticContext?: Record<string, unknown>;
}

function sanitizeProposedAnnotations(
  rawList: unknown,
  defaultSoundfile?: string,
): Array<{
  soundfile: string;
  channel: number;
  startTimeSec: number;
  endTimeSec: number;
  lowFreqHz: number;
  highFreqHz: number;
  comment: string;
  notes?: string;
}> {
  if (!Array.isArray(rawList)) return [];
  const out: Array<{
    soundfile: string;
    channel: number;
    startTimeSec: number;
    endTimeSec: number;
    lowFreqHz: number;
    highFreqHz: number;
    comment: string;
    notes?: string;
  }> = [];

  for (const item of rawList.slice(0, 60)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as ProposedAnnotationRaw;
    const s = Number(r.startTimeSec);
    const e = Number(r.endTimeSec);
    const lo = Number(r.lowFreqHz);
    const hi = Number(r.highFreqHz);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) continue;
    const ch = Number(r.channel);
    out.push({
      soundfile:
        typeof r.soundfile === 'string' && r.soundfile.trim()
          ? r.soundfile.trim()
          : defaultSoundfile || '',
      channel: Number.isFinite(ch) && ch >= 1 ? Math.round(ch) : 1,
      startTimeSec: Math.max(0, s),
      endTimeSec: Math.max(0, e),
      lowFreqHz: Math.max(0, lo),
      highFreqHz: Math.max(0, hi),
      comment: typeof r.comment === 'string' ? r.comment.trim() : '',
      notes: typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : undefined,
    });
  }
  return out;
}

function parseNotebookCellOutput(
  rawText: string,
  defaultSoundfile?: string,
): {
  markdown: string;
  proposedAnnotations: ReturnType<typeof sanitizeProposedAnnotations>;
  variables: Record<string, unknown>;
} {
  let text = rawText.trim();
  let proposedAnnotations: ReturnType<typeof sanitizeProposedAnnotations> = [];
  let variables: Record<string, unknown> = {};

  const actionMatch = text.match(/<syrinx_notebook_actions>([\s\S]*?)<\/syrinx_notebook_actions>/i);
  if (actionMatch) {
    text = text.replace(actionMatch[0], '').trim();
    try {
      const parsed = JSON.parse(actionMatch[1].trim()) as {
        proposedAnnotations?: unknown;
        variables?: unknown;
      };
      proposedAnnotations = sanitizeProposedAnnotations(
        parsed.proposedAnnotations,
        defaultSoundfile,
      );
      if (
        parsed.variables &&
        typeof parsed.variables === 'object' &&
        !Array.isArray(parsed.variables)
      ) {
        variables = parsed.variables as Record<string, unknown>;
      }
    } catch {
      // ignore malformed optional action JSON
    }
  }

  return {
    markdown: text || 'No output returned.',
    proposedAnnotations,
    variables,
  };
}

const NOTEBOOK_CELL_SYSTEM = [
  'You are an AI Analytic Step inside a SyrinxOne Bioacoustics Notebook/Script.',
  'You receive real acoustic context from the user’s open recording (metadata, selection/view bounds, DSP metrics, annotations, spectrogram PNG) plus outputs, variables, and matplotlib figures produced by earlier Python cells in this notebook.',
  'Ground every quantitative statement strictly in the provided measurements, Python outputs, and images. Never invent numbers.',
  'Format your answer as clear, concise Markdown suitable for a scientific analysis report.',
  'When the prompt asks to log events, propose annotations, or return structured variables for downstream cells, optionally end your response with ONE block:',
  '<syrinx_notebook_actions>{"proposedAnnotations":[{"soundfile":"file.wav","channel":1,"startTimeSec":1.2,"endTimeSec":2.1,"lowFreqHz":1200,"highFreqHz":4800,"comment":"species_or_label","notes":"rationale"}],"variables":{"key":"value"}}</syrinx_notebook_actions>',
].join('\n');

const NOTEBOOK_COPILOT_SYSTEM = [
  'You are the SyrinxOne Notebook Copilot, helping bioacoustics researchers build reusable Python + Gemini analytic notebooks that can also run headlessly as SyrinxOne Tools.',
  'Python cells run with an injected `syrinx` helper object containing:',
  '  - syrinx.context (dict: fileId, name, sampleRate, numChannels, durationSec, selection, viewRange, specParams, params, annotations)',
  '  - syrinx.spectrogram(channel=0, start_sec=None, end_sec=None) -> returns dict/matrix from engine',
  '  - syrinx.propose_annotation(start_sec, end_sec, low_hz, high_hz, channel=1, comment="", notes="")',
  '  - syrinx.emit_figure(fig_or_plt, label="Figure")',
  '  - syrinx.set_var(name, value) (persisted for downstream Python & AI cells)',
  'AI Prompt cells run Gemini with all prior variables, stdout, and figures automatically attached.',
  'Keep Python code clean, self-contained, and well-commented using numpy, scipy, matplotlib, and syrinx.',
].join('\n');

export const notebookAiRouter = Router();

notebookAiRouter.post('/api/local/ai/notebook-cell', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    res.status(400).json({
      code: 'MISSING_GEMINI_API_KEY',
      error:
        'GEMINI_API_KEY is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets to execute AI notebook cells.',
    });
    return;
  }

  const body = (req.body ?? {}) as NotebookCellRequestBody;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    res.status(400).json({ error: 'Cell prompt is required.' });
    return;
  }

  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : 'gemini-4-hydrogen';

  const sections: string[] = [];
  if (body.notebookTitle) {
    sections.push(
      `Notebook: "${body.notebookTitle}"${body.cellTitle ? ` | Cell: "${body.cellTitle}"` : ''}${body.scope ? ` | Scope: ${body.scope}` : ''}`,
    );
  }
  if (body.parameters && Object.keys(body.parameters).length > 0) {
    sections.push(`Script Parameters:\n${JSON.stringify(body.parameters, null, 2)}`);
  }
  if (body.acousticContext) {
    sections.push(`Active SyrinxOne Recording Context:\n${JSON.stringify(body.acousticContext, null, 2)}`);
  }
  if (body.priorVariables && Object.keys(body.priorVariables).length > 0) {
    sections.push(
      `Variables Produced by Earlier Cells:\n${JSON.stringify(body.priorVariables, null, 2).slice(0, 12000)}`,
    );
  }
  if (typeof body.priorStdout === 'string' && body.priorStdout.trim()) {
    sections.push(`Earlier Python Stdout:\n${body.priorStdout.slice(0, 6000)}`);
  }
  if (Array.isArray(body.priorMarkdown) && body.priorMarkdown.length > 0) {
    sections.push(`Earlier Cell Summaries:\n${body.priorMarkdown.join('\n---\n').slice(0, 6000)}`);
  }
  sections.push(`AI Cell Instruction:\n${prompt}`);

  const parts: Part[] = [{ text: sections.join('\n\n') }];

  if (isValidBase64Png(body.spectrogramImageBase64)) {
    parts.push({ text: '[Spectrogram PNG from active SyrinxOne view/selection]' });
    parts.push({
      inlineData: {
        mimeType: 'image/png',
        data: body.spectrogramImageBase64,
      },
    });
  }

  if (Array.isArray(body.figuresBase64)) {
    for (const fig of body.figuresBase64.slice(0, 4)) {
      if (!fig || !isValidBase64Png(fig.data)) continue;
      parts.push({ text: `[Figure produced by prior cell: ${fig.label || 'Plot'}]` });
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: fig.data,
        },
      });
    }
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: NOTEBOOK_CELL_SYSTEM,
      },
    });

    const activeFile = body.acousticContext?.file as { name?: string } | undefined;
    const parsed = parseNotebookCellOutput(response.text ?? '', activeFile?.name);

    res.json({
      status: 'done',
      modelUsed: model,
      ...parsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Notebook AI cell execution failed';
    res.status(500).json({ error: msg });
  }
});

notebookAiRouter.post('/api/local/ai/notebook-copilot', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    res.status(400).json({
      code: 'MISSING_GEMINI_API_KEY',
      error:
        'GEMINI_API_KEY is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets to use the Notebook Copilot.',
    });
    return;
  }

  const body = (req.body ?? {}) as NotebookCopilotRequestBody;
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (!instruction) {
    res.status(400).json({ error: 'Copilot instruction is required.' });
    return;
  }

  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : 'gemini-4-hydrogen';

  const contextText = [
    `Notebook Title: ${body.notebookTitle || 'Untitled'}`,
    body.notebookDescription ? `Description: ${body.notebookDescription}` : '',
    body.scope ? `Scope: ${body.scope}` : '',
    Array.isArray(body.cells) && body.cells.length > 0
      ? `Current Cells:\n${body.cells
          .map(
            (c, i) =>
              `[${i + 1}] (${c.kind || 'python'}${c.title ? `: ${c.title}` : ''})\n${(c.source || '').slice(0, 1200)}`,
          )
          .join('\n\n')}`
      : 'Current Cells: (none yet)',
    body.acousticContext
      ? `Active Recording Context:\n${JSON.stringify(body.acousticContext, null, 2).slice(0, 6000)}`
      : '',
    `User Request: ${instruction}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: contextText }] }],
      config: {
        systemInstruction: NOTEBOOK_COPILOT_SYSTEM,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            reply: {
              type: Type.STRING,
              description: 'Brief explanation of the suggested notebook cells or edits.',
            },
            suggestedCells: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  kind: {
                    type: Type.STRING,
                    enum: ['markdown', 'python', 'ai'],
                  },
                  title: { type: Type.STRING },
                  source: { type: Type.STRING },
                },
                required: ['kind', 'source'],
              },
            },
          },
          required: ['reply', 'suggestedCells'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}') as {
      reply?: string;
      suggestedCells?: Array<{ kind?: string; title?: string; source?: string }>;
    };

    const suggestedCells = Array.isArray(parsed.suggestedCells)
      ? parsed.suggestedCells
          .filter(
            (c) =>
              c &&
              (c.kind === 'markdown' || c.kind === 'python' || c.kind === 'ai') &&
              typeof c.source === 'string' &&
              c.source.trim().length > 0,
          )
          .map((c) => ({
            kind: c.kind as 'markdown' | 'python' | 'ai',
            title: typeof c.title === 'string' ? c.title.trim() : undefined,
            source: c.source!.trim(),
          }))
      : [];

    res.json({
      reply: parsed.reply || 'Generated notebook cells.',
      suggestedCells,
      modelUsed: model,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Notebook copilot request failed';
    res.status(500).json({ error: msg });
  }
});
