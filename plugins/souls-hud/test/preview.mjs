/**
 * Build a self-contained preview of the HUD artwork.
 *
 * Inlines the real `lib/hud.css` and `lib/hud.js` and stubs `fetch` so the
 * renderer paints a chosen scenario around an app-like backdrop. Used with
 * headless Chrome to eyeball (and iterate on) the artwork:
 *
 *   node test/preview.mjs
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --disable-gpu --hide-scrollbars --user-data-dir=/tmp/hud-chrome \
 *     --force-device-scale-factor=2 --window-size=760,260 \
 *     --virtual-time-budget=2000 --screenshot=/tmp/hud-dark.png \
 *     "file:///<workspace>/plugins/souls-hud/preview/preview.html#dark"
 *
 * The `badges` and `badges-light` scenes are a gallery of every device against
 * every metal, drawn with the renderer's own `previewSvg` — the fastest way to
 * check the eight palettes and the motifs after touching either.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const css = readFileSync(new URL('lib/hud.css', root), 'utf8')
const js = readFileSync(new URL('lib/hud.js', root), 'utf8')
const outDir = new URL('preview/', root)
mkdirSync(outDir, { recursive: true })

/**
 * Best-effort live vitals, **opt-in**.
 *
 * With `--live` and the app running, the preview shows the user's real numbers
 * instead of a mock, so the HUD can be compared against a live session. It is off
 * by default because `preview/preview.html` is a committed file: running this
 * without the flag once baked the account's real balance and the capture timestamp
 * into the page, which is not something a repository should carry. The fallback
 * fixtures are the honest default for an artifact that ships.
 */
const useLive = process.argv.includes('--live')
async function liveState() {
  if (!useLive) return null
  try {
    const response = await fetch('http://127.0.0.1:19387/dsh-souls-hud/state.json', {
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) return null
    const state = await response.json()
    if (!state?.balance?.available) return null
    return state
  } catch {
    return null
  }
}

const live = await liveState()

/** Per-scenario vitals, keyed by the fragment the preview is opened with. */
const SCENES = {
  dark: {
    label: 'DSH-like dark frame',
    balance: { available: true, currency: 'CNY', recharge: 11.68, bonus: 4.2, hpRatio: 0.2336, fpRatio: 0.084 },
    context: { available: true, used: 235480, total: 1000000, percent: 24, ratio: 0.23548 },
    surface: 'dark',
  },
  full: {
    label: 'healthy vitals',
    balance: { available: true, currency: 'CNY', recharge: 47.5, bonus: 21.4, hpRatio: 0.95, fpRatio: 0.428 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.742 },
    surface: 'dark',
  },
  critical: {
    label: 'critical HP',
    balance: { available: true, currency: 'CNY', recharge: 4.1, bonus: 0, hpRatio: 0.082, fpRatio: 0 },
    context: { available: true, used: 931000, total: 1000000, percent: 93, ratio: 0.931 },
    surface: 'dark',
  },
  light: {
    label: 'light theme legibility',
    balance: { available: true, currency: 'CNY', recharge: 11.68, bonus: 4.2, hpRatio: 0.2336, fpRatio: 0.084 },
    context: { available: true, used: 235480, total: 1000000, percent: 24, ratio: 0.23548 },
    surface: 'light',
  },
  unknown: {
    label: 'signed out / no session',
    balance: { available: false, reason: 'signed-out' },
    context: { available: false, reason: 'no-session' },
    surface: 'dark',
  },
  // Exercises the chat anchor against a mock of the app's own layout classes:
  // a 184px sidebar, a 76px header band carrying the tab row, then messages.
  anchor: {
    label: 'chat anchor — your live vitals',
    surface: 'dark',
    mock: true,
    balance: live?.balance ?? {
      available: true, currency: 'CNY', recharge: 10.4, bonus: 0, hpRatio: 0.208, fpRatio: 0,
    },
    context: live?.context ?? {
      available: true, used: 355182, total: 1000000, percent: 36, ratio: 0.355182,
    },
  },
  zoom: {
    label: 'detail — 3x',
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.742 },
    surface: 'dark',
    scale: 3,
    width: 272,
  },
  damage: {    label: 'taking a hit — pale trail draining',
    surface: 'dark',
    scale: 2,
    width: 272,
    pollMs: 300,
    sequence: [
      {
        balance: { available: true, currency: 'CNY', recharge: 46.0, bonus: 12.75, hpRatio: 0.92, fpRatio: 0.255 },
        context: { available: true, used: 300000, total: 1000000, percent: 30, ratio: 0.3 },
      },
      {
        balance: { available: true, currency: 'CNY', recharge: 26.5, bonus: 12.75, hpRatio: 0.53, fpRatio: 0.255 },
        context: { available: true, used: 880000, total: 1000000, percent: 88, ratio: 0.88 },
      },
    ],
  },
  // The live mark is painted by the stylesheet (scoped to `#dsh-souls-hud`)
  // while the preview bakes its own paint, so a non-default device and metal
  // have to be exercised through the real cluster, not only through the gallery.
  'moon-silver': {
    label: 'live mark — moon on silver',
    surface: 'dark',
    device: 'moon',
    material: 'silver',
    width: 272,
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.742 },
  },
  'sword-iron-light': {
    label: 'live mark — sword on iron (light)',
    surface: 'light',
    device: 'sword',
    material: 'iron',
    width: 272,
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.742 },
  },
  // The burn gauge: an arc along the medal's milled edge, whose length is the
  // rate and whose colour is the tariff window.
  'burn-low': {
    label: 'burn — 25%, off-peak (cool)',
    surface: 'dark',
    device: 'moon',
    material: 'silver',
    burnRatio: 0.25,
    tpm: 5000,
    tariff: 'offpeak',
    width: 272,
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.742 },
  },
  'burn-high': {
    label: 'burn — 90%, peak (amber, breathing)',
    surface: 'dark',
    device: 'whale',
    material: 'bronze',
    burnRatio: 0.9,
    tpm: 18000,
    tariff: 'peak',
    width: 272,
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.742 },
  },
  'burn-octagon': {
    label: 'burn — 60%, peak, octagon',
    surface: 'light',
    device: 'sword',
    material: 'iron',
    shape: 'octagon',
    burnRatio: 0.6,
    tpm: 12000,
    tariff: 'peak',
    width: 272,
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.742 },
  },
  // The heat overlay, idle ring. Peak and off-peak have to differ when nothing is
  // burning, which is most of the time — that is the whole point of the overlay.
  'heat-peak': {
    label: 'peak, idle ring — the medal runs hot',
    surface: 'dark',
    tariff: 'peak',
    level: 0,
    burnRatio: 0,
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.74 },
  },
  'heat-offpeak': {
    label: 'off-peak, idle ring — the same badge, cold',
    surface: 'dark',
    tariff: 'offpeak',
    level: 0,
    burnRatio: 0,
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.74 },
  },
  'heat-peak-hot': {
    label: 'peak, burning — the overlay at full',
    surface: 'dark',
    tariff: 'peak',
    level: 4,
    burnRatio: 1,
    tpm: 18400,
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.74 },
  },
  'heat-peak-light': {
    label: 'peak, idle, light cut',
    surface: 'light',
    tariff: 'peak',
    level: 0,
    burnRatio: 0,
    material: 'bronze',
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.74 },
  },
  'heat-peak-octagon': {
    label: 'peak, idle, octagon plate',
    surface: 'dark',
    tariff: 'peak',
    level: 0,
    burnRatio: 0,
    shape: 'octagon',
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.74 },
  },
  // The settings form's preview board, built by the renderer's own
  // `previewCells` — the same four cells the form shows, at 2x, so the theme and
  // tariff combinations can be eyeballed (and shot on a light page *and* a dark
  // one: each cell forces its own theme, so both pages must look identical).
  cells: {
    label: 'settings preview board — theme × tariff',
    surface: 'dark',
    cells: true,
    device: 'moon',
    material: 'silver',
    burnRatio: 0.62,
    tpm: 12400,
    cacheTpm: 900000,
    tariff: 'peak',
    width: 272,
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.742 },
  },
  'cells-light': {
    label: 'settings preview board — on a light page',
    surface: 'light',
    cells: true,
    device: 'moon',
    material: 'silver',
    burnRatio: 0.62,
    tpm: 12400,
    cacheTpm: 900000,
    tariff: 'peak',
    width: 272,
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.742 },
  },
  // Every device against every metal, in one frame — the dark cut of each
  // material under the dark body, and its light cut on the `badges-light` scene.
  badges: {
    label: 'devices × metals — dark cut',
    surface: 'dark',
    gallery: true,
    width: 272,
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.742 },
  },
  'badges-light': {
    label: 'devices × metals — light cut',
    surface: 'light',
    gallery: true,
    width: 272,
    balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
    context: { available: true, used: 742000, total: 1000000, percent: 74, ratio: 0.742 },
  },
}

// Composite-onto-reality scenes. The capture is the whole screen in logical
// points; the DSH window's top-left corner sits at (146, 53), so a scene's
// offset is expressed in *window* coordinates and converted here.
const SHOT = process.env.DSH_HUD_SHOT
if (SHOT) {
  const WINDOW = { x: 227, y: 83 }
  const live = (label, wx, wy, extra) => ({
    label,
    surface: 'shot',
    shot: SHOT,
    offsetX: WINDOW.x + wx,
    offsetY: WINDOW.y + wy,
    width: 132,
    balance: { available: true, currency: 'CNY', recharge: 10.91, bonus: 0, hpRatio: 0.218, fpRatio: 0 },
    context: { available: true, used: 309537, total: 1000000, percent: 31, ratio: 0.3095 },
    ...extra,
  })
  SCENES['live-now'] = live('live: shipped default (88, 10) @132px', 88, 10)
  SCENES['live-wide'] = live('live: too wide (88, 10) @200px', 88, 10, { width: 200 })
  SCENES['live-top'] = live('live: flush to the top (88, 1) @132px', 88, 1)
  SCENES['live-below'] = live('live: below the brand row (88, 60) @132px', 88, 60)
  // Absolute screen coordinates, measured off the capture itself: chat column
  // left edge 411, header/tab band bottom 110, plus the 8px anchor inset.
  SCENES['live-chat'] = {
    ...live('live: chat message area anchor', 0, 0),
    offsetX: 411 + 20,
    offsetY: 110 + 10,
    width: 240,
  }
  SCENES['live-chat-narrow'] = { ...SCENES['live-chat'], width: 180 }
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Souls Style preview</title>
<style>${css}</style>
<style>
  html, body { margin: 0; height: 100%; }
  body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body[data-surface="dark"] {
    background:
      radial-gradient(120% 90% at 18% 0%, #23201c 0%, #17151300 60%),
      linear-gradient(160deg, #1b1a18 0%, #121110 55%, #0c0b0a 100%);
    color: #b9b2a4;
  }
  body[data-surface="light"] {
    background: linear-gradient(160deg, #f4f2ee 0%, #e6e2da 60%, #d8d3c8 100%);
    color: #4a453c;
  }
  /* A stand-in for the app chrome so the HUD is judged in context. */
  .chrome { position: fixed; inset: 0; pointer-events: none; }
  .chrome .rail {
    position: absolute; inset: 0 auto 0 0; width: 232px;
    background: rgba(255,255,255,.03);
    border-right: 1px solid rgba(255,255,255,.06);
  }
  body[data-surface="light"] .chrome .rail {
    background: rgba(0,0,0,.03); border-right-color: rgba(0,0,0,.07);
  }
  .chrome .lights { position: absolute; left: 15px; top: 14px; display: flex; gap: 8px; }
  .chrome .lights i { width: 12px; height: 12px; border-radius: 50%; background: #5b5b5b; }
  .chrome .title {
    position: absolute; left: 246px; top: 12px; font-size: 12px; opacity: .5;
    letter-spacing: .04em;
  }
  .chrome .copy {
    position: absolute; left: 268px; top: 108px; max-width: 420px;
    font-size: 12px; opacity: .45;
  }
  .chrome .scene { left: 268px; top: 74px; opacity: .35; letter-spacing: .08em; text-transform: uppercase; font-size: 10px; }
  /* "shot" scenes composite the HUD onto a real screen capture of the app so
     placement can be judged against the actual chrome. */
  body[data-surface="shot"] { background: #000; }
  body[data-surface="shot"] .shot {
    position: fixed; left: 0; top: 0; width: 1728px;
    pointer-events: none; user-select: none;
  }
  body[data-surface="shot"] .chrome { display: none; }
  /* Mock of the app's frame classes, so the chat anchor can be exercised with
     the real selectors and real geometry (184px sidebar, 76px header). */
  .mockFrame { position: fixed; inset: 0; display: flex; }
  .mockFrame .P9Gu9a_sidebarCol { width: 184px; flex: none; background: #16181c; }
  .mockFrame .P9Gu9a_centerCol { flex: 1; min-width: 0; position: relative; }
  .mockFrame ._5AcOhq_header { height: 76px; border-bottom: 1px solid rgba(255,255,255,.08);
    display: flex; align-items: flex-end; padding: 0 0 10px 20px; gap: 36px; }
  .mockFrame ._5AcOhq_tab { font-size: 13px; color: #8a8f98; }
  .mockFrame ._5AcOhq_tabActive { color: #5b8def; }
  .mockFrame ._5AcOhq_scrollBody { padding: 16px 20px; color: #8a8f98; }
  body:not([data-mock]) .mockFrame { display: none; }
  /* The badge gallery: one row per metal, one column per device. */
  .gallery { position: fixed; left: 268px; top: 96px; display: none;
    transform: scale(0.78); transform-origin: 0 0; }
  body[data-gallery] .gallery { display: block; }
  body[data-gallery] .chrome .copy { display: none; }
  .gallery table { border-collapse: separate; border-spacing: 8px 6px; }
  .galleryTitle { font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
    opacity: .45; margin: 6px 0 2px; }
  .gallery th { font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
    opacity: .55; font-weight: 500; text-align: center; }
  .gallery td { text-align: center; }
  .gallery .cell { display: inline-block; width: 44px; height: 44px; }
  .gallery td span.cell { width: 44px; height: 44px; }
  .gallery .rowLabel { font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
    opacity: .55; text-align: right; padding-right: 4px; }
</style>
</head>
<body data-surface="dark">
  <div class="mockFrame">
    <div class="P9Gu9a_sidebarCol"></div>
    <div class="P9Gu9a_centerCol">
      <div class="_5AcOhq_header">
        <span class="_5AcOhq_tab _5AcOhq_tabActive">Chat</span>
        <span class="_5AcOhq_tab">Trajectory</span>
      </div>
      <div class="_5AcOhq_scrollBody">messages scroll here</div>
    </div>
  </div>
  <img class="shot" alt="" hidden>
  <div class="gallery" id="gallery"></div>
  <div class="chrome">
    <div class="rail"></div>
    <div class="lights"><i></i><i></i><i></i></div>
    <div class="title">DeepSeek Harness</div>
    <div class="copy scene" id="scene-label"></div>
    <div class="copy">
      The cluster sits in the top-left over the frame, click-through, with the
      vitals rendered from live host data.
    </div>
  </div>
<script>
  var SCENES = ${JSON.stringify(SCENES)};
  function scene() {
    var key = (location.hash || '#dark').slice(1);
    return SCENES[key] || SCENES.dark;
  }
  var current = scene();
  var fetchCount = 0;
  document.body.setAttribute('data-surface', current.surface);
  // The app marks dark mode on <body>; mirror that so the light-theme branch
  // is exercised by the light scene only.
  if (current.surface === 'dark' || current.surface === 'shot') document.body.setAttribute('data-ds-dark-theme', '');
  if (current.shot) {
    var image = document.querySelector('.shot');
    image.hidden = false;
    image.src = current.shot;
  }
  if (current.mock) document.body.setAttribute('data-mock', '');
  if (current.gallery || current.cells) document.body.setAttribute('data-gallery', '');
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('scene-label').textContent = current.label;
  });
  window.fetch = function () {
    var s = scene();
    // A sequence scene walks through frames so time-based behaviour (the pale
    // damage trail, the change flash) can be captured by a screenshot.
    var frame = s.sequence ? s.sequence[Math.min(fetchCount, s.sequence.length - 1)] : s;
    fetchCount += 1;
    return Promise.resolve({
      ok: true,
      json: function () {
        return Promise.resolve({
          ok: true,
          balance: frame.balance,
          context: frame.context,
          burn: {
            available: true,
            metric: 'new-tokens-per-minute',
            tokensPerMin: s.tpm || 0,
            outputTokensPerMin: Math.round((s.tpm || 0) / 4),
            cacheTokensPerMin: s.cacheTpm || 0,
            ratio: s.burnRatio || 0,
            level: (s.burnRatio || 0) === 0 ? 0 : Math.max(1, Math.ceil((s.burnRatio || 0) * 4)),
            fullScaleTpm: 20000,
            samples: 20,
            windowMs: 60000,
          },
          tariff: {
            enabled: s.tariff !== 'off',
            peak: s.tariff === 'peak',
            reason: s.tariff === 'peak' ? 'peak-hours' : 'window',
            weekend: false,
            utcClock: '02:19',
            windowStart: 990,
            windowEnd: 30,
            weekendOffPeak: true,
          },
          config: { pollMs: s.pollMs || 600000, barWidth: s.width || 272, scale: s.scale || 1, offsetX: s.offsetX === undefined ? 88 : s.offsetX, offsetY: s.offsetY === undefined ? 11 : s.offsetY, showText: true, idleDimMs: 0, criticalPercent: 25, device: s.device || 'whale', material: s.material || 'bronze', shape: s.shape || 'round', customDevice: { present: false } },
        });
      },
    });
  };
  /**
   * Draw the badge gallery with the renderer's own markup.
   *
   * The renderer mounts asynchronously (it fetches its stylesheet first), and
   * the gallery needs both that markup and that stylesheet, so it waits for the
   * guard the renderer publishes rather than guessing a delay.
   */
  function drawGallery() {
    var hud = window.__DSH_SOULS_HUD__;
    if (!hud || typeof hud.previewSvg !== 'function') { setTimeout(drawGallery, 120); return; }
    var devices = ['whale', 'hammer', 'sword', 'sun', 'moon', 'wolf'];
    var materials = ['bronze', 'iron', 'silver', 'gold'];
    var shapes = ['round', 'octagon'];
    var html = '';
    shapes.forEach(function (shape) {
      html += '<div class="galleryTitle">' + shape + '</div><table><tr><th></th>';
      devices.forEach(function (device) { html += '<th>' + device + '</th>'; });
      html += '</tr>';
      materials.forEach(function (material) {
        html += '<tr><td class="rowLabel">' + material + '</td>';
        devices.forEach(function (device) {
          html += '<td><span class="dsh-sh__mark cell" data-preview data-material="' + material +
            '" data-device="' + device + '">' +
            hud.previewSvg({ device: device, shape: shape, material: material }) + '</span></td>';
        });
        html += '</tr>';
      });
      html += '</table>';
    });
    document.getElementById('gallery').innerHTML = html;
  }
  /**
   * Draw the settings form's preview board itself.
   *
   * It calls the renderer's previewCells, i.e. the exact function the form calls,
   * so a change to the cells shows up here as well.
   */
  function drawCells() {
    var hud = window.__DSH_SOULS_HUD__;
    if (!hud || typeof hud.previewCells !== 'function') { setTimeout(drawCells, 120); return; }
    var cells = hud.previewCells({
      device: current.device || 'whale',
      shape: current.shape || 'round',
      material: current.material || 'bronze',
      gauge: current.burnRatio || 0,
      size: 96,
    });
    var html = '<div style="display:flex;gap:26px">';
    cells.forEach(function (cell) {
      html += '<div style="display:flex;flex-direction:column;align-items:center;gap:8px">' +
        cell.html +
        '<span style="font:11px monospace;opacity:.6">' + (cell.dark ? 'dark' : 'light') + ' · ' + cell.tariff + '</span></div>';
    });
    html += '</div>';
    document.getElementById('gallery').innerHTML = html;
  }
  if (current.gallery) drawGallery();
  if (current.cells) drawCells();
</script>
<script>${js}</script>
</body>
</html>
`

writeFileSync(new URL('preview.html', outDir), html)
console.log('wrote', new URL('preview.html', outDir).pathname)
console.log('scenes:', Object.keys(SCENES).join(', '))
