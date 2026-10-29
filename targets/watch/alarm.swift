import Foundation
import SwiftUI
import WatchKit
import UserNotifications
import AVFoundation

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
    let watchSoundOn: Bool

    func toDictionary() -> [String: Any] {
        return [
            "key": key,
            "seatId": seatId,
            "timestamp": date.timeIntervalSince1970,
            "title": title,
            "watchSoundOn": watchSoundOn
        ]
    }

    init(key: String, seatId: String, date: Date, title: String, watchSoundOn: Bool = false) {
        self.key = key
        self.seatId = seatId
        self.date = date
        self.title = title
        self.watchSoundOn = watchSoundOn
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
        self.watchSoundOn = (dictionary["watchSoundOn"] as? NSNumber)?.boolValue ?? (dictionary["watchSoundOn"] as? Bool) ?? false
    }
}

final class WatchAlarmCoordinator: NSObject, ObservableObject, WKExtendedRuntimeSessionDelegate, UNUserNotificationCenterDelegate {
    static let shared = WatchAlarmCoordinator()

    @Published private(set) var ringing: [WatchAlarmEvent] = []
    // システムのスマートアラーム画面で「開く」を押した時に、超過カウントを維持したままアクション分岐画面を開くためのイベント通知
    @Published private(set) var pendingOpenedAlarmEvent: WatchAlarmEvent? = nil
    // 診断パネル用
    @Published private(set) var statusText: String = "予約なし"

    func clearPendingOpenedAlarmEvent() {
        pendingOpenedAlarmEvent = nil
    }

    private var lastPeerNotifText: String = ""
    private var lastPeerNotifAt: Date = .distantPast

    /// 共有相手（関係者の席）でチェック完了・タイマー停止・担当指名・募集などが行われた際にWatchへ通知する
    func postPeerActionNotification(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let now = Date()
        if trimmed == lastPeerNotifText && now.timeIntervalSince(lastPeerNotifAt) < 2.5 {
            return
        }
        lastPeerNotifText = trimmed
        lastPeerNotifAt = now

        // 手首への触覚フィードバック（フォアグラウンド時は showNotification 側でも鳴るためバックグラウンド時のみ直接鳴らす）
        if WKApplication.shared().applicationState != .active {
            WKInterfaceDevice.current().play(.notification)
            let content = UNMutableNotificationContent()
            content.title = "AssistTimer"
            content.body = trimmed
            content.sound = .default
            if #available(watchOS 8.0, *) {
                content.interruptionLevel = .timeSensitive
            }
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.2, repeats: false)
            let reqId = "assisttimer.peer.\(UUID().uuidString)"
            let req = UNNotificationRequest(identifier: reqId, content: content, trigger: trigger)
            UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
        }
    }

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
    private var sessionScheduledAt: Date = .distantPast
    private var sessionPresentedSystemAlert = false
    private var wasBackgroundWhenSystemAlertShown = false
    private var invalidatingSessions: Set<WKExtendedRuntimeSession> = []
    private var intentionallyInvalidatedSessions: Set<WKExtendedRuntimeSession> = []
    private var sessionKeysBySession: [WKExtendedRuntimeSession: String] = [:]
    private var nextSmartAlarmScheduleAllowedAt: Date = .distantPast
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
    // ★ アラーム停止操作直後にフォアグラウンド遷移等でスマートアラーム（2枚目）が誤って予約・発火するのを防ぐガード時刻
    private var suppressSmartAlarmUntil: Date = .distantPast
    private var retryScheduleWorkItem: DispatchWorkItem?
    private var lastSessionEnd: String = "-"
    private var notificationAuth: String = "?"

    private var notificationSignature = "__INIT__"
    private var authRequested = false
    private var hapticStep = 0
    private var hapticTimer: Timer?
    private var audioPlayer: AVAudioPlayer?
    private static let alarmWavData: Data = WatchAlarmCoordinator.generateAlarmWavData()

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
        // ★ options: []（バックグラウンド実行）にすることで、通知の「アラーム停止」を押した時にアプリを前面起動させず、
        //   1回押すだけでその場で通知が閉じてスマートアラーム（2枚目）が後から立ち上がるのを100%防ぐ！
        let stopAction = UNNotificationAction(identifier: "STOP_ACTION", title: "アラーム停止", options: [])
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
            // すでに予約済み・arm済みのメインタイマーと実質同一（±10秒以内、または両方とも超過到達済み、またはバックグラウンドでスマートアラーム予約済み）なら、
            // 既存の終了時刻を維持してスマートアラームの破棄・再予約衝突および超過時の誤破棄を完全に防ぐ
            let existingMain = events.first(where: { $0.seatId == m.id && $0.key.contains("-main@") && !isAcknowledged($0.key) })
            let finalMainEnd: Date
            if let existing = existingMain,
               (abs(existing.date.timeIntervalSince(effectiveEnd)) <= 10 ||
                (existing.date <= nowDate && effectiveEnd <= nowDate.addingTimeInterval(2)) ||
                (!canScheduleSmartAlarm && isSameTarget(key1: sessionKey, key2: existing.key) && abs(existing.date.timeIntervalSince(effectiveEnd)) <= 30)) {
                finalMainEnd = existing.date
            } else {
                finalMainEnd = effectiveEnd
            }
            let mainEpoch = Int(finalMainEnd.timeIntervalSince1970)
            let mainKey = "\(m.id)-main@\(mainEpoch)"
            // ★ カウントダウン中（未来の終了時刻）または既存稼働中の超過イベントは確実にarm登録を維持し、過去の古い消火履歴と衝突していた場合はクリアして確実に鳴動させる
            let wasMainArmed = existingMain != nil || armed.keys.contains(where: { $0.hasPrefix("\(m.id)-main@") && !isAcknowledged($0) }) || isMainTimerRingingOrDue
            if finalMainEnd > nowDate.addingTimeInterval(-2) || (wasMainArmed && finalMainEnd > nowDate.addingTimeInterval(-10800)) {
                if armed[mainKey] == nil {
                    armed[mainKey] = finalMainEnd.timeIntervalSince1970
                    ackChanged = true
                }
            }
            if finalMainEnd > nowDate {
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
                    title: "⏱️ メインタイマー 終了",
                    watchSoundOn: m.watchAlarmSoundEnabled || soundOn
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

        // ★ 2. 共有タイマー（客席タイマー）のアラーム対象登録（関係者のみ：無関係な他人の席では鳴らさない）
        let activeUser = currentUserName ?? ""
        for t in timers where t.isRunning {
            let label = t.displaySeatName
            let existingSeat = events.first(where: { $0.seatId == t.id && $0.key.contains("-main@") && !isAcknowledged($0.key) })
            let finalSeatEnd: Date
            if let existing = existingSeat,
               (abs(existing.date.timeIntervalSince(t.targetEndTime)) <= 10 ||
                (existing.date <= nowDate && t.targetEndTime <= nowDate.addingTimeInterval(2))) {
                finalSeatEnd = existing.date
            } else {
                finalSeatEnd = t.targetEndTime
            }
            if t.shouldAlertMainTimer(for: activeUser) {
                let mainEpoch = Int(finalSeatEnd.timeIntervalSince1970)
                let mainKey = "\(t.id)-main@\(mainEpoch)"
                let wasSeatArmed = existingSeat != nil || armed.keys.contains(where: { $0.hasPrefix("\(t.id)-main@") && !isAcknowledged($0) })
                if finalSeatEnd > nowDate.addingTimeInterval(-2) || (wasSeatArmed && finalSeatEnd > nowDate.addingTimeInterval(-10800)) {
                    if armed[mainKey] == nil {
                        armed[mainKey] = finalSeatEnd.timeIntervalSince1970
                        ackChanged = true
                    }
                }
                if finalSeatEnd > nowDate {
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
                        title: "\(label) タイム終了",
                        watchSoundOn: t.watchAlarmSoundEnabled || soundOn
                    ))
                }
            }
            if !t.isCheckCompleted, let checkEnd = t.checkTargetEndTime, (t.checkTotalSeconds ?? 0) > 0, t.shouldAlertCheckTimer(for: activeUser) {
                let existingCheck = events.first(where: { $0.seatId == t.id && $0.key.contains("-check@") && !isAcknowledged($0.key) })
                let finalCheckEnd: Date
                if let existing = existingCheck,
                   (abs(existing.date.timeIntervalSince(checkEnd)) <= 10 ||
                    (existing.date <= nowDate && checkEnd <= nowDate.addingTimeInterval(2))) {
                    finalCheckEnd = existing.date
                } else {
                    finalCheckEnd = checkEnd
                }
                let checkEpoch = Int(finalCheckEnd.timeIntervalSince1970)
                let checkKey = "\(t.id)-check@\(checkEpoch)"
                let wasCheckArmed = existingCheck != nil || armed.keys.contains(where: { $0.hasPrefix("\(t.id)-check@") && !isAcknowledged($0) })
                if finalCheckEnd > nowDate.addingTimeInterval(-2) || (wasCheckArmed && finalCheckEnd > nowDate.addingTimeInterval(-10800)) {
                    if armed[checkKey] == nil {
                        armed[checkKey] = finalCheckEnd.timeIntervalSince1970
                        ackChanged = true
                    }
                }
                if finalCheckEnd > nowDate {
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
                        title: "\(label) \(t.displayCheckProcess)時間",
                        watchSoundOn: t.watchAlarmSoundEnabled || soundOn
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
        // ★ iPhone側やWatchの席カード操作で停止・完了され、同一席・同一種別の予定がリストから完全に消えた場合のみ、
        //   表示済みの1枚目（通知）も鳴動中・予約中の2枚目（スマートアラーム）も即座に自動消去する
        //   （※時間延長・微調整等で同一席の新しい終了時刻イベントが list にある場合は消火扱いにしない）
        let removedFromList = events.filter { oldEv in
            let isCheck = oldEv.key.contains("-check@")
            let kindTag = isCheck ? "-check@" : "-main@"
            return !list.contains(where: { $0.seatId == oldEv.seatId && $0.key.contains(kindTag) })
        }
        if !removedFromList.isEmpty {
            for oldEv in removedFromList {
                acknowledged[oldEv.key] = oldEv.date.timeIntervalSince1970
                removeForceRinging(matching: oldEv.key)
                removeNotifications(forEventKey: oldEv.key)
                if let sKey = sessionKey, isSameTarget(key1: sKey, key2: oldEv.key) {
                    invalidateCurrentSession()
                }
            }
            ackChanged = true
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
        if ringing.isEmpty {
            stopForegroundHaptics()
        }
        smartAlarmCompletedKeys = smartAlarmCompletedKeys.filter { !$0.hasPrefix("\(seatId)-main@") }
        persist()

        // 2. 既存のチェック用スマートアラームセッションがあれば安全に破棄する
        if let key = sessionKey, key.hasPrefix("\(seatId)-check@") {
            invalidateCurrentSession()
        }

        // 3. 通知署名をリセットして残りの全体タイマー通知を確実に再構成・再登録する
        notificationSignature = "__FORCE__"
        update(timers: timers, mainTimer: mainTimer, soundOn: soundOn, currentUserName: currentUserName)

        // 4. 前のセッションの破棄完了およびシステムアラート消去アニメーション完了に備えて段階的に再確認
        scheduleRetryAfterInvalidation(delay: 0.25)
    }

    /// メインタイマーがユーザーによって明示的にリセット・一時停止された時に呼ぶ
    func acknowledgeMainTimer(skipRefresh: Bool = false) {
        suppressSmartAlarmUntil = Date().addingTimeInterval(3.0)
        var changed = false
        var allMainKeys = Set<String>()
        for ev in events where ev.seatId == "main-timer" {
            acknowledged[ev.key] = ev.date.timeIntervalSince1970
            allMainKeys.insert(ev.key)
            removeForceRinging(matching: ev.key)
            scheduledNotificationEventKeys.remove(ev.key)
            restoredOverlayEvents = restoredOverlayEvents.filter { !isSameTarget(key1: $0.key, key2: ev.key) }
            changed = true
        }
        for ev in ringing where ev.seatId == "main-timer" {
            acknowledged[ev.key] = ev.date.timeIntervalSince1970
            allMainKeys.insert(ev.key)
            removeForceRinging(matching: ev.key)
            scheduledNotificationEventKeys.remove(ev.key)
            restoredOverlayEvents = restoredOverlayEvents.filter { !isSameTarget(key1: $0.key, key2: ev.key) }
            changed = true
        }
        for (k, ts) in armed where k.hasPrefix("main-timer") {
            acknowledged[k] = ts
            allMainKeys.insert(k)
            removeForceRinging(matching: k)
            scheduledNotificationEventKeys.remove(k)
            changed = true
        }
        for k in scheduledNotificationEventKeys where k.hasPrefix("main-timer") {
            allMainKeys.insert(k)
            scheduledNotificationEventKeys.remove(k)
        }
        if let snap = lastSystemDismissedSnapshot, snap.event.seatId == "main-timer" {
            lastSystemDismissedSnapshot = nil
            pendingSystemDismissPhoneSyncWorkItem?.cancel()
            pendingSystemDismissPhoneSyncWorkItem = nil
        }
        events.removeAll { $0.seatId == "main-timer" }
        if changed {
            persist()
            persistEvents()
        }
        let mainIds = allMainKeys.flatMap { k in
            repeatOffsets.indices.map { "\(notificationPrefix)\(k).\($0)" }
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
        notificationSignature = "__FORCE__"
        if !skipRefresh {
            refresh()
        }
    }

    /// 客席タイマー（全体またはチェックのみ）がユーザーによって明示的に停止・完了・延長された時にピンポイントで消火する
    /// （別席や後続の未発火スマートアラームを誤って消火しないための安全な席単位消火メソッド）
    func acknowledgeSeatTimer(seatId: String, checkOnly: Bool = false, skipRefresh: Bool = false) {
        let prefix = checkOnly ? "\(seatId)-check@" : "\(seatId)-"
        var changed = false
        var matchedKeys = Set<String>()

        func matchesTarget(_ key: String, eventSeatId: String? = nil) -> Bool {
            if checkOnly {
                if let sId = eventSeatId {
                    return sId == seatId && key.contains("-check@")
                }
                return key.hasPrefix("\(seatId)-check@")
            } else {
                if let sId = eventSeatId {
                    return sId == seatId
                }
                return key.hasPrefix("\(seatId)-main@") || key.hasPrefix("\(seatId)-check@")
            }
        }

        for ev in events where matchesTarget(ev.key, eventSeatId: ev.seatId) {
            acknowledged[ev.key] = ev.date.timeIntervalSince1970
            matchedKeys.insert(ev.key)
            removeForceRinging(matching: ev.key)
            scheduledNotificationEventKeys.remove(ev.key)
            restoredOverlayEvents = restoredOverlayEvents.filter { !isSameTarget(key1: $0.key, key2: ev.key) }
            changed = true
        }
        for ev in ringing where matchesTarget(ev.key, eventSeatId: ev.seatId) {
            acknowledged[ev.key] = ev.date.timeIntervalSince1970
            matchedKeys.insert(ev.key)
            removeForceRinging(matching: ev.key)
            scheduledNotificationEventKeys.remove(ev.key)
            restoredOverlayEvents = restoredOverlayEvents.filter { !isSameTarget(key1: $0.key, key2: ev.key) }
            changed = true
        }
        for (k, ts) in armed where matchesTarget(k) {
            acknowledged[k] = ts
            matchedKeys.insert(k)
            removeForceRinging(matching: k)
            scheduledNotificationEventKeys.remove(k)
            changed = true
        }
        for k in scheduledNotificationEventKeys where matchesTarget(k) {
            matchedKeys.insert(k)
            scheduledNotificationEventKeys.remove(k)
        }
        if let snap = lastSystemDismissedSnapshot,
           snap.event.seatId == seatId,
           (!checkOnly || snap.isCheckEvent) {
            lastSystemDismissedSnapshot = nil
            pendingSystemDismissPhoneSyncWorkItem?.cancel()
            pendingSystemDismissPhoneSyncWorkItem = nil
        }
        events.removeAll { matchesTarget($0.key, eventSeatId: $0.seatId) }
        if changed {
            persist()
            persistEvents()
        }
        let notifIds = matchedKeys.flatMap { k in
            repeatOffsets.indices.map { "\(notificationPrefix)\(k).\($0)" }
        }
        if !notifIds.isEmpty {
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: notifIds)
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: notifIds)
        }
        ringing.removeAll { matchesTarget($0.key, eventSeatId: $0.seatId) }
        if ringing.isEmpty {
            stopForegroundHaptics()
        }
        if let key = sessionKey, (key.hasPrefix(prefix) || matchesTarget(key)) {
            invalidateCurrentSession()
        }
        notificationSignature = "__FORCE__"
        if !skipRefresh {
            refresh()
        }
    }

    /// アプリ表示中に1秒ごとに呼ぶ
    func tick() {
        refresh()
    }

    /// 「止める」ボタン（カスタムボタン側で別途アクション送信する場合は sendToPhone: false を指定可能）
    func stop(sendToPhone: Bool = true, completeCheckIfNeeded: Bool = true, explicitTarget: WatchAlarmEvent? = nil, skipRefresh: Bool = false) {
        suppressSmartAlarmUntil = Date().addingTimeInterval(3.0)
        pendingSystemDismissPhoneSyncWorkItem?.cancel()
        pendingSystemDismissPhoneSyncWorkItem = nil
        lastSystemDismissedSnapshot = nil
        acknowledgeRinging(sendToPhone: sendToPhone, completeCheckIfNeeded: completeCheckIfNeeded, explicitTarget: explicitTarget)
        stopForegroundHaptics()
        // ★ すでに後続の全体タイマー等のために新しく予約成立（.scheduled）している未消火セッションは破棄せず保護し、
        //   鳴動中・消火済みのセッションは遅延なく即座に破棄する
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
        for adopted in Array(backgroundAdoptedSessions) {
            intentionallyInvalidatedSessions.insert(adopted)
            sessionKeysBySession.removeValue(forKey: adopted)
            if adopted.state != .invalid {
                adopted.invalidate()
            }
            backgroundAdoptedSessions.remove(adopted)
        }
        notificationSignature = "__FORCE__"
        if !skipRefresh {
            refresh()
            scheduleRetryAfterInvalidation(delay: 0.25)
        }
    }

    /// アプリが表示状態になった時（スマートアラームの予約・通知の許可確認はこの時しかできない）
    func appBecameActive() {
        let now = Date()
        lastAppBecameActiveAt = now

        // ★ ケースA: システムのスマートアラーム画面（「"AssistTimer" からのアラームです。 [開く] [終了]」）で
        //   左側の「開く」が押され、セッションがまだ .running（または破棄直前）のままフォアグラウンドに移行した場合:
        //   アラームの振動のみを止め、超過カウントアップ（+00:xx）は維持したままアクション分岐画面（「タイマーを止める」等）へ移行する！
        if sessionStarted || (session != nil && notifiedSessions.contains(session!)) {
            let endedKey = sessionKey ?? UserDefaults.standard.string(forKey: sessionKeyStoreKey)
            let matchedEv: WatchAlarmEvent? = {
                if let k = endedKey, let ev = events.first(where: { isSameTarget(key1: $0.key, key2: k) }) {
                    return ev
                }
                if let k = endedKey, let ev = eventFromKey(k) {
                    return ev
                }
                return currentRinging(now).last
            }()
            if let k = endedKey {
                smartAlarmCompletedKeys.insert(k)
            }
            if let ev = matchedEv {
                removeNotifications(forEventKey: ev.key)
            }
            // sendToPhone: false, completeCheckIfNeeded: false にすることで、00:00へリセットせず超過カウントアップを維持したまま「タイマーを止める」画面へ移行
            acknowledgeRinging(sendToPhone: false, completeCheckIfNeeded: false, explicitTarget: matchedEv)
            stopForegroundHaptics()
            invalidateCurrentSession()
            if let ev = matchedEv {
                pendingOpenedAlarmEvent = ev
            }
            notificationSignature = "__FORCE__"
            requestAuthorizationIfNeeded()
            refreshNotificationAuth()
            refresh()
            return
        }

        // ★ ケースB: 文字盤（.background）でシステムアラームの「開く」を押した際、watchOSの順序で didInvalidateWith が
        //   appBecameActive より数十〜数百ミリ秒先に呼ばれていた場合も、直前スナップショットからアクション分岐画面へ移行する！
        if let snap = lastSystemDismissedSnapshot,
           now.timeIntervalSince(snap.dismissedAt) < 1.5 {
            lastSystemDismissedSnapshot = nil
            pendingSystemDismissPhoneSyncWorkItem?.cancel()
            pendingSystemDismissPhoneSyncWorkItem = nil
            pendingOpenedAlarmEvent = snap.event
        } else {
            lastSystemDismissedSnapshot = nil
            pendingSystemDismissPhoneSyncWorkItem?.cancel()
            pendingSystemDismissPhoneSyncWorkItem = nil
        }

        requestAuthorizationIfNeeded()
        refreshNotificationAuth()
        refresh()
    }

    /// アプリ終了中にスマートアラームの時刻になり、システムがアプリを起動した時
    func adopt(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        let block = {
            extendedRuntimeSession.delegate = self
            if self.sessionKey == nil {
                self.sessionKey = UserDefaults.standard.string(forKey: self.sessionKeyStoreKey)
            }
            if self.events.isEmpty, let rawEvents = UserDefaults.standard.array(forKey: self.eventsStoreKey) as? [[String: Any]] {
                self.events = rawEvents.compactMap { WatchAlarmEvent(dictionary: $0) }
            }
            // ★ すでに通知の「アラーム停止」等で停止済み、または「今まさに鳴るべき未消火イベント（現在時刻＋15秒以内）」が存在しない場合は、
            //   （別席やチェック後の未来の本タイマーしか残っていない場合も含め）2枚目のシステムアラームを起動せず即座に破棄する
            let now = Date()
            let isAlreadyAcked = (self.sessionKey != nil && self.isAcknowledged(self.sessionKey!))
            let hasDueUnackedEvent = self.events.contains { !self.isAcknowledged($0.key) && $0.date <= now.addingTimeInterval(15) }
            if isAlreadyAcked || !hasDueUnackedEvent {
                self.intentionallyInvalidatedSessions.insert(extendedRuntimeSession)
                self.sessionKeysBySession.removeValue(forKey: extendedRuntimeSession)
                if extendedRuntimeSession.state != .invalid {
                    extendedRuntimeSession.invalidate()
                }
                self.clearSession()
                self.updateStatusText()
                return
            }
            if let k = self.sessionKey {
                self.sessionKeysBySession[extendedRuntimeSession] = k
            }
            self.backgroundAdoptedSessions.insert(extendedRuntimeSession)
            self.session = extendedRuntimeSession
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

    // ★ 2つのイベントキーが実質的に同一ターゲット（同一席・同一種別、かつ通信丸め誤差の2秒以内）か判定
    //   （※15秒にすると、停止直後に短いテストタイマー等を再スタートした際に「停止済み」と誤認して鳴らなくなるため2秒に厳密化）
    //   クラウドUUID到着前後で「seat-<番号>」と「<UUID>」にキーが切り替わった同一席も一致とみなす。
    private func isSameTarget(key1: String?, key2: String?) -> Bool {
        guard let k1 = key1, let k2 = key2 else { return false }
        if k1 == k2 { return true }
        let parts1 = k1.components(separatedBy: "@")
        let parts2 = k2.components(separatedBy: "@")
        guard parts1.count == 2, parts2.count == 2,
              let epoch1 = Int(parts1[1]), let epoch2 = Int(parts2[1]),
              abs(epoch1 - epoch2) <= 2 else {
            return false
        }
        if parts1[0] == parts2[0] { return true }
        let isCheck1 = parts1[0].hasSuffix("-check")
        let isCheck2 = parts2[0].hasSuffix("-check")
        let isMain1 = parts1[0].hasSuffix("-main")
        let isMain2 = parts2[0].hasSuffix("-main")
        guard (isCheck1 && isCheck2) || (isMain1 && isMain2) else { return false }
        let suffixLen = isCheck1 ? 6 : 5
        let sid1 = String(parts1[0].dropLast(suffixLen))
        let sid2 = String(parts2[0].dropLast(suffixLen))
        guard sid1 != "main-timer" && sid2 != "main-timer" else { return sid1 == sid2 }
        if sid1.hasPrefix("seat-"), let num = Int(sid1.dropFirst(5)), num > 0 {
            let matches = WatchSessionManager.shared.timers.filter { $0.seatNumber == num }
            if matches.count == 1 && matches[0].id == sid2 { return true }
        }
        if sid2.hasPrefix("seat-"), let num = Int(sid2.dropFirst(5)), num > 0 {
            let matches = WatchSessionManager.shared.timers.filter { $0.seatNumber == num }
            if matches.count == 1 && matches[0].id == sid1 { return true }
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
        //    - 鳴動中（sessionStarted == true）の場合: 対象の予定が明示的に止められたか、予定リストから消滅した場合に即破棄
        //      （※ s.state == .invalid にすでになっている場合は、ユーザーが2枚目の[開く]/[終了]を押した直後のため didInvalidateWith の停止処理に委ねる）
        //    - 予約中（sessionStarted == false）の場合:
        //      ・バックグラウンド起床直後（backgroundAdoptedSessionsに含まれる）のセッションは didStart 前のため未消火の間は保護し、消火済みなら即破棄
        //      ・予定が完全に消滅した（events.isEmpty && ringing.isEmpty）または対象キーが明示的に消火済み（isAcknowledged）なら遅延なく即座に破棄
        if let s = session {
            let acked = (sessionKey != nil && isAcknowledged(sessionKey!))
            let targetStillExists: Bool = {
                guard let key = sessionKey else { return false }
                return events.contains { isSameTarget(key1: $0.key, key2: key) } || ringing.contains { isSameTarget(key1: $0.key, key2: key) }
            }()
            if sessionStarted || notifiedSessions.contains(s) {
                if s.state == .invalid {
                    // ★ 2枚目（スマートアラーム）で「開く」を押して didInvalidateWith より先に appBecameActive() -> refresh() が走った場合、
                    //   一瞬だけ赤い alarmOverlay が出たり振動したりするのを防ぐため、鳴動表示を抑止して didInvalidateWith の完了処理を待つ
                    ringing = []
                    stopForegroundHaptics()
                } else if acked || !targetStillExists || (events.isEmpty && ringing.isEmpty) {
                    invalidateCurrentSession()
                }
            } else if acked || (events.isEmpty && ringing.isEmpty) {
                invalidateCurrentSession()
            } else if !backgroundAdoptedSessions.contains(s) {
                let seatRemoved: Bool = {
                    guard let key = sessionKey, let seatPrefix = key.components(separatedBy: "@").first else { return false }
                    return !events.contains { $0.key.hasPrefix(seatPrefix) }
                }()
                if seatRemoved {
                    invalidateCurrentSession()
                } else if s.state == .invalid {
                    clearSession()
                }
            }
        }

        scheduleSmartAlarmIfPossible(now)
        updateForegroundHaptics()
        updateAlarmAudio()
        rescheduleNotifications(now)
        updateStatusText()
    }

    private func findMatchingSeat(for seatId: String, title: String = "") -> SeatTimerItem? {
        let timers = WatchSessionManager.shared.timers
        if let exact = timers.first(where: { $0.id == seatId }) {
            return exact
        }
        if let byTag = timers.first(where: { "seat-\($0.seatNumber)" == seatId || String($0.seatNumber) == seatId }) {
            return byTag
        }
        if seatId.hasPrefix("seat-"),
           let num = Int(seatId.dropFirst(5)),
           num > 0 && num < 1000,
           let byNum = timers.first(where: { $0.seatNumber == num }) {
            return byNum
        }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedTitle.isEmpty,
           let byTitle = timers.first(where: { !$0.displaySeatName.isEmpty && trimmedTitle.hasPrefix($0.displaySeatName) }) {
            return byTitle
        }
        return nil
    }

    private func eventFromKey(_ key: String) -> WatchAlarmEvent? {
        if let existing = events.first(where: { isSameTarget(key1: $0.key, key2: key) }) {
            return existing
        }
        if let r = ringing.first(where: { isSameTarget(key1: $0.key, key2: key) }) {
            return r
        }
        let separator = key.contains("-check@") ? "-check@" : (key.contains("-main@") ? "-main@" : nil)
        guard let sep = separator,
              let range = key.range(of: sep, options: .backwards) else {
            return nil
        }
        let seatId = String(key[..<range.lowerBound])
        let epStr = String(key[range.upperBound...])
        let ts = Double(epStr) ?? Date().timeIntervalSince1970
        let matchedSeat = (seatId == "main-timer") ? nil : findMatchingSeat(for: seatId)
        let wSound: Bool = {
            if seatId == "main-timer" {
                return WatchSessionManager.shared.mainTimer?.watchAlarmSoundEnabled ?? ((UserDefaults.standard.object(forKey: "assisttimer.mainTimerWatchSound.v2") as? Bool) ?? false)
            }
            if let seat = matchedSeat {
                return seat.watchAlarmSoundEnabled
            }
            return self.soundOn
        }()
        let fallbackTitle: String = {
            if seatId == "main-timer" { return "⏱️ メインタイマー 終了" }
            if let seat = matchedSeat {
                return sep == "-check@" ? "🔍 \(seat.displaySeatName) チェック時間" : "\(seat.displaySeatName) タイム終了"
            }
            return ""
        }()
        return WatchAlarmEvent(key: key, seatId: matchedSeat?.id ?? seatId, date: Date(timeIntervalSince1970: ts), title: fallbackTitle, watchSoundOn: wSound)
    }

    /// 指定されたイベントキー（および同一席・同一種別の±15秒ウィンドウを含む全キー）に紐づくローカル通知を即座に全削除する
    private func removeNotifications(forEventKey key: String) {
        var targetKeys: Set<String> = [key]
        let isCheckTarget = key.contains("-check@")
        let kindTag = isCheckTarget ? "-check@" : "-main@"
        var candidateSeatIds: Set<String> = []
        if let range = key.range(of: kindTag, options: .backwards) {
            candidateSeatIds.insert(String(key[..<range.lowerBound]))
        }
        var prefixHeaders: [String] = []
        if let ev = eventFromKey(key) {
            candidateSeatIds.insert(ev.seatId)
            if ev.seatId != "main-timer", let matched = findMatchingSeat(for: ev.seatId, title: ev.title) {
                candidateSeatIds.insert(matched.id)
                if matched.seatNumber > 0 {
                    candidateSeatIds.insert("seat-\(matched.seatNumber)")
                }
            }
            let prefixTags = candidateSeatIds.map { "\($0)\(kindTag)" }
            prefixHeaders = prefixTags.map { "\(notificationPrefix)\($0)" }
            let baseEpoch = Int(ev.date.timeIntervalSince1970)
            for prefixTag in prefixTags {
                for e in events where e.key.hasPrefix(prefixTag) { targetKeys.insert(e.key) }
                for r in ringing where r.key.hasPrefix(prefixTag) { targetKeys.insert(r.key) }
                for k in armed.keys where k.hasPrefix(prefixTag) { targetKeys.insert(k) }
                for k in scheduledNotificationEventKeys where k.hasPrefix(prefixTag) { targetKeys.insert(k) }
                // ★ 通信同期による1〜数秒の時刻ズレやアプリ再起動後でも、残りリピート通知（4秒・8秒・13秒後など）が
                //   1件も取りこぼされず同期的に即座に消えるよう、前後15秒分のキーも一括生成して消去する
                for ep in (baseEpoch - 15)...(baseEpoch + 15) {
                    targetKeys.insert("\(prefixTag)\(ep)")
                }
            }
        }
        for k in targetKeys {
            scheduledNotificationEventKeys.remove(k)
        }
        let ids = targetKeys.flatMap { k in repeatOffsets.indices.map { "\(notificationPrefix)\(k).\($0)" } }
        let center = UNUserNotificationCenter.current()
        if !ids.isEmpty {
            center.removePendingNotificationRequests(withIdentifiers: ids)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
        if !prefixHeaders.isEmpty {
            center.getPendingNotificationRequests { requests in
                let matched = requests.map(\.identifier).filter { id in prefixHeaders.contains { id.hasPrefix($0) } }
                if !matched.isEmpty {
                    center.removePendingNotificationRequests(withIdentifiers: matched)
                    center.removeDeliveredNotifications(withIdentifiers: matched)
                }
            }
            center.getDeliveredNotifications { delivered in
                let matched = delivered.map { $0.request.identifier }.filter { id in prefixHeaders.contains { id.hasPrefix($0) } }
                if !matched.isEmpty {
                    center.removeDeliveredNotifications(withIdentifiers: matched)
                }
            }
        }
    }

    private func acknowledgeRinging(sendToPhone: Bool, completeCheckIfNeeded: Bool = true, explicitTarget: WatchAlarmEvent? = nil, deferPhoneSend: Bool = false) {
        let now = Date()
        var mergedTargets = currentRinging(now)
        if let exp = explicitTarget, !mergedTargets.contains(where: { isSameTarget(key1: $0.key, key2: exp.key) }) {
            mergedTargets.append(exp)
        }
        for r in ringing where !mergedTargets.contains(where: { isSameTarget(key1: $0.key, key2: r.key) }) {
            mergedTargets.append(r)
        }
        for (_, r) in restoredOverlayEvents where !mergedTargets.contains(where: { isSameTarget(key1: $0.key, key2: r.key) }) {
            mergedTargets.append(r)
        }
        for key in forceRingingKeys where !mergedTargets.contains(where: { isSameTarget(key1: $0.key, key2: key) }) {
            if let ev = eventFromKey(key) {
                mergedTargets.append(ev)
            }
        }
        if mergedTargets.isEmpty,
           explicitTarget == nil,
           let k = sessionKey ?? UserDefaults.standard.string(forKey: sessionKeyStoreKey),
           let ev = eventFromKey(k),
           (sessionStarted || ev.date <= now.addingTimeInterval(2.0)) {
            mergedTargets.append(ev)
        }
        let targets = mergedTargets
        guard !targets.isEmpty else {
            if !ringing.isEmpty { ringing = [] }
            if sendToPhone, var m = WatchSessionManager.shared.mainTimer, (m.isOvertime || m.isPreCountingDown || m.isRunning) {
                let stoppedEnd = m.targetEndTime.timeIntervalSince1970
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
                events.removeAll { $0.seatId == "main-timer" }
                persistEvents()
                WidgetSync.save(timers: WatchSessionManager.shared.timers, mainTimer: m, userName: WatchSessionManager.shared.currentUserName, forceReload: true)
                if !deferPhoneSend {
                    WatchSessionManager.shared.sendMainTimerAction(action: "MAIN_TIMER_RESET", stoppedEndTime: stoppedEnd)
                }
            }
            return
        }
        var allAckKeys = Set<String>()
        for e in targets {
            acknowledged[e.key] = e.date.timeIntervalSince1970
            allAckKeys.insert(e.key)
            let isCheckTarget = e.key.contains("-check@")
            let kindTag = isCheckTarget ? "-check@" : "-main@"
            let prefixTag = "\(e.seatId)\(kindTag)"
            for ev in events where ev.seatId == e.seatId && ev.key.contains(kindTag) {
                acknowledged[ev.key] = ev.date.timeIntervalSince1970
                allAckKeys.insert(ev.key)
            }
            for (k, ts) in armed where k.hasPrefix(prefixTag) {
                acknowledged[k] = ts
                allAckKeys.insert(k)
            }
            for k in scheduledNotificationEventKeys where k.hasPrefix(prefixTag) {
                acknowledged[k] = e.date.timeIntervalSince1970
                allAckKeys.insert(k)
                scheduledNotificationEventKeys.remove(k)
            }
            if let sKey = sessionKey, sKey.hasPrefix(prefixTag) {
                acknowledged[sKey] = e.date.timeIntervalSince1970
                allAckKeys.insert(sKey)
            }
            let baseEpoch = Int(e.date.timeIntervalSince1970)
            for ep in (baseEpoch - 15)...(baseEpoch + 15) {
                allAckKeys.insert("\(prefixTag)\(ep)")
            }
            removeForceRinging(matching: e.key)
            removeNotifications(forEventKey: e.key)
            restoredOverlayEvents = restoredOverlayEvents.filter { !isSameTarget(key1: $0.key, key2: e.key) }
        }
        persist()
        ringing = []

        // ★ 放置タイム終了のアラーム（-main@）と途中チェック時間のアラーム（-check@）を分離して処理:
        //   1. 本放置・メインタイマー（-main@）: ユーザーが明示的に「止める / タイム終了 / シャンプーに入る」等を選んだ時（sendToPhone == true）は00:00に戻す。
        //   2. 途中チェック時間（-check@）: 通知やスマートアラームで開いた場合でもチェック完了として扱い、残りの本放置タイマー（第2段階スマートアラーム）を即座に再予約する。
        let mainSeatIds = Set(targets.filter { $0.key.contains("-main@") }.map { $0.seatId })
        let seatIds = Set(targets.map { $0.seatId })
        for id in seatIds {
            if !deferPhoneSend, let snap = lastSystemDismissedSnapshot, (snap.event.seatId == id || (id == "main-timer" && snap.event.seatId == "main-timer")) {
                lastSystemDismissedSnapshot = nil
                pendingSystemDismissPhoneSyncWorkItem?.cancel()
                pendingSystemDismissPhoneSyncWorkItem = nil
            }
            let isMainTimer = (id == "main-timer" || id == WatchSessionManager.shared.mainTimer?.id)
            if isMainTimer {
                if sendToPhone {
                    // ★ メインタイマーのアラーム消火: 明示的に止めた時（sendToPhone == true）は
                    //   00:00 停止状態へ即座に戻し、予定リストからも除去して文字盤モジュールを即時更新する。
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
                        WatchSessionManager.shared.recordMainTimerLocalAction("RESET", endTime: stoppedEnd)
                        WidgetSync.save(timers: WatchSessionManager.shared.timers, mainTimer: m, userName: WatchSessionManager.shared.currentUserName, forceReload: true)
                    } else {
                        WatchSessionManager.shared.recordMainTimerLocalAction("RESET", endTime: stoppedEnd)
                    }
                    events.removeAll { $0.seatId == "main-timer" || $0.seatId == id }
                    persistEvents()
                    if !deferPhoneSend {
                        WatchSessionManager.shared.sendMainTimerAction(action: "MAIN_TIMER_RESET", stoppedEndTime: stoppedEnd)
                    }
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
                        events.removeAll { $0.seatId == id && $0.key.contains("-main@") }
                        persistEvents()
                        WatchSessionManager.shared.applyLocalStop(seatId: id, fallbackEndTime: mainEvent.date)
                        if !deferPhoneSend {
                            WatchSessionManager.shared.sendActionToPhone(
                                action: "STOP_ALARM",
                                seatId: id,
                                extra: extra
                            )
                        }
                    }
                } else if completeCheckIfNeeded {
                    // ★ チェック時間アラームの停止: Watch側でも即座にチェック完了を反映し、残りの全体タイマーを新しく入れ直す
                    let checkEvent = targets.first(where: { $0.seatId == id && $0.key.contains("-check@") })
                    WatchSessionManager.shared.applyLocalCheckComplete(seatId: id, fallbackCheckEndTime: checkEvent?.date)
                    if !deferPhoneSend {
                        WatchSessionManager.shared.sendActionToPhone(
                            action: "STOP_ALARM",
                            seatId: id,
                            extra: ["kind": "check"]
                        )
                    }
                }
            }
        }
    }

    private func sendDeferredStopToPhone(for snap: SystemDismissedSnapshot) {
        let ev = snap.event
        if ev.seatId == "main-timer" {
            let stoppedEnd = snap.preMainTimer?.targetEndTime.timeIntervalSince1970 ?? ev.date.timeIntervalSince1970
            WatchSessionManager.shared.sendMainTimerAction(action: "MAIN_TIMER_RESET", stoppedEndTime: stoppedEnd)
        } else if snap.isCheckEvent {
            WatchSessionManager.shared.sendActionToPhone(
                action: "STOP_ALARM",
                seatId: ev.seatId,
                extra: ["kind": "check"]
            )
        } else {
            let expectedMs = (snap.preSeatTimer?.targetEndTime.timeIntervalSince1970 ?? ev.date.timeIntervalSince1970) * 1000.0
            WatchSessionManager.shared.sendActionToPhone(
                action: "STOP_ALARM",
                seatId: ev.seatId,
                extra: [
                    "kind": "main",
                    "expectedEnd": expectedMs
                ]
            )
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
        sessionScheduledAt = .distantPast
        sessionPresentedSystemAlert = false
        wasBackgroundWhenSystemAlertShown = false
    }

    private func invalidateCurrentSession() {
        guard let s = session else { return }
        if canScheduleSmartAlarm {
            // ★ 既存の別予定セッションを破棄して0.25秒後に新セッションへ切り替える際、直後に手首が下がっても再予約できるよう引き継ぎウィンドウを付与
            allowBackgroundHandoffScheduleUntil = Date().addingTimeInterval(2.0)
        }
        let current = s
        let wasStarted = sessionStarted
        let key = sessionKey
        clearSession()
        safeInvalidateSession(current, wasStarted: wasStarted, associatedKey: key)
    }

    /// ★ セッション破棄メソッド:
    ///    破棄時に notifyUser（＝2枚目のシステムアラーム画面表示）を呼んだり非同期遅延を入れたりすると、
    ///    1枚目の通知で「アラーム停止」を押した直後に2枚目のアラームが鳴り出す原因になるため、即座に同期破棄する。
    private func safeInvalidateSession(_ s: WKExtendedRuntimeSession, wasStarted: Bool = false, associatedKey: String? = nil) {
        intentionallyInvalidatedSessions.insert(s)
        if let key = associatedKey {
            sessionKeysBySession[s] = key
        }
        notifiedSessions.remove(s)
        sessionNotifyStartTimes.removeValue(forKey: s)
        backgroundAdoptedSessions.remove(s)
        guard s.state != .invalid else {
            invalidatingSessions.remove(s)
            sessionKeysBySession.removeValue(forKey: s)
            return
        }
        invalidatingSessions.insert(s)
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
        stopAlarmAudio()
    }

    // MARK: - ★ ウォッチ本体スピーカーからの強制アラーム音再生（消音モードでも強制鳴動、OFF時はバイブのみ）

    private func shouldPlayWatchAlarmSound() -> Bool {
        if ringing.contains(where: { $0.watchSoundOn || self.soundOn }) {
            return true
        }
        if sessionStarted, let key = sessionKey, !isAcknowledged(key) {
            if let ev = eventFromKey(key), (ev.watchSoundOn || self.soundOn) {
                return true
            }
        }
        return false
    }

    private func updateAlarmAudio() {
        if shouldPlayWatchAlarmSound() {
            startAlarmAudioIfNeeded()
        } else {
            stopAlarmAudio()
        }
    }

    private func startAlarmAudioIfNeeded() {
        if let player = audioPlayer, player.isPlaying {
            return
        }
        do {
            let audioSession = AVAudioSession.sharedInstance()
            // ★ .playback カテゴリを指定することで watchOS の消音モード（サイレントモード）を貫通して強制的にスピーカーから鳴らす
            try audioSession.setCategory(.playback, mode: .default, options: [.duckOthers])
            try audioSession.setActive(true)
            let player = try AVAudioPlayer(data: Self.alarmWavData)
            player.numberOfLoops = -1
            player.volume = 1.0
            player.prepareToPlay()
            player.play()
            self.audioPlayer = player
        } catch {
            // オーディオ初期化失敗時はハプティック振動が継続してカバーする
        }
    }

    private func stopAlarmAudio() {
        if let player = audioPlayer {
            if player.isPlaying {
                player.stop()
            }
            audioPlayer = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// 外部音源ファイル不要で100%確実に鳴らせる高明瞭デジタルアラーム音（ピピピピッ♪周期）の16bit PCM WAVデータをメモリ生成
    private static func generateAlarmWavData() -> Data {
        let sampleRate: Int = 22050
        let durationSeconds: Double = 1.0
        let totalSamples = Int(Double(sampleRate) * durationSeconds)
        var pcm = [Int16](repeating: 0, count: totalSamples)

        // 1秒間に4回の明瞭な電子アラームビープ（0.00〜0.11s, 0.15〜0.26s, 0.30〜0.41s, 0.45〜0.60s）
        let beepWindows: [(start: Double, end: Double, freq1: Double, freq2: Double)] = [
            (0.00, 0.11, 2800.0, 3400.0),
            (0.15, 0.26, 2800.0, 3400.0),
            (0.30, 0.41, 2800.0, 3400.0),
            (0.45, 0.60, 3200.0, 3800.0)
        ]

        for i in 0..<totalSamples {
            let t = Double(i) / Double(sampleRate)
            var sampleValue: Double = 0.0
            for w in beepWindows where t >= w.start && t <= w.end {
                let localT = t - w.start
                let len = w.end - w.start
                let fade = 0.006
                var env = 1.0
                if localT < fade {
                    env = localT / fade
                } else if (len - localT) < fade {
                    env = max(0.0, (len - localT) / fade)
                }
                let wave = 0.65 * sin(2.0 * Double.pi * w.freq1 * t) + 0.35 * sin(2.0 * Double.pi * w.freq2 * t)
                sampleValue = wave * env * 0.92
                break
            }
            let clamped = max(-1.0, min(1.0, sampleValue))
            pcm[i] = Int16(clamped * Double(Int16.max))
        }

        let dataBytesCount = totalSamples * 2
        let riffChunkSize = 36 + dataBytesCount
        var data = Data(capacity: 44 + dataBytesCount)

        func appendASCII(_ s: String) {
            if let d = s.data(using: .ascii) { data.append(d) }
        }
        func appendUInt32LE(_ v: UInt32) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        func appendUInt16LE(_ v: UInt16) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }

        appendASCII("RIFF")
        appendUInt32LE(UInt32(riffChunkSize))
        appendASCII("WAVE")
        appendASCII("fmt ")
        appendUInt32LE(16) // PCM fmt chunk size
        appendUInt16LE(1)  // AudioFormat = 1 (PCM)
        appendUInt16LE(1)  // NumChannels = 1 (Mono)
        appendUInt32LE(UInt32(sampleRate))
        appendUInt32LE(UInt32(sampleRate * 2)) // ByteRate
        appendUInt16LE(2)  // BlockAlign
        appendUInt16LE(16) // BitsPerSample
        appendASCII("data")
        appendUInt32LE(UInt32(dataBytesCount))

        pcm.withUnsafeBufferPointer { ptr in
            data.append(UnsafeBufferPointer(start: UnsafeRawPointer(ptr.baseAddress!).assumingMemoryBound(to: UInt8.self), count: dataBytesCount))
        }
        return data
    }

    // MARK: - スマートアラーム（WKExtendedRuntimeSession）

    private func scheduleSmartAlarmIfPossible(_ now: Date) {
        // 鳴動中のセッション（または2枚目表示済みで didInvalidateWith コールバック待ちのセッション）には触らない
        // ※停止済みのイベントはすべて !isAcknowledged($0.key) と $0.date > now で除外されるため、
        //   グローバルな suppressSmartAlarmUntil で新規予約を止めない（停止直後の再スタートやチェック後の残り本タイマー予約を100%通す）
        if sessionStarted { return }
        if let s = session, notifiedSessions.contains(s) { return }
        if let s = session, s.state == .invalid { clearSession() }

        // ★ すでに破棄完了したセッションを掃除し、まだOS側で破棄処理中のセッションがある場合は
        //   .sessionInProgress エラーを防ぐため破棄完了コールバック（または0.25秒タイマー）まで待つ
        invalidatingSessions = invalidatingSessions.filter { $0.state != .invalid }
        if !invalidatingSessions.isEmpty {
            return
        }

        // ★ 時刻到達済み・または開始直前（5秒以内）の未消火予定のセッションは保護する
        if session != nil, let key = sessionKey, !isAcknowledged(key),
           let ev = events.first(where: { isSameTarget(key1: $0.key, key2: key) }), ev.date <= now.addingTimeInterval(5) {
            return
        }

        // ★ 重要: すでに終了時刻を過ぎた予定（currentRinging）に対して後から0.2秒後にスマートアラームを新規予約すると、
        //   1枚目の通知が出た後や「アラーム停止」を押した直後に2枚目のシステムアラームが鳴り出す原因になるため、
        //   必ず「まだ終了時刻を迎えていない未来の予定（$0.date > now）」のみをスマートアラームの予約対象とする！
        let target: WatchAlarmEvent?
        let startDate: Date
        if let n = events
            .filter({ $0.date > now && !isAcknowledged($0.key) })
            .min(by: { $0.date < $1.date }) {
            target = n
            startDate = max(now.addingTimeInterval(1.0), n.date)
        } else {
            target = nil
            startDate = now
        }

        // ★ 正常に予約成立しているセッション（.scheduled または .running）、および start(at:) 呼び出し直後で
        //   watchOS デーモン側の非同期ステータス遷移待ち（.notStarted かつ開始後3秒未満）のセッションは「予約済み」として保護する！
        //   （※ start(at:) 直後の .notStarted を clearSession() で捨てて2個目のセッションを作ると、
        //     .sessionInProgress エラーや1分タイマー鳴動時の extendedRuntimeSession !== self.session 破棄バグの原因になる）
        if let s = session {
            if s.state == .invalid {
                clearSession()
            } else if isSameTarget(key1: sessionKey, key2: target?.key),
                      (s.state == .scheduled || s.state == .running || (s.state == .notStarted && now.timeIntervalSince(sessionScheduledAt) < 3.0)) {
                return // 予約済み（または非同期予約遷移中）
            } else if s.state == .notStarted && now.timeIntervalSince(sessionScheduledAt) >= 3.0 {
                guard canScheduleSmartAlarm else { return }
                invalidateCurrentSession()
                return
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
        guard now >= nextSmartAlarmScheduleAllowedAt else { return }
        // ★ watchOS の仕様上、WKExtendedRuntimeSession.start(at:) は .active または .inactive（canScheduleSmartAlarm == true）、
        //   または直前のスマートアラーム終了直後の引き継ぎウィンドウ（allowBackgroundHandoffScheduleUntil）で試行する。
        //   もしOS側に拒否されて .invalid になった場合は即座にクリアし、次回アクティブ化時に再予約する。
        let canAttemptSchedule = canScheduleSmartAlarm || (now < allowBackgroundHandoffScheduleUntil)
        guard canAttemptSchedule else { return }

        // ★ 前のセッションが完全に存在しないクリーンな状態で、最速新規予約（XPC通信ラグで過去時刻エラーにならないよう最低1.0秒先を保証）
        let safeStartDate = max(Date().addingTimeInterval(1.0), startDate)
        let s = WKExtendedRuntimeSession()
        s.delegate = self
        s.start(at: safeStartDate)
        if s.state == .invalid {
            intentionallyInvalidatedSessions.insert(s)
            nextSmartAlarmScheduleAllowedAt = now.addingTimeInterval(1.2)
            clearSession()
            scheduleRetryAfterInvalidation(delay: 1.25)
            return
        }
        session = s
        sessionKeysBySession[s] = t.key
        sessionScheduledAt = now
        setSessionKey(t.key)
        sessionStarted = false
        sessionPresentedSystemAlert = false
        wasBackgroundWhenSystemAlertShown = false
    }

    // 止めるまで強い振動を繰り返す（アプリ非表示時はシステムのアラーム画面になる）
    private func startNotifyUser(_ s: WKExtendedRuntimeSession) {
        notifiedSessions.insert(s)
        sessionNotifyStartTimes[s] = Date()
        updateAlarmAudio()
        let appState = WKApplication.shared().applicationState
        if appState != .active {
            sessionPresentedSystemAlert = true
        }
        if appState == .background {
            wasBackgroundWhenSystemAlertShown = true
        }
        let types = strongHaptics
        var step = 0
        s.notifyUser(hapticType: .failure) { [weak self] next in
            if let self = self {
                let st = WKApplication.shared().applicationState
                if st != .active { self.sessionPresentedSystemAlert = true }
                if st == .background { self.wasBackgroundWhenSystemAlertShown = true }
            }
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
            if isAcknowledged(key) {
                // ★ すでに通知の「アラーム停止」等で消火済みの場合は、2枚目のシステムアラーム画面を出さずに即座に破棄する
                if session === extendedRuntimeSession {
                    invalidateCurrentSession()
                } else if extendedRuntimeSession.state != .invalid {
                    intentionallyInvalidatedSessions.insert(extendedRuntimeSession)
                    extendedRuntimeSession.invalidate()
                }
                updateStatusText()
                return
            }
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
            sessionKeysBySession[extendedRuntimeSession] = ev.key
            setSessionKey(ev.key)
            persist()
            // ★ 2枚目（スマートアラーム）が起動した瞬間に、同一イベントの1枚目（ローカル通知）を全消去して二重表示を防ぐ！
            removeNotifications(forEventKey: ev.key)
            startNotifyUser(extendedRuntimeSession)
            refresh()
        } else if let latest = currentRinging(now).last {
            sessionKeysBySession[extendedRuntimeSession] = latest.key
            setSessionKey(latest.key)
            removeNotifications(forEventKey: latest.key)
            startNotifyUser(extendedRuntimeSession)
            refresh()
        } else {
            // ★ すでに手動で止められた後の古いセッションがすれ違いで開始された場合は、
            //   notifyUser（＝2枚目のアラーム画面表示）を呼ばずに即座に破棄する
            if session === extendedRuntimeSession {
                invalidateCurrentSession()
            } else if extendedRuntimeSession.state != .invalid {
                intentionallyInvalidatedSessions.insert(extendedRuntimeSession)
                extendedRuntimeSession.invalidate()
            }
            updateStatusText()
        }
    }

    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        DispatchQueue.main.async {
            if extendedRuntimeSession !== self.session {
                // ★ 万が一セッション参照が入れ替わっていた場合でも、破棄中リストに含まれておらず、
                //   かつ今まさに鳴るべき未消火イベントがある場合は破棄せず正規セッションとして引き継いで確実に振動させる！
                let now = Date()
                let hasDueUnacked = self.events.contains { !self.isAcknowledged($0.key) && $0.date <= now.addingTimeInterval(15) }
                if !self.invalidatingSessions.contains(extendedRuntimeSession) && !self.intentionallyInvalidatedSessions.contains(extendedRuntimeSession) && hasDueUnacked {
                    if let old = self.session, old !== extendedRuntimeSession, old.state != .invalid {
                        self.intentionallyInvalidatedSessions.insert(old)
                        self.invalidatingSessions.insert(old)
                        old.invalidate()
                    }
                    self.session = extendedRuntimeSession
                } else {
                    self.safeInvalidateSession(extendedRuntimeSession, wasStarted: false)
                    return
                }
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
            let wasIntentionallyInvalidated = self.intentionallyInvalidatedSessions.remove(extendedRuntimeSession) != nil
            let wasInvalidating = (self.invalidatingSessions.remove(extendedRuntimeSession) != nil) || wasIntentionallyInvalidated
            let wasBackgroundAdopted = self.backgroundAdoptedSessions.remove(extendedRuntimeSession) != nil
            let wasNotified = self.notifiedSessions.remove(extendedRuntimeSession) != nil
            self.sessionNotifyStartTimes.removeValue(forKey: extendedRuntimeSession)
            let isCurrent = (extendedRuntimeSession === self.session)
            let sessionSpecificKey = self.sessionKeysBySession.removeValue(forKey: extendedRuntimeSession)
            guard wasInvalidating || isCurrent || wasBackgroundAdopted || wasNotified else { return }

            let wasStarted = (self.sessionStarted && isCurrent) || wasBackgroundAdopted || wasNotified
            let wasSystemAlert = (self.sessionPresentedSystemAlert && isCurrent) || wasBackgroundAdopted || (wasStarted && WKApplication.shared().applicationState != .active)
            let wasBgWhenShown = (self.wasBackgroundWhenSystemAlertShown && isCurrent) || wasBackgroundAdopted
            // ★ セッション固有キーを優先参照し、古いチェック用セッションの遅延 didInvalidateWith が
            //   新しく予約された本体タイマーの self.sessionKey を誤って参照して TimeActionSheet を再表示させるバグを防止！
            let endedKey = sessionSpecificKey ?? (isCurrent ? (self.sessionKey ?? UserDefaults.standard.string(forKey: self.sessionKeyStoreKey)) : nil)
            if isCurrent {
                self.clearSession()
            }
            self.lastSessionEnd = self.reasonText(reason, error: error)
            if wasStarted, let k = endedKey {
                // ★ 一度鳴動開始して閉じたスマートアラームを記録し、次回予約で本体タイマー（2回目）へ確実に移行させる
                self.smartAlarmCompletedKeys.insert(k)
            }
            // ★ システムのスマートアラーム画面（「"AssistTimer" からのアラームです。 [開く] [終了]」）が閉じた場合:
            //   1. 左側の「開く」を押してフォアグラウンド復帰した場合:
            //      アラームの振動のみを止め、超過カウントアップ（+00:xx）を維持したままアクション分岐画面（「タイマーを止める」等）へ移行する。
            //   2. 右側の「終了」を押した場合（またはデジタルクラウン等で閉じた場合）:
            //      アラームの振動・音・通知のみを消火し、超過カウントアップ（+00:xx）は継続させる！
            //      その後、超過タイムをタップした時に「タイマーを止める」ボタンが表示され、明示的に止めると 00:00 に戻る。
            //   ※ 必ず wasStarted == true（実際に鳴動開始していたセッション）かつ意図的破棄ではない場合のみシステムアラーム終了として扱う。
            if !wasInvalidating && reason != .sessionInProgress && wasStarted {
                self.allowBackgroundHandoffScheduleUntil = Date().addingTimeInterval(2.5)
                self.suppressSmartAlarmUntil = Date().addingTimeInterval(3.0)
                self.pendingSystemDismissPhoneSyncWorkItem?.cancel()
                self.pendingSystemDismissPhoneSyncWorkItem = nil
                let now = Date()
                let matchedEv: WatchAlarmEvent? = {
                    if let k = endedKey, let ev = self.events.first(where: { self.isSameTarget(key1: $0.key, key2: k) }) {
                        return ev
                    }
                    if let k = endedKey, let ev = self.eventFromKey(k) {
                        return ev
                    }
                    if let lastRing = self.currentRinging(now).last {
                        return lastRing
                    }
                    if let m = WatchSessionManager.shared.mainTimer, (m.isOvertime || m.isPreCountingDown || m.isRunning) {
                        let ep = Int(m.targetEndTime.timeIntervalSince1970)
                        return WatchAlarmEvent(key: "main-timer-main@\(ep)", seatId: "main-timer", date: m.targetEndTime, title: "⏱️ メインタイマー 終了")
                    }
                    return nil
                }()

                if let ev = matchedEv {
                    self.removeNotifications(forEventKey: ev.key)
                    self.forceRingingKeys.insert(ev.key)
                }

                // 「開く」が押されてアプリがすでに .active になっているか判定
                let openedIntoForeground = (WKApplication.shared().applicationState == .active && wasSystemAlert && now.timeIntervalSince(self.lastAppBecameActiveAt) < 1.5)
                if openedIntoForeground {
                    self.lastSystemDismissedSnapshot = nil
                    self.acknowledgeRinging(sendToPhone: false, completeCheckIfNeeded: false, explicitTarget: matchedEv)
                    self.stopForegroundHaptics()
                    if let ev = matchedEv {
                        self.pendingOpenedAlarmEvent = ev
                    }
                    self.notificationSignature = "__FORCE__"
                    self.refresh()
                    self.scheduleRetryAfterInvalidation(delay: 0.25)
                    return
                }

                // 文字盤（.background）から「開く」が押され、didInvalidateWith が appBecameActive よりわずかに先に届いた場合に備えてスナップショットを保存
                if wasBgWhenShown, let ev = matchedEv {
                    let isCheck = ev.key.contains("-check@")
                    let preMain = WatchSessionManager.shared.mainTimer
                    let preSeat = self.findMatchingSeat(for: ev.seatId, title: ev.title)
                    self.lastSystemDismissedSnapshot = SystemDismissedSnapshot(
                        event: ev,
                        dismissedAt: now,
                        isCheckEvent: isCheck,
                        preMainTimer: preMain,
                        preSeatTimer: preSeat
                    )
                } else {
                    self.lastSystemDismissedSnapshot = nil
                }

                // ★ 「終了」押下時: アラーム振動・音・通知のみを消火し、メインタイマー・客席タイマー・中間チェックタイマーすべて超過カウントアップ（+00:xx）を継続させる！
                //   （チェックタイマーのイベントも acknowledged に記録されるため、残りの本タイマーの第2段階スマートアラームへ自動で引き継がれる）
                self.acknowledgeRinging(sendToPhone: false, completeCheckIfNeeded: false, explicitTarget: matchedEv)
                self.stopForegroundHaptics()
                self.notificationSignature = "__FORCE__"
                self.refresh()
                self.scheduleRetryAfterInvalidation(delay: 0.25)
                return
            }
            // ★ 未開始の予約セッションが watchOS によって即座に破棄された場合（画面遷移中や前セッション破棄直後の XPC 拒否など）は、
            //   0ms で同期 refresh() → start(at:) → didInvalidateWith の無限 XPC ＆ UNUserNotificationCenter 再登録ストームになるのを防ぐため、
            //   1.2秒のクールダウンを置いてから再試行する。
            if !wasStarted && !wasInvalidating {
                self.nextSmartAlarmScheduleAllowedAt = Date().addingTimeInterval(1.2)
                self.scheduleRetryAfterInvalidation(delay: 1.25)
                return
            }
            // ★ 意図的に前セッションを破棄完了した瞬間に、残っている次の予定（チェック後の本タイマーなど）を再スケジュール
            if reason != .sessionInProgress {
                self.refresh()
            }
            self.scheduleRetryAfterInvalidation(delay: reason == .sessionInProgress ? 0.35 : 0.25)
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
        let activeSmartKey: String = {
            guard let s = session, (s.state == .scheduled || s.state == .running || s.state == .notStarted || sessionStarted), let k = sessionKey else {
                return ""
            }
            return "\(k):\(sessionStarted ? "run" : "sched")"
        }()
        let signature = targets.map { $0.key }.joined(separator: "|") + "##" + activeSmartKey
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
            // ★ スマートアラーム（2枚目）が現在このイベントに対して予約成立中または鳴動中の場合:
            //   - 鳴動中（sessionStarted == true）ならローカル通知（1枚目）は一切登録しない（二重表示を完全防止）
            //   - 予約中（.scheduled / .notStarted）なら、0秒時点でスマートアラームとローカル通知が同時発火して重なるのを防ぐため、
            //     初回（0秒）のみをスキップし、万が一スマートアラームがOSに抑制され起動しなかった場合の
            //     バックアップ（4秒以降）はすべて登録する（スマートアラームが正常起動した瞬間に4秒以降のバックアップも全削除される）
            let isCoveredBySmartAlarm = (session != nil && (session?.state == .scheduled || session?.state == .running || session?.state == .notStarted || sessionStarted) && isSameTarget(key1: sessionKey, key2: e.key))
            if isCoveredBySmartAlarm && sessionStarted {
                continue
            }
            for (i, offset) in offsets.enumerated() {
                if count >= limit { break }
                if isCoveredBySmartAlarm && offset < 4 {
                    continue
                }
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
                    ? "タイムアップです。「アラーム停止」で止まります。"
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

        // ★ 2. 不要になった古い通知ID（予約待ち・およびすでにWatch画面に表示済みのアラーム通知のみ）を非同期で掃除
        // ※ 相手からの操作通知（"assisttimer.peer.*"）を巻き込んで消さないよう、prefix（"assisttimer.alarm."）一致のみ削除する
        let activeKeyPrefixes = targets
            .filter { !(session != nil && sessionStarted && isSameTarget(key1: sessionKey, key2: $0.key)) }
            .map { "\(prefix)\($0.key)." }
        center.getPendingNotificationRequests { requests in
            let stale = requests.map(\.identifier).filter { $0.hasPrefix(prefix) && !newIdentifiers.contains($0) }
            if !stale.isEmpty {
                center.removePendingNotificationRequests(withIdentifiers: stale)
                center.removeDeliveredNotifications(withIdentifiers: stale)
            }
        }
        center.getDeliveredNotifications { delivered in
            let staleDelivered = delivered.map { $0.request.identifier }.filter { id in
                guard id.hasPrefix(prefix) else { return false }
                return !activeKeyPrefixes.contains(where: { id.hasPrefix($0) })
            }
            if !staleDelivered.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: staleDelivered)
            }
        }
    }

    // アプリ表示中は画面のアラーム表示＋振動で知らせるので通知バナーは出さない（常時表示 .inactive やバックグラウンドでは通知＋触覚も確実に出す）
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let reqId = notification.request.identifier
        DispatchQueue.main.async {
            if reqId.hasPrefix("assisttimer.peer.") {
                if WKApplication.shared().applicationState == .active {
                    completionHandler([])
                } else {
                    WKInterfaceDevice.current().play(.notification)
                    completionHandler([.banner, .sound, .list])
                }
                return
            }
            if reqId.hasPrefix(self.notificationPrefix) {
                let stripped = String(reqId.dropFirst(self.notificationPrefix.count))
                if let dotIdx = stripped.lastIndex(of: ".") {
                    let eventKey = String(stripped[..<dotIdx])
                    // ★ すでに消火済み、またはスマートアラーム（2枚目）が現在鳴動中の場合は、通知バナーも振動も出さず即破棄（二重表示防止）
                    if self.isAcknowledged(eventKey) || (self.sessionStarted && self.isSameTarget(key1: self.sessionKey, key2: eventKey)) {
                        self.removeNotifications(forEventKey: eventKey)
                        completionHandler([])
                        return
                    }
                    self.forceRingingKeys.insert(eventKey)
                }
            }
            if self.sessionStarted {
                completionHandler([])
                return
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

    // ★ 通知タップ（「開く」）または「アラーム停止」ボタン（STOP_ACTION）押下時:
    //   1. 「アラーム停止」ボタン（STOP_ACTION）を押した時: バックグラウンドのまま対象タイマーを即座に停止・リセット（チェック時はチェック完了）し、iPhoneへも停止を同期する。
    //   2. 通知カード本体をタップ（「開く」: UNNotificationDefaultActionIdentifier）してアプリを開いた時:
    //      スマートアラーム左側の「開く」と完全統一し、アラーム振動・音・通知のみを消火して超過カウントアップ（+00:xx）は維持したまま、
    //      即座に「⏹️ タイマーを止める」が最上段にある操作画面（.timerActionBranch / .subCheckActionBranch）を自動で開く！
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let reqId = response.notification.request.identifier
        if reqId.hasPrefix("assisttimer.peer.") {
            completionHandler()
            return
        }
        let isExplicitStopAction = (response.actionIdentifier == "STOP_ACTION")
        let block = {
            self.allowBackgroundHandoffScheduleUntil = Date().addingTimeInterval(2.5)
            self.suppressSmartAlarmUntil = Date().addingTimeInterval(5.0)
            self.pendingSystemDismissPhoneSyncWorkItem?.cancel()
            self.pendingSystemDismissPhoneSyncWorkItem = nil
            self.lastSystemDismissedSnapshot = nil
            if self.events.isEmpty, let rawEvents = UserDefaults.standard.array(forKey: self.eventsStoreKey) as? [[String: Any]] {
                self.events = rawEvents.compactMap { WatchAlarmEvent(dictionary: $0) }
            }
            var targetEventKey: String? = nil
            var explicitTargetEvent: WatchAlarmEvent? = nil
            // 通知ID（"assisttimer.alarm.<eventKey>.<index>"）から対象イベントキーを特定し、
            // コールドスタート時やイベント時刻更新後でも確実に通知削除・対象解決へ通す
            if reqId.hasPrefix(self.notificationPrefix) {
                let stripped = String(reqId.dropFirst(self.notificationPrefix.count))
                if let dotIdx = stripped.lastIndex(of: ".") {
                    let eventKey = String(stripped[..<dotIdx])
                    targetEventKey = eventKey
                    explicitTargetEvent = self.eventFromKey(eventKey)
                    self.removeNotifications(forEventKey: eventKey)
                    self.forceRingingKeys.insert(eventKey)
                }
            }
            if isExplicitStopAction {
                self.stop(sendToPhone: true, completeCheckIfNeeded: true, explicitTarget: explicitTargetEvent)
            } else {
                self.stop(sendToPhone: false, completeCheckIfNeeded: false, explicitTarget: explicitTargetEvent)
            }
            if let eventKey = targetEventKey {
                let ts = explicitTargetEvent?.date.timeIntervalSince1970 ?? Date().timeIntervalSince1970
                self.acknowledged[eventKey] = ts
                self.removeForceRinging(matching: eventKey)
                self.removeNotifications(forEventKey: eventKey)
                self.persist()
            }
            if !isExplicitStopAction {
                if let ev = explicitTargetEvent ?? targetEventKey.flatMap({ self.eventFromKey($0) }) {
                    self.pendingOpenedAlarmEvent = ev
                }
                completionHandler()
                return
            }
            // ★ バックグラウンドの通知アクション（STOP_ACTION: options: []）で呼ばれた際、
            //   WCSession の iPhone 送信および 0.25秒後のチェック後本タイマー再予約が完遂する前に
            //   watchOS にプロセスをサスペンドされるのを防ぐため、短時間アクティビティ保護をかけてから完了を返す
            ProcessInfo.processInfo.performExpiringActivity(withReason: "AssistTimerNotificationStop") { expired in
                if !expired {
                    Thread.sleep(forTimeInterval: 0.35)
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                completionHandler()
            }
        }
        if Thread.isMainThread {
            block()
        } else {
            DispatchQueue.main.async(execute: block)
        }
    }
}
