# Device figures

The eight figures the medallion can be struck with, as standalone SVGs you can
open in any vector editor. `node test/devices.mjs` writes them out of the
renderer, so a file here is always the same markup the badge draws — and
`node test/devices.mjs --check` fails if one has drifted.

| File | What it is |
| --- | --- |
| `whale.svg` … `wolf.svg` | one figure each, ready to edit |
| `contact-sheet.svg` | every figure struck into the medallion, side by side |
| `_guide.svg` | the plate, the recessed field, and the box a figure's artboard is fitted into |

## The contract

- **Coordinate space:** whatever the file's `viewBox` says — the current artwork is
  authored at `0 0 512 512`, which is what the renderer's `DEVICE_VIEWBOX` holds.
  The renderer centres that box on the medal's field and scales it by
  `32 / max(width, height)`, so all six are fitted identically. An upload may use
  any artboard; a built-in declares one for all of them (`--import` fails if they
  disagree).
- **Paint:** keep `fill="currentColor"` on the shapes. The stylesheet repaints
  everything inside `.dsh-sh__device` with the material's gradient
  (`fill: url(#dsh-sh-device)`), so a literal colour you set while designing is
  *replaced* on the badge — the attribute is there so the exported file also
  renders on its own. `fill="none"` plus `stroke="currentColor"` gives line art.
- **`fill-rule="evenodd"`** is how the whale's eye, the moon's crescent and the
  wolf's eyes/mouth are cut out of a single filled path. Not overridden by the
  stylesheet, so cut-outs survive.
- **Stay near the middle.** In medal units the field's circle is radius 18.6 around
  `(24, 24)`, and the artboard is fitted into a 32-unit box at `(8, 8)`. So in the
  artboard's own units the field is a circle of radius `18.6 × (512 / 32) = 297.6`
  around the artboard's centre, while the artboard's corners sit 16√2 ≈ 22.6 medal
  units out — exactly on the plate's rim. Anything important should stay inside
  about **r = 250** of the centre at 512; rays, points and tips may reach further,
  and the ones in `sun.svg` and `sword.svg` deliberately do.
- **No `id`s, no `style`, no events, no external references.** Built-ins are
  trusted, but a figure that also survives the *upload* sanitizer is a figure that
  can be shipped either way: scripts, `on*` handlers, `style` (which would
  out-rank the metal), external URLs and foreign objects are stripped there.

## Changing a built-in

```sh
# 1. edit the figures
open assets/devices/whale.svg

# 2. write them all back into lib/hud.js (the whole DEVICE_MARKUP table, regenerated)
node test/devices.mjs --import

# 3. and check the two sides agree again
node test/devices.mjs --check   # export == what the renderer holds
node test/preview.mjs           # rebuild the gallery, look at #badges
node test/upload.mjs            # the markup rules, driven in a browser
```

`--import` treats this directory as the source of truth: a file with no entry is
added, an entry with no file is **removed**, and every figure needs a one-line
description in `test/devices.mjs`'s `NOTES` (it fails loudly otherwise, rather
than dropping prose). A single figure can still be pasted by hand:
`node test/devices.mjs --fragment whale` prints just that expression.

## Not changing the source at all

The settings form takes an uploaded SVG, which is the supported route for art
that is yours rather than the plugin's: pick **Device → custom**, choose the
file, and it is sanitized, fitted the same way, and painted in the material. That
path needs no rebuild — and `node test/upload.mjs` is where its rules are
enforced.
