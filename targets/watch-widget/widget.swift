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
private let savedAtEpochKey = "assisttimer.widget.savedAtEpoch"
private let lastTouchedKey = "assisttimer.widget.lastTouchedId"
private let lastTouchedAtEpochKey = "assisttimer.widget.lastTouchedAtEpoch"
private let widgetFetchedAtEpochKey = "assisttimer.widget.fetchedAtEpoch"
private let supabaseRestBaseURL = "https://hcmjcwcmvcwicjmnhtdc.supabase.co/rest/v1"
private let supabaseAnonKey = "sb_publishable_MWb3aHCk_XtQthwbw3be3g_bjObUVeq"

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
    let shouldAlertMain: Bool
    let shouldAlertCheck: Bool
    let totalSeconds: Int
    let isCountUpEnabled: Bool
    let creatorName: String?
    let isCreatorMeExplicit: Bool?
    let isNoHelpNeeded: Bool
    let currentUserName: String?
    let userAliases: [String]
    
    // チェック・ヘルプタイマー情報
    let prepEndDate: Date?
    let prepTotalSeconds: Int?
    let checkEndDate: Date?
    let checkTotalSeconds: Int?
    let checkProcess: String?
    let checkStaff: String?
    let shampooStaff: String?
    let helpProcess: String?
    let isRecruiting: Bool
    let isCheckCompleted: Bool

    static func isStaffMe(_ staff: String?, currentUserName: String?, userAliases: [String]) -> Bool {
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
        if let me = currentUserName?.trimmingCharacters(in: .whitespacesAndNewlines), !me.isEmpty, me != "スタイリスト" {
            if raw.caseInsensitiveCompare(me) == .orderedSame || normalize(me) == normRaw {
                return true
            }
        }
        for alias in userAliases {
            let cleanAlias = alias.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleanAlias.isEmpty, cleanAlias != "スタイリスト" else { continue }
            if raw.caseInsensitiveCompare(cleanAlias) == .orderedSame || normalize(cleanAlias) == normRaw {
                return true
            }
        }
        return false
    }

    /// 大元タイマーが 00:00 到達後の超過カウントアップ（endDate <= date）を文字盤モジュールに表示すべきか判定
    /// （Q1=A & Q3=A: 大元タイマーの当事者、または未完了のチェックタイマー当事者のときのみ true）
    var shouldDisplayOvertime: Bool {
        guard isCountUpEnabled else { return false }
        if shouldAlertMain { return true }
        if shouldAlertCheck && !isCheckCompleted && checkEndDate != nil { return true }
        return false
    }
    
    // 担当フロー（作成者 → 最終担当者）の表示情報
    var staffFlow: StaffFlowInfo {
        let creatorRaw = (creatorName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        
        // 作成者（左側）: 自分が作成したなら「自分」、他人ならその名前
        let isCreatorMe: Bool = {
            if let explicit = isCreatorMeExplicit {
                return explicit
            }
            if creatorRaw != "スタイリスト" && Self.isStaffMe(creatorRaw, currentUserName: currentUserName, userAliases: userAliases) {
                return true
            }
            return false
        }()
        let creatorDisplay = isCreatorMe ? "自分" : (creatorRaw.isEmpty ? "主担当" : creatorRaw)
        
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
            let isTargetMe = Self.isStaffMe(shampooRaw, currentUserName: currentUserName, userAliases: userAliases)
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
    var lastTouchedAtEpoch: Double = 0
    var userName: String? = nil
    var userAliases: [String] = []
    var cloudSalonId: String = ""
    var cloudUserId: String = ""
    var savedAtEpoch: Double = 0
}

enum ComplicationData {
    static func load() -> ComplicationSnapshot {
        guard let defaults = UserDefaults(suiteName: appGroup),
              let data = defaults.data(forKey: snapshotKey),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let seats = obj["seats"] as? [[String: Any]] else { return ComplicationSnapshot() }
        let now = Date()
        let currentUserName = obj["userName"] as? String
        var userAliases = (obj["userAliases"] as? [String])
            ?? defaults.stringArray(forKey: "assisttimer.watch.userAliases.v1")
            ?? []
        let cloudSalonId = ((obj["cloudSalonId"] as? String)
            ?? defaults.string(forKey: "assisttimer.watch.cloudSalonId.v1")
            ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let cloudUserId = ((obj["cloudUserId"] as? String)
            ?? defaults.string(forKey: "assisttimer.watch.cloudUserId.v1")
            ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !cloudUserId.isEmpty,
           let memberMap = defaults.dictionary(forKey: "assisttimer.watch.memberIdMap.v1") as? [String: String] {
            for (k, v) in memberMap where k.caseInsensitiveCompare(cloudUserId) == .orderedSame {
                let cleanV = v.trimmingCharacters(in: .whitespacesAndNewlines)
                if !cleanV.isEmpty, cleanV != "スタイリスト", !userAliases.contains(cleanV) {
                    userAliases.append(cleanV)
                }
            }
        }
        let savedAtEpoch = defaults.double(forKey: savedAtEpochKey)

        let parsed: [ComplicationSeat] = seats.compactMap { d in
            guard let end = (d["endEpoch"] as? NSNumber)?.doubleValue else { return nil }
            let num = (d["seatNumber"] as? NSNumber)?.intValue ?? 0
            let id = (d["id"] as? String) ?? ""
            let isMain = (d["isMainTimer"] as? NSNumber)?.boolValue ?? (d["isMainTimer"] as? Bool) ?? (id == "main-timer")
            let label = (d["seatLabel"] as? String) ?? (isMain ? "メインタイマー" : "\(num)番席")
            
            var prepEnd: Date? = nil
            if let prepEpoch = (d["prepEndEpoch"] as? NSNumber)?.doubleValue, prepEpoch > 0 {
                prepEnd = Date(timeIntervalSince1970: prepEpoch)
            }
            let prepTot = (d["prepTotalSeconds"] as? NSNumber)?.intValue
            var checkEnd: Date? = nil
            if let chkEpoch = (d["checkEndEpoch"] as? NSNumber)?.doubleValue, chkEpoch > 0 {
                checkEnd = Date(timeIntervalSince1970: chkEpoch)
            }
            let checkTot = (d["checkTotalSeconds"] as? NSNumber)?.intValue
            let checkProc = d["checkProcess"] as? String
            let checkStaff = d["checkStaff"] as? String
            let shampooStaff = d["shampooStaff"] as? String
            let helpProc = d["helpProcess"] as? String
            let isRecruiting = (d["isRecruiting"] as? NSNumber)?.boolValue ?? (d["isRecruiting"] as? Bool) ?? false
            let isCheckComp = (d["isCheckCompleted"] as? NSNumber)?.boolValue ?? (d["isCheckCompleted"] as? Bool) ?? false
            let creator = d["creatorName"] as? String
            let isCreatorMeExplicit = (d["isCreatorMe"] as? NSNumber)?.boolValue ?? (d["isCreatorMe"] as? Bool)
            let isNoHelp = (d["isNoHelpNeeded"] as? NSNumber)?.boolValue ?? (d["isNoHelpNeeded"] as? Bool) ?? false

            let defaultMainCountUp = (defaults.object(forKey: "assisttimer.watch.isCountUpEnabled") as? Bool) ?? true
            let isCountUpEnabled = (d["isCountUpEnabled"] as? NSNumber)?.boolValue
                ?? (d["isCountUpEnabled"] as? Bool)
                ?? (isMain ? defaultMainCountUp : true)
            let rawRunning = (d["isRunning"] as? NSNumber)?.boolValue ?? (d["isRunning"] as? Bool) ?? false
            let endDate = Date(timeIntervalSince1970: end)
            // ★ 終了時刻が未設定(<=0)または3時間(10800秒)以上経過した放置データは強制的に非稼働扱いとし、永遠のカウントアップ表示を防止
            let isValidRunning = rawRunning && end > 0 && endDate > now.addingTimeInterval(-10800)
            let relatedVal = (d["related"] as? NSNumber)?.boolValue ?? (d["related"] as? Bool) ?? false
            let shouldAlertMain = (d["shouldAlertMain"] as? NSNumber)?.boolValue ?? (d["shouldAlertMain"] as? Bool) ?? relatedVal
            let shouldAlertCheck = (d["shouldAlertCheck"] as? NSNumber)?.boolValue ?? (d["shouldAlertCheck"] as? Bool) ?? false
            
            return ComplicationSeat(
                id: id,
                seatNumber: num,
                seatLabel: label,
                isMainTimer: isMain,
                endDate: endDate,
                isRunning: isValidRunning,
                pausedRemaining: (d["pausedRemaining"] as? NSNumber)?.intValue ?? 0,
                related: relatedVal,
                shouldAlertMain: shouldAlertMain,
                shouldAlertCheck: shouldAlertCheck,
                totalSeconds: (d["totalSeconds"] as? NSNumber)?.intValue ?? (d["totalSeconds"] as? Int) ?? 600,
                isCountUpEnabled: isCountUpEnabled,
                creatorName: creator,
                isCreatorMeExplicit: isCreatorMeExplicit,
                isNoHelpNeeded: isNoHelp,
                currentUserName: currentUserName,
                userAliases: userAliases,
                prepEndDate: prepEnd,
                prepTotalSeconds: prepTot,
                checkEndDate: checkEnd,
                checkTotalSeconds: checkTot,
                checkProcess: checkProc,
                checkStaff: checkStaff,
                shampooStaff: shampooStaff,
                helpProcess: helpProc,
                isRecruiting: isRecruiting,
                isCheckCompleted: isCheckComp
            )
        }
        let loadedTouchedId = (obj["lastTouchedId"] as? String) ?? defaults.string(forKey: lastTouchedKey)
        let rawTouchedAt = (obj["lastTouchedAtEpoch"] as? NSNumber)?.doubleValue
            ?? (obj["lastTouchedAtEpoch"] as? Double)
            ?? defaults.double(forKey: lastTouchedAtEpochKey)
        let loadedTouchedAtEpoch = (loadedTouchedId != nil && rawTouchedAt.isFinite && rawTouchedAt > 0) ? rawTouchedAt : 0
        return ComplicationSnapshot(
            seats: parsed,
            lastTouchedId: loadedTouchedId,
            lastTouchedAtEpoch: loadedTouchedAtEpoch,
            userName: currentUserName,
            userAliases: userAliases,
            cloudSalonId: cloudSalonId,
            cloudUserId: cloudUserId,
            savedAtEpoch: savedAtEpoch
        )
    }

    /// WidgetExtension から直接 Supabase REST API を取得し、Watch 本体アプリが .background で起床遅延していても
    /// 文字盤（モジュラー）のタイムライン更新タイミングで最新の客席稼働状態を直接反映する
    static func fetchLatestFromSupabaseIfAvailable(
        baseSnapshot: ComplicationSnapshot,
        timeout: TimeInterval = 2.2,
        completion: @escaping (ComplicationSnapshot, Bool, String, Int, [String: String], String) -> Void
    ) {
        let fetchStartMs = WidgetSyncTrace.safeMillisInt64(Date().timeIntervalSince1970 * 1000.0)
        let salonId = baseSnapshot.cloudSalonId
        let now = Date()
        let nowEpoch = now.timeIntervalSince1970
        let lastWidgetFetchEpoch = UserDefaults(suiteName: appGroup)?.double(forKey: widgetFetchedAtEpochKey) ?? 0
        guard UUID(uuidString: salonId) != nil else {
            completion(baseSnapshot, false, "no_salon_id", 0, [:], "")
            return
        }
        // ★ HIGH-6: 直近1.2秒以内にWatch本体アプリがWidgetSyncを書き込んだばかり、または0.6秒以内にフェッチ済みの場合は通信をスキップし、
        //   didSkipByDebounce = true を返して getTimeline 側で 2.0秒後に必ず再評価（「開始→0.5秒後にヘルプ指名」の取りこぼしを根絶）
        let shouldDebounce = (nowEpoch - baseSnapshot.savedAtEpoch < 1.2) ||
            (nowEpoch - lastWidgetFetchEpoch < 0.6 && !baseSnapshot.seats.isEmpty)
        if shouldDebounce {
            completion(baseSnapshot, true, "debounced", 0, [:], "")
            return
        }

        var comps = URLComponents(string: "\(supabaseRestBaseURL)/salon_timers")
        comps?.queryItems = [
            URLQueryItem(name: "salon_id", value: "eq.\(salonId)"),
            URLQueryItem(name: "select", value: "id,seat_label,status,target_seconds,target_end_timestamp,paused_remaining_seconds,created_by,updated_by,color_staff_name,assistant_staff_name,help_process,is_shampooing,check_target_end_timestamp,check_total_seconds,check_process,check_staff_name,sort_order,updated_at"),
            URLQueryItem(name: "order", value: "updated_at.desc")
        ]
        guard let url = comps?.url else {
            completion(baseSnapshot, false, "invalid_url", 0, [:], "")
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = timeout
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        let lock = NSLock()
        var didComplete = false
        let finishOnce: (ComplicationSnapshot, Bool, String, [String: String], String) -> Void = { snap, skipped, outcome, cloudRevMap, cloudCompRev in
            lock.lock()
            if didComplete {
                lock.unlock()
                return
            }
            didComplete = true
            lock.unlock()
            let nowMs = WidgetSyncTrace.safeMillisInt64(Date().timeIntervalSince1970 * 1000.0)
            let elapsedMs = Int(max(0, nowMs - fetchStartMs))
            completion(snap, skipped, outcome, elapsedMs, cloudRevMap, cloudCompRev)
        }

        let task = URLSession.shared.dataTask(with: req) { data, response, error in
            if let error = error {
                let nsErr = error as NSError
                let reason = (nsErr.code == NSURLErrorTimedOut) ? "http_timeout" : "net_err_\(nsErr.code)"
                finishOnce(baseSnapshot, false, reason, [:], "")
                return
            }
            guard let http = response as? HTTPURLResponse else {
                finishOnce(baseSnapshot, false, "no_http_resp", [:], "")
                return
            }
            guard (200...299).contains(http.statusCode),
                  let data = data,
                  let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                finishOnce(baseSnapshot, false, "http_\(http.statusCode)", [:], "")
                return
            }

            let appDefaults = UserDefaults(suiteName: appGroup)
            let localStops = (appDefaults?.dictionary(forKey: "assisttimer.watch.localStops.v1") as? [String: [String: Double]]) ?? [:]
            let peerStoppedEnds = (appDefaults?.dictionary(forKey: "assisttimer.watch.peerStoppedSeatEnds.v1") as? [String: Double]) ?? [:]
            let confirmedPeerStops = (appDefaults?.dictionary(forKey: "assisttimer.watch.confirmedPeerStoppedEnds.v1") as? [String: Double]) ?? [:]
            let myUid = (!baseSnapshot.cloudUserId.isEmpty
                ? baseSnapshot.cloudUserId
                : (appDefaults?.string(forKey: "assisttimer.watch.cloudUserId.v1") ?? "")
            ).trimmingCharacters(in: .whitespacesAndNewlines)
            let myName = baseSnapshot.userName
            let myAliases = baseSnapshot.userAliases
            let isoFormatterFrac = ISO8601DateFormatter()
            isoFormatterFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let isoFormatterBasic = ISO8601DateFormatter()
            isoFormatterBasic.formatOptions = [.withInternetDateTime]
            let normalizeSeatMatchKey: (String) -> String = { s in
                let withoutSuffix = s.replacingOccurrences(of: "席", with: "")
                let noSpaces = String(String.UnicodeScalarView(withoutSuffix.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }))
                return noSpaces.lowercased()
            }

            // 1. 個人用メインタイマー（isMainTimer）はクラウドに存在しないため必ず先頭に保護維持
            let mainSeats: [ComplicationSeat] = baseSnapshot.seats.filter { $0.isMainTimer }
            var cloudSeats: [ComplicationSeat] = []

            // order=updated_at.desc で取得し、同一席ラベルの重複行を最新1件に絞った上で seatNumber 昇順にソートする
            var seenLabels = Set<String>()
            var touchedRelatedId: String? = nil
            var touchedOtherId: String? = nil
            var cloudRevBySeatId: [String: String] = [:]
            var cloudCompositeParts: [String] = []

            for (idx, row) in rows.enumerated() {
                guard let id = row["id"] as? String, !id.isEmpty else { continue }
                let rawLabel = ((row["seat_label"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let cleanKey = normalizeSeatMatchKey(rawLabel)
                if !cleanKey.isEmpty {
                    if seenLabels.contains(cleanKey) { continue }
                    seenLabels.insert(cleanKey)
                }

                let digits = cleanKey.filter { $0.isNumber }
                let sortOrderSeatNum = ((row["sort_order"] as? NSNumber)?.intValue ?? (row["sort_order"] as? Int)).map { $0 + 1 }
                let localMatchedByIdOrLabel = baseSnapshot.seats.first(where: { seat in
                    guard !seat.isMainTimer else { return false }
                    if seat.id == id { return true }
                    let locClean = normalizeSeatMatchKey(seat.seatLabel)
                    return !cleanKey.isEmpty && locClean == cleanKey
                })
                let seatNum = Int(digits) ?? localMatchedByIdOrLabel?.seatNumber ?? sortOrderSeatNum ?? (idx + 1)
                let localMatch = localMatchedByIdOrLabel ?? baseSnapshot.seats.first(where: { !$0.isMainTimer && $0.seatNumber == seatNum })
                let seatLabel = rawLabel.isEmpty ? "\(seatNum)番席" : (rawLabel.hasSuffix("席") ? rawLabel : "\(rawLabel)席")
                let statusStr = (row["status"] as? String) ?? "paused"
                let endMs = (row["target_end_timestamp"] as? NSNumber)?.doubleValue ?? (row["target_end_timestamp"] as? Double) ?? 0
                let endEpoch = endMs > 1_000_000_000_000 ? (endMs / 1000.0).rounded() : endMs.rounded()
                var endDate = Date(timeIntervalSince1970: max(0, endEpoch))
                var isRunning = (statusStr == "running" && endEpoch > 0 && endDate > now.addingTimeInterval(-10800))

                let rowUpdatedAtEpoch: Double = {
                    guard let rawUpd = (row["updated_at"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !rawUpd.isEmpty else { return 0 }
                    if let d = isoFormatterFrac.date(from: rawUpd) ?? isoFormatterBasic.date(from: rawUpd) {
                        return d.timeIntervalSince1970
                    }
                    return 0
                }()

                // 2. デグレ防止ガード: Watch本体側で実際に停止操作が行われた席（assisttimer.watch.localStops.v1）のみをピンポイントで保護
                if isRunning {
                    let stopRecord = localStops[id] ?? (localMatch.flatMap { localStops[$0.id] }) ?? localStops["seat-\(seatNum)"]
                    let stoppedAtEpoch = stopRecord?["at"] ?? 0
                    let stoppedEndEpoch = stopRecord?["end"] ?? 0
                    let isSameStoppedEnd = (stoppedEndEpoch > 0 && abs(stoppedEndEpoch - endEpoch) <= 2.5 && nowEpoch - stoppedAtEpoch < 14400)
                    let isCloudRowOlderThanSeatStop = (stoppedAtEpoch > 0 && nowEpoch - stoppedAtEpoch < 8.0 && rowUpdatedAtEpoch > 0 && rowUpdatedAtEpoch + 0.5 < stoppedAtEpoch)
                    if isSameStoppedEnd || isCloudRowOlderThanSeatStop {
                        isRunning = false
                    }
                }

                let totalSec = max(0, min(86_400, (row["target_seconds"] as? NSNumber)?.intValue ?? 600))
                let pausedRem = max(0, min(86_400, (row["paused_remaining_seconds"] as? NSNumber)?.intValue ?? 0))
                let createdBy = ((row["created_by"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let updatedBy = ((row["updated_by"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let colorStaff = ((row["color_staff_name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let assistRaw = ((row["assistant_staff_name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let helpProc = ((row["help_process"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let checkStaff = ((row["check_staff_name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let checkProc = ((row["check_process"] as? String) ?? "チェック").trimmingCharacters(in: .whitespacesAndNewlines)
                let chkEndMs = (row["check_target_end_timestamp"] as? NSNumber)?.doubleValue ?? 0
                let chkEndEpoch = chkEndMs > 1_000_000_000_000 ? (chkEndMs / 1000.0).rounded() : chkEndMs.rounded()
                let chkTotalSec = (row["check_total_seconds"] as? NSNumber)?.intValue ?? 0
                let hasCloudUnfinishedCheck = chkEndEpoch > 0 && chkTotalSec > 0

                let isCreatorMe: Bool = {
                    if !myUid.isEmpty && !createdBy.isEmpty {
                        return createdBy.caseInsensitiveCompare(myUid) == .orderedSame
                    }
                    if !colorStaff.isEmpty && colorStaff != "スタイリスト" {
                        return ComplicationSeat.isStaffMe(colorStaff, currentUserName: myName, userAliases: myAliases)
                    }
                    return localMatch?.isCreatorMeExplicit ?? false
                }()
                let isNoHelp = (assistRaw == "ヘルプなし" || assistRaw.lowercased() == "none" || helpProc == "ヘルプなし")
                let isRecruiting = (assistRaw == "募集中")
                let shampooStaff: String? = (!isNoHelp && !isRecruiting && !assistRaw.isEmpty) ? assistRaw : nil
                let isAssistMe = (shampooStaff != nil) && ComplicationSeat.isStaffMe(shampooStaff, currentUserName: myName, userAliases: myAliases)
                let isCheckMeRaw = hasCloudUnfinishedCheck && ComplicationSeat.isStaffMe(checkStaff, currentUserName: myName, userAliases: myAliases)
                let shouldAlertMain = isCreatorMe || isAssistMe
                let wouldAlertCheckIfRunning = hasCloudUnfinishedCheck && (isCreatorMe || isCheckMeRaw || (checkStaff == "募集中" && isCreatorMe))

                let cloudIsShampooing = (row["is_shampooing"] as? NSNumber)?.boolValue ?? (row["is_shampooing"] as? Bool) ?? false
                let hasActiveCustomHelpProc = !helpProc.isEmpty && helpProc != "シャンプー" && helpProc != "ヘルプなし" && helpProc.lowercased() != "none" && helpProc != "募集中" && helpProc != "未定"
                let hasActivePostStopProcess = cloudIsShampooing || hasActiveCustomHelpProc
                let hasOtherConcreteAssist = !assistRaw.isEmpty
                    && assistRaw != "ヘルプなし"
                    && assistRaw.lowercased() != "none"
                    && assistRaw != "募集中"
                    && assistRaw != "未定"
                    && assistRaw != "スタイリスト"
                    && assistRaw != "スタッフ"
                    && !ComplicationSeat.isStaffMe(assistRaw, currentUserName: myName, userAliases: myAliases)

                // ★ CRITICAL-1: ローカルで超過継続中の席について、自機（iPhone/Watch）で止めた場合や確認済みピア停止、担当解除済みの場合は
                //   絶対に復活させず 00:00 に戻し、実際に「他スタッフが先に止めて自分はまだ未確認」の当事者席のみ超過継続を保護する
                if !isRunning, let loc = localMatch, loc.isRunning, loc.endDate <= now, loc.shouldDisplayOvertime {
                    let locEndEpoch = loc.endDate.timeIntervalSince1970
                    let stopRecord = localStops[id] ?? localStops[loc.id] ?? localStops["seat-\(seatNum)"]
                    let stoppedAtEpoch = stopRecord?["at"] ?? 0
                    let stoppedEndEpoch = stopRecord?["end"] ?? 0
                    let isLocallyStopped = (stoppedEndEpoch > 0 && abs(stoppedEndEpoch - locEndEpoch) <= 2.5 && nowEpoch - stoppedAtEpoch < 14400)
                        || (stoppedAtEpoch > 0 && nowEpoch - stoppedAtEpoch < 8.0)
                    let isStoppedByMe = !myUid.isEmpty && !updatedBy.isEmpty && updatedBy.caseInsensitiveCompare(myUid) == .orderedSame
                    let confirmedPeerEnd = confirmedPeerStops[id] ?? confirmedPeerStops[loc.id] ?? confirmedPeerStops["seat-\(seatNum)"] ?? 0
                    let isConfirmedPeerStop = confirmedPeerEnd > 0 && abs(confirmedPeerEnd - locEndEpoch) <= 2.5
                    let activePeerEnd = peerStoppedEnds[id] ?? peerStoppedEnds[loc.id] ?? peerStoppedEnds["seat-\(seatNum)"] ?? 0
                    let hasUnconfirmedPeerStop = activePeerEnd > 0 && abs(activePeerEnd - locEndEpoch) <= 2.5
                    // Watch本体の reconcileTimersFromDirectCloudRows と完全一致:
                    // - updated_by と myUid が両方ある場合は UUID 不一致で判定
                    // - updated_by が NULL/空 または myUid 未同期の場合は「停止後工程（シャンプー等）稼働中 かつ 自分以外の具体名担当者あり」の明示的証拠がある時のみ他者停止継続とし、
                    //   通常の自端末停止で3時間 +00:15 が文字盤に残るゾンビ復活を完全防止する
                    let isStoppedByOtherPeer: Bool = {
                        if !myUid.isEmpty && !updatedBy.isEmpty {
                            return updatedBy.caseInsensitiveCompare(myUid) != .orderedSame
                        }
                        return hasActivePostStopProcess && hasOtherConcreteAssist
                    }()
                    let isStillStakeholderOnCloud = shouldAlertMain || wouldAlertCheckIfRunning
                    if !isLocallyStopped && !isStoppedByMe && !isConfirmedPeerStop && (hasUnconfirmedPeerStop || isStoppedByOtherPeer) && isStillStakeholderOnCloud {
                        isRunning = true
                        endDate = loc.endDate
                    }
                }

                let hasActiveCheck = isRunning && hasCloudUnfinishedCheck
                let isCheckCompleted = !hasActiveCheck && chkTotalSec > 0
                let isCheckMe = hasActiveCheck && isCheckMeRaw
                // ★ HIGH-7: Watch 本体の SeatTimerItem.shouldAlertCheckTimer と完全一致
                let shouldAlertCheck = hasActiveCheck && (isCreatorMe || isCheckMe || (checkStaff == "募集中" && isCreatorMe))
                let isRelated = shouldAlertMain || (hasActiveCheck && isCheckMe)

                if isRunning {
                    let wasRunning = localMatch?.isRunning ?? false
                    let prevEnd = localMatch?.endDate.timeIntervalSince1970 ?? 0
                    let prevChkEnd = (!((localMatch?.isCheckCompleted) ?? false) ? (localMatch?.checkEndDate?.timeIntervalSince1970 ?? 0) : 0)
                    let curChkEnd = hasActiveCheck ? chkEndEpoch : 0
                    let prevRel = localMatch?.related ?? false
                    let prevAlertMain = localMatch?.shouldAlertMain ?? false
                    if !wasRunning
                        || abs(prevEnd - endDate.timeIntervalSince1970) >= 2.0
                        || (curChkEnd > 0 && abs(prevChkEnd - curChkEnd) >= 2.0)
                        || (!prevRel && isRelated)
                        || (!prevAlertMain && shouldAlertMain) {
                        if isRelated {
                            touchedRelatedId = id
                        } else {
                            touchedOtherId = id
                        }
                    }
                }

                let resolvedHelpProcForSeat = (!isRunning && pausedRem <= 0 && !hasActivePostStopProcess)
                    ? ""
                    : (cloudIsShampooing && helpProc.isEmpty ? "シャンプー" : helpProc)
                let resolvedShampooStaffForSeat = (!isRunning && pausedRem <= 0 && !hasActivePostStopProcess)
                    ? nil
                    : shampooStaff
                let rowCloudRev = WidgetSyncTrace.computeCloudRowStateRev(row, fallbackSeatNumber: seatNum)
                cloudRevBySeatId[id] = rowCloudRev
                let rowRevSeatKey = WidgetSyncTrace.normalizeSeatKey(seatNumber: seatNum, seatLabel: seatLabel)
                cloudCompositeParts.append("\(rowRevSeatKey):\(rowCloudRev)")

                let seatItem = ComplicationSeat(
                    id: id,
                    seatNumber: seatNum,
                    seatLabel: seatLabel,
                    isMainTimer: false,
                    endDate: endDate,
                    isRunning: isRunning,
                    pausedRemaining: pausedRem,
                    related: isRelated,
                    shouldAlertMain: shouldAlertMain,
                    shouldAlertCheck: shouldAlertCheck,
                    totalSeconds: totalSec,
                    isCountUpEnabled: localMatch?.isCountUpEnabled ?? true,
                    creatorName: colorStaff.isEmpty ? "スタイリスト" : colorStaff,
                    isCreatorMeExplicit: isCreatorMe,
                    isNoHelpNeeded: isNoHelp,
                    currentUserName: myName,
                    userAliases: myAliases,
                    prepEndDate: nil,
                    prepTotalSeconds: nil,
                    checkEndDate: hasActiveCheck ? Date(timeIntervalSince1970: chkEndEpoch) : nil,
                    checkTotalSeconds: hasActiveCheck ? chkTotalSec : nil,
                    checkProcess: checkProc.isEmpty ? "チェック" : checkProc,
                    checkStaff: checkStaff.isEmpty ? nil : checkStaff,
                    shampooStaff: resolvedShampooStaffForSeat,
                    helpProcess: resolvedHelpProcForSeat,
                    isRecruiting: isRecruiting,
                    isCheckCompleted: isCheckCompleted
                )
                cloudSeats.append(seatItem)
            }

            let cloudCompositeRev = cloudCompositeParts.isEmpty
                ? "empty000"
                : String(cloudCompositeParts.sorted().joined(separator: ",").prefix(200))

            cloudSeats.sort {
                if $0.seatNumber != $1.seatNumber {
                    return $0.seatNumber < $1.seatNumber
                }
                return $0.id < $1.id
            }
            let mergedSeats = mainSeats + cloudSeats

            var resolvedTouchedId = baseSnapshot.lastTouchedId
            var resolvedTouchedAtEpoch = baseSnapshot.lastTouchedAtEpoch
            let hasAnyRelatedRunning = mergedSeats.contains(where: { $0.isRunning && $0.related })
            if let rel = touchedRelatedId {
                resolvedTouchedId = rel
                resolvedTouchedAtEpoch = (nowEpoch * 1000.0).rounded() / 1000.0
            } else if !hasAnyRelatedRunning, let other = touchedOtherId {
                resolvedTouchedId = other
                resolvedTouchedAtEpoch = (nowEpoch * 1000.0).rounded() / 1000.0
            } else if let existingId = resolvedTouchedId {
                if let matchedActive = mergedSeats.first(where: { ($0.id == existingId || (!$0.isMainTimer && "seat-\($0.seatNumber)" == existingId)) && $0.isRunning }) {
                    if hasAnyRelatedRunning && !matchedActive.related {
                        resolvedTouchedId = nil
                        resolvedTouchedAtEpoch = 0
                    } else {
                        resolvedTouchedId = matchedActive.id
                    }
                } else {
                    resolvedTouchedId = nil
                    resolvedTouchedAtEpoch = 0
                }
            }

            let updatedSnapshot = ComplicationSnapshot(
                seats: mergedSeats,
                lastTouchedId: resolvedTouchedId,
                lastTouchedAtEpoch: resolvedTouchedId != nil ? resolvedTouchedAtEpoch : 0,
                userName: myName,
                userAliases: myAliases,
                cloudSalonId: salonId,
                cloudUserId: myUid,
                savedAtEpoch: baseSnapshot.savedAtEpoch
            )
            persistSnapshotToAppGroup(updatedSnapshot)
            finishOnce(updatedSnapshot, false, "http_ok_\(rows.count)", cloudRevBySeatId, cloudCompositeRev)
        }
        task.resume()

        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout) {
            finishOnce(baseSnapshot, false, "watchdog_timeout", [:], "")
        }
    }

    private static func safeFiniteEpoch(_ date: Date?) -> Double {
        guard let d = date else { return 0 }
        let raw = d.timeIntervalSince1970
        guard raw.isFinite, raw > 0, raw < 4_102_444_800 else { return 0 }
        return raw.rounded()
    }

    private static func persistSnapshotToAppGroup(_ snap: ComplicationSnapshot) {
        guard let defaults = UserDefaults(suiteName: appGroup) else { return }
        var serializedSeats: [[String: Any]] = []
        for s in snap.seats {
            let endEpoch = s.isRunning ? safeFiniteEpoch(s.endDate) : 0
            var d: [String: Any] = [
                "id": s.id,
                "seatNumber": s.seatNumber,
                "seatLabel": s.seatLabel,
                "isMainTimer": s.isMainTimer,
                "endEpoch": endEpoch,
                "isRunning": s.isRunning && endEpoch > 0,
                "pausedRemaining": max(0, min(86_400, s.pausedRemaining)),
                "related": s.related,
                "shouldAlertMain": s.shouldAlertMain,
                "shouldAlertCheck": s.shouldAlertCheck,
                "totalSeconds": max(0, min(86_400, s.totalSeconds)),
                "isCountUpEnabled": s.isCountUpEnabled,
                "isNoHelpNeeded": s.isNoHelpNeeded,
                "isRecruiting": s.isRecruiting,
                "isCheckCompleted": s.isCheckCompleted
            ]
            if let creator = s.creatorName {
                d["creatorName"] = creator
            }
            if let isCreatorMe = s.isCreatorMeExplicit {
                d["isCreatorMe"] = isCreatorMe
            }
            if let prepEnd = s.prepEndDate {
                let pEpoch = safeFiniteEpoch(prepEnd)
                if pEpoch > 0 {
                    d["prepEndEpoch"] = pEpoch
                    if let pTot = s.prepTotalSeconds, pTot > 0 {
                        d["prepTotalSeconds"] = max(1, min(3_600, pTot))
                    }
                }
            }
            if !s.isCheckCompleted, let chkEnd = s.checkEndDate {
                let cEpoch = safeFiniteEpoch(chkEnd)
                if cEpoch > 0 {
                    d["checkEndEpoch"] = cEpoch
                    if let cTot = s.checkTotalSeconds, cTot > 0 {
                        d["checkTotalSeconds"] = max(1, min(86_400, cTot))
                    }
                }
            }
            if let checkProc = s.checkProcess, !checkProc.isEmpty {
                d["checkProcess"] = checkProc
            }
            if let checkStaff = s.checkStaff, !checkStaff.isEmpty {
                d["checkStaff"] = checkStaff
            }
            if let shampoo = s.shampooStaff, !shampoo.isEmpty {
                d["shampooStaff"] = shampoo
            }
            if let helpProc = s.helpProcess, !helpProc.isEmpty {
                d["helpProcess"] = helpProc
            }
            serializedSeats.append(d)
        }
        var payload: [String: Any] = [
            "seats": serializedSeats,
            "userAliases": snap.userAliases,
            "cloudSalonId": snap.cloudSalonId,
            "cloudUserId": snap.cloudUserId
        ]
        if let uName = snap.userName {
            payload["userName"] = uName
        }
        if let touchedId = snap.lastTouchedId {
            payload["lastTouchedId"] = touchedId
            if snap.lastTouchedAtEpoch > 0 {
                payload["lastTouchedAtEpoch"] = snap.lastTouchedAtEpoch
            }
        }
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        if let touchedId = snap.lastTouchedId {
            defaults.set(touchedId, forKey: lastTouchedKey)
            if snap.lastTouchedAtEpoch > 0 {
                defaults.set(snap.lastTouchedAtEpoch, forKey: lastTouchedAtEpochKey)
            } else {
                defaults.removeObject(forKey: lastTouchedAtEpochKey)
            }
        } else {
            defaults.removeObject(forKey: lastTouchedKey)
            defaults.removeObject(forKey: lastTouchedAtEpochKey)
        }
        defaults.set(data, forKey: snapshotKey)
        defaults.set(Date().timeIntervalSince1970, forKey: widgetFetchedAtEpochKey)
    }

    static func isDisplayableRunning(_ seat: ComplicationSeat, at date: Date) -> Bool {
        guard seat.isRunning,
              seat.endDate.timeIntervalSince1970 > 0,
              seat.endDate > date.addingTimeInterval(-10800) else {
            return false
        }
        if seat.endDate > date {
            // カウントダウン中（残り時間あり）は表示可能
            return true
        }
        // ★ 超過カウントアップ中（endDate <= date）は、大元タイマーの当事者（shouldAlertMain && isCountUpEnabled）
        //   または未完了のチェックタイマー自体が稼働・超過対象（shouldAlertCheck && !isCheckCompleted && checkEndDate != nil）のときのみ表示し、
        //   チェック完了後（主担当・全体ヘルプでない）や無関係な他スタッフの席は文字盤モジュールに表示しない（00:00 稼働なしへ戻す）
        return seat.shouldDisplayOvertime
    }

    /// 席の実効終了時刻（自分の対象である未完了チェックタイマーが本タイマーより先に到来する場合はチェック終了時刻を優先）
    static func effectiveEndDate(for seat: ComplicationSeat) -> Date {
        if !seat.isCheckCompleted, seat.shouldAlertCheck, let chkEnd = seat.checkEndDate, chkEnd < seat.endDate {
            return chkEnd
        }
        return seat.endDate
    }

    /// 自分の当事者席で本タイマーまたは中間チェックタイマーが超過中かどうか
    static func isSeatOvertime(_ seat: ComplicationSeat, at date: Date) -> Bool {
        if seat.endDate <= date && seat.shouldDisplayOvertime {
            return true
        }
        if !seat.isCheckCompleted, seat.shouldAlertCheck, let chkEnd = seat.checkEndDate, chkEnd <= date {
            return true
        }
        return false
    }

    /// 自分の関係席で緊急状態（本タイマー/チェック超過中、または実効残り3分＝180秒以内）かどうか
    static func isUrgentRelatedSeat(_ seat: ComplicationSeat, at date: Date) -> Bool {
        guard seat.related else { return false }
        if isSeatOvertime(seat, at: date) {
            return true
        }
        return effectiveEndDate(for: seat).timeIntervalSince(date) <= 180.0
    }

    /// Q1確定仕様：「20秒プレビュー ＋ 緊急席オーバーライド」および優先順位
    /// - 直近20秒以内に開始・操作・指名された席（lastTouchedId）があれば20秒間プレビュー表示して手首でのセット確認を保証
    /// - ただし別席が超過中または残り3分以内の緊急状態にある場合は即座に緊急席を優先（緊急席オーバーライド）
    /// - 20秒経過後（またはプレビュー対象なし時）は：
    ///   ①自分の超過中席 ➔ ②自分のカウントダウン中席 ➔ ③（自分の稼働席が0件のときのみ）他スタッフのカウントダウン中席（各グループ内は effectiveEndDate が近い順）
    static func pick(from snapshot: ComplicationSnapshot, at date: Date) -> ComplicationSeat? {
        let running = snapshot.seats.filter { isDisplayableRunning($0, at: date) }
        guard !running.isEmpty else { return nil }
        let hasRelatedRunning = running.contains(where: { $0.related })
        let dateEpoch = date.timeIntervalSince1970
        let isWithinPreviewWindow = snapshot.lastTouchedAtEpoch > 0
            && dateEpoch >= (snapshot.lastTouchedAtEpoch - 1.0)
            && dateEpoch < (snapshot.lastTouchedAtEpoch + 20.0)

        if isWithinPreviewWindow,
           let id = snapshot.lastTouchedId,
           let touched = running.first(where: { $0.id == id || (!$0.isMainTimer && "seat-\($0.seatNumber)" == id) }),
           (touched.related || !hasRelatedRunning) {
            let hasOtherOvertime = running.contains { $0.id != touched.id && $0.related && isSeatOvertime($0, at: date) }
            let hasOtherUrgent = running.contains { $0.id != touched.id && isUrgentRelatedSeat($0, at: date) }
            if !hasOtherUrgent
                || isSeatOvertime(touched, at: date)
                || (isUrgentRelatedSeat(touched, at: date) && !hasOtherOvertime) {
                return touched
            }
        }

        let myOvertime = running.filter { $0.related && isSeatOvertime($0, at: date) }
        let myCountingDown = running.filter { $0.related && !isSeatOvertime($0, at: date) && $0.endDate > date }
        let otherCountingDown = hasRelatedRunning ? [] : running.filter { !$0.related && $0.endDate > date }
        let groups: [[ComplicationSeat]] = [
            myOvertime,
            myCountingDown,
            otherCountingDown
        ]
        for group in groups where !group.isEmpty {
            return group.min { effectiveEndDate(for: $0) < effectiveEndDate(for: $1) }
        }
        return nil
    }

    static func entry(at date: Date, snapshot: ComplicationSnapshot) -> ComplicationEntry {
        let activeCount = snapshot.seats.filter { isDisplayableRunning($0, at: date) }.count
        return ComplicationEntry(
            date: date,
            seat: pick(from: snapshot, at: date),
            runningCount: activeCount
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
                shouldAlertMain: true,
                shouldAlertCheck: false,
                totalSeconds: 15 * 60,
                isCountUpEnabled: true,
                creatorName: "スタイリスト",
                isCreatorMeExplicit: true,
                isNoHelpNeeded: false,
                currentUserName: "スタイリスト",
                userAliases: [],
                prepEndDate: nil,
                prepTotalSeconds: nil,
                checkEndDate: Date().addingTimeInterval(3 * 60),
                checkTotalSeconds: 5 * 60,
                checkProcess: "チェック",
                checkStaff: "田中",
                shampooStaff: "佐藤",
                helpProcess: "シャンプー",
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
        let baseSnapshot = ComplicationData.load()
        ComplicationData.fetchLatestFromSupabaseIfAvailable(baseSnapshot: baseSnapshot, timeout: 2.2) { snapshot, didSkipByDebounce, fetchOutcome, fetchMs, cloudRevBySeatId, cloudCompositeRev in
            let now = Date()
            let seats = snapshot.seats
            var entryDates = Set<Date>()
            entryDates.insert(now)
            if snapshot.lastTouchedAtEpoch > 0 {
                let previewEnd = Date(timeIntervalSince1970: snapshot.lastTouchedAtEpoch + 20.0)
                if previewEnd > now {
                    entryDates.insert(previewEnd)
                }
            }
            
            // 各席のキーポイント時刻にエントリーを入れて、色変化（青→黄→赤）・20秒プレビュー終了・緊急席切替・超過切り替えを自動で行う
            for seat in seats where seat.isRunning {
                let total = max(10, Double(seat.totalSeconds))
                let end = seat.endDate
                if let prepEnd = seat.prepEndDate, prepEnd > now {
                    entryDates.insert(prepEnd)
                }
                if end > now {
                    entryDates.insert(end)
                    if !seat.shouldDisplayOvertime {
                        entryDates.insert(end.addingTimeInterval(0.5))
                        entryDates.insert(end.addingTimeInterval(1.0))
                    }
                    if seat.related {
                        let tUrgent = end.addingTimeInterval(-180)
                        if tUrgent > now { entryDates.insert(tUrgent) }
                    }
                    // 残り30%（黄に切り替え）
                    let t30 = end.addingTimeInterval(-total * 0.30)
                    if t30 > now { entryDates.insert(t30) }
                    // 残り10%（赤に切り替え）
                    let t10 = end.addingTimeInterval(-total * 0.10)
                    if t10 > now { entryDates.insert(t10) }
                }
                if seat.shouldDisplayOvertime {
                    // 超過バー満タン（終了＋180秒）および3時間上限（終了＋10800秒）
                    let tOverMax = end.addingTimeInterval(180)
                    if tOverMax > now { entryDates.insert(tOverMax) }
                    let tAutoExpire = end.addingTimeInterval(10800)
                    if tAutoExpire > now { entryDates.insert(tAutoExpire) }
                }
                
                // ★ チェックタイマーのエントリー（終了時刻・緊急3分前・残り1分前で赤切り替え）
                if let checkEnd = seat.checkEndDate, !seat.isCheckCompleted {
                    if checkEnd > now {
                        entryDates.insert(checkEnd)
                        if seat.related && seat.shouldAlertCheck {
                            let checkUrgent = checkEnd.addingTimeInterval(-180)
                            if checkUrgent > now {
                                entryDates.insert(checkUrgent)
                            }
                        }
                        let checkRedTime = checkEnd.addingTimeInterval(-60)
                        if checkRedTime > now {
                            entryDates.insert(checkRedTime)
                        }
                    }
                }
            }
            
            let sortedDates = entryDates.sorted()
            let entries = sortedDates.prefix(40).map { ComplicationData.entry(at: $0, snapshot: snapshot) }
            // ★ HIGH-6: デバウンスによりフェッチをスキップした場合（タイマー開始直後の連続操作中）は 2.0秒後に再評価ポリシーを設定し、
            //   0.5秒後のヘルプ指名等の後続変更が最大60秒間取り残されるのを完全防止する。
            //   通常時は稼働席あり60秒後・待機時120秒後の再取得ポリシーを設定する。
            let hasAnyRunning = seats.contains(where: { ComplicationData.isDisplayableRunning($0, at: now) })
            let reloadInterval: TimeInterval = didSkipByDebounce ? 2.0 : (hasAnyRunning ? 60 : 120)
            let policyLabel = didSkipByDebounce ? "2s" : (hasAnyRunning ? "60s" : "120s")
            let pickedSeat = entries.first?.seat
            let compositeRev = WidgetSyncTrace.computeCompositeStateRev(seats)
            let stateRev: String = {
                if let picked = pickedSeat {
                    return WidgetSyncTrace.computeWidgetSeatStateRev(picked)
                }
                if fetchOutcome.hasPrefix("http_ok_") && !cloudCompositeRev.isEmpty {
                    return cloudCompositeRev
                }
                return compositeRev
            }()
            let seatRef: String = {
                guard let picked = pickedSeat else { return "idle" }
                return WidgetSyncTrace.formatSeatRef(seatNumber: picked.seatNumber, seatLabel: picked.seatLabel, id: picked.id)
            }()
            var traceMeta: [String: Any] = [
                "didSkipByDebounce": didSkipByDebounce,
                "reloadPolicy": policyLabel,
                "runningCount": entries.first?.runningCount ?? 0,
                "family": String(describing: context.family),
                "compositeRev": compositeRev
            ]
            if fetchOutcome.hasPrefix("http_ok_") {
                if !cloudCompositeRev.isEmpty {
                    traceMeta["cloudCompositeRev"] = cloudCompositeRev
                }
                if let picked = pickedSeat, let pickedCloudRev = cloudRevBySeatId[picked.id] {
                    traceMeta["pickedCloudRev"] = pickedCloudRev
                    traceMeta["cloudRev"] = pickedCloudRev
                } else if !cloudCompositeRev.isEmpty {
                    traceMeta["cloudRev"] = cloudCompositeRev
                }
            }
            WidgetSyncTrace.append(
                userId: snapshot.cloudUserId,
                seat: seatRef,
                act: "getTimeline",
                res: (fetchOutcome.hasPrefix("http_ok") || fetchOutcome == "debounced" || fetchOutcome == "no_salon_id") ? "ok" : "err",
                rsn: fetchOutcome,
                stateRev: stateRev,
                ms: fetchMs,
                meta: traceMeta
            )
            completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(reloadInterval))))
        }
    }
}

// MARK: - Views
struct ComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ComplicationEntry

    private var activeSeat: ComplicationSeat? {
        guard let seat = entry.seat,
              seat.isRunning,
              seat.endDate.timeIntervalSince1970 > 0,
              seat.endDate > entry.date.addingTimeInterval(-10800) else { return nil }
        if !seat.shouldDisplayOvertime && seat.endDate <= entry.date {
            return nil
        }
        return seat
    }

    private var isPreCountingDown: Bool {
        guard let seat = activeSeat, let prepEnd = seat.prepEndDate else { return false }
        return entry.date < prepEnd
    }

    private var isOver: Bool {
        guard let seat = activeSeat else { return false }
        if isPreCountingDown { return false }
        return seat.isCountUpEnabled && seat.endDate <= entry.date
    }

    private var timeColor: Color {
        if isPreCountingDown {
            return Color(red: 1.0, green: 0.84, blue: 0.04)
        }
        return isOver ? Color(red: 1.0, green: 0.27, blue: 0.23) : .white
    }

    private func timerText(for seat: ComplicationSeat) -> Text {
        if let prepEnd = seat.prepEndDate, entry.date < prepEnd {
            let start = min(entry.date, prepEnd)
            return Text(timerInterval: start...prepEnd, countsDown: true)
        }
        if !seat.isCountUpEnabled {
            let start = min(entry.date, seat.endDate)
            return Text(timerInterval: start...seat.endDate, countsDown: true)
        }
        return Text(seat.endDate, style: .timer)
    }

    var body: some View {
        Group {
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
        .widgetURL(URL(string: "assisttimer://open-map")!)
    }

    // モジュラー文字盤の大きい枠
    private var rectangular: some View {
        let hasActiveCheck: Bool = {
            guard let seat = activeSeat, seat.isRunning, !seat.isCheckCompleted, let checkEnd = seat.checkEndDate else {
                return false
            }
            // チェックタイマーも「タイマーを止める」が押されるまで超過カウントアップ表示を継続（最大3時間保護）
            return checkEnd.addingTimeInterval(10800) > entry.date
        }()
        
        return VStack(alignment: .leading, spacing: hasActiveCheck ? 1 : 3) {
            // ── 1行目: アイコン・席番号（またはメインタイマー）・自分バッジ・稼働中◯席（1列に集約） ──
            HStack(spacing: 3) {
                if let seat = activeSeat {
                    if seat.isMainTimer {
                        Image(systemName: "stopwatch.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(Color(red: 0.19, green: 0.82, blue: 0.35))
                        Text("メインタイマー")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(Color(red: 0.19, green: 0.82, blue: 0.35))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
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
                        .minimumScaleFactor(0.8)
                    Spacer(minLength: 2)
                    Text("稼働中0席")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            
            if let seat = activeSeat {
                // ── 2行目: タイム表示（チェックタイマー有無で動的自動サイズ最適化） ──
                let timeFontSize: CGFloat = hasActiveCheck ? 23 : 28
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(isPreCountingDown ? "準備" : (isOver ? "超過" : "残り"))
                        .font(.system(size: hasActiveCheck ? 11 : 12, weight: .bold))
                        .foregroundColor(timeColor)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                    timerText(for: seat)
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
                Text("00:00")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .lineLimit(1)
                Text("稼働中のタイマーなし")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(URL(string: "assisttimer://open-map")!)
        .containerBackground(for: .widget) { Color.clear }
    }

    @ViewBuilder
    private func progressBar(for seat: ComplicationSeat) -> some View {
        let total = max(10, seat.totalSeconds)
        let startDate = seat.endDate.addingTimeInterval(-Double(total))
        let isOvertime = seat.isCountUpEnabled && entry.date >= seat.endDate
        
        if let prepEnd = seat.prepEndDate, entry.date < prepEnd {
            let prepTotal = max(1, seat.prepTotalSeconds ?? 5)
            let prepStart = prepEnd.addingTimeInterval(-Double(prepTotal))
            ProgressView(
                timerInterval: prepStart...prepEnd,
                countsDown: true
            )
            .progressViewStyle(.linear)
            .tint(Color(red: 1.0, green: 0.84, blue: 0.04))
            .labelsHidden()
        } else if isOvertime {
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
                if isCheckOver {
                    Text("超過")
                        .font(.system(size: 8.5, weight: .heavy))
                        .foregroundColor(checkBarColor)
                        .lineLimit(1)
                        .fixedSize()
                }
                Text(checkEnd, style: .timer)
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(checkBarColor)
                    .lineLimit(1)
            }
            
            Spacer(minLength: 2)
            
            // 真ん中: チェックタイマーの工程名とチェック担当の名前（1行目の全体ヘルプ・シャンプー担当とは完全分離）
            let staffText: String = {
                let rawProc = (seat.checkProcess ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let proc = rawProc.isEmpty ? "チェック" : rawProc
                let rawCheckStaff = (seat.checkStaff ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if rawCheckStaff.isEmpty {
                    return "\(proc) 未定"
                } else if rawCheckStaff == "募集中" {
                    return "\(proc) 募集中"
                } else if ComplicationSeat.isStaffMe(rawCheckStaff, currentUserName: seat.currentUserName, userAliases: seat.userAliases) {
                    return "\(proc) 自分"
                } else {
                    return "\(proc) \(rawCheckStaff)"
                }
            }()
            Text(staffText)
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            
            Spacer(minLength: 2)
            
            // 右側: チェック用のめっちゃ細いインジケーター（オレンジ / 1分前で赤）
            if isCheckOver {
                ProgressView(
                    timerInterval: checkEnd...checkEnd.addingTimeInterval(180),
                    countsDown: false
                )
                .progressViewStyle(.linear)
                .tint(checkBarColor)
                .labelsHidden()
                .scaleEffect(y: 0.35)
                .frame(width: 36, height: 3)
                .clipped()
            } else {
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
    }

    private func compactSeatLabel(for seat: ComplicationSeat) -> String {
        if seat.isMainTimer { return "メイン" }
        let trimmed = seat.seatLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "\(seat.seatNumber)番" }
        if trimmed.hasSuffix("番席") {
            return String(trimmed.dropLast(1))
        }
        return trimmed
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                if let seat = activeSeat {
                    Text(compactSeatLabel(for: seat))
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(seat.isMainTimer ? Color(red: 0.19, green: 0.82, blue: 0.35) : nil)
                        .widgetAccentable(!seat.isMainTimer)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    timerText(for: seat)
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
            if let seat = activeSeat {
                Text("\(seat.isMainTimer ? "メインタイマー" : seat.seatLabel) \(isPreCountingDown ? "準備" : (isOver ? "超過" : "残り")) ") + timerText(for: seat)
            } else {
                Text("AssistTimer 00:00")
            }
        }
        .containerBackground(for: .widget) { Color.clear }
    }

    private var corner: some View {
        Image(systemName: "timer")
            .font(.system(size: 20, weight: .bold))
            .widgetAccentable()
            .widgetLabel {
                if let seat = activeSeat {
                    Text("\(compactSeatLabel(for: seat)) ") + timerText(for: seat)
                } else {
                    Text("00:00")
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

// MARK: - Issue #13: WidgetKit 軽量トレース追記ヘルパー（App Group 最大60件ローテーション・全時刻Int64）
private enum WidgetSyncTrace {
    private static let fileName = "sync_trace_widget.jsonl"
    private static let maxLines = 60
    private static let ioQueue = DispatchQueue(label: "com.assisttimer.widget.synctrace", qos: .utility)
    private static var localSeq: Int = 0

    static func safeMillisInt64(_ rawMs: Double) -> Int64 {
        guard rawMs.isFinite, rawMs > 0 else { return 0 }
        let ms = rawMs < 10_000_000_000 ? (rawMs * 1000.0) : rawMs
        let clamped = min(4_102_444_800_000.0, max(0.0, ms))
        return Int64(clamped.rounded())
    }

    static func fnv1a32HexUtf8(_ input: String) -> String {
        var hash: UInt32 = 0x811c9dc5
        for byte in input.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 0x01000193
        }
        return String(format: "%08x", hash)
    }

    static func normalizeStaffToken(_ raw: String?) -> String {
        guard let raw = raw, !raw.isEmpty else { return "" }
        let nfkc = raw.precomposedStringWithCompatibilityMapping
        let scalars = nfkc.unicodeScalars.filter { scalar in
            !CharacterSet.whitespacesAndNewlines.contains(scalar) && scalar.value != 0x3000 && scalar.value != 0xFEFF
        }
        return String(String.UnicodeScalarView(scalars)).lowercased()
    }

    static func maskStaff(_ raw: String?) -> String {
        let norm = normalizeStaffToken(raw)
        if norm.isEmpty { return "empty" }
        if norm == "未定" { return "unset" }
        if norm == "ヘルプなし" || norm == "none" { return "none" }
        if norm == "募集中" { return "recruit" }
        if norm == "スタイリスト" || norm == "スタッフ" { return "default_stylist" }
        let h = fnv1a32HexUtf8(norm)
        return "stf#" + String(h.prefix(4))
    }

    private static func isUuidLike(_ lower: String) -> Bool {
        let bytes = Array(lower.utf8)
        guard bytes.count >= 14, bytes[8] == 0x2d, bytes[13] == 0x2d else { return false }
        let isHex: (UInt8) -> Bool = { b in
            (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66)
        }
        for i in 0..<8 where !isHex(bytes[i]) { return false }
        for i in 9..<13 where !isHex(bytes[i]) { return false }
        return true
    }

    static func maskId(_ raw: String?, prefix: String = "") -> String {
        let s = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return "" }
        let lower = s.lowercased()
        if prefix == "u" || prefix == "s" {
            return "\(prefix)#\(String(lower.prefix(6)))"
        }
        if isUuidLike(lower) {
            let p = prefix.isEmpty ? "t" : prefix
            return "\(p)#\(String(lower.prefix(6)))"
        }
        return String(s.prefix(24))
    }

    static func normalizeSeatKey(seatNumber: Int, seatLabel: String?) -> String {
        var lbl = (seatLabel ?? "").precomposedStringWithCompatibilityMapping
        lbl = lbl.replacingOccurrences(of: "(サンプル)", with: "")
                 .replacingOccurrences(of: "（サンプル）", with: "")
        let scalars = lbl.unicodeScalars.filter { scalar in
            !CharacterSet.whitespacesAndNewlines.contains(scalar) && scalar.value != 0x3000 && scalar.value != 0xFEFF
        }
        lbl = String(String.UnicodeScalarView(scalars))
        if lbl.hasSuffix("席") {
            lbl = String(lbl.dropLast())
        }
        if lbl.hasSuffix("番") {
            let stem = String(lbl.dropLast())
            if !stem.isEmpty && stem.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }) {
                lbl = stem
            }
        }
        lbl = lbl.lowercased()
        if !lbl.isEmpty,
           lbl.first != "0",
           lbl.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }),
           let n = Int(lbl), n > 0 {
            return "s\(n)"
        }
        if !lbl.isEmpty {
            return lbl
        }
        if seatNumber > 0 {
            return "s\(seatNumber)"
        }
        return "s0"
    }

    static func formatSeatRef(seatNumber: Int, seatLabel: String?, id: String?) -> String {
        let key = normalizeSeatKey(seatNumber: seatNumber, seatLabel: seatLabel)
        let masked = maskId(id, prefix: "t")
        return masked.isEmpty ? key : "\(key)(\(masked))"
    }

    static func isCustomPostStopProcessLabel(_ rawProc: String?) -> Bool {
        let p = (rawProc ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return false }
        let lower = p.lowercased()
        return p != "シャンプー"
            && p != "ヘルプなし"
            && lower != "none"
            && p != "募集中"
            && p != "未定"
    }

    static func computeStateRevFromFields(
        seatNumber: Int,
        seatLabel: String?,
        isRunning: Bool,
        targetEndMs: Int64,
        pausedRemainingSeconds: Int = 0,
        hasActiveCheck: Bool,
        checkTargetEndMs: Int64,
        isPostStopProcessActive: Bool,
        assistToken: String?,
        checkToken: String?
    ) -> String {
        let seatKey = normalizeSeatKey(seatNumber: seatNumber, seatLabel: seatLabel)
        let runFlag = (isRunning && targetEndMs > 0) ? 1 : 0
        let pausedSec = (runFlag == 0) ? max(0, pausedRemainingSeconds) : 0
        let shampooFlag = (runFlag == 0 && pausedSec <= 0 && isPostStopProcessActive) ? 1 : 0
        let endBucket5s: Int64 = (runFlag == 1)
            ? Int64((Double(targetEndMs) / 5000.0).rounded(.toNearestOrAwayFromZero))
            : ((shampooFlag == 0 && pausedSec > 0) ? Int64(pausedSec) : 0)
        let chkFlag = (runFlag == 1 && hasActiveCheck && checkTargetEndMs > 0) ? 1 : 0
        let checkEndBucket5s: Int64 = (chkFlag == 1)
            ? Int64((Double(checkTargetEndMs) / 5000.0).rounded(.toNearestOrAwayFromZero))
            : 0
        let shouldKeepAssist = (runFlag == 1) || (shampooFlag == 1) || (pausedSec > 0)
        let assistMasked = shouldKeepAssist ? maskStaff(assistToken) : "empty"
        let checkMasked = (chkFlag == 1) ? maskStaff(checkToken) : "empty"
        let canonical = "\(seatKey)|\(runFlag)|\(endBucket5s)|\(chkFlag)|\(checkEndBucket5s)|\(shampooFlag)|\(assistMasked)|\(checkMasked)"
        return fnv1a32HexUtf8(canonical)
    }

    static func computeWidgetSeatStateRev(_ seat: ComplicationSeat) -> String {
        let endMs: Int64 = seat.isRunning
            ? safeMillisInt64(seat.endDate.timeIntervalSince1970 * 1000.0)
            : 0
        let runFlag = seat.isRunning && endMs > 0
        let pausedSec = !runFlag ? max(0, seat.pausedRemaining) : 0
        let checkTot = seat.checkTotalSeconds ?? 0
        let chkEndMs: Int64 = {
            guard runFlag, !seat.isCheckCompleted, checkTot > 0, let d = seat.checkEndDate else { return 0 }
            return safeMillisInt64(d.timeIntervalSince1970 * 1000.0)
        }()
        let hasCheck = runFlag && !seat.isCheckCompleted && checkTot > 0 && chkEndMs > 0
        let cleanHelpProc = (seat.helpProcess ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let isPostStopProcessActive = !runFlag && pausedSec <= 0
            && (cleanHelpProc == "シャンプー" || isCustomPostStopProcessLabel(cleanHelpProc))
        let assistToken: String = {
            if seat.isRecruiting { return "募集中" }
            if seat.isNoHelpNeeded { return "ヘルプなし" }
            return seat.shampooStaff ?? ""
        }()
        let checkToken = hasCheck ? (seat.checkStaff ?? "") : ""
        return computeStateRevFromFields(
            seatNumber: seat.seatNumber,
            seatLabel: seat.seatLabel,
            isRunning: runFlag,
            targetEndMs: endMs,
            pausedRemainingSeconds: pausedSec,
            hasActiveCheck: hasCheck,
            checkTargetEndMs: chkEndMs,
            isPostStopProcessActive: isPostStopProcessActive,
            assistToken: assistToken,
            checkToken: checkToken
        )
    }

    static func computeCloudRowStateRev(_ row: [String: Any], fallbackSeatNumber: Int = 0) -> String {
        let statusStr = (row["status"] as? String) ?? ""
        let rawEnd = (row["target_end_timestamp"] as? NSNumber)?.doubleValue
            ?? (row["target_end_timestamp"] as? Double)
            ?? 0
        let endMs = safeMillisInt64(rawEnd)
        let isRunning = (statusStr == "running" && endMs > 0)
        let rawShampoo = (row["is_shampooing"] as? NSNumber)?.boolValue
            ?? (row["is_shampooing"] as? Bool)
            ?? false
        let rawPausedSec = max(0, (row["paused_remaining_seconds"] as? NSNumber)?.intValue ?? (row["paused_remaining_seconds"] as? Int) ?? 0)
        let pausedSec: Int = (!isRunning && statusStr == "paused" && rawPausedSec > 0)
            ? rawPausedSec
            : 0
        let checkTot = (row["check_total_seconds"] as? NSNumber)?.intValue
            ?? (row["check_total_seconds"] as? Int)
            ?? 0
        let rawChkEnd = (row["check_target_end_timestamp"] as? NSNumber)?.doubleValue
            ?? (row["check_target_end_timestamp"] as? Double)
            ?? 0
        let chkEndMs = safeMillisInt64(rawChkEnd)
        let isCheckDone = (row["is_check_completed"] as? NSNumber)?.boolValue
            ?? (row["is_check_completed"] as? Bool)
            ?? false
        let hasCheck = isRunning && !isCheckDone && checkTot > 0 && chkEndMs > 0
        let rawHelpProc = (row["help_process"] as? String) ?? ""
        let isPostStopProcessActive = !isRunning && pausedSec <= 0
            && (rawShampoo || isCustomPostStopProcessLabel(rawHelpProc))
        let assistToken = (row["assistant_staff_name"] as? String) ?? ""
        let checkToken = hasCheck ? ((row["check_staff_name"] as? String) ?? "") : ""
        let seatLabel = (row["seat_label"] as? String) ?? ""
        return computeStateRevFromFields(
            seatNumber: fallbackSeatNumber,
            seatLabel: seatLabel,
            isRunning: isRunning,
            targetEndMs: endMs,
            pausedRemainingSeconds: pausedSec,
            hasActiveCheck: hasCheck,
            checkTargetEndMs: chkEndMs,
            isPostStopProcessActive: isPostStopProcessActive,
            assistToken: assistToken,
            checkToken: checkToken
        )
    }

    static func computeCompositeStateRev(_ seats: [ComplicationSeat]) -> String {
        let regular = seats.filter { !$0.isMainTimer }
        guard !regular.isEmpty else { return "empty000" }
        let parts = regular.map { s -> String in
            let key = normalizeSeatKey(seatNumber: s.seatNumber, seatLabel: s.seatLabel)
            return "\(key):\(computeWidgetSeatStateRev(s))"
        }.sorted()
        return String(parts.joined(separator: ",").prefix(200))
    }

    private static let forbiddenPiiKeys: Set<String> = [
        "comment", "memo", "note", "customerName", "body", "title", "expoPushToken", "expo_push_token"
    ]

    private static func sanitizeMetaValue(_ val: Any, key: String = "", depth: Int = 0) -> Any? {
        if val is NSNull { return nil }
        if let b = val as? Bool { return b }
        if let i = val as? Int { return i }
        if let i64 = val as? Int64 { return NSNumber(value: i64) }
        if let d = val as? Double { return d.isFinite ? NSNumber(value: d) : nil }
        if let f = val as? Float { return f.isFinite ? NSNumber(value: Double(f)) : nil }
        if let n = val as? NSNumber {
            if CFNumberIsFloatType(n) {
                let dv = n.doubleValue
                return dv.isFinite ? n : nil
            }
            return n
        }
        if let s = val as? String {
            let maxLen = key.lowercased().hasSuffix("rev") ? 200 : 96
            return s.count > maxLen ? String(s.prefix(maxLen)) + "…" : s
        }
        if depth >= 2 { return nil }
        if let arr = val as? [Any] {
            return arr.prefix(12).compactMap { sanitizeMetaValue($0, key: key, depth: depth + 1) }
        }
        if let dict = val as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, v) in dict.prefix(20) {
                if forbiddenPiiKeys.contains(k) { continue }
                if let cv = sanitizeMetaValue(v, key: k, depth: depth + 1) {
                    out[k] = cv
                }
            }
            return out
        }
        return nil
    }

    static func append(
        userId: String,
        seat: String,
        act: String,
        res: String,
        rsn: String,
        stateRev: String,
        ms: Int,
        meta: [String: Any]
    ) {
        let wallMs = safeMillisInt64(Date().timeIntervalSince1970 * 1000.0)
        let monoMs = Int64((ProcessInfo.processInfo.systemUptime * 1000.0).rounded())
        let devId = userId.isEmpty ? "wg" : maskId(userId, prefix: "u")
        let cleanMeta = (sanitizeMetaValue(meta, key: "meta", depth: 0) as? [String: Any]) ?? [:]
        ioQueue.async {
            localSeq += 1
            var entry: [String: Any] = [
                "seq": localSeq,
                "dev": devId,
                "layer": "watch_widget",
                "wallMs": NSNumber(value: wallMs),
                "monoMs": NSNumber(value: monoMs),
                "hop": "WG_TIMELINE",
                "ch": "widget_timeline",
                "seat": String(seat.prefix(32)),
                "act": act,
                "res": res,
                "rsn": rsn,
                "stateRev": String(stateRev.prefix(200)),
                "ms": ms,
                "appState": "extension"
            ]
            if !cleanMeta.isEmpty {
                entry["meta"] = cleanMeta
            }
            guard PropertyListSerialization.propertyList(entry, isValidFor: .binary),
                  JSONSerialization.isValidJSONObject(entry),
                  let lineData = try? JSONSerialization.data(withJSONObject: entry),
                  let lineStr = String(data: lineData, encoding: .utf8),
                  let fileUrl = FileManager.default
                      .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
                      .appendingPathComponent(fileName) else { return }

            var lines: [String] = []
            if let existingData = try? Data(contentsOf: fileUrl),
               let existingText = String(data: existingData, encoding: .utf8) {
                lines = existingText.split(separator: "\n").map(String.init)
            }
            lines.append(lineStr)
            if lines.count > maxLines {
                lines.removeFirst(lines.count - maxLines)
            }
            let outText = lines.joined(separator: "\n")
            try? outText.data(using: .utf8)?.write(to: fileUrl, options: .atomic)
        }
    }
}
