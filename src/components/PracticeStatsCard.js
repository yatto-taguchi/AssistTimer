import React, { useState, useEffect, useContext } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { AppContext } from '../utils/AppContext';

// AndroidでLayoutAnimationを有効化
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const STORAGE_KEY_STATS_ACCORDION = '@records_stats_accordion_open';

export default function PracticeStatsCard({ stats }) {
  const { isEcoMode } = useContext(AppContext);
  const [isStatsExpanded, setIsStatsExpanded] = useState(false);
  const [isGenreAccordionExpanded, setIsGenreAccordionExpanded] = useState(false);

  // 前回の開閉状態を復元（デフォルトは折りたたみ）
  useEffect(() => {
    const loadAccordionState = async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY_STATS_ACCORDION);
        if (stored !== null) {
          setIsStatsExpanded(JSON.parse(stored));
        }
      } catch (e) {
        console.error('Failed to load stats accordion state', e);
      }
    };
    loadAccordionState();
  }, []);

  if (!stats) return null;

  // 親アコーディオン（練習時間を詳しく見る）の開閉トグル
  const toggleStatsAccordion = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const nextState = !isStatsExpanded;
    setIsStatsExpanded(nextState);
    AsyncStorage.setItem(STORAGE_KEY_STATS_ACCORDION, JSON.stringify(nextState)).catch(console.error);
  };

  // 子アコーディオン（ジャンル別内訳）の開閉トグル
  const toggleGenreAccordion = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsGenreAccordionExpanded(!isGenreAccordionExpanded);
  };

  // 秒数を「○h ○m」または「○分」にフォーマット
  const formatTotalTime = (totalSeconds) => {
    if (!totalSeconds || totalSeconds <= 0) return '0分';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}分`;
  };

  // カラーパレット（爽やかで優しい薄緑色テーマ）
  const cardBg = isEcoMode ? '#0D1C14' : '#F0FDF4';
  const cardBorder = isEcoMode ? '#1B4332' : '#BBF7D0';
  const labelColor = isEcoMode ? '#88AA99' : '#52796F';
  const mainTextColor = isEcoMode ? '#ECFDF5' : '#14532D';
  const subCardBg = isEcoMode ? '#14291E' : '#FFFFFF';
  const subCardBorder = isEcoMode ? '#1E3A2B' : '#DCFCE7';
  const timeBadgeBg = isEcoMode ? '#1C382B' : '#DCFCE7';
  const timeBadgeText = isEcoMode ? '#4ADE80' : '#15803D';
  const iconColor = isEcoMode ? '#4ADE80' : '#16A34A';

  const totalCompleted = stats.totalCompleted || 0;
  const inTimeRate = stats.overallInTimeRate || 0;
  const interruptedCount = stats.totalInterrupted || 0;
  const totalDurationStr = formatTotalTime(stats.totalDuration);
  const genres = stats.genres || [];

  return (
    <View style={[styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}>
      {/* カードヘッダー（タップで開閉） */}
      <TouchableOpacity
        style={styles.headerPressable}
        onPress={toggleStatsAccordion}
        activeOpacity={0.7}
      >
        <View style={styles.headerLeft}>
          <Ionicons 
            name="time-outline" 
            size={18} 
            color={iconColor} 
            style={{ marginRight: 7 }} 
          />
          <Text style={[styles.headerTitle, { color: mainTextColor }]}>
            練習時間を詳しく見る
          </Text>
        </View>

        <View style={styles.headerRight}>
          {/* 折りたたみ時: 総練習時間サマリーバッジ */}
          {!isStatsExpanded ? (
            <View style={[styles.timeSummaryBadge, { backgroundColor: timeBadgeBg }]}>
              <Ionicons 
                name="hourglass-outline" 
                size={11} 
                color={timeBadgeText} 
                style={{ marginRight: 3 }} 
              />
              <Text style={[styles.timeSummaryBadgeText, { color: timeBadgeText }]}>
                {totalDurationStr}
              </Text>
            </View>
          ) : (
            /* 展開時: 連続練習日数バッジ（継続中のみ表示） */
            stats.overallStreak > 0 && (
              <View style={[styles.streakBadge, { backgroundColor: isEcoMode ? '#2C1E14' : '#FFF3E0' }]}>
                <Text style={[styles.streakBadgeText, { color: '#FF9500' }]}>
                  🔥 {stats.overallStreak}日連続
                </Text>
              </View>
            )
          )}

          <Ionicons
            name={isStatsExpanded ? "chevron-up" : "chevron-down"}
            size={18}
            color={iconColor}
            style={{ marginLeft: 6 }}
          />
        </View>
      </TouchableOpacity>

      {/* 展開時コンテンツ */}
      {isStatsExpanded && (
        <View style={styles.expandedContent}>
          {/* 主要4指標グリッド */}
          <View style={styles.gridContainer}>
            {/* ① 総練習回数 */}
            <View style={[styles.gridItem, { backgroundColor: subCardBg, borderColor: subCardBorder }]}>
              <Text style={[styles.gridLabel, { color: labelColor }]}>総練習回数</Text>
              <View style={styles.gridValueRow}>
                <Text style={[styles.gridValue, { color: isEcoMode ? '#38BDF8' : '#007AFF' }]}>
                  {totalCompleted}
                </Text>
                <Text style={[styles.gridUnit, { color: isEcoMode ? '#888' : '#666' }]}>回</Text>
              </View>
            </View>

            {/* ② タイム達成率 */}
            <View style={[styles.gridItem, { backgroundColor: subCardBg, borderColor: subCardBorder }]}>
              <Text style={[styles.gridLabel, { color: labelColor }]}>タイム達成率</Text>
              <View style={styles.gridValueRow}>
                <Text style={[styles.gridValue, { color: '#34C759' }]}>
                  {totalCompleted > 0 ? `${inTimeRate}` : '-'}
                </Text>
                {totalCompleted > 0 && (
                  <Text style={[styles.gridUnit, { color: isEcoMode ? '#888' : '#666' }]}>%</Text>
                )}
              </View>
            </View>

            {/* ③ 途中終了（中断） */}
            <View style={[styles.gridItem, { backgroundColor: subCardBg, borderColor: subCardBorder }]}>
              <Text style={[styles.gridLabel, { color: labelColor }]}>途中で終了</Text>
              <View style={styles.gridValueRow}>
                <Text style={[styles.gridValue, { color: '#FF9500' }]}>
                  {interruptedCount}
                </Text>
                <Text style={[styles.gridUnit, { color: isEcoMode ? '#888' : '#666' }]}>回</Text>
              </View>
            </View>

            {/* ④ 総練習時間 */}
            <View style={[styles.gridItem, { backgroundColor: subCardBg, borderColor: subCardBorder }]}>
              <Text style={[styles.gridLabel, { color: labelColor }]}>総練習時間</Text>
              <View style={styles.gridValueRow}>
                <Text style={[styles.gridValueTime, { color: isEcoMode ? '#A78BFA' : '#5856D6' }]}>
                  {totalDurationStr}
                </Text>
              </View>
            </View>
          </View>

          {/* ジャンル別内訳アコーディオンヘッダー */}
          {genres.length > 0 && (
            <TouchableOpacity
              style={[styles.accordionHeader, { borderTopColor: cardBorder }]}
              onPress={toggleGenreAccordion}
              activeOpacity={0.7}
            >
              <View style={styles.accordionHeaderLeft}>
                <Ionicons 
                  name="pricetags-outline" 
                  size={15} 
                  color={isEcoMode ? '#64D2FF' : '#007AFF'} 
                  style={{ marginRight: 6 }} 
                />
                <Text style={[styles.accordionTitle, { color: isEcoMode ? '#AAA' : '#444' }]}>
                  ジャンル別内訳（{genres.length}種）
                </Text>
              </View>
              <View style={styles.accordionHeaderRight}>
                <Text style={[styles.accordionStatusText, { color: isEcoMode ? '#666' : '#8E8E93' }]}>
                  {isGenreAccordionExpanded ? '閉じる' : '詳細を見る'}
                </Text>
                <Ionicons
                  name={isGenreAccordionExpanded ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={isEcoMode ? '#888' : '#8E8E93'}
                  style={{ marginLeft: 4 }}
                />
              </View>
            </TouchableOpacity>
          )}

          {/* アコーディオン展開コンテンツ（ジャンル別リスト） */}
          {isGenreAccordionExpanded && genres.length > 0 && (
            <View style={styles.accordionContent}>
              {genres.map((item, idx) => (
                <View
                  key={`stat-genre-${idx}-${item.category}`}
                  style={[
                    styles.genreRow,
                    { backgroundColor: subCardBg, borderColor: subCardBorder }
                  ]}
                >
                  <View style={styles.genreRowTop}>
                    <Text style={[styles.genreName, { color: mainTextColor }]}>
                      {item.category}
                    </Text>
                    <View style={styles.genreCountBadge}>
                      <Text style={[styles.genreCountNum, { color: isEcoMode ? '#64D2FF' : '#007AFF' }]}>
                        {item.completed}
                      </Text>
                      <Text style={[styles.genreCountUnit, { color: labelColor }]}>回</Text>
                    </View>
                  </View>

                  <View style={styles.genreRowBottom}>
                    <Text style={[styles.genreSubText, { color: labelColor }]}>
                      📅 最終: {item.lastPracticedRelative}
                    </Text>
                    <Text style={[styles.genreSubText, { color: '#34C759' }]}>
                      🎯 達成率: {item.inTimeRate}%
                    </Text>
                    {item.streakDays > 0 ? (
                      <Text style={[styles.genreSubText, { color: '#FF9500' }]}>
                        🔥 {item.streakDays}日連続
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 0,
    marginTop: 10,
    marginBottom: 6,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  headerPressable: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 24,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  timeSummaryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  timeSummaryBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  streakBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  streakBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  expandedContent: {
    marginTop: 12,
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  gridItem: {
    width: '48.5%',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: 'center',
  },
  gridLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  gridValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  gridValue: {
    fontSize: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  gridValueTime: {
    fontSize: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  gridUnit: {
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 3,
  },
  accordionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  accordionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  accordionTitle: {
    fontSize: 12,
    fontWeight: '600',
  },
  accordionHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  accordionStatusText: {
    fontSize: 11,
    fontWeight: '500',
  },
  accordionContent: {
    marginTop: 8,
    gap: 6,
  },
  genreRow: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  genreRowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  genreName: {
    fontSize: 14,
    fontWeight: '700',
  },
  genreCountBadge: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  genreCountNum: {
    fontSize: 16,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  genreCountUnit: {
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 2,
  },
  genreRowBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
  },
  genreSubText: {
    fontSize: 11,
    fontWeight: '500',
  },
});

