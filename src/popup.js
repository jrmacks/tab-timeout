import { normalizeSettings } from "./logic.js";

const $ = (id) => document.getElementById(id);

async function render() {
  const { settings } = await chrome.storage.sync.get("settings");
  const s = normalizeSettings(settings || {});
  $("enabled").checked = s.enabled;
  $("idle").textContent = `${s.idleMinutes} min idle`;

  const { tabState } = await chrome.storage.session.get("tabState");
  $("count").textContent = String(Object.keys(tabState || {}).length);
}

$("enabled").addEventListener("change", async (e) => {
  const { settings } = await chrome.storage.sync.get("settings");
  const next = normalizeSettings({ ...(settings || {}), enabled: e.target.checked });
  await chrome.storage.sync.set({ settings: next });
});

$("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

render();
