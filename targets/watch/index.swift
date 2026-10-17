import SwiftUI
import WatchKit
import WatchConnectivity

// ★ アプリのライフサイクル（スマートアラームの引き継ぎ・表示状態の検知）
final class WatchAppDelegate: NSObject, WKApplicationDelegate {
    func applicationDidFinishLaunching() {
        _ = WatchSessionManager.shared
        _ = WatchAlarmCoordinator.shared
    }

    func applicationDidBecomeActive() {
        WatchAlarmCoordinator.shared.appBecameActive()
    }

    // アプリ終了中にスマートアラームの時刻になった時、システムがアプリを起動してここに渡す
    // （ここで delegate を設定しないとセッションが終了してしまう）
    func handle(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        WatchAlarmCoordinator.shared.adopt(extendedRuntimeSession)
    }
}

@main
struct watchEntry: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        // ★ バックグラウンドで iPhone からデータが届いた時、受信処理が終わるまで起動を維持
        //   （席データを受け取ったらアラーム予定・通知を更新するため）
        .backgroundTask(.watchConnectivity) {
            await MainActor.run {
                _ = WatchSessionManager.shared
            }
            for _ in 0..<20 {
                if !WCSession.default.hasContentPending { break }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }
}
