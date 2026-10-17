import ExpoModulesCore
import WatchConnectivity

public class ExpoWatchConnectivityModule: Module {
  private var sessionDelegate: SessionDelegate?
  private var pendingApplicationContext: [String: Any]?
  private var pendingUserInfo: [String: Any]?

  // ★ 診断用（通信状態の画面表示に使用）
  fileprivate var lastActivationError: String = ""
  fileprivate var nativeReceivedCount: Int = 0
  fileprivate var lastNativeReceivedAt: Double = 0
  fileprivate var lastNativeReceivedKind: String = ""
  fileprivate var lastNativeReceivedAction: String = ""

  // ★ JSの受信準備が整う前に届いたWatchからの受信を保留（取りこぼし防止）
  private let eventLock = NSLock()
  private var jsReady: Bool = false
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
        self.pendingApplicationContext = cleanContext
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
        self.pendingApplicationContext = nil
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
        self.pendingUserInfo = cleanUserInfo
        session.activate()
        promise.resolve(true)
        return
      }

      guard session.isPaired, session.isWatchAppInstalled else {
        promise.resolve(false)
        return
      }

      let transfer = session.transferUserInfo(cleanUserInfo)
      self.pendingUserInfo = nil
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
    guard let pending = self.pendingApplicationContext else { return }
    do {
      try session.updateApplicationContext(pending)
      self.pendingApplicationContext = nil
    } catch {
      print("[ExpoWatchConnectivity] flushPendingApplicationContext failed: \(error.localizedDescription)")
    }
  }

  fileprivate func flushPendingUserInfo(session: WCSession) {
    guard session.isPaired, session.isWatchAppInstalled else { return }
    guard let pending = self.pendingUserInfo else { return }
    session.transferUserInfo(pending)
    self.pendingUserInfo = nil
  }

  fileprivate func dispatchEvent(_ name: String, _ body: [String: Any]) {
    eventLock.lock()
    if !jsReady {
      pendingEvents.append(["name": name, "body": body])
      if pendingEvents.count > maxPendingEvents {
        pendingEvents.removeFirst(pendingEvents.count - maxPendingEvents)
      }
      eventLock.unlock()
      return
    }
    eventLock.unlock()
    sendEvent(name, body)
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
    return [
      "supported": true,
      "activationState": activationStateText(s.activationState),
      "isPaired": s.isPaired,
      "isWatchAppInstalled": s.isWatchAppInstalled,
      "isReachable": s.isReachable,
      "delegateOk": delegateOk,
      "activationError": lastActivationError,
      "nativeReceivedCount": nativeReceivedCount,
      "lastNativeReceivedAt": lastNativeReceivedAt,
      "lastNativeReceivedKind": lastNativeReceivedKind,
      "lastNativeReceivedAction": lastNativeReceivedAction
    ]
  }

  fileprivate func emitStatus() {
    sendEvent("onStatusChanged", buildStatus())
  }

  // ★ JSへ渡す前にネイティブ層で受信を記録（JSに届いているかの切り分け用）
  fileprivate func recordReceived(kind: String, body: [String: Any]) {
    nativeReceivedCount += 1
    lastNativeReceivedAt = Date().timeIntervalSince1970 * 1000.0
    lastNativeReceivedKind = kind
    lastNativeReceivedAction = (body["action"] as? String) ?? (body["type"] as? String) ?? "?"
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
      self.module?.lastActivationError = errorText
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
