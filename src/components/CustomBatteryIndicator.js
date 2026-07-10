import React, { useEffect, useState, useContext } from 'react';
import { View, Text, StyleSheet, Platform, StatusBar as RNStatusBar } from 'react-native';
import * as Battery from 'expo-battery';
import { Ionicons } from '@expo/vector-icons';
import { AppContext } from '../utils/AppContext';

export default function CustomBatteryIndicator() {
  const { isEcoMode } = useContext(AppContext);
  const [batteryLevel, setBatteryLevel] = useState(null);

  useEffect(() => {
    let subscription;
    const initBattery = async () => {
      // getBatteryLevelAsync returns a value between 0 and 1, or -1 on web/unsupported
      const level = await Battery.getBatteryLevelAsync();
      if (level >= 0) {
        setBatteryLevel(level);
      }
      
      subscription = Battery.addBatteryLevelListener(({ batteryLevel }) => {
        if (batteryLevel >= 0) {
          setBatteryLevel(batteryLevel);
        }
      });
    };
    
    initBattery();
    
    return () => {
      if (subscription) {
        subscription.remove();
      }
    };
  }, []);

  if (!isEcoMode || batteryLevel === null) {
    return null;
  }

  const percentage = Math.round(batteryLevel * 100);
  
  // OS StatusBar height approximation for top positioning
  // iOS is typically ~47 on notched phones, Android varies
  const statusBarHeight = Platform.OS === 'ios' ? 44 : RNStatusBar.currentHeight || 24;

  let iconName = "battery-full";
  if (percentage <= 20) iconName = "battery-dead";
  else if (percentage <= 60) iconName = "battery-half";

  return (
    <View style={[styles.container, { top: statusBarHeight }]} pointerEvents="none">
      <Ionicons name={iconName} size={14} color="#aaa" />
      <Text style={styles.text}>{percentage}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    right: 15,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 9999,
  },
  text: {
    color: '#aaa',
    fontSize: 12,
    marginLeft: 4,
    fontWeight: 'bold',
  }
});
