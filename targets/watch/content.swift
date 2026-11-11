import SwiftUI
import Combine
import WatchConnectivity

// MARK: - Safe Numeric Conversion Helpers (arm64_32 32-bit Int Overflow Prevention)

/// TimeInterval（秒差）を32bit Intでも絶対にオーバーフローしない範囲（既定±864,000秒＝±10日）にクランプしてIntへ変換する
func safeClampedSeconds(_ interval: TimeInterval, maxAbs: Double = 864_000.0) -> Int {
    guard interval.isFinite else { return 0 }
    return Int(min(maxAbs, max(-maxAbs, interval)))
}

/// TimeInterval（秒差）を切り上げ（ceil）した上で安全範囲にクランプしてIntへ変換する
func safeClampedCeilSeconds(_ interval: TimeInterval, maxAbs: Double = 864_000.0) -> Int {
    guard interval.isFinite else { return 0 }
    return Int(min(maxAbs, max(-maxAbs, ceil(interval))))
}

/// UNIXエポック秒（またはミリ秒混入値）を安全にInt64秒へ変換する（2038年問題およびarm64_32 SIGTRAP完全防止）
func safeEpochSecondsInt64(_ raw: TimeInterval) -> Int64 {
    guard raw.isFinite, raw > 0 else { return 0 }
    let norm = raw > 10_000_000_000 ? (raw / 1000.0) : raw
    let clamped = min(4_102_444_800.0, max(0.0, norm))
    return Int64(clamped.rounded())
}

/// UNIXエポックミリ秒（または秒混入値）を安全にInt64ミリ秒へ変換する（arm64_32でのInt(nowEpoch * 1000)オーバーフロー完全防止）
func safeEpochMillisInt64(_ rawMs: Double) -> Int64 {
    guard rawMs.isFinite, rawMs > 0 else { return 0 }
    let ms = rawMs < 10_000_000_000 ? (rawMs * 1000.0) : rawMs
    let clamped = min(4_102_444_800_000.0, max(0.0, ms))
    return Int64(clamped.rounded())
}

// MARK: - ★ 全画面・全モーダルシート共通の常時稼働リアルタイムクロック（シート開閉や親View再描画で停止・リセットしない恒久Timer）
final class WatchRealtimeClock {
    static let shared = WatchRealtimeClock()
    let publisher = PassthroughSubject<Date, Never>()
    private var timer: Timer?

    private init() {
        let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            let now = Date()
            self?.publisher.send(now)
            // ★ watchOS の画面減光（Always-On Display / .inactive 遷移）により SwiftUI の View.onReceive が一時停止している間も、
            //   RunLoop.main 上の直結タイマーから準備カウントダウン完了遷移、アラーム 00:00 到達検知（tick）と Supabase 直接同期ポーリングを継続実行する
            WatchSessionManager.shared.advanceMainTimerPreCountdownIfNeeded(now: now)
            WatchAlarmCoordinator.shared.tick()
            if WKApplication.shared().applicationState != .background {
                WatchSessionManager.shared.pollCloudTimersFromSupabaseIfNeeded()
            }
        }
        RunLoop.main.add(t, forMode: .common)
        self.timer = t
    }
}

// MARK: - データモデル (絶対終了時刻 targetEndTime 基準)
struct SeatTimerItem: Identifiable, Equatable {
    var id: String
    var seatNumber: Int
    var seatLabel: String? = nil // ★ ユーザー登録表示名（例: "1番席 (個室)"）
    var createdBy: String? = nil // ★ タイマー作成者のクラウドユーザーUUID（同名・デフォルト名「スタイリスト」でも主担当を厳密保持）
    var creatorName: String
    var isCreatorMeExplicit: Bool? = nil // ★ iPhone側でcreatedByユーザーID照合済みの自ユーザー作成判定
    var totalSeconds: Int // 全体初期設定秒数 (例: 900秒 = 15分)
    var targetEndTime: Date // 終了目標時刻（画面消灯・スリープでもずれない絶対時刻）
    var isRunning: Bool
    var pausedRemainingSeconds: Int // 一時停止中の残り秒数
    var helpProcess: String = "" // 依頼工程 ("シャンプー", "コーミング", "チェック", "その他", 未指定時は "")
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
    var checkProcess: String = "チェック"
    var checkStaff: String?
    var isCheckCompleted: Bool = false
    
    static let allowedCheckProcesses: [String] = ["チェック", "コーミング", "1液2液", "担当を呼ぶ"]
    static func sanitizeCheckProcess(_ raw: String?) -> String {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return allowedCheckProcesses.contains(trimmed) ? trimmed : "チェック"
    }

    var displayCheckProcess: String {
        return Self.sanitizeCheckProcess(checkProcess)
    }
    
    var checkProcessIconName: String {
        switch displayCheckProcess {
        case "コーミング": return "comb.fill"
        case "1液2液": return "drop.fill"
        case "担当を呼ぶ": return "bell.fill"
        default: return "magnifyingglass"
        }
    }
    
    var checkProcessColorHex: String {
        switch displayCheckProcess {
        case "コーミング": return "#0A84FF"
        case "1液2液": return "#BF5AF2"
        case "担当を呼ぶ": return "#FF9F0A"
        default: return "#30D158"
        }
    }
    
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
    var isAutoFinished: Bool = false
    // ★ ウォッチ・スマホのアラーム音ON/OFF（どちらもデフォルトOFF：ウォッチの振動は常時ON）
    var watchAlarmSoundEnabled: Bool = false
    var alarmSoundEnabled: Bool = false

    init(
        id: String,
        seatNumber: Int = 0,
        seatLabel: String? = nil,
        createdBy: String? = nil,
        creatorName: String = "スタイリスト",
        isCreatorMeExplicit: Bool? = nil,
        totalSeconds: Int = 0,
        targetEndTime: Date = Date(),
        isRunning: Bool = false,
        pausedRemainingSeconds: Int = 0,
        helpProcess: String = "",
        shampooStaff: String? = nil,
        isRecruiting: Bool = false,
        isNoHelpNeeded: Bool = false,
        status: TreatmentStatus = .normal,
        checkTotalSeconds: Int? = nil,
        checkTargetEndTime: Date? = nil,
        checkProcess: String = "チェック",
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
        isCountUpEnabled: Bool = true,
        isAutoFinished: Bool = false,
        watchAlarmSoundEnabled: Bool = false,
        alarmSoundEnabled: Bool = false
    ) {
        self.id = id
        self.seatNumber = seatNumber
        self.seatLabel = seatLabel
        self.createdBy = createdBy
        self.creatorName = creatorName
        self.isCreatorMeExplicit = isCreatorMeExplicit
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
        self.checkProcess = checkProcess
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
        self.isAutoFinished = isAutoFinished
        self.watchAlarmSoundEnabled = watchAlarmSoundEnabled
        self.alarmSoundEnabled = alarmSoundEnabled
    }
    
    // 準備中カウントダウンの残り秒数
    var prepRemainingSeconds: Int {
        guard isPreCountingDown else { return 0 }
        if let end = prepEndTime {
            let diff = end.timeIntervalSince(Date())
            return max(0, safeClampedCeilSeconds(diff))
        }
        return max(0, preCountdownSeconds)
    }
    
    // 現在の残り秒数（動的計算）
    // ★ iPhone(HomeScreen)の Math.ceil((targetEndTime - now)/1000) と一致させて1秒の表示ズレを完全解消
    var remainingSeconds: Int {
        if !isRunning {
            return pausedRemainingSeconds
        }
        guard targetEndTime.timeIntervalSince1970 > 1_000_000_000 else {
            return pausedRemainingSeconds
        }
        let diff = targetEndTime.timeIntervalSince(Date())
        return diff > 0 ? safeClampedCeilSeconds(diff) : safeClampedSeconds(diff)
    }
    
    // チェックタイマー残り秒数
    var checkRemainingSeconds: Int? {
        guard !isCheckCompleted, let checkEnd = checkTargetEndTime else { return nil }
        if !isRunning { return nil }
        guard checkEnd.timeIntervalSince1970 > 1_000_000_000 else { return nil }
        let diff = checkEnd.timeIntervalSince(Date())
        return diff > 0 ? safeClampedCeilSeconds(diff) : 0
    }
    
    // チェックタイマー超過秒数（超過中は正の秒数、未超過なら0）
    var checkOvertimeSeconds: Int {
        guard isRunning, !isCheckCompleted, let checkEnd = checkTargetEndTime else { return 0 }
        guard checkEnd.timeIntervalSince1970 > 1_000_000_000 else { return 0 }
        let diff = checkEnd.timeIntervalSince(Date())
        return diff <= 0 ? abs(safeClampedSeconds(diff)) : 0
    }
    
    // チェックタイマー超過判定
    var isCheckOvertime: Bool {
        guard isRunning, !isCheckCompleted, let checkEnd = checkTargetEndTime else { return false }
        return checkEnd.timeIntervalSince(Date()) <= 0
    }
    
    // タイム超過判定（残り0秒未満、または稼働中で0秒以下）
    var isOvertime: Bool {
        return remainingSeconds < 0 || (isRunning && remainingSeconds <= 0)
    }
    
    // ★ 00:00（停止中・未稼働・リセット後）判定
    var isZero: Bool {
        return !isRunning && !isPreCountingDown && remainingSeconds <= 0
    }
    
    // ★ ヘルプ担当・チェック担当等のスタッフ名が「自分自身」かどうか判定（カスタム呼び名・別名リスト userAliases 対応＆空白正規化）
    static func isStaffMe(_ staff: String?, currentUserName: String) -> Bool {
        guard let raw = staff?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return false }
        if raw == "自分" || raw == "あなた" { return true }
        let lower = raw.lowercased()
        if raw == "ヘルプなし" || lower == "none" || raw == "未定" || raw == "募集中" { return false }
        let normalize = { (s: String) -> String in
            s.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: " ", with: "")
                .replacingOccurrences(of: "　", with: "")
                .lowercased()
        }
        let normRaw = normalize(raw)
        guard !normRaw.isEmpty else { return false }
        let cleanUser = currentUserName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleanUser.isEmpty && (raw.caseInsensitiveCompare(cleanUser) == .orderedSame || normalize(cleanUser) == normRaw) {
            return true
        }
        let aliases = WatchSessionManager.shared.currentUserAliases
        for alias in aliases {
            let cleanAlias = alias.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleanAlias.isEmpty, cleanAlias != "スタイリスト" else { continue }
            if raw.caseInsensitiveCompare(cleanAlias) == .orderedSame || normalize(cleanAlias) == normRaw {
                return true
            }
        }
        let myUid = WatchSessionManager.shared.cloudUserId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !myUid.isEmpty,
           let mappedName = WatchSessionManager.shared.memberIdMap[myUid]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !mappedName.isEmpty,
           mappedName != "スタイリスト" {
            if raw.caseInsensitiveCompare(mappedName) == .orderedSame || normalize(mappedName) == normRaw {
                return true
            }
        }
        return false
    }

    // ★ スタッフ名の画面表示用フォーマット（自分自身の場合は名前を省いて「自分」に統一）
    static func displayStaffName(_ staff: String, currentUserName: String) -> String {
        let trimmed = staff.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return staff }
        if isStaffMe(trimmed, currentUserName: currentUserName) {
            return "自分"
        }
        return trimmed
    }

    // ★ この席のタイマー作成者（主担当）が「自分自身」かどうか判定（createdBy UUID照合およびiPhone側のユーザーID照合フラグを最優先）
    func isCreatorMe(currentUserName: String) -> Bool {
        if let cb = createdBy?.trimmingCharacters(in: .whitespacesAndNewlines), !cb.isEmpty {
            let myUid = WatchSessionManager.shared.cloudUserId.trimmingCharacters(in: .whitespacesAndNewlines)
            if WatchSessionManager.isValidCloudUUID(cb) && WatchSessionManager.isValidCloudUUID(myUid) {
                return cb.caseInsensitiveCompare(myUid) == .orderedSame
            }
        }
        if let explicit = isCreatorMeExplicit {
            return explicit
        }
        let cleanCreator = creatorName.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleanCreator == "スタイリスト" {
            let sStaff = (shampooStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let cStaff = (checkStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let hasOtherShampoo = !sStaff.isEmpty && sStaff != "ヘルプなし" && sStaff.lowercased() != "none" && sStaff != "募集中" && sStaff != "未定" && !SeatTimerItem.isStaffMe(sStaff, currentUserName: currentUserName)
            let hasOtherCheck = !cStaff.isEmpty && cStaff != "ヘルプなし" && cStaff.lowercased() != "none" && cStaff != "募集中" && cStaff != "未定" && !SeatTimerItem.isStaffMe(cStaff, currentUserName: currentUserName)
            if hasOtherShampoo || hasOtherCheck {
                return false
            }
        }
        return SeatTimerItem.isStaffMe(cleanCreator, currentUserName: currentUserName)
    }

    // ★ 完全待機 00:00 空席（稼働中・事前カウントダウン・一時停止残り時間ありではなく、停止後アクティブ工程・事前募集・事前ヘルプ指定・未完了チェック予約もない席）の判定
    var isUnpreparedIdleZeroSeat: Bool {
        guard !isRunning, !isPreCountingDown, pausedRemainingSeconds <= 0, status == .normal else { return false }
        let cleanHelp = helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanHelp.isEmpty else { return false }
        guard !isRecruiting, !isNoHelpNeeded else { return false }
        let cleanAssist = (shampooStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanAssist.isEmpty || cleanAssist == "未定" else { return false }
        let cleanCheck = (checkStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let hasActiveCheck = !isCheckCompleted && (checkTargetEndTime != nil || (checkTotalSeconds ?? 0) > 0 || (!cleanCheck.isEmpty && cleanCheck != "未定"))
        return !hasActiveCheck
    }

    // ★ ヘルプ指定・チェック指定・募集操作時に主担当（createdBy / creatorName）を自ユーザーとして設定・更新してよいかの厳密判定
    //   - 既に自分が主担当である場合（createdBy == 自分、または isCreatorMeExplicit == true）は true
    //   - 完全な空の 00:00 待機席（isUnpreparedIdleZeroSeat == true）の場合は、前客の createdBy / isCreatorMeExplicit が残留していても true（次の担当者が主担当を取得可能）
    //   - 稼働中・一時停止中・停止後工程中・他人が事前設定済みの席で他スタッフの createdBy が入っている場合は、creatorName がデフォルトであっても絶対に false
    func shouldClaimOrRefreshCreatorAsMe(currentUserName: String, myUid: String = WatchSessionManager.shared.cloudUserId) -> Bool {
        let existingUid = (createdBy ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanMyUid = myUid.trimmingCharacters(in: .whitespacesAndNewlines)
        if !existingUid.isEmpty && !cleanMyUid.isEmpty && existingUid.caseInsensitiveCompare(cleanMyUid) == .orderedSame {
            return true
        }
        if isCreatorMeExplicit == true {
            return true
        }
        if isUnpreparedIdleZeroSeat {
            return true
        }
        if isCreatorMeExplicit == false || !existingUid.isEmpty {
            return false
        }
        let prevCreator = creatorName.trimmingCharacters(in: .whitespacesAndNewlines)
        return prevCreator.isEmpty || prevCreator == "スタイリスト" || prevCreator == "スタッフ" || SeatTimerItem.isStaffMe(prevCreator, currentUserName: currentUserName)
    }

    // ★ 主担当を自分として確定反映（createdBy UUID / creatorName / isCreatorMeExplicit を一括更新）
    mutating func applyCreatorAsMe(currentUserName: String, myUid: String = WatchSessionManager.shared.cloudUserId) {
        let prevCreator = creatorName.trimmingCharacters(in: .whitespacesAndNewlines)
        isCreatorMeExplicit = true
        let cleanUid = myUid.trimmingCharacters(in: .whitespacesAndNewlines)
        if WatchSessionManager.isValidCloudUUID(cleanUid) {
            createdBy = cleanUid
        }
        let cleanName = currentUserName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleanName.isEmpty {
            let keepExistingSelfConcreteName = (cleanName == "スタイリスト" || cleanName == "スタッフ")
                && !prevCreator.isEmpty
                && prevCreator != "スタイリスト"
                && prevCreator != "スタッフ"
                && SeatTimerItem.isStaffMe(prevCreator, currentUserName: cleanName)
            if !keepExistingSelfConcreteName {
                creatorName = cleanName
            }
        }
    }

    // ★ 作成者（主担当）の画面表示用フォーマット（自分自身なら「自分」、他人ならそのスタッフ名）
    func displayCreatorName(currentUserName: String, emptyFallback: String = "主担当") -> String {
        if isCreatorMe(currentUserName: currentUserName) {
            return "自分"
        }
        let trimmed = creatorName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? emptyFallback : trimmed
    }

    // ★ 仕様変更（Issue #9 & Build 116 Q1=A）: 自分に関係している席か判定
    //   （作成者/主担当 or 明示的に指名されたヘルプ担当 or 未完了のチェックタイマーが存在するチェック担当のみ。チェック完了後は主担当・全体ヘルプ担当でなければ除外）
    func isRelated(to userName: String) -> Bool {
        if isMainTimer { return true }
        if isCreatorMe(currentUserName: userName) { return true }
        let sStaff = (shampooStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !sStaff.isEmpty && sStaff != "ヘルプなし" && sStaff.lowercased() != "none" && sStaff != "募集中" && sStaff != "未定" {
            if SeatTimerItem.isStaffMe(sStaff, currentUserName: userName) { return true }
        }
        if !isCheckCompleted && (checkTargetEndTime != nil || (checkTotalSeconds ?? 0) > 0) {
            let chkStaff = (checkStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !chkStaff.isEmpty && chkStaff != "ヘルプなし" && chkStaff.lowercased() != "none" && chkStaff != "募集中" && chkStaff != "未定" {
                if SeatTimerItem.isStaffMe(chkStaff, currentUserName: userName) { return true }
            }
        }
        return false
    }

    // ★ 全体タイマー（放置タイム終了）のアラーム・通知対象か判定（関係者のみ：作成者/主担当・明示的に指名された全体ヘルプ担当のみ。「未定」時の全員鳴動は廃止）
    func shouldAlertMainTimer(for userName: String) -> Bool {
        if isMainTimer { return true }
        if isCreatorMe(currentUserName: userName) { return true }

        let sStaff = (shampooStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let sLower = sStaff.lowercased()
        if isNoHelpNeeded || sStaff.isEmpty || sStaff == "ヘルプなし" || sLower == "none" || sStaff == "募集中" || sStaff == "未定" {
            return false
        }
        return SeatTimerItem.isStaffMe(sStaff, currentUserName: userName)
    }

    // ★ 中間チェックタイマーのアラーム・通知対象か判定（関係者のみ：作成者/主担当・明示的に指名されたチェック担当のみ。「未定」時の全員鳴動は廃止）
    func shouldAlertCheckTimer(for userName: String) -> Bool {
        if isMainTimer { return false }
        if isCreatorMe(currentUserName: userName) { return true }

        let chkStaff = (checkStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let chkLower = chkStaff.lowercased()
        if chkStaff.isEmpty || chkStaff == "ヘルプなし" || chkLower == "none" || chkStaff == "募集中" || chkStaff == "未定" {
            return false
        }
        return SeatTimerItem.isStaffMe(chkStaff, currentUserName: userName)
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
        checkProcess = "チェック"
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
        
        let rawCreatedBy = ((dictionary["createdBy"] as? String) ?? (dictionary["created_by"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        self.createdBy = rawCreatedBy.isEmpty ? nil : rawCreatedBy
        self.creatorName = (dictionary["creatorName"] as? String) ?? (dictionary["colorStaffName"] as? String) ?? "スタイリスト"
        self.isCreatorMeExplicit = (dictionary["isCreatorMe"] as? NSNumber)?.boolValue ?? (dictionary["isCreatorMe"] as? Bool)
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
            self.pausedRemainingSeconds = self.isRunning ? self.totalSeconds : 0
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
        
        let rawHelpProcess = (dictionary["helpProcess"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let rawActionStatus = (dictionary["actionStatus"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !rawHelpProcess.isEmpty && rawHelpProcess != "normal" {
            self.helpProcess = rawHelpProcess
        } else if rawActionStatus == "shampoo" {
            self.helpProcess = "シャンプー"
        } else if rawActionStatus == "combing" {
            self.helpProcess = "コーミング"
        } else if rawActionStatus == "check" {
            self.helpProcess = "チェック"
        } else if rawActionStatus == "other" {
            self.helpProcess = "その他"
        } else {
            self.helpProcess = ""
        }
        let rawShampoo = (dictionary["shampooStaff"] as? String) ?? (dictionary["assistantStaffName"] as? String)
        self.shampooStaff = (rawShampoo?.isEmpty == false) ? rawShampoo : nil
        self.isRecruiting = (dictionary["isRecruiting"] as? NSNumber)?.boolValue ?? (dictionary["isRecruiting"] as? Bool) ?? false
        self.isNoHelpNeeded = (dictionary["isNoHelpNeeded"] as? NSNumber)?.boolValue ?? (dictionary["isNoHelpNeeded"] as? Bool) ?? false
        
        // 施術ステータス (normal, shampoo, combing, check)
        // ※ 稼働中（isRunning == true）の場合は相手が既に先行停止して実稼働工程に入っている場合のみ .shampoo / .combing / .check とし、
        //    通常の予約工程（actionStatus）を停止後の実稼働ステータスと混同しないよう保護する
        let actionStatus = dictionary["actionStatus"] as? String
        let statusStr = dictionary["status"] as? String
        let isShampooing = (dictionary["isShampooing"] as? NSNumber)?.boolValue ?? (dictionary["isShampooing"] as? Bool) ?? false
        let peerStoppedEndMs = (dictionary["peerStoppedTargetEndTimestamp"] as? NSNumber)?.doubleValue ?? (dictionary["peerStoppedTargetEndTimestamp"] as? Double) ?? 0
        let allowActiveStatus = !self.isRunning || isShampooing || peerStoppedEndMs > 0
        if allowActiveStatus && (isShampooing || actionStatus == "shampoo" || statusStr == "shampoo") {
            self.status = .shampoo
        } else if allowActiveStatus && (actionStatus == "combing" || statusStr == "combing") {
            self.status = .combing
        } else if allowActiveStatus && (actionStatus == "check" || statusStr == "check") {
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
        let rawCheckProcess = (dictionary["checkProcess"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.checkProcess = Self.sanitizeCheckProcess(rawCheckProcess)
        let rawCheckStaff = (dictionary["checkStaff"] as? String) ?? (dictionary["checkStaffName"] as? String)
        self.checkStaff = (rawCheckStaff?.isEmpty == false) ? rawCheckStaff : nil
        self.isCheckCompleted = (dictionary["isCheckCompleted"] as? NSNumber)?.boolValue ?? (dictionary["isCheckCompleted"] as? Bool) ?? false
        self.isCollapsed = (dictionary["isCollapsed"] as? NSNumber)?.boolValue ?? (dictionary["isCollapsed"] as? Bool) ?? false
        self.isMainTimer = (dictionary["isMainTimer"] as? NSNumber)?.boolValue ?? (dictionary["isMainTimer"] as? Bool) ?? (id == "main-timer")
        self.genre = dictionary["genre"] as? String
        if let rawLabel = dictionary["seatLabel"] as? String {
            let cleaned = rawLabel
                .replacingOccurrences(of: " (サンプル)", with: "")
                .replacingOccurrences(of: "(サンプル)", with: "")
                .replacingOccurrences(of: "（サンプル）", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            self.seatLabel = cleaned.isEmpty ? nil : cleaned
        } else {
            self.seatLabel = nil
        }
        self.isPreCountingDown = (dictionary["isPreCountingDown"] as? NSNumber)?.boolValue ?? (dictionary["isPreCountingDown"] as? Bool) ?? false
        self.preCountdownSeconds = (dictionary["preCountdownSeconds"] as? NSNumber)?.intValue ?? (dictionary["preCountdownSeconds"] as? Int) ?? 0
        self.isCountdownConfigEnabled = (dictionary["isCountdownConfigEnabled"] as? NSNumber)?.boolValue ?? (dictionary["isCountdownConfigEnabled"] as? Bool) ?? false
        self.countdownConfigSeconds = (dictionary["countdownConfigSeconds"] as? NSNumber)?.intValue ?? (dictionary["countdownConfigSeconds"] as? Int) ?? 5
        let savedCountUp = (UserDefaults.standard.object(forKey: "assisttimer.watch.isCountUpEnabled") as? Bool) ?? true
        let parsedCountUp = (dictionary["isCountUpEnabled"] as? NSNumber)?.boolValue ?? (dictionary["isCountUpEnabled"] as? Bool)
        self.isCountUpEnabled = parsedCountUp ?? (self.isMainTimer ? savedCountUp : true)
        self.isAutoFinished = (dictionary["isAutoFinished"] as? NSNumber)?.boolValue ?? (dictionary["isAutoFinished"] as? Bool) ?? false
        if let explicitCountUp = parsedCountUp, self.isMainTimer {
            UserDefaults.standard.set(explicitCountUp, forKey: "assisttimer.watch.isCountUpEnabled")
            UserDefaults(suiteName: "group.com.assisttimer")?.set(explicitCountUp, forKey: "assisttimer.watch.isCountUpEnabled")
        }
        let savedMainWatchSound = (UserDefaults.standard.object(forKey: "assisttimer.mainTimerWatchSound.v2") as? Bool) ?? false
        let parsedWatchSound = (dictionary["watchAlarmSoundEnabled"] as? NSNumber)?.boolValue ?? (dictionary["watchAlarmSoundEnabled"] as? Bool)
        self.watchAlarmSoundEnabled = parsedWatchSound ?? (self.isMainTimer ? savedMainWatchSound : false)
        self.alarmSoundEnabled = (dictionary["alarmSoundEnabled"] as? NSNumber)?.boolValue ?? (dictionary["alarmSoundEnabled"] as? Bool) ?? false
        if let prepEndMs = (dictionary["prepEndTimestamp"] as? NSNumber)?.doubleValue ?? (dictionary["prepEndTimestamp"] as? Double), prepEndMs > 0 {
            self.prepEndTime = Date(timeIntervalSince1970: prepEndMs / 1000.0)
        } else {
            self.prepEndTime = nil
        }
        self.hasAlertedHelpUnassigned = (dictionary["hasAlertedHelpUnassigned"] as? NSNumber)?.boolValue ?? (dictionary["hasAlertedHelpUnassigned"] as? Bool) ?? false
        
        // ★ 00:00席またはアコーディオン収納席はヘルプ・助手を完全クリア（固定残り防止。ただしシャンプー中等の進行中ステータスがある停止席は担当表示を保持）
        if !self.isRunning && (self.pausedRemainingSeconds <= 0 || self.isCollapsed) {
            if self.status == .normal {
                self.helpProcess = ""
                self.shampooStaff = nil
            }
            self.isRecruiting = false
            self.isNoHelpNeeded = false
            self.hasAlertedHelpUnassigned = false
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
            "isCountUpEnabled": isCountUpEnabled,
            "isAutoFinished": isAutoFinished,
            "watchAlarmSoundEnabled": watchAlarmSoundEnabled,
            "alarmSoundEnabled": alarmSoundEnabled,
            "hasAlertedHelpUnassigned": hasAlertedHelpUnassigned
        ]
        if let createdBy = createdBy, !createdBy.isEmpty { dict["createdBy"] = createdBy }
        if let isCreatorMeExplicit = isCreatorMeExplicit { dict["isCreatorMe"] = isCreatorMeExplicit }
        if let seatLabel = seatLabel { dict["seatLabel"] = seatLabel }
        if let shampooStaff = shampooStaff { dict["shampooStaff"] = shampooStaff }
        if let checkTotalSeconds = checkTotalSeconds { dict["checkTotalSeconds"] = checkTotalSeconds }
        if let checkTargetEndTime = checkTargetEndTime { dict["checkEndTimestamp"] = checkTargetEndTime.timeIntervalSince1970 * 1000.0 }
        dict["checkProcess"] = displayCheckProcess
        if let checkStaff = checkStaff { dict["checkStaff"] = checkStaff }
        if let genre = genre { dict["genre"] = genre }
        if let prepEndTime = prepEndTime { dict["prepEndTimestamp"] = prepEndTime.timeIntervalSince1970 * 1000.0 }
        return dict
    }
}

import WatchConnectivity

// MARK: - タップして確認するまで消えない共有通知アイテム（時刻・席名・担当者・工程・タップ遷移用メタ情報）
struct PeerConfirmationAlertItem: Identifiable, Equatable, Codable {
    let id: String
    let timeText: String
    let text: String
    let colorHex: String
    let createdAt: TimeInterval
    var eventType: String = ""
    var seatId: String = ""
    var seatNumber: Int = 0
    var seatLabel: String = ""
    var semanticKey: String = ""

    init(
        id: String,
        timeText: String,
        text: String,
        colorHex: String,
        createdAt: TimeInterval,
        eventType: String = "",
        seatId: String = "",
        seatNumber: Int = 0,
        seatLabel: String = "",
        semanticKey: String = ""
    ) {
        self.id = id
        self.timeText = timeText
        self.text = text
        self.colorHex = colorHex
        self.createdAt = createdAt
        self.eventType = eventType
        self.seatId = seatId
        self.seatNumber = seatNumber
        self.seatLabel = seatLabel
        self.semanticKey = semanticKey
    }

    enum CodingKeys: String, CodingKey {
        case id, timeText, text, colorHex, createdAt, eventType, seatId, seatNumber, seatLabel, semanticKey
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.timeText = try c.decode(String.self, forKey: .timeText)
        self.text = try c.decode(String.self, forKey: .text)
        self.colorHex = try c.decode(String.self, forKey: .colorHex)
        self.createdAt = try c.decode(TimeInterval.self, forKey: .createdAt)
        self.eventType = try c.decodeIfPresent(String.self, forKey: .eventType) ?? ""
        self.seatId = try c.decodeIfPresent(String.self, forKey: .seatId) ?? ""
        self.seatNumber = try c.decodeIfPresent(Int.self, forKey: .seatNumber) ?? 0
        self.seatLabel = try c.decodeIfPresent(String.self, forKey: .seatLabel) ?? ""
        self.semanticKey = try c.decodeIfPresent(String.self, forKey: .semanticKey) ?? ""
    }
}

// MARK: - iPhone (WCSession) 通信マネージャー
class WatchSessionManager: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchSessionManager()
    private let appGroupDefaults = UserDefaults(suiteName: "group.com.assisttimer")
    private let savedTimersKey = "assisttimer.watch.savedTimers.v1"
    private let savedMainTimerKey = "assisttimer.watch.savedMainTimer.v1"
    private let savedUserNameKey = "assisttimer.watch.savedUserName.v1"
    private let savedWatchMainEndKey = "assisttimer.watch.watchStartedMainEnd.v1"
    private let savedWatchSeatStartsKey = "assisttimer.watch.watchStartedSeats.v1"
    private let savedLastBuildVersionKey = "assisttimer.watch.lastBuildVersion.v1"
    private let savedLastPayloadTsKey = "assisttimer.watch.lastPayloadTimestamp.v1"
    private let savedUnconfirmedPeerAlertsKey = "assisttimer.watch.unconfirmedPeerAlerts.v1"
    private let savedMemberIdMapKey = "assisttimer.watch.memberIdMap.v1"
    private let savedUserAliasesKey = "assisttimer.watch.userAliases.v1"

    @Published var timers: [SeatTimerItem] = [
        SeatTimerItem(
            id: "seat-1",
            seatNumber: 1,
            seatLabel: "1番席",
            creatorName: "スタイリスト",
            totalSeconds: 0,
            targetEndTime: Date(),
            isRunning: false,
            pausedRemainingSeconds: 0,
            status: .normal,
            isCollapsed: true
        )
    ] {
        didSet {
            let raw = timers.map { $0.toDictionary() }
            UserDefaults.standard.set(raw, forKey: savedTimersKey)
            appGroupDefaults?.set(raw, forKey: savedTimersKey)
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
        pausedRemainingSeconds: 0,
        isMainTimer: true,
        isCountUpEnabled: (UserDefaults.standard.object(forKey: "assisttimer.watch.isCountUpEnabled") as? Bool) ?? true
    ) {
        didSet {
            if let m = mainTimer {
                let dict = m.toDictionary()
                UserDefaults.standard.set(dict, forKey: savedMainTimerKey)
                appGroupDefaults?.set(dict, forKey: savedMainTimerKey)
            } else {
                UserDefaults.standard.removeObject(forKey: savedMainTimerKey)
                appGroupDefaults?.removeObject(forKey: savedMainTimerKey)
            }
        }
    }
    @Published var members: [String] = []
    var memberIdMap: [String: String] = [:]
    @Published var currentUserName: String = "スタイリスト" {
        didSet {
            if !currentUserName.isEmpty {
                UserDefaults.standard.set(currentUserName, forKey: savedUserNameKey)
                appGroupDefaults?.set(currentUserName, forKey: savedUserNameKey)
            }
        }
    }
    @Published var currentUserAliases: [String] = [] {
        didSet {
            UserDefaults.standard.set(currentUserAliases, forKey: savedUserAliasesKey)
            appGroupDefaults?.set(currentUserAliases, forKey: savedUserAliasesKey)
        }
    }
    // ★ 相手からのリアルタイム操作通知（タイマー停止、チェック完了、シャンプー開始、担当解除等）
    @Published var incomingNotification: (text: String, color: String, eventType: String)? = nil
    // ★ 誰かがタップして確認するまで消えない共有通知キュー
    @Published var unconfirmedPeerAlerts: [PeerConfirmationAlertItem] = []
    private var recentEnqueuedPeerBodies: [(body: String, seatNumber: Int?, kind: String, semanticKey: String, at: TimeInterval)] = []
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
    
    // ★ Watch 側アラーム音（未設定時はデフォルト false = OFF）
    @Published var alarmSoundEnabled: Bool = (UserDefaults.standard.object(forKey: "assisttimer.watchAlarmSound.v2") as? Bool) ?? false
    // ★ 招待元（オーナー）サロンかどうか（参加者ゲストの場合は false となり、Watchからの新規席追加をロック）
    private let savedIsSalonOwnerKey = "assisttimer.watch.isSalonOwner.v1"
    @Published var isSalonOwner: Bool = (UserDefaults.standard.object(forKey: "assisttimer.watch.isSalonOwner.v1") as? Bool)
        ?? (UserDefaults(suiteName: "group.com.assisttimer")?.object(forKey: "assisttimer.watch.isSalonOwner.v1") as? Bool)
        ?? true {
        didSet {
            UserDefaults.standard.set(isSalonOwner, forKey: savedIsSalonOwnerKey)
            appGroupDefaults?.set(isSalonOwner, forKey: savedIsSalonOwnerKey)
        }
    }

    // ★ ペアリング中のiPhoneがロック・休止中でもWatchから直接Supabaseクラウドへ停止・状態変更を即時反映＆クラウド最新状態を直接補完ポーリングするためのサロン識別情報
    private let savedCloudSalonIdKey = "assisttimer.watch.cloudSalonId.v1"
    private let savedCloudUserIdKey = "assisttimer.watch.cloudUserId.v1"
    private(set) var cloudSalonId: String = "" {
        didSet {
            UserDefaults.standard.set(cloudSalonId, forKey: savedCloudSalonIdKey)
            appGroupDefaults?.set(cloudSalonId, forKey: savedCloudSalonIdKey)
        }
    }
    private(set) var cloudUserId: String = "" {
        didSet {
            UserDefaults.standard.set(cloudUserId, forKey: savedCloudUserIdKey)
            appGroupDefaults?.set(cloudUserId, forKey: savedCloudUserIdKey)
        }
    }
    // ★ コールド起動後に一度でも iPhone からの権威ある SYNC_SEATS、直接クラウドポーリング、または自機ローカル操作が行われたかを示すフラグ
    //   （WidgetSync の 15秒逆上書き防止ガードを「コールド起動直後の未同期 00:00 初期メモリ」のみに限定し、リモート停止・担当解除の即時反映をブロックしない）
    private(set) var hasReceivedAuthoritativeSyncInSession: Bool = false
    private var lastDirectCloudPollAt: Date = .distantPast
    private(set) var isDirectCloudPollInFlight: Bool = false
    // ★ TestFlightビルド更新初回起動時刻（この時刻以前に終了時刻を迎えていた古い超過タイマーがiPhoneキャッシュやクラウドから1秒後に遅れて届いても復活させない）
    private var buildUpdateExpiryCutoff: Date? = nil
    private static let supabaseRestBaseURL = "https://hcmjcwcmvcwicjmnhtdc.supabase.co/rest/v1"
    private static let supabaseAnonKey = "sb_publishable_MWb3aHCk_XtQthwbw3be3g_bjObUVeq"
    // ★ Supabase の salon_timers テーブルに updated_by カラムが未追加の環境で 400 Bad Request になった場合、
    //   iPhone 側（salonCloudService.js）と同様に updated_by を除外して自動リトライ＆以降は除外維持するフラグ
    private static var updatedByColumnUnsupported: Bool = false

    private static let iso8601FractionalFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let iso8601BasicFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static func parseCloudISODate(_ raw: Any?) -> Date? {
        guard let str = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !str.isEmpty else {
            return nil
        }
        if let d = iso8601FractionalFormatter.date(from: str) {
            return d
        }
        return iso8601BasicFormatter.date(from: str)
    }
    
    // ★ 有効化前に行われた操作の保留キュー（有効化完了時に自動送信。メインスレッドでのみ操作）
    private var pendingPayloads: [[String: Any]] = []
    
    // ★ 受信済みの最新データの作成時刻（iPhone の Date.now()、ミリ秒）。
    //   即時メッセージと保存データ（applicationContext）は届く順番が前後することがあるため、永続化してコールド起動時も古いデータで上書きしない
    private var lastPayloadTimestamp: Double = 0 {
        didSet {
            if lastPayloadTimestamp > 0 {
                UserDefaults.standard.set(lastPayloadTimestamp, forKey: savedLastPayloadTsKey)
                appGroupDefaults?.set(lastPayloadTimestamp, forKey: savedLastPayloadTsKey)
            }
        }
    }
    private var lastHandledPeerNotifId: String = ""
    private var handledPeerNotifIds: [String] = []
    private let savedHandledPeerNotifIdsKey = "assisttimer.watch.handledPeerNotifIds.v1"
    // ★ A-3 / Round2: semanticKey（timerId|eventType|actorId|stateDisc）による45秒重複排除マップ（WCSession / 直接クラウドポーリング別管理＋ロール系状態遷移での旧キー即時無効化）
    private let semanticKeyLock = NSLock()
    private var handledWCSessionSemanticKeys: [String: TimeInterval] = [:]
    private var handledDirectPollSemanticKeys: [String: TimeInterval] = [:]
    private var handledWildcardWCSessionSemanticKeys: [String: TimeInterval] = [:]
    private var handledWildcardDirectPollSemanticKeys: [String: TimeInterval] = [:]
    var isModalSheetCurrentlyPresented: Bool = false
    
    // ★ Watch または iPhone で止めた席（古い「稼働中」スナップショットや applicationContext で超過・稼働へゾンビ復活しないよう4時間保持＆永続化）
    private var localStops: [String: (at: Date, end: Double)] = [:]
    private let localStopHoldSeconds: TimeInterval = 14400
    private let savedLocalStopsKey = "assisttimer.watch.localStops.v1"
    // ★ 他スタッフがクラウド上で停止・シャンプー移行した際、関係者である自分のWatchでタイマー継続しつつ同一停止への8秒ごと再通知ループやクラウド状態上書きを防ぐ記録
    private var peerStoppedSeatEnds: [String: Double] = [:]
    private let savedPeerStoppedSeatsKey = "assisttimer.watch.peerStoppedSeatEnds.v1"
    // ★ ピア停止後に自分が「確認」またはアラーム停止して完了させた終了時刻（WidgetKit や遅着 SYNC_SEATS での3時間超過ゾンビ復活を完全防止）
    private var confirmedPeerStoppedSeatEnds: [String: Double] = [:]
    private let savedConfirmedPeerStoppedSeatsKey = "assisttimer.watch.confirmedPeerStoppedEnds.v1"
    // ★ acknowledgeSeatTimer や applyLocalStop で peerStoppedSeatEnds がクリアされた直後（15秒以内）に続く STOP_ALARM / STOP_TIMER 送信でも wasPeerStopped を確実に維持するキャッシュ
    private var recentlyClearedPeerStoppedAt: [String: Date] = [:]
    private let savedMainStopActionTimeKey = "assisttimer.watch.mainStopActionTime.v1"
    private let savedMainStopActionTypeKey = "assisttimer.watch.mainStopActionType.v1"
    private let savedMainStopEndTimeKey = "assisttimer.watch.mainStopEndTime.v1"
    
    // ★ Watch で完了・解除したチェックタイマー（すれ違い通信の古いデータでチェックタイマーが復活し、残りの全体タイマー予約を邪魔するのを防止）
    private var localCheckClears: [String: (at: Date, checkEnd: Double)] = [:]
    private let localCheckClearHoldSeconds: TimeInterval = 60
    
    // ★ Watch で直近に行われた客席操作（ヘルプ募集・担当指名・時間微調整など）が、iPhoneからのすれ違い SYNC_SEATS やクラウド遅延ポーリングで巻き戻されるのを防ぐ保護
    private var localActionGeneration: Int = 0
    private var localSeatMods: [String: Date] = [:]
    private let localSeatModHoldSeconds: TimeInterval = 12.0
    private var watchStartedSeatTimes: [String: Date] = [:]
    private let watchStartedSeatHoldSeconds: TimeInterval = 180.0
    private let watchStartedSeatPersistSeconds: TimeInterval = 10800.0
    private var lastWatchSeatRePushAt: Date = .distantPast
    private var notifiedDirectCloudEventKeys: [String] = []
    private let savedNotifiedDirectCloudEventKeysKey = "assisttimer.watch.notifiedDirectCloudEventKeys.v1"
    
    // ★ Watch 上で収納（計測終了）・展開（スリムバーをタップ）した席。停止中は iPhone の値より優先し、
    //   席が稼働したら消す（同期のたびにカードが勝手に開閉しないようにする）
    private var collapseOverrides: [String: Bool] = [:]
    
    // ★ メインタイマーの直近ローカル操作＆停止保護（Watch/iPhoneで停止後、古い保存データによる巻き戻し・ゾンビ復活を4時間完全ブロック）
    private var lastMainTimerLocalActionTime: Date = Date.distantPast
    private var lastMainTimerLocalActionType: String = "" // "RESET", "PAUSE", "START", "SET_TIME", "ADJUST"
    private(set) var lastMainTimerLocalStopEndTime: Double = 0
    private let mainTimerLocalHoldSeconds: TimeInterval = 15.0
    private let mainTimerStopHoldSeconds: TimeInterval = 14400.0
    // ★ Watch 主導で開始し現在カウントダウン稼働中のメインタイマー終了予定時刻（iPhone スリープ中や SYNC_SEATS 同梱の未開始データによる強制停止を防止）
    private var watchStartedMainTimerEndTime: Date? = nil {
        didSet {
            if let end = watchStartedMainTimerEndTime {
                let epoch = end.timeIntervalSince1970
                UserDefaults.standard.set(epoch, forKey: savedWatchMainEndKey)
                appGroupDefaults?.set(epoch, forKey: savedWatchMainEndKey)
            } else {
                UserDefaults.standard.removeObject(forKey: savedWatchMainEndKey)
                appGroupDefaults?.removeObject(forKey: savedWatchMainEndKey)
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
        appGroupDefaults?.set(dict, forKey: savedLocalStopsKey)
    }

    private func persistPeerStoppedSeats() {
        let cutoffEpoch = Date().addingTimeInterval(-10800).timeIntervalSince1970
        var dict: [String: Double] = [:]
        for (k, endEpoch) in peerStoppedSeatEnds where endEpoch > cutoffEpoch {
            dict[k] = endEpoch
        }
        peerStoppedSeatEnds = dict
        UserDefaults.standard.set(dict, forKey: savedPeerStoppedSeatsKey)
        appGroupDefaults?.set(dict, forKey: savedPeerStoppedSeatsKey)
    }

    private func persistConfirmedPeerStoppedSeats() {
        let cutoffEpoch = Date().addingTimeInterval(-14400).timeIntervalSince1970
        var dict: [String: Double] = [:]
        for (k, endEpoch) in confirmedPeerStoppedSeatEnds where endEpoch > cutoffEpoch {
            dict[k] = endEpoch
        }
        confirmedPeerStoppedSeatEnds = dict
        UserDefaults.standard.set(dict, forKey: savedConfirmedPeerStoppedSeatsKey)
        appGroupDefaults?.set(dict, forKey: savedConfirmedPeerStoppedSeatsKey)
    }

    func markPeerStoppedSeat(seatId: String, seatNumber: Int = 0, endTimeEpoch: Double) {
        guard endTimeEpoch > 0 else { return }
        var keys = Set<String>(allSeatKeys(for: seatId, seatNumber: seatNumber))
        if seatNumber > 0 {
            keys.insert("seat-\(seatNumber)")
        }
        let now = Date()
        for key in keys {
            if let confirmedEnd = confirmedPeerStoppedSeatEnds[key], confirmedEnd > 0, abs(confirmedEnd - endTimeEpoch) <= 15.0 {
                return
            }
            if let stop = localStops[key], now.timeIntervalSince(stop.at) < localStopHoldSeconds, stop.end > 0, abs(stop.end - endTimeEpoch) <= 15.0 {
                return
            }
        }
        for key in keys where !key.isEmpty {
            peerStoppedSeatEnds[key] = endTimeEpoch
        }
        persistPeerStoppedSeats()
    }

    func clearPeerStoppedSeat(seatId: String, seatNumber: Int = 0, recordRecentClear: Bool = true, confirmedEndEpoch: Double = 0) {
        var keys = Set<String>(allSeatKeys(for: seatId, seatNumber: seatNumber))
        if seatNumber > 0 {
            keys.insert("seat-\(seatNumber)")
        }
        var changed = false
        var maxRemovedEnd: Double = confirmedEndEpoch
        let now = Date()
        for key in keys {
            if let prevEnd = peerStoppedSeatEnds.removeValue(forKey: key) {
                changed = true
                if prevEnd > maxRemovedEnd {
                    maxRemovedEnd = prevEnd
                }
            }
            if !recordRecentClear {
                recentlyClearedPeerStoppedAt[key] = nil
            }
        }
        if recordRecentClear && maxRemovedEnd > 0 {
            var didRecordConfirmed = false
            for key in keys where !key.isEmpty {
                if confirmedPeerStoppedSeatEnds[key] != maxRemovedEnd {
                    confirmedPeerStoppedSeatEnds[key] = maxRemovedEnd
                    didRecordConfirmed = true
                }
            }
            if didRecordConfirmed {
                persistConfirmedPeerStoppedSeats()
            }
        }
        if changed {
            if recordRecentClear {
                for key in keys where !key.isEmpty {
                    recentlyClearedPeerStoppedAt[key] = now
                }
            }
            persistPeerStoppedSeats()
        }
    }

    func isPeerStoppedSeat(seatId: String, seatNumber: Int = 0, endTimeEpoch: Double = 0) -> Bool {
        var keys = Set<String>(allSeatKeys(for: seatId, seatNumber: seatNumber))
        if seatNumber > 0 {
            keys.insert("seat-\(seatNumber)")
        }
        for key in keys {
            if let recordedEnd = peerStoppedSeatEnds[key], recordedEnd > 0 {
                if endTimeEpoch <= 0 || abs(recordedEnd - endTimeEpoch) <= 15.0 {
                    return true
                }
            }
        }
        return false
    }

    func wasRecentlyOrCurrentlyPeerStoppedSeat(seatId: String, seatNumber: Int? = nil, targetEndTime: Date? = nil) -> Bool {
        let sNum = seatNumber ?? 0
        let endEpoch = targetEndTime?.timeIntervalSince1970 ?? 0
        if isPeerStoppedSeat(seatId: seatId, seatNumber: sNum, endTimeEpoch: endEpoch) {
            return true
        }
        var keys = Set<String>(allSeatKeys(for: seatId, seatNumber: sNum))
        if sNum > 0 {
            keys.insert("seat-\(sNum)")
        }
        let now = Date()
        for key in keys {
            if let clearedAt = recentlyClearedPeerStoppedAt[key], now.timeIntervalSince(clearedAt) < 15.0 {
                return true
            }
        }
        return false
    }

    func advanceMainTimerPreCountdownIfNeeded(now: Date = Date()) {
        guard var m = self.mainTimer, m.isPreCountingDown, let prepEnd = m.prepEndTime, prepEnd <= now else { return }
        m.isPreCountingDown = false
        m.preCountdownSeconds = 0
        m.prepEndTime = nil
        m.isRunning = true
        let runSec = m.pausedRemainingSeconds > 0 ? m.pausedRemainingSeconds : m.totalSeconds
        m.targetEndTime = prepEnd.addingTimeInterval(TimeInterval(runSec))
        self.mainTimer = m
        WidgetSync.save(timers: self.timers, mainTimer: m, userName: self.currentUserName, forceReload: true)
        WatchAlarmCoordinator.shared.update(
            timers: self.timers,
            mainTimer: m,
            soundOn: self.alarmSoundEnabled,
            currentUserName: self.currentUserName
        )
    }

    private func persistWatchStartedSeats() {
        let now = Date()
        var dict: [String: Double] = [:]
        for (k, v) in watchStartedSeatTimes where now.timeIntervalSince(v) < watchStartedSeatPersistSeconds {
            dict[k] = v.timeIntervalSince1970
        }
        UserDefaults.standard.set(dict, forKey: savedWatchSeatStartsKey)
        appGroupDefaults?.set(dict, forKey: savedWatchSeatStartsKey)
    }
    
    private func persistMainTimerStopState() {
        let actEpoch = lastMainTimerLocalActionTime.timeIntervalSince1970
        UserDefaults.standard.set(actEpoch, forKey: savedMainStopActionTimeKey)
        UserDefaults.standard.set(lastMainTimerLocalActionType, forKey: savedMainStopActionTypeKey)
        UserDefaults.standard.set(lastMainTimerLocalStopEndTime, forKey: savedMainStopEndTimeKey)
        appGroupDefaults?.set(actEpoch, forKey: savedMainStopActionTimeKey)
        appGroupDefaults?.set(lastMainTimerLocalActionType, forKey: savedMainStopActionTypeKey)
        appGroupDefaults?.set(lastMainTimerLocalStopEndTime, forKey: savedMainStopEndTimeKey)
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

    // ★ システムのスマートアラーム画面で「開く」が押された際、直前の超過カウントアップ状態を復元する
    func restoreMainTimerForOpenedAlarm(_ item: SeatTimerItem) {
        self.lastMainTimerLocalActionTime = .distantPast
        self.lastMainTimerLocalActionType = ""
        self.lastMainTimerLocalStopEndTime = 0
        var restored = item
        restored.isRunning = true
        restored.isPreCountingDown = false
        self.watchStartedMainTimerEndTime = restored.targetEndTime
        self.persistMainTimerStopState()
        self.mainTimer = restored
    }

    func restoreSeatTimerForOpenedAlarm(_ item: SeatTimerItem, wasPeerStopped: Bool = false) {
        self.clearLocalStop(seatId: item.id)
        self.clearLocalStop(seatId: "seat-\(item.seatNumber)")
        let matchedIdx = self.timers.firstIndex(where: { $0.id == item.id })
            ?? self.timers.firstIndex(where: { $0.seatNumber == item.seatNumber })
        if let idx = matchedIdx {
            let currentId = self.timers[idx].id
            self.clearLocalStop(seatId: currentId)
            var restored = item
            restored.id = currentId
            restored.isRunning = true
            restored.isCollapsed = false
            self.timers[idx] = restored
            if wasPeerStopped {
                self.markPeerStoppedSeat(
                    seatId: currentId,
                    seatNumber: restored.seatNumber,
                    endTimeEpoch: restored.targetEndTime.timeIntervalSince1970
                )
            }
        }
    }

    private static let peerAlertTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    private func persistUnconfirmedPeerAlerts() {
        if let data = try? JSONEncoder().encode(self.unconfirmedPeerAlerts) {
            UserDefaults.standard.set(data, forKey: savedUnconfirmedPeerAlertsKey)
            appGroupDefaults?.set(data, forKey: savedUnconfirmedPeerAlertsKey)
        }
    }

    static func stripLeadingBracketTime(_ text: String) -> (extractedTime: String?, body: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("【"),
              let closeIdx = trimmed.firstIndex(of: "】") else {
            return (nil, trimmed)
        }
        let inside = String(trimmed[trimmed.index(after: trimmed.startIndex)..<closeIdx]).trimmingCharacters(in: .whitespacesAndNewlines)
        if inside.contains(":") && inside.count <= 5 {
            let after = String(trimmed[trimmed.index(after: closeIdx)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            return (inside, after)
        }
        return (nil, trimmed)
    }

    static func extractPeerAlertSeatAndKind(_ cleanBody: String, id: String = "") -> (seatNumber: Int?, kind: String) {
        var seatNum: Int? = nil
        if let banRange = cleanBody.range(of: "番") {
            let prefixBeforeBan = cleanBody[..<banRange.lowerBound]
            var digitChars: [Character] = []
            for ch in prefixBeforeBan.reversed() {
                if ch.isNumber, ch.wholeNumberValue != nil {
                    digitChars.append(ch)
                } else {
                    break
                }
            }
            if !digitChars.isEmpty {
                let numStr = String(digitChars.reversed())
                if let n = Int(numStr), n > 0 {
                    seatNum = n
                }
            }
        }
        if seatNum == nil, let seatTagRange = id.range(of: "seat-") {
            let afterTag = id[seatTagRange.upperBound...]
            let digits = afterTag.prefix(while: { $0.isNumber })
            if let n = Int(digits), n > 0 {
                seatNum = n
            }
        }
        let kind: String
        if cleanBody.contains("担当から外れ") || cleanBody.contains("担当が解除") || cleanBody.contains("担当を変更しました") || id.contains("unassign") {
            if cleanBody.contains("チェック") || cleanBody.contains("1液2液") || cleanBody.contains("担当を呼ぶ") || id.contains("unassign_check") {
                kind = "unassign_check"
            } else {
                kind = "unassign_assist"
            }
        } else if cleanBody.contains("募集中") || cleanBody.contains("募集しています") || cleanBody.contains("📢") || id.contains("recruit") {
            if cleanBody.contains("チェック") || cleanBody.contains("1液2液") || cleanBody.contains("担当を呼ぶ") || id.contains("recruit_check") || id.contains("check_recruit") {
                kind = "recruit_check"
            } else {
                kind = "recruit"
            }
        } else if (cleanBody.contains("指定されました") || cleanBody.contains("指定しました") || cleanBody.contains("指名") || cleanBody.contains("設定しました") || cleanBody.contains("頼まれました") || id.contains("assign")) {
            if cleanBody.contains("チェック") || cleanBody.contains("1液2液") || cleanBody.contains("担当を呼ぶ") || id.contains("assign_check") {
                kind = "assign_check"
            } else {
                kind = "assign_assist"
            }
        } else if cleanBody.contains("完了") || cleanBody.contains("✓") || id.contains("cloud_chk_") || id.contains("check_done") || id.contains("check_complete") {
            kind = "check_done"
        } else if cleanBody.contains("止めました") || cleanBody.contains("停止されました") || cleanBody.contains("終了しました") || cleanBody.contains("リセット") || cleanBody.contains("⏹") || id.contains("cloud_stop_") || id.contains("cloud_sec_stop_") || id.contains("poll_sec_stop_") || id.contains("poll_stop_") || id.contains("timer_stop") {
            kind = "stop"
        } else if cleanBody.contains("シャンプー") || id.contains("shampoo") {
            kind = "shampoo"
        } else if cleanBody.contains("コーミング") || id.contains("combing") {
            kind = "combing"
        } else if cleanBody.contains("入りました") || id.contains("cloud_stop_proc_") || id.contains("cloud_stopped_proc_") || id.contains("poll_status_") {
            if cleanBody.contains("チェック") {
                kind = "check"
            } else {
                kind = "help_enter"
            }
        } else if cleanBody.contains("残り時間が変更") || cleanBody.contains("延長しました") || cleanBody.contains("短縮しました") || cleanBody.contains("時間を変更") || id.contains("cloud_adjust_") || id.contains("time_adjust") {
            kind = "time_adjust"
        } else if cleanBody.contains("チェック") {
            kind = "check"
        } else if cleanBody.contains("開始されました") || cleanBody.contains("開始しました") || cleanBody.contains("スタート") || (cleanBody.contains("セット") && !cleanBody.contains("リセット")) || id.contains("cloud_start_") || id.contains("timer_start") {
            kind = "timer_start"
        } else {
            kind = "other"
        }
        return (seatNum, kind)
    }

    static func normalizePeerEventKind(_ raw: String, fallback: String = "other") -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return fallback }
        switch trimmed {
        case "timer_stop", "stop":
            return "stop"
        case "shampoo_start", "shampoo", "シャンプー中", "シャンプー":
            return "shampoo"
        case "combing_start", "combing", "コーミング中", "コーミング":
            return "combing"
        case "check_start", "check", "チェック中":
            return "check"
        case "check_complete", "check_done":
            return "check_done"
        case "check_recruit", "recruit_check":
            return "recruit_check"
        case "recruit_help":
            return "recruit"
        case "recruit":
            return fallback == "recruit_check" ? "recruit_check" : "recruit"
        case "assign_assist", "assign_check", "unassign_assist", "unassign_check", "timer_start", "time_adjust", "add_check", "help_enter":
            return trimmed
        default:
            return fallback != "other" ? fallback : trimmed
        }
    }

    func markDirectCloudEventNotifiedIfNeeded(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if self.notifiedDirectCloudEventKeys.contains(trimmed) {
            return false
        }
        self.notifiedDirectCloudEventKeys.append(trimmed)
        if self.notifiedDirectCloudEventKeys.count > 120 {
            self.notifiedDirectCloudEventKeys.removeFirst(self.notifiedDirectCloudEventKeys.count - 120)
        }
        UserDefaults.standard.set(self.notifiedDirectCloudEventKeys, forKey: savedNotifiedDirectCloudEventKeysKey)
        appGroupDefaults?.set(self.notifiedDirectCloudEventKeys, forKey: savedNotifiedDirectCloudEventKeysKey)
        return true
    }

    func releaseDirectCloudEventKey(_ key: String) {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if let idx = self.notifiedDirectCloudEventKeys.firstIndex(of: trimmed) {
            self.notifiedDirectCloudEventKeys.remove(at: idx)
            UserDefaults.standard.set(self.notifiedDirectCloudEventKeys, forKey: savedNotifiedDirectCloudEventKeysKey)
            appGroupDefaults?.set(self.notifiedDirectCloudEventKeys, forKey: savedNotifiedDirectCloudEventKeysKey)
        }
    }

    func releaseDirectCloudEventKeysMatchingPrefixes(_ prefixes: [String]) {
        let validPrefixes = prefixes.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !validPrefixes.isEmpty else { return }
        let beforeCount = self.notifiedDirectCloudEventKeys.count
        self.notifiedDirectCloudEventKeys.removeAll { existing in
            validPrefixes.contains { existing.hasPrefix($0) }
        }
        if self.notifiedDirectCloudEventKeys.count != beforeCount {
            UserDefaults.standard.set(self.notifiedDirectCloudEventKeys, forKey: savedNotifiedDirectCloudEventKeysKey)
            appGroupDefaults?.set(self.notifiedDirectCloudEventKeys, forKey: savedNotifiedDirectCloudEventKeysKey)
        }
    }

    // ★ イベント種別をロール系（"assist" | "recruit" | "check" | "timer" | ""）へ分類（iPhone JS `getPeerEventRoleFamily` と完全一致）
    static func peerEventRoleFamily(_ eventType: String) -> String {
        let ev = normalizeSemanticToken(eventType)
        switch ev {
        case "assign_assist", "unassign_assist":
            return "assist"
        case "recruit":
            return "recruit"
        case "assign_check", "unassign_check", "recruit_check", "add_check", "check_done":
            return "check"
        case "timer_start", "time_adjust", "stop", "status_change", "shampoo", "combing", "check", "help_enter", "assign_main":
            return "timer"
        default:
            return ""
        }
    }

    static func parsePeerSemanticKeyParts(_ rawKey: String) -> (target: String, ev: String, actor: String, disc: String, roleFamily: String)? {
        let raw = rawKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !raw.isEmpty else { return nil }
        let parts = raw.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2 else { return nil }
        let target = parts[0]
        let ev = parts[1]
        guard !target.isEmpty, !ev.isEmpty else { return nil }
        let actor = parts.count >= 3 ? parts[2] : ""
        let disc = parts.count >= 4 ? parts[3...].joined(separator: "|") : ""
        return (target: target, ev: ev, actor: actor, disc: disc, roleFamily: peerEventRoleFamily(ev))
    }

    // ★ 2つの semanticKey が同一席上の「同じイベント状態（同一 ev かつ同一 stateDisc）」を表すか判定
    //   （Watch直接ポーリング等で片方の actorId が空、またはローカルID/クラウドUUIDが異なる場合も同一状態として認識し、
    //     佐藤→鈴木、+5分→+3分、シャンプー募集→コーミング募集、1次停止B→2次停止A のような異なる状態は false を返す）
    static func isSamePeerSemanticState(_ keyA: String, _ keyB: String) -> Bool {
        let cleanA = keyA.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanB = keyB.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanA.isEmpty, !cleanB.isEmpty else { return false }
        if let pA = parsePeerSemanticKeyParts(cleanA), let pB = parsePeerSemanticKeyParts(cleanB) {
            guard pA.ev == pB.ev && pA.disc == pB.disc else { return false }
            if (pA.ev == "stop" || pA.ev == "check_done"),
               !pA.actor.isEmpty, !pB.actor.isEmpty, pA.actor != pB.actor {
                return false
            }
            return true
        }
        return normalizeSemanticToken(cleanA) == normalizeSemanticToken(cleanB)
    }

    // ★ 単発イベント到着時に 'recruit' ファミリーと 'assist' / 'check' ファミリー間で相反する過去の semanticKey を相互無効化（iPhone JS `shouldDropCrossFamilySemanticKey` と完全一致）
    static func shouldDropCrossFamilySemanticKey(
        incoming: (target: String, ev: String, actor: String, disc: String, roleFamily: String),
        candidate: (target: String, ev: String, actor: String, disc: String, roleFamily: String)
    ) -> Bool {
        let inEv = incoming.ev
        let inDisc = incoming.disc
        let candEv = candidate.ev
        let candDisc = candidate.disc

        if inEv == "assign_assist" || inEv == "assign_check" {
            if let colonIdx = inDisc.firstIndex(of: ":") {
                let proc = String(inDisc[inDisc.index(after: colonIdx)...])
                if !proc.isEmpty && (candEv == "recruit" || candEv == "recruit_check") && candDisc == proc {
                    return true
                }
            }
            return false
        }

        if inEv == "unassign_assist" || inEv == "unassign_check" {
            if let arrowRange = inDisc.range(of: "->") {
                let nextPart = String(inDisc[arrowRange.upperBound...])
                if nextPart != "募集中" && (candEv == "recruit" || candEv == "recruit_check") {
                    return true
                }
            }
            return false
        }

        if inEv == "recruit" || inEv == "recruit_check" {
            let proc = inDisc
            if !proc.isEmpty && (candEv == "assign_assist" || candEv == "assign_check"),
               let colonIdx = candDisc.firstIndex(of: ":") {
                let candProc = String(candDisc[candDisc.index(after: colonIdx)...])
                if candProc == proc {
                    return true
                }
            }
            if candEv == "unassign_assist" || candEv == "unassign_check",
               let arrowRange = candDisc.range(of: "->") {
                let candNext = String(candDisc[arrowRange.upperBound...])
                if candNext != "募集中" {
                    return true
                }
            }
            return false
        }

        return false
    }

    private static func expandPeerSemanticKeyVariants(_ semanticKey: String) -> (exactKey: String, wildcardWriteKey: String, wildcardReadKeys: [String])? {
        guard let p = parsePeerSemanticKeyParts(semanticKey) else { return nil }
        let exactKey: String
        if !p.disc.isEmpty {
            exactKey = "\(p.target)|\(p.ev)|\(p.actor)|\(p.disc)"
        } else {
            exactKey = p.actor.isEmpty ? "\(p.target)|\(p.ev)" : "\(p.target)|\(p.ev)|\(p.actor)"
        }
        let suffix = p.disc.isEmpty ? "" : "|\(p.disc)"
        if !p.actor.isEmpty {
            return (
                exactKey: exactKey,
                wildcardWriteKey: "\(p.target)|\(p.ev)|?\(suffix)",
                wildcardReadKeys: ["\(p.target)|\(p.ev)|*\(suffix)"]
            )
        }
        return (
            exactKey: exactKey,
            wildcardWriteKey: "\(p.target)|\(p.ev)|*\(suffix)",
            wildcardReadKeys: ["\(p.target)|\(p.ev)|*\(suffix)", "\(p.target)|\(p.ev)|?\(suffix)"]
        )
    }

    private func purgeHandledSemanticMapsLocked(targetTokens: Set<String>, roleFamily: String, keepEvDiscPairs: Set<String>) {
        guard !roleFamily.isEmpty, !targetTokens.isEmpty else { return }
        let shouldKeep: (String) -> Bool = { key in
            guard let p = Self.parsePeerSemanticKeyParts(key) else { return true }
            guard targetTokens.contains(p.target), p.roleFamily == roleFamily else { return true }
            return keepEvDiscPairs.contains("\(p.ev)|\(p.disc)")
        }
        self.handledWCSessionSemanticKeys = self.handledWCSessionSemanticKeys.filter { shouldKeep($0.key) }
        self.handledDirectPollSemanticKeys = self.handledDirectPollSemanticKeys.filter { shouldKeep($0.key) }
        self.handledWildcardWCSessionSemanticKeys = self.handledWildcardWCSessionSemanticKeys.filter { shouldKeep($0.key) }
        self.handledWildcardDirectPollSemanticKeys = self.handledWildcardDirectPollSemanticKeys.filter { shouldKeep($0.key) }
    }

    func purgeStalePeerSemanticKeysOnEvent(semanticKey: String, seatId: String = "", seatNumber: Int = 0, seatLabel: String = "", eventType: String = "") {
        let parsed = Self.parsePeerSemanticKeyParts(semanticKey)
        let roleFamily = parsed?.roleFamily ?? Self.peerEventRoleFamily(eventType)
        guard !roleFamily.isEmpty else { return }
        var targetTokens = Set<String>()
        if let t = parsed?.target, !t.isEmpty { targetTokens.insert(t) }
        for cand in [seatId, seatLabel, seatNumber > 0 ? "seat-\(seatNumber)" : "", seatNumber > 0 ? "\(seatNumber)番席" : "", seatNumber > 0 ? "\(seatNumber)番" : ""] {
            let norm = Self.normalizeSemanticToken(cand)
            if !norm.isEmpty { targetTokens.insert(norm) }
        }
        var keepPairs = Set<String>()
        if let p = parsed {
            keepPairs.insert("\(p.ev)|\(p.disc)")
        }
        semanticKeyLock.lock()
        purgeHandledSemanticMapsLocked(targetTokens: targetTokens, roleFamily: roleFamily, keepEvDiscPairs: keepPairs)
        // ★ Bug 9-C.2: 'recruit' ⇔ 'assist' / 'check' 間の双方向クロスファミリー無効化（別工程の担当キーは保護）
        if let p = parsed {
            let shouldDropCross: (String) -> Bool = { key in
                guard let kp = Self.parsePeerSemanticKeyParts(key), targetTokens.contains(kp.target) else { return false }
                return Self.shouldDropCrossFamilySemanticKey(incoming: p, candidate: kp)
            }
            self.handledWCSessionSemanticKeys = self.handledWCSessionSemanticKeys.filter { !shouldDropCross($0.key) }
            self.handledDirectPollSemanticKeys = self.handledDirectPollSemanticKeys.filter { !shouldDropCross($0.key) }
            self.handledWildcardWCSessionSemanticKeys = self.handledWildcardWCSessionSemanticKeys.filter { !shouldDropCross($0.key) }
            self.handledWildcardDirectPollSemanticKeys = self.handledWildcardDirectPollSemanticKeys.filter { !shouldDropCross($0.key) }
        }
        semanticKeyLock.unlock()
    }

    func hasHandledPeerSemanticKey(_ semanticKey: String, channel: String, nowSec: TimeInterval) -> Bool {
        guard let variants = Self.expandPeerSemanticKeyVariants(semanticKey) else { return false }
        let exactTtl: TimeInterval = 45.0
        let wildcardTtl: TimeInterval = 3.5
        semanticKeyLock.lock()
        defer { semanticKeyLock.unlock() }
        let isFresh: ([String: TimeInterval], String, TimeInterval) -> Bool = { map, k, ttl in
            guard let ts = map[k] else { return false }
            return (nowSec - ts) < ttl
        }
        if channel == "wcsession_self" {
            return isFresh(self.handledWCSessionSemanticKeys, variants.exactKey, exactTtl)
        }
        if channel == "direct_poll_cross" {
            if isFresh(self.handledDirectPollSemanticKeys, variants.exactKey, exactTtl) { return true }
            for wk in variants.wildcardReadKeys where isFresh(self.handledWildcardDirectPollSemanticKeys, wk, wildcardTtl) {
                return true
            }
            return false
        }
        if isFresh(self.handledWCSessionSemanticKeys, variants.exactKey, exactTtl) ||
           isFresh(self.handledDirectPollSemanticKeys, variants.exactKey, exactTtl) {
            return true
        }
        for wk in variants.wildcardReadKeys {
            if isFresh(self.handledWildcardWCSessionSemanticKeys, wk, wildcardTtl) ||
               isFresh(self.handledWildcardDirectPollSemanticKeys, wk, wildcardTtl) {
                return true
            }
        }
        return false
    }

    func recordHandledPeerSemanticKey(_ semanticKey: String, channel: String, seatId: String = "", seatNumber: Int = 0, seatLabel: String = "", eventType: String = "", nowSec: TimeInterval) {
        guard let variants = Self.expandPeerSemanticKeyVariants(semanticKey) else { return }
        purgeStalePeerSemanticKeysOnEvent(semanticKey: semanticKey, seatId: seatId, seatNumber: seatNumber, seatLabel: seatLabel, eventType: eventType)
        semanticKeyLock.lock()
        self.handledWCSessionSemanticKeys = self.handledWCSessionSemanticKeys.filter { nowSec - $0.value < 60.0 }
        self.handledDirectPollSemanticKeys = self.handledDirectPollSemanticKeys.filter { nowSec - $0.value < 60.0 }
        self.handledWildcardWCSessionSemanticKeys = self.handledWildcardWCSessionSemanticKeys.filter { nowSec - $0.value < 10.0 }
        self.handledWildcardDirectPollSemanticKeys = self.handledWildcardDirectPollSemanticKeys.filter { nowSec - $0.value < 10.0 }
        if channel == "wcsession" {
            self.handledWCSessionSemanticKeys[variants.exactKey] = nowSec
            self.handledWildcardWCSessionSemanticKeys[variants.wildcardWriteKey] = nowSec
        } else {
            self.handledDirectPollSemanticKeys[variants.exactKey] = nowSec
            self.handledWildcardDirectPollSemanticKeys[variants.wildcardWriteKey] = nowSec
        }
        semanticKeyLock.unlock()
    }

    // ★ 席状態遷移（WCSession applyPayload / 直接クラウドポーリング reconcile）時に、
    //   同一席・同一ロール系（assist / check / timer）で現在状態と異なる過去の semanticKey・recentEnqueuedPeerBodies・notifiedDirectCloudEventKeys を一括無効化
    func purgeStalePeerSemanticKeysForSeatTransition(prev: SeatTimerItem?, next: SeatTimerItem) {
        struct RoleState {
            let targets: Set<String>
            let rawIds: Set<String>
            let seatNumber: Int
            let isRunning: Bool
            let targetEndMs: Int64
            let rawAssist: String
            let rawAssistForUnassign: String
            let rawHelpProc: String
            let rawHelpProcForUnassign: String
            let isConcreteAssist: Bool
            let assistToken: String
            let helpProcToken: String
            let hasCheck: Bool
            let checkEndMs: Int64
            let rawCheckStaff: String
            let rawCheckProc: String
            let isConcreteCheck: Bool
            let checkToken: String
            let checkProcToken: String
            let actionProcLabel: String
            let creatorToken: String
        }
        let extract: (SeatTimerItem?) -> RoleState? = { seat in
            guard let seat = seat, !seat.isMainTimer else { return nil }
            let targetEndMs: Int64 = seat.isRunning && seat.targetEndTime.timeIntervalSince1970 > 1_000_000_000
                ? safeEpochMillisInt64(seat.targetEndTime.timeIntervalSince1970 * 1000.0)
                : 0
            let isRunning = seat.isRunning && targetEndMs > 0
            let rawAssistField = (seat.shampooStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let rawHelpProc = seat.helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
            let isNoHelp = seat.isNoHelpNeeded || rawAssistField == "ヘルプなし" || rawAssistField.lowercased() == "none" || rawHelpProc == "ヘルプなし" || rawHelpProc.lowercased() == "none"
            let isRecruiting = !isNoHelp && (seat.isRecruiting || rawAssistField == "募集中")
            let rawAssist = isNoHelp ? "ヘルプなし" : (isRecruiting ? "募集中" : rawAssistField)
            let isConcreteAssist = !rawAssist.isEmpty && rawAssist != "未定" && rawAssist != "募集中" && rawAssist != "ヘルプなし" && rawAssist.lowercased() != "none" && rawAssist != "スタイリスト" && rawAssist != "スタッフ"
            let assistToken = isNoHelp ? "ヘルプなし" : (isRecruiting ? "募集中" : (isConcreteAssist ? Self.normalizeSemanticToken(rawAssist) : ""))
            let helpProcToken = Self.normalizeSemanticToken((rawHelpProc.isEmpty || rawHelpProc == "ヘルプ" || rawHelpProc == "ヘルプなし" || rawHelpProc.lowercased() == "none") ? "シャンプー" : rawHelpProc)

            let checkEndMs: Int64 = (seat.checkTargetEndTime != nil && seat.checkTargetEndTime!.timeIntervalSince1970 > 1_000_000_000)
                ? safeEpochMillisInt64(seat.checkTargetEndTime!.timeIntervalSince1970 * 1000.0)
                : 0
            let hasCheck = isRunning && !seat.isCheckCompleted && (checkEndMs > 0 || (seat.checkTotalSeconds ?? 0) > 0)
            let rawCheckStaff = (seat.checkStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let rawCheckProc = seat.displayCheckProcess
            let isConcreteCheck = hasCheck && !rawCheckStaff.isEmpty && rawCheckStaff != "未定" && rawCheckStaff != "募集中" && rawCheckStaff != "ヘルプなし" && rawCheckStaff.lowercased() != "none" && rawCheckStaff != "スタイリスト" && rawCheckStaff != "スタッフ"
            let checkToken = !hasCheck ? "" : (rawCheckStaff == "募集中" ? "募集中" : (isConcreteCheck ? Self.normalizeSemanticToken(rawCheckStaff) : "unset"))
            let checkProcToken = Self.normalizeSemanticToken(rawCheckProc.isEmpty ? "チェック" : rawCheckProc)

            let actionProcLabel: String = {
                guard !isRunning else { return "" }
                switch seat.status {
                case .shampoo: return (!rawHelpProc.isEmpty && rawHelpProc != "ヘルプなし" && rawHelpProc.lowercased() != "none") ? rawHelpProc : "シャンプー"
                case .combing: return "コーミング"
                case .check: return "チェック"
                case .normal: return ""
                }
            }()
            var targets = Set<String>()
            var rawIds = Set<String>()
            if !seat.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                rawIds.insert(seat.id.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            for cand in [seat.id, seat.seatLabel ?? "", seat.seatNumber > 0 ? "seat-\(seat.seatNumber)" : "", seat.seatNumber > 0 ? "\(seat.seatNumber)番席" : "", seat.seatNumber > 0 ? "\(seat.seatNumber)番" : ""] {
                let norm = Self.normalizeSemanticToken(cand)
                if !norm.isEmpty { targets.insert(norm) }
            }
            return RoleState(
                targets: targets,
                rawIds: rawIds,
                seatNumber: seat.seatNumber,
                isRunning: isRunning,
                targetEndMs: targetEndMs,
                rawAssist: rawAssist,
                rawAssistForUnassign: isNoHelp ? "ヘルプなし" : (isConcreteAssist ? rawAssist : ""),
                rawHelpProc: rawHelpProc,
                rawHelpProcForUnassign: isNoHelp ? "ヘルプなし" : rawHelpProc,
                isConcreteAssist: isConcreteAssist,
                assistToken: assistToken,
                helpProcToken: helpProcToken,
                hasCheck: hasCheck,
                checkEndMs: checkEndMs,
                rawCheckStaff: rawCheckStaff,
                rawCheckProc: rawCheckProc,
                isConcreteCheck: isConcreteCheck,
                checkToken: checkToken,
                checkProcToken: checkProcToken,
                actionProcLabel: actionProcLabel,
                creatorToken: Self.normalizeSemanticToken(seat.creatorName)
            )
        }

        guard let nextState = extract(next) else { return }
        let prevState = extract(prev)
        var targetTokens = nextState.targets
        var allRawIds = nextState.rawIds
        if let p = prevState {
            targetTokens.formUnion(p.targets)
            allRawIds.formUnion(p.rawIds)
        }
        guard !targetTokens.isEmpty else { return }

        let assistChanged = prevState == nil
            || prevState!.assistToken != nextState.assistToken
            || prevState!.helpProcToken != nextState.helpProcToken
            || prevState!.isRunning != nextState.isRunning
        let recruitChanged = assistChanged
            || prevState == nil
            || ((prevState!.checkToken == "募集中") != (nextState.checkToken == "募集中"))
            || (nextState.checkToken == "募集中" && prevState!.checkProcToken != nextState.checkProcToken)
        let checkChanged = prevState == nil
            || prevState!.hasCheck != nextState.hasCheck
            || prevState!.checkToken != nextState.checkToken
            || prevState!.checkProcToken != nextState.checkProcToken
            || abs(prevState!.checkEndMs - nextState.checkEndMs) >= 2500
        let timerChanged = prevState == nil
            || prevState!.isRunning != nextState.isRunning
            || abs(prevState!.targetEndMs - nextState.targetEndMs) >= 2500
            || prevState!.actionProcLabel != nextState.actionProcLabel
            || prevState!.creatorToken != nextState.creatorToken

        var keepAssist = Set<String>()
        if assistChanged {
            if nextState.isRunning && nextState.isConcreteAssist {
                keepAssist.insert("assign_assist|\(Self.buildPeerEventStateDisc(eventType: "assign_assist", nextAssist: nextState.rawAssist, helpProc: nextState.rawHelpProc.isEmpty ? "シャンプー" : nextState.rawHelpProc))")
            }
            if let p = prevState, p.isRunning, nextState.isRunning, p.isConcreteAssist, p.assistToken != nextState.assistToken {
                keepAssist.insert("unassign_assist|\(Self.buildPeerEventStateDisc(eventType: "unassign_assist", prevAssist: p.rawAssist, nextAssist: nextState.rawAssistForUnassign, nextHelpProc: nextState.rawHelpProcForUnassign))")
            }
            let isAssistMeNow = nextState.isRunning && nextState.isConcreteAssist && SeatTimerItem.isStaffMe(nextState.rawAssist, currentUserName: self.currentUserName)
            let helpProcShifted = prevState != nil && prevState!.helpProcToken != nextState.helpProcToken
            var releasePrefixes: [String] = []
            for rId in allRawIds {
                if !isAssistMeNow || helpProcShifted { releasePrefixes.append("cloud_assign_assist_\(rId)_") }
                if isAssistMeNow || helpProcShifted { releasePrefixes.append("cloud_unassign_assist_\(rId)_") }
            }
            releaseDirectCloudEventKeysMatchingPrefixes(releasePrefixes)
        }

        var keepRecruit = Set<String>()
        if recruitChanged {
            if nextState.isRunning {
                if nextState.assistToken == "募集中" {
                    keepRecruit.insert("recruit|\(Self.buildPeerEventStateDisc(eventType: "recruit", recruitProc: nextState.rawHelpProc.isEmpty ? "シャンプー" : nextState.rawHelpProc))")
                }
                if nextState.checkToken == "募集中" {
                    keepRecruit.insert("recruit|\(Self.buildPeerEventStateDisc(eventType: "recruit", recruitProc: nextState.rawCheckProc.isEmpty ? "チェック" : nextState.rawCheckProc))")
                }
            }
            let helpProcShifted = prevState != nil && prevState!.helpProcToken != nextState.helpProcToken
            let checkProcShifted = prevState != nil && prevState!.checkProcToken != nextState.checkProcToken
            var releasePrefixes: [String] = []
            for rId in allRawIds {
                if nextState.assistToken != "募集中" || helpProcShifted { releasePrefixes.append("cloud_recruit_help_\(rId)_") }
                if nextState.checkToken != "募集中" || checkProcShifted { releasePrefixes.append("cloud_recruit_check_\(rId)_") }
            }
            releaseDirectCloudEventKeysMatchingPrefixes(releasePrefixes)
        }

        var keepCheck = Set<String>()
        if checkChanged {
            if nextState.hasCheck {
                keepCheck.insert("add_check|\(Self.buildPeerEventStateDisc(eventType: "add_check", checkProc: nextState.rawCheckProc, nextCheckEndMs: nextState.checkEndMs))")
                if nextState.isConcreteCheck {
                    keepCheck.insert("assign_check|\(Self.buildPeerEventStateDisc(eventType: "assign_check", nextCheckStaff: nextState.rawCheckStaff, checkProc: nextState.rawCheckProc))")
                }
            } else {
                keepCheck.insert("check_done|\(Self.buildPeerEventStateDisc(eventType: "check_done"))")
            }
            if let p = prevState, p.hasCheck, nextState.hasCheck, p.isConcreteCheck, p.checkToken != nextState.checkToken {
                keepCheck.insert("unassign_check|\(Self.buildPeerEventStateDisc(eventType: "unassign_check", prevCheckStaff: p.rawCheckStaff, nextCheckStaff: nextState.isConcreteCheck ? nextState.rawCheckStaff : (nextState.checkToken == "募集中" ? "募集中" : "")))")
            }
            let isCheckMeNow = nextState.hasCheck && nextState.isConcreteCheck && SeatTimerItem.isStaffMe(nextState.rawCheckStaff, currentUserName: self.currentUserName)
            let checkProcShifted = prevState != nil && prevState!.checkProcToken != nextState.checkProcToken
            var releasePrefixes: [String] = []
            for rId in allRawIds {
                if !isCheckMeNow || checkProcShifted { releasePrefixes.append("cloud_assign_check_\(rId)_") }
                if isCheckMeNow || checkProcShifted { releasePrefixes.append("cloud_unassign_check_\(rId)_") }
                if nextState.checkToken != "募集中" || checkProcShifted { releasePrefixes.append("cloud_recruit_check_\(rId)_") }
            }
            releaseDirectCloudEventKeysMatchingPrefixes(releasePrefixes)
        }

        var keepTimer = Set<String>()
        if timerChanged {
            if nextState.isRunning {
                keepTimer.insert("timer_start|\(Self.buildPeerEventStateDisc(eventType: "timer_start", nextEndMs: nextState.targetEndMs))")
                keepTimer.insert("time_adjust|\(Self.buildPeerEventStateDisc(eventType: "time_adjust", nextEndMs: nextState.targetEndMs))")
                keepTimer.insert("assign_main|\(Self.buildPeerEventStateDisc(eventType: "assign_main", nextEndMs: nextState.targetEndMs))")
            } else {
                keepTimer.insert("stop|\(Self.buildPeerEventStateDisc(eventType: "stop"))")
                if !nextState.actionProcLabel.isEmpty {
                    keepTimer.insert("status_change|\(Self.buildPeerEventStateDisc(eventType: "status_change", nextAssist: nextState.rawAssist, procLabel: nextState.actionProcLabel))")
                }
            }
            let endShifted = prevState == nil || prevState!.isRunning != nextState.isRunning || abs(prevState!.targetEndMs - nextState.targetEndMs) >= 2500
            if endShifted {
                var releasePrefixes: [String] = []
                for rId in allRawIds {
                    releasePrefixes.append("cloud_adjust_\(rId)_")
                    if !nextState.isRunning || prevState == nil || !prevState!.isRunning {
                        releasePrefixes.append("cloud_start_\(rId)_")
                    }
                }
                releaseDirectCloudEventKeysMatchingPrefixes(releasePrefixes)
            }
        }

        semanticKeyLock.lock()
        if assistChanged {
            purgeHandledSemanticMapsLocked(targetTokens: targetTokens, roleFamily: "assist", keepEvDiscPairs: keepAssist)
        }
        if recruitChanged {
            purgeHandledSemanticMapsLocked(targetTokens: targetTokens, roleFamily: "recruit", keepEvDiscPairs: keepRecruit)
        }
        if checkChanged {
            purgeHandledSemanticMapsLocked(targetTokens: targetTokens, roleFamily: "check", keepEvDiscPairs: keepCheck)
        }
        if timerChanged {
            purgeHandledSemanticMapsLocked(targetTokens: targetTokens, roleFamily: "timer", keepEvDiscPairs: keepTimer)
        }
        semanticKeyLock.unlock()

        if nextState.seatNumber > 0 && (assistChanged || recruitChanged || checkChanged || timerChanged) {
            self.recentEnqueuedPeerBodies.removeAll { entry in
                guard entry.seatNumber == nextState.seatNumber else { return false }
                let entryFamily: String = {
                    if let p = Self.parsePeerSemanticKeyParts(entry.semanticKey) { return p.roleFamily }
                    return Self.peerEventRoleFamily(entry.kind)
                }()
                if entryFamily == "assist" && assistChanged {
                    if let p = Self.parsePeerSemanticKeyParts(entry.semanticKey) {
                        return !keepAssist.contains("\(p.ev)|\(p.disc)")
                    }
                    if entry.kind == "assign_assist" { return !nextState.isConcreteAssist }
                    if entry.kind == "unassign_assist" { return nextState.isConcreteAssist || nextState.assistToken == "募集中" }
                } else if entryFamily == "recruit" && recruitChanged {
                    if let p = Self.parsePeerSemanticKeyParts(entry.semanticKey) {
                        return !keepRecruit.contains("\(p.ev)|\(p.disc)")
                    }
                    return nextState.assistToken != "募集中" && nextState.checkToken != "募集中"
                } else if entryFamily == "check" && checkChanged {
                    if let p = Self.parsePeerSemanticKeyParts(entry.semanticKey) {
                        return !keepCheck.contains("\(p.ev)|\(p.disc)")
                    }
                    if entry.kind == "recruit_check" { return nextState.checkToken != "募集中" }
                    if entry.kind == "assign_check" { return !nextState.isConcreteCheck }
                    if entry.kind == "unassign_check" { return nextState.isConcreteCheck || nextState.checkToken == "募集中" }
                } else if entryFamily == "timer" && timerChanged {
                    if let p = Self.parsePeerSemanticKeyParts(entry.semanticKey) {
                        return !keepTimer.contains("\(p.ev)|\(p.disc)")
                    }
                    if entry.kind == "stop" { return nextState.isRunning }
                    if entry.kind == "timer_start" { return !nextState.isRunning }
                }
                return false
            }
        }
    }

    @discardableResult
    func enqueuePeerConfirmationAlert(
        id: String = UUID().uuidString,
        text: String,
        colorHex: String = "#30D158",
        timeText: String? = nil,
        eventType: String = "",
        seatId: String = "",
        seatNumber: Int = 0,
        seatLabel: String = "",
        semanticKey: String = ""
    ) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        var didEnqueueNew = false
        let work = {
            let nowEpoch = Date().timeIntervalSince1970
            let parsed = Self.stripLeadingBracketTime(trimmed)
            let resolvedTime: String = {
                if let t = timeText?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
                    return t
                }
                if let ext = parsed.extractedTime, !ext.isEmpty {
                    return ext
                }
                return Self.peerAlertTimeFormatter.string(from: Date())
            }()
            let cleanBody = parsed.body
            let formattedText = "【\(resolvedTime)】\(cleanBody)"
            let incomingMeta = Self.extractPeerAlertSeatAndKind(cleanBody, id: id)
            let resolvedSeatNum = seatNumber > 0 ? seatNumber : (incomingMeta.seatNumber ?? 0)
            let resolvedKind = Self.normalizePeerEventKind(eventType, fallback: incomingMeta.kind)
            let cleanSemKey = semanticKey.trimmingCharacters(in: .whitespacesAndNewlines)
            let incomingHasActor = cleanBody.contains("さんが") || cleanBody.contains("さんにより")

            if !cleanSemKey.isEmpty {
                self.purgeStalePeerSemanticKeysOnEvent(
                    semanticKey: cleanSemKey,
                    seatId: seatId,
                    seatNumber: resolvedSeatNum,
                    seatLabel: seatLabel,
                    eventType: resolvedKind
                )
                if resolvedSeatNum > 0, let inParts = Self.parsePeerSemanticKeyParts(cleanSemKey) {
                    self.recentEnqueuedPeerBodies.removeAll { entry in
                        guard entry.seatNumber == resolvedSeatNum,
                              let candParts = Self.parsePeerSemanticKeyParts(entry.semanticKey) else { return false }
                        if !inParts.roleFamily.isEmpty && candParts.roleFamily == inParts.roleFamily {
                            return !Self.isSamePeerSemanticState(entry.semanticKey, cleanSemKey)
                        }
                        return Self.shouldDropCrossFamilySemanticKey(incoming: inParts, candidate: candParts)
                    }
                }
            }

            // ★ A-1 / A-3 / Round2: 同一席・同一ロール（担当指名⇔担当解除⇔募集）の連続変更時に直前の異なる種別の履歴をクリアして再通知落ちを100%防止し、
            //   未確認の古いバナーが残っていれば最新状態に差し替えて現場の誤認を防ぐ
            if resolvedSeatNum > 0 {
                let mutuallyExclusiveGroup: Set<String>? = {
                    switch resolvedKind {
                    case "assign_assist", "unassign_assist", "recruit":
                        return ["assign_assist", "unassign_assist", "recruit"]
                    case "assign_check", "unassign_check", "recruit_check":
                        return ["assign_check", "unassign_check", "recruit_check"]
                    default:
                        return nil
                    }
                }()
                if let group = mutuallyExclusiveGroup {
                    let staleKinds = group.subtracting([resolvedKind])
                    self.recentEnqueuedPeerBodies.removeAll { $0.seatNumber == resolvedSeatNum && staleKinds.contains($0.kind) }
                    self.unconfirmedPeerAlerts.removeAll { existing in
                        let existingClean = Self.stripLeadingBracketTime(existing.text).body
                        let existingMeta = Self.extractPeerAlertSeatAndKind(existingClean, id: existing.id)
                        let existingNum = existing.seatNumber > 0 ? existing.seatNumber : (existingMeta.seatNumber ?? 0)
                        let existingKind = Self.normalizePeerEventKind(existing.eventType, fallback: existingMeta.kind)
                        return existingNum == resolvedSeatNum && staleKinds.contains(existingKind)
                    }
                }
            }

            self.recentEnqueuedPeerBodies.removeAll { nowEpoch - $0.at > 25.0 }
            if self.recentEnqueuedPeerBodies.contains(where: { entry in
                guard entry.body == cleanBody && nowEpoch - entry.at < 15.0 else { return false }
                if !cleanSemKey.isEmpty && !entry.semanticKey.isEmpty && !Self.isSamePeerSemanticState(entry.semanticKey, cleanSemKey) {
                    return false
                }
                return true
            }) {
                return
            }
            if self.unconfirmedPeerAlerts.contains(where: { existing in
                if existing.id == id { return true }
                guard existing.text == formattedText && nowEpoch - existing.createdAt < 15.0 else { return false }
                if !cleanSemKey.isEmpty && !existing.semanticKey.isEmpty && !Self.isSamePeerSemanticState(existing.semanticKey, cleanSemKey) {
                    return false
                }
                return true
            }) {
                return
            }

            // ★ Watch直接ポーリング通知（担当者名なしの場合あり）とiPhone中継通知（担当者名あり）が25秒以内に前後到着した場合、
            //   同一状態の重複は担当者名入りの文面へインプレース更新し、
            //   Bug 9-B: 同一種別でも状態が異なる別イベント（佐藤→鈴木、+5分→+3分、シャンプー募集→コーミング募集、1次停止→2次停止）は
            //   古い未確認バナーを除去した上で最新バナーを追加＆振動させる！
            if resolvedSeatNum > 0, resolvedKind != "other" {
                let assignKinds: Set<String> = ["assign_assist", "assign_check", "recruit", "recruit_check"]
                var didReplaceDifferentStateBanner = false
                if let existingIdx = self.unconfirmedPeerAlerts.lastIndex(where: { existing in
                    guard nowEpoch - existing.createdAt < 25.0 else { return false }
                    let existingClean = Self.stripLeadingBracketTime(existing.text).body
                    let existingMeta = Self.extractPeerAlertSeatAndKind(existingClean, id: existing.id)
                    let existingNum = existing.seatNumber > 0 ? existing.seatNumber : (existingMeta.seatNumber ?? 0)
                    let existingKind = Self.normalizePeerEventKind(existing.eventType, fallback: existingMeta.kind)
                    if existingNum != resolvedSeatNum { return false }
                    if existingKind == resolvedKind { return true }
                    // Watch直接ポーリングの開始＋同時指名とiPhone中継通知の前後到着も1件に統合
                    if (existingKind == "timer_start" && assignKinds.contains(resolvedKind)) ||
                       (resolvedKind == "timer_start" && assignKinds.contains(existingKind)) {
                        return nowEpoch - existing.createdAt < 6.0
                    }
                    return false
                }) {
                    let prevItem = self.unconfirmedPeerAlerts[existingIdx]
                    let existingClean = Self.stripLeadingBracketTime(prevItem.text).body
                    let existingMeta = Self.extractPeerAlertSeatAndKind(existingClean, id: prevItem.id)
                    let existingKind = Self.normalizePeerEventKind(prevItem.eventType, fallback: existingMeta.kind)
                    let existingHasActor = existingClean.contains("さんが") || existingClean.contains("さんにより")

                    let isDifferentSameKindState: Bool = {
                        guard existingKind == resolvedKind else { return false }
                        if !prevItem.semanticKey.isEmpty && !cleanSemKey.isEmpty {
                            return !Self.isSamePeerSemanticState(prevItem.semanticKey, cleanSemKey)
                        }
                        if existingClean != cleanBody && existingHasActor == incomingHasActor {
                            return true
                        }
                        return false
                    }()

                    if isDifferentSameKindState {
                        self.unconfirmedPeerAlerts.remove(at: existingIdx)
                        didReplaceDifferentStateBanner = true
                    } else {
                        let shouldUpgradeText = (incomingHasActor && !existingHasActor)
                            || (existingKind == "timer_start" && resolvedKind != "timer_start")
                        let mergedSemKey = !cleanSemKey.isEmpty ? cleanSemKey : prevItem.semanticKey
                        if existingKind == "timer_start" && resolvedKind != "timer_start" {
                            self.recentEnqueuedPeerBodies.removeAll { $0.seatNumber == resolvedSeatNum && $0.kind == "timer_start" }
                        }
                        if shouldUpgradeText || (prevItem.seatId.isEmpty && !seatId.isEmpty) || (prevItem.semanticKey.isEmpty && !mergedSemKey.isEmpty) {
                            var updatedList = self.unconfirmedPeerAlerts
                            updatedList[existingIdx] = PeerConfirmationAlertItem(
                                id: id.isEmpty ? prevItem.id : id,
                                timeText: shouldUpgradeText ? resolvedTime : prevItem.timeText,
                                text: shouldUpgradeText ? formattedText : prevItem.text,
                                colorHex: (shouldUpgradeText && !colorHex.isEmpty) ? colorHex : prevItem.colorHex,
                                createdAt: prevItem.createdAt,
                                eventType: shouldUpgradeText ? resolvedKind : (prevItem.eventType.isEmpty ? resolvedKind : prevItem.eventType),
                                seatId: !seatId.isEmpty ? seatId : prevItem.seatId,
                                seatNumber: resolvedSeatNum > 0 ? resolvedSeatNum : prevItem.seatNumber,
                                seatLabel: !seatLabel.isEmpty ? seatLabel : prevItem.seatLabel,
                                semanticKey: mergedSemKey
                            )
                            self.unconfirmedPeerAlerts = updatedList
                            self.persistUnconfirmedPeerAlerts()
                        }
                        self.recentEnqueuedPeerBodies.append((body: cleanBody, seatNumber: resolvedSeatNum, kind: resolvedKind, semanticKey: mergedSemKey, at: nowEpoch))
                        return
                    }
                }

                // すでにユーザーが「確認 ✓」を押してバナーを消去した直後（20秒以内）に、別チャネルから同一イベントの遅延パケットが届いた場合も再通知を防止
                // （※ semanticKey の stateDisc が異なる新イベント A→B、+5分→+3分、A→B→A 等は抑制せず通過させる）
                if !didReplaceDifferentStateBanner && self.recentEnqueuedPeerBodies.contains(where: { recent in
                    guard nowEpoch - recent.at < 20.0, recent.seatNumber == resolvedSeatNum else { return false }
                    let isStartAssignCombo = ((recent.kind == "timer_start" && assignKinds.contains(resolvedKind)) ||
                                              (resolvedKind == "timer_start" && assignKinds.contains(recent.kind))) && (nowEpoch - recent.at < 6.0)
                    if !cleanSemKey.isEmpty && !recent.semanticKey.isEmpty {
                        if !Self.isSamePeerSemanticState(recent.semanticKey, cleanSemKey) && !isStartAssignCombo {
                            return false
                        }
                    } else if recent.kind == resolvedKind {
                        let recentHasActor = recent.body.contains("さんが") || recent.body.contains("さんにより")
                        if recent.body != cleanBody && recentHasActor == incomingHasActor {
                            return false
                        }
                    }
                    if recent.kind == resolvedKind { return true }
                    if isStartAssignCombo { return true }
                    return false
                }) {
                    self.recentEnqueuedPeerBodies.append((body: cleanBody, seatNumber: resolvedSeatNum, kind: resolvedKind, semanticKey: cleanSemKey, at: nowEpoch))
                    return
                }
            }

            self.recentEnqueuedPeerBodies.append((body: cleanBody, seatNumber: resolvedSeatNum > 0 ? resolvedSeatNum : incomingMeta.seatNumber, kind: resolvedKind, semanticKey: cleanSemKey, at: nowEpoch))

            let item = PeerConfirmationAlertItem(
                id: id.isEmpty ? "peer_\(safeEpochMillisInt64(nowEpoch * 1000))_\(Int.random(in: 100...999))" : id,
                timeText: resolvedTime,
                text: formattedText,
                colorHex: colorHex.isEmpty ? "#30D158" : colorHex,
                createdAt: nowEpoch,
                eventType: resolvedKind,
                seatId: seatId,
                seatNumber: resolvedSeatNum,
                seatLabel: seatLabel,
                semanticKey: cleanSemKey
            )
            var next = self.unconfirmedPeerAlerts
            if next.count >= 15 {
                next.removeFirst(next.count - 14)
            }
            next.append(item)
            self.unconfirmedPeerAlerts = next
            self.persistUnconfirmedPeerAlerts()
            didEnqueueNew = true
        }
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
        return didEnqueueNew
    }

    func removeStopRelatedPeerAlerts(forSeatId seatId: String, seatNumber: Int, displaySeatName: String = "") {
        guard !self.unconfirmedPeerAlerts.isEmpty else { return }
        let stopRelatedKinds: Set<String> = ["stop", "shampoo", "combing", "check", "help_enter"]
        let candidateKeys = Set(allSeatKeys(for: seatId, seatNumber: seatNumber))
        let beforeCount = self.unconfirmedPeerAlerts.count
        self.unconfirmedPeerAlerts.removeAll { existing in
            let existingClean = Self.stripLeadingBracketTime(existing.text).body
            let existingMeta = Self.extractPeerAlertSeatAndKind(existingClean, id: existing.id)
            let normalizedKind = Self.normalizePeerEventKind(existing.eventType, fallback: existingMeta.kind)
            let existingIsStopRelated = stopRelatedKinds.contains(normalizedKind)
                || existing.id.contains("cloud_stop_")
                || existing.id.contains("cloud_stopped_proc_")
                || existing.id.contains("cloud_sec_stop_")
                || existing.id.contains("poll_status_")
                || existing.id.contains("poll_sec_stop_")
                || existing.id.contains("poll_stop_")
            guard existingIsStopRelated else { return false }
            let existingNum = existing.seatNumber > 0 ? existing.seatNumber : (existingMeta.seatNumber ?? 0)
            if seatNumber > 0, existingNum == seatNumber {
                return true
            }
            if !existing.seatId.isEmpty && candidateKeys.contains(existing.seatId) {
                return true
            }
            if candidateKeys.contains(where: { !$0.isEmpty && existing.id.contains($0) }) {
                return true
            }
            if !displaySeatName.isEmpty && existingClean.contains(displaySeatName) {
                return true
            }
            return false
        }
        if self.unconfirmedPeerAlerts.count != beforeCount {
            self.persistUnconfirmedPeerAlerts()
        }
    }

    func confirmTopPeerAlert() {
        let work = {
            guard !self.unconfirmedPeerAlerts.isEmpty else { return }
            let alert = self.unconfirmedPeerAlerts.removeFirst()
            self.persistUnconfirmedPeerAlerts()

            let cleanBody = Self.stripLeadingBracketTime(alert.text).body
            let meta = Self.extractPeerAlertSeatAndKind(cleanBody, id: alert.id)
            let normalizedKind = Self.normalizePeerEventKind(alert.eventType, fallback: meta.kind)
            let stopRelatedKinds: Set<String> = ["stop", "shampoo", "combing", "check", "help_enter"]
            let isStopRelated = stopRelatedKinds.contains(normalizedKind)
                || alert.id.contains("cloud_stop_")
                || alert.id.contains("cloud_stopped_proc_")
                || alert.id.contains("cloud_sec_stop_")
                || alert.id.contains("poll_status_")
                || alert.id.contains("poll_sec_stop_")
                || alert.id.contains("poll_stop_")
            let isCheckDoneRelated = (normalizedKind == "check_done" || alert.id.contains("cloud_chk_"))

            let resolveTargetSeat: () -> SeatTimerItem? = {
                if !alert.seatId.isEmpty,
                   let byExactId = self.timers.first(where: { $0.id == alert.seatId }) {
                    return byExactId
                }
                let sNum = alert.seatNumber > 0 ? alert.seatNumber : (meta.seatNumber ?? 0)
                if sNum > 0,
                   let byNum = self.timers.first(where: { $0.seatNumber == sNum }) {
                    return byNum
                }
                if let byId = self.timers.first(where: { !$0.id.isEmpty && alert.id.contains($0.id) }) {
                    return byId
                }
                if let byName = self.timers.first(where: { !$0.displaySeatName.isEmpty && cleanBody.contains($0.displaySeatName) }) {
                    return byName
                }
                if isStopRelated {
                    if let peerStopped = self.timers.first(where: {
                        $0.isRunning && self.isPeerStoppedSeat(seatId: $0.id, seatNumber: $0.seatNumber, endTimeEpoch: $0.targetEndTime.timeIntervalSince1970)
                    }) {
                        return peerStopped
                    }
                }
                return nil
            }

            if isStopRelated, let targetSeat = resolveTargetSeat() {
                self.removeStopRelatedPeerAlerts(
                    forSeatId: targetSeat.id,
                    seatNumber: targetSeat.seatNumber,
                    displaySeatName: targetSeat.displaySeatName
                )
                if targetSeat.isRunning || WatchAlarmCoordinator.shared.isSeatRingingOrDue(seatId: targetSeat.id, seatNumber: targetSeat.seatNumber) {
                    let expectedEndMs = targetSeat.targetEndTime.timeIntervalSince1970 * 1000.0
                    var stopExtra: [String: Any] = [
                        "kind": "main",
                        "expectedEnd": expectedEndMs,
                        "wasPeerStopped": true
                    ]
                    if targetSeat.status != .normal {
                        stopExtra["peerIsShampooing"] = (targetSeat.status == .shampoo)
                        stopExtra["peerHelpProcess"] = targetSeat.helpProcess.isEmpty ? targetSeat.status.rawValue : targetSeat.helpProcess
                        if let staff = targetSeat.shampooStaff, !staff.isEmpty {
                            stopExtra["peerAssistantStaffName"] = staff
                        }
                    }
                    WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                        seatId: targetSeat.id,
                        seatNumber: targetSeat.seatNumber,
                        checkOnly: false,
                        skipRefresh: true
                    )
                    self.applyLocalStop(seatId: targetSeat.id, fallbackEndTime: targetSeat.targetEndTime)
                    self.sendActionToPhone(action: "STOP_ALARM", seatId: targetSeat.id, extra: stopExtra)
                }
            } else if isCheckDoneRelated, let targetSeat = resolveTargetSeat(), !targetSeat.isCheckCompleted {
                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                    seatId: targetSeat.id,
                    seatNumber: targetSeat.seatNumber,
                    checkOnly: true,
                    skipRefresh: true
                )
                let preservedChk = self.applyLocalCheckComplete(seatId: targetSeat.id, fallbackCheckEndTime: targetSeat.checkTargetEndTime)
                var checkExtra: [String: Any] = ["kind": "check"]
                if let preservedChk = preservedChk {
                    checkExtra["checkTotalSeconds"] = preservedChk
                }
                self.sendActionToPhone(action: "STOP_ALARM", seatId: targetSeat.id, extra: checkExtra)
            }
        }
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    func resolveCloudActorName(cloudAssist: String, cloudUpdatedBy: String, cloudCreatedBy: String, cloudColorStaff: String) -> String {
        let cleanUpd = cloudUpdatedBy.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleanUpd.isEmpty {
            if let exact = self.memberIdMap[cleanUpd], !exact.isEmpty {
                return exact
            }
            if let matched = self.memberIdMap.first(where: { $0.key.caseInsensitiveCompare(cleanUpd) == .orderedSame })?.value, !matched.isEmpty {
                return matched
            }
            let cleanCre = cloudCreatedBy.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanColor = cloudColorStaff.trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleanCre.isEmpty && cleanUpd.caseInsensitiveCompare(cleanCre) == .orderedSame && !cleanColor.isEmpty {
                return cleanColor
            }
        }
        let cleanAssist = cloudAssist.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleanAssist.isEmpty && cleanAssist != "募集中" && cleanAssist != "ヘルプなし" && cleanAssist != "none" && cleanAssist != "未定" {
            return cleanAssist
        }
        return ""
    }
    
    override init() {
        super.init()
        let nowDate = Date()
        let shortVer = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let buildVer = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
        let currentWatchSanitizeVersion = "122"
        let currentWatchBuild = "\(shortVer) (\(buildVer))-v\(currentWatchSanitizeVersion)"
        let prevWatchBuild = UserDefaults.standard.string(forKey: savedLastBuildVersionKey)
            ?? appGroupDefaults?.string(forKey: savedLastBuildVersionKey)
        let isNewWatchBuildUpdate = (prevWatchBuild != currentWatchBuild)
        if isNewWatchBuildUpdate {
            UserDefaults.standard.set(currentWatchBuild, forKey: savedLastBuildVersionKey)
            appGroupDefaults?.set(currentWatchBuild, forKey: savedLastBuildVersionKey)
        }

        let stdLastTs = UserDefaults.standard.double(forKey: savedLastPayloadTsKey)
        let savedLastTs = stdLastTs > 0 ? stdLastTs : (appGroupDefaults?.double(forKey: savedLastPayloadTsKey) ?? 0)
        let nowInitMs = nowDate.timeIntervalSince1970 * 1000.0
        if savedLastTs > 0 && savedLastTs <= nowInitMs + 120_000 {
            self.lastPayloadTimestamp = savedLastTs
        }
        if let savedNotifIds = UserDefaults.standard.stringArray(forKey: savedHandledPeerNotifIdsKey) {
            self.handledPeerNotifIds = Array(savedNotifIds.suffix(30))
            self.lastHandledPeerNotifId = self.handledPeerNotifIds.last ?? ""
        }
        if let savedCloudEvKeys = (UserDefaults.standard.stringArray(forKey: savedNotifiedDirectCloudEventKeysKey)
            ?? appGroupDefaults?.stringArray(forKey: savedNotifiedDirectCloudEventKeysKey)) {
            self.notifiedDirectCloudEventKeys = Array(savedCloudEvKeys.suffix(120))
        }

        if let savedName = (UserDefaults.standard.string(forKey: savedUserNameKey)
            ?? appGroupDefaults?.string(forKey: savedUserNameKey)),
           !savedName.isEmpty {
            self.currentUserName = savedName
        }
        if let savedSalonId = (UserDefaults.standard.string(forKey: savedCloudSalonIdKey)
            ?? appGroupDefaults?.string(forKey: savedCloudSalonIdKey)),
           !savedSalonId.isEmpty {
            self.cloudSalonId = savedSalonId
            UserDefaults.standard.set(savedSalonId, forKey: savedCloudSalonIdKey)
            appGroupDefaults?.set(savedSalonId, forKey: savedCloudSalonIdKey)
        }
        if let savedUid = (UserDefaults.standard.string(forKey: savedCloudUserIdKey)
            ?? appGroupDefaults?.string(forKey: savedCloudUserIdKey)),
           !savedUid.isEmpty {
            self.cloudUserId = savedUid
            UserDefaults.standard.set(savedUid, forKey: savedCloudUserIdKey)
            appGroupDefaults?.set(savedUid, forKey: savedCloudUserIdKey)
        }
        if let savedMap = ((UserDefaults.standard.dictionary(forKey: savedMemberIdMapKey) as? [String: String])
            ?? (appGroupDefaults?.dictionary(forKey: savedMemberIdMapKey) as? [String: String])) {
            self.memberIdMap = savedMap
        }
        if let savedAliases = (UserDefaults.standard.stringArray(forKey: savedUserAliasesKey)
            ?? appGroupDefaults?.stringArray(forKey: savedUserAliasesKey)),
           !savedAliases.isEmpty {
            self.currentUserAliases = savedAliases
        }
        if isNewWatchBuildUpdate {
            self.buildUpdateExpiryCutoff = nowDate
            self.unconfirmedPeerAlerts = []
            self.persistUnconfirmedPeerAlerts()
        } else if let savedAlertsData = (UserDefaults.standard.data(forKey: savedUnconfirmedPeerAlertsKey)
            ?? appGroupDefaults?.data(forKey: savedUnconfirmedPeerAlertsKey)),
           let decodedAlerts = try? JSONDecoder().decode([PeerConfirmationAlertItem].self, from: savedAlertsData) {
            let nowEpoch = nowDate.timeIntervalSince1970
            self.unconfirmedPeerAlerts = decodedAlerts.filter { nowEpoch - $0.createdAt < 14400 }
        }
        if let rawStops = ((UserDefaults.standard.dictionary(forKey: savedLocalStopsKey) as? [String: [String: Double]])
            ?? (appGroupDefaults?.dictionary(forKey: savedLocalStopsKey) as? [String: [String: Double]])) {
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
        if isNewWatchBuildUpdate {
            self.peerStoppedSeatEnds.removeAll()
            self.persistPeerStoppedSeats()
            self.confirmedPeerStoppedSeatEnds.removeAll()
            self.persistConfirmedPeerStoppedSeats()
            self.localCheckClears.removeAll()
        } else {
            if let rawPeerStops = ((UserDefaults.standard.dictionary(forKey: savedPeerStoppedSeatsKey) as? [String: Double])
                ?? (appGroupDefaults?.dictionary(forKey: savedPeerStoppedSeatsKey) as? [String: Double])) {
                let cutoffEpoch = nowDate.addingTimeInterval(-10800).timeIntervalSince1970
                var restoredPeerStops: [String: Double] = [:]
                for (k, endEpoch) in rawPeerStops where endEpoch > cutoffEpoch {
                    restoredPeerStops[k] = endEpoch
                }
                self.peerStoppedSeatEnds = restoredPeerStops
            }
            if let rawConfirmedStops = ((UserDefaults.standard.dictionary(forKey: savedConfirmedPeerStoppedSeatsKey) as? [String: Double])
                ?? (appGroupDefaults?.dictionary(forKey: savedConfirmedPeerStoppedSeatsKey) as? [String: Double])) {
                let cutoffEpoch = nowDate.addingTimeInterval(-14400).timeIntervalSince1970
                var restoredConfirmedStops: [String: Double] = [:]
                for (k, endEpoch) in rawConfirmedStops where endEpoch > cutoffEpoch {
                    restoredConfirmedStops[k] = endEpoch
                }
                self.confirmedPeerStoppedSeatEnds = restoredConfirmedStops
            }
        }
        if let rawStarts = ((UserDefaults.standard.dictionary(forKey: savedWatchSeatStartsKey) as? [String: Double])
            ?? (appGroupDefaults?.dictionary(forKey: savedWatchSeatStartsKey) as? [String: Double])) {
            var restoredStarts: [String: Date] = [:]
            for (k, startEpoch) in rawStarts {
                let startDate = Date(timeIntervalSince1970: startEpoch)
                if nowDate.timeIntervalSince(startDate) < watchStartedSeatPersistSeconds {
                    restoredStarts[k] = startDate
                }
            }
            self.watchStartedSeatTimes = restoredStarts
        }
        let stdMainStopAt = UserDefaults.standard.double(forKey: savedMainStopActionTimeKey)
        let savedMainStopAt = stdMainStopAt > 0 ? stdMainStopAt : (appGroupDefaults?.double(forKey: savedMainStopActionTimeKey) ?? 0)
        if savedMainStopAt > 0 {
            let atDate = Date(timeIntervalSince1970: savedMainStopAt)
            if nowDate.timeIntervalSince(atDate) < mainTimerStopHoldSeconds {
                self.lastMainTimerLocalActionTime = atDate
                self.lastMainTimerLocalActionType = UserDefaults.standard.string(forKey: savedMainStopActionTypeKey)
                    ?? appGroupDefaults?.string(forKey: savedMainStopActionTypeKey)
                    ?? ""
                let stdStopEnd = UserDefaults.standard.double(forKey: savedMainStopEndTimeKey)
                self.lastMainTimerLocalStopEndTime = stdStopEnd > 0
                    ? stdStopEnd
                    : (appGroupDefaults?.double(forKey: savedMainStopEndTimeKey) ?? 0)
            }
        }
        let stdWatchEndEpoch = UserDefaults.standard.double(forKey: savedWatchMainEndKey)
        let savedWatchEndEpoch = stdWatchEndEpoch > 0 ? stdWatchEndEpoch : (appGroupDefaults?.double(forKey: savedWatchMainEndKey) ?? 0)
        if savedWatchEndEpoch > nowDate.addingTimeInterval(-10800).timeIntervalSince1970 {
            if (isNewWatchBuildUpdate && savedWatchEndEpoch <= nowDate.timeIntervalSince1970)
                || (self.lastMainTimerLocalStopEndTime > 0 && abs(savedWatchEndEpoch - self.lastMainTimerLocalStopEndTime) <= 2) {
                self.watchStartedMainTimerEndTime = nil
            } else {
                self.watchStartedMainTimerEndTime = Date(timeIntervalSince1970: savedWatchEndEpoch)
            }
        }
        if let rawMain = (UserDefaults.standard.dictionary(forKey: savedMainTimerKey)
            ?? appGroupDefaults?.dictionary(forKey: savedMainTimerKey)),
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
               abs(restoredMain.targetEndTime.timeIntervalSince1970 - self.lastMainTimerLocalStopEndTime) <= 2 {
                restoredMain.isRunning = false
                restoredMain.isPreCountingDown = false
                restoredMain.pausedRemainingSeconds = 0
                self.watchStartedMainTimerEndTime = nil
            }
            // ★ ビルド更新初回起動時はすでにタイムアップ済み（targetEndTime <= nowDate）または停止中のメインタイマーも残留させずリセットする。
            //   通常起動時は3時間（10800秒）以内の稼働・超過はそのまま保護し、「タイマーを止める」が押されるまで継続させる。
            if isNewWatchBuildUpdate && (!restoredMain.isRunning || restoredMain.targetEndTime <= nowDate) {
                let wasActiveBeforeBuildReset = restoredMain.isRunning || restoredMain.isPreCountingDown
                let expiredEndEpoch = restoredMain.targetEndTime.timeIntervalSince1970
                restoredMain.isRunning = false
                restoredMain.isPreCountingDown = false
                restoredMain.pausedRemainingSeconds = 0
                restoredMain.isAutoFinished = false
                self.watchStartedMainTimerEndTime = nil
                UserDefaults.standard.removeObject(forKey: savedWatchMainEndKey)
                appGroupDefaults?.removeObject(forKey: savedWatchMainEndKey)
                if wasActiveBeforeBuildReset && expiredEndEpoch > 0 {
                    self.lastMainTimerLocalActionType = "RESET"
                    self.lastMainTimerLocalActionTime = nowDate
                    self.lastMainTimerLocalStopEndTime = expiredEndEpoch
                    self.persistMainTimerStopState()
                }
            } else if restoredMain.isRunning {
                let cutoff = nowDate.addingTimeInterval(-10800)
                if restoredMain.targetEndTime <= cutoff {
                    restoredMain.isRunning = false
                    restoredMain.pausedRemainingSeconds = 0
                    self.watchStartedMainTimerEndTime = nil
                }
            } else if !restoredMain.isPreCountingDown {
                self.watchStartedMainTimerEndTime = nil
                if isNewWatchBuildUpdate || restoredMain.pausedRemainingSeconds <= 0 || restoredMain.pausedRemainingSeconds >= restoredMain.totalSeconds {
                    restoredMain.pausedRemainingSeconds = 0
                }
            }
            self.mainTimer = restoredMain
        } else {
            self.watchStartedMainTimerEndTime = nil
        }
        if let rawTimers = ((UserDefaults.standard.array(forKey: savedTimersKey) as? [[String: Any]])
            ?? (appGroupDefaults?.array(forKey: savedTimersKey) as? [[String: Any]])) {
            var restoredTimers = rawTimers.compactMap { SeatTimerItem(dictionary: $0) }
            var expiredSeatsForDirectCloudStop: [(seat: SeatTimerItem, expiredEndMs: Double)] = []
            if !restoredTimers.isEmpty {
                for i in restoredTimers.indices {
                    let id = restoredTimers[i].id
                    let seatKey = "seat-\(restoredTimers[i].seatNumber)"
                    let isExpiredOnNewBuild = isNewWatchBuildUpdate && (!restoredTimers[i].isRunning || self.canNormalizeExpiredSeatOnBuildUpdate(restoredTimers[i], cutoff: nowDate))
                    if let stop = self.localStops[id] ?? self.localStops[seatKey],
                       restoredTimers[i].isRunning,
                       abs(restoredTimers[i].targetEndTime.timeIntervalSince1970 - stop.end) <= 2.5,
                       nowDate.timeIntervalSince(stop.at) < localStopHoldSeconds {
                        restoredTimers[i].isRunning = false
                        restoredTimers[i].totalSeconds = 0
                        restoredTimers[i].pausedRemainingSeconds = 0
                        restoredTimers[i].targetEndTime = Date(timeIntervalSince1970: 0)
                        restoredTimers[i].status = .normal
                        restoredTimers[i].shampooStaff = nil
                        restoredTimers[i].helpProcess = ""
                        restoredTimers[i].isRecruiting = false
                        restoredTimers[i].isNoHelpNeeded = false
                        restoredTimers[i].isCollapsed = true
                        restoredTimers[i].clearCheck()
                    } else if isExpiredOnNewBuild || (restoredTimers[i].isRunning && restoredTimers[i].targetEndTime <= nowDate.addingTimeInterval(-10800)) {
                        // ★ TestFlightビルド更新初回起動時にすでにタイムアップ済み（自分の席または15分以上放置された超過状態）または停止中の席、
                        //   あるいは通常起動時に3時間以上超過放置された席は 00:00 にクリーンアップして残留ゾンビ化を防ぐ
                        if restoredTimers[i].isRunning && restoredTimers[i].targetEndTime.timeIntervalSince1970 > 0 {
                            let expiredSeatCopy = restoredTimers[i]
                            let expiredEndMs = restoredTimers[i].targetEndTime.timeIntervalSince1970 * 1000.0
                            self.markLocalStop(seatId: id, endTime: restoredTimers[i].targetEndTime)
                            self.markLocalStop(seatId: seatKey, endTime: restoredTimers[i].targetEndTime)
                            if isNewWatchBuildUpdate {
                                expiredSeatsForDirectCloudStop.append((seat: expiredSeatCopy, expiredEndMs: expiredEndMs))
                            }
                        }
                        restoredTimers[i].isRunning = false
                        restoredTimers[i].totalSeconds = 0
                        restoredTimers[i].pausedRemainingSeconds = 0
                        restoredTimers[i].targetEndTime = Date(timeIntervalSince1970: 0)
                        restoredTimers[i].status = .normal
                        restoredTimers[i].shampooStaff = nil
                        restoredTimers[i].helpProcess = ""
                        restoredTimers[i].isRecruiting = false
                        restoredTimers[i].isNoHelpNeeded = false
                        restoredTimers[i].isCollapsed = true
                        restoredTimers[i].clearCheck()
                    } else if isNewWatchBuildUpdate && restoredTimers[i].isRunning && restoredTimers[i].targetEndTime <= nowDate {
                        // 他スタッフが関与している直近（15分未満）の現役超過タイマーは 00:00 に潰さず維持（アラーム自体の再鳴動抑止は WatchAlarmCoordinator.init で acknowledged 済み）
                        if let chkEnd = restoredTimers[i].checkTargetEndTime, chkEnd <= nowDate.addingTimeInterval(-900) {
                            restoredTimers[i].clearCheck()
                        }
                    } else if isNewWatchBuildUpdate, let chkEnd = restoredTimers[i].checkTargetEndTime, chkEnd <= nowDate {
                        let hasOtherChecker: Bool = {
                            guard !restoredTimers[i].isCheckCompleted,
                                  let c = restoredTimers[i].checkStaff?.trimmingCharacters(in: .whitespacesAndNewlines),
                                  !c.isEmpty, c != "募集中" else { return false }
                            return !SeatTimerItem.isStaffMe(c, currentUserName: self.currentUserName)
                        }()
                        if chkEnd <= nowDate.addingTimeInterval(-900) || !hasOtherChecker {
                            restoredTimers[i].clearCheck()
                        }
                    } else if !restoredTimers[i].isRunning {
                        let isLegacy20MinSample = restoredTimers[i].totalSeconds == 1200 && restoredTimers[i].pausedRemainingSeconds == 1200
                        if isNewWatchBuildUpdate || isLegacy20MinSample {
                            // ★ TestFlightアップデート後または旧20分サンプル席で稼働中でない席は 00:00 に正規化（「タイマーを止める」不要で即タイム入力可能）
                            restoredTimers[i].totalSeconds = 0
                            restoredTimers[i].pausedRemainingSeconds = 0
                            restoredTimers[i].targetEndTime = Date(timeIntervalSince1970: 0)
                            restoredTimers[i].status = .normal
                            restoredTimers[i].shampooStaff = nil
                            restoredTimers[i].helpProcess = ""
                            restoredTimers[i].isRecruiting = false
                            restoredTimers[i].isNoHelpNeeded = false
                            restoredTimers[i].isCollapsed = true
                            restoredTimers[i].clearCheck()
                        }
                    }
                }
                self.timers = restoredTimers
                if !expiredSeatsForDirectCloudStop.isEmpty {
                    let entriesToStop = expiredSeatsForDirectCloudStop
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                        guard let self = self else { return }
                        for entry in entriesToStop {
                            self.patchStopSeatTimerInSupabaseDirectly(
                                seatId: entry.seat.id,
                                seatNumber: entry.seat.seatNumber,
                                matchedSeat: entry.seat,
                                extra: [
                                    "expectedEnd": entry.expiredEndMs,
                                    "wasPeerStopped": false
                                ]
                            )
                        }
                    }
                }
            }
        }
        WidgetSync.save(timers: self.timers, mainTimer: self.mainTimer, userName: self.currentUserName, forceReload: false)
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
                extra["watchMainTimerStoppedEnd"] = self.lastMainTimerLocalStopEndTime * 1000.0
            }
        } else if let m = self.mainTimer,
                  self.watchStartedMainTimerEndTime != nil,
                  (m.isRunning || m.isPreCountingDown) {
            let cutoff = nowDate.addingTimeInterval(-10800)
            if m.targetEndTime > cutoff {
                let soundVal = UserDefaults.standard.object(forKey: "assisttimer.mainTimerPhoneSound.v2") as? Bool ?? false
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
        // ★ iPhoneアプリ閉鎖・TestFlight更新中にWatch側で開始された稼働中客席タイマーも同梱通知し、iPhone起動時の逆同期で停止されるのを防止
        let cutoff = nowDate.addingTimeInterval(-10800)
        var activeWatchSeats: [[String: Any]] = []
        for t in self.timers where t.isRunning && t.targetEndTime > cutoff {
            let seatKey = "seat-\(t.seatNumber)"
            if let startedAt = self.watchStartedSeatTimes[t.id] ?? self.watchStartedSeatTimes[seatKey],
               nowDate.timeIntervalSince(startedAt) < self.watchStartedSeatPersistSeconds {
                var itemDict: [String: Any] = [
                    "id": t.id,
                    "seatNumber": t.seatNumber,
                    "seatLabel": t.seatLabel ?? "\(t.seatNumber)番席",
                    "totalSeconds": t.totalSeconds > 0 ? t.totalSeconds : 600,
                    "targetEndTimestamp": t.targetEndTime.timeIntervalSince1970 * 1000.0,
                    "helpProcess": t.helpProcess,
                    "assistantStaffName": t.isRecruiting ? "募集中" : (t.isNoHelpNeeded ? "ヘルプなし" : (t.shampooStaff ?? "")),
                    "isRecruiting": t.isRecruiting,
                    "isNoHelpNeeded": t.isNoHelpNeeded,
                    "creatorName": t.creatorName,
                    "isCreatorMe": t.isCreatorMe(currentUserName: self.currentUserName),
                    "watchAlarmSoundEnabled": t.watchAlarmSoundEnabled,
                    "alarmSoundEnabled": t.alarmSoundEnabled
                ]
                if !t.isCheckCompleted, let chkSec = t.checkTotalSeconds, chkSec > 0, let chkEnd = t.checkTargetEndTime {
                    itemDict["checkTargetSeconds"] = chkSec
                    itemDict["checkEndTimestamp"] = chkEnd.timeIntervalSince1970 * 1000.0
                    itemDict["checkProcess"] = t.checkProcess
                    if let chkStaff = t.checkStaff, !chkStaff.isEmpty {
                        itemDict["checkStaffName"] = chkStaff
                    }
                }
                activeWatchSeats.append(itemDict)
            }
        }
        if !activeWatchSeats.isEmpty {
            extra["watchActiveSeats"] = activeWatchSeats
        }
        // ★ iPhoneがバックグラウンド休止中にWatchで「タイマーを止める」を押した客席も REQUEST_SYNC に同梱し、
        //   再接続・起動時にiPhoneとSupabaseクラウドの稼働中タイマーを確実に00:00停止へ同期する！
        var stoppedWatchSeats: [[String: Any]] = []
        var addedStopKeys: Set<String> = []
        for (stopKey, stopVal) in self.localStops {
            guard nowDate.timeIntervalSince(stopVal.at) < self.localStopHoldSeconds,
                  stopVal.end > 0 else { continue }
            let matchedTimer = self.timers.first(where: { $0.id == stopKey })
                ?? self.timers.first(where: { "seat-\($0.seatNumber)" == stopKey })
            if let t = matchedTimer {
                // 現在Watch上で稼働中の席は停止済みリスト（watchStoppedSeats）に含めない（再スタート後の新タイマー誤停止を防止）
                if t.isRunning {
                    continue
                }
                let dedupKey = "\(t.id)|\(safeEpochSecondsInt64(stopVal.end))"
                guard !addedStopKeys.contains(dedupKey) else { continue }
                addedStopKeys.insert(dedupKey)
                var stopDict: [String: Any] = [
                    "id": t.id,
                    "seatNumber": t.seatNumber,
                    "seatLabel": t.seatLabel ?? "\(t.seatNumber)番席",
                    "stoppedTargetEndTimestamp": stopVal.end * 1000.0,
                    "stoppedAt": stopVal.at.timeIntervalSince1970 * 1000.0
                ]
                if t.status != .normal {
                    stopDict["wasPeerStopped"] = true
                    stopDict["peerIsShampooing"] = (t.status == .shampoo)
                    stopDict["peerHelpProcess"] = t.helpProcess.isEmpty ? t.status.rawValue : t.helpProcess
                    if let s = t.shampooStaff, !s.isEmpty {
                        stopDict["peerAssistantStaffName"] = s
                    }
                }
                stoppedWatchSeats.append(stopDict)
            } else {
                let dedupKey = "\(stopKey)|\(safeEpochSecondsInt64(stopVal.end))"
                guard !addedStopKeys.contains(dedupKey) else { continue }
                addedStopKeys.insert(dedupKey)
                var dict: [String: Any] = [
                    "id": stopKey,
                    "stoppedTargetEndTimestamp": stopVal.end * 1000.0,
                    "stoppedAt": stopVal.at.timeIntervalSince1970 * 1000.0
                ]
                if stopKey.hasPrefix("seat-"), let num = Int(stopKey.dropFirst(5)), num > 0 {
                    dict["seatNumber"] = num
                    dict["seatLabel"] = "\(num)番席"
                }
                stoppedWatchSeats.append(dict)
            }
        }
        if !stoppedWatchSeats.isEmpty {
            extra["watchStoppedSeats"] = stoppedWatchSeats
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
    
    // ★ "seat-1" 等の初期ローカルIDとクラウドUUIDの双方向すべてに対して保護キーを適用するヘルパー
    private func canonicalSeatId(for seatId: String) -> String {
        if let exact = timers.first(where: { $0.id == seatId }) {
            return exact.id
        }
        if seatId.hasPrefix("seat-"),
           let num = Int(seatId.replacingOccurrences(of: "seat-", with: "")),
           let matched = timers.first(where: { $0.seatNumber == num }) {
            return matched.id
        }
        return seatId
    }

    private func allSeatKeys(for seatId: String, seatNumber: Int = 0) -> [String] {
        var keys = Set<String>([seatId, canonicalSeatId(for: seatId)])
        if seatNumber > 0 {
            keys.insert("seat-\(seatNumber)")
            if let matchedByNum = timers.first(where: { $0.seatNumber == seatNumber }) {
                keys.insert(matchedByNum.id)
            }
        }
        if let matched = timers.first(where: { $0.id == seatId }) {
            keys.insert(matched.id)
            keys.insert("seat-\(matched.seatNumber)")
        } else if seatId.hasPrefix("seat-"),
                  let num = Int(seatId.replacingOccurrences(of: "seat-", with: "")),
                  let matched = timers.first(where: { $0.seatNumber == num }) {
            keys.insert(matched.id)
            keys.insert("seat-\(matched.seatNumber)")
        }
        return Array(keys)
    }

    func isSeatProtectedByRecentLocalAction(seatId: String, seatNumber: Int, within seconds: TimeInterval = 12.0) -> Bool {
        let now = Date()
        var candidateKeys = Set<String>(allSeatKeys(for: seatId, seatNumber: seatNumber))
        if seatNumber > 0 {
            candidateKeys.insert("seat-\(seatNumber)")
            if let matched = timers.first(where: { $0.seatNumber == seatNumber }) {
                candidateKeys.insert(matched.id)
            }
        }
        let currentSeat = timers.first(where: { candidateKeys.contains($0.id) || (seatNumber > 0 && $0.seatNumber == seatNumber) })
        if currentSeat?.isRunning == false {
            for key in candidateKeys {
                if let stop = localStops[key], now.timeIntervalSince(stop.at) < localStopHoldSeconds {
                    return false
                }
            }
        }
        for key in candidateKeys {
            if let modAt = localSeatMods[key], now.timeIntervalSince(modAt) < seconds {
                return true
            }
            if let startedAt = watchStartedSeatTimes[key], now.timeIntervalSince(startedAt) < seconds {
                return true
            }
        }
        return false
    }

    func isSeatLocallyStopped(seatId: String, seatNumber: Int, since minDate: Date? = nil, matchingEndTime: Date? = nil) -> Bool {
        let now = Date()
        var candidateKeys = Set<String>(allSeatKeys(for: seatId, seatNumber: seatNumber))
        if seatNumber > 0 {
            candidateKeys.insert("seat-\(seatNumber)")
            if let matched = timers.first(where: { $0.seatNumber == seatNumber }) {
                candidateKeys.insert(matched.id)
            }
        }
        for key in candidateKeys {
            if let stop = localStops[key], now.timeIntervalSince(stop.at) < localStopHoldSeconds {
                if let minDate = minDate, stop.at < minDate { continue }
                if let matchingEndTime = matchingEndTime,
                   matchingEndTime.timeIntervalSince1970 > 0,
                   stop.end > 0,
                   abs(stop.end - matchingEndTime.timeIntervalSince1970) > 2.5 {
                    continue
                }
                return true
            }
        }
        return false
    }

    func canNormalizeExpiredSeatOnBuildUpdate(_ seat: SeatTimerItem, cutoff: Date) -> Bool {
        guard seat.isRunning else { return true }
        // タイムアップから15分（900秒）以上経過している古い放置超過タイマーは無条件にクリーンアップ対象
        if seat.targetEndTime <= cutoff.addingTimeInterval(-900) {
            return true
        }
        // タイムアップから15分未満の直近超過タイマーは、自分が主担当（または単独利用）かつ他スタッフがヘルプ/チェックに入っていない場合のみ即時クリーンアップ対象とする
        guard seat.targetEndTime <= cutoff else { return false }
        let isMineMain = seat.isCreatorMe(currentUserName: self.currentUserName)
        let hasOtherAssistant: Bool = {
            guard let s = seat.shampooStaff?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !s.isEmpty, s != "ヘルプなし", s != "none", s != "募集中" else { return false }
            return !SeatTimerItem.isStaffMe(s, currentUserName: self.currentUserName)
        }()
        let hasOtherChecker: Bool = {
            guard !seat.isCheckCompleted,
                  let c = seat.checkStaff?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !c.isEmpty, c != "募集中" else { return false }
            return !SeatTimerItem.isStaffMe(c, currentUserName: self.currentUserName)
        }()
        return isMineMain && !hasOtherAssistant && !hasOtherChecker
    }

    // ★ Watch 上（または iPhone 側同期）で席を止めたことを記録（止める前の終了時刻も保存・永続化。メインスレッドで呼ぶ）
    func markLocalStop(seatId: String, endTime: Date) {
        self.hasReceivedAuthoritativeSyncInSession = true
        self.localActionGeneration &+= 1
        let now = Date()
        let endVal = endTime.timeIntervalSince1970
        let matchedSeat = timers.first(where: { $0.id == seatId || "seat-\($0.seatNumber)" == seatId })
        for key in allSeatKeys(for: seatId, seatNumber: matchedSeat?.seatNumber ?? 0) {
            localStops[key] = (at: now, end: endVal)
            watchStartedSeatTimes[key] = nil
            localSeatMods[key] = nil
        }
        persistLocalStops()
        persistWatchStartedSeats()
        removeStopRelatedPeerAlerts(
            forSeatId: matchedSeat?.id ?? seatId,
            seatNumber: matchedSeat?.seatNumber ?? 0,
            displaySeatName: matchedSeat?.displaySeatName ?? ""
        )
    }
    
    func clearLocalStop(seatId: String) {
        self.hasReceivedAuthoritativeSyncInSession = true
        self.localActionGeneration &+= 1
        let now = Date()
        for key in allSeatKeys(for: seatId) {
            localStops[key] = nil
            peerStoppedSeatEnds[key] = nil
            confirmedPeerStoppedSeatEnds[key] = nil
            recentlyClearedPeerStoppedAt[key] = nil
            watchStartedSeatTimes[key] = now
        }
        persistLocalStops()
        persistPeerStoppedSeats()
        persistConfirmedPeerStoppedSeats()
        persistWatchStartedSeats()
    }
    
    // ★ Watch 上でチェック完了・解除したことを記録（メインスレッドで呼ぶ）
    func markLocalCheckClear(seatId: String, checkEndTime: Date?) {
        self.hasReceivedAuthoritativeSyncInSession = true
        self.localActionGeneration &+= 1
        let now = Date()
        let endVal = checkEndTime?.timeIntervalSince1970 ?? 0
        for key in allSeatKeys(for: seatId) {
            localCheckClears[key] = (at: now, checkEnd: endVal)
        }
    }
    
    func clearLocalCheckClear(seatId: String) {
        self.localActionGeneration &+= 1
        for key in allSeatKeys(for: seatId) {
            localCheckClears[key] = nil
        }
    }
    
    // ★ Watch 上で客席のヘルプ・チェック担当・時間微調整等を変更したことを記録（すれ違い通信による巻き戻し防止。メインスレッドで呼ぶ）
    func markLocalSeatMod(seatId: String, seatNumber: Int = 0) {
        self.hasReceivedAuthoritativeSyncInSession = true
        self.localActionGeneration &+= 1
        let now = Date()
        for key in allSeatKeys(for: seatId, seatNumber: seatNumber) {
            localSeatMods[key] = now
        }
    }
    
    // ★ Watch 上で収納・展開したことを記録（nil = 記録を消す。メインスレッドで呼ぶ）
    func setCollapseOverride(seatId: String, collapsed: Bool?) {
        for key in allSeatKeys(for: seatId) {
            collapseOverrides[key] = collapsed
        }
    }
    
    // ★ アラーム通知等から渡された seatId（ローカルID "seat-1" またはクラウドUUID）を現在の timers 配列のインデックスに解決する
    private func findTimerIndex(forSeatId seatId: String) -> Int? {
        if let exact = timers.firstIndex(where: { $0.id == seatId }) {
            return exact
        }
        let cid = canonicalSeatId(for: seatId)
        return timers.firstIndex(where: { canonicalSeatId(for: $0.id) == cid || "seat-\($0.seatNumber)" == cid })
    }

    // ★ アラームの「止める」など、画面外から席を止める（Watch の表示をすぐ 0:00 の停止にする。他スタッフが移行したシャンプー中等の進行状態は保持）
    func applyLocalStop(seatId: String, fallbackEndTime: Date? = nil) {
        if let idx = findTimerIndex(forSeatId: seatId) {
            let actualId = timers[idx].id
            let seatNum = timers[idx].seatNumber
            let end = timers[idx].isRunning ? timers[idx].targetEndTime : (fallbackEndTime ?? timers[idx].targetEndTime)
            let wasPeerStopped = wasRecentlyOrCurrentlyPeerStoppedSeat(seatId: actualId, seatNumber: seatNum, targetEndTime: end)
                || wasRecentlyOrCurrentlyPeerStoppedSeat(seatId: seatId, seatNumber: seatNum, targetEndTime: end)
            let hasPeerActiveProcess = wasPeerStopped && timers[idx].status != .normal
            let clearedCheckEnd = timers[idx].checkTargetEndTime
            if wasPeerStopped {
                clearPeerStoppedSeat(seatId: actualId, seatNumber: seatNum, recordRecentClear: true)
                if actualId != seatId {
                    clearPeerStoppedSeat(seatId: seatId, seatNumber: seatNum, recordRecentClear: true)
                }
            }
            markLocalStop(seatId: actualId, endTime: end)
            setCollapseOverride(seatId: actualId, collapsed: true)
            if actualId != seatId {
                markLocalStop(seatId: seatId, endTime: end)
                setCollapseOverride(seatId: seatId, collapsed: true)
            }
            if let clearedCheckEnd = clearedCheckEnd {
                markLocalCheckClear(seatId: actualId, checkEndTime: clearedCheckEnd)
                if actualId != seatId {
                    markLocalCheckClear(seatId: seatId, checkEndTime: clearedCheckEnd)
                }
            }
            var updated = timers
            updated[idx].isRunning = false
            updated[idx].pausedRemainingSeconds = 0
            updated[idx].totalSeconds = 0
            updated[idx].clearCheck()
            if !hasPeerActiveProcess {
                updated[idx].status = .normal
                updated[idx].shampooStaff = nil
                updated[idx].helpProcess = ""
            }
            updated[idx].isRecruiting = false
            updated[idx].isNoHelpNeeded = false
            updated[idx].isCollapsed = true
            timers = updated
            WatchAlarmCoordinator.shared.update(timers: updated, mainTimer: self.mainTimer, soundOn: self.alarmSoundEnabled, currentUserName: self.currentUserName)
            WidgetSync.save(timers: updated, mainTimer: self.mainTimer, userName: self.currentUserName, forceReload: true)
        } else if let fallbackEndTime = fallbackEndTime {
            markLocalStop(seatId: seatId, endTime: fallbackEndTime)
            setCollapseOverride(seatId: seatId, collapsed: true)
        }
    }
    
    // ★ チェックタイマーのアラーム「止める」などで、Watch の表示を即座にチェック完了にし、残りの全体タイマーを新しいタイマーとして入れ直す（席カードは絶対に閉じない）
    @discardableResult
    func applyLocalCheckComplete(seatId: String, fallbackCheckEndTime: Date? = nil) -> Int? {
        if let idx = findTimerIndex(forSeatId: seatId) {
            let actualId = timers[idx].id
            let checkEnd = timers[idx].checkTargetEndTime ?? fallbackCheckEndTime
            let preservedCheckSec = max(60, timers[idx].checkTotalSeconds ?? 60)
            markLocalCheckClear(seatId: actualId, checkEndTime: checkEnd)
            setCollapseOverride(seatId: actualId, collapsed: false)
            if actualId != seatId {
                markLocalCheckClear(seatId: seatId, checkEndTime: checkEnd)
                setCollapseOverride(seatId: seatId, collapsed: false)
            }
            var updated = timers
            updated[idx].isCheckCompleted = true
            updated[idx].checkStaff = self.currentUserName
            updated[idx].checkTargetEndTime = nil
            updated[idx].checkTotalSeconds = nil
            updated[idx].isCollapsed = false
            timers = updated
            WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                seatId: actualId,
                timers: updated,
                mainTimer: self.mainTimer,
                soundOn: self.alarmSoundEnabled,
                currentUserName: self.currentUserName
            )
            WidgetSync.save(timers: updated, mainTimer: self.mainTimer, userName: self.currentUserName, forceReload: true)
            return preservedCheckSec
        } else {
            markLocalCheckClear(seatId: seatId, checkEndTime: fallbackCheckEndTime)
            return nil
        }
    }
    
    // ★ スマートアラームのバックグラウンド起床時（adopt / didStart / activateSessionRingingAndNotify）に、
    //   WCSessionDelegate よりも先に notifyUser が呼ばれて停止済みタイマーのアラートが出るのを防ぐため、
    //   watchOS (companionappd) に到着済みの最新 receivedApplicationContext を即時同期反映する
    func syncFromLatestApplicationContextIfNewer() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        let ctx = session.receivedApplicationContext
        guard !ctx.isEmpty else { return }
        let ts = (ctx["timestamp"] as? NSNumber)?.doubleValue ?? (ctx["timestamp"] as? Double) ?? 0
        guard ts > 0 && ts > self.lastPayloadTimestamp else { return }
        if Thread.isMainThread {
            self.processReceivedData(ctx, kind: "保存データ")
        } else {
            DispatchQueue.main.sync {
                if ts > self.lastPayloadTimestamp {
                    self.processReceivedData(ctx, kind: "保存データ")
                }
            }
        }
    }

    // ★ 相手からのリアルタイム操作通知（タイマー停止、チェック完了、シャンプー開始、コーミング移行等）
    //   メインタイマー同期等の新しい timestamp が先行到着していた場合でも、別経路（transferUserInfo / sendMessage）で届いた
    //   未読の notifId を取りこぼさないよう、古いスナップショット早期 return より前に判定・発火する。
    //   保存データ（applicationContext）や90秒以上前の古いデータでは発火させず、sourceUser == "__remote__" のみ発火して自己エコーを防止する。
    @discardableResult
    private func handleIncomingPeerNotificationIfNeeded(_ data: [String: Any], kind: String, payloadTs: Double, nowMs: Double) -> Bool {
        guard let notif = data["notification"] as? [String: Any],
              let text = notif["text"] as? String,
              !text.isEmpty else {
            return false
        }
        let notifId = notif["id"] as? String ?? ""
        let isFreshSavedContext = (kind == "保存データ" && !notifId.isEmpty && payloadTs > 0 && abs(nowMs - payloadTs) <= 25_000)
        let isRecentNotif = ((kind != "保存データ") && (payloadTs <= 0 || abs(nowMs - payloadTs) <= 90_000)) || isFreshSavedContext
        guard isRecentNotif else { return false }
        let colorHex = notif["color"] as? String ?? "#30D158"
        let timeStr = notif["time"] as? String
        let sourceUser = notif["sourceUser"] as? String ?? ""
        guard sourceUser == "__remote__" else { return false }

        let eventType = (notif["eventType"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let notifSeatId = (notif["seatId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let notifSeatNum = (notif["seatNumber"] as? NSNumber)?.intValue ?? (notif["seatNumber"] as? Int) ?? 0
        let notifSeatLabel = (notif["seatLabel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let semanticKey = (notif["semanticKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if !notifId.isEmpty {
            if notifId == self.lastHandledPeerNotifId || self.handledPeerNotifIds.contains(notifId) {
                return false
            }
            self.lastHandledPeerNotifId = notifId
            self.handledPeerNotifIds.append(notifId)
            if self.handledPeerNotifIds.count > 30 {
                self.handledPeerNotifIds.removeFirst(self.handledPeerNotifIds.count - 30)
            }
            UserDefaults.standard.set(self.handledPeerNotifIds, forKey: self.savedHandledPeerNotifIdsKey)
        }

        // ★ A-3 / Round2: semanticKey（timerId|eventType|actorId|stateDisc）による45秒重複排除
        //   同一イベントが sendMessage と transferUserInfo 等から重複到着した場合は1回に統合しつつ、
        //   直接クラウドポーリングで既に先行処理されていた場合は担当者名入り文面の静かな差し替えのみ許可して2回目の振動を抑止し、
        //   A→B→A（ロール系状態遷移）は旧キー即時パージにより必ず通過させる
        var alreadyHandledByDirectPoll = false
        if !semanticKey.isEmpty {
            let nowSec = nowMs / 1000.0
            if self.hasHandledPeerSemanticKey(semanticKey, channel: "wcsession_self", nowSec: nowSec) {
                return false
            }
            alreadyHandledByDirectPoll = self.hasHandledPeerSemanticKey(semanticKey, channel: "direct_poll_cross", nowSec: nowSec)
            self.recordHandledPeerSemanticKey(
                semanticKey,
                channel: "wcsession",
                seatId: notifSeatId,
                seatNumber: notifSeatNum,
                seatLabel: notifSeatLabel,
                eventType: eventType,
                nowSec: nowSec
            )
        }

        let isGentleInfo = eventType.hasPrefix("unassign_")
        let fireAlert = {
            if alreadyHandledByDirectPoll {
                // 直接クラウドポーリングで先行表示済みの同一状態バナーに担当者名が欠落していた場合のみ静かにインプレース昇格（再振動・新規バナー追加はしない）
                let hasPendingBannerForSeat = self.unconfirmedPeerAlerts.contains { existing in
                    let sameSeat = (notifSeatNum > 0 && existing.seatNumber == notifSeatNum)
                        || (!notifSeatId.isEmpty && existing.seatId == notifSeatId)
                    guard sameSeat else { return false }
                    if !existing.semanticKey.isEmpty && !semanticKey.isEmpty {
                        return Self.isSamePeerSemanticState(existing.semanticKey, semanticKey) || existing.eventType == "timer_start"
                    }
                    return true
                }
                if hasPendingBannerForSeat {
                    _ = self.enqueuePeerConfirmationAlert(
                        id: notifId.isEmpty ? "peer_\(safeEpochMillisInt64(nowMs))" : notifId,
                        text: text,
                        colorHex: colorHex,
                        timeText: timeStr,
                        eventType: eventType,
                        seatId: notifSeatId,
                        seatNumber: notifSeatNum,
                        seatLabel: notifSeatLabel,
                        semanticKey: semanticKey
                    )
                }
                return
            }
            let didAdd = self.enqueuePeerConfirmationAlert(
                id: notifId.isEmpty ? "peer_\(safeEpochMillisInt64(nowMs))" : notifId,
                text: text,
                colorHex: colorHex,
                timeText: timeStr,
                eventType: eventType,
                seatId: notifSeatId,
                seatNumber: notifSeatNum,
                seatLabel: notifSeatLabel,
                semanticKey: semanticKey
            )
            if didAdd {
                self.incomingNotification = (text: text, color: colorHex, eventType: eventType)
                WatchAlarmCoordinator.shared.postPeerActionNotification(
                    text: text,
                    forceSystemBanner: self.isModalSheetCurrentlyPresented,
                    isGentleInfo: isGentleInfo,
                    eventType: eventType
                )
            }
        }
        if Thread.isMainThread {
            fireAlert()
        } else {
            DispatchQueue.main.async(execute: fireAlert)
        }
        return true
    }

    func processReceivedData(_ data: [String: Any], kind: String = "-") {
        // ★ 古いデータ（後から届いた保存データやコールド起動時に再配信される receivedApplicationContext）は無視。
        //   lastPayloadTimestamp を永続化し、10分超の長時間施術タイマーのタイムアップバックグラウンド起床時でも
        //   開始前の古い保存データ（applicationContext）で稼働中タイマーやスマートアラームが消火されるのを完全防止する。
        //   （※iPhone の時計が過去に巻き戻された異常時のみ、現在時刻+2分超の保存値を無効化して受け入れる）
        let previousPayloadTimestamp = self.lastPayloadTimestamp
        let nowCheckMs = Date().timeIntervalSince1970 * 1000.0
        let incomingPayloadTs = (data["timestamp"] as? NSNumber)?.doubleValue ?? (data["timestamp"] as? Double) ?? 0

        // ★ タイムスタンプ逆転による古い seats/mainTimer 早期破棄より前に、未処理の共有相手通知（notifId）だけは確実に取り出して通知発火する
        let didAcceptFreshPeerNotification = handleIncomingPeerNotificationIfNeeded(data, kind: kind, payloadTs: incomingPayloadTs, nowMs: nowCheckMs)

        if incomingPayloadTs > 0,
           (data["seats"] != nil || data["mainTimer"] != nil) {
            let isSavedTsValid = (previousPayloadTimestamp > 0 && previousPayloadTimestamp <= nowCheckMs + 120_000)
            if isSavedTsValid {
                if (kind == "保存データ" && incomingPayloadTs <= previousPayloadTimestamp) || incomingPayloadTs < previousPayloadTimestamp {
                    self.lastReceivedKind = "\(kind)(古いデータのため無視)"
                    return
                }
            }
            lastPayloadTimestamp = incomingPayloadTs
        }
        
        // ★ 診断用: 受信記録
        self.receivedCount += 1
        self.lastReceivedAt = Date()
        self.lastReceivedKind = kind
        
        // スタッフ名同期
        if let name = data["userName"] as? String, !name.isEmpty {
            self.currentUserName = name
        }

        // クラウド共有サロンID・ユーザーID同期（Watch単独直接クラウドPATCH・ポーリング用）
        // ※ iPhone起動直後の未ロード状態で送られる "workspace-free" 等で有効なUUIDが上書き消去されるのを防ぐ
        var didUpdateCloudIdentity = false
        if let incomingSalonId = data["salonId"] as? String {
            let trimmedSalonId = incomingSalonId.trimmingCharacters(in: .whitespacesAndNewlines)
            if Self.isValidCloudUUID(trimmedSalonId) && trimmedSalonId != self.cloudSalonId {
                self.cloudSalonId = trimmedSalonId
                didUpdateCloudIdentity = true
            }
        }
        if let incomingUid = data["userId"] as? String {
            let trimmedUid = incomingUid.trimmingCharacters(in: .whitespacesAndNewlines)
            if Self.isValidCloudUUID(trimmedUid) && trimmedUid != self.cloudUserId {
                self.cloudUserId = trimmedUid
                didUpdateCloudIdentity = true
            }
        }
        
        // 登録メンバー一覧同期（型ゆらぎを許容して確実にパース）
        if let membersArray = (data["members"] as? [String]) ?? (data["members"] as? [Any])?.compactMap({ $0 as? String }) {
            self.members = membersArray
        }
        if let rawMemberMap = data["memberIdMap"] as? [String: Any] {
            var updatedMap = self.memberIdMap
            for (k, v) in rawMemberMap {
                if let nameVal = v as? String, !nameVal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    updatedMap[k] = nameVal.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            }
            self.memberIdMap = updatedMap
            UserDefaults.standard.set(updatedMap, forKey: self.savedMemberIdMapKey)
            appGroupDefaults?.set(updatedMap, forKey: self.savedMemberIdMapKey)
        }
        // ★ 自端末ユーザーの別名・カスタム呼び名リスト同期（別端末からカスタム呼び名で指名された場合も確実に自分を判定）
        var mergedAliases: [String] = []
        var seenNormAliases = Set<String>()
        let appendAlias = { (candidate: String?) in
            guard let raw = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !raw.isEmpty,
                  raw != "スタイリスト",
                  raw != "ヘルプなし",
                  raw != "none",
                  raw != "未定",
                  raw != "募集中" else { return }
            let norm = raw.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "　", with: "").lowercased()
            guard !norm.isEmpty, !seenNormAliases.contains(norm) else { return }
            seenNormAliases.insert(norm)
            mergedAliases.append(raw)
        }
        appendAlias(self.currentUserName)
        if !self.cloudUserId.isEmpty {
            appendAlias(self.memberIdMap[self.cloudUserId])
        }
        if let rawAliases = (data["userAliases"] as? [String]) ?? (data["userAliases"] as? [Any])?.compactMap({ $0 as? String }) {
            for alias in rawAliases {
                appendAlias(alias)
            }
        } else {
            for existingAlias in self.currentUserAliases {
                appendAlias(existingAlias)
            }
        }
        if mergedAliases != self.currentUserAliases {
            self.currentUserAliases = mergedAliases
            if data["seats"] == nil && data["mainTimer"] == nil {
                WatchAlarmCoordinator.shared.update(
                    timers: self.timers,
                    mainTimer: self.mainTimer,
                    soundOn: self.alarmSoundEnabled,
                    currentUserName: self.currentUserName
                )
                WidgetSync.save(
                    timers: self.timers,
                    mainTimer: self.mainTimer,
                    userName: self.currentUserName,
                    forceReload: true
                )
            }
        }
        
        let payloadTs = incomingPayloadTs
        let nowMs = Date().timeIntervalSince1970 * 1000.0
        let isStaleSnapshot = (payloadTs > 0 && nowMs - payloadTs > 60_000) || (kind == "保存データ" && (payloadTs <= 0 || nowMs - payloadTs > 15_000))
        // ★ Watchが手首下げ（バックグラウンド）中にiPhoneまたは共有相手がタイマーを停止・一時停止・リセットし、
        //   applicationContext（保存データ）または15〜60秒以上経過した transferUserInfo で届いた場合でも、
        //   前回受信した lastPayloadTimestamp より確実に新しいペイロード（isGenuinelyNewerPayload）であれば
        //   古いスナップショット扱いして停止済みアラームを復活させない
        let isGenuinelyNewerPayload = (payloadTs > 0 && previousPayloadTimestamp > 0 && payloadTs > previousPayloadTimestamp)
        let isStaleContextForAlarm = !isGenuinelyNewerPayload && isStaleSnapshot
        
        // ★ Watch 側アラーム音の設定
        if let sound = (data["watchAlarmSound"] as? NSNumber)?.boolValue ?? (data["watchAlarmSound"] as? Bool) {
            if sound != self.alarmSoundEnabled {
                self.alarmSoundEnabled = sound
                UserDefaults.standard.set(sound, forKey: "assisttimer.watchAlarmSound.v2")
            }
        }
        
        // ★ サロンオーナー権限フラグ同期（席の増減は招待元オーナーのみ許可）
        if let ownerFlag = (data["isSalonOwner"] as? NSNumber)?.boolValue ?? (data["isSalonOwner"] as? Bool) {
            if ownerFlag != self.isSalonOwner {
                self.isSalonOwner = ownerFlag
            }
        }
        
        // メインタイマー同期（Watch主導の予約時刻を保護しつつ、iPhoneからの最新状態と同期）
        var didUpdateMain = false
        if let rawMain = data["mainTimer"] as? [String: Any], var parsedMain = SeatTimerItem(dictionary: rawMain) {
            let nowDate = Date()
            if let cur = self.mainTimer {
                if rawMain["isCountUpEnabled"] == nil {
                    parsedMain.isCountUpEnabled = cur.isCountUpEnabled
                }
                if rawMain["helpProcess"] == nil {
                    parsedMain.helpProcess = cur.helpProcess
                }
                if rawMain["isNoHelpNeeded"] == nil {
                    parsedMain.isNoHelpNeeded = cur.isNoHelpNeeded
                }
                if rawMain["watchAlarmSoundEnabled"] == nil {
                    parsedMain.watchAlarmSoundEnabled = cur.watchAlarmSoundEnabled
                }
            } else if rawMain["watchAlarmSoundEnabled"] == nil {
                parsedMain.watchAlarmSoundEnabled = (UserDefaults.standard.object(forKey: "assisttimer.mainTimerWatchSound.v2") as? Bool) ?? false
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
            // ★ メインタイマーは「タイマーを止める」が明示的に押されるまで超過（カウントアップ）を維持する。
            //   3時間以内は継続させ、3時間以上前の放置データまたはビルド更新起動時刻以前に期限切れだった残留データのみ自動停止
            if parsedMain.isRunning || parsedMain.isPreCountingDown {
                let effectiveCutoff = self.buildUpdateExpiryCutoff ?? nowDate.addingTimeInterval(-10800)
                if parsedMain.targetEndTime <= effectiveCutoff || parsedMain.targetEndTime <= nowDate.addingTimeInterval(-10800) {
                    parsedMain.isRunning = false
                    parsedMain.isPreCountingDown = false
                    parsedMain.preCountdownSeconds = 0
                    parsedMain.prepEndTime = nil
                    parsedMain.pausedRemainingSeconds = 0
                    parsedMain.isAutoFinished = false
                }
            }
            // ★ Watch側ですでに稼働中または準備カウントダウン中のメインタイマーがあり、iPhoneから同一設定時間の稼働データ（往復同期）が返ってきた場合は、
            //   Watch側で予約済みの targetEndTime / prepEndTime を維持してスマートアラームの破棄・再予約衝突を防止する
            if let cur = self.mainTimer,
               (cur.isRunning || cur.isPreCountingDown),
               (parsedMain.isRunning || parsedMain.isPreCountingDown),
               cur.totalSeconds == parsedMain.totalSeconds {
                if ((cur.targetEndTime > nowDate) == (parsedMain.targetEndTime > nowDate) &&
                    abs(cur.targetEndTime.timeIntervalSince(parsedMain.targetEndTime)) <= 10) ||
                   (cur.targetEndTime <= nowDate && parsedMain.targetEndTime <= nowDate.addingTimeInterval(2)) {
                    parsedMain.targetEndTime = cur.targetEndTime
                }
                if cur.isPreCountingDown && parsedMain.isPreCountingDown,
                   let curPrep = cur.prepEndTime, let incPrep = parsedMain.prepEndTime,
                   abs(curPrep.timeIntervalSince(incPrep)) <= 10 {
                    parsedMain.prepEndTime = curPrep
                }
            }
            let msgType = (data["type"] as? String) ?? ""
            let isExplicitStop = (rawMain["explicitStop"] as? NSNumber)?.boolValue ?? (rawMain["explicitStop"] as? Bool) ?? false
            let isExplicitReset = (rawMain["isExplicitReset"] as? NSNumber)?.boolValue ?? (rawMain["isExplicitReset"] as? Bool) ?? false
            let isPausedOnPhone = (rawMain["isPaused"] as? NSNumber)?.boolValue ?? (rawMain["isPaused"] as? Bool) ?? false
            let isAutoFinished = (rawMain["isAutoFinished"] as? Bool) == true || (rawMain["isAutoFinished"] as? NSNumber)?.boolValue == true
            parsedMain.isAutoFinished = isAutoFinished
            let incomingLastResetEndMs = (rawMain["lastResetTargetEndTimestamp"] as? NSNumber)?.doubleValue ?? (rawMain["lastResetTargetEndTimestamp"] as? Double) ?? 0
            let incomingLastResetEndSec = incomingLastResetEndMs > 1e11 ? (incomingLastResetEndMs / 1000.0) : incomingLastResetEndMs
            let incomingLastResetAtMs = (rawMain["lastResetAt"] as? NSNumber)?.doubleValue ?? (rawMain["lastResetAt"] as? Double) ?? 0
            let incomingLastResetAtSec = incomingLastResetAtMs > 1e11 ? (incomingLastResetAtMs / 1000.0) : incomingLastResetAtMs
            let curEndSec = self.mainTimer?.targetEndTime.timeIntervalSince1970 ?? 0
            let curStartSec = curEndSec > 0 ? (curEndSec - Double(self.mainTimer?.totalSeconds ?? 600)) : 0
            let matchesCurrentEndOnPhone = (incomingLastResetEndSec > 0 && curEndSec > 0 && abs(incomingLastResetEndSec - curEndSec) <= 15)
            let resetAfterCurrentStart = (incomingLastResetAtSec > 0 && curStartSec > 0 && incomingLastResetAtSec > max(curStartSec + 1.0, self.lastMainTimerLocalActionTime.timeIntervalSince1970 + 0.5))
            let isCurrentTimerStoppedOnPhone = !isAutoFinished && !parsedMain.isRunning && !parsedMain.isPreCountingDown && (
                matchesCurrentEndOnPhone ||
                ((!isStaleSnapshot || isGenuinelyNewerPayload) && resetAfterCurrentStart)
            )
            let isPhoneStopAfterLocalStart = isCurrentTimerStoppedOnPhone && (
                matchesCurrentEndOnPhone ||
                (incomingLastResetAtSec > self.lastMainTimerLocalActionTime.timeIntervalSince1970 + 0.2)
            )
            let isHoldingLocalStart = !isPhoneStopAfterLocalStart &&
                (nowDate.timeIntervalSince(self.lastMainTimerLocalActionTime) < self.mainTimerLocalHoldSeconds) &&
                (self.lastMainTimerLocalActionType == "START" || self.lastMainTimerLocalActionType == "SET_TIME")
            let isAuthoritativePhoneStop = (
                isPhoneStopAfterLocalStart ||
                ((!isStaleSnapshot || isGenuinelyNewerPayload) && !isHoldingLocalStart && (
                    isCurrentTimerStoppedOnPhone ||
                    (msgType == "SYNC_MAIN_TIMER" && !isAutoFinished && (isExplicitStop || isExplicitReset || (!parsedMain.isRunning && !parsedMain.isPreCountingDown && isPausedOnPhone)))
                ))
            )
            // ★ iPhone側が同一メインタイマーの稼働（isRunning または isPreCountingDown）に追いついたか、
            //   またはiPhone側で明示的にリセット・終了されたら、Watch単独保護フラグを解除して以降の双方向停止を有効化
            if let watchEnd = self.watchStartedMainTimerEndTime {
                if parsedMain.isRunning || parsedMain.isPreCountingDown {
                    if abs(parsedMain.targetEndTime.timeIntervalSince(watchEnd)) <= 20 || parsedMain.totalSeconds == self.mainTimer?.totalSeconds {
                        self.watchStartedMainTimerEndTime = parsedMain.targetEndTime
                    }
                } else if isAuthoritativePhoneStop {
                    // iPhone側で明示的に現在のタイマーがリセット・停止された場合のみ Watch単独保護フラグを解除する（SYNC_SEATSの古いキャッシュやREQUEST_SYNCの未稼働返信では消さない）
                    self.watchStartedMainTimerEndTime = nil
                }
            }
            let isWatchOwnedActive: Bool = {
                guard let watchEnd = self.watchStartedMainTimerEndTime,
                      watchEnd > nowDate.addingTimeInterval(-10800),
                      let cur = self.mainTimer,
                      (cur.isRunning || cur.isPreCountingDown) else { return false }
                if isAuthoritativePhoneStop { return false }
                let isUnstartedInitial = !parsedMain.isRunning && !parsedMain.isPreCountingDown
                // iPhoneがスリープ中・未反映のまま送られてきた SYNC_SEATS 同梱データや保存データ、未反映初期スナップショットによる強制停止をブロック
                return msgType == "SYNC_SEATS" || (isStaleSnapshot && !isGenuinelyNewerPayload) || isUnstartedInitial
            }()
            let timeSinceLocalAction = nowDate.timeIntervalSince(self.lastMainTimerLocalActionTime)
            let isLocalStartOrAdjustOverriddenByPhoneStop = isAuthoritativePhoneStop && (
                self.lastMainTimerLocalActionType == "START" ||
                self.lastMainTimerLocalActionType == "SET_TIME" ||
                self.lastMainTimerLocalActionType == "ADJUST"
            )
            let isRecentlyModifiedOnWatch = !isLocalStartOrAdjustOverriddenByPhoneStop && (timeSinceLocalAction < self.mainTimerLocalHoldSeconds)
            let isBlockedByLocalStop: Bool = {
                guard self.lastMainTimerLocalActionType == "RESET" || self.lastMainTimerLocalActionType == "PAUSE" else { return false }
                guard timeSinceLocalAction < self.mainTimerStopHoldSeconds else { return false }
                guard parsedMain.isRunning || parsedMain.isPreCountingDown else { return false }
                if self.lastMainTimerLocalStopEndTime > 0 {
                    if abs(parsedMain.targetEndTime.timeIntervalSince1970 - self.lastMainTimerLocalStopEndTime) <= 10 || parsedMain.targetEndTime <= nowDate {
                        return true
                    }
                    // 新しい未来の終了時刻（停止したタイマーと10秒超異なる未来の時刻）で稼働開始された場合はブロックしない
                    if parsedMain.targetEndTime > nowDate.addingTimeInterval(2) && (!isStaleSnapshot || isGenuinelyNewerPayload) {
                        return false
                    }
                }
                if timeSinceLocalAction < 2.0 || parsedMain.targetEndTime <= nowDate || (isStaleSnapshot && !isGenuinelyNewerPayload) {
                    return true
                }
                return false
            }()
            
            if isBlockedByLocalStop {
                // ★ Watchで停止・終了した直後に、iPhoneからまだ反映前の古い稼働中・超過データが返ってきた場合はリセット・停止状態（00:00）を死守
                if self.lastMainTimerLocalActionType == "RESET", var cur = self.mainTimer {
                    cur.isRunning = false
                    cur.isPreCountingDown = false
                    cur.isAutoFinished = false
                    cur.pausedRemainingSeconds = 0
                    cur.helpProcess = ""
                    cur.isNoHelpNeeded = false
                    cur.targetEndTime = Date().addingTimeInterval(TimeInterval(cur.totalSeconds))
                    self.mainTimer = cur
                }
            } else if isRecentlyModifiedOnWatch {
                let isNewFutureTimerFromPhone = (parsedMain.isRunning && parsedMain.targetEndTime > nowDate.addingTimeInterval(2)) || parsedMain.isPreCountingDown
                if self.lastMainTimerLocalActionType == "RESET" {
                    if isNewFutureTimerFromPhone {
                        // Watch停止後にiPhone等で新しい未来の終了時刻を持つタイマーが開始された場合は即時反映
                        self.mainTimer = parsedMain
                        self.lastMainTimerLocalActionTime = Date.distantPast
                        self.lastMainTimerLocalStopEndTime = 0
                        self.persistMainTimerStopState()
                        didUpdateMain = true
                    } else {
                        parsedMain.isRunning = false
                        parsedMain.isPreCountingDown = false
                        parsedMain.isAutoFinished = false
                        parsedMain.pausedRemainingSeconds = 0
                        parsedMain.helpProcess = ""
                        parsedMain.isNoHelpNeeded = false
                        parsedMain.targetEndTime = Date().addingTimeInterval(TimeInterval(parsedMain.totalSeconds))
                        self.mainTimer = parsedMain
                        didUpdateMain = true
                    }
                } else if self.lastMainTimerLocalActionType == "PAUSE" {
                    if isNewFutureTimerFromPhone {
                        self.mainTimer = parsedMain
                        self.lastMainTimerLocalActionTime = Date.distantPast
                        self.lastMainTimerLocalStopEndTime = 0
                        self.persistMainTimerStopState()
                        didUpdateMain = true
                    } else {
                        parsedMain.isRunning = false
                        parsedMain.isPreCountingDown = false
                        parsedMain.isAutoFinished = false
                        if parsedMain.pausedRemainingSeconds <= 0 {
                            parsedMain.pausedRemainingSeconds = 0
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
                    let sameRunningAdjusted = (parsedMain.isRunning == (self.mainTimer?.isRunning ?? false) && abs(curRem - parsedMain.remainingSeconds) <= 5)
                    let sameStoppedTotal = (!parsedMain.isRunning && !(self.mainTimer?.isRunning ?? false) && parsedMain.totalSeconds == self.mainTimer?.totalSeconds)
                    if sameRunningAdjusted || sameStoppedTotal || ((isExplicitStop || isExplicitReset || isCurrentTimerStoppedOnPhone) && (!isStaleSnapshot || isGenuinelyNewerPayload)) {
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
                let isLocalOvertime = (self.mainTimer?.isRunning == true && (self.mainTimer?.targetEndTime ?? nowDate) <= nowDate)
                let isPhoneCurrentlyStoppedOrPaused = !parsedMain.isRunning && !parsedMain.isPreCountingDown && !isAutoFinished && (!isStaleSnapshot || isGenuinelyNewerPayload) && !isHoldingLocalStart && !isWatchOwnedActive
                let isDirectPhoneStop = isCurrentTimerStoppedOnPhone || isAuthoritativePhoneStop || isPhoneCurrentlyStoppedOrPaused
                let shouldKeepOvertimeOnStaleSeatSync = isLocalOvertime && msgType == "SYNC_SEATS" && isStaleSnapshot && !isGenuinelyNewerPayload
                // ★ メインタイマーが00:00に到達しただけで「タイマーを止める」が押されていない場合（isAutoFinished または 古いSYNC_SEATS到着時の超過継続中）は、
                //   明示的な停止・リセット（isExplicitReset / isExplicitStop / isDirectPhoneStop）でない限り Watch側では00:00に戻さず超過（カウントアップ）状態を維持する
                if (isAutoFinished || shouldKeepOvertimeOnStaleSeatSync) && !isExplicitReset && !isExplicitStop && !isDirectPhoneStop,
                   let cur = self.mainTimer,
                   cur.isRunning {
                    parsedMain.isRunning = true
                    parsedMain.isPreCountingDown = false
                    parsedMain.targetEndTime = cur.targetEndTime
                }
                if !parsedMain.isRunning && !parsedMain.isPreCountingDown {
                    if isDirectPhoneStop || isExplicitReset || isExplicitStop {
                        parsedMain.isAutoFinished = false
                    }
                    let prevCur = self.mainTimer
                    let isMidCountdownPause = isPausedOnPhone && !isExplicitReset && parsedMain.pausedRemainingSeconds > 0
                    if let cur = prevCur, (cur.isRunning || cur.isPreCountingDown) {
                        self.lastMainTimerLocalActionTime = nowDate
                        self.lastMainTimerLocalActionType = isMidCountdownPause ? "PAUSE" : "RESET"
                        self.lastMainTimerLocalStopEndTime = cur.targetEndTime.timeIntervalSince1970
                        self.watchStartedMainTimerEndTime = nil
                        self.persistMainTimerStopState()
                    }
                    if isExplicitReset || (!isMidCountdownPause && isExplicitStop) || parsedMain.pausedRemainingSeconds <= 0 {
                        parsedMain.pausedRemainingSeconds = 0
                        if isExplicitReset || (!isMidCountdownPause && isExplicitStop) {
                            parsedMain.helpProcess = ""
                            parsedMain.isNoHelpNeeded = false
                        }
                    } else if !isMidCountdownPause,
                              parsedMain.pausedRemainingSeconds == parsedMain.totalSeconds,
                              let cur = prevCur,
                              !cur.isRunning && !cur.isPreCountingDown && cur.pausedRemainingSeconds == 0 {
                        // Watch側で既に00:00リセット待機中のときは、iPhoneの定期SYNC_SEATSによる初期設定秒数で00:00表示を上書きしない
                        parsedMain.pausedRemainingSeconds = 0
                    }
                    let canTrustMainStop = !isAutoFinished && (!isStaleSnapshot || isGenuinelyNewerPayload || isCurrentTimerStoppedOnPhone)
                    if canTrustMainStop {
                        let wasPrevActive = (prevCur?.isRunning == true || prevCur?.isPreCountingDown == true)
                        let shouldAcknowledge = isExplicitReset || isExplicitStop || isCurrentTimerStoppedOnPhone || wasPrevActive || WatchAlarmCoordinator.shared.isMainTimerRingingOrDue
                        if shouldAcknowledge {
                            WatchAlarmCoordinator.shared.acknowledgeMainTimer()
                        }
                    }
                } else if parsedMain.isRunning || parsedMain.isPreCountingDown {
                    // 新しい終了時刻で稼働開始したことが確認できたら、古い停止ブロックを解除
                    if self.lastMainTimerLocalStopEndTime > 0,
                       abs(parsedMain.targetEndTime.timeIntervalSince1970 - self.lastMainTimerLocalStopEndTime) > 2 {
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
            let parsedPairs: [(item: SeatTimerItem, raw: [String: Any])] = rawSeats.compactMap { elem in
                if let dict = elem as? [String: Any], let item = SeatTimerItem(dictionary: dict) {
                    return (item: item, raw: dict)
                }
                return nil
            }
            var parsed = parsedPairs.map { $0.item }
            // ★ 安全防御: すでに客席がある場合、空配列による全消滅・強制停止を鉄壁ブロック（明示クリアまたはゲスト初期サンプル席のみ例外許可）
            let isGuestInitialPlaceholder = (!self.isSalonOwner && self.timers.count == 1 && self.timers[0].id == "seat-1" && !self.timers[0].isRunning)
            let allowClear = ((data["clearAllSeats"] as? NSNumber)?.boolValue ?? (data["clearAllSeats"] as? Bool) ?? false) || isGuestInitialPlaceholder
            if parsed.isEmpty && !self.timers.isEmpty && !allowClear {
                // 稼働中・停止中問わず、空データによる客席全滅を完全ブロック
                if didUpdateMain {
                    WatchAlarmCoordinator.shared.update(
                        timers: self.timers,
                        mainTimer: self.mainTimer,
                        soundOn: self.alarmSoundEnabled,
                        currentUserName: self.currentUserName,
                        isStaleContextSnapshot: isStaleContextForAlarm
                    )
                    WidgetSync.save(timers: self.timers, mainTimer: self.mainTimer, userName: self.currentUserName, forceReload: true)
                }
            } else {
                // ★ Watch で止めたのに、まだ「止める前と同じ終了時刻で稼働中」のデータが届いた場合は、
                //   iPhone がまだ反映していないだけなので停止のままにする（最大60秒）
                let nowDate = Date()
                let rawNotifDict = data["notification"] as? [String: Any]
                let rawNotifId = (rawNotifDict?["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let rawNotifText = (rawNotifDict?["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let notifTargetSeatId = (rawNotifDict?["seatId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let explicitNotifSeatNum = (rawNotifDict?["seatNumber"] as? NSNumber)?.intValue ?? (rawNotifDict?["seatNumber"] as? Int) ?? 0
                let extractedNotifSeatNum = explicitNotifSeatNum > 0
                    ? explicitNotifSeatNum
                    : (rawNotifText.isEmpty ? 0 : (Self.extractPeerAlertSeatAndKind(Self.stripLeadingBracketTime(rawNotifText).body, id: rawNotifId).seatNumber ?? 0))
                let cleanNotifSeatLabel = ((rawNotifDict?["seatLabel"] as? String) ?? "")
                    .replacingOccurrences(of: "席", with: "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                var didProtectWatchStartedSeats = false
                for i in parsed.indices {
                    let id = parsed[i].id
                    let rawSeat = parsedPairs[i].raw
                    let lastStoppedAtMs = (rawSeat["lastStoppedAt"] as? NSNumber)?.doubleValue ?? (rawSeat["lastStoppedAt"] as? Double) ?? 0
                    let lastStoppedAtSec = lastStoppedAtMs > 0 ? (lastStoppedAtMs / 1000.0) : 0
                    let lastStoppedEndMs = (rawSeat["lastStoppedTargetEndTimestamp"] as? NSNumber)?.doubleValue ?? (rawSeat["lastStoppedTargetEndTimestamp"] as? Double) ?? 0
                    let lastStoppedEndSec = lastStoppedEndMs > 0 ? (lastStoppedEndMs / 1000.0) : 0
                    let incomingPeerStoppedEndMs = (rawSeat["peerStoppedTargetEndTimestamp"] as? NSNumber)?.doubleValue ?? (rawSeat["peerStoppedTargetEndTimestamp"] as? Double) ?? 0
                    if incomingPeerStoppedEndMs > 0 {
                        self.markPeerStoppedSeat(seatId: id, seatNumber: parsed[i].seatNumber, endTimeEpoch: incomingPeerStoppedEndMs / 1000.0)
                    } else if parsed[i].isRunning {
                        let newRunEndEpoch = parsed[i].targetEndTime.timeIntervalSince1970
                        if !self.isPeerStoppedSeat(seatId: id, seatNumber: parsed[i].seatNumber, endTimeEpoch: newRunEndEpoch) {
                            self.clearPeerStoppedSeat(seatId: id, seatNumber: parsed[i].seatNumber, recordRecentClear: false)
                        }
                    }
                    // ★ 超過カウントアップ中（3時間以内）の稼働席は勝手に00:00へリセットしないが、3時間以上前（-10800秒）の放置データ、
                    //   またはTestFlightビルド更新起動時刻（起動後60秒以内）以前に期限切れだった古い超過残留データ（他スタッフが担当中の15分未満超過を除く）は00:00停止へ正規化
                    let activeBuildCutoff: Date? = self.buildUpdateExpiryCutoff.flatMap { nowDate.timeIntervalSince($0) <= 60.0 ? $0 : nil }
                    let shouldNormalizeOnBuildCutoff = activeBuildCutoff.map { self.canNormalizeExpiredSeatOnBuildUpdate(parsed[i], cutoff: $0) } ?? false
                    if parsed[i].isRunning && (shouldNormalizeOnBuildCutoff || parsed[i].targetEndTime <= nowDate.addingTimeInterval(-10800)) {
                        parsed[i].isRunning = false
                        parsed[i].totalSeconds = 0
                        parsed[i].pausedRemainingSeconds = 0
                        parsed[i].targetEndTime = Date(timeIntervalSince1970: 0)
                        parsed[i].status = .normal
                        parsed[i].shampooStaff = nil
                        parsed[i].helpProcess = ""
                        parsed[i].isRecruiting = false
                        parsed[i].isNoHelpNeeded = false
                        parsed[i].isCollapsed = true
                        parsed[i].clearCheck()
                    } else if let buildCutoff = activeBuildCutoff, parsed[i].isRunning, parsed[i].targetEndTime <= buildCutoff {
                        if let chkEnd = parsed[i].checkTargetEndTime, chkEnd <= buildCutoff.addingTimeInterval(-900) {
                            parsed[i].clearCheck()
                        }
                    } else if let buildCutoff = activeBuildCutoff,
                              let chkEnd = parsed[i].checkTargetEndTime,
                              chkEnd <= buildCutoff {
                        let hasOtherChecker: Bool = {
                            guard !parsed[i].isCheckCompleted,
                                  let c = parsed[i].checkStaff?.trimmingCharacters(in: .whitespacesAndNewlines),
                                  !c.isEmpty, c != "募集中" else { return false }
                            return !SeatTimerItem.isStaffMe(c, currentUserName: self.currentUserName)
                        }()
                        if chkEnd <= buildCutoff.addingTimeInterval(-900) || !hasOtherChecker {
                            parsed[i].clearCheck()
                        }
                    }
                    // ★ Watch で直近12秒以内に行われた客席操作（タイム入力開始・ヘルプ募集・担当指名・時間微調整等）は、iPhone側の未反映 SYNC_SEATS やクラウド遅延ポーリングで巻き戻されないよう保持する
                    //   ※ 1回目のSYNC_SEATSが一致したからといって localSeatMods / watchStartedSeatTimes を即nilクリアすると、0.2秒後に到着した古い直接ポーリング結果で 00:00 に巻き戻されるため、ホールド期間（12秒〜15秒）満了または明示的な停止まで保持する
                    //   ※ Supabaseクラウド同期で席ID(UUID)が切り替わった場合も seatNumber で引き継ぎ保護する
                    let seatNumKey = "seat-\(parsed[i].seatNumber)"
                    let matchedPrevById = self.timers.first(where: { $0.id == id })
                    let matchedPrevByNum = matchedPrevById ?? self.timers.first(where: { $0.seatNumber == parsed[i].seatNumber })
                    let prevKey = matchedPrevByNum?.id ?? id
                    let prevEndSec = matchedPrevByNum?.targetEndTime.timeIntervalSince1970 ?? 0
                    let matchesStoppedSeatEnd = !parsed[i].isRunning && lastStoppedEndSec > 0 && prevEndSec > 0 && abs(lastStoppedEndSec - prevEndSec) <= 15
                    let cleanSeatLabel = (parsed[i].seatLabel ?? "")
                        .replacingOccurrences(of: "席", with: "")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    // ★ Bug 2.2修正: グローバルな notification 存在有無ではなく、①今回の受信で新規受理された有効なピア通知であり、かつ ②当該客席（parsed[i]）を対象とする通知である場合のみ true とする
                    //   （applicationContext 再送による古い通知のゾンビ化、および2番席への通知と同梱されたスナップショットで1番席の自己停止・ローカル変更保護が誤バイパスされるのを完全遮断）
                    let hasExplicitPeerNotifForSeat: Bool = {
                        guard didAcceptFreshPeerNotification else { return false }
                        if !notifTargetSeatId.isEmpty && (notifTargetSeatId == id || notifTargetSeatId == prevKey || notifTargetSeatId == seatNumKey) {
                            return true
                        }
                        if extractedNotifSeatNum > 0 && parsed[i].seatNumber == extractedNotifSeatNum {
                            return true
                        }
                        if !cleanNotifSeatLabel.isEmpty && !cleanSeatLabel.isEmpty && cleanSeatLabel == cleanNotifSeatLabel {
                            return true
                        }
                        return false
                    }()
                    if let modAt = localSeatMods[id] ?? localSeatMods[prevKey] ?? localSeatMods[seatNumKey] {
                        let isAuthoritativeSeatStop = !parsed[i].isRunning && (
                            matchesStoppedSeatEnd ||
                            hasExplicitPeerNotifForSeat ||
                            (lastStoppedAtSec > modAt.timeIntervalSince1970 + 0.2)
                        )
                        let isAuthoritativeSeatStartOrChange: Bool = {
                            guard parsed[i].isRunning, !isStaleSnapshot || isGenuinelyNewerPayload || hasExplicitPeerNotifForSeat else { return false }
                            guard let prev = matchedPrevByNum else { return true }
                            if !prev.isRunning && parsed[i].targetEndTime > nowDate.addingTimeInterval(-3600) {
                                return true
                            }
                            // ★ B-4: Watchローカルでの時間延長・担当変更直後（12秒以内）に、iPhone側の未反映SYNC_SEATSで巻き戻されるのを防止。
                            //   当該席への明示的な他スタッフ操作通知（hasExplicitPeerNotifForSeat）がある場合のみ12秒以内でもリモート変更を優先採用する。
                            return hasExplicitPeerNotifForSeat
                        }()
                        if isAuthoritativeSeatStop {
                            localSeatMods[id] = nil
                            localSeatMods[prevKey] = nil
                            localSeatMods[seatNumKey] = nil
                        } else if nowDate.timeIntervalSince(modAt) < localSeatModHoldSeconds {
                            if !isAuthoritativeSeatStartOrChange, let prev = matchedPrevByNum, parsed[i] != prev {
                                var restored = prev
                                restored.id = id
                                restored.seatNumber = parsed[i].seatNumber
                                if let newLabel = parsed[i].seatLabel, !newLabel.isEmpty {
                                    restored.seatLabel = newLabel
                                }
                                parsed[i] = restored
                            }
                            localSeatMods[id] = modAt
                            localSeatMods[prevKey] = modAt
                            localSeatMods[seatNumKey] = modAt
                        } else {
                            localSeatMods[id] = nil
                            localSeatMods[prevKey] = nil
                            localSeatMods[seatNumKey] = nil
                        }
                    }
                    // ★ Watch主導で開始した席（iPhone側のTestFlight更新が3分超かかった場合を含む3時間以内・iPhone未反映中）が、
                    //   iPhone起動直後の未反映スナップショットやクラウド直接ポーリングの遅延行で強制停止されるのを保護（開始後最低15秒間は稼働追従後も保持）
                    if let startedAt = watchStartedSeatTimes[id] ?? watchStartedSeatTimes[prevKey] ?? watchStartedSeatTimes[seatNumKey] {
                        let isAuthoritativeWatchSeatStop = !parsed[i].isRunning && (
                            matchesStoppedSeatEnd ||
                            hasExplicitPeerNotifForSeat ||
                            (lastStoppedAtSec > startedAt.timeIntervalSince1970 + 0.5) ||
                            (!isStaleSnapshot && isGenuinelyNewerPayload && payloadTs > (startedAt.timeIntervalSince1970 * 1000.0 + 15_000))
                        )
                        if isAuthoritativeWatchSeatStop {
                            watchStartedSeatTimes[id] = nil
                            watchStartedSeatTimes[prevKey] = nil
                            watchStartedSeatTimes[seatNumKey] = nil
                            persistWatchStartedSeats()
                        } else if parsed[i].isRunning {
                            if nowDate.timeIntervalSince(startedAt) >= 15.0 {
                                watchStartedSeatTimes[id] = nil
                                watchStartedSeatTimes[prevKey] = nil
                                watchStartedSeatTimes[seatNumKey] = nil
                                persistWatchStartedSeats()
                            } else {
                                watchStartedSeatTimes[id] = startedAt
                                watchStartedSeatTimes[prevKey] = startedAt
                                watchStartedSeatTimes[seatNumKey] = startedAt
                            }
                        } else if (nowDate.timeIntervalSince(startedAt) < watchStartedSeatPersistSeconds || (isStaleSnapshot && !isGenuinelyNewerPayload)),
                                  let prev = matchedPrevByNum,
                                  prev.isRunning,
                                  prev.targetEndTime > nowDate.addingTimeInterval(-10800) {
                            var restored = prev
                            restored.id = id
                            restored.seatNumber = parsed[i].seatNumber
                            if let newLabel = parsed[i].seatLabel, !newLabel.isEmpty {
                                restored.seatLabel = newLabel
                            }
                            parsed[i] = restored
                            watchStartedSeatTimes[id] = startedAt
                            watchStartedSeatTimes[prevKey] = startedAt
                            watchStartedSeatTimes[seatNumKey] = startedAt
                            persistWatchStartedSeats()
                            didProtectWatchStartedSeats = true
                        } else {
                            watchStartedSeatTimes[id] = nil
                            watchStartedSeatTimes[prevKey] = nil
                            watchStartedSeatTimes[seatNumKey] = nil
                            persistWatchStartedSeats()
                        }
                    }
                    // ★ 既存の同一タイマーがWatchで稼働中の場合、往復同期による数秒のズレで終了予定時刻が書き換わってスマートアラームが破棄されるのを防ぐ
                    if let prev = matchedPrevByNum, prev.isRunning, parsed[i].isRunning {
                        if prev.totalSeconds == parsed[i].totalSeconds,
                           (prev.targetEndTime > nowDate) == (parsed[i].targetEndTime > nowDate),
                           abs(prev.targetEndTime.timeIntervalSince(parsed[i].targetEndTime)) <= 2 {
                            parsed[i].targetEndTime = prev.targetEndTime
                        }
                        if abs(prev.targetEndTime.timeIntervalSince(parsed[i].targetEndTime)) <= 5.0,
                           prev.isCreatorMeExplicit == true {
                            parsed[i].isCreatorMeExplicit = true
                            if SeatTimerItem.isStaffMe(prev.creatorName, currentUserName: self.currentUserName) {
                                parsed[i].creatorName = prev.creatorName
                            }
                        }
                        if prev.hasAlertedHelpUnassigned && parsed[i].remainingSeconds <= 180 {
                            parsed[i].hasAlertedHelpUnassigned = true
                        }
                        if !prev.isCheckCompleted && !parsed[i].isCheckCompleted {
                            if prev.checkTotalSeconds == parsed[i].checkTotalSeconds,
                               let prevChk = prev.checkTargetEndTime,
                               let newChk = parsed[i].checkTargetEndTime,
                               (prevChk > nowDate) == (newChk > nowDate),
                               abs(prevChk.timeIntervalSince(newChk)) <= 2 {
                                parsed[i].checkTargetEndTime = prevChk
                                if parsed[i].checkProcess == "チェック" && prev.checkProcess != "チェック" {
                                    parsed[i].checkProcess = prev.checkProcess
                                }
                            }
                        }
                    } else if parsed[i].isRunning && parsed[i].remainingSeconds <= 180 {
                        parsed[i].hasAlertedHelpUnassigned = true
                    }
                    // ★ Watch で完了・解除したチェックタイマーが、すれ違いの古い通信パケットで復活するのをブロック
                    if let chkClear = localCheckClears[id] ?? localCheckClears[prevKey] {
                        let incomingChkEnd = parsed[i].checkTargetEndTime?.timeIntervalSince1970 ?? 0
                        let sameCheck = (chkClear.checkEnd <= 0) || (incomingChkEnd > 0 && abs(incomingChkEnd - chkClear.checkEnd) <= 2)
                        if !parsed[i].isCheckCompleted && parsed[i].checkTargetEndTime != nil && sameCheck && nowDate.timeIntervalSince(chkClear.at) < localCheckClearHoldSeconds {
                            parsed[i].isCheckCompleted = true
                            parsed[i].checkTargetEndTime = nil
                            parsed[i].checkTotalSeconds = nil
                            if parsed[i].checkStaff == nil {
                                parsed[i].checkStaff = self.currentUserName
                            }
                        } else if parsed[i].isCheckCompleted || parsed[i].checkTargetEndTime == nil || !sameCheck || nowDate.timeIntervalSince(chkClear.at) >= localCheckClearHoldSeconds {
                            localCheckClears[id] = nil
                            localCheckClears[prevKey] = nil
                        }
                    }
                    // ★ 仕様変更（Issue #9）:
                    //   - 自分（または自分のペアiPhone）が止めた場合、または自分が関係者でない席は即時 00:00 停止＆アラーム消火
                    //   - 他スタッフが止めた/シャンプー移行した当該席の通知（hasExplicitPeerNotifForSeat）であり、かつ自分がその席の関係者（shouldAlertMainTimer）でローカル停止していない場合は、
                    //     自分のWatch上のカウントダウン・アラーム予約・超過カウントアップを止めずに継続させる
                    let canTrustSeatStop = !isStaleSnapshot || isGenuinelyNewerPayload || matchesStoppedSeatEnd || hasExplicitPeerNotifForSeat
                    if !parsed[i].isRunning && canTrustSeatStop {
                        if let prev = matchedPrevByNum, prev.isRunning {
                            let hasLocalStopForSeat = (localStops[id] != nil || localStops[prevKey] != nil)
                            let prevEndEpoch = prev.targetEndTime.timeIntervalSince1970
                            let isAlreadyPeerStopped = self.isPeerStoppedSeat(seatId: id, seatNumber: parsed[i].seatNumber, endTimeEpoch: prevEndEpoch)
                                || self.isPeerStoppedSeat(seatId: prevKey, seatNumber: parsed[i].seatNumber, endTimeEpoch: prevEndEpoch)
                            let isStaleOvertimeLocal = Date().timeIntervalSince(prev.targetEndTime) > 300.0
                                && parsed[i].isZero
                                && parsed[i].status == .normal
                                && !hasExplicitPeerNotifForSeat
                            let shouldKeepRunningOnPeerStop = (hasExplicitPeerNotifForSeat || isAlreadyPeerStopped)
                                && !isStaleOvertimeLocal
                                && !hasLocalStopForSeat
                                && !matchesStoppedSeatEnd
                                && prev.shouldAlertMainTimer(for: self.currentUserName)
                            if shouldKeepRunningOnPeerStop {
                                self.markPeerStoppedSeat(seatId: id, seatNumber: parsed[i].seatNumber, endTimeEpoch: prevEndEpoch)
                                if prevKey != id {
                                    self.markPeerStoppedSeat(seatId: prevKey, seatNumber: parsed[i].seatNumber, endTimeEpoch: prevEndEpoch)
                                }
                                parsed[i].isRunning = true
                                parsed[i].targetEndTime = prev.targetEndTime
                                parsed[i].totalSeconds = prev.totalSeconds
                                parsed[i].pausedRemainingSeconds = prev.pausedRemainingSeconds
                                parsed[i].isCollapsed = false
                            } else {
                                self.clearPeerStoppedSeat(seatId: id, seatNumber: parsed[i].seatNumber, recordRecentClear: true, confirmedEndEpoch: prevEndEpoch)
                                if prevKey != id {
                                    self.clearPeerStoppedSeat(seatId: prevKey, seatNumber: parsed[i].seatNumber, recordRecentClear: true, confirmedEndEpoch: prevEndEpoch)
                                }
                                if parsed[i].isZero || parsed[i].status != .normal {
                                    markLocalStop(seatId: id, endTime: prev.targetEndTime)
                                    if prevKey != id {
                                        markLocalStop(seatId: prevKey, endTime: prev.targetEndTime)
                                    }
                                }
                                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                                    seatId: id,
                                    seatNumber: parsed[i].seatNumber,
                                    checkOnly: false,
                                    skipRefresh: true
                                )
                            }
                        } else if matchesStoppedSeatEnd || (!hasExplicitPeerNotifForSeat && WatchAlarmCoordinator.shared.isSeatRingingOrDue(seatId: id, seatNumber: parsed[i].seatNumber)) {
                            self.clearPeerStoppedSeat(seatId: id, seatNumber: parsed[i].seatNumber, recordRecentClear: true, confirmedEndEpoch: lastStoppedEndSec)
                            if prevKey != id {
                                self.clearPeerStoppedSeat(seatId: prevKey, seatNumber: parsed[i].seatNumber, recordRecentClear: true, confirmedEndEpoch: lastStoppedEndSec)
                            }
                            if (parsed[i].isZero || parsed[i].status != .normal), lastStoppedEndSec > 0 {
                                let stoppedDate = Date(timeIntervalSince1970: lastStoppedEndSec)
                                markLocalStop(seatId: id, endTime: stoppedDate)
                                if prevKey != id {
                                    markLocalStop(seatId: prevKey, endTime: stoppedDate)
                                }
                            }
                            WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                                seatId: id,
                                seatNumber: parsed[i].seatNumber,
                                checkOnly: false,
                                skipRefresh: true
                            )
                        }
                    } else if parsed[i].isRunning && (!isStaleSnapshot || isGenuinelyNewerPayload || hasExplicitPeerNotifForSeat) {
                        // ★ A-1: 稼働中（または超過中）の席で自分のヘルプ担当／チェック担当が外された場合、
                        //   予約中のスマートアラーム・ローカル通知・鳴動中バイブレーションを 0ms で即時消火する
                        let shouldAlertMainNow = parsed[i].shouldAlertMainTimer(for: self.currentUserName)
                        if (matchedPrevByNum?.shouldAlertMainTimer(for: self.currentUserName) == true && !shouldAlertMainNow) ||
                           (!shouldAlertMainNow && WatchAlarmCoordinator.shared.isSeatRingingOrDue(seatId: id, seatNumber: parsed[i].seatNumber, checkOnly: false) && !WatchAlarmCoordinator.shared.isSeatRingingOrDue(seatId: id, seatNumber: parsed[i].seatNumber, checkOnly: true)) {
                            self.clearPeerStoppedSeat(seatId: id, seatNumber: parsed[i].seatNumber, recordRecentClear: false)
                            if prevKey != id {
                                self.clearPeerStoppedSeat(seatId: prevKey, seatNumber: parsed[i].seatNumber, recordRecentClear: false)
                            }
                            WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                                seatId: id,
                                seatNumber: parsed[i].seatNumber,
                                checkOnly: false,
                                mainOnly: true,
                                skipRefresh: true
                            )
                            if prevKey != id {
                                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                                    seatId: prevKey,
                                    seatNumber: parsed[i].seatNumber,
                                    checkOnly: false,
                                    mainOnly: true,
                                    skipRefresh: true
                                )
                            }
                        }
                        let isIncomingCheckInactive = parsed[i].isCheckCompleted || parsed[i].checkTargetEndTime == nil
                        let shouldAlertCheckNow = !isIncomingCheckInactive && parsed[i].shouldAlertCheckTimer(for: self.currentUserName)
                        if let prev = matchedPrevByNum,
                           !prev.isCheckCompleted,
                           prev.checkTargetEndTime != nil,
                           isIncomingCheckInactive {
                            markLocalCheckClear(seatId: id, checkEndTime: prev.checkTargetEndTime)
                            if prevKey != id {
                                markLocalCheckClear(seatId: prevKey, checkEndTime: prev.checkTargetEndTime)
                            }
                            WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                                seatId: id,
                                seatNumber: parsed[i].seatNumber,
                                checkOnly: true,
                                skipRefresh: true
                            )
                        } else if isIncomingCheckInactive && WatchAlarmCoordinator.shared.isSeatRingingOrDue(seatId: id, seatNumber: parsed[i].seatNumber, checkOnly: true) {
                            WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                                seatId: id,
                                seatNumber: parsed[i].seatNumber,
                                checkOnly: true,
                                skipRefresh: true
                            )
                        } else if !isIncomingCheckInactive && !shouldAlertCheckNow &&
                                  (matchedPrevByNum?.shouldAlertCheckTimer(for: self.currentUserName) == true ||
                                   WatchAlarmCoordinator.shared.isSeatRingingOrDue(seatId: id, seatNumber: parsed[i].seatNumber, checkOnly: true)) {
                            WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                                seatId: id,
                                seatNumber: parsed[i].seatNumber,
                                checkOnly: true,
                                skipRefresh: true
                            )
                            if prevKey != id {
                                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                                    seatId: prevKey,
                                    seatNumber: parsed[i].seatNumber,
                                    checkOnly: true,
                                    skipRefresh: true
                                )
                            }
                        }
                    }
                    guard let stop = localStops[id] ?? localStops[prevKey] ?? localStops[seatNumKey] else { continue }
                    // ★ 同一終了時刻の判定を 15秒 → 2.5秒 に厳密化（停止直後に別Watchや自機で同じ分数のタイマーを再設定した際に誤って00:00へ潰されるのを防止）
                    let sameEnd = abs(parsed[i].targetEndTime.timeIntervalSince1970 - stop.end) <= 2.5
                    if nowDate.timeIntervalSince(stop.at) >= localStopHoldSeconds {
                        localStops[id] = nil
                        localStops[prevKey] = nil
                        localStops[seatNumKey] = nil
                        persistLocalStops()
                    } else if parsed[i].isRunning {
                        if sameEnd && !hasExplicitPeerNotifForSeat {
                            parsed[i].isRunning = false
                            parsed[i].totalSeconds = 0
                            parsed[i].pausedRemainingSeconds = 0
                            parsed[i].targetEndTime = Date(timeIntervalSince1970: 0)
                            parsed[i].status = .normal
                            parsed[i].shampooStaff = nil
                            parsed[i].helpProcess = ""
                            parsed[i].isRecruiting = false
                            parsed[i].isNoHelpNeeded = false
                            parsed[i].isCollapsed = true
                            parsed[i].clearCheck()
                        } else {
                            // 異なる新しい終了時刻で再スタートされた場合はブロック解除
                            localStops[id] = nil
                            localStops[prevKey] = nil
                            localStops[seatNumKey] = nil
                            persistLocalStops()
                        }
                    }
                }
                if didProtectWatchStartedSeats && !isStaleSnapshot && nowDate.timeIntervalSince(self.lastWatchSeatRePushAt) > 2.5 {
                    self.lastWatchSeatRePushAt = nowDate
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                        self?.requestSyncFromPhone()
                    }
                }
                // ★ カードの収納: 稼働中の席は常に展開。停止中は Watch 上での操作を優先し、00:00で何も入っていない席は初期状態で閉じる
                for i in parsed.indices {
                    let id = parsed[i].id
                    let prevKey = "seat-\(parsed[i].seatNumber)"
                    if parsed[i].isRunning {
                        if (parsed[i].createdBy ?? "").isEmpty,
                           let prevMatch = self.timers.first(where: { $0.isRunning && ($0.id == id || $0.seatNumber == parsed[i].seatNumber) }),
                           let prevCb = prevMatch.createdBy,
                           !prevCb.isEmpty {
                            parsed[i].createdBy = prevCb
                        }
                        parsed[i].isCollapsed = false
                        collapseOverrides[id] = nil
                        collapseOverrides[prevKey] = nil
                    } else if let collapsed = collapseOverrides[id] ?? collapseOverrides[prevKey] {
                        parsed[i].isCollapsed = collapsed
                        collapseOverrides[id] = collapsed
                    } else if parsed[i].isZero {
                        parsed[i].isCollapsed = true
                    }
                }
                if !isStaleContextForAlarm {
                    for nextSeat in parsed {
                        let prevSeat = self.timers.first(where: { $0.id == nextSeat.id || $0.seatNumber == nextSeat.seatNumber })
                        self.purgeStalePeerSemanticKeysForSeatTransition(prev: prevSeat, next: nextSeat)
                    }
                    self.hasReceivedAuthoritativeSyncInSession = true
                }
                self.lastReceivedSeatCount = parsed.count
                self.timers = parsed
                // ★ バックグラウンド受信でもアラーム予定（通知・スマートアラーム）を更新（関係者判定・コールド起動時の古い保存データ保護付き）
                WatchAlarmCoordinator.shared.update(
                    timers: parsed,
                    mainTimer: self.mainTimer,
                    soundOn: self.alarmSoundEnabled,
                    currentUserName: self.currentUserName,
                    isStaleContextSnapshot: isStaleContextForAlarm
                )
                // ★ 文字盤コンプリケーションへ共有（即時リロード強制）
                WidgetSync.save(timers: parsed, mainTimer: self.mainTimer, userName: self.currentUserName, forceReload: true)
            }
        } else if data["mainTimer"] != nil || didUpdateMain {
            // ★ メインタイマーのみの更新時（seatsキーなし）も文字盤・アラームを同期
            WatchAlarmCoordinator.shared.update(
                timers: self.timers,
                mainTimer: self.mainTimer,
                soundOn: self.alarmSoundEnabled,
                currentUserName: self.currentUserName,
                isStaleContextSnapshot: isStaleContextForAlarm
            )
            WidgetSync.save(timers: self.timers, mainTimer: self.mainTimer, userName: self.currentUserName, forceReload: true)
        } else if didUpdateCloudIdentity {
            WidgetSync.save(timers: self.timers, mainTimer: self.mainTimer, userName: self.currentUserName, forceReload: false)
        }
    }
    
    // ★ メインタイマー専用の操作送信（携帯の音出力フラグおよび一意なactionIdを付与）
    func sendMainTimerAction(action: String, extra: [String: Any] = [:], stoppedEndTime: Double = 0, mainTimerOverride: SeatTimerItem? = nil) {
        let clean = action.replacingOccurrences(of: "MAIN_TIMER_", with: "")
        let refMain = mainTimerOverride ?? self.mainTimer
        let isActive = (refMain?.isRunning == true || refMain?.isPreCountingDown == true)
        let endTime = stoppedEndTime > 0
            ? stoppedEndTime
            : (isActive ? (refMain?.targetEndTime.timeIntervalSince1970 ?? 0) : 0)
        recordMainTimerLocalAction(clean, endTime: endTime)
        var fullExtra = extra
        if fullExtra["actionId"] == nil {
            fullExtra["actionId"] = "\(action)_\(safeEpochMillisInt64(Date().timeIntervalSince1970 * 1000))"
        }
        if fullExtra["playSoundOnPhone"] == nil {
            let soundVal = UserDefaults.standard.object(forKey: "assisttimer.mainTimerPhoneSound.v2") as? Bool ?? false
            fullExtra["playSoundOnPhone"] = soundVal
        }
        if let m = refMain, (m.isRunning || m.isPreCountingDown) {
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
    func sendMainTimerSetTime(seconds: Int, autoStart: Bool = true, mainTimerOverride: SeatTimerItem? = nil) {
        sendMainTimerAction(action: "MAIN_TIMER_SET_TIME", extra: ["totalSeconds": seconds, "autoStart": autoStart], mainTimerOverride: mainTimerOverride)
    }
    
    // ★ メインタイマーの秒数増減を送信
    func sendMainTimerAdjust(seconds: Int, mainTimerOverride: SeatTimerItem? = nil) {
        sendMainTimerAction(action: "MAIN_TIMER_ADJUST", extra: ["secondsToAdd": seconds], mainTimerOverride: mainTimerOverride)
    }
    
    // ★ 送信結果をメインスレッドで記録
    private func recordSend(_ result: String) {
        DispatchQueue.main.async {
            self.lastSendResult = result
        }
    }
    
    private final class DirectPushCoordinationState {
        let lock = NSLock()
        var shouldDispatchDirectPush: Bool = false
        var didPatchSucceed: Bool = false
        var didTriggerPush: Bool = false
        var onReadyToDispatchPush: (() -> Void)? = nil

        func markNeedsDirectPush() {
            var fire: (() -> Void)? = nil
            lock.lock()
            shouldDispatchDirectPush = true
            if didPatchSucceed && !didTriggerPush {
                didTriggerPush = true
                fire = onReadyToDispatchPush
                onReadyToDispatchPush = nil
            }
            lock.unlock()
            fire?()
        }

        func markPatchSucceeded(dispatchBlock: @escaping () -> Void) {
            var fire: (() -> Void)? = nil
            lock.lock()
            didPatchSucceed = true
            if shouldDispatchDirectPush && !didTriggerPush {
                didTriggerPush = true
                fire = dispatchBlock
            } else if !didTriggerPush {
                onReadyToDispatchPush = dispatchBlock
            }
            lock.unlock()
            fire?()
        }
    }

    // MARK: - iPhoneへのアクション送信（＋クラウド共有サロン接続時はWatchからSupabaseへも0ms直接REST同期）
    // ①即時通信できれば sendMessage（iPhoneの受信確認つき）→ 重要停止操作は transferUserInfo も0ms同時投入
    // ②即時通信できなければ最初から transferUserInfo（iPhoneアプリ起動時に届く予備ルート）
    // ③ペアリング中のiPhoneがロック・バックグラウンド休止中でも共有相手のWatch/iPhoneへ即座に停止・担当変更等を届けるため、
    //   Watch自身からも直接 Supabase REST API へ PATCH 更新を実行（Realtime + ダイレクトPush / Edge Function トリガーを即時発火）
    func sendActionToPhone(action: String, seatId: String, extra: [String: Any] = [:], preActionSeat: SeatTimerItem? = nil) {
        if !Thread.isMainThread {
            DispatchQueue.main.async { [weak self] in
                self?.sendActionToPhone(action: action, seatId: seatId, extra: extra, preActionSeat: preActionSeat)
            }
            return
        }
        var resolvedSeatId = seatId
        var matchedSeatForCloud: SeatTimerItem? = nil
        var payload: [String: Any] = [
            "action": action,
            "seatId": seatId,
            "userName": currentUserName,
            "timestamp": Date().timeIntervalSince1970 * 1000.0
        ]
        if !seatId.isEmpty, seatId != "main-timer" {
            let matchedSeat = self.timers.first(where: { $0.id == seatId })
                ?? (seatId.hasPrefix("seat-") ? Int(seatId.replacingOccurrences(of: "seat-", with: "")).flatMap { num in self.timers.first(where: { $0.seatNumber == num }) } : nil)
            if let matchedSeat = matchedSeat {
                matchedSeatForCloud = matchedSeat
                resolvedSeatId = matchedSeat.id
                payload["seatId"] = matchedSeat.id
                payload["seatNumber"] = matchedSeat.seatNumber
                if let label = matchedSeat.seatLabel, !label.isEmpty {
                    payload["seatLabel"] = label
                }
            }
        }
        for (k, v) in extra {
            payload[k] = v
        }

        if !seatId.isEmpty && seatId != "main-timer" {
            let stopKind = (payload["kind"] as? String) ?? ""
            let isMainStopAction = (action == "STOP_TIMER" || action == "RESET_ZERO" || action == "FINISH_MEASURE" || (action == "STOP_ALARM" && stopKind != "check"))
            if isMainStopAction {
                let explicitPeerStopped = (payload["wasPeerStopped"] as? NSNumber)?.boolValue ?? (payload["wasPeerStopped"] as? Bool) ?? false
                let expectedEndMs = (payload["expectedEnd"] as? NSNumber)?.doubleValue ?? (payload["expectedEnd"] as? Double) ?? 0
                let refEndDate = expectedEndMs > 0 ? Date(timeIntervalSince1970: expectedEndMs / 1000.0) : matchedSeatForCloud?.targetEndTime
                let resolvedSeatNum = matchedSeatForCloud?.seatNumber ?? (payload["seatNumber"] as? Int) ?? 0
                let peerStopped = explicitPeerStopped
                    || self.wasRecentlyOrCurrentlyPeerStoppedSeat(seatId: resolvedSeatId, seatNumber: resolvedSeatNum, targetEndTime: refEndDate)
                    || (resolvedSeatId != seatId && self.wasRecentlyOrCurrentlyPeerStoppedSeat(seatId: seatId, seatNumber: resolvedSeatNum, targetEndTime: refEndDate))
                    || (!(matchedSeatForCloud?.isRunning ?? true) && (matchedSeatForCloud?.status ?? .normal) != .normal)
                if peerStopped {
                    payload["wasPeerStopped"] = true
                    if let ms = matchedSeatForCloud, ms.status != .normal {
                        if payload["peerIsShampooing"] == nil {
                            payload["peerIsShampooing"] = (ms.status == .shampoo)
                        }
                        if payload["peerHelpProcess"] == nil {
                            payload["peerHelpProcess"] = ms.helpProcess.isEmpty ? ms.status.rawValue : ms.helpProcess
                        }
                        if payload["peerAssistantStaffName"] == nil {
                            payload["peerAssistantStaffName"] = ms.shampooStaff ?? ""
                        }
                    }
                }
            }
        }

        let canWatchDirectCloudPush = !seatId.isEmpty
            && seatId != "main-timer"
            && action != "REQUEST_SYNC"
            && Self.isValidCloudUUID(self.cloudSalonId.trimmingCharacters(in: .whitespacesAndNewlines))
            && Self.isValidCloudUUID(self.cloudUserId.trimmingCharacters(in: .whitespacesAndNewlines))
        let pushCoord: DirectPushCoordinationState? = canWatchDirectCloudPush ? DirectPushCoordinationState() : nil

        if !seatId.isEmpty && seatId != "main-timer" && action != "REQUEST_SYNC" {
            self.syncSeatActionDirectlyToCloud(
                action: action,
                resolvedSeatId: resolvedSeatId,
                matchedSeat: matchedSeatForCloud,
                preActionSeat: preActionSeat ?? matchedSeatForCloud,
                extra: payload,
                pushCoord: pushCoord
            )
        }

        guard WCSession.isSupported() else {
            pushCoord?.markNeedsDirectPush()
            return
        }
        let session = WCSession.default
        
        let executeSend = {
            if !seatId.isEmpty && seatId != "main-timer" && action != "REQUEST_SYNC" {
                self.hasReceivedAuthoritativeSyncInSession = true
                self.localActionGeneration &+= 1
                let resolvedSeatNum = matchedSeatForCloud?.seatNumber ?? (extra["seatNumber"] as? Int) ?? 0
                let stopKindForMod = (extra["kind"] as? String) ?? ""
                let isMainStopActionForMod = (
                    action == "STOP_TIMER" ||
                    action == "RESET_ZERO" ||
                    action == "FINISH_MEASURE" ||
                    action == "ENTER_HELP" ||
                    action == "START_SHAMPOO" ||
                    (action == "STOP_ALARM" && stopKindForMod != "check")
                )
                if !isMainStopActionForMod {
                    self.markLocalSeatMod(seatId: resolvedSeatId, seatNumber: resolvedSeatNum)
                    if resolvedSeatId != seatId {
                        self.markLocalSeatMod(seatId: seatId, seatNumber: resolvedSeatNum)
                    }
                }
                if action == "START_TIMER" {
                    let now = Date()
                    self.clearLocalStop(seatId: resolvedSeatId)
                    self.clearPeerStoppedSeat(seatId: resolvedSeatId, seatNumber: resolvedSeatNum, recordRecentClear: false)
                    if resolvedSeatId != seatId {
                        self.clearLocalStop(seatId: seatId)
                        self.clearPeerStoppedSeat(seatId: seatId, seatNumber: resolvedSeatNum, recordRecentClear: false)
                    }
                    for key in self.allSeatKeys(for: resolvedSeatId, seatNumber: resolvedSeatNum) {
                        self.watchStartedSeatTimes[key] = now
                        self.localSeatMods[key] = now
                    }
                    if resolvedSeatId != seatId {
                        for key in self.allSeatKeys(for: seatId, seatNumber: resolvedSeatNum) {
                            self.watchStartedSeatTimes[key] = now
                            self.localSeatMods[key] = now
                        }
                    }
                    self.persistWatchStartedSeats()
                } else if action == "ADJUST_TIME" {
                    let isSubCheck = (extra["isSubCheck"] as? NSNumber)?.boolValue ?? (extra["isSubCheck"] as? Bool) ?? false
                    if !isSubCheck {
                        self.clearPeerStoppedSeat(seatId: resolvedSeatId, seatNumber: resolvedSeatNum, recordRecentClear: false)
                        if resolvedSeatId != seatId {
                            self.clearPeerStoppedSeat(seatId: seatId, seatNumber: resolvedSeatNum, recordRecentClear: false)
                        }
                    }
                } else if action == "STOP_ALARM" || action == "STOP_TIMER" || action == "RESET_ZERO" || action == "FINISH_MEASURE" || action == "ENTER_HELP" || action == "START_SHAMPOO" {
                    let isCheckOnlyStop = (action == "STOP_ALARM" && (extra["kind"] as? String) == "check")
                    if !isCheckOnlyStop {
                        var hadStart = false
                        for key in self.allSeatKeys(for: resolvedSeatId, seatNumber: resolvedSeatNum) {
                            if self.watchStartedSeatTimes.removeValue(forKey: key) != nil {
                                hadStart = true
                            }
                        }
                        if resolvedSeatId != seatId {
                            for key in self.allSeatKeys(for: seatId, seatNumber: resolvedSeatNum) {
                                if self.watchStartedSeatTimes.removeValue(forKey: key) != nil {
                                    hadStart = true
                                }
                            }
                        }
                        if hadStart {
                            self.persistWatchStartedSeats()
                        }
                    }
                }
            }
            self.lastSentAction = action
            self.lastSentAt = Date()
            
            guard session.activationState == .activated else {
                // REQUEST_SYNC は有効化完了時に自動で送るので保留しない（重複防止）
                if action != "REQUEST_SYNC" {
                    var queuedPayload = payload
                    if let coord = pushCoord {
                        queuedPayload["watchDispatchedDirectPush"] = true
                        coord.markNeedsDirectPush()
                    }
                    self.pendingPayloads.append(queuedPayload)
                }
                self.lastSendResult = "未準備（有効化待ち・保留\(self.pendingPayloads.count)件）"
                session.activate()
                return
            }
            self.deliver(payload, session: session, pushCoord: pushCoord)
        }
        if Thread.isMainThread {
            executeSend()
        } else {
            DispatchQueue.main.async(execute: executeSend)
        }
    }
    
    private final class DeliveryFallbackState {
        let lock = NSLock()
        var acked = false
        var fallbackSent = false
        var superseded = false
        var ackSema: DispatchSemaphore?
    }
    private let activeDeliveriesLock = NSLock()
    private var activeDeliveriesByTarget: [String: DeliveryFallbackState] = [:]

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
    private func deliver(_ payload: [String: Any], session: WCSession, pushCoord: DirectPushCoordinationState? = nil) {
        let action = (payload["action"] as? String) ?? ""
        let targetSid = (payload["seatId"] as? String) ?? ""
        let isMainStopOrReset = (action == "MAIN_TIMER_RESET" || action == "MAIN_TIMER_PAUSE")
        if isMainStopOrReset {
            // ★ メインタイマーの停止・リセット送信時は、未送信キューに残っている古い開始命令をクリアして順序逆転による再稼働を防止
            //   （※ WCSession.outstandingUserInfoTransfers のイテレーションと .cancel() は wcd IPC競合クラッシュを引き起こすため一切行わない）
            pendingPayloads.removeAll { item in
                let a = (item["action"] as? String) ?? ""
                return a == "MAIN_TIMER_START" || a == "MAIN_TIMER_SET_TIME"
            }
        }
        let isSeatStopOrReset = (
            action == "STOP_TIMER" ||
            action == "RESET_ZERO" ||
            action == "FINISH_MEASURE" ||
            action == "ENTER_HELP" ||
            action == "START_SHAMPOO" ||
            (action == "STOP_ALARM" && (payload["kind"] as? String) != "check")
        )
        let targetSeatNum = (payload["seatNumber"] as? NSNumber)?.intValue ?? (payload["seatNumber"] as? Int) ?? 0
        if isSeatStopOrReset && (!targetSid.isEmpty || targetSeatNum > 0) {
            // ★ 客席タイマー停止時も、同一席の未送信 START_TIMER がローカル保留キューに残っていればクリアして順序逆転による再稼働を防止
            pendingPayloads.removeAll { item in
                let a = (item["action"] as? String) ?? ""
                let sid = (item["seatId"] as? String) ?? ""
                let sNum = (item["seatNumber"] as? NSNumber)?.intValue ?? (item["seatNumber"] as? Int) ?? 0
                let sameSeat = (!targetSid.isEmpty && sid == targetSid) || (targetSeatNum > 0 && sNum == targetSeatNum)
                return sameSeat && a == "START_TIMER"
            }
        } else if action == "START_TIMER" && (!targetSid.isEmpty || targetSeatNum > 0) {
            // ★ 客席タイマー開始時も、同一席の古い停止命令（STOP_TIMER / ENTER_HELP 等）がローカル保留キューに残っていればクリア
            let stopActionSet: Set<String> = ["STOP_TIMER", "RESET_ZERO", "FINISH_MEASURE", "ENTER_HELP", "START_SHAMPOO", "STOP_ALARM"]
            pendingPayloads.removeAll { item in
                let a = (item["action"] as? String) ?? ""
                let sid = (item["seatId"] as? String) ?? ""
                let sNum = (item["seatNumber"] as? NSNumber)?.intValue ?? (item["seatNumber"] as? Int) ?? 0
                let sameSeat = (!targetSid.isEmpty && sid == targetSid) || (targetSeatNum > 0 && sNum == targetSeatNum)
                return sameSeat && stopActionSet.contains(a)
            }
        }

        let targetKeys: [String] = {
            guard action != "REQUEST_SYNC" else { return [] }
            if action.hasPrefix("MAIN_TIMER_") || targetSid == "main-timer" {
                return ["main-timer"]
            }
            if !targetSid.isEmpty || targetSeatNum > 0 {
                let keys = allSeatKeys(for: targetSid, seatNumber: targetSeatNum)
                return keys.isEmpty ? (targetSid.isEmpty ? [] : [targetSid]) : keys
            }
            return []
        }()

        let state = DeliveryFallbackState()
        let ackSema = DispatchSemaphore(value: 0)
        state.ackSema = ackSema

        if !targetKeys.isEmpty {
            var semasToSignal: [DispatchSemaphore] = []
            activeDeliveriesLock.lock()
            var visitedPrev: [ObjectIdentifier: DeliveryFallbackState] = [:]
            for key in targetKeys {
                if let prev = activeDeliveriesByTarget[key] {
                    visitedPrev[ObjectIdentifier(prev)] = prev
                }
                if session.isReachable {
                    activeDeliveriesByTarget[key] = state
                } else {
                    activeDeliveriesByTarget.removeValue(forKey: key)
                }
            }
            activeDeliveriesLock.unlock()

            for prev in visitedPrev.values {
                prev.lock.lock()
                prev.superseded = true
                if let prevSema = prev.ackSema {
                    prev.ackSema = nil
                    semasToSignal.append(prevSema)
                }
                prev.lock.unlock()
            }
            for s in semasToSignal {
                s.signal()
            }
        }

        if session.isReachable {
            lastSendResult = "即時送信中…"
            let clearActiveDeliveryIfCurrent: () -> Void = { [weak self] in
                guard let self = self, !targetKeys.isEmpty else { return }
                self.activeDeliveriesLock.lock()
                for key in targetKeys {
                    if self.activeDeliveriesByTarget[key] === state {
                        self.activeDeliveriesByTarget.removeValue(forKey: key)
                    }
                }
                self.activeDeliveriesLock.unlock()
            }
            let triggerFallbackIfNeeded: (String) -> Void = { [weak self] reason in
                guard action != "REQUEST_SYNC" else { return }
                state.lock.lock()
                if state.acked || state.fallbackSent || state.superseded {
                    state.lock.unlock()
                    return
                }
                state.fallbackSent = true
                state.ackSema = nil
                state.lock.unlock()
                clearActiveDeliveryIfCurrent()
                var fallbackPayload = payload
                if let coord = pushCoord {
                    fallbackPayload["watchDispatchedDirectPush"] = true
                    coord.markNeedsDirectPush()
                }
                session.transferUserInfo(fallbackPayload)
                DispatchQueue.main.async {
                    self?.recordSend(reason)
                }
            }

            if action != "REQUEST_SYNC" {
                ProcessInfo.processInfo.performExpiringActivity(withReason: "WatchSendMessage-\(action)") { expired in
                    if expired {
                        triggerFallbackIfNeeded("スリープ移行→予備ルート併用送信")
                        ackSema.signal()
                        return
                    }
                    _ = ackSema.wait(timeout: .now() + 0.75)
                    triggerFallbackIfNeeded("即時待機(0.75s)→予備ルート併用送信")
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
                    triggerFallbackIfNeeded("即時待機(0.75s)→予備ルート併用送信")
                    ackSema.signal()
                }
                session.sendMessage(payload, replyHandler: { [weak self] _ in
                    state.lock.lock()
                    state.acked = true
                    state.ackSema = nil
                    state.lock.unlock()
                    clearActiveDeliveryIfCurrent()
                    ackSema.signal()
                    DispatchQueue.main.async {
                        self?.recordSend("iPhone受信OK")
                    }
                }, errorHandler: { error in
                    print("[WatchSession] sendMessage error: \(error.localizedDescription)")
                    triggerFallbackIfNeeded("即時失敗→予備ルート: \(error.localizedDescription)")
                    ackSema.signal()
                })
            } else {
                session.sendMessage(payload, replyHandler: { [weak self] _ in
                    DispatchQueue.main.async {
                        self?.recordSend("iPhone受信OK")
                    }
                }, errorHandler: { [weak self] error in
                    print("[WatchSession] sendMessage error: \(error.localizedDescription)")
                    DispatchQueue.main.async {
                        self?.recordSend("即時失敗: \(error.localizedDescription)")
                    }
                })
            }
        } else {
            if action != "REQUEST_SYNC" {
                var fallbackPayload = payload
                if let coord = pushCoord {
                    fallbackPayload["watchDispatchedDirectPush"] = true
                    coord.markNeedsDirectPush()
                }
                session.transferUserInfo(fallbackPayload)
            }
            lastSendResult = "iPhone未接続→予備ルート＋クラウド直接同期"
        }
    }

    // MARK: - Watch単独の直接Supabase REST同期＆補完ポーリング
    static func isValidCloudUUID(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count == 36 else { return false }
        return UUID(uuidString: trimmed) != nil
    }

    func patchStopSeatTimerInSupabaseDirectly(
        seatId: String,
        seatNumber: Int,
        matchedSeat: SeatTimerItem? = nil,
        extra: [String: Any] = [:]
    ) {
        var payload: [String: Any] = [
            "seatId": seatId,
            "seatNumber": seatNumber,
            "seatLabel": matchedSeat?.seatLabel ?? (seatNumber > 0 ? "\(seatNumber)番" : "")
        ]
        for (k, v) in extra {
            payload[k] = v
        }
        let standaloneCoord = DirectPushCoordinationState()
        standaloneCoord.markNeedsDirectPush()
        syncSeatActionDirectlyToCloud(
            action: "STOP_TIMER",
            resolvedSeatId: seatId,
            matchedSeat: matchedSeat,
            preActionSeat: matchedSeat,
            extra: payload,
            pushCoord: standaloneCoord
        )
    }

    private func syncSeatActionDirectlyToCloud(
        action: String,
        resolvedSeatId: String,
        matchedSeat: SeatTimerItem?,
        preActionSeat: SeatTimerItem? = nil,
        extra: [String: Any],
        pushCoord: DirectPushCoordinationState? = nil
    ) {
        let salonId = self.cloudSalonId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isValidCloudUUID(salonId) else { return }

        let uid = self.cloudUserId.trimmingCharacters(in: .whitespacesAndNewlines)
        let memberIdMapSnapshot = self.memberIdMap
        let staffName = ((extra["userName"] as? String) ?? self.currentUserName).trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveStaff = staffName.isEmpty ? "スタイリスト" : staffName
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoNow = isoFormatter.string(from: Date())

        let hasUUIDSeatId = Self.isValidCloudUUID(resolvedSeatId)
        let rawLabel = ((extra["seatLabel"] as? String) ?? matchedSeat?.seatLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let seatNum = (extra["seatNumber"] as? NSNumber)?.intValue ?? (extra["seatNumber"] as? Int) ?? matchedSeat?.seatNumber ?? 0
        let cleanNumLabel = seatNum > 0 ? "\(seatNum)番" : ""
        let hasLabelCandidate = !rawLabel.isEmpty || !cleanNumLabel.isEmpty
        let baseLabel = !rawLabel.isEmpty ? rawLabel.replacingOccurrences(of: "席", with: "") : cleanNumLabel
        let withSuffixLabel = "\(baseLabel)席"

        var queryItems: [URLQueryItem] = [
            URLQueryItem(name: "salon_id", value: "eq.\(salonId)")
        ]
        if hasUUIDSeatId && hasLabelCandidate {
            // UUID一致行だけでなく、同一サロン内の同じ席ラベル（「1番」「1番席」）の重複行やID昇格前後の行も1回のPATCHで漏れなく開始・停止・更新する
            queryItems.append(URLQueryItem(name: "or", value: "(id.eq.\(resolvedSeatId),seat_label.in.(\"\(baseLabel)\",\"\(withSuffixLabel)\"))"))
        } else if hasUUIDSeatId {
            queryItems.append(URLQueryItem(name: "id", value: "eq.\(resolvedSeatId)"))
        } else if hasLabelCandidate {
            queryItems.append(URLQueryItem(name: "seat_label", value: "in.(\"\(baseLabel)\",\"\(withSuffixLabel)\")"))
        } else {
            return
        }

        let expectedEndMs = (extra["expectedEnd"] as? NSNumber)?.doubleValue ?? (extra["expectedEnd"] as? Double) ?? 0
        var body: [String: Any] = [
            "updated_at": isoNow
        ]
        if Self.isValidCloudUUID(uid) && !Self.updatedByColumnUnsupported {
            body["updated_by"] = uid
        }

        let stopKind = ((extra["kind"] as? String) ?? "").lowercased()
        let nowMs = Date().timeIntervalSince1970 * 1000.0
        let appendStopExpectedEndFilter = { (items: inout [URLQueryItem]) in
            if expectedEndMs > 1_000_000_000_000 {
                if expectedEndMs > nowMs + 2_000 {
                    // カウントダウン稼働中の特定タイマーを停止する場合は upper bound (expectedEndMs + 15秒) のみ制限し、
                    // 1人目が既に停止して target_end_timestamp が 0 になっている行への 2人目の停止・シャンプー移行も確実にヒットさせつつ、
                    // 別Watchが新しく未来へ開始した別タイマー（> maxEnd）を誤って止めないよう保護する
                    let maxEnd = safeEpochMillisInt64(expectedEndMs + 15_000)
                    items.append(URLQueryItem(name: "target_end_timestamp", value: "lte.\(maxEnd)"))
                } else {
                    // タイムアップ超過中（+00:xx）のタイマーを停止する場合は、超過中の全タイマーを対象にしつつ、別Watchが新しく未来へスタートしたタイマーは絶対に止めない
                    let maxOvertimeEnd = safeEpochMillisInt64(nowMs + 5_000)
                    items.append(URLQueryItem(name: "target_end_timestamp", value: "lte.\(maxOvertimeEnd)"))
                }
            } else {
                // 非稼働画面（00:00リセット・計測完了等）からの操作が、別Watchで稼働開始された未来のタイマーを潰さないようガード
                let maxNonFutureEnd = safeEpochMillisInt64(nowMs + 2_000)
                items.append(URLQueryItem(name: "target_end_timestamp", value: "lte.\(maxNonFutureEnd)"))
            }
        }

        let resolvePreservedPeerOrValidAssistant = { (isResetZero: Bool, wasPeerStopped: Bool) -> (assist: Any, helpProc: Any, isShampoo: Bool) in
            let explicitPeerShampoo = (extra["peerIsShampooing"] as? NSNumber)?.boolValue ?? (extra["peerIsShampooing"] as? Bool) ?? false
            let explicitPeerProc = ((extra["peerHelpProcess"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let explicitPeerAssist = ((extra["peerAssistantStaffName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let seatStatus = matchedSeat?.status ?? .normal
            let seatHasActiveAction = (seatStatus != .normal) || explicitPeerShampoo || !explicitPeerProc.isEmpty
            let rawAssist = (!explicitPeerAssist.isEmpty ? explicitPeerAssist : (matchedSeat?.shampooStaff ?? "")).trimmingCharacters(in: .whitespacesAndNewlines)
            let validAssist = (!rawAssist.isEmpty && rawAssist != "募集中" && rawAssist != "ヘルプなし" && rawAssist != "none" && rawAssist != "未定") ? rawAssist : ""
            if wasPeerStopped && seatHasActiveAction {
                let isShampoo = explicitPeerShampoo || (seatStatus == .shampoo) || (explicitPeerProc == "シャンプー")
                let resolvedProc: String = {
                    if !explicitPeerProc.isEmpty { return explicitPeerProc }
                    if isShampoo { return "シャンプー" }
                    if seatStatus == .combing { return "コーミング" }
                    if seatStatus == .check { return "チェック" }
                    return matchedSeat?.helpProcess ?? ""
                }()
                return (
                    assist: validAssist.isEmpty ? NSNull() : validAssist,
                    helpProc: resolvedProc.isEmpty ? NSNull() : resolvedProc,
                    isShampoo: isShampoo
                )
            }
            return (
                assist: (isResetZero || validAssist.isEmpty) ? NSNull() : validAssist,
                helpProc: NSNull(),
                isShampoo: false
            )
        }

        switch action {
        case "STOP_TIMER", "RESET_ZERO", "FINISH_MEASURE":
            let refEndDate = expectedEndMs > 0 ? Date(timeIntervalSince1970: expectedEndMs / 1000.0) : matchedSeat?.targetEndTime
            let wasAlreadyPeerStopped = ((extra["wasPeerStopped"] as? NSNumber)?.boolValue ?? (extra["wasPeerStopped"] as? Bool) ?? false)
                || self.wasRecentlyOrCurrentlyPeerStoppedSeat(seatId: resolvedSeatId, seatNumber: seatNum, targetEndTime: refEndDate)
                || (!(matchedSeat?.isRunning ?? true) && (matchedSeat?.status ?? .normal) != .normal)
            let preserved = resolvePreservedPeerOrValidAssistant(action == "RESET_ZERO", wasAlreadyPeerStopped)
            let hasPreservedPeerAction = !(preserved.assist is NSNull) || !(preserved.helpProc is NSNull) || preserved.isShampoo
            appendStopExpectedEndFilter(&queryItems)
            if action == "RESET_ZERO" && !hasPreservedPeerAction {
                body["status"] = "idle"
                body["color_staff_name"] = ""
            } else {
                body["status"] = "paused"
            }
            body["target_seconds"] = 0
            body["target_end_timestamp"] = 0
            body["paused_remaining_seconds"] = 0
            body["assistant_staff_name"] = preserved.assist
            body["help_process"] = preserved.helpProc
            body["is_shampooing"] = preserved.isShampoo
            body["check_target_end_timestamp"] = NSNull()
            body["check_total_seconds"] = NSNull()
            body["check_process"] = NSNull()
            body["check_staff_name"] = NSNull()

        case "STOP_ALARM":
            if stopKind == "check" {
                let extraChk = (extra["checkTotalSeconds"] as? NSNumber)?.intValue ?? (extra["checkTotalSeconds"] as? Int)
                let preservedChk = max(60, extraChk ?? matchedSeat?.checkTotalSeconds ?? 60)
                body["check_target_end_timestamp"] = NSNull()
                body["check_total_seconds"] = preservedChk
                body["check_staff_name"] = effectiveStaff
            } else {
                let refEndDate = expectedEndMs > 0 ? Date(timeIntervalSince1970: expectedEndMs / 1000.0) : matchedSeat?.targetEndTime
                let wasAlreadyPeerStopped = ((extra["wasPeerStopped"] as? NSNumber)?.boolValue ?? (extra["wasPeerStopped"] as? Bool) ?? false)
                    || self.wasRecentlyOrCurrentlyPeerStoppedSeat(seatId: resolvedSeatId, seatNumber: seatNum, targetEndTime: refEndDate)
                    || (!(matchedSeat?.isRunning ?? true) && (matchedSeat?.status ?? .normal) != .normal)
                let preserved = resolvePreservedPeerOrValidAssistant(false, wasAlreadyPeerStopped)
                appendStopExpectedEndFilter(&queryItems)
                body["status"] = "paused"
                body["target_seconds"] = 0
                body["target_end_timestamp"] = 0
                body["paused_remaining_seconds"] = 0
                body["assistant_staff_name"] = preserved.assist
                body["help_process"] = preserved.helpProc
                body["is_shampooing"] = preserved.isShampoo
                body["check_target_end_timestamp"] = NSNull()
                body["check_total_seconds"] = NSNull()
                body["check_process"] = NSNull()
                body["check_staff_name"] = NSNull()
            }

        case "ENTER_HELP", "START_SHAMPOO":
            appendStopExpectedEndFilter(&queryItems)
            let rawProc = ((extra["helpProcess"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let resolvedProc = (action == "START_SHAMPOO" || rawProc.isEmpty || rawProc == "shampoo") ? "シャンプー" : rawProc
            let isShampoo = (resolvedProc == "シャンプー")
            body["status"] = "paused"
            body["target_seconds"] = 0
            body["target_end_timestamp"] = 0
            body["paused_remaining_seconds"] = 0
            body["assistant_staff_name"] = effectiveStaff
            body["help_process"] = resolvedProc
            body["is_shampooing"] = isShampoo
            body["check_target_end_timestamp"] = NSNull()
            body["check_total_seconds"] = NSNull()
            body["check_process"] = NSNull()
            body["check_staff_name"] = NSNull()

        case "FINISH_SHAMPOO", "UPDATE_STATUS":
            queryItems.append(URLQueryItem(name: "status", value: "neq.running"))
            let nextActionStatus = ((extra["actionStatus"] as? String) ?? "normal").trimmingCharacters(in: .whitespacesAndNewlines)
            if action == "FINISH_SHAMPOO" || nextActionStatus.isEmpty || nextActionStatus == "normal" {
                body["status"] = "idle"
                body["color_staff_name"] = ""
            }
            body["is_shampooing"] = false
            body["assistant_staff_name"] = NSNull()
            body["help_process"] = NSNull()

        case "COMPLETE_CHECK":
            queryItems.append(URLQueryItem(name: "status", value: "eq.running"))
            let extraChk = (extra["checkTotalSeconds"] as? NSNumber)?.intValue ?? (extra["checkTotalSeconds"] as? Int)
            let preservedChk = max(60, extraChk ?? matchedSeat?.checkTotalSeconds ?? 60)
            body["check_target_end_timestamp"] = NSNull()
            body["check_total_seconds"] = preservedChk
            body["check_staff_name"] = effectiveStaff

        case "CANCEL_CHECK":
            body["check_target_end_timestamp"] = NSNull()
            body["check_total_seconds"] = NSNull()
            body["check_process"] = NSNull()
            body["check_staff_name"] = NSNull()

        case "SET_CHECK_TIMER":
            queryItems.append(URLQueryItem(name: "status", value: "eq.running"))
            let chkSec = (extra["checkTotalSeconds"] as? NSNumber)?.intValue ?? (extra["checkTotalSeconds"] as? Int) ?? 0
            let chkEndVal = (extra["checkEndTimestamp"] as? NSNumber)?.doubleValue ?? (extra["checkEndTimestamp"] as? Double) ?? 0
            guard chkSec > 0, chkEndVal.isFinite, chkEndVal > 1_000_000_000_000 else { return }
            let rawChkProc = ((extra["checkProcess"] as? String) ?? "チェック").trimmingCharacters(in: .whitespacesAndNewlines)
            let rawChkStaff = ((extra["checkStaffName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            body["check_total_seconds"] = chkSec
            body["check_target_end_timestamp"] = safeEpochMillisInt64(chkEndVal)
            body["check_process"] = rawChkProc.isEmpty ? "チェック" : rawChkProc
            body["check_staff_name"] = rawChkStaff.isEmpty ? NSNull() : rawChkStaff
            let shouldSetCreatorToMe = (preActionSeat ?? matchedSeat)?.shouldClaimOrRefreshCreatorAsMe(currentUserName: effectiveStaff, myUid: uid) ?? false
            if shouldSetCreatorToMe {
                body["color_staff_name"] = effectiveStaff
                if Self.isValidCloudUUID(uid) {
                    body["created_by"] = uid
                }
            }

        case "ASSIGN_HELP":
            let isSubCheck = (extra["isSubCheck"] as? NSNumber)?.boolValue ?? (extra["isSubCheck"] as? Bool) ?? false
            let shouldSetCreatorToMe = (preActionSeat ?? matchedSeat)?.shouldClaimOrRefreshCreatorAsMe(currentUserName: effectiveStaff, myUid: uid) ?? false
            if isSubCheck {
                let rawChkStaff = ((extra["checkStaffName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let rawChkProc = ((extra["checkProcess"] as? String) ?? "チェック").trimmingCharacters(in: .whitespacesAndNewlines)
                body["check_process"] = rawChkProc.isEmpty ? "チェック" : rawChkProc
                body["check_staff_name"] = rawChkStaff.isEmpty ? NSNull() : rawChkStaff
                if shouldSetCreatorToMe {
                    body["color_staff_name"] = effectiveStaff
                    if Self.isValidCloudUUID(uid) {
                        body["created_by"] = uid
                    }
                }
            } else {
                let rawProc = ((extra["helpProcess"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let rawAssist = ((extra["assistantStaffName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if rawProc == "ヘルプなし" || rawAssist == "ヘルプなし" {
                    body["help_process"] = "ヘルプなし"
                    body["assistant_staff_name"] = "ヘルプなし"
                    body["is_shampooing"] = false
                    if shouldSetCreatorToMe {
                        body["color_staff_name"] = effectiveStaff
                        if Self.isValidCloudUUID(uid) {
                            body["created_by"] = uid
                        }
                    }
                } else {
                    let resolvedProc = (rawProc.isEmpty && !rawAssist.isEmpty) ? "シャンプー" : rawProc
                    body["help_process"] = resolvedProc.isEmpty ? NSNull() : resolvedProc
                    body["assistant_staff_name"] = rawAssist.isEmpty ? NSNull() : rawAssist
                    body["is_shampooing"] = false
                    if resolvedProc == "チェック" && !rawAssist.isEmpty {
                        body["check_staff_name"] = rawAssist
                    }
                    if shouldSetCreatorToMe {
                        body["color_staff_name"] = effectiveStaff
                        if Self.isValidCloudUUID(uid) {
                            body["created_by"] = uid
                        }
                    }
                }
            }

        case "RECRUIT_HELP":
            let isSubCheck = (extra["isSubCheck"] as? NSNumber)?.boolValue ?? (extra["isSubCheck"] as? Bool) ?? false
            let rawProc = ((extra["helpProcess"] as? String) ?? (extra["checkProcess"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if isSubCheck {
                body["check_process"] = rawProc.isEmpty ? "チェック" : rawProc
                body["check_staff_name"] = "募集中"
            } else {
                body["help_process"] = rawProc.isEmpty ? "シャンプー" : rawProc
                body["assistant_staff_name"] = "募集中"
                body["is_shampooing"] = false
            }
            let shouldSetCreatorToMe = (preActionSeat ?? matchedSeat)?.shouldClaimOrRefreshCreatorAsMe(currentUserName: effectiveStaff, myUid: uid) ?? false
            if shouldSetCreatorToMe {
                body["color_staff_name"] = effectiveStaff
                if Self.isValidCloudUUID(uid) {
                    body["created_by"] = uid
                }
            }

        case "CLEAR_STAFF":
            body["help_process"] = NSNull()
            body["assistant_staff_name"] = NSNull()
            body["is_shampooing"] = false

        case "CLAIM_CHECK":
            body["check_staff_name"] = effectiveStaff

        case "START_TIMER":
            guard hasUUIDSeatId || hasLabelCandidate else { return }
            let targetSec = (extra["targetSeconds"] as? NSNumber)?.intValue ?? (extra["targetSeconds"] as? Int) ?? 0
            let targetEndVal = (extra["targetEndTimestamp"] as? NSNumber)?.doubleValue ?? (extra["targetEndTimestamp"] as? Double) ?? 0
            guard targetSec > 0, targetEndVal.isFinite, targetEndVal > 1_000_000_000_000 else { return }
            body["status"] = "running"
            body["target_seconds"] = targetSec
            body["target_end_timestamp"] = safeEpochMillisInt64(targetEndVal)
            body["paused_remaining_seconds"] = 0
            body["color_staff_name"] = effectiveStaff
            if Self.isValidCloudUUID(uid) {
                body["created_by"] = uid
            }
            body["assistant_staff_name"] = NSNull()
            body["help_process"] = NSNull()
            body["is_shampooing"] = false
            let chkSec = (extra["checkTotalSeconds"] as? NSNumber)?.intValue ?? (extra["checkTotalSeconds"] as? Int) ?? 0
            let chkEndVal = (extra["checkEndTimestamp"] as? NSNumber)?.doubleValue ?? (extra["checkEndTimestamp"] as? Double) ?? 0
            if chkSec > 0 && chkSec < targetSec && chkEndVal.isFinite && chkEndVal > 1_000_000_000_000 {
                let rawChkProc = ((extra["checkProcess"] as? String) ?? "チェック").trimmingCharacters(in: .whitespacesAndNewlines)
                let rawChkStaff = ((extra["checkStaffName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                body["check_total_seconds"] = chkSec
                body["check_target_end_timestamp"] = safeEpochMillisInt64(chkEndVal)
                body["check_process"] = rawChkProc.isEmpty ? "チェック" : rawChkProc
                body["check_staff_name"] = rawChkStaff.isEmpty ? NSNull() : rawChkStaff
            } else {
                body["check_total_seconds"] = NSNull()
                body["check_target_end_timestamp"] = NSNull()
                body["check_process"] = NSNull()
                body["check_staff_name"] = NSNull()
            }

        case "ADJUST_TIME":
            guard hasUUIDSeatId || hasLabelCandidate else { return }
            let isSubCheck = (extra["isSubCheck"] as? NSNumber)?.boolValue ?? (extra["isSubCheck"] as? Bool) ?? false
            if isSubCheck {
                queryItems.append(URLQueryItem(name: "status", value: "eq.running"))
                let chkEndVal = (extra["checkEndTimestamp"] as? NSNumber)?.doubleValue ?? (extra["checkEndTimestamp"] as? Double) ?? 0
                guard chkEndVal.isFinite, chkEndVal > 1_000_000_000_000 else { return }
                body["check_target_end_timestamp"] = safeEpochMillisInt64(chkEndVal)
                let chkSec = (extra["checkTotalSeconds"] as? NSNumber)?.intValue ?? (extra["checkTotalSeconds"] as? Int) ?? 0
                if chkSec > 0 {
                    body["check_total_seconds"] = chkSec
                }
            } else {
                let targetEndVal = (extra["targetEndTimestamp"] as? NSNumber)?.doubleValue ?? (extra["targetEndTimestamp"] as? Double) ?? 0
                guard targetEndVal.isFinite, targetEndVal > 1_000_000_000_000 else { return }
                body["target_end_timestamp"] = safeEpochMillisInt64(targetEndVal)
                let totalSec = (extra["totalSeconds"] as? NSNumber)?.intValue ?? (extra["totalSeconds"] as? Int) ?? 0
                if totalSec > 0 {
                    body["target_seconds"] = totalSec
                }
                if targetEndVal > nowMs {
                    body["status"] = "running"
                    body["is_shampooing"] = false
                    body["paused_remaining_seconds"] = 0
                }
            }

        default:
            return
        }

        guard var comps = URLComponents(string: "\(Self.supabaseRestBaseURL)/salon_timers") else { return }
        comps.queryItems = queryItems
        guard let url = comps.url,
              JSONSerialization.isValidJSONObject(body),
              let jsonData = try? JSONSerialization.data(withJSONObject: body, options: []) else {
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.timeoutInterval = 6.0
        request.setValue(Self.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(Self.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        request.httpBody = jsonData

        final class DirectCloudExpiringState {
            let lock = NSLock()
            var isExpired = false
            var shouldRetryWithoutUpdatedBy = false
            var patchSucceeded = false
            var currentTask: URLSessionDataTask?
            var currentSema: DispatchSemaphore?
        }
        let expState = DirectCloudExpiringState()

        // ★ タップ直後に手首を下ろして画面が消灯してもwatchOSがHTTPS送信完了までネットワークを保持するよう expiringActivity で保護
        //   （万一OSから expired == true が通知された場合は即座に通信タスクを cancel しセマフォを解放して 0xbada5e47 強制終了を100%防止）
        ProcessInfo.processInfo.performExpiringActivity(withReason: "SalonDirectCloudSync-\(action)") { [weak self] expired in
            if expired {
                expState.lock.lock()
                expState.isExpired = true
                let taskToCancel = expState.currentTask
                let semaToSignal = expState.currentSema
                expState.currentTask = nil
                expState.currentSema = nil
                expState.lock.unlock()
                taskToCancel?.cancel()
                semaToSignal?.signal()
                return
            }
            expState.lock.lock()
            if expState.isExpired {
                expState.lock.unlock()
                return
            }
            let sema = DispatchSemaphore(value: 0)
            expState.currentSema = sema
            expState.lock.unlock()

            let task = URLSession.shared.dataTask(with: request) { _, response, error in
                if let error = error {
                    print("[WatchCloudSync] Direct PATCH \(action) error: \(error.localizedDescription)")
                } else if let http = response as? HTTPURLResponse {
                    if (200...299).contains(http.statusCode) {
                        expState.lock.lock()
                        expState.patchSucceeded = true
                        expState.lock.unlock()
                    } else {
                        print("[WatchCloudSync] Direct PATCH \(action) status: \(http.statusCode)")
                        if http.statusCode == 400 && body["updated_by"] != nil {
                            expState.lock.lock()
                            expState.shouldRetryWithoutUpdatedBy = true
                            expState.lock.unlock()
                        }
                    }
                }
                sema.signal()
            }
            expState.lock.lock()
            if expState.isExpired {
                expState.currentSema = nil
                expState.lock.unlock()
                task.cancel()
                return
            }
            expState.currentTask = task
            expState.lock.unlock()

            task.resume()
            _ = sema.wait(timeout: .now() + 3.5)

            expState.lock.lock()
            let expiredAfterFirst = expState.isExpired
            let shouldRetry = expState.shouldRetryWithoutUpdatedBy
            expState.currentTask = nil
            expState.currentSema = nil
            expState.lock.unlock()
            if expiredAfterFirst {
                task.cancel()
                return
            }

            // ★ Supabase 側に updated_by カラムが存在しない環境で 400 Bad Request となった場合は即座に updated_by を外して再送信する
            if shouldRetry {
                Self.updatedByColumnUnsupported = true
                var fallbackBody = body
                fallbackBody.removeValue(forKey: "updated_by")
                if JSONSerialization.isValidJSONObject(fallbackBody),
                   let fallbackData = try? JSONSerialization.data(withJSONObject: fallbackBody, options: []) {
                    var retryReq = request
                    retryReq.httpBody = fallbackData
                    let retrySema = DispatchSemaphore(value: 0)
                    let retryTask = URLSession.shared.dataTask(with: retryReq) { _, retryResp, retryErr in
                        if let retryErr = retryErr {
                            print("[WatchCloudSync] Direct PATCH retry \(action) error: \(retryErr.localizedDescription)")
                        } else if let http = retryResp as? HTTPURLResponse {
                            if (200...299).contains(http.statusCode) {
                                expState.lock.lock()
                                expState.patchSucceeded = true
                                expState.lock.unlock()
                            } else {
                                print("[WatchCloudSync] Direct PATCH retry \(action) status: \(http.statusCode)")
                            }
                        }
                        retrySema.signal()
                    }
                    expState.lock.lock()
                    if expState.isExpired {
                        expState.lock.unlock()
                        retryTask.cancel()
                        return
                    }
                    expState.currentTask = retryTask
                    expState.currentSema = retrySema
                    expState.lock.unlock()

                    retryTask.resume()
                    _ = retrySema.wait(timeout: .now() + 3.5)

                    expState.lock.lock()
                    let expiredAfterRetry = expState.isExpired
                    expState.currentTask = nil
                    expState.currentSema = nil
                    expState.lock.unlock()
                    if expiredAfterRetry {
                        retryTask.cancel()
                        return
                    }
                }
            }

            expState.lock.lock()
            let didPatchSucceed = expState.patchSucceeded
            expState.lock.unlock()

            if didPatchSucceed {
                let effectivePushCoord: DirectPushCoordinationState = {
                    if let c = pushCoord { return c }
                    let c = DirectPushCoordinationState()
                    c.markNeedsDirectPush()
                    return c
                }()
                effectivePushCoord.markPatchSucceeded { [weak self] in
                    self?.sendDirectExpoPushFromWatch(
                        salonId: salonId,
                        uid: uid,
                        actorName: effectiveStaff,
                        action: action,
                        seatLabel: withSuffixLabel,
                        seatNum: seatNum,
                        resolvedSeatId: resolvedSeatId,
                        matchedSeat: matchedSeat,
                        preActionSeat: preActionSeat ?? matchedSeat,
                        memberIdMap: memberIdMapSnapshot,
                        patchBody: body,
                        extra: extra
                    )
                }
            }

            if !didPatchSucceed || !hasUUIDSeatId {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    self?.pollCloudTimersFromSupabaseIfNeeded(force: true)
                }
            }
        }
    }

    private struct WatchPushPlanItem {
        let eventType: String
        let stateDisc: String
        let title: String
        let bodyText: String
        let colorHex: String
        let isStakeholderScoped: Bool
        let isPersonalTargetOnly: Bool
        let targetStaffNames: [String]
        let includeCreator: Bool
    }

    // ★ 3層共通（iPhone JS / Watch Swift / Supabase Edge Function TS 完全一致）のセマンティックキー・stateDisc・collapseId 生成
    static func normalizeSemanticToken(_ raw: String?) -> String {
        guard let raw = raw else { return "" }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let noSpaces = String(String.UnicodeScalarView(trimmed.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }))
        return noSpaces.replacingOccurrences(of: "|", with: "_").lowercased()
    }

    static func buildPeerEventStateDisc(
        eventType: String,
        prevAssist: String = "",
        nextAssist: String = "",
        helpProc: String = "",
        nextHelpProc: String = "",
        prevCheckStaff: String = "",
        nextCheckStaff: String = "",
        checkProc: String = "",
        recruitProc: String = "",
        procLabel: String = "",
        nextEndMs: Int64 = 0,
        nextCheckEndMs: Int64 = 0,
        fallbackStateDisc: String = ""
    ) -> String {
        let ev = normalizeSemanticToken(eventType)
        guard !ev.isEmpty else { return "" }
        let canonHelp: (String) -> String = { p in
            let n = normalizeSemanticToken(p)
            return (n.isEmpty || n == "ヘルプ" || n == "ヘルプなし" || n == "none") ? "シャンプー" : n
        }
        let canonCheck: (String) -> String = { p in
            let n = normalizeSemanticToken(p)
            return n.isEmpty ? "チェック" : n
        }
        let canonUnassignNext: (String, String) -> String = { staff, proc in
            let np = normalizeSemanticToken(proc)
            let ns = normalizeSemanticToken(staff)
            if np == "ヘルプなし" || ns == "ヘルプなし" || ns == "none" { return "ヘルプなし" }
            if ns.isEmpty || ns == "未定" { return "none" }
            return ns
        }
        switch ev {
        case "assign_assist":
            return "\(normalizeSemanticToken(nextAssist)):\(canonHelp(helpProc))"
        case "unassign_assist":
            return "\(normalizeSemanticToken(prevAssist))->\(canonUnassignNext(nextAssist, nextHelpProc))"
        case "assign_check":
            return "\(normalizeSemanticToken(nextCheckStaff)):\(canonCheck(checkProc))"
        case "unassign_check":
            return "\(normalizeSemanticToken(prevCheckStaff))->\(canonUnassignNext(nextCheckStaff, ""))"
        case "recruit":
            let r = !recruitProc.isEmpty ? recruitProc : (!helpProc.isEmpty ? helpProc : "シャンプー")
            return normalizeSemanticToken(r)
        case "time_adjust", "timer_start", "assign_main":
            let bucket = Int64((Double(max(0, nextEndMs)) / 5000.0).rounded(.toNearestOrAwayFromZero))
            return "\(bucket)"
        case "add_check":
            let bucket = Int64((Double(max(0, nextCheckEndMs)) / 5000.0).rounded(.toNearestOrAwayFromZero))
            return "\(bucket):\(canonCheck(checkProc))"
        case "status_change":
            let pl = procLabel.isEmpty ? "none" : procLabel
            let na = nextAssist.isEmpty ? "none" : nextAssist
            return "\(normalizeSemanticToken(pl)):\(normalizeSemanticToken(na))"
        case "stop", "check_done":
            return "stop"
        default:
            return normalizeSemanticToken(fallbackStateDisc)
        }
    }

    static func fnv1a32HexUtf8(_ input: String) -> String {
        var hash: UInt32 = 0x811c9dc5
        for byte in input.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 0x01000193
        }
        return String(format: "%08x", hash)
    }

    static func buildExpoCollapseId(timerId: String, eventType: String, stateDisc: String = "") -> String {
        let normTimer = normalizeSemanticToken(timerId)
        let normEvt = normalizeSemanticToken(eventType)
        let normDisc = normalizeSemanticToken(stateDisc)
        let timerAscii = String(String.UnicodeScalarView(normTimer.unicodeScalars.filter {
            ($0.value >= 0x61 && $0.value <= 0x7a) || ($0.value >= 0x30 && $0.value <= 0x39)
        }))
        let evtAscii = String(String.UnicodeScalarView(normEvt.unicodeScalars.filter {
            ($0.value >= 0x61 && $0.value <= 0x7a) || ($0.value >= 0x30 && $0.value <= 0x39) || $0.value == 0x5f
        }))
        let shortTimer = timerAscii.isEmpty ? "seat" : String(timerAscii.prefix(12))
        let shortEvt = evtAscii.isEmpty ? "evt" : String(evtAscii.prefix(12))
        let hash8 = fnv1a32HexUtf8("\(normTimer)|\(normEvt)|\(normDisc)")
        return "at:\(shortTimer):\(shortEvt):\(hash8)"
    }

    static func buildPeerEventSemanticKey(timerIdOrLabel: String, eventType: String, actorId: String = "", stateDisc: String = "") -> String {
        let target = normalizeSemanticToken(timerIdOrLabel)
        let ev = normalizeSemanticToken(eventType)
        let actor = normalizeSemanticToken(actorId)
        let disc = normalizeSemanticToken(stateDisc)
        guard !target.isEmpty, !ev.isEmpty else { return "" }
        if !disc.isEmpty {
            return "\(target)|\(ev)|\(actor)|\(disc)"
        }
        return actor.isEmpty ? "\(target)|\(ev)" : "\(target)|\(ev)|\(actor)"
    }

    // ★ A-6: Watchから直接 Supabase Edge Function `notify-salon-event` を呼び出すフォールバック
    //   （Watchローカルの memberIdMap に未反映のカスタム呼び名スタッフが対象の場合や、トークン直接取得エラー時でもサーバー権限で確実に名前解決＆Push配信する）
    private func invokeNotifySalonEventEdgeFunctionFromWatch(
        salonId: String,
        uid: String,
        seatLabel: String,
        resolvedSeatId: String,
        preActionSeat: SeatTimerItem?,
        seatSnapshot: [String: Any],
        isoNow: String,
        alreadyNotifiedTokens: [String] = []
    ) {
        let edgeURLStr = Self.supabaseRestBaseURL.replacingOccurrences(of: "/rest/v1", with: "/functions/v1/notify-salon-event")
        guard let edgeURL = URL(string: edgeURLStr) else { return }

        let nullOrStr: (String?) -> Any = { val in
            guard let s = val?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return NSNull() }
            return s
        }
        let record: [String: Any] = [
            "id": resolvedSeatId,
            "salon_id": salonId,
            "seat_label": seatLabel,
            "status": (seatSnapshot["status"] as? String) ?? "paused",
            "target_seconds": (seatSnapshot["targetSeconds"] as? Int) ?? 0,
            "target_end_timestamp": (seatSnapshot["targetEndTimestamp"] as? Int64) ?? Int64(0),
            "paused_remaining_seconds": (seatSnapshot["pausedRemainingSeconds"] as? Int) ?? 0,
            "created_by": nullOrStr(seatSnapshot["createdBy"] as? String),
            "color_staff_name": nullOrStr(seatSnapshot["colorStaffName"] as? String),
            "assistant_staff_name": nullOrStr(seatSnapshot["assistantStaffName"] as? String),
            "help_process": nullOrStr(seatSnapshot["helpProcess"] as? String),
            "is_shampooing": (seatSnapshot["isShampooing"] as? Bool) ?? false,
            "check_target_end_timestamp": ((seatSnapshot["checkTargetEndTimestamp"] as? Int64) ?? 0) > 0
                ? ((seatSnapshot["checkTargetEndTimestamp"] as? Int64) ?? Int64(0))
                : NSNull(),
            "check_total_seconds": ((seatSnapshot["checkTotalSeconds"] as? Int) ?? 0) > 0
                ? ((seatSnapshot["checkTotalSeconds"] as? Int) ?? 0)
                : NSNull(),
            "check_process": nullOrStr(seatSnapshot["checkProcess"] as? String),
            "check_staff_name": nullOrStr(seatSnapshot["checkStaffName"] as? String),
            "updated_by": uid,
            "updated_at": isoNow
        ]

        var oldRecord: [String: Any] = [
            "id": resolvedSeatId,
            "salon_id": salonId,
            "seat_label": seatLabel
        ]
        if let prev = preActionSeat {
            let prevAssistVal: String? = {
                if prev.isNoHelpNeeded { return "ヘルプなし" }
                if prev.isRecruiting { return "募集中" }
                return prev.shampooStaff
            }()
            let prevEndMs: Int64 = prev.isRunning && prev.targetEndTime.timeIntervalSince1970 > 1_000_000_000
                ? safeEpochMillisInt64(prev.targetEndTime.timeIntervalSince1970 * 1000.0)
                : 0
            let prevChkEndMs: Int64 = (prev.isRunning && !prev.isCheckCompleted && (prev.checkTargetEndTime?.timeIntervalSince1970 ?? 0) > 1_000_000_000)
                ? safeEpochMillisInt64((prev.checkTargetEndTime?.timeIntervalSince1970 ?? 0) * 1000.0)
                : 0
            oldRecord["status"] = prev.isRunning ? "running" : "paused"
            oldRecord["target_seconds"] = prev.totalSeconds
            oldRecord["target_end_timestamp"] = prevEndMs
            oldRecord["paused_remaining_seconds"] = prev.isRunning ? 0 : prev.pausedRemainingSeconds
            oldRecord["created_by"] = nullOrStr(prev.createdBy)
            oldRecord["color_staff_name"] = nullOrStr(prev.creatorName)
            oldRecord["assistant_staff_name"] = nullOrStr(prevAssistVal)
            oldRecord["help_process"] = nullOrStr(prev.isNoHelpNeeded ? "ヘルプなし" : prev.helpProcess)
            oldRecord["is_shampooing"] = (prev.status == .shampoo)
            oldRecord["check_target_end_timestamp"] = prevChkEndMs > 0 ? prevChkEndMs : NSNull()
            oldRecord["check_total_seconds"] = (prev.checkTotalSeconds ?? 0) > 0 ? (prev.checkTotalSeconds ?? 0) : NSNull()
            oldRecord["check_process"] = nullOrStr(prev.checkProcess)
            oldRecord["check_staff_name"] = nullOrStr(prev.checkStaff)
        }

        let payload: [String: Any] = [
            "type": "UPDATE",
            "table": "salon_timers",
            "record": record,
            "old_record": oldRecord,
            "alreadyNotifiedTokens": alreadyNotifiedTokens
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let bodyData = try? JSONSerialization.data(withJSONObject: payload, options: []) else { return }

        var req = URLRequest(url: edgeURL)
        req.httpMethod = "POST"
        req.timeoutInterval = 4.5
        req.setValue(Self.supabaseAnonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(Self.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = bodyData
        URLSession.shared.dataTask(with: req).resume()
    }

    // ★ Watch単独でSupabase直接PATCHが成功し、かつ自端末iPhoneへの即時sendMessageが未接続/失敗した際、
    //   別スタッフのiPhone/Watchを即時起床させるダイレクトExpo Push配信（＋Edge Functionフォールバック）
    private func sendDirectExpoPushFromWatch(
        salonId: String,
        uid: String,
        actorName: String,
        action: String,
        seatLabel: String,
        seatNum: Int,
        resolvedSeatId: String,
        matchedSeat: SeatTimerItem?,
        preActionSeat: SeatTimerItem? = nil,
        memberIdMap: [String: String],
        patchBody: [String: Any],
        extra: [String: Any]
    ) {
        guard Self.isValidCloudUUID(salonId), Self.isValidCloudUUID(uid) else { return }
        let cleanActor = (actorName != "スタイリスト" && actorName != "自分" && actorName != "あなた") ? actorName : ""
        let actorLabel = cleanActor.isEmpty ? "" : "\(cleanActor)さんが"
        let nowMs = safeEpochMillisInt64(Date().timeIntervalSince1970 * 1000.0)
        let isoNow = (patchBody["updated_at"] as? String) ?? Self.iso8601FractionalFormatter.string(from: Date())
        let prevSeat = preActionSeat ?? matchedSeat

        let normalizeStaffKey: (String?) -> String = { raw in
            guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return "" }
            return s.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "　", with: "").lowercased()
        }
        let isValidNamedStaff: (String?) -> Bool = { raw in
            guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return false }
            let ignored: Set<String> = ["スタイリスト", "未定", "募集中", "ヘルプなし", "none", "自分", "あなた"]
            return !ignored.contains(s)
        }

        // seatSnapshot 辞書を先に構築（stateDisc・semanticKey・Edge Functionフォールバックでも共通利用）
        let statusStr: String = {
            if let patchStatus = patchBody["status"] as? String, !patchStatus.isEmpty {
                return patchStatus
            }
            if let seat = matchedSeat {
                return seat.isRunning ? "running" : "paused"
            }
            return (action == "STOP_TIMER" || action == "RESET_ZERO" || action == "FINISH_MEASURE" || action == "ENTER_HELP" || action == "START_SHAMPOO") ? "paused" : "running"
        }()
        let snapRunning = (statusStr == "running")
        let snapTargetSec: Int = {
            if let sec = patchBody["target_seconds"] as? Int { return max(0, sec) }
            if let sec = (patchBody["target_seconds"] as? NSNumber)?.intValue { return max(0, sec) }
            return snapRunning ? max(0, matchedSeat?.totalSeconds ?? 0) : 0
        }()
        let snapTargetEndMs: Int64 = {
            if !snapRunning { return 0 }
            if let end64 = patchBody["target_end_timestamp"] as? Int64 { return max(0, end64) }
            if let endNum = patchBody["target_end_timestamp"] as? NSNumber { return max(0, endNum.int64Value) }
            if let seat = matchedSeat, seat.targetEndTime.timeIntervalSince1970 > 1_000_000_000 {
                return safeEpochMillisInt64(seat.targetEndTime.timeIntervalSince1970 * 1000.0)
            }
            return 0
        }()
        let snapPausedRem: Int = {
            if snapRunning { return 0 }
            if let p = patchBody["paused_remaining_seconds"] as? Int { return max(0, p) }
            if let p = (patchBody["paused_remaining_seconds"] as? NSNumber)?.intValue { return max(0, p) }
            return 0
        }()
        let snapColorStaff: String = {
            if patchBody["color_staff_name"] != nil {
                return (patchBody["color_staff_name"] as? String) ?? ""
            }
            return matchedSeat?.creatorName ?? actorName
        }()
        let snapAssistStaff: String = {
            if patchBody["assistant_staff_name"] is NSNull { return "" }
            if let a = patchBody["assistant_staff_name"] as? String { return a }
            if let seat = matchedSeat {
                if seat.isNoHelpNeeded { return "ヘルプなし" }
                if seat.isRecruiting { return "募集中" }
                return seat.shampooStaff ?? ""
            }
            return ""
        }()
        let snapHelpProc: String = {
            if patchBody["help_process"] is NSNull { return "" }
            if let h = patchBody["help_process"] as? String { return h }
            return matchedSeat?.helpProcess ?? ""
        }()
        let snapIsShampooing: Bool = {
            if let b = patchBody["is_shampooing"] as? Bool { return b }
            if let n = patchBody["is_shampooing"] as? NSNumber { return n.boolValue }
            return matchedSeat?.status == .shampoo
        }()
        let snapCheckTotalSec: Int = {
            if patchBody["check_total_seconds"] is NSNull { return 0 }
            if let c = patchBody["check_total_seconds"] as? Int { return max(0, c) }
            if let c = (patchBody["check_total_seconds"] as? NSNumber)?.intValue { return max(0, c) }
            return max(0, matchedSeat?.checkTotalSeconds ?? 0)
        }()
        let snapCheckEndMs: Int64 = {
            if !snapRunning || patchBody["check_target_end_timestamp"] is NSNull { return 0 }
            if let e64 = patchBody["check_target_end_timestamp"] as? Int64 { return max(0, e64) }
            if let eNum = patchBody["check_target_end_timestamp"] as? NSNumber { return max(0, eNum.int64Value) }
            if let chkEnd = matchedSeat?.checkTargetEndTime, chkEnd.timeIntervalSince1970 > 1_000_000_000 {
                return safeEpochMillisInt64(chkEnd.timeIntervalSince1970 * 1000.0)
            }
            return 0
        }()
        let snapCheckProc: String = {
            if patchBody["check_process"] is NSNull { return "チェック" }
            if let cp = patchBody["check_process"] as? String, !cp.isEmpty { return cp }
            return matchedSeat?.checkProcess ?? "チェック"
        }()
        let snapCheckStaff: String = {
            if patchBody["check_staff_name"] is NSNull { return "" }
            if let cs = patchBody["check_staff_name"] as? String { return cs }
            return matchedSeat?.checkStaff ?? ""
        }()
        let resolvedSnapCreatedBy: String? = {
            if statusStr == "idle" {
                return nil
            }
            if let patchCb = (patchBody["created_by"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !patchCb.isEmpty {
                return patchCb
            }
            if action == "START_TIMER" && Self.isValidCloudUUID(uid) {
                return uid
            }
            if let matchedCb = matchedSeat?.createdBy?.trimmingCharacters(in: .whitespacesAndNewlines), !matchedCb.isEmpty {
                return matchedCb
            }
            if let prevCb = prevSeat?.createdBy?.trimmingCharacters(in: .whitespacesAndNewlines), !prevCb.isEmpty {
                return prevCb
            }
            return nil
        }()
        let seatSnapshot: [String: Any] = [
            "id": resolvedSeatId,
            "seatNumber": seatNum > 0 ? seatNum : (matchedSeat?.seatNumber ?? 1),
            "seatLabel": seatLabel,
            "status": statusStr,
            "targetSeconds": snapTargetSec,
            "targetEndTimestamp": snapTargetEndMs,
            "pausedRemainingSeconds": snapPausedRem,
            "createdBy": resolvedSnapCreatedBy ?? NSNull(),
            "colorStaffName": snapColorStaff,
            "assistantStaffName": snapAssistStaff,
            "helpProcess": snapHelpProc,
            "isShampooing": snapIsShampooing,
            "checkTargetEndTimestamp": snapCheckEndMs,
            "checkTotalSeconds": snapCheckTotalSec,
            "checkProcess": snapCheckProc,
            "checkStaffName": snapCheckStaff,
            "updatedBy": uid,
            "updatedAt": nowMs
        ]

        // ★ A-1: 変更前スナップショット（prevSeat）と変更後を比較し、担当解除（unassign_assist / unassign_check）を検出
        var plans: [WatchPushPlanItem] = []
        let prevAssistRaw: String = {
            guard let p = prevSeat, !p.isNoHelpNeeded, !p.isRecruiting else { return "" }
            return (p.shampooStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }()
        let prevHelpProcRaw = (prevSeat?.helpProcess ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let prevCheckRaw = (prevSeat?.checkStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let prevCheckProcRaw = prevSeat?.displayCheckProcess ?? "チェック"
        let hadActivePrevCheck = (prevSeat?.isRunning == true) && (prevSeat?.isCheckCompleted == false) && (prevSeat?.checkTargetEndTime != nil)

        if action == "ASSIGN_HELP" || action == "RECRUIT_HELP" || action == "CLEAR_STAFF" {
            let isSubCheckOnly = (action == "ASSIGN_HELP" || action == "RECRUIT_HELP")
                && ((extra["isSubCheck"] as? NSNumber)?.boolValue ?? (extra["isSubCheck"] as? Bool) ?? false)
            if !isSubCheckOnly,
               isValidNamedStaff(prevAssistRaw),
               !SeatTimerItem.isStaffMe(prevAssistRaw, currentUserName: self.currentUserName) {
                let nextValidAssist = isValidNamedStaff(snapAssistStaff) ? snapAssistStaff : ""
                if nextValidAssist.isEmpty || normalizeStaffKey(prevAssistRaw) != normalizeStaffKey(nextValidAssist) {
                    let procName = prevHelpProcRaw.isEmpty ? "ヘルプ" : prevHelpProcRaw
                    plans.append(WatchPushPlanItem(
                        eventType: "unassign_assist",
                        stateDisc: Self.buildPeerEventStateDisc(
                            eventType: "unassign_assist",
                            prevAssist: prevAssistRaw,
                            nextAssist: snapAssistStaff,
                            nextHelpProc: snapHelpProc
                        ),
                        title: "ℹ️ \(seatLabel) 担当解除",
                        bodyText: "\(seatLabel): \(actorLabel)\(procName)担当を変更・解除したため、担当から外れました",
                        colorHex: "#8E8E93",
                        isStakeholderScoped: true,
                        isPersonalTargetOnly: true,
                        targetStaffNames: [prevAssistRaw],
                        includeCreator: false
                    ))
                }
            }
        }

        if action == "ASSIGN_HELP" || action == "RECRUIT_HELP" || action == "CLAIM_CHECK" || action == "SET_CHECK_TIMER" {
            let touchesCheck: Bool = {
                if action == "CLAIM_CHECK" || action == "SET_CHECK_TIMER" { return true }
                if ((extra["helpProcess"] as? String) ?? "") == "チェック" { return true }
                return (extra["isSubCheck"] as? NSNumber)?.boolValue ?? (extra["isSubCheck"] as? Bool) ?? false
            }()
            if touchesCheck,
               hadActivePrevCheck,
               isValidNamedStaff(prevCheckRaw),
               !SeatTimerItem.isStaffMe(prevCheckRaw, currentUserName: self.currentUserName) {
                let nextValidCheck = isValidNamedStaff(snapCheckStaff) ? snapCheckStaff : ""
                if nextValidCheck.isEmpty || normalizeStaffKey(prevCheckRaw) != normalizeStaffKey(nextValidCheck) {
                    plans.append(WatchPushPlanItem(
                        eventType: "unassign_check",
                        stateDisc: Self.buildPeerEventStateDisc(
                            eventType: "unassign_check",
                            prevCheckStaff: prevCheckRaw,
                            nextCheckStaff: snapCheckStaff
                        ),
                        title: "ℹ️ \(seatLabel) \(prevCheckProcRaw)担当解除",
                        bodyText: "\(seatLabel): \(actorLabel)\(prevCheckProcRaw)担当を変更・解除したため、担当から外れました",
                        colorHex: "#8E8E93",
                        isStakeholderScoped: true,
                        isPersonalTargetOnly: true,
                        targetStaffNames: [prevCheckRaw],
                        includeCreator: false
                    ))
                }
            }
        }

        let prevWasUnpreparedIdleZero = (prevSeat?.isUnpreparedIdleZeroSeat == true)
        let allSeatStakeholders: [String] = [
            prevWasUnpreparedIdleZero ? nil : prevSeat?.creatorName,
            prevWasUnpreparedIdleZero ? nil : prevSeat?.shampooStaff,
            prevWasUnpreparedIdleZero ? nil : prevSeat?.checkStaff,
            matchedSeat?.creatorName,
            matchedSeat?.shampooStaff,
            matchedSeat?.checkStaff,
            snapColorStaff,
            snapAssistStaff,
            snapCheckStaff
        ].compactMap { $0 }.filter { isValidNamedStaff($0) }

        switch action {
        case "START_TIMER":
            let mins = max(1, Int(round(Double(snapTargetSec > 0 ? snapTargetSec : 600) / 60.0)))
            plans.append(WatchPushPlanItem(
                eventType: "timer_start",
                stateDisc: Self.buildPeerEventStateDisc(eventType: "timer_start", nextEndMs: snapTargetEndMs),
                title: "▶️ \(seatLabel) タイマー開始",
                bodyText: "\(seatLabel): \(actorLabel)タイマー（\(mins)分）を開始しました",
                colorHex: "#0A84FF",
                isStakeholderScoped: true,
                isPersonalTargetOnly: false,
                targetStaffNames: allSeatStakeholders,
                includeCreator: true
            ))
        case "ADJUST_TIME":
            let isSubCheck = (extra["isSubCheck"] as? NSNumber)?.boolValue ?? (extra["isSubCheck"] as? Bool) ?? false
            let deltaSec = (extra["secondsToAdd"] as? NSNumber)?.intValue ?? (extra["secondsToAdd"] as? Int) ?? 0
            if isSubCheck {
                plans.append(WatchPushPlanItem(
                    eventType: "time_adjust",
                    stateDisc: Self.buildPeerEventStateDisc(
                        eventType: "time_adjust",
                        nextEndMs: snapCheckEndMs > 0 ? snapCheckEndMs : snapTargetEndMs
                    ),
                    title: "⏱ \(seatLabel) \(snapCheckProc)時間変更",
                    bodyText: "\(seatLabel): \(actorLabel)\(snapCheckProc)タイマーの時間を変更しました",
                    colorHex: "#5E5CE6",
                    isStakeholderScoped: true,
                    isPersonalTargetOnly: false,
                    targetStaffNames: [snapColorStaff, snapCheckStaff].filter { isValidNamedStaff($0) },
                    includeCreator: true
                ))
            } else {
                let absMin = max(1, Int(round(Double(abs(deltaSec)) / 60.0)))
                let changeWord = deltaSec >= 0 ? "延長" : "短縮"
                let bodyTxt = deltaSec != 0
                    ? "\(seatLabel): \(actorLabel)放置タイムを\(absMin)分\(changeWord)しました"
                    : "\(seatLabel): \(actorLabel)放置タイムを変更しました"
                plans.append(WatchPushPlanItem(
                    eventType: "time_adjust",
                    stateDisc: Self.buildPeerEventStateDisc(eventType: "time_adjust", nextEndMs: snapTargetEndMs),
                    title: "⏱ \(seatLabel) 時間\(changeWord)",
                    bodyText: bodyTxt,
                    colorHex: "#0A84FF",
                    isStakeholderScoped: true,
                    isPersonalTargetOnly: false,
                    targetStaffNames: allSeatStakeholders,
                    includeCreator: true
                ))
            }
        case "STOP_TIMER", "RESET_ZERO", "FINISH_MEASURE":
            plans.append(WatchPushPlanItem(
                eventType: "stop",
                stateDisc: Self.buildPeerEventStateDisc(eventType: "stop"),
                title: "⏹ \(seatLabel) タイマー停止",
                bodyText: "\(seatLabel): \(actorLabel)タイマーを止めました",
                colorHex: "#FF9F0A",
                isStakeholderScoped: true,
                isPersonalTargetOnly: false,
                targetStaffNames: allSeatStakeholders,
                includeCreator: true
            ))
        case "STOP_ALARM":
            let stopKind = ((extra["kind"] as? String) ?? "").lowercased()
            if stopKind == "check" {
                let chkProc = prevCheckProcRaw.isEmpty ? "チェック" : prevCheckProcRaw
                plans.append(WatchPushPlanItem(
                    eventType: "check_done",
                    stateDisc: Self.buildPeerEventStateDisc(eventType: "check_done"),
                    title: "✓ \(seatLabel) \(chkProc)完了",
                    bodyText: "\(seatLabel): \(actorLabel)\(chkProc)を完了しました（全体タイマー継続中）",
                    colorHex: "#5E5CE6",
                    isStakeholderScoped: true,
                    isPersonalTargetOnly: false,
                    targetStaffNames: [snapColorStaff, prevCheckRaw, snapCheckStaff].filter { isValidNamedStaff($0) },
                    includeCreator: true
                ))
            } else {
                plans.append(WatchPushPlanItem(
                    eventType: "stop",
                    stateDisc: Self.buildPeerEventStateDisc(eventType: "stop"),
                    title: "⏹ \(seatLabel) タイマー停止",
                    bodyText: "\(seatLabel): \(actorLabel)タイマーを止めました",
                    colorHex: "#FF9F0A",
                    isStakeholderScoped: true,
                    isPersonalTargetOnly: false,
                    targetStaffNames: allSeatStakeholders,
                    includeCreator: true
                ))
            }
        case "ENTER_HELP", "START_SHAMPOO":
            let proc = snapHelpProc.isEmpty ? "シャンプー" : snapHelpProc
            let cHex = proc == "シャンプー" ? "#0A84FF" : (proc == "コーミング" ? "#30D158" : "#5E5CE6")
            plans.append(WatchPushPlanItem(
                eventType: "stop",
                stateDisc: Self.buildPeerEventStateDisc(eventType: "stop"),
                title: "⏹ \(seatLabel) \(proc)移行",
                bodyText: "\(seatLabel): \(actorLabel)\(proc)に入りました",
                colorHex: cHex,
                isStakeholderScoped: true,
                isPersonalTargetOnly: false,
                targetStaffNames: allSeatStakeholders,
                includeCreator: true
            ))
        case "COMPLETE_CHECK":
            let chkProc = prevCheckProcRaw.isEmpty ? "チェック" : prevCheckProcRaw
            plans.append(WatchPushPlanItem(
                eventType: "check_done",
                stateDisc: Self.buildPeerEventStateDisc(eventType: "check_done"),
                title: "✓ \(seatLabel) \(chkProc)完了",
                bodyText: "\(seatLabel): \(actorLabel)\(chkProc)を完了しました（全体タイマー継続中）",
                colorHex: "#5E5CE6",
                isStakeholderScoped: true,
                isPersonalTargetOnly: false,
                targetStaffNames: [snapColorStaff, prevCheckRaw, snapCheckStaff].filter { isValidNamedStaff($0) },
                includeCreator: true
            ))
        case "CANCEL_CHECK":
            let chkProc = prevCheckProcRaw.isEmpty ? "チェック" : prevCheckProcRaw
            plans.append(WatchPushPlanItem(
                eventType: "check_done",
                stateDisc: Self.buildPeerEventStateDisc(eventType: "check_done"),
                title: "⏹ \(seatLabel) \(chkProc)解除",
                bodyText: "\(seatLabel): \(actorLabel)\(chkProc)タイマーを解除しました",
                colorHex: "#5E5CE6",
                isStakeholderScoped: true,
                isPersonalTargetOnly: false,
                targetStaffNames: [snapColorStaff, prevCheckRaw].filter { isValidNamedStaff($0) },
                includeCreator: true
            ))
        case "CLAIM_CHECK":
            plans.append(WatchPushPlanItem(
                eventType: "assign_check",
                stateDisc: Self.buildPeerEventStateDisc(
                    eventType: "assign_check",
                    nextCheckStaff: snapCheckStaff,
                    checkProc: snapCheckProc
                ),
                title: "🔔 \(seatLabel) \(snapCheckProc)担当決定",
                bodyText: "\(seatLabel): \(actorLabel)\(snapCheckProc)担当に入りました",
                colorHex: "#5E5CE6",
                isStakeholderScoped: true,
                isPersonalTargetOnly: true,
                targetStaffNames: [snapColorStaff].filter { isValidNamedStaff($0) },
                includeCreator: true
            ))
        case "ASSIGN_HELP":
            let isSubCheck = (extra["isSubCheck"] as? NSNumber)?.boolValue ?? (extra["isSubCheck"] as? Bool) ?? false
            if isSubCheck {
                let chkStaff = ((extra["checkStaffName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let chkProc = ((extra["checkProcess"] as? String) ?? "チェック").trimmingCharacters(in: .whitespacesAndNewlines)
                if isValidNamedStaff(chkStaff) {
                    plans.append(WatchPushPlanItem(
                        eventType: "assign_check",
                        stateDisc: Self.buildPeerEventStateDisc(
                            eventType: "assign_check",
                            nextCheckStaff: chkStaff,
                            checkProc: chkProc
                        ),
                        title: "🔔 \(seatLabel) \(chkProc)担当指名",
                        bodyText: "\(seatLabel): \(actorLabel)\(chkStaff)さんを\(chkProc)担当に指定しました",
                        colorHex: "#5E5CE6",
                        isStakeholderScoped: true,
                        isPersonalTargetOnly: true,
                        targetStaffNames: [chkStaff, snapColorStaff].filter { isValidNamedStaff($0) },
                        includeCreator: true
                    ))
                }
            } else {
                let assist = ((extra["assistantStaffName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let proc = ((extra["helpProcess"] as? String) ?? "シャンプー").trimmingCharacters(in: .whitespacesAndNewlines)
                if isValidNamedStaff(assist) && proc != "ヘルプなし" {
                    plans.append(WatchPushPlanItem(
                        eventType: "assign_assist",
                        stateDisc: Self.buildPeerEventStateDisc(
                            eventType: "assign_assist",
                            nextAssist: assist,
                            helpProc: proc
                        ),
                        title: "🔔 \(seatLabel) \(proc)担当指名",
                        bodyText: "\(seatLabel): \(actorLabel)\(assist)さんを\(proc)担当に指定しました",
                        colorHex: "#30D158",
                        isStakeholderScoped: true,
                        isPersonalTargetOnly: true,
                        targetStaffNames: [assist, snapColorStaff].filter { isValidNamedStaff($0) },
                        includeCreator: true
                    ))
                }
            }
        case "RECRUIT_HELP":
            let isSubCheck = (extra["isSubCheck"] as? NSNumber)?.boolValue ?? (extra["isSubCheck"] as? Bool) ?? false
            let proc = isSubCheck ? snapCheckProc : (snapHelpProc.isEmpty ? "シャンプー" : snapHelpProc)
            plans.append(WatchPushPlanItem(
                eventType: "recruit",
                stateDisc: Self.buildPeerEventStateDisc(
                    eventType: "recruit",
                    helpProc: snapHelpProc,
                    recruitProc: proc
                ),
                title: "📢 \(seatLabel) \(proc)ヘルプ募集",
                bodyText: "\(seatLabel): \(actorLabel)\(proc)のヘルプを募集しています",
                colorHex: "#FF9F0A",
                isStakeholderScoped: false,
                isPersonalTargetOnly: false,
                targetStaffNames: [],
                includeCreator: false
            ))
        case "SET_CHECK_TIMER":
            let chkMin = max(1, Int(round(Double(snapCheckTotalSec > 0 ? snapCheckTotalSec : 300) / 60.0)))
            plans.append(WatchPushPlanItem(
                eventType: "add_check",
                stateDisc: Self.buildPeerEventStateDisc(
                    eventType: "add_check",
                    checkProc: snapCheckProc,
                    nextCheckEndMs: snapCheckEndMs
                ),
                title: "⏱ \(seatLabel) \(snapCheckProc)タイマー追加",
                bodyText: "\(seatLabel): \(actorLabel)\(snapCheckProc)タイマー（\(chkMin)分）を追加しました",
                colorHex: "#5E5CE6",
                isStakeholderScoped: true,
                isPersonalTargetOnly: false,
                targetStaffNames: [snapColorStaff, snapCheckStaff].filter { isValidNamedStaff($0) },
                includeCreator: true
            ))
        case "CLEAR_STAFF":
            break
        default:
            return
        }

        guard !plans.isEmpty else { return }

        let seatCreatedBy: String = {
            let snapCb = (resolvedSnapCreatedBy ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !snapCb.isEmpty { return snapCb }
            if !prevWasUnpreparedIdleZero,
               let prevCb = prevSeat?.createdBy?.trimmingCharacters(in: .whitespacesAndNewlines),
               !prevCb.isEmpty {
                return prevCb
            }
            return ""
        }()
        let hasOtherCreatorUid = !seatCreatedBy.isEmpty
            ? (seatCreatedBy.lowercased() != uid.lowercased())
            : (!prevWasUnpreparedIdleZero && prevSeat?.isCreatorMeExplicit == false)
        let isCallProcess = (snapHelpProc == "呼び出し") || ((extra["helpProcess"] as? String) == "呼び出し")

        var tokenComps = URLComponents(string: "\(Self.supabaseRestBaseURL)/salon_member_push_tokens")
        tokenComps?.queryItems = [
            URLQueryItem(name: "salon_id", value: "eq.\(salonId)"),
            URLQueryItem(name: "select", value: "user_id,expo_push_token"),
            URLQueryItem(name: "user_id", value: "neq.\(uid)")
        ]
        guard let tokenURL = tokenComps?.url else {
            invokeNotifySalonEventEdgeFunctionFromWatch(
                salonId: salonId,
                uid: uid,
                seatLabel: seatLabel,
                resolvedSeatId: resolvedSeatId,
                preActionSeat: prevSeat,
                seatSnapshot: seatSnapshot,
                isoNow: isoNow
            )
            return
        }

        var tokenReq = URLRequest(url: tokenURL)
        tokenReq.httpMethod = "GET"
        tokenReq.timeoutInterval = 3.5
        tokenReq.setValue(Self.supabaseAnonKey, forHTTPHeaderField: "apikey")
        tokenReq.setValue("Bearer \(Self.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        tokenReq.setValue("application/json", forHTTPHeaderField: "Accept")

        URLSession.shared.dataTask(with: tokenReq) { [weak self] data, resp, err in
            guard let self = self else { return }
            let httpOk = (resp as? HTTPURLResponse).map { (200...299).contains($0.statusCode) } ?? false
            guard err == nil,
                  httpOk,
                  let data = data,
                  let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                self.invokeNotifySalonEventEdgeFunctionFromWatch(
                    salonId: salonId,
                    uid: uid,
                    seatLabel: seatLabel,
                    resolvedSeatId: resolvedSeatId,
                    preActionSeat: prevSeat,
                    seatSnapshot: seatSnapshot,
                    isoNow: isoNow
                )
                return
            }

            let nonSelfRows = rows.filter { row in
                if let rowUid = (row["user_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !rowUid.isEmpty,
                   rowUid.lowercased() == uid.lowercased() {
                    return false
                }
                return true
            }
            guard !nonSelfRows.isEmpty else { return }

            var allMessages: [[String: Any]] = []
            var needsEdgeFallbackForUnresolved = false

            for plan in plans {
                var otherTargetNormNames = Set<String>()
                for rawName in plan.targetStaffNames where isValidNamedStaff(rawName) {
                    if !SeatTimerItem.isStaffMe(rawName, currentUserName: self.currentUserName) {
                        let norm = normalizeStaffKey(rawName)
                        if !norm.isEmpty {
                            otherTargetNormNames.insert(norm)
                        }
                    }
                }
                let planHasOtherCreator = plan.includeCreator && hasOtherCreatorUid
                let planHasUnknownCreatorOnStop = plan.includeCreator
                    && (plan.eventType == "stop" || plan.eventType == "check_done")
                    && seatCreatedBy.isEmpty
                    && (prevSeat?.isCreatorMe(currentUserName: self.currentUserName) == false)

                if plan.isStakeholderScoped
                    && otherTargetNormNames.isEmpty
                    && !planHasOtherCreator
                    && !(plan.includeCreator && isCallProcess)
                    && !planHasUnknownCreatorOnStop {
                    continue
                }

                var targetStakeholderUids = Set<String>()
                var resolvedNormNames = Set<String>()
                if plan.isStakeholderScoped {
                    if plan.includeCreator && !seatCreatedBy.isEmpty && seatCreatedBy.lowercased() != uid.lowercased() {
                        targetStakeholderUids.insert(seatCreatedBy.lowercased())
                    }
                    if !otherTargetNormNames.isEmpty {
                        for (mUid, mName) in memberIdMap {
                            let cleanUid = mUid.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                            guard !cleanUid.isEmpty, cleanUid != uid.lowercased() else { continue }
                            let normMemberName = normalizeStaffKey(mName)
                            if !normMemberName.isEmpty && otherTargetNormNames.contains(normMemberName) {
                                targetStakeholderUids.insert(cleanUid)
                                resolvedNormNames.insert(normMemberName)
                            }
                        }
                    }
                }

                let hasUnresolvedNamedTarget = !otherTargetNormNames.subtracting(resolvedNormNames).isEmpty
                let scopedRows: [[String: Any]] = {
                    if !plan.isStakeholderScoped {
                        return nonSelfRows
                    }
                    let matched = nonSelfRows.filter { row in
                        guard let rowUid = (row["user_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                              !rowUid.isEmpty else { return false }
                        return targetStakeholderUids.contains(rowUid)
                    }
                    if !matched.isEmpty {
                        if hasUnresolvedNamedTarget {
                            needsEdgeFallbackForUnresolved = true
                        }
                        return matched
                    }
                    // 個人指名・担当解除イベントは memberIdMap 未解決時に無関係メンバーへ全体配信せず Edge Function のサーバー側名前解決に委譲する
                    if plan.isPersonalTargetOnly {
                        if hasUnresolvedNamedTarget || planHasOtherCreator {
                            needsEdgeFallbackForUnresolved = true
                        }
                        return []
                    }
                    if hasUnresolvedNamedTarget {
                        needsEdgeFallbackForUnresolved = true
                    }
                    return (planHasUnknownCreatorOnStop || isCallProcess) ? nonSelfRows : []
                }()

                var seenTokens = Set<String>()
                let notifId = "wpush_\(plan.eventType)_\(resolvedSeatId)_\(nowMs)"
                let semKey = Self.buildPeerEventSemanticKey(
                    timerIdOrLabel: resolvedSeatId,
                    eventType: plan.eventType,
                    actorId: uid,
                    stateDisc: plan.stateDisc
                )
                let collapseId = Self.buildExpoCollapseId(
                    timerId: resolvedSeatId,
                    eventType: plan.eventType,
                    stateDisc: plan.stateDisc
                )
                let isGentle = plan.eventType.hasPrefix("unassign_")

                for row in scopedRows {
                    if let rowUid = (row["user_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !rowUid.isEmpty,
                       rowUid.lowercased() == uid.lowercased() {
                        continue
                    }
                    guard let token = (row["expo_push_token"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                          token.hasPrefix("ExponentPushToken["),
                          !seenTokens.contains(token) else { continue }
                    seenTokens.insert(token)
                    var msgObj: [String: Any] = [
                        "to": token,
                        "title": plan.title,
                        "body": plan.bodyText,
                        "priority": "high",
                        "_contentAvailable": true,
                        "collapseId": collapseId,
                        "interruptionLevel": isGentle ? "active" : "time-sensitive",
                        "channelId": "salon-shared-events",
                        "data": [
                            "type": "SALON_EVENT_PUSH",
                            "salonId": salonId,
                            "timerId": resolvedSeatId,
                            "seatNumber": seatNum,
                            "seatLabel": seatLabel,
                            "notifId": notifId,
                            "eventType": plan.eventType,
                            "stateDisc": plan.stateDisc,
                            "semanticKey": semKey,
                            "isGentleInfo": isGentle,
                            "notifText": plan.bodyText,
                            "notifColor": plan.colorHex,
                            "color": plan.colorHex,
                            "updatedBy": uid,
                            "actorId": uid,
                            "updatedAt": nowMs,
                            "seatSnapshot": seatSnapshot
                        ]
                    ]
                    if !isGentle {
                        msgObj["sound"] = "default"
                    }
                    allMessages.append(msgObj)
                }
            }

            if allMessages.isEmpty {
                if needsEdgeFallbackForUnresolved {
                    self.invokeNotifySalonEventEdgeFunctionFromWatch(
                        salonId: salonId,
                        uid: uid,
                        seatLabel: seatLabel,
                        resolvedSeatId: resolvedSeatId,
                        preActionSeat: prevSeat,
                        seatSnapshot: seatSnapshot,
                        isoNow: isoNow
                    )
                }
                return
            }

            guard let expoURL = URL(string: "https://exp.host/--/api/v2/push/send"),
                  JSONSerialization.isValidJSONObject(allMessages),
                  let pushBody = try? JSONSerialization.data(withJSONObject: allMessages, options: []) else { return }

            var pushReq = URLRequest(url: expoURL)
            pushReq.httpMethod = "POST"
            pushReq.timeoutInterval = 4.0
            pushReq.setValue("application/json", forHTTPHeaderField: "Content-Type")
            pushReq.setValue("application/json", forHTTPHeaderField: "Accept")
            pushReq.httpBody = pushBody
            let sentToTokens = Array(Set(allMessages.compactMap { ($0["to"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }))
            URLSession.shared.dataTask(with: pushReq) { [weak self] _, pushResp, pushErr in
                let pushOk = (pushResp as? HTTPURLResponse).map { (200...299).contains($0.statusCode) } ?? false
                if pushErr != nil || !pushOk || needsEdgeFallbackForUnresolved {
                    let alreadyDelivered = (pushErr == nil && pushOk) ? sentToTokens : []
                    self?.invokeNotifySalonEventEdgeFunctionFromWatch(
                        salonId: salonId,
                        uid: uid,
                        seatLabel: seatLabel,
                        resolvedSeatId: resolvedSeatId,
                        preActionSeat: prevSeat,
                        seatSnapshot: seatSnapshot,
                        isoNow: isoNow,
                        alreadyNotifiedTokens: alreadyDelivered
                    )
                }
            }.resume()
        }.resume()
    }

    // ★ Watchアクティブ・減光待機中（.active / .inactive）の直接Supabase補完ポーリング
    //   （共有相手がタイマーを開始・停止・変更した際、万一自端末iPhoneが休止・遅延でもWatch単独で完全同期）
    func pollCloudTimersFromSupabaseIfNeeded(force: Bool = false) {
        let salonId = self.cloudSalonId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isValidCloudUUID(salonId) else { return }
        let now = Date()
        if self.isDirectCloudPollInFlight {
            if now.timeIntervalSince(self.lastDirectCloudPollAt) > 5.5 {
                self.isDirectCloudPollInFlight = false
            } else {
                return
            }
        }
        let appState = WKApplication.shared().applicationState
        if !force && appState == .background {
            return
        }

        let hasRunningSeat = self.timers.contains(where: { $0.isRunning })
        let isPhoneReachable = WCSession.isSupported()
            && WCSession.default.activationState == .activated
            && WCSession.default.isReachable
        let minInterval: TimeInterval
        if force {
            minInterval = 0.35
        } else if appState == .active {
            minInterval = hasRunningSeat
                ? (isPhoneReachable ? 6.0 : 4.0)
                : (isPhoneReachable ? 12.0 : 8.0)
        } else {
            minInterval = hasRunningSeat
                ? (isPhoneReachable ? 15.0 : 8.0)
                : (isPhoneReachable ? 30.0 : 15.0)
        }
        guard now.timeIntervalSince(self.lastDirectCloudPollAt) >= minInterval else { return }
        self.lastDirectCloudPollAt = now
        self.isDirectCloudPollInFlight = true

        guard var comps = URLComponents(string: "\(Self.supabaseRestBaseURL)/salon_timers") else {
            self.isDirectCloudPollInFlight = false
            return
        }
        let baseSelect = "id,seat_label,status,target_seconds,target_end_timestamp,paused_remaining_seconds,created_by,color_staff_name,assistant_staff_name,help_process,is_shampooing,check_target_end_timestamp,check_total_seconds,check_process,check_staff_name,sort_order,updated_at"
        let selectFields = Self.updatedByColumnUnsupported ? baseSelect : "\(baseSelect),updated_by"
        comps.queryItems = [
            URLQueryItem(name: "salon_id", value: "eq.\(salonId)"),
            URLQueryItem(name: "select", value: selectFields),
            URLQueryItem(name: "order", value: "updated_at.desc")
        ]
        guard let url = comps.url else {
            self.isDirectCloudPollInFlight = false
            return
        }

        let requestGeneration = self.localActionGeneration
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 4.5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue(Self.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(Self.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                defer { self.isDirectCloudPollInFlight = false }
                // ★ GETリクエスト飛行中にWatch上でローカル操作（タイム入力開始・ヘルプ指定・停止等）が行われた場合は、
                //   リクエスト送信前の古いクラウド応答でローカル状態を上書きしないよう破棄し、0.8秒後に再ポーリングする
                guard self.localActionGeneration == requestGeneration else {
                    self.lastDirectCloudPollAt = .distantPast
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                        self?.pollCloudTimersFromSupabaseIfNeeded(force: true)
                    }
                    return
                }
                if let http = response as? HTTPURLResponse, http.statusCode == 400, !Self.updatedByColumnUnsupported {
                    Self.updatedByColumnUnsupported = true
                    self.isDirectCloudPollInFlight = false
                    self.lastDirectCloudPollAt = .distantPast
                    self.pollCloudTimersFromSupabaseIfNeeded(force: true)
                    return
                }
                guard error == nil,
                      let http = response as? HTTPURLResponse,
                      (200...299).contains(http.statusCode),
                      let data = data,
                      let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
                    return
                }
                guard self.cloudSalonId.trimmingCharacters(in: .whitespacesAndNewlines) == salonId else { return }
                self.reconcileTimersFromDirectCloudRows(rows)
            }
        }.resume()
    }

    private func reconcileTimersFromDirectCloudRows(_ rows: [[String: Any]]) {
        guard !rows.isEmpty else { return }
        let now = Date()
        let nowMs = now.timeIntervalSince1970 * 1000.0
        var updatedTimers = self.timers
        var didChange = false

        var dedupedRows: [[String: Any]] = []
        var seenRowLabels = Set<String>()
        for row in rows {
            guard let rId = (row["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !rId.isEmpty else { continue }
            let rawLabel = ((row["seat_label"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let normLabel = rawLabel.replacingOccurrences(of: "席", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            let dedupeKey = normLabel.isEmpty ? "id:\(rId)" : "lbl:\(normLabel)"
            guard !seenRowLabels.contains(dedupeKey) else { continue }
            seenRowLabels.insert(dedupeKey)
            dedupedRows.append(row)
        }
        guard !dedupedRows.isEmpty else { return }

        // ★ Bug 2.3修正: Watch側の timers が空配列の初回起動時や、iPhone非到達中に他スタッフが新規客席を追加した場合でも、
        //   未登録クラウド行をプレースホルダ席として安全に追記し、後続ループで稼働タイマー・アラーム予約・工程・通知を一括反映する
        var usedSeatNumbers = Set(updatedTimers.map { $0.seatNumber })
        var maxSeatNum = updatedTimers.map { $0.seatNumber }.max() ?? 0
        var newlyAppendedRowIds = Set<String>()
        var pendingNewSeats: [(sortKey: Int, item: SeatTimerItem)] = []
        for (rowIdx, row) in dedupedRows.enumerated() {
            guard let rId = (row["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !rId.isEmpty else { continue }
            let rawLabel = ((row["seat_label"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let normLabel = rawLabel.replacingOccurrences(of: "席", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            let rawDigits = rawLabel.prefix(while: { $0.isNumber })
            let parsedDigitNum = Int(rawDigits)

            let alreadyExists = updatedTimers.contains { cur in
                if cur.id == rId { return true }
                let curNorm = (cur.seatLabel ?? "\(cur.seatNumber)番").replacingOccurrences(of: "席", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !normLabel.isEmpty && curNorm == normLabel { return true }
                if let dNum = parsedDigitNum, dNum > 0, cur.seatNumber == dNum {
                    let curDigits = (cur.seatLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(while: { $0.isNumber })
                    if cur.seatLabel == nil || !curDigits.isEmpty {
                        return true
                    }
                }
                return false
            }
            guard !alreadyExists else { continue }

            let sortOrd = (row["sort_order"] as? NSNumber)?.intValue ?? (row["sort_order"] as? Int)
            let candidateNum: Int = {
                if let dNum = parsedDigitNum, dNum > 0, !usedSeatNumbers.contains(dNum) {
                    return dNum
                }
                if let sOrd = sortOrd, sOrd >= 0, !usedSeatNumbers.contains(sOrd + 1) {
                    return sOrd + 1
                }
                return maxSeatNum + 1
            }()
            usedSeatNumbers.insert(candidateNum)
            if candidateNum > maxSeatNum {
                maxSeatNum = candidateNum
            }
            let cCreatedBy = ((row["created_by"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let cColorStaff = ((row["color_staff_name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let cPausedRem = (row["paused_remaining_seconds"] as? NSNumber)?.intValue ?? (row["paused_remaining_seconds"] as? Int) ?? 0
            let cTargetSec = (row["target_seconds"] as? NSNumber)?.intValue ?? (row["target_seconds"] as? Int) ?? 0
            let rawSt = (row["status"] as? String) ?? "idle"
            let initPaused = (rawSt == "paused" && cPausedRem > 0) ? cPausedRem : 0
            let initTotal = (initPaused > 0) ? max(initPaused, cTargetSec) : 0
            let myInitUid = self.cloudUserId.trimmingCharacters(in: .whitespacesAndNewlines)
            let initCreatorExplicit: Bool? = {
                if Self.isValidCloudUUID(myInitUid) && Self.isValidCloudUUID(cCreatedBy) {
                    return cCreatedBy.caseInsensitiveCompare(myInitUid) == .orderedSame
                }
                if !cColorStaff.isEmpty && cColorStaff != "スタイリスト" {
                    return SeatTimerItem.isStaffMe(cColorStaff, currentUserName: self.currentUserName)
                }
                return nil
            }()
            let placeholder = SeatTimerItem(
                id: rId,
                seatNumber: candidateNum,
                seatLabel: rawLabel.isEmpty ? "\(candidateNum)番席" : rawLabel,
                createdBy: cCreatedBy.isEmpty ? nil : cCreatedBy,
                creatorName: cColorStaff.isEmpty ? "スタイリスト" : cColorStaff,
                isCreatorMeExplicit: initCreatorExplicit,
                totalSeconds: initTotal,
                targetEndTime: Date(timeIntervalSince1970: 0),
                isRunning: false,
                pausedRemainingSeconds: initPaused,
                isCollapsed: false
            )
            newlyAppendedRowIds.insert(rId)
            let sortKey = sortOrd ?? (parsedDigitNum ?? (1000 + rowIdx))
            pendingNewSeats.append((sortKey: sortKey, item: placeholder))
        }
        if !pendingNewSeats.isEmpty {
            pendingNewSeats.sort {
                if $0.sortKey != $1.sortKey { return $0.sortKey < $1.sortKey }
                return $0.item.seatNumber < $1.item.seatNumber
            }
            updatedTimers.append(contentsOf: pendingNewSeats.map { $0.item })
            didChange = true
        }

        for i in updatedTimers.indices {
            let cur = updatedTimers[i]
            let prevKey = "seat-\(cur.seatNumber)"
            let curCleanLabel = (cur.seatLabel ?? "\(cur.seatNumber)番").replacingOccurrences(of: "席", with: "").trimmingCharacters(in: .whitespacesAndNewlines)

            // order=updated_at.desc で取得しているため、同一席ラベルに複数行がある場合でも最も新しく更新された行を最優先で選択
            let matchedRow: [String: Any]? = rows.first(where: { row in
                let rLabel = ((row["seat_label"] as? String) ?? "").replacingOccurrences(of: "席", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
                return !curCleanLabel.isEmpty && rLabel == curCleanLabel
            }) ?? rows.first(where: { ($0["id"] as? String) == cur.id })
            ?? rows.first(where: { row in
                let rLabel = ((row["seat_label"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let digits = rLabel.prefix(while: { $0.isNumber })
                return !digits.isEmpty && Int(digits) == cur.seatNumber
            })
            guard let row = matchedRow else { continue }

            let rowId = (row["id"] as? String) ?? cur.id
            let cloudUpdatedAt = Self.parseCloudISODate(row["updated_at"])
            let cloudLabel = ((row["seat_label"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let rawCloudStatus = (row["status"] as? String) ?? "idle"
            let cloudTargetSec = (row["target_seconds"] as? NSNumber)?.intValue ?? (row["target_seconds"] as? Int) ?? 0
            let rawCloudTargetEndMs = (row["target_end_timestamp"] as? NSNumber)?.doubleValue ?? (row["target_end_timestamp"] as? Double) ?? 0
            let cloudCreatedBy = ((row["created_by"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let cloudUpdatedBy = ((row["updated_by"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let cloudColorStaff = ((row["color_staff_name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let rawCloudAssist = ((row["assistant_staff_name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let rawCloudCheckStaff = ((row["check_staff_name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let rawCloudIsCheckCompleted = (row["is_check_completed"] as? NSNumber)?.boolValue ?? (row["is_check_completed"] as? Bool) ?? false
            let myUid = self.cloudUserId.trimmingCharacters(in: .whitespacesAndNewlines)
            let hasValidMyUid = Self.isValidCloudUUID(myUid)
            let hasValidCloudCreatorUid = Self.isValidCloudUUID(cloudCreatedBy)
            let isCloudCreatorMe: Bool = {
                if hasValidMyUid && hasValidCloudCreatorUid {
                    return cloudCreatedBy.caseInsensitiveCompare(myUid) == .orderedSame
                }
                if !cloudColorStaff.isEmpty && cloudColorStaff != "スタイリスト" {
                    return SeatTimerItem.isStaffMe(cloudColorStaff, currentUserName: self.currentUserName)
                }
                return cur.isCreatorMe(currentUserName: self.currentUserName)
            }()
            let hasOtherCloudAssistant = !rawCloudAssist.isEmpty && rawCloudAssist != "ヘルプなし" && rawCloudAssist != "none" && rawCloudAssist != "募集中" && !SeatTimerItem.isStaffMe(rawCloudAssist, currentUserName: self.currentUserName)
            let hasOtherCloudChecker = !rawCloudIsCheckCompleted && !rawCloudCheckStaff.isEmpty && rawCloudCheckStaff != "募集中" && !SeatTimerItem.isStaffMe(rawCloudCheckStaff, currentUserName: self.currentUserName)
            let activeBuildCutoff: Date? = self.buildUpdateExpiryCutoff.flatMap { now.timeIntervalSince($0) <= 60.0 ? $0 : nil }
            let isExpiredBeforeBuildUpdate: Bool = {
                guard let buildCutoff = activeBuildCutoff,
                      rawCloudStatus == "running",
                      rawCloudTargetEndMs > 0 else { return false }
                let rawEndSec = rawCloudTargetEndMs / 1000.0
                if rawEndSec <= buildCutoff.addingTimeInterval(-900).timeIntervalSince1970 {
                    return true
                }
                guard rawEndSec <= buildCutoff.timeIntervalSince1970 else { return false }
                return isCloudCreatorMe && !hasOtherCloudAssistant && !hasOtherCloudChecker
            }()
            let cloudStatus = isExpiredBeforeBuildUpdate ? "idle" : rawCloudStatus
            let cloudTargetEndMs = isExpiredBeforeBuildUpdate ? 0 : rawCloudTargetEndMs
            let cloudTargetEndSec = cloudTargetEndMs > 0 ? cloudTargetEndMs / 1000.0 : 0
            let rawCloudCheckEndMs = (row["check_target_end_timestamp"] as? NSNumber)?.doubleValue ?? (row["check_target_end_timestamp"] as? Double) ?? 0
            let isCheckExpiredBeforeBuildUpdate: Bool = {
                guard let buildCutoff = activeBuildCutoff, rawCloudCheckEndMs > 0 else { return false }
                let rawChkSec = rawCloudCheckEndMs / 1000.0
                if rawChkSec <= buildCutoff.addingTimeInterval(-900).timeIntervalSince1970 {
                    return true
                }
                guard rawChkSec <= buildCutoff.timeIntervalSince1970 else { return false }
                return !hasOtherCloudChecker
            }()
            let cloudCheckEndMs = (isExpiredBeforeBuildUpdate || isCheckExpiredBeforeBuildUpdate) ? 0 : rawCloudCheckEndMs
            let cloudCheckTotalSec = (isExpiredBeforeBuildUpdate || isCheckExpiredBeforeBuildUpdate)
                ? 0
                : ((row["check_total_seconds"] as? NSNumber)?.intValue ?? (row["check_total_seconds"] as? Int) ?? 0)
            let cloudIsShampooing = isExpiredBeforeBuildUpdate ? false : ((row["is_shampooing"] as? NSNumber)?.boolValue ?? (row["is_shampooing"] as? Bool) ?? false)
            let cloudHelpProc = isExpiredBeforeBuildUpdate ? "" : ((row["help_process"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let cloudAssist = isExpiredBeforeBuildUpdate ? "" : rawCloudAssist
            let isSameRunningTimer = cur.isRunning && cloudStatus == "running" && abs(cloudTargetEndSec - cur.targetEndTime.timeIntervalSince1970) <= 2.5
            let resolvedIsCreatorMe: Bool? = {
                if hasValidMyUid && hasValidCloudCreatorUid && cloudCreatedBy.caseInsensitiveCompare(myUid) == .orderedSame {
                    return true
                }
                if !cloudColorStaff.isEmpty && cloudColorStaff != "スタイリスト" && SeatTimerItem.isStaffMe(cloudColorStaff, currentUserName: self.currentUserName) && (!hasValidMyUid || !hasValidCloudCreatorUid) {
                    return true
                }
                if isSameRunningTimer && cur.isCreatorMeExplicit == true {
                    return true
                }
                if hasValidMyUid && hasValidCloudCreatorUid {
                    return false
                }
                if !cloudColorStaff.isEmpty && cloudColorStaff != "スタイリスト" {
                    return SeatTimerItem.isStaffMe(cloudColorStaff, currentUserName: self.currentUserName)
                }
                return cur.isCreatorMeExplicit
            }()

            if let modAt = self.localSeatMods[rowId] ?? self.localSeatMods[cur.id] ?? self.localSeatMods[prevKey] {
                let isNewerCloudTimestamp = (cloudUpdatedAt != nil) && (cloudUpdatedAt! > modAt.addingTimeInterval(1.5))
                let isDifferentPeerUpdater: Bool = {
                    if hasValidMyUid && Self.isValidCloudUUID(cloudUpdatedBy) {
                        return cloudUpdatedBy.caseInsensitiveCompare(myUid) != .orderedSame
                    }
                    return false
                }()
                let isAuthoritativeNewerPeerChange = isNewerCloudTimestamp && isDifferentPeerUpdater
                let isFallbackStopTransitionWithoutUid = isNewerCloudTimestamp
                    && cloudUpdatedBy.isEmpty
                    && (cur.isRunning != (cloudStatus == "running" && cloudTargetEndMs > 0))
                    && now.timeIntervalSince(modAt) >= 6.0
                if !isAuthoritativeNewerPeerChange && !isFallbackStopTransitionWithoutUid && now.timeIntervalSince(modAt) < self.localSeatModHoldSeconds {
                    continue
                }
            }

            // ① 稼働中だったタイマーがクラウド上で途中停止・リセット・シャンプー移行された場合:
            //    - 自分（または自分のペア端末）が止めた場合、または自分が関係者でない席 → 即座に00:00停止＆アラーム予約消火
            //    - 他スタッフが停止・シャンプー移行した場合で、自分がその席の関係者（shouldAlertMainTimer）である場合 →
            //      即座に「タップ確認制通知」を表示しつつ、自分のWatch上のタイマー・アラーム・超過カウントアップは止めずに継続させる（Issue #9）
            if cur.isRunning && (cloudStatus != "running" || cloudTargetEndMs <= 0) {
                if let startedAt = self.watchStartedSeatTimes[rowId] ?? self.watchStartedSeatTimes[cur.id] ?? self.watchStartedSeatTimes[prevKey] {
                    let isCloudRowOlderThanLocalStart = (cloudUpdatedAt == nil) || (cloudUpdatedAt! <= startedAt.addingTimeInterval(0.5))
                    let startHoldSec: TimeInterval = isCloudRowOlderThanLocalStart ? 15.0 : 5.0
                    if now.timeIntervalSince(startedAt) < startHoldSec {
                        // 自Watchから開始した直後（クラウド反映完了前やiPhone中継待ちの間）に古い paused 行で巻き戻されるのを保護
                        continue
                    }
                }
                let wasStoppedLocallyBeforePoll = (self.localStops[rowId] != nil || self.localStops[cur.id] != nil || self.localStops[prevKey] != nil)
                let stoppedEnd = cur.targetEndTime
                let stoppedEndEpoch = stoppedEnd.timeIntervalSince1970
                let prevCheckEnd = cur.checkTargetEndTime
                let actorName = self.resolveCloudActorName(
                    cloudAssist: cloudAssist,
                    cloudUpdatedBy: cloudUpdatedBy,
                    cloudCreatedBy: cloudCreatedBy,
                    cloudColorStaff: cloudColorStaff
                )
                let hasActiveCloudCustomHelpProc = !cloudHelpProc.isEmpty && cloudHelpProc != "シャンプー" && cloudHelpProc != "ヘルプなし" && cloudHelpProc.lowercased() != "none" && cloudHelpProc != "募集中" && cloudHelpProc != "未定"
                let hasActiveCloudPostStopProcess = cloudIsShampooing || hasActiveCloudCustomHelpProc
                let hasOtherConcreteCloudAssist = !cloudAssist.isEmpty
                    && cloudAssist != "ヘルプなし"
                    && cloudAssist.lowercased() != "none"
                    && cloudAssist != "募集中"
                    && cloudAssist != "未定"
                    && cloudAssist != "スタイリスト"
                    && cloudAssist != "スタッフ"
                    && !SeatTimerItem.isStaffMe(cloudAssist, currentUserName: self.currentUserName)
                let isStaleIdleCloudSeat = (cloudStatus == "idle" && cloudTargetEndMs <= 0 && !cloudIsShampooing && !hasActiveCloudCustomHelpProc)
                    && (cloudUpdatedAt == nil || now.timeIntervalSince(cloudUpdatedAt!) > 30.0 || now.timeIntervalSince(cur.targetEndTime) > 300.0)
                // ★ 3層・Widget共通厳密判定:
                //   - updated_by と自機 cloudUserId が両方有効な場合は UUID 不一致時のみ「他スタッフによる停止」と判定
                //   - updated_by が空/NULL または自機 cloudUserId 未同期時は、無条件で他者停止扱いせず、
                //     「停止後工程（シャンプー・コーミング・チェック等）が稼働中 かつ 自分以外の具体的な担当者名が入っている」明示的証拠がある時のみ他者停止継続とし、
                //     それ以外は即座に 00:00 停止へ収束させる（自端末停止後の3時間 +00:15 ゾンビ復活・誤バナーを完全防止）
                let isStoppedByOtherPeerOnCloud: Bool = {
                    if wasStoppedLocallyBeforePoll || isStaleIdleCloudSeat { return false }
                    if hasValidMyUid && Self.isValidCloudUUID(cloudUpdatedBy) {
                        return cloudUpdatedBy.caseInsensitiveCompare(myUid) != .orderedSame
                    }
                    return hasActiveCloudPostStopProcess && hasOtherConcreteCloudAssist
                }()

                if isStoppedByOtherPeerOnCloud && cur.shouldAlertMainTimer(for: self.currentUserName) {
                    let alreadyHandledPeerStop = self.isPeerStoppedSeat(seatId: rowId, seatNumber: cur.seatNumber, endTimeEpoch: stoppedEndEpoch)
                        || self.isPeerStoppedSeat(seatId: cur.id, seatNumber: cur.seatNumber, endTimeEpoch: stoppedEndEpoch)
                    self.markPeerStoppedSeat(seatId: rowId, seatNumber: cur.seatNumber, endTimeEpoch: stoppedEndEpoch)
                    if cur.id != rowId {
                        self.markPeerStoppedSeat(seatId: cur.id, seatNumber: cur.seatNumber, endTimeEpoch: stoppedEndEpoch)
                    }
                    let prevPeerStatus = updatedTimers[i].status
                    let nextStatus: TreatmentStatus = {
                        if cloudIsShampooing { return .shampoo }
                        if cloudHelpProc == "コーミング" { return .combing }
                        if cloudHelpProc == "チェック" { return .check }
                        if hasActiveCloudCustomHelpProc { return .shampoo }
                        return .normal
                    }()
                    let nextHelpProc: String = {
                        if cloudIsShampooing { return "シャンプー" }
                        if cloudHelpProc == "コーミング" { return "コーミング" }
                        if cloudHelpProc == "チェック" { return "チェック" }
                        if hasActiveCloudCustomHelpProc { return cloudHelpProc }
                        return updatedTimers[i].helpProcess
                    }()
                    let nextShampooStaff: String? = {
                        if !cloudAssist.isEmpty && cloudAssist != "ヘルプなし" && cloudAssist != "none" && cloudAssist != "募集中" && cloudAssist != "未定" {
                            return cloudAssist
                        }
                        return updatedTimers[i].shampooStaff
                    }()
                    if updatedTimers[i].id != rowId {
                        updatedTimers[i].id = rowId
                        didChange = true
                    }
                    if !cloudLabel.isEmpty && updatedTimers[i].seatLabel != cloudLabel {
                        updatedTimers[i].seatLabel = cloudLabel
                        didChange = true
                    }
                    if updatedTimers[i].status != nextStatus || updatedTimers[i].helpProcess != nextHelpProc || updatedTimers[i].shampooStaff != nextShampooStaff {
                        updatedTimers[i].status = nextStatus
                        updatedTimers[i].helpProcess = nextHelpProc
                        updatedTimers[i].shampooStaff = nextShampooStaff
                        didChange = true
                    }
                    self.purgeStalePeerSemanticKeysForSeatTransition(prev: cur, next: updatedTimers[i])
                    let didTransitionToActiveProcess = alreadyHandledPeerStop && prevPeerStatus != nextStatus && nextStatus != .normal
                    if !alreadyHandledPeerStop || didTransitionToActiveProcess {
                        let timeStr = Self.peerAlertTimeFormatter.string(from: now)
                        let seatDisplay = !cloudLabel.isEmpty ? cloudLabel : cur.displaySeatName
                        let msg: String
                        let colorHex: String
                        if cloudIsShampooing {
                            msg = actorName.isEmpty
                                ? "【\(timeStr)】💧 \(seatDisplay)がシャンプーに入りました"
                                : "【\(timeStr)】💧 \(seatDisplay)のシャンプーに \(actorName) さんが入りました"
                            colorHex = "#AF52DE"
                        } else if !cloudHelpProc.isEmpty && cloudHelpProc != "シャンプー" && cloudHelpProc != "ヘルプなし" && cloudHelpProc != "none" && cloudHelpProc != "募集中" {
                            let emoji = (cloudHelpProc == "コーミング") ? "🪮" : ((cloudHelpProc == "チェック") ? "🔍" : "💬")
                            colorHex = (cloudHelpProc == "コーミング") ? "#0A84FF" : ((cloudHelpProc == "チェック") ? "#30D158" : "#5E5CE6")
                            msg = actorName.isEmpty
                                ? "【\(timeStr)】\(emoji) \(seatDisplay)が\(cloudHelpProc)に入りました"
                                : "【\(timeStr)】\(emoji) \(seatDisplay)の\(cloudHelpProc)に \(actorName) さんが入りました"
                        } else {
                            msg = actorName.isEmpty
                                ? "【\(timeStr)】⏹ \(seatDisplay)のタイマーが停止されました"
                                : "【\(timeStr)】⏹ \(seatDisplay)のタイマーを \(actorName) さんが止めました"
                            colorHex = "#FF9500"
                        }
                        let stopUpdatedMs = safeEpochMillisInt64((cloudUpdatedAt ?? now).timeIntervalSince1970 * 1000.0)
                        let alertId = didTransitionToActiveProcess
                            ? "cloud_stop_proc_\(rowId)_\(safeEpochSecondsInt64(stoppedEndEpoch))_\(nextStatus.rawValue)_\(stopUpdatedMs)"
                            : "cloud_stop_\(rowId)_\(safeEpochSecondsInt64(stoppedEndEpoch))_\(stopUpdatedMs)"
                        let stopEvType = (nextStatus != .normal) ? nextStatus.rawValue : "stop"
                        let stopSemEv = didTransitionToActiveProcess ? "status_change" : "stop"
                        let stopProcLabel: String = {
                            switch nextStatus {
                            case .shampoo:
                                return (!cloudHelpProc.isEmpty && cloudHelpProc != "ヘルプなし" && cloudHelpProc != "none") ? cloudHelpProc : "シャンプー"
                            case .combing:
                                return "コーミング"
                            case .check:
                                return "チェック"
                            case .normal:
                                return ""
                            }
                        }()
                        let stopSemDisc = didTransitionToActiveProcess
                            ? Self.buildPeerEventStateDisc(eventType: "status_change", nextAssist: cloudAssist, procLabel: stopProcLabel)
                            : Self.buildPeerEventStateDisc(eventType: "stop")
                        let stopSemKey = Self.buildPeerEventSemanticKey(
                            timerIdOrLabel: rowId,
                            eventType: stopSemEv,
                            actorId: cloudUpdatedBy,
                            stateDisc: stopSemDisc
                        )
                        let nowSec = now.timeIntervalSince1970
                        if stopSemKey.isEmpty || !self.hasHandledPeerSemanticKey(stopSemKey, channel: "any", nowSec: nowSec) {
                            if !stopSemKey.isEmpty {
                                self.recordHandledPeerSemanticKey(
                                    stopSemKey,
                                    channel: "direct_poll",
                                    seatId: rowId,
                                    seatNumber: cur.seatNumber,
                                    seatLabel: seatDisplay,
                                    eventType: stopSemEv,
                                    nowSec: nowSec
                                )
                            }
                            let didAdd = self.enqueuePeerConfirmationAlert(
                                id: alertId,
                                text: msg,
                                colorHex: colorHex,
                                timeText: timeStr,
                                eventType: stopEvType,
                                seatId: rowId,
                                seatNumber: cur.seatNumber,
                                seatLabel: seatDisplay,
                                semanticKey: stopSemKey
                            )
                            if didAdd {
                                self.incomingNotification = (text: msg, color: colorHex, eventType: stopEvType)
                                WatchAlarmCoordinator.shared.postPeerActionNotification(
                                    text: msg,
                                    forceSystemBanner: self.isModalSheetCurrentlyPresented,
                                    eventType: stopEvType
                                )
                                didChange = true
                            }
                        }
                    }
                    continue
                }

                self.clearPeerStoppedSeat(seatId: rowId, seatNumber: cur.seatNumber, recordRecentClear: true, confirmedEndEpoch: stoppedEndEpoch)
                if cur.id != rowId {
                    self.clearPeerStoppedSeat(seatId: cur.id, seatNumber: cur.seatNumber, recordRecentClear: true, confirmedEndEpoch: stoppedEndEpoch)
                }
                self.markLocalStop(seatId: rowId, endTime: stoppedEnd)
                self.setCollapseOverride(seatId: rowId, collapsed: true)
                if cur.id != rowId {
                    self.markLocalStop(seatId: cur.id, endTime: stoppedEnd)
                    self.setCollapseOverride(seatId: cur.id, collapsed: true)
                }
                self.markLocalStop(seatId: prevKey, endTime: stoppedEnd)
                if let prevCheckEnd = prevCheckEnd {
                    self.markLocalCheckClear(seatId: rowId, checkEndTime: prevCheckEnd)
                    if cur.id != rowId {
                        self.markLocalCheckClear(seatId: cur.id, checkEndTime: prevCheckEnd)
                    }
                }
                updatedTimers[i].id = rowId
                if !cloudLabel.isEmpty {
                    updatedTimers[i].seatLabel = cloudLabel
                }
                // 自分が止めた場合（または自分が無関係な席の場合）は 00:00 リセット＆カード収納
                updatedTimers[i].isRunning = false
                updatedTimers[i].pausedRemainingSeconds = 0
                updatedTimers[i].totalSeconds = 0
                updatedTimers[i].clearCheck()
                updatedTimers[i].status = .normal
                updatedTimers[i].helpProcess = ""
                updatedTimers[i].shampooStaff = nil
                updatedTimers[i].isRecruiting = false
                updatedTimers[i].isNoHelpNeeded = false
                updatedTimers[i].createdBy = nil
                updatedTimers[i].isCreatorMeExplicit = nil
                updatedTimers[i].isCollapsed = true
                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                    seatId: rowId,
                    seatNumber: cur.seatNumber,
                    checkOnly: false,
                    skipRefresh: true
                )
                if cur.id != rowId {
                    WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                        seatId: cur.id,
                        seatNumber: cur.seatNumber,
                        checkOnly: false,
                        skipRefresh: true
                    )
                }
                didChange = true
                continue
            }

            // ② 稼働中のまま途中チェックタイマーのみ共有相手により完了・解除された場合
            if cur.isRunning && !cur.isCheckCompleted && cur.checkTargetEndTime != nil && cloudStatus == "running" && cloudCheckEndMs <= 0 {
                let wasCheckClearedLocally = (self.localCheckClears[rowId] != nil || self.localCheckClears[cur.id] != nil)
                self.markLocalCheckClear(seatId: rowId, checkEndTime: cur.checkTargetEndTime)
                let chkStaffRaw = ((row["check_staff_name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if cloudCheckTotalSec > 0 {
                    updatedTimers[i].isCheckCompleted = true
                    updatedTimers[i].checkTargetEndTime = nil
                    updatedTimers[i].checkTotalSeconds = nil
                    if !chkStaffRaw.isEmpty {
                        updatedTimers[i].checkStaff = chkStaffRaw
                    }
                } else {
                    updatedTimers[i].clearCheck()
                }
                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                    seatId: rowId,
                    seatNumber: cur.seatNumber,
                    checkOnly: true,
                    skipRefresh: true
                )
                self.purgeStalePeerSemanticKeysForSeatTransition(prev: cur, next: updatedTimers[i])
                if !wasCheckClearedLocally && cloudCheckTotalSec > 0 {
                    let checkActor = (!chkStaffRaw.isEmpty && chkStaffRaw != "未定" && chkStaffRaw != "募集中")
                        ? chkStaffRaw
                        : self.resolveCloudActorName(
                            cloudAssist: "",
                            cloudUpdatedBy: cloudUpdatedBy,
                            cloudCreatedBy: cloudCreatedBy,
                            cloudColorStaff: cloudColorStaff
                        )
                    let isSelfCheck = (hasValidMyUid && !cloudUpdatedBy.isEmpty && cloudUpdatedBy.caseInsensitiveCompare(myUid) == .orderedSame)
                        || (!checkActor.isEmpty && SeatTimerItem.isStaffMe(checkActor, currentUserName: self.currentUserName))
                    if !isSelfCheck && cur.shouldAlertCheckTimer(for: self.currentUserName) {
                        let timeStr = Self.peerAlertTimeFormatter.string(from: now)
                        let seatDisplay = !cloudLabel.isEmpty ? cloudLabel : cur.displaySeatName
                        let chkProc = cur.displayCheckProcess
                        let msg = checkActor.isEmpty
                            ? "【\(timeStr)】✓ \(seatDisplay)の\(chkProc)完了"
                            : "【\(timeStr)】✓ \(seatDisplay)の\(chkProc)に \(checkActor) さんが入りました（完了）"
                        let chkDoneSemKey = Self.buildPeerEventSemanticKey(
                            timerIdOrLabel: rowId,
                            eventType: "check_done",
                            actorId: cloudUpdatedBy,
                            stateDisc: Self.buildPeerEventStateDisc(eventType: "check_done")
                        )
                        let nowSec = now.timeIntervalSince1970
                        if chkDoneSemKey.isEmpty || !self.hasHandledPeerSemanticKey(chkDoneSemKey, channel: "any", nowSec: nowSec) {
                            if !chkDoneSemKey.isEmpty {
                                self.recordHandledPeerSemanticKey(
                                    chkDoneSemKey,
                                    channel: "direct_poll",
                                    seatId: rowId,
                                    seatNumber: cur.seatNumber,
                                    seatLabel: seatDisplay,
                                    eventType: "check_done",
                                    nowSec: nowSec
                                )
                            }
                            let chkDoneUpdatedMs = safeEpochMillisInt64((cloudUpdatedAt ?? now).timeIntervalSince1970 * 1000.0)
                            let didAdd = self.enqueuePeerConfirmationAlert(
                                id: "cloud_chk_\(rowId)_\(chkDoneUpdatedMs)",
                                text: msg,
                                colorHex: "#30D158",
                                timeText: timeStr,
                                eventType: "check_done",
                                seatId: rowId,
                                seatNumber: cur.seatNumber,
                                seatLabel: seatDisplay,
                                semanticKey: chkDoneSemKey
                            )
                            if didAdd {
                                self.incomingNotification = (text: msg, color: "#30D158", eventType: "check_done")
                                WatchAlarmCoordinator.shared.postPeerActionNotification(
                                    text: msg,
                                    forceSystemBanner: self.isModalSheetCurrentlyPresented,
                                    eventType: "check_done"
                                )
                            }
                        }
                    }
                }
                didChange = true
            }

            // ③ 停止中だった席が共有相手により新しく開始された、または稼働中の席が別の新しいタイマー・残り時間・ヘルプ指定・募集に変更された場合
            if cloudStatus == "running" && cloudTargetEndMs > (nowMs - 3 * 3600 * 1000) {
                let wasRunningBefore = cur.isRunning
                let isNewOrResetTimer = !wasRunningBefore || abs(cloudTargetEndSec - cur.targetEndTime.timeIntervalSince1970) > 2.5
                let cloudCheckDone = cloudCheckTotalSec > 0 && cloudCheckEndMs <= 0
                if !wasRunningBefore {
                    if let stop = self.localStops[rowId] ?? self.localStops[cur.id] ?? self.localStops[prevKey],
                       now.timeIntervalSince(stop.at) < self.localStopHoldSeconds,
                       abs(cloudTargetEndSec - stop.end) <= 2.5 {
                        continue
                    }
                    self.clearLocalStop(seatId: rowId)
                    self.clearLocalStop(seatId: cur.id)
                    self.clearLocalStop(seatId: prevKey)
                    let sec = max(10, cloudTargetSec > 0 ? cloudTargetSec : 600)
                    updatedTimers[i].id = rowId
                    if !cloudLabel.isEmpty {
                        updatedTimers[i].seatLabel = cloudLabel
                    }
                    updatedTimers[i].isRunning = true
                    updatedTimers[i].totalSeconds = sec
                    updatedTimers[i].pausedRemainingSeconds = sec
                    updatedTimers[i].targetEndTime = Date(timeIntervalSince1970: cloudTargetEndSec)
                    updatedTimers[i].status = .normal
                    let isNoHelp = (cloudAssist == "ヘルプなし" || cloudAssist == "none" || cloudHelpProc == "ヘルプなし")
                    let isRecruit = (cloudAssist == "募集中")
                    updatedTimers[i].isNoHelpNeeded = isNoHelp
                    updatedTimers[i].isRecruiting = isRecruit
                    updatedTimers[i].helpProcess = isNoHelp ? "" : cloudHelpProc
                    updatedTimers[i].shampooStaff = (cloudAssist.isEmpty || isRecruit || isNoHelp) ? nil : cloudAssist
                    if !cloudColorStaff.isEmpty {
                        updatedTimers[i].creatorName = cloudColorStaff
                    }
                    if !cloudCreatedBy.isEmpty {
                        updatedTimers[i].createdBy = cloudCreatedBy
                    }
                    updatedTimers[i].isCreatorMeExplicit = resolvedIsCreatorMe
                    updatedTimers[i].isCollapsed = false
                    self.collapseOverrides[rowId] = nil
                    self.collapseOverrides[cur.id] = nil
                    self.collapseOverrides[prevKey] = nil
                    if cloudCheckTotalSec > 0 && cloudCheckEndMs > 0 {
                        updatedTimers[i].checkTotalSeconds = cloudCheckTotalSec
                        updatedTimers[i].checkTargetEndTime = Date(timeIntervalSince1970: cloudCheckEndMs / 1000.0)
                        updatedTimers[i].checkProcess = SeatTimerItem.sanitizeCheckProcess(row["check_process"] as? String)
                        let cChkStaff = ((row["check_staff_name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        updatedTimers[i].checkStaff = cChkStaff.isEmpty ? nil : cChkStaff
                        updatedTimers[i].isCheckCompleted = false
                    } else {
                        updatedTimers[i].clearCheck()
                    }
                    didChange = true
                } else {
                    // 稼働中の席で別Watchから新規タイマーが再設定された、または時間延長・ヘルプ指定・チェック追加が行われた場合
                    if !cloudLabel.isEmpty && updatedTimers[i].seatLabel != cloudLabel {
                        updatedTimers[i].seatLabel = cloudLabel
                        didChange = true
                    }
                    if abs(cloudTargetEndSec - cur.targetEndTime.timeIntervalSince1970) > 2.5 {
                        self.clearPeerStoppedSeat(seatId: rowId, seatNumber: cur.seatNumber, recordRecentClear: false)
                        self.clearPeerStoppedSeat(seatId: cur.id, seatNumber: cur.seatNumber, recordRecentClear: false)
                        WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                            seatId: rowId,
                            seatNumber: cur.seatNumber,
                            checkOnly: false,
                            mainOnly: true,
                            skipRefresh: true
                        )
                        if cur.id != rowId {
                            WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                                seatId: cur.id,
                                seatNumber: cur.seatNumber,
                                checkOnly: false,
                                mainOnly: true,
                                skipRefresh: true
                            )
                        }
                        updatedTimers[i].id = rowId
                        updatedTimers[i].targetEndTime = Date(timeIntervalSince1970: cloudTargetEndSec)
                        if cloudTargetSec > 0 {
                            updatedTimers[i].totalSeconds = cloudTargetSec
                            updatedTimers[i].pausedRemainingSeconds = cloudTargetSec
                        }
                        if updatedTimers[i].remainingSeconds > 180 {
                            updatedTimers[i].hasAlertedHelpUnassigned = false
                        }
                        if !cloudColorStaff.isEmpty {
                            updatedTimers[i].creatorName = cloudColorStaff
                        }
                        if !cloudCreatedBy.isEmpty {
                            updatedTimers[i].createdBy = cloudCreatedBy
                        }
                        updatedTimers[i].isCreatorMeExplicit = resolvedIsCreatorMe
                        updatedTimers[i].isCollapsed = false
                        didChange = true
                    } else {
                        if !cloudColorStaff.isEmpty && updatedTimers[i].creatorName != cloudColorStaff {
                            updatedTimers[i].creatorName = cloudColorStaff
                            didChange = true
                        }
                        if !cloudCreatedBy.isEmpty && updatedTimers[i].createdBy != cloudCreatedBy {
                            updatedTimers[i].createdBy = cloudCreatedBy
                            didChange = true
                        }
                        if updatedTimers[i].isCreatorMeExplicit != resolvedIsCreatorMe {
                            updatedTimers[i].isCreatorMeExplicit = resolvedIsCreatorMe
                            didChange = true
                        }
                    }
                    let isNoHelp = (cloudAssist == "ヘルプなし" || cloudAssist == "none" || cloudHelpProc == "ヘルプなし")
                    let isRecruit = (cloudAssist == "募集中")
                    let nextHelpProc = isNoHelp ? "" : cloudHelpProc
                    let nextStaff: String? = (cloudAssist.isEmpty || isRecruit || isNoHelp) ? nil : cloudAssist
                    if updatedTimers[i].helpProcess != nextHelpProc ||
                       updatedTimers[i].shampooStaff != nextStaff ||
                       updatedTimers[i].isRecruiting != isRecruit ||
                       updatedTimers[i].isNoHelpNeeded != isNoHelp {
                        updatedTimers[i].helpProcess = nextHelpProc
                        updatedTimers[i].shampooStaff = nextStaff
                        updatedTimers[i].isRecruiting = isRecruit
                        updatedTimers[i].isNoHelpNeeded = isNoHelp
                        didChange = true
                    }
                    if cloudCheckTotalSec > 0 && cloudCheckEndMs > 0 {
                        let nextChkEnd = Date(timeIntervalSince1970: cloudCheckEndMs / 1000.0)
                        let nextChkProc = SeatTimerItem.sanitizeCheckProcess(row["check_process"] as? String)
                        let cChkStaff = ((row["check_staff_name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        let nextChkStaff: String? = cChkStaff.isEmpty ? nil : cChkStaff
                        let chkEndDiff = abs((updatedTimers[i].checkTargetEndTime?.timeIntervalSince1970 ?? 0) - nextChkEnd.timeIntervalSince1970)
                        if updatedTimers[i].isCheckCompleted || chkEndDiff > 2.5 || updatedTimers[i].checkProcess != nextChkProc || updatedTimers[i].checkStaff != nextChkStaff {
                            if chkEndDiff > 2.5 {
                                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                                    seatId: rowId,
                                    seatNumber: cur.seatNumber,
                                    checkOnly: true,
                                    skipRefresh: true
                                )
                                if cur.id != rowId {
                                    WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                                        seatId: cur.id,
                                        seatNumber: cur.seatNumber,
                                        checkOnly: true,
                                        skipRefresh: true
                                    )
                                }
                            }
                            updatedTimers[i].checkTotalSeconds = cloudCheckTotalSec
                            updatedTimers[i].checkTargetEndTime = nextChkEnd
                            updatedTimers[i].checkProcess = nextChkProc
                            updatedTimers[i].checkStaff = nextChkStaff
                            updatedTimers[i].isCheckCompleted = false
                            didChange = true
                        }
                    } else if !cloudCheckDone && updatedTimers[i].checkTargetEndTime != nil && !updatedTimers[i].isCheckCompleted {
                        WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                            seatId: rowId,
                            seatNumber: cur.seatNumber,
                            checkOnly: true,
                            skipRefresh: true
                        )
                        if cur.id != rowId {
                            WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                                seatId: cur.id,
                                seatNumber: cur.seatNumber,
                                checkOnly: true,
                                skipRefresh: true
                            )
                        }
                        updatedTimers[i].clearCheck()
                        didChange = true
                    }
                }

                // ★ サブ機iPhoneロック中やPush通知遅延時でも、Watch直接クラウドポーリングで新規開始・ヘルプ募集・担当指名・担当解除を即座に反映＆消火＆通知
                let nextItem = updatedTimers[i]

                // ★ A-1: 稼働中の席で自分がヘルプ担当・チェック担当から外された瞬間（別スタッフへ変更・ヘルプなし・募集切替・解除）は0msでアラーム予約・鳴動を即時完全消火
                if wasRunningBefore
                    && cur.shouldAlertMainTimer(for: self.currentUserName)
                    && !nextItem.shouldAlertMainTimer(for: self.currentUserName) {
                    self.clearPeerStoppedSeat(seatId: rowId, seatNumber: cur.seatNumber, recordRecentClear: false)
                    self.clearPeerStoppedSeat(seatId: cur.id, seatNumber: cur.seatNumber, recordRecentClear: false)
                    WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                        seatId: rowId,
                        seatNumber: cur.seatNumber,
                        checkOnly: false,
                        mainOnly: true,
                        skipRefresh: true
                    )
                    if cur.id != rowId {
                        WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                            seatId: cur.id,
                            seatNumber: cur.seatNumber,
                            checkOnly: false,
                            mainOnly: true,
                            skipRefresh: true
                        )
                    }
                }
                if wasRunningBefore
                    && cur.shouldAlertCheckTimer(for: self.currentUserName)
                    && !nextItem.shouldAlertCheckTimer(for: self.currentUserName) {
                    WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                        seatId: rowId,
                        seatNumber: cur.seatNumber,
                        checkOnly: true,
                        skipRefresh: true
                    )
                    if cur.id != rowId {
                        WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                            seatId: cur.id,
                            seatNumber: cur.seatNumber,
                            checkOnly: true,
                            skipRefresh: true
                        )
                    }
                }

                let endEpochKey = safeEpochSecondsInt64(cloudTargetEndSec)
                let chkEndEpochKey = safeEpochSecondsInt64(cloudCheckEndMs / 1000.0)
                let prevChkEndEpochKey = safeEpochSecondsInt64(cur.checkTargetEndTime?.timeIntervalSince1970 ?? 0)

                let nextAssistStaff = (nextItem.shampooStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let prevAssistStaff = (cur.shampooStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let isAssistAssignedToMeNow = !nextAssistStaff.isEmpty && SeatTimerItem.isStaffMe(nextAssistStaff, currentUserName: self.currentUserName)
                let wasAssistAssignedToMeBefore = wasRunningBefore && !isNewOrResetTimer && !prevAssistStaff.isEmpty && SeatTimerItem.isStaffMe(prevAssistStaff, currentUserName: self.currentUserName) && cur.helpProcess == nextItem.helpProcess
                let wasAssistMeOnSameTimer = wasRunningBefore && !isNewOrResetTimer && !prevAssistStaff.isEmpty && !cur.isNoHelpNeeded && !cur.isRecruiting && SeatTimerItem.isStaffMe(prevAssistStaff, currentUserName: self.currentUserName)

                let nextChkStaff = (nextItem.checkStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let prevChkStaff = (cur.checkStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let hasActiveNextCheck = !nextItem.isCheckCompleted && nextItem.checkTargetEndTime != nil
                let hadActiveCheckBeforeOnSameTimer = wasRunningBefore && !isNewOrResetTimer && !cur.isCheckCompleted && cur.checkTargetEndTime != nil
                let hadSameCheckBefore = hadActiveCheckBeforeOnSameTimer && abs((cur.checkTargetEndTime?.timeIntervalSince1970 ?? 0) - (nextItem.checkTargetEndTime?.timeIntervalSince1970 ?? 0)) <= 2.5
                let isCheckAssignedToMeNow = hasActiveNextCheck && !nextChkStaff.isEmpty && nextChkStaff != "募集中" && SeatTimerItem.isStaffMe(nextChkStaff, currentUserName: self.currentUserName)
                let wasCheckAssignedToMeBefore = hadSameCheckBefore && !prevChkStaff.isEmpty && SeatTimerItem.isStaffMe(prevChkStaff, currentUserName: self.currentUserName) && cur.displayCheckProcess == nextItem.displayCheckProcess
                let wasCheckMeOnSameCheck = hadActiveCheckBeforeOnSameTimer && !prevChkStaff.isEmpty && prevChkStaff != "募集中" && SeatTimerItem.isStaffMe(prevChkStaff, currentUserName: self.currentUserName) && !cloudCheckDone

                let isHelpRecruitingNow = nextItem.isRecruiting
                let wasHelpRecruitingBefore = wasRunningBefore && !isNewOrResetTimer && cur.isRecruiting && cur.helpProcess == nextItem.helpProcess

                let isCheckRecruitingNow = hasActiveNextCheck && nextChkStaff == "募集中"
                let wasCheckRecruitingBefore = hadSameCheckBefore && prevChkStaff == "募集中" && cur.displayCheckProcess == nextItem.displayCheckProcess

                // 同一タイマー稼働中に一度募集・指名・解除された後、再度募集・再指名・再解除された場合に再通知できるよう反対状態遷移時にキーを解放（A-3）
                let procForKey = nextItem.helpProcess.isEmpty ? "シャンプー" : nextItem.helpProcess
                let prevProcForKey = cur.helpProcess.isEmpty ? "シャンプー" : cur.helpProcess
                let chkProcForKey = nextItem.displayCheckProcess
                let prevChkProcForKey = cur.displayCheckProcess
                if !isCheckAssignedToMeNow {
                    self.releaseDirectCloudEventKey("cloud_assign_check_\(rowId)_\(chkEndEpochKey)_\(chkProcForKey)")
                    if prevChkEndEpochKey > 0 {
                        self.releaseDirectCloudEventKey("cloud_assign_check_\(rowId)_\(prevChkEndEpochKey)_\(prevChkProcForKey)")
                    }
                } else {
                    self.releaseDirectCloudEventKey("cloud_unassign_check_\(rowId)_\(chkEndEpochKey)_\(chkProcForKey)")
                    if prevChkEndEpochKey > 0 {
                        self.releaseDirectCloudEventKey("cloud_unassign_check_\(rowId)_\(prevChkEndEpochKey)_\(prevChkProcForKey)")
                    }
                }
                if !isAssistAssignedToMeNow {
                    self.releaseDirectCloudEventKey("cloud_assign_assist_\(rowId)_\(endEpochKey)_\(procForKey)")
                    if prevProcForKey != procForKey {
                        self.releaseDirectCloudEventKey("cloud_assign_assist_\(rowId)_\(endEpochKey)_\(prevProcForKey)")
                    }
                } else {
                    self.releaseDirectCloudEventKey("cloud_unassign_assist_\(rowId)_\(endEpochKey)_\(procForKey)")
                    if prevProcForKey != procForKey {
                        self.releaseDirectCloudEventKey("cloud_unassign_assist_\(rowId)_\(endEpochKey)_\(prevProcForKey)")
                    }
                }
                if !isHelpRecruitingNow {
                    self.releaseDirectCloudEventKey("cloud_recruit_help_\(rowId)_\(endEpochKey)_\(procForKey)")
                    if prevProcForKey != procForKey {
                        self.releaseDirectCloudEventKey("cloud_recruit_help_\(rowId)_\(endEpochKey)_\(prevProcForKey)")
                    }
                }
                if !isCheckRecruitingNow {
                    self.releaseDirectCloudEventKey("cloud_recruit_check_\(rowId)_\(chkEndEpochKey)_\(chkProcForKey)")
                    if prevChkEndEpochKey > 0 {
                        self.releaseDirectCloudEventKey("cloud_recruit_check_\(rowId)_\(prevChkEndEpochKey)_\(prevChkProcForKey)")
                    }
                }

                let hasRecentLocalMod = self.isSeatProtectedByRecentLocalAction(seatId: rowId, seatNumber: cur.seatNumber, within: 12.0)
                    || self.isSeatProtectedByRecentLocalAction(seatId: cur.id, seatNumber: cur.seatNumber, within: 12.0)
                let actorFromUpdatedBy = self.resolveCloudActorName(
                    cloudAssist: "",
                    cloudUpdatedBy: cloudUpdatedBy,
                    cloudCreatedBy: cloudCreatedBy,
                    cloudColorStaff: cloudColorStaff
                )
                let isRecruitTransitionOnMySeat = resolvedIsCreatorMe == true && ((isHelpRecruitingNow && !cur.isRecruiting) || (isCheckRecruitingNow && prevChkStaff != "募集中"))
                let isSelfCloudMod: Bool = {
                    if hasRecentLocalMod { return true }
                    if hasValidMyUid && Self.isValidCloudUUID(cloudUpdatedBy) {
                        return cloudUpdatedBy.caseInsensitiveCompare(myUid) == .orderedSame
                    }
                    if !actorFromUpdatedBy.isEmpty && SeatTimerItem.isStaffMe(actorFromUpdatedBy, currentUserName: self.currentUserName) {
                        return true
                    }
                    if cloudUpdatedBy.isEmpty && resolvedIsCreatorMe == true && (isNewOrResetTimer || isRecruitTransitionOnMySeat) {
                        return true
                    }
                    return false
                }()
                let resolvedNotifyActor: String = {
                    if !actorFromUpdatedBy.isEmpty { return actorFromUpdatedBy }
                    if resolvedIsCreatorMe == false && !cloudColorStaff.isEmpty && cloudColorStaff != "スタイリスト" && !SeatTimerItem.isStaffMe(cloudColorStaff, currentUserName: self.currentUserName) {
                        return cloudColorStaff
                    }
                    return ""
                }()

                self.purgeStalePeerSemanticKeysForSeatTransition(prev: cur, next: nextItem)
                let isStaleBootstrapForNewSeat = newlyAppendedRowIds.contains(rowId) && (cloudUpdatedAt.map { now.timeIntervalSince($0) > 90.0 } ?? false)
                if !isSelfCloudMod && !isStaleBootstrapForNewSeat {
                    let timeStr = Self.peerAlertTimeFormatter.string(from: now)
                    let seatDisplay = !cloudLabel.isEmpty ? cloudLabel : nextItem.displaySeatName

                    var pollEventType = ""
                    var pollEventKey = ""
                    var pollAlertId = ""
                    var pollMsg = ""
                    var pollColor = "#0A84FF"

                    if isCheckAssignedToMeNow && !wasCheckAssignedToMeBefore {
                        let chkProc = nextItem.displayCheckProcess
                        let chkMins = max(1, (nextItem.checkTotalSeconds ?? 300) / 60)
                        pollEventType = "assign_check"
                        pollEventKey = "cloud_assign_check_\(rowId)_\(chkEndEpochKey)_\(chkProc)"
                        pollAlertId = pollEventKey
                        pollMsg = resolvedNotifyActor.isEmpty
                            ? "【\(timeStr)】🔍 \(seatDisplay)の【\(chkProc)（\(chkMins)分）】担当に指定されました"
                            : "【\(timeStr)】🔍 \(resolvedNotifyActor)さんがあなたを\(seatDisplay)の【\(chkProc)（\(chkMins)分）】担当に指定しました"
                        pollColor = "#30D158"
                    } else if isAssistAssignedToMeNow && !wasAssistAssignedToMeBefore {
                        let proc = nextItem.helpProcess.isEmpty ? "シャンプー" : nextItem.helpProcess
                        pollEventType = "assign_assist"
                        pollEventKey = "cloud_assign_assist_\(rowId)_\(endEpochKey)_\(proc)"
                        pollAlertId = pollEventKey
                        pollMsg = resolvedNotifyActor.isEmpty
                            ? "【\(timeStr)】🤝 \(seatDisplay)の【\(proc)】担当に指定されました"
                            : "【\(timeStr)】🤝 \(resolvedNotifyActor)さんがあなたを\(seatDisplay)の【\(proc)】担当に指定しました"
                        pollColor = "#0A84FF"
                    } else if wasAssistMeOnSameTimer && !isAssistAssignedToMeNow {
                        let proc = !cur.helpProcess.isEmpty ? cur.helpProcess : procForKey
                        let reasonSuffix: String = {
                            if !nextAssistStaff.isEmpty && !nextItem.isRecruiting && !nextItem.isNoHelpNeeded {
                                return "（\(nextAssistStaff)さんに変更）"
                            }
                            if nextItem.isNoHelpNeeded {
                                return "（ヘルプなしに変更）"
                            }
                            if nextItem.isRecruiting {
                                return "（全員募集に変更）"
                            }
                            return ""
                        }()
                        pollEventType = "unassign_assist"
                        pollEventKey = "cloud_unassign_assist_\(rowId)_\(endEpochKey)_\(proc)"
                        pollAlertId = pollEventKey
                        pollMsg = resolvedNotifyActor.isEmpty
                            ? "【\(timeStr)】ℹ️ \(seatDisplay)の【\(proc)】担当から外れました\(reasonSuffix)"
                            : "【\(timeStr)】ℹ️ \(resolvedNotifyActor)さんが\(seatDisplay)の【\(proc)】担当を変更しました\(reasonSuffix)"
                        pollColor = "#8E8E93"
                    } else if wasCheckMeOnSameCheck && !isCheckAssignedToMeNow {
                        let chkProc = prevChkProcForKey
                        let reasonSuffix: String = {
                            if hasActiveNextCheck && !nextChkStaff.isEmpty && nextChkStaff != "募集中" {
                                return "（\(nextChkStaff)さんに変更）"
                            }
                            if hasActiveNextCheck && nextChkStaff == "募集中" {
                                return "（全員募集に変更）"
                            }
                            return ""
                        }()
                        let keyEpoch = prevChkEndEpochKey > 0 ? prevChkEndEpochKey : chkEndEpochKey
                        pollEventType = "unassign_check"
                        pollEventKey = "cloud_unassign_check_\(rowId)_\(keyEpoch)_\(chkProc)"
                        pollAlertId = pollEventKey
                        pollMsg = resolvedNotifyActor.isEmpty
                            ? "【\(timeStr)】ℹ️ \(seatDisplay)の【\(chkProc)】担当から外れました\(reasonSuffix)"
                            : "【\(timeStr)】ℹ️ \(resolvedNotifyActor)さんが\(seatDisplay)の【\(chkProc)】担当を変更しました\(reasonSuffix)"
                        pollColor = "#8E8E93"
                    } else if isHelpRecruitingNow && !wasHelpRecruitingBefore {
                        let proc = nextItem.helpProcess.isEmpty ? "シャンプー" : nextItem.helpProcess
                        pollEventType = "recruit"
                        pollEventKey = "cloud_recruit_help_\(rowId)_\(endEpochKey)_\(proc)"
                        pollAlertId = pollEventKey
                        pollMsg = resolvedNotifyActor.isEmpty
                            ? "【\(timeStr)】📢 \(seatDisplay)が【\(proc)】のヘルプを募集中です！"
                            : "【\(timeStr)】📢 \(resolvedNotifyActor)さんが\(seatDisplay)の【\(proc)】を全員に募集中です！"
                        pollColor = "#FF9500"
                    } else if isCheckRecruitingNow && !wasCheckRecruitingBefore {
                        let chkProc = nextItem.displayCheckProcess
                        let chkMins = max(1, (nextItem.checkTotalSeconds ?? 300) / 60)
                        pollEventType = "recruit_check"
                        pollEventKey = "cloud_recruit_check_\(rowId)_\(chkEndEpochKey)_\(chkProc)"
                        pollAlertId = pollEventKey
                        pollMsg = resolvedNotifyActor.isEmpty
                            ? "【\(timeStr)】📢 \(seatDisplay)が【\(chkProc)（\(chkMins)分）】の担当を募集中です！"
                            : "【\(timeStr)】📢 \(resolvedNotifyActor)さんが\(seatDisplay)の【\(chkProc)（\(chkMins)分）】を募集中です！"
                        pollColor = "#FF9500"
                    } else if !wasRunningBefore && isNewOrResetTimer && (resolvedIsCreatorMe == true || nextItem.shouldAlertMainTimer(for: self.currentUserName) || nextItem.shouldAlertCheckTimer(for: self.currentUserName)) {
                        let mins = max(1, nextItem.totalSeconds / 60)
                        pollEventType = "timer_start"
                        pollEventKey = "cloud_start_\(rowId)_\(endEpochKey)"
                        pollAlertId = pollEventKey
                        pollMsg = resolvedNotifyActor.isEmpty
                            ? "【\(timeStr)】⏱️ \(seatDisplay)のタイマー（\(mins)分）が開始されました"
                            : "【\(timeStr)】⏱️ \(resolvedNotifyActor)さんが\(seatDisplay)のタイマー（\(mins)分）を開始しました"
                        pollColor = "#0A84FF"
                    } else if wasRunningBefore && abs(cloudTargetEndSec - cur.targetEndTime.timeIntervalSince1970) >= 25.0 && (resolvedIsCreatorMe == true || nextItem.shouldAlertMainTimer(for: self.currentUserName) || nextItem.shouldAlertCheckTimer(for: self.currentUserName)) {
                        let remMins = max(1, safeClampedSeconds((max(0, cloudTargetEndSec - now.timeIntervalSince1970) / 60.0).rounded()))
                        pollEventType = "time_adjust"
                        pollEventKey = "cloud_adjust_\(rowId)_\(endEpochKey)"
                        pollAlertId = pollEventKey
                        pollMsg = resolvedNotifyActor.isEmpty
                            ? "【\(timeStr)】⏱️ \(seatDisplay)の残り時間が変更されました（残り約\(remMins)分）"
                            : "【\(timeStr)】⏱️ \(resolvedNotifyActor)さんが\(seatDisplay)の残り時間を変更しました（残り約\(remMins)分）"
                        pollColor = "#0A84FF"
                    }

                    if !pollEventKey.isEmpty && !pollMsg.isEmpty {
                        let canonicalPollEv = (pollEventType == "recruit_check") ? "recruit" : pollEventType
                        let nextAssistForDisc = nextItem.isNoHelpNeeded
                            ? "ヘルプなし"
                            : (nextItem.isRecruiting ? "募集中" : nextAssistStaff)
                        let nextHelpProcForDisc = nextItem.isNoHelpNeeded
                            ? "ヘルプなし"
                            : (nextItem.helpProcess.isEmpty ? "シャンプー" : nextItem.helpProcess)
                        let pollStateDisc = Self.buildPeerEventStateDisc(
                            eventType: canonicalPollEv,
                            prevAssist: prevAssistStaff,
                            nextAssist: nextAssistForDisc,
                            helpProc: nextHelpProcForDisc,
                            nextHelpProc: nextHelpProcForDisc,
                            prevCheckStaff: prevChkStaff,
                            nextCheckStaff: nextChkStaff,
                            checkProc: nextItem.displayCheckProcess,
                            recruitProc: pollEventType == "recruit_check"
                                ? nextItem.displayCheckProcess
                                : (nextItem.helpProcess.isEmpty ? "シャンプー" : nextItem.helpProcess),
                            nextEndMs: safeEpochMillisInt64(cloudTargetEndMs),
                            nextCheckEndMs: safeEpochMillisInt64(cloudCheckEndMs)
                        )
                        let pollSemKey = Self.buildPeerEventSemanticKey(
                            timerIdOrLabel: rowId,
                            eventType: canonicalPollEv,
                            actorId: cloudUpdatedBy,
                            stateDisc: pollStateDisc
                        )
                        let nowSec = now.timeIntervalSince1970
                        let alreadyHandledSem = !pollSemKey.isEmpty && self.hasHandledPeerSemanticKey(pollSemKey, channel: "any", nowSec: nowSec)
                        if !alreadyHandledSem && self.markDirectCloudEventNotifiedIfNeeded(pollEventKey) {
                            if !pollSemKey.isEmpty {
                                self.recordHandledPeerSemanticKey(
                                    pollSemKey,
                                    channel: "direct_poll",
                                    seatId: rowId,
                                    seatNumber: nextItem.seatNumber,
                                    seatLabel: seatDisplay,
                                    eventType: canonicalPollEv,
                                    nowSec: nowSec
                                )
                            }
                            let pollUpdatedMs = safeEpochMillisInt64((cloudUpdatedAt ?? now).timeIntervalSince1970 * 1000.0)
                            let resolvedPollAlertId = "\(pollAlertId)_\(pollUpdatedMs)"
                            let isGentlePoll = pollEventType.hasPrefix("unassign_")
                            let didAdd = self.enqueuePeerConfirmationAlert(
                                id: resolvedPollAlertId,
                                text: pollMsg,
                                colorHex: pollColor,
                                timeText: timeStr,
                                eventType: pollEventType,
                                seatId: rowId,
                                seatNumber: nextItem.seatNumber,
                                seatLabel: seatDisplay,
                                semanticKey: pollSemKey
                            )
                            if didAdd {
                                self.incomingNotification = (text: pollMsg, color: pollColor, eventType: pollEventType)
                                WatchAlarmCoordinator.shared.postPeerActionNotification(
                                    text: pollMsg,
                                    forceSystemBanner: self.isModalSheetCurrentlyPresented,
                                    isGentleInfo: isGentlePoll,
                                    eventType: pollEventType
                                )
                            }
                        }
                    }
                }
            } else if !cur.isRunning && cloudStatus != "running" {
                // 非稼働中（00:00待機・シャンプー中・コーミング中・チェック中等）の席名＆工程ステータス同期（Issue #12: 1人目が停止後に2人目がシャンプー移行または二次停止した際の通知＆反映を含む）
                let isProtectedByRecentLocal = self.isSeatProtectedByRecentLocalAction(seatId: rowId, seatNumber: cur.seatNumber, within: 8.0)
                    || self.isSeatProtectedByRecentLocalAction(seatId: cur.id, seatNumber: cur.seatNumber, within: 8.0)
                if !isProtectedByRecentLocal {
                    let prevStatus = updatedTimers[i].status
                    if updatedTimers[i].id != rowId {
                        updatedTimers[i].id = rowId
                        didChange = true
                    }
                    if !cloudLabel.isEmpty && updatedTimers[i].seatLabel != cloudLabel {
                        updatedTimers[i].seatLabel = cloudLabel
                        didChange = true
                    }
                    let isNoHelp = (cloudAssist == "ヘルプなし" || cloudAssist == "none" || cloudHelpProc == "ヘルプなし")
                    let isRecruit = (cloudAssist == "募集中")
                    let hasActiveCloudCustomHelpProc = !cloudHelpProc.isEmpty && cloudHelpProc != "シャンプー" && cloudHelpProc != "ヘルプなし" && cloudHelpProc.lowercased() != "none" && cloudHelpProc != "募集中" && cloudHelpProc != "未定"
                    let nextStatus: TreatmentStatus = {
                        if cloudIsShampooing { return .shampoo }
                        if cloudHelpProc == "コーミング" { return .combing }
                        if cloudHelpProc == "チェック" { return .check }
                        if hasActiveCloudCustomHelpProc { return .shampoo }
                        return .normal
                    }()
                    let nextHelpProc: String = (nextStatus == .normal || isNoHelp)
                        ? ""
                        : (cloudHelpProc.isEmpty && nextStatus == .shampoo ? "シャンプー" : cloudHelpProc)
                    let nextShampooStaff: String? = (nextStatus == .normal || cloudAssist.isEmpty || isRecruit || isNoHelp || cloudAssist == "未定")
                        ? nil
                        : cloudAssist
                    if updatedTimers[i].status != nextStatus ||
                       updatedTimers[i].helpProcess != nextHelpProc ||
                       updatedTimers[i].shampooStaff != nextShampooStaff ||
                       updatedTimers[i].isRecruiting != isRecruit ||
                       updatedTimers[i].isNoHelpNeeded != isNoHelp {
                        updatedTimers[i].status = nextStatus
                        updatedTimers[i].helpProcess = nextHelpProc
                        updatedTimers[i].shampooStaff = nextShampooStaff
                        updatedTimers[i].isRecruiting = isRecruit
                        updatedTimers[i].isNoHelpNeeded = isNoHelp
                        didChange = true
                    }
                    if cloudStatus == "idle" && cloudColorStaff.isEmpty && nextStatus == .normal && updatedTimers[i].pausedRemainingSeconds <= 0 && !isRecruit && !isNoHelp && nextShampooStaff == nil {
                        if updatedTimers[i].createdBy != nil || !updatedTimers[i].creatorName.isEmpty || updatedTimers[i].isCreatorMeExplicit != nil {
                            updatedTimers[i].createdBy = nil
                            updatedTimers[i].creatorName = ""
                            updatedTimers[i].isCreatorMeExplicit = nil
                            didChange = true
                        }
                    }
                    self.purgeStalePeerSemanticKeysForSeatTransition(prev: cur, next: updatedTimers[i])

                    if let updatedAt = cloudUpdatedAt, now.timeIntervalSince(updatedAt) <= 90.0 {
                        let actorName = self.resolveCloudActorName(
                            cloudAssist: (nextStatus != .normal) ? cloudAssist : "",
                            cloudUpdatedBy: cloudUpdatedBy,
                            cloudCreatedBy: cloudCreatedBy,
                            cloudColorStaff: cloudColorStaff
                        )
                        let isSelfStoppedMod: Bool = {
                            if hasValidMyUid && Self.isValidCloudUUID(cloudUpdatedBy) {
                                return cloudUpdatedBy.caseInsensitiveCompare(myUid) == .orderedSame
                            }
                            if cloudUpdatedBy.isEmpty && !actorName.isEmpty && SeatTimerItem.isStaffMe(actorName, currentUserName: self.currentUserName) {
                                return true
                            }
                            return false
                        }()
                        let localStopEntry = self.localStops[rowId] ?? self.localStops[cur.id] ?? self.localStops[prevKey]
                        let isRecentLocalStopper = (localStopEntry != nil) && (now.timeIntervalSince(localStopEntry!.at) <= 1800.0)
                        let isStakeholderOnStopped = (resolvedIsCreatorMe == true)
                            || cur.isCreatorMe(currentUserName: self.currentUserName)
                            || SeatTimerItem.isStaffMe(cur.shampooStaff ?? "", currentUserName: self.currentUserName)
                            || (!cloudAssist.isEmpty && cloudAssist != "募集中" && cloudAssist != "ヘルプなし" && SeatTimerItem.isStaffMe(cloudAssist, currentUserName: self.currentUserName))
                            || isRecentLocalStopper

                        if !isSelfStoppedMod && isStakeholderOnStopped {
                            let timeStr = Self.peerAlertTimeFormatter.string(from: updatedAt)
                            let seatDisplay = !cloudLabel.isEmpty ? cloudLabel : cur.displaySeatName
                            let updatedEpoch = safeEpochSecondsInt64(updatedAt.timeIntervalSince1970)
                            let nowSec = now.timeIntervalSince1970

                            if prevStatus != nextStatus && nextStatus != .normal {
                                let procKey = "cloud_stopped_proc_\(rowId)_\(updatedEpoch)_\(nextStatus.rawValue)"
                                let evKind = (nextStatus == .shampoo) ? "shampoo" : ((nextStatus == .combing) ? "combing" : "check")
                                let emoji = (nextStatus == .shampoo) ? "💧" : ((nextStatus == .combing) ? "🪮" : "🔍")
                                let procLabel = (nextStatus == .shampoo) ? "シャンプー" : ((nextStatus == .combing) ? "コーミング" : "チェック")
                                let colorHex = (nextStatus == .shampoo) ? "#AF52DE" : ((nextStatus == .combing) ? "#0A84FF" : "#30D158")
                                let procSemKey = Self.buildPeerEventSemanticKey(
                                    timerIdOrLabel: rowId,
                                    eventType: "status_change",
                                    actorId: cloudUpdatedBy,
                                    stateDisc: Self.buildPeerEventStateDisc(
                                        eventType: "status_change",
                                        nextAssist: isNoHelp ? "ヘルプなし" : cloudAssist,
                                        procLabel: procLabel
                                    )
                                )
                                let alreadyHandledProcSem = !procSemKey.isEmpty && self.hasHandledPeerSemanticKey(procSemKey, channel: "any", nowSec: nowSec)
                                if !alreadyHandledProcSem && self.markDirectCloudEventNotifiedIfNeeded(procKey) {
                                    if !procSemKey.isEmpty {
                                        self.recordHandledPeerSemanticKey(
                                            procSemKey,
                                            channel: "direct_poll",
                                            seatId: rowId,
                                            seatNumber: cur.seatNumber,
                                            seatLabel: seatDisplay,
                                            eventType: "status_change",
                                            nowSec: nowSec
                                        )
                                    }
                                    let msg = actorName.isEmpty
                                        ? "【\(timeStr)】\(emoji) \(seatDisplay)が\(procLabel)に入りました"
                                        : "【\(timeStr)】\(emoji) \(seatDisplay)の\(procLabel)に \(actorName) さんが入りました"
                                    let didAdd = self.enqueuePeerConfirmationAlert(
                                        id: procKey,
                                        text: msg,
                                        colorHex: colorHex,
                                        timeText: timeStr,
                                        eventType: evKind,
                                        seatId: rowId,
                                        seatNumber: cur.seatNumber,
                                        seatLabel: seatDisplay,
                                        semanticKey: procSemKey
                                    )
                                    if didAdd {
                                        self.incomingNotification = (text: msg, color: colorHex, eventType: evKind)
                                        WatchAlarmCoordinator.shared.postPeerActionNotification(
                                            text: msg,
                                            forceSystemBanner: self.isModalSheetCurrentlyPresented,
                                            eventType: evKind
                                        )
                                        didChange = true
                                    }
                                }
                            } else if prevStatus == nextStatus && cloudStatus == "paused",
                                      let stopEntry = localStopEntry,
                                      updatedAt > stopEntry.at.addingTimeInterval(0.5),
                                      !cloudUpdatedBy.isEmpty {
                                let secStopKey = "cloud_sec_stop_\(rowId)_\(updatedEpoch)_\(cloudUpdatedBy)"
                                let secStopSemKey = Self.buildPeerEventSemanticKey(
                                    timerIdOrLabel: rowId,
                                    eventType: "stop",
                                    actorId: cloudUpdatedBy,
                                    stateDisc: Self.buildPeerEventStateDisc(eventType: "stop")
                                )
                                let alreadyHandledSecSem = !secStopSemKey.isEmpty && self.hasHandledPeerSemanticKey(secStopSemKey, channel: "any", nowSec: nowSec)
                                if !alreadyHandledSecSem && self.markDirectCloudEventNotifiedIfNeeded(secStopKey) {
                                    if !secStopSemKey.isEmpty {
                                        self.recordHandledPeerSemanticKey(
                                            secStopSemKey,
                                            channel: "direct_poll",
                                            seatId: rowId,
                                            seatNumber: cur.seatNumber,
                                            seatLabel: seatDisplay,
                                            eventType: "stop",
                                            nowSec: nowSec
                                        )
                                    }
                                    let msg = actorName.isEmpty
                                        ? "【\(timeStr)】⏹ \(seatDisplay)のタイマーが停止されました"
                                        : "【\(timeStr)】⏹ \(seatDisplay)のタイマーを \(actorName) さんが止めました"
                                    let didAdd = self.enqueuePeerConfirmationAlert(
                                        id: secStopKey,
                                        text: msg,
                                        colorHex: "#FF9500",
                                        timeText: timeStr,
                                        eventType: "stop",
                                        seatId: rowId,
                                        seatNumber: cur.seatNumber,
                                        seatLabel: seatDisplay,
                                        semanticKey: secStopSemKey
                                    )
                                    if didAdd {
                                        self.incomingNotification = (text: msg, color: "#FF9500", eventType: "stop")
                                        WatchAlarmCoordinator.shared.postPeerActionNotification(
                                            text: msg,
                                            forceSystemBanner: self.isModalSheetCurrentlyPresented,
                                            eventType: "stop"
                                        )
                                        didChange = true
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        self.hasReceivedAuthoritativeSyncInSession = true

        if didChange {
            self.timers = updatedTimers
            WatchAlarmCoordinator.shared.update(
                timers: updatedTimers,
                mainTimer: self.mainTimer,
                soundOn: self.alarmSoundEnabled,
                currentUserName: self.currentUserName
            )
            WidgetSync.save(
                timers: updatedTimers,
                mainTimer: self.mainTimer,
                userName: self.currentUserName,
                forceReload: true
            )
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

// MARK: - ★ 全Apple Watch画面サイズ（38mm/40mm/41mm/42mm/44mm/45mm/46mm/49mm）自動最適化ヘルパー
enum WatchLayout {
    static var screenWidth: CGFloat {
        WKInterfaceDevice.current().screenBounds.width
    }
    /// 38mm(136pt) / 旧42mm(156pt) / 40mm(162pt) / 41mm(176pt) などの小型画面
    static var isSmall: Bool {
        screenWidth < 180
    }
    /// 44mm(184pt) / 新42mm(187pt) 以下の中〜小型画面（45mm=198pt, 46mm=208pt, 49mm=205pt 以外）
    static var isCompact: Bool {
        screenWidth < 192
    }
    /// 画面幅に応じたスケール係数（基準: 198pt、最小 0.84 〜 最大 1.0）
    static var scale: CGFloat {
        let s = screenWidth / 198.0
        return min(1.0, max(0.84, s))
    }
    static func font(_ base: CGFloat) -> CGFloat {
        return (base * scale * 2).rounded() / 2
    }
    static var cardPadding: CGFloat {
        isSmall ? 6 : (isCompact ? 7.5 : 9)
    }
    static var sheetHorizontalPadding: CGFloat {
        isSmall ? 2 : (isCompact ? 4 : 6)
    }
    static var buttonHorizontalPadding: CGFloat {
        isSmall ? 6 : (isCompact ? 7.5 : 9)
    }
}

// ★ シート閉鎖中のSwiftUI ViewGraph再評価・クラッシュや `.sheet(item:)` の再生成デッドロックを防ぐための非リアクティブ管理ボックス
private final class PendingSheetActionBox {
    var action: (() -> Void)? = nil
    var seatSheetAction: (() -> Void)? = nil
    var closeFallbackWorkItem: DispatchWorkItem? = nil
    var mainCloseFallbackWorkItem: DispatchWorkItem? = nil
    var chainedSheetWorkItem: DispatchWorkItem? = nil
    var cachedSheetItems: [String: SeatTimerItem] = [:]
    var cachedMainTimerItem: SeatTimerItem? = nil
    var suppressOvertimeSheetUntil: Date = .distantPast
    var skipNextTimersOnChangeSync: Bool = false
}

// MARK: - メイン画面
struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
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
    @State private var timeActionInitialBranchMode: Bool = false
    @State private var timeActionInitialSubCheckBranchMode: Bool = false
    @State private var pendingOpenStandardSeatIdAfterAdd: String? = nil
    
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
    @State private var notificationDismissWorkItem: DispatchWorkItem? = nil
    @State private var pendingRemotePeerBanner: (text: String, color: Color, receivedAt: Date)? = nil
    @State private var alertedUnassignedHelpKeys: Set<String> = []
    
    // 客席サムネイル・バードビュー（一覧）表示フラグ（起動時およびモジュラー文字盤タップ時は一覧をデフォルト表示）
    @State private var showingThumbnailMap = true
    @State private var showingMainTimerSheet = false
    @State private var mainTimerSheetInitialSubMode: MainTimerActionSheet.SubMode? = nil
    @State private var hasInitialOpenedMap = false
    @State private var pendingSelectedSeatId: String? = nil
    @State private var pendingOpenMainTimerSheet: Bool = false
    @State private var pendingOvertimeSheetWorkItem: DispatchWorkItem? = nil
    
    // 客席タイマー一覧（永続化データから即座に復元し、バックグラウンド再起動時の予定消滅を防止）
    @State private var timers: [SeatTimerItem] = WatchSessionManager.shared.timers
    // メインタイマー（永続化データから即座に復元）
    @State private var mainTimer: SeatTimerItem? = WatchSessionManager.shared.mainTimer
    
    // ★ タイム確定時などの自動スクロール用ステート
    @State private var scrollToSeatId: String? = nil
    @State private var scrollTrigger: Int = 0
    // ★ サロン客席マップのDigital Crown（トグル）フォーカス復帰トリガー
    @State private var mapCrownFocusTrigger: Int = 0
    
    // ★ 現在いずれかのモーダルシートが表示中かどうか（シート表示中に背面ビューのスクロール・バナー・クラウンフォーカスを動かしてSwiftUIをデッドロックさせないためのガード）
    private var isAnyModalSheetPresented: Bool {
        showingMainTimerSheet ||
        showingAddSeatSheet ||
        timeActionTargetId != nil ||
        checkActionTargetId != nil ||
        shampooActionTargetId != nil ||
        selectHelpStaffTargetId != nil ||
        selectCheckStaffTargetId != nil
    }
    
    private func triggerScroll(to seatId: String) {
        scrollToSeatId = seatId
        guard !isAnyModalSheetPresented else { return }
        scrollTrigger += 1
        mapCrownFocusTrigger += 1
    }
    
    // 0.5秒周期の画面再描画トリガー（常時稼働 WatchRealtimeClock）
    @State private var now = Date()
    
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
            
            // ③ 同じグループ内では超過中の席（本タイマー超過・中間チェック超過）を最優先
            let aAnyOver = a.isOvertime || a.isCheckOvertime
            let bAnyOver = b.isOvertime || b.isCheckOvertime
            if aAnyOver != bAnyOver {
                return aAnyOver && !bAnyOver
            }
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
    
    // 通知バナー表示ヘルパー（リモート通知はタップして確認するまで消えない persistent キューで表示、ローカル操作のみ自動消去）
    private func showNotification(
        text: String,
        color: Color = Color(hex: "#0A84FF"),
        playHapticFeedback: Bool = false,
        isRemotePeer: Bool = false,
        isGentleInfo: Bool = false
    ) {
        if playHapticFeedback {
            if isGentleInfo {
                // ★ A-1: 担当解除（unassign_*）はタイムアップや新規募集と混同しないよう控えめなクリック振動1回のみ
                playHaptic(.click)
            } else {
                playHaptic(.notification)
                if isRemotePeer {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) {
                        WKInterfaceDevice.current().play(.directionUp)
                    }
                }
            }
        }
        // リモート共有通知は WatchSessionManager.unconfirmedPeerAlerts キュー（確認タップ制バナー）で常時表示するため、3.5秒自動消去バナーには流さない
        if isRemotePeer {
            pendingRemotePeerBanner = nil
            return
        }
        notificationDismissWorkItem?.cancel()
        guard !isAnyModalSheetPresented else {
            return
        }
        let isSameBannerShowing = (notificationBannerText == text)
        if !isSameBannerShowing {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
                notificationBannerText = text
                notificationBannerColor = color
            }
        } else {
            notificationBannerColor = color
        }
        
        let displayDuration: TimeInterval = 3.2
        let workItem = DispatchWorkItem {
            withAnimation(.easeOut(duration: 0.3)) {
                if notificationBannerText == text {
                    notificationBannerText = nil
                }
            }
        }
        notificationDismissWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + displayDuration, execute: workItem)
    }
    
    // ★ 一覧画面（カードリスト / 客席マップ）からシートを開く直前に、最新の sessionManager.timers と cachedSheetItems を解決するヘルパー
    //   （※ シートオープンと同一トランザクションで親 View の `@State self.timers` 配列を書き換えると、
    //       watchOS SwiftUI の ViewGraph 再構築とシートプレゼンテーションが競合してクラッシュする原因となるため、
    //       `self.timers` の同期更新は行わず、`cachedSheetItems` スナップショットと `self.timers` 上の既存 id 整合のみを行う）
    @discardableResult
    private func prepareSheetTarget(for item: SeatTimerItem, cacheKey: String) -> SeatTimerItem {
        var freshest = sessionManager.timers.first(where: { $0.id == item.id })
            ?? sessionManager.timers.first(where: { $0.seatNumber == item.seatNumber })
            ?? timers.first(where: { $0.id == item.id })
            ?? timers.first(where: { $0.seatNumber == item.seatNumber })
            ?? item
        if timers.first(where: { $0.id == freshest.id }) == nil,
           let localMatch = timers.first(where: { $0.seatNumber == freshest.seatNumber }) {
            freshest.id = localMatch.id
        }
        pendingMainTimerSheetActionBox.cachedSheetItems[cacheKey] = freshest
        return freshest
    }

    // ★ シート表示中に親の `timers` が更新されても `.sheet(item:)` に渡す `SeatTimerItem` が変化して
    //   SwiftUI のシート再構築・アニメーション競合フリーズを引き起こさないよう、シートオープン時のスナップショットを固定するヘルパー
    private func resolveSheetItem(for targetId: String?, cacheKey: String) -> SeatTimerItem? {
        guard let targetId = targetId else {
            pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: cacheKey)
            return nil
        }
        if let cached = pendingMainTimerSheetActionBox.cachedSheetItems[cacheKey],
           cached.id == targetId {
            return cached
        }
        if let exact = sessionManager.timers.first(where: { $0.id == targetId }) ?? timers.first(where: { $0.id == targetId }) {
            pendingMainTimerSheetActionBox.cachedSheetItems[cacheKey] = exact
            return exact
        }
        if targetId.hasPrefix("seat-"),
           let num = Int(targetId.replacingOccurrences(of: "seat-", with: "")),
           var matched = sessionManager.timers.first(where: { $0.seatNumber == num }) ?? timers.first(where: { $0.seatNumber == num }) {
            matched.id = targetId
            pendingMainTimerSheetActionBox.cachedSheetItems[cacheKey] = matched
            return matched
        }
        if let sessionMatch = sessionManager.timers.first(where: { $0.id == targetId }),
           var matched = timers.first(where: { $0.seatNumber == sessionMatch.seatNumber }) {
            matched.id = targetId
            pendingMainTimerSheetActionBox.cachedSheetItems[cacheKey] = matched
            return matched
        }
        if let localMatch = timers.first(where: { $0.id == targetId }),
           var matched = sessionManager.timers.first(where: { $0.seatNumber == localMatch.seatNumber }) {
            matched.id = targetId
            pendingMainTimerSheetActionBox.cachedSheetItems[cacheKey] = matched
            return matched
        }
        return pendingMainTimerSheetActionBox.cachedSheetItems[cacheKey]
    }

    private func findSeatIndex(for item: SeatTimerItem) -> Int? {
        if let idx = timers.firstIndex(where: { $0.id == item.id }) {
            return idx
        }
        return timers.firstIndex(where: { $0.seatNumber == item.seatNumber })
    }

    private func findSeatIndex(seatId: String, title: String? = nil) -> Int? {
        if let idx = timers.firstIndex(where: { $0.id == seatId }) {
            return idx
        }
        if seatId.hasPrefix("seat-"),
           let num = Int(seatId.replacingOccurrences(of: "seat-", with: "")),
           let idx = timers.firstIndex(where: { $0.seatNumber == num }) {
            return idx
        }
        if let title = title {
            let digits = title.prefix(while: { $0.isNumber })
            if let num = Int(digits), let idx = timers.firstIndex(where: { $0.seatNumber == num }) {
                return idx
            }
        }
        return nil
    }

    // シート用のバインディング
    private var bindingTimeAction: Binding<SeatTimerItem?> {
        Binding(
            get: { resolveSheetItem(for: timeActionTargetId, cacheKey: "timeAction") },
            set: { newVal in
                if newVal == nil {
                    timeActionTargetId = nil
                    timeActionInitialBranchMode = false
                    timeActionInitialSubCheckBranchMode = false
                    pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "timeAction")
                }
            }
        )
    }
    
    private var bindingCheckAction: Binding<SeatTimerItem?> {
        Binding(
            get: { resolveSheetItem(for: checkActionTargetId, cacheKey: "checkAction") },
            set: { newVal in
                if newVal == nil {
                    checkActionTargetId = nil
                    pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "checkAction")
                }
            }
        )
    }
    
    private var bindingShampooAction: Binding<SeatTimerItem?> {
        Binding(
            get: { resolveSheetItem(for: shampooActionTargetId, cacheKey: "shampooAction") },
            set: { newVal in
                if newVal == nil {
                    shampooActionTargetId = nil
                    pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "shampooAction")
                }
            }
        )
    }
    
    private var bindingSelectHelpStaff: Binding<SeatTimerItem?> {
        Binding(
            get: { resolveSheetItem(for: selectHelpStaffTargetId, cacheKey: "selectHelpStaff") },
            set: { newVal in
                if newVal == nil {
                    selectHelpStaffTargetId = nil
                    pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "selectHelpStaff")
                }
            }
        )
    }
    
    private var bindingSelectCheckStaff: Binding<SeatTimerItem?> {
        Binding(
            get: { resolveSheetItem(for: selectCheckStaffTargetId, cacheKey: "selectCheckStaff") },
            set: { newVal in
                if newVal == nil {
                    selectCheckStaffTargetId = nil
                    pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "selectCheckStaff")
                }
            }
        )
    }
    
    // ★ アラーム鳴動時に前面のモーダルシートがアラーム停止画面（alarmOverlay）を覆い隠さないよう全シートを即座に閉じる
    private func dismissAllSheetsForAlarm() {
        pendingOvertimeSheetWorkItem?.cancel()
        pendingOvertimeSheetWorkItem = nil
        pendingMainTimerSheetActionBox.chainedSheetWorkItem?.cancel()
        pendingMainTimerSheetActionBox.chainedSheetWorkItem = nil
        pendingOpenStandardSeatIdAfterAdd = nil
        pendingMainTimerSheetActionBox.closeFallbackWorkItem?.cancel()
        pendingMainTimerSheetActionBox.closeFallbackWorkItem = nil
        pendingMainTimerSheetActionBox.mainCloseFallbackWorkItem?.cancel()
        pendingMainTimerSheetActionBox.mainCloseFallbackWorkItem = nil
        _ = executePendingMainTimerSheetAction(clearSheetBindings: true)
        _ = executePendingSeatSheetAction(clearSheetBindings: true)
        pendingMainTimerSheetActionBox.cachedSheetItems.removeAll()
        pendingMainTimerSheetActionBox.cachedMainTimerItem = nil
        pendingSelectedSeatId = nil
        pendingOpenMainTimerSheet = false
        showingAddSeatSheet = false
        timeActionTargetId = nil
        timeActionInitialBranchMode = false
        timeActionInitialSubCheckBranchMode = false
        checkActionTargetId = nil
        shampooActionTargetId = nil
        selectHelpStaffTargetId = nil
        selectCheckStaffTargetId = nil
        showingMainTimerSheet = false
    }

    private func findMatchingReceivedSeat(targetId: String, cached: SeatTimerItem?, in receivedTimers: [SeatTimerItem]) -> SeatTimerItem? {
        if let exact = receivedTimers.first(where: { $0.id == targetId }) {
            return exact
        }
        if let cachedNum = cached?.seatNumber, cachedNum > 0,
           let byCachedNum = receivedTimers.first(where: { $0.seatNumber == cachedNum }) {
            return byCachedNum
        }
        if targetId.hasPrefix("seat-"),
           let num = Int(targetId.replacingOccurrences(of: "seat-", with: "")),
           let byPrefixNum = receivedTimers.first(where: { $0.seatNumber == num }) {
            return byPrefixNum
        }
        if let localMatch = timers.first(where: { $0.id == targetId }),
           let byLocalNum = receivedTimers.first(where: { $0.seatNumber == localMatch.seatNumber }) {
            return byLocalNum
        }
        return nil
    }

    // ★ スマホや他端末から対象タイマー（または途中チェックタイマー）が停止・完了された場合、
    //   開いたままの超過・操作シート（TimeActionSheet / CheckActionSheet / MainTimerActionSheet）を自動で閉じて即座に 00:00 停止画面へ復帰させる
    @discardableResult
    private func handleRemoteModalSheetAutoCloseIfNeeded(receivedTimers: [SeatTimerItem], receivedMain: SeatTimerItem?) -> Bool {
        var didAutoClose = false

        if pendingMainTimerSheetActionBox.seatSheetAction == nil {
            if let targetId = timeActionTargetId {
                let cached = pendingMainTimerSheetActionBox.cachedSheetItems["timeAction"]
                let latest = findMatchingReceivedSeat(targetId: targetId, cached: cached, in: receivedTimers)
                let localCurrent = findMatchingReceivedSeat(targetId: targetId, cached: cached, in: self.timers)
                let resolvedSeatNum = latest?.seatNumber ?? cached?.seatNumber ?? localCurrent?.seatNumber ?? 0
                let isProtectedByLocalAction = sessionManager.isSeatProtectedByRecentLocalAction(
                    seatId: targetId,
                    seatNumber: resolvedSeatNum,
                    within: 15.0
                )
                let wasRunningWhenOpened = (cached?.isRunning == true) || (localCurrent?.isRunning == true) || timeActionInitialBranchMode
                let wasPausedNonZeroWhenOpened = (cached != nil && cached?.isRunning == false && cached?.isZero == false && localCurrent?.isRunning != true)
                let shouldCloseForMainStop =
                    !isProtectedByLocalAction &&
                    ((wasRunningWhenOpened && (latest == nil || latest?.isRunning == false)) ||
                     (wasPausedNonZeroWhenOpened && (latest == nil || latest?.isZero == true)) ||
                     (timeActionInitialBranchMode && cached?.shouldAlertMainTimer(for: currentUserName) == true && latest?.shouldAlertMainTimer(for: currentUserName) == false))
                let shouldCloseForSubCheckStop =
                    !isProtectedByLocalAction &&
                    timeActionInitialSubCheckBranchMode &&
                    (latest == nil || latest?.isRunning == false || latest?.isCheckCompleted == true || latest?.checkTargetEndTime == nil ||
                     (cached?.shouldAlertCheckTimer(for: currentUserName) == true && latest?.shouldAlertCheckTimer(for: currentUserName) == false))
                if shouldCloseForMainStop || shouldCloseForSubCheckStop {
                    timeActionTargetId = nil
                    timeActionInitialBranchMode = false
                    timeActionInitialSubCheckBranchMode = false
                    pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "timeAction")
                    didAutoClose = true
                }
                // ★ 重要: シート表示中は cachedSheetItems["timeAction"] を絶対に書き換えない！
                //   （書き換えると bindingTimeAction が返す item が変化し、timeActionSheetView(item:) の引数 item.isZero が変わって
                //    SwiftUI がシートを再評価・強制閉鎖してしまうため、シートオープン時のスナップショットを完全固定する）
            }

            if let targetId = checkActionTargetId {
                let cached = pendingMainTimerSheetActionBox.cachedSheetItems["checkAction"]
                let latest = findMatchingReceivedSeat(targetId: targetId, cached: cached, in: receivedTimers)
                let resolvedSeatNum = latest?.seatNumber ?? cached?.seatNumber ?? 0
                let isProtectedByLocalAction = sessionManager.isSeatProtectedByRecentLocalAction(
                    seatId: targetId,
                    seatNumber: resolvedSeatNum,
                    within: 15.0
                )
                let wasUnassignedFromCheck = (cached?.shouldAlertCheckTimer(for: currentUserName) == true && latest?.shouldAlertCheckTimer(for: currentUserName) == false)
                if !isProtectedByLocalAction && (latest == nil || latest?.isRunning == false || latest?.isCheckCompleted == true || latest?.checkTargetEndTime == nil || wasUnassignedFromCheck) {
                    checkActionTargetId = nil
                    pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "checkAction")
                    didAutoClose = true
                }
            }

            if let targetId = shampooActionTargetId {
                let cached = pendingMainTimerSheetActionBox.cachedSheetItems["shampooAction"]
                let latest = findMatchingReceivedSeat(targetId: targetId, cached: cached, in: receivedTimers)
                let resolvedSeatNum = latest?.seatNumber ?? cached?.seatNumber ?? 0
                let isProtectedByLocalAction = sessionManager.isSeatProtectedByRecentLocalAction(
                    seatId: targetId,
                    seatNumber: resolvedSeatNum,
                    within: 15.0
                )
                let wasRunningWhenOpened = (cached?.isRunning == true)
                let switchedToDifferentTimer: Bool = {
                    guard let latest = latest, latest.isRunning else { return false }
                    if !wasRunningWhenOpened { return true }
                    if let cachedEnd = cached?.targetEndTime, abs(latest.targetEndTime.timeIntervalSince(cachedEnd)) > 5.0 {
                        return true
                    }
                    return false
                }()
                let wasStoppedRemotely = (wasRunningWhenOpened && (latest == nil || latest?.isRunning == false))
                if !isProtectedByLocalAction && (latest == nil || switchedToDifferentTimer || wasStoppedRemotely) {
                    shampooActionTargetId = nil
                    pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "shampooAction")
                    didAutoClose = true
                }
            }

            if let targetId = selectHelpStaffTargetId {
                let cached = pendingMainTimerSheetActionBox.cachedSheetItems["selectHelpStaff"]
                let latest = findMatchingReceivedSeat(targetId: targetId, cached: cached, in: receivedTimers)
                let localCurrent = findMatchingReceivedSeat(targetId: targetId, cached: cached, in: self.timers)
                let resolvedSeatNum = latest?.seatNumber ?? cached?.seatNumber ?? localCurrent?.seatNumber ?? 0
                let isProtectedByLocalAction = sessionManager.isSeatProtectedByRecentLocalAction(
                    seatId: targetId,
                    seatNumber: resolvedSeatNum,
                    within: 15.0
                )
                let wasRunningWhenOpened = (cached?.isRunning == true) || (localCurrent?.isRunning == true)
                let wasStoppedRemotely = (wasRunningWhenOpened && (latest == nil || latest?.isRunning == false))
                if !isProtectedByLocalAction && (latest == nil || wasStoppedRemotely) {
                    selectHelpStaffTargetId = nil
                    pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "selectHelpStaff")
                    didAutoClose = true
                }
            }

            if let targetId = selectCheckStaffTargetId {
                let cached = pendingMainTimerSheetActionBox.cachedSheetItems["selectCheckStaff"]
                let latest = findMatchingReceivedSeat(targetId: targetId, cached: cached, in: receivedTimers)
                let localCurrent = findMatchingReceivedSeat(targetId: targetId, cached: cached, in: self.timers)
                let resolvedSeatNum = latest?.seatNumber ?? cached?.seatNumber ?? localCurrent?.seatNumber ?? 0
                let isProtectedByLocalAction = sessionManager.isSeatProtectedByRecentLocalAction(
                    seatId: targetId,
                    seatNumber: resolvedSeatNum,
                    within: 15.0
                )
                let wasRunningWhenOpened = (cached?.isRunning == true) || (localCurrent?.isRunning == true)
                let wasStoppedRemotely = (wasRunningWhenOpened && (latest == nil || latest?.isRunning == false))
                if !isProtectedByLocalAction && (latest == nil || wasStoppedRemotely) {
                    selectCheckStaffTargetId = nil
                    pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "selectCheckStaff")
                    didAutoClose = true
                }
            }
        }

        if pendingMainTimerSheetActionBox.action == nil && showingMainTimerSheet {
            let cachedMain = pendingMainTimerSheetActionBox.cachedMainTimerItem ?? self.mainTimer
            if let m = receivedMain {
                let wasMainActive = (cachedMain?.isRunning == true || cachedMain?.isPreCountingDown == true)
                let wasMainPausedNonZero = (cachedMain != nil && !wasMainActive && cachedMain?.isZero == false)
                if (wasMainActive && !m.isRunning && !m.isPreCountingDown) ||
                   (wasMainPausedNonZero && !m.isRunning && !m.isPreCountingDown && m.isZero) {
                    showingMainTimerSheet = false
                    mainTimerSheetInitialSubMode = nil
                    pendingMainTimerSheetActionBox.cachedMainTimerItem = nil
                    didAutoClose = true
                }
            }
        }

        if didAutoClose {
            pendingOvertimeSheetWorkItem?.cancel()
            pendingOvertimeSheetWorkItem = nil
            pendingMainTimerSheetActionBox.suppressOvertimeSheetUntil = Date().addingTimeInterval(1.5)
            if self.timers != receivedTimers && (!receivedTimers.isEmpty || timers.isEmpty) {
                self.timers = receivedTimers
            }
            if let m = receivedMain, self.mainTimer != m {
                self.mainTimer = m
            }
            WidgetSync.save(
                timers: self.timers,
                mainTimer: sessionManager.mainTimer ?? self.mainTimer,
                userName: currentUserName,
                forceReload: true
            )
            mapCrownFocusTrigger += 1
        }
        return didAutoClose
    }
    
    // ★ MainTimerActionSheet の dismiss() トランザクションと親画面の @State/@Published 更新が衝突しないようシート閉鎖後に実行（手首を下げる前にスマートアラーム予約を完了させる）
    //   watchOS のモーダルシート閉鎖アニメーション（約0.35秒）の途中で親 State を書き換えると View 階層破棄や dismiss() 無視が発生するため、
    //   通常は onDismiss で即実行し、万一 watchOS 側で dismiss() がドロップされた場合のみ 0.42秒後のフォールバックで強制閉鎖＆実行する。
    private func deferMainTimerSheetCloseAction(_ action: @escaping () -> Void) {
        pendingMainTimerSheetActionBox.suppressOvertimeSheetUntil = Date().addingTimeInterval(1.5)
        pendingOvertimeSheetWorkItem?.cancel()
        pendingOvertimeSheetWorkItem = nil
        pendingMainTimerSheetActionBox.mainCloseFallbackWorkItem?.cancel()
        pendingMainTimerSheetActionBox.action = action
        let fallback = DispatchWorkItem {
            self.pendingMainTimerSheetActionBox.mainCloseFallbackWorkItem = nil
            if self.showingMainTimerSheet {
                self.showingMainTimerSheet = false
            }
            self.pendingMainTimerSheetActionBox.cachedMainTimerItem = nil
            _ = self.executePendingMainTimerSheetAction()
        }
        pendingMainTimerSheetActionBox.mainCloseFallbackWorkItem = fallback
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.42, execute: fallback)
    }
    
    @discardableResult
    private func executePendingMainTimerSheetAction(clearSheetBindings: Bool = false) -> Bool {
        let hadPending = (pendingMainTimerSheetActionBox.action != nil || pendingMainTimerSheetActionBox.mainCloseFallbackWorkItem != nil)
        pendingMainTimerSheetActionBox.mainCloseFallbackWorkItem?.cancel()
        pendingMainTimerSheetActionBox.mainCloseFallbackWorkItem = nil
        if clearSheetBindings && hadPending {
            if self.showingMainTimerSheet {
                self.showingMainTimerSheet = false
            }
            self.pendingMainTimerSheetActionBox.cachedMainTimerItem = nil
        }
        if let action = pendingMainTimerSheetActionBox.action {
            pendingMainTimerSheetActionBox.action = nil
            action()
        }
        return hadPending
    }
    
    // ★ 客席タイマー操作シート（TimeActionSheet 等）を閉じるボタン操作時に、シート閉鎖トランザクションと親 `timers` 更新が衝突して固まるのを防ぐ遅延実行ヘルパー
    //   0.15秒（閉鎖アニメーション中）に親 `timers` を書き換えると TimeActionSheet 内のボタン階層がアニメーション途中で消滅し、
    //   さらに watchOS の dismiss() が中断されて数秒〜数十秒フリーズするため、onDismiss（または0.42秒後の強制閉鎖フォールバック）で実行する。
    private func deferSeatSheetCloseAction(_ action: @escaping () -> Void) {
        pendingMainTimerSheetActionBox.suppressOvertimeSheetUntil = Date().addingTimeInterval(1.5)
        pendingOvertimeSheetWorkItem?.cancel()
        pendingOvertimeSheetWorkItem = nil
        pendingMainTimerSheetActionBox.closeFallbackWorkItem?.cancel()
        pendingMainTimerSheetActionBox.seatSheetAction = action
        let fallback = DispatchWorkItem {
            self.pendingMainTimerSheetActionBox.closeFallbackWorkItem = nil
            if self.timeActionTargetId != nil { self.timeActionTargetId = nil }
            self.timeActionInitialBranchMode = false
            self.timeActionInitialSubCheckBranchMode = false
            if self.checkActionTargetId != nil { self.checkActionTargetId = nil }
            if self.shampooActionTargetId != nil { self.shampooActionTargetId = nil }
            if self.selectHelpStaffTargetId != nil { self.selectHelpStaffTargetId = nil }
            if self.selectCheckStaffTargetId != nil { self.selectCheckStaffTargetId = nil }
            if self.showingAddSeatSheet { self.showingAddSeatSheet = false }
            self.pendingMainTimerSheetActionBox.cachedSheetItems.removeAll()
            _ = self.executePendingSeatSheetAction()
        }
        pendingMainTimerSheetActionBox.closeFallbackWorkItem = fallback
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.42, execute: fallback)
    }
    
    @discardableResult
    private func executePendingSeatSheetAction(clearSheetBindings: Bool = false) -> Bool {
        let hadPending = (pendingMainTimerSheetActionBox.seatSheetAction != nil || pendingMainTimerSheetActionBox.closeFallbackWorkItem != nil)
        pendingMainTimerSheetActionBox.closeFallbackWorkItem?.cancel()
        pendingMainTimerSheetActionBox.closeFallbackWorkItem = nil
        if clearSheetBindings {
            pendingMainTimerSheetActionBox.chainedSheetWorkItem?.cancel()
            pendingMainTimerSheetActionBox.chainedSheetWorkItem = nil
            pendingOpenStandardSeatIdAfterAdd = nil
        }
        if clearSheetBindings && hadPending {
            if self.timeActionTargetId != nil { self.timeActionTargetId = nil }
            self.timeActionInitialBranchMode = false
            self.timeActionInitialSubCheckBranchMode = false
            if self.checkActionTargetId != nil { self.checkActionTargetId = nil }
            if self.shampooActionTargetId != nil { self.shampooActionTargetId = nil }
            if self.selectHelpStaffTargetId != nil { self.selectHelpStaffTargetId = nil }
            if self.selectCheckStaffTargetId != nil { self.selectCheckStaffTargetId = nil }
            if self.showingAddSeatSheet { self.showingAddSeatSheet = false }
            self.pendingMainTimerSheetActionBox.cachedSheetItems.removeAll()
        }
        if let action = pendingMainTimerSheetActionBox.seatSheetAction {
            pendingMainTimerSheetActionBox.seatSheetAction = nil
            if self.timers.isEmpty && !self.sessionManager.timers.isEmpty {
                self.timers = self.sessionManager.timers
            }
            action()
        }
        if clearSheetBindings {
            pendingMainTimerSheetActionBox.chainedSheetWorkItem?.cancel()
            pendingMainTimerSheetActionBox.chainedSheetWorkItem = nil
            pendingOpenStandardSeatIdAfterAdd = nil
        }
        return hadPending
    }
    
    // ★ 客席タイマー変更時にアラーム再構成と文字盤コンプリケーション同期を確実に実行する共通ヘルパー
    private func syncSeatTimersState(forceWidgetReload: Bool = true) {
        let currentMain = sessionManager.mainTimer ?? self.mainTimer
        WatchAlarmCoordinator.shared.update(
            timers: timers,
            mainTimer: currentMain,
            soundOn: sessionManager.alarmSoundEnabled,
            currentUserName: currentUserName
        )
        WidgetSync.save(
            timers: timers,
            mainTimer: currentMain,
            userName: currentUserName,
            forceReload: forceWidgetReload
        )
    }

    var body: some View {
        ZStack {
            NavigationStack {
                ZStack(alignment: .top) {
                    VStack(spacing: 4) {
                        if alarm.isBackgroundRefreshDisabled {
                            backgroundRefreshDisabledBanner
                        }
                        if let peerAlert = sessionManager.unconfirmedPeerAlerts.first {
                            peerConfirmationBannerView(peerAlert, totalCount: sessionManager.unconfirmedPeerAlerts.count)
                        }
                        if showingThumbnailMap {
                            thumbnailMapSheetView
                        } else {
                            cardsScrollView
                        }
                    }
                    
                    if let banner = notificationBannerText, sessionManager.unconfirmedPeerAlerts.isEmpty {
                        bannerView(banner)
                    }
                }
                .onChange(of: alarm.isBackgroundRefreshDisabled) { _, isDisabled in
                    if isDisabled {
                        showNotification(
                            text: "⚠️ Watchの「設定＞一般＞バックグラウンド更新＞AssistTimer」をONにしてください",
                            color: Color(hex: "#FF9F0A"),
                            playHapticFeedback: true
                        )
                    }
                }
                .onChange(of: timers) { _, newTimers in
                    if newTimers.contains(where: { $0.isRunning }) {
                        self.now = Date()
                    }
                    if pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync {
                        pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = false
                        return
                    }
                    alarm.update(timers: newTimers, mainTimer: sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                    WidgetSync.save(timers: newTimers, mainTimer: sessionManager.mainTimer, userName: currentUserName, forceReload: true)
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
                        if showingThumbnailMap {
                            mapCrownFocusTrigger += 1
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
                pendingMainTimerSheetActionBox.cachedMainTimerItem = nil
                let didExecutePending = executePendingMainTimerSheetAction()
                if let latestMain = sessionManager.mainTimer, self.mainTimer != latestMain {
                    self.mainTimer = latestMain
                }
                if self.timers != sessionManager.timers && !sessionManager.timers.isEmpty {
                    self.timers = sessionManager.timers
                }
                if !didExecutePending {
                    WidgetSync.save(timers: sessionManager.timers.isEmpty ? self.timers : sessionManager.timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                }
                mapCrownFocusTrigger += 1
            }) {
                mainTimerSheetView
            }
            // 新規席追加シート
            .sheet(isPresented: $showingAddSeatSheet, onDismiss: {
                let didExecutePending = executePendingSeatSheetAction()
                if let latestMain = sessionManager.mainTimer, self.mainTimer != latestMain {
                    self.mainTimer = latestMain
                }
                if self.timers != sessionManager.timers && !sessionManager.timers.isEmpty {
                    self.timers = sessionManager.timers
                }
                if !didExecutePending {
                    WidgetSync.save(timers: sessionManager.timers.isEmpty ? self.timers : sessionManager.timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                }
                if let targetId = scrollToSeatId {
                    triggerScroll(to: targetId)
                }
                mapCrownFocusTrigger += 1
                if let pendingSeatId = pendingOpenStandardSeatIdAfterAdd {
                    pendingOpenStandardSeatIdAfterAdd = nil
                    timeActionInitialBranchMode = false
                    timeActionInitialSubCheckBranchMode = false
                    pendingMainTimerSheetActionBox.chainedSheetWorkItem?.cancel()
                    let work = DispatchWorkItem {
                        self.pendingMainTimerSheetActionBox.chainedSheetWorkItem = nil
                        guard self.scenePhase == .active, self.alarm.ringing.isEmpty else { return }
                        if let targetSeat = self.sessionManager.timers.first(where: { $0.id == pendingSeatId }) ?? self.timers.first(where: { $0.id == pendingSeatId }) {
                            let prepared = self.prepareSheetTarget(for: targetSeat, cacheKey: "timeAction")
                            self.timeActionTargetId = prepared.id
                        } else {
                            self.timeActionTargetId = pendingSeatId
                        }
                    }
                    pendingMainTimerSheetActionBox.chainedSheetWorkItem = work
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
                }
            }) {
                addSeatSheetView
            }
            // タイム操作シート
            .sheet(item: bindingTimeAction, onDismiss: {
                timeActionInitialBranchMode = false
                timeActionInitialSubCheckBranchMode = false
                pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "timeAction")
                let didExecutePending = executePendingSeatSheetAction()
                if let latestMain = sessionManager.mainTimer, self.mainTimer != latestMain {
                    self.mainTimer = latestMain
                }
                if self.timers != sessionManager.timers && !sessionManager.timers.isEmpty {
                    self.timers = sessionManager.timers
                }
                if !didExecutePending {
                    WidgetSync.save(timers: sessionManager.timers.isEmpty ? self.timers : sessionManager.timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                }
                if let targetId = scrollToSeatId {
                    triggerScroll(to: targetId)
                }
                mapCrownFocusTrigger += 1
            }) { item in
                timeActionSheetView(item: item)
            }
            // チェック操作シート
            .sheet(item: bindingCheckAction, onDismiss: {
                pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "checkAction")
                let didExecutePending = executePendingSeatSheetAction()
                if let latestMain = sessionManager.mainTimer, self.mainTimer != latestMain {
                    self.mainTimer = latestMain
                }
                if self.timers != sessionManager.timers && !sessionManager.timers.isEmpty {
                    self.timers = sessionManager.timers
                }
                if !didExecutePending {
                    WidgetSync.save(timers: sessionManager.timers.isEmpty ? self.timers : sessionManager.timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                }
                mapCrownFocusTrigger += 1
            }) { item in
                checkActionSheetView(item: item)
            }
            // ★ シャンプー・施術操作シート
            .sheet(item: bindingShampooAction, onDismiss: {
                pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "shampooAction")
                let didExecutePending = executePendingSeatSheetAction()
                if let latestMain = sessionManager.mainTimer, self.mainTimer != latestMain {
                    self.mainTimer = latestMain
                }
                if self.timers != sessionManager.timers && !sessionManager.timers.isEmpty {
                    self.timers = sessionManager.timers
                }
                if !didExecutePending {
                    WidgetSync.save(timers: sessionManager.timers.isEmpty ? self.timers : sessionManager.timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                }
                mapCrownFocusTrigger += 1
            }) { item in
                shampooActionSheetView(item: item)
            }
            // ★ ヘルプ工程選択・スタッフ指定・募集シート
            .sheet(item: bindingSelectHelpStaff, onDismiss: {
                pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "selectHelpStaff")
                let didExecutePending = executePendingSeatSheetAction()
                if let latestMain = sessionManager.mainTimer, self.mainTimer != latestMain {
                    self.mainTimer = latestMain
                }
                if self.timers != sessionManager.timers && !sessionManager.timers.isEmpty {
                    self.timers = sessionManager.timers
                }
                if !didExecutePending {
                    WidgetSync.save(timers: sessionManager.timers.isEmpty ? self.timers : sessionManager.timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                }
                mapCrownFocusTrigger += 1
            }) { item in
                selectHelpWorkflowSheetView(item: item)
            }
            // ★ チェック担当スタッフ指定・募集シート
            .sheet(item: bindingSelectCheckStaff, onDismiss: {
                pendingMainTimerSheetActionBox.cachedSheetItems.removeValue(forKey: "selectCheckStaff")
                let didExecutePending = executePendingSeatSheetAction()
                if let latestMain = sessionManager.mainTimer, self.mainTimer != latestMain {
                    self.mainTimer = latestMain
                }
                if self.timers != sessionManager.timers && !sessionManager.timers.isEmpty {
                    self.timers = sessionManager.timers
                }
                if !didExecutePending {
                    WidgetSync.save(timers: sessionManager.timers.isEmpty ? self.timers : sessionManager.timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                }
                mapCrownFocusTrigger += 1
            }) { item in
                selectCheckStaffSheetView(item: item)
            }
            .onReceive(WatchRealtimeClock.shared.publisher) { input in
                // ★ モーダルシート表示中、または全タイマー停止＆非鳴動時は背面の ContentView.now を毎秒書き換えず不要な全画面再描画を防止
                let activeMain = sessionManager.mainTimer ?? self.mainTimer
                let hasActiveTimer = (activeMain?.isRunning == true) ||
                    (activeMain?.isPreCountingDown == true) ||
                    self.timers.contains(where: { $0.isRunning }) ||
                    sessionManager.timers.contains(where: { $0.isRunning })
                if (!isAnyModalSheetPresented && hasActiveTimer) || !alarm.ringing.isEmpty {
                    now = input
                }
                // ★ スマホ・他端末から停止されたタイマーの超過/操作シートが開いていた場合は自動で閉じて即座に 00:00 へ更新
                _ = handleRemoteModalSheetAutoCloseIfNeeded(
                    receivedTimers: sessionManager.timers,
                    receivedMain: sessionManager.mainTimer
                )
                // ★ システムアラームの「終了」等で WatchSessionManager 側が 00:00 リセットされた場合も、追加タップなしで即座に画面へ反映
                //   （mainTimer は showingMainTimerSheet の boolean バインディングであり item 変化による強制閉鎖を起こさないため常に即時同期する）
                if let latestMain = sessionManager.mainTimer, self.mainTimer != latestMain {
                    if !isAnyModalSheetPresented && (latestMain.isRunning || latestMain.isPreCountingDown) {
                        self.now = input
                    }
                    self.mainTimer = latestMain
                }
                if !isAnyModalSheetPresented {
                    if self.timers != sessionManager.timers {
                        if sessionManager.timers.contains(where: { $0.isRunning }) {
                            self.now = input
                        }
                        self.timers = sessionManager.timers
                    }
                }
                // ★ 準備中カウントダウンが0秒に到達したらローカルでも即座に本番タイマー稼働へ移行
                if var m = sessionManager.mainTimer ?? self.mainTimer,
                   m.isPreCountingDown,
                   let prepEnd = m.prepEndTime,
                   input >= prepEnd {
                    m.isPreCountingDown = false
                    m.preCountdownSeconds = 0
                    m.prepEndTime = nil
                    m.isRunning = true
                    let runSec = m.pausedRemainingSeconds > 0 ? m.pausedRemainingSeconds : m.totalSeconds
                    m.targetEndTime = prepEnd.addingTimeInterval(TimeInterval(runSec))
                    self.now = input
                    self.mainTimer = m
                    sessionManager.mainTimer = m
                    WidgetSync.save(timers: sessionManager.timers, mainTimer: m, userName: currentUserName, forceReload: true)
                    alarm.update(timers: sessionManager.timers, mainTimer: m, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                }
                if hasActiveTimer {
                    checkUnassignedHelpAlerts()
                }
                // ★ メインタイマーが終了時刻（00:00）に到達した際、自動で00:00に戻さず、
                //   「タイマーを止める」等が押されるまでは超過（カウントアップ）状態を継続する
            }
            .onReceive(alarm.$pendingOpenedAlarmEvent) { openedEvent in
                guard let ev = openedEvent else { return }
                handleOpenedAlarmEvent(ev)
            }
            .onReceive(sessionManager.$timers) { received in
                _ = handleRemoteModalSheetAutoCloseIfNeeded(
                    receivedTimers: received,
                    receivedMain: sessionManager.mainTimer
                )
                // ★ モーダルシート表示中（閉鎖アニメーション中を含む）は親 View の @State 再評価による閉鎖デッドロックを防ぐため onDismiss / scenePhase で同期
                if !isAnyModalSheetPresented && self.timers != received {
                    if received.contains(where: { $0.isRunning }) {
                        self.now = Date()
                    }
                    self.timers = received
                }
            }
            .onReceive(sessionManager.$mainTimer) { receivedMain in
                _ = handleRemoteModalSheetAutoCloseIfNeeded(
                    receivedTimers: sessionManager.timers,
                    receivedMain: receivedMain
                )
                if let receivedMain = receivedMain, self.mainTimer != receivedMain {
                    if !isAnyModalSheetPresented && (receivedMain.isRunning || receivedMain.isPreCountingDown) {
                        self.now = Date()
                    }
                    self.mainTimer = receivedMain
                }
            }
            .onReceive(sessionManager.$currentUserName) { receivedName in
                if !receivedName.isEmpty && self.currentUserName != receivedName {
                    self.currentUserName = receivedName
                    alarm.update(
                        timers: self.timers,
                        mainTimer: sessionManager.mainTimer ?? self.mainTimer,
                        soundOn: sessionManager.alarmSoundEnabled,
                        currentUserName: receivedName
                    )
                    WidgetSync.save(
                        timers: sessionManager.timers.isEmpty ? self.timers : sessionManager.timers,
                        mainTimer: sessionManager.mainTimer ?? self.mainTimer,
                        userName: receivedName,
                        forceReload: true
                    )
                }
            }
            .onReceive(sessionManager.$currentUserAliases) { _ in
                let activeTimers = sessionManager.timers.isEmpty ? self.timers : sessionManager.timers
                alarm.update(
                    timers: activeTimers,
                    mainTimer: sessionManager.mainTimer ?? self.mainTimer,
                    soundOn: sessionManager.alarmSoundEnabled,
                    currentUserName: self.currentUserName
                )
                WidgetSync.save(
                    timers: activeTimers,
                    mainTimer: sessionManager.mainTimer ?? self.mainTimer,
                    userName: self.currentUserName,
                    forceReload: true
                )
            }
            .onReceive(sessionManager.$incomingNotification) { notif in
                if let notif = notif {
                    showNotification(
                        text: notif.text,
                        color: Color(hex: notif.color),
                        playHapticFeedback: true,
                        isRemotePeer: true,
                        isGentleInfo: notif.eventType.hasPrefix("unassign_")
                    )
                    sessionManager.incomingNotification = nil
                }
            }
            .onChange(of: isAnyModalSheetPresented) { _, isPresented in
                sessionManager.isModalSheetCurrentlyPresented = isPresented
                if isPresented {
                    // ★ シートオープン中に背面の3.2秒消去タイマーが発火して親ViewのwithAnimation再評価を引き起こすのを完全防止
                    notificationDismissWorkItem?.cancel()
                    notificationDismissWorkItem = nil
                    if notificationBannerText != nil {
                        notificationBannerText = nil
                    }
                } else {
                    self.now = Date()
                    if let pending = pendingRemotePeerBanner {
                        pendingRemotePeerBanner = nil
                        if Date().timeIntervalSince(pending.receivedAt) <= 12.0 {
                            showNotification(
                                text: pending.text,
                                color: pending.color,
                                playHapticFeedback: false,
                                isRemotePeer: true
                            )
                        }
                    }
                }
            }
            .onAppear {
                sessionManager.syncFromLatestApplicationContextIfNewer()
                sessionManager.requestSyncFromPhone()
                sessionManager.pollCloudTimersFromSupabaseIfNeeded(force: true)
                if let initialMain = sessionManager.mainTimer {
                    self.mainTimer = initialMain
                }
                if !isAnyModalSheetPresented && self.timers != sessionManager.timers && !sessionManager.timers.isEmpty {
                    self.timers = sessionManager.timers
                }
                let activeTimers = sessionManager.timers.isEmpty ? timers : sessionManager.timers
                WidgetSync.save(timers: activeTimers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                alarm.update(timers: activeTimers, mainTimer: sessionManager.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                // ★ 初回起動時は一覧（サロン客席マップ）をインラインで直接表示（モーダルシート競合によるブラックアウトも完全根絶）
                if !hasInitialOpenedMap {
                    hasInitialOpenedMap = true
                    showingThumbnailMap = true
                }
                if !alarm.ringing.isEmpty {
                    dismissAllSheetsForAlarm()
                }
            }
            .onChange(of: scenePhase) { _, newPhase in
                // ★ デジタルクラウン（トグルスイッチ）を押して文字盤へ戻る際やフォアグラウンド復帰時に、
                //   シート閉鎖待ちのアクションが残っていれば即座に確定・実行した上で、
                //   文字盤モジュール画面（コンプリケーション）を必ず最新の00:00／稼働状態へ同期即リロードする
                if newPhase != .active {
                    _ = executePendingMainTimerSheetAction(clearSheetBindings: true)
                    _ = executePendingSeatSheetAction(clearSheetBindings: true)
                } else {
                    sessionManager.syncFromLatestApplicationContextIfNewer()
                    sessionManager.advanceMainTimerPreCountdownIfNeeded()
                    sessionManager.pollCloudTimersFromSupabaseIfNeeded(force: true)
                }
                if newPhase != .active || !isAnyModalSheetPresented {
                    if let latestMain = sessionManager.mainTimer, self.mainTimer != latestMain {
                        self.mainTimer = latestMain
                    }
                    if self.timers != sessionManager.timers && !sessionManager.timers.isEmpty {
                        self.timers = sessionManager.timers
                    }
                }
                let currentMain = sessionManager.mainTimer ?? self.mainTimer
                let currentTimers = sessionManager.timers.isEmpty ? self.timers : sessionManager.timers
                WidgetSync.save(
                    timers: currentTimers,
                    mainTimer: currentMain,
                    userName: currentUserName,
                    forceReload: true
                )
                // ★ アプリアイコン・ドック・デジタルクラウン等からWatchアプリをアクティブにした際も、
                //   超過タイム（+00:xx）が継続中かつシート未表示であれば即座に「タイマーを止める」画面を自動表示する
                if newPhase == .active,
                   alarm.pendingOpenedAlarmEvent == nil,
                   !isAnyModalSheetPresented {
                    presentOvertimeActionSheetIfNeeded(currentMain: currentMain, currentTimers: currentTimers)
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

    private enum OvertimeSheetTarget {
        case mainTimer
        case seatCheck(id: String)
        case seatMain(id: String)
    }

    private func isSameSeatTarget(_ currentTargetId: String?, as seat: SeatTimerItem) -> Bool {
        guard let cur = currentTargetId, !cur.isEmpty else { return false }
        if cur == seat.id || cur == "seat-\(seat.seatNumber)" { return true }
        if let cached = pendingMainTimerSheetActionBox.cachedSheetItems["timeAction"],
           cached.id == cur,
           (cached.seatNumber == seat.seatNumber || cached.id == seat.id) {
            return true
        }
        return false
    }

    // ★ 超過中（+00:xx）のタイマーが存在する場合に「⏹️ タイマーを止める」が最上部に配置された操作画面を即座に開く共通ヘルパー
    //   1. URL等で特定席（またはメインタイマー）が指定されていて超過中ならその対象を最優先
    //   2. 複数タイマーが同時に超過中の場合は、最も新しくタイムアップした（終了時刻が直近の）タイマーを最優先
    //   handleOpenURL と scenePhase == .active が連続発火した際も WorkItem をキャンセル・1本化して二重発火を防止する
    private func presentOvertimeActionSheetIfNeeded(currentMain: SeatTimerItem?, currentTimers: [SeatTimerItem], preferredSeatId: String? = nil, delayOverride: TimeInterval? = nil) {
        pendingOvertimeSheetWorkItem?.cancel()
        pendingOvertimeSheetWorkItem = nil
        guard Date() >= pendingMainTimerSheetActionBox.suppressOvertimeSheetUntil else { return }

        var candidates: [(target: OvertimeSheetTarget, seatId: String, expiredAt: Date)] = []
        if let m = currentMain, m.isOvertime {
            candidates.append((target: .mainTimer, seatId: "main-timer", expiredAt: m.targetEndTime))
        }
        for t in currentTimers {
            if t.isOvertime && t.shouldAlertMainTimer(for: currentUserName) {
                candidates.append((target: .seatMain(id: t.id), seatId: t.id, expiredAt: t.targetEndTime))
            } else if t.isCheckOvertime && !t.isOvertime && t.shouldAlertCheckTimer(for: currentUserName) {
                candidates.append((target: .seatCheck(id: t.id), seatId: t.id, expiredAt: t.checkTargetEndTime ?? t.targetEndTime))
            }
        }
        guard !candidates.isEmpty else { return }

        let chosen: (target: OvertimeSheetTarget, seatId: String, expiredAt: Date) = {
            if let pref = preferredSeatId, !pref.isEmpty {
                if pref == "main-timer", let mainCand = candidates.first(where: { $0.seatId == "main-timer" }) {
                    return mainCand
                }
                let resolvedPrefId = findSeatIndex(seatId: pref, title: "").map { self.timers[$0].id }
                    ?? currentTimers.first(where: { $0.id == pref || "seat-\($0.seatNumber)" == pref || String($0.seatNumber) == pref })?.id
                    ?? pref
                if let seatCand = candidates.first(where: { $0.seatId == resolvedPrefId }) {
                    return seatCand
                }
            }
            return candidates.max(by: { $0.expiredAt < $1.expiredAt }) ?? candidates[0]
        }()

        let delay = delayOverride ?? (isAnyModalSheetPresented ? 0.45 : 0.08)

        switch chosen.target {
        case .mainTimer:
            mainTimerSheetInitialSubMode = .timerActionBranch
            if showingMainTimerSheet {
                return
            }
            let work = DispatchWorkItem {
                self.pendingOvertimeSheetWorkItem = nil
                guard self.alarm.ringing.isEmpty, Date() >= self.pendingMainTimerSheetActionBox.suppressOvertimeSheetUntil else { return }
                let latestMain = self.sessionManager.mainTimer ?? self.mainTimer
                guard latestMain?.isOvertime == true else { return }
                self.mainTimerSheetInitialSubMode = .timerActionBranch
                if !self.showingMainTimerSheet {
                    self.showingMainTimerSheet = true
                }
            }
            pendingOvertimeSheetWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        case .seatCheck(let targetId):
            triggerScroll(to: targetId)
            if let targetSeat = currentTimers.first(where: { $0.id == targetId || "seat-\($0.seatNumber)" == targetId }),
               isSameSeatTarget(timeActionTargetId, as: targetSeat) {
                timeActionInitialBranchMode = false
                timeActionInitialSubCheckBranchMode = true
                return
            }
            let work = DispatchWorkItem {
                self.pendingOvertimeSheetWorkItem = nil
                guard self.alarm.ringing.isEmpty, Date() >= self.pendingMainTimerSheetActionBox.suppressOvertimeSheetUntil else { return }
                let activeTimers = self.sessionManager.timers.isEmpty ? self.timers : self.sessionManager.timers
                guard let latestSeat = activeTimers.first(where: { $0.id == targetId || "seat-\($0.seatNumber)" == targetId }),
                      latestSeat.isCheckOvertime,
                      !latestSeat.isOvertime,
                      latestSeat.shouldAlertCheckTimer(for: self.currentUserName) else { return }
                self.timeActionInitialBranchMode = false
                self.timeActionInitialSubCheckBranchMode = true
                if !self.isSameSeatTarget(self.timeActionTargetId, as: latestSeat) {
                    let prepared = self.prepareSheetTarget(for: latestSeat, cacheKey: "timeAction")
                    self.timeActionTargetId = prepared.id
                }
            }
            pendingOvertimeSheetWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        case .seatMain(let targetId):
            triggerScroll(to: targetId)
            if let targetSeat = currentTimers.first(where: { $0.id == targetId || "seat-\($0.seatNumber)" == targetId }),
               isSameSeatTarget(timeActionTargetId, as: targetSeat) {
                timeActionInitialBranchMode = true
                timeActionInitialSubCheckBranchMode = false
                return
            }
            let work = DispatchWorkItem {
                self.pendingOvertimeSheetWorkItem = nil
                guard self.alarm.ringing.isEmpty, Date() >= self.pendingMainTimerSheetActionBox.suppressOvertimeSheetUntil else { return }
                let activeTimers = self.sessionManager.timers.isEmpty ? self.timers : self.sessionManager.timers
                guard let latestSeat = activeTimers.first(where: { $0.id == targetId || "seat-\($0.seatNumber)" == targetId }),
                      latestSeat.isOvertime,
                      latestSeat.shouldAlertMainTimer(for: self.currentUserName) else { return }
                self.timeActionInitialBranchMode = true
                self.timeActionInitialSubCheckBranchMode = false
                if !self.isSameSeatTarget(self.timeActionTargetId, as: latestSeat) {
                    let prepared = self.prepareSheetTarget(for: latestSeat, cacheKey: "timeAction")
                    self.timeActionTargetId = prepared.id
                }
            }
            pendingOvertimeSheetWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }

    // ★ コンプリケーション（モジュラー文字盤）等からのURL起動ハンドラ（bodyの型推論負荷を軽減するため分離）
    private func handleOpenURL(_ url: URL) {
        sessionManager.syncFromLatestApplicationContextIfNewer()
        pendingOvertimeSheetWorkItem?.cancel()
        pendingOvertimeSheetWorkItem = nil
        pendingMainTimerSheetActionBox.chainedSheetWorkItem?.cancel()
        pendingMainTimerSheetActionBox.chainedSheetWorkItem = nil
        pendingOpenStandardSeatIdAfterAdd = nil
        _ = executePendingMainTimerSheetAction(clearSheetBindings: true)
        _ = executePendingSeatSheetAction(clearSheetBindings: true)
        pendingMainTimerSheetActionBox.suppressOvertimeSheetUntil = .distantPast
        // ★ モジュラー文字盤タップ時: 未消火アラームがあればアラーム振動・音のみ消火し、本タイマーも中間チェックも超過カウントアップは止めない
        if !alarm.ringing.isEmpty {
            alarm.stop(sendToPhone: false, completeCheckIfNeeded: false)
        }
        // コールドスタート・バックグラウンド復帰直後でも sessionManager の最新状態を即座に反映
        if let latestMain = sessionManager.mainTimer {
            self.mainTimer = latestMain
        }
        if self.timers != sessionManager.timers && !sessionManager.timers.isEmpty {
            self.timers = sessionManager.timers
        }
        let currentMain = sessionManager.mainTimer ?? self.mainTimer
        let currentTimers = sessionManager.timers.isEmpty ? self.timers : sessionManager.timers

        var preferredOvertimeSeatId: String? = nil
        if url.host == "main" {
            preferredOvertimeSeatId = "main-timer"
        }
        if url.host == "list" {
            showingThumbnailMap = false
        } else {
            // モジュラー文字盤タップ（open-map / open / main / seat 等の全コンプリケーションURL）では一覧画面を開く
            showingThumbnailMap = true
            if url.host == "seat",
               let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
               let seatId = components.queryItems?.first(where: { $0.name == "id" })?.value,
               !seatId.isEmpty {
                preferredOvertimeSeatId = seatId
                triggerScroll(to: seatId)
            }
        }

        // ★ 既に同じ対象（同一客席またはメインタイマー）のシートが表示中であれば、シートを閉じて0.08秒後に開き直すトランザクション衝突を避け、そのまま維持する
        var targetOvertimeSeat: SeatTimerItem? = nil
        var isTargetMainOvertime = false
        if preferredOvertimeSeatId == "main-timer", currentMain?.isOvertime == true {
            isTargetMainOvertime = true
        } else if let pref = preferredOvertimeSeatId, !pref.isEmpty,
                  let matched = currentTimers.first(where: { $0.id == pref || "seat-\($0.seatNumber)" == pref || String($0.seatNumber) == pref }),
                  ((matched.isOvertime && matched.shouldAlertMainTimer(for: currentUserName)) || (matched.isCheckOvertime && !matched.isOvertime && matched.shouldAlertCheckTimer(for: currentUserName))) {
            targetOvertimeSeat = matched
        } else {
            let mainExp = (currentMain?.isOvertime == true) ? currentMain?.targetEndTime : nil
            let seatCands = currentTimers.filter {
                ($0.isOvertime && $0.shouldAlertMainTimer(for: currentUserName)) ||
                ($0.isCheckOvertime && !$0.isOvertime && $0.shouldAlertCheckTimer(for: currentUserName))
            }
            let latestSeatCand = seatCands.max { a, b in
                let aExp = a.isOvertime ? a.targetEndTime : (a.checkTargetEndTime ?? a.targetEndTime)
                let bExp = b.isOvertime ? b.targetEndTime : (b.checkTargetEndTime ?? b.targetEndTime)
                return aExp < bExp
            }
            if let mExp = mainExp, let sCand = latestSeatCand {
                let sExp = sCand.isOvertime ? sCand.targetEndTime : (sCand.checkTargetEndTime ?? sCand.targetEndTime)
                if mExp >= sExp {
                    isTargetMainOvertime = true
                } else {
                    targetOvertimeSeat = sCand
                }
            } else if mainExp != nil {
                isTargetMainOvertime = true
            } else {
                targetOvertimeSeat = latestSeatCand
            }
        }

        let wasAnySheetPresented = isAnyModalSheetPresented
        if isTargetMainOvertime && showingMainTimerSheet {
            mainTimerSheetInitialSubMode = .timerActionBranch
            WidgetSync.save(timers: currentTimers, mainTimer: currentMain, userName: currentUserName, forceReload: true)
            return
        }
        if let targetSeat = targetOvertimeSeat, isSameSeatTarget(timeActionTargetId, as: targetSeat) {
            timeActionInitialBranchMode = targetSeat.isOvertime
            timeActionInitialSubCheckBranchMode = targetSeat.isCheckOvertime && !targetSeat.isOvertime
            WidgetSync.save(timers: currentTimers, mainTimer: currentMain, userName: currentUserName, forceReload: true)
            return
        }

        // 別のシートが開いていた場合はすべて閉じてから十分なアニメーション完了待機（0.45秒）後に開く
        pendingMainTimerSheetActionBox.cachedSheetItems.removeAll()
        pendingMainTimerSheetActionBox.cachedMainTimerItem = nil
        showingMainTimerSheet = false
        showingAddSeatSheet = false
        timeActionTargetId = nil
        timeActionInitialBranchMode = false
        timeActionInitialSubCheckBranchMode = false
        checkActionTargetId = nil
        shampooActionTargetId = nil
        selectHelpStaffTargetId = nil
        selectCheckStaffTargetId = nil

        WidgetSync.save(timers: currentTimers, mainTimer: currentMain, userName: currentUserName, forceReload: true)

        // ★ システムアラーム終了後など、超過タイム（+00:xx）が継続中に文字盤モジュール画面をタップした時は、
        //   即座に「タイマーを止める」ボタンがある操作画面（.timerActionBranch / .subCheckActionBranch）を表示してワンタップで止められるようにする！
        presentOvertimeActionSheetIfNeeded(
            currentMain: currentMain,
            currentTimers: currentTimers,
            preferredSeatId: preferredOvertimeSeatId,
            delayOverride: wasAnySheetPresented ? 0.45 : 0.08
        )
    }

    // ★ システムのスマートアラーム画面（「"AssistTimer" からのアラームです。 [開く] [終了]」）で
    //   左側の「開く」を押した時の分岐遷移ハンドラ:
    //   超過カウントアップ（+00:xx）を表示したまま、「タイマーを止める」「シャンプーに入る」「時間延長」等の操作画面へ即座に移行する！
    private func handleOpenedAlarmEvent(_ event: WatchAlarmEvent) {
        pendingOvertimeSheetWorkItem?.cancel()
        pendingOvertimeSheetWorkItem = nil
        _ = executePendingMainTimerSheetAction(clearSheetBindings: true)
        _ = executePendingSeatSheetAction(clearSheetBindings: true)
        pendingMainTimerSheetActionBox.suppressOvertimeSheetUntil = Date().addingTimeInterval(1.5)
        alarm.clearPendingOpenedAlarmEvent()
        if let latestMain = sessionManager.mainTimer {
            self.mainTimer = latestMain
        }
        if self.timers != sessionManager.timers && !sessionManager.timers.isEmpty {
            self.timers = sessionManager.timers
        }

        let wasAnySheetPresented = isAnyModalSheetPresented
        if event.seatId == "main-timer" {
            mainTimerSheetInitialSubMode = .timerActionBranch
            if showingMainTimerSheet {
                return
            }
            pendingMainTimerSheetActionBox.cachedSheetItems.removeAll()
            pendingMainTimerSheetActionBox.cachedMainTimerItem = nil
            showingAddSeatSheet = false
            timeActionTargetId = nil
            checkActionTargetId = nil
            shampooActionTargetId = nil
            selectHelpStaffTargetId = nil
            selectCheckStaffTargetId = nil
            let delay: TimeInterval = wasAnySheetPresented ? 0.45 : 0.08
            let work = DispatchWorkItem {
                self.pendingOvertimeSheetWorkItem = nil
                self.mainTimerSheetInitialSubMode = .timerActionBranch
                self.showingMainTimerSheet = true
            }
            pendingOvertimeSheetWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        } else {
            let isCheck = event.key.contains("-check@")
            let activeTimers = sessionManager.timers.isEmpty ? self.timers : sessionManager.timers
            let matchedSeat = findSeatIndex(seatId: event.seatId, title: event.title).map { self.timers[$0] }
                ?? activeTimers.first(where: { $0.id == event.seatId || "seat-\($0.seatNumber)" == event.seatId })
            let resolvedSeatId = matchedSeat?.id ?? event.seatId
            triggerScroll(to: resolvedSeatId)
            timeActionInitialBranchMode = !isCheck
            timeActionInitialSubCheckBranchMode = isCheck
            if let seat = matchedSeat, isSameSeatTarget(timeActionTargetId, as: seat) {
                return
            }
            pendingMainTimerSheetActionBox.cachedSheetItems.removeAll()
            pendingMainTimerSheetActionBox.cachedMainTimerItem = nil
            showingMainTimerSheet = false
            showingAddSeatSheet = false
            timeActionTargetId = nil
            checkActionTargetId = nil
            shampooActionTargetId = nil
            selectHelpStaffTargetId = nil
            selectCheckStaffTargetId = nil
            let delay: TimeInterval = wasAnySheetPresented ? 0.45 : 0.08
            let work = DispatchWorkItem {
                self.pendingOvertimeSheetWorkItem = nil
                self.timeActionInitialBranchMode = !isCheck
                self.timeActionInitialSubCheckBranchMode = isCheck
                let latestTimers = self.sessionManager.timers.isEmpty ? self.timers : self.sessionManager.timers
                if let latestSeat = latestTimers.first(where: { $0.id == resolvedSeatId || "seat-\($0.seatNumber)" == resolvedSeatId }) {
                    let prepared = self.prepareSheetTarget(for: latestSeat, cacheKey: "timeAction")
                    self.timeActionTargetId = prepared.id
                } else {
                    self.timeActionTargetId = resolvedSeatId
                }
            }
            pendingOvertimeSheetWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
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
            
            Text(sessionManager.isSalonOwner ? "📱 iPhoneで席を追加してください" : "📱 招待元の席データを同期中")
                .font(.system(size: 13, weight: .bold))
                .foregroundColor(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
                .multilineTextAlignment(.center)
            
            Text("サロンワーク画面の客席と\n自動でリアルタイム連動します")
                .font(.system(size: 11))
                .foregroundColor(Color(hex: "#8E8E93"))
                .minimumScaleFactor(0.8)
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
    
    private static let diagDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    private func diagTime(_ date: Date?) -> String {
        guard let date = date else { return "--:--:--" }
        return Self.diagDateFormatter.string(from: date)
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
        if firstEvent.seatId == "main-timer" || firstEvent.seatId == (sessionManager.mainTimer ?? self.mainTimer)?.id {
            // メインタイマーにはシャンプー・コーミング等の工程概念がないため、常に「タイマーを止める」のみを表示
            return nil
        }
        guard let seatIdx = findSeatIndex(seatId: firstEvent.seatId, title: firstEvent.title) else { return nil }
        let seat = timers[seatIdx]
        
        let isCheckAlarm = firstEvent.key.contains("-check@")
        if isCheckAlarm {
            // 中間チェックタイマーのアラーム: subCheckStopAndHelpButtons と統一し、
            // 明示的にチェック工程（コーミング・1液2液・担当を呼ぶ）または担当者が指定されている場合のみ工程連動ボタンを表示する
            // （未選択時は余計なボタンを出さず、赤い「タイマーを止める」のみを表示して1タップでチェックのみ完了・本タイマー継続）
            let checkProc = seat.displayCheckProcess
            let hasExplicitCheckHelp = (checkProc != "チェック") || !(seat.checkStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if hasExplicitCheckHelp {
                return (item: seat, action: .check(isCheckOnly: true))
            }
            return nil
        }
        
        // 全体タイマー・メインタイマーのアラーム: 終了後メニュー指定項目に連動（ヘルプなし・未指定ならnil）
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

    // ★ 全画面アラーム（alarmOverlay）の赤い「タイマーを止める」ボタン共通処理:
    //   - チェックタイマー単独鳴動（-check@）時は、対象席のチェックのみ完了消火し、大元タイマーは絶対に止めず席カードも閉じない（isCollapsed = false 維持）
    //   - 大元の共有タイマー鳴動（-main@）時は、対象席のみ 00:00 リセット＆席カードを閉じる（isCollapsed = true）
    //   - 個人メインタイマー鳴動（main-timer）時は、個人メインタイマーのみ 00:00 リセット
    private func handleStopButtonInAlarmOverlay() {
        let ringingSnapshot = alarm.ringing
        if let firstEv = ringingSnapshot.first {
            if firstEv.key.contains("-check@") {
                if let idx = findSeatIndex(seatId: firstEv.seatId, title: firstEv.title) {
                    let actualSeatId = timers[idx].id
                    let actualSeatNum = timers[idx].seatNumber
                    let seatName = timers[idx].displaySeatName
                    let checkProc = timers[idx].displayCheckProcess
                    let clearedCheckEnd = timers[idx].checkTargetEndTime ?? firstEv.date
                    alarm.acknowledgeSeatTimer(seatId: actualSeatId, seatNumber: actualSeatNum, checkOnly: true, skipRefresh: true)
                    if firstEv.seatId != actualSeatId {
                        alarm.acknowledgeSeatTimer(seatId: firstEv.seatId, seatNumber: actualSeatNum, checkOnly: true, skipRefresh: true)
                    }
                    sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                    sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: false)
                    if firstEv.seatId != actualSeatId {
                        sessionManager.markLocalCheckClear(seatId: firstEv.seatId, checkEndTime: clearedCheckEnd)
                        sessionManager.setCollapseOverride(seatId: firstEv.seatId, collapsed: false)
                    }
                    pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                        timers[idx].isCheckCompleted = true
                        timers[idx].checkStaff = currentUserName
                        timers[idx].checkTargetEndTime = nil
                        timers[idx].checkTotalSeconds = nil
                        timers[idx].isCollapsed = false
                    }
                    sessionManager.timers = timers
                    WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                        seatId: actualSeatId,
                        timers: timers,
                        mainTimer: sessionManager.mainTimer ?? self.mainTimer,
                        soundOn: sessionManager.alarmSoundEnabled,
                        currentUserName: currentUserName
                    )
                    sessionManager.sendActionToPhone(action: "COMPLETE_CHECK", seatId: actualSeatId)
                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                    showNotification(text: "✅ 【\(seatName)】\(checkProc)完了（タイマー続行）", color: Color(hex: "#30D158"))
                } else {
                    alarm.stop(explicitTarget: firstEv)
                    if self.timers != sessionManager.timers {
                        self.timers = sessionManager.timers
                    }
                    WidgetSync.save(timers: self.timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                }
                WKInterfaceDevice.current().play(.success)
                return
            }

            let isPersonalMain = (firstEv.seatId == "main-timer" || firstEv.seatId == (sessionManager.mainTimer ?? self.mainTimer)?.id)
            if isPersonalMain {
                handleResetMainTimer(playHapticFeedback: false)
                alarm.stop(sendToPhone: false, explicitTarget: firstEv)
            } else {
                alarm.stop(explicitTarget: firstEv)
                if let sm = sessionManager.mainTimer {
                    self.mainTimer = sm
                }
            }
            if self.timers != sessionManager.timers {
                self.timers = sessionManager.timers
            }
            WidgetSync.save(timers: self.timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
            WKInterfaceDevice.current().play(.success)
            return
        }

        let hadMain = alarm.isMainTimerRingingOrDue
        if hadMain {
            handleResetMainTimer(playHapticFeedback: false)
            alarm.stop(sendToPhone: false)
        } else {
            alarm.stop()
            if let sm = sessionManager.mainTimer {
                self.mainTimer = sm
            }
        }
        if self.timers != sessionManager.timers {
            self.timers = sessionManager.timers
        }
        WidgetSync.save(timers: self.timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
        WKInterfaceDevice.current().play(.success)
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
                        let overSec = max(0, safeClampedSeconds(now.timeIntervalSince(e.date)))
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
                    // ① 内容連動ボタン（シャンプーに入る／チェックに入る等 ※客席タイマーのみ）
                    switch ringingInfo.action {
                    case .check(let isCheckOnly):
                        let checkProc = isCheckOnly ? ringingInfo.item.displayCheckProcess : "チェック"
                        let checkIcon = isCheckOnly ? ringingInfo.item.checkProcessIconName : "magnifyingglass"
                        let checkBtnLabel: String = isCheckOnly
                            ? ((checkProc == "担当を呼ぶ") ? "担当を呼ぶ（タイマー続行）" : "\(checkProc)に入る（タイマー続行）")
                            : "チェックに入る"
                        let checkBtnColors: [Color] = {
                            guard isCheckOnly else { return [Color(hex: "#30D158"), Color(hex: "#248A3D")] }
                            switch checkProc {
                            case "コーミング": return [Color(hex: "#0A84FF"), Color(hex: "#0062D2")]
                            case "1液2液": return [Color(hex: "#BF5AF2"), Color(hex: "#8E44AD")]
                            case "担当を呼ぶ": return [Color(hex: "#FF9F0A"), Color(hex: "#FF8000")]
                            default: return [Color(hex: "#30D158"), Color(hex: "#248A3D")]
                            }
                        }()
                        Button(action: {
                            WKInterfaceDevice.current().play(.success)
                            if let idx = findSeatIndex(for: ringingInfo.item) {
                                let actualSeatId = timers[idx].id
                                let actualSeatNum = timers[idx].seatNumber
                                alarm.acknowledgeSeatTimer(seatId: actualSeatId, seatNumber: actualSeatNum, checkOnly: isCheckOnly, skipRefresh: true)
                                if ringingInfo.item.id != actualSeatId {
                                    alarm.acknowledgeSeatTimer(seatId: ringingInfo.item.id, seatNumber: actualSeatNum, checkOnly: isCheckOnly, skipRefresh: true)
                                }
                                let clearedCheckEnd = timers[idx].checkTargetEndTime
                                sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                                if ringingInfo.item.id != actualSeatId {
                                    sessionManager.markLocalCheckClear(seatId: ringingInfo.item.id, checkEndTime: clearedCheckEnd)
                                }
                                pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                                if isCheckOnly {
                                    // ★ チェックタイマーのみ停止・完了（全体のタイマーは止まらない！席カードも閉じない！残りの全体タイマーを新しいタイマーとして入れ直す）
                                    let preservedCheckSec = max(60, timers[idx].checkTotalSeconds ?? ringingInfo.item.checkTotalSeconds ?? 60)
                                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                        timers[idx].isCheckCompleted = true
                                        timers[idx].checkStaff = currentUserName
                                        timers[idx].checkTargetEndTime = nil
                                        timers[idx].checkTotalSeconds = nil
                                        timers[idx].isCollapsed = false
                                    }
                                    sessionManager.timers = timers
                                    sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: false)
                                    if ringingInfo.item.id != actualSeatId {
                                        sessionManager.setCollapseOverride(seatId: ringingInfo.item.id, collapsed: false)
                                    }
                                    WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                                        seatId: actualSeatId,
                                        timers: timers,
                                        mainTimer: sessionManager.mainTimer ?? self.mainTimer,
                                        soundOn: sessionManager.alarmSoundEnabled,
                                        currentUserName: currentUserName
                                    )
                                    sessionManager.sendActionToPhone(action: "COMPLETE_CHECK", seatId: actualSeatId, extra: ["checkTotalSeconds": preservedCheckSec])
                                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                                    showNotification(
                                        text: "✅ 【\(ringingInfo.item.displaySeatName)】\(checkProc)完了（タイマー続行）",
                                        color: Color(hex: "#30D158")
                                    )
                                } else {
                                    // ★ 全体タイマーのチェック: シャンプー等と同様に大元もチェックもすべて00:00停止し、席カードを閉じる
                                    let stoppedEndTime = timers[idx].targetEndTime
                                    let expectedEndMs = timers[idx].expectedEndMs
                                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                        timers[idx].isRunning = false
                                        timers[idx].pausedRemainingSeconds = 0
                                        timers[idx].totalSeconds = 0
                                        timers[idx].status = .check
                                        timers[idx].helpProcess = "チェック"
                                        timers[idx].shampooStaff = currentUserName
                                        timers[idx].isRecruiting = false
                                        timers[idx].isNoHelpNeeded = false
                                        timers[idx].clearCheck()
                                        timers[idx].isCollapsed = true
                                    }
                                    sessionManager.timers = timers
                                    sessionManager.markLocalStop(seatId: actualSeatId, endTime: stoppedEndTime)
                                    sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: true)
                                    if ringingInfo.item.id != actualSeatId {
                                        sessionManager.markLocalStop(seatId: ringingInfo.item.id, endTime: stoppedEndTime)
                                        sessionManager.setCollapseOverride(seatId: ringingInfo.item.id, collapsed: true)
                                    }
                                    WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                                    sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: actualSeatId, extra: ["expectedEnd": expectedEndMs, "isCompleted": true, "helpProcess": "チェック"])
                                    WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                                    showNotification(
                                        text: "✅ 【\(ringingInfo.item.displaySeatName)】自分がチェックに入りました",
                                        color: Color(hex: "#30D158")
                                    )
                                }
                            } else {
                                alarm.acknowledgeSeatTimer(seatId: ringingInfo.item.id, seatNumber: ringingInfo.item.seatNumber, checkOnly: isCheckOnly, skipRefresh: false)
                            }
                        }) {
                            HStack(spacing: 5) {
                                Image(systemName: checkIcon)
                                    .font(.system(size: 13, weight: .heavy))
                                Text(checkBtnLabel)
                                    .font(.system(size: 14, weight: .heavy))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(
                                LinearGradient(
                                    colors: checkBtnColors,
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                            .foregroundColor(.white)
                            .cornerRadius(12)
                            .shadow(color: checkBtnColors.first?.opacity(0.35) ?? Color(hex: "#30D158").opacity(0.35), radius: 3, x: 0, y: 1)
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal, 4)
                        
                    case .shampoo(let label):
                        Button(action: {
                            WKInterfaceDevice.current().play(.success)
                            if let idx = findSeatIndex(for: ringingInfo.item) {
                                let actualSeatId = timers[idx].id
                                let actualSeatNum = timers[idx].seatNumber
                                let stoppedEndTime = timers[idx].targetEndTime
                                let expectedEndMs = timers[idx].expectedEndMs
                                let clearedCheckEnd = timers[idx].checkTargetEndTime
                                alarm.acknowledgeSeatTimer(seatId: actualSeatId, seatNumber: actualSeatNum, checkOnly: false, skipRefresh: true)
                                if ringingInfo.item.id != actualSeatId {
                                    alarm.acknowledgeSeatTimer(seatId: ringingInfo.item.id, seatNumber: actualSeatNum, checkOnly: false, skipRefresh: true)
                                }
                                sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                                if ringingInfo.item.id != actualSeatId {
                                    sessionManager.markLocalCheckClear(seatId: ringingInfo.item.id, checkEndTime: clearedCheckEnd)
                                }
                                pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                                withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                    timers[idx].isRunning = false
                                    timers[idx].pausedRemainingSeconds = 0
                                    timers[idx].status = .shampoo
                                    timers[idx].helpProcess = "シャンプー"
                                    timers[idx].shampooStaff = currentUserName
                                    timers[idx].isRecruiting = false
                                    timers[idx].isNoHelpNeeded = false
                                    timers[idx].clearCheck()
                                    timers[idx].isCollapsed = true
                                }
                                sessionManager.timers = timers
                                sessionManager.markLocalStop(seatId: actualSeatId, endTime: stoppedEndTime)
                                sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: true)
                                if ringingInfo.item.id != actualSeatId {
                                    sessionManager.markLocalStop(seatId: ringingInfo.item.id, endTime: stoppedEndTime)
                                    sessionManager.setCollapseOverride(seatId: ringingInfo.item.id, collapsed: true)
                                }
                                WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                                sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: actualSeatId, extra: ["expectedEnd": expectedEndMs, "isCompleted": true, "helpProcess": "シャンプー"])
                                WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                                showNotification(
                                    text: "✅ 【\(ringingInfo.item.displaySeatName)】\(currentUserName)さんがシャンプーに入りました",
                                    color: Color(hex: "#30D158")
                                )
                            } else {
                                alarm.acknowledgeSeatTimer(seatId: ringingInfo.item.id, seatNumber: ringingInfo.item.seatNumber, checkOnly: false, skipRefresh: false)
                            }
                        }) {
                            HStack(spacing: 5) {
                                Image(systemName: "drop.fill")
                                    .font(.system(size: 13, weight: .heavy))
                                Text(label)
                                    .font(.system(size: 14, weight: .heavy))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
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
                            WKInterfaceDevice.current().play(.success)
                            if let idx = findSeatIndex(for: ringingInfo.item) {
                                let actualSeatId = timers[idx].id
                                let actualSeatNum = timers[idx].seatNumber
                                let process = timers[idx].helpProcess.isEmpty ? ringingInfo.item.helpProcess : timers[idx].helpProcess
                                let stoppedEndTime = timers[idx].targetEndTime
                                let expectedEndMs = timers[idx].expectedEndMs
                                let clearedCheckEnd = timers[idx].checkTargetEndTime
                                alarm.acknowledgeSeatTimer(seatId: actualSeatId, seatNumber: actualSeatNum, checkOnly: false, skipRefresh: true)
                                if ringingInfo.item.id != actualSeatId {
                                    alarm.acknowledgeSeatTimer(seatId: ringingInfo.item.id, seatNumber: actualSeatNum, checkOnly: false, skipRefresh: true)
                                }
                                sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                                if ringingInfo.item.id != actualSeatId {
                                    sessionManager.markLocalCheckClear(seatId: ringingInfo.item.id, checkEndTime: clearedCheckEnd)
                                }
                                pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                                withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                    timers[idx].isRunning = false
                                    timers[idx].pausedRemainingSeconds = 0
                                    timers[idx].status = (process == "コーミング") ? .combing : ((process == "チェック") ? .check : .shampoo)
                                    timers[idx].helpProcess = process
                                    timers[idx].shampooStaff = currentUserName
                                    timers[idx].isRecruiting = false
                                    timers[idx].isNoHelpNeeded = false
                                    timers[idx].clearCheck()
                                    timers[idx].isCollapsed = true
                                }
                                sessionManager.timers = timers
                                sessionManager.markLocalStop(seatId: actualSeatId, endTime: stoppedEndTime)
                                sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: true)
                                if ringingInfo.item.id != actualSeatId {
                                    sessionManager.markLocalStop(seatId: ringingInfo.item.id, endTime: stoppedEndTime)
                                    sessionManager.setCollapseOverride(seatId: ringingInfo.item.id, collapsed: true)
                                }
                                WatchAlarmCoordinator.shared.update(timers: timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
                                sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: actualSeatId, extra: ["expectedEnd": expectedEndMs, "isCompleted": true, "helpProcess": process])
                                WidgetSync.save(timers: timers, mainTimer: sessionManager.mainTimer ?? self.mainTimer, userName: currentUserName, forceReload: true)
                                showNotification(
                                    text: "✅ 【\(ringingInfo.item.displaySeatName)】\(currentUserName)さんが\(process)に入りました",
                                    color: Color(hex: "#30D158")
                                )
                            } else {
                                alarm.acknowledgeSeatTimer(seatId: ringingInfo.item.id, seatNumber: ringingInfo.item.seatNumber, checkOnly: false, skipRefresh: false)
                            }
                        }) {
                            HStack(spacing: 5) {
                                Image(systemName: iconName)
                                    .font(.system(size: 13, weight: .heavy))
                                Text(label)
                                    .font(.system(size: 14, weight: .heavy))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
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
                    
                    // ② 止めるボタン（本タイマー時は00:00停止＆カード収納、チェック単独アラーム時はチェックのみ完了して本タイマー継続＆カード展開維持）
                    Button(action: {
                        handleStopButtonInAlarmOverlay()
                    }) {
                        Text("タイマーを止める")
                            .font(.system(size: 14, weight: .heavy, design: .rounded))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Color(hex: "#FF453A"))
                            .foregroundColor(.white)
                            .cornerRadius(12)
                            .shadow(color: Color(hex: "#FF453A").opacity(0.3), radius: 3, x: 0, y: 1)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 4)
                    
                    // ③ 超過カウントを続行してカード画面を見るボタン（本タイマーも中間チェックも00:00に戻さず超過カウント続行）
                    Button(action: {
                        alarm.stop(sendToPhone: false, completeCheckIfNeeded: false, explicitTarget: alarm.ringing.first)
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("超過カウント続行（画面を見る）")
                            .font(.system(size: 11.5, weight: .bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
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
                    // ★ ヘルプ未指定時・チェック単独未指定時・メインタイマー時: 「止める」＆「超過カウント続行」
                    Button(action: {
                        handleStopButtonInAlarmOverlay()
                    }) {
                        Text("タイマーを止める")
                            .font(.system(size: 16, weight: .heavy, design: .rounded))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
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
                        alarm.stop(sendToPhone: false, completeCheckIfNeeded: false, explicitTarget: alarm.ringing.first)
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("超過カウント続行（画面を見る）")
                            .font(.system(size: 11.5, weight: .bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
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
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
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
                    let currentMain = sessionManager.mainTimer ?? self.mainTimer ?? defaultMainTimer()
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
                            mainTimerSheetInitialSubMode = currentMain.isZero ? .reinput : .timerActionBranch
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
                                    let prepared = prepareSheetTarget(for: item, cacheKey: "timeAction")
                                    if prepared.isCheckOvertime && !prepared.isOvertime {
                                        timeActionInitialBranchMode = false
                                        timeActionInitialSubCheckBranchMode = true
                                    } else {
                                        // 客席マップ（SeatThumbnailMapSheet）と完全統一:
                                        // 超過中（isOvertime）のみ直接「タイマーを止める」分岐画面（.timerActionBranch）を開き、
                                        // 通常カウントダウン稼働中は1番目の標準画面（.standard: タイマー＋ヘルプ指定＋チェック担当）を開く
                                        timeActionInitialBranchMode = prepared.isOvertime
                                        timeActionInitialSubCheckBranchMode = false
                                    }
                                    timeActionTargetId = prepared.id
                                    playHaptic(.click)
                                },
                                onOpenSelectHelpStaff: {
                                    let prepared = prepareSheetTarget(for: item, cacheKey: "selectHelpStaff")
                                    selectHelpStaffTargetId = prepared.id
                                    playHaptic(.click)
                                },
                                onOpenShampooAction: {
                                    let prepared = prepareSheetTarget(for: item, cacheKey: "shampooAction")
                                    shampooActionTargetId = prepared.id
                                    playHaptic(.click)
                                },
                                onOpenCheckAction: {
                                    let prepared = prepareSheetTarget(for: item, cacheKey: "timeAction")
                                    timeActionInitialBranchMode = false
                                    timeActionInitialSubCheckBranchMode = true
                                    timeActionTargetId = prepared.id
                                    playHaptic(.click)
                                },
                                onOpenSelectCheckStaff: {
                                    let prepared = prepareSheetTarget(for: item, cacheKey: "selectCheckStaff")
                                    selectCheckStaffTargetId = prepared.id
                                    playHaptic(.click)
                                },
                                onClaimCheck: {
                                    if let idx = findSeatIndex(for: item) {
                                        let preActionSeat = timers[idx]
                                        let actualSeatId = timers[idx].id
                                        let actualSeatNum = timers[idx].seatNumber
                                        pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                            timers[idx].checkStaff = currentUserName
                                        }
                                        sessionManager.timers = timers
                                        sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                                        if item.id != actualSeatId {
                                            sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                                        }
                                        syncSeatTimersState(forceWidgetReload: true)
                                        sessionManager.sendActionToPhone(action: "CLAIM_CHECK", seatId: actualSeatId, preActionSeat: preActionSeat)
                                        showNotification(text: "📤 \(item.displayCheckProcess)担当に立候補しました", color: Color(hex: "#30D158"))
                                    }
                                }
                            )
                            .id(item.id)
                        }
                    }
                    
                    // ② 一番下に「新しい席を追加」ボタンを配置（席の増減は招待元オーナーのみ）
                    if sessionManager.isSalonOwner {
                        Button(action: {
                            showingAddSeatSheet = true
                            playHaptic(.click)
                        }) {
                            HStack(spacing: 6) {
                                Image(systemName: "plus.circle.fill")
                                    .font(.system(size: 15, weight: .bold))
                                Text("新しい席を追加")
                                    .font(.system(size: 13, weight: .bold))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
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
                LongPressGesture(minimumDuration: 0.65)
                    .onEnded { _ in
                        playHaptic(.start)
                        showingThumbnailMap = true
                    }
            )
        }
    }
    
    @ViewBuilder
    private var backgroundRefreshDisabledBanner: some View {
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(Color(hex: "#FFD60A"))
            Text("Watch「設定＞一般＞バックグラウンド更新＞AssistTimer」をONにしてください")
                .font(.system(size: 9.5, weight: .bold))
                .foregroundColor(.white)
                .lineLimit(2)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 7)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 9)
                .fill(Color(hex: "#FF9F0A").opacity(0.28))
                .overlay(
                    RoundedRectangle(cornerRadius: 9)
                        .stroke(Color(hex: "#FF9F0A").opacity(0.75), lineWidth: 1)
                )
        )
        .padding(.horizontal, 4)
    }

    // ★ A-4: 共有通知バナーから対象席のアクションシートへ遷移可能かを判定する共通ヘルパー
    private func resolvePeerBannerNavigationTarget(_ alert: PeerConfirmationAlertItem) -> (seat: SeatTimerItem, kind: String)? {
        let cleanBody = WatchSessionManager.stripLeadingBracketTime(alert.text).body
        let meta = WatchSessionManager.extractPeerAlertSeatAndKind(cleanBody, id: alert.id)
        let kind = WatchSessionManager.normalizePeerEventKind(alert.eventType, fallback: meta.kind)
        // 担当解除（unassign_*）および単純なタイマー停止完了（stop）は確認消去のみ（不要なタイム入力シート起動を防止）
        if kind.hasPrefix("unassign_") || kind == "stop" {
            return nil
        }
        let sourceTimers = sessionManager.timers.isEmpty ? self.timers : sessionManager.timers
        let resolvedSeatNum = alert.seatNumber > 0 ? alert.seatNumber : (meta.seatNumber ?? 0)
        let matchedSeat: SeatTimerItem? = {
            if !alert.seatId.isEmpty,
               let exact = sourceTimers.first(where: { $0.id == alert.seatId }) {
                return exact
            }
            if resolvedSeatNum > 0,
               let byNum = sourceTimers.first(where: { $0.seatNumber == resolvedSeatNum }) {
                return byNum
            }
            if let byIdInAlert = sourceTimers.first(where: { !$0.id.isEmpty && alert.id.contains($0.id) }) {
                return byIdInAlert
            }
            if !alert.seatLabel.isEmpty,
               let byLabel = sourceTimers.first(where: { $0.displaySeatName == alert.seatLabel }) {
                return byLabel
            }
            if let byName = sourceTimers.first(where: { !$0.displaySeatName.isEmpty && cleanBody.contains($0.displaySeatName) }) {
                return byName
            }
            return nil
        }()
        guard let seat = matchedSeat else { return nil }
        if !seat.isRunning && seat.isZero && seat.status == .normal {
            return nil
        }
        return (seat: seat, kind: kind)
    }

    // ★ 誰かがタップして確認するまで消えない共有通知バナー（時刻・席・誰が何に入ったかを表示し、対象席シートへ1タップで直行）
    @ViewBuilder
    private func peerConfirmationBannerView(_ alert: PeerConfirmationAlertItem, totalCount: Int) -> some View {
        let canOpenTargetSeat = alarm.ringing.isEmpty && !isAnyModalSheetPresented && resolvePeerBannerNavigationTarget(alert) != nil
        Button(action: {
            playHaptic(.click)
            let preNavTarget = (alarm.ringing.isEmpty && !isAnyModalSheetPresented)
                ? resolvePeerBannerNavigationTarget(alert)
                : nil
            withAnimation(.spring(response: 0.28, dampingFraction: 0.8)) {
                sessionManager.confirmTopPeerAlert()
                // シートを直後に開く場合は prepareSheetTarget と同様、同一フレームで親 self.timers を書き換えず onDismiss 同期に委譲して ViewGraph 競合を防止
                if preNavTarget == nil && self.timers != sessionManager.timers && !sessionManager.timers.isEmpty {
                    self.timers = sessionManager.timers
                }
            }
            if preNavTarget != nil {
                pendingMainTimerSheetActionBox.chainedSheetWorkItem?.cancel()
                let work = DispatchWorkItem {
                    self.pendingMainTimerSheetActionBox.chainedSheetWorkItem = nil
                    guard self.scenePhase == .active,
                          self.alarm.ringing.isEmpty,
                          !self.isAnyModalSheetPresented,
                          let latestNav = self.resolvePeerBannerNavigationTarget(alert) else {
                        if !self.isAnyModalSheetPresented && self.timers != self.sessionManager.timers && !self.sessionManager.timers.isEmpty {
                            self.timers = self.sessionManager.timers
                        }
                        return
                    }
                    let targetSeat = latestNav.seat
                    if !targetSeat.isRunning && targetSeat.status != .normal {
                        let prepared = self.prepareSheetTarget(for: targetSeat, cacheKey: "shampooAction")
                        self.triggerScroll(to: prepared.id)
                        self.shampooActionTargetId = prepared.id
                    } else if targetSeat.isRunning {
                        let prepared = self.prepareSheetTarget(for: targetSeat, cacheKey: "timeAction")
                        self.triggerScroll(to: prepared.id)
                        if prepared.isCheckOvertime && !prepared.isOvertime {
                            self.timeActionInitialBranchMode = false
                            self.timeActionInitialSubCheckBranchMode = true
                        } else {
                            self.timeActionInitialBranchMode = prepared.isOvertime
                            self.timeActionInitialSubCheckBranchMode = false
                        }
                        self.timeActionTargetId = prepared.id
                    } else if !self.isAnyModalSheetPresented && self.timers != self.sessionManager.timers && !self.sessionManager.timers.isEmpty {
                        self.timers = self.sessionManager.timers
                        self.triggerScroll(to: targetSeat.id)
                    }
                }
                pendingMainTimerSheetActionBox.chainedSheetWorkItem = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: work)
            }
        }) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Image(systemName: "bell.badge.fill")
                        .font(.system(size: 9.5, weight: .heavy))
                    Text("🕒 \(alert.timeText) 共有通知")
                        .font(.system(size: 9.5, weight: .heavy))
                        .lineLimit(1)
                    Spacer(minLength: 2)
                    if totalCount > 1 {
                        Text("未確認\(totalCount)件")
                            .font(.system(size: 8.5, weight: .black))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.black.opacity(0.35))
                            .cornerRadius(5)
                    }
                    HStack(spacing: 2) {
                        Image(systemName: canOpenTargetSeat ? "arrow.up.forward.circle.fill" : "checkmark.circle.fill")
                            .font(.system(size: 10, weight: .bold))
                        Text(canOpenTargetSeat ? "開く" : "確認")
                            .font(.system(size: 9.5, weight: .black))
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.black.opacity(0.32))
                    .cornerRadius(7)
                }
                Text(alert.text)
                    .font(.system(size: 11, weight: .heavy))
                    .lineLimit(3)
                    .minimumScaleFactor(0.76)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 11)
                    .fill(Color(hex: alert.colorHex))
                    .overlay(
                        RoundedRectangle(cornerRadius: 11)
                            .stroke(Color.white.opacity(0.45), lineWidth: 1)
                    )
            )
            .foregroundColor(.white)
            .shadow(color: .black.opacity(0.45), radius: 3, x: 0, y: 2)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 4)
        .padding(.top, 2)
        .transition(.move(edge: .top).combined(with: .opacity))
        .zIndex(120)
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
            pausedRemainingSeconds: 0,
            isMainTimer: true,
            isCountUpEnabled: (UserDefaults.standard.object(forKey: "assisttimer.watch.isCountUpEnabled") as? Bool) ?? true,
            watchAlarmSoundEnabled: (UserDefaults.standard.object(forKey: "assisttimer.mainTimerWatchSound.v2") as? Bool) ?? false,
            alarmSoundEnabled: (UserDefaults.standard.object(forKey: "assisttimer.mainTimerPhoneSound.v2") as? Bool) ?? false
        )
    }
    
    private func handleToggleMainTimer() {
        playHaptic(.click)
        let currentNow = Date()
        self.now = currentNow
        let curState = self.mainTimer
        let curSession = sessionManager.mainTimer
        var main = curSession ?? curState ?? defaultMainTimer()
        let wasOvertime = main.isOvertime
        let willPause = main.isRunning || main.isPreCountingDown
        let activeCandidate = [curSession, curState].compactMap { $0 }.first(where: { $0.isRunning || $0.isPreCountingDown })
        let stoppedEnd = willPause
            ? (activeCandidate?.targetEndTime.timeIntervalSince1970 ?? (sessionManager.lastMainTimerLocalStopEndTime > 0 ? sessionManager.lastMainTimerLocalStopEndTime : main.targetEndTime.timeIntervalSince1970))
            : 0
        main.isAutoFinished = false
        if willPause {
            if main.isPreCountingDown || wasOvertime {
                main.pausedRemainingSeconds = 0
                if wasOvertime {
                    main.helpProcess = ""
                    main.isNoHelpNeeded = false
                }
                main.targetEndTime = currentNow.addingTimeInterval(TimeInterval(main.totalSeconds))
            } else {
                main.pausedRemainingSeconds = max(0, safeClampedCeilSeconds(main.targetEndTime.timeIntervalSince(currentNow)))
            }
            main.isRunning = false
            main.isPreCountingDown = false
            main.preCountdownSeconds = 0
            main.prepEndTime = nil
            WatchAlarmCoordinator.shared.acknowledgeMainTimer()
        } else {
            main.watchAlarmSoundEnabled = (UserDefaults.standard.object(forKey: "assisttimer.mainTimerWatchSound.v2") as? Bool) ?? false
            main.alarmSoundEnabled = (UserDefaults.standard.object(forKey: "assisttimer.mainTimerPhoneSound.v2") as? Bool) ?? false
            let isInitialStart = (main.pausedRemainingSeconds <= 0 || main.pausedRemainingSeconds == main.totalSeconds || main.isOvertime)
            if isInitialStart && main.isCountdownConfigEnabled && main.countdownConfigSeconds > 0 {
                let prepEnd = currentNow.addingTimeInterval(TimeInterval(main.countdownConfigSeconds))
                main.isPreCountingDown = true
                main.preCountdownSeconds = main.countdownConfigSeconds
                main.prepEndTime = prepEnd
                main.isRunning = false
                main.pausedRemainingSeconds = main.totalSeconds
                main.targetEndTime = prepEnd.addingTimeInterval(TimeInterval(main.totalSeconds))
            } else {
                main.isRunning = true
                let rem = (main.pausedRemainingSeconds > 0 && !main.isOvertime) ? main.pausedRemainingSeconds : main.totalSeconds
                main.targetEndTime = currentNow.addingTimeInterval(TimeInterval(rem))
            }
        }
        let activeTimers = sessionManager.timers.isEmpty ? timers : sessionManager.timers
        self.mainTimer = main
        sessionManager.mainTimer = main
        WidgetSync.save(timers: activeTimers, mainTimer: main, userName: currentUserName, forceReload: true)
        WatchAlarmCoordinator.shared.update(timers: activeTimers, mainTimer: main, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
        sessionManager.sendMainTimerAction(
            action: willPause ? (wasOvertime ? "MAIN_TIMER_RESET" : "MAIN_TIMER_PAUSE") : "MAIN_TIMER_START",
            extra: willPause ? [:] : ["totalSeconds": main.totalSeconds],
            stoppedEndTime: stoppedEnd
        )
    }
    
    @discardableResult
    private func handleStartMainTimer(playHapticFeedback: Bool = true, deferParentStateSync: Bool = false) -> SeatTimerItem {
        if playHapticFeedback {
            playHaptic(.click)
        }
        let currentNow = Date()
        if !deferParentStateSync {
            self.now = currentNow
        }
        var main = sessionManager.mainTimer ?? self.mainTimer ?? defaultMainTimer()
        let wasOvertime = main.isOvertime
        main.isAutoFinished = false
        main.watchAlarmSoundEnabled = (UserDefaults.standard.object(forKey: "assisttimer.mainTimerWatchSound.v2") as? Bool) ?? false
        main.alarmSoundEnabled = (UserDefaults.standard.object(forKey: "assisttimer.mainTimerPhoneSound.v2") as? Bool) ?? false
        let isInitialStart = (main.pausedRemainingSeconds <= 0 || main.pausedRemainingSeconds == main.totalSeconds || wasOvertime)
        if isInitialStart && main.isCountdownConfigEnabled && main.countdownConfigSeconds > 0 {
            let prepEnd = currentNow.addingTimeInterval(TimeInterval(main.countdownConfigSeconds))
            main.isPreCountingDown = true
            main.preCountdownSeconds = main.countdownConfigSeconds
            main.prepEndTime = prepEnd
            main.isRunning = false
            main.pausedRemainingSeconds = main.totalSeconds
            main.targetEndTime = prepEnd.addingTimeInterval(TimeInterval(main.totalSeconds))
        } else {
            main.isRunning = true
            let rem = (main.pausedRemainingSeconds > 0 && !wasOvertime) ? main.pausedRemainingSeconds : main.totalSeconds
            main.targetEndTime = currentNow.addingTimeInterval(TimeInterval(rem))
        }
        let activeTimers = sessionManager.timers.isEmpty ? timers : sessionManager.timers
        if !deferParentStateSync {
            if main.isRunning || main.isPreCountingDown {
                self.now = Date()
            }
            self.mainTimer = main
            sessionManager.mainTimer = main
        }
        if wasOvertime || WatchAlarmCoordinator.shared.isMainTimerRingingOrDue {
            WatchAlarmCoordinator.shared.acknowledgeMainTimer(skipRefresh: true)
        }
        WidgetSync.save(timers: activeTimers, mainTimer: main, userName: currentUserName, forceReload: true)
        WatchAlarmCoordinator.shared.update(timers: activeTimers, mainTimer: main, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
        sessionManager.sendMainTimerAction(action: "MAIN_TIMER_START", extra: ["totalSeconds": main.totalSeconds], mainTimerOverride: main)
        return main
    }
    
    @discardableResult
    private func handlePauseMainTimer(playHapticFeedback: Bool = true, deferParentStateSync: Bool = false) -> SeatTimerItem {
        if playHapticFeedback {
            playHaptic(.click)
        }
        let curState = self.mainTimer
        let curSession = sessionManager.mainTimer
        var main = curSession ?? curState ?? defaultMainTimer()
        let wasOvertime = main.isOvertime
        let activeCandidate = [curSession, curState].compactMap { $0 }.first(where: { $0.isRunning || $0.isPreCountingDown })
        let stoppedEnd = activeCandidate?.targetEndTime.timeIntervalSince1970
            ?? (sessionManager.lastMainTimerLocalStopEndTime > 0 ? sessionManager.lastMainTimerLocalStopEndTime : main.targetEndTime.timeIntervalSince1970)
        if main.isPreCountingDown || wasOvertime {
            main.pausedRemainingSeconds = 0
            if wasOvertime {
                main.helpProcess = ""
                main.isNoHelpNeeded = false
            }
            main.targetEndTime = Date().addingTimeInterval(TimeInterval(main.totalSeconds))
        } else {
            main.pausedRemainingSeconds = max(0, safeClampedCeilSeconds(main.targetEndTime.timeIntervalSince(Date())))
        }
        main.isRunning = false
        main.isPreCountingDown = false
        main.isAutoFinished = false
        main.preCountdownSeconds = 0
        main.prepEndTime = nil
        let activeTimers = sessionManager.timers.isEmpty ? timers : sessionManager.timers
        if !deferParentStateSync {
            if main.isRunning || main.isPreCountingDown {
                self.now = Date()
            }
            self.mainTimer = main
            sessionManager.mainTimer = main
        }
        WatchAlarmCoordinator.shared.acknowledgeMainTimer(skipRefresh: true)
        WatchAlarmCoordinator.shared.update(timers: activeTimers, mainTimer: main, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
        WidgetSync.save(timers: activeTimers, mainTimer: main, userName: currentUserName, forceReload: true)
        sessionManager.sendMainTimerAction(
            action: wasOvertime ? "MAIN_TIMER_RESET" : "MAIN_TIMER_PAUSE",
            stoppedEndTime: stoppedEnd,
            mainTimerOverride: main
        )
        return main
    }
    
    @discardableResult
    private func handleResetMainTimer(playHapticFeedback: Bool = true, deferParentStateSync: Bool = false) -> SeatTimerItem {
        if playHapticFeedback {
            playHaptic(.click)
        }
        let curState = self.mainTimer
        let curSession = sessionManager.mainTimer
        var main = curSession ?? curState ?? defaultMainTimer()
        let activeCandidate = [curSession, curState].compactMap { $0 }.first(where: { $0.isRunning || $0.isPreCountingDown })
        let stoppedEnd = activeCandidate?.targetEndTime.timeIntervalSince1970
            ?? (sessionManager.lastMainTimerLocalStopEndTime > 0 ? sessionManager.lastMainTimerLocalStopEndTime : main.targetEndTime.timeIntervalSince1970)
        main.isRunning = false
        main.isPreCountingDown = false
        main.isAutoFinished = false
        main.preCountdownSeconds = 0
        main.prepEndTime = nil
        main.pausedRemainingSeconds = 0
        main.helpProcess = ""
        main.isNoHelpNeeded = false
        main.targetEndTime = Date().addingTimeInterval(TimeInterval(main.totalSeconds))
        let activeTimers = sessionManager.timers.isEmpty ? timers : sessionManager.timers
        if !deferParentStateSync {
            if main.isRunning || main.isPreCountingDown {
                self.now = Date()
            }
            self.mainTimer = main
            sessionManager.mainTimer = main
        }
        WatchAlarmCoordinator.shared.acknowledgeMainTimer(skipRefresh: true)
        if WatchAlarmCoordinator.shared.ringing.isEmpty {
            // 他の客席タイマーが鳴動中でなければ残存セッションも完全停止
            WatchAlarmCoordinator.shared.stop(sendToPhone: false, skipRefresh: true)
        }
        WatchAlarmCoordinator.shared.update(timers: activeTimers, mainTimer: main, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
        WidgetSync.save(timers: activeTimers, mainTimer: main, userName: currentUserName, forceReload: true)
        sessionManager.sendMainTimerAction(action: "MAIN_TIMER_RESET", stoppedEndTime: stoppedEnd, mainTimerOverride: main)
        return main
    }
    
    @discardableResult
    private func handleSetMainTimerTime(totalSec: Int, autoStart: Bool = true, playHapticFeedback: Bool = true, deferParentStateSync: Bool = false) -> SeatTimerItem {
        if playHapticFeedback {
            playHaptic(.click)
        }
        var main = sessionManager.mainTimer ?? self.mainTimer ?? defaultMainTimer()
        let wasOvertime = main.isOvertime
        main.isAutoFinished = false
        main.watchAlarmSoundEnabled = (UserDefaults.standard.object(forKey: "assisttimer.mainTimerWatchSound.v2") as? Bool) ?? false
        main.alarmSoundEnabled = (UserDefaults.standard.object(forKey: "assisttimer.mainTimerPhoneSound.v2") as? Bool) ?? false
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
        let activeTimers = sessionManager.timers.isEmpty ? timers : sessionManager.timers
        if !deferParentStateSync {
            if main.isRunning || main.isPreCountingDown {
                self.now = Date()
            }
            self.mainTimer = main
            sessionManager.mainTimer = main
        }
        if wasOvertime || WatchAlarmCoordinator.shared.isMainTimerRingingOrDue {
            WatchAlarmCoordinator.shared.acknowledgeMainTimer(skipRefresh: true)
        }
        WidgetSync.save(timers: activeTimers, mainTimer: main, userName: currentUserName, forceReload: true)
        WatchAlarmCoordinator.shared.update(timers: activeTimers, mainTimer: main, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
        sessionManager.sendMainTimerSetTime(seconds: totalSec, autoStart: shouldAutoStart, mainTimerOverride: main)
        return main
    }
    
    @discardableResult
    private func handleAdjustMainTimer(deltaSec: Int, playHapticFeedback: Bool = true, deferParentStateSync: Bool = false) -> SeatTimerItem {
        if playHapticFeedback {
            playHaptic(.click)
        }
        var main = sessionManager.mainTimer ?? self.mainTimer ?? defaultMainTimer()
        let wasOvertime = main.isOvertime
        main.isAutoFinished = false
        if main.isRunning {
            let baseEnd = main.isOvertime ? Date() : main.targetEndTime
            main.targetEndTime = max(Date().addingTimeInterval(5), baseEnd.addingTimeInterval(Double(deltaSec)))
        } else {
            let wasPausedMidCountdown = (main.pausedRemainingSeconds > 0 && !main.isPreCountingDown)
            let baseSec = wasPausedMidCountdown ? main.pausedRemainingSeconds : main.totalSeconds
            let nextSec = max(10, baseSec + deltaSec)
            if main.isPreCountingDown {
                main.pausedRemainingSeconds = nextSec
                main.totalSeconds = nextSec
                let prepEnd = main.prepEndTime ?? Date().addingTimeInterval(TimeInterval(max(1, main.preCountdownSeconds)))
                main.targetEndTime = prepEnd.addingTimeInterval(TimeInterval(nextSec))
            } else if wasPausedMidCountdown {
                main.pausedRemainingSeconds = nextSec
                main.totalSeconds = max(main.totalSeconds, nextSec)
            } else {
                // ★ 停止・初期状態（00:00）での微調整は、デジタル数字を 00:00 のまま維持し、設定分数のみを更新する
                main.pausedRemainingSeconds = 0
                main.totalSeconds = nextSec
            }
            main.isRunning = false
        }
        let activeTimers = sessionManager.timers.isEmpty ? timers : sessionManager.timers
        if !deferParentStateSync {
            if main.isRunning || main.isPreCountingDown {
                self.now = Date()
            }
            self.mainTimer = main
            sessionManager.mainTimer = main
        }
        if main.isRunning && (wasOvertime || WatchAlarmCoordinator.shared.isMainTimerRingingOrDue) && deltaSec > 0 {
            WatchAlarmCoordinator.shared.acknowledgeMainTimer(skipRefresh: true)
        }
        WidgetSync.save(timers: activeTimers, mainTimer: main, userName: currentUserName, forceReload: true)
        WatchAlarmCoordinator.shared.update(timers: activeTimers, mainTimer: main, soundOn: sessionManager.alarmSoundEnabled, currentUserName: currentUserName)
        sessionManager.sendMainTimerAdjust(seconds: deltaSec, mainTimerOverride: main)
        return main
    }
    
    @ViewBuilder
    private var thumbnailMapSheetView: some View {
        SeatThumbnailMapSheet(
            timers: timers,
            mainTimer: sessionManager.mainTimer ?? self.mainTimer ?? defaultMainTimer(),
            currentUserName: currentUserName,
            now: now,
            crownFocusTrigger: mapCrownFocusTrigger,
            isModalSheetPresented: isAnyModalSheetPresented,
            onSelectSeat: { selectedSeat in
                let prepared = prepareSheetTarget(for: selectedSeat, cacheKey: "timeAction")
                triggerScroll(to: prepared.id)
                if prepared.isCheckOvertime && !prepared.isOvertime {
                    timeActionInitialBranchMode = false
                    timeActionInitialSubCheckBranchMode = true
                } else {
                    // ★ 超過中（isOvertime）のみ直接「タイマーを止める」分岐画面（2番目の画面）を開き、
                    //   稼働中（非超過）の共有タイマーは1番目の標準画面（.standard: タイマー数字＋ヘルプ指定＋チェック担当指定）を開く
                    timeActionInitialBranchMode = prepared.isOvertime
                    timeActionInitialSubCheckBranchMode = false
                }
                timeActionTargetId = prepared.id
            },
            onSelectMainTimer: {
                let currentMain = sessionManager.mainTimer ?? self.mainTimer ?? defaultMainTimer()
                mainTimerSheetInitialSubMode = currentMain.isZero ? .reinput : .timerActionBranch
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
            onAddSeat: sessionManager.isSalonOwner ? {
                showingAddSeatSheet = true
            } : nil
        )
    }
    
    @ViewBuilder
    private var mainTimerSheetView: some View {
        let initialMain: SeatTimerItem = {
            if let cached = pendingMainTimerSheetActionBox.cachedMainTimerItem {
                return cached
            }
            let current = sessionManager.mainTimer ?? self.mainTimer ?? defaultMainTimer()
            pendingMainTimerSheetActionBox.cachedMainTimerItem = current
            return current
        }()
        MainTimerActionSheet(
            item: initialMain,
            initialSubMode: mainTimerSheetInitialSubMode,
            onStart: {
                // ★ タップした0msの瞬間に開始状態確定・アラーム予約・モジュラー文字盤即時同期・iPhone送信まで完了し、
                //   sessionManager.mainTimer / self.mainTimer の @Published 更新のみシート閉鎖後に反映（dismiss中のView破棄を完全防止）
                let updatedMain = self.handleStartMainTimer(playHapticFeedback: false, deferParentStateSync: true)
                deferMainTimerSheetCloseAction {
                    self.sessionManager.mainTimer = updatedMain
                    self.mainTimer = updatedMain
                }
            },
            onPause: {
                let updatedMain = self.handlePauseMainTimer(playHapticFeedback: false, deferParentStateSync: true)
                deferMainTimerSheetCloseAction {
                    self.sessionManager.mainTimer = updatedMain
                    self.mainTimer = updatedMain
                }
            },
            onReset: {
                // ★ 「タイマーを止める」を押した0msの瞬間に全振動・音・セッション・通知を完全消火し、00:00リセット＆文字盤同期＆iPhone送信を即完了
                let updatedMain = self.handleResetMainTimer(playHapticFeedback: false, deferParentStateSync: true)
                deferMainTimerSheetCloseAction {
                    self.sessionManager.mainTimer = updatedMain
                    self.mainTimer = updatedMain
                }
            },
            onSetTime: { sec in
                // ★ 時間決定・定番分数タップ時に0msでカウントダウン開始状態と文字盤タイムラインを即確定（直後にデジタルクラウンで文字盤へ戻っても即カウント反映）
                let updatedMain = self.handleSetMainTimerTime(totalSec: sec, playHapticFeedback: false, deferParentStateSync: true)
                deferMainTimerSheetCloseAction {
                    self.sessionManager.mainTimer = updatedMain
                    self.mainTimer = updatedMain
                }
            },
            onAdjust: { deltaSec in
                let cur = self.sessionManager.mainTimer ?? self.mainTimer ?? initialMain
                if cur.isRunning || cur.isOvertime {
                    let updatedMain = self.handleAdjustMainTimer(deltaSec: deltaSec, playHapticFeedback: false, deferParentStateSync: true)
                    deferMainTimerSheetCloseAction {
                        self.sessionManager.mainTimer = updatedMain
                        self.mainTimer = updatedMain
                    }
                } else {
                    self.handleAdjustMainTimer(deltaSec: deltaSec, playHapticFeedback: false, deferParentStateSync: false)
                }
            }
        )
    }
    
    @ViewBuilder
    private var addSeatSheetView: some View {
        AddSeatSheet(
            currentUserName: currentUserName,
            suggestedSeatNumber: (timers.map { $0.seatNumber }.max() ?? 0) + 1,
            onAdd: { newSeat in
                deferSeatSheetCloseAction {
                    guard self.sessionManager.isSalonOwner else { return }
                    self.now = Date()
                    var createdSeat = newSeat
                    let addUid = self.sessionManager.cloudUserId.trimmingCharacters(in: .whitespacesAndNewlines)
                    createdSeat.createdBy = WatchSessionManager.isValidCloudUUID(addUid) ? addUid : nil
                    createdSeat.isCreatorMeExplicit = true
                    self.triggerScroll(to: createdSeat.id)
                    self.pendingOpenStandardSeatIdAfterAdd = createdSeat.id
                    self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                    self.timers.append(createdSeat)
                    self.sessionManager.timers = self.timers
                    self.syncSeatTimersState(forceWidgetReload: true)
                    var extra: [String: Any] = [
                        "seatNumber": newSeat.seatNumber,
                        "totalSeconds": newSeat.totalSeconds,
                        "targetEndTimestamp": newSeat.targetEndTime.timeIntervalSince1970 * 1000.0,
                        "watchAlarmSoundEnabled": newSeat.watchAlarmSoundEnabled,
                        "alarmSoundEnabled": newSeat.alarmSoundEnabled
                    ]
                    if let checkSec = newSeat.checkTotalSeconds {
                        extra["checkTotalSeconds"] = checkSec
                        if let checkEnd = newSeat.checkTargetEndTime {
                            extra["checkEndTimestamp"] = checkEnd.timeIntervalSince1970 * 1000.0
                        }
                    }
                    self.sessionManager.sendActionToPhone(action: "ADD_SEAT", seatId: newSeat.id, extra: extra)
                    self.showNotification(text: "📤 \(newSeat.displaySeatName)を新規作成しました", color: Color(hex: "#0A84FF"))
                }
            }
        )
    }
    
    // ★ 客席タイマーの「シャンプーに入る」「タイマーを止める」「チェック完了」等がタップされた0msの瞬間に、
    //   シート閉鎖アニメーションを待たずすべての振動・音・現行/バックグラウンドセッション・リピート通知を即時完全停止するヘルパー
    private func immediatelyAcknowledgeSeatAlarm(for item: SeatTimerItem, checkOnly: Bool, onlyIfRingingOrOvertime: Bool = false) {
        let matchedIdx = findSeatIndex(for: item)
        let actualSeat = matchedIdx.map { timers[$0] }
        let refSeat = actualSeat ?? item
        let targetSeatId = actualSeat?.id ?? item.id
        let targetSeatNum = actualSeat?.seatNumber ?? item.seatNumber
        if onlyIfRingingOrOvertime {
            let isOver = checkOnly
                ? ((actualSeat?.isCheckOvertime == true) || item.isCheckOvertime)
                : ((actualSeat?.isOvertime == true) || item.isOvertime || (actualSeat?.isCheckOvertime == true) || item.isCheckOvertime)
            let isRinging = WatchAlarmCoordinator.shared.isSeatRingingOrDue(
                seatId: targetSeatId,
                seatNumber: targetSeatNum,
                checkOnly: checkOnly
            )
            guard isOver || isRinging else { return }
        }
        WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
            seatId: targetSeatId,
            seatNumber: targetSeatNum,
            checkOnly: checkOnly,
            skipRefresh: false
        )
        if item.id != targetSeatId {
            WatchAlarmCoordinator.shared.acknowledgeSeatTimer(
                seatId: item.id,
                seatNumber: targetSeatNum,
                checkOnly: checkOnly,
                skipRefresh: false
            )
        }
        // ★ カウントダウン中または超過中にモーダルシートから「タイマーを止める」「シャンプーに入る」「チェック完了」等をタップした0msの瞬間は、
        //   WatchSessionManager.@Published timers を書き換えると dismiss() と同一フレームでシート内の .onReceive($timers) や親View再評価が走って
        //   watchOSのシート閉鎖トランザクションがデッドロックするため、0ms時点では localStops / localCheckClears / WatchAlarmCoordinator / WidgetSync（ローカルコピー使用）
        //   のみ即時確定し、timers 配列の更新は deferSeatSheetCloseAction 内で一括実行する！
        if !onlyIfRingingOrOvertime {
            var previewTimers = self.timers.isEmpty ? sessionManager.timers : self.timers
            let pIdx = previewTimers.firstIndex(where: { $0.id == targetSeatId })
                ?? previewTimers.firstIndex(where: { $0.id == item.id })
                ?? previewTimers.firstIndex(where: { $0.seatNumber == targetSeatNum })
            let currentMain = sessionManager.mainTimer ?? self.mainTimer
            if checkOnly {
                sessionManager.markLocalCheckClear(seatId: targetSeatId, checkEndTime: refSeat.checkTargetEndTime)
                sessionManager.setCollapseOverride(seatId: targetSeatId, collapsed: false)
                if item.id != targetSeatId {
                    sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: refSeat.checkTargetEndTime)
                    sessionManager.setCollapseOverride(seatId: item.id, collapsed: false)
                }
                if let pIdx = pIdx {
                    previewTimers[pIdx].isCheckCompleted = true
                    previewTimers[pIdx].checkStaff = self.currentUserName
                    previewTimers[pIdx].checkTargetEndTime = nil
                    previewTimers[pIdx].checkTotalSeconds = nil
                    previewTimers[pIdx].isCollapsed = false
                }
                WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                    seatId: targetSeatId,
                    timers: previewTimers,
                    mainTimer: currentMain,
                    soundOn: sessionManager.alarmSoundEnabled,
                    currentUserName: self.currentUserName
                )
                WidgetSync.save(timers: previewTimers, mainTimer: currentMain, userName: self.currentUserName, forceReload: true)
            } else {
                sessionManager.markLocalStop(seatId: targetSeatId, endTime: refSeat.targetEndTime)
                sessionManager.setCollapseOverride(seatId: targetSeatId, collapsed: true)
                if item.id != targetSeatId {
                    sessionManager.markLocalStop(seatId: item.id, endTime: refSeat.targetEndTime)
                    sessionManager.setCollapseOverride(seatId: item.id, collapsed: true)
                }
                if let clearedCheckEnd = refSeat.checkTargetEndTime {
                    sessionManager.markLocalCheckClear(seatId: targetSeatId, checkEndTime: clearedCheckEnd)
                    if item.id != targetSeatId {
                        sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: clearedCheckEnd)
                    }
                }
                if let pIdx = pIdx {
                    previewTimers[pIdx].isRunning = false
                    previewTimers[pIdx].pausedRemainingSeconds = 0
                    previewTimers[pIdx].totalSeconds = 0
                    previewTimers[pIdx].clearCheck()
                    previewTimers[pIdx].isRecruiting = false
                    previewTimers[pIdx].isNoHelpNeeded = false
                    previewTimers[pIdx].isCollapsed = true
                }
                WatchAlarmCoordinator.shared.update(
                    timers: previewTimers,
                    mainTimer: currentMain,
                    soundOn: sessionManager.alarmSoundEnabled,
                    currentUserName: self.currentUserName
                )
                WidgetSync.save(timers: previewTimers, mainTimer: currentMain, userName: self.currentUserName, forceReload: true)
            }
        }
    }

    @ViewBuilder
    private func timeActionSheetView(item: SeatTimerItem) -> some View {
        // ★ 00:00時はタイム入力画面、超過中またはカード数字タップ時は微調整・シャンプーに入る・止める等の統合操作画面を表示
        TimeActionSheet(
            item: item,
            initialReinputMode: item.isZero && !timeActionInitialSubCheckBranchMode,
            initialTimerBranchMode: timeActionInitialBranchMode || (item.isOvertime && !timeActionInitialSubCheckBranchMode),
            initialSubCheckBranchMode: timeActionInitialSubCheckBranchMode,
            currentUserName: currentUserName,
            staffCandidates: sessionManager.members,
            onAdjust: { deltaSec in
                if deltaSec > 0 {
                    self.immediatelyAcknowledgeSeatAlarm(for: item, checkOnly: false, onlyIfRingingOrOvertime: true)
                }
                deferSeatSheetCloseAction {
                    self.triggerScroll(to: item.id)
                    if let idx = self.findSeatIndex(for: item) {
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        let wasOvertime = self.timers[idx].isOvertime
                        let nowDate = Date()
                        let baseEnd = (deltaSec > 0) ? max(nowDate, self.timers[idx].targetEndTime) : self.timers[idx].targetEndTime
                        let newEnd = max(nowDate.addingTimeInterval(5), baseEnd.addingTimeInterval(Double(deltaSec)))
                        let nextTotalSec = max(10, self.timers[idx].totalSeconds + deltaSec)
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].targetEndTime = newEnd
                        self.timers[idx].totalSeconds = nextTotalSec
                        self.timers[idx].pausedRemainingSeconds = max(10, self.timers[idx].pausedRemainingSeconds + deltaSec)
                        if newEnd > nowDate {
                            self.timers[idx].status = .normal
                        }
                        if self.timers[idx].remainingSeconds > 180 {
                            self.timers[idx].hasAlertedHelpUnassigned = false
                        }
                        self.timers[idx].isCollapsed = false
                        self.sessionManager.timers = self.timers
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        self.sessionManager.clearLocalStop(seatId: actualSeatId)
                        self.sessionManager.clearPeerStoppedSeat(seatId: actualSeatId, seatNumber: actualSeatNum, recordRecentClear: false)
                        self.sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: false)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                            self.sessionManager.clearLocalStop(seatId: item.id)
                            self.sessionManager.clearPeerStoppedSeat(seatId: item.id, seatNumber: actualSeatNum, recordRecentClear: false)
                            self.sessionManager.setCollapseOverride(seatId: item.id, collapsed: false)
                        }
                        if wasOvertime && deltaSec > 0 {
                            WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: actualSeatId, seatNumber: actualSeatNum, checkOnly: false, mainOnly: true, skipRefresh: true)
                            if item.id != actualSeatId {
                                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: item.id, seatNumber: actualSeatNum, checkOnly: false, mainOnly: true, skipRefresh: true)
                            }
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.sessionManager.sendActionToPhone(
                            action: "ADJUST_TIME",
                            seatId: actualSeatId,
                            extra: [
                                "secondsToAdd": deltaSec,
                                "totalSeconds": nextTotalSec,
                                "targetEndTimestamp": newEnd.timeIntervalSince1970 * 1000.0
                            ]
                        )
                        let deltaText = formatDeltaString(deltaSec)
                        self.showNotification(text: "⏱️ \(item.displaySeatName): \(deltaText)しました", color: Color(hex: "#0A84FF"))
                    }
                }
            },
            onAdjustCheck: { deltaSec in
                if deltaSec > 0 {
                    self.immediatelyAcknowledgeSeatAlarm(for: item, checkOnly: true, onlyIfRingingOrOvertime: true)
                }
                deferSeatSheetCloseAction {
                    self.triggerScroll(to: item.id)
                    if let idx = self.findSeatIndex(for: item) {
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        let wasCheckOvertime = self.timers[idx].isCheckOvertime
                        let rawCheckEnd = self.timers[idx].checkTargetEndTime ?? Date()
                        let baseCheckEnd = (deltaSec > 0) ? max(Date(), rawCheckEnd) : rawCheckEnd
                        let newCheckEnd = max(Date().addingTimeInterval(5), baseCheckEnd.addingTimeInterval(Double(deltaSec)))
                        let nextCheckTotal = max(10, (self.timers[idx].checkTotalSeconds ?? 0) + deltaSec)
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].checkTargetEndTime = newCheckEnd
                        self.timers[idx].checkTotalSeconds = nextCheckTotal
                        self.timers[idx].isCollapsed = false
                        self.sessionManager.timers = self.timers
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        self.sessionManager.clearLocalCheckClear(seatId: actualSeatId)
                        self.sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: false)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                            self.sessionManager.clearLocalCheckClear(seatId: item.id)
                            self.sessionManager.setCollapseOverride(seatId: item.id, collapsed: false)
                        }
                        if wasCheckOvertime && deltaSec > 0 {
                            WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: actualSeatId, seatNumber: actualSeatNum, checkOnly: true, skipRefresh: true)
                            if item.id != actualSeatId {
                                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: item.id, seatNumber: actualSeatNum, checkOnly: true, skipRefresh: true)
                            }
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.sessionManager.sendActionToPhone(
                            action: "ADJUST_TIME",
                            seatId: actualSeatId,
                            extra: [
                                "secondsToAdd": deltaSec,
                                "isSubCheck": true,
                                "checkTotalSeconds": nextCheckTotal,
                                "checkEndTimestamp": newCheckEnd.timeIntervalSince1970 * 1000.0
                            ]
                        )
                        let deltaText = formatDeltaString(deltaSec)
                        self.showNotification(text: "⏱️ \(item.displaySeatName) チェック: \(deltaText)しました", color: Color(hex: "#30D158"))
                    }
                }
            },
            onStop: {
                // ★ タップした0msの瞬間に停止前メタデータを確定取得し、全振動・セッション・リピート通知の消火＋iPhone送信＋Supabase直接PATCHまで0msで即完了！
                //   （先に deferSeatSheetCloseAction を登録して seatSheetAction != nil にすることで、シート閉鎖中の handleRemoteModalSheetAutoCloseIfNeeded 誤発火も防止）
                let preSeat = self.findSeatIndex(for: item).map { self.timers[$0] } ?? item
                let referenceSeat = preSeat.isRunning ? preSeat : item
                let latestInSession = self.sessionManager.timers.first(where: { $0.id == preSeat.id || $0.seatNumber == preSeat.seatNumber }) ?? preSeat
                // ★ シートを開いた時点では停止していたのに、裏で別Watchが同じ席番号で新しいタイマーを開始していた場合のみ、その新タイマーを誤って止めず画面のみ最新へ同期する
                let isReplacedByNewRemoteTimer = !referenceSeat.isRunning
                    && latestInSession.isRunning
                    && latestInSession.targetEndTime > Date().addingTimeInterval(2.0)
                if isReplacedByNewRemoteTimer {
                    deferSeatSheetCloseAction {
                        self.triggerScroll(to: latestInSession.id)
                        if self.timers != self.sessionManager.timers && !self.sessionManager.timers.isEmpty {
                            self.timers = self.sessionManager.timers
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.showNotification(text: "🔄 \(item.displaySeatName)は別端末で新しいタイマーが開始されたため更新しました", color: Color(hex: "#0A84FF"))
                    }
                    return
                }
                let actualSeatId = preSeat.id
                let actualSeatNum = preSeat.seatNumber
                let stoppedEndTime = referenceSeat.isRunning ? referenceSeat.targetEndTime : preSeat.targetEndTime
                let rawExpectedMs = referenceSeat.isRunning ? (referenceSeat.targetEndTime.timeIntervalSince1970 * 1000.0) : item.expectedEndMs
                let expectedEndMs = rawExpectedMs > 0 ? rawExpectedMs : (stoppedEndTime.timeIntervalSince1970 * 1000.0)
                let wasPeerStopped = self.sessionManager.wasRecentlyOrCurrentlyPeerStoppedSeat(seatId: actualSeatId, seatNumber: actualSeatNum, targetEndTime: stoppedEndTime)
                    || self.sessionManager.wasRecentlyOrCurrentlyPeerStoppedSeat(seatId: item.id, seatNumber: actualSeatNum, targetEndTime: stoppedEndTime)
                let sessionPeerSeatPre = self.sessionManager.timers.first(where: { $0.id == actualSeatId || $0.id == item.id || $0.seatNumber == actualSeatNum })
                let effectivePeerStatus: TreatmentStatus = (preSeat.status != .normal)
                    ? preSeat.status
                    : (sessionPeerSeatPre?.status ?? .normal)
                let effectivePeerStaff: String = {
                    if let s = preSeat.shampooStaff, !s.isEmpty { return s }
                    if let s = sessionPeerSeatPre?.shampooStaff, !s.isEmpty { return s }
                    return ""
                }()
                let hasPeerActiveProcess = wasPeerStopped && (effectivePeerStatus != .normal)
                let effectivePeerProcLabel: String = {
                    switch effectivePeerStatus {
                    case .shampoo: return "シャンプー"
                    case .combing: return "コーミング"
                    case .check: return "チェック"
                    case .normal: return ""
                    }
                }()
                var stopExtra: [String: Any] = [
                    "expectedEnd": expectedEndMs,
                    "wasPeerStopped": wasPeerStopped
                ]
                if hasPeerActiveProcess {
                    stopExtra["peerIsShampooing"] = (effectivePeerStatus == .shampoo)
                    stopExtra["peerHelpProcess"] = effectivePeerProcLabel
                    stopExtra["peerActiveProcess"] = effectivePeerStatus.rawValue
                    if !effectivePeerStaff.isEmpty {
                        stopExtra["peerAssistantStaffName"] = effectivePeerStaff
                        stopExtra["peerShampooStaff"] = effectivePeerStaff
                    }
                }
                let clearedCheckEnd = preSeat.checkTargetEndTime ?? item.checkTargetEndTime
                deferSeatSheetCloseAction {
                    self.triggerScroll(to: item.id)
                    if self.timers.isEmpty && !self.sessionManager.timers.isEmpty {
                        self.timers = self.sessionManager.timers
                    }
                    if wasPeerStopped {
                        self.sessionManager.clearPeerStoppedSeat(seatId: actualSeatId, seatNumber: actualSeatNum, recordRecentClear: true)
                        if item.id != actualSeatId {
                            self.sessionManager.clearPeerStoppedSeat(seatId: item.id, seatNumber: actualSeatNum, recordRecentClear: true)
                        }
                    }
                    if let idx = self.findSeatIndex(for: item) {
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        var updated = self.timers
                        updated[idx].isRunning = false
                        updated[idx].pausedRemainingSeconds = 0
                        updated[idx].totalSeconds = 0
                        if hasPeerActiveProcess {
                            updated[idx].status = effectivePeerStatus
                            updated[idx].helpProcess = effectivePeerProcLabel
                            if !effectivePeerStaff.isEmpty {
                                updated[idx].shampooStaff = effectivePeerStaff
                            }
                        } else {
                            updated[idx].status = .normal
                            updated[idx].helpProcess = ""
                            updated[idx].shampooStaff = nil
                        }
                        updated[idx].isRecruiting = false
                        updated[idx].isNoHelpNeeded = false
                        updated[idx].isCollapsed = true
                        // ★ チェックタイマーも解除（Q3）
                        updated[idx].clearCheck()
                        self.timers = updated
                        self.sessionManager.timers = updated
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.showNotification(text: "⏹️ \(item.displaySeatName)のタイマーを止めました", color: Color(hex: "#30D158"))
                    }
                }
                self.immediatelyAcknowledgeSeatAlarm(for: preSeat, checkOnly: false)
                self.sessionManager.markLocalStop(seatId: actualSeatId, endTime: stoppedEndTime)
                self.sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: true)
                if item.id != actualSeatId {
                    self.sessionManager.markLocalStop(seatId: item.id, endTime: stoppedEndTime)
                    self.sessionManager.setCollapseOverride(seatId: item.id, collapsed: true)
                }
                if let clearedCheckEnd = clearedCheckEnd {
                    self.sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                    if item.id != actualSeatId {
                        self.sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: clearedCheckEnd)
                    }
                }
                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: actualSeatId, seatNumber: actualSeatNum, checkOnly: false, skipRefresh: true)
                if item.id != actualSeatId {
                    WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: item.id, seatNumber: actualSeatNum, checkOnly: false, skipRefresh: true)
                }
                self.sessionManager.sendActionToPhone(action: "STOP_TIMER", seatId: actualSeatId, extra: stopExtra)
            },
            onEnterHelp: {
                // ★ 「シャンプーに入る」「コーミングに入る」等を押した0msの瞬間に、停止前工程名・終了時刻を確定して完全消火＋iPhone送信＋Supabase直接PATCHまで即完了！
                let preSeat = self.findSeatIndex(for: item).map { self.timers[$0] } ?? item
                let referenceSeat = preSeat.isRunning ? preSeat : item
                let latestInSession = self.sessionManager.timers.first(where: { $0.id == preSeat.id || $0.seatNumber == preSeat.seatNumber }) ?? preSeat
                let isReplacedByNewRemoteTimer = !referenceSeat.isRunning
                    && latestInSession.isRunning
                    && latestInSession.targetEndTime > Date().addingTimeInterval(2.0)
                if isReplacedByNewRemoteTimer {
                    deferSeatSheetCloseAction {
                        self.triggerScroll(to: latestInSession.id)
                        if self.timers != self.sessionManager.timers && !self.sessionManager.timers.isEmpty {
                            self.timers = self.sessionManager.timers
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.showNotification(text: "🔄 \(item.displaySeatName)は別端末で新しいタイマーが開始されたため更新しました", color: Color(hex: "#0A84FF"))
                    }
                    return
                }
                let actualSeatId = preSeat.id
                let actualSeatNum = preSeat.seatNumber
                let stoppedEndTime = referenceSeat.isRunning ? referenceSeat.targetEndTime : preSeat.targetEndTime
                let rawExpectedMs = referenceSeat.isRunning ? (referenceSeat.targetEndTime.timeIntervalSince1970 * 1000.0) : item.expectedEndMs
                let expectedEndMs = rawExpectedMs > 0 ? rawExpectedMs : (stoppedEndTime.timeIntervalSince1970 * 1000.0)
                let clearedCheckEnd = preSeat.checkTargetEndTime ?? item.checkTargetEndTime
                let rawProcess = preSeat.helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
                let fallbackItemProc = item.helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
                let process = !rawProcess.isEmpty ? rawProcess : (!fallbackItemProc.isEmpty ? fallbackItemProc : "シャンプー")
                deferSeatSheetCloseAction {
                    self.triggerScroll(to: item.id)
                    if let idx = self.findSeatIndex(for: item) {
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].isRunning = false
                        self.timers[idx].pausedRemainingSeconds = 0
                        self.timers[idx].totalSeconds = 0
                        self.timers[idx].status = (process == "コーミング") ? .combing : ((process == "チェック") ? .check : .shampoo)
                        self.timers[idx].shampooStaff = self.currentUserName
                        self.timers[idx].helpProcess = process
                        self.timers[idx].isRecruiting = false
                        self.timers[idx].isNoHelpNeeded = false
                        self.timers[idx].isCollapsed = true
                        self.timers[idx].clearCheck()
                        self.sessionManager.timers = self.timers
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.showNotification(
                            text: "✅ 【\(item.displaySeatName)】自分が\(process)に入りました",
                            color: Color(hex: "#30D158")
                        )
                    }
                }
                self.immediatelyAcknowledgeSeatAlarm(for: preSeat, checkOnly: false)
                self.sessionManager.markLocalStop(seatId: actualSeatId, endTime: stoppedEndTime)
                self.sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: true)
                if item.id != actualSeatId {
                    self.sessionManager.markLocalStop(seatId: item.id, endTime: stoppedEndTime)
                    self.sessionManager.setCollapseOverride(seatId: item.id, collapsed: true)
                }
                if let clearedCheckEnd = clearedCheckEnd {
                    self.sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                    if item.id != actualSeatId {
                        self.sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: clearedCheckEnd)
                    }
                }
                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: actualSeatId, seatNumber: actualSeatNum, checkOnly: false, skipRefresh: true)
                if item.id != actualSeatId {
                    WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: item.id, seatNumber: actualSeatNum, checkOnly: false, skipRefresh: true)
                }
                self.sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: actualSeatId, extra: ["expectedEnd": expectedEndMs, "isCompleted": true, "helpProcess": process])
            },
            onCompleteCheck: {
                // ★ 「チェックに入る」（全体タイマー連動）を押した0msの瞬間に振動・セッション・リピート通知を即時完全停止＋iPhone送信＋Supabase直接PATCHまで即完了！
                let preSeat = self.findSeatIndex(for: item).map { self.timers[$0] } ?? item
                let referenceSeat = preSeat.isRunning ? preSeat : item
                let latestInSession = self.sessionManager.timers.first(where: { $0.id == preSeat.id || $0.seatNumber == preSeat.seatNumber }) ?? preSeat
                let isReplacedByNewRemoteTimer = !referenceSeat.isRunning
                    && latestInSession.isRunning
                    && latestInSession.targetEndTime > Date().addingTimeInterval(2.0)
                if isReplacedByNewRemoteTimer {
                    deferSeatSheetCloseAction {
                        self.triggerScroll(to: latestInSession.id)
                        if self.timers != self.sessionManager.timers && !self.sessionManager.timers.isEmpty {
                            self.timers = self.sessionManager.timers
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.showNotification(text: "🔄 \(item.displaySeatName)は別端末で新しいタイマーが開始されたため更新しました", color: Color(hex: "#0A84FF"))
                    }
                    return
                }
                let actualSeatId = preSeat.id
                let actualSeatNum = preSeat.seatNumber
                let stoppedEndTime = referenceSeat.isRunning ? referenceSeat.targetEndTime : preSeat.targetEndTime
                let rawExpectedMs = referenceSeat.isRunning ? (referenceSeat.targetEndTime.timeIntervalSince1970 * 1000.0) : item.expectedEndMs
                let expectedEndMs = rawExpectedMs > 0 ? rawExpectedMs : (stoppedEndTime.timeIntervalSince1970 * 1000.0)
                let clearedCheckEnd = preSeat.checkTargetEndTime ?? item.checkTargetEndTime
                deferSeatSheetCloseAction {
                    self.triggerScroll(to: item.id)
                    if let idx = self.findSeatIndex(for: item) {
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].isRunning = false
                        self.timers[idx].pausedRemainingSeconds = 0
                        self.timers[idx].totalSeconds = 0
                        self.timers[idx].status = .check
                        self.timers[idx].helpProcess = "チェック"
                        self.timers[idx].shampooStaff = self.currentUserName
                        self.timers[idx].isRecruiting = false
                        self.timers[idx].isNoHelpNeeded = false
                        self.timers[idx].isCollapsed = true
                        self.timers[idx].clearCheck()
                        self.sessionManager.timers = self.timers
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.showNotification(
                            text: "✅ 【\(item.displaySeatName)】自分がチェックに入りました",
                            color: Color(hex: "#30D158")
                        )
                    }
                }
                self.immediatelyAcknowledgeSeatAlarm(for: preSeat, checkOnly: false)
                self.sessionManager.markLocalStop(seatId: actualSeatId, endTime: stoppedEndTime)
                self.sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: true)
                if item.id != actualSeatId {
                    self.sessionManager.markLocalStop(seatId: item.id, endTime: stoppedEndTime)
                    self.sessionManager.setCollapseOverride(seatId: item.id, collapsed: true)
                }
                if let clearedCheckEnd = clearedCheckEnd {
                    self.sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                    if item.id != actualSeatId {
                        self.sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: clearedCheckEnd)
                    }
                }
                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: actualSeatId, seatNumber: actualSeatNum, checkOnly: false, skipRefresh: true)
                if item.id != actualSeatId {
                    WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: item.id, seatNumber: actualSeatNum, checkOnly: false, skipRefresh: true)
                }
                self.sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: actualSeatId, extra: ["expectedEnd": expectedEndMs, "isCompleted": true, "helpProcess": "チェック", "completeSubCheck": true])
            },
            onReinputTime: { totalSec, checkSec, watchSound, phoneSound in
                let preSeat = self.findSeatIndex(for: item).map { self.timers[$0] } ?? item
                let actualSeatId = preSeat.id
                let actualSeatNum = preSeat.seatNumber
                let sec = max(10, totalSec)
                // ★ 全体タイムより短いチェック時間のみ有効
                let validCheckSec = (checkSec != nil && checkSec! < sec) ? checkSec : nil
                let m = sec / 60
                let s = sec % 60
                let timeStr = s > 0 ? "\(m)分\(s)秒" : "\(m)分"
                let startBase = Date()
                self.now = startBase
                let mainEnd = startBase.addingTimeInterval(Double(sec))
                let checkEnd = (validCheckSec != nil && validCheckSec! > 0) ? startBase.addingTimeInterval(Double(validCheckSec!)) : nil
                let checkText = (validCheckSec ?? 0) > 0 ? "（チェック\(validCheckSec! / 60)分）" : ""
                let applyStartToSeat = { (seat: inout SeatTimerItem) in
                    seat.creatorName = self.currentUserName
                    let myUid = self.sessionManager.cloudUserId.trimmingCharacters(in: .whitespacesAndNewlines)
                    seat.createdBy = WatchSessionManager.isValidCloudUUID(myUid) ? myUid : nil
                    seat.isCreatorMeExplicit = true
                    seat.totalSeconds = sec
                    seat.targetEndTime = mainEnd
                    seat.pausedRemainingSeconds = sec
                    seat.isRunning = true
                    seat.status = .normal
                    seat.isCollapsed = false
                    seat.helpProcess = ""
                    seat.shampooStaff = nil
                    seat.isRecruiting = false
                    seat.isNoHelpNeeded = false
                    seat.hasAlertedHelpUnassigned = false
                    seat.watchAlarmSoundEnabled = watchSound
                    seat.alarmSoundEnabled = phoneSound
                    if let chk = validCheckSec, chk > 0, let cEnd = checkEnd {
                        seat.checkTotalSeconds = chk
                        seat.checkTargetEndTime = cEnd
                        seat.checkStaff = nil
                        seat.checkProcess = "チェック"
                        seat.isCheckCompleted = false
                    } else {
                        seat.clearCheck()
                    }
                }
                // ★ TimeActionSheet.applyReinputAndShowStandard はシートを閉じずにそのまま .standard（ヘルプ指定画面）へ遷移するため、
                //   deferSeatSheetCloseAction を使わず 0ms で即座に timers / cachedSheetItems / sessionManager / アラーム予約 / クラウド同期へ反映する
                self.pendingMainTimerSheetActionBox.closeFallbackWorkItem?.cancel()
                self.pendingMainTimerSheetActionBox.closeFallbackWorkItem = nil
                self.pendingMainTimerSheetActionBox.seatSheetAction = nil
                WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: actualSeatId, seatNumber: actualSeatNum, checkOnly: false, skipRefresh: true)
                if item.id != actualSeatId {
                    WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: item.id, seatNumber: actualSeatNum, checkOnly: false, skipRefresh: true)
                }
                if let idx = self.findSeatIndex(for: item) {
                    self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                    applyStartToSeat(&self.timers[idx])
                    // ★ シートオープン中に cachedSheetItems["timeAction"] を上書きすると bindingTimeAction が返す item が変化し、
                    //   timeActionSheetView(item:) の引数 item.isZero が true → false に切り替わって SwiftUI がシートを再評価・強制閉鎖してしまうため、
                    //   未キャッシュ時のみセットし、既にキャッシュがある場合はオープン時のスナップショットを完全固定する
                    if self.pendingMainTimerSheetActionBox.cachedSheetItems["timeAction"] == nil {
                        var freshCache = self.timers[idx]
                        freshCache.id = self.timeActionTargetId ?? actualSeatId
                        self.pendingMainTimerSheetActionBox.cachedSheetItems["timeAction"] = freshCache
                    }
                }
                var updatedSessionTimers = self.timers
                if let sIdx = updatedSessionTimers.firstIndex(where: { $0.id == actualSeatId || $0.id == item.id || $0.seatNumber == actualSeatNum }) {
                    applyStartToSeat(&updatedSessionTimers[sIdx])
                }
                self.sessionManager.timers = updatedSessionTimers
                self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                self.sessionManager.clearLocalStop(seatId: actualSeatId)
                self.sessionManager.clearPeerStoppedSeat(seatId: actualSeatId, seatNumber: actualSeatNum, recordRecentClear: false)
                self.sessionManager.clearLocalCheckClear(seatId: actualSeatId)
                self.sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: nil)
                if item.id != actualSeatId {
                    self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                    self.sessionManager.clearLocalStop(seatId: item.id)
                    self.sessionManager.clearPeerStoppedSeat(seatId: item.id, seatNumber: actualSeatNum, recordRecentClear: false)
                    self.sessionManager.clearLocalCheckClear(seatId: item.id)
                    self.sessionManager.setCollapseOverride(seatId: item.id, collapsed: nil)
                }
                let currentMain = self.sessionManager.mainTimer ?? self.mainTimer
                WatchAlarmCoordinator.shared.update(
                    timers: updatedSessionTimers,
                    mainTimer: currentMain,
                    soundOn: self.sessionManager.alarmSoundEnabled,
                    currentUserName: self.currentUserName
                )
                WidgetSync.save(
                    timers: updatedSessionTimers,
                    mainTimer: currentMain,
                    userName: self.currentUserName,
                    forceReload: true
                )
                var extraPayload: [String: Any] = [
                    "targetSeconds": sec,
                    "targetEndTimestamp": mainEnd.timeIntervalSince1970 * 1000.0,
                    "watchAlarmSoundEnabled": watchSound,
                    "alarmSoundEnabled": phoneSound
                ]
                if let chk = validCheckSec, chk > 0, let cEnd = checkEnd {
                    extraPayload["checkTotalSeconds"] = chk
                    extraPayload["checkEndTimestamp"] = cEnd.timeIntervalSince1970 * 1000.0
                }
                self.sessionManager.sendActionToPhone(action: "START_TIMER", seatId: actualSeatId, extra: extraPayload)
                self.showNotification(
                    text: "⏱️ \(item.displaySeatName): \(timeStr)に開始しました\(checkText)",
                    color: Color(hex: "#FFD60A")
                )
            },
            onAssignHelp: { process, staff in
                if let idx = findSeatIndex(for: item) {
                    let preActionSeat = timers[idx]
                    let actualSeatId = timers[idx].id
                    let actualSeatNum = timers[idx].seatNumber
                    let isSelfStaff = SeatTimerItem.isStaffMe(staff, currentUserName: currentUserName)
                    let shouldSetCreatorToMe = preActionSeat.shouldClaimOrRefreshCreatorAsMe(currentUserName: currentUserName, myUid: sessionManager.cloudUserId)
                    pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                    timers[idx].helpProcess = process
                    timers[idx].shampooStaff = staff
                    if process == "チェック" {
                        timers[idx].checkStaff = staff
                    }
                    timers[idx].isRecruiting = false
                    timers[idx].isNoHelpNeeded = false
                    if shouldSetCreatorToMe {
                        timers[idx].applyCreatorAsMe(currentUserName: currentUserName, myUid: sessionManager.cloudUserId)
                    }
                    sessionManager.timers = timers
                    sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                    if item.id != actualSeatId {
                        sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                    }
                    syncSeatTimersState(forceWidgetReload: true)
                    sessionManager.sendActionToPhone(action: "ASSIGN_HELP", seatId: actualSeatId, extra: ["helpProcess": process, "assistantStaffName": staff], preActionSeat: preActionSeat)
                    showNotification(
                        text: isSelfStaff ? "📤 自分を【\(process)】に設定しました" : "📤 \(staff)さんに【\(process)】を指定しました",
                        color: Color(hex: "#0A84FF")
                    )
                }
            },
            onRecruitHelp: { process in
                if let idx = findSeatIndex(for: item) {
                    let preActionSeat = timers[idx]
                    let actualSeatId = timers[idx].id
                    let actualSeatNum = timers[idx].seatNumber
                    let shouldSetCreatorToMe = preActionSeat.shouldClaimOrRefreshCreatorAsMe(currentUserName: currentUserName, myUid: sessionManager.cloudUserId)
                    pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                    timers[idx].helpProcess = process
                    timers[idx].shampooStaff = nil
                    if process == "チェック" {
                        timers[idx].checkStaff = nil
                    }
                    timers[idx].isRecruiting = true
                    timers[idx].isNoHelpNeeded = false
                    if shouldSetCreatorToMe {
                        timers[idx].applyCreatorAsMe(currentUserName: currentUserName, myUid: sessionManager.cloudUserId)
                    }
                    if timers[idx].remainingSeconds <= 180 {
                        timers[idx].hasAlertedHelpUnassigned = true
                    }
                    sessionManager.timers = timers
                    sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                    if item.id != actualSeatId {
                        sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                    }
                    syncSeatTimersState(forceWidgetReload: true)
                    sessionManager.sendActionToPhone(action: "RECRUIT_HELP", seatId: actualSeatId, extra: ["helpProcess": process], preActionSeat: preActionSeat)
                    showNotification(
                        text: "📢 【\(item.displaySeatName)】\(process)担当を全員に募集通知しました！",
                        color: Color(hex: "#FF9F0A")
                    )
                }
            },
            onSetNoHelp: {
                if let idx = findSeatIndex(for: item) {
                    let preActionSeat = timers[idx]
                    let actualSeatId = timers[idx].id
                    let actualSeatNum = timers[idx].seatNumber
                    let shouldSetCreatorToMe = preActionSeat.shouldClaimOrRefreshCreatorAsMe(currentUserName: currentUserName, myUid: sessionManager.cloudUserId)
                    pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                    timers[idx].helpProcess = ""
                    timers[idx].shampooStaff = nil
                    timers[idx].isRecruiting = false
                    timers[idx].isNoHelpNeeded = true
                    if shouldSetCreatorToMe {
                        timers[idx].applyCreatorAsMe(currentUserName: currentUserName, myUid: sessionManager.cloudUserId)
                    }
                    sessionManager.timers = timers
                    sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                    if item.id != actualSeatId {
                        sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                    }
                    syncSeatTimersState(forceWidgetReload: true)
                    sessionManager.sendActionToPhone(action: "ASSIGN_HELP", seatId: actualSeatId, extra: ["helpProcess": "ヘルプなし", "assistantStaffName": "ヘルプなし"], preActionSeat: preActionSeat)
                    showNotification(
                        text: "👤 【\(item.displaySeatName)】ヘルプなし（一人施術）に設定しました",
                        color: Color(hex: "#8E8E93")
                    )
                }
            },
            onClearHelp: {
                if let idx = findSeatIndex(for: item) {
                    let preActionSeat = timers[idx]
                    let actualSeatId = timers[idx].id
                    let actualSeatNum = timers[idx].seatNumber
                    pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                    timers[idx].helpProcess = ""
                    timers[idx].shampooStaff = nil
                    timers[idx].isRecruiting = false
                    timers[idx].isNoHelpNeeded = false
                    sessionManager.timers = timers
                    sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                    if item.id != actualSeatId {
                        sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                    }
                    syncSeatTimersState(forceWidgetReload: true)
                    sessionManager.sendActionToPhone(action: "CLEAR_STAFF", seatId: actualSeatId, preActionSeat: preActionSeat)
                    showNotification(
                        text: "👤 【\(item.displaySeatName)】ヘルプ指定を未定に戻しました",
                        color: Color(hex: "#8E8E93")
                    )
                }
            },
            onAssignCheckStaff: { checkProcess, staff in
                if let idx = findSeatIndex(for: item) {
                    let preActionSeat = timers[idx]
                    let actualSeatId = timers[idx].id
                    let actualSeatNum = timers[idx].seatNumber
                    let isSelfCheck = SeatTimerItem.isStaffMe(staff, currentUserName: currentUserName)
                    let shouldSetCreatorToMe = preActionSeat.shouldClaimOrRefreshCreatorAsMe(currentUserName: currentUserName, myUid: sessionManager.cloudUserId)
                    pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                    timers[idx].checkProcess = checkProcess
                    timers[idx].checkStaff = staff
                    if shouldSetCreatorToMe {
                        timers[idx].applyCreatorAsMe(currentUserName: currentUserName, myUid: sessionManager.cloudUserId)
                    }
                    sessionManager.timers = timers
                    sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                    if item.id != actualSeatId {
                        sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                    }
                    syncSeatTimersState(forceWidgetReload: true)
                    sessionManager.sendActionToPhone(action: "ASSIGN_HELP", seatId: actualSeatId, extra: ["checkStaffName": staff, "checkProcess": checkProcess, "isSubCheck": true], preActionSeat: preActionSeat)
                    showNotification(
                        text: isSelfCheck ? "📤 自分を【\(checkProcess)】担当に設定しました" : "📤 \(staff)さんを【\(checkProcess)】担当に指定しました",
                        color: Color(hex: "#30D158")
                    )
                }
            },
            onRecruitCheckStaff: { checkProcess in
                if let idx = findSeatIndex(for: item) {
                    let preActionSeat = timers[idx]
                    let actualSeatId = timers[idx].id
                    let actualSeatNum = timers[idx].seatNumber
                    let shouldSetCreatorToMe = preActionSeat.shouldClaimOrRefreshCreatorAsMe(currentUserName: currentUserName, myUid: sessionManager.cloudUserId)
                    pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                    timers[idx].checkProcess = checkProcess
                    timers[idx].checkStaff = "募集中"
                    if shouldSetCreatorToMe {
                        timers[idx].applyCreatorAsMe(currentUserName: currentUserName, myUid: sessionManager.cloudUserId)
                    }
                    sessionManager.timers = timers
                    sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                    if item.id != actualSeatId {
                        sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                    }
                    syncSeatTimersState(forceWidgetReload: true)
                    sessionManager.sendActionToPhone(action: "RECRUIT_HELP", seatId: actualSeatId, extra: ["helpProcess": checkProcess, "checkProcess": checkProcess, "isSubCheck": true], preActionSeat: preActionSeat)
                    showNotification(
                        text: "📢 【\(item.displaySeatName)】\(checkProcess)担当を全員に募集通知しました！",
                        color: Color(hex: "#FF9F0A")
                    )
                }
            },
            onClearCheckStaff: {
                if let idx = findSeatIndex(for: item) {
                    let preActionSeat = timers[idx]
                    let actualSeatId = timers[idx].id
                    let actualSeatNum = timers[idx].seatNumber
                    pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                    timers[idx].checkProcess = "チェック"
                    timers[idx].checkStaff = nil
                    sessionManager.timers = timers
                    sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                    if item.id != actualSeatId {
                        sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                    }
                    syncSeatTimersState(forceWidgetReload: true)
                    sessionManager.sendActionToPhone(action: "ASSIGN_HELP", seatId: actualSeatId, extra: ["checkStaffName": "", "checkProcess": "チェック", "isSubCheck": true], preActionSeat: preActionSeat)
                    showNotification(
                        text: "👤 チェック担当を未定に戻しました",
                        color: Color(hex: "#8E8E93")
                    )
                }
            },
            onCompleteSubCheck: {
                let preSeat = self.findSeatIndex(for: item).map { self.timers[$0] } ?? item
                let actualSeatId = preSeat.id
                let doneProc = preSeat.displayCheckProcess
                let clearedCheckEnd = preSeat.checkTargetEndTime ?? item.checkTargetEndTime
                let preservedCheckSec = max(60, preSeat.checkTotalSeconds ?? item.checkTotalSeconds ?? 60)
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].isCheckCompleted = true
                        self.timers[idx].checkStaff = self.currentUserName
                        self.timers[idx].checkTargetEndTime = nil
                        self.timers[idx].checkTotalSeconds = nil
                        self.timers[idx].isCollapsed = false
                        self.sessionManager.timers = self.timers
                        WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                            seatId: actualSeatId,
                            timers: self.timers,
                            mainTimer: self.sessionManager.mainTimer ?? self.mainTimer,
                            soundOn: self.sessionManager.alarmSoundEnabled,
                            currentUserName: self.currentUserName
                        )
                        WidgetSync.save(
                            timers: self.timers,
                            mainTimer: self.sessionManager.mainTimer ?? self.mainTimer,
                            userName: self.currentUserName,
                            forceReload: true
                        )
                        self.showNotification(text: "✅ \(doneProc)完了（全体タイマー続行）", color: Color(hex: "#30D158"))
                    }
                }
                self.immediatelyAcknowledgeSeatAlarm(for: preSeat, checkOnly: true)
                self.sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                self.sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: false)
                if item.id != actualSeatId {
                    self.sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: clearedCheckEnd)
                    self.sessionManager.setCollapseOverride(seatId: item.id, collapsed: false)
                }
                self.sessionManager.sendActionToPhone(action: "COMPLETE_CHECK", seatId: actualSeatId, extra: ["checkTotalSeconds": preservedCheckSec], preActionSeat: preSeat)
            },
            onCancelSubCheck: {
                let preSeat = self.findSeatIndex(for: item).map { self.timers[$0] } ?? item
                let actualSeatId = preSeat.id
                let clearedCheckEnd = preSeat.checkTargetEndTime ?? item.checkTargetEndTime
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        let actualSeatNum = self.timers[idx].seatNumber
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].checkTargetEndTime = nil
                        self.timers[idx].checkTotalSeconds = nil
                        self.timers[idx].checkStaff = nil
                        self.timers[idx].checkProcess = "チェック"
                        self.sessionManager.timers = self.timers
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                            seatId: actualSeatId,
                            timers: self.timers,
                            mainTimer: self.sessionManager.mainTimer ?? self.mainTimer,
                            soundOn: self.sessionManager.alarmSoundEnabled,
                            currentUserName: self.currentUserName
                        )
                        WidgetSync.save(
                            timers: self.timers,
                            mainTimer: self.sessionManager.mainTimer ?? self.mainTimer,
                            userName: self.currentUserName,
                            forceReload: true
                        )
                        self.showNotification(text: "⏹ チェックタイマーを解除しました", color: Color(hex: "#8E8E93"))
                    }
                }
                self.immediatelyAcknowledgeSeatAlarm(for: preSeat, checkOnly: true)
                self.sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                if item.id != actualSeatId {
                    self.sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: clearedCheckEnd)
                }
                self.sessionManager.sendActionToPhone(action: "CANCEL_CHECK", seatId: actualSeatId, preActionSeat: preSeat)
            },
            onAddLateCheck: { checkSec, checkProcess, checkStaff, closeSheet in
                let applyLateCheck = {
                    if let idx = self.findSeatIndex(for: item) {
                        let preActionSeat = self.timers[idx]
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        let validSec = max(60, checkSec)
                        let checkEnd = Date().addingTimeInterval(Double(validSec))
                        let resolvedProc = SeatTimerItem.sanitizeCheckProcess(checkProcess)
                        let resolvedStaff: String? = (checkStaff?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false) ? checkStaff : nil
                        let shouldSetCreatorToMe = preActionSeat.shouldClaimOrRefreshCreatorAsMe(currentUserName: self.currentUserName, myUid: self.sessionManager.cloudUserId)
                        WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: actualSeatId, seatNumber: actualSeatNum, checkOnly: true, skipRefresh: true)
                        if item.id != actualSeatId {
                            WatchAlarmCoordinator.shared.acknowledgeSeatTimer(seatId: item.id, seatNumber: actualSeatNum, checkOnly: true, skipRefresh: true)
                        }
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].checkTotalSeconds = validSec
                        self.timers[idx].checkTargetEndTime = checkEnd
                        self.timers[idx].checkProcess = resolvedProc
                        self.timers[idx].checkStaff = resolvedStaff
                        self.timers[idx].isCheckCompleted = false
                        if shouldSetCreatorToMe {
                            self.timers[idx].applyCreatorAsMe(currentUserName: self.currentUserName, myUid: self.sessionManager.cloudUserId)
                        }
                        self.sessionManager.timers = self.timers
                        self.sessionManager.clearLocalCheckClear(seatId: actualSeatId)
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.clearLocalCheckClear(seatId: item.id)
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        let extraPayload: [String: Any] = [
                            "checkTotalSeconds": validSec,
                            "checkEndTimestamp": checkEnd.timeIntervalSince1970 * 1000.0,
                            "checkProcess": resolvedProc,
                            "checkStaffName": resolvedStaff ?? ""
                        ]
                        self.sessionManager.sendActionToPhone(action: "SET_CHECK_TIMER", seatId: actualSeatId, extra: extraPayload, preActionSeat: preActionSeat)
                        let mins = validSec / 60
                        let staffText = resolvedStaff != nil ? " (\(SeatTimerItem.displayStaffName(resolvedStaff!, currentUserName: self.currentUserName)))" : ""
                        self.showNotification(
                            text: "🔍 \(item.displaySeatName): チェック\(mins)分を追加しました\(staffText)",
                            color: Color(hex: "#0A84FF")
                        )
                    }
                }
                if closeSheet {
                    deferSeatSheetCloseAction {
                        applyLateCheck()
                    }
                } else {
                    applyLateCheck()
                }
            },
            onUpdateSoundSettings: { watchSound, phoneSound in
                if let idx = findSeatIndex(for: item) {
                    let actualSeatId = timers[idx].id
                    let actualSeatNum = timers[idx].seatNumber
                    pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                    timers[idx].watchAlarmSoundEnabled = watchSound
                    timers[idx].alarmSoundEnabled = phoneSound
                    sessionManager.timers = timers
                    sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                    if item.id != actualSeatId {
                        sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                    }
                    syncSeatTimersState(forceWidgetReload: false)
                    sessionManager.sendActionToPhone(
                        action: "UPDATE_SOUND_SETTINGS",
                        seatId: actualSeatId,
                        extra: [
                            "watchAlarmSoundEnabled": watchSound,
                            "alarmSoundEnabled": phoneSound
                        ]
                    )
                }
            }
        )
    }
    
    @ViewBuilder
    private func checkActionSheetView(item: SeatTimerItem) -> some View {
        CheckActionSheet(
            item: item,
            currentUserName: currentUserName,
            onOpenSelectStaff: {
                deferSeatSheetCloseAction {
                    self.pendingMainTimerSheetActionBox.chainedSheetWorkItem?.cancel()
                    let work = DispatchWorkItem {
                        self.pendingMainTimerSheetActionBox.chainedSheetWorkItem = nil
                        guard self.scenePhase == .active, self.alarm.ringing.isEmpty else { return }
                        let prepared = self.prepareSheetTarget(for: item, cacheKey: "selectCheckStaff")
                        self.selectCheckStaffTargetId = prepared.id
                    }
                    self.pendingMainTimerSheetActionBox.chainedSheetWorkItem = work
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
                }
            },
            onCompleteCheck: {
                let preSeat = self.findSeatIndex(for: item).map { self.timers[$0] } ?? item
                let actualSeatId = preSeat.id
                let clearedCheckEnd = preSeat.checkTargetEndTime ?? item.checkTargetEndTime
                let preservedCheckSec = max(60, preSeat.checkTotalSeconds ?? item.checkTotalSeconds ?? 60)
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].isCheckCompleted = true
                        self.timers[idx].checkStaff = self.currentUserName
                        self.timers[idx].checkTargetEndTime = nil
                        self.timers[idx].checkTotalSeconds = nil
                        self.timers[idx].isCollapsed = false
                        self.sessionManager.timers = self.timers
                        WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                            seatId: actualSeatId,
                            timers: self.timers,
                            mainTimer: self.sessionManager.mainTimer ?? self.mainTimer,
                            soundOn: self.sessionManager.alarmSoundEnabled,
                            currentUserName: self.currentUserName
                        )
                        WidgetSync.save(
                            timers: self.timers,
                            mainTimer: self.sessionManager.mainTimer ?? self.mainTimer,
                            userName: self.currentUserName,
                            forceReload: true
                        )
                        self.showNotification(text: "✅ チェック完了を全員へ通知しました", color: Color(hex: "#30D158"))
                    }
                }
                self.immediatelyAcknowledgeSeatAlarm(for: preSeat, checkOnly: true)
                self.sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                self.sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: false)
                if item.id != actualSeatId {
                    self.sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: clearedCheckEnd)
                    self.sessionManager.setCollapseOverride(seatId: item.id, collapsed: false)
                }
                self.sessionManager.sendActionToPhone(action: "COMPLETE_CHECK", seatId: actualSeatId, extra: ["checkTotalSeconds": preservedCheckSec], preActionSeat: preSeat)
            },
            onCancelCheck: {
                let preSeat = self.findSeatIndex(for: item).map { self.timers[$0] } ?? item
                let actualSeatId = preSeat.id
                let clearedCheckEnd = preSeat.checkTargetEndTime ?? item.checkTargetEndTime
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        let actualSeatNum = self.timers[idx].seatNumber
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].checkTargetEndTime = nil
                        self.timers[idx].checkTotalSeconds = nil
                        self.timers[idx].checkStaff = nil
                        self.timers[idx].checkProcess = "チェック"
                        self.sessionManager.timers = self.timers
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                            seatId: actualSeatId,
                            timers: self.timers,
                            mainTimer: self.sessionManager.mainTimer ?? self.mainTimer,
                            soundOn: self.sessionManager.alarmSoundEnabled,
                            currentUserName: self.currentUserName
                        )
                        WidgetSync.save(
                            timers: self.timers,
                            mainTimer: self.sessionManager.mainTimer ?? self.mainTimer,
                            userName: self.currentUserName,
                            forceReload: true
                        )
                        self.showNotification(text: "⏹ チェックタイマーを解除しました", color: Color(hex: "#8E8E93"))
                    }
                }
                self.immediatelyAcknowledgeSeatAlarm(for: preSeat, checkOnly: true)
                self.sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                if item.id != actualSeatId {
                    self.sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: clearedCheckEnd)
                }
                self.sessionManager.sendActionToPhone(action: "CANCEL_CHECK", seatId: actualSeatId, preActionSeat: preSeat)
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
            onAssignStaff: { checkProcess, staff in
                let cleanProc = SeatTimerItem.sanitizeCheckProcess(checkProcess)
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        let preActionSeat = self.timers[idx]
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        let isSelfCheck = SeatTimerItem.isStaffMe(staff, currentUserName: self.currentUserName)
                        let shouldSetCreatorToMe = preActionSeat.shouldClaimOrRefreshCreatorAsMe(currentUserName: self.currentUserName, myUid: self.sessionManager.cloudUserId)
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].checkProcess = cleanProc
                        self.timers[idx].checkStaff = staff
                        if shouldSetCreatorToMe {
                            self.timers[idx].applyCreatorAsMe(currentUserName: self.currentUserName, myUid: self.sessionManager.cloudUserId)
                        }
                        self.sessionManager.timers = self.timers
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.sessionManager.sendActionToPhone(action: "ASSIGN_HELP", seatId: actualSeatId, extra: ["checkStaffName": staff, "checkProcess": cleanProc, "isSubCheck": true], preActionSeat: preActionSeat)
                        self.showNotification(
                            text: isSelfCheck ? "📤 自分を【\(cleanProc)】担当に設定しました" : "📤 \(staff)さんを【\(cleanProc)】担当に指定しました",
                            color: Color(hex: "#30D158")
                        )
                    }
                }
            },
            onRecruitAll: { checkProcess in
                let cleanProc = SeatTimerItem.sanitizeCheckProcess(checkProcess)
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        let preActionSeat = self.timers[idx]
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        let shouldSetCreatorToMe = preActionSeat.shouldClaimOrRefreshCreatorAsMe(currentUserName: self.currentUserName, myUid: self.sessionManager.cloudUserId)
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].checkProcess = cleanProc
                        self.timers[idx].checkStaff = "募集中"
                        if shouldSetCreatorToMe {
                            self.timers[idx].applyCreatorAsMe(currentUserName: self.currentUserName, myUid: self.sessionManager.cloudUserId)
                        }
                        self.sessionManager.timers = self.timers
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.sessionManager.sendActionToPhone(action: "RECRUIT_HELP", seatId: actualSeatId, extra: ["helpProcess": cleanProc, "checkProcess": cleanProc, "isSubCheck": true], preActionSeat: preActionSeat)
                        self.showNotification(
                            text: "📢 【\(item.displaySeatName)】\(cleanProc)担当を全員に募集通知しました！",
                            color: Color(hex: "#FF9F0A")
                        )
                    }
                }
            },
            onClearStaff: {
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        let preActionSeat = self.timers[idx]
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].checkProcess = "チェック"
                        self.timers[idx].checkStaff = nil
                        self.sessionManager.timers = self.timers
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.sessionManager.sendActionToPhone(action: "ASSIGN_HELP", seatId: actualSeatId, extra: ["checkStaffName": "", "checkProcess": "チェック", "isSubCheck": true], preActionSeat: preActionSeat)
                        self.showNotification(
                            text: "👤 チェック担当を未定に戻しました",
                            color: Color(hex: "#8E8E93")
                        )
                    }
                }
            }
        )
    }
    
    @ViewBuilder
    private func shampooActionSheetView(item: SeatTimerItem) -> some View {
        ShampooActionSheet(
            item: item,
            currentUserName: currentUserName,
            onStartShampoo: {
                let preSeat = self.findSeatIndex(for: item).map { self.timers[$0] } ?? item
                let latestInSession = self.sessionManager.timers.first(where: { $0.id == preSeat.id || $0.seatNumber == preSeat.seatNumber }) ?? preSeat
                let isReplacedByNewRemoteTimer = latestInSession.isRunning
                    && latestInSession.targetEndTime > Date().addingTimeInterval(2.0)
                    && (!item.isRunning || abs(latestInSession.targetEndTime.timeIntervalSince(item.targetEndTime)) > 15.0)
                if isReplacedByNewRemoteTimer {
                    deferSeatSheetCloseAction {
                        if self.timers != self.sessionManager.timers && !self.sessionManager.timers.isEmpty {
                            self.timers = self.sessionManager.timers
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                    }
                    return
                }
                let actualSeatId = preSeat.id
                let stoppedEndTime = item.isRunning ? item.targetEndTime : preSeat.targetEndTime
                let expectedEndMs = item.isRunning ? (item.targetEndTime.timeIntervalSince1970 * 1000.0) : (preSeat.isRunning ? (preSeat.targetEndTime.timeIntervalSince1970 * 1000.0) : item.expectedEndMs)
                let clearedCheckEnd = preSeat.checkTargetEndTime ?? item.checkTargetEndTime
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].isRunning = false
                        self.timers[idx].pausedRemainingSeconds = 0
                        self.timers[idx].totalSeconds = 0
                        self.timers[idx].status = .shampoo
                        self.timers[idx].shampooStaff = self.currentUserName
                        self.timers[idx].helpProcess = "シャンプー"
                        self.timers[idx].isRecruiting = false
                        self.timers[idx].isNoHelpNeeded = false
                        self.timers[idx].isCollapsed = true
                        self.timers[idx].clearCheck()
                        self.sessionManager.timers = self.timers
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.showNotification(
                            text: "✅ 【\(item.displaySeatName)】自分がシャンプーに入りました",
                            color: Color(hex: "#30D158")
                        )
                    }
                }
                self.immediatelyAcknowledgeSeatAlarm(for: preSeat, checkOnly: false)
                self.sessionManager.markLocalStop(seatId: actualSeatId, endTime: stoppedEndTime)
                self.sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: true)
                if item.id != actualSeatId {
                    self.sessionManager.markLocalStop(seatId: item.id, endTime: stoppedEndTime)
                    self.sessionManager.setCollapseOverride(seatId: item.id, collapsed: true)
                }
                if let clearedCheckEnd = clearedCheckEnd {
                    self.sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                    if item.id != actualSeatId {
                        self.sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: clearedCheckEnd)
                    }
                }
                self.sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: actualSeatId, extra: ["expectedEnd": expectedEndMs, "isCompleted": true, "helpProcess": "シャンプー"])
            },
            onFinishShampoo: {
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].status = .normal
                        self.timers[idx].shampooStaff = nil
                        self.timers[idx].helpProcess = ""
                        self.timers[idx].isRecruiting = false
                        if !self.timers[idx].isRunning && self.timers[idx].pausedRemainingSeconds <= 0 {
                            self.timers[idx].createdBy = nil
                            self.timers[idx].creatorName = ""
                            self.timers[idx].isCreatorMeExplicit = nil
                        }
                        self.sessionManager.timers = self.timers
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.sessionManager.sendActionToPhone(action: "FINISH_SHAMPOO", seatId: actualSeatId)
                        self.showNotification(
                            text: "✅ 【\(item.displaySeatName)】シャンプー完了を全員へ通知しました",
                            color: Color(hex: "#30D158")
                        )
                    }
                }
            },
            onStartCombing: {
                let preSeat = self.findSeatIndex(for: item).map { self.timers[$0] } ?? item
                let latestInSession = self.sessionManager.timers.first(where: { $0.id == preSeat.id || $0.seatNumber == preSeat.seatNumber }) ?? preSeat
                let isReplacedByNewRemoteTimer = latestInSession.isRunning
                    && latestInSession.targetEndTime > Date().addingTimeInterval(2.0)
                    && (!item.isRunning || abs(latestInSession.targetEndTime.timeIntervalSince(item.targetEndTime)) > 15.0)
                if isReplacedByNewRemoteTimer {
                    deferSeatSheetCloseAction {
                        if self.timers != self.sessionManager.timers && !self.sessionManager.timers.isEmpty {
                            self.timers = self.sessionManager.timers
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                    }
                    return
                }
                let actualSeatId = preSeat.id
                let stoppedEndTime = item.isRunning ? item.targetEndTime : preSeat.targetEndTime
                let expectedEndMs = item.isRunning ? (item.targetEndTime.timeIntervalSince1970 * 1000.0) : (preSeat.isRunning ? (preSeat.targetEndTime.timeIntervalSince1970 * 1000.0) : item.expectedEndMs)
                let clearedCheckEnd = preSeat.checkTargetEndTime ?? item.checkTargetEndTime
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].isRunning = false
                        self.timers[idx].pausedRemainingSeconds = 0
                        self.timers[idx].totalSeconds = 0
                        self.timers[idx].status = .combing
                        self.timers[idx].shampooStaff = self.currentUserName
                        self.timers[idx].helpProcess = "コーミング"
                        self.timers[idx].isRecruiting = false
                        self.timers[idx].isNoHelpNeeded = false
                        self.timers[idx].isCollapsed = true
                        self.timers[idx].clearCheck()
                        self.sessionManager.timers = self.timers
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.showNotification(
                            text: "✅ 【\(item.displaySeatName)】自分がコーミングに入りました",
                            color: Color(hex: "#30D158")
                        )
                    }
                }
                self.immediatelyAcknowledgeSeatAlarm(for: preSeat, checkOnly: false)
                self.sessionManager.markLocalStop(seatId: actualSeatId, endTime: stoppedEndTime)
                self.sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: true)
                if item.id != actualSeatId {
                    self.sessionManager.markLocalStop(seatId: item.id, endTime: stoppedEndTime)
                    self.sessionManager.setCollapseOverride(seatId: item.id, collapsed: true)
                }
                if let clearedCheckEnd = clearedCheckEnd {
                    self.sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                    if item.id != actualSeatId {
                        self.sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: clearedCheckEnd)
                    }
                }
                self.sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: actualSeatId, extra: ["expectedEnd": expectedEndMs, "isCompleted": true, "helpProcess": "コーミング"])
            },
            onFinishCombing: {
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].status = .normal
                        self.timers[idx].shampooStaff = nil
                        self.timers[idx].helpProcess = ""
                        self.timers[idx].isRecruiting = false
                        if !self.timers[idx].isRunning && self.timers[idx].pausedRemainingSeconds <= 0 {
                            self.timers[idx].createdBy = nil
                            self.timers[idx].creatorName = ""
                            self.timers[idx].isCreatorMeExplicit = nil
                        }
                        self.sessionManager.timers = self.timers
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.sessionManager.sendActionToPhone(action: "UPDATE_STATUS", seatId: actualSeatId, extra: ["actionStatus": "normal", "isShampooing": false])
                        self.showNotification(
                            text: "✅ 【\(item.displaySeatName)】コーミング完了を全員へ通知しました",
                            color: Color(hex: "#30D158")
                        )
                    }
                }
            },
            onStartCheck: {
                let preSeat = self.findSeatIndex(for: item).map { self.timers[$0] } ?? item
                let latestInSession = self.sessionManager.timers.first(where: { $0.id == preSeat.id || $0.seatNumber == preSeat.seatNumber }) ?? preSeat
                let isReplacedByNewRemoteTimer = latestInSession.isRunning
                    && latestInSession.targetEndTime > Date().addingTimeInterval(2.0)
                    && (!item.isRunning || abs(latestInSession.targetEndTime.timeIntervalSince(item.targetEndTime)) > 15.0)
                if isReplacedByNewRemoteTimer {
                    deferSeatSheetCloseAction {
                        if self.timers != self.sessionManager.timers && !self.sessionManager.timers.isEmpty {
                            self.timers = self.sessionManager.timers
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                    }
                    return
                }
                let actualSeatId = preSeat.id
                let stoppedEndTime = item.isRunning ? item.targetEndTime : preSeat.targetEndTime
                let expectedEndMs = item.isRunning ? (item.targetEndTime.timeIntervalSince1970 * 1000.0) : (preSeat.isRunning ? (preSeat.targetEndTime.timeIntervalSince1970 * 1000.0) : item.expectedEndMs)
                let clearedCheckEnd = preSeat.checkTargetEndTime ?? item.checkTargetEndTime
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].isRunning = false
                        self.timers[idx].pausedRemainingSeconds = 0
                        self.timers[idx].totalSeconds = 0
                        self.timers[idx].status = .check
                        self.timers[idx].shampooStaff = self.currentUserName
                        self.timers[idx].helpProcess = "チェック"
                        self.timers[idx].isRecruiting = false
                        self.timers[idx].isNoHelpNeeded = false
                        self.timers[idx].isCollapsed = true
                        self.timers[idx].clearCheck()
                        self.sessionManager.timers = self.timers
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.showNotification(
                            text: "✅ 【\(item.displaySeatName)】自分がチェックに入りました",
                            color: Color(hex: "#30D158")
                        )
                    }
                }
                self.immediatelyAcknowledgeSeatAlarm(for: preSeat, checkOnly: false)
                self.sessionManager.markLocalStop(seatId: actualSeatId, endTime: stoppedEndTime)
                self.sessionManager.setCollapseOverride(seatId: actualSeatId, collapsed: true)
                if item.id != actualSeatId {
                    self.sessionManager.markLocalStop(seatId: item.id, endTime: stoppedEndTime)
                    self.sessionManager.setCollapseOverride(seatId: item.id, collapsed: true)
                }
                if let clearedCheckEnd = clearedCheckEnd {
                    self.sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                    if item.id != actualSeatId {
                        self.sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: clearedCheckEnd)
                    }
                }
                self.sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: actualSeatId, extra: ["expectedEnd": expectedEndMs, "isCompleted": true, "helpProcess": "チェック"])
            },
            onFinishCheck: {
                let preSeat = self.findSeatIndex(for: item).map { self.timers[$0] } ?? item
                let actualSeatId = preSeat.id
                let actualSeatNum = preSeat.seatNumber
                let clearedCheckEnd = preSeat.checkTargetEndTime ?? item.checkTargetEndTime
                let preservedCheckSec = max(60, preSeat.checkTotalSeconds ?? item.checkTotalSeconds ?? 60)
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].status = .normal
                        self.timers[idx].isCheckCompleted = true
                        self.timers[idx].checkStaff = self.currentUserName
                        self.timers[idx].checkTargetEndTime = nil
                        self.timers[idx].checkTotalSeconds = nil
                        if self.timers[idx].helpProcess == "チェック" {
                            self.timers[idx].helpProcess = ""
                            self.timers[idx].isRecruiting = false
                        }
                        self.sessionManager.timers = self.timers
                        WatchAlarmCoordinator.shared.restartRemainingTimerAfterCheck(
                            seatId: actualSeatId,
                            timers: self.timers,
                            mainTimer: self.sessionManager.mainTimer ?? self.mainTimer,
                            soundOn: self.sessionManager.alarmSoundEnabled,
                            currentUserName: self.currentUserName
                        )
                        WidgetSync.save(
                            timers: self.timers,
                            mainTimer: self.sessionManager.mainTimer ?? self.mainTimer,
                            userName: self.currentUserName,
                            forceReload: true
                        )
                        self.showNotification(
                            text: "✅ 【\(item.displaySeatName)】チェック完了を全員へ通知しました",
                            color: Color(hex: "#30D158")
                        )
                    }
                }
                self.immediatelyAcknowledgeSeatAlarm(for: preSeat, checkOnly: true)
                self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                self.sessionManager.markLocalCheckClear(seatId: actualSeatId, checkEndTime: clearedCheckEnd)
                if item.id != actualSeatId {
                    self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                    self.sessionManager.markLocalCheckClear(seatId: item.id, checkEndTime: clearedCheckEnd)
                }
                self.sessionManager.sendActionToPhone(action: "COMPLETE_CHECK", seatId: actualSeatId, extra: ["checkTotalSeconds": preservedCheckSec], preActionSeat: preSeat)
            },
            onChangeStaff: {
                deferSeatSheetCloseAction {
                    self.pendingMainTimerSheetActionBox.chainedSheetWorkItem?.cancel()
                    let work = DispatchWorkItem {
                        self.pendingMainTimerSheetActionBox.chainedSheetWorkItem = nil
                        guard self.scenePhase == .active, self.alarm.ringing.isEmpty else { return }
                        let prepared = self.prepareSheetTarget(for: item, cacheKey: "selectHelpStaff")
                        self.selectHelpStaffTargetId = prepared.id
                    }
                    self.pendingMainTimerSheetActionBox.chainedSheetWorkItem = work
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
                }
            },
            onClearStaff: {
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        let preActionSeat = self.timers[idx]
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        let oldStaff = self.timers[idx].shampooStaff ?? "担当者"
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].helpProcess = ""
                        self.timers[idx].shampooStaff = nil
                        self.timers[idx].status = .normal
                        self.timers[idx].isRecruiting = false
                        self.timers[idx].isNoHelpNeeded = false
                        self.sessionManager.timers = self.timers
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.sessionManager.sendActionToPhone(action: "CLEAR_STAFF", seatId: actualSeatId, preActionSeat: preActionSeat)
                        let isOldSelf = SeatTimerItem.isStaffMe(oldStaff, currentUserName: self.currentUserName)
                        self.showNotification(
                            text: isOldSelf ? "📤 自分の担当を解除しました" : "📤 \(oldStaff)さんに担当解除を通知しました",
                            color: Color(hex: "#8E8E93")
                        )
                    }
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
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        let preActionSeat = self.timers[idx]
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        let isSelfStaff = SeatTimerItem.isStaffMe(staff, currentUserName: self.currentUserName)
                        let shouldSetCreatorToMe = preActionSeat.shouldClaimOrRefreshCreatorAsMe(currentUserName: self.currentUserName, myUid: self.sessionManager.cloudUserId)
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].helpProcess = process
                        self.timers[idx].shampooStaff = staff
                        if process == "チェック" {
                            self.timers[idx].checkStaff = staff
                        }
                        self.timers[idx].isRecruiting = false
                        self.timers[idx].isNoHelpNeeded = false
                        if shouldSetCreatorToMe {
                            self.timers[idx].applyCreatorAsMe(currentUserName: self.currentUserName, myUid: self.sessionManager.cloudUserId)
                        }
                        self.sessionManager.timers = self.timers
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.sessionManager.sendActionToPhone(action: "ASSIGN_HELP", seatId: actualSeatId, extra: ["helpProcess": process, "assistantStaffName": staff], preActionSeat: preActionSeat)
                        self.showNotification(
                            text: isSelfStaff ? "📤 自分を【\(process)】担当に設定しました" : "📤 \(staff)さんに【\(process)】を通知しました",
                            color: Color(hex: "#0A84FF")
                        )
                    }
                }
            },
            onRecruitAll: { process in
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        let preActionSeat = self.timers[idx]
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        let shouldSetCreatorToMe = preActionSeat.shouldClaimOrRefreshCreatorAsMe(currentUserName: self.currentUserName, myUid: self.sessionManager.cloudUserId)
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].helpProcess = process
                        self.timers[idx].shampooStaff = nil
                        if process == "チェック" {
                            self.timers[idx].checkStaff = nil
                        }
                        self.timers[idx].isRecruiting = true
                        self.timers[idx].isNoHelpNeeded = false
                        if shouldSetCreatorToMe {
                            self.timers[idx].applyCreatorAsMe(currentUserName: self.currentUserName, myUid: self.sessionManager.cloudUserId)
                        }
                        if self.timers[idx].remainingSeconds <= 180 {
                            self.timers[idx].hasAlertedHelpUnassigned = true
                        }
                        self.sessionManager.timers = self.timers
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.sessionManager.sendActionToPhone(action: "RECRUIT_HELP", seatId: actualSeatId, extra: ["helpProcess": process], preActionSeat: preActionSeat)
                        // 募集するの場合は全員に通知する！
                        self.showNotification(
                            text: "📢 【\(item.displaySeatName)】\(process)担当を全員に募集通知しました！",
                            color: Color(hex: "#FF9F0A")
                        )
                    }
                }
            },
            onSetNoHelp: {
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        let preActionSeat = self.timers[idx]
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        let shouldSetCreatorToMe = preActionSeat.shouldClaimOrRefreshCreatorAsMe(currentUserName: self.currentUserName, myUid: self.sessionManager.cloudUserId)
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].helpProcess = ""
                        self.timers[idx].shampooStaff = nil
                        self.timers[idx].isRecruiting = false
                        self.timers[idx].isNoHelpNeeded = true
                        if shouldSetCreatorToMe {
                            self.timers[idx].applyCreatorAsMe(currentUserName: self.currentUserName, myUid: self.sessionManager.cloudUserId)
                        }
                        self.sessionManager.timers = self.timers
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.sessionManager.sendActionToPhone(action: "ASSIGN_HELP", seatId: actualSeatId, extra: ["helpProcess": "ヘルプなし", "assistantStaffName": "ヘルプなし"], preActionSeat: preActionSeat)
                        self.showNotification(
                            text: "👤 【\(item.displaySeatName)】ヘルプなし（一人施術）に設定しました",
                            color: Color(hex: "#8E8E93")
                        )
                    }
                }
            },
            onClearHelp: {
                deferSeatSheetCloseAction {
                    if let idx = self.findSeatIndex(for: item) {
                        let preActionSeat = self.timers[idx]
                        let actualSeatId = self.timers[idx].id
                        let actualSeatNum = self.timers[idx].seatNumber
                        self.pendingMainTimerSheetActionBox.skipNextTimersOnChangeSync = true
                        self.timers[idx].helpProcess = ""
                        self.timers[idx].shampooStaff = nil
                        self.timers[idx].isRecruiting = false
                        self.timers[idx].isNoHelpNeeded = false
                        if self.timers[idx].remainingSeconds <= 180 {
                            self.timers[idx].hasAlertedHelpUnassigned = true
                        }
                        self.sessionManager.timers = self.timers
                        self.sessionManager.markLocalSeatMod(seatId: actualSeatId, seatNumber: actualSeatNum)
                        if item.id != actualSeatId {
                            self.sessionManager.markLocalSeatMod(seatId: item.id, seatNumber: actualSeatNum)
                        }
                        self.syncSeatTimersState(forceWidgetReload: true)
                        self.sessionManager.sendActionToPhone(action: "CLEAR_STAFF", seatId: actualSeatId, preActionSeat: preActionSeat)
                        self.showNotification(
                            text: "👤 【\(item.displaySeatName)】ヘルプ指定を未定に戻しました",
                            color: Color(hex: "#8E8E93")
                        )
                    }
                }
            }
        )
    }
    
    private func checkUnassignedHelpAlerts() {
        var didMutate = false
        for idx in timers.indices {
            let rem = timers[idx].remainingSeconds
            let seatId = timers[idx].id
            if !timers[idx].isRunning || rem > 180 {
                alertedUnassignedHelpKeys = alertedUnassignedHelpKeys.filter { !$0.hasPrefix("\(seatId)|") }
                continue
            }
            if timers[idx].isRunning && timers[idx].totalSeconds > 180 && rem <= 180 && rem > 0 && timers[idx].shampooStaff == nil && !timers[idx].isNoHelpNeeded && !timers[idx].isRecruiting && !timers[idx].hasAlertedHelpUnassigned && timers[idx].shouldAlertMainTimer(for: currentUserName) {
                timers[idx].hasAlertedHelpUnassigned = true
                didMutate = true
                let alertKey = "\(seatId)|\(timers[idx].totalSeconds)"
                if !alertedUnassignedHelpKeys.contains(alertKey) {
                    alertedUnassignedHelpKeys.insert(alertKey)
                    let unassignedText = "🚨 【\(timers[idx].displaySeatName)】残り3分（ヘルプ未定）"
                    sessionManager.enqueuePeerConfirmationAlert(
                        id: "unassigned_\(alertKey)",
                        text: unassignedText,
                        colorHex: "#FF453A"
                    )
                    showNotification(
                        text: unassignedText,
                        color: Color(hex: "#FF453A"),
                        playHapticFeedback: true,
                        isRemotePeer: true
                    )
                }
            }
        }
        if didMutate {
            sessionManager.timers = timers
        }
    }
    
    private func binding(for id: String) -> Binding<SeatTimerItem> {
        // ★ `$timers[index]`（静的インデックス束縛）を完全廃止し、常に `id`（および席番号フォールバック）による動的検索 Binding を返す。
        //   これにより、カードやシート表示中にリモート同期・席削除・UUID昇格等で `timers` 配列の要素数や順序が変化しても
        //   `Swift/ContiguousArrayBuffer.swift: Index out of range`（SIGTRAP）が絶対に発生しない。
        let fallbackSeatNum: Int = {
            if let existing = self.timers.first(where: { $0.id == id }) ?? self.sessionManager.timers.first(where: { $0.id == id }) {
                return existing.seatNumber
            }
            if id.hasPrefix("seat-"), let n = Int(id.dropFirst(5)), n > 0 {
                return n
            }
            return 0
        }()
        return Binding(
            get: {
                if let match = self.timers.first(where: { $0.id == id }) {
                    return match
                }
                if fallbackSeatNum > 0, let matchByNum = self.timers.first(where: { $0.seatNumber == fallbackSeatNum }) {
                    return matchByNum
                }
                if let sessionMatch = self.sessionManager.timers.first(where: { $0.id == id }) {
                    return sessionMatch
                }
                if fallbackSeatNum > 0, let sessionByNum = self.sessionManager.timers.first(where: { $0.seatNumber == fallbackSeatNum }) {
                    return sessionByNum
                }
                return SeatTimerItem(
                    id: id,
                    seatNumber: max(1, fallbackSeatNum),
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
                } else if fallbackSeatNum > 0, let idxByNum = self.timers.firstIndex(where: { $0.seatNumber == fallbackSeatNum }) {
                    self.timers[idxByNum] = newValue
                } else if let idxByNewNum = self.timers.firstIndex(where: { $0.seatNumber == newValue.seatNumber }) {
                    self.timers[idxByNewNum] = newValue
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
        Group {
            if isCollapsed {
                collapsedMainCardView
            } else {
                expandedMainCardView
            }
        }
        .onChange(of: item.isRunning) { _, running in
            if running {
                isManuallyExpanded = false
            }
        }
        .onChange(of: item.isPreCountingDown) { _, pre in
            if pre {
                isManuallyExpanded = false
            }
        }
        .onChange(of: item.isZero) { _, zero in
            if zero {
                isManuallyExpanded = false
            }
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
            HStack(spacing: 5) {
                // 左側: タイトル
                HStack(spacing: 3) {
                    Image(systemName: "stopwatch.fill")
                        .font(.system(size: 11, weight: .bold))
                    Text("メインタイマー")
                        .font(.system(size: WatchLayout.font(13), weight: .bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                .foregroundColor(Color(hex: "#30D158"))
                
                // 待機中バッジ
                HStack(spacing: 3) {
                    Image(systemName: "clock")
                        .font(.system(size: 8))
                    Text("00:00")
                        .font(.system(size: 9.5, weight: .bold))
                        .lineLimit(1)
                }
                .foregroundColor(Color(hex: "#8E8E93"))
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Color.white.opacity(0.1))
                .cornerRadius(4)
                .fixedSize(horizontal: true, vertical: false)
                
                Spacer(minLength: 2)
                
                // 右側: 開く
                HStack(spacing: 2) {
                    Text("開く")
                        .font(.system(size: 10, weight: .bold))
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                }
                .foregroundColor(Color(hex: "#30D158"))
                .fixedSize(horizontal: true, vertical: false)
            }
            .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
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

    // ★ フル展開カード（共有タイマーの上2階層と同じUI構造: 1番目=タイマー数字、2番目=終了後メニュー選択）
    @ViewBuilder
    private var expandedMainCardView: some View {
        VStack(alignment: .leading, spacing: 6) {
            // ① ヘッダー
            HStack(spacing: 4) {
                Image(systemName: "stopwatch.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(Color(hex: "#30D158"))
                Text("メインタイマー")
                    .font(.system(size: WatchLayout.font(13), weight: .bold))
                    .foregroundColor(Color(hex: "#30D158"))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                
                if let genre = item.genre, !genre.isEmpty {
                    Text(genre)
                        .font(.system(size: 9.5, weight: .bold))
                        .foregroundColor(Color(hex: "#A0E0B0"))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1.5)
                        .background(Color(hex: "#30D158").opacity(0.2))
                        .cornerRadius(4)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                
                Spacer(minLength: 2)
                
                // 自分バッジ
                HStack(spacing: 2) {
                    Image(systemName: "star.fill")
                        .font(.system(size: 7))
                    Text("自分")
                        .font(.system(size: 9.5, weight: .heavy))
                        .lineLimit(1)
                }
                .foregroundColor(Color(hex: "#FFD60A"))
                .padding(.horizontal, 4)
                .padding(.vertical, 1.5)
                .background(Color(hex: "#FFD60A").opacity(0.18))
                .cornerRadius(4)
                .fixedSize(horizontal: true, vertical: false)
            }
            
            // ② 1番目（一番上）: タイム数字 ＆ プログレスバー（タップで操作・止める・メニューに入る等へ分岐）
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
                                .lineLimit(1)
                                .fixedSize()
                        } else if item.isPreCountingDown {
                            Text("準備中")
                                .font(.system(size: 12, weight: .heavy))
                                .foregroundColor(Color(hex: "#FFD60A"))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        Text(formatSeconds(item.isPreCountingDown ? item.prepRemainingSeconds : abs(item.remainingSeconds)))
                            .font(.system(size: WatchLayout.font(32), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(
                                item.isOvertime ? Color(hex: "#FF453A") :
                                (item.isPreCountingDown ? Color(hex: "#FFD60A") : Color(hex: "#30D158"))
                            )
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    
                    HStack(spacing: 4) {
                        Image(systemName: "timer")
                            .font(.system(size: 9))
                        Text("\(item.totalSeconds / 60)分設定")
                            .font(.system(size: 10, weight: .semibold))
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                        if item.isOvertime {
                            Text("• タップで止める・タイム終了 >")
                                .font(.system(size: 9.5, weight: .heavy))
                                .foregroundColor(Color(hex: "#FFD60A"))
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                        } else if item.isPreCountingDown {
                            Text("• ⏳ カウントダウン中")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(Color(hex: "#FFD60A"))
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                        } else if !item.isRunning {
                            Text("• ⏸️ 停止中")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(Color(hex: "#FF9F0A"))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        } else {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 8))
                                .foregroundColor(Color(hex: "#8E8E93"))
                        }
                    }
                    .foregroundColor(item.isOvertime ? Color(hex: "#FF857D") : Color(hex: "#A0E0B0"))
                    .frame(maxWidth: .infinity, alignment: .center)
                    
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
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(item.isOvertime ? Color(hex: "#FF453A").opacity(0.18) : Color(hex: "#30D158").opacity(0.15))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(item.isOvertime ? Color(hex: "#FF453A").opacity(0.5) : Color(hex: "#30D158").opacity(0.45), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
        }
        .padding(WatchLayout.cardPadding)
        .background(Color(hex: "#1C1C1E"))
        .cornerRadius(14)
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(cardBorderColor, lineWidth: 1.5)
        )
        .padding(.horizontal, WatchLayout.isSmall ? 2 : 4)
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
        if SeatTimerItem.isStaffMe(item.shampooStaff, currentUserName: currentUserName) {
            return "⭐️ 自分シャンプー"
        } else if SeatTimerItem.isStaffMe(item.checkStaff, currentUserName: currentUserName) {
            return "⭐️ 自分チェック"
        } else if item.isCreatorMe(currentUserName: currentUserName) {
            return "⭐️ 自分作成"
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
            HStack(spacing: 5) {
                // 左側: 席番号
                HStack(spacing: 3) {
                    Image(systemName: "applewatch")
                        .font(.system(size: 11, weight: .bold))
                    Text(item.displaySeatName)
                        .font(.system(size: WatchLayout.font(13), weight: .heavy))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                .foregroundColor(.white)
                
                // 状態バッジ (施術中ステータスがある場合は工程＋担当者、それ以外は00:00)
                if item.status != .normal {
                    let staffDisp = (item.shampooStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? ""
                        : ":\(SeatTimerItem.displayStaffName(item.shampooStaff ?? "", currentUserName: currentUserName))"
                    let statusBadgeText: String = {
                        switch item.status {
                        case .shampoo:
                            return "💧 SP\(staffDisp)"
                        case .combing:
                            return "🪮 コーミング\(staffDisp)"
                        case .check:
                            return "🔍 チェック\(staffDisp)"
                        case .normal:
                            return "00:00"
                        }
                    }()
                    let badgeColor: Color = (item.status == .check) ? Color(hex: "#30D158") : Color(hex: "#64D2FF")
                    Text(statusBadgeText)
                        .font(.system(size: 9.5, weight: .heavy))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                        .foregroundColor(badgeColor)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(badgeColor.opacity(0.18))
                        .cornerRadius(4)
                } else {
                    HStack(spacing: 3) {
                        Image(systemName: item.isZero ? "clock" : "stop.circle.fill")
                            .font(.system(size: 8))
                        Text("00:00")
                            .font(.system(size: 9.5, weight: .bold))
                            .lineLimit(1)
                    }
                    .foregroundColor(Color(hex: "#8E8E93"))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color.white.opacity(0.1))
                    .cornerRadius(4)
                    .fixedSize(horizontal: true, vertical: false)
                }
                
                Spacer(minLength: 2)
                
                // 右側: 開く
                HStack(spacing: 2) {
                    Text("開く")
                        .font(.system(size: 10, weight: .bold))
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                }
                .foregroundColor(Color(hex: "#64D2FF"))
                .fixedSize(horizontal: true, vertical: false)
            }
            .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
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
        .padding(WatchLayout.cardPadding)
        .background(Color(hex: "#1C1C1E"))
        .cornerRadius(14)
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke((item.isOvertime || item.isCheckOvertime) ? Color(hex: "#FF453A").opacity(0.6) : (isRelatedToMe ? Color(hex: "#FFD60A").opacity(0.4) : Color.white.opacity(0.12)), lineWidth: isRelatedToMe ? 1.5 : 1)
        )
    }
    
    // MARK: - ① ヘッダー部
    @ViewBuilder
    private var headerSection: some View {
        HStack(alignment: .center, spacing: 4) {
            // 席番号（左側: 見切れそうになったら縮小または「...」で省略）
            HStack(spacing: 3) {
                Image(systemName: "applewatch")
                    .font(.system(size: 11, weight: .bold))
                Text(item.displaySeatName)
                    .font(.system(size: WatchLayout.font(14), weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .truncationMode(.tail)
            }
            .foregroundColor(.white)
            .layoutPriority(0)
            
            Spacer(minLength: 4)
            
            // 担当表示（右上に寄せる: 1行維持で文字潰れを防止）
            creatorRoleBadge
                .layoutPriority(1)
        }
    }
    
    @ViewBuilder
    private var creatorRoleBadge: some View {
        if item.isCreatorMe(currentUserName: currentUserName) {
            // 自分が作成者の場合: 「⭐️ 担当: 自分」
            HStack(spacing: 3) {
                Image(systemName: "star.fill")
                    .font(.system(size: 8))
                    .foregroundColor(Color(hex: "#FFD60A"))
                Text("担当: 自分")
                    .font(.system(size: WatchLayout.font(11), weight: .heavy))
                    .foregroundColor(Color(hex: "#FFD60A"))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Color(hex: "#FFD60A").opacity(0.18))
            .cornerRadius(6)
            .fixedSize(horizontal: true, vertical: false)
        } else if SeatTimerItem.isStaffMe(item.shampooStaff, currentUserName: currentUserName) || SeatTimerItem.isStaffMe(item.checkStaff, currentUserName: currentUserName) {
            // 他人作成で自分がヘルプの場合: 「担当: 佐藤 ★自分」
            HStack(spacing: 3) {
                Text("担当: \(item.displayCreatorName(currentUserName: currentUserName))")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(Color(hex: "#E5E5EA"))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                
                HStack(spacing: 2) {
                    Image(systemName: "star.fill")
                        .font(.system(size: 7))
                    Text("自分")
                        .font(.system(size: 9, weight: .heavy))
                        .lineLimit(1)
                }
                .foregroundColor(Color(hex: "#FFD60A"))
                .padding(.horizontal, 3.5)
                .padding(.vertical, 1.5)
                .background(Color(hex: "#FFD60A").opacity(0.18))
                .cornerRadius(4)
                .fixedSize(horizontal: true, vertical: false)
            }
        } else {
            // 他人が担当の席: 「担当: ヤマモト」
            Text("担当: \(item.displayCreatorName(currentUserName: currentUserName))")
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(Color(hex: "#C7C7CC"))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .padding(.horizontal, 5)
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
                            .lineLimit(1)
                            .fixedSize()
                    }
                    
                    Text(formatSeconds(abs(item.remainingSeconds)))
                        .font(.system(size: WatchLayout.font(32), weight: .black, design: .rounded))
                        .monospacedDigit()
                        .foregroundColor(item.isOvertime ? Color(hex: "#FF453A") : Color(hex: "#64D2FF"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity, alignment: .center)
                
                // カウント時間の下に全体タイムを小さく中央表示
                HStack(spacing: 4) {
                    Image(systemName: "timer")
                        .font(.system(size: 9))
                    Text("\(item.totalSeconds / 60)分設定")
                        .font(.system(size: 10, weight: .semibold))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                    
                    if item.isOvertime {
                        Text("• タップで止める・タイム終了 >")
                            .font(.system(size: 9.5, weight: .heavy))
                            .foregroundColor(Color(hex: "#FFD60A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    } else if !item.isRunning {
                        Text("• ⏸️ 停止中")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(Color(hex: "#FF9F0A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
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
            .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(timerCardBackground)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(timerCardStroke, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
    
    // MARK: - ③ シャンプー・ヘルプ担当部
    private var isShampooOrCombing: Bool {
        item.status == .shampoo || item.status == .combing || item.status == .check
    }

    private var shampooStatusIcon: String {
        if item.status == .shampoo {
            return "drop.fill"
        } else if item.status == .combing || item.helpProcess == "コーミング" {
            return "comb.fill"
        } else if item.status == .check || item.helpProcess == "チェック" {
            return "magnifyingglass"
        } else {
            return "drop.fill"
        }
    }
    
    private var shampooStatusTitle: String {
        if item.status == .shampoo {
            return "流し中:"
        } else if item.status == .combing {
            return "コーミング中:"
        } else if item.status == .check {
            return "チェック中:"
        } else {
            let p = item.helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
            return "\(p.isEmpty ? "ヘルプ" : p):"
        }
    }

    private func staffButtonBackground(staff: String) -> Color {
        if isShampooOrCombing {
            return Color(hex: "#0A84FF").opacity(0.3)
        } else if SeatTimerItem.isStaffMe(staff, currentUserName: currentUserName) {
            return Color(hex: "#FFD60A").opacity(0.14)
        } else {
            return Color.white.opacity(0.08)
        }
    }

    private func staffButtonStroke(staff: String) -> Color {
        if isShampooOrCombing {
            return Color(hex: "#0A84FF").opacity(0.7)
        } else if SeatTimerItem.isStaffMe(staff, currentUserName: currentUserName) {
            return Color(hex: "#FFD60A").opacity(0.4)
        } else {
            return Color.white.opacity(0.12)
        }
    }

    @ViewBuilder
    private func staffAssignedButton(staff: String) -> some View {
        let isMe = SeatTimerItem.isStaffMe(staff, currentUserName: currentUserName)
        let displayStaff = SeatTimerItem.displayStaffName(staff, currentUserName: currentUserName)
        Button(action: onOpenSelectHelpStaff) {
            HStack(spacing: 4) {
                Image(systemName: shampooStatusIcon)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(isShampooOrCombing ? .white : Color(hex: "#0A84FF"))
                
                Text(shampooStatusTitle)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(Color(hex: "#C0C0C8"))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                
                Text(displayStaff)
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundColor(isMe ? Color(hex: "#FFD60A") : .white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                
                Spacer(minLength: 2)
                
                HStack(spacing: 2) {
                    Text(isShampooOrCombing ? "施術中" : "変更")
                        .font(.system(size: 9, weight: .semibold))
                        .lineLimit(1)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                }
                .foregroundColor(isShampooOrCombing ? Color.white.opacity(0.8) : Color(hex: "#8E8E93"))
                .fixedSize(horizontal: true, vertical: false)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
            .padding(.vertical, 7)
            .background(staffButtonBackground(staff: staff))
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(staffButtonStroke(staff: staff), lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
    
    @ViewBuilder
    private var helpStaffSection: some View {
        // ★ 00:00席（施術中ステータスなし）およびアコーディオン収納席はヘルプを完全解除・非表示
        if (item.isZero && item.status == .normal) || item.isCollapsed {
            EmptyView()
        } else if let staff = item.shampooStaff, !staff.isEmpty {
            staffAssignedButton(staff: staff)
        } else if item.status != .normal {
            staffAssignedButton(staff: "担当者")
        } else if item.isRecruiting {
            // ★ 全員に募集中！
            Button(action: onOpenSelectHelpStaff) {
                HStack(spacing: 4) {
                    Image(systemName: "megaphone.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(Color(hex: "#FF9F0A"))
                    
                    let p = item.helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
                    Text("\(p.isEmpty ? "ヘルプ" : p): 募集中")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundColor(Color(hex: "#FFD60A"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    
                    Spacer(minLength: 2)
                    
                    Text("私が入る >")
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundColor(Color(hex: "#FF9F0A"))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                .padding(.vertical, 7)
                .background(Color(hex: "#FF9F0A").opacity(0.2))
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color(hex: "#FF9F0A").opacity(0.7), lineWidth: 1)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            
        } else if item.isNoHelpNeeded {
            Button(action: onOpenSelectHelpStaff) {
                HStack(spacing: 4) {
                    Image(systemName: "person.fill")
                        .font(.system(size: 10))
                    Text("👤 ヘルプなし (ワンマン)")
                        .font(.system(size: 10, weight: .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(Color.white.opacity(0.06))
                .foregroundColor(Color(hex: "#8E8E93"))
                .cornerRadius(8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            
        } else if !item.isZero {
            // 指定なし ➔ タイマー稼働中・設定時のみ「ヘルプを指定してください」を表示
            Button(action: onOpenSelectHelpStaff) {
                HStack(spacing: 4) {
                    Image(systemName: "person.crop.circle.badge.plus")
                        .font(.system(size: 11, weight: .bold))
                    Text("ヘルプを指定してください")
                        .font(.system(size: 11, weight: .heavy))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Spacer(minLength: 2)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                .padding(.vertical, 7)
                .background(Color(hex: "#FF9F0A").opacity(0.18))
                .foregroundColor(Color(hex: "#FFD60A"))
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color(hex: "#FF9F0A").opacity(0.55), lineWidth: 1)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
    
    // MARK: - ④ 3番目: チェックのタイマーの数字 ＋ その下にチェックに入る人の名前を入れる場所
    @ViewBuilder
    private var checkTimerSection: some View {
        if let checkSec = item.checkRemainingSeconds {
            let chkProc = item.displayCheckProcess
            let isCheckOver = item.isCheckOvertime
            VStack(spacing: 5) {
                // 上段: チェックのタイマーの数字（タップでチェック完了・解除などの操作シートへ分岐）
                Button(action: onOpenCheckAction) {
                    HStack(alignment: .center, spacing: 4) {
                        Image(systemName: item.checkProcessIconName)
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(isCheckOver ? Color(hex: "#FF453A") : Color(hex: item.checkProcessColorHex))
                        Text(isCheckOver ? "\(chkProc)超過" : chkProc)
                            .font(.system(size: 10.5, weight: .heavy))
                            .foregroundColor(isCheckOver ? Color(hex: "#FF453A") : Color(hex: "#A0E0B0"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .fixedSize(horizontal: true, vertical: false)
                        Spacer(minLength: 2)
                        Text(isCheckOver ? "+\(formatSeconds(item.checkOvertimeSeconds))" : formatSeconds(checkSec))
                            .font(.system(size: WatchLayout.font(18), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(isCheckOver ? Color(hex: "#FF453A") : Color(hex: "#30D158"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundColor(Color(hex: "#8E8E93"))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                    .padding(.vertical, 5)
                    .background(isCheckOver ? Color(hex: "#FF453A").opacity(0.20) : Color(hex: "#30D158").opacity(0.15))
                    .cornerRadius(7)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                
                // 下段（チェックのタイマーの数字の下）: チェックに入るべき人の名前を入れる場所
                if let cStaff = item.checkStaff, !cStaff.isEmpty {
                    Button(action: onOpenSelectCheckStaff) {
                        HStack(spacing: 4) {
                            if cStaff == "募集中" {
                                Image(systemName: "megaphone.fill")
                                    .font(.system(size: 9.5, weight: .bold))
                                    .foregroundColor(Color(hex: "#FF9F0A"))
                                Text("\(chkProc): 全員に募集中")
                                    .font(.system(size: 10.5, weight: .heavy))
                                    .foregroundColor(Color(hex: "#FFD60A"))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.72)
                            } else {
                                let displayStaff = SeatTimerItem.displayStaffName(cStaff, currentUserName: currentUserName)
                                Image(systemName: "person.fill.checkmark")
                                    .font(.system(size: 9.5, weight: .bold))
                                    .foregroundColor(Color(hex: "#30D158"))
                                Text("\(chkProc): \(displayStaff)")
                                    .font(.system(size: 10.5, weight: .heavy))
                                    .foregroundColor(.white)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.72)
                            }
                            Spacer(minLength: 2)
                            Text("変更 >")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(Color(hex: "#8E8E93"))
                                .lineLimit(1)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                        .padding(.vertical, 6)
                        .background(Color.white.opacity(0.10))
                        .cornerRadius(7)
                        .overlay(
                            RoundedRectangle(cornerRadius: 7)
                                .stroke(Color(hex: "#30D158").opacity(0.4), lineWidth: 1)
                        )
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    Button(action: onOpenSelectCheckStaff) {
                        HStack(spacing: 4) {
                            Image(systemName: "person.badge.plus")
                                .font(.system(size: 10, weight: .bold))
                            Text("チェック担当を指名・募集")
                                .font(.system(size: 10.5, weight: .heavy))
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                            Spacer(minLength: 2)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 8.5, weight: .bold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                        .padding(.vertical, 6)
                        .background(Color(hex: "#FF9F0A").opacity(0.25))
                        .foregroundColor(Color(hex: "#FFD60A"))
                        .cornerRadius(7)
                        .overlay(
                            RoundedRectangle(cornerRadius: 7)
                                .stroke(Color(hex: "#FF9F0A").opacity(0.6), lineWidth: 1)
                        )
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(WatchLayout.isSmall ? 5 : 7)
            .background(Color(hex: "#30D158").opacity(0.10))
            .cornerRadius(10)
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(Color(hex: "#30D158").opacity(0.38), lineWidth: 1)
            )
        } else if item.isCheckCompleted {
            HStack(spacing: 4) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 10))
                Text("\(item.displayCheckProcess)完了")
                    .font(.system(size: 10, weight: .bold))
                    .lineLimit(1)
                if let cStaff = item.checkStaff {
                    Text("(\(SeatTimerItem.displayStaffName(cStaff, currentUserName: currentUserName)))")
                        .font(.system(size: 10))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
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
    
    // 0.5秒周期のカウントアップ更新（常時稼働 WatchRealtimeClock）
    @State private var now = Date()
    
    // 超過秒数のフォーマット（MM:SS）
    var overtimeFormatted: String {
        let sec = abs(min(0, safeClampedSeconds(item.targetEndTime.timeIntervalSince(now))))
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
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
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
                
                if false { // ③ ボタン2（一本化により非表示）
                Button(action: {
                    playHaptic(.directionUp)
                    onResetZero()
                    dismiss()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 13, weight: .bold))
                        Text("タイマーを止める")
                            .font(.system(size: 13, weight: .bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
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
                
                }
                // ④ ボタン3: 「タイマーを止める」ボタン（一本化・アコーディオンをしまう）
                Button(action: {
                    playHaptic(.stop)
                    onFinishMeasure()
                    dismiss()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 13, weight: .bold))
                        Text("タイマーを止める")
                            .font(.system(size: 13, weight: .bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
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
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.bottom, 6)
        }
        .onAppear {
            now = Date()
        }
        .onReceive(WatchRealtimeClock.shared.publisher) { input in
            now = input
        }
    }
    
    private func playHaptic(_ type: WKHapticType) {
        WKInterfaceDevice.current().play(type)
    }
}

// MARK: - メインタイマー専用操作・時間選択シート（共有タイマーの上2階層と同じUI構造・サブタイマーなし）
struct MainTimerActionSheet: View {
    enum SubMode {
        case standard
        case timerActionBranch
        case reinput
    }
    
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
    
    @State private var watchSoundEnabled: Bool = UserDefaults.standard.object(forKey: "assisttimer.mainTimerWatchSound.v2") as? Bool ?? false
    @State private var phoneSoundEnabled: Bool = UserDefaults.standard.object(forKey: "assisttimer.mainTimerPhoneSound.v2") as? Bool ?? false
    // ★ 共有タイマーと同じ累積追加・減少秒数（何回も連打可能）
    @State private var accumulatedDelta: Int = 0
    // ★ シート内サブ画面モード
    @State private var subMode: SubMode
    @State private var crownSeconds: Double = 600.0
    @State private var now = Date()
    @State private var isClosingSheet: Bool = false

    private func closeSheetAfter(_ action: () -> Void) {
        guard !isClosingSheet else { return }
        isClosingSheet = true
        action()
        dismiss()
        // 万一 watchOS 側の通知割り込み等でシート閉鎖アニメーションがキャンセルされてもボタンがロックされない安全フェイルセーフ
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if isClosingSheet {
                isClosingSheet = false
            }
        }
    }
    
    // クイック分数選択ボタン（定番タイム）
    let quickMinutes = [1, 3, 5, 10, 15, 20, 25, 30, 45]
    
    init(
        item: SeatTimerItem,
        initialSubMode: SubMode? = nil,
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
        if initialItem.isOvertime {
            self._subMode = State(initialValue: .timerActionBranch)
        } else if let explicitMode = initialSubMode {
            self._subMode = State(initialValue: explicitMode)
        } else if initialItem.isZero {
            // ★ 00:00（未稼働・リセット状態）で開いた時は共有タイマーと同じく最初からトグル（Digital Crown）入力モードで開く
            self._subMode = State(initialValue: .reinput)
        } else {
            self._subMode = State(initialValue: .timerActionBranch)
        }
        self._crownSeconds = State(initialValue: initialItem.isZero ? 0.0 : Double(initSec))
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
            return max(0, safeClampedCeilSeconds(currentItem.targetEndTime.timeIntervalSince(now)))
        } else if isOvertime {
            return abs(min(0, safeClampedSeconds(currentItem.targetEndTime.timeIntervalSince(now))))
        } else {
            return max(0, currentItem.pausedRemainingSeconds)
        }
    }
    
    var baseAdjustmentSeconds: Int {
        if isRunning || isOvertime {
            return currentSeconds
        }
        return currentSeconds > 0 ? currentSeconds : max(10, currentItem.totalSeconds)
    }
    
    // 現在の残り秒数 ＋ 累積追加秒数（リアルタイム反映。停止中・リセット後は00:00を表示し、調整操作時は設定秒数を基準に増減）
    var currentDisplaySeconds: Int {
        if isOvertime {
            return max(0, accumulatedDelta)
        }
        if !isRunning && currentSeconds == 0 && accumulatedDelta == 0 {
            return 0
        }
        return max(10, baseAdjustmentSeconds + accumulatedDelta)
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
            switch subMode {
            case .reinput:
                unifiedMainReinputScrollView
            case .timerActionBranch:
                mainTimerActionBranchScrollView
            case .standard:
                standardMainActionScrollView
            }
        }
        .onAppear {
            now = Date()
        }
        .onReceive(WatchRealtimeClock.shared.publisher) { input in
            guard !isClosingSheet else { return }
            now = input
            if let latest = WatchSessionManager.shared.mainTimer {
                let wasActive = displayItem.isRunning || displayItem.isPreCountingDown
                let wasPausedNonZero = !wasActive && !displayItem.isZero
                if (wasActive && !latest.isRunning && !latest.isPreCountingDown) ||
                   (wasPausedNonZero && !latest.isRunning && !latest.isPreCountingDown && latest.isZero) {
                    isClosingSheet = true
                    dismiss()
                    return
                }
                if subMode != .reinput, accumulatedDelta == 0, latest != displayItem {
                    displayItem = latest
                }
            }
            if subMode == .standard && isOvertime && accumulatedDelta <= 0 {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    subMode = .timerActionBranch
                }
            }
        }
        .onReceive(WatchSessionManager.shared.$mainTimer) { latest in
            guard !isClosingSheet, let latest = latest else { return }
            let wasActive = displayItem.isRunning || displayItem.isPreCountingDown
            let wasPausedNonZero = !wasActive && !displayItem.isZero
            if (wasActive && !latest.isRunning && !latest.isPreCountingDown) ||
               (wasPausedNonZero && !latest.isRunning && !latest.isPreCountingDown && latest.isZero) {
                isClosingSheet = true
                dismiss()
                return
            }
            if subMode != .reinput && accumulatedDelta == 0 && latest != displayItem {
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
                        if currentItem.isZero {
                            dismiss()
                        } else {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                subMode = .timerActionBranch
                            }
                        }
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        HStack(spacing: 2) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text("戻る")
                                .font(.system(size: 11, weight: .bold))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .foregroundColor(Color(hex: "#FFD60A"))
                    }
                    .buttonStyle(.plain)
                    
                    Spacer(minLength: 4)
                    
                    Text("メインタイマー設定")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    
                    Spacer(minLength: 4)
                }
                .padding(.horizontal, 4)
                
                // ② ００:００の巨大デジタル表示エリア（分・秒をそれぞれタップしてリューズで入力）
                CrownMinSecPicker(
                    totalSeconds: Binding(
                        get: { safeClampedSeconds(crownSeconds) },
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
                            .lineLimit(1)
                            .minimumScaleFactor(0.65)
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
                                .lineLimit(1)
                                .minimumScaleFactor(0.65)
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
                                .lineLimit(1)
                                .minimumScaleFactor(0.68)
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
                
                // ⑤ 決定ボタン（★時間が1秒以上設定された時は「決定」、00:00時は前回設定分数でのワンタップスタートも表示）
                if safeClampedSeconds(crownSeconds) > 0 {
                    Button(action: {
                        let sec = max(10, safeClampedSeconds(crownSeconds))
                        WKInterfaceDevice.current().play(.click)
                        closeSheetAfter {
                            onSetTime(sec)
                        }
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 12, weight: .heavy))
                            Text("決定 (\(formatSeconds(safeClampedSeconds(crownSeconds))))")
                                .font(.system(size: 12, weight: .black))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
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
                } else if currentItem.totalSeconds > 0 {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        closeSheetAfter {
                            onStart()
                        }
                    }) {
                        HStack(spacing: 5) {
                            Image(systemName: "play.fill")
                                .font(.system(size: 12, weight: .bold))
                            Text("前回設定 (\(max(1, currentItem.totalSeconds / 60))分) でスタート")
                                .font(.system(size: 11, weight: .heavy))
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(Color(hex: "#30D158"))
                        .foregroundColor(.black)
                        .cornerRadius(8)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 2)
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
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Spacer()
                }
                .padding(.horizontal, 4)
                
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 5) {
                    ForEach(quickMinutes, id: \.self) { min in
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            closeSheetAfter {
                                onSetTime(min * 60)
                            }
                        }) {
                            Text("\(min)分")
                                .font(.system(size: 13, weight: .heavy))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
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
                
                watchSoundToggleButton
                phoneSoundToggleButton
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
    }
    
    // MARK: - ★ 標準操作画面
    @ViewBuilder
    private var standardMainActionScrollView: some View {
        ScrollView {
            VStack(spacing: 6) {
                mainStandardTopTimerSection
                
                Divider()
                    .padding(.vertical, 2)
                
                watchSoundToggleButton
                phoneSoundToggleButton
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
    }
    
    @ViewBuilder
    private var mainStandardTopTimerSection: some View {
        HStack(spacing: 4) {
            Text("メインタイマーの操作")
                .font(.system(size: 12, weight: .heavy))
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Spacer(minLength: 4)
            Text("全体: \(currentItem.totalSeconds / 60)分")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.gray)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 4)
        
        Divider()
            .padding(.vertical, 1)
        
        // ★ 1番目（一番上）: タイマーの数字のみ表示（タップで「タイマーを止める」「シャンプーに入る」等の分岐画面へ）
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                subMode = .timerActionBranch
            }
        }) {
            HStack(alignment: .center, spacing: 6) {
                Image(systemName: "timer")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(isOvertime ? Color(hex: "#FF453A") : Color(hex: "#30D158"))
                
                if isOvertime && accumulatedDelta <= 0 {
                    Text("超過 +\(formatSeconds(currentSeconds))")
                        .font(.system(size: WatchLayout.font(20), weight: .black, design: .rounded))
                        .monospacedDigit()
                        .foregroundColor(Color(hex: "#FF453A"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                } else if currentItem.isPreCountingDown {
                    Text("準備中 \(formatSeconds(currentItem.prepRemainingSeconds))")
                        .font(.system(size: WatchLayout.font(18), weight: .black, design: .rounded))
                        .monospacedDigit()
                        .foregroundColor(Color(hex: "#FFD60A"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                } else {
                    Text(formatSeconds(currentDisplaySeconds))
                        .font(.system(size: WatchLayout.font(22), weight: .black, design: .rounded))
                        .monospacedDigit()
                        .foregroundColor(Color(hex: "#30D158"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                
                Spacer(minLength: 4)
                
                HStack(spacing: 2) {
                    Text("操作")
                        .font(.system(size: 10, weight: .bold))
                        .lineLimit(1)
                        .fixedSize()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                }
                .foregroundColor(Color(hex: "#8E8E93"))
                .fixedSize(horizontal: true, vertical: false)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 9)
                    .fill(isOvertime ? Color(hex: "#FF453A").opacity(0.20) : Color(hex: "#30D158").opacity(0.18))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9)
                    .stroke(isOvertime ? Color(hex: "#FF453A").opacity(0.55) : Color(hex: "#30D158").opacity(0.5), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
    
    // MARK: - ★ タイマーの数字をタップした時の分岐画面（「タイマーを止める」等）
    @ViewBuilder
    private var mainTimerActionBranchScrollView: some View {
        ScrollView {
            VStack(spacing: 7) {
                HStack {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        dismiss()
                    }) {
                        HStack(spacing: 2) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text("戻る")
                                .font(.system(size: 11, weight: .bold))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .foregroundColor(Color(hex: "#30D158"))
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 4)
                    Text("メインタイマー")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Spacer(minLength: 4)
                }
                .padding(.horizontal, 4)
                
                // 現在のタイム表示（どのタイマーか一目でわかるよう「メインタイマー」バッジを大きく表示）
                VStack(spacing: 3) {
                    HStack(spacing: 4) {
                        Image(systemName: "stopwatch.fill")
                            .font(.system(size: 12, weight: .heavy))
                            .foregroundColor(isOvertime && accumulatedDelta <= 0 ? Color(hex: "#FF453A") : Color(hex: "#30D158"))
                        Text("メインタイマー")
                            .font(.system(size: WatchLayout.font(15), weight: .black, design: .rounded))
                            .foregroundColor(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 3)
                    .background(
                        Capsule()
                            .fill(isOvertime && accumulatedDelta <= 0 ? Color(hex: "#FF453A").opacity(0.28) : Color(hex: "#30D158").opacity(0.22))
                    )
                    .overlay(
                        Capsule()
                            .stroke(isOvertime && accumulatedDelta <= 0 ? Color(hex: "#FF453A").opacity(0.75) : Color(hex: "#30D158").opacity(0.6), lineWidth: 1)
                    )

                    if isOvertime && accumulatedDelta <= 0 {
                        Text("超過 +\(formatSeconds(currentSeconds))")
                            .font(.system(size: WatchLayout.font(23), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#FF453A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    } else {
                        Text(formatSeconds(currentDisplaySeconds))
                            .font(.system(size: WatchLayout.font(26), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#30D158"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                }
                .padding(.vertical, 2)
                
                // ★ 超過中は「タイマーを止める」を最上部（超過タイムの直下）に配置してスクロール無しで即座に押せるようにする
                if isOvertime && accumulatedDelta <= 0 {
                    mainActionStopTimerButton
                }
                
                // ★ 微調整ボタン（+1分 / +3分 / +5分、-30秒 / +30秒）
                mainActionDeltaButtonsSection
                
                if accumulatedDelta != 0 {
                    mainActionConfirmSection
                }
                
                // ★ 通常カウントダウン中・または時間延長操作中は微調整ボタンの下に「タイマーを止める」を配置
                if !isOvertime || accumulatedDelta > 0 {
                    mainActionStopTimerButton
                }
                
                // ★ 「タイマーを止める」の下に「タイム再入力。」を配置
                mainActionReinputButton
                
                // ③ 稼働中（超過前）の一時停止 / 停止中の再開
                if !isOvertime && !currentItem.isPreCountingDown {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        let currentlyRunning = isRunning
                        closeSheetAfter {
                            if currentlyRunning {
                                onPause()
                            } else {
                                onStart()
                            }
                        }
                    }) {
                        HStack(spacing: 5) {
                            Image(systemName: isRunning ? "pause.fill" : "play.fill")
                                .font(.system(size: 12, weight: .bold))
                            Text(isRunning ? "一時停止" : "再開・スタート")
                                .font(.system(size: 12, weight: .bold))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color.white.opacity(0.14))
                        .foregroundColor(isRunning ? Color(hex: "#FF9F0A") : Color(hex: "#30D158"))
                        .cornerRadius(9)
                    }
                    .buttonStyle(.plain)
                }
                
                Divider()
                    .padding(.vertical, 2)
                
                watchSoundToggleButton
                phoneSoundToggleButton
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
    }
    
    @ViewBuilder
    private var mainActionDeltaButtonsSection: some View {
        // ⑤ 共有タイマーと同じ分・秒トグル調整ボタン（何回も押せる累積調整！）
        // 上段: +1分, +3分, +5分
        HStack(spacing: 5) {
            Button(action: {
                accumulatedDelta += 60
                WKInterfaceDevice.current().play(.click)
            }) {
                Text("+1分")
                    .font(.system(size: 12, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
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
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
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
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color(hex: "#0A84FF").opacity(0.35))
                    .foregroundColor(Color(hex: "#64D2FF"))
                    .cornerRadius(7)
            }
            .buttonStyle(.plain)
        }
        
        // 下段: -30秒, +30秒（共有タイマーと同じ2ボタンに統一）
        HStack(spacing: 5) {
            Button(action: {
                if isOvertime {
                    accumulatedDelta = max(0, accumulatedDelta - 30)
                } else {
                    let minDelta = min(0, 10 - baseAdjustmentSeconds)
                    accumulatedDelta = max(minDelta, accumulatedDelta - 30)
                }
                WKInterfaceDevice.current().play(.click)
            }) {
                Text("-30秒")
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
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
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(Color.white.opacity(0.12))
                    .foregroundColor(Color(hex: "#C0C0C8"))
                    .cornerRadius(6)
            }
            .buttonStyle(.plain)
        }
    }
    
    @ViewBuilder
    private var mainActionConfirmSection: some View {
        // ⑥ トグル調整時の「確定」ボタン
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
                WKInterfaceDevice.current().play(.click)
                if isRunning || isOvertime {
                    // ★ シート閉鎖トランザクション中に @State (accumulatedDelta) を書き換えてボタン階層を消滅させると watchOS の dismiss() が固まるためそのまま閉じる
                    closeSheetAfter {
                        onAdjust(delta)
                    }
                } else {
                    accumulatedDelta = 0
                    onAdjust(delta)
                    if let updated = WatchSessionManager.shared.mainTimer {
                        displayItem = updated
                    }
                }
            }) {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 13, weight: .heavy))
                    Text("確定 (\(formatDelta(accumulatedDelta)))")
                        .font(.system(size: 12, weight: .black))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
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
    }
    
    @ViewBuilder
    private var mainActionStopTimerButton: some View {
        Button(action: {
            WKInterfaceDevice.current().play(.stop)
            // ★ シート閉鎖フレームで @State (displayItem / accumulatedDelta) を書き換えて View 階層（if isOvertime ↔ if !isOvertime）を変化させない（閉鎖ロック完全防止）
            closeSheetAfter {
                onReset()
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: "stop.circle.fill")
                    .font(.system(size: 14, weight: .bold))
                Text("タイマーを止める")
                    .font(.system(size: 14, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Color(hex: "#FF453A"))
            .foregroundColor(.white)
            .cornerRadius(10)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var mainActionReinputButton: some View {
        // 「タイマーを止める」の下に配置する「タイム再入力。」ボタン
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            crownSeconds = Double(currentItem.totalSeconds > 0 ? currentItem.totalSeconds : 600)
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                subMode = .reinput
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 12, weight: .bold))
                Text("タイム再入力。")
                    .font(.system(size: 12, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(Color(hex: "#FFD60A"))
            .foregroundColor(.black)
            .cornerRadius(9)
            .shadow(color: Color(hex: "#FFD60A").opacity(0.35), radius: 2, x: 0, y: 1)
        }
        .buttonStyle(.plain)
    }
    
    @ViewBuilder
    private var watchSoundToggleButton: some View {
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            watchSoundEnabled.toggle()
            displayItem.watchAlarmSoundEnabled = watchSoundEnabled
            UserDefaults.standard.set(watchSoundEnabled, forKey: "assisttimer.mainTimerWatchSound.v2")
            if var m = WatchSessionManager.shared.mainTimer {
                m.watchAlarmSoundEnabled = watchSoundEnabled
                WatchSessionManager.shared.mainTimer = m
                WatchAlarmCoordinator.shared.update(
                    timers: WatchSessionManager.shared.timers,
                    mainTimer: m,
                    soundOn: WatchSessionManager.shared.alarmSoundEnabled,
                    currentUserName: WatchSessionManager.shared.currentUserName
                )
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: watchSoundEnabled ? "applewatch.radiowaves.left.and.right" : "applewatch")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(watchSoundEnabled ? Color(hex: "#FF9F0A") : Color(hex: "#8E8E93"))
                Text("ウォッチの音")
                    .font(.system(size: 11.5, weight: .bold))
                    .foregroundColor(watchSoundEnabled ? Color(hex: "#FFD60A") : Color(hex: "#E0E0E5"))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(watchSoundEnabled ? "ON" : "OFF")
                    .font(.system(size: 10, weight: .black))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2.5)
                    .background(watchSoundEnabled ? Color(hex: "#FF9F0A") : Color.white.opacity(0.12))
                    .foregroundColor(watchSoundEnabled ? .black : Color(hex: "#8E8E93"))
                    .cornerRadius(5)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(watchSoundEnabled ? Color(hex: "#FF9F0A").opacity(0.18) : Color.white.opacity(0.06))
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(watchSoundEnabled ? Color(hex: "#FF9F0A").opacity(0.6) : Color.white.opacity(0.12), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var phoneSoundToggleButton: some View {
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            phoneSoundEnabled.toggle()
            displayItem.alarmSoundEnabled = phoneSoundEnabled
            UserDefaults.standard.set(phoneSoundEnabled, forKey: "assisttimer.mainTimerPhoneSound.v2")
            if var m = WatchSessionManager.shared.mainTimer {
                m.alarmSoundEnabled = phoneSoundEnabled
                WatchSessionManager.shared.mainTimer = m
            }
            WatchSessionManager.shared.sendMainTimerAction(
                action: "MAIN_TIMER_UPDATE_SOUND",
                extra: ["playSoundOnPhone": phoneSoundEnabled]
            )
        }) {
            HStack(spacing: 6) {
                Image(systemName: phoneSoundEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(phoneSoundEnabled ? Color(hex: "#FF9F0A") : Color(hex: "#8E8E93"))
                Text("スマホの音")
                    .font(.system(size: 11.5, weight: .bold))
                    .foregroundColor(phoneSoundEnabled ? Color(hex: "#FFD60A") : Color(hex: "#E0E0E5"))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(phoneSoundEnabled ? "ON" : "OFF")
                    .font(.system(size: 10, weight: .black))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2.5)
                    .background(phoneSoundEnabled ? Color(hex: "#FF9F0A") : Color.white.opacity(0.12))
                    .foregroundColor(phoneSoundEnabled ? .black : Color(hex: "#8E8E93"))
                    .cornerRadius(5)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(phoneSoundEnabled ? Color(hex: "#FF9F0A").opacity(0.18) : Color.white.opacity(0.06))
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(phoneSoundEnabled ? Color(hex: "#FF9F0A").opacity(0.6) : Color.white.opacity(0.12), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - タイム操作シート（タイマー操作・メニュー＆ヘルプ担当指定・途中チェック操作統合）
struct TimeActionSheet: View {
    enum SubMode {
        case standard
        case timerActionBranch
        case subCheckActionBranch
        case reinput
        case selectHelpProcess
        case selectHelpStaff
        case selectCheckProcess
        case selectCheckStaff
        case addLateCheck
    }
    
    @Environment(\.dismiss) var dismiss
    let item: SeatTimerItem
    let initialReinputMode: Bool
    let initialTimerBranchMode: Bool
    let initialSubCheckBranchMode: Bool
    let currentUserName: String
    let staffCandidates: [String]
    let onAdjust: (Int) -> Void
    let onStop: () -> Void
    let onEnterHelp: (() -> Void)?
    let onCompleteCheck: (() -> Void)?
    let onReinputTime: (Int, Int?, Bool, Bool) -> Void
    let onAssignHelp: ((String, String) -> Void)?
    let onRecruitHelp: ((String) -> Void)?
    let onSetNoHelp: (() -> Void)?
    let onClearHelp: (() -> Void)?
    let onAssignCheckStaff: ((String, String) -> Void)?
    let onRecruitCheckStaff: ((String) -> Void)?
    let onClearCheckStaff: (() -> Void)?
    let onCompleteSubCheck: (() -> Void)?
    let onCancelSubCheck: (() -> Void)?
    let onAdjustCheck: ((Int) -> Void)?
    let onAddLateCheck: ((Int, String, String?, Bool) -> Void)?
    let onUpdateSoundSettings: ((Bool, Bool) -> Void)?
    
    // シート内でのリアルタイム表示用アイテム
    @State private var liveItem: SeatTimerItem
    
    // ★ ウォッチのアラーム音・スマホのアラーム音 ON/OFF（両方ともデフォルトOFF、バイブは常に作動）
    @State private var watchSoundEnabled: Bool
    @State private var phoneSoundEnabled: Bool
    
    // 累積追加秒数（何回もタップ可能！）
    @State private var accumulatedDelta: Int = 0
    // チェックタイマー用の累積追加秒数
    @State private var checkAccumulatedDelta: Int = 0
    // チェック操作画面からヘルプ変更を開いたかどうかの戻り先フラグ
    @State private var cameFromSubCheckBranch: Bool = false
    // 標準画面（.standard）からチェック追加画面を開いたかどうかの戻り先フラグ
    @State private var cameFromStandardAddCheck: Bool = false
    // ★ シート表示中にカウントダウンが0秒を切って超過に入った瞬間のみ1回だけ分岐画面へ自動遷移させるフラグ（毎0.5秒の強制引き戻しによるフリーズを防止）
    @State private var hasAutoMovedToMainOvertimeBranch: Bool
    @State private var hasAutoMovedToCheckOvertimeBranch: Bool
    
    // シート内サブ画面モード
    @State private var subMode: SubMode
    
    // 選択中のヘルプメニュー（工程）
    @State private var selectedProcess: String = "シャンプー"
    // 選択中のチェックメニュー（内容）
    @State private var selectedCheckProcess: String = "チェック"
    
    // ★ 途中チェック（サブタイマー）分数 (0 = なし)
    @State private var checkMinutes: Int = 0
    
    // ★ 後からチェックタイマーを追加する画面用ステート（分数・ヘルプ内容・担当者）
    @State private var lateCheckMinutes: Int = 5
    @State private var lateCheckProcess: String = "チェック"
    @State private var lateCheckStaff: String = ""
    
    // ★ リューズ(Crown)無段階調整用 (分・秒独立タップ切替)
    @State private var crownSeconds: Double = 0.0
    
    // 0.5秒周期のカウントダウン更新（常時稼働 WatchRealtimeClock）
    @State private var now = Date()
    @State private var sheetOpenedAt: Date = Date()
    @State private var isClosingSheet: Bool = false
    // ★ シート内でタイム入力開始・ヘルプ指定・サブ画面遷移を行った時刻を記録し、15秒間はリモート更新や古いポーリングでシートが勝手に閉鎖・上書きされるのを完全防止
    @State private var lastLocalSheetMutationAt: Date? = nil

    private func recordLocalSheetInteraction() {
        lastLocalSheetMutationAt = Date()
        WatchSessionManager.shared.markLocalSeatMod(seatId: liveItem.id, seatNumber: liveItem.seatNumber)
        if item.id != liveItem.id {
            WatchSessionManager.shared.markLocalSeatMod(seatId: item.id, seatNumber: liveItem.seatNumber)
        }
    }

    private func closeSheetAfter(_ action: () -> Void) {
        guard !isClosingSheet else { return }
        isClosingSheet = true
        action()
        dismiss()
        // 万一 watchOS 側の通知割り込み等でシート閉鎖アニメーションがキャンセルされてもボタンがロックされない安全フェイルセーフ
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if isClosingSheet {
                isClosingSheet = false
            }
        }
    }
    
    let reinputMinutes = [5, 10, 15, 20, 25, 30, 35, 40, 45]
    let checkPills = [0, 3, 5, 7, 10]
    let processOptions: [(name: String, icon: String, color: String)] = [
        ("シャンプー", "drop.fill", "#0A84FF"),
        ("コーミング", "comb.fill", "#0A84FF"),
        ("チェック", "magnifyingglass", "#30D158"),
        ("その他", "ellipsis.circle", "#8E8E93")
    ]
    let checkProcessOptions: [(name: String, icon: String, color: String)] = [
        ("チェック", "magnifyingglass", "#30D158"),
        ("コーミング", "comb.fill", "#0A84FF"),
        ("1液2液", "drop.fill", "#BF5AF2"),
        ("担当を呼ぶ", "bell.fill", "#FF9F0A")
    ]
    
    init(
        item: SeatTimerItem,
        initialReinputMode: Bool = false,
        initialTimerBranchMode: Bool = false,
        initialSubCheckBranchMode: Bool = false,
        currentUserName: String = "スタイリスト",
        staffCandidates: [String] = [],
        onAdjust: @escaping (Int) -> Void,
        onAdjustCheck: ((Int) -> Void)? = nil,
        onStop: @escaping () -> Void,
        onEnterHelp: (() -> Void)? = nil,
        onCompleteCheck: (() -> Void)? = nil,
        onReinputTime: @escaping (Int, Int?, Bool, Bool) -> Void,
        onAssignHelp: ((String, String) -> Void)? = nil,
        onRecruitHelp: ((String) -> Void)? = nil,
        onSetNoHelp: (() -> Void)? = nil,
        onClearHelp: (() -> Void)? = nil,
        onAssignCheckStaff: ((String, String) -> Void)? = nil,
        onRecruitCheckStaff: ((String) -> Void)? = nil,
        onClearCheckStaff: (() -> Void)? = nil,
        onCompleteSubCheck: (() -> Void)? = nil,
        onCancelSubCheck: (() -> Void)? = nil,
        onAddLateCheck: ((Int, String, String?, Bool) -> Void)? = nil,
        onUpdateSoundSettings: ((Bool, Bool) -> Void)? = nil
    ) {
        self.item = item
        self._liveItem = State(initialValue: item)
        self._watchSoundEnabled = State(initialValue: item.watchAlarmSoundEnabled)
        self._phoneSoundEnabled = State(initialValue: item.alarmSoundEnabled)
        self.initialReinputMode = initialReinputMode
        self.initialTimerBranchMode = initialTimerBranchMode
        self.initialSubCheckBranchMode = initialSubCheckBranchMode
        let initSubMode: SubMode = initialSubCheckBranchMode ? .subCheckActionBranch : (initialReinputMode ? .reinput : (initialTimerBranchMode ? .timerActionBranch : .standard))
        self._subMode = State(initialValue: initSubMode)
        self._hasAutoMovedToMainOvertimeBranch = State(initialValue: initialTimerBranchMode)
        self._hasAutoMovedToCheckOvertimeBranch = State(initialValue: initialSubCheckBranchMode)
        self.currentUserName = currentUserName
        self.staffCandidates = staffCandidates
        self.onAdjust = onAdjust
        self.onAdjustCheck = onAdjustCheck
        self.onStop = onStop
        self.onEnterHelp = onEnterHelp
        self.onCompleteCheck = onCompleteCheck
        self.onReinputTime = onReinputTime
        self.onAssignHelp = onAssignHelp
        self.onRecruitHelp = onRecruitHelp
        self.onSetNoHelp = onSetNoHelp
        self.onClearHelp = onClearHelp
        self.onAssignCheckStaff = onAssignCheckStaff
        self.onRecruitCheckStaff = onRecruitCheckStaff
        self.onClearCheckStaff = onClearCheckStaff
        self.onCompleteSubCheck = onCompleteSubCheck
        self.onCancelSubCheck = onCancelSubCheck
        self.onAddLateCheck = onAddLateCheck
        self.onUpdateSoundSettings = onUpdateSoundSettings
        let initialCheckMin = (item.checkTotalSeconds ?? 0) / 60
        let defaultLateCheckMin = item.remainingSeconds > 0 ? min(5, max(1, (item.remainingSeconds - 30) / 60)) : 5
        self._checkMinutes = State(initialValue: initialCheckMin)
        self._lateCheckMinutes = State(initialValue: initialCheckMin > 0 ? initialCheckMin : defaultLateCheckMin)
        let initProc = item.helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
        self._selectedProcess = State(initialValue: initProc.isEmpty ? "シャンプー" : initProc)
        self._selectedCheckProcess = State(initialValue: item.displayCheckProcess)
        self._lateCheckProcess = State(initialValue: item.displayCheckProcess)
        self._lateCheckStaff = State(initialValue: item.checkStaff ?? "")
    }
    
    var isOvertime: Bool {
        liveItem.isRunning && liveItem.targetEndTime.timeIntervalSince1970 > 1_000_000_000 && liveItem.targetEndTime.timeIntervalSince(now) <= 0 && accumulatedDelta <= 0
    }
    
    var overtimeSeconds: Int {
        guard liveItem.isRunning && liveItem.targetEndTime.timeIntervalSince1970 > 1_000_000_000 else { return 0 }
        return abs(min(0, safeClampedSeconds(liveItem.targetEndTime.timeIntervalSince(now))))
    }
    
    // 現在の残り秒数 ＋ 累積追加秒数（リアルタイム反映）
    var currentDisplaySeconds: Int {
        let baseRemaining: Int
        if liveItem.isRunning && liveItem.targetEndTime.timeIntervalSince1970 > 1_000_000_000 {
            let diff = liveItem.targetEndTime.timeIntervalSince(now)
            baseRemaining = diff > 0 ? safeClampedCeilSeconds(diff) : 0
        } else {
            baseRemaining = max(0, liveItem.pausedRemainingSeconds)
        }
        let adjusted = baseRemaining + accumulatedDelta
        return max(0, adjusted)
    }
    
    // 途中チェックの残り秒数
    var currentCheckRemainingSeconds: Int? {
        guard !liveItem.isCheckCompleted, let checkEnd = liveItem.checkTargetEndTime, liveItem.isRunning else { return nil }
        guard checkEnd.timeIntervalSince1970 > 1_000_000_000 else { return nil }
        let diff = checkEnd.timeIntervalSince(now)
        return diff > 0 ? safeClampedCeilSeconds(diff) : 0
    }
    
    // 途中チェックの表示秒数（残り秒数 ＋ チェック用累積追加秒数）
    var currentCheckDisplaySeconds: Int? {
        guard let baseRem = currentCheckRemainingSeconds else { return nil }
        return max(0, baseRem + checkAccumulatedDelta)
    }
    
    var isCheckOvertime: Bool {
        guard liveItem.isRunning, !liveItem.isCheckCompleted, let checkEnd = liveItem.checkTargetEndTime else { return false }
        guard checkEnd.timeIntervalSince1970 > 1_000_000_000 else { return false }
        return checkEnd.timeIntervalSince(now) <= 0 && checkAccumulatedDelta <= 0
    }
    
    var checkOvertimeSeconds: Int {
        guard liveItem.isRunning, !liveItem.isCheckCompleted, let checkEnd = liveItem.checkTargetEndTime else { return 0 }
        guard checkEnd.timeIntervalSince1970 > 1_000_000_000 else { return 0 }
        return abs(min(0, safeClampedSeconds(checkEnd.timeIntervalSince(now))))
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
            switch subMode {
            case .reinput:
                unifiedReinputScrollView
            case .timerActionBranch:
                timerActionBranchScrollView
            case .subCheckActionBranch:
                subCheckActionBranchScrollView
            case .selectHelpProcess:
                selectHelpProcessScrollView
            case .selectHelpStaff:
                selectHelpStaffScrollView
            case .selectCheckProcess:
                selectCheckProcessScrollView
            case .selectCheckStaff:
                selectCheckStaffScrollView
            case .addLateCheck:
                addLateCheckScrollView
            case .standard:
                standardActionScrollView
            }
        }
        .onAppear {
            let currentNow = Date()
            now = currentNow
            sheetOpenedAt = currentNow
        }
        .onReceive(WatchRealtimeClock.shared.publisher) { input in
            guard !isClosingSheet else { return }
            now = input
            let isRecentlyMutatedInSheet = lastLocalSheetMutationAt.map { input.timeIntervalSince($0) < 15.0 } ?? false
            let isProtectedByLocalAction = isRecentlyMutatedInSheet || WatchSessionManager.shared.isSeatProtectedByRecentLocalAction(
                seatId: liveItem.id,
                seatNumber: liveItem.seatNumber,
                within: 15.0
            )
            let isInInteractiveSubMode = (subMode == .reinput || subMode == .selectHelpProcess || subMode == .selectHelpStaff || subMode == .selectCheckProcess || subMode == .selectCheckStaff || subMode == .addLateCheck)
            let isLocallyStopped = liveItem.isRunning && WatchSessionManager.shared.isSeatLocallyStopped(
                seatId: liveItem.id,
                seatNumber: liveItem.seatNumber,
                since: sheetOpenedAt.addingTimeInterval(-0.5),
                matchingEndTime: liveItem.targetEndTime
            )
            let latest = WatchSessionManager.shared.timers.first(where: { $0.id == liveItem.id })
                ?? WatchSessionManager.shared.timers.first(where: { $0.seatNumber == liveItem.seatNumber })
            if !isInInteractiveSubMode && isLocallyStopped && (latest == nil || latest?.isRunning == false) {
                isClosingSheet = true
                dismiss()
                return
            }
            if let latest = latest {
                if !isProtectedByLocalAction && !isInInteractiveSubMode &&
                   ((liveItem.isRunning && !latest.isRunning) ||
                    (!liveItem.isRunning && !liveItem.isZero && latest.isZero) ||
                    (subMode == .subCheckActionBranch && (!latest.isRunning || latest.isCheckCompleted || latest.checkTargetEndTime == nil))) {
                    isClosingSheet = true
                    dismiss()
                    return
                }
                if !isProtectedByLocalAction && !isInInteractiveSubMode && latest != liveItem {
                    liveItem = latest
                }
            } else if !isProtectedByLocalAction && !isInInteractiveSubMode && liveItem.isRunning && !WatchSessionManager.shared.timers.isEmpty {
                isClosingSheet = true
                dismiss()
                return
            }
            if !isOvertime {
                hasAutoMovedToMainOvertimeBranch = false
            } else if !hasAutoMovedToMainOvertimeBranch && accumulatedDelta <= 0 {
                // ★ チェックタイマー操作画面（.subCheckActionBranch）等の表示中は絶対に大元タイマー停止画面（.timerActionBranch）へすり替えない
                if subMode == .standard && liveItem.shouldAlertMainTimer(for: currentUserName) {
                    hasAutoMovedToMainOvertimeBranch = true
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        subMode = .timerActionBranch
                    }
                }
            }
            if !isCheckOvertime {
                hasAutoMovedToCheckOvertimeBranch = false
            } else if !hasAutoMovedToCheckOvertimeBranch && !isOvertime && checkAccumulatedDelta <= 0 && accumulatedDelta <= 0 {
                if subMode == .standard && liveItem.shouldAlertCheckTimer(for: currentUserName) {
                    hasAutoMovedToCheckOvertimeBranch = true
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        subMode = .subCheckActionBranch
                    }
                }
            }
        }
        .onReceive(WatchSessionManager.shared.$timers) { received in
            guard !isClosingSheet else { return }
            let isRecentlyMutatedInSheet = lastLocalSheetMutationAt.map { Date().timeIntervalSince($0) < 15.0 } ?? false
            let isProtectedByLocalAction = isRecentlyMutatedInSheet || WatchSessionManager.shared.isSeatProtectedByRecentLocalAction(
                seatId: liveItem.id,
                seatNumber: liveItem.seatNumber,
                within: 15.0
            )
            let isInInteractiveSubMode = (subMode == .reinput || subMode == .selectHelpProcess || subMode == .selectHelpStaff || subMode == .selectCheckProcess || subMode == .selectCheckStaff || subMode == .addLateCheck)
            let isLocallyStopped = liveItem.isRunning && WatchSessionManager.shared.isSeatLocallyStopped(
                seatId: liveItem.id,
                seatNumber: liveItem.seatNumber,
                since: sheetOpenedAt.addingTimeInterval(-0.5),
                matchingEndTime: liveItem.targetEndTime
            )
            let latest = received.first(where: { $0.id == liveItem.id })
                ?? received.first(where: { $0.seatNumber == liveItem.seatNumber })
            if !isInInteractiveSubMode && isLocallyStopped && (latest == nil || latest?.isRunning == false) {
                isClosingSheet = true
                dismiss()
                return
            }
            guard !isProtectedByLocalAction && !isInInteractiveSubMode else { return }
            if let latest = latest {
                if (liveItem.isRunning && !latest.isRunning) ||
                   (!liveItem.isRunning && !liveItem.isZero && latest.isZero) ||
                   (subMode == .subCheckActionBranch && (!latest.isRunning || latest.isCheckCompleted || latest.checkTargetEndTime == nil)) {
                    isClosingSheet = true
                    dismiss()
                }
            } else if liveItem.isRunning && !received.isEmpty {
                isClosingSheet = true
                dismiss()
            }
        }
    }
    
    // MARK: - ★ タイム入力確定時に liveItem を即座に反映し、そのまま標準画面（.standard: ヘルプ指定＆チェック担当指定）へ遷移する共通ヘルパー
    private func applyReinputAndShowStandard(totalSec: Int) {
        recordLocalSheetInteraction()
        let sec = max(10, totalSec)
        let chkSec = (checkMinutes > 0 && (checkMinutes * 60) < sec) ? checkMinutes * 60 : nil
        let startBase = Date()
        now = startBase
        accumulatedDelta = 0
        checkAccumulatedDelta = 0
        hasAutoMovedToMainOvertimeBranch = false
        hasAutoMovedToCheckOvertimeBranch = false
        
        liveItem.creatorName = currentUserName
        liveItem.isCreatorMeExplicit = true
        liveItem.totalSeconds = sec
        liveItem.targetEndTime = startBase.addingTimeInterval(Double(sec))
        liveItem.pausedRemainingSeconds = sec
        liveItem.isRunning = true
        liveItem.status = .normal
        liveItem.isCollapsed = false
        liveItem.helpProcess = ""
        liveItem.shampooStaff = nil
        liveItem.isRecruiting = false
        liveItem.isNoHelpNeeded = false
        liveItem.hasAlertedHelpUnassigned = false
        liveItem.watchAlarmSoundEnabled = watchSoundEnabled
        liveItem.alarmSoundEnabled = phoneSoundEnabled
        
        if let chk = chkSec, chk > 0 {
            liveItem.checkTotalSeconds = chk
            liveItem.checkTargetEndTime = startBase.addingTimeInterval(Double(chk))
            liveItem.checkStaff = nil
            liveItem.checkProcess = "チェック"
            liveItem.isCheckCompleted = false
            lateCheckMinutes = chk / 60
            lateCheckProcess = "チェック"
            lateCheckStaff = ""
        } else {
            liveItem.clearCheck()
        }
        
        onReinputTime(sec, chkSec, watchSoundEnabled, phoneSoundEnabled)
        
        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
            subMode = .standard
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
                        if initialReinputMode && liveItem.isZero {
                            dismiss()
                        } else {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                subMode = .timerActionBranch
                            }
                        }
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        HStack(spacing: 2) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text("戻る")
                                .font(.system(size: 11, weight: .bold))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .foregroundColor(Color(hex: "#FFD60A"))
                    }
                    .buttonStyle(.plain)
                    
                    Spacer(minLength: 4)
                    
                    Text("\(liveItem.displaySeatName) タイム設定")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    
                    Spacer(minLength: 4)
                }
                .padding(.horizontal, 4)
                
                // ② ００:００の巨大デジタル表示エリア（分・秒をそれぞれタップしてリューズで入力）
                CrownMinSecPicker(
                    totalSeconds: Binding(
                        get: { safeClampedSeconds(crownSeconds) },
                        set: { crownSeconds = Double(min(5400, max(0, $0))) }
                    ),
                    maxMinutes: 90,
                    fontSize: 30
                )
                .padding(.horizontal, 2)
                
                // ③ 補助ボタン（00:00 / -1分 / +1分 / +30秒）
                HStack(spacing: 4) {
                    Button(action: {
                        crownSeconds = 0.0
                        WKInterfaceDevice.current().play(.click)
                    }) {
                        Text("00:00")
                            .font(.system(size: 10, weight: .bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.68)
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
                            .lineLimit(1)
                            .minimumScaleFactor(0.68)
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
                            .lineLimit(1)
                            .minimumScaleFactor(0.68)
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
                            .lineLimit(1)
                            .minimumScaleFactor(0.68)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                            .background(Color.white.opacity(0.15))
                            .foregroundColor(.white)
                            .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 2)
                
                // ★ チェック（サブタイマー）設定セクション
                VStack(spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        HStack(spacing: 3) {
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(Color(hex: "#30D158"))
                            Text("チェック:")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(.gray)
                                .lineLimit(1)
                        }
                        Spacer()
                        Text(checkMinutes == 0 ? "なし" : "\(checkMinutes)分")
                            .font(.system(size: 13, weight: .heavy, design: .rounded))
                            .foregroundColor(checkMinutes == 0 ? .gray : Color(hex: "#30D158"))
                            .lineLimit(1)
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
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.68)
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
                if safeClampedSeconds(crownSeconds) > 0 {
                    Button(action: {
                        let sec = safeClampedSeconds(crownSeconds)
                        if sec > 0 {
                            WKInterfaceDevice.current().play(.click)
                            applyReinputAndShowStandard(totalSec: sec)
                        }
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 12, weight: .heavy))
                            if checkMinutes > 0 && (checkMinutes * 60) < safeClampedSeconds(crownSeconds) {
                                Text("決定 (\(formatSeconds(safeClampedSeconds(crownSeconds)))) 【\(checkMinutes)分CHK】")
                                    .font(.system(size: 10.5, weight: .black))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.72)
                            } else {
                                Text("決定 (\(formatSeconds(safeClampedSeconds(crownSeconds))))")
                                    .font(.system(size: 12, weight: .black))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
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
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Spacer(minLength: 2)
                    HStack(spacing: 2) {
                        Text("下も選択可")
                            .font(.system(size: 8.5, weight: .semibold))
                            .lineLimit(1)
                            .fixedSize()
                        Image(systemName: "chevron.down")
                            .font(.system(size: 7.5, weight: .bold))
                    }
                    .foregroundColor(Color(hex: "#8E8E93"))
                    .fixedSize(horizontal: true, vertical: false)
                }
                .padding(.horizontal, 4)
                
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 5) {
                    ForEach(reinputMinutes, id: \.self) { min in
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            applyReinputAndShowStandard(totalSec: min * 60)
                        }) {
                            Text("\(min)分")
                                .font(.system(size: 13, weight: .heavy))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
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
                
                // ★ ⑥ ウォッチの音 ON/OFF（上）＆ スマホの音 ON/OFF（下）ボタン（バイブは常に作動）
                seatWatchSoundToggleButton
                    .padding(.top, 2)
                seatPhoneSoundToggleButton
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 2)
        }
    }
    
    // MARK: - 標準操作画面（1番目: タイマー数字[タップで分岐] ➔ 2番目: 終了後メニュー＆ヘルプ担当 ➔ 3番目: チェック数字＋その下にチェック担当）
    @ViewBuilder
    private var standardActionScrollView: some View {
        ScrollView {
            VStack(spacing: 6) {
                standardTopTimerSection
                standardHelpSection
                standardSubCheckSection
                
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    dismiss()
                }) {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 12, weight: .bold))
                        Text("完了（一覧へ戻る）")
                            .font(.system(size: 11.5, weight: .heavy))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.14))
                    .foregroundColor(.white)
                    .cornerRadius(8)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(Color.white.opacity(0.22), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
    }
    
    @ViewBuilder
    private var standardTopTimerSection: some View {
        HStack(spacing: 4) {
            Button(action: {
                WKInterfaceDevice.current().play(.click)
                dismiss()
            }) {
                HStack(spacing: 2) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 10.5, weight: .bold))
                    Text("戻る")
                        .font(.system(size: 10.5, weight: .bold))
                        .lineLimit(1)
                        .fixedSize()
                }
                .foregroundColor(Color(hex: "#64D2FF"))
            }
            .buttonStyle(.plain)
            Spacer(minLength: 3)
            Text(liveItem.displaySeatName)
                .font(.system(size: 12, weight: .heavy))
                .lineLimit(1)
                .minimumScaleFactor(0.65)
            Spacer(minLength: 3)
            Text("全体: \(liveItem.totalSeconds / 60)分")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.gray)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 4)
        
        Divider()
            .padding(.vertical, 1)
        
        // ★ ① 1番目（一番上）: タイマーの数字のみ表示（タップで「タイマーを止める」「シャンプーに入る」等の分岐画面へ）
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                subMode = .timerActionBranch
            }
        }) {
            HStack(alignment: .center, spacing: 6) {
                Image(systemName: "timer")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(isOvertime ? Color(hex: "#FF453A") : Color(hex: "#64D2FF"))
                
                if isOvertime {
                    Text("超過 +\(formatSeconds(overtimeSeconds))")
                        .font(.system(size: WatchLayout.font(20), weight: .black, design: .rounded))
                        .monospacedDigit()
                        .foregroundColor(Color(hex: "#FF453A"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                } else {
                    Text(formatSeconds(currentDisplaySeconds))
                        .font(.system(size: WatchLayout.font(22), weight: .black, design: .rounded))
                        .monospacedDigit()
                        .foregroundColor(Color(hex: "#64D2FF"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                
                Spacer(minLength: 4)
                
                HStack(spacing: 2) {
                    Text("操作")
                        .font(.system(size: 10, weight: .bold))
                        .lineLimit(1)
                        .fixedSize()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                }
                .foregroundColor(Color(hex: "#8E8E93"))
                .fixedSize(horizontal: true, vertical: false)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 9)
                    .fill(isOvertime ? Color(hex: "#FF453A").opacity(0.20) : Color(hex: "#0A84FF").opacity(0.20))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9)
                    .stroke(isOvertime ? Color(hex: "#FF453A").opacity(0.55) : Color(hex: "#0A84FF").opacity(0.55), lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
    
    // MARK: - ★ タイマーの数字をタップした時の分岐画面（「シャンプーに入る」「タイマーを止める」等）
    @ViewBuilder
    private var timerActionBranchScrollView: some View {
        ScrollView {
            VStack(spacing: 7) {
                HStack {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        accumulatedDelta = 0
                        if initialTimerBranchMode {
                            dismiss()
                        } else {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                subMode = .standard
                            }
                        }
                    }) {
                        HStack(spacing: 2) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text("戻る")
                                .font(.system(size: 11, weight: .bold))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .foregroundColor(Color(hex: "#64D2FF"))
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 4)
                    Text(liveItem.displaySeatName)
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Spacer(minLength: 4)
                }
                .padding(.horizontal, 4)
                
                // 現在のタイム表示（どこの席のタイマーか一目でわかるよう「1番席」等の名前バッジを大きく表示）
                VStack(spacing: 3) {
                    HStack(spacing: 4) {
                        Image(systemName: "timer")
                            .font(.system(size: 12, weight: .heavy))
                            .foregroundColor(isOvertime ? Color(hex: "#FF453A") : Color(hex: "#64D2FF"))
                        Text(liveItem.displaySeatName)
                            .font(.system(size: WatchLayout.font(16), weight: .black, design: .rounded))
                            .foregroundColor(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 3)
                    .background(
                        Capsule()
                            .fill(isOvertime ? Color(hex: "#FF453A").opacity(0.28) : Color(hex: "#0A84FF").opacity(0.24))
                    )
                    .overlay(
                        Capsule()
                            .stroke(isOvertime ? Color(hex: "#FF453A").opacity(0.75) : Color(hex: "#64D2FF").opacity(0.65), lineWidth: 1)
                    )

                    if isOvertime {
                        Text("超過 +\(formatSeconds(overtimeSeconds))")
                            .font(.system(size: WatchLayout.font(23), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#FF453A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    } else {
                        Text(formatSeconds(currentDisplaySeconds))
                            .font(.system(size: WatchLayout.font(26), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#64D2FF"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                }
                .padding(.vertical, 2)
                
                // ★ 超過中は「〇〇に入る」「タイマーを止める」を最上部（超過タイム表示の直下）に配置してスクロール無しで即座に押せるようにする
                if isOvertime && accumulatedDelta <= 0 {
                    seatBranchStopAndHelpButtons
                }
                
                // ★ 微調整ボタン（+1分 / +3分 / +5分、-30秒 / +30秒）
                standardDeltaButtonsSection
                
                if accumulatedDelta != 0 {
                    standardConfirmSection
                }
                
                if !isOvertime || accumulatedDelta > 0 {
                    seatBranchStopAndHelpButtons
                }
                
                // ★ 「タイマーを止める」の下に「タイム再入力。」を配置
                standardReinputButton
                
                // ★ ユーザー指定: 止める画面の一番下に「＋ チェックタイマーを追加」ボタンを配置（分数・ヘルプ担当者も選択可能）
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    recordLocalSheetInteraction()
                    cameFromStandardAddCheck = false
                    let existingCheckMin = (liveItem.checkTotalSeconds ?? 0) / 60
                    let defaultLateCheckMin = liveItem.remainingSeconds > 0 ? min(5, max(1, (liveItem.remainingSeconds - 30) / 60)) : 5
                    lateCheckMinutes = existingCheckMin > 0 ? existingCheckMin : defaultLateCheckMin
                    lateCheckProcess = liveItem.displayCheckProcess
                    lateCheckStaff = liveItem.checkStaff ?? ""
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        subMode = .addLateCheck
                    }
                }) {
                    HStack(spacing: 5) {
                        Image(systemName: "plus.circle.fill")
                            .font(.system(size: 13, weight: .heavy))
                        Text(liveItem.checkTargetEndTime != nil && !liveItem.isCheckCompleted ? "チェックタイマーを変更・再設定" : "＋ チェックタイマーを追加")
                            .font(.system(size: 12, weight: .heavy))
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(Color(hex: "#0A84FF").opacity(0.28))
                    .foregroundColor(Color(hex: "#64D2FF"))
                    .cornerRadius(9)
                    .overlay(
                        RoundedRectangle(cornerRadius: 9)
                            .stroke(Color(hex: "#0A84FF").opacity(0.7), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                
                // ★ ウォッチの音 ON/OFF（上）＆ スマホの音 ON/OFF（下）ボタン（バイブは常に作動）
                seatWatchSoundToggleButton
                    .padding(.top, 2)
                seatPhoneSoundToggleButton
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
    }
    
    // MARK: - ★ 共有席タイマー用 ヘルプ開始＆タイマー停止ボタン共通セクション
    @ViewBuilder
    private var seatBranchStopAndHelpButtons: some View {
        let rawP = liveItem.helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
        if !liveItem.isNoHelpNeeded && !rawP.isEmpty {
            let p = rawP
            if p == "チェック" {
                Button(action: {
                    WKInterfaceDevice.current().play(.success)
                    // ★ シート閉鎖フレームで @State liveItem を書き換えて View 階層（if isOvertime ↔ if !isOvertime）を変化させない（閉鎖ロック完全防止）
                    closeSheetAfter {
                        onCompleteCheck?()
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 14, weight: .heavy))
                        Text("チェックに入る")
                            .font(.system(size: 14, weight: .heavy))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
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
                    .cornerRadius(10)
                }
                .buttonStyle(.plain)
            } else {
                let iconName: String = (p == "コーミング") ? "comb.fill" : ((p == "その他") ? "ellipsis.circle.fill" : "drop.fill")
                Button(action: {
                    WKInterfaceDevice.current().play(.success)
                    closeSheetAfter {
                        onEnterHelp?()
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: iconName)
                            .font(.system(size: 14, weight: .heavy))
                        Text("\(p)に入る")
                            .font(.system(size: 14, weight: .heavy))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
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
                    .cornerRadius(10)
                }
                .buttonStyle(.plain)
            }
        }
        
        Button(action: {
            WKInterfaceDevice.current().play(.stop)
            // ★ シート閉鎖フレームで @State liveItem を書き換えて View 階層（if isOvertime ↔ if !isOvertime）を変化させない（閉鎖ロック完全防止）
            closeSheetAfter {
                onStop()
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: "stop.circle.fill")
                    .font(.system(size: 14, weight: .bold))
                Text("タイマーを止める")
                    .font(.system(size: 14, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Color(hex: "#FF453A"))
            .foregroundColor(.white)
            .cornerRadius(10)
        }
        .buttonStyle(.plain)
    }

    // MARK: - ★ 共有席タイマー用 ウォッチの音・スマホの音 ON/OFF トグルボタン（ウォッチの音＝上、スマホの音＝下）
    private var seatWatchSoundToggleButton: some View {
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            recordLocalSheetInteraction()
            watchSoundEnabled.toggle()
            liveItem.watchAlarmSoundEnabled = watchSoundEnabled
            onUpdateSoundSettings?(watchSoundEnabled, phoneSoundEnabled)
        }) {
            HStack(spacing: 6) {
                Image(systemName: watchSoundEnabled ? "applewatch.radiowaves.left.and.right" : "applewatch")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(watchSoundEnabled ? Color(hex: "#FF9F0A") : Color(hex: "#8E8E93"))
                Text("ウォッチの音")
                    .font(.system(size: 11.5, weight: .bold))
                    .foregroundColor(watchSoundEnabled ? Color(hex: "#FFD60A") : Color(hex: "#E0E0E5"))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(watchSoundEnabled ? "ON" : "OFF")
                    .font(.system(size: 10, weight: .black))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2.5)
                    .background(watchSoundEnabled ? Color(hex: "#FF9F0A") : Color.white.opacity(0.12))
                    .foregroundColor(watchSoundEnabled ? .black : Color(hex: "#8E8E93"))
                    .cornerRadius(5)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(watchSoundEnabled ? Color(hex: "#FF9F0A").opacity(0.18) : Color.white.opacity(0.06))
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(watchSoundEnabled ? Color(hex: "#FF9F0A").opacity(0.6) : Color.white.opacity(0.12), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
    
    private var seatPhoneSoundToggleButton: some View {
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            recordLocalSheetInteraction()
            phoneSoundEnabled.toggle()
            liveItem.alarmSoundEnabled = phoneSoundEnabled
            onUpdateSoundSettings?(watchSoundEnabled, phoneSoundEnabled)
        }) {
            HStack(spacing: 6) {
                Image(systemName: phoneSoundEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(phoneSoundEnabled ? Color(hex: "#FF9F0A") : Color(hex: "#8E8E93"))
                Text("スマホの音")
                    .font(.system(size: 11.5, weight: .bold))
                    .foregroundColor(phoneSoundEnabled ? Color(hex: "#FFD60A") : Color(hex: "#E0E0E5"))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(phoneSoundEnabled ? "ON" : "OFF")
                    .font(.system(size: 10, weight: .black))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2.5)
                    .background(phoneSoundEnabled ? Color(hex: "#FF9F0A") : Color.white.opacity(0.12))
                    .foregroundColor(phoneSoundEnabled ? .black : Color(hex: "#8E8E93"))
                    .cornerRadius(5)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(phoneSoundEnabled ? Color(hex: "#FF9F0A").opacity(0.18) : Color.white.opacity(0.06))
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(phoneSoundEnabled ? Color(hex: "#FF9F0A").opacity(0.6) : Color.white.opacity(0.12), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
    
    // MARK: - ★ 稼働中の共有タイマーに後から「チェックタイマーを追加」する画面（分数＋ヘルプ内容＋誰にヘルプに入ってもらうか）
    @ViewBuilder
    private var addLateCheckScrollView: some View {
        ScrollView {
            VStack(spacing: 6) {
                HStack {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            subMode = cameFromStandardAddCheck ? .standard : .timerActionBranch
                        }
                    }) {
                        HStack(spacing: 2) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text("戻る")
                                .font(.system(size: 11, weight: .bold))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .foregroundColor(Color(hex: "#64D2FF"))
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 4)
                    Text("\(liveItem.displaySeatName) チェック追加")
                        .font(.system(size: 11.5, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Spacer(minLength: 4)
                }
                .padding(.horizontal, 4)
                
                // ① チェック分数選択
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("1. チェック分数")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(Color(hex: "#8E8E93"))
                        Spacer()
                        Text("\(lateCheckMinutes)分後")
                            .font(.system(size: 12, weight: .black, design: .rounded))
                            .foregroundColor(Color(hex: "#30D158"))
                    }
                    .padding(.horizontal, 2)
                    
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 4) {
                        ForEach([1, 3, 5, 7, 10, 15], id: \.self) { m in
                            let isSel = (lateCheckMinutes == m)
                            Button(action: {
                                WKInterfaceDevice.current().play(.click)
                                lateCheckMinutes = m
                            }) {
                                Text("\(m)分")
                                    .font(.system(size: 11.5, weight: isSel ? .heavy : .bold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 6)
                                    .background(isSel ? Color(hex: "#30D158") : Color.white.opacity(0.12))
                                    .foregroundColor(isSel ? .black : .white)
                                    .cornerRadius(6)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    
                    HStack(spacing: 5) {
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            lateCheckMinutes = max(1, lateCheckMinutes - 1)
                        }) {
                            Text("-1分")
                                .font(.system(size: 11, weight: .bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 5)
                                .background(Color.white.opacity(0.12))
                                .foregroundColor(Color(hex: "#C0C0C8"))
                                .cornerRadius(6)
                        }
                        .buttonStyle(.plain)
                        
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            lateCheckMinutes = min(90, lateCheckMinutes + 1)
                        }) {
                            Text("+1分")
                                .font(.system(size: 11, weight: .bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 5)
                                .background(Color.white.opacity(0.12))
                                .foregroundColor(Color(hex: "#64D2FF"))
                                .cornerRadius(6)
                        }
                        .buttonStyle(.plain)
                    }
                }
                
                Divider()
                    .padding(.vertical, 1)
                
                // ② チェック内容（工程）選択
                VStack(alignment: .leading, spacing: 4) {
                    Text("2. チェック内容（任意）")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(Color(hex: "#8E8E93"))
                        .padding(.horizontal, 2)
                    
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 4) {
                        ForEach(checkProcessOptions, id: \.name) { proc in
                            let isSel = (lateCheckProcess == proc.name)
                            Button(action: {
                                WKInterfaceDevice.current().play(.click)
                                lateCheckProcess = proc.name
                            }) {
                                HStack(spacing: 3) {
                                    Image(systemName: proc.icon)
                                        .font(.system(size: 10, weight: .bold))
                                    Text(proc.name)
                                        .font(.system(size: 10.5, weight: .heavy))
                                        .lineLimit(1)
                                        .minimumScaleFactor(0.72)
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 6)
                                .background(isSel ? Color(hex: proc.color) : Color.white.opacity(0.12))
                                .foregroundColor(.white)
                                .cornerRadius(6)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                
                Divider()
                    .padding(.vertical, 1)
                
                // ③ 誰にヘルプに入ってもらうか選択
                VStack(alignment: .leading, spacing: 4) {
                    Text("3. 誰にヘルプに入ってもらうか")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(Color(hex: "#8E8E93"))
                        .padding(.horizontal, 2)
                    
                    let otherStaff = staffCandidates.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0 != currentUserName }
                    
                    // 指定なし / 全員に募集 / 自分
                    HStack(spacing: 4) {
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            lateCheckStaff = ""
                        }) {
                            Text("指定なし")
                                .font(.system(size: 10.5, weight: lateCheckStaff.isEmpty ? .heavy : .bold))
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 6)
                                .background(lateCheckStaff.isEmpty ? Color(hex: "#0A84FF") : Color.white.opacity(0.12))
                                .foregroundColor(.white)
                                .cornerRadius(6)
                        }
                        .buttonStyle(.plain)
                        
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            lateCheckStaff = "募集中"
                        }) {
                            Text("📢全員募集")
                                .font(.system(size: 10.5, weight: lateCheckStaff == "募集中" ? .heavy : .bold))
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 6)
                                .background(lateCheckStaff == "募集中" ? Color(hex: "#FF9F0A") : Color.white.opacity(0.12))
                                .foregroundColor(lateCheckStaff == "募集中" ? .black : .white)
                                .cornerRadius(6)
                        }
                        .buttonStyle(.plain)
                    }
                    
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        lateCheckStaff = currentUserName
                    }) {
                        let isLateSelf = SeatTimerItem.isStaffMe(lateCheckStaff, currentUserName: currentUserName)
                        HStack(spacing: 4) {
                            Image(systemName: "hand.raised.fill")
                                .font(.system(size: 10))
                            Text("自分が担当")
                                .font(.system(size: 11, weight: .bold))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(isLateSelf ? Color(hex: "#30D158") : Color.white.opacity(0.12))
                        .foregroundColor(isLateSelf ? .black : .white)
                        .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                    
                    ForEach(otherStaff, id: \.self) { staff in
                        let isSel = (lateCheckStaff == staff)
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            lateCheckStaff = staff
                        }) {
                            HStack(spacing: 4) {
                                Image(systemName: "person.fill")
                                    .font(.system(size: 10))
                                Text("\(staff)さんに頼む")
                                    .font(.system(size: 11, weight: .bold))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(isSel ? Color(hex: "#0A84FF") : Color.white.opacity(0.12))
                            .foregroundColor(.white)
                            .cornerRadius(6)
                        }
                        .buttonStyle(.plain)
                    }
                }
                
                // ④ 確定ボタン
                Button(action: {
                    WKInterfaceDevice.current().play(.success)
                    let sec = max(60, lateCheckMinutes * 60)
                    let resolvedProc = lateCheckProcess.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "チェック" : lateCheckProcess
                    let staffVal: String? = lateCheckStaff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : lateCheckStaff
                    let shouldCloseSheet = !cameFromStandardAddCheck
                    if cameFromStandardAddCheck {
                        let checkEnd = Date().addingTimeInterval(Double(sec))
                        liveItem.checkTotalSeconds = sec
                        liveItem.checkTargetEndTime = checkEnd
                        liveItem.checkProcess = resolvedProc
                        liveItem.checkStaff = staffVal
                        liveItem.isCheckCompleted = false
                        checkAccumulatedDelta = 0
                        hasAutoMovedToCheckOvertimeBranch = false
                        recordLocalSheetInteraction()
                        onAddLateCheck?(sec, resolvedProc, staffVal, shouldCloseSheet)
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            subMode = .standard
                        }
                    } else {
                        closeSheetAfter {
                            onAddLateCheck?(sec, resolvedProc, staffVal, shouldCloseSheet)
                        }
                    }
                }) {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 13, weight: .heavy))
                        Text("チェックタイマーを開始 (\(lateCheckMinutes)分)")
                            .font(.system(size: 12, weight: .black))
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(
                        LinearGradient(
                            colors: [Color(hex: "#30D158"), Color(hex: "#248A3D")],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .foregroundColor(.white)
                    .cornerRadius(9)
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
    }
    
    // MARK: - ★ チェックのタイマーの数字をタップした時の分岐画面（微調整・チェック/コーミングに入る・タイマーを止める・ヘルプ変更）
    @ViewBuilder
    private var subCheckStopAndHelpButtons: some View {
        // ① ヘルプ内容（コーミング・1液2液・担当を呼ぶ）またはチェック担当者が明示指定されている場合のみ「〇〇に入る」ボタンを表示（未指定時は勝手にコーミング等を出さない）
        let checkProcessName: String = liveItem.displayCheckProcess
        let hasExplicitCheckHelp: Bool = (checkProcessName != "チェック") || !(liveItem.checkStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if hasExplicitCheckHelp {
            let checkIconName: String = liveItem.checkProcessIconName
            let checkActionLabel: String = (checkProcessName == "担当を呼ぶ") ? "担当を呼ぶ（完了）" : "\(checkProcessName)に入る"
            let checkColors: [Color] = {
                switch checkProcessName {
                case "コーミング":
                    return [Color(hex: "#0A84FF"), Color(hex: "#0062D2")]
                case "1液2液":
                    return [Color(hex: "#BF5AF2"), Color(hex: "#8E44AD")]
                case "担当を呼ぶ":
                    return [Color(hex: "#FF9F0A"), Color(hex: "#FF8000")]
                default:
                    return [Color(hex: "#30D158"), Color(hex: "#248A3D")]
                }
            }()
            
            Button(action: {
                WKInterfaceDevice.current().play(.success)
                // ★ シート閉鎖フレームで @State liveItem を書き換えて View 階層（if isCheckOvertime ↔ if !isCheckOvertime）を変化させない（閉鎖ロック完全防止）
                closeSheetAfter {
                    onCompleteSubCheck?()
                }
            }) {
                HStack(spacing: 6) {
                    Image(systemName: checkIconName)
                        .font(.system(size: 14, weight: .heavy))
                    Text(checkActionLabel)
                        .font(.system(size: 14, weight: .heavy))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(
                    LinearGradient(
                        colors: checkColors,
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .foregroundColor(.white)
                .cornerRadius(10)
            }
            .buttonStyle(.plain)
        }
        
        // ② チェックタイマーをすぐ止められる「タイマーを止める」ボタン（全体放置タイマーは続行）
        Button(action: {
            WKInterfaceDevice.current().play(.stop)
            // ★ シート閉鎖フレームで @State liveItem を書き換えて View 階層（if isCheckOvertime ↔ if !isCheckOvertime）を変化させない（閉鎖ロック完全防止）
            closeSheetAfter {
                onCompleteSubCheck?()
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: "stop.circle.fill")
                    .font(.system(size: 14, weight: .bold))
                Text("タイマーを止める")
                    .font(.system(size: 14, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Color(hex: "#FF453A"))
            .foregroundColor(.white)
            .cornerRadius(10)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var subCheckActionBranchScrollView: some View {
        ScrollView {
            VStack(spacing: 7) {
                HStack {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        checkAccumulatedDelta = 0
                        if initialSubCheckBranchMode {
                            dismiss()
                        } else {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                subMode = .standard
                            }
                        }
                    }) {
                        HStack(spacing: 2) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text("戻る")
                                .font(.system(size: 11, weight: .bold))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .foregroundColor(Color(hex: "#30D158"))
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 4)
                    Text("\(liveItem.displaySeatName) チェック")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Spacer(minLength: 4)
                }
                .padding(.horizontal, 4)
                
                // 現在のチェックタイム表示（どこの席のチェックタイマーか一目でわかるよう席名＋チェックバッジを大きく表示）
                VStack(spacing: 3) {
                    HStack(spacing: 4) {
                        Image(systemName: liveItem.checkProcessIconName)
                            .font(.system(size: 11.5, weight: .heavy))
                            .foregroundColor(isCheckOvertime ? Color(hex: "#FF453A") : Color(hex: "#30D158"))
                        Text("\(liveItem.displaySeatName)（\(liveItem.displayCheckProcess)）")
                            .font(.system(size: WatchLayout.font(15), weight: .black, design: .rounded))
                            .foregroundColor(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 3)
                    .background(
                        Capsule()
                            .fill(isCheckOvertime ? Color(hex: "#FF453A").opacity(0.28) : Color(hex: "#30D158").opacity(0.22))
                    )
                    .overlay(
                        Capsule()
                            .stroke(isCheckOvertime ? Color(hex: "#FF453A").opacity(0.75) : Color(hex: "#30D158").opacity(0.6), lineWidth: 1)
                    )

                    if isCheckOvertime {
                        Text("超過 +\(formatSeconds(checkOvertimeSeconds))")
                            .font(.system(size: WatchLayout.font(23), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#FF453A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    } else if let checkRem = currentCheckDisplaySeconds {
                        Text(formatSeconds(checkRem))
                            .font(.system(size: WatchLayout.font(26), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#30D158"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    } else {
                        Text("00:00 (完了)")
                            .font(.system(size: WatchLayout.font(20), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#8E8E93"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                }
                .padding(.vertical, 2)
                
                // ★ チェック超過中は「〇〇に入る」「タイマーを止める」を最上部（超過タイム表示の直下）に配置してスクロール無しで即座に押せるようにする
                if isCheckOvertime && checkAccumulatedDelta <= 0 {
                    subCheckStopAndHelpButtons
                }
                
                // ★ 微調整ボタン（+1分 / +3分 / +5分、-30秒 / +30秒）
                subCheckDeltaButtonsSection
                
                if checkAccumulatedDelta != 0 {
                    subCheckConfirmSection
                }
                
                if !isCheckOvertime || checkAccumulatedDelta > 0 {
                    subCheckStopAndHelpButtons
                }
                
                // ③ 「ヘルプ変更」ボタン（タップで内容選択 ➔ 担当選択リストへ）
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    cameFromSubCheckBranch = true
                    selectedCheckProcess = liveItem.displayCheckProcess
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        subMode = .selectCheckProcess
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "person.2.fill")
                            .font(.system(size: 13, weight: .bold))
                        if let cStaff = liveItem.checkStaff, !cStaff.isEmpty {
                            Text("ヘルプ変更 (\(SeatTimerItem.displayStaffName(cStaff, currentUserName: currentUserName)))")
                                .font(.system(size: 13, weight: .heavy))
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                        } else {
                            Text("ヘルプ変更")
                                .font(.system(size: 14, weight: .heavy))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.white.opacity(0.16))
                    .foregroundColor(.white)
                    .cornerRadius(10)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color.white.opacity(0.25), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
    }
    
    @ViewBuilder
    private var subCheckDeltaButtonsSection: some View {
        // +1分, +3分, +5分（何回も押せる！dismissしない）
        HStack(spacing: 5) {
            Button(action: {
                checkAccumulatedDelta += 60
                WKInterfaceDevice.current().play(.click)
            }) {
                Text("+1分")
                    .font(.system(size: 12, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.16))
                    .foregroundColor(.white)
                    .cornerRadius(7)
            }
            .buttonStyle(.plain)
            
            Button(action: {
                checkAccumulatedDelta += 180
                WKInterfaceDevice.current().play(.click)
            }) {
                Text("+3分")
                    .font(.system(size: 12, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.16))
                    .foregroundColor(.white)
                    .cornerRadius(7)
            }
            .buttonStyle(.plain)
            
            Button(action: {
                checkAccumulatedDelta += 300
                WKInterfaceDevice.current().play(.click)
            }) {
                Text("+5分")
                    .font(.system(size: 12, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color(hex: "#30D158").opacity(0.35))
                    .foregroundColor(Color(hex: "#30D158"))
                    .cornerRadius(7)
            }
            .buttonStyle(.plain)
        }
        
        // -30秒, +30秒（何回も押せる！dismissしない・最低残り10秒ガード付き）
        HStack(spacing: 5) {
            Button(action: {
                let baseCheckRem = currentCheckRemainingSeconds ?? 0
                if baseCheckRem <= 0 {
                    checkAccumulatedDelta = max(0, checkAccumulatedDelta - 30)
                } else {
                    let minDelta = min(0, 10 - baseCheckRem)
                    checkAccumulatedDelta = max(minDelta, checkAccumulatedDelta - 30)
                }
                WKInterfaceDevice.current().play(.click)
            }) {
                Text("-30秒")
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(Color.white.opacity(0.12))
                    .foregroundColor(Color(hex: "#C0C0C8"))
                    .cornerRadius(6)
            }
            .buttonStyle(.plain)
            
            Button(action: {
                checkAccumulatedDelta += 30
                WKInterfaceDevice.current().play(.click)
            }) {
                Text("+30秒")
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(Color.white.opacity(0.12))
                    .foregroundColor(Color(hex: "#C0C0C8"))
                    .cornerRadius(6)
            }
            .buttonStyle(.plain)
        }
    }
    
    @ViewBuilder
    private var subCheckConfirmSection: some View {
        // ★ 追加タイムを押した時に出現する「確定」ボタン（黄色）
        HStack(spacing: 5) {
            Button(action: {
                withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                    checkAccumulatedDelta = 0
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
                let delta = checkAccumulatedDelta
                WKInterfaceDevice.current().play(.click)
                closeSheetAfter {
                    onAdjustCheck?(delta)
                }
            }) {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 13, weight: .heavy))
                    Text("確定 (\(formatDelta(checkAccumulatedDelta)))")
                        .font(.system(size: 12, weight: .black))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
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
    }
    
    @ViewBuilder
    private var standardSubCheckSection: some View {
        // ★ ③ 3番目: チェックのタイマーの数字 ＋ その下にチェックに入るべき人の名前を入れる場所
        if let checkRem = currentCheckRemainingSeconds {
            let chkProc = liveItem.displayCheckProcess
            VStack(spacing: 5) {
                // 上段: チェックのタイマーの数字（タップでチェック完了・解除へ分岐）
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        subMode = .subCheckActionBranch
                    }
                }) {
                    HStack(alignment: .center, spacing: 5) {
                        Image(systemName: liveItem.checkProcessIconName)
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(Color(hex: liveItem.checkProcessColorHex))
                        Text(chkProc)
                            .font(.system(size: 10.5, weight: .heavy))
                            .foregroundColor(Color(hex: "#A0E0B0"))
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                        Spacer(minLength: 4)
                        Text(formatSeconds(checkRem))
                            .font(.system(size: WatchLayout.font(17), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#30D158"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                        HStack(spacing: 2) {
                            Text("操作")
                                .font(.system(size: 9, weight: .bold))
                                .lineLimit(1)
                                .fixedSize()
                            Image(systemName: "chevron.right")
                                .font(.system(size: 8, weight: .bold))
                        }
                        .foregroundColor(Color(hex: "#8E8E93"))
                        .fixedSize(horizontal: true, vertical: false)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, WatchLayout.isSmall ? 6 : 8)
                    .padding(.vertical, 6)
                    .background(Color(hex: "#30D158").opacity(0.16))
                    .cornerRadius(7)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                
                // 下段（チェックのタイマーの数字の下）: チェックに入るべき人の名前を入れる場所
                standardSubCheckStaffButton
            }
            .padding(WatchLayout.isSmall ? 5 : 7)
            .background(Color(hex: "#30D158").opacity(0.10))
            .cornerRadius(9)
            .overlay(
                RoundedRectangle(cornerRadius: 9)
                    .stroke(Color(hex: "#30D158").opacity(0.35), lineWidth: 1)
            )
        } else if !isOvertime && liveItem.totalSeconds > 0 {
            Button(action: {
                WKInterfaceDevice.current().play(.click)
                recordLocalSheetInteraction()
                cameFromStandardAddCheck = true
                let existingCheckMin = (liveItem.checkTotalSeconds ?? 0) / 60
                let defaultLateCheckMin = liveItem.remainingSeconds > 0 ? min(5, max(1, (liveItem.remainingSeconds - 30) / 60)) : 5
                lateCheckMinutes = existingCheckMin > 0 ? existingCheckMin : defaultLateCheckMin
                lateCheckProcess = liveItem.displayCheckProcess
                lateCheckStaff = liveItem.checkStaff ?? ""
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    subMode = .addLateCheck
                }
            }) {
                HStack(spacing: 5) {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(Color(hex: "#30D158"))
                    Text("＋ チェックタイマー・担当を追加")
                        .font(.system(size: 10.5, weight: .heavy))
                        .foregroundColor(Color(hex: "#30D158"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8.5, weight: .bold))
                        .foregroundColor(Color(hex: "#8E8E93"))
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                .padding(.vertical, 7)
                .background(Color(hex: "#30D158").opacity(0.12))
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color(hex: "#30D158").opacity(0.45), lineWidth: 1)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
    
    @ViewBuilder
    private var standardSubCheckStaffButton: some View {
        let isUnassigned = (liveItem.checkStaff == nil)
        let bgColor: Color = isUnassigned ? Color(hex: "#FF9F0A").opacity(0.25) : Color.white.opacity(0.12)
        let fgColor: Color = isUnassigned ? Color(hex: "#FFD60A") : .white
        let strokeColor: Color = isUnassigned ? Color(hex: "#FF9F0A").opacity(0.6) : Color.white.opacity(0.15)
        let chkProc = liveItem.displayCheckProcess
        
        // チェック担当者の指名・変更ボタン（内容選択 ➔ 担当選択）
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            recordLocalSheetInteraction()
            cameFromSubCheckBranch = false
            selectedCheckProcess = liveItem.displayCheckProcess
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                subMode = .selectCheckProcess
            }
        }) {
            HStack(spacing: 4) {
                if let cStaff = liveItem.checkStaff, !cStaff.isEmpty {
                    if cStaff == "募集中" {
                        Image(systemName: "megaphone.fill")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(Color(hex: "#FF9F0A"))
                        Text("\(chkProc): 全員に募集中")
                            .font(.system(size: 10.5, weight: .heavy))
                            .foregroundColor(Color(hex: "#FFD60A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                    } else {
                        let displayStaff = SeatTimerItem.displayStaffName(cStaff, currentUserName: currentUserName)
                        Image(systemName: "person.fill.checkmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(Color(hex: "#30D158"))
                        Text("\(chkProc): \(displayStaff)")
                            .font(.system(size: 10.5, weight: .heavy))
                            .foregroundColor(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                    }
                    Spacer(minLength: 4)
                    Text("変更 >")
                        .font(.system(size: 9.5, weight: .bold))
                        .foregroundColor(Color(hex: "#8E8E93"))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                } else {
                    Image(systemName: "person.badge.plus")
                        .font(.system(size: 10.5, weight: .bold))
                    Text("チェック担当を指名・募集")
                        .font(.system(size: 10.5, weight: .heavy))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8.5, weight: .bold))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, WatchLayout.isSmall ? 6 : 8)
            .padding(.vertical, 6)
            .background(bgColor)
            .foregroundColor(fgColor)
            .cornerRadius(7)
            .overlay(
                RoundedRectangle(cornerRadius: 7)
                    .stroke(strokeColor, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
    
    @ViewBuilder
    private var standardHelpSection: some View {
        // ★ ② 2番目（タイマーの数字の下）: タイマー全体の最後にシャンプーに入るかコーミングをするか等を選べる場所
        if liveItem.isNoHelpNeeded {
            // ヘルプなし（一人施術）設定中
            Button(action: {
                WKInterfaceDevice.current().play(.click)
                recordLocalSheetInteraction()
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    subMode = .selectHelpProcess
                }
            }) {
                HStack(spacing: 5) {
                    Image(systemName: "person.fill")
                        .font(.system(size: 11))
                    Text("👤 ヘルプなし（一人施術）")
                        .font(.system(size: 11, weight: .bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Spacer(minLength: 4)
                    Text("変更 >")
                        .font(.system(size: 9.5, weight: .bold))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                .padding(.vertical, 7)
                .background(Color.white.opacity(0.08))
                .foregroundColor(Color(hex: "#C0C0C8"))
                .cornerRadius(8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            let p = liveItem.helpProcess.trimmingCharacters(in: .whitespacesAndNewlines)
            if p.isEmpty {
                // ★ メニュー未選択時: メニュー（シャンプー/コーミング/チェック/その他）と担当を選べるボタンを表示
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    recordLocalSheetInteraction()
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        subMode = .selectHelpProcess
                    }
                }) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            Image(systemName: "person.crop.circle.badge.plus")
                                .font(.system(size: 12, weight: .bold))
                            Text("メニュー・ヘルプ担当を指定")
                                .font(.system(size: 11.5, weight: .heavy))
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                            Spacer(minLength: 4)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .bold))
                        }
                        Text("シャンプー / コーミング / チェック / その他")
                            .font(.system(size: 8.5, weight: .medium))
                            .foregroundColor(Color.white.opacity(0.75))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                    .padding(.vertical, 8)
                    .background(Color(hex: "#FF9F0A").opacity(0.22))
                    .foregroundColor(Color(hex: "#FFD60A"))
                    .cornerRadius(8)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(Color(hex: "#FF9F0A").opacity(0.65), lineWidth: 1)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                standardHelpStatusBadgeButton(process: p)
            }
        }
    }
    
    @ViewBuilder
    private func standardHelpStatusBadgeButton(process p: String) -> some View {
        let bgColor: Color = liveItem.isRecruiting ? Color(hex: "#FF9F0A").opacity(0.18) : Color.white.opacity(0.10)
        let strokeColor: Color = liveItem.isRecruiting ? Color(hex: "#FF9F0A").opacity(0.6) : Color.white.opacity(0.18)
        
        // 現在選択中のメニュー＆担当者バッジ（タップでメニュー・担当者を変更可能）
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            recordLocalSheetInteraction()
            selectedProcess = p
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                subMode = .selectHelpProcess
            }
        }) {
            HStack(spacing: 5) {
                if liveItem.isRecruiting {
                    Image(systemName: "megaphone.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(Color(hex: "#FF9F0A"))
                    Text("\(p): 全員に募集中")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundColor(Color(hex: "#FFD60A"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                } else if let staff = liveItem.shampooStaff, !staff.isEmpty {
                    let isMe = SeatTimerItem.isStaffMe(staff, currentUserName: currentUserName)
                    let displayStaff = SeatTimerItem.displayStaffName(staff, currentUserName: currentUserName)
                    let staffColor: Color = isMe ? Color(hex: "#FFD60A") : .white
                    Image(systemName: "person.fill.checkmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(Color(hex: "#0A84FF"))
                    Text("\(p): \(displayStaff)")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundColor(staffColor)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                } else {
                    Image(systemName: "person.badge.plus")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(Color(hex: "#FFD60A"))
                    Text("\(p): 担当未定")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundColor(Color(hex: "#FFD60A"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                }
                Spacer(minLength: 4)
                Text("変更 >")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(Color(hex: "#8E8E93"))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
            .padding(.vertical, 7)
            .background(bgColor)
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(strokeColor, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
    
    @ViewBuilder
    private var standardDeltaButtonsSection: some View {
        // ④ +1分, +3分, +5分（何回も押せる！dismissしない）
        HStack(spacing: 5) {
            Button(action: {
                accumulatedDelta += 60
                WKInterfaceDevice.current().play(.click)
            }) {
                Text("+1分")
                    .font(.system(size: 12, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
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
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
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
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color(hex: "#0A84FF").opacity(0.35))
                    .foregroundColor(Color(hex: "#64D2FF"))
                    .cornerRadius(7)
            }
            .buttonStyle(.plain)
        }
        
        // ④ -30秒, +30秒（何回も押せる！dismissしない・最低残り10秒ガード付き）
        HStack(spacing: 5) {
            Button(action: {
                let baseRem: Int = {
                    if liveItem.isRunning && liveItem.targetEndTime.timeIntervalSince1970 > 1_000_000_000 {
                        let diff = liveItem.targetEndTime.timeIntervalSince(now)
                        return diff > 0 ? safeClampedCeilSeconds(diff) : 0
                    }
                    return max(0, liveItem.pausedRemainingSeconds)
                }()
                if baseRem <= 0 {
                    accumulatedDelta = max(0, accumulatedDelta - 30)
                } else {
                    let minDelta = min(0, 10 - baseRem)
                    accumulatedDelta = max(minDelta, accumulatedDelta - 30)
                }
                WKInterfaceDevice.current().play(.click)
            }) {
                Text("-30秒")
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
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
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(Color.white.opacity(0.12))
                    .foregroundColor(Color(hex: "#C0C0C8"))
                    .cornerRadius(6)
            }
            .buttonStyle(.plain)
        }
    }
    
    @ViewBuilder
    private var standardConfirmSection: some View {
        // ★ 追加タイムを押した時に出現する「確定」ボタン（黄色）
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
                let delta = accumulatedDelta
                WKInterfaceDevice.current().play(.click)
                closeSheetAfter {
                    onAdjust(delta)
                }
            }) {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 13, weight: .heavy))
                    Text("確定 (\(formatDelta(accumulatedDelta)))")
                        .font(.system(size: 12, weight: .black))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
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
    }
    
    @ViewBuilder
    private var standardReinputButton: some View {
        // ★ 「タイマーを止める」の下に配置する「タイム再入力。」（黄色）
        Button(action: {
            recordLocalSheetInteraction()
            crownSeconds = 0.0
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                subMode = .reinput
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 12, weight: .bold))
                Text("タイム再入力。")
                    .font(.system(size: 12, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(Color(hex: "#FFD60A"))
            .foregroundColor(.black)
            .cornerRadius(9)
            .shadow(color: Color(hex: "#FFD60A").opacity(0.35), radius: 2, x: 0, y: 1)
        }
        .buttonStyle(.plain)
    }
    
    // MARK: - ★ シート内サブ画面1: 本番ヘルプのメニュー（工程）選択画面
    @ViewBuilder
    private var selectHelpProcessScrollView: some View {
        ScrollView {
            VStack(spacing: 7) {
                HStack {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            subMode = .standard
                        }
                    }) {
                        HStack(spacing: 2) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text("戻る")
                                .font(.system(size: 11, weight: .bold))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .foregroundColor(Color(hex: "#0A84FF"))
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 4)
                    Text("メニュー選択")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Spacer(minLength: 4)
                }
                .padding(.horizontal, 4)
                
                Text("工程を選んで担当者または募集を指定")
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundColor(.gray)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                
                Divider()
                
                ForEach(processOptions, id: \.name) { proc in
                    let isCurrent = (liveItem.helpProcess == proc.name && !liveItem.isNoHelpNeeded)
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        recordLocalSheetInteraction()
                        selectedProcess = proc.name
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            subMode = .selectHelpStaff
                        }
                    }) {
                        HStack(spacing: 8) {
                            Image(systemName: proc.icon)
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(Color(hex: proc.color))
                                .frame(width: 20)
                            
                            Text(proc.name)
                                .font(.system(size: 13.5, weight: .heavy))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                            
                            Spacer(minLength: 4)
                            
                            if isCurrent {
                                Text("選択中")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundColor(Color(hex: "#FFD60A"))
                                    .lineLimit(1)
                                    .fixedSize()
                            }
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(.gray)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                        .padding(.vertical, 9)
                        .background(isCurrent ? Color(hex: "#0A84FF").opacity(0.25) : Color.white.opacity(0.12))
                        .foregroundColor(.white)
                        .cornerRadius(9)
                        .overlay(
                            RoundedRectangle(cornerRadius: 9)
                                .stroke(isCurrent ? Color(hex: "#0A84FF") : Color.clear, lineWidth: 1)
                        )
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                
                Divider()
                
                // ヘルプなし（一人で施術）ボタン
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    recordLocalSheetInteraction()
                    let shouldSetCreatorToMe = liveItem.shouldClaimOrRefreshCreatorAsMe(currentUserName: currentUserName)
                    liveItem.helpProcess = ""
                    liveItem.shampooStaff = nil
                    liveItem.isRecruiting = false
                    liveItem.isNoHelpNeeded = true
                    if shouldSetCreatorToMe {
                        liveItem.applyCreatorAsMe(currentUserName: currentUserName)
                    }
                    onSetNoHelp?()
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        subMode = .standard
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "person.fill")
                            .font(.system(size: 12, weight: .bold))
                        Text("ヘルプなし（一人で施術）")
                            .font(.system(size: 11.5, weight: .bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.10))
                    .foregroundColor(Color(hex: "#C0C0C8"))
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                
                if !liveItem.helpProcess.isEmpty || liveItem.shampooStaff != nil || liveItem.isRecruiting || liveItem.isNoHelpNeeded {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        recordLocalSheetInteraction()
                        liveItem.helpProcess = ""
                        liveItem.shampooStaff = nil
                        liveItem.isRecruiting = false
                        liveItem.isNoHelpNeeded = false
                        onClearHelp?()
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            subMode = .standard
                        }
                    }) {
                        Text("指定を解除（未定に戻す）")
                            .font(.system(size: 10.5, weight: .medium))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(Color.white.opacity(0.06))
                            .foregroundColor(.gray)
                            .cornerRadius(8)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
    }
    
    // MARK: - ★ シート内サブ画面2: 本番ヘルプの担当者・全員募集の選択画面
    @ViewBuilder
    private var selectHelpStaffScrollView: some View {
        ScrollView {
            VStack(spacing: 7) {
                HStack {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            subMode = .selectHelpProcess
                        }
                    }) {
                        HStack(spacing: 2) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text("工程へ")
                                .font(.system(size: 11, weight: .bold))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .foregroundColor(Color(hex: "#0A84FF"))
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 4)
                    Text("【\(selectedProcess)】の担当")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Spacer(minLength: 4)
                }
                .padding(.horizontal, 4)
                
                Divider()
                
                // ① 全員に募集する
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    recordLocalSheetInteraction()
                    let shouldSetCreatorToMe = liveItem.shouldClaimOrRefreshCreatorAsMe(currentUserName: currentUserName)
                    liveItem.helpProcess = selectedProcess
                    liveItem.shampooStaff = nil
                    if selectedProcess == "チェック" {
                        liveItem.checkStaff = nil
                    }
                    liveItem.isRecruiting = true
                    liveItem.isNoHelpNeeded = false
                    if shouldSetCreatorToMe {
                        liveItem.applyCreatorAsMe(currentUserName: currentUserName)
                    }
                    if liveItem.remainingSeconds <= 180 {
                        liveItem.hasAlertedHelpUnassigned = true
                    }
                    onRecruitHelp?(selectedProcess)
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        subMode = .standard
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "megaphone.fill")
                            .font(.system(size: 12, weight: .heavy))
                        Text("全員に募集する")
                            .font(.system(size: 12.5, weight: .black))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
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
                
                // ② 自分が担当する
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    recordLocalSheetInteraction()
                    let shouldSetCreatorToMe = liveItem.shouldClaimOrRefreshCreatorAsMe(currentUserName: currentUserName)
                    liveItem.helpProcess = selectedProcess
                    liveItem.shampooStaff = currentUserName
                    if selectedProcess == "チェック" {
                        liveItem.checkStaff = currentUserName
                    }
                    liveItem.isRecruiting = false
                    liveItem.isNoHelpNeeded = false
                    if shouldSetCreatorToMe {
                        liveItem.applyCreatorAsMe(currentUserName: currentUserName)
                    }
                    onAssignHelp?(selectedProcess, currentUserName)
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        subMode = .standard
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "person.fill.checkmark")
                            .font(.system(size: 12, weight: .heavy))
                        Text("自分が担当する")
                            .font(.system(size: 12.5, weight: .heavy))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color(hex: "#30D158"))
                    .foregroundColor(.black)
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                
                // ③ 個別スタッフを指名
                Text("スタッフを指名（相手に通知）")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(Color(hex: "#A0A0A5"))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 2)
                
                if staffCandidates.isEmpty {
                    VStack(spacing: 4) {
                        Image(systemName: "person.crop.circle.badge.plus")
                            .font(.system(size: 20))
                            .foregroundColor(Color(hex: "#0A84FF"))
                        Text("📱 スマホの共有コードでメンバーを連携するとスタッフ一覧が表示されます")
                            .font(.system(size: 9, weight: .bold))
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
                        helpStaffCandidateRow(staff)
                    }
                }
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
    }
    
    @ViewBuilder
    private func helpStaffCandidateRow(_ staff: String) -> some View {
        let isMe = SeatTimerItem.isStaffMe(staff, currentUserName: currentUserName)
        let isSelected = (liveItem.shampooStaff == staff && liveItem.helpProcess == selectedProcess)
        let bgColor: Color = isSelected ? Color(hex: "#30D158").opacity(0.2) : (isMe ? Color(hex: "#FFD60A").opacity(0.18) : Color.white.opacity(0.12))
        let strokeColor: Color = isSelected ? Color(hex: "#30D158").opacity(0.6) : (isMe ? Color(hex: "#FFD60A").opacity(0.5) : Color.white.opacity(0.1))
        let iconColor: Color = isMe ? Color(hex: "#FFD60A") : Color(hex: "#0A84FF")
        
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            recordLocalSheetInteraction()
            let shouldSetCreatorToMe = liveItem.shouldClaimOrRefreshCreatorAsMe(currentUserName: currentUserName)
            liveItem.helpProcess = selectedProcess
            liveItem.shampooStaff = staff
            if selectedProcess == "チェック" {
                liveItem.checkStaff = staff
            }
            liveItem.isRecruiting = false
            liveItem.isNoHelpNeeded = false
            if shouldSetCreatorToMe {
                liveItem.applyCreatorAsMe(currentUserName: currentUserName)
            }
            onAssignHelp?(selectedProcess, staff)
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                subMode = .standard
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: isMe ? "star.fill" : "person.fill")
                    .font(.system(size: 11))
                    .foregroundColor(iconColor)
                Text(isMe ? "自分" : staff)
                    .font(.system(size: 12, weight: isMe ? .heavy : .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Spacer(minLength: 4)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(Color(hex: "#30D158"))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
            .padding(.vertical, 7)
            .background(bgColor)
            .foregroundColor(.white)
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(strokeColor, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
    
    // MARK: - ★ シート内サブ画面3-1: チェック（サブタイマー）の内容選択画面（コーミング / チェック / 1液2液 / 担当を呼ぶ）
    @ViewBuilder
    private var selectCheckProcessScrollView: some View {
        let returnTarget: SubMode = cameFromSubCheckBranch ? .subCheckActionBranch : .standard
        ScrollView {
            VStack(spacing: 7) {
                HStack {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            subMode = returnTarget
                        }
                    }) {
                        HStack(spacing: 2) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text("戻る")
                                .font(.system(size: 11, weight: .bold))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .foregroundColor(Color(hex: "#30D158"))
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 4)
                    Text("チェック内容")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Spacer(minLength: 4)
                }
                .padding(.horizontal, 4)
                
                Text("内容を選んで担当者または募集を指定")
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundColor(.gray)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                
                Divider()
                
                ForEach(checkProcessOptions, id: \.name) { proc in
                    let isCurrent = (liveItem.displayCheckProcess == proc.name && liveItem.checkStaff != nil)
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        recordLocalSheetInteraction()
                        selectedCheckProcess = proc.name
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            subMode = .selectCheckStaff
                        }
                    }) {
                        HStack(spacing: 8) {
                            Image(systemName: proc.icon)
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(Color(hex: proc.color))
                                .frame(width: 20)
                            
                            Text(proc.name)
                                .font(.system(size: 13.5, weight: .heavy))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                            
                            Spacer(minLength: 4)
                            
                            if isCurrent {
                                Text("選択中")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundColor(Color(hex: "#FFD60A"))
                                    .lineLimit(1)
                                    .fixedSize()
                            }
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(.gray)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                        .padding(.vertical, 9)
                        .background(isCurrent ? Color(hex: proc.color).opacity(0.25) : Color.white.opacity(0.12))
                        .foregroundColor(.white)
                        .cornerRadius(9)
                        .overlay(
                            RoundedRectangle(cornerRadius: 9)
                                .stroke(isCurrent ? Color(hex: proc.color) : Color.clear, lineWidth: 1)
                        )
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                
                if liveItem.checkStaff != nil {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        recordLocalSheetInteraction()
                        liveItem.checkProcess = "チェック"
                        liveItem.checkStaff = nil
                        onClearCheckStaff?()
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            subMode = returnTarget
                        }
                    }) {
                        Text("担当を未定に戻す")
                            .font(.system(size: 10.5, weight: .medium))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(Color.white.opacity(0.08))
                            .foregroundColor(.gray)
                            .cornerRadius(8)
                    }
                    .buttonStyle(.plain)
                }
                
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    closeSheetAfter {
                        onCancelSubCheck?()
                    }
                }) {
                    Text("チェックタイマーを解除")
                        .font(.system(size: 10.5, weight: .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(Color(hex: "#FF453A").opacity(0.15))
                        .foregroundColor(Color(hex: "#FF6961"))
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
    }
    
    // MARK: - ★ シート内サブ画面3-2: チェック（サブタイマー）の担当者・募集選択画面
    @ViewBuilder
    private var selectCheckStaffScrollView: some View {
        let returnTarget: SubMode = cameFromSubCheckBranch ? .subCheckActionBranch : .standard
        ScrollView {
            VStack(spacing: 7) {
                HStack {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            subMode = .selectCheckProcess
                        }
                    }) {
                        HStack(spacing: 2) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text("内容へ")
                                .font(.system(size: 11, weight: .bold))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .foregroundColor(Color(hex: "#30D158"))
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 4)
                    Text("【\(selectedCheckProcess)】の担当")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Spacer(minLength: 4)
                }
                .padding(.horizontal, 4)
                
                Divider()
                
                // ① 全員に募集する
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    recordLocalSheetInteraction()
                    let shouldSetCreatorToMe = liveItem.shouldClaimOrRefreshCreatorAsMe(currentUserName: currentUserName)
                    liveItem.checkProcess = selectedCheckProcess
                    liveItem.checkStaff = "募集中"
                    if shouldSetCreatorToMe {
                        liveItem.applyCreatorAsMe(currentUserName: currentUserName)
                    }
                    onRecruitCheckStaff?(selectedCheckProcess)
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        subMode = returnTarget
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "megaphone.fill")
                            .font(.system(size: 12, weight: .heavy))
                        Text("全員に募集する")
                            .font(.system(size: 12.5, weight: .black))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(
                        LinearGradient(colors: [Color(hex: "#FF9F0A"), Color(hex: "#FF8000")], startPoint: .leading, endPoint: .trailing)
                    )
                    .foregroundColor(.black)
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                
                // ② 自分が担当する
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    recordLocalSheetInteraction()
                    let shouldSetCreatorToMe = liveItem.shouldClaimOrRefreshCreatorAsMe(currentUserName: currentUserName)
                    liveItem.checkProcess = selectedCheckProcess
                    liveItem.checkStaff = currentUserName
                    if shouldSetCreatorToMe {
                        liveItem.applyCreatorAsMe(currentUserName: currentUserName)
                    }
                    onAssignCheckStaff?(selectedCheckProcess, currentUserName)
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        subMode = returnTarget
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "person.fill.checkmark")
                            .font(.system(size: 12, weight: .heavy))
                        Text("自分が担当する")
                            .font(.system(size: 12.5, weight: .heavy))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color(hex: "#30D158"))
                    .foregroundColor(.black)
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                
                // ③ 個別スタッフを指名
                Text("スタッフを指名（相手に通知）")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(Color(hex: "#A0A0A5"))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 2)
                
                if staffCandidates.isEmpty {
                    VStack(spacing: 4) {
                        Image(systemName: "person.crop.circle.badge.plus")
                            .font(.system(size: 20))
                            .foregroundColor(Color(hex: "#0A84FF"))
                        Text("📱 スマホの共有コードでメンバーを連携するとスタッフ一覧が表示されます")
                            .font(.system(size: 9, weight: .bold))
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
                        checkStaffCandidateRow(staff)
                    }
                }
                
                if liveItem.checkStaff != nil {
                    Button(action: {
                        WKInterfaceDevice.current().play(.click)
                        recordLocalSheetInteraction()
                        liveItem.checkProcess = "チェック"
                        liveItem.checkStaff = nil
                        onClearCheckStaff?()
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            subMode = returnTarget
                        }
                    }) {
                        Text("担当を未定に戻す")
                            .font(.system(size: 10.5, weight: .medium))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(Color.white.opacity(0.08))
                            .foregroundColor(.gray)
                            .cornerRadius(8)
                    }
                    .buttonStyle(.plain)
                }
                
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    closeSheetAfter {
                        onCancelSubCheck?()
                    }
                }) {
                    Text("チェックタイマーを解除")
                        .font(.system(size: 10.5, weight: .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(Color(hex: "#FF453A").opacity(0.15))
                        .foregroundColor(Color(hex: "#FF6961"))
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
    }
    
    @ViewBuilder
    private func checkStaffCandidateRow(_ staff: String) -> some View {
        let isMe = SeatTimerItem.isStaffMe(staff, currentUserName: currentUserName)
        let isSelected = (liveItem.checkStaff == staff && liveItem.displayCheckProcess == selectedCheckProcess)
        let bgColor: Color = isSelected ? Color(hex: "#30D158").opacity(0.2) : (isMe ? Color(hex: "#FFD60A").opacity(0.18) : Color.white.opacity(0.12))
        let strokeColor: Color = isSelected ? Color(hex: "#30D158").opacity(0.6) : (isMe ? Color(hex: "#FFD60A").opacity(0.5) : Color.white.opacity(0.1))
        let iconColor: Color = isMe ? Color(hex: "#FFD60A") : Color(hex: "#0A84FF")
        let returnTarget: SubMode = cameFromSubCheckBranch ? .subCheckActionBranch : .standard
        
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            recordLocalSheetInteraction()
            let shouldSetCreatorToMe = liveItem.shouldClaimOrRefreshCreatorAsMe(currentUserName: currentUserName)
            liveItem.checkProcess = selectedCheckProcess
            liveItem.checkStaff = staff
            if shouldSetCreatorToMe {
                liveItem.applyCreatorAsMe(currentUserName: currentUserName)
            }
            onAssignCheckStaff?(selectedCheckProcess, staff)
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                subMode = returnTarget
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: isMe ? "star.fill" : "person.fill")
                    .font(.system(size: 11))
                    .foregroundColor(iconColor)
                Text(isMe ? "自分" : staff)
                    .font(.system(size: 12, weight: isMe ? .heavy : .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Spacer(minLength: 4)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(Color(hex: "#30D158"))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
            .padding(.vertical, 7)
            .background(bgColor)
            .foregroundColor(.white)
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(strokeColor, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
    @State private var isClosingSheet: Bool = false
    
    private func closeSheetAfter(_ action: @escaping () -> Void) {
        guard !isClosingSheet else { return }
        isClosingSheet = true
        action()
        dismiss()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if isClosingSheet {
                isClosingSheet = false
            }
        }
    }
    
    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Text("\(item.displaySeatName)のチェックタイマー")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                
                if let staff = item.checkStaff {
                    Text("担当: \(SeatTimerItem.displayStaffName(staff, currentUserName: currentUserName))")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Color(hex: "#30D158"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                } else if item.isRecruiting {
                    Text("担当: 募集中")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Color(hex: "#FF9F0A"))
                        .lineLimit(1)
                } else {
                    Text("担当: 未定")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Color(hex: "#FFD60A"))
                        .lineLimit(1)
                }
                
                // ★ 担当者を指定/変更ボタン（タップでスタッフ選択シートを開く）
                Button(action: {
                    closeSheetAfter {
                        onOpenSelectStaff()
                    }
                }) {
                    HStack(spacing: 5) {
                        Image(systemName: "person.badge.plus")
                            .font(.system(size: 12, weight: .bold))
                        Text(item.checkStaff == nil ? "担当者を指定する" : "担当者を変更する")
                            .font(.system(size: 12, weight: .bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color(hex: "#0A84FF"))
                    .foregroundColor(.white)
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                
                Button(action: {
                    closeSheetAfter {
                        onCompleteCheck()
                    }
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                        Text("チェック完了にする")
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
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
                    closeSheetAfter {
                        onCancelCheck()
                    }
                }) {
                    Text("チェックタイマーを解除")
                        .font(.system(size: 11, weight: .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(Color.white.opacity(0.1))
                        .foregroundColor(.gray)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
        .onReceive(WatchSessionManager.shared.$timers) { received in
            guard !isClosingSheet, !received.isEmpty else { return }
            if WatchSessionManager.shared.isSeatProtectedByRecentLocalAction(seatId: item.id, seatNumber: item.seatNumber, within: 8.0) {
                return
            }
            let latest = received.first(where: { $0.id == item.id })
                ?? received.first(where: { $0.seatNumber == item.seatNumber })
            if latest == nil || latest?.isRunning == false || latest?.isCheckCompleted == true || latest?.checkTargetEndTime == nil {
                isClosingSheet = true
                dismiss()
            }
        }
    }
}

// MARK: - チェック担当スタッフ指定・募集シート（2ステップ: ①内容選択 ➔ ②担当者選択）
struct SelectCheckStaffSheet: View {
    @Environment(\.dismiss) var dismiss
    let item: SeatTimerItem
    let currentUserName: String
    let staffCandidates: [String]
    let onAssignStaff: (String, String) -> Void
    let onRecruitAll: (String) -> Void
    let onClearStaff: () -> Void
    
    @State private var currentStep: Int = 0
    @State private var selectedCheckProcess: String = "チェック"
    @State private var isClosingSheet: Bool = false
    
    private func closeSheetAfter(_ action: @escaping () -> Void) {
        guard !isClosingSheet else { return }
        isClosingSheet = true
        action()
        dismiss()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if isClosingSheet {
                isClosingSheet = false
            }
        }
    }
    
    let checkProcessOptions: [(name: String, icon: String, color: String)] = [
        ("コーミング", "comb.fill", "#0A84FF"),
        ("チェック", "magnifyingglass", "#30D158"),
        ("1液2液", "drop.fill", "#BF5AF2"),
        ("担当を呼ぶ", "bell.fill", "#FF9F0A")
    ]
    
    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if currentStep == 0 {
                    step1CheckProcessSelectionView
                } else {
                    step2CheckStaffSelectionView
                }
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
        .onAppear {
            selectedCheckProcess = item.displayCheckProcess
        }
    }
    
    @ViewBuilder
    private var step1CheckProcessSelectionView: some View {
        VStack(spacing: 2) {
            Text("\(item.displaySeatName) チェック内容")
                .font(.system(size: 13, weight: .heavy))
                .foregroundColor(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            
            Text("内容を選んで担当者または募集を指定")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.gray)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
        }
        
        Divider()
        
        ForEach(checkProcessOptions, id: \.name) { proc in
            let isCurrent = (item.displayCheckProcess == proc.name && item.checkStaff != nil)
            Button(action: {
                guard !isClosingSheet else { return }
                WKInterfaceDevice.current().play(.click)
                selectedCheckProcess = proc.name
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
                        .font(.system(size: 13.5, weight: .heavy))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    
                    Spacer(minLength: 4)
                    
                    if isCurrent {
                        Text("選択中")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(Color(hex: "#FFD60A"))
                            .lineLimit(1)
                            .fixedSize()
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.gray)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                .padding(.vertical, 9)
                .background(isCurrent ? Color(hex: proc.color).opacity(0.25) : Color.white.opacity(0.12))
                .foregroundColor(.white)
                .cornerRadius(9)
                .overlay(
                    RoundedRectangle(cornerRadius: 9)
                        .stroke(isCurrent ? Color(hex: proc.color) : Color.clear, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
        }
        
        if item.checkStaff != nil || item.isRecruiting {
            Button(action: {
                closeSheetAfter {
                    onClearStaff()
                }
            }) {
                Text("担当を未定に戻す")
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
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
    
    @ViewBuilder
    private var step2CheckStaffSelectionView: some View {
        HStack {
            Button(action: {
                guard !isClosingSheet else { return }
                WKInterfaceDevice.current().play(.click)
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    currentStep = 0
                }
            }) {
                HStack(spacing: 2) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 11, weight: .bold))
                    Text("内容へ")
                        .font(.system(size: 11, weight: .bold))
                        .lineLimit(1)
                        .fixedSize()
                }
                .foregroundColor(Color(hex: "#30D158"))
            }
            .buttonStyle(.plain)
            
            Spacer(minLength: 4)
            
            Text("【\(selectedCheckProcess)】の担当")
                .font(.system(size: 12, weight: .heavy))
                .foregroundColor(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            
            Spacer(minLength: 4)
        }
        .padding(.horizontal, 4)
        
        Divider()
        
        // ① 全員に募集する（アンバー）
        Button(action: {
            closeSheetAfter {
                onRecruitAll(selectedCheckProcess)
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: "megaphone.fill")
                    .font(.system(size: 12, weight: .heavy))
                Text("全員に募集する")
                    .font(.system(size: 13, weight: .black))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
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
        
        // ② 自分が担当する（緑）
        Button(action: {
            closeSheetAfter {
                onAssignStaff(selectedCheckProcess, currentUserName)
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: "person.fill.checkmark")
                    .font(.system(size: 12, weight: .heavy))
                Text("自分が担当する")
                    .font(.system(size: 13, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
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
            .lineLimit(1)
            .minimumScaleFactor(0.75)
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
                let isMe = SeatTimerItem.isStaffMe(staff, currentUserName: currentUserName)
                let isSelected = (item.checkStaff == staff && item.displayCheckProcess == selectedCheckProcess)
                
                Button(action: {
                    closeSheetAfter {
                        onAssignStaff(selectedCheckProcess, staff)
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: isMe ? "star.fill" : "person.fill")
                            .font(.system(size: 11))
                            .foregroundColor(isMe ? Color(hex: "#FFD60A") : Color(hex: "#0A84FF"))
                        
                        Text(isMe ? "自分" : staff)
                            .font(.system(size: 12, weight: isMe ? .heavy : .bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                        
                        Spacer(minLength: 4)
                        
                        if isSelected {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundColor(Color(hex: "#30D158"))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
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
                closeSheetAfter {
                    onClearStaff()
                }
            }) {
                Text("担当を未定に戻す")
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
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
    @State private var isMounted: Bool = false

    private let minuteColor = Color(hex: "#FFD60A")
    private let secondColor = Color(hex: "#30D158")

    var body: some View {
        let effectiveFontSize = WatchLayout.font(fontSize)
        VStack(spacing: 2) {
            HStack(spacing: 3) {
                unitField(.minute, value: totalSeconds / 60, color: minuteColor, label: "分", size: effectiveFontSize)
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
                    .font(.system(size: effectiveFontSize * 0.8, weight: .bold, design: .monospaced))
                    .foregroundColor(.gray)

                unitField(.second, value: totalSeconds % 60, color: secondColor, label: "秒", size: effectiveFontSize)
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
                    .lineLimit(1)
                    .minimumScaleFactor(0.68)
            }
            .foregroundColor(focusedUnit == .second ? secondColor : minuteColor)
        }
        .onAppear {
            isMounted = true
            syncFromTotal(totalSeconds)
            focusedUnit = .minute
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                guard isMounted else { return }
                if focusedUnit == nil {
                    focusedUnit = .minute
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
                guard isMounted else { return }
                if focusedUnit == nil {
                    focusedUnit = .minute
                }
            }
        }
        .onDisappear {
            isMounted = false
            focusedUnit = nil
        }
        .onChange(of: minuteValue) { _, newValue in
            let m = min(maxMinutes, max(0, safeClampedSeconds(newValue.rounded())))
            let next = m * 60 + totalSeconds % 60
            if next != totalSeconds { totalSeconds = next }
        }
        .onChange(of: secondValue) { _, newValue in
            let s = min(59, max(0, safeClampedSeconds(newValue.rounded())))
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

    private func unitField(_ unit: EditTimeUnit, value: Int, color: Color, label: String, size: CGFloat) -> some View {
        let selected = focusedUnit == unit
        return HStack(alignment: .lastTextBaseline, spacing: 1) {
            Text(String(format: "%02d", value))
                .font(.system(size: size, weight: .black, design: .monospaced))
                .foregroundColor(selected ? color : Color.white.opacity(0.85))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(label)
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(selected ? color : .gray)
                .lineLimit(1)
                .fixedSize()
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
    @State private var watchSoundEnabled: Bool = false
    @State private var phoneSoundEnabled: Bool = false
    @State private var isClosingSheet: Bool = false
    let onAdd: (SeatTimerItem) -> Void
    
    private func closeSheetAfter(_ action: @escaping () -> Void) {
        guard !isClosingSheet else { return }
        isClosingSheet = true
        action()
        dismiss()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if isClosingSheet {
                isClosingSheet = false
            }
        }
    }
    
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
                        .minimumScaleFactor(0.75)
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
                        .minimumScaleFactor(0.75)
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
                        .lineLimit(1)
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
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
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
                    Text("チェック:")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.gray)
                        .lineLimit(1)
                    Spacer()
                    Text(checkMinutes == 0 ? "なし" : "\(checkMinutes)分")
                        .font(.system(size: 15, weight: .heavy, design: .rounded))
                        .foregroundColor(checkMinutes == 0 ? .gray : Color(hex: "#30D158"))
                        .lineLimit(1)
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
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 6)
                                .background(checkMinutes == cmin ? Color(hex: "#30D158") : Color.white.opacity(0.12))
                                .foregroundColor(checkMinutes == cmin ? .black : Color(hex: "#E0E0E5"))
                                .cornerRadius(7)
                        }
                        .buttonStyle(.plain)
                    }
                }
                
                // ★ ウォッチの音 ON/OFF（上）＆ スマホの音 ON/OFF（下）ボタン（デフォルトOFF、バイブは常に作動）
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    watchSoundEnabled.toggle()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: watchSoundEnabled ? "applewatch.radiowaves.left.and.right" : "applewatch")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(watchSoundEnabled ? Color(hex: "#FF9F0A") : Color(hex: "#8E8E93"))
                        Text("ウォッチの音")
                            .font(.system(size: 11.5, weight: .bold))
                            .foregroundColor(watchSoundEnabled ? Color(hex: "#FFD60A") : Color(hex: "#E0E0E5"))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(watchSoundEnabled ? "ON" : "OFF")
                            .font(.system(size: 10, weight: .black))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2.5)
                            .background(watchSoundEnabled ? Color(hex: "#FF9F0A") : Color.white.opacity(0.12))
                            .foregroundColor(watchSoundEnabled ? .black : Color(hex: "#8E8E93"))
                            .cornerRadius(5)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(watchSoundEnabled ? Color(hex: "#FF9F0A").opacity(0.18) : Color.white.opacity(0.06))
                    .cornerRadius(8)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(watchSoundEnabled ? Color(hex: "#FF9F0A").opacity(0.6) : Color.white.opacity(0.12), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
                
                Button(action: {
                    WKInterfaceDevice.current().play(.click)
                    phoneSoundEnabled.toggle()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: phoneSoundEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(phoneSoundEnabled ? Color(hex: "#FF9F0A") : Color(hex: "#8E8E93"))
                        Text("スマホの音")
                            .font(.system(size: 11.5, weight: .bold))
                            .foregroundColor(phoneSoundEnabled ? Color(hex: "#FFD60A") : Color(hex: "#E0E0E5"))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(phoneSoundEnabled ? "ON" : "OFF")
                            .font(.system(size: 10, weight: .black))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2.5)
                            .background(phoneSoundEnabled ? Color(hex: "#FF9F0A") : Color.white.opacity(0.12))
                            .foregroundColor(phoneSoundEnabled ? .black : Color(hex: "#8E8E93"))
                            .cornerRadius(5)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(phoneSoundEnabled ? Color(hex: "#FF9F0A").opacity(0.18) : Color.white.opacity(0.06))
                    .cornerRadius(8)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(phoneSoundEnabled ? Color(hex: "#FF9F0A").opacity(0.6) : Color.white.opacity(0.12), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                
                Button(action: {
                    let totalSec = selectedMinutes * 60 + selectedSeconds
                    guard totalSec > 0 else { return }
                    var newItem = SeatTimerItem(
                        id: UUID().uuidString,
                        seatNumber: seatNumber,
                        creatorName: currentUserName,
                        isCreatorMeExplicit: true,
                        totalSeconds: totalSec,
                        targetEndTime: Date().addingTimeInterval(Double(totalSec)),
                        isRunning: true,
                        pausedRemainingSeconds: totalSec,
                        shampooStaff: nil,
                        status: .normal,
                        watchAlarmSoundEnabled: watchSoundEnabled,
                        alarmSoundEnabled: phoneSoundEnabled
                    )
                    if checkMinutes > 0 && (checkMinutes * 60) < totalSec {
                        newItem.checkTotalSeconds = checkMinutes * 60
                        newItem.checkTargetEndTime = Date().addingTimeInterval(Double(checkMinutes * 60))
                        newItem.checkStaff = nil
                    }
                    closeSheetAfter {
                        onAdd(newItem)
                    }
                }) {
                    Text("タイマースタート")
                        .font(.system(size: 13, weight: .heavy))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
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
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.bottom, 16)
        }
    }
}

// MARK: - シャンプー・施術操作シート（スタッフ指定済み時のタップ）
struct ShampooActionSheet: View {
    @Environment(\.dismiss) var dismiss
    let item: SeatTimerItem
    var currentUserName: String = ""
    let onStartShampoo: () -> Void
    let onFinishShampoo: () -> Void
    let onStartCombing: () -> Void
    let onFinishCombing: () -> Void
    var onStartCheck: (() -> Void)? = nil
    var onFinishCheck: (() -> Void)? = nil
    let onChangeStaff: () -> Void
    let onClearStaff: () -> Void
    @State private var isClosingSheet: Bool = false
    
    private func closeSheetAfter(_ action: @escaping () -> Void) {
        guard !isClosingSheet else { return }
        isClosingSheet = true
        action()
        dismiss()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if isClosingSheet {
                isClosingSheet = false
            }
        }
    }
    
    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                VStack(spacing: 2) {
                    Text("\(item.displaySeatName)の\(item.helpProcess)操作")
                        .font(.system(size: 13, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    
                    if let staff = item.shampooStaff {
                        Text("現在の担当: \(SeatTimerItem.displayStaffName(staff, currentUserName: currentUserName))")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(Color(hex: "#FFD60A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                }
                
                Divider()
                
                // ★ 指定された技術（helpProcess）に応じたボタンのみを1つ大きく表示
                if item.helpProcess == "コーミング" {
                    // ① コーミング指定時
                    if item.status == .combing {
                        Button(action: {
                            closeSheetAfter {
                                onFinishCombing()
                            }
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 16, weight: .bold))
                                Text("コーミング完了（通常へ）")
                                    .font(.system(size: 14, weight: .heavy))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.72)
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
                            closeSheetAfter {
                                onStartCombing()
                            }
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "comb.fill")
                                    .font(.system(size: 16, weight: .bold))
                                Text("コーミングする。")
                                    .font(.system(size: 15, weight: .heavy))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
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
                            closeSheetAfter {
                                if let finishCheck = onFinishCheck {
                                    finishCheck()
                                } else {
                                    onFinishShampoo()
                                }
                            }
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 16, weight: .bold))
                                Text("チェック完了（通常へ）")
                                    .font(.system(size: 14, weight: .heavy))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.72)
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
                            closeSheetAfter {
                                if let startCheck = onStartCheck {
                                    startCheck()
                                } else {
                                    onStartShampoo()
                                }
                            }
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "magnifyingglass")
                                    .font(.system(size: 16, weight: .bold))
                                Text("チェックする。")
                                    .font(.system(size: 15, weight: .heavy))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
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
                            closeSheetAfter {
                                onFinishShampoo()
                            }
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 16, weight: .bold))
                                Text("シャンプー完了（通常へ）")
                                    .font(.system(size: 14, weight: .heavy))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.72)
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
                            closeSheetAfter {
                                onStartShampoo()
                            }
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "drop.fill")
                                    .font(.system(size: 16, weight: .bold))
                                Text("シャンプーする。")
                                    .font(.system(size: 15, weight: .heavy))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
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
                    closeSheetAfter {
                        onChangeStaff()
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "person.2.fill")
                            .font(.system(size: 12, weight: .bold))
                        Text("スタッフ変更")
                            .font(.system(size: 12, weight: .bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
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
                    closeSheetAfter {
                        onClearStaff()
                    }
                }) {
                    Text("担当を解除（未指定に戻す）")
                        .font(.system(size: 10, weight: .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(Color.white.opacity(0.08))
                        .foregroundColor(Color(hex: "#A0A0A5"))
                        .cornerRadius(6)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
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
    var onSetNoHelp: (() -> Void)? = nil        // ヘルプなし（一人で施術）
    var onClearHelp: (() -> Void)? = nil        // 指定を解除
    
    // ステップ管理: 0 = 工程選択, 1 = スタッフ指定/募集
    @State private var currentStep: Int = 0
    @State private var selectedProcess: String = "シャンプー"
    @State private var isClosingSheet: Bool = false
    
    private func closeSheetAfter(_ action: @escaping () -> Void) {
        guard !isClosingSheet else { return }
        isClosingSheet = true
        action()
        dismiss()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if isClosingSheet {
                isClosingSheet = false
            }
        }
    }
    
    // 利用可能な工程
    let processOptions: [(name: String, icon: String, color: String)] = [
        ("シャンプー", "drop.fill", "#0A84FF"),
        ("コーミング", "comb.fill", "#0A84FF"),
        ("チェック", "magnifyingglass", "#30D158"),
        ("その他", "ellipsis.circle", "#8E8E93")
    ]
    let checkProcessOptions: [(name: String, icon: String, color: String)] = [
        ("コーミング", "comb.fill", "#0A84FF"),
        ("チェック", "magnifyingglass", "#30D158"),
        ("1液2液", "drop.fill", "#BF5AF2"),
        ("担当を呼ぶ", "bell.fill", "#FF9F0A")
    ]
    
    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if currentStep == 0 {
                    step1ProcessSelectionView
                } else {
                    step2StaffSelectionView
                }
            }
            .padding(.horizontal, WatchLayout.sheetHorizontalPadding)
            .padding(.vertical, 4)
        }
        .onAppear {
            if !item.helpProcess.isEmpty && item.helpProcess != "ヘルプなし" {
                selectedProcess = item.helpProcess
            }
        }
    }
    
    @ViewBuilder
    private var step1ProcessSelectionView: some View {
        // ===== ステップ1: 工程を選択 =====
        VStack(spacing: 2) {
            Text("\(item.displaySeatName)のヘルプ工程")
                .font(.system(size: 13, weight: .heavy))
                .foregroundColor(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Text("依頼するメニューを選択してください")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.gray)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .padding(.bottom, 2)
        
        Divider()
        
        ForEach(processOptions, id: \.name) { proc in
            let isCurrentProc = (item.helpProcess == proc.name && !item.isNoHelpNeeded)
            let bgColor: Color = isCurrentProc ? Color(hex: proc.color).opacity(0.18) : Color.white.opacity(0.12)
            let strokeColor: Color = isCurrentProc ? Color(hex: proc.color).opacity(0.6) : Color.clear
            
            Button(action: {
                guard !isClosingSheet else { return }
                WKInterfaceDevice.current().play(.click)
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
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    
                    Spacer(minLength: 4)
                    
                    if isCurrentProc {
                        Text("選択中")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(Color(hex: proc.color))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(Color(hex: proc.color).opacity(0.2))
                            .cornerRadius(4)
                            .lineLimit(1)
                            .fixedSize()
                    }
                    
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.gray)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                .padding(.vertical, 10)
                .background(bgColor)
                .foregroundColor(.white)
                .cornerRadius(9)
                .overlay(
                    RoundedRectangle(cornerRadius: 9)
                        .stroke(strokeColor, lineWidth: 1)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        
        // ★ ヘルプなし（一人で施術）
        if let setNoHelp = onSetNoHelp {
            let noHelpBg: Color = item.isNoHelpNeeded ? Color(hex: "#30D158").opacity(0.2) : Color.white.opacity(0.08)
            let noHelpFg: Color = item.isNoHelpNeeded ? Color(hex: "#30D158") : Color(hex: "#E0E0E5")
            Button(action: {
                closeSheetAfter {
                    WKInterfaceDevice.current().play(.click)
                    setNoHelp()
                }
            }) {
                HStack(spacing: 6) {
                    Image(systemName: "person.fill.checkmark")
                        .font(.system(size: 12, weight: .bold))
                    Text("ヘルプなし（一人で施術）")
                        .font(.system(size: 12, weight: .bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Spacer(minLength: 4)
                    if item.isNoHelpNeeded {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundColor(Color(hex: "#30D158"))
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                .padding(.vertical, 9)
                .background(noHelpBg)
                .foregroundColor(noHelpFg)
                .cornerRadius(9)
            }
            .buttonStyle(.plain)
        }
        
        // ★ 指定を解除（未選択に戻す）
        if let clearHelp = onClearHelp, (!item.helpProcess.isEmpty || item.shampooStaff != nil || item.isRecruiting || item.isNoHelpNeeded) {
            Button(action: {
                closeSheetAfter {
                    WKInterfaceDevice.current().play(.click)
                    clearHelp()
                }
            }) {
                Text("指定を解除（未選択に戻す）")
                    .font(.system(size: 10.5, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(Color.white.opacity(0.06))
                    .foregroundColor(Color(hex: "#FF453A"))
                    .cornerRadius(7)
            }
            .buttonStyle(.plain)
        }
    }
    
    @ViewBuilder
    private var step2StaffSelectionView: some View {
        // ===== ステップ2: 全員に募集 または スタッフ指定 =====
        VStack(spacing: 2) {
            HStack {
                Button(action: {
                    guard !isClosingSheet else { return }
                    withAnimation {
                        currentStep = 0
                    }
                }) {
                    HStack(spacing: 2) {
                        Image(systemName: "chevron.left")
                        Text("工程へ")
                            .lineLimit(1)
                            .fixedSize()
                    }
                    .font(.system(size: 10.5, weight: .bold))
                    .foregroundColor(Color(hex: "#0A84FF"))
                }
                .buttonStyle(.plain)
                
                Spacer(minLength: 4)
                
                Text("【\(selectedProcess)】の担当")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                
                Spacer(minLength: 4)
            }
            
            Text("全員に募集、または担当スタッフを指名")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.gray)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        
        Divider()
        
        // ★ ① 全員に募集する（目立つアンバーボタン・全員に通知）
        Button(action: {
            closeSheetAfter {
                WKInterfaceDevice.current().play(.click)
                onRecruitAll(selectedProcess)
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: "megaphone.fill")
                    .font(.system(size: 13, weight: .heavy))
                Text("全員に募集する")
                    .font(.system(size: 13, weight: .black))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
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
        
        // ★ ② 自分が担当する（ショートカット）
        Button(action: {
            closeSheetAfter {
                WKInterfaceDevice.current().play(.click)
                onAssignStaff(selectedProcess, currentUserName)
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(Color(hex: "#30D158"))
                Text("自分が担当する")
                    .font(.system(size: 12, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Spacer(minLength: 4)
                if SeatTimerItem.isStaffMe(item.shampooStaff, currentUserName: currentUserName) && item.helpProcess == selectedProcess {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 12))
                        .foregroundColor(Color(hex: "#30D158"))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
            .padding(.vertical, 8)
            .background(Color(hex: "#30D158").opacity(0.18))
            .foregroundColor(.white)
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color(hex: "#30D158").opacity(0.5), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        
        // ★ ③ 個別スタッフを指名する
        Text("他のスタッフを指名（相手に通知）")
            .font(.system(size: 9, weight: .bold))
            .foregroundColor(Color(hex: "#A0A0A5"))
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 2)
        
        let otherCandidates = staffCandidates.filter { $0 != currentUserName }
        if otherCandidates.isEmpty {
            // ★ 他のメンバーが0人の場合の案内カード
            VStack(spacing: 5) {
                Image(systemName: "person.crop.circle.badge.plus")
                    .font(.system(size: 22))
                    .foregroundColor(Color(hex: "#0A84FF"))
                    .padding(.top, 2)
                Text("📱 スマホの共有コードでメンバーを連携すると\n他のスタッフを指名できます")
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
            ForEach(otherCandidates, id: \.self) { staff in
                let isSelected = (item.shampooStaff == staff && item.helpProcess == selectedProcess)
                let bgColor: Color = isSelected ? Color(hex: "#0A84FF").opacity(0.22) : Color.white.opacity(0.12)
                let strokeColor: Color = isSelected ? Color(hex: "#0A84FF").opacity(0.6) : Color.white.opacity(0.1)
                
                Button(action: {
                    closeSheetAfter {
                        WKInterfaceDevice.current().play(.click)
                        onAssignStaff(selectedProcess, staff)
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "person.fill")
                            .font(.system(size: 11))
                            .foregroundColor(Color(hex: "#0A84FF"))
                        
                        Text(staff)
                            .font(.system(size: 12, weight: .bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                        
                        Spacer(minLength: 4)
                        
                        if isSelected {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundColor(Color(hex: "#30D158"))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
                    .padding(.vertical, 7)
                    .background(bgColor)
                    .foregroundColor(.white)
                    .cornerRadius(8)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(strokeColor, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
            }
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
    var crownFocusTrigger: Int = 0
    var isModalSheetPresented: Bool = false
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
    
    // ★ 指でのドラッグ操作に加えて、Digital Crown（トグル）でも上下にスクロール移動できるようフォーカス＆ステップ管理
    @FocusState private var isMapCrownFocused: Bool
    @State private var crownValue: Double = 0.0
    @State private var currentScrollStep: Int = 0
    
    // 席番号順（1番席、2番席、3番席...）に整列して物理レイアウトと連動
    var physicalSortedTimers: [SeatTimerItem] {
        timers.sorted { $0.seatNumber < $1.seatNumber }
    }
    
    // 2列ずつの行配列（Digital Crownでの行単位スクロールと指スクロールを両立）
    var seatRows: [[SeatTimerItem]] {
        let sorted = physicalSortedTimers
        var rows: [[SeatTimerItem]] = []
        var index = 0
        while index < sorted.count {
            let end = min(index + 2, sorted.count)
            rows.append(Array(sorted[index..<end]))
            index += 2
        }
        return rows
    }
    
    // スクロール可能な最大ステップインデックス（0:ヘッダー, 1:メインタイマー, 2...N+1:客席行, N+2:下部追加ボタン）
    var maxScrollStep: Int {
        seatRows.count + 2
    }
    
    // サマリー集計（メインタイマーも稼働数に算入・超過カウントアップ中も稼働としてカウント）
    var isMainRunning: Bool {
        guard let m = mainTimer else { return false }
        return m.isRunning || m.isPreCountingDown
    }
    var runningCount: Int {
        timers.filter { $0.isRunning }.count + (isMainRunning ? 1 : 0)
    }
    var recruitingCount: Int { timers.filter { $0.isRecruiting }.count }
    var pausedCount: Int {
        timers.filter { !$0.isRunning }.count + ((mainTimer != nil && !isMainRunning) ? 1 : 0)
    }
    
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 7) {
                    mapHeaderSection
                        .id("map_step_0")
                    
                    // ★ メインタイマー専用カード（上段にフルタイトル・下段に特大タイマー時間・タップで詳細シート）
                    if let main = mainTimer {
                        ThumbnailMainTimerCard(
                            item: main,
                            now: now,
                            onTap: {
                                onSelectMainTimer()
                            }
                        )
                        .id("map_step_1")
                    }
                    
                    Divider()
                    
                    mapSeatGridSection
                    
                    mapFooterSection
                        .id("map_step_\(maxScrollStep)")
                }
                .padding(.horizontal, 4)
                .padding(.vertical, 4)
            }
            .focusable()
            .focused($isMapCrownFocused)
            .digitalCrownRotation(
                $crownValue,
                from: -10000.0,
                through: 10000.0,
                by: 1.0,
                sensitivity: .low,
                isContinuous: true,
                isHapticFeedbackEnabled: true
            )
            .onChange(of: crownValue) { oldVal, newVal in
                guard !isModalSheetPresented else { return }
                let delta = safeClampedSeconds(newVal.rounded()) - safeClampedSeconds(oldVal.rounded())
                guard delta != 0 else { return }
                let direction = delta > 0 ? 1 : -1
                let nextStep = min(maxScrollStep, max(0, currentScrollStep + direction))
                if nextStep != currentScrollStep {
                    currentScrollStep = nextStep
                }
                let anchor: UnitPoint = nextStep == 0 ? .top : (nextStep >= maxScrollStep ? .bottom : .center)
                withAnimation(.easeOut(duration: 0.16)) {
                    proxy.scrollTo("map_step_\(nextStep)", anchor: anchor)
                }
            }
            .onAppear {
                if !isModalSheetPresented {
                    isMapCrownFocused = true
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    if !isModalSheetPresented {
                        isMapCrownFocused = true
                    }
                }
            }
            .onChange(of: isModalSheetPresented) { _, presented in
                if presented {
                    isMapCrownFocused = false
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                        if !isModalSheetPresented {
                            isMapCrownFocused = true
                        }
                    }
                }
            }
            .onChange(of: crownFocusTrigger) { _, _ in
                guard !isModalSheetPresented else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    if !isModalSheetPresented {
                        isMapCrownFocused = true
                    }
                }
            }
        }
    }
    
    @ViewBuilder
    private var mapHeaderSection: some View {
        // ① ヘッダー＆サマリーピルバー
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: "square.grid.2x2.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(Color(hex: "#64D2FF"))
                Text("サロン客席マップ")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Spacer(minLength: 4)
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
                            .lineLimit(1)
                            .fixedSize()
                    }
                    .foregroundColor(Color(hex: "#64D2FF"))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2.5)
                    .background(Color(hex: "#64D2FF").opacity(0.18))
                    .cornerRadius(6)
                    .fixedSize(horizontal: true, vertical: false)
                }
                .buttonStyle(.plain)
            }
            
            // 稼働サマリーピル（一目で状況把握）
            HStack(spacing: 4) {
                HStack(spacing: 3) {
                    Circle()
                        .fill(Color(hex: "#30D158"))
                        .frame(width: 6, height: 6)
                    Text("稼働:\(runningCount)")
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                }
                .padding(.horizontal, 5)
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
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                    }
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color(hex: "#FF9F0A").opacity(0.25))
                    .cornerRadius(5)
                }
                
                HStack(spacing: 2) {
                    Text("⏸ 停止:\(pausedCount)")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(Color(hex: "#8E8E93"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                }
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Color.white.opacity(0.08))
                .cornerRadius(5)
                
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 4)
    }
    
    @ViewBuilder
    private var mapSeatGridSection: some View {
        // ② 2列サムネイルグリッド（客席タイマー群：指スクロール＋Digital Crown上下スクロール両対応）
        VStack(spacing: 6) {
            ForEach(Array(seatRows.enumerated()), id: \.offset) { rowIdx, rowItems in
                HStack(spacing: 6) {
                    ForEach(rowItems) { item in
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            onSelectSeat(item)
                        }) {
                            ThumbnailSeatCard(
                                item: item,
                                currentUserName: currentUserName,
                                now: now
                            )
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .frame(maxWidth: .infinity)
                    }
                    if rowItems.count == 1 {
                        Color.clear
                            .frame(maxWidth: .infinity)
                    }
                }
                .id("map_step_\(rowIdx + 2)")
                .onAppear {
                    currentScrollStep = rowIdx + 2
                }
            }
        }
        .padding(.horizontal, 2)
    }
    
    @ViewBuilder
    private var mapFooterSection: some View {
        VStack(spacing: 6) {
            Text("※タップで操作 / リューズまたは指で上下移動")
                .font(.system(size: 8.5, weight: .medium))
                .foregroundColor(Color(hex: "#8E8E93"))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
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
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
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
                        .minimumScaleFactor(0.75)
                    
                    if let genre = item.genre, !genre.isEmpty {
                        Text(genre)
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundColor(stateColor.text)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(stateColor.text.opacity(0.2))
                            .cornerRadius(4)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    
                    Spacer(minLength: 4)
                    
                    // 稼働状態インジケータ（タップで設定へ進めることが直感的にわかる）
                    HStack(spacing: 2) {
                        if isOvertime {
                            Text("超過")
                                .font(.system(size: 9.5, weight: .heavy))
                                .foregroundColor(Color(hex: "#FF453A"))
                                .lineLimit(1)
                                .fixedSize()
                        } else if item.isPreCountingDown {
                            Circle()
                                .fill(Color(hex: "#FFD60A"))
                                .frame(width: 5, height: 5)
                            Text("準備中")
                                .font(.system(size: 9.5, weight: .bold))
                                .foregroundColor(Color(hex: "#FFD60A"))
                                .lineLimit(1)
                                .fixedSize()
                        } else if isRunning {
                            Circle()
                                .fill(stateColor.text)
                                .frame(width: 5, height: 5)
                            Text("稼働中")
                                .font(.system(size: 9.5, weight: .bold))
                                .foregroundColor(stateColor.text)
                                .lineLimit(1)
                                .fixedSize()
                        } else {
                            Text(item.isZero ? "00:00" : "⏸ 停止")
                                .font(.system(size: 9.5, weight: .medium))
                                .foregroundColor(Color(hex: "#8E8E93"))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundColor(Color(hex: "#8E8E93"))
                    }
                    .fixedSize(horizontal: true, vertical: false)
                }
                
                // 下段: 大きなタイマー数字 ＆ 全体設定分数（改行せず1行で綺麗に収まる）
                HStack(alignment: .firstTextBaseline) {
                    if item.isPreCountingDown {
                        Text(formatSeconds(item.prepRemainingSeconds))
                            .font(.system(size: WatchLayout.font(20), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#FFD60A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    } else if isRunning {
                        Text(formatSeconds(rem))
                            .font(.system(size: WatchLayout.font(20), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(stateColor.text)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    } else if isOvertime {
                        Text("+\(formatSeconds(abs(rem)))")
                            .font(.system(size: WatchLayout.font(20), weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#FF453A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    } else {
                        let pausedSec = max(0, item.pausedRemainingSeconds)
                        Text(formatSeconds(pausedSec))
                            .font(.system(size: WatchLayout.font(20), weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#8E8E93"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    
                    Spacer(minLength: 4)
                    
                    Text("\(max(1, item.totalSeconds / 60))分設定")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(Color(hex: "#8E8E93"))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(.horizontal, WatchLayout.buttonHorizontalPadding)
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
    var isCheckOvertime: Bool { item.isCheckOvertime }
    var isAnyOvertime: Bool { isOvertime || isCheckOvertime }
    var isMe: Bool { item.isRelated(to: currentUserName) }
    var rem: Int { item.remainingSeconds }
    
    // 時間連動カラー判定（青 ➔ 残り3分: 黄 ➔ 残り1分: 赤 ➔ 超過: 全赤＆パルス発光）
    var stateColor: (border: Color, bg: Color, text: Color) {
        if isAnyOvertime {
            let red = Color(hex: "#FF453A")
            return (red, red.opacity(isPulsing ? 0.38 : 0.18), isOvertime ? red : Color(hex: "#64D2FF"))
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
            } else if SeatTimerItem.isStaffMe(item.shampooStaff, currentUserName: currentUserName) || item.isCreatorMe(currentUserName: currentUserName) {
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
                    .minimumScaleFactor(0.72)
                
                Spacer(minLength: 2)
                
                if isOvertime {
                    Text("超過")
                        .font(.system(size: 8, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(Color(hex: "#FF453A"))
                        .cornerRadius(3)
                } else if isCheckOvertime {
                    Text("検超過")
                        .font(.system(size: 7.5, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(Color(hex: "#FF453A"))
                        .cornerRadius(3)
                } else if isRunning && rem <= 60 {
                    Text("まもなく")
                        .font(.system(size: 7.5, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(Color(hex: "#FF453A"))
                        .cornerRadius(3)
                } else if isRunning && rem <= 180 {
                    Text("残3分")
                        .font(.system(size: 7.5, weight: .heavy))
                        .foregroundColor(.black)
                        .lineLimit(1)
                        .fixedSize()
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
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(Color.white.opacity(0.12))
                        .cornerRadius(3)
                }
            }
            
            // 中段: 時間数字（稼働中は大きく、超過時は赤、停止中は薄く）
            if isRunning {
                Text(formatSeconds(rem))
                    .font(.system(size: WatchLayout.font(15), weight: .black, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(stateColor.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            } else if isOvertime {
                Text("+\(formatSeconds(abs(rem)))")
                    .font(.system(size: WatchLayout.font(14.5), weight: .black, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(Color(hex: "#FF453A"))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            } else {
                Text("00:00")
                    .font(.system(size: WatchLayout.font(14), weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(Color(hex: "#636366"))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            
            // ★ チェック体制（チェックタイマー稼働中のみ中段下部に表示）
            if let checkRem = item.checkRemainingSeconds, !item.isCheckCompleted {
                let checkStaff = item.checkStaff ?? (item.isRecruiting ? "募集中" : "未定")
                let isCheckOver = item.isCheckOvertime
                let isCheckUnder1Min = checkRem <= 60
                let checkColor: Color = (isCheckOver || isCheckUnder1Min) ? Color(hex: "#FF453A") : Color(hex: "#FF9F0A")
                
                HStack(spacing: 2) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 6.5, weight: .bold))
                    Text(isCheckOver ? "検:+\(formatSeconds(item.checkOvertimeSeconds))" : "検:\(formatSeconds(checkRem))")
                        .font(.system(size: 7.5, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .lineLimit(1)
                        .fixedSize()
                    Text(SeatTimerItem.displayStaffName(checkStaff, currentUserName: currentUserName))
                        .font(.system(size: 7, weight: .bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.68)
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
                let creatorIsMe = item.isCreatorMe(currentUserName: currentUserName)
                HStack(spacing: 2) {
                    Image(systemName: "pencil")
                        .font(.system(size: 6.5, weight: .bold))
                        .foregroundColor(creatorIsMe ? Color(hex: "#FFD60A") : Color(hex: "#8E8E93"))
                    Text("主:\(item.displayCreatorName(currentUserName: currentUserName))")
                        .font(.system(size: 8, weight: creatorIsMe ? .heavy : .bold))
                        .foregroundColor(creatorIsMe ? Color(hex: "#FFD60A") : Color(hex: "#E5E5EA"))
                        .lineLimit(1)
                        .minimumScaleFactor(0.68)
                }
                
                // ② ヘルプ担当（アシスタント / 一人施術 / 募集中）
                let procPrefix = (item.helpProcess.isEmpty || item.helpProcess == "ヘルプなし") ? "助" : item.helpProcess
                HStack(spacing: 2) {
                    if item.status != .normal {
                        let staffStr = (item.shampooStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        let staffIsMe = SeatTimerItem.isStaffMe(staffStr, currentUserName: currentUserName)
                        let dispStaff = staffStr.isEmpty ? "施術中" : SeatTimerItem.displayStaffName(staffStr, currentUserName: currentUserName)
                        let procShort = (item.status == .shampoo) ? "💧SP" : ((item.status == .combing) ? "🪮コ" : "🔍検")
                        Text("\(procShort):\(dispStaff)")
                            .font(.system(size: 8, weight: .heavy))
                            .foregroundColor(staffIsMe ? Color(hex: "#FFD60A") : ((item.status == .check) ? Color(hex: "#30D158") : Color(hex: "#64D2FF")))
                            .lineLimit(1)
                            .minimumScaleFactor(0.68)
                    } else if item.isNoHelpNeeded {
                        Image(systemName: "person.fill")
                            .font(.system(size: 6.5))
                            .foregroundColor(Color(hex: "#8E8E93"))
                        Text("助:なし (一人)")
                            .font(.system(size: 8, weight: .medium))
                            .foregroundColor(Color(hex: "#8E8E93"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.68)
                    } else if (!isRunning && rem <= 0) || item.isZero || item.isCollapsed {
                        Text("助:待機中")
                            .font(.system(size: 8, weight: .medium))
                            .foregroundColor(Color(hex: "#8E8E93"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.68)
                    } else if item.isRecruiting {
                        Image(systemName: "megaphone.fill")
                            .font(.system(size: 6.5))
                            .foregroundColor(Color(hex: "#FF9F0A"))
                        Text("\(procPrefix):募集中")
                            .font(.system(size: 8, weight: .heavy))
                            .foregroundColor(Color(hex: "#FFD60A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.68)
                    } else if let staff = item.shampooStaff, !staff.isEmpty {
                        let staffIsMe = SeatTimerItem.isStaffMe(staff, currentUserName: currentUserName)
                        Image(systemName: "hands.sparkles.fill")
                            .font(.system(size: 6.5))
                            .foregroundColor(staffIsMe ? Color(hex: "#FFD60A") : Color(hex: "#0A84FF"))
                        Text("\(procPrefix):\(SeatTimerItem.displayStaffName(staff, currentUserName: currentUserName))")
                            .font(.system(size: 8, weight: staffIsMe ? .heavy : .bold))
                            .foregroundColor(staffIsMe ? Color(hex: "#FFD60A") : Color(hex: "#64D2FF"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.68)
                    } else if isRunning {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 6.5))
                            .foregroundColor(Color(hex: "#FF9F0A"))
                        Text("\(procPrefix):未定")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundColor(Color(hex: "#FF9F0A"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.68)
                    } else {
                        Text("助:待機中")
                            .font(.system(size: 8, weight: .medium))
                            .foregroundColor(Color(hex: "#8E8E93"))
                            .lineLimit(1)
                            .minimumScaleFactor(0.68)
                    }
                }
            }
            .padding(.top, 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, WatchLayout.isSmall ? 4.5 : 6)
        .padding(.vertical, 5)
        .background(stateColor.bg)
        .cornerRadius(9)
        .overlay(
            RoundedRectangle(cornerRadius: 9)
                .stroke(stateColor.border, lineWidth: isAnyOvertime && isPulsing ? 1.5 : 1)
        )
        .shadow(color: isAnyOvertime && isPulsing ? Color(hex: "#FF453A").opacity(0.85) : Color.clear, radius: 4)
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
