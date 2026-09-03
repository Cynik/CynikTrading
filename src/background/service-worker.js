/* =========================================================================
   PoE Trade Helper — background service worker
   =========================================================================
   This file has no DOM: no document, no window, no page to touch. What it CAN
   do is fetch other websites, which the content script cannot.

   It is also short-lived. Chrome shuts it down after ~30 seconds of doing
   nothing and starts it again on the next message. Two consequences:
     - every addListener() call must be at the top level of this file
     - never keep anything important in a plain variable; it will vanish
   ========================================================================= */

/* See the matching note in store.js — Firefox's `browser.*` is promise-
   based, its `chrome.*` compat alias isn't, so every `await` below needs
   whichever global is actually the real one for this browser. The
   background script is its own execution context, so it gets its own
   copy of this rather than sharing store.js's (a content script). */
const browserAPI = globalThis.browser ?? globalThis.chrome;

const LOG = (...args) => console.log("[PoE Helper SW]", ...args);

/* How long we reuse a cached rate before asking poe.ninja again.
   poe.ninja's own docs say the underlying data only refreshes every ~15 min
   for PoE 1 and roughly hourly for PoE 2, so polling faster is pure waste. */
const CACHE_MINUTES = 15;

/* Which league to price against, per game. "" means "ask poe.ninja for the
   current league list and use the first one" — that's the temp league. */
const LEAGUE_OVERRIDE = { poe1: "", poe2: "" };

async function fetchJson(url) {
  // The service worker is killed if a fetch takes longer than 30 seconds,
  // so we give up at 10 and return a clean error instead.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function resolveLeague(game) {
  if (LEAGUE_OVERRIDE[game]) return LEAGUE_OVERRIDE[game];
  const leagues = await fetchJson(`https://poe.ninja/${game}/api/economy/leagues`);
  // The list is ordered with the current temp league first.
  return leagues[0].id;
}

/* Returns the full currency-rate picture for a game: how many chaos one
   divine is worth (needed for the chaos<->divine badge and for converting
   PoE2's item-price index — see the note above PRICE_CATEGORIES), plus a
   name -> chaos-equivalent-value table for every OTHER tradeable currency
   poe.ninja tracks (Orb of Alchemy, Gemcutter's Prism, ...).

   That table matters because PoE2 listings commonly get priced in
   currencies other than chaos/divine — Alchemy Orbs and Gemcutter's Prisms
   specifically (confirmed by the developer 2026-09) — so treating every
   other currency as "no rate, don't guess" meant a real, common slice of
   PoE2 listings could never be picked as the page's cheapest for Bookmarks/
   Saved price tracking (PH.prices.cheapestOnPage in prices.js), and a
   search where every visible listing happened to use one of those
   currencies captured nothing at all.

   One HTTP request already returns everything needed — poe.ninja's own
   `?type=Currency` overview carries `core` (the primary/secondary summary
   this always read), `lines` (every currency's own value as `primaryValue`,
   expressed in `core.primary`'s units), and `items` (id -> the currency's
   real display name, the same name readCurrency() in prices.js reads off a
   trade-site row). primaryValue's "expressed in the primary currency's
   units" convention was cross-checked live 2026-09 by triangulating it
   against each line's own maxVolumeRate/maxVolumeCurrency pair for known
   currencies (chaos, divine, Gemcutter's Prism) until the two independently
   agreed, rather than assumed from the field name alone — the item-price
   endpoint uses a same-named field with the same convention (see
   normalizeItem below), but that's a structurally different endpoint and
   wasn't assumed to share semantics without checking.

   poe.ninja gives a "primary" currency and rates expressed relative to it,
   and the primary is DIFFERENT between the two games:
     PoE 1: primary = chaos, rates.divine ≈ 0.0047  -> divine = 1 / 0.0047
     PoE 2: primary = divine, rates.chaos  ≈ 11.15  -> divine = 11.15
   So we handle both rather than hardcoding one. */
async function fetchCurrencyRates(game) {
  const league = await resolveLeague(game);
  const url =
    `https://poe.ninja/${game}/api/economy/exchange/current/overview` +
    `?league=${encodeURIComponent(league)}&type=Currency`;

  const data = await fetchJson(url);
  const { primary, rates } = data.core;

  let divineInChaos;
  if (primary === "chaos") {
    divineInChaos = 1 / rates.divine;
  } else if (primary === "divine") {
    divineInChaos = rates.chaos;
  } else {
    // Neither is the base — convert through the primary.
    divineInChaos = rates.chaos / rates.divine;
  }

  if (!Number.isFinite(divineInChaos) || divineInChaos <= 0) {
    throw new Error(`nonsense rate from poe.ninja: ${divineInChaos}`);
  }

  // primaryValue is already in chaos when chaos is the primary (PoE1);
  // otherwise (PoE2, primary=divine) it needs converting through divineInChaos.
  const primaryToChaos = primary === "chaos" ? 1 : divineInChaos;
  const nameById = Object.fromEntries((data.items ?? []).map((it) => [it.id, it.name]));
  const chaosValueByName = {};
  for (const line of data.lines ?? []) {
    const name = nameById[line.id];
    if (name && Number.isFinite(line.primaryValue)) {
      chaosValueByName[name] = line.primaryValue * primaryToChaos;
    }
  }

  return { divineInChaos, chaosValueByName, league, fetchedAt: Date.now() };
}

async function getCurrencyRate(game) {
  const cacheKey = `rate_${game}`;
  const stored = await browserAPI.storage.local.get(cacheKey);
  const cached = stored[cacheKey];

  /* Also requires chaosValueByName to be present, not just a fresh
     fetchedAt — a rate cached by an older version of this file (before
     chaosValueByName existed) would otherwise be served as-is for up to
     CACHE_MINUTES, silently reintroducing "no rate for this currency" for
     everything but chaos/divine until it happened to expire on its own.
     Self-heals immediately instead of needing the cache manually cleared
     or waiting out the window. */
  const ageOk =
    cached && cached.chaosValueByName && Date.now() - cached.fetchedAt < CACHE_MINUTES * 60 * 1000;
  if (ageOk) {
    LOG("using cached rate for", game);
    return cached;
  }

  const fresh = await fetchCurrencyRates(game);
  await browserAPI.storage.local.set({ [cacheKey]: fresh });
  LOG("fetched fresh rate for", game, fresh);
  return fresh;
}

/* -------------------------------------------------------------------------
   Named-item prices (for the "poe.ninja average" next to a bookmark's
   cheapest-when-saved badge) — anything with a fixed catalog name poe.ninja
   tracks. Rares aren't included: there's no such thing as "the average Rare
   Amulet," they're not a fixed catalog.

   Verified 2026-08 by loading poe.ninja's own site and watching its network
   requests — the endpoint isn't the same "exchange" one currency uses, and
   isn't documented anywhere obvious:

     https://poe.ninja/poe1/api/economy/stash/current/item/overview
       ?league=<league>&type=UniqueWeapon        (singular "Weapon")

   The two games' responses use different shapes for the price itself: PoE1
   gives explicit `chaosValue`/`divineValue` fields; PoE2 gives a single
   `primaryValue` instead. Confirmed live (2026-09, loaded poe.ninja in a
   real browser with the PoE2 tab selected) that `primaryValue` is
   denominated in divine, matching that response's own `core.primary` field
   — e.g. "The Ordained" showed as "4.0" next to the divine-orb icon for a
   raw `primaryValue: 4`, and "Quill Rain" showed "3.0" divine for
   `primaryValue: 3`. This mattered to check for real rather than assume:
   PoE2's divine-to-chaos ratio is only ~11:1 (vs PoE1's ~200:1), so a
   wrong-unit guess wouldn't have been an obviously-broken number, just a
   quietly wrong one. normalizeItem() below converts both shapes into the
   same {chaosValue, divineValue} pair so nothing downstream of this file
   needs to know which game an entry came from.

   Currency and Fragments are NOT in either list on purpose: poe.ninja prices
   those through a structurally different endpoint (id + primaryValue
   relative to a "primary" currency, no display name in the line itself —
   see fetchDivineInChaos above), not this name/chaosValue shape. Bolting
   them on would need a separate id-to-name lookup we haven't verified, so
   they stay unsupported rather than shipping a guess. PoE2 also has no
   Corpse-equivalent category (Corpses are a PoE1 Necropolis-league
   mechanic) and no gem-price entry at all — confirmed live that PoE2's
   "Uncut Gems"/"Lineage Gems" pages have no "Trade" link on any row (see
   the Trade-button rule below), unlike PoE1's SkillGem/ImbuedGem.

   Each `type=` value here was verified for real (curl'd against poe.ninja's
   live API, checked for actual `name`/price data) before being added —
   never add one on a guess; a wrong type string 404s. fetchPriceCategory
   below tolerates that (Promise.allSettled, one bad category just logs and
   drops out) so a typo can't take down every other category's prices, but
   the goal is still zero 404s in normal operation.

   Not every category poe.ninja prices is worth adding here, even once the
   type= string is known: if poe.ninja's own page for that category shows no
   "Trade" button (compare its Corpses page, which links every row straight
   to a trade search, against its Tattoos page, which has no Trade column at
   all), there's no official trade-site search for that item type, so no
   bookmark could ever be titled with that name — the price entries would
   just be dead weight in storage and never match anything. Corpses (PoE1)
   and every Unique* category below (PoE2, each checked live 2026-09) cleared
   that bar; before adding another category, check for the Trade button.

   One item name can have several price entries: different link counts, mod
   "variants" (poe.ninja calls a mutated/"Foulborn" Headhunter a separate
   line from the normal one), or — for gems — every level/quality/corrupted
   combination priced as its own line (a level 1 Greater Spell Echo Support
   and a level 78/23%-quality corrupted one are ~4x apart in price). There's
   no way to know which exact variant a saved trade's title refers to, so we
   pick whichever entry has the most listings as the representative price —
   the most commonly-traded version is the reasonable default, not a
   guarantee it matches your specific item.
   ------------------------------------------------------------------------- */

const PRICE_CATEGORIES = {
  poe1: [
    "UniqueWeapon", "UniqueArmour", "UniqueAccessory", "UniqueFlask", "UniqueJewel",
    "ForbiddenJewel", "ShrineBelt", "UniqueTincture", "UniqueRelic",
    "SkillGem", "ImbuedGem", "Corpse",
  ],
  /* Each verified live 2026-09 against poe.ninja's PoE2 economy tab: real
     data at this type= string, a "Trade" link on every row (see the rule
     above), and prices shown in divine (see normalizeItem's own note). */
  poe2: [
    "UniqueWeapons", "UniqueArmours", "UniqueAccessories", "UniqueFlasks",
    "UniqueCharms", "UniqueJewels", "UniqueSanctumRelics", "UniqueTablets",
  ],
};

/* The category-slug half of an item's own poe.ninja page URL — each one
   verified by checking a real detailsId from that category resolves at
   https://poe.ninja/<game>/economy/<league-slug>/<category-slug>/<detailsId>.
   Not derivable from PRICE_CATEGORIES by a simple rule (plurals aren't
   consistent — "Armour" -> "armours" but "SkillGem" -> "skill-gems", not
   "skillgems"; PoE2's "UniqueSanctumRelics" type= maps to the plain
   "unique-relics" slug, not "unique-sanctum-relics" — found by inspecting
   the site's own network request for its Unique Relics tab, since the
   plural-of-type-name guess 404s), so this is spelled out by hand rather
   than guessed. */
const PRICE_CATEGORY_SLUGS = {
  poe1: {
    UniqueWeapon: "unique-weapons",
    UniqueArmour: "unique-armours",
    UniqueAccessory: "unique-accessories",
    UniqueFlask: "unique-flasks",
    UniqueJewel: "unique-jewels",
    ForbiddenJewel: "forbidden-jewels",
    ShrineBelt: "shrine-belts",
    UniqueTincture: "unique-tinctures",
    UniqueRelic: "unique-relics",
    SkillGem: "skill-gems",
    ImbuedGem: "imbued-gems",
    Corpse: "corpses",
  },
  poe2: {
    UniqueWeapons: "unique-weapons",
    UniqueArmours: "unique-armours",
    UniqueAccessories: "unique-accessories",
    UniqueFlasks: "unique-flasks",
    UniqueCharms: "unique-charms",
    UniqueJewels: "unique-jewels",
    UniqueSanctumRelics: "unique-relics",
    UniqueTablets: "unique-tablets",
  },
};

/* poe.ninja's item-detail pages want a lowercased league slug, but the two
   games join multi-word league names differently — verified live 2026-09:
   PoE1 hyphenates ("Allflame" -> "allflame", a single word so unconfirmed
   for a real multi-word PoE1 league); PoE2 just strips spaces entirely
   ("Runes of Aldur" -> "runesofaldur", "Standard" -> "standard", "Hardcore"
   -> "hardcore"). Both games' LEAGUE_OVERRIDE default (the current temp
   league, always first in /leagues) resolves to a name this rule handles
   correctly. Hardcore leagues are a known exception on PoE2 (its own nav
   shows "HC Runes of Aldur" -> "runesofaldurhc" — the HC marker moves to
   the end rather than staying a prefix) and previous-league short names are
   another ("Fate of the Vaal" -> just "vaal") — neither is reachable
   through LEAGUE_OVERRIDE's default, so a wrong guess there only 404s the
   outbound poe.ninja link, same bounded blast radius the PoE1-only version
   of this comment already accepted for Hardcore. */
function leagueSlugFor(game, league) {
  return game === "poe2"
    ? league.toLowerCase().replace(/\s+/g, "")
    : league.toLowerCase().replace(/\s+/g, "-");
}

async function fetchPriceCategory(game, league, category) {
  const url =
    `https://poe.ninja/${game}/api/economy/stash/current/item/overview` +
    `?league=${encodeURIComponent(league)}&type=${category}`;
  const data = await fetchJson(url);
  return data.lines ?? [];
}

/* Normalizes one poe.ninja line item, from either game's shape, into the
   one shape everything downstream of this file (prices.js, bookmarks.js)
   reads — so callers never need to branch on which game an entry came
   from. `divineInChaos` is only used for PoE2's primaryValue-in-divine
   conversion (see the note above PRICE_CATEGORIES); PoE1 lines already
   carry both chaosValue and divineValue directly and ignore it. */
function normalizeItem(game, it, category, leagueSlug, divineInChaos) {
  const chaosValue = game === "poe2" ? it.primaryValue * divineInChaos : it.chaosValue;
  const divineValue = game === "poe2" ? it.primaryValue : it.divineValue;

  return {
    name: it.name,
    baseType: it.baseType,
    chaosValue,
    divineValue,
    listingCount: it.listingCount ?? it.count ?? 0,
    /* Gems only (PoE1) — absent entirely on non-gem items, and absent
       (rather than 0/false) on a gem itself when quality is 0 or it isn't
       corrupted. PoE2 has no gem category here (see the note above
       PRICE_CATEGORIES), so these are always absent for a PoE2 entry. */
    gemLevel: it.gemLevel,
    gemQuality: it.gemQuality,
    corrupted: it.corrupted,
    ninjaUrl: it.detailsId
      ? `https://poe.ninja/${game}/economy/${leagueSlug}/${PRICE_CATEGORY_SLUGS[game][category]}/${it.detailsId}`
      : null,
    /* poe.ninja's own 7-day trend line — a series of % change values
       relative to the oldest point (always 0), not absolute chaos prices.
       Verified 2026-08 against the live endpoint (a real Headhunter entry
       came back `{ totalChange: 9.09, data: [0, 3.31, -9.20, -8.01, -3.68,
       8.90, 9.09] }`). totalChange is poe.ninja's own summary number for
       the same series (not always exactly the last data point), kept
       alongside it rather than re-derived. Can be a short or empty array
       for a thinly-traded item — callers check length before drawing
       anything with it. */
    sparkline: it.sparkLine?.data ?? [],
    sparklineChange: it.sparkLine?.totalChange ?? null,
  };
}

async function getItemPriceIndex(game) {
  const cacheKey = `itemPrices_${game}`;
  const stored = await browserAPI.storage.local.get(cacheKey);
  const cached = stored[cacheKey];

  const ageOk = cached && Date.now() - cached.fetchedAt < CACHE_MINUTES * 60 * 1000;
  if (ageOk) return cached;

  const league = await resolveLeague(game);
  const leagueSlug = leagueSlugFor(game, league);
  /* Only PoE2 needs this — its lines carry a single primaryValue in divine,
     not PoE1's already-split chaosValue/divineValue — but it's cheap either
     way since getCurrencyRate has its own 15-minute cache shared with the
     chaos<->divine badge feature, so this rarely triggers a real fetch. */
  const { divineInChaos } = game === "poe2" ? await getCurrencyRate(game) : {};

  const categories = PRICE_CATEGORIES[game];
  const results = await Promise.allSettled(
    categories.map((c) => fetchPriceCategory(game, league, c))
  );
  const lists = results.map((r, i) => {
    if (r.status === "rejected") {
      LOG(`price category "${categories[i]}" failed, skipping:`, r.reason);
      return [];
    }
    return r.value.map((it) => normalizeItem(game, it, categories[i], leagueSlug, divineInChaos));
  });

  const items = lists.flat();

  const fresh = { items, league, fetchedAt: Date.now() };
  await browserAPI.storage.local.set({ [cacheKey]: fresh });
  LOG(`fetched ${items.length} item prices (${game}, ${league})`);
  return fresh;
}

/* -------------------------------------------------------------------------
   Message handling.

   Security note worth internalising: the content script sends us a game name
   ("poe1"/"poe2"), never a URL. If it could hand us any URL to fetch, a
   malicious page could use this extension as a proxy with our permissions.
   Build the URL here, from values we control.
   ------------------------------------------------------------------------- */
browserAPI.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "GET_CURRENCY_RATE") return; // not ours, ignore

  const game = msg.game === "poe2" ? "poe2" : "poe1";

  getCurrencyRate(game)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));

  // Returning true keeps the message channel open so the async sendResponse
  // above actually lands. Forget this line and the reply silently disappears.
  return true;
});

browserAPI.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "GET_ITEM_PRICE_INDEX") return; // not ours, ignore

  const game = msg.game === "poe2" ? "poe2" : "poe1";

  getItemPriceIndex(game)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true;
});

LOG("service worker started");
