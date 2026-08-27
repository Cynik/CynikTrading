/* =========================================================================
   store.js — everything that gets saved, and the only file that touches
   chrome.storage. Loaded first, so every other file can use PH.store.
   =========================================================================
   Data model (all under chrome.storage.local):

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
     liveSearches [ { id, title, addedAt, location } ]   flat, not per-folder
     savedListings [ { id, savedAt, league, location, title, price, seller, mods } ]
     settings     { tildePrefix, showPriceConversion }
     leagues      { "1": "Allflame", "2": "Runes of Aldur" }   last seen per game

   A saved search's `location` is { version, type, slug } and deliberately
   has NO league. That is the whole trick: the slug is league-independent on
   GGG's side, so a bookmark saved last league opens in the current one. See
   location.js for how the league gets filled in at click time.
   ========================================================================= */

window.PH = window.PH || {};

PH.store = (() => {
  const LOG = (...a) => console.log("[PoE Helper store]", ...a);

  /* IDs only need to be unique on this machine, so this is plenty. */
  const newId = () =>
    Math.random().toString(36).slice(2) + Date.now().toString(36);

  const DEFAULTS = {
    folders: [],
    trades: {},
    liveSearches: [],
    savedListings: [],
    settings: { tildePrefix: true, showPriceConversion: true },
    leagues: {},
  };

  async function readAll() {
    const raw = await chrome.storage.local.get(Object.keys(DEFAULTS));
    const data = {};
    for (const key of Object.keys(DEFAULTS)) {
      data[key] = raw[key] ?? structuredClone(DEFAULTS[key]);
    }
    return data;
  }

  /* ----------------------------------------------------------------------
     One-time migration from v0.1, which kept a flat `bookmarks` array with
     full URLs. We fold those into a folder rather than dropping them.
     ---------------------------------------------------------------------- */
  async function migrateLegacyBookmarks() {
    const { bookmarks } = await chrome.storage.local.get("bookmarks");
    if (!Array.isArray(bookmarks) || bookmarks.length === 0) return;

    const folders = (await chrome.storage.local.get("folders")).folders ?? [];
    const trades = (await chrome.storage.local.get("trades")).trades ?? {};

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

    await chrome.storage.local.set({ folders, trades });
    await chrome.storage.local.remove("bookmarks");
    LOG(`migrated ${trades[folderId].length} old bookmarks into a folder`);
  }

  /* ---------------------------------------------------------------- folders */

  async function getFolders() {
    return (await readAll()).folders;
  }

  async function saveFolder(folder) {
    const { folders } = await readAll();
    if (folder.id) {
      const i = folders.findIndex((f) => f.id === folder.id);
      if (i !== -1) folders[i] = { ...folders[i], ...folder };
    } else {
      folder.id = newId();
      folder.archivedAt = folder.archivedAt ?? null;
      folders.push(folder);
    }
    await chrome.storage.local.set({ folders });
    return folder;
  }

  async function deleteFolder(folderId) {
    const { folders, trades } = await readAll();
    delete trades[folderId];
    await chrome.storage.local.set({
      folders: folders.filter((f) => f.id !== folderId),
      trades,
    });
  }

  /* Archiving moves the folder to the end of the list, the way Better
     Trading does it, so active folders stay together at the top. */
  async function toggleFolderArchive(folderId) {
    const { folders } = await readAll();
    const i = folders.findIndex((f) => f.id === folderId);
    if (i === -1) return;
    const folder = folders[i];
    folder.archivedAt = folder.archivedAt ? null : new Date().toUTCString();
    folders.splice(i, 1);
    folders.push(folder);
    await chrome.storage.local.set({ folders });
  }

  /* Reordering only ever hands us the folders currently VISIBLE (one game
     version, archived or not). Splicing that subset straight into storage
     would scramble the hidden ones, so we write the reordered items back
     into the slots they already occupied. */
  async function reorderFolders(visibleIdsInNewOrder) {
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
    await chrome.storage.local.set({ folders });
  }

  /* ----------------------------------------------------------------- trades */

  async function getTrades(folderId) {
    return (await readAll()).trades[folderId] ?? [];
  }

  async function saveTrade(folderId, trade) {
    const { trades } = await readAll();
    const list = trades[folderId] ?? [];
    if (trade.id) {
      const i = list.findIndex((t) => t.id === trade.id);
      if (i !== -1) list[i] = { ...list[i], ...trade };
    } else {
      trade.id = newId();
      trade.completedAt = trade.completedAt ?? null;
      list.push(trade);
    }
    trades[folderId] = list;
    await chrome.storage.local.set({ trades });
    return trade;
  }

  async function replaceTrades(folderId, list) {
    const { trades } = await readAll();
    trades[folderId] = list;
    await chrome.storage.local.set({ trades });
  }

  async function deleteTrade(folderId, tradeId) {
    const list = await getTrades(folderId);
    await replaceTrades(folderId, list.filter((t) => t.id !== tradeId));
  }

  const PRICE_HISTORY_MAX = 5;
  /* A repeat visit within this window that finds the SAME price doesn't earn
     its own slot — it just refreshes the latest entry's timestamp. With only
     3 slots, three uneventful re-checks would otherwise crowd out an actual
     price change; this keeps the history meaningful (real changes) rather
     than a log of "still 7c" three times over. */
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
    const list = await getTrades(folderId);
    const trade = list.find((t) => t.id === tradeId);
    if (!trade) return;

    const history = trade.priceHistory ?? (trade.priceAtSave ? [trade.priceAtSave] : []);
    await saveTrade(folderId, { id: tradeId, priceHistory: nextPriceHistory(history, entry) });
  }

  /* Appends one Total Cost observation onto a folder's own rolling history —
     called only when the folder is opened and its total recomputed
     (PH.bookmarks.renderTrades), not on a timer, so the dedup window mostly
     guards against opening/closing the same folder in quick succession
     without anything actually having changed. */
  async function pushFolderTotalCost(folderId, entry) {
    const { folders } = await readAll();
    const folder = folders.find((f) => f.id === folderId);
    if (!folder) return;

    const history = folder.totalCostHistory ?? [];
    await saveFolder({ id: folderId, totalCostHistory: nextPriceHistory(history, entry) });
  }

  /* Resets the folder's own Total Cost trend history back to a fresh
     baseline: the current total (its most recent entry, if any) is kept so
     the header keeps showing a live number, but everything older than that
     is dropped, so there's nothing left to compare against — no trend
     arrow, no multi-point popup — until a genuinely new total gets
     recorded on a later open. The trades underneath, and their own price
     histories, are untouched. */
  async function clearFolderTotalCost(folderId) {
    const { folders } = await readAll();
    const folder = folders.find((f) => f.id === folderId);
    if (!folder) return;

    const latest = (folder.totalCostHistory ?? []).at(-1);
    await saveFolder({ id: folderId, totalCostHistory: latest ? [latest] : [] });
  }

  /* Wipes every trade's price history in the folder (and the legacy
     singular priceAtSave some older trades still carry), plus the folder's
     own Total Cost history — a full wipe here, not clearFolderTotalCost's
     keep-the-latest-entry behavior, since once every trade's price is gone
     there's no real data left to justify showing ANY total, current or
     otherwise. The trades themselves, and everything else about them, are
     untouched. */
  async function clearFolderPriceHistory(folderId) {
    const list = await getTrades(folderId);
    const cleared = list.map((t) => {
      const next = { ...t, priceHistory: [] };
      delete next.priceAtSave;
      return next;
    });
    await replaceTrades(folderId, cleared);
    await saveFolder({ id: folderId, totalCostHistory: [] });
  }

  async function reorderTrades(folderId, idsInNewOrder) {
    const list = await getTrades(folderId);
    const byId = new Map(list.map((t) => [t.id, t]));
    const reordered = idsInNewOrder.map((id) => byId.get(id)).filter(Boolean);
    if (reordered.length !== list.length) return;
    await replaceTrades(folderId, reordered);
  }

  /* ------------------------------------------------------- live searches --
     A flat list (not folder-scoped) of searches you want quick access to
     open as a live search. Same location shape as a trade, so it survives a
     league reset the same way bookmarks do. */

  async function getLiveSearches() {
    return (await readAll()).liveSearches;
  }

  async function saveLiveSearch(entry) {
    const { liveSearches } = await readAll();
    if (entry.id) {
      const i = liveSearches.findIndex((s) => s.id === entry.id);
      if (i !== -1) liveSearches[i] = { ...liveSearches[i], ...entry };
    } else {
      entry.id = newId();
      entry.addedAt = entry.addedAt ?? new Date().toISOString();
      liveSearches.push(entry);
    }
    await chrome.storage.local.set({ liveSearches });
    return entry;
  }

  async function deleteLiveSearch(id) {
    const { liveSearches } = await readAll();
    await chrome.storage.local.set({
      liveSearches: liveSearches.filter((s) => s.id !== id),
    });
  }

  /* Same trick as reorderFolders: the list mixes both games, but the UI only
     ever shows and reorders one game's entries at a time. Write the reordered
     visible items back into the slots they already occupied so the hidden
     game's entries don't get scrambled. */
  async function reorderLiveSearches(visibleIdsInNewOrder) {
    const { liveSearches } = await readAll();
    const slots = [];
    liveSearches.forEach((s, i) => {
      if (visibleIdsInNewOrder.includes(s.id)) slots.push(i);
    });
    if (slots.length !== visibleIdsInNewOrder.length) return;
    const byId = new Map(liveSearches.map((s) => [s.id, s]));
    slots.forEach((slot, n) => {
      liveSearches[slot] = byId.get(visibleIdsInNewOrder[n]);
    });
    await chrome.storage.local.set({ liveSearches });
  }

  /* ---------------------------------------------------------------- leagues */

  /* Called whenever the URL changes, purely to remember "the last league you
     were browsing, per game" — the fallback resolveLeague() in location.js
     uses when a bookmark/live search has no page to inherit a league from. */
  async function noteLeague(loc) {
    if (!loc?.version || !loc?.league) return;
    const { leagues } = await readAll();
    if (leagues[loc.version] === loc.league) return;
    leagues[loc.version] = loc.league;
    await chrome.storage.local.set({ leagues });
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

  async function saveSavedListing(listing) {
    const { savedListings } = await readAll();
    listing.id = newId();
    listing.savedAt = listing.savedAt ?? new Date().toISOString();
    savedListings.unshift(listing);
    await chrome.storage.local.set({ savedListings });
    return listing;
  }

  async function deleteSavedListing(id) {
    const { savedListings } = await readAll();
    await chrome.storage.local.set({
      savedListings: savedListings.filter((l) => l.id !== id),
    });
  }

  /* --------------------------------------------------------------- settings */

  async function getSettings() {
    return (await readAll()).settings;
  }

  async function setSetting(key, value) {
    const settings = await getSettings();
    settings[key] = value;
    await chrome.storage.local.set({ settings });
  }

  async function getLastSeenLeagues() {
    return (await readAll()).leagues;
  }

  /* Let any part of the UI react to a change made somewhere else — the
     popup toggling a setting, or a second trade tab adding a bookmark. */
  function onChange(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") callback(changes);
    });
  }

  return {
    newId, readAll, migrateLegacyBookmarks,
    getFolders, saveFolder, deleteFolder, toggleFolderArchive, reorderFolders, pushFolderTotalCost,
    clearFolderTotalCost, clearFolderPriceHistory,
    getTrades, saveTrade, replaceTrades, deleteTrade, reorderTrades, pushTradePrice,
    getLiveSearches, saveLiveSearch, deleteLiveSearch, reorderLiveSearches,
    getSavedListings, saveSavedListing, deleteSavedListing,
    noteLeague, getSettings, setSetting, getLastSeenLeagues, onChange,
  };
})();
