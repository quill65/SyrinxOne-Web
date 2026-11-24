# SyrinxOne Web UI — Google AI Studio Build Bundle

This is a flat, standalone Vite + React + TypeScript export of `apps/web` (with `packages/shared/src` inlined at `src/shared/`) so it runs directly inside **Google AI Studio Build** with zero npm workspace setup.

## Connected DSP Engine
Pre-configured in `.env`:
```
VITE_API_URL=https://syrinx-engine-466330924576.us-west1.run.app
```
You can also switch the backend URL (or add a Bearer token) at runtime by clicking the **S1 SyrinxOne** badge in the top-left toolbar, or opening `?api=https://...` in the browser.

## Local Preview
```bash
npm install
npm run dev
```

## Syncing Changes Back to the Main Monorepo
Because `vite.config.ts` aliases `@syrinxone/shared` to `src/shared/index.ts`, all imports stay identical to `apps/web/src`. Copy modified files from `src/` (excluding `src/shared/`) directly back into `apps/web/src/` in the main `master` branch.
