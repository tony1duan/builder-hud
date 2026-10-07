/**
 * BuilderHUD — client half.
 *
 * Built bundle in the web module-loader format: a classic script that registers
 * a CJS-style factory under this package's graph id. The host's `clientModules`
 * scans enabled loader entries for `dsh.client` packages, serves this file from
 * `/plugins`, and pushes graph changes down the `/plugins/events` SSE channel;
 * the browser's module controller answers by calling
 * `loader.create({ name: id })`, which runs `apply()` below.
 *
 * It does four things, all of them things only a client half can do:
 *
 *   1. mounts the renderer (see `apply()`);
 *   2. publishes which session the GUI is showing, so the stamina bar describes
 *      the session on screen rather than the host's guess;
 *   3. registers this plugin's dictionary (`locale` namespace `souls-hud`) and
 *      publishes the app's own translate seat for the renderer, which is a plain
 *      script and cannot reach the Cordis context;
 *   4. renders the settings form on the plugin's row, in the app's language,
 *      including the medallion's device/material pickers and the SVG upload.
 *
 * ## Why `apply()` re-mounts unconditionally
 *
 * `dsh-client-hmr` stat-polls every graph row's bundle and pushes a `rebuilt`
 * frame whenever that file's size/mtime/ctime changes; the browser answers with
 * `entries.reload(id, rev)`, which re-imports this bundle and runs `apply()`
 * again in the **already-open page**. That is the only mechanism DSH offers for
 * getting changed browser code into a page that is already running, and this
 * plugin leans on it deliberately: touching this file swaps the live renderer.
 *
 * So `apply()` always tears down whatever is mounted and injects a fresh
 * `<script>` for the renderer. The host serves `lib/hud.js` with
 * `cache-control: no-store`, so the re-fetch always picks up the current file.
 *
 * There is deliberately no disposer that removes the HUD: a torn-down renderer
 * with no re-mount is exactly the "it silently disappeared" failure this plugin
 * cannot afford, and the guard makes a second mount harmless.
 *
 * @module dsh-plugin-souls-hud/client
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-souls-hud",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** Stable Cordis plugin name. */
    var name = "souls-hud-client";

    /** The renderer the host serves; also the single-instance guard's owner. */
    var RENDERER = "/dsh-souls-hud/hud.js";

    /** The plugin's own route prefix. */
    var BASE = "/dsh-souls-hud";

    /** The renderer's own single-instance guard, which doubles as a handle. */
    var GUARD = "__DSH_SOULS_HUD__";

    /** The namespace this plugin owns in the app's locale registry. */
    var NS = "souls-hud";

    /**
     * The `plugins.row.config` keys this component answers.
     *
     * The owner dispatches `<bundle package>#<row id>` — the **bundle's** name,
     * not the row's module name (`rowConfigKey(pkg.name, row.rowId)` in
     * `dsh-client-ui-plugin-manager`, where `pkg` is the card being viewed). The
     * row belongs to the BuilderHUD bundle's patch, so that is the key the page
     * actually asks for; registering under our own package name alone left the
     * occupant live but never dispatched — the row simply had no configure
     * control.
     *
     * Both are registered: the first is what the shipped bundle dispatches, the
     * second covers a profile that declares the row itself against this package.
     */
    var CONFIG_KEYS = ["dsh-plugin-builder-hud#souls-hud", "dsh-plugin-souls-hud#souls-hud"];
    /**
     * The package whose page shows this row's settings.
     *
     * The app's `pluginNavigation` service is two lines:
     *
     *     ctx.layout.selectPanel(PANEL_ID);
     *     instance.actions.setView({ kind: "package", name: packageName });
     *
     * — so the argument names a **package view**, and the app's documentation says
     * `openBundle(packageName)` opens *bundle details*, with row pages identified by
     * "the bundle package and row id". This row's bundle is `dsh-plugin-builder-hud`
     * (it is in the profile's `dsh.profile.bundles`), so that is the name.
     *
     * `#`-qualified candidates exist but are not documented; {@link trial} is exposed
     * so one can be tried from the console without a rebuild.
     */
    var NAV_TARGET = "dsh-plugin-builder-hud";

    /**
     * The one place that decides how this project can be supported.
     *
     * Two channels, because two is what it actually uses: the WeChat 赞赏码 for
     * readers in China, Ko-fi for everyone else. The plugin is free and stays free —
     * nothing here is a licence and no feature sits behind one — and a channel whose
     * half is empty (`url` for a link, `file` for a code) is not rendered at all.
     *
     * - `kind: "qr"` — an image under `assets/support/`, served by the host at
     *   `/dsh-souls-hud/support/<file>`; its button unfolds the code in place.
     * - `kind: "link"` — a page to open in a new tab.
     *
     * `id` is also the dictionary key: `support.<id>` for the label and, for a code,
     * `support.<id>.scan` for the app that can read it. Adding a channel is one entry
     * here and its strings in `DICT`; `test/harness.mjs` fails if the two disagree.
     */
    var SUPPORT = {
      channels: [
        { id: "wechat", kind: "qr", file: "wechat.png" },
        { id: "kofi", kind: "link", url: "https://ko-fi.com/tonyhd" },
      ],
    };

    /**
     * This plugin's own strings.
     *
     * The app's locale service wants every shipped locale in one call, so this
     * is one table with an `en` and a `zh` column and no partial translations:
     * a key added to one has to be added to the other, and the fallback chain
     * (`zh` → `en`) means an English string is never a missing string.
     *
     * The renderer's copy is not a second source of truth — it subscribes to
     * this one through `window.__DSH_SOULS_HUD_T__` and only carries a floor for
     * the route where the client half never mounts.
     */
    var DICT = {
      zh: {
        // --- shared with the renderer -----------------------------------------
        // `lib/hud.js` has no Cordis context, so it reads these five through
        // `__DSH_SOULS_HUD_T__`; its own FALLBACK_TEXT has to carry the same keys.
        "row.balanceTitle": "打开设置查看余额",
        "row.contextTitle": "查看 context 占用",
        "balance.signedOut": "未登录",
        "balance.unavailable": "不可用",
        "context.noSession": "无会话",

        // --- the row's one-liner ----------------------------------------------
        "mark.settings": "点击打开这个插件的设置",
    "summary.line": "徽章 {badge} · 红条 ¥{hp} / 蓝条 ¥{fp} · 数值{numbers} · 绿条{stamina}",

        // --- page -------------------------------------------------------------
        "page.intro": "改动会立即保存，没有”确定“按钮。",

        // --- preview ----------------------------------------------------------
        "section.preview": "预览",
        "section.previewHint": "",
        "preview.unavailable": "HUD 未运行。",
        "preview.dark": "深色",
        "preview.light": "浅色",
        "preview.peak": "高峰",
        "preview.offpeak": "低谷",
        "preview.caption": "{theme} · {tariff}",
        "preview.gaugeLive": "此刻 {value} 新 token/min。",
        "preview.gaugeSample": "预览环固定画 {percent}%。",
        "preview.noReading": "",
        "preview.themeNote": "",

        // --- badge ------------------------------------------------------------
        "section.badge": "徽章",
        "section.badgeHint": "",
        "shape.label": "轮廓",
        "shape.hint": "",
        "shape.round": "圆形 · 誓约奖章",
        "shape.octagon": "八角形 · 切角铜牌",
        "material.label": "金属",
        "material.hint": "",
        "material.bronze": "青铜（默认）",
        "material.iron": "铁（偏蓝的钢色）",
        "material.silver": "银",
        "material.gold": "金",
        "device.label": "图形",
        "device.hint": "",
        "device.whale": "鲸鱼（默认）",
        "device.hammer": "锤子",
        "device.sword": "剑",
        "device.sun": "太阳",
        "device.moon": "月亮",
        "device.wolf": "狼",
        "device.custom": "自定义 · 用我上传的 SVG",
        "upload.label": "自定义图形",
        "upload.hint": "一个 .svg：自动缩放贴合、自动上金属色。挖空用 fill-rule=\"evenodd\"。",
        "upload.choose": "选择 SVG 文件…",
        "upload.replace": "换一个 SVG…",
        "upload.remove": "删除并恢复默认图形",
        "upload.none": "还没有上传文件。",
        "upload.stored": "已上传：{kb} KB",
        "upload.busy": "处理中…",
        "upload.saved": "已上传并启用。",
        "upload.error.empty": "文件是空的。",
        "upload.error.too-large": "文件太大（上限 64 KB）。",
        "upload.error.not-an-svg": "这不是一个 SVG 文件。",
        "upload.error.no-file": "先上传一个 SVG 文件，再选“自定义”。",
        "upload.error.no-viewbox": "这个 SVG 既没有 viewBox 也没有宽高，无法缩放。",
        "upload.error.forbidden-element": "文件里有不允许的元素（脚本、外链图片、动画等）。",
        "upload.error.event-handler": "文件里有内联事件（on* 属性），已拒绝。",
        "upload.error.external-reference": "文件引用了外部地址，已拒绝。",
        "upload.error.script-url": "文件里有 javascript:/data: 之类的地址，已拒绝。",
        "upload.error.read-failed": "读取文件失败。",
        "upload.error.generic": "上传失败：{reason}",

        // --- bars -------------------------------------------------------------
        "section.bars": "状态条",
        "section.barsHint": "",
        "bars.now": "当前：充值 ¥{recharge} · 赠送 ¥{bonus} · 上下文已用 {percent}%（剩余 {free}%）",
        "bars.nowUnavailable": "读不到实时数据。",
        "bars.hp.label": "红条上限 · 充值余额",
        "bars.hp.hint": "¥{cap} 时满格。",
        "bars.fp.label": "蓝条上限 · 赠送余额",
        "bars.fp.hint": "¥{cap} 时满格。",
        "bars.numbers.label": "条上的数值",
        "bars.numbers.hint": "",
        "numbers.always": "一直显示",
        "numbers.hover": "鼠标移上去才显示",
        "numbers.hidden": "不显示",
        "bars.stamina.label": "绿条口径 · 上下文",
        "bars.stamina.hint": "",
        "stamina.remaining": "剩余（条越满越好）",
        "stamina.used": "已用",
        "value.numbers.always": "常显",
        "value.numbers.hover": "悬浮",
        "value.numbers.hidden": "隐藏",
        "value.stamina.remaining": "剩余",
        "value.stamina.used": "已用",

        // --- burn ring and tariff --------------------------------------------
        "section.burn": "消耗环与时段",
        "section.burnHint": "环长＝消耗速度，颜色＝高峰/低谷。",
        "burn.now": "当前：{rate} · 生成 {output} · 缓存重读 {cache} · {tariff}",
        "burn.rate": "{value} 新 token/分",
        "burn.output": "{value}/分",
        "burn.cache": "{value}/分",
        "burn.idle": "空闲",
        "burn.warming": "测量中…",
        "burn.unavailable": "HUD 未运行，暂时读不到。",
        "burn.scale.label": "环形量程",
        "burn.scale.hint": "环满一圈所需要的速度。当前 {rate}。",
        "burn.scale.unit": "新 token/分",
        "burn.tint.label": "用时段颜色给环上色",
        "burn.tint.hint": "",
        "burn.advanced": "高峰时段与节假日",
        "burn.advancedHint": "",
        "tariff.enabled": "在徽章上显示时段",
        "tariff.enabledHint": "",
        "tariff.half": "",
        "tariff.now": "现在：{clock} UTC · {state}{why}{next}",
        "tariff.next": " · {when}后转为{state}",
        "tariff.hoursMinutes": "{hours} 小时 {minutes} 分",
        "tariff.minutes": "{minutes} 分钟",
        "tariff.why.peak-window": "（{window} UTC）",
        "tariff.why.between-windows": "（两个高峰时段之间的空档）",
        "tariff.why.weekend": "（周末全天低谷）",
        "tariff.why.holiday": "（{date} {name}）",
        "tariff.why.off-day": "（不是高峰星期）",
        "tariff.why.outside-windows": "（高峰时段之外）",
        "tariff.windows": "高峰时段（UTC）",
        "tariff.windowsHint": "",
        "tariff.windowAdd": "再加一个时段",
        "tariff.windowRemove": "删除",
        "tariff.weekdays": "高峰期星期",
        "tariff.weekdaysHint": "",
        "weekday.0": "日",
        "weekday.1": "一",
        "weekday.2": "二",
        "weekday.3": "三",
        "weekday.4": "四",
        "weekday.5": "五",
        "weekday.6": "六",
        "tariff.holidayMode": "中国法定节假日",
        "tariff.holiday.cn": "国务院数据（公休＋调休）",
        "tariff.holiday.custom": "自定义日期",
        "tariff.holiday.none": "不考虑节假日",
        "tariff.holidayData": "数据：{years} 年 · 生成于 {date}",
        "tariff.holidayUnknown": "未知",
        "tariff.holidayFresh": "",
        "tariff.holidayStale": "数据还没有 {year} 年，建议刷新。",
        "tariff.auto": "自动保持节假日数据最新",
        "tariff.autoHint": "",
        "tariff.checked": "上次检查：{when}",
        "tariff.lastError": "上次自动更新失败：{error}",
        "tariff.refresh": "立即刷新",
        "tariff.refreshing": "正在刷新…",
        "tariff.refreshed": "已更新。",
        "tariff.refreshFailed": "无法连接数据源，保留原有数据。",
        "tariff.makeup": "调休上班日也算工作日",
        "tariff.makeupHint": "",
        "tariff.customHolidays": "放假日期",
        "tariff.customHolidaysHint": "每行一个 YYYY-MM-DD。",
        "tariff.customWorkdays": "调休上班日期",
        "tariff.customWorkdaysHint": "每行一个 YYYY-MM-DD。",
        "tariff.peak": "高峰",
        "tariff.offpeak": "低谷",
        "tariff.off": "未显示时段",

        // --- support ----------------------------------------------------------
        // Only shown when at least one channel in `SUPPORT` is filled in; the
        // free promise is on the page either way, because it is the point.
        "page.free": "插件完全免费，没有付费版，也没有需要解锁的功能。",
        "section.support": "支持作者",
        "section.supportHint": "打赏只是心意，不换取任何功能。",
        "support.thanks": "如果它帮到了你，可以请作者喝杯咖啡：",
        "support.qrHint": "扫码打赏",
        // A code is app-specific in a way a URL never is: the WeChat 赞赏码 cannot be
        // read by Alipay or by the camera app, so each channel says which app opens it.
        "support.qrOpen": "扫不出来时，点一下二维码打开原图，更好扫。",
        "support.kofi": "Ko-fi",
        "support.wechat": "微信赞赏码",
        "support.wechat.scan": "只能微信扫一扫",

        // --- save status ------------------------------------------------------
        "status.saving": "保存中…",
        "status.saved": "已保存",
        "status.failed": "保存失败",
      },
      en: {
        // --- shared with the renderer -----------------------------------------
        "row.balanceTitle": "Open Settings to see the balance",
        "row.contextTitle": "Show the context readout",
        "balance.signedOut": "signed out",
        "balance.unavailable": "unavailable",
        "context.noSession": "no session",

        // --- the row's one-liner ----------------------------------------------
        "mark.settings": "Click to open this plugin's settings",
        "summary.line": "badge {badge} · red ¥{hp} / blue ¥{fp} · numbers {numbers} · stamina {stamina}",

        // --- page -------------------------------------------------------------
        "page.intro": "Changes save as you make them.",

        // --- preview ----------------------------------------------------------
        "section.preview": "Preview",
        "section.previewHint": "",
        "preview.unavailable": "HUD not running.",
        "preview.dark": "Dark",
        "preview.light": "Light",
        "preview.peak": "Peak",
        "preview.offpeak": "Off-peak",
        "preview.caption": "{theme} · {tariff}",
        "preview.gaugeLive": "Right now {value} new tok/min.",
        "preview.gaugeSample": "The preview ring is fixed at {percent}%.",
        "preview.noReading": "",
        "preview.themeNote": "",

        // --- badge ------------------------------------------------------------
        "section.badge": "Badge",
        "section.badgeHint": "",
        "shape.label": "Outline",
        "shape.hint": "",
        "shape.round": "Round · covenant medal",
        "shape.octagon": "Octagon · cut-corner plate",
        "material.label": "Metal",
        "material.hint": "",
        "material.bronze": "Bronze (default)",
        "material.iron": "Iron (blue steel)",
        "material.silver": "Silver",
        "material.gold": "Gold",
        "device.label": "Figure",
        "device.hint": "",
        "device.whale": "Whale (default)",
        "device.hammer": "Hammer",
        "device.sword": "Sword",
        "device.sun": "Sun",
        "device.moon": "Moon",
        "device.wolf": "Wolf",
        "device.custom": "Custom · my uploaded SVG",
        "upload.label": "Custom figure",
        "upload.hint": "One .svg — scaled to fit and painted in the metal. Cut a hole with fill-rule=\"evenodd\".",
        "upload.choose": "Choose an SVG file…",
        "upload.replace": "Choose a different SVG…",
        "upload.remove": "Delete and go back to the default",
        "upload.none": "No file uploaded yet.",
        "upload.stored": "Uploaded: {kb} KB",
        "upload.busy": "Working…",
        "upload.saved": "Uploaded and in use.",
        "upload.error.empty": "The file is empty.",
        "upload.error.too-large": "The file is too large (64 KB limit).",
        "upload.error.not-an-svg": "That is not an SVG file.",
        "upload.error.no-file": "Upload an SVG first, then choose “Custom”.",
        "upload.error.no-viewbox": "That SVG has no viewBox and no width/height, so it cannot be scaled.",
        "upload.error.forbidden-element": "The file contains something it may not (script, external image, animation…).",
        "upload.error.event-handler": "The file contains inline event handlers (on* attributes).",
        "upload.error.external-reference": "The file references an external address.",
        "upload.error.script-url": "The file contains a javascript:/data: style address.",
        "upload.error.read-failed": "The file could not be read.",
        "upload.error.generic": "Upload failed: {reason}",

        // --- bars -------------------------------------------------------------
        "section.bars": "Bars",
        "section.barsHint": "",
        "bars.now": "Now: topped-up ¥{recharge} · granted ¥{bonus} · context {percent}% used ({free}% free)",
        "bars.nowUnavailable": "No live reading.",
        "bars.hp.label": "Red bar cap · topped-up balance",
        "bars.hp.hint": "Full at ¥{cap}.",
        "bars.fp.label": "Blue bar cap · granted balance",
        "bars.fp.hint": "Full at ¥{cap}.",
        "bars.numbers.label": "Numbers on the bars",
        "bars.numbers.hint": "",
        "numbers.always": "Always",
        "numbers.hover": "On hover",
        "numbers.hidden": "Never",
        "bars.stamina.label": "Green bar reading · context",
        "bars.stamina.hint": "",
        "stamina.remaining": "Free (a fuller bar is better)",
        "stamina.used": "Used",
        "value.numbers.always": "on",
        "value.numbers.hover": "on hover",
        "value.numbers.hidden": "off",
        "value.stamina.remaining": "free",
        "value.stamina.used": "used",

        // --- burn ring and tariff --------------------------------------------
        "section.burn": "Burn ring & tariff",
        "section.burnHint": "Length is burn rate; colour is the tariff window.",
        "burn.now": "Now: {rate} · generated {output} · cache re-read {cache} · {tariff}",
        "burn.rate": "{value} new tok/min",
        "burn.output": "{value}/min",
        "burn.cache": "{value}/min",
        "burn.idle": "idle",
        "burn.warming": "measuring…",
        "burn.unavailable": "The HUD is not running, so there is nothing to read yet.",
        "burn.scale.label": "Ring full scale",
        "burn.scale.hint": "The rate that fills the ring. Currently {rate}.",
        "burn.scale.unit": "new tok/min",
        "burn.tint.label": "Colour the ring by tariff window",
        "burn.tint.hint": "",
        "burn.advanced": "Peak hours & holidays",
        "burn.advancedHint": "",
        "tariff.enabled": "Show the tariff window on the badge",
        "tariff.enabledHint": "",
        "tariff.half": "",
        "tariff.now": "Now: {clock} UTC · {state}{why}{next}",
        "tariff.next": " · {state} in {when}",
        "tariff.hoursMinutes": "{hours}h {minutes}m",
        "tariff.minutes": "{minutes}m",
        "tariff.why.peak-window": " ({window} UTC)",
        "tariff.why.between-windows": " (the gap between the two peak windows)",
        "tariff.why.weekend": " (weekends are off-peak in full)",
        "tariff.why.holiday": " ({date} {name})",
        "tariff.why.off-day": " (not a peak weekday)",
        "tariff.why.outside-windows": " (outside the peak windows)",
        "tariff.windows": "Peak windows (UTC)",
        "tariff.windowsHint": "",
        "tariff.windowAdd": "Add a window",
        "tariff.windowRemove": "Remove",
        "tariff.weekdays": "Peak weekdays",
        "tariff.weekdaysHint": "",
        "weekday.0": "Sun",
        "weekday.1": "Mon",
        "weekday.2": "Tue",
        "weekday.3": "Wed",
        "weekday.4": "Thu",
        "weekday.5": "Fri",
        "weekday.6": "Sat",
        "tariff.holidayMode": "Chinese public holidays",
        "tariff.holiday.cn": "State Council calendar (holidays + 调休)",
        "tariff.holiday.custom": "Custom dates",
        "tariff.holiday.none": "Ignore holidays",
        "tariff.holidayData": "Data: {years} · generated {date}",
        "tariff.holidayUnknown": "unknown",
        "tariff.holidayFresh": "",
        "tariff.holidayStale": "No data for {year} yet — refresh it.",
        "tariff.auto": "Keep the holiday data current automatically",
        "tariff.autoHint": "",
        "tariff.checked": "Last checked: {when}",
        "tariff.lastError": "The last automatic refresh failed: {error}",
        "tariff.refresh": "Refresh now",
        "tariff.refreshing": "Refreshing…",
        "tariff.refreshed": "Updated.",
        "tariff.refreshFailed": "Upstream unreachable; keeping the existing data.",
        "tariff.makeup": "Count make-up workdays as working days",
        "tariff.makeupHint": "",
        "tariff.customHolidays": "Holiday dates",
        "tariff.customHolidaysHint": "One YYYY-MM-DD per line.",
        "tariff.customWorkdays": "Make-up workdays",
        "tariff.customWorkdaysHint": "One YYYY-MM-DD per line.",
        "tariff.peak": "peak",
        "tariff.offpeak": "off-peak",
        "tariff.off": "tariff not shown",

        // --- support ----------------------------------------------------------
        "page.free": "The plugin is free: no paid edition, and no feature to unlock.",
        "section.support": "Support the author",
        "section.supportHint": "A tip is a thank-you, not a purchase — it unlocks nothing.",
        "support.thanks": "If it has been useful, you can buy the author a coffee:",
        "support.qrHint": "scan to tip",
        "support.qrOpen": "If it will not scan, click the code to open the full-size image.",
        "support.kofi": "Ko-fi",
        "support.wechat": "WeChat tip code",
        "support.wechat.scan": "WeChat app only",

        // --- save status ------------------------------------------------------
        "status.saving": "Saving…",
        "status.saved": "Saved",
        "status.failed": "Save failed",
      },
    };

    /**
     * (Re)mount the HUD renderer. Safe to call repeatedly.
     * @param _ctx - the client Cordis context (nothing needs disposing).
     */
    function apply(_ctx) {
      // React is required for the settings form only. If it cannot be
      // resolved, the HUD must still mount — the form is the optional half.
      var React = null;
      try {
        React = require("react");
      } catch (error) {
        React = null;
      }
      var locale = _ctx && _ctx.get ? _ctx.get("locale") : null;
      registerDictionaries(_ctx, locale);
      registerSettings(_ctx, React, locale);
      publishShownSession(_ctx);
      publishLocale(locale);
      var live = window[GUARD];
      if (live && typeof live.destroy === "function") {
        try {
          live.destroy();
        } catch (error) {
          // A half-built instance must never block its replacement.
        }
      }

      var previous = document.querySelector("script[data-dsh-souls-hud]");
      if (previous && previous.parentNode) previous.parentNode.removeChild(previous);

      var script = document.createElement("script");
      script.src = RENDERER;
      script.async = false;
      script.dataset.dshBuilderHud = "client";
      document.head.appendChild(script);
    }

    /**
     * Register this plugin's dictionaries under its own locale namespace.
     *
     * Registration throws when the namespace already holds that locale, which is
     * exactly what a second mount in the same page would do — and a second mount
     * is a normal event here (HMR re-imports this file). So a duplicate is
     * accepted silently: the strings are identical, and refusing to mount over it
     * would be worse.
     *
     * @param ctx - the client Cordis context.
     * @param locale - the app's locale service, or null when absent.
     */
    function registerDictionaries(ctx, locale) {
      if (!ctx || !ctx.effect || !locale || typeof locale.register !== "function") return;
      ctx.effect(function () {
        try {
          return locale.register(NS, { zh: DICT.zh, en: DICT.en });
        } catch (error) {
          return undefined;
        }
      });
    }

    /**
     * Publish "which session is the GUI showing" for the renderer to name on
     * every poll.
     *
     * Session selection lives in the browser, not in the host, so the host can
     * only guess — and its guess (newest root session) never moved when the user
     * switched sessions, which is exactly why the stamina bar described the
     * wrong session. The app's `uiSession` service owns the answer: its
     * `adapter.current` is the main-view binding and the snapshot's `key` is the
     * session id (`undefined` while the hero screen is up).
     *
     * A reader rather than a value: the renderer always sees the live answer, and
     * an HMR reload cannot leave a stale id or a dead subscription behind.
     *
     * @param ctx - the client Cordis context.
     */
    function publishShownSession(ctx) {
      window.__DSH_DSH_SESSION__ = function () {
        try {
          var ui = ctx && ctx.get ? ctx.get("uiSession") : null;
          var source = ui && ui.adapter && ui.adapter.current;
          var value =
            source && typeof source.getSnapshot === "function" ? source.getSnapshot() : null;
          var id = value && value.key;
          return typeof id === "string" ? id : "";
        } catch (error) {
          return "";
        }
      };
    }

    /**
     * Publish the app's locale to the renderer.
     *
     * `lib/hud.js` is a plain injected script: it has no Cordis context and
     * therefore cannot reach `ctx.locale`. Both halves of the problem are solved
     * with readers rather than values, so a locale switch is picked up on the
     * next draw without any re-mount:
     *
     *   - `__DSH_SOULS_HUD_T__` — this plugin's own translate seat, so the HUD's
     *     handful of strings come from the same dictionary as the settings form;
     *   - `__DSH_SOULS_HUD_LOCALE__` — the active language id, for the renderer's
     *     own fallback table when the seat is not there yet.
     *
     * @param locale - the app's locale service, or null when absent.
     */
    function publishLocale(locale) {
      window.__DSH_SOULS_HUD_LOCALE__ = function () {
        try {
          var snapshot = locale && typeof locale.getSnapshot === "function" ? locale.getSnapshot() : null;
          return snapshot && typeof snapshot.active === "string" ? snapshot.active : "";
        } catch (error) {
          return "";
        }
      };
      window.__DSH_SOULS_HUD_T__ =
        locale && typeof locale.bind === "function"
          ? locale.bind(NS)
          : function (key, params) {
              var table = browserDict();
              var template = table[key] !== undefined ? table[key] : DICT.en[key];
              if (typeof template !== "string") return key;
              return params
                ? template.replace(/\{(\w+)\}/g, function (match, name) {
                    return name in params ? String(params[name]) : match;
                  })
                : template;
            };
    }
    /**
     * Normalize an uploaded SVG into something the badge can wear.
     *
     * This is the "make it blend in" step, done with the DOM rather than with
     * string surgery:
     *
     *   - **fills become `currentColor`**, so the metal decides the colour.
     *     `url(#…)` paints are flattened the same way — the badge supplies its
     *     own gradient and will not read someone else's;
     *   - **stroke art stays stroke art** (filling an outline turns a drawing
     *     into a blob) but its stroke becomes `currentColor` too, so it is
     *     struck from the same metal;
     *   - **basic shapes become paths** (`rect`, `circle`, `ellipse`, `line`,
     *     `polygon`, `polyline`), so the result is one element type and one
     *     paint contract — the closest thing to "convert it to a fill" that can
     *     be done without a stroke-to-outline expander;
     *   - **ids are prefixed** and `url(#…)`/`href="#…"` follow, so an upload can
     *     never collide with an id the app already uses;
     *   - scripts, remote references, inline styles and event handlers are
     *     dropped outright (the host refuses them again on the way in).
     *
     * It lives at module scope, not inside the form, because it is pure and
     * because it is the one piece of the upload path worth testing on its own:
     * `exports.normalizeUpload` publishes it, and `test/upload.mjs` drives it in
     * headless Chrome.
     *
     * @param text - the file's text.
     * @returns `{ ok: true, svg, preview }` or `{ ok: false, reason }`.
     */
    function normalizeUpload(text) {
      if (typeof text !== "string" || text.trim() === "") return { ok: false, reason: "empty" };
      if (text.length > 64 * 1024) return { ok: false, reason: "too-large" };
      var doc;
      try {
        doc = new DOMParser().parseFromString(text, "image/svg+xml");
      } catch (error) {
        return { ok: false, reason: "not-an-svg" };
      }
      if (!doc || !doc.documentElement) return { ok: false, reason: "not-an-svg" };
      var root = doc.documentElement;
      if (String(root.nodeName).toLowerCase() !== "svg") return { ok: false, reason: "not-an-svg" };
      if (doc.getElementsByTagName("parsererror").length > 0) {
        return { ok: false, reason: "not-an-svg" };
      }

      var viewBox = root.getAttribute("viewBox");
      if (!viewBox) {
        var width = parseFloat(root.getAttribute("width"));
        var height = parseFloat(root.getAttribute("height"));
        if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) {
          return { ok: false, reason: "no-viewbox" };
        }
        viewBox = "0 0 " + width + " " + height;
      }

      var UNSAFE = /^(script|foreignobject|iframe|object|embed|image|feimage|animate|animatetransform|animatemotion|set|link|meta|base|style|handler)$/;
      var SHAPES = { path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polygon: 1, polyline: 1 };
      var prefix = "dsh-sh-u" + Math.random().toString(36).slice(2, 8) + "-";
      var ids = {};
      var all = [];
      var walk = root.getElementsByTagName("*");
      for (var i = 0; i < walk.length; i += 1) all.push(walk[i]);
      // The root is part of the drawing too, and `getElementsByTagName` never
      // returns the element it is called on — so without this the `<svg>`'s own
      // `onload`, `style` or `class` would survive the scrub untouched.
      all.push(root);
      for (var k = 0; k < all.length; k += 1) {
        var found = all[k].getAttribute("id");
        if (found) ids[found] = prefix + found;
      }

      /** Turn one drawable primitive into a `path`, or return null. */
      function toPath(node) {
        var tag = String(node.nodeName).toLowerCase();
        var num = function (name, fallback) {
          var value = parseFloat(node.getAttribute(name));
          return isFinite(value) ? value : fallback;
        };
        if (tag === "path") return null;
        if (tag === "line") {
          return (
            "M" + num("x1", 0) + " " + num("y1", 0) +
            "L" + num("x2", 0) + " " + num("y2", 0)
          );
        }
        if (tag === "polyline" || tag === "polygon") {
          var points = (node.getAttribute("points") || "").trim();
          if (points === "") return null;
          var body = "M" + points.replace(/[,\s]+/g, " ");
          return tag === "polygon" ? body + "Z" : body;
        }
        if (tag === "rect") {
          var x = num("x", 0);
          var y = num("y", 0);
          var w = num("width", 0);
          var h = num("height", 0);
          if (w <= 0 || h <= 0) return null;
          var rx = Math.min(num("rx", num("ry", 0)), w / 2);
          var ry = Math.min(num("ry", num("rx", 0)), h / 2);
          if (rx <= 0 || ry <= 0) {
            return "M" + x + " " + y + "H" + (x + w) + "V" + (y + h) + "H" + x + "Z";
          }
          return (
            "M" + (x + rx) + " " + y +
            "H" + (x + w - rx) +
            "A" + rx + " " + ry + " 0 0 1 " + (x + w) + " " + (y + ry) +
            "V" + (y + h - ry) +
            "A" + rx + " " + ry + " 0 0 1 " + (x + w - rx) + " " + (y + h) +
            "H" + (x + rx) +
            "A" + rx + " " + ry + " 0 0 1 " + x + " " + (y + h - ry) +
            "V" + (y + ry) +
            "A" + rx + " " + ry + " 0 0 1 " + (x + rx) + " " + y + "Z"
          );
        }
        if (tag === "circle" || tag === "ellipse") {
          var cx = num("cx", 0);
          var cy = num("cy", 0);
          var rxs = tag === "circle" ? num("r", 0) : num("rx", 0);
          var rys = tag === "circle" ? num("r", 0) : num("ry", 0);
          if (rxs <= 0 || rys <= 0) return null;
          return (
            "M" + (cx - rxs) + " " + cy +
            "A" + rxs + " " + rys + " 0 1 0 " + (cx + rxs) + " " + cy +
            "A" + rxs + " " + rys + " 0 1 0 " + (cx - rxs) + " " + cy + "Z"
          );
        }
        return null;
      }

      for (var n = all.length - 1; n >= 0; n -= 1) {
        var node = all[n];
        var tag = String(node.nodeName).toLowerCase();
        if (UNSAFE.test(tag)) {
          if (node.parentNode) node.parentNode.removeChild(node);
          continue;
        }
        var names = [];
        for (var a = 0; a < node.attributes.length; a += 1) names.push(node.attributes[a].name);
        var hadStroke = false;
        var strokeNone = false;
        for (var s = 0; s < names.length; s += 1) {
          var attr = names[s];
          var lower = attr.toLowerCase();
          if (/^on[a-z]+$/.test(lower) || lower === "style" || lower === "class" || lower === "filter") {
            node.removeAttribute(attr);
            continue;
          }
          if (lower === "href" || lower === "xlink:href") {
            var target = (node.getAttribute(attr) || "").trim();
            if (target.charAt(0) !== "#") node.removeAttribute(attr);
            else node.setAttribute(attr, ids[target.slice(1)] ? "#" + ids[target.slice(1)] : "");
            continue;
          }
          if (lower === "stroke") {
            var strokeValue = (node.getAttribute(attr) || "").trim().toLowerCase();
            strokeNone = strokeValue === "none" || strokeValue === "";
            hadStroke = !strokeNone;
            if (hadStroke) node.setAttribute(attr, "currentColor");
            continue;
          }
          var value = node.getAttribute(attr) || "";
          if (value.indexOf("url(") !== -1) {
            node.setAttribute(
              attr,
              value.replace(/url\(\s*#([^)\s]+)\s*\)/g, function (match, id) {
                return ids[id] ? "url(#" + ids[id] + ")" : match;
              }),
            );
          }
        }
        // Paint: one metal colour, decided by the stylesheet. A shape that
        // was filled becomes `currentColor`; line art keeps `fill="none"` so
        // the badge does not turn its outlines into blobs.
        var fill = node.getAttribute("fill");
        var fillNone = fill !== null && fill.trim().toLowerCase() === "none";
        if (SHAPES[tag]) {
          if (fillNone) {
            node.setAttribute("fill", "none");
            if (hadStroke && !node.getAttribute("stroke-width")) {
              node.setAttribute("stroke-width", "1.2");
            }
          } else {
            node.setAttribute("fill", "currentColor");
          }
          if (strokeNone) node.removeAttribute("stroke");
          var pathData = toPath(node);
          if (pathData !== null) {
            // One element type for everything drawable. Only the attributes
            // that describe *appearance and placement* come across; the
            // primitive's own geometry is now in `d`.
            var KEEP = {
              transform: 1, fill: 1, stroke: 1, "stroke-width": 1, "stroke-linecap": 1,
              "stroke-linejoin": 1, "stroke-miterlimit": 1, "stroke-dasharray": 1,
              "fill-rule": 1, "clip-rule": 1, opacity: 1, "fill-opacity": 1,
              "stroke-opacity": 1, id: 1,
              // Geometry that is not the primitive's own outline still decides
              // what part of it is visible — dropping these turned a clipped
              // rectangle into a full-size block in the first version of this.
              "clip-path": 1, mask: 1,
            };
            var replacement = doc.createElementNS("http://www.w3.org/2000/svg", "path");
            replacement.setAttribute("d", pathData);
            for (var c = 0; c < node.attributes.length; c += 1) {
              var carry = node.attributes[c];
              var carryName = carry.name.toLowerCase();
              if (carryName === "d") continue;
              if (!KEEP[carryName] && carryName.indexOf("data-") !== 0) continue;
              replacement.setAttribute(carry.name, carry.value);
            }
            if (node.parentNode) node.parentNode.replaceChild(replacement, node);
            node = replacement;
          }
        }
        var nodeId = node.getAttribute("id");
        if (nodeId) node.setAttribute("id", ids[nodeId] || prefix + nodeId);
      }

      var markup = "";
      for (var child = 0; child < root.childNodes.length; child += 1) {
        var item = root.childNodes[child];
        if (item.nodeType === 3 && String(item.nodeValue).trim() === "") continue;
        markup += new XMLSerializer().serializeToString(item);
      }

      var serialized = new XMLSerializer().serializeToString(root);
      return { ok: true, svg: serialized, preview: { viewBox: viewBox, markup: markup } };
    }


    /** The dictionary matching the browser's language, for the no-locale case. */
    function browserDict() {
      var language =
        (typeof navigator !== "undefined" && navigator.language) || "";
      return language.toLowerCase().indexOf("zh") === 0 ? DICT.zh : DICT.en;
    }

    /**
     * One string, from the app's seat when it is there and this plugin's table
     * otherwise.
     *
     * At module scope because two surfaces need it: the row's settings form and the
     * tip jar, which lives on the bundle's page. Both fall back to {@link DICT} rather
     * than showing a key.
     *
     * @param props - the component's props, whose `t` is the app's seat.
     * @param key - the dictionary key.
     * @param params - values for `{placeholders}`, if any.
     * @returns the translated string, or the key when nothing carries it.
     */
    function translate(props, key, params) {
      if (props && typeof props.t === "function") {
        try {
          var translated = props.t(key, params);
          if (typeof translated === "string" && translated !== "" && translated !== key) {
            return translated;
          }
        } catch (error) {
          // A broken seat is not worth failing a page over.
        }
      }
      var table = browserDict();
      var template = table[key] !== undefined ? table[key] : DICT.en[key];
      if (typeof template !== "string") return key;
      return params
        ? template.replace(/\{(\w+)\}/g, function (match, name) {
            return name in params ? String(params[name]) : match;
          })
        : template;
    }

    /**
     * Which app reads a channel's code.
     *
     * A URL works in any browser; a payment code does not. The WeChat 赞赏码 is
     * WeChat's own format — Alipay and the camera app cannot read it — which is a
     * support question waiting to happen, so each QR channel carries its own
     * `support.<id>.scan` line and the caption names the app. A channel without one
     * falls back to the generic "scan to tip".
     *
     * @param t - the translate seat for the surface drawing it.
     * @param id - the channel id.
     * @returns the translated line, or the generic one when the channel has none.
     */
    function scanAppLine(t, id) {
      var key = "support." + id + ".scan";
      var translated = t(key);
      return translated && translated !== key ? translated : t("support.qrHint");
    }

    /**
     * The plugin's own settings form, shown on its row in the Plugins page.
     *
     * The app's slot contract says the configuration of one row is keyed by
     * `<package name>#<row id>`, and that a form registered there provides its
     * own copy, its own current value and its own write path. So this reads and
     * writes the host half's `/config` endpoint directly rather than going
     * through the settings domain — the values are the plugin's own.
     *
     * Registering with `locale: NS` is what makes `t` arrive as a prop: the
     * renderer installs a translate seat per outlet, and the outlet re-renders
     * on every locale revision, so the whole form follows a language switch.
     *
     * @param React - React, as the module loader supplies it.
     */
    function settingsForm(React) {
      var CONFIG = BASE + "/config";
      var DEVICE_PATH = BASE + "/device.svg";

      /**
       * The form's look, in one place.
       *
       * The hierarchy is carried by three things and nothing else: a rule above
       * each *section* title, more space above a section than inside it, and one
       * dim ink for every explanatory line. Rows inside a section deliberately
       * have no separators — the last version ruled every field, which made
       * eleven equal-looking rows and no visible grouping.
       */
      var TERTIARY = "var(--dsw-alias-label-tertiary, #8a8a8a)";
      var RULE = "0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))";
      var PAD_BG = "var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.08))";
      var introStyle = { fontSize: "12px", lineHeight: "19px", color: TERTIARY };
      var sectionStyle = { paddingTop: "16px", marginTop: "14px", borderTop: RULE };
      var sectionTitleStyle = { fontSize: "13px", fontWeight: 700, letterSpacing: "0.2px" };
      var sectionDescStyle = { fontSize: "12px", lineHeight: "18px", color: TERTIARY, marginTop: "2px" };
      var rowStyle = { display: "flex", flexDirection: "column", gap: "4px", paddingTop: "8px" };
      var gridStyle = {
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 20px",
        alignItems: "flex-start",
      };
      var cellStyle = {
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        flex: "1 1 190px",
        minWidth: "168px",
        paddingTop: "8px",
      };
      var labelStyle = { fontSize: "13px", fontWeight: 600 };
      var hintStyle = { fontSize: "12px", lineHeight: "18px", color: TERTIARY };
      var captionStyle = { fontSize: "11px", lineHeight: "14px", color: TERTIARY };
      /** The live status line: a read-out, not a control, and it looks like one. */
      var readoutStyle = {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "11.5px",
        lineHeight: "17px",
        color: TERTIARY,
        background: PAD_BG,
        borderRadius: "6px",
        padding: "6px 8px",
        marginTop: "8px",
      };
      var controlStyle = {
        font: "inherit",
        fontSize: "13px",
        padding: "5px 8px",
        borderRadius: "6px",
        border: "0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
        background: "var(--dsw-alias-bg-module-platform, transparent)",
        color: "inherit",
        boxSizing: "border-box",
        width: "100%",
        maxWidth: "260px",
      };
      var disclosureStyle = {
        font: "inherit",
        fontSize: "12px",
        fontWeight: 600,
        padding: "0",
        border: "0",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
      };
      /** A weekday chip: on is the accent, off is the plain control. */
      var ACCENT = "var(--dsw-alias-brand-primary, #d9a441)";
      var WEEKDAY_ON = { background: ACCENT, color: "#101216", borderColor: ACCENT, fontWeight: 600 };
      var WEEKDAY_OFF = {};
      var buttonStyle = {
        font: "inherit",
        fontSize: "12px",
        padding: "4px 10px",
        borderRadius: "6px",
        border: "0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        alignSelf: "flex-start",
      };
      var ERROR_INK = { color: "var(--dsw-alias-state-error-primary, #d24a43)" };
      /** A support channel: the same button, but it is a link, not an action. */
      var DEVICES = ["whale", "hammer", "sword", "sun", "moon", "wolf", "custom"];
      var MATERIALS = ["bronze", "iron", "silver", "gold"];
      var SHAPES = ["round", "octagon"];
      /** How often the form re-reads the renderer's live burn number, ms. */
      var BURN_POLL_MS = 2000;

      /** A `HH:MM` clock time, as the host's tariff rule wants it. */
      var CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;

      /**
       * The preview board: four cells, one per theme × tariff window.
       *
       * The renderer builds the cells (`previewCells`) rather than this form, so
       * the form and `test/preview.mjs` cannot drift apart, and each cell already
       * carries the wrapper attributes the stylesheet needs — the metal stops
       * baked for that theme, the enamel for that device, and the gauge coloured
       * for that tariff window. The burn ring is in every cell, at the live ratio.
       *
       * @param device - device id.
       * @param shape - `round` | `octagon`.
       * @param material - metal id.
       * @param customMarkup - a just-uploaded device, when there is one.
       * @param gauge - 0..1 burn fraction to draw.
       * @returns four cells (dark first), or null when the renderer is not up.
       */
      function previewCells(device, shape, material, customMarkup, gauge) {
        var hud = window.__DSH_SOULS_HUD__;
        if (!hud || typeof hud.previewCells !== "function") return null;
        try {
          return hud.previewCells({
            device: device,
            shape: shape,
            material: material,
            custom: customMarkup,
            gauge: gauge,
            size: 48,
          });
        } catch (error) {
          return null;
        }
      }

      return function SettingsForm(props) {
        // The owner asks for one of two views on the same registration: a
        // one-liner inside a paragraph (`summary`) and the real form with its
        // save control (`page`). Rendering the form for both put the whole
        // editor — selects and all — inside the row's description line.
        var view = props && props.view === "summary" ? "summary" : "page";
        var t = function (key, params) {
          return translate(props, key, params);
        };
        var loaded = React.useState(null);
        var data = loaded[0];
        var setData = loaded[1];
        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var statusState = React.useState(null);
        var status = statusState[0];
        var setStatus = statusState[1];
        var uploadState = React.useState(null);
        var upload = uploadState[0];
        var setUpload = uploadState[1];
        // The sanitized upload, while the form is the thing that has it (the
        // renderer fetches the stored file for itself on its next poll).
        var markupState = React.useState(null);
        var customMarkup = markupState[0];
        var setCustomMarkup = markupState[1];
        var fileRef = React.useRef(null);
        // The live burn/tariff reading is read from the renderer rather than
        // fetched: it is already in the page, and asking the host again for a
        // number the badge is drawing would be a second source of truth.
        var burnState = React.useState(null);
        var live = burnState[0];
        var setLive = burnState[1];
        // ...and the same for the bars: the caps and the context mode read much
        // better next to what they are capping right now.
        var liveState = React.useState(null);
        var liveNow = liveState[0];
        var setLiveNow = liveState[1];
        // Whether the off-peak window is unfolded. `null` follows the
        // configuration; a real boolean is the user's own choice.
        //
        // This is declared *here*, with the other hooks, and not next to the
        // disclosure that uses it: there are two early returns below (the loading
        // placeholder and the row's summary view), and a hook after either of them
        // runs on some renders and not others — React answers that with
        // "Rendered more hooks than during the previous render" and the whole
        // configuration page renders blank. Found in the app, not by a test: the
        // shim in test/form.mjs did not enforce hook order, and now it does.
        var windowState = React.useState(null);
        var windowOpen = windowState[0];
        var setWindowOpen = windowState[1];
        // The holiday calendar's refresh, and what it answered. Declared here for
        // the same reason as the disclosure above: a hook after an early return
        // blanks the whole page.
        var holidayState = React.useState(null);
        var holidayRefresh = holidayState[0];
        var setHolidayRefresh = holidayState[1];

        React.useEffect(function () {
          var alive = true;
          var read = function () {
            var hud = window.__DSH_SOULS_HUD__;
            var value = hud && typeof hud.burnReading === "function" ? hud.burnReading() : null;
            if (!alive) return;
            setLive(value);
            var reading = hud && typeof hud.liveReading === "function" ? hud.liveReading() : null;
            if (alive) setLiveNow(reading);
          };
          read();
          var timer = setInterval(read, BURN_POLL_MS);
          return function () {
            alive = false;
            clearInterval(timer);
          };
        }, []);

        React.useEffect(function () {
          var live = true;
          fetch(CONFIG, { credentials: "same-origin", cache: "no-store" })
            .then(function (response) {
              return response.ok ? response.json() : null;
            })
            .then(function (payload) {
              if (live && payload) setData(payload);
              return payload;
            })
            .then(function (payload) {
              // A stored device has to be read back to be previewed, and the
              // renderer only hands out the sanitizer — the bytes come from the
              // host's own route, so the preview is of the real thing.
              if (!live || !payload || !payload.config || !payload.config.customDevice) return;
              if (!payload.config.customDevice.present) return;
              return fetch(DEVICE_PATH, { credentials: "same-origin", cache: "no-store" })
                .then(function (response) {
                  return response.ok ? response.text() : "";
                })
                .then(function (text) {
                  var hud = window.__DSH_SOULS_HUD__;
                  if (!live || !text || !hud || typeof hud.inspectUpload !== "function") return;
                  var inspected = hud.inspectUpload(text);
                  if (inspected) setCustomMarkup(inspected);
                });
            })
            .catch(function () {
              /* leave the form blank rather than inventing values */
            });
          return function () {
            live = false;
          };
        }, []);

        /** Re-read the effective configuration after a write. */
        function save(patch) {
          setBusy(true);
          setStatus(null);
          return fetch(CONFIG, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          })
            .then(function (response) {
              return response.ok ? response.json() : null;
            })
            .then(function (payload) {
              if (payload) setData({ config: payload.config, overrides: payload.overrides });
              setStatus(payload ? "saved" : "failed");
              // The renderer's own poll is up to 15 seconds away; a preference
              // that takes that long to appear reads as a broken switch.
              var hud = window.__DSH_SOULS_HUD__;
              if (payload && hud && typeof hud.refresh === "function") {
                try {
                  hud.refresh();
                } catch (error) {
                  /* an impatient refresh must never break the save */
                }
              }
              return payload;
            })
            .catch(function () {
              setStatus("failed");
              return null;
            })
            .then(function (payload) {
              setBusy(false);
              return payload;
            });
        }

        /** Read the picked file, normalize it, store it, then select it. */
        function uploadFile(file) {
          if (!file) return;
          setUpload({ state: "busy" });
          file
            .text()
            .then(function (text) {
              var normalized = normalizeUpload(text);
              if (!normalized.ok) {
                setUpload({ state: "error", reason: normalized.reason });
                return null;
              }
              return fetch(DEVICE_PATH, {
                method: "POST",
                credentials: "same-origin",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ svg: normalized.svg }),
              })
                .then(function (response) {
                  return response.ok ? response.json() : null;
                })
                .then(function (payload) {
                  if (!payload || !payload.ok) {
                    setUpload({ state: "error", reason: (payload && payload.reason) || "generic" });
                    return null;
                  }
                  setCustomMarkup(normalized.preview);
                  setUpload({ state: "ready", bytes: payload.bytes });
                  return save({ device: "custom" });
                });
            })
            .catch(function () {
              setUpload({ state: "error", reason: "read-failed" });
            });
        }

        /** Remove the stored upload and fall back to the built-in whale. */
        function removeUpload() {
          setUpload({ state: "busy" });
          fetch(DEVICE_PATH, { method: "DELETE", credentials: "same-origin" })
            .then(function (response) {
              return response.ok;
            })
            .catch(function () {
              return false;
            })
            .then(function (ok) {
              setCustomMarkup(null);
              setUpload(ok ? null : { state: "error", reason: "generic" });
              if (ok) return save({ device: "whale" });
              return null;
            });
        }

        // Every hook above runs unconditionally; only the render branches.
        if (!data) return React.createElement("span", { style: hintStyle }, "…");

        var config = data.config || {};
        var device = DEVICES.indexOf(config.device) === -1 ? "whale" : config.device;
        var material = MATERIALS.indexOf(config.material) === -1 ? "bronze" : config.material;
        var shape = SHAPES.indexOf(config.shape) === -1 ? "round" : config.shape;

        if (view === "summary") {
          // The row's one-liner: what the badge *is* first, then the readings.
          return React.createElement(
            "span",
            { style: hintStyle },
            t("summary.line", {
              badge:
                t("shape." + shape) + " · " + t("material." + material) + " · " + t("device." + device),
              hp: config.hpTargetCny,
              fp: config.fpTargetCny,
              numbers: t("value.numbers." + config.numbers),
              stamina: t("value.stamina." + config.staminaMode),
            }),
          );
        }

        // --- layout primitives ------------------------------------------------
        //
        // The page reads top-down as: what you are editing (preview), then the
        // three groups of things you can change it with, ordered by how often they
        // are touched — the badge's look, the bars' readings, and the burn ring's
        // calibration. Each group says what it is for in one line, and the
        // technical end of the ring (its window) is folded away.
        var section = function (title, description, node, key) {
          return React.createElement(
            "section",
            { key: key || title, style: sectionStyle },
            React.createElement("div", { style: sectionTitleStyle }, title),
            description ? React.createElement("div", { style: sectionDescStyle }, description) : null,
            node,
          );
        };
        /**
         * A line of smaller text, or nothing at all.
         *
         * The trimmed copy is the point: a setting whose meaning is already on its
         * label carries no hint, and an empty one would only add a gap.
         *
         * @param text - the already-translated text.
         * @param key - React key.
         * @returns the element, or null.
         */
        var hintLine = function (text, key) {
          return text ? React.createElement("div", { style: hintStyle, key: key }, text) : null;
        };
        var field = function (label, hint, control, key) {
          return React.createElement(
            "div",
            { style: rowStyle, key: key || label },
            React.createElement("div", { style: labelStyle }, label),
            hint ? React.createElement("div", { style: hintStyle }, hint) : null,
            control,
          );
        };
        /**
         * One cell of a two-up row: short controls sit side by side.
         *
         * The control is pushed to the bottom of the cell, so two neighbours line
         * up even when one hint wraps a line more than the other — which is the
         * whole point of putting them side by side.
         */
        var cell = function (label, hint, control, key) {
          return React.createElement(
            "div",
            { style: cellStyle, key: key || label },
            React.createElement("div", { style: labelStyle }, label),
            hint ? React.createElement("div", { style: hintStyle }, hint) : null,
            React.createElement("div", { style: { marginTop: "auto", paddingTop: "2px" } }, control),
          );
        };
        /** Two-up row; wraps to one column on a narrow page. */
        var grid = function (children) {
          return React.createElement("div", { style: gridStyle }, children);
        };
        /** A live read-out: monospaced, dim, never a control. */
        var readout = function (text, key) {
          return React.createElement("div", { style: readoutStyle, key: key || text }, text);
        };
        var select = function (value, options, onChange) {
          return React.createElement(
            "select",
            {
              style: controlStyle,
              value: value,
              disabled: busy,
              onChange: function (event) {
                onChange(event.target.value);
              },
            },
            options.map(function (option) {
              return React.createElement(
                "option",
                { key: option.value, value: option.value },
                option.label,
              );
            }),
          );
        };
        /**
         * One boolean, as a checkbox that writes on change.
         * @param value - the current value.
         * @param onChange - called with the next value.
         * @returns the input element.
         */
        var checkbox = function (value, onChange) {
          return React.createElement("input", {
            type: "checkbox",
            checked: value !== false,
            disabled: busy,
            style: { width: "16px", height: "16px", accentColor: "auto" },
            onChange: function (event) {
              onChange(event.target.checked);
            },
          });
        };
        /** A checkbox and its label, so the label is part of the hit target. */
        var toggle = function (label, value, onChange, key) {
          return React.createElement(
            "label",
            {
              key: key || label,
              style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" },
            },
            checkbox(value, onChange),
            React.createElement("span", { style: labelStyle }, label),
          );
        };
        /**
         * One `HH:MM` clock time, with the caller deciding what to do with it.
         *
         * The peak windows are a *list*, so a change is not "key = value" but "the
         * list with this one entry replaced" — which `clockInput` cannot express.
         *
         * @param key - the React key.
         * @param value - the current clock.
         * @param onChange - called with a readable clock.
         * @returns the input element.
         */
        var clockInputAt = function (key, value, onChange) {
          return React.createElement("input", {
            key: key,
            style: Object.assign({}, controlStyle, { maxWidth: "90px" }),
            type: "text",
            inputMode: "numeric",
            placeholder: "HH:MM",
            defaultValue: String(value || ""),
            disabled: busy,
            onKeyDown: function (event) {
              if (event.key === "Enter") event.target.blur();
            },
            onBlur: function (event) {
              var next = String(event.target.value).trim();
              if (!CLOCK.test(next) || next === value) return;
              onChange(next);
            },
          });
        };
        /**
         * A list of dates, one per line. Written on blur, and only when the text
         * actually changed — the host refuses junk, and a silent revert is worse
         * than the text staying put.
         *
         * @param key - the setting key.
         * @param value - the current dates.
         * @returns the textarea element.
         */
        var textArea = function (key, value) {
          var text = (Array.isArray(value) ? value : []).join("\n");
          return React.createElement("textarea", {
            key: key,
            style: Object.assign({}, controlStyle, {
              minHeight: "72px",
              fontFamily: "ui-monospace, Menlo, monospace",
              lineHeight: "18px",
            }),
            spellCheck: false,
            defaultValue: text,
            disabled: busy,
            placeholder: "2026-10-01",
            onBlur: function (event) {
              var next = String(event.target.value);
              if (next === text) return;
              var patch = {};
              patch[key] = next;
              save(patch);
            },
          });
        };
        /**
         * One positive number, written on blur or Enter — a CNY cap or the ring's
         * full scale. Both are "the amount at which the bar/ring is full", so they
         * share one control rather than two lookalikes.
         *
         * @param key - the setting key.
         * @param value - the current value.
         * @param options - `{ maxWidth, step }`.
         * @returns the input element.
         */
        var numberInput = function (key, value, options) {
          var extra = options || {};
          return React.createElement("input", {
            style: Object.assign({}, controlStyle, { maxWidth: extra.maxWidth || "140px" }),
            type: "number",
            min: "1",
            step: String(extra.step || 1),
            defaultValue: String(value),
            disabled: busy,
            onKeyDown: function (event) {
              if (event.key === "Enter") event.target.blur();
            },
            onBlur: function (event) {
              var next = Number(event.target.value);
              if (Number.isFinite(next) && next > 0 && next !== value) {
                var patch = {};
                patch[key] = next;
                save(patch);
              }
            },
          });
        };

        var uploadNote = (function () {
          if (!upload) {
            return config.customDevice && config.customDevice.present
              ? t("upload.stored", { kb: Math.max(1, Math.round(config.customDevice.bytes / 1024)) })
              : t("upload.none");
          }
          if (upload.state === "busy") return t("upload.busy");
          if (upload.state === "ready") return t("upload.saved");
          return t("upload.error." + upload.reason, { reason: upload.reason });
        })();
        var uploadFailed = Boolean(upload && upload.state === "error");
        var storedUpload = Boolean(config.customDevice && config.customDevice.present);
        // The upload belongs to "Custom": show it when that is the figure in use,
        // or when there is a stored file to replace or delete, or when somebody
        // just picked Custom and needs to be told what to do next.
        var showUpload = device === "custom" || storedUpload || uploadFailed;

        var fileInput = React.createElement("input", {
          ref: fileRef,
          type: "file",
          accept: ".svg,image/svg+xml",
          style: { display: "none" },
          onChange: function (event) {
            var file = event.target.files && event.target.files[0];
            event.target.value = "";
            uploadFile(file);
          },
        });

        // --- live read-outs ---------------------------------------------------
        /** Money, as the bars print it. */
        var money = function (value) {
          return (Math.round((Number(value) || 0) * 100) / 100).toFixed(2);
        };
        /** A rate, short enough to sit in a sentence: 1240 -> 1.2k. */
        var rate = function (value) {
          var number = Number(value);
          if (!Number.isFinite(number) || number <= 0) return "0";
          if (number >= 1e6) return (number / 1e6).toFixed(1) + "M";
          if (number >= 1e3) return (number / 1e3).toFixed(1) + "k";
          return String(Math.round(number));
        };
        var balance = liveNow && liveNow.balance;
        var context = liveNow && liveNow.context;
        var barsNow =
          balance && balance.available
            ? t("bars.now", {
                recharge: money(balance.recharge),
                bonus: money(balance.bonus),
                percent: context && context.available ? context.percent : "—",
                free: context && context.available ? context.freePercent : "—",
              })
            : t("bars.nowUnavailable", {
                reason: t("balance." + ((balance && balance.reason) === "signed-out" ? "signedOut" : "unavailable")),
              });
        var tariffValue = live && live.tariff === "peak" ? "peak" : live && live.tariff === "offpeak" ? "offpeak" : "off";
        var burnNow = live
          ? t("burn.now", {
              rate: typeof live.tokensPerMin === "number" ? t("burn.rate", { value: rate(live.tokensPerMin) }) : t("burn.warming"),
              output: t("burn.output", { value: rate(live.outputTokensPerMin) }),
              cache: t("burn.cache", { value: rate(live.cacheTokensPerMin) }),
              tariff: t("tariff." + tariffValue),
            })
          : t("burn.unavailable");

        // --- the tariff rule, as the form edits it ---------------------------

        /** The published rule, so the form can tell "default" from "changed". */
        var PUBLISHED_WINDOWS = [
          { start: "01:00", end: "04:00" },
          { start: "06:00", end: "10:00" },
        ];
        var PUBLISHED_WEEKDAYS = [1, 2, 3, 4, 5];
        var windows =
          Array.isArray(config.tariffPeakWindows) && config.tariffPeakWindows.length > 0
            ? config.tariffPeakWindows
            : PUBLISHED_WINDOWS;
        var weekdays =
          Array.isArray(config.tariffPeakWeekdays) && config.tariffPeakWeekdays.length > 0
            ? config.tariffPeakWeekdays
            : PUBLISHED_WEEKDAYS;

        /** Write the whole window list: the host validates it as a list. */
        var saveWindows = function (list) {
          save({ tariffPeakWindows: list });
        };
        /** `HH:MM` plus hours, wrapped — for a window that a new one continues from. */
        var addHours = function (clock, hours) {
          var parts = String(clock || "00:00").split(":");
          var total = (Number(parts[0]) * 60 + Number(parts[1]) + hours * 60) % 1440;
          if (!isFinite(total) || total < 0) total = 0;
          return (
            String(Math.floor(total / 60)).padStart(2, "0") +
            ":" +
            String(total % 60).padStart(2, "0")
          );
        };

        // What the badge is showing right now, and *why*: with two windows, a gap
        // between them and a holiday calendar, "peak" on its own is not an
        // explanation. The reason comes from the reading the renderer holds, which
        // is the same one it painted the badge from.
        var tariffDetail = (live && live.tariffDetail) || null;
        var stateLabel =
          tariffValue === "off" ? t("tariff.off") : t("tariff." + tariffValue);
        var whyLabel =
          tariffValue === "off" || !tariffDetail || !tariffDetail.reason
            ? ""
            : t("tariff.why." + tariffDetail.reason, {
                window: tariffDetail.window || "",
                name: tariffDetail.holidayName || "",
                date: tariffDetail.holidayDate || "",
              });
        var nextLabel = "";
        if (tariffValue !== "off" && tariffDetail && typeof tariffDetail.nextChangeAt === "number") {
          var minutesLeft = Math.max(0, Math.round((tariffDetail.nextChangeAt - Date.now()) / 60000));
          var hoursLeft = Math.floor(minutesLeft / 60);
          nextLabel = t("tariff.next", {
            when: hoursLeft > 0 ? t("tariff.hoursMinutes", { hours: hoursLeft, minutes: minutesLeft % 60 }) : t("tariff.minutes", { minutes: minutesLeft }),
            state: t(tariffDetail.nextChangePeak ? "tariff.peak" : "tariff.offpeak"),
          });
        }
        var tariffNow = t("tariff.now", {
          clock: tariffDetail && tariffDetail.utcClock ? tariffDetail.utcClock : "--:--",
          state: stateLabel,
          why: whyLabel,
          next: nextLabel,
        });

        // The calendar: where it came from, what it covers, and one button that
        // reaches upstream. A stale calendar would quietly call a holiday a
        // working day, so it says so instead.
        var holidayInfo = config.holidays || {};
        var holidayCheckedNote = holidayInfo.checkedAt
          ? t("tariff.checked", { when: String(holidayInfo.checkedAt).slice(0, 10) })
          : "";
        var holidayNote = t("tariff.holidayData", {
          years: (holidayInfo.years || []).join(", "),
          date: holidayInfo.generated || t("tariff.holidayUnknown"),
        });
        var holidayStaleNote = holidayInfo.stale
          ? t("tariff.holidayStale", { year: holidayInfo.current })
          : t("tariff.holidayFresh");
        var holidayResult =
          holidayRefresh === "ok"
            ? t("tariff.refreshed")
            : holidayRefresh === "failed"
              ? t("tariff.refreshFailed")
              : holidayRefresh === "busy"
                ? t("tariff.refreshing")
                : "";
        var refreshCalendar = function () {
          setHolidayRefresh("busy");
          fetch(BASE + "/holidays.json", { method: "POST", credentials: "same-origin" })
            .then(function (response) {
              return response.ok ? response.json() : null;
            })
            .then(function (payload) {
              setHolidayRefresh(payload && payload.ok ? "ok" : "failed");
              // The status rides on the config, so re-read it rather than guess.
              return fetch(CONFIG, { credentials: "same-origin" })
                .then(function (response) {
                  return response.ok ? response.json() : null;
                })
                .then(function (next) {
                  if (next) setData({ config: next.config, overrides: next.overrides });
                });
            })
            .catch(function () {
              setHolidayRefresh("failed");
            });
        };
        var autoOn = config.tariffAutoRefresh !== false;
        var holidayPanel = React.createElement(
          "div",
          { style: { paddingTop: "6px" } },
          React.createElement(
            "div",
            { style: rowStyle },
            toggle(t("tariff.auto"), autoOn, function (value) {
              save({ tariffAutoRefresh: value });
            }, "tariff-auto"),
            hintLine(t("tariff.autoHint")),
          ),
          React.createElement("div", { style: Object.assign({}, hintStyle, { paddingTop: "6px" }) }, holidayNote),
          React.createElement("div", { style: hintStyle }, holidayCheckedNote),
          React.createElement(
            "div",
            { style: Object.assign({}, hintStyle, holidayInfo.stale ? ERROR_INK : null) },
            holidayStaleNote,
          ),
          holidayInfo.lastError
            ? React.createElement(
                "div",
                { style: Object.assign({}, hintStyle, ERROR_INK) },
                t("tariff.lastError", { error: holidayInfo.lastError }),
              )
            : null,
          // The button stays, but it is a fallback: the switch above is how this
          // normally stays current.
          React.createElement(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "8px", paddingTop: "4px" } },
            React.createElement(
              "button",
              {
                type: "button",
                style: buttonStyle,
                disabled: busy || holidayRefresh === "busy",
                onClick: refreshCalendar,
              },
              holidayRefresh === "busy" ? t("tariff.refreshing") : t("tariff.refresh"),
            ),
            holidayResult ? React.createElement("span", { style: hintStyle }, holidayResult) : null,
          ),
        );

        // A rule that is not the published one opens itself: then it is something
        // the user set deliberately, and hiding it would hide their own change.
        var windowIsCustom =
          JSON.stringify(windows) !== JSON.stringify(PUBLISHED_WINDOWS) ||
          JSON.stringify(weekdays) !== JSON.stringify(PUBLISHED_WEEKDAYS) ||
          (config.tariffHolidayMode || "cn") !== "cn";
        var showWindow = windowOpen === null ? windowIsCustom : windowOpen;

        // Every cell draws the ring at the same **sample** fill.
        //
        // It used to draw the live reading, which is a bad preview twice over: a
        // busy session pegs the ring at 100% (so it shows nothing about the
        // gauge), and an idle one leaves it empty (so it shows even less). 60% is
        // the fill that shows the most — length, colour, the lit edge — and the
        // live value is printed under the board instead, where a number belongs.
        var SAMPLE_GAUGE = 0.6;
        var gaugeRatio = SAMPLE_GAUGE;
        var cells = previewCells(device, shape, material, customMarkup, gaugeRatio);
        var gaugeNote =
          t("preview.gaugeSample", { percent: Math.round(gaugeRatio * 100) }) +
          " " +
          (live && live.available
            ? t("preview.gaugeLive", { value: rate(live.tokensPerMin) })
            : t("preview.noReading"));
        var preview = cells
          ? React.createElement(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "6px" } },
              React.createElement(
                "div",
                { style: { display: "flex", gap: "14px", flexWrap: "wrap" } },
                cells.map(function (item) {
                  return React.createElement(
                    "div",
                    {
                      key: (item.dark ? "dark" : "light") + "-" + item.tariff,
                      style: {
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: "4px",
                      },
                    },
                    React.createElement("span", {
                      // The cell's own markup, from the renderer: the whole
                      // medallion, already painted for this theme and tariff.
                      dangerouslySetInnerHTML: { __html: item.html },
                    }),
                    React.createElement(
                      "span",
                      { style: captionStyle },
                      t("preview.caption", {
                        theme: t(item.dark ? "preview.dark" : "preview.light"),
                        tariff: t(item.tariff === "peak" ? "preview.peak" : "preview.offpeak"),
                      }),
                    ),
                  );
                }),
              ),
              React.createElement("div", { style: hintStyle }, gaugeNote),
            )
          : React.createElement("div", { style: hintStyle }, t("preview.unavailable"));

        return React.createElement(
          "div",
          { style: { paddingTop: "2px" } },

          React.createElement("div", { style: introStyle }, t("page.intro")),
          React.createElement(
            "div",
            { style: Object.assign({}, introStyle, { paddingTop: "2px" }) },
            t("page.free"),
          ),

          // 1. What you are editing.
          section(
            t("section.preview"),
            t("section.previewHint"),
            React.createElement(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "6px", paddingTop: "6px" } },
              preview,
              hintLine(t("preview.themeNote")),
            ),
            "preview",
          ),

          // 2. The badge: outline, metal, figure.
          section(
            t("section.badge"),
            t("section.badgeHint"),
            React.createElement(
              "div",
              null,
              grid([
                cell(
                  t("shape.label"),
                  t("shape.hint"),
                  select(
                    shape,
                    SHAPES.map(function (id) {
                      return { value: id, label: t("shape." + id) };
                    }),
                    function (value) {
                      save({ shape: value });
                    },
                  ),
                  "shape",
                ),
                cell(
                  t("material.label"),
                  t("material.hint"),
                  select(
                    material,
                    MATERIALS.map(function (id) {
                      return { value: id, label: t("material." + id) };
                    }),
                    function (value) {
                      save({ material: value });
                    },
                  ),
                  "material",
                ),
              ]),
              field(
                t("device.label"),
                t("device.hint"),
                select(
                  device,
                  DEVICES.map(function (id) {
                    return { value: id, label: t("device." + id) };
                  }),
                  function (value) {
                    if (value === "custom" && !storedUpload) {
                      // Nothing uploaded yet: selecting it would show the built-in
                      // mark under a "custom" label, so the picker stays on what is
                      // actually drawn and the upload row opens to say why.
                      setUpload({ state: "error", reason: "no-file" });
                      return;
                    }
                    save({ device: value });
                  },
                ),
                "device",
              ),
              showUpload
                ? field(
                    t("upload.label"),
                    t("upload.hint"),
                    React.createElement(
                      "div",
                      { style: { display: "flex", flexDirection: "column", gap: "8px" } },
                      fileInput,
                      React.createElement(
                        "div",
                        { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
                        React.createElement(
                          "button",
                          {
                            type: "button",
                            style: buttonStyle,
                            disabled: busy,
                            onClick: function () {
                              if (fileRef.current) fileRef.current.click();
                            },
                          },
                          storedUpload ? t("upload.replace") : t("upload.choose"),
                        ),
                        storedUpload
                          ? React.createElement(
                              "button",
                              {
                                type: "button",
                                style: buttonStyle,
                                disabled: busy,
                                onClick: removeUpload,
                              },
                              t("upload.remove"),
                            )
                          : null,
                      ),
                      React.createElement(
                        "div",
                        { style: uploadFailed ? Object.assign({}, hintStyle, ERROR_INK) : hintStyle },
                        uploadNote,
                      ),
                    ),
                    "upload",
                  )
                : null,
            ),
            "badge",
          ),

          // 3. The bars, each with what it is reading right now.
          section(
            t("section.bars"),
            t("section.barsHint"),
            React.createElement(
              "div",
              null,
              readout(barsNow, "bars-now"),
              grid([
                cell(
                  t("bars.hp.label"),
                  t("bars.hp.hint", { cap: money(config.hpTargetCny), now: balance && balance.available ? money(balance.recharge) : "—" }),
                  numberInput("hpTargetCny", config.hpTargetCny, { maxWidth: "120px" }),
                  "hp",
                ),
                cell(
                  t("bars.fp.label"),
                  t("bars.fp.hint", { cap: money(config.fpTargetCny), now: balance && balance.available ? money(balance.bonus) : "—" }),
                  numberInput("fpTargetCny", config.fpTargetCny, { maxWidth: "120px" }),
                  "fp",
                ),
              ]),
              grid([
                cell(
                  t("bars.numbers.label"),
                  t("bars.numbers.hint"),
                  select(
                    config.numbers,
                    [
                      { value: "always", label: t("numbers.always") },
                      { value: "hover", label: t("numbers.hover") },
                      { value: "hidden", label: t("numbers.hidden") },
                    ],
                    function (value) {
                      save({ numbers: value });
                    },
                  ),
                  "numbers",
                ),
                cell(
                  t("bars.stamina.label"),
                  t("bars.stamina.hint", {
                    percent: context && context.available ? context.percent : "—",
                  }),
                  select(
                    config.staminaMode,
                    [
                      { value: "remaining", label: t("stamina.remaining") },
                      { value: "used", label: t("stamina.used") },
                    ],
                    function (value) {
                      save({ staminaMode: value });
                    },
                  ),
                  "stamina",
                ),
              ]),
            ),
            "bars",
          ),

          // 4. The ring: what it measures, and the one part of its colour rule
          //    that is worth configuring.
          section(
            t("section.burn"),
            t("section.burnHint"),
            React.createElement(
              "div",
              null,
              readout(burnNow, "burn-now"),
              field(
                t("burn.scale.label"),
                t("burn.scale.hint", {
                  rate: typeof live.tokensPerMin === "number" ? t("burn.rate", { value: rate(live.tokensPerMin) }) : t("burn.warming"),
                }),
                React.createElement(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: "8px" } },
                  numberInput("burnFullScaleTpm", config.burnFullScaleTpm, { maxWidth: "120px", step: 500 }),
                  React.createElement("span", { style: hintStyle }, t("burn.scale.unit")),
                ),
                "burn-scale",
              ),
              // The tariff rule: DeepSeek's published peak hours, and the fact
              // that off-peak is *half* the peak rate. Every part of it is a
              // setting, because the prices are not this plugin's to decide.
              React.createElement(
                "div",
                { style: rowStyle, key: "tariff-toggle" },
                toggle(t("tariff.enabled"), config.tariffEnabled, function (value) {
                  save({ tariffEnabled: value });
                }, "tariff-enabled"),
                hintLine(t("tariff.enabledHint")),
              ),
              readout(tariffNow, "tariff-now"),
              hintLine(t("tariff.half")),
              React.createElement(
                "div",
                { style: { paddingTop: "6px" } },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    style: disclosureStyle,
                    disabled: busy,
                    onClick: function () {
                      setWindowOpen(!showWindow);
                    },
                  },
                  (showWindow ? "\u25be " : "\u25b8 ") + t("burn.advanced"),
                ),
                hintLine(t("burn.advancedHint")),
                showWindow
                  ? React.createElement(
                      "div",
                      null,
                      // The peak windows. Two of them by default, and the gap
                      // between them is off-peak — which is the part a single
                      // "off-peak window" cannot say.
                      React.createElement(
                        "div",
                        { style: Object.assign({}, labelStyle, { paddingTop: "10px" }) },
                        t("tariff.windows"),
                      ),
                      hintLine(t("tariff.windowsHint")),
                      windows.map(function (window, index) {
                        return React.createElement(
                          "div",
                          {
                            key: "tariff-window-" + index,
                            style: { display: "flex", alignItems: "flex-end", gap: "8px", paddingTop: "6px" },
                          },
                          clockInputAt("tariff-window-" + index + "-start", window.start, function (value) {
                            saveWindows(
                              windows.map(function (item, at) {
                                return at === index ? { start: value, end: item.end } : item;
                              }),
                            );
                          }),
                          React.createElement("span", { style: hintStyle }, "\u2013"),
                          clockInputAt("tariff-window-" + index + "-end", window.end, function (value) {
                            saveWindows(
                              windows.map(function (item, at) {
                                return at === index ? { start: item.start, end: value } : item;
                              }),
                            );
                          }),
                          React.createElement("span", { style: hintStyle }, "UTC"),
                          windows.length > 1
                            ? React.createElement(
                                "button",
                                {
                                  type: "button",
                                  style: buttonStyle,
                                  disabled: busy,
                                  onClick: function () {
                                    saveWindows(
                                      windows.filter(function (item, at) {
                                        return at !== index;
                                      }),
                                    );
                                  },
                                },
                                t("tariff.windowRemove"),
                              )
                            : null,
                        );
                      }),
                      windows.length < 4
                        ? React.createElement(
                            "button",
                            {
                              type: "button",
                              style: Object.assign({}, buttonStyle, { marginTop: "6px" }),
                              disabled: busy,
                              onClick: function () {
                                var last = windows[windows.length - 1] || { start: "01:00", end: "04:00" };
                                saveWindows(
                                  windows.concat([{ start: last.end, end: addHours(last.end, 2) }]),
                                );
                              },
                            },
                            t("tariff.windowAdd"),
                          )
                        : null,

                      // Which weekdays count. The published rule is Monday
                      // through Friday, and a 调休 Sunday is a separate question.
                      React.createElement(
                        "div",
                        { style: Object.assign({}, labelStyle, { paddingTop: "12px" }) },
                        t("tariff.weekdays"),
                      ),
                      React.createElement(
                        "div",
                        { style: { display: "flex", gap: "4px", flexWrap: "wrap", paddingTop: "4px" } },
                        [1, 2, 3, 4, 5, 6, 0].map(function (day) {
                          var on = config.tariffPeakWeekdays.indexOf(day) !== -1;
                          return React.createElement(
                            "button",
                            {
                              key: "weekday-" + day,
                              type: "button",
                              disabled: busy,
                              "aria-pressed": on ? "true" : "false",
                              style: Object.assign({}, buttonStyle, on ? WEEKDAY_ON : WEEKDAY_OFF),
                              onClick: function () {
                                var next = on
                                  ? config.tariffPeakWeekdays.filter(function (item) {
                                      return item !== day;
                                    })
                                  : config.tariffPeakWeekdays.concat([day]);
                                save({ tariffPeakWeekdays: next });
                              },
                            },
                            t("weekday." + day),
                          );
                        }),
                      ),
                      hintLine(t("tariff.weekdaysHint")),

                      // The holiday calendar.
                      React.createElement(
                        "div",
                        { style: Object.assign({}, labelStyle, { paddingTop: "12px" }) },
                        t("tariff.holidayMode"),
                      ),
                      select(
                        config.tariffHolidayMode,
                        [
                          { value: "cn", label: t("tariff.holiday.cn") },
                          { value: "custom", label: t("tariff.holiday.custom") },
                          { value: "none", label: t("tariff.holiday.none") },
                        ],
                        function (value) {
                          save({ tariffHolidayMode: value });
                        },
                      ),
                      config.tariffHolidayMode === "cn" ? holidayPanel : null,
                      config.tariffHolidayMode === "custom"
                        ? React.createElement(
                            "div",
                            null,
                            field(
                              t("tariff.customHolidays"),
                              t("tariff.customHolidaysHint"),
                              textArea("tariffCustomHolidays", config.tariffCustomHolidays),
                              "tariff-custom-holidays",
                            ),
                            field(
                              t("tariff.customWorkdays"),
                              t("tariff.customWorkdaysHint"),
                              textArea("tariffCustomWorkdays", config.tariffCustomWorkdays),
                              "tariff-custom-workdays",
                            ),
                          )
                        : null,
                      React.createElement(
                        "div",
                        { style: { paddingTop: "8px" } },
                        toggle(t("tariff.makeup"), config.tariffMakeupWorkdays, function (value) {
                          save({ tariffMakeupWorkdays: value });
                        }, "tariff-makeup"),
                      ),
                      hintLine(t("tariff.makeupHint")),
                    )
                  : null,
              ),
            ),
            "burn",
          ),

          React.createElement(
            "div",
            { style: Object.assign({}, hintStyle, { minHeight: "18px", paddingTop: "10px" }) },
            busy ? t("status.saving") : status === "saved" ? t("status.saved") : status === "failed" ? t("status.failed") : "",
          ),
        );
      };
    }

    /**
     * Publish the way into this plugin's settings, for the renderer to call.
     *
     * `lib/hud.js` is a plain injected script: it has no Cordis context, so it
     * cannot reach `pluginNavigation` — the app's own API for "show me this
     * bundle's details", which is where this row's form is registered. The client
     * half can reach it, and this global is the bridge.
     *
     * Resolved at click time rather than at mount: the service may arrive later
     * than this plugin, and a badge that works after it does is better than one
     * that gave up at boot.
     *
     * @param ctx - the client Cordis context.
     */
    function publishNavigation(ctx) {
      if (!ctx) return;
      var service = null;
      /**
       * Take a resolved service.
       *
       * The app's own documentation says other client plugins *inject*
       * `pluginNavigation`, so that is what happens first: `ctx.inject` waits for the
       * service and hands over the real instance. `ctx.get` alone can produce a
       * placeholder whose methods quietly do nothing — which is indistinguishable
       * from the badge being broken, and is why `open()` now reports what happened.
       */
      var adopt = function (candidate, from) {
        if (candidate && typeof candidate.openBundle === "function") {
          if (service !== candidate && window.console && console.info) {
            console.info("[souls-hud] pluginNavigation ready (" + from + ")");
          }
          service = candidate;
        }
      };
      if (typeof ctx.inject === "function") {
        try {
          ctx.inject(["pluginNavigation"], function (navCtx) {
            adopt(
              (navCtx && navCtx.pluginNavigation) ||
                (navCtx && typeof navCtx.get === "function" ? navCtx.get("pluginNavigation") : null),
              "inject",
            );
          });
        } catch (error) {
          /* an older host: the lazy `ctx.get` below is the fallback */
        }
      }
      window.__DSH_SOULS_HUD_NAV__ = {
        open: function () {
          var nav =
            service || (typeof ctx.get === "function" ? ctx.get("pluginNavigation") : null);
          if (!nav || typeof nav.openBundle !== "function") {
            if (window.console && console.info) {
              console.info("[souls-hud] pluginNavigation is not available");
            }
            return false;
          }
          try {
            var result = nav.openBundle(NAV_TARGET);
            if (window.console && console.info) {
              console.info("[souls-hud] openBundle(" + NAV_TARGET + ")");
            }
            if (result && typeof result.then === "function") {
              result.then(null, function (error) {
                if (window.console && console.warn) {
                  console.warn("[souls-hud] openBundle rejected: " + error);
                }
              });
            }
            return true;
          } catch (error) {
            if (window.console && console.warn) {
              console.warn("[souls-hud] openBundle threw: " + error);
            }
            return false;
          }
        },
        /** Where the service came from, for one-line diagnosis in the console. */
        source: function () {
          return service ? "injected" : "unresolved";
        },
        /**
         * Open an arbitrary name, for trying candidates without a rebuild.
         *
         * The service takes a name and resolves it in its own store; when a name is
         * not in that store the panel simply shows the list, which tells us nothing
         * from inside the page. One line per candidate in the console settles it.
         *
         * @param name - the package or `<bundle>#<row>` id to try.
         * @returns whether a navigation service took the call.
         */
        trial: function (name) {
          var nav =
            service || (typeof ctx.get === "function" ? ctx.get("pluginNavigation") : null);
          if (!nav || typeof nav.openBundle !== "function") return false;
          nav.openBundle(String(name));
          if (window.console && console.info) {
            console.info("[souls-hud] openBundle(" + name + ")");
          }
          return true;
        },
      };
    }

    /**
     * The tip jar, as a surface of its own.
     *
     * It lives on the **bundle's** page — `plugins.detail.section` appears after a
     * bundle's rows, after a row's configuration and after an official plugin's form
     * alike — so it checks the subject it was handed and renders on BuilderHUD's page
     * and nowhere else. One level out from the skin's settings form, on purpose: how
     * to thank the author is a fact about the project rather than a setting of the
     * skin, and a 200 px payment code parked under a form of sliders was the loudest
     * thing on the page.
     *
     * Two buttons. Ko-fi is an ordinary link; WeChat unfolds its code in place with a
     * `<details>`, the same disclosure the tariff rule uses, because a payment code is
     * something you look at once. Both glyphs are drawn here rather than borrowed, the
     * same rule the medallion follows.
     *
     * @param React - React, as the module loader supplies it.
     * @returns the component.
     */
    function supportPanel(React) {
      var SUPPORT_BASE = BASE + "/support/";
      /**
       * How large a payment code is drawn, in CSS pixels.
       *
       * 132 was the first cut and it is too small to scan a decorative code: the
       * WeChat 赞赏码 is a dot ring, not a dense grid, and a phone needs it wider than
       * a grid QR would. The code is also a link to the file itself, so this is the
       * "sitting in front of the screen" size, not the only size.
       */
      var QR_SIZE = 200;

      var TERTIARY = "var(--dsw-alias-label-tertiary, #8a8a8a)";
      var RULE = "0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))";
      var sectionStyle = { paddingTop: "16px", marginTop: "14px", borderTop: RULE };
      var titleStyle = { fontSize: "13px", fontWeight: 700, letterSpacing: "0.2px" };
      var descStyle = { fontSize: "12px", lineHeight: "18px", color: TERTIARY, marginTop: "2px" };
      var captionStyle = { fontSize: "11px", lineHeight: "14px", color: TERTIARY };
      var buttonStyle = {
        font: "inherit",
        fontSize: "12px",
        padding: "5px 12px",
        borderRadius: "6px",
        border: "0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        textDecoration: "none",
        width: "fit-content",
      };
      var summaryStyle = Object.assign({}, buttonStyle, { listStyle: "none" });
      var iconStyle = { width: "14px", height: "14px", flex: "none" };

      /** A scan frame: the action, not another company's logo. */
      var scanIcon = function () {
        return React.createElement(
          "svg",
          {
            viewBox: "0 0 16 16",
            style: iconStyle,
            "aria-hidden": "true",
            focusable: "false",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: "1.4",
            strokeLinecap: "round",
          },
          React.createElement("path", { d: "M2.2 6V3.6c0-.8.6-1.4 1.4-1.4H6" }),
          React.createElement("path", { d: "M10 2.2h2.4c.8 0 1.4.6 1.4 1.4V6" }),
          React.createElement("path", { d: "M13.8 10v2.4c0 .8-.6 1.4-1.4 1.4H10" }),
          React.createElement("path", { d: "M6 13.8H3.6c-.8 0-1.4-.6-1.4-1.4V10" }),
          React.createElement("path", { d: "M5.4 8h5.2M5.4 10.4h2.6M10.6 10.4v2" }),
        );
      };

      /** A cup: what the service is called, not what its logo looks like. */
      var cupIcon = function () {
        return React.createElement(
          "svg",
          {
            viewBox: "0 0 16 16",
            style: iconStyle,
            "aria-hidden": "true",
            focusable: "false",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: "1.4",
            strokeLinecap: "round",
            strokeLinejoin: "round",
          },
          React.createElement("path", { d: "M2.6 6.2h8.2v4.1a2.6 2.6 0 0 1-2.6 2.6H5.2a2.6 2.6 0 0 1-2.6-2.6z" }),
          React.createElement("path", { d: "M10.8 7.2h1.1a1.7 1.7 0 0 1 0 3.4h-1.1" }),
          React.createElement("path", { d: "M5 2.4v1.4M7.6 2.2v1.6" }),
        );
      };

      return function SupportPanel(props) {
        var t = function (key, params) {
          return translate(props, key, params);
        };
        // A list slot is rendered on every detail page; this one belongs to the
        // bundle's page only, so the subject decides. No hooks above this line, so
        // returning early is safe.
        var subject = props && props.subject;
        if (!subject || subject.name !== NAV_TARGET) return null;
        var configured = (SUPPORT.channels || []).filter(function (channel) {
          if (!channel || !channel.id) return false;
          if (channel.kind === "link") return Boolean(channel.url);
          if (channel.kind === "qr") return Boolean(channel.file);
          return false;
        });
        if (configured.length === 0) return null;

        return React.createElement(
          "section",
          { style: sectionStyle, "data-dsh-support": "bundle" },
          React.createElement("div", { style: titleStyle }, t("section.support")),
          React.createElement("div", { style: descStyle }, t("section.supportHint")),
          React.createElement(
            "div",
            {
              style: {
                display: "flex",
                flexWrap: "wrap",
                // The WeChat button owns the unfolded code, so the row is as tall as
                // the code when it is open. `flex-start` keeps Ko-fi a button instead
                // of stretching it into a column beside the image.
                alignItems: "flex-start",
                gap: "8px",
                paddingTop: "10px",
              },
            },
            configured.map(function (channel) {
              if (channel.kind === "link") {
                return React.createElement(
                  "a",
                  {
                    key: channel.id,
                    href: channel.url,
                    target: "_blank",
                    rel: "noreferrer noopener",
                    style: buttonStyle,
                  },
                  channel.id === "kofi" ? cupIcon() : null,
                  t("support." + channel.id),
                );
              }
              var src = SUPPORT_BASE + channel.file;
              return React.createElement(
                "details",
                { key: channel.id, style: { margin: 0 } },
                React.createElement(
                  "summary",
                  { style: summaryStyle },
                  scanIcon(),
                  t("support." + channel.id),
                ),
                React.createElement(
                  "div",
                  {
                    style: {
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                      paddingTop: "10px",
                    },
                  },
                  React.createElement(
                    "a",
                    {
                      href: src,
                      target: "_blank",
                      rel: "noreferrer noopener",
                      title: t("support.qrOpen"),
                      style: { display: "block", lineHeight: "0", width: QR_SIZE + "px" },
                    },
                    React.createElement("img", {
                      src: src,
                      alt: t("support." + channel.id),
                      width: QR_SIZE,
                      height: QR_SIZE,
                      style: { display: "block", borderRadius: "6px", background: "#fff" },
                    }),
                  ),
                  React.createElement(
                    "div",
                    { style: captionStyle },
                    t("support." + channel.id) + " · " + scanAppLine(t, channel.id),
                  ),
                  React.createElement("div", { style: captionStyle }, t("support.qrOpen")),
                ),
              );
            }),
          ),
        );
      };
    }

    /**
     * Register this plugin's surfaces: the row's settings form, and the tip jar on
     * the bundle's page.
     *
     * @param ctx - the client Cordis context.
     * @param React - React, as the module loader supplies it.
     * @param locale - the app's locale service, or null when absent.
     */
    function registerSettings(ctx, React, locale) {
      // Before the slot check: the bridge is useful whether or not this app has a
      // row-config slot to register into.
      publishNavigation(ctx);
      if (!ctx || !ctx.slots) return;
      var hasLocale = Boolean(locale && typeof locale.bind === "function");
      var Form = settingsForm(React);
      ctx.effect(function () {
        return ctx.slots.inject("plugins.row.config", function () {
          var disposers = CONFIG_KEYS.map(function (key) {
            return ctx.slots.register(
              {
                name: "plugins.row.config",
                key: key,
                // `locale` is what makes the owner hand the component its `t`
                // seat. Declaring it without the locale face installed throws, so
                // an app without the locale plugin simply gets the plugin's own
                // table instead of a form that fails to render.
                ...(hasLocale ? { locale: NS } : {}),
              },
              Form,
            );
          });
          return function () {
            for (var i = 0; i < disposers.length; i += 1) {
              if (typeof disposers[i] === "function") disposers[i]();
            }
          };
        });
      });

      // The tip jar, one level out: the bundle's page rather than the row's form.
      // `plugins.detail.section` is a *list* slot — an id and an order, no key — and
      // the component filters itself by the subject it is handed.
      var Panel = supportPanel(React);
      ctx.effect(function () {
        return ctx.slots.inject("plugins.detail.section", function () {
          return ctx.slots.register(
            {
              name: "plugins.detail.section",
              id: "builder-hud-support",
              order: 100,
              label: function () {
                return translate(null, "section.support");
              },
              ...(hasLocale ? { locale: NS } : {}),
            },
            Panel,
          );
        });
      });
    }

    exports.name = name;
    exports.inject = ["slots"];
    exports.apply = apply;
    /** The upload normalizer, published so it can be driven without the form. */
    exports.normalizeUpload = normalizeUpload;
    return module.exports;
  },
});
