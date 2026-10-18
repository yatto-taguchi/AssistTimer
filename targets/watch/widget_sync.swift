import Foundation
import WidgetKit

// MARK: - 文字盤コンプリケーション（targets/watch-widget）へのデータ共有
// App Group の UserDefaults に席タイマーの要約を書き込み、内容が変わった時だけ
// WidgetKit のタイムラインを再読み込みする（バックグラウンドの再読み込み回数には上限があるため）。
enum WidgetSync {
    static let appGroup = "group.com.assisttimer"
    static let snapshotKey = "assisttimer.widget.snapshot"

    private static var lastPayload: Data?

    static func save(timers: [SeatTimerItem], userName: String) {
        let seats: [[String: Any]] = timers.map { t in
            [
                "seatNumber": t.seatNumber,
                // 秒単位に丸めて、同じ内容での無駄な再読み込みを防ぐ
                "endEpoch": t.targetEndTime.timeIntervalSince1970.rounded(),
                "isRunning": t.isRunning,
                "pausedRemaining": t.pausedRemainingSeconds,
                "related": t.isRelated(to: userName)
            ]
        }
        let payload: [String: Any] = ["seats": seats, "userName": userName]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        if data == lastPayload { return }
        lastPayload = data

        guard let defaults = UserDefaults(suiteName: appGroup) else { return }
        defaults.set(data, forKey: snapshotKey)
        WidgetCenter.shared.reloadAllTimelines()
    }
}
