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

   Price reuses PH.prices.readRowPrice — see the note at the top of
   prices.js for that selector.

   "Search this exact item" (back to calling GGG's trade-search API directly,
   after two non-API designs — see CLAUDE.local.md for that whole history)
   calls GGG's own trade-search API directly and opens the real results —
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

  /* {amount, currency} -> a chaos-equivalent number — same conversion
     Bookmarks uses for its own price math (toChaosEquivalent in
     bookmarks.js), duplicated here rather than shared since each module
     already keeps its own small formatting helpers. currency is only ever
     exactly "chaos" or "divine" for those two (see readCurrency in
     prices.js); null if it's divine and the exchange rate hasn't loaded.
     Any other currency (Orb of Fusing, Exalted Orb, ...) — a listing can
     genuinely be saved priced in one of these, captureListing reads
     whatever the row actually says — has no real rate available, so it's
     floored to a flat ~1 chaos-equivalent rather than left uncomparable:
     a deliberate, explicit approximation for sorting/diff/group-price
     math on your own saved listings, not a real conversion. Used for the
     price diff below and for sorting/grouping the list by price. */
  function toChaosEquivalent(entry) {
    if (entry.currency === "chaos") return entry.amount;
    const rate = PH.prices.currentRate();
    if (entry.currency === "divine") return rate ? entry.amount * rate.divineInChaos : null;
    return 1;
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
     the Auto-~ feature note in CLAUDE.md): each word in the typed text
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
     Listings that are "the same item" collapse into one group in the list —
     automatically for a shared title (uniques, currency, corpses, ... —
     anything with a real, meaningful name) or shared icon (unique/magic/
     rare/anything unidentified — see autoGroupKey), with a text-based
     fallback (textFallbackClusters, in buildGroups) for magic/rare pairs
     icon-matching alone doesn't catch, and manually by dragging one
     listing onto another (see wireGroupDrag/groupListings), which always
     takes priority over whatever an item would've auto-grouped into. A
     group of one item never renders as a group — see buildGroups — so
     auto-grouping is invisible until a second matching item shows up, and
     dragging two
     items together is what makes a manual group exist at all. */

  /* The grouping key for automatic (non-dragged) grouping. Same title for
     anything with a stable, meaningful, fully-known name — but the icon
     URL instead for unique/magic/rare, and unconditionally so (not just
     when unidentified): an unidentified unique's title is just its base
     type ("Infernal Sword"), not the actual unique's name — GGG doesn't
     reveal which specific unique it is until identified — so text-
     matching it against an identified "Starforge Infernal Sword" would
     never succeed even though they're plausibly the same drop. Icon
     matching sidesteps that entirely: a unique keeps its own distinct
     artwork whether identified or not (confirmed 2026-08 — an
     unidentified Starforge's icon URL is byte-identical to an identified
     one's), so this is the closest thing to "the API exposing the
     identified name" actually available. Every unique has to use this
     same icon-based key regardless of ITS OWN identified status too —
     not just unidentified ones — or an identified Starforge (keyed by
     title) and an unidentified one (keyed by icon) end up in two
     different key spaces that can never match each other, which was
     exactly the bug an earlier version of this function had. Magic/rare
     use icon for a different reason: their single header line mixes
     randomly-rolled affix words into what looks like a name/type — see
     the long rebuildSearch comment on why that text can't be trusted as
     a real identifier — regardless of identified status too, since GGG
     serves the exact same generic artwork for every roll of the same
     base either way. null (never auto-grouped) if the listing has
     neither a usable title nor an icon — both realistic for a listing
     saved before either existed. */
  function autoGroupKey(listing) {
    if (listing.rarity === "unique" || listing.rarity === "magic" || listing.rarity === "rare" || listing.unidentified) {
      return listing.icon ? `icon:${listing.icon}` : null;
    }
    return listing.title ? `title:${listing.title}` : null;
  }

  /* The header text for a group of listings.

     A unique group prefers an identified member's real title over
     anything computed — "Starforge Infernal Sword" is the one, fixed,
     correct name every member (identified or not) actually is, unlike
     magic/rare where every "identified" member still has its own
     different randomly-rolled full name. If every member happens to be
     unidentified (title is just the base type for all of them), there's
     nothing more specific to prefer — falls through to the same
     word-matching below, which just returns that shared base type as-is
     in that case.

     Everything else (magic/rare, or a unique group with no identified
     member) finds the longest run of words common to every member's
     title instead, which converges on the shared base type regardless of
     where affix words landed ("Weaponmaster's Infernal Sword" and
     "Infernal Sword of Fame" share only "Infernal Sword" as a contiguous
     run, and an unidentified "Infernal Sword" fits right into that same
     run too) — no list of known prefixes/suffixes to maintain. Falls
     back to the first member's own title if that somehow comes up empty
     (e.g. a one-word title with no run in common with anything). */
  function autoGroupLabel(members) {
    if (members[0]?.rarity === "unique") {
      const identified = members.find((m) => !m.unidentified && m.title);
      if (identified) return identified.title;
    }

    const titles = members.map((m) => m.title).filter(Boolean);
    return commonWordSpan(titles) || members[0]?.title || "Group";
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

  function commonWordSpan(titles) {
    if (titles.length === 0) return null;
    let common = titles[0].split(/\s+/);
    for (let i = 1; i < titles.length && common.length; i++) {
      common = longestCommonWordRun(common, titles[i].split(/\s+/));
    }
    return common.length ? common.join(" ") : null;
  }

  /* Longest contiguous run of words shared between two word lists —
     classic longest-common-substring DP, just applied to words instead
     of characters. Case-insensitive so "of" vs "Of" at a sentence
     boundary still counts. */
  function longestCommonWordRun(a, b) {
    let best = [];
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        if (a[i - 1].toLowerCase() !== b[j - 1].toLowerCase()) continue;
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > best.length) best = a.slice(i - dp[i][j], i);
      }
    }
    return best;
  }

  /* Fallback for when icon-matching alone doesn't pair up two same-base
     magic/rare listings — the generated icon URL is expected to be
     identical for every roll of the same base regardless of rarity, but
     that's evidently not always true in practice (confirmed live: a
     magic and a rare Infernal Sword the user pointed out weren't
     grouping), and the actual reason isn't pinned down. Rather than
     leave those ungrouped, this clusters them by title instead, using
     the same longest-common-word-run technique autoGroupLabel already
     uses to *label* a group — now also deciding *whether* two titles
     belong together, not just what to call them once they do, so this
     still doesn't need any list of known prefix/suffix words to strip.
     Greedy single-pass: each item joins the first existing cluster its
     title shares a 2+-word run with (narrowing that cluster's own
     "core" words to just the shared run as it grows, so drift doesn't
     accumulate across many merges), or starts a new one. A 2-word
     minimum (not 1) avoids two genuinely different bases falsely
     matching on one generic shared word like "Sword" alone. Returns
     only clusters that end up with 2+ members. */
  function textFallbackClusters(items) {
    const clusters = [];
    for (const item of items) {
      if (!item.title) continue;
      const words = item.title.split(/\s+/);

      const fit = clusters.find((c) => longestCommonWordRun(c.words, words).length >= 2);
      if (fit) {
        fit.words = longestCommonWordRun(fit.words, words);
        fit.members.push(item);
      } else {
        clusters.push({ words, members: [item] });
      }
    }
    return clusters.filter((c) => c.members.length >= 2);
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

    /* Magic/rare listings whose own icon-keyed bucket didn't end up with
       company (including one with no icon at all) get a second chance
       via textFallbackClusters — see the long comment there. Checked
       against each item's bucket size *before* this loop changes
       anything, so a listing that already found real company by icon is
       never reconsidered here. */
    const iconMissed = ungrouped.filter((l) => {
      if (l.rarity !== "magic" && l.rarity !== "rare") return false;
      const key = autoGroupKey(l);
      return !key || (autoByKey.get(key)?.length ?? 0) < 2;
    });
    for (const cluster of textFallbackClusters(iconMissed)) {
      autoByKey.set(`text:${cluster.words.join(" ")}`, cluster.members);
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
     away from it. */
  async function groupListings(draggedId, targetId) {
    if (draggedId === targetId) return;

    const [listings, groups] = await Promise.all([PH.store.getSavedListings(), PH.store.getSavedGroups()]);
    const dragged = listings.find((l) => l.id === draggedId);
    const target = listings.find((l) => l.id === targetId);
    if (!dragged || !target) return;
    if (dragged.groupId && dragged.groupId === target.groupId) return; // already together

    if (target.groupId) {
      await PH.store.setListingGroup(dragged.id, target.groupId);
    } else {
      const targetKey = autoGroupKey(target);
      const autoCompany = targetKey
        ? listings.filter((l) => !l.groupId && l.id !== dragged.id && l.id !== target.id && autoGroupKey(l) === targetKey)
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
     not gated behind a separate grip handle. */
  function wireGroupDrag(list) {
    list.addEventListener("dragstart", (e) => {
      const row = e.target.closest("[data-listing-id]");
      if (!row) return;
      draggedListingId = row.dataset.listingId;
      row.classList.add("ph-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", draggedListingId);
    });

    /* The ungroup zone ([data-ungroup-zone]) is a separate kind of drop
       target from a listing/group-head ([data-listing-id]) — checked
       first in each handler below since it isn't nested inside a
       [data-listing-id] element (so closest() wouldn't fall through to
       it), and its own drop calls removeFromGroup instead of
       groupListings. */
    list.addEventListener("dragover", (e) => {
      if (!draggedListingId) return;
      const zone = e.target.closest("[data-ungroup-zone]");
      if (zone) { e.preventDefault(); zone.classList.add("ph-drop-target"); return; }

      const row = e.target.closest("[data-listing-id]");
      if (!row || row.dataset.listingId === draggedListingId) return;
      e.preventDefault();
      row.classList.add("ph-drop-target");
    });

    list.addEventListener("dragleave", (e) => {
      (e.target.closest("[data-ungroup-zone]") ?? e.target.closest("[data-listing-id]"))?.classList.remove("ph-drop-target");
    });

    list.addEventListener("drop", (e) => {
      const zone = e.target.closest("[data-ungroup-zone]");
      if (zone) {
        zone.classList.remove("ph-drop-target");
        if (draggedListingId) { e.preventDefault(); removeFromGroup(draggedListingId); }
        return;
      }

      const row = e.target.closest("[data-listing-id]");
      row?.classList.remove("ph-drop-target");
      if (!draggedListingId || !row || row.dataset.listingId === draggedListingId) return;
      e.preventDefault();
      groupListings(draggedListingId, row.dataset.listingId);
    });

    list.addEventListener("dragend", (e) => {
      e.target.closest("[data-listing-id]")?.classList.remove("ph-dragging");
      draggedListingId = null;
      for (const dropTarget of list.querySelectorAll(".ph-drop-target")) dropTarget.classList.remove("ph-drop-target");
    });
  }

  function formatChaosDelta(diff) {
    const abs = Math.abs(diff);
    const sign = diff > 0 ? "+" : "-";
    const rate = PH.prices.currentRate();
    return rate && abs >= rate.divineInChaos
      ? `${sign}${(abs / rate.divineInChaos).toFixed(1)} div`
      : `${sign}${Math.round(abs)}c`;
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
    const rows = document.querySelectorAll(`${ROW}:not([${MARK}])`);
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
    const buttons = document.querySelectorAll(".ph-save-btn");
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

  async function captureListing(row) {
    /* Guards against a duplicate save even if the button was somehow
       still clickable despite syncSaveButtons — e.g. storage changed in
       another tab in the instant between render and click. */
    const existing = await PH.store.getSavedListings();
    if (matchingListing(existing, row)) {
      toast("Already saved.");
      syncSaveButtons();
      return;
    }

    const page = PH.location.current();
    const priced = PH.prices.readRowPrice(row);
    const { name, type } = itemNameType(row);
    const listedText = row.querySelector('[data-field="indexed"] small')?.textContent.trim();

    const listing = {
      location: { version: page.version, type: page.type, slug: page.slug },
      league: page.league,
      sourceId: row.dataset.id ?? null,
      title: itemTitle(row),
      name,
      type,
      icon: row.querySelector(".icon img")?.src ?? null,
      listedAt: parseListedAgo(listedText),
      rarity: itemRarity(row),
      unidentified: isUnidentified(row),
      price: priced ? formatPrice(priced) : null,
      priceIcon: priced?.icon ?? null,
      seller: sellerName(row),
      mods: modLines(row),
      priceHistory: priced ? [{ amount: priced.amount, currency: priced.currency, capturedAt: new Date().toISOString() }] : [],
    };

    await PH.store.saveSavedListing(listing);
    toast(`Saved “${listing.title ?? "listing"}”`);
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
     Attributes"). Each mod's { id, text, value }: id is the stat's own
     internal id (from its data-field attribute, not its text) that GGG's
     search API filters on; value is a best-effort read of the first number
     in the rendered text, for mods with no roll at all (flags like "Your
     Physical Damage can Shock") there's nothing to search a value for, so
     that comes back null. */
  function modLines(row) {
    return [...row.querySelectorAll(".item-mod")]
      .map((mod) => {
        const statEl = mod.querySelector('[data-field^="stat."]');
        const text = statEl?.textContent.trim();
        if (!text) return null;
        const id = statEl.getAttribute("data-field")?.replace(/^stat\./, "") || null;
        return { id, text, value: modRollValue(text) };
      })
      .filter(Boolean);
  }

  function modRollValue(text) {
    const match = text.match(/-?\d[\d,]*\.?\d*/);
    if (!match) return null;
    const value = parseFloat(match[0].replace(/,/g, ""));
    return Number.isFinite(value) ? value : null;
  }

  /* ------------------------------------------------ search this exact item ---- */
  /*
     "Search this exact item" calls GGG's own trade-search API
     (pathofexile.com/api/trade/search/<league>) directly and opens the real
     results — not a prefilled query you still have to finish yourself. This
     is a deliberate, narrow exception to this project's usual "never touch
     an undocumented endpoint" rule; see CLAUDE.md's hard-boundary section
     for the full reasoning (real precedent from Awakened PoE Trade and
     PoE-Overlay-Community-Fork, confirmed by reading their actual source,
     and an explicit decision made with the developer rather than assumed —
     revisited more than once this session before landing here for good).
     The rules that keep this narrow:

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
       - Search only — this never calls /api/trade/fetch. We only need the
         search id to build a results URL; unlike a price-checker we don't
         need each listing's own data, so there's no reason to make that
         second kind of call at all.

     Each stat filter's min AND max are both set to the exact rolled value
     (not just a minimum) — the tightest possible match, since the goal is
     relocating one specific item, not browsing similar ones. When there
     are no stats to filter on at all (unidentified, or nothing rolled
     that had both a stat id and value), the seller's account is added as
     a filter instead, to keep name/type-only results narrowed to one
     listing — see the trade_filters.account note further down. */

  const TRADE_API_HOST = "https://www.pathofexile.com";

  async function rebuildSearch(listing) {
    const version = listing.location?.version ?? "1";
    if (version !== "1") {
      toast("Rebuild via search isn't available for PoE2 yet.", { error: true });
      return;
    }

    const league = listing.league;
    if (!league) {
      toast("No league recorded for this listing — can't search.", { error: true });
      return;
    }

    const statFilters = (listing.mods ?? [])
      .filter((mod) => typeof mod === "object" && mod?.id && mod.value != null)
      .map((mod) => ({ id: mod.id, value: { min: mod.value, max: mod.value } }));

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

    /* Without this, an unidentified item's search would let identified
       copies of the same base back into results too ("identified: any" is
       the default) — statFilters above may still include its implicit(s),
       but that alone doesn't rule out an identified item that rolled the
       same implicit. Filter key/shape verified against
       PoE-Overlay-Community-Fork's own reference trade-search request
       (doc/poe/api_trade_search_request.json), not guessed. */
    if (listing.unidentified) {
      request.query.filters.misc_filters = { filters: { identified: { option: "false" } } };
    }

    /* Same reference doc, filters.type_filters.filters.rarity — stands in
       for the name/type narrowing magic/rare listings don't get above. */
    if (isMagicOrRare) {
      request.query.filters.type_filters = { filters: { rarity: { option: listing.rarity } } };
    }

    /* No reliable name/type narrowing — unidentified, magic/rare (see
       above), or nothing rolled that had both a stat id and a value —
       means stats alone might still return several listings from
       different sellers. The seller's account narrows it back to one,
       same technique Path of Building's own trade-query code uses for
       exactly this ("apply trader name... this should make false
       positives extremely unlikely" — TradeQuery.lua) and the same filter
       the trade site's own "Trade Filters" > Seller Account UI sets when
       ticked. */
    if (listing.seller && (listing.unidentified || isMagicOrRare || statFilters.length === 0)) {
      request.query.filters.trade_filters = { filters: { account: { input: listing.seller } } };
    }

    /* Opened synchronously, before the fetch below — browsers can silently
       drop a popup once too much time has passed since the click that
       triggered it. We navigate this tab to the real results once they're
       ready, rather than opening the final URL directly. */
    const resultTab = window.open("about:blank", "_blank");

    /* about:blank's default background is plain white, which flashes
       bright against everything else here being dark for however long the
       search takes to come back. Same origin as this tab (we just opened
       it ourselves), so writing a dark background straight into it before
       navigating away is safe — no CORS/cross-origin restriction applies. */
    if (resultTab) {
      resultTab.document.write('<meta charset="utf-8"><body style="background:#1c1f26;margin:0"></body>');
      resultTab.document.close();
    }

    const result = await searchTrade(request, league);
    if (!result) {
      if (resultTab) resultTab.location.href = PH.location.buildBlankSearchUrl(version, league) ?? "about:blank";
      return;
    }

    /* Lets the tab that's about to load record a price observation back
       onto this listing once real results show — see the note above
       capturePendingPrice. Skipped on a zero-result search: there's no
       price to capture, and notePriceIfMatch/capturePendingPrice would
       have nothing to read off an empty results page anyway. */
    if (result.total > 0) await PH.store.setPendingPriceCapture(listing.id);

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

  /* POSTs one search to GGG's trade API and returns { id, total }, or null
     (with a toast already shown) on any failure — cooldown refusal, a
     network error, a non-2xx response, or a malformed one. */
  async function searchTrade(request, league) {
    const cooldown = await PH.store.getTradeSearchCooldown();
    if (cooldown && Date.now() < cooldown) {
      const waitSec = Math.ceil((cooldown - Date.now()) / 1000);
      toast(`Rate limited by the trade site — try again in ${waitSec}s.`, { error: true });
      return null;
    }

    const url = `${TRADE_API_HOST}/api/trade/search/${encodeURIComponent(league)}`;
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch {
      toast("Couldn't reach the trade site's search API.", { error: true });
      return null;
    }

    const blockedUntil = rateLimitCooldown(response.headers);
    if (blockedUntil) await PH.store.setTradeSearchCooldown(blockedUntil);

    if (!response.ok) {
      toast(
        response.status === 429
          ? "Rate limited by the trade site — try again shortly."
          : `Trade search failed (HTTP ${response.status}).`,
        { error: true }
      );
      return null;
    }

    const data = await response.json().catch(() => null);
    if (!data?.id) {
      toast("Trade search returned no results id.", { error: true });
      return null;
    }
    return { id: data.id, total: data.total ?? 0 };
  }

  /* GGG's rate-limit headers, per policy this response's request was
     charged against (there can be several at once — e.g. one window for
     "requests per few seconds", another for "requests per few minutes"):

       x-rate-limit-rules: Account,Ip
       x-rate-limit-account: 8:10:60,50:600:1800    "count:period(s):timeout(s)"
       x-rate-limit-account-state: 3:10:0,12:600:0  "count:period(s):timeout(s-if-blocked)"

     Simplified from PoE-Overlay-Community-Fork's own TradeRateLimitService:
     they track a full sliding-window ledger of past request timestamps
     (needed since they also batch-fetch listing data); we only ever make
     one search call per click, so it's enough to compute "the latest time
     any rule says we're blocked until" and refuse new calls before then. */
  function rateLimitCooldown(headers) {
    const rules = headers.get("x-rate-limit-rules");
    if (!rules) return null;

    const now = Date.now();
    let latest = null;

    for (const rule of rules.split(",").map((r) => r.trim().toLowerCase())) {
      const limits = headers.get(`x-rate-limit-${rule}`)?.split(",") ?? [];
      const states = headers.get(`x-rate-limit-${rule}-state`)?.split(",") ?? [];

      for (let i = 0; i < limits.length && i < states.length; i++) {
        const [maxCount, period, timeout] = limits[i].split(":").map(Number);
        const [currentCount, , currentTimeout] = states[i].split(":").map(Number);

        const blockedFor = currentTimeout > 0 ? currentTimeout : currentCount >= maxCount ? (timeout || period) : 0;
        if (blockedFor <= 0) continue;

        const until = now + blockedFor * 1000;
        if (!latest || until > latest) latest = until;
      }
    }

    return latest;
  }

  /* ------------------------------------------------------- price capture ---- */
  /*
     "Search this exact item" opens a new tab; once that tab actually shows
     results, we record the cheapest one back onto the listing that sent us
     there, so its price history reflects reality without you having to
     manually re-save it. The handoff goes through PH.store.pendingPriceCapture
     (a listing id) for the same reason as the search request itself: a
     freshly opened tab has no other way to know which listing it came from.
     initPriceCapture reads it once on boot and clears it immediately, so a
     tab that was already sitting open can't also claim it. capturePendingPrice
     is called from main.js's poll loop the same way PH.bookmarks.notePriceIfMatch
     is — once real results are showing, once per visit — and reads the
     page via PH.prices.cheapestRowOnPage (same comparison as
     cheapestOnPage, which bookmarks uses, but also hands back the row
     itself so its "listed X ago" text can be re-read too — see
     PH.store.setListingListedAt); nothing new is fetched or clicked to
     make this happen. Dedup (only a genuine price change earns a new
     history slot) comes for free from PH.store.pushSavedListingPrice
     sharing nextPriceHistory with bookmark trades. */

  let pendingPriceCapture = null; // saved listing id

  async function initPriceCapture() {
    const pending = await PH.store.getPendingPriceCapture();
    if (!pending) return;

    pendingPriceCapture = pending;
    await PH.store.clearPendingPriceCapture();
  }

  function capturePendingPrice() {
    if (!pendingPriceCapture) return;
    const id = pendingPriceCapture;
    pendingPriceCapture = null; // once per visit, whether or not this finds a price

    const row = PH.prices.cheapestRowOnPage();
    if (!row) return;
    const priced = PH.prices.readRowPrice(row);
    if (!priced) return;

    const listedText = row.querySelector('[data-field="indexed"] small')?.textContent.trim();
    const listedAt = parseListedAgo(listedText);

    PH.store
      .pushSavedListingPrice(id, { ...priced, capturedAt: new Date().toISOString() })
      .then(() => (listedAt ? PH.store.setListingListedAt(id, listedAt) : null))
      .then(() => PH.panel.refresh());
  }

  /* -------------------------------------------------------------- render ---- */

  async function render(container) {
    const [listings, lastSeenLeagues, groups] = await Promise.all([
      PH.store.getSavedListings(),
      PH.store.getLastSeenLeagues(),
      PH.store.getSavedGroups(),
    ]);
    const pageLocation = PH.location.current();
    const context = { pageLocation, lastSeenLeagues };

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
        renderFilteredList(list, forThisGame, groups, context);
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

    /* Only worth showing once there's an actual group to drag out of —
       otherwise it's just a dead drop target cluttering an ungrouped
       list. */
    if (entries.some((e) => e.kind === "group")) list.append(ungroupedDropZone());

    for (const entry of entries) {
      list.append(entry.kind === "group" ? groupRow(entry, context, needle) : listingRow(entry.listing, context));
    }
  }

  /* A standing drop target — not a real group, nothing rendered inside it
     — for pulling one listing back out of whatever group it's in. The
     only other way to do that is the group's own "Ungroup" menu action,
     which dissolves the *whole* group; this is the one-listing-at-a-time
     equivalent. Matched in wireGroupDrag by [data-ungroup-zone] rather
     than [data-listing-id], a separate code path from grouping onto
     another listing. */
  function ungroupedDropZone() {
    return el("div", { class: "ph-saved-ungroup-zone", dataset: { ungroupZone: "true" } },
      "Drag here to remove a listing from its group"
    );
  }

  /* The other half of ungroupedDropZone — clears groupId on one listing.
     If that was the second-to-last member of its old group, setListingGroup
     itself dismantles that group (see the store.js comment there), same
     as it already does when moving a listing into a *different* group. */
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
      const toggle = el("button", {
        type: "button",
        class: "ph-saved-group-toggle",
        "aria-expanded": String(isOpen),
        onclick: () => { setGroupCollapsed(entry.id, isOpen); PH.panel.refresh(); },
      },
        el("span", { class: "ph-saved-group-chevron", text: isOpen ? "▾" : "▸" }),
        el("span", { class: "ph-saved-group-title", text: entry.title }),
        el("span", {
          class: "ph-saved-group-count",
          text: visibleMembers.length === entry.members.length
            ? String(entry.members.length)
            : `${visibleMembers.length}/${entry.members.length}`,
        })
      );

      /* .ph-icon-btn (same compact style as the "···" menu trigger) rather
         than the full "Price ▲" text button the list-level sort uses —
         there's a second button planned for this same row later, so this
         stays icon-only to leave room for it rather than crowding the
         header now and having to shrink it later. */
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
          sortBtn,
          menu([
            { label: "Rename group", onClick: () => setEditing({ kind: "rename-group", entryId: entry.id }) },
            entry.manual
              ? { label: "Ungroup", danger: true, onClick: async () => { await PH.store.ungroupListings(entry.id); PH.panel.refresh(); } }
              : null,
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
            ? el("span", { class: `ph-hover-diff ph-hover-diff-${diff > 0 ? "up" : "down"}`, text: formatChaosDelta(diff) })
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

    /* listedAt (when the trade site says the item was listed) rather than
       savedAt (when you clicked Save Listing) — listings saved before
       listedAt existed fall back to savedAt, the only time they have. */
    const metaBits = [listing.seller, league, timeAgo(listing.listedAt ?? listing.savedAt)].filter(Boolean);
    body.append(el("div", { class: "ph-saved-meta", text: metaBits.join(" · ") }));

    if (listing.unidentified) {
      body.append(el("span", { class: "ph-saved-unidentified", text: "Unidentified" }));
    }
    if (listing.mods?.length) {
      /* Shown for an unidentified listing too — its mods are just
         whatever implicit(s) it has, which are genuinely visible on the
         real item even unidentified (only explicit/rolled affixes are
         hidden). Listings saved before "Search this exact item" needed a
         stat's own id still just have a plain string per mod, not
         { id, text, value }. */
      body.append(el("ul", { class: "ph-saved-mods" },
        listing.mods.map((mod) => el("li", { text: typeof mod === "string" ? mod : mod.text }))
      ));
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
      body.append(el("div", { class: "ph-toolbar" },
        url ? el("a", { class: "ph-btn", href: url, target: "_blank", rel: "noopener", text: "Rerun this search" }) : null,
        button("Search this exact item", {
          title: "Search the trade site directly for this item's name and rolled mods",
          onClick: () => rebuildSearch(listing),
        }),
        button("Remove", {
          class: "ph-btn ph-btn-danger",
          onClick: async () => { await PH.store.deleteSavedListing(listing.id); PH.panel.refresh(); },
        })
      ));
    }

    row.append(body);
    return row;
  }

  return { render, enhanceRows, syncSaveButtons, initPriceCapture, capturePendingPrice };
})();
