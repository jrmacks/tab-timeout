import { normalizeSettings } from "./logic.js";

const NUMERIC = ["idleMinutes", "graceSeconds", "retentionDays"];
const BOOLEAN = ["enabled", "exemptPinned", "exemptAudible", "exemptActive", "exemptUnsavedInput"];

const $ = (id) => document.getElementById(id);

async function load() {
  const { settings } = await chrome.storage.sync.get("settings");
  const s = normalizeSettings(settings || {});
  for (const key of NUMERIC) $(key).value = s[key];
  for (const key of BOOLEAN) $(key).checked = s[key];
}

async function save() {
  const raw = {};
  for (const key of NUMERIC) raw[key] = Number($(key).value);
  for (const key of BOOLEAN) raw[key] = $(key).checked;
  const settings = normalizeSettings(raw);

  await chrome.storage.sync.set({ settings });
  // Reflect any clamping back into the form.
  for (const key of NUMERIC) $(key).value = settings[key];

  const status = $("status");
  status.textContent = "Saved ✓";
  status.classList.add("show");
  setTimeout(() => status.classList.remove("show"), 1600);
}

$("save").addEventListener("click", save);
load();
