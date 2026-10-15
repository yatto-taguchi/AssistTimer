import ExpoModulesCore
import WatchConnectivity

public class ExpoWatchConnectivityModule: Module {
  private var sessionDelegate: SessionDelegate?
  private var pendingApplicationContext: [String: Any]?

  private var session: WCSession? {
    return WCSession.isSupported() ? WCSession.default : nil
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoWatchConnectivity")

    Events(
      "onMessageReceived",
      "onApplicationContextReceived"
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

    AsyncFunction("updateApplicationContext") { (context: [String: Any], promise: Promise) in
      guard let session = self.session else {
        promise.reject("E_NOT_SUPPORTED", "WatchConnectivity is not supported on this device")
        return
      }

      guard session.activationState == .activated else {
        // まだアクティベート中の場合は保留キューに保管し、アクティベート完了時に自動送信
        self.pendingApplicationContext = context
        session.activate()
        promise.resolve(true)
        return
      }

      do {
        try session.updateApplicationContext(context)
        self.pendingApplicationContext = nil
        promise.resolve(true)
      } catch {
        promise.reject("E_UPDATE_FAILED", error.localizedDescription)
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

      guard session.isReachable else {
        promise.reject("E_NOT_REACHABLE", "Apple Watch is not currently reachable")
        return
      }

      session.sendMessage(message, replyHandler: { reply in
        promise.resolve(reply)
      }, errorHandler: { error in
        promise.reject("E_SEND_FAILED", error.localizedDescription)
      })
    }
  }

  fileprivate func flushPendingApplicationContext(session: WCSession) {
    guard let pending = self.pendingApplicationContext else { return }
    do {
      try session.updateApplicationContext(pending)
      self.pendingApplicationContext = nil
    } catch {
      print("[ExpoWatchConnectivity] flushPendingApplicationContext failed: \(error.localizedDescription)")
    }
  }

  fileprivate func dispatchEvent(_ name: String, _ body: [String: Any]) {
    sendEvent(name, body)
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
    if activationState == .activated {
      DispatchQueue.main.async {
        if let s = session as WCSession? {
          self.module?.flushPendingApplicationContext(session: s)
        }
      }
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
      self.module?.dispatchEvent("onMessageReceived", ["message": message])
    }
  }

  func session(_ session: WCSession, didReceiveMessage message: [String : Any], replyHandler: @escaping ([String : Any]) -> Void) {
    DispatchQueue.main.async {
      self.module?.dispatchEvent("onMessageReceived", ["message": message])
    }
    replyHandler(["status": "acknowledged"])
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
    DispatchQueue.main.async {
      self.module?.dispatchEvent("onApplicationContextReceived", ["context": applicationContext])
    }
  }
}
