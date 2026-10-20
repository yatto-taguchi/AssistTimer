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

struct ComplicationSeat {
    let id: String
    let seatNumber: Int
    let endDate: Date
    let isRunning: Bool
    let pausedRemaining: Int
    let related: Bool
    let totalSeconds: Int
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
        let parsed: [ComplicationSeat] = seats.compactMap { d in
            guard let num = (d["seatNumber"] as? NSNumber)?.intValue,
                  let end = (d["endEpoch"] as? NSNumber)?.doubleValue else { return nil }
            return ComplicationSeat(
                id: (d["id"] as? String) ?? "",
                seatNumber: num,
                endDate: Date(timeIntervalSince1970: end),
                isRunning: (d["isRunning"] as? NSNumber)?.boolValue ?? false,
                pausedRemaining: (d["pausedRemaining"] as? NSNumber)?.intValue ?? 0,
                related: (d["related"] as? NSNumber)?.boolValue ?? false,
                totalSeconds: (d["totalSeconds"] as? NSNumber)?.intValue ?? (d["totalSeconds"] as? Int) ?? 600
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
            seat: ComplicationSeat(id: "preview", seatNumber: 3, endDate: Date().addingTimeInterval(15 * 60), isRunning: true, pausedRemaining: 0, related: true, totalSeconds: 15 * 60),
            runningCount: 2
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
        VStack(alignment: .leading, spacing: 2) {
            // ── 1行目: アイコン・席番号・自分バッジ・稼働中◯席（1列に集約） ──
            HStack(spacing: 3) {
                Image(systemName: "timer")
                    .font(.system(size: 11, weight: .bold))
                    .widgetAccentable()
                if let seat = entry.seat {
                    Text("\(seat.seatNumber)番席")
                        .font(.system(size: 13, weight: .bold))
                        .widgetAccentable()
                        .lineLimit(1)
                    if seat.related {
                        Text("自分")
                            .font(.system(size: 9, weight: .bold))
                            .padding(.horizontal, 3)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.white.opacity(0.2)))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 2)
                    Text(entry.runningCount > 1 ? "稼働中\(entry.runningCount)席" : "稼働中1席")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                } else {
                    Text("AssistTimer")
                        .font(.system(size: 13, weight: .bold))
                        .widgetAccentable()
                        .lineLimit(1)
                    Spacer(minLength: 2)
                    Text("稼働中0席")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }
            if let seat = entry.seat {
                // ── 2行目: タイム表示 ──
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(isOver ? "超過" : "残り")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(timeColor)
                    Text(seat.endDate, style: .timer)
                        .font(.system(size: 21, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundColor(timeColor)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                
                // ── 3行目: 横バーのインジケーター（新設！） ──
                progressBar(for: seat)
            } else {
                Text("待機中")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                Text("稼働中のタイマーなし")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
        } else {
            // ★ カウントダウン中: 右から左へ消費される
            let remaining = seat.endDate.timeIntervalSince(entry.date)
            let ratio = max(0.0, min(1.0, remaining / Double(total)))
            
            let barColor: Color = {
                // 浮動小数点（Double）の丸め誤差を考慮し、0.0001の安全マージンを設ける
                if ratio <= 0.1001 {
                    return Color(red: 1.0, green: 0.27, blue: 0.23) // 赤（残り10%以下）
                } else if ratio <= 0.3001 {
                    return Color(red: 1.0, green: 0.62, blue: 0.04) // 黄（残り30%以下）
                } else {
                    return Color(red: 0.04, green: 0.52, blue: 1.0)  // 青（残り30%超）
                }
            }()
            
            ProgressView(
                timerInterval: startDate...seat.endDate,
                countsDown: true
            )
            .progressViewStyle(.linear)
            .tint(barColor)
        }
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                if let seat = entry.seat {
                    Text("\(seat.seatNumber)番")
                        .font(.system(size: 10, weight: .bold))
                        .widgetAccentable()
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
                Text("\(seat.seatNumber)番席 \(isOver ? "超過" : "残り") \(seat.endDate, style: .timer)")
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
                    Text("\(seat.seatNumber)番 \(seat.endDate, style: .timer)")
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
