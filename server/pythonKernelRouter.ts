import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import { Router } from 'express';

const MAX_KERNELS = 8;
const CELL_TIMEOUT_MS = 25_000;
const KERNEL_IDLE_TTL_MS = 30 * 60 * 1000;

const PYTHON_WORKER_SCRIPT = String.raw`
import base64
import importlib.util
import io
import json
import math
import sys
import traceback
import urllib.parse
import urllib.request

class _SyrinxSDK:
    def __init__(self):
        self.context = {}
        self._engine_url = ""
        self._engine_token = ""
        self._figures = []
        self._vars = {}
        self._proposals = []

    def _begin_cell(self, ctx, engine_url, engine_token):
        self.context = ctx or {}
        self._engine_url = (engine_url or "").rstrip("/")
        self._engine_token = engine_token or ""
        self._figures = []
        self._vars = {}
        self._proposals = []

    def set_var(self, name, value):
        self._vars[str(name)] = value

    def emit_figure(self, obj, label="Figure"):
        b64 = None
        if isinstance(obj, bytes):
            b64 = base64.b64encode(obj).decode("ascii")
        elif isinstance(obj, str):
            b64 = obj.split(",", 1)[-1].strip()
        elif hasattr(obj, "savefig"):
            buf = io.BytesIO()
            obj.savefig(buf, format="png", bbox_inches="tight")
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        if b64:
            self._figures.append({"label": str(label), "base64Png": b64})

    def propose_annotation(
        self,
        start_sec,
        end_sec,
        low_hz,
        high_hz,
        channel=1,
        comment="",
        notes="",
        soundfile="",
    ):
        file_info = self.context.get("file") or {}
        self._proposals.append({
            "soundfile": soundfile or file_info.get("name") or "",
            "channel": int(channel),
            "startTimeSec": float(start_sec),
            "endTimeSec": float(end_sec),
            "lowFreqHz": float(low_hz),
            "highFreqHz": float(high_hz),
            "comment": str(comment),
            "notes": str(notes),
        })

    def _engine_get(self, path, params=None):
        if not self._engine_url:
            raise RuntimeError("No Python DSP Engine URL configured in SyrinxOne settings.")
        url = f"{self._engine_url}{path}"
        if params:
            q = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
            if q:
                url = f"{url}?{q}"
        req = urllib.request.Request(url, method="GET")
        if self._engine_token:
            req.add_header("Authorization", f"Bearer {self._engine_token}")
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _engine_post(self, path, payload):
        if not self._engine_url:
            raise RuntimeError("No Python DSP Engine URL configured in SyrinxOne settings.")
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(f"{self._engine_url}{path}", data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        if self._engine_token:
            req.add_header("Authorization", f"Bearer {self._engine_token}")
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def measurements(self, channel=None, start_sec=None, end_sec=None, low_hz=None, high_hz=None):
        file_info = self.context.get("file") or {}
        fid = file_info.get("fileId")
        if not fid:
            raise RuntimeError("No active recording fileId.")
        sel = self.context.get("selection") or self.context.get("viewRange") or {}
        ch = self.context.get("channel", 0) if channel is None else int(channel)
        s0 = sel.get("startSec", 0.0) if start_sec is None else float(start_sec)
        s1 = sel.get("endSec", file_info.get("durationSec", 1.0)) if end_sec is None else float(end_sec)
        lo = sel.get("lowFreqHz", sel.get("minFreqHz", 0.0)) if low_hz is None else float(low_hz)
        hi = sel.get("highFreqHz", sel.get("maxFreqHz", file_info.get("sampleRate", 44100) / 2.0)) if high_hz is None else float(high_hz)
        return self._engine_post(f"/api/audio/{urllib.parse.quote(str(fid))}/measurements", {
            "channel": ch,
            "startSec": s0,
            "endSec": s1,
            "lowFreqHz": lo,
            "highFreqHz": hi,
        })

    def detect(self, min_freq_hz=0.0, max_freq_hz=None, threshold_db=10.0, min_dur_sec=0.05, max_gap_sec=0.2, comment=""):
        file_info = self.context.get("file") or {}
        fid = file_info.get("fileId")
        if not fid:
            raise RuntimeError("No active recording fileId.")
        nyq = float(file_info.get("sampleRate", 44100)) / 2.0
        return self._engine_post(f"/api/audio/{urllib.parse.quote(str(fid))}/detect", {
            "channel": self.context.get("channel", 0),
            "minFreqHz": float(min_freq_hz),
            "maxFreqHz": float(nyq if max_freq_hz is None else max_freq_hz),
            "triggerThresholdDb": float(threshold_db),
            "minSoundDurSec": float(min_dur_sec),
            "maxSilenceGapSec": float(max_gap_sec),
            "comment": str(comment),
        })

    def spectrogram(self, channel=None, start_sec=None, end_sec=None):
        file_info = self.context.get("file") or {}
        fid = file_info.get("fileId")
        sp = self.context.get("specParams") or {}
        vr = self.context.get("viewRange") or {}
        ch = self.context.get("channel", 0) if channel is None else int(channel)
        s0 = vr.get("startSec", 0.0) if start_sec is None else float(start_sec)
        s1 = vr.get("endSec", file_info.get("durationSec", 1.0)) if end_sec is None else float(end_sec)
        if self._engine_url and fid:
            return self._engine_get(f"/api/audio/{urllib.parse.quote(str(fid))}/spectrogram", {
                "channel": ch,
                "startSec": s0,
                "endSec": s1,
                "fftSize": sp.get("fftSize", 1024),
                "hopSize": sp.get("hopSize", 256),
                "windowType": sp.get("windowType", "hann"),
                "dspMode": sp.get("dspMode", "power_db"),
            })
        return self.context.get("spectrogramSummary") or {}

    def audio(self, channel=0, start_sec=None, end_sec=None):
        return self.context.get("waveformSummary") or {}

syrinx = _SyrinxSDK()
_ns = {"__name__": "__main__", "syrinx": syrinx, "math": math, "json": json}

_real_stdout = sys.stdout

for _raw_line in sys.stdin:
    _raw_line = _raw_line.strip()
    if not _raw_line:
        continue
    _req = json.loads(_raw_line)
    _req_id = _req.get("id")
    if _req.get("cmd") == "status":
        _pkgs = {m: (importlib.util.find_spec(m) is not None) for m in ("numpy", "scipy", "matplotlib")}
        _real_stdout.write(json.dumps({
            "id": _req_id,
            "ok": True,
            "pythonVersion": sys.version.split()[0],
            "packages": _pkgs,
        }) + "\n")
        _real_stdout.flush()
        continue

    _out_buf = io.StringIO()
    _err_buf = io.StringIO()
    _old_out, _old_err = sys.stdout, sys.stderr
    _error_msg = None
    try:
        sys.stdout = _out_buf
        sys.stderr = _err_buf
        syrinx._begin_cell(
            _req.get("context") or {},
            _req.get("engineUrl") or "",
            _req.get("engineToken") or "",
        )
        _code = _req.get("code") or ""
        _compiled = compile(_code, "<syrinx-cell>", "exec")
        exec(_compiled, _ns, _ns)
    except Exception as _exc:
        _error_msg = traceback.format_exc()
    finally:
        sys.stdout = _old_out
        sys.stderr = _old_err

    _resp = {
        "id": _req_id,
        "ok": _error_msg is None,
        "stdout": _out_buf.getvalue(),
        "stderr": _err_buf.getvalue(),
        "error": _error_msg,
        "figures": syrinx._figures,
        "variables": syrinx._vars,
        "proposedAnnotations": syrinx._proposals,
    }
    _real_stdout.write(json.dumps(_resp, default=str) + "\n")
    _real_stdout.flush()
`;

interface PendingExec {
  resolve: (val: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface KernelSession {
  notebookId: string;
  proc: ChildProcessWithoutNullStreams;
  lineBuffer: string;
  pending: Map<string, PendingExec>;
  busy: boolean;
  lastUsedAt: number;
}

const kernels = new Map<string, KernelSession>();

function killKernel(notebookId: string): void {
  const sess = kernels.get(notebookId);
  if (!sess) return;
  kernels.delete(notebookId);
  for (const [, p] of sess.pending) {
    clearTimeout(p.timer);
    p.reject(new Error('Python kernel restarted or terminated.'));
  }
  sess.pending.clear();
  try {
    sess.proc.kill('SIGTERM');
  } catch {
    // ignore
  }
}

function sweepIdleKernels(): void {
  const now = Date.now();
  for (const [id, sess] of kernels.entries()) {
    if (!sess.busy && now - sess.lastUsedAt > KERNEL_IDLE_TTL_MS) {
      killKernel(id);
    }
  }
}

function getOrCreateKernel(notebookId: string): KernelSession {
  sweepIdleKernels();
  const existing = kernels.get(notebookId);
  if (existing && !existing.proc.killed && existing.proc.exitCode === null) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  if (existing) {
    killKernel(notebookId);
  }

  if (kernels.size >= MAX_KERNELS) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, sess] of kernels.entries()) {
      if (!sess.busy && sess.lastUsedAt < oldestTime) {
        oldestTime = sess.lastUsedAt;
        oldestId = id;
      }
    }
    if (oldestId) killKernel(oldestId);
  }

  const proc = spawn('python3', ['-u', '-c', PYTHON_WORKER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      LANG: process.env.LANG || 'C.UTF-8',
      HOME: '/tmp',
    },
  });

  const sess: KernelSession = {
    notebookId,
    proc,
    lineBuffer: '',
    pending: new Map(),
    busy: false,
    lastUsedAt: Date.now(),
  };

  proc.stdout.on('data', (chunk: Buffer) => {
    sess.lineBuffer += chunk.toString('utf8');
    let nlIdx = sess.lineBuffer.indexOf('\n');
    while (nlIdx >= 0) {
      const line = sess.lineBuffer.slice(0, nlIdx).trim();
      sess.lineBuffer = sess.lineBuffer.slice(nlIdx + 1);
      if (line) {
        try {
          const msg = JSON.parse(line) as { id?: string } & Record<string, unknown>;
          if (msg.id && sess.pending.has(msg.id)) {
            const entry = sess.pending.get(msg.id)!;
            sess.pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg);
          }
        } catch {
          // ignore malformed worker line
        }
      }
      nlIdx = sess.lineBuffer.indexOf('\n');
    }
  });

  proc.on('exit', () => {
    kernels.delete(notebookId);
    for (const [, p] of sess.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Python kernel process exited unexpectedly.'));
    }
    sess.pending.clear();
  });

  kernels.set(notebookId, sess);
  return sess;
}

function sendToKernel(
  sess: KernelSession,
  payload: Record<string, unknown>,
  timeoutMs = CELL_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sess.pending.delete(id);
      killKernel(sess.notebookId);
      reject(new Error(`Cell execution timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    sess.pending.set(id, { resolve, reject, timer });
    sess.proc.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
  });
}

export const pythonKernelRouter = Router();

pythonKernelRouter.post('/api/local/python/kernel/exec', async (req, res) => {
  const body = (req.body ?? {}) as {
    notebookId?: string;
    code?: string;
    context?: Record<string, unknown>;
    engineUrl?: string;
    engineToken?: string;
  };

  const notebookId =
    typeof body.notebookId === 'string' && body.notebookId.trim()
      ? body.notebookId.trim()
      : 'default';
  const code = typeof body.code === 'string' ? body.code : '';
  if (!code.trim()) {
    res.status(400).json({ error: 'Python code is required.' });
    return;
  }

  const sess = getOrCreateKernel(notebookId);
  if (sess.busy) {
    res.status(409).json({ error: 'Kernel is already executing another cell.' });
    return;
  }

  sess.busy = true;
  sess.lastUsedAt = Date.now();
  try {
    const result = await sendToKernel(sess, {
      cmd: 'exec',
      code,
      context: body.context ?? {},
      engineUrl: typeof body.engineUrl === 'string' ? body.engineUrl : '',
      engineToken: typeof body.engineToken === 'string' ? body.engineToken : '',
    });

    if (!result.ok) {
      res.status(200).json({
        ok: false,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error || 'Python execution error',
        figures: result.figures ?? [],
        variables: result.variables ?? {},
        proposedAnnotations: result.proposedAnnotations ?? [],
      });
      return;
    }

    res.json({
      ok: true,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      figures: result.figures ?? [],
      variables: result.variables ?? {},
      proposedAnnotations: result.proposedAnnotations ?? [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Python kernel execution failed';
    res.status(500).json({ error: msg });
  } finally {
    sess.busy = false;
    sess.lastUsedAt = Date.now();
  }
});

pythonKernelRouter.post('/api/local/python/kernel/restart', (req, res) => {
  const body = (req.body ?? {}) as { notebookId?: string };
  const notebookId =
    typeof body.notebookId === 'string' && body.notebookId.trim()
      ? body.notebookId.trim()
      : 'default';
  killKernel(notebookId);
  getOrCreateKernel(notebookId);
  res.json({ ok: true, restarted: true, notebookId });
});

pythonKernelRouter.post('/api/local/python/kernel/interrupt', (req, res) => {
  const body = (req.body ?? {}) as { notebookId?: string };
  const notebookId =
    typeof body.notebookId === 'string' && body.notebookId.trim()
      ? body.notebookId.trim()
      : 'default';
  const sess = kernels.get(notebookId);
  if (!sess) {
    res.json({ ok: true, interrupted: false });
    return;
  }
  killKernel(notebookId);
  res.json({ ok: true, interrupted: true });
});

pythonKernelRouter.get('/api/local/python/kernel/status', async (req, res) => {
  const notebookId =
    typeof req.query.notebookId === 'string' && req.query.notebookId.trim()
      ? req.query.notebookId.trim()
      : 'default';
  try {
    const sess = getOrCreateKernel(notebookId);
    const info = await sendToKernel(sess, { cmd: 'status' }, 5000);
    res.json({
      ok: true,
      alive: true,
      busy: sess.busy,
      pythonVersion: info.pythonVersion,
      packages: info.packages ?? {},
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      alive: false,
      error: err instanceof Error ? err.message : 'Status check failed',
    });
  }
});
