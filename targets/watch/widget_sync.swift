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
    static let savedAtEpochKey = "assisttimer.widget.savedAtEpoch"
    static let lastTouchedAtEpochKey = "assisttimer.widget.lastTouchedAtEpoch"
    private static let widgetFetchedAtEpochKey = "assisttimer.widget.fetchedAtEpoch"
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
    private static var lastLoggedSkipDedup: Bool = false

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

        let nowEpoch = Date().timeIntervalSince1970

        // ★ HIGH-7: 直近15秒以内に WidgetKit がクラウドから最新状態を自律フェッチした直後に、
        //   Watch 本体アプリの「コールド起動直後でまだ一度も権威ある同期（SYNC_SEATS / 直接クラウドポーリング / 自機操作）を受けていない未同期メモリ」から
        //   「全客席 00:00 非稼働」かつローカル停止記録もないデータが渡された場合のみ、App Group の稼働中客席スナップショットを逆上書きしないよう保護する。
        //   （※既に SYNC_SEATS やクラウド同期を受信済み（hasReceivedAuthoritativeSyncInSession == true）のリモート停止・担当解除では絶対にブロックしない）
        let lastWidgetFetchEpoch = defaults.double(forKey: widgetFetchedAtEpochKey)
        let hasAnyIncomingRunningSeat = timers.contains(where: { $0.isRunning && safeFiniteEpoch($0.targetEndTime) > 0 })
        let isIncomingMainActive = (mainTimer?.isRunning == true || mainTimer?.isPreCountingDown == true)
        let isColdBootUnsyncedMemory = !WatchSessionManager.shared.hasReceivedAuthoritativeSyncInSession
        if isColdBootUnsyncedMemory && !hasAnyIncomingRunningSeat && !isIncomingMainActive && lastWidgetFetchEpoch > 0 && (nowEpoch - lastWidgetFetchEpoch) < 15.0,
           let existingData = defaults.data(forKey: snapshotKey),
           let existingObj = try? JSONSerialization.jsonObject(with: existingData) as? [String: Any],
           let existingSeats = existingObj["seats"] as? [[String: Any]] {
            let hadRunningMainInExisting = existingSeats.contains { sDict in
                let isMain = (sDict["isMainTimer"] as? NSNumber)?.boolValue ?? (sDict["isMainTimer"] as? Bool) ?? false
                let sRunning = (sDict["isRunning"] as? NSNumber)?.boolValue ?? (sDict["isRunning"] as? Bool) ?? false
                return isMain && sRunning
            }
            if !hadRunningMainInExisting {
                let localStopsDict = (defaults.dictionary(forKey: "assisttimer.watch.localStops.v1") as? [String: [String: Double]]) ?? [:]
                let confirmedPeerStopsDict = (defaults.dictionary(forKey: "assisttimer.watch.confirmedPeerStoppedEnds.v1") as? [String: Double]) ?? [:]
                let hasUnstoppedActiveCloudSeatInExisting = existingSeats.contains { sDict in
                    let isMain = (sDict["isMainTimer"] as? NSNumber)?.boolValue ?? (sDict["isMainTimer"] as? Bool) ?? false
                    guard !isMain else { return false }
                    let sRunning = (sDict["isRunning"] as? NSNumber)?.boolValue ?? (sDict["isRunning"] as? Bool) ?? false
                    let sEnd = (sDict["endEpoch"] as? NSNumber)?.doubleValue ?? (sDict["endEpoch"] as? Double) ?? 0
                    guard sRunning, sEnd > 0, sEnd > nowEpoch - 10800 else { return false }
                    let sId = (sDict["id"] as? String) ?? ""
                    let sNum = (sDict["seatNumber"] as? NSNumber)?.intValue ?? (sDict["seatNumber"] as? Int) ?? 0
                    let stopRec = localStopsDict[sId] ?? (sNum > 0 ? localStopsDict["seat-\(sNum)"] : nil)
                    let stopAt = stopRec?["at"] ?? 0
                    let stopEnd = stopRec?["end"] ?? 0
                    let wasStoppedLocally = (stopEnd > 0 && abs(stopEnd - sEnd) <= 2.5 && nowEpoch - stopAt < 14400)
                        || (stopAt > 0 && nowEpoch - stopAt < 15.0)
                    let confirmedPeerEnd = confirmedPeerStopsDict[sId] ?? (sNum > 0 ? confirmedPeerStopsDict["seat-\(sNum)"] : nil) ?? 0
                    let wasConfirmedPeerStop = confirmedPeerEnd > 0 && abs(confirmedPeerEnd - sEnd) <= 2.5
                    return !wasStoppedLocally && !wasConfirmedPeerStop
                }
                if hasUnstoppedActiveCloudSeatInExisting {
                    SyncTraceLogger.shared.log(
                        hop: "W_WIDGET_SAVE",
                        ch: "app_group",
                        act: "save",
                        res: "skip",
                        rsn: "skip_cold_boot_15s",
                        stateRev: SyncTraceLogger.computeCompositeStateRev(timers)
                    )
                    return
                }
            }
        }

        // メインタイマーも含めた全アイテムリスト
        var allItems = timers
        if let m = mainTimer {
            allItems.insert(m, at: 0)
        }

        // ── 最後に操作された席の判定（自分が関わる席を最優先し、他人の無関係な席で自分の文字盤が奪われないようにする） ──
        var lastTouchedId = defaults.string(forKey: lastTouchedKey)
        var lastTouchedAtEpoch = defaults.double(forKey: lastTouchedAtEpochKey)
        var didTouchChange = false
        let prevStates = defaults.dictionary(forKey: prevStatesKey) as? [String: [Double]] // id: [isRunning(0/1), endEpoch, checkEndEpoch]
        let hasAnyRelatedActive = allItems.contains(where: { ($0.isRunning || $0.isPreCountingDown) && ($0.id == "main-timer" || $0.isRelated(to: userName)) })
        if let prev = prevStates {
            var touchedRelated: String?
            var touchedOther: String?
            for t in allItems where (t.isRunning || t.isPreCountingDown) {
                let end = safeFiniteEpoch(t.targetEndTime)
                let checkEnd = (!t.isCheckCompleted ? safeFiniteEpoch(t.checkTargetEndTime) : 0)
                let isRel = (t.id == "main-timer") || t.isRelated(to: userName)
                let shouldAlertMain = (t.id == "main-timer") || t.shouldAlertMainTimer(for: userName)
                var didChange = false
                let seatKey = "seat-\(t.seatNumber)"
                let prevEntry = prev[t.id] ?? (t.seatNumber > 0 ? prev[seatKey] : nil)
                if let p = prevEntry, p.count >= 2 {
                    let wasRunning = p[0] > 0.5
                    let prevCheckEnd = p.count >= 3 ? p[2] : 0
                    let prevRel = p.count >= 4 ? (p[3] > 0.5) : false
                    let prevAlertMain = p.count >= 5 ? (p[4] > 0.5) : false
                    if !wasRunning || abs(p[1] - end) >= endChangeThreshold || (checkEnd > 0 && abs(prevCheckEnd - checkEnd) >= endChangeThreshold) || (!prevRel && isRel) || (!prevAlertMain && shouldAlertMain) {
                        didChange = true // スタート（再開含む）・時間変更・チェックタイマー追加/変更・自分へのヘルプ/チェック担当新規指名
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
                didTouchChange = true
            } else if !hasAnyRelatedActive, let other = touchedOther {
                lastTouchedId = other
                didTouchChange = true
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
        if lastTouchedId == nil {
            lastTouchedAtEpoch = 0
        } else if didTouchChange {
            lastTouchedAtEpoch = nowEpoch.isFinite ? (nowEpoch * 1000.0).rounded() / 1000.0 : 0
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
            if lastTouchedAtEpoch.isFinite && lastTouchedAtEpoch > 0 {
                defaults.set(lastTouchedAtEpoch, forKey: lastTouchedAtEpochKey)
            } else {
                defaults.removeObject(forKey: lastTouchedAtEpochKey)
            }
        } else {
            defaults.removeObject(forKey: lastTouchedKey)
            defaults.removeObject(forKey: lastTouchedAtEpochKey)
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
                "isCountUpEnabled": m.isCountUpEnabled,
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
                "isCountUpEnabled": t.isCountUpEnabled,
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

        let salonId = (defaults.string(forKey: "assisttimer.watch.cloudSalonId.v1") ?? WatchSessionManager.shared.cloudSalonId).trimmingCharacters(in: .whitespacesAndNewlines)
        let userId = (defaults.string(forKey: "assisttimer.watch.cloudUserId.v1") ?? WatchSessionManager.shared.cloudUserId).trimmingCharacters(in: .whitespacesAndNewlines)
        let aliases = (defaults.stringArray(forKey: "assisttimer.watch.userAliases.v1") ?? WatchSessionManager.shared.currentUserAliases)

        var payload: [String: Any] = [
            "seats": seats,
            "userName": userName,
            "userAliases": aliases,
            "cloudSalonId": salonId,
            "cloudUserId": userId
        ]
        if let id = lastTouchedId {
            payload["lastTouchedId"] = id
            if lastTouchedAtEpoch.isFinite && lastTouchedAtEpoch > 0 {
                payload["lastTouchedAtEpoch"] = lastTouchedAtEpoch
            }
        }
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        let compositeRev = SyncTraceLogger.computeCompositeStateRev(timers)
        let shouldReloadImmediate = anyActiveStateChanged || !isAppActive
        if data == lastPayload && !anyActiveStateChanged {
            let now = Date()
            defaults.set(now.timeIntervalSince1970, forKey: savedAtEpochKey)
            let hasPendingTrailing = (trailingReloadWorkItem != nil)
            let neverReloadedThisPayload = (lastReloadedPayload != data)
            let becameActiveAfterBackgroundReload = (isAppActive && !lastReloadedWhileActive)
            let isPeriodicForceEnsure = (forceReload && now.timeIntervalSince(lastReloadAt) >= 15.0)
            let needsForceEnsureReload = hasPendingTrailing || (forceReload && (neverReloadedThisPayload || becameActiveAfterBackgroundReload || isPeriodicForceEnsure))
            if needsForceEnsureReload {
                lastLoggedSkipDedup = false
                if !isAppActive || forceReload {
                    defaults.synchronize()
                }
                SyncTraceLogger.shared.log(
                    hop: "W_WIDGET_SAVE",
                    ch: "widget_center",
                    act: "force_ensure_reload",
                    res: "ok",
                    rsn: !isAppActive ? "reload_immediate" : "reload_trailing",
                    stateRev: compositeRev,
                    meta: ["isAppActive": isAppActive]
                )
                scheduleTimelineReloadOnQueue(for: data, isAppActive: isAppActive, immediate: !isAppActive)
            } else if !lastLoggedSkipDedup {
                lastLoggedSkipDedup = true
                SyncTraceLogger.shared.log(
                    hop: "W_WIDGET_SAVE",
                    ch: "app_group",
                    act: "save",
                    res: "skip",
                    rsn: "skip_dedup",
                    stateRev: compositeRev
                )
            }
            return
        }
        lastLoggedSkipDedup = false
        lastPayload = data

        defaults.set(data, forKey: snapshotKey)
        defaults.set(Date().timeIntervalSince1970, forKey: savedAtEpochKey)
        if shouldReloadImmediate || forceReload {
            defaults.synchronize()
        }
        SyncTraceLogger.shared.log(
            hop: "W_WIDGET_SAVE",
            ch: "widget_center",
            act: "save_and_reload",
            res: "ok",
            rsn: shouldReloadImmediate ? "reload_immediate" : "reload_trailing",
            stateRev: compositeRev,
            meta: [
                "runningCount": timers.filter { $0.isRunning }.count,
                "isAppActive": isAppActive
            ]
        )
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

// MARK: - Issue #13: Watch & Widget 一気通貫トレースロガー（通信副作用ゼロ・UserDefaults不使用・全時刻Int64）
final class SyncTraceLogger {
    static let shared = SyncTraceLogger()

    private static let appGroup = "group.com.assisttimer"
    private static let watchLogFileName = "sync_trace_watch.jsonl"
    private static let widgetLogFileName = "sync_trace_widget.jsonl"
    private static let maxEntries = 220

    private let lock = NSLock()
    private var entries: [[String: Any]] = []
    private var nextSeq: Int = 0
    private var currentScene: String = "S1"
    private var cachedAppState: String = "unknown"
    private let sessionDevFallback: String

    private let ioQueue = DispatchQueue(label: "com.assisttimer.watch.synctrace", qos: .utility)
    private var persistWorkItem: DispatchWorkItem?

    private init() {
        self.sessionDevFallback = String(format: "w#%04x", UInt32.random(in: 0...0xFFFF))
        hydrateFromDiskAsync()
    }

    // MARK: - 4層完全共通ハッシュ ＆ PIIマスク

    static func fnv1a32HexUtf8(_ input: String) -> String {
        var hash: UInt32 = 0x811c9dc5
        for byte in input.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 0x01000193
        }
        return String(format: "%08x", hash)
    }

    static func normalizeStaffToken(_ raw: String?) -> String {
        guard let raw = raw, !raw.isEmpty else { return "" }
        let nfkc = raw.precomposedStringWithCompatibilityMapping
        let scalars = nfkc.unicodeScalars.filter { scalar in
            !CharacterSet.whitespacesAndNewlines.contains(scalar) && scalar.value != 0x3000 && scalar.value != 0xFEFF
        }
        return String(String.UnicodeScalarView(scalars)).lowercased()
    }

    static func maskStaff(_ raw: String?) -> String {
        let norm = normalizeStaffToken(raw)
        if norm.isEmpty { return "empty" }
        if norm == "未定" { return "unset" }
        if norm == "ヘルプなし" || norm == "none" { return "none" }
        if norm == "募集中" { return "recruit" }
        if norm == "スタイリスト" || norm == "スタッフ" { return "default_stylist" }
        let h = fnv1a32HexUtf8(norm)
        return "stf#" + String(h.prefix(4))
    }

    private static func isUuidLike(_ lower: String) -> Bool {
        let bytes = Array(lower.utf8)
        guard bytes.count >= 14, bytes[8] == 0x2d, bytes[13] == 0x2d else { return false }
        let isHex: (UInt8) -> Bool = { b in
            (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66)
        }
        for i in 0..<8 where !isHex(bytes[i]) { return false }
        for i in 9..<13 where !isHex(bytes[i]) { return false }
        return true
    }

    static func maskId(_ raw: String?, prefix: String = "") -> String {
        let s = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return "" }
        let lower = s.lowercased()
        if prefix == "u" || prefix == "s" {
            return "\(prefix)#\(String(lower.prefix(6)))"
        }
        if isUuidLike(lower) {
            let p = prefix.isEmpty ? "t" : prefix
            return "\(p)#\(String(lower.prefix(6)))"
        }
        return String(s.prefix(24))
    }

    static func maskToken(_ raw: String?) -> String {
        let s = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return "" }
        if let openIdx = s.firstIndex(of: "["),
           let closeIdx = s[openIdx...].firstIndex(of: "]"),
           openIdx < closeIdx {
            let inner = s[s.index(after: openIdx)..<closeIdx]
            return "tok#" + String(inner.suffix(4))
        }
        return "tok#" + String(s.suffix(4))
    }

    static func createTraceId(nowMs: Int64? = nil) -> String {
        let ms = nowMs ?? safeEpochMillisInt64(Date().timeIntervalSince1970 * 1000.0)
        let b36 = String(max(0, ms), radix: 36, uppercase: false)
        let r4 = String(format: "%04x", UInt32.random(in: 0...0xFFFF))
        return "tr_\(b36)_\(r4)"
    }

    // MARK: - 4層完全共通 stateRev 算出

    static func normalizeSeatKey(seatNumber: Int, seatLabel: String?) -> String {
        var lbl = (seatLabel ?? "").precomposedStringWithCompatibilityMapping
        lbl = lbl.replacingOccurrences(of: "(サンプル)", with: "")
                 .replacingOccurrences(of: "（サンプル）", with: "")
        let scalars = lbl.unicodeScalars.filter { scalar in
            !CharacterSet.whitespacesAndNewlines.contains(scalar) && scalar.value != 0x3000 && scalar.value != 0xFEFF
        }
        lbl = String(String.UnicodeScalarView(scalars))
        if lbl.hasSuffix("席") {
            lbl = String(lbl.dropLast())
        }
        if lbl.hasSuffix("番") {
            let stem = String(lbl.dropLast())
            if !stem.isEmpty && stem.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }) {
                lbl = stem
            }
        }
        lbl = lbl.lowercased()
        if !lbl.isEmpty,
           lbl.first != "0",
           lbl.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }),
           let n = Int(lbl), n > 0 {
            return "s\(n)"
        }
        if !lbl.isEmpty {
            return lbl
        }
        if seatNumber > 0 {
            return "s\(seatNumber)"
        }
        return "s0"
    }

    static func isCustomPostStopProcessLabel(_ rawProc: String?) -> Bool {
        let p = (rawProc ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return false }
        let lower = p.lowercased()
        return p != "シャンプー"
            && p != "ヘルプなし"
            && lower != "none"
            && p != "募集中"
            && p != "未定"
    }

    static func computeStateRevFromFields(
        seatNumber: Int,
        seatLabel: String?,
        isRunning: Bool,
        targetEndMs: Int64,
        pausedRemainingSeconds: Int = 0,
        hasActiveCheck: Bool,
        checkTargetEndMs: Int64,
        isPostStopProcessActive: Bool,
        assistToken: String?,
        checkToken: String?
    ) -> String {
        let seatKey = normalizeSeatKey(seatNumber: seatNumber, seatLabel: seatLabel)
        let runFlag = (isRunning && targetEndMs > 0) ? 1 : 0
        let pausedSec = (runFlag == 0) ? max(0, pausedRemainingSeconds) : 0
        let shampooFlag = (runFlag == 0 && pausedSec <= 0 && isPostStopProcessActive) ? 1 : 0
        let endBucket5s: Int64 = (runFlag == 1)
            ? Int64((Double(targetEndMs) / 5000.0).rounded(.toNearestOrAwayFromZero))
            : ((shampooFlag == 0 && pausedSec > 0) ? Int64(pausedSec) : 0)
        let chkFlag = (runFlag == 1 && hasActiveCheck && checkTargetEndMs > 0) ? 1 : 0
        let checkEndBucket5s: Int64 = (chkFlag == 1)
            ? Int64((Double(checkTargetEndMs) / 5000.0).rounded(.toNearestOrAwayFromZero))
            : 0
        let shouldKeepAssist = (runFlag == 1) || (shampooFlag == 1) || (pausedSec > 0)
        let assistMasked = shouldKeepAssist ? maskStaff(assistToken) : "empty"
        let checkMasked = (chkFlag == 1) ? maskStaff(checkToken) : "empty"
        let canonical = "\(seatKey)|\(runFlag)|\(endBucket5s)|\(chkFlag)|\(checkEndBucket5s)|\(shampooFlag)|\(assistMasked)|\(checkMasked)"
        return fnv1a32HexUtf8(canonical)
    }

    static func computeSeatStateRev(_ item: SeatTimerItem) -> String {
        let endMs: Int64 = item.isRunning
            ? safeEpochMillisInt64(item.targetEndTime.timeIntervalSince1970 * 1000.0)
            : 0
        let runFlag = item.isRunning && endMs > 0
        let pausedSec = !runFlag ? max(0, item.pausedRemainingSeconds) : 0
        let checkTot = item.checkTotalSeconds ?? 0
        let chkEndMs: Int64 = {
            guard runFlag, !item.isCheckCompleted, checkTot > 0, let d = item.checkTargetEndTime else { return 0 }
            return safeEpochMillisInt64(d.timeIntervalSince1970 * 1000.0)
        }()
        let hasCheck = runFlag && !item.isCheckCompleted && checkTot > 0 && chkEndMs > 0
        let isPostStopProcessActive = !runFlag && pausedSec <= 0 && (item.status != .normal || isCustomPostStopProcessLabel(item.helpProcess))
        let assistToken: String = {
            if item.isRecruiting { return "募集中" }
            if item.isNoHelpNeeded { return "ヘルプなし" }
            return item.shampooStaff ?? ""
        }()
        let checkToken = hasCheck ? (item.checkStaff ?? "") : ""
        return computeStateRevFromFields(
            seatNumber: item.seatNumber,
            seatLabel: item.displaySeatName,
            isRunning: runFlag,
            targetEndMs: endMs,
            pausedRemainingSeconds: pausedSec,
            hasActiveCheck: hasCheck,
            checkTargetEndMs: chkEndMs,
            isPostStopProcessActive: isPostStopProcessActive,
            assistToken: assistToken,
            checkToken: checkToken
        )
    }

    static func computeCloudRowStateRev(_ row: [String: Any]) -> String {
        let statusStr = (row["status"] as? String) ?? ""
        let rawEnd = (row["target_end_timestamp"] as? NSNumber)?.doubleValue
            ?? (row["target_end_timestamp"] as? Double)
            ?? 0
        let endMs = safeEpochMillisInt64(rawEnd)
        let isRunning = (statusStr == "running" && endMs > 0)
        let rawShampoo = (row["is_shampooing"] as? NSNumber)?.boolValue
            ?? (row["is_shampooing"] as? Bool)
            ?? false
        let rawPausedSec = max(0, (row["paused_remaining_seconds"] as? NSNumber)?.intValue ?? (row["paused_remaining_seconds"] as? Int) ?? 0)
        let pausedSec: Int = (!isRunning && statusStr == "paused" && rawPausedSec > 0)
            ? rawPausedSec
            : 0
        let checkTot = (row["check_total_seconds"] as? NSNumber)?.intValue
            ?? (row["check_total_seconds"] as? Int)
            ?? 0
        let rawChkEnd = (row["check_target_end_timestamp"] as? NSNumber)?.doubleValue
            ?? (row["check_target_end_timestamp"] as? Double)
            ?? 0
        let chkEndMs = safeEpochMillisInt64(rawChkEnd)
        let isCheckDone = (row["is_check_completed"] as? NSNumber)?.boolValue
            ?? (row["is_check_completed"] as? Bool)
            ?? false
        let hasCheck = isRunning && !isCheckDone && checkTot > 0 && chkEndMs > 0
        let rawHelpProc = (row["help_process"] as? String) ?? ""
        let isPostStopProcessActive = !isRunning && pausedSec <= 0 && (rawShampoo || isCustomPostStopProcessLabel(rawHelpProc))
        let assistToken = (row["assistant_staff_name"] as? String) ?? ""
        let checkToken = hasCheck ? ((row["check_staff_name"] as? String) ?? "") : ""
        let seatLabel = (row["seat_label"] as? String) ?? ""
        return computeStateRevFromFields(
            seatNumber: 0,
            seatLabel: seatLabel,
            isRunning: isRunning,
            targetEndMs: endMs,
            pausedRemainingSeconds: pausedSec,
            hasActiveCheck: hasCheck,
            checkTargetEndMs: chkEndMs,
            isPostStopProcessActive: isPostStopProcessActive,
            assistToken: assistToken,
            checkToken: checkToken
        )
    }

    static func computeCompositeStateRev(_ timers: [SeatTimerItem]) -> String {
        let regularSeats = timers.filter { !$0.isMainTimer }
        guard !regularSeats.isEmpty else { return "empty000" }
        let parts = regularSeats.map { item -> String in
            let key = normalizeSeatKey(seatNumber: item.seatNumber, seatLabel: item.displaySeatName)
            return "\(key):\(computeSeatStateRev(item))"
        }.sorted()
        return String(parts.joined(separator: ",").prefix(200))
    }

    static func formatSeatRef(seatNumber: Int, seatLabel: String?, id: String?) -> String {
        let key = normalizeSeatKey(seatNumber: seatNumber, seatLabel: seatLabel)
        let masked = maskId(id, prefix: "t")
        return masked.isEmpty ? key : "\(key)(\(masked))"
    }

    // MARK: - 状態管理・メモリ追記・App Groupファイル非同期永続化

    private func currentWatchAppState() -> String {
        if Thread.isMainThread {
            let txt: String
            switch WKApplication.shared().applicationState {
            case .active: txt = "active"
            case .inactive: txt = "inactive"
            case .background: txt = "background"
            @unknown default: txt = "unknown"
            }
            lock.lock()
            cachedAppState = txt
            lock.unlock()
            return txt
        }
        lock.lock()
        let snap = cachedAppState
        lock.unlock()
        return snap
    }

    func updateAppState(_ stateText: String) {
        lock.lock()
        cachedAppState = stateText
        lock.unlock()
    }

    func setScene(_ scene: String) {
        let clean = scene.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        lock.lock()
        currentScene = clean.isEmpty ? "S1" : clean
        lock.unlock()
    }

    func getScene() -> String {
        lock.lock()
        let s = currentScene
        lock.unlock()
        return s
    }

    private static let forbiddenPiiKeys: Set<String> = [
        "comment", "memo", "note", "customerName", "body", "title", "expoPushToken", "expo_push_token"
    ]

    private func sanitizeMetaValue(_ val: Any, key: String = "", depth: Int = 0) -> Any? {
        if val is NSNull { return nil }
        if let b = val as? Bool { return b }
        if let i = val as? Int { return i }
        if let i64 = val as? Int64 { return NSNumber(value: i64) }
        if let d = val as? Double { return d.isFinite ? d : nil }
        if let f = val as? Float { return f.isFinite ? Double(f) : nil }
        if let n = val as? NSNumber {
            if CFNumberIsFloatType(n) {
                let dv = n.doubleValue
                return dv.isFinite ? n : nil
            }
            return n
        }
        if let s = val as? String {
            let maxLen = key.lowercased().hasSuffix("rev") ? 200 : 96
            return s.count > maxLen ? String(s.prefix(maxLen)) + "…" : s
        }
        if depth >= 2 { return nil }
        if let arr = val as? [Any] {
            return arr.prefix(12).compactMap { sanitizeMetaValue($0, key: key, depth: depth + 1) }
        }
        if let dict = val as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, v) in dict.prefix(20) {
                if Self.forbiddenPiiKeys.contains(k) { continue }
                if let cv = sanitizeMetaValue(v, key: k, depth: depth + 1) {
                    out[k] = cv
                }
            }
            return out
        }
        return nil
    }

    private static func sanitizePlistValue(_ val: Any, key: String = "", depth: Int = 0) -> Any? {
        if val is NSNull { return nil }
        if let s = val as? String {
            let maxLen = (key == "stateRev" || key.lowercased().hasSuffix("rev")) ? 200 : 120
            return s.count > maxLen ? String(s.prefix(maxLen)) : s
        }
        if let b = val as? Bool { return b }
        if let i = val as? Int { return i }
        if let i64 = val as? Int64 { return NSNumber(value: i64) }
        if let d = val as? Double { return d.isFinite ? NSNumber(value: d) : nil }
        if let f = val as? Float { return f.isFinite ? NSNumber(value: Double(f)) : nil }
        if let n = val as? NSNumber {
            if CFNumberIsFloatType(n) {
                let dv = n.doubleValue
                return dv.isFinite ? n : nil
            }
            return n
        }
        if depth >= 3 { return nil }
        if let arr = val as? [Any] {
            return arr.prefix(20).compactMap { sanitizePlistValue($0, key: key, depth: depth + 1) }
        }
        if let dict = val as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, v) in dict {
                if forbiddenPiiKeys.contains(k) { continue }
                if let cv = sanitizePlistValue(v, key: k, depth: depth + 1) {
                    out[k] = cv
                }
            }
            return out
        }
        return nil
    }

    static func sanitizePlistDictionary(_ dict: [String: Any]) -> [String: Any]? {
        guard let cleaned = sanitizePlistValue(dict, depth: 0) as? [String: Any],
              !cleaned.isEmpty,
              PropertyListSerialization.propertyList(cleaned, isValidFor: .binary) else {
            return nil
        }
        return cleaned
    }

    func log(
        hop: String,
        ch: String = "",
        seat: String = "",
        act: String = "",
        res: String = "ok",
        rsn: String = "",
        traceId: String = "",
        stateRev: String = "",
        ms: Int? = nil,
        meta: [String: Any]? = nil
    ) {
        let wallMs = safeEpochMillisInt64(Date().timeIntervalSince1970 * 1000.0)
        let monoMs = Int64((ProcessInfo.processInfo.systemUptime * 1000.0).rounded())
        let appState = currentWatchAppState()
        let rawUid = WatchSessionManager.shared.cloudUserId
        let devId = rawUid.isEmpty ? sessionDevFallback : Self.maskId(rawUid, prefix: "u")

        var cleanMeta: [String: Any]? = nil
        if let meta = meta, let sanitized = sanitizeMetaValue(meta, key: "meta", depth: 0) as? [String: Any], !sanitized.isEmpty {
            cleanMeta = sanitized
        }

        lock.lock()
        nextSeq += 1
        var entry: [String: Any] = [
            "seq": nextSeq,
            "dev": devId,
            "layer": "watch_app",
            "wallMs": NSNumber(value: wallMs),
            "monoMs": NSNumber(value: monoMs),
            "scene": currentScene,
            "traceId": String(traceId.prefix(40)),
            "stateRev": String(stateRev.prefix(200)),
            "hop": hop,
            "ch": ch,
            "seat": String(seat.prefix(32)),
            "act": act,
            "res": res,
            "rsn": rsn,
            "appState": appState
        ]
        if let ms = ms {
            entry["ms"] = ms
        }
        if let cleanMeta = cleanMeta {
            entry["meta"] = cleanMeta
        }
        entries.append(entry)
        if entries.count > Self.maxEntries {
            entries.removeFirst(entries.count - Self.maxEntries)
        }
        lock.unlock()

        schedulePersist()
    }

    private static func containerFileURL(_ fileName: String) -> URL? {
        return FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent(fileName)
    }

    private func hydrateFromDiskAsync() {
        ioQueue.async { [weak self] in
            guard let self = self,
                  let url = Self.containerFileURL(Self.watchLogFileName),
                  let data = try? Data(contentsOf: url),
                  let text = String(data: data, encoding: .utf8) else { return }
            var loaded: [[String: Any]] = []
            for line in text.split(separator: "\n") {
                if let lData = line.data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: lData) as? [String: Any],
                   let safeObj = Self.sanitizePlistDictionary(obj) {
                    loaded.append(safeObj)
                }
            }
            guard !loaded.isEmpty else { return }
            self.lock.lock()
            let combined = Array((loaded + self.entries).suffix(Self.maxEntries))
            self.entries = combined.enumerated().map { idx, item in
                var copy = item
                copy["seq"] = idx + 1
                return copy
            }
            self.nextSeq = self.entries.count
            self.lock.unlock()
        }
    }

    private func schedulePersist() {
        ioQueue.async { [weak self] in
            guard let self = self else { return }
            if self.persistWorkItem != nil { return }
            let work = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                self.persistWorkItem = nil
                self.lock.lock()
                let snapshot = self.entries
                self.lock.unlock()
                guard let url = Self.containerFileURL(Self.watchLogFileName) else { return }
                var lines: [String] = []
                lines.reserveCapacity(snapshot.count)
                for item in snapshot {
                    if JSONSerialization.isValidJSONObject(item),
                       let d = try? JSONSerialization.data(withJSONObject: item),
                       let s = String(data: d, encoding: .utf8) {
                        lines.append(s)
                    }
                }
                let joined = lines.joined(separator: "\n")
                try? joined.data(using: .utf8)?.write(to: url, options: .atomic)
            }
            self.persistWorkItem = work
            self.ioQueue.asyncAfter(deadline: .now() + 1.2, execute: work)
        }
    }

    func clearAll(scene: String? = nil) {
        lock.lock()
        entries.removeAll()
        nextSeq = 0
        if let scene = scene, !scene.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            currentScene = scene.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        }
        let activeScene = currentScene
        lock.unlock()

        ioQueue.async { [weak self] in
            self?.persistWorkItem?.cancel()
            self?.persistWorkItem = nil
            if let wUrl = Self.containerFileURL(Self.watchLogFileName) {
                try? FileManager.default.removeItem(at: wUrl)
            }
            if let wgUrl = Self.containerFileURL(Self.widgetLogFileName) {
                try? FileManager.default.removeItem(at: wgUrl)
            }
        }

        log(hop: "W_SESSION_CLEAR", ch: "diag", act: activeScene, res: "ok", rsn: "cleared_from_phone")
    }

    func exportForPhonePull(maxBytes: Int = 28_000) -> [[String: Any]] {
        lock.lock()
        let watchSnapshot = entries.compactMap { Self.sanitizePlistDictionary($0) }
        lock.unlock()

        var widgetEntries: [[String: Any]] = []
        if let wgUrl = Self.containerFileURL(Self.widgetLogFileName),
           let data = try? Data(contentsOf: wgUrl),
           let text = String(data: data, encoding: .utf8) {
            for line in text.split(separator: "\n") {
                if let lData = line.data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: lData) as? [String: Any],
                   let safeObj = Self.sanitizePlistDictionary(obj) {
                    widgetEntries.append(safeObj)
                }
            }
        }

        let merged = (watchSnapshot + widgetEntries).sorted { a, b in
            let wa = (a["wallMs"] as? NSNumber)?.int64Value ?? 0
            let wb = (b["wallMs"] as? NSNumber)?.int64Value ?? 0
            if wa != wb { return wa < wb }
            let sa = (a["seq"] as? NSNumber)?.intValue ?? 0
            let sb = (b["seq"] as? NSNumber)?.intValue ?? 0
            return sa < sb
        }

        var selectedReversed: [[String: Any]] = []
        var usedBytes = 0
        for item in merged.reversed() {
            guard PropertyListSerialization.propertyList(item, isValidFor: .binary),
                  JSONSerialization.isValidJSONObject(item),
                  let d = try? JSONSerialization.data(withJSONObject: item) else { continue }
            let itemBytes = d.count + 8
            if usedBytes + itemBytes > maxBytes {
                break
            }
            usedBytes += itemBytes
            selectedReversed.append(item)
        }
        return selectedReversed.reversed()
    }
}
