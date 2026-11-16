// Tracks whether the page has unsaved user input so the background worker can
// spare such tabs from auto-close. Deliberately tiny and best-effort: we only
// flip a boolean and answer one message type.

(() => {
  let dirty = false;

  const markDirty = () => {
    dirty = true;
  };

  // Capture phase so we still see events that stop propagation.
  document.addEventListener("input", markDirty, true);
  document.addEventListener("change", markDirty, true);

  // A submit (or reset) means the input was acted on — no longer "unsaved".
  const clearDirty = () => {
    dirty = false;
  };
  document.addEventListener("submit", clearDirty, true);
  document.addEventListener("reset", clearDirty, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "tab-timeout:isDirty") {
      sendResponse({ dirty });
    }
  });
})();
