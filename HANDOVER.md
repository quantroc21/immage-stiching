# Virtual Tour 360 — Engineering Handover & Technical Specification

**Repo:** https://github.com/quantroc21/immage-stiching  
**Live Worker:** https://virtual-tour-360.projectpickx.workers.dev  
**Owner:** Lê Hoàng Quân (`quanle2212@kuv.edu.vn`)  
**Stack:** React 19 + TypeScript + Vite + Tailwind + Three.js + Web Workers + Cloudflare Workers (R2 + Static Assets).

---

## 1. Executive Summary & Strategic Pivot

### ❌ The Generative AI Experiment is Officially Closed:
- **Findings:** Generative diffusion models (Gemini / Imagen) hallucinates details (inventing new logos, changing clothing patterns, inventing fake furniture/decor, and stamping AI watermark stars). For real-estate, hotels, and homestay tours, this is unacceptable.
- **Decision:** **NO MORE AI GENERATION.** The pipeline must be **100% Native Computer Vision & Precise Optics**.

### 🎯 The Core Insight & Objective:
> *"Blur, ghosting, tearing, and severed furniture happen primarily because of **capture pose discrepancy and sensor-to-camera latency at the moment of shooting**."*

If each photo is captured at the **exact, mathematically optimal pose with zero angular velocity**, and the stitcher performs **sub-pixel pairwise pose refinement (Visual Bundle Adjustment)**, the native stitcher will produce crystal-clear, seamless, commercial-grade 360° panoramas directly on-device.

---

## 2. Root Causes of Current Stitching Defects

1. **Sensor-to-Camera Pipeline Latency (~80ms):**
   - The browser's `deviceorientation` event updates at ~60Hz, but `<video>` canvas frame capture has a 50–100ms internal hardware buffer delay.
   - If the user is rotating at $15^\circ/\text{s}$, an 80ms lag introduces a **$1.2^\circ$ angular offset** ($\approx 15\text{px}$ on 4K equirectangular).
2. **Overly Loose Targeting Tolerance:**
   - In `OrientationOverlay.tsx`, `matchThresholdDeg` was allowed to drift up to $4.5^\circ$. Two adjacent shots drifting in opposite directions produce a **$9.0^\circ$ gap or overlap distortion**.
3. **Rigid Gyro Assumption in `stitchWorker.ts`:**
   - `stitchWorker.ts` currently treats raw $(yaw_i, pitch_i)$ angles from the gyroscope as absolute truth without pairwise image content alignment. Any gyro drift or hand parallax results in a step/shear at the seams.

---

## 3. The 3 Technical Milestones for Claude Code

### Milestone 1: Precision Reticle & Zero-Velocity Freeze Lock (`src/capture/OrientationOverlay.tsx`)
1. **Tighten Alignment Threshold:**
   - Reduce matching tolerance to $\le 1.8^\circ - 2.0^\circ$ (instead of $4.5^\circ$).
2. **Zero-Velocity Stability Lock (Stationary Requirement):**
   - The dwell timer must **only advance when angular velocity $\omega \le 2.0^\circ/\text{s}$**.
   - When $\omega \to 0$, the latency error $\Delta \theta = \omega \times \Delta t \to 0$, guaranteeing zero sensor-to-camera phase error!
3. **Magnetic Snapping UI:**
   - Two concentric rings: Outer Guidance Ring + Inner Precision Bullseye.
   - Visual snap feedback + `navigator.vibrate?.([15, 30, 15])` haptic pulse when perfectly centered.

### Milestone 2: Geometric Dot Matrix Optimization (`src/capture/sphereDots.ts` & `cameraFov.ts`)
1. **Calibrated 3-Row Grid:**
   - Floor row: $-42^\circ$ (4–5 shots)
   - Equator row: $0^\circ$ (6–7 shots)
   - Ceiling row: $+42^\circ$ (4–5 shots)
   - Total: ~14–16 shots on iPhone Ultra-Wide (0.5x lens) / ~18 shots on Main lens.
2. **Guaranteed 20–25% Optical Overlap:**
   - Ensure every adjacent pair shares at least 200–300px of high-contrast overlap strip.

### Milestone 3: Pairwise Visual Pose Refinement (`src/capture/stitchWorker.ts`)
1. **Sub-Pixel Pose Optimization:**
   - Before final high-frequency rendering, take initial poses $(yaw_i, pitch_i, roll_i)$ and run a fast coordinate descent / gradient search over overlap regions to minimize intensity disagreement $\sum |I_i - I_j|^2$.
   - This adjusts each shot by $\pm 0.5^\circ - 1.5^\circ$ to snap image features (table edges, floor tiles, wall corners) into **exact 0-pixel alignment**.
2. **Winner-Takes-All High-Frequency Compositing:**
   - Strict `SEAM_BLEND_MARGIN` ($\le 0.02$) along structural edges.
   - Low-frequency exposure compensation without ghost-halo bleeding.

---

## 4. Key Files Reference

```
src/
  capture/
    CaptureView.tsx          Camera stream, lens picker, frame grabbing, UI layout
    OrientationOverlay.tsx   Three.js 3D sphere viewfinder, gyro tracking, dwell & trigger
    sphereDots.ts            3-row spherical capture grid generator
    cameraFov.ts             Lens FOV constants and aspect ratio math
    stitchWorker.ts          4K Equirectangular multi-band stitcher Web Worker
    useStitcher.ts           Web Worker client hook
    exportBundle.ts          Multi-image capture export / Grid overview generator
  components/
    PanoramaViewer.tsx       Pannellum 360 viewer component
  App.tsx                    Main tour editor & studio dock
```

---

## 5. Development & Deployment Commands

```bash
# Type check & lint
npx tsc -b --noEmit
npx oxlint src/

# Test build
npm run build

# Deploy to Cloudflare Workers
git add -A && git commit -m "your commit message" && git push origin main && npm run deploy
```

---

## 6. Prompt to Copy-Paste to Claude Code

```text
Đọc kỹ file HANDOVER.md và CLAUDE.md để nắm rõ toàn bộ kiến trúc và định hướng mới:
1. KHÔNG DÙNG AI TẠO SINH (Gemini/Diffusion) NỮA vì bị ảo giác (hallucination), tự bịa đồ vật/logo.
2. TẬP TRUNG 100% VÀO THUẬT TOÁN THỊ GIÁC & CƠ CHẾ BẮT ĐIỂM CHÍNH XÁC:
   - Trong `src/capture/OrientationOverlay.tsx`: Nâng cấp tâm ngắm chính xác (Precision Reticle), thu hẹp dung sai bắt điểm xuống <= 1.8 độ, bổ sung cơ chế Khóa Đứng Yên (Zero-Velocity Freeze Lock, tốc độ xoay < 2 độ/s mới kích hoạt chụp) để triệt tiêu độ trễ giữa Gyroscope và Camera.
   - Trong `src/capture/sphereDots.ts`: Tối ưu ma trận chấm 3 hàng đảm bảo độ phủ chồng lấn quang học 20-25%.
   - Trong `src/capture/stitchWorker.ts`: Bổ sung thuật toán tự động vi chỉnh góc chụp (Visual Pose Refinement) giữa các ảnh kề nhau để đường gạch sàn và đồ nội thất khớp khít 100% từng pixel.
3. Chạy `npm run build` và deploy với `npm run deploy`.
```
