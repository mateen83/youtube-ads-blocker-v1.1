; (async () => {
  const state = {
    enabled: true,
    lastScan: 0,
    scanIntervalMs: 500,
    adLoopActive: false,
    savedVolume: -1, // Track original volume before muting ads
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
    // Standard ad renderers
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
    // Engagement panel ads (sidebar ad cards)
    "ytd-ads-engagement-panel-content-renderer",
    '#panels ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
    // New ad view-model components (the banners user reported)
    "ad-grid-card-collection-view-model",
    "ad-grid-card-text-view-model",
    "ad-button-view-model",
    "panel-text-icon-text-grid-cards-sub-layout-content-view-model",
    // Player ad containers
    "#player-ads",
    ".ytp-ad-module",
    ".ytp-ad-image-overlay",
    ".ytp-ad-player-overlay",
    ".ytp-ad-overlay-container",
    ".ytp-ad-overlay-slot",
  ]

  const SKIP_BUTTON_SELECTORS = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button.ytp-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-slot button",
    ".ytp-ad-skip-button-slot .ytp-ad-skip-button-container",
    ".ytp-ad-skip-button-container button",
    "button.ytp-ad-skip-button-modern",
    ".ytp-ad-overlay-close-button",
    ".ytp-ad-survey-answer-button",
    'button[id^="skip-button"]',
    ".videoAdUiSkipButton",
  ]

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
    if (el) {
      try {
        el.click()
      } catch { }
      return true
    }
    return false
  }

  // ─── Playback rate guard ────────────────────────────────────
  function normalizePlaybackRate() {
    const v = selectVideo()
    if (!v) return
    if (v.playbackRate > 2 || v.playbackRate < 0.5) {
      try {
        v.playbackRate = 1
      } catch { }
    }
  }

  // ─── Volume management (mute ads, restore after) ───────────
  function muteForAd() {
    const v = selectVideo()
    if (!v) return
    // Save volume only once per ad
    if (state.savedVolume < 0) {
      state.savedVolume = v.volume
    }
    try {
      v.volume = 0
    } catch { }
  }

  function restoreVolume() {
    const v = selectVideo()
    if (!v) return
    if (state.savedVolume >= 0) {
      try {
        v.volume = state.savedVolume
      } catch { }
      state.savedVolume = -1
    }
  }

  // ─── Skip / fast-forward ad ─────────────────────────────────
  function skipAdIfAny() {
    if (!isAdShowing()) {
      // Ad ended — restore volume and normalize rate
      restoreVolume()
      normalizePlaybackRate()
      return false
    }

    // Try every known skip button
    let clicked = false
    for (const sel of SKIP_BUTTON_SELECTORS) {
      if (clickIfExists(sel)) {
        clicked = true
        break
      }
    }

    // If still in ad, fast-forward it
    if (isAdShowing()) {
      const v = selectVideo()
      if (v && Number.isFinite(v.duration) && v.duration > 0.5) {
        try {
          muteForAd()
          if (v.paused) v.play().catch(() => { })
          v.currentTime = v.duration - 0.1
        } catch { }
      }
    }

    // Try skip buttons again after seeking (some appear after seek)
    if (isAdShowing()) {
      for (const sel of SKIP_BUTTON_SELECTORS) {
        if (clickIfExists(sel)) break
      }
    }

    return true
  }

  // ─── Reflow (fix layout after removing nodes) ──────────────
  let pendingReflow = false
  function requestReflow() {
    if (pendingReflow) return
    pendingReflow = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          window.dispatchEvent(new Event("resize"))
        } catch { }
        pendingReflow = false
      })
    })
  }

  // ─── Remove ad DOM nodes ───────────────────────────────────
  function removeAdNodes(root = document) {
    let removed = false
    for (const sel of REMOVE_SELECTORS) {
      root.querySelectorAll(sel).forEach((n) => {
        const tag = (n.tagName || "").toUpperCase()
        // Never remove core content tiles
        if (
          tag === "YTD-RICH-ITEM-RENDERER" ||
          tag === "YTD-VIDEO-RENDERER" ||
          tag === "YTD-GRID-VIDEO-RENDERER"
        ) {
          return
        }
        try {
          n.remove()
        } catch {
          try {
            n.style.setProperty("display", "none", "important")
            n.style.setProperty("visibility", "hidden", "important")
          } catch { }
        }
        removed = true
      })
    }
    if (removed) requestReflow()
  }

  // ─── Dismiss "ad blocker detected" enforcement popup ───────
  // IMPORTANT: Only resume playback if we actually found and removed a popup.
  // Otherwise user's manual pause is respected.
  function dismissEnforcementPopup() {
    let dismissed = false

    // Find enforcement dialogs
    const dialogs = document.querySelectorAll("tp-yt-paper-dialog")
    for (const dialog of dialogs) {
      if (dialog.querySelector("ytd-enforcement-message-view-model")) {
        try {
          dialog.remove()
        } catch {
          try {
            dialog.style.setProperty("display", "none", "important")
          } catch { }
        }
        dismissed = true
      }
    }

    // Standalone enforcement renderers
    document.querySelectorAll("ytd-enforcement-message-view-model").forEach((el) => {
      try {
        el.closest("tp-yt-paper-dialog")?.remove()
      } catch { }
      try {
        el.remove()
      } catch { }
      dismissed = true
    })

    // Remove the backdrop overlay
    document.querySelectorAll("tp-yt-iron-overlay-backdrop").forEach((el) => {
      try {
        el.remove()
      } catch {
        try {
          el.style.setProperty("display", "none", "important")
        } catch { }
      }
      dismissed = true
    })

    // Only restore page state if we actually dismissed something
    if (dismissed) {
      if (document.body) {
        document.body.style.removeProperty("overflow")
        document.body.style.removeProperty("position")
        document.body.classList.remove("no-scroll")
      }
      const html = document.documentElement
      if (html) {
        html.style.removeProperty("overflow")
        html.style.removeProperty("position")
      }
      // Resume video only because the popup paused it
      const v = selectVideo()
      if (v && v.paused) {
        try {
          v.play().catch(() => { })
        } catch { }
      }
    }
  }

  // ─── Debounced scan ────────────────────────────────────────
  function debouncedScan() {
    const t = now()
    if (t - state.lastScan < state.scanIntervalMs) return
    state.lastScan = t
    removeAdNodes()
    dismissEnforcementPopup()
    if (isWatchOrShorts()) skipAdIfAny()
    hookVideo()
  }

  // ─── Hook video element for ad detection ───────────────────
  function hookVideo() {
    const v = selectVideo()
    if (!v || v.__ytAdHooked) return
    v.__ytAdHooked = true

    const maybeSkip = () => {
      if (!state.enabled) return
      if (!isWatchOrShorts()) return
      skipAdIfAny()
    }

    v.addEventListener("loadedmetadata", maybeSkip, { passive: true })
    v.addEventListener("timeupdate", maybeSkip, { passive: true })
    v.addEventListener("play", maybeSkip, { passive: true })
  }

  // ─── MutationObserver ──────────────────────────────────────
  const observer = new MutationObserver((muts) => {
    let shouldScan = false
    for (const m of muts) {
      if (m.type === "childList" && (m.addedNodes?.length || m.removedNodes?.length)) {
        shouldScan = true
        break
      }
      if (m.type === "attributes" && (m.attributeName === "class" || m.attributeName === "style")) {
        shouldScan = true
        break
      }
    }
    if (!shouldScan) return

    const scan = () => debouncedScan()
    if ("requestIdleCallback" in window) {
      requestIdleCallback(scan, { timeout: 150 })
    } else {
      setTimeout(scan, 0)
    }
  })

  function startObserver() {
    try {
      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style"],
      })
    } catch { }
  }

  // ─── Fast polling loop for ads ─────────────────────────────
  // Runs always on watch/shorts pages, checks every 250ms
  function startAdLoopIfNecessary() {
    if (state.adLoopActive) return
    state.adLoopActive = true
    const loop = () => {
      if (!state.enabled) return
      // Run ad skip on any page (ads can load before isWatchOrShorts triggers)
      if (isAdShowing()) {
        skipAdIfAny()
      }
      // Also remove DOM ad nodes
      removeAdNodes()
      dismissEnforcementPopup()
      setTimeout(loop, 250)
    }
    loop()
  }

  // ─── Navigation handler ────────────────────────────────────
  function handleNavigate() {
    removeAdNodes()
    dismissEnforcementPopup()
    normalizePlaybackRate()
    restoreVolume()
    hookVideo()
    startAdLoopIfNecessary()
  }

  // ─── Bootstrap ─────────────────────────────────────────────
  removeAdNodes()
  dismissEnforcementPopup()
  hookVideo()
  startObserver()
  startAdLoopIfNecessary()
  normalizePlaybackRate()

  // YouTube SPA events
  window.addEventListener("yt-navigate-finish", handleNavigate, true)
  window.addEventListener("yt-page-data-updated", handleNavigate, true)

  // Toggle enable/disable live
  chromeApi.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && Object.prototype.hasOwnProperty.call(changes, "enabled")) {
      state.enabled = changes.enabled.newValue
      if (state.enabled) {
        removeAdNodes()
        dismissEnforcementPopup()
        hookVideo()
        startAdLoopIfNecessary()
        normalizePlaybackRate()
      }
    }
  })
})()
