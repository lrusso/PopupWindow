let currentPrefs = {};

const saveToPreference = (id, value) => {
  let update = {};
  update[id] = value;
  chrome.storage.local.set(update);
};

const handleVelueChange = id => {
  let elem = document.getElementById(id);
  if(elem) {
    let elemType = elem.getAttribute('type');
    if(elemType === 'checkbox') {
      elem.addEventListener('input', event => {
        saveToPreference(id, elem.checked ? true : false);
      });
    }
    else if(elemType === 'option') {
      elem.addEventListener('input', event => {
        saveToPreference(id, parseInt(elem.value));
      });
    }
    else if(elemType === 'number') {
      elem.addEventListener('input', event => {
        saveToPreference(id, parseInt(elem.value));
      });
    }
  }
};

const setValueToElem = (id, value) => {
  let elem = document.getElementById(id);
  if(elem) {
    let elemType = elem.getAttribute('type');
    if(elemType === 'checkbox') {
      elem.checked = value;
    }
    else if(elemType === 'option') {
      let options = Array.from(elem.querySelectorAll('option'));
      for(let option of options) {
        if(parseInt(option.getAttribute('value')) === value) {
          option.selected = true;
          break;
        }
      }
    }
    else if(elemType === 'number') {
      elem.value = value;
    }
  }
};

const onDefaultPositionChange = () => {
  let defaultPosition = document.getElementById('defaultPosition');
  let elems = Array.from(document.querySelectorAll('.windowPosition'));

  if(defaultPosition.value === '5') {
    elems.forEach(tag => {
      tag.classList.add('show');
      tag.classList.remove('hidden');
    });
  } else {
    elems.forEach(tag => {
      tag.classList.add('hidden');
      tag.classList.remove('show');
    });
  }
}

// ---- Per-URL rules -------------------------------------------------------

// Index in this array == position value stored in the rule (same as defaultPosition).
const POSITION_L10N_IDS = ['center', 'topLeft', 'bottomLeft', 'topRight', 'bottomRight', 'customPosition'];

const getUrlRules = () => {
  if(!Array.isArray(currentPrefs.urlRules)) {
    currentPrefs.urlRules = [];
  }
  return currentPrefs.urlRules;
};

const saveUrlRules = () => {
  chrome.storage.local.set({urlRules: getUrlRules()});
};

const parseOptionalInt = value => {
  let n = parseInt(value);
  return Number.isFinite(n) ? n : null;
};

const createRuleRow = (rule, index) => {
  let tr = document.createElement('tr');
  const addCell = child => {
    let td = document.createElement('td');
    if(child) td.appendChild(child);
    tr.appendChild(td);
    return td;
  };
  const makeNumber = (value, min, className) => {
    let input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.className = className;
    input.value = (value === null || value === undefined) ? '' : value;
    return input;
  };
  const makeButton = (label, l10nId, onClick) => {
    let button = document.createElement('button');
    button.type = 'button';
    button.className = 'ruleAction';
    button.textContent = label;
    button.title = chrome.i18n.getMessage(l10nId);
    button.addEventListener('click', onClick);
    return button;
  };

  // URL pattern
  let pattern = document.createElement('input');
  pattern.type = 'text';
  pattern.className = 'rulePattern';
  pattern.placeholder = 'https://*.example.com/*';
  pattern.value = rule.pattern || '';
  pattern.addEventListener('input', () => {
    rule.pattern = pattern.value;
    saveUrlRules();
  });
  addCell(pattern);

  // Position
  let position = document.createElement('select');
  let defaultOption = document.createElement('option');
  defaultOption.value = '-1';
  defaultOption.textContent = chrome.i18n.getMessage('useDefault');
  position.appendChild(defaultOption);
  POSITION_L10N_IDS.forEach((l10nId, value) => {
    let option = document.createElement('option');
    option.value = String(value);
    option.textContent = chrome.i18n.getMessage(l10nId);
    position.appendChild(option);
  });
  let rulePosition = parseOptionalInt(rule.position);
  position.value = String((rulePosition !== null && rulePosition >= 0 && rulePosition <= 5) ? rulePosition : -1);

  // Left / Top share the cell with the select and only show up for custom position;
  // they have no header, the tooltip tells them apart.
  let left = makeNumber(rule.left ?? 0, 0, 'ruleNumber');
  let top = makeNumber(rule.top ?? 0, 0, 'ruleNumber');
  left.title = chrome.i18n.getMessage('windowPositionLeft');
  top.title = chrome.i18n.getMessage('windowPositionTop');
  const updateCustomVisibility = () => {
    let custom = position.value === '5';
    left.classList.toggle('hidden', !custom);
    top.classList.toggle('hidden', !custom);
  };
  position.addEventListener('change', () => {
    rule.position = parseInt(position.value);
    updateCustomVisibility();
    saveUrlRules();
  });
  left.addEventListener('input', () => {
    rule.left = parseOptionalInt(left.value) ?? 0;
    saveUrlRules();
  });
  top.addEventListener('input', () => {
    rule.top = parseOptionalInt(top.value) ?? 0;
    saveUrlRules();
  });
  updateCustomVisibility();
  let positionCell = addCell(position);
  positionCell.appendChild(left);
  positionCell.appendChild(top);

  // Width / Height (empty == use default)
  let width = makeNumber(rule.width, 30, 'ruleNumber');
  let height = makeNumber(rule.height, 30, 'ruleNumber');
  width.placeholder = document.getElementById('windowWidth').value;
  height.placeholder = document.getElementById('windowHeight').value;
  width.addEventListener('input', () => {
    rule.width = parseOptionalInt(width.value);
    saveUrlRules();
  });
  height.addEventListener('input', () => {
    rule.height = parseOptionalInt(height.value);
    saveUrlRules();
  });
  addCell(width);
  addCell(height);

  // Actions
  addCell(makeButton('✕', 'removeUrlRule', () => {
    getUrlRules().splice(index, 1);
    saveUrlRules();
    renderUrlRules();
  }));

  return tr;
};

const renderUrlRules = () => {
  let rules = getUrlRules();
  let list = document.getElementById('urlRuleList');
  list.textContent = '';
  rules.forEach((rule, index) => {
    list.appendChild(createRuleRow(rule, index));
  });
  document.getElementById('urlRuleTable').classList.toggle('hidden', rules.length === 0);
  document.getElementById('urlRulesEmpty').classList.toggle('hidden', rules.length !== 0);
};

const addUrlRule = () => {
  getUrlRules().push({pattern: '', position: -1, left: 0, top: 0, width: null, height: null});
  saveUrlRules();
  renderUrlRules();
  let inputs = document.querySelectorAll('#urlRuleList input.rulePattern');
  if(inputs.length > 0) {
    inputs[inputs.length - 1].focus();
  }
};

// ---- Init ----------------------------------------------------------------

const init = preferences => {
  currentPrefs = preferences;
  for(let p in preferences) {
    setValueToElem(p, preferences[p]);
    handleVelueChange(p);
  }
  let l10nTags = Array.from(document.querySelectorAll('[data-l10n-id]'));
  l10nTags.forEach(tag => {
    tag.textContent = chrome.i18n.getMessage(tag.getAttribute('data-l10n-id'));
  });
  let defaultPosition = document.getElementById('defaultPosition');
  defaultPosition.addEventListener('change', event=>{
    onDefaultPositionChange();
  });
  onDefaultPositionChange();

  document.getElementById('addUrlRule').addEventListener('click', addUrlRule);
  renderUrlRules();
};

window.addEventListener('load', event => {
  chrome.storage.local.get(null, results => {
    if (results && results.version) {
      init(results);
    }
  });
}, true);
