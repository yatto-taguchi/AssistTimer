import ExpoModulesCore
import WatchConnectivity
import UserNotifications
import UIKit

public class ExpoWatchConnectivityModule: Module {
  private var sessionDelegate: SessionDelegate?
  private var notificationDelegate: PeerNotificationCenterDelegate?
  private let bgTaskLock = NSLock()
  private var realtimeBgTaskId: UIBackgroundTaskIdentifier = .invalid
  private var realtimeBgWorkItem: DispatchWorkItem?
  private var watchActionBgTaskId: UIBackgroundTaskIdentifier = .invalid
  private var watchActionBgWorkItem: DispatchWorkItem?
  private let transferLock = NSLock()
  private var bgObserverTokens: [NSObjectProtocol] = []
  private var pendingApplicationContext: [String: Any]?
  private var pendingUserInfo: [String: Any]?

  // ★ 診断用（通信状態の画面表示に使用）
  fileprivate var lastActivationError: String = ""
  fileprivate var nativeReceivedCount: Int = 0
  fileprivate var lastNativeReceivedAt: Double = 0
  fileprivate var lastNativeReceivedKind: String = ""
  fileprivate var lastNativeReceivedAction: String = ""

  // ★ Issue #13: ネイティブ層リングバッファ（ロック保護メモリ追記のみ・最大150件・通信副作用ゼロ）
  private let diagLock = NSLock()
  private var nativeDiagLogs: [[String: Any]] = []
  private var nativeDiagSeq: Int = 0
  private let maxNativeDiagLogs = 150
  private var cachedAppState: String = "unknown"

  // ★ JSの受信準備が整う前およびイベント取りこぼし防止用の受信キュー（連番管理）
  private let eventLock = NSLock()
  private var jsReady: Bool = false
  private var hasListeners: Bool = false
  private var nextEventSeq: Int = 0
  private var pendingEvents: [[String: Any]] = []
  private let maxPendingEvents = 100

  private var session: WCSession? {
    return WCSession.isSupported() ? WCSession.default : nil
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoWatchConnectivity")

    Events(
      "onMessageReceived",
      "onApplicationContextReceived",
      "onUserInfoReceived",
      "onStatusChanged"
    )

    OnStartObserving {
      self.eventLock.lock()
      self.hasListeners = true
      self.eventLock.unlock()
    }

    OnStopObserving {
      self.eventLock.lock()
      self.hasListeners = false
      self.eventLock.unlock()
    }

    OnCreate {
      if WCSession.isSupported() {
        let delegate = SessionDelegate(module: self)
        self.sessionDelegate = delegate
        let s = WCSession.default
        s.delegate = delegate
        s.activate()
      }
      DispatchQueue.main.async {
        let center = UNUserNotificationCenter.current()
        if !(center.delegate is PeerNotificationCenterDelegate) {
          let notifDelegate = PeerNotificationCenterDelegate(previousDelegate: center.delegate, module: self)
          self.notificationDelegate = notifDelegate
          center.delegate = notifDelegate
        }
        _ = self.currentAppStateText()
        self.setupBackgroundTaskObservers()
      }
    }

    OnDestroy {
      DispatchQueue.main.async {
        for token in self.bgObserverTokens {
          NotificationCenter.default.removeObserver(token)
        }
        self.bgObserverTokens.removeAll()
        self.endRealtimeBackgroundTask()
        self.endWatchActionBackgroundTask()
      }
    }

    AsyncFunction("requestNotificationPermission") { (promise: Promise) in
      let center = UNUserNotificationCenter.current()
      center.getNotificationSettings { settings in
        if settings.authorizationStatus == .authorized ||
           settings.authorizationStatus == .provisional ||
           settings.authorizationStatus == .ephemeral {
          promise.resolve(true)
          return
        }
        DispatchQueue.main.async {
          guard UIApplication.shared.applicationState == .active else {
            promise.resolve(false)
            return
          }
          center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            promise.resolve(granted)
          }
        }
      }
    }

    AsyncFunction("presentLocalNotification") { (title: String, body: String, promise: Promise) in
      let trimmedBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmedBody.isEmpty else {
        promise.resolve(false)
        return
      }
      let resolvedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        ? "サロン共有通知"
        : title.trimmingCharacters(in: .whitespacesAndNewlines)
      let center = UNUserNotificationCenter.current()

      let enqueueNotification = {
        let content = UNMutableNotificationContent()
        content.title = resolvedTitle
        content.body = trimmedBody
        content.sound = .default
        if #available(iOS 15.0, *) {
          content.interruptionLevel = .timeSensitive
        }
        content.threadIdentifier = "assisttimer.peer.shared"
        let identifier = "assisttimer.peer.\(UUID().uuidString)"
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        center.add(request) { [weak self] error in
          self?.appendNativeDiagLog(
            hop: "N_LOCAL_NOTIF",
            ch: "local_enqueue",
            act: "presentLocalNotification",
            res: error == nil ? "ok" : "err",
            rsn: error?.localizedDescription ?? "enqueued"
          )
          promise.resolve(error == nil)
        }
      }

      center.getNotificationSettings { settings in
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
          enqueueNotification()
        case .notDetermined:
          DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active else {
              promise.resolve(false)
              return
            }
            center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
              if granted {
                enqueueNotification()
              } else {
                promise.resolve(false)
              }
            }
          }
        default:
          promise.resolve(false)
        }
      }
    }

    AsyncFunction("activate") { (promise: Promise) in
      guard WCSession.isSupported() else {
        promise.resolve(["supported": false, "activated": false])
        return
      }
      
      let s = WCSession.default
      if self.sessionDelegate == nil {
        let delegate = SessionDelegate(module: self)
        self.sessionDelegate = delegate
        s.delegate = delegate
      }
      if s.activationState != .activated {
        s.activate()
      }
      promise.resolve([
        "supported": true,
        "isPaired": s.isPaired,
        "isWatchAppInstalled": s.isWatchAppInstalled,
        "isReachable": s.isReachable
      ])
    }

    Function("isSupported") { () -> Bool in
      return WCSession.isSupported()
    }

    Function("isPaired") { () -> Bool in
      return self.session?.isPaired ?? false
    }

    Function("isWatchAppInstalled") { () -> Bool in
      return self.session?.isWatchAppInstalled ?? false
    }

    Function("isReachable") { () -> Bool in
      return self.session?.isReachable ?? false
    }

    // ★ 診断用: 現在の通信状態をまとめて返す
    Function("getStatus") { () -> [String: Any] in
      return self.buildStatus()
    }

    // ★ Issue #13: ネイティブ層トレースログのオンデマンド回収・クリア
    Function("flushNativeDiagLogs") { () -> [[String: Any]] in
      return self.drainNativeDiagLogs()
    }

    Function("clearNativeDiagLogs") { () -> Bool in
      self.resetNativeDiagLogs()
      return true
    }

    // ★ ネイティブビルドバージョン（CFBundleShortVersionString + CFBundleVersion）を同期取得（TestFlightアップデート検知用）
    Function("getAppBuildVersion") { () -> String in
      let shortVer = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
      let buildVer = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
      return "\(shortVer) (\(buildVer))"
    }

    // ★ JSの受信準備完了を通知し、それまでに保留していた受信をまとめて受け取る
    // 戻り値: [{ "name": イベント名, "body": イベント本体 }]
    Function("takePendingEvents") { () -> [[String: Any]] in
      self.eventLock.lock()
      self.jsReady = true
      let queued = self.pendingEvents
      self.pendingEvents.removeAll()
      self.eventLock.unlock()
      return queued
    }

    AsyncFunction("updateApplicationContext") { (context: [String: Any], promise: Promise) in
      guard let session = self.session else {
        promise.reject("E_NOT_SUPPORTED", "WatchConnectivity is not supported on this device")
        return
      }

      let cleanContext = self.sanitizeDictionary(context)

      guard session.activationState == .activated else {
        // まだアクティベート中の場合は保留キューに保管し、アクティベート完了時に自動送信
        self.eventLock.lock()
        self.pendingApplicationContext = cleanContext
        self.eventLock.unlock()
        session.activate()
        promise.resolve(true)
        return
      }

      guard session.isPaired else {
        promise.resolve(false)
        return
      }

      do {
        try session.updateApplicationContext(cleanContext)
        self.eventLock.lock()
        self.pendingApplicationContext = nil
        self.eventLock.unlock()
        promise.resolve(true)
      } catch {
        print("[ExpoWatchConnectivity] updateApplicationContext warning: \(error.localizedDescription)")
        promise.resolve(false)
      }
    }

    AsyncFunction("sendMessage") { (message: [String: Any], promise: Promise) in
      guard let session = self.session else {
        promise.reject("E_NOT_SUPPORTED", "WatchConnectivity is not supported")
        return
      }

      guard session.activationState == .activated else {
        promise.reject("E_NOT_ACTIVATED", "Session is not activated")
        return
      }

      guard session.isPaired else {
        promise.reject("E_NOT_PAIRED", "Apple Watch is not paired")
        return
      }

      // ★ isReachable が true（Watchが目の前で起動中）であれば、isWatchAppInstalled判定遅延に関わらず直ちに送信
      guard session.isReachable else {
        if !session.isWatchAppInstalled {
          promise.reject("E_NOT_INSTALLED", "Watch app is not installed")
        } else {
          promise.reject("E_NOT_REACHABLE", "Apple Watch is not currently reachable")
        }
        return
      }

      let cleanMessage = self.sanitizeDictionary(message)

      session.sendMessage(cleanMessage, replyHandler: { reply in
        promise.resolve(reply)
      }, errorHandler: { error in
        promise.reject("E_SEND_FAILED", error.localizedDescription)
      })
    }

    AsyncFunction("transferUserInfo") { (userInfo: [String: Any], promise: Promise) in
      guard let session = self.session else {
        promise.reject("E_NOT_SUPPORTED", "WatchConnectivity is not supported on this device")
        return
      }

      let cleanUserInfo = self.sanitizeDictionary(userInfo)

      guard session.activationState == .activated else {
        self.eventLock.lock()
        self.pendingUserInfo = cleanUserInfo
        self.eventLock.unlock()
        session.activate()
        promise.resolve(true)
        return
      }

      guard session.isPaired, session.isWatchAppInstalled else {
        promise.resolve(false)
        return
      }

      let isHighPriorityWake =
        (cleanUserInfo["highPriorityWake"] as? Bool) == true ||
        (cleanUserInfo["highPriorityWake"] as? NSNumber)?.boolValue == true ||
        cleanUserInfo["notification"] != nil ||
        (cleanUserInfo["type"] as? String) == "SYNC_MAIN_TIMER"
      var wireUserInfo = cleanUserInfo
      wireUserInfo.removeValue(forKey: "highPriorityWake")

      self.transferLock.lock()
      // ★ WCSession.outstandingUserInfoTransfers のイテレーションと .cancel() は wcd IPC競合クラッシュを引き起こすため行わない
      // ★ 1日50回の transferCurrentComplicationUserInfo 優先起床枠は、
      //   Watchが非Reachable（手首下げ文字盤表示・バックグラウンド中）かつタイマー開始・停止・指名・募集・共有通知およびメインタイマー同期（isHighPriorityWake）専用に使用し、
      //   isReachable == true 時（sendMessage + updateApplicationContext で 0ms 到達済み）の不要消費による枯渇を防止する
      let isReachableSnap = session.isReachable
      let isCompEnabledSnap = session.isComplicationEnabled
      let remQuotaBefore = session.remainingComplicationUserInfoTransfers
      let canUseComplicationTransfer =
        isHighPriorityWake &&
        !isReachableSnap &&
        isCompEnabledSnap &&
        remQuotaBefore > 0

      let transfer: WCSessionUserInfoTransfer
      if canUseComplicationTransfer {
        transfer = session.transferCurrentComplicationUserInfo(wireUserInfo)
      } else {
        transfer = session.transferUserInfo(wireUserInfo)
      }
      let isTransferring = transfer.isTransferring
      let remQuotaAfter = session.remainingComplicationUserInfoTransfers
      self.transferLock.unlock()

      let txReason: String = {
        if !isHighPriorityWake { return "normal_priority" }
        if isReachableSnap { return "skip_complication_reachable" }
        if !isCompEnabledSnap { return "downgrade_complication_disabled" }
        if remQuotaBefore <= 0 { return "downgrade_quota_zero" }
        return "complication_priority_tx"
      }()
      let txTraceId = (wireUserInfo["traceId"] as? String)
        ?? ((wireUserInfo["notification"] as? [String: Any])?["traceId"] as? String)
        ?? ""
      self.appendNativeDiagLog(
        hop: "N_WC_TRANSFER_TX",
        ch: canUseComplicationTransfer ? "complication_userinfo" : "userinfo",
        act: (wireUserInfo["type"] as? String) ?? "transfer",
        res: isTransferring ? "ok" : "err",
        rsn: txReason,
        traceId: txTraceId,
        meta: [
          "isHighPriorityWake": isHighPriorityWake,
          "isReachable": isReachableSnap,
          "isComplicationEnabled": isCompEnabledSnap,
          "remainingQuota": remQuotaAfter
        ]
      )
      self.eventLock.lock()
      self.pendingUserInfo = nil
      self.eventLock.unlock()
      promise.resolve(isTransferring)
    }
  }

  fileprivate func sanitizePropertyListValue(_ value: Any) -> Any? {
    if value is NSNull {
      return nil
    }
    if let dict = value as? [String: Any] {
      var cleanDict: [String: Any] = [:]
      for (k, v) in dict {
        if let cleanVal = sanitizePropertyListValue(v) {
          cleanDict[k] = cleanVal
        }
      }
      return cleanDict
    }
    if let arr = value as? [Any] {
      var cleanArr: [Any] = []
      for elem in arr {
        if let cleanElem = sanitizePropertyListValue(elem) {
          cleanArr.append(cleanElem)
        }
      }
      return cleanArr
    }
    if value is String || value is NSNumber || value is Date || value is Data {
      return value
    }
    return String(describing: value)
  }

  fileprivate func sanitizeDictionary(_ dict: [String: Any]) -> [String: Any] {
    return (sanitizePropertyListValue(dict) as? [String: Any]) ?? [:]
  }

  fileprivate func flushPendingApplicationContext(session: WCSession) {
    guard session.isPaired else { return }
    self.eventLock.lock()
    let pending = self.pendingApplicationContext
    self.pendingApplicationContext = nil
    self.eventLock.unlock()
    guard let pending = pending else { return }
    do {
      try session.updateApplicationContext(pending)
    } catch {
      print("[ExpoWatchConnectivity] flushPendingApplicationContext failed: \(error.localizedDescription)")
    }
  }

  fileprivate func currentAppStateText() -> String {
    if Thread.isMainThread {
      let txt: String
      switch UIApplication.shared.applicationState {
      case .active: txt = "active"
      case .inactive: txt = "inactive"
      case .background: txt = "background"
      @unknown default: txt = "unknown"
      }
      diagLock.lock()
      cachedAppState = txt
      diagLock.unlock()
      return txt
    }
    diagLock.lock()
    let snap = cachedAppState
    diagLock.unlock()
    return snap
  }

  fileprivate func appendNativeDiagLog(
    hop: String,
    ch: String = "wc_native",
    act: String = "",
    res: String = "ok",
    rsn: String = "",
    traceId: String = "",
    seat: String = "",
    ms: Int? = nil,
    meta: [String: Any]? = nil
  ) {
    let rawWallMs = Date().timeIntervalSince1970 * 1000.0
    let wallMs: Int64 = (rawWallMs.isFinite && rawWallMs > 0)
      ? Int64(min(4_102_444_800_000.0, max(0.0, rawWallMs)).rounded())
      : 0
    let rawMonoMs = ProcessInfo.processInfo.systemUptime * 1000.0
    let monoMs: Int64 = (rawMonoMs.isFinite && rawMonoMs >= 0)
      ? Int64(min(4_102_444_800_000.0, max(0.0, rawMonoMs)).rounded())
      : 0
    let appState = currentAppStateText()
    diagLock.lock()
    nativeDiagSeq += 1
    var entry: [String: Any] = [
      "seq": nativeDiagSeq,
      "wallMs": Double(wallMs),
      "monoMs": Double(monoMs),
      "hop": hop,
      "ch": ch,
      "act": act,
      "res": res,
      "rsn": rsn,
      "traceId": traceId,
      "seat": seat,
      "appState": appState
    ]
    if let ms = ms {
      entry["ms"] = ms
    }
    if let meta = meta {
      entry["meta"] = sanitizeDictionary(meta)
    }
    nativeDiagLogs.append(entry)
    if nativeDiagLogs.count > maxNativeDiagLogs {
      nativeDiagLogs.removeFirst(nativeDiagLogs.count - maxNativeDiagLogs)
    }
    diagLock.unlock()
  }

  fileprivate func drainNativeDiagLogs() -> [[String: Any]] {
    diagLock.lock()
    let items = nativeDiagLogs
    nativeDiagLogs.removeAll()
    diagLock.unlock()
    return items
  }

  fileprivate func resetNativeDiagLogs() {
    diagLock.lock()
    nativeDiagLogs.removeAll()
    nativeDiagSeq = 0
    diagLock.unlock()
  }

  fileprivate func flushPendingUserInfo(session: WCSession) {
    guard session.isPaired, session.isWatchAppInstalled else { return }
    self.eventLock.lock()
    let pending = self.pendingUserInfo
    self.pendingUserInfo = nil
    self.eventLock.unlock()
    guard let pending = pending else { return }
    let isHighPriorityWake =
      (pending["highPriorityWake"] as? Bool) == true ||
      (pending["highPriorityWake"] as? NSNumber)?.boolValue == true ||
      pending["notification"] != nil ||
      (pending["type"] as? String) == "SYNC_MAIN_TIMER"
    var wirePending = pending
    wirePending.removeValue(forKey: "highPriorityWake")
    self.transferLock.lock()
    let isReachableSnap = session.isReachable
    let isCompEnabledSnap = session.isComplicationEnabled
    let remQuotaBefore = session.remainingComplicationUserInfoTransfers
    let canUseComplicationTransfer =
      isHighPriorityWake &&
      !isReachableSnap &&
      isCompEnabledSnap &&
      remQuotaBefore > 0
    if canUseComplicationTransfer {
      session.transferCurrentComplicationUserInfo(wirePending)
    } else {
      session.transferUserInfo(wirePending)
    }
    let remQuotaAfter = session.remainingComplicationUserInfoTransfers
    self.transferLock.unlock()
    let txReason: String = {
      if !isHighPriorityWake { return "flush_normal_priority" }
      if isReachableSnap { return "flush_skip_complication_reachable" }
      if !isCompEnabledSnap { return "flush_downgrade_complication_disabled" }
      if remQuotaBefore <= 0 { return "flush_downgrade_quota_zero" }
      return "flush_complication_priority_tx"
    }()
    let txTraceId = (wirePending["traceId"] as? String)
      ?? ((wirePending["notification"] as? [String: Any])?["traceId"] as? String)
      ?? ""
    self.appendNativeDiagLog(
      hop: "N_WC_TRANSFER_TX",
      ch: canUseComplicationTransfer ? "complication_userinfo" : "userinfo",
      act: (wirePending["type"] as? String) ?? "flush_transfer",
      res: "ok",
      rsn: txReason,
      traceId: txTraceId,
      meta: [
        "isHighPriorityWake": isHighPriorityWake,
        "isReachable": isReachableSnap,
        "isComplicationEnabled": isCompEnabledSnap,
        "remainingQuota": remQuotaAfter
      ]
    )
  }

  @discardableResult
  fileprivate func dispatchEvent(_ name: String, _ body: [String: Any]) -> (seq: Int, canEmit: Bool, jsReady: Bool, hasListeners: Bool) {
    let cleanBody = self.sanitizeDictionary(body)
    eventLock.lock()
    nextEventSeq += 1
    let seq = nextEventSeq
    var taggedBody = cleanBody
    taggedBody["_eventSeq"] = seq
    pendingEvents.append(["name": name, "body": taggedBody, "_eventSeq": seq])
    if pendingEvents.count > maxPendingEvents {
      pendingEvents.removeFirst(pendingEvents.count - maxPendingEvents)
    }
    let jsReadySnap = jsReady
    let hasListenersSnap = hasListeners
    let canEmit = (jsReadySnap && hasListenersSnap)
    eventLock.unlock()
    if canEmit {
      if Thread.isMainThread {
        sendEvent(name, taggedBody)
      } else {
        DispatchQueue.main.async { [weak self] in
          guard let self = self else { return }
          self.eventLock.lock()
          let stillCanEmit = (self.jsReady && self.hasListeners)
          self.eventLock.unlock()
          if stillCanEmit {
            self.sendEvent(name, taggedBody)
          }
        }
      }
    }
    return (seq, canEmit, jsReadySnap, hasListenersSnap)
  }

  fileprivate func activationStateText(_ state: WCSessionActivationState) -> String {
    switch state {
    case .activated: return "activated"
    case .inactive: return "inactive"
    case .notActivated: return "notActivated"
    @unknown default: return "unknown"
    }
  }

  fileprivate func buildStatus() -> [String: Any] {
    guard WCSession.isSupported() else {
      return ["supported": false]
    }
    let s = WCSession.default
    let delegateOk = (sessionDelegate != nil) && (s.delegate === sessionDelegate)
    self.eventLock.lock()
    let actErr = lastActivationError
    let rxCount = nativeReceivedCount
    let rxAt = lastNativeReceivedAt
    let rxKind = lastNativeReceivedKind
    let rxAction = lastNativeReceivedAction
    self.eventLock.unlock()
    return [
      "supported": true,
      "activationState": activationStateText(s.activationState),
      "isPaired": s.isPaired,
      "isWatchAppInstalled": s.isWatchAppInstalled,
      "isReachable": s.isReachable,
      "isComplicationEnabled": s.isComplicationEnabled,
      "remainingComplicationTransfers": s.remainingComplicationUserInfoTransfers,
      "delegateOk": delegateOk,
      "activationError": actErr,
      "nativeReceivedCount": rxCount,
      "lastNativeReceivedAt": rxAt,
      "lastNativeReceivedKind": rxKind,
      "lastNativeReceivedAction": rxAction
    ]
  }

  fileprivate func emitStatus() {
    self.eventLock.lock()
    let canEmit = (self.jsReady && self.hasListeners)
    self.eventLock.unlock()
    guard canEmit else { return }
    if Thread.isMainThread {
      self.sendEvent("onStatusChanged", self.buildStatus())
    } else {
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.eventLock.lock()
        let stillCanEmit = (self.jsReady && self.hasListeners)
        self.eventLock.unlock()
        guard stillCanEmit else { return }
        self.sendEvent("onStatusChanged", self.buildStatus())
      }
    }
  }

  fileprivate func setLastActivationError(_ errorText: String) {
    self.eventLock.lock()
    self.lastActivationError = errorText
    self.eventLock.unlock()
  }

  // ★ JSへ渡す前にネイティブ層で受信を記録（JSに届いているかの切り分け用）
  fileprivate func recordReceived(kind: String, body: [String: Any]) {
    let actionStr = (body["action"] as? String) ?? (body["type"] as? String) ?? "?"
    let nowMs = Date().timeIntervalSince1970 * 1000.0
    self.eventLock.lock()
    nativeReceivedCount += 1
    lastNativeReceivedAt = nowMs
    lastNativeReceivedKind = kind
    lastNativeReceivedAction = actionStr
    self.eventLock.unlock()
  }

  // ★ スマホ画面閉鎖・別アプリ切替直後も Supabase Realtime 受信および Watch/OSバナー通知送出を完了できるようバックグラウンド実行猶予を確保
  fileprivate func setupBackgroundTaskObservers() {
    guard bgObserverTokens.isEmpty else { return }
    let becomeActive = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      _ = self?.currentAppStateText()
    }
    let resignActive = NotificationCenter.default.addObserver(
      forName: UIApplication.willResignActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      _ = self?.currentAppStateText()
    }
    let enterBg = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      _ = self?.currentAppStateText()
      self?.beginRealtimeBackgroundTask()
    }
    let enterFg = NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      _ = self?.currentAppStateText()
      self?.endRealtimeBackgroundTask()
      self?.endWatchActionBackgroundTask()
    }
    bgObserverTokens = [becomeActive, resignActive, enterBg, enterFg]
  }

  private func beginRealtimeBackgroundTask() {
    if !Thread.isMainThread {
      DispatchQueue.main.async { [weak self] in
        self?.beginRealtimeBackgroundTask()
      }
      return
    }
    var expiredBeforeStore = false
    var isCreating = true
    let startedId = UIApplication.shared.beginBackgroundTask(withName: "AssistTimerRealtimePeerSync") { [weak self] in
      guard let self = self else { return }
      self.bgTaskLock.lock()
      if isCreating {
        expiredBeforeStore = true
        self.bgTaskLock.unlock()
        return
      }
      self.bgTaskLock.unlock()
      self.endRealtimeBackgroundTask()
    }
    if startedId == .invalid {
      return
    }

    var taskToEndImmediately: UIBackgroundTaskIdentifier = .invalid
    var oldTaskId: UIBackgroundTaskIdentifier = .invalid
    var scheduledWorkItem: DispatchWorkItem?

    bgTaskLock.lock()
    isCreating = false
    if expiredBeforeStore {
      taskToEndImmediately = startedId
    } else {
      realtimeBgWorkItem?.cancel()
      realtimeBgWorkItem = nil
      oldTaskId = realtimeBgTaskId
      realtimeBgTaskId = startedId
      let workItem = DispatchWorkItem { [weak self] in
        self?.endRealtimeBackgroundTask()
      }
      realtimeBgWorkItem = workItem
      scheduledWorkItem = workItem
    }
    bgTaskLock.unlock()

    if oldTaskId != .invalid {
      UIApplication.shared.endBackgroundTask(oldTaskId)
    }
    if taskToEndImmediately != .invalid {
      UIApplication.shared.endBackgroundTask(taskToEndImmediately)
      return
    }
    if let workItem = scheduledWorkItem {
      DispatchQueue.main.asyncAfter(deadline: .now() + 3.5, execute: workItem)
    }
  }

  fileprivate func endRealtimeBackgroundTask() {
    if !Thread.isMainThread {
      DispatchQueue.main.async { [weak self] in
        self?.endRealtimeBackgroundTask()
      }
      return
    }
    bgTaskLock.lock()
    realtimeBgWorkItem?.cancel()
    realtimeBgWorkItem = nil
    let taskToEnd = realtimeBgTaskId
    realtimeBgTaskId = .invalid
    bgTaskLock.unlock()
    if taskToEnd != .invalid {
      UIApplication.shared.endBackgroundTask(taskToEnd)
    }
  }

  // ★ Watchからバックグラウンド中のiPhoneへ操作（STOP_TIMER等）が届いた際、
  //   メインスレッド上で安全にバックグラウンド実行タスク（3.5秒上限）を確保し、
  //   replyHandler返却直後にiOSがプロセスを即サスペンドしてSupabaseへのクラウド同期（upsertCloudTimer）が中断されるのを防止する
  fileprivate func beginWatchActionBackgroundTask() {
    if !Thread.isMainThread {
      DispatchQueue.main.async { [weak self] in
        self?.beginWatchActionBackgroundTask()
      }
      return
    }
    var expiredBeforeStore = false
    var isCreating = true
    let startedId = UIApplication.shared.beginBackgroundTask(withName: "AssistTimerWatchActionCloudSync") { [weak self] in
      guard let self = self else { return }
      self.appendNativeDiagLog(
        hop: "N_BG_TASK_EXPIRE",
        ch: "bg_task",
        act: "watch_action_3.5s",
        res: "skip",
        rsn: "os_expiration"
      )
      self.bgTaskLock.lock()
      if isCreating {
        expiredBeforeStore = true
        self.bgTaskLock.unlock()
        return
      }
      self.bgTaskLock.unlock()
      self.endWatchActionBackgroundTask()
    }
    let remBgSec = UIApplication.shared.backgroundTimeRemaining
    // ★ フォアグラウンド時は backgroundTimeRemaining が DBL_MAX (1.797e308, isFinite == true) を返すため、
    //   Int(remBgSec) を先に評価すると Int.max オーバーフロー (EXC_BREAKPOINT) で即クラッシュする。必ず Double のまま上限クランプしてから Int 化する。
    let safeBgRemainingSec: Int = (remBgSec.isFinite && remBgSec >= 0)
      ? Int(min(999.0, max(0.0, remBgSec)).rounded(.down))
      : -1
    self.appendNativeDiagLog(
      hop: "N_BG_TASK_BEGIN",
      ch: "bg_task",
      act: "watch_action_3.5s",
      res: startedId == .invalid ? "err" : "ok",
      rsn: startedId == .invalid ? "invalid_task_id" : "started",
      meta: [
        "bgTimeRemainingSec": safeBgRemainingSec
      ]
    )
    if startedId == .invalid {
      return
    }

    var taskToEndImmediately: UIBackgroundTaskIdentifier = .invalid
    var oldTaskId: UIBackgroundTaskIdentifier = .invalid
    var scheduledWorkItem: DispatchWorkItem?

    bgTaskLock.lock()
    isCreating = false
    if expiredBeforeStore {
      taskToEndImmediately = startedId
    } else {
      watchActionBgWorkItem?.cancel()
      watchActionBgWorkItem = nil
      oldTaskId = watchActionBgTaskId
      watchActionBgTaskId = startedId
      let workItem = DispatchWorkItem { [weak self] in
        self?.appendNativeDiagLog(
          hop: "N_BG_TASK_EXPIRE",
          ch: "bg_task",
          act: "watch_action_3.5s",
          res: "ok",
          rsn: "timer_3.5s"
        )
        self?.endWatchActionBackgroundTask()
      }
      watchActionBgWorkItem = workItem
      scheduledWorkItem = workItem
    }
    bgTaskLock.unlock()

    if oldTaskId != .invalid {
      UIApplication.shared.endBackgroundTask(oldTaskId)
    }
    if taskToEndImmediately != .invalid {
      UIApplication.shared.endBackgroundTask(taskToEndImmediately)
      return
    }
    if let workItem = scheduledWorkItem {
      DispatchQueue.main.asyncAfter(deadline: .now() + 3.5, execute: workItem)
    }
  }

  fileprivate func endWatchActionBackgroundTask() {
    if !Thread.isMainThread {
      DispatchQueue.main.async { [weak self] in
        self?.endWatchActionBackgroundTask()
      }
      return
    }
    bgTaskLock.lock()
    watchActionBgWorkItem?.cancel()
    watchActionBgWorkItem = nil
    let taskToEnd = watchActionBgTaskId
    watchActionBgTaskId = .invalid
    bgTaskLock.unlock()
    if taskToEnd != .invalid {
      UIApplication.shared.endBackgroundTask(taskToEnd)
    }
  }
}

// MARK: - OS標準バナー通知表示デリゲート（inactive / background 時の確実なバナー表示＆既存デリゲート委譲）
private class PeerNotificationCenterDelegate: NSObject, UNUserNotificationCenterDelegate {
  weak var previousDelegate: UNUserNotificationCenterDelegate?
  weak var module: ExpoWatchConnectivityModule?

  init(previousDelegate: UNUserNotificationCenterDelegate?, module: ExpoWatchConnectivityModule? = nil) {
    self.previousDelegate = previousDelegate
    self.module = module
    super.init()
  }

  private static func extractTraceId(from userInfo: [AnyHashable: Any]) -> String {
    if let t = userInfo["traceId"] as? String, !t.isEmpty { return t }
    if let body = userInfo["body"] as? [String: Any], let t = body["traceId"] as? String, !t.isEmpty { return t }
    return ""
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let handleOnMain = { [weak self] in
      let reqId = notification.request.identifier
      let traceId = Self.extractTraceId(from: notification.request.content.userInfo)
      if reqId.hasPrefix("assisttimer.peer.") {
        self?.module?.appendNativeDiagLog(
          hop: "N_LOCAL_NOTIF",
          ch: "local_will_present",
          act: "peer_banner",
          res: "ok",
          rsn: "shown",
          traceId: traceId
        )
        if #available(iOS 14.0, *) {
          completionHandler([.banner, .list, .sound])
        } else {
          completionHandler([.alert, .sound])
        }
        return
      }
      if notification.request.trigger is UNPushNotificationTrigger {
        if UIApplication.shared.applicationState == .active {
          self?.module?.appendNativeDiagLog(
            hop: "N_LOCAL_NOTIF",
            ch: "apns_will_present",
            act: "remote_push",
            res: "skip",
            rsn: "fg_suppressed_native",
            traceId: traceId
          )
          // アプリがフォアグラウンド（active）の時はRealtimeのアプリ内トースト＋Watch直接通知のみとし、OSリモートプッシュバナーの二重表示を抑止
          completionHandler([])
          return
        }
        self?.module?.appendNativeDiagLog(
          hop: "N_LOCAL_NOTIF",
          ch: "apns_will_present",
          act: "remote_push",
          res: "ok",
          rsn: "delegated_non_active",
          traceId: traceId
        )
      }
      if let prev = self?.previousDelegate,
         prev.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
        prev.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
        return
      }
      if #available(iOS 14.0, *) {
        completionHandler([.banner, .list, .sound])
      } else {
        completionHandler([.alert, .sound])
      }
    }

    if Thread.isMainThread {
      handleOnMain()
    } else {
      DispatchQueue.main.async(execute: handleOnMain)
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if let prev = previousDelegate,
       prev.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
      prev.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
      return
    }
    completionHandler()
  }
}

// MARK: - WCSessionDelegate 専用内部クラス (NSObject準拠)
private class SessionDelegate: NSObject, WCSessionDelegate {
  weak var module: ExpoWatchConnectivityModule?

  init(module: ExpoWatchConnectivityModule) {
    self.module = module
    super.init()
  }

  private static func extractRxDiagFields(_ body: [String: Any]) -> (act: String, traceId: String, seat: String) {
    let act = (body["action"] as? String) ?? (body["type"] as? String) ?? "?"
    let traceId = (body["traceId"] as? String)
      ?? ((body["extra"] as? [String: Any])?["traceId"] as? String)
      ?? ""
    let seat = (body["seatId"] as? String)
      ?? (body["seatId"] as? NSNumber)?.stringValue
      ?? ""
    return (act, traceId, seat)
  }

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    let errorText = error?.localizedDescription ?? ""
    DispatchQueue.main.async {
      self.module?.setLastActivationError(errorText)
      if activationState == .activated {
        self.module?.flushPendingApplicationContext(session: session)
        self.module?.flushPendingUserInfo(session: session)
      }
      self.module?.emitStatus()
    }
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    DispatchQueue.main.async {
      self.module?.emitStatus()
    }
  }

  func sessionWatchStateDidChange(_ session: WCSession) {
    DispatchQueue.main.async {
      self.module?.emitStatus()
    }
  }

  func sessionDidBecomeInactive(_ session: WCSession) {
    // 複数Watch切り替え時
  }

  func sessionDidDeactivate(_ session: WCSession) {
    // 新しいセッションに再アクティベート
    session.activate()
  }

  func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
    DispatchQueue.main.async {
      self.module?.beginWatchActionBackgroundTask()
      self.module?.recordReceived(kind: "message", body: message)
      let res = self.module?.dispatchEvent("onMessageReceived", ["message": message])
      let fields = Self.extractRxDiagFields(message)
      self.module?.appendNativeDiagLog(
        hop: "N_WC_RX",
        ch: "message_noreply",
        act: fields.act,
        res: "ok",
        rsn: (res?.canEmit == true) ? "js_dispatched" : "queued_pre_js",
        traceId: fields.traceId,
        seat: fields.seat,
        meta: [
          "seq": res?.seq ?? 0,
          "jsReady": res?.jsReady ?? false,
          "hasListeners": res?.hasListeners ?? false
        ]
      )
    }
  }

  func session(_ session: WCSession, didReceiveMessage message: [String : Any], replyHandler: @escaping ([String : Any]) -> Void) {
    DispatchQueue.main.async {
      self.module?.beginWatchActionBackgroundTask()
      self.module?.recordReceived(kind: "message", body: message)
      let res = self.module?.dispatchEvent("onMessageReceived", ["message": message])
      let fields = Self.extractRxDiagFields(message)
      self.module?.appendNativeDiagLog(
        hop: "N_WC_RX",
        ch: "message_reply",
        act: fields.act,
        res: "ok",
        rsn: (res?.canEmit == true) ? "js_dispatched" : "queued_pre_js",
        traceId: fields.traceId,
        seat: fields.seat,
        meta: [
          "seq": res?.seq ?? 0,
          "jsReady": res?.jsReady ?? false,
          "hasListeners": res?.hasListeners ?? false
        ]
      )
      if UIApplication.shared.applicationState != .active {
        // バックグラウンド起床時はすでに beginWatchActionBackgroundTask()（3.5秒保護）を開始しているため、
        // Watch側 0.85s タイムアウトより十分に早くACKが返るよう 0.10秒で replyHandler を返す
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) { [weak self] in
          replyHandler(["status": "acknowledged"])
          self?.module?.appendNativeDiagLog(
            hop: "N_WC_ACK_SENT",
            ch: "message_reply",
            act: fields.act,
            res: "ok",
            rsn: "delayed_100ms_bg",
            traceId: fields.traceId,
            seat: fields.seat,
            meta: [
              "seq": res?.seq ?? 0,
              "jsDispatched": res?.canEmit ?? false
            ]
          )
        }
      } else {
        replyHandler(["status": "acknowledged"])
        self.module?.appendNativeDiagLog(
          hop: "N_WC_ACK_SENT",
          ch: "message_reply",
          act: fields.act,
          res: "ok",
          rsn: "immediate_fg",
          traceId: fields.traceId,
          seat: fields.seat,
          meta: [
            "seq": res?.seq ?? 0,
            "jsDispatched": res?.canEmit ?? false
          ]
        )
      }
    }
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
    DispatchQueue.main.async {
      self.module?.beginWatchActionBackgroundTask()
      self.module?.recordReceived(kind: "context", body: applicationContext)
      let res = self.module?.dispatchEvent("onApplicationContextReceived", ["context": applicationContext])
      let fields = Self.extractRxDiagFields(applicationContext)
      self.module?.appendNativeDiagLog(
        hop: "N_WC_RX",
        ch: "context",
        act: fields.act,
        res: "ok",
        rsn: (res?.canEmit == true) ? "js_dispatched" : "queued_pre_js",
        traceId: fields.traceId,
        seat: fields.seat,
        meta: [
          "seq": res?.seq ?? 0,
          "jsReady": res?.jsReady ?? false,
          "hasListeners": res?.hasListeners ?? false
        ]
      )
    }
  }

  // ★ 予備ルート（transferUserInfo）で届いた操作は onUserInfoReceived のみで通知し、二重処理を防止
  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any] = [:]) {
    DispatchQueue.main.async {
      self.module?.beginWatchActionBackgroundTask()
      self.module?.recordReceived(kind: "userInfo", body: userInfo)
      let res = self.module?.dispatchEvent("onUserInfoReceived", ["userInfo": userInfo])
      let fields = Self.extractRxDiagFields(userInfo)
      self.module?.appendNativeDiagLog(
        hop: "N_WC_RX",
        ch: "userInfo",
        act: fields.act,
        res: "ok",
        rsn: (res?.canEmit == true) ? "js_dispatched" : "queued_pre_js",
        traceId: fields.traceId,
        seat: fields.seat,
        meta: [
          "seq": res?.seq ?? 0,
          "jsReady": res?.jsReady ?? false,
          "hasListeners": res?.hasListeners ?? false
        ]
      )
    }
  }
}
