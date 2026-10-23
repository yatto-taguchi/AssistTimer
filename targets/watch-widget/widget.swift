import SwiftUI
import WidgetKit

// MARK: - AssistTimer 文字盤コンプリケーション
// Watch アプリ（targets/watch/widget_sync.swift）が App Group に書いた席タイマーの要約を読み、1席を表示する。
// 優先順: ①最後にスタート・時間変更・新規作成した席（稼働中の場合）
//         ②自分が関わるカウントダウン中の席 → ③カウントダウン中の席
//         → ④自分が関わる超過中の席 → ⑤超過中の席（それぞれ終了が近い順）
//         超過かどうかは表示する時刻（タイムラインの各エントリーの時刻）で判定するため、
//         ある席が終わった瞬間に次のカウントダウン中の席へ自動で切り替わる。
// 残り時間は Text(date, style: .timer) でリアルタイムに進むため、毎秒の再読み込みは不要。

private let appGroup = "group.com.assisttimer"
private let snapshotKey = "assisttimer.widget.snapshot"

struct StaffFlowInfo {
    let creator: String
    let target: String
    let isRecruiting: Bool
}

struct ComplicationSeat {
    let id: String
    let seatNumber: Int
    let seatLabel: String
    let isMainTimer: Bool
    let endDate: Date
    let isRunning: Bool
    let pausedRemaining: Int
    let related: Bool
    let totalSeconds: Int
    let creatorName: String?
    let isNoHelpNeeded: Bool
    let currentUserName: String?
    
    // チェック・ヘルプタイマー情報
    let checkEndDate: Date?
    let checkTotalSeconds: Int?
    let checkStaff: String?
    let shampooStaff: String?
    let helpProcess: String?
    let isRecruiting: Bool
    let isCheckCompleted: Bool
    
    // 担当フロー（作成者 → 最終担当者）の表示情報
    var staffFlow: StaffFlowInfo {
        let me = (currentUserName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let creatorRaw = (creatorName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        
        // 作成者（左側）: 自分が作成したなら「自分」、他人ならその名前
        let isCreatorMe: Bool = {
            if !me.isEmpty && !creatorRaw.isEmpty {
                return creatorRaw.caseInsensitiveCompare(me) == .orderedSame
            }
            return related || creatorRaw.isEmpty
        }()
        let creatorDisplay = isCreatorMe ? "自分" : (creatorRaw.isEmpty ? "スタイリスト" : creatorRaw)
        
        // 最終担当（右側 / シャンプー・コーミング等）
        let shampooRaw = (shampooStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let targetDisplay: String
        let recruiting: Bool
        
        if isNoHelpNeeded {
            // ヘルプ不要（一人施術）: 作成者と同じ名前で統一表示（「自分 → 自分」または「佐藤 → 佐藤」）
            targetDisplay = creatorDisplay
            recruiting = false
        } else if !shampooRaw.isEmpty {
            // 最終担当決定済み
            let isTargetMe: Bool = {
                if !me.isEmpty {
                    return shampooRaw.caseInsensitiveCompare(me) == .orderedSame
                }
                return false
            }()
            targetDisplay = isTargetMe ? "自分" : shampooRaw
            recruiting = false
        } else {
            // 担当者未定（募集中）
            targetDisplay = "募集"
            recruiting = true
        }
        
        return StaffFlowInfo(creator: creatorDisplay, target: targetDisplay, isRecruiting: recruiting)
    }
}

struct ComplicationEntry: TimelineEntry {
    let date: Date
    /// 表示する席（nil = 稼働中のタイマーなし）
    let seat: ComplicationSeat?
    /// 稼働中の席数
    let runningCount: Int
}

// MARK: - データ読み込みと席の選択
struct ComplicationSnapshot {
    var seats: [ComplicationSeat] = []
    var lastTouchedId: String?
}

enum ComplicationData {
    static func load() -> ComplicationSnapshot {
        guard let defaults = UserDefaults(suiteName: appGroup),
              let data = defaults.data(forKey: snapshotKey),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let seats = obj["seats"] as? [[String: Any]] else { return ComplicationSnapshot() }
        let currentUserName = obj["userName"] as? String
        let parsed: [ComplicationSeat] = seats.compactMap { d in
            guard let end = (d["endEpoch"] as? NSNumber)?.doubleValue else { return nil }
            let num = (d["seatNumber"] as? NSNumber)?.intValue ?? 0
            let id = (d["id"] as? String) ?? ""
            let isMain = (d["isMainTimer"] as? NSNumber)?.boolValue ?? (d["isMainTimer"] as? Bool) ?? (id == "main-timer")
            let label = (d["seatLabel"] as? String) ?? (isMain ? "メインタイマー" : "\(num)番席")
            
            var checkEnd: Date? = nil
            if let chkEpoch = (d["checkEndEpoch"] as? NSNumber)?.doubleValue, chkEpoch > 0 {
                checkEnd = Date(timeIntervalSince1970: chkEpoch)
            }
            let checkTot = (d["checkTotalSeconds"] as? NSNumber)?.intValue
            let checkStaff = d["checkStaff"] as? String
            let shampooStaff = d["shampooStaff"] as? String
            let helpProc = d["helpProcess"] as? String
            let isRecruiting = (d["isRecruiting"] as? NSNumber)?.boolValue ?? (d["isRecruiting"] as? Bool) ?? false
            let isCheckComp = (d["isCheckCompleted"] as? NSNumber)?.boolValue ?? (d["isCheckCompleted"] as? Bool) ?? false
            let creator = d["creatorName"] as? String
            let isNoHelp = (d["isNoHelpNeeded"] as? NSNumber)?.boolValue ?? (d["isNoHelpNeeded"] as? Bool) ?? false
            
            return ComplicationSeat(
                id: id,
                seatNumber: num,
                seatLabel: label,
                isMainTimer: isMain,
                endDate: Date(timeIntervalSince1970: end),
                isRunning: (d["isRunning"] as? NSNumber)?.boolValue ?? false,
                pausedRemaining: (d["pausedRemaining"] as? NSNumber)?.intValue ?? 0,
                related: (d["related"] as? NSNumber)?.boolValue ?? false,
                totalSeconds: (d["totalSeconds"] as? NSNumber)?.intValue ?? (d["totalSeconds"] as? Int) ?? 600,
                creatorName: creator,
                isNoHelpNeeded: isNoHelp,
                currentUserName: currentUserName,
                checkEndDate: checkEnd,
                checkTotalSeconds: checkTot,
                checkStaff: checkStaff,
                shampooStaff: shampooStaff,
                helpProcess: helpProc,
                isRecruiting: isRecruiting,
                isCheckCompleted: isCheckComp
            )
        }
        return ComplicationSnapshot(seats: parsed, lastTouchedId: obj["lastTouchedId"] as? String)
    }

    /// ①最後に操作された稼働中の席。無ければ、date の時点で
    /// ②自分のカウントダウン中 → ③カウントダウン中 → ④自分の超過中 → ⑤超過中（それぞれ終了が近い順）
    /// ※ 以前は終了が一番近い席を選んでいたため、放置された超過席がずっと表示されていた
    static func pick(from snapshot: ComplicationSnapshot, at date: Date) -> ComplicationSeat? {
        let running = snapshot.seats.filter { $0.isRunning }
        if let id = snapshot.lastTouchedId, let touched = running.first(where: { $0.id == id }) {
            return touched
        }
        let countingDown = running.filter { $0.endDate > date }
        let overtime = running.filter { $0.endDate <= date }
        let groups: [[ComplicationSeat]] = [
            countingDown.filter { $0.related },
            countingDown,
            overtime.filter { $0.related },
            overtime
        ]
        for group in groups where !group.isEmpty {
            return group.min { $0.endDate < $1.endDate }
        }
        return nil
    }

    static func entry(at date: Date, snapshot: ComplicationSnapshot) -> ComplicationEntry {
        ComplicationEntry(
            date: date,
            seat: pick(from: snapshot, at: date),
            runningCount: snapshot.seats.filter { $0.isRunning }.count
        )
    }
}

// MARK: - Timeline
struct ComplicationProvider: TimelineProvider {
    func placeholder(in context: Context) -> ComplicationEntry {
        ComplicationEntry(
            date: Date(),
            seat: ComplicationSeat(
                id: "preview",
                seatNumber: 1,
                seatLabel: "1番席",
                isMainTimer: false,
                endDate: Date().addingTimeInterval(10 * 60),
                isRunning: true,
                pausedRemaining: 0,
                related: true,
                totalSeconds: 15 * 60,
                creatorName: "スタイリスト",
                isNoHelpNeeded: false,
                currentUserName: "スタイリスト",
                checkEndDate: Date().addingTimeInterval(3 * 60),
                checkTotalSeconds: 5 * 60,
                checkStaff: "田中",
                shampooStaff: "田中",
                helpProcess: "チェック",
                isRecruiting: false,
                isCheckCompleted: false
            ),
            runningCount: 1
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (ComplicationEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        completion(ComplicationData.entry(at: Date(), snapshot: ComplicationData.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ComplicationEntry>) -> Void) {
        let now = Date()
        let snapshot = ComplicationData.load()
        let seats = snapshot.seats
        var entryDates = Set<Date>()
        entryDates.insert(now)
        
        // 各席のキーポイント時刻にエントリーを入れて、色変化（青→黄→赤）および超過切り替えを自動で行う
        for seat in seats where seat.isRunning {
            let total = max(10, Double(seat.totalSeconds))
            let end = seat.endDate
            if end > now {
                entryDates.insert(end)
                // 残り30%（黄に切り替え）
                let t30 = end.addingTimeInterval(-total * 0.30)
                if t30 > now { entryDates.insert(t30) }
                // 残り10%（赤に切り替え）
                let t10 = end.addingTimeInterval(-total * 0.10)
                if t10 > now { entryDates.insert(t10) }
            }
            // 超過バー満タン（終了＋180秒）
            let tOverMax = end.addingTimeInterval(180)
            if tOverMax > now { entryDates.insert(tOverMax) }
            
            // ★ チェックタイマーのエントリー（終了時刻 ＆ 残り1分前で赤切り替え ＆ 終了1分後で自動消去切り替え）
            if let checkEnd = seat.checkEndDate, !seat.isCheckCompleted {
                if checkEnd > now {
                    entryDates.insert(checkEnd)
                    let checkRedTime = checkEnd.addingTimeInterval(-60)
                    if checkRedTime > now {
                        entryDates.insert(checkRedTime)
                    }
                }
                // チェック終了から60秒後にチェック行を非表示にして特大メインタイマーへ自動復帰するエントリー
                let checkAutoDismissTime = checkEnd.addingTimeInterval(60)
                if checkAutoDismissTime > now {
                    entryDates.insert(checkAutoDismissTime)
                }
            }
        }
        
        let sortedDates = entryDates.sorted()
        let entries = sortedDates.prefix(40).map { ComplicationData.entry(at: $0, snapshot: snapshot) }
        // 席の追加・変更時は Watch アプリ側から reloadAllTimelines() される
        completion(Timeline(entries: entries, policy: .never))
    }
}

// MARK: - Views
struct ComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ComplicationEntry

    private var isOver: Bool {
        guard let seat = entry.seat else { return false }
        return seat.endDate <= entry.date
    }

    private var timeColor: Color {
        isOver ? Color(red: 1.0, green: 0.27, blue: 0.23) : .white
    }

    var body: some View {
        switch family {
        case .accessoryCircular:
            circular
        case .accessoryInline:
            inline
        case .accessoryCorner:
            corner
        default:
            rectangular
        }
    }

    // モジュラー文字盤の大きい枠
    private var rectangular: some View {
        let hasActiveCheck: Bool = {
            guard let seat = entry.seat, seat.isRunning, !seat.isCheckCompleted, let checkEnd = seat.checkEndDate else {
                return false
            }
            // チェック終了時刻から60秒以上経過した後は自動的に非表示化し、メインタイマーの特大表示に戻す
            return checkEnd.addingTimeInterval(60) > entry.date
        }()
        
        return VStack(alignment: .leading, spacing: hasActiveCheck ? 1 : 3) {
            // ── 1行目: アイコン・席番号（またはメインタイマー）・自分バッジ・稼働中◯席（1列に集約） ──
            HStack(spacing: 3) {
                if let seat = entry.seat {
                    if seat.isMainTimer {
                        Image(systemName: "stopwatch.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(Color(red: 0.19, green: 0.82, blue: 0.35))
                        Text("メインタイマー")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(Color(red: 0.19, green: 0.82, blue: 0.35))
                            .lineLimit(1)
                    } else {
                        Image(systemName: "timer")
                            .font(.system(size: 11, weight: .bold))
                            .widgetAccentable()
                        Text(seat.seatLabel)
                            .font(.system(size: 13, weight: .bold))
                            .widgetAccentable()
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        
                        // ★ 担当フローバッジ（作成者 → 最終担当者）
                        let flow = seat.staffFlow
                        HStack(spacing: 2) {
                            Text(flow.creator)
                                .lineLimit(1)
                            Image(systemName: "arrow.right")
                                .font(.system(size: 6.5, weight: .bold))
                                .foregroundColor(flow.isRecruiting ? Color(red: 1.0, green: 0.62, blue: 0.04) : .secondary)
                            Text(flow.target)
                                .foregroundColor(flow.isRecruiting ? Color(red: 1.0, green: 0.62, blue: 0.04) : .primary)
                                .lineLimit(1)
                        }
                        .font(.system(size: 8.5, weight: .bold))
                        .padding(.horizontal, 3.5)
                        .padding(.vertical, 1.5)
                        .background(Capsule().fill(flow.isRecruiting ? Color.orange.opacity(0.2) : Color.white.opacity(0.18)))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    }
                    Spacer(minLength: 2)
                    Text(entry.runningCount > 1 ? "稼働中\(entry.runningCount)席" : "稼働中1席")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .fixedSize(horizontal: true, vertical: false)
                } else {
                    Image(systemName: "timer")
                        .font(.system(size: 11, weight: .bold))
                        .widgetAccentable()
                    Text("AssistTimer")
                        .font(.system(size: 13, weight: .bold))
                        .widgetAccentable()
                        .lineLimit(1)
                    Spacer(minLength: 2)
                    Text("稼働中0席")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            
            if let seat = entry.seat {
                // ── 2行目: タイム表示（チェックタイマー有無で動的自動サイズ最適化） ──
                let timeFontSize: CGFloat = hasActiveCheck ? 23 : 28
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(isOver ? "超過" : "残り")
                        .font(.system(size: hasActiveCheck ? 11 : 12, weight: .bold))
                        .foregroundColor(timeColor)
                    Text(seat.endDate, style: .timer)
                        .font(.system(size: timeFontSize, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundColor(timeColor)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                
                // ── 3行目: 横バーのインジケーター（不要ラベル非表示 ＆ 自動太さ調整 ＆ 色付き） ──
                progressBar(for: seat)
                    .scaleEffect(y: hasActiveCheck ? 0.6 : 0.85)
                    .frame(height: hasActiveCheck ? 3.5 : 5.5)
                    .clipped()
                
                // ── 4行目: チェック用タイマー行（チェックタイマー稼働中のみ一番下に小さく表示） ──
                if hasActiveCheck, let checkEnd = seat.checkEndDate {
                    checkTimerRow(seat: seat, checkEnd: checkEnd)
                }
            } else {
                Text("待機中")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                Text("稼働中のタイマーなし")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL({
            if let seat = entry.seat {
                return seat.isMainTimer ? URL(string: "assisttimer://main")! : URL(string: "assisttimer://seat?id=\(seat.id)")!
            } else {
                return URL(string: "assisttimer://open")!
            }
        }())
        .containerBackground(for: .widget) { Color.clear }
    }

    @ViewBuilder
    private func progressBar(for seat: ComplicationSeat) -> some View {
        let total = max(10, seat.totalSeconds)
        let startDate = seat.endDate.addingTimeInterval(-Double(total))
        let isOvertime = entry.date >= seat.endDate
        
        if isOvertime {
            // ★ カウントアップ・超過中: 3分（180秒）で左から右へ赤が伸びていく
            let overtimeMax: TimeInterval = 180
            ProgressView(
                timerInterval: seat.endDate...seat.endDate.addingTimeInterval(overtimeMax),
                countsDown: false
            )
            .progressViewStyle(.linear)
            .tint(Color(red: 1.0, green: 0.27, blue: 0.23))
            .labelsHidden()
        } else {
            // ★ カウントダウン中: 右から左へ消費される
            let remaining = seat.endDate.timeIntervalSince(entry.date)
            let ratio = max(0.0, min(1.0, remaining / Double(total)))
            
            let barColor: Color = {
                if ratio <= 0.1001 {
                    return Color(red: 1.0, green: 0.27, blue: 0.23) // 赤（残り10%以下）
                } else if ratio <= 0.3001 {
                    return Color(red: 1.0, green: 0.62, blue: 0.04) // 黄（残り30%以下）
                } else if seat.isMainTimer {
                    return Color(red: 0.19, green: 0.82, blue: 0.35) // メインタイマーは鮮やかなグリーン
                } else {
                    return Color(red: 0.04, green: 0.52, blue: 1.0)  // 席タイマーは鮮やかなブルー
                }
            }()
            
            ProgressView(
                timerInterval: startDate...seat.endDate,
                countsDown: true
            )
            .progressViewStyle(.linear)
            .tint(barColor)
            .labelsHidden()
        }
    }

    @ViewBuilder
    private func checkTimerRow(seat: ComplicationSeat, checkEnd: Date) -> some View {
        let now = entry.date
        let isCheckOver = now >= checkEnd
        let checkRemaining = checkEnd.timeIntervalSince(now)
        let isUnderOneMin = checkRemaining <= 60
        let checkTotal = max(10, Double(seat.checkTotalSeconds ?? 300))
        let checkStart = checkEnd.addingTimeInterval(-checkTotal)
        
        let checkBarColor: Color = (isUnderOneMin || isCheckOver)
            ? Color(red: 1.0, green: 0.27, blue: 0.23) // 残り1分切ったら赤
            : Color(red: 1.0, green: 0.58, blue: 0.0)  // 通常はオレンジ
            
        HStack(alignment: .center, spacing: 4) {
            // 左側: チェック用タイマーの時間
            HStack(spacing: 2) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(checkBarColor)
                Text(checkEnd, style: .timer)
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(checkBarColor)
                    .lineLimit(1)
            }
            
            Spacer(minLength: 2)
            
            // 真ん中: チェック/シャンプー/コーミング等の担当の名前
            let staffText: String = {
                let proc = seat.helpProcess ?? "チェック"
                let assignedStaff: String? = {
                    if proc == "チェック" {
                        if let c = seat.checkStaff, !c.isEmpty { return c }
                        if let s = seat.shampooStaff, !s.isEmpty { return s }
                        return nil
                    } else {
                        if let s = seat.shampooStaff, !s.isEmpty { return s }
                        if let c = seat.checkStaff, !c.isEmpty { return c }
                        return nil
                    }
                }()
                if let staff = assignedStaff, !staff.isEmpty {
                    return "\(proc) \(staff)"
                } else {
                    return "\(proc) 募集中"
                }
            }()
            Text(staffText)
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            
            Spacer(minLength: 2)
            
            // 右側: チェック用のめっちゃ細いインジケーター（オレンジ / 1分前で赤）
            ProgressView(
                timerInterval: checkStart...checkEnd,
                countsDown: true
            )
            .progressViewStyle(.linear)
            .tint(checkBarColor)
            .labelsHidden()
            .scaleEffect(y: 0.35)
            .frame(width: 36, height: 3)
            .clipped()
        }
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                if let seat = entry.seat {
                    Text(seat.isMainTimer ? "メイン" : "\(seat.seatNumber)番")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(seat.isMainTimer ? Color(red: 0.19, green: 0.82, blue: 0.35) : nil)
                        .widgetAccentable(!seat.isMainTimer)
                    Text(seat.endDate, style: .timer)
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundColor(timeColor)
                        .multilineTextAlignment(.center)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                } else {
                    Image(systemName: "timer")
                        .font(.system(size: 18, weight: .bold))
                        .widgetAccentable()
                }
            }
            .padding(4)
        }
        .containerBackground(for: .widget) { Color.clear }
    }

    private var inline: some View {
        Group {
            if let seat = entry.seat {
                Text("\(seat.isMainTimer ? "メインタイマー" : "\(seat.seatNumber)番席") \(isOver ? "超過" : "残り") \(seat.endDate, style: .timer)")
            } else {
                Text("AssistTimer 待機中")
            }
        }
        .containerBackground(for: .widget) { Color.clear }
    }

    private var corner: some View {
        Image(systemName: "timer")
            .font(.system(size: 20, weight: .bold))
            .widgetAccentable()
            .widgetLabel {
                if let seat = entry.seat {
                    Text("\(seat.isMainTimer ? "メイン" : "\(seat.seatNumber)番") \(seat.endDate, style: .timer)")
                } else {
                    Text("待機中")
                }
            }
        .containerBackground(for: .widget) { Color.clear }
    }
}

// MARK: - Widget
struct AssistTimerComplication: Widget {
    let kind = "AssistTimerComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ComplicationProvider()) { entry in
            ComplicationView(entry: entry)
        }
        .configurationDisplayName("AssistTimer")
        .description("最後に操作した席、またはカウントダウン中の席の残り時間を表示します。")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline, .accessoryCorner])
    }
}

@main
struct AssistTimerComplicationBundle: WidgetBundle {
    var body: some Widget {
        AssistTimerComplication()
    }
}
