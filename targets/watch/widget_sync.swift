import Foundation
import WidgetKit

// MARK: - 文字盤コンプリケーション（targets/watch-widget）へのデータ共有
// App Group の UserDefaults に席タイマーの要約を書き込み、内容が変わった時だけ
// WidgetKit のタイムラインを再読み込みする（バックグラウンドの再読み込み回数には上限があるため）。
//
// ★「最後にスタート・時間変更・新規作成した席」（lastTouchedId）もここで判定する。
//   Watch の操作も iPhone の操作も最終的に席リスト（timers）の変化として届くため、
//   前回の状態と比べて「稼働を始めた」「終了時刻が変わった」「新しく増えた稼働中の席」を検出する。
enum WidgetSync {
    static let appGroup = "group.com.assisttimer"
    static let snapshotKey = "assisttimer.widget.snapshot"
    private static let prevStatesKey = "assisttimer.widget.prevStates"
    private static let lastTouchedKey = "assisttimer.widget.lastTouchedId"

    /// 終了時刻がこの秒数以上ずれたら「時間変更」とみなす（端末間の通信遅延による小さなずれは無視）
    private static let endChangeThreshold: Double = 2

    private static var lastPayload: Data?

    static func save(timers: [SeatTimerItem], mainTimer: SeatTimerItem? = nil, userName: String, forceReload: Bool = false) {
        guard let defaults = UserDefaults(suiteName: appGroup) else { return }

        // メインタイマーも含めた全アイテムリスト
        var allItems = timers
        if let m = mainTimer {
            allItems.insert(m, at: 0)
        }

        // ── 最後に操作された席の判定 ──
        var lastTouchedId = defaults.string(forKey: lastTouchedKey)
        let prevStates = defaults.dictionary(forKey: prevStatesKey) as? [String: [Double]] // id: [isRunning(0/1), endEpoch]
        if let prev = prevStates {
            var touched: String?
            for t in allItems where (t.isRunning || t.isPreCountingDown) {
                let end = t.targetEndTime.timeIntervalSince1970.rounded()
                if let p = prev[t.id], p.count == 2 {
                    let wasRunning = p[0] > 0.5
                    if !wasRunning || abs(p[1] - end) >= endChangeThreshold {
                        touched = t.id // スタート（再開含む）・時間変更
                    }
                } else if !prev.isEmpty {
                    // 新規作成（起動直後の「空→全席」読み込みは操作とみなさない）
                    touched = t.id
                }
            }
            if let touched = touched {
                lastTouchedId = touched
            }
        }
        // 削除された席、または停止した席の ID は忘れる
        if let id = lastTouchedId {
            let isStillActive = allItems.contains(where: { $0.id == id && ($0.isRunning || $0.isPreCountingDown) })
            if !isStillActive && !allItems.isEmpty {
                lastTouchedId = nil
            }
        }
        let prevMainActive = (prevStates?["main-timer"]?.first ?? 0) > 0.5
        let curMainActive = (mainTimer?.isRunning == true || mainTimer?.isPreCountingDown == true)
        let mainActiveChanged = (prevMainActive != curMainActive)
        var newStates: [String: [Double]] = [:]
        for t in allItems {
            let active = t.isRunning || t.isPreCountingDown
            newStates[t.id] = [active ? 1 : 0, t.targetEndTime.timeIntervalSince1970.rounded()]
        }
        defaults.set(newStates, forKey: prevStatesKey)
        if let id = lastTouchedId {
            defaults.set(id, forKey: lastTouchedKey)
        } else {
            defaults.removeObject(forKey: lastTouchedKey)
        }

        // ── コンプリケーション用の要約 ──
        var seats: [[String: Any]] = []
        if let m = mainTimer {
            let now = Date()
            let runSec = m.pausedRemainingSeconds > 0 ? m.pausedRemainingSeconds : m.totalSeconds
            let prepEnd: Date? = m.isPreCountingDown
                ? (m.prepEndTime ?? now.addingTimeInterval(TimeInterval(max(1, m.preCountdownSeconds))))
                : nil
            let effectiveEnd: Date = {
                if let pEnd = prepEnd {
                    return pEnd.addingTimeInterval(TimeInterval(runSec))
                }
                return m.targetEndTime
            }()
            let mActive = (m.isRunning || m.isPreCountingDown)

            var mainDict: [String: Any] = [
                "id": m.id,
                "seatNumber": 0,
                "seatLabel": "メインタイマー",
                "isMainTimer": true,
                "endEpoch": mActive ? effectiveEnd.timeIntervalSince1970.rounded() : 0,
                "isRunning": mActive,
                "pausedRemaining": m.pausedRemainingSeconds,
                "related": true,
                "totalSeconds": m.totalSeconds,
                "isCountUpEnabled": true,
                "isCheckCompleted": true
            ]
            if mActive, let pEnd = prepEnd, pEnd > now {
                mainDict["prepEndEpoch"] = pEnd.timeIntervalSince1970.rounded()
                mainDict["prepTotalSeconds"] = max(1, m.countdownConfigSeconds)
            }
            seats.append(mainDict)
        }

        for t in timers {
            var d: [String: Any] = [
                "id": t.id,
                "seatNumber": t.seatNumber,
                "seatLabel": t.displaySeatName,
                "isMainTimer": false,
                // 秒単位に丸めて、同じ内容での無駄な再読み込みを防ぐ（停止中の席は終了時刻を使わないので0）
                "endEpoch": t.isRunning ? t.targetEndTime.timeIntervalSince1970.rounded() : 0,
                "isRunning": t.isRunning,
                "pausedRemaining": t.pausedRemainingSeconds,
                "related": t.isRelated(to: userName),
                "totalSeconds": t.totalSeconds,
                "creatorName": t.creatorName,
                "isNoHelpNeeded": t.isNoHelpNeeded,
                "isCheckCompleted": t.isCheckCompleted,
                "checkProcess": t.displayCheckProcess,
                "helpProcess": t.helpProcess,
                "isRecruiting": t.isRecruiting
            ]
            if let shampoo = t.shampooStaff, !shampoo.isEmpty {
                d["shampooStaff"] = shampoo
            }
            if let staff = t.checkStaff, !staff.isEmpty {
                d["checkStaff"] = staff
            }
            if let checkEnd = t.checkTargetEndTime, let checkTot = t.checkTotalSeconds {
                d["checkEndEpoch"] = checkEnd.timeIntervalSince1970.rounded()
                d["checkTotalSeconds"] = checkTot
            }
            seats.append(d)
        }

        var payload: [String: Any] = ["seats": seats, "userName": userName]
        if let id = lastTouchedId {
            payload["lastTouchedId"] = id
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        if !forceReload && data == lastPayload && !mainActiveChanged { return }
        lastPayload = data

        defaults.set(data, forKey: snapshotKey)
        defaults.synchronize()
        WidgetCenter.shared.reloadAllTimelines()
    }
}
