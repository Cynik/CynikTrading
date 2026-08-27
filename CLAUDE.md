# PoE Trade Helper

A Manifest V3 browser extension (plain JavaScript, no build step) that adds
quality-of-life features to the official Path of Exile trade site.

**Target browser is Opera GX**, which is Chromium-based, so the `chrome.*`
APIs, MV3 rules and DevTools all behave identically. Two practical
differences: the extensions page is `opera://extensions` (or Ctrl+Shift+E),
and Chrome Web Store publishing is not the distribution path — this runs
unpacked. Don't suggest CWS listing or Chrome-only APIs without checking
Opera's Chromium version at `opera://about`.

## Reading order

`store.js` (what's saved) → `location.js` (how trade URLs work) → `panel.js`
(the shell) → `bookmarks.js` / `saved.js` (the tabs) → `main.js` (wiring and
boot).

## Layout

Content scripts are **classic scripts, not modules**, listed in order in the
manifest. They share one `window.PH` namespace. Adding a file means adding it
to `content_scripts[0].js` _in dependency order_ — `store.js` must load first,
`main.js` last.

- `src/content/store.js` — the only file that touches `chrome.storage`
- `src/content/location.js` — parse trade URLs, build them, resolve leagues
- `src/content/icons.js` — folder icon slugs, colours, monogram badges
- `src/content/ui.js` — shared DOM helpers, menus, inline forms, drag-sort
- `src/content/search-panel.js` — reads GGG's search form for title suggestions
- `src/content/exchange.js` — import/export codes and file backup
- `src/content/panel.js` — the slide-out panel, tabs, collapse
- `src/content/bookmarks.js`, `saved.js` — one per tab
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
   (last 5, oldest first), captured on save/repoint _and_ automatically
   whenever you visit that bookmarked search on the trade site — with a ▲/▼
   trend indicator comparing the two most recent, colored by move size (a
   border at 10%+, gold at 30%+ for a drop, an inverted black-on-red fill at
   30%+ for a rise), and a hover popup on the price badge showing the full
   history with the same tiering per-row plus a small single-color
   sparkline. Next to that badge, for PoE1 items poe.ninja has a fixed
   catalog for (uniques, gems, corpses, ...), a poe.ninja average-price
   badge that links straight to that item's poe.ninja page. Each folder's
   header also shows a **Total Cost** — the sum of every trade's latest
   price, in chaos or divine (whichever's smaller-numbered) — with the same
   trend arrow/hover-popup/sparkline treatment as a trade's own price.
   Recomputes on every render while the folder is open, so the number
   itself is never wrong relative to what's shown per-trade below it — but
   the *history entry* for a new total is debounced a few seconds behind
   the last change (`totalCostPushTimers` in `bookmarks.js`), since
   checking several trades in a row each updates its own price
   independently, and one history slot per trade checked would drown out
   anything meaningful within the 5-entry cap; only the settled total after
   a burst of changes gets recorded. `totalCostFor` also refuses to return
   a total at all (rather than a technically-valid-looking but wrong one)
   if a divine-priced trade exists but the exchange rate hasn't loaded yet
   to convert it — see the note above that function. While collapsed the
   header just shows the last value it recorded
   (`folder.totalCostHistory`, cached on the folder itself) without a
   trades fetch, which can go stale until you next open that folder — see
   the note above `totalCostFor` and `renderTrades` in `bookmarks.js`. Its
   own history (separate from each trade's) can be reset from the folder's
   `···` menu — "Reset Total Cost trend" keeps the current number but
   drops the trend baseline; "Clear price history for this folder" wipes
   every trade's price history (and Total Cost along with it, since it has
   nothing left to sum). Working.
2. **Saved listings** — a manually-saved snapshot of one specific trade offer
   (item, price, seller, its rolled mods), captured via a **Save listing**
   button on each result row's own button cluster, on its own line below it
   (`.details .btns`, same spot the old pinned.js used for 📌). Replaced
   History's auto-tracking in v0.3. Selectors verified 2026-08 against a
   real unique item's row — see the note at the top of `saved.js`. The price
   shows its currency's own icon (chaos/divine orb), read from GGG's CDN at
   save time (`priceIcon`) since a saved listing has no live row left to
   re-read it from later. Each listing also has **Search this exact item**:
   calls GGG's trade-search API directly (item name/type + each rolled
   mod's own stat id, both min and max set to the exact rolled value) and
   opens the real results in a new tab — not a prefilled query. This is a
   deliberate, narrow exception to the hard boundary below, not a general
   permission — see that section for the full reasoning and the guardrails
   (rate-limited against GGG's own response headers, PoE1 only for now,
   search only, never fetch), and the comment above `searchTrade` in
   `saved.js` for the implementation. Two other designs were tried first
   and dropped: typing every stat into "+ Add Stat Filter" one at a time
   (worked but was tedious — one click per stat, vs. one API call for all
   of them), and filling item name + Seller Account onto the listing's
   original search (didn't survive real testing — see `CLAUDE.local.md`
   for that whole back-and-forth). Each listing also keeps a rolling
   `priceHistory` (oldest first, capped at 5, same shape and dedup as a
   bookmark trade's own — see `PH.store.pushTradePrice`), seeded from the
   price captured at save time and appended to whenever "Search this exact
   item" turns up real results — a same price just refreshes the latest
   entry's timestamp rather than taking a slot, so it only grows on an
   actual change. The card shows the latest price; hovering it shows the
   full history once there's more than one entry. See the note above
   `capturePendingPrice` in `saved.js`. A checkbox on each listing plus
   **Clear all**/**Clear selected** remove listings in bulk, scoped to
   whichever game's listings are currently shown — `PH.store.deleteSavedListings`
   does it in one storage write. Only **Clear all** confirms first; **Clear
   selected** acts immediately, since checking rows one at a time is
   already a deliberate choice.
3. **Auto-`~`** — a leading `~` makes the stat filter search fuzzy, so it's
   typed into every empty stat box, including one you just deleted it from —
   the popup toggle is the only way to turn this off. (An earlier version
   opted a box out once you deleted the `~` from it; that behavior was
   removed in favor of always refilling.) Selector still unverified against
   the live site.
4. **Chaos ↔ divine** — annotates listing prices. Rate from poe.ninja, cached
   15 minutes. Selectors taken from Better Trading's source, so known-good.
   The amount-parsing half was actually wrong until it was re-verified
   against the real live site in v0.3 — see the note at the top of
   `prices.js`. Working now.

**Removed in this session**: the Live searches tab (a flat, folder-less
watchlist duplicating a bookmark trade's location shape). Its one
differentiator, "Open live search," just opened GGG's own `/live` tab — a
bookmark trade's own `···` menu already has that same "Open live search"
item, so the tab added nothing a folder didn't already cover once you'd
saved the search there. Deleted `src/content/live-searches.js`, its manifest
entry, its `PH.store` functions (`getLiveSearches`/`saveLiveSearch`/
`deleteLiveSearch`/`reorderLiveSearches`) and `liveSearches` storage key, its
panel tab, and its `test/logic-test.js` coverage.

## Rules for this codebase

- **Plain JS, no frameworks, no bundler.** The whole point is that every line
  stays readable without a build step. Do not introduce npm, TypeScript, or a
  build step without asking first.
- **A bookmark stores no league.** `location` is `{version, type, slug}`. The
  league is resolved at click time (pinned league → current page → last seen
  for that game, tracked by `PH.store.noteLeague` on every URL change). This
  is what makes it survive a league reset — do not "fix" it by storing the
  league. A saved listing _does_ keep its league, because it's a record of a
  specific past moment, not a reusable search.
- **Selectors live at the top of the file that uses them**, with a comment
  saying whether they're verified. Never invent one; gate a feature off rather
  than shipping a guess that fails silently.
- **All network calls go in the service worker — except calling GGG's own
  trade-search API for "Search this exact item," which stays in the content
  script.** A content script inherits pathofexile.com's same-origin rules,
  so it cannot fetch poe.ninja (and `host_permissions` does not change that),
  but calling pathofexile.com itself from a content script already running
  there is same-origin and needs no elevated permission — see the
  hard-boundary section below for why that one call exists at all.
- **The content script sends parameters, never URLs.** The service worker
  builds every URL itself from values it controls.
- **Register every `addListener` at the top level** of the service worker. It
  is shut down after ~30s idle and restarted on the next event.
- **Every DOM enhancer marks what it touched** (`ph-tilde`, `ph-pinnable`,
  `ph-priced`) and selects with `:not([mark])`. Our own edits re-trigger the
  MutationObserver; the marks are what stop the loop.
- **A bookmark stores a search reference, not a listing.** Its `location` is
  just `{version, type, slug}` — no price, item, or seller data, so
  persisting it is safe: reopening it just re-runs the search rather than
  showing a snapshot of results that may already be sold. **Saved listings
  are the exception**, and it's an intentional one: they exist specifically
  to remember a price/item/seller snapshot, labelled and treated as a
  point-in-time record (see `PH.store.saveSavedListing`) — never persist
  live DOM (a clone of the row) the way the old pinned-items feature did.
- **Import/export must stay byte-compatible with Better Trading.** Format is
  `"<v>:" + base64(JSON)` with keys `icn/tit/ver/trs/loc`; v1 has no prefix
  and Latin-1 base64. `test/logic-test.js` checks this against their own
  fixture. Real saved data depends on this staying correct — breaking it
  loses folders and searches on import.

## Hard boundary: what this extension must never do

GGG's Terms of Use forbid automated software acting on their site (§7c), data
extraction/scraping (§7f), and reverse-engineering undocumented endpoints
(§7i — and `/api/trade/*` is _not_ in their developer docs). Their developer
docs also require that macros be manually invoked, one action per invocation.
Verified directly (2026-08, not just asserted): fetched
pathofexile.com/developer/docs itself — its API Reference lists Account
Profile/Characters/Stashes, Leagues, PvP Matches, Guild/Public Stashes, and
Currency Exchange, and nothing else; there is no Trade or Trade Search
endpoint anywhere in it. The `/api/trade/search` and `/api/trade/fetch`
endpoints third-party tools use (confirmed by reading Awakened PoE Trade's
actual source, `renderer/src/web/price-check/trade/pathofexile-trade.ts`)
are the trade website's own internal API, not anything GGG published. The
same docs page states the macro rule verbatim: "Macros must be invoked
manually by the user... each macro invocation must perform a single
function, and the resulting function must execute only one action with the
game."

So: **this extension reads the page the user already loaded and stores things
locally.** It does not send whispers, click buttons on a timer, open
live-search websockets, or bulk-collect listings. The "Open live search" menu
item opens a normal tab and lets the trade site do its own thing — we never
hold that socket ourselves. If a feature request would need any of that, say
so and stop rather than building it.

**One deliberate, narrow exception** (added 2026-08, a conscious policy
decision, revisited more than once before settling — see `CLAUDE.local.md`
for the full back-and-forth — not a default to reach for again without the
same kind of conversation): Saved listings' **Search this exact item** calls
`/api/trade/search` directly — see `searchTrade` in `saved.js`. This was
chosen after weighing real precedent: Awakened PoE Trade and
PoE-Overlay-Community-Fork both call this same endpoint (confirmed by
reading their actual source — the latter's `PoEHttpService.search`/
`TradeRateLimitService` were the model for our own rate limiter) and are
widely used without evidence of GGG taking action against ordinary users of
well-behaved tools. It's still not risk-free — the endpoint isn't a contract
GGG owes anyone, it can change or be restricted for non-browser traffic
without notice, and using it runs under the account that's logged into the
browser. The scope stays narrow on purpose:
  - **Content script, not service worker** — the request targets
    pathofexile.com itself, which the content script already runs on, so
    it's same-origin (automatic cookies, no CORS) and needs no new
    `host_permissions` entry.
  - **Only ever fired by an explicit click** — never polled, never batched,
    never on a timer.
  - **Rate-limited against GGG's own headers** — every response's
    `x-rate-limit-*` headers are parsed and a request is refused with a
    toast, not silently retried, if we'd exceed what GGG just told us our
    budget is. See `tradeSearchCooldown` in `store.js`.
  - **Search only, never fetch** — we only need the search `id` to build a
    results URL; we never call `/api/trade/fetch` to pull listing data
    ourselves, unlike APT/PoE-Overlay's price-check features.
  Any other undocumented-endpoint use (whispers, `/api/trade/fetch`, bulk
  collection, anything on PoE2's `/api/trade2/*` — not yet verified to have
  the same shape, so not supported) would need this same kind of explicit,
  recorded decision, not an assumption that the door is now open generally.

The other host we contact is poe.ninja: a cached exchange rate, and (PoE1
uniques only) cached item-price data for the "poe.ninja average" badge in
Bookmarks. Both are read-only lookups against poe.ninja's own public data,
cached for `CACHE_MINUTES`, never a per-item live request.

Public-facing copy must include: "This product isn't affiliated with or
endorsed by Grinding Gear Games in any way."

## Testing

`node test/logic-test.js` covers storage, URL/league logic, and import/export.
Everything else needs the browser:

1. `opera://extensions` (Ctrl+Shift+E) → reload the extension card.
2. Reload the trade page (content script changes need _both_).
3. F12 on the trade page → Console → filter `PoE Helper`.
4. `opera://extensions` → "service worker" link → separate console for the
   background script. Close that window before believing it works; having it
   open keeps the worker alive and hides idle-shutdown bugs.

When handing off a DOM problem, paste the element's **outerHTML** from
DevTools (right-click the element → Copy → Copy outerHTML), not a screenshot
or a description. That's the difference between a fix and a guess.

## Local notes

Current priorities, session-to-session progress, and developer-specific
context live in `CLAUDE.local.md`, which is gitignored and never committed.
This file (`CLAUDE.md`) stays limited to architecture and rules that are safe
to ship in the repo.
