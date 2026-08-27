This file is vendored, not installed via npm:

```
opencv.js <- @techstark/opencv-js@5.0.0-release.1 (dist/opencv.js)
```

It is loaded inside `src/capture/stitchWorker.ts` via `importScripts('/opencv/opencv.js')`
so it never has to pass through the Vite bundler (it's ~13MB with the WASM binary
embedded as base64). To update, reinstall the npm package temporarily and copy
`node_modules/@techstark/opencv-js/dist/opencv.js` here again.
