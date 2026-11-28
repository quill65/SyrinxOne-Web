import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { aiRouter } from './server/aiRouter.ts';
import { docsRouter } from './server/docsRouter.ts';
import { notebookAiRouter } from './server/notebookAiRouter.ts';
import { pythonKernelRouter } from './server/pythonKernelRouter.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '16mb' }));

  app.use(aiRouter);
  app.use(docsRouter);
  app.use(notebookAiRouter);
  app.use(pythonKernelRouter);

  // Never let unknown /api/* paths fall through to Vite/SPA index.html HTML responses
  app.use('/api', (_req, res) => {
    res.status(404).json({
      error:
        'Unknown local API route. Set Engine URL in SyrinxOne settings to your Cloud Run or local Python DSP server.',
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
        watch: {
          ignored: ['**/dist/**', '**/.git/**'],
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`SyrinxOne web server listening on http://0.0.0.0:${PORT}`);
  });
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  httpServer.on('error', (err) => {
    console.error('[server] HTTP server error:', err);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
});

void startServer().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
