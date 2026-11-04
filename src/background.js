// Background service worker (Manifest V3).
// The worker can be shut down at any time, so it must not rely on in-memory
// state surviving between events and must register every event listener
// synchronously at the top level.

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
  version: 6
};
let preferences = {};
const winMapping = new Map();    // normal windows: id -> {id, lastFocus}
const popupMapping = new Map();  // popup windows:  id -> {id, originalWindowId}

const MENU_OPEN_THIS_LINK = 'openThisLink';
const MENU_MOVE_THIS_PAGE = 'moveThisPage';

const sessionArea = chrome.storage.session; // undefined before Chrome 102

// ---- Small promise wrappers ---------------------------------------------------

const ignoreLastError = () => { void chrome.runtime.lastError; };

const storageGet = () => new Promise(resolve => {
  chrome.storage.local.get(null, results => resolve(results || {}));
});
const storageSet = items => new Promise(resolve => {
  chrome.storage.local.set(items, () => { ignoreLastError(); resolve(); });
});
const windowsGet = windowId => new Promise(resolve => {
  chrome.windows.get(windowId, win => { ignoreLastError(); resolve(win || null); });
});
const windowsGetAll = windowTypes => new Promise(resolve => {
  chrome.windows.getAll({windowTypes: windowTypes}, wins => { ignoreLastError(); resolve(wins || []); });
});
const windowsGetLastFocused = () => new Promise(resolve => {
  chrome.windows.getLastFocused({populate: true}, win => { ignoreLastError(); resolve(win || null); });
});
const tabsGet = tabId => new Promise(resolve => {
  chrome.tabs.get(tabId, tab => { ignoreLastError(); resolve(tab || null); });
});

// ---- Preferences --------------------------------------------------------------

let preferencesReady = null;

const loadPreference = async () => {
  let results = await storageGet();
  if (!results.version) {
    preferences = Object.assign({}, defaultPreference);
    await storageSet(defaultPreference);
  } else {
    preferences = results;
    if (preferences.version !== defaultPreference.version) {
      let update = {};
      let needUpdate = false;
      for (let p in defaultPreference) {
        if (preferences[p] === undefined) {
          update[p] = defaultPreference[p];
          preferences[p] = defaultPreference[p];
          needUpdate = true;
        }
      }
      if (needUpdate) {
        update.version = defaultPreference.version;
        preferences.version = defaultPreference.version;
        await storageSet(update);
      }
    }
  }
  return preferences;
};

const ensurePreferences = () => {
  if (!preferencesReady) {
    preferencesReady = loadPreference();
  }
  return preferencesReady;
};

// ---- Context menus ------------------------------------------------------------

// The page menu item says "Pop-up current page" in a normal window and
// "Merge current page" inside a pop-up window. Its title follows the focused
// window (see windows.onFocusChanged), since a right-click focuses the window
// before the menu is shown.
const pageMenuTitle = (windowInfo) => {
  let inPopup = windowInfo && windowInfo.type === 'popup';
  return chrome.i18n.getMessage(inPopup ? 'mergeThisPage' : 'popupThisPage');
};

const updatePageMenuTitle = async (windowId) => {
  let windowInfo = await windowsGet(windowId);
  if (!windowInfo) return;
  chrome.contextMenus.update(MENU_MOVE_THIS_PAGE, {title: pageMenuTitle(windowInfo)}, ignoreLastError);
};

// Menus are rebuilt from scratch so this is safe to call on every startup.
const rebuildMenus = async () => {
  let focused = await windowsGetLastFocused();
  await new Promise(resolve => {
    chrome.contextMenus.removeAll(() => {
      ignoreLastError();
      chrome.contextMenus.create({
        id: MENU_OPEN_THIS_LINK,
        title: chrome.i18n.getMessage('openThisLink'),
        contexts: ['link']
      }, ignoreLastError);
      chrome.contextMenus.create({
        id: MENU_MOVE_THIS_PAGE,
        title: pageMenuTitle(focused),
        contexts: ['page', 'frame']
      }, ignoreLastError);
      resolve();
    });
  });
};

// ---- Per-URL rules ------------------------------------------------------------

// Convert a user pattern into a RegExp. '*' matches any sequence of characters,
// everything else is matched literally. Matching is case-insensitive.
const patternToRegExp = (pattern) => {
  let parts = pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + parts.join('.*') + '$', 'i');
};

// Return the first rule in preferences.urlRules that matches the given URL, or null.
const findUrlRule = (url) => {
  if (!url || !Array.isArray(preferences.urlRules)) {
    return null;
  }
  for (let rule of preferences.urlRules) {
    if (!rule || typeof rule.pattern !== 'string') {
      continue;
    }
    let pattern = rule.pattern.trim();
    if (pattern === '') {
      continue;
    }
    try {
      if (pattern.indexOf('*') === -1) {
        // No wildcard: match any URL that contains the text.
        if (url.toLowerCase().indexOf(pattern.toLowerCase()) !== -1) {
          return rule;
        }
      }
      else if (patternToRegExp(pattern).test(url)) {
        return rule;
      }
    } catch (e) {
      // Ignore malformed patterns.
    }
  }
  return null;
};

const toPositiveInt = (value) => {
  let n = parseInt(value);
  return (Number.isFinite(n) && n > 0) ? n : null;
};

// Merge the global preferences with the per-URL rule (if any) for this URL.
const getWindowSettings = (url) => {
  let settings = {
    position: preferences.defaultPosition,
    left: preferences.windowPositionLeft,
    top: preferences.windowPositionTop,
    width: preferences.windowWidth,
    height: preferences.windowHeight
  };
  let rule = findUrlRule(url);
  if (rule) {
    let position = parseInt(rule.position);
    if (Number.isFinite(position) && position >= 0 && position <= 5) {
      settings.position = position;
      if (position === 5) {
        let left = parseInt(rule.left);
        let top = parseInt(rule.top);
        settings.left = Number.isFinite(left) ? left : 0;
        settings.top = Number.isFinite(top) ? top : 0;
      }
    }
    let width = toPositiveInt(rule.width);
    let height = toPositiveInt(rule.height);
    if (width !== null) settings.width = width;
    if (height !== null) settings.height = height;
  }
  return settings;
};

// ---- Screen geometry ----------------------------------------------------------

// Returns {left, top, width, height} of the usable area of the display that
// contains the source window (or the primary display).
const getWorkArea = async (sourceWindowId) => {
  let displays = await new Promise(resolve => {
    chrome.system.display.getInfo(info => { ignoreLastError(); resolve(info || []); });
  });
  if (displays.length === 0) {
    return {left: 0, top: 0, width: 1280, height: 800};
  }
  let display = displays.find(d => d.isPrimary) || displays[0];
  if (displays.length > 1 && sourceWindowId !== undefined && sourceWindowId !== null) {
    let win = await windowsGet(sourceWindowId);
    if (win && typeof win.left === 'number' && typeof win.top === 'number') {
      let cx = win.left + (win.width || 0) / 2;
      let cy = win.top + (win.height || 0) / 2;
      let hit = displays.find(d => {
        let b = d.workArea;
        return cx >= b.left && cx < b.left + b.width && cy >= b.top && cy < b.top + b.height;
      });
      if (hit) display = hit;
    }
  }
  let b = display.workArea || display.bounds;
  return {left: b.left, top: b.top, width: b.width, height: b.height};
};

// ---- Popup / merge ------------------------------------------------------------

const popupWindow = async (tab, targetUrl, winLeft, winTop, winWidth, winHeight) => {
  await ensurePreferences();
  let settings = getWindowSettings(targetUrl || (tab ? tab.url : undefined));
  let width = winWidth ?? settings.width;
  let height = winHeight ?? settings.height;

  let area = await getWorkArea(tab ? tab.windowId : undefined);
  let sTop = area.top;
  let sLeft = area.left;
  let sWidth = area.width;
  let sHeight = area.height;
  let top = sTop;
  let left = sLeft;
  if (settings.position === 0) {
    top = sTop + Math.round((sHeight - height)/2);
    left = sLeft + Math.round((sWidth - width)/2);
  }
  else if (settings.position === 5) {
    top = settings.top;
    left = settings.left;
  }
  else {
    if (settings.position === 2 || settings.position === 4) {
      top = sTop + sHeight - height;
      if (top < sTop) {
        top = sTop;
      }
    }
    if (settings.position === 3 || settings.position === 4) {
      left = sLeft + sWidth - width;
      if (left < sLeft) {
        left = sLeft;
      }
    }
  }
  if (winTop !== undefined) {
    top = winTop;
  }
  if (winLeft !== undefined) {
    left = winLeft;
  }

  let setting = {
    type: 'popup',
    top: top,
    left: left,
    width: width,
    height: height,
  };
  if (targetUrl) {
    setting.url = targetUrl;
  }
  else {
    setting.tabId = tab.id;
  }
  chrome.windows.create(setting, windowInfo => {
    ignoreLastError();
    if (!windowInfo) return;
    chrome.windows.update(windowInfo.id, {focused: true, top: top, left: left}, ignoreLastError);
    addToPopupMapping(windowInfo, tab ? tab.windowId : null);
  });
};

const moveTab = (tabId, windowId) => {
  chrome.tabs.move(tabId, {windowId: windowId, index: -1}, () => {
    ignoreLastError();
    chrome.windows.update(windowId, {focused: true}, ignoreLastError);
    chrome.tabs.update(tabId, {active: true}, ignoreLastError);
  });
};

const mergeWindow = async (tab, windowId) => {
  let window = windowId ? winMapping.get(windowId) : null;
  if (!window) {
    for (let w of winMapping.values()) {
      if (!window || w.lastFocus > window.lastFocus) {
        window = w;
      }
    }
  }

  if (window) {
    moveTab(tab.id, window.id);
  }
  else {
    let normalWindows = await windowsGetAll(['normal']);
    if (normalWindows.length === 0) { // no normal window left, create one
      chrome.windows.create({
        tabId: tab.id,
        type: 'normal'
      }, ignoreLastError);
    }
    else {
      moveTab(tab.id, normalWindows[0].id);
    }
  }
};

// Pop the tab out, or merge it back if it is already in one of our popups.
const popupOrMerge = async (tab) => {
  let windowInfo = await windowsGet(tab.windowId);
  if (windowInfo && windowInfo.type === 'popup') {
    let popup = popupMapping.get(windowInfo.id);
    mergeWindow(tab, popup ? popup.originalWindowId : null);
  }
  else {
    popupWindow(tab);
  }
};

// ---- Window bookkeeping -------------------------------------------------------

const addToWinMapping = window => {
  winMapping.set(window.id, {
    id: window.id,
    lastFocus: 0
  });
};

const addToPopupMapping = (window, originalWindowId) => {
  popupMapping.set(window.id, {
    id: window.id,
    originalWindowId: originalWindowId
  });
  savePopupMapping();
};

// The service worker can be shut down at any time, so remember which popup came
// from which window in session storage (when available).
const savePopupMapping = () => {
  if (!sessionArea) return;
  let data = {};
  for (let [id, popup] of popupMapping) {
    data[id] = popup.originalWindowId;
  }
  sessionArea.set({popupMapping: data}, ignoreLastError);
};

const restorePopupMapping = () => new Promise(resolve => {
  if (!sessionArea) {
    resolve({});
    return;
  }
  sessionArea.get('popupMapping', res => {
    ignoreLastError();
    resolve((res && res.popupMapping) || {});
  });
});

// ---- Startup ------------------------------------------------------------------

const init = async () => {
  try {
    await ensurePreferences();
    let saved = await restorePopupMapping();
    let windowInfos = await windowsGetAll(['normal', 'popup']);
    for (let windowInfo of windowInfos) {
      if (windowInfo.type === 'normal') {
        addToWinMapping(windowInfo);
      }
      else if (windowInfo.type === 'popup') {
        let originalWindowId = saved[windowInfo.id];
        popupMapping.set(windowInfo.id, {
          id: windowInfo.id,
          originalWindowId: (originalWindowId !== undefined) ? originalWindowId : null
        });
      }
    }
    savePopupMapping();
    await rebuildMenus();
  } catch (e) {
    console.error('PopupWindow init failed', e);
  }
};

const ready = init();

// ---- Event listeners (must be registered synchronously) -----------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  ready.then(() => {
    for (let item of Object.keys(changes)) {
      preferences[item] = changes[item].newValue;
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  ready.then(() => {
    switch (info.menuItemId) {
      case MENU_OPEN_THIS_LINK:
        popupWindow(tab, info.linkUrl);
        break;
      case MENU_MOVE_THIS_PAGE:
        popupOrMerge(tab);
        break;
    }
  });
});

chrome.action.onClicked.addListener(tab => {
  ready.then(() => popupWindow(tab));
});

chrome.windows.onRemoved.addListener(windowId => {
  if (winMapping.get(windowId)) {
    winMapping.delete(windowId);
  }
  else if (popupMapping.get(windowId)) {
    popupMapping.delete(windowId);
    savePopupMapping();
  }
});

chrome.windows.onCreated.addListener(windowInfo => {
  if (windowInfo.type === 'normal') {
    addToWinMapping(windowInfo);
  }
});

chrome.windows.onFocusChanged.addListener(windowId => {
  let window = winMapping.get(windowId);
  if (window) {
    window.lastFocus = performance.now();
  }
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  ready.then(() => updatePageMenuTitle(windowId));
});

chrome.commands.onCommand.addListener(command => {
  if (command !== 'popupWindow') return;
  ready.then(async () => {
    let windowInfo = await windowsGetLastFocused();
    if (!windowInfo || !windowInfo.tabs) return;
    let tab = windowInfo.tabs.find(t => t.active);
    if (!tab) return;
    if (windowInfo.type === 'popup') {
      let popup = popupMapping.get(windowInfo.id);
      mergeWindow(tab, popup ? popup.originalWindowId : null);
    }
    else {
      popupWindow(tab);
    }
  });
});

// Other extensions can ask us to pop a tab out:
//   chrome.runtime.sendMessage(extensionId, {action: 'popupWindow', tabId, left, top, width, height})
const messageHandler = (message, sender, sendResponse) => {
  if (message && message.action === 'popupWindow') {
    ready.then(async () => {
      let tab = await tabsGet(message.tabId);
      if (!tab) return;
      if (message.left && message.top) {
        popupWindow(tab, null, message.left, message.top, message.width, message.height);
      } else {
        popupWindow(tab);
      }
    });
  }
  else if (message && message.action === 'ack') {
    sendResponse({result:'ok'});
  }
};

chrome.runtime.onMessage.addListener(messageHandler);
chrome.runtime.onMessageExternal.addListener(messageHandler);
