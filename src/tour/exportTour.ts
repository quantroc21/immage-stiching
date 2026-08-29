import { FLIGHT } from './TourStage'
import type { SceneWithUrl } from './types'

/**
 * Packs the whole tour into one self-contained HTML file: Pannellum inlined,
 * every panorama embedded as a data URI. No server, no asset folder — the file
 * opens straight from disk, can be mailed around, or dropped on any host and
 * embedded in an iframe.
 *
 * The exported page carries the same two-slot warp as the app, driven by the
 * same FLIGHT timings, so a tour handed to someone else moves identically.
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
    flight: FLIGHT,
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
  #stage { position: absolute; inset: 0; isolation: isolate; overflow: hidden; }
  .vt-slot { position: absolute; inset: 0; will-change: transform, opacity; }
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
  #chrome { position: absolute; left: 0; right: 0; bottom: 0; z-index: 30;
    display: flex; gap: 8px; overflow-x: auto; padding: 12px;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
    background: linear-gradient(transparent, rgba(0,0,0,.75) 45%); }
  #chrome button { flex: none; border: 0; border-radius: 9999px; padding: 9px 16px;
    font-size: 13px; font-weight: 500; color: #fff; background: rgba(38,38,38,.92);
    cursor: pointer; }
  #chrome button.active { background: #4f46e5; }
  #title { position: absolute; top: 0; left: 0; z-index: 30; padding: 14px 16px;
    padding-top: max(14px, env(safe-area-inset-top)); font-size: 15px; font-weight: 600;
    text-shadow: 0 1px 6px rgba(0,0,0,.9); pointer-events: none; }
  @media (prefers-reduced-motion: reduce) {
    .vt-hotspot__ring { animation: none; }
    .vt-slot { transition-property: opacity !important; transition-delay: 0ms !important;
      transform: none !important; }
  }
</style>
</head>
<body>
<div id="stage"><div class="vt-slot" id="s0"></div><div class="vt-slot" id="s1"></div></div>
<div id="title"></div>
<div id="chrome"></div>
<script>${pannellumJs}</script>
<script>
(function () {
  var DATA = ${embedJson(data)};
  var F = DATA.flight;
  // Same limits as the app: wider than ~85 deg funnels on a portrait screen.
  var REST_HFOV = 70;

  var byId = {};
  DATA.scenes.forEach(function (s) { byId[s.id] = s; });

  var slots = [document.getElementById('s0'), document.getElementById('s1')];
  var viewers = [null, null];
  var front = 0;
  var current = DATA.firstScene;
  var trail = [];
  var busy = false;

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

  function configFor(id, entryYaw) {
    var s = byId[id];
    return {
      type: 'equirectangular',
      panorama: s.panorama,
      autoLoad: true,
      showControls: false,
      compass: false,
      yaw: entryYaw == null ? s.initialYaw : entryYaw,
      pitch: s.initialPitch,
      hfov: REST_HFOV,
      minHfov: 45,
      maxHfov: 85,
      minPitch: -80,
      maxPitch: 80,
      hotSpots: s.hotspots.map(function (h) {
        var target = byId[h.targetSceneId];
        return {
          id: h.id,
          yaw: h.yaw,
          pitch: h.pitch,
          type: 'info',
          cssClass: 'vt-hotspot',
          createTooltipFunc: marker(target ? target.name : ''),
          clickHandlerFunc: function (ev) { warp(h.targetSceneId, h.yaw, ev); }
        };
      })
    };
  }

  function reset(i) {
    if (viewers[i]) { viewers[i].destroy(); viewers[i] = null; }
    slots[i].innerHTML = '';
    slots[i].removeAttribute('style');
  }

  // Warm the rooms reachable from here so a move never waits on a decode.
  function preload(id) {
    (byId[id] ? byId[id].hotspots : []).forEach(function (h) {
      if (byId[h.targetSceneId]) new Image().src = byId[h.targetSceneId].panorama;
    });
  }

  /**
   * entryYaw null means a plain dissolve (picking a room off the menu);
   * a yaw means the visitor walked through a doorway and should fly.
   */
  function move(targetId, entryYaw, ev, record) {
    if (busy || !byId[targetId] || targetId === current) return;
    busy = true;

    var incoming = front === 0 ? 1 : 0;
    var outgoing = front;
    reset(incoming);
    slots[incoming].style.zIndex = 5;
    slots[incoming].style.transitionDuration = '0ms';
    if (entryYaw != null) slots[incoming].style.transform = 'scale(' + F.inScale + ')';

    var v = pannellum.viewer(slots[incoming], configFor(targetId, entryYaw));
    viewers[incoming] = v;

    var revealed = false;
    function reveal() {
      if (revealed) return;
      revealed = true;

      front = incoming;
      if (record !== false) trail.push(current);
      current = targetId;

      slots[incoming].style.zIndex = 10;
      slots[incoming].style.transitionProperty = 'transform';
      slots[incoming].style.transitionDuration = F.settleMs + 'ms';
      slots[incoming].style.transitionTimingFunction = F.inEase;
      slots[incoming].style.transform = 'scale(1)';

      slots[outgoing].style.zIndex = 20;
      slots[outgoing].style.pointerEvents = 'none';
      if (entryYaw != null) {
        var origin = '50% 50%';
        var box = ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect
          ? ev.currentTarget.getBoundingClientRect() : null;
        var r = document.getElementById('stage').getBoundingClientRect();
        if (box && r.width > 0 && r.height > 0) {
          origin = ((box.left + box.width / 2 - r.left) / r.width) * 100 + '% ' +
                   ((box.top + box.height / 2 - r.top) / r.height) * 100 + '%';
        }
        slots[outgoing].style.transformOrigin = origin;
        slots[outgoing].style.transitionProperty = 'transform, opacity';
        slots[outgoing].style.transitionDuration = F.warpMs + 'ms, ' + F.fadeMs + 'ms';
        slots[outgoing].style.transitionDelay = '0ms, ' + F.fadeDelayMs + 'ms';
        slots[outgoing].style.transitionTimingFunction = F.outEase + ', linear';
        slots[outgoing].style.transform = 'scale(' + F.outScale + ')';
      } else {
        slots[outgoing].style.transitionProperty = 'opacity';
        slots[outgoing].style.transitionDuration = F.warpMs + 'ms';
      }
      slots[outgoing].style.opacity = 0;

      render();
      preload(current);
      setTimeout(function () { reset(outgoing); busy = false; }, F.warpMs + 60);
    }

    // Reveal the moment the panorama is up; never stall if the event is missed
    // (a backgrounded tab suspends the frames Pannellum loads on).
    v.on('load', reveal);
    setTimeout(reveal, F.revealGraceMs);
  }

  function warp(targetId, yaw, ev) { move(targetId, yaw, ev, true); }
  function jump(targetId) { move(targetId, null, null, true); }

  var chrome = document.getElementById('chrome');
  var titleEl = document.getElementById('title');

  function render() {
    titleEl.textContent = byId[current] ? byId[current].name : '';
    chrome.innerHTML = '';
    if (trail.length) {
      var back = document.createElement('button');
      back.textContent = '\\u2190 Quay l\\u1ea1i';
      back.onclick = function () {
        if (busy || !trail.length) return;
        var prev = trail.pop();
        move(prev, null, null, false);
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

  // First room, straight in.
  viewers[0] = pannellum.viewer(slots[0], configFor(current, null));
  slots[0].style.zIndex = 10;
  render();
  preload(current);
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
