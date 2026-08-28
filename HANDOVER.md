# 📋 Virtual Tour 360 — Project Handover & Claude Code Context

> **Repository:** `https://github.com/quantroc21/immage-stiching`  
> **Production URL:** `https://virtual-tour-360.projectpickx.workers.dev`  
> **Tech Stack:** React 19, TypeScript, Vite, Three.js, Canvas 2D / OffscreenCanvas WebWorkers, TailwindCSS, Vite PWA, Cloudflare Workers (Wrangler).

---

## 1. 🏗️ Architecture & Core Components

```
virtual-tour-360/
├── src/
│   ├── App.tsx                     # Minimalist Pro Camera Studio Dock (Shutter, Gallery, Samples)
│   ├── components/
│   │   └── PanoramaViewer.tsx      # Interactive 360 viewer (Pannellum-based / Three.js fallback)
│   ├── capture/
│   │   ├── CaptureView.tsx         # Main camera capture controller (4K native getUserMedia, shutter UI)
│   │   ├── OrientationOverlay.tsx  # Three.js 3D viewfinder, gyroscope tracking, dot guidance & dwell trigger
│   │   ├── sphereDots.ts           # 3-row sphere dot generator (~16-18 dots: Floor -42°, Equator 0°, Ceiling +42°)
│   │   ├── cameraFov.ts            # Dynamic FOV derivation (calibrated vertical FOV ~72-73°)
│   │   ├── deviceOrientation.ts    # iOS Safari permission requester for DeviceOrientationEvent
│   │   ├── usePortraitOrientation.ts # Screen lock & aspect ratio detection
│   │   ├── stitchWorker.ts         # Multi-threaded 4K Winner-Takes-All stitching engine (WebWorker)
│   │   ├── useStitcher.ts          # React hook interface for stitchWorker lifecycle
│   │   └── types.ts                # TypeScript definitions for photos, dots, messages
│   └── main.tsx
```

---

## 2. 🔬 Deep-Dive: Stitching Engine (`stitchWorker.ts`)

### Why Previous Algorithms Failed:
1. **Weighted Average Blending:** Averaging 3-4 overlapping shots produced "plastic", watery, blurred ghost artifacts and double-vision on foreground objects (chairs, tables, floor tiles).
2. **Auto-Exposure Differences:** iPhone changes exposure per shot (towards window = bright, corners = dark), causing visible banding.
3. **6K Memory Pressure:** 6K buffers on mobile WebWorkers caused OOM context loss.

### Current Commercial-Grade Implementation:
1. **Winner-Takes-All Ownership Map:**
   - For every pixel in the 4K equirectangular canvas (`4096x2048`), determine which photo's center is angularly closest (`fastAngularDist`).
   - Each pixel is strictly "owned" by 1 photo.
2. **Narrow Seam Blend (3°):**
   - Cross-fade blending is restricted only to a 3° margin around ownership boundaries (`smoothstep` transition).
   - Keeps 95% of each photo 100% sharp with zero ghosting.
3. **Global Exposure Normalization:**
   - Calculates luminance average (`0.299R + 0.587G + 0.114B`) per shot.
   - Normalizes all shots to the median brightness with clamped gain (`0.6x - 1.8x`), eliminating brightness banding.
4. **4K High-Res Output:**
   - 4K (`4096x2048`) at 0.95 JPEG quality — optimal balance between commercial crispness and mobile RAM safety (~150MB).

---

## 3. 🎯 Deep-Dive: Capture & Guidance (`OrientationOverlay.tsx` & `CaptureView.tsx`)

1. **Camera Feed:**
   - `getUserMedia` requests `width: { ideal: 3840, min: 1920 }`, `height: { ideal: 2160, min: 1080 }` with fallback.
   - `grabFrame()` captures full native sensor resolution.
2. **Sphere Layout (`sphereDots.ts`):**
   - **3 Rows:** Floor (`-42°`), Equator (`0°`), Ceiling (`+42°`).
   - Total shots: **~16–18 dots** (matching Teleport360 standard).
   - Overlap: 10%.
3. **Capture Trigger Mechanics:**
   - **Pure Auto-Dwell Capture:** Fires automatically after 800ms steady hold on target dot (`STEADY_MAX_DEG_PER_SEC = 28°/s`, `ROLL_TOLERANCE_DEG = 18°`). Completely hands-free without requiring button clicks.
4. **VRAM Optimization:**
   - 3D sphere live preview uses 512px canvas textures so total Three.js VRAM is `< 5MB` on iOS Safari.

---

## 4. 🚀 Development & Deployment Commands

```bash
# Type check & lint
npx tsc -b --noEmit
npx oxlint src/

# Local Dev Server
npm run dev

# Production Build & Deploy to Cloudflare Workers
npm run deploy
# (which runs: tsc -b && vite build && wrangler deploy)
```

---

## 5. 📌 Key Knobs & Constants

| File | Constant | Current Value | Purpose |
|---|---|---|---|
| `cameraFov.ts` | `ASSUMED_VERTICAL_FOV_DEG` | `73` | Calibrated vertical FOV of iPhone main sensor |
| `sphereDots.ts` | `PITCH_RANGE_DEG` | `42` | Angle of top & bottom capture rings (±42°) |
| `sphereDots.ts` | `DEFAULT_OVERLAP` | `0.10` | Overlap percentage between adjacent shots |
| `OrientationOverlay.tsx` | `ROLL_TOLERANCE_DEG` | `18` | Allowed wrist roll before warning/blocking |
| `OrientationOverlay.tsx` | `STEADY_MAX_DEG_PER_SEC` | `28` | Hand-tremor tolerance threshold |
| `CaptureView.tsx` | `DWELL_MS` | `800` | Countdown duration to auto-snap |
| `CaptureView.tsx` | `FINISH_AVAILABLE_FRACTION` | `0.4` | Early stitch completion threshold (40% shots) |
| `stitchWorker.ts` | `OUTPUT_WIDTH` / `HEIGHT` | `4096` / `2048` | Equirectangular canvas dimensions |
| `stitchWorker.ts` | `SEAM_BLEND_DEG` | `3.0` | Angular width of border blending |
