# Assist Timer — 開発体制・常設ルール (AGENTS.md)

サロン共有機能（複数スタッフ × iPhone × Apple Watch × Supabaseクラウド同期 × バックグラウンドPush通知 × アラーム制御）は状態遷移と境界条件が多岐にわたるため、本リポジトリにおける**すべての機能追加・仕様変更・バグ修正タスク**では、以下の**「4つの専門サブエージェントによる相互チェック＆ブラッシュアップ開発フロー」**を標準開発フローとして**常時自動適用（Always On）**する。

ユーザーが毎回細かく指示しなくても、新しいチャットや任意の作業環境（外出先Mac・自宅PC等）において、親エージェント（進行役）は自動的に本ルールおよびスキル `.agents/skills/salon-multi-agent-dev/SKILL.md` に従って4つの専門役割を動かしながら作業を進行すること。

---

## 1. 採用する「4エージェント相互チェック体制」の定義

修正・実装タスクを実行する際、親エージェントは以下の4つの専門サブエージェント（`define_subagent` / `invoke_subagent`）を用いて相互検証を行う。

### ① 現場フロー・UX批評担当 (`ux-flow-critic`)
- **使命**: 美容室のリアルな営業現場の視点から、仕様や操作フローの妥当性を批判的に検証する。
- **チェック観点**:
  - 「本当にこの仕様書の挙動で現場が迷わないか？」「カラー塗布中・シャンプー中で手首やスマホを見られない／触れられない状況で、気づけないケースはないか？」
  - 「スタイリスト（主担当 / 設定者）・アシスタント（ヘルプ／チェック担当）・無関係な他スタッフのそれぞれにとって、より自然で事故が起きない挙動はないか？」
  - 仕様書やイシューの要件そのものに改善の余地や矛盾があれば、実装前にブラッシュアップ案・確認事項を提示する。

### ② 仕様書＆整合性監査担当 (`spec-auditor`)
- **使命**: [`SPECIFICATION.md`](SPECIFICATION.md) および過去の GitHub Issues（#5〜#10 等）との整合性を厳密に監査する。
- **チェック観点**:
  - **3層間のロジック完全一致**:
    1. スマホ（[`src/screens/SalonWorkScreen.js`](src/screens/SalonWorkScreen.js) / [`src/utils/salonCloudService.js`](src/utils/salonCloudService.js) / [`src/screens/HomeScreen.js`](src/screens/HomeScreen.js)）
    2. Apple Watch（[`targets/watch/content.swift`](targets/watch/content.swift) / [`targets/watch/alarm.swift`](targets/watch/alarm.swift) / [`targets/watch/widget_sync.swift`](targets/watch/widget_sync.swift)）
    3. クラウド（[`supabase/functions/notify-salon-event/index.ts`](supabase/functions/notify-salon-event/index.ts)）
    上記3層で判定ロジック（関係者判定、停止保護、タイムスタンプ比較、ステータス遷移等）に食い違いがないか。
  - **デグレ（回帰バグ）防止**:
    過去に修正した重要機構（スリープ復帰、ローカル席ID→クラウドUUID昇格、自己エコー防止、Watch単体Supabase直接通信、スマートアラーム `WKExtendedRuntimeSession` 保護など）を壊していないか。
  - **仕様書同期**:
    変更内容が漏れなく [`SPECIFICATION.md`](SPECIFICATION.md) に反映されているか。

### ③ 実装担当 (`implementer`)
- **使命**: ①・②の検証を通過した確定仕様に基づき、iPhone / Apple Watch / Supabase / [`SPECIFICATION.md`](SPECIFICATION.md) の実装を正確に行う。
- **ルール**:
  - 推測で仕様を省略せず、3層すべての整合性を保って実装する。
  - ④（`qa-verifier`）からの差し戻し指摘があった場合は、表面的なパッチではなく根本原因から修正する。

### ④ 最終品質・意地悪テスト検証担当 (`qa-verifier`)
- **使命**: ③が実装したコード変更（`git diff`）を「意地悪なテスト視点（Adversarial QA）」で徹底的に検証し、問題があれば③（または②）へ差し戻す。
- **チェック観点**:
  - 「iPhoneがロック中／バックグラウンド中」
  - 「Watchが手首下げスリープ中（`.inactive` / `.background`）」
  - 「モーダルシート（`TimeActionSheet` 等）を開いている最中のリモート更新」
  - 「カウントダウン終了直前・超過（カウントアップ）中に別スタッフが操作」
  - 「他スタッフがシャンプーに移行した後、設定者が遅れて自分のアラームを止めた時（工程ステータス上書き消失の防止）」
  - 「同名スタッフやデフォルト名（`スタイリスト`）が存在する時」
  - 「通信瞬断後のクラウドポーリング（`reconcileCloudTimers` / `pollCloudTimersFromSupabaseIfNeeded`）復帰時や、確認バナー消去後の再ポーリング時」
  - 上記すべての境界条件でバグ（無限再通知ループ・鳴りっぱなし・無音・誤停止・ゾンビ復活・工程消失）が起きないかをコードトレースおよび構文検証（`node --check` / `swiftc -parse`）で証明する。
  - **全項目がクリアされるまで完了（コミット／ビルド／ユーザーへの完了報告）を承認しない。**

---

## 2. 標準実行ワークフロー（4ステップ進行手順）

コード修正・機能実装・イシュー対応を行う際は、必ず `.agents/skills/salon-multi-agent-dev/SKILL.md` を参照し、以下の順序で進行すること：

1. **Step 1: 実装前レビュー（① `ux-flow-critic` ＆ ② `spec-auditor`）**
   - イシューやユーザー要望、対象コード、[`SPECIFICATION.md`](SPECIFICATION.md) を確認し、現場UX視点の批評と3層整合性・デグレリスクの監査を実施する。
   - ユーザーから「先にプランを出して確認を取る」よう指示されている場合や仕様上の重大な疑問点がある場合は、①・②の分析結果をまとめた改善プラン・質問リストを提示して承認を得る。
2. **Step 2: 実装＆仕様書反映（③ `implementer`）**
   - Step 1 で確定した設計に基づき、スマホ・Apple Watch・クラウド・[`SPECIFICATION.md`](SPECIFICATION.md) を一貫して実装する。
3. **Step 3: 意地悪QA検証＆差し戻しループ（④ `qa-verifier`）**
   - 実装後の差分（`git diff`）に対して④ `qa-verifier` サブエージェントを起動し、上記の意地悪テスト観点と構文チェック（`node --check`、`swiftc -parse`）で徹底監査する。
   - **1件でもバグ・競合・仕様漏れが検出された場合は完了とせず、③へ差し戻して修正 ➜ 再検証をパスするまで繰り返す。**
4. **Step 4: 最終報告**
   - ①〜④の検証結果と修正内容、構文チェック結果をユーザーへ分かりやすく報告する。
