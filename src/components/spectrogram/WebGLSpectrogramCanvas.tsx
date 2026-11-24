import React, { useEffect, useRef } from 'react';
import type { DisplaySettings, SpectrogramMatrix, TimeFreqRange } from '@syrinxone/shared';
import { buildColormapRGBA } from './colormaps';

interface Props {
  matrix: SpectrogramMatrix | undefined;
  viewRange: TimeFreqRange;
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
  specTex: WebGLTexture;
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
  displaySettings,
  bitmapFallbackUrl,
  width,
  height,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glResRef = useRef<GlResources | null>(null);
  const uploadedMatrixRef = useRef<SpectrogramMatrix | null>(null);
  const uploadedColormapRef = useRef<string | null>(null);

  const useServerBitmap = displaySettings.renderMode === 'server_bitmap';

  // Initialize WebGL2 context & program once
  useEffect(() => {
    if (useServerBitmap) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
    if (!gl) return;

    // Enable float texture linear filtering if supported
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

    const specTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, specTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const lutTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'u_specTex'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_lutTex'), 1);

    glResRef.current = {
      gl,
      program,
      specTex,
      lutTex,
      vao,
      uTime: gl.getUniformLocation(program, 'u_timeUvRange'),
      uFreq: gl.getUniformLocation(program, 'u_freqUvRange'),
      uGain: gl.getUniformLocation(program, 'u_gainDb'),
      uThresh: gl.getUniformLocation(program, 'u_thresholdDb'),
      uDyn: gl.getUniformLocation(program, 'u_dynamicRangeDb'),
    };
    uploadedMatrixRef.current = null;
    uploadedColormapRef.current = null;

    return () => {
      gl.deleteTexture(specTex);
      gl.deleteTexture(lutTex);
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      glResRef.current = null;
    };
  }, [useServerBitmap]);

  // Upload spectrogram Float32 texture & draw on any display/view change (60fps GPU)
  useEffect(() => {
    if (useServerBitmap) return;
    const res = glResRef.current;
    const canvas = canvasRef.current;
    if (!res || !canvas || !matrix || matrix.numTimeBins === 0 || matrix.numFreqBins === 0) {
      return;
    }

    const { gl } = res;
    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.max(1, Math.round(width * dpr));
    const pxH = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }

    // Upload spectrogram data only when the Float32 matrix actually changed
    if (uploadedMatrixRef.current !== matrix) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, res.specTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      // Row-major [timeIndex * numFreqBins + freqIndex] => texture width=numFreqBins, height=numTimeBins
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32F,
        matrix.numFreqBins,
        matrix.numTimeBins,
        0,
        gl.RED,
        gl.FLOAT,
        matrix.data,
      );
      uploadedMatrixRef.current = matrix;
    }

    // Filter mode (check float linear extension support)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, res.specTex);
    const hasLinear = Boolean(gl.getExtension('OES_texture_float_linear'));
    const filter =
      displaySettings.interpolation === 'linear' && hasLinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);

    // Upload 1D colormap LUT only when colormap changed
    if (uploadedColormapRef.current !== displaySettings.colormap) {
      const lut = buildColormapRGBA(displaySettings.colormap);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, res.lutTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
      uploadedColormapRef.current = displaySettings.colormap;
    }

    const totalTime = Math.max(1e-6, matrix.endSec - matrix.startSec);
    const totalFreq = Math.max(1e-6, matrix.maxFreqHz - matrix.minFreqHz);
    const t0 = (viewRange.startSec - matrix.startSec) / totalTime;
    const t1 = (viewRange.endSec - matrix.startSec) / totalTime;
    const f0 = (viewRange.minFreqHz - matrix.minFreqHz) / totalFreq;
    const f1 = (viewRange.maxFreqHz - matrix.minFreqHz) / totalFreq;

    gl.viewport(0, 0, pxW, pxH);
    gl.useProgram(res.program);
    gl.bindVertexArray(res.vao);
    gl.uniform2f(res.uTime, t0, t1);
    gl.uniform2f(res.uFreq, f0, f1);
    gl.uniform1f(res.uGain, displaySettings.gainDb);
    gl.uniform1f(res.uThresh, displaySettings.thresholdDb);
    gl.uniform1f(res.uDyn, displaySettings.dynamicRangeDb);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }, [matrix, viewRange, displaySettings, width, height, useServerBitmap]);

  if (useServerBitmap && bitmapFallbackUrl) {
    return (
      <img
        src={bitmapFallbackUrl}
        alt="Spectrogram bitmap"
        draggable={false}
        style={{
          width: `${width}px`,
          height: `${height}px`,
          display: 'block',
          imageRendering: displaySettings.interpolation === 'nearest' ? 'pixelated' : 'auto',
          userSelect: 'none',
        }}
      />
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
