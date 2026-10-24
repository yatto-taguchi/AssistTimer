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
//     ※ 前のセッションを invalidate() した直後（同一ターン）に新しい start(at:) を呼ぶと
//        watchOS が .sessionInProgress エラーで弾くため、必ず破棄完了を待ってから新規予約する。
//     ※ 開始されたスマートアラーム（.running）は、いかなる場合でも notifyUser を最低1回呼んでからでないと
//        watchOS が「スケジュールされたアラームを再生できませんでした」のシステム警告を出すため、
//        safeInvalidateSession で 100% 確実に保護する。
// ・アプリ表示中: 上記に加えて、0.3秒ごとの強い振動（.failure / .notification / .retry）を重ねる
// ・予備: ローカル通知（終了時刻＋0〜180秒の連続 TimeSensitive 通知）
//
// Watch 側で止めた時は iPhone へ STOP_ALARM / MAIN_TIMER_RESET を送り、iPhone 側のアラームも止める。

struct WatchAlarmEvent: Equatable {
    let key: String      // "<席ID>-main@<終了時刻(秒)>" / "<席ID>-check@<終了時刻(秒)>"
    let seatId: String
    let date: Date
    let title: String

    func toDictionary() -> [String: Any] {
        return [
            "key": key,
            "seatId": seatId,
            "timestamp": date.timeIntervalSince1970,
            "title": title
        ]
    }

    init(key: String, seatId: String, date: Date, title: String) {
        self.key = key
        self.seatId = seatId
        self.date = date
        self.title = title
    }

    init?(dictionary: [String: Any]) {
        guard let key = dictionary["key"] as? String,
              let seatId = dictionary["seatId"] as? String,
              let ts = (dictionary["timestamp"] as? NSNumber)?.doubleValue ?? (dictionary["timestamp"] as? Double),
              let title = dictionary["title"] as? String else {
            return nil
        }
        self.key = key
        self.seatId = seatId
        self.date = Date(timeIntervalSince1970: ts)
        self.title = title
    }
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
    // スマートアラームが数ミリ秒〜数秒早く起動した際に即座に鳴動扱いとするキー
    private var forceRingingKeys: Set<String> = []
    private var soundOn = false

    private var session: WKExtendedRuntimeSession?
    private var sessionKey: String?
    private var sessionStarted = false
    private var invalidatingSessions: Set<WKExtendedRuntimeSession> = []
    // ★ watchOSペナルティ防止用: notifyUser を呼び出し済みのセッション、呼び出し開始時刻、およびバックグラウンド起動で引き継いだセッションを記録
    private var notifiedSessions: Set<WKExtendedRuntimeSession> = []
    private var sessionNotifyStartTimes: [WKExtendedRuntimeSession: Date] = [:]
    private var backgroundAdoptedSessions: Set<WKExtendedRuntimeSession> = []
    // スマートアラームが一度鳴動開始→終了したキー（チェックタイマー閉じた後に本体タイマーのスマートアラームへ確実に引き継ぐ）
    private var smartAlarmCompletedKeys: Set<String> = []
    // バックグラウンド時に既存の全体タイマー通知を壊さないための登録済み通知イベントキー記録
    private var scheduledNotificationEventKeys: Set<String> = []
    // システムアラーム画面で「開く」が押されてフォアグラウンド起動したか「終了」が押されたかを識別するための最終アクティブ化時刻
    private var lastAppBecameActiveAt: Date = .distantPast
    // システムアラーム画面（[開く] / [終了]）が非アクティブ状態で閉じた際、即時完了処理を行いつつ「開く」だった場合にオーバーレイを復元するためのスナップショット
    private struct SystemDismissedSnapshot {
        let event: WatchAlarmEvent
        let dismissedAt: Date
        let isCheckEvent: Bool
        let preMainTimer: SeatTimerItem?
        let preSeatTimer: SeatTimerItem?
    }
    private var lastSystemDismissedSnapshot: SystemDismissedSnapshot?
    private var pendingSystemDismissPhoneSyncWorkItem: DispatchWorkItem?
    private var restoredOverlayEvents: [String: WatchAlarmEvent] = [:]
    private var allowBackgroundHandoffScheduleUntil: Date = .distantPast
    private var retryScheduleWorkItem: DispatchWorkItem?
    private var lastSessionEnd: String = "-"
    private var notificationAuth: String = "?"

    private var notificationSignature = ""
    private var authRequested = false
    private var hapticStep = 0
    private var hapticTimer: Timer?

    private let armedStoreKey = "assisttimer.alarm.armed"
    private let ackStoreKey = "assisttimer.alarm.ack"
    private let eventsStoreKey = "assisttimer.alarm.events"
    private let sessionKeyStoreKey = "assisttimer.alarm.sessionKey"
    private let notificationPrefix = "assisttimer.alarm."
    // ★ 高密度連続TimeSensitive通知オフセット（watchOSの64件上限を超えないよう8回に厳選し、複数席＋チェックタイマー併用時も確実に全件登録する）
    private let repeatOffsets: [TimeInterval] = [0, 4, 8, 13, 18, 25, 40, 60]
    private let maxNotifications = 56 // watchOS の保留通知上限（64件）に対して安全マージンを確保
    // 強めに感じる触覚を交互に鳴らす（最も強烈な .failure と .notification を高密度連打）
    private let strongHaptics: [WKHapticType] = [.failure, .notification, .failure, .retry]

    override init() {
        super.init()
        armed = (UserDefaults.standard.dictionary(forKey: armedStoreKey) as? [String: Double]) ?? [:]
        acknowledged = (UserDefaults.standard.dictionary(forKey: ackStoreKey) as? [String: Double]) ?? [:]
        sessionKey = UserDefaults.standard.string(forKey: sessionKeyStoreKey)
        if let rawEvents = UserDefaults.standard.array(forKey: eventsStoreKey) as? [[String: Any]] {
            events = rawEvents.compactMap { WatchAlarmEvent(dictionary: $0) }
        }

        // ★ アプリ起動時（TestFlight更新後や再起動時）に、すでに終了時刻から60秒以上過ぎている古い予約が残っていれば
        //   すべて消火済み（acknowledged）として扱い、アプリを開いた瞬間に過去のバイブレーションが暴発するのを防ぐ。
        //   ※直近60秒以内に終了時刻を迎えたばかりの予定は、スマートアラームのバックグラウンド起動（adopt）で鳴らすため保護する！
        let launchCutoff = Date().timeIntervalSince1970 - 60
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

    /// メインタイマーが現在鳴動中（または未消火でタイムアップ到達済み）かどうか
    var isMainTimerRingingOrDue: Bool {
        if ringing.contains(where: { $0.seatId == "main-timer" }) { return true }
        let now = Date()
        return events.contains { $0.seatId == "main-timer" && $0.date <= now && isArmed($0.key) && !isAcknowledged($0.key) }
    }

    /// 席データが変わった時（iPhoneからの受信・Watchでの操作）に呼ぶ。バックグラウンドでも可。
    func update(timers: [SeatTimerItem], mainTimer: SeatTimerItem? = nil, soundOn: Bool, currentUserName: String? = nil) {
        self.soundOn = soundOn
        var list: [WatchAlarmEvent] = []
        let nowDate = Date()
        var ackChanged = false

        let shouldKeepEvent: (String, Date) -> Bool = { [weak self] key, targetDate in
            guard let self = self else { return false }
            // ★ カウントダウン中（終了予定時刻が未来）の予定は監視対象とする
            if targetDate > nowDate { return true }
            // すでに終了時刻に達している予定は「終了前にカウントダウン中として arm 済み＆未停止」の場合のみ保持（超過カウントアップ中も保護）
            guard self.isArmed(key) && !self.isAcknowledged(key) else { return false }
            if targetDate > nowDate.addingTimeInterval(-10800) { return true }
            return self.ringing.contains { self.isSameTarget(key1: $0.key, key2: key) }
        }

        // ★ 1. メインタイマーのアラーム対象登録
        //    準備中カウントダウン（isPreCountingDown == true）の間であっても、本番終了時刻（prepEnd + totalSeconds）で
        //    最初からスマートアラーム＆通知を予約する！これによりスタート直後に手首を下ろしても100%確実に発動する。
        if let m = mainTimer, (m.isRunning || m.isPreCountingDown) {
            let effectiveEnd: Date
            if m.isPreCountingDown {
                let prepEnd = m.prepEndTime ?? nowDate.addingTimeInterval(TimeInterval(max(1, m.preCountdownSeconds)))
                let runSec = m.pausedRemainingSeconds > 0 ? m.pausedRemainingSeconds : m.totalSeconds
                effectiveEnd = prepEnd.addingTimeInterval(TimeInterval(runSec))
            } else {
                effectiveEnd = m.targetEndTime
            }
            // すでに予約済み・arm済みのメインタイマーと実質同一（±15秒以内）なら、既存の終了時刻を維持して予約の揺らぎを防ぐ
            let finalMainEnd: Date
            if let existingMain = events.first(where: { $0.seatId == m.id && $0.key.contains("-main@") && !isAcknowledged($0.key) }),
               abs(existingMain.date.timeIntervalSince(effectiveEnd)) <= 15 {
                finalMainEnd = existingMain.date
            } else {
                finalMainEnd = effectiveEnd
            }
            let mainEpoch = Int(finalMainEnd.timeIntervalSince1970)
            let mainKey = "\(m.id)-main@\(mainEpoch)"
            // ★ カウントダウン中（未来の終了時刻）のメインタイマーは即座にarm登録し、過去の古い消火履歴と衝突していた場合はクリアして確実に鳴動させる
            if finalMainEnd > nowDate.addingTimeInterval(-2) {
                if armed[mainKey] == nil {
                    armed[mainKey] = finalMainEnd.timeIntervalSince1970
                    ackChanged = true
                }
            }
            if finalMainEnd > nowDate.addingTimeInterval(2) {
                let staleAckKeys = acknowledged.keys.filter { isSameTarget(key1: $0, key2: mainKey) }
                if !staleAckKeys.isEmpty {
                    for k in staleAckKeys { acknowledged.removeValue(forKey: k) }
                    ackChanged = true
                }
                smartAlarmCompletedKeys = smartAlarmCompletedKeys.filter { !isSameTarget(key1: $0, key2: mainKey) }
            }
            if shouldKeepEvent(mainKey, finalMainEnd) {
                list.append(WatchAlarmEvent(
                    key: mainKey,
                    seatId: m.id,
                    date: finalMainEnd,
                    title: "⏱️ メインタイマー 終了"
                ))
            }
        } else if let existingRingingMain = ringing.first(where: { $0.seatId == "main-timer" }), !isAcknowledged(existingRingingMain.key) {
            // ★ メインタイマーが0秒に到達して鳴動している間は、iPhoneから自動停止（isRunning: false）が届いても
            //   ユーザーが明示的に止めるまで鳴動イベントを保持する
            list.append(existingRingingMain)
        } else if mainTimer != nil,
                  let existingDueMain = events.first(where: { $0.seatId == "main-timer" && !isAcknowledged($0.key) && isArmed($0.key) }),
                  existingDueMain.date <= nowDate.addingTimeInterval(15),
                  existingDueMain.date > nowDate.addingTimeInterval(-10800) {
            // ★ iPhone側またはWatch側がカウントアップOFFで0秒到達と同時に isRunning: false を設定した場合でも、
            //   Watch側の終了時刻直前〜直後であればイベントを消さずに確実に鳴動させる
            if existingDueMain.date <= nowDate.addingTimeInterval(5) {
                forceRingingKeys.insert(existingDueMain.key)
            }
            list.append(existingDueMain)
        }

        // ★ 2. 共有タイマー（客席タイマー）のアラーム対象登録
        for t in timers where t.isRunning {
            let label = t.displaySeatName
            // 既存の同一席イベントと時刻差が15秒以内なら既存時刻を維持（通信往復での再予約・セッション衝突を防止）
            let finalSeatEnd: Date
            if let existingSeat = events.first(where: { $0.seatId == t.id && $0.key.contains("-main@") && !isAcknowledged($0.key) }),
               abs(existingSeat.date.timeIntervalSince(t.targetEndTime)) <= 15 {
                finalSeatEnd = existingSeat.date
            } else {
                finalSeatEnd = t.targetEndTime
            }
            let mainEpoch = Int(finalSeatEnd.timeIntervalSince1970)
            let mainKey = "\(t.id)-main@\(mainEpoch)"
            if finalSeatEnd > nowDate.addingTimeInterval(-2) {
                if armed[mainKey] == nil {
                    armed[mainKey] = finalSeatEnd.timeIntervalSince1970
                    ackChanged = true
                }
            }
            if finalSeatEnd > nowDate.addingTimeInterval(2) {
                let staleAckKeys = acknowledged.keys.filter { isSameTarget(key1: $0, key2: mainKey) }
                if !staleAckKeys.isEmpty {
                    for k in staleAckKeys { acknowledged.removeValue(forKey: k) }
                    ackChanged = true
                }
                smartAlarmCompletedKeys = smartAlarmCompletedKeys.filter { !isSameTarget(key1: $0, key2: mainKey) }
            }
            if shouldKeepEvent(mainKey, finalSeatEnd) {
                list.append(WatchAlarmEvent(
                    key: mainKey,
                    seatId: t.id,
                    date: finalSeatEnd,
                    title: "\(label) タイム終了"
                ))
            }
            if !t.isCheckCompleted, let checkEnd = t.checkTargetEndTime, (t.checkTotalSeconds ?? 0) > 0 {
                let finalCheckEnd: Date
                if let existingCheck = events.first(where: { $0.seatId == t.id && $0.key.contains("-check@") && !isAcknowledged($0.key) }),
                   abs(existingCheck.date.timeIntervalSince(checkEnd)) <= 15 {
                    finalCheckEnd = existingCheck.date
                } else {
                    finalCheckEnd = checkEnd
                }
                let checkEpoch = Int(finalCheckEnd.timeIntervalSince1970)
                let checkKey = "\(t.id)-check@\(checkEpoch)"
                if finalCheckEnd > nowDate.addingTimeInterval(-2) {
                    if armed[checkKey] == nil {
                        armed[checkKey] = finalCheckEnd.timeIntervalSince1970
                        ackChanged = true
                    }
                }
                if finalCheckEnd > nowDate.addingTimeInterval(2) {
                    let staleAckKeys = acknowledged.keys.filter { isSameTarget(key1: $0, key2: checkKey) }
                    if !staleAckKeys.isEmpty {
                        for k in staleAckKeys { acknowledged.removeValue(forKey: k) }
                        ackChanged = true
                    }
                    smartAlarmCompletedKeys = smartAlarmCompletedKeys.filter { !isSameTarget(key1: $0, key2: checkKey) }
                }
                // ★ 本体タイマーがすでに終了時刻（0:00）に到達している場合、未消火のチェックタイマーが本体アラームを塞がないよう自動で引き継ぐ
                if finalSeatEnd <= nowDate && finalCheckEnd < finalSeatEnd {
                    if !isAcknowledged(checkKey) {
                        acknowledged[checkKey] = finalCheckEnd.timeIntervalSince1970
                        ackChanged = true
                    }
                } else if shouldKeepEvent(checkKey, finalCheckEnd) {
                    list.append(WatchAlarmEvent(
                        key: checkKey,
                        seatId: t.id,
                        date: finalCheckEnd,
                        title: "\(label) チェック時間"
                    ))
                }
            }
        }
        // システムアラーム画面で「開く」を押してフォアグラウンド復帰し、alarmOverlay 表示を維持しているイベントがあれば保持
        for (key, restoredEv) in restoredOverlayEvents {
            if isAcknowledged(key) {
                restoredOverlayEvents.removeValue(forKey: key)
            } else if !list.contains(where: { isSameTarget(key1: $0.key, key2: key) }) {
                list.append(restoredEv)
            }
        }
        events = list
        persistEvents()
        if ackChanged { persist() }
        refresh()
    }

    /// ★ チェックタイマー終了・完了時に、残りの全体タイマーを「新しいタイマー」としてクリーンに入れ直す
    func restartRemainingTimerAfterCheck(seatId: String, timers: [SeatTimerItem], mainTimer: SeatTimerItem?, soundOn: Bool, currentUserName: String?) {
        // 1. その席のチェックイベントをすべて完了・消火済みにし、チェック用リピート通知を同期的に即消去する
        let checkEvents = (events + ringing).filter { $0.seatId == seatId && $0.key.contains("-check@") }
        for ev in checkEvents {
            acknowledged[ev.key] = ev.date.timeIntervalSince1970
            removeForceRinging(matching: ev.key)
            scheduledNotificationEventKeys.remove(ev.key)
            restoredOverlayEvents = restoredOverlayEvents.filter { !isSameTarget(key1: $0.key, key2: ev.key) }
        }
        if let snap = lastSystemDismissedSnapshot, snap.event.seatId == seatId && snap.isCheckEvent {
            lastSystemDismissedSnapshot = nil
        }
        let checkIds = checkEvents.flatMap { e in repeatOffsets.indices.map { "\(notificationPrefix)\(e.key).\($0)" } }
        if !checkIds.isEmpty {
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: checkIds)
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: checkIds)
        }
        ringing.removeAll { $0.seatId == seatId && $0.key.contains("-check@") }
        smartAlarmCompletedKeys = smartAlarmCompletedKeys.filter { !$0.hasPrefix("\(seatId)-main@") }
        persist()

        // 2. 既存のチェック用スマートアラームセッションがあれば安全に破棄する
        if let key = sessionKey, key.hasPrefix("\(seatId)-check@") {
            invalidateCurrentSession()
        }

        // 3. 通知署名をリセットして残りの全体タイマー通知を確実に再構成・再登録する
        notificationSignature = ""
        update(timers: timers, mainTimer: mainTimer, soundOn: soundOn, currentUserName: currentUserName)

        // 4. 前のセッションの破棄完了およびシステムアラート消去アニメーション完了に備えて段階的に再確認
        scheduleRetryAfterInvalidation(delay: 0.25)
    }

    /// メインタイマーがユーザーによって明示的にリセット・一時停止された時に呼ぶ
    func acknowledgeMainTimer() {
        var changed = false
        for ev in events where ev.seatId == "main-timer" {
            acknowledged[ev.key] = ev.date.timeIntervalSince1970
            removeForceRinging(matching: ev.key)
            scheduledNotificationEventKeys.remove(ev.key)
            restoredOverlayEvents = restoredOverlayEvents.filter { !isSameTarget(key1: $0.key, key2: ev.key) }
            changed = true
        }
        for ev in ringing where ev.seatId == "main-timer" {
            acknowledged[ev.key] = ev.date.timeIntervalSince1970
            removeForceRinging(matching: ev.key)
            scheduledNotificationEventKeys.remove(ev.key)
            restoredOverlayEvents = restoredOverlayEvents.filter { !isSameTarget(key1: $0.key, key2: ev.key) }
            changed = true
        }
        if let snap = lastSystemDismissedSnapshot, snap.event.seatId == "main-timer" {
            lastSystemDismissedSnapshot = nil
            pendingSystemDismissPhoneSyncWorkItem?.cancel()
            pendingSystemDismissPhoneSyncWorkItem = nil
        }
        if changed { persist() }
        let mainIds = (events + ringing).filter { $0.seatId == "main-timer" }.flatMap { e in
            repeatOffsets.indices.map { "\(notificationPrefix)\(e.key).\($0)" }
        }
        if !mainIds.isEmpty {
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: mainIds)
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: mainIds)
        }
        ringing.removeAll { $0.seatId == "main-timer" }
        if ringing.isEmpty {
            stopForegroundHaptics()
        }
        if let key = sessionKey, key.hasPrefix("main-timer") {
            invalidateCurrentSession()
        }
        refresh()
    }

    /// アプリ表示中に1秒ごとに呼ぶ
    func tick() {
        refresh()
    }

    /// 「止める」ボタン（カスタムボタン側で別途アクション送信する場合は sendToPhone: false を指定可能）
    func stop(sendToPhone: Bool = true, completeCheckIfNeeded: Bool = true) {
        pendingSystemDismissPhoneSyncWorkItem?.cancel()
        pendingSystemDismissPhoneSyncWorkItem = nil
        lastSystemDismissedSnapshot = nil
        acknowledgeRinging(sendToPhone: sendToPhone, completeCheckIfNeeded: completeCheckIfNeeded)
        stopForegroundHaptics()
        // ★ すでに後続の全体タイマー等のために新しく予約成立（.scheduled）している未消火セッションは破棄せず保護する
        if session != nil {
            let shouldInvalidateSession: Bool = {
                if sessionStarted { return true }
                guard let key = sessionKey else { return true }
                if isAcknowledged(key) { return true }
                if events.isEmpty && ringing.isEmpty { return true }
                return false
            }()
            if shouldInvalidateSession {
                invalidateCurrentSession()
            }
        }
        notificationSignature = ""
        refresh()
        scheduleRetryAfterInvalidation(delay: 0.25)
    }

    /// アプリが表示状態になった時（スマートアラームの予約・通知の許可確認はこの時しかできない）
    func appBecameActive() {
        let now = Date()
        lastAppBecameActiveAt = now
        // ★ システムのスマートアラーム画面（「"AssistTimer" からのアラームです。 [開く] [終了]」）で
        //   「開く」を押してフォアグラウンド遷移してきた場合（直近1.8秒以内のシステム消去）は、
        //   即時消火していたイベントのオーバーレイ表示（次の画面）を復元し、ユーザーが画面上で操作できるようにする
        if let snap = lastSystemDismissedSnapshot, now.timeIntervalSince(snap.dismissedAt) < 1.8 {
            lastSystemDismissedSnapshot = nil
            pendingSystemDismissPhoneSyncWorkItem?.cancel()
            pendingSystemDismissPhoneSyncWorkItem = nil
            if !snap.isCheckEvent {
                if let preMain = snap.preMainTimer {
                    WatchSessionManager.shared.mainTimer = preMain
                    WidgetSync.save(timers: WatchSessionManager.shared.timers, mainTimer: preMain, userName: WatchSessionManager.shared.currentUserName)
                }
                if let preSeat = snap.preSeatTimer,
                   let idx = WatchSessionManager.shared.timers.firstIndex(where: { $0.id == preSeat.id }) {
                    WatchSessionManager.shared.timers[idx] = preSeat
                    WidgetSync.save(timers: WatchSessionManager.shared.timers, mainTimer: WatchSessionManager.shared.mainTimer, userName: WatchSessionManager.shared.currentUserName)
                }
            }
            let matchingAckKeys = acknowledged.keys.filter { isSameTarget(key1: $0, key2: snap.event.key) }
            for k in matchingAckKeys {
                acknowledged.removeValue(forKey: k)
            }
            armed[snap.event.key] = snap.event.date.timeIntervalSince1970
            restoredOverlayEvents[snap.event.key] = snap.event
            if !events.contains(where: { isSameTarget(key1: $0.key, key2: snap.event.key) }) {
                events.append(snap.event)
            }
            forceRingingKeys.insert(snap.event.key)
            persist()
        }
        requestAuthorizationIfNeeded()
        refreshNotificationAuth()
        refresh()
    }

    /// アプリ終了中にスマートアラームの時刻になり、システムがアプリを起動した時
    func adopt(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        let block = {
            extendedRuntimeSession.delegate = self
            self.backgroundAdoptedSessions.insert(extendedRuntimeSession)
            self.session = extendedRuntimeSession
            if self.sessionKey == nil {
                self.sessionKey = UserDefaults.standard.string(forKey: self.sessionKeyStoreKey)
            }
            if self.events.isEmpty, let rawEvents = UserDefaults.standard.array(forKey: self.eventsStoreKey) as? [[String: Any]] {
                self.events = rawEvents.compactMap { WatchAlarmEvent(dictionary: $0) }
            }
            self.sessionStarted = (extendedRuntimeSession.state == .running)
            if self.sessionStarted {
                self.activateSessionRingingAndNotify(extendedRuntimeSession)
            } else {
                // ★ セッションが .running へ遷移する直前に refresh() を呼ぶと、sessionStarted == false 判定で
                //   誤って invalidate され「スケジュールされたアラームを再生できませんでした」警告が出るのを防ぐため、
                //   didStart が呼ばれるまでセッション破棄判定を行わず待機する
                self.updateStatusText()
            }
        }
        if Thread.isMainThread {
            block()
        } else {
            DispatchQueue.main.async(execute: block)
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
        return events.filter { ev in
            guard !isAcknowledged(ev.key) else { return false }
            if forceRingingKeys.contains(where: { isSameTarget(key1: $0, key2: ev.key) }) {
                return true
            }
            return ev.date <= now && isArmed(ev.key)
        }
    }

    // ★ 2つのイベントキーが実質的に同一ターゲット（同一席・同一種別、かつ時刻差が15秒以内）か判定
    private func isSameTarget(key1: String?, key2: String?) -> Bool {
        guard let k1 = key1, let k2 = key2 else { return false }
        if k1 == k2 { return true }
        let parts1 = k1.components(separatedBy: "@")
        let parts2 = k2.components(separatedBy: "@")
        guard parts1.count == 2, parts2.count == 2, parts1[0] == parts2[0] else { return false }
        if let epoch1 = Int(parts1[1]), let epoch2 = Int(parts2[1]), abs(epoch1 - epoch2) <= 15 {
            return true
        }
        return false
    }

    private func removeForceRinging(matching key: String) {
        forceRingingKeys = forceRingingKeys.filter { !isSameTarget(key1: $0, key2: key) }
    }

    private func refresh() {
        let now = Date()
        var changed = false

        // ★ メインタイマーが終了時刻（00:00）に到達しても自動停止（00:00リセット）は行わず、
        //   ユーザーが明示的に「タイマーを止める」等を押すまでは超過（カウントアップ）状態を維持する。

        // ★ 終了予定時刻が現在より未来（または直近2秒以内に開始されたばかり）のイベントを arm 対象とする
        for e in events where !isArmed(e.key) && e.date > now.addingTimeInterval(-2) {
            armed[e.key] = e.date.timeIntervalSince1970
            changed = true
        }
        // ★ 同一席で本体タイマー（-main）が時刻到達した場合、古い未消火のチェックタイマー（-check）を自動的に完了扱いにして
        //   2回目の本体タイマーのアラーム・振動へ確実に切り替える
        for mainEv in events where mainEv.key.contains("-main@") && mainEv.date <= now && isArmed(mainEv.key) && !isAcknowledged(mainEv.key) {
            for checkEv in events where checkEv.seatId == mainEv.seatId && checkEv.key.contains("-check@") && !isAcknowledged(checkEv.key) {
                acknowledged[checkEv.key] = checkEv.date.timeIntervalSince1970
                removeForceRinging(matching: checkEv.key)
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
                    removeForceRinging(matching: ev.key)
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
                setSessionKey(latest.key)
                startNotifyUser(s)
            }
        }

        // ★ セッション破棄判定:
        //    - 鳴動中（sessionStarted == true）の場合: 対象の予定が明示的に止められたか、鳴動対象がすべて消火された場合のみ破棄
        //    - 予約中（sessionStarted == false）の場合:
        //      ・バックグラウンド起床直後（backgroundAdoptedSessionsに含まれる）のセッションはまだ didStart 前のため絶対に破棄しない
        //      ・予定が完全に消滅した（events.isEmpty && ringing.isEmpty）または対象キーが明示的に消火済み（isAcknowledged）なら破棄
        //      ・対象キーの時刻が変わっただけの場合は、フォアグラウンドで再予約可能な時（canScheduleSmartAlarm）のみscheduleSmartAlarmIfPossible内で安全に入れ替える！
        if let s = session {
            if sessionStarted {
                let acked = (sessionKey != nil && isAcknowledged(sessionKey!))
                if (acked && ringing.isEmpty) || (events.isEmpty && ringing.isEmpty) {
                    invalidateCurrentSession()
                }
            } else if !backgroundAdoptedSessions.contains(s) {
                let acked = (sessionKey != nil && isAcknowledged(sessionKey!))
                let seatRemoved: Bool = {
                    guard let key = sessionKey, let seatPrefix = key.components(separatedBy: "@").first else { return false }
                    return !events.contains { $0.key.hasPrefix(seatPrefix) }
                }()
                // ★ 開始予定時刻まで残り3秒以内〜直後5秒以内の予約セッションは、OS側ですでに起動シーケンス（.scheduled -> .running）に
                //   入っている可能性があり、ここで didStart 前に invalidate() すると「スケジュールされたアラームを再生できませんでした」警告になるため、
                //   didStart で notifyUser を1回鳴らしてから安全に閉じさせる
                let isImminentStart: Bool = {
                    guard let key = sessionKey,
                          let epStr = key.components(separatedBy: "@").last,
                          let ep = Double(epStr) else { return false }
                    let diff = ep - now.timeIntervalSince1970
                    return diff <= 3.0 && diff >= -5.0
                }()
                if (acked || seatRemoved || (events.isEmpty && ringing.isEmpty)) && !isImminentStart {
                    invalidateCurrentSession()
                } else if s.state == .invalid {
                    clearSession()
                }
            }
        }

        scheduleSmartAlarmIfPossible(now)
        updateForegroundHaptics()
        rescheduleNotifications(now)
        updateStatusText()
    }

    private func acknowledgeRinging(sendToPhone: Bool, completeCheckIfNeeded: Bool = true) {
        let now = Date()
        let targets = currentRinging(now)
        guard !targets.isEmpty else {
            if !ringing.isEmpty { ringing = [] }
            return
        }
        for e in targets {
            acknowledged[e.key] = e.date.timeIntervalSince1970
            removeForceRinging(matching: e.key)
            restoredOverlayEvents = restoredOverlayEvents.filter { !isSameTarget(key1: $0.key, key2: e.key) }
        }
        persist()
        let ids = targets.flatMap { e in repeatOffsets.indices.map { "\(notificationPrefix)\(e.key).\($0)" } }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
        ringing = []

        // ★ 放置タイム終了のアラーム（-main@）と途中チェック時間のアラーム（-check@）を分離して処理:
        //   1. 本放置・メインタイマー（-main@）: ユーザーがアプリ内で明示的に「止める / タイム終了 / シャンプーに入る」を選んだ時（sendToPhone == true）のみ00:00に戻す。
        //      通知の「開く」やスマートアラーム停止（sendToPhone == false）では振動とオーバーレイだけ消火し、超過カウントアップ（+00:01...）を継続させる。
        //   2. 途中チェック時間（-check@）: 通知やスマートアラームで開いた場合でもチェック完了として扱い、残りの本放置タイマー（第2段階スマートアラーム）を即座に再予約する。
        let mainSeatIds = Set(targets.filter { $0.key.contains("-main@") }.map { $0.seatId })
        let seatIds = Set(targets.map { $0.seatId })
        for id in seatIds {
            let isMainTimer = (id == "main-timer" || id == WatchSessionManager.shared.mainTimer?.id)
            if isMainTimer {
                if sendToPhone {
                    // ★ メインタイマーのアラーム消火: ユーザーが明示的に「タイマーを止める / シャンプーに入る」等を押した時（sendToPhone == true）のみ
                    //   00:00 停止状態へ戻し、文字盤モジュールも即時更新する。システムアラーム画面の「開く」「終了」では超過（カウントアップ）を維持する。
                    let stoppedEnd = targets.first(where: { $0.seatId == id })?.date.timeIntervalSince1970
                        ?? (WatchSessionManager.shared.mainTimer?.targetEndTime.timeIntervalSince1970 ?? 0)
                    if var m = WatchSessionManager.shared.mainTimer {
                        m.isRunning = false
                        m.isPreCountingDown = false
                        m.preCountdownSeconds = 0
                        m.prepEndTime = nil
                        m.pausedRemainingSeconds = 0
                        m.helpProcess = ""
                        m.isNoHelpNeeded = false
                        m.targetEndTime = Date().addingTimeInterval(TimeInterval(m.totalSeconds))
                        WatchSessionManager.shared.mainTimer = m
                        WatchSessionManager.shared.clearWatchStartedMainTimer()
                        WidgetSync.save(timers: WatchSessionManager.shared.timers, mainTimer: m, userName: WatchSessionManager.shared.currentUserName)
                    }
                    WatchSessionManager.shared.sendMainTimerAction(action: "MAIN_TIMER_RESET", stoppedEndTime: stoppedEnd)
                }
            } else {
                // ★ サロン客席タイマーのアラーム消火
                let isMain = mainSeatIds.contains(id)
                if isMain {
                    if sendToPhone, let mainEvent = targets.first(where: { $0.seatId == id && $0.key.contains("-main@") }) {
                        // 鳴っていたタイマーの終了時刻。iPhone は席の終了時刻と照合し、別のタイマーなら止めない
                        let extra: [String: Any] = [
                            "kind": "main",
                            "expectedEnd": mainEvent.date.timeIntervalSince1970 * 1000.0
                        ]
                        WatchSessionManager.shared.applyLocalStop(seatId: id)
                        WatchSessionManager.shared.sendActionToPhone(
                            action: "STOP_ALARM",
                            seatId: id,
                            extra: extra
                        )
                    }
                } else if completeCheckIfNeeded {
                    // ★ チェック時間アラームの停止: Watch側でも即座にチェック完了を反映し、残りの全体タイマーを新しく入れ直す
                    WatchSessionManager.shared.applyLocalCheckComplete(seatId: id)
                    WatchSessionManager.shared.sendActionToPhone(
                        action: "STOP_ALARM",
                        seatId: id,
                        extra: ["kind": "check"]
                    )
                }
            }
        }
    }

    private func setSessionKey(_ key: String?) {
        sessionKey = key
        if let key = key {
            UserDefaults.standard.set(key, forKey: sessionKeyStoreKey)
        } else {
            UserDefaults.standard.removeObject(forKey: sessionKeyStoreKey)
        }
    }

    private func clearSession() {
        session = nil
        setSessionKey(nil)
        sessionStarted = false
    }

    private func invalidateCurrentSession() {
        guard let s = session else { return }
        let current = s
        let wasStarted = sessionStarted
        let key = sessionKey
        clearSession()
        safeInvalidateSession(current, wasStarted: wasStarted, associatedKey: key)
    }

    /// ★ watchOSペナルティ警告（「スケジュールされたアラームを再生できませんでした」）を100%防ぐ安全破棄メソッド
    private func safeInvalidateSession(_ s: WKExtendedRuntimeSession, wasStarted: Bool = false, associatedKey: String? = nil) {
        guard s.state != .invalid else {
            invalidatingSessions.remove(s)
            notifiedSessions.remove(s)
            sessionNotifyStartTimes.removeValue(forKey: s)
            backgroundAdoptedSessions.remove(s)
            return
        }
        invalidatingSessions.insert(s)
        // ★ 開始予定時刻まで残り3秒以内〜直後5秒以内の .scheduled セッションは、OS側でちょうど起動遷移中の可能性があるため、
        //   即座に invalidate() せず 1.2秒様子を見て、もしその間に didStart が呼ばれたら notifyUser を通してから破棄する
        if s.state == .scheduled && !wasStarted && !backgroundAdoptedSessions.contains(s),
           let key = associatedKey,
           let epStr = key.components(separatedBy: "@").last,
           let ep = Double(epStr) {
            let diff = ep - Date().timeIntervalSince1970
            if diff <= 3.0 && diff >= -5.0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                    guard let self = self else { return }
                    if s.state != .invalid {
                        if s.state == .running && !self.notifiedSessions.contains(s) {
                            self.notifiedSessions.insert(s)
                            self.sessionNotifyStartTimes[s] = Date()
                            s.notifyUser(hapticType: .notification, repeatHandler: nil)
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                                if s.state != .invalid { s.invalidate() }
                                self?.scheduleRetryAfterInvalidation(delay: 0.25)
                            }
                            return
                        }
                        s.invalidate()
                    }
                    self.scheduleRetryAfterInvalidation(delay: 0.25)
                }
                return
            }
        }

        let needsNotifyBeforeInvalidate = (s.state == .running || backgroundAdoptedSessions.contains(s) || wasStarted) && !notifiedSessions.contains(s)
        if needsNotifyBeforeInvalidate {
            // ★ 開始済み（またはバックグラウンド起床した）スマートアラームを notifyUser 未完了のまま即座に invalidate() すると、
            //   Carousel デーモンに notifyUser が届く前に XPC 接続が切れてシステム警告が出るため、
            //   notifyUser を呼んでから 0.8秒後に invalidate() を実行する
            notifiedSessions.insert(s)
            sessionNotifyStartTimes[s] = Date()
            s.notifyUser(hapticType: .notification, repeatHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                if s.state != .invalid {
                    s.invalidate()
                }
                self?.scheduleRetryAfterInvalidation(delay: 0.25)
            }
            return
        }

        // ★ すでに startNotifyUser 等で notifyUser を呼び出し済みの場合でも、呼び出し直後（0.8秒未満）に
        //   即座に invalidate() するとOS側に notifyUser が到達する前に切断されて警告が出るため、最低0.8秒の経過を保証する
        if let notifyStart = sessionNotifyStartTimes[s] {
            let elapsed = Date().timeIntervalSince(notifyStart)
            if elapsed < 0.8 {
                let waitDelay = max(0.15, 0.8 - elapsed)
                DispatchQueue.main.asyncAfter(deadline: .now() + waitDelay) { [weak self] in
                    if s.state != .invalid {
                        s.invalidate()
                    }
                    self?.scheduleRetryAfterInvalidation(delay: 0.25)
                }
                return
            }
        }

        s.invalidate()
        scheduleRetryAfterInvalidation(delay: 0.25)
    }

    /// ★ 前のセッションの破棄完了を待ってから次のスマートアラームを予約する（.sessionInProgress 競合エラー防止）
    private func scheduleRetryAfterInvalidation(delay: TimeInterval = 0.25) {
        retryScheduleWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.invalidatingSessions = self.invalidatingSessions.filter { $0.state != .invalid }
            if !self.invalidatingSessions.isEmpty {
                // まだOS側で破棄が完了していなくても、一定時間経過後はブロックを解除して再予約を試みる
                self.invalidatingSessions.removeAll()
            }
            self.refresh()
        }
        retryScheduleWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
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

    private func persistEvents() {
        let dicts = events.map { $0.toDictionary() }
        UserDefaults.standard.set(dicts, forKey: eventsStoreKey)
    }

    private func updateStatusText() {
        let smart: String
        if sessionStarted {
            smart = "鳴動中"
        } else if let s = session, s.state == .scheduled || s.state == .notStarted {
            if let key = sessionKey, let ev = events.first(where: { isSameTarget(key1: $0.key, key2: key) }) {
                let f = DateFormatter()
                f.dateFormat = "HH:mm:ss"
                smart = "予約 \(f.string(from: ev.date))"
            } else {
                smart = "予約あり"
            }
        } else if !invalidatingSessions.isEmpty {
            smart = "切替中…"
        } else {
            smart = "予約なし"
        }
        let text = "スマートアラーム:\(smart) / 鳴動\(ringing.count)件 / 通知:\(notificationAuth) / 音:\(soundOn ? "ON" : "OFF") / 前回終了:\(lastSessionEnd)"
        if text != statusText { statusText = text }
    }

    // MARK: - アプリ表示中＆常時表示（AOD: .inactive）中の強い振動（0.3秒ごとの超高速マックス連打）

    private func updateForegroundHaptics() {
        let shouldVibrate = !ringing.isEmpty && canScheduleSmartAlarm
        if shouldVibrate {
            guard hapticTimer == nil else { return }
            playNextHaptic()
            let t = Timer(timeInterval: 0.3, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                if self.ringing.isEmpty || !self.canScheduleSmartAlarm {
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

        // ★ すでに破棄完了したセッションを掃除し、まだOS側で破棄処理中のセッションがある場合は
        //   .sessionInProgress エラーを防ぐため破棄完了コールバック（または0.25秒タイマー）まで待つ
        invalidatingSessions = invalidatingSessions.filter { $0.state != .invalid }
        if !invalidatingSessions.isEmpty {
            return
        }

        // ★ 時刻到達済み・または開始直前（5秒以内）の予定のセッションは絶対に取り消さない
        if session != nil, let key = sessionKey, !isAcknowledged(key),
           let ev = events.first(where: { isSameTarget(key1: $0.key, key2: key) }), ev.date <= now.addingTimeInterval(5) {
            return
        }

        // 鳴動中なのにセッションが無い（アプリを開いた時点で過ぎていた等）→ 0.2秒後開始で即時予約し、
        // 画面が暗くなっても止めるまで鳴り続けるようにする。
        // ただし既にスマートアラームが一通り鳴って閉じた予定（smartAlarmCompletedKeys）は除外し、次の本体タイマーの予約を優先する！
        let target: WatchAlarmEvent?
        let startDate: Date
        if let r = currentRinging(now).first(where: { !isSmartAlarmCompleted($0.key) }) {
            // 即時鳴動セッションの開始はフォアグラウンド表示中のみ許可
            guard canScheduleSmartAlarm else { return }
            target = r
            startDate = now.addingTimeInterval(0.2)
        } else if let n = events
            .filter({ $0.date > now && !isAcknowledged($0.key) })
            .min(by: { $0.date < $1.date }) {
            target = n
            startDate = max(now.addingTimeInterval(0.5), n.date)
        } else {
            target = nil
            startDate = now
        }

        // ★ 正常に予約成立しているセッション（.scheduled または .running）のみを「予約済み」とみなす。
        //   もし過去の試行で .notStarted（予約未成立）や .invalid のまま残っているセッションがあれば即座にクリアして再予約へ進む！
        if let s = session {
            if s.state == .notStarted || s.state == .invalid {
                clearSession()
            } else if isSameTarget(key1: sessionKey, key2: target?.key), s.state == .scheduled || s.state == .running {
                return // 予約済み
            }
        }

        // ★ 既存の別予定セッションがある場合：
        //    1. 画面消灯中（バックグラウンド）は新規予約が不可能なため、既存セッションを絶対に破棄せず保護する！
        //    2. 画面点灯中（フォアグラウンド）なら、まず既存セッションを invalidate し、破棄完了後（0.25秒後）に新しい予定を予約する！
        //       （同一ターンで invalidate と start(at:) を同時実行すると .sessionInProgress で新セッションが死ぬため）
        if session != nil {
            guard canScheduleSmartAlarm else { return }
            invalidateCurrentSession()
            return
        }

        guard let t = target, startDate.timeIntervalSince(now) < 36 * 3600 else { return }
        // ★ watchOS の仕様上、WKExtendedRuntimeSession.start(at:) は .active または .inactive（canScheduleSmartAlarm == true）、
        //   または直前のスマートアラーム終了直後の引き継ぎウィンドウ（allowBackgroundHandoffScheduleUntil）で試行する。
        //   もしOS側に拒否されて .invalid になった場合は即座にクリアし、次回アクティブ化時に再予約する。
        let canAttemptSchedule = canScheduleSmartAlarm || (now < allowBackgroundHandoffScheduleUntil)
        guard canAttemptSchedule else { return }

        // ★ 前のセッションが完全に存在しないクリーンな状態で、最速新規予約
        let safeStartDate = max(Date().addingTimeInterval(0.5), startDate)
        let s = WKExtendedRuntimeSession()
        s.delegate = self
        s.start(at: safeStartDate)
        if s.state == .invalid {
            clearSession()
            return
        }
        session = s
        setSessionKey(t.key)
        sessionStarted = false
    }

    // 止めるまで強い振動を繰り返す（アプリ非表示時はシステムのアラーム画面になる）
    private func startNotifyUser(_ s: WKExtendedRuntimeSession) {
        notifiedSessions.insert(s)
        sessionNotifyStartTimes[s] = Date()
        let types = strongHaptics
        var step = 0
        s.notifyUser(hapticType: .failure) { next in
            step += 1
            next.pointee = types[step % types.count]
            return 0.4 // ★ 止めるまで手首が激しく揺れ続けるマックス振動！
        }
    }

    /// ★ スマートアラームが開始された瞬間、対象イベントを確実に鳴動状態へ移行して notifyUser を実行する
    private func activateSessionRingingAndNotify(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        let now = Date()
        if events.isEmpty, let rawEvents = UserDefaults.standard.array(forKey: eventsStoreKey) as? [[String: Any]] {
            events = rawEvents.compactMap { WatchAlarmEvent(dictionary: $0) }
        }
        if sessionKey == nil {
            sessionKey = UserDefaults.standard.string(forKey: sessionKeyStoreKey)
        }

        // セッションに対応するイベント（または直近15秒以内に終了時刻を迎える未消火イベント）を特定し、強制鳴動フラグを立てる
        var matchedEvent: WatchAlarmEvent? = nil
        if let key = sessionKey {
            matchedEvent = events.first(where: { isSameTarget(key1: $0.key, key2: key) && !isAcknowledged($0.key) })
        }
        if matchedEvent == nil {
            matchedEvent = events
                .filter { !isAcknowledged($0.key) && $0.date <= now.addingTimeInterval(15) }
                .min(by: { abs($0.date.timeIntervalSince(now)) < abs($1.date.timeIntervalSince(now)) })
        }

        if let ev = matchedEvent {
            armed[ev.key] = ev.date.timeIntervalSince1970
            forceRingingKeys.insert(ev.key)
            setSessionKey(ev.key)
            persist()
            // ★ 最優先で notifyUser を開始（watchOSのペナルティ警告を100%回避し、確実に振動を開始する）
            startNotifyUser(extendedRuntimeSession)
            refresh()
        } else if !currentRinging(now).isEmpty {
            let latest = currentRinging(now).last!
            setSessionKey(latest.key)
            startNotifyUser(extendedRuntimeSession)
            refresh()
        } else {
            // ★ すでに手動で止められた後の古いセッションがすれ違いで開始された場合でも、
            //   notifyUser を確実に実行してから少し待って閉じることで、watchOSのペナルティ警告を100%防止する
            notifiedSessions.insert(extendedRuntimeSession)
            sessionNotifyStartTimes[extendedRuntimeSession] = Date()
            extendedRuntimeSession.notifyUser(hapticType: .notification, repeatHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                guard let self = self else { return }
                if self.session === extendedRuntimeSession {
                    self.invalidateCurrentSession()
                } else if extendedRuntimeSession.state != .invalid {
                    extendedRuntimeSession.invalidate()
                }
                self.updateStatusText()
            }
        }
    }

    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        DispatchQueue.main.async {
            guard extendedRuntimeSession === self.session else {
                // 古いセッションがすれ違いで開始された場合も、警告防止のため必ず safeInvalidateSession を通す
                self.safeInvalidateSession(extendedRuntimeSession, wasStarted: true)
                return
            }
            self.sessionStarted = true
            self.lastSessionEnd = "-"
            self.activateSessionRingingAndNotify(extendedRuntimeSession)
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
            let wasBackgroundAdopted = self.backgroundAdoptedSessions.remove(extendedRuntimeSession) != nil
            self.notifiedSessions.remove(extendedRuntimeSession)
            self.sessionNotifyStartTimes.removeValue(forKey: extendedRuntimeSession)
            let isCurrent = (extendedRuntimeSession === self.session)
            guard wasInvalidating || isCurrent || wasBackgroundAdopted else { return }

            let wasStarted = (self.sessionStarted && isCurrent) || wasBackgroundAdopted
            let endedKey = self.sessionKey ?? UserDefaults.standard.string(forKey: self.sessionKeyStoreKey)
            if isCurrent {
                self.clearSession()
            }
            self.lastSessionEnd = self.reasonText(reason, error: error)
            if wasStarted, let k = endedKey {
                // ★ 一度鳴動開始して閉じたスマートアラームを記録し、次回予約で本体タイマー（2回目）へ確実に移行させる
                self.smartAlarmCompletedKeys.insert(k)
            }
            // ★ システムのスマートアラーム画面（「"AssistTimer" からのアラームです。 [開く] [終了]」）で操作された場合（reason == .none）:
            //   - すでにアプリがフォアグラウンド（.active）に遷移している場合（「開く」が押された場合）は、forceRingingKeys に保持して次の画面（alarmOverlay）を即座に表示する。
            //   - アプリが非アクティブ（.inactive / .background）の場合は、watchOSによるバックグラウンド即時凍結（サスペンド）で処理が中断されるのを防ぐため、
            //     遅延なしで即座（同期処理内）に完了処理・通知削除・文字盤00:00保存・後続タイマー予約を完結させつつ、
            //     もし「開く」が押されて直後に appBecameActive() が呼ばれた場合はスナップショットからオーバーレイ（次の画面）を復元する！
            if !wasInvalidating && (wasStarted || endedKey != nil) && reason == WKExtendedRuntimeSessionInvalidationReason.none {
                self.allowBackgroundHandoffScheduleUntil = Date().addingTimeInterval(2.5)
                let alreadyActive = (WKApplication.shared().applicationState == .active)
                    || (Date().timeIntervalSince(self.lastAppBecameActiveAt) < 0.8)
                if alreadyActive {
                    if let k = endedKey, !self.isAcknowledged(k) {
                        self.forceRingingKeys.insert(k)
                    }
                    self.refresh()
                    self.scheduleRetryAfterInvalidation(delay: 0.25)
                    return
                }

                let now = Date()
                let matchedEv: WatchAlarmEvent? = {
                    if let k = endedKey, let ev = self.events.first(where: { self.isSameTarget(key1: $0.key, key2: k) }) {
                        return ev
                    }
                    return self.currentRinging(now).last
                }()

                if let ev = matchedEv {
                    let isCheck = ev.key.contains("-check@")
                    let preMain = WatchSessionManager.shared.mainTimer
                    let preSeat = WatchSessionManager.shared.timers.first(where: { $0.id == ev.seatId })
                    self.lastSystemDismissedSnapshot = SystemDismissedSnapshot(
                        event: ev,
                        dismissedAt: now,
                        isCheckEvent: isCheck,
                        preMainTimer: preMain,
                        preSeatTimer: preSeat
                    )
                    self.forceRingingKeys.insert(ev.key)

                    if isCheck {
                        // ★ チェックタイマーは遅延ゼロで即座にチェック完了＆残りの本タイマー予約まで完結させる
                        self.acknowledgeRinging(sendToPhone: true, completeCheckIfNeeded: true)
                    } else {
                        // ★ システムアラーム画面（「"AssistTimer" からのアラームです。 [開く] [終了]」）では、
                        //   「開く」「終了」のどちらを押しても 00:00 には戻さず、超過（カウントアップ）状態を維持する。
                        //   アラーム音・振動・保留通知のみを消火し、「開く」でアプリが前面に来た場合は appBecameActive() で
                        //   消化タイム・オーバーレイ表示（「シャンプーに入る」「タイマーを止める」等）を復元する。
                        self.acknowledgeRinging(sendToPhone: false, completeCheckIfNeeded: false)
                        WidgetSync.save(
                            timers: WatchSessionManager.shared.timers,
                            mainTimer: WatchSessionManager.shared.mainTimer,
                            userName: WatchSessionManager.shared.currentUserName
                        )
                    }
                } else {
                    self.acknowledgeRinging(sendToPhone: false, completeCheckIfNeeded: true)
                }
                self.notificationSignature = ""
                self.refresh()
                self.scheduleRetryAfterInvalidation(delay: 0.25)
                return
            }
            // ★ 前セッション破棄完了の瞬間に、残っている次の予定（チェック後の本タイマーなど）を即座に再スケジュール！
            if reason != .sessionInProgress {
                self.refresh()
            }
            self.scheduleRetryAfterInvalidation(delay: reason == .sessionInProgress ? 0.35 : 0.2)
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
        //    非同期ブロックの内側に置くと、手首を下げた瞬間にアプリが中断され通知が登録されない致命的バグを防止。
        let activeKeys = Set(targets.map { $0.key })
        scheduledNotificationEventKeys = scheduledNotificationEventKeys.intersection(activeKeys)

        var count = 0
        var newIdentifiers = Set<String>()
        for e in targets {
            for (i, offset) in offsets.enumerated() {
                if count >= limit { break }
                let interval = e.date.addingTimeInterval(offset).timeIntervalSinceNow
                // すでに過ぎたリピートオフセットを大量に1秒後へ同時登録するとwatchOSの通知スパム抑制に引っかかるため、
                // 初回(i==0)の直近5秒以内のみ即時発火を許容し、それ以外は未来のオフセットのみ登録する
                if i == 0 {
                    if interval < -5 { continue }
                } else {
                    if interval < 0.5 { continue }
                }
                let id = "\(prefix)\(e.key).\(i)"
                newIdentifiers.insert(id)
                count += 1

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
            }
            scheduledNotificationEventKeys.insert(e.key)
        }

        // ★ 2. 不要になった古い通知IDのみ非同期で掃除（新規予約の登録をブロック・遅延させない）
        center.getPendingNotificationRequests { requests in
            let stale = requests.map(\.identifier).filter { $0.hasPrefix(prefix) && !newIdentifiers.contains($0) }
            if !stale.isEmpty {
                center.removePendingNotificationRequests(withIdentifiers: stale)
            }
        }
    }

    // アプリ表示中は画面のアラーム表示＋振動で知らせるので通知バナーは出さない（常時表示 .inactive やバックグラウンドでは通知＋触覚も確実に出す）
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let reqId = notification.request.identifier
        DispatchQueue.main.async {
            if reqId.hasPrefix(self.notificationPrefix) {
                let stripped = String(reqId.dropFirst(self.notificationPrefix.count))
                if let dotIdx = stripped.lastIndex(of: ".") {
                    let eventKey = String(stripped[..<dotIdx])
                    if !self.isAcknowledged(eventKey) {
                        self.forceRingingKeys.insert(eventKey)
                    }
                }
            }
            self.playNextHaptic()
            self.refresh()
            if WKApplication.shared().applicationState == .active {
                completionHandler([])
            } else {
                completionHandler([.banner, .sound, .list])
            }
        }
    }

    // ★ 通知タップ（「開く」）または「アラーム停止」ボタン押下時:
    //   アラーム音・振動およびオーバーレイのみを消火して一覧画面（赤色の超過カウント +00:xx カード表示）を直接見せ、
    //   超過カウントアップ（超過 00:01...）は自動終了させない！
    //   アプリ画面でカードをタップして「タイム終了」「止める」「シャンプーに入る」等を明示的に選んだ時のみ 00:00 に戻る仕様。
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let reqId = response.notification.request.identifier
        DispatchQueue.main.async {
            if self.events.isEmpty, let rawEvents = UserDefaults.standard.array(forKey: self.eventsStoreKey) as? [[String: Any]] {
                self.events = rawEvents.compactMap { WatchAlarmEvent(dictionary: $0) }
            }
            // 通知ID（"assisttimer.alarm.<eventKey>.<index>"）から対象イベントキーを特定し、
            // コールドスタート時などでも確実に消火対象（forceRingingKeys）へ含めてオーバーレイを閉じ、チェック完了処理等を通す
            if reqId.hasPrefix(self.notificationPrefix) {
                let stripped = String(reqId.dropFirst(self.notificationPrefix.count))
                if let dotIdx = stripped.lastIndex(of: ".") {
                    let eventKey = String(stripped[..<dotIdx])
                    if !self.isAcknowledged(eventKey) {
                        self.forceRingingKeys.insert(eventKey)
                    }
                }
            }
            let shouldSendStopToPhone = false
            self.stop(sendToPhone: shouldSendStopToPhone)
            completionHandler()
        }
    }
}
