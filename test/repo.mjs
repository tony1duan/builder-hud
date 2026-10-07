/**
 * Repository metadata guard.
 *
 * The files in `.github/`, the links between the documents, and the commands
 * those documents tell a reader to run are invisible to every other suite — and
 * all three rot the same way: silently.
 *
 *   - GitHub reads issue templates **only from the default branch**, and it
 *     drops a form whose YAML or schema is wrong without reporting it anywhere.
 *     A broken template does not error; it simply stops appearing, so nobody
 *     notices it is gone.
 *   - A renamed heading leaves an `#anchor` that still looks right in an
 *     editor's preview and lands on the top of the file on GitHub.
 *   - A renamed test file turns "run this to prove it" into MODULE_NOT_FOUND.
 *
 * So this suite asserts, from the bytes that are actually committed, the same
 * things a reader depends on. It runs on plain Node with no dependencies, from
 * a checkout or a tarball.
 *
 * Run: node test/repo.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** This repository. A typo here sends donors and reporters at a 404. */
const SELF_REPO = 'tony1duan/builder-hud'

/** Third-party links the documents are allowed to point at. */
const EXTERNAL_REPOS = new Set(['NateScarlet/holiday-cn'])

/** Never walked: not published, or not ours. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'notes'])

/** The block types GitHub renders in an issue form. */
const BLOCK_TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes'])

/** The keys GitHub reads in FUNDING.yml. Anything else is ignored. */
const FUNDING_KEYS = new Set([
  'github',
  'patreon',
  'open_collective',
  'ko_fi',
  'tidelift',
  'community_bridge',
  'liberapay',
  'issuehunt',
  'lfx_crowdfunding',
  'polar',
  'buy_me_a_coffee',
  'thanks_dev',
  'custom',
])

const ISSUE_DIR = '.github/ISSUE_TEMPLATE'
const CONFIG_FILE = `${ISSUE_DIR}/config.yml`
const FUNDING_FILE = '.github/FUNDING.yml'
const PR_TEMPLATE = '.github/PULL_REQUEST_TEMPLATE.md'

// --- the files ---------------------------------------------------------------

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...walk(full))
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

const FILES = walk(ROOT)
const rel = (path) => relative(ROOT, path).split(sep).join('/')
const REL_FILES = FILES.map(rel)
const read = (path) => readFileSync(join(ROOT, path), 'utf8')

/** Every text file whose contents are instructions to a human. */
const DOC_FILES = REL_FILES.filter((f) => /\.(md|ya?ml)$/.test(f))

// --- a reader for the YAML subset these files use -----------------------------
//
// There is no YAML parser in Node and the project ships no dependencies, so this
// reads the subset the `.github/` files actually contain: block mappings, block
// sequences of mappings, one nested sequence level, scalars, and `|` block
// scalars. It is deliberately strict — anything it does not recognise throws
// rather than being skipped, because a guard that quietly skips the broken part
// of a file is a guard that passes while the file is broken.

function readYaml(text, file) {
  const top = new Map()
  const blocks = []
  let bodyIndent = null
  let current = null
  let scalar = null

  text.split('\n').forEach((raw, index) => {
    const where = `${file}:${index + 1}`
    if (/^ *\t/.test(raw)) throw new Error(`${where}: YAML forbids a tab in indentation`)

    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) return

    const indent = line.length - line.trimStart().length
    if (scalar !== null) {
      if (indent > scalar.indent) {
        if (line.trim() !== '' && scalar.contentIndent === null) scalar.contentIndent = indent
        scalar.lines.push(line.trim() === '' ? '' : line.slice(scalar.contentIndent))
        return
      }
      scalar.map.set(scalar.key, scalar.lines.join('\n').trim())
      scalar = null
    }

    const text_ = line.trim()
    const keyed = /^([A-Za-z_][\w-]*):(?:[ ]?(.*))?$/

    const sequence = /^-[ ]+(.*)$/.exec(text_)
    if (sequence) {
      const entry = keyed.exec(sequence[1])
      if (!entry) throw new Error(`${where}: unrecognised sequence entry ${JSON.stringify(sequence[1])}`)
      const key = entry[1]
      const value = entry[2] ?? ''

      if (bodyIndent === null) bodyIndent = indent
      if (indent > bodyIndent) {
        if (current === null || key !== 'label') {
          throw new Error(`${where}: expected nothing but an option label nested this deep`)
        }
        current.options.push(value)
        return
      }
      if (indent !== bodyIndent) {
        throw new Error(`${where}: this entry is indented ${indent}, its siblings are at ${bodyIndent}`)
      }

      current = { line: index + 1, fields: new Map(), options: [] }
      current.fields.set(key, value)
      if (isBlockScalar(value)) scalar = { map: current.fields, key, indent, lines: [], contentIndent: null }
      blocks.push(current)
      return
    }

    const entry = keyed.exec(text_)
    if (!entry) throw new Error(`${where}: unrecognised line ${JSON.stringify(text_)}`)
    const key = entry[1]
    const value = entry[2] ?? ''

    if (indent === 0) {
      if (top.has(key)) throw new Error(`${where}: duplicate top-level key '${key}'`)
      top.set(key, value)
      if (isBlockScalar(value)) scalar = { map: top, key, indent, lines: [], contentIndent: null }
      current = null
      bodyIndent = null
      return
    }

    if (current === null) throw new Error(`${where}: '${key}' is not inside an entry`)
    if (current.fields.has(key)) throw new Error(`${where}: duplicate key '${key}'`)
    current.fields.set(key, value)
    if (isBlockScalar(value)) scalar = { map: current.fields, key, indent, lines: [], contentIndent: null }
  })

  if (scalar !== null) scalar.map.set(scalar.key, scalar.lines.join('\n').trim())

  return { top, blocks }
}

const isBlockScalar = (value) => value === '|' || value === '>' || value === '|-' || value === '>-' || value === '|+'

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

// --- issue forms --------------------------------------------------------------

const formFiles = REL_FILES.filter(
  (f) => f.startsWith(`${ISSUE_DIR}/`) && f.endsWith('.yml') && f !== CONFIG_FILE,
)

assert.ok(formFiles.length > 0, `${ISSUE_DIR}/ has no issue forms left`)

for (const file of formFiles) {
  const text = read(file)
  const { top, blocks } = readYaml(text, file)

  assert.ok(nonEmpty(top.get('name')), `${file}: a form needs a name, or GitHub cannot list it`)
  assert.ok(nonEmpty(top.get('description')), `${file}: a form needs a description`)
  assert.ok(top.has('body'), `${file}: a form needs a body`)

  // Fail closed: every block in the file must have been recognised. If the
  // reader ever skips syntax it does not know, this is what catches it.
  const declared = [...text.matchAll(/^[ ]*-[ ]+type:/gm)].length
  assert.equal(
    blocks.filter((b) => b.fields.has('type')).length,
    declared,
    `${file}: the reader did not see every block, so the checks below prove nothing`,
  )

  const ids = new Set()
  for (const block of blocks) {
    const { line } = block
    const type = block.fields.get('type')
    assert.ok(type, `${file}:${line}: every body entry needs a type`)
    assert.ok(BLOCK_TYPES.has(type), `${file}:${line}: '${type}' is not an issue-form block type`)

    if (type === 'markdown') {
      assert.ok(nonEmpty(block.fields.get('value')), `${file}:${line}: a markdown entry needs a value`)
      continue
    }

    const id = block.fields.get('id')
    assert.ok(nonEmpty(id), `${file}:${line}: a '${type}' entry needs an id, or its answer is dropped`)
    assert.ok(!ids.has(id), `${file}:${line}: duplicate id '${id}' — GitHub keeps one and discards the other`)
    ids.add(id)

    if (type !== 'checkboxes') {
      assert.ok(nonEmpty(block.fields.get('label')), `${file}:${line}: '${id}' needs a label`)
    }
    if (type === 'dropdown' || type === 'checkboxes') {
      assert.ok(block.options.length > 0, `${file}:${line}: '${id}' needs at least one option`)
      assert.ok(block.options.every(nonEmpty), `${file}:${line}: '${id}' has an empty option label`)
    }
  }
}

{
  const { top, blocks } = readYaml(read(CONFIG_FILE), CONFIG_FILE)
  assert.ok(top.has('blank_issues_enabled'), `${CONFIG_FILE}: 'blank_issues_enabled' decides whether the form is offered at all`)
  assert.ok(nonEmpty(top.get('blank_issues_enabled')), `${CONFIG_FILE}: 'blank_issues_enabled' is empty`)
  assert.ok(blocks.length > 0, `${CONFIG_FILE}: the contact links are the whole point of this file`)
  for (const block of blocks) {
    for (const key of ['name', 'url', 'about']) {
      assert.ok(nonEmpty(block.fields.get(key)), `${CONFIG_FILE}:${block.line}: a contact link needs a '${key}'`)
    }
  }
}

// --- the sponsor button ---------------------------------------------------------

{
  const { top } = readYaml(read(FUNDING_FILE), FUNDING_FILE)
  assert.ok(top.size > 0, `${FUNDING_FILE}: no funding keys, so there is no Sponsor button`)
  for (const [key, value] of top) {
    assert.ok(FUNDING_KEYS.has(key), `${FUNDING_FILE}: GitHub does not read the key '${key}'`)
    assert.ok(nonEmpty(value), `${FUNDING_FILE}: '${key}' has no value`)
  }
  const custom = top.get('custom')
  if (custom !== undefined) {
    const urls = custom
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
    assert.ok(urls.length <= 4, `${FUNDING_FILE}: GitHub reads at most four custom URLs, this lists ${urls.length}`)
  }
}

// --- the pull request template --------------------------------------------------

assert.ok(REL_FILES.includes(PR_TEMPLATE), `${PR_TEMPLATE} is missing — a pull request then arrives with no shape`)
{
  const text = read(PR_TEMPLATE)
  assert.ok(nonEmpty(text), `${PR_TEMPLATE} is empty`)
  assert.ok(/- \[ \]/.test(text), `${PR_TEMPLATE}: the checklist must use GitHub's '- [ ]' checkbox syntax, or it renders as text`)
}

// --- the working notes stay internal -------------------------------------------

{
  const ignore = read('.gitignore').split('\n').map((l) => l.trim())
  assert.ok(
    ignore.includes('notes/') || ignore.includes('notes'),
    '.gitignore must keep notes/ out of the repository: it holds the reverse-engineering write-ups',
  )
}

// --- links, anchors and commands --------------------------------------------------

/** Headings of a Markdown document, in order, ignoring fenced code. */
function headingsOf(text) {
  const out = []
  let fence = null
  for (const line of text.split('\n')) {
    const fenced = /^\s*(```|~~~)/.exec(line)
    if (fenced) {
      fence = fence === null ? fenced[1] : null
      continue
    }
    if (fence !== null) continue
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) out.push(heading[2])
  }
  return out
}

/** GitHub's heading slug: lowercase, drop punctuation, spaces to hyphens. */
function slugify(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/** Every anchor a document offers, including the `-1`, `-2` repeats GitHub makes. */
function anchorsOf(path) {
  const seen = new Map()
  const anchors = new Set()
  for (const heading of headingsOf(read(path))) {
    const base = slugify(heading)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
  }
  return anchors
}

/** Markdown links and images, ignoring fenced code. */
function linksIn(text) {
  const out = []
  let fence = null
  text.split('\n').forEach((line, index) => {
    const fenced = /^\s*(```|~~~)/.exec(line)
    if (fenced) {
      fence = fence === null ? fenced[1] : null
      return
    }
    if (fence !== null) return
    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      out.push({ target: match[1], line: index + 1 })
    }
  })
  return out
}

function splitAnchor(target) {
  const hash = target.indexOf('#')
  return hash === -1 ? [target, null] : [target.slice(0, hash), target.slice(hash + 1)]
}

/** Where an in-repo link points, or null when it leaves the repository. */
function destinationOf(target, fromFile) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    // A URL that names a file in this repository is still a link we can check.
    const blob = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/[^/]+\/(.+)$/.exec(target)
    if (blob === null || `${blob[1]}/${blob[2]}` !== SELF_REPO) return null
    const [path, anchor] = splitAnchor(blob[3])
    return { path: join(ROOT, path), anchor }
  }
  const [target_, anchor] = splitAnchor(target)
  const path = target_ === '' ? join(ROOT, fromFile) : resolve(ROOT, dirname(fromFile), target_)
  return { path, anchor }
}

let checkedLinks = 0
for (const file of DOC_FILES) {
  const text = read(file)

  // A GitHub URL in the repository's own metadata must name this repository, or
  // a known third party. A typo here is a link that 404s and nobody sees it.
  if (file.startsWith('.github/')) {
    for (const match of text.matchAll(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/g)) {
      const slug = `${match[1]}/${match[2]}`
      assert.ok(
        slug === SELF_REPO || EXTERNAL_REPOS.has(slug),
        `${file}: github.com/${slug} is neither this repository nor a known third party`,
      )
    }
  }

  for (const { target, line } of linksIn(text)) {
    const destination = destinationOf(target, file)
    if (destination === null) continue
    const where = `${file}:${line}`

    assert.ok(
      !relative(ROOT, destination.path).startsWith('..'),
      `${where}: '${target}' points outside the repository`,
    )
    assert.ok(existsSync(destination.path), `${where}: '${target}' does not exist`)

    // A directory link is served as that directory's README, so an anchor on it
    // resolves there — that is exactly how `../souls-hud#support` works.
    let target_ = destination.path
    if (destination.anchor !== null && statSync(target_).isDirectory()) target_ = join(target_, 'README.md')

    if (destination.anchor === null || destination.anchor === '') continue
    assert.ok(
      target_.endsWith('.md'),
      `${where}: '#${destination.anchor}' points into a file with no headings`,
    )
    assert.ok(
      anchorsOf(rel(target_)).has(destination.anchor),
      `${where}: no heading in ${rel(target_)} makes the anchor '#${destination.anchor}'`,
    )
    checkedLinks += 1
  }

  // Commands in the documents must name files that exist. The docs use both
  // conventions — repo-root-relative in the root documents and the "Verifying"
  // blocks, package-relative in the per-package prose — so a command is accepted
  // if it resolves from any directory between the document and the repo root,
  // which is where a reader copying it could plausibly be standing.
  const bases = []
  for (let dir = dirname(join(ROOT, file)); ; dir = dirname(dir)) {
    bases.push(dir)
    if (dir === ROOT) break
  }
  for (const match of text.matchAll(/(?<![\w/-])node\s+([\w./-]+\.mjs)/g)) {
    const given = match[1]
    const places = bases.map((base) => rel(base) || '.').join(', ')
    assert.ok(
      bases.some((base) => existsSync(join(base, given))),
      `${file}: it tells the reader to run 'node ${given}', which exists in none of: ${places}`,
    )
  }
}

console.log(
  `repository metadata: issue forms, the sponsor button, the pull request template, ` +
    `${checkedLinks} anchors and the linked paths and commands are all consistent`,
)
