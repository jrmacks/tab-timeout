// Pure, side-effect-free helpers shared by the service worker and the unit tests.
// Nothing here may touch chrome.* — keep it trivially testable under node:test.

export const DEFAULT_SETTINGS = {
  enabled: true,
  idleMinutes: 10,
  graceSeconds: 60,
  retentionDays: 7,
  exemptPinned: true,
  exemptAudible: true,
  exemptActive: true,
  exemptUnsavedInput: true,
};

// Clamp ranges for the options form so a fat-fingered value can't brick the sweep.
export const LIMITS = {
  idleMinutes: { min: 1, max: 1440 },
  graceSeconds: { min: 5, max: 3600 },
  retentionDays: { min: 1, max: 365 },
};

export function normalizeSettings(raw = {}) {
  const out = { ...DEFAULT_SETTINGS, ...raw };
  for (const key of Object.keys(LIMITS)) {
    const n = Number(out[key]);
    const { min, max } = LIMITS[key];
    out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULT_SETTINGS[key];
  }
  for (const key of ["enabled", "exemptPinned", "exemptAudible", "exemptActive", "exemptUnsavedInput"]) {
    out[key] = Boolean(out[key]);
  }
  return out;
}

export function idleMs(now, lastActive) {
  return Math.max(0, now - (lastActive ?? now));
}

// Synchronous exemptions derived purely from the tab object + settings.
// Unsaved-input is handled separately because it needs an async content-script round trip.
export function isExempt(tab, settings) {
  if (!tab) return true;
  if (settings.exemptPinned && tab.pinned) return true;
  if (settings.exemptAudible && tab.audible) return true;
  if (settings.exemptActive && tab.active) return true;
  return false;
}

export function isPastIdle(elapsedMs, settings) {
  return elapsedMs >= settings.idleMinutes * 60_000;
}

export function isPastGrace(now, notifiedAt, settings) {
  if (!notifiedAt) return false;
  return now - notifiedAt >= settings.graceSeconds * 1000;
}

export function isExpiredBookmark(bookmark, now, settings) {
  if (!bookmark || !bookmark.url || !bookmark.dateAdded) return false;
  return now - bookmark.dateAdded >= settings.retentionDays * 86_400_000;
}

// Only http(s) pages are worth archiving; chrome://, about:, file:// etc. are skipped.
export function isArchivable(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

export function truncate(text, max = 60) {
  const s = (text ?? "").trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

export function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
