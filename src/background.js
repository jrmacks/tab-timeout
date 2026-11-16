import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  idleMs,
  isExempt,
  isPastIdle,
  isPastGrace,
  isExpiredBookmark,
  isArchivable,
  truncate,
  safeHostname,
} from "./logic.js";

const SWEEP_ALARM = "sweep";
const CLEANUP_ALARM = "cleanup";
const SWEEP_PERIOD_MIN = 1;
const CLEANUP_PERIOD_MIN = 720; // every 12h
const FOLDER_TITLE = "Recently Closed";
const NOTIF_PREFIX = "tab-timeout:";
const DIRTY_TIMEOUT_MS = 500;

// ---------------------------------------------------------------------------
// State serialization.
//
// The service worker is single-threaded, but async functions interleave at
// `await` boundaries. `tabState` lives under one storage key and is read-
// modify-written by several handlers, so concurrent runs could clobber each
// other (e.g. a sweep overwriting a tab the user just visited). All mutations
// go through this promise-chain lock so they apply atomically and in order.
// Helpers prefixed with `_` assume the lock is already held and must never be
// called from inside another locked section that could re-enter.
// ---------------------------------------------------------------------------

let stateChain = Promise.resolve();

function withStateLock(fn) {
  const next = stateChain.then(() => fn());
  stateChain = next.then(
    () => {},
    () => {},
  );
  return next;
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return normalizeSettings(settings || {});
}

async function getTabState() {
  const { tabState } = await chrome.storage.session.get("tabState");
  return tabState || {};
}

function setTabState(state) {
  return chrome.storage.session.set({ tabState: state });
}

// Drop a pending keep/close prompt from an entry and dismiss its notification.
function clearPending(entry) {
  if (entry.notifId) {
    chrome.notifications.clear(entry.notifId);
    delete entry.notifId;
  }
  delete entry.notifiedAt;
}

// Reset a tab's idle clock and dismiss any pending prompt.
async function touch(tabId) {
  if (typeof tabId !== "number") return;
  await withStateLock(async () => {
    const state = await getTabState();
    const entry = state[tabId] || {};
    entry.lastActive = Date.now();
    clearPending(entry);
    state[tabId] = entry;
    await setTabState(state);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

function ensureAlarms() {
  chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_PERIOD_MIN });
  chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: CLEANUP_PERIOD_MIN });
}

async function seed() {
  await withStateLock(async () => {
    const now = Date.now();
    const tabs = await chrome.tabs.query({});
    const state = {};
    for (const tab of tabs) state[tab.id] = { lastActive: now };
    await setTabState(state);
  });
  ensureAlarms();
  resolveFolderId().catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.sync.get("settings");
  if (!settings) await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  await seed();
});

chrome.runtime.onStartup.addListener(seed);

// ---------------------------------------------------------------------------
// Activity tracking.
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(({ tabId }) => touch(tabId));
chrome.tabs.onCreated.addListener((tab) => touch(tab.id));

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete" || info.active) touch(tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) await touch(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) =>
  withStateLock(async () => {
    const state = await getTabState();
    const entry = state[tabId];
    if (!entry) return;
    if (entry.notifId) chrome.notifications.clear(entry.notifId);
    delete state[tabId];
    await setTabState(state);
  }),
);

// ---------------------------------------------------------------------------
// Unsaved-input check via the content script. Best-effort: a missing script
// (chrome://, web store, not-yet-injected) or a slow page counts as clean.
// ---------------------------------------------------------------------------

async function hasUnsavedInput(tabId) {
  let timer;
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "tab-timeout:isDirty" }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), DIRTY_TIMEOUT_MS);
      }),
    ]);
    return Boolean(res && res.dirty);
  } catch {
    return false;
  } finally {
    clearTimeout(timer); // don't leave a dangling timer when sendMessage wins
  }
}

// ---------------------------------------------------------------------------
// Bookmark archiving + retention cleanup.
// ---------------------------------------------------------------------------

async function resolveFolderId() {
  const { folderId } = await chrome.storage.local.get("folderId");
  if (folderId) {
    try {
      const [node] = await chrome.bookmarks.get(folderId);
      if (node && !node.url) return folderId;
    } catch {
      /* stale id; recreate below */
    }
  }

  const matches = await chrome.bookmarks.search({ title: FOLDER_TITLE });
  const existing = matches.find((n) => !n.url);
  if (existing) {
    await chrome.storage.local.set({ folderId: existing.id });
    return existing.id;
  }

  const parentId = await otherBookmarksId();
  const created = await chrome.bookmarks.create({ parentId, title: FOLDER_TITLE });
  await chrome.storage.local.set({ folderId: created.id });
  return created.id;
}

// "Other Bookmarks" is id "2" on standard Chrome; resolve from the tree so we
// degrade gracefully where that isn't true.
async function otherBookmarksId() {
  try {
    const [root] = await chrome.bookmarks.getTree();
    const children = (root && root.children) || [];
    const other = children.find((c) => c.id === "2") || children[children.length - 1] || children[0];
    if (other) return other.id;
  } catch {
    /* fall back below */
  }
  return "2";
}

async function archive(tab) {
  if (!isArchivable(tab.url)) return;
  const folderId = await resolveFolderId();
  const dupes = await chrome.bookmarks.search({ url: tab.url });
  if (dupes.some((b) => b.parentId === folderId)) return; // already archived
  await chrome.bookmarks.create({
    parentId: folderId,
    title: truncate(tab.title || tab.url, 120),
    url: tab.url,
  });
}

// Archive then close. Deliberately does NOT touch tabState — the onRemoved
// listener cleans up — so it is safe to call from inside the sweep lock.
async function archiveAndClose(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // already gone
  }
  await archive(tab);
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* race: already closed */
  }
}

async function cleanupBookmarks(settings) {
  const now = Date.now();
  let folderId;
  try {
    folderId = await resolveFolderId();
  } catch {
    return;
  }
  const children = await chrome.bookmarks.getChildren(folderId).catch(() => []);
  for (const node of children) {
    if (isExpiredBookmark(node, now, settings)) {
      await chrome.bookmarks.remove(node.id).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Keep/close notification.
// ---------------------------------------------------------------------------

async function notify(tab, entry) {
  const notifId = `${NOTIF_PREFIX}${tab.id}:${Date.now()}`;
  try {
    await chrome.notifications.create(notifId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "Idle tab — keep it open?",
      message: truncate(tab.title || tab.url, 80),
      contextMessage: safeHostname(tab.url),
      buttons: [{ title: "Keep open" }, { title: "Close now" }],
      requireInteraction: true,
      priority: 2,
    });
  } catch {
    return false; // notifications unavailable; leave the tab alone this round
  }
  entry.notifId = notifId;
  entry.notifiedAt = Date.now();
  return true;
}

function tabIdFromNotif(notifId) {
  const id = Number(notifId.split(":")[1]);
  return Number.isFinite(id) ? id : null;
}

chrome.notifications.onButtonClicked.addListener(async (notifId, buttonIndex) => {
  if (!notifId.startsWith(NOTIF_PREFIX)) return;
  const tabId = tabIdFromNotif(notifId);
  chrome.notifications.clear(notifId);
  if (tabId == null) return;
  if (buttonIndex === 0) {
    await touch(tabId); // keep open
  } else {
    await archiveAndClose(tabId); // close now
  }
});

chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId.startsWith(NOTIF_PREFIX)) return;
  const tabId = tabIdFromNotif(notifId);
  chrome.notifications.clear(notifId);
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    /* tab gone */
  }
  await touch(tabId);
});

// ---------------------------------------------------------------------------
// The sweep: the periodic heart of the extension. Runs entirely under the
// state lock so its snapshot can't be clobbered mid-flight.
// ---------------------------------------------------------------------------

async function sweep() {
  const settings = await getSettings();
  if (!settings.enabled) return;

  await withStateLock(async () => {
    const now = Date.now();
    const prev = await getTabState();
    const tabs = await chrome.tabs.query({});

    // Rebuild from the live tab set rather than mutating the old map in place.
    // Entries for tabs closed while the worker was dormant (a missed onRemoved,
    // bulk close, or crash) are simply not carried over, so tabState can never
    // accumulate orphans — it stays bounded by the number of open tabs.
    const state = {};

    for (const tab of tabs) {
      const entry = prev[tab.id] || { lastActive: now };
      state[tab.id] = entry;

      if (isExempt(tab, settings)) {
        clearPending(entry);
        continue;
      }

      const elapsed = idleMs(now, entry.lastActive);

      if (entry.notifiedAt) {
        // Awaiting a decision. Re-check idle in case the tab became active.
        if (!isPastIdle(elapsed, settings)) {
          clearPending(entry);
        } else if (isPastGrace(now, entry.notifiedAt, settings)) {
          if (settings.exemptUnsavedInput && (await hasUnsavedInput(tab.id))) {
            clearPending(entry); // user typed during the grace window
          } else {
            clearPending(entry); // dismiss the prompt before the tab disappears
            await archiveAndClose(tab.id);
            delete state[tab.id];
          }
        }
        continue;
      }

      if (isPastIdle(elapsed, settings)) {
        if (settings.exemptUnsavedInput && (await hasUnsavedInput(tab.id))) continue;
        await notify(tab, entry);
      }
    }

    await setTabState(state);
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SWEEP_ALARM) await sweep();
  else if (alarm.name === CLEANUP_ALARM) await cleanupBookmarks(await getSettings());
});
