/* =========================================================================
   main.js — boots everything. Loaded last, so every PH.* module exists.
   =========================================================================
   Reading order for this project: store.js (what's saved) → location.js (how
   trade URLs work) → panel.js (the shell) → bookmarks/saved (the tabs) →
   this file (wiring).
   ========================================================================= */

const LOG = (...args) => console.log("[PoE Helper]", ...args);

/* -------------------------------------------------------------------------
   FEATURE — Type "~" for me automatically in stat filter boxes
   -------------------------------------------------------------------------
   A leading "~" makes the stat filter's text search fuzzy: the words match
   anywhere in the mod, in any order. So "~life regen" finds "Regenerate #
   Life per second", which plain "life regen" misses.

   Fuzzy is what you want almost every time, so we type it for you. The only
   rule is we never touch a box that already has something in it (so never
   "~~life", and pasting still works) — we always refill an EMPTY box on
   focus, even one you deleted the "~" from a moment ago. The popup toggle is
   the only way to turn this off. */

const STAT_FILTER_INPUT = 'input.multiselect__input, .filter-select input[type="text"]';
const TILDE = "~";
const TILDE_MARK = "ph-tilde";

let tildeEnabled = true;

function wireTildePrefix(input) {
  if (input.hasAttribute(TILDE_MARK)) return;
  input.setAttribute(TILDE_MARK, "");

  input.addEventListener("focus", () => {
    if (!tildeEnabled) return;
    if (input.value !== "") return;

    input.value = TILDE;
    /* Setting .value doesn't tell the trade site's own code anything changed,
       so the dropdown won't re-filter unless we fire the event it listens for. */
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

/* -------------------------------------------------------------------------
   Watching the page
   ------------------------------------------------------------------------- */

/* The trade site rewrites its own HTML constantly and changes the URL without
   a page load, so nothing can be done once at startup. */
function scan() {
  document.querySelectorAll(`${STAT_FILTER_INPUT}:not([${TILDE_MARK}])`).forEach(wireTildePrefix);
  PH.prices.annotate();
  PH.saved.enhanceRows();
}

let scanQueued = false;
function queueScan() {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => { scanQueued = false; scan(); });
}

/* Our own DOM edits re-trigger the observer. What stops that becoming a loop
   is that every enhancer marks what it has already touched and selects with
   :not([mark]) — so a second pass over the same rows does nothing. */
function watchDom() {
  const observer = new MutationObserver(queueScan);
  observer.observe(document.body, { childList: true, subtree: true });
}

/* -------------------------------------------------------------------------
   Watching the URL

   The trade site navigates with pushState, which fires no event. Polling is
   the honest answer, and it's what Better Trading does. We only poll while
   the window has focus, so a background tab costs nothing.
   ------------------------------------------------------------------------- */

const POLL_MS = 500;
let lastPath = null;
let pollTimer = null;
/* Reset on every navigation; see checkResultsForPricing below. */
let pricedThisVisit = false;

async function checkLocation() {
  const path = window.location.pathname;
  if (path === lastPath) return;
  lastPath = path;
  pricedThisVisit = false;

  await PH.store.noteLeague(PH.location.current());
  PH.panel.refresh();
}

/* Once real results are showing for whatever search we're now on, ask
   Bookmarks to record a price observation if this happens to be a search
   we've saved, and ask Saved listings to do the same if this tab was
   opened by "Search this exact item" — once per visit, not once per poll
   tick. This is the same DOM the page already loaded on its own; nothing
   is fetched or clicked to make this happen. */
function checkResultsForPricing() {
  if (pricedThisVisit) return;
  if (!document.querySelector(".resultset > div.row[data-id]")) return;
  pricedThisVisit = true;
  PH.bookmarks.notePriceIfMatch();
  PH.saved.capturePendingPrice();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { checkLocation(); checkResultsForPricing(); }, POLL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */

async function boot() {
  LOG("starting on", window.location.href);

  await PH.store.migrateLegacyBookmarks();

  const settings = await PH.store.getSettings();
  tildeEnabled = settings.tildePrefix !== false;

  await PH.saved.initPriceCapture();

  PH.panel.registerTab("bookmarks", (container) => PH.bookmarks.render(container));
  PH.panel.registerTab("saved", (container) => PH.saved.render(container));

  const mounted = PH.panel.mount();
  if (!mounted) LOG("panel not mounted — the trade app isn't on this page");

  await PH.prices.init();

  scan();
  watchDom();

  startPolling();
  checkLocation();
  window.addEventListener("focus", startPolling);
  window.addEventListener("blur", stopPolling);

  /* React to changes made in the popup or another tab. */
  PH.store.onChange((changes) => {
    if (changes.settings) {
      const next = changes.settings.newValue ?? {};
      tildeEnabled = next.tildePrefix !== false;
      PH.prices.setEnabled(next.showPriceConversion !== false);
    }
    /* savedGroups on its own (not paired with a savedListings write) only
       happens for a pure group rename — every other group action
       (creating one, ungrouping, a listing being deleted out from under
       one) also touches savedListings in the same flow, which already
       covers it. */
    if (changes.folders || changes.trades || changes.savedListings || changes.savedGroups) PH.panel.refresh();
    /* Keeps a result row's own "Save Listing"/"Saved" button in sync with
       storage — covers removing a listing from the Saved tab (in this tab
       or a different one) reverting the button on the search results tab
       it came from, if that tab still has the row on screen. */
    if (changes.savedListings) PH.saved.syncSaveButtons();
  });

  LOG("ready");
}

boot();
