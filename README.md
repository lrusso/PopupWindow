# LRusso Popup Window

Chrome extension (Manifest V3) that moves a tab to a standalone window, without tabs bar, navigation bar and bookmark bar UI. The position and size of the pop-up window can be set globally or per URL.

# Features

- Toolbar button, context menu items and an optional keyboard shortcut (set it in `chrome://extensions/shortcuts`) to pop the current tab out, or merge it back into its original window.
- "Open this link in pop-up window" in the link context menu.
- Default pop-up position (center, a corner, or custom coordinates) and size.
- Per-URL rules that override position and size for specific pages.

# Per-URL settings

The default position and size apply to every pop-up window. In the preferences page you can also add rules that override them for specific pages:

- **URL pattern** — `*` is a wildcard, e.g. `https://*.google.com/*`. A pattern without `*` matches any URL containing that text, e.g. `web.whatsapp.com`.
- **Position** — one of the standard positions, a custom left/top, or "Use default".
- **Width / Height** — leave empty to keep the default value.

Rules are checked from top to bottom and the first match wins. The rule is matched against the URL of the tab being popped out, or the link URL when using "Open this link in pop-up window".

# Layout

- `src/` — the extension itself (`manifest.json`, scripts, options page, locales and icons). This is the folder to load unpacked and the one that gets zipped.
- `build.js` — build script, see below.
- `test.js` — tests for the service worker logic, see below.
- `dist/` — build output (zips for the Chrome Web Store).

# Icons

The PNGs in `src/icon/` are rendered from the SVGs next to them. Chrome uses them in different places:

- `icons` 16/32 in the manifest (`icon_black-*.png`): shown next to the extension's context menu items.
- `icons` 48/128 (`icon-*.png`, blue): shown in `chrome://extensions` and in the install dialog.
- `action.default_icon` (`icon-*.png`, blue): the toolbar button.

# Install

Get it from the Chrome Web Store: https://chromewebstore.google.com/detail/lrusso-popup-window/cnldjjbdhocgjcdikkhfjikdjdkcpjia

# Install from source (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `src` folder (the one that contains `manifest.json`).

# Test

Runs `src/background.js` in a Node sandbox with a simulated Chrome and checks the per-URL rules, the preference migration, pop-up creation and merging. No dependencies:

```sh
node test.js
```

# Build

Runs the tests and then creates `dist/lrusso-popup-window-<version>.zip`, the file to upload to the Chrome Web Store. If a test fails, no zip is built. It only needs Node.js, no dependencies:

```sh
node build.js
```

The version comes from `src/manifest.json`. The zip contains everything in `src/` except the SVG sources and dot files, plus `LICENSE`.

# Based on the work of

https://github.com/ettoolong/PopupWindow
