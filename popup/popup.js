// ─── Theme + tab-mode — applied before render to avoid flash ─────────────────
(function () {
  if (localStorage.getItem('qs-theme') === 'dark') {
    document.documentElement.classList.add('dark');
  }
  // Opened in a full browser tab (?tab=1) → use the roomy editing layout.
  if (new URLSearchParams(location.search).get('tab') === '1') {
    document.documentElement.classList.add('tab-mode');
  }
})();

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  websites:  [],
  sortOrder: 'recency',
  filter:    '',
  blocklist: [],
};

let dragSrcId = null;

// ─── Storage ──────────────────────────────────────────────────────────────────

function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  localStorage.setItem('qs-theme', dark ? 'dark' : 'light');
  const btn = document.getElementById('theme-btn');
  if (btn) btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
}

async function loadState() {
  const data = await chrome.storage.sync.get(['websites', 'sortOrder', 'reuseTabs', 'enabled', 'theme', 'singleWordOnly', 'blocklist']);
  state.websites  = data.websites  || [];
  state.sortOrder = data.sortOrder || 'recency';

  // Normalise + de-dupe stored exclusions (migrates older path-based entries)
  const rawBlock  = data.blocklist || [];
  state.blocklist = [...new Set(rawBlock.map(normalizeExclusion).filter(Boolean))];
  if (state.blocklist.join('|') !== rawBlock.join('|')) persistBlocklist();
  renderExcluded();

  // Wire the single-word-only toggle
  const singleWordToggle = document.getElementById('single-word-toggle');
  singleWordToggle.checked = data.singleWordOnly || false;
  singleWordToggle.addEventListener('change', () => {
    chrome.storage.sync.set({ singleWordOnly: singleWordToggle.checked });
  });

  // Wire the reuse-tabs toggle
  const reuseToggle = document.getElementById('reuse-tabs-toggle');
  reuseToggle.checked = data.reuseTabs || false;
  reuseToggle.addEventListener('change', () => {
    chrome.storage.sync.set({ reuseTabs: reuseToggle.checked });
  });

  // Sync theme from storage (localStorage already applied the cached value above)
  applyTheme(data.theme === 'dark');

  // Wire the enabled toggle (master on/off)
  const enabledToggle = document.getElementById('enabled-toggle');
  enabledToggle.checked = data.enabled !== false; // default: true
  applyEnabledState(enabledToggle.checked);
  enabledToggle.addEventListener('change', () => {
    const val = enabledToggle.checked;
    chrome.storage.sync.set({ enabled: val });
    chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: val });
    applyEnabledState(val);
  });
}

function applyEnabledState(enabled) {
  document.querySelector('.popup').classList.toggle('qs-off', !enabled);
}

function persist() {
  chrome.storage.sync.set({ websites: state.websites, sortOrder: state.sortOrder });
}

// ─── Sorting / filtering ──────────────────────────────────────────────────────

function getSortedFiltered() {
  const q = state.filter.toLowerCase();
  let list = q
    ? state.websites.filter(w =>
        (w.name || w.domain).toLowerCase().includes(q) ||
        w.url.toLowerCase().includes(q)
      )
    : [...state.websites];

  if (state.sortOrder === 'recency')      list.sort((a, b) => (b.lastUsed || b.addedAt) - (a.lastUsed || a.addedAt));
  if (state.sortOrder === 'alphabetical') list.sort((a, b) => (a.name || a.domain).localeCompare(b.name || b.domain));
  if (state.sortOrder === 'manual')       list.sort((a, b) => a.manualOrder - b.manualOrder);

  return list;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const container  = document.getElementById('site-list');
  const emptyState = document.getElementById('empty-state');
  const badge      = document.getElementById('active-count');

  container.querySelectorAll('.site-item').forEach(el => el.remove());

  const activeCount = state.websites.filter(w => w.active).length;
  badge.textContent = `${activeCount} active`;

  if (state.websites.length === 0) {
    emptyState.style.display = 'flex';
    updateLimitNotice();
    return;
  }
  emptyState.style.display = 'none';

  const isManual = state.sortOrder === 'manual';
  getSortedFiltered().forEach(site => container.appendChild(buildRow(site, isManual)));

  updateLimitNotice();
  updateScrollFade();
  updatePageScrollFade();
}

// ─── Row builder ──────────────────────────────────────────────────────────────

function buildRow(site, isManual) {
  const row = document.createElement('div');
  row.className = 'site-item';
  row.dataset.id = site.id;

  // Drag handle
  const drag = document.createElement('div');
  drag.className = 'site-drag' + (isManual ? '' : ' hidden');
  drag.innerHTML = `
    <svg width="11" height="14" viewBox="0 0 11 14" fill="currentColor">
      <circle cx="2.5" cy="2"  r="1.5"/><circle cx="8.5" cy="2"  r="1.5"/>
      <circle cx="2.5" cy="7"  r="1.5"/><circle cx="8.5" cy="7"  r="1.5"/>
      <circle cx="2.5" cy="12" r="1.5"/><circle cx="8.5" cy="12" r="1.5"/>
    </svg>`;

  // Favicon
  const favicon = document.createElement('img');
  favicon.className = 'site-favicon';
  favicon.alt = '';
  favicon.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site.domain)}&sz=32`;
  favicon.addEventListener('error', () => {
    const fb = document.createElement('div');
    fb.className = 'favicon-fallback';
    fb.textContent = (site.name || site.domain)[0].toUpperCase();
    favicon.replaceWith(fb);
  });

  // Name / domain label (click to rename inline)
  const info = document.createElement('div');
  info.className = 'site-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'site-domain';
  nameEl.textContent = site.name || site.domain;
  nameEl.title = 'Click to rename  •  ' + site.url;
  info.appendChild(nameEl);

  nameEl.addEventListener('click', (e) => {
    e.stopPropagation();
    startInlineRename(nameEl, site);
  });

  // Search URL (shown in the full-tab view, click to edit)
  const urlEl = document.createElement('div');
  urlEl.className = 'site-url';
  urlEl.textContent = site.url;
  urlEl.title = 'Click to edit the search URL';
  info.appendChild(urlEl);

  urlEl.addEventListener('click', (e) => {
    e.stopPropagation();
    startInlineUrlEdit(urlEl, site);
  });

  // Toggle
  const label = document.createElement('label');
  label.className = 'toggle';
  label.title = site.active ? 'Active — click to deactivate' : 'Inactive — click to activate';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = site.active;
  const track = document.createElement('span');
  track.className = 'toggle-track';
  label.appendChild(checkbox);
  label.appendChild(track);

  checkbox.addEventListener('change', () => {
    const w = state.websites.find(w => w.id === site.id);
    if (!w) return;
    w.active = checkbox.checked;
    label.title = w.active ? 'Active — click to deactivate' : 'Inactive — click to activate';
    persist();
    document.getElementById('active-count').textContent =
      `${state.websites.filter(w => w.active).length} active`;
  });

  // Delete
  const del = document.createElement('button');
  del.className = 'btn-delete';
  del.title = 'Remove';
  del.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
    </svg>`;

  del.addEventListener('click', () => {
    state.websites = state.websites.filter(w => w.id !== site.id);
    persist();
    render();
  });

  row.appendChild(drag);
  row.appendChild(favicon);
  row.appendChild(info);
  row.appendChild(label);
  row.appendChild(del);

  if (isManual) setupDrag(row, site.id);
  return row;
}

// ─── Inline rename ────────────────────────────────────────────────────────────

function startInlineRename(nameEl, site) {
  const input = document.createElement('input');
  input.className = 'site-name-input';
  input.value = site.name || site.domain;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const val = input.value.trim();
    const w = state.websites.find(w => w.id === site.id);
    if (w) {
      w.name = val || w.domain;
      persist();
    }
    nameEl.textContent = val || site.domain;
    nameEl.title = 'Click to rename  •  ' + site.url;
    input.replaceWith(nameEl);
  }

  function cancel() {
    input.replaceWith(nameEl);
  }

  input.addEventListener('blur',    commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('click', e => e.stopPropagation());
}

// ─── Inline URL edit ──────────────────────────────────────────────────────────

function startInlineUrlEdit(urlEl, site) {
  const input = document.createElement('input');
  input.className = 'site-url-input';
  input.value = site.url;
  input.spellcheck = false;
  urlEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;

  function commit() {
    if (done) return; done = true;
    const raw = input.value.trim();
    const w = state.websites.find(w => w.id === site.id);
    if (w && raw) {
      let url = raw;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      try {
        // Validate (with {query} swapped out) and refresh the derived domain
        const parsed = new URL(url.replace(/\{query\}/g, 'test'));
        w.url    = url;
        w.domain = parsed.hostname;
        persist();
      } catch { /* invalid URL → keep the old one */ }
    }
    render();   // rebuild so favicon + domain reflect the new URL
  }

  function cancel() {
    if (done) return; done = true;
    render();
  }

  input.addEventListener('blur',    commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('click', e => e.stopPropagation());
}

// ─── Drag & drop (manual order) ───────────────────────────────────────────────

function setupDrag(row, id) {
  row.draggable = true;

  row.addEventListener('dragstart', (e) => {
    dragSrcId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    requestAnimationFrame(() => row.classList.add('dragging'));
  });

  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  });

  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (id !== dragSrcId) {
      document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      row.classList.add('drag-over');
    }
  });

  row.addEventListener('dragleave', (e) => {
    if (!row.contains(e.relatedTarget)) row.classList.remove('drag-over');
  });

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drag-over');
    if (!dragSrcId || id === dragSrcId) return;

    const srcIdx = state.websites.findIndex(w => w.id === dragSrcId);
    const dstIdx = state.websites.findIndex(w => w.id === id);
    if (srcIdx === -1 || dstIdx === -1) return;

    const [moved] = state.websites.splice(srcIdx, 1);
    state.websites.splice(dstIdx, 0, moved);
    state.websites.forEach((w, i) => { w.manualOrder = i; });

    persist();
    render();
  });
}

// ─── Add website ──────────────────────────────────────────────────────────────

function addWebsite(rawUrl, rawName) {
  let url = rawUrl.trim();
  if (!url) return false;

  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // Replace {query} placeholder before URL parsing/validation
  let parsed;
  try { parsed = new URL(url.replace(/\{query\}/g, 'test')); } catch { return false; }

  if (state.websites.length >= 20) return false;
  if (state.websites.some(w => w.url === url)) return false;

  const customName = rawName?.trim();

  state.websites.push({
    id:          crypto.randomUUID(),
    url,
    domain:      parsed.hostname,
    name:        customName || parsed.hostname,
    active:      true,
    addedAt:     Date.now(),
    lastUsed:    null,
    manualOrder: state.websites.length,
  });

  persist();
  render();
  return true;
}

// ─── Limit notice ─────────────────────────────────────────────────────────────

function updateLimitNotice() {
  document.querySelector('.limit-notice')?.remove();
  if (state.websites.length >= 20) {
    const notice = document.createElement('div');
    notice.className = 'limit-notice';
    notice.textContent = 'Maximum of 20 websites reached';
    document.querySelector('.add-section').prepend(notice);
  }
}

// ─── Sort tabs ────────────────────────────────────────────────────────────────

function applySortTab() {
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === state.sortOrder);
  });
}

document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.sortOrder = btn.dataset.sort;
    applySortTab();
    persist();
    render();
  });
});

// ─── Filter ───────────────────────────────────────────────────────────────────

document.getElementById('filter-input').addEventListener('input', (e) => {
  state.filter = e.target.value;
  render();
});

// ─── Add form wiring ──────────────────────────────────────────────────────────

const addButtons = document.getElementById('add-buttons');
const addForm    = document.getElementById('add-form');
const urlInput   = document.getElementById('url-input');
const nameInput  = document.getElementById('name-input');
const confirmBtn = document.getElementById('confirm-btn');
const cancelBtn  = document.getElementById('cancel-btn');

function openForm(prefillUrl = '', prefillName = '') {
  addButtons.style.display = 'none';
  addForm.classList.add('visible');
  urlInput.value  = prefillUrl;
  nameInput.value = prefillName;
  // If URL is pre-filled, land on name field so user just types a label
  (prefillUrl ? nameInput : urlInput).focus();
}

function closeForm() {
  addForm.classList.remove('visible');
  addButtons.style.display = '';
  urlInput.value  = '';
  nameInput.value = '';
  urlInput.classList.remove('error');
}

document.getElementById('add-btn').addEventListener('click', () => openForm());

cancelBtn.addEventListener('click', closeForm);

confirmBtn.addEventListener('click', () => {
  if (addWebsite(urlInput.value, nameInput.value)) {
    closeForm();
  } else {
    urlInput.classList.add('error');
    urlInput.focus();
    setTimeout(() => urlInput.classList.remove('error'), 600);
  }
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  confirmBtn.click();
  if (e.key === 'Escape') closeForm();
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  confirmBtn.click();
  if (e.key === 'Escape') closeForm();
});

// ─── Add this website (current tab) ──────────────────────────────────────────

document.getElementById('add-current-btn').addEventListener('click', async () => {
  const btn = document.getElementById('add-current-btn');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const url = tab?.url || '';
  const isWebPage = url && /^https?:\/\//i.test(url);

  if (!isWebPage) {
    const original = btn.innerHTML;
    btn.textContent = 'Not a web page';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1800);
    return;
  }

  // Use just the origin so the extension opens the site's homepage for searching
  let cleanUrl;
  try { cleanUrl = new URL(url).origin + '/'; } catch { cleanUrl = url; }

  // Use the page title as a suggested display name, trimmed to something sensible
  const rawTitle = (tab.title || '').replace(/\s*[-–|·•]\s*.+$/, '').trim();
  const suggestedName = rawTitle.length > 0 && rawTitle.length <= 50 ? rawTitle : '';

  openForm(cleanUrl, suggestedName);
});

// ─── Download today's words ───────────────────────────────────────────────────

async function downloadWords(format) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const { history = {} } = await chrome.storage.local.get('history');

  // Deduplicate case-insensitively, keeping first occurrence
  const seen  = new Set();
  const words = (history[today] || []).filter(w => {
    const key = w.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const btn = document.getElementById(format === 'csv' ? 'download-csv-btn' : 'download-txt-btn');

  if (!words.length) {
    const orig = btn.innerHTML;
    btn.textContent = 'No words today';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000);
    return;
  }

  let content, mime, ext;

  if (format === 'csv') {
    // UTF-8 BOM so Excel opens it correctly without mangling accented characters
    const BOM = '﻿';
    const rows = words.map(w => `"${w.replace(/"/g, '""')}"`);
    content = BOM + 'word\n' + rows.join('\n');
    mime    = 'text/csv; charset=utf-8';
    ext     = 'csv';
  } else {
    content = words.join('\n');
    mime    = 'text/plain; charset=utf-8';
    ext     = 'txt';
  }

  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `words-${today}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById('download-txt-btn').addEventListener('click', () => downloadWords('txt'));
document.getElementById('download-csv-btn').addEventListener('click', () => downloadWords('csv'));

// ─── Site-list inner scroll fade ─────────────────────────────────────────────

function updateScrollFade() {
  const list = document.getElementById('site-list');
  const fade = document.getElementById('scroll-fade');
  const canScrollMore = list.scrollHeight > list.clientHeight + 4 &&
                        list.scrollTop   < list.scrollHeight - list.clientHeight - 4;
  fade.classList.toggle('visible', canScrollMore);
}

document.getElementById('site-list').addEventListener('scroll', updateScrollFade);

// ─── Page-level scroll indicator (inset shadow on body) ──────────────────────

function updatePageScrollFade() {
  const el       = document.documentElement;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  const hasMore  = el.scrollHeight > el.clientHeight + 8;
  document.body.classList.toggle('has-more', hasMore && !atBottom);
}

window.addEventListener('scroll', updatePageScrollFade, { passive: true });

// ─── Excluded sites ─────────────────────────────────────────────────────────

// Normalise whatever the user typed into a bare domain. Exclusions are
// site-wide on purpose — pasting a full article URL still excludes the whole
// site, and any path/query is dropped so every page on it matches.
function normalizeExclusion(raw) {
  const v = (raw || '').trim().toLowerCase();
  if (!v) return '';
  try {
    const u = new URL(/^https?:\/\//.test(v) ? v : 'https://' + v);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return v.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
  }
}

function persistBlocklist() {
  chrome.storage.sync.set({ blocklist: state.blocklist });
}

function addExclusion(raw) {
  const entry = normalizeExclusion(raw);
  if (!entry) return false;
  if (state.blocklist.includes(entry)) return false;
  state.blocklist.push(entry);
  persistBlocklist();
  renderExcluded();
  return true;
}

function removeExclusion(entry) {
  state.blocklist = state.blocklist.filter(e => e !== entry);
  persistBlocklist();
  renderExcluded();
}

function renderExcluded() {
  const list = document.getElementById('excluded-list');
  list.innerHTML = '';

  if (state.blocklist.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'excluded-empty';
    empty.textContent = 'No excluded sites yet';
    list.appendChild(empty);
    return;
  }

  state.blocklist.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'excluded-item';

    const label = document.createElement('span');
    label.className = 'excluded-name';
    label.textContent = entry;
    label.title = entry;

    const del = document.createElement('button');
    del.className = 'excluded-remove';
    del.title = 'Remove';
    del.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>`;
    del.addEventListener('click', () => removeExclusion(entry));

    row.appendChild(label);
    row.appendChild(del);
    list.appendChild(row);
  });
}

const excludeInput = document.getElementById('exclude-input');

document.getElementById('exclude-add-btn').addEventListener('click', () => {
  if (addExclusion(excludeInput.value)) {
    excludeInput.value = '';
  } else {
    excludeInput.classList.add('error');
    setTimeout(() => excludeInput.classList.remove('error'), 600);
  }
  excludeInput.focus();
});

excludeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('exclude-add-btn').click();
});

document.getElementById('exclude-current-btn').addEventListener('click', async () => {
  const btn = document.getElementById('exclude-current-btn');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';

  if (!/^https?:\/\//i.test(url)) {
    const orig = btn.innerHTML;
    btn.textContent = 'Not a web page';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1800);
    return;
  }

  if (!addExclusion(new URL(url).hostname)) {
    const orig = btn.innerHTML;
    btn.textContent = 'Already excluded';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1800);
  }
});

// ─── Learn more ───────────────────────────────────────────────────────────────

document.getElementById('learn-more-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://liahbrussolo.wordpress.com/quick-search-extension/' });
});

// ─── Open in a full tab ───────────────────────────────────────────────────────

document.getElementById('expand-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') + '?tab=1' });
  window.close();
});

// ─── Theme toggle button ──────────────────────────────────────────────────────

document.getElementById('theme-btn').addEventListener('click', () => {
  const dark = !document.documentElement.classList.contains('dark');
  applyTheme(dark);
  chrome.storage.sync.set({ theme: dark ? 'dark' : 'light' });
});

// ─── Scroll-more fade ────────────────────────────────────────────────────────

function updateScrollFade() {
  const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
  document.getElementById('scroll-fade').classList.toggle('hidden', atBottom);
}

window.addEventListener('scroll', updateScrollFade, { passive: true });

// ─── Boot ─────────────────────────────────────────────────────────────────────

loadState().then(() => {
  applySortTab();
  render();
  updateScrollFade(); // set correct state after content is rendered
});
