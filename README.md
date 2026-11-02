# LRusso Popup Window
Chrome extension (Manifest V3) that moves a tab to a standalone window, without tabs bar, navigation bar and bookmark bar UI.

Based on [PopupWindow](https://github.com/ettoolong/PopupWindow) by ettoolong, MIT License.

# Features
* Toolbar button, context menu items and an optional keyboard shortcut (set it in `chrome://extensions/shortcuts`) to pop the current tab out, or merge it back into its original window.
* "Open this link in pop-up window" in the link context menu.
* Default pop-up position (center, a corner, or custom coordinates) and size.
* Per-URL rules that override position and size for specific pages.

# Per-URL settings
The default position and size apply to every pop-up window. In the preferences page you can also add rules that override them for specific pages:

* **URL pattern** — `*` is a wildcard, e.g. `https://*.google.com/*`. A pattern without `*` matches any URL containing that text, e.g. `web.whatsapp.com`.
* **Position** — one of the standard positions, a custom left/top, or "Use default".
* **Width / Height** — leave empty to keep the default value.

Rules are checked from top to bottom and the first match wins. The rule is matched against the URL of the tab being popped out, or the link URL when using "Open this link in pop-up window". Window geometry passed by another extension via `chrome.runtime.sendMessage` still takes precedence over any rule.

# Icons
The PNGs in `icon/` are rendered from the SVGs next to them. Chrome uses them in different places:

* `icons` 16/32 in the manifest (`icon_black-*.png`): shown next to the extension's context menu items.
* `icons` 48/128 (`icon-*.png`, blue): shown in `chrome://extensions` and in the install dialog.
* `action.default_icon` (`icon-*.png`, blue) and `icon_w-*.png` (light): the toolbar button, switchable in the preferences.

# Install (unpacked)
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder (the one that contains `manifest.json`).

# Build
Creates the zip to upload to the Chrome Web Store:

```sh
mkdir -p web-ext-artifacts
zip -r -X web-ext-artifacts/lrusso-popup-window-$(node -p "require('./manifest.json').version").zip \
  manifest.json background.js options.html options.js options.css LICENSE README.md _locales icon \
  -x "icon/*.svg" -x "*.DS_Store"
```

# Contributing
For updating/creating language translations please create a pull request; for new languages please start with [this file](_locales/en/messages.json) and translate it, storing it with the appropriate language tag (for a list of tags, see [here](https://developer.chrome.com/docs/webstore/i18n/?localeTable#choosing-locales-to-support)).
