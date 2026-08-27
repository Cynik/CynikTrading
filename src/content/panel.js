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
  const TAB_KEY = "ph-panel-tab";

  const TABS = [
    { id: "bookmarks", label: "Bookmarks", glyph: "🗀" },
    { id: "saved", label: "Saved", glyph: "🏷" },
  ];

  let root = null;
  let bodyEl = null;
  let currentTab = "bookmarks";
  const renderers = {}; // tab id -> function(container)

  /* Tab renderers are async (they read from chrome.storage). A single store
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
      chevron.title = collapsed ? "Show panel" : "Hide panel";
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
    localStorage.setItem(TAB_KEY, id);

    for (const btn of root.querySelectorAll(".ph-tab")) {
      btn.classList.toggle("ph-tab-active", btn.dataset.tab === id);
      btn.setAttribute("aria-selected", String(btn.dataset.tab === id));
    }
    renderBody();
  }

  function renderBody() {
    if (!bodyEl) return;
    const renderer = renderers[currentTab];
    if (!renderer) { bodyEl.textContent = ""; return; }

    const token = ++renderToken;
    const scratch = document.createElement("div");
    Promise.resolve(renderer(scratch)).then(() => {
      if (token !== renderToken) return; // a newer render started; drop this one
      /* Whatever a hover popup was anchored to is about to be replaced. */
      PH.ui.closeHoverPopup();
      bodyEl.replaceChildren(...scratch.childNodes);
    });
  }

  /* Called by the tabs whenever they change something, and by main.js when
     storage changes underneath us. */
  function refresh() {
    if (root) renderBody();
  }

  function build() {
    root = document.createElement("div");
    root.id = "ph-panel";
    root.setAttribute("role", "complementary");
    root.setAttribute("aria-label", "PoE Trade Helper");

    /* --- header: collapse chevron + title ------------------------------- */
    const header = document.createElement("div");
    header.className = "ph-header";

    const collapse = document.createElement("button");
    collapse.className = "ph-collapse";
    collapse.type = "button";
    collapse.addEventListener("click", () => setCollapsed(!isCollapsed()));

    const title = document.createElement("div");
    title.className = "ph-title";
    title.textContent = "Trade Helper";

    header.append(collapse, title);

    /* --- tab strip ------------------------------------------------------ */
    const tabs = document.createElement("div");
    tabs.className = "ph-tabs";
    tabs.setAttribute("role", "tablist");

    for (const tab of TABS) {
      const btn = document.createElement("button");
      btn.className = "ph-tab";
      btn.type = "button";
      btn.dataset.tab = tab.id;
      btn.setAttribute("role", "tab");
      btn.innerHTML = "";
      const glyph = document.createElement("span");
      glyph.className = "ph-tab-glyph";
      glyph.textContent = tab.glyph;
      const text = document.createElement("span");
      text.textContent = tab.label;
      btn.append(glyph, text);
      btn.addEventListener("click", () => selectTab(tab.id));
      tabs.appendChild(btn);
    }

    /* --- body ----------------------------------------------------------- */
    bodyEl = document.createElement("div");
    bodyEl.className = "ph-body";

    root.append(header, tabs, bodyEl);
    document.body.appendChild(root);

    document.body.classList.add("ph-active");
    setCollapsed(isCollapsed());

    const saved = localStorage.getItem(TAB_KEY);
    currentTab = renderers[saved] ? saved : "bookmarks";
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

  return { mount, refresh, selectTab, registerTab, setCollapsed, isCollapsed };
})();
