/**
 * Generate this bundle's card artwork — `icon.svg` — from the Souls Style renderer.
 *
 * The card's icon reaches the Plugins page as a base64 `data:` URI inside an
 * `<img src>`, so it is a **document of its own**: it must declare the SVG
 * namespace, and it cannot use `currentColor` or CSS custom properties, because
 * there is no page to inherit from. The live medallion leans on both.
 *
 * So the icon is the same drawing, flattened: the bronze/light palette is written
 * out as literal stop colours and the built-in whale is struck from the device
 * gradient. The geometry and the device paths are read out of `lib/hud.js` rather
 * than copied, so the card cannot drift away from the badge it advertises —
 * `test/harness.mjs` regenerates this and fails if the committed file differs.
 *
 * It lives beside the card it draws rather than beside the renderer, because the
 * artwork belongs to this package; the renderer is read out of its own package.
 *
 * Run: node test/icon.mjs
 *      node test/icon.mjs --check
 */

import { readFileSync, writeFileSync } from 'node:fs'

const hud = readFileSync(new URL('../../souls-hud/lib/hud.js', import.meta.url), 'utf8')

/**
 * The artboard the built-in figures are drawn on (`DEVICE_VIEWBOX`).
 *
 * It is a string literal in the renderer rather than a number, because the
 * artwork was authored in an editor at that size; the icon has to fit the same box
 * the badge fits, or the card advertises a whale the badge does not draw.
 */
const ARTBOARD = (() => {
  const found = /var DEVICE_VIEWBOX = '([^']+)'/.exec(hud)
  if (!found) throw new Error('icon: lib/hud.js no longer declares DEVICE_VIEWBOX')
  return found[1]
})()

/**
 * Mirror of the renderer's `fitDevice`: scale `32 / max(w, h)`, then centre the
 * artboard on the medal's field.
 *
 * Five lines duplicated from `hud.js` because this script runs without a DOM and
 * `fitDevice` lives inside the renderer's IIFE. `test/devices.mjs` carries the
 * same mirror; the badge is the thing that proves all three agree.
 *
 * @param artboard - the figure's `viewBox`.
 * @param inner - its markup.
 * @returns the markup wrapped in the transform.
 */
function fit(artboard, inner) {
  const parts = String(artboard).trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return inner
  const [, , width, height] = parts
  const scale = 32 / Math.max(width, height)
  const tx = 8 + (32 - width * scale) / 2 - parts[0] * scale
  const ty = 8 + (32 - height * scale) / 2 - parts[1] * scale
  return `<g transform="translate(${tx},${ty}) scale(${scale})">${inner}</g>`
}

/**
 * Take one `var NAME = <literal>;` array out of the renderer's source.
 * @param name - the variable name.
 * @returns the parsed literal.
 */
function arrayLiteral(name) {
  const match = new RegExp(`var ${name} = (\\[[\\s\\S]*?\\]);`).exec(hud)
  if (!match) throw new Error(`icon: lib/hud.js no longer declares ${name}`)
  return new Function(`return ${match[1]}`)()
}

/**
 * Take one `var NAME = { … };` object out of the renderer's source, by brace
 * matching — the same trick {@link deviceTable} uses, and for the same reason:
 * the frame's geometry has to have exactly one definition.
 */
function objectLiteral(declaration) {
  const start = hud.indexOf(declaration)
  if (start === -1) throw new Error(`icon: lib/hud.js no longer declares ${declaration}`)
  let depth = 0
  for (let i = hud.indexOf('{', start); i < hud.length; i += 1) {
    if (hud[i] === '{') depth += 1
    else if (hud[i] === '}') {
      depth -= 1
      if (depth === 0) return new Function(`return ${hud.slice(hud.indexOf('{', start), i + 1)}`)()
    }
  }
  throw new Error(`icon: ${declaration} is not balanced`)
}

/**
 * Take the device table out of the renderer.
 *
 * It is a self-contained object literal of string-building closures, so a
 * `new Function` around the exact source is enough — and if its shape ever
 * changes, the `instanceof Function` check below fails loudly instead of
 * quietly producing an icon with no device in it.
 */
function deviceTable() {
  const start = hud.indexOf('var DEVICE_MARKUP = {')
  if (start === -1) throw new Error('icon: lib/hud.js no longer declares DEVICE_MARKUP')
  let depth = 0
  let end = -1
  for (let i = hud.indexOf('{', start); i < hud.length; i += 1) {
    const character = hud[i]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) throw new Error('icon: DEVICE_MARKUP is not balanced')
  const table = new Function(`${hud.slice(start, end + 1)}\nreturn DEVICE_MARKUP;`)()
  if (!table || typeof table.whale !== 'function') {
    throw new Error('icon: DEVICE_MARKUP has no whale motif')
  }
  return table
}

const geometry = objectLiteral('var MEDALLION_GEOMETRY = ')
const round = geometry.round
const devices = deviceTable()
const cracks = geometry.cracks
const pits = geometry.pits

/** The three widths a fracture is drawn at, from rim end to tip. */
const TAPER = [1, 0.72, 0.45]

/**
 * The fractures as tapered strokes — a mirror of `crackPaths` in the renderer.
 *
 * The card has to show the same fractures the badge does, so this is deliberately
 * the same algorithm: bucket each fracture's segments into three widths and emit
 * one path per run of equal width.
 *
 * @param list - the frame's fracture data.
 * @returns the `<path>` elements.
 */
function crackMarkup(list) {
  return list
    .map((crack) => {
      const parts = []
      let run = null
      let width = 0
      for (let i = 1; i < crack.pts.length; i += 1) {
        const along = (i - 1) / Math.max(1, crack.pts.length - 1)
        const next = Math.round(crack.w * TAPER[along < 0.34 ? 0 : along < 0.67 ? 1 : 2] * 100) / 100
        if (run === null || next !== width) {
          if (run !== null) parts.push(`<path stroke-width="${width}" d="${run}"/>`)
          run = `M${crack.pts[i - 1][0]} ${crack.pts[i - 1][1]}`
          width = next
        }
        run += `L${crack.pts[i][0]} ${crack.pts[i][1]}`
      }
      if (run !== null) parts.push(`<path stroke-width="${width}" d="${run}"/>`)
      return parts.join('')
    })
    .join('')
}

/**
 * The bronze/light ramp, written out literally for a standalone document.
 *
 * The device stops are not a second palette: `hud.css` defines them *as* metal
 * stops (`--dsh-sh-device-0: var(--dsh-sh-metal-1)` and so on for the light cut),
 * so here the device simply takes the darker half of the same ramp.
 */
const BRONZE_PLATE = ['#fdf1cd', '#d8b673', '#9a7a3e', '#5f4a20', '#2b2009']
const BRONZE_DEVICE = BRONZE_PLATE.slice(1)

/** One line of `<linearGradient>` stops. */
function gradient(id, colors, x1, y1, x2, y2) {
  const offsets = [0, 0.18, 0.46, 0.72, 1]
  const stops = colors
    .map((color, index) => {
      const offset = colors.length === 4 ? [0, 0.3, 0.62, 1][index] : offsets[index]
      return `<stop offset="${offset}" stop-color="${color}"/>`
    })
    .join('')
  return `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`
}

const medallion =
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
  '<defs>' +
  gradient('dsh-sh-plate', BRONZE_PLATE, 0.12, 0, 0.78, 1) +
  '<radialGradient id="dsh-sh-recess" cx="0.5" cy="0.4" r="0.66">' +
  '<stop offset="0.5" stop-color="rgba(0,0,0,0)"/>' +
  '<stop offset="1" stop-color="rgba(0,0,0,0.5)"/>' +
  '</radialGradient>' +
  gradient('dsh-sh-device', BRONZE_DEVICE, 0.18, 0.05, 0.82, 1) +
  `<clipPath id="dsh-sh-clip"><circle cx="24" cy="24" r="${round.fieldRadius}"/></clipPath>` +
  '</defs>' +
  // The card artwork is the *default* badge: the round covenant medal in bronze,
  // light — same geometry the renderer builds, same default shape.
  `<circle cx="24" cy="24" r="${round.plateRadius}" fill="url(#dsh-sh-plate)"/>` +
  `<circle cx="24" cy="24" r="${round.plateRadius}" fill="none" stroke="rgba(24,18,6,0.85)" stroke-width="0.8"/>` +
  `<circle cx="24" cy="24" r="${round.millRadius}" fill="none" stroke="rgba(255,246,222,0.34)" stroke-width="1.1" stroke-dasharray="0.9 1.6"/>` +
  // The rim's inner shadow, which the badge draws as two hairlines (see
  // `medallionSvg`): the card has to carry it too, or the icon loses the depth
  // that makes the badge readable at 16px.
  `<circle cx="24" cy="24" r="${round.millRadius - 1.15}" fill="none" stroke="rgba(28,20,8,0.42)" stroke-width="1.6"/>` +
  `<circle cx="24" cy="24" r="${round.millRadius - 2.35}" fill="none" stroke="rgba(20,14,4,0.5)" stroke-width="0.9"/>` +
  `<circle cx="24" cy="24" r="${round.fieldRadius}" fill="#efe6cf"/>` +
  '<g clip-path="url(#dsh-sh-clip)">' +
  `<circle cx="24" cy="24" r="${round.fieldRadius}" fill="url(#dsh-sh-recess)"/>` +
  // Fractures, drawn the way the renderer draws them: dark, and tapering from the
  // rim end to the tip (`crackPaths` in `lib/hud.js`).
  '<g fill="none" stroke="rgba(34,22,6,0.46)" stroke-linecap="round" stroke-linejoin="round">' +
  crackMarkup(cracks) +
  '</g>' +
  '<g fill="rgba(40,26,8,0.44)">' +
  pits.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join('') +
  '</g></g>' +
  `<circle cx="24" cy="24" r="${round.fieldRadius}" fill="none" stroke="rgba(255,245,220,0.5)" stroke-width="0.9"/>` +
  // The device is fitted into the field by a plain group transform, exactly as
  // `deviceGroup()`/`fitDevice()` do it at runtime — a nested `<svg>` is the
  // obvious alternative and it silently vanishes inside this frame.
  '<g>' +
  fit(ARTBOARD, devices.whale()) +
  '</g>' +
  '</svg>'

// The device's own `fill="currentColor"` is meaningless in a standalone image:
// `hud.css` repaints it with the device gradient, and here that has to be named.
const standalone = medallion.replace(/fill="currentColor"/g, 'fill="url(#dsh-sh-device)"')

/**
 * The rules a manifest icon has to satisfy.
 *
 * It reaches the card as a base64 `data:` URI inside an `<img src>`, so it is a
 * document of its own: `acme` is not the page, `currentColor` has nothing to
 * inherit, and a CSS custom property has no value. Every one of these has been
 * wrong at least once.
 *
 * @param svg - the artwork's text.
 * @throws when the artwork would not draw.
 */
function verify(svg) {
  const rules = [
    ['xmlns="http://www.w3.org/2000/svg"', 'declare the SVG namespace'],
    ['url(#dsh-sh-device)', 'strike the device from the medallion’s own metal'],
    ['stop-color="#fdf1cd"', 'write the bronze/light palette out literally'],
    ['<circle cx="24" cy="24" r="22.6"', 'draw the round covenant medal, the default shape'],
    ['stroke-dasharray', 'keep the medal’s milled edge'],
  ]
  for (const [needle, why] of rules) {
    if (!svg.includes(needle)) throw new Error(`icon.svg must ${why}: missing ${needle}`)
  }
  for (const [needle, why] of [
    ['currentColor', 'currentColor has nothing to inherit in an <img>'],
    ['var(--', 'a standalone image has no CSS custom properties'],
  ]) {
    if (svg.includes(needle)) throw new Error(`icon.svg must not use ${needle}: ${why}`)
  }
  if (Buffer.byteLength(svg) > 256 * 1024) {
    throw new Error('the app refuses a manifest icon over 256 KiB')
  }
}

const target = new URL('../icon.svg', import.meta.url)
if (process.argv.includes('--check')) {
  const current = readFileSync(target, 'utf8')
  if (current.trim() !== standalone.trim()) {
    console.error('icon.svg is stale — run: node test/icon.mjs')
    process.exit(1)
  }
  verify(current)
  console.log('icon.svg is up to date and drawable (%d bytes)', Buffer.byteLength(current))
} else {
  verify(standalone)
  writeFileSync(target, standalone + '\n')
  console.log('wrote icon.svg (%d bytes)', Buffer.byteLength(standalone))
}
