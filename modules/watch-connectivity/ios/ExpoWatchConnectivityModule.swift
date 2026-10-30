import ExpoModulesCore
import WatchConnectivity
import UserNotifications
import UIKit

public class ExpoWatchConnectivityModule: Module {
  private var sessionDelegate: SessionDelegate?
  private var notificationDelegate: PeerNotificationCenterDelegate?
  private var bgTaskId: UIBackgroundTaskIdentifier = .invalid
  private var bgObserverTokens: [NSObjectProtocol] = []
  private var pendingApplicationContext: [String: Any]?
  private var pendingUserInfo: [String: Any]?

  // ★ 診断用（通信状態の画面表示に使用）
  fileprivate var lastActivationError: String = ""
  fileprivate var nativeReceivedCount: Int = 0
  fileprivate var lastNativeReceivedAt: Double = 0
  fileprivate var lastNativeReceivedKind: String = ""
  fileprivate var lastNativeReceivedAction: String = ""

  // ★ JSの受信準備が整う前およびイベント取りこぼし防止用の受信キュー（連番管理）
  private let eventLock = NSLock()
  private var jsReady: Bool = false
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
          let notifDelegate = PeerNotificationCenterDelegate(previousDelegate: center.delegate)
          self.notificationDelegate = notifDelegate
          center.delegate = notifDelegate
        }
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
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
          promise.resolve(granted)
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
        center.add(request) { error in
          promise.resolve(error == nil)
        }
      }

      center.getNotificationSettings { settings in
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
          enqueueNotification()
        case .notDetermined:
          center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            if granted {
              enqueueNotification()
            } else {
              promise.resolve(false)
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
        cleanUserInfo["notification"] != nil
      var wireUserInfo = cleanUserInfo
      wireUserInfo.removeValue(forKey: "highPriorityWake")

      if let msgType = wireUserInfo["type"] as? String {
        for transfer in session.outstandingUserInfoTransfers where transfer.isTransferring {
          if let existingType = transfer.userInfo["type"] as? String,
             existingType == msgType,
             transfer.userInfo["notification"] == nil {
            transfer.cancel()
          }
        }
      }

      // ★ 1日50回の transferCurrentComplicationUserInfo 優先起床枠のうち最後の15回は、
      //   タイマー停止・一時停止・リセットおよび共有通知（isHighPriorityWake）専用に温存し、通常同期による枯渇を防止する
      let canUseComplicationTransfer =
        session.isComplicationEnabled &&
        session.remainingComplicationUserInfoTransfers > 0 &&
        (isHighPriorityWake || session.remainingComplicationUserInfoTransfers > 15)

      let transfer: WCSessionUserInfoTransfer
      if canUseComplicationTransfer {
        transfer = session.transferCurrentComplicationUserInfo(wireUserInfo)
      } else {
        transfer = session.transferUserInfo(wireUserInfo)
      }
      self.eventLock.lock()
      self.pendingUserInfo = nil
      self.eventLock.unlock()
      promise.resolve(transfer.isTransferring)
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
      pending["notification"] != nil
    var wirePending = pending
    wirePending.removeValue(forKey: "highPriorityWake")
    let canUseComplicationTransfer =
      session.isComplicationEnabled &&
      session.remainingComplicationUserInfoTransfers > 0 &&
      (isHighPriorityWake || session.remainingComplicationUserInfoTransfers > 15)
    if canUseComplicationTransfer {
      session.transferCurrentComplicationUserInfo(wirePending)
    } else {
      session.transferUserInfo(wirePending)
    }
  }

  fileprivate func dispatchEvent(_ name: String, _ body: [String: Any]) {
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
    let ready = jsReady
    eventLock.unlock()
    if ready {
      sendEvent(name, taggedBody)
    }
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
      "delegateOk": delegateOk,
      "activationError": actErr,
      "nativeReceivedCount": rxCount,
      "lastNativeReceivedAt": rxAt,
      "lastNativeReceivedKind": rxKind,
      "lastNativeReceivedAction": rxAction
    ]
  }

  fileprivate func emitStatus() {
    sendEvent("onStatusChanged", buildStatus())
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
    let enterBg = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.beginRealtimeBackgroundTask()
    }
    let enterFg = NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.endRealtimeBackgroundTask()
    }
    bgObserverTokens = [enterBg, enterFg]
  }

  private func beginRealtimeBackgroundTask() {
    endRealtimeBackgroundTask()
    bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "AssistTimerRealtimePeerSync") { [weak self] in
      self?.endRealtimeBackgroundTask()
    }
  }

  fileprivate func endRealtimeBackgroundTask() {
    guard bgTaskId != .invalid else { return }
    let taskToEnd = bgTaskId
    bgTaskId = .invalid
    UIApplication.shared.endBackgroundTask(taskToEnd)
  }
}

// MARK: - OS標準バナー通知表示デリゲート（inactive / background 時の確実なバナー表示＆既存デリゲート委譲）
private class PeerNotificationCenterDelegate: NSObject, UNUserNotificationCenterDelegate {
  weak var previousDelegate: UNUserNotificationCenterDelegate?

  init(previousDelegate: UNUserNotificationCenterDelegate?) {
    self.previousDelegate = previousDelegate
    super.init()
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let reqId = notification.request.identifier
    if reqId.hasPrefix("assisttimer.peer.") {
      if #available(iOS 14.0, *) {
        completionHandler([.banner, .list, .sound])
      } else {
        completionHandler([.alert, .sound])
      }
      return
    }
    if notification.request.trigger is UNPushNotificationTrigger {
      let isForeground: Bool
      if Thread.isMainThread {
        isForeground = (UIApplication.shared.applicationState == .active)
      } else {
        isForeground = DispatchQueue.main.sync { UIApplication.shared.applicationState == .active }
      }
      if isForeground {
        // アプリがフォアグラウンド（active）の時はRealtimeのアプリ内トースト＋Watch直接通知のみとし、OSリモートプッシュバナーの二重表示を抑止
        completionHandler([])
        return
      }
    }
    if let prev = previousDelegate,
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
      self.module?.recordReceived(kind: "message", body: message)
      self.module?.dispatchEvent("onMessageReceived", ["message": message])
    }
  }

  func session(_ session: WCSession, didReceiveMessage message: [String : Any], replyHandler: @escaping ([String : Any]) -> Void) {
    DispatchQueue.main.async {
      self.module?.recordReceived(kind: "message", body: message)
      self.module?.dispatchEvent("onMessageReceived", ["message": message])
    }
    replyHandler(["status": "acknowledged"])
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
    DispatchQueue.main.async {
      self.module?.recordReceived(kind: "context", body: applicationContext)
      self.module?.dispatchEvent("onApplicationContextReceived", ["context": applicationContext])
    }
  }

  // ★ 予備ルート（transferUserInfo）で届いた操作は onUserInfoReceived のみで通知し、二重処理を防止
  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any] = [:]) {
    DispatchQueue.main.async {
      self.module?.recordReceived(kind: "userInfo", body: userInfo)
      self.module?.dispatchEvent("onUserInfoReceived", ["userInfo": userInfo])
    }
  }
}
