require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoAlarmKit'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'MIT'
  s.author         = 'AssistTimer'
  s.homepage       = 'https://github.com/litthairdesign'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # ★ podspec は Expo autolinking の仕様どおり ios/ 配下に置く（モジュール直下だと登録されない）
  s.source_files = "**/*.{h,m,mm,swift}"
  # ★ 音OFF時に使う無音サウンド（アプリ本体のバンドル直下にコピーされる）
  s.resources = ["sounds/*.caf"]
  # ★ iOS 26 未満の端末でも起動できるよう弱リンク
  s.weak_frameworks = ['AlarmKit', 'ActivityKit', 'AppIntents']
end
