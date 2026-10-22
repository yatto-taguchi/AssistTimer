import Foundation
import SwiftUI
import WatchKit
import UserNotifications

// MARK: - タイムアップのアラーム（止めるまで鳴り続ける）
//
// ・本命: スマートアラーム（WKExtendedRuntimeSession の start(at:) ＋ notifyUser）
//     終了時刻になると、画面が暗くても・手首を下ろしていても、システムのアラーム画面を出して
//     ユーザーが止めるまで振動を繰り返す。
//     ※ start(at:) はアプリ表示中にしか予約できず、同時に1件まで → 一番早い予定を予約する
//     ※ 鳴っている予定のセッションは絶対に取り消さない（Build 38 の不具合: 0秒到達時にアプリ表示中だと
//        「未来の予定がない」と判断して開始直前のセッションを取り消していた → 画面が暗くなると振動が止まった）
//     ※ アプリ表示中に鳴動中なのにセッションが無い場合は、その場で1秒後開始のセッションを予約して引き継ぐ
// ・アプリ表示中: 上記に加えて、0.5秒ごとの強い振動（.notification / .failure / .retry）を重ねる
// ・予備: ローカル通知（終了時刻＋0〜120秒の繰り返し）
//
// Watch 側で止めた時は iPhone へ STOP_ALARM を送り、iPhone 側で鳴っている同じ席のアラームも止める。

struct WatchAlarmEvent: Equatable {
    let key: String      // "<席ID>-main@<終了時刻(秒)>" / "<席ID>-check@<終了時刻(秒)>"
    let seatId: String
    let date: Date
    let title: String
}

final class WatchAlarmCoordinator: NSObject, ObservableObject, WKExtendedRuntimeSessionDelegate, UNUserNotificationCenterDelegate {
    static let shared = WatchAlarmCoordinator()

    @Published private(set) var ringing: [WatchAlarmEvent] = []
    // 診断パネル用
    @Published private(set) var statusText: String = "予約なし"

    private var events: [WatchAlarmEvent] = []
    // 「終了前に一度でも把握していた」予定（アプリ起動時点ですでに過ぎていた古い予定では鳴らさない）
    private var armed: [String: Double] = [:]
    // 止めた予定
    private var acknowledged: [String: Double] = [:]
    private var soundOn = false

    private var session: WKExtendedRuntimeSession?
    private var sessionKey: String?
    private var sessionStarted = false
    private var invalidatingSessions: Set<WKExtendedRuntimeSession> = []
    // スマートアラームが一度鳴動開始→終了したキー（チェックタイマー閉じた後に本体タイマーのスマートアラームへ確実に引き継ぐ）
    private var smartAlarmCompletedKeys: Set<String> = []
    private var lastSessionEnd: String = "-"
    private var notificationAuth: String = "?"

    private var notificationSignature = ""
    private var authRequested = false
    private var hapticStep = 0
    private var hapticTimer: Timer?

    private let armedStoreKey = "assisttimer.alarm.armed"
    private let ackStoreKey = "assisttimer.alarm.ack"
    private let notificationPrefix = "assisttimer.alarm."
    // ★ 高密度連続TimeSensitive通知オフセット（0秒から5秒・10秒おきに連続投入し、画面オフでも確実に気づけるようにする）
    private let repeatOffsets: [TimeInterval] = [0, 5, 10, 15, 20, 25, 30, 45, 60, 90, 120, 180]
    private let maxNotifications = 60 // watchOS の保留通知上限（64件）未満に抑える
    // 強めに感じる触覚を交互に鳴らす（最も強烈な .failure と .notification を高密度連打）
    private let strongHaptics: [WKHapticType] = [.failure, .notification, .failure, .retry]

    override init() {
        super.init()
        armed = (UserDefaults.standard.dictionary(forKey: armedStoreKey) as? [String: Double]) ?? [:]
        acknowledged = (UserDefaults.standard.dictionary(forKey: ackStoreKey) as? [String: Double]) ?? [:]
        // ★ アプリ起動時（TestFlight更新後や再起動時）に、すでに終了時刻を過ぎている古い予約が残っていれば
        //   すべて消火済み（acknowledged）として扱い、アプリを開いた瞬間に過去のバイブレーションが暴発するのを確実に防ぐ
        let launchCutoff = Date().timeIntervalSince1970
        var staleKeys: [String] = []
        for (key, ts) in armed where ts <= launchCutoff && acknowledged[key] == nil {
            acknowledged[key] = ts
            staleKeys.append(key)
        }
        if !staleKeys.isEmpty {
            persist()
            let staleNotifIds = staleKeys.flatMap { k in repeatOffsets.indices.map { "\(notificationPrefix)\(k).\($0)" } }
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: staleNotifIds)
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: staleNotifIds)
        }
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        let stopAction = UNNotificationAction(identifier: "STOP_ACTION", title: "アラーム停止", options: [.foreground])
        let category = UNNotificationCategory(identifier: "ALARM_CATEGORY", actions: [stopAction], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([category])
        UNUserNotificationCenter.current().delegate = self
        requestAuthorizationIfNeeded()
    }

    // MARK: - 外部から呼ぶ

    /// 席データが変わった時（iPhoneからの受信・Watchでの操作）に呼ぶ。バックグラウンドでも可。
    func update(timers: [SeatTimerItem], mainTimer: SeatTimerItem? = nil, soundOn: Bool, currentUserName: String? = nil) {
        self.soundOn = soundOn
        var list: [WatchAlarmEvent] = []
        let nowDate = Date()
        var ackChanged = false

        let shouldKeepEvent: (String, Date) -> Bool = { [weak self] key, targetDate in
            guard let self = self else { return false }
            // ★ カウントダウン中（終了予定時刻が未来）の予定のみを新規監視対象とする
            if targetDate > nowDate { return true }
            // すでに終了時刻に達している予定は「終了前にカウントダウン中として arm 済み＆未停止」の場合のみ保持
            guard self.isArmed(key) && !self.isAcknowledged(key) else { return false }
            if targetDate > nowDate.addingTimeInterval(-30) { return true }
            return self.ringing.contains { self.isSameTarget(key1: $0.key, key2: key) }
        }

        // ★ 稼働中タイマーをアラーム対象とする。
        //   0秒到達直後にiPhoneから超過状態（isOvertime == true）の同期が届いても、
        //   すでに arm 済みかつ未消火（!isAcknowledged）のイベントは絶対に一覧から消さず、止めるまで振動を継続させる！
        if let m = mainTimer, m.isRunning, !m.isPreCountingDown {
            let mainEpoch = Int(m.targetEndTime.timeIntervalSince1970)
            let mainKey = "\(m.id)-main@\(mainEpoch)"
            if shouldKeepEvent(mainKey, m.targetEndTime) {
                list.append(WatchAlarmEvent(
                    key: mainKey,
                    seatId: m.id,
                    date: m.targetEndTime,
                    title: "⏱️ メインタイマー 終了"
                ))
            }
        }
        for t in timers where t.isRunning {
            let label = t.displaySeatName
            let mainEpoch = Int(t.targetEndTime.timeIntervalSince1970)
            let mainKey = "\(t.id)-main@\(mainEpoch)"
            if shouldKeepEvent(mainKey, t.targetEndTime) {
                list.append(WatchAlarmEvent(
                    key: mainKey,
                    seatId: t.id,
                    date: t.targetEndTime,
                    title: "\(label) タイム終了"
                ))
            }
            if !t.isCheckCompleted, let checkEnd = t.checkTargetEndTime, (t.checkTotalSeconds ?? 0) > 0 {
                let checkEpoch = Int(checkEnd.timeIntervalSince1970)
                let checkKey = "\(t.id)-check@\(checkEpoch)"
                // ★ 本体タイマーがすでに終了時刻（0:00）に到達している場合、未消火のチェックタイマーが本体アラームを塞がないよう自動で引き継ぐ
                if t.targetEndTime <= nowDate && checkEnd < t.targetEndTime {
                    if !isAcknowledged(checkKey) {
                        acknowledged[checkKey] = checkEnd.timeIntervalSince1970
                        ackChanged = true
                    }
                } else if shouldKeepEvent(checkKey, checkEnd) {
                    list.append(WatchAlarmEvent(
                        key: checkKey,
                        seatId: t.id,
                        date: checkEnd,
                        title: "\(label) チェック時間"
                    ))
                }
            }
        }
        if ackChanged { persist() }
        events = list
        refresh()
    }

    /// アプリ表示中に1秒ごとに呼ぶ
    func tick() {
        refresh()
    }

    /// 「止める」ボタン
    func stop() {
        acknowledgeRinging(sendToPhone: true)
        stopForegroundHaptics()
        if session != nil {
            invalidateCurrentSession()
        }
        refresh()
    }

    /// アプリが表示状態になった時（スマートアラームの予約・通知の許可確認はこの時しかできない）
    func appBecameActive() {
        requestAuthorizationIfNeeded()
        refreshNotificationAuth()
        refresh()
    }

    /// アプリ終了中にスマートアラームの時刻になり、システムがアプリを起動した時
    func adopt(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        DispatchQueue.main.async {
            extendedRuntimeSession.delegate = self
            self.session = extendedRuntimeSession
            self.sessionKey = nil
            self.sessionStarted = (extendedRuntimeSession.state == .running)
            self.refresh()
            if let s = self.session, s === extendedRuntimeSession, self.sessionStarted, !self.ringing.isEmpty {
                self.sessionKey = self.ringing.last?.key
                self.startNotifyUser(s)
            } else if self.session === extendedRuntimeSession && (self.sessionStarted || self.sessionKey == nil) && self.ringing.isEmpty {
                self.invalidateCurrentSession()
            }
            self.updateStatusText()
        }
    }

    // MARK: - 内部処理

    private var isAppActive: Bool {
        return WKApplication.shared().applicationState == .active
    }

    /// スマートアラーム（WKExtendedRuntimeSession）はフォアグラウンド（active または inactive）の状態で予約可能
    private var canScheduleSmartAlarm: Bool {
        let state = WKApplication.shared().applicationState
        return state == .active || state == .inactive
    }

    private func isArmed(_ key: String) -> Bool {
        if armed[key] != nil { return true }
        return armed.keys.contains { isSameTarget(key1: $0, key2: key) }
    }

    private func isAcknowledged(_ key: String) -> Bool {
        if acknowledged[key] != nil { return true }
        return acknowledged.keys.contains { isSameTarget(key1: $0, key2: key) }
    }

    private func isSmartAlarmCompleted(_ key: String) -> Bool {
        if smartAlarmCompletedKeys.contains(key) { return true }
        return smartAlarmCompletedKeys.contains { isSameTarget(key1: $0, key2: key) }
    }

    private func currentRinging(_ now: Date) -> [WatchAlarmEvent] {
        return events.filter { $0.date <= now && isArmed($0.key) && !isAcknowledged($0.key) }
    }

    // そのキーの予定が「時刻到達済み」または「止めた・消えた」か
    private func isKeyDueOrDone(_ key: String?) -> Bool {
        guard let key = key else { return true }
        if isAcknowledged(key) { return true }
        guard let ev = events.first(where: { isSameTarget(key1: $0.key, key2: key) }) else { return true }
        return ev.date <= Date()
    }

    // ★ 2つのイベントキーが実質的に同一ターゲット（同一席・同一種別、かつ時刻差が2秒以内）か判定
    private func isSameTarget(key1: String?, key2: String?) -> Bool {
        guard let k1 = key1, let k2 = key2 else { return false }
        if k1 == k2 { return true }
        let parts1 = k1.components(separatedBy: "@")
        let parts2 = k2.components(separatedBy: "@")
        guard parts1.count == 2, parts2.count == 2, parts1[0] == parts2[0] else { return false }
        if let epoch1 = Int(parts1[1]), let epoch2 = Int(parts2[1]), abs(epoch1 - epoch2) <= 2 {
            return true
        }
        return false
    }

    private func refresh() {
        let now = Date()
        var changed = false
        // ★ タイマーの前提: 終了予定時刻が現在より未来（e.date > now、カウントダウン進行中）のイベントのみを arm 対象とする。
        //   すでに終了時刻を過ぎている（<= now）イベントを後から受信しても絶対に arm せず、起動時や同期時の誤振動を防ぐ。
        for e in events where !isArmed(e.key) && e.date > now {
            armed[e.key] = e.date.timeIntervalSince1970
            changed = true
        }
        // ★ 同一席で本体タイマー（-main）が時刻到達した場合、古い未消火のチェックタイマー（-check）を自動的に完了扱いにして
        //   2回目の本体タイマーのアラーム・振動へ確実に切り替える
        for mainEv in events where mainEv.key.contains("-main@") && mainEv.date <= now && isArmed(mainEv.key) && !isAcknowledged(mainEv.key) {
            for checkEv in events where checkEv.seatId == mainEv.seatId && checkEv.key.contains("-check@") && !isAcknowledged(checkEv.key) {
                acknowledged[checkEv.key] = checkEv.date.timeIntervalSince1970
                changed = true
            }
        }
        if prune(now) { changed = true }
        if changed { persist() }

        // ★ 稼働中のイベントが0件の場合、残留しているゴーストアラーム・保留通知を完全消火
        if events.isEmpty && !ringing.isEmpty {
            let ids = ringing.flatMap { k in repeatOffsets.indices.map { "\(notificationPrefix)\(k.key).\($0)" } }
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids)
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
            ringing = []
            stopForegroundHaptics()
            invalidateCurrentSession()
        }

        let newRinging = currentRinging(now)
        let hasNewRingingEvent = newRinging.contains { nr in
            !ringing.contains(where: { isSameTarget(key1: $0.key, key2: nr.key) })
        }
        if newRinging != ringing {
            // 鳴っていたのに消えた予定（相手が止めた・完了した・時間を再設定/延長した）があれば消火済み記録＆保留・配信通知も即座に消火
            let removedEvents = ringing.filter { r in !newRinging.contains(where: { isSameTarget(key1: $0.key, key2: r.key) }) }
            if !removedEvents.isEmpty {
                for ev in removedEvents {
                    acknowledged[ev.key] = ev.date.timeIntervalSince1970
                }
                persist()
                let ids = removedEvents.flatMap { ev in repeatOffsets.indices.map { "\(notificationPrefix)\(ev.key).\($0)" } }
                UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids)
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
            }
            ringing = newRinging
        }

        // ★ 新しいアラーム（チェック後の本体タイマー等）が鳴動開始した瞬間、フォアグラウンド振動とスマートアラームを即座に再トリガー
        if hasNewRingingEvent {
            stopForegroundHaptics()
            if let s = session, sessionStarted, let latest = newRinging.last, !isSameTarget(key1: sessionKey, key2: latest.key) {
                sessionKey = latest.key
                startNotifyUser(s)
            }
        }

        // 鳴っている予定または予約中の予定が相手によって止められた・席が終了した・鳴動対象が空になった → アラームを即時消火
        // （★ isSameTarget により、通信時のミリ秒丸め誤差（±2秒）による誤消火を確実に防止）
        if session != nil {
            let keyInvalid = (sessionKey != nil && (!events.contains { isSameTarget(key1: $0.key, key2: sessionKey) } || isAcknowledged(sessionKey!)))
            let noEventsAtAll = events.isEmpty && ringing.isEmpty
            let runningWithoutRinging = sessionStarted && ringing.isEmpty
            let orphanWithoutRinging = (sessionKey == nil) && ringing.isEmpty
            if keyInvalid || noEventsAtAll || runningWithoutRinging || orphanWithoutRinging {
                invalidateCurrentSession()
            }
        }

        scheduleSmartAlarmIfPossible(now)
        updateForegroundHaptics()
        rescheduleNotifications(now)
        updateStatusText()
    }

    private func acknowledgeRinging(sendToPhone: Bool) {
        let now = Date()
        let targets = currentRinging(now)
        guard !targets.isEmpty else {
            if !ringing.isEmpty { ringing = [] }
            return
        }
        for e in targets {
            acknowledged[e.key] = e.date.timeIntervalSince1970
        }
        persist()
        let ids = targets.flatMap { e in repeatOffsets.indices.map { "\(notificationPrefix)\(e.key).\($0)" } }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
        ringing = []
        if sendToPhone {
            // ★ 放置タイム終了のアラーム（main）を止めたら、その席のタイマーも停止（0:00）にする。
            //   チェック時間のアラームはチェック完了（completed）にして音・振動を止める（全体タイマーは続行）。
            let mainSeatIds = Set(targets.filter { $0.key.contains("-main@") }.map { $0.seatId })
            let seatIds = Set(targets.map { $0.seatId })
            for id in seatIds {
                let isMainTimer = (id == "main-timer" || id == WatchSessionManager.shared.mainTimer?.id)
                if isMainTimer {
                    // ★ メインタイマーのアラーム消火: メインタイマーのみを安全にリセットし、客席タイマーには絶対に触れない！
                    if var m = WatchSessionManager.shared.mainTimer {
                        m.isRunning = false
                        m.isPreCountingDown = false
                        m.preCountdownSeconds = 0
                        m.prepEndTime = nil
                        m.pausedRemainingSeconds = m.totalSeconds
                        WatchSessionManager.shared.mainTimer = m
                        WidgetSync.save(timers: WatchSessionManager.shared.timers, mainTimer: m, userName: WatchSessionManager.shared.currentUserName)
                    }
                    // MAIN_TIMER_RESET 1本に統合（iPhone側でアラーム消火とタイマーリセットの両方を即時実行し、時間差の二重リセットを防止）
                    WatchSessionManager.shared.sendMainTimerAction(action: "MAIN_TIMER_RESET")
                } else {
                    // ★ サロン客席タイマーのアラーム消火
                    let isMain = mainSeatIds.contains(id)
                    var extra: [String: Any] = ["kind": isMain ? "main" : "check"]
                    if isMain, let mainEvent = targets.first(where: { $0.seatId == id && $0.key.contains("-main@") }) {
                        // 鳴っていたタイマーの終了時刻。iPhone は席の終了時刻と照合し、別のタイマーなら止めない
                        extra["expectedEnd"] = mainEvent.date.timeIntervalSince1970 * 1000.0
                        WatchSessionManager.shared.applyLocalStop(seatId: id)
                    } else if !isMain {
                        // チェック時間アラームの停止: Watch側でも即座にチェック完了を反映
                        WatchSessionManager.shared.applyLocalCheckComplete(seatId: id)
                    }
                    WatchSessionManager.shared.sendActionToPhone(
                        action: "STOP_ALARM",
                        seatId: id,
                        extra: extra
                    )
                }
            }
        }
    }

    private func clearSession() {
        session = nil
        sessionKey = nil
        sessionStarted = false
    }

    private func invalidateCurrentSession() {
        guard let s = session else { return }
        let current = s
        clearSession()
        invalidatingSessions.insert(current)
        current.invalidate()
    }

    // 古い記録（12時間以上前）を削除
    private func prune(_ now: Date) -> Bool {
        let limit = now.timeIntervalSince1970 - 12 * 3600
        let beforeA = armed.count
        let beforeK = acknowledged.count
        armed = armed.filter { $0.value >= limit }
        acknowledged = acknowledged.filter { $0.value >= limit }
        return beforeA != armed.count || beforeK != acknowledged.count
    }

    private func persist() {
        UserDefaults.standard.set(armed, forKey: armedStoreKey)
        UserDefaults.standard.set(acknowledged, forKey: ackStoreKey)
    }

    private func updateStatusText() {
        let smart: String
        if sessionStarted {
            smart = "鳴動中"
        } else if let s = session, s.state == .scheduled || s.state == .notStarted {
            if let key = sessionKey, let ev = events.first(where: { $0.key == key }) {
                let f = DateFormatter()
                f.dateFormat = "HH:mm:ss"
                smart = "予約 \(f.string(from: ev.date))"
            } else {
                smart = "予約あり"
            }
        } else {
            smart = "予約なし"
        }
        let text = "スマートアラーム:\(smart) / 鳴動\(ringing.count)件 / 通知:\(notificationAuth) / 音:\(soundOn ? "ON" : "OFF") / 前回終了:\(lastSessionEnd)"
        if text != statusText { statusText = text }
    }

    // MARK: - アプリ表示中の強い振動（0.3秒ごとの超高速マックス連打）

    private func updateForegroundHaptics() {
        let shouldVibrate = !ringing.isEmpty && isAppActive
        if shouldVibrate {
            guard hapticTimer == nil else { return }
            playNextHaptic()
            let t = Timer(timeInterval: 0.3, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                if self.ringing.isEmpty || !self.isAppActive {
                    self.stopForegroundHaptics()
                    return
                }
                self.playNextHaptic()
            }
            RunLoop.main.add(t, forMode: .common)
            hapticTimer = t
        } else {
            stopForegroundHaptics()
        }
    }

    private func playNextHaptic() {
        let type = strongHaptics[hapticStep % strongHaptics.count]
        hapticStep += 1
        WKInterfaceDevice.current().play(type)
    }

    private func stopForegroundHaptics() {
        hapticTimer?.invalidate()
        hapticTimer = nil
    }

    // MARK: - スマートアラーム（WKExtendedRuntimeSession）

    private func scheduleSmartAlarmIfPossible(_ now: Date) {
        // 鳴動中のセッションには触らない
        if sessionStarted { return }
        if let s = session, s.state == .invalid { clearSession() }

        // ★ 時刻到達済み（＝まもなく開始する／開始処理中）の予定のセッションは絶対に取り消さない
        if session != nil, let key = sessionKey, !isAcknowledged(key),
           let ev = events.first(where: { isSameTarget(key1: $0.key, key2: key) }), ev.date <= now.addingTimeInterval(2) {
            return
        }

        // 鳴動中なのにセッションが無い（アプリを開いた時点で過ぎていた等）→ 0.2秒後開始で即時予約し、
        // 画面が暗くなっても止めるまで鳴り続けるようにする。
        // ただし既にスマートアラームが一通り鳴って閉じた予定（smartAlarmCompletedKeys）は除外し、次の本体タイマーの予約を優先する！
        let target: WatchAlarmEvent?
        let startDate: Date
        let isImmediateRinging: Bool
        if let r = currentRinging(now).first(where: { !isSmartAlarmCompleted($0.key) }) {
            // 即時鳴動セッションの開始はフォアグラウンド表示中のみ許可
            guard canScheduleSmartAlarm else { return }
            target = r
            startDate = now.addingTimeInterval(0.2)
            isImmediateRinging = true
        } else if let n = events
            .filter({ $0.date > now && !isAcknowledged($0.key) })
            .min(by: { $0.date < $1.date }) {
            target = n
            startDate = n.date
            isImmediateRinging = false
        } else {
            target = nil
            startDate = now
            isImmediateRinging = false
        }

        if let s = session, isSameTarget(key1: sessionKey, key2: target?.key), s.state == .scheduled || s.state == .notStarted {
            return // 予約済み
        }

        // ★ 既存の別予定セッションがある場合：
        //    画面消灯中（バックグラウンド）は新規予約が不可能なため、既存セッションを絶対に破棄せず保護する！
        if session != nil {
            guard canScheduleSmartAlarm else { return }
            invalidateCurrentSession()
        }

        guard let t = target, startDate.timeIntervalSince(now) < 36 * 3600 else { return }
        if isImmediateRinging {
            guard canScheduleSmartAlarm else { return }
        }

        // ★ 画面がついている今この瞬間、または前セッション終了直後の遷移枠で最速新規予約
        let s = WKExtendedRuntimeSession()
        s.delegate = self
        s.start(at: startDate)
        session = s
        sessionKey = t.key
        sessionStarted = false
    }

    // 止めるまで強い振動を繰り返す（アプリ非表示時はシステムのアラーム画面になる）
    private func startNotifyUser(_ s: WKExtendedRuntimeSession) {
        let types = strongHaptics
        var step = 0
        s.notifyUser(hapticType: .failure) { next in
            step += 1
            next.pointee = types[step % types.count]
            return 0.4 // ★ 0.8秒から0.4秒へ半減！止めるまで手首が激しく揺れ続けるマックス振動！
        }
    }

    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        DispatchQueue.main.async {
            guard extendedRuntimeSession === self.session else {
                extendedRuntimeSession.invalidate()
                return
            }
            self.sessionStarted = true
            self.lastSessionEnd = "-"
            self.refresh()
            // ★ 実際にタイムアップして鳴動中（!ringing.isEmpty）の時だけ振動を開始する。
            //   まだ終了していない・すでに止められた・鳴動対象がない場合は即座にセッションを破棄し、誤振動を完全防止！
            if !self.ringing.isEmpty, let s = self.session, s === extendedRuntimeSession {
                self.sessionKey = self.ringing.last?.key ?? self.sessionKey
                self.startNotifyUser(s)
            } else {
                self.invalidateCurrentSession()
            }
        }
    }

    func extendedRuntimeSessionWillExpire(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        // 30分の上限が近い。通知（予備）は別途予約済みなので何もしない
    }

    func extendedRuntimeSession(_ extendedRuntimeSession: WKExtendedRuntimeSession,
                                didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason,
                                error: Error?) {
        DispatchQueue.main.async {
            let wasInvalidating = self.invalidatingSessions.remove(extendedRuntimeSession) != nil
            let isCurrent = (extendedRuntimeSession === self.session)
            guard wasInvalidating || isCurrent else { return }

            let wasStarted = self.sessionStarted && isCurrent
            let endedKey = self.sessionKey
            if isCurrent {
                self.clearSession()
            }
            self.lastSessionEnd = self.reasonText(reason, error: error)
            if wasStarted, let k = endedKey {
                // ★ 一度鳴動開始して閉じたスマートアラームを記録し、次回予約で本体タイマー（2回目）へ確実に移行させる
                self.smartAlarmCompletedKeys.insert(k)
            }
            // システムのアラーム画面で「停止」が押された → 止めた扱いにして iPhone にも伝える
            if wasStarted && reason == WKExtendedRuntimeSessionInvalidationReason.none {
                self.acknowledgeRinging(sendToPhone: true)
            }
            // ★ 前セッション破棄完了後、残っている次の予定（本タイマーなど）を確実に再スケジュール！
            self.refresh()
        }
    }

    private func reasonText(_ reason: WKExtendedRuntimeSessionInvalidationReason, error: Error?) -> String {
        let base: String
        switch reason {
        case .none: base = "停止"
        case .sessionInProgress: base = "他セッション実行中"
        case .expired: base = "時間切れ"
        case .resignedFrontmost: base = "前面喪失"
        case .error: base = "エラー"
        case .suppressedBySystem: base = "システム抑制"
        @unknown default: base = "不明"
        }
        if let e = error { return "\(base)(\(e.localizedDescription))" }
        return base
    }

    // MARK: - ローカル通知（予備）

    private func requestAuthorizationIfNeeded() {
        guard !authRequested else { return }
        authRequested = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { [weak self] _, _ in
            self?.refreshNotificationAuth()
        }
    }

    private func refreshNotificationAuth() {
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            let text: String
            switch settings.authorizationStatus {
            case .authorized: text = "許可"
            case .denied: text = "拒否"
            case .notDetermined: text = "未確認"
            case .provisional: text = "仮許可"
            case .ephemeral: text = "一時"
            @unknown default: text = "不明"
            }
            DispatchQueue.main.async {
                self?.notificationAuth = text
                self?.updateStatusText()
            }
        }
    }

    private func rescheduleNotifications(_ now: Date) {
        let lastOffset = repeatOffsets.last ?? 0
        // 繰り返し通知がまだ残っている予定（鳴動中の予定も含める：鳴った瞬間に繰り返し分を消さないため）
        let targets = events
            .filter { $0.date.addingTimeInterval(lastOffset) > now && !isAcknowledged($0.key) }
            .sorted { $0.date < $1.date }
        let signature = targets.map { $0.key }.joined(separator: "|")
        guard signature != notificationSignature else { return }
        notificationSignature = signature

        let offsets = repeatOffsets
        let prefix = notificationPrefix
        let limit = maxNotifications
        let center = UNUserNotificationCenter.current()

        // ★ 1. 即座に（同期的に）すべてのターゲット通知を usernoted へ投入！
        //    非同期ブロックの内側に置くと、手首を下げた瞬間にアプリが中断され通知が登録されない致命的バグを防止
        var count = 0
        var newIdentifiers = Set<String>()
        for e in targets {
            for (i, offset) in offsets.enumerated() {
                if count >= limit { break }
                let interval = e.date.addingTimeInterval(offset).timeIntervalSinceNow
                // すでに過ぎたリピートオフセットを大量に1秒後へ同時登録するとwatchOSの通知スパム抑制に引っかかるため、
                // 初回(i==0)の直近5秒以内のみ即時発火を 허용し、それ以外は未来のオフセットのみ登録する
                if i == 0 {
                    if interval < -5 { continue }
                } else {
                    if interval < 0.5 { continue }
                }
                let id = "\(prefix)\(e.key).\(i)"
                newIdentifiers.insert(id)

                let content = UNMutableNotificationContent()
                content.title = "⏰ \(e.title)"
                content.body = i == 0
                    ? "タイムアップです。アプリを開いて止めてください。"
                    : "まだ止められていません（\(Int(offset))秒経過）"
                // ★ watchOS では content.sound を指定しないと触覚（Taptic Engine）の振動が一切鳴らない。
                //   消音モード時はシステム側で自動的に「振動のみ」となるため、常に .default を指定して振動を保証する。
                content.sound = .default
                content.interruptionLevel = .timeSensitive
                content.categoryIdentifier = "ALARM_CATEGORY"
                // ★ チェックタイマーと本体タイマーが同一スレッドにまとめられて2回目の振動が抑制されるのを防ぐためイベント別に分離
                content.threadIdentifier = "assisttimer.alarm.\(e.key)"
                let triggerInterval = max(1, interval)
                let trigger = UNTimeIntervalNotificationTrigger(timeInterval: triggerInterval, repeats: false)
                center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
                count += 1
            }
        }

        // ★ 2. 不要になった古い通知IDのみ非同期で掃除（新規予約の登録をブロック・遅延させない）
        center.getPendingNotificationRequests { requests in
            let stale = requests.map(\.identifier).filter { $0.hasPrefix(prefix) && !newIdentifiers.contains($0) }
            if !stale.isEmpty {
                center.removePendingNotificationRequests(withIdentifiers: stale)
            }
        }
    }

    // アプリ表示中は画面のアラーム表示＋振動で知らせるので通知バナーは出さない
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        DispatchQueue.main.async {
            self.refresh()
            if WKApplication.shared().applicationState == .active {
                completionHandler([])
            } else {
                completionHandler([.banner, .sound, .list])
            }
        }
    }

    // ★ 通知タップまたは「アラーム停止」ボタン押下時に即座にアラーム消火＆iPhone同期
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async {
            self.stop()
            completionHandler()
        }
    }
}
