/* =========================================================================
   store.js — everything that gets saved, and the only file that touches
   browser storage. Loaded first, so every other file can use PH.store.
   =========================================================================
   Data model (all under PH.browserAPI.storage.local):

     folders      [ { id, title, icon, version, archivedAt, totalCostHistory? } ]
                    totalCostHistory is [ { amount, currency: "chaos",
                    capturedAt } ], same shape and rolling-history mechanics
                    (oldest first, capped, same-value dedup) as a trade's
                    priceHistory — see PH.store.pushFolderTotalCost. It's the
                    sum of every trade's own latest price, refreshed only
                    when the folder is opened (PH.bookmarks.renderTrades)
                    and read as-is everywhere else, including collapsed, so
                    showing it (its latest entry, a trend arrow, and a hover
                    popup of past totals) doesn't need a trades fetch per
                    folder. Absent (undefined) until a folder's been opened
                    at least once since this existed, and never gains an
                    entry for an open that found nothing priced.
     trades       { "<folderId>": [ { id, title, completedAt, location,
                                       priceHistory? } ] }
                    priceHistory is [ { amount, currency, capturedAt } ],
                    oldest first, capped at 5 — the cheapest listing on the
                    page each time this trade's search was observed: at
                    save, at repoint (which resets the history — the old
                    entries belonged to whatever search this used to point
                    at), and automatically whenever you visit the bookmarked
                    search on the trade site (see PH.bookmarks.notePriceIfMatch
                    and the poll loop in main.js). A snapshot, not a live
                    price; see PH.prices.cheapestOnPage. A repeat visit within
                    3 hours that finds the same price refreshes the latest
                    entry's timestamp rather than taking a slot — see
                    PH.store.pushTradePrice (and pushFolderTotalCost, which
                    shares the same capped/deduped-history logic). Trades
                    saved before this existed may still carry the old
                    singular `priceAtSave` field — readers fall back to
                    treating it as a 1-entry history.
     savedListings [ { id, savedAt, listedAt, league, location, sourceId,
                       title, name, type, icon, rarity, unidentified,
                       corrupted, price, priceIcon, seller, mods, properties,
                       additionalStats, priceHistory?, groupId? } ]
                    properties is [ { id, text, value } ] — every base
                    property line on the item (quality, item level, the
                    Requires line, ...) via .item-property — see
                    itemProperties in saved.js. id is the property's own
                    data-field attribute (e.g. "ev" for Evasion Rating,
                    verified 2026-08 against a real property's outerHTML),
                    the same convention a mod's own id uses; value is the
                    same best-effort first-number read modRollValue
                    already does for mods. Both exist so the compare modal
                    can offer the same click-a-stat-to-sort-every-column
                    behavior GGG's own trade site offers for its property
                    columns, not just for mods — see comparePropertyCell/
                    propValueFor in saved.js. text is the full "Label:
                    value" display string, not split into individual
                    fields — the actual property set varies too much by
                    item type/base to catalog beyond that. additionalStats
                    is the same { id, text, value } shape, but from the
                    separate .itemPopupAdditional block instead (DPS/
                    Physical DPS/Elemental DPS for a weapon, Base
                    Percentile/Armour/Evasion/Energy Shield for armour —
                    see itemAdditionalStats in saved.js), kept apart from
                    properties rather than merged into one flat list
                    because GGG's own item popup visually separates them
                    into their own groups (Item Level/Requires Level
                    together, Intangibility and similar one-off quirks
                    together, the base .item-property readings together,
                    and this .itemPopupAdditional block together, in that
                    order) — see itemPropertyBlocks in saved.js, which is
                    what actually reconstructs that grouping for display;
                    this schema just keeps the two sources apart so it
                    can. Listings saved before either existed just have
                    none; listings saved before id/value existed on these
                    have plain strings instead, same fallback mods already
                    has for the same reason. groupId,
                    when set, references a savedGroups entry (below) — set
                    by dragging one
                    listing onto another,
                    cleared (deleted along with an empty group) by
                    ungrouping. Absent for a listing that's never been
                    manually grouped.
                    rarity is GGG's own item-popup--<rarity> class, read
                    generically (see itemRarity in saved.js) — "unique",
                    "currency", and "magic" confirmed against real rows;
                    "rare"/"normal" inferred from that same pattern, not
                    independently seen. Drives two things: rebuildSearch
                    skips the broken name/type fields for magic/rare (see
                    the long comment there — a magic/rare item's single
                    header line mixes rolled affix words into what would
                    be `type`, which isn't a real base type GGG's trade
                    API recognizes) in favor of a type_filters.rarity
                    filter instead, and the Saved tab's auto-grouping
                    groups magic/rare listings by type alone rather than
                    by full title. Listings saved before this existed are
                    just never grouped/searched with rarity in mind.
                    unidentified is true if GGG showed a plain
                    "Unidentified" line on the item at save time (see
                    isUnidentified in saved.js) — its explicit/rolled
                    affixes are hidden while unidentified, but any
                    implicit(s) still show and still end up in mods same as
                    any other listing. Shown as its own badge on the
                    listing alongside the mods list (not instead of it —
                    mods may be empty, one implicit, or several), and adds
                    the misc_filters.identified:"false" filter to "Search
                    this exact item"'s request so an identified copy of the
                    same base doesn't creep back into results that would
                    otherwise be name/type-only. Listings saved before this
                    existed are just never treated as unidentified, even if
                    they were.
                    corrupted is true if GGG showed a plain "Corrupted" line
                    on the item at save time (see isCorrupted in saved.js) —
                    a critical identifier, since a corrupted item never
                    rerolls and rules out most crafting, so it's shown as
                    its own centered line (not folded into the unidentified
                    badge's styling) matching where GGG's own popup shows
                    it, and adds misc_filters.corrupted:"true" to "Search
                    this exact item"'s request for the same reason
                    unidentified adds its own identified filter above —
                    without it, an otherwise-identical uncorrupted item can
                    outrank the real corrupted listing on price and get
                    captured as if it were the same item (see
                    capturePendingPrice's seller check below for the second,
                    independent guard against exactly that). Listings saved
                    before this existed are just never flagged as
                    corrupted, even if they were.
                    icon is the item's own artwork <img src> (web.poecdn.com),
                    priceIcon the currency image's own <img src> from GGG's
                    CDN — both captured at save time since a saved listing
                    has no live row left to re-read them from later;
                    listings saved before icon existed just have no item
                    image. listedAt is when GGG says the listing itself was
                    posted (parsed from the row's own "listed X ago" text —
                    see parseListedAgo in saved.js — so it's only as precise
                    as that text's unit), separate from savedAt (when you
                    clicked Save Listing). Set at save time, and refreshed
                    (see updateSavedListingSnapshot) every time "Search this
                    exact item" finds real results, the same visit it
                    captures a fresh price — the original listing isn't
                    necessarily still the cheapest match by then (relisted,
                    undercut, time passed), so this keeps "listed X ago"
                    honest instead of frozen at whatever it read at save
                    time. The rest of the snapshot (mods, properties,
                    rarity, icon, sourceId, ...) refreshes the same way and
                    for the same reason — a re-search re-reads the whole row,
                    not just its price, so e.g. a newly-added property field
                    or a corrected mod-parsing bug shows up on next search
                    instead of only on a fresh manual re-save. Listings saved
                    before listedAt existed fall back to showing savedAt
                    instead.
                    sourceId is the result row's own data-id, GGG's id for
                    that specific listing — lets PH.saved.syncSaveButtons
                    recognize "already saved" if the same search turns up
                    the same listing again; listings saved before this
                    existed just never match. name/type are the item's
                    flavour name and base type kept apart
                    (not joined like the display title), for "Search this
                    exact item"'s query.name/query.type. mods is
                    [ { id, text, value, kind?, range?, affix? } ] — id is
                    the stat's own internal id from its data-field
                    attribute, for that same feature's stat filters;
                    listings saved before that existed just have plain
                    strings instead. kind ("implicit"/"explicit"/"pseudo",
                    the last being GGG's own computed "total" summary
                    lines like "+142 total maximum Life"), range
                    ({min, max}, the roll's own possible bounds), and
                    affix ({type: "prefix"/"suffix", code}) are all read
                    straight off GGG's own display (see modLines/
                    parseModRoll/parseModAffix in saved.js) and drive the
                    compare modal's per-mod code label/roll-quality bar;
                    all absent on listings saved before they existed.
                    range is null for a mod GGG shows as a dual [a—b to
                    c—d] range (a two-part "Adds X to Y Damage" style
                    mod), which isn't parsed. affix.code is GGG's own raw
                    tier code text verbatim — usually "P1"/"S4", but
                    sometimes a compound like "P2 + P1" for a mod that's
                    the sum of two affix rolls (verified live) — kept
                    whole rather than reduced to a single tier number so
                    a compound roll doesn't silently lose half of itself;
                    affix itself is null for an implicit (not a tiered
                    prefix/suffix affix at all) or if GGG's code text
                    doesn't match the expected shape. priceHistory is
                    [ { amount, currency, capturedAt } ], oldest first,
                    capped at 5, same capped/deduped-history shape and
                    mechanics as a bookmark trade's own priceHistory (see
                    PH.store.pushTradePrice) — seeded with the price
                    captured at save time, and appended to whenever
                    "Search this exact item" finds real results (see
                    PH.saved.capturePendingPrice and the poll loop in
                    main.js); a same-price recheck refreshes the latest
                    entry's timestamp rather than taking a slot, so it
                    genuinely only grows on an actual price change.
                    Listings saved before this existed just have no history
                    — the plain `price` string is still shown as a fallback.
                    noResultsFound? is true once "Search this exact item"
                    comes back with zero results — see setListingNoResults —
                    and drives an inline "remove this?" prompt on the
                    listing's own row in every tab currently showing it
                    (not a one-shot cross-tab handoff like
                    pendingPriceCapture below, since more than one tab can
                    have this listing's row on screen at once — the results
                    tab the search itself just opened, and whichever tab
                    the click came from). Cleared back to unset on either
                    "Cancel" or the listing being deleted.
     savedGroups  [ { id, title } ]  manual groups in the Saved tab —
                    created by dragging one listing onto another (see
                    PH.saved's drag handlers), a listing's own groupId
                    references one of these. Deliberately separate from
                    automatic grouping (same title for most rarities, same
                    icon for magic/rare — see groupKeyFor in saved.js,
                    which needs no persisted state since it's recomputed
                    every render): a manual group is a real, named,
                    user-made thing, so it gets real identity here the
                    same way a Bookmarks folder does, while an automatic
                    group is just a rendering convenience with nothing to
                    remember. Renaming what started as an automatic group
                    promotes it into one of these (see PH.saved's rename
                    handler) rather than being a no-op, since there'd
                    otherwise be nothing to attach the new name to.
     pendingPriceCapture  string | null   a saved listing's id — a short-
                    lived handoff from "Search this exact item" to the
                    fresh tab it opens, since that tab has no other way to
                    know which listing to record a price observation
                    against. Read once by the receiving tab's
                    PH.saved.initPriceCapture on boot, then immediately
                    cleared, so a tab that was already open can't also
                    pick it up.
     tradeSearchCooldown  number | null   epoch ms; PH.saved.searchTrade
                    (Saved listings' "Search this exact item") refuses to call
                    GGG's trade API again before this time, per whatever
                    the API's own x-rate-limit-* response headers most
                    recently said our budget was. Shared across tabs since
                    the content script has no persistent process of its own.
     tradeFetchCooldown  number | null   same shape and purpose as
                    tradeSearchCooldown, but for /api/trade/fetch — a
                    separate rate-limit budget from /api/trade/search's own,
                    tracked separately because a results tab's own page load
                    consumes it (to render the listings /search found) even
                    though this content script never calls /fetch for
                    listing data itself; see PH.saved.fetchListingHeaders
                    and the note above it for why this call exists at all.
     tradeRateState  { search, fetch }  each null or { policy, entries,
                    recordedAt } — the last real x-rate-limit-* reading
                    PH.rateLimitOverlay parsed from that endpoint's own
                    response headers (policy is GGG's own label, e.g.
                    "trade-search-request-limit"; entries is one
                    { maxCount, period, currentCount } per rate-limit
                    window). Persisted (unlike tradeSearchCooldown/
                    tradeFetchCooldown above, which only need the single
                    "blocked until" moment) so the rate-limit pill in the
                    panel header still has real numbers to decay from and
                    display right after a fresh page load, not just within
                    the tab that happened to make the request.
     tradeLinkClicks  [ epoch ms, ... ]  timestamps of every bookmark
                    trade-link click (PH.bookmarks' tradeRow, both the row's
                    own link and its "Open live search" menu item) — this
                    tab has no way to see the real request(s) that clicking
                    one actually makes on GGG's side (it navigates away
                    before any response comes back to us), so the rate-limit
                    pill instead adds however many of these fall inside a
                    given window's own period on top of that window's last
                    real decayed count, an estimate rather than a real
                    reading. Pruned on every write to whatever window the
                    longest currently-known real rate-limit period is (falls
                    back to a fixed default before any real data exists),
                    so this never grows without bound.
     settings     { tildePrefix, showPriceConversion, sortByTruePrice }
     leagues      { "1": "Allflame", "2": "Runes of Aldur" }   last seen per game

   A saved search's `location` is { version, type, slug } and deliberately
   has NO league. That is the whole trick: the slug is league-independent on
   GGG's side, so a bookmark saved last league opens in the current one. See
   location.js for how the league gets filled in at click time.
   ========================================================================= */

window.PH = window.PH || {};

/* Firefox exposes a promise-based `browser.*` namespace; Chrome only has
   `chrome.*`, whose MV3 storage/runtime methods also resolve without a
   callback. Firefox does provide a `chrome.*` alias too, but it's
   callback-only there, so an `await chrome.storage.local.get(...)` call
   (the shape used throughout this file) would silently get back
   `undefined` instead of the real result.

   Read as the bare `browser`/`chrome` identifier, NOT `window.browser`/
   `window.chrome` — confirmed live (real console error: "PH.browserAPI is
   undefined") that in a Firefox CONTENT SCRIPT specifically, `window` is
   the actual page's window object, which never has `browser` attached to
   it; Firefox injects `browser` into the content script's own scope as a
   bare global instead, reachable directly but not through `window`. Chrome
   attaches `chrome` onto the content script's `window` too, so `window.
   chrome` would have kept working there, but relying on `window.` at all
   was the bug on Firefox. `typeof browser` (rather than a bare reference)
   avoids a ReferenceError on Chrome, where no global named `browser`
   exists at all. */
PH.browserAPI = typeof browser !== "undefined" ? browser : chrome;

PH.store = (() => {
  const LOG = (...a) => console.log("[PoE Helper store]", ...a);

  /* IDs only need to be unique on this machine, so this is plenty. */
  const newId = () =>
    Math.random().toString(36).slice(2) + Date.now().toString(36);

  const DEFAULTS = {
    folders: [],
    trades: {},
    savedListings: [],
    savedGroups: [],
    pendingPriceCapture: null,
    tradeSearchCooldown: null,
    tradeFetchCooldown: null,
    tradeRateState: { search: null, fetch: null },
    tradeLinkClicks: [],
    settings: { tildePrefix: true, showPriceConversion: true, sortByTruePrice: true },
    leagues: {},
  };

  async function readAll() {
    const raw = await PH.browserAPI.storage.local.get(Object.keys(DEFAULTS));
    const data = {};
    for (const key of Object.keys(DEFAULTS)) {
      data[key] = raw[key] ?? structuredClone(DEFAULTS[key]);
    }
    return data;
  }

  /* Every mutator below reads some slice of storage, changes it in memory,
     then writes it back — and PH.browserAPI.storage.local has no compare-and-swap,
     so that read-then-write is NOT atomic. Two of these firing close
     together (a fast double-click before a button disables itself, or the
     same action taken in two trade-site tabs open at once) can interleave:
     the second one reads before the first one writes, and its write then
     silently clobbers the first change instead of building on it.

     withLock() serializes them. Where the Web Locks API is available, the
     lock is requested on navigator.locks, which MDN documents as scoped to
     the page's origin — so this also covers multiple pathofexile.com tabs,
     not just this one. Where it isn't (the Node test harness has no
     `navigator`), this falls back to an in-module promise chain, which
     still serializes everything within a single tab/content-script
     instance. Every exported function that does its own read-modify-write
     runs its whole body inside this — including migrateLegacyBookmarks,
     where serializing is what stops two tabs racing to import the same
     legacy `bookmarks` array twice: whichever runs second sees the first
     one's PH.browserAPI.storage.local.remove("bookmarks") already happened.

     navigator.locks is deliberately skipped on Firefox specifically —
     confirmed live (a real "Permission denied to access property 'then'"
     thrown from inside migrateLegacyBookmarks, the very first withLock
     call boot() makes) that Firefox's Xray wrappers can't safely let
     navigator.locks (a page-realm API; content scripts share the page's
     own `navigator`, not an extension-private one) chain onto a promise
     that resolves via the privileged browser.storage API — a known class
     of Firefox content-script bug, not specific to this one call. Chrome's
     extension model doesn't wall content scripts off from page objects
     the same way, so it keeps the real cross-tab lock; Firefox falls back
     to the same in-module chain the test harness already uses, which
     still serializes everything within one tab — losing only the
     cross-tab race protection for the rare case of two Firefox tabs on
     the trade site racing the exact same write. typeof browser !==
     "undefined" is the same Firefox-detection already used for
     PH.browserAPI above — a content script is the only context this
     runs in, so there's no background/popup case to also worry about
     here. */
  let writeChain = Promise.resolve();
  function withLock(fn) {
    const isFirefox = typeof browser !== "undefined";
    if (!isFirefox && typeof navigator !== "undefined" && navigator.locks?.request) {
      return navigator.locks.request("ph-store-mutate", fn);
    }
    const result = writeChain.then(fn, fn);
    writeChain = result.then(() => {}, () => {});
    return result;
  }

  /* ----------------------------------------------------------------------
     One-time migration from v0.1, which kept a flat `bookmarks` array with
     full URLs. We fold those into a folder rather than dropping them.
     ---------------------------------------------------------------------- */
  async function migrateLegacyBookmarks() {
    return withLock(async () => {
      const { bookmarks } = await PH.browserAPI.storage.local.get("bookmarks");
      if (!Array.isArray(bookmarks) || bookmarks.length === 0) return;

      const folders = (await PH.browserAPI.storage.local.get("folders")).folders ?? [];
      const trades = (await PH.browserAPI.storage.local.get("trades")).trades ?? {};

      const folderId = newId();
      folders.push({
        id: folderId,
        title: "Imported",
        icon: "map",
        version: "1",
        archivedAt: null,
      });

      trades[folderId] = bookmarks
        .map((b) => {
          const loc = PH.location.parseUrl(b.url);
          if (!loc) return null;
          return {
            id: newId(),
            title: b.name || "Untitled",
            completedAt: null,
            location: { version: loc.version, type: loc.type, slug: loc.slug },
          };
        })
        .filter(Boolean);

      await PH.browserAPI.storage.local.set({ folders, trades });
      await PH.browserAPI.storage.local.remove("bookmarks");
      LOG(`migrated ${trades[folderId].length} old bookmarks into a folder`);
    });
  }

  /* ---------------------------------------------------------------- folders */

  async function getFolders() {
    return (await readAll()).folders;
  }

  /* Returns the saved folder, or null if `folder.id` was given but no
     longer matches anything (it was deleted, in this tab or another, in
     the time between the editor opening and this submit) — callers must
     check for null rather than assume an id-carrying save always lands,
     since silently no-op'ing here while the caller still reports success
     would hide a real failure from the user. */
  async function saveFolder(folder) {
    return withLock(async () => {
      const { folders } = await readAll();
      if (folder.id) {
        const i = folders.findIndex((f) => f.id === folder.id);
        if (i === -1) return null;
        folders[i] = { ...folders[i], ...folder };
      } else {
        folder.id = newId();
        folder.archivedAt = folder.archivedAt ?? null;
        folders.push(folder);
      }
      await PH.browserAPI.storage.local.set({ folders });
      return folder;
    });
  }

  async function deleteFolder(folderId) {
    return withLock(async () => {
      const { folders, trades } = await readAll();
      delete trades[folderId];
      await PH.browserAPI.storage.local.set({
        folders: folders.filter((f) => f.id !== folderId),
        trades,
      });
    });
  }

  /* Archiving moves the folder to the end of the list, the way Better
     Trading does it, so active folders stay together at the top. */
  async function toggleFolderArchive(folderId) {
    return withLock(async () => {
      const { folders } = await readAll();
      const i = folders.findIndex((f) => f.id === folderId);
      if (i === -1) return;
      const folder = folders[i];
      folder.archivedAt = folder.archivedAt ? null : new Date().toUTCString();
      folders.splice(i, 1);
      folders.push(folder);
      await PH.browserAPI.storage.local.set({ folders });
    });
  }

  /* Reordering only ever hands us the folders currently VISIBLE (one game
     version, archived or not). Splicing that subset straight into storage
     would scramble the hidden ones, so we write the reordered items back
     into the slots they already occupied. */
  async function reorderFolders(visibleIdsInNewOrder) {
    return withLock(async () => {
      const { folders } = await readAll();
      const slots = [];
      folders.forEach((f, i) => {
        if (visibleIdsInNewOrder.includes(f.id)) slots.push(i);
      });
      if (slots.length !== visibleIdsInNewOrder.length) return;
      const byId = new Map(folders.map((f) => [f.id, f]));
      slots.forEach((slot, n) => {
        folders[slot] = byId.get(visibleIdsInNewOrder[n]);
      });
      await PH.browserAPI.storage.local.set({ folders });
    });
  }

  /* ----------------------------------------------------------------- trades */

  async function getTrades(folderId) {
    return (await readAll()).trades[folderId] ?? [];
  }

  /* Returns the saved trade, or null on failure — either the parent folder
     no longer exists (guards against resurrecting an orphaned trades[]
     entry under a deleted folder id when registering a brand new trade),
     or `trade.id` was given but no longer matches anything in that folder.
     Callers must check for null; see saveFolder's own note for why a
     silent no-op here can't be allowed to look like success upstream. */
  async function saveTrade(folderId, trade) {
    return withLock(async () => {
      const { folders, trades } = await readAll();
      if (!folders.some((f) => f.id === folderId)) return null;

      const list = trades[folderId] ?? [];
      if (trade.id) {
        const i = list.findIndex((t) => t.id === trade.id);
        if (i === -1) return null;
        list[i] = { ...list[i], ...trade };
      } else {
        trade.id = newId();
        trade.completedAt = trade.completedAt ?? null;
        list.push(trade);
      }
      trades[folderId] = list;
      await PH.browserAPI.storage.local.set({ trades });
      return trade;
    });
  }

  async function replaceTrades(folderId, list) {
    return withLock(async () => {
      const { trades } = await readAll();
      trades[folderId] = list;
      await PH.browserAPI.storage.local.set({ trades });
    });
  }

  async function deleteTrade(folderId, tradeId) {
    return withLock(async () => {
      const { trades } = await readAll();
      trades[folderId] = (trades[folderId] ?? []).filter((t) => t.id !== tradeId);
      await PH.browserAPI.storage.local.set({ trades });
    });
  }

  const PRICE_HISTORY_MAX = 5;
  /* A repeat visit within this window that finds the SAME price doesn't earn
     its own slot — it just refreshes the latest entry's timestamp. With only
     PRICE_HISTORY_MAX slots, uneventful re-checks would otherwise crowd out
     an actual price change; this keeps the history meaningful (real changes)
     rather than a log of "still 7c" several times over. */
  const PRICE_DEDUP_MS = 3 * 60 * 60 * 1000;

  /* Shared by pushTradePrice and pushFolderTotalCost: appends entry onto a
     rolling history, capped at PRICE_HISTORY_MAX, collapsing a same-value
     recheck within PRICE_DEDUP_MS into a timestamp refresh on the latest
     entry instead of its own slot. */
  function nextPriceHistory(history, entry) {
    const latest = history.at(-1);
    const samePrice = latest && latest.amount === entry.amount && latest.currency === entry.currency;
    const recent = latest && new Date(entry.capturedAt) - new Date(latest.capturedAt) < PRICE_DEDUP_MS;

    return samePrice && recent
      ? [...history.slice(0, -1), entry]
      : [...history, entry].slice(-PRICE_HISTORY_MAX);
  }

  /* Appends one price observation onto a trade's rolling history — used when
     auto-detecting a visit to a bookmarked search (main.js's poll loop calls
     into PH.bookmarks, which calls this). Register/repoint don't use this:
     they each start a *fresh* history via a plain saveTrade, since a
     repointed trade's old prices belonged to a different search entirely. */
  async function pushTradePrice(folderId, tradeId, entry) {
    return withLock(async () => {
      const { trades } = await readAll();
      const list = trades[folderId] ?? [];
      const i = list.findIndex((t) => t.id === tradeId);
      if (i === -1) return;

      const trade = list[i];
      const history = trade.priceHistory ?? (trade.priceAtSave ? [trade.priceAtSave] : []);
      list[i] = { ...trade, priceHistory: nextPriceHistory(history, entry) };
      trades[folderId] = list;
      await PH.browserAPI.storage.local.set({ trades });
    });
  }

  /* Appends one Total Cost observation onto a folder's own rolling history —
     called only when the folder is opened and its total recomputed
     (PH.bookmarks.renderTrades), not on a timer, so the dedup window mostly
     guards against opening/closing the same folder in quick succession
     without anything actually having changed. */
  async function pushFolderTotalCost(folderId, entry) {
    return withLock(async () => {
      const { folders } = await readAll();
      const i = folders.findIndex((f) => f.id === folderId);
      if (i === -1) return;

      const history = folders[i].totalCostHistory ?? [];
      folders[i] = { ...folders[i], totalCostHistory: nextPriceHistory(history, entry) };
      await PH.browserAPI.storage.local.set({ folders });
    });
  }

  /* Resets the folder's own Total Cost trend history back to a fresh
     baseline: currentTotal (the caller's own live recomputation, from that
     folder's actual current trades — see totalCostFor/tradesByFolder in
     bookmarks.js) becomes the single entry kept, so there's nothing left to
     compare against — no trend arrow, no multi-point popup — until a
     genuinely new total differs from it on a later render. null (nothing
     priced right now) clears the history to empty instead, rather than
     keeping a number with nothing behind it.

     Deliberately NOT the previously-stored "latest" entry (an earlier
     version just kept whatever was already there) — that value can already
     be stale relative to the live trades: renderTrades' own debounced
     Total Cost push (TOTAL_COST_PUSH_DEBOUNCE_MS, up to 4s out) can still
     be in flight when this runs, and if it landed after a reset that kept
     the old stale entry, it appended a second, *different* entry right
     back — a real, reported bug where "Reset Total Cost trend" appeared to
     do nothing, since the trend it just cleared reappeared moments later.
     Keeping the live total here instead means even a stale pending push
     resolves to the exact same amount, which nextPriceHistory's own dedup
     (see pushFolderTotalCost) collapses into a timestamp refresh on this
     same entry rather than a new slot.

     The trades underneath, and their own price histories, are untouched. */
  async function clearFolderTotalCost(folderId, currentTotal) {
    return withLock(async () => {
      const { folders } = await readAll();
      const i = folders.findIndex((f) => f.id === folderId);
      if (i === -1) return;

      const kept = currentTotal != null
        ? [{ amount: currentTotal, currency: "chaos", capturedAt: new Date().toISOString() }]
        : [];
      folders[i] = { ...folders[i], totalCostHistory: kept };
      await PH.browserAPI.storage.local.set({ folders });
    });
  }

  /* Wipes every trade's price history in the folder (and the legacy
     singular priceAtSave some older trades still carry), plus the folder's
     own Total Cost history — a full wipe here, not clearFolderTotalCost's
     keep-the-latest-entry behavior, since once every trade's price is gone
     there's no real data left to justify showing ANY total, current or
     otherwise. The trades themselves, and everything else about them, are
     untouched. */
  async function clearFolderPriceHistory(folderId) {
    return withLock(async () => {
      const { trades, folders } = await readAll();
      const list = trades[folderId] ?? [];
      trades[folderId] = list.map((t) => {
        const next = { ...t, priceHistory: [] };
        delete next.priceAtSave;
        return next;
      });

      const i = folders.findIndex((f) => f.id === folderId);
      if (i !== -1) folders[i] = { ...folders[i], totalCostHistory: [] };

      await PH.browserAPI.storage.local.set({ trades, folders });
    });
  }

  async function reorderTrades(folderId, idsInNewOrder) {
    return withLock(async () => {
      const { trades } = await readAll();
      const list = trades[folderId] ?? [];
      const byId = new Map(list.map((t) => [t.id, t]));
      const reordered = idsInNewOrder.map((id) => byId.get(id)).filter(Boolean);
      if (reordered.length !== list.length) return;
      trades[folderId] = reordered;
      await PH.browserAPI.storage.local.set({ trades });
    });
  }

  /* ---------------------------------------------------------------- leagues */

  /* Called whenever the URL changes, purely to remember "the last league you
     were browsing, per game" — the fallback resolveLeague() in location.js
     uses when a bookmark/live search has no page to inherit a league from. */
  async function noteLeague(loc) {
    if (!loc?.version || !loc?.league) return;
    return withLock(async () => {
      const { leagues } = await readAll();
      if (leagues[loc.version] === loc.league) return;
      leagues[loc.version] = loc.league;
      await PH.browserAPI.storage.local.set({ leagues });
    });
  }

  /* ---------------------------------------------------------- saved listings

     A manually-saved snapshot of one specific trade offer — what it was, what
     it cost, who was selling it, when. This is deliberately NOT live data: the
     listing may already be sold by the time you look at it again. It keeps
     its league for the same reason a history entry used to — it's a record of
     a specific past moment, not a reusable search like a bookmark. */

  async function getSavedListings() {
    return (await readAll()).savedListings;
  }

  /* The "is this already saved?" check and the write happen under the same
     lock — so two saves fired close together (two tabs on the same search,
     or a click landing twice before the button disables) can't both pass
     the check against the same stale read and both write a duplicate.
     `isDuplicate` is the caller's own matching logic (PH.saved.matchingListing
     scoped to one candidate); it runs against a fresh read taken right
     before the write, not whatever the caller read earlier. Returns the
     saved listing, or null if a duplicate was found and nothing was
     written. */
  async function saveSavedListingUnlessDuplicate(listing, isDuplicate) {
    return withLock(async () => {
      const { savedListings } = await readAll();
      if (savedListings.some(isDuplicate)) return null;

      listing.id = newId();
      listing.savedAt = listing.savedAt ?? new Date().toISOString();
      savedListings.unshift(listing);
      await PH.browserAPI.storage.local.set({ savedListings });
      return listing;
    });
  }

  async function deleteSavedListing(id) {
    await deleteSavedListings([id]);
  }

  /* Used by "Clear all" and "Clear selected" — one storage write for
     however many listings, rather than one per listing. Also dismantles
     any manual group left with fewer than 2 members once these are gone
     — a group of exactly one is never really a group (buildGroups in
     saved.js already refuses to render one as one), so a delete that
     drops one to 1 clears that survivor's own groupId too, not just a
     group left at 0. */
  async function deleteSavedListings(ids) {
    return withLock(async () => {
      const idSet = new Set(ids);
      const { savedListings, savedGroups } = await readAll();
      const remaining = savedListings.filter((l) => !idSet.has(l.id));

      const countByGroup = new Map();
      for (const l of remaining) {
        if (l.groupId) countByGroup.set(l.groupId, (countByGroup.get(l.groupId) ?? 0) + 1);
      }
      for (const l of remaining) {
        if (l.groupId && countByGroup.get(l.groupId) < 2) l.groupId = null;
      }

      const stillUsed = new Set(remaining.map((l) => l.groupId).filter(Boolean));
      await PH.browserAPI.storage.local.set({
        savedListings: remaining,
        savedGroups: (savedGroups ?? []).filter((g) => stillUsed.has(g.id)),
      });
    });
  }

  /* ---------------------------------------------------------- saved groups */

  async function getSavedGroups() {
    return (await readAll()).savedGroups ?? [];
  }

  /* Creates a new manual group and returns it — used both when dragging
     one listing onto another (a fresh group) and when renaming what was
     an automatic group (promoting it into a real, named one). */
  async function createSavedGroup(title) {
    return withLock(async () => {
      const { savedGroups } = await readAll();
      const group = { id: newId(), title };
      const list = [...(savedGroups ?? []), group];
      await PH.browserAPI.storage.local.set({ savedGroups: list });
      return group;
    });
  }

  async function renameSavedGroup(id, title) {
    return withLock(async () => {
      const { savedGroups } = await readAll();
      const group = (savedGroups ?? []).find((g) => g.id === id);
      if (!group) return;

      group.title = title;
      await PH.browserAPI.storage.local.set({ savedGroups });
    });
  }

  /* Sets or clears (groupId: null) which manual group a listing belongs
     to — moving one listing between groups, not the whole-group dissolve
     ungroupListings below does. If the listing was already in a
     different group, and leaving it drops that old group to fewer than 2
     members, the old group dismantles too (its survivor's own groupId
     cleared, the now-unused savedGroups entry removed) — a group of one
     is never really a group. */
  async function setListingGroup(id, groupId) {
    return withLock(async () => {
      const { savedListings, savedGroups } = await readAll();
      const listing = savedListings.find((l) => l.id === id);
      if (!listing) return;

      const previousGroupId = listing.groupId ?? null;
      listing.groupId = groupId ?? null;

      let groups = savedGroups ?? [];
      if (previousGroupId && previousGroupId !== listing.groupId) {
        const remainingInOld = savedListings.filter((l) => l.groupId === previousGroupId).length;
        if (remainingInOld < 2) {
          for (const l of savedListings) if (l.groupId === previousGroupId) l.groupId = null;
          groups = groups.filter((g) => g.id !== previousGroupId);
        }
      }

      await PH.browserAPI.storage.local.set({ savedListings, savedGroups: groups });
    });
  }

  /* Ungroups every listing currently in `groupId` (back to no group) and
     deletes the now-empty group entry itself — the only action that
     dissolves a manual group outright, as opposed to setListingGroup
     moving one listing at a time. */
  async function ungroupListings(groupId) {
    return withLock(async () => {
      const { savedListings, savedGroups } = await readAll();
      for (const l of savedListings) {
        if (l.groupId === groupId) l.groupId = null;
      }
      await PH.browserAPI.storage.local.set({
        savedListings,
        savedGroups: (savedGroups ?? []).filter((g) => g.id !== groupId),
      });
    });
  }

  /* Appends one price observation onto a saved listing's rolling history —
     used when "Search this exact item" finds real results (see
     PH.saved.capturePendingPrice and the poll loop in main.js). Shares
     nextPriceHistory's cap/dedup with bookmark trades and folder totals, so
     a same-price recheck just refreshes the latest entry's timestamp
     rather than taking a slot. */
  async function pushSavedListingPrice(id, entry) {
    return withLock(async () => {
      const { savedListings } = await readAll();
      const listing = savedListings.find((l) => l.id === id);
      if (!listing) return;

      listing.priceHistory = nextPriceHistory(listing.priceHistory ?? [], entry);
      await PH.browserAPI.storage.local.set({ savedListings });
    });
  }

  /* Merges `fields` onto a saved listing in place — used by
     PH.saved.capturePendingPrice to refresh the whole captured snapshot
     (mods, properties, rarity, icon, sourceId, listedAt, ...) from the
     matched row on a real re-search, not just the price. Plain
     Object.assign rather than a field-by-field setter: every field this
     gets called with already comes straight from the same row-reading
     functions captureListing itself uses, so there's nothing keeping this
     any narrower than "whatever the caller read off the row." priceHistory
     is deliberately never passed through here — that stays on
     pushSavedListingPrice's own dedup path so a same-price re-search still
     only refreshes a timestamp instead of overwriting real history.
     capturePendingPrice checks the row's seller against the listing's own
     stored seller before ever calling this — a real report caught the
     "cheapest match" landing on a different, merely similar-looking item
     (from a different seller) and silently overwriting the original
     listing's record with it, so this function itself trusts its caller
     to have already ruled that out rather than re-checking here. */
  async function updateSavedListingSnapshot(id, fields) {
    return withLock(async () => {
      const { savedListings } = await readAll();
      const listing = savedListings.find((l) => l.id === id);
      if (!listing) return;

      Object.assign(listing, fields);
      await PH.browserAPI.storage.local.set({ savedListings });
    });
  }

  /* Flags/clears a saved listing as "the last exact search for it found
     zero results" — see the noResultsFound schema note above. Set by
     PH.saved.rebuildSearch right after a real, well-formed search (exact
     name/type + every mod pinned min=max) comes back empty; cleared by
     that same row's "Cancel" or by deleting the listing outright.
     Persisted on the listing itself rather than kept as in-memory UI
     state, specifically so it shows up via the ordinary
     PH.browserAPI.storage.onChange -> refresh every tab already reacts to — no
     need to guess which tab counts as "the" one to prompt in when the
     results tab the search just opened has its own independent copy of
     this same row. */
  async function setListingNoResults(id, value) {
    return withLock(async () => {
      const { savedListings } = await readAll();
      const listing = savedListings.find((l) => l.id === id);
      if (!listing) return;

      if (value) listing.noResultsFound = true;
      else delete listing.noResultsFound;
      await PH.browserAPI.storage.local.set({ savedListings });
    });
  }

  /* ------------------------------------------------------- price capture */

  async function setPendingPriceCapture(id) {
    await PH.browserAPI.storage.local.set({ pendingPriceCapture: id });
  }

  async function getPendingPriceCapture() {
    return (await readAll()).pendingPriceCapture;
  }

  async function clearPendingPriceCapture() {
    await PH.browserAPI.storage.local.set({ pendingPriceCapture: null });
  }

  /* ------------------------------------------------- search this exact item */

  async function getTradeSearchCooldown() {
    return (await readAll()).tradeSearchCooldown;
  }

  async function setTradeSearchCooldown(blockedUntil) {
    await PH.browserAPI.storage.local.set({ tradeSearchCooldown: blockedUntil });
  }

  async function getTradeFetchCooldown() {
    return (await readAll()).tradeFetchCooldown;
  }

  async function setTradeFetchCooldown(blockedUntil) {
    await PH.browserAPI.storage.local.set({ tradeFetchCooldown: blockedUntil });
  }

  async function getTradeRateState() {
    return (await readAll()).tradeRateState;
  }

  async function setTradeRateState(endpoint, data) {
    const tradeRateState = await getTradeRateState();
    await PH.browserAPI.storage.local.set({ tradeRateState: { ...tradeRateState, [endpoint]: data } });
  }

  const CLICK_HORIZON_DEFAULT_SECONDS = 120;
  const CLICK_HORIZON_MAX_SECONDS = 900;

  /* How far back tradeLinkClicks needs to reach to be useful: at least the
     longest rate-limit window we've actually seen (no point pruning a click
     that's still inside a real window PH.rateLimitOverlay is tracking), but
     capped so a policy with a very long window (GGG's real search policy
     carries one over 21600s) can't make this grow for hours — a warning
     about clicking too fast only makes sense over a much shorter horizon
     than that anyway. Falls back to a fixed default before any real
     tradeRateState exists yet. */
  function clickHorizonSeconds(tradeRateState) {
    const periods = [tradeRateState?.search, tradeRateState?.fetch]
      .filter(Boolean)
      .flatMap((endpoint) => endpoint.entries.map((entry) => entry.period));
    if (!periods.length) return CLICK_HORIZON_DEFAULT_SECONDS;
    return Math.min(Math.max(...periods), CLICK_HORIZON_MAX_SECONDS);
  }

  async function getTradeLinkClicks() {
    return (await readAll()).tradeLinkClicks;
  }

  /* Called on every bookmark trade-link click (see PH.bookmarks' tradeRow) —
     there's no response for this tab to read a real rate-limit reading from,
     since the click navigates away before one could come back, so this is
     the only record that click ever happened. */
  async function recordTradeLinkClick() {
    const data = await readAll();
    const horizonMs = clickHorizonSeconds(data.tradeRateState) * 1000;
    const now = Date.now();
    const tradeLinkClicks = data.tradeLinkClicks.filter((t) => now - t < horizonMs);
    tradeLinkClicks.push(now);
    await PH.browserAPI.storage.local.set({ tradeLinkClicks });
  }

  /* --------------------------------------------------------------- settings */

  async function getSettings() {
    return (await readAll()).settings;
  }

  async function getLastSeenLeagues() {
    return (await readAll()).leagues;
  }

  /* Let any part of the UI react to a change made somewhere else — the
     popup toggling a setting, or a second trade tab adding a bookmark. */
  function onChange(callback) {
    PH.browserAPI.storage.onChanged.addListener((changes, area) => {
      if (area === "local") callback(changes);
    });
  }

  return {
    newId, readAll, migrateLegacyBookmarks,
    getFolders, saveFolder, deleteFolder, toggleFolderArchive, reorderFolders, pushFolderTotalCost,
    clearFolderTotalCost, clearFolderPriceHistory,
    getTrades, saveTrade, replaceTrades, deleteTrade, reorderTrades, pushTradePrice,
    getSavedListings, saveSavedListingUnlessDuplicate, deleteSavedListing, deleteSavedListings, pushSavedListingPrice,
    updateSavedListingSnapshot, setListingNoResults,
    getSavedGroups, createSavedGroup, renameSavedGroup, setListingGroup, ungroupListings,
    setPendingPriceCapture, getPendingPriceCapture, clearPendingPriceCapture,
    getTradeSearchCooldown, setTradeSearchCooldown, getTradeFetchCooldown, setTradeFetchCooldown,
    getTradeRateState, setTradeRateState, getTradeLinkClicks, recordTradeLinkClick,
    noteLeague, getSettings, getLastSeenLeagues, onChange,
  };
})();
