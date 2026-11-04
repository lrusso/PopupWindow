let currentPrefs = {};

const saveToPreference = (id, value) => {
  let update = {};
  update[id] = value;
  chrome.storage.local.set(update);
};

// Integer in a number input, or undefined when it is empty or outside its min/max.
// Those states show up while typing and are ignored instead of saved.
const readNumber = input => {
  let n = parseInt(input.value);
  return (input.validity.valid && Number.isFinite(n)) ? n : undefined;
};

const handleVelueChange = id => {
  let elem = document.getElementById(id);
  if(elem) {
    let elemType = elem.getAttribute('type');
    if(elemType === 'option') {
      elem.addEventListener('input', event => {
        saveToPreference(id, parseInt(elem.value));
      });
    }
    else if(elemType === 'number') {
      elem.addEventListener('input', event => {
        let n = readNumber(elem);
        if(n !== undefined) {
          saveToPreference(id, n);
        }
      });
    }
  }
};

const setValueToElem = (id, value) => {
  let elem = document.getElementById(id);
  if(elem) {
    let elemType = elem.getAttribute('type');
    if(elemType === 'option') {
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
  // Saves the input into rule[key] as it changes. An empty input stores emptyValue;
  // an invalid or out-of-range one keeps the last saved value.
  const bindRuleNumber = (input, key, emptyValue) => {
    input.addEventListener('input', () => {
      let value = input.value === '' ? emptyValue : readNumber(input);
      if(value === undefined) return;
      rule[key] = value;
      saveUrlRules();
    });
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
  bindRuleNumber(left, 'left', 0);
  bindRuleNumber(top, 'top', 0);
  updateCustomVisibility();
  let positionCell = addCell(position);
  positionCell.appendChild(left);
  positionCell.appendChild(top);

  // Width / Height (empty == use default)
  let width = makeNumber(rule.width, 1, 'ruleNumber');
  let height = makeNumber(rule.height, 1, 'ruleNumber');
  width.placeholder = document.getElementById('windowWidth').value;
  height.placeholder = document.getElementById('windowHeight').value;
  bindRuleNumber(width, 'width', null);
  bindRuleNumber(height, 'height', null);
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
