import React, { useEffect, useRef } from 'react';
import type { DisplaySettings, SpectrogramMatrix, TimeFreqRange } from '@syrinxone/shared';
import { downsampleSpectrogramTime } from '../../utils/spectrogramFetch';
import { buildColormapRGBA } from './colormaps';

export interface SpectrogramRenderRow {
  key: string;
  matrix: SpectrogramMatrix | undefined;
  viewRange: TimeFreqRange;
  topPx: number;
  heightPx: number;
  bitmapFallbackUrl?: string;
}

interface Props {
  matrix?: SpectrogramMatrix | undefined;
  viewRange?: TimeFreqRange;
  rows?: SpectrogramRenderRow[];
  displaySettings: DisplaySettings;
  bitmapFallbackUrl?: string;
  width: number;
  height: number;
}

const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_specTex;
uniform sampler2D u_lutTex;
uniform vec2 u_timeUvRange;   // (u0, u1) normalized into spectrogram matrix [0..1]
uniform vec2 u_freqUvRange;   // (v0, v1) normalized into spectrogram matrix [0..1]
uniform float u_gainDb;
uniform float u_thresholdDb;
uniform float u_dynamicRangeDb;

void main() {
  // Spectrogram texture layout: width = numFreqBins (x), height = numTimeBins (y)
  // Screen X maps to time (y in texture), Screen Y (0=bottom, 1=top) maps to freq (x in texture)
  float tNorm = mix(u_timeUvRange.x, u_timeUvRange.y, v_uv.x);
  float fNorm = mix(u_freqUvRange.x, u_freqUvRange.y, v_uv.y);

  if (tNorm < 0.0 || tNorm > 1.0 || fNorm < 0.0 || fNorm > 1.0) {
    outColor = vec4(0.08, 0.09, 0.11, 1.0);
    return;
  }

  float val = texture(u_specTex, vec2(fNorm, tNorm)).r;
  float norm = clamp((val + u_gainDb - u_thresholdDb) / max(1.0, u_dynamicRangeDb), 0.0, 1.0);
  outColor = texture(u_lutTex, vec2(norm, 0.5));
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('Unable to create WebGL shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh) || 'unknown';
    gl.deleteShader(sh);
    throw new Error(`Shader compile error: ${info}`);
  }
  return sh;
}

interface GlResources {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  texByMatrix: Map<SpectrogramMatrix, WebGLTexture>;
  lutTex: WebGLTexture;
  vao: WebGLVertexArrayObject;
  uTime: WebGLUniformLocation | null;
  uFreq: WebGLUniformLocation | null;
  uGain: WebGLUniformLocation | null;
  uThresh: WebGLUniformLocation | null;
  uDyn: WebGLUniformLocation | null;
}

export const WebGLSpectrogramCanvas: React.FC<Props> = ({
  matrix,
  viewRange,
  rows,
  displaySettings,
  bitmapFallbackUrl,
  width,
  height,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glResRef = useRef<GlResources | null>(null);
  const uploadedColormapRef = useRef<string | null>(null);

  const effectiveRows: SpectrogramRenderRow[] =
    rows && rows.length > 0
      ? rows
      : viewRange
        ? [
            {
              key: 'single',
              matrix,
              viewRange,
              topPx: 0,
              heightPx: height,
              bitmapFallbackUrl,
            },
          ]
        : [];

  const useBitmapImg =
    displaySettings.renderMode === 'server_bitmap' &&
    effectiveRows.some((r) => Boolean(r.bitmapFallbackUrl));

  // Initialize ONE WebGL2 context & program once for all stacked rows
  useEffect(() => {
    if (useBitmapImg) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
    if (!gl) return;

    gl.getExtension('OES_texture_float_linear');

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const lutTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'u_specTex'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_lutTex'), 1);

    const texByMatrix = new Map<SpectrogramMatrix, WebGLTexture>();
    glResRef.current = {
      gl,
      program,
      texByMatrix,
      lutTex,
      vao,
      uTime: gl.getUniformLocation(program, 'u_timeUvRange'),
      uFreq: gl.getUniformLocation(program, 'u_freqUvRange'),
      uGain: gl.getUniformLocation(program, 'u_gainDb'),
      uThresh: gl.getUniformLocation(program, 'u_thresholdDb'),
      uDyn: gl.getUniformLocation(program, 'u_dynamicRangeDb'),
    };
    uploadedColormapRef.current = null;

    return () => {
      for (const tex of texByMatrix.values()) {
        gl.deleteTexture(tex);
      }
      texByMatrix.clear();
      gl.deleteTexture(lutTex);
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      glResRef.current = null;
    };
  }, [useBitmapImg]);

  // Upload spectrogram Float32 textures & draw all rows in 1 GPU pass
  useEffect(() => {
    if (useBitmapImg) return;
    const res = glResRef.current;
    const canvas = canvasRef.current;
    if (!res || !canvas || width <= 0 || height <= 0) {
      return;
    }

    const { gl, texByMatrix } = res;
    const baseDpr = window.devicePixelRatio || 1;
    const maxDim = 4096;
    const effDpr = Math.min(baseDpr, maxDim / Math.max(1, height), maxDim / Math.max(1, width));
    const pxW = Math.max(1, Math.round(width * effDpr));
    const pxH = Math.max(1, Math.round(height * effDpr));
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }

    const scaleY = pxH / Math.max(1, height);

    // Clear full canvas stage once
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, pxW, pxH);
    gl.clearColor(0.043, 0.059, 0.078, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Collect currently active matrices so stale textures are freed
    const activeMatrices = new Set<SpectrogramMatrix>();
    for (const r of effectiveRows) {
      if (r.matrix && r.matrix.numTimeBins > 0 && r.matrix.numFreqBins > 0) {
        activeMatrices.add(r.matrix);
      }
    }
    for (const [mat, tex] of texByMatrix.entries()) {
      if (!activeMatrices.has(mat)) {
        gl.deleteTexture(tex);
        texByMatrix.delete(mat);
      }
    }

    if (activeMatrices.size === 0) return;

    const maxTex = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096;
    const hasLinear = Boolean(gl.getExtension('OES_texture_float_linear'));
    const filter =
      displaySettings.interpolation === 'linear' && hasLinear ? gl.LINEAR : gl.NEAREST;

    // Upload 1D colormap LUT only when colormap changed
    if (uploadedColormapRef.current !== displaySettings.colormap) {
      const lut = buildColormapRGBA(displaySettings.colormap);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, res.lutTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
      uploadedColormapRef.current = displaySettings.colormap;
    }

    gl.useProgram(res.program);
    gl.bindVertexArray(res.vao);
    gl.uniform1f(res.uGain, displaySettings.gainDb);
    gl.uniform1f(res.uThresh, displaySettings.thresholdDb);
    gl.uniform1f(res.uDyn, displaySettings.dynamicRangeDb);
    gl.enable(gl.SCISSOR_TEST);

    for (const row of effectiveRows) {
      const mat = row.matrix;
      if (!mat || mat.numTimeBins <= 0 || mat.numFreqBins <= 0 || row.heightPx <= 0) continue;

      let tex = texByMatrix.get(mat);
      gl.activeTexture(gl.TEXTURE0);
      if (!tex) {
        tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const uploadMat =
          mat.numTimeBins > maxTex ? downsampleSpectrogramTime(mat, maxTex) : mat;
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.R32F,
          uploadMat.numFreqBins,
          uploadMat.numTimeBins,
          0,
          gl.RED,
          gl.FLOAT,
          uploadMat.data,
        );
        texByMatrix.set(mat, tex);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, tex);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);

      const totalTime = Math.max(1e-6, mat.endSec - mat.startSec);
      const totalFreq = Math.max(1e-6, mat.maxFreqHz - mat.minFreqHz);
      const t0 = (row.viewRange.startSec - mat.startSec) / totalTime;
      const t1 = (row.viewRange.endSec - mat.startSec) / totalTime;
      const f0 = (row.viewRange.minFreqHz - mat.minFreqHz) / totalFreq;
      const f1 = (row.viewRange.maxFreqHz - mat.minFreqHz) / totalFreq;

      // WebGL Y is bottom-up
      const vyTop = pxH - Math.round(row.topPx * scaleY);
      const vyBot = pxH - Math.round((row.topPx + row.heightPx) * scaleY);
      const rh = Math.max(1, vyTop - vyBot);

      gl.viewport(0, vyBot, pxW, rh);
      gl.scissor(0, vyBot, pxW, rh);
      gl.uniform2f(res.uTime, t0, t1);
      gl.uniform2f(res.uFreq, f0, f1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.disable(gl.SCISSOR_TEST);
  }, [effectiveRows, displaySettings, width, height, useBitmapImg]);

  if (useBitmapImg) {
    return (
      <div
        style={{
          position: 'relative',
          width: `${width}px`,
          height: `${height}px`,
          background: '#0b0f14',
        }}
      >
        {effectiveRows.map((row) =>
          row.bitmapFallbackUrl ? (
            <img
              key={row.key}
              src={row.bitmapFallbackUrl}
              alt="Spectrogram bitmap"
              draggable={false}
              style={{
                position: 'absolute',
                left: 0,
                top: `${row.topPx}px`,
                width: `${width}px`,
                height: `${row.heightPx}px`,
                display: 'block',
                imageRendering: displaySettings.interpolation === 'nearest' ? 'pixelated' : 'auto',
                userSelect: 'none',
              }}
            />
          ) : null,
        )}
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        display: 'block',
      }}
    />
  );
};
