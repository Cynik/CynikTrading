# PoE Trade Helper

This project is based in part on Better Trading by Exile Center, which is licensed under the MIT License.

Improvements to Better Trading:

- Automaically adds the fuzzy search modifier (~) to all trade search fields
-

Quality-of-life additions to the official Path of Exile trade site, as an
in-page panel.

- **Bookmarks** — folders with icons, drag to reorder, archive, mark searches
  done, share a folder as a code, back everything up to a file. Each saved
  search tracks its cheapest price over your last 5 visits, with a ▲/▼ for
  whether it's trending up or down — and for PoE1 items poe.ninja has a
  fixed catalog for (uniques, gems, corpses, ...), its average price
  alongside it.
- **Saved listings** — snapshot a specific trade offer (item, price, seller,
  its mods) with a button on each result row. "Search this exact item" takes
  you straight back to real results for that item and its rolled mods
  (PoE1 only for now), and records the price if it's changed since you
  saved it — hover the price to see its history.
- **Auto-`~`** — stat filter boxes start with `~` already typed, making the mod
  search fuzzy by default. Delete it for an exact search.
- **Chaos ↔ divine** — the other currency's value, next to each listed price.

Works on `pathofexile.com/trade` (PoE 1) and `/trade2` (PoE 2).

## Bookmarks survive a league reset

A saved search stores the search hash, not the league. When you click it, the
league is filled in from wherever you're browsing — so last league's bookmarks
open in this league without any editing. You can pin a bookmark to one specific
league if you want (rename it and tick the box).

## Install (development)

Works in any Chromium browser — Opera GX, Chrome, Edge, Brave.

1. Open the extensions page: `opera://extensions` in Opera GX (or
   Ctrl+Shift+E), `chrome://extensions` in Chrome or Edge
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder — the one containing
   `manifest.json`, not the file itself
4. Open the trade site. The panel appears on the right; the `‹` tab on its edge
   collapses it.

No Chrome Web Store account or "Install Chrome Extensions" addon is needed —
loading unpacked bypasses the store entirely.

After editing files: reload the extension card on the extensions page, then
reload the trade page.

## Moving over from Better Trading

Import is compatible with Better Trading's formats, so nothing has to be
retyped:

- **One folder** — its menu → Export/Share, copy the code, then here:
  **Import folder** and paste it.
- **Everything** — Better Trading's _Save file_, then here: **Restore from
  file**. Restoring adds folders and never deletes, so it's safe to try.

## Tests

```
node test/logic-test.js
```

Covers storage, trade-URL parsing, league resolution, and Better Trading
import/export compatibility. Panel rendering and the page selectors still need
a browser.

## Design

The extension is deliberately read-only with respect to GGG, with one narrow,
deliberate exception: **Search this exact item** (Saved listings) calls the
trade site's own search API directly, so it can take you to real results
instead of a filled-in form you still have to submit yourself — the same
approach well-established community tools like Awakened PoE Trade and
PoE Overlay use. It's rate-limited against the trade site's own response
headers and only ever runs when you click it. Nothing else in the extension
automates any in-game action or sends your data anywhere; everything else
reads the page you already have open and stores your data locally. The other
network request it makes is a currency exchange rate from poe.ninja, cached
for 15 minutes.

Exchange rate data from [poe.ninja](https://poe.ninja). Import/export format,
several verified CSS selectors, and the folder icon artwork come from
[Better Trading](https://github.com/exile-center/better-trading) (MIT).

---

This product isn't affiliated with or endorsed by Grinding Gear Games in any way.
