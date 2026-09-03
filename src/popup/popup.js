/* The popup is only settings now — bookmarks moved into the in-page panel.
   It's destroyed the moment you click away, so it reads fresh every time. */

const rateEl = document.getElementById("rate");
const tildeBox = document.getElementById("tilde");
const pricesBox = document.getElementById("prices");
const sortBox = document.getElementById("sort");

const DEFAULTS = { tildePrefix: true, showPriceConversion: true, sortByTruePrice: true };

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...settings };
}

/* Both checkboxes' change handlers read-then-write the same `settings`
   object — toggling one right after the other (fast keyboard tabbing, or
   just two quick clicks) can otherwise interleave: the second handler's
   read lands before the first handler's write, so its write clobbers the
   first toggle instead of building on it. Chaining every write through
   this one promise serializes them. */
let writeChain = Promise.resolve();
function serialize(fn) {
  const result = writeChain.then(fn, fn);
  writeChain = result.then(() => {}, () => {});
  return result;
}

async function bindToggle(box, key) {
  const settings = await getSettings();
  box.checked = settings[key] !== false;

  box.addEventListener("change", () => serialize(async () => {
    const current = await getSettings();
    current[key] = box.checked;
    await chrome.storage.local.set({ settings: current });
  }));
}

/* Which game the active tab is on ("/trade2/..." is PoE 2, everything else
   is PoE 1 — same rule as PH.location.parseVersion in the content script,
   duplicated here since the popup is a separate context with no access to
   that module). Falls back to poe1 if the active tab isn't a trade page. */
async function activeGame() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const path = tab?.url ? new URL(tab.url).pathname : "";
    return path.startsWith("/trade2") ? "poe2" : "poe1";
  } catch {
    return "poe1";
  }
}

/* For PoE2, Exalted Orb takes the role Chaos Orb plays in PoE1's own
   divine<->"small unit" pairing (see poe2-exalt-replaces-chaos-in-hierarchy
   — Exalted, not Chaos, is PoE2's actual common bulk currency). res.data
   is the full rate object GET_CURRENCY_RATE returns, which already
   carries chaosValueByName (built in service-worker.js's
   fetchCurrencyRates) for exactly this — no separate fetch needed. Falls
   back to chaos if that rate hasn't loaded yet, same as everywhere else
   this substitution is made. */
async function showRate() {
  try {
    const game = await activeGame();
    const res = await chrome.runtime.sendMessage({ type: "GET_CURRENCY_RATE", game });
    if (!res?.ok) {
      rateEl.textContent = "Exchange rate unavailable";
      return;
    }
    const { divineInChaos, chaosValueByName, league } = res.data;
    const exaltedInChaos = game === "poe2" ? chaosValueByName?.["Exalted Orb"] : null;
    rateEl.textContent = exaltedInChaos
      ? `1 divine ≈ ${(divineInChaos / exaltedInChaos).toFixed(1)} exalted · ${league}`
      : `1 divine ≈ ${divineInChaos.toFixed(1)} chaos · ${league}`;
  } catch {
    rateEl.textContent = "Exchange rate unavailable";
  }
}

bindToggle(tildeBox, "tildePrefix");
bindToggle(pricesBox, "showPriceConversion");
bindToggle(sortBox, "sortByTruePrice");
showRate();
