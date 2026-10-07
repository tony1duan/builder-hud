/**
 * The SVG upload path, driven for real.
 *
 * The normalizer that turns a picked file into a badge-ready device is the one
 * piece of this plugin that cannot be reached from Node: it is a browser script
 * and it uses `DOMParser`/`XMLSerializer`. So this runs it where it lives —
 * headless Chrome — and reads the answer back out of the rendered DOM with
 * `--dump-dom`, which this Chrome build does honour (the older
 * `--virtual-time-budget`-plus-`--screenshot` trick did not).
 *
 * It checks the two halves of the pipeline separately and then together:
 *
 *   - `lib/client.js`'s `normalizeUpload` — what is stored;
 *   - `lib/hud.js`'s `inspectUpload` / `previewSvg` — what is drawn;
 *   - a custom device surviving both, including the regression that a nested
 *     `<svg>` in the device silently renders nothing inside the medallion.
 *
 * Run: node test/upload.mjs        (needs Google Chrome installed)
 * Skip with: DSH_HUD_CHROME=none node test/upload.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CHROME =
  process.env.DSH_HUD_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

if (CHROME === 'none' || !existsSync(CHROME)) {
  console.log('upload: skipped (no Chrome at %s)', CHROME)
  process.exit(0)
}

const root = new URL('../', import.meta.url)
const client = readFileSync(new URL('lib/client.js', root), 'utf8')
const hud = readFileSync(new URL('lib/hud.js', root), 'utf8')
const css = readFileSync(new URL('lib/hud.css', root), 'utf8')

/** The fixtures, kept next to the assertions they belong to. */
const FIXTURES = {
  filled:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
    '<rect x="2" y="2" width="20" height="20" rx="3" fill="#e11d48"/></svg>',
  lineArt:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<path d="M3 21 L21 3" fill="none" stroke="#111827" stroke-width="2.5" stroke-linecap="round"/></svg>',
  refs:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<defs><linearGradient id="shade"><stop offset="0" stop-color="#fff"/></linearGradient>' +
    '<clipPath id="cut"><circle cx="12" cy="12" r="10"/></clipPath></defs>' +
    '<rect x="0" y="0" width="24" height="24" fill="url(#shade)" clip-path="url(#cut)"/></svg>',
  hostile:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onclick="alert(1)" style="fill:red">' +
    '<script>alert(2)</script><image href="https://example.com/x.png"/>' +
    '<a href="javascript:alert(3)"><circle cx="12" cy="12" r="9" fill="#0f0"/></a>' +
    '<use href="https://example.com/y.svg#a"/></svg>',
  sized: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="48"><circle cx="16" cy="24" r="10" fill="#333"/></svg>',
  noSize: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L4 4"/></svg>',
}

// A literal `</script>` anywhere in the page's source — and the hostile fixture
// contains one — would end the inline script early, so it is escaped.
const fixturesJson = JSON.stringify(FIXTURES).replace(/<\//g, '<\\/')

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>souls-hud upload test</title>
<style>${css}</style></head>
<body>
<pre id="result">pending</pre>
<pre id="errors"></pre>
<script>
  // The client half is a module-loader bundle, so its factory is captured the
  // same way the browser's module controller does it.
  window.__CSS__ = document.querySelector('style').textContent;
  window.__HUD_ERRORS__ = [];
  window.addEventListener('error', function (event) {
    window.__HUD_ERRORS__.push(String(event.message) + ' @' + event.lineno);
  });
  window.__ModuleLoader__ = { load: function (definition) { window.__HUD_DEF__ = definition; } };
  document.addEventListener('DOMContentLoaded', function () {
    var box = document.getElementById('errors');
    if (box) box.textContent = (window.__HUD_ERRORS__ || []).join('\\n');
  });
<\/script>
<script>${client}<\/script>
<script>
  // The renderer mounts asynchronously; give it a fetch that settles fast and
  // never reaches the network, and a stylesheet it can install.
  window.fetch = function (url) {
    var target = String(url);
    if (target.indexOf('hud.css') !== -1) {
      return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(window.__CSS__); } });
    }
    return Promise.resolve({
      ok: false, status: 404,
      text: function () { return Promise.resolve(''); },
      json: function () { return Promise.resolve({}); },
    });
  };
<\/script>
<script>${hud}<\/script>
<script>
(function () {
  // NOTE: this script is a template literal. No regex literals (a backslash is an
  // escape for the *test file*: \s becomes s, \b becomes a backspace) and no
  // backticks. Use string operations.
  var results = [];
  try {
  function check(name, condition, detail) {
    results.push((condition ? 'PASS ' : 'FAIL ') + name + (condition ? '' : ' :: ' + String(detail)));
  }
  var FIXTURES = ${fixturesJson};
  var plugin = window.__HUD_DEF__.factory(function () { return {}; });
  var normalize = plugin.normalizeUpload;
  var renderer = window.__DSH_SOULS_HUD__;

  check('factory exports the normalizer', typeof normalize === 'function');
  check('renderer publishes inspectUpload + previewSvg',
    renderer && typeof renderer.inspectUpload === 'function' && typeof renderer.previewSvg === 'function');

  // --- refusals ------------------------------------------------------------
  check('empty file is refused', normalize('').reason === 'empty', JSON.stringify(normalize('')));
  check('non-SVG text is refused', normalize('hello').reason === 'not-an-svg');
  check('an HTML document is refused', normalize('<div>x</div>').reason === 'not-an-svg');
  check('an SVG with no size information is refused',
    normalize(FIXTURES.noSize).reason === 'no-viewbox');
  check('an oversized file is refused',
    normalize('<svg viewBox="0 0 4 4">' + 'x'.repeat(70000) + '</svg>').reason === 'too-large');

  // --- what a filled drawing becomes ---------------------------------------
  var filled = normalize(FIXTURES.filled);
  check('a filled drawing is accepted', filled.ok === true, JSON.stringify(filled).slice(0, 200));
  check('its hard-coded colour is gone', filled.svg.indexOf('#e11d48') === -1);
  check('its fill is currentColor', filled.svg.indexOf('fill="currentColor"') !== -1, filled.svg.slice(0, 200));
  check('its rect became a path', filled.svg.indexOf('<path') !== -1 && filled.svg.indexOf('<rect') === -1, filled.svg);
  check('its viewBox survives', filled.svg.indexOf('viewBox="0 0 24 24"') !== -1);
  check('the preview markup is not empty', filled.preview && filled.preview.markup.length > 0);
  check('the preview keeps the viewBox', filled.preview && filled.preview.viewBox === '0 0 24 24');

  // A rounded rect has to keep its corners through the path conversion.
  check('a rounded rect keeps its arcs', filled.svg.indexOf('A3 3 0 0 1') !== -1, filled.svg);

  // --- what line art becomes -----------------------------------------------
  var line = normalize(FIXTURES.lineArt);
  check('line art is accepted', line.ok === true);
  check('line art keeps fill="none"', line.svg.indexOf('fill="none"') !== -1, line.svg);
  check('line art keeps its own stroke width',
    line.svg.indexOf('stroke-width="2.5"') !== -1, line.svg);
  check('line art is stroked with currentColor',
    line.svg.indexOf('stroke="currentColor"') !== -1, line.svg);

  // --- ids and references ---------------------------------------------------
  var refs = normalize(FIXTURES.refs);
  check('a drawing with defs is accepted', refs.ok === true);
  // Plain string checks on purpose: regex literals inside this page's template
  // literal lose their backslashes, and a check that quietly stopped testing
  // anything is worse than no check.
  check('its ids are namespaced',
    refs.svg.indexOf('id="dsh-sh-u') !== -1 && refs.svg.indexOf('id="shade"') === -1,
    refs.svg.slice(0, 260));
  check('its own gradient reference is gone',
    refs.svg.indexOf('url(#shade)') === -1 && refs.svg.indexOf('url(#dsh-sh-u') !== -1,
    refs.svg);
  check('its clip-path follows the renamed id',
    refs.svg.indexOf('url(#cut)') === -1 && refs.svg.indexOf('clip-path="url(#dsh-sh-u') !== -1,
    refs.svg.slice(0, 400));

  // --- hostile input --------------------------------------------------------
  var hostile = normalize(FIXTURES.hostile);
  check('a hostile drawing is accepted but stripped', hostile.ok === true);
  check('no script element survives', hostile.svg.toLowerCase().indexOf('<script') === -1);
  check('no event handler survives', hostile.svg.toLowerCase().indexOf('onclick') === -1, hostile.svg.slice(0, 200));
  check('no inline style survives', hostile.svg.toLowerCase().indexOf('style=') === -1, hostile.svg.slice(0, 200));
  check('no remote image survives', hostile.svg.toLowerCase().indexOf('<image') === -1);
  check('no javascript: URL survives', hostile.svg.toLowerCase().indexOf('javascript:') === -1);
  check('no external reference survives', hostile.svg.indexOf('example.com') === -1);
  check('the drawing inside it does survive', hostile.svg.indexOf('<circle') !== -1 || hostile.svg.indexOf('<path') !== -1);

  // --- width/height becomes a viewBox --------------------------------------
  var sized = normalize(FIXTURES.sized);
  check('a drawing with only width/height gets a viewBox', sized.ok === true && sized.preview.viewBox === '0 0 32 48',
    JSON.stringify(sized.ok ? sized.preview : sized));

  // --- and now the renderer's half -----------------------------------------
  var inspected = renderer.inspectUpload(filled.svg);
  check('the renderer accepts the normalized file', Boolean(inspected), 'inspectUpload returned nothing');
  check('the renderer keeps the viewBox', inspected && inspected.viewBox === '0 0 24 24');

  var custom = renderer.previewSvg({ device: 'custom', shape: 'round', material: 'silver', custom: inspected });
  check('the custom device reaches the medallion', custom.indexOf('data-device="custom"') !== -1, custom.slice(0, 200));
  check('the device is fitted by a group transform', custom.indexOf('translate(8,8)') !== -1, custom.slice(0, 400));
  // Regression, found by the devices x metals gallery: a nested <svg> inside
  // this frame is laid out as a zero-sized viewport and the device disappears.
  var devicePart = custom.slice(custom.indexOf('dsh-sh__device'));
  check('the device is not a nested <svg>',
    devicePart.indexOf('<svg') === -1, devicePart.slice(0, 200));
  check('every device shape is painted from the metal',
    custom.indexOf('fill="url(#dsh-shp') !== -1, 'no preview gradient reference found');

  // --- the burn gauge -------------------------------------------------------
  //
  // The gauge is one full-length path per silhouette whose *visible* arc is a
  // dash: stroke-dasharray is the perimeter and stroke-dashoffset slides it out of
  // view. That is what makes it animatable — stroke-dashoffset is a CSS property,
  // so a new reading glides instead of snapping, while a path's "d" cannot be
  // transitioned (rewriting "d" per poll was the first implementation, and it
  // jumped).
  //
  // It follows the plate it belongs to: a circle on the round medal's milled
  // edge, the inset octagon for the cut-corner plate.
  var idleGauge = renderer.previewSvg({ device: 'whale', shape: 'round', gauge: 0 });
  var halfGauge = renderer.previewSvg({ device: 'whale', shape: 'round', gauge: 0.5 });
  var fullGauge = renderer.previewSvg({ device: 'whale', shape: 'round', gauge: 1 });
  var octagonGauge = renderer.previewSvg({ device: 'whale', shape: 'octagon', gauge: 0.25 });
  function gaugeAttrOf(markup, name) {
    var at = markup.indexOf('<path class="dsh-sh__gauge"');
    if (at === -1) return null;
    var key = ' ' + name + '="';
    var found = markup.indexOf(key, at);
    if (found === -1) return null;
    var from = found + key.length;
    return markup.slice(from, markup.indexOf('"', from));
  }
  function gaugePathOf(markup) {
    return gaugeAttrOf(markup, 'd');
  }
  function gaugeOffsetOf(markup) {
    var value = gaugeAttrOf(markup, 'stroke-dashoffset');
    return value === null ? null : Number(value);
  }
  function gaugeLengthOf(markup) {
    var value = gaugeAttrOf(markup, 'stroke-dasharray');
    return value === null ? null : Number(value);
  }
  // The path is always the whole perimeter; the fill is what moves.
  var length = gaugeLengthOf(halfGauge);
  check('the gauge declares the whole perimeter as one dash',
    typeof length === 'number' && Math.abs(length - 2 * Math.PI * 21.1) < 0.01, String(length));
  check('an idle gauge has slid completely out of view',
    gaugeOffsetOf(idleGauge) === gaugeLengthOf(idleGauge), String(gaugeOffsetOf(idleGauge)));
  check('a half gauge shows half the perimeter',
    Math.abs(gaugeOffsetOf(halfGauge) - length / 2) < 0.01, String(gaugeOffsetOf(halfGauge)));
  check('a full gauge shows all of it', gaugeOffsetOf(fullGauge) === 0, String(gaugeOffsetOf(fullGauge)));
  check('the path itself never changes with the reading',
    gaugePathOf(idleGauge) === gaugePathOf(fullGauge) && gaugePathOf(idleGauge).length > 0);
  check('the round gauge is an arc',
    (gaugePathOf(halfGauge) || '').indexOf('A21.1 21.1') !== -1, gaugePathOf(halfGauge));
  check('the round gauge closes with two arcs',
    ((gaugePathOf(fullGauge) || '').match(/A21\.1 21\.1/g) || []).length === 2, gaugePathOf(fullGauge));
  check('the octagon gauge follows the octagon',
    (gaugePathOf(octagonGauge) || '').indexOf('L') !== -1 && (gaugePathOf(octagonGauge) || '').indexOf('A') === -1,
    gaugePathOf(octagonGauge));
  check('the octagon gauge closes its outline',
    (gaugePathOf(octagonGauge) || '').indexOf('Z') !== -1, gaugePathOf(octagonGauge));
  // Eight edges of the octagon, always walked in full: the dash decides the fill.
  var octagonEdges = (gaugePathOf(octagonGauge) || '').match(/L/g) || [];
  var quarterOffset = gaugeOffsetOf(octagonGauge);
  var octagonLength = gaugeLengthOf(octagonGauge);
  check('the octagon perimeter is walked edge by edge',
    octagonEdges.length === 8, String(octagonEdges.length));
  check('a quarter of the octagon hides three quarters of it',
    Math.abs(quarterOffset - octagonLength * 0.75) < 0.01, String(quarterOffset));
  check('the octagon perimeter is longer than the round one', octagonLength > length);

  // --- the motion contract --------------------------------------------------
  //
  // Both readouts animate, and that is a *requirement*, not decoration: the values
  // arrive from a 15 s poll, so an unanimated bar or ring is a jump every 15 s.
  // A still screenshot cannot show a transition, so ask the browser for the
  // computed style. The page is standing in for the app here, so it mounts the
  // same markup the live HUD builds inside the same stylesheet.
  var motionProbe = document.createElement('div');
  motionProbe.id = 'dsh-souls-hud';
  // The live DOM is a .dsh-sh__mark wrapper around the medallion SVG (the wrapper
  // is what carries the material/device/tariff attributes), so the probe has to
  // build the same shape or the stylesheet's rules cannot match.
  motionProbe.innerHTML =
    '<div class="dsh-sh__bars"><div class="dsh-sh__row" data-kind="hp">' +
    '<div class="dsh-sh__ghost"></div><div class="dsh-sh__fill"></div></div></div>' +
    '<span class="dsh-sh__mark" data-material="bronze" data-device="whale" data-tariff="peak">' +
    renderer.previewSvg({ device: 'whale', material: 'bronze', gauge: 0.4 }) +
    '</span>';
  document.body.appendChild(motionProbe);
  var fillStyle = getComputedStyle(motionProbe.querySelector('.dsh-sh__fill'));
  var gaugeStyle = getComputedStyle(motionProbe.querySelector('.dsh-sh__gauge'));
  var fillSeconds = parseFloat(fillStyle.transitionDuration) || 0;
  check('the bars glide rather than snap', fillSeconds >= 1,
    'bar transition-duration is ' + fillStyle.transitionDuration);
  check('the bars ease out rather than linearly', fillStyle.transitionTimingFunction.indexOf('cubic-bezier') !== -1,
    fillStyle.transitionTimingFunction);
  check('the burn ring animates its dash offset',
    gaugeStyle.transitionProperty.indexOf('stroke-dashoffset') !== -1,
    gaugeStyle.transitionProperty);
  var gaugeSeconds = parseFloat(gaugeStyle.transitionDuration) || 0;
  check('the burn ring glides too', gaugeSeconds >= 1,
    'gauge transition-duration is ' + gaugeStyle.transitionDuration);
  check('the burn ring transitions its colour with the tariff too',
    gaugeStyle.transitionProperty.indexOf('stroke') !== -1, gaugeStyle.transitionProperty);
  motionProbe.remove();

  // --- frame structure ------------------------------------------------------
  //
  // The heat overlay is opacity-gated by the tariff window, so anything nested
  // inside it disappears when the overlay is hidden — which is exactly how a
  // misplaced closing tag hid the figure off-peak while it looked fine at peak.
  //
  // No regexes here: this script is a template literal, so a backslash in a
  // pattern is an escape *for the test file*, and a word boundary silently became
  // a backspace character. String operations cannot be mis-escaped.
  // --- an empty gauge draws nothing ---------------------------------------------
  //
  // 'stroke-dasharray: L' with the offset at 'L' puts the path start on a dash
  // boundary, and Chrome paints a zero-length dash there: with a round cap that is
  // a *dot*, visible at the octagon's top-left vertex while nothing is burning.
  // The cap has to stay round — it is what makes the lit end look struck — so the
  // empty state is stated and faded out instead.
  var emptyFrame = renderer.previewSvg({ device: 'whale', shape: 'octagon', material: 'bronze', gauge: 0 });
  var litFrame = renderer.previewSvg({ device: 'whale', shape: 'octagon', material: 'bronze', gauge: 0.5 });
  check('an empty gauge says so', emptyFrame.indexOf('dsh-sh__gauge') !== -1 && emptyFrame.indexOf('data-empty="1"') !== -1,
    'no data-empty on the empty gauge');
  check('a lit gauge does not', litFrame.indexOf('data-empty') === -1, 'a lit gauge was marked empty');
  // ...and the stylesheet acts on it, which is the part that actually paints.
  var gaugeHost = document.createElement('div');
  gaugeHost.className = 'dsh-sh__mark';
  gaugeHost.setAttribute('data-material', 'bronze');
  gaugeHost.setAttribute('data-device', 'whale');
  gaugeHost.setAttribute('data-tariff', 'offpeak');
  gaugeHost.innerHTML = emptyFrame;
  document.body.appendChild(gaugeHost);
  var emptyGauge = gaugeHost.querySelector('.dsh-sh__gauge');
  check('and the empty arc is not painted', getComputedStyle(emptyGauge).opacity === '0',
    'opacity is ' + getComputedStyle(emptyGauge).opacity);
  gaugeHost.innerHTML = litFrame;
  var litGauge = gaugeHost.querySelector('.dsh-sh__gauge');
  check('while a lit arc is', Number(getComputedStyle(litGauge).opacity) > 0,
    'opacity is ' + getComputedStyle(litGauge).opacity);
  check('and keeps its round cap', litGauge.getAttribute('stroke-linecap') === 'round',
    'linecap is ' + litGauge.getAttribute('stroke-linecap'));
  gaugeHost.remove();

  // --- the arc's bright core -----------------------------------------------------
  //
  // The gauge is two <path>s on one geometry: a coloured band, and a narrow bright
  // core riding its centre. Nothing structural holds them together — they are two
  // elements in a string — so if a reading is applied to one and not the other, the
  // core is left hanging off the end of the band it is meant to light. Hence the
  // same-dash check; the brightness checks below are the other half, in the
  // stylesheet's own terms.
  function coreAttrOf(markup, name) {
    var at = markup.indexOf('<path class="dsh-sh__gauge-core"');
    if (at === -1) return null;
    var key = ' ' + name + '="';
    var found = markup.indexOf(key, at);
    if (found === -1) return null;
    var from = found + key.length;
    return markup.slice(from, markup.indexOf('"', from));
  }
  check('the arc carries a bright core', coreAttrOf(halfGauge, 'd') !== null, 'no core path was rendered');
  check('the core rides the band exactly',
    coreAttrOf(halfGauge, 'd') === gaugePathOf(halfGauge) &&
      coreAttrOf(halfGauge, 'stroke-dasharray') === gaugeAttrOf(halfGauge, 'stroke-dasharray') &&
      coreAttrOf(halfGauge, 'stroke-dashoffset') === gaugeAttrOf(halfGauge, 'stroke-dashoffset'),
    'the core and the band disagree');
  check('an empty arc empties its core as well',
    coreAttrOf(idleGauge, 'data-empty') === '1' && coreAttrOf(litFrame, 'data-empty') === null,
    'the core was not told the arc is empty');

  var coreHost = document.createElement('div');
  coreHost.className = 'dsh-sh__mark';
  coreHost.setAttribute('data-material', 'bronze');
  coreHost.setAttribute('data-device', 'whale');
  coreHost.setAttribute('data-tariff', 'peak');
  coreHost.innerHTML = litFrame;
  document.body.appendChild(coreHost);
  var restCore = getComputedStyle(coreHost.querySelector('.dsh-sh__gauge-core'));
  check('the core is a hairline rather than a second arc', parseFloat(restCore.strokeWidth) < 1, restCore.strokeWidth);
  check('and is dark until a burn level lights it', restCore.strokeOpacity === '0', restCore.strokeOpacity);

  // Every lit level breathes — the earlier cut only breathed at the top level — and
  // the band and the core breathe *together*, because a steady band under a pulsing
  // filament reads as a rendering fault rather than as breathing.
  //
  // A fresh element per level, on purpose: stroke-opacity is transitioned, and a
  // computed style read in the same tick as the attribute change reports the value
  // the transition is *leaving*, which is how the first cut of this check managed to
  // measure zero at every level while the rules were all correct.
  var quiet = [];
  var coreOpacity = {};
  for (var level = 1; level <= 4; level += 1) {
    var levelHost = document.createElement('div');
    levelHost.className = 'dsh-sh__mark';
    levelHost.setAttribute('data-material', 'bronze');
    levelHost.setAttribute('data-device', 'whale');
    levelHost.setAttribute('data-tariff', 'peak');
    levelHost.setAttribute('data-burn', String(level));
    levelHost.innerHTML = litFrame;
    document.body.appendChild(levelHost);
    var bandAt = getComputedStyle(levelHost.querySelector('.dsh-sh__gauge'));
    var coreAt = getComputedStyle(levelHost.querySelector('.dsh-sh__gauge-core'));
    if (bandAt.animationName !== 'dsh-sh-breathe') quiet.push('band@' + level + '=' + bandAt.animationName);
    if (coreAt.animationName !== 'dsh-sh-breathe') quiet.push('core@' + level + '=' + coreAt.animationName);
    coreOpacity[level] = Number(coreAt.strokeOpacity);
    levelHost.remove();
  }
  check('every lit level breathes, band and core together', quiet.length === 0, quiet.join(', '));
  check('the core brightens as the burn climbs',
    coreOpacity[1] > 0 && coreOpacity[2] > coreOpacity[1] && coreOpacity[3] > coreOpacity[2] &&
      coreOpacity[4] > coreOpacity[3],
    JSON.stringify(coreOpacity));
  // The empty rule is written after the level rules precisely so it wins this tie.
  coreHost.setAttribute('data-burn', '4');
  coreHost.innerHTML = emptyFrame;
  check('an arc with nothing burning does not breathe, even at a burning level',
    getComputedStyle(coreHost.querySelector('.dsh-sh__gauge')).animationName === 'none',
    'the empty gauge is animating');
  coreHost.remove();

  // --- the floating cluster paints no surface ------------------------------------
  //
  // Floating used to mean a card: a translucent panel with a hairline and a lift
  // shadow. It read as an app panel pasted over the conversation, and the artwork
  // never needed it — the medallion, each bar and its socket, and the read-outs all
  // carry their own shadow in both themes, so the drawing is what separates the
  // cluster from whatever is behind it. What must *not* go with the surface is the
  // pointer behaviour: the padding is the grab area, and the cursor is the only hint
  // that it can be dragged at all.
  var floatHost = document.createElement('div');
  floatHost.id = 'dsh-souls-hud';
  floatHost.className = 'dsh-sh--float';
  floatHost.innerHTML = renderer.previewSvg({ device: 'whale', material: 'bronze', gauge: 0.4 });
  document.body.appendChild(floatHost);
  var floatStyle = getComputedStyle(floatHost);
  check('a floating cluster paints no background of its own',
    floatStyle.backgroundColor === 'rgba(0, 0, 0, 0)', floatStyle.backgroundColor);
  check('and casts no card shadow', floatStyle.boxShadow === 'none', floatStyle.boxShadow);
  check('but still takes the pointer, so it can be dragged',
    floatStyle.pointerEvents === 'auto' && floatStyle.cursor === 'grab',
    floatStyle.pointerEvents + ' / ' + floatStyle.cursor);
  check('and keeps the padding that is the grab area',
    parseFloat(floatStyle.paddingLeft) > 0, floatStyle.paddingLeft);
  floatHost.remove();

  // --- a lit fracture is the ring's own light ------------------------------------
  //
  // The point of lighting the fractures from the arc is that they cannot read as a
  // different light: same colour, same tariff, same brightness. The colour comes from
  // the stylesheet, so a computed style is the only place it can be read.
  function crackHost(tariff, burn) {
    var host = document.createElement('div');
    host.className = 'dsh-sh__mark';
    host.setAttribute('data-material', 'bronze');
    host.setAttribute('data-device', 'whale');
    host.setAttribute('data-tariff', tariff);
    host.setAttribute('data-burn', burn);
    host.innerHTML = renderer.previewSvg({ device: 'whale', material: 'bronze', gauge: 0.6 });
    document.body.appendChild(host);
    return host;
  }
  var peakHost = crackHost('peak', '4');
  var peakRing = getComputedStyle(peakHost.querySelector('.dsh-sh__gauge')).stroke;
  var peakLit = getComputedStyle(peakHost.querySelector('.dsh-sh__crack[data-lit="1"] .dsh-sh__crack-band')).stroke;
  var peakUnlit = peakHost.querySelector('.dsh-sh__crack:not([data-lit])');
  check('a lit fracture is the colour of the ring that lit it', peakLit === peakRing,
    'fracture ' + peakLit + ' vs ring ' + peakRing);
  check('a fracture the arc has not reached stays dark',
    peakUnlit !== null && getComputedStyle(peakUnlit).opacity === '0',
    peakUnlit === null ? 'no unlit fracture in the frame' : getComputedStyle(peakUnlit).opacity);
  check('and one it has reached is lit',
    Number(getComputedStyle(peakHost.querySelector('.dsh-sh__crack[data-lit="1"]')).opacity) > 0,
    getComputedStyle(peakHost.querySelector('.dsh-sh__crack[data-lit="1"]')).opacity);
  // The flow gradient: nine stops, each starting a little after the last, and an
  // animation on them — that stagger is the whole of the travelling light.
  var flowStops = peakHost.querySelectorAll('.dsh-sh__flow');
  var delays = [].map.call(flowStops, function (stop) { return stop.style.animationDelay; });
  check('the flow gradient has its stops', flowStops.length === 9, 'stops: ' + flowStops.length);
  check('every stop starts at a different moment',
    delays.length === 9 && new Set(delays).size === 9, delays.join(' '));
  check('and the stops are the thing that moves',
    flowStops.length === 9 && getComputedStyle(flowStops[0]).animationName === 'dsh-sh-drift',
    flowStops.length === 9 ? getComputedStyle(flowStops[0]).animationName : 'no stops');
  peakHost.remove();
  // Off-peak the ring is cool, and every fracture it lights goes with it.
  var offHost = crackHost('offpeak', '4');
  var offLit = getComputedStyle(offHost.querySelector('.dsh-sh__crack[data-lit="1"] .dsh-sh__crack-band')).stroke;
  check('off-peak a lit fracture follows the ring to the cool colour', offLit !== peakLit,
    'off-peak ' + offLit + ' vs peak ' + peakLit);
  offHost.remove();

  // --- can the badge actually be clicked? --------------------------------------
  //
  // Not "does the handler call the API" — that was fine and the badge still did
  // nothing for three rounds. The cluster sets 'pointer-events: none' at its root
  // so it never swallows clicks meant for the app, and every interactive part has
  // to opt back in. This asserts the *hit test*: with the real stylesheet, is the
  // badge the element under its own centre? A button nothing can press fails here
  // and nowhere else.
  var probe = document.createElement('div');
  probe.id = 'dsh-souls-hud';
  probe.style.cssText = 'position:fixed;left:40px;top:40px;z-index:2147483647';
  var probeMark = document.createElement('span');
  probeMark.className = 'dsh-sh__mark';
  probeMark.setAttribute('role', 'button');
  probeMark.innerHTML = renderer.previewSvg({ device: 'whale', shape: 'round', gauge: 0.5 });
  probe.appendChild(probeMark);
  document.body.appendChild(probe);
  var probeBox = probeMark.getBoundingClientRect();
  var under = document.elementFromPoint(
    Math.round(probeBox.left + probeBox.width / 2),
    Math.round(probeBox.top + probeBox.height / 2),
  );
  check('the badge is under its own pointer', Boolean(under) && probeMark.contains(under),
    'the element at the badge centre is ' + (under ? under.tagName + '.' + under.className : 'nothing'));
  check('and accepts pointer events', getComputedStyle(probeMark).pointerEvents === 'auto',
    'pointer-events is ' + getComputedStyle(probeMark).pointerEvents);
  // ...and a click there reaches a listener, which is what the app does.
  var heard = 0;
  probeMark.addEventListener('click', function () { heard += 1; });
  probeMark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  check('a click on it is delivered', heard === 1, 'listeners heard ' + heard + ' clicks');
  probe.remove();

  var frame = renderer.previewSvg({ device: 'whale', shape: 'round', gauge: 0.5 });
  var count = function (haystack, needle) { return haystack.split(needle).length - 1; };
  // The frame is markup, so the only honest test of it is a parse. Counting the
  // strings <g and </g> balanced happily while the heat rim's missing bracket
  // swallowed its own closing tag into the element — the browser then re-nested
  // the rest of the frame around it and the settings preview collapsed.
  // --- the way into the settings ----------------------------------------------
  //
  // The badge is the door. The app owns navigation, and its API for this is the
  // service below.
  // pluginNavigation.openBundle; the client half publishes it on a global because
  // the renderer is a plain script with no Cordis context. All three states are
  // asserted here, because "nothing happens" is exactly what a broken bridge looks
  // like and it is the one failure a person cannot debug from the outside.
  var opened = [];
  check('the renderer publishes the way in', typeof renderer.openPluginSettings === 'function');
  window.__DSH_SOULS_HUD_NAV__ = {
    open: function () {
      opened.push('bundle');
      return true;
    },
  };
  check('the badge uses the app API when it is there', renderer.openPluginSettings() === true, 'returned false');
  check('and asks for a bundle page', opened.join(',') === 'bundle', opened.join(',') || 'nothing was opened');
  // A service that is present but cannot do the job falls through to the DOM route,
  // which in this page has no Plugins entry to click, so it reports failure.
  window.__DSH_SOULS_HUD_NAV__ = { open: function () { return false; } };
  var warnings = [];
  var realWarn = console.warn;
  console.warn = function (message) { warnings.push(String(message)); };
  var fellThrough = renderer.openPluginSettings();
  console.warn = realWarn;
  delete window.__DSH_SOULS_HUD_NAV__;
  check('a dead service does not report success', fellThrough === false, 'claimed it opened something');
  check('and the failure is not silent', warnings.length > 0, 'no warning was logged');

  var parsed = new DOMParser().parseFromString(frame, 'image/svg+xml');
  check('the frame parses as SVG', !parsed.querySelector('parsererror'),
    String(parsed.querySelector('parsererror') && parsed.querySelector('parsererror').textContent).slice(0, 200));
  check('the frame keeps its medallion', parsed.querySelectorAll('.dsh-sh__device').length === 1,
    'devices: ' + parsed.querySelectorAll('.dsh-sh__device').length);
  check('the frame keeps its overlay', parsed.querySelectorAll('.dsh-sh__heat').length === 1,
    'overlays: ' + parsed.querySelectorAll('.dsh-sh__heat').length);
  check('the overlay keeps its rim', parsed.querySelectorAll('.dsh-sh__heat-rim circle, .dsh-sh__heat-rim polygon').length === 1);

  var groupBody = function (name) {
    // Match the class attribute and then its tag: the groups carry other
    // attributes (fill, linecap), so requiring the immediate '>' finds nothing.
    var at = frame.indexOf('class="' + name + '"');
    if (at === -1) return '';
    var open = frame.indexOf('>', at);
    var close = frame.indexOf('</g>', open);
    return close === -1 ? frame.slice(open) : frame.slice(open, close);
  };
  var widthsIn = function (markup) {
    return markup
      .split('stroke-width="')
      .slice(1)
      .map(function (chunk) { return Number(chunk.slice(0, chunk.indexOf('"'))); })
      .filter(function (w) { return w > 0; });
  };

  var opens = count(frame, '<g');
  var closes = count(frame, '</g>');
  check('the frame leaves no group open', opens === closes, opens + ' <g vs ' + closes + ' </g>');

  var heatAt = frame.indexOf('class="dsh-sh__heat"');
  var deviceAt = frame.indexOf('class="dsh-sh__device"');
  check('the heat overlay is drawn', heatAt !== -1, 'no .dsh-sh__heat in the frame');
  check('the figure is drawn', deviceAt !== -1, 'no .dsh-sh__device in the frame');
  // The overlay must be a *sibling* of the figure, not a parent: it is
  // opacity-gated by the tariff window, so a figure nested inside it would come
  // and go with the tariff.
  var betweenFrame = frame.slice(Math.min(heatAt, deviceAt), Math.max(heatAt, deviceAt));
  check(
    'the figure is not inside the heat overlay',
    count(betweenFrame, '<g') === count(betweenFrame, '</g>'),
    count(betweenFrame, '<g') + ' opened, ' + count(betweenFrame, '</g>') + ' closed between them',
  );
  // ...and the overlay paints last. A 'g' carrying 'opacity: 0' *before* a sibling
  // that fills from a gradient made that sibling vanish in Chrome, so the figure
  // appeared and disappeared with the tariff window. Order is not cosmetic here.
  check('the overlay paints over the figure', heatAt > deviceAt, 'heat at ' + heatAt + ', figure at ' + deviceAt);
  // ...and so do the fractures. They run through the whole casting, so a crack that
  // stopped at the device's outline would read as painted on the field instead.
  var cracksAt = frame.indexOf('class="dsh-sh__cracks"');
  check('the fractures paint over the figure', cracksAt > deviceAt, 'cracks at ' + cracksAt + ', figure at ' + deviceAt);
  check('the fractures stay clipped to the field', frame.slice(cracksAt - 200, cracksAt).indexOf('clip-path') !== -1,
    frame.slice(Math.max(0, cracksAt - 200), cracksAt));
  // The overlay is the plate's wash now. The fractures left it when they stopped
  // being a property of the tariff window — they are per-crack and coverage-driven,
  // checked below.
  var layers = ['dsh-sh__heat-wash', 'dsh-sh__heat-field', 'dsh-sh__heat-rim'];
  for (var layer = 0; layer < layers.length; layer += 1) {
    check('the overlay draws its ' + layers[layer], frame.indexOf(layers[layer]) !== -1);
  }

  // The artboard has to be *scaled* into the field. A device that is not fitted is
  // drawn at its own 512-unit size, overflows the 48-unit frame, and disappears.
  var deviceChunk = frame.slice(deviceAt, deviceAt + 300);
  check(
    'the device is fitted from its artboard into the field',
    deviceChunk.indexOf('scale(0.0625)') !== -1,
    deviceChunk.slice(0, 220),
  );
  check('the device draws its figure', count(frame.slice(deviceAt), '<path') > 0, deviceChunk.slice(0, 220));

  // --- the fractures ----------------------------------------------------------
  //
  // A crack is not a scratch: it opens where it starts and thins to nothing where
  // it runs out, so the paths carry several different stroke widths. And the heat
  // has to spill *past* the crack it follows, which is what makes it read as lava
  // coming out rather than as the crack being lit.
  // No regexes in this script: it is a template literal, so backslashes are
  // escapes *for the test file* and a character class silently loses them.
  // The widest fracture is deliberately a crack that has *opened*, so the cap is
  // 1.5 rather than "hairline".
  var crackWidths = widthsIn(groupBody('dsh-sh__cracks')).filter(function (w) { return w <= 1.5; });
  var distinct = {};
  crackWidths.forEach(function (w) { distinct[w] = true; });
  check('the fractures taper', Object.keys(distinct).length >= 3,
    'stroke widths found: ' + crackWidths.join(', '));
  check('the fractures are thin lines', Math.max.apply(null, crackWidths) <= 1.5,
    'widest crack: ' + Math.max.apply(null, crackWidths));
  check('a pool forms where the widest fractures open',
    frame.indexOf('dsh-sh__crack-spill') !== -1, 'no spill circle');

  // --- which fractures the arc has reached -------------------------------------
  //
  // The fractures are lit by *position*: one group per crack, data-at carrying the
  // angle it opens at, and data-lit on the ones the sweep covers. The sets below
  // are the geometry's own numbers — the six rim angles against the arc's start — so
  // they are golden values rather than a restatement of the rule they test.
  //
  // Crack order from the renderer, with the rim angle each opens at:
  //   0 lower left 246  1 its branch 244  2 bottom 214
  //   3 lower right 130  4 its branch 127  5 top 358
  function litCracks(markup) {
    var host = document.createElement('div');
    host.innerHTML = markup;
    var lit = [];
    var groups = host.querySelectorAll('.dsh-sh__crack[data-lit="1"]');
    for (var i = 0; i < groups.length; i += 1) lit.push(Number(groups[i].getAttribute('data-crack')));
    lit.sort(function (a, b) { return a - b; });
    return lit.join(',');
  }
  function frameAt(ratio, shape) {
    return renderer.previewSvg({ device: 'whale', shape: shape || 'round', material: 'bronze', gauge: ratio });
  }
  check('every fracture gets a group of its own',
    (frame.match(/class="dsh-sh__crack"/g) || []).length === 6,
    'groups: ' + (frame.match(/class="dsh-sh__crack"/g) || []).length);
  check('and carries the angle it opens at',
    (frame.match(/data-at="/g) || []).length === 6,
    'angles: ' + (frame.match(/data-at="/g) || []).length);
  // The frame above is the 0.4 one the rest of this file drives the gauge with.
  check('an arc that has not reached them lights none', litCracks(frameAt(0)) === '', litCracks(frameAt(0)));
  check('a quarter of the perimeter still reaches none', litCracks(frameAt(0.25)) === '', litCracks(frameAt(0.25)));
  check('60% reaches the bottom three', litCracks(frameAt(0.6)) === '2,3,4', litCracks(frameAt(0.6)));
  check('90% reaches five of the six', litCracks(frameAt(0.9)) === '0,1,2,3,4', litCracks(frameAt(0.9)));
  check('a closed ring reaches all six', litCracks(frameAt(1)) === '0,1,2,3,4,5', litCracks(frameAt(1)));
  // The octagon's gauge starts at its first vertex rather than at the top, so the same
  // reading lights a different set. That is the whole reason the start angle is read
  // off the silhouette instead of assumed.
  check('the octagon lights a different set at the same reading',
    litCracks(frameAt(0.6, 'octagon')) !== litCracks(frameAt(0.6, 'round')),
    'octagon ' + litCracks(frameAt(0.6, 'octagon')) + ' vs round ' + litCracks(frameAt(0.6, 'round')));

  // --- the preview board ----------------------------------------------------
  //
  // Four cells, one per theme x tariff window, so the form shows the combinations
  // the user can never see at once. Each cell has to force its own theme (the
  // dark cut is selected by an ancestor, and the page is often the other one),
  // bake that theme's metal stops, and carry the burn gauge.
  var board = renderer.previewCells({
    device: 'whale',
    shape: 'round',
    material: 'bronze',
    gauge: 0.5,
    size: 48,
  });
  check('the board has four cells', board.length === 4, 'got ' + board.length);
  check('the board covers both themes and both tariffs',
    board.map(function (c) { return (c.dark ? 'dark' : 'light') + '/' + c.tariff; }).join(' ') ===
      'dark/peak dark/offpeak light/peak light/offpeak',
    board.map(function (c) { return (c.dark ? 'dark' : 'light') + '/' + c.tariff; }).join(' '));
  var darkCell = board[0];
  var lightCell = board[2];
  check('a dark cell forces its own theme',
    darkCell.html.indexOf('data-ds-dark-theme') !== -1, darkCell.html.slice(0, 120));
  check('a light cell carries no dark attribute',
    lightCell.html.indexOf('data-ds-dark-theme') === -1, lightCell.html.slice(0, 120));
  check('a cell states the tariff it previews',
    board[0].html.indexOf('data-tariff="peak"') !== -1 && board[1].html.indexOf('data-tariff="offpeak"') !== -1);
  check('a cell keeps the metal and device attributes',
    darkCell.html.indexOf('data-material="bronze"') !== -1 && darkCell.html.indexOf('data-device="whale"') !== -1);
  // The baked stops are the proof that the *cell's* theme was read, not the page's.
  check('the dark cell bakes the dark cut',
    stopsOf(darkCell.html).join(',') === '#c9a869,#a07f42,#6f5526,#40300f', stopsOf(darkCell.html).join(','));
  check('the light cell bakes the light cut',
    stopsOf(lightCell.html).join(',') === '#d8b673,#9a7a3e,#5f4a20,#2b2009', stopsOf(lightCell.html).join(','));
  check('the two cuts are genuinely different',
    stopsOf(darkCell.html).join(',') !== stopsOf(lightCell.html).join(','));
  check('every cell draws the burn gauge at half',
    board.every(function (c) {
      return Math.abs(gaugeOffsetOf(c.html) - gaugeLengthOf(c.html) / 2) < 0.01;
    }),
    board.map(function (c) { return gaugeOffsetOf(c.html); }).join(' | '));
  check('an idle board hides the gauge entirely',
    gaugeOffsetOf(renderer.previewCells({ device: 'whale', material: 'bronze', gauge: 0 })[0].html) ===
      gaugeLengthOf(renderer.previewCells({ device: 'whale', material: 'bronze', gauge: 0 })[0].html));
  check('a custom device with no upload previews the built-in mark',
    renderer.previewCells({ device: 'custom', material: 'bronze', gauge: 0.4 })[0].html.indexOf('data-device="whale"') !== -1);

  var fallback = renderer.previewSvg({ device: 'custom', shape: 'round', material: 'silver', custom: null });
  check('a missing upload falls back to the built-in device',
    fallback.indexOf('data-device="whale"') !== -1);

  // --- shapes ---------------------------------------------------------------
  var round = renderer.previewSvg({ device: 'whale', shape: 'round', material: 'bronze' });
  var octagon = renderer.previewSvg({ device: 'whale', shape: 'octagon', material: 'bronze' });
  var defaultShape = renderer.previewSvg({ device: 'whale', material: 'bronze' });
  check('the round medal is a circle', round.indexOf('<circle cx="24" cy="24" r="22.6"') !== -1, round.slice(0, 300));
  // The milled edge is its own element (a dashed ring), not a dash array anywhere
  // in the markup — the gauge uses one of those now, so ask about the element.
  check('the round medal has a milled edge', round.indexOf('class="dsh-sh__mill"') !== -1, round.slice(0, 300));
  check('the octagon is still a polygon',
    octagon.indexOf('<polygon points="12,1.2') !== -1, octagon.slice(0, 300));
  check('the octagon has no milled edge', octagon.indexOf('class="dsh-sh__mill"') === -1, octagon.slice(0, 300));
  check('round is the shape used when none is given',
    defaultShape.indexOf('data-shape="round"') !== -1, defaultShape.slice(0, 120));
  check('the shape is named in the markup',
    round.indexOf('data-shape="round"') !== -1 && octagon.indexOf('data-shape="octagon"') !== -1);

  // --- the motif is the material -------------------------------------------
  //
  // This is the rule in one assertion: the stops of the device gradient have to
  // be the material's metal stops, not the upload's colours and not a second
  // palette that merely resembles them. hud.css defines them as metal stops, so
  // iron's motif must carry iron's ramp.
  // Plain string walking again: a regex literal here would lose its backslashes
  // to the surrounding template literal and end early on an escaped slash.
  function stopsOf(markup) {
    var at = markup.indexOf('-device"');
    if (at === -1) return [];
    var open = markup.indexOf('>', at);
    var close = markup.indexOf('</linearGradient>', open);
    if (open === -1 || close === -1) return [];
    var body = markup.slice(open, close);
    var stops = [];
    var cursor = 0;
    while (cursor < body.length) {
      var hash = body.indexOf('#', cursor);
      if (hash === -1) break;
      stops.push(body.slice(hash, hash + 7));
      cursor = hash + 7;
    }
    return stops;
  }
  var ironMark = renderer.previewSvg({ device: 'hammer', shape: 'round', material: 'iron' });
  var bronzeMark = renderer.previewSvg({ device: 'hammer', shape: 'round', material: 'bronze' });
  var ironStops = stopsOf(ironMark);
  var bronzeStops = stopsOf(bronzeMark);
  check('the device gradient has four stops', ironStops.length === 4, ironStops.join(','));
  // The expectation is read from the stylesheet the page is wearing, not written
  // down here: what is being asserted is the *link* between a material and its
  // motif, so recolouring a metal must not require editing the test. (It did,
  // once: iron's ramp was hard-coded, and a blue-cast tweak failed the suite for
  // the wrong reason.)
  function rampOf(material) {
    var probe = document.createElement('span');
    probe.className = 'dsh-sh__mark';
    probe.setAttribute('data-preview', '');
    probe.setAttribute('data-material', material);
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    document.body.appendChild(probe);
    var computed = getComputedStyle(probe);
    var ramp = [1, 2, 3, 4].map(function (step) {
      return computed.getPropertyValue('--dsh-sh-metal-' + step).trim();
    });
    probe.remove();
    return ramp;
  }
  check("iron's motif carries iron's metal",
    ironStops.join(',') === rampOf('iron').join(','), ironStops.join(',') + ' vs ' + rampOf('iron').join(','));
  check("bronze's motif carries bronze's metal",
    bronzeStops.join(',') === rampOf('bronze').join(','), bronzeStops.join(',') + ' vs ' + rampOf('bronze').join(','));
  check('two materials give two motifs',
    ironStops.join(',') !== bronzeStops.join(','), 'both materials produced the same gradient');
  check("an upload's own colour never reaches the badge",
    custom.indexOf('#e11d48') === -1, custom.slice(0, 300));

  } catch (error) {
    results.push('FAIL threw :: ' + (error && error.stack ? String(error.stack).slice(0, 600) : String(error)));
  }
  if (window.__HUD_ERRORS__ && window.__HUD_ERRORS__.length > 0) {
    results.push('FAIL script-error :: ' + window.__HUD_ERRORS__.join(' | '));
  }
  document.getElementById('result').textContent = results.join('\\n');

})();
<\/script>
</body></html>
`

const dir = mkdtempSync(join(tmpdir(), 'dsh-hud-upload-'))
const page = join(dir, 'upload.html')
writeFileSync(page, html)
if (process.env.DSH_HUD_KEEP) writeFileSync('/tmp/hud-probe/upload-page.html', html)

let dom = ''
try {
  dom = execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--user-data-dir=${join(dir, 'chrome')}`,
      '--virtual-time-budget=4000',
      '--dump-dom',
      pathToFileURL(page).href,
    ],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
  )
} catch (error) {
  // Chrome writes the DOM and then sometimes exits non-zero on teardown; the
  // dump is still on stdout, which is all this test reads.
  dom = String(error.stdout ?? '')
  if (!dom.includes('id="result"')) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`upload: headless Chrome produced no DOM\n${String(error.stderr ?? '').slice(0, 800)}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

/** The `<pre id="result">` text, with the entities the DOM dump escapes. */
function resultText(source) {
  const match = /<pre id="result">([\s\S]*?)<\/pre>/.exec(source)
  if (!match) throw new Error('upload: the page wrote no result')
  return match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

const lines = resultText(dom).split('\n').filter(Boolean)
const failed = lines.filter((line) => line.startsWith('FAIL'))
for (const line of lines) console.log(' ', line)
const errorText = (/<pre id="errors">([\s\S]*?)<\/pre>/.exec(dom) || ['', ''])[1].trim()
if (lines.length === 0 || lines[0].startsWith('pending')) {
  throw new Error(
    'upload: the page never finished its assertions' + (errorText ? `\npage errors:\n${errorText}` : ' (no script error reported)'),
  )
}
if (errorText) console.log('  page errors:', errorText)
if (failed.length > 0) {
  console.error(`souls-hud upload: ${failed.length} assertion(s) failed`)
  process.exit(1)
}
console.log(`souls-hud upload: all ${lines.length} assertions passed`)
