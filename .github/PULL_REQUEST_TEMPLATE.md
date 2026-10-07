<!--
  One concern per pull request. The tests say what changed; this says what it was
  for. If the change is user-visible, say what to look at in the app.
-->

## What this changes

## Why

<!--
  The reason, not the diff. If it fixes something, what did it break, and how did
  it show up? A commit message that only restates the diff is not a reason.
-->

## Which suite proves it

- [ ] `node plugins/souls-hud/test/harness.mjs`
- [ ] `node plugins/souls-hud/test/form.mjs`
- [ ] `node plugins/souls-hud/test/upload.mjs`
- [ ] `node plugins/souls-hud/test/devices.mjs --check`
- [ ] `node plugins/builder-hud/test/icon.mjs --check`
- [ ] `node plugins/souls-hud/test/preview.mjs`
- [ ] `node test/repo.mjs`

## Checklist

- [ ] No new runtime dependency (the plugin ships none, and that is a feature)
- [ ] Every user-visible string is in both `zh` and `en` — there is no partial translation
- [ ] Tests use fixtures, not live data
- [ ] The READMEs are updated where behaviour changed — they are the documentation, not a summary of it
- [ ] Any new guard was added by **injecting the failure first** and watching the suite catch it

## What to look at in the app

<!--
  Only for a user-visible change. A change to `lib/host.js` needs a full restart;
  a change to `lib/client.js` needs a page reload.
-->
