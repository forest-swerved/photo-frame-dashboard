function key(node) {
  return node.nodeType === Node.ELEMENT_NODE
    ? node.getAttribute('data-key') || node.id || (node.hasAttribute('data-form') ? `form:${node.getAttribute('data-form')}` : null)
    : null;
}

function compatible(current, desired) {
  return current.nodeType === desired.nodeType && current.nodeName === desired.nodeName;
}

function patch(current, desired) {
  if (current.nodeType !== Node.ELEMENT_NODE) {
    if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
    return;
  }
  const valueChanged = current.getAttribute('value') !== desired.getAttribute('value');
  const checkedChanged = current.hasAttribute('checked') !== desired.hasAttribute('checked');
  const selected = current.tagName === 'SELECT' ? current.value : null;
  const selectionChanged = current.tagName === 'SELECT'
    && [...current.options].filter(option => option.hasAttribute('selected')).map(option => option.value).join('\n')
      !== [...desired.options].filter(option => option.hasAttribute('selected')).map(option => option.value).join('\n');
  for (const attribute of [...current.attributes]) {
    // A user's expanded disclosure is UI state, not new server data.
    if (current.tagName === 'DETAILS' && attribute.name === 'open' && !desired.hasAttribute('open')) continue;
    if (!desired.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of desired.attributes) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  if (!current.hasAttribute('data-clock') && !current.hasAttribute('data-clock-date')) patchChildren(current, desired);
  // Unchanged form defaults must not erase an unfinished, temporarily unfocused form.
  if (current.tagName === 'INPUT') {
    if (valueChanged) current.value = desired.value;
    if (checkedChanged) current.checked = desired.checked;
  } else if (current.tagName === 'SELECT') {
    if (!selectionChanged && [...current.options].some(option => option.value === selected)) current.value = selected;
    else if (selectionChanged) current.value = desired.value;
  }
}

function patchChildren(parent, desiredParent) {
  const previous = [...parent.childNodes];
  const keyed = new Map(previous.filter(key).map(node => [key(node), node]));
  const retained = new Set();
  let cursor = parent.firstChild;
  for (const desired of desiredParent.childNodes) {
    const identity = key(desired);
    let current = identity ? keyed.get(identity) : previous.find(node => !retained.has(node) && !key(node) && compatible(node, desired));
    if (current && !compatible(current, desired)) current = null;
    if (!current) current = desired.cloneNode(true);
    if (current !== cursor) parent.insertBefore(current, cursor);
    patch(current, desired);
    retained.add(current);
    cursor = current.nextSibling;
  }
  for (const child of [...parent.childNodes]) if (!retained.has(child)) child.remove();
}

// Preserve real controls, browser focus, and nested scroll positions across data
// refreshes. A successful save can update its own keyed row without rebuilding the shell.
export function createRenderer(root) {
  let previousMarkup = null;
  const template = document.createElement('template');
  return markup => {
    if (markup === previousMarkup) return false;
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const focusScope = focused?.closest('[data-key]');
    const selection = focused && typeof focused.selectionStart === 'number'
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const scrolling = [root, ...root.querySelectorAll('*')]
      .filter(element => element.scrollTop || element.scrollLeft)
      .map(element => [element, element.scrollTop, element.scrollLeft]);
    template.innerHTML = markup;
    patchChildren(root, template.content);
    if (focused?.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
      if (selection) focused.setSelectionRange(...selection);
    } else if (focused && !focused.isConnected && focusScope?.isConnected) {
      focusScope.querySelector('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled])')?.focus({ preventScroll: true });
    }
    for (const [element, top, left] of scrolling) {
      if (element.isConnected) { element.scrollTop = top; element.scrollLeft = left; }
    }
    previousMarkup = markup;
    return true;
  };
}
