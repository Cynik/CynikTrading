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
     text label, for layouts where the icon is missing. */
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
    return null;
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

  /* { amount, currency } for one row, or null — the one place that knows
     where a row's price element lives, so annotate/cheapestOnPage/the
     saved-listing capture button all read it the same way. */
  function readRowPrice(row) {
    const priceEl = row.querySelector('[data-field="price"]') ?? row.querySelector(".details .price");
    if (!priceEl) return null;
    const amount = readAmount(priceEl);
    const currency = readCurrency(priceEl);
    return amount != null && currency ? { amount, currency } : null;
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

      let text;
      if (currency === "divine") {
        text = `≈ ${Math.round(amount * rate.divineInChaos)}c`;
      } else {
        const inDivine = amount / rate.divineInChaos;
        /* Below a tenth of a divine the conversion is noise, not information. */
        if (inDivine < 0.1) continue;
        text = `≈ ${inDivine.toFixed(2)} div`;
      }

      priceEl.append(
        PH.ui.el("span", { class: "ph-converted", text, title: `poe.ninja · ${rate.league}` })
      );
    }
  }

  const currentRate = () => rate;

  /* Reads every visible result row's price and returns the cheapest as
     { amount, currency }, or null if there's nothing comparable on the page.
     Skips bulk-exchange rows — those price currency-to-currency, not
     item-to-currency, and don't use this same price markup. A divine price
     only counts if `rate` is loaded, since comparing it to a chaos price
     needs the exchange rate; we don't guess one. */
  function cheapestOnPage() {
    let best = null;
    let bestChaos = Infinity;

    for (const row of document.querySelectorAll(`${ROW}:not(.exchange)`)) {
      const priced = readRowPrice(row);
      if (!priced) continue;
      const { amount, currency } = priced;

      let chaosEquivalent;
      if (currency === "chaos") chaosEquivalent = amount;
      else if (rate) chaosEquivalent = amount * rate.divineInChaos;
      else continue;

      if (chaosEquivalent < bestChaos) {
        bestChaos = chaosEquivalent;
        best = { amount, currency };
      }
    }

    return best;
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
    init, annotate, setEnabled, currentRate, cheapestOnPage, readRowPrice,
    loadPriceIndex, matchItem,
  };
})();
