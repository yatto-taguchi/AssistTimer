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
    // 強めに感じる触覚を交互に鳴らす
    private let strongHaptics: [WKHapticType] = [.notification, .failure, .retry]

    override init() {
        super.init()
        armed = (UserDefaults.standard.dictionary(forKey: armedStoreKey) as? [String: Double]) ?? [:]
        acknowledged = (UserDefaults.standard.dictionary(forKey: ackStoreKey) as? [String: Double]) ?? [:]
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
        if let m = mainTimer, m.isRunning {
            let mainEpoch = Int(m.targetEndTime.timeIntervalSince1970)
            list.append(WatchAlarmEvent(
                key: "\(m.id)-main@\(mainEpoch)",
                seatId: m.id,
                date: m.targetEndTime,
                title: "⏱️ メインタイマー 終了"
            ))
        }
        for t in timers where t.isRunning {
            let label = t.displaySeatName
            let mainEpoch = Int(t.targetEndTime.timeIntervalSince1970)
            list.append(WatchAlarmEvent(
                key: "\(t.id)-main@\(mainEpoch)",
                seatId: t.id,
                date: t.targetEndTime,
                title: "\(label) タイム終了"
            ))
            if !t.isCheckCompleted, let checkEnd = t.checkTargetEndTime, (t.checkTotalSeconds ?? 0) > 0 {
                let checkEpoch = Int(checkEnd.timeIntervalSince1970)
                list.append(WatchAlarmEvent(
                    key: "\(t.id)-check@\(checkEpoch)",
                    seatId: t.id,
                    date: checkEnd,
                    title: "\(label) チェック時間"
                ))
            }
        }
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
        if session != nil, sessionStarted || sessionKey == nil || isKeyDueOrDone(sessionKey) {
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
        extendedRuntimeSession.delegate = self
        session = extendedRuntimeSession
        sessionKey = nil
        sessionStarted = extendedRuntimeSession.state == .running
        if sessionStarted {
            startNotifyUser(extendedRuntimeSession)
        }
        updateStatusText()
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

    private func currentRinging(_ now: Date) -> [WatchAlarmEvent] {
        return events.filter { $0.date <= now && armed[$0.key] != nil && acknowledged[$0.key] == nil }
    }

    // そのキーの予定が「時刻到達済み」または「止めた・消えた」か
    private func isKeyDueOrDone(_ key: String?) -> Bool {
        guard let key = key else { return true }
        if acknowledged[key] != nil { return true }
        guard let ev = events.first(where: { $0.key == key }) else { return true }
        return ev.date <= Date()
    }

    private func refresh() {
        let now = Date()
        var changed = false
        // ★ 終了予定時刻が直近（過去5分以内含む）のイベントを確実に arm 対象とし、0:00到達時の取りこぼしを防止
        for e in events where armed[e.key] == nil && e.date > now.addingTimeInterval(-300) {
            armed[e.key] = e.date.timeIntervalSince1970
            changed = true
        }
        if prune(now) { changed = true }
        if changed { persist() }

        let newRinging = currentRinging(now)
        if newRinging != ringing {
            // 鳴っていたのに消えた予定（相手が止めた・完了した）があれば保留・配信通知も即座に消火
            let removedKeys = ringing.filter { r in !newRinging.contains(where: { $0.key == r.key }) }.map { $0.key }
            if !removedKeys.isEmpty {
                let ids = removedKeys.flatMap { k in repeatOffsets.indices.map { "\(notificationPrefix)\(k).\($0)" } }
                UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids)
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
            }
            ringing = newRinging
        }

        // 鳴っている予定または予約中の予定が相手によって止められた・席が終了した → アラームを即時消火
        if session != nil {
            let keyInvalid = (sessionKey != nil && (!events.contains { $0.key == sessionKey } || acknowledged[sessionKey!] != nil))
            let noEventsAtAll = events.isEmpty && ringing.isEmpty
            if keyInvalid || noEventsAtAll {
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
                let isMain = mainSeatIds.contains(id)
                var extra: [String: Any] = ["kind": isMain ? "main" : "check"]
                if isMain, let mainEvent = targets.first(where: { $0.seatId == id && $0.key.contains("-main@") }) {
                    // ★ 鳴っていたタイマーの終了時刻。iPhone は席の終了時刻と照合し、別のタイマーなら止めない
                    extra["expectedEnd"] = mainEvent.date.timeIntervalSince1970 * 1000.0
                    WatchSessionManager.shared.applyLocalStop(seatId: id)
                    if id == "main-timer" || id == WatchSessionManager.shared.mainTimer?.id {
                        if var m = WatchSessionManager.shared.mainTimer {
                            m.isRunning = false
                            m.pausedRemainingSeconds = m.totalSeconds
                            WatchSessionManager.shared.mainTimer = m
                        }
                        WatchSessionManager.shared.sendMainTimerAction(action: "MAIN_TIMER_RESET")
                    }
                } else if !isMain {
                    // ★ チェック時間アラームの停止: Watch側でも即座にチェック完了を反映
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

    // MARK: - アプリ表示中の強い振動（0.5秒ごと）

    private func updateForegroundHaptics() {
        let shouldVibrate = !ringing.isEmpty && isAppActive
        if shouldVibrate {
            guard hapticTimer == nil else { return }
            playNextHaptic()
            let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
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

        // ★ 直前のセッションが無効化処理中の場合は完了(didInvalidateWith)を待つ（0.3秒後フォールバックあり）
        if !invalidatingSessions.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                self?.refresh()
            }
            return
        }

        // ★ 時刻到達済み（＝まもなく開始する／開始処理中）の予定のセッションは絶対に取り消さない
        if session != nil, let key = sessionKey, acknowledged[key] == nil,
           let ev = events.first(where: { $0.key == key }), ev.date <= now.addingTimeInterval(2) {
            return
        }

        // 鳴動中なのにセッションが無い（アプリを開いた時点で過ぎていた等）→ 1秒後開始で予約し、
        // 画面が暗くなっても止めるまで鳴り続けるようにする
        let target: WatchAlarmEvent?
        let startDate: Date
        if let r = currentRinging(now).first {
            // 即時鳴動セッションの開始はフォアグラウンド表示中のみ許可
            guard canScheduleSmartAlarm else { return }
            target = r
            startDate = now.addingTimeInterval(1)
        } else if let n = events
            .filter({ $0.date > now && acknowledged[$0.key] == nil })
            .min(by: { $0.date < $1.date }) {
            target = n
            startDate = n.date
        } else {
            target = nil
            startDate = now
        }

        if let s = session, let key = sessionKey, key == target?.key, s.state == .scheduled || s.state == .notStarted {
            return // 予約済み
        }
        if session != nil {
            invalidateCurrentSession()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                self?.refresh()
            }
            return
        }
        guard let t = target, startDate.timeIntervalSince(now) < 36 * 3600 else { return }
        guard canScheduleSmartAlarm else { return }

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
        s.notifyUser(hapticType: .notification) { next in
            step += 1
            next.pointee = types[step % types.count]
            return 0.8
        }
    }

    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        startNotifyUser(extendedRuntimeSession)
        DispatchQueue.main.async {
            guard extendedRuntimeSession === self.session else { return }
            self.sessionStarted = true
            self.lastSessionEnd = "-"
            self.refresh()
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
            if isCurrent {
                self.clearSession()
            }
            self.lastSessionEnd = self.reasonText(reason, error: error)
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
            .filter { $0.date.addingTimeInterval(lastOffset) > now && acknowledged[$0.key] == nil }
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
                if interval < -60 { continue }
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
                content.threadIdentifier = "assisttimer.alarm"
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
