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
  whether it's trending up or down — and for items poe.ninja has a fixed
  catalog for (uniques on both games; PoE1 also gems, corpses, ...), its
  average price alongside it, with a 7-day trend line graph on hover.
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

Works in any Chromium browser — Opera GX, Chrome, Edge, Brave — and in Firefox.

**Chromium browsers**

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

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and pick `manifest.json` inside this
   folder
3. Open the trade site. The panel appears the same way it does on Chromium.

A temporary add-on unloads when Firefox closes, so this step needs repeating
each session — that's Firefox's own limitation for unpacked/unsigned
extensions, not something this project can skip around. After editing files,
click **Reload** next to the add-on on the same `about:debugging` page, then
reload the trade page.

---

This product isn't affiliated with or endorsed by Grinding Gear Games in any way.
