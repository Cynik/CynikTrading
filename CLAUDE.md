# PoE Trade Helper

A Manifest V3 browser extension (plain JavaScript, no build step) that adds
quality-of-life features to the official Path of Exile trade site.

**Target browser is Opera GX**, which is Chromium-based, so the `chrome.*`
APIs, MV3 rules and DevTools all behave identically. Two practical
differences: the extensions page is `opera://extensions` (or Ctrl+Shift+E),
and Chrome Web Store publishing is not the distribution path — this runs
unpacked. Don't suggest CWS listing or Chrome-only APIs without checking
Opera's Chromium version at `opera://about`.

The developer is new to extensions, APIs, and git. Explain the *why* alongside changes,
and prefer the boring obvious solution over the clever one.

## Reading order

`store.js` (what's saved) → `location.js` (how trade URLs work) → `panel.js`
(the shell) → `bookmarks.js` / `live-searches.js` / `saved.js` (the tabs) →
`main.js` (wiring and boot).

## Layout

Content scripts are **classic scripts, not modules**, listed in order in the
manifest. They share one `window.PH` namespace. Adding a file means adding it
to `content_scripts[0].js` *in dependency order* — `store.js` must load first,
`main.js` last.

- `src/content/store.js` — the only file that touches `chrome.storage`
- `src/content/location.js` — parse trade URLs, build them, resolve leagues
- `src/content/icons.js` — folder icon slugs, colours, monogram badges
- `src/content/ui.js` — shared DOM helpers, menus, inline forms, drag-sort
- `src/content/search-panel.js` — reads GGG's search form for title suggestions
- `src/content/exchange.js` — import/export codes and file backup
- `src/content/panel.js` — the slide-out panel, tabs, collapse
- `src/content/bookmarks.js`, `live-searches.js`, `saved.js` — one per tab
- `src/content/prices.js` — chaos ↔ divine annotation
- `src/content/main.js` — boot, the `~` feature, DOM and URL watchers
- `src/content/panel.css` — every style; all classes prefixed `ph-`
- `src/assets/icons/bookmark-folder/*.png` — Better Trading's folder icons
  (MIT), served via `web_accessible_resources`
- `src/background/service-worker.js` — no DOM; the only network calls
- `src/popup/` — settings only (two toggles + current rate)
- `test/logic-test.js` — `node test/logic-test.js`

## Features and status

1. **Bookmarks** — folders with icons, saved searches, drag-reorder, archive,
   mark-as-done, rename, "point at the search I'm on now", share codes, file
   backup. Each trade keeps a rolling history of its cheapest observed price
   (last 5, oldest first), captured on save/repoint *and* automatically
   whenever you visit that bookmarked search on the trade site — with a ▲/▼
   trend indicator comparing the two most recent, colored by move size (a
   border at 10%+, gold at 30%+ for a drop, an inverted black-on-red fill at
   30%+ for a rise), and a hover popup on the price badge showing the full
   history with the same tiering per-row plus a small single-color
   sparkline. Next to that badge, for PoE1 items poe.ninja has a fixed
   catalog for (uniques, gems, corpses, ...), a poe.ninja average-price
   badge that links straight to that item's poe.ninja page. Each folder's
   header also shows a **Total Cost** — the sum of every trade's latest
   price — cached on the folder and refreshed only when you open it, so a
   collapsed folder shows its last-known total without a trades fetch (can
   go stale between opens; that's deliberate, see the note by
   `totalCostBadge` in bookmarks.js). Working.
2. **Live searches** — a flat, persisted watchlist of searches (same
   `{version, type, slug}` location shape as a bookmark), added from the
   current page or pulled in from a bookmark folder, each with a one-click
   "Open live search". Replaced the old per-listing pinning in v0.3. Working.
3. **Saved listings** — a manually-saved snapshot of one specific trade offer
   (item, price, seller, its rolled mods), captured via a 🏷 button on each
   result row (`.details .btns`, same spot the old pinned.js used for 📌).
   Replaced History's auto-tracking in v0.3. Selectors verified 2026-08
   against a real unique item's row — see the note at the top of `saved.js`.
   **Still missing**: "rebuild a search from this item's own stats" — a
   different, larger piece needing unverified selectors for the advanced
   search form's *set* behavior, not just reading a row. Capturing and
   managing listings works now; reconstruction doesn't exist yet.
4. **Auto-`~`** — a leading `~` makes the stat filter search fuzzy, so it's
   typed into every empty stat box, including one you just deleted it from —
   the popup toggle is the only way to turn this off. (An earlier version
   opted a box out once you deleted the `~` from it; the developer found that
   annoying rather than helpful, so it was removed in favor of always
   refilling.) Selector still unverified against the live site.
5. **Chaos ↔ divine** — annotates listing prices. Rate from poe.ninja, cached
   15 minutes. Selectors taken from Better Trading's source, so known-good.
   The amount-parsing half was actually wrong until it was re-verified
   against the real live site in v0.3 — see the note at the top of
   `prices.js`. Working now.

## Rules for this codebase

- **Plain JS, no frameworks, no bundler.** The whole point is that the developer can
  read every line. Do not introduce npm, TypeScript, or a build step without
  asking first.
- **A bookmark (and a live search) stores no league.** `location` is
  `{version, type, slug}`. The league is resolved at click time (pinned
  league → current page → last seen for that game, tracked by
  `PH.store.noteLeague` on every URL change). This is what makes them survive
  a league reset — do not "fix" it by storing the league. A saved listing
  *does* keep its league, because it's a record of a specific past moment,
  not a reusable search.
- **Selectors live at the top of the file that uses them**, with a comment
  saying whether they're verified. Never invent one; gate a feature off rather
  than shipping a guess that fails silently.
- **All network calls go in the service worker.** A content script inherits
  pathofexile.com's same-origin rules, so it cannot fetch poe.ninja — and
  `host_permissions` does not change that.
- **The content script sends parameters, never URLs.** The service worker
  builds every URL itself from values it controls.
- **Register every `addListener` at the top level** of the service worker. It
  is shut down after ~30s idle and restarted on the next event.
- **Every DOM enhancer marks what it touched** (`ph-tilde`, `ph-pinnable`,
  `ph-priced`) and selects with `:not([mark])`. Our own edits re-trigger the
  MutationObserver; the marks are what stop the loop.
- **Live searches store a search reference, not a listing.** A live-search
  entry is the same `{version, type, slug}` shape as a bookmark trade — no
  price, item, or seller data, so persisting it is safe: reopening it just
  re-runs the search rather than showing a snapshot of results that may
  already be sold. **Saved listings are the exception**, and it's an
  intentional one: they exist specifically to remember a price/item/seller
  snapshot, labelled and treated as a point-in-time record (see
  `PH.store.saveSavedListing`) — never persist live DOM (a clone of the row)
  the way the old pinned-items feature did.
- **Import/export must stay byte-compatible with Better Trading.** Format is
  `"<v>:" + base64(JSON)` with keys `icn/tit/ver/trs/loc`; v1 has no prefix
  and Latin-1 base64. `test/logic-test.js` checks this against their own
  fixture. The developer is migrating off Better Trading, so breaking this loses data.

## Hard boundary: what this extension must never do

GGG's Terms of Use forbid automated software acting on their site (§7c), data
extraction/scraping (§7f), and reverse-engineering undocumented endpoints
(§7i — and `/api/trade/*` is *not* in their developer docs). Their developer
docs also require that macros be manually invoked, one action per invocation.

So: **this extension reads the page the user already loaded and stores things
locally.** It does not send whispers, click buttons on a timer, open
live-search websockets, poll `/api/trade/*`, or bulk-collect listings. The
"Open live search" menu item opens a normal tab and lets the trade site do its
own thing — we never hold that socket ourselves. If a feature request would
need any of that, say so and stop rather than building it.

The only host we contact is poe.ninja: a cached exchange rate, and (PoE1
uniques only) cached item-price data for the "poe.ninja average" badge in
Bookmarks. Both are read-only lookups against poe.ninja's own public data,
cached for `CACHE_MINUTES`, never a per-item live request.

Public-facing copy must include: "This product isn't affiliated with or
endorsed by Grinding Gear Games in any way."

## Testing

`node test/logic-test.js` covers storage, URL/league logic, and import/export.
Everything else needs the browser:

1. `opera://extensions` (Ctrl+Shift+E) → reload the extension card.
2. Reload the trade page (content script changes need *both*).
3. F12 on the trade page → Console → filter `PoE Helper`.
4. `opera://extensions` → "service worker" link → separate console for the
   background script. Close that window before believing it works; having it
   open keeps the worker alive and hides idle-shutdown bugs.

## Where we are, and what's next

v0.3 replaced per-listing pinning with a persisted Live-searches watchlist,
replaced History's auto-tracking with a manually-curated Saved-listings tab,
and added a rolling price-history + trend indicator to Bookmarks, deduped so
a same-price recheck within 3h refreshes a timestamp instead of taking a slot
(see `PH.store.pushTradePrice`). `node test/logic-test.js` should now pass 69
checks — run it to confirm, since Node.js wasn't available to verify it when
this file was last edited (the price-history cap changed from 3 to 5, and
the test file was updated to match, but not actually executed). Everything
below needs a real browser, to verify manually.

Priorities, in order:

1. **"Rebuild a search from this item's own stats" — blocked on real DOM,
   needs the developer.** The last missing piece of Saved listings: type each mod's
   text into the "+ Add Stat Filter" flow and fill the resulting min/max
   range from the rolled value. Needs verified selectors for the
   category/rarity dropdowns' *set* behavior (not just read, like
   `search-panel.js` does today), the add-stat-filter control, the
   stat-search dropdown, and the numeric range inputs — none of which exist
   yet. Ask the developer to paste outerHTML (right-click → Inspect → Copy → Copy
   outerHTML) of the advanced search sidebar after clicking "+ Add Stat
   Filter" and picking one stat, so the resulting filter row (with its
   min/max inputs) is visible.
2. **Check the Live searches tab against the real page.** Verify "Add current
   search", "From bookmarks…", and "Open live search" all work against the
   live site's URLs and league resolution.
3. **Migrate the developer's Better Trading data before they uninstall it.** Their *Save
   file* → our **Restore from file**. Verify folder titles, icons and search
   counts survived, then compare a few links.

Done: **The panel's viewport-narrowing dead zone and footer overlap, verified
2026-08 against the live DOM.** Narrowing `#trade` for the panel doesn't
narrow the real browser viewport, so GGG's own `@media (min-width: 1200px)`
breakpoint for its two-column `.search-advanced-pane` filter layout never
re-evaluates — the page still thinks it's at full desktop width even once
`#trade` no longer has room for two columns, so the columns squeeze awkwardly
instead of gracefully stacking. Confirmed this is a known problem, not
something specific to this codebase, against Better Trading's own source
(github.com/exile-center/better-trading) — its `_search-panel.scss` hits the
identical issue and patches it the identical way: a media query keyed to the
*real* window width, forcing single-column layout only in the "dead zone"
where `#trade` is narrowed but the real window is still wide enough that GGG
thinks it's desktop. `.search-advanced-pane` is Better Trading's own selector
and still matches the live site today. Separately, GGG's site footer
(`div.bottom`) turned out to be `position: absolute; bottom: 8px` rather than
flowing normally after the content, so narrowing-induced text wrapping (which
grows the filters' real height) made it overlap the Search/Clear/Hide Filters
row instead of clearing it — fixed by forcing it back into normal flow while
the panel is narrowing `#trade`, rather than guessing at how much clearance
to reserve. Both fixed in `panel.css`. Also fixed in the same pass: a scroll
jump on collapse/expand (the width transition briefly shrinks `#trade`'s
height mid-reflow, and the browser clamps scroll position to fit) by
restoring scroll position in `panel.js`'s `setCollapsed`; and a
`slide-fade-in` animation on panel tab content, matching Better Trading's own
(`opacity`+`translateY(10px)`, 0.2s ease).

Done: **Auto-`~` no longer opts a box out.** It used to remember that you'd
deleted the `~` from a specific box and stay out of it until cleared; the developer
found that more annoying than helpful, so it was removed — the popup toggle
is now the only way to turn this off (see `main.js`). Also confirmed
`STAT_FILTER_INPUT`'s selector (`input.multiselect__input`) is correct
against the live site, via a real outerHTML paste showing `ph-tilde=""`
already marked on a live input — the "still unverified" caveat is gone.

Done: **The panel-narrowing fix, verified 2026-08 against the live DOM.** The
panel was narrowing `#app` to make room for itself, but `#app` turned out to
be an empty, zero-height leftover Vue mount point (`<div id="app"
data-v-app=""></div>`) that GGG's site no longer renders into — the rule had
been a silent no-op since it was written, on every version of the site. The
real results/filters container is `#trade`, which also arrives centered via
GGG's own `margin: 0 auto`, so `margin: 0` had to come along with the width
override or it would've just shrunk from both sides instead of giving up its
right edge. Fixed in `panel.css` and `panel.js`'s comment; confirmed live that
rows, prices, and the "Ignore Player" button all reflow correctly now instead
of getting clipped under the panel.

Done: **Saved listings' capture button.** Real selectors now, verified
2026-08 against a real result row — item name, seller, and rolled mod text
all read cleanly; the price reuses `PH.prices.readRowPrice`. See the note at
the top of `saved.js`. Also fixed in the same pass: the chaos↔divine
conversion's amount-parsing was silently broken (`.currency-text` turned out
to hold the currency's *name*, not the number) — see the note at the top of
`prices.js`.

Done: **Folder icon artwork.** Real icons now — Better Trading's 64
bookmark-folder PNGs (MIT), downloaded into
`src/assets/icons/bookmark-folder/`, served via a `web_accessible_resources`
entry scoped to `/trade*`. `PH.icons.render()` returns an `<img>`; the old
monogram badge is now only an `onerror` fallback (see `icons.js`).

When handing off a DOM problem, paste the element's **outerHTML**
from DevTools (right-click the element → Copy → Copy outerHTML), not a
screenshot or a description. That's the difference between a fix and a guess.
