import React, { useEffect, useState, useContext } from 'react';
import { View, Text, StyleSheet, Platform, StatusBar as RNStatusBar } from 'react-native';
import * as Battery from 'expo-battery';
import { Ionicons } from '@expo/vector-icons';
import { AppContext } from '../utils/AppContext';

export default function CustomBatteryIndicator() {
  const { 
    isEcoMode, 
    isEcoClockEnabled, isEcoBatteryEnabled,
    isNormalClockEnabled, isNormalBatteryEnabled 
  } = useContext(AppContext);
  const [batteryLevel, setBatteryLevel] = useState(null);
  const [timeStr, setTimeStr] = useState('');

  // 電池残量の取得
  useEffect(() => {
    let subscription;
    const initBattery = async () => {
      const level = await Battery.getBatteryLevelAsync();
      if (level >= 0) setBatteryLevel(level);
      
      subscription = Battery.addBatteryLevelListener(({ batteryLevel }) => {
        if (batteryLevel >= 0) setBatteryLevel(batteryLevel);
      });
    };
    initBattery();
    
    return () => {
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

  const showClock = isEcoMode ? isEcoClockEnabled : isNormalClockEnabled;
  const showBattery = isEcoMode ? isEcoBatteryEnabled : isNormalBatteryEnabled;

  if (!showClock && !showBattery) {
    return null;
  }

  const percentage = batteryLevel !== null ? Math.round(batteryLevel * 100) : null;
  const statusBarHeight = Platform.OS === 'ios' ? 44 : RNStatusBar.currentHeight || 24;

  let iconName = "battery-full";
  if (percentage !== null) {
    if (percentage <= 20) iconName = "battery-dead";
    else if (percentage <= 60) iconName = "battery-half";
  }

  // OSのステータスバー領域に被りすぎない範囲で、できるだけ上（ドットの真上あたり）に配置する
  // 3つのタブが均等配置されているため、左右から約16%の位置がドットの中心になります
  return (
    <View style={[styles.container, { top: Math.max(10, statusBarHeight - 10) }]} pointerEvents="none">
      {/* 左側のドット（記録一覧）の上：時刻 */}
      <View style={styles.leftSide}>
        {showClock && <Text style={[styles.text, !isEcoMode && { color: '#666' }]}>{timeStr}</Text>}
      </View>

      {/* 右側のドット（設定）の上：電池残量 */}
      <View style={styles.rightSide}>
        {showBattery && percentage !== null && (
          <>
            <Ionicons name={iconName} size={14} color={isEcoMode ? "#aaa" : "#666"} />
            <Text style={[styles.text, !isEcoMode && { color: '#666' }]}>{percentage}%</Text>
          </>
        )}
      </View>
    </View>
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
