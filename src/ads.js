/**
 * Focus — ad handling, ported from yt-ads-sucks (v1.2.0).
 *
 * Detects when YouTube's player shows an ad (`ad-showing` / `ad-interrupting`
 * on the player container) and, depending on settings:
 *   1. Mutes the <video>, restoring the user's mute state afterwards.
 *   2. Covers the video with a black screen, keeping YouTube's "Skip" button
 *      and countdown visible and clickable.
 *   3. Adds a button to show/hide the ad (default: hidden).
 *   4. Skips by itself: speeds playback up so the "Skip" button unlocks as
 *      soon as possible (~5s) and clicks it. Non-skippable ads just run fast
 *      and muted.
 *
 * Works whether Focus mode is on or off (same as the original extension).
 */
(() => {
  "use strict";
  const { t, cache } = globalThis.FX;

  const AD_CLASSES = ["ad-showing", "ad-interrupting"];
  const REVEAL_CLASS = "ytas-reveal";
  const NO_BLACKOUT_CLASS = "ytas-no-blackout";

  // YouTube's "Skip" button selectors (old and new/modern variants).
  const SKIP_BUTTON_SELECTORS = [
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-container button",
    "button.ytp-ad-skip-button-modern",
  ];

  const AD_PLAYBACK_RATE = 16;

  let userMutedBeforeAd = null; // null = not in an ad
  let wasAdShowing = false;

  const settings = () => cache.settings;
  const getPlayer = () => document.querySelector(".html5-video-player");
  const getVideo = (player) => (player || document).querySelector("video.html5-main-video, video");
  const isAdShowing = (player) => AD_CLASSES.some((c) => player.classList.contains(c));

  // ----------------------------------------------------------- auto-skip
  function trySkipAd(player) {
    const scope = player || document;
    for (const sel of SKIP_BUTTON_SELECTORS) {
      const btn = scope.querySelector(sel);
      if (btn && btn.offsetParent !== null && !btn.disabled) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  // YouTube sometimes resets the rate, so it is re-applied on every check.
  function speedUpAd(video) {
    try {
      if (video.playbackRate !== AD_PLAYBACK_RATE) video.playbackRate = AD_PLAYBACK_RATE;
    } catch (_) {
      /* some ads block playbackRate changes */
    }
  }

  // ----------------------------------------------------------- overlay + toggle
  function updateToggleLabel(player) {
    const btn = player.querySelector(".ytas-toggle");
    if (!btn) return;
    const revealed = player.classList.contains(REVEAL_CLASS);
    btn.textContent = revealed ? t("adHide") : t("adShow");
    btn.setAttribute("aria-pressed", String(revealed));
  }

  function ensureUi(player) {
    // Overlay sits right after the video container: above <video>, below the
    // ad module (Skip button, countdown).
    if (!player.querySelector(".ytas-blackout")) {
      const overlay = document.createElement("div");
      overlay.className = "ytas-blackout";
      overlay.setAttribute("aria-hidden", "true");
      const title = document.createElement("div");
      title.className = "ytas-blackout-title";
      title.textContent = t("adRunning");
      const sub = document.createElement("div");
      sub.className = "ytas-blackout-sub";
      sub.textContent = t("adSub");
      overlay.append(title, sub);
      const videoContainer = player.querySelector(".html5-video-container");
      if (videoContainer) videoContainer.insertAdjacentElement("afterend", overlay);
      else player.prepend(overlay);
    }

    if (!player.querySelector(".ytas-toggle")) {
      const btn = document.createElement("button");
      btn.className = "ytas-toggle";
      btn.type = "button";
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); // don't toggle play/pause
        e.preventDefault();
        player.classList.toggle(REVEAL_CLASS);
        updateToggleLabel(player);
      });
      btn.addEventListener("keydown", (e) => e.stopPropagation());
      player.appendChild(btn);
    }

    player.classList.toggle(NO_BLACKOUT_CLASS, !settings().adBlackout);
    updateToggleLabel(player);
  }

  // ----------------------------------------------------------- main loop
  function check() {
    const player = getPlayer();
    if (!player) return;
    ensureUi(player);

    const video = getVideo(player);
    if (!video) return;

    const s = settings();
    const adShowing = isAdShowing(player);

    if (adShowing && !wasAdShowing) {
      userMutedBeforeAd = video.muted;
      if (s.adMute) video.muted = true;
      player.classList.remove(REVEAL_CLASS);
      updateToggleLabel(player);
      wasAdShowing = true;
      if (s.adSkip) {
        speedUpAd(video);
        trySkipAd(player);
      }
    } else if (adShowing) {
      // Keep muted even if the player unmutes when switching between ads.
      if (s.adMute && !video.muted) video.muted = true;
      if (s.adSkip) {
        speedUpAd(video);
        trySkipAd(player);
      }
    } else if (wasAdShowing) {
      if (userMutedBeforeAd !== null) video.muted = userMutedBeforeAd;
      try {
        if (video.playbackRate !== 1) video.playbackRate = 1;
      } catch (_) {
        /* ignore */
      }
      userMutedBeforeAd = null;
      wasAdShowing = false;
      player.classList.remove(REVEAL_CLASS);
      updateToggleLabel(player);
    }
  }

  // The player signals ads through class changes.
  let observer = null;
  let observedPlayer = null;

  function attachObserver() {
    const player = getPlayer();
    if (!player || player === observedPlayer) return;
    if (observer) observer.disconnect();
    observer = new MutationObserver(check);
    observer.observe(player, { attributes: true, attributeFilter: ["class"] });
    observedPlayer = player;
    check();
  }

  // YouTube is an SPA: the player can be recreated between videos.
  const bodyObserver = new MutationObserver(() => {
    if (!observedPlayer || !document.contains(observedPlayer)) attachObserver();
  });
  bodyObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("yt-navigate-finish", () => {
    attachObserver();
    check();
  });
  globalThis.FX.onChange(check);

  // Fallback polling, frequent enough to click "Skip" as soon as it unlocks.
  setInterval(check, 250);
  attachObserver();
})();
