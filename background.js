const RULESET_ID = "ruleset_1"

async function setRulesetEnabled(enabled) {
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enabled ? [RULESET_ID] : [],
      disableRulesetIds: enabled ? [] : [RULESET_ID],
    })
  } catch (e) {
    console.warn("Failed to update ruleset state:", e)
  }
}

async function getEnabled() {
  const { enabled } = await chrome.storage.sync.get({ enabled: true })
  return enabled
}

chrome.runtime.onInstalled.addListener(async () => {
  const enabled = await getEnabled()
  await setRulesetEnabled(enabled)
})

chrome.runtime.onStartup.addListener(async () => {
  const enabled = await getEnabled()
  await setRulesetEnabled(enabled)
})

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "sync" && Object.prototype.hasOwnProperty.call(changes, "enabled")) {
    const enabled = changes.enabled.newValue
    await setRulesetEnabled(enabled)
  }
})
