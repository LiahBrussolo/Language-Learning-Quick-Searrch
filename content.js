// Fires when the user deliberately *selects* text, then copies + searches it.
//
// A selection counts as deliberate only when it comes from a real gesture:
//   • a drag  — the mouse travelled between mousedown and mouseup, or
//   • a double-click — selects the word under the cursor.
// A plain click (button, dropdown option, link) moves the mouse ~0px and is
// ignored, so clicking UI never opens a search tab.
//
// Guards before any of that: extension enabled, site not excluded.

let searchTimer    = null;
let singleWordOnly = false;
let enabled        = true;
let blocklist      = [];

// Where the mouse went down — distance to mouseup tells a drag from a click.
let downX = 0, downY = 0;
const DRAG_THRESHOLD = 6;   // px of travel required to count as a selection drag

// ─── Settings — load once, then stay in sync reactively ───────────────────────
chrome.storage.sync.get(['singleWordOnly', 'enabled', 'blocklist'], d => {
  singleWordOnly = d.singleWordOnly || false;
  enabled        = d.enabled !== false;        // default: on
  blocklist      = d.blocklist || [];
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.singleWordOnly) singleWordOnly = changes.singleWordOnly.newValue;
  if (changes.enabled)        enabled        = changes.enabled.newValue !== false;
  if (changes.blocklist)      blocklist      = changes.blocklist.newValue || [];
});

// ─── Is this page excluded by the user? ───────────────────────────────────────
function isExcluded() {
  // Prefer the top page's address (what the user sees) so a selection inside a
  // same-origin iframe is still judged against the real site. Cross-origin
  // frames fall back to their own URL (the background does the final check).
  let url, host;
  try {
    url  = window.top.location.href.toLowerCase();
    host = window.top.location.hostname.toLowerCase();
  } catch {
    url  = location.href.toLowerCase();
    host = location.hostname.toLowerCase();
  }

  return blocklist.some(raw => {
    const entry = (raw || '').trim().toLowerCase();
    if (!entry) return false;
    // Full URL → prefix match; bare domain → exact host or any subdomain of it.
    if (entry.startsWith('http')) return url.startsWith(entry);
    return host === entry || host.endsWith('.' + entry);
  });
}

// Shared gate — true only when we're allowed to act right now.
function active() {
  return enabled && !!chrome.runtime?.id && !isExcluded();
}

// ─── Copy the selection + fire the search ─────────────────────────────────────
function runSearch(sel, text) {
  // Copy to clipboard — keep the HTML flavour so hyperlinks survive a paste
  // into rich-text apps (Gmail, Docs, Word …); plain text for everything else.
  let html = '';
  if (sel.rangeCount > 0) {
    const tmp = document.createElement('div');
    tmp.appendChild(sel.getRangeAt(0).cloneContents());
    html = tmp.innerHTML;
  }
  if (html) {
    navigator.clipboard.write([
      new ClipboardItem({
        'text/html':  new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })
    ]).catch(() => navigator.clipboard.writeText(text).catch(() => {}));
  } else {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  // "Single words only" → multi-word selections are copied but not searched.
  if (singleWordOnly && text.split(/\s+/).length > 1) return;

  chrome.runtime.sendMessage({ type: 'SEARCH_QUERY', query: text }).catch(() => {});
}

// ─── Drag-to-select ───────────────────────────────────────────────────────────
document.addEventListener('mousedown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
}, true);

document.addEventListener('mouseup', (e) => {
  clearTimeout(searchTimer);
  if (!active()) return;

  // A real text-selection drag moves the cursor. A button / dropdown / link
  // click stays put → ignore it so clicking UI never triggers a search.
  const travelled = Math.hypot(e.clientX - downX, e.clientY - downY);
  if (travelled < DRAG_THRESHOLD) return;

  searchTimer = setTimeout(() => {
    if (!active()) return;
    const sel  = window.getSelection();
    const text = sel?.toString().trim();
    if (text) runSearch(sel, text);
  }, 250);
});

// ─── Double-click a word ──────────────────────────────────────────────────────
document.addEventListener('dblclick', () => {
  clearTimeout(searchTimer);          // don't let the mouseup path also fire
  if (!active()) return;

  searchTimer = setTimeout(() => {
    if (!active()) return;
    const sel  = window.getSelection();
    const text = sel?.toString().trim();
    if (text) runSearch(sel, text);
  }, 50);
});
