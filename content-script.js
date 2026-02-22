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

  // ─── Selectors ──────────────────────────────────────────────
  const REMOVE_SELECTORS = [
    // Header/Sidebar Ad Slots
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
    // Engagement panel ads & Banners reported by user
    "ytd-ads-engagement-panel-content-renderer",
    '#panels ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
    "ad-grid-card-collection-view-model",
    "ad-grid-card-text-view-model",
    "ad-button-view-model",
    "panel-text-icon-text-grid-cards-sub-layout-content-view-model",
    // Player Overlays
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

  // ─── Static Hiding (CSS) ────────────────────────────────────
  // Injecting CSS is more "seamless" and doesn't break grid layouts as much as JS removal
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
      
      /* Visually completely hide the video stream & player overlay while an ad is showing */
      .ad-showing video {
        opacity: 0 !important;
      }
      .ad-showing .ytp-ad-player-overlay {
        display: none !important;
      }
    `
    document.documentElement.appendChild(style)
  }

  // ─── Helpers ────────────────────────────────────────────────
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
    if (el && el.offsetHeight > 0) { // Only click if visible
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

  // ─── Ad Skipping ───────────────────────────────────────────
  function skipAdIfAny() {
    if (!isAdShowing()) {
      restoreVolume()
      return false
    }

    muteForAd()

    // Fast-forward skip: Jump to the end instantly
    const v = selectVideo()
    if (v && Number.isFinite(v.duration) && v.duration > 0.1) {
      try {
        if (v.currentTime < v.duration - 0.5) {
          v.currentTime = v.duration - 0.1
        }
        v.playbackRate = 16
        if (v.paused) v.play().catch(() => { })
      } catch { }
    }

    // Try clicking skip buttons instantly
    for (const sel of SKIP_BUTTON_SELECTORS) {
      if (clickIfExists(sel)) {
        break
      }
    }

    // Secondary effort to hide ad overlay parts quickly
    const adOverlay = document.querySelector(".ytp-ad-player-overlay, .ytp-ad-player-overlay-instream-info")
    if (adOverlay) {
      adOverlay.style.setProperty("display", "none", "important")
    }

    return true
  }

  // ─── Popup Dismissal ───────────────────────────────────────
  function dismissEnforcementPopup() {
    let dismissed = false

    // Find violation popups
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
      // Resume playback ONLY if we just dismissed a popup
      const v = selectVideo()
      if (v && v.paused) v.play().catch(() => { })
    }
  }

  // ─── Cleaner Node Removal fallback ─────────────────────────
  // Some ads are injected dynamically and might ignore the style tag
  function removeAdNodes() {
    for (const sel of REMOVE_SELECTORS) {
      document.querySelectorAll(sel).forEach(el => {
        // Only hide, don't remove structural elements to prevent grid breakage
        if (el.style.display !== "none") {
          el.style.setProperty("display", "none", "important")
        }
      })
    }
  }

  // ─── Scan Logic ───────────────────────────────────────────
  function scan() {
    if (!state.enabled) return
    injectStyles()
    attachVideoListener()
    removeAdNodes()
    dismissEnforcementPopup()
    if (isWatchOrShorts()) {
      skipAdIfAny()
    } else {
      // If we are not on a video page, restore volume just in case
      restoreVolume()
    }
  }

  // ─── Direct Video Events for Sub-millisecond Detection ──────
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

  // ─── Observers & Loops ─────────────────────────────────────
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
      // Faster loop to catch start ads more instantly
      const interval = isAdShowing() ? 50 : 250
      setTimeout(loop, interval)
    }
    loop()
  }

  // ─── Entry Points ─────────────────────────────────────────
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
