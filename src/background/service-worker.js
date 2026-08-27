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

/* Returns how many chaos one divine is worth.

   poe.ninja gives us a "primary" currency and rates expressed relative to it,
   and the primary is DIFFERENT between the two games:
     PoE 1: primary = chaos, rates.divine ≈ 0.0047  -> divine = 1 / 0.0047
     PoE 2: primary = divine, rates.chaos  ≈ 11.15  -> divine = 11.15
   So we handle both rather than hardcoding one. */
async function fetchDivineInChaos(game) {
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

  return { divineInChaos, league, fetchedAt: Date.now() };
}

async function getCurrencyRate(game) {
  const cacheKey = `rate_${game}`;
  const stored = await chrome.storage.local.get(cacheKey);
  const cached = stored[cacheKey];

  const ageOk =
    cached && Date.now() - cached.fetchedAt < CACHE_MINUTES * 60 * 1000;
  if (ageOk) {
    LOG("using cached rate for", game);
    return cached;
  }

  const fresh = await fetchDivineInChaos(game);
  await chrome.storage.local.set({ [cacheKey]: fresh });
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

   PoE1-only for now. PoE2 *does* track unique items too (its economy nav has
   an "Equipment" section, easy to miss because the sidebar only renders it
   once scrolled into view) at the same path with pluralised type names
   (type=UniqueWeapons) — but its response uses a single `primaryValue`
   field instead of PoE1's explicit `chaosValue`/`divineValue`, and we
   haven't confirmed what unit/scale that's actually in. Guessing wrong here
   means showing a confidently-wrong price, which is worse than showing
   nothing — so PoE2 stays unsupported until that's verified for real.

   Currency and Fragments are NOT in this list on purpose: poe.ninja prices
   those through a structurally different endpoint (id + primaryValue
   relative to a "primary" currency, no display name in the line itself —
   see fetchDivineInChaos above), not this name/chaosValue shape. Bolting
   them on would need a separate id-to-name lookup we haven't verified, so
   they stay unsupported rather than shipping a guess.

   Each `type=` value here was verified for real (curl'd against poe.ninja's
   live API, checked for actual `name`/`chaosValue` data) before being added
   — never add one on a guess; a wrong type string 404s. fetchPriceCategory
   below tolerates that (Promise.allSettled, one bad category just logs and
   drops out) so a typo can't take down every other category's prices, but
   the goal is still zero 404s in normal operation.

   Not every category poe.ninja prices is worth adding here, even once the
   type= string is known: if poe.ninja's own page for that category shows no
   "Trade" button (compare its Corpses page, which links every row straight
   to a trade search, against its Tattoos page, which has no Trade column at
   all), there's no official trade-site search for that item type, so no
   bookmark could ever be titled with that name — the price entries would
   just be dead weight in storage and never match anything. Corpses cleared
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

const PRICE_CATEGORIES = [
  "UniqueWeapon", "UniqueArmour", "UniqueAccessory", "UniqueFlask", "UniqueJewel",
  "ForbiddenJewel", "ShrineBelt", "UniqueTincture", "UniqueRelic",
  "SkillGem", "ImbuedGem", "Corpse",
];

/* The category-slug half of an item's own poe.ninja page URL — each one
   verified 2026-08 by checking a real detailsId from that category resolves
   at https://poe.ninja/poe1/economy/<league-slug>/<category-slug>/<detailsId>.
   Not derivable from PRICE_CATEGORIES by a simple rule (plurals aren't
   consistent — "Armour" -> "armours" but "SkillGem" -> "skill-gems", not
   "skillgems"), so this is spelled out by hand rather than guessed. */
const PRICE_CATEGORY_SLUGS = {
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
};

async function fetchPriceCategory(league, category) {
  const url =
    `https://poe.ninja/poe1/api/economy/stash/current/item/overview` +
    `?league=${encodeURIComponent(league)}&type=${category}`;
  const data = await fetchJson(url);
  return data.lines ?? [];
}

async function getItemPriceIndex() {
  const cacheKey = "itemPrices_poe1";
  const stored = await chrome.storage.local.get(cacheKey);
  const cached = stored[cacheKey];

  const ageOk = cached && Date.now() - cached.fetchedAt < CACHE_MINUTES * 60 * 1000;
  if (ageOk) return cached;

  const league = await resolveLeague("poe1");
  /* poe.ninja's own item-detail pages want a lowercased, hyphenated league
     slug — verified 2026-08 for single-word leagues ("Allflame" ->
     "allflame", "Standard" -> "standard"), which is what LEAGUE_OVERRIDE's
     default always resolves to. Multi-word Hardcore league slugs are
     unverified; a wrong guess there just means a poe.ninja link 404s,
     nothing breaks in the extension itself. */
  const leagueSlug = league.toLowerCase().replace(/\s+/g, "-");

  const results = await Promise.allSettled(
    PRICE_CATEGORIES.map((c) => fetchPriceCategory(league, c))
  );
  const lists = results.map((r, i) => {
    if (r.status === "rejected") {
      LOG(`price category "${PRICE_CATEGORIES[i]}" failed, skipping:`, r.reason);
      return [];
    }
    return r.value.map((it) => ({ ...it, category: PRICE_CATEGORIES[i] }));
  });

  const items = lists.flat().map((it) => ({
    name: it.name,
    baseType: it.baseType,
    chaosValue: it.chaosValue,
    divineValue: it.divineValue,
    listingCount: it.listingCount ?? it.count ?? 0,
    /* Gems only — absent entirely on non-gem items, and absent (rather than
       0/false) on a gem itself when quality is 0 or it isn't corrupted. */
    gemLevel: it.gemLevel,
    gemQuality: it.gemQuality,
    corrupted: it.corrupted,
    ninjaUrl: it.detailsId
      ? `https://poe.ninja/poe1/economy/${leagueSlug}/${PRICE_CATEGORY_SLUGS[it.category]}/${it.detailsId}`
      : null,
  }));

  const fresh = { items, league, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [cacheKey]: fresh });
  LOG(`fetched ${items.length} item prices (${league})`);
  return fresh;
}

/* -------------------------------------------------------------------------
   Message handling.

   Security note worth internalising: the content script sends us a game name
   ("poe1"/"poe2"), never a URL. If it could hand us any URL to fetch, a
   malicious page could use this extension as a proxy with our permissions.
   Build the URL here, from values we control.
   ------------------------------------------------------------------------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "GET_CURRENCY_RATE") return; // not ours, ignore

  const game = msg.game === "poe2" ? "poe2" : "poe1";

  getCurrencyRate(game)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));

  // Returning true keeps the message channel open so the async sendResponse
  // above actually lands. Forget this line and the reply silently disappears.
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "GET_ITEM_PRICE_INDEX") return; // not ours, ignore

  getItemPriceIndex()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true;
});

LOG("service worker started");
