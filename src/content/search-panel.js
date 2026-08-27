/* =========================================================================
   search-panel.js — reads GGG's own search form to suggest a bookmark name.
   =========================================================================
   These selectors come from Better Trading's source, so they're known-good
   rather than guessed — but they're also the most fragile thing in this
   extension, because they depend on GGG's markup. If titles stop
   auto-filling, this file is the only place to look.
   ========================================================================= */

window.PH = window.PH || {};

PH.searchPanel = (() => {
  const SEARCH_INPUT = ".search-panel .search-bar .search-left input";
  const CATEGORY_INPUT =
    ".search-advanced-items .filter-group:nth-of-type(1) .filter-property:nth-of-type(1) input";
  const RARITY_INPUT =
    ".search-advanced-items .filter-group:nth-of-type(1) .filter-property:nth-of-type(2) input";
  const STATS =
    ".search-advanced-pane:last-child .filter-group-body .filter:not(.disabled) .filter-title";
  /* Same selector saved.js uses to read an item's name off a result row —
     see the note at the top of that file for how it was verified. */
  const RESULT_ROW = ".resultset > div.row[data-id]";
  const ITEM_NAME_LINE = ".item-popup__header-line";

  const readValue = (selector) => {
    const node = document.querySelector(selector);
    const value = node?.value?.trim();
    /* "Any" is GGG's own placeholder for "nothing picked" here, not a real
       selection — reading it as one is how "Any (Any)" bookmark titles
       happened. */
    return value && value !== "Any" ? value : null;
  };

  /* The name (+ base type) of the first visible result — useful when the
     search has no typed item name and no category/rarity picked (a pure
     stat-filter search, e.g. "jewels with this notable"), where every
     result is the same fixed-name item and that name is a far better
     bookmark title than a raw stat line. */
  function firstResultName() {
    const row = document.querySelector(RESULT_ROW);
    if (!row) return null;
    const lines = [...row.querySelectorAll(ITEM_NAME_LINE)]
      .map((line) => line.textContent.trim())
      .filter(Boolean);
    return lines.join(" ") || null;
  }

  /* Best available name, in descending order of usefulness:
       the item name you typed  >  "Body Armour (Rare)"  >  the first
       result's own name  >  the first mod  >  a plain fallback */
  function recommendTitle() {
    const name = readValue(SEARCH_INPUT);
    if (name) return name;

    const category = readValue(CATEGORY_INPUT);
    const rarity = readValue(RARITY_INPUT);
    if (category) return rarity ? `${category} (${rarity})` : category;

    const resultName = firstResultName();
    if (resultName) return resultName;

    const firstStat = document.querySelector(STATS)?.textContent?.trim();
    if (firstStat) return firstStat;

    const location = PH.location.current();
    return location.type === "exchange" ? "Bulk exchange" : "Search";
  }

  return { recommendTitle };
})();
