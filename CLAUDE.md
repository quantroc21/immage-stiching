# Virtual Tour 360 — Claude Code Guide

## Project Overview
PWA for capturing 360° panoramas with mobile camera and multi-threaded in-browser stitching.
- **Tech**: React 19, TypeScript, Vite, Three.js, Canvas 2D/OffscreenCanvas WebWorker, TailwindCSS, Cloudflare Workers (Wrangler).
- **Live URL**: https://virtual-tour-360.projectpickx.workers.dev
- **Full Handover**: See [HANDOVER.md](./HANDOVER.md) for architectural deep dive and configuration constants.

## Key Workflows & Commands
- **Lint & Type Check**: `npx oxlint src/ && npx tsc -b --noEmit`
- **Build**: `npm run build`
- **Deploy**: `npm run deploy` (builds and publishes to Cloudflare Workers via Wrangler)
- **Dev**: `npm run dev`

## Architecture & Code Map
- `src/capture/CaptureView.tsx`: Main camera capture UI, 4K native stream acquisition & minimalist viewfinder.
- `src/capture/OrientationOverlay.tsx`: Three.js 3D sphere viewfinder, gyro tracking, dot guidance, fast auto-dwell (800ms). Preview textures are 512px canvas to prevent WebGL VRAM leak on iOS.
- `src/capture/stitchWorker.ts`: 4K equirectangular stitching engine using Winner-Takes-All ownership map + 3° narrow seam blend + global exposure compensation.
- `src/capture/sphereDots.ts`: 3-row capture grid (Floor -42°, Equator 0°, Ceiling +42°) with ~16-18 shots total.
- `src/capture/cameraFov.ts`: Calibrated vertical FOV (~73°) and dynamic aspect ratio calculations.
- `src/components/PanoramaViewer.tsx`: Interactive 360 viewer with download and Web Share API.
- `src/App.tsx`: Minimalist Pro Camera Studio Dock.

## Guidelines
- Always preserve Winner-Takes-All logic in `stitchWorker.ts` to prevent ghosting/plastic blending.
- Keep 3D preview textures lightweight in `OrientationOverlay.tsx` to respect iOS Safari WebGL memory limits.
- Verify changes with `npx tsc -b --noEmit` and `npx oxlint src/` before deploying.
