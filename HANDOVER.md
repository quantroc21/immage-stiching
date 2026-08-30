# Virtual Tour 360 — Handover

**Repo:** https://github.com/quantroc21/immage-stiching
**Live:** https://virtual-tour-360.projectpickx.workers.dev
**Owner:** Lê Hoàng Quân. Vietnamese UI. Real use case: virtual tours of a homestay/rental, shown to prospective guests.

React 19 + TypeScript + Vite + Tailwind, PWA, deployed as a Cloudflare Worker with static assets and an R2 bucket.

---

## 1. What the app does

Capture a room as a 360 panorama on the phone, name it, connect rooms with hotspots, walk the tour, publish it as a link.

```
src/
  App.tsx                  tour editor: rooms, hotspots, edit/preview modes, sheets
  capture/
    CaptureView.tsx        camera flow: lens pick, dot grid, dwell-to-shoot, result screen
    OrientationOverlay.tsx Three.js viewfinder, gyro tracking, dot guidance
    sphereDots.ts          dot grid derived from measured FOV (12 dots on ultra-wide)
    cameraFov.ts           FOV assumptions per lens
    stitchWorker.ts        THE STITCHER. gyro-based equirectangular projection, 4096x2048
    useStitcher.ts         worker driver
  tour/
    useTour.ts             scene CRUD, object-URL lifecycle, persistence
    storage.ts             IndexedDB (panoramas are 2-4MB Blobs, localStorage cannot hold them)
    TourStage.tsx          two-slot Street-View-style warp between rooms
    TourViewer.tsx         Pannellum wrapper, hotspot sync, tap-to-place
    tourPage.ts            standalone tour page, shared by the export and the hosted page
    exportTour.ts          offline single-file HTML export
    shareTour.ts           upload client, content-addressed, XHR for progress
    flight.ts              warp timings, shared with the exported page
  worker/index.ts          POST /api/tour, POST /api/tour/check, GET /t/<id>, GET /i/<hash>.jpg
```

## 2. State: solid

These work and are verified against production. Leave them alone unless asked.

- **Multi-room tours.** Rooms in IndexedDB, tap-to-place hotspots, edit/preview modes, cascade delete.
- **Room transitions.** Two stacked Pannellum viewers; the outgoing room rushes toward the tapped doorway and dissolves while the incoming one settles. All CSS transform, no field-of-view animation (animating hfov re-projects a 4096px sphere every frame and stutters). Timings in `tour/flight.ts`.
- **Link sharing.** Upload to R2, get `/t/<id>`. Panoramas are stored under the SHA-256 of their bytes at `img/<hash>.jpg`, shared across tours; re-publishing after an edit uploads no image bytes. Measured: first share 5.0s, immediate re-share 2.0s.
- **Offline export.** One self-contained HTML, Pannellum and panoramas inlined.
- **Viewer geometry.** `hfov: 70`, clamped 45..85, pitch clamped +-80, in `TourViewer.tsx` and in `tourPage.ts`. **Do not widen these.** Past ~85 degrees the rectilinear projection funnels on a portrait phone screen when panning up or down, which the owner calls "giãn giãn nước" (flowing-water stretch). This regressed once already.

## 3. State: the open problem

Stitch quality. The owner's words: **chói (glare), mờ (blur), ghosted**. A real capture is in the chat history: a bedroom where a person lying on the floor is torn into pieces, the tiled floor smears, and a foil-covered window shows blocky patches.

Three distinct causes, worth keeping separate:

| Symptom | Cause | Fixable by |
|---|---|---|
| Torn/duplicated person | subject changed pose between shots | seam routing (put one shot in charge of the whole person). Not by warping: they did not move, they changed shape. |
| Floor smearing | parallax on the nearest surface (~1m), no texture to match on | optical flow, or shooting from higher/further |
| Blown windows | clipped pixels, detail gone | pulling from an overlapping shot that exposed it lower |
| Ghost doubles | parallax; both placements averaged in the blend | local alignment before blending, or seam routing around the object |

### How the stitcher currently decides things

`stitchWorker.ts`, ~880 lines, well commented. Pipeline: decode (downscale to 1280 long side) -> vignette estimate -> FOV auto-calibration by minimising trimmed-mean overlap disagreement -> Brown & Lowe exposure gains solved over overlaps -> low-frequency band (wide feather average on a 1/16 grid) -> high-frequency band (strip by strip) -> merge -> pole fill.

The decision that matters: **which shot owns an output pixel is decided by geometry alone.** `projectPixel` returns a `margin`, the distance from the frame's own edge; largest margin wins; contributors within `SEAM_BLEND_MARGIN` of the winner are feathered in. It is blind to whether the winning shot is sharp, correctly exposed, or agrees with its neighbours. A direction is normally covered by 2-3 shots, so better data is frequently available and discarded.

That is the lever. It has not been successfully pulled yet.

## 4. What was tried and reverted (read before repeating it)

Branch `stitcher-quality-experiments` (`71bc795`) holds three changes that are **not** on `main`. `main` reverted to the pre-change stitcher at `88f41e4` because the owner judged real output worse.

| Commit | Change | Synthetic measurement |
|---|---|---|
| `c7e7ab3` | ownership weighted by local sharpness and clipping (`frameQuality.ts`) | one blurred shot of 24: sharpness retained in its band 16.5% -> 86.7%. One shot overexposed 2.9x: zero clipped pixels in output. |
| `39082e4` | build the low band AFTER the sharp band, weight its samples by agreement with it | ghost pixels 5.17% -> 1.80%, ghost:solid 1.20 -> 0.42, solid object unchanged, seam step under 18% exposure drift 3.66 -> 3.70 |
| `71bc795` | blur + bilinearly interpolate the quality map | not measured; written after spotting rectangular patches in the owner's real photo |

Two things measured their way *out* of that branch and are worth not re-inventing:

- **Rejecting disagreeing samples in the sharp band did nothing** (5.17% -> 5.30%) and made things worse combined with the low-band fix. The ghost lives in the low-frequency band, which is subtracted, blurred and added back, so a ghost there is smeared over the whole neighbourhood as a halo.
- **An earlier ICM seam optimiser did nothing**: 466 of 59,904 cells relabelled, cost 8.407 -> 8.371. ICM is greedy and single-cell; the margin-based labelling is already a local minimum, and moving a seam requires moving a whole chain of cells at once. This is an argument against ICM specifically, not against seam optimisation. Graph cut (min-cut/max-flow) is the algorithm that can do it, and is what enblend/Hugin use.

### The mistake to avoid repeating

Every one of those numbers came from **synthetic captures rendered from a flat equirect world**: evenly textured, no moving subject, no specular surface, no bare floor. They were real measurements of the wrong scene. The defects that actually ruin the owner's photos are exactly the ones the test scene did not contain. If you change the stitcher, get real source frames first.

## 5. The single highest-value unblocker

**The app throws the source shots away after stitching.** `CaptureView` holds `photos` in component state and discards them once a panorama is accepted. Consequences: a capture cannot be re-stitched with different settings, nothing can be A/B'd on real data, and every experiment costs a fresh shooting session.

Storing the 12-24 source JPEGs alongside the room (IndexedDB, ~1-3MB each) and adding a "re-stitch" action would unblock all further stitcher work. There used to be a "share the N source shots" button; it was removed at the owner's request because the result-screen bar was overcrowded, not because the capability was unwanted.

## 6. Directions not yet tried

Nothing below has been attempted. No opinion is attached; the owner is keen on the AI route in particular and it has not had a fair go.

**AI repair, masked.** The stitcher already computes disagreement between overlapping shots (it uses it for FOV calibration). That is a defect map, essentially free. Exporting the panorama plus a mask of the pixels where shots disagree lets a generative model repair only those pixels and leave everything else untouched. Worth knowing when weighing it: the tours are shown to people booking a room, so anything invented inside furniture or fixtures is a business risk in a way that invented wall texture is not. That is a reason to constrain where the model may paint, not a reason to skip it.

**Graph-cut seam routing.** Route the boundary through low-disagreement regions so one shot owns a whole object. This is the direct fix for the torn person, which no amount of warping can help. Cost function is better than it was: disagreement between overlaps plus, if the branch is revived, the sharpness/clipping maps.

**Optical flow deghosting.** Estimate a local displacement field between overlapping shots and warp before blending. Standard commercial answer to parallax. Two known risks: textureless walls give meaningless flow that will smear if trusted, and it is expensive (stitch is ~25s now; expect 40-60s).

**Highlight recovery.** iOS runs continuous auto-exposure and there is no way to lock it from a web app (`exposureMode` is not supported in Safari's getUserMedia, and the app sets no exposure constraints). So shots genuinely differ in exposure, and a blown window in one shot is often correctly exposed in another. That variation is available for free.

**Lens distortion.** Never corrected. Ultra-wide barrel distortion is worst at frame edges, which is exactly where seams run. Hugin's solve for these photos carried real radial coefficients. The FOV sweep-and-minimise machinery in `stitchWorker.ts` could be extended to solve for them the same way.

## 7. Operational notes

- **`tsc --noEmit` checks nothing.** `tsconfig.json` is a solution file with `"files": []` and project references. Use `npm run build` (`tsc -b && vite build`).
- **Deploy:** `npm run deploy`. Verify with curl afterwards; `/i/<hash>.jpg` once returned `index.html` because `run_worker_first` in `wrangler.jsonc` did not list `/i/*`, and every new tour would have shown no rooms.
- **Service worker.** `navigateFallbackDenylist` in `vite.config.ts` keeps `/t/` and `/api/` away from the SPA fallback. Without it, anyone who installed the PWA opens the editor instead of the shared tour. `fetch` bypasses the navigation route, so this does not reproduce unless you navigate for real.
- **Testing the stitcher** needs the browser: it is an ES-module Web Worker using OffscreenCanvas. A full stitch of 24 shots takes ~50s, so drive it asynchronously and poll rather than awaiting inside one tool call.
- **R2:** bucket `virtual-tour-360`. `POST /api/tour` is unauthenticated; limits are 40 rooms and 16MB per image. Fine for now, worth a key before wider use.
- **Git identity** is not configured globally; commits use `-c user.name="Lê Hoàng Quân" -c user.email="quanle2212@kuv.edu.vn"`.

## 8. Shooting technique, which outperforms the software

Measured for this app at 4096px output, object at 1.2m:

| Grip | Lens offset from rotation axis | Misalignment |
|---|---|---|
| Arm extended, turning the body | ~35cm | ~110px |
| Elbows in, phone close | ~5cm | ~16px |
| Tripod over the axis | 0 | 0 |

Rotate around the lens, not the body. Stand away from the nearest object; error scales with offset/distance. Hold still for the 800ms dwell. Clear people and moving objects out: a subject that changes pose cannot be stitched by anything.
