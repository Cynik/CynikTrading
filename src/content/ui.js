/* =========================================================================
   ui.js — small helpers the tabs all use.
   =========================================================================
   Nothing clever here. It exists so bookmarks.js and saved.js don't each
   grow their own copy of "make a button" and "ask a question".
   ========================================================================= */

window.PH = window.PH || {};

PH.ui = (() => {
  /* el("div", {class: "x", onclick: fn}, "text", childEl) */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  const button = (label, opts = {}) =>
    el("button", { type: "button", class: opts.class ?? "ph-btn", title: opts.title, onclick: opts.onClick }, label);

  const iconButton = (glyph, opts = {}) =>
    el("button", {
      type: "button",
      class: `ph-icon-btn ${opts.class ?? ""}`.trim(),
      title: opts.title,
      "aria-label": opts.title ?? glyph,
      onclick: opts.onClick,
    }, glyph);

  /* A dropdown menu hung off a "…" button. One open at a time. */
  function menu(items) {
    const wrap = el("div", { class: "ph-menu-wrap" });
    const trigger = iconButton("···", { title: "More", class: "ph-menu-trigger" });
    const list = el("div", { class: "ph-menu" });

    for (const item of items) {
      if (!item) continue;
      if (item === "-") { list.append(el("div", { class: "ph-menu-sep" })); continue; }
      list.append(el("button", {
        type: "button",
        class: `ph-menu-item ${item.danger ? "ph-danger" : ""}`.trim(),
        onclick: (e) => { e.stopPropagation(); close(); item.onClick(); },
      }, item.label));
    }

    function close() {
      wrap.classList.remove("ph-menu-open");
      document.removeEventListener("click", onOutside, true);
    }
    function onOutside(e) {
      if (!wrap.contains(e.target)) close();
    }

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = !wrap.classList.contains("ph-menu-open");
      for (const other of document.querySelectorAll(".ph-menu-open")) {
        other.classList.remove("ph-menu-open");
      }
      if (opening) {
        wrap.classList.add("ph-menu-open");
        document.addEventListener("click", onOutside, true);
      }
    });

    wrap.append(trigger, list);
    return wrap;
  }

  /* An inline form instead of window.prompt(), so it looks like it belongs
     to the page and can be cancelled with Escape. */
  function inlineForm({ value = "", placeholder = "", submitLabel = "Save", onSubmit, onCancel, extra }) {
    const input = el("input", { class: "ph-input", type: "text", value, placeholder });

    const form = el("form", {
      class: "ph-form",
      onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) onSubmit(v); },
      onkeydown: (e) => { if (e.key === "Escape") { e.preventDefault(); onCancel?.(); } },
    });

    form.append(input);
    if (extra) form.append(extra);
    form.append(el("div", { class: "ph-form-actions" },
      /* Must be type="submit", not the shared button() helper (which is
         always type="button") — otherwise clicking it does nothing and only
         pressing Enter in the field would submit the form. */
      el("button", { type: "submit", class: "ph-btn ph-btn-primary" }, submitLabel),
      button("Cancel", { onClick: () => onCancel?.() })
    ));

    /* Focus after the browser has painted, or the caret lands nowhere. */
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return form;
  }

  function confirmRow(message, { onConfirm, onCancel, confirmLabel = "Delete" }) {
    return el("div", { class: "ph-confirm" },
      el("span", { class: "ph-confirm-msg", text: message }),
      button(confirmLabel, { class: "ph-btn ph-btn-danger", onClick: onConfirm }),
      button("Cancel", { onClick: onCancel })
    );
  }

  function toast(message, { error = false } = {}) {
    const node = el("div", { class: `ph-toast ${error ? "ph-toast-error" : ""}`.trim(), text: message });
    document.body.append(node);
    setTimeout(() => node.classList.add("ph-toast-out"), 2400);
    setTimeout(() => node.remove(), 3000);
  }

  function empty(message) {
    return el("div", { class: "ph-empty", text: message });
  }

  /* Shared by anything displaying a { amount, currency } price from
     PH.prices — the trade-price badge in Bookmarks, and the saved-listing
     capture button. currency is only ever exactly "chaos" or "divine" for
     those two (see readCurrency in prices.js) — anything else is that
     currency's own real display name (e.g. "Orb of Fusing"), shown as-is
     rather than mislabelled as chaos, which is what this used to do for
     every non-divine currency before readCurrency could tell them apart. */
  function formatPrice({ amount, currency }) {
    if (currency === "divine") return `${amount} div`;
    if (currency === "chaos") return `${amount}c`;
    return `${amount} ${currency}`;
  }

  /* ----------------------------------------------------------------------
     A custom hover popup — not the native `title` attribute tooltip (slow
     to appear, unstyled, one line only). Shows a small panel of `lines`
     (an array of strings, one per row) positioned under `trigger` while
     it's hovered or focused. Only one is ever open at a time.
     ---------------------------------------------------------------------- */
  let openHoverPopup = null;

  function closeHoverPopup() {
    openHoverPopup?.remove();
    openHoverPopup = null;
  }

  /* Each entry in `lines` is a plain string, {text, class} to add an extra
     class (e.g. a price-change highlight) to just that line, or a DOM node
     (e.g. a sparkline, or a whole .ph-hover-grid of rows) to insert as-is
     instead of wrapping it as a line. `title`, if given, renders as a small
     uppercase label above everything else, separated by a hairline. */
  function hoverPopup(trigger, lines, { title } = {}) {
    const show = () => {
      closeHoverPopup();
      const popup = el("div", { class: "ph-hover-popup" },
        title ? el("div", { class: "ph-hover-popup-title", text: title }) : null,
        lines.map((line) => {
          if (line instanceof Node) return line;
          const isPlain = typeof line === "string";
          return el("div", {
            class: `ph-hover-popup-line ${isPlain ? "" : line.class ?? ""}`.trim(),
            text: isPlain ? line : line.text,
          });
        })
      );
      document.body.append(popup);
      openHoverPopup = popup;

      const rect = trigger.getBoundingClientRect();
      popup.style.left = `${Math.max(4, rect.left)}px`;
      popup.style.top = `${rect.bottom + 5}px`;
      /* Keep it on-screen if the trigger is near the panel's left edge. */
      const overflow = popup.getBoundingClientRect().right - window.innerWidth + 4;
      if (overflow > 0) popup.style.left = `${Math.max(4, rect.left - overflow)}px`;
    };

    trigger.addEventListener("mouseenter", show);
    trigger.addEventListener("focus", show);
    trigger.addEventListener("mouseleave", closeHoverPopup);
    trigger.addEventListener("blur", closeHoverPopup);
  }

  /* "3 minutes ago" without pulling in a date library. */
  function timeAgo(iso) {
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    const steps = [
      [60, "s"], [3600, "m"], [86400, "h"], [604800, "d"], [2629800, "w"],
    ];
    if (seconds < 60) return `${Math.floor(seconds)}s ago`;
    for (let i = 1; i < steps.length; i++) {
      if (seconds < steps[i][0]) {
        return `${Math.floor(seconds / steps[i - 1][0])}${steps[i][1]} ago`;
      }
    }
    return `${Math.floor(seconds / 2629800)}mo ago`;
  }

  /* ----------------------------------------------------------------------
     Drag to reorder, using the browser's own drag events.

     `container` holds the rows; each draggable row needs data-id set. When a
     drop finishes we hand back the ids in their new order and let the caller
     persist that.
     ---------------------------------------------------------------------- */
  function makeSortable(container, { handleSelector, onReorder }) {
    let dragged = null;

    container.addEventListener("dragstart", (e) => {
      const row = e.target.closest("[data-id]");
      if (!row || !container.contains(row)) return;
      dragged = row;
      row.classList.add("ph-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.dataset.id);
    });

    container.addEventListener("dragover", (e) => {
      if (!dragged) return;
      e.preventDefault();
      const over = e.target.closest("[data-id]");
      if (!over || over === dragged || !container.contains(over)) return;

      /* Insert before or after depending on which half we're hovering. */
      const box = over.getBoundingClientRect();
      const after = e.clientY > box.top + box.height / 2;
      over.parentNode.insertBefore(dragged, after ? over.nextSibling : over);
    });

    container.addEventListener("dragend", () => {
      if (!dragged) return;
      dragged.classList.remove("ph-dragging");
      dragged = null;
      const ids = [...container.querySelectorAll(":scope > [data-id]")].map((n) => n.dataset.id);
      onReorder(ids);
    });

    /* Rows are only draggable while the grip is held, so clicking a link or
       opening a menu doesn't start a drag. */
    container.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest(handleSelector);
      const row = e.target.closest("[data-id]");
      if (row) row.draggable = Boolean(grip);
    });
  }

  /* A minimal single-color line — no axes, labels, or gridlines by design.
     `values` must already be in one comparable unit (the caller converts
     currencies first); this doesn't know or care what they represent. */
  function sparklineSvg(values, color) {
    const W = 100, H = 26, PAD = 2;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1; // all-equal values still render, just as a flat line
    const step = values.length > 1 ? (W - PAD * 2) / (values.length - 1) : 0;

    const points = values
      .map((v, i) => {
        const x = PAD + i * step;
        const y = H - PAD - ((v - min) / span) * (H - PAD * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "ph-sparkline");

    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", points);
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", color);
    polyline.setAttribute("stroke-width", "2");
    polyline.setAttribute("stroke-linecap", "round");
    polyline.setAttribute("stroke-linejoin", "round");
    polyline.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(polyline);

    return svg;
  }

  return {
    el, button, iconButton, menu, inlineForm, confirmRow, toast, empty, timeAgo, makeSortable, formatPrice,
    hoverPopup, closeHoverPopup, sparklineSvg,
  };
})();
