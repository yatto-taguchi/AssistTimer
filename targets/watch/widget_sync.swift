import Foundation
import WatchKit
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

    private static let queueKey = DispatchSpecificKey<Bool>()
    private static let syncQueue: DispatchQueue = {
        let q = DispatchQueue(label: "com.assisttimer.watch.widgetsync", qos: .userInitiated)
        q.setSpecific(key: queueKey, value: true)
        return q
    }()
    private static var pendingWorkItem: DispatchWorkItem?
    private static var pendingForceReload: Bool = false
    private static var lastPayload: Data?
    private static var lastReloadAt: Date = .distantPast
    private static var trailingReloadWorkItem: DispatchWorkItem?

    static func save(timers: [SeatTimerItem], mainTimer: SeatTimerItem? = nil, userName: String, forceReload: Bool = false) {
        let timersSnapshot = timers
        let mainSnapshot = mainTimer
        let userSnapshot = userName

        // ★ Watch アプリが非アクティブ／バックグラウンド（手首下げ減光中・バックグラウンド通信受信中）のとき、
        //   または呼び出し元がバックグラウンドスレッドのときは、0.06秒の非同期デバウンスでプロセスがサスペンドされて
        //   WidgetCenter.reloadAllTimelines() が発火し損ねるのを防ぐため、自動的に同期実行（syncQueue.sync）へ昇格する
        let isCallerBackgroundThread = !Thread.isMainThread
        let isAppNotActive: Bool = {
            if Thread.isMainThread {
                return WKApplication.shared().applicationState != .active
            }
            return true
        }()
        let shouldExecuteSynchronously = forceReload || isCallerBackgroundThread || isAppNotActive

        if shouldExecuteSynchronously {
            // ★ タイマースタート・時間決定・停止・scenePhase遷移などの明示的操作（forceReload: true）や非アクティブ時は、
            //   直後にデジタルクラウンで文字盤へ戻ってアプリがサスペンドしても100%即座に文字盤へ反映されるよう、
            //   0.06秒デバウンスおよび0.25秒スロットリングを一切挟まず同期的に保存＆タイムラインリロードを完了させる！
            let executeImmediateSave = {
                let effectiveForce = forceReload || pendingForceReload || isAppNotActive
                pendingWorkItem?.cancel()
                pendingWorkItem = nil
                pendingForceReload = false
                performSaveOnQueue(
                    timers: timersSnapshot,
                    mainTimer: mainSnapshot,
                    userName: userSnapshot,
                    forceReload: effectiveForce
                )
            }
            if DispatchQueue.getSpecific(key: queueKey) == true {
                executeImmediateSave()
            } else {
                syncQueue.sync(execute: executeImmediateSave)
            }
            return
        }

        syncQueue.async {
            pendingWorkItem?.cancel()
            let work = DispatchWorkItem {
                let shouldForce = pendingForceReload
                pendingForceReload = false
                performSaveOnQueue(
                    timers: timersSnapshot,
                    mainTimer: mainSnapshot,
                    userName: userSnapshot,
                    forceReload: shouldForce
                )
            }
            pendingWorkItem = work
            syncQueue.asyncAfter(deadline: .now() + 0.06, execute: work)
        }
    }

    private static func performSaveOnQueue(timers: [SeatTimerItem], mainTimer: SeatTimerItem?, userName: String, forceReload: Bool) {
        guard let defaults = UserDefaults(suiteName: appGroup) else { return }

        // メインタイマーも含めた全アイテムリスト
        var allItems = timers
        if let m = mainTimer {
            allItems.insert(m, at: 0)
        }

        // ── 最後に操作された席の判定（自分が関わる席を最優先し、他人の無関係な席で自分の文字盤が奪われないようにする） ──
        var lastTouchedId = defaults.string(forKey: lastTouchedKey)
        let prevStates = defaults.dictionary(forKey: prevStatesKey) as? [String: [Double]] // id: [isRunning(0/1), endEpoch, checkEndEpoch]
        let hasAnyRelatedActive = allItems.contains(where: { ($0.isRunning || $0.isPreCountingDown) && ($0.id == "main-timer" || $0.isRelated(to: userName)) })
        if let prev = prevStates {
            var touchedRelated: String?
            var touchedOther: String?
            for t in allItems where (t.isRunning || t.isPreCountingDown) {
                let end = t.targetEndTime.timeIntervalSince1970.rounded()
                let checkEnd = (!t.isCheckCompleted ? (t.checkTargetEndTime?.timeIntervalSince1970.rounded() ?? 0) : 0)
                let isRel = (t.id == "main-timer") || t.isRelated(to: userName)
                var didChange = false
                let seatKey = "seat-\(t.seatNumber)"
                let prevEntry = prev[t.id] ?? (t.seatNumber > 0 ? prev[seatKey] : nil)
                if let p = prevEntry, p.count >= 2 {
                    let wasRunning = p[0] > 0.5
                    let prevCheckEnd = p.count >= 3 ? p[2] : 0
                    if !wasRunning || abs(p[1] - end) >= endChangeThreshold || (checkEnd > 0 && abs(prevCheckEnd - checkEnd) >= endChangeThreshold) {
                        didChange = true // スタート（再開含む）・時間変更・チェックタイマー追加/変更
                    }
                } else if !prev.isEmpty {
                    // 新規作成（起動直後の「空→全席」読み込みは操作とみなさない）
                    didChange = true
                }
                if didChange {
                    if isRel {
                        touchedRelated = t.id
                    } else {
                        touchedOther = t.id
                    }
                }
            }
            if let rel = touchedRelated {
                lastTouchedId = rel
            } else if !hasAnyRelatedActive, let other = touchedOther {
                lastTouchedId = other
            }
        }
        // 削除された席、または停止した席の ID は忘れる（また、自分の関係席が稼働中なのに無関係な席が lastTouchedId になっている場合もリセット）
        if let id = lastTouchedId {
            let matchedActive = allItems.first(where: { ($0.id == id || ($0.seatNumber > 0 && "seat-\($0.seatNumber)" == id)) && ($0.isRunning || $0.isPreCountingDown) })
            if let m = matchedActive {
                if hasAnyRelatedActive && !(m.id == "main-timer" || m.isRelated(to: userName)) {
                    lastTouchedId = nil
                } else {
                    lastTouchedId = m.id
                }
            } else if !allItems.isEmpty {
                lastTouchedId = nil
            }
        }

        // ★ メインタイマー・全客席タイマー・チェックタイマーの稼働/停止遷移および稼働中席の削除を完全検知（anyActiveStateChanged）
        let prevMainActive = (prevStates?["main-timer"]?.first ?? 0) > 0.5
        let curMainActive = (mainTimer?.isRunning == true || mainTimer?.isPreCountingDown == true)
        let mainActiveChanged = (prevMainActive != curMainActive)

        var seatOrCheckActiveChanged = false
        var currentAllKeys = Set<String>(["main-timer"])
        for t in timers {
            currentAllKeys.insert(t.id)
            let seatKey = "seat-\(t.seatNumber)"
            if t.seatNumber > 0 {
                currentAllKeys.insert(seatKey)
            }
            if let prev = prevStates {
                let prevEntry = prev[t.id] ?? (t.seatNumber > 0 ? prev[seatKey] : nil)
                let wasRunning = (prevEntry?.first ?? 0) > 0.5
                if wasRunning != t.isRunning {
                    seatOrCheckActiveChanged = true
                } else if t.isRunning, let p = prevEntry, p.count >= 2 {
                    let curEnd = t.targetEndTime.timeIntervalSince1970.rounded()
                    if abs(p[1] - curEnd) >= endChangeThreshold {
                        seatOrCheckActiveChanged = true
                    }
                }
                let prevCheckEnd = (prevEntry?.count ?? 0) >= 3 ? (prevEntry?[2] ?? 0) : 0
                let checkEnd = (!t.isCheckCompleted ? (t.checkTargetEndTime?.timeIntervalSince1970.rounded() ?? 0) : 0)
                if (prevCheckEnd > 0 && checkEnd == 0) || (prevCheckEnd == 0 && checkEnd > 0) || (checkEnd > 0 && abs(prevCheckEnd - checkEnd) >= endChangeThreshold) {
                    seatOrCheckActiveChanged = true
                }
            }
        }
        if !seatOrCheckActiveChanged, let prev = prevStates {
            for (k, v) in prev where k != "main-timer" {
                if (v.first ?? 0) > 0.5 && !currentAllKeys.contains(k) {
                    seatOrCheckActiveChanged = true
                    break
                }
            }
        }
        let anyActiveStateChanged = mainActiveChanged || seatOrCheckActiveChanged

        var newStates: [String: [Double]] = [:]
        for t in allItems {
            let active = t.isRunning || t.isPreCountingDown
            let checkEnd = (!t.isCheckCompleted ? (t.checkTargetEndTime?.timeIntervalSince1970.rounded() ?? 0) : 0)
            let entry: [Double] = [active ? 1 : 0, active ? t.targetEndTime.timeIntervalSince1970.rounded() : 0, checkEnd]
            newStates[t.id] = entry
            if t.id != "main-timer" && t.seatNumber > 0 {
                newStates["seat-\(t.seatNumber)"] = entry
            }
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
                "isCreatorMe": t.isCreatorMe(currentUserName: userName),
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
            if !t.isCheckCompleted, let checkEnd = t.checkTargetEndTime, let checkTot = t.checkTotalSeconds {
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
        if data == lastPayload && !anyActiveStateChanged {
            if forceReload {
                trailingReloadWorkItem?.cancel()
                trailingReloadWorkItem = nil
                let now = Date()
                if now.timeIntervalSince(lastReloadAt) >= 0.1 {
                    lastReloadAt = now
                    WidgetCenter.shared.reloadAllTimelines()
                }
            } else if trailingReloadWorkItem != nil {
                trailingReloadWorkItem?.cancel()
                trailingReloadWorkItem = nil
                lastReloadAt = Date()
                WidgetCenter.shared.reloadAllTimelines()
            }
            return
        }
        lastPayload = data

        defaults.set(data, forKey: snapshotKey)
        if forceReload || anyActiveStateChanged {
            trailingReloadWorkItem?.cancel()
            trailingReloadWorkItem = nil
            lastReloadAt = Date()
            WidgetCenter.shared.reloadAllTimelines()
        } else {
            scheduleTimelineReloadOnQueue()
        }
    }

    private static func scheduleTimelineReloadOnQueue() {
        trailingReloadWorkItem?.cancel()
        let now = Date()
        let elapsed = now.timeIntervalSince(lastReloadAt)
        if elapsed >= 0.25 {
            lastReloadAt = now
            WidgetCenter.shared.reloadAllTimelines()
        } else {
            let delay = max(0.05, 0.25 - elapsed)
            let work = DispatchWorkItem {
                lastReloadAt = Date()
                WidgetCenter.shared.reloadAllTimelines()
            }
            trailingReloadWorkItem = work
            syncQueue.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }
}
