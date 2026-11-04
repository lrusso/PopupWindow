// Default preferences, shared by the service worker (importScripts) and the
// options page (script tag). Stored in chrome.storage.local.
const defaultPreference = {
  defaultPosition: 0,
  windowPositionLeft: 0,
  windowPositionTop: 0,
  windowWidth: 500,
  windowHeight: 400,
  // Per-URL overrides. Each rule: {pattern, position, left, top, width, height}
  //   pattern:  URL pattern. '*' is a wildcard; a pattern without '*' matches any URL containing it.
  //   position: -1 = use default, otherwise same values as defaultPosition (0..5).
  //   left/top: used when position === 5 (custom position).
  //   width/height: null = use default.
  // Rules are evaluated in order; the first match wins.
  urlRules: [],
  // Bump when a new key is added above: the migration adds missing keys.
  version: 6,
}
