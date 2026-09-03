/* =========================================================================
   icons.js — folder icons.
   =========================================================================
   Better Trading ships 64 PNGs (MIT licensed — see README), one per slug, and
   we bundle those same files under src/assets/icons/bookmark-folder/. Since
   we keep the SAME slugs Better Trading uses ("ascendant", "poe2-titan",
   "divine"), its export codes import cleanly and a slug always resolves to a
   real icon.

   The old monogram-badge rendering (a coloured span with the slug's initials)
   stays as a defensive fallback via <img onerror>, in case a file ever fails
   to load — not because we expect it to.
   ========================================================================= */

window.PH = window.PH || {};

PH.icons = (() => {
  /* Grouped the way the picker displays them: one row per base class. */
  const POE1_CLASSES = [
    ["Duelist",  "#b8482f", ["slayer", "gladiator", "champion"]],
    ["Shadow",   "#2f7f6a", ["assassin", "saboteur", "trickster"]],
    ["Marauder", "#a5462b", ["juggernaut", "berserker", "chieftain"]],
    ["Witch",    "#5a4b9c", ["necromancer", "elementalist", "occultist"]],
    ["Ranger",   "#3f8a3f", ["deadeye", "raider", "pathfinder"]],
    ["Templar",  "#9c8033", ["guardian", "hierophant", "inquisitor"]],
    ["Scion",    "#8a5f9c", ["ascendant"]],
  ];

  const POE2_CLASSES = [
    ["Warrior",   "#a5462b", ["poe2-titan", "poe2-warbringer", "poe2-smith-of-kitava"]],
    ["Sorceress", "#3f6ea8", ["poe2-chronomancer", "poe2-stormweaver"]],
    ["Ranger",    "#3f8a3f", ["poe2-deadeye", "poe2-pathfinder"]],
    ["Huntress",  "#4f8a6a", ["poe2-ritualist", "poe2-amazon"]],
    ["Monk",      "#2f7f8a", ["poe2-invoker", "poe2-acolyte-of-chayula"]],
    ["Mercenary", "#8a6a33", ["poe2-witch-hunter", "poe2-gemling-legionnaire", "poe2-tactician"]],
    ["Witch",     "#5a4b9c", ["poe2-infernalist", "poe2-blood-mage", "poe2-lich"]],
  ];

  const POE1_ITEMS = ["alchemy", "chaos", "exalt", "divine", "mirror", "card", "essence", "fossil", "map", "scarab"];

  const POE2_ITEMS = ["poe2-alchemy", "poe2-annul", "poe2-artificer", "poe2-augment", "poe2-chance",
    "poe2-chaos", "poe2-divine", "poe2-essence", "poe2-exalt", "poe2-gemcutter", "poe2-glassblower",
    "poe2-mirror", "poe2-regal", "poe2-rune", "poe2-transmute", "poe2-vaal", "poe2-waystone", "poe2-wisdom"];

  const ITEM_COLOR = "#7d6a3a";

  /* slug -> colour, built once from the tables above. */
  const COLORS = {};
  for (const [, color, slugs] of [...POE1_CLASSES, ...POE2_CLASSES]) {
    for (const slug of slugs) COLORS[slug] = color;
  }
  for (const slug of [...POE1_ITEMS, ...POE2_ITEMS]) COLORS[slug] = ITEM_COLOR;

  function label(slug) {
    if (!slug) return "?";
    const words = slug.replace(/^poe2-/, "").split("-");
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return words[0].slice(0, 2).toUpperCase();
  }

  function prettyName(slug) {
    return slug
      .replace(/^poe2-/, "")
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  }

  /* The monogram badge — used for the `null` placeholder, and as the
     onerror fallback below if a bundled icon file ever fails to load. */
  function monogramBadge(slug) {
    const el = document.createElement("span");
    el.className = "ph-icon ph-icon-mono";
    el.textContent = label(slug);
    el.style.background = COLORS[slug] ?? "#3a4048";
    /* PH.ui.hoverPopup, not the native title attribute — see the note
       above ui.js's own el() for why every tooltip in this project goes
       through that one mechanism instead. icons.js loads before ui.js
       (manifest.json's own script order), but PH.ui is only read here at
       call time, well after every content script has finished loading. */
    if (slug) {
      el.setAttribute("aria-label", prettyName(slug));
      PH.ui.hoverPopup(el, [prettyName(slug)]);
    }
    return el;
  }

  /* Returns an <img> for a slug's bundled icon, or a monogram badge if
     there's no slug (the neutral placeholder) or the image fails to load. */
  function render(slug) {
    if (!slug) return monogramBadge(slug);

    const img = document.createElement("img");
    img.className = "ph-icon";
    img.src = PH.browserAPI.runtime.getURL(`src/assets/icons/bookmark-folder/${slug}.png`);
    img.alt = "";
    img.setAttribute("aria-label", prettyName(slug));
    PH.ui.hoverPopup(img, [prettyName(slug)]);
    img.onerror = () => img.replaceWith(monogramBadge(slug));
    return img;
  }

  function optionsFor(version) {
    return {
      classes: version === "2" ? POE2_CLASSES : POE1_CLASSES,
      items: version === "2" ? POE2_ITEMS : POE1_ITEMS,
    };
  }

  return { render, optionsFor, prettyName };
})();
