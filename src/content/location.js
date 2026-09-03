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

  /* A malformed percent-encoding in the URL would otherwise throw straight
     out of parsePath — falling back to the raw text keeps this a league
     name that just looks odd instead of an uncaught rejection that skips
     the rest of checkLocation's navigation handling in main.js. */
  function decodeSegment(segment) {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
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
      league: league ? decodeSegment(league) : null,
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

  /* league's own "poe2/Standard"/"xbox/Legion" shape (see parsePath above)
     is what buildUrl/the trade-search API both need — the realm segment is
     load-bearing there, not decoration. Showing that same string to a
     person reads as a stray "poe2/" prefix on the league name, though (a
     real report), so this strips it back off for anywhere the league is
     just being displayed, never for a value headed into a URL or API
     call. */
  function displayLeague(league) {
    if (!league) return league;
    const slash = league.indexOf("/");
    if (slash === -1) return league;
    return REALMS.includes(league.slice(0, slash)) ? league.slice(slash + 1) : league;
  }

  return { current, parsePath, parseUrl, buildUrl, resolveLeague, displayLeague };
})();
