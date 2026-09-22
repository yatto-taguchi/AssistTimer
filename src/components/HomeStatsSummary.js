import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * ホーム画面（タイマー画面）用の練習統計サマリーコンポーネント
 * ジャンルバッジとタイマー円の間に配置される
 */
const HomeStatsSummary = ({
  stats,
  isEcoMode,
  isCollapsed,
  onToggleCollapse,
  disabled = false,
}) => {
  if (!stats) return null;

  const handlePress = () => {
    if (disabled) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (onToggleCollapse) {
      onToggleCollapse();
    }
  };

  const streakText = stats.streakDays > 0 
    ? `🔥 ${stats.streakDays}日連続` 
    : '🔥 0日';

  if (isCollapsed) {
    // 折りたたみ時: 超スリムな1行サマリーピル
    return (
      <TouchableOpacity
        style={[
          styles.collapsedContainer,
          isEcoMode ? styles.collapsedContainerEco : styles.collapsedContainerNormal,
        ]}
        onPress={handlePress}
        activeOpacity={0.7}
        disabled={disabled}
      >
        <Ionicons
          name="stats-chart"
          size={12}
          color={isEcoMode ? '#64D2FF' : '#007AFF'}
          style={{ marginRight: 5 }}
        />
        <Text style={[styles.collapsedText, isEcoMode ? styles.textEco : styles.textNormal]}>
          今日 {stats.todaySessions}回 ({stats.todayDurationText})
        </Text>
        <Text style={[styles.collapsedDivider, isEcoMode ? styles.dividerEco : styles.dividerNormal]}>
          ・
        </Text>
        <Text style={[styles.collapsedText, isEcoMode ? styles.textEco : styles.textNormal]}>
          累計 {stats.totalCompleted}回
        </Text>
        <Ionicons
          name="chevron-down"
          size={12}
          color={isEcoMode ? '#8E8E93' : '#8E8E93'}
          style={{ marginLeft: 5 }}
        />
      </TouchableOpacity>
    );
  }

  // 展開時: 洗練された2段マイクロカード
  return (
    <TouchableOpacity
      style={[
        styles.cardContainer,
        isEcoMode ? styles.cardContainerEco : styles.cardContainerNormal,
      ]}
      onPress={handlePress}
      activeOpacity={0.85}
      disabled={disabled}
    >
      {/* 上段: 合計回数 ｜ 累計タイム ｜ 平均タイム */}
      <View style={styles.row}>
        <View style={styles.item}>
          <Text style={[styles.label, isEcoMode ? styles.labelEco : styles.labelNormal]}>
            合計
          </Text>
          <Text style={[styles.value, isEcoMode ? styles.valueEco : styles.valueNormal]}>
            {stats.totalCompleted}<Text style={styles.unit}>回</Text>
          </Text>
        </View>

        <View style={[styles.separator, isEcoMode ? styles.separatorEco : styles.separatorNormal]} />

        <View style={styles.item}>
          <Text style={[styles.label, isEcoMode ? styles.labelEco : styles.labelNormal]}>
            累計
          </Text>
          <Text style={[styles.value, isEcoMode ? styles.valueEco : styles.valueNormal]}>
            {stats.totalDurationText}
          </Text>
        </View>

        <View style={[styles.separator, isEcoMode ? styles.separatorEco : styles.separatorNormal]} />

        <View style={styles.item}>
          <Text style={[styles.label, isEcoMode ? styles.labelEco : styles.labelNormal]}>
            平均
          </Text>
          <Text style={[styles.value, isEcoMode ? styles.valueEco : styles.valueNormal]}>
            {stats.averageDurationText}
          </Text>
        </View>

        {/* 右上の折りたたみインジケーター */}
        <View style={styles.collapseButton}>
          <Ionicons
            name="chevron-up"
            size={13}
            color={isEcoMode ? '#8E8E93' : '#8E8E93'}
          />
        </View>
      </View>

      {/* 水平ディバイダー */}
      <View style={[styles.horizontalDivider, isEcoMode ? styles.horizontalDividerEco : styles.horizontalDividerNormal]} />

      {/* 下段: 今日の回数と分数 ｜ 連続日数 */}
      <View style={styles.row}>
        <View style={[styles.item, { flex: 1.2, alignItems: 'flex-start', paddingLeft: 4 }]}>
          <View style={styles.badgeRow}>
            <Text style={[styles.label, isEcoMode ? styles.labelEco : styles.labelNormal]}>
              今日:
            </Text>
            <Text style={[styles.todayValue, isEcoMode ? styles.todayValueEco : styles.todayValueNormal]}>
              {' '}{stats.todaySessions}<Text style={styles.unit}>回</Text>
              <Text style={[styles.subValue, isEcoMode ? styles.subValueEco : styles.subValueNormal]}>
                {' '}({stats.todayDurationText})
              </Text>
            </Text>
          </View>
        </View>

        <View style={[styles.separator, isEcoMode ? styles.separatorEco : styles.separatorNormal]} />

        <View style={[styles.item, { flex: 1, alignItems: 'flex-end', paddingRight: 6 }]}>
          <Text style={[styles.streakValue, isEcoMode ? styles.streakValueEco : styles.streakValueNormal]}>
            {streakText}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  // 折りたたみ時
  collapsedContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 3,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 6,
  },
  collapsedContainerNormal: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E5EA',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  collapsedContainerEco: {
    backgroundColor: '#161618',
    borderColor: '#2C2C2E',
  },
  collapsedText: {
    fontSize: 11,
    fontWeight: '500',
  },
  collapsedDivider: {
    fontSize: 11,
    marginHorizontal: 3,
  },
  dividerNormal: {
    color: '#C7C7CC',
  },
  dividerEco: {
    color: '#3A3A3C',
  },

  // 展開時カード
  cardContainer: {
    width: 290,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginTop: 8,
  },
  cardContainerNormal: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E5EA',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1.5 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  cardContainerEco: {
    backgroundColor: '#161618',
    borderColor: '#262628',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  item: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
  },
  collapseButton: {
    paddingLeft: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  horizontalDivider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 4,
  },
  horizontalDividerNormal: {
    backgroundColor: '#EBEBF0',
  },
  horizontalDividerEco: {
    backgroundColor: '#262628',
  },
  separator: {
    width: StyleSheet.hairlineWidth,
    height: 12,
    marginHorizontal: 4,
  },
  separatorNormal: {
    backgroundColor: '#E0E0E5',
  },
  separatorEco: {
    backgroundColor: '#2C2C2E',
  },

  // ラベルと値
  label: {
    fontSize: 10,
    fontWeight: '500',
    marginRight: 3,
  },
  labelNormal: {
    color: '#8E8E93',
  },
  labelEco: {
    color: '#71717A',
  },

  value: {
    fontSize: 11,
    fontWeight: '700',
  },
  valueNormal: {
    color: '#1C1C1E',
  },
  valueEco: {
    color: '#F2F2F7',
  },
  unit: {
    fontSize: 9,
    fontWeight: '500',
  },

  badgeRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  todayValue: {
    fontSize: 11,
    fontWeight: '700',
  },
  todayValueNormal: {
    color: '#007AFF',
  },
  todayValueEco: {
    color: '#64D2FF',
  },
  subValue: {
    fontSize: 10,
    fontWeight: '500',
  },
  subValueNormal: {
    color: '#687076',
  },
  subValueEco: {
    color: '#A1A1AA',
  },

  streakValue: {
    fontSize: 11,
    fontWeight: '700',
  },
  streakValueNormal: {
    color: '#FF9500',
  },
  streakValueEco: {
    color: '#F59E0B',
  },

  textNormal: {
    color: '#3A3A3C',
  },
  textEco: {
    color: '#E4E4E7',
  },
});

export default HomeStatsSummary;
