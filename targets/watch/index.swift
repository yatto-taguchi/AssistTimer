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
        // ★ バックグラウンドで iPhone からデータが届いた時、受信処理が終わるまで最小限の待機のみ維持
        //   （長時間のスリープ保持による Watchdog 0x8badf00d クラッシュを防ぐため最大 0.45 秒で即時解放）
        .backgroundTask(.watchConnectivity) {
            await MainActor.run {
                _ = WatchSessionManager.shared
            }
            for _ in 0..<3 {
                if !WCSession.isSupported() || !WCSession.default.hasContentPending { break }
                try? await Task.sleep(nanoseconds: 150_000_000)
            }
        }
    }
}
