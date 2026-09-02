import React from 'react';
import { View, StyleSheet, Text } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

export default function RingProgress({
  radius = 120,
  strokeWidth = 20,
  progress = 0.5,
  color = '#007AFF', // 青色（変更可能）
  backgroundColor = '#E5E5EA', // トラック背景色
  fillColor = 'transparent',
}) {
  const innerRadius = radius - strokeWidth / 2;
  const circumference = 2 * Math.PI * innerRadius;
  
  // Progress goes from 0 to 1
  return (
    <View style={styles.container}>
      <Svg style={{ width: radius * 2, height: radius * 2 }}>

        {/* Active Progress Circle */}
        <Circle
          r={innerRadius}
          cx={radius}
          cy={radius}
          fill={fillColor}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={progress * circumference - circumference}
          strokeLinecap="round"
          // Rotate to start from top
          transform={`rotate(-90 ${radius} ${radius})`}
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
});
