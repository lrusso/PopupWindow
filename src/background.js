// Background service worker (Manifest V3).
// The worker can be shut down at any time, so it must not rely on in-memory
// state surviving between events and must register every event listener
// synchronously at the top level.

importScripts("defaults.js") // defaultPreference

let preferences = {}
const popupMapping = new Map() // popup windows: id -> {id, originalWindowId}
let focusedNormalWindows = [] // ids of normal windows, most recently focused first

const MENU_OPEN_THIS_LINK = "openThisLink"
const MENU_MOVE_THIS_PAGE = "moveThisPage"

const sessionArea = chrome.storage.session

// ---- Small promise wrappers ---------------------------------------------------

const ignoreLastError = () => {
  void chrome.runtime.lastError
}

const storageGet = () =>
  new Promise((resolve) => {
    chrome.storage.local.get(null, (results) => resolve(results || {}))
  })
const storageSet = (items) =>
  new Promise((resolve) => {
    chrome.storage.local.set(items, () => {
      ignoreLastError()
      resolve()
    })
  })
const windowsGet = (windowId) =>
  new Promise((resolve) => {
    chrome.windows.get(windowId, (win) => {
      ignoreLastError()
      resolve(win || null)
    })
  })
const windowsGetAll = (windowTypes) =>
  new Promise((resolve) => {
    chrome.windows.getAll({ windowTypes: windowTypes }, (wins) => {
      ignoreLastError()
      resolve(wins || [])
    })
  })
const windowsGetLastFocused = (options = {}) =>
  new Promise((resolve) => {
    chrome.windows.getLastFocused(options, (win) => {
      ignoreLastError()
      resolve(win || null)
    })
  })

// ---- Preferences --------------------------------------------------------------

let preferencesReady = null

const loadPreference = async () => {
  let results = await storageGet()
  if (!results.version) {
    preferences = Object.assign({}, defaultPreference)
    await storageSet(defaultPreference)
  } else {
    preferences = results
    if (preferences.version !== defaultPreference.version) {
      let update = {}
      let needUpdate = false
      for (let p in defaultPreference) {
        if (preferences[p] === undefined) {
          update[p] = defaultPreference[p]
          preferences[p] = defaultPreference[p]
          needUpdate = true
        }
      }
      if (needUpdate) {
        update.version = defaultPreference.version
        preferences.version = defaultPreference.version
        await storageSet(update)
      }
    }
  }
  return preferences
}

const ensurePreferences = () => {
  if (!preferencesReady) {
    preferencesReady = loadPreference()
  }
  return preferencesReady
}

// ---- Context menus ------------------------------------------------------------

// Remembers the focus order of normal windows, used when merging.
const onWindowFocused = async (windowId) => {
  let windowInfo = await windowsGet(windowId)
  if (!windowInfo) return
  if (windowInfo.type === "normal" && focusedNormalWindows[0] !== windowId) {
    focusedNormalWindows = [
      windowId,
      ...focusedNormalWindows.filter((id) => id !== windowId),
    ].slice(0, 20)
    saveFocusedNormalWindows()
  }
}

// Menus are rebuilt from scratch so this is safe to call on every startup.
// The page item has one title for both cases: Chrome can't change it per window,
// and on macOS a right-click on a background window doesn't focus it.
const rebuildMenus = async () => {
  await new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      ignoreLastError()
      chrome.contextMenus.create(
        {
          id: MENU_OPEN_THIS_LINK,
          title: chrome.i18n.getMessage("openThisLink"),
          contexts: ["link"],
        },
        ignoreLastError
      )
      chrome.contextMenus.create(
        {
          id: MENU_MOVE_THIS_PAGE,
          title: chrome.i18n.getMessage("moveThisPage"),
          contexts: ["page", "frame"],
        },
        ignoreLastError
      )
      resolve()
    })
  })
}

const setActionIcon = () => {
  let base = preferences.iconColor === 1 ? "icon/icon_w" : "icon/icon"
  chrome.action.setIcon(
    {
      path: {
        16: base + "-16.png",
        32: base + "-32.png",
        48: base + "-48.png",
      },
    },
    ignoreLastError
  )
}

// ---- Per-URL rules ------------------------------------------------------------

// Convert a user pattern into a RegExp. '*' matches any sequence of characters,
// everything else is matched literally. Matching is case-insensitive.
const patternToRegExp = (pattern) => {
  let parts = pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp("^" + parts.join(".*") + "$", "i")
}

// Return the first rule in preferences.urlRules that matches the given URL, or null.
const findUrlRule = (url) => {
  if (!url || !Array.isArray(preferences.urlRules)) {
    return null
  }
  for (let rule of preferences.urlRules) {
    if (!rule || typeof rule.pattern !== "string") {
      continue
    }
    let pattern = rule.pattern.trim()
    if (pattern === "") {
      continue
    }
    try {
      if (pattern.indexOf("*") === -1) {
        // No wildcard: match any URL that contains the text.
        if (url.toLowerCase().indexOf(pattern.toLowerCase()) !== -1) {
          return rule
        }
      } else if (patternToRegExp(pattern).test(url)) {
        return rule
      }
    } catch (e) {
      // Ignore malformed patterns.
    }
  }
  return null
}

const toPositiveInt = (value) => {
  let n = parseInt(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

// Merge the global preferences with the per-URL rule (if any) for this URL.
const getWindowSettings = (url) => {
  let settings = {
    position: preferences.defaultPosition,
    left: preferences.windowPositionLeft,
    top: preferences.windowPositionTop,
    width: preferences.windowWidth,
    height: preferences.windowHeight,
  }
  let rule = findUrlRule(url)
  if (rule) {
    let position = parseInt(rule.position)
    if (Number.isFinite(position) && position >= 0 && position <= 5) {
      settings.position = position
      if (position === 5) {
        let left = parseInt(rule.left)
        let top = parseInt(rule.top)
        settings.left = Number.isFinite(left) ? left : 0
        settings.top = Number.isFinite(top) ? top : 0
      }
    }
    let width = toPositiveInt(rule.width)
    let height = toPositiveInt(rule.height)
    if (width !== null) settings.width = width
    if (height !== null) settings.height = height
  }
  return settings
}

// ---- Screen geometry ----------------------------------------------------------

// Returns {left, top, width, height} of the usable area of the display that
// contains the source window (or the primary display).
const getWorkArea = async (sourceWindowId) => {
  let displays = await new Promise((resolve) => {
    chrome.system.display.getInfo((info) => {
      ignoreLastError()
      resolve(info || [])
    })
  })
  if (displays.length === 0) {
    return { left: 0, top: 0, width: 1280, height: 800 }
  }
  let display = displays.find((d) => d.isPrimary) || displays[0]
  if (
    displays.length > 1 &&
    sourceWindowId !== undefined &&
    sourceWindowId !== null
  ) {
    let win = await windowsGet(sourceWindowId)
    if (win && typeof win.left === "number" && typeof win.top === "number") {
      let cx = win.left + (win.width || 0) / 2
      let cy = win.top + (win.height || 0) / 2
      let hit = displays.find((d) => {
        let b = d.workArea
        return (
          cx >= b.left &&
          cx < b.left + b.width &&
          cy >= b.top &&
          cy < b.top + b.height
        )
      })
      if (hit) display = hit
    }
  }
  let b = display.workArea || display.bounds
  return { left: b.left, top: b.top, width: b.width, height: b.height }
}

// ---- Popup / merge ------------------------------------------------------------

// Open the tab (or targetUrl, for links) in a pop-up window placed and sized
// according to the preferences and the per-URL rules.
const popupWindow = async (tab, targetUrl) => {
  await ensurePreferences()
  let settings = getWindowSettings(targetUrl || (tab ? tab.url : undefined))
  let width = settings.width
  let height = settings.height

  let area = await getWorkArea(tab ? tab.windowId : undefined)
  let sTop = area.top
  let sLeft = area.left
  let sWidth = area.width
  let sHeight = area.height
  let top = sTop
  let left = sLeft
  if (settings.position === 0) {
    top = sTop + Math.round((sHeight - height) / 2)
    left = sLeft + Math.round((sWidth - width) / 2)
  } else if (settings.position === 5) {
    top = settings.top
    left = settings.left
  } else {
    if (settings.position === 2 || settings.position === 4) {
      top = sTop + sHeight - height
      if (top < sTop) {
        top = sTop
      }
    }
    if (settings.position === 3 || settings.position === 4) {
      left = sLeft + sWidth - width
      if (left < sLeft) {
        left = sLeft
      }
    }
  }

  let setting = {
    type: "popup",
    incognito: !!(tab && tab.incognito), // an incognito tab (or a link in one) stays incognito
    top: top,
    left: left,
    width: width,
    height: height,
  }
  if (targetUrl) {
    setting.url = targetUrl
  } else {
    setting.tabId = tab.id
  }
  chrome.windows.create(setting, (windowInfo) => {
    ignoreLastError()
    if (!windowInfo) return
    chrome.windows.update(
      windowInfo.id,
      { focused: true, top: top, left: left },
      ignoreLastError
    )
    addToPopupMapping(windowInfo, tab ? tab.windowId : null)
  })
}

const moveTab = (tabId, windowId) => {
  chrome.tabs.move(tabId, { windowId: windowId, index: -1 }, () => {
    ignoreLastError()
    chrome.windows.update(windowId, { focused: true }, ignoreLastError)
    chrome.tabs.update(tabId, { active: true }, ignoreLastError)
  })
}

// Whether the tab can be moved into this window: a normal window in the same
// mode (Chrome does not move tabs between incognito and regular windows).
const canHold = (windowInfo, tab) =>
  !!windowInfo &&
  windowInfo.type === "normal" &&
  !!windowInfo.incognito === !!tab.incognito

// The window with this id, if it still exists and can hold the tab.
const windowFor = async (windowId, tab) => {
  if (windowId === null || windowId === undefined) return null
  let windowInfo = await windowsGet(windowId)
  return canHold(windowInfo, tab) ? windowInfo : null
}

// Move the tab back to the window it came from. If that window is gone, use the
// most recently focused normal window that still exists; if there is none, open a new one.
const mergeWindow = async (tab, originalWindowId) => {
  let target = await windowFor(originalWindowId, tab)
  for (let i = 0; !target && i < focusedNormalWindows.length; i++) {
    target = await windowFor(focusedNormalWindows[i], tab)
  }
  if (!target) {
    target = (await windowsGetAll(["normal"])).find((w) => canHold(w, tab)) || null
  }
  if (target) {
    moveTab(tab.id, target.id)
  } else {
    chrome.windows.create(
      { tabId: tab.id, type: "normal", incognito: !!tab.incognito },
      ignoreLastError
    )
  }
}

// Pop the tab out, or merge it back if it is already in one of our popups.
const popupOrMerge = async (tab) => {
  let windowInfo = await windowsGet(tab.windowId)
  if (windowInfo && windowInfo.type === "popup") {
    let popup = popupMapping.get(windowInfo.id)
    mergeWindow(tab, popup ? popup.originalWindowId : null)
  } else {
    popupWindow(tab)
  }
}

// ---- Popup bookkeeping --------------------------------------------------------

const addToPopupMapping = (window, originalWindowId) => {
  popupMapping.set(window.id, {
    id: window.id,
    originalWindowId: originalWindowId,
  })
  savePopupMapping()
}

// The service worker can be shut down at any time, so remember which popup came
// from which window, and the focus order of normal windows, in session storage.
const savePopupMapping = () => {
  let data = {}
  for (let [id, popup] of popupMapping) {
    data[id] = popup.originalWindowId
  }
  sessionArea.set({ popupMapping: data }, ignoreLastError)
}

const saveFocusedNormalWindows = () => {
  sessionArea.set({ focusedNormalWindows: focusedNormalWindows }, ignoreLastError)
}

const restoreSession = () =>
  new Promise((resolve) => {
    sessionArea.get(["popupMapping", "focusedNormalWindows"], (res) => {
      ignoreLastError()
      resolve(res || {})
    })
  })

// ---- Startup ------------------------------------------------------------------

const init = async () => {
  try {
    await ensurePreferences()
    let saved = await restoreSession()
    let savedPopups = saved.popupMapping || {}
    focusedNormalWindows = Array.isArray(saved.focusedNormalWindows)
      ? saved.focusedNormalWindows
      : []
    let popups = await windowsGetAll(["popup"])
    for (let windowInfo of popups) {
      let originalWindowId = savedPopups[windowInfo.id]
      popupMapping.set(windowInfo.id, {
        id: windowInfo.id,
        originalWindowId: originalWindowId !== undefined ? originalWindowId : null,
      })
    }
    savePopupMapping()
    await rebuildMenus()
    setActionIcon()
  } catch (e) {
    console.error("PopupWindow init failed", e)
  }
}

const ready = init()

// ---- Event listeners (must be registered synchronously) -----------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return
  ready.then(() => {
    for (let item of Object.keys(changes)) {
      preferences[item] = changes[item].newValue
      if (item === "iconColor") {
        setActionIcon()
      }
    }
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return
  ready.then(() => {
    switch (info.menuItemId) {
      case MENU_OPEN_THIS_LINK:
        popupWindow(tab, info.linkUrl)
        break
      case MENU_MOVE_THIS_PAGE:
        popupOrMerge(tab)
        break
    }
  })
})

chrome.action.onClicked.addListener((tab) => {
  ready.then(() => popupWindow(tab))
})

chrome.windows.onRemoved.addListener((windowId) => {
  if (popupMapping.delete(windowId)) {
    savePopupMapping()
  }
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  ready.then(() => onWindowFocused(windowId))
})

chrome.commands.onCommand.addListener((command) => {
  if (command !== "popupWindow") return
  ready.then(async () => {
    let windowInfo = await windowsGetLastFocused({ populate: true })
    if (!windowInfo || !windowInfo.tabs) return
    let tab = windowInfo.tabs.find((t) => t.active)
    if (!tab) return
    if (windowInfo.type === "popup") {
      let popup = popupMapping.get(windowInfo.id)
      mergeWindow(tab, popup ? popup.originalWindowId : null)
    } else {
      popupWindow(tab)
    }
  })
})
