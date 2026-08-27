/* =========================================================================
   live-searches.js — the Live searches tab.
   =========================================================================
   A flat, persisted list of searches you want to keep watching. Unlike a
   Bookmarks folder, there's no organizing step — add the search you're on,
   or pull one in from a folder you already have — and each entry gets a
   one-click "Open live search", which just opens the trade site's own
   /live URL in a new tab. We never hold that connection ourselves; see the
   hard boundary in CLAUDE.md.

   Same location shape as a bookmark trade — { version, type, slug } with no
   league stored — so an entry survives a league reset the same way.
   ========================================================================= */

window.PH = window.PH || {};

PH.liveSearches = (() => {
  const { el, button, menu, inlineForm, toast, empty, makeSortable } = PH.ui;

  /* One inline editor open at a time, same rule as Bookmarks. */
  let editing = null; // { kind: "new" | "edit", id? }

  function setEditing(next) {
    editing = next;
    PH.panel.refresh();
  }

  /* ---------------------------------------------------------------- render */

  async function render(container) {
    const pageLocation = PH.location.current();
    const [searches, lastSeenLeagues] = await Promise.all([
      PH.store.getLiveSearches(),
      PH.store.getLastSeenLeagues(),
    ]);
    const context = { pageLocation, lastSeenLeagues };

    /* Scoped to the game you're browsing, same as folders. */
    const forThisGame = searches.filter((s) => s.location.version === pageLocation.version);

    container.append(el("div", { class: "ph-notice" },
      "Searches you want to keep an eye on. “Open live search” opens the trade site's own live-search tab — this extension never holds that connection itself."
    ));

    container.append(toolbar(pageLocation));

    if (editing?.kind === "new") {
      container.append(newSearchForm(pageLocation));
    }

    if (forThisGame.length === 0) {
      if (editing?.kind !== "new") {
        container.append(empty(
          "No live searches yet. Add the search you're on, or pull one in from your bookmarks."
        ));
      }
    } else {
      const list = el("div", { class: "ph-trades" });
      for (const search of forThisGame) list.append(searchRow(search, context));
      makeSortable(list, {
        handleSelector: ".ph-grip",
        onReorder: async (ids) => { await PH.store.reorderLiveSearches(ids); },
      });
      container.append(list);
    }

    if (editing?.kind === "edit") {
      const search = forThisGame.find((s) => s.id === editing.id);
      if (search) container.append(searchEditor(search, () => setEditing(null)));
    }
  }

  function toolbar(pageLocation) {
    const canAdd = Boolean(pageLocation.type && pageLocation.slug && pageLocation.league);

    return el("div", { class: "ph-toolbar" },
      button(canAdd ? "＋ Add current search" : "Run a search to add it", {
        class: `ph-btn ph-btn-primary ${canAdd ? "" : "ph-btn-disabled"}`.trim(),
        title: canAdd ? `${pageLocation.type} · ${pageLocation.league} · ${pageLocation.slug}` : "Open a trade search first",
        onClick: () => {
          if (!canAdd) {
            toast("Run a search first — there's no search URL to add yet.", { error: true });
            return;
          }
          setEditing(editing?.kind === "new" ? null : { kind: "new" });
        },
      }),
      button("⤓ From bookmarks…", { onClick: addFromBookmarks })
    );
  }

  /* ------------------------------------------------------------- one entry */

  function searchRow(search, context) {
    const league = PH.location.resolveLeague(search.location, context);
    const url = PH.location.buildUrl(search.location, league);

    const row = el("div", { class: "ph-trade", dataset: { id: search.id } });

    const link = url
      ? el("a", { class: "ph-trade-link", href: url, title: `${league} · ${search.location.slug}` },
          el("span", { class: "ph-trade-title", text: search.title }),
          search.location.league ? el("span", { class: "ph-pin-badge", text: search.location.league, title: "Pinned to this league" }) : null
        )
      /* No league known yet — usually because you opened /trade with no
         league in the URL. Say so rather than rendering a dead link. */
      : el("span", { class: "ph-trade-link ph-trade-dead", title: "Open any league's trade page and this will light up" },
          el("span", { class: "ph-trade-title", text: search.title }),
          el("span", { class: "ph-pin-badge", text: "no league" })
        );

    row.append(
      link,
      menu([
        url ? { label: "Open live search", onClick: () => window.open(PH.location.buildUrl(search.location, league, { live: true }), "_blank") } : null,
        url ? { label: "Copy URL", onClick: () => copyUrl(url) } : null,
        "-",
        { label: "Rename", onClick: () => setEditing({ kind: "edit", id: search.id }) },
        { label: "Point at the search I'm on now", onClick: () => repoint(search) },
        "-",
        { label: "Remove", danger: true, onClick: async () => {
          await PH.store.deleteLiveSearch(search.id);
          PH.panel.refresh();
        } },
      ]),
      el("span", { class: "ph-grip", title: "Drag to reorder", text: "⇕" })
    );

    return row;
  }

  async function copyUrl(url) {
    try {
      await navigator.clipboard.writeText(url);
      toast("URL copied");
    } catch {
      toast("Couldn't copy.", { error: true });
    }
  }

  async function repoint(search) {
    const page = PH.location.current();
    if (!page.type || !page.slug) {
      toast("Open a search first, then try again.", { error: true });
      return;
    }
    await PH.store.saveLiveSearch({
      id: search.id,
      location: { ...search.location, version: page.version, type: page.type, slug: page.slug },
    });
    toast(`“${search.title}” now points at this search`);
    PH.panel.refresh();
  }

  /* ------------------------------------------------------------- editors */

  function newSearchForm(pageLocation) {
    const form = inlineForm({
      value: PH.searchPanel.recommendTitle(),
      placeholder: "Name this search",
      submitLabel: "Add",
      onSubmit: async (title) => {
        await PH.store.saveLiveSearch({
          title,
          location: { version: pageLocation.version, type: pageLocation.type, slug: pageLocation.slug },
        });
        setEditing(null);
        toast("Added to live searches");
      },
      onCancel: () => setEditing(null),
    });

    return el("div", { class: "ph-editor" },
      el("div", { class: "ph-editor-note", text: `${pageLocation.type} · ${pageLocation.league}` }),
      form
    );
  }

  function searchEditor(search, done) {
    let pinLeague = search.location.league ?? "";

    const pinRow = el("label", { class: "ph-checkbox" },
      el("input", {
        type: "checkbox",
        checked: Boolean(search.location.league),
        onchange: (e) => {
          pinLeague = e.target.checked ? (PH.location.current().league ?? "") : "";
        },
      }),
      el("span", { text: `Always open in ${PH.location.current().league ?? "this league"}` })
    );

    const form = inlineForm({
      value: search.title,
      placeholder: "Search name",
      onSubmit: async (title) => {
        const location = { ...search.location };
        if (pinLeague) location.league = pinLeague;
        else delete location.league;
        await PH.store.saveLiveSearch({ id: search.id, title, location });
        done();
      },
      onCancel: done,
      extra: pinRow,
    });

    return el("div", { class: "ph-editor" }, form);
  }

  /* ------------------------------------------------------ pull from a folder */

  async function addFromBookmarks() {
    const version = PH.location.current().version;
    const folders = (await PH.store.getFolders()).filter(
      (f) => (f.version ?? "1") === version && !f.archivedAt
    );

    const entries = [];
    for (const folder of folders) {
      const trades = await PH.store.getTrades(folder.id);
      for (const trade of trades) entries.push({ folder, trade });
    }

    if (entries.length === 0) {
      toast("No saved searches to pull from — save one on the Bookmarks tab first.", { error: true });
      return;
    }

    const picked = await pickEntry(entries);
    if (!picked) return;

    await PH.store.saveLiveSearch({
      title: picked.trade.title,
      location: { ...picked.trade.location },
    });
    toast(`Added “${picked.trade.title}”`);
    PH.panel.refresh();
  }

  function pickEntry(entries) {
    return new Promise((resolve) => {
      const overlay = el("div", { class: "ph-overlay", onclick: (e) => {
        if (e.target === overlay) { overlay.remove(); resolve(null); }
      } });

      const box = el("div", { class: "ph-dialog" },
        el("div", { class: "ph-dialog-title", text: "Add which saved search?" })
      );

      for (const entry of entries) {
        box.append(el("button", {
          type: "button", class: "ph-dialog-choice",
          onclick: () => { overlay.remove(); resolve(entry); },
        }, PH.icons.render(entry.folder.icon), el("span", { text: `${entry.folder.title} / ${entry.trade.title}` })));
      }

      box.append(button("Cancel", { onClick: () => { overlay.remove(); resolve(null); } }));
      overlay.append(box);
      document.body.append(overlay);
    });
  }

  return { render };
})();
