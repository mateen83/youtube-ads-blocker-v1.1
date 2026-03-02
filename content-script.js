; (async () => {
  const state = {
    enabled: true,
    lastScan: 0,
    scanIntervalMs: 500,
    adLoopActive: false,
    savedVolume: -1,
  }

  const chromeApi = window.chrome

  try {
    const { enabled } = await chromeApi.storage.sync.get({ enabled: true })
    state.enabled = enabled
  } catch {
    state.enabled = true
  }

  if (!state.enabled) return

  const REMOVE_SELECTORS = [
    "#masthead-ad",
    "ytd-ad-slot-renderer",
    "ytd-display-ad-renderer",
    "ytd-action-companion-ad-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-promoted-video-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-search-pyv-renderer",
    "ytd-companion-slot-renderer",
    "ytd-banner-promo-renderer",
    "ytd-rich-section-renderer[is-shorts-ads]",
    "ytd-ad-feedback-renderer",
    "ytd-ads-engagement-panel-content-renderer",
    '#panels ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
    "ad-grid-card-collection-view-model",
    "ad-grid-card-text-view-model",
    "ad-button-view-model",
    "panel-text-icon-text-grid-cards-sub-layout-content-view-model",
    "#clarify-box",
    "ytd-emergency-onebox-renderer",
    "#player-ads",
    ".ytp-ad-module",
    ".ytp-ad-image-overlay",
    ".ytp-ad-player-overlay",
    ".ytp-ad-overlay-container",
    ".ytp-ad-overlay-slot",
  ]

  const SKIP_BUTTON_SELECTORS = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-slot button",
    ".ytp-ad-skip-button-container button",
    "button.ytp-ad-skip-button-modern",
    ".ytp-ad-overlay-close-button",
    ".ytp-ad-survey-answer-button",
  ]
  function injectStyles() {
    if (document.getElementById("yt-ad-blocker-styles")) return
    const style = document.createElement("style")
    style.id = "yt-ad-blocker-styles"
    style.textContent = `
      ${REMOVE_SELECTORS.join(", ")} {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        width: 0 !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
      /* Prevent grid layout breakage by making sure ad slots don't take up space */
      ytd-rich-item-renderer:has(${REMOVE_SELECTORS.join(", ")}) {
        display: none !important;
      }
      /* Hide ad video & overlay so user never sees ad content */
      .ad-showing video {
        opacity: 0 !important;
      }
      .ad-showing .ytp-ad-player-overlay,
      .ad-showing .ytp-ad-player-overlay-instream-info,
      .ad-showing .ytp-ad-text,
      .ad-showing .ytp-ad-preview-container,
      .ad-showing .ytp-ad-skip-button-slot,
      .ad-showing .ytp-ad-message-slot,
      .ad-showing .ytp-ad-visit-advertiser-button {
        display: none !important;
      }
    `
    document.documentElement.appendChild(style)
  }

  const now = () => performance.now()
  const isWatchOrShorts = () => {
    const p = location.pathname
    return p === "/watch" || p.startsWith("/shorts/")
  }
  const selectVideo = () => document.querySelector("video")

  function isAdShowing() {
    const player = document.querySelector(".html5-video-player")
    if (!player) return false
    return (
      player.classList.contains("ad-showing") ||
      player.classList.contains("ad-interrupting")
    )
  }

  function clickIfExists(selector) {
    const el = document.querySelector(selector)
    if (el && el.offsetHeight > 0) {
      try {
        el.click()
        return true
      } catch { }
    }
    return false
  }

  function muteForAd() {
    const v = selectVideo()
    if (!v) return
    if (state.savedVolume < 0) {
      state.savedVolume = v.volume
    }
    try { v.volume = 0 } catch { }
  }

  function restoreVolume() {
    const v = selectVideo()
    if (!v) return
    if (state.savedVolume >= 0) {
      try { v.volume = state.savedVolume } catch { }
      state.savedVolume = -1
    }
  }

  /** Force the ad video to end instantly and tell YouTube to move on. */
  function forceEndAdVideo() {
    const v = selectVideo()
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0.1) return
    try {
      v.currentTime = v.duration - 0.1
      v.playbackRate = 16
      if (v.paused) v.play().catch(() => { })
    } catch { }
  }

  /** Click every known skip / dismiss button. */
  function clickAllSkipButtons() {
    for (const sel of SKIP_BUTTON_SELECTORS) {
      clickIfExists(sel)
    }
  }

  /**
   * Force-clear the ad-showing state from the player so the real video
   * becomes visible again (removes the black screen).
   */
  function forceRemoveAdState() {
    const player = document.querySelector(".html5-video-player")
    if (!player) return
    player.classList.remove("ad-showing", "ad-interrupting")
    // Also remove any leftover ad overlay elements from the DOM
    const adOverlays = document.querySelectorAll(
      ".ytp-ad-player-overlay, .ytp-ad-player-overlay-instream-info, " +
      ".ytp-ad-text, .ytp-ad-preview-container, .ytp-ad-module"
    )
    adOverlays.forEach(el =>
      el.style.setProperty("display", "none", "important")
    )
    restoreVolume()
    const v = selectVideo()
    if (v) {
      v.playbackRate = 1
      if (v.paused) v.play().catch(() => { })
    }
  }

  function skipAdIfAny() {
    if (!isAdShowing()) {
      restoreVolume()
      return false
    }

    muteForAd()

    // Step 1: Seek the ad video to its end
    forceEndAdVideo()

    // Step 2: Click all skip / dismiss buttons
    clickAllSkipButtons()

    // Step 3: Schedule aggressive cleanup to remove the stuck ad-showing
    // state. This is what fixes the persistent black screen — if YouTube
    // doesn't clear ad-showing on its own, we force it off.
    scheduleAdShowingCleanup()

    return true
  }

  let cleanupTimer1 = null
  let cleanupTimer2 = null
  function scheduleAdShowingCleanup() {
    // Fast first attempt at 100ms
    if (!cleanupTimer1) {
      cleanupTimer1 = setTimeout(() => {
        cleanupTimer1 = null
        if (!isAdShowing()) { restoreVolume(); return }
        // Try skip buttons + seek again
        clickAllSkipButtons()
        forceEndAdVideo()
        // If still stuck, force-remove ad state now
        if (isAdShowing()) {
          forceRemoveAdState()
        }
      }, 100)
    }
    // Safety-net second attempt at 500ms in case the first wasn't enough
    if (!cleanupTimer2) {
      cleanupTimer2 = setTimeout(() => {
        cleanupTimer2 = null
        if (!isAdShowing()) { restoreVolume(); return }
        clickAllSkipButtons()
        forceEndAdVideo()
        forceRemoveAdState()
      }, 500)
    }
  }

  // Popup Dismissal 
  function dismissEnforcementPopup() {
    let dismissed = false
    const dialogs = document.querySelectorAll("tp-yt-paper-dialog")
    dialogs.forEach(dialog => {
      if (dialog.querySelector("ytd-enforcement-message-view-model") ||
        dialog.innerText.includes("Ad blockers violate") ||
        dialog.innerText.includes("Ad blockers are not allowed")) {
        dialog.remove()
        dismissed = true
      }
    })

    // Backdrops
    const backdrops = document.querySelectorAll("tp-yt-iron-overlay-backdrop")
    if (dismissed && backdrops.length > 0) {
      backdrops.forEach(b => b.remove())
      document.body.style.overflow = "auto"
      const v = selectVideo()
      if (v && v.paused) v.play().catch(() => { })
    }
  }

  //  Cleaner Node Removal fallback 
  function removeAdNodes() {
    for (const sel of REMOVE_SELECTORS) {
      document.querySelectorAll(sel).forEach(el => {
        if (el.style.display !== "none") {
          el.style.setProperty("display", "none", "important")
        }
      })
    }
  }

  // Scan Logic 
  function scan() {
    if (!state.enabled) return
    injectStyles()
    attachVideoListener()
    removeAdNodes()
    dismissEnforcementPopup()
    if (isWatchOrShorts()) {
      skipAdIfAny()
    } else {
      restoreVolume()
    }
  }

  // Direct Video Events for Sub-millisecond Detection 
  let videoElement = null;
  function handleVideoEvents() {
    if (!state.enabled) return;
    if (isAdShowing()) {
      skipAdIfAny();
    }
  }

  function attachVideoListener() {
    const v = selectVideo();
    if (v && v !== videoElement) {
      if (videoElement) {
        videoElement.removeEventListener("timeupdate", handleVideoEvents);
        videoElement.removeEventListener("play", handleVideoEvents);
        videoElement.removeEventListener("loadeddata", handleVideoEvents);
      }
      videoElement = v;
      videoElement.addEventListener("timeupdate", handleVideoEvents);
      videoElement.addEventListener("play", handleVideoEvents);
      videoElement.addEventListener("loadeddata", handleVideoEvents);
    }
  }

  // Observers & Loops 
  let scanTimeout = null;
  const observer = new MutationObserver(() => {
    const t = now()
    if (t - state.lastScan > 200) {
      state.lastScan = t
      scan()
    } else {
      if (!scanTimeout) {
        scanTimeout = setTimeout(() => {
          state.lastScan = now()
          scan()
          scanTimeout = null
        }, 200)
      }
    }
  })

  function startAdLoop() {
    if (state.adLoopActive) return
    state.adLoopActive = true
    const loop = () => {
      if (!state.enabled) return
      scan()
      const interval = isAdShowing() ? 50 : 250
      setTimeout(loop, interval)
    }
    loop()
  }

  // Entry Points 
  injectStyles()
  scan()

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  })

  startAdLoop()

  // YouTube SPA handling
  window.addEventListener("yt-navigate-finish", () => {
    state.lastScan = 0
    scan()
  })

  // Storage change handling
  chromeApi.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue
      if (!state.enabled) {
        const style = document.getElementById("yt-ad-blocker-styles")
        if (style) style.remove()
      } else {
        injectStyles()
        scan()
      }
    }
  })
})()
