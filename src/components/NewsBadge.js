import React, { useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * 案D: スピーチバブル型（カラフル吹き出し）NEWSバッジ
 * React Native標準コンポーネントのみで構築し、New Architecture (Fabric) でも100%安全・高速に描画
 * @param {boolean} isVisible - 表示フラグ
 * @param {boolean} isHiddenUntilNext - 次の更新まで隠す設定中かどうか
 * @param {number} unreadCount - 未読件数
 * @param {Function} onPress - タップ時のコールバック
 */
export default function NewsBadge({ 
  unreadCount = 0, 
  onPress, 
  isHiddenUntilNext = false,
  style 
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  // 「次の更新まで隠す」がONの場合、表示しない
  if (isHiddenUntilNext) {
    return null;
  }

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.9,
      useNativeDriver: true,
      speed: 20,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1.0,
      friction: 4,
      tension: 50,
      useNativeDriver: true,
    }).start();
  };

  const hasUnread = unreadCount > 0;

  return (
    <Animated.View style={[styles.wrapper, { transform: [{ scale: scaleAnim }] }, style]}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={styles.touchArea}
      >
        {/* 吹き出し本体（鮮やかコーラルピンク × ゴールドアクセント） */}
        <View style={styles.bubble}>
          <Ionicons name="sparkles" size={11} color="#FFE600" style={styles.sparkleIcon} />
          <Text style={styles.newsText}>NEWS!</Text>
          {/* 吹き出しのしっぽ（左下） */}
          <View style={styles.tail} />
        </View>

        {/* 未読がある場合の赤い通知バッジ */}
        {hasUnread && (
          <View style={styles.unreadBadge}>
            <View style={styles.unreadDot} />
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    // 影エフェクト
    shadowColor: '#FF5E62',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 4,
    elevation: 4,
  },
  touchArea: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubble: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FF5E62', // 鮮やかで温かいコーラルピンク
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.5)',
  },
  sparkleIcon: {
    marginRight: 2,
  },
  newsText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.3,
    textShadowColor: 'rgba(0, 0, 0, 0.25)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  tail: {
    position: 'absolute',
    bottom: -4,
    left: 8,
    width: 0,
    height: 0,
    borderLeftWidth: 3.5,
    borderRightWidth: 3.5,
    borderTopWidth: 4.5,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#FF5E62',
  },
  unreadBadge: {
    position: 'absolute',
    top: -3,
    right: -3,
    backgroundColor: '#FFFFFF',
    borderRadius: 5,
    padding: 1,
  },
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#FF3B30',
  },
});
