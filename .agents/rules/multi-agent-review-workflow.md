---
trigger: always_on
description: >-
  Assist Timer サロン共有・タイマー・アラーム改修における「4つの専門サブエージェント（現場UX批評・仕様整合性監査・実装・最終QA検証）相互チェック＆ブラッシュアップ開発フロー」の常設ルール。
---

# 4エージェント相互チェック＆ブラッシュアップ開発フロー (常時自動適用ルール)

本リポジトリ（Assist Timer）においてバグ修正・仕様変更・イシュー実装を行う際は、単一視点での実装による競合・逆流・通知漏れ・デグレを防ぐため、必ず以下の**4つの専門サブエージェントによる相互チェック体制**で作業を進めること。

詳細なサブエージェント定義（`define_subagent` / `invoke_subagent` プロンプトテンプレートおよび検証チェックリスト）は、スキル **[`.agents/skills/salon-multi-agent-dev/SKILL.md`](../skills/salon-multi-agent-dev/SKILL.md)** に定義されているため、タスク開始時に必ず該当スキルを参照して実行すること。

---

## 必須フロー（①現場UX批評 ➜ ②仕様整合性監査 ➜ ③実装 ➜ ④最終QA検証）

### 1. ① 現場フロー・UX批評担当 (`ux-flow-critic`)
- **役割**: 美容室の実際の営業現場（スタイリスト・アシスタント・他スタッフの動き、両手が塞がっている施術中、手首を見られない状況など）の視点から、仕様や操作フローの妥当性を批判的に検証する。
- **アクション**:
  - 実装前に「本当にこの挙動で現場が迷わないか？」「気づけないケースや誤操作が起きないか？」を検証し、改善点があればブラッシュアップ案を提示する。

### 2. ② 仕様書＆整合性監査担当 (`spec-auditor`)
- **役割**: [`SPECIFICATION.md`](../../SPECIFICATION.md) および過去の GitHub Issues（#5〜#10 等）との整合性を監査する。
- **アクション**:
  - スマホ（[`src/screens/SalonWorkScreen.js`](../../src/screens/SalonWorkScreen.js) / [`src/utils/salonCloudService.js`](../../src/utils/salonCloudService.js)）、Apple Watch（[`targets/watch/content.swift`](../../targets/watch/content.swift) / [`targets/watch/alarm.swift`](../../targets/watch/alarm.swift)）、クラウド（[`supabase/functions/notify-salon-event/index.ts`](../../supabase/functions/notify-salon-event/index.ts)）の3層間で判定ロジックに食い違いがないかを監査する。
  - 過去に修正した機能（スリープ復帰、UUID昇格、自己エコー防止、Watch直接クラウドポーリング、スマートアラーム保護等）へのデグレがないかを確認する。

### 3. ③ 実装担当 (`implementer`)
- **役割**: ①・②の検証を通過した確定仕様に基づき、iPhone / Apple Watch / Supabase / [`SPECIFICATION.md`](../../SPECIFICATION.md) の実装を正確に行う。
- **アクション**:
  - 推測で仕様を省略せず実装し、④から差し戻し指摘を受けた場合は根本原因から修正する。

### 4. ④ 最終品質・意地悪テスト検証担当 (`qa-verifier`)
- **役割**: ③が実装したコード変更（`git diff`）を「意地悪なテスト視点」で徹底的に検証し、問題があれば③（または②）へ差し戻す。
- **アクション**:
  - 「iPhoneロック／バックグラウンド中」「Watch手首下げスリープ中」「モーダルシート展開中」「タイムアップ直前・超過中に別スタッフが操作」「他スタッフがシャンプー移行後に設定者が遅れてアラーム停止」「同名スタッフ存在時」「通信瞬断・ポーリング復帰時・確認バナー消去後の再ポーリング時」等の境界条件をコードトレースで検証する。
  - `node --check` および `swiftc -parse` による構文検証を実施する。
  - **全項目がクリア（PASS）されるまで、タスク完了・コミット・ビルドを承認しない。**
