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

    /// DateからJSON安全な有限エポック秒（Double）を取得する（NaN/InfiniteによるJSONSerialization Objective-C例外SIGABRTを完全防止）
    private static func safeFiniteEpoch(_ date: Date?) -> Double {
        guard let d = date else { return 0 }
        let ep = d.timeIntervalSince1970
        guard ep.isFinite, ep > 1_000_000_000, ep <= 4_102_444_800 else { return 0 }
        return ep.rounded()
    }

    private static let queueKey = DispatchSpecificKey<Bool>()
    private static let syncQueue: DispatchQueue = {
        let q = DispatchQueue(label: "com.assisttimer.watch.widgetsync", qos: .userInitiated)
        q.setSpecific(key: queueKey, value: true)
        return q
    }()
    private static var pendingWorkItem: DispatchWorkItem?
    private static var pendingForceReload: Bool = false
    private static var lastPayload: Data?
    private static var lastReloadedPayload: Data?
    private static var lastReloadedWhileActive: Bool = false
    private static var lastReloadAt: Date = .distantPast
    private static var trailingReloadWorkItem: DispatchWorkItem?

    static func save(timers: [SeatTimerItem], mainTimer: SeatTimerItem? = nil, userName: String, forceReload: Bool = false) {
        let timersSnapshot = timers
        let mainSnapshot = mainTimer
        let userSnapshot = userName

        // ★ メインスレッドの Watchdog タイムアウト（0x8badf00d: cfprefsd / chronod IPC 待ちデッドロック）を
        //   100%防止するため、メインスレッドからの `syncQueue.sync` は絶対に行わず、常に `syncQueue.async` で直列実行する。
        //   forceReload == true または非アクティブ時は 0.06秒デバウンスをスキップして syncQueue 上で即時実行する。
        let isAppActive: Bool = Thread.isMainThread ? (WKApplication.shared().applicationState == .active) : false
        let shouldExecuteImmediatelyOnQueue = forceReload || !isAppActive

        syncQueue.async {
            if forceReload {
                pendingForceReload = true
            }
            if shouldExecuteImmediatelyOnQueue {
                let effectiveForce = forceReload || pendingForceReload || !isAppActive
                pendingWorkItem?.cancel()
                pendingWorkItem = nil
                pendingForceReload = false
                performSaveOnQueue(
                    timers: timersSnapshot,
                    mainTimer: mainSnapshot,
                    userName: userSnapshot,
                    forceReload: effectiveForce,
                    isAppActive: isAppActive
                )
                return
            }

            pendingWorkItem?.cancel()
            let work = DispatchWorkItem {
                let shouldForce = pendingForceReload
                pendingForceReload = false
                performSaveOnQueue(
                    timers: timersSnapshot,
                    mainTimer: mainSnapshot,
                    userName: userSnapshot,
                    forceReload: shouldForce,
                    isAppActive: isAppActive
                )
            }
            pendingWorkItem = work
            syncQueue.asyncAfter(deadline: .now() + 0.06, execute: work)
        }
    }

    private static func performSaveOnQueue(timers: [SeatTimerItem], mainTimer: SeatTimerItem?, userName: String, forceReload: Bool, isAppActive: Bool) {
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
                let end = safeFiniteEpoch(t.targetEndTime)
                let checkEnd = (!t.isCheckCompleted ? safeFiniteEpoch(t.checkTargetEndTime) : 0)
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
            let isRel = t.isRelated(to: userName)
            let shouldAlertMain = t.shouldAlertMainTimer(for: userName)
            if let prev = prevStates {
                let prevEntry = prev[t.id] ?? (t.seatNumber > 0 ? prev[seatKey] : nil)
                let wasRunning = (prevEntry?.first ?? 0) > 0.5
                if wasRunning != t.isRunning {
                    seatOrCheckActiveChanged = true
                } else if t.isRunning, let p = prevEntry, p.count >= 2 {
                    let curEnd = safeFiniteEpoch(t.targetEndTime)
                    if abs(p[1] - curEnd) >= endChangeThreshold {
                        seatOrCheckActiveChanged = true
                    }
                    if p.count >= 4 {
                        let prevRel = p[3] > 0.5
                        if prevRel != isRel {
                            seatOrCheckActiveChanged = true
                        }
                    }
                    if p.count >= 5 {
                        let prevAlertMain = p[4] > 0.5
                        if prevAlertMain != shouldAlertMain {
                            seatOrCheckActiveChanged = true
                        }
                    }
                }
                let prevCheckEnd = (prevEntry?.count ?? 0) >= 3 ? (prevEntry?[2] ?? 0) : 0
                let checkEnd = (!t.isCheckCompleted ? safeFiniteEpoch(t.checkTargetEndTime) : 0)
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
            let active = (t.isRunning || t.isPreCountingDown) && safeFiniteEpoch(t.targetEndTime) > 0
            let checkEnd = (!t.isCheckCompleted ? safeFiniteEpoch(t.checkTargetEndTime) : 0)
            let isRel = (t.id == "main-timer") ? true : t.isRelated(to: userName)
            let shouldAlertMain = (t.id == "main-timer") ? true : t.shouldAlertMainTimer(for: userName)
            let entry: [Double] = [
                active ? 1 : 0,
                active ? safeFiniteEpoch(t.targetEndTime) : 0,
                checkEnd,
                isRel ? 1 : 0,
                shouldAlertMain ? 1 : 0
            ]
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
            let runSec = max(0, min(86_400, m.pausedRemainingSeconds > 0 ? m.pausedRemainingSeconds : m.totalSeconds))
            let prepEnd: Date? = m.isPreCountingDown
                ? (m.prepEndTime ?? now.addingTimeInterval(TimeInterval(max(1, min(3_600, m.preCountdownSeconds)))))
                : nil
            let effectiveEnd: Date = {
                if let pEnd = prepEnd {
                    return pEnd.addingTimeInterval(TimeInterval(runSec))
                }
                return m.targetEndTime
            }()
            let mEndEpoch = safeFiniteEpoch(effectiveEnd)
            let mActive = (m.isRunning || m.isPreCountingDown) && mEndEpoch > 0

            var mainDict: [String: Any] = [
                "id": m.id,
                "seatNumber": 0,
                "seatLabel": "メインタイマー",
                "isMainTimer": true,
                "endEpoch": mActive ? mEndEpoch : 0,
                "isRunning": mActive,
                "pausedRemaining": max(0, min(86_400, m.pausedRemainingSeconds)),
                "related": true,
                "shouldAlertMain": true,
                "shouldAlertCheck": false,
                "totalSeconds": max(0, min(86_400, m.totalSeconds)),
                "isCountUpEnabled": true,
                "isCheckCompleted": true
            ]
            if mActive, let pEnd = prepEnd, pEnd > now, safeFiniteEpoch(pEnd) > 0 {
                mainDict["prepEndEpoch"] = safeFiniteEpoch(pEnd)
                mainDict["prepTotalSeconds"] = max(1, min(3_600, m.countdownConfigSeconds))
            }
            seats.append(mainDict)
        }

        for t in timers {
            let tEndEpoch = safeFiniteEpoch(t.targetEndTime)
            let tRunning = t.isRunning && tEndEpoch > 0
            var d: [String: Any] = [
                "id": t.id,
                "seatNumber": t.seatNumber,
                "seatLabel": t.displaySeatName,
                "isMainTimer": false,
                // 秒単位に丸めて、同じ内容での無駄な再読み込みを防ぐ（停止中の席は終了時刻を使わないので0）
                "endEpoch": tRunning ? tEndEpoch : 0,
                "isRunning": tRunning,
                "pausedRemaining": max(0, min(86_400, t.pausedRemainingSeconds)),
                "related": t.isRelated(to: userName),
                "shouldAlertMain": t.shouldAlertMainTimer(for: userName),
                "shouldAlertCheck": (!t.isCheckCompleted && safeFiniteEpoch(t.checkTargetEndTime) > 0 && t.shouldAlertCheckTimer(for: userName)),
                "totalSeconds": max(0, min(86_400, t.totalSeconds)),
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
            let chkEndEpoch = safeFiniteEpoch(t.checkTargetEndTime)
            if !t.isCheckCompleted, chkEndEpoch > 0, let checkTot = t.checkTotalSeconds, checkTot > 0 {
                d["checkEndEpoch"] = chkEndEpoch
                d["checkTotalSeconds"] = max(1, min(86_400, checkTot))
            }
            seats.append(d)
        }

        var payload: [String: Any] = ["seats": seats, "userName": userName]
        if let id = lastTouchedId {
            payload["lastTouchedId"] = id
        }
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        let shouldReloadImmediate = anyActiveStateChanged || !isAppActive
        if data == lastPayload && !anyActiveStateChanged {
            let now = Date()
            let hasPendingTrailing = (trailingReloadWorkItem != nil)
            let neverReloadedThisPayload = (lastReloadedPayload != data)
            let becameActiveAfterBackgroundReload = (isAppActive && !lastReloadedWhileActive)
            let isPeriodicForceEnsure = (forceReload && now.timeIntervalSince(lastReloadAt) >= 15.0)
            let needsForceEnsureReload = hasPendingTrailing || (forceReload && (neverReloadedThisPayload || becameActiveAfterBackgroundReload || isPeriodicForceEnsure))
            if needsForceEnsureReload {
                if !isAppActive || forceReload {
                    defaults.synchronize()
                }
                scheduleTimelineReloadOnQueue(for: data, isAppActive: isAppActive, immediate: !isAppActive)
            }
            return
        }
        lastPayload = data

        defaults.set(data, forKey: snapshotKey)
        if shouldReloadImmediate || forceReload {
            defaults.synchronize()
        }
        scheduleTimelineReloadOnQueue(for: data, isAppActive: isAppActive, immediate: shouldReloadImmediate)
    }

    private static func scheduleTimelineReloadOnQueue(for data: Data, isAppActive: Bool, immediate: Bool = false) {
        trailingReloadWorkItem?.cancel()
        let now = Date()
        let elapsed = now.timeIntervalSince(lastReloadAt)
        if immediate || elapsed >= 0.25 {
            trailingReloadWorkItem = nil
            lastReloadAt = now
            lastReloadedPayload = data
            lastReloadedWhileActive = isAppActive
            WidgetCenter.shared.reloadAllTimelines()
            if immediate && elapsed < 0.25 && isAppActive {
                let delay = max(0.08, 0.25 - elapsed)
                let work = DispatchWorkItem {
                    trailingReloadWorkItem = nil
                    lastReloadAt = Date()
                    lastReloadedPayload = data
                    let currentActive = Thread.isMainThread ? (WKApplication.shared().applicationState == .active) : isAppActive
                    lastReloadedWhileActive = currentActive
                    WidgetCenter.shared.reloadAllTimelines()
                }
                trailingReloadWorkItem = work
                syncQueue.asyncAfter(deadline: .now() + delay, execute: work)
            }
        } else {
            let delay = max(0.05, 0.25 - elapsed)
            let work = DispatchWorkItem {
                trailingReloadWorkItem = nil
                lastReloadAt = Date()
                lastReloadedPayload = data
                let currentActive = Thread.isMainThread ? (WKApplication.shared().applicationState == .active) : isAppActive
                lastReloadedWhileActive = currentActive
                WidgetCenter.shared.reloadAllTimelines()
            }
            trailingReloadWorkItem = work
            syncQueue.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }
}
