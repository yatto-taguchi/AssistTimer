/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = config => ({
  type: "watch-widget",
  name: "AssistTimerComplication",
  displayName: "AssistTimer",
  colors: { $accent: "#0A84FF" },
  deploymentTarget: "10.0",
  bundleIdentifier: ".watchkitapp.widget",
  entitlements: {
    // Watch アプリと同じ App Group で席タイマーの要約を共有する
    "com.apple.security.application-groups": ["group.com.assisttimer"],
  },
});
