import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { StyleSheet, View, Image, Text, Animated, Dimensions, Easing, TouchableOpacity, Vibration } from 'react-native';

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
  // 第三弾（走りシリーズ - タイム中専用）
  run_tokotoko: require('../../assets/characters/yamaimo/run_tokotoko.png'),
  run_patapata: require('../../assets/characters/yamaimo/run_patapata.png'),
  run_shuchu: require('../../assets/characters/yamaimo/run_shuchu.png'),
  run_hachimaki: require('../../assets/characters/yamaimo/run_hachimaki.png'),
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
  const [activeItem, setActiveItem] = useState(null); // { imageKey, position, hasSpeechBubble, speechText, duration, sizeMode }
  
  const animOpacity = useRef(new Animated.Value(0)).current;
  const animTranslateX = useRef(new Animated.Value(0)).current;
  const animTranslateY = useRef(new Animated.Value(0)).current;
  const animScale = useRef(new Animated.Value(0.8)).current;
  const animRotate = useRef(new Animated.Value(0)).current;
  const animFlipX = useRef(new Animated.Value(1)).current; // 1: 右向き, -1: 左向き反転
  const animBounceY = useRef(new Animated.Value(0)).current; // トコトコ走る上下バウンド
  const bounceAnimRef = useRef(null);
  const runningAnimRef = useRef(null);
  const hideTimeoutRef = useRef(null);
  const isDismissingRef = useRef(false);

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
      let duration = 30000; // デフォルト30秒

      // サイズ抽選: 超巨大 (20%), ラージ (25%), ミニ (25%), 標準 (30%)
      const sizeRand = Math.random();
      let sizeMode = 'normal';
      if (sizeRand < 0.20) {
        sizeMode = 'huge';
        position = 'center'; // 超巨大時は画面中央または中央上下をドーーーンと占拠！
      } else if (sizeRand < 0.45) {
        sizeMode = 'large';
      } else if (sizeRand < 0.70) {
        sizeMode = 'small';
      } else {
        sizeMode = 'normal';
      }

      if (type === 'setting') {
        // 準備時間やカウントアップ設定時: 「任せて」
        imageKey = 'makasete';
        if (sizeMode !== 'huge') position = 'bottom-right';
        duration = 3500;
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
        duration = 15000; // 準備中は最大15秒（またはタイマー開始時・タップで消去）
      } else if (type === 'running') {
        // タイム中（タイム中専用の演出！）
        // 約60%の高確率で「広告バナーの上を走る・焦ってウロウロする」ランナー演出が出現！
        const isBannerRunner = Math.random() < 0.60;

        if (isBannerRunner) {
          position = 'banner-run';
          sizeMode = 'banner-run';
          
          // 演出パターン抽選:
          // 1. left_to_right: 左から右へ駆け抜け (35%)
          // 2. right_to_left: 右から左へ駆け抜け (35%)
          // 3. pacing: 左右に焦ってウロウロ！ (30%)
          const runRand = Math.random();
          let runnerType = 'left_to_right';
          if (runRand < 0.35) {
            runnerType = 'left_to_right';
          } else if (runRand < 0.70) {
            runnerType = 'right_to_left';
          } else {
            runnerType = 'pacing';
          }

          if (runnerType === 'pacing') {
            // 左右焦りウロウロ: 汗かきトコトコやハチマキが超マッチ！
            const pacingImages = ['run_tokotoko', 'run_hachimaki', 'run_patapata'];
            imageKey = pacingImages[Math.floor(Math.random() * pacingImages.length)];
            hasSpeechBubble = true;
            const pacingMsgs = ['あわわ…！', '焦る焦る！', '落ち着いて〜！', 'ど、どうしよう〜！', '集中、集中！'];
            speechText = pacingMsgs[Math.floor(Math.random() * pacingMsgs.length)];
            duration = 9000;
          } else if (runnerType === 'left_to_right') {
            const l2rImages = ['run_tokotoko', 'run_patapata', 'run_shuchu', 'run_hachimaki'];
            imageKey = l2rImages[Math.floor(Math.random() * l2rImages.length)];
            hasSpeechBubble = Math.random() < 0.65;
            const l2rMsgs = ['ファイト〜！', 'その調子！', 'トコトコ…', '駆け抜け中！', '頑張ろう！'];
            speechText = l2rMsgs[Math.floor(Math.random() * l2rMsgs.length)];
            duration = 4500;
          } else { // right_to_left
            const r2lImages = ['run_tokotoko', 'run_patapata', 'run_shuchu', 'run_hachimaki'];
            imageKey = r2lImages[Math.floor(Math.random() * r2lImages.length)];
            hasSpeechBubble = Math.random() < 0.65;
            const r2lMsgs = ['急げ急げ〜！', '通りま〜す！', 'あと少し！', 'ファイト！'];
            speechText = r2lMsgs[Math.floor(Math.random() * r2lMsgs.length)];
            duration = 4500;
          }

          showCharacter({ 
            imageKey, 
            position, 
            sizeMode, 
            hasSpeechBubble, 
            speechText, 
            duration,
            runPattern: runnerType
          });
          return;
        } else {
          // 残り40%は従来のタイム中応援（巨大やまいも、ケーキ、見守りなど）
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
          duration = 30000; // タイム中は30秒表示！
        }
      } else if (type === 'finish_success') {
        // タイム終了後（タイム内達成 & 記録保存時）
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

        // 位置のランダム決定（右下固定を完全撤廃！画面中央や文字被りも含めた全画面ランダム配置）
        if (sizeMode === 'huge') {
          const hugePositions = ['center', 'center-upper', 'center-lower'];
          position = hugePositions[Math.floor(Math.random() * hugePositions.length)];
        } else {
          const finishPositions = [
            'center', 'center-upper', 'center-lower',
            'bottom-right', 'bottom-left', 'bottom-center',
            'top-center', 'top-left', 'top-right',
            'side-right', 'side-left'
          ];
          position = finishPositions[Math.floor(Math.random() * finishPositions.length)];
        }
        duration = 15000; // タイム終了後は最大15秒（またはタップで即消去）
      } else if (type === 'overtime_start' || type === 'finish_overtime') {
        // タイム内に入らなかった時（超過時間突入時・超過保存時）
        const overtimeKeys = ['wakaruyo', 'fu', 'pizza', 'heeee', 'orange'];
        imageKey = overtimeKeys[Math.floor(Math.random() * overtimeKeys.length)];
        if (imageKey === 'pizza') {
          hasSpeechBubble = true;
          speechText = 'あ、気にせず頑張って♡';
        }

        // 位置のランダム決定
        if (sizeMode === 'huge') {
          const hugePositions = ['center', 'center-upper', 'center-lower'];
          position = hugePositions[Math.floor(Math.random() * hugePositions.length)];
        } else {
          const overtimePositions = [
            'center', 'center-upper', 'center-lower',
            'bottom-right', 'bottom-left', 'bottom-center',
            'top-center', 'top-left', 'top-right',
            'side-right', 'side-left'
          ];
          position = overtimePositions[Math.floor(Math.random() * overtimePositions.length)];
        }
        duration = 15000; // 最大15秒（またはタップで即消去）
      }

      showCharacter({ imageKey, position, sizeMode, hasSpeechBubble, speechText, duration });
    },
    // 手動で即座に指定のキャラクターを出現させる
    showDirect: (params) => {
      showCharacter(params);
    },
    // 外部から即座にフェードアウト・消去させる
    dismiss: () => {
      dismissCharacter(false);
    }
  }));

  // ランダムな消滅エフェクト（全5種類）を実行して消える
  const dismissCharacter = (isTapped = false) => {
    if (isDismissingRef.current || !activeItem) return;
    isDismissingRef.current = true;

    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }

    // 進行中の走行・バウンドアニメーションを停止
    if (bounceAnimRef.current) {
      bounceAnimRef.current.stop();
      bounceAnimRef.current = null;
    }
    if (runningAnimRef.current) {
      runningAnimRef.current.stop();
      runningAnimRef.current = null;
    }
    animBounceY.setValue(0);
    animFlipX.setValue(1);

    // タップ時は小気味よい微小振動フィードバック
    if (isTapped) {
      try {
        Vibration.vibrate(25);
      } catch (e) {
        // 無視
      }
    }

    // 消滅エフェクト全5種からランダム選択
    // 0: 'shrink' (縮小ポップダウン: キュッと小さくなって消える)
    // 1: 'drop' (スポンッ: 下または画面外へ引っ込んで消える)
    // 2: 'float' (ふわ〜り: 上へふわりと昇華して消える)
    // 3: 'pop' (ポンッ: 一瞬膨らんで弾けるように消える)
    // 4: 'spin' (くるんっ: 傾きながら縮小して消える)
    const effectType = Math.floor(Math.random() * 5);
    const anims = [];

    if (effectType === 0) {
      // 0: シュンッ（縮小ポップダウン）
      anims.push(
        Animated.timing(animOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(animScale, {
          toValue: 0.1,
          duration: 200,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        })
      );
    } else if (effectType === 1) {
      // 1: スポンッ（引っ込み・沈み込み）
      const dropY = (activeItem.position === 'top-center' || activeItem.position === 'top-left' || activeItem.position === 'top-right' || activeItem.position === 'center-upper') ? -60 : 70;
      anims.push(
        Animated.timing(animOpacity, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(animTranslateY, {
          toValue: dropY,
          duration: 220,
          easing: Easing.in(Easing.back(1.2)),
          useNativeDriver: true,
        })
      );
    } else if (effectType === 2) {
      // 2: ふわ〜り（上昇フェード）
      anims.push(
        Animated.timing(animOpacity, {
          toValue: 0,
          duration: 260,
          useNativeDriver: true,
        }),
        Animated.timing(animTranslateY, {
          toValue: -60,
          duration: 260,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(animScale, {
          toValue: 1.15,
          duration: 260,
          useNativeDriver: true,
        })
      );
    } else if (effectType === 3) {
      // 3: ポンッ（ポッピング弾け消え）
      anims.push(
        Animated.timing(animOpacity, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.timing(animScale, {
          toValue: 1.25,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        })
      );
    } else {
      // 4: くるんっ（回転スピンダウン）
      const rotDir = Math.random() > 0.5 ? 1 : -1;
      anims.push(
        Animated.timing(animOpacity, {
          toValue: 0,
          duration: 230,
          useNativeDriver: true,
        }),
        Animated.timing(animScale, {
          toValue: 0.15,
          duration: 230,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(animRotate, {
          toValue: rotDir,
          duration: 230,
          useNativeDriver: true,
        })
      );
    }

    Animated.parallel(anims).start(({ finished }) => {
      if (finished) {
        setActiveItem(null);
        isDismissingRef.current = false;
        animRotate.setValue(0);
      }
    });
  };

  const showCharacter = ({ 
    imageKey, 
    position = 'bottom-right', 
    sizeMode = 'normal', 
    hasSpeechBubble = false, 
    speechText = '', 
    duration = 30000,
    runPattern = null
  }) => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
    if (bounceAnimRef.current) {
      bounceAnimRef.current.stop();
      bounceAnimRef.current = null;
    }
    if (runningAnimRef.current) {
      runningAnimRef.current.stop();
      runningAnimRef.current = null;
    }

    isDismissingRef.current = false;
    animOpacity.stopAnimation();
    animTranslateX.stopAnimation();
    animTranslateY.stopAnimation();
    animScale.stopAnimation();
    animRotate.stopAnimation();
    animBounceY.setValue(0);
    animFlipX.setValue(1);

    setActiveItem({ imageKey, position, sizeMode, hasSpeechBubble, speechText, runPattern });

    // 広告バナー上ランナー演出の場合の専用アニメーション
    if (position === 'banner-run') {
      // トコトコ走る上下バウンドループ（軽快なボビング）
      bounceAnimRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(animBounceY, {
            toValue: -7,
            duration: 110,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          Animated.timing(animBounceY, {
            toValue: 0,
            duration: 110,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
        ])
      );
      bounceAnimRef.current.start();

      animScale.setValue(1);
      animRotate.setValue(0);
      animTranslateY.setValue(0);

      if (runPattern === 'left_to_right') {
        // 1. 左から右へ駆け抜け
        animFlipX.setValue(1); // 右向き
        animTranslateX.setValue(-120);
        animOpacity.setValue(1);

        runningAnimRef.current = Animated.timing(animTranslateX, {
          toValue: screenWidth + 120,
          duration: 4200,
          easing: Easing.linear,
          useNativeDriver: true,
        });

        runningAnimRef.current.start(({ finished }) => {
          if (finished) dismissCharacter(false);
        });
      } else if (runPattern === 'right_to_left') {
        // 2. 右から左へ駆け抜け
        animFlipX.setValue(-1); // 左向きに反転
        animTranslateX.setValue(screenWidth + 120);
        animOpacity.setValue(1);

        runningAnimRef.current = Animated.timing(animTranslateX, {
          toValue: -120,
          duration: 4200,
          easing: Easing.linear,
          useNativeDriver: true,
        });

        runningAnimRef.current.start(({ finished }) => {
          if (finished) dismissCharacter(false);
        });
      } else {
        // 3. 左右に焦ってウロウロ！（pacing）
        const startX = screenWidth * 0.20;
        animTranslateX.setValue(startX);
        animFlipX.setValue(1); // 最初は右向き
        animOpacity.setValue(0);

        runningAnimRef.current = Animated.sequence([
          // フェードインしながら右へ小走り
          Animated.parallel([
            Animated.timing(animOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
            Animated.timing(animTranslateX, {
              toValue: screenWidth * 0.65,
              duration: 1200,
              easing: Easing.linear,
              useNativeDriver: true,
            }),
          ]),
          // ちょっと立ち止まる（反転）
          Animated.delay(180),
          // 反転して左へ小走り
          Animated.timing(animTranslateX, {
            toValue: screenWidth * 0.15,
            duration: 1400,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          // ちょっと立ち止まる（反転）
          Animated.delay(180),
          // 反転して右へ小走り
          Animated.timing(animTranslateX, {
            toValue: screenWidth * 0.60,
            duration: 1100,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          // 画面外へ左に駆け去る
          Animated.timing(animTranslateX, {
            toValue: -130,
            duration: 1200,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
        ]);

        // 反転リスナーをセットして移動に合わせてキャラクターをくるっと反転
        const listenerId = animTranslateX.addListener(({ value }) => {
          // 移動の折り返し地点に合わせて向きを切り替え
          // 最初の右移動: 0.20 -> 0.65 (flip: 1)
          // 次の左移動: 0.65 -> 0.15 (flip: -1)
          // 次の右移動: 0.15 -> 0.60 (flip: 1)
          // 最後の退場: 0.60 -> -130 (flip: -1)
          // 簡易判定: 前回の値と比較
          if (animTranslateX._prevVal !== undefined) {
            if (value > animTranslateX._prevVal && animFlipX._value !== 1) {
              animFlipX.setValue(1);
            } else if (value < animTranslateX._prevVal && animFlipX._value !== -1) {
              animFlipX.setValue(-1);
            }
          }
          animTranslateX._prevVal = value;
        });

        runningAnimRef.current.start(({ finished }) => {
          animTranslateX.removeListener(listenerId);
          delete animTranslateX._prevVal;
          if (finished) dismissCharacter(false);
        });
      }

      // 安全タイマー（アニメーション完了前に何らかの要因で停止しなかった場合）
      hideTimeoutRef.current = setTimeout(() => {
        dismissCharacter(false);
      }, duration + 1000);
      return;
    }

    // 通常のポップアップ出現アニメーション
    let initX = 0;
    let initY = 30;
    if (position === 'side-right') {
      initX = 60;
      initY = 0;
    } else if (position === 'side-left') {
      initX = -60;
      initY = 0;
    } else if (position === 'top-center' || position === 'top-left' || position === 'top-right' || position === 'center-upper') {
      initX = 0;
      initY = -40;
    } else if (position === 'center' || position === 'center-lower') {
      initX = 0;
      initY = 50;
    }

    animOpacity.setValue(0);
    animTranslateX.setValue(initX);
    animTranslateY.setValue(initY);
    animScale.setValue(sizeMode === 'huge' ? 0.4 : 0.7);
    animRotate.setValue(0);

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

    // 指定時間（タイム中は30秒等）が経過したらランダムエフェクトでスッと自然消滅
    hideTimeoutRef.current = setTimeout(() => {
      dismissCharacter(false);
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
      case 'center-upper':
        return styles.posCenterUpper;
      case 'center-lower':
        return styles.posCenterLower;
      case 'top-left':
        return styles.posTopLeft;
      case 'top-right':
        return styles.posTopRight;
      case 'top-center':
        return styles.posTopCenter;
      case 'side-right':
        return styles.posSideRight;
      case 'side-left':
        return styles.posSideLeft;
      case 'bottom-left':
        return styles.posBottomLeft;
      case 'bottom-center':
        return styles.posBottomCenter;
      case 'banner-run':
        return styles.posBannerRun;
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
      case 'banner-run':
        return styles.characterImageBannerRun;
      case 'normal':
      default:
        return styles.characterImageNormal;
    }
  };

  // 回転補間
  const spinInterpolation = animRotate.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ['-30deg', '0deg', '30deg'],
  });

  return (
    <View style={styles.fullscreenContainer} pointerEvents="box-none">
      <Animated.View
        style={[
          styles.characterWrapper,
          getPositionStyle(),
          {
            opacity: animOpacity,
            transform: [
              { translateX: animTranslateX },
              { translateY: Animated.add(animTranslateY, animBounceY) },
              { scale: animScale },
              { rotate: spinInterpolation },
            ],
          },
        ]}
        pointerEvents="box-none"
      >
        <TouchableOpacity
          activeOpacity={0.88}
          onPress={() => dismissCharacter(true)}
          style={styles.touchableArea}
        >
          {/* 吹き出しを表示（メイン画像、ピザ、ケーキ、水分補給、コーヒー、ランナー等） */}
          {activeItem.hasSpeechBubble && (
            <View style={[
              styles.speechBubble,
              activeItem.sizeMode === 'huge' && styles.speechBubbleHuge,
              activeItem.position === 'banner-run' && styles.speechBubbleBannerRun,
            ]}>
              <Text style={[
                styles.speechText,
                activeItem.sizeMode === 'huge' && styles.speechTextHuge,
                activeItem.position === 'banner-run' && styles.speechTextBannerRun,
              ]}>
                {activeItem.speechText}
              </Text>
              <View style={styles.speechTail} />
            </View>
          )}

          <Animated.Image
            source={YAMAIMO_IMAGES[activeItem.imageKey] || YAMAIMO_IMAGES.main}
            style={[
              getImageStyle(),
              { transform: [{ scaleX: animFlipX }] } // 左右反転は画像のみに適用し、吹き出し文字は正方向を維持
            ]}
            resizeMode="contain"
          />
        </TouchableOpacity>
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
  touchableArea: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 画面中央（超巨大画面占拠用 / 中央ドカン）
  posCenter: {
    alignSelf: 'center',
    top: screenHeight * 0.28,
  },
  // 画面中央やや上（結果表示エリアの上・文字被り）
  posCenterUpper: {
    alignSelf: 'center',
    top: screenHeight * 0.16,
  },
  // 画面中央やや下（ボタンやジャンルの上・文字被り）
  posCenterLower: {
    alignSelf: 'center',
    top: screenHeight * 0.44,
  },
  // 画面右上
  posTopRight: {
    right: 16,
    top: screenHeight > 750 ? 120 : 90,
  },
  // 画面左上
  posTopLeft: {
    left: 16,
    top: screenHeight > 750 ? 120 : 90,
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
  // 広告バナーの真上のラインを地面にして走るポジション
  posBannerRun: {
    position: 'absolute',
    left: 0,
    bottom: screenHeight > 750 ? 92 : 62, // 広告バナー（高さ50px + bottomPadding）の真上のヘリ
  },
  // バナー上ランナー専用サイズ（ちょこんと可愛いサイズ感）
  characterImageBannerRun: {
    width: 86,
    height: 86,
  },
  // バナー上ランナー用吹き出し
  speechBubbleBannerRun: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 4,
  },
  speechTextBannerRun: {
    fontSize: 11,
  },
  // 超巨大（画面いっぱい特大サイズ）
  characterImageHuge: {
    width: Math.min(330, screenWidth * 0.86),
    height: Math.min(330, screenWidth * 0.86),
  },
  // ラージサイズ（大迫力）
  characterImageLarge: {
    width: 220,
    height: 220,
  },
  // 標準サイズ（程よい中型）
  characterImageNormal: {
    width: 150,
    height: 150,
  },
  // ミニサイズ（ちょこんと小型）
  characterImageSmall: {
    width: 95,
    height: 95,
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
