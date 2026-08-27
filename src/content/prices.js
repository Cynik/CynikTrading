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
  const ROW = ".resultset > div.row[data-id]";
  const MARK = "ph-priced";

  let rate = null;         // { divineInChaos, league, fetchedAt }
  let priceIndex = null;  // { items: [{name, baseType, chaosValue, divineValue, listingCount, gemLevel?, gemQuality?, corrupted?}], league }
  let enabled = true;

  async function init() {
    const settings = await PH.store.getSettings();
    enabled = settings.showPriceConversion !== false;
    if (enabled) await loadRate();
  }

  async function loadRate() {
    const game = PH.location.current().version === "2" ? "poe2" : "poe1";
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_CURRENCY_RATE", game });
      if (!response?.ok) {
        console.log("[PoE Helper] no exchange rate:", response?.error);
        return;
      }
      rate = response.data;
      console.log(
        `[PoE Helper] 1 divine = ${rate.divineInChaos.toFixed(1)} chaos (${rate.league}, poe.ninja)`
      );
    } catch (err) {
      console.log("[PoE Helper] rate request failed:", err);
    }
  }

  function setEnabled(next) {
    enabled = next;
    if (enabled && !rate) loadRate();
    if (!enabled) {
      for (const note of document.querySelectorAll(".ph-converted")) note.remove();
    }
  }

  /* Work out which currency a price is in. The visible text is just a number,
     so the currency comes from the icon's filename. Falls back to reading any
     text label, for layouts where the icon is missing.

     Only ever returns the two exact strings "chaos"/"divine" for those two
     — every other currency (Orb of Fusing, Exalted Orb, ...) comes back as
     its own real display name instead of being forced into one of those
     two or dropped. There's no fixed rate for these (poe.ninja only feeds
     this extension a chaos<->divine rate), so callers that need a
     chaos-equivalent number (sorting, totals, price diffs) treat anything
     that isn't "chaos"/"divine" as a flat ~1c floor rather than a real
     conversion — a deliberate approximation, not a guess: see the note
     above toChaosEquivalent in bookmarks.js/saved.js. */
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

    const text = priceEl.textContent.toLowerCase();
    if (/\bdiv(ine)?\b/.test(text)) return "divine";
    if (/\bchaos\b/.test(text)) return "chaos";

    /* Any other currency — its display name sits in its own <span> right
       after the icon, inside .currency-text (verified 2026-08 against a
       real chaos-priced row's outerHTML: <span class="currency-text
       currency-image"><img ...><span>Chaos Orb</span></span> — the same
       wrapper this reuses for e.g. "Orb of Fusing", not independently
       outerHTML-verified for a non-chaos/divine currency specifically,
       since the structure is identical either way). */
    const name = priceEl.querySelector(".currency-text span:last-child")?.textContent.trim();
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

  function annotate() {
    if (!enabled || !rate) return;

    for (const row of document.querySelectorAll(`${ROW}:not([${MARK}])`)) {
      row.setAttribute(MARK, "");

      const priced = readRowPrice(row);
      if (!priced) continue;
      const { amount, currency } = priced;

      const priceEl =
        row.querySelector('[data-field="price"]') ?? row.querySelector(".details .price");

      /* Only chaos and divine have a real rate to convert with — anything
         else (readCurrency can now return any currency's own name, not
         just those two) has no conversion to show here, so it's skipped
         rather than guessed at. That's different from the flat ~1c floor
         toChaosEquivalent uses elsewhere for exotic currencies: this badge
         is a direct "here's the value" claim shown right on the trade
         site next to the real price, not an internal sort/total number —
         showing a floor here as if it were computed would be misleading
         in a way it isn't when it's just breaking a sort tie. */
      let text;
      if (currency === "divine") {
        text = `≈ ${Math.round(amount * rate.divineInChaos)}c`;
      } else if (currency === "chaos") {
        const inDivine = amount / rate.divineInChaos;
        /* Below a tenth of a divine the conversion is noise, not information. */
        if (inDivine < 0.1) continue;
        text = `≈ ${inDivine.toFixed(2)} div`;
      } else {
        continue;
      }

      priceEl.append(
        PH.ui.el("span", { class: "ph-converted", text, title: `poe.ninja · ${rate.league}` })
      );
    }
  }

  const currentRate = () => rate;

  /* chaos itself, divine converted via rate (null with no rate loaded), or
     null for anything else — readCurrency can now return any currency's
     own name, not just those two, but there's no rate to convert an
     exotic one with, and unlike the saved-listing math in bookmarks.js/
     saved.js (which treats one as a deliberate flat ~1c floor for
     sorting/totals a user is actively curating), this drives *automatic*
     "what's the cheapest thing on this page" picking — flooring it here
     risks a cheap-looking exotic-currency listing always winning that
     comparison over a genuinely cheaper chaos-priced one, which could
     actively mislead price tracking rather than just show an approximate
     number. */
  function chaosEquivalentOf(amount, currency) {
    if (currency === "chaos") return amount;
    if (currency === "divine") return rate ? amount * rate.divineInChaos : null;
    return null;
  }

  /* Reads every visible result row's price and returns the cheapest as
     { amount, currency }, or null if there's nothing comparable on the page.
     Skips bulk-exchange rows — those price currency-to-currency, not
     item-to-currency, and don't use this same price markup. */
  function cheapestOnPage() {
    let best = null;
    let bestChaos = Infinity;

    for (const row of document.querySelectorAll(`${ROW}:not(.exchange)`)) {
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
     itself return the row: that object flows straight into chrome.storage
     (PH.store.pushTradePrice/pushSavedListingPrice), and a DOM element
     isn't serializable — mixing the two would risk a silent storage bug
     the moment someone spread the wrong return value into a saved entry. */
  function cheapestRowOnPage() {
    let bestRow = null;
    let bestChaos = Infinity;

    for (const row of document.querySelectorAll(`${ROW}:not(.exchange)`)) {
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

  /* --------------------------------------------------- poe.ninja averages --
     PoE1 only, and only for categories with a fixed catalog name poe.ninja
     tracks (uniques, gems, corpses, ...) — see PRICE_CATEGORIES in
     service-worker.js for the full list and why each one's there. PoE2
     uniques aren't supported yet, and rares aren't a fixed catalog you can
     look up an "average" for. */

  async function loadPriceIndex() {
    if (priceIndex) return priceIndex;
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_ITEM_PRICE_INDEX" });
      if (!response?.ok) {
        console.log("[PoE Helper] no item price index:", response?.error);
        return null;
      }
      priceIndex = response.data;
      return priceIndex;
    } catch (err) {
      console.log("[PoE Helper] item price index request failed:", err);
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
    init, annotate, setEnabled, currentRate, cheapestOnPage, cheapestRowOnPage, readRowPrice,
    loadPriceIndex, matchItem,
  };
})();
