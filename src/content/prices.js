/* =========================================================================
   prices.js — chaos ↔ divine conversion on result rows.
   =========================================================================
   The one feature that needs the network. The content script can't fetch
   poe.ninja (it inherits pathofexile.com's same-origin rules), so it asks the
   background service worker, which can.

   Verified against the live site (2026-08), from a real row's outerHTML:

     <span data-field="price" class="...">
       <span class="price-label buyout-price">Asking Price:</span>&nbsp;<br>
       <span>7</span><span>×</span>
       <span class="currency-text currency-image">
         <img src=".../CurrencyRerollRare.png" alt="chaos" title="chaos">
         <span>Chaos Orb</span>
       </span>
     </span>

   The amount ("7") is a bare, classless <span> — there's no selector for it
   specifically, so it's read as the first digit run in the whole price
   element's text (the label text never contains digits). `.currency-text`
   is NOT the amount; it wraps the icon *and the currency's own name*
   ("Chaos Orb") — an earlier version of this file assumed it held the
   amount, which silently broke both this feature and the price-snapshot
   used by Bookmarks. The currency itself comes from the icon's filename.
   ========================================================================= */

window.PH = window.PH || {};

PH.prices = (() => {
  const LOG = (...a) => console.log("[PoE Helper]", ...a);

  const ROW = ".resultset > div.row[data-id]";
  const MARK = "ph-priced";

  let rate = null;         // { divineInChaos, chaosValueByName, league, fetchedAt }
  let priceIndex = null;  // { items: [{name, baseType, chaosValue, divineValue, listingCount, gemLevel?, gemQuality?, corrupted?}], league, game }
  let enabled = true;
  let sortEnabled = true;

  async function init() {
    const settings = await PH.store.getSettings();
    enabled = settings.showPriceConversion !== false;
    sortEnabled = settings.sortByTruePrice !== false;
    if (enabled || sortEnabled) await loadRate();
  }

  async function loadRate() {
    const game = PH.location.current().version === "2" ? "poe2" : "poe1";
    try {
      const response = await PH.browserAPI.runtime.sendMessage({ type: "GET_CURRENCY_RATE", game });
      if (!response?.ok) {
        LOG("no exchange rate:", response?.error);
        return;
      }
      rate = response.data;
      LOG(`1 divine = ${rate.divineInChaos.toFixed(1)} chaos (${rate.league}, poe.ninja)`);
    } catch (err) {
      LOG("rate request failed:", err);
    }
  }

  function setEnabled(next) {
    enabled = next;
    if (enabled && !rate) loadRate();
    if (!enabled) {
      for (const note of document.querySelectorAll(".ph-converted")) note.remove();
    }
  }

  /* Toggling this off only stops *future* re-sorts — rows already moved by
     an earlier sortResultsByPrice() call stay where they were put (same as
     setEnabled leaves already-computed history alone); reloading the page
     is what gets GGG's own order back, same as it would for any other
     setting here. */
  function setSortEnabled(next) {
    sortEnabled = next;
    if (sortEnabled && !rate) loadRate();
  }

  /* The trade site is a pushState SPA — a tab can sit on the same page for
     hours without this content script ever reloading, so the rate fetched
     once at init() would otherwise just go stale forever. Called from
     main.js's existing poll loop (cheap: just a timestamp check unless
     actually due), on the same cadence the background service worker
     itself uses to decide whether its own cached rate needs refetching. */
  const RATE_REFRESH_MS = 15 * 60 * 1000;
  function refreshRateIfStale() {
    if (!enabled && !sortEnabled) return;
    if (rate && Date.now() - rate.fetchedAt < RATE_REFRESH_MS) return;
    loadRate();
  }

  /* Work out which currency a price is in. The visible text is just a number,
     so the currency comes from the icon's filename. Falls back to reading any
     text label, for layouts where the icon is missing.

     Only ever returns the two exact strings "chaos"/"divine" for those two
     — every other currency (Orb of Fusing, Exalted Orb, ...) comes back as
     its own real display name instead of being forced into one of those
     two or dropped. poe.ninja now feeds this extension a rate for every
     currency it tracks (see chaosValueByName, built in service-worker.js's
     fetchCurrencyRates), keyed by that same real display name, so
     chaosEquivalentOf below resolves almost any currency's real value —
     bookmarks.js/saved.js's own toChaosEquivalent still floors to a flat
     ~1c, but only for the rare case of a currency name that isn't in that
     table at all (poe.ninja doesn't track it), not as a general fallback
     the way it used to be. */
  function readCurrency(priceEl) {
    const img = priceEl.querySelector('.currency-image img, img');
    const src = img?.getAttribute("src") ?? "";

    /* GGG's own asset names. CurrencyRerollRare is the chaos orb;
       CurrencyModValues is the divine orb. */
    if (/CurrencyRerollRare/i.test(src)) return "chaos";
    if (/CurrencyModValues/i.test(src)) return "divine";

    const alt = (img?.getAttribute("alt") ?? "").toLowerCase();
    if (alt.includes("chaos")) return "chaos";
    if (alt.includes("divine")) return "divine";

    /* Excludes our own injected .ph-converted badge before reading any
       more text — annotate() appends it INSIDE this same priceEl, and on
       any re-read after that (every later cheapestOnPage/cheapestRowOnPage
       call, not just annotate()'s own one-time pass over a row) its own
       "≈ ... div"/"≈ < 0.1 div"/"≈ ...c" text would otherwise get picked
       up by the checks below as if it were the row's real currency
       indicator. Caught live: once annotate() had run, every row on the
       page — regardless of what it was actually priced in — read back as
       "divine", because the broad text scan two lines down matched our
       own badge's "div" rather than anything GGG rendered. */
    const withoutOwnBadge = priceEl.cloneNode(true);
    withoutOwnBadge.querySelector(".ph-converted")?.remove();

    const text = withoutOwnBadge.textContent.toLowerCase();
    if (/\bdiv(ine)?\b/.test(text)) return "divine";
    if (/\bchaos\b/.test(text)) return "chaos";

    /* Any other currency — its display name sits in its own <span> right
       after the icon, inside .currency-text (verified 2026-08 against a
       real chaos-priced row's outerHTML: <span class="currency-text
       currency-image"><img ...><span>Chaos Orb</span></span> — the same
       wrapper this reuses for e.g. "Orb of Fusing", not independently
       outerHTML-verified for a non-chaos/divine currency specifically,
       since the structure is identical either way). */
    const name = withoutOwnBadge.querySelector(".currency-text span:last-child")?.textContent.trim();
    return name || null;
  }

  /* The icon's own <img src>, straight from GGG's CDN — reused as-is rather
     than us bundling copies, so Saved listings (which have no live row to
     re-read later) can still show the right currency icon. */
  function readCurrencyIcon(priceEl) {
    const img = priceEl.querySelector('.currency-image img, img');
    return img?.getAttribute("src") ?? null;
  }

  function readAmount(priceEl) {
    /* No selector for the amount specifically — it's a bare <span> with no
       class. The label text ("Asking Price:") never contains digits, so the
       first digit run in the whole element's text is reliably the amount. */
    const raw = priceEl.textContent.replace(/,/g, "");
    const match = raw.match(/[\d.]+/);
    if (!match) return null;
    const value = parseFloat(match[0]);
    return Number.isFinite(value) ? value : null;
  }

  /* { amount, currency, icon } for one row, or null — the one place that
     knows where a row's price element lives, so annotate/cheapestOnPage/the
     saved-listing capture button all read it the same way. `icon` is best-
     effort (the currency image's own src) and can be null even when amount
     and currency aren't. */
  function readRowPrice(row) {
    const priceEl = row.querySelector('[data-field="price"]') ?? row.querySelector(".details .price");
    if (!priceEl) return null;
    const amount = readAmount(priceEl);
    const currency = readCurrency(priceEl);
    const icon = readCurrencyIcon(priceEl);
    return amount != null && currency ? { amount, currency, icon } : null;
  }

  /* For PoE2, Exalted Orb takes the role Chaos Orb plays in PoE1's own
     divine<->"small unit" display pairing — PoE2's actual common bulk
     currency is Exalted, not Chaos (Chaos sits at an odd middle tier
     there, worth dozens of Exalted apiece per poe.ninja's own live rates —
     see fetchCurrencyRates in service-worker.js), so a PoE1-style "Xc"
     reading doesn't map to how PoE2 players actually think about value.
     `version` is the page/folder's own "1"/"2" — not the currency actually
     read off a row, which annotate() below still branches on separately.
     Falls back to plain chaos if PoE2's Exalted Orb rate hasn't loaded yet,
     same "show an approximation rather than nothing" reasoning used
     elsewhere in this file. */
  function smallUnitAmount(chaosEquivalent, version) {
    if (version === "2") {
      const exaltedInChaos = rate?.chaosValueByName?.["Exalted Orb"];
      if (exaltedInChaos) {
        return `${Math.round(chaosEquivalent / exaltedInChaos)} ${PH.ui.abbreviateCurrency("Exalted Orb")}`;
      }
    }
    return `${Math.round(chaosEquivalent)}c`;
  }

  function annotate() {
    if (!enabled || !rate) return;
    const version = PH.location.current().version;
    /* Whichever currency plays the "small unit" role for this game — a row
       already priced in it converts up to divine (or gets skipped as too
       small to bother); a row priced in anything else, including Chaos
       Orb itself on a PoE2 page, goes through the generic branch below and
       gets whichever of divine/small-unit its own value calls for. */
    const smallCurrency = version === "2" ? "Exalted Orb" : "chaos";

    for (const row of PH.ui.tradeRoot().querySelectorAll(`${ROW}:not([${MARK}])`)) {
      row.setAttribute(MARK, "");

      /* Exchange rows price currency-to-currency, not item-to-currency, and
         don't use this same price markup — see cheapestOnPage's own
         :not(.exchange) exclusion for the same reason. */
      if (row.classList.contains("exchange")) continue;

      const priced = readRowPrice(row);
      if (!priced) continue;
      const { amount, currency } = priced;

      const priceEl =
        row.querySelector('[data-field="price"]') ?? row.querySelector(".details .price");

      /* chaos/divine convert directly; anything else (readCurrency can
         return any currency's own name) goes through chaosValueByName —
         still skipped, not guessed, for the rare currency poe.ninja
         doesn't track at all. This badge is a direct "here's the value"
         claim shown right on the trade site next to the real price, so a
         currency with no real rate stays skipped here same as before. */
      let text;
      if (currency === "divine") {
        text = `≈ ${smallUnitAmount(amount * rate.divineInChaos, version)}`;
      } else if (currency === smallCurrency) {
        /* Unlike "chaos" (always resolvable, chaosEquivalentOf's first
           branch just returns amount as-is), "Exalted Orb" needs
           chaosValueByName to have loaded — null here would otherwise
           silently become NaN < 0.1 (false), showing "≈ NaN div". */
        const smallEquivalent = chaosEquivalentOf(amount, currency);
        if (smallEquivalent == null) continue;
        const inDivine = smallEquivalent / rate.divineInChaos;
        /* Below a tenth of a divine, showing a precise number (e.g. "≈ 0.00
           div") reads as more precision than it has — per the developer's
           explicit ask, show the floor itself instead of suppressing the
           badge entirely, so a row still gets *some* conversion shown. */
        text = inDivine < 0.1 ? "≈ < 0.1 div" : `≈ ${inDivine.toFixed(2)} div`;
      } else {
        const chaosEquivalent = chaosEquivalentOf(amount, currency);
        if (chaosEquivalent == null) continue;
        const inDivine = chaosEquivalent / rate.divineInChaos;
        /* Same divine-once-it's-worth-1+ threshold formatNinjaValue in
           bookmarks.js uses, so this badge shows the same unit poe.ninja
           itself would for a value of this size. */
        text = inDivine >= 1 ? `≈ ${inDivine.toFixed(2)} div` : `≈ ${smallUnitAmount(chaosEquivalent, version)}`;
      }

      priceEl.append(
        PH.ui.el("span", { class: "ph-converted", text, title: `poe.ninja · ${rate.league}` })
      );
    }
  }

  const currentRate = () => rate;

  /* chaos itself, divine converted via rate, or — for any other currency
     (readCurrency can return any currency's own display name, not just
     those two) — its own real value from rate.chaosValueByName, built in
     service-worker.js's fetchCurrencyRates from poe.ninja's full currency
     catalog (Orb of Alchemy, Gemcutter's Prism, ...), not just chaos/divine.
     Real PoE2 listings commonly get priced in exactly those two — this used
     to floor straight to null for both, meaning a search where every
     listing happened to use one of them could never produce a "cheapest on
     page" price at all (see cheapestOnPage below, and PH.bookmarks.
     notePriceIfMatch/PH.saved.capturePendingPrice which depend on it).
     Still returns null (never guesses) for the rare currency name that
     genuinely isn't in poe.ninja's own catalog, or when no rate has loaded
     yet at all — unlike the saved-listing math in bookmarks.js/saved.js
     (which floors an unresolvable currency to a flat ~1c for sorting/
     totals on a user's own curated data), this drives *automatic* "what's
     the cheapest thing on this page" picking, where a guessed floor could
     make a cheap-looking listing wrongly win over a genuinely cheaper,
     resolvable one. */
  function chaosEquivalentOf(amount, currency) {
    if (currency === "chaos") return amount;
    if (currency === "divine") return rate ? amount * rate.divineInChaos : null;
    const perUnit = rate?.chaosValueByName?.[currency];
    return perUnit != null ? amount * perUnit : null;
  }

  /* Reads every visible result row's price and returns the cheapest as
     { amount, currency }, or null if there's nothing comparable on the page.
     Skips bulk-exchange rows — those price currency-to-currency, not
     item-to-currency, and don't use this same price markup. */
  function cheapestOnPage() {
    let best = null;
    let bestChaos = Infinity;

    for (const row of PH.ui.tradeRoot().querySelectorAll(`${ROW}:not(.exchange)`)) {
      const priced = readRowPrice(row);
      if (!priced) continue;
      const chaosEquivalent = chaosEquivalentOf(priced.amount, priced.currency);
      if (chaosEquivalent == null) continue;

      if (chaosEquivalent < bestChaos) {
        bestChaos = chaosEquivalent;
        best = { amount: priced.amount, currency: priced.currency };
      }
    }

    return best;
  }

  /* Same comparison as cheapestOnPage, but returns the row element itself
     rather than just its price — for callers that need to read something
     else off that specific row too (PH.saved.capturePendingPrice reads its
     "listed X ago" text). Kept separate rather than having cheapestOnPage
     itself return the row: that object flows straight into browser storage
     (PH.store.pushTradePrice/pushSavedListingPrice), and a DOM element
     isn't serializable — mixing the two would risk a silent storage bug
     the moment someone spread the wrong return value into a saved entry. */
  function cheapestRowOnPage() {
    let bestRow = null;
    let bestChaos = Infinity;

    for (const row of PH.ui.tradeRoot().querySelectorAll(`${ROW}:not(.exchange)`)) {
      const priced = readRowPrice(row);
      if (!priced) continue;
      const chaosEquivalent = chaosEquivalentOf(priced.amount, priced.currency);
      if (chaosEquivalent == null) continue;

      if (chaosEquivalent < bestChaos) {
        bestChaos = chaosEquivalent;
        bestRow = row;
      }
    }

    return bestRow;
  }

  /* Reorders the currently visible results so the true cheapest listing (by
     the same chaos-equivalent math cheapestOnPage uses) ends up on top.
     GGG's own "sort by price" uses GGG's own internal chaos<->divine rate,
     which can disagree with poe.ninja's — a page the site itself considers
     price-sorted can still show a divine-priced listing above a
     chaos-priced one that's genuinely cheaper by poe.ninja's numbers (the
     same numbers this extension's own "≈" badge shows right on that row).
     This makes the visible order agree with that badge instead of just
     noting the disagreement.

     Only rows the site renders as a plain result (div.row[data-id], not
     .exchange — those price currency-to-currency, nothing to compare) are
     eligible to move; everything else under .resultset (exchange rows,
     any other injected element) stays in its exact original slot — this
     permutes values only among the slots eligible rows already occupied,
     never touches slots holding something else. A row with no computable
     chaos-equivalent (an exotic currency, or divine with no rate loaded)
     sorts after every row that has one, same null-sorts-last rule used
     for price sorting everywhere else in this codebase (see
     priceComparator in saved.js). No-ops (skips the DOM writes entirely)
     when the eligible rows are already in the right order, so a page
     that's already correctly sorted — or a repeat call from the next
     mutation *this* reorder itself triggers — doesn't keep rewriting the
     DOM every scan. */
  function sortResultsByPrice() {
    if (!sortEnabled || !rate) return;

    const container = PH.ui.tradeRoot().querySelector(".resultset");
    if (!container) return;

    const children = [...container.children];
    const slots = [];
    const sortable = [];
    children.forEach((child, i) => {
      if (child.matches("div.row[data-id]") && !child.classList.contains("exchange")) {
        slots.push(i);
        sortable.push(child);
      }
    });
    if (sortable.length < 2) return;

    const keyed = sortable.map((row, i) => {
      const priced = readRowPrice(row);
      const key = priced ? chaosEquivalentOf(priced.amount, priced.currency) : null;
      return { row, key, i };
    });

    keyed.sort((a, b) => {
      if (a.key == null && b.key == null) return a.i - b.i;
      if (a.key == null) return 1;
      if (b.key == null) return -1;
      return a.key - b.key || a.i - b.i;
    });

    if (keyed.every((k, idx) => k.row === sortable[idx])) return;

    slots.forEach((slot, idx) => { children[slot] = keyed[idx].row; });
    for (const child of children) container.appendChild(child);
  }

  /* --------------------------------------------------- poe.ninja averages --
     Both games, but only for categories with a fixed catalog name poe.ninja
     tracks (uniques, and PoE1 also gems/corpses) — see PRICE_CATEGORIES in
     service-worker.js for the full list per game and why each one's there.
     Rares aren't included on either game: there's no fixed catalog to look
     up an "average" for. */

  async function loadPriceIndex() {
    const game = PH.location.current().version === "2" ? "poe2" : "poe1";
    /* Cached per game, not just once — a tab can sit on the same trade SPA
       across a version change (folders are rendered per-page-version, so
       whichever folder is currently open always matches `game` here, but
       this still refetches rather than serving the other game's index if
       that ever changes). */
    if (priceIndex && priceIndex.game === game) return priceIndex;
    try {
      const response = await PH.browserAPI.runtime.sendMessage({ type: "GET_ITEM_PRICE_INDEX", game });
      if (!response?.ok) {
        LOG("no item price index:", response?.error);
        return null;
      }
      priceIndex = { ...response.data, game };
      return priceIndex;
    } catch (err) {
      LOG("item price index request failed:", err);
      return null;
    }
  }

  /* Best-effort match: a saved title is usually "<Item Name> <Base Type>"
     (whatever the trade site's item-name search box showed), so we match by
     prefix rather than exact equality, preferring the longest/most specific
     name that matches (so a short name can't false-match a longer one).
     Multiple entries can share a name — see isBetterVariant for how we pick
     one when that happens. */
  function matchItem(title) {
    if (!priceIndex || !title) return null;
    const needle = title.trim().toLowerCase();

    let best = null;
    for (const item of priceIndex.items) {
      const name = item.name.toLowerCase();
      if (!needle.startsWith(name)) continue;
      if (!best || name.length > best.name.length ||
          (name.length === best.name.length && isBetterVariant(item, best))) {
        best = item;
      }
    }
    return best;
  }

  /* Deciding between same-name entries. For gems: level 1 / 0% quality /
     uncorrupted — the state most gems are actually traded in, and our
     default assumption since we don't (yet) capture which level/quality a
     saved search's own filters specified. Ties within that fall back to
     whichever's most commonly listed. Non-gem items (uniques etc.) have no
     level/quality concept — those go straight to most-commonly-listed,
     the closest thing to "the standard version" without knowing which link
     count or mod variant a saved item actually was. */
  function isBetterVariant(candidate, current) {
    if (candidate.gemLevel != null || current.gemLevel != null) {
      const level = (v) => v.gemLevel ?? Infinity;
      if (level(candidate) !== level(current)) return level(candidate) < level(current);

      const quality = (v) => v.gemQuality ?? 0;
      if (quality(candidate) !== quality(current)) return quality(candidate) < quality(current);

      const corrupted = (v) => v.corrupted ?? false;
      if (corrupted(candidate) !== corrupted(current)) return !corrupted(candidate);
    }
    return candidate.listingCount > current.listingCount;
  }

  return {
    init, annotate, setEnabled, setSortEnabled, currentRate, cheapestOnPage, cheapestRowOnPage,
    readRowPrice, sortResultsByPrice, loadPriceIndex, matchItem, refreshRateIfStale,
    /* Exported so bookmarks.js/saved.js's own toChaosEquivalent can share
       this exact lookup (including the now-real per-currency rates) rather
       than keeping a second, drifting copy of the same three-way branch. */
    chaosEquivalentOf,
    /* Exported so bookmarks.js's formatChaosOrDivine/formatChaosDelta (Total
       Cost and price-history diffs) and saved.js's own diff formatter share
       the same PoE2-uses-Exalted-not-Chaos substitution this file's own
       annotate() uses, rather than three drifting copies of it. */
    smallUnitAmount,
  };
})();
