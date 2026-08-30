import { FLIGHT } from './flight'

/**
 * Builds the standalone tour page.
 *
 * Two callers share it so a tour never behaves differently depending on how it
 * was handed over: the offline export inlines Pannellum and the panoramas as
 * data URIs, while the hosted page links them, letting rooms stream in instead
 * of making the visitor download the whole tour before the first one appears.
 */

export interface TourPageHotspot {
  id: string
  yaw: number
  pitch: number
  targetSceneId: string
}

export interface TourPageScene {
  id: string
  name: string
  /** A data: URI for the offline file, or a URL for the hosted page. */
  panorama: string
  initialYaw: number
  initialPitch: number
  hotspots: TourPageHotspot[]
}

export interface TourPageOptions {
  title: string
  scenes: TourPageScene[]
  /** Pannellum's stylesheet, inlined or linked. */
  css: { inline: string } | { href: string }
  /** Pannellum itself, inlined or linked. */
  js: { inline: string } | { src: string }
}

/** Keeps a stray "</script>" inside the data from ending the script block. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function escapeText(value: string): string {
  return value.replace(/[<>&]/g, '')
}

export function renderTourPage({ title, scenes, css, js }: TourPageOptions): string {
  const cssTag =
    'inline' in css ? `<style>${css.inline}</style>` : `<link rel="stylesheet" href="${css.href}">`
  const jsTag = 'inline' in js ? `<script>${js.inline}</script>` : `<script src="${js.src}"></script>`
  const data = { firstScene: scenes[0].id, flight: FLIGHT, scenes }

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeText(title)}</title>
${cssTag}
<style>
  html, body { margin: 0; height: 100%; background: #0a0a0a; color: #fff;
    font-family: system-ui, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
  #stage { position: absolute; inset: 0; isolation: isolate; overflow: hidden; }
  .vt-slot { position: absolute; inset: 0; will-change: transform, opacity; }
  .vt-hotspot { position: absolute; width: 44px; height: 44px; cursor: pointer; }
  .vt-hotspot__ring { display: block; box-sizing: border-box; width: 100%; height: 100%;
    border-radius: 9999px; border: 3px solid rgba(255,255,255,.95);
    background: rgba(255,255,255,.22); transition: transform .15s ease, background .15s ease;
    animation: vt-pulse 2.4s ease-out infinite; }
  .vt-hotspot:hover .vt-hotspot__ring { transform: scale(1.15); background: rgba(255,255,255,.4); }
  .vt-hotspot__label { position: absolute; top: calc(100% + 6px); left: 50%;
    transform: translateX(-50%); max-width: 140px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; border-radius: 9999px; background: rgba(0,0,0,.75); padding: 3px 10px;
    font-size: 12px; font-weight: 500; line-height: 1.4; pointer-events: none; }
  @keyframes vt-pulse {
    0% { box-shadow: 0 2px 10px rgba(0,0,0,.5), 0 0 0 0 rgba(255,255,255,.5); }
    70% { box-shadow: 0 2px 10px rgba(0,0,0,.5), 0 0 0 18px rgba(255,255,255,0); }
    100% { box-shadow: 0 2px 10px rgba(0,0,0,.5), 0 0 0 0 rgba(255,255,255,0); }
  }
  #top { position: absolute; top: 0; left: 0; right: 0; z-index: 30; pointer-events: none;
    padding: 12px 16px 28px; padding-top: max(12px, env(safe-area-inset-top));
    background: linear-gradient(rgba(0,0,0,.72), transparent); }
  #title { font-size: 15px; font-weight: 600; text-shadow: 0 1px 6px rgba(0,0,0,.9); }
  #sub { margin-top: 2px; font-size: 12px; color: rgba(255,255,255,.62);
    text-shadow: 0 1px 6px rgba(0,0,0,.9); }
  #back { position: absolute; left: 12px; z-index: 31;
    bottom: max(16px, env(safe-area-inset-bottom)); border: 0; border-radius: 9999px;
    padding: 9px 16px; font-size: 13px; font-weight: 500; color: #fff;
    background: rgba(23,23,23,.92); cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.5); }
  #back[hidden] { display: none; }
  @media (prefers-reduced-motion: reduce) {
    .vt-hotspot__ring { animation: none; }
    .vt-slot { transition-property: opacity !important; transition-delay: 0ms !important;
      transform: none !important; }
  }
</style>
</head>
<body>
<div id="stage"><div class="vt-slot" id="s0"></div><div class="vt-slot" id="s1"></div></div>
<div id="top"><div id="title"></div><div id="sub"></div></div>
<button id="back" hidden></button>
${jsTag}
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

  var titleEl = document.getElementById('title');
  var subEl = document.getElementById('sub');
  var backEl = document.getElementById('back');

  backEl.textContent = '\\u2190 Quay l\\u1ea1i';
  backEl.onclick = function () {
    if (busy || !trail.length) return;
    move(trail.pop(), null, null, false);
  };

  function render() {
    titleEl.textContent = byId[current] ? byId[current].name : '';
    subEl.textContent = DATA.scenes.length + ' ph\\u00f2ng';
    backEl.hidden = trail.length === 0;
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
}
