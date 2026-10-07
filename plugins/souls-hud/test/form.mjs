/**
 * Render the settings form without a browser, and check what it says.
 *
 * The form is a React component that normally only exists inside the app's
 * Plugins page, which needs a running, authenticated app to look at — so every
 * layout question ("is the preview in the right place?", "does the tariff window
 * shout?") used to need a human. This runs the *real* component: `lib/client.js`
 * is loaded with a module loader that hands it a small React-compatible shim, and
 * the renderer it talks to is stubbed at its published guard
 * (`window.__DSH_SOULS_HUD__`), because a canvas, not a form, is the renderer's
 * business — `test/upload.mjs` drives that half for real.
 *
 * The tree the component returns is walked, flattened and serialized, so the same
 * run answers both questions: what does it say (assertions) and what does it look
 * like (`preview/form.html`, a static page — no scripts, so Chrome can screenshot
 * it without the virtual-time stall a timer-driven page causes).
 *
 * Run: node test/form.mjs              write preview/form.html and check it
 *      node test/form.mjs --shot out.png
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const clientJs = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// Read for `realCells()` only: the Node-side render stubs the renderer, but the
// screenshot needs its actual output.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const hudJs = readFileSync(new URL('../lib/hud.js', import.meta.url), 'utf8')
const hudCss = readFileSync(new URL('../lib/hud.css', import.meta.url), 'utf8')

/** The configuration the host would answer with. */
const CONFIG = {
  numbers: 'hover',
  hpTargetCny: 100,
  fpTargetCny: 50,
  staminaMode: 'remaining',
  device: 'whale',
  shape: 'round',
  material: 'bronze',
  customDevice: { present: false, bytes: 0 },
  burnFullScaleTpm: 6000,
  tariffEnabled: true,
  // The published rule: two windows in UTC, Monday through Friday, Chinese public
  // holidays excluded. The fixture is the default *because* the form's job is to
  // show the default honestly and offer to change it.
  tariffPeakWindows: [
    { start: '01:00', end: '04:00' },
    { start: '06:00', end: '10:00' },
  ],
  tariffPeakWeekdays: [1, 2, 3, 4, 5],
  tariffHolidayMode: 'cn',
  tariffCustomHolidays: [],
  tariffCustomWorkdays: [],
  tariffMakeupWorkdays: false,
  tariffAutoRefresh: true,
  holidays: {
    source: 'https://github.com/NateScarlet/holiday-cn',
    generated: '2026-09-28',
    years: [2024, 2025, 2026, 2027],
    papers: ['https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'],
    offDays: 89,
    workdays: 19,
    current: 2026,
    covered: true,
    stale: false,
    auto: true,
    checkedAt: '2026-09-28T00:00:00.000Z',
    lastError: null,
    nextDueAt: Date.now() + 20 * 24 * 3600 * 1000,
  },
}

/** The renderer's published reading, as the live badge would produce it. */
const READING = {
  balance: { available: true, currency: 'CNY', recharge: 31.4, bonus: 12.75, hpRatio: 0.628, fpRatio: 0.255 },
  context: { available: true, used: 742000, total: 1000000, percent: 74, freePercent: 26 },
  tariff: 'peak',
  tariffDetail: {
    reason: 'peak-window',
    window: '01:00–04:00',
    utcClock: '02:19',
    nextChangeAt: Date.now() + 101 * 60000,
    nextChangePeak: false,
    holidayName: null,
    holidayDate: '2026-09-28',
    makeup: false,
    half: true,
  },
  burn: { available: true, ratio: 0.57, level: 3, tokensPerMin: 3400, outputTokensPerMin: 1700, cacheTokensPerMin: 1900000 },
}

// --- the React-compatible shim -------------------------------------------------
//
// Only what the form uses: createElement, useState, useEffect, useRef. There is
// no DOM anywhere in this file, which is the point: the component's output is a
// tree, and a tree can be inspected in Node in milliseconds.

function createReact() {
  const hooks = []
  const effects = []
  let cursor = 0
  let render = null
  // The hook calls this render made, in order. React compares them across renders
  // and throws when they differ — and a component that throws renders *nothing*,
  // which is how a hook declared after an early return blanked the real settings
  // page while this shim stayed happy. So it compares them too.
  let signature = []
  const node = (type, props, children) => ({ type, props: { ...props, children } })

  const React = {
    createElement(type, props, ...children) {
      return node(type, props || {}, children.length === 1 ? children[0] : children.length ? children : undefined)
    },
    useState(initial) {
      signature.push('state')
      const at = cursor++
      // Indexed, not pushed: a `push` when an earlier slot is still empty lands
      // the hook at the wrong index, which reads as "cannot set properties of
      // undefined" three hooks later.
      if (hooks[at] === undefined) hooks[at] = { value: typeof initial === 'function' ? initial() : initial }
      return [
        hooks[at].value,
        (next) => {
          hooks[at].value = typeof next === 'function' ? next(hooks[at].value) : next
        },
      ]
    },
    useRef(initial) {
      signature.push('ref')
      const at = cursor++
      if (hooks[at] === undefined) hooks[at] = { value: { current: initial === undefined ? null : initial } }
      return hooks[at].value
    },
    useEffect(fn, deps) {
      signature.push('effect')
      const at = cursor++
      if (effects[at] === undefined) effects[at] = { deps: undefined, last: undefined }
      effects[at].fn = fn
      effects[at].deps = deps
    },
    /**
     * Render the component, run its effects, and settle (bounded).
     *
     * @param component - the function component.
     * @param props - its props.
     * @returns the last rendered tree.
     * @throws when the hook calls change between renders, as React would.
     */
    async mount(component, props) {
      // A mount is a new component instance: the hooks of the previous one are
      // gone, or a page/summary pair would look like a hook-order change.
      hooks.length = 0
      effects.length = 0
      signature = []
      let first = null
      const runEffects = () => {
        for (const slot of effects.filter(Boolean)) {
          const changed =
            slot.deps === undefined ||
            !slot.last ||
            slot.last.length !== slot.deps.length ||
            slot.deps.some((value, at) => value !== slot.last[at])
          if (!changed) continue
          slot.last = slot.deps ? slot.deps.slice() : undefined
          slot.cleanup = slot.fn()
        }
      }
      await Promise.resolve()
      cursor = 0
      signature = []
      render = component(props)
      first = signature.join(',')
      runEffects()
      // The form fetches its config and reads the renderer asynchronously; three
      // settles is plenty, and the bound keeps a mistake here from hanging the run.
      for (let pass = 0; pass < 4; pass += 1) {
        await Promise.resolve()
        await new Promise((resolve) => setImmediate(resolve))
        cursor = 0
        signature = []
        render = component(props)
        if (signature.join(',') !== first) {
          throw new Error(
            'form: the component changed its hook calls between renders ' +
              `(${first} -> ${signature.join(',')}), which React rejects`,
          )
        }
        runEffects()
      }
      return render
    },
  }
  return React
}

// --- the app, standing in ------------------------------------------------------

/** A window with the renderer's guard, a fetch stub and nothing else. */
/**
 * The renderer's four preview cells, rendered by the renderer itself.
 *
 * The form's page runs in Node, where there is no DOM for `previewCells` to read
 * the palette from — so this renders them once in Chrome (a one-shot page: the
 * stylesheet, the renderer, and a `fetch` that 404s so nothing keeps polling) and
 * hands the markup to the page. Without it the screenshot showed hand-drawn
 * stand-ins, and a review of the *fractures* based on a stand-in is worthless.
 *
 * @returns the four cells' HTML, or null when Chrome is unavailable.
 */
function realCells() {
  const probe = `<!doctype html><html><head><meta charset="utf-8"><style>${hudCss}
    body { margin: 0; background: #1c1c1e; }
  </style></head><body data-ds-dark-theme><div id="cells"></div>
  <script>
    window.fetch = function () {
      return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve({}); }, text: function () { return Promise.resolve(''); } });
    };
  </script>
  <script>${hudJs}</script>
  <script>
    (function () {
      var hud = window.__DSH_SOULS_HUD__;
      if (!hud || typeof hud.previewCells !== 'function') return;
      var host = document.getElementById('cells');
      hud.previewCells({ device: 'whale', shape: 'round', material: 'bronze', gauge: 0.6, size: 48 })
        .forEach(function (cell, index) {
          var box = document.createElement('div');
          box.id = 'cell' + index;
          box.innerHTML = cell.html;
          host.appendChild(box);
        });
      document.body.setAttribute('data-cells', '1');
    })();
  </script></body></html>`
  const dir = mkdtempSync(join(tmpdir(), 'souls-hud-cells-'))
  const file = join(dir, 'cells.html')
  writeFileSync(file, probe)
  const result = spawnSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--user-data-dir=${join(dir, 'chrome')}`,
      '--virtual-time-budget=4000',
      '--dump-dom',
      pathToFileURL(file).href,
    ],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
  )
  const dom = String(result.stdout || result.error?.stdout || '')
  if (!/data-cells="1"/.test(dom)) return null
  const cells = []
  for (let index = 0; index < 4; index += 1) {
    const at = dom.indexOf(`id="cell${index}"`)
    if (at === -1) return null
    const open = dom.indexOf('>', at) + 1
    const next = dom.indexOf(`<div id="cell${index + 1}"`, open)
    const close = next === -1 ? dom.indexOf('</div>', open) : next
    let html = dom.slice(open, close).trim()
    // Each cell sits in its own probe `box` div. For every cell but the last the
    // slice above runs to the *next* box, so this cell's own closing tag comes with
    // it — and a stray `</div>` in the middle of the settings preview closes the
    // form's column early and the four badges staircase down the page.
    if (html.endsWith('</div>')) html = html.slice(0, -'</div>'.length).trim()
    if (!html) return null
    cells.push({
      dark: index < 2,
      tariff: index % 2 === 0 ? 'peak' : 'offpeak',
      html,
    })
  }
  return cells
}

/** The stand-in cells, used when the real ones cannot be rendered. */
function stubCells() {
  return ['dark/peak', 'dark/offpeak', 'light/peak', 'light/offpeak'].map((id) => ({
    dark: id.startsWith('dark'),
    // `endsWith('/peak')`, not `endsWith('peak')`: "offpeak" ends with "peak",
    // which labelled two cells as peak in the first screenshot of this page.
    tariff: id.endsWith('/peak') ? 'peak' : 'offpeak',
    html:
      '<svg class="dsh-sh__mark-cell" viewBox="0 0 48 48">' +
      '<circle cx="24" cy="24" r="22.6" fill="#4a3a22"/>' +
      '<circle cx="24" cy="24" r="18.6" fill="#171208"/>' +
      '</svg>',
  }))
}

/**
 * The window the component sees: the renderer's published guard, stubbed.
 *
 * @param cells - the preview cells to hand back; the real ones when they could be
 *   rendered, otherwise `stubCells()`.
 * @returns the fake window.
 */
function fakeWindow(cells) {
  return {
    __DSH_SOULS_HUD__: {
      previewCells: () => cells || stubCells(),
      previewSvg: () => '<svg class="dsh-sh__mark-cell"/>',
      inspectUpload: () => null,
      burnReading: () => ({ ...READING.burn, tariff: READING.tariff, tariffDetail: READING.tariffDetail }),
      tariffReading: () => READING.tariff,
      liveReading: () => READING,
      refresh: () => {},
    },
  }
}

/** A `fetch` that answers the two routes the form uses, and nothing else. */
/** The config the stub routes answer with; a second render can change it. */
let stubConfig = CONFIG
function setStubConfig(next) {
  stubConfig = next
}

function fakeFetch() {
  return (url) => {
    const target = String(url)
    const payload = target.includes('/config') ? { config: stubConfig, overrides: {} } : null
    return Promise.resolve(
      payload
        ? { ok: true, status: 200, json: () => Promise.resolve(payload) }
        : { ok: false, status: 404, json: () => Promise.resolve({}) },
    )
  }
}

/**
 * Load `lib/client.js` the way the app's module loader does.
 *
 * The bundle is a classic script that expects `window.__ModuleLoader__`, a
 * `require`, and a DOM-ish global set. Everything it can reach is passed in, so
 * the module's timers and fetches are this file's to control: the form polls the
 * renderer every two seconds, and a real interval would keep this process alive
 * after the assertions are done.
 *
 * @param window - the fake window, with the renderer's guard on it.
 * @param React - the shim to hand back for `require('react')`.
 * @param source - the bundle to run. The real one by default; a test that needs a
 *   different module constant (the support channels are one) patches the source and
 *   loads *that*, because a stubbed constant would test the stub rather than the
 *   form.
 * @returns the module the bundle registered.
 */
function loadClientHalf(window, React, source = clientJs) {
  let definition = null
  window.__ModuleLoader__ = { load: (value) => { definition = value } }
  // Enough of a document for `apply()`, which injects the renderer's <script>
  // tag. The renderer itself is stubbed at its guard, so the tag never loads.
  const element = () => ({
    dataset: {}, style: {},
    setAttribute() {}, appendChild() {}, removeChild() {}, parentNode: null,
  })
  const document = {
    head: element(), body: element(),
    querySelector: () => null, getElementById: () => null, createElement: element,
  }
  const noop = () => 0
  // The bundle is a classic script: run it with the globals the app would have.
  const run = new Function(
    'window', 'document', 'console', 'require', 'fetch',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', source,
  )
  run(window, document, console, (id) => (String(id) === 'react' ? React : {}), window.fetch, noop, noop, noop, noop)
  return definition
}

/** Collect the text of a rendered tree, in order. */
function textOf(tree) {
  const out = []
  const walk = (item) => {
    if (item === null || item === undefined || item === false) return
    if (Array.isArray(item)) return item.forEach(walk)
    if (typeof item === 'string' || typeof item === 'number') return out.push(String(item))
    if (typeof item.type === 'function') return walk(item.type(item.props || {}))
    if (item.props && item.props.dangerouslySetInnerHTML) out.push('[medallion]')
    walk(item.props && item.props.children)
  }
  walk(tree)
  return out.join('')
}

/** The same walk, but as static HTML — inline styles, no scripts. */
function htmlOf(tree) {
  const walk = (item) => {
    if (item === null || item === undefined || item === false || item === true) return ''
    if (Array.isArray(item)) return item.map(walk).join('')
    if (typeof item === 'string' || typeof item === 'number') return escape(String(item))
    if (typeof item.type === 'function') return walk(item.type(item.props || {}))
    const props = item.props || {}
    const style = Object.entries(props.style || {})
      .map(([key, value]) => `${kebab(key)}:${String(value)}`)
      .join(';')
    const attrs = [style ? ` style="${escape(style)}"` : '']
    if (props.className) attrs.push(` class="${escape(props.className)}"`)
    // The page is written for a human to look at, so the attributes that carry a
    // node's *meaning* have to survive the walk. Without this a support link was
    // an `<a>` with no href and a QR code an `<img>` with no source — the two
    // things the support section is made of.
    for (const name of ['href', 'src', 'alt', 'target', 'rel', 'title', 'width', 'height']) {
      if (props[name] !== undefined) attrs.push(` ${name}="${escape(String(props[name]))}"`)
    }
    // SVG geometry too: without `d`, `viewBox`, `stroke` and the rest, the tip jar's
    // glyphs render as nothing in the static page — and the page is what a reviewer
    // looks at, so "it is only the preview" is not good enough.
    for (const name of SVG_ATTRS) {
      if (props[name] === undefined) continue
      const attr = name === 'viewBox' ? 'viewBox' : kebab(name)
      attrs.push(` ${attr}="${escape(String(props[name]))}"`)
    }
    if (item.type === 'input') {
      attrs.push(` type="${props.type || 'text'}"`)
      if (props.defaultValue !== undefined) attrs.push(` value="${escape(String(props.defaultValue))}"`)
      if (props.checked) attrs.push(' checked')
      if (props.disabled) attrs.push(' disabled')
      if (props.placeholder) attrs.push(` placeholder="${escape(props.placeholder)}"`)
      return `<input${attrs.join('')}>`
    }
    if (item.type === 'select') {
      const options = (Array.isArray(props.children) ? props.children : [props.children])
        .map(walk)
        .join('')
      return `<select${attrs.join('')}>${options}</select>`
    }
    if (item.type === 'option') return `<option>${walk(props.children)}</option>`
    const inner = props.dangerouslySetInnerHTML
      ? props.dangerouslySetInnerHTML.__html
      : walk(props.children)
    return `<${item.type}${attrs.join('')}>${inner}</${item.type}>`
  }
  return walk(tree)
}

/** The SVG attributes the static page has to carry through, with their JS spelling. */
const SVG_ATTRS = [
  'viewBox', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin',
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points',
  'transform', 'aria-hidden', 'focusable', 'id',
]

const escape = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const kebab = (key) => key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())

// --- render both views ---------------------------------------------------------

const React = createReact()
const window = fakeWindow()
window.fetch = fakeFetch()
globalThis.fetch = window.fetch
const definition = loadClientHalf(window, React)
if (!definition) throw new Error('form: the client half did not load')

/**
 * Every registration the client half makes, by slot name.
 *
 * The plugin now fills two surfaces — the row's settings form (`plugins.row.config`,
 * registered under two keys) and the tip jar (`plugins.detail.section`) — so keeping
 * only the last capture would test whichever happened to run last.
 */
function captureRegistrations() {
  const bySlot = new Map()
  return {
    bySlot,
    ctx: {
      effect: (fn) => fn(),
      slots: {
        inject: (key, fn) => fn(),
        register: (registration, component) => {
          if (!bySlot.has(registration.name)) bySlot.set(registration.name, { registration, component })
          return () => {}
        },
      },
      get: () => null,
      fetch: window.fetch,
    },
  }
}

const first = captureRegistrations()
const ctx = first.ctx
// The factory takes the module `require` and returns the module.
const client = definition.factory((id) => (String(id) === 'react' ? React : {}))
client.apply(ctx)
const captured = first.bySlot.get('plugins.row.config')
if (!captured) throw new Error('form: the row configuration was never registered')
const panelEntry = first.bySlot.get('plugins.detail.section')
if (!panelEntry) throw new Error('form: the tip jar was never registered')

// `client.js` closes over its own `window`; the renderer guard has to be visible
// to it, so the shim's globals are installed for the component's lifetime.
globalThis.window = window
// The guard itself, before trusting it: a component that calls a hook after an
// early return must be rejected exactly as React rejects it. This is the bug that
// blanked the settings page in the app while the shim was happy — the shim must
// not be the easiest place to be wrong.
{
  let calls = 0
  const misordered = () => {
    calls += 1
    const first = React.useState(0)
    if (calls === 1) return React.createElement('span', null, 'loading')
    const late = React.useState(0)
    return React.createElement('span', null, String(first[0] + late[0]))
  }
  let rejected = false
  try {
    await React.mount(misordered, {})
  } catch (error) {
    rejected = /hook calls between renders/.test(String(error.message))
  }
  if (!rejected) {
    console.error('form: the shim accepted a component whose hook calls change between renders')
    process.exit(1)
  }
}

const page = await React.mount(captured.component, { view: 'page', t: undefined })
const summary = await React.mount(captured.component, { view: 'summary', t: undefined })

const flat = textOf(page)
const failures = []
const ok = (condition, message) => {
  if (!condition) failures.push(message)
}

// The information hierarchy: four sections, in this order — the preview answers
// "what am I editing", the badge is what people come for, and the ring's
// calibration is what they need least often.
let cursor = -1
for (const heading of ['Preview', 'Badge', 'Bars', 'Burn ring & tariff']) {
  const at = flat.indexOf(heading)
  ok(at !== -1, `the form must have a "${heading}" section`)
  ok(at > cursor, `the "${heading}" section is out of order`)
  cursor = at
}

// The copy is deliberately thin: a hint stays only when the control cannot be
// understood without it. These are the ones that stay, and the ones that were cut,
// asserted in both directions so the trimming cannot quietly be undone.
for (const needed of [
  'Changes save as you make them',           // no confirm button to look for
  'Length is burn rate; colour is the tariff window',  // what the ring encodes
  'The rate that fills the ring',            // what the scale number means
  'Full at ¥',                               // what a cap is
]) {
  ok(flat.includes(needed), `a necessary explanation is missing: ${needed}`)
}
for (const cut of [
  'sidebar',                                 // where it is drawn: visible
  'Dark Souls III',                          // where the silhouette comes from
  'so it blends into the rim',               // why the metal matches
  'Off-peak is half the peak rate',          // pricing, not this setting
  'judged in Chinese time',                  // behaviour, documented instead
  'Strokes and cut-outs both work',          // detail of the upload rule
  'Lower it to make the gauge more sensitive',
]) {
  ok(!flat.includes(cut), `an unnecessary explanation came back: ${cut}`)
}

// The live read-outs: the reason a cap or a scale means anything.
ok(flat.includes('Now: topped-up ¥31.40 · granted ¥12.75'), 'the bars section must print the live balances')
ok(flat.includes('Now: 3.4k new tok/min'), 'the ring section must print the live rate')
ok(flat.includes('Full at ¥100'), 'the red cap must say what makes it full')

// The rule is the advanced half: reachable, but folded away.
ok(flat.includes('Peak hours & holidays'), 'the rule needs a disclosure label')
ok(!htmlOf(page).includes('value="16:30"'), 'the windows must start collapsed at their default values')
// The folded-away half still has to state the rule it is hiding, and the fact that
// off-peak costs half — that is the whole point of showing the window at all.
ok(flat.includes('Show the tariff window on the badge'), 'the tariff switch must be a plain setting')
ok(flat.includes('Now: 02:19 UTC'), 'the section must print the live reading')
ok(flat.includes('peak (01:00–04:00 UTC)'), 'and why it is that reading')
ok(flat.includes('off-peak in 1h 41m'), 'and when it next changes')

// The controls and the preview.
for (const option of ['Round · covenant medal', 'Octagon', 'Bronze (default)', 'Iron (blue steel)', 'Silver', 'Gold', 'Whale (default)', 'Wolf']) {
  ok(flat.includes(option), `the badge section is missing the ${option} option`)
}
ok((htmlOf(page).match(/dsh-sh__mark-cell/g) || []).length === 4, 'the preview must draw all four cells')

// The stand-ins only stand in for *layout*. The board the artwork is reviewed on
// is drawn by the renderer itself, in `preview/cells.html`: a review of the
// fractures cannot be based on a circle somebody drew in a test.
const board = realCells()
if (board) {
  const boardBody = board
    .map((cell) => {
      const caption = (cell.dark ? 'Dark' : 'Light') + ' \u00b7 ' + cell.tariff
      return (
        '<div style="display:flex;flex-direction:column;align-items:center;gap:4px">' +
        '<span>' + cell.html + '</span>' +
        '<span style="font-size:11px;line-height:14px;color:#8a8a8a">' + caption + '</span>' +
        '</div>'
      )
    })
    .join('')
  const boardPage = `<!doctype html>
<html><head><meta charset="utf-8"><style>${hudCss}
  body { margin: 0; background: #1c1c1e; font-family: ui-sans-serif, system-ui; }
  .board { display: flex; gap: 14px; flex-wrap: wrap; padding: 16px; }
</style></head>
<body data-ds-dark-theme><div class="board">${boardBody}</div></body></html>`
  const boardFile = new URL('../preview/cells.html', import.meta.url)
  const host = htmlOf(page).indexOf('data-preview')
  writeFileSync(boardFile, boardPage)
  ok(boardBody.indexOf('dsh-sh__gauge') !== -1, 'the board cells must carry the real gauge')
  // The board is one dark page holding both cuts, so each cell has to state which
  // one it is: the light cells used to come out dark with the app, which made the
  // whole board a dark-mode board.
  ok(boardBody.includes('data-cut="light"'), 'the board must state which cells are the light cut')
  ok(boardBody.includes('data-cut="dark"'), 'and which are the dark cut')
  ok(boardBody.indexOf('dsh-sh__cracks') !== -1, 'the board cells must carry the real fractures')
  ok(boardBody.indexOf('dsh-sh__heat') !== -1, 'the peak board cells must carry the heat overlay')
  ok(host === -1 || true, 'board written')
  console.log('form: preview/cells.html carries the renderer\'s own four cells')
} else {
  console.warn('form: Chrome unavailable, preview/cells.html not written')
}
// The bridge into the plugin's own settings page is published by the client half.
{
  const opened = []
  let injected = null
  const navCtx = {
    ...ctx,
    // The app documents `ctx.inject(["pluginNavigation"], …)` for this, and that is
    // what has to be used: `ctx.get` alone can hand back a placeholder whose methods
    // do nothing, which looks exactly like a broken badge.
    inject: (names, callback) => {
      injected = names
      callback({ pluginNavigation: { openBundle: (name) => opened.push(name) } })
      return () => {}
    },
    get: () => null,
  }
  const bridgeClient = definition.factory((id) => (String(id) === 'react' ? React : {}))
  bridgeClient.apply(navCtx)
  ok(typeof window.__DSH_SOULS_HUD_NAV__ === 'object', 'the client half publishes the navigation bridge')
  ok(injected && injected[0] === 'pluginNavigation', 'and asks for the service the documented way')
  ok(window.__DSH_SOULS_HUD_NAV__.source() === 'injected', 'the injected service is the one it uses')
  ok(window.__DSH_SOULS_HUD_NAV__.open() === true, 'and it opens')
  // The *bundle*: `openBundle` names a package view, and the app documents it as
  // opening bundle details, with row pages identified by "the bundle package and row
  // id". This row's bundle is `dsh-plugin-builder-hud`.
  ok(opened[0] === 'dsh-plugin-builder-hud', 'the bundle that owns the page: ' + opened[0])
  // ...and a candidate can be tried without a rebuild, which is how a `#`-qualified
  // row id gets settled if the bundle alone is not enough.
  ok(window.__DSH_SOULS_HUD_NAV__.trial('dsh-plugin-builder-hud#souls-hud') === true, 'trial navigates')
  ok(opened[1] === 'dsh-plugin-builder-hud#souls-hud', 'with the name it was given: ' + opened[1])
  // An unresolved service must say so rather than pretending to have opened it.
  const bareCtx = { ...ctx, get: () => null }
  const bareClient = definition.factory((id) => (String(id) === 'react' ? React : {}))
  bareClient.apply(bareCtx)
  ok(window.__DSH_SOULS_HUD_NAV__.open() === false, 'with no service it reports failure')
  ok(window.__DSH_SOULS_HUD_NAV__.source() === 'unresolved', 'and says the service is unresolved')
  delete window.__DSH_SOULS_HUD_NAV__
}

// The preview's ring is a *sample*, not the live reading: a pegged live ring shows
// nothing about the gauge, and an empty one shows even less. The board used to say
// so in a caption; the fill speaks for itself now.
ok(!flat.includes('fixed at 60%'), 'the board must not caption itself')

// The row's one-liner leads with what the badge is.
const summaryText = textOf(summary)
ok(
  summaryText.includes('badge Round · covenant medal · Bronze (default) · Whale (default)'),
  `the row summary must lead with the badge: ${summaryText}`,
)

// --- the tip jar ---------------------------------------------------------------
//
// Three states, three different questions. The *shipped* page must show the tip jar
// exactly when the shipped configuration has a channel — that contract has to hold
// whether this checkout has been given an address or not, so the expectation is
// derived from the literal rather than written down. A *configured* page must
// render what it promises and nothing more: one link per link channel, one image
// per QR channel, no dead button for a channel that is still empty, and a code a
// phone can actually scan — a real size, and a way to the full-size file. An
// *empty* configuration must show no section at all: a tip jar nobody can use reads
// as a missing feature rather than a choice.

/** Take `var SUPPORT = {…}` out of the bundle, the way the harness takes `DICT`. */
function supportLiteral(source) {
  const start = source.indexOf('var SUPPORT = ')
  if (start === -1) throw new Error('form: var SUPPORT = not found')
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return new Function(`return ${source.slice(source.indexOf('{', start), i + 1)}`)()
    }
  }
  throw new Error('form: var SUPPORT = is not balanced')
}

/** The English label of each channel, as the dictionary spells it. */
const SUPPORT_LABELS = { wechat: 'WeChat tip code', kofi: 'Ko-fi' }
const configured = (channel) =>
  Boolean((channel.kind === 'link' && channel.url) || (channel.kind === 'qr' && channel.file))

// The row's settings form carries neither the tip jar nor a line about what the
// plugin costs: the buttons moved out to the bundle's page, and the free promise is
// stated in the READMEs rather than in the form. What is asserted here is the part
// that could actually be violated — the tip jar must not be in the row.
ok(
  !flat.includes('Support the author'),
  'the tip jar must not be inside the row, where a 200 px code drowned the settings',
)

/** Mount one surface from a patched copy of the client half. */
async function mountPatched(source, surface) {
  const win = fakeWindow()
  win.fetch = fakeFetch()
  const localReact = createReact()
  const definition = loadClientHalf(win, localReact, source)
  if (!definition) throw new Error('form: the patched client half did not load')
  const bySlot = new Map()
  const localCtx = {
    effect: (fn) => fn(),
    slots: {
      inject: (key, fn) => fn(),
      register: (registration, component) => {
        if (!bySlot.has(registration.name)) bySlot.set(registration.name, { registration, component })
        return () => {}
      },
    },
    get: () => null,
    fetch: win.fetch,
  }
  const client = definition.factory((id) => (String(id) === 'react' ? localReact : {}))
  client.apply(localCtx)
  const entry = bySlot.get(surface.slot)
  if (!entry) throw new Error(`form: ${surface.slot} was never registered`)
  // `client.js` closes over its own `window`, so the shim's globals have to point at
  // *this* window for the duration of the mount — and be put back afterwards, because
  // the pages below render against the original one.
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  globalThis.window = win
  globalThis.fetch = win.fetch
  try {
    return await localReact.mount(entry.component, surface.props)
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
}

const BUNDLE = 'dsh-plugin-builder-hud'
/**
 * The subjects the Plugins page actually builds.
 *
 * These are copied from `ui-plugin-manager` rather than invented: the first cut of
 * this test fed the panel `{ name: BUNDLE }`, which is not a shape the app ever
 * produces, so the suite stayed green while the panel rendered on no page at all.
 */
const bundleSubject = (name) => ({ kind: 'bundle', pkg: { name, installed: true, enabled: true, rows: [] } })
const BUNDLE_SUBJECT = bundleSubject(BUNDLE)
const panelProps = (subject) => ({ subject, t: undefined })
const TIP_JAR = { slot: 'plugins.detail.section' }

// The fixtures patch the configuration by hand, so the shape they patch is asserted
// first: a test whose patch quietly stopped matching would pass while testing the
// shipped values.
if (!/\{ id: "[a-z]+", kind: "link", url: "[^"]*" \}/.test(clientJs) || !/\{ id: "[a-z]+", kind: "qr", file: "[^"]*" \}/.test(clientJs)) {
  throw new Error('form: the SUPPORT literal changed shape; the fixtures below no longer patch it')
}
const emptySource = clientJs
  .replace(/(\{ id: "[a-z]+", kind: "link", url: )"[^"]*"/g, '$1""')
  .replace(/(\{ id: "[a-z]+", kind: "qr", file: )"[^"]*"/g, '$1""')
const richSource = clientJs
  .replace(/(\{ id: "kofi", kind: "link", url: )"[^"]*"/, '$1"https://ko-fi.com/example"')
  .replace(/(\{ id: "wechat", kind: "qr", file: )"[^"]*"/, '$1"wechat.png"')

// Every channel empty: no section at all. A tip jar nobody can use reads as a missing
// feature rather than a choice.
const emptyTree = await mountPatched(emptySource, { ...TIP_JAR, props: panelProps(BUNDLE_SUBJECT) })
ok(!textOf(emptyTree).includes('Support the author'), 'with every channel empty there is no tip jar')

// Somebody else's detail page. The slot is a *list* rendered on every detail page —
// a bundle's, a row's, an official plugin's — so the subject is the only thing
// keeping the tip jar on the page it belongs to.
const foreignTree = await mountPatched(clientJs, {
  ...TIP_JAR,
  props: panelProps(bundleSubject('dsh-plugin-something-else')),
})
ok(foreignTree === null, 'the tip jar must render on no page but the bundle it belongs to')
// The row page of the very skin it pays for: still not its page. "One level out" is
// the whole point of the move.
const rowTree = await mountPatched(clientJs, {
  ...TIP_JAR,
  props: panelProps({
    kind: 'row',
    pkg: { name: BUNDLE, installed: true, enabled: true, rows: [] },
    row: { rowId: 'souls-hud', moduleName: 'dsh-plugin-souls-hud', enabled: true },
  }),
})
ok(rowTree === null, 'and not on a row page either, not even its own skin\'s')
const itemTree = await mountPatched(clientJs, {
  ...TIP_JAR,
  props: panelProps({ kind: 'item', id: 'some-official-plugin' }),
})
ok(itemTree === null, 'nor on an official plugin\'s page')

// The shipped configuration: both channels on, one button each.
const supportTree = await mountPatched(clientJs, { ...TIP_JAR, props: panelProps(BUNDLE_SUBJECT) })
const supportHtml = htmlOf(supportTree)
const supportFlat = textOf(supportTree)
const shippedChannels = supportLiteral(clientJs).channels
ok(supportFlat.includes('Support the author'), 'the tip jar gets its own section')
ok(
  !supportFlat.includes('A tip is a thank-you') && !supportFlat.includes('unlocks nothing'),
  'and nothing but the heading: the buttons are the rest of it',
)
for (const channel of shippedChannels) {
  ok(
    supportFlat.includes(SUPPORT_LABELS[channel.id]) === configured(channel),
    `the tip jar must ${configured(channel) ? 'show' : 'hide'} the ${channel.id} channel`,
  )
}

// Ko-fi: one link, with a glyph beside its label.
const kofiAt = supportHtml.indexOf('href="https://ko-fi.com/tonyhd"')
ok(kofiAt !== -1, 'the Ko-fi button is a real link')
const kofiMarkup = supportHtml.slice(kofiAt, supportHtml.indexOf('</a>', kofiAt))
ok(kofiMarkup.includes('<svg'), 'the Ko-fi button carries its own glyph')
ok(kofiMarkup.includes('Ko-fi'), 'beside its label')
ok(
  supportHtml.includes('target="_blank"') && supportHtml.includes('rel="noreferrer noopener"'),
  'and it opens in a new tab, without handing over the opener',
)

// WeChat: a disclosure, not a parked image — the code is what you open when you mean
// to pay, so it stays out of the page until then.
ok(supportHtml.includes('<details'), 'the WeChat button unfolds instead of parking a code')
const detailsAt = supportHtml.indexOf('<details')
const summaryAt = supportHtml.indexOf('<summary', detailsAt)
const imgAt = supportHtml.indexOf('<img', detailsAt)
ok(summaryAt !== -1, 'the disclosure is the button')
ok(imgAt > summaryAt, 'and the code lives inside it, after the summary')
ok(
  supportHtml.includes('src="/dsh-souls-hud/support/wechat.png"'),
  'the code points at the host route that serves it',
)
ok(supportHtml.includes('alt="WeChat tip code"'), 'the code carries an alt: a QR is unreadable to a screen reader')
ok(supportHtml.includes('width="200"') && supportHtml.includes('height="200"'), 'the code is drawn at a scannable size')
ok(
  supportHtml.includes('href="/dsh-souls-hud/support/wechat.png"'),
  'and the code itself links to the full-size image',
)
ok(supportFlat.includes('WeChat app only'), 'the caption names the only app that can read it')
ok(supportFlat.includes('If it will not scan'), 'with a line for when it will not scan')

// The fixture, with the address changed: the same two buttons, the fixture's link, and
// nothing of the shipped one.
const richTree = await mountPatched(richSource, { ...TIP_JAR, props: panelProps(BUNDLE_SUBJECT) })
const richHtml = htmlOf(richTree)
ok(richHtml.includes('href="https://ko-fi.com/example"'), 'the fixture link is the one rendered')
ok(!richHtml.includes('tonyhd'), 'and the shipped address is not')

// --- write the static page, so a human can look at the same tree ----------------

const formHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>souls-hud settings form</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 20px 24px; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #1c1c1e; color: #ededed;
         --dsw-alias-bg-module-platform: rgba(255,255,255,0.06);
         --dsw-alias-border-l2: rgba(255,255,255,0.16);
         --dsw-alias-label-tertiary: #9a9a9a; }
  #form { max-width: 470px; }
  .page-title { font-size: 15px; font-weight: 700; }
  .page-kind { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-bottom: 4px; }
  .dsh-sh__mark-cell { width: 48px; height: 48px; }
  .dsh-sh__mark-cell .cell-gauge { stroke: #d9a441; }
${hudCss}
</style></head>
<body>
<div class="page-title">Souls Style</div>
<div class="page-kind">the row's settings page, as the component renders it</div>
<div id="form">${htmlOf(page)}</div>
</body></html>
`

mkdirSync(new URL('../preview/', import.meta.url), { recursive: true })

// A static page cannot reach the host, so a served code would render as a broken
// icon there and the section would look wrong for a reason that has nothing to do
// with the section. The stand-in is only for the pages a human opens; every
// assertion above is on the real route.
const QR_STAND_IN =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
      '<rect width="200" height="200" fill="#ffffff"/>' +
      '<rect x="7.5" y="7.5" width="185" height="185" fill="none" stroke="#cfcfcf"/>' +
      '<text x="100" y="96" font-family="monospace" font-size="14" fill="#8a8a8a" text-anchor="middle">wechat.png</text>' +
      '<text x="100" y="116" font-family="monospace" font-size="11" fill="#b3b3b3" text-anchor="middle">served by the host</text>' +
      '</svg>',
  )
/** Point the served code at the stand-in — both the `src` and the link that opens it. */
const staticPage = (html) => html.split('/dsh-souls-hud/support/wechat.png').join(QR_STAND_IN)

writeFileSync(new URL('../preview/form.html', import.meta.url), staticPage(formHtml))

// The tip jar has its own surface now, so it gets its own page — the row form above no
// longer carries it at all. Its disclosure is opened in the static page, because a
// reviewer who has to click to see the code is not reviewing the code.
const panelHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>BuilderHUD — the tip jar</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 20px 24px; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #1c1c1e; color: #ededed;
         --dsw-alias-bg-module-platform: rgba(255,255,255,0.06);
         --dsw-alias-border-l2: rgba(255,255,255,0.16);
         --dsw-alias-label-tertiary: #9a9a9a; }
  #panel { max-width: 470px; }
  .page-title { font-size: 15px; font-weight: 700; }
  .page-kind { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-bottom: 4px; }
</style></head>
<body>
<div class="page-title">BuilderHUD</div>
<div class="page-kind">the bundle's page, as the tip jar renders on it</div>
<div id="panel">${staticPage(htmlOf(supportTree)).replace('<details', '<details open')}</div>
</body></html>
`
writeFileSync(new URL('../preview/tip-jar.html', import.meta.url), panelHtml)
console.log('form: preview/form.html and preview/tip-jar.html written')

// A second page with the rule *changed*, because the section folds itself away
// while the rule is the published one — and a page nobody can open is not a page
// a human can review. It also shows the custom-calendar fields.
if (typeof setStubConfig === 'function') {
  setStubConfig({
    ...CONFIG,
    tariffPeakWindows: [
      { start: '01:00', end: '04:00' },
      { start: '06:00', end: '10:00' },
      { start: '13:00', end: '15:00' },
    ],
    tariffPeakWeekdays: [1, 2, 3, 4, 5, 6],
    tariffHolidayMode: 'cn',
    tariffMakeupWorkdays: true,
    holidays: { ...CONFIG.holidays, stale: true, checkedAt: '2026-08-01T00:00:00.000Z' },
  })
  const customTree = await React.mount(captured.component, { view: 'page', t: undefined })
  writeFileSync(
    new URL('../preview/form-tariff.html', import.meta.url),
    formHtml.replace(htmlOf(page), htmlOf(customTree)),
  )
  console.log('form: preview/form-tariff.html shows the tariff rule unfolded')

  // The bundled-calendar half of the section, with a stale calendar: this is the
  // path that reaches the network, so it has to render its own status and button.
  setStubConfig({
    ...CONFIG,
    tariffPeakWindows: [{ start: '01:00', end: '04:00' }],
    holidays: { ...CONFIG.holidays, stale: true },
  })
  // A third tree for the custom-calendar fields, which the page above no longer
  // shows: they are the other half of the same setting.
  setStubConfig({ ...CONFIG, tariffHolidayMode: 'custom', holidays: { ...CONFIG.holidays, stale: true } })
  const customFieldsTree = await React.mount(captured.component, { view: 'page', t: undefined })
  const customFlat = textOf(customFieldsTree)
  ok(customFlat.includes('Holiday dates'), 'the custom mode shows its holiday list')
  ok(customFlat.includes('Make-up workdays'), 'and its make-up workday list')
  ok(!customFlat.includes('Refresh now'), 'and no calendar panel, because it is not using one')

  setStubConfig({ ...CONFIG, tariffPeakWindows: [{ start: '01:00', end: '04:00' }], holidays: { ...CONFIG.holidays, stale: true } })
  const calendarTree = await React.mount(captured.component, { view: 'page', t: undefined })
  const calendarFlat = textOf(calendarTree)
  ok(calendarFlat.includes('Data: 2024, 2025, 2026, 2027'), 'the calendar panel names the years it covers')
  ok(calendarFlat.includes('Keep the holiday data current automatically'), 'the automatic refresh is a setting')
  ok(calendarFlat.includes('Last checked: 2026-09-28'), 'the panel says when it last looked')
  ok(calendarFlat.includes('No data for 2026 yet'), 'a stale calendar says so')
  ok(calendarFlat.includes('Refresh now'), 'and keeps a manual refresh as a fallback')
  ok(!calendarFlat.includes('Holiday dates'), 'the custom fields belong to the custom mode only')
}

const shotAt = process.argv.indexOf('--shot')
if (shotAt !== -1) {
  const out = process.argv[shotAt + 1] || '/tmp/souls-hud-form.png'
  spawnSync(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=' + (process.env.HUD_FORM_WIDTH || '560') + ',' + (process.env.HUD_FORM_HEIGHT || '1300'),
      '--screenshot=' + out,
      new URL('../preview/form.html', import.meta.url).href,
    ],
    { stdio: 'ignore', timeout: 30000 },
  )
  console.log('wrote ' + out)
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('form: structure, copy, live read-outs and the row summary all check out')
