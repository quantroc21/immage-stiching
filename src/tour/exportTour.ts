import type { SceneWithUrl } from './types'

/**
 * Packs the whole tour into one self-contained HTML file: Pannellum inlined,
 * every panorama embedded as a data URI. No server, no asset folder — the file
 * opens straight from disk, can be mailed around, or dropped on any host and
 * embedded in an iframe.
 */

async function toDataUri(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** Keeps a stray "</script>" inside the data from ending the script block. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

export interface TourExport {
  blob: Blob
  filename: string
  bytes: number
}

export async function buildTourHtml(scenes: SceneWithUrl[], title: string): Promise<TourExport> {
  const [pannellumJs, pannellumCss] = await Promise.all([
    fetch('/pannellum/pannellum.js').then((r) => r.text()),
    fetch('/pannellum/pannellum.css').then((r) => r.text()),
  ])

  const panoramas = await Promise.all(scenes.map((scene) => toDataUri(scene.image)))
  const data = {
    firstScene: scenes[0].id,
    scenes: scenes.map((scene, i) => ({
      id: scene.id,
      name: scene.name,
      panorama: panoramas[i],
      initialYaw: scene.initialYaw,
      initialPitch: scene.initialPitch,
      hotspots: scene.hotspots.map((h) => ({
        id: h.id,
        yaw: h.yaw,
        pitch: h.pitch,
        targetSceneId: h.targetSceneId,
      })),
    })),
  }

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title.replace(/[<>&]/g, '')}</title>
<style>${pannellumCss}</style>
<style>
  html, body { margin: 0; height: 100%; background: #0a0a0a; color: #fff;
    font-family: system-ui, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
  #stage { position: absolute; inset: 0; }
  .vt-hotspot { position: absolute; width: 44px; height: 44px; cursor: pointer; }
  .vt-hotspot__ring { display: block; box-sizing: border-box; width: 100%; height: 100%;
    border-radius: 9999px; border: 3px solid rgba(255,255,255,.95);
    background: rgba(79,70,229,.55); transition: transform .15s ease, background .15s ease;
    animation: vt-pulse 2.4s ease-out infinite; }
  .vt-hotspot:hover .vt-hotspot__ring { transform: scale(1.15); background: rgba(79,70,229,.85); }
  .vt-hotspot__label { position: absolute; top: calc(100% + 6px); left: 50%;
    transform: translateX(-50%); max-width: 140px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; border-radius: 9999px; background: rgba(0,0,0,.75); padding: 3px 10px;
    font-size: 12px; font-weight: 500; line-height: 1.4; pointer-events: none; }
  @keyframes vt-pulse {
    0% { box-shadow: 0 2px 10px rgba(0,0,0,.5), 0 0 0 0 rgba(99,102,241,.55); }
    70% { box-shadow: 0 2px 10px rgba(0,0,0,.5), 0 0 0 18px rgba(99,102,241,0); }
    100% { box-shadow: 0 2px 10px rgba(0,0,0,.5), 0 0 0 0 rgba(99,102,241,0); }
  }
  #chrome { position: absolute; left: 0; right: 0; bottom: 0; z-index: 5;
    display: flex; gap: 8px; overflow-x: auto; padding: 12px;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
    background: linear-gradient(transparent, rgba(0,0,0,.75) 45%); }
  #chrome button { flex: none; border: 0; border-radius: 9999px; padding: 9px 16px;
    font-size: 13px; font-weight: 500; color: #fff; background: rgba(38,38,38,.92);
    cursor: pointer; backdrop-filter: blur(6px); }
  #chrome button.active { background: #4f46e5; }
  #title { position: absolute; top: 0; left: 0; z-index: 5; padding: 14px 16px;
    padding-top: max(14px, env(safe-area-inset-top)); font-size: 15px; font-weight: 600;
    text-shadow: 0 1px 6px rgba(0,0,0,.9); pointer-events: none; }
  @media (prefers-reduced-motion: reduce) { .vt-hotspot__ring { animation: none; } }
</style>
</head>
<body>
<div id="stage"></div>
<div id="title"></div>
<div id="chrome"></div>
<script>${pannellumJs}</script>
<script>
(function () {
  var DATA = ${embedJson(data)};
  var REST_HFOV = 100, TRAVEL_HFOV = 58, APPROACH_MS = 420, SETTLE_MS = 900;

  var byId = {};
  DATA.scenes.forEach(function (s) { byId[s.id] = s; });

  function marker(label) {
    return function (div) {
      var ring = document.createElement('span');
      ring.className = 'vt-hotspot__ring';
      var cap = document.createElement('span');
      cap.className = 'vt-hotspot__label';
      cap.textContent = label;
      div.appendChild(ring);
      div.appendChild(cap);
    };
  }

  var config = {
    default: {
      firstScene: DATA.firstScene,
      sceneFadeDuration: 520,
      autoLoad: true
    },
    scenes: {}
  };

  DATA.scenes.forEach(function (s) {
    config.scenes[s.id] = {
      type: 'equirectangular',
      panorama: s.panorama,
      yaw: s.initialYaw,
      pitch: s.initialPitch,
      hfov: REST_HFOV,
      minHfov: 50,
      maxHfov: 120,
      showControls: false,
      compass: false,
      hotSpots: s.hotspots.map(function (h) {
        var target = byId[h.targetSceneId];
        return {
          id: h.id,
          yaw: h.yaw,
          pitch: h.pitch,
          type: 'info',
          cssClass: 'vt-hotspot',
          createTooltipFunc: marker(target ? target.name : ''),
          clickHandlerFunc: function () { travel(h.targetSceneId, h.yaw, h.pitch); }
        };
      })
    };
  });

  var viewer = pannellum.viewer('stage', config);
  var current = DATA.firstScene;
  var history = [];
  var busy = false;

  // Turn toward the doorway and push in before the crossfade, then ease back
  // out on arrival, so moving between rooms reads as walking, not a cut.
  function travel(target, yaw, pitch) {
    if (busy || !byId[target]) return;
    busy = true;
    // lookAt's callback rides on requestAnimationFrame, which a backgrounded
    // tab suspends. A timer backstop keeps the tour from wedging on 'busy'.
    var moved = false;
    var arrive = function () {
      if (moved) return;
      moved = true;
      history.push(current);
      current = target;
      viewer.loadScene(target, byId[target].initialPitch, yaw, TRAVEL_HFOV);
      setTimeout(release, 4000);
    };
    viewer.lookAt(pitch * 0.5, yaw, TRAVEL_HFOV, APPROACH_MS, arrive);
    setTimeout(arrive, APPROACH_MS + 150);
  }

  function jump(target) {
    if (busy || target === current || !byId[target]) return;
    busy = true;
    history.push(current);
    current = target;
    viewer.loadScene(target, byId[target].initialPitch, byId[target].initialYaw, REST_HFOV);
    setTimeout(release, 4000);
  }

  function release() {
    busy = false;
    render();
  }

  // 'scenechange' lands as soon as the new room is up; the fade event only
  // follows if animation frames are running. Both release the guard, and a
  // timer covers the case where neither arrives (a backgrounded tab).
  viewer.on('scenechange', release);
  viewer.on('scenechangefadedone', function () {
    viewer.lookAt(undefined, undefined, REST_HFOV, SETTLE_MS);
    release();
  });

  var chrome = document.getElementById('chrome');
  var titleEl = document.getElementById('title');

  function render() {
    titleEl.textContent = byId[current] ? byId[current].name : '';
    chrome.innerHTML = '';
    if (history.length) {
      var back = document.createElement('button');
      back.textContent = '\\u2190 Quay l\\u1ea1i';
      back.onclick = function () {
        if (busy || !history.length) return;
        var prev = history.pop();
        busy = true;
        current = prev;
        viewer.loadScene(prev, byId[prev].initialPitch, byId[prev].initialYaw, REST_HFOV);
        setTimeout(release, 4000);
      };
      chrome.appendChild(back);
    }
    DATA.scenes.forEach(function (s) {
      var b = document.createElement('button');
      b.textContent = s.name;
      if (s.id === current) b.className = 'active';
      b.onclick = function () { jump(s.id); };
      chrome.appendChild(b);
    });
  }

  render();
})();
</script>
</body>
</html>`

  const blob = new Blob([html], { type: 'text/html' })
  const slug =
    title
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'tour-360'
  return { blob, filename: `${slug}.html`, bytes: blob.size }
}
