# BuilderHUD

A bundle of customizable vitals-cluster skins for the DSH sidebar. It ships one:
the [**Souls Style**](../souls-hud) — three Dark Souls style bars beside an
engraved covenant medallion whose shape, device, metal and light/dark cut are all
settings, and whose edge doubles as a token-burn gauge.

![The medallion in dark mode — every device, every metal](../souls-hud/preview/shots/medallion-dark.png)

## What is in this package

This package is the **bundle**: the thing the Plugins page lists as a card, and
the patch layer that puts a row on it.

| File | Why |
| --- | --- |
| `package.json` | the card's name and description, `dsh.bundle.patch`, and the dependency on the skin |
| `cordis.patch.yml` | the row: `id: souls-hud`, `name: dsh-plugin-souls-hud`, and the default configuration |
| `locale/{en,zh}.json` | the **card's** title (*BuilderHUD*) and one-liner, per language |
| `icon.svg` | the card's artwork — generated from the renderer by `test/icon.mjs` |
| `test/icon.mjs` | regenerates that artwork from `../souls-hud/lib/hud.js`, and proves it is drawable |

There is no runtime code here on purpose. The name on the card comes from the
package listed in `dsh.profile.bundles`, and the name on the row comes from the
package the row points at — so two names need two packages. See
[the Souls Style README](../souls-hud#the-names-and-why-there-are-two-packages)
for the load-bearing reason (a subpath row silently loses its browser half).

## Installing

The profile lists this bundle, and this bundle depends on the skin:

```json
{
  "dependencies": {
    "dsh-plugin-builder-hud": "^0.4.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-plugin-builder-hud"]
    }
  }
}
```

`pnpm add dsh-plugin-builder-hud` in the profile brings the Souls Style in with it.
The profile's own `cordis.patch.yml` then carries only the switch's state:

```yaml
- id: souls-hud
  disabled: false
```

> Do **not** repeat the `insert` row there. The row belongs to this bundle's
> patch; the same id in two layers makes the entry ambiguous, which the Host
> reports as `unaddressable` and the Plugins page renders as a *disabled* switch.

To install from a checkout instead, link both packages into the profile's
`node_modules` (this package and `../souls-hud`) and keep the same profile
manifest.

## The artwork: two icons, one generator

An icon reaches the Plugins page as a base64 `data:` URI inside an `<img src>`, so it
is a document of its own: it must declare the SVG namespace, and it cannot use
`currentColor` or a CSS custom property. Both are generated from the renderer, so a
card cannot advertise a badge the plugin does not draw:

| Icon | Badge | Command |
| --- | --- | --- |
| [`icon.svg`](icon.svg) — this bundle's card | round covenant medal, whale, bronze — the default badge | `node test/icon.mjs` |
| [`../souls-hud/icon.svg`](../souls-hud/icon.svg) — the skin's row | cut-corner plate, sun struck into the field | `node test/icon.mjs --shape octagon --device sun --out ../souls-hud/icon.svg` |

```sh
node test/icon.mjs --check   # the card is current and drawable
node test/icon.mjs --shape octagon --device sun --out ../souls-hud/icon.svg --check
```

`--out` is required as soon as the badge is not the default one, so a variant can
never overwrite the card artwork; the round output is byte-identical to what this
script has always written, which is what makes `--check` meaningful for it.

## Licensing and marks

MIT. The medallion, its devices and the whale are BuilderHUD's own drawings —
**not** the DeepSeek logo, and not traced from it: shipping the official mark in
an open-source package would put a trademark somewhere its owner never put it.
Anyone who wants it on their own machine can upload it as a device.

## Support

Both packages are free — the bundle and the skin. There is no paid edition, no
licence key, and no feature to unlock, and the settings page says so in as many
words; the donations exist to pay for maintenance, not to open a door.

If the HUD earns its place in your sidebar, the tip jar is on **this bundle's
card page** — the skin registers it into `plugins.detail.section`, so it sits one
level out from the row's settings. Two buttons, each a glyph beside its label:
WeChat unfolds its code in place, Ko-fi opens in a new tab. Both are configured in
one place and documented in [the Souls Style README](../souls-hud#support), and an
unfilled channel is not rendered at all, so a checkout that has not been given an
address shows no tip jar. The same section lists the two metadata fields (npm's `funding`,
`.github/FUNDING.yml`) that make a channel findable once there is one; this
package's `package.json` can carry the same `funding` field as the skin.

A donation changes nothing about the licence: MIT before, MIT after.
