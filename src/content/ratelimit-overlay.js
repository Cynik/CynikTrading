/* =========================================================================
   ratelimit-overlay.js — feeds the panel header's "Rate" pill with GGG's
   own trade-API rate-limit budget.
   =========================================================================
   Awakened PoE Trade shows this the same way: a small always-visible
   indicator with every window's real numbers ("1 / 5 over 12s"), not a
   filtered-down summary and not just a toast once a call has already been
   refused. This never makes a request of its own, and there is no GGG
   endpoint that reports your current rate-limit usage on demand — verified
   against APT's own source (renderer/src/web/price-check/trade/common.ts,
   pathofexile-trade.ts): its RATE_LIMIT_RULES are only ever corrected by
   adjustRateLimits(), called right after its own real /api/trade/search and
   /api/trade/fetch responses, exactly the two calls and the exact same
   x-rate-limit-* headers saved.js's searchTrade/fetchListingHeaders already
   read (see parseRateLimitHeaders there, which calls update() below with
   what it just parsed).

   Two gaps beyond that real-header data are closed here:

   1. Decay. APT's own counts drop locally between requests, because each of
      *its* requests is tracked individually and expires off a local
      sliding-window array once its own window elapses (RateLimiter.ts's
      ResourceHandle). We only ever see the aggregate count GGG reported as
      of the last real call, not individual request timestamps, so
      linesFor's decay below approximates the same effect: once a full
      window has passed since that last observation, every earlier request
      must have aged out of it, so the count is shown as 0 again.

   2. Bookmark-link clicks. Opening a saved search from the Bookmarks tab is
      a plain navigation (see PH.bookmarks' tradeRow) — it leaves this tab
      before any response comes back, so we never get real headers for
      whatever request(s) it actually makes on GGG's side. What we *do*
      know is that we caused it, so PH.store.recordTradeLinkClick logs the
      click, and linesFor below adds however many of those fall inside a
      given window's period on top of that window's decayed real count —
      an estimate, not a real reading, and applied to every currently-known
      policy rather than guessing which one a bookmarked search's own page
      load actually draws from.

   Both persist to chrome.storage (PH.store.tradeRateState/tradeLinkClicks)
   so a fresh page load — which is exactly what happens after a bookmark
   click — still has real numbers to decay from and real clicks to count,
   not just whatever this tab's own in-memory state happened to see.

   The pill itself lives in panel.js (PH.panel.setRateLimit) since it's part
   of the panel's own header, not a floating element of its own.
   ========================================================================= */

window.PH = window.PH || {};

PH.rateLimitOverlay = (() => {
  const state = {}; // { search: { policy, entries, blockedUntil, recordedAt }, fetch: { ... } }
  let linkClicks = [];
  let tickTimer = null;

  /* One line per window GGG reports, in the same "current / max over Ns"
     shape a real rate-limit inspector shows — every window, including ones
     sitting at 0, not only whichever is closest to its cap. `hot` is true
     for a window within 2 requests of its max (one more than
     rateLimitCooldown's own -1 margin in saved.js already treats as
     blocking, so this flags a call earlier still) or already in cooldown. */
  function linesFor({ policy, entries, blockedUntil, recordedAt }) {
    const now = Date.now();
    const lines = [`Policy: ${policy || "unknown"}`];
    let hot = false;

    if (blockedUntil && blockedUntil > now) {
      lines.push(`blocked ${Math.ceil((blockedUntil - now) / 1000)}s`);
      hot = true;
    }

    for (const { maxCount, period, currentCount } of entries) {
      if (maxCount <= 0) continue;
      const decayed = (now - recordedAt) / 1000 >= period ? 0 : currentCount;
      const clicksSince = linkClicks.reduce(
        (n, t) => (t > recordedAt && now - t < period * 1000 ? n + 1 : n), 0
      );
      const estimated = decayed + clicksSince;
      lines.push(`${estimated} / ${maxCount} over ${period}s${clicksSince ? " (est.)" : ""}`);
      if (maxCount - estimated <= 2) hot = true;
    }

    return { lines, hot };
  }

  function render() {
    const lines = [];
    let hot = false;

    for (const data of Object.values(state)) {
      const result = linesFor(data);
      lines.push(...result.lines);
      hot = hot || result.hot;
    }

    PH.panel?.setRateLimit(lines.length ? { hot, lines } : null);
  }

  /* Ticks once a second for as long as anything could still change on its
     own — a cooldown counting down, a window that hasn't fully decayed yet,
     or a recent bookmark-link click still inside some window's period — so
     the pill's numbers keep moving between real requests, the same live
     feel APT's per-request expiry gives it. Stops once nothing is pending,
     rather than running forever in the background. */
  function rescheduleTick() {
    clearInterval(tickTimer);
    const now = Date.now();
    const anyPending = Object.values(state).some(({ blockedUntil, recordedAt, entries }) => {
      if (blockedUntil > now) return true;
      return entries.some(({ period }) =>
        (now - recordedAt) / 1000 < period || linkClicks.some((t) => now - t < period * 1000)
      );
    });
    tickTimer = anyPending ? setInterval(() => { render(); rescheduleTick(); }, 1000) : null;
  }

  /* Called by saved.js right after a real /api/trade/search or
     /api/trade/fetch response. Persists the reading (fire-and-forget — its
     own failure shouldn't block anything this click does) so a page loaded
     later, including the one a bookmark click navigates to, still has it. */
  function update(endpoint, { policy, entries }, blockedUntil) {
    const recordedAt = Date.now();
    state[endpoint] = { policy, entries, blockedUntil, recordedAt };
    PH.store.setTradeRateState(endpoint, { policy, entries, recordedAt });
    render();
    rescheduleTick();
  }

  /* Called once at boot (main.js, right after PH.panel.mount()) to seed the
     pill with whatever the last real reading and recent bookmark clicks
     were, rather than starting blank on every fresh page load. */
  async function init() {
    const [rateState, clicks, searchCooldown, fetchCooldown] = await Promise.all([
      PH.store.getTradeRateState(),
      PH.store.getTradeLinkClicks(),
      PH.store.getTradeSearchCooldown(),
      PH.store.getTradeFetchCooldown(),
    ]);

    if (rateState?.search) state.search = { ...rateState.search, blockedUntil: searchCooldown };
    if (rateState?.fetch) state.fetch = { ...rateState.fetch, blockedUntil: fetchCooldown };
    linkClicks = clicks ?? [];

    render();
    rescheduleTick();
  }

  return { init, update };
})();
