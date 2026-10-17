import Foundation
import CryptoKit
#if canImport(AlarmKit)
import AlarmKit
import ActivityKit
import SwiftUI
#endif

#if canImport(AlarmKit)
@available(iOS 26.0, *)
struct AssistTimerAlarmMetadata: AlarmMetadata {}
#endif

// ★ AlarmKit（iOS 26+ の純正アラーム）呼び出しの本体
// Expo に依存しない形で分離し、ローカルの iOS SDK で型チェックできるようにしている。
// ※ EAS の既定ビルド環境（Xcode 26.0 / iOS 26.0 SDK）に存在する API のみを使うこと。
enum AlarmKitBridge {
  static let silentSoundName = "assisttimer_silence.caf"

  // JS 側の任意の文字列キー（例: "seat-1-main"）から、毎回同じ UUID を作る
  static func uuid(for key: String) -> UUID {
    let digest = SHA256.hash(data: Data(("assisttimer-alarm:" + key).utf8))
    var bytes = Array(digest.prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x50  // version 5 相当
    bytes[8] = (bytes[8] & 0x3F) | 0x80  // RFC 4122 variant
    return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                       bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
  }

  static func isAvailable() -> Bool {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) { return true }
    #endif
    return false
  }

  static func authorizationStatus() -> String {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      return statusText(AlarmManager.shared.authorizationState)
    }
    #endif
    return "unavailable"
  }

  static func requestAuthorization() async -> String {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      do {
        let state = try await AlarmManager.shared.requestAuthorization()
        return statusText(state)
      } catch {
        return "error: \(error.localizedDescription)"
      }
    }
    #endif
    return "unavailable"
  }

  // 戻り値: "ok" / "past" / "denied" / "unavailable" / "error: …"
  static func schedule(key: String, timestampMs: Double, title: String, soundOn: Bool) async -> String {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      return await scheduleAlarm(key: key, timestampMs: timestampMs, title: title, soundOn: soundOn)
    }
    #endif
    return "unavailable"
  }

  // 予約の取り消し＋鳴っている最中なら停止
  static func cancel(key: String) -> Bool {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      let id = uuid(for: key)
      let manager = AlarmManager.shared
      var done = false
      if (try? manager.stop(id: id)) != nil { done = true }
      if (try? manager.cancel(id: id)) != nil { done = true }
      return done
    }
    #endif
    return false
  }

  #if canImport(AlarmKit)
  @available(iOS 26.0, *)
  private static func statusText(_ state: AlarmManager.AuthorizationState) -> String {
    switch state {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
  }

  @available(iOS 26.0, *)
  private static func scheduleAlarm(key: String, timestampMs: Double, title: String, soundOn: Bool) async -> String {
    let manager = AlarmManager.shared
    if manager.authorizationState == .notDetermined {
      _ = try? await manager.requestAuthorization()
    }
    guard manager.authorizationState == .authorized else { return "denied" }

    let id = uuid(for: key)
    // 同じキーの古い予約は先に取り消す（時間変更時の二重予約防止）
    try? manager.cancel(id: id)

    let fireDate = Date(timeIntervalSince1970: timestampMs / 1000.0)
    guard fireDate.timeIntervalSinceNow > 0.5 else { return "past" }

    let stopButton = AlarmButton(text: "停止", textColor: .white, systemImageName: "stop.circle.fill")
    let alert = AlarmPresentation.Alert(title: LocalizedStringResource(stringLiteral: title), stopButton: stopButton)
    let attributes = AlarmAttributes<AssistTimerAlarmMetadata>(
      presentation: AlarmPresentation(alert: alert),
      metadata: AssistTimerAlarmMetadata(),
      tintColor: Color(red: 0.04, green: 0.52, blue: 1.0)
    )
    let sound: AlertConfiguration.AlertSound = soundOn ? .default : .named(silentSoundName)
    let configuration = AlarmManager.AlarmConfiguration<AssistTimerAlarmMetadata>.alarm(
      schedule: .fixed(fireDate),
      attributes: attributes,
      sound: sound
    )
    do {
      _ = try await manager.schedule(id: id, configuration: configuration)
      return "ok"
    } catch {
      return "error: \(error.localizedDescription)"
    }
  }
  #endif
}
