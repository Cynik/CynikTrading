/* The popup is only settings now — bookmarks moved into the in-page panel.
   It's destroyed the moment you click away, so it reads fresh every time. */

const rateEl = document.getElementById("rate");
const tildeBox = document.getElementById("tilde");
const pricesBox = document.getElementById("prices");

const DEFAULTS = { tildePrefix: true, showPriceConversion: true };

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...settings };
}

async function bindToggle(box, key) {
  const settings = await getSettings();
  box.checked = settings[key] !== false;

  box.addEventListener("change", async () => {
    const current = await getSettings();
    current[key] = box.checked;
    await chrome.storage.local.set({ settings: current });
  });
}

async function showRate() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_CURRENCY_RATE", game: "poe1" });
    rateEl.textContent = res?.ok
      ? `1 divine ≈ ${res.data.divineInChaos.toFixed(1)} chaos · ${res.data.league}`
      : "Exchange rate unavailable";
  } catch {
    rateEl.textContent = "Exchange rate unavailable";
  }
}

bindToggle(tildeBox, "tildePrefix");
bindToggle(pricesBox, "showPriceConversion");
showRate();
