import Foundation
import CryptoKit
import UserNotifications
#if canImport(UIKit)
import UIKit
#endif
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
    setupLifecycleObserversIfNeeded()
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) { return true }
    #endif
    return true
  }

  private static let appStateLock = NSLock()
  private static var cachedIsAppActive: Bool = false
  private static var didSetupAppStateObservers: Bool = false
  private static var pendingOrphanSweepOnActive: Bool = false
  private static var didCleanupUnrecordedMainTimerOnce: Bool = false

  private static let opQueueLock = NSLock()
  private static var tailTask: Task<Void, Never>? = nil
  private static var tailOpId: UInt64 = 0

  private static func takePreviousTailAndBumpOpId() -> (previous: Task<Void, Never>?, opId: UInt64) {
    opQueueLock.lock()
    defer { opQueueLock.unlock() }
    let previous = tailTask
    tailOpId &+= 1
    return (previous, tailOpId)
  }

  private static func setTailTask(_ task: Task<Void, Never>) {
    opQueueLock.lock()
    tailTask = task
    opQueueLock.unlock()
  }

  private static func clearTailTaskIfMatching(opId: UInt64) {
    opQueueLock.lock()
    if tailOpId == opId {
      tailTask = nil
    }
    opQueueLock.unlock()
  }

  private static func enqueueFireAndForgetOperation(
    priority: TaskPriority = .userInitiated,
    _ operation: @escaping @Sendable () async -> Void
  ) {
    opQueueLock.lock()
    let previous = tailTask
    tailOpId &+= 1
    let myOpId = tailOpId
    let task = Task.detached(priority: priority) {
      if let previous = previous {
        _ = await previous.value
      }
      await operation()
      clearTailTaskIfMatching(opId: myOpId)
    }
    tailTask = task
    opQueueLock.unlock()
  }

  private static func enqueueAsyncOperation<T: Sendable>(
    priority: TaskPriority = .userInitiated,
    _ operation: @escaping @Sendable () async -> T
  ) async -> T {
    let resultTask = registerAsyncOperationTask(priority: priority, operation)
    return await resultTask.value
  }

  private static func registerAsyncOperationTask<T: Sendable>(
    priority: TaskPriority,
    _ operation: @escaping @Sendable () async -> T
  ) -> Task<T, Never> {
    opQueueLock.lock()
    let previous = tailTask
    tailOpId &+= 1
    let myOpId = tailOpId
    let resultTask = Task.detached(priority: priority) { () -> T in
      if let previous = previous {
        _ = await previous.value
      }
      return await operation()
    }
    let trackerTask = Task.detached(priority: priority) {
      _ = await resultTask.value
      clearTailTaskIfMatching(opId: myOpId)
    }
    tailTask = trackerTask
    opQueueLock.unlock()
    return resultTask
  }

  private static func updateCachedIsAppActiveAndCheckSweep(_ isActiveNow: Bool) {
    appStateLock.lock()
    cachedIsAppActive = isActiveNow
    let shouldSweep = isActiveNow && pendingOrphanSweepOnActive
    if shouldSweep {
      pendingOrphanSweepOnActive = false
    }
    appStateLock.unlock()
    if shouldSweep {
      performDeferredOrphanSweepAsync()
    }
  }

  static func setupLifecycleObserversIfNeeded() {
    #if canImport(UIKit)
    appStateLock.lock()
    let alreadySetup = didSetupAppStateObservers
    if !alreadySetup {
      didSetupAppStateObservers = true
    }
    appStateLock.unlock()

    if alreadySetup {
      if Thread.isMainThread {
        let isActive = (UIApplication.shared.applicationState == .active)
        updateCachedIsAppActiveAndCheckSweep(isActive)
      }
      return
    }

    let registerObservers = {
      let isActiveNow = (UIApplication.shared.applicationState == .active)
      updateCachedIsAppActiveAndCheckSweep(isActiveNow)

      let center = NotificationCenter.default
      center.addObserver(
        forName: UIApplication.didBecomeActiveNotification,
        object: nil,
        queue: .main
      ) { _ in
        updateCachedIsAppActiveAndCheckSweep(true)
      }
      center.addObserver(
        forName: UIApplication.willResignActiveNotification,
        object: nil,
        queue: .main
      ) { _ in
        appStateLock.lock()
        cachedIsAppActive = false
        appStateLock.unlock()
      }
      center.addObserver(
        forName: UIApplication.didEnterBackgroundNotification,
        object: nil,
        queue: .main
      ) { _ in
        appStateLock.lock()
        cachedIsAppActive = false
        appStateLock.unlock()
      }
    }

    if Thread.isMainThread {
      registerObservers()
    } else {
      DispatchQueue.main.async(execute: registerObservers)
    }
    #endif
  }

  /// JS スレッド等の非メインスレッドから呼ばれても DispatchQueue.main.sync を一切使わず 0ms で安全にフォアグラウンド判定を返す
  private static func isAppForegroundActive() -> Bool {
    #if canImport(UIKit)
    setupLifecycleObserversIfNeeded()
    if Thread.isMainThread {
      let active = (UIApplication.shared.applicationState == .active)
      updateCachedIsAppActiveAndCheckSweep(active)
      return active
    }
    appStateLock.lock()
    let active = cachedIsAppActive
    appStateLock.unlock()
    return active
    #else
    return true
    #endif
  }

  /// 非同期コンテキスト（scheduleAlarm / scheduleNotificationFallback）から MainActor 経由で確実に最新のフォアグラウンド状態を取得する
  private static func isAppForegroundActiveAsync() async -> Bool {
    #if canImport(UIKit)
    setupLifecycleObserversIfNeeded()
    let active = await MainActor.run {
      UIApplication.shared.applicationState == .active
    }
    updateCachedIsAppActiveAndCheckSweep(active)
    return active
    #else
    return true
    #endif
  }

  private static func performDeferredOrphanSweepAsync() {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      enqueueFireAndForgetOperation(priority: .utility) {
        let manager = AlarmManager.shared
        guard let activeAlarms = try? manager.alarms else { return }
        let protectedUUIDs = currentProtectedUUIDsSnapshot()
        for alarm in activeAlarms where !protectedUUIDs.contains(alarm.id) {
          _ = try? manager.stop(id: alarm.id)
          _ = try? manager.cancel(id: alarm.id)
        }
      }
    }
    #endif
  }

  private static let authStatusLock = NSLock()
  private static var cachedFallbackAuthStatus: String = "notDetermined"

  private static func setCachedFallbackAuthStatus(_ mapped: String) {
    authStatusLock.lock()
    cachedFallbackAuthStatus = mapped
    authStatusLock.unlock()
  }

  private static func getCachedFallbackAuthStatus() -> String {
    authStatusLock.lock()
    let current = cachedFallbackAuthStatus
    authStatusLock.unlock()
    return current
  }

  private static func updateCachedFallbackAuthStatus(_ status: UNAuthorizationStatus) -> String {
    let mapped: String
    switch status {
    case .authorized, .provisional, .ephemeral: mapped = "authorized"
    case .denied: mapped = "denied"
    case .notDetermined: mapped = "notDetermined"
    @unknown default: mapped = "unknown"
    }
    setCachedFallbackAuthStatus(mapped)
    return mapped
  }

  static func authorizationStatus() -> String {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      return statusText(AlarmManager.shared.authorizationState)
    }
    #endif
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      _ = updateCachedFallbackAuthStatus(settings.authorizationStatus)
    }
    return getCachedFallbackAuthStatus()
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
      let mapped = granted ? "authorized" : "denied"
      setCachedFallbackAuthStatus(mapped)
      return mapped
    } catch {
      return "error: \(error.localizedDescription)"
    }
  }

  // 戻り値: "ok" / "past" / "denied" / "unavailable" / "cancelled" / "error: …"
  static func schedule(key: String, timestampMs: Double, title: String, soundOn: Bool) async -> String {
    let schedGen = bumpKeyGeneration(for: key, markInFlight: true)
    defer { clearInFlightSchedule(for: key, generation: schedGen) }
    return await enqueueAsyncOperation(priority: .userInitiated) {
      guard isScheduleStillValid(for: key, scheduleGeneration: schedGen) else {
        return "cancelled"
      }
      #if canImport(AlarmKit)
      if #available(iOS 26.0, *) {
        return await scheduleAlarm(
          key: key,
          timestampMs: timestampMs,
          title: title,
          soundOn: soundOn,
          scheduleGeneration: schedGen
        )
      }
      #endif
      return await scheduleNotificationFallback(
        key: key,
        timestampMs: timestampMs,
        title: title,
        soundOn: soundOn,
        scheduleGeneration: schedGen
      )
    }
  }

  // 予約の取り消し＋鳴っている最中なら停止
  static func cancel(key: String) -> Bool {
    let (cancelGen, wasInFlight) = bumpKeyGenerationForCancel(for: key)
    // こちらから取り消した予約は「ユーザーが止めた」と判定しないよう、記録から先に消す
    let hadRecord = removeRecord(key: key)
    if !hadRecord && !wasInFlight {
      if key != "main-timer" {
        return false
      }
      // バックグラウンド中は記録のない main-timer に対して AlarmManager XPC を呼ばない
      guard isAppForegroundActive() else {
        return false
      }
      appStateLock.lock()
      let alreadyCleaned = didCleanupUnrecordedMainTimerOnce
      didCleanupUnrecordedMainTimerOnce = true
      appStateLock.unlock()
      if alreadyCleaned {
        return false
      }
    }
    let notifId = "assisttimer.fallback.\(key)"
    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [notifId])
    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [notifId])
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      let id = uuid(for: key)
      // 同期 JSI 呼び出し元の JS スレッドを XPC 待ちでブロックしないよう FIFO 直列キューで停止・取消を実行
      enqueueFireAndForgetOperation(priority: .userInitiated) {
        guard isCancelStillValid(for: key, cancelGeneration: cancelGen) else { return }
        let manager = AlarmManager.shared
        _ = try? manager.stop(id: id)
        _ = try? manager.cancel(id: id)
      }
      return true
    }
    #endif
    return true
  }

  private static func scheduleNotificationFallback(
    key: String,
    timestampMs: Double,
    title: String,
    soundOn: Bool,
    scheduleGeneration: UInt64
  ) async -> String {
    guard isScheduleStillValid(for: key, scheduleGeneration: scheduleGeneration) else {
      return "cancelled"
    }
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    _ = updateCachedFallbackAuthStatus(settings.authorizationStatus)
    guard isScheduleStillValid(for: key, scheduleGeneration: scheduleGeneration) else {
      return "cancelled"
    }
    if settings.authorizationStatus == .notDetermined {
      guard await isAppForegroundActiveAsync() else {
        return "denied"
      }
      _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
      guard isScheduleStillValid(for: key, scheduleGeneration: scheduleGeneration) else {
        return "cancelled"
      }
    }
    let updatedSettings = await center.notificationSettings()
    _ = updateCachedFallbackAuthStatus(updatedSettings.authorizationStatus)
    guard isScheduleStillValid(for: key, scheduleGeneration: scheduleGeneration) else {
      return "cancelled"
    }
    guard updatedSettings.authorizationStatus == .authorized ||
          updatedSettings.authorizationStatus == .provisional ||
          updatedSettings.authorizationStatus == .ephemeral else {
      return "denied"
    }

    let notifId = "assisttimer.fallback.\(key)"
    removeRecord(key: key)
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
      guard isScheduleStillValid(for: key, scheduleGeneration: scheduleGeneration) else {
        center.removePendingNotificationRequests(withIdentifiers: [notifId])
        center.removeDeliveredNotifications(withIdentifiers: [notifId])
        removeRecord(key: key)
        return "cancelled"
      }
      addRecord(key: key, timestampMs: timestampMs)
      return "ok"
    } catch {
      return "error: \(error.localizedDescription)"
    }
  }

  // MARK: - ユーザーがアラーム画面で「停止」した予約の検出と世代・InFlight排他管理
  // AlarmKit には「停止が押された」通知が無いため、予約したキーと鳴る時刻を端末内に記録しておき、
  // 「鳴る時刻を過ぎたのに、こちらが取り消していないのに AlarmKit の一覧から消えた」ものを止められたと判断する。
  static let scheduledRecordKey = "assisttimer.alarmkit.scheduled"
  private static let recordLock = NSLock()
  private static var keyGenerations: [String: UInt64] = [:]
  private static var inFlightScheduleKeys: Set<String> = []
  private static var latestKnownKeepKeysBySource: [String: Set<String>] = [:]

  private static func bumpKeyGeneration(for key: String, markInFlight: Bool) -> UInt64 {
    recordLock.lock(); defer { recordLock.unlock() }
    let next = (keyGenerations[key] ?? 0) &+ 1
    keyGenerations[key] = next
    if markInFlight {
      inFlightScheduleKeys.insert(key)
    } else {
      inFlightScheduleKeys.remove(key)
    }
    return next
  }

  private static func bumpKeyGenerationForCancel(for key: String) -> (generation: UInt64, wasInFlight: Bool) {
    recordLock.lock(); defer { recordLock.unlock() }
    let wasInFlight = inFlightScheduleKeys.remove(key) != nil
    let next = (keyGenerations[key] ?? 0) &+ 1
    keyGenerations[key] = next
    return (next, wasInFlight)
  }

  private static func clearInFlightSchedule(for key: String, generation: UInt64) {
    recordLock.lock(); defer { recordLock.unlock() }
    if keyGenerations[key] == generation {
      inFlightScheduleKeys.remove(key)
    }
  }

  private static func isCancelStillValid(for key: String, cancelGeneration: UInt64) -> Bool {
    recordLock.lock(); defer { recordLock.unlock() }
    guard keyGenerations[key] == cancelGeneration else { return false }
    guard !inFlightScheduleKeys.contains(key) else { return false }
    let records = loadRecords()
    return records[key] == nil
  }

  private static func isScheduleStillValid(for key: String, scheduleGeneration: UInt64) -> Bool {
    recordLock.lock(); defer { recordLock.unlock() }
    return keyGenerations[key] == scheduleGeneration
  }

  private static let abandonedRecordCutoffMs: Double = 3 * 3600 * 1000.0

  private static func currentProtectedUUIDsSnapshot(additionalKeys: Set<String> = []) -> Set<UUID> {
    recordLock.lock()
    let keepSets = Array(latestKnownKeepKeysBySource.values)
    let mainInitialized = (latestKnownKeepKeysBySource["main"] != nil)
    let inFlight = inFlightScheduleKeys
    let records = loadRecords()
    recordLock.unlock()

    let nowMs = Date().timeIntervalSince1970 * 1000.0
    let recentCutoffMs = nowMs - abandonedRecordCutoffMs
    var protectedUUIDs = Set<UUID>()
    for set in keepSets {
      for key in set {
        protectedUUIDs.insert(uuid(for: key))
      }
    }
    if !mainInitialized {
      protectedUUIDs.insert(uuid(for: "main-timer"))
    }
    for key in additionalKeys {
      protectedUUIDs.insert(uuid(for: key))
    }
    for key in inFlight {
      protectedUUIDs.insert(uuid(for: key))
    }
    for (key, ts) in records where ts > recentCutoffMs {
      protectedUUIDs.insert(uuid(for: key))
    }
    return protectedUUIDs
  }

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
    let sourceKey = (key == "main-timer") ? "main" : "salon"
    if var set = latestKnownKeepKeysBySource[sourceKey] {
      set.insert(key)
      latestKnownKeepKeysBySource[sourceKey] = set
    }
  }

  @discardableResult
  static func removeRecord(key: String) -> Bool {
    recordLock.lock(); defer { recordLock.unlock() }
    for sourceKey in Array(latestKnownKeepKeysBySource.keys) {
      latestKnownKeepKeysBySource[sourceKey]?.remove(key)
    }
    var records = loadRecords()
    guard records[key] != nil else { return false }
    records[key] = nil
    saveRecords(records)
    return true
  }

  /// アプリ起動時の初回同期や全停止時に、過去の残留アラームや一覧に存在しない古い予約を確実に停止・消去する
  /// ※ keepKeys に含まれる現在進行中（カウントダウン中および直近3時間以内の超過カウントアップ中）のアラームは
  ///   ロック画面で鳴動中の消音や takeUserStoppedAlarms の記録消失を防ぐためキャンセルしない
  static func cleanupOnSourceInit(source: String, keepKeys: [String]) -> Int {
    let keepSet = Set(keepKeys)
    let nowMs = Date().timeIntervalSince1970 * 1000.0
    let recentCutoffMs = nowMs - abandonedRecordCutoffMs
    recordLock.lock()
    latestKnownKeepKeysBySource[source] = keepSet
    let records = loadRecords()
    recordLock.unlock()

    var keysToCancel = Set<String>()
    if source == "main" && !keepSet.contains("main-timer") {
      keysToCancel.insert("main-timer")
    }
    for (key, ts) in records {
      if source == "main" {
        if key == "main-timer" && (!keepSet.contains(key) || ts <= recentCutoffMs) {
          keysToCancel.insert(key)
        }
      } else if source == "salon" {
        if key != "main-timer" && (!keepSet.contains(key) || ts <= recentCutoffMs) {
          keysToCancel.insert(key)
        }
      } else if !keepSet.contains(key) || ts <= recentCutoffMs {
        keysToCancel.insert(key)
      }
    }
    for key in keysToCancel {
      _ = cancel(key: key)
    }

    // iOS 26+ AlarmManager.shared.alarms に残存している孤立・鳴動中アラームも直接走査して確実に停止・消去する
    // ※ バックグラウンド／非アクティブ時は records の有無にかかわらず重い XPC 全件走査を絶対に実行せず、次回アクティブ復帰時に非同期実行する
    guard isAppForegroundActive() else {
      appStateLock.lock()
      pendingOrphanSweepOnActive = true
      appStateLock.unlock()
      return keysToCancel.count
    }
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      let extraKeys = keepSet
      enqueueFireAndForgetOperation(priority: .utility) {
        let manager = AlarmManager.shared
        guard let activeAlarms = try? manager.alarms else { return }
        let protectedUUIDs = currentProtectedUUIDsSnapshot(additionalKeys: extraKeys)
        for alarm in activeAlarms where !protectedUUIDs.contains(alarm.id) {
          _ = try? manager.stop(id: alarm.id)
          _ = try? manager.cancel(id: alarm.id)
        }
      }
    }
    #endif

    return keysToCancel.count
  }

  /// 止められた予約を [{ "key": String, "timestamp": Double(ms) }] で返し、記録から消す
  static func takeUserStoppedAlarms() -> [[String: Any]] {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      let nowMs = Date().timeIntervalSince1970 * 1000.0
      recordLock.lock()
      let initialRecords = loadRecords()
      recordLock.unlock()
      guard !initialRecords.isEmpty else { return [] }
      // 鳴る時刻を過ぎた予約だけが対象（まだ鳴っていない予約は調べない）
      let initialDue = initialRecords.filter { $0.value <= nowMs - 1000 }
      guard !initialDue.isEmpty else { return [] }
      guard isAppForegroundActive() else { return [] }

      recordLock.lock(); defer { recordLock.unlock() }
      var records = loadRecords()
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
  private static func scheduleAlarm(
    key: String,
    timestampMs: Double,
    title: String,
    soundOn: Bool,
    scheduleGeneration: UInt64
  ) async -> String {
    guard isScheduleStillValid(for: key, scheduleGeneration: scheduleGeneration) else {
      return "cancelled"
    }
    let manager = AlarmManager.shared
    if manager.authorizationState == .notDetermined {
      if await isAppForegroundActiveAsync() {
        _ = try? await manager.requestAuthorization()
        guard isScheduleStillValid(for: key, scheduleGeneration: scheduleGeneration) else {
          return "cancelled"
        }
      } else {
        return await scheduleNotificationFallback(
          key: key,
          timestampMs: timestampMs,
          title: title,
          soundOn: soundOn,
          scheduleGeneration: scheduleGeneration
        )
      }
    }
    guard manager.authorizationState == .authorized else { return "denied" }
    guard isScheduleStillValid(for: key, scheduleGeneration: scheduleGeneration) else {
      return "cancelled"
    }

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
      guard isScheduleStillValid(for: key, scheduleGeneration: scheduleGeneration) else {
        _ = try? manager.stop(id: id)
        _ = try? manager.cancel(id: id)
        removeRecord(key: key)
        return "cancelled"
      }
      addRecord(key: key, timestampMs: timestampMs)
      return "ok"
    } catch {
      return "error: \(error.localizedDescription)"
    }
  }
  #endif
}
