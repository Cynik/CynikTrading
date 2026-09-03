/* =========================================================================
   panel.js — the slide-out panel itself: shell, tabs, collapse.
   =========================================================================
   We don't touch the trade site's own layout beyond one thing: adding a class
   to <body> that narrows GGG's #trade (the real results/filters container —
   not #app, which is an empty leftover Vue mount point) so our fixed-position
   panel isn't sitting on top of the results. Collapsing slides the panel off
   the right edge and gives the width back.
   ========================================================================= */

window.PH = window.PH || {};

PH.panel = (() => {
  const COLLAPSE_KEY = "ph-panel-collapsed";

  const TABS = [
    { id: "bookmarks", label: "Bookmarks", glyph: "🗀" },
    { id: "saved", label: "Saved", glyph: "💾" },
  ];

  let root = null;
  let bodyEl = null;
  let ratePill = null;
  let rateLines = ["No trade-API calls made yet this session.", 'Use "Search this exact item" to check.'];
  let currentTab = "bookmarks";
  const renderers = {}; // tab id -> function(container)

  /* Tab renderers are async (they read from browser storage). A single store
     write can trigger refresh() twice in quick succession — once directly,
     once more from the storage.onChanged listener reacting to that same
     write — so two renders can be in flight at once. If both appended
     straight into the live body, the second render's clear-and-append would
     race the first one's still-pending appends and everything would show up
     twice. Instead each render builds into an off-screen scratch element,
     and only the most recently *requested* render is allowed to swap its
     finished result into the visible body — a stale one is just discarded. */
  let renderToken = 0;

  /* localStorage is the right home for this: it's per-browser UI state, not
     data worth syncing or backing up, and reading it is synchronous so the
     panel opens in the correct state with no flicker. */
  const isCollapsed = () => localStorage.getItem(COLLAPSE_KEY) === "true";

  function setCollapsed(collapsed) {
    const scrollY = window.scrollY;

    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
    document.body.classList.toggle("ph-collapsed", collapsed);
    const chevron = root.querySelector(".ph-collapse");
    if (chevron) {
      chevron.textContent = collapsed ? "‹" : "›";
      chevron.setAttribute("aria-label", collapsed ? "Show panel" : "Hide panel");
      chevron.setAttribute("aria-expanded", String(!collapsed));
    }

    /* #trade's width transition (panel.css) can momentarily shrink its
       height mid-reflow while it animates, and the browser clamps scroll
       position to fit whatever height briefly results — a clamp that
       sticks even once the layout settles back to its real (taller)
       height. Restoring the pre-toggle scroll position, both right away and
       again once the 0.2s transition has finished, undoes that clamp
       whichever moment it happened at. */
    window.scrollTo(0, scrollY);
    setTimeout(() => window.scrollTo(0, scrollY), 250);
  }

  function registerTab(id, renderer) {
    renderers[id] = renderer;
  }

  function selectTab(id) {
    if (!renderers[id]) return;
    currentTab = id;

    for (const btn of root.querySelectorAll(".ph-tab")) {
      btn.classList.toggle("ph-tab-active", btn.dataset.tab === id);
      btn.setAttribute("aria-selected", String(btn.dataset.tab === id));
    }
    renderBody();
  }

  async function renderBody() {
    if (!bodyEl) return;
    const renderer = renderers[currentTab];
    if (!renderer) { bodyEl.textContent = ""; return; }

    const token = ++renderToken;
    const scratch = document.createElement("div");
    await renderer(scratch);
    if (token !== renderToken) return; // a newer render started; drop this one
    /* Whatever a hover popup was anchored to is about to be replaced. */
    PH.ui.closeHoverPopup();
    bodyEl.replaceChildren(...scratch.childNodes);
  }

  /* Called by the tabs whenever they change something, and by main.js when
     storage changes underneath us. */
  function refresh() {
    if (root) renderBody();
  }

  function build() {
    const { el } = PH.ui;

    /* --- header: collapse chevron + title ------------------------------- */
    const collapse = el("button", {
      class: "ph-collapse",
      type: "button",
      onclick: () => setCollapsed(!isCollapsed()),
    });
    /* Wired once here, not via a `title` set on el() above — this button's
       own label flips ("Show panel"/"Hide panel") every toggle, and
       hoverPopup only re-reads a `lines` function fresh on each hover, not
       on every DOM mutation, so setCollapsed below just updates textContent/
       aria-expanded and leaves this alone rather than re-wiring a fresh
       hoverPopup (and a fresh, stacked set of listeners) on every click. */
    PH.ui.hoverPopup(collapse, () => [isCollapsed() ? "Show panel" : "Hide panel"]);
    const title = el("div", { class: "ph-title", text: "Trade Helper" });

    /* Always visible, like Awakened PoE Trade's own rate-limit indicator —
       but honest about not having real numbers yet rather than fabricating
       a "0/0" reading before the extension has actually made a trade-API
       call (see rateLines' initial value below and ratelimit-overlay.js,
       which is what replaces it with real data). The lines shown on hover
       are read lazily via the `rateLines` closure, since this pill is built
       once here and never recreated, but its content keeps changing for as
       long as the panel stays open. */
    ratePill = el("span", { class: "ph-ratelimit-pill", text: "Rate Limit Info" });
    PH.ui.hoverPopup(ratePill, () => rateLines, { title: "Trade-API rate limit" });

    const header = el("div", { class: "ph-header" }, collapse, title, ratePill);

    /* --- tab strip ------------------------------------------------------ */
    const tabButtons = TABS.map((tab) =>
      el("button", {
        class: "ph-tab",
        type: "button",
        dataset: { tab: tab.id },
        role: "tab",
        onclick: () => selectTab(tab.id),
      },
        el("span", { class: "ph-tab-glyph", text: tab.glyph }),
        el("span", { text: tab.label })
      )
    );
    const tabs = el("div", { class: "ph-tabs", role: "tablist" }, ...tabButtons);

    /* --- body ----------------------------------------------------------- */
    bodyEl = el("div", { class: "ph-body" });

    root = el("div", { id: "ph-panel", role: "complementary", "aria-label": "PoE Trade Helper" },
      header, tabs, bodyEl);
    document.body.appendChild(root);

    document.body.classList.add("ph-active");
    setCollapsed(isCollapsed());

    /* Deliberately NOT restoring whichever tab was last open (this used to
       persist it to localStorage) — per an explicit ask, every fresh page
       load should land on Bookmarks regardless of what you were looking at
       last, not just on the very first visit. currentTab already defaults
       to "bookmarks" at module scope, so there's nothing to set here;
       switching tabs mid-session (selectTab) still works exactly the same,
       it just no longer outlives the page. */
  }

  /* Called by ratelimit-overlay.js on every render pass (both right after a
     real trade-API response and on its own once-a-second decay tick — see
     that file). `status` is null (nothing recorded yet this session, or
     everything's decayed back to untouched) or { hot, lines } — `hot` true
     once any endpoint is within the warning margin or already in cooldown,
     turning the pill from its normal gold to red; `lines` is what the hover
     popup shows, GGG's own policy name plus one line per rate-limit window.
     The pill itself never hides — falls back to the same "no data yet"
     lines it starts with instead of going blank. */
  function setRateLimit(status) {
    if (!ratePill) return;
    rateLines = status?.lines?.length
      ? status.lines
      : ["No trade-API calls made yet this session.", 'Use "Search this exact item" to check.'];
    ratePill.classList.toggle("ph-ratelimit-hot", Boolean(status?.hot));
  }

  function mount() {
    /* If the trade app isn't on the page, the site is in maintenance or we're
       on some other /trade sub-page. Don't inject anything. */
    if (!document.querySelector("#trade")) {
      console.log("[PoE Helper] no #trade element — not mounting the panel");
      return false;
    }
    if (document.getElementById("ph-panel")) return true;
    build();
    selectTab(currentTab);
    return true;
  }

  return { mount, refresh, registerTab, setRateLimit };
})();
