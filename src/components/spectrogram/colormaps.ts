import type { ColormapName } from '@syrinxone/shared';

type Stop = [number, [number, number, number]];

const STOPS: Record<Exclude<ColormapName, 'grayscale_bow' | 'grayscale_wob'>, Stop[]> = {
  viridis: [
    [0.0, [68, 1, 84]],
    [0.25, [59, 82, 139]],
    [0.5, [33, 145, 140]],
    [0.75, [94, 201, 98]],
    [1.0, [253, 231, 37]],
  ],
  magma: [
    [0.0, [0, 0, 4]],
    [0.25, [81, 18, 124]],
    [0.5, [183, 55, 121]],
    [0.75, [252, 137, 97]],
    [1.0, [252, 253, 191]],
  ],
  inferno: [
    [0.0, [0, 0, 4]],
    [0.25, [87, 16, 110]],
    [0.5, [188, 55, 84]],
    [0.75, [249, 142, 9]],
    [1.0, [252, 255, 164]],
  ],
  turbo: [
    [0.0, [48, 18, 59]],
    [0.25, [40, 188, 235]],
    [0.5, [164, 252, 60]],
    [0.75, [251, 126, 33]],
    [1.0, [122, 4, 3]],
  ],
};

/** Build 256x4 RGBA Uint8Array texture matching Python backend colormaps. */
export function buildColormapRGBA(name: ColormapName): Uint8Array {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r = 0;
    let g = 0;
    let b = 0;

    if (name === 'grayscale_bow') {
      const v = Math.round((1 - t) * 255);
      r = v;
      g = v;
      b = v;
    } else if (name === 'grayscale_wob') {
      const v = Math.round(t * 255);
      r = v;
      g = v;
      b = v;
    } else {
      const stops = STOPS[name];
      let s0 = stops[0];
      let s1 = stops[stops.length - 1];
      for (let k = 0; k < stops.length - 1; k++) {
        if (t >= stops[k][0] && t <= stops[k + 1][0]) {
          s0 = stops[k];
          s1 = stops[k + 1];
          break;
        }
      }
      const span = Math.max(1e-6, s1[0] - s0[0]);
      const u = (t - s0[0]) / span;
      r = Math.round(s0[1][0] + (s1[1][0] - s0[1][0]) * u);
      g = Math.round(s0[1][1] + (s1[1][1] - s0[1][1]) * u);
      b = Math.round(s0[1][2] + (s1[1][2] - s0[1][2]) * u);
    }

    const idx = i * 4;
    out[idx] = r;
    out[idx + 1] = g;
    out[idx + 2] = b;
    out[idx + 3] = 255;
  }
  return out;
}
