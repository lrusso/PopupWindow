#!/usr/bin/env node
// Runs src/background.js inside a Node sandbox with a simulated Chrome and checks
// the per-URL rules, the preference migration, pop-up creation and merging.
// Needs only Node.js (no dependencies): node test.js

"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const SOURCE = fs.readFileSync(path.join(__dirname, "src", "background.js"), "utf8")

let failures = 0
const check = (condition, message) => {
  console.log((condition ? "ok   " : "FAIL ") + message)
  if (!condition) failures++
}
const section = (title) => console.log(`\n${title}`)

// ---------------------------------------------------------------------------
// Simulated browser
// ---------------------------------------------------------------------------

// Any chrome.* member that is not stubbed below: a callable proxy whose call
// invokes a trailing callback with no arguments, so the promise wrappers in
// background.js resolve. addListener is a no-op (listeners would otherwise be
// invoked as callbacks).
const anything = (name) =>
  new Proxy(function () {}, {
    get: (target, prop) => (prop === Symbol.toPrimitive ? () => 0 : anything(prop)),
    apply: (target, self, args) => {
      if (name === "addListener") return
      let callback = args.find((arg) => typeof arg === "function")
      if (callback) callback()
    },
  })

const clone = (value) => JSON.parse(JSON.stringify(value))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// A browser with windows, a local storage (preferences), a session storage that
// outlives worker restarts, and a worker running background.js.
const browser = ({ windows = [], local = {} } = {}) => {
  let session = {}
  let calls = { localSet: [], localRemove: [], moved: [], created: [] }
  let worker = null

  const start = async () => {
    let listeners = {}
    let real = {
      runtime: {
        lastError: undefined,
        onMessage: { addListener() {} },
        onMessageExternal: { addListener() {} },
      },
      storage: {
        local: {
          get: (keys, callback) => callback(clone(local)),
          set: (items, callback) => {
            calls.localSet.push(clone(items))
            Object.assign(local, clone(items))
            if (callback) callback()
          },
          remove: (keys, callback) => {
            calls.localRemove.push(keys)
            if (callback) callback()
          },
        },
        session: {
          get: (keys, callback) => {
            let out = {}
            for (let key of [].concat(keys)) {
              if (key in session) out[key] = clone(session[key])
            }
            callback(out)
          },
          set: (items, callback) => {
            Object.assign(session, clone(items))
            if (callback) callback()
          },
        },
        onChanged: { addListener() {} },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        get: (id, callback) => callback(windows.find((w) => w.id === id)),
        getAll: (options, callback) =>
          callback(windows.filter((w) => options.windowTypes.includes(w.type))),
        getLastFocused: (options, callback) => callback(windows[0]),
        create: (options, callback) => {
          calls.created.push(options)
          if (callback) callback({ id: 999 })
        },
        update: (id, options, callback) => {
          if (callback) callback()
        },
        onRemoved: {
          addListener: (fn) => {
            listeners.removed = fn
          },
        },
        onFocusChanged: {
          addListener: (fn) => {
            listeners.focus = fn
          },
        },
      },
      tabs: {
        move: (tabId, options, callback) => {
          calls.moved.push({ tabId, windowId: options.windowId })
          if (callback) callback()
        },
        update: (id, options, callback) => {
          if (callback) callback()
        },
      },
      contextMenus: {
        update() {},
        create() {},
        removeAll: (callback) => callback && callback(),
        onClicked: { addListener() {} },
      },
      i18n: { getMessage: (id) => id },
    }
    let chrome = new Proxy(real, {
      get: (target, prop) => (prop in target ? target[prop] : anything(prop)),
    })
    let context = vm.createContext({ chrome, console, setTimeout })
    new vm.Script(SOURCE).runInContext(context)
    await vm.runInContext("ready", context)
    worker = { context, listeners }
  }

  const run = (code) => vm.runInContext(code, worker.context)

  return {
    windows,
    local,
    calls,
    start,
    restart: start,
    run,
    focus: async (id) => {
      worker.listeners.focus(id)
      await tick()
      await tick()
    },
    close: async (id) => {
      windows.splice(
        windows.findIndex((w) => w.id === id),
        1
      )
      worker.listeners.removed(id)
      await tick()
    },
    merge: async (tab, originalWindowId) => {
      await run(
        `mergeWindow(${JSON.stringify(tab)}, ${JSON.stringify(originalWindowId)})`
      )
      await tick()
    },
    popup: async (tab, url = null) => {
      await run(`popupWindow(${JSON.stringify(tab)}, ${JSON.stringify(url)})`)
      await tick()
      await tick()
    },
    lastMove: () => calls.moved[calls.moved.length - 1],
    lastCreate: () => calls.created[calls.created.length - 1],
  }
}

const PREFS = {
  version: 6,
  defaultPosition: 1,
  windowPositionLeft: 10,
  windowPositionTop: 20,
  windowWidth: 600,
  windowHeight: 300,
  urlRules: [],
}

// ---------------------------------------------------------------------------
// Per-URL rules
// ---------------------------------------------------------------------------

const testRules = async () => {
  section("Per-URL rules")
  let b = browser({ local: clone(PREFS) })
  await b.start()
  const settings = (rules, url) => {
    b.run(`preferences.urlRules = ${JSON.stringify(rules)}`)
    return b.run(`getWindowSettings(${JSON.stringify(url)})`)
  }
  const rule = (pattern, extra = {}) => ({
    pattern,
    position: -1,
    left: 0,
    top: 0,
    width: null,
    height: null,
    ...extra,
  })

  let s = settings([], "https://example.com/")
  check(
    s.position === 1 &&
      s.left === 10 &&
      s.top === 20 &&
      s.width === 600 &&
      s.height === 300,
    "no rules -> global defaults"
  )

  s = settings(
    [rule("https://*.google.com/*", { width: 900 })],
    "https://mail.google.com/mail/u/0"
  )
  check(s.width === 900, "wildcard pattern matches a subdomain and path")

  s = settings(
    [rule("https://*.google.com/*", { width: 900 })],
    "https://google.com/"
  )
  check(s.width === 600, "wildcard pattern is anchored: the whole URL must match")

  s = settings(
    [rule("https://*.google.com/*", { width: 900 })],
    "HTTPS://MAIL.GOOGLE.COM/X"
  )
  check(s.width === 900, "matching is case-insensitive")

  s = settings(
    [rule("web.whatsapp.com", { height: 700 })],
    "https://web.whatsapp.com/"
  )
  check(s.height === 700, "pattern without * matches any URL containing it")

  s = settings(
    [rule("WEB.WHATSAPP.COM", { height: 700 })],
    "https://web.whatsapp.com/"
  )
  check(s.height === 700, "substring match is case-insensitive too")

  s = settings([rule("*", { width: 111 })], "https://anything.example/")
  check(s.width === 111, "a lone * matches everything")

  s = settings(
    [rule("https://example.com/?a=1*", { width: 222 })],
    "https://example.com/?a=1&b=2"
  )
  check(s.width === 222, "regex characters in the pattern are literal (? matches ?)")

  s = settings(
    [rule("https://example.com/?a=1*", { width: 222 })],
    "https://example.com/xa=1"
  )
  check(s.width === 600, "regex characters do not act as regex (? is not optional)")

  s = settings(
    [
      rule("example.com", { width: 111 }),
      rule("https://example.com/*", { width: 222 }),
    ],
    "https://example.com/"
  )
  check(s.width === 111, "first matching rule wins")

  s = settings(
    [
      rule(""),
      rule("   "),
      null,
      { pattern: 42 },
      rule("example.com", { width: 333 }),
    ],
    "https://example.com/"
  )
  check(s.width === 333, "empty, blank and malformed rules are skipped")

  s = settings(
    [rule("example.com", { position: 5, left: 5, top: 6 })],
    "https://example.com/"
  )
  check(
    s.position === 5 && s.left === 5 && s.top === 6,
    "custom position takes left/top from the rule"
  )

  s = settings(
    [rule("example.com", { position: 2, left: 5, top: 6 })],
    "https://example.com/"
  )
  check(
    s.position === 2 && s.left === 10 && s.top === 20,
    "a corner position ignores the rule's left/top"
  )

  s = settings(
    [rule("example.com", { position: -1, width: 50 })],
    "https://example.com/"
  )
  check(
    s.position === 1 && s.width === 50,
    "position -1 keeps the default position but width still applies"
  )

  s = settings([rule("example.com", { position: 9 })], "https://example.com/")
  check(s.position === 1, "an invalid position falls back to the default")

  s = settings(
    [rule("example.com", { width: 0, height: "abc" })],
    "https://example.com/"
  )
  check(
    s.width === 600 && s.height === 300,
    "zero or non-numeric width/height keep the defaults"
  )

  s = settings([rule("example.com", { width: 800 })], undefined)
  check(s.width === 600, "no URL -> defaults")
}

// ---------------------------------------------------------------------------
// Preference migration
// ---------------------------------------------------------------------------

const testMigration = async () => {
  section("Preference migration")
  let base = {
    defaultPosition: 1,
    windowPositionLeft: 10,
    windowPositionTop: 20,
    windowWidth: 600,
    windowHeight: 300,
  }

  let b = browser({ local: {} })
  await b.start()
  let prefs = await b.run("ensurePreferences()")
  check(
    prefs.version === 6 &&
      Array.isArray(prefs.urlRules) &&
      prefs.windowWidth === 500,
    "fresh install -> defaults written, version 6"
  )
  check(
    b.calls.localSet.length === 1 && b.calls.localSet[0].version === 6,
    "fresh install -> written once"
  )

  b = browser({ local: { ...base, iconColor: 0, version: 4 } })
  await b.start()
  prefs = await b.run("ensurePreferences()")
  check(
    Array.isArray(prefs.urlRules) &&
      prefs.version === 6 &&
      prefs.windowWidth === 600,
    "old version -> missing keys added, version bumped, existing values kept"
  )
  check(
    b.calls.localSet.length === 1 &&
      b.calls.localSet[0].urlRules !== undefined &&
      b.calls.localSet[0].version === 6,
    "old version -> one write with the new keys and the version"
  )

  b = browser({ local: { ...base, urlRules: [], iconColor: 1, version: 5 } })
  await b.start()
  prefs = await b.run("ensurePreferences()")
  check(
    b.calls.localSet.length === 0 &&
      b.calls.localRemove.length === 0 &&
      prefs.iconColor === 1,
    "version 5 with no missing keys -> nothing written, unknown keys left alone"
  )

  b = browser({ local: clone(PREFS) })
  await b.start()
  await b.run("ensurePreferences()")
  check(b.calls.localSet.length === 0, "current version -> no writes")
}

// ---------------------------------------------------------------------------
// Pop-up creation
// ---------------------------------------------------------------------------

const testPopup = async () => {
  section("Pop-up creation")
  let b = browser({ windows: [{ id: 1, type: "normal" }], local: clone(PREFS) })
  await b.start()
  await b.popup({
    id: 42,
    windowId: 1,
    url: "https://example.com/",
    incognito: false,
  })
  let c = b.lastCreate()
  check(
    c &&
      c.type === "popup" &&
      c.tabId === 42 &&
      c.incognito === false &&
      c.width === 600 &&
      c.height === 300,
    "regular tab -> regular popup window with the configured size"
  )

  b = browser({
    windows: [{ id: 2, type: "normal", incognito: true }],
    local: clone(PREFS),
  })
  await b.start()
  await b.popup({
    id: 43,
    windowId: 2,
    url: "https://example.com/",
    incognito: true,
  })
  c = b.lastCreate()
  check(
    c && c.type === "popup" && c.tabId === 43 && c.incognito === true,
    "incognito tab -> incognito popup window"
  )

  b = browser({
    windows: [{ id: 2, type: "normal", incognito: true }],
    local: clone(PREFS),
  })
  await b.start()
  await b.popup(
    { id: 43, windowId: 2, url: "https://example.com/", incognito: true },
    "https://link.example/"
  )
  c = b.lastCreate()
  check(
    c &&
      c.url === "https://link.example/" &&
      c.tabId === undefined &&
      c.incognito === true,
    "link opened from an incognito page -> incognito popup with that URL"
  )

  b = browser({
    windows: [{ id: 1, type: "normal" }],
    local: {
      ...clone(PREFS),
      urlRules: [
        {
          pattern: "example.com",
          position: -1,
          left: 0,
          top: 0,
          width: 777,
          height: null,
        },
      ],
    },
  })
  await b.start()
  await b.popup({
    id: 42,
    windowId: 1,
    url: "https://example.com/",
    incognito: false,
  })
  c = b.lastCreate()
  check(
    c && c.width === 777 && c.height === 300,
    "a matching rule overrides the size of the new popup"
  )
}

// ---------------------------------------------------------------------------
// Merging back
// ---------------------------------------------------------------------------

const testMerge = async () => {
  section("Merging back")
  const normal = (id, extra = {}) => ({ id, type: "normal", ...extra })
  const popup = (id, extra = {}) => ({ id, type: "popup", ...extra })
  const tab = { id: 42, windowId: 7, incognito: false }
  const incognitoTab = { id: 42, windowId: 7, incognito: true }
  let b

  b = browser({ windows: [normal(1), normal(2), popup(7)], local: clone(PREFS) })
  await b.start()
  await b.focus(1)
  await b.focus(2)
  await b.focus(7)
  await b.merge(tab, 1)
  check(
    b.lastMove().windowId === 1,
    "origin window still open -> back to it, even if another window was focused later"
  )

  b = browser({
    windows: [normal(1), normal(2), normal(3), popup(7)],
    local: clone(PREFS),
  })
  await b.start()
  await b.focus(1)
  await b.focus(3)
  await b.focus(2)
  await b.focus(7)
  await b.close(2)
  await b.merge(tab, 2)
  check(
    b.lastMove().windowId === 3,
    "origin closed while the popup is focused -> most recently focused remaining window"
  )

  b = browser({
    windows: [normal(1), normal(2), normal(3), popup(7)],
    local: clone(PREFS),
  })
  await b.start()
  await b.focus(1)
  await b.focus(3)
  await b.focus(2)
  await b.focus(7)
  await b.close(2)
  await b.restart()
  await b.merge(tab, 2)
  check(
    b.lastMove().windowId === 3,
    "same, but the service worker restarted in between -> same window"
  )

  b = browser({
    windows: [normal(1), normal(2), normal(3), popup(7)],
    local: clone(PREFS),
  })
  await b.start()
  await b.focus(3)
  await b.focus(2)
  await b.focus(7)
  await b.close(2)
  await b.focus(1)
  await b.focus(7)
  await b.merge(tab, 2)
  check(
    b.lastMove().windowId === 1,
    "after closing the origin the user worked in another window -> that window"
  )

  b = browser({ windows: [normal(1), normal(2), popup(7)], local: clone(PREFS) })
  await b.start()
  await b.merge(tab, null)
  check(
    b.lastMove().windowId === 1,
    "no focus history at all -> first normal window"
  )

  b = browser({ windows: [popup(7)], local: clone(PREFS) })
  await b.start()
  await b.merge(tab, 5)
  check(
    b.calls.moved.length === 0 &&
      b.lastCreate().tabId === 42 &&
      b.lastCreate().type === "normal",
    "no normal window at all -> a new normal window is created with the tab"
  )

  b = browser({
    windows: [normal(1), normal(2, { incognito: true }), popup(7)],
    local: clone(PREFS),
  })
  await b.start()
  await b.focus(1)
  await b.focus(2)
  await b.focus(7)
  await b.merge(tab, 5)
  check(
    b.lastMove().windowId === 1,
    "regular tab, last focused window is incognito -> skipped"
  )

  b = browser({
    windows: [
      normal(1),
      normal(2, { incognito: true }),
      popup(7, { incognito: true }),
    ],
    local: clone(PREFS),
  })
  await b.start()
  await b.focus(2)
  await b.focus(1)
  await b.focus(7)
  await b.merge(incognitoTab, 5)
  check(
    b.lastMove().windowId === 2,
    "incognito tab, last focused window is regular -> skipped"
  )

  b = browser({
    windows: [normal(1), popup(7, { incognito: true })],
    local: clone(PREFS),
  })
  await b.start()
  await b.focus(1)
  await b.focus(7)
  await b.merge(incognitoTab, 5)
  check(
    b.calls.moved.length === 0 && b.lastCreate().incognito === true,
    "incognito tab with no incognito window -> a new incognito window is created"
  )
}

// ---------------------------------------------------------------------------

;(async () => {
  await testRules()
  await testMigration()
  await testPopup()
  await testMerge()
  console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed")
  process.exit(failures ? 1 : 0)
})()
