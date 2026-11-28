import { Router } from 'express';

export const docsRouter = Router();

docsRouter.get('/api/archive-docs/read', async (req, res) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!rawUrl) {
    res.status(400).json({ error: 'Missing url query parameter' });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }

  if (parsed.protocol !== 'https:') {
    res.status(400).json({ error: 'Only https:// documentation URLs are supported' });
    return;
  }

  const host = parsed.hostname.toLowerCase();
  const isPrivateOrLiteral =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(':');
  if (isPrivateOrLiteral) {
    res.status(403).json({ error: 'Disallowed host' });
    return;
  }

  try {
    const upstream = await fetch(parsed.toString(), {
      redirect: 'error',
      signal: AbortSignal.timeout(6000),
      headers: {
        Accept: 'text/plain, text/markdown, text/*, application/json, application/xml;q=0.9',
      },
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
      return;
    }
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    const looksTextPath = /\.(md|markdown|txt|rst|csv|tsv|json|xml|yaml|yml)$/i.test(
      parsed.pathname,
    );
    if (
      !ct.startsWith('text/') &&
      !ct.includes('json') &&
      !ct.includes('xml') &&
      !looksTextPath
    ) {
      res.status(415).json({ error: `Non-text content-type (${ct || 'unknown'})`, contentType: ct });
      return;
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    const maxBytes = 131072;
    const truncated = buf.byteLength > maxBytes;
    const text = buf.subarray(0, maxBytes).toString('utf8');
    res.json({
      url: parsed.toString(),
      contentType: ct || 'text/plain',
      truncated,
      text,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to fetch document' });
  }
});
