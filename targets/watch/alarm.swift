import Foundation
import SwiftUI
import WatchKit
import UserNotifications

// MARK: - タイムアップのアラーム（止めるまで鳴り続ける）
//
// ・アプリ表示中: 1秒ごとに強い振動（.notification / .failure を交互）を「止める」まで繰り返す
// ・バックグラウンド / 手首を下ろしている時:
//     スマートアラーム（WKExtendedRuntimeSession の start(at:) ＋ notifyUser）で
//     システムのアラーム画面を出し、ユーザーが止めるまで振動を繰り返す。
//     ※ start(at:) はアプリ表示中にしか予約できず、同時に1件まで → 一番早い席の分だけ予約する
// ・予備: ローカル通知（終了時刻＋20〜120秒後の繰り返し）
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

    private var notificationSignature = ""
    private var authRequested = false
    private var hapticToggle = false

    private let armedStoreKey = "assisttimer.alarm.armed"
    private let ackStoreKey = "assisttimer.alarm.ack"
    private let notificationPrefix = "assisttimer.alarm."
    private let repeatOffsets: [TimeInterval] = [0, 20, 40, 60, 90, 120]
    private let maxNotifications = 60 // watchOS の保留通知上限（64件）未満に抑える

    override init() {
        super.init()
        armed = (UserDefaults.standard.dictionary(forKey: armedStoreKey) as? [String: Double]) ?? [:]
        acknowledged = (UserDefaults.standard.dictionary(forKey: ackStoreKey) as? [String: Double]) ?? [:]
        UNUserNotificationCenter.current().delegate = self
    }

    // MARK: - 外部から呼ぶ

    /// 席データが変わった時（iPhoneからの受信・Watchでの操作）に呼ぶ。バックグラウンドでも可。
    func update(timers: [SeatTimerItem], soundOn: Bool) {
        self.soundOn = soundOn
        var list: [WatchAlarmEvent] = []
        for t in timers where t.isRunning {
            let label = "\(t.seatNumber)番席"
            let mainEpoch = Int(t.targetEndTime.timeIntervalSince1970)
            list.append(WatchAlarmEvent(
                key: "\(t.id)-main@\(mainEpoch)",
                seatId: t.id,
                date: t.targetEndTime,
                title: "\(label) 放置タイム終了"
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

    /// アプリ表示中に1秒ごとに呼ぶ（鳴動中なら強い振動）
    func tick() {
        refresh()
        guard !ringing.isEmpty, isAppActive else { return }
        hapticToggle.toggle()
        WKInterfaceDevice.current().play(hapticToggle ? .notification : .failure)
    }

    /// 「止める」ボタン
    func stop() {
        acknowledgeRinging(sendToPhone: true)
        if let s = session, sessionStarted {
            clearSession()
            s.invalidate()
        }
        refresh()
    }

    /// アプリが表示状態になった時（スマートアラームの予約はこの時しかできない）
    func appBecameActive() {
        refresh()
    }

    /// アプリ終了中にスマートアラームの時刻になり、システムがアプリを起動した時
    func adopt(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        extendedRuntimeSession.delegate = self
        session = extendedRuntimeSession
        sessionKey = nil
        sessionStarted = extendedRuntimeSession.state == .running
        if sessionStarted {
            extendedRuntimeSession.notifyUser(hapticType: .notification) { next in
                next.pointee = .notification
                return 1.5
            }
        }
        updateStatusText()
    }

    // MARK: - 内部処理

    private var isAppActive: Bool {
        return WKApplication.shared().applicationState == .active
    }

    private func currentRinging(_ now: Date) -> [WatchAlarmEvent] {
        return events.filter { $0.date <= now && armed[$0.key] != nil && acknowledged[$0.key] == nil }
    }

    private func refresh() {
        let now = Date()
        var changed = false
        for e in events where e.date > now && armed[e.key] == nil {
            armed[e.key] = e.date.timeIntervalSince1970
            changed = true
        }
        if prune(now) { changed = true }
        if changed { persist() }

        let newRinging = currentRinging(now)
        if newRinging != ringing { ringing = newRinging }

        // 鳴っている予定が iPhone 側で止められた・席が終了した → スマートアラームも止める
        if sessionStarted, let s = session, let key = sessionKey {
            let stillValid = events.contains { $0.key == key } && acknowledged[key] == nil
            if !stillValid {
                clearSession()
                s.invalidate()
            }
        }

        scheduleSmartAlarmIfPossible(now)
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
            let seatIds = Set(targets.map { $0.seatId })
            for id in seatIds {
                WatchSessionManager.shared.sendActionToPhone(action: "STOP_ALARM", seatId: id)
            }
        }
    }

    private func clearSession() {
        session = nil
        sessionKey = nil
        sessionStarted = false
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
            smart = "予約あり"
        } else {
            smart = "予約なし"
        }
        let text = "スマートアラーム:\(smart) / 鳴動\(ringing.count)件 / 音:\(soundOn ? "ON" : "OFF")"
        if text != statusText { statusText = text }
    }

    // MARK: - スマートアラーム（WKExtendedRuntimeSession）

    private func scheduleSmartAlarmIfPossible(_ now: Date) {
        // 鳴動中のセッションには触らない
        if sessionStarted { return }
        if let s = session, s.state == .invalid { clearSession() }
        // start(at:) はアプリ表示中にしか呼べない
        guard isAppActive else { return }

        let next = events
            .filter { $0.date > now.addingTimeInterval(2) && acknowledged[$0.key] == nil }
            .min { $0.date < $1.date }

        if let s = session, let key = sessionKey, key == next?.key, s.state == .scheduled || s.state == .notStarted {
            return // 予約済み
        }
        if let old = session {
            clearSession()
            old.invalidate()
        }
        guard let target = next, target.date.timeIntervalSince(now) < 36 * 3600 else { return }

        let s = WKExtendedRuntimeSession()
        s.delegate = self
        s.start(at: target.date)
        session = s
        sessionKey = target.key
        sessionStarted = false
    }

    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        // 止めるまで最強クラスの振動を繰り返す（アプリ非表示時はシステムのアラーム画面になる）
        extendedRuntimeSession.notifyUser(hapticType: .notification) { next in
            next.pointee = .notification
            return 1.5
        }
        DispatchQueue.main.async {
            guard extendedRuntimeSession === self.session else { return }
            self.sessionStarted = true
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
            guard extendedRuntimeSession === self.session else { return }
            let wasStarted = self.sessionStarted
            self.clearSession()
            // システムのアラーム画面で「停止」が押された → 止めた扱いにして iPhone にも伝える
            if wasStarted && reason == WKExtendedRuntimeSessionInvalidationReason.none {
                self.acknowledgeRinging(sendToPhone: true)
            }
            self.refresh()
        }
    }

    // MARK: - ローカル通知（予備）

    private func requestAuthorizationIfNeeded() {
        guard !authRequested else { return }
        authRequested = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func rescheduleNotifications(_ now: Date) {
        let lastOffset = repeatOffsets.last ?? 0
        // 繰り返し通知がまだ残っている予定（鳴動中の予定も含める：鳴った瞬間に繰り返し分を消さないため）
        let targets = events
            .filter { $0.date.addingTimeInterval(lastOffset) > now && acknowledged[$0.key] == nil }
            .sorted { $0.date < $1.date }
        let signature = targets.map { $0.key }.joined(separator: "|") + "#\(soundOn)"
        guard signature != notificationSignature else { return }
        notificationSignature = signature
        if !targets.isEmpty { requestAuthorizationIfNeeded() }

        let soundOn = self.soundOn
        let offsets = repeatOffsets
        let prefix = notificationPrefix
        let limit = maxNotifications
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { requests in
            let old = requests.map { $0.identifier }.filter { $0.hasPrefix(prefix) }
            center.removePendingNotificationRequests(withIdentifiers: old)
            var count = 0
            for e in targets {
                for (i, offset) in offsets.enumerated() {
                    if count >= limit { break }
                    let interval = e.date.addingTimeInterval(offset).timeIntervalSinceNow
                    if interval <= 1 { continue }
                    let content = UNMutableNotificationContent()
                    content.title = "⏰ \(e.title)"
                    content.body = i == 0
                        ? "タイムアップです。アプリを開いて止めてください。"
                        : "まだ止められていません（\(Int(offset))秒経過）"
                    content.sound = soundOn ? .default : nil
                    content.threadIdentifier = "assisttimer.alarm"
                    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
                    center.add(UNNotificationRequest(identifier: "\(prefix)\(e.key).\(i)", content: content, trigger: trigger))
                    count += 1
                }
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
}
