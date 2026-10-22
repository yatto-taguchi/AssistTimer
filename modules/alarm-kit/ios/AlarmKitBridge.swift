import Foundation
import CryptoKit
import UserNotifications
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
    return true
  }

  static func authorizationStatus() -> String {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      return statusText(AlarmManager.shared.authorizationState)
    }
    #endif
    let sema = DispatchSemaphore(value: 0)
    var result = "notDetermined"
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral: result = "authorized"
      case .denied: result = "denied"
      case .notDetermined: result = "notDetermined"
      @unknown default: result = "unknown"
      }
      sema.signal()
    }
    _ = sema.wait(timeout: .now() + 2.0)
    return result
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
    do {
      let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
      return granted ? "authorized" : "denied"
    } catch {
      return "error: \(error.localizedDescription)"
    }
  }

  // 戻り値: "ok" / "past" / "denied" / "unavailable" / "error: …"
  static func schedule(key: String, timestampMs: Double, title: String, soundOn: Bool) async -> String {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      return await scheduleAlarm(key: key, timestampMs: timestampMs, title: title, soundOn: soundOn)
    }
    #endif
    return await scheduleNotificationFallback(key: key, timestampMs: timestampMs, title: title, soundOn: soundOn)
  }

  // 予約の取り消し＋鳴っている最中なら停止
  static func cancel(key: String) -> Bool {
    // こちらから取り消した予約は「ユーザーが止めた」と判定しないよう、記録から先に消す
    removeRecord(key: key)
    let notifId = "assisttimer.fallback.\(key)"
    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [notifId])
    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [notifId])
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
    return true
  }

  private static func scheduleNotificationFallback(key: String, timestampMs: Double, title: String, soundOn: Bool) async -> String {
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    if settings.authorizationStatus == .notDetermined {
      _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }
    let updatedSettings = await center.notificationSettings()
    guard updatedSettings.authorizationStatus == .authorized ||
          updatedSettings.authorizationStatus == .provisional ||
          updatedSettings.authorizationStatus == .ephemeral else {
      return "denied"
    }

    let notifId = "assisttimer.fallback.\(key)"
    center.removePendingNotificationRequests(withIdentifiers: [notifId])
    center.removeDeliveredNotifications(withIdentifiers: [notifId])

    let fireDate = Date(timeIntervalSince1970: timestampMs / 1000.0)
    let interval = fireDate.timeIntervalSinceNow
    guard interval > 0.5 else { return "past" }

    let content = UNMutableNotificationContent()
    content.title = "Assist Timer"
    content.body = title
    if soundOn {
      content.sound = .default
    }
    if #available(iOS 15.0, *) {
      content.interruptionLevel = .timeSensitive
    }

    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
    let request = UNNotificationRequest(identifier: notifId, content: content, trigger: trigger)
    do {
      try await center.add(request)
      return "ok"
    } catch {
      return "error: \(error.localizedDescription)"
    }
  }

  // MARK: - ユーザーがアラーム画面で「停止」した予約の検出
  // AlarmKit には「停止が押された」通知が無いため、予約したキーと鳴る時刻を端末内に記録しておき、
  // 「鳴る時刻を過ぎたのに、こちらが取り消していないのに AlarmKit の一覧から消えた」ものを止められたと判断する。
  static let scheduledRecordKey = "assisttimer.alarmkit.scheduled"
  private static let recordLock = NSLock()

  private static func loadRecords() -> [String: Double] {
    return (UserDefaults.standard.dictionary(forKey: scheduledRecordKey) as? [String: Double]) ?? [:]
  }

  private static func saveRecords(_ records: [String: Double]) {
    UserDefaults.standard.set(records, forKey: scheduledRecordKey)
  }

  static func addRecord(key: String, timestampMs: Double) {
    recordLock.lock(); defer { recordLock.unlock() }
    var records = loadRecords()
    records[key] = timestampMs
    saveRecords(records)
  }

  static func removeRecord(key: String) {
    recordLock.lock(); defer { recordLock.unlock() }
    var records = loadRecords()
    guard records[key] != nil else { return }
    records[key] = nil
    saveRecords(records)
  }

  /// アプリ起動時の初回同期で、過去の残留アラームや一覧に存在しない古い予約を確実に停止・消去する
  static func cleanupOnSourceInit(source: String, keepKeys: [String]) -> Int {
    let keepSet = Set(keepKeys)
    let nowMs = Date().timeIntervalSince1970 * 1000.0
    recordLock.lock()
    let records = loadRecords()
    recordLock.unlock()

    var keysToCancel = Set<String>()
    if source == "main" && !keepSet.contains("main-timer") {
      keysToCancel.insert("main-timer")
    }
    for (key, ts) in records {
      if ts <= nowMs {
        keysToCancel.insert(key)
      } else if source == "main" && key == "main-timer" && !keepSet.contains(key) {
        keysToCancel.insert(key)
      } else if source == "salon" && key != "main-timer" && !keepSet.contains(key) {
        keysToCancel.insert(key)
      }
    }
    for key in keysToCancel {
      _ = cancel(key: key)
    }
    return keysToCancel.count
  }

  /// 止められた予約を [{ "key": String, "timestamp": Double(ms) }] で返し、記録から消す
  static func takeUserStoppedAlarms() -> [[String: Any]] {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      recordLock.lock(); defer { recordLock.unlock() }
      var records = loadRecords()
      guard !records.isEmpty else { return [] }
      let nowMs = Date().timeIntervalSince1970 * 1000.0
      // 鳴る時刻を過ぎた予約だけが対象（まだ鳴っていない予約は調べない）
      let due = records.filter { $0.value <= nowMs - 1000 }
      guard !due.isEmpty else { return [] }
      // 一覧を取得できない時は判定しない（誤って席を止めない）
      guard let alarms = try? AlarmManager.shared.alarms else { return [] }
      let activeIds = Set(alarms.map { $0.id })
      var stopped: [[String: Any]] = []
      for (key, ts) in due {
        if activeIds.contains(uuid(for: key)) {
          // まだ鳴っている（または一覧に残っている）。ただし 12 時間以上前の記録は整理する
          if ts < nowMs - 12 * 3600 * 1000 { records[key] = nil }
          continue
        }
        stopped.append(["key": key, "timestamp": ts])
        records[key] = nil
      }
      saveRecords(records)
      return stopped
    }
    #endif
    return []
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
    removeRecord(key: key)
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
      addRecord(key: key, timestampMs: timestampMs)
      return "ok"
    } catch {
      return "error: \(error.localizedDescription)"
    }
  }
  #endif
}
