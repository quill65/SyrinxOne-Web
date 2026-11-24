import type { LayoutCommand, MDIWindowState } from '@syrinxone/shared';

export interface CanvasBounds {
  width: number;
  height: number;
}

const MIN_W = 280;
const MIN_H = 200;

/**
 * Classic Syrinx MDI window layout algorithms (ClientWinInfoList.h equivalents):
 * Tile Grid (RxC), Tile Horizontal, Tile Vertical, Cascade, Resize All to Active, Fit Screen.
 */
export function applyMdiLayout(
  windows: MDIWindowState[],
  command: LayoutCommand,
  bounds: CanvasBounds,
  activeWindowId: string | null,
): MDIWindowState[] {
  const visible = windows.filter((w) => !w.minimized);
  if (visible.length === 0) return windows;

  const pad = 6;
  const availW = Math.max(MIN_W, bounds.width - pad * 2);
  const availH = Math.max(MIN_H, bounds.height - pad * 2);
  const updates = new Map<string, Partial<MDIWindowState>>();

  if (command === 'tile_grid' || command === 'fit_screen') {
    const n = visible.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cellW = Math.max(MIN_W, Math.floor((availW - pad * (cols - 1)) / cols));
    const cellH = Math.max(MIN_H, Math.floor((availH - pad * (rows - 1)) / rows));

    visible.forEach((w, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      updates.set(w.windowId, {
        x: pad + col * (cellW + pad),
        y: pad + row * (cellH + pad),
        width: cellW,
        height: cellH,
        maximized: false,
      });
    });
  } else if (command === 'tile_horizontal') {
    const n = visible.length;
    const cellH = Math.max(MIN_H, Math.floor((availH - pad * (n - 1)) / n));
    visible.forEach((w, idx) => {
      updates.set(w.windowId, {
        x: pad,
        y: pad + idx * (cellH + pad),
        width: availW,
        height: cellH,
        maximized: false,
      });
    });
  } else if (command === 'tile_vertical') {
    const n = visible.length;
    const cellW = Math.max(MIN_W, Math.floor((availW - pad * (n - 1)) / n));
    visible.forEach((w, idx) => {
      updates.set(w.windowId, {
        x: pad + idx * (cellW + pad),
        y: pad,
        width: cellW,
        height: availH,
        maximized: false,
      });
    });
  } else if (command === 'cascade') {
    const step = 30;
    const wSize = Math.max(MIN_W, Math.min(820, Math.floor(availW * 0.72)));
    const hSize = Math.max(MIN_H, Math.min(520, Math.floor(availH * 0.72)));
    visible.forEach((w, idx) => {
      const offset = (idx % 10) * step;
      updates.set(w.windowId, {
        x: pad + offset,
        y: pad + offset,
        width: wSize,
        height: hSize,
        zIndex: idx + 1,
        maximized: false,
      });
    });
  } else if (command === 'resize_all_to_active') {
    const ref =
      visible.find((w) => w.windowId === activeWindowId) ?? visible[visible.length - 1];
    visible.forEach((w) => {
      updates.set(w.windowId, {
        width: ref.width,
        height: ref.height,
        maximized: false,
      });
    });
  }

  return windows.map((w) => {
    const patch = updates.get(w.windowId);
    return patch ? { ...w, ...patch } : w;
  });
}

export function clampWindowGeometry(
  win: MDIWindowState,
  bounds: CanvasBounds,
): Pick<MDIWindowState, 'x' | 'y' | 'width' | 'height'> {
  const width = Math.max(MIN_W, Math.min(win.width, Math.max(MIN_W, bounds.width)));
  const height = Math.max(MIN_H, Math.min(win.height, Math.max(MIN_H, bounds.height)));
  const x = Math.max(-width + 80, Math.min(win.x, Math.max(0, bounds.width - 80)));
  const y = Math.max(0, Math.min(win.y, Math.max(0, bounds.height - 40)));
  return { x, y, width, height };
}
