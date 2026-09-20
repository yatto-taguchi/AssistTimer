import React, { useState, useContext } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppContext } from '../utils/AppContext';

// AndroidでLayoutAnimationを有効化
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function PracticeStatsCard({ stats }) {
  const { isEcoMode } = useContext(AppContext);
  const [isAccordionExpanded, setIsAccordionExpanded] = useState(false);

  if (!stats) return null;

  const toggleAccordion = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsAccordionExpanded(!isAccordionExpanded);
  };

  // 秒数を「○時間○分」または「○分○秒」にフォーマット
  const formatTotalTime = (totalSeconds) => {
    if (!totalSeconds || totalSeconds <= 0) return '0分';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}分`;
  };

  // カラーパレット
  const cardBg = isEcoMode ? '#111111' : '#FFFFFF';
  const cardBorder = isEcoMode ? '#222222' : '#E5E5EA';
  const labelColor = isEcoMode ? '#888888' : '#8E8E93';
  const mainTextColor = isEcoMode ? '#FFFFFF' : '#1C1C1E';
  const subCardBg = isEcoMode ? '#18181A' : '#F9F9FB';
  const subCardBorder = isEcoMode ? '#28282B' : '#ECECF0';

  const totalCompleted = stats.totalCompleted || 0;
  const inTimeRate = stats.overallInTimeRate || 0;
  const interruptedCount = stats.totalInterrupted || 0;
  const totalDurationStr = formatTotalTime(stats.totalDuration);
  const genres = stats.genres || [];

  return (
    <View style={[styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}>
      {/* カードヘッダー */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Ionicons 
            name="bar-chart" 
            size={18} 
            color={isEcoMode ? '#64D2FF' : '#007AFF'} 
            style={{ marginRight: 6 }} 
          />
          <Text style={[styles.headerTitle, { color: mainTextColor }]}>練習サマリー＆統計</Text>
        </View>
        {stats.overallStreak > 0 && (
          <View style={[styles.streakBadge, { backgroundColor: isEcoMode ? '#2C1E14' : '#FFF3E0' }]}>
            <Text style={[styles.streakBadgeText, { color: '#FF9500' }]}>
              🔥 {stats.overallStreak}日連続
            </Text>
          </View>
        )}
      </View>

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
          onPress={toggleAccordion}
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
              {isAccordionExpanded ? '閉じる' : '詳細を見る'}
            </Text>
            <Ionicons
              name={isAccordionExpanded ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={isEcoMode ? '#888' : '#8E8E93'}
              style={{ marginLeft: 4 }}
            />
          </View>
        </TouchableOpacity>
      )}

      {/* アコーディオン展開コンテンツ（ジャンル別リスト） */}
      {isAccordionExpanded && genres.length > 0 && (
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
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 6,
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  streakBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  streakBadgeText: {
    fontSize: 12,
    fontWeight: '700',
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
