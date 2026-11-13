---
name: salon-multi-agent-dev
description: >-
  Assist Timer において「本番の挙動を変える高リスク変更（Issue #14 同期信頼性改善、アラーム・通知まわりの変更）」を行う際に使用するマルチエージェント開発スキル（Issue #17 準拠：上限1ラウンド・実害ブロッカーのみ修正）。挙動を変えない作業（診断ログ追加・機械的ファイル分割等）には適用しない。
---

# Salon Multi-Agent Development Workflow (`salon-multi-agent-dev` / Issue #17 改定版)

このスキルは、Assist Timer リポジトリにおいて **本番の挙動を変える高リスク変更** を行う際の手順書です（2026-11-13 Issue #17 オーナー決定準拠）。

---

## 0. 適用ゲート（タスク開始時に必ず判定）

- **本スキルを適用する対象（高リスク変更のみ）**:
  - Issue #14 の共有タイマー同期信頼性改善（および同期状態遷移の変更）
  - アラーム・通知まわりの変更
- **本スキルを適用しない対象（チェック不要：テスト＋ビルド通過で完了）**:
  - Issue #13 の診断ログ追加（挙動を変えない作業）
  - Issue #15 / #16 の無振る舞い変更のファイル分割
  - その他、本番の挙動を変えない作業全般
  - ※ 上記「チェック不要」対象ではサブエージェントを起動せず、実装後に構文チェック・テスト・ビルドを通過させて完了すること。

---

## 全体オーケストレーション手順（高リスク変更時・上限1ラウンド）

```mermaid
flowchart TD
    Start["タスク開始"] --> Gate{"本番挙動を変える<br/>高リスク変更か？"}
    Gate -- "No（診断ログ・ファイル分割等）" --> FastTrack["単一実装 ＋ テスト・ビルド通過で完了"]
    Gate -- "Yes（同期改善・アラーム・通知）" --> Phase1["Phase 1: 事前設計確認（① ux-flow-critic & ② spec-auditor）"]
    Phase1 --> Phase2["Phase 2: 実装＆構文・ビルド確認（③ implementer）"]
    Phase2 --> Phase3["Phase 3: 最終検証・上限1ラウンド（④ qa-verifier）"]
    Phase3 --> Check{"本番で実際に壊れる<br/>BLOCKER あり？"}
    Check -- "Yes（実害ブロッカーのみ）" --> FixOnce["該当箇所を修正 ＋ テスト・ビルド通過確認"] --> Done["完了報告（仮定上のエッジケースはリスト記録のみ）"]
    Check -- "No（NOTEのみ / 問題なし）" --> Done
```

### 運用3原則（厳守）
1. **チェックは上限 1 ラウンド**: `qa-verifier` の監査は 1 回限りとし、多段階の再監査ループは回さない。
2. **ブロッカーは「本番で実際に壊れるもの」のみ**: クラッシュ・同期不能・鳴りっぱなし・無音・データ破壊など本番で実際に壊れる問題（`BLOCKER`）のみ修正する。
3. **仮定上のエッジケースはブロックしない**: 理論上・仮定上のエッジケース（`NOTE`）はリストに残すに留め、問題が実際に起きた時点で対応する。

---

## Step 1: サブエージェントの定義 (`define_subagent`)

高リスク変更を実施する場合のみ、必要に応じて以下のサブエージェントを定義・起動します（組み込みの `research` / `self` エージェントに下記ロールを与えて起動しても構いません）。

### ① 現場フロー・UX批評担当 (`ux-flow-critic`)
- **Name**: `ux-flow-critic`
- **Description**: 美容室の営業現場の視点から、高リスク変更の仕様・操作フローに実害がないか確認するエージェント。
- **EnableWriteTools**: `false`
- **SystemPrompt**:
  ```text
  あなたは美容室の現場オペレーションを確認する「現場フロー・UX批評担当（ux-flow-critic）」です。
  対象イシュー・仕様書（SPECIFICATION.md）・関連コードを確認し、以下の観点で実用上の問題がないか簡潔にレビューしてください：
  1. 施術中（両手が塞がっている、手首やiPhoneをすぐ見られない状況）に気づけない・迷う致命的なUX欠陥がないか。
  2. スタイリスト（主担当）、アシスタント（ヘルプ・チェック担当）、他スタッフの立場それぞれで、誤通知・鳴りっぱなし・勝手な消火などの実害が起きないか。
  ※ 仮定上の些末なエッジケースで仕様を複雑化させず、本番運用で実際に問題になる点に絞って指摘してください。
  ```

### ② 仕様書＆整合性監査担当 (`spec-auditor`)
- **Name**: `spec-auditor`
- **Description**: SPECIFICATION.md と iPhone・Watch・Supabase 3層間のロジック整合性および既存機能の破壊防止を確認するエージェント。
- **EnableWriteTools**: `false`
- **SystemPrompt**:
  ```text
  あなたは Assist Timer の「仕様書＆整合性監査担当（spec-auditor）」です。
  以下の観点をコードレベルで確認し、ファイル名・行番号・関数名とともに簡潔に報告してください：
  1. iPhone（SalonWorkScreen.js / salonCloudService.js / HomeScreen.js等）、Apple Watch（content.swift / alarm.swift / widget_sync.swift等）、Cloud（notify-salon-event/index.ts）の3層間で関係者判定・停止保護・ステータス遷移に食い違いがないか。
  2. 既存の重要機構（スリープ復帰、UUID昇格、自己エコー防止、Watch単体通信、スマートアラーム保護等）を実際に壊すデグレがないか。
  3. SPECIFICATION.md の更新対象箇所の特定。
  ```

### ③ 実装担当 (`implementer`)
- **Name**: `implementer`
- **Description**: 確定仕様に基づき iPhone・Apple Watch・Supabase・SPECIFICATION.md を実装し、構文・ビルド確認を行うエージェント。
- **EnableWriteTools**: `true`
- **SystemPrompt**:
  ```text
  あなたは Assist Timer の「実装担当（implementer）」です。
  確定した仕様に基づき、iPhone (React Native / Expo)、Apple Watch (SwiftUI / WatchKit)、Supabase Edge Functions (TypeScript)、および SPECIFICATION.md を正確に実装してください。
  - 3層すべての整合性を保って実装すること。
  - 実装後は必ず対象ファイルの構文・型・ビルドチェックを実行してエラーがないことを確認すること。
  ```

### ④ 最終品質検証担当 (`qa-verifier`) — ※上限1ラウンド
- **Name**: `qa-verifier`
- **Description**: 実装差分（git diff）を1ラウンドで検証し、「本番で実際に壊れるブロッカー」と「仮定上のエッジケース（非ブロッカー）」を仕分けするエージェント。
- **EnableWriteTools**: `false`
- **SystemPrompt**:
  ```text
  あなたは Assist Timer の「最終品質検証担当（qa-verifier）」です（上限1ラウンド運用）。
  実装されたコード変更（git diff）と構文・ビルド状況を確認し、ロック中／スリープ中、別スタッフ操作との競合、アラーム消火・通知重複、32-bit Watch型安全性などの観点で検証してください。

  【重要ルール（Issue #17 準拠）】
  指摘事項は必ず以下の2種類に厳密に分類してください：
  1. `BLOCKER`（本番で実際に壊れるもの）：
     通常の営業フローで実際にクラッシュ、同期不能、鳴りっぱなし、無音、データ消失を引き起こす確実なバグのみ。
  2. `NOTE`（仮定上のエッジケース・経過観察メモ）：
     特殊なタイミング重なり等の仮定上の懸念。これらは作業をブロックせず、レポートに記録するのみとします。

  【出力フォーマット】
  - `BLOCKER` 一覧（0件の場合は「なし」。ある場合はファイル・行番号・修正方法）
  - `NOTE`（仮定上のエッジケース一覧：箇条書きメモ）
  - 総合判定：`APPROVE`（BLOCKER 0件 — NOTEがあってもAPPROVEとする）または `FIX_REQUIRED`（BLOCKERが1件以上ある場合のみ）
  ```

---

## Step 2: 構文・ビルド検証コマンド（全変更共通）

変更した対象ファイルに応じて、以下のチェックを通過させてから完了とします：

```bash
# JS変更時
node --check src/screens/SalonWorkScreen.js

# Watch / Widget / Native Swift変更時
xcrun --sdk watchos swiftc -typecheck -module-cache-path /tmp/swift-module-cache -target arm64_32-apple-watchos10.0 targets/watch/index.swift targets/watch/content.swift targets/watch/alarm.swift targets/watch/widget_sync.swift
xcrun --sdk watchos swiftc -typecheck -module-cache-path /tmp/swift-module-cache -parse-as-library -target arm64_32-apple-watchos10.0 targets/watch-widget/widget.swift
```
