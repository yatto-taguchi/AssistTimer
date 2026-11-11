/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = config => ({
  type: "watch",
  name: "AssistTimerWatch",
  displayName: "AssistTimer",
  icon: "../../assets/icon.png",
  colors: { $accent: "#0A84FF" },
  deploymentTarget: "10.0",
  bundleIdentifier: ".watchkitapp",
  entitlements: {
    // 文字盤コンプリケーション（targets/watch-widget）と席タイマーの要約を共有する
    "com.apple.security.application-groups": ["group.com.assisttimer"],
  },
});