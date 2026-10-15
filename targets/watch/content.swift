import SwiftUI
import Combine

// MARK: - データモデル (絶対終了時刻 targetEndTime 基準)
struct SeatTimerItem: Identifiable, Equatable {
    let id: String
    var seatNumber: Int
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
    
    // 途中チェックタイマー
    var checkTotalSeconds: Int?
    var checkTargetEndTime: Date?
    var checkStaff: String?
    var isCheckCompleted: Bool = false
    
    // ヘルプ未定アラート発火済みフラグ（全員通知用）
    var hasAlertedHelpUnassigned: Bool = false
    
    // ★ アコーディオン折りたたみフラグ（計測終了時など）
    var isCollapsed: Bool = false
    
    // 現在の残り秒数（動的計算）
    var remainingSeconds: Int {
        if !isRunning {
            return pausedRemainingSeconds
        }
        return Int(targetEndTime.timeIntervalSince(Date()))
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
    
    // 自分に関係している席か判定（作成者 or シャンプー担当 or チェック担当）
    func isRelated(to userName: String) -> Bool {
        return creatorName == userName ||
               shampooStaff == userName ||
               checkStaff == userName
    }
}

// MARK: - SeatTimerItem 辞書相互変換（iPhone連携用）
extension SeatTimerItem {
    init?(dictionary: [String: Any]) {
        guard let id = dictionary["id"] as? String else { return nil }
        self.id = id
        
        if let num = dictionary["seatNumber"] as? Int {
            self.seatNumber = num
        } else if let label = dictionary["seatLabel"] as? String {
            let digits = label.compactMap { $0.isNumber ? String($0) : nil }.joined()
            self.seatNumber = Int(digits) ?? 1
        } else {
            self.seatNumber = 1
        }
        
        self.creatorName = (dictionary["creatorName"] as? String) ?? (dictionary["colorStaffName"] as? String) ?? "スタイリスト"
        self.totalSeconds = (dictionary["totalSeconds"] as? Int) ?? (dictionary["targetSeconds"] as? Int) ?? 600
        
        if let endMs = dictionary["targetEndTimestamp"] as? Double {
            self.targetEndTime = Date(timeIntervalSince1970: endMs / 1000.0)
        } else if let endSec = dictionary["targetEndTime"] as? Double {
            self.targetEndTime = Date(timeIntervalSince1970: endSec)
        } else {
            self.targetEndTime = Date().addingTimeInterval(TimeInterval(self.totalSeconds))
        }
        
        let statusStr = dictionary["status"] as? String ?? "running"
        self.isRunning = (statusStr == "running")
        
        if let paused = dictionary["pausedRemainingSeconds"] as? Int {
            self.pausedRemainingSeconds = paused
        } else {
            let rem = Int(self.targetEndTime.timeIntervalSince(Date()))
            self.pausedRemainingSeconds = max(0, rem)
        }
        
        self.helpProcess = (dictionary["helpProcess"] as? String) ?? (dictionary["actionStatus"] as? String) ?? "シャンプー"
        let rawShampoo = (dictionary["shampooStaff"] as? String) ?? (dictionary["assistantStaffName"] as? String)
        self.shampooStaff = (rawShampoo?.isEmpty == false) ? rawShampoo : nil
        self.isRecruiting = (dictionary["isRecruiting"] as? Bool) ?? false
        self.isNoHelpNeeded = (dictionary["isNoHelpNeeded"] as? Bool) ?? false
        
        let actionStatus = dictionary["actionStatus"] as? String
        let isShampooing = dictionary["isShampooing"] as? Bool ?? false
        if isShampooing || actionStatus == "shampoo" {
            self.status = .shampoo
        } else if actionStatus == "combing" {
            self.status = .combing
        } else if actionStatus == "check" {
            self.status = .check
        } else {
            self.status = .normal
        }
        
        self.checkTotalSeconds = (dictionary["checkTotalSeconds"] as? Int) ?? (dictionary["checkTargetSeconds"] as? Int)
        if let checkEndMs = (dictionary["checkEndTimestamp"] as? Double) ?? (dictionary["checkTargetEndTime"] as? Double) {
            self.checkTargetEndTime = Date(timeIntervalSince1970: checkEndMs / 1000.0)
        }
        let rawCheckStaff = (dictionary["checkStaff"] as? String) ?? (dictionary["checkStaffName"] as? String)
        self.checkStaff = (rawCheckStaff?.isEmpty == false) ? rawCheckStaff : nil
        self.isCheckCompleted = (dictionary["isCheckCompleted"] as? Bool) ?? false
        self.isCollapsed = (dictionary["isCollapsed"] as? Bool) ?? false
    }
}

import WatchConnectivity

// MARK: - iPhone (WCSession) 通信マネージャー
class WatchSessionManager: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchSessionManager()
    
    @Published var timers: [SeatTimerItem] = []
    @Published var currentUserName: String = "スタイリスト"
    @Published var isConnectedToPhone: Bool = false
    
    override init() {
        super.init()
        if WCSession.isSupported() {
            let session = WCSession.default
            session.delegate = self
            session.activate()
        }
    }
    
    // MARK: - WCSessionDelegate
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.isConnectedToPhone = (activationState == .activated)
            if let context = session.receivedApplicationContext as [String: Any]?, !context.isEmpty {
                self.processReceivedData(context)
            }
        }
    }
    
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
        DispatchQueue.main.async {
            self.processReceivedData(applicationContext)
        }
    }
    
    func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
        DispatchQueue.main.async {
            self.processReceivedData(message)
        }
    }
    
    func session(_ session: WCSession, didReceiveMessage message: [String : Any], replyHandler: @escaping ([String : Any]) -> Void) {
        DispatchQueue.main.async {
            self.processReceivedData(message)
            replyHandler(["status": "ok"])
        }
    }
    
    func processReceivedData(_ data: [String: Any]) {
        // スタッフ名同期
        if let name = data["userName"] as? String, !name.isEmpty {
            self.currentUserName = name
        }
        
        // 座席リスト同期
        if let seatsArray = data["seats"] as? [[String: Any]] {
            let parsed = seatsArray.compactMap { SeatTimerItem(dictionary: $0) }
            self.timers = parsed
        }
    }
    
    // MARK: - iPhoneへのアクション送信
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
        
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil) { error in
                print("[WatchSession] sendMessage error: \(error.localizedDescription)")
            }
        } else {
            session.transferUserInfo(payload)
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

// MARK: - メイン画面
struct ContentView: View {
    @StateObject private var sessionManager = WatchSessionManager.shared
    
    // ログイン中の自ユーザー名（サロン設定・iPhone同期）
    @State private var currentUserName: String = "スタイリスト"
    
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
    
    // 共有通知バナー（トースト表示）
    @State private var notificationBannerText: String? = nil
    @State private var notificationBannerColor: Color = Color(hex: "#0A84FF")
    
    // 客席サムネイル・バードビューシートフラグ（画面長押しまたは右上⊞アイコンでオープン）
    @State private var showingThumbnailMap = false
    
    // 客席タイマー一覧（iPhone同期受信データ、初期値は空）
    @State private var timers: [SeatTimerItem] = []
    
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
    
    var body: some View {
        NavigationStack {
            ZStack(alignment: .top) {
                cardsScrollView
                
                if let banner = notificationBannerText {
                    bannerView(banner)
                }
            }
            .navigationTitle("共有タイマー")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: {
                        playHaptic(.click)
                        showingThumbnailMap = true
                    }) {
                        Image(systemName: "square.grid.2x2.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(Color(hex: "#64D2FF"))
                    }
                }
            }
            // ★ 客席サムネイル・バードビューシート（長押しまたは右上グリッドタップで表示）
            .sheet(isPresented: $showingThumbnailMap) {
                SeatThumbnailMapSheet(
                    timers: timers,
                    currentUserName: currentUserName,
                    now: now,
                    onSelectSeat: { selectedSeat in
                        timeActionTargetId = selectedSeat.id
                    }
                )
            }
            // 新規席追加シート
            .sheet(isPresented: $showingAddSeatSheet) {
                addSeatSheetView
            }
            // タイム操作シート
            .sheet(item: bindingTimeAction) { item in
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
            .onReceive(ticker) { input in
                now = input
                checkUnassignedHelpAlerts()
            }
            .onReceive(sessionManager.$timers) { received in
                withAnimation(.easeInOut(duration: 0.25)) {
                    self.timers = received
                }
            }
            .onReceive(sessionManager.$currentUserName) { receivedName in
                if !receivedName.isEmpty {
                    self.currentUserName = receivedName
                }
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

    @ViewBuilder
    private var cardsScrollView: some View {
        ScrollView {
            VStack(spacing: 12) {
                if timers.isEmpty {
                    // ★ 席が0件の時のプレースホルダー表示
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
                            onClaimCheck: {
                                withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                                        timers[idx].checkStaff = currentUserName
                                    }
                                }
                                sessionManager.sendActionToPhone(action: "CLAIM_CHECK", seatId: item.id)
                                showNotification(text: "📤 チェック担当に立候補しました", color: Color(hex: "#30D158"))
                            }
                        )
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
            }
            .padding(.horizontal, 2)
            .padding(.bottom, 20)
        }
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.45)
                .onEnded { _ in
                    playHaptic(.start)
                    showingThumbnailMap = true
                }
        )
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
    
    @ViewBuilder
    private var addSeatSheetView: some View {
        AddSeatSheet(
            currentUserName: currentUserName,
            suggestedSeatNumber: (timers.map { $0.seatNumber }.max() ?? 0) + 1,
            onAdd: { newSeat in
                withAnimation {
                    timers.append(newSeat)
                }
                showNotification(text: "📤 \(newSeat.seatNumber)番席を新規作成しました", color: Color(hex: "#0A84FF"))
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
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                            timers[idx].isRunning = false
                            timers[idx].pausedRemainingSeconds = item.remainingSeconds
                            let process = timers[idx].helpProcess
                            timers[idx].status = (process == "コーミング" ? .combing : .shampoo)
                            timers[idx].shampooStaff = currentUserName
                        }
                        sessionManager.sendActionToPhone(action: "ENTER_HELP", seatId: item.id)
                        let process = item.helpProcess.isEmpty ? "シャンプー" : item.helpProcess
                        showNotification(
                            text: "📤 【\(item.seatNumber)番席】\(currentUserName)さんが\(process)に入りました",
                            color: Color(hex: "#0A84FF")
                        )
                    }
                },
                onResetZero: {
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                            timers[idx].totalSeconds = 0
                            timers[idx].pausedRemainingSeconds = 0
                            timers[idx].targetEndTime = Date()
                            timers[idx].isRunning = false
                            timers[idx].status = .normal
                            timers[idx].checkTotalSeconds = nil
                            timers[idx].checkTargetEndTime = nil
                            timers[idx].checkStaff = nil
                            timers[idx].isCheckCompleted = false
                            timers[idx].shampooStaff = nil
                            timers[idx].isRecruiting = false
                            timers[idx].isNoHelpNeeded = false
                        }
                        sessionManager.sendActionToPhone(action: "RESET_ZERO", seatId: item.id)
                        showNotification(
                            text: "⏱️ \(item.seatNumber)番席: 00:00にリセットしました",
                            color: Color(hex: "#FFD60A")
                        )
                    }
                },
                onFinishMeasure: {
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                            timers[idx].isRunning = false
                            timers[idx].isCollapsed = true
                        }
                        sessionManager.sendActionToPhone(action: "FINISH_MEASURE", seatId: item.id)
                        showNotification(
                            text: "🏁 \(item.seatNumber)番席: 計測を終了しました",
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
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        timers[idx].targetEndTime = timers[idx].targetEndTime.addingTimeInterval(Double(deltaSec))
                        timers[idx].pausedRemainingSeconds += deltaSec
                        sessionManager.sendActionToPhone(action: "ADJUST_TIME", seatId: item.id, extra: ["secondsToAdd": deltaSec])
                        let deltaText = formatDeltaString(deltaSec)
                        showNotification(text: "⏱️ \(item.seatNumber)番席: \(deltaText)しました", color: Color(hex: "#0A84FF"))
                    }
                },
                onStop: {
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        timers[idx].isRunning = false
                        timers[idx].pausedRemainingSeconds = 0
                        sessionManager.sendActionToPhone(action: "STOP_TIMER", seatId: item.id)
                        showNotification(text: "⏹️ \(item.seatNumber)番席のタイマーを止めました", color: Color(hex: "#30D158"))
                    }
                },
                onReinputTime: { totalSec in
                    if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                        let sec = max(10, totalSec)
                        let m = sec / 60
                        let s = sec % 60
                        let timeStr = s > 0 ? "\(m)分\(s)秒" : "\(m)分"
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                            timers[idx].totalSeconds = sec
                            timers[idx].targetEndTime = Date().addingTimeInterval(Double(sec))
                            timers[idx].pausedRemainingSeconds = sec
                            timers[idx].isRunning = true
                            timers[idx].status = .normal
                            
                            // ★ 連動してチェックも消える！
                            timers[idx].checkTotalSeconds = nil
                            timers[idx].checkTargetEndTime = nil
                            timers[idx].checkStaff = nil
                            timers[idx].isCheckCompleted = false
                        }
                        sessionManager.sendActionToPhone(action: "START_TIMER", seatId: item.id, extra: ["targetSeconds": sec])
                        showNotification(
                            text: "⏱️ \(item.seatNumber)番席: \(timeStr)に再入力しました（チェック解除）",
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
            onCompleteCheck: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    timers[idx].isCheckCompleted = true
                    timers[idx].checkStaff = currentUserName
                    sessionManager.sendActionToPhone(action: "COMPLETE_CHECK", seatId: item.id)
                    showNotification(text: "✅ チェック完了を全員へ通知しました", color: Color(hex: "#30D158"))
                }
            },
            onCancelCheck: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    timers[idx].checkTargetEndTime = nil
                    timers[idx].checkTotalSeconds = nil
                    sessionManager.sendActionToPhone(action: "CANCEL_CHECK", seatId: item.id)
                    playHaptic(.click)
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
                    timers[idx].status = .shampoo
                    sessionManager.sendActionToPhone(action: "UPDATE_STATUS", seatId: item.id, extra: ["actionStatus": "shampoo", "isShampooing": true])
                    showNotification(
                        text: "📤 【\(item.seatNumber)番席】シャンプー開始を全員へ通知しました",
                        color: Color(hex: "#0A84FF")
                    )
                }
            },
            onFinishShampoo: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    timers[idx].status = .normal
                    sessionManager.sendActionToPhone(action: "UPDATE_STATUS", seatId: item.id, extra: ["actionStatus": "normal", "isShampooing": false])
                    showNotification(
                        text: "📤 【\(item.seatNumber)番席】シャンプー完了を全員へ通知しました",
                        color: Color(hex: "#30D158")
                    )
                }
            },
            onStartCombing: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    timers[idx].status = .combing
                    sessionManager.sendActionToPhone(action: "UPDATE_STATUS", seatId: item.id, extra: ["actionStatus": "combing", "isShampooing": false])
                    showNotification(
                        text: "📤 【\(item.seatNumber)番席】コーミング開始を全員へ通知しました",
                        color: Color(hex: "#0A84FF")
                    )
                }
            },
            onFinishCombing: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    timers[idx].status = .normal
                    sessionManager.sendActionToPhone(action: "UPDATE_STATUS", seatId: item.id, extra: ["actionStatus": "normal", "isShampooing": false])
                    showNotification(
                        text: "📤 【\(item.seatNumber)番席】コーミング完了を全員へ通知しました",
                        color: Color(hex: "#30D158")
                    )
                }
            },
            onStartCheck: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    timers[idx].status = .check
                    sessionManager.sendActionToPhone(action: "UPDATE_STATUS", seatId: item.id, extra: ["actionStatus": "check", "isShampooing": false])
                    showNotification(
                        text: "📤 【\(item.seatNumber)番席】チェック開始を全員へ通知しました",
                        color: Color(hex: "#30D158")
                    )
                }
            },
            onFinishCheck: {
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    timers[idx].status = .normal
                    sessionManager.sendActionToPhone(action: "UPDATE_STATUS", seatId: item.id, extra: ["actionStatus": "normal", "isShampooing": false])
                    showNotification(
                        text: "📤 【\(item.seatNumber)番席】チェック完了を全員へ通知しました",
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
                    let oldStaff = timers[idx].shampooStaff ?? "担当者"
                    timers[idx].shampooStaff = nil
                    timers[idx].status = .normal
                    sessionManager.sendActionToPhone(action: "CLEAR_STAFF", seatId: item.id)
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
            onAssignStaff: { process, staff in
                if let idx = timers.firstIndex(where: { $0.id == item.id }) {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                        timers[idx].helpProcess = process
                        timers[idx].shampooStaff = staff
                        timers[idx].isRecruiting = false
                    }
                    sessionManager.sendActionToPhone(action: "ASSIGN_HELP", seatId: item.id, extra: ["helpProcess": process, "assistantStaffName": staff])
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
                        timers[idx].isRecruiting = true
                    }
                    sessionManager.sendActionToPhone(action: "RECRUIT_HELP", seatId: item.id, extra: ["helpProcess": process])
                    // 募集するの場合は全員に通知する！
                    showNotification(
                        text: "📢 【\(item.seatNumber)番席】\(process)担当を全員に募集通知しました！",
                        color: Color(hex: "#FF9F0A")
                    )
                }
            }
        )
    }
    
    private func checkUnassignedHelpAlerts() {
        for idx in timers.indices {
            let rem = timers[idx].remainingSeconds
            if timers[idx].isRunning && rem <= 180 && rem > 0 && timers[idx].shampooStaff == nil && !timers[idx].isNoHelpNeeded && !timers[idx].hasAlertedHelpUnassigned {
                timers[idx].hasAlertedHelpUnassigned = true
                showNotification(
                    text: "🚨 【\(timers[idx].seatNumber)番席】ヘルプ未定！全員へ通知しました",
                    color: Color(hex: "#FF453A")
                )
            }
        }
    }
    
    private func binding(for id: String) -> Binding<SeatTimerItem> {
        guard let index = timers.firstIndex(where: { $0.id == id }) else {
            fatalError("Timer not found")
        }
        return $timers[index]
    }
    
    private func playHaptic(_ type: WKHapticType) {
        WKInterfaceDevice.current().play(type)
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
            WKInterfaceDevice.current().play(.click)
        }) {
            HStack(spacing: 6) {
                // 左側: 席番号
                HStack(spacing: 3) {
                    Image(systemName: "applewatch")
                        .font(.system(size: 11, weight: .bold))
                    Text("\(item.seatNumber)番席")
                        .font(.system(size: 13, weight: .heavy))
                }
                .foregroundColor(.white)
                
                // 終了バッジ
                HStack(spacing: 3) {
                    Image(systemName: "stop.circle.fill")
                        .font(.system(size: 8))
                    Text("計測終了")
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
                Text("\(item.seatNumber)番席")
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
                    
                    if !item.isRunning {
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
        if let staff = item.shampooStaff {
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
            Button(action: onOpenCheckAction) {
                HStack(alignment: .center) {
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
                    
                    Spacer()
                    
                    if let cStaff = item.checkStaff {
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
                    } else {
                        Button(action: onClaimCheck) {
                            Text("私がチェック")
                                .font(.system(size: 10, weight: .heavy))
                                .foregroundColor(.black)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 5)
                                .background(Color(hex: "#30D158"))
                                .cornerRadius(6)
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
            }
            .buttonStyle(.plain)
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
                HStack(alignment: .center, spacing: 6) {
                    HStack(spacing: 3) {
                        Image(systemName: "applewatch")
                            .font(.system(size: 11, weight: .bold))
                        Text("\(item.seatNumber)番席")
                            .font(.system(size: 13, weight: .heavy))
                    }
                    .foregroundColor(.white)
                    
                    Spacer()
                    
                    // 超過バッジ ＆ タイム
                    HStack(spacing: 4) {
                        Text("超過")
                            .font(.system(size: 10, weight: .heavy))
                            .foregroundColor(Color(hex: "#FF453A"))
                        Text(overtimeFormatted)
                            .font(.system(size: 16, weight: .black, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(Color(hex: "#FF453A"))
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2.5)
                    .background(Color(hex: "#FF453A").opacity(0.18))
                    .cornerRadius(6)
                }
                .padding(.horizontal, 4)
                .padding(.top, 2)
                
                Divider()
                    .background(Color.white.opacity(0.15))
                    .padding(.vertical, 1)
                
                // ② ボタン1: ヘルプ項目連動「シャンプー入る」ボタン
                Button(action: {
                    playHaptic(.start)
                    onEnterHelp()
                    dismiss()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: helpIconName)
                            .font(.system(size: 14, weight: .bold))
                        Text("\(helpProcessName)入る")
                            .font(.system(size: 14, weight: .heavy))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(
                        LinearGradient(
                            colors: [Color(hex: "#0A84FF"), Color(hex: "#0062D2")],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .foregroundColor(.white)
                    .cornerRadius(10)
                    .shadow(color: Color(hex: "#0A84FF").opacity(0.4), radius: 3, x: 0, y: 1)
                }
                .buttonStyle(.plain)
                
                // ③ ボタン2: 「タイムをリセット」ボタン（００００に変わる）
                Button(action: {
                    playHaptic(.directionUp)
                    onResetZero()
                    dismiss()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 13, weight: .bold))
                        Text("タイムをリセット")
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
                
                // ④ ボタン3: 「計測終了」ボタン（アコーディオンをしまう）
                Button(action: {
                    playHaptic(.stop)
                    onFinishMeasure()
                    dismiss()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 13, weight: .bold))
                        Text("計測終了")
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

// MARK: - タイム操作シート
struct TimeActionSheet: View {
    @Environment(\.dismiss) var dismiss
    let item: SeatTimerItem
    let initialReinputMode: Bool
    let onAdjust: (Int) -> Void
    let onStop: () -> Void
    let onReinputTime: (Int) -> Void
    
    // 累積追加秒数（何回もタップ可能！）
    @State private var accumulatedDelta: Int = 0
    
    // タイム再入力モードフラグ
    @State private var isReinputMode: Bool
    
    // ★ リューズ(Crown)無段階調整用
    @State private var crownSeconds: Double = 0.0
    @FocusState private var isCrownFocused: Bool
    
    // 1秒周期のカウントダウン更新
    @State private var now = Date()
    let ticker = Timer.publish(every: 1.0, on: .main, in: .common).autoconnect()
    
    let reinputMinutes = [5, 10, 15, 20, 25, 30, 35, 40, 45]
    
    init(
        item: SeatTimerItem,
        initialReinputMode: Bool = false,
        onAdjust: @escaping (Int) -> Void,
        onStop: @escaping () -> Void,
        onReinputTime: @escaping (Int) -> Void
    ) {
        self.item = item
        self.initialReinputMode = initialReinputMode
        self._isReinputMode = State(initialValue: initialReinputMode)
        self.onAdjust = onAdjust
        self.onStop = onStop
        self.onReinputTime = onReinputTime
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
                
                // ② ００:００の巨大デジタル表示エリア（Crownフォーカス対象・無段階調整）
                VStack(spacing: 1.5) {
                    Text(formatSeconds(Int(crownSeconds)))
                        .font(.system(size: 30, weight: .black, design: .monospaced))
                        .foregroundColor(Color(hex: "#FFD60A"))
                        .shadow(color: Color(hex: "#FFD60A").opacity(0.35), radius: 4, x: 0, y: 0)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 2)
                        .background(
                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color.white.opacity(0.08))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8)
                                        .stroke(Color(hex: "#FFD60A").opacity(0.6), lineWidth: 1.2)
                                )
                        )
                        .focusable()
                        .focused($isCrownFocused)
                        .digitalCrownRotation(
                            $crownSeconds,
                            from: 0.0,
                            through: 5400.0,
                            by: 1.0,
                            sensitivity: .medium,
                            isContinuous: false,
                            isHapticFeedbackEnabled: true
                        )
                    
                    HStack(spacing: 3) {
                        Image(systemName: "digitalcrown.horizontal.press.fill")
                            .font(.system(size: 8))
                        Text("Watchのリューズ(Crown)で無段階調整")
                            .font(.system(size: 8.5, weight: .medium))
                    }
                    .foregroundColor(Color(hex: "#C0C0C8"))
                }
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
                
                // ④ 決定ボタン（★時間が1秒以上設定された時だけスッと出現！）
                if Int(crownSeconds) > 0 {
                    Button(action: {
                        let sec = Int(crownSeconds)
                        if sec > 0 {
                            WKInterfaceDevice.current().play(.click)
                            onReinputTime(sec)
                            dismiss()
                        }
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
                            onReinputTime(min * 60)
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
        .onAppear {
            isCrownFocused = true
        }
    }
    
    // MARK: - 標準操作画面（タイマー稼働中の＋／−・停止・タイム再入力）
    @ViewBuilder
    private var standardActionScrollView: some View {
        ScrollView {
            VStack(spacing: 6) {
                // 通常操作モード
                HStack {
                    Text("\(item.seatNumber)番席のタイマー操作")
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
                
                // ② +1分, +3分, +5分（何回も押せる！dismissしない）
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
    let onCompleteCheck: () -> Void
    let onCancelCheck: () -> Void
    
    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Text("\(item.seatNumber)番席のチェックタイマー")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundColor(.white)
                
                if let staff = item.checkStaff {
                    Text("担当: \(staff)")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Color(hex: "#30D158"))
                }
                
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

// MARK: - 新規席追加シート
struct AddSeatSheet: View {
    @Environment(\.dismiss) var dismiss
    let currentUserName: String
    @State var seatNumber: Int
    @State private var selectedMinutes: Int = 15
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
            VStack(spacing: 8) {
                HStack {
                    Text("客席番号:")
                        .font(.system(size: 12, weight: .bold))
                    Spacer()
                    Stepper("\(seatNumber)番席", value: $seatNumber, in: 1...20)
                        .font(.system(size: 13, weight: .heavy))
                }
                .padding(.horizontal, 4)
                
                Divider()
                
                HStack(alignment: .firstTextBaseline) {
                    Text("全体タイム:")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.gray)
                    Spacer()
                    Text("\(selectedMinutes)分")
                        .font(.system(size: 20, weight: .black, design: .rounded))
                        .foregroundColor(Color(hex: "#64D2FF"))
                }
                .padding(.horizontal, 4)
                
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 5) {
                    ForEach(quickPills, id: \.self) { min in
                        Button(action: {
                            selectedMinutes = min
                        }) {
                            Text("\(min)分")
                                .font(.system(size: 12, weight: .bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 7)
                                .background(selectedMinutes == min ? Color(hex: "#0A84FF") : Color.white.opacity(0.12))
                                .foregroundColor(selectedMinutes == min ? .white : Color(hex: "#E0E0E5"))
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
                    let totalSec = selectedMinutes * 60
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
                    if checkMinutes > 0 {
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
                        .background(Color(hex: "#30D158"))
                        .foregroundColor(.black)
                        .cornerRadius(9)
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
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
                    Text("\(item.seatNumber)番席の\(item.helpProcess)操作")
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
    
    // サロン内のスタッフ候補リスト
    let staffCandidates = ["タグチ", "佐藤", "ヤマモト", "渡辺", "鈴木"]
    
    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if currentStep == 0 {
                    // ===== ステップ1: 工程を選択 =====
                    VStack(spacing: 2) {
                        Text("\(item.seatNumber)番席のヘルプ工程")
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
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
        }
    }
}

// MARK: - 客席サムネイル・バードビューシート（長押しで全席の稼働状況を一目俯瞰）
struct SeatThumbnailMapSheet: View {
    @Environment(\.dismiss) var dismiss
    let timers: [SeatTimerItem]
    let currentUserName: String
    let now: Date
    let onSelectSeat: (SeatTimerItem) -> Void
    
    // 席番号順（1番席、2番席、3番席...）に整列して物理レイアウトと連動
    var physicalSortedTimers: [SeatTimerItem] {
        timers.sorted { $0.seatNumber < $1.seatNumber }
    }
    
    // サマリー集計
    var runningCount: Int { timers.filter { $0.isRunning && $0.remainingSeconds > 0 }.count }
    var recruitingCount: Int { timers.filter { $0.isRecruiting }.count }
    var pausedCount: Int { timers.filter { !$0.isRunning }.count }
    
    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
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
                
                Divider()
                
                // ② 2列サムネイルグリッド
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
                    ForEach(physicalSortedTimers) { item in
                        Button(action: {
                            WKInterfaceDevice.current().play(.click)
                            onSelectSeat(item)
                            dismiss()
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
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 4)
        }
    }
}

// MARK: - サムネイル席カード
struct ThumbnailSeatCard: View {
    let item: SeatTimerItem
    let currentUserName: String
    let now: Date
    
    var isRunning: Bool { item.isRunning && item.remainingSeconds > 0 }
    var isOvertime: Bool { item.isOvertime }
    var isMe: Bool { item.isRelated(to: currentUserName) }
    
    // 背景＆枠線の色
    var borderColor: Color {
        if isOvertime {
            return Color(hex: "#FF453A")
        } else if item.isRecruiting {
            return Color(hex: "#FF9F0A")
        } else if item.shampooStaff == currentUserName || item.creatorName == currentUserName {
            return Color(hex: "#FFD60A")
        } else if isRunning {
            return Color(hex: "#0A84FF")
        } else {
            return Color.white.opacity(0.18)
        }
    }
    
    var backgroundColor: Color {
        if isOvertime {
            return Color(hex: "#FF453A").opacity(0.22)
        } else if item.isRecruiting {
            return Color(hex: "#FF9F0A").opacity(0.2)
        } else if item.shampooStaff == currentUserName || item.creatorName == currentUserName {
            return Color(hex: "#FFD60A").opacity(0.16)
        } else if isRunning {
            return Color(hex: "#0A84FF").opacity(0.18)
        } else {
            return Color.white.opacity(0.06)
        }
    }
    
    private func formatSeconds(_ seconds: Int) -> String {
        let m = max(0, seconds) / 60
        let s = max(0, seconds) % 60
        return String(format: "%02d:%02d", m, s)
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // 上段: 席番号 ＋ 状態インジケーターランプ
            HStack(spacing: 2) {
                Text("\(item.seatNumber)番")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
                
                Spacer(minLength: 4)
                
                if isOvertime {
                    Text("超過")
                        .font(.system(size: 8, weight: .heavy))
                        .foregroundColor(.white)
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(Color(hex: "#FF453A"))
                        .cornerRadius(3)
                } else if item.isRecruiting {
                    Image(systemName: "megaphone.fill")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(Color(hex: "#FF9F0A"))
                } else if isRunning {
                    Circle()
                        .fill(Color(hex: "#30D158"))
                        .frame(width: 7, height: 7)
                } else {
                    Text("停止")
                        .font(.system(size: 8, weight: .medium))
                        .foregroundColor(Color(hex: "#8E8E93"))
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(Color.white.opacity(0.12))
                        .cornerRadius(3)
                }
            }
            
            // 中段: 時間数字（稼働中は大きく、停止中は薄く）
            if isRunning {
                Text(formatSeconds(item.remainingSeconds))
                    .font(.system(size: 15, weight: .black, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(Color(hex: "#64D2FF"))
            } else if isOvertime {
                Text("+\(formatSeconds(abs(item.remainingSeconds)))")
                    .font(.system(size: 14, weight: .black, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(Color(hex: "#FF453A"))
            } else {
                Text("00:00")
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(Color(hex: "#636366"))
            }
            
            // 下段: 【作成者（主担当）】＆【ヘルプ担当】の2人表示
            VStack(alignment: .leading, spacing: 2) {
                // ① タイマー作成者（主担当スタイリスト）
                HStack(spacing: 2) {
                    Image(systemName: "pencil")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundColor(item.creatorName == currentUserName ? Color(hex: "#FFD60A") : Color(hex: "#8E8E93"))
                    Text("主:\(item.creatorName == currentUserName ? "あなた" : item.creatorName)")
                        .font(.system(size: 8.5, weight: item.creatorName == currentUserName ? .heavy : .bold))
                        .foregroundColor(item.creatorName == currentUserName ? Color(hex: "#FFD60A") : Color(hex: "#E5E5EA"))
                        .lineLimit(1)
                }
                
                // ② ヘルプ担当（アシスタント / 募集中）
                HStack(spacing: 2) {
                    if item.isRecruiting {
                        Image(systemName: "megaphone.fill")
                            .font(.system(size: 7))
                            .foregroundColor(Color(hex: "#FF9F0A"))
                        Text("助:募集中")
                            .font(.system(size: 8.5, weight: .heavy))
                            .foregroundColor(Color(hex: "#FFD60A"))
                            .lineLimit(1)
                    } else if let staff = item.shampooStaff {
                        Image(systemName: "hands.sparkles.fill")
                            .font(.system(size: 7))
                            .foregroundColor(staff == currentUserName ? Color(hex: "#FFD60A") : Color(hex: "#0A84FF"))
                        Text("助:\(staff == currentUserName ? "あなた" : staff)")
                            .font(.system(size: 8.5, weight: staff == currentUserName ? .heavy : .bold))
                            .foregroundColor(staff == currentUserName ? Color(hex: "#FFD60A") : Color(hex: "#64D2FF"))
                            .lineLimit(1)
                    } else if isRunning {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 7))
                            .foregroundColor(Color(hex: "#FF453A"))
                        Text("助:未定")
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundColor(Color(hex: "#FF453A"))
                    } else {
                        Text("助:待機中")
                            .font(.system(size: 8.5, weight: .medium))
                            .foregroundColor(Color(hex: "#8E8E93"))
                    }
                }
            }
            .padding(.top, 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 7)
        .padding(.vertical, 6)
        .background(backgroundColor)
        .cornerRadius(9)
        .overlay(
            RoundedRectangle(cornerRadius: 9)
                .stroke(borderColor, lineWidth: 1)
        )
    }
}

// MARK: - プレビュー
struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
