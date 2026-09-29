# Donation images

The plugin is free; this directory is only for the payment codes that make a tip
possible. Nothing here changes what the plugin does.

Drop a file here and name it in `lib/client.js` — the WeChat 赞赏码 already shipped
is exactly that:

```js
var SUPPORT = {
  channels: [
    { id: "wechat", kind: "qr", file: "wechat.png" },
    { id: "alipay", kind: "qr", file: "" },        // empty: not rendered at all
  ],
};
```

The settings form then shows it under **支持作者 / Support the author**, at the
bottom of the plugin's own page. Until a `file` is filled in, that channel is not
rendered — an empty tip jar is worse than no tip jar.

Every code says **which app can read it**: the caption comes from
`support.<id>.scan` in the dictionary (`"只能微信扫一扫"` / `"WeChat app only"`),
and `test/harness.mjs` fails if a QR channel has no such line. That is not
decoration — a code is app-specific in a way a URL never is.

| Rule | Why |
| --- | --- |
| Names must match `^[a-z0-9][a-z0-9._-]*\.(png\|jpe?g\|webp\|svg)$` | The host serves this directory at `/dsh-souls-hud/support/<file>` and rejects anything else, so a name that cannot reach outside the directory never gets the chance. |
| Crop to the **code**, not the card | A payment app exports a decorated card — title, the code, a caption banner. The code is often under half the frame, and at tile size it becomes unscannable. Crop to the code with a comfortable white ring and throw the decoration away; the form supplies its own caption. |
| Keep a generous quiet margin — ~12% of the code on each side | The WeChat 赞赏码 is a ring of dots, not a dense grid, and it needs white space to lock on. `wechat.png` here is 591×591: a 477 px code plus a 57 px ring. |
| 400–600 px square, PNG | It is drawn at 200×200 CSS pixels and the tile links to the file itself for scanning, so 591 px is plenty sharp and still a 127 KB file. PNG, not JPEG: a code is hard edges, and JPEG puts rings around them. |
| Name the scanner, in both languages | A WeChat 赞赏码 is WeChat's own format: **Alipay and the camera app cannot read it**. Without the line, a supporter points the wrong scanner at it and concludes the plugin is broken. |
| One code per file | `wechat.png` and `alipay.png` are the conventional names, but any name matching the rule works. |
| Never a personal payment *link* | A QR image is a code, not a redirect; a `kind: "link"` channel may only be a public page such as 爱发电 or GitHub Sponsors. |
