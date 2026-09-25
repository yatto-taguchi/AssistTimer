import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { StyleSheet, View, Image, Text, Animated, Dimensions, Easing } from 'react-native';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

export const YAMAIMO_IMAGES = {
  // 第一弾
  main: require('../../assets/characters/yamaimo/main.png'),
  ji: require('../../assets/characters/yamaimo/ji.png'),
  chiratto: require('../../assets/characters/yamaimo/chiratto.png'),
  biroon: require('../../assets/characters/yamaimo/biroon.png'),
  ganbare: require('../../assets/characters/yamaimo/ganbare.png'),
  iijan: require('../../assets/characters/yamaimo/iijan.png'),
  makasete: require('../../assets/characters/yamaimo/makasete.png'),
  wakaruyo: require('../../assets/characters/yamaimo/wakaruyo.png'),
  oyasumi: require('../../assets/characters/yamaimo/oyasumi.png'),
  fu: require('../../assets/characters/yamaimo/fu.png'),
  // 第二弾
  orange: require('../../assets/characters/yamaimo/orange.png'),
  cake_tabetemasu: require('../../assets/characters/yamaimo/cake_tabetemasu.png'),
  cake_taberu: require('../../assets/characters/yamaimo/cake_taberu.png'),
  coffee_time: require('../../assets/characters/yamaimo/coffee_time.png'),
  coffee_dou: require('../../assets/characters/yamaimo/coffee_dou.png'),
  suibun: require('../../assets/characters/yamaimo/suibun.png'),
  heeee: require('../../assets/characters/yamaimo/heeee.png'),
  karaage: require('../../assets/characters/yamaimo/karaage.png'),
  pizza: require('../../assets/characters/yamaimo/pizza.png'),
};

const CHEER_MESSAGES = [
  '頑張ろう！',
  'その調子！',
  '落ち着いて〜！',
  '集中、集中！',
  'やまいもが見守ってるよ！',
  'ファイト〜！',
  '焦らず丁寧に！',
];

const CheerYamaimoOverlay = forwardRef(({ 
  isCheerModeEnabled, 
  isCheerInEcoEnabled, 
  isEcoMode 
}, ref) => {
  const [activeItem, setActiveItem] = useState(null); // { imageKey, position, hasSpeechBubble, speechText, duration }
  
  const animOpacity = useRef(new Animated.Value(0)).current;
  const animTranslateX = useRef(new Animated.Value(0)).current;
  const animTranslateY = useRef(new Animated.Value(0)).current;
  const animScale = useRef(new Animated.Value(0.8)).current;
  const hideTimeoutRef = useRef(null);

  const isEnabled = isCheerModeEnabled && (!isEcoMode || isCheerInEcoEnabled);

  // 外部からのトリガー関数
  useImperativeHandle(ref, () => ({
    // trigger('setting' | 'prep' | 'running' | 'finish_success' | 'overtime_start' | 'finish_overtime')
    trigger: (type, chance = 0.6) => {
      if (!isEnabled) return;
      // 出ない時もあってよい（確率抽選）
      if (Math.random() > chance) return;

      let imageKey = 'main';
      let position = 'bottom-right';
      let hasSpeechBubble = false;
      let speechText = '';
      let duration = 3500;

      // サイズ抽選: 超巨大 (15%), ラージ (20%), ミニ (15%), 標準 (50%)
      const sizeRand = Math.random();
      let sizeMode = 'normal';
      if (sizeRand < 0.15) {
        sizeMode = 'huge';
        position = 'center'; // 超巨大時は画面中央をドーーーンと占拠！
      } else if (sizeRand < 0.35) {
        sizeMode = 'large';
      } else if (sizeRand < 0.50) {
        sizeMode = 'small';
      } else {
        sizeMode = 'normal';
      }

      if (type === 'setting') {
        // 準備時間やカウントアップ設定時: 「任せて」
        imageKey = 'makasete';
        if (sizeMode !== 'huge') position = 'bottom-right';
      } else if (type === 'prep') {
        // 準備中: がんばれ、じー、チラッ、びろ～ん、オレンジ、へーーー、からあげ、ピザ、＋低確率でケーキ食べてます、コーヒータイム
        const isRare = Math.random() < 0.12;
        if (isRare) {
          // レア枠（ツッコミ・脱力）
          if (Math.random() > 0.5) {
            imageKey = 'cake_tabetemasu';
            hasSpeechBubble = true;
            speechText = 'あ、ケーキ食べてます';
          } else {
            imageKey = 'coffee_time';
          }
        } else {
          const prepKeys = ['ganbare', 'ji', 'chiratto', 'biroon', 'orange', 'heeee', 'karaage', 'pizza'];
          imageKey = prepKeys[Math.floor(Math.random() * prepKeys.length)];
          if (imageKey === 'pizza') {
            hasSpeechBubble = true;
            speechText = 'あ、気にせず頑張って♡';
          }
        }

        if (sizeMode !== 'huge') {
          if (imageKey === 'chiratto') position = 'side-right';
          else if (imageKey === 'ji' || imageKey === 'coffee_time' || imageKey === 'karaage') position = 'bottom-center';
          else if (imageKey === 'biroon') position = 'top-center';
          else position = 'bottom-right';
        }
      } else if (type === 'running') {
        // タイム中:
        // 低確率レア枠（12%）: ケーキ食べてます、コーヒータイム
        // 通常枠: main（吹き出し）、ピザ（吹き出し）、じー、チラッ、びろ～ん、がんばれ、おやすみ、フッ、オレンジ、へーーー、からあげ
        const isRare = Math.random() < 0.12;
        if (isRare) {
          if (Math.random() > 0.5) {
            imageKey = 'cake_tabetemasu';
            hasSpeechBubble = true;
            speechText = 'あ、ケーキ食べてます';
          } else {
            imageKey = 'coffee_time';
          }
        } else {
          const runningKeys = [
            'main', 'pizza', 'ji', 'chiratto', 'biroon', 'ganbare', 
            'oyasumi', 'fu', 'orange', 'heeee', 'karaage'
          ];
          imageKey = runningKeys[Math.floor(Math.random() * runningKeys.length)];
          if (imageKey === 'main') {
            hasSpeechBubble = true;
            speechText = CHEER_MESSAGES[Math.floor(Math.random() * CHEER_MESSAGES.length)];
          } else if (imageKey === 'pizza') {
            hasSpeechBubble = true;
            speechText = 'あ、気にせず頑張って♡';
          }
        }

        if (sizeMode !== 'huge') {
          if (imageKey === 'chiratto') {
            position = Math.random() > 0.5 ? 'side-right' : 'side-left';
          } else if (imageKey === 'ji' || imageKey === 'coffee_time' || imageKey === 'karaage') {
            position = 'bottom-center';
          } else if (imageKey === 'biroon') {
            position = 'top-center';
          } else {
            position = 'bottom-right';
          }
        }
      } else if (type === 'finish_success') {
        // タイム終了後（タイム内達成 & 記録保存時）:
        // レア枠（15%）: コーヒーどう？（本格ハンドドリップ）
        // 通常枠: ケーキ食べる？、水分補給、いいじゃん、からあげ（最高〜！）
        const isRare = Math.random() < 0.15;
        if (isRare) {
          imageKey = 'coffee_dou';
          hasSpeechBubble = true;
          speechText = Math.random() > 0.5 ? 'コーヒーどう？' : 'ケーキ食べる？';
        } else {
          const successKeys = ['cake_taberu', 'suibun', 'iijan', 'karaage'];
          imageKey = successKeys[Math.floor(Math.random() * successKeys.length)];
          if (imageKey === 'cake_taberu') {
            hasSpeechBubble = true;
            speechText = 'ケーキ食べる？';
          } else if (imageKey === 'suibun') {
            hasSpeechBubble = true;
            speechText = '水分補給しよう！';
          }
        }
        if (sizeMode !== 'huge') position = 'bottom-right';
        duration = 3800;
      } else if (type === 'overtime_start' || type === 'finish_overtime') {
        // タイム内に入らなかった時（超過時間突入時・超過保存時）: わかるよ、フッ、ピザ、へーーー、オレンジ
        const overtimeKeys = ['wakaruyo', 'fu', 'pizza', 'heeee', 'orange'];
        imageKey = overtimeKeys[Math.floor(Math.random() * overtimeKeys.length)];
        if (imageKey === 'pizza') {
          hasSpeechBubble = true;
          speechText = 'あ、気にせず頑張って♡';
        }
        if (sizeMode !== 'huge') position = 'bottom-right';
        duration = 3800;
      }

      showCharacter({ imageKey, position, sizeMode, hasSpeechBubble, speechText, duration });
    },
    // 手動で即座に指定のキャラクターを出現させる
    showDirect: (params) => {
      showCharacter(params);
    }
  }));

  const showCharacter = ({ 
    imageKey, 
    position = 'bottom-right', 
    sizeMode = 'normal', 
    hasSpeechBubble = false, 
    speechText = '', 
    duration = 3500 
  }) => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
    animOpacity.stopAnimation();
    animTranslateX.stopAnimation();
    animTranslateY.stopAnimation();
    animScale.stopAnimation();

    setActiveItem({ imageKey, position, sizeMode, hasSpeechBubble, speechText });

    // アニメーション初期化
    let initX = 0;
    let initY = 30;
    if (position === 'side-right') {
      initX = 60;
      initY = 0;
    } else if (position === 'side-left') {
      initX = -60;
      initY = 0;
    } else if (position === 'top-center') {
      initX = 0;
      initY = -40;
    } else if (position === 'center') {
      initX = 0;
      initY = 50;
    }

    animOpacity.setValue(0);
    animTranslateX.setValue(initX);
    animTranslateY.setValue(initY);
    animScale.setValue(sizeMode === 'huge' ? 0.4 : 0.7);

    // ポップアップ・スプリングアニメーション
    Animated.parallel([
      Animated.timing(animOpacity, {
        toValue: 1,
        duration: 280,
        useNativeDriver: true,
      }),
      Animated.spring(animScale, {
        toValue: 1,
        friction: sizeMode === 'huge' ? 5 : 6,
        tension: sizeMode === 'huge' ? 45 : 50,
        useNativeDriver: true,
      }),
      Animated.spring(animTranslateX, {
        toValue: 0,
        friction: 6,
        tension: 50,
        useNativeDriver: true,
      }),
      Animated.spring(animTranslateY, {
        toValue: 0,
        friction: 6,
        tension: 50,
        useNativeDriver: true,
      }),
    ]).start();

    // 一定時間後にフワッとフェードアウト
    hideTimeoutRef.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(animOpacity, {
          toValue: 0,
          duration: 350,
          useNativeDriver: true,
        }),
        Animated.timing(animScale, {
          toValue: sizeMode === 'huge' ? 0.7 : 0.8,
          duration: 350,
          useNativeDriver: true,
        }),
        Animated.timing(animTranslateY, {
          toValue: position === 'top-center' ? -20 : (position === 'center' ? -30 : 20),
          duration: 350,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) {
          setActiveItem(null);
        }
      });
    }, duration);
  };

  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  if (!activeItem || !isEnabled) {
    return null;
  }

  // 位置スタイルの動的計算
  const getPositionStyle = () => {
    switch (activeItem.position) {
      case 'center':
        return styles.posCenter;
      case 'side-right':
        return styles.posSideRight;
      case 'side-left':
        return styles.posSideLeft;
      case 'bottom-center':
        return styles.posBottomCenter;
      case 'top-center':
        return styles.posTopCenter;
      case 'bottom-right':
      default:
        return styles.posBottomRight;
    }
  };

  // サイズスタイルの動的計算
  const getImageStyle = () => {
    switch (activeItem.sizeMode) {
      case 'huge':
        return styles.characterImageHuge;
      case 'large':
        return styles.characterImageLarge;
      case 'small':
        return styles.characterImageSmall;
      case 'normal':
      default:
        return styles.characterImageNormal;
    }
  };

  return (
    <View style={styles.fullscreenContainer} pointerEvents="none">
      <Animated.View
        style={[
          styles.characterWrapper,
          getPositionStyle(),
          {
            opacity: animOpacity,
            transform: [
              { translateX: animTranslateX },
              { translateY: animTranslateY },
              { scale: animScale },
            ],
          },
        ]}
      >
        {/* 吹き出しを表示（メイン画像、ピザ、ケーキ、水分補給、コーヒー等） */}
        {activeItem.hasSpeechBubble && (
          <View style={[
            styles.speechBubble,
            activeItem.sizeMode === 'huge' && styles.speechBubbleHuge
          ]}>
            <Text style={[
              styles.speechText,
              activeItem.sizeMode === 'huge' && styles.speechTextHuge
            ]}>
              {activeItem.speechText}
            </Text>
            <View style={styles.speechTail} />
          </View>
        )}

        <Image
          source={YAMAIMO_IMAGES[activeItem.imageKey] || YAMAIMO_IMAGES.main}
          style={getImageStyle()}
          resizeMode="contain"
        />
      </Animated.View>
    </View>
  );
});

export default CheerYamaimoOverlay;

const styles = StyleSheet.create({
  fullscreenContainer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  characterWrapper: {
    position: 'absolute',
    alignItems: 'center',
  },
  // 画面中央（超巨大画面占拠用）
  posCenter: {
    alignSelf: 'center',
    top: screenHeight * 0.28,
  },
  // 右下（操作ボタンの斜め上あたり：タイマー数字とボタンに被らないゴールデンエリア）
  posBottomRight: {
    right: 16,
    bottom: screenHeight > 750 ? 190 : 160,
  },
  // 左下
  posBottomLeft: {
    left: 16,
    bottom: screenHeight > 750 ? 190 : 160,
  },
  // 画面右端からのぞき見
  posSideRight: {
    right: -10,
    top: screenHeight * 0.38,
  },
  // 画面左端からのぞき見
  posSideLeft: {
    left: -10,
    top: screenHeight * 0.38,
  },
  // 下部中央からひょっこり
  posBottomCenter: {
    alignSelf: 'center',
    bottom: screenHeight > 750 ? 200 : 170,
  },
  // 上部中央（びろ〜ん等）
  posTopCenter: {
    alignSelf: 'center',
    top: 90,
  },
  // 超巨大（画面いっぱい）
  characterImageHuge: {
    width: Math.min(320, screenWidth * 0.82),
    height: Math.min(320, screenWidth * 0.82),
  },
  // ラージサイズ
  characterImageLarge: {
    width: 190,
    height: 190,
  },
  // 標準サイズ
  characterImageNormal: {
    width: 140,
    height: 140,
  },
  // ミニサイズ
  characterImageSmall: {
    width: 105,
    height: 105,
  },

  speechBubble: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    marginBottom: 6,
    borderWidth: 1.5,
    borderColor: '#FACC15',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
    maxWidth: 200,
  },
  speechBubbleHuge: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    marginBottom: 8,
    maxWidth: 280,
    borderWidth: 2,
  },
  speechText: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#333333',
    textAlign: 'center',
  },
  speechTextHuge: {
    fontSize: 16,
  },
  speechTail: {
    position: 'absolute',
    bottom: -6,
    alignSelf: 'center',
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderTopWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#FACC15',
  },
});
