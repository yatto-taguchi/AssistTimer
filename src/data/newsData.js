// AssistTimer - お知らせ（NEWS）データ定義および判定ヘルパー

export const NEWS_CATEGORIES = {
  all: { id: 'all', label: 'すべて', icon: 'list-outline', color: '#007AFF' },
  new_feature: { id: 'new_feature', label: '新機能・おすすめ', icon: 'sparkles', color: '#FF9500', days: 30 },
  layout: { id: 'layout', label: '配置・レイアウト変更', icon: 'color-palette-outline', color: '#5856D6', days: 30 },
  bug_fix: { id: 'bug_fix', label: 'バグの修正', icon: 'build-outline', color: '#34C759', days: 14 },
  other: { id: 'other', label: 'その他', icon: 'megaphone-outline', color: '#8E8E93', days: 30 },
};

/**
 * お知らせアイテム一覧（新しい順に定義）
 * 今後の改修時も、この配列の先頭に新しいオブジェクトを1件追加するだけでアプリ全体に自動反映されます。
 */
export const NEWS_ITEMS = [
  {
    id: 'news-20261001-01',
    date: '2026/10/01',
    category: 'new_feature',
    title: '📢 NEWS（お知らせ）機能を追加しました！',
    body: '画面左上のカラフルな吹き出しアイコンから、最新のアップデート情報や新機能、バグ修正内容をいつでもご確認いただけるようになりました。既読ボタンや「次の更新までアイコンを隠す」機能もご利用いただけます。',
  },
  {
    id: 'news-20260930-01',
    date: '2026/09/30',
    category: 'new_feature',
    title: '画面常時点灯 ＆ 画面消灯時のバックグラウンド音声再生に対応',
    body: 'タイマー計測中に画面がスリープ（自動消灯）しなくなり、練習に集中できるようになりました。また、電源ボタン等で画面を消灯した際でも、全16種の音声アナウンス・終了カウントダウン・アラームが実時間通りに鳴るバックグラウンド再生に対応しました。',
  },
  {
    id: 'news-20260927-01',
    date: '2026/09/27',
    category: 'new_feature',
    title: '応援キャラクター【やまいも】が走るアニメーションが登場！',
    body: 'タイマー計測中、画面下部の広告バナーの上を小刻みな足音で駆け抜けて応援してくれる「ランナー演出」が追加されました。練習の合間にクスッと笑ってリフレッシュできます。',
  },
  {
    id: 'news-20260926-02',
    date: '2026/09/26',
    category: 'new_feature',
    title: 'タイム終了後のカウントアップ・赤色インジケーター実装',
    body: '目標タイム終了後の超過時間カウントアップ中、12時の位置から3分で1周する鮮やかな赤いリングインジケーターが表示され、超過ペースをひと目で直感把握できるようになりました。',
  },
  {
    id: 'news-20260926-01',
    date: '2026/09/26',
    category: 'layout',
    title: '練習記録に「練習した日時（日付＋時刻）」を明示表示',
    body: '記録一覧画面や詳細モーダル、タイマー終了時の保存画面にて、日付だけでなく正確な練習時間（例: 2026/09/26 13:46）が記録・表示されるようになりました。',
  },
  {
    id: 'news-20260924-01',
    date: '2026/09/24',
    category: 'new_feature',
    title: '練習記録画面に「📸 写真アルバム」モードを新設',
    body: '練習記録一覧の上部で [📋 リスト] と [📸 写真アルバム] を切り替えられるようになりました。写真付きの作品だけをInstagram風の綺麗な2列グリッドで振り返ることができます。',
  },
  {
    id: 'news-20260923-01',
    date: '2026/09/23',
    category: 'layout',
    title: '記録一覧のジャンル絞り込み ＆ ★お気に入り優先ソート機能',
    body: '記録一覧の上部にジャンル別チップバーを新設し、特定の練習ジャンルやお気に入りの記録だけを素早く抽出・振り返りができるようになりました。',
  },
];

/**
 * 指定したお知らせが「アクティブ（有効期間内）」かどうかを判定する
 * @param {Object} item お知らせアイテム
 * @param {Date} [currentDate] 判定基準日（省略時は現在日時）
 * @returns {boolean} 有効期間内であれば true
 */
export function isNewsItemActive(item, currentDate = new Date()) {
  if (!item || !item.date) return false;
  
  // 日付文字列 'YYYY/MM/DD' を Date に変換
  const parts = item.date.split('/');
  if (parts.length !== 3) return true;
  
  const itemDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  const diffTime = currentDate.getTime() - itemDate.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  
  // カテゴリごとの許容日数（新機能: 30日、配置変更: 30日、バグ修正: 14日、その他: 30日）
  const categoryConfig = NEWS_CATEGORIES[item.category] || NEWS_CATEGORIES.other;
  const maxDays = categoryConfig.days || 30;
  
  // 過去の日付でなければ、日数差が許容以内かどうか
  return diffDays <= maxDays;
}

/**
 * お知らせ一覧を「アクティブ（期間内）」と「期限切れ（アーカイブ）」に分類する
 */
export function partitionNewsItems(items = NEWS_ITEMS, currentDate = new Date()) {
  const activeItems = [];
  const expiredItems = [];
  
  items.forEach(item => {
    if (isNewsItemActive(item, currentDate)) {
      activeItems.push(item);
    } else {
      expiredItems.push(item);
    }
  });
  
  return { activeItems, expiredItems };
}

/**
 * 未読のお知らせ数を計算する（アクティブ期間内のもののみ）
 */
export function getUnreadNewsCount(readIds = [], items = NEWS_ITEMS, currentDate = new Date()) {
  const { activeItems } = partitionNewsItems(items, currentDate);
  const readSet = new Set(readIds);
  return activeItems.filter(item => !readSet.has(item.id)).length;
}
