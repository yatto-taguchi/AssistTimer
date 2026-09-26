import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

export default function RingProgress({
  radius = 120,
  strokeWidth = 20,
  progress = 0.5,
  color = '#007AFF', // 青色（変更可能）
  backgroundColor = '#E5E5EA', // トラック背景色
  fillColor = 'transparent',
  isIdle = false,
  isEcoMode = false,
}) {
  const innerRadius = radius - strokeWidth / 2;
  const circumference = 2 * Math.PI * innerRadius;

  const rotateAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let rotateLoop = null;
    let pulseLoop = null;

    if (isIdle) {
      rotateAnim.setValue(0);
      pulseAnim.setValue(0);

      // 水流ハイライトのゆったり回転（9秒で360度）
      rotateLoop = Animated.loop(
        Animated.timing(rotateAnim, {
          toValue: 1,
          duration: 9000,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      );

      // 光の呼吸パルス（3.6秒周期で穏やかに満ち引き）
      pulseLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1800,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 0,
            duration: 1800,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ])
      );

      rotateLoop.start();
      pulseLoop.start();
    } else {
      rotateAnim.stopAnimation();
      rotateAnim.setValue(0);
      pulseAnim.stopAnimation();
      pulseAnim.setValue(0);
    }

    return () => {
      if (rotateLoop) rotateLoop.stop();
      if (pulseLoop) pulseLoop.stop();
      rotateAnim.stopAnimation();
      pulseAnim.stopAnimation();
    };
  }, [isIdle]);

  // 回転角度の補間
  const spin = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // 透明度の補間（光の呼吸: 0.82 〜 1.0）
  const pulseOpacity = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.82, 1.0],
  });

  return (
    <View style={styles.container}>
      {isIdle ? (
        /* 待機時: 1本の完全な美しい円環 ＋ オフセット放射グラデーション（一箇所だけが水のように光って巡る） */
        <Animated.View
          style={{
            width: radius * 2,
            height: radius * 2,
            transform: [{ rotate: spin }],
            opacity: pulseOpacity,
          }}
        >
          <Svg style={{ width: radius * 2, height: radius * 2 }}>
            <Defs>
              <RadialGradient
                id="idleWaterRadialGrad"
                cx="50%"
                cy="3%"
                r="65%"
                fx="50%"
                fy="3%"
              >
                <Stop offset="0%" stopColor={isEcoMode ? "#64D2FF" : "#00FFFF"} stopOpacity="1" />
                <Stop offset="25%" stopColor={isEcoMode ? "#30B0C7" : "#5AC8FA"} stopOpacity="1" />
                <Stop offset="60%" stopColor={isEcoMode ? "#0A84FF" : "#007AFF"} stopOpacity="1" />
                <Stop offset="100%" stopColor={isEcoMode ? "#0040DD" : "#0051A8"} stopOpacity="1" />
              </RadialGradient>
            </Defs>
            {/* 完全に1本の滑らかで美しい円環（ツギハギ・変なパーツは一切なし） */}
            <Circle
              r={innerRadius}
              cx={radius}
              cy={radius}
              fill="transparent"
              stroke="url(#idleWaterRadialGrad)"
              strokeWidth={strokeWidth}
            />
          </Svg>
        </Animated.View>
      ) : (
        /* 計測中・一時停止時: 通常の単色プログレスリング（進捗0%時は不要な始点ドット残留を根本防止） */
        <Svg style={{ width: radius * 2, height: radius * 2 }}>
          {progress > 0 && (
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
              transform={`rotate(-90 ${radius} ${radius})`}
            />
          )}
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
});
