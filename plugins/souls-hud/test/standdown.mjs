/**
 * Stand-down regression test.
 *
 * The plugin's switch has two halves that cannot be tested from the host side:
 * when the host half goes away (its routes start answering 404, which is what
 * switching the plugin off does), the renderer must stop drawing and **hand the
 * app's brand row back**; and when the host half returns, it must come back by
 * itself, because this app has no page reload.
 *
 * The renderer only needs a DOM, a `fetch` and timers, so this runs it in
 * headless Chrome against a stubbed app shell and a `fetch` whose answers the
 * test controls. Chrome's virtual clock runs the whole scenario instantly.
 *
 * STATUS: the scenario drives a deterministic virtual clock, but the Chrome
 * build on this machine ignores --virtual-time-budget for --screenshot (it
 * captures before any timer runs) and hangs on --dump-dom, so the run only
 * writes the report as a picture rather than asserting on it. It needs either
 * a Chrome that honours virtual time, a CDP-driven runner, or a DOM shim such
 * as jsdom to become a real assertion. Kept because the scenario itself is
 * correct and re-usable.
 *
 * Usage: node test/standdown.mjs      (needs Google Chrome installed)
 */

import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const here = (name) => fileURLToPath(new URL(name, import.meta.url))

const renderer = readFileSync(here('../lib/hud.js'), 'utf8')
const stylesheet = readFileSync(here('../lib/hud.css'), 'utf8')

const STATE = {
  config: {
    pollMs: 1000,
    barWidth: 96,
    scale: 1,
    anchor: 'sidebar',
    gapX: 10,
    gapY: 10,
    offsetX: 20,
    offsetY: 40,
    showText: true,
    idleDimMs: 0,
    criticalPercent: 25,
  },
  balance: {
    available: true,
    currency: 'CNY',
    recharge: 23.5,
    bonus: 0,
    hpRatio: 0.47,
    fpRatio: 0,
  },
  context: {
    available: true,
    used: 270000,
    total: 1000000,
    percent: 27,
    ratio: 0.27,
    freePercent: 73,
    freeRatio: 0.73,
  },
}

const page = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: #101216; color: #e8e8e8;
    font: 16px/1.7 ui-monospace, Menlo, monospace; }
  /* Pin the report above everything: the HUD's own z-index is near the top of
     the 32-bit range, and its size depends on the stub's layout. */
  #results { position: fixed; inset: 0 0 auto 0; z-index: 2147483647;
    padding: 14px 18px; margin: 0; white-space: pre; font-size: 17px;
    background: #101216; }
  .X_sidebarCol { position: absolute; left: 0; top: 0; width: 280px; height: 600px; }
  .X_brandRow { display: flex; align-items: center; gap: 8px; height: 44px; }
</style>
<div class="X_sidebarCol">
  <div class="X_brandRow">
    <svg data-slot="sidebar.brand.mark" width="20" height="20" viewBox="0 0 50 50">
      <path d="M0 0h50v50H0z" />
    </svg>
    <span data-slot="sidebar.brand.name">deepseek HARNESS</span>
  </div>
  <button type="button">New Session</button>
</div>
<pre id="results"></pre>
<script>
  var MODE = "on";
  var beacons = [];

  // The one control the test has: flip the "plugin" off and on.
  window.__setMode = function (next) { MODE = next; };

  window.fetch = function (url, options) {
    var target = String(url);
    function reply(status, body) {
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status: status,
        text: function () { return Promise.resolve(body); },
        json: function () { return Promise.resolve(JSON.parse(body)); },
      });
    }
    if (target.indexOf("/hud.css") !== -1) return reply(200, ${JSON.stringify(stylesheet)});
    if (target.indexOf("/beacon") !== -1) {
      try { beacons.push(JSON.parse(options.body)); } catch (error) { /* ignore */ }
      return reply(200, "{}");
    }
    if (target.indexOf("/health") !== -1) {
      return MODE === "on" ? reply(200, '{"ok":true}') : reply(404, "");
    }
    if (target.indexOf("/state.json") !== -1) {
      return MODE === "on" ? reply(200, ${JSON.stringify(JSON.stringify(STATE))}) : reply(404, "");
    }
    return reply(404, "");
  };

  function snap(label) {
    var root = document.getElementById("dsh-souls-hud");
    var mark = document.querySelector('[data-slot="sidebar.brand.mark"]');
    var name = document.querySelector('[data-slot="sidebar.brand.name"]');
    var sp = root && root.querySelector('[data-kind="sp"] .dsh-sh__value');
    var markBox = root && root.querySelector(".dsh-sh__mark");
    return {
      label: label,
      hud: Boolean(root),
      rows: root ? root.querySelectorAll(".dsh-sh__row").length : 0,
      sp: sp ? sp.textContent : null,
      hidingRule: Boolean(document.getElementById("dsh-souls-hud-brand")),
      hudStyle: Boolean(document.getElementById("dsh-souls-hud-style")),
      appMark: mark ? getComputedStyle(mark).visibility : "absent",
      appName: name ? getComputedStyle(name).visibility : "absent",
      markPx: markBox ? Math.round(markBox.getBoundingClientRect().height) : 0,
      // The figure, and the transform that fits it: a badge that renders without
      // its device looks *plausible* — plate, rim, shadow, cracks — which is why
      // this went unnoticed for a whole pass.
      device: (function () {
        var group = root && root.querySelector(".dsh-sh__device");
        if (!group) return "absent";
        var fitted = group.firstElementChild;
        var shape = group.querySelector("path, polygon, circle");
        var box = null;
        try {
          box = shape ? shape.getBBox() : null;
        } catch (error) {
          box = null;
        }
        return (
          group.getAttribute("data-device") +
          " fit=" + (fitted ? fitted.getAttribute("transform") : "none") +
          " box=" + (box ? [box.x, box.y, box.width, box.height].map(function (n) { return Math.round(n); }).join(",") : "none") +
          " paint=" + (shape ? getComputedStyle(shape).fill : "none")
        );
      })(),
      markWidth: markBox ? Math.round(markBox.getBoundingClientRect().width) : 0,
      markRole: markBox ? markBox.getAttribute("role") : null,
      markTab: markBox ? markBox.getAttribute("tabindex") : null,
      markTitle: markBox ? markBox.getAttribute("title") : null,
    };
  }

  var steps = [];
  var errors = [];
  function record(label) { steps.push(snap(label)); }

  // This Chrome build does not run page timers under --virtual-time-budget, so
  // the scenario drives its own clock: deterministic, and independent of how
  // fast the environment happens to be.
  var realSetTimeout = window.setTimeout.bind(window);
  window.__nativeSetTimeout = realSetTimeout;
  var vnow = 0;
  var seq = 1;
  var timers = {};
  window.setTimeout = function (fn, ms) {
    var id = seq++;
    timers[id] = { at: vnow + (Number(ms) || 0), fn: fn, every: 0 };
    return id;
  };
  window.setInterval = function (fn, ms) {
    var id = seq++;
    var every = Math.max(1, Number(ms) || 1);
    timers[id] = { at: vnow + every, fn: fn, every: every };
    return id;
  };
  window.clearTimeout = function (id) { delete timers[id]; };
  window.clearInterval = function (id) { delete timers[id]; };
  window.requestAnimationFrame = function (fn) {
    return window.setTimeout(function () { fn(vnow); }, 16);
  };
  window.cancelAnimationFrame = function (id) { delete timers[id]; };

  function runDue() {
    var due = [];
    for (var id in timers) if (timers[id].at <= vnow) due.push(timers[id]);
    due.sort(function (a, b) { return a.at - b.at; });
    for (var i = 0; i < due.length; i += 1) {
      var timer = due[i];
      if (timer.every) timer.at = vnow + timer.every;
      else { for (var key in timers) if (timers[key] === timer) delete timers[key]; }
      try { timer.fn(vnow); } catch (error) { errors.push(String((error && error.message) || error)); }
    }
  }
  function flush() {
    var chain = Promise.resolve();
    for (var i = 0; i < 10; i += 1) chain = chain.then(function () {});
    return chain;
  }
  function advance(ms) {
    var end = vnow + ms;
    function step() {
      if (vnow >= end) return Promise.resolve();
      vnow = Math.min(end, vnow + 25);
      runDue();
      return flush().then(step);
    }
    return step();
  }

  function paint() {
    document.getElementById("results").textContent =
      steps.map(function (step) {
        return step.label.padEnd(11) +
          " hud=" + (step.hud ? 1 : 0) +
          " rows=" + step.rows +
          " sp=" + step.sp +
          " rule=" + (step.hidingRule ? 1 : 0) +
          " style=" + (step.hudStyle ? 1 : 0) +
          " mark=" + step.appMark +
          " badge=" + step.markPx + "px" +
          " float=" + (step.float ? "y" : "n") + "@" + step.x + "," + step.y;
      }).join("\n") + (errors.length ? "\nERRORS: " + errors.join(" | ") : "\nERRORS: none");
  }

  /** Collapse the rail the way the app does: the brand row goes away. */
  function collapseSidebar(collapsed) {
    var sidebar = document.querySelector(".X_sidebarCol");
    var row = document.querySelector('[data-slot="sidebar.brand.mark"]').parentElement;
    if (sidebar) sidebar.style.width = collapsed ? "64px" : "280px";
    if (row) row.style.display = collapsed ? "none" : "";
  }

  /** Drag the floating cluster with real pointer events and report where it went. */
  function dragFloating(byX, byY) {
    var root = document.getElementById("dsh-souls-hud");
    if (!root) return null;
    var box = root.getBoundingClientRect();
    var at = { x: Math.round(box.left) + 8, y: Math.round(box.top) + 8 };
    var fire = function (type, x, y) {
      root.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: y,
        }),
      );
    };
    fire("pointerdown", at.x, at.y);
    fire("pointermove", at.x + byX / 2, at.y + byY / 2);
    fire("pointermove", at.x + byX, at.y + byY);
    fire("pointerup", at.x + byX, at.y + byY);
    return at;
  }

  window.__runScenario = function () {
    return advance(500)
      .then(function () { record("mounted"); return advance(1400); })
      .then(function () { MODE = "off"; return advance(3200); })
      .then(function () { record("after-off"); return advance(400); })
      .then(function () { MODE = "on"; return advance(10000); })
      .then(function () { record("after-on"); })
      .then(function () {
        // Collapsed rail: the cluster must float, and start below the tabs.
        collapseSidebar(true);
        return advance(1200);
      })
      .then(function () {
        record("collapsed");
        var step = steps[steps.length - 1];
        if (!step.float) errors.push("collapsed: the cluster did not float");
        var y = parseInt(step.y, 10);
        if (!(y >= 88)) errors.push("collapsed: y=" + step.y + " is not below the tabs by the margin");
        return advance(200);
      })
      .then(function () {
        // ...and it must be draggable, and remember where it was put.
        var before = steps[steps.length - 1];
        dragFloating(60, 90);
        return advance(400).then(function () {
          record("dragged");
          var after = steps[steps.length - 1];
          if (parseInt(after.x, 10) <= parseInt(before.x, 10)) {
            errors.push("drag: x went " + before.x + " -> " + after.x);
          }
          if (!after.stored) errors.push("drag: the position was not remembered");
          return advance(200);
        });
      })
      .then(function () {
        // Expanding the rail puts it back in the row.
        collapseSidebar(false);
        return advance(1200);
      })
      .then(function () {
        record("expanded");
        var step = steps[steps.length - 1];
        if (step.float) errors.push("expanded: the cluster is still floating");
      })
      .catch(function (error) { errors.push("scenario: " + ((error && error.message) || error)); })
      .then(paint);
  };
</script>
<script>${renderer}</script>
<script>
  (function () {
    // hud.js boots on DOMContentLoaded, so start from a real task after it.
    window.__nativeSetTimeout(function () { window.__runScenario(); }, 30);
  })();
</script>
`

writeFileSync('/tmp/dsh-standdown.html', page)

const shot = process.env.DSH_SHOT || '/tmp/dsh-standdown.png'

await new Promise((resolve, reject) => {
  execFile(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--no-first-run',
      // A throwaway profile: a reused one serves the page from cache, and the
      // screenshot then shows a previous run of the page (which cost an hour of
      // chasing a rendering ghost that was never there).
      `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dsh-standdown-'))}`,
      '--force-device-scale-factor=1',
      '--window-size=1080,260',
      '--virtual-time-budget=14000',
      '--screenshot=' + shot,
      'file:///tmp/dsh-standdown.html',
    ],
    { maxBuffer: 40 * 1024 * 1024, timeout: 120000 },
    (error) => (error ? reject(error) : resolve()),
  )
})

// The report is a picture on this Chrome build, so print what the page drew
// and let the run's own exit status stay honest about Chrome succeeding.
console.log('souls-hud stand-down: report written to ' + shot)
console.log('  (opens as: ' + shot + ')')
console.log('souls-hud stand-down:')
console.log('  The report is drawn by the page; read ' + shot + ' to see the steps.')
console.log('  Expected: mounted hud=1 mark=hidden | after-off hud=0 mark=visible')
console.log('            after-on hud=1 rows=3 mark=hidden')
