import SwiftUI
import Combine
import WatchConnectivity

// MARK: - データモデル (絶対終了時刻 targetEndTime 基準)
struct SeatTimerItem: Identifiable, Equatable {
    let id: String
    var seatNumber: Int
    var seatLabel: String? = nil // ★ ユーザー登録表示名（例: "1番席 (個室)"）
    var creatorName: String
    var totalSeconds: Int // 全体初期設定秒数 (例: 900秒 = 15分)
    var targetEndTime: Date // 終了目標時刻（画面消灯・スリープでもずれない絶対時刻）
    var isRunning: Bool
    var pausedRemainingSeconds: Int // 一時停止中の残り秒数
    var helpProcess: String = "シャンプー" // 依頼工程 ("シャンプー", "コーミング", "チェック", "その他")
    var shampooStaff: String? // 担当スタッフ (nil = 未定)
    var isRecruiting: Bool = false // 全員に募集中フラグ
    var isNoHelpNeeded: Bool = false
    var status: TreatmentStatus = .normal
    
    // 表示用の席名（登録名があればそれを優先、なければ "◯番席"）
    var displaySeatName: String {
        if let label = seatLabel?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty {
            return label
        }
        return isMainTimer ? "メインタイマー" : "\(seatNumber)番席"
    }
    
    // 途中チェックタイマー
    var checkTotalSeconds: Int?
    var checkTargetEndTime: Date?
    var checkStaff: String?
    var isCheckCompleted: Bool = false
    
    // ヘルプ未定アラート発火済みフラグ（全員通知用）
    var hasAlertedHelpUnassigned: Bool = false
    
    // ★ アコーディオン折りたたみフラグ（計測終了時など）
    var isCollapsed: Bool = false
    
    // ★ メインタイマーフラグ ＆ ジャンル
    var isMainTimer: Bool = false
    var genre: String? = nil
    
    // ★ 準備中カウントダウン（iPhone設定連動）
    var isPreCountingDown: Bool = false
    var preCountdownSeconds: Int = 0
    var prepEndTime: Date? = nil
    var isCountdownConfigEnabled: Bool = false
    var countdownConfigSeconds: Int = 5
    var isCountUpEnabled: Bool = true

    init(
        id: String,
        seatNumber: Int = 0,
        seatLabel: String? = nil,
        creatorName: String = "スタイリスト",
        totalSeconds: Int = 600,
        targetEndTime: Date = Date().addingTimeInterval(600),
        isRunning: Bool = false,
        pausedRemainingSeconds: Int = 600,
        helpProcess: String = "シャンプー",
        shampooStaff: String? = nil,
        isRecruiting: Bool = false,
        isNoHelpNeeded: Bool = false,
        status: TreatmentStatus = .normal,
        checkTotalSeconds: Int? = nil,
        checkTargetEndTime: Date? = nil,
        checkStaff: String? = nil,
        isCheckCompleted: Bool = false,
        hasAlertedHelpUnassigned: Bool = false,
        isCollapsed: Bool = false,
        isMainTimer: Bool = false,
        genre: String? = nil,
        isPreCountingDown: Bool = false,
        preCountdownSeconds: Int = 0,
        prepEndTime: Date? = nil,
        isCountdownConfigEnabled: Bool = false,
        countdownConfigSeconds: Int = 5,
        isCountUpEnabled: Bool = true
    ) {
        self.id = id
        self.seatNumber = seatNumber
        self.seatLabel = seatLabel
        self.creatorName = creatorName
        self.totalSeconds = totalSeconds
        self.targetEndTime = targetEndTime
        self.isRunning = isRunning
        self.pausedRemainingSeconds = pausedRemainingSeconds
        self.helpProcess = helpProcess
        self.shampooStaff = shampooStaff
        self.isRecruiting = isRecruiting
        self.isNoHelpNeeded = isNoHelpNeeded
        self.status = status
        self.checkTotalSeconds = checkTotalSeconds
        self.checkTargetEndTime = checkTargetEndTime
        self.checkStaff = checkStaff
        self.isCheckCompleted = isCheckCompleted
        self.hasAlertedHelpUnassigned = hasAlertedHelpUnassigned
        self.isCollapsed = isCollapsed
        self.isMainTimer = isMainTimer
        self.genre = genre
        self.isPreCountingDown = isPreCountingDown
        self.preCountdownSeconds = preCountdownSeconds
        self.prepEndTime = prepEndTime
        self.isCountdownConfigEnabled = isCountdownConfigEnabled
        self.countdownConfigSeconds = countdownConfigSeconds
        self.isCountUpEnabled = isCountUpEnabled
    }
    
    // 準備中カウントダウンの残り秒数
    var prepRemainingSeconds: Int {
        guard isPreCountingDown else { return 0 }
        if let end = prepEndTime {
            let diff = end.timeIntervalSince(Date())
            return max(0, Int(ceil(diff)))
        }
        return max(0, preCountdownSeconds)
    }
    
    // 現在の残り秒数（動的計算）
    // ★ iPhone(HomeScreen)の Math.ceil((targetEndTime - now)/1000) と一致させて1秒の表示ズレを完全解消
    var remainingSeconds: Int {
        if !isRunning {
            return pausedRemainingSeconds
        }
        let diff = targetEndTime.timeIntervalSince(Date())
        return diff > 0 ? Int(ceil(diff)) : Int(diff)
    }
    
    // チェックタイマー残り秒数
    var checkRemainingSeconds: Int? {
        guard !isCheckCompleted, let checkEnd = checkTargetEndTime else { return nil }
        if !isRunning { return nil }
        let sec = Int(checkEnd.timeIntervalSince(Date()))
        return sec > 0 ? sec : 0
    }
    
    // タイム超過判定（残り0秒未満、または稼働中で0秒以下）
    var isOvertime: Bool {
        return remainingSeconds < 0 || (isRunning && remainingSeconds <= 0)
    }
    
    // ★ 00:00（停止中・未稼働・リセット後）判定
    var isZero: Bool {
        return !isRunning && remainingSeconds <= 0
    }
    
    // 自分に関係している席か判定（作成者 or シャンプー・コーミング等ヘルプ担当 or サブタイマー・チェック担当 or 全員募集中）
    func isRelated(to userName: String) -> Bool {
        let cleanUser = userName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if cleanUser.isEmpty || cleanUser == "スタイリスト" || cleanUser == "スタッフ" { return true }
        
        let cName = creatorName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if cName.isEmpty || cName == "スタイリスト" || cName == "スタッフ" { return true }
        
        let sStaff = (shampooStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let chkStaff = (checkStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        
        return cName == cleanUser ||
               (!sStaff.isEmpty && sStaff == cleanUser) ||
               (!chkStaff.isEmpty && chkStaff == cleanUser) ||
               isRecruiting
    }
    
    // ★ iPhone へ送る停止系操作に付ける「操作した時に見ていた終了時刻」(ms)。停止中なら 0。
    //   iPhone は席の終了時刻と照合し、遅れて届いた操作で再スタート後の席を止めないようにする
    var expectedEndMs: Double {
        return isRunning ? targetEndTime.timeIntervalSince1970 * 1000.0 : 0
    }
    
    // ★ チェックタイマーの解除（止める・計測終了・アラーム停止・リセット・タイム再入力）
    mutating func clearCheck() {
        checkTotalSeconds = nil
        checkTargetEndTime = nil
        checkStaff = nil
        isCheckCompleted = false
    }
}

// MARK: - SeatTimerItem 辞書相互変換（iPhone連携用）
extension SeatTimerItem {
    init?(dictionary: [String: Any]) {
        // IDの安全な取得 (String または NSNumber)
        let rawId = (dictionary["id"] as? String) ?? (dictionary["id"] as? NSNumber)?.stringValue
        guard let id = rawId, !id.isEmpty else { return nil }
        self.id = id
        
        // 席番号
        if let num = (dictionary["seatNumber"] as? NSNumber)?.intValue ?? (dictionary["seatNumber"] as? Int) {
            self.seatNumber = num
        } else if let label = dictionary["seatLabel"] as? String {
            let digits = label.compactMap { $0.isNumber ? String($0) : nil }.joined()
            self.seatNumber = Int(digits) ?? 1
        } else {
            self.seatNumber = 1
        }
        
        self.creatorName = (dictionary["creatorName"] as? String) ?? (dictionary["colorStaffName"] as? String) ?? "スタイリスト"
        self.totalSeconds = (dictionary["totalSeconds"] as? NSNumber)?.intValue ?? (dictionary["totalSeconds"] as? Int) ?? (dictionary["targetSeconds"] as? Int) ?? 600
        
        // ★ isRunning の正確な判定 (Bool / NSNumber を最優先、なければ status 文字列)
        let isRunningVal: Bool
        if let running = (dictionary["isRunning"] as? NSNumber)?.boolValue ?? (dictionary["isRunning"] as? Bool) {
            isRunningVal = running
        } else {
            let statusStr = dictionary["status"] as? String ?? ""
            isRunningVal = (statusStr == "running")
        }
        self.isRunning = isRunningVal
        
        if let paused = (dictionary["pausedRemainingSeconds"] as? NSNumber)?.intValue ?? (dictionary["pausedRemainingSeconds"] as? Int) {
            self.pausedRemainingSeconds = paused
        } else {
            self.pausedRemainingSeconds = self.totalSeconds
        }
        
        // 終了時刻（稼働中かつ有効な未来/過去の絶対時刻があればそれを採用、有効な終了時刻が無ければ停止扱い）
        if let endMs = (dictionary["targetEndTimestamp"] as? NSNumber)?.doubleValue ?? (dictionary["targetEndTimestamp"] as? Double), endMs > 0 {
            self.targetEndTime = Date(timeIntervalSince1970: endMs / 1000.0)
        } else if let endSec = (dictionary["targetEndTime"] as? NSNumber)?.doubleValue ?? (dictionary["targetEndTime"] as? Double), endSec > 0 {
            self.targetEndTime = Date(timeIntervalSince1970: endSec)
        } else {
            self.isRunning = false
            let rem = self.pausedRemainingSeconds > 0 ? self.pausedRemainingSeconds : max(60, self.totalSeconds)
            self.targetEndTime = Date().addingTimeInterval(TimeInterval(rem))
        }
        
        self.helpProcess = (dictionary["helpProcess"] as? String) ?? (dictionary["actionStatus"] as? String) ?? "シャンプー"
        let rawShampoo = (dictionary["shampooStaff"] as? String) ?? (dictionary["assistantStaffName"] as? String)
        self.shampooStaff = (rawShampoo?.isEmpty == false) ? rawShampoo : nil
        self.isRecruiting = (dictionary["isRecruiting"] as? NSNumber)?.boolValue ?? (dictionary["isRecruiting"] as? Bool) ?? false
        self.isNoHelpNeeded = (dictionary["isNoHelpNeeded"] as? NSNumber)?.boolValue ?? (dictionary["isNoHelpNeeded"] as? Bool) ?? false
        
        // ★ 00:00（停止中・待機中・リセット後）の席はヘルプ・助手を完全クリア（固定残り防止）
        if !self.isRunning && self.pausedRemainingSeconds <= 0 {
            self.shampooStaff = nil
            self.isRecruiting = false
            self.isNoHelpNeeded = false
        }
        
        // 施術ステータス (normal, shampoo, combing, check)
        let actionStatus = dictionary["actionStatus"] as? String
        let statusStr = dictionary["status"] as? String
        let isShampooing = (dictionary["isShampooing"] as? NSNumber)?.boolValue ?? (dictionary["isShampooing"] as? Bool) ?? false
        if isShampooing || actionStatus == "shampoo" || statusStr == "shampoo" {
            self.status = .shampoo
        } else if actionStatus == "combing" || statusStr == "combing" {
            self.status = .combing
        } else if actionStatus == "check" || statusStr == "check" {
            self.status = .check
        } else {
            self.status = .normal
        }
        
        if let sec = (dictionary["checkTotalSeconds"] as? NSNumber)?.intValue ?? (dictionary["checkTotalSeconds"] as? Int) ?? (dictionary["checkTargetSeconds"] as? Int), sec > 0 {
            self.checkTotalSeconds = sec
        } else {
            self.checkTotalSeconds = nil
        }
        if let endMs = (dictionary["checkEndTimestamp"] as? NSNumber)?.doubleValue ?? (dictionary["checkEndTimestamp"] as? Double) ?? (dictionary["checkTargetEndTime"] as? Double), endMs > 0 {
            self.checkTargetEndTime = Date(timeIntervalSince1970: endMs / 1000.0)
        } else {
            self.checkTargetEndTime = nil
        }
        let rawCheckStaff = (dictionary["checkStaff"] as? String) ?? (dictionary["checkStaffName"] as? String)
        self.checkStaff = (rawCheckStaff?.isEmpty == false) ? rawCheckStaff : nil
        self.isCheckCompleted = (dictionary["isCheckCompleted"] as? NSNumber)?.boolValue ?? (dictionary["isCheckCompleted"] as? Bool) ?? false
        self.isCollapsed = (dictionary["isCollapsed"] as? NSNumber)?.boolValue ?? (dictionary["isCollapsed"] as? Bool) ?? false
        self.isMainTimer = (dictionary["isMainTimer"] as? NSNumber)?.boolValue ?? (dictionary["isMainTimer"] as? Bool) ?? (id == "main-timer")
        self.genre = dictionary["genre"] as? String
        self.seatLabel = dictionary["seatLabel"] as? String
        self.isPreCountingDown = (dictionary["isPreCountingDown"] as? NSNumber)?.boolValue ?? (dictionary["isPreCountingDown"] as? Bool) ?? false
        self.preCountdownSeconds = (dictionary["preCountdownSeconds"] as? NSNumber)?.intValue ?? (dictionary["preCountdownSeconds"] as? Int) ?? 0
        self.isCountdownConfigEnabled = (dictionary["isCountdownConfigEnabled"] as? NSNumber)?.boolValue ?? (dictionary["isCountdownConfigEnabled"] as? Bool) ?? false
        self.countdownConfigSeconds = (dictionary["countdownConfigSeconds"] as? NSNumber)?.intValue ?? (dictionary["countdownConfigSeconds"] as? Int) ?? 5
        self.isCountUpEnabled = (dictionary["isCountUpEnabled"] as? NSNumber)?.boolValue ?? (dictionary["isCountUpEnabled"] as? Bool) ?? true
        if let prepEndMs = (dictionary["prepEndTimestamp"] as? NSNumber)?.doubleValue ?? (dictionary["prepEndTimestamp"] as? Double), prepEndMs > 0 {
            self.prepEndTime = Date(timeIntervalSince1970: prepEndMs / 1000.0)
        } else {
            self.prepEndTime = nil
        }
        
        // ★ 00:00席またはアコーディオン収納席はヘルプ・助手を完全クリア（固定残り防止）
        if !self.isRunning && (self.pausedRemainingSeconds <= 0 || self.isCollapsed) {
            self.shampooStaff = nil
            self.isRecruiting = false
            self.isNoHelpNeeded = false
        }
    }

    func toDictionary() -> [String: Any] {
        let statusStr: String
        switch status {
        case .shampoo: statusStr = "shampoo"
        case .combing: statusStr = "combing"
        case .check: statusStr = "check"
        case .normal: statusStr = "normal"
        }
        var dict: [String: Any] = [
            "id": id,
            "seatNumber": seatNumber,
            "creatorName": creatorName,
            "totalSeconds": totalSeconds,
            "targetEndTimestamp": targetEndTime.timeIntervalSince1970 * 1000.0,
            "isRunning": isRunning,
            "pausedRemainingSeconds": pausedRemainingSeconds,
            "helpProcess": helpProcess,
            "isRecruiting": isRecruiting,
            "isNoHelpNeeded": isNoHelpNeeded,
            "actionStatus": statusStr,
            "isShampooing": (status == .shampoo),
            "isCheckCompleted": isCheckCompleted,
            "isCollapsed": isCollapsed,
            "isMainTimer": isMainTimer,
            "isPreCountingDown": isPreCountingDown,
            "preCountdownSeconds": preCountdownSeconds,
            "isCountdownConfigEnabled": isCountdownConfigEnabled,
            "countdownConfigSeconds": countdownConfigSeconds,
            "isCountUpEnabled": isCountUpEnabled
        ]
        if let seatLabel = seatLabel { dict["seatLabel"] = seatLabel }
        if let shampooStaff = shampooStaff { dict["shampooStaff"] = shampooStaff }
        if let checkTotalSeconds = checkTotalSeconds { dict["checkTotalSeconds"] = checkTotalSeconds }
        if let checkTargetEndTime = checkTargetEndTime { dict["checkEndTimestamp"] = checkTargetEndTime.timeIntervalSince1970 * 1000.0 }
        if let checkStaff = checkStaff { dict["checkStaff"] = checkStaff }
        if let genre = genre { dict["genre"] = genre }
        if let prepEndTime = prepEndTime { dict["prepEndTimestamp"] = prepEndTime.timeIntervalSince1970 * 1000.0 }
        return dict
    }
}

import WatchConnectivity

// MARK: - iPhone (WCSession) 通信マネージャー
class WatchSessionManager: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchSessionManager()
    private let savedTimersKey = "assisttimer.watch.savedTimers.v1"
    private let savedMainTimerKey = "assisttimer.watch.savedMainTimer.v1"
    private let savedUserNameKey = "assisttimer.watch.savedUserName.v1"
    private let savedWatchMainEndKey = "assisttimer.watch.watchStartedMainEnd.v1"

    @Published var timers: [SeatTimerItem] = [
        SeatTimerItem(
            id: "seat-1",
            seatNumber: 1,
            seatLabel: "1番席 (サンプル)",
            creatorName: "スタイリスト",
            totalSeconds: 1200,
            targetEndTime: Date().addingTimeInterval(1200),
            isRunning: false,
            pausedRemainingSeconds: 1200,
            status: .normal
        )
    ] {
        didSet {
            let raw = timers.map { $0.toDictionary() }
            UserDefaults.standard.set(raw, forKey: savedTimersKey)
        }
    }
    @Published var mainTimer: SeatTimerItem? = SeatTimerItem(
        id: "main-timer",
        seatNumber: 0,
        seatLabel: "メインタイマー",
        creatorName: "スタイリスト",
        totalSeconds: 600,
        targetEndTime: Date().addingTimeInterval(600),
        isRunning: false,
        pausedRemainingSeconds: 600,
        isMainTimer: true
    ) {
        didSet {
            if let m = mainTimer {
                UserDefaults.standard.set(m.toDictionary(), forKey: savedMainTimerKey)
            } else {
                UserDefaults.standard.removeObject(forKey: savedMainTimerKey)
            }
        }
    }
    @Published var members: [String] = []
    @Published var currentUserName: String = "スタイリスト" {
        didSet {
            if !currentUserName.isEmpty {
                UserDefaults.standard.set(currentUserName, forKey: savedUserNameKey)
            }
        }
    }
    // ★ 相手からのリアルタイム操作通知（タイマー停止、チェック完了、シャンプー開始等）
    @Published var incomingNotification: (text: String, color: String)? = nil
    // ★ 「iPhoneと即時通信できる状態（isReachable）」のみ true。有効化だけでは true にしない
    @Published var isConnectedToPhone: Bool = false
    
    // ★ 診断用（画面の通信状態パネルに常時表示）
    // linkState: 0 = 未有効化(灰) / 1 = 有効化済み・iPhoneアプリ未接続(黄) / 2 = iPhoneと通信可能(緑)
    @Published var linkState: Int = 0
    @Published var activationStateText: String = "未有効化"
    @Published var isCompanionAppInstalled: Bool = false
    @Published var lastSentAction: String = "-"
    @Published var lastSentAt: Date? = nil
    @Published var lastSendResult: String = "-"
    @Published var lastReceivedAt: Date? = nil
    @Published var lastReceivedKind: String = "-"
    @Published var lastReceivedSeatCount: Int = -1
    @Published var receivedCount: Int = 0
    
    // ★ Watch 側アラーム音（iPhone の設定画面から同期。未設定時はデフォルト true）
    @Published var alarmSoundEnabled: Bool = (UserDefaults.standard.object(forKey: "assisttimer.watchAlarmSound") as? Bool) ?? true
    
    // ★ 有効化前に行われた操作の保留キュー（有効化完了時に自動送信。メインスレッドでのみ操作）
    private var pendingPayloads: [[String: Any]] = []
    
    // ★ 受信済みの最新データの作成時刻（iPhone の Date.now()、ミリ秒）。
    //   即時メッセージと保存データ（applicationContext）は届く順番が前後することがあるため、古いデータで上書きしない
    private var lastPayloadTimestamp: Double = 0
    
    // ★ Watch または iPhone で止めた席（古い「稼働中」スナップショットや applicationContext で超過・稼働へゾンビ復活しないよう4時間保持＆永続化）
    private var localStops: [String: (at: Date, end: Double)] = [:]
    private let localStopHoldSeconds: TimeInterval = 14400
    private let savedLocalStopsKey = "assisttimer.watch.localStops.v1"
    private let savedMainStopActionTimeKey = "assisttimer.watch.mainStopActionTime.v1"
    private let savedMainStopActionTypeKey = "assisttimer.watch.mainStopActionType.v1"
    private let savedMainStopEndTimeKey = "assisttimer.watch.mainStopEndTime.v1"
    
    // ★ Watch で完了・解除したチェックタイマー（すれ違い通信の古いデータでチェックタイマーが復活し、残りの全体タイマー予約を邪魔するのを防止）
    private var localCheckClears: [String: (at: Date, checkEnd: Double)] = [:]
    private let localCheckClearHoldSeconds: TimeInterval = 60
    
    // ★ Watch 上で収納（計測終了）・展開（スリムバーをタップ）した席。停止中は iPhone の値より優先し、
    //   席が稼働したら消す（同期のたびにカードが勝手に開閉しないようにする）
    private var collapseOverrides: [String: Bool] = [:]
    
    // ★ メインタイマーの直近ローカル操作＆停止保護（Watch/iPhoneで停止後、古い保存データによる巻き戻し・ゾンビ復活を4時間完全ブロック）
    private var lastMainTimerLocalActionTime: Date = Date.distantPast
    private var lastMainTimerLocalActionType: String = "" // "RESET", "PAUSE", "START", "SET_TIME", "ADJUST"
    private var lastMainTimerLocalStopEndTime: Double = 0
    private let mainTimerLocalHoldSeconds: TimeInterval = 15.0
    private let mainTimerStopHoldSeconds: TimeInterval = 14400.0
    // ★ Watch 主導で開始し現在カウントダウン稼働中のメインタイマー終了予定時刻（iPhone スリープ中や SYNC_SEATS 同梱の未開始データによる強制停止を防止）
    private var watchStartedMainTimerEndTime: Date? = nil {
        didSet {
            if let end = watchStartedMainTimerEndTime {
                UserDefaults.standard.set(end.timeIntervalSince1970, forKey: savedWatchMainEndKey)
            } else {
                UserDefaults.standard.removeObject(forKey: savedWatchMainEndKey)
            }
        }
    }
    
    func clearWatchStartedMainTimer() {
        self.watchStartedMainTimerEndTime = nil
    }
    
    private func persistLocalStops() {
        let now = Date()
        var dict: [String: [String: Double]] = [:]
        for (k, v) in localStops where now.timeIntervalSince(v.at) < localStopHoldSeconds {
            dict[k] = ["at": v.at.timeIntervalSince1970, "end": v.end]
        }
        UserDefaults.standard.set(dict, forKey: savedLocalStopsKey)
    }
    
    private func persistMainTimerStopState() {
        UserDefaults.standard.set(lastMainTimerLocalActionTime.timeIntervalSince1970, forKey: savedMainStopActionTimeKey)
        UserDefaults.standard.set(lastMainTimerLocalActionType, forKey: savedMainStopActionTypeKey)
        UserDefaults.standard.set(lastMainTimerLocalStopEndTime, forKey: savedMainStopEndTimeKey)
    }
    
    func recordMainTimerLocalAction(_ actionType: String = "", endTime: Double = 0) {
        self.lastMainTimerLocalActionTime = Date()
        self.lastMainTimerLocalActionType = actionType
        let nowEpoch = Date().timeIntervalSince1970
        if actionType == "START" || (actionType == "SET_TIME" && endTime > nowEpoch) || (actionType == "ADJUST" && endTime > nowEpoch) {
            self.lastMainTimerLocalStopEndTime = 0
            if endTime > nowEpoch {
                self.watchStartedMainTimerEndTime = Date(timeIntervalSince1970: endTime)
            } else if let cur = self.mainTimer, (cur.isRunning || cur.isPreCountingDown) {
                self.watchStartedMainTimerEndTime = cur.targetEndTime
            }
        } else if actionType == "RESET" || actionType == "PAUSE" || actionType == "SET_TIME" {
            if endTime > 0 {
                self.lastMainTimerLocalStopEndTime = endTime
            } else if let watchEnd = self.watchStartedMainTimerEndTime {
                self.lastMainTimerLocalStopEndTime = watchEnd.timeIntervalSince1970
            } else if let cur = self.mainTimer, (cur.isRunning || cur.isPreCountingDown) {
                self.lastMainTimerLocalStopEndTime = cur.targetEndTime.timeIntervalSince1970
            }
            self.watchStartedMainTimerEndTime = nil
        }
        persistMainTimerStopState()
    }
    
    override init() {
        super.init()
        let nowDate = Date()
        if let savedName = UserDefaults.standard.string(forKey: savedUserNameKey), !savedName.isEmpty {
            self.currentUserName = savedName
        }
        if let rawStops = UserDefaults.standard.dictionary(forKey: savedLocalStopsKey) as? [String: [String: Double]] {
            var restoredStops: [String: (at: Date, end: Double)] = [:]
            for (k, v) in rawStops {
                if let atEpoch = v["at"], let endEpoch = v["end"] {
                    let atDate = Date(timeIntervalSince1970: atEpoch)
                    if nowDate.timeIntervalSince(atDate) < localStopHoldSeconds {
                        restoredStops[k] = (at: atDate, end: endEpoch)
                    }
                }
            }
            self.localStops = restoredStops
        }
        let savedMainStopAt = UserDefaults.standard.double(forKey: savedMainStopActionTimeKey)
        if savedMainStopAt > 0 {
            let atDate = Date(timeIntervalSince1970: savedMainStopAt)
            if nowDate.timeIntervalSince(atDate) < mainTimerStopHoldSeconds {
                self.lastMainTimerLocalActionTime = atDate
                self.lastMainTimerLocalActionType = UserDefaults.standard.string(forKey: savedMainStopActionTypeKey) ?? ""
                self.lastMainTimerLocalStopEndTime = UserDefaults.standard.double(forKey: savedMainStopEndTimeKey)
            }
        }
        let savedWatchEndEpoch = UserDefaults.standard.double(forKey: savedWatchMainEndKey)
        if savedWatchEndEpoch > nowDate.addingTimeInterval(-10800).timeIntervalSince1970 {
            if self.lastMainTimerLocalStopEndTime > 0 && abs(savedWatchEndEpoch - self.lastMainTimerLocalStopEndTime) <= 15 {
                self.watchStartedMainTimerEndTime = nil
            } else {
                self.watchStartedMainTimerEndTime = Date(timeIntervalSince1970: savedWatchEndEpoch)
            }
        }
        if let rawMain = UserDefaults.standard.dictionary(forKey: savedMainTimerKey),
           var restoredMain = SeatTimerItem(dictionary: rawMain) {
            if restoredMain.isPreCountingDown {
                let prepEnd = restoredMain.prepEndTime ?? nowDate
                let runSec = restoredMain.pausedRemainingSeconds > 0 ? restoredMain.pausedRemainingSeconds : restoredMain.totalSeconds
                let mainEnd = prepEnd.addingTimeInterval(TimeInterval(runSec))
                restoredMain.targetEndTime = mainEnd
                if prepEnd <= nowDate {
                    restoredMain.isPreCountingDown = false
                    restoredMain.preCountdownSeconds = 0
                    restoredMain.prepEndTime = nil
                    restoredMain.isRunning = true
                }
            }
            if (restoredMain.isRunning || restoredMain.isPreCountingDown),
               self.lastMainTimerLocalStopEndTime > 0,
               abs(restoredMain.targetEndTime.timeIntervalSince1970 - self.lastMainTimerLocalStopEndTime) <= 15 {
                restoredMain.isRunning = false
                restoredMain.isPreCountingDown = false
                restoredMain.pausedRemainingSeconds = restoredMain.totalSeconds
                self.watchStartedMainTimerEndTime = nil
            }
            // ★ カウントアップOFFのときは終了時刻を過ぎていれば完了・待機状態にする。
            //   カウントアップONのときは3時間（10800秒）以内の超過は稼働中のまま保護し、それより古い放置データのみリセットする
            if restoredMain.isRunning {
                let cutoff = restoredMain.isCountUpEnabled ? nowDate.addingTimeInterval(-10800) : nowDate
                if restoredMain.targetEndTime <= cutoff {
                    restoredMain.isRunning = false
                    restoredMain.pausedRemainingSeconds = restoredMain.totalSeconds
                    self.watchStartedMainTimerEndTime = nil
                }
            } else if !restoredMain.isPreCountingDown {
                self.watchStartedMainTimerEndTime = nil
                if restoredMain.pausedRemainingSeconds <= 0 {
                    restoredMain.pausedRemainingSeconds = restoredMain.totalSeconds
                }
            }
            self.mainTimer = restoredMain
        } else {
            self.watchStartedMainTimerEndTime = nil
        }
        if let rawTimers = UserDefaults.standard.array(forKey: savedTimersKey) as? [[String: Any]] {
            var restoredTimers = rawTimers.compactMap { SeatTimerItem(dictionary: $0) }
            if !restoredTimers.isEmpty {
                for i in restoredTimers.indices {
                    let id = restoredTimers[i].id
                    if let stop = self.localStops[id],
                       restoredTimers[i].isRunning,
                       abs(restoredTimers[i].targetEndTime.timeIntervalSince1970 - stop.end) < 15,
                       nowDate.timeIntervalSince(stop.at) < localStopHoldSeconds {
                        restoredTimers[i].isRunning = false
                        restoredTimers[i].pausedRemainingSeconds = 0
                        restoredTimers[i].clearCheck()
                    } else if restoredTimers[i].isRunning && restoredTimers[i].targetEndTime <= nowDate.addingTimeInterval(-10800) {
                        restoredTimers[i].isRunning = false
                        restoredTimers[i].pausedRemainingSeconds = 0
                        restoredTimers[i].clearCheck()
                    }
                }
                self.timers = restoredTimers
            }
        }
        if WCSession.isSupported() {
            let session = WCSession.default
            session.delegate = self
            session.activate()
        }
    }
    
    // ★ 現在のセッション状態を診断用プロパティへ反映（メインスレッドで呼ぶこと）
    private func refreshLinkState(_ session: WCSession) {
        switch session.activationState {
        case .activated: activationStateText = "有効"
        case .inactive: activationStateText = "一時停止"
        case .notActivated: activationStateText = "未有効化"
        @unknown default: activationStateText = "不明"
        }
        isCompanionAppInstalled = session.isCompanionAppInstalled
        isConnectedToPhone = session.isReachable
        if session.isReachable {
            linkState = 2
        } else if session.activationState == .activated {
            linkState = 1
        } else {
            linkState = 0
        }
    }
    
    // MARK: - WCSessionDelegate
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.refreshLinkState(session)
            if let error = error {
                self.lastSendResult = "有効化エラー: \(error.localizedDescription)"
            }
            if let context = session.receivedApplicationContext as [String: Any]?, !context.isEmpty {
                self.processReceivedData(context, kind: "保存データ")
            }
            if activationState == .activated {
                self.flushPendingPayloads(session)
                self.requestSyncFromPhone()
            }
        }
    }
    
    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.refreshLinkState(session)
            // ★ iPhoneとの接続が確立された瞬間（緑色点灯時）、保留中の操作を送出し、最新データを要求！手動タップ不要で完全自動同期
            if session.isReachable {
                self.flushPendingPayloads(session)
                self.requestSyncFromPhone()
            }
        }
    }
    
    func sessionCompanionAppInstalledDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.refreshLinkState(session)
        }
    }
    
    func requestSyncFromPhone() {
        var extra: [String: Any] = [:]
        let nowDate = Date()
        if nowDate.timeIntervalSince(self.lastMainTimerLocalActionTime) < self.mainTimerStopHoldSeconds,
           (self.lastMainTimerLocalActionType == "RESET" || self.lastMainTimerLocalActionType == "PAUSE"),
           self.mainTimer?.isRunning != true,
           self.mainTimer?.isPreCountingDown != true {
            extra["watchMainTimerStopped"] = true
            if self.lastMainTimerLocalStopEndTime > 0 {
                extra["targetEndTimestamp"] = self.lastMainTimerLocalStopEndTime * 1000.0
            }
        } else if let m = self.mainTimer,
                  self.watchStartedMainTimerEndTime != nil,
                  (m.isRunning || m.isPreCountingDown) {
            let cutoff = m.isCountUpEnabled ? nowDate.addingTimeInterval(-10800) : nowDate
            if m.targetEndTime > cutoff {
                let soundVal = UserDefaults.standard.object(forKey: "assisttimer.mainTimerPhoneSound") as? Bool ?? true
                extra["watchMainTimerActive"] = true
                extra["totalSeconds"] = m.totalSeconds
                extra["autoStart"] = true
                extra["playSoundOnPhone"] = soundVal
                extra["targetEndTimestamp"] = m.targetEndTime.timeIntervalSince1970 * 1000.0
                if m.isPreCountingDown, let prepEnd = m.prepEndTime {
                    extra["prepEndTimestamp"] = prepEnd.timeIntervalSince1970 * 1000.0
                }
            } else {
                self.watchStartedMainTimerEndTime = nil
            }
        } else if self.watchStartedMainTimerEndTime != nil {
            self.watchStartedMainTimerEndTime = nil
        }
        sendActionToPhone(action: "REQUEST_SYNC", seatId: "", extra: extra)
    }
    
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
        DispatchQueue.main.async {
            self.processReceivedData(applicationContext, kind: "保存データ")
        }
    }
    
    func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
        DispatchQueue.main.async {
            self.processReceivedData(message, kind: "即時")
        }
    }
    
    func session(_ session: WCSession, didReceiveMessage message: [String : Any], replyHandler: @escaping ([String : Any]) -> Void) {
        DispatchQueue.main.async {
            self.processReceivedData(message, kind: "即時")
            replyHandler(["status": "ok"])
        }
    }
    
    // ★ バックグラウンドキュー経由の確実な受信
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any] = [:]) {
        DispatchQueue.main.async {
            self.processReceivedData(userInfo, kind: "予備")
        }
    }
    
    // ★ Watch 上（または iPhone 側同期）で席を止めたことを記録（止める前の終了時刻も保存・永続化。メインスレッドで呼ぶ）
    func markLocalStop(seatId: String, endTime: Date) {
        localStops[seatId] = (at: Date(), end: endTime.timeIntervalSince1970)
        persistLocalStops()
    }
    
    // ★ Watch 上でチェック完了・解除したことを記録（メインスレッドで呼ぶ）
    func markLocalCheckClear(seatId: String, checkEndTime: Date?) {
        localCheckClears[seatId] = (at: Date(), checkEnd: checkEndTime?.timeIntervalSince1970 ?? 0)
    }
    
    func clearLocalCheckClear(seatId: String) {
        localCheckClears[seatId] = nil
    }
    
    // ★ Watch 上で収納・展開したことを記録（nil = 記録を消す。メインスレッドで呼ぶ）
    func setCollapseOverride(seatId: String, collapsed: Bool?) {
        collapseOverrides[seatId] = collapsed
    }
    
    // ★ アラームの「止める」など、画面外から席を止める（Watch の表示をすぐ 0:00 の停止にする。チェック＆ヘルプも完全解除）
    func applyLocalStop(seatId: String) {
        guard let idx = timers.firstIndex(where: { $0.id == seatId }), timers[idx].isRunning else { return }
        markLocalStop(seatId: seatId, endTime: timers[idx].targetEndTime)
        timers[idx].isRunning = false
        timers[idx].pausedRemainingSeconds = 0
        timers[idx].clearCheck()
        timers[idx].shampooStaff = nil
        timers[idx].helpProcess = "シャンプー"
        timers[idx].isRecruiting = false
        timers[idx].isNoHelpNeeded = false
        let snapshot = timers
        WatchAlarmCoordinator.shared.update(timers: snapshot, mainTimer: self.mainTimer, soundOn: self.alarmSoundEnabled, currentUserName: self.currentUserName)
        WidgetSync.save(timers: snapshot, mainTimer: self.mainTimer, userName: self.currentUserName)
    }
    
    // ★ チェックタイマーのアラーム「止める」などで、Watch の表示を即座にチェック完了にし、残りの全体タイマーを新しいタイマーとして入れ直す
    func applyLocalCheckComplete(seatId: String) {
        guard let idx = timers.firstIndex(where: { $0.id == seatId }) else { return }
        markLocalCheckClear(seatId: seatId, checkEndTime: timers[idx].checkTargetEndTime)
        timers[idx].isCheckCompleted = true
        timers[idx].checkStaff = self.currentUserName
        timers[idx].checkTargetEndTime = nil
        timers[idx].checkTotalSeconds = nil
        let snapshot = timers
        WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
            seatId: seatId,
            timers: snapshot,
            mainTimer: self.mainTimer,
            soundOn: self.alarmSoundEnabled,
            currentUserName: self.currentUserName
        )
        WidgetSync.save(timers: snapshot, mainTimer: self.mainTimer, userName: self.currentUserName)
    }
    
    func processReceivedData(_ data: [String: Any], kind: String = "-") {
        // ★ 古いデータ（後から届いた保存データなど）は無視。
        //   10分以上古い場合は iPhone の時計が変わった可能性があるため受け入れる
        if let ts = (data["timestamp"] as? NSNumber)?.doubleValue, (data["seats"] != nil || data["mainTimer"] != nil) {
            if ts < lastPayloadTimestamp && lastPayloadTimestamp - ts < 600_000 {
                self.lastReceivedKind = "\(kind)(古いデータのため無視)"
                return
            }
            lastPayloadTimestamp = ts
        }
        
        // ★ 診断用: 受信記録
        self.receivedCount += 1
        self.lastReceivedAt = Date()
        self.lastReceivedKind = kind
        
        // スタッフ名同期
        if let name = data["userName"] as? String, !name.isEmpty {
            self.currentUserName = name
        }
        
        // 登録メンバー一覧同期（型ゆらぎを許容して確実にパース）
        if let membersArray = (data["members"] as? [String]) ?? (data["members"] as? [Any])?.compactMap({ $0 as? String }) {
            self.members = membersArray
        }
        
        let payloadTs = (data["timestamp"] as? NSNumber)?.doubleValue ?? (data["timestamp"] as? Double) ?? 0
        let nowMs = Date().timeIntervalSince1970 * 1000.0
        let isStaleSnapshot = (payloadTs > 0 && nowMs - payloadTs > 60_000) || (kind == "保存データ" && (payloadTs <= 0 || nowMs - payloadTs > 15_000))

        // ★ 相手からのリアルタイム操作通知（タイマー停止、チェック完了、シャンプー開始等）
        //   保存データ（applicationContext）や15秒以上前の古いデータでは発火させない（アプリ起動直後のバイブ暴発を防止）
        let isRecentNotif = (kind != "保存データ") && (payloadTs <= 0 || abs(nowMs - payloadTs) <= 15_000)
        if isRecentNotif, let notif = data["notification"] as? [String: Any], let text = notif["text"] as? String, !text.isEmpty {
            let colorHex = notif["color"] as? String ?? "#30D158"
            let sourceUser = notif["sourceUser"] as? String ?? ""
            if sourceUser.isEmpty || sourceUser != self.currentUserName {
                DispatchQueue.main.async {
                    self.incomingNotification = (text: text, color: colorHex)
                }
            }
        }
        
        // ★ Watch 側アラーム音の設定
        if let sound = (data["watchAlarmSound"] as? NSNumber)?.boolValue ?? (data["watchAlarmSound"] as? Bool) {
            if sound != self.alarmSoundEnabled {
                self.alarmSoundEnabled = sound
                UserDefaults.standard.set(sound, forKey: "assisttimer.watchAlarmSound")
            }
        }
        
        // メインタイマー同期（Watch主導の予約時刻を保護しつつ、iPhoneからの最新状態と同期）
        var didUpdateMain = false
        if let rawMain = data["mainTimer"] as? [String: Any], var parsedMain = SeatTimerItem(dictionary: rawMain) {
            let nowDate = Date()
            if rawMain["isCountUpEnabled"] == nil, let cur = self.mainTimer {
                parsedMain.isCountUpEnabled = cur.isCountUpEnabled
            }
            // ★ 準備中カウントダウン中でも本番終了予定時刻を確定させておく（すでに準備終了時刻を過ぎていれば本番稼働・超過へ自動正規化）
            if parsedMain.isPreCountingDown {
                let prepEnd = parsedMain.prepEndTime ?? nowDate.addingTimeInterval(TimeInterval(max(1, parsedMain.preCountdownSeconds)))
                let runSec = parsedMain.pausedRemainingSeconds > 0 ? parsedMain.pausedRemainingSeconds : parsedMain.totalSeconds
                let mainEnd = prepEnd.addingTimeInterval(TimeInterval(runSec))
                parsedMain.targetEndTime = mainEnd
                if prepEnd <= nowDate {
                    parsedMain.isPreCountingDown = false
                    parsedMain.preCountdownSeconds = 0
                    parsedMain.prepEndTime = nil
                    parsedMain.isRunning = true
                }
            }
            // ★ カウントアップOFFのときは終了時刻到達後は停止させる。
            //   カウントアップONのときは、保存データや古いスナップショットでも3時間以内は継続させ、3時間以上前の放置データのみ停止
            if parsedMain.isRunning || parsedMain.isPreCountingDown {
                if !parsedMain.isCountUpEnabled && parsedMain.targetEndTime <= nowDate {
                    parsedMain.isRunning = false
                    parsedMain.isPreCountingDown = false
                    parsedMain.preCountdownSeconds = 0
                    parsedMain.prepEndTime = nil
                    parsedMain.pausedRemainingSeconds = 0
                } else if isStaleSnapshot && parsedMain.targetEndTime <= nowDate.addingTimeInterval(-10800) {
                    parsedMain.isRunning = false
                    parsedMain.isPreCountingDown = false
                    parsedMain.preCountdownSeconds = 0
                    parsedMain.prepEndTime = nil
                    parsedMain.pausedRemainingSeconds = parsedMain.totalSeconds
                }
            }
            // ★ Watch側ですでに稼働中または準備カウントダウン中のメインタイマーがあり、iPhoneから同一設定時間の稼働データ（往復同期）が返ってきた場合は、
            //   Watch側で予約済みの targetEndTime / prepEndTime を維持してスマートアラームの破棄・再予約衝突を防止する
            if let cur = self.mainTimer,
               (cur.isRunning || cur.isPreCountingDown),
               (parsedMain.isRunning || parsedMain.isPreCountingDown),
               cur.totalSeconds == parsedMain.totalSeconds {
                if abs(cur.targetEndTime.timeIntervalSince(parsedMain.targetEndTime)) <= 15 {
                    parsedMain.targetEndTime = cur.targetEndTime
                }
                if cur.isPreCountingDown && parsedMain.isPreCountingDown,
                   let curPrep = cur.prepEndTime, let incPrep = parsedMain.prepEndTime,
                   abs(curPrep.timeIntervalSince(incPrep)) <= 15 {
                    parsedMain.prepEndTime = curPrep
                }
            }
            let msgType = (data["type"] as? String) ?? ""
            // ★ iPhone側が同一メインタイマーの稼働（isRunning または isPreCountingDown）に追いついたか、
            //   またはリアルタイムの SYNC_MAIN_TIMER で明示的にリセット・終了されたら、Watch単独保護フラグを解除して以降の双方向停止を有効化
            if let watchEnd = self.watchStartedMainTimerEndTime {
                if parsedMain.isRunning || parsedMain.isPreCountingDown {
                    if abs(parsedMain.targetEndTime.timeIntervalSince(watchEnd)) <= 20 || parsedMain.totalSeconds == self.mainTimer?.totalSeconds {
                        self.watchStartedMainTimerEndTime = nil
                    }
                } else if !isStaleSnapshot && msgType == "SYNC_MAIN_TIMER" {
                    // Watchで開始後、十分な時間（8秒以上）経過した後または終了予定時刻到達後にiPhoneから直接SYNC_MAIN_TIMERの停止が届いた場合は正式な停止・終了として受け入れる
                    if watchEnd <= nowDate || nowDate.timeIntervalSince(self.lastMainTimerLocalActionTime) >= 8.0 {
                        self.watchStartedMainTimerEndTime = nil
                    }
                }
            }
            let isWatchOwnedActive: Bool = {
                guard let watchEnd = self.watchStartedMainTimerEndTime,
                      watchEnd > nowDate,
                      let cur = self.mainTimer,
                      (cur.isRunning || cur.isPreCountingDown) else { return false }
                let isUnstartedInitial = !parsedMain.isRunning && !parsedMain.isPreCountingDown && parsedMain.pausedRemainingSeconds == parsedMain.totalSeconds
                // iPhoneがスリープ中・未反映のまま送られてきた SYNC_SEATS 同梱データや保存データ、開始直後(8秒以内)の未反映初期スナップショットによる強制停止をブロック
                return msgType == "SYNC_SEATS" || isStaleSnapshot || (isUnstartedInitial && nowDate.timeIntervalSince(self.lastMainTimerLocalActionTime) < 8.0)
            }()
            let timeSinceLocalAction = nowDate.timeIntervalSince(self.lastMainTimerLocalActionTime)
            let isRecentlyModifiedOnWatch = timeSinceLocalAction < self.mainTimerLocalHoldSeconds
            let isBlockedByLocalStop: Bool = {
                guard self.lastMainTimerLocalActionType == "RESET" || self.lastMainTimerLocalActionType == "PAUSE" else { return false }
                guard timeSinceLocalAction < self.mainTimerStopHoldSeconds else { return false }
                guard parsedMain.isRunning || parsedMain.isPreCountingDown else { return false }
                if timeSinceLocalAction < self.mainTimerLocalHoldSeconds { return true }
                if self.lastMainTimerLocalStopEndTime > 0,
                   abs(parsedMain.targetEndTime.timeIntervalSince1970 - self.lastMainTimerLocalStopEndTime) <= 15 {
                    return true
                }
                return false
            }()
            
            if isBlockedByLocalStop {
                // ★ Watchで停止・終了した直後に、iPhoneからまだ反映前の古い稼働中・超過データが返ってきた場合はリセット・停止状態を死守
                if self.lastMainTimerLocalActionType == "RESET", var cur = self.mainTimer {
                    cur.isRunning = false
                    cur.isPreCountingDown = false
                    cur.pausedRemainingSeconds = cur.totalSeconds
                    self.mainTimer = cur
                }
            } else if isRecentlyModifiedOnWatch {
                if self.lastMainTimerLocalActionType == "RESET" {
                    if !parsedMain.isRunning && !parsedMain.isPreCountingDown {
                        if parsedMain.pausedRemainingSeconds <= 0 {
                            parsedMain.pausedRemainingSeconds = parsedMain.totalSeconds
                        }
                        self.mainTimer = parsedMain
                        didUpdateMain = true
                    }
                } else if self.lastMainTimerLocalActionType == "PAUSE" {
                    if !parsedMain.isRunning && !parsedMain.isPreCountingDown {
                        if parsedMain.pausedRemainingSeconds <= 0 {
                            parsedMain.pausedRemainingSeconds = parsedMain.totalSeconds
                        }
                        self.mainTimer = parsedMain
                        didUpdateMain = true
                    }
                } else if self.lastMainTimerLocalActionType == "START" {
                    if parsedMain.isRunning || parsedMain.isPreCountingDown {
                        self.mainTimer = parsedMain
                        self.lastMainTimerLocalActionTime = Date.distantPast
                        didUpdateMain = true
                    }
                } else if self.lastMainTimerLocalActionType == "SET_TIME" {
                    let localNeedsActive = (self.mainTimer?.isRunning == true || self.mainTimer?.isPreCountingDown == true)
                    let incomingIsActive = (parsedMain.isRunning || parsedMain.isPreCountingDown)
                    if parsedMain.totalSeconds == self.mainTimer?.totalSeconds && (!localNeedsActive || incomingIsActive) {
                        self.mainTimer = parsedMain
                        self.lastMainTimerLocalActionTime = Date.distantPast
                        didUpdateMain = true
                    }
                } else if self.lastMainTimerLocalActionType == "ADJUST" {
                    let curRem = self.mainTimer?.remainingSeconds ?? parsedMain.remainingSeconds
                    if parsedMain.isRunning != self.mainTimer?.isRunning || abs(curRem - parsedMain.remainingSeconds) <= 5 {
                        self.mainTimer = parsedMain
                        self.lastMainTimerLocalActionTime = Date.distantPast
                        didUpdateMain = true
                    }
                } else {
                    self.mainTimer = parsedMain
                    self.lastMainTimerLocalActionTime = Date.distantPast
                    didUpdateMain = true
                }
            } else if isWatchOwnedActive {
                // ★ Watch主導で開始した稼働中メインタイマーは、iPhoneが追いつく前の未開始データやSYNC_SEATS同梱データで上書き停止させない
                didUpdateMain = false
            } else {
                // 通常同期: iPhone側で明示的にリセット・一時停止された場合はWatchのアラームも消火し、停止した終了時刻を4時間記録してゾンビ復活を防ぐ
                if !parsedMain.isRunning && !parsedMain.isPreCountingDown {
                    if let cur = self.mainTimer, (cur.isRunning || cur.isPreCountingDown) {
                        self.lastMainTimerLocalActionTime = nowDate
                        self.lastMainTimerLocalActionType = "RESET"
                        self.lastMainTimerLocalStopEndTime = cur.targetEndTime.timeIntervalSince1970
                        self.watchStartedMainTimerEndTime = nil
                        self.persistMainTimerStopState()
                    }
                    if parsedMain.pausedRemainingSeconds > 0 {
                        if let cur = self.mainTimer {
                            let isNaturalCountdownAutoStop = !parsedMain.isCountUpEnabled && abs(cur.targetEndTime.timeIntervalSince(nowDate)) <= 5
                            let shouldAcknowledge = !isStaleSnapshot && !isNaturalCountdownAutoStop && (cur.isRunning || cur.isPreCountingDown || (msgType == "SYNC_MAIN_TIMER" && WatchAlarmCoordinator.shared.isMainTimerRingingOrDue))
                            if shouldAcknowledge {
                                WatchAlarmCoordinator.shared.acknowledgeMainTimer()
                            }
                        }
                    } else {
                        // カウントアップOFFで0秒到達により自動停止した場合は、鳴動中のアラームは維持しつつカード表示は設定時間へ戻す
                        parsedMain.pausedRemainingSeconds = parsedMain.totalSeconds
                    }
                } else if parsedMain.isRunning || parsedMain.isPreCountingDown {
                    // 新しい終了時刻で稼働開始したことが確認できたら、古い停止ブロックを解除
                    if self.lastMainTimerLocalStopEndTime > 0,
                       abs(parsedMain.targetEndTime.timeIntervalSince1970 - self.lastMainTimerLocalStopEndTime) > 15 {
                        self.lastMainTimerLocalStopEndTime = 0
                        self.persistMainTimerStopState()
                    }
                }
                self.mainTimer = parsedMain
                didUpdateMain = true
            }
        }

        // 座席リスト同期（型ゆらぎを許容して1席ずつ確実にパース）
        let rawSeats = (data["seats"] as? [Any]) ?? (data["seats"] as? [[String: Any]])
        if let rawSeats = rawSeats {
            var parsed = rawSeats.compactMap { elem -> SeatTimerItem? in
                if let dict = elem as? [String: Any] {
                    return SeatTimerItem(dictionary: dict)
                }
                return nil
            }
            // ★ 安全防御: すでに客席がある場合、空配列による全消滅・強制停止を鉄壁ブロック
            let allowClear = (data["clearAllSeats"] as? Bool) == true
            if parsed.isEmpty && !self.timers.isEmpty && !allowClear {
                // 稼働中・停止中問わず、空データによる客席全滅を完全ブロック
                if didUpdateMain {
                    WatchAlarmCoordinator.shared.update(timers: self.timers, mainTimer: self.mainTimer, soundOn: self.alarmSoundEnabled, currentUserName: self.currentUserName)
                    WidgetSync.save(timers: self.timers, mainTimer: self.mainTimer, userName: self.currentUserName)
                }
            } else {
                // ★ Watch で止めたのに、まだ「止める前と同じ終了時刻で稼働中」のデータが届いた場合は、
                //   iPhone がまだ反映していないだけなので停止のままにする（最大60秒）
                let nowDate = Date()
                for i in parsed.indices {
                    let id = parsed[i].id
                    // ★ 保存データ（applicationContext）や古いスナップショットでも、超過カウントアップ中（3時間以内）の稼働席は勝手に00:00へリセットしない（3時間以上前の放置データのみ停止）
                    if isStaleSnapshot && parsed[i].isRunning && parsed[i].targetEndTime <= nowDate.addingTimeInterval(-10800) {
                        parsed[i].isRunning = false
                        parsed[i].pausedRemainingSeconds = 0
                        parsed[i].clearCheck()
                    }
                    // ★ 既存の同一タイマーがWatchで稼働中の場合、往復同期による数秒のズレで終了予定時刻が書き換わってスマートアラームが破棄されるのを防ぐ
                    if let prev = self.timers.first(where: { $0.id == id }), prev.isRunning, parsed[i].isRunning {
                        if prev.totalSeconds == parsed[i].totalSeconds,
                           abs(prev.targetEndTime.timeIntervalSince(parsed[i].targetEndTime)) <= 15 {
                            parsed[i].targetEndTime = prev.targetEndTime
                            if prev.hasAlertedHelpUnassigned {
                                parsed[i].hasAlertedHelpUnassigned = true
                            }
                        }
                        if !prev.isCheckCompleted && !parsed[i].isCheckCompleted,
                           prev.checkTotalSeconds == parsed[i].checkTotalSeconds,
                           let prevChk = prev.checkTargetEndTime,
                           let newChk = parsed[i].checkTargetEndTime,
                           abs(prevChk.timeIntervalSince(newChk)) <= 15 {
                            parsed[i].checkTargetEndTime = prevChk
                        }
                    } else if parsed[i].isRunning && parsed[i].remainingSeconds <= 180 {
                        parsed[i].hasAlertedHelpUnassigned = true
                    }
                    // ★ Watch で完了・解除したチェックタイマーが、すれ違いの古い通信パケットで復活するのを15秒間ブロック
                    if let chkClear = localCheckClears[id] {
                        let incomingChkEnd = parsed[i].checkTargetEndTime?.timeIntervalSince1970 ?? 0
                        let sameCheck = (chkClear.checkEnd <= 0) || (incomingChkEnd > 0 && abs(incomingChkEnd - chkClear.checkEnd) < 15)
                        if !parsed[i].isCheckCompleted && parsed[i].checkTargetEndTime != nil && sameCheck && nowDate.timeIntervalSince(chkClear.at) < localCheckClearHoldSeconds {
                            parsed[i].isCheckCompleted = true
                            parsed[i].checkTargetEndTime = nil
                            parsed[i].checkTotalSeconds = nil
                            if parsed[i].checkStaff == nil {
                                parsed[i].checkStaff = self.currentUserName
                            }
                        } else if parsed[i].isCheckCompleted || parsed[i].checkTargetEndTime == nil || nowDate.timeIntervalSince(chkClear.at) >= localCheckClearHoldSeconds {
                            localCheckClears[id] = nil
                        }
                    }
                    // ★ iPhone側で計測終了・リセットされた席も終了時刻を記録し、後から届く古い applicationContext 等でゾンビ復活するのを防ぐ
                    if let prev = self.timers.first(where: { $0.id == id }), prev.isRunning, !parsed[i].isRunning {
                        markLocalStop(seatId: id, endTime: prev.targetEndTime)
                    }
                    guard let stop = localStops[id] else { continue }
                    let sameEnd = abs(parsed[i].targetEndTime.timeIntervalSince1970 - stop.end) < 15
                    if nowDate.timeIntervalSince(stop.at) >= localStopHoldSeconds {
                        localStops[id] = nil
                        persistLocalStops()
                    } else if parsed[i].isRunning {
                        if sameEnd {
                            parsed[i].isRunning = false
                            parsed[i].pausedRemainingSeconds = 0
                            parsed[i].clearCheck()
                        } else {
                            // 異なる新しい終了時刻で再スタートされた場合はブロック解除
                            localStops[id] = nil
                            persistLocalStops()
                        }
                    }
                }
                // ★ カードの収納: 稼働中の席は常に展開。停止中は Watch 上での操作を優先し、00:00で何も入っていない席は初期状態で閉じる
                for i in parsed.indices {
                    let id = parsed[i].id
                    if parsed[i].isRunning {
                        parsed[i].isCollapsed = false
                        collapseOverrides[id] = nil
                    } else if let collapsed = collapseOverrides[id] {
                        parsed[i].isCollapsed = collapsed
                    } else if parsed[i].isZero {
                        parsed[i].isCollapsed = true
                    }
                }
                self.lastReceivedSeatCount = parsed.count
                self.timers = parsed
                // ★ バックグラウンド受信でもアラーム予定（通知・スマートアラーム）を更新（関係者判定付き）
                WatchAlarmCoordinator.shared.update(timers: parsed, mainTimer: self.mainTimer, soundOn: self.alarmSoundEnabled, currentUserName: self.currentUserName)
                // ★ 文字盤コンプリケーションへ共有
                WidgetSync.save(timers: parsed, mainTimer: self.mainTimer, userName: self.currentUserName)
            }
        } else if data["mainTimer"] != nil || didUpdateMain {
            // ★ メインタイマーのみの更新時（seatsキーなし）も文字盤・アラームを同期
            WatchAlarmCoordinator.shared.update(timers: self.timers, mainTimer: self.mainTimer, soundOn: self.alarmSoundEnabled, currentUserName: self.currentUserName)
            WidgetSync.save(timers: self.timers, mainTimer: self.mainTimer, userName: self.currentUserName)
        }
    }
    
    // ★ メインタイマー専用の操作送信（携帯の音出力フラグおよび一意なactionIdを付与）
    func sendMainTimerAction(action: String, extra: [String: Any] = [:], stoppedEndTime: Double = 0) {
        let clean = action.replacingOccurrences(of: "MAIN_TIMER_", with: "")
        let isActive = (self.mainTimer?.isRunning == true || self.mainTimer?.isPreCountingDown == true)
        let endTime = stoppedEndTime > 0
            ? stoppedEndTime
            : (isActive ? (self.mainTimer?.targetEndTime.timeIntervalSince1970 ?? 0) : 0)
        recordMainTimerLocalAction(clean, endTime: endTime)
        var fullExtra = extra
        if fullExtra["actionId"] == nil {
            fullExtra["actionId"] = "\(action)_\(Int(Date().timeIntervalSince1970 * 1000))"
        }
        if fullExtra["playSoundOnPhone"] == nil {
            let soundVal = UserDefaults.standard.object(forKey: "assisttimer.mainTimerPhoneSound") as? Bool ?? true
            fullExtra["playSoundOnPhone"] = soundVal
        }
        if let m = self.mainTimer, (m.isRunning || m.isPreCountingDown) {
            if fullExtra["targetEndTimestamp"] == nil {
                fullExtra["targetEndTimestamp"] = m.targetEndTime.timeIntervalSince1970 * 1000.0
            }
            if m.isPreCountingDown, let prepEnd = m.prepEndTime, fullExtra["prepEndTimestamp"] == nil {
                fullExtra["prepEndTimestamp"] = prepEnd.timeIntervalSince1970 * 1000.0
            }
        } else if (clean == "RESET" || clean == "PAUSE"), self.lastMainTimerLocalStopEndTime > 0, fullExtra["targetEndTimestamp"] == nil {
            fullExtra["targetEndTimestamp"] = self.lastMainTimerLocalStopEndTime * 1000.0
        }
        sendActionToPhone(action: action, seatId: "main-timer", extra: fullExtra)
    }
    
    // ★ メインタイマーの設定時間変更を送信（即時スタート対応）
    func sendMainTimerSetTime(seconds: Int, autoStart: Bool = true) {
        sendMainTimerAction(action: "MAIN_TIMER_SET_TIME", extra: ["totalSeconds": seconds, "autoStart": autoStart])
    }
    
    // ★ メインタイマーの秒数増減を送信
    func sendMainTimerAdjust(seconds: Int) {
        sendMainTimerAction(action: "MAIN_TIMER_ADJUST", extra: ["secondsToAdd": seconds])
    }
    
    // ★ 送信結果をメインスレッドで記録
    private func recordSend(_ result: String) {
        DispatchQueue.main.async {
            self.lastSendResult = result
        }
    }
    
    // MARK: - iPhoneへのアクション送信
    // ①即時通信できれば sendMessage（iPhoneの受信確認つき）→ 失敗したら transferUserInfo へ自動切替
    // ②即時通信できなければ最初から transferUserInfo（iPhoneアプリ起動時に届く予備ルート）
    func sendActionToPhone(action: String, seatId: String, extra: [String: Any] = [:]) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        var payload: [String: Any] = [
            "action": action,
            "seatId": seatId,
            "userName": currentUserName,
            "timestamp": Date().timeIntervalSince1970 * 1000.0
        ]
        for (k, v) in extra {
            payload[k] = v
        }
        
        let executeSend = {
            self.lastSentAction = action
            self.lastSentAt = Date()
            
            guard session.activationState == .activated else {
                // REQUEST_SYNC は有効化完了時に自動で送るので保留しない（重複防止）
                if action != "REQUEST_SYNC" {
                    self.pendingPayloads.append(payload)
                }
                self.lastSendResult = "未準備（有効化待ち・保留\(self.pendingPayloads.count)件）"
                session.activate()
                return
            }
            self.deliver(payload, session: session)
        }
        if Thread.isMainThread {
            executeSend()
        } else {
            DispatchQueue.main.async(execute: executeSend)
        }
    }
    
    // ★ 有効化完了時に保留していた操作を順に送信（メインスレッドで呼ぶこと）
    private func flushPendingPayloads(_ session: WCSession) {
        guard !pendingPayloads.isEmpty else { return }
        let queued = pendingPayloads
        pendingPayloads.removeAll()
        for p in queued {
            deliver(p, session: session)
        }
    }
    
    // ★ 実際の送信（即時ルート → 失敗時または応答遅延時は予備ルート）
    private func deliver(_ payload: [String: Any], session: WCSession) {
        let action = (payload["action"] as? String) ?? ""
        let isMainTimerAction = action.hasPrefix("MAIN_TIMER_")
        let isMainStopOrReset = (action == "MAIN_TIMER_RESET" || action == "MAIN_TIMER_PAUSE")
        if isMainStopOrReset {
            // ★ メインタイマーの停止・リセット送信時は、未送信キューやOS転送待ちに残っている古い開始命令をキャンセルして順序逆転による再稼働を防止
            pendingPayloads.removeAll { item in
                let a = (item["action"] as? String) ?? ""
                return a == "MAIN_TIMER_START" || a == "MAIN_TIMER_SET_TIME"
            }
            for transfer in session.outstandingUserInfoTransfers {
                let info = transfer.userInfo
                let a = (info["action"] as? String) ?? ""
                let sid = (info["seatId"] as? String) ?? ""
                if sid == "main-timer" && (a == "MAIN_TIMER_START" || a == "MAIN_TIMER_SET_TIME") {
                    transfer.cancel()
                }
            }
        }
        if session.isReachable {
            lastSendResult = "即時送信中…"
            var acked = false
            var fallbackSent = false
            if isMainTimerAction {
                // ★ Watch操作直後に手首を下ろした場合でも確実にiPhoneへ届けるため、1.2秒以内に即時応答がなければ予備ルート(transferUserInfo)も自動併用（iPhone側でactionId重複排除済み）
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                    guard !acked && !fallbackSent else { return }
                    if (action == "MAIN_TIMER_START" || action == "MAIN_TIMER_SET_TIME"),
                       let latestType = self?.lastMainTimerLocalActionType,
                       (latestType == "RESET" || latestType == "PAUSE") {
                        return
                    }
                    fallbackSent = true
                    session.transferUserInfo(payload)
                    self?.recordSend("即時待機→予備ルート併用送信")
                }
            }
            session.sendMessage(payload, replyHandler: { [weak self] _ in
                DispatchQueue.main.async {
                    acked = true
                    self?.recordSend("iPhone受信OK")
                }
            }, errorHandler: { [weak self] error in
                print("[WatchSession] sendMessage error: \(error.localizedDescription)")
                DispatchQueue.main.async {
                    if action != "REQUEST_SYNC" && !fallbackSent {
                        fallbackSent = true
                        session.transferUserInfo(payload)
                    }
                    self?.recordSend("即時失敗→予備ルート: \(error.localizedDescription)")
                }
            })
        } else {
            if action != "REQUEST_SYNC" {
                session.transferUserInfo(payload)
            }
            lastSendResult = "iPhone未接続→予備ルートで送信待ち"
        }
    }
}

// MARK: - 施術ステータス
enum TreatmentStatus: String, CaseIterable {
    case normal = "放置中"
    case shampoo = "シャンプー中"
    case combing = "コーミング中"
    case check = "チェック中"
    
    var icon: String {
        switch self {
        case .normal: return "hourglass"
        case .shampoo: return "drop.fill"
        case .combing: return "comb.fill"
        case .check: return "magnifyingglass"
        }
    }
    
    var color: Color {
        switch self {
        case .normal: return Color(hex: "#0A84FF")
        case .shampoo: return Color(hex: "#AF52DE")
        case .combing: return Color(hex: "#FF9F0A")
        case .check: return Color(hex: "#30D158")
        }
    }
}

// MARK: - カラー拡張
extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 3:
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6:
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8:
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }
}

// ★ シート閉鎖中のSwiftUI ViewGraph再評価・クラッシュを防ぐための非リアクティブ遅延実行ボックス
private final class PendingSheetActionBox {
    var action: (() -> Void)? = nil
}

// MARK: - メイン画面
struct ContentView: View {
    @StateObject private var sessionManager = WatchSessionManager.shared
    // ★ タイムアップのアラーム（止めるまで鳴り続ける）
    @ObservedObject private var alarm = WatchAlarmCoordinator.shared
    private let pendingMainTimerSheetActionBox = PendingSheetActionBox()
    
    // ログイン中の自ユーザー名（サロン設定・iPhone同期）
    @State private var currentUserName: String = WatchSessionManager.shared.currentUserName
    
    // 新規席追加シートフラグ
    @State private var showingAddSeatSheet = false
    
    // タイム操作シート対象席
    @State private var timeActionTargetId: String? = nil
    
    // チェック操作シート対象席
    @State private var checkActionTargetId: String? = nil
    
    // シャンプー操作シート対象席（スタッフ指定済み時: 「シャンプーする」「スタッフ変更」）
    @State private var shampooActionTargetId: String? = nil
    
    // ヘルプスタッフ選択シート対象席（未指定時またはスタッフ変更時）
    @State private var selectHelpStaffTargetId: String? = nil
    
    // チェック担当スタッフ選択シート対象席（未指定時または担当変更時）
    @State private var selectCheckStaffTargetId: String? = nil
    
    // 共有通知バナー（トースト表示）
    @State private var notificationBannerText: String? = nil
    @State private var notificationBannerColor: Color = Color(hex: "#0A84FF")
    
    // 客席サムネイル・バードビュー（一覧）表示フラグ（起動時およびモジュラー文字盤タップ時は一覧をデフォルト表示）
    @State private var showingThumbnailMap = true
    @State private var showingMainTimerSheet = false
    @State private var hasInitialOpenedMap = false
    @State private var pendingSelectedSeatId: String? = nil
    @State private var pendingOpenMainTimerSheet: Bool = false
    
    // 客席タイマー一覧（永続化データから即座に復元し、バックグラウンド再起動時の予定消滅を防止）
    @State private var timers: [SeatTimerItem] = WatchSessionManager.shared.timers
    // メインタイマー（永続化データから即座に復元）
    @State private var mainTimer: SeatTimerItem? = WatchSessionManager.shared.mainTimer
    
    // ★ タイム確定時などの自動スクロール用ステート
    @State private var scrollToSeatId: String? = nil
    @State private var scrollTrigger: Int = 0
    
    private func triggerScroll(to seatId: String) {
        scrollToSeatId = seatId
        scrollTrigger += 1
    }
    
    // 1秒周期の画面再描画トリガー
    @State private var now = Date()
    let ticker = Timer.publish(every: 1.0, on: .main, in: .common).autoconnect()
    
    // 「自分が入る予定のタイマー」や「自分が作成したタイマー」を自動で最上部にソート
    var sortedTimers: [SeatTimerItem] {
        return timers.sorted { a, b in
            // ① 計測終了（アコーディオン収納済み）は最下部へ
            if a.isCollapsed != b.isCollapsed {
                return !a.isCollapsed && b.isCollapsed
            }
            
            let aMine = a.isRelated(to: currentUserName)
            let bMine = b.isRelated(to: currentUserName)
            
            // ② 自分関係の席（自分が入る/作成した）を最優先で上にする
            if aMine != bMine {
                return aMine && !bMine
            }
            
            // ③ 同じグループ内では超過中の席を最優先
            if a.isOvertime != b.isOvertime {
                return a.isOvertime && !b.isOvertime
            }
            
            // ④ 稼働中（isRunning）を停止中より優先
            if a.isRunning != b.isRunning {
                return a.isRunning && !b.isRunning
            }
            
            // ⑤ 残り時間が少ない順
            if a.remainingSeconds != b.remainingSeconds {
                return a.remainingSeconds < b.remainingSeconds
            }
            
            // ⑥ 席番号順
            return a.seatNumber < b.seatNumber
        }
    }
    
    // 通知バナー表示ヘルパー
    private func showNotification(text: String, color: Color = Color(hex: "#0A84FF")) {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
            notificationBannerText = text
            notificationBannerColor = color
        }
        playHaptic(.notification)
        
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) {
            withAnimation(.easeOut(duration: 0.3)) {
                if notificationBannerText == text {
                    notificationBannerText = nil
                }
            }
        }
    }
    
    // シート用のバインディング
    private var bindingTimeAction: Binding<SeatTimerItem?> {
        Binding(
            get: { timers.first { $0.id == timeActionTargetId } },
            set: { _ in timeActionTargetId = nil }
        )
    }
    
    private var bindingCheckAction: Binding<SeatTimerItem?> {
        Binding(
            get: { timers.first { $0.id == checkActionTargetId } },
            set: { _ in checkActionTargetId = nil }
        )
    }
    
    private var bindingShampooAction: Binding<SeatTimerItem?> {
        Binding(
            get: { timers.first { $0.id == shampooActionTargetId } },
            set: { _ in shampooActionTargetId = nil }
        )
    }
    
    private var bindingSelectHelpStaff: Binding<SeatTimerItem?> {
        Binding(
            get: { timers.first { $0.id == selectHelpStaffTargetId } },
            set: { _ in selectHelpStaffTargetId = nil }
        )
    }
    
    private var bindingSelectCheckStaff: Binding<SeatTimerItem?> {
        Binding(
            get: { timers.first { $0.id == selectCheckStaffTargetId } },
            set: { _ in selectCheckStaffTargetId = nil }
        )
    }
    
    // ★ アラーム鳴動時に前面のモーダルシートがアラーム停止画面（alarmOverlay）を覆い隠さないよう全シートを即座に閉じる
    private func dismissAllSheetsForAlarm() {
        executePendingMainTimerSheetAction()
        pendingSelectedSeatId = nil
        pendingOpenMainTimerSheet = false
        showingAddSeatSheet = false
        timeActionTargetId = nil
        checkActionTargetId = nil
        shampooActionTargetId = nil
        selectHelpStaffTargetId = nil
        selectCheckStaffTargetId = nil
        showingMainTimerSheet = false
    }
    
    // ★ MainTimerActionSheet の dismiss() トランザクションと親画面の @State/@Published 更新が衝突しないようシート閉鎖完了後に実行
    private func deferMainTimerSheetCloseAction(_ action: @escaping () -> Void) {
        pendingMainTimerSheetActionBox.action = action
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            executePendingMainTimerSheetAction()
        }
    }
    
    private func executePendingMainTimerSheetAction() {
        guard let action = pendingMainTimerSheetActionBox.action else { return }
        pendingMainTimerSheetActionBox.action = nil
        DispatchQueue.main.async {
            action()
        }
    }

    var body: some View {
        ZStack {
            NavigationStack {
                ZStack(alignment: .top) {
                    if showingThumbnailMap {
                        thumbnailMapSheetView
                    } else {
                        cardsScrollView
                    }
                    
                    if let banner = notificationBannerText {
                        bannerView(banner)
                    }
                }
                .onChange(of: timers) { _, newTimers in
                    alarm.update(timers: newTimers, mainTimer: sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                    WidgetSync.save(timers: newTimers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                }
                .onChange(of: alarm.ringing) { _, newRinging in
                    if !newRinging.isEmpty {
                        dismissAllSheetsForAlarm()
                    }
                }
                .onChange(of: showingMainTimerSheet) { _, isShowing in
                    if isShowing && !alarm.ringing.isEmpty {
                        showingMainTimerSheet = false
                    }
                }
                .navigationTitle(showingThumbnailMap ? "客席一覧" : "共有タイマー")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(alarm.ringing.isEmpty ? .visible : .hidden, for: .navigationBar)
                .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: {
                        playHaptic(.click)
                        sessionManager.requestSyncFromPhone()
                        showNotification(text: "🔄 iPhoneへ同期要求送信", color: Color(hex: "#0A84FF"))
                    }) {
                        HStack(spacing: 3) {
                            Circle()
                                .fill(linkColor)
                                .frame(width: 6, height: 6)
                            Image(systemName: "arrow.triangle.2.circlepath")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(Color(hex: "#0A84FF"))
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: {
                        playHaptic(.click)
                        withAnimation(.easeInOut(duration: 0.2)) {
                            showingThumbnailMap.toggle()
                        }
                    }) {
                        Image(systemName: showingThumbnailMap ? "list.bullet" : "square.grid.2x2.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(Color(hex: "#64D2FF"))
                    }
                }
            }
            // ★ メインタイマー専用操作・時間設定シート（メイン画面・一覧画面のカードタップ用）
            .sheet(isPresented: $showingMainTimerSheet, onDismiss: {
                executePendingMainTimerSheetAction()
            }) {
                mainTimerSheetView
            }
            // 新規席追加シート
            .sheet(isPresented: $showingAddSeatSheet, onDismiss: {
                if let targetId = scrollToSeatId {
                    triggerScroll(to: targetId)
                }
            }) {
                addSeatSheetView
            }
            // タイム操作シート
            .sheet(item: bindingTimeAction, onDismiss: {
                if let targetId = scrollToSeatId {
                    triggerScroll(to: targetId)
                }
            }) { item in
                timeActionSheetView(item: item)
            }
            // チェック操作シート
            .sheet(item: bindingCheckAction) { item in
                checkActionSheetView(item: item)
            }
            // ★ シャンプー・施術操作シート
            .sheet(item: bindingShampooAction) { item in
                shampooActionSheetView(item: item)
            }
            // ★ ヘルプ工程選択・スタッフ指定・募集シート
            .sheet(item: bindingSelectHelpStaff) { item in
                selectHelpWorkflowSheetView(item: item)
            }
            // ★ チェック担当スタッフ指定・募集シート
            .sheet(item: bindingSelectCheckStaff) { item in
                selectCheckStaffSheetView(item: item)
            }
            .onReceive(ticker) { input in
                now = input
                // ★ 準備中カウントダウンが0秒に到達したらローカルでも即座に本番タイマー稼働へ移行
                if var m = self.mainTimer ?? sessionManager.mainTimer,
                   m.isPreCountingDown,
                   let prepEnd = m.prepEndTime,
                   input >= prepEnd {
                    m.isPreCountingDown = false
                    m.preCountdownSeconds = 0
                    m.prepEndTime = nil
                    m.isRunning = true
                    let runSec = m.pausedRemainingSeconds > 0 ? m.pausedRemainingSeconds : m.totalSeconds
                    m.targetEndTime = prepEnd.addingTimeInterval(TimeInterval(runSec))
                    self.mainTimer = m
                    sessionManager.mainTimer = m
                    WidgetSync.save(timers: timers, mainTimer: m, userName: currentUserName)
                    alarm.update(timers: timers, mainTimer: m, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                }
                checkUnassignedHelpAlerts()
                alarm.tick()
                // ★ カウントアップOFF設定のとき、メインタイマーが終了時刻（00:00）に到達したらアラーム発火後に自動停止（超過カウントアップへ突入させない）
                if var m = self.mainTimer ?? sessionManager.mainTimer,
                   m.isRunning,
                   !m.isPreCountingDown,
                   !m.isCountUpEnabled,
                   input >= m.targetEndTime {
                    m.isRunning = false
                    m.pausedRemainingSeconds = m.totalSeconds
                    sessionManager.clearWatchStartedMainTimer()
                    self.mainTimer = m
                    sessionManager.mainTimer = m
                    WidgetSync.save(timers: timers, mainTimer: m, userName: currentUserName)
                    alarm.update(timers: timers, mainTimer: m, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                }
            }
            .onReceive(sessionManager.$timers) { received in
                withAnimation(.easeInOut(duration: 0.25)) {
                    self.timers = received
                }
            }
            .onReceive(sessionManager.$mainTimer) { receivedMain in
                if let receivedMain = receivedMain, self.mainTimer != receivedMain {
                    self.mainTimer = receivedMain
                }
            }
            .onReceive(sessionManager.$currentUserName) { receivedName in
                if !receivedName.isEmpty {
                    self.currentUserName = receivedName
                }
            }
            .onReceive(sessionManager.$incomingNotification) { notif in
                if let notif = notif {
                    showNotification(text: notif.text, color: Color(hex: notif.color))
                    sessionManager.incomingNotification = nil
                }
            }
            .onAppear {
                sessionManager.requestSyncFromPhone()
                if let initialMain = sessionManager.mainTimer {
                    self.mainTimer = initialMain
                }
                alarm.update(timers: timers, mainTimer: sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                // ★ 初回起動時は一覧（サロン客席マップ）をインラインで直接表示（モーダルシート競合によるブラックアウトも完全根絶）
                if !hasInitialOpenedMap {
                    hasInitialOpenedMap = true
                    showingThumbnailMap = true
                }
                if !alarm.ringing.isEmpty {
                    dismissAllSheetsForAlarm()
                }
            }
            .onOpenURL { url in
                handleOpenURL(url)
            }
        }
        
        // ★ アラーム鳴動時はナビゲーションバーも含めて画面全体をマイルド深紅オーバーレイで覆う
        if !alarm.ringing.isEmpty {
            alarmOverlay
                .zIndex(10)
                .transition(.opacity)
        }
    }
}

    // ★ コンプリケーション（モジュラー文字盤）等からのURL起動ハンドラ（bodyの型推論負荷を軽減するため分離）
    private func handleOpenURL(_ url: URL) {
        // ★ モジュラー文字盤タップ時: 未消火アラームがあればアラーム振動のみ消火し、超過カウントアップは止めない（アプリ内で明示操作するまで00:00に戻さない）
        if !alarm.ringing.isEmpty {
            alarm.stop(sendToPhone: false)
        }
        // 開いている余計なシートを閉じて一覧（サロン客席マップ）を確実に表示
        showingMainTimerSheet = false
        showingAddSeatSheet = false
        timeActionTargetId = nil
        checkActionTargetId = nil
        shampooActionTargetId = nil
        selectHelpStaffTargetId = nil
        selectCheckStaffTargetId = nil

        if url.host == "list" {
            showingThumbnailMap = false
        } else {
            // モジュラー文字盤タップ（open-map / open / main / seat 等の全コンプリケーションURL）では一覧画面を開く
            showingThumbnailMap = true
            if url.host == "seat",
               let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
               let seatId = components.queryItems?.first(where: { $0.name == "id" })?.value,
               !seatId.isEmpty {
                triggerScroll(to: seatId)
            }
        }
    }
    
    // ★ 席が0件のときのプレースホルダー（iPhone同期案内）
    @ViewBuilder
    private var emptySeatsPlaceholderView: some View {
        VStack(spacing: 10) {
            Image(systemName: "iphone.radiowaves.left.and.right")
                .font(.system(size: 34))
                .foregroundColor(Color(hex: "#0A84FF"))
                .padding(.top, 14)
            
            Text("📱 iPhoneで席を追加してください")
                .font(.system(size: 13, weight: .bold))
                .foregroundColor(.white)
                .multilineTextAlignment(.center)
            
            Text("サロンワーク画面の客席と\n自動でリアルタイム連動します")
                .font(.system(size: 11))
                .foregroundColor(Color(hex: "#8E8E93"))
                .multilineTextAlignment(.center)
                .lineSpacing(2)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
        .padding(.horizontal, 10)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Color(hex: "#1C1C1E"))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(Color(hex: "#2C2C2E"), lineWidth: 1)
                )
        )
        .padding(.horizontal, 4)
    }

    // ★ 接続ランプの色（緑=iPhoneと通信可能 / 黄=有効化済み・iPhoneアプリ未接続 / 灰=未有効化）
    private var linkColor: Color {
        switch sessionManager.linkState {
        case 2: return Color(hex: "#30D158")
        case 1: return Color(hex: "#FFD60A")
        default: return Color.gray
        }
    }
    
    private func diagTime(_ date: Date?) -> String {
        guard let date = date else { return "--:--:--" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f.string(from: date)
    }
    
    // ★ 通信状態パネル（診断用・常時表示。不要になったら cardsScrollView から外す）
    @ViewBuilder
    private var diagnosticPanel: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Circle()
                    .fill(linkColor)
                    .frame(width: 6, height: 6)
                Text(sessionManager.linkState == 2 ? "iPhoneと通信可能" : (sessionManager.linkState == 1 ? "有効・iPhone未接続" : "未有効化"))
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(.white)
            }
            Text("状態:\(sessionManager.activationStateText) / iPhoneアプリ:\(sessionManager.isCompanionAppInstalled ? "○" : "×")")
                .font(.system(size: 9))
                .foregroundColor(Color(hex: "#8E8E93"))
            Text("送信 \(diagTime(sessionManager.lastSentAt)) \(sessionManager.lastSentAction)")
                .font(.system(size: 9))
                .foregroundColor(Color(hex: "#8E8E93"))
            Text("結果: \(sessionManager.lastSendResult)")
                .font(.system(size: 9))
                .foregroundColor(Color(hex: "#8E8E93"))
                .lineLimit(3)
            Text("受信 \(sessionManager.receivedCount)回 \(diagTime(sessionManager.lastReceivedAt)) \(sessionManager.lastReceivedKind) \(sessionManager.lastReceivedSeatCount >= 0 ? "\(sessionManager.lastReceivedSeatCount)席" : "")")
                .font(.system(size: 9))
                .foregroundColor(Color(hex: "#8E8E93"))
            Text("⏰ \(alarm.statusText)")
                .font(.system(size: 9))
                .foregroundColor(Color(hex: "#8E8E93"))
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(hex: "#1C1C1E"))
        )
        .padding(.horizontal, 4)
    }

    // MARK: - ★ アラーム鳴動中の連動アクション判定（シャンプーとチェックは同居せずヘルプ連動・未指定は止めるのみ）
    private enum RingingHelpAction {
        case check(isCheckOnly: Bool) // チェックに入る (isCheckOnly: trueなら全体タイマーは止まらない)
        case shampoo(label: String)   // シャンプーに入る (全体タイマー停止)
        case custom(label: String)    // コーミング等に入る (全体タイマー停止)
    }

    private var activeRingingAction: (item: SeatTimerItem, action: RingingHelpAction)? {
        guard let firstEvent = alarm.ringing.first else { return nil }
        guard let seat = timers.first(where: { $0.id == firstEvent.seatId }) else { return nil }
        
        let isCheckAlarm = firstEvent.key.contains("-check@")
        if isCheckAlarm {
            // 中間チェックタイマーのアラーム: チェックタイマーのみ停止、全体は止まらない
            return (item: seat, action: .check(isCheckOnly: true))
        }
        
        // 全体タイマーのアラーム: ヘルプ指定項目に連動（未指定ならnil）
        if seat.isNoHelpNeeded { return nil }
        let rawProcess = seat.helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
        if rawProcess.isEmpty { return nil }
        
        if rawProcess == "チェック" {
            // 全体タイマーのヘルプがチェック: 全体タイマーも止まる
            return (item: seat, action: .check(isCheckOnly: false))
        } else if rawProcess == "シャンプー" {
            return (item: seat, action: .shampoo(label: "シャンプーに入る"))
        } else {
            return (item: seat, action: .custom(label: "\(rawProcess)に入る"))
        }
    }

    // ★ タイムアップ時の全画面アラーム表示（watchOS純正準拠・漆黒ピュアブラック ＆ 鮮烈アクセントUI）
    @ViewBuilder
    private var alarmOverlay: some View {
        ScrollView {
            VStack(spacing: 7) {
                Spacer(minLength: 10)
                
                // アイコン ＋ タイムアップ
                VStack(spacing: 3) {
                    Image(systemName: "bell.badge.fill")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundColor(Color(hex: "#FF453A"))
                    
                    Text("タイムアップ")
                        .font(.system(size: 17, weight: .black, design: .rounded))
                        .foregroundColor(.white)
                }
                
                // 席名・アラーム対象 ＋ リアルタイム超過カウントアップ表示
                VStack(spacing: 4) {
                    ForEach(alarm.ringing.prefix(3), id: \.key) { e in
                        let overSec = max(0, Int(now.timeIntervalSince(e.date)))
                        let overText = String(format: "超過 +%02d:%02d", overSec / 60, overSec % 60)
                        VStack(spacing: 2) {
                            Text(e.title)
                                .font(.system(size: 14, weight: .heavy, design: .rounded))
                                .foregroundColor(.white)
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                            Text(overText)
                                .font(.system(size: 15, weight: .black, design: .rounded))
                                .monospacedDigit()
                                .foregroundColor(Color(hex: "#FF453A"))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color(hex: "#FF453A").opacity(0.22))
                        .cornerRadius(8)
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(Color(hex: "#FF453A").opacity(0.45), lineWidth: 1)
                        )
                    }
                    if alarm.ringing.count > 3 {
                        Text("ほか \(alarm.ringing.count - 3) 件")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.white.opacity(0.75))
                    }
                }
                
                Spacer(minLength: 6)
                
                // ★ 連動ボタン ＆ 止めるボタン ＆ 超過カウント続行ボタン
                if let ringingInfo = activeRingingAction {
                    // ① 内容連動ボタン（シャンプーに入る／チェックに入る等）
                    switch ringingInfo.action {
                    case .check(let isCheckOnly):
                        Button(action: {
                            alarm.stop(sendToPhone: false, completeCheckIfNeeded: false)
                            WKInterfaceDevice.current().play(.success)
                            if let idx = timers.firstIndex(where: { $0.id == ringingInfo.item.id }) {
                                if isCheckOnly {
                                    // ★ チェックタイマーのみ停止・完了（全体のタイマーは止まらない！残りの全体タイマーを新しいタイマーとして入れ直す）
                                    sessionManager.markLocalCheckClear(seatId: ringingInfo.item.id, checkEndTime: timers[idx].checkTargetEndTime)
                                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                        timers[idx].isCheckCompleted = true
                                        timers[idx].checkStaff = currentUserName
                                        timers[idx].checkTargetEndTime = nil
                                        timers[idx].checkTotalSeconds = nil
                                    }
                                    sessionManager.timers = timers
                                    WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                                        seatId: ringingInfo.item.id,
                                        timers: timers,
                                        mainTimer: self.mainTimer ?? sessionManager.mainTimer,
                                        soundOn: sessionManager.alarmSoundEnabled,
                                        currentUserName: currentUserName
                                    )
                                    sessionManager.sendActionToPhone(action: "COMPLETE_CHECK", seatId: ringingInfo.item.id)
                                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                                    showNotification(
                                        text: "✅ 【\(ringingInfo.item.displaySeatName)】チェック完了（タイマー続行）",
                                        color: Color(hex: "#30D158")
                                    )
                                } else {
                                    // ★ 全体タイマーのチェック: 全体のタイマーも止まる
                                    sessionManager.markLocalCheckClear(seatId: ringingInfo.item.id, checkEndTime: timers[idx].checkTargetEndTime)
                                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                        timers[idx].isRunning = false
                                        timers[idx].pausedRemainingSeconds = 0
                                        timers[idx].isCheckCompleted = true
                                        timers[idx].checkStaff = currentUserName
                                        timers[idx].checkTargetEndTime = nil
                                        timers[idx].checkTotalSeconds = nil
                                    }
                                    sessionManager.timers = timers
                                    sessionManager.markLocalStop(seatId: ringingInfo.item.id, endTime: ringingInfo.item.targetEndTime)
                                    WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                                    sessionManager.sendActionToPhone(action: "STOP_TIMER", seatId: ringingInfo.item.id, extra: ["expectedEnd": ringingInfo.item.expectedEndMs])
                                    sessionManager.sendActionToPhone(action: "COMPLETE_CHECK", seatId: ringingInfo.item.id)
                                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                                    showNotification(
                                        text: "✅ 【\(ringingInfo.item.displaySeatName)】\(currentUserName)さんがチェックに入りました",
                                        color: Color(hex: "#30D158")
                                    )
                                }
                            }
                        }) {
                            HStack(spacing: 5) {
                                Image(systemName: "magnifyingglass")
                                    .font(.system(size: 13, weight: .heavy))
                                Text(isCheckOnly ? "チェックに入る（タイマー続行）" : "チェックに入る")
                                    .font(.system(size: 14, weight: .heavy))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(
                                LinearGradient(
                                    colors: [Color(hex: "#30D158"), Color(hex: "#248A3D")],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                            .foregroundColor(.white)
                            .cornerRadius(12)
                            .shadow(color: Color(hex: "#30D158").opacity(0.35), radius: 3, x: 0, y: 1)
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal, 4)
                        
                    case .shampoo(let label):
                        Button(action: {
                            alarm.stop(sendToPhone: false)
                            WKInterfaceDevice.current().play(.success)
                            if let idx = timers.firstIndex(where: { $0.id == ringingInfo.item.id }) {
                                withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                    timers[idx].isRunning = false
                                    timers[idx].pausedRemainingSeconds = 0
                                    timers[idx].status = .normal
                                    timers[idx].shampooStaff = currentUserName
                                    timers[idx].isRecruiting = false
                                }
                                sessionManager.timers = timers
                                sessionManager.markLocalStop(seatId: ringingInfo.item.id, endTime: ringingInfo.item.targetEndTime)
                                WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                                sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: ringingInfo.item.id, extra: ["expectedEnd": ringingInfo.item.expectedEndMs, "isCompleted": true])
                                WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                                showNotification(
                                    text: "✅ 【\(ringingInfo.item.displaySeatName)】\(currentUserName)さんがシャンプーに入りました",
                                    color: Color(hex: "#30D158")
                                )
                            }
                        }) {
                            HStack(spacing: 5) {
                                Image(systemName: "drop.fill")
                                    .font(.system(size: 13, weight: .heavy))
                                Text(label)
                                    .font(.system(size: 14, weight: .heavy))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(
                                LinearGradient(
                                    colors: [Color(hex: "#0A84FF"), Color(hex: "#0062D2")],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                            .foregroundColor(.white)
                            .cornerRadius(12)
                            .shadow(color: Color(hex: "#0A84FF").opacity(0.35), radius: 3, x: 0, y: 1)
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal, 4)
                        
                    case .custom(let label):
                        let iconName = (ringingInfo.item.helpProcess == "コーミング") ? "comb.fill" : "sparkles"
                        Button(action: {
                            alarm.stop(sendToPhone: false)
                            WKInterfaceDevice.current().play(.success)
                            if let idx = timers.firstIndex(where: { $0.id == ringingInfo.item.id }) {
                                let process = ringingInfo.item.helpProcess
                                withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                    timers[idx].isRunning = false
                                    timers[idx].pausedRemainingSeconds = 0
                                    timers[idx].status = .normal
                                    timers[idx].shampooStaff = currentUserName
                                    timers[idx].isRecruiting = false
                                }
                                sessionManager.timers = timers
                                sessionManager.markLocalStop(seatId: ringingInfo.item.id, endTime: ringingInfo.item.targetEndTime)
                                WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                                sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: ringingInfo.item.id, extra: ["expectedEnd": ringingInfo.item.expectedEndMs, "isCompleted": true])
                                WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                                showNotification(
                                    text: "✅ 【\(ringingInfo.item.displaySeatName)】\(currentUserName)さんが\(process)に入りました",
                                    color: Color(hex: "#30D158")
                                )
                            }
                        }) {
                            HStack(spacing: 5) {
                                Image(systemName: iconName)
                                    .font(.system(size: 13, weight: .heavy))
                                Text(label)
                                    .font(.system(size: 14, weight: .heavy))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(
                                LinearGradient(
                                    colors: [Color(hex: "#0A84FF"), Color(hex: "#0062D2")],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                            .foregroundColor(.white)
                            .cornerRadius(12)
                            .shadow(color: Color(hex: "#0A84FF").opacity(0.35), radius: 3, x: 0, y: 1)
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal, 4)
                    }
                    
                    // ② 止めるボタン（00:00に戻す）
                    Button(action: {
                        alarm.stop()
                        WKInterfaceDevice.current().play(.success)
                    }) {
                        Text("止める（00:00に戻す）")
                            .font(.system(size: 14, weight: .heavy, design: .rounded))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Color(hex: "#FF453A"))
                            .foregroundColor(.white)
                            .cornerRadius(12)
                            .shadow(color: Color(hex: "#FF453A").opacity(0.3), radius: 3, x: 0, y: 1)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 4)
                    
                    // ③ 超過カウントを続行してカード画面を見るボタン（00:00に戻さない）
                    Button(action: {
                        alarm.stop(sendToPhone: false)
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("超過カウント続行（画面を見る）")
                            .font(.system(size: 11.5, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color.white.opacity(0.14))
                            .foregroundColor(Color(hex: "#FFD60A"))
                            .cornerRadius(10)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 4)
                    .padding(.bottom, 4)
                } else {
                    // ★ ヘルプ未指定時・メインタイマー時: 「止める（00:00に戻す）」＆「超過カウント続行」
                    Button(action: {
                        alarm.stop()
                        WKInterfaceDevice.current().play(.success)
                    }) {
                        Text("止める（00:00に戻す）")
                            .font(.system(size: 16, weight: .heavy, design: .rounded))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color(hex: "#FF453A"))
                            .foregroundColor(.white)
                            .cornerRadius(14)
                            .shadow(color: Color(hex: "#FF453A").opacity(0.35), radius: 5, x: 0, y: 2)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 6)
                    
                    Button(action: {
                        alarm.stop(sendToPhone: false)
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("超過カウント続行（画面を見る）")
                            .font(.system(size: 11.5, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color.white.opacity(0.14))
                            .foregroundColor(Color(hex: "#FFD60A"))
                            .cornerRadius(10)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 6)
                    .padding(.bottom, 6)
                }
            }
            .padding(.horizontal, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
        .ignoresSafeArea()
    }

    @ViewBuilder
    private var cardsScrollView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 12) {
                    // ★ メインタイマーカード（HomeScreen連動・エメラルドグリーン、常に操作可能）
                    let currentMain = self.mainTimer ?? sessionManager.mainTimer ?? defaultMainTimer()
                    MainTimerCard(
                        item: currentMain,
                        now: now,
                        onToggle: {
                            handleToggleMainTimer()
                        },
                        onReset: {
                            handleResetMainTimer()
                        },
                        onOpenAction: {
                            showingMainTimerSheet = true
                        }
                    )
                    .id("main_timer")
                    
                    if timers.isEmpty {
                        // ★ 客席タイマーが0件の時のプレースホルダー表示
                        emptySeatsPlaceholderView
                    } else {
                        // ① 客席タイマーカード一覧
                        ForEach(sortedTimers) { item in
                            SeatTimerCard(
                                item: binding(for: item.id),
                                currentUserName: currentUserName,
                                now: now,
                                onOpenTimeAction: {
                                    timeActionTargetId = item.id
                                    playHaptic(.click)
                                },
                                onOpenSelectHelpStaff: {
                                    selectHelpStaffTargetId = item.id
                                    playHaptic(.click)
                                },
                                onOpenShampooAction: {
                                    shampooActionTargetId = item.id
                                    playHaptic(.click)
                                },
                                onOpenCheckAction: {
                                    checkActionTargetId = item.id
                                    playHaptic(.click)
                                },
                                onOpenSelectCheckStaff: {
                                    selectCheckStaffTargetId = item.id
                                    playHaptic(.click)
                                },
                                onClaimCheck: {
                                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                        if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                                            timers[idx].checkStaff = currentUserName
                                        }
                                    }
                                    sessionManager.sendActionToPhone(action: "CLAIM_CHECK", seatId: item.id)
                                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                                    showNotification(text: "📤 チェック担当に立候補しました", color: Color(hex: "#30D158"))
                                }
                            )
                            .id(item.id)
                        }
                    }
                    
                    // ② 一番下に「新しい席を追加」ボタンを配置
                    Button(action: {
                        showingAddSeatSheet = true
                        playHaptic(.click)
                    }) {
                        HStack(spacing: 6) {
                            Image(systemName: "plus.circle.fill")
                                .font(.system(size: 15, weight: .bold))
                            Text("新しい席を追加")
                                .font(.system(size: 13, weight: .bold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Color(hex: "#0A84FF").opacity(0.18))
                        .foregroundColor(Color(hex: "#0A84FF"))
                        .cornerRadius(10)
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(Color(hex: "#0A84FF").opacity(0.4), lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 4)
                    .padding(.top, 4)
                    .id("add_seat_button")
                }
                .padding(.horizontal, 2)
                .padding(.bottom, 20)
            }
            .onChange(of: scrollTrigger) { _, _ in
                if let targetId = scrollToSeatId {
                    // シート消滅・レイアウト更新完了を待ってスムーズにスクロール
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                            proxy.scrollTo(targetId, anchor: .center)
                        }
                    }
                }
            }
            .simultaneousGesture(
                LongPressGesture(minimumDuration: 0.45)
                    .onEnded { _ in
                        playHaptic(.start)
                        showingThumbnailMap = true
                    }
            )
        }
    }
    
    private func bannerView(_ banner: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: "bell.badge.fill")
                .font(.system(size: 10, weight: .bold))
            Text(banner)
                .font(.system(size: 10, weight: .bold))
                .lineLimit(2)
                .minimumScaleFactor(0.8)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(notificationBannerColor)
        .foregroundColor(.white)
        .cornerRadius(12)
        .shadow(color: .black.opacity(0.5), radius: 3, x: 0, y: 2)
        .transition(.move(edge: .top).combined(with: .opacity))
        .padding(.horizontal, 4)
        .padding(.top, 2)
        .zIndex(100)
        .onTapGesture {
            withAnimation {
                notificationBannerText = nil
            }
        }
    }
    
    // MARK: - メインタイマー操作ヘルパー（型推論タイムアウト解消のための分離）
    private func defaultMainTimer() -> SeatTimerItem {
        SeatTimerItem(
            id: "main-timer",
            seatNumber: 0,
            seatLabel: "メインタイマー",
            creatorName: currentUserName.isEmpty ? "スタイリスト" : currentUserName,
            totalSeconds: 600,
            targetEndTime: Date().addingTimeInterval(600),
            isRunning: false,
            pausedRemainingSeconds: 600,
            isMainTimer: true
        )
    }
    
    private func handleToggleMainTimer() {
        playHaptic(.click)
        var main = self.mainTimer ?? sessionManager.mainTimer ?? defaultMainTimer()
        let wasOvertime = main.isOvertime
        let willPause = main.isRunning || main.isPreCountingDown
        let stoppedEnd = willPause ? main.targetEndTime.timeIntervalSince1970 : 0
        if willPause {
            if main.isPreCountingDown || wasOvertime {
                main.pausedRemainingSeconds = main.totalSeconds
                main.targetEndTime = now.addingTimeInterval(TimeInterval(main.totalSeconds))
            } else {
                main.pausedRemainingSeconds = max(0, Int(ceil(main.targetEndTime.timeIntervalSince(now))))
            }
            main.isRunning = false
            main.isPreCountingDown = false
            main.preCountdownSeconds = 0
            main.prepEndTime = nil
            WatchAlarmCoordinator.shared.acknowledgeMainTimer()
        } else {
            let isInitialStart = (main.pausedRemainingSeconds <= 0 || main.pausedRemainingSeconds == main.totalSeconds || main.isOvertime)
            if isInitialStart && main.isCountdownConfigEnabled && main.countdownConfigSeconds > 0 {
                let prepEnd = now.addingTimeInterval(TimeInterval(main.countdownConfigSeconds))
                main.isPreCountingDown = true
                main.preCountdownSeconds = main.countdownConfigSeconds
                main.prepEndTime = prepEnd
                main.isRunning = false
                main.pausedRemainingSeconds = main.totalSeconds
                main.targetEndTime = prepEnd.addingTimeInterval(TimeInterval(main.totalSeconds))
            } else {
                main.isRunning = true
                let rem = (main.pausedRemainingSeconds > 0 && !main.isOvertime) ? main.pausedRemainingSeconds : main.totalSeconds
                main.targetEndTime = now.addingTimeInterval(TimeInterval(rem))
            }
        }
        self.mainTimer = main
        sessionManager.mainTimer = main
        WidgetSync.save(timers: timers, mainTimer: main, userName: currentUserName)
        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: main, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
        sessionManager.sendMainTimerAction(
            action: willPause ? (wasOvertime ? "MAIN_TIMER_RESET" : "MAIN_TIMER_PAUSE") : "MAIN_TIMER_START",
            extra: willPause ? [:] : ["totalSeconds": main.totalSeconds],
            stoppedEndTime: stoppedEnd
        )
    }
    
    private func handleStartMainTimer() {
        playHaptic(.click)
        var main = self.mainTimer ?? sessionManager.mainTimer ?? defaultMainTimer()
        let isInitialStart = (main.pausedRemainingSeconds <= 0 || main.pausedRemainingSeconds == main.totalSeconds || main.isOvertime)
        if isInitialStart && main.isCountdownConfigEnabled && main.countdownConfigSeconds > 0 {
            let prepEnd = Date().addingTimeInterval(TimeInterval(main.countdownConfigSeconds))
            main.isPreCountingDown = true
            main.preCountdownSeconds = main.countdownConfigSeconds
            main.prepEndTime = prepEnd
            main.isRunning = false
            main.pausedRemainingSeconds = main.totalSeconds
            main.targetEndTime = prepEnd.addingTimeInterval(TimeInterval(main.totalSeconds))
        } else {
            main.isRunning = true
            let rem = (main.pausedRemainingSeconds > 0 && !main.isOvertime) ? main.pausedRemainingSeconds : main.totalSeconds
            main.targetEndTime = Date().addingTimeInterval(TimeInterval(rem))
        }
        self.mainTimer = main
        sessionManager.mainTimer = main
        WidgetSync.save(timers: timers, mainTimer: main, userName: currentUserName)
        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: main, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
        sessionManager.sendMainTimerAction(action: "MAIN_TIMER_START", extra: ["totalSeconds": main.totalSeconds])
    }
    
    private func handlePauseMainTimer() {
        playHaptic(.click)
        var main = self.mainTimer ?? sessionManager.mainTimer ?? defaultMainTimer()
        let wasOvertime = main.isOvertime
        let stoppedEnd = (main.isRunning || main.isPreCountingDown) ? main.targetEndTime.timeIntervalSince1970 : 0
        if main.isPreCountingDown || wasOvertime {
            main.pausedRemainingSeconds = main.totalSeconds
            main.targetEndTime = Date().addingTimeInterval(TimeInterval(main.totalSeconds))
        } else {
            main.pausedRemainingSeconds = max(0, Int(ceil(main.targetEndTime.timeIntervalSince(Date()))))
        }
        main.isRunning = false
        main.isPreCountingDown = false
        main.preCountdownSeconds = 0
        main.prepEndTime = nil
        self.mainTimer = main
        sessionManager.mainTimer = main
        WatchAlarmCoordinator.shared.acknowledgeMainTimer()
        WidgetSync.save(timers: timers, mainTimer: main, userName: currentUserName)
        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: main, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
        sessionManager.sendMainTimerAction(
            action: wasOvertime ? "MAIN_TIMER_RESET" : "MAIN_TIMER_PAUSE",
            stoppedEndTime: stoppedEnd
        )
    }
    
    private func handleResetMainTimer() {
        playHaptic(.click)
        var main = self.mainTimer ?? sessionManager.mainTimer ?? defaultMainTimer()
        let stoppedEnd = (main.isRunning || main.isPreCountingDown) ? main.targetEndTime.timeIntervalSince1970 : 0
        main.isRunning = false
        main.isPreCountingDown = false
        main.preCountdownSeconds = 0
        main.prepEndTime = nil
        main.pausedRemainingSeconds = main.totalSeconds
        main.targetEndTime = Date().addingTimeInterval(TimeInterval(main.totalSeconds))
        self.mainTimer = main
        sessionManager.mainTimer = main
        WatchAlarmCoordinator.shared.acknowledgeMainTimer()
        WidgetSync.save(timers: timers, mainTimer: main, userName: currentUserName)
        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: main, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
        sessionManager.sendMainTimerAction(action: "MAIN_TIMER_RESET", stoppedEndTime: stoppedEnd)
    }
    
    private func handleSetMainTimerTime(totalSec: Int, autoStart: Bool = true) {
        playHaptic(.click)
        var main = self.mainTimer ?? sessionManager.mainTimer ?? defaultMainTimer()
        main.totalSeconds = totalSec
        main.pausedRemainingSeconds = totalSec
        
        let shouldAutoStart = autoStart || main.isRunning
        if shouldAutoStart {
            // ★ タイム入力時に即座にカウントダウンを開始（客席タイマーと統一された直感的UX）
            if main.isCountdownConfigEnabled && main.countdownConfigSeconds > 0 {
                let prepEnd = Date().addingTimeInterval(TimeInterval(main.countdownConfigSeconds))
                main.isPreCountingDown = true
                main.preCountdownSeconds = main.countdownConfigSeconds
                main.prepEndTime = prepEnd
                main.isRunning = false
                main.targetEndTime = prepEnd.addingTimeInterval(TimeInterval(totalSec))
            } else {
                main.isRunning = true
                main.isPreCountingDown = false
                main.preCountdownSeconds = 0
                main.prepEndTime = nil
                main.targetEndTime = Date().addingTimeInterval(TimeInterval(totalSec))
            }
        } else {
            main.isRunning = false
            main.isPreCountingDown = false
            main.preCountdownSeconds = 0
            main.prepEndTime = nil
            main.targetEndTime = Date().addingTimeInterval(TimeInterval(totalSec))
        }
        self.mainTimer = main
        sessionManager.mainTimer = main
        WidgetSync.save(timers: timers, mainTimer: main, userName: currentUserName)
        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: main, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
        sessionManager.sendMainTimerSetTime(seconds: totalSec, autoStart: shouldAutoStart)
    }
    
    private func handleAdjustMainTimer(deltaSec: Int) {
        playHaptic(.click)
        var main = self.mainTimer ?? sessionManager.mainTimer ?? defaultMainTimer()
        if main.isRunning {
            let baseEnd = main.isOvertime ? Date() : main.targetEndTime
            main.targetEndTime = max(Date().addingTimeInterval(5), baseEnd.addingTimeInterval(Double(deltaSec)))
        } else {
            let nextSec = max(10, main.pausedRemainingSeconds + deltaSec)
            main.pausedRemainingSeconds = nextSec
            main.totalSeconds = nextSec
            main.isRunning = false
            if main.isPreCountingDown {
                let prepEnd = main.prepEndTime ?? Date().addingTimeInterval(TimeInterval(max(1, main.preCountdownSeconds)))
                main.targetEndTime = prepEnd.addingTimeInterval(TimeInterval(nextSec))
            }
        }
        self.mainTimer = main
        sessionManager.mainTimer = main
        WidgetSync.save(timers: timers, mainTimer: main, userName: currentUserName)
        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: main, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
        sessionManager.sendMainTimerAdjust(seconds: deltaSec)
    }
    
    @ViewBuilder
    private var thumbnailMapSheetView: some View {
        SeatThumbnailMapSheet(
            timers: timers,
            mainTimer: self.mainTimer ?? sessionManager.mainTimer ?? defaultMainTimer(),
            currentUserName: currentUserName,
            now: now,
            onSelectSeat: { selectedSeat in
                triggerScroll(to: selectedSeat.id)
                timeActionTargetId = selectedSeat.id
            },
            onSelectMainTimer: {
                showingMainTimerSheet = true
            },
            onToggleMainTimer: { handleToggleMainTimer() },
            onResetMainTimer: { handleResetMainTimer() },
            onSetMainTimerTime: { handleSetMainTimerTime(totalSec: $0) },
            onAdjustMainTimer: { handleAdjustMainTimer(deltaSec: $0) },
            onStartMainTimer: { handleStartMainTimer() },
            onPauseMainTimer: { handlePauseMainTimer() },
            onClose: {
                withAnimation(.easeInOut(duration: 0.2)) {
                    showingThumbnailMap = false
                }
            },
            onAddSeat: {
                showingAddSeatSheet = true
            }
        )
    }
    
    @ViewBuilder
    private var mainTimerSheetView: some View {
        let currentMain = self.mainTimer ?? sessionManager.mainTimer ?? defaultMainTimer()
        MainTimerActionSheet(
            item: currentMain,
            onStart: {
                deferMainTimerSheetCloseAction {
                    handleStartMainTimer()
                }
            },
            onPause: { handlePauseMainTimer() },
            onReset: {
                handleResetMainTimer()
            },
            onSetTime: { sec in
                deferMainTimerSheetCloseAction {
                    handleSetMainTimerTime(totalSec: sec)
                }
            },
            onAdjust: { handleAdjustMainTimer(deltaSec: $0) }
        )
    }
    
    @ViewBuilder
    private var addSeatSheetView: some View {
        AddSeatSheet(
            currentUserName: currentUserName,
            suggestedSeatNumber: (timers.map { $0.seatNumber }.max() ?? 0) + 1,
            onAdd: { newSeat in
                triggerScroll(to: newSeat.id)
                withAnimation {
                    timers.append(newSeat)
                }
                sessionManager.timers = timers
                WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                WidgetSync.save(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, userName: currentUserName)
                var extra: [String: Any] = [
                    "seatNumber": newSeat.seatNumber,
                    "totalSeconds": newSeat.totalSeconds,
                    "targetEndTimestamp": newSeat.targetEndTime.timeIntervalSince1970 * 1000.0
                ]
                if let checkSec = newSeat.checkTotalSeconds {
                    extra["checkTotalSeconds"] = checkSec
                    if let checkEnd = newSeat.checkTargetEndTime {
                        extra["checkEndTimestamp"] = checkEnd.timeIntervalSince1970 * 1000.0
                    }
                }
                sessionManager.sendActionToPhone(action: "ADD_SEAT", seatId: newSeat.id, extra: extra)
                showNotification(text: "📤 \(newSeat.displaySeatName)を新規作成しました", color: Color(hex: "#0A84FF"))
            }
        )
    }
    
    @ViewBuilder
    private func timeActionSheetView(item: SeatTimerItem) -> some View {
        if item.isOvertime {
            // ★ カウントアップ（超過中）時の専用シート（3つのボタン: シャンプー入る、タイムリセット、計測終了）
            OvertimeActionSheet(
                item: item,
                currentUserName: currentUserName,
                onEnterHelp: {
                    triggerScroll(to: item.id)
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        let rawProcess = timers[idx].helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
                        let process = rawProcess.isEmpty ? "シャンプー" : rawProcess
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                            timers[idx].isRunning = false
                            // ★ 0:00 で停止
                            timers[idx].pausedRemainingSeconds = 0
                            // ★ 入る＝やったことになってる＝即座に完了（通常へ）！
                            timers[idx].status = .normal
                            timers[idx].shampooStaff = nil
                            timers[idx].helpProcess = ""
                            timers[idx].isRecruiting = false
                            if process == "チェック" {
                                timers[idx].checkStaff = currentUserName
                                timers[idx].isCheckCompleted = true
                            }
                        }
                        sessionManager.timers = timers
                        sessionManager.markLocalStop(seatId: item.id, endTime: item.targetEndTime)
                        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                        sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: item.id, extra: ["expectedEnd": item.expectedEndMs, "isCompleted": true])
                        WidgetSync.save(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, userName: currentUserName)
                        showNotification(
                            text: "✅ 【\(item.displaySeatName)】\(currentUserName)さんが\(process)を完了しました",
                            color: Color(hex: "#30D158")
                        )
                    }
                },
                onResetZero: {
                    triggerScroll(to: item.id)
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                            timers[idx].totalSeconds = 0
                            timers[idx].pausedRemainingSeconds = 0
                            timers[idx].targetEndTime = Date()
                            timers[idx].isRunning = false
                            timers[idx].status = .normal
                            timers[idx].clearCheck()
                            timers[idx].shampooStaff = nil
                            timers[idx].isRecruiting = false
                            timers[idx].isNoHelpNeeded = false
                            timers[idx].isCollapsed = true
                        }
                        sessionManager.timers = timers
                        sessionManager.setCollapseOverride(seatId: item.id, collapsed: true)
                        sessionManager.markLocalStop(seatId: item.id, endTime: item.targetEndTime)
                        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                        WidgetSync.save(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, userName: currentUserName)
                        sessionManager.sendActionToPhone(action: "RESET_ZERO", seatId: item.id, extra: ["expectedEnd": item.expectedEndMs])
                        showNotification(
                            text: "⏱️ \(item.displaySeatName): 00:00にリセットしました",
                            color: Color(hex: "#FFD60A")
                        )
                    }
                },
                onFinishMeasure: {
                    triggerScroll(to: item.id)
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                            timers[idx].isRunning = false
                            // ★ 0:00 の停止（以前は古い残り秒数がそのまま表示されることがあった）
                            timers[idx].pausedRemainingSeconds = 0
                            timers[idx].clearCheck()
                            timers[idx].isCollapsed = true
                        }
                        sessionManager.timers = timers
                        sessionManager.setCollapseOverride(seatId: item.id, collapsed: true)
                        sessionManager.markLocalStop(seatId: item.id, endTime: item.targetEndTime)
                        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                        WidgetSync.save(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, userName: currentUserName)
                        sessionManager.sendActionToPhone(action: "FINISH_MEASURE", seatId: item.id, extra: ["expectedEnd": item.expectedEndMs])
                        showNotification(
                            text: "🏁 \(item.displaySeatName): 計測を終了しました",
                            color: Color(hex: "#8E8E93")
                        )
                    }
                }
            )
        } else {
            // ★ 00:00になっている場合は、タップしたらタイム入力画面にそのまま移動！
            TimeActionSheet(
                item: item,
                initialReinputMode: item.isZero,
                onAdjust: { deltaSec in
                    triggerScroll(to: item.id)
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        let newEnd = timers[idx].targetEndTime.addingTimeInterval(Double(deltaSec))
                        timers[idx].targetEndTime = newEnd
                        timers[idx].pausedRemainingSeconds += deltaSec
                        timers[idx].isCollapsed = false
                        sessionManager.timers = timers
                        sessionManager.setCollapseOverride(seatId: item.id, collapsed: false)
                        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                        WidgetSync.save(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, userName: currentUserName)
                        sessionManager.sendActionToPhone(
                            action: "ADJUST_TIME",
                            seatId: item.id,
                            extra: [
                                "secondsToAdd": deltaSec,
                                "targetEndTimestamp": newEnd.timeIntervalSince1970 * 1000.0
                            ]
                        )
                        let deltaText = formatDeltaString(deltaSec)
                        showNotification(text: "⏱️ \(item.displaySeatName): \(deltaText)しました", color: Color(hex: "#0A84FF"))
                    }
                },
                onStop: {
                    triggerScroll(to: item.id)
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        timers[idx].isRunning = false
                        timers[idx].pausedRemainingSeconds = 0
                        // ★ チェックタイマーも解除（Q3）
                        timers[idx].clearCheck()
                        sessionManager.timers = timers
                        sessionManager.markLocalStop(seatId: item.id, endTime: item.targetEndTime)
                        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                        WidgetSync.save(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, userName: currentUserName)
                        sessionManager.sendActionToPhone(action: "STOP_TIMER", seatId: item.id, extra: ["expectedEnd": item.expectedEndMs])
                        showNotification(text: "⏹️ \(item.displaySeatName)のタイマーを止めました", color: Color(hex: "#30D158"))
                    }
                },
                onEnterHelp: {
                    // ★ タイムが早くても切り上げて指定施術（シャンプー・コーミング等）に入る
                    triggerScroll(to: item.id)
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        let rawProcess = timers[idx].helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
                        let process = rawProcess.isEmpty ? "シャンプー" : rawProcess
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                            timers[idx].isRunning = false
                            timers[idx].pausedRemainingSeconds = 0
                            timers[idx].status = .normal
                            timers[idx].shampooStaff = currentUserName
                            timers[idx].isRecruiting = false
                        }
                        sessionManager.timers = timers
                        sessionManager.markLocalStop(seatId: item.id, endTime: item.targetEndTime)
                        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                        sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: item.id, extra: ["expectedEnd": item.expectedEndMs, "isCompleted": true])
                        WidgetSync.save(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, userName: currentUserName)
                        showNotification(
                            text: "✅ 【\(item.displaySeatName)】\(currentUserName)さんが\(process)に入りました",
                            color: Color(hex: "#30D158")
                        )
                    }
                },
                onCompleteCheck: {
                    // ★ タイムが早くても切り上げてチェックに入る（全体タイマー連動のため全体タイマーも00:00停止）
                    triggerScroll(to: item.id)
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                            timers[idx].isRunning = false
                            timers[idx].pausedRemainingSeconds = 0
                            timers[idx].isCheckCompleted = true
                            timers[idx].checkStaff = currentUserName
                            timers[idx].checkTargetEndTime = nil
                            timers[idx].checkTotalSeconds = nil
                        }
                        sessionManager.timers = timers
                        sessionManager.markLocalStop(seatId: item.id, endTime: item.targetEndTime)
                        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                        sessionManager.sendActionToPhone(action: "STOP_TIMER", seatId: item.id, extra: ["expectedEnd": item.expectedEndMs])
                        sessionManager.sendActionToPhone(action: "COMPLETE_CHECK", seatId: item.id)
                        WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                        showNotification(
                            text: "✅ 【\(item.displaySeatName)】\(currentUserName)さんがチェックに入りました",
                            color: Color(hex: "#30D158")
                        )
                    }
                },
                onReinputTime: { totalSec, checkSec in
                    triggerScroll(to: item.id)
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        let sec = max(10, totalSec)
                        // ★ 全体タイムより短いチェック時間のみ有効
                        let validCheckSec = (checkSec != nil && checkSec! < sec) ? checkSec : nil
                        let m = sec / 60
                        let s = sec % 60
                        let timeStr = s > 0 ? "\(m)分\(s)秒" : "\(m)分"
                        let startBase = Date()
                        let mainEnd = startBase.addingTimeInterval(Double(sec))
                        let checkEnd = (validCheckSec != nil && validCheckSec! > 0) ? startBase.addingTimeInterval(Double(validCheckSec!)) : nil
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                            timers[idx].totalSeconds = sec
                            timers[idx].targetEndTime = mainEnd
                            timers[idx].pausedRemainingSeconds = sec
                            timers[idx].isRunning = true
                            timers[idx].status = .normal
                            timers[idx].isCollapsed = false
                            
                            // ★ 途中チェックタイマーの設定または解除
                            if let chk = validCheckSec, chk > 0, let cEnd = checkEnd {
                                timers[idx].checkTotalSeconds = chk
                                timers[idx].checkTargetEndTime = cEnd
                                timers[idx].checkStaff = nil
                                timers[idx].isCheckCompleted = false
                            } else {
                                timers[idx].clearCheck()
                            }
                        }
                        sessionManager.timers = timers
                        sessionManager.clearLocalCheckClear(seatId: item.id)
                        sessionManager.setCollapseOverride(seatId: item.id, collapsed: nil)
                        WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                        WidgetSync.save(timers: timers, mainTimer: self.mainTimer ?? sessionManager.mainTimer, userName: currentUserName)
                        var extraPayload: [String: Any] = [
                            "targetSeconds": sec,
                            "targetEndTimestamp": mainEnd.timeIntervalSince1970 * 1000.0
                        ]
                        if let chk = validCheckSec, chk > 0, let cEnd = checkEnd {
                            extraPayload["checkTotalSeconds"] = chk
                            extraPayload["checkEndTimestamp"] = cEnd.timeIntervalSince1970 * 1000.0
                        }
                        sessionManager.sendActionToPhone(action: "START_TIMER", seatId: item.id, extra: extraPayload)
                        
                        let checkText = (validCheckSec ?? 0) > 0 ? "（チェック\(validCheckSec! / 60)分）" : ""
                        showNotification(
                            text: "⏱️ \(item.displaySeatName): \(timeStr)に開始しました\(checkText)",
                            color: Color(hex: "#FFD60A")
                        )
                    }
                }
            )
        }
    }
    
    @ViewBuilder
    private func checkActionSheetView(item: SeatTimerItem) -> some View {
        CheckActionSheet(
            item: item,
            currentUserName: currentUserName,
            onOpenSelectStaff: {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    selectCheckStaffTargetId = item.id
                }
            },
            onCompleteCheck: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: timers[idx].checkTargetEndTime)
                    timers[idx].isCheckCompleted = true
                    timers[idx].checkStaff = currentUserName
                    timers[idx].checkTargetEndTime = nil
                    timers[idx].checkTotalSeconds = nil
                    sessionManager.timers = timers
                    WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                        seatId: item.id,
                        timers: timers,
                        mainTimer: self.mainTimer ?? sessionManager.mainTimer,
                        soundOn: sessionManager.alarmSoundEnabled,
                        currentUserName: currentUserName
                    )
                    sessionManager.sendActionToPhone(action: "COMPLETE_CHECK", seatId: item.id)
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    showNotification(text: "✅ チェック完了を全員へ通知しました", color: Color(hex: "#30D158"))
                }
            },
            onCancelCheck: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: timers[idx].checkTargetEndTime)
                    timers[idx].checkTargetEndTime = nil
                    timers[idx].checkTotalSeconds = nil
                    sessionManager.timers = timers
                    WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                        seatId: item.id,
                        timers: timers,
                        mainTimer: self.mainTimer ?? sessionManager.mainTimer,
                        soundOn: sessionManager.alarmSoundEnabled,
                        currentUserName: currentUserName
                    )
                    sessionManager.sendActionToPhone(action: "CANCEL_CHECK", seatId: item.id)
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    playHaptic(.click)
                }
            }
        )
    }
    
    // ★ チェック担当スタッフ指定・募集シートビュー
    @ViewBuilder
    private func selectCheckStaffSheetView(item: SeatTimerItem) -> some View {
        SelectCheckStaffSheet(
            item: item,
            currentUserName: currentUserName,
            staffCandidates: sessionManager.members,
            onAssignStaff: { staff in
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                        timers[idx].checkStaff = staff
                        timers[idx].helpProcess = "チェック"
                        timers[idx].isRecruiting = false
                    }
                    sessionManager.sendActionToPhone(action: "ASSIGN_HELP", seatId: item.id, extra: ["helpProcess": "チェック", "assistantStaffName": staff, "checkStaffName": staff])
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    showNotification(
                        text: "📤 \(staff)さんをチェック担当に指定しました",
                        color: Color(hex: "#30D158")
                    )
                }
            },
            onRecruitAll: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                        timers[idx].checkStaff = nil
                        timers[idx].helpProcess = "チェック"
                        timers[idx].isRecruiting = true
                    }
                    sessionManager.sendActionToPhone(action: "RECRUIT_HELP", seatId: item.id, extra: ["helpProcess": "チェック"])
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    showNotification(
                        text: "📢 【\(item.displaySeatName)】チェック担当を全員に募集通知しました！",
                        color: Color(hex: "#FF9F0A")
                    )
                }
            },
            onClearStaff: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                        timers[idx].checkStaff = nil
                        timers[idx].isRecruiting = false
                    }
                    sessionManager.sendActionToPhone(action: "ASSIGN_HELP", seatId: item.id, extra: ["helpProcess": "チェック", "assistantStaffName": "", "checkStaffName": ""])
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    showNotification(
                        text: "👤 チェック担当を未定に戻しました",
                        color: Color(hex: "#8E8E93")
                    )
                }
            }
        )
    }
    
    @ViewBuilder
    private func shampooActionSheetView(item: SeatTimerItem) -> some View {
        ShampooActionSheet(
            item: item,
            onStartShampoo: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    timers[idx].status = .normal
                    timers[idx].shampooStaff = nil
                    timers[idx].helpProcess = ""
                    timers[idx].isRecruiting = false
                    sessionManager.sendActionToPhone(action: "UPDATE_STATUS", seatId: item.id, extra: ["actionStatus": "normal", "isShampooing": false])
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    showNotification(
                        text: "✅ 【\(item.displaySeatName)】シャンプー完了を全員へ通知しました",
                        color: Color(hex: "#30D158")
                    )
                }
            },
            onFinishShampoo: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    timers[idx].status = .normal
                    timers[idx].shampooStaff = nil
                    timers[idx].helpProcess = ""
                    timers[idx].isRecruiting = false
                    sessionManager.sendActionToPhone(action: "UPDATE_STATUS", seatId: item.id, extra: ["actionStatus": "normal", "isShampooing": false])
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    showNotification(
                        text: "✅ 【\(item.displaySeatName)】シャンプー完了を全員へ通知しました",
                        color: Color(hex: "#30D158")
                    )
                }
            },
            onStartCombing: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    timers[idx].status = .normal
                    timers[idx].shampooStaff = nil
                    timers[idx].helpProcess = ""
                    timers[idx].isRecruiting = false
                    sessionManager.sendActionToPhone(action: "UPDATE_STATUS", seatId: item.id, extra: ["actionStatus": "normal", "isShampooing": false])
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    showNotification(
                        text: "✅ 【\(item.displaySeatName)】コーミング完了を全員へ通知しました",
                        color: Color(hex: "#30D158")
                    )
                }
            },
            onFinishCombing: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    timers[idx].status = .normal
                    timers[idx].shampooStaff = nil
                    timers[idx].helpProcess = ""
                    timers[idx].isRecruiting = false
                    sessionManager.sendActionToPhone(action: "UPDATE_STATUS", seatId: item.id, extra: ["actionStatus": "normal", "isShampooing": false])
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    showNotification(
                        text: "✅ 【\(item.displaySeatName)】コーミング完了を全員へ通知しました",
                        color: Color(hex: "#30D158")
                    )
                }
            },
            onStartCheck: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: timers[idx].checkTargetEndTime)
                    timers[idx].status = .normal
                    timers[idx].isCheckCompleted = true
                    timers[idx].checkStaff = currentUserName
                    timers[idx].checkTargetEndTime = nil
                    timers[idx].checkTotalSeconds = nil
                    timers[idx].helpProcess = ""
                    timers[idx].isRecruiting = false
                    sessionManager.timers = timers
                    WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                        seatId: item.id,
                        timers: timers,
                        mainTimer: self.mainTimer ?? sessionManager.mainTimer,
                        soundOn: sessionManager.alarmSoundEnabled,
                        currentUserName: currentUserName
                    )
                    sessionManager.sendActionToPhone(action: "COMPLETE_CHECK", seatId: item.id)
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    showNotification(
                        text: "✅ 【\(item.displaySeatName)】チェック完了を全員へ通知しました",
                        color: Color(hex: "#30D158")
                    )
                }
            },
            onFinishCheck: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: timers[idx].checkTargetEndTime)
                    timers[idx].status = .normal
                    timers[idx].isCheckCompleted = true
                    timers[idx].checkStaff = currentUserName
                    timers[idx].checkTargetEndTime = nil
                    timers[idx].checkTotalSeconds = nil
                    timers[idx].helpProcess = ""
                    timers[idx].isRecruiting = false
                    sessionManager.timers = timers
                    WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                        seatId: item.id,
                        timers: timers,
                        mainTimer: self.mainTimer ?? sessionManager.mainTimer,
                        soundOn: sessionManager.alarmSoundEnabled,
                        currentUserName: currentUserName
                    )
                    sessionManager.sendActionToPhone(action: "COMPLETE_CHECK", seatId: item.id)
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    showNotification(
                        text: "✅ 【\(item.displaySeatName)】チェック完了を全員へ通知しました",
                        color: Color(hex: "#30D158")
                    )
                }
            },
            onChangeStaff: {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    selectHelpStaffTargetId = item.id
                }
            },
            onClearStaff: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    let oldStaff = timers[idx].shampooStaff ?? timers[idx].checkStaff ?? "担当者"
                    timers[idx].shampooStaff = nil
                    timers[idx].checkStaff = nil
                    timers[idx].status = .normal
                    timers[idx].isRecruiting = false
                    sessionManager.sendActionToPhone(action: "CLEAR_STAFF", seatId: item.id)
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    showNotification(
                        text: "📤 \(oldStaff)さんに担当解除を通知しました",
                        color: Color(hex: "#8E8E93")
                    )
                }
            }
        )
    }
    
    @ViewBuilder
    private func selectHelpWorkflowSheetView(item: SeatTimerItem) -> some View {
        SelectHelpWorkflowSheet(
            item: item,
            currentUserName: currentUserName,
            staffCandidates: sessionManager.members,
            onAssignStaff: { process, staff in
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                        timers[idx].helpProcess = process
                        timers[idx].shampooStaff = staff
                        if process == "チェック" {
                            timers[idx].checkStaff = staff
                        }
                        timers[idx].isRecruiting = false
                    }
                    sessionManager.sendActionToPhone(action: "ASSIGN_HELP", seatId: item.id, extra: ["helpProcess": process, "assistantStaffName": staff])
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    showNotification(
                        text: "📤 \(staff)さんに【\(process)】を通知しました",
                        color: Color(hex: "#0A84FF")
                    )
                }
            },
            onRecruitAll: { process in
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                        timers[idx].helpProcess = process
                        timers[idx].shampooStaff = nil
                        if process == "チェック" {
                            timers[idx].checkStaff = nil
                        }
                        timers[idx].isRecruiting = true
                    }
                    sessionManager.sendActionToPhone(action: "RECRUIT_HELP", seatId: item.id, extra: ["helpProcess": process])
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer, userName: currentUserName)
                    // 募集するの場合は全員に通知する！
                    showNotification(
                        text: "📢 【\(item.displaySeatName)】\(process)担当を全員に募集通知しました！",
                        color: Color(hex: "#FF9F0A")
                    )
                }
            }
        )
    }
    
    private func checkUnassignedHelpAlerts() {
        for idx in timers.indices {
            let rem = timers[idx].remainingSeconds
            if timers[idx].isRunning && timers[idx].totalSeconds > 180 && rem <= 180 && rem > 0 && timers[idx].shampooStaff == nil && !timers[idx].isNoHelpNeeded && !timers[idx].hasAlertedHelpUnassigned {
                timers[idx].hasAlertedHelpUnassigned = true
                showNotification(
                    text: "🚨 【\(timers[idx].displaySeatName)】ヘルプ未定！全員へ通知しました",
                    color: Color(hex: "#FF453A")
                )
            }
        }
    }
    
    private func binding(for id: String) -> Binding<SeatTimerItem> {
        if let index = timers.firstIndex(where: { $0.id == id }) {
            return $timers[index]
        }
        // 万が一アニメーション中や配列更新の合間に見つからない場合でも、fatalErrorでクラッシュさせずに安全にフォールバック
        return Binding(
            get: {
                self.timers.first(where: { $0.id == id }) ?? SeatTimerItem(
                    id: id,
                    seatNumber: 1,
                    creatorName: "",
                    totalSeconds: 0,
                    targetEndTime: Date(),
                    isRunning: false,
                    pausedRemainingSeconds: 0,
                    shampooStaff: nil,
                    status: .normal
                )
            },
            set: { newValue in
                if let idx = self.timers.firstIndex(where: { $0.id == id }) {
                    self.timers[idx] = newValue
                }
            }
        )
    }
    
    private func playHaptic(_ type: WKHapticType) {
        WKInterfaceDevice.current().play(type)
    }
}

// MARK: - メインタイマー専用カードコンポーネント (エメラルドグリーン基調)
struct MainTimerCard: View {
    let item: SeatTimerItem
    let now: Date
    let onToggle: () -> Void
    let onReset: () -> Void
    var onOpenAction: (() -> Void)? = nil
    
    private var progressRatio: Double {
        if item.isPreCountingDown {
            let total = max(1, item.countdownConfigSeconds)
            let rem = max(0, item.prepRemainingSeconds)
            return min(1.0, Double(rem) / Double(total))
        }
        let total = max(1, item.totalSeconds)
        let rem = max(0, item.remainingSeconds)
        return min(1.0, Double(rem) / Double(total))
    }
    
    private var cardBorderColor: Color {
        if item.isOvertime {
            return Color(hex: "#FF453A").opacity(0.6)
        } else if item.isPreCountingDown {
            return Color(hex: "#FFD60A").opacity(0.6)
        } else if item.isRunning {
            return Color(hex: "#30D158").opacity(0.55)
        } else {
            return Color(hex: "#30D158").opacity(0.28)
        }
    }
    
    private var cardBackgroundColor: Color {
        if item.isOvertime {
            return Color(hex: "#FF453A").opacity(0.18)
        } else if item.isPreCountingDown {
            return Color(hex: "#FFD60A").opacity(0.16)
        } else if item.isRunning {
            return Color(hex: "#30D158").opacity(0.14)
        } else {
            return Color(hex: "#1C1C1E")
        }
    }
    
    private var progressGradient: LinearGradient {
        if item.isOvertime {
            return LinearGradient(colors: [Color(hex: "#FF453A"), Color(hex: "#FF6961")], startPoint: .leading, endPoint: .trailing)
        } else if item.isPreCountingDown {
            return LinearGradient(colors: [Color(hex: "#FFD60A"), Color(hex: "#FF9F0A")], startPoint: .leading, endPoint: .trailing)
        } else {
            return LinearGradient(colors: [Color(hex: "#30D158"), Color(hex: "#63E6E2")], startPoint: .leading, endPoint: .trailing)
        }
    }

    // ★ 手動展開ステート
    @State private var isManuallyExpanded: Bool = false
    
    // 折りたたみ判定: 稼働中なら常に開く。00:00（停止中かつ残り<=0）で手動展開されていない場合は閉じる
    private var isCollapsed: Bool {
        if item.isRunning || item.isPreCountingDown { return false }
        if item.isZero { return !isManuallyExpanded }
        return false
    }

    var body: some View {
        if isCollapsed {
            collapsedMainCardView
        } else {
            expandedMainCardView
        }
    }
    
    // ★ アコーディオン折りたたみ時（コンパクトなスリムバー表示）
    @ViewBuilder
    private var collapsedMainCardView: some View {
        Button(action: {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                isManuallyExpanded = true
            }
            WKInterfaceDevice.current().play(.click)
        }) {
            HStack(spacing: 6) {
                // 左側: タイトル
                HStack(spacing: 3) {
                    Image(systemName: "stopwatch.fill")
                        .font(.system(size: 11, weight: .bold))
                    Text("メインタイマー")
                        .font(.system(size: 13, weight: .bold))
                }
                .foregroundColor(Color(hex: "#30D158"))
                
                // 待機中バッジ
                HStack(spacing: 3) {
                    Image(systemName: "clock")
                        .font(.system(size: 8))
                    Text("待機中 (00:00)")
                        .font(.system(size: 9.5, weight: .bold))
                }
                .foregroundColor(Color(hex: "#8E8E93"))
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Color.white.opacity(0.1))
                .cornerRadius(4)
                
                Spacer()
                
                // 右側: 開く
                HStack(spacing: 3) {
                    Text("開く")
                        .font(.system(size: 10, weight: .bold))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                }
                .foregroundColor(Color(hex: "#30D158"))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(Color(hex: "#1C1C1E"))
            .cornerRadius(10)
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(Color(hex: "#30D158").opacity(0.35), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // ★ フル展開カード
    @ViewBuilder
    private var expandedMainCardView: some View {
        VStack(spacing: 6) {
            // ① ヘッダー
            HStack(spacing: 4) {
                Image(systemName: "stopwatch.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(Color(hex: "#30D158"))
                Text("メインタイマー")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(Color(hex: "#30D158"))
                    .lineLimit(1)
                
                if let genre = item.genre, !genre.isEmpty {
                    Text(genre)
                        .font(.system(size: 9.5, weight: .bold))
                        .foregroundColor(Color(hex: "#A0E0B0"))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1.5)
                        .background(Color(hex: "#30D158").opacity(0.2))
                        .cornerRadius(4)
                        .lineLimit(1)
                }
                
                Spacer()
                
                // あなたバッジ
                HStack(spacing: 2) {
                    Image(systemName: "star.fill")
                        .font(.system(size: 7))
                    Text("あなた")
                        .font(.system(size: 9.5, weight: .heavy))
                }
                .foregroundColor(Color(hex: "#FFD60A"))
                .padding(.horizontal, 4)
                .padding(.vertical, 1.5)
                .background(Color(hex: "#FFD60A").opacity(0.18))
                .cornerRadius(4)
            }
            
            // ② タイム数字 ＆ プログレスバー（タップで時間設定・操作シート表示）
            Button(action: {
                if let open = onOpenAction {
                    WKInterfaceDevice.current().play(.click)
                    open()
                }
            }) {
                VStack(alignment: .center, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        if item.isOvertime {
                            Text("超過")
                                .font(.system(size: 12, weight: .heavy))
                                .foregroundColor(Color(hex: "#FF453A"))
                        } else if item.isPreCountingDown {
                            Text("準備中")
                                .font(.system(size: 12, weight: .heavy))
                                .foregroundColor(Color(hex: "#FFD60A"))
                        }
                        Text(formatSeconds(item.isPreCountingDown ? item.prepRemainingSeconds : abs(item.remainingSeconds)))
                            .font(.system(size: 32, weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(
                                item.isOvertime ? Color(hex: "#FF453A") :
                                (item.isPreCountingDown ? Color(hex: "#FFD60A") : Color(hex: "#30D158"))
                            )
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    
                    HStack(spacing: 4) {
                        Image(systemName: "timer")
                            .font(.system(size: 9))
                        Text("\(item.totalSeconds / 60)分設定")
                            .font(.system(size: 10, weight: .semibold))
                        if item.isPreCountingDown {
                            Text("• ⏳ カウントダウン中")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(Color(hex: "#FFD60A"))
                        } else if !item.isRunning {
                            Text("• ⏸️ 停止中")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(Color(hex: "#FF9F0A"))
                        }
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8))
                            .foregroundColor(Color(hex: "#8E8E93"))
                    }
                    .foregroundColor(item.isOvertime ? Color(hex: "#FF857D") : Color(hex: "#A0E0B0"))
                    .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            .buttonStyle(.plain)    
                // 棒状インジケーター
                GeometryReader { geo in
                    let totalW = geo.size.width
                    let barW = totalW * CGFloat(progressRatio)
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(Color.white.opacity(0.12))
                            .frame(height: 4)
                        Capsule()
                            .fill(progressGradient)
                            .frame(width: max(4, barW), height: 4)
                    }
                }
                .frame(height: 4)
                .padding(.horizontal, 4)
                .padding(.top, 4)
                .padding(.bottom, 2)
            
            // ③ 下部ボタン群（スタート/一時停止 ＆ リセット）
            HStack(spacing: 8) {
                Button(action: onToggle) {
                    let isActive = item.isRunning || item.isPreCountingDown
                    HStack(spacing: 4) {
                        Image(systemName: item.isOvertime ? "stop.fill" : (isActive ? "pause.fill" : "play.fill"))
                            .font(.system(size: 11, weight: .bold))
                        Text(item.isPreCountingDown ? "中止" : (item.isOvertime ? "終了" : (item.isRunning ? "一時停止" : "スタート")))
                            .font(.system(size: 12, weight: .bold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(isActive ? Color(hex: "#FF9F0A").opacity(0.25) : Color(hex: "#30D158").opacity(0.25))
                    .foregroundColor(isActive ? Color(hex: "#FF9F0A") : Color(hex: "#30D158"))
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                
                Button(action: {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                        isManuallyExpanded = false
                    }
                    onReset()
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 11, weight: .bold))
                        Text("リセット")
                            .font(.system(size: 12, weight: .bold))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(Color.white.opacity(0.1))
                    .foregroundColor(Color(hex: "#8E8E93"))
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 2)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(cardBackgroundColor)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(cardBorderColor, lineWidth: 1.5)
        )
        .padding(.horizontal, 4)
    }

    private func formatSeconds(_ seconds: Int) -> String {
        let m = seconds / 60
        let s = seconds % 60
        return String(format: "%02d:%02d", m, s)
    }
}

// MARK: - 客席タイマーカードコンポーネント
struct SeatTimerCard: View {
    @Binding var item: SeatTimerItem
    let currentUserName: String
    let now: Date
    let onOpenTimeAction: () -> Void
    let onOpenSelectHelpStaff: () -> Void
    let onOpenShampooAction: () -> Void
    let onOpenCheckAction: () -> Void
    let onOpenSelectCheckStaff: () -> Void
    let onClaimCheck: () -> Void
    
    // 自分に関係している席か判定
    var isRelatedToMe: Bool {
        return item.isRelated(to: currentUserName)
    }
    
    // 自分の関与タイプ
    var myRoleText: String? {
        if item.shampooStaff == currentUserName {
            return "⭐️ あなたシャンプー"
        } else if item.checkStaff == currentUserName {
            return "⭐️ あなたチェック"
        } else if item.creatorName == currentUserName {
            return "⭐️ あなた作成"
        }
        return nil
    }
    
    // プログレスバーの進捗割合 (残り時間 / 全体時間: 1.0 -> 0.0)
    var progressRatio: Double {
        if item.isOvertime {
            return 1.0 // 超過時はフル幅表示
        }
        let total = Double(max(1, item.totalSeconds))
        let rem = Double(max(0, item.remainingSeconds))
        return min(1.0, rem / total)
    }
    
    var body: some View {
        if item.isCollapsed {
            collapsedCardView
        } else {
            expandedCardView
        }
    }
    
    // MARK: - ★ アコーディオン折りたたみ時（コンパクトなスリムバー表示）
    @ViewBuilder
    private var collapsedCardView: some View {
        Button(action: {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                item.isCollapsed = false
            }
            // ★ 次の同期でまた収納されないように記録
            WatchSessionManager.shared.setCollapseOverride(seatId: item.id, collapsed: false)
            WKInterfaceDevice.current().play(.click)
        }) {
            HStack(spacing: 6) {
                // 左側: 席番号
                HStack(spacing: 3) {
                    Image(systemName: "applewatch")
                        .font(.system(size: 11, weight: .bold))
                    Text(item.displaySeatName)
                        .font(.system(size: 13, weight: .heavy))
                }
                .foregroundColor(.white)
                
                // 状態バッジ (00:00なら「待機中 (00:00)」、それ以外は「計測終了」)
                HStack(spacing: 3) {
                    Image(systemName: item.isZero ? "clock" : "stop.circle.fill")
                        .font(.system(size: 8))
                    Text(item.isZero ? "待機中 (00:00)" : "計測終了")
                        .font(.system(size: 9.5, weight: .bold))
                }
                .foregroundColor(Color(hex: "#8E8E93"))
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Color.white.opacity(0.1))
                .cornerRadius(4)
                
                Spacer()
                
                // 右側: 開く
                HStack(spacing: 3) {
                    Text("開く")
                        .font(.system(size: 10, weight: .bold))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                }
                .foregroundColor(Color(hex: "#64D2FF"))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(Color(hex: "#1C1C1E"))
            .cornerRadius(10)
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(Color.white.opacity(0.18), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
    
    // MARK: - フル展開カード
    @ViewBuilder
    private var expandedCardView: some View {
        VStack(alignment: .leading, spacing: 6) {
            headerSection
            mainTimerSection
            helpStaffSection
            checkTimerSection
        }
        .padding(9)
        .background(Color(hex: "#1C1C1E"))
        .cornerRadius(14)
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(item.isOvertime ? Color(hex: "#FF453A").opacity(0.6) : (isRelatedToMe ? Color(hex: "#FFD60A").opacity(0.4) : Color.white.opacity(0.12)), lineWidth: isRelatedToMe ? 1.5 : 1)
        )
    }
    
    // MARK: - ① ヘッダー部
    @ViewBuilder
    private var headerSection: some View {
        HStack(alignment: .center, spacing: 4) {
            // 席番号（左側: 見切れそうになったら「...」で省略）
            HStack(spacing: 3) {
                Image(systemName: "applewatch")
                    .font(.system(size: 11, weight: .bold))
                Text(item.displaySeatName)
                    .font(.system(size: 14, weight: .heavy))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .foregroundColor(.white)
            .layoutPriority(0)
            
            Spacer(minLength: 6)
            
            // 担当表示（右上に寄せる: 固定サイズで文字潰れを防止）
            creatorRoleBadge
                .layoutPriority(1)
                .fixedSize(horizontal: true, vertical: false)
        }
    }
    
    @ViewBuilder
    private var creatorRoleBadge: some View {
        if item.creatorName == currentUserName {
            // 自分が作成者の場合: 「⭐️ 担当: あなた」
            HStack(spacing: 3) {
                Image(systemName: "star.fill")
                    .font(.system(size: 8))
                    .foregroundColor(Color(hex: "#FFD60A"))
                Text("担当: あなた")
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundColor(Color(hex: "#FFD60A"))
                    .lineLimit(1)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 2.5)
            .background(Color(hex: "#FFD60A").opacity(0.18))
            .cornerRadius(6)
        } else if item.shampooStaff == currentUserName || item.checkStaff == currentUserName {
            // 他人作成で自分がヘルプの場合: 「担当: 佐藤 ★あなた」
            HStack(spacing: 4) {
                Text("担当: \(item.creatorName)")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(Color(hex: "#E5E5EA"))
                    .lineLimit(1)
                
                HStack(spacing: 2) {
                    Image(systemName: "star.fill")
                        .font(.system(size: 7))
                    Text("あなた")
                        .font(.system(size: 9.5, weight: .heavy))
                        .lineLimit(1)
                }
                .foregroundColor(Color(hex: "#FFD60A"))
                .padding(.horizontal, 4)
                .padding(.vertical, 1.5)
                .background(Color(hex: "#FFD60A").opacity(0.18))
                .cornerRadius(4)
            }
        } else {
            // 他人が担当の席: 「担当: ヤマモト」
            Text("担当: \(item.creatorName)")
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(Color(hex: "#C7C7CC"))
                .lineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.white.opacity(0.1))
                .cornerRadius(5)
        }
    }
    
    // MARK: - ② メインタイマー部
    private var progressGradient: LinearGradient {
        if item.isOvertime {
            return LinearGradient(colors: [Color(hex: "#FF453A"), Color(hex: "#FF6961")], startPoint: .leading, endPoint: .trailing)
        } else if progressRatio < 0.2 {
            return LinearGradient(colors: [Color(hex: "#FF9F0A"), Color(hex: "#FFD60A")], startPoint: .leading, endPoint: .trailing)
        } else {
            return LinearGradient(colors: [Color(hex: "#0A84FF"), Color(hex: "#64D2FF")], startPoint: .leading, endPoint: .trailing)
        }
    }
    
    private var timerCardBackground: Color {
        if item.isOvertime {
            return Color(hex: "#FF453A").opacity(0.18)
        } else if isRelatedToMe {
            return Color(hex: "#0A84FF").opacity(0.22)
        } else {
            return Color(hex: "#0A84FF").opacity(0.12)
        }
    }
    
    private var timerCardStroke: Color {
        if item.isOvertime {
            return Color(hex: "#FF453A").opacity(0.5)
        } else if isRelatedToMe {
            return Color(hex: "#0A84FF").opacity(0.5)
        } else {
            return Color(hex: "#0A84FF").opacity(0.25)
        }
    }
    
    @ViewBuilder
    private var mainTimerSection: some View {
        Button(action: onOpenTimeAction) {
            VStack(alignment: .center, spacing: 3) {
                // カウント時間数字（中央揃え・特大）
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if item.isOvertime {
                        Text("超過")
                            .font(.system(size: 12, weight: .heavy))
                            .foregroundColor(Color(hex: "#FF453A"))
                    }
                    
                    Text(formatSeconds(abs(item.remainingSeconds)))
                        .font(.system(size: 32, weight: .black, design: .rounded))
                        .monospacedDigit()
                        .foregroundColor(item.isOvertime ? Color(hex: "#FF453A") : Color(hex: "#64D2FF"))
                }
                .frame(maxWidth: .infinity, alignment: .center)
                
                // カウント時間の下に全体タイムを小さく中央表示
                HStack(spacing: 4) {
                    Image(systemName: "timer")
                        .font(.system(size: 9))
                    Text("\(item.totalSeconds / 60)分設定")
                        .font(.system(size: 10, weight: .semibold))
                    
                    if item.isOvertime {
                        Text("• タップで止める・タイム終了 >")
                            .font(.system(size: 9.5, weight: .heavy))
                            .foregroundColor(Color(hex: "#FFD60A"))
                    } else if !item.isRunning {
                        Text("• ⏸️ 停止中")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(Color(hex: "#FF9F0A"))
                    }
                }
                .foregroundColor(item.isOvertime ? Color(hex: "#FF857D") : Color(hex: "#90C0E0"))
                .frame(maxWidth: .infinity, alignment: .center)
                
                // ★ 棒状インジケーター（プログレスバー）
                GeometryReader { geo in
                    let totalW = geo.size.width
                    let barW = totalW * CGFloat(progressRatio)
                    
                    ZStack(alignment: .leading) {
                        // 背景トラック
                        Capsule()
                            .fill(Color.white.opacity(0.12))
                            .frame(height: 4)
                        
                        // 進行バー
                        Capsule()
                            .fill(progressGradient)
                            .frame(width: max(4, barW), height: 4)
                    }
                }
                .frame(height: 4)
                .padding(.horizontal, 4)
                .padding(.top, 4)
                .padding(.bottom, 2)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(timerCardBackground)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(timerCardStroke, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
    
    // MARK: - ③ シャンプー・ヘルプ担当部
    private var isShampooOrCombing: Bool {
        item.status == .shampoo || item.status == .combing
    }

    private var shampooStatusIcon: String {
        if item.status == .shampoo {
            return "drop.fill"
        } else if item.status == .combing || item.helpProcess == "コーミング" {
            return "comb.fill"
        } else {
            return "drop.fill"
        }
    }
    
    private var shampooStatusTitle: String {
        if item.status == .shampoo {
            return "流し中:"
        } else if item.status == .combing {
            return "コーミング中:"
        } else {
            return "\(item.helpProcess):"
        }
    }

    private func staffButtonBackground(staff: String) -> Color {
        if isShampooOrCombing {
            return Color(hex: "#0A84FF").opacity(0.3)
        } else if staff == currentUserName {
            return Color(hex: "#FFD60A").opacity(0.14)
        } else {
            return Color.white.opacity(0.08)
        }
    }

    private func staffButtonStroke(staff: String) -> Color {
        if isShampooOrCombing {
            return Color(hex: "#0A84FF").opacity(0.7)
        } else if staff == currentUserName {
            return Color(hex: "#FFD60A").opacity(0.4)
        } else {
            return Color.white.opacity(0.12)
        }
    }

    @ViewBuilder
    private func staffAssignedButton(staff: String) -> some View {
        Button(action: onOpenShampooAction) {
            HStack(spacing: 5) {
                Image(systemName: shampooStatusIcon)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(isShampooOrCombing ? .white : Color(hex: "#0A84FF"))
                
                Text(shampooStatusTitle)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(Color(hex: "#C0C0C8"))
                
                Text(staff)
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundColor(staff == currentUserName ? Color(hex: "#FFD60A") : .white)
                
                Spacer()
                
                HStack(spacing: 2) {
                    Text(isShampooOrCombing ? "施術中" : "操作")
                        .font(.system(size: 9, weight: .semibold))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                }
                .foregroundColor(isShampooOrCombing ? Color.white.opacity(0.8) : Color(hex: "#8E8E93"))
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(staffButtonBackground(staff: staff))
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(staffButtonStroke(staff: staff), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
    
    @ViewBuilder
    private var helpStaffSection: some View {
        // ★ 00:00席およびアコーディオン収納席はヘルプを完全解除・非表示
        if item.isZero || item.isCollapsed {
            EmptyView()
        } else if let staff = item.shampooStaff {
            staffAssignedButton(staff: staff)
        } else if item.isRecruiting {
            // ★ 全員に募集中！
            Button(action: onOpenSelectHelpStaff) {
                HStack(spacing: 5) {
                    Image(systemName: "megaphone.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(Color(hex: "#FF9F0A"))
                    
                    Text("\(item.helpProcess): 募集中")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundColor(Color(hex: "#FFD60A"))
                    
                    Spacer()
                    
                    Text("私が入る >")
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundColor(Color(hex: "#FF9F0A"))
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 9)
                .padding(.vertical, 7)
                .background(Color(hex: "#FF9F0A").opacity(0.2))
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color(hex: "#FF9F0A").opacity(0.7), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            
        } else if item.isNoHelpNeeded {
            Button(action: onOpenSelectHelpStaff) {
                HStack(spacing: 4) {
                    Image(systemName: "person.fill")
                        .font(.system(size: 10))
                    Text("👤 ヘルプなし (ワンマン)")
                        .font(.system(size: 10, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(Color.white.opacity(0.06))
                .foregroundColor(Color(hex: "#8E8E93"))
                .cornerRadius(8)
            }
            .buttonStyle(.plain)
            
        } else if !item.isZero {
            // 指定なし ➔ タイマー稼働中・設定時のみ「ヘルプを指定してください」を表示
            Button(action: onOpenSelectHelpStaff) {
                HStack(spacing: 5) {
                    Image(systemName: "person.crop.circle.badge.plus")
                        .font(.system(size: 11, weight: .bold))
                    Text("ヘルプを指定してください")
                        .font(.system(size: 11, weight: .heavy))
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 9)
                .padding(.vertical, 7)
                .background(Color(hex: "#FF9F0A").opacity(0.18))
                .foregroundColor(Color(hex: "#FFD60A"))
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color(hex: "#FF9F0A").opacity(0.55), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
        }
    }
    
    // MARK: - ④ チェックタイマー部
    @ViewBuilder
    private var checkTimerSection: some View {
        if let checkSec = item.checkRemainingSeconds {
            HStack(alignment: .center) {
                // 左側: タイマー詳細操作（タップで完了・解除などのシート）
                Button(action: onOpenCheckAction) {
                    HStack(spacing: 4) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 11, weight: .bold))
                        VStack(alignment: .leading, spacing: 0) {
                            Text("チェックまで")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(Color(hex: "#A0E0B0"))
                            Text(formatSeconds(checkSec))
                                .font(.system(size: 16, weight: .black, design: .rounded))
                                .monospacedDigit()
                                .foregroundColor(Color(hex: "#30D158"))
                        }
                    }
                }
                .buttonStyle(.plain)
                
                Spacer()
                
                // 右側: 担当スタッフ指定・変更（最初は未定で、タップで担当者を指定可能）
                if let cStaff = item.checkStaff {
                    Button(action: onOpenSelectCheckStaff) {
                        HStack(spacing: 3) {
                            Image(systemName: "person.fill.checkmark")
                                .font(.system(size: 9))
                            Text(cStaff)
                                .font(.system(size: 11, weight: .heavy))
                        }
                        .foregroundColor(Color(hex: "#30D158"))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 5)
                        .background(Color(hex: "#30D158").opacity(0.2))
                        .cornerRadius(6)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(Color(hex: "#30D158").opacity(0.4), lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                } else if item.isRecruiting {
                    Button(action: onOpenSelectCheckStaff) {
                        HStack(spacing: 3) {
                            Image(systemName: "megaphone.fill")
                                .font(.system(size: 9))
                            Text("募集中 >")
                                .font(.system(size: 10, weight: .heavy))
                        }
                        .foregroundColor(.black)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 5)
                        .background(Color(hex: "#FF9F0A"))
                        .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                } else {
                    Button(action: onOpenSelectCheckStaff) {
                        HStack(spacing: 3) {
                            Image(systemName: "person.badge.plus")
                                .font(.system(size: 9))
                            Text("未定 >")
                                .font(.system(size: 10, weight: .heavy))
                        }
                        .foregroundColor(Color(hex: "#FFD60A"))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 5)
                        .background(Color(hex: "#FF9F0A").opacity(0.25))
                        .cornerRadius(6)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(Color(hex: "#FF9F0A").opacity(0.6), lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color(hex: "#30D158").opacity(0.14))
            .cornerRadius(10)
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(Color(hex: "#30D158").opacity(0.4), lineWidth: 1)
            )
        } else if item.isCheckCompleted {
            HStack(spacing: 4) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 10))
                Text("チェック完了")
                    .font(.system(size: 10, weight: .bold))
                if let cStaff = item.checkStaff {
                    Text("(\(cStaff))")
                        .font(.system(size: 10))
                }
            }
            .foregroundColor(Color(hex: "#30D158").opacity(0.8))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color(hex: "#30D158").opacity(0.08))
            .cornerRadius(6)
        }
    }
    
    private func formatSeconds(_ seconds: Int) -> String {
        let m = seconds / 60
        let s = seconds % 60
        return String(format: "%02d:%02d", m, s)
    }
}

func formatDeltaString(_ sec: Int) -> String {
    let sign = sec >= 0 ? "+" : "-"
    let absSec = abs(sec)
    let m = absSec / 60
    let s = absSec % 60
    let action = sec >= 0 ? "延長" : "短縮"
    if m > 0 && s > 0 {
        return "\(sign)\(m)分\(s)秒 \(action)"
    } else if m > 0 {
        return "\(sign)\(m)分 \(action)"
    } else {
        return "\(sign)\(s)秒 \(action)"
    }
}

// MARK: - ★ カウントアップ（超過中）専用アクションシート
struct OvertimeActionSheet: View {
    @Environment(\.dismiss) var dismiss
    let item: SeatTimerItem
    let currentUserName: String
    let onEnterHelp: () -> Void
    let onResetZero: () -> Void
    let onFinishMeasure: () -> Void
    
    // 1秒周期のカウントアップ更新
    @State private var now = Date()
    let ticker = Timer.publish(every: 1.0, on: .main, in: .common).autoconnect()
    
    // 超過秒数のフォーマット（MM:SS）
    var overtimeFormatted: String {
        let sec = abs(item.remainingSeconds)
        let m = sec / 60
        let s = sec % 60
        return String(format: "%02d:%02d", m, s)
    }
    
    // ヘルプ項目名（デフォルト: シャンプー）
    var helpProcessName: String {
        let p = item.helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
        return p.isEmpty ? "シャンプー" : p
    }
    
    var helpIconName: String {
        switch helpProcessName {
        case "コーミング": return "comb.fill"
        case "チェック": return "magnifyingglass"
        default: return "drop.fill"
        }
    }
    
    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                // ① ヘッダー部（席番号 ＆ 超過タイムリアルタイム表示）
                HStack(alignment: .center, spacing: 5) {
                    HStack(spacing: 3) {
                        Image(systemName: "applewatch")
                            .font(.system(size: 11, weight: .bold))
                        Text(item.displaySeatName)
                            .font(.system(size: 13, weight: .heavy))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .truncationMode(.tail)
                    }
                    .foregroundColor(.white)
                    
                    Spacer(minLength: 4)
                    
                    // 超過バッジ ＆ タイム（幅固定・改行絶対防止）
                    HStack(spacing: 3) {
                        Text("超過")
                            .font(.system(size: 9.5, weight: .heavy))
                            .foregroundColor(Color(hex: "#FF453A"))
                            .lineLimit(1)
                            .fixedSize()
                        Text(overtimeFormatted)
                            .font(.system(size: 14.5, weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#FF453A"))
                            .lineLimit(1)
                            .fixedSize()
                    }
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2.5)
                    .background(Color(hex: "#FF453A").opacity(0.18))
                    .cornerRadius(6)
                    .fixedSize(horizontal: true, vertical: false)
                }
                .padding(.horizontal, 4)
                .padding(.top, 2)
                
                Divider()
                    .background(Color.white.opacity(0.15))
                    .padding(.vertical, 1)
                
                // ② ボタン1: ヘルプ項目連動「シャンプーに入る／チェックに入る」ボタン（未指定時は非表示）
                if !item.isNoHelpNeeded && !item.helpProcess.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button(action: {
                        playHaptic(.start)
                        onEnterHelp()
                        dismiss()
                    }) {
                        HStack(spacing: 6) {
                            Image(systemName: helpIconName)
                                .font(.system(size: 14, weight: .bold))
                            Text("\(helpProcessName)に入る")
                                .font(.system(size: 14, weight: .heavy))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(
                            LinearGradient(
                                colors: helpProcessName == "チェック"
                                    ? [Color(hex: "#30D158"), Color(hex: "#248A3D")]
                                    : [Color(hex: "#0A84FF"), Color(hex: "#0062D2")],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .foregroundColor(.white)
                        .cornerRadius(10)
                        .shadow(
                            color: (helpProcessName == "チェック" ? Color(hex: "#30D158") : Color(hex: "#0A84FF")).opacity(0.4),
                            radius: 3, x: 0, y: 1
                        )
                    }
                    .buttonStyle(.plain)
                }
                
                // ③ ボタン2: 「止める（00:00に戻す）」ボタン
                Button(action: {
                    playHaptic(.directionUp)
                    onResetZero()
                    dismiss()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 13, weight: .bold))
                        Text("止める（00:00に戻す）")
                            .font(.system(size: 13, weight: .bold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(Color(hex: "#FF9F0A").opacity(0.2))
                    .foregroundColor(Color(hex: "#FFD60A"))
                    .cornerRadius(10)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color(hex: "#FF9F0A").opacity(0.4), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                
                // ④ ボタン3: 「タイム終了（計測終了）」ボタン（アコーディオンをしまう）
                Button(action: {
                    playHaptic(.stop)
                    onFinishMeasure()
                    dismiss()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 13, weight: .bold))
                        Text("タイム終了（計測終了）")
                            .font(.system(size: 13, weight: .bold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(Color(hex: "#FF453A").opacity(0.18))
                    .foregroundColor(Color(hex: "#FF453A"))
                    .cornerRadius(10)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color(hex: "#FF453A").opacity(0.4), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                
                // 閉じるリンク
                Button(action: {
                    dismiss()
                }) {
                    Text("閉じる")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Color(hex: "#8E8E93"))
                        .padding(.top, 2)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 4)
            .padding(.bottom, 6)
        }
        .onReceive(ticker) { input in
            now = input
        }
    }
    
    private func playHaptic(_ type: WKHapticType) {
        WKInterfaceDevice.current().play(type)
    }
}

// MARK: - メインタイマー専用操作・時間選択シート（共有タイマーと同じ分・秒トグル＆タイム再入力UI・サブタイマーなし）
struct MainTimerActionSheet: View {
    @Environment(\.dismiss) var dismiss
    let item: SeatTimerItem
    let onStart: () -> Void
    let onPause: () -> Void
    let onReset: () -> Void
    let onSetTime: (Int) -> Void
    let onAdjust: (Int) -> Void
    
    // ★ シート表示中のローカル状態（WatchSessionManager の @ObservedObject を直接購読しないことで、
    //   時間入力＋dismiss() 同時実行時の watchOS SwiftUI ViewGraph / CrownSequencer クラッシュを完全防止）
    @State private var displayItem: SeatTimerItem
    
    var currentItem: SeatTimerItem {
        displayItem
    }
    
    @State private var phoneSoundEnabled: Bool = UserDefaults.standard.object(forKey: "assisttimer.mainTimerPhoneSound") as? Bool ?? true
    // ★ 共有タイマーと同じ累積追加・減少秒数（何回も連打可能）
    @State private var accumulatedDelta: Int = 0
    // ★ タイム再入力モードフラグ（共有タイマーの unifiedReinputScrollView と統一・サブタイマーなし）
    @State private var isReinputMode: Bool = false
    @State private var crownSeconds: Double = 600.0
    @State private var now = Date()
    let ticker = Timer.publish(every: 1.0, on: .main, in: .common).autoconnect()
    
    // クイック分数選択ボタン（定番タイム）
    let quickMinutes = [1, 3, 5, 10, 15, 20, 25, 30, 45]
    
    init(
        item: SeatTimerItem,
        onStart: @escaping () -> Void,
        onPause: @escaping () -> Void,
        onReset: @escaping () -> Void,
        onSetTime: @escaping (Int) -> Void,
        onAdjust: @escaping (Int) -> Void
    ) {
        self.item = item
        let initialItem = WatchSessionManager.shared.mainTimer ?? item
        self._displayItem = State(initialValue: initialItem)
        let initSec = initialItem.totalSeconds > 0 ? initialItem.totalSeconds : 600
        self._crownSeconds = State(initialValue: Double(initSec))
        self.onStart = onStart
        self.onPause = onPause
        self.onReset = onReset
        self.onSetTime = onSetTime
        self.onAdjust = onAdjust
    }
    
    var isRunning: Bool { currentItem.isRunning && currentItem.remainingSeconds > 0 }
    var isOvertime: Bool { currentItem.isOvertime }
    
    var currentSeconds: Int {
        if isRunning {
            return max(0, Int(ceil(currentItem.targetEndTime.timeIntervalSince(now))))
        } else if isOvertime {
            return abs(min(0, Int(currentItem.targetEndTime.timeIntervalSince(now))))
        } else {
            return currentItem.pausedRemainingSeconds > 0 ? currentItem.pausedRemainingSeconds : currentItem.totalSeconds
        }
    }
    
    // 現在の残り秒数 ＋ 累積追加秒数（リアルタイム反映）
    var currentDisplaySeconds: Int {
        if isOvertime {
            return max(0, accumulatedDelta)
        }
        return max(10, currentSeconds + accumulatedDelta)
    }
    
    private func formatSeconds(_ seconds: Int) -> String {
        let m = max(0, seconds) / 60
        let s = max(0, seconds) % 60
        return String(format: "%02d:%02d", m, s)
    }
    
    private func formatDelta(_ sec: Int) -> String {
        let sign = sec >= 0 ? "+" : "-"
        let absSec = abs(sec)
        let m = absSec / 60
        let s = absSec % 60
        if m > 0 && s > 0 {
            return "\(sign)\(m)分\(s)秒"
        } else if m > 0 {
            return "\(sign)\(m)分"
        } else {
            return "\(sign)\(s)秒"
        }
    }
    
    var body: some View {
        Group {
            if isReinputMode {
                unifiedMainReinputScrollView
            } else {
                standardMainActionScrollView
            }
        }
        .onReceive(ticker) { input in
            now = input
            if !isReinputMode, accumulatedDelta == 0, let latest = WatchSessionManager.shared.mainTimer, latest != displayItem {
                displayItem = latest
            }
        }
    }
    
    // MARK: - ★ 任意タイム設定 ＆ クイックパネル統合画面（共有タイマーと同じ分・秒トグル＋クラウン・サブタイマーなし）
    @ViewBuilder
    private var unifiedMainReinputScrollView: some View {
        ScrollView {
            VStack(spacing: 5) {
                // ① ナビバー（戻る ＆ 任意タイム設定）
                HStack {
                    Button(action: {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            isReinputMode = false
                        }
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        HStack(spacing: 3) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text("戻る")
                                .font(.system(size: 11, weight: .bold))
                        }
                        .foregroundColor(Color(hex: "#FFD60A"))
                    }
                    .buttonStyle(.plain)
                    
                    Spacer()
                    
                    Text("任意タイム設定")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.white)
                    
                    Spacer()
                }
                .padding(.horizontal, 4)
                
                // ② ００:００の巨大デジタル表示エリア（分・秒をそれぞれタップしてリューズで入力）
                CrownMinSecPicker(
                    totalSeconds: Binding(
                        get: { Int(crownSeconds) },
                        set: { crownSeconds = Double(min(7200, max(0, $0))) }
                    ),
                    maxMinutes: 120,
                    fontSize: 30
                )
                .padding(.horizontal, 2)
                
                // ③ 分トグルボタン（リセット / -5分 / -1分 / +1分 / +5分）
                HStack(spacing: 3) {
                    Button(action: {
                        crownSeconds = 0.0
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("00:00")
                            .font(.system(size: 9.5, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 5)
                            .background(Color.white.opacity(0.12))
                            .foregroundColor(.gray)
                            .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                    
                    ForEach([("-5分", -300.0), ("-1分", -60.0), ("+1分", 60.0), ("+5分", 300.0)], id: \.0) { label, delta in
                        Button(action: {
                            crownSeconds = min(7200, max(0, crownSeconds + delta))
                            WKInterfaceDevice.current().play(.click)
                        }) {
                            Text(label)
                                .font(.system(size: 10, weight: .bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 5)
                                .background(delta > 0 ? Color(hex: "#0A84FF").opacity(0.28) : Color.white.opacity(0.15))
                                .foregroundColor(delta > 0 ? Color(hex: "#64D2FF") : .white)
                                .cornerRadius(6)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 2)
                
                // ④ 秒トグルボタン（-30秒 / -10秒 / +10秒 / +30秒）
                HStack(spacing: 4) {
                    ForEach([("-30秒", -30.0), ("-10秒", -10.0), ("+10秒", 10.0), ("+30秒", 30.0)], id: \.0) { label, delta in
                        Button(action: {
                            crownSeconds = min(7200, max(0, crownSeconds + delta))
                            WKInterfaceDevice.current().play(.click)
                        }) {
                            Text(label)
                                .font(.system(size: 9.5, weight: .bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 4)
                                .background(Color.white.opacity(0.12))
                                .foregroundColor(delta > 0 ? Color(hex: "#30D158") : Color(hex: "#C0C0C8"))
                                .cornerRadius(6)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 2)
                
                // ⑤ 決定ボタン（★時間が1秒以上設定された時だけ出現・サブタイマーなし）
                if Int(crownSeconds) > 0 {
                    Button(action: {
                        let sec = max(10, Int(crownSeconds))
                        WKInterfaceDevice.current().play(.click)
                        onSetTime(sec)
                        dismiss()
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 12, weight: .heavy))
                            Text("決定 (\(formatSeconds(Int(crownSeconds))))")
                                .font(.system(size: 12, weight: .black))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(
                            LinearGradient(colors: [Color(hex: "#FFD60A"), Color(hex: "#FF9F0A")], startPoint: .leading, endPoint: .trailing)
                        )
                        .foregroundColor(.black)
                        .cornerRadius(8)
                        .shadow(color: Color(hex: "#FFD60A").opacity(0.35), radius: 2, x: 0, y: 1)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 2)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
                
                // ⑥ クイックパネル（定番タイム 3列グリッド）
                Divider()
                    .padding(.vertical, 1)
                
                HStack(spacing: 4) {
                    Image(systemName: "square.grid.3x3.fill")
                        .font(.system(size: 9))
                        .foregroundColor(Color(hex: "#FFD60A"))
                    Text("クイックパネル (定番タイム)")
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundColor(Color(hex: "#E0E0E5"))
                    Spacer()
                }
                .padding(.horizontal, 4)
                
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 5) {
                    ForEach(quickMinutes, id: \.self) { min in
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            onSetTime(min * 60)
                            dismiss()
                        }) {
                            Text("\(min)分")
                                .font(.system(size: 13, weight: .heavy))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 7)
                                .background(Color(hex: "#FFD60A").opacity(0.22))
                                .foregroundColor(Color(hex: "#FFD60A"))
                                .cornerRadius(7)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 7)
                                        .stroke(Color(hex: "#FFD60A").opacity(0.6), lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 2)
                
                Divider()
                    .padding(.vertical, 2)
                
                phoneSoundToggleButton
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 4)
        }
    }
    
    // MARK: - ★ 標準操作画面（共有タイマーと同じ分・秒トグル微調整 ＆ 確定 ＆ タイム再入力）
    @ViewBuilder
    private var standardMainActionScrollView: some View {
        ScrollView {
            VStack(spacing: 7) {
                // ① ナビゲーションバー
                HStack {
                    HStack(spacing: 4) {
                        Image(systemName: "stopwatch.fill")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(Color(hex: "#30D158"))
                        Text("メインタイマー")
                            .font(.system(size: 13, weight: .heavy))
                            .foregroundColor(.white)
                    }
                    Spacer()
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        dismiss()
                    }) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 16))
                            .foregroundColor(Color(hex: "#8E8E93"))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 4)
                
                // ② 共有タイマーではない旨の注意書き
                Text("※こちらは共有タイマーではありません")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(Color(hex: "#FFD60A").opacity(0.85))
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 3)
                    .padding(.horizontal, 6)
                    .background(Color.white.opacity(0.06))
                    .cornerRadius(4)
                
                // ③ 巨大タイマー表示 ＆ 状態（トグル調整時はリアルタイム反映）
                VStack(spacing: 2) {
                    if isOvertime && accumulatedDelta <= 0 {
                        Text("超過")
                            .font(.system(size: 11, weight: .heavy))
                            .foregroundColor(Color(hex: "#FF453A"))
                        Text("+\(formatSeconds(currentSeconds))")
                            .font(.system(size: 30, weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#FF453A"))
                    } else if currentItem.isPreCountingDown {
                        Text("準備中")
                            .font(.system(size: 11, weight: .heavy))
                            .foregroundColor(Color(hex: "#FFD60A"))
                        Text(formatSeconds(currentItem.prepRemainingSeconds))
                            .font(.system(size: 30, weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#FFD60A"))
                        Text("カウントダウン中...")
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundColor(Color(hex: "#FFD60A").opacity(0.85))
                    } else if isRunning || (isOvertime && accumulatedDelta > 0) {
                        Text(formatSeconds(currentDisplaySeconds))
                            .font(.system(size: 30, weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(accumulatedDelta != 0 ? Color(hex: "#FFD60A") : Color(hex: "#30D158"))
                        if accumulatedDelta != 0 {
                            Text("調整中: \(formatDelta(accumulatedDelta))")
                                .font(.system(size: 9.5, weight: .bold))
                                .foregroundColor(Color(hex: "#FFD60A"))
                        }
                    } else {
                        Text(formatSeconds(currentDisplaySeconds))
                            .font(.system(size: 30, weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(accumulatedDelta != 0 ? Color(hex: "#FFD60A") : .white)
                        Text(accumulatedDelta != 0 ? "調整中: \(formatDelta(accumulatedDelta))" : "⏸ 停止中（\(max(1, currentItem.totalSeconds / 60))分設定）")
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundColor(accumulatedDelta != 0 ? Color(hex: "#FFD60A") : Color(hex: "#8E8E93"))
                    }
                }
                .padding(.vertical, 1)
                
                // ④ メイン操作ボタン（スタート / 一時停止 / リセット / 準備中中止）
                if isOvertime {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        onReset()
                        dismiss()
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "stop.circle.fill")
                                .font(.system(size: 14, weight: .bold))
                            Text("計測終了 / リセット")
                                .font(.system(size: 13, weight: .bold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color(hex: "#FF453A"))
                        .foregroundColor(.white)
                        .cornerRadius(8)
                    }
                    .buttonStyle(.plain)
                } else if currentItem.isPreCountingDown {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        onPause()
                        if let updated = WatchSessionManager.shared.mainTimer {
                            displayItem = updated
                        }
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 13, weight: .bold))
                            Text("カウントダウン中止")
                                .font(.system(size: 13, weight: .bold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color(hex: "#FF453A"))
                        .foregroundColor(.white)
                        .cornerRadius(8)
                    }
                    .buttonStyle(.plain)
                } else if isRunning {
                    HStack(spacing: 6) {
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            onPause()
                            if let updated = WatchSessionManager.shared.mainTimer {
                                displayItem = updated
                            }
                        }) {
                            HStack(spacing: 4) {
                                Image(systemName: "pause.fill")
                                    .font(.system(size: 12, weight: .bold))
                                Text("一時停止")
                                    .font(.system(size: 12, weight: .bold))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color(hex: "#FF9F0A"))
                            .foregroundColor(.black)
                            .cornerRadius(8)
                        }
                        .buttonStyle(.plain)
                        
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            accumulatedDelta = 0
                            onReset()
                            if let updated = WatchSessionManager.shared.mainTimer {
                                displayItem = updated
                            }
                        }) {
                            HStack(spacing: 4) {
                                Image(systemName: "arrow.counterclockwise")
                                    .font(.system(size: 12, weight: .bold))
                                Text("リセット")
                                    .font(.system(size: 12, weight: .bold))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color.white.opacity(0.15))
                            .foregroundColor(.white)
                            .cornerRadius(8)
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        if accumulatedDelta != 0 {
                            let targetSec = max(10, currentSeconds + accumulatedDelta)
                            accumulatedDelta = 0
                            onSetTime(targetSec)
                        } else {
                            onStart()
                        }
                        dismiss()
                    }) {
                        HStack(spacing: 6) {
                            Image(systemName: "play.fill")
                                .font(.system(size: 14, weight: .bold))
                            Text(accumulatedDelta != 0 ? "\(formatSeconds(currentDisplaySeconds)) でスタート" : "スタート")
                                .font(.system(size: 13, weight: .heavy))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color(hex: "#30D158"))
                        .foregroundColor(.black)
                        .cornerRadius(8)
                    }
                    .buttonStyle(.plain)
                }
                
                // ⑤ 共有タイマーと同じ分・秒トグル調整ボタン（何回も押せる累積調整！）
                // 上段: +1分, +3分, +5分
                HStack(spacing: 5) {
                    Button(action: {
                        accumulatedDelta += 60
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("+1分")
                            .font(.system(size: 12, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 7)
                            .background(Color.white.opacity(0.16))
                            .foregroundColor(.white)
                            .cornerRadius(7)
                    }
                    .buttonStyle(.plain)
                    
                    Button(action: {
                        accumulatedDelta += 180
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("+3分")
                            .font(.system(size: 12, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 7)
                            .background(Color.white.opacity(0.16))
                            .foregroundColor(.white)
                            .cornerRadius(7)
                    }
                    .buttonStyle(.plain)
                    
                    Button(action: {
                        accumulatedDelta += 300
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("+5分")
                            .font(.system(size: 12, weight: .heavy))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 7)
                            .background(Color(hex: "#0A84FF").opacity(0.35))
                            .foregroundColor(Color(hex: "#64D2FF"))
                            .cornerRadius(7)
                    }
                    .buttonStyle(.plain)
                }
                
                // 下段: -5分, -1分, -30秒, +30秒
                HStack(spacing: 4) {
                    ForEach([("-5分", -300), ("-1分", -60), ("-30秒", -30), ("+30秒", 30)], id: \.0) { label, delta in
                        Button(action: {
                            if isOvertime {
                                accumulatedDelta = max(0, accumulatedDelta + delta)
                            } else {
                                let minDelta = min(0, 10 - currentSeconds)
                                accumulatedDelta = max(minDelta, accumulatedDelta + delta)
                            }
                            WKInterfaceDevice.current().play(.click)
                        }) {
                            Text(label)
                                .font(.system(size: 10, weight: .bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 6)
                                .background(Color.white.opacity(0.12))
                                .foregroundColor(delta < 0 ? Color(hex: "#FF6961") : Color(hex: "#C0C0C8"))
                                .cornerRadius(6)
                        }
                        .buttonStyle(.plain)
                    }
                }
                
                // ⑥ トグル調整時は「確定」ボタン、未調整時は「タイム再入力。」ボタン（共有タイマーと完全統一）
                if accumulatedDelta != 0 {
                    HStack(spacing: 5) {
                        Button(action: {
                            withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                                accumulatedDelta = 0
                            }
                            WKInterfaceDevice.current().play(.click)
                        }) {
                            Image(systemName: "arrow.counterclockwise")
                                .font(.system(size: 12, weight: .bold))
                                .frame(width: 34, height: 34)
                                .background(Color.white.opacity(0.15))
                                .foregroundColor(.white)
                                .cornerRadius(7)
                        }
                        .buttonStyle(.plain)
                        
                        Button(action: {
                            let delta = accumulatedDelta
                            accumulatedDelta = 0
                            WKInterfaceDevice.current().play(.click)
                            onAdjust(delta)
                            if isRunning || isOvertime {
                                dismiss()
                            } else if let updated = WatchSessionManager.shared.mainTimer {
                                displayItem = updated
                            }
                        }) {
                            HStack(spacing: 4) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 13, weight: .heavy))
                                Text("確定 (\(formatDelta(accumulatedDelta)))")
                                    .font(.system(size: 12, weight: .black))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(
                                LinearGradient(colors: [Color(hex: "#FFD60A"), Color(hex: "#FF9F0A")], startPoint: .leading, endPoint: .trailing)
                            )
                            .foregroundColor(.black)
                            .cornerRadius(8)
                            .shadow(color: Color(hex: "#FFD60A").opacity(0.4), radius: 2, x: 0, y: 1)
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        crownSeconds = Double(currentItem.totalSeconds > 0 ? currentItem.totalSeconds : 600)
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            isReinputMode = true
                        }
                    }) {
                        HStack(spacing: 6) {
                            Image(systemName: "arrow.triangle.2.circlepath")
                                .font(.system(size: 12, weight: .bold))
                            Text("タイム再入力。")
                                .font(.system(size: 12, weight: .heavy))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color(hex: "#FFD60A"))
                        .foregroundColor(.black)
                        .cornerRadius(8)
                        .shadow(color: Color(hex: "#FFD60A").opacity(0.35), radius: 2, x: 0, y: 1)
                    }
                    .buttonStyle(.plain)
                }
                
                // ⑦ クイック時間選択（定番タイム）
                VStack(alignment: .leading, spacing: 4) {
                    Text("クイックパネル (定番タイム)")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(Color(hex: "#8E8E93"))
                        .padding(.leading, 2)
                    
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 5) {
                        ForEach(quickMinutes, id: \.self) { m in
                            let isSelected = (currentItem.totalSeconds == m * 60)
                            Button(action: {
                                WKInterfaceDevice.current().play(.click)
                                onSetTime(m * 60)
                                dismiss()
                            }) {
                                Text("\(m)分")
                                    .font(.system(size: 12, weight: isSelected ? .heavy : .bold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 6)
                                    .background(isSelected ? Color(hex: "#30D158").opacity(0.3) : Color.white.opacity(0.08))
                                    .foregroundColor(isSelected ? Color(hex: "#30D158") : .white)
                                    .cornerRadius(6)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 6)
                                            .stroke(isSelected ? Color(hex: "#30D158") : Color.clear, lineWidth: 1)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                
                Divider()
                    .padding(.vertical, 2)
                
                // ⑧ 携帯の音出力トグル
                phoneSoundToggleButton
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
        }
    }
    
    @ViewBuilder
    private var phoneSoundToggleButton: some View {
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            phoneSoundEnabled.toggle()
            UserDefaults.standard.set(phoneSoundEnabled, forKey: "assisttimer.mainTimerPhoneSound")
        }) {
            HStack(spacing: 8) {
                Image(systemName: phoneSoundEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(phoneSoundEnabled ? Color(hex: "#30D158") : Color(hex: "#8E8E93"))
                
                VStack(alignment: .leading, spacing: 1) {
                    HStack {
                        Text("携帯の音")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(.white)
                        Spacer()
                        Text(phoneSoundEnabled ? "ON" : "OFF")
                            .font(.system(size: 11, weight: .heavy))
                            .foregroundColor(phoneSoundEnabled ? Color(hex: "#30D158") : Color(hex: "#8E8E93"))
                    }
                    Text(phoneSoundEnabled ? "iPhoneからも音・音声アナウンスが鳴ります" : "携帯は消音、ウォッチの振動のみでお知らせ")
                        .font(.system(size: 8))
                        .foregroundColor(Color(hex: "#8E8E93"))
                        .lineLimit(1)
                }
            }
            .padding(8)
            .background(Color.white.opacity(0.08))
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(phoneSoundEnabled ? Color(hex: "#30D158").opacity(0.5) : Color.white.opacity(0.1), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - タイム操作シート
struct TimeActionSheet: View {
    @Environment(\.dismiss) var dismiss
    let item: SeatTimerItem
    let initialReinputMode: Bool
    let onAdjust: (Int) -> Void
    let onStop: () -> Void
    let onEnterHelp: (() -> Void)?
    let onCompleteCheck: (() -> Void)?
    let onReinputTime: (Int, Int?) -> Void
    
    // 累積追加秒数（何回もタップ可能！）
    @State private var accumulatedDelta: Int = 0
    
    // タイム再入力モードフラグ
    @State private var isReinputMode: Bool
    
    // ★ 途中チェック（サブタイマー）分数 (0 = なし)
    @State private var checkMinutes: Int = 0
    
    // ★ リューズ(Crown)無段階調整用 (分・秒独立タップ切替)
    @State private var crownSeconds: Double = 0.0
    
    // 1秒周期のカウントダウン更新
    @State private var now = Date()
    let ticker = Timer.publish(every: 1.0, on: .main, in: .common).autoconnect()
    
    let reinputMinutes = [5, 10, 15, 20, 25, 30, 35, 40, 45]
    let checkPills = [0, 3, 5, 7, 10]
    
    init(
        item: SeatTimerItem,
        initialReinputMode: Bool = false,
        onAdjust: @escaping (Int) -> Void,
        onStop: @escaping () -> Void,
        onEnterHelp: (() -> Void)? = nil,
        onCompleteCheck: (() -> Void)? = nil,
        onReinputTime: @escaping (Int, Int?) -> Void
    ) {
        self.item = item
        self.initialReinputMode = initialReinputMode
        self._isReinputMode = State(initialValue: initialReinputMode)
        self.onAdjust = onAdjust
        self.onStop = onStop
        self.onEnterHelp = onEnterHelp
        self.onCompleteCheck = onCompleteCheck
        self.onReinputTime = onReinputTime
        let initialCheckMin = (item.checkTotalSeconds ?? 0) / 60
        self._checkMinutes = State(initialValue: initialCheckMin)
    }
    
    // 現在の残り秒数 ＋ 累積追加秒数（リアルタイム反映）
    var currentDisplaySeconds: Int {
        let baseRemaining = max(0, Int(item.targetEndTime.timeIntervalSince(now)))
        let adjusted = baseRemaining + accumulatedDelta
        return max(0, adjusted)
    }
    
    private func formatSeconds(_ seconds: Int) -> String {
        let m = seconds / 60
        let s = seconds % 60
        return String(format: "%02d:%02d", m, s)
    }
    
    private func formatDelta(_ sec: Int) -> String {
        let sign = sec >= 0 ? "+" : "-"
        let absSec = abs(sec)
        let m = absSec / 60
        let s = absSec % 60
        if m > 0 && s > 0 {
            return "\(sign)\(m)分\(s)秒"
        } else if m > 0 {
            return "\(sign)\(m)分"
        } else {
            return "\(sign)\(s)秒"
        }
    }
    
    var body: some View {
        Group {
            if isReinputMode {
                unifiedReinputScrollView
            } else {
                standardActionScrollView
            }
        }
        .onReceive(ticker) { input in
            now = input
        }
    }
    
    // MARK: - ★ 任意タイム設定 ＆ クイックパネル統合画面（ダイレクト表示 ＆ スクロール対応）
    @ViewBuilder
    private var unifiedReinputScrollView: some View {
        ScrollView {
            VStack(spacing: 5) {
                // ① ナビバー（戻る ＆ 任意タイム設定）
                HStack {
                    Button(action: {
                        if initialReinputMode {
                            dismiss()
                        } else {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                isReinputMode = false
                            }
                        }
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        HStack(spacing: 3) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text("戻る")
                                .font(.system(size: 11, weight: .bold))
                        }
                        .foregroundColor(Color(hex: "#FFD60A"))
                    }
                    .buttonStyle(.plain)
                    
                    Spacer()
                    
                    Text("任意タイム設定")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.white)
                    
                    Spacer()
                }
                .padding(.horizontal, 4)
                
                // ② ００:００の巨大デジタル表示エリア（分・秒をそれぞれタップしてリューズで入力）
                CrownMinSecPicker(
                    totalSeconds: Binding(
                        get: { Int(crownSeconds) },
                        set: { crownSeconds = Double(min(5400, max(0, $0))) }
                    ),
                    maxMinutes: 90,
                    fontSize: 30
                )
                .padding(.horizontal, 2)
                
                // ③ 補助ボタン（リセット / -1分 / +1分 / +30秒）
                HStack(spacing: 4) {
                    Button(action: {
                        crownSeconds = 0.0
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("リセット")
                            .font(.system(size: 10, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                            .background(Color.white.opacity(0.12))
                            .foregroundColor(.gray)
                            .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                    
                    Button(action: {
                        crownSeconds = max(0, crownSeconds - 60)
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("-1分")
                            .font(.system(size: 11, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                            .background(Color.white.opacity(0.15))
                            .foregroundColor(.white)
                            .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                    
                    Button(action: {
                        crownSeconds = min(5400, crownSeconds + 60)
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("+1分")
                            .font(.system(size: 11, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                            .background(Color.white.opacity(0.15))
                            .foregroundColor(.white)
                            .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                    
                    Button(action: {
                        crownSeconds = min(5400, crownSeconds + 30)
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("+30秒")
                            .font(.system(size: 10, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                            .background(Color.white.opacity(0.15))
                            .foregroundColor(.white)
                            .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 2)
                
                // ★ 途中チェック（サブタイマー）設定セクション
                VStack(spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        HStack(spacing: 3) {
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(Color(hex: "#30D158"))
                            Text("途中チェック:")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(.gray)
                        }
                        Spacer()
                        Text(checkMinutes == 0 ? "なし" : "\(checkMinutes)分")
                            .font(.system(size: 13, weight: .heavy, design: .rounded))
                            .foregroundColor(checkMinutes == 0 ? .gray : Color(hex: "#30D158"))
                    }
                    .padding(.horizontal, 4)
                    
                    HStack(spacing: 3) {
                        ForEach(checkPills, id: \.self) { cmin in
                            Button(action: {
                                checkMinutes = cmin
                                WKInterfaceDevice.current().play(.click)
                            }) {
                                Text(cmin == 0 ? "なし" : "\(cmin)分")
                                    .font(.system(size: 10, weight: .bold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 5)
                                    .background(checkMinutes == cmin ? Color(hex: "#30D158") : Color.white.opacity(0.12))
                                    .foregroundColor(checkMinutes == cmin ? .black : Color(hex: "#E0E0E5"))
                                    .cornerRadius(6)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 2)
                }
                .padding(.top, 2)
                
                // ④ 決定ボタン（★時間が1秒以上設定された時だけスッと出現！）
                if Int(crownSeconds) > 0 {
                    Button(action: {
                        let sec = Int(crownSeconds)
                        if sec > 0 {
                            WKInterfaceDevice.current().play(.click)
                            let chkSec = (checkMinutes > 0 && (checkMinutes * 60) < sec) ? checkMinutes * 60 : nil
                            onReinputTime(sec, chkSec)
                            dismiss()
                        }
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 12, weight: .heavy))
                            if checkMinutes > 0 && (checkMinutes * 60) < Int(crownSeconds) {
                                Text("決定 (\(formatSeconds(Int(crownSeconds)))) 【\(checkMinutes)分CHK】")
                                    .font(.system(size: 10.5, weight: .black))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                            } else {
                                Text("決定 (\(formatSeconds(Int(crownSeconds))))")
                                    .font(.system(size: 12, weight: .black))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(
                            LinearGradient(colors: [Color(hex: "#FFD60A"), Color(hex: "#FF9F0A")], startPoint: .leading, endPoint: .trailing)
                        )
                        .foregroundColor(.black)
                        .cornerRadius(8)
                        .shadow(color: Color(hex: "#FFD60A").opacity(0.35), radius: 2, x: 0, y: 1)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 2)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
                
                // ⑤ クイックパネル（ディバイダー ＆ タイル群）
                Divider()
                    .padding(.vertical, 1)
                
                HStack(spacing: 4) {
                    Image(systemName: "square.grid.3x3.fill")
                        .font(.system(size: 9))
                        .foregroundColor(Color(hex: "#FFD60A"))
                    Text("クイックパネル (定番タイム)")
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundColor(Color(hex: "#E0E0E5"))
                    Spacer()
                    HStack(spacing: 2) {
                        Text("下も選択可")
                            .font(.system(size: 8.5, weight: .semibold))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 7.5, weight: .bold))
                    }
                    .foregroundColor(Color(hex: "#8E8E93"))
                }
                .padding(.horizontal, 4)
                
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 5) {
                    ForEach(reinputMinutes, id: \.self) { min in
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            let totalSec = min * 60
                            // ★ 安全ガード: チェック時間は全体タイムより短い場合のみ有効
                            let chkSec = (checkMinutes > 0 && (checkMinutes * 60) < totalSec) ? checkMinutes * 60 : nil
                            onReinputTime(totalSec, chkSec)
                            dismiss()
                        }) {
                            Text("\(min)分")
                                .font(.system(size: 13, weight: .heavy))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 7)
                                .background(Color(hex: "#FFD60A").opacity(0.22))
                                .foregroundColor(Color(hex: "#FFD60A"))
                                .cornerRadius(7)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 7)
                                        .stroke(Color(hex: "#FFD60A").opacity(0.6), lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 2)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
        }
    }
    
    // MARK: - 標準操作画面（タイマー稼働中の＋／−・停止・タイム再入力）
    @ViewBuilder
    private var standardActionScrollView: some View {
        ScrollView {
            VStack(spacing: 6) {
                // 通常操作モード
                HStack {
                    Text("\(item.displaySeatName)のタイマー操作")
                        .font(.system(size: 12, weight: .heavy))
                    Spacer()
                    Text("全体: \(item.totalSeconds / 60)分")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.gray)
                }
                .padding(.horizontal, 4)
                
                Divider()
                    .padding(.vertical, 1)
                
                // ★ ① 一番上: 時刻 ＋ タイマーを止める（緑色！）
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    onStop()
                    dismiss()
                }) {
                    HStack(spacing: 6) {
                        // リアルタイム残り時間（下の＋／−を押すとリアルタイムで変化！）
                        HStack(spacing: 3) {
                            Image(systemName: "timer")
                                .font(.system(size: 10, weight: .bold))
                            Text(formatSeconds(currentDisplaySeconds))
                                .font(.system(size: 15, weight: .black, design: .rounded))
                                .monospacedDigit()
                        }
                        .foregroundColor(.black)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.white.opacity(0.35))
                        .cornerRadius(5)
                        
                        Spacer()
                        
                        HStack(spacing: 3) {
                            Image(systemName: "stop.circle.fill")
                                .font(.system(size: 12, weight: .heavy))
                            Text("タイマーを止める")
                                .font(.system(size: 11, weight: .heavy))
                        }
                        .foregroundColor(.black)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 8)
                    .background(Color(hex: "#30D158"))
                    .cornerRadius(8)
                    .shadow(color: Color(hex: "#30D158").opacity(0.35), radius: 2, x: 0, y: 1)
                }
                .buttonStyle(.plain)
                
                // ★ ② ヘルプ項目連動ボタン（シャンプー／チェック／コーミング等に連動。未指定時は非表示・同居絶対防止）
                if !item.isNoHelpNeeded {
                    let p = item.helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !p.isEmpty {
                        if p == "チェック" {
                            Button(action: {
                                WKInterfaceDevice.current().play(.click)
                                onCompleteCheck?()
                                dismiss()
                            }) {
                                HStack(spacing: 5) {
                                    Image(systemName: "magnifyingglass")
                                        .font(.system(size: 12, weight: .heavy))
                                    Text("チェックに入る（切り上げ）")
                                        .font(.system(size: 12, weight: .heavy))
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(
                                    LinearGradient(
                                        colors: [Color(hex: "#30D158"), Color(hex: "#248A3D")],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                                .foregroundColor(.white)
                                .cornerRadius(8)
                                .shadow(color: Color(hex: "#30D158").opacity(0.3), radius: 2, x: 0, y: 1)
                            }
                            .buttonStyle(.plain)
                        } else {
                            let iconName = (p == "コーミング") ? "comb.fill" : "drop.fill"
                            Button(action: {
                                WKInterfaceDevice.current().play(.click)
                                onEnterHelp?()
                                dismiss()
                            }) {
                                HStack(spacing: 5) {
                                    Image(systemName: iconName)
                                        .font(.system(size: 12, weight: .heavy))
                                    Text("\(p)に入る（切り上げ）")
                                        .font(.system(size: 12, weight: .heavy))
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(
                                    LinearGradient(
                                        colors: [Color(hex: "#0A84FF"), Color(hex: "#0062D2")],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                                .foregroundColor(.white)
                                .cornerRadius(8)
                                .shadow(color: Color(hex: "#0A84FF").opacity(0.35), radius: 2, x: 0, y: 1)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                
                // ③ +1分, +3分, +5分（何回も押せる！dismissしない）
                HStack(spacing: 5) {
                    Button(action: {
                        accumulatedDelta += 60
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("+1分")
                            .font(.system(size: 12, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color.white.opacity(0.16))
                            .foregroundColor(.white)
                            .cornerRadius(7)
                    }
                    .buttonStyle(.plain)
                    
                    Button(action: {
                        accumulatedDelta += 180
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("+3分")
                            .font(.system(size: 12, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color.white.opacity(0.16))
                            .foregroundColor(.white)
                            .cornerRadius(7)
                    }
                    .buttonStyle(.plain)
                    
                    Button(action: {
                        accumulatedDelta += 300
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("+5分")
                            .font(.system(size: 12, weight: .heavy))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color(hex: "#0A84FF").opacity(0.35))
                            .foregroundColor(Color(hex: "#64D2FF"))
                            .cornerRadius(7)
                    }
                    .buttonStyle(.plain)
                }
                
                // ③ -30秒, +30秒（何回も押せる！dismissしない）
                HStack(spacing: 5) {
                    Button(action: {
                        accumulatedDelta -= 30
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("-30秒")
                            .font(.system(size: 11, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 7)
                            .background(Color.white.opacity(0.12))
                            .foregroundColor(Color(hex: "#C0C0C8"))
                            .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                    
                    Button(action: {
                        accumulatedDelta += 30
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("+30秒")
                            .font(.system(size: 11, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 7)
                            .background(Color.white.opacity(0.12))
                            .foregroundColor(Color(hex: "#C0C0C8"))
                            .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                }
                
                Divider()
                    .padding(.vertical, 1)
                
                // ★ ④ 一番下: 追加タイムを押すと「確定」に変わる！（黄色）
                if accumulatedDelta != 0 {
                    HStack(spacing: 5) {
                        // 取り消し・リセットボタン
                        Button(action: {
                            withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                                accumulatedDelta = 0
                            }
                            WKInterfaceDevice.current().play(.click)
                        }) {
                            Image(systemName: "arrow.counterclockwise")
                                .font(.system(size: 12, weight: .bold))
                                .frame(width: 34, height: 34)
                                .background(Color.white.opacity(0.15))
                                .foregroundColor(.white)
                                .cornerRadius(7)
                        }
                        .buttonStyle(.plain)
                        
                        // 確定ボタン（黄色）
                        Button(action: {
                            onAdjust(accumulatedDelta)
                            dismiss()
                        }) {
                            HStack(spacing: 4) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 13, weight: .heavy))
                                Text("確定 (\(formatDelta(accumulatedDelta)))")
                                    .font(.system(size: 12, weight: .black))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                            .background(
                                LinearGradient(colors: [Color(hex: "#FFD60A"), Color(hex: "#FF9F0A")], startPoint: .leading, endPoint: .trailing)
                            )
                            .foregroundColor(.black)
                            .cornerRadius(8)
                            .shadow(color: Color(hex: "#FFD60A").opacity(0.4), radius: 2, x: 0, y: 1)
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    // 追加タイムがない時は「タイム再入力。」（黄色）
                    Button(action: {
                        crownSeconds = 0.0
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            isReinputMode = true
                        }
                    }) {
                        HStack(spacing: 6) {
                            Image(systemName: "arrow.triangle.2.circlepath")
                                .font(.system(size: 12, weight: .bold))
                            Text("タイム再入力。")
                                .font(.system(size: 12, weight: .heavy))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color(hex: "#FFD60A"))
                        .foregroundColor(.black)
                        .cornerRadius(8)
                        .shadow(color: Color(hex: "#FFD60A").opacity(0.35), radius: 2, x: 0, y: 1)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
        }
    }
}

// MARK: - チェック操作シート
struct CheckActionSheet: View {
    @Environment(\.dismiss) var dismiss
    let item: SeatTimerItem
    let currentUserName: String
    let onOpenSelectStaff: () -> Void
    let onCompleteCheck: () -> Void
    let onCancelCheck: () -> Void
    
    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Text("\(item.displaySeatName)のチェックタイマー")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundColor(.white)
                
                if let staff = item.checkStaff {
                    Text("担当: \(staff)")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Color(hex: "#30D158"))
                } else if item.isRecruiting {
                    Text("担当: 募集中")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Color(hex: "#FF9F0A"))
                } else {
                    Text("担当: 未定")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Color(hex: "#FFD60A"))
                }
                
                // ★ 担当者を指定/変更ボタン（タップでスタッフ選択シートを開く）
                Button(action: {
                    dismiss()
                    onOpenSelectStaff()
                }) {
                    HStack(spacing: 5) {
                        Image(systemName: "person.badge.plus")
                            .font(.system(size: 12, weight: .bold))
                        Text(item.checkStaff == nil ? "担当者を指定する" : "担当者を変更する")
                            .font(.system(size: 12, weight: .bold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color(hex: "#0A84FF"))
                    .foregroundColor(.white)
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                
                Button(action: {
                    onCompleteCheck()
                    dismiss()
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                        Text("チェック完了にする")
                    }
                    .font(.system(size: 13, weight: .heavy))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(Color(hex: "#30D158"))
                    .foregroundColor(.black)
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                
                Button(action: {
                    onCancelCheck()
                    dismiss()
                }) {
                    Text("チェックタイマーを解除")
                        .font(.system(size: 11, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(Color.white.opacity(0.1))
                        .foregroundColor(.gray)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
        }
    }
}

// MARK: - チェック担当スタッフ指定・募集シート
struct SelectCheckStaffSheet: View {
    @Environment(\.dismiss) var dismiss
    let item: SeatTimerItem
    let currentUserName: String
    let staffCandidates: [String]
    let onAssignStaff: (String) -> Void
    let onRecruitAll: () -> Void
    let onClearStaff: () -> Void
    
    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                // ヘッダー部
                VStack(spacing: 2) {
                    Text("\(item.displaySeatName) チェック担当")
                        .font(.system(size: 13, weight: .heavy))
                        .foregroundColor(.white)
                    
                    Text("チェック担当の指定または全員に募集")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.gray)
                }
                
                Divider()
                
                // ① 全員に募集する（アンバー）
                Button(action: {
                    onRecruitAll()
                    dismiss()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "megaphone.fill")
                            .font(.system(size: 12, weight: .heavy))
                        Text("全員に募集する")
                            .font(.system(size: 13, weight: .black))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(
                        LinearGradient(colors: [Color(hex: "#FF9F0A"), Color(hex: "#FF8000")], startPoint: .leading, endPoint: .trailing)
                    )
                    .foregroundColor(.black)
                    .cornerRadius(8)
                    .shadow(color: Color(hex: "#FF9F0A").opacity(0.4), radius: 2, x: 0, y: 1)
                }
                .buttonStyle(.plain)
                
                // ② あなた（自分）が担当する（緑）
                Button(action: {
                    onAssignStaff(currentUserName)
                    dismiss()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "person.fill.checkmark")
                            .font(.system(size: 12, weight: .heavy))
                        Text("自分がチェックする")
                            .font(.system(size: 13, weight: .heavy))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color(hex: "#30D158"))
                    .foregroundColor(.black)
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                
                // ③ 個別スタッフを指定
                Text("スタッフを指名（相手に通知）")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(Color(hex: "#A0A0A5"))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 2)
                
                if staffCandidates.isEmpty {
                    VStack(spacing: 4) {
                        Image(systemName: "person.crop.circle.badge.plus")
                            .font(.system(size: 20))
                            .foregroundColor(Color(hex: "#0A84FF"))
                        Text("📱 スマホの共有コードでメンバーを連携してください")
                            .font(.system(size: 9.5, weight: .bold))
                            .foregroundColor(.white)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .padding(.horizontal, 6)
                    .background(Color.white.opacity(0.06))
                    .cornerRadius(8)
                } else {
                    ForEach(staffCandidates, id: \.self) { staff in
                        let isMe = (staff == currentUserName)
                        let isSelected = (item.checkStaff == staff)
                        
                        Button(action: {
                            onAssignStaff(staff)
                            dismiss()
                        }) {
                            HStack(spacing: 6) {
                                Image(systemName: isMe ? "star.fill" : "person.fill")
                                    .font(.system(size: 11))
                                    .foregroundColor(isMe ? Color(hex: "#FFD60A") : Color(hex: "#0A84FF"))
                                
                                Text(isMe ? "\(staff)（あなた）" : staff)
                                    .font(.system(size: 12, weight: isMe ? .heavy : .bold))
                                
                                Spacer()
                                
                                if isSelected {
                                    Image(systemName: "checkmark.circle.fill")
                                        .font(.system(size: 12, weight: .bold))
                                        .foregroundColor(Color(hex: "#30D158"))
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .background(isSelected ? Color(hex: "#30D158").opacity(0.2) : (isMe ? Color(hex: "#FFD60A").opacity(0.18) : Color.white.opacity(0.12)))
                            .foregroundColor(.white)
                            .cornerRadius(8)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(isSelected ? Color(hex: "#30D158").opacity(0.6) : (isMe ? Color(hex: "#FFD60A").opacity(0.5) : Color.white.opacity(0.1)), lineWidth: 1)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                
                // ④ 既に担当者がいる場合、未定に戻すボタン
                if item.checkStaff != nil || item.isRecruiting {
                    Button(action: {
                        onClearStaff()
                        dismiss()
                    }) {
                        Text("担当を未定に戻す")
                            .font(.system(size: 11, weight: .medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(Color.white.opacity(0.08))
                            .foregroundColor(.gray)
                            .cornerRadius(8)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 2)
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
        }
    }
}

// MARK: - 編集単位（分/秒）
enum EditTimeUnit {
    case minute
    case second
}

// MARK: - 分・秒をリューズで入力する部品（Build 40）
// 以前は「分・秒をまとめた1つの入力欄」でリューズの刻み幅を切り替えていたが、
// 切替が反映されず「分を選んでも秒が変わる」不具合があった。
// 分・秒それぞれを独立した入力欄（別々のフォーカス・別々のリューズ値）にし、タップした方だけが変わるようにした。
struct CrownMinSecPicker: View {
    @Binding var totalSeconds: Int
    let maxMinutes: Int
    let fontSize: CGFloat

    @FocusState private var focusedUnit: EditTimeUnit?
    @State private var minuteValue: Double = 0
    @State private var secondValue: Double = 0

    private let minuteColor = Color(hex: "#FFD60A")
    private let secondColor = Color(hex: "#30D158")

    var body: some View {
        VStack(spacing: 2) {
            HStack(spacing: 3) {
                unitField(.minute, value: totalSeconds / 60, color: minuteColor, label: "分")
                    .focusable()
                    .focused($focusedUnit, equals: .minute)
                    .digitalCrownRotation(
                        $minuteValue,
                        from: 0.0,
                        through: Double(maxMinutes),
                        by: 1.0,
                        sensitivity: .medium,
                        isContinuous: false,
                        isHapticFeedbackEnabled: true
                    )
                    .onTapGesture {
                        focusedUnit = .minute
                        WKInterfaceDevice.current().play(.click)
                    }

                Text(":")
                    .font(.system(size: fontSize * 0.8, weight: .bold, design: .monospaced))
                    .foregroundColor(.gray)

                unitField(.second, value: totalSeconds % 60, color: secondColor, label: "秒")
                    .focusable()
                    .focused($focusedUnit, equals: .second)
                    .digitalCrownRotation(
                        $secondValue,
                        from: 0.0,
                        through: 59.0,
                        by: 1.0,
                        sensitivity: .medium,
                        isContinuous: false,
                        isHapticFeedbackEnabled: true
                    )
                    .onTapGesture {
                        focusedUnit = .second
                        WKInterfaceDevice.current().play(.click)
                    }
            }
            .frame(maxWidth: .infinity)

            HStack(spacing: 3) {
                Image(systemName: "digitalcrown.horizontal.press.fill")
                    .font(.system(size: 8))
                Text(focusedUnit == .second ? "Crownで【秒】を調整（分をタップで切替）" : "Crownで【分】を調整（秒をタップで切替）")
                    .font(.system(size: 8.5, weight: .medium))
            }
            .foregroundColor(focusedUnit == .second ? secondColor : minuteColor)
        }
        .onAppear {
            syncFromTotal(totalSeconds)
            focusedUnit = .minute
        }
        .onChange(of: minuteValue) { _, newValue in
            let m = min(maxMinutes, max(0, Int(newValue.rounded())))
            let next = m * 60 + totalSeconds % 60
            if next != totalSeconds { totalSeconds = next }
        }
        .onChange(of: secondValue) { _, newValue in
            let s = min(59, max(0, Int(newValue.rounded())))
            let next = (totalSeconds / 60) * 60 + s
            if next != totalSeconds { totalSeconds = next }
        }
        .onChange(of: totalSeconds) { _, newValue in
            // ピル・＋－ボタンなど外から変わった時にリューズ値を合わせる
            syncFromTotal(newValue)
        }
    }

    private func syncFromTotal(_ total: Int) {
        let m = Double(total / 60)
        let s = Double(total % 60)
        if minuteValue != m { minuteValue = m }
        if secondValue != s { secondValue = s }
    }

    private func unitField(_ unit: EditTimeUnit, value: Int, color: Color, label: String) -> some View {
        let selected = focusedUnit == unit
        return HStack(alignment: .lastTextBaseline, spacing: 1) {
            Text(String(format: "%02d", value))
                .font(.system(size: fontSize, weight: .black, design: .monospaced))
                .foregroundColor(selected ? color : Color.white.opacity(0.85))
            Text(label)
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(selected ? color : .gray)
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(selected ? color.opacity(0.18) : Color.white.opacity(0.06))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(selected ? color : Color.clear, lineWidth: 1.2)
                )
        )
    }
}

// MARK: - 新規席追加シート
struct AddSeatSheet: View {
    @Environment(\.dismiss) var dismiss
    let currentUserName: String
    @State var seatNumber: Int
    @State private var selectedMinutes: Int = 15
    @State private var selectedSeconds: Int = 0
    @State private var checkMinutes: Int = 0
    let onAdd: (SeatTimerItem) -> Void
    
    init(currentUserName: String, suggestedSeatNumber: Int, onAdd: @escaping (SeatTimerItem) -> Void) {
        self.currentUserName = currentUserName
        self._seatNumber = State(initialValue: suggestedSeatNumber)
        self.onAdd = onAdd
    }
    
    let quickPills = [10, 15, 20, 25, 30]
    let checkPills = [0, 3, 5, 7, 10]
    
    var body: some View {
        ScrollView {
            VStack(spacing: 7) {
                // 客席番号ステッパー
                HStack(spacing: 6) {
                    Text("客席番号:")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(.gray)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                    Spacer()
                    Button(action: {
                        if seatNumber > 1 {
                            WKInterfaceDevice.current().play(.click)
                            seatNumber -= 1
                        }
                    }) {
                        Image(systemName: "minus")
                            .font(.system(size: 11, weight: .bold))
                            .frame(width: 28, height: 28)
                            .background(Color.white.opacity(0.18))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                    
                    Text("\(seatNumber)番席")
                        .font(.system(size: 15, weight: .heavy, design: .rounded))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                        .frame(minWidth: 44)
                    
                    Button(action: {
                        if seatNumber < 30 {
                            WKInterfaceDevice.current().play(.click)
                            seatNumber += 1
                        }
                    }) {
                        Image(systemName: "plus")
                            .font(.system(size: 11, weight: .bold))
                            .frame(width: 28, height: 28)
                            .background(Color.white.opacity(0.18))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 4)
                
                Divider()
                
                // ★ 全体タイム（分・秒をそれぞれタップしてリューズで入力）
                HStack(alignment: .center, spacing: 3) {
                    Text("全体タイム:")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(.gray)
                    Spacer()
                }
                .padding(.horizontal, 4)
                CrownMinSecPicker(
                    totalSeconds: Binding(
                        get: { selectedMinutes * 60 + selectedSeconds },
                        set: { newValue in
                            selectedMinutes = newValue / 60
                            selectedSeconds = newValue % 60
                        }
                    ),
                    maxMinutes: 90,
                    fontSize: 24
                )
                .padding(.horizontal, 4)
                
                // 定番ピル群 (タップで即座にその分数にセット)
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 5) {
                    ForEach(quickPills, id: \.self) { min in
                        Button(action: {
                            selectedMinutes = min
                            selectedSeconds = 0
                            WKInterfaceDevice.current().play(.click)
                        }) {
                            Text("\(min)分")
                                .font(.system(size: 12, weight: .bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 6)
                                .background(selectedMinutes == min && selectedSeconds == 0 ? Color(hex: "#0A84FF") : Color.white.opacity(0.12))
                                .foregroundColor(selectedMinutes == min && selectedSeconds == 0 ? .white : Color(hex: "#E0E0E5"))
                                .cornerRadius(7)
                        }
                        .buttonStyle(.plain)
                    }
                }
                
                Divider()
                
                HStack(alignment: .firstTextBaseline) {
                    Text("途中チェック:")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.gray)
                    Spacer()
                    Text(checkMinutes == 0 ? "なし" : "\(checkMinutes)分")
                        .font(.system(size: 15, weight: .heavy, design: .rounded))
                        .foregroundColor(checkMinutes == 0 ? .gray : Color(hex: "#30D158"))
                }
                .padding(.horizontal, 4)
                
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 5) {
                    ForEach(checkPills, id: \.self) { cmin in
                        Button(action: {
                            checkMinutes = cmin
                            WKInterfaceDevice.current().play(.click)
                        }) {
                            Text(cmin == 0 ? "なし" : "\(cmin)分")
                                .font(.system(size: 11, weight: .bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 6)
                                .background(checkMinutes == cmin ? Color(hex: "#30D158") : Color.white.opacity(0.12))
                                .foregroundColor(checkMinutes == cmin ? .black : Color(hex: "#E0E0E5"))
                                .cornerRadius(7)
                        }
                        .buttonStyle(.plain)
                    }
                }
                
                Button(action: {
                    let totalSec = selectedMinutes * 60 + selectedSeconds
                    guard totalSec > 0 else { return }
                    var newItem = SeatTimerItem(
                        id: UUID().uuidString,
                        seatNumber: seatNumber,
                        creatorName: currentUserName,
                        totalSeconds: totalSec,
                        targetEndTime: Date().addingTimeInterval(Double(totalSec)),
                        isRunning: true,
                        pausedRemainingSeconds: totalSec,
                        shampooStaff: nil,
                        status: .normal
                    )
                    if checkMinutes > 0 && (checkMinutes * 60) < totalSec {
                        newItem.checkTotalSeconds = checkMinutes * 60
                        newItem.checkTargetEndTime = Date().addingTimeInterval(Double(checkMinutes * 60))
                        newItem.checkStaff = nil
                    }
                    onAdd(newItem)
                    dismiss()
                }) {
                    Text("タイマースタート")
                        .font(.system(size: 13, weight: .heavy))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(selectedMinutes * 60 + selectedSeconds > 0 ? Color(hex: "#30D158") : Color.gray.opacity(0.3))
                        .foregroundColor(selectedMinutes * 60 + selectedSeconds > 0 ? .black : .gray)
                        .cornerRadius(9)
                }
                .buttonStyle(.plain)
                .disabled(selectedMinutes * 60 + selectedSeconds <= 0)
                .padding(.top, 4)
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 16)
        }
    }
}

// MARK: - シャンプー・施術操作シート（スタッフ指定済み時のタップ）
struct ShampooActionSheet: View {
    @Environment(\.dismiss) var dismiss
    let item: SeatTimerItem
    let onStartShampoo: () -> Void
    let onFinishShampoo: () -> Void
    let onStartCombing: () -> Void
    let onFinishCombing: () -> Void
    var onStartCheck: (() -> Void)? = nil
    var onFinishCheck: (() -> Void)? = nil
    let onChangeStaff: () -> Void
    let onClearStaff: () -> Void
    
    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                VStack(spacing: 2) {
                    Text("\(item.displaySeatName)の\(item.helpProcess)操作")
                        .font(.system(size: 13, weight: .heavy))
                        .foregroundColor(.white)
                    
                    if let staff = item.shampooStaff {
                        Text("現在の担当: \(staff)")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(Color(hex: "#FFD60A"))
                    }
                }
                
                Divider()
                
                // ★ 指定された技術（helpProcess）に応じたボタンのみを1つ大きく表示
                if item.helpProcess == "コーミング" {
                    // ① コーミング指定時
                    if item.status == .combing {
                        Button(action: {
                            onFinishCombing()
                            dismiss()
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 16, weight: .bold))
                                Text("コーミング完了（通常へ）")
                                    .font(.system(size: 14, weight: .heavy))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color(hex: "#30D158"))
                            .foregroundColor(.black)
                            .cornerRadius(10)
                        }
                        .buttonStyle(.plain)
                    } else {
                        Button(action: {
                            onStartCombing()
                            dismiss()
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "comb.fill")
                                    .font(.system(size: 16, weight: .bold))
                                Text("コーミングする。")
                                    .font(.system(size: 15, weight: .heavy))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 13)
                            .background(Color(hex: "#0A84FF"))
                            .foregroundColor(.white)
                            .cornerRadius(10)
                            .shadow(color: Color(hex: "#0A84FF").opacity(0.35), radius: 3, x: 0, y: 2)
                        }
                        .buttonStyle(.plain)
                    }
                } else if item.helpProcess == "チェック" {
                    // ② チェック指定時
                    if item.status == .check {
                        Button(action: {
                            if let finishCheck = onFinishCheck {
                                finishCheck()
                            } else {
                                onFinishShampoo()
                            }
                            dismiss()
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 16, weight: .bold))
                                Text("チェック完了（通常へ）")
                                    .font(.system(size: 14, weight: .heavy))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color(hex: "#30D158"))
                            .foregroundColor(.black)
                            .cornerRadius(10)
                        }
                        .buttonStyle(.plain)
                    } else {
                        Button(action: {
                            if let startCheck = onStartCheck {
                                startCheck()
                            } else {
                                onStartShampoo()
                            }
                            dismiss()
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "magnifyingglass")
                                    .font(.system(size: 16, weight: .bold))
                                Text("チェックする。")
                                    .font(.system(size: 15, weight: .heavy))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 13)
                            .background(Color(hex: "#30D158"))
                            .foregroundColor(.black)
                            .cornerRadius(10)
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    // ③ シャンプー指定時（デフォルト）
                    if item.status == .shampoo {
                        Button(action: {
                            onFinishShampoo()
                            dismiss()
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 16, weight: .bold))
                                Text("シャンプー完了（通常へ）")
                                    .font(.system(size: 14, weight: .heavy))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color(hex: "#30D158"))
                            .foregroundColor(.black)
                            .cornerRadius(10)
                        }
                        .buttonStyle(.plain)
                    } else {
                        Button(action: {
                            onStartShampoo()
                            dismiss()
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "drop.fill")
                                    .font(.system(size: 16, weight: .bold))
                                Text("シャンプーする。")
                                    .font(.system(size: 15, weight: .heavy))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 13)
                            .background(Color(hex: "#0A84FF"))
                            .foregroundColor(.white)
                            .cornerRadius(10)
                            .shadow(color: Color(hex: "#0A84FF").opacity(0.35), radius: 3, x: 0, y: 2)
                        }
                        .buttonStyle(.plain)
                    }
                }
                
                Divider()
                
                // ③ スタッフ変更
                Button(action: {
                    dismiss()
                    onChangeStaff()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "person.2.fill")
                            .font(.system(size: 12, weight: .bold))
                        Text("スタッフ変更")
                            .font(.system(size: 12, weight: .bold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.14))
                    .foregroundColor(.white)
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                
                // ④ 担当を解除
                Button(action: {
                    onClearStaff()
                    dismiss()
                }) {
                    Text("担当を解除（未指定に戻す）")
                        .font(.system(size: 10, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(Color.white.opacity(0.08))
                        .foregroundColor(Color(hex: "#A0A0A5"))
                        .cornerRadius(6)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
        }
    }
}

// MARK: - ヘルプ工程選択・スタッフ指定・募集ワークフローシート
struct SelectHelpWorkflowSheet: View {
    @Environment(\.dismiss) var dismiss
    let item: SeatTimerItem
    let currentUserName: String
    let staffCandidates: [String]
    let onAssignStaff: (String, String) -> Void // (工程, スタッフ名) -> 相手に通知
    let onRecruitAll: (String) -> Void          // (工程) -> 全員に通知
    
    // ステップ管理: 0 = 工程選択, 1 = スタッフ指定/募集
    @State private var currentStep: Int = 0
    @State private var selectedProcess: String = "シャンプー"
    
    // 利用可能な工程
    let processOptions: [(name: String, icon: String, color: String)] = [
        ("シャンプー", "drop.fill", "#0A84FF"),
        ("コーミング", "comb.fill", "#0A84FF"),
        ("チェック", "magnifyingglass", "#30D158"),
        ("その他", "ellipsis.circle", "#8E8E93")
    ]
    
    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if currentStep == 0 {
                    // ===== ステップ1: 工程を選択 =====
                    VStack(spacing: 2) {
                        Text("\(item.displaySeatName)のヘルプ工程")
                            .font(.system(size: 13, weight: .heavy))
                            .foregroundColor(.white)
                        Text("依頼する工程を選択してください")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(.gray)
                    }
                    .padding(.bottom, 2)
                    
                    Divider()
                    
                    ForEach(processOptions, id: \.name) { proc in
                        Button(action: {
                            selectedProcess = proc.name
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                currentStep = 1
                            }
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: proc.icon)
                                    .font(.system(size: 14, weight: .bold))
                                    .foregroundColor(Color(hex: proc.color))
                                    .frame(width: 20)
                                
                                Text(proc.name)
                                    .font(.system(size: 14, weight: .heavy))
                                
                                Spacer()
                                
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundColor(.gray)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(Color.white.opacity(0.12))
                            .foregroundColor(.white)
                            .cornerRadius(9)
                        }
                        .buttonStyle(.plain)
                    }
                    
                } else {
                    // ===== ステップ2: 全員に募集 または スタッフ指定 =====
                    VStack(spacing: 2) {
                        HStack {
                            Button(action: {
                                withAnimation {
                                    currentStep = 0
                                }
                            }) {
                                Image(systemName: "chevron.left")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundColor(Color(hex: "#0A84FF"))
                            }
                            .buttonStyle(.plain)
                            
                            Spacer()
                            
                            Text("【\(selectedProcess)】の依頼")
                                .font(.system(size: 13, weight: .heavy))
                                .foregroundColor(.white)
                            
                            Spacer()
                        }
                        
                        Text("全員に募集、またはスタッフを指定")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(.gray)
                    }
                    
                    Divider()
                    
                    // ★ ① 全員に募集する（目立つアンバーボタン・全員に通知）
                    Button(action: {
                        onRecruitAll(selectedProcess)
                        dismiss()
                    }) {
                        HStack(spacing: 6) {
                            Image(systemName: "megaphone.fill")
                                .font(.system(size: 13, weight: .heavy))
                            Text("全員に募集する")
                                .font(.system(size: 13, weight: .black))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(
                            LinearGradient(colors: [Color(hex: "#FF9F0A"), Color(hex: "#FF8000")], startPoint: .leading, endPoint: .trailing)
                        )
                        .foregroundColor(.black)
                        .cornerRadius(9)
                        .shadow(color: Color(hex: "#FF9F0A").opacity(0.4), radius: 3, x: 0, y: 2)
                    }
                    .buttonStyle(.plain)
                    
                    // ★ ② 個別スタッフを指定する
                    Text("スタッフを指定（相手に通知）")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(Color(hex: "#A0A0A5"))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 2)
                    
                    if staffCandidates.isEmpty {
                        // ★ メンバーが0人の場合の案内カード
                        VStack(spacing: 5) {
                            Image(systemName: "person.crop.circle.badge.plus")
                                .font(.system(size: 24))
                                .foregroundColor(Color(hex: "#0A84FF"))
                                .padding(.top, 2)
                            Text("📱 スマホの共有コードでメンバーを連携してください")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(.white)
                                .multilineTextAlignment(.center)
                            Text("サロン画面の「メンバー」から共有コードで連携すると\nここに自動でスタッフが表示されます")
                                .font(.system(size: 8.5))
                                .foregroundColor(Color(hex: "#8E8E93"))
                                .multilineTextAlignment(.center)
                                .lineSpacing(2)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .padding(.horizontal, 6)
                        .background(Color.white.opacity(0.06))
                        .cornerRadius(8)
                    } else {
                        ForEach(staffCandidates, id: \.self) { staff in
                            let isMe = (staff == currentUserName)
                            let isSelected = (item.shampooStaff == staff)
                            
                            Button(action: {
                                onAssignStaff(selectedProcess, staff)
                                dismiss()
                            }) {
                                HStack(spacing: 6) {
                                    Image(systemName: isMe ? "star.fill" : "person.fill")
                                        .font(.system(size: 11))
                                        .foregroundColor(isMe ? Color(hex: "#FFD60A") : Color(hex: "#0A84FF"))
                                    
                                    Text(isMe ? "\(staff)（あなた）" : staff)
                                        .font(.system(size: 12, weight: isMe ? .heavy : .bold))
                                    
                                    Spacer()
                                    
                                    if isSelected {
                                        Image(systemName: "checkmark.circle.fill")
                                            .font(.system(size: 12, weight: .bold))
                                            .foregroundColor(Color(hex: "#30D158"))
                                    }
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .background(isMe ? Color(hex: "#FFD60A").opacity(0.18) : Color.white.opacity(0.12))
                                .foregroundColor(.white)
                                .cornerRadius(8)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8)
                                        .stroke(isMe ? Color(hex: "#FFD60A").opacity(0.5) : Color.white.opacity(0.1), lineWidth: 1)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
        }
    }
}

// MARK: - 客席サムネイル・バードビューシート（全席・メインタイマーの稼働状況を一目俯瞰）
struct SeatThumbnailMapSheet: View {
    @Environment(\.dismiss) var dismiss
    let timers: [SeatTimerItem]
    let mainTimer: SeatTimerItem?
    let currentUserName: String
    let now: Date
    let onSelectSeat: (SeatTimerItem) -> Void
    let onSelectMainTimer: () -> Void
    let onToggleMainTimer: () -> Void
    let onResetMainTimer: () -> Void
    let onSetMainTimerTime: (Int) -> Void
    let onAdjustMainTimer: (Int) -> Void
    let onStartMainTimer: () -> Void
    let onPauseMainTimer: () -> Void
    var onClose: (() -> Void)? = nil
    var onAddSeat: (() -> Void)? = nil
    
    // 席番号順（1番席、2番席、3番席...）に整列して物理レイアウトと連動
    var physicalSortedTimers: [SeatTimerItem] {
        timers.sorted { $0.seatNumber < $1.seatNumber }
    }
    
    // サマリー集計（メインタイマーも稼働数に算入）
    var isMainRunning: Bool {
        guard let m = mainTimer else { return false }
        return (m.isRunning && m.remainingSeconds > 0) || m.isPreCountingDown
    }
    var runningCount: Int {
        timers.filter { $0.isRunning && $0.remainingSeconds > 0 }.count + (isMainRunning ? 1 : 0)
    }
    var recruitingCount: Int { timers.filter { $0.isRecruiting }.count }
    var pausedCount: Int {
        timers.filter { !$0.isRunning }.count + ((mainTimer != nil && !isMainRunning) ? 1 : 0)
    }
    
    var body: some View {
        ScrollView {
            VStack(spacing: 7) {
                // ① ヘッダー＆サマリーピルバー
                VStack(spacing: 4) {
                    HStack {
                        Image(systemName: "square.grid.2x2.fill")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(Color(hex: "#64D2FF"))
                        Text("サロン客席マップ")
                            .font(.system(size: 13, weight: .heavy))
                            .foregroundColor(.white)
                        Spacer()
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            if let onClose = onClose {
                                onClose()
                            } else {
                                dismiss()
                            }
                        }) {
                            HStack(spacing: 2) {
                                Image(systemName: "list.bullet")
                                    .font(.system(size: 9, weight: .bold))
                                Text("リスト")
                                    .font(.system(size: 9.5, weight: .bold))
                            }
                            .foregroundColor(Color(hex: "#64D2FF"))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2.5)
                            .background(Color(hex: "#64D2FF").opacity(0.18))
                            .cornerRadius(6)
                        }
                        .buttonStyle(.plain)
                    }
                    
                    // 稼働サマリーピル（一目で状況把握）
                    HStack(spacing: 5) {
                        HStack(spacing: 3) {
                            Circle()
                                .fill(Color(hex: "#30D158"))
                                .frame(width: 6, height: 6)
                            Text("稼働:\(runningCount)")
                                .font(.system(size: 10, weight: .heavy))
                                .foregroundColor(.white)
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.white.opacity(0.12))
                        .cornerRadius(5)
                        
                        if recruitingCount > 0 {
                            HStack(spacing: 3) {
                                Image(systemName: "megaphone.fill")
                                    .font(.system(size: 8))
                                    .foregroundColor(Color(hex: "#FF9F0A"))
                                Text("募集:\(recruitingCount)")
                                    .font(.system(size: 10, weight: .heavy))
                                    .foregroundColor(Color(hex: "#FFD60A"))
                            }
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color(hex: "#FF9F0A").opacity(0.25))
                            .cornerRadius(5)
                        }
                        
                        HStack(spacing: 2) {
                            Text("⏸ 停止:\(pausedCount)")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundColor(Color(hex: "#8E8E93"))
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.white.opacity(0.08))
                        .cornerRadius(5)
                        
                        Spacer()
                    }
                }
                .padding(.horizontal, 4)
                
                // ★ メインタイマー専用カード（上段にフルタイトル・下段に特大タイマー時間・タップで詳細シート）
                if let main = mainTimer {
                    ThumbnailMainTimerCard(
                        item: main,
                        now: now,
                        onTap: {
                            onSelectMainTimer()
                        }
                    )
                }
                
                Divider()
                
                // ② 2列サムネイルグリッド（客席タイマー群）
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
                    ForEach(physicalSortedTimers) { item in
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            onSelectSeat(item)
                        }) {
                            ThumbnailSeatCard(
                                item: item,
                                currentUserName: currentUserName,
                                now: now
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 2)
                
                Text("※タップすると席のタイマー操作が開きます")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(Color(hex: "#8E8E93"))
                    .padding(.top, 4)
                
                if let onAddSeat = onAddSeat {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        onAddSeat()
                    }) {
                        HStack(spacing: 5) {
                            Image(systemName: "plus.circle.fill")
                                .font(.system(size: 13, weight: .bold))
                            Text("新しい席を追加")
                                .font(.system(size: 12, weight: .bold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color(hex: "#0A84FF").opacity(0.18))
                        .foregroundColor(Color(hex: "#0A84FF"))
                        .cornerRadius(9)
                        .overlay(
                            RoundedRectangle(cornerRadius: 9)
                                .stroke(Color(hex: "#0A84FF").opacity(0.4), lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 2)
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 4)
        }
    }
}

// MARK: - メインタイマー用サムネイルカード（マップ上部全幅・文字崩れ完全解消＆上下2段レイアウト）
struct ThumbnailMainTimerCard: View {
    let item: SeatTimerItem
    let now: Date
    let onTap: () -> Void
    
    @State private var isPulsing = false
    
    var isRunning: Bool { item.isRunning && item.remainingSeconds > 0 }
    var isOvertime: Bool { item.isOvertime }
    var rem: Int { item.remainingSeconds }
    
    // 時間連動カラー判定
    var stateColor: (border: Color, bg: Color, text: Color) {
        if isOvertime {
            // 超過時: 赤 ＆ パルス発光
            let c = Color(hex: "#FF453A")
            return (c, c.opacity(isPulsing ? 0.38 : 0.18), c)
        } else if item.isPreCountingDown {
            // 準備カウントダウン中: 黄色
            let c = Color(hex: "#FFD60A")
            return (c, c.opacity(0.20), c)
        } else if isRunning {
            if rem <= 60 {
                // 残り1分以内: 赤
                let c = Color(hex: "#FF453A")
                return (c, c.opacity(0.24), c)
            } else if rem <= 180 {
                // 残り3分以内: 黄
                let c = Color(hex: "#FFD60A")
                return (c, c.opacity(0.20), c)
            } else {
                // 通常稼働: エメラルドグリーン
                let c = Color(hex: "#30D158")
                return (c, c.opacity(0.18), Color(hex: "#30D158"))
            }
        } else {
            // 停止中
            return (Color(hex: "#30D158").opacity(0.3), Color(hex: "#30D158").opacity(0.06), Color(hex: "#8E8E93"))
        }
    }
    
    private func formatSeconds(_ seconds: Int) -> String {
        let m = max(0, seconds) / 60
        let s = max(0, seconds) % 60
        return String(format: "%02d:%02d", m, s)
    }
    
    var body: some View {
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            onTap()
        }) {
            VStack(alignment: .leading, spacing: 3) {
                // 上段: ヘッダー（「メインタイマー」フル表示 + 状態バッジ + 遷移矢印）
                HStack(spacing: 4) {
                    Image(systemName: "stopwatch.fill")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(stateColor.text)
                    Text("メインタイマー")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .fixedSize()
                    
                    if let genre = item.genre, !genre.isEmpty {
                        Text(genre)
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundColor(stateColor.text)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(stateColor.text.opacity(0.2))
                            .cornerRadius(4)
                            .lineLimit(1)
                    }
                    
                    Spacer()
                    
                    // 稼働状態インジケータ（タップで設定へ進めることが直感的にわかる）
                    HStack(spacing: 2) {
                        if isOvertime {
                            Text("超過")
                                .font(.system(size: 9.5, weight: .heavy))
                                .foregroundColor(Color(hex: "#FF453A"))
                        } else if item.isPreCountingDown {
                            Circle()
                                .fill(Color(hex: "#FFD60A"))
                                .frame(width: 5, height: 5)
                            Text("準備中")
                                .font(.system(size: 9.5, weight: .bold))
                                .foregroundColor(Color(hex: "#FFD60A"))
                        } else if isRunning {
                            Circle()
                                .fill(stateColor.text)
                                .frame(width: 5, height: 5)
                            Text("稼働中")
                                .font(.system(size: 9.5, weight: .bold))
                                .foregroundColor(stateColor.text)
                        } else {
                            Text("⏸ 停止")
                                .font(.system(size: 9.5, weight: .medium))
                                .foregroundColor(Color(hex: "#8E8E93"))
                        }
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundColor(Color(hex: "#8E8E93"))
                    }
                }
                
                // 下段: 大きなタイマー数字 ＆ 全体設定分数（改行せず1行で綺麗に収まる）
                HStack(alignment: .firstTextBaseline) {
                    if item.isPreCountingDown {
                        Text(formatSeconds(item.prepRemainingSeconds))
                            .font(.system(size: 20, weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#FFD60A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                    } else if isRunning {
                        Text(formatSeconds(rem))
                            .font(.system(size: 20, weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(stateColor.text)
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                    } else if isOvertime {
                        Text("+\(formatSeconds(abs(rem)))")
                            .font(.system(size: 20, weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#FF453A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                    } else {
                        let pausedSec = item.pausedRemainingSeconds > 0 ? item.pausedRemainingSeconds : item.totalSeconds
                        Text(formatSeconds(pausedSec))
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#8E8E93"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                    }
                    
                    Spacer()
                    
                    Text("\(max(1, item.totalSeconds / 60))分設定")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(Color(hex: "#8E8E93"))
                }
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(stateColor.bg)
            .cornerRadius(9)
            .overlay(
                RoundedRectangle(cornerRadius: 9)
                    .stroke(stateColor.border, lineWidth: isOvertime && isPulsing ? 1.5 : 1)
            )
            .shadow(color: isOvertime && isPulsing ? Color(hex: "#FF453A").opacity(0.85) : Color.clear, radius: 4)
        }
        .buttonStyle(.plain)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                isPulsing = true
            }
        }
    }
}

// MARK: - サムネイル席カード
struct ThumbnailSeatCard: View {
    let item: SeatTimerItem
    let currentUserName: String
    let now: Date
    
    @State private var isPulsing = false
    
    var isRunning: Bool { item.isRunning && item.remainingSeconds > 0 }
    var isOvertime: Bool { item.isOvertime }
    var isMe: Bool { item.isRelated(to: currentUserName) }
    var rem: Int { item.remainingSeconds }
    
    // 時間連動カラー判定（青 ➔ 残り3分: 黄 ➔ 残り1分: 赤 ➔ 超過: 全赤＆パルス発光）
    var stateColor: (border: Color, bg: Color, text: Color) {
        if isOvertime {
            let red = Color(hex: "#FF453A")
            return (red, red.opacity(isPulsing ? 0.38 : 0.18), red)
        } else if isRunning {
            if rem <= 60 {
                // 残り1分以内: 赤警告
                let red = Color(hex: "#FF453A")
                return (red, red.opacity(0.24), red)
            } else if rem <= 180 {
                // 残り3分以内: 黄色注意
                let yellow = Color(hex: "#FFD60A")
                return (yellow, yellow.opacity(0.20), yellow)
            } else if item.isRecruiting {
                // 募集中
                let orange = Color(hex: "#FF9F0A")
                return (orange, orange.opacity(0.18), orange)
            } else if item.shampooStaff == currentUserName || item.creatorName == currentUserName {
                // 自分関連
                let gold = Color(hex: "#FFD60A")
                return (gold, gold.opacity(0.15), Color(hex: "#64D2FF"))
            } else {
                // 通常カウント中: 青
                let blue = Color(hex: "#0A84FF")
                return (blue, blue.opacity(0.15), Color(hex: "#64D2FF"))
            }
        } else {
            // 停止中
            return (Color.white.opacity(0.16), Color.white.opacity(0.05), Color(hex: "#8E8E93"))
        }
    }
    
    private func formatSeconds(_ seconds: Int) -> String {
        let m = max(0, seconds) / 60
        let s = max(0, seconds) % 60
        return String(format: "%02d:%02d", m, s)
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // 上段: 席名 ＋ 状態インジケーターランプ
            HStack(spacing: 2) {
                Text(item.displaySeatName)
                    .font(.system(size: 11.5, weight: .heavy))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .minimumScaleFactor(0.8)
                
                Spacer(minLength: 2)
                
                if isOvertime {
                    Text("超過")
                        .font(.system(size: 8, weight: .heavy))
                        .foregroundColor(.white)
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(Color(hex: "#FF453A"))
                        .cornerRadius(3)
                } else if isRunning && rem <= 60 {
                    Text("まもなく")
                        .font(.system(size: 7.5, weight: .heavy))
                        .foregroundColor(.white)
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(Color(hex: "#FF453A"))
                        .cornerRadius(3)
                } else if isRunning && rem <= 180 {
                    Text("残3分")
                        .font(.system(size: 7.5, weight: .heavy))
                        .foregroundColor(.black)
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(Color(hex: "#FFD60A"))
                        .cornerRadius(3)
                } else if item.isRecruiting {
                    Image(systemName: "megaphone.fill")
                        .font(.system(size: 8.5, weight: .bold))
                        .foregroundColor(Color(hex: "#FF9F0A"))
                } else if isRunning {
                    Circle()
                        .fill(Color(hex: "#30D158"))
                        .frame(width: 6.5, height: 6.5)
                } else {
                    Text("停止")
                        .font(.system(size: 7.5, weight: .medium))
                        .foregroundColor(Color(hex: "#8E8E93"))
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(Color.white.opacity(0.12))
                        .cornerRadius(3)
                }
            }
            
            // 中段: 時間数字（稼働中は大きく、超過時は赤、停止中は薄く）
            if isRunning {
                Text(formatSeconds(rem))
                    .font(.system(size: 15, weight: .black, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(stateColor.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            } else if isOvertime {
                Text("+\(formatSeconds(abs(rem)))")
                    .font(.system(size: 14.5, weight: .black, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(Color(hex: "#FF453A"))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            } else {
                Text("00:00")
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(Color(hex: "#636366"))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            
            // ★ チェック体制（途中チェックタイマー稼働中のみ中段下部に表示）
            if let checkRem = item.checkRemainingSeconds, !item.isCheckCompleted {
                let checkStaff = item.checkStaff ?? (item.isRecruiting ? "募集中" : "未定")
                let isCheckOver = checkRem <= 0
                let isCheckUnder1Min = checkRem <= 60
                let checkColor: Color = (isCheckOver || isCheckUnder1Min) ? Color(hex: "#FF453A") : Color(hex: "#FF9F0A")
                
                HStack(spacing: 2) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 6.5, weight: .bold))
                    Text("検:\(formatSeconds(checkRem))")
                        .font(.system(size: 7.5, weight: .bold, design: .rounded))
                        .monospacedDigit()
                    Text(checkStaff == currentUserName ? "あなた" : checkStaff)
                        .font(.system(size: 7, weight: .bold))
                        .lineLimit(1)
                }
                .foregroundColor(checkColor)
                .padding(.horizontal, 2.5)
                .padding(.vertical, 1)
                .background(checkColor.opacity(0.15))
                .cornerRadius(3)
            }
            
            // 下段: 【作成者（主担当）】＆【ヘルプ担当】の2人表示
            VStack(alignment: .leading, spacing: 1.5) {
                // ① タイマー作成者（主担当スタイリスト）
                HStack(spacing: 2) {
                    Image(systemName: "pencil")
                        .font(.system(size: 6.5, weight: .bold))
                        .foregroundColor(item.creatorName == currentUserName ? Color(hex: "#FFD60A") : Color(hex: "#8E8E93"))
                    Text("主:\(item.creatorName == currentUserName ? "あなた" : (item.creatorName.isEmpty ? "主担当" : item.creatorName))")
                        .font(.system(size: 8, weight: item.creatorName == currentUserName ? .heavy : .bold))
                        .foregroundColor(item.creatorName == currentUserName ? Color(hex: "#FFD60A") : Color(hex: "#E5E5EA"))
                        .lineLimit(1)
                }
                
                // ② ヘルプ担当（アシスタント / 一人施術 / 募集中）
                HStack(spacing: 2) {
                    if item.isNoHelpNeeded {
                        Image(systemName: "person.fill")
                            .font(.system(size: 6.5))
                            .foregroundColor(Color(hex: "#8E8E93"))
                        Text("助:なし (一人)")
                            .font(.system(size: 8, weight: .medium))
                            .foregroundColor(Color(hex: "#8E8E93"))
                            .lineLimit(1)
                    } else if (!isRunning && rem <= 0) || item.isZero || item.isCollapsed {
                        Text("助:待機中")
                            .font(.system(size: 8, weight: .medium))
                            .foregroundColor(Color(hex: "#8E8E93"))
                            .lineLimit(1)
                    } else if item.isRecruiting {
                        Image(systemName: "megaphone.fill")
                            .font(.system(size: 6.5))
                            .foregroundColor(Color(hex: "#FF9F0A"))
                        Text("助:募集中")
                            .font(.system(size: 8, weight: .heavy))
                            .foregroundColor(Color(hex: "#FFD60A"))
                            .lineLimit(1)
                    } else if let staff = item.shampooStaff, !staff.isEmpty {
                        Image(systemName: "hands.sparkles.fill")
                            .font(.system(size: 6.5))
                            .foregroundColor(staff == currentUserName ? Color(hex: "#FFD60A") : Color(hex: "#0A84FF"))
                        Text("助:\(staff == currentUserName ? "あなた" : staff)")
                            .font(.system(size: 8, weight: staff == currentUserName ? .heavy : .bold))
                            .foregroundColor(staff == currentUserName ? Color(hex: "#FFD60A") : Color(hex: "#64D2FF"))
                            .lineLimit(1)
                    } else if isRunning {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 6.5))
                            .foregroundColor(Color(hex: "#FF453A"))
                        Text("助:未定")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundColor(Color(hex: "#FF453A"))
                            .lineLimit(1)
                    } else {
                        Text("助:待機中")
                            .font(.system(size: 8, weight: .medium))
                            .foregroundColor(Color(hex: "#8E8E93"))
                            .lineLimit(1)
                    }
                }
            }
            .padding(.top, 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .background(stateColor.bg)
        .cornerRadius(9)
        .overlay(
            RoundedRectangle(cornerRadius: 9)
                .stroke(stateColor.border, lineWidth: isOvertime && isPulsing ? 1.5 : 1)
        )
        .shadow(color: isOvertime && isPulsing ? Color(hex: "#FF453A").opacity(0.85) : Color.clear, radius: 4)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                isPulsing = true
            }
        }
    }
}

// MARK: - プレビュー
struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
