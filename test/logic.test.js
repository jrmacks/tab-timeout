import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  LIMITS,
  normalizeSettings,
  idleMs,
  isExempt,
  isPastIdle,
  isPastGrace,
  isExpiredBookmark,
  isArchivable,
  truncate,
  safeHostname,
} from "../src/logic.js";

const MIN = 60_000;
const DAY = 86_400_000;

test("normalizeSettings fills defaults from an empty object", () => {
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
});

test("normalizeSettings clamps numeric values into range", () => {
  const s = normalizeSettings({ idleMinutes: 0, graceSeconds: 99999, retentionDays: -4 });
  assert.equal(s.idleMinutes, LIMITS.idleMinutes.min);
  assert.equal(s.graceSeconds, LIMITS.graceSeconds.max);
  assert.equal(s.retentionDays, LIMITS.retentionDays.min);
});

test("normalizeSettings rounds and coerces non-numbers to defaults", () => {
  assert.equal(normalizeSettings({ idleMinutes: 12.7 }).idleMinutes, 13);
  assert.equal(normalizeSettings({ idleMinutes: "abc" }).idleMinutes, DEFAULT_SETTINGS.idleMinutes);
});

test("normalizeSettings coerces booleans", () => {
  const s = normalizeSettings({ enabled: 0, exemptPinned: "yes" });
  assert.equal(s.enabled, false);
  assert.equal(s.exemptPinned, true);
});

test("idleMs never goes negative and treats missing lastActive as now", () => {
  assert.equal(idleMs(1000, 400), 600);
  assert.equal(idleMs(1000, 2000), 0);
  assert.equal(idleMs(1000, undefined), 0);
});

test("isExempt honors each toggle", () => {
  assert.equal(isExempt({ pinned: true }, DEFAULT_SETTINGS), true);
  assert.equal(isExempt({ audible: true }, DEFAULT_SETTINGS), true);
  assert.equal(isExempt({ active: true }, DEFAULT_SETTINGS), true);
  assert.equal(isExempt({ pinned: false, audible: false, active: false }, DEFAULT_SETTINGS), false);
});

test("isExempt respects disabled toggles", () => {
  const s = normalizeSettings({ exemptPinned: false, exemptAudible: false, exemptActive: false });
  assert.equal(isExempt({ pinned: true, audible: true, active: true }, s), false);
});

test("isExempt treats a missing tab as exempt (defensive)", () => {
  assert.equal(isExempt(null, DEFAULT_SETTINGS), true);
});

test("isPastIdle compares against idleMinutes", () => {
  assert.equal(isPastIdle(10 * MIN, DEFAULT_SETTINGS), true);
  assert.equal(isPastIdle(10 * MIN - 1, DEFAULT_SETTINGS), false);
});

test("isPastGrace needs a notifiedAt and the full grace window", () => {
  const now = 1_000_000;
  assert.equal(isPastGrace(now, undefined, DEFAULT_SETTINGS), false);
  assert.equal(isPastGrace(now, now - 60_000, DEFAULT_SETTINGS), true);
  assert.equal(isPastGrace(now, now - 59_000, DEFAULT_SETTINGS), false);
});

test("isExpiredBookmark uses dateAdded and retentionDays", () => {
  const now = 100 * DAY;
  assert.equal(isExpiredBookmark({ url: "https://a", dateAdded: now - 7 * DAY }, now, DEFAULT_SETTINGS), true);
  assert.equal(isExpiredBookmark({ url: "https://a", dateAdded: now - 6 * DAY }, now, DEFAULT_SETTINGS), false);
});

test("isExpiredBookmark ignores folders and entries without a timestamp", () => {
  const now = 100 * DAY;
  assert.equal(isExpiredBookmark({ title: "folder" }, now, DEFAULT_SETTINGS), false);
  assert.equal(isExpiredBookmark({ url: "https://a" }, now, DEFAULT_SETTINGS), false);
  assert.equal(isExpiredBookmark(null, now, DEFAULT_SETTINGS), false);
});

test("isArchivable accepts only http(s)", () => {
  assert.equal(isArchivable("https://example.com"), true);
  assert.equal(isArchivable("http://example.com"), true);
  assert.equal(isArchivable("chrome://newtab"), false);
  assert.equal(isArchivable("about:blank"), false);
  assert.equal(isArchivable(undefined), false);
});

test("truncate shortens long strings with an ellipsis", () => {
  assert.equal(truncate("hello", 60), "hello");
  assert.equal(truncate("  spaced  ", 60), "spaced");
  assert.equal(truncate("abcdefghij", 5), "abcd…");
  assert.equal(truncate(undefined), "");
});

test("safeHostname extracts host and tolerates junk", () => {
  assert.equal(safeHostname("https://news.example.com/x?y=1"), "news.example.com");
  assert.equal(safeHostname("not a url"), "");
});
