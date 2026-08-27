/* =========================================================================
   location.js — reading the trade URL, and building links back to it.
   =========================================================================
   A PoE trade URL looks like one of these:

     /trade/search/Allflame/aBc123          PoE 1, PC
     /trade2/search/poe2/Standard/aBc123    PoE 2 (extra realm segment)
     /trade/exchange/Allflame/aBc123        bulk currency exchange
     /trade/search/xbox/Legion/aBc123       console realms, same shape as PoE 2

   So the league is either one segment ("Allflame") or two joined by a slash
   ("xbox/Legion"). Everything downstream treats it as one opaque string.
   ========================================================================= */

window.PH = window.PH || {};

PH.location = (() => {
  const BASE = "https://www.pathofexile.com";
  const REALMS = ["xbox", "sony", "poe2"];

  function parseVersion(firstSegment) {
    return firstSegment === "trade2" ? "2" : "1";
  }

  /* Pull a location out of any pathname. Returns nulls for the parts that
     aren't there, so callers can check what they got. */
  function parsePath(pathname) {
    const parts = pathname.split("/").slice(1);
    let versionPart, type, league, slug, live;

    if (REALMS.includes(parts[2])) {
      const [v, t, realm, leagueInRealm, s, l] = parts;
      versionPart = v; type = t; slug = s; live = l;
      league = leagueInRealm ? `${realm}/${leagueInRealm}` : null;
    } else {
      [versionPart, type, league, slug, live] = parts;
    }

    return {
      version: parseVersion(versionPart),
      type: type || null,
      league: league ? decodeURIComponent(league) : null,
      slug: slug || null,
      isLive: live === "live",
    };
  }

  const current = () => parsePath(window.location.pathname);

  function parseUrl(url) {
    try {
      return parsePath(new URL(url).pathname);
    } catch {
      return null;
    }
  }

  /* League names contain spaces and parentheses ("Curse of the Allflame",
     "Hardcore (Ruthless)"). encodeURIComponent escapes the parentheses too,
     which GGG's own links don't, so we put those back. */
  function encodeSegment(segment) {
    return segment
      .split("/")
      .map((part) =>
        encodeURIComponent(part).replace(/%28/g, "(").replace(/%29/g, ")")
      )
      .join("/");
  }

  function buildUrl(location, league, { live = false } = {}) {
    if (!league || !location?.type || !location?.slug) return null;
    const base = location.version === "2" ? "trade2" : "trade";
    const url = [BASE, base, location.type, encodeSegment(league), location.slug].join("/");
    return live ? `${url}/live` : url;
  }

  /* A fresh, empty search — no slug, because there isn't one yet. GGG only
     hands out a slug after you actually submit a search from their own form,
     so this is as far as a URL alone can get you toward "start a new
     search"; the rest (typing the item name, adding stat filters, hitting
     Search) has to happen in the page itself. */
  function buildBlankSearchUrl(version, league) {
    if (!league) return null;
    const base = version === "2" ? "trade2" : "trade";
    return [BASE, base, "search", encodeSegment(league)].join("/");
  }

  /* ----------------------------------------------------------------------
     Which league should a bookmark open in?

     This is the feature that makes bookmarks survive a league reset. A saved
     search stores no league, so we pick one, in this order:

       1. a league pinned onto the bookmark itself (you asked for Standard)
       2. the league of the page you're looking at right now
       3. the last league we saw you browsing for that game

     Anything left over means we genuinely don't know — the link renders
     disabled rather than sending you somewhere broken.
     ---------------------------------------------------------------------- */
  function resolveLeague(location, { pageLocation, lastSeenLeagues }) {
    if (location.league) return location.league;
    if (pageLocation?.league && pageLocation.version === location.version) {
      return pageLocation.league;
    }
    return lastSeenLeagues?.[location.version] ?? null;
  }

  return { current, parsePath, parseUrl, buildUrl, buildBlankSearchUrl, resolveLeague, encodeSegment };
})();
