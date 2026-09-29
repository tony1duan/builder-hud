/**
 * Export the built-in devices as standalone, hand-editable SVGs.
 *
 * The point is that what you edit is what the plugin stores: each file is a
 * `0 0 32 32` document whose contents are **exactly** the fragment
 * `lib/hud.js`'s `DEVICE_MARKUP` returns for that device, wrapped so an editor
 * can open it. Tweak the paths, then paste the group's children back into the
 * matching `DEVICE_MARKUP` entry — nothing is scaled, re-projected or renamed on
 * the way in or out. The renderer fits the 32-unit box into the medallion's
 * field itself (`fitDevice`), so the figure's own coordinate space is the one you
 * design in.
 *
 * It also writes `contact-sheet.svg`, where every figure is shown struck into the
 * real medallion, and `_guide.svg`, which is the field's square drawn inside the
 * round plate — the margins a figure has to live within.
 *
 * Run: node test/devices.mjs
 *      node test/devices.mjs --check      (fail if the committed files are stale)
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

const hud = readFileSync(new URL('../lib/hud.js', import.meta.url), 'utf8')
const outDir = new URL('../assets/devices/', import.meta.url)

/**
 * Take the device table out of the renderer's source.
 *
 * It is a self-contained object literal of string-building closures, so a
 * `new Function` around the exact source is enough — and the shape check below
 * fails loudly if that ever stops being true, rather than exporting nothing.
 *
 * @returns the device id → markup builder table.
 */
function deviceTable() {
  const start = hud.indexOf('var DEVICE_MARKUP = {')
  if (start === -1) throw new Error('devices: lib/hud.js no longer declares DEVICE_MARKUP')
  let depth = 0
  for (let i = hud.indexOf('{', start); i < hud.length; i += 1) {
    if (hud[i] === '{') depth += 1
    else if (hud[i] === '}') {
      depth -= 1
      if (depth === 0) {
        const table = new Function(`return ${hud.slice(hud.indexOf('{', start), i + 1)}`)()
        for (const [id, build] of Object.entries(table)) {
          if (typeof build !== 'function') throw new Error(`devices: ${id} is not a builder function`)
        }
        return table
      }
    }
  }
  throw new Error('devices: DEVICE_MARKUP is not balanced')
}

/** Take one `var NAME = { … };` object out of the renderer's source. */
function objectLiteral(declaration) {
  const start = hud.indexOf(declaration)
  if (start === -1) throw new Error(`devices: lib/hud.js no longer declares ${declaration}`)
  let depth = 0
  for (let i = hud.indexOf('{', start); i < hud.length; i += 1) {
    if (hud[i] === '{') depth += 1
    else if (hud[i] === '}') {
      depth -= 1
      if (depth === 0) {
        return new Function(`return ${hud.slice(hud.indexOf('{', start), i + 1)}`)()
      }
    }
  }
  throw new Error(`devices: ${declaration} is not balanced`)
}

/**
 * Put one drawing element per line.
 *
 * The source fragments are string concatenations, so they arrive as a single
 * enormous line. Nobody can hand-tune that; the markup itself is unchanged, only
 * its whitespace — and `--fragment` puts it back on one line for the paste back
 * into `lib/hud.js`.
 *
 * @param markup - the fragment.
 * @returns the same fragment, one element per line.
 */
function readable(markup) {
  return markup
    .replace(/></g, '>\n<')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
}

const DEVICES = deviceTable()
const geometry = objectLiteral('var MEDALLION_GEOMETRY = {')

/** The artboard the renderer fits the built-in figures from (`DEVICE_VIEWBOX`). */
const ARTBOARD = (() => {
  const found = /var DEVICE_VIEWBOX = '([^']+)'/.exec(hud)
  if (!found) throw new Error('devices: lib/hud.js no longer declares DEVICE_VIEWBOX')
  return found[1]
})()

/**
 * Mirror of the renderer's `fitDevice`: scale `32 / max(w, h)` and centre the
 * artboard on the medal's field.
 *
 * The sheet and the card icon each carry a copy of these five lines because they
 * are dev artifacts that run without a DOM, and `fitDevice` lives inside the
 * renderer's IIFE. The check that they agree is the badge itself: if a figure sits
 * wrong in the app, it sits wrong on the sheet too.
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

/** The bronze, light cut — so an exported figure is visible on a white canvas. */
const INK = '#d9a441'
/** The plate and field behind a figure on the contact sheet. */
const PLATE = '#e3c98f'
const FIELD = '#2b2618'

/**
 * One device as a standalone document.
 *
 * `color` is set on the root so the fragment's own `currentColor` fills resolve;
 * nothing else about the fragment is touched, which is what makes the file
 * pasteable straight back into `DEVICE_MARKUP`.
 *
 * @param id - device id.
 * @returns the SVG text, newline-terminated.
 */
function deviceFile(id) {
  const comment = `    <!-- ${id}: paste these children back into DEVICE_MARKUP.${id} in lib/hud.js. -->`
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="${ARTBOARD}"
     color="${INK}" role="img" aria-label="${id}">
${comment}
  <g id="device" fill="currentColor">
${readable(DEVICES[id]()).replace(/^/gm, '    ')}
  </g>
</svg>
`
}

/** The medallion's field square inside the plate, for judging margins. */
function guide() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 48 48"
     role="img" aria-label="device guide">
  <!-- The round plate and its recessed field, then the box a figure's artboard is
       fitted into: centred, and scaled by 32 / max(width, height). The dashed
       square is 32 medal units, i.e. wherever the artboard's own edges land. -->
  <circle cx="24" cy="24" r="${geometry.round.plateRadius}" fill="${PLATE}"/>
  <circle cx="24" cy="24" r="${geometry.round.fieldRadius}" fill="${FIELD}"/>
  <rect x="8" y="8" width="32" height="32" fill="none" stroke="#ffffff" stroke-opacity="0.5"
        stroke-width="0.4" stroke-dasharray="1.2 1"/>
  <rect x="8" y="8" width="32" height="32" fill="none" stroke="#000000" stroke-opacity="0.25"
        stroke-width="0.2"/>
</svg>
`
}

/**
 * Every device struck into the real medallion, one per cell.
 *
 * This is the sheet to eyeball after a tweak: the guide square is drawn too, so
 * a figure that grew past the field is obvious.
 *
 * @returns the SVG text, newline-terminated.
 */
function contactSheet() {
  const ids = Object.keys(DEVICES)
  const cell = 48
  const cells = ids
    .map((id, index) => {
      // Not named `fit`: that is the shared transform helper's name, and a local
      // of the same name shadows it inside this callback.
      const cellGroup = `<g transform="translate(${index * cell},0)">`
      return `${cellGroup}
    <circle cx="24" cy="24" r="${geometry.round.plateRadius}" fill="${PLATE}"/>
    <circle cx="24" cy="24" r="${geometry.round.fieldRadius}" fill="${FIELD}"/>
    <rect x="8" y="8" width="32" height="32" fill="none" stroke="#ffffff" stroke-opacity="0.28"
          stroke-width="0.35" stroke-dasharray="1 1"/>
    <g fill="${INK}">${fit(ARTBOARD, DEVICES[id]())}</g>
    <text x="24" y="46.4" text-anchor="middle" font-family="monospace" font-size="2.6"
          fill="#8a8a8a">${id}</text>
  </g>`
    })
    .join('\n  ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${ids.length * 96}" height="96"
     viewBox="0 0 ${ids.length * cell} ${cell}" color="${INK}" role="img"
     aria-label="device contact sheet">
  ${cells}
</svg>
`
}

const files = new Map()
for (const id of Object.keys(DEVICES)) files.set(`${id}.svg`, deviceFile(id))
files.set('contact-sheet.svg', contactSheet())
files.set('_guide.svg', guide())

/**
 * Print one device as the JS expression `DEVICE_MARKUP` wants.
 *
 * Read from the *SVG file*, not from the renderer, so the loop after a tweak is:
 * edit `assets/devices/whale.svg`, then paste this over the `return` in
 * `DEVICE_MARKUP.whale` (or upload the SVG in the settings form and never touch
 * the source at all).
 *
 * @param id - device id.
 * @returns nothing; the expression goes to stdout.
 */
function printFragment(id) {
  const svg = readFileSync(new URL(`${id}.svg`, outDir), 'utf8')
  const open = svg.indexOf('<g id="device"')
  const close = svg.lastIndexOf('</g>')
  if (open === -1 || close === -1) {
    throw new Error(`devices: ${id}.svg has no <g id="device"> group to read`)
  }
  const body = svg
    .slice(svg.indexOf('>', open) + 1, close)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+</g, '<')
    .replace(/>\s+/g, '>')
    .replace(/\s+\/>/g, '/>')
    .trim()
  // Chunk on element boundaries so the expression reads like the source does.
  const elements = body.match(/<[^>]+\/>|<[^>]+>[\s\S]*?<\/[^>]+>/g) || [body]
  const chunks = []
  let current = ''
  for (const element of elements) {
    if (current !== '' && current.length + element.length > 88) {
      chunks.push(current)
      current = ''
    }
    current += element
  }
  if (current !== '') chunks.push(current)
  console.log(chunks.map((chunk) => `'${chunk.replace(/'/g, "\\'")}'`).join(' +\n'))
}

/**
 * Normalize a figure file into the fragment `DEVICE_MARKUP` stores.
 *
 * Three things differ between an editor's export and what the renderer wants, and
 * all three are mechanical:
 *
 *   - the `<svg>` wrapper goes (the renderer supplies the frame);
 *   - whitespace collapses to one line, because the fragment is stored as a JS
 *     string;
 *   - a literal `fill` becomes `currentColor`. Nothing on the badge depends on it
 *     — the stylesheet repaints every shape with the material's gradient — but the
 *     settings preview *bakes* literal paints, so a `fill="black"` from an editor
 *     would show up as a black figure in the preview while the badge looked right.
 *
 * @param text - the file's text.
 * @returns the fragment.
 */
function normalizeFigure(text) {
  const open = text.indexOf('<svg')
  const close = text.lastIndexOf('</svg>')
  if (open === -1 || close === -1) throw new Error('devices: not an SVG document')
  let inner = text
    .slice(text.indexOf('>', open) + 1, close)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // Drop the exporter's own `<g id="device">` wrapper — *all* of them, in a loop.
  // Keeping it nested one more group per round trip (which is exactly what it did
  // before this existed), so the strip has to be idempotent to be safe.
  while (inner.startsWith('<g id="device"')) {
    const body = inner.indexOf('>') + 1
    const tail = inner.lastIndexOf('</g>')
    if (tail === -1) break
    inner = inner.slice(body, tail).trim()
  }
  return inner
    .replace(/>\s+</g, '><')
    .replace(/\s+\/>/g, '/>')
    .replace(/fill="(?!none|currentColor)[^"]*"/g, 'fill="currentColor"')
    .trim()
}

/** The `viewBox` a figure file declares. */
function viewBoxOf(text) {
  const found = /viewBox="([^"]+)"/.exec(text)
  return found ? found[1] : '0 0 512 512'
}

/**
 * What each figure is, in one line, for the doc comment the renderer gets.
 *
 * Kept here rather than parsed out of the SVG: a generated description reads like
 * one, and a figure without an entry fails the import loudly instead of landing in
 * `lib/hud.js` undocumented.
 */
const NOTES = {
  whale: 'A whale: a rounded body, a raised fluke, and a cut-out eye.',
  hammer: "A blacksmith's hammer: a chamfered head on a straight haft.",
  sword: 'A longsword, point up and lying on the diagonal: blade, crossguard, grip, pommel.',
  sun: 'A sun: eight tapered points around a hollow disc, cut from one path.',
  moon: 'A crescent moon: one disc carved out of another.',
  wolf: "A wolf's head: a long snout, pricked ears, and a jagged mane.",
}

/** Split a fragment into `<element>` chunks of a readable line length. */
function chunkFragment(fragment) {
  const chunks = []
  let current = ''
  for (const element of fragment.match(/<[^>]+\/>|<[^>]+>[\s\S]*?<\/[^>]+>/g) || [fragment]) {
    if (current !== '' && current.length + element.length > 88) {
      chunks.push(current)
      current = ''
    }
    current += element
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/**
 * Write the figures in `assets/devices/` back into the renderer.
 *
 * The assets are the editable copy, so this is the bulk version of the
 * `--fragment` paste: the whole `DEVICE_MARKUP` literal is regenerated from the
 * files, which means a figure with no file is **removed**, a file with no entry is
 * added, and the artboard comes from the files themselves. The literal is rebuilt
 * in one piece rather than patched entry by entry — an earlier version patched by
 * regex and quietly emptied the table when the pattern missed.
 *
 * @returns nothing; `lib/hud.js` is rewritten.
 */
function importFigures() {
  // The directory is the source of truth for *which* figures exist; the generated
  // map only exists to be replaced.
  const ids = readdirSync(outDir)
    .filter((name) => name.endsWith('.svg') && !name.startsWith('_') && name !== 'contact-sheet.svg')
    .map((name) => name.slice(0, -4))
    .sort()
  // The default figure leads; the rest sort. The table's own order is what the
  // contact sheet walks, and a sheet that opens with the whale reads better than
  // one that opens with the hammer.
  ids.sort((a, b) => (a === 'whale' ? -1 : b === 'whale' ? 1 : a.localeCompare(b)))
  if (ids.length === 0) throw new Error('devices: no figures in assets/devices to import')

  const artboards = new Set(ids.map((id) => viewBoxOf(readFigure(id))))
  if (artboards.size !== 1) {
    throw new Error(`devices: the figures disagree about their artboard: ${[...artboards].join(' / ')}`)
  }
  const artboard = [...artboards][0]

  const entries = ids.map((id) => {
    const note = NOTES[id]
    if (!note) {
      throw new Error(`devices: add a NOTES entry for "${id}" in test/devices.mjs first`)
    }
    const fragment = normalizeFigure(readFigure(id))
    const chunks = chunkFragment(fragment)
    const lines = chunks.map(
      (chunk, index) => `        '${chunk.replace(/'/g, "\\'")}'${index === chunks.length - 1 ? '' : ' +'}`,
    )
    return `    /** ${note} */\n    ${id}: function () {\n      return (\n${lines.join('\n')}\n      );\n    },`
  })

  const literal = `  var DEVICE_MARKUP = {\n${entries.join('\n')}\n  };`
  const start = hud.indexOf('  var DEVICE_MARKUP = {')
  if (start === -1) throw new Error('devices: lib/hud.js no longer declares DEVICE_MARKUP')
  const end = hud.indexOf('\n  };', start)
  if (end <= start) throw new Error('devices: DEVICE_MARKUP has no closing brace')
  let source = hud.slice(0, start) + literal + hud.slice(end + '\n  };'.length)

  if (!/var DEVICE_VIEWBOX = '[^']*'/.test(source)) {
    throw new Error('devices: lib/hud.js no longer declares DEVICE_VIEWBOX')
  }
  source = source.replace(/var DEVICE_VIEWBOX = '[^']*'/, `var DEVICE_VIEWBOX = '${artboard}'`)

  writeFileSync(new URL('../lib/hud.js', import.meta.url), source)
  console.log(`imported ${ids.length} figures into lib/hud.js (artboard ${artboard}): ${ids.join(', ')}`)
}

/** One figure file's text. */
function readFigure(id) {
  return readFileSync(new URL(`${id}.svg`, outDir), 'utf8')
}

if (process.argv.includes('--import')) {
  importFigures()
  process.exit(0)
}

const fragmentOf = process.argv.indexOf('--fragment')
if (fragmentOf !== -1) {
  printFragment(process.argv[fragmentOf + 1] || 'whale')
  process.exit(0)
}

const check = process.argv.includes('--check')
mkdirSync(outDir, { recursive: true })
let stale = 0
for (const [name, text] of files) {
  const target = new URL(name, outDir)
  if (check) {
    let current = ''
    try {
      current = readFileSync(target, 'utf8')
    } catch {
      current = ''
    }
    if (current !== text) {
      console.error(`stale: assets/devices/${name} — run: node test/devices.mjs`)
      stale += 1
    }
  } else {
    writeFileSync(target, text)
  }
}
if (check && stale > 0) process.exit(1)
console.log(
  check
    ? `assets/devices: ${files.size} files are current`
    : `wrote ${files.size} files to assets/devices (${Object.keys(DEVICES).join(', ')})`,
)
