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
     savedListings [ { id, savedAt, listedAt, league, location, sourceId,
                       title, name, type, icon, rarity, unidentified,
                       price, priceIcon, seller, mods, priceHistory?,
                       groupId? } ]
                    groupId, when set, references a savedGroups entry
                    (below) — set by dragging one listing onto another,
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
                    (see setListingListedAt) every time "Search this exact
                    item" finds real results, the same visit it captures a
                    fresh price — the original listing isn't necessarily
                    still the cheapest match by then (relisted, undercut,
                    time passed), so this keeps "listed X ago" honest
                    instead of frozen at whatever it read at save time.
                    Listings saved before listedAt existed fall back to
                    showing savedAt instead.
                    sourceId is the result row's own data-id, GGG's id for
                    that specific listing — lets PH.saved.syncSaveButtons
                    recognize "already saved" if the same search turns up
                    the same listing again; listings saved before this
                    existed just never match. name/type are the item's
                    flavour name and base type kept apart
                    (not joined like the display title), for "Search this
                    exact item"'s query.name/query.type. mods is
                    [ { id, text, value } ] — id is the stat's own internal
                    id from its data-field attribute, for that same
                    feature's stat filters; listings saved before that
                    existed just have plain strings instead. priceHistory is
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
    savedListings: [],
    savedGroups: [],
    pendingPriceCapture: null,
    tradeSearchCooldown: null,
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
    await chrome.storage.local.set({
      savedListings: remaining,
      savedGroups: (savedGroups ?? []).filter((g) => stillUsed.has(g.id)),
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
    const { savedGroups } = await readAll();
    const group = { id: newId(), title };
    const list = [...(savedGroups ?? []), group];
    await chrome.storage.local.set({ savedGroups: list });
    return group;
  }

  async function renameSavedGroup(id, title) {
    const { savedGroups } = await readAll();
    const group = (savedGroups ?? []).find((g) => g.id === id);
    if (!group) return;

    group.title = title;
    await chrome.storage.local.set({ savedGroups });
  }

  /* Sets or clears (groupId: null) which manual group a listing belongs
     to — moving one listing between groups, not the whole-group dissolve
     ungroupListings below does. If the listing was already in a
     different group, and leaving it drops that old group to fewer than 2
     members, the old group dismantles too (its survivor's own groupId
     cleared, the now-unused savedGroups entry removed) — a group of one
     is never really a group. */
  async function setListingGroup(id, groupId) {
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

    await chrome.storage.local.set({ savedListings, savedGroups: groups });
  }

  /* Ungroups every listing currently in `groupId` (back to no group) and
     deletes the now-empty group entry itself — the only action that
     dissolves a manual group outright, as opposed to setListingGroup
     moving one listing at a time. */
  async function ungroupListings(groupId) {
    const { savedListings, savedGroups } = await readAll();
    for (const l of savedListings) {
      if (l.groupId === groupId) l.groupId = null;
    }
    await chrome.storage.local.set({
      savedListings,
      savedGroups: (savedGroups ?? []).filter((g) => g.id !== groupId),
    });
  }

  /* Appends one price observation onto a saved listing's rolling history —
     used when "Search this exact item" finds real results (see
     PH.saved.capturePendingPrice and the poll loop in main.js). Shares
     nextPriceHistory's cap/dedup with bookmark trades and folder totals, so
     a same-price recheck just refreshes the latest entry's timestamp
     rather than taking a slot. */
  async function pushSavedListingPrice(id, entry) {
    const { savedListings } = await readAll();
    const listing = savedListings.find((l) => l.id === id);
    if (!listing) return;

    listing.priceHistory = nextPriceHistory(listing.priceHistory ?? [], entry);
    await chrome.storage.local.set({ savedListings });
  }

  /* Refreshes a saved listing's listedAt whenever "Search this exact item"
     finds real results — see PH.saved.capturePendingPrice, which reads it
     off the matched row the same visit it captures a price. The original
     listing you saved may no longer be the cheapest match (relisted,
     someone else undercut it, time passed), so this keeps "listed X ago"
     honest rather than leaving it frozen at whatever it was at save time. */
  async function setListingListedAt(id, listedAt) {
    const { savedListings } = await readAll();
    const listing = savedListings.find((l) => l.id === id);
    if (!listing) return;

    listing.listedAt = listedAt;
    await chrome.storage.local.set({ savedListings });
  }

  /* Flags/clears a saved listing as "the last exact search for it found
     zero results" — see the noResultsFound schema note above. Set by
     PH.saved.rebuildSearch right after a real, well-formed search (exact
     name/type + every mod pinned min=max) comes back empty; cleared by
     that same row's "Cancel" or by deleting the listing outright.
     Persisted on the listing itself rather than kept as in-memory UI
     state, specifically so it shows up via the ordinary
     chrome.storage.onChange -> refresh every tab already reacts to — no
     need to guess which tab counts as "the" one to prompt in when the
     results tab the search just opened has its own independent copy of
     this same row. */
  async function setListingNoResults(id, value) {
    const { savedListings } = await readAll();
    const listing = savedListings.find((l) => l.id === id);
    if (!listing) return;

    if (value) listing.noResultsFound = true;
    else delete listing.noResultsFound;
    await chrome.storage.local.set({ savedListings });
  }

  /* ------------------------------------------------------- price capture */

  async function setPendingPriceCapture(id) {
    await chrome.storage.local.set({ pendingPriceCapture: id });
  }

  async function getPendingPriceCapture() {
    return (await readAll()).pendingPriceCapture;
  }

  async function clearPendingPriceCapture() {
    await chrome.storage.local.set({ pendingPriceCapture: null });
  }

  /* ------------------------------------------------- search this exact item */

  async function getTradeSearchCooldown() {
    return (await readAll()).tradeSearchCooldown;
  }

  async function setTradeSearchCooldown(blockedUntil) {
    await chrome.storage.local.set({ tradeSearchCooldown: blockedUntil });
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
    getSavedListings, saveSavedListing, deleteSavedListing, deleteSavedListings, pushSavedListingPrice,
    setListingListedAt, setListingNoResults,
    getSavedGroups, createSavedGroup, renameSavedGroup, setListingGroup, ungroupListings,
    setPendingPriceCapture, getPendingPriceCapture, clearPendingPriceCapture,
    getTradeSearchCooldown, setTradeSearchCooldown,
    noteLeague, getSettings, setSetting, getLastSeenLeagues, onChange,
  };
})();
