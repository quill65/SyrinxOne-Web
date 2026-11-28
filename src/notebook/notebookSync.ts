import type { NotebookContextSummary, ProposedAnnotation } from './types';

const CHANNEL_NAME = 'syrinxone.notebook.sync.v1';
const LATEST_CONTEXT_KEY = 'syrinxone.latestAcousticContext.v1';

export interface SyncedAcousticContext {
  summary: NotebookContextSummary | null;
  contextPayload: Record<string, unknown>;
  spectrogramImageBase64?: string;
  updatedAt: number;
}

type SyncMessage =
  | { type: 'CONTEXT_UPDATE'; payload: SyncedAcousticContext }
  | { type: 'REQUEST_CONTEXT' }
  | { type: 'COMMIT_ANNOTATIONS'; items: ProposedAnnotation[] };

let cachedSyncedContext: SyncedAcousticContext | null = null;

function createChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}

export function isDetachedNotebookTab(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('view') === 'notebook';
}

export function getDetachedNotebookIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get('notebookId');
}

export function publishSyncedContext(snapshot: SyncedAcousticContext): void {
  cachedSyncedContext = snapshot;
  try {
    localStorage.setItem(
      LATEST_CONTEXT_KEY,
      JSON.stringify({
        summary: snapshot.summary,
        contextPayload: snapshot.contextPayload,
        updatedAt: snapshot.updatedAt,
      }),
    );
  } catch {
    // ignore storage quota
  }

  const ch = createChannel();
  if (!ch) return;
  try {
    ch.postMessage({ type: 'CONTEXT_UPDATE', payload: snapshot } satisfies SyncMessage);
  } finally {
    ch.close();
  }
}

export function getSyncedRemoteContext(): SyncedAcousticContext | null {
  if (cachedSyncedContext) return cachedSyncedContext;
  try {
    const raw = localStorage.getItem(LATEST_CONTEXT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SyncedAcousticContext;
    if (parsed && typeof parsed === 'object' && parsed.contextPayload) {
      cachedSyncedContext = parsed;
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

export function sendCommitAnnotationsToMainTab(items: ProposedAnnotation[]): boolean {
  const ch = createChannel();
  if (!ch) return false;
  try {
    ch.postMessage({ type: 'COMMIT_ANNOTATIONS', items } satisfies SyncMessage);
    return true;
  } finally {
    ch.close();
  }
}

export function startMainTabSyncBridge(options: {
  getLatestContext: () => SyncedAcousticContext;
  onCommitAnnotations: (items: ProposedAnnotation[]) => void;
}): () => void {
  const ch = createChannel();
  if (!ch) return () => {};

  ch.onmessage = (ev: MessageEvent<SyncMessage>) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'REQUEST_CONTEXT') {
      ch.postMessage({
        type: 'CONTEXT_UPDATE',
        payload: options.getLatestContext(),
      } satisfies SyncMessage);
    } else if (msg.type === 'COMMIT_ANNOTATIONS' && Array.isArray(msg.items)) {
      options.onCommitAnnotations(msg.items);
    }
  };

  return () => ch.close();
}

export function startDetachedTabSyncClient(
  onContextUpdate: (ctx: SyncedAcousticContext) => void,
): () => void {
  const ch = createChannel();
  if (!ch) return () => {};

  ch.onmessage = (ev: MessageEvent<SyncMessage>) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'CONTEXT_UPDATE' && msg.payload) {
      cachedSyncedContext = msg.payload;
      onContextUpdate(msg.payload);
    }
  };

  ch.postMessage({ type: 'REQUEST_CONTEXT' } satisfies SyncMessage);
  return () => ch.close();
}
