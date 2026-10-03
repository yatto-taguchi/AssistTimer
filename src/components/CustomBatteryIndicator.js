import React, { useEffect, useState, useContext } from 'react';
import { View, Text, StyleSheet, Platform, StatusBar as RNStatusBar, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Battery from 'expo-battery';
import { Ionicons } from '@expo/vector-icons';
import { AppContext } from '../utils/AppContext';

export default function CustomBatteryIndicator() {
  const { 
    isEcoMode, 
    isEcoClockEnabled, isEcoBatteryEnabled,
    controlsOpacity
  } = useContext(AppContext);
  const [batteryLevel, setBatteryLevel] = useState(1.0);
  const [timeStr, setTimeStr] = useState('');

  let insets = { top: 0 };
  try {
    insets = useSafeAreaInsets();
  } catch (e) {
    // Provider外等の安全フォールバック
  }

  // 電池残量の取得
  useEffect(() => {
    let subscription;
    let isMounted = true;

    const fetchBattery = async () => {
      try {
        const level = await Battery.getBatteryLevelAsync();
        if (!isMounted) return;
        if (level >= 0) {
          setBatteryLevel(level);
        } else {
          // iOSシミュレーター環境等（level === -1）でのフォールバック表示（100%）
          setBatteryLevel(1.0);
        }
      } catch (error) {
        if (!isMounted) return;
        // 例外時（API未対応等）もフォールバック
        setBatteryLevel(1.0);
      }
    };

    fetchBattery();

    // 30秒ごとに定期ポーリング（実機での残量変化追従）
    const interval = setInterval(fetchBattery, 30000);

    // バッテリー残量変更リスナー
    try {
      subscription = Battery.addBatteryLevelListener(({ batteryLevel }) => {
        if (!isMounted) return;
        if (batteryLevel >= 0) {
          setBatteryLevel(batteryLevel);
        } else {
          setBatteryLevel(1.0);
        }
      });
    } catch (e) {
      // リスナー登録不可時の保護
    }

    return () => {
      isMounted = false;
      clearInterval(interval);
      if (subscription) subscription.remove();
    };
  }, []);

  // 時刻の取得と更新
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const h = now.getHours().toString().padStart(2, '0');
      const m = now.getMinutes().toString().padStart(2, '0');
      setTimeStr(`${h}:${m}`);
    };
    updateTime();
    const interval = setInterval(updateTime, 5000);
    return () => clearInterval(interval);
  }, []);

  // 通常モードはOS標準ステータスバーがあるため、CustomBatteryIndicatorはエコモード専用
  if (!isEcoMode) {
    return null;
  }

  const showClock = isEcoClockEnabled;
  const showBattery = isEcoBatteryEnabled;

  if (!showClock && !showBattery) {
    return null;
  }

  const percentage = batteryLevel !== null ? Math.round(batteryLevel * 100) : null;
  const topSafe = insets.top > 0 ? insets.top : (Platform.OS === 'ios' ? 44 : (RNStatusBar.currentHeight || 24));
  const indicatorTop = Math.max(8, topSafe - 24);

  let iconName = "battery-full";
  if (percentage !== null) {
    if (percentage <= 20) iconName = "battery-dead";
    else if (percentage <= 60) iconName = "battery-half";
  }

  // OSのステータスバー領域に被りすぎない範囲で、できるだけ上（ドットの真上あたり）に配置する
  // 3つのタブが均等配置されているため、左右から約16%の位置がドットの中心になります
  return (
    <Animated.View 
      style={[
        styles.container, 
        { 
          top: indicatorTop,
          opacity: controlsOpacity
        }
      ]} 
      pointerEvents="none"
    >
      {/* 左側のドット（記録一覧）の上：時刻 */}
      <View style={styles.leftSide}>
        {showClock && <Text style={styles.text}>{timeStr}</Text>}
      </View>

      {/* 右側のドット（設定）の上：電池残量 */}
      <View style={styles.rightSide}>
        {showBattery && percentage !== null && (
          <>
            <Ionicons name={iconName} size={14} color="#aaa" />
            <Text style={styles.text}>{percentage}%</Text>
          </>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: '12%', // ドットの真上付近に合うように調整
    zIndex: 9999,
  },
  leftSide: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 50,
    transform: [{ translateX: -10 }], // さらに左に5ピクセル移動（合計-10）
  },
  rightSide: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: 60,
    transform: [{ translateX: 10 }], // さらに右に5ピクセル移動（合計10）
  },
  text: {
    color: '#aaa',
    fontSize: 12,
    marginLeft: 4,
    fontWeight: 'bold',
  }
});
