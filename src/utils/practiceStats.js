import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRecords } from './recordStorage';

const PRACTICE_STATS_KEY = 'ASSISTIMER_PRACTICE_STATS';

/**
 * 日付（ISO文字列）から YYYY-MM-DD 形式のローカル日付文字列を取得
 */
export const toLocalDateString = (isoString) => {
  if (!isoString) return '';
  const d = new Date(isoString);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * 最終練習日の相対表示（今日、昨日、○日前、M/D）を生成
 */
export const formatRelativeDate = (isoString) => {
  if (!isoString) return '未実施';
  const target = new Date(isoString);
  const now = new Date();

  // 年月日の比較（時間を00:00:00にリセット）
  const targetDateOnly = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const nowDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const diffTime = nowDateOnly.getTime() - targetDateOnly.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return '今日';
  if (diffDays === 1) return '昨日';
  if (diffDays >= 2 && diffDays <= 6) return `${diffDays}日前`;

  const m = target.getMonth() + 1;
  const d = target.getDate();
  return `${m}/${d}`;
};

/**
 * 特定ジャンル（または全体）の連続練習日数（Streak）を計算
 * @param {Array} records - レコード配列
 * @param {string} [category] - 対象ジャンル（省略時は全ジャンル）
 * @returns {number} 連続日数
 */
export const calculateStreakDays = (records, category = null) => {
  if (!records || records.length === 0) return 0;

  const filtered = category
    ? records.filter(r => (r.category || '未分類') === category)
    : records;

  if (filtered.length === 0) return 0;

  // 日付のユニークな配列（YYYY-MM-DD）を作成して降順ソート
  const uniqueDates = Array.from(
    new Set(filtered.map(r => toLocalDateString(r.date)).filter(Boolean))
  ).sort().reverse();

  if (uniqueDates.length === 0) return 0;

  const now = new Date();
  const todayStr = toLocalDateString(now.toISOString());
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = toLocalDateString(yesterday.toISOString());

  // 直近が今日か昨日でなければ連続は途切れている
  const latestDate = uniqueDates[0];
  if (latestDate !== todayStr && latestDate !== yesterdayStr) {
    return 0;
  }

  let streak = 0;
  let expectedDate = new Date(latestDate === todayStr ? now : yesterday);

  for (let i = 0; i < uniqueDates.length; i++) {
    const curExpectedStr = toLocalDateString(expectedDate.toISOString());
    if (uniqueDates[i] === curExpectedStr) {
      streak++;
      expectedDate.setDate(expectedDate.getDate() - 1);
    } else {
      break;
    }
  }

  return streak;
};

/**
 * 永続化された統計データを取得
 */
export const getStoredStats = async () => {
  try {
    const json = await AsyncStorage.getItem(PRACTICE_STATS_KEY);
    if (json) {
      return JSON.parse(json);
    }
  } catch (e) {
    console.error('Failed to get stored practice stats', e);
  }
  return {
    totalInterrupted: 0,
    genreInterrupted: {},
  };
};

/**
 * 途中終了（リセット中断）を1回記録
 * @param {string} [category] - 中断したジャンル名
 */
export const recordInterruption = async (category = null) => {
  try {
    const stats = await getStoredStats();
    stats.totalInterrupted = (stats.totalInterrupted || 0) + 1;

    if (category) {
      if (!stats.genreInterrupted) stats.genreInterrupted = {};
      stats.genreInterrupted[category] = (stats.genreInterrupted[category] || 0) + 1;
    }

    await AsyncStorage.setItem(PRACTICE_STATS_KEY, JSON.stringify(stats));
    return stats;
  } catch (e) {
    console.error('Failed to record practice interruption', e);
  }
};

/**
 * 保存済みレコードと中断統計を統合し、完全な集計データを生成
 */
export const getFullPracticeStats = async () => {
  try {
    const [records, storedStats] = await Promise.all([
      getRecords(),
      getStoredStats()
    ]);

    const totalCompleted = records.length;
    const totalInterrupted = storedStats.totalInterrupted || 0;

    let totalDuration = 0;
    let inTimeCount = 0;

    // ジャンル別集計マップ
    const genreMap = {};

    records.forEach(r => {
      const cat = r.category || '未分類';
      const dur = Number(r.duration) || 0;
      totalDuration += dur;

      // タイム内判定：明示フラグがある場合はそれを優先、ない場合は tags に「タイム」があるか判定
      const isInTime = r.isCompletedInTime !== undefined
        ? Boolean(r.isCompletedInTime)
        : (Array.isArray(r.tags) ? r.tags.includes('タイム') : true);

      if (isInTime) {
        inTimeCount++;
      }

      if (!genreMap[cat]) {
        genreMap[cat] = {
          category: cat,
          completed: 0,
          inTime: 0,
          totalDuration: 0,
          records: [],
          lastPracticedDate: null,
          interrupted: (storedStats.genreInterrupted && storedStats.genreInterrupted[cat]) || 0,
        };
      }

      genreMap[cat].completed++;
      if (isInTime) genreMap[cat].inTime++;
      genreMap[cat].totalDuration += dur;
      genreMap[cat].records.push(r);

      if (!genreMap[cat].lastPracticedDate || new Date(r.date) > new Date(genreMap[cat].lastPracticedDate)) {
        genreMap[cat].lastPracticedDate = r.date;
      }
    });

    // 各ジャンルの連続日数と最終表示を算出
    const genres = Object.values(genreMap).map(g => {
      const streak = calculateStreakDays(g.records, g.category);
      const inTimeRate = g.completed > 0 ? Math.round((g.inTime / g.completed) * 100) : 0;
      return {
        ...g,
        streakDays: streak,
        lastPracticedRelative: formatRelativeDate(g.lastPracticedDate),
        inTimeRate: inTimeRate,
      };
    });

    // 完了回数が多い順にソート
    genres.sort((a, b) => b.completed - a.completed);

    const overallInTimeRate = totalCompleted > 0
      ? Math.round((inTimeCount / totalCompleted) * 100)
      : 0;

    const overallStreak = calculateStreakDays(records);

    return {
      totalCompleted,
      totalInterrupted,
      totalPracticeCount: totalCompleted, // 全体の練習完了回数
      totalDuration,
      overallInTimeRate,
      overallStreak,
      genres,
      genreMap,
    };
  } catch (e) {
    console.error('Failed to get full practice stats', e);
    return {
      totalCompleted: 0,
      totalInterrupted: 0,
      totalPracticeCount: 0,
      totalDuration: 0,
      overallInTimeRate: 0,
      overallStreak: 0,
      genres: [],
      genreMap: {},
    };
  }
};
