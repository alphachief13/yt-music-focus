/**
 * Focus — service worker.
 * Only job: flip the `focus` setting from the toolbar icon or the keyboard
 * shortcut. Content scripts react to chrome.storage changes on their own.
 */
"use strict";

// Optional GNOME panel bridge (off unless enabled on the options page).
importScripts("shared.js", "desktop.js");

async function toggleFocus() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const focus = settings.focus === false; // undefined => currently on => turn off
  await chrome.storage.local.set({ settings: { ...settings, focus } });
  await syncTitle(focus);
}

async function syncTitle(focus) {
  if (focus === undefined) {
    const { settings = {} } = await chrome.storage.local.get("settings");
    focus = settings.focus !== false;
  }
  await chrome.action.setTitle({ title: `Focus — ${focus ? "on" : "off"}` });
  await chrome.action.setBadgeText({ text: focus ? "" : "off" });
  await chrome.action.setBadgeBackgroundColor({ color: "#2a2a2a" });
}

chrome.action.onClicked.addListener(toggleFocus);
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "toggle-focus") toggleFocus();
});
chrome.runtime.onInstalled.addListener(() => syncTitle());
chrome.runtime.onStartup.addListener(() => syncTitle());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    syncTitle(changes.settings.newValue?.focus !== false);
  }
});
