/* =========================================================================
   bookmarks.js — the Bookmarks tab: folders, saved searches, backup tools.
   ========================================================================= */

window.PH = window.PH || {};

PH.bookmarks = (() => {
  const { el, button, menu, inlineForm, confirmRow, toast, empty, makeSortable, timeAgo, formatPrice } = PH.ui;

  const EXPANDED_KEY = "ph-expanded-folders";
  const SHOW_ARCHIVE_KEY = "ph-show-archive";

  /* Which folders are open is UI state, so it lives in localStorage. */
  const expanded = () => new Set((localStorage.getItem(EXPANDED_KEY) || "").split(",").filter(Boolean));

  /* Tracks which open folders have already had their Total Cost recomputed
     this "open session" — renderTrades checks this so opening a folder
     pushes at most once, not on every re-render that happens while it
     stays open (editing a trade, clearing history, reordering, etc. all
     trigger a re-render, but none of those is "opening the folder" and
     shouldn't each re-push). Cleared here on collapse so the next open is a
     genuinely fresh push — this is what makes "Clear Total Cost history"
     actually stick until you close and reopen the folder, instead of being
     silently undone by the very next re-render. */
  const totalCostPushedThisOpen = new Set();

  function setExpanded(id, open) {
    const set = expanded();
    open ? set.add(id) : set.delete(id);
    localStorage.setItem(EXPANDED_KEY, [...set].join(","));
    if (!open) totalCostPushedThisOpen.delete(id);
  }

  const showArchive = () => localStorage.getItem(SHOW_ARCHIVE_KEY) === "true";

  /* An inline editor open somewhere in the tree — we keep one at a time so
     the panel never fills up with half-finished forms. */
  let editing = null; // { kind, folderId?, tradeId? }

  function setEditing(next) {
    editing = next;
    PH.panel.refresh();
  }

  /* ---------------------------------------------------------------- render */

  async function render(container) {
    const pageLocation = PH.location.current();
    const version = pageLocation.version;
    const [folders, lastSeenLeagues] = await Promise.all([
      PH.store.getFolders(),
      PH.store.getLastSeenLeagues(),
    ]);

    const context = { pageLocation, lastSeenLeagues };

    /* Folders are scoped to the game you're browsing — PoE 2 folders don't
       clutter the panel while you're on the PoE 1 site. */
    const forThisGame = folders.filter((f) => (f.version ?? "1") === version);
    const visible = forThisGame.filter((f) => (showArchive() ? f.archivedAt : !f.archivedAt));

    container.append(toolbar(forThisGame));

    if (editing?.kind === "new-folder") {
      container.append(folderEditor({ version }, () => setEditing(null)));
    }

    if (editing?.kind === "import-folder") {
      container.append(folderImporter(() => setEditing(null)));
    }

    if (visible.length === 0) {
      container.append(empty(
        showArchive()
          ? "No archived folders."
          : "No folders yet. Create one, then use “Register current trade” to save the search you're looking at."
      ));
    } else {
      const list = el("div", { class: "ph-folders" });
      for (const folder of visible) list.append(folderRow(folder, context));
      makeSortable(list, {
        handleSelector: ".ph-grip",
        onReorder: async (ids) => {
          await PH.store.reorderFolders(ids);
        },
      });
      container.append(list);
    }

    container.append(backupTools());
  }

  /* Two equal-width rows rather than one — folder-management actions (New /
     Import / Archive) on top, the expand/collapse-all pair below. Each row's
     buttons are flex:1 1 0 so they split that row's width evenly. */
  function toolbar(foldersForThisGame) {
    const archived = foldersForThisGame.filter((f) => f.archivedAt).length;
    const visibleNow = foldersForThisGame.filter((f) => (showArchive() ? f.archivedAt : !f.archivedAt));

    const row1 = el("div", { class: "ph-toolbar-row" },
      button("＋ New folder", {
        class: "ph-btn ph-btn-primary",
        onClick: () => setEditing(editing?.kind === "new-folder" ? null : { kind: "new-folder" }),
      }),
      button("⤓ Import folder", {
        onClick: () => setEditing(editing?.kind === "import-folder" ? null : { kind: "import-folder" }),
      }),
      button(showArchive() ? "← Back to active" : `🗄 Archive${archived ? ` (${archived})` : ""}`, {
        onClick: () => {
          localStorage.setItem(SHOW_ARCHIVE_KEY, String(!showArchive()));
          PH.panel.refresh();
        },
      })
    );

    /* One toggle rather than two buttons — same shape as the Archive toggle
       above. "All expanded" is the on-state: with anything still collapsed,
       the button offers to expand the rest; only once everything visible is
       already open does it flip to offering to collapse. */
    const allExpanded = visibleNow.length > 0 && visibleNow.every((f) => expanded().has(f.id));
    const row2 = el("div", { class: "ph-toolbar-row" },
      button(allExpanded ? "Collapse all" : "Expand all", {
        onClick: () => {
          /* Routed through setExpanded (not a single bulk localStorage
             write) so collapsing also resets totalCostPushedThisOpen for
             each folder — otherwise a folder collapsed via this button and
             later reopened on its own would find itself already marked
             "pushed this session" and silently skip recomputing Total
             Cost. */
          for (const f of visibleNow) setExpanded(f.id, !allExpanded);
          PH.panel.refresh();
        },
      })
    );

    return el("div", { class: "ph-toolbar" }, row1, row2);
  }

  /* ----------------------------------------------------------- folder row */

  function folderRow(folder, context) {
    const isOpen = expanded().has(folder.id);

    const row = el("div", { class: "ph-folder", dataset: { id: folder.id } });

    const toggle = el("button", {
      type: "button",
      class: "ph-folder-toggle",
      "aria-expanded": String(isOpen),
      onclick: () => { setExpanded(folder.id, !isOpen); PH.panel.refresh(); },
    });
    toggle.append(
      PH.icons.render(folder.icon),
      el("span", { class: "ph-folder-title", text: folder.title })
    );

    /* folder.totalCostHistory is a cached, capped history (same shape and
       PH.store.pushFolderTotalCost mechanics as a trade's priceHistory),
       refreshed only when the folder is opened (see renderTrades) — reading
       it here means a collapsed folder shows its last-known total, trend
       arrow, and hover popup with no trades fetch at all, keeping the "one
       storage read instead of twenty" property intact even with Total Cost
       visible everywhere. It can go stale between opens (a price change
       elsewhere doesn't retroactively update a folder you haven't opened
       since), which is the deliberate trade-off the developer asked for over always
       reading every folder's trades up front. */
    const totalHistory = folder.totalCostHistory ?? [];
    const { badge: totalBadge, trendBadge: totalTrendBadge } = priceTrendUI(totalHistory, {
      badgeClass: "ph-folder-total",
      formatLatest: (entry) => `Total Cost: ${formatChaosOrDivine(entry.amount)}`,
      formatLine: (entry) => `${formatHistoryTimestamp(entry.capturedAt)} — ${formatChaosOrDivine(entry.amount)}`,
      trendTitle: (trend) =>
        `Total cost ${trend.direction === "down" ? "went down" : "went up"} since you last opened this folder (${trend.percent}% ${trend.direction})`,
    });

    /* Built as one el() call (children passed directly) rather than a
       separate head.append(...) — el()'s children loop skips null entries
       (totalBadge/totalTrendBadge are null whenever there's no history to
       show yet), but the native Node.append() a bare .append() call would
       use does NOT: it stringifies a null argument into a literal "null"
       text node instead of skipping it. That's why this used to briefly
       show the word "null" right after clearing a folder's Total Cost
       history — verified 2026-08, found by clearing it and watching the
       header render "null" where the arrow should've just been absent. */
    const head = el("div", { class: `ph-folder-head ${isOpen ? "ph-open" : ""}`.trim() },
      toggle,
      totalBadge,
      totalTrendBadge,
      menu([
        { label: "Rename / change icon", onClick: () => setEditing({ kind: "edit-folder", folderId: folder.id }) },
        { label: "Copy share code", onClick: () => copyFolderCode(folder) },
        { label: folder.archivedAt ? "Restore from archive" : "Archive", onClick: async () => {
          await PH.store.toggleFolderArchive(folder.id);
          PH.panel.refresh();
        } },
        "-",
        { label: "Reset Total Cost trend", onClick: () => setEditing({ kind: "clear-total-cost", folderId: folder.id }) },
        { label: "Clear price history for this folder", onClick: () => setEditing({ kind: "clear-price-history", folderId: folder.id }) },
        "-",
        { label: "Delete folder", danger: true, onClick: () => setEditing({ kind: "delete-folder", folderId: folder.id }) },
      ]),
      el("span", { class: "ph-grip", title: "Drag to reorder", text: "⇕" })
    );

    row.append(head);

    if (editing?.kind === "edit-folder" && editing.folderId === folder.id) {
      row.append(folderEditor(folder, () => setEditing(null)));
    }

    if (editing?.kind === "delete-folder" && editing.folderId === folder.id) {
      row.append(confirmRow(`Delete “${folder.title}” and everything in it?`, {
        onConfirm: async () => { await PH.store.deleteFolder(folder.id); setEditing(null); },
        onCancel: () => setEditing(null),
      }));
    }

    if (editing?.kind === "clear-total-cost" && editing.folderId === folder.id) {
      row.append(confirmRow(`Reset the trend for “${folder.title}”'s Total Cost? The current total stays, but the trend arrow and past-total history reset — the trades inside, and their own price histories, are untouched.`, {
        confirmLabel: "Clear",
        onConfirm: async () => { await PH.store.clearFolderTotalCost(folder.id); setEditing(null); },
        onCancel: () => setEditing(null),
      }));
    }

    if (editing?.kind === "clear-price-history" && editing.folderId === folder.id) {
      row.append(confirmRow(`Clear the price history for every trade in “${folder.title}”? This also clears the folder's Total Cost history, since it's built from those same prices. The trades themselves are untouched.`, {
        confirmLabel: "Clear",
        onConfirm: async () => { await PH.store.clearFolderPriceHistory(folder.id); setEditing(null); },
        onCancel: () => setEditing(null),
      }));
    }

    if (isOpen) {
      const body = el("div", { class: "ph-folder-body" });
      row.append(body);
      /* Trades load per folder, so a panel with twenty collapsed folders
         does one storage read instead of twenty. */
      renderTrades(body, folder, context);
    }

    return row;
  }

  /* Sum of each trade's most recently captured price, converted to a
     chaos-equivalent so mixed chaos/divine trades add up sensibly — same
     conversion priceTrend and the sparkline use. Trades with no captured
     price yet (never saved with a price, or a divine entry before the
     exchange rate loaded) just don't contribute, rather than treating
     "unknown" as 0. Returns null if nothing in the folder has a price to
     count at all — distinct from 0, which means "priced trades that
     happen to sum to zero," not "nothing priced." */
  function totalCostFor(trades) {
    let total = 0;
    let any = false;
    for (const trade of trades) {
      const latest = (trade.priceHistory ?? (trade.priceAtSave ? [trade.priceAtSave] : [])).at(-1);
      const chaos = latest ? toChaosEquivalent(latest) : null;
      if (chaos != null) { total += chaos; any = true; }
    }
    return any ? total : null;
  }

  async function renderTrades(body, folder, context) {
    const trades = await PH.store.getTrades(folder.id);

    /* Total Cost is only ever recomputed once per "open session" — see
       totalCostPushedThisOpen. renderTrades runs on EVERY re-render of an
       open folder (editing a trade, clearing history, reordering, ...),
       not just the moment it was opened, so without this guard a push
       would fire on every one of those too: besides being pointless
       churn, it would also immediately undo "Clear Total Cost history"
       the instant the folder's next incidental re-render happened,
       defeating the point of clearing it at all. Skipped (and still
       marked handled) when there's nothing to count, or the value hasn't
       actually changed from the last recorded amount — not just left to
       PH.store.pushFolderTotalCost's own dedup, which still performs a
       write (a timestamp refresh on the latest entry) that would trigger
       PH.store.onChange -> PH.panel.refresh() -> another renderTrades. */
    if (!totalCostPushedThisOpen.has(folder.id)) {
      totalCostPushedThisOpen.add(folder.id);
      const freshTotal = totalCostFor(trades);
      const lastRecorded = folder.totalCostHistory?.at(-1)?.amount ?? null;
      if (freshTotal != null && freshTotal !== lastRecorded) {
        await PH.store.pushFolderTotalCost(folder.id, {
          amount: freshTotal,
          currency: "chaos",
          capturedAt: new Date().toISOString(),
        });
      }
    }

    if (trades.length === 0 && editing?.kind !== "new-trade") {
      body.append(el("div", { class: "ph-folder-empty", text: "Nothing saved here yet." }));
    }

    /* poe.ninja only has item prices for PoE1 right now — see the note in
       service-worker.js. Loaded once per folder, not once per row; PH.prices
       caches it client-side too, so this is cheap after the first real
       fetch. */
    if ((folder.version ?? "1") === "1" && trades.some((t) => t.priceHistory?.length || t.priceAtSave)) {
      await PH.prices.loadPriceIndex();
    }

    const list = el("div", { class: "ph-trades" });
    for (const trade of trades) list.append(tradeRow(folder, trade, context));
    makeSortable(list, {
      handleSelector: ".ph-grip",
      onReorder: async (ids) => { await PH.store.reorderTrades(folder.id, ids); },
    });
    body.append(list);

    if (editing?.kind === "edit-trade" && editing.folderId === folder.id) {
      const trade = trades.find((t) => t.id === editing.tradeId);
      if (trade) body.append(tradeEditor(folder, trade, () => setEditing(null)));
    }

    if (editing?.kind === "new-trade" && editing.folderId === folder.id) {
      body.append(newTradeForm(folder, context));
    } else {
      body.append(registerButton(folder, context));
    }
  }

  /* ------------------------------------------------------------ trade row */

  function tradeRow(folder, trade, context) {
    const league = PH.location.resolveLeague(trade.location, context);
    const url = PH.location.buildUrl(trade.location, league);
    const done = Boolean(trade.completedAt);

    const row = el("div", {
      class: `ph-trade ${done ? "ph-done" : ""}`.trim(),
      dataset: { id: trade.id },
    });

    /* Oldest first, capped at 5 by PH.store.pushTradePrice. Trades saved
       before history existed still carry the old singular `priceAtSave`. */
    const history = trade.priceHistory ?? (trade.priceAtSave ? [trade.priceAtSave] : []);
    const latest = history.at(-1) ?? null;

    const { badge: priceBadge, trendBadge } = priceTrendUI(history, {
      badgeClass: "ph-trade-price",
      formatLatest: formatPrice,
      formatLine: (entry) => `${formatHistoryTimestamp(entry.capturedAt)} — ${formatPrice(entry)}`,
      trendTitle: (trend) =>
        `${trend.direction === "down" ? "Cheaper" : "Pricier"} than the last time this was checked (${trend.percent}% ${trend.direction})`,
    });

    /* Only attempted alongside priceBadge — see the "when available" framing
       this was asked for. Best-effort name match against poe.ninja's data;
       PoE1 only (PH.prices' index may already be loaded from a PoE1 folder
       rendered earlier this session, so this game check has to happen here
       too, not just before loading it in renderTrades). */
    const isPoe1 = (folder.version ?? "1") === "1";
    const ninja = isPoe1 && latest ? PH.prices.matchItem(trade.title) : null;
    const avgBadge = ninja
      ? el("span", {
          class: `ph-trade-avg${ninja.ninjaUrl ? " ph-trade-avg-link" : ""}`,
          title: `poe.ninja average, ${ninja.listingCount} listing${ninja.listingCount === 1 ? "" : "s"} — may not match this exact item's variant (links, mods, gem level/quality, etc.)${ninja.ninjaUrl ? ". Click to view on poe.ninja." : ""}`,
          text: `avg ${formatNinjaValue(ninja, latest.currency)}`,
          /* Nested inside the row's own <a> (a link to the trade search), so
             this has to stop that click from also firing — a nested <a>
             here would be invalid HTML and browsers handle it
             inconsistently, hence a span + manual open instead of a real
             link. */
          onclick: ninja.ninjaUrl
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.open(ninja.ninjaUrl, "_blank", "noopener,noreferrer");
              }
            : undefined,
        })
      : null;

    const link = url
      ? el("a", { class: "ph-trade-link", href: url, title: `${league} · ${trade.location.slug}` },
          el("span", { class: "ph-trade-title", text: trade.title }),
          priceBadge,
          trendBadge,
          avgBadge,
          trade.location.league ? el("span", { class: "ph-pin-badge", text: trade.location.league, title: "Pinned to this league" }) : null
        )
      /* No league known yet — usually because you opened /trade with no
         league in the URL. Say so rather than rendering a dead link. */
      : el("span", { class: "ph-trade-link ph-trade-dead", title: "Open any league's trade page and this will light up" },
          el("span", { class: "ph-trade-title", text: trade.title }),
          priceBadge,
          trendBadge,
          avgBadge,
          el("span", { class: "ph-pin-badge", text: "no league" })
        );

    row.append(
      link,
      menu([
        { label: "Copy URL", onClick: () => copyText(url, "URL copied") },
        trade.location.type === "search" && url
          ? { label: "Open live search", onClick: () => window.open(PH.location.buildUrl(trade.location, league, { live: true }), "_blank") }
          : null,
        "-",
        { label: "Rename", onClick: () => setEditing({ kind: "edit-trade", folderId: folder.id, tradeId: trade.id }) },
        { label: "Point at the search I'm on now", onClick: () => repointTrade(folder, trade) },
        { label: done ? "Mark as not done" : "Mark as done", onClick: async () => {
          await PH.store.saveTrade(folder.id, { id: trade.id, completedAt: done ? null : new Date().toUTCString() });
          PH.panel.refresh();
        } },
        "-",
        { label: "Delete", danger: true, onClick: async () => {
          await PH.store.deleteTrade(folder.id, trade.id);
          PH.panel.refresh();
        } },
      ]),
      el("span", { class: "ph-grip", title: "Drag to reorder", text: "⇕" })
    );

    return row;
  }

  /* --------------------------------------------------------------- editors */

  function iconPicker(version, selected, onPick) {
    const wrap = el("div", { class: "ph-icon-picker" });
    const { classes, items } = PH.icons.optionsFor(version);

    const renderChoice = (slug) => {
      const badge = PH.icons.render(slug);
      const btn = el("button", {
        type: "button",
        class: `ph-icon-choice ${selected === slug ? "ph-chosen" : ""}`.trim(),
        title: PH.icons.prettyName(slug),
        onclick: (e) => { e.preventDefault(); onPick(selected === slug ? null : slug); },
      }, badge);
      return btn;
    };

    /* One continuous wrapping grid rather than a short row per class — with
       real icon art the portraits tell classes apart on their own, so a
       forced row-per-class (only 3 icons wide) just stranded empty space to
       the right of every row. */
    wrap.append(...items.map(renderChoice));
    for (const [, , slugs] of classes) {
      wrap.append(...slugs.map(renderChoice));
    }
    return wrap;
  }

  function folderEditor(folder, done) {
    let icon = folder.icon ?? null;
    const version = folder.version ?? "1";

    const form = inlineForm({
      value: folder.title ?? "",
      placeholder: "Folder name",
      submitLabel: folder.id ? "Save" : "Create folder",
      onSubmit: async (title) => {
        await PH.store.saveFolder({ ...folder, title, icon, version });
        done();
      },
      onCancel: done,
    });

    /* The picker rebuilds itself on every pick so the selected badge updates,
       without re-rendering the whole panel and losing what you've typed. */
    const slot = el("div", { class: "ph-icon-slot" });

    function paint() {
      slot.textContent = "";
      slot.append(iconPicker(version, icon, (next) => { icon = next; paint(); }));
    }
    paint();

    form.insertBefore(slot, form.querySelector(".ph-form-actions"));
    return el("div", { class: "ph-editor" }, form);
  }

  function tradeEditor(folder, trade, done) {
    let pinLeague = trade.location.league ?? "";

    const pinRow = el("label", { class: "ph-checkbox" },
      el("input", {
        type: "checkbox",
        checked: Boolean(trade.location.league),
        onchange: (e) => {
          pinLeague = e.target.checked ? (PH.location.current().league ?? "") : "";
        },
      }),
      el("span", { text: `Always open in ${PH.location.current().league ?? "this league"}` })
    );

    const form = inlineForm({
      value: trade.title,
      placeholder: "Search name",
      onSubmit: async (title) => {
        const location = { ...trade.location };
        if (pinLeague) location.league = pinLeague;
        else delete location.league;
        await PH.store.saveTrade(folder.id, { id: trade.id, title, location });
        done();
      },
      onCancel: done,
      extra: pinRow,
    });

    return el("div", { class: "ph-editor" }, form);
  }

  /* --------------------------------------------------- register current trade */

  function registerButton(folder, context) {
    const page = context.pageLocation;
    const canSave = Boolean(page.type && page.slug && page.league);
    const wrongGame = page.version !== (folder.version ?? "1");

    if (wrongGame) {
      return el("div", { class: "ph-folder-note", text: "This folder belongs to the other game version." });
    }

    return button(canSave ? "＋ Register current trade" : "Run a search to save it", {
      class: `ph-btn ph-register ${canSave ? "" : "ph-btn-disabled"}`.trim(),
      title: canSave ? `${page.type} · ${page.league} · ${page.slug}` : "Open a trade search first",
      onClick: () => {
        if (!canSave) {
          toast("Run a search first — there's no search URL to save yet.", { error: true });
          return;
        }
        setEditing({ kind: "new-trade", folderId: folder.id });
      },
    });
  }

  function newTradeForm(folder, context) {
    const page = context.pageLocation;

    const form = inlineForm({
      value: PH.searchPanel.recommendTitle(),
      placeholder: "Name this search",
      submitLabel: "Save search",
      onSubmit: async (title) => {
        const cheapest = snapshotCheapest();
        await PH.store.saveTrade(folder.id, {
          title,
          completedAt: null,
          location: { version: page.version, type: page.type, slug: page.slug },
          priceHistory: cheapest ? [cheapest] : [],
        });
        setEditing(null);
        toast(`Saved to ${folder.title}`);
      },
      onCancel: () => setEditing(null),
    });

    return el("div", { class: "ph-editor" },
      el("div", { class: "ph-editor-note", text: `${page.type} · ${page.league}` }),
      form
    );
  }

  async function repointTrade(folder, trade) {
    const page = PH.location.current();
    if (!page.type || !page.slug) {
      toast("Open a search first, then try again.", { error: true });
      return;
    }
    const cheapest = snapshotCheapest();
    await PH.store.saveTrade(folder.id, {
      id: trade.id,
      location: { ...trade.location, version: page.version, type: page.type, slug: page.slug },
      /* The old history belonged to whatever search this used to point at —
         meaningless once the trade points somewhere else, so it's replaced
         rather than appended to. */
      priceHistory: cheapest ? [cheapest] : [],
    });
    toast(`“${trade.title}” now points at this search`);
    PH.panel.refresh();
  }

  /* Called from main.js's poll loop once real results are visible on
     whatever page we're now on — if it happens to match a saved trade
     (same location, any folder, this game only), records a price
     observation into that trade's rolling history. Silent no-op otherwise;
     this fires on every navigation, most of which aren't a bookmarked
     search. */
  async function notePriceIfMatch() {
    const page = PH.location.current();
    if (!page.type || !page.slug) return;

    const cheapest = snapshotCheapest();
    if (!cheapest) return;

    /* The same search could be saved into more than one folder — update
       every match, not just the first, so none of them silently fall
       behind. */
    let matched = false;
    const folders = await PH.store.getFolders();
    for (const folder of folders) {
      if ((folder.version ?? "1") !== page.version) continue;
      const trades = await PH.store.getTrades(folder.id);
      for (const trade of trades) {
        if (trade.location.type !== page.type || trade.location.slug !== page.slug) continue;
        await PH.store.pushTradePrice(folder.id, trade.id, cheapest);
        matched = true;
      }
    }
    if (matched) PH.panel.refresh();
  }

  /* { amount, currency } for the cheapest listing currently on the page, or
     null if there's nothing to compare (no results yet, an exchange search,
     or a divine price with no exchange rate loaded to convert it). Never a
     guess — see PH.prices.cheapestOnPage. */
  function snapshotCheapest() {
    const cheapest = PH.prices.cheapestOnPage();
    return cheapest ? { ...cheapest, capturedAt: new Date().toISOString() } : null;
  }

  /* poe.ninja gives chaosValue/divineValue directly (no rate math needed) —
     homogenized to match priceBadge's own currency so the two badges are
     directly comparable at a glance instead of forcing a mental conversion. */
  function formatNinjaValue({ chaosValue, divineValue }, currency) {
    return currency === "divine" ? `${divineValue.toFixed(1)} div` : `${Math.round(chaosValue)}c`;
  }

  /* "8/26 4:26pm" — hand-rolled instead of toLocaleString() so the format is
     exact and consistent regardless of the browser's locale settings. */
  function formatHistoryTimestamp(iso) {
    const d = new Date(iso);
    const hour12 = d.getHours() % 12 || 12;
    const minutes = String(d.getMinutes()).padStart(2, "0");
    const ampm = d.getHours() >= 12 ? "pm" : "am";
    return `${d.getMonth() + 1}/${d.getDate()} ${hour12}:${minutes}${ampm}`;
  }

  /* {direction: "down"/"up", percent}, or null (no signal — equal, or not
     comparable). Just the raw numbers — the trend arrow and the price-
     history row each turn `percent` into their own tier boundaries (see
     arrowTier/rowTier below), since the two don't share the same scheme.
     The two entries can be in different currencies (the cheapest listing
     isn't always the same currency twice), so this converts both to a
     chaos-equivalent using the same exchange rate prices.js already keeps
     loaded — never guessed, and if the rate isn't loaded and the currencies
     differ, we just don't show a trend rather than compare apples to
     oranges. */
  /* Also used by the sparkline (toChaosEquivalent) to put a trade's whole
     price history on one comparable scale. */
  function toChaosEquivalent(entry) {
    const rate = PH.prices.currentRate();
    return entry.currency === "chaos" ? entry.amount : rate ? entry.amount * rate.divineInChaos : null;
  }

  function priceTrend(latest, previous) {
    const before = toChaosEquivalent(previous);
    const after = toChaosEquivalent(latest);
    if (before == null || after == null || before === after) return null;

    const direction = after < before ? "down" : "up";
    const percent = Math.round(Math.abs((after - before) / before) * 100);
    return { direction, percent };
  }

  /* The arrow only calls out a move once it's notable: no extra styling
     under 10%, a colored border at 10%+, a different accent at 30%+ (gold
     for a big drop, an inverted black-on-red fill for a big rise — see
     .ph-trend-tier-* in panel.css for why the two aren't symmetric). */
  const arrowTier = (percent) => (percent >= 30 ? "neon" : percent >= 10 ? "light" : null);

  /* The price-history row highlights every entry, on a 3-step scale from a
     dull tint (still under 10%) through solid (10%+) to bright (30%+) —
     unlike the arrow, even a small move gets some color here. */
  const rowTier = (percent) => (percent >= 30 ? "bright" : percent >= 10 ? "solid" : "dull");

  /* Used for Total Cost, which is always tracked in chaos (see
     totalCostFor) but reads better in divine once it's worth 1+ — same
     "don't guess" rule as everywhere else: no rate loaded means it just
     stays in chaos rather than showing a stale or fabricated conversion. */
  function formatChaosOrDivine(amount) {
    const rate = PH.prices.currentRate();
    return rate && amount >= rate.divineInChaos
      ? `${(amount / rate.divineInChaos).toFixed(1)} div`
      : `${Math.round(amount)}c`;
  }

  /* Shared by tradeRow (trade.priceHistory) and folderRow
     (folder.totalCostHistory) — the "current value" badge, its trend arrow,
     and the hover popup (history list with per-row tiering, plus a
     sparkline), built from any {amount, currency, capturedAt} history
     array, oldest first. formatLatest/formatLine control how an entry's
     amount is displayed, since trades show their own native currency and
     Total Cost converts to divine past a threshold. */
  function priceTrendUI(history, { badgeClass, formatLatest, formatLine, trendTitle }) {
    const latest = history.at(-1) ?? null;
    const previous = history.length >= 2 ? history.at(-2) : null;
    const trend = latest && previous ? priceTrend(latest, previous) : null;

    const badge = latest
      /* title:"" suppresses the native tooltip an element would otherwise
         inherit from an ancestor's own title (the trade row's <a> shows
         the league/slug, which visually collided with this popup). */
      ? el("span", { class: badgeClass, title: "", text: formatLatest(latest) })
      : null;

    if (badge) {
      /* Each entry highlighted against its own predecessor (history[i - 1],
         not the reversed display order) — see rowTier for the color scale.
         The oldest entry has no predecessor, so it never gets a highlight.
         Newest first for display — most recent observation is what you
         care about first. */
      const lines = history.map((entry, i) => {
        const t = i > 0 ? priceTrend(entry, history[i - 1]) : null;
        return {
          text: formatLine(entry),
          class: t ? `ph-hover-popup-line-${t.direction}-${rowTier(t.percent)}` : "",
        };
      }).reverse();

      /* A plain, single-color trend line above the list — oldest to newest
         left-to-right (chart convention), colored by the same up/down
         `trend` used for the arrow next to the badge. Skipped entirely
         rather than guessed at when there's nothing to compare (one entry)
         or the currencies aren't comparable yet (rate not loaded) — same
         "don't show it rather than show it wrong" rule as priceTrend
         itself. */
      const sparkValues = history.map(toChaosEquivalent);
      if (history.length >= 2 && sparkValues.every((v) => v != null)) {
        const color = trend ? (trend.direction === "down" ? "#6fae5c" : "var(--ph-danger)") : "var(--ph-muted)";
        lines.unshift(PH.ui.sparklineSvg(sparkValues, color));
      }

      PH.ui.hoverPopup(badge, lines);
    }

    const trendTier = trend ? arrowTier(trend.percent) : null;
    const trendBadge = trend
      ? el("span", {
          class: `ph-trade-trend ph-trend-${trend.direction}${trendTier ? ` ph-trend-tier-${trendTier}` : ""}`,
          title: trendTitle(trend),
          text: trend.direction === "down" ? "▼" : "▲",
        })
      : null;

    return { badge, trendBadge };
  }

  /* ---------------------------------------------------------- import/export */

  function folderImporter(done) {
    const preview = el("div", { class: "ph-editor-note", text: "Paste a share code." });
    let parsed = null;

    const input = el("textarea", {
      class: "ph-textarea",
      rows: "3",
      placeholder: "3:eyJpY24i…",
      oninput: (e) => {
        parsed = PH.exchange.deserializeFolder(e.target.value);
        if (!e.target.value.trim()) {
          preview.textContent = "Paste a share code.";
          preview.classList.remove("ph-error");
        } else if (parsed) {
          preview.textContent = `${parsed.folder.title} — ${parsed.trades.length} search${parsed.trades.length === 1 ? "" : "es"}`;
          preview.classList.remove("ph-error");
        } else {
          preview.textContent = "That code doesn't look valid.";
          preview.classList.add("ph-error");
        }
      },
    });

    const wrap = el("div", { class: "ph-editor" },
      input,
      preview,
      el("div", { class: "ph-form-actions" },
        button("Import", {
          class: "ph-btn ph-btn-primary",
          onClick: async () => {
            if (!parsed) { toast("Nothing valid to import.", { error: true }); return; }
            await PH.exchange.importFolder(parsed);
            toast(`Imported “${parsed.folder.title}”`);
            done();
          },
        }),
        button("Cancel", { onClick: done })
      )
    );

    requestAnimationFrame(() => input.focus());
    return wrap;
  }

  async function copyFolderCode(folder) {
    const trades = await PH.store.getTrades(folder.id);
    copyText(PH.exchange.serializeFolder(folder, trades), "Share code copied");
  }

  async function copyText(text, successMessage) {
    if (!text) { toast("Nothing to copy.", { error: true }); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast(successMessage);
    } catch {
      /* Clipboard access can be refused; fall back to the old trick. */
      const scratch = el("textarea", { class: "ph-offscreen" });
      scratch.value = text;
      document.body.append(scratch);
      scratch.select();
      document.execCommand("copy");
      scratch.remove();
      toast(successMessage);
    }
  }

  /* ---------------------------------------------------------- backup tools */

  function backupTools() {
    const filePicker = el("input", {
      type: "file",
      accept: "text/plain,.txt",
      class: "ph-offscreen",
      onchange: async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const text = await PH.exchange.readFile(file);
          const { restored, skipped } = await PH.exchange.restoreFromText(text);
          if (restored === 0) {
            toast("No folders found in that file.", { error: true });
          } else {
            toast(`Restored ${restored} folder${restored === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}`);
          }
        } catch {
          toast("Couldn't read that file.", { error: true });
        }
        e.target.value = "";
        PH.panel.refresh();
      },
    });

    return el("div", { class: "ph-backup" },
      el("div", { class: "ph-backup-label", text: "Backup tools" }),
      el("div", { class: "ph-backup-actions" },
        button("⤓ Save file", {
          onClick: async () => {
            PH.exchange.downloadBackup(await PH.exchange.generateBackupText());
            toast("Backup downloaded");
          },
        }),
        button("⤒ Restore from file", { onClick: () => filePicker.click() })
      ),
      el("div", { class: "ph-backup-note", text: "Reads Better Trading backups too. Restoring adds folders, it never deletes." }),
      filePicker
    );
  }

  return { render, notePriceIfMatch };
})();
