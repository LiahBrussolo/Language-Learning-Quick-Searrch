// ─── Keyboard shortcut — works on PDFs + all pages ────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'search-selection') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  let text = '';

  // Try to read the selection directly via scripting (works on normal pages)
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        document.execCommand('copy');           // copies selection to clipboard
        return window.getSelection()?.toString().trim() || '';
      },
    });
    text = result?.result?.trim() || '';
  } catch {
    // Scripting blocked (PDF viewer, chrome:// pages, etc.) — fall through
  }

  // Fall back to reading the clipboard (works for PDFs after execCommand('copy'))
  if (!text) {
    await new Promise(r => setTimeout(r, 150)); // give the copy a moment to land
    text = await readFromClipboard();
  }

  if (text) handleSearch(text, tab.url);
});

// Reads text from the clipboard via an offscreen document (needed in SW context)
async function readFromClipboard() {
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['CLIPBOARD'],
      justification: 'Read selected text from PDFs and non-scriptable pages',
    });
  } catch {
    // Already exists — that's fine
  }
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'READ_CLIPBOARD' }, response => {
      if (chrome.runtime.lastError) { resolve(''); return; }
      resolve(response?.text || '');
    });
  });
}

// ─── Context menu — primary trigger for PDFs (content scripts can't run there) ─

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'qs-search',
    title:    'Search with QuickSearch',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'qs-search' && info.selectionText?.trim()) {
    handleSearch(info.selectionText.trim(), tab?.url);
  }
});

// ─── Extension badge (shows OFF when disabled) ────────────────────────────────

function updateBadge(enabled) {
  if (enabled) {
    chrome.action.setBadgeText({ text: '' });
  } else {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#9BA396' });
  }
}

// Sync badge to stored state on service-worker startup
chrome.storage.sync.get('enabled', ({ enabled = true }) => updateBadge(enabled));

// ─── Message from content script ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SEARCH_QUERY' && message.query?.trim()) {
    handleSearch(message.query.trim(), sender.tab?.url);
    sendResponse({ ok: true });
  }
  if (message.type === 'SET_ENABLED') {
    updateBadge(message.enabled);
  }
  return true;
});

// ─── Tab injection (survives service-worker restarts via storage.session) ─────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const key = `qs_${tabId}`;
  const data = await chrome.storage.session.get(key);
  const query = data[key];
  if (!query) return;
  await chrome.storage.session.remove(key);
  chrome.scripting.executeScript({ target: { tabId }, func: injectSearch, args: [query] });
});

// ─── Core search handler ───────────────────────────────────────────────────────

// Does this tab URL fall under one of the user's excluded sites?
function isPageExcluded(rawUrl, blocklist) {
  let url, host;
  try { const u = new URL(rawUrl); url = rawUrl.toLowerCase(); host = u.hostname.toLowerCase(); }
  catch { return false; }
  return blocklist.some(raw => {
    const entry = (raw || '').trim().toLowerCase();
    if (!entry) return false;
    if (entry.startsWith('http')) return url.startsWith(entry);
    return host === entry || host.endsWith('.' + entry);
  });
}

async function handleSearch(query, srcUrl) {
  const { websites = [], reuseTabs = false, enabled = true, blocklist = [] } =
    await chrome.storage.sync.get(['websites', 'reuseTabs', 'enabled', 'blocklist']);
  if (!enabled) return;
  if (srcUrl && isPageExcluded(srcUrl, blocklist)) return;   // excluded site — never search
  const active = websites.filter(w => w.active);
  if (!active.length) return;

  // Persist word to history + stamp lastUsed on each active site
  await logWord(query);
  const now = Date.now();
  chrome.storage.sync.set({
    websites: websites.map(w => active.some(a => a.id === w.id) ? { ...w, lastUsed: now } : w),
  });

  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const windowId = currentTab?.windowId;
  const existingTabs = reuseTabs ? await chrome.tabs.query({ windowId }) : [];

  let firstActivated = false;

  for (const site of active) {
    // {query} in the URL = direct navigation, no DOM injection needed
    const isTemplate = site.url.includes('{query}');
    const targetUrl  = isTemplate
      ? site.url.replace(/\{query\}/g, encodeURIComponent(query))
      : site.url;

    // Reuse an existing tab on the same origin
    if (reuseTabs) {
      const origin = new URL(isTemplate ? targetUrl : site.url).origin;
      const match  = existingTabs.find(t => {
        try { return new URL(t.url).origin === origin; }
        catch { return false; }
      });
      if (match) {
        if (!firstActivated) await chrome.tabs.update(match.id, { active: true });
        firstActivated = true;
        if (!isTemplate) await chrome.storage.session.set({ [`qs_${match.id}`]: query });
        await chrome.tabs.update(match.id, { url: targetUrl });
        continue;
      }
    }

    // Open new tab
    const tab = await chrome.tabs.create({ url: targetUrl, active: !firstActivated, windowId });
    firstActivated = true;
    if (!isTemplate) await chrome.storage.session.set({ [`qs_${tab.id}`]: query });
  }
}

// ─── Word history ──────────────────────────────────────────────────────────────

async function logWord(word) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const { history = {} } = await chrome.storage.local.get('history');
  if (!history[today]) history[today] = [];
  const lower = word.toLowerCase();
  if (!history[today].some(w => w.toLowerCase() === lower)) {
    history[today].push(word);
    await chrome.storage.local.set({ history });
  }
}

// ─── Injected into target tabs — must be fully self-contained ─────────────────

function injectSearch(query) {
  // Priority list: specific → general. textarea added for sites like Reverso.
  const SELECTORS = [
    'input[type="search"]',
    'input[name="q"]',         'textarea[name="q"]',
    'input[name="query"]',     'textarea[name="query"]',
    'input[name="search"]',    'textarea[name="search"]',
    'input[name="zoek"]',
    'input[name="woord"]',
    'input[name="s"]',
    'input[name="term"]',
    'input[name="keyword"]',
    'input[name="keywords"]',
    'input[id*="search"  i]',  'textarea[id*="search"  i]',
    'input[id*="zoek"    i]',
    'input[id*="query"   i]',  'textarea[id*="query"   i]',
    'input[placeholder*="search"    i]', 'textarea[placeholder*="search"    i]',
    'input[placeholder*="zoek"      i]',
    'input[placeholder*="find"      i]',
    'input[placeholder*="translate" i]', 'textarea[placeholder*="translate" i]',
    'input[class*="search" i]',          'textarea[class*="search" i]',
    'input[type="text"]',  // broadest input catch-all
    'textarea',            // broadest textarea catch-all
  ];

  function isVisible(el) {
    return el.offsetWidth > 0 && el.offsetHeight > 0
      && !el.disabled && el.type !== 'hidden' && !el.readOnly;
  }

  function findInput() {
    for (const sel of SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  function fillAndSubmit(el) {
    el.focus();

    // Native value setter works for React / Vue / Angular controlled components
    const proto  = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, query);

    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    const form = el.closest('form');
    if (form) {
      const btn = form.querySelector(
        'button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"])'
      );
      if (btn) {
        btn.click();
      } else {
        form.submit();
      }
    } else {
      // Dispatch full Enter key sequence for JS-driven search bars
      ['keydown', 'keypress', 'keyup'].forEach(type =>
        el.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        }))
      );
    }
  }

  // Poll for up to 3 s — handles JS-rendered / SPA pages
  let attempts = 0;
  const interval = setInterval(() => {
    const input = findInput();
    if (input) { clearInterval(interval); fillAndSubmit(input); }
    else if (++attempts >= 30) clearInterval(interval);
  }, 100);
}
