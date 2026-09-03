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

  function setExpanded(id, open) {
    const set = expanded();
    open ? set.add(id) : set.delete(id);
    localStorage.setItem(EXPANDED_KEY, [...set].join(","));
  }

  const showArchive = () => localStorage.getItem(SHOW_ARCHIVE_KEY) === "true";

  /* Debounces Total Cost history pushes — see the note above renderTrades'
     own push. One timer per folder (a Map, not a single variable) since
     more than one folder can be open and settling at once. */
  const totalCostPushTimers = new Map(); // folderId -> setTimeout id
  const TOTAL_COST_PUSH_DEBOUNCE_MS = 4000;

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

    /* One shared fetch, up front, for every currently-open folder's trades
       — readAll() already reads every folder's trades in a single call, so
       each open folder independently re-fetching that same data (what
       renderTrades used to do on its own) was pure repeated work once more
       than one folder is open at a time. Only paid when something's
       actually open, so a fully collapsed panel still costs nothing extra. */
    const tradesByFolder = visible.some((f) => expanded().has(f.id))
      ? (await PH.store.readAll()).trades
      : null;

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
      for (const folder of visible) list.append(folderRow(folder, context, tradesByFolder));
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
     buttons are flex:1 1 0 so they split that row's width evenly. A divider
     line above and below row2 boxes it off from both row1 and the folder
     list underneath — per a real report, without it every button plus the
     folder list read as one undifferentiated block, with nothing marking
     that Collapse all is a view toggle rather than a fourth folder action. */
  function toolbar(foldersForThisGame) {
    const archived = foldersForThisGame.filter((f) => f.archivedAt).length;
    const visibleNow = foldersForThisGame.filter((f) => (showArchive() ? f.archivedAt : !f.archivedAt));

    const row1 = el("div", { class: "ph-toolbar-row" },
      button("＋ New folder", {
        class: "ph-btn ph-btn-primary",
        onClick: () => setEditing(editing?.kind === "new-folder" ? null : { kind: "new-folder" }),
      }),
      button("Import folder", {
        onClick: () => setEditing(editing?.kind === "import-folder" ? null : { kind: "import-folder" }),
      }),
      button(showArchive() ? "Back to active" : `Archive${archived ? ` (${archived})` : ""}`, {
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
          localStorage.setItem(EXPANDED_KEY, allExpanded ? "" : visibleNow.map((f) => f.id).join(","));
          PH.panel.refresh();
        },
      })
    );

    return el("div", { class: "ph-toolbar" },
      row1,
      el("hr", { class: "ph-toolbar-divider" }),
      row2,
      el("hr", { class: "ph-toolbar-divider" })
    );
  }

  /* ----------------------------------------------------------- folder row */

  function folderRow(folder, context, tradesByFolder) {
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
       since) — a deliberate trade-off in favor of that read-count property,
       over always reading every folder's trades up front. */
    const totalHistory = folder.totalCostHistory ?? [];
    const { badge: totalBadge, trendBadge: totalTrendBadge } = priceTrendUI(totalHistory, {
      badgeClass: "ph-folder-total",
      formatLatest: (entry) => `Total Cost: ${formatChaosOrDivine(entry.amount, folder.version)}`,
      formatAmount: (entry) => formatChaosOrDivine(entry.amount, folder.version),
      historyTitle: "Total cost history",
      version: folder.version,
      trendTitle: (trend) =>
        trend.direction === "same"
          ? "Same total cost as the last time this folder was opened"
          : `Total cost ${trend.direction === "down" ? "went down" : "went up"} since you last opened this folder (${trend.percent}% ${trend.direction})`,
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
        { label: "Sort by price", onClick: () => sortFolderByPrice(folder) },
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
        /* Passes the live total (recomputed from this folder's own trades),
           not the previously-stored "latest" entry — see the note above
           clearFolderTotalCost in store.js for the real bug that fixed:
           renderTrades' own debounced Total Cost push (up to 4s out — see
           TOTAL_COST_PUSH_DEBOUNCE_MS) can still be pending from before this
           click, and if it landed after a reset that kept the old stale
           entry, it re-added a *different* second entry, resurrecting the
           very trend arrow this was supposed to clear. Using the live total
           here means even that stale pending push resolves to the exact
           same amount and collapses into a timestamp refresh instead. */
        onConfirm: async () => {
          const trades = tradesByFolder ? (tradesByFolder[folder.id] ?? []) : await PH.store.getTrades(folder.id);
          await PH.store.clearFolderTotalCost(folder.id, totalCostFor(trades));
          setEditing(null);
        },
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
      /* A collapsed folder never reaches here at all, so a panel with
         twenty collapsed folders still costs nothing; render() already
         fetched every open folder's trades in one shared call above. */
      renderTrades(body, folder, context, tradesByFolder);
    }

    return row;
  }

  /* Sum of each trade's most recently captured price, converted to a
     chaos-equivalent so mixed chaos/divine trades add up sensibly — same
     conversion priceTrend and the sparkline use. Trades with no captured
     price yet (never saved with a price) just don't contribute, rather
     than treating "unknown" as 0. Returns null if nothing in the folder
     has a price to count at all — distinct from 0, which means "priced
     trades that happen to sum to zero," not "nothing priced."

     Also returns null — the whole total, not just that one trade — if a
     divine-priced trade exists but can't be converted right now (the
     exchange rate hasn't loaded yet). An earlier version silently dropped
     just that trade from the sum, which produced a technically-valid-
     looking but wrong (too low) total; since renderTrades pushes any total
     that differs from what's already stored, that wrong number would get
     recorded as a real history entry — visible as the price oscillating
     between the real total and a smaller one on every re-render, since
     each one looked like a genuine change from the last. Bailing out
     entirely here means renderTrades' own null check skips the push that
     render instead, leaving the last real total alone until a render with
     the rate actually loaded corrects it. */
  function totalCostFor(trades) {
    let total = 0;
    let any = false;
    for (const trade of trades) {
      const latest = (trade.priceHistory ?? (trade.priceAtSave ? [trade.priceAtSave] : [])).at(-1);
      if (!latest) continue;
      const chaos = toChaosEquivalent(latest);
      if (chaos == null) return null;
      total += chaos;
      any = true;
    }
    return any ? total : null;
  }

  async function renderTrades(body, folder, context, tradesByFolder) {
    /* tradesByFolder is folderRow's shared, already-fetched map — the
       fallback fetch below only matters if this is ever called without it. */
    const trades = tradesByFolder ? (tradesByFolder[folder.id] ?? []) : await PH.store.getTrades(folder.id);

    /* Total Cost recomputes on every render of an open folder, same as the
       trade rows below it draw from this same `trades` — so what's shown
       never visibly disagrees with what's actually shown per-trade. The
       actual history push is debounced, not immediate, though: each trade
       updates its own price independently (visiting one bookmarked search
       at a time, or "Search this exact item" landing on a fresh price), so
       checking several items in a row would otherwise recompute and push a
       new total after *each* one — one history slot per trade checked,
       not one entry for the settled result once you're done. Scheduling
       the push a few seconds out and re-scheduling (not stacking) on every
       subsequent render means only the *last* total in a burst actually
       gets recorded — see totalCostPushTimers above. Once that push
       finally lands, PH.store.onChange fires renderTrades again, freshTotal
       now matches what's stored, and no new timer gets scheduled — so this
       still settles after one extra cycle rather than looping forever,
       same guarantee the immediate version had. */
    const freshTotal = totalCostFor(trades);
    const lastRecorded = folder.totalCostHistory?.at(-1)?.amount ?? null;
    if (freshTotal != null && freshTotal !== lastRecorded) {
      clearTimeout(totalCostPushTimers.get(folder.id));
      totalCostPushTimers.set(folder.id, setTimeout(() => {
        totalCostPushTimers.delete(folder.id);
        PH.store.pushFolderTotalCost(folder.id, {
          amount: freshTotal,
          currency: "chaos",
          capturedAt: new Date().toISOString(),
        });
      }, TOTAL_COST_PUSH_DEBOUNCE_MS));
    }

    if (trades.length === 0 && editing?.kind !== "new-trade") {
      body.append(el("div", { class: "ph-folder-empty", text: "Nothing saved here yet." }));
    }

    /* poe.ninja has item prices for both games now, each with its own fixed
       catalog — see PRICE_CATEGORIES in service-worker.js. Loaded once per
       folder, not once per row; PH.prices caches it client-side too, so
       this is cheap after the first real fetch. */
    if (trades.some((t) => t.priceHistory?.length || t.priceAtSave)) {
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

    const { badge: priceBadge, trendBadge, trend, trendTier } = priceTrendUI(history, {
      badgeClass: "ph-trade-price",
      formatLatest: formatPrice,
      formatAmount: formatPrice,
      historyTitle: "Price history",
      version: folder.version,
      trendTitle: (trend) =>
        trend.direction === "same"
          ? "Same price as the last time this was checked"
          : `${trend.direction === "down" ? "Cheaper" : "Pricier"} than the last time this was checked (${trend.percent}% ${trend.direction})`,
    });

    /* Price + arrow grouped into one pill so a big (30%+) drop can outline
       just the two of them, not the whole row and not the arrow alone —
       see the ph-trade-price-drop rule in panel.css. */
    const priceGroup = el("span", { class: "ph-trade-price-group" }, priceBadge, trendBadge);
    if (trend?.direction === "down" && trendTier === "neon") {
      priceGroup.classList.add("ph-trade-price-drop");
    }

    /* Only attempted alongside priceBadge, shown when a match is available.
       Best-effort name match against poe.ninja's data, whichever game's
       index PH.prices currently has loaded (see loadPriceIndex — it's
       always the index for the page's own current version, matching this
       folder since folders only render for the game you're browsing). */
    const ninja = latest ? PH.prices.matchItem(trade.title) : null;
    const avgBadge = ninja
      /* title:"" for the same reason as priceBadge above — this also sits
         inside the row's own <a> and would otherwise inherit its
         league/slug title. The real description goes through
         PH.ui.hoverPopup instead of a real title attribute, since this
         text is long enough that the browser's native tooltip renders as
         a large plain box that visibly lingered right after a click. */
      ? el("span", {
          class: `ph-trade-avg${ninja.ninjaUrl ? " ph-trade-avg-link" : ""}`,
          title: "",
          text: `avg ${formatNinjaValue(ninja, folder.version)}`,
          /* Nested inside the row's own <a> (a link to the trade search), so
             this has to stop that click from also firing — a nested <a>
             here would be invalid HTML and browsers handle it
             inconsistently, hence a span + manual open instead of a real
             link. */
          onclick: ninja.ninjaUrl
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                /* Opening a background/new tab doesn't reliably fire
                   mouseleave on this span (the cursor itself never moves),
                   so the hover popup could otherwise linger open behind
                   the new tab — close it explicitly instead of counting
                   on that event. */
                PH.ui.closeHoverPopup();
                window.open(ninja.ninjaUrl, "_blank", "noopener,noreferrer");
              }
            : undefined,
        })
      : null;

    /* The popup carries whatever we actually have: poe.ninja's own 7-day
       trend line (same sparkline widget the local price-history popups
       use, just fed poe.ninja's % values instead of our own chaos-
       equivalent history) when there's enough of it to draw, and the
       "click to view" hint only when there's really somewhere to click —
       no ninjaUrl on its own would make that line misleading. */
    const hasTrend = (ninja?.sparkline?.length ?? 0) >= 2;
    if (avgBadge && (hasTrend || ninja.ninjaUrl)) {
      const lines = [];
      if (hasTrend) {
        const change = ninja.sparklineChange ?? ninja.sparkline.at(-1);
        const color = change > 0 ? "var(--ph-danger)" : change < 0 ? "#6fae5c" : "var(--ph-muted)";
        lines.push(PH.ui.sparklineSvg(ninja.sparkline, color));
        lines.push(`7-day trend: ${change > 0 ? "+" : ""}${change.toFixed(1)}%`);
      }
      if (ninja.ninjaUrl) lines.push("Click to view on PoE Ninja");
      PH.ui.hoverPopup(avgBadge, lines, { title: "poe.ninja" });
    }

    const link = url
      /* onclick doesn't preventDefault — the link still navigates normally.
         It only records that this click happened (see
         PH.store.recordTradeLinkClick), since this tab has no way to read
         a real rate-limit reading back from whatever request(s) that
         navigation triggers on GGG's side. */
      ? el("a", { class: "ph-trade-link", href: url, onclick: () => PH.store.recordTradeLinkClick() },
          el("span", { class: "ph-trade-title", text: trade.title }),
          priceGroup,
          avgBadge,
          trade.location.league ? el("span", { class: "ph-pin-badge", text: PH.location.displayLeague(trade.location.league), title: "Pinned to this league" }) : null
        )
      /* No league known yet — usually because you opened /trade with no
         league in the URL. Say so rather than rendering a dead link. */
      : el("span", { class: "ph-trade-link ph-trade-dead", title: "Open any league's trade page and this will light up" },
          el("span", { class: "ph-trade-title", text: trade.title }),
          priceGroup,
          avgBadge,
          el("span", { class: "ph-pin-badge", text: "no league" })
        );

    row.append(
      link,
      menu([
        { label: "Copy URL", onClick: () => copyText(url, "URL copied") },
        trade.location.type === "search" && url
          ? { label: "Open live search", onClick: () => {
              PH.store.recordTradeLinkClick();
              window.open(PH.location.buildUrl(trade.location, league, { live: true }), "_blank");
            } }
          : null,
        "-",
        { label: "Rename", onClick: () => setEditing({ kind: "edit-trade", folderId: folder.id, tradeId: trade.id }) },
        { label: "Point at the search I'm on now", onClick: () => repointTrade(folder, trade) },
        { label: done ? "Mark as not done" : "Mark as done", onClick: async () => {
          const saved = await PH.store.saveTrade(folder.id, { id: trade.id, completedAt: done ? null : new Date().toUTCString() });
          if (!saved) toast("That trade no longer exists.", { error: true });
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
        const saved = await PH.store.saveFolder({ ...folder, title, icon, version });
        if (!saved) toast("That folder no longer exists.", { error: true });
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
      el("span", { text: `Always open in ${PH.location.displayLeague(PH.location.current().league) ?? "this league"}` })
    );

    const form = inlineForm({
      value: trade.title,
      placeholder: "Search name",
      onSubmit: async (title) => {
        const location = { ...trade.location };
        if (pinLeague) location.league = pinLeague;
        else delete location.league;
        const saved = await PH.store.saveTrade(folder.id, { id: trade.id, title, location });
        if (!saved) toast("That trade no longer exists.", { error: true });
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
      title: canSave ? `${page.type} · ${PH.location.displayLeague(page.league)} · ${page.slug}` : "Open a trade search first",
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
        const saved = await PH.store.saveTrade(folder.id, {
          title,
          completedAt: null,
          location: { version: page.version, type: page.type, slug: page.slug },
          priceHistory: cheapest ? [cheapest] : [],
        });
        setEditing(null);
        toast(saved ? `Saved to ${folder.title}` : "That folder no longer exists.", { error: !saved });
      },
      onCancel: () => setEditing(null),
    });

    return el("div", { class: "ph-editor" },
      el("div", { class: "ph-editor-note", text: `${page.type} · ${PH.location.displayLeague(page.league)}` }),
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
    const saved = await PH.store.saveTrade(folder.id, {
      id: trade.id,
      location: { ...trade.location, version: page.version, type: page.type, slug: page.slug },
      /* The old history belonged to whatever search this used to point at —
         meaningless once the trade points somewhere else, so it's replaced
         rather than appended to. */
      priceHistory: cheapest ? [cheapest] : [],
    });
    toast(saved ? `“${trade.title}” now points at this search` : "That trade no longer exists.", { error: !saved });
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

  /* poe.ninja gives chaosValue/divineValue directly (no rate math needed).
     Picked by the item's OWN value, the same divine-once-it's-worth-1+
     threshold formatChaosOrDivine uses — not by matching priceBadge's own
     currency, which an earlier version did for at-a-glance comparability.
     That fell apart for anything priced well outside its usual range (an
     overpriced/joke listing, or a cheap listing of an otherwise-pricey
     item): a real report showed a ~22-chaos item's own listing at 22
     divine, and the avg badge dutifully converted poe.ninja's real 22.0
     chaos value into "0.1 div" to match — technically consistent math,
     but a number poe.ninja itself never shows for that item, since it
     always presents this one in chaos. Matching poe.ninja's own natural
     unit instead means this can never show a value that doesn't match
     what clicking through to poe.ninja itself would show.

     PoE2 is the one deliberate exception, per the developer's explicit
     ask: below the divine threshold, PoE2 shows Exalted Orbs instead of
     chaos, since Exalted (not Chaos) is PoE2's actual common bulk
     currency — Chaos sits at an awkward middle tier there (worth dozens
     of Exalted apiece, see fetchCurrencyRates in service-worker.js), so a
     "3c" reading doesn't map to how PoE2 players actually think about
     value the way it does in PoE1. Needs the live exchange rate (the
     same one the ≈ badge and cheapest-price capture already use) to
     convert chaosValue into Exalted terms; falls back to chaos if that
     rate or "Exalted Orb" specifically hasn't loaded yet, rather than
     showing nothing. Uses the same "ex" abbreviation PH.ui.formatPrice
     gives a real Exalted-priced trade, via the shared
     PH.ui.abbreviateCurrency, rather than a second hardcoded label. */
  function formatNinjaValue({ chaosValue, divineValue }, version) {
    if (divineValue >= 1) return `${divineValue.toFixed(1)} div`;
    if (version === "2") {
      const exaltedInChaos = PH.prices.currentRate()?.chaosValueByName?.["Exalted Orb"];
      if (exaltedInChaos) return `${Math.round(chaosValue / exaltedInChaos)} ${PH.ui.abbreviateCurrency("Exalted Orb")}`;
    }
    return `${Math.round(chaosValue)}c`;
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
     comparable). Just the raw numbers — the trend arrow turns `percent`
     into its own tier boundaries (see arrowTier below). The two entries
     can be in different currencies (the cheapest listing
     isn't always the same currency twice), so this converts both to a
     chaos-equivalent using the same exchange rate prices.js already keeps
     loaded — never guessed, and if the rate isn't loaded and the currencies
     differ, we just don't show a trend rather than compare apples to
     oranges. */
  /* Also used by the sparkline to put a trade's whole price history on one
     comparable scale. Delegates to PH.prices.chaosEquivalentOf, which now
     resolves almost any currency's real value via poe.ninja's own catalog
     (see fetchCurrencyRates in service-worker.js) — PoE2 listings commonly
     get priced in things like Orb of Alchemy or Gemcutter's Prism, and
     PH.prices.cheapestOnPage (what seeds a trade's price to begin with) can
     now pick those up too instead of skipping them for lack of a rate.

     chaosEquivalentOf returning null is ambiguous on its own — it means
     either "no rate has loaded at all yet" (a brief, temporary state right
     after the page loads, or right after a PoE1/PoE2 version switch) or
     "the rate IS loaded but this specific currency genuinely isn't in
     poe.ninja's catalog" (a real, permanent gap). Those need different
     treatment: floor the permanent case to a flat ~1 chaos-equivalent
     (better than leaving it uncomparable, for a small, user-curated set of
     trades), but propagate null for the temporary case so totalCostFor
     keeps treating the whole total as unknown rather than momentarily
     summing a floored 1 in place of a trade's real (possibly much larger)
     value — collapsing these two into one flat floor previously
     reintroduced the exact Total Cost oscillation bug fixed earlier this
     project (a folder's total flipping between its real value and a much
     smaller wrong one on every render), caught live via the developer's
     own hover-popup screenshot showing two history entries seconds apart
     (8.0 div, then 222 ex — a ~15x undervaluation from exactly this
     floor-during-a-temporarily-unloaded-rate scenario). */
  function toChaosEquivalent(entry) {
    const real = PH.prices.chaosEquivalentOf(entry.amount, entry.currency);
    if (real != null) return real;
    return PH.prices.currentRate() ? 1 : null;
  }

  /* A trade's own latest captured price as a chaos-equivalent — the same
     lookup tradeRow (for display) and totalCostFor (for the folder total)
     already do, pulled out here since "Sort by price" is a third caller
     with the same need. null for a trade with nothing captured yet, or a
     divine price with no exchange rate loaded — sortFolderByPrice below
     sorts those last, same null-sorts-last rule used for price sorting
     everywhere else in this codebase. */
  function tradeChaosPrice(trade) {
    const latest = (trade.priceHistory ?? (trade.priceAtSave ? [trade.priceAtSave] : [])).at(-1);
    return latest ? toChaosEquivalent(latest) : null;
  }

  /* "Sort by price" in a folder's own menu — reorders its trades descending
     (priciest first) and persists that via reorderTrades, the same
     storage call manual drag-reordering already uses, so the result is
     indistinguishable from having dragged everything into place by hand.
     Reads the trade list straight from storage rather than whatever
     render already has in memory, since the folder this was clicked from
     might be collapsed — folderRow only fetches a folder's trades when
     it's open, but the menu (and this action) exists whether it is or
     not. Trades with no computable price still sort last regardless of
     direction — "unknown" isn't a price, so it's never worth more or less
     than a real one, same null-sorts-last rule used for price sorting
     everywhere else in this codebase. */
  async function sortFolderByPrice(folder) {
    const trades = await PH.store.getTrades(folder.id);
    if (trades.length < 2) return;

    const keyed = trades.map((trade, i) => ({ trade, i, key: tradeChaosPrice(trade) }));
    keyed.sort((a, b) => {
      if (a.key == null && b.key == null) return a.i - b.i;
      if (a.key == null) return 1;
      if (b.key == null) return -1;
      return b.key - a.key || a.i - b.i;
    });

    await PH.store.reorderTrades(folder.id, keyed.map((k) => k.trade.id));
    PH.panel.refresh();
  }

  function priceTrend(latest, previous) {
    const before = toChaosEquivalent(previous);
    const after = toChaosEquivalent(latest);
    if (before == null || after == null) return null;
    if (before === after) return { direction: "same", percent: 0 };

    const direction = after < before ? "down" : "up";
    const percent = Math.round(Math.abs((after - before) / before) * 100);
    return { direction, percent };
  }

  /* Three fill-intensity tiers for the trend arrow's own pill (dull under
     10%, light at 10%+, neon at 30%+ — see .ph-trend-tier-* in panel.css),
     plus "neon" doubles as the trigger for the bigger price-drop flair
     around the whole price group (.ph-trade-price-drop). Always returns a
     tier — unlike the price-history popup's diff pills, which stay flat
     two-tone since the exact number is right there next to them, the
     arrow is all you get at a glance scrolling a folder, so even a small
     move gets some fill. */
  const arrowTier = (percent) => (percent >= 30 ? "neon" : percent >= 10 ? "light" : "dull");

  /* Used for Total Cost, which is always tracked in chaos-equivalent (see
     totalCostFor) but reads better in divine once it's worth 1+ — same
     "don't guess" rule as everywhere else: no rate loaded means it just
     stays in the small-unit fallback rather than showing a stale or
     fabricated conversion. version ("1"/"2", the folder's own — see
     folderRow) picks Exalted over Chaos as that small unit for PoE2, via
     PH.prices.smallUnitAmount — see the note there and in
     poe2-exalt-replaces-chaos-in-hierarchy for why. */
  function formatChaosOrDivine(amount, version) {
    const rate = PH.prices.currentRate();
    return rate && amount >= rate.divineInChaos
      ? `${(amount / rate.divineInChaos).toFixed(1)} div`
      : PH.prices.smallUnitAmount(amount, version);
  }

  /* Same chaos/divine threshold as formatChaosOrDivine, but signed — used
     for the +/- delta shown next to each price-history line. */
  function formatChaosDelta(diff, version) {
    const abs = Math.abs(diff);
    const sign = diff > 0 ? "+" : "-";
    const rate = PH.prices.currentRate();
    return rate && abs >= rate.divineInChaos
      ? `${sign}${(abs / rate.divineInChaos).toFixed(1)} div`
      : `${sign}${PH.prices.smallUnitAmount(abs, version)}`;
  }

  /* Shared by tradeRow (trade.priceHistory) and folderRow
     (folder.totalCostHistory) — the "current value" badge, its trend arrow,
     and the hover popup (a small time/price/diff table, plus a sparkline),
     built from any {amount, currency, capturedAt} history array, oldest
     first. formatLatest/formatAmount control how an entry's amount is
     displayed, since trades show their own native currency and Total Cost
     converts to divine past a threshold — formatLatest is just the badge
     (Total Cost's gets a "Total Cost: " prefix the popup rows don't need),
     formatAmount is the bare price used in each popup row. version is only
     used for the diff column's own formatChaosDelta call (Total Cost's
     diff is always a chaos-equivalent number needing the same PoE2-uses-
     Exalted substitution regardless of which caller this is); tradeRow's
     own formatAmount/formatLatest already close over whatever they need
     independently, so this doesn't affect those. */
  function priceTrendUI(history, { badgeClass, formatLatest, formatAmount, historyTitle, trendTitle, version }) {
    const latest = history.at(-1) ?? null;
    const previous = history.length >= 2 ? history.at(-2) : null;
    const trend = latest && previous ? priceTrend(latest, previous) : null;

    const badge = latest
      /* title:"" keeps this from ever inheriting a native tooltip from an
         ancestor — nothing sets one today, but this stops one from
         silently colliding with the custom hover popup below if an
         ancestor ever gains one later. */
      ? el("span", { class: badgeClass, title: "", text: formatLatest(latest) })
      : null;

    if (badge) {
      /* One flat grid (see .ph-hover-grid in panel.css) instead of one
         wrapper div per row, so every row's time/price/diff columns line
         up like a small table rather than each row sizing its own columns
         independently — each entry contributes exactly 3 children (a
         placeholder <span> for "no diff to show" so the column count per
         row never drifts). Newest first — the most recent observation is
         what you care about first. */
      const cells = history.map((entry, i) => {
        const prev = i > 0 ? history[i - 1] : null;
        const before = prev ? toChaosEquivalent(prev) : null;
        const after = prev ? toChaosEquivalent(entry) : null;
        const diff = before != null && after != null ? after - before : null;

        return [
          el("span", { class: "ph-hover-time", text: formatHistoryTimestamp(entry.capturedAt) }),
          el("span", { class: "ph-hover-price", text: formatAmount(entry) }),
          diff
            ? el("span", { class: `ph-hover-diff ph-hover-diff-${diff > 0 ? "up" : "down"}`, text: formatChaosDelta(diff, version) })
            : el("span"),
        ];
      }).reverse().flat();

      const lines = [el("div", { class: "ph-hover-grid" }, cells)];

      /* A plain, single-color trend line above the table — oldest to newest
         left-to-right (chart convention), colored by the same up/down
         `trend` used for the arrow next to the badge. Skipped entirely
         rather than guessed at when there's nothing to compare (one entry)
         or the currencies aren't comparable yet (rate not loaded) — same
         "don't show it rather than show it wrong" rule as priceTrend
         itself. */
      const sparkValues = history.map(toChaosEquivalent);
      if (history.length >= 2 && sparkValues.every((v) => v != null)) {
        const color =
          trend?.direction === "down" ? "#6fae5c" :
          trend?.direction === "up" ? "var(--ph-danger)" :
          "var(--ph-muted)";
        lines.unshift(PH.ui.sparklineSvg(sparkValues, color));
      }

      PH.ui.hoverPopup(badge, lines, { title: historyTitle });
    }

    /* "same" never gets a tier — 0% never crosses arrowTier's 10%/30%
       thresholds anyway, but being explicit here means that stays true
       even if those thresholds ever change. */
    const trendTier = trend && trend.direction !== "same" ? arrowTier(trend.percent) : null;
    const trendBadge = trend
      ? el("span", {
          class: `ph-trade-trend ph-trend-${trend.direction}${trendTier ? ` ph-trend-tier-${trendTier}` : ""}`,
          title: trendTitle(trend),
          text: trend.direction === "same" ? "=" : trend.direction === "down" ? "▼" : "▲",
        })
      : null;

    return { badge, trendBadge, trend, trendTier };
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
        button("Save file", {
          onClick: async () => {
            PH.exchange.downloadBackup(await PH.exchange.generateBackupText());
            toast("Backup downloaded");
          },
        }),
        button("Restore from file", { onClick: () => filePicker.click() })
      ),
      el("div", { class: "ph-backup-note", text: "Reads Better Trading backups too. Restoring adds folders, it never deletes." }),
      filePicker
    );
  }

  return { render, notePriceIfMatch };
})();
