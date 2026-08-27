/* =========================================================================
   saved.js — the Saved tab, and the capture button on result rows.
   =========================================================================
   Replaced History in v0.3. A saved listing is a manually-captured snapshot
   of one specific trade offer — item, price, seller, the mods that were
   rolled on it — not live data. The listing may already be sold by the time
   you look at it again, so it keeps the league it was found in, the same way
   a history entry used to: it's a record of a past moment, not a reusable
   search like a bookmark.

   Capture selectors, verified 2026-08 against a real result row's outerHTML
   (a unique item; a rare/magic/normal row may not match every part of this,
   which is why every read below tolerates coming back empty):

     .item-popup__header-line              one <div> per line of the item's
                                            name (unique flavour name + base
                                            type are two separate lines;
                                            joined with a space)
     .item-mod [data-field^="stat."]       one element per rolled mod (both
                                            .item-mod--implicit and
                                            .item-mod--explicit), its
                                            .textContent is the mod's own
                                            rendered text with the rolled
                                            value already substituted in
     [data-field="indexed"] .profile-link a   the seller's account name
     .details .btns                        the button cluster we add our
                                            save button to (same spot the
                                            old pinned.js used for 📌)

   Price reuses PH.prices.readRowPrice — see the note at the top of
   prices.js for that selector.

   Still missing: "rebuild a search from this item's own stats" — that needs
   different, still-unverified selectors (the advanced search form's SET
   behavior, not just reading a result row), so it isn't built yet.
   ========================================================================= */

window.PH = window.PH || {};

PH.saved = (() => {
  const { el, button, empty, timeAgo, toast, formatPrice } = PH.ui;

  const ROW = ".resultset > div.row[data-id]";
  const MARK = "ph-savable";

  /* ---------------------------------------------------- the save button ---- */

  function enhanceRows() {
    const rows = document.querySelectorAll(`${ROW}:not([${MARK}])`);
    for (const row of rows) {
      row.setAttribute(MARK, "");

      /* Bulk-exchange rows price currency-to-currency and don't have an
         item, seller, or mods in this shape — nothing sensible to save. */
      if (row.classList.contains("exchange")) continue;

      const buttons = row.querySelector(".details .btns");
      if (!buttons) continue;

      buttons.append(el("button", {
        type: "button",
        class: "ph-save-btn",
        title: "Save this listing",
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          captureListing(row);
        },
      }, "🏷"));
    }
  }

  async function captureListing(row) {
    const page = PH.location.current();
    const priced = PH.prices.readRowPrice(row);

    const listing = {
      location: { version: page.version, type: page.type, slug: page.slug },
      league: page.league,
      title: itemTitle(row),
      price: priced ? formatPrice(priced) : null,
      seller: sellerName(row),
      mods: modLines(row),
    };

    await PH.store.saveSavedListing(listing);
    toast(`Saved “${listing.title ?? "listing"}”`);
    PH.panel.refresh();
  }

  /* The unique flavour name and base type render as separate lines; for a
     rare/magic/normal item there may be just one, or none at all if the
     header markup differs — either way we join whatever's there. */
  function itemTitle(row) {
    const lines = [...row.querySelectorAll(".item-popup__header-line")]
      .map((line) => line.textContent.trim())
      .filter(Boolean);
    return lines.join(" ") || null;
  }

  function sellerName(row) {
    const link = row.querySelector('[data-field="indexed"] .profile-link a');
    return link?.textContent.trim() || null;
  }

  /* Implicit and explicit mods both use this shape; the rolled value is
     already substituted into the text (e.g. "+89 to all Attributes"). */
  function modLines(row) {
    return [...row.querySelectorAll(".item-mod")]
      .map((mod) => mod.querySelector('[data-field^="stat."]')?.textContent.trim())
      .filter(Boolean);
  }

  /* -------------------------------------------------------------- render ---- */

  async function render(container) {
    const [listings, lastSeenLeagues] = await Promise.all([
      PH.store.getSavedListings(),
      PH.store.getLastSeenLeagues(),
    ]);
    const pageLocation = PH.location.current();
    const context = { pageLocation, lastSeenLeagues };

    const forThisGame = listings.filter((l) => (l.location?.version ?? "1") === pageLocation.version);

    if (forThisGame.length === 0) {
      container.append(empty("No saved listings yet. Use the save button on a trade result to snapshot it here."));
      return;
    }

    const list = el("div", { class: "ph-saved-list" });
    for (const listing of forThisGame) list.append(listingRow(listing, context));
    container.append(list);
  }

  function listingRow(listing, context) {
    const league = listing.league ?? PH.location.resolveLeague(listing.location ?? {}, context);
    const url = listing.location ? PH.location.buildUrl(listing.location, league) : null;

    const row = el("div", { class: "ph-saved-row" });

    row.append(el("div", { class: "ph-saved-head" },
      el("span", { class: "ph-saved-title", text: listing.title || "Untitled item" }),
      listing.price ? el("span", { class: "ph-saved-price", text: listing.price }) : null
    ));

    const metaBits = [listing.seller, league, timeAgo(listing.savedAt)].filter(Boolean);
    row.append(el("div", { class: "ph-saved-meta", text: metaBits.join(" · ") }));

    if (listing.mods?.length) {
      row.append(el("ul", { class: "ph-saved-mods" },
        listing.mods.map((mod) => el("li", { text: mod }))
      ));
    }

    row.append(el("div", { class: "ph-toolbar" },
      url ? el("a", { class: "ph-btn", href: url, target: "_blank", rel: "noopener", text: "Open the search this came from" }) : null,
      button("Remove", {
        class: "ph-btn ph-btn-danger",
        onClick: async () => { await PH.store.deleteSavedListing(listing.id); PH.panel.refresh(); },
      })
    ));

    return row;
  }

  return { render, enhanceRows };
})();
