import ExpoModulesCore
import WatchConnectivity

public class WatchConnectivityModule: Module, WCSessionDelegate {
  private var session: WCSession? {
    return WCSession.isSupported() ? WCSession.default : nil
  }

  public func definition() -> ModuleDefinition {
    Name("WatchConnectivity")

    Events(
      "onMessageReceived",
      "onApplicationContextReceived"
    )

    AsyncFunction("activate") { (promise: Promise) in
      guard WCSession.isSupported() else {
        promise.resolve(["supported": false, "activated": false])
        return
      }
      
      let s = WCSession.default
      s.delegate = self
      s.activate()
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
        // まだアクティベートされていない場合はアクティベートを試行
        session.activate()
        promise.reject("E_NOT_ACTIVATED", "WCSession is not yet activated")
        return
      }

      do {
        try session.updateApplicationContext(context)
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
        // Reachableでない場合はフォールバックとしてupdateApplicationContextに回すか、エラーを返す
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

  // MARK: - WCSessionDelegate

  public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    // アクティベーション完了
  }

  public func sessionDidBecomeInactive(_ session: WCSession) {
    // 複数Watch切り替え時
  }

  public func sessionDidDeactivate(_ session: WCSession) {
    // 新しいセッションに再アクティベート
    session.activate()
  }

  public func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
    sendEvent("onMessageReceived", ["message": message])
  }

  public func session(_ session: WCSession, didReceiveMessage message: [String : Any], replyHandler: @escaping ([String : Any]) -> Void) {
    sendEvent("onMessageReceived", ["message": message])
    replyHandler(["status": "acknowledged"])
  }

  public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
    sendEvent("onApplicationContextReceived", ["context": applicationContext])
  }
}
