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
        // ★ バックグラウンド（文字盤表示中）で iPhone からデータが届いた時、WCSession デリゲート配送と
        //   直接クラウド補完ポーリング・WidgetSync 書き込みが完了するまで待機（最低 0.3秒、最大 1.8秒で安全解放）
        .backgroundTask(.watchConnectivity) {
            let startMs = safeEpochMillisInt64(Date().timeIntervalSince1970 * 1000.0)
            await MainActor.run {
                let hasPending = WCSession.isSupported() && WCSession.default.hasContentPending
                SyncTraceLogger.shared.log(
                    hop: "W_BG_WC_TASK",
                    ch: "bg_wc",
                    act: "begin",
                    res: "ok",
                    rsn: hasPending ? "has_pending" : "no_pending"
                )
                WatchSessionManager.shared.syncFromLatestApplicationContextIfNewer()
                WatchSessionManager.shared.pollCloudTimersFromSupabaseIfNeeded(force: true)
            }
            for i in 0..<12 {
                try? await Task.sleep(nanoseconds: 150_000_000)
                let shouldContinue = await MainActor.run {
                    let hasWCPending = WCSession.isSupported() && WCSession.default.hasContentPending
                    let isPolling = WatchSessionManager.shared.isDirectCloudPollInFlight
                    return i < 2 || hasWCPending || isPolling
                }
                if !shouldContinue { break }
            }
            await MainActor.run {
                WatchSessionManager.shared.syncFromLatestApplicationContextIfNewer()
                WidgetSync.save(
                    timers: WatchSessionManager.shared.timers,
                    mainTimer: WatchSessionManager.shared.mainTimer,
                    userName: WatchSessionManager.shared.currentUserName,
                    forceReload: true
                )
                let elapsed = Int(max(0, safeEpochMillisInt64(Date().timeIntervalSince1970 * 1000.0) - startMs))
                SyncTraceLogger.shared.log(
                    hop: "W_BG_WC_TASK",
                    ch: "bg_wc",
                    act: "end",
                    res: "ok",
                    stateRev: SyncTraceLogger.computeCompositeStateRev(WatchSessionManager.shared.timers),
                    ms: elapsed
                )
            }
        }
    }
}
