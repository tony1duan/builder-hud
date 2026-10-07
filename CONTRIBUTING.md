# Contributing

Thanks for looking. This is a small project with an unusually strict test suite,
and the suite is the whole contract — if it passes, a change is welcome; if it
fails, the failure usually explains itself.

## What is in here

| Path | What it is |
| --- | --- |
| `plugins/builder-hud` | the **bundle**: the card the Plugins page lists, and the patch layer that puts a row on it. No runtime code, on purpose |
| `plugins/souls-hud` | the **skin**: the host half (state, settings, the donation route), the client half (the settings form), and the renderer (`lib/hud.js` + `lib/hud.css`) |

[`plugins/souls-hud/README.md`](plugins/souls-hud/README.md) is the real
documentation — installation, every setting, the artwork, the tariff rule, the
holiday calendar. Read it before changing behaviour.

## Ground rules

These are not style preferences; each one has a test behind it, and each exists
because breaking it cost something real.

1. **No runtime dependencies.** The plugin ships none: it is plain ES modules, plain
   browser JavaScript, and a stylesheet. A dependency would have to be justified as
   more than convenience.
2. **Every user-visible string is in both languages.** The dictionary in
   `lib/client.js` has a `zh` and an `en` column, and `test/harness.mjs` fails if
   the key sets differ. There is no partial translation.
3. **Tests use fixtures, never live data.** The suite must pass on a machine that
   has never run the app. `test/preview.mjs` can read live vitals, but only with
   `--live`; the committed `preview/preview.html` is generated without it.
4. **The suite tells the truth about the app.** The harness resolves routes through
   a copy of the real request matcher rather than calling handlers directly — a
   route registered with a trailing slash passes a naive test and 404s for every
   user. When you add a guard, add it by *injecting the failure* first and watching
   the suite catch it.
5. **No one else's artwork, data or marks.** The medallion, its devices and the
   whale are this project's own drawings. `test/harness.mjs` fails if the app's own
   favicon path — or the word `favicon` — reappears in a shipped file. Data that is
   not ours (the holiday calendar) carries its licence and source in the README.
6. **The free promise is not negotiable.** No feature may be gated, licensed or
   sold. The tip jar on the bundle's page is for users who want to say thanks, and
   it unlocks nothing — `test/form.mjs` asserts the panel shows exactly the channels
   that are configured, nothing when none are, and nothing on any page but this
   bundle's.

## Getting set up

Node 20 or newer, no install step, no build step:

```sh
git clone https://github.com/tony1duan/builder-hud
cd builder-hud
node plugins/souls-hud/test/harness.mjs
```

For the browser-driven tests, a local Chrome is used in headless mode; the paths in
the test files assume macOS, and nothing else does.

## The suite

| Command | What it proves |
| --- | --- |
| `node plugins/souls-hud/test/harness.mjs` | the data path, every route (including the donation images and the refusals), the route matcher, the dictionaries, the marks |
| `node plugins/souls-hud/test/form.mjs` | the real settings component, mounted three times — shipped, configured, empty — plus `preview/form*.html` |
| `node plugins/souls-hud/test/upload.mjs` | the upload normalizer and the artwork, against hostile SVGs, in headless Chrome |
| `node plugins/souls-hud/test/devices.mjs --check` | `assets/devices/` still matches the renderer |
| `node plugins/builder-hud/test/icon.mjs --check` | the card artwork still matches the renderer |
| `node plugins/souls-hud/test/preview.mjs` | rebuilds `preview/preview.html` from the fixtures |

Run all of them before opening a pull request. The two `--check` scripts compare
committed artwork against what the renderer draws now: run them without `--check`
to regenerate after an artwork change, then with `--check` to confirm the committed
files are current.

## Where to touch what

| You want to change | Look at | Then regenerate |
| --- | --- | --- |
| What the sidebar draws | `lib/hud.js`, `lib/hud.css` | `test/icon.mjs`, `test/preview.mjs` |
| A setting, or the settings form | `lib/client.js` (`DICT` for copy, `settingsForm` for the form) | `test/form.mjs` |
| What data exists, or a route | `lib/host.js` | `test/harness.mjs` |
| The card (name, icon, description) | `plugins/builder-hud` | `plugins/builder-hud/test/icon.mjs` |

Two traps worth knowing before you start, both documented with their reasons in the
skin README: the **row must not be repeated** in the profile's own patch layer, and
the two packages need two names because the card's name comes from the bundle and
the row's from the skin.

## Changing something in the running app

The client half is re-composed per page load; the host half is a Node module loaded
at boot. So a change to `lib/host.js` needs a **full restart** of the app, while a
change to `lib/client.js` needs a reload. While the app is running:

```sh
curl -s http://127.0.0.1:19387/dsh-souls-hud/state.json | python3 -m json.tool
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  http://127.0.0.1:19387/dsh-souls-hud/support/wechat.png
```

## Pull requests

- One concern per pull request, with the *why* in the commit message — the tests
  say what changed, the message should say what it was for.
- Update the README when behaviour changes: the READMEs are the documentation, not
  a summary of it.
- If the change is user-visible, say what to look at in the app.

## Bugs and questions

Use the issue templates — they ask for the two things that make a bug reproducible
here: what the sidebar shows, and what the host reports at the same moment.

## Support

Contributions are unpaid; the tip jar is for users, not for contributors, and it
buys nobody a feature. See [the Support section](plugins/souls-hud/README.md#support).

## License

MIT. By contributing you agree your work is licensed under it.
