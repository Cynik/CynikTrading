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
     [data-field="indexed"] small          "listed 5 minutes ago" — relative
                                            text only, verified 2026-08; GGG
                                            never puts a real timestamp
                                            anywhere on the row, so
                                            parseListedAgo below can only be
                                            as precise as this text's own
                                            unit (to the minute/hour/day,
                                            never the second)
     .details .btns                        the button cluster we add our
                                            save button to (same spot the
                                            old pinned.js used for 📌)
     .icon img                             the item's own artwork — verified
                                            2026-08 against a real row's
                                            outerHTML (a Starforge, shown
                                            with its shaper-item background
                                            frame). Just the plain art via
                                            .src; the frame/glow background
                                            some rows also carry (shaper,
                                            elder, synthesised, ...) is a
                                            separate inline style on the same
                                            <img> that isn't captured — a
                                            nice-to-have, not what was asked
                                            for.
     div.row[data-id]                      the row's own data-id is GGG's
                                            own id for this specific listing
                                            (a long stable hash, not a
                                            client-side index — verified
                                            2026-08 against a real search's
                                            outerHTML, several rows in the
                                            same result set each with their
                                            own distinct value). Captured as
                                            sourceId so a re-run of the same
                                            search can tell "already saved"
                                            apart from "not yet" — see
                                            syncSaveButtons.
     .item-popup__content span             an unidentified item hides its
                                            explicit/rolled affixes (its
                                            implicit(s), if any, still show)
                                            — one of these spans' trimmed
                                            .textContent is exactly
                                            "Unidentified" where the hidden
                                            affixes would otherwise be
                                            (verified 2026-08 against a real
                                            unidentified unique's outerHTML).
                                            Matched by exact text, not the
                                            ".lc" class or inline color it
                                            happens to carry here, since
                                            .lc is used all over this popup
                                            for unrelated text — see
                                            isUnidentified below.
     .item-popup (class list)              item-popup--<rarity> — "unique"
                                            and "currency" verified 2026-08
                                            against real rows, "magic" the
                                            same way against a real magic
                                            item; "rare"/"normal" inferred
                                            from that pattern, not
                                            independently seen — see
                                            itemRarity below.
     .item-popup__content *                unmatched by any of the above —
                                            a corrupted item shows a plain
                                            "Corrupted" line where the
                                            "Unidentified" line would
                                            otherwise be, but which tag
                                            carries it hasn't been confirmed
                                            against a real corrupted row yet
                                            (only seen in a user screenshot
                                            of the live trade site itself,
                                            not this extension's own DOM
                                            read). isCorrupted below matches
                                            by exact trimmed text over every
                                            descendant rather than guessing
                                            a tag, so it still works whatever
                                            the real element turns out to
                                            be — but this one still needs a
                                            real outerHTML paste to move from
                                            "should work" to "verified."

   Price reuses PH.prices.readRowPrice — see the note at the top of
   prices.js for that selector.

   "Search this exact item" calls GGG's own trade-search API directly and
   opens the real results —
   not a prefilled query you still have to finish yourself. See the long
   comment above searchTrade for what that means, why it's allowed here
   specifically (a deliberate exception, not a default), and the care it's
   built with. That needs a stat's own internal id, not just its rendered
   text, so modLines below also reads:

     .item-mod [data-field^="stat."]  (attribute, not just its text this
                                       time) — e.g. "stat.explicit.stat_
                                       1509134228"; GGG's search API wants
                                       that same string minus the leading
                                       "stat." (verified 2026-08 against
                                       PoE-Overlay-Community-Fork's own
                                       doc/poe/api_trade_search_request.json
                                       fixture, which pairs an identical-
                                       shaped id with a real search request)
   PoE1 only for now — PoE2's trade API isn't verified to have the same
   request shape, so it's gated off rather than guessed at.
   ========================================================================= */

window.PH = window.PH || {};

PH.saved = (() => {
  const { el, button, empty, timeAgo, toast, formatPrice, confirmRow, menu, inlineForm } = PH.ui;

  const ROW = ".resultset > div.row[data-id]";
  const MARK = "ph-savable";

  /* Which groups are collapsed — UI state, so it lives in localStorage,
     same pattern (and same "store the exception, default the rest open"
     shape) as Bookmarks' own folder-expanded set. Keyed by entry.id,
     which works for both a real manual group's id and an automatic
     group's deterministic `auto:<key>` id (see buildGroups) — an
     automatic group can lose and re-gain its 2nd member across renders
     as you filter/search, so remembering it by that same stable key
     means a collapse choice survives that instead of forgetting itself
     the moment the group's own identity ever changes. */
  const GROUP_COLLAPSE_KEY = "ph-collapsed-saved-groups";
  const collapsedGroups = () => new Set((localStorage.getItem(GROUP_COLLAPSE_KEY) || "").split(",").filter(Boolean));
  function setGroupCollapsed(id, collapsed) {
    const set = collapsedGroups();
    collapsed ? set.add(id) : set.delete(id);
    localStorage.setItem(GROUP_COLLAPSE_KEY, [...set].join(","));
  }

  /* {amount, currency} -> a chaos-equivalent number. Delegates to
     PH.prices.chaosEquivalentOf, which resolves almost any currency's real
     value via poe.ninja's own catalog (fetchCurrencyRates in
     service-worker.js), not just chaos/divine — a listing can genuinely be
     saved priced in Orb of Alchemy, Gemcutter's Prism, etc. (captureListing
     reads whatever the row actually says), and now gets a real conversion
     instead of a flat guess for those.

     A null from chaosEquivalentOf is ambiguous — "no rate loaded at all
     yet" (temporary, resolves itself once the fetch lands) vs "the rate IS
     loaded but this currency genuinely isn't in poe.ninja's catalog"
     (permanent). Only the permanent case floors to a flat ~1
     chaos-equivalent (a deliberate, explicit approximation for sorting/
     diff/group-price math on your own saved listings, not a real
     conversion); the temporary case propagates null instead, matching
     bookmarks.js's own toChaosEquivalent — collapsing the two into one
     flat floor caused a real Total Cost oscillation bug there (see its own
     comment for the full account), and this shares the same
     PH.prices.chaosEquivalentOf dependency even though Saved listings have
     no summed total of their own to oscillate. */
  function toChaosEquivalent(entry) {
    const real = PH.prices.chaosEquivalentOf(entry.amount, entry.currency);
    if (real != null) return real;
    return PH.prices.currentRate() ? 1 : null;
  }

  function chaosDelta(before, after) {
    const b = toChaosEquivalent(before);
    const a = toChaosEquivalent(after);
    return b != null && a != null ? a - b : null;
  }

  /* The chaos-equivalent of a listing's own latest price, for sorting —
     null for a listing with no priceHistory (pre-history listings that
     only ever got a plain price string) or a divine price with no rate
     loaded yet; entryChaosPrice/sortEntries below always put those last
     regardless of direction, never guessing where they'd land. */
  function listingChaosPrice(listing) {
    const latest = (listing.priceHistory ?? []).at(-1);
    return latest ? toChaosEquivalent(latest) : null;
  }

  /* Matches typed text against everything visible on a listing's own
     card — title, seller, the "Unidentified" badge, and each mod's
     rendered text — not just the title, so e.g. typing a stat ("30%") or
     a seller name filters correctly too.

     Fuzzy the same way the trade site's own auto-~ stat search is (see
     main.js's tilde-prefix feature): each word in the typed text
     just has to appear *somewhere* in the combined text, in any order —
     not as one contiguous phrase. "max life" matches "+90 to maximum
     Life" (both words present — "max" inside "maximum", "life" on its
     own — even though "max life" itself isn't a substring anywhere), the
     same way typing "~max life" into a trade-site stat filter would.
     Unlike the trade site's own version this never needs a leading ~ —
     the filter box has nothing else it could mean by a plain word. */
  function matchesFilter(listing, needle) {
    if (!needle) return true;
    const mods = (listing.mods ?? []).map((mod) => (typeof mod === "string" ? mod : mod.text));
    const haystack = [
      listing.title,
      listing.seller,
      listing.unidentified ? "Unidentified" : "",
      listing.corrupted ? "Corrupted" : "",
      ...mods,
    ].filter(Boolean).join(" \n ");
    return matchesWords(haystack, needle);
  }

  /* The word-matching core of matchesFilter, pulled out so entryMatchesFilter
     below can run the exact same fuzzy rule against a group's own title,
     not just a listing's fields. */
  function matchesWords(haystack, needle) {
    const words = needle.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (haystack ?? "").toLowerCase();
    return words.every((word) => hay.includes(word));
  }

  /* Whether a render-ready entry (see buildGroups) should show at all
     under the current filter text — a group counts as matching if its
     own name does, or if any one of its members would on their own
     (the whole group stays together either way; searching doesn't
     partially reveal a group down to just the matching listing). */
  function entryMatchesFilter(entry, needle) {
    if (!needle) return true;
    if (entry.kind === "group" && matchesWords(entry.title, needle)) return true;
    const listings = entry.kind === "group" ? entry.members : [entry.listing];
    return listings.some((l) => matchesFilter(l, needle));
  }

  /* ------------------------------------------------------------- grouping ---- */
  /*
     Listings that are "the same kind of thing" collapse into one group in
     the list — automatically for a shared title (currency, gems, corpses,
     ... anything with a real, stable, non-randomized name), by icon for
     uniques (see autoGroupKey — a unique's own artwork is fixed regardless
     of which specific roll or identified state it's in, the closest thing
     to "the API exposing which unique this is" actually available), and by
     rarity + item category (e.g. "Rare Boots", "Magic Amulet") for
     magic/rare/normal gear — any two rares of the same slot are considered
     comparable, not just two rolls of the exact same base. This was an
     explicit correction: an earlier design tried to match magic/rare
     listings by exact base type (icon URL, with a text-clustering
     fallback for when icon-matching missed same-base pairs for reasons
     never pinned down) — real testing showed that was both unreliable and
     narrower than actually wanted; "all Rare Boots together" was the real
     expectation, not "only boots that share one exact base." Manual
     grouping (dragging one listing onto another — see
     wireGroupDrag/groupListings) always takes priority over whatever an
     item would've auto-grouped into. A group of one item never renders as
     a group — see buildGroups — so auto-grouping is invisible until a
     second matching item shows up, and dragging two items together is
     what makes a manual group exist at all.

     A group's own label is always a pure function of whichever key put
     its members together — "Rare Boots" for the rarity+category key, an
     identified member's own title for a unique's icon key, the shared
     title for a title key — never recomputed from *which* members happen
     to be in the group beyond that. This is deliberate, per an explicit
     ask: a group's name is only ever decided once, when it's created (see
     autoGroupLabel/nameForNewGroup), and never re-managed after that even
     if a later member doesn't itself match the label — true by
     construction for auto-groups (every member already shares the exact
     key that produced the label), and for a manual group because nothing
     here ever touches its title after creation except an explicit
     "Rename group". */

  /* The item's own defining category word — "Boots", "Amulet", "Sword",
     ... — taken as the last word of type (or title, for a listing saved
     before type existed separately). PoE's own item-naming convention
     appends every affix word *before* the base type's own name, never
     inside or after it, so this stays reliable even for a magic/rare
     item's single header line mixing rolled affix words in ahead of the
     real base ("Weaponmaster's Infernal Sword" ends in "Sword" same as a
     plain "Infernal Sword" would) — confirmed against the exact case that
     prompted this whole redesign, three differently-named rare boots
     ("Cataclysm Road Wyvernscale Boots", "Glyph Span Dragonscale Boots",
     "Havoc March Murder Boots") that all correctly reduce to "Boots".
     Most equipment slots follow this pattern (Boots/Gloves/Helmet/Amulet/
     Ring/Belt/Quiver/Shield/Sword/Axe/Bow/...); body armour bases are a
     known exception (e.g. "Vaal Regalia" doesn't end in a category word
     at all) — those just group by whatever their own last word actually
     is, which still reliably reunites multiple listings of that *exact*
     base with each other, just under a more specific-looking label than
     "Body Armour" would be, rather than failing to group at all. null if
     there's no type/title text to work with. */
  function itemCategory(listing) {
    const text = listing.type || listing.title || "";
    const words = text.trim().split(/\s+/).filter(Boolean);
    return words.length ? words[words.length - 1] : null;
  }

  const rarityLabel = (rarity) => (rarity ? rarity[0].toUpperCase() + rarity.slice(1) : "");

  /* The grouping key for automatic (non-dragged) grouping — see the
     section note above for the reasoning behind each branch. null (never
     auto-grouped) if the listing has nothing usable to key by, realistic
     for a listing saved before rarity/type/title existed. */
  function autoGroupKey(listing) {
    if (listing.rarity === "unique") {
      return listing.icon ? `icon:${listing.icon}` : null;
    }
    if (listing.rarity === "magic" || listing.rarity === "rare" || listing.rarity === "normal") {
      const category = itemCategory(listing);
      return category ? `cat:${listing.rarity}:${category.toLowerCase()}` : null;
    }
    return listing.title ? `title:${listing.title}` : null;
  }

  /* The header text for a group of listings — see the section note above
     for why this never looks past members[0] (every member already
     shares whatever key grouped them together, so there's nothing more
     specific to learn from the rest). A unique group prefers an
     identified member's real title over its own base-type-only one, if
     any member happens to be identified — "Starforge Infernal Sword" is
     the one, fixed, correct name every member (identified or not)
     actually is; falls back to whatever title is there (possibly just
     the unidentified base type) if none are. */
  function autoGroupLabel(members) {
    const first = members[0];
    if (!first) return "Group";

    if (first.rarity === "unique") {
      const identified = members.find((m) => !m.unidentified && m.title);
      return identified?.title ?? first.title ?? "Group";
    }
    if (first.rarity === "magic" || first.rarity === "rare" || first.rarity === "normal") {
      const category = itemCategory(first);
      return category ? `${rarityLabel(first.rarity)} ${category}` : (first.title ?? "Group");
    }
    return first.title ?? "Group";
  }

  /* Rarity rank for coloring a group's own header bar — see groupRow. Not
     a value/quality judgment about the items themselves, just the fixed
     order the game's own UI conventions already use (normal < magic <
     rare < unique); currency/gem sit outside that equipment hierarchy
     entirely, so they're ranked here only relative to each other, below
     magic. Unranked/unknown rarities (undefined, or a listing saved
     before rarity was captured) count as lower than everything. */
  const RARITY_RANK = { normal: 0, currency: 0, gem: 0, magic: 1, rare: 2, unique: 3 };
  function highestRarity(members) {
    let best = null;
    let bestRank = -1;
    for (const m of members) {
      const rank = RARITY_RANK[m.rarity] ?? -1;
      if (rank > bestRank) { bestRank = rank; best = m.rarity; }
    }
    return best;
  }

  /* Partitions a list of listings into render-ready entries — either
     { kind: "single", listing } or { kind: "group", manual, id, title,
     members }. Manual groups (a real savedGroups entry) always win over
     automatic ones; whatever's left ungrouped after that gets automatic
     grouping by autoGroupKey. A group with only one member — manual
     groups can end up here transiently between a member being removed
     and the empty-group cleanup, automatic ones just never reach 2 —
     still renders as a plain single, not a group of one. sortIndex is
     each entry's position in `listings` (via its first member), used to
     keep a stable order when no price sort is active. */
  function buildGroups(listings, groups) {
    const manualById = new Map();
    const ungrouped = [];

    for (const l of listings) {
      if (l.groupId) {
        if (!manualById.has(l.groupId)) manualById.set(l.groupId, []);
        manualById.get(l.groupId).push(l);
      } else {
        ungrouped.push(l);
      }
    }

    const autoByKey = new Map();
    for (const l of ungrouped) {
      const key = autoGroupKey(l);
      if (!key) continue;
      if (!autoByKey.has(key)) autoByKey.set(key, []);
      autoByKey.get(key).push(l);
    }

    const entries = [];
    const grouped = new Set();

    for (const [groupId, members] of manualById) {
      if (members.length < 2) continue;
      const meta = groups.find((g) => g.id === groupId);
      entries.push({
        kind: "group", manual: true, id: groupId,
        title: meta?.title ?? autoGroupLabel(members),
        members, sortIndex: listings.indexOf(members[0]),
      });
      members.forEach((m) => grouped.add(m.id));
    }

    for (const [key, members] of autoByKey) {
      if (members.length < 2) continue;
      entries.push({
        kind: "group", manual: false, id: `auto:${key}`,
        title: autoGroupLabel(members),
        members, sortIndex: listings.indexOf(members[0]),
      });
      members.forEach((m) => grouped.add(m.id));
    }

    for (const l of listings) {
      if (!grouped.has(l.id)) entries.push({ kind: "single", listing: l, sortIndex: listings.indexOf(l) });
    }

    return entries;
  }

  /* The cheapest chaos-equivalent price among an entry's listings (its
     own price for a single) — what price-sorting orders entries by, so a
     group sorts to wherever its best listing would've sorted on its own.
     null (sorts last, either direction) if nothing in the entry has a
     comparable price. */
  function entryChaosPrice(entry) {
    const members = entry.kind === "group" ? entry.members : [entry.listing];
    const prices = members.map(listingChaosPrice).filter((p) => p != null);
    return prices.length ? Math.min(...prices) : null;
  }

  /* Shared by sortEntries (comparing whole entries by entryChaosPrice) and
     the member-sort below (comparing individual listings by
     listingChaosPrice) — same null-sorts-last rule either way. */
  function priceComparator(dir, priceOf) {
    return (a, b) => {
      const pa = priceOf(a);
      const pb = priceOf(b);
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return dir === "asc" ? pa - pb : pb - pa;
    };
  }

  /* Ascending/descending by entryChaosPrice (which group sorts to wherever
     its own best listing would've), or each entry's own position in the
     original (already filtered) list when dir is null — this only
     reorders which group/single appears where in the top-level list, not
     what's inside a group; see groupSortDirs below for that. Always a
     copy, never mutating `entries`. */
  function sortEntries(entries, dir) {
    if (!dir) return [...entries].sort((a, b) => a.sortIndex - b.sortIndex);
    return [...entries].sort(priceComparator(dir, entryChaosPrice));
  }

  /* Each group's own price-sort state, independent of the list's own
     sortDir above and of every other group's — its own button in the
     group header (see groupRow) cycles null -> asc -> desc -> null, the
     same 3-state shape as the list-level one. Not persisted; like
     filterText/sortDir, resets on a fresh boot. */
  const groupSortDirs = new Map(); // entry.id -> "asc" | "desc" | null
  const groupSortDir = (id) => groupSortDirs.get(id) ?? null;
  function setGroupSortDir(id, dir) {
    dir ? groupSortDirs.set(id, dir) : groupSortDirs.delete(id);
  }

  /* A listing id to scroll to and briefly highlight the next time render()
     draws it — set right before "Search this exact item" flags a listing
     as noResultsFound (see rebuildSearch), so the "it's gone, remove it?"
     prompt doesn't get lost somewhere down a long list you'd otherwise
     have to go hunting for. Consumed once (cleared right after use) so it
     doesn't re-trigger on every later render. Scoped to whichever tab
     actually clicked the button — the flag itself reaches every tab
     showing this listing via storage sync (see the schema note on
     noResultsFound in store.js), but this scroll cue is local, ordinary
     module state, not something that could follow it there too. */
  let pendingFocusListingId = null;

  /* Shared by the list-level sort button and each group's own — same
     3-state cycle, same label shape either way. */
  const sortLabel = (dir) => (dir === "asc" ? "Price ▲" : dir === "desc" ? "Price ▼" : "Sort by price");
  const nextSortDir = (dir) => (dir === null ? "asc" : dir === "asc" ? "desc" : null);

  /* Whether a set of listings look like "the same item" by autoGroupKey —
     used only to decide how to *name* a freshly dragged-together group
     (see nameForNewGroup), not whether dragging is allowed at all (you
     can drag any two listings together regardless). */
  function looksAlike(members) {
    if (members.length < 2) return true;
    const keys = members.map(autoGroupKey);
    return keys.every((k) => k != null && k === keys[0]);
  }

  /* The name a brand new manual group starts with. Members that actually
     look like the same item (autoGroupKey agrees across all of them) get
     the same logical name auto-grouping itself would've used. Anything
     else — genuinely different items dragged together on purpose — gets
     "Mixed Group N", the lowest N not already used by another mixed
     group, so re-using a number some other mixed group still has doesn't
     make two groups look like the same one. */
  async function nameForNewGroup(members) {
    if (looksAlike(members)) return autoGroupLabel(members);

    const existing = await PH.store.getSavedGroups();
    const used = new Set(
      existing.map((g) => Number(/^Mixed Group (\d+)$/.exec(g.title)?.[1])).filter((n) => Number.isFinite(n))
    );
    let n = 1;
    while (used.has(n)) n++;
    return `Mixed Group ${n}`;
  }

  /* Drags one listing onto another to group them — the only way a manual
     group gets created or grown. Dropping onto a listing that's already
     in a manual group just adds the dragged listing to it. Dropping onto
     a listing that's currently only *automatically* grouped (or not
     grouped at all) creates a brand new manual group — and, if the
     target had company via auto-grouping, pulls every one of those
     members in too, rather than leaving the target's old automatic
     group looking broken by losing just the one item that got dragged
     away from it.

     Dropping onto a groupmate you're already manually grouped with is
     treated as an ungroup, not a no-op: a group card fills most of the
     list's height, so dragging a member "out into open space" routinely
     lands back on one of its own siblings rather than genuine empty
     space. Silently doing nothing there made the whole ungroup gesture
     feel broken — the drop-target highlight still lights up (it's just
     another row), but nothing happens on release. Landing back on a
     sibling is never a useful way to ask "add me to a group I'm already
     in", so reinterpreting it as "take me out" is a strict improvement,
     not a semantics conflict. */
  async function groupListings(draggedId, targetId) {
    if (draggedId === targetId) return;

    const [listings, groups] = await Promise.all([PH.store.getSavedListings(), PH.store.getSavedGroups()]);
    const dragged = listings.find((l) => l.id === draggedId);
    const target = listings.find((l) => l.id === targetId);
    if (!dragged || !target) return;
    if (dragged.groupId && dragged.groupId === target.groupId) return removeFromGroup(draggedId);

    if (target.groupId) {
      await PH.store.setListingGroup(dragged.id, target.groupId);
    } else {
      const targetKey = autoGroupKey(target);
      const targetVersion = target.location?.version ?? "1";
      const autoCompany = targetKey
        ? listings.filter((l) => !l.groupId && l.id !== dragged.id && l.id !== target.id
            && autoGroupKey(l) === targetKey && (l.location?.version ?? "1") === targetVersion)
        : [];
      const members = [target, ...autoCompany, dragged];
      const group = await PH.store.createSavedGroup(await nameForNewGroup(members));
      for (const member of members) await PH.store.setListingGroup(member.id, group.id);
    }

    PH.panel.refresh();
  }

  /* Drag-to-group, wired once on the whole list (event delegation via
     [data-listing-id], not per-row listeners) so it keeps working across
     re-renders that swap the list's own children — see renderFilteredList.
     Each row is draggable outright (see listingRow's draggable: "true"),
     not gated behind a separate grip handle. Handles BOTH dropping onto
     another row (grouping) and dropping anywhere else within the list at
     all — the gap between two group cards, say — as ungrouping, resolved
     directly here rather than leaning on wireDocumentUngroupDrop below
     for that: a real test showed a drop landing back inside the list's
     own bounds (just not on a row) didn't reliably reach a document-level
     listener the way dragover events do — bubbling isn't guaranteed to
     behave identically for every drag event type in every engine, so
     resolving it at the closest scope that's actually guaranteed to see
     it is the more robust fix. wireDocumentUngroupDrop is left in place
     purely for a drop that lands genuinely outside the list altogether
     (over the compare modal, say) — see the note there. stopPropagation
     on drop keeps the two from double-handling the same event when a
     drop does land inside the list. */
  function wireGroupDrag(list) {
    wireDocumentUngroupDrop();

    list.addEventListener("dragstart", (e) => {
      const row = e.target.closest("[data-listing-id]");
      if (!row) return;
      draggedListingId = row.dataset.listingId;
      dragOutcomeHandled = false;
      row.classList.add("ph-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", draggedListingId);

      /* Only reveal the standing ungroup target for a listing that's
         actually in a group — dropping an already-standalone listing onto
         it would just be a no-op (see removeFromGroup's own guard), so
         showing it then would be a target that does nothing. */
      if (row.closest(".ph-saved-group")) ungroupZoneEl?.classList.add("ph-ungroup-zone-active");
    });

    /* The same gold outline a valid group target already gets doubles as
       the ungroup feedback too, per an explicit ask — applied to the
       whole list itself (the "ungrouped container" the listing is
       conceptually moving into) whenever the pointer isn't over some
       other row, rather than the dragged listing's own group card (tried
       first, but corrected per a follow-up: the destination being
       highlighted should be where it's landing — the list as a whole —
       not where it's leaving). Recomputed from scratch every dragover
       (toggle, not add/remove split across dragover/dragleave) so the
       list's own highlight and a target row's own highlight can never
       both end up lit, or get stuck lit, from a missed edge case between
       the two events. */
    list.addEventListener("dragover", (e) => {
      if (!draggedListingId) return;
      e.preventDefault();

      const row = e.target.closest("[data-listing-id]");
      const isOtherRow = Boolean(row) && row.dataset.listingId !== draggedListingId;

      list.classList.toggle("ph-drop-target", !isOtherRow);
      row?.classList.toggle("ph-drop-target", isOtherRow);
    });

    list.addEventListener("dragleave", (e) => {
      e.target.closest("[data-listing-id]")?.classList.remove("ph-drop-target");
      if (!list.contains(e.relatedTarget)) list.classList.remove("ph-drop-target");
    });

    list.addEventListener("drop", (e) => {
      const row = e.target.closest("[data-listing-id]");
      row?.classList.remove("ph-drop-target");
      list.classList.remove("ph-drop-target");
      if (!draggedListingId) return;
      e.preventDefault();
      e.stopPropagation();
      dragOutcomeHandled = true;

      if (!row) removeFromGroup(draggedListingId);
      else if (row.dataset.listingId !== draggedListingId) groupListings(draggedListingId, row.dataset.listingId);
    });

    /* dragend always fires, whatever happened during the drag — a
       successful drop somewhere, one that landed on a target whose own
       drop handler didn't do its job for whatever reason, or a genuine
       cancel (Escape, or releasing outside the browser window). Only the
       middle case needs handling here: if nothing already resolved this
       drag (dragOutcomeHandled) AND the browser doesn't consider it an
       outright cancel (dropEffect stays "none" for that — every real drop
       location on this page already gets preventDefault via wireGroupDrag/
       wireDocumentUngroupDrop, so a genuine drop never leaves it at
       "none"), treat it the same as dropping into open space: ungroup.
       removeFromGroup's own guard makes this a no-op for anything that
       wasn't grouped to begin with, so there's no harm in reaching this
       point on an ordinary drag that already WAS handled some other way —
       dragOutcomeHandled is what actually gates it. */
    list.addEventListener("dragend", (e) => {
      e.target.closest("[data-listing-id]")?.classList.remove("ph-dragging");
      if (!dragOutcomeHandled && draggedListingId && e.dataTransfer.dropEffect !== "none") {
        removeFromGroup(draggedListingId);
      }
      draggedListingId = null;
      list.classList.remove("ph-drop-target");
      for (const dropTarget of list.querySelectorAll(".ph-drop-target")) dropTarget.classList.remove("ph-drop-target");
      ungroupZoneEl?.classList.remove("ph-ungroup-zone-active", "ph-drop-target");
    });
  }

  /* A standing, always-reachable ungroup target — fixed to the panel's own
     viewport position rather than living inside the scrolling `.ph-saved-
     list`, unlike the "drop anywhere that isn't a row" fallback above and
     the first version of this feature (a plain row appended to the bottom
     of the list, removed for "not working reliably"; see the git history
     on this file). A card-filled, possibly long-scrolling list gives that
     approach two ways to fail that neither is really a bug in: the fallback's
     only feedback is the entire list's own gold outline, which barely
     shows once cards fill most of the visible area — nearly every point
     you release over resolves to *some* row instead of the list's own
     background — and the original dedicated zone, appended after every
     group, scrolled along with everything else, so reaching it while
     mid-drag from *further up* than the scroll position meant scrolling
     the container by hand at the same time as controlling the drag
     itself. Anchoring this one with position: fixed sidesteps both: it
     always sits at the same spot on screen no matter how long the list is
     or how far it's scrolled, and it's a big, clearly-labeled target
     rather than a hard-to-notice outline. Kept alongside, not instead of,
     the existing fallback — dropping into genuine open space still works
     the same way it always did; this is just a second, more reliable way
     to ask for the same thing. */
  function ungroupedDropZone() {
    const zone = el("div", { class: "ph-saved-ungroup-zone" },
      el("div", { class: "ph-saved-ungroup-zone-title", text: "Ungrouped" }),
      el("div", { class: "ph-saved-ungroup-zone-sub", text: "Drop here to remove from group" })
    );

    zone.addEventListener("dragover", (e) => {
      if (!draggedListingId) return;
      e.preventDefault();
      zone.classList.add("ph-drop-target");
    });

    zone.addEventListener("dragleave", () => zone.classList.remove("ph-drop-target"));

    zone.addEventListener("drop", (e) => {
      zone.classList.remove("ph-drop-target");
      if (!draggedListingId) return;
      e.preventDefault();
      e.stopPropagation();
      dragOutcomeHandled = true;
      removeFromGroup(draggedListingId);
    });

    return zone;
  }

  /* The "drag out into open space to ungroup" half of the mechanism,
     wired on `document` exactly once (guarded by ungroupDropWired) rather
     than inside wireGroupDrag itself, which runs fresh on every render —
     a document-level listener has no owning element to be garbage
     collected with, so registering it per-render would leak a new one on
     every single Saved-tab refresh. Exists purely for a drop that lands
     completely outside the list's own bounds (over the compare modal,
     another panel tab's own controls, anything) — a real report showed
     that case specifically stuck on a "no-drop" cursor and did nothing,
     since the browser rejects a drop whose dragover default was never
     prevented, and a list-scoped listener never sees a dragover that
     never entered its own subtree. wireGroupDrag's own drop listener
     calls stopPropagation whenever it handles a drop, so this never
     double-fires for a drop that lands *inside* the list (that case is
     resolved there directly — see the note on wireGroupDrag for why).
     Guarded by `draggedListingId` throughout, so this never does
     anything outside an actual listing drag started in wireGroupDrag's
     own dragstart. */
  let ungroupDropWired = false;
  function wireDocumentUngroupDrop() {
    if (ungroupDropWired) return;
    ungroupDropWired = true;

    document.addEventListener("dragover", (e) => {
      if (!draggedListingId) return;
      e.preventDefault();
    });

    document.addEventListener("drop", (e) => {
      if (!draggedListingId) return;
      e.preventDefault();
      dragOutcomeHandled = true;
      removeFromGroup(draggedListingId);
    });
  }

  /* version ("1"/"2", the listing's own location.version) picks Exalted
     over Chaos as the below-divine unit for PoE2, via
     PH.prices.smallUnitAmount — same substitution bookmarks.js's own copy
     of this function uses; see poe2-exalt-replaces-chaos-in-hierarchy for
     why. */
  function formatChaosDelta(diff, version) {
    const abs = Math.abs(diff);
    const sign = diff > 0 ? "+" : "-";
    const rate = PH.prices.currentRate();
    return rate && abs >= rate.divineInChaos
      ? `${sign}${(abs / rate.divineInChaos).toFixed(1)} div`
      : `${sign}${PH.prices.smallUnitAmount(abs, version)}`;
  }

  /* Bulk clearing — "Clear all" / "Clear selected" / the per-row checkbox.
     Both UI state, kept in memory like Bookmarks' own `editing`: not worth
     persisting across a reload, and a listing you've checked in one game's
     view has no visible checkbox in the other, so ids for a different game
     can linger in here harmlessly until actually acted on ("Clear all"'s
     confirm and "Clear selected" both filter down to the game currently on
     screen before deleting anything). "Clear all" confirms first, since it
     can wipe out everything at once; "Clear selected" acts immediately —
     you already made the selection deliberately, one row at a time. */
  let editing = null; // { kind: "clear-all" } | { kind: "rename-group", entryId } | null
  const selected = new Set();

  /* The listing id currently mid-drag (see wireGroupDrag) — a plain
     module variable rather than dataTransfer's own payload, since reading
     dataTransfer.getData during dragover is unreliable across browsers
     (some only expose it on drop); a real listing id has to be there
     anyway before setData is worth calling. null outside of an active
     drag. */
  let draggedListingId = null;

  /* Set by whichever drop handler actually processes a given drag — the
     list's own (onto a row, or onto open space), the standing ungroup
     zone's, or the document-level fallback — so dragend below can tell
     "some drop fired and made a decision" apart from "nothing ever did".
     Reset to false at the start of every dragstart. Exists because a real
     report showed a case where a drop's own dragover reliably highlighted
     its target (proving preventDefault ran) but the matching drop event
     itself apparently never reached that target's listener — a genuine
     drag-and-drop inconsistency, not something worth chasing further to
     explain, when dragend (which fires unconditionally at the end of
     every drag, spec-guaranteed, regardless of whether a drop happened
     anywhere) can just catch it directly instead. */
  let dragOutcomeHandled = false;

  /* The current render's standing ungroup target (see ungroupedDropZone) —
     reassigned each render() since the element itself is torn down and
     rebuilt along with everything else in `container`. Kept outside
     render() so wireGroupDrag's dragstart/dragend handlers (attached once
     per render to a *different* element, `list`) can reveal and hide it
     without either function needing to thread a reference through the
     other. null before the first render. */
  let ungroupZoneEl = null;

  /* The filter box and price-sort toggle, same in-memory-only treatment
     as editing/selected above — not persisted, and reset to "show
     everything, unsorted" on a fresh boot. Kept outside render() (rather
     than as local state a fresh render would forget) so re-filtering or
     re-sorting on input doesn't need a full PH.panel.refresh() — see
     renderFilteredList, which updates just the list in place so the
     filter <input> itself is never torn down and rebuilt mid-keystroke
     (that would lose focus on every character typed). */
  let filterText = "";
  let sortDir = null; // null | "asc" | "desc" — cycles null -> asc -> desc -> null

  /* Debounces the filter re-render — without it, every keystroke re-groups
     and re-sorts the whole game-scoped list and rebuilds the DOM for it,
     which gets janky once there are hundreds of saved listings. filterText
     itself still updates on every keystroke (so the eventual render always
     reflects the latest text, and Cancel/Clear-style reads of it elsewhere
     stay live); only the expensive re-render is delayed. */
  let filterDebounceTimer = null;
  const FILTER_DEBOUNCE_MS = 150;

  function setEditing(next) {
    editing = next;
    PH.panel.refresh();
  }

  function toggleSelected(id, checked) {
    checked ? selected.add(id) : selected.delete(id);
    PH.panel.refresh();
  }

  /* ---------------------------------------------------- the save button ---- */

  async function enhanceRows() {
    const rows = PH.ui.tradeRoot().querySelectorAll(`${ROW}:not([${MARK}])`);
    if (!rows.length) return;

    for (const row of rows) {
      row.setAttribute(MARK, "");

      /* Bulk-exchange rows price currency-to-currency and don't have an
         item, seller, or mods in this shape — nothing sensible to save. */
      if (row.classList.contains("exchange")) continue;

      const buttons = row.querySelector(".details .btns");
      if (!buttons) continue;

      /* A sibling after .btns, not a child of it — .btns is a tight flex
         row of the trade site's own buttons with no room to spare, which is
         why a 4th button squeezed in there rendered nearly invisible. Its
         own line below reads much better. Starts as "Save Listing" for
         every row regardless of whether it's already saved — syncSaveButtons
         right below corrects that in one pass rather than duplicating the
         "is this already saved" check here too. */
      buttons.after(el("button", {
        type: "button",
        class: "ph-save-btn",
        title: "Save this listing",
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          captureListing(row);
        },
      }, "Save Listing"));
    }

    await syncSaveButtons();
  }

  /* A saved listing "matches" a live row two ways: sourceId — the exact
     same listing instance (see the schema note at the top of the file) —
     or, failing that, the same item title + seller account, which catches
     re-saving what's effectively the same offer even when GGG's own row
     id has changed (a relist, or just not stable across a fresh search —
     never verified either way, so this is the belt-and-suspenders check,
     not the primary one). Title+seller with no price/mods compared is
     deliberately loose — enough to stop an accidental duplicate save of
     the obviously-same listing, not a guarantee of "the exact same" the
     way sourceId is. Returns the matching listing, or null. */
  function matchingListing(saved, row) {
    const sourceId = row.dataset.id;
    const bySourceId = saved.find((l) => l.sourceId && l.sourceId === sourceId);
    if (bySourceId) return bySourceId;

    const title = itemTitle(row);
    const seller = sellerName(row);
    if (!title || !seller) return null;
    return saved.find((l) => l.title === title && l.seller === seller) ?? null;
  }

  /* Keeps every .ph-save-btn on the page in sync with what's actually in
     storage (see matchingListing above for how a row is matched to a
     saved listing). Called from three places: enhanceRows above (so a row
     for something you saved on an earlier visit shows "Saved"/"Already
     saved" immediately, not just after you try to re-save it), right
     after captureListing/a removal in this tab, and from main.js's
     PH.store.onChange (so removing the listing from the Saved tab — in
     this tab or a different one — flips the button back live). Buttons
     are never created or removed here, only their label/disabled state —
     enhanceRows owns adding them once per row. */
  async function syncSaveButtons() {
    const buttons = PH.ui.tradeRoot().querySelectorAll(".ph-save-btn");
    if (!buttons.length) return;

    const saved = await PH.store.getSavedListings();

    for (const btn of buttons) {
      const row = btn.closest("div.row[data-id]");
      const match = row ? matchingListing(saved, row) : null;
      const already = match && match.sourceId === row.dataset.id ? "Saved" : match ? "Already saved" : null;

      btn.textContent = already ?? "Save Listing";
      btn.disabled = Boolean(already);
      btn.classList.toggle("ph-save-btn-saved", Boolean(already));
    }
  }

  /* Every field captureListing and capturePendingPrice both need off a
     live result row — pulled out once so a re-search (capturePendingPrice)
     refreshes exactly the same fields a fresh save would capture, rather
     than a hand-picked subset that quietly drifts from captureListing over
     time. `priced` is included as-is (not spread into the returned object)
     since the two callers use it differently — captureListing seeds
     priceHistory's first entry from it, capturePendingPrice hands it to
     pushSavedListingPrice's own dedup path — neither wants it as a stored
     field on the listing itself. */
  function snapshotFromRow(row) {
    const priced = PH.prices.readRowPrice(row);
    const { name, type } = itemNameType(row);
    const listedText = row.querySelector('[data-field="indexed"] small')?.textContent.trim();

    return {
      priced,
      fields: {
        sourceId: row.dataset.id ?? null,
        title: itemTitle(row),
        name,
        type,
        icon: row.querySelector(".icon img")?.src ?? null,
        listedAt: parseListedAgo(listedText),
        rarity: itemRarity(row),
        unidentified: isUnidentified(row),
        corrupted: isCorrupted(row),
        price: priced ? formatPrice(priced) : null,
        priceIcon: priced?.icon ?? null,
        seller: sellerName(row),
        mods: modLines(row),
        properties: itemProperties(row),
        additionalStats: itemAdditionalStats(row),
      },
    };
  }

  async function captureListing(row) {
    const page = PH.location.current();
    const { priced, fields } = snapshotFromRow(row);

    const listing = {
      location: { version: page.version, type: page.type, slug: page.slug },
      league: page.league,
      ...fields,
      priceHistory: priced ? [{ amount: priced.amount, currency: priced.currency, capturedAt: new Date().toISOString() }] : [],
    };

    /* The "already saved?" check and the write happen atomically inside
       saveSavedListingUnlessDuplicate — guards against a duplicate save
       even if the button was somehow still clickable despite
       syncSaveButtons (e.g. storage changed in another tab, or this
       click landed twice, in the instant between render and click). */
    const saved = await PH.store.saveSavedListingUnlessDuplicate(
      listing,
      (l) => matchingListing([l], row) != null
    );
    if (!saved) {
      toast("Already saved.");
      syncSaveButtons();
      return;
    }

    toast(`Saved “${saved.title ?? "listing"}”`);
    PH.panel.refresh();
    syncSaveButtons();
  }

  /* "listed 5 minutes ago" -> an approximate ISO timestamp, computed once
     at save time since a saved listing has no live row left to re-read
     this from later (same reasoning as icon/priceIcon above). GGG's
     markup only ever gives relative text, never a real timestamp, so this
     is only as precise as that text's own unit — to the minute, hour, or
     day, never the second.

     Not every count uses the "N units ago" form: at exactly one day old
     GGG says "yesterday" instead of "1 day ago" (confirmed live), which
     the numeric pattern below doesn't match — so that's handled as its
     own case rather than folded into the regex. The regex itself also
     accepts "a"/"an" in place of a leading digit ("an hour ago", "a
     minute ago"), the same singular wording convention "yesterday" is
     part of, on the theory GGG likely uses it for other units too — not
     yet confirmed for anything but "yesterday" and 5+ digit counts, so
     if some other phrasing (e.g. "today", "just now") turns up looking
     wrong on a saved listing, that's this function silently returning
     null and falling back to the plain savedAt time in listingRow — worth
     reporting so a case for it can be added here precisely rather than
     guessed at. */
  function parseListedAgo(text) {
    if (!text) return null;
    if (/\byesterday\b/i.test(text)) {
      return new Date(Date.now() - 86_400_000).toISOString();
    }

    const match = text.match(/(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
    if (!match) return null;

    const amount = /^\d+$/.test(match[1]) ? Number(match[1]) : 1;
    const unitMs = {
      second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000,
      week: 604_800_000, month: 2_629_800_000, year: 31_557_600_000,
    }[match[2].toLowerCase()];
    return new Date(Date.now() - amount * unitMs).toISOString();
  }

  /* An unidentified item hides its explicit/rolled affixes (implicits
     still show) behind a plain "Unidentified" line where they'd otherwise
     be. Matched by exact trimmed text rather than the .lc class or inline
     color that line happens to carry, since .lc is used throughout this
     popup for unrelated properties too. */
  function isUnidentified(row) {
    return [...row.querySelectorAll(".item-popup__content span")]
      .some((span) => span.textContent.trim() === "Unidentified");
  }

  /* A corrupted item is a critical identifier (unlike most rolled affixes,
     it never rerolls and rules out most crafting) — GGG renders it as its
     own centered line, set apart by rules above/below, same section of the
     popup "Unidentified" occupies for an unidentified item. Matched the
     same way as isUnidentified above (exact trimmed text over every
     descendant, not scoped to `span`, since the corrupted line hasn't been
     confirmed to use the same tag) rather than a class/color guess. */
  function isCorrupted(row) {
    return [...row.querySelectorAll(".item-popup__content *")]
      .some((node) => node.children.length === 0 && node.textContent.trim() === "Corrupted");
  }

  /* GGG's own rarity class on the item popup itself — "unique" and
     "currency" confirmed 2026-08 against real rows (item-popup--unique,
     item-popup--currency), "magic" confirmed the same way against a real
     magic Infernal Sword's outerHTML. "rare"/"normal" follow the exact
     same item-popup--<rarity> pattern as those three but haven't been
     independently seen — inferred, not guessed blind, and read generically
     here (whatever suffix actually follows item-popup--) rather than
     hardcoded to only the confirmed values, so an unconfirmed one still
     comes through correctly instead of silently reading as null. Used by
     rebuildSearch to skip the broken name/type fields for magic/rare
     (see the long comment there) and to keep the auto-grouping rule
     ("group by type alone" for magic/rare, by full title otherwise). */
  function itemRarity(row) {
    const popup = row.querySelector(".item-popup");
    const rarityClass = [...(popup?.classList ?? [])].find((c) => c.startsWith("item-popup--"));
    return rarityClass?.replace("item-popup--", "") ?? null;
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

  /* Same header lines as itemTitle, but kept apart rather than joined —
     GGG's trade API takes a unique's flavour name and its base type as two
     separate fields (query.name / query.type), not one combined string.
     A magic/rare item has no separate flavour-name line — just one line
     mixing its rolled affix words with the base type ("Weaponmaster's
     Infernal Sword") — which lands in `type` below same as a normal item's
     single plain-type line would, but is NOT a real, usable base type;
     rebuildSearch knows to skip both fields entirely for those two
     rarities rather than send that string to the trade API as-is. */
  function itemNameType(row) {
    const lines = [...row.querySelectorAll(".item-popup__header-line")]
      .map((line) => line.textContent.trim())
      .filter(Boolean);
    if (lines.length >= 2) return { name: lines[0], type: lines[1] };
    if (lines.length === 1) return { name: null, type: lines[0] };
    return { name: null, type: null };
  }

  function sellerName(row) {
    const link = row.querySelector('[data-field="indexed"] .profile-link a');
    return link?.textContent.trim() || null;
  }

  /* Implicit and explicit mods both use this shape; the rolled value is
     already substituted into the rendered text (e.g. "+89 to all
     Attributes"). Each mod's { id, text, value, kind, range, affix }: id
     is the stat's own internal id (from its data-field attribute, not
     its text) that GGG's search API filters on — note that id's own
     leading category ("implicit"/"explicit"/"crafted"/"enchant"/
     "fractured"/...) is read straight from that same attribute
     regardless of whether this function's own kind detection below
     recognizes that category, so rebuildSearch's statFilters (see
     statCategory/statHash there) can key off it even for mod types this
     doesn't classify by kind yet. value is a best-effort read of the
     rendered text's own number(s): dualRangeAverage handles a two-number
     mod like "Adds 45 to 75 Physical Damage" (the average of both, 60,
     not either endpoint — confirmed wrong before against a real working
     search capture), modRollValue the plain first-number case otherwise;
     for mods with no roll at all (flags like "Your Physical Damage can
     Shock") there's nothing to search a value for, so that comes back
     null. kind ("implicit" | "explicit" | "pseudo" | null) is read
     straight off the row's own .item-mod--implicit/.item-mod--explicit/
     .item-mod--pseudo class — a pseudo mod is a summary line like "+142
     total maximum Life" GGG computes from the item's other mods, with
     its own stat.pseudo id prefix (verified 2026-08 against real
     outerHTML) rather than stat.implicit or stat.explicit, and no affix
     code of its own; anything not matching one of those three classes
     (crafted, enchant, fractured, ... — not yet individually verified by
     their own CSS class) comes back null here, which is why the pseudo
     detection used elsewhere (isPseudoMod) treats null-kind-with-no-
     affix as pseudo-like for display purposes even though it may
     genuinely be one of these other, still-unclassified categories.
     range (see parseModRoll) is the roll's own possible [min, max]
     bounds, and affix (see parseModAffix) is its prefix/suffix + tier,
     both straight from GGG's display — used for the compare modal's
     tag/roll-quality bar, not this feature's own search filters. */
  function modLines(row) {
    return [...row.querySelectorAll(".item-mod")]
      .map((mod) => {
        const statEl = mod.querySelector('[data-field^="stat."]');
        const text = statEl?.textContent.trim();
        if (!text) return null;
        const id = statEl.getAttribute("data-field")?.replace(/^stat\./, "") || null;
        /* enchant/crafted/fractured aren't detected by their own CSS
           class (unverified — this project doesn't guess a selector it
           hasn't seen) but *are* reliably identifiable from id's own
           leading category, confirmed real via a captured
           /api/trade/search request showing exactly these three
           prefixes ("enchant.stat_...", "crafted.stat_...",
           "fractured.stat_...") on a real item. Checked after the three
           CSS-class kinds, not instead of them, so an implicit/explicit/
           pseudo mod is never reclassified by this fallback. */
        const kind = mod.classList.contains("item-mod--implicit") ? "implicit"
          : mod.classList.contains("item-mod--explicit") ? "explicit"
          : mod.classList.contains("item-mod--pseudo") ? "pseudo"
          : id?.startsWith("enchant.") ? "enchant"
          : id?.startsWith("crafted.") ? "crafted"
          : id?.startsWith("fractured.") ? "fractured"
          : null;
        return {
          id, text, kind,
          value: dualRangeAverage(text) ?? modRollValue(text),
          range: parseModRoll(mod),
          affix: parseModAffix(mod),
        };
      })
      .filter(Boolean);
  }

  /* An explicit mod's own prefix/suffix + tier code, straight from GGG's
     own compact display — the same sibling span parseModRoll reads the
     roll range from (<span class="lc l pr">P1<span class="d">…</span>
     </span> for a tier-1 prefix, "lc l su" + "S4" for a tier-4 suffix —
     verified 2026-08 against several real magic items' outerHTML), just
     read differently: the "pr"/"su" class says which one it is, and the
     leading text (everything in that span *outside* the nested .d range
     span) is GGG's own code — usually just "P1"/"S4", but a mod can also
     be the sum of two affix rolls, shown as GGG's own "P2 + P1" (verified
     live against a real Life mod on a real item) — kept as that whole
     raw string rather than only capturing the first tier number, so nothing
     about a compound roll gets silently dropped. Implicits carry no
     "pr"/"su" class at all — they aren't tiered affixes — so this is null
     for those, same as it is for anything the class/text pattern doesn't
     match rather than a guessed-at code.

     affixEl.textContent, not affixEl.firstChild.textContent — GGG's own
     Vue rendering scatters empty <!----> comment placeholders through
     this markup (seen throughout every mod's own outerHTML), and
     firstChild can land on one of those instead of the actual code's own
     text node, whose own .textContent is "" — silently breaking this
     every time. Node.textContent on the *element* correctly skips comment
     nodes and concatenates only real text in DOM order, so reading that
     instead (then stripping the trailing [range] the nested .d span
     contributes) gets the code reliably regardless of which child node it
     actually ends up as. */
  function parseModAffix(mod) {
    const affixEl = mod.querySelector(".lc.l");
    if (!affixEl) return null;

    const type = affixEl.classList.contains("pr") ? "prefix" : affixEl.classList.contains("su") ? "suffix" : null;
    if (!type) return null;

    const code = affixEl.textContent.replace(/\[.*\]\s*$/, "").trim();
    return code ? { type, code } : null;
  }

  /* Every base property line on the item — quality, defenses (Armour/
     Evasion/Energy Shield), weapon stats (Physical Damage/Crit Chance/
     Attacks per Second/Weapon Range), item level, and the Requires line
     — all read the same way via .item-property, the same selector
     verified repeatedly across different item types (weapons showed
     Physical Damage/Crit/APS/Range, corpses
     showed Corpse Level/Monster Category, every item type showed Item
     Level and Requires). Each property's own field id is read the same
     way a mod's is (data-field, e.g. "ev" for Evasion Rating — verified
     2026-08 against a real property's outerHTML:
     <span data-field="ev" ... type="17"><span>Evasion Rating</span>: ...),
     and value is the same best-effort first-number read modRollValue
     already does for mods — this is what lets the compare modal offer
     the same click-a-stat-to-sort-every-column-by-it behavior GGG's own
     trade site offers for its own property columns, not just for mods.
     Not every property carries a clean single value worth sorting by
     ("Two Handed Axe" has none, "Requires Level 66, 140 Str, 86 Dex" only
     picks up the first number) — those just come back with value: null
     and aren't clickable, same as a flag mod with nothing to roll. Read
     generically as each property's own rendered text otherwise, rather
     than trying to parse out individual fields into their own listing
     properties beyond id/value, since the actual set of properties
     varies enormously by item type/base and only the *container*
     selector has been verified, not a field-by-field catalog of every
     possible property GGG might show. */
  function itemProperties(row) {
    return [...row.querySelectorAll(".item-property")]
      .map((prop) => {
        const text = prop.textContent.replace(/\s+/g, " ").trim();
        if (!text) return null;
        const id = prop.querySelector("[data-field]")?.getAttribute("data-field") || null;
        return { id, text, value: modRollValue(text) };
      })
      .filter(Boolean);
  }

  /* The "additional" stat line under a weapon (DPS/Physical DPS/Elemental
     DPS) or an armour's own defenses (Base Percentile/Armour/Evasion/
     Energy Shield/Ward) — a second block, separate from .item-property,
     verified against two different real items: a weapon's
     .itemPopupAdditional (no modifier class) and an armour's
     .itemPopupAdditional.q (a "q" class that appears to just be Vue's own
     scoped-style hash, not semantically different) share the identical
     [data-field] + .colourDefault/.colourAugmented value + "invisible"-
     when-inapplicable shape (an armour with no Energy Shield/Ward carries
     both fields with an empty value and the invisible class, same as a
     non-elemental weapon's Elemental DPS shows 0 and invisible). Skips
     invisible fields entirely rather than showing an empty or zero line
     that isn't actually meaningful for this specific item.

     The label text is read from a *clone* of each field with its value
     span removed, not the live element's own leading text node — the
     same Vue-comment-placeholder pitfall parseModAffix already ran into:
     reading a specific child node directly can land on one of GGG's own
     empty <!----> placeholders instead of the real text, while reading
     .textContent (which skips comments) after removing the value node is
     reliable regardless of which child the label's text node actually is.

     Sorted so base_defence_percentile always ends up last regardless of
     where it sits in the DOM — GGG's own markup lists it *first* among
     these fields (confirmed against a real armour's outerHTML), but
     comparing that rendering against GGG's actual displayed order showed
     the opposite: percentile renders visually last there. Rather than
     guess at whatever CSS ordering produces that, this just hard-codes
     the one boundary there's real evidence for. */
  function itemAdditionalStats(row) {
    const fields = [...row.querySelectorAll(".itemPopupAdditional [data-field]")]
      .filter((el) => !el.classList.contains("invisible"));

    fields.sort((a, b) => {
      const aLast = a.getAttribute("data-field") === "base_defence_percentile" ? 1 : 0;
      const bLast = b.getAttribute("data-field") === "base_defence_percentile" ? 1 : 0;
      return aLast - bLast;
    });

    return fields
      .map((el) => {
        const valueEl = el.querySelector(".colourDefault, .colourAugmented");
        const rawValue = valueEl?.textContent.trim();
        if (!rawValue) return null;

        const clone = el.cloneNode(true);
        clone.querySelector(".colourDefault, .colourAugmented")?.remove();
        const label = clone.textContent.trim();

        /* Same id/value shape itemProperties uses, for the same reason —
           sortable in the compare modal, not just displayed text. */
        return {
          id: el.getAttribute("data-field") || null,
          text: label ? `${label}: ${rawValue}` : rawValue,
          value: modRollValue(rawValue),
        };
      })
      .filter(Boolean);
  }

  /* .item-property entries split into "Item Level/Requires Level",
     "Intangibility" (and anything else in that same one-off-quirk
     category — see the note on SPECIAL_PROPERTIES below), and everything
     else (Quality, plus Armour/Evasion Rating/Energy Shield when there's
     no itemPopupAdditional value to prefer instead — see below) — GGG's
     own popup visually groups these as separate blocks (per a direct
     side-by-side comparison against our own rendering, including a real
     screenshot specifically calling out Intangibility as needing its own
     group rather than sitting with Quality/defenses), even though
     itemProperties captures them as one flat, undistinguished, DOM-order
     list. Matched by each entry's own leading label text rather than a
     DOM selector, since itemProperties has already flattened everything
     into plain { id, text, value } entries by the time this runs.

     Armour/Evasion Rating/Energy Shield/Ward are dropped from the
     "everything else" group specifically when additionalStats has
     something to say about them — not a duplicate to declutter, but two
     genuinely different numbers: .item-property's own Armour/Evasion/
     etc. reads the item's *actual* current roll (whatever quality it
     happens to have), while the itemPopupAdditional block's same-named
     fields are GGG's own percentile-comparison numbers, normalized to
     20% quality regardless of the item's real quality — confirmed
     directly: on an item that already happens to sit at +20% quality the
     two sets of numbers are identical and easy to mistake for a plain
     duplicate, but they're not the same number for an item at any other
     quality. For comparing across listings, the quality-normalized
     figure is the one that's actually apples-to-apples (a lower-quality
     item's raw Evasion isn't directly comparable to a higher-quality
     one's), so that's the one kept — see itemPropertyBlocks, which
     prefers additionalStats' own copy over this one. */
  /* properties/additionalStats were plain strings for part of this same
     session before gaining id/value (see the schema note in store.js) —
     normalized to the current { id, text, value } shape at every read
     site rather than migrated in storage, the same tolerate-old-shape
     approach mods/affix/kind already use for listings saved even earlier
     than that. */
  function asPropertyEntry(p) {
    return typeof p === "string" ? { id: null, text: p, value: null } : p;
  }

  /* A weapon's own handedness+type line ("Two Handed Axe", "Claw", "Bow",
     ...) — GGG shows this directly under the item's own name, not mixed
     into the property block below it. Detected generically as the *first*
     captured property having no ":" and no parsed value, rather than a
     hardcoded list of weapon classes to maintain — every other
     .item-property line is a real "Label: value" pair; this is the one
     kind that isn't. Returns null (nothing to pull out) for anything else,
     including a listing saved before properties existed at all. */
  function itemClassText(listing) {
    const first = (listing.properties ?? [])[0];
    if (!first) return null;
    const prop = asPropertyEntry(first);
    return !prop.text.includes(":") && prop.value == null ? prop.text : null;
  }

  const SPECIAL_PROPERTIES = /^(Intangibility)\b/i;
  /* Item Level and the Requires line — shared with propEntries below,
     which excludes these from the compare modal's star/sort mechanism
     entirely (see the note there for why), so both stay in sync off one
     pattern rather than two copies that could drift apart. */
  const LEVEL_INFO_PROPERTIES = /^(Item Level|Requires)\b/i;
  function splitBaseProperties(properties, hasAdditionalDefenses) {
    const levelInfo = [];
    const special = [];
    const stats = [];
    const supersededByAdditional = /^(Armour|Evasion(?: Rating)?|Energy Shield|Ward)\b/i;
    for (const prop of properties) {
      if (LEVEL_INFO_PROPERTIES.test(prop.text)) { levelInfo.push(prop); continue; }
      if (SPECIAL_PROPERTIES.test(prop.text)) { special.push(prop); continue; }
      if (hasAdditionalDefenses && supersededByAdditional.test(prop.text)) continue;
      stats.push(prop);
    }
    return { levelInfo, special, stats };
  }

  /* One property's own line, plain (no click-to-sort) — the version a
     lone listing's own card uses, since there's no other listing to sort
     against; see comparePropertyCell in openCompareModal for the
     interactive version the compare modal renders instead. */
  function propertyLineNode(prop) {
    return el("div", { class: "ph-item-property-line", text: prop.text });
  }

  /* The full property display for one listing — up to four visually
     separated groups, joined by a *small* divider rather than the more
     prominent one between implicit/explicit mods (ph-item-divider-small
     vs ph-item-divider), per an explicit ask to match GGG's own lighter
     touch specifically here: Item Level/Requires Level, then
     Intangibility (see SPECIAL_PROPERTIES), then Quality (plus Armour/
     Evasion Rating/Energy Shield when there's nothing more specific to
     show instead — see splitBaseProperties), then the itemPopupAdditional
     block (the quality-normalized Armour/Evasion/Energy Shield values
     plus Base Percentile, always last within its own group — see
     itemAdditionalStats). Any group that's empty for this particular
     listing (e.g. a jewel has no defenses at all) is skipped entirely
     rather than leaving a stray divider with nothing on one side of it.
     `renderProp` builds one property's own line — propertyLineNode's
     plain version for a lone listing, or the compare modal's own
     clickable/sortable version — mirroring how groupedModNodes takes a
     renderMod callback for the same reason. */
  /* Enchant mods ("8% increased Explicit Physical Modifier magnitudes",
     weapon/helm enchantments, ...) belong in the header block as their
     own divided group, not mixed into the regular mods list below — per
     an explicit ask, the same treatment Intangibility already gets.
     Detected via mod.kind === "enchant" (see modLines — an id-prefix
     signal confirmed real via a captured network request, not a guessed
     CSS class). Property-shaped (value: null — an enchant isn't meant to
     be sortable here the way a real property stat is) so it can reuse
     whatever renderProp callback itemPropertyBlocks was already given
     for everything else, rather than needing its own render path.
     excludeEnchantMods below is the other half of this — what keeps
     these out of the regular mods list once they're pulled out here. */
  function enchantEntries(listing) {
    return (listing.mods ?? [])
      .filter((m) => typeof m === "object" && m.kind === "enchant")
      .map((m) => ({ id: null, text: m.text, value: null }));
  }

  /* The mods list minus whatever enchantEntries above already pulled
     into the header block — everything else (implicit/explicit/pseudo/
     crafted/fractured/unclassified) stays in the regular mods
     rendering. */
  function excludeEnchantMods(mods) {
    return (mods ?? []).filter((m) => !(typeof m === "object" && m.kind === "enchant"));
  }

  function itemPropertyBlocks(listing, renderProp = propertyLineNode) {
    const additionalStats = (listing.additionalStats ?? []).map(asPropertyEntry);
    let properties = (listing.properties ?? []).map(asPropertyEntry);
    /* The class line (see itemClassText) renders separately, directly
       under the item's title — drop it here so it doesn't also show up
       a second time as an ordinary property line. */
    if (itemClassText(listing) != null) properties = properties.slice(1);
    const { levelInfo, special, stats } = splitBaseProperties(properties, additionalStats.length > 0);
    const enchants = enchantEntries(listing);
    /* Each group's own color, matching GGG's own item popup (per a real
       side-by-side comparison) — special is Intangibility-only today
       (see SPECIAL_PROPERTIES), so its own green applies to that; enchant
       gets the same blue family GGG uses for it. Neither is pixel-sampled
       from a real screenshot the way the mod-text colors below started
       from, so treat these as a close approximation, adjustable once
       actually seen live. levelInfo/stats/additionalStats stay
       uncolored (the default ink/muted tone already in place). */
    const groups = [
      { entries: levelInfo, variant: null },
      { entries: special, variant: "special" },
      { entries: enchants, variant: "enchant" },
      { entries: stats, variant: null },
      { entries: additionalStats, variant: null },
    ].filter((g) => g.entries.length);

    const nodes = [];
    groups.forEach((group, i) => {
      if (i > 0) nodes.push(el("hr", { class: "ph-item-divider-small" }));
      const variantClass = group.variant ? ` ph-item-properties-${group.variant}` : "";
      nodes.push(el("div", { class: `ph-item-properties${variantClass}` }, group.entries.map(renderProp)));
    });
    return nodes;
  }

  function modRollValue(text) {
    const match = text.match(/-?\d[\d,]*\.?\d*/);
    if (!match) return null;
    const value = parseFloat(match[0].replace(/,/g, ""));
    return Number.isFinite(value) ? value : null;
  }

  /* A dual-range mod's own rendered text — "Adds 45 to 75 Physical
     Damage" — has two numbers, not one, and modRollValue above only ever
     captures the first (45). Confirmed wrong via a real side-by-side
     comparison against GGG's own working search: the correct search
     value for this exact mod is 60, the average of both numbers, not
     either endpoint alone. Matches the first "<number> to <number>"
     substring specifically (requiring a real number, not just any word,
     on both sides of "to") so this doesn't misfire on a mod whose text
     merely contains the word "to" without flanking numbers — "+34 to
     Intelligence" (no second number after "to"), "10% chance to Poison
     on Hit" (no number immediately before "to") — both correctly fail to
     match and fall through to modRollValue's own single-number read
     instead. A mod with two "to"s in its own text ("Adds 2 to 3 Fire
     Damage to Spells and Attacks") still matches the *first* one
     correctly, since regex scanning is left to right. null (not this
     kind of mod at all) falls through to modRollValue the same way a
     mod with no roll at all already does. */
  function dualRangeAverage(text) {
    const match = text.match(/(-?[\d.]+)\s+to\s+(-?[\d.]+)/i);
    if (!match) return null;
    const a = parseFloat(match[1]);
    const b = parseFloat(match[2]);
    return Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : null;
  }

  /* A mod's possible roll range, straight from GGG's own display — a
     sibling <span class="lc l ..."><span class="d">[low—high]</span></span>
     right after the mod's main stat span, present on implicit and
     explicit mods alike (verified 2026-08 against several real magic
     items' outerHTML — e.g. "+35 to Strength" carrying "[33—37]" right
     beside it). Only handles a single [low—high] (or a fixed [n], which
     becomes {min: n, max: n}) — a two-part mod like "Adds X to Y Damage"
     shows a dual range ("[110—150 to 223—260]", one range per number in
     the mod's own text), which modRollValue above doesn't capture two
     values for either, so there's nothing to pair a second range with —
     skipped (null) rather than guessed at, same as modRollValue already
     does for a mod with no roll at all. */
  function parseModRoll(mod) {
    const rangeText = mod.querySelector(".lc.l .d")?.textContent ?? "";
    if (!rangeText || rangeText.includes(" to ")) return null;

    const dual = rangeText.match(/(-?[\d.]+)\s*[—-]\s*(-?[\d.]+)/);
    if (dual) {
      const min = parseFloat(dual[1]);
      const max = parseFloat(dual[2]);
      return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
    }

    const single = rangeText.match(/-?[\d.]+/);
    if (!single) return null;
    const n = parseFloat(single[0]);
    return Number.isFinite(n) ? { min: n, max: n } : null;
  }

  /* ------------------------------------------------ search this exact item ---- */
  /*
     "Search this exact item" calls GGG's own trade-search API
     (pathofexile.com/api/trade/search/<league>, or /api/trade2/... for a
     PoE2 listing — same request/response shape, just the PoE2 host path
     from location.js's own buildUrl) directly and opens the real results —
     not a prefilled query you still have to finish yourself. This
     is a deliberate, narrow exception to this project's usual "never touch
     an undocumented endpoint" rule (real precedent from Awakened PoE Trade
     and PoE-Overlay-Community-Fork, confirmed by reading their actual
     source, and a deliberate decision rather than an assumption). The
     rules that keep this narrow:

       - Only ever called from here, in direct response to a click — never
         polled, never batched, never on a timer.
       - Runs in THIS content script, not the service worker — the target
         is pathofexile.com itself, which this script is already running
         on, so the request is same-origin (automatic cookies, no CORS,
         no new host_permissions entry needed). That's the one exception to
         "network calls go in the service worker" — poe.ninja still isn't
         reachable this way.
       - Rate-limited against GGG's own response headers (rateLimitCooldown
         below), refusing new calls with a toast rather than retrying
         silently, mirroring PoE-Overlay-Community-Fork's own
         TradeRateLimitService.
       - /api/trade/fetch is also called now (see fetchListingHeaders), but
         strictly for its response headers, to track its own separate
         rate-limit budget — never its body. Unlike a price-checker, we
         never source a listing's own item/mod data from it; the DOM
         capture this feature already has stays the only source of truth
         for what gets saved. See the long comment above
         fetchListingHeaders for the full reasoning (including why mixing
         /fetch's own data in would be actively unsafe, not just
         unnecessary).

     Each stat filter's min AND max are both set to the exact rolled value
     (not just a minimum) — the tightest possible match, since the goal is
     relocating one specific item, not browsing similar ones. See
     buildStatFilters for how those per-mod values are actually turned
     into filters — not simply one-to-one, since GGG's own search merges
     some same-stat mods together. When there are no stats to filter on
     at all (unidentified, or nothing rolled that had both a stat id and
     value), the seller's account is added as a filter instead, to keep
     name/type-only results narrowed to one listing — see the
     trade_filters.account note further down. */

  /* mod.id's own leading category ("explicit", "crafted", "implicit",
     "enchant", "fractured", ...) and the stat hash after it — both read
     straight off the id string itself (see modLines), not off mod.kind,
     since this needs to work for categories this project doesn't
     classify by kind/CSS-class at all yet (crafted, enchant, fractured).
     "stat_1509134228" for a "explicit.stat_1509134228" id, "explicit" for
     its category. */
  function statHash(id) {
    const i = id.indexOf(".");
    return i === -1 ? id : id.slice(i + 1);
  }
  function statCategory(id) {
    const i = id.indexOf(".");
    return i === -1 ? null : id.slice(0, i);
  }

  /* GGG's own search doesn't treat every distinct mod as its own filter
     one-for-one — confirmed via a real side-by-side comparison the
     developer ran against GGG's own working search for the same item:
     when an item has the same underlying stat rolled from two different
     mod categories at once (e.g. a real explicit "+65% increased
     Physical Damage" affix AND a separately bench-crafted "+138%
     increased Physical Damage" mod — two genuinely different lines on
     the item, both real, sharing one stat hash under the hood), GGG's
     search doesn't filter on them as two independent id:value pairs; it
     merges them into one filter, using the explicit category's own id
     with their SUMMED value (203, not 65 and 138 pinned separately).
     Sending them as two separate exact pins is exactly the shape of bug
     real testing caught: an AND query with two filters that could never
     both be true for the same real listing, since no listing's own
     explicit-only reading would be 65 *and* its crafted-only reading
     138 the way two independent id:value filters demand — GGG's own
     search just doesn't split it that way to begin with.

     Grouped by hash (see statHash) since that's what actually identifies
     "the same underlying stat" regardless of which category produced it;
     within a group, the explicit category's own id is preferred when
     present (the one confirmed case), falling back to whichever mod
     happened to be captured first for any other combination this hasn't
     been tested against — better than guessing at a different rule with
     no evidence for it either way. A group of one behaves exactly as
     before (its own id, its own value, unchanged). */
  /* A "N% reduced X" mod's rendered text carries no sign (modRollValue only
     ever reads a plain positive number off it — see modLines), but stat
     filters are always framed in the positive on the trade site too
     ("increased"/"reduced" share one underlying stat id, and it's the
     numeric value's own sign that says which), so a reduced roll needs to
     go to GGG's search as a negative number or it's asking for the exact
     opposite of what's on the item — the bug a real screenshot caught
     ("34% reduced Presence Area of Effect" filtered as min=max=34 instead
     of -34). mod.range (see parseModRoll) already carries the real signed
     bounds straight from GGG's own display (e.g. [-40, -20] for a reduced
     stat), so a value that only fits the range once negated is flipped —
     same technique modQuality below already uses for the compare modal's
     roll-quality bar, pulled out here so both places (and both games —
     this is DOM-driven, not PoE1/PoE2-specific) share one fix instead of
     two copies drifting apart. A mod with no captured range (a legacy
     saved listing from before range was tracked) is left as-is — nothing
     to compare its sign against, same as before this fix. */
  function signedModValue(mod) {
    const { value, range } = mod;
    if (value == null || !range) return value;
    if (value >= range.min && value <= range.max) return value;
    if (-value >= range.min && -value <= range.max) return -value;
    return value;
  }

  function buildStatFilters(mods) {
    const eligible = mods
      .filter((mod) => typeof mod === "object" && mod?.id && mod.value != null)
      .map((mod) => ({ ...mod, value: signedModValue(mod) }));

    const byHash = new Map();
    for (const mod of eligible) {
      const hash = statHash(mod.id);
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(mod);
    }

    return [...byHash.values()].map((group) => {
      const id = group.find((m) => statCategory(m.id) === "explicit")?.id ?? group[0].id;
      const value = group.reduce((sum, m) => sum + m.value, 0);
      return { id, value: { min: value, max: value } };
    });
  }

  const TRADE_API_HOST = "https://www.pathofexile.com";

  async function rebuildSearch(listing) {
    const version = listing.location?.version ?? "1";

    const league = listing.league;
    if (!league) {
      toast("No league recorded for this listing — can't search.", { error: true });
      return;
    }

    /* Set on every real search attempt now, not just a zero-result one —
       per an explicit ask, the listing you just searched for should be
       the one render() scrolls to and briefly highlights next, the same
       way it already did for "this item's gone, remove it?", every time
       you click Search this exact item (including the compare modal's own
       Find Item button), not only when something's wrong with it. */
    pendingFocusListingId = listing.id;

    const statFilters = buildStatFilters(listing.mods ?? []);

    const request = {
      query: {
        status: { option: "any" },
        stats: [{ type: "and", filters: statFilters }],
        filters: {},
      },
      sort: { price: "asc" },
    };
    /* A magic or rare item's header is a single line combining its
       (randomly rolled) affix words with the base type — e.g. "Weaponmaster's
       Infernal Sword" or "Dragon Sever Infernal Sword" — not two separate
       lines the way a unique's flavour name + base type are (itemNameType
       above just takes that one line as-is for `type` when there's only
       one). Sending that whole string as query.type doesn't match GGG's
       base-type catalog (it's not a real type name), and query.name is
       specifically for a unique's fixed flavour name, not a per-item
       random rare name — so both silently returned nothing for magic/rare
       listings. There's no reliable way to recover the bare base type
       from that text (stripping affix words would mean maintaining our
       own copy of every prefix/suffix in the game, which is exactly the
       kind of guess this project avoids), so instead: skip name/type
       entirely for these two rarities and lean on stats (already exact,
       min=max) plus an explicit rarity filter to keep the tier narrowed. */
    const isMagicOrRare = listing.rarity === "magic" || listing.rarity === "rare";
    if (!isMagicOrRare) {
      if (listing.name) request.query.name = listing.name;
      if (listing.type) request.query.type = listing.type;
    }

    /* Without `identified`, an unidentified item's search would let
       identified copies of the same base back into results too
       ("identified: any" is the default) — statFilters above may still
       include its implicit(s), but that alone doesn't rule out an
       identified item that rolled the same implicit. Without `corrupted`,
       an uncorrupted item with otherwise-identical stats (a common roll on
       a popular base) can outrank the actual corrupted listing on price
       and land as the "cheapest" result capturePendingPrice then captures,
       silently overwriting a corrupted listing's own record with an
       uncorrupted item's fields — exactly what happened before this filter
       existed. Both filter keys/shapes verified against
       PoE-Overlay-Community-Fork's own reference trade-search request
       (doc/poe/api_trade_search_request.json), not guessed. `corrupted` is
       only ever asserted true — a listing saved before the field existed
       has it undefined, not false, and an uncorrupted item has no
       comparable "prove a negative" identifier worth filtering on the way
       corrupted itself is. */
    const miscFilters = {};
    if (listing.unidentified) miscFilters.identified = { option: "false" };
    if (listing.corrupted) miscFilters.corrupted = { option: "true" };
    if (Object.keys(miscFilters).length) {
      request.query.filters.misc_filters = { filters: miscFilters };
    }

    /* Same reference doc, filters.type_filters.filters.rarity — stands in
       for the name/type narrowing magic/rare listings don't get above. */
    if (isMagicOrRare) {
      request.query.filters.type_filters = { filters: { rarity: { option: listing.rarity } } };
    }

    /* Seller account is only added when there are NO real stat filters at
       all to narrow the search with — real testing showed adding it
       *alongside* stat filters (an earlier version also added it for
       every unidentified/magic/rare listing, regardless of whether
       statFilters actually had anything in it) made the combined AND
       query too strict and could return zero results for an item
       confirmed to still be listed, since it's now demanding an exact
       stat match AND an exact account-name match at once rather than
       letting the already-exact stats stand on their own. Unidentified/
       magic/rare listings almost always still have real stat filters
       (implicits at minimum), so they'll rarely reach this at all; it's
       specifically for the case stats alone can't narrow anything — same
       technique Path of Building's own trade-query code uses for exactly
       this ("apply trader name... this should make false positives
       extremely unlikely" — TradeQuery.lua) and the same filter the trade
       site's own "Trade Filters" > Seller Account UI sets when ticked. */
    if (listing.seller && statFilters.length === 0) {
      request.query.filters.trade_filters = { filters: { account: { input: listing.seller } } };
    }

    /* Opened synchronously, before the fetch below — browsers can silently
       drop a popup once too much time has passed since the click that
       triggered it. We navigate this tab to the real results once they're
       ready, rather than opening the final URL directly. */
    const resultTab = window.open("about:blank", "_blank");

    /* about:blank's default background is plain white, which flashes
       bright against everything else here being dark for however long the
       search takes to come back. Same origin as this tab in Chrome (we
       just opened it ourselves), so writing a dark background straight
       into it before navigating away is safe there — no CORS/cross-origin
       restriction applies. Firefox is the real exception, not "every
       browser": confirmed live (a real SecurityError, "Permission denied
       to access property 'document' on cross-origin object") that a
       content script's own window.open("about:blank") gets a window
       Firefox treats as cross-origin to the content script specifically —
       a known Firefox bug (Bugzilla #1387109), not a mistake in this
       code — even though it's genuinely same-origin, and even though a
       normal (non-extension) page script opening the exact same
       about:blank window would never hit this. try/catch rather than a
       Firefox version check: this is the only thing in this whole flow
       .document access ever touches, so swallowing just this one failure
       is simpler and more robust than detecting Firefox up front, and it
       degrades harmlessly — plain about:blank instead of the dark
       background — while everything past this point in the function
       (the actual search, the eventual real navigation) is untouched by
       it either way. */
    if (resultTab) {
      try {
        resultTab.document.write('<meta charset="utf-8"><body style="background:#1c1f26;margin:0"></body>');
        resultTab.document.close();
      } catch {}
    }

    const result = await searchTrade(request, league, version);
    if (!result || result.error) {
      /* Used to silently navigate this tab to a blank new-search page —
         a real report ("sometimes it breaks if you click it a second
         time, producing nothing in the search window") turned out to be
         exactly this: searchTrade's own failure toast (rate limited,
         network error, ...) lands in the *original* tab, not this new
         one, so if this is the tab you're actually looking at (the usual
         case, since it's the one that just opened), there was nothing at
         all explaining why it's empty. A later report showed even
         pointing at the original tab isn't enough — its toast auto-
         dismisses well before you've switched back to look for it — so
         searchTrade's own error message (see its own return there) is
         shown directly here too, in Chrome — not just a generic pointer
         to go find it elsewhere.

         result?.error is always one of searchTrade's own hardcoded
         strings today (never raw server text), but it's still assigned via
         a real element's textContent rather than interpolated into the
         write() markup — textContent can't be misread as HTML no matter
         what ends up in that string later, which a template literal
         can't promise on its own. Firefox's AMO linter flags exactly this
         pattern (an unsanitized dynamic value passed to document.write)
         even though nothing user-controlled reaches it today.

         Wrapped the same way as the dark-background write above, for the
         same Firefox reason — this .document access throws there too. On
         Firefox this just closes the otherwise-permanently-blank tab
         instead, relying on searchTrade's own toast (already shown in the
         original tab, every failure branch) rather than a message that
         can't be written here. */
      if (resultTab) {
        try {
          const doc = resultTab.document;
          doc.write(
            '<meta charset="utf-8"><body style="background:#1c1f26;margin:0;color:#c9ccd3;font:14px sans-serif;padding:32px;line-height:1.6"><p>Search this exact item didn\'t go through.</p></body>'
          );
          const message = doc.createElement("p");
          message.textContent = result?.error ?? "Check the original tab for why (rate limited, a network error, ...) and try again from there.";
          doc.body.appendChild(message);
          doc.close();
        } catch {
          try { resultTab.close(); } catch {}
        }
      }
      return;
    }

    /* Lets the tab that's about to load record a price observation back
       onto this listing once real results show — see the note above
       capturePendingPrice. Skipped on a zero-result search: there's no
       price to capture, and notePriceIfMatch/capturePendingPrice would
       have nothing to read off an empty results page anyway. */
    if (result.total > 0) {
      await PH.store.setPendingPriceCapture(listing.id);
      /* Fire-and-forget, not awaited — see the note above
         fetchListingHeaders for why this call exists and why its own
         result never affects anything else this click does. */
      fetchListingHeaders(result.ids.slice(0, 1), result.id, version);
    }

    const url = PH.location.buildUrl({ version, type: "search", slug: result.id }, league);
    if (resultTab) resultTab.location.href = url;
    else window.open(url, "_blank", "noopener,noreferrer");

    /* A real, well-formed search (exact name/type + every rolled mod
       pinned min=max) coming back with zero results almost always means
       the listing is gone — sold, or the seller delisted it — rather than
       the search being too strict, since it's exactly this specific item's
       own values. Still opens the (empty) results tab above so you can see
       that for yourself; flagging it on the listing (rather than local UI
       state) is what puts the "remove this?" prompt on its row in *that*
       new tab too, not just this one — see setListingNoResults. */
    if (result.total === 0) {
      await PH.store.setListingNoResults(listing.id, true);
      return;
    }

    toast(`Found ${result.total} matching listing${result.total === 1 ? "" : "s"}.`);
  }

  /* POSTs one search to GGG's trade API and returns { id, total, ids }
     (ids being the matched listings' own ids, cheapest first per this
     request's own sort — see rebuildSearch's request.sort — for
     fetchListingHeaders below to use) on success, or { error: <message> }
     on any failure — cooldown refusal, a network error, a non-2xx
     response, or a malformed one. error is the same text the toast below
     shows, just also handed back to the caller — a real report showed the
     toast alone isn't enough, since it lands in this (the original) tab
     while rebuildSearch's caller is usually already looking at the new
     results tab it just opened, and a toast that's dismissed by the time
     you switch back leaves nothing explaining why the search failed. */
  async function searchTrade(request, league, version) {
    const cooldown = await PH.store.getTradeSearchCooldown();
    if (cooldown && Date.now() < cooldown) {
      const waitSec = Math.ceil((cooldown - Date.now()) / 1000);
      const error = `Rate limited by the trade site — try again in ${waitSec}s.`;
      toast(error, { error: true });
      return { error };
    }

    const base = version === "2" ? "trade2" : "trade";
    /* league can be "poe2/Standard" (or "xbox/Legion") — a real "/" separating
       the realm segment from the league name (see location.js's parsePath).
       Plain encodeURIComponent(league) would escape that "/" to "%2F",
       collapsing what the trade API expects as two path segments into one
       malformed one — never triggered for PoE1 on PC (no realm prefix, so
       identical output to before) but broke every PoE2 search. Splitting on
       "/" first and encoding each part on its own fixes that without
       touching how a slash-free PoE1 league name gets encoded — deliberately
       not reusing PH.location.encodeSegment here, since that also un-escapes
       "(" / ")" for the web-navigation URL buildUrl produces, an assumption
       confirmed for that URL but not for this POST endpoint. */
    const leaguePath = league.split("/").map(encodeURIComponent).join("/");
    const url = `${TRADE_API_HOST}/api/${base}/search/${leaguePath}`;
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch {
      const error = "Couldn't reach the trade site's search API.";
      toast(error, { error: true });
      return { error };
    }

    const rateData = parseRateLimitHeaders(response.headers);
    if (rateData) {
      const blockedUntil = rateLimitCooldown(rateData);
      if (blockedUntil) await PH.store.setTradeSearchCooldown(blockedUntil);
      else reportRateLimitWarning(rateData, "search");
      PH.rateLimitOverlay?.update("search", rateData, blockedUntil);
    }

    if (!response.ok) {
      const error = response.status === 429
        ? "Rate limited by the trade site — try again shortly."
        : `Trade search failed (HTTP ${response.status}).`;
      toast(error, { error: true });
      return { error };
    }

    const data = await response.json().catch(() => null);
    if (!data?.id) {
      const error = "Trade search returned no results id.";
      toast(error, { error: true });
      return { error };
    }
    return { id: data.id, total: data.total ?? 0, ids: data.result ?? [] };
  }

  /* Calls /api/trade/fetch purely to read its response headers — never its
     body. Added 2026-08 alongside a real, screenshot-confirmed problem:
     the results tab rebuildSearch opens makes its own /api/trade/fetch
     call to actually render the listings /search found, against a
     separate, much tighter rate-limit budget than /api/trade/search's own
     (a real rate-limit inspector's readout showed /fetch's tightest rule
     as 2 requests per 6 seconds, vs /search's 5 per 12) — a budget this
     content script otherwise has no way to see at all, since that request
     is made by the trade site's own client code, not by any fetch() of
     ours. This call exists solely to get real headers for that budget, the
     same way searchTrade's own POST already gives us real headers for
     /search's. The response body is deliberately never parsed: GGG's real
     /fetch response (verified against a captured real example in
     PoE-Overlay-Community-Fork's own docs, doc/poe/api_trade_fetch.json)
     does carry full item data, but its own per-mod stat ids
     (item.extended.mods.*[].magnitudes[].hash, a numeric hash like
     "explicit.stat_4052037485") are a different, incompatible scheme from
     the semantic data-field ids this feature's own search filters already
     depend on (see modLines) — mixing the two in would silently break
     "Search this exact item" for any mod sourced the wrong way. The DOM
     capture this feature already has (modLines/itemProperties, refreshed
     on every real re-search — see snapshotFromRow) stays the only source
     of truth for what actually gets saved.

     Only ever called for the single cheapest matched listing (ids[0] from
     searchTrade's own price-ascending sort) — one id is enough to read
     real headers from, no reason to spend more of the very budget this is
     trying to protect than that. Fire-and-forget from rebuildSearch (never
     awaited) — its only effect is future rate-limit state, nothing this
     click's own success depends on, so a failure here is silent and never
     blocks or delays opening the real results tab.

     ?query=<searchId> is included even though its own value is never used
     here — every real call to this endpoint seen in reference source
     (APT's pathofexile-trade.ts) includes it, and there's no confirmed
     evidence this endpoint behaves the same without it, so this matches
     the verified shape rather than guessing it's safe to drop. */
  async function fetchListingHeaders(ids, searchId, version) {
    if (!ids.length) return;
    const cooldown = await PH.store.getTradeFetchCooldown();
    if (cooldown && Date.now() < cooldown) return;

    const base = version === "2" ? "trade2" : "trade";
    let response;
    try {
      response = await fetch(`${TRADE_API_HOST}/api/${base}/fetch/${ids.join(",")}?query=${encodeURIComponent(searchId)}`);
    } catch {
      return;
    }

    const rateData = parseRateLimitHeaders(response.headers);
    if (rateData) {
      const blockedUntil = rateLimitCooldown(rateData);
      if (blockedUntil) await PH.store.setTradeFetchCooldown(blockedUntil);
      else reportRateLimitWarning(rateData, "fetch");
      PH.rateLimitOverlay?.update("fetch", rateData, blockedUntil);
    }
  }

  /* GGG's rate-limit headers, per policy this response's request was
     charged against (there can be several at once — e.g. one window for
     "requests per few seconds", another for "requests per few minutes"):

       x-rate-limit-rules: Account,Ip
       x-rate-limit-account: 8:10:60,50:600:1800    "count:period(s):timeout(s)"
       x-rate-limit-account-state: 3:10:0,12:600:0  "count:period(s):timeout(s-if-blocked)"

     Shared by both searchTrade and fetchListingHeaders — each endpoint has
     its own separate rate-limit budget (see tradeSearchCooldown/
     tradeFetchCooldown in store.js), but the header shape and the logic
     for reading it are identical either way, so this doesn't care which
     one called it. Simplified from PoE-Overlay-Community-Fork's own
     TradeRateLimitService: they track a full sliding-window ledger of past
     request timestamps (needed since they call these endpoints far more
     often than we do); we only ever make one call to either endpoint per
     click, so it's enough to compute "the latest time any rule says we're
     blocked until" and refuse new calls before then.

     currentCount is checked against maxCount - 1, not maxCount, on
     purpose: this only ever sees the budget as of the one response it's
     given. For /api/trade/search specifically, rebuildSearch's own
     results tab then loads that search's real results page, which makes
     at least one more request of its own — against /api/trade/fetch's
     separate budget, which fetchListingHeaders exists to give us
     visibility into, but even that call's own response only reflects
     state as of itself, not whatever the tab's own simultaneous load also
     does. A real user screenshot confirmed the gap this margin closes:
     three clicks reactively approved by an earlier (>= maxCount) version
     of this check still hit GGG's own "Rate limit exceeded" error on the
     results tab itself, meaning the budget was already exhausted by the
     time each tab's own load ran, just not yet by the time our own prior
     calls returned. Leaving one request of headroom unclaimed cools us
     down a call earlier, before that invisible extra request has the
     chance to be the one that tips a rule over. */
  /* Flattens GGG's own rate-limit headers into one entry per rule per window
     (a rule like "Account" or "Ip" can carry several windows at once, e.g.
     "8 per 10s" and "50 per 600s"), plus the policy name (x-rate-limit-
     policy, e.g. "trade-search-request-limit" — GGG's own label for which
     budget this endpoint is charged against, shown as-is by
     PH.rateLimitOverlay so its readout matches what a real rate-limit
     inspector shows). Shared by rateLimitCooldown, reportRateLimitWarning,
     and PH.rateLimitOverlay below, all three of which used to each re-parse
     the same raw headers independently. Returns null when the response
     carries no rate-limit headers at all (calls that never hit a
     rate-limited endpoint). */
  function parseRateLimitHeaders(headers) {
    const rules = headers.get("x-rate-limit-rules");
    if (!rules) return null;

    const entries = [];
    for (const rule of rules.split(",").map((r) => r.trim().toLowerCase())) {
      const limits = headers.get(`x-rate-limit-${rule}`)?.split(",") ?? [];
      const states = headers.get(`x-rate-limit-${rule}-state`)?.split(",") ?? [];

      for (let i = 0; i < limits.length && i < states.length; i++) {
        const [maxCount, period, timeout] = limits[i].split(":").map(Number);
        const [currentCount, , currentTimeout] = states[i].split(":").map(Number);
        entries.push({ rule, maxCount, period, timeout, currentCount, currentTimeout });
      }
    }
    return { policy: headers.get("x-rate-limit-policy") ?? "", entries };
  }

  function rateLimitCooldown({ entries }) {
    const now = Date.now();
    let latest = null;

    for (const { maxCount, period, timeout, currentCount, currentTimeout } of entries) {
      const blockedFor = currentTimeout > 0 ? currentTimeout : currentCount >= maxCount - 1 ? (timeout || period) : 0;
      if (blockedFor <= 0) continue;

      const until = now + blockedFor * 1000;
      if (!latest || until > latest) latest = until;
    }

    return latest;
  }

  /* A softer, earlier signal than rateLimitCooldown's own hard stop —
     mirrors Awakened PoE Trade's own proactive rate-limit UI, which warns
     as any budget gets close rather than only once a call actually gets
     refused; matched deliberately, since staying visually/behaviorally
     distinct from APT isn't a goal for this project. Flags any rule
     sitting exactly 2 requests from its own max — one more than
     rateLimitCooldown's own -1 margin already treats as blocking, so this
     fires a call earlier still, as a heads-up rather than a refusal (the
     two margins can't both fire for the same rule on the same response,
     since they're checking different remaining-headroom values). Shown as
     a plain toast, not the error-styled one rateLimitCooldown's own
     refusal uses, since nothing was actually refused yet. */
  function reportRateLimitWarning({ entries }, label) {
    const lines = [];
    for (const { maxCount, period, currentCount } of entries) {
      if (maxCount > 0 && maxCount - currentCount === 2) {
        lines.push(`${currentCount}/${maxCount} per ${period}s`);
      }
    }

    if (lines.length) {
      toast(`Approaching the trade site's ${label} rate limit (${lines.join(", ")}) — slow down a little.`);
    }
  }

  /* ------------------------------------------------------- price capture ---- */
  /*
     "Search this exact item" opens a new tab; once that tab actually shows
     results, we record the cheapest one back onto the listing that sent us
     there, so its price history reflects reality without you having to
     manually re-save it — and, since snapshotFromRow re-reads the whole
     row anyway, the rest of the listing's own captured fields (mods,
     properties, rarity, icon, listedAt, ...) refresh the same way, so
     seeing a fix or new field land doesn't require deleting and re-saving
     by hand either. The handoff goes through PH.store.pendingPriceCapture
     (a listing id) for the same reason as the search request itself: a
     freshly opened tab has no other way to know which listing it came from.
     initPriceCapture reads it once on boot and clears it immediately, so a
     tab that was already sitting open can't also claim it. capturePendingPrice
     is called from main.js's poll loop the same way PH.bookmarks.notePriceIfMatch
     is — once real results are showing, once per visit — and reads the
     page via PH.prices.cheapestRowOnPage (same comparison as
     cheapestOnPage, which bookmarks uses, but also hands back the row
     itself so the rest of its fields can be re-read too — see
     PH.store.updateSavedListingSnapshot); nothing new is fetched or clicked
     to make this happen. Dedup (only a genuine price change earns a new
     history slot) comes for free from PH.store.pushSavedListingPrice
     sharing nextPriceHistory with bookmark trades. */

  let pendingPriceCapture = null; // saved listing id

  async function initPriceCapture() {
    const pending = await PH.store.getPendingPriceCapture();
    if (!pending) return;

    pendingPriceCapture = pending;
    await PH.store.clearPendingPriceCapture();
  }

  async function capturePendingPrice() {
    if (!pendingPriceCapture) return;
    const id = pendingPriceCapture;
    pendingPriceCapture = null; // once per visit, whether or not this finds a price

    const row = PH.prices.cheapestRowOnPage();
    if (!row) return;
    const { priced, fields } = snapshotFromRow(row);
    if (!priced) return;

    /* A search's stat/rarity/corrupted filters narrow results to items
       that LOOK the same, but "cheapest result on the page" and "the
       listing we searched for" aren't guaranteed to be the same seller —
       a different account can genuinely have an identical-looking item,
       or the filters can still be imperfect for some case not yet
       covered (this is exactly how a missing `corrupted` filter let an
       uncorrupted item outrank a saved corrupted listing on price and get
       captured in its place — fixed separately in rebuildSearch above,
       but this check exists so the wrong item still can't silently
       overwrite the right one even when some other filter gap turns up
       later). Only blocks on a *known* mismatch — a listing with no
       seller recorded yet (saved before `seller` existed) has nothing to
       compare against, so that case still updates rather than being
       stuck unable to ever refresh. */
    const existing = (await PH.store.getSavedListings()).find((l) => l.id === id);
    if (existing?.seller && fields.seller && existing.seller !== fields.seller) {
      toast(`Cheapest match is from a different seller — skipped updating “${existing.title ?? "this listing"}”.`, { error: true });
      return;
    }

    /* Refresh the whole snapshot (mods, properties, rarity, icon, ...),
       not just the price — otherwise a listing only ever reflects what
       parsing/fields existed the day it was originally saved, and seeing
       an improved capture (a newly-added property, a fixed mod-kind bug)
       requires deleting and re-saving it by hand. priceHistory itself
       stays on pushSavedListingPrice's own dedup path, not this merge. */
    await PH.store.pushSavedListingPrice(id, { ...priced, capturedAt: new Date().toISOString() });
    await PH.store.updateSavedListingSnapshot(id, fields);
    PH.panel.refresh();
  }

  /* -------------------------------------------------------------- render ---- */

  async function render(container) {
    /* One readAll() instead of four separate getters — each of those
       internally re-reads all of storage on its own, so firing them
       concurrently still meant four redundant full round-trips instead of
       one on every Saved-tab render. */
    const { savedListings: listings, leagues: lastSeenLeagues, savedGroups: groups, folders } =
      await PH.store.readAll();
    const pageLocation = PH.location.current();
    const context = { pageLocation, lastSeenLeagues, folders };

    const forThisGame = listings.filter((l) => (l.location?.version ?? "1") === pageLocation.version);

    if (forThisGame.length === 0) {
      container.append(empty("No saved listings yet. Use the save button on a trade result to snapshot it here."));
      return;
    }

    container.append(clearToolbar(forThisGame));

    if (editing?.kind === "clear-all") {
      container.append(confirmRow(
        `Remove all ${forThisGame.length} saved listing${forThisGame.length === 1 ? "" : "s"}? This can't be undone.`,
        {
          confirmLabel: "Clear all",
          onConfirm: async () => {
            const ids = forThisGame.map((l) => l.id);
            await PH.store.deleteSavedListings(ids);
            ids.forEach((id) => selected.delete(id));
            setEditing(null);
          },
          onCancel: () => setEditing(null),
        }
      ));
    }

    const list = el("div", { class: "ph-saved-list" });
    wireGroupDrag(list);
    container.append(searchSortToolbar(forThisGame, groups, context, list));
    renderFilteredList(list, forThisGame, groups, context);
    container.append(list);

    ungroupZoneEl = ungroupedDropZone();
    container.append(ungroupZoneEl);

    if (pendingFocusListingId) focusListingOnNextPaint(pendingFocusListingId);
  }

  /* Scrolls a listing's row into view and briefly highlights it — the
     `container` this render() call just built is still a detached
     scratch element at this point (see renderBody in panel.js), not yet
     swapped into the live page, so scrollIntoView here would do nothing;
     requestAnimationFrame defers this to the next paint, by which point
     that swap (a synchronous .then() callback right after this render()
     call resolves) has already happened. Doesn't try to expand a
     collapsed group the listing might be inside — a real gap, not
     handled here — so this can still silently find nothing in that case. */
  function focusListingOnNextPaint(listingId) {
    pendingFocusListingId = null;
    requestAnimationFrame(() => {
      const row = document.querySelector(`.ph-saved-row[data-listing-id="${CSS.escape(listingId)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("ph-saved-row-focus");
      setTimeout(() => row.classList.remove("ph-saved-row-focus"), 1600);
    });
  }

  /* Filter box + price-sort toggle. Both write straight to `list` via
     renderFilteredList rather than going through PH.panel.refresh() —
     refresh tears down and rebuilds the whole tab from scratch, which
     would recreate this very <input> on every keystroke and throw away
     focus/cursor position mid-type. Updating just the list in place
     leaves the input (and the sort button's own label) untouched, so
     typing feels normal. */
  function searchSortToolbar(forThisGame, groups, context, list) {
    const input = el("input", {
      type: "text",
      class: "ph-input",
      placeholder: "Filter saved listings…",
      value: filterText,
      oninput: (e) => {
        filterText = e.target.value;
        clearTimeout(filterDebounceTimer);
        filterDebounceTimer = setTimeout(
          () => renderFilteredList(list, forThisGame, groups, context),
          FILTER_DEBOUNCE_MS
        );
      },
    });

    const sortBtn = button(sortLabel(sortDir), {
      title: "Cycle sort by price: off, cheapest first, priciest first",
      onClick: () => {
        sortDir = nextSortDir(sortDir);
        sortBtn.textContent = sortLabel(sortDir);
        renderFilteredList(list, forThisGame, groups, context);
      },
    });

    return el("div", { class: "ph-saved-search-row" }, input, sortBtn);
  }

  /* Grouping runs on the *full* game-scoped list, not a pre-filtered one —
     filtering happens after, at the entry level (entryMatchesFilter), so
     a group's own name can match even when the search text isn't found
     in any individual member's own fields, and a matching group always
     shows every member intact rather than being fragmented down to just
     the listing that happened to match. */
  function renderFilteredList(list, forThisGame, groups, context) {
    const needle = filterText.trim();
    const allEntries = buildGroups(forThisGame, groups);
    const entries = sortEntries(allEntries.filter((entry) => entryMatchesFilter(entry, needle)), sortDir);

    list.replaceChildren();
    if (entries.length === 0) {
      list.append(empty(needle ? "No saved listings match that search." : "No saved listings yet."));
      return;
    }

    for (const entry of entries) {
      list.append(entry.kind === "group" ? groupRow(entry, context, needle) : listingRow(entry.listing, context));
    }
  }

  /* Pulls one listing back out of whatever group it's in — dropping it
     anywhere in the list that isn't another row (see wireGroupDrag's own
     drop handler) triggers this, rather than a dedicated "drag here"
     drop zone a first version had. That zone didn't work reliably in
     practice; the simpler rule instead: drag a grouped listing out into
     open space to ungroup it, the same way dragging it onto another
     listing groups it. The only
     other way to ungroup one is the group's own "Ungroup" menu action,
     which dissolves the *whole* group; this is the one-listing-at-a-time
     equivalent. If that was the second-to-last member of its old group,
     setListingGroup itself dismantles that group (see the store.js
     comment there), same as it already does when moving a listing into
     a *different* group. */
  async function removeFromGroup(id) {
    const listings = await PH.store.getSavedListings();
    const listing = listings.find((l) => l.id === id);
    if (!listing?.groupId) return;

    await PH.store.setListingGroup(id, null);
    PH.panel.refresh();
  }

  /* A group's own card: a header (collapse toggle + title + member count,
     plus a rename/ungroup menu) over its members, each rendered exactly
     like a standalone listingRow. The header itself is also a valid drop
     target — targeting the group's first member is enough, since
     groupListings just looks up whatever group *that* listing is already
     in — and stays one whether the group is open or collapsed, so you
     can drag another listing onto a collapsed group without opening it
     first. `needle` (the active filter text, "" when there's none) only
     changes which *members* actually render — matchesFilter/entryMatchesFilter
     already decided this whole entry belongs in the list at all; this is
     just "which of these still count as a hit" now that it's a group and
     not a single listing. If the group only matched by its own name (no
     individual member did), every member still shows, since none of them
     is "the" match. */
  function groupRow(entry, context, needle = "") {
    const wrap = el("div", { class: "ph-saved-group" });
    const isOpen = !collapsedGroups().has(entry.id);
    const groupDir = groupSortDir(entry.id);

    const rarity = highestRarity(entry.members);
    if (rarity) wrap.classList.add(`ph-rarity-${rarity}`);

    const visibleMembers = needle
      ? (() => {
          const hits = entry.members.filter((m) => matchesFilter(m, needle));
          return hits.length ? hits : entry.members;
        })()
      : entry.members;

    /* Delete group replaces the whole card with a confirm, same pattern
       "Clear all" uses — a bulk delete of possibly several listings at
       once deserves the same speed bump, unlike "Ungroup" (dissolves the
       grouping only, keeps every listing) which needs none. */
    if (editing?.kind === "delete-group" && editing.entryId === entry.id) {
      wrap.append(confirmRow(
        `Delete all ${entry.members.length} listing${entry.members.length === 1 ? "" : "s"} in this group? This can't be undone.`,
        {
          confirmLabel: "Delete group",
          onConfirm: async () => {
            await PH.store.deleteSavedListings(entry.members.map((m) => m.id));
            setEditing(null);
          },
          onCancel: () => setEditing(null),
        }
      ));
      return wrap;
    }

    if (editing?.kind === "rename-group" && editing.entryId === entry.id) {
      wrap.append(inlineForm({
        value: entry.title,
        placeholder: "Group name",
        submitLabel: "Save",
        onSubmit: async (title) => {
          if (entry.manual) {
            await PH.store.renameSavedGroup(entry.id, title);
          } else {
            const group = await PH.store.createSavedGroup(title);
            for (const member of entry.members) await PH.store.setListingGroup(member.id, group.id);
          }
          setEditing(null);
        },
        onCancel: () => setEditing(null),
      }));
    } else {
      /* Just the chevron + title now — the count used to live in here too,
         but it's now the Compare button below, and buttons can't nest
         inside another button (invalid HTML, unreliable clicks), so it
         has to be a sibling instead. */
      const toggle = el("button", {
        type: "button",
        class: "ph-saved-group-toggle",
        "aria-expanded": String(isOpen),
        onclick: () => { setGroupCollapsed(entry.id, isOpen); PH.panel.refresh(); },
      },
        el("span", { class: "ph-saved-group-chevron", text: isOpen ? "▾" : "▸" }),
        el("span", { class: "ph-saved-group-title", text: entry.title })
      );

      const compareBtn = button(
        visibleMembers.length === entry.members.length
          ? `Compare (${entry.members.length})`
          : `Compare (${visibleMembers.length}/${entry.members.length})`,
        {
          class: "ph-saved-group-compare",
          title: "Compare every listing in this group side by side",
          onClick: () => openCompareModal(entry, visibleMembers, context.folders),
        }
      );

      /* .ph-icon-btn (same compact style as the "···" menu trigger) rather
         than the full "Price ▲" text button the list-level sort uses —
         keeps the header compact now that Compare sits here too. */
      const sortBtn = PH.ui.iconButton(groupDir === "asc" ? "▲" : groupDir === "desc" ? "▼" : "⇅", {
        title:
          groupDir === "asc" ? "Sorted cheapest first — click for priciest first"
          : groupDir === "desc" ? "Sorted priciest first — click to turn off"
          : "Sort this group by price",
        onClick: () => { setGroupSortDir(entry.id, nextSortDir(groupDir)); PH.panel.refresh(); },
      });

      const head = el("div", {
        class: "ph-saved-group-head",
        dataset: { listingId: entry.members[0].id },
      },
        toggle,
        el("div", { class: "ph-saved-group-actions" },
          compareBtn,
          sortBtn,
          menu([
            { label: "Rename group", onClick: () => setEditing({ kind: "rename-group", entryId: entry.id }) },
            entry.manual
              ? { label: "Ungroup", onClick: async () => { await PH.store.ungroupListings(entry.id); PH.panel.refresh(); } }
              : null,
            { label: "Delete group", danger: true, onClick: () => setEditing({ kind: "delete-group", entryId: entry.id }) },
          ])
        )
      );
      wrap.append(head);
    }

    if (isOpen) {
      const orderedMembers = groupDir
        ? [...visibleMembers].sort(priceComparator(groupDir, listingChaosPrice))
        : visibleMembers;
      const members = el("div", { class: "ph-saved-group-members" });
      for (const listing of orderedMembers) members.append(listingRow(listing, context));
      wrap.append(members);
    }

    return wrap;
  }

  /* ---------------------------------------------------------- compare modal ---- */
  /*
     A one-off overlay just for this feature, not a shared PH.ui
     primitive — Compare is the only thing in the panel that needs a real
     popup-over-everything overlay right now. Only one open at a time,
     same "close whatever's already open" rule PH.ui.hoverPopup already
     uses for its own singleton popup.
  */

  let openCompareBackdrop = null;

  function closeCompareModal() {
    openCompareBackdrop?.remove();
    openCompareBackdrop = null;
    document.removeEventListener("keydown", onCompareModalKeydown);
  }

  function onCompareModalKeydown(e) {
    if (e.key === "Escape") closeCompareModal();
  }

  /* A clicked mod's rolled value for one listing, matched by the stat's
     own internal id (not its rendered text, which differs per listing
     since the rolled value is baked into it) — null if this listing
     doesn't carry that stat at all, or carries it as a plain pre-mod-id
     string (see the schema note on savedListings.mods in store.js). */
  function modValueFor(listing, statId) {
    const mod = (listing.mods ?? []).find((m) => typeof m === "object" && m?.id === statId);
    return mod?.value ?? null;
  }

  /* Same idea as modValueFor, but for a property/additionalStats entry
     (see itemProperties/itemAdditionalStats) — checked across both
     arrays since either could hold the clicked id and a listing has no
     reason to know which one a given field id came from. */
  function propValueFor(listing, id) {
    const all = [...(listing.properties ?? []), ...(listing.additionalStats ?? [])].map(asPropertyEntry);
    return all.find((p) => p.id === id)?.value ?? null;
  }

  /* Where a mod's own rolled value sits within its possible range, 0–100
     (100 = the best possible roll) — the compare modal's own take on the
     value+MAX bar Awakened PoE Trade shows. null when there's nothing
     meaningful to show: no range captured (see parseModRoll — a legacy
     listing, a flag mod with nothing to roll, or a dual-range mod that
     isn't parsed), or a fixed range with no spread to speak of (min ===
     max, e.g. "+2 to Level of Socketed Gems" always rolling exactly 2). */
  function modQuality(mod) {
    if (!mod.range || mod.value == null) return null;
    const { min, max } = mod.range;
    if (max === min) return null;
    /* signedModValue (see buildStatFilters above) flips a "N% reduced X"
       mod's parsed-positive value negative when that's the only way it
       lands inside its own range — the same correction this bar needs so
       a reduced-stat mod doesn't clamp to a flat 100% every time. */
    const value = signedModValue(mod);
    const pct = ((value - min) / (max - min)) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  /* Hovering a mod's own (min-max) range shows the two-tone quality bar
     this used to show inline (see modQuality) plus a plain "N% of range"
     line — via PH.ui.hoverPopup rather than the earlier inline bar +
     verbose native-tooltip sentence, per an explicit ask: the inline
     display should just be the compact "(min-max)" text already appended
     to the mod's own line, with the bar and percentage moved to hovering
     it instead of competing for space in every row all the time. Two
     separate lines in the popup (the bar, then the percentage text), not
     one line combining both, matching that same ask. No-op if there's
     nothing meaningful to show (no range, or min === max — see
     modQuality). */
  function wireModRangeHover(node, mod) {
    const quality = modQuality(mod);
    if (quality == null) return;
    /* Reuses the same red/green (ph-compare-mod-range-min/-max) already
       used for the inline (min-max) range text elsewhere in this file,
       so a worst/best roll reads the same color — bar fill and label
       alike — whether it's the compact inline text or this popup. */
    const labelClass = quality === 0 ? "ph-compare-mod-range-min" : quality === 100 ? "ph-compare-mod-range-max" : "";
    /* A 0% fill is 0 width — invisible, so a Min Roll would show as a
       blank bar instead of a red one. Fill it fully red instead so the
       worst-possible roll still reads as a clearly "full" (bad) bar,
       matching the Max Roll's already-full green bar at the other end. */
    const barWidth = quality === 0 ? 100 : quality;
    const bar = el("span", { class: "ph-compare-mod-bar" },
      el("span", { class: `ph-compare-mod-bar-fill ${labelClass}`.trim(), style: `width:${barWidth}%` })
    );
    const label = el("span", {
      class: labelClass,
      text: quality === 0 ? "Min Roll" : quality === 100 ? "Max Roll" : `${quality}% of range`,
    });
    PH.ui.hoverPopup(node, [el("div", { class: "ph-compare-mod-quality" }, bar, label)]);
  }

  /* A mod's own text color by kind — shared by modLineNode and
     compareModCell so the two never drift apart. Implicit (light grey)
     and pseudo (darker grey, via isPseudoMod) per an explicit color
     correction earlier; crafted gets its own distinct color too, per a
     direct correction that lumping it in with pseudo was wrong — PoE's
     own UI convention gives a bench-crafted mod a recognizably different
     color from a plain rolled affix, not a match for GGG pixel-for-pixel
     (not independently verified against a real screenshot the way
     implicit/pseudo's colors were), but a real, well-known convention
     rather than an arbitrary pick — worth adjusting once it's actually
     seen live. Anything else (a plain explicit affix, or fractured/
     enchant sitting wherever they're rendered) gets no override, the
     default ink color. */
  function modKindClass(mod) {
    if (typeof mod !== "object") return "";
    if (mod.kind === "implicit") return "ph-compare-mod-text-implicit";
    if (mod.kind === "crafted") return "ph-compare-mod-text-crafted";
    if (isPseudoMod(mod)) return "ph-compare-mod-text-pseudo";
    return "";
  }

  /* A mod's identity for the compare modal's shared/best-value highlight
     (modShareCounts/modBestValues/compareModCell) — the mod's own
     rendered text with every number stripped out to a single "#"
     placeholder, so "+97 to maximum Life" and "+92 to maximum Life" (or
     "Adds 45 to 75 Physical Damage" vs "Adds 62 to 129 Physical Damage")
     key identically regardless of what actually rolled.

     Deliberately NOT keyed by mod.id (an earlier version was) — a real
     report showed two listings with what was visibly the exact same mod
     (same wording, same roll range) failing to highlight as a matching
     pair while a neighboring mod on those same listings matched
     correctly, and there's no way in this environment to inspect GGG's
     own id assignment closely enough to say why one mod's id lined up
     and another's didn't. Matching on the displayed text instead
     sidesteps whatever that inconsistency was rather than chasing it
     blind, and has a second real benefit: it naturally unifies a legacy
     plain-string mod (saved before ids/values existed) with a modern
     object-shaped one sharing the same template — an id-based key never
     could, since a legacy mod has no id to compare at all. Every listing
     being compared here is a different roll of the same base item, so
     two mods landing on the same stripped template are, in practice,
     always the same underlying stat. */
  function modKey(mod) {
    const text = (typeof mod === "object" ? mod.text : mod) ?? "";
    return text.replace(/-?\d[\d,]*\.?\d*/g, "#").trim();
  }

  /* The shared engine behind all eight modXxx/propXxx counting functions
     below (modShareCounts/modBestValues/modUniformValues/modStarCounts and
     their prop* counterparts) — mods and properties get IDENTICAL
     treatment (how many listings carry each distinct one, the highest
     value seen for it, whether every carrier agrees on that value, and
     how many of a listing's own entries earn compareModCell/
     comparePropertyCell's star), just over different entry lists, key
     functions, and eligibility rules, so the counting logic itself lives
     here once rather than twice. Each modXxx/propXxx function below is a
     thin wrapper supplying its own `entriesFn` (which array a listing's
     entries come from — `mods`, or propEntries' combined properties+
     additionalStats), `keyFn` (modKey vs propKey), and `filterFn` (which
     entries are even eligible — mods restrict share/uniform/star
     differently by kind, see each wrapper's own note; properties have no
     such distinction and mostly pass everything through). Every filterFn
     below is a literal translation of that function's original standalone
     condition, not a simplified rewrite, so behavior is unchanged. */
  function entryShareCounts(members, entriesFn, keyFn, filterFn) {
    const counts = new Map();
    for (const listing of members) {
      const seen = new Set();
      for (const entry of entriesFn(listing)) {
        if (!filterFn(entry)) continue;
        const key = keyFn(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }

  function entryBestValues(members, entriesFn, keyFn, filterFn) {
    const best = new Map();
    for (const listing of members) {
      for (const entry of entriesFn(listing)) {
        if (!filterFn(entry)) continue;
        const key = keyFn(entry);
        if (!best.has(key) || entry.value > best.get(key)) best.set(key, entry.value);
      }
    }
    return best;
  }

  function entryUniformValues(members, entriesFn, keyFn, filterFn) {
    const DIFFERS = Symbol("differs");
    const seen = new Map();
    for (const listing of members) {
      const countedKeys = new Set();
      for (const entry of entriesFn(listing)) {
        if (!filterFn(entry)) continue;
        const key = keyFn(entry);
        if (countedKeys.has(key)) continue;
        countedKeys.add(key);
        const rep = entry.value ?? null;
        if (!seen.has(key)) seen.set(key, rep);
        else if (seen.get(key) !== DIFFERS && seen.get(key) !== rep) seen.set(key, DIFFERS);
      }
    }
    const uniform = new Map();
    for (const [key, rep] of seen) uniform.set(key, rep !== DIFFERS);
    return uniform;
  }

  function entryStarCounts(members, shareCounts, bestValues, uniformValues, entriesFn, keyFn, filterFn) {
    const counts = new Map();
    for (const listing of members) {
      let count = 0;
      const countedKeys = new Set();
      for (const entry of entriesFn(listing)) {
        if (!filterFn(entry)) continue;
        const key = keyFn(entry);
        if (countedKeys.has(key)) continue;
        countedKeys.add(key);
        const shareCount = shareCounts.get(key) ?? 0;
        const isUniform = shareCount === members.length && uniformValues.get(key) === true;
        if (!isUniform && shareCount >= 2 && entry.value === bestValues.get(key)) count++;
      }
      counts.set(listing.id, count);
    }
    return counts;
  }

  /* How many of `members` carry each distinct mod — used to highlight a
     mod line wherever it recurs across the compared items, rather than
     forcing every column into a shared row grid (see openCompareModal):
     an early version gave every listing a cell in every distinct mod's
     row, so a listing missing that mod showed a "—" placeholder just to
     keep the grid's rows aligned — with items that share only a few mods,
     that's mostly empty placeholder cells creating visual gaps rather
     than useful alignment. Each listing now lists only its own mods, and
     this highlights the ones worth noticing instead. Counts each distinct
     mod once per listing even if it somehow appears twice on the same
     one. No kind filter — every mod (implicit, crafted, explicit, ...)
     counts toward this, even though only explicit mods ever actually get
     starred/bordered off it (see compareModCell's own isExplicit gate). */
  function modShareCounts(members) {
    return entryShareCounts(members, (l) => l.mods ?? [], modKey, () => true);
  }

  /* The highest rolled `value` seen for each distinct shared mod, across
     `members` — feeds compareModCell's star icon (rule B, see the note
     there): among items that share a mod at genuinely differing values,
     the one(s) at the max get marked. A mod with no numeric value at all
     (a flag/boolean affix like "Your Elemental Damage can Shock", parsed
     to value: null by modLines — nothing in its own text to extract a
     magnitude from) has no real "highest" to single out, so it's left
     out of this map entirely. */
  function modBestValues(members) {
    return entryBestValues(members, (l) => l.mods ?? [], modKey, (mod) => typeof mod === "object" && mod.value != null);
  }

  /* How many of a listing's own explicit mods would earn compareModCell's
     star (rule B there) — i.e. the same isExplicit/!isUniform/count>=2/
     mod.value===bestValues.get(key) test compareModCell applies per mod,
     just tallied per listing instead of rendered per cell. Feeds the
     whole-column border below; kept in lockstep with compareModCell's own
     logic deliberately (both read the same shareCounts/bestValues/
     uniformValues) so the column border and the individual mod stars can
     never disagree about which mods actually won. */
  function modStarCounts(members, shareCounts, bestValues, uniformValues) {
    return entryStarCounts(
      members, shareCounts, bestValues, uniformValues,
      (l) => l.mods ?? [], modKey,
      (mod) => typeof mod === "object" && mod.kind === "explicit" && mod.value != null
    );
  }

  /* A listing's own properties AND additionalStats as one combined list
     (see itemProperties/itemAdditionalStats) — the property-side
     counterpart to a listing's `mods` array, for the four functions
     below that mirror modShareCounts/modBestValues/modUniformValues/
     modStarCounts but for stat lines instead of mods. Combined into one
     list rather than kept apart the way itemPropertyBlocks displays them
     (in separate groups) since nothing here cares which of the two
     sources a stat came from, only whether it recurs across listings.

     Item Level and the Requires line are excluded outright — per an
     explicit ask, these should never be starred or sortable at all. They
     aren't a rolled stat worth "comparing" the way Physical Damage or
     Critical Strike Chance are: a higher Item Level doesn't make an item
     better (it only raises what *could* have rolled on it, already
     expressed by the actual mods listed below), and Requires is a
     prerequisite, not a stat to optimize for. Uses LEVEL_INFO_PROPERTIES,
     the same pattern splitBaseProperties uses to route these into their
     own levelInfo group, so the two can't drift out of sync. */
  function propEntries(listing) {
    const all = [...(listing.properties ?? []), ...(listing.additionalStats ?? [])].map(asPropertyEntry);
    return all.filter((prop) => !LEVEL_INFO_PROPERTIES.test(prop.text));
  }

  /* A property's own identity for share/best/uniform matching — its
     data-field id when captured (the stable, already-trusted key
     propValueFor/applySort use for click-to-sort), falling back to its
     exact text for a listing saved before id existed on these. Unlike
     modKey, this doesn't need to strip numbers from the text — mods
     moved to that scheme after a real id inconsistency bug (see
     modKey's own note), and no equivalent has been seen for properties,
     so there's no reason to give up id's own stability pre-emptively. */
  function propKey(prop) {
    return prop.id ? `id:${prop.id}` : `text:${prop.text}`;
  }

  /* Same idea as modShareCounts — how many of `members` carry each
     distinct property/additionalStat, deduped per listing. */
  function propShareCounts(members) {
    return entryShareCounts(members, propEntries, propKey, () => true);
  }

  /* Same idea as modBestValues — the highest value seen for each
     distinct shared property, across `members`. */
  function propBestValues(members) {
    return entryBestValues(members, propEntries, propKey, (prop) => prop.value != null);
  }

  /* Same idea as modUniformValues — whether every listing carrying a
     given property agrees on the exact same value. A property has no
     roll-range concept the way a mod does (see the new "no variability"
     gate on compareModCell's own `clickable`, added first for mods), so
     this cross-listing agreement is the *only* signal available for
     "nothing to compare here" on a property — reused for both
     comparePropertyCell's click-to-sort gate and its own star. */
  function propUniformValues(members) {
    return entryUniformValues(members, propEntries, propKey, () => true);
  }

  /* Same idea as modStarCounts — how many of a listing's own properties
     would earn comparePropertyCell's star, tallied per listing so it can
     feed the same whole-column border mod stars do (see
     compareColumnBorder) rather than being its own, separate signal.
     Excludes SPECIAL_PROPERTIES (Intangibility) outright — per an explicit
     ask, since a higher Intangibility roll is worse, not better, "highest
     value wins a star" is backwards for it, and there's no inverted-star
     concept to award instead; it just never earns one, though it stays
     sortable (see comparePropertyCell's own isSpecial gate on
     clickable/dir, not on this). */
  function propStarCounts(members, shareCounts, bestValues, uniformValues) {
    return entryStarCounts(
      members, shareCounts, bestValues, uniformValues,
      propEntries, propKey,
      (prop) => prop.value != null && !SPECIAL_PROPERTIES.test(prop.text)
    );
  }

  /* The id(s) tied for the lowest chaos-equivalent price among `members`
     — feeds both the currency-pill star (renderTable) and the whole-
     column border below, where it counts as one more star toward a
     listing's total (see the note above compareColumnBorder) rather than
     being a separate, independently-triggered signal — per an explicit
     ask, "cheapest" is just another star in the same tally, not a
     special case bolted onto it. A listing with no comparable chaos
     price (see listingChaosPrice — no priceHistory yet, or a divine
     price with no exchange rate loaded) can never win this, the same
     "don't guess a price comparison" rule Bookmarks' own Total Cost
     already follows. */
  function cheapestListingIds(members) {
    let min = null;
    for (const listing of members) {
      const price = listingChaosPrice(listing);
      if (price != null && (min == null || price < min)) min = price;
    }
    const ids = new Set();
    if (min == null) return ids;
    for (const listing of members) {
      if (listingChaosPrice(listing) === min) ids.add(listing.id);
    }
    return ids;
  }

  /* The whole-column border for the compare modal's header/mods/footer
     cells — "cheapest" folded into the same star tally a listing's mods
     earn (see modStarCounts/cheapestListingIds above) rather than a
     separate rule: a listing's total is its own mod-star count plus one
     more if it's also the cheapest. Whichever listing has the single
     highest total gets a border — gold if that total includes the price
     star (it's the cheapest one), green if it doesn't (it won purely on
     mods). A tie for the highest total gets no border for anyone, same
     as a tie on mod-stars alone always has — folding price into the same
     count this way is also what makes an existing mod-star tie resolve
     on its own once one of the tied listings is also the cheapest (its
     total ends up one higher than the others'), with no separate
     tie-break rule needed for that case specifically. */
  /* An unidentified listing is never eligible to WIN this border — per an
     explicit ask, it has nothing real to compare (no explicit mods at
     all, see identifiedMembers in openCompareModal), so even a "win" that
     only came from its price star (it happens to be cheapest, with every
     real mod-comparing listing sitting at zero) would be rewarding an
     empty comparison rather than an actual best item. Excluded from the
     candidate pool entirely instead of just never accumulating mod
     stars — otherwise, being the sole cheapest listing among several
     identified ones with no mod stars of their own would still let it win
     on the strength of the price star alone. cheapestIds itself is
     untouched (an unidentified listing can still be flagged cheapest for
     its own price-pill star — just never for this). */
  function compareColumnBorder(members, starCounts, cheapestIds) {
    const totals = new Map();
    for (const listing of members) {
      totals.set(listing.id, (starCounts.get(listing.id) ?? 0) + (cheapestIds.has(listing.id) ? 1 : 0));
    }
    const candidates = members.filter((l) => !l.unidentified);
    const maxTotal = Math.max(0, ...candidates.map((l) => totals.get(l.id) ?? 0));
    const winners = maxTotal > 0 ? candidates.filter((l) => totals.get(l.id) === maxTotal) : [];
    const winnerId = winners.length === 1 ? winners[0].id : null;

    return (listing) => {
      if (listing.id !== winnerId) return null;
      return cheapestIds.has(listing.id) ? "gold" : "green";
    };
  }

  /* Whether every listing carrying a given EXPLICIT mod (see the kind
     filter below — implicits/enchants/crafted never take part in either
     of compareModCell's two comparison treatments, per an explicit ask)
     has it at the exact same value, including "no value at all" (a flag/
     boolean affix) counting as a match only when every carrier likewise
     has none — feeds rule A there: a mod present with an identical value
     on literally every compared item gets a green border, as opposed to
     rule B's star for a mod that's shared but genuinely varies. Counts
     each distinct mod once per listing (same dedup as modShareCounts)
     so a listing that somehow carries the same mod twice can't register
     a false "differs" against itself. */
  function modUniformValues(members) {
    return entryUniformValues(members, (l) => l.mods ?? [], modKey, (mod) => typeof mod === "object" && mod.kind === "explicit");
  }

  /* mod.kind === "pseudo" is the real signal (see modLines) — the
     affix==null fallback stays alongside it only for listings saved
     before that class was captured, whose pseudo mods have no kind at
     all. Shared by orderModsForDisplay (which group a mod sorts into),
     groupedModNodes (which group it renders into, and where the divider
     between groups goes), and modLineNode/compareModCell (how it's
     colored) — pulled into one place rather than three copies of the
     same fallback condition drifting apart from each other. */
  function isPseudoMod(mod) {
    return typeof mod === "object" && (mod.kind === "pseudo" || (mod.kind == null && mod.affix == null));
  }

  /* A listing's own mods, reordered for display — real implicits first,
     then every prefix, then every suffix, confirmed live as the order
     GGG's own item popup itself displays them in, with prefixes and
     suffixes further split into two clearly separate halves (prefix
     block, then suffix block) rather than left interleaved in roll
     order — and the "total"/pseudo summary lines GGG shows dimmed at the
     very bottom (no tier code of their own — see parseModAffix) trail
     last here too, rather than competing for attention with the real
     tiered affixes above them, in their own group with their own divider
     (see groupedModNodes) rather than lumped in with prefix/suffix as an
     earlier version had it — per an explicit ask, pseudo needs to read as
     clearly its own thing, not just "whatever's left after prefix/
     suffix." Stable within each group (ties keep their original order)
     since there's nothing more meaningful to break a tie by once every
     mod gets its own line instead of sharing a row. */
  function orderModsForDisplay(mods) {
    function rank(mod) {
      if (typeof mod !== "object") return 3;
      if (mod.kind === "implicit") return 0;
      if (isPseudoMod(mod)) return 3;
      if (mod.affix?.type === "prefix") return 1;
      if (mod.affix?.type === "suffix") return 2;
      return 3;
    }
    return mods.map((mod, i) => ({ mod, i })).sort((a, b) => rank(a.mod) - rank(b.mod) || a.i - b.i).map((x) => x.mod);
  }

  /* One mod line — tier code (if any) + text, colored the same way the
     compare modal's own mod lines are (reuses its CSS classes rather than
     a parallel set, so the two stay visually consistent) — pulled out on
     its own since listingRow needs the same single-mod rendering the
     compare modal builds inline in its per-column loop, without any of
     that loop's click-to-sort/shared-highlight logic a lone listing has
     no other listing to compare against for. */
  /* The roll's own possible bounds, compact — "(55-64)" — as its own
     trailing element rather than appended into the mod's own text, so
     every mod line's range lands in the same right-aligned column (see
     .ph-compare-mod-range) instead of trailing wherever that particular
     line's own text happens to end. Always rendered, even as an empty
     span for a mod with no range, so that column's width stays reserved
     consistently down the whole list rather than only appearing on rows
     that happen to have one. Collapses to a single "(25)" rather than
     "(25-25)" when there's no real spread — the second number adds
     nothing once it's identical to the first. Hovering it (when there's
     a real range) shows the fuller quality-bar picture — see
     wireModRangeHover. */
  /* Gated on `value` (parsed from the mod's own text — see modLines), not
     just `range` (GGG's own roll-range widget) — a flag/boolean affix like
     "Your Elemental Damage can Shock" has no number anywhere in its own
     text, but GGG's popup still renders a fixed "[1]" range indicator next
     to it (evidently a UI artifact of always-on mods, not a real
     magnitude), which showed up here as a meaningless "(1)" per an
     explicit report. If the text itself has nothing to roll, there's
     nothing worth displaying a range for. Collapses to a single "(25)"
     rather than "(25-25)" when there's no real spread — the second number
     adds nothing once it's identical to the first. */
  function modRangeText(mod) {
    const isObj = typeof mod === "object";
    const range = isObj && mod.value != null ? mod.range : null;
    return range ? (range.min === range.max ? `(${range.min})` : `(${range.min}-${range.max})`) : "";
  }

  function modRangeNode(mod) {
    const isObj = typeof mod === "object";
    const range = isObj && mod.value != null ? mod.range : null;
    const quality = modQuality(mod);
    const qualityClass = quality === 0 ? " ph-compare-mod-range-min" : quality === 100 ? " ph-compare-mod-range-max" : "";
    /* title: "" overrides the enclosing compareModCell's own "Click to
       sort..." native tooltip (browsers otherwise walk up to the nearest
       ancestor with a title attribute) — without it, hovering this badge
       to see wireModRangeHover's own popup showed GGG's native tooltip
       stacked on top of it, blocking the bar/label per a real report. */
    const span = el("span", { class: `ph-compare-mod-range${qualityClass}`, text: modRangeText(mod), title: "" });
    if (range) wireModRangeHover(span, mod);
    return span;
  }

  /* An invisible twin of modRangeNode's own output, placed on the
     opposite side of an implicit line's centered text (see modLineNode/
     compareModCell) — the range badge's real width isn't knowable in
     advance (a flag mod has none at all, others run "(25)" to "(90-100)"),
     so mirroring its actual rendered content is what lets both flanks end
     up the same width and the text land on the row's true center, rather
     than centering the text+badge pair as one unit (which visibly pulled
     the text left of center by roughly half the badge's own width once
     seen live). visibility: hidden keeps its layout space without
     painting it or letting it receive hover/clicks. */
  function modRangeMirrorNode(mod) {
    return el("span", { class: "ph-compare-mod-range ph-compare-mod-range-mirror", text: modRangeText(mod), "aria-hidden": "true" });
  }

  function modLineNode(mod) {
    const isObj = typeof mod === "object";
    const kindClass = modKindClass(mod);
    const text = isObj ? mod.text : mod;
    const textSpan = el("span", { class: `ph-compare-mod-text ${kindClass}`.trim(), text });
    const isImplicit = isObj && mod.kind === "implicit";

    /* Centered rather than left-aligned like every other mod line — per
       an explicit ask, to set the implicit(s) further apart from the
       tiered prefix/suffix block below (already visually separated by
       the gold divider — see groupedModNodes — this centers the line
       itself too, the same way a lone Corrupted/Unidentified line reads
       as its own thing rather than part of the list). Only ever one or
       two lines, never a long scannable column, so losing left-alignment
       here doesn't cost anything the way it would for prefix/suffix.
       modRangeMirrorNode balances the real range badge on the opposite
       side — see the note above it for why the text needs that to
       actually land on center. Implicits never carry mod.affix (they
       aren't tiered prefix/suffix affixes), so this slot is otherwise
       always empty for them anyway. */
    return el("div", { class: `ph-item-mod-line ${isImplicit ? "ph-mod-implicit" : ""}`.trim() },
      isImplicit
        ? modRangeMirrorNode(mod)
        : isObj && mod.affix
          ? el("span", { class: `ph-compare-mod-code ph-compare-mod-code-${mod.affix.type}`, text: mod.affix.code })
          : null,
      textSpan,
      modRangeNode(mod)
    );
  }

  /* A listing's mods (see orderModsForDisplay for the order), split into
     three visually separate sections, each its own group with a divider
     between it and the next — implicits, then the real tiered affixes
     (prefix/suffix), then pseudo "total" summary lines last. An earlier
     version lumped pseudo in with prefix/suffix as "everything that isn't
     implicit," on the theory its own dim color already set it apart
     enough — per an explicit correction, pseudo needs a real divider of
     its own too, not just a color difference, to read as clearly its own
     category rather than part of the tiered-affix block. Membership is
     decided by isPseudoMod directly here (not just orderModsForDisplay's
     own rank), so a mod's group and its color (see modLineNode/
     compareModCell, which use the same isPseudoMod) can never disagree
     with each other. Only groups that actually have something in them
     get rendered, each with a divider before it except the first — a
     listing with no implicits and no pseudo lines just gets one plain
     group, no dividers at all. `renderMod` builds one mod's own line —
     modLineNode's plain version for a lone listing, or the compare
     modal's own clickable/shared-highlighted version — so both places
     get the same section structure without duplicating this grouping
     logic. */
  function groupedModNodes(mods, renderMod) {
    const ordered = orderModsForDisplay(mods);
    const implicits = ordered.filter((m) => typeof m === "object" && m.kind === "implicit");
    const pseudos = ordered.filter((m) => isPseudoMod(m) && !implicits.includes(m));
    const explicit = ordered.filter((m) => !implicits.includes(m) && !pseudos.includes(m));

    const nodes = [];
    for (const group of [implicits, explicit, pseudos]) {
      if (!group.length) continue;
      if (nodes.length) nodes.push(el("hr", { class: "ph-item-divider" }));
      nodes.push(el("div", { class: "ph-item-mod-group" }, group.map(renderMod)));
    }
    return nodes;
  }

  function itemModsBlock(mods) {
    return el("div", { class: "ph-item-mods" }, groupedModNodes(mods, modLineNode));
  }

  /* Columns are the listings in `members` (whichever set the Compare
     button's own count reflects: respects an active filter and the
     group's own sort, not always the group's full membership); each
     column lists only that listing's own mods (see orderModsForDisplay),
     not a shared row grid every column gets a cell in whether or not it
     has that mod — an earlier version did that spreadsheet-style, and
     with items that only share a handful of mods it was mostly "—"
     placeholder cells just to keep unrelated rows aligned across columns,
     more visual noise than the alignment was worth. A mod that recurs
     across 2+ of the compared listings gets highlighted instead (see
     modShareCounts) — the "this is worth comparing" signal moved from
     row position to a highlight, which still works with every column
     having a different number of mods.

     Clicking a mod with a real rolled value AND an actual spread to it
     (see compareModCell's own `hasRange` — a fixed, never-varying value
     like "Gain 700% of Weapon Physical Damage..." has a value but
     nothing meaningful to sort by) sorts the *columns* by that same
     stat, descending (highest roll first) on the first click; click it
     again for ascending, or a different mod to switch to that stat —
     same toggle shape as every other price sort in this file, just keyed
     by stat id instead of price, and it still highlights that stat
     wherever it appears since the match is by id, not by row. Re-renders
     the whole table in place (renderTable), not a full modal rebuild, so
     it doesn't flash or lose scroll position.

     A listing's own properties/additionalStats (Item Level, Physical
     Damage, DPS, ...) get the exact same rule-B star/glow and click-to-
     sort restriction as mods (see comparePropertyCell, propShareCounts/
     propBestValues/propUniformValues/propStarCounts) — a property has no
     roll-range concept of its own the way a mod does, so "nothing to
     compare" here means carried by fewer than 2 of the compared listings,
     or identical on every one that has it, rather than a fixed range.
     Properties never get rule A's own dimmed treatment (not asked for),
     just the restriction and the star. A property's own star counts
     toward the same whole-column border total a mod's star does (see
     compareColumnBorder) — the border doesn't care which of the two
     kinds actually earned a listing its win. */
  function openCompareModal(entry, members, folders) {
    closeCompareModal();

    const backdrop = el("div", { class: "ph-compare-backdrop" });
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeCompareModal(); });

    /* All of this is recomputed by recomputeDerived (defined below) every
       time `members` itself changes — removing a listing from the
       compare (see removeFromCompare) can change who's cheapest, what
       counts as "shared", and who has the most stars, so these can't
       stay frozen at whatever they were when the modal first opened. */
    let shareCounts, bestValues, uniformValues, modStars;
    let propShares, propBests, propUniforms, propStars;
    let starCounts, cheapestIds, columnBorderFor;
    /* An unidentified listing has no explicit mods to compare at all
       (only whatever implicit(s) are genuinely visible unidentified), so
       counting it toward "how many listings share this mod/property" or
       "is this identical across every compared item" would make an
       otherwise-universal match look partial just because one column
       structurally can't carry it — the exact bug a real screenshot
       showed (a mod every IDENTIFIED listing shared losing its dim/star
       treatment solely because one column was unidentified). Excluded
       from every share/best/uniform/star computation; still rendered as
       its own column via the full `members` list elsewhere, and still
       eligible for the cheapest-price star (cheapestIds,
       compareColumnBorder) — per an explicit ask, the one thing an
       unidentified listing can still earn. Hoisted alongside the other
       derived state (not local to recomputeDerived) since compareModCell/
       comparePropertyCell also need its own length — a mod/property
       shared by every IDENTIFIED listing must compare its share count
       against identifiedMembers.length, not members.length, or an
       unidentified column in the compare would make a real 100% match
       among the rest look partial. */
    let identifiedMembers;

    function recomputeDerived() {
      identifiedMembers = members.filter((l) => !l.unidentified);

      shareCounts = modShareCounts(identifiedMembers);
      bestValues = modBestValues(identifiedMembers);
      uniformValues = modUniformValues(identifiedMembers);
      modStars = modStarCounts(identifiedMembers, shareCounts, bestValues, uniformValues);

      propShares = propShareCounts(identifiedMembers);
      propBests = propBestValues(identifiedMembers);
      propUniforms = propUniformValues(identifiedMembers);
      propStars = propStarCounts(identifiedMembers, propShares, propBests, propUniforms);

      /* A listing's total star count for the whole-column border feeds
         off both mods and properties — a property that's the highest of
         several differing ones (see comparePropertyCell) counts toward
         the same tally a mod's own star does, per an explicit ask,
         rather than being tracked as some separate, parallel signal.
         Built from the full `members` list (not identifiedMembers) so an
         unidentified listing still gets a real (zero) entry rather than
         an undefined one — it just can never have earned any stars to
         begin with, having been excluded above. */
      starCounts = new Map(members.map((l) => [l.id, (modStars.get(l.id) ?? 0) + (propStars.get(l.id) ?? 0)]));
      cheapestIds = cheapestListingIds(members);
      columnBorderFor = compareColumnBorder(members, starCounts, cheapestIds);
    }
    recomputeDerived();

    /* One shared sort state for both mods and properties — GGG's own
       trade site lets you sort by any of an item's stat columns, not
       just its mods, so the compare modal's click-to-sort now covers
       .item-property/.itemPopupAdditional entries too (see
       comparePropertyCell), not only mods (compareModCell). kind keeps
       the two id spaces apart (a property's short "ev"/"ar"-style
       data-field could otherwise collide with a mod's own stat id, even
       though none has been seen to in practice). */
    let sort = null; // { kind: "mod" | "prop", id, dir: "asc" | "desc" } | null
    let order = members;

    function sortValueFor(listing) {
      if (!sort) return null;
      return sort.kind === "mod" ? modValueFor(listing, sort.id) : propValueFor(listing, sort.id);
    }

    function applySort(kind, id, { defaultDir = "desc" } = {}) {
      /* First click on a new column sorts descending — highest roll
         first, per an explicit ask, rather than ascending — a click
         toggles from there same as before. defaultDir lets a caller
         invert that for a property where lower is actually better (see
         comparePropertyCell's own isSpecial gate) rather than hardcoding
         "highest first" as universally correct. */
      sort = sort?.kind === kind && sort.id === id
        ? { kind, id, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { kind, id, dir: defaultDir };
      order = [...members].sort(priceComparator(sort.dir, sortValueFor));
      renderTable();
    }

    /* Removes a listing from Saved entirely (not just from this compare
       view) — per an explicit ask for a per-card remove button, the same
       destructive-immediately behavior the Saved tab's own trash icon
       already has (no confirm, matching that established precedent).
       PH.panel.refresh() updates the Saved tab underneath; this modal is
       its own overlay appended straight to document.body (see the bottom
       of this function), so refreshing the panel doesn't touch it — the
       table here is re-rendered separately, from the shrunken `members`.
       Comparing fewer than 2 items isn't meaningful, so the whole modal
       closes instead once removal would leave just one. */
    async function removeFromCompare(listing) {
      await PH.store.deleteSavedListing(listing.id);
      PH.panel.refresh();

      members = members.filter((m) => m.id !== listing.id);
      if (members.length < 2) { closeCompareModal(); return; }

      order = order.filter((m) => m.id !== listing.id);
      recomputeDerived();
      renderTable();
    }

    const table = el("div", { class: "ph-compare-table" });

    /* A 3-row CSS grid (grid-auto-flow: column — see panel.css), not the
       flex row of self-contained columns this used to be: each listing
       contributes a header cell (row 1), a mods cell (row 2), and a
       footer cell (row 3, just the Find Item button) as flat siblings,
       not a wrapper div around all three. Grid sizes each *row* to its
       tallest cell regardless of the others' content, which is what
       actually fixes a real, screenshotted problem — the property block
       ending at a different height in every column meant the mods below
       it started at visibly different depths, misaligned in a way that
       had nothing to do with the earlier "—" placeholder-row problem
       this whole per-column layout was originally built to fix (see the
       note above .ph-compare-table). Grid solves both at once: row 1
       (headers) stretches every column's header to the same height, so
       the boundary into row 2 lines up; row 2 (mods) is sized to
       whichever column has the most mods, but a shorter column just gets
       blank space at the bottom of its own cell — never a placeholder
       row inserted *between* real mod lines, which is what actually made
       the earlier grid read as full of gaps; row 3 then lands at a
       consistent height below that for every column regardless. */
    function renderTable() {
      table.replaceChildren();

      for (const listing of order) {
        const history = listing.priceHistory ?? [];
        const latest = history.at(-1);
        const priceText = latest ? formatPrice(latest) : listing.price;

        /* "gold" | "green" | null — see compareColumnBorder. Applied to
           all three of this column's own cells (not just the header) so
           it reads as one bordered card despite the three being flat
           grid siblings, not a wrapper div (see the note above this
           function for why there's no wrapper to just put a border on
           directly). */
        const borderTier = columnBorderFor(listing);
        const borderClass = borderTier ? `ph-compare-col-${borderTier}` : "";

        const header = el("div", { class: `ph-compare-col-header ${borderClass}`.trim() },
          /* Removes this listing from Saved entirely, not just from this
             compare view — see removeFromCompare above. Positioned over
             the header's own top-right corner rather than taking a row
             of its own, the same way the modal's own close button sits
             in its header. */
          PH.ui.iconButton("×", {
            class: "ph-compare-remove-btn",
            title: "Remove this listing from Saved",
            onClick: () => removeFromCompare(listing),
          }),
          listing.icon ? el("img", { class: "ph-compare-icon", src: listing.icon, alt: "" }) : null,
          el("div", {
            class: `ph-compare-title ${listing.rarity ? `ph-rarity-${listing.rarity}` : ""}`.trim(),
            text: listing.title || "Untitled item",
          }),
          /* The weapon class line ("Two Handed Axe", ...) — see
             itemClassText — right under the name, same as a lone
             listing's own card. */
          itemClassText(listing) ? el("div", { class: "ph-item-class-line", text: itemClassText(listing) }) : null,
          priceText
            ? el("div", { class: "ph-compare-price" },
                listing.priceIcon ? el("img", { class: "ph-saved-price-icon", src: listing.priceIcon, alt: "" }) : null,
                el("span", { text: priceText }),
                /* The cheapest of the compared listings — see
                   cheapestListingIds. Ties (an exact same chaos-
                   equivalent price) all get it, same as a tied mod
                   value all getting compareModCell's own star — UNLESS
                   the tie spans every listing being compared, per an
                   explicit ask: a star every single column earns is no
                   longer a "cheapest" signal, just noise (the same
                   reasoning Rule A already applies to a mod shared,
                   identical, by everyone — see isUniformMatch). Still
                   counted toward columnBorderFor/starCounts either way
                   (that reads cheapestIds directly, not this gate) — the
                   price star's absence here is purely visual; an
                   all-tied price still keeps its column eligible for the
                   gold/green border off whatever real mod stars it has. */
                cheapestIds.has(listing.id) && cheapestIds.size < members.length
                  ? el("span", { class: "ph-compare-price-star", title: "Cheapest of the compared items", text: "★" })
                  : null
              )
            : null,
          listing.unidentified ? el("span", { class: "ph-saved-unidentified", text: "Unidentified" }) : null,
          listing.corrupted ? el("div", { class: "ph-saved-corrupted", text: "Corrupted" }) : null,
          ...itemPropertyBlocks(listing, (prop) => comparePropertyCell(prop, listing))
        );

        /* Same implicit/divider/rest grouping a lone listing's own card
           gets (see groupedModNodes/itemModsBlock) — an earlier version of
           this rendered its mod list as one flat, undivided run, which is
           what left a column reading as an undifferentiated block of text
           with nothing marking where implicit ends and explicit begins. */
        const modsBlock = el("div", { class: `ph-item-mods ph-compare-mods-cell ${borderClass}`.trim() }, groupedModNodes(excludeEnchantMods(listing.mods), compareModCell));

        /* Same "Search this exact item"/Bookmark actions a saved listing's
           own toolbar has (see rebuildSearch/bookmarkButton), just
           reachable from inside the compare modal too, one per column,
           rather than having to close the modal to find them on the
           listing itself. */
        const footer = el("div", { class: `ph-compare-col-footer ${borderClass}`.trim() },
          button("Find Item", {
            title: "Search the trade site directly for this item's name and rolled mods\nGGG rate-limits this strictly, so repeated clicks in quick succession will get refused or blocked",
            onClick: () => rebuildSearch(listing),
          }),
          bookmarkButton(listing, folders)
        );

        table.append(header, modsBlock, footer);
      }
    }

    /* One mod's own cell within the compare modal specifically — code +
       text + roll-quality bar like modLineNode's plain version, plus the
       click-to-sort behavior and two, mutually exclusive comparison
       treatments a lone listing's own card has no other listing to need
       those for. Both are EXPLICIT-mod-only, per an explicit ask —
       implicits, enchants, and crafted mods never take part in either,
       regardless of whether they match or vary:

         Rule A — a mod present, at the exact same value, on literally
         every one of the compared columns gets a plain green
         (#7fd88f) border around the whole cell: "identical everywhere,
         nothing to compare." See modUniformValues.

         Rule B — a mod shared by 2+ columns whose values genuinely
         differ gets a small green star on whichever column(s) tie for
         the highest value: "this one rolled best." See modBestValues.
         Never fires alongside rule A (isUniformMatch already covers the
         "all tied" case with a border instead).

       Reads sort/order from openCompareModal's own enclosing scope, same
       as renderTable itself does. */
    function compareModCell(mod) {
      const isObj = typeof mod === "object";
      const id = isObj ? mod.id : null;
      /* Not sortable when there's nothing to actually sort by — a mod
         whose rolled range is fixed (min === max, e.g. "Gain 700% of
         Weapon Physical Damage..." always rolling exactly 700, the same
         "nothing to compare" case modRollQuality already treats as
         meaningless) has a `value` but no real spread, so clicking it
         would just reorder columns by a number that's identical on every
         copy of that mod anyway. Requires `mod.range` to exist at all
         too — a dual-range mod ("Adds 45 to 75 Physical Damage") has a
         genuinely rolled value but no captured range (see parseModRoll,
         which explicitly skips " to " text), so it already shows no
         range badge either (modRangeNode) — staying non-clickable here
         is the same "don't guess" limitation extended consistently,
         not a new one. */
      const hasRange = isObj && mod.range != null && mod.range.min !== mod.range.max;
      const clickable = isObj && mod.value != null && hasRange;
      const isActive = id && sort?.kind === "mod" && sort.id === id;
      const arrow = isActive ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
      const modText = `${isObj ? mod.text : mod}${arrow}`;
      const key = modKey(mod);
      const count = shareCounts.get(key) ?? 0;
      const isExplicit = isObj && mod.kind === "explicit";
      const hasValue = isObj && mod.value != null;

      /* identifiedMembers.length, not members.length — shareCounts/
         uniformValues were computed over identified listings only (see
         recomputeDerived), so "shared by everyone" has to mean everyone
         who could actually carry the mod, not literally every column
         including an unidentified one that structurally can't. */
      const isUniformMatch = isExplicit && count === identifiedMembers.length && uniformValues.get(key) === true;
      const isTopValue = isExplicit && !isUniformMatch && count >= 2 && hasValue && mod.value === bestValues.get(key);
      const kindClass = modKindClass(mod);
      const isImplicit = isObj && mod.kind === "implicit";

      const textSpan = el("span", { class: `ph-compare-mod-text ${kindClass}`.trim(), text: modText });

      return el("div", {
        class: [
          "ph-compare-cell",
          /* Same centering as modLineNode's own implicit line, for the
             same reason — see the note there. */
          isImplicit ? "ph-mod-implicit" : "",
          clickable ? "ph-compare-mod-clickable" : "",
          isActive ? "ph-compare-mod-active" : "",
          /* Rule B (highest of several differing values) gets both a
             star AND a bright glow — the more noteworthy of the two
             rules, so it earns the stronger treatment. Rule A (identical
             everywhere) gets a plain dulled text color instead — no
             glow, no star — since a shared, unremarkable mod is the
             common case in a real compare, and giving it any of the
             brighter signals competed with rule B's own for attention
             when the two aren't equally noteworthy. */
          isTopValue ? "ph-compare-mod-glow" : "",
          isUniformMatch ? "ph-compare-mod-dim" : "",
        ].filter(Boolean).join(" "),
        title: clickable
          ? "Click to sort every column by this modifier"
          : isUniformMatch ? "Identical across every compared item"
          : isTopValue ? "Highest roll among compared items"
          : null,
        onclick: clickable ? () => applySort("mod", id) : null,
      },
        /* GGG's own compact code (e.g. "P1", "S4", or a compound
           "P2 + P1" — see parseModAffix) in place of the earlier
           separate "PREFIX"/"SUFFIX"/"TIER N" tags — same information,
           one short label instead of three, colored by affix type so
           prefix vs suffix still reads at a glance down the column.
           An implicit never carries mod.affix (not a tiered prefix/
           suffix), so this slot is free for modRangeMirrorNode instead —
           see the note above it for why the text needs that to actually
           land on center rather than the text+badge pair together. */
        isImplicit
          ? modRangeMirrorNode(mod)
          : isObj && mod.affix
            ? el("span", { class: `ph-compare-mod-code ph-compare-mod-code-${mod.affix.type}`, text: mod.affix.code })
            : null,
        textSpan,
        /* Rule B's own star, right before the range badge rather than
           inside the (fixed-width, right-aligned) range column itself —
           a star sized to fit that column would read cramped next to a
           number it's not actually part of. */
        /* Gold + drop-shadow instead of the usual plain green when this
           same mod is ALSO a max roll (see modRangeNode/modQuality) — per
           an explicit ask, a top-value star that happens to be maxed out
           on its own range deserves a stronger, distinct treatment from
           an ordinary "highest of what's here" star. */
        isTopValue ? el("span", { class: `ph-compare-mod-star${modQuality(mod) === 100 ? " ph-compare-mod-star-max" : ""}`, title: "Highest roll among compared items", text: "★" }) : null,
        modRangeNode(mod)
      );
    }

    /* A property/additionalStats entry's own cell — plain text, click-to-
       sort when it carries a real value (see propValueFor), the same
       behavior GGG's own trade site offers for its stat columns and
       compareModCell already gives mods. No code badge or quality bar —
       those are mod-specific (affix tier, roll range) and don't apply to
       a property at all. */
    function comparePropertyCell(prop, listing) {
      const key = propKey(prop);
      const shareCount = propShares.get(key) ?? 0;
      /* identifiedMembers.length — see the same note on compareModCell's
         own isUniformMatch. A property is visible on every listing
         regardless of identification status (unlike explicit mods), so
         this mostly matters for consistency with the mod-side check
         rather than fixing a live bug on the property side specifically. */
      const isUniform = shareCount === identifiedMembers.length && propUniforms.get(key) === true;
      /* Same "nothing to compare" gate compareModCell's own `hasRange`
         enforces for mods, adapted for a property's own lack of any
         roll-range concept — real, cross-listing agreement/disagreement
         is the only signal available here, so a property carried by
         fewer than 2 listings, or identical on every listing that has
         it, isn't sortable or starrable either. */
      const hasVariability = shareCount >= 2 && !isUniform;
      /* Intangibility is a negative stat — a *higher* roll is worse, not
         better — so "highest value gets a star" (isTopValue below) would
         be actively wrong for it, per an explicit ask. Left clickable and
         sortable like any other property (there's real value in sorting
         by it), just never starred/glowed and never counted toward the
         column border total (see propStarCounts), and defaulting to an
         ascending first click — lowest (best) first — rather than the
         descending-first every other property/mod uses. */
      const isSpecial = SPECIAL_PROPERTIES.test(prop.text);
      const clickable = prop.value != null && prop.id != null && hasVariability;
      /* !listing.unidentified — propBests/propUniforms only ever reflect
         identified listings (see identifiedMembers), but an unidentified
         listing's OWN property line still renders through this same
         function and could coincidentally match that best value on its
         own merits (e.g. its Physical Damage happening to equal the
         identified listings' best) — this stops it from earning a star
         it was never a real candidate for, per an explicit ask that an
         unidentified listing can only ever earn the cheapest-price star,
         nothing else. */
      const isTopValue = !isSpecial && !listing.unidentified && hasVariability && prop.value === propBests.get(key);
      const isActive = sort?.kind === "prop" && sort.id === prop.id;
      const arrow = isActive ? (sort.dir === "asc" ? " ▲" : " ▼") : "";

      return el("div", {
        class: [
          "ph-item-property-line",
          "ph-compare-property-cell",
          clickable ? "ph-compare-mod-clickable" : "",
          isActive ? "ph-compare-mod-active" : "",
          /* Same rule-B treatment mods get — see the note above
             compareModCell's own class list. */
          isTopValue ? "ph-compare-mod-glow" : "",
        ].filter(Boolean).join(" "),
        title: clickable
          ? "Click to sort every column by this property"
          : isTopValue ? "Highest value among compared items"
          : null,
        text: `${prop.text}${arrow}`,
        onclick: clickable ? () => applySort("prop", prop.id, { defaultDir: isSpecial ? "asc" : "desc" }) : null,
      },
        isTopValue ? el("span", { class: "ph-compare-mod-star", title: "Highest value among compared items", text: "★" }) : null
      );
    }

    renderTable();

    const modal = el("div", { class: "ph-compare-modal" },
      el("div", { class: "ph-compare-head" },
        el("span", { class: "ph-compare-heading", text: `Compare — ${entry.title}` }),
        PH.ui.iconButton("×", { title: "Close", onClick: () => closeCompareModal() })
      ),
      table
    );

    backdrop.append(modal);
    document.body.append(backdrop);
    openCompareBackdrop = backdrop;
    document.addEventListener("keydown", onCompareModalKeydown);
  }

  function clearToolbar(forThisGame) {
    const selectedCount = forThisGame.filter((l) => selected.has(l.id)).length;

    return el("div", { class: "ph-toolbar-row" },
      button("Clear all", {
        class: "ph-btn ph-btn-danger",
        onClick: () => setEditing({ kind: "clear-all" }),
      }),
      button(selectedCount ? `Clear selected (${selectedCount})` : "Clear selected", {
        class: `ph-btn ph-btn-danger ${selectedCount ? "" : "ph-btn-disabled"}`.trim(),
        onClick: async () => {
          if (!selectedCount) { toast("Check a few listings first.", { error: true }); return; }
          const ids = forThisGame.filter((l) => selected.has(l.id)).map((l) => l.id);
          await PH.store.deleteSavedListings(ids);
          ids.forEach((id) => selected.delete(id));
          PH.panel.refresh();
        },
      })
    );
  }

  /* "Bookmark" — takes a listing's own search (see listing.location, the
     search that found it, captured the same way at save time as Bookmarks'
     own {version, type, slug} reference) and files it into a Bookmarks
     folder you pick from a menu, so revisiting that same search later
     (any listing it turns up, not just this one) is one click away from
     the Bookmarks tab too. Deliberately files the *search*, never this
     listing's own price/mods/seller — a bookmark stores no listing data
     by design (see location.js: a bookmark keeps no league, only
     {version, type, slug}, so it survives a league reset; a saved
     listing keeps a league because it's a record of a specific past
     moment, not a reusable search), so this is genuinely creating a
     Bookmarks trade, not a second copy of the saved listing. Returns
     null (no button) for a listing with nothing to file
     — saved before location existed, or from a game version whose
     folders aren't offered here since none would match anyway.

     `folders` is fetched once by the caller (render/openCompareModal),
     not re-fetched per button, since opening this menu shouldn't need
     its own storage round-trip every time. */
  function bookmarkButton(listing, folders, { iconOnly = false } = {}) {
    if (!listing.location?.type || !listing.location?.slug) return null;

    const version = listing.location.version ?? "1";
    const matching = (folders ?? []).filter((f) => (f.version ?? "1") === version && !f.archivedAt);

    /* Icon-only (listingRow's own toolbar, condensed to a single row of
       icon buttons per an explicit ask) vs. plain text (the compare
       modal's footer, matching Find Item's own plain-text style right
       next to it — no icon there, per a direct correction). */
    const trigger = iconOnly
      ? PH.ui.iconButton(PH.ui.icon("bookmark"), { title: "File this listing's search into a Bookmarks folder" })
      : button("Bookmark", { title: "File this listing's search into a Bookmarks folder" });

    return PH.ui.menu(
      matching.length
        ? matching.map((folder) => ({
            label: folder.title,
            onClick: async () => {
              const saved = await PH.store.saveTrade(folder.id, {
                title: listing.title || "Untitled item",
                location: listing.location,
              });
              toast(saved ? `Bookmarked to ${folder.title}` : "That folder no longer exists.", { error: !saved });
            },
          }))
        : [{ label: "No folders yet — create one in Bookmarks first", onClick: () => {} }],
      { trigger }
    );
  }

  function listingRow(listing, context) {
    const league = listing.league ?? PH.location.resolveLeague(listing.location ?? {}, context);
    const url = listing.location ? PH.location.buildUrl(listing.location, league) : null;

    /* dataset.listingId is what wireGroupDrag's event delegation matches
       against. draggable: "true" (the actual string, not the boolean —
       HTML's draggable attribute only means yes when its value is
       literally "true") makes the whole row itself the drag handle,
       rather than a separate grip element. */
    const row = el("div", {
      class: "ph-saved-row",
      dataset: { listingId: listing.id },
      draggable: "true",
    });
    const body = el("div", { class: "ph-saved-body" });
    if (listing.icon) row.append(el("img", { class: "ph-saved-icon", src: listing.icon, alt: "" }));

    /* priceHistory only exists on listings saved (or re-priced via "Search
       this exact item") since it was added — older ones just have the
       plain price string from when they were saved, with nothing to
       compare it against. */
    const history = listing.priceHistory ?? [];
    const latest = history.at(-1);
    const priceText = latest ? formatPrice(latest) : listing.price;

    const priceBadge = priceText
      ? el("span", { class: "ph-saved-price", title: "" },
          listing.priceIcon ? el("img", { class: "ph-saved-price-icon", src: listing.priceIcon, alt: "" }) : null,
          el("span", { text: priceText })
        )
      : null;

    if (priceBadge && history.length > 1) {
      /* Same .ph-hover-grid table Bookmarks uses for its own price history
         — one flat grid (not a wrapper div per row) so time/price/diff
         columns line up; each entry contributes exactly 3 children (a
         placeholder <span> when there's no predecessor to diff against). */
      const cells = history.map((entry, i) => {
        const prev = i > 0 ? history[i - 1] : null;
        const diff = prev ? chaosDelta(prev, entry) : null;
        return [
          el("span", { class: "ph-hover-time", text: timeAgo(entry.capturedAt) }),
          el("span", { class: "ph-hover-price", text: formatPrice(entry) }),
          diff
            ? el("span", { class: `ph-hover-diff ph-hover-diff-${diff > 0 ? "up" : "down"}`, text: formatChaosDelta(diff, listing.location?.version) })
            : el("span"),
        ];
      }).reverse().flat();

      PH.ui.hoverPopup(priceBadge, [el("div", { class: "ph-hover-grid" }, cells)], { title: "Price history" });
    }

    body.append(el("div", { class: "ph-saved-head" },
      el("input", {
        type: "checkbox",
        class: "ph-saved-check",
        title: "Select for Clear selected",
        checked: selected.has(listing.id),
        onchange: (e) => toggleSelected(listing.id, e.target.checked),
      }),
      el("span", {
        class: `ph-saved-title ${listing.rarity ? `ph-rarity-${listing.rarity}` : ""}`.trim(),
        text: listing.title || "Untitled item",
      }),
      priceBadge
    ));

    /* The weapon class line ("Two Handed Axe", ...) — see itemClassText —
       right under the name, the same position GGG's own popup shows it
       in, not mixed into the property block below (which itemPropertyBlocks
       already excludes it from). null (nothing rendered) for anything
       that isn't a weapon, or a listing saved before properties existed. */
    const classText = itemClassText(listing);
    if (classText) body.append(el("div", { class: "ph-item-class-line", text: classText }));

    /* listedAt (when the trade site says the item was listed) rather than
       savedAt (when you clicked Save Listing) — listings saved before
       listedAt existed fall back to savedAt, the only time they have. */
    const metaBits = [listing.seller, PH.location.displayLeague(league), timeAgo(listing.listedAt ?? listing.savedAt)].filter(Boolean);
    body.append(el("div", { class: "ph-saved-meta", text: metaBits.join(" · ") }));

    if (listing.unidentified) {
      body.append(el("span", { class: "ph-saved-unidentified", text: "Unidentified" }));
    }

    /* Same spot the compare modal's own header puts it — right after
       price/Unidentified, before the property blocks — so the card and
       the compare modal read consistently. */
    if (listing.corrupted) {
      body.append(el("div", { class: "ph-saved-corrupted", text: "Corrupted" }));
    }

    /* Item Level/Requires Level, Quality/defenses, and Base Percentile
       (see itemPropertyBlocks) — each its own small-divided group, then
       the mods themselves behind the more prominent divider GGG's own
       item popup uses between its implicit and explicit sections
       (verified 2026-08 against a real popup's outerHTML), rather than
       everything just run together in one plain list the way this used
       to render. */
    const propertyBlocks = itemPropertyBlocks(listing);
    body.append(...propertyBlocks);
    /* Enchant mods already rendered as their own group inside
       itemPropertyBlocks above (see enchantEntries) — excluded here so
       they don't also show up a second time in the regular mods list. */
    const displayMods = excludeEnchantMods(listing.mods);
    if (displayMods.length) {
      /* Shown for an unidentified listing too — its mods are just
         whatever implicit(s) it has, which are genuinely visible on the
         real item even unidentified (only explicit/rolled affixes are
         hidden). Listings saved before "Search this exact item" needed a
         stat's own id still just have a plain string per mod, not
         { id, text, value }. */
      if (propertyBlocks.length) body.append(el("hr", { class: "ph-item-divider" }));
      body.append(itemModsBlock(displayMods));
    }

    if (listing.noResultsFound) {
      body.append(confirmRow("It looks like the item is no longer available.\nWould you like to remove it?", {
        confirmLabel: "Remove",
        onConfirm: async () => {
          await PH.store.deleteSavedListing(listing.id);
          PH.panel.refresh();
        },
        onCancel: async () => {
          await PH.store.setListingNoResults(listing.id, false);
          PH.panel.refresh();
        },
      }));
    } else {
      /* Icon-only, single row — four full-width labeled buttons stacked
         vertically (the original design) ate a quarter of the card's own
         height each, per a direct complaint; tooltips (title/aria-label
         on every one) carry the same explanation the labels used to,
         just on hover instead of always on screen. */
      body.append(el("div", { class: "ph-toolbar ph-toolbar-icons" },
        url
          ? el("a", {
              class: "ph-icon-btn", href: url, target: "_blank", rel: "noopener",
              title: "Rerun this search", "aria-label": "Rerun this search",
            }, PH.ui.icon("refresh"))
          : null,
        PH.ui.iconButton(PH.ui.icon("search"), {
          title: "Search the trade site directly for this item's name and rolled mods\nGGG rate-limits this strictly, so repeated clicks in quick succession will get refused or blocked",
          onClick: () => rebuildSearch(listing),
        }),
        bookmarkButton(listing, context.folders, { iconOnly: true }),
        PH.ui.iconButton(PH.ui.icon("trash"), {
          class: "ph-icon-btn-danger",
          title: "Remove this saved listing",
          onClick: async () => { await PH.store.deleteSavedListing(listing.id); PH.panel.refresh(); },
        })
      ));
    }

    row.append(body);
    return row;
  }

  return { render, enhanceRows, syncSaveButtons, initPriceCapture, capturePendingPrice };
})();
