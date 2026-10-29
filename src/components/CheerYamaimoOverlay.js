import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { StyleSheet, View, Image, Text, Animated, Dimensions, Easing, TouchableOpacity, Vibration } from 'react-native';
import { Audio } from 'expo-av';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

// やまいも登場サウンド一覧（効果音8割・レアボイス2割）
export const YAMAIMO_SOUNDS = {
  // 効果音（SE 8種）
  se_pop: require('../../assets/yamaimo_se_pop.wav'),           // ① ぽこっ（ウッドポップ）
  se_drop: require('../../assets/yamaimo_se_drop.wav'),         // ② ぴちょん（澄んだ水滴）
  se_step: require('../../assets/yamaimo_se_step.wav'),         // ④ ててっ（走る足音）
  se_supon: require('../../assets/yamaimo_se_supon.wav'),       // ⑪ すぽんっ（コルク抜け）
  se_deepdrop: require('../../assets/yamaimo_se_deepdrop.wav'), // ⑬ とぷん（まろやかな湧き水）
  se_kalimba: require('../../assets/yamaimo_se_kalimba.wav'),   // ⑭ ぽろん（カリンバ）
  se_koron: require('../../assets/yamaimo_se_koron.wav'),       // ⑮ ころん（木の実転がり）
  se_muni: require('../../assets/yamaimo_se_muni.wav'),         // ⑯ むにっ（低反発モチ）
  // レアボイス（3種 / 声のトーンA: 元気マスコット高め）
  voice_yahho: require('../../assets/yamaimo_voice_yahho.wav'), // ⑦ 「やっほ！」
  voice_n: require('../../assets/yamaimo_voice_n.wav'),         // ⑧ 「ん？」
  voice_doumo: require('../../assets/yamaimo_voice_doumo.wav'), // ⑰ 「あ、どうも」
};

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
  isEcoMode,
  isCheerSoundEnabled = true,
  playsInSilentMode = true,
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
  const soundRef = useRef(null);

  // アンマウント時に音声を確実に解放
  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
    };
  }, []);

  // やまいも登場サウンド再生（効果音8割・レアボイス2割、シーン連動）
  const playYamaimoSound = async ({ type, imageKey, position, sizeMode, isBannerRunner }) => {
    if (!isCheerSoundEnabled) return;

    try {
      // 効果音8割 (80%)、ボイス2割 (20%) の比率
      const isVoice = Math.random() < 0.20;
      let soundKey = null;

      if (isBannerRunner || sizeMode === 'banner-run') {
        // 走行シーン（バナー上ランナー）
        soundKey = isVoice ? 'voice_yahho' : 'se_step';
      } else if (sizeMode === 'huge' || imageKey === 'biroon') {
        // 超巨大化、びろ〜ん
        if (isVoice) {
          soundKey = Math.random() < 0.6 ? 'voice_n' : 'voice_yahho';
        } else {
          const pool = ['se_muni', 'se_supon', 'se_pop'];
          soundKey = pool[Math.floor(Math.random() * pool.length)];
        }
      } else if (
        imageKey === 'cake_taberu' || imageKey === 'coffee_dou' || 
        imageKey === 'suibun' || imageKey === 'iijan' || type === 'finish_success'
      ) {
        // 達成・ご褒美・差し入れシーン
        if (isVoice) {
          soundKey = 'voice_doumo';
        } else {
          const pool = ['se_kalimba', 'se_koron', 'se_deepdrop'];
          soundKey = pool[Math.floor(Math.random() * pool.length)];
        }
      } else if (
        imageKey === 'cake_tabetemasu' || imageKey === 'coffee_time' || 
        imageKey === 'pizza' || imageKey === 'karaage' || imageKey === 'orange' || imageKey === 'heeee'
      ) {
        // 食事・モグモグ・脱力シーン
        if (isVoice) {
          soundKey = Math.random() < 0.6 ? 'voice_doumo' : 'voice_n';
        } else {
          const pool = ['se_muni', 'se_koron', 'se_pop'];
          soundKey = pool[Math.floor(Math.random() * pool.length)];
        }
      } else if (
        type === 'overtime_start' || type === 'finish_overtime' ||
        imageKey === 'wakaruyo' || imageKey === 'fu' || imageKey === 'oyasumi'
      ) {
        // 超過・慰め・おやすみシーン
        if (isVoice) {
          soundKey = 'voice_doumo';
        } else {
          const pool = ['se_deepdrop', 'se_kalimba', 'se_pop'];
          soundKey = pool[Math.floor(Math.random() * pool.length)];
        }
      } else {
        // ひょっこり・チラッ・じー・見守り・通常出現シーン
        if (isVoice) {
          soundKey = Math.random() < 0.7 ? 'voice_n' : 'voice_yahho';
        } else {
          const pool = ['se_pop', 'se_supon', 'se_drop'];
          soundKey = pool[Math.floor(Math.random() * pool.length)];
        }
      }

      if (!soundKey || !YAMAIMO_SOUNDS[soundKey]) return;

      if (soundRef.current) {
        await soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }

      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: !!playsInSilentMode,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      const { sound: newSound } = await Audio.Sound.createAsync(
        YAMAIMO_SOUNDS[soundKey],
        { shouldPlay: true, volume: 0.85 }
      );
      soundRef.current = newSound;

      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) {
          newSound.unloadAsync().catch(() => {});
          if (soundRef.current === newSound) {
            soundRef.current = null;
          }
        }
      });

      await newSound.playAsync();
      console.log(`[CheerOverlay] Sound played successfully: ${soundKey}`);
    } catch (e) {
      console.log('[CheerOverlay] Yamaimo sound play error:', e);
    }
  };

  const isEnabled = isCheerModeEnabled && (!isEcoMode || isCheerInEcoEnabled);

  // 外部からのトリガー関数
  useImperativeHandle(ref, () => ({
    // trigger('setting' | 'prep' | 'running' | 'finish_success' | 'overtime_start' | 'finish_overtime')
    trigger: (type, chance = 0.6, options = {}) => {
      console.log(`[CheerOverlay] trigger called: type=${type}, chance=${chance}, isEnabled=${isEnabled} (cheer=${isCheerModeEnabled}, eco=${isEcoMode}, cheerInEco=${isCheerInEcoEnabled})`);
      if (!isEnabled) {
        console.log('[CheerOverlay] Ignored because isEnabled is false');
        return;
      }
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
        // 準備時間中（ウォームアップ・リラックス）
        // 約80%の高確率で「広告バナーの上をテクテク歩く」ウォーキング演出が発生！
        const isBannerWalker = Math.random() < 0.80;
        if (isBannerWalker) {
          position = 'banner-run';
          sizeMode = 'banner-run';
          hasSpeechBubble = true;

          // 5大ウォーキングパターンの抽選:
          // 0: walk_slow (のんびりお散歩)
          // 1: walk_stop_check (中央で立ち止まり確認)
          // 2: walk_stretch (準備体操・ウォーミングアップ)
          // 3: walk_countdown (カウントダウン連動歩行)
          // 4: walk_patrol (見回りパトロール)
          const walkPatterns = ['walk_slow', 'walk_stop_check', 'walk_stretch', 'walk_countdown', 'walk_patrol'];
          const walkPattern = walkPatterns[Math.floor(Math.random() * walkPatterns.length)];

          if (walkPattern === 'walk_stretch') {
            imageKey = Math.random() < 0.6 ? 'run_patapata' : 'run_hachimaki';
            const stretchMsgs = ['イチ、ニ、イチ、ニ！', '肩の力抜いて〜', 'ウォーミングアップ！', '準備バッチリ？'];
            speechText = stretchMsgs[Math.floor(Math.random() * stretchMsgs.length)];
            duration = 7000;
          } else if (walkPattern === 'walk_stop_check') {
            imageKey = Math.random() < 0.5 ? 'run_tokotoko' : 'run_shuchu';
            const checkMsgs = ['準備OK？', '道具そろった？', '深呼吸した？', 'よし、いけるね！', 'マイペースにいこ〜'];
            speechText = checkMsgs[Math.floor(Math.random() * checkMsgs.length)];
            duration = 8000;
          } else if (walkPattern === 'walk_countdown') {
            imageKey = Math.random() < 0.5 ? 'run_shuchu' : 'run_tokotoko';
            const cdMsgs = ['そろそろ始まるよ〜', 'カウントダウン中！', 'スタート準備！', 'トコトコ…'];
            speechText = cdMsgs[Math.floor(Math.random() * cdMsgs.length)];
            duration = 8000;
          } else if (walkPattern === 'walk_patrol') {
            imageKey = Math.random() < 0.5 ? 'run_tokotoko' : 'run_shuchu';
            const patrolMsgs = ['見回り中〜', '異常なし！', '準備中をお知らせします', '準備はいかが？'];
            speechText = patrolMsgs[Math.floor(Math.random() * patrolMsgs.length)];
            duration = 8000;
          } else {
            // walk_slow: のんびりお散歩
            const slowImages = ['run_tokotoko', 'run_patapata', 'run_shuchu'];
            imageKey = slowImages[Math.floor(Math.random() * slowImages.length)];
            const slowMsgs = ['準備準備〜♪', '深呼吸〜', 'リラックス♪', '落ち着いていこ〜', 'トコトコ…'];
            speechText = slowMsgs[Math.floor(Math.random() * slowMsgs.length)];
            duration = 8000;
          }

          showCharacter({
            imageKey,
            position,
            sizeMode,
            hasSpeechBubble,
            speechText,
            duration,
            runPattern: walkPattern,
            type,
            isBannerRunner: true,
            isBannerWalker: true,
            prepSeconds: options?.prepSeconds,
          });
          return;
        } else {
          // 残り20%は従来の準備中静止画（レア枠ケーキ、びろ〜ん、じー等）
          const isRare = Math.random() < 0.20;
          if (isRare) {
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
          duration = 15000;
        }
      } else if (type === 'idle') {
        // 待機中（保存完了後戻り、リセット後、待機放置中）
        // 約85%の高確率で「広告バナーの上をトコトコ歩く」ウォーキング演出が発生！
        const isBannerWalker = Math.random() < 0.85;
        const todayCount = Number(options?.todayCount) || 1;
        const prefix = `今日${todayCount}回目だよ！`;

        if (isBannerWalker) {
          position = 'banner-run';
          sizeMode = 'banner-run';
          hasSpeechBubble = true;

          let suffix = '';
          let walkPattern = 'walk_stop_check';

          if (todayCount >= 30) {
            // ステージ4: 30回超〜（超レア・心配＆気遣いモード）
            // 汗を飛ばして心配するトコトコ画像が最優先！
            imageKey = 'run_tokotoko';
            const lateCareMsgs = [
              'そろそろ今日は終わりにしない？',
              'さすがに頑張りすぎだよ〜！',
              '体壊しちゃうよ！休んで！',
              'もう十分すごいから！ね？',
              'やまいも、心配になってきた…',
              'お茶でも飲んでゆっくり休も？'
            ];
            suffix = lateCareMsgs[Math.floor(Math.random() * lateCareMsgs.length)];
            // 中央で立ち止まってしっかり心配を伝える
            walkPattern = Math.random() < 0.70 ? 'walk_stop_check' : 'walk_slow';
          } else if (todayCount >= 10) {
            // ステージ3: 10〜29回目（努力の鬼・リスペクト期）
            imageKey = Math.random() < 0.5 ? 'run_hachimaki' : 'run_shuchu';
            const zoneMsgs = [
              'すごい集中力だ…！',
              '努力の鬼だね！',
              '限界を超えていこう！',
              'やまいもも感動してるよ！',
              'どこまでもついていくよ！',
              '熱い魂を感じる…！'
            ];
            suffix = zoneMsgs[Math.floor(Math.random() * zoneMsgs.length)];
            walkPattern = ['walk_stop_check', 'walk_slow', 'walk_stretch'][Math.floor(Math.random() * 3)];
          } else if (todayCount >= 2) {
            // ステージ2: 2〜9回目（熱血・ノリノリ・決して諦めない）
            const midImages = ['run_shuchu', 'run_patapata', 'run_tokotoko', 'run_hachimaki'];
            imageKey = midImages[Math.floor(Math.random() * midImages.length)];
            const midMsgs = [
              'まだまだ行こうぜ！',
              '熱い感じで！',
              '決して諦めない！',
              'その調子でガンガンいこう！',
              'どんどん伸びてるよ！',
              'ナイス継続！次もファイト！'
            ];
            suffix = midMsgs[Math.floor(Math.random() * midMsgs.length)];
            walkPattern = ['walk_stop_check', 'walk_slow', 'walk_stretch', 'walk_patrol'][Math.floor(Math.random() * 4)];
          } else {
            // ステージ1: その日1回目（スタートダッシュ・気合入れ）
            const firstImages = ['run_tokotoko', 'run_shuchu', 'run_patapata'];
            imageKey = firstImages[Math.floor(Math.random() * firstImages.length)];
            const firstMsgs = [
              '気合い入れて頑張ろう！',
              '今日は何回やっちゃう？',
              'さあ、始めよう！',
              '今日もいい練習にしよ〜！',
              '今日もよろしくね！'
            ];
            suffix = firstMsgs[Math.floor(Math.random() * firstMsgs.length)];
            walkPattern = ['walk_stop_check', 'walk_slow', 'walk_stretch'][Math.floor(Math.random() * 3)];
          }

          speechText = `${prefix}\n${suffix}`;
          duration = 8000;

          showCharacter({
            imageKey,
            position,
            sizeMode,
            hasSpeechBubble,
            speechText,
            duration,
            runPattern: walkPattern,
            type,
            isBannerRunner: true,
            isBannerWalker: true,
          });
          return;
        } else {
          // 残り15%は待機中のレア静止画（ケーキ、コーヒー、チラッ、メイン見守り等）
          const rareImages = ['cake_tabetemasu', 'coffee_time', 'biroon', 'chiratto', 'main'];
          imageKey = rareImages[Math.floor(Math.random() * rareImages.length)];
          if (imageKey === 'main') {
            hasSpeechBubble = true;
            speechText = `${prefix}\n気合い入れていこう！`;
          } else if (imageKey === 'cake_tabetemasu') {
            hasSpeechBubble = true;
            speechText = 'あ、ケーキ食べてます';
          }
          if (sizeMode !== 'huge') {
            if (imageKey === 'chiratto') position = 'side-right';
            else if (imageKey === 'coffee_time') position = 'bottom-center';
            else if (imageKey === 'biroon') position = 'top-center';
            else position = 'bottom-right';
          }
          duration = 15000;
        }
      } else if (type === 'running') {
        // タイム中（タイム中専用の演出！）
        // 初回など options.forceBannerRunner 指定時は100%ランナー！
        // 通常時も約75%の高確率で「広告バナーの上を走る・焦ってウロウロする」ランナー演出が出現！
        const isBannerRunner = options?.forceBannerRunner ? true : (Math.random() < 0.75);
        const phase = options?.phase || 'mid'; // 'early' | 'mid' | 'late'

        if (isBannerRunner) {
          position = 'banner-run';
          sizeMode = 'banner-run';
          
          // 演出パターン抽選:
          // 序盤 (early): 爽やかな駆け抜け (left_to_right 50%, right_to_left 50%)、焦りウロウロは出さない
          // 中盤 (mid): 駆け抜け 80%, 焦りウロウロ 20%
          // 後半 (late): 駆け抜け 60%, 焦りウロウロ 40%（焦り演出を強化）
          const runRand = Math.random();
          let runnerType = 'left_to_right';
          if (phase === 'early') {
            runnerType = runRand < 0.50 ? 'left_to_right' : 'right_to_left';
          } else if (phase === 'late') {
            if (runRand < 0.25) {
              runnerType = 'left_to_right';
            } else if (runRand < 0.60) {
              runnerType = 'right_to_left';
            } else {
              runnerType = 'pacing';
            }
          } else {
            if (runRand < 0.40) {
              runnerType = 'left_to_right';
            } else if (runRand < 0.80) {
              runnerType = 'right_to_left';
            } else {
              runnerType = 'pacing';
            }
          }

          if (runnerType === 'pacing') {
            // 左右焦りウロウロ: 汗かきトコトコやハチマキが超マッチ！
            const pacingImages = ['run_tokotoko', 'run_hachimaki', 'run_patapata'];
            imageKey = pacingImages[Math.floor(Math.random() * pacingImages.length)];
            hasSpeechBubble = true;
            if (phase === 'late') {
              const latePacingMsgs = ['焦る焦る！', 'あわわ…！', 'ど、どうしよう〜！', 'あと少し！', 'ラストスパート！'];
              speechText = latePacingMsgs[Math.floor(Math.random() * latePacingMsgs.length)];
            } else {
              const midPacingMsgs = ['落ち着いて〜！', '集中、集中！', 'ど、どうしよう〜！', 'あわわ…！'];
              speechText = midPacingMsgs[Math.floor(Math.random() * midPacingMsgs.length)];
            }
            duration = 9000;
          } else {
            // left_to_right または right_to_left の駆け抜け
            const runImages = ['run_tokotoko', 'run_patapata', 'run_shuchu', 'run_hachimaki'];
            imageKey = runImages[Math.floor(Math.random() * runImages.length)];
            hasSpeechBubble = Math.random() < 0.85; // ランナーはメッセージを基本表示

            if (phase === 'early') {
              // 序盤（スタート直後・初回確定演出）: 「スタート！」「ファイト〜！」「頑張ろう！」等
              // ※「その調子！」は除外、「あと少し！」「急げ急げ〜！」も除外
              const earlyMsgs = ['スタート！', 'ファイト〜！', '頑張ろう！', 'トコトコ…', '通りま〜す！'];
              speechText = earlyMsgs[Math.floor(Math.random() * earlyMsgs.length)];
            } else if (phase === 'mid') {
              // 中盤（進行中）: 「その調子！」（中盤専用）、「落ち着いて〜！」「順調、順調！」等
              const midMsgs = ['その調子！', '落ち着いて〜！', '順調、順調！', '集中、集中！', 'ファイト！', 'トコトコ…'];
              speechText = midMsgs[Math.floor(Math.random() * midMsgs.length)];
            } else {
              // 後半（ラストスパート）: 「あと少し！」（後半専用）、「急げ急げ〜！」「ラストスパート！」等
              const lateMsgs = ['あと少し！', '急げ急げ〜！', 'ラストスパート！', '最後まで！', 'ファイト！'];
              speechText = lateMsgs[Math.floor(Math.random() * lateMsgs.length)];
            }
            duration = 4500;
          }

          showCharacter({ 
            imageKey, 
            position, 
            sizeMode, 
            hasSpeechBubble, 
            speechText, 
            duration,
            runPattern: runnerType,
            type,
            isBannerRunner: true,
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
              if (phase === 'early') {
                // 序盤: 「その調子！」「あと少し！」は出さず、前向きなスタート応援
                const earlyMainMsgs = ['頑張ろう！', 'ファイト〜！', '集中、集中！', 'やまいもが見守ってるよ！', '焦らず丁寧に！'];
                speechText = earlyMainMsgs[Math.floor(Math.random() * earlyMainMsgs.length)];
              } else if (phase === 'late') {
                // 後半: 「あと少し！」「ラストスパート！」等
                const lateMainMsgs = ['あと少し！', '最後まで！', 'ラストスパート！', 'ファイト〜！', '頑張ろう！'];
                speechText = lateMainMsgs[Math.floor(Math.random() * lateMainMsgs.length)];
              } else {
                speechText = CHEER_MESSAGES[Math.floor(Math.random() * CHEER_MESSAGES.length)];
              }
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

      showCharacter({ imageKey, position, sizeMode, hasSpeechBubble, speechText, duration, type, isBannerRunner: false });
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
    runPattern = null,
    type = 'running',
    isBannerRunner = false,
    isBannerWalker = false,
    prepSeconds = null,
  }) => {
    // 登場サウンドを再生（効果音8割・レアボイス2割、シーン連動）
    playYamaimoSound({ type, imageKey, position, sizeMode, isBannerRunner });

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

    console.log('[CheerOverlay] Character showing:', { imageKey, position, sizeMode, runPattern, isBannerWalker });
    setActiveItem({ imageKey, position, sizeMode, hasSpeechBubble, speechText, runPattern });

    // 広告バナー上ランナー・ウォーキング演出の場合の専用アニメーション
    if (position === 'banner-run') {
      const bobDuration = isBannerWalker ? 220 : 110; // 歩く時はゆったり220ms、走る時は軽快110ms
      const bobHeight = isBannerWalker ? -5 : -7;

      const startBobbing = () => {
        if (bounceAnimRef.current) bounceAnimRef.current.stop();
        bounceAnimRef.current = Animated.loop(
          Animated.sequence([
            Animated.timing(animBounceY, {
              toValue: bobHeight,
              duration: bobDuration,
              easing: Easing.linear,
              useNativeDriver: true,
            }),
            Animated.timing(animBounceY, {
              toValue: 0,
              duration: bobDuration,
              easing: Easing.linear,
              useNativeDriver: true,
            }),
          ])
        );
        bounceAnimRef.current.start();
      };

      startBobbing();

      animScale.setValue(1);
      animRotate.setValue(0);
      animTranslateY.setValue(0);

      if (isBannerWalker) {
        // ---- 準備中・待機中ウォーキング専用アニメーション ----
        animFlipX.setValue(1); // 基本右向き
        animOpacity.setValue(1);

        if (runPattern === 'walk_stop_check') {
          // パターン② 立ち止まり確認:
          // 左から中央へ歩く (2300ms) → 中央でピタッと立ち止まる (2400ms) → 右へ歩き去る (2300ms)
          const midX = screenWidth * 0.38;
          animTranslateX.setValue(-80);

          runningAnimRef.current = Animated.timing(animTranslateX, {
            toValue: midX,
            duration: 2300,
            easing: Easing.linear,
            useNativeDriver: true,
          });

          runningAnimRef.current.start(({ finished }) => {
            if (!finished) return;
            // 中央到着: ボビングを停止してピタッと静止（吹き出しをじっくり読ませる）
            if (bounceAnimRef.current) {
              bounceAnimRef.current.stop();
              bounceAnimRef.current = null;
            }
            animBounceY.setValue(0);

            setTimeout(() => {
              // 立ち止まり終了: 再びボビング開始して右外へ歩き去る
              startBobbing();
              runningAnimRef.current = Animated.timing(animTranslateX, {
                toValue: screenWidth + 80,
                duration: 2300,
                easing: Easing.linear,
                useNativeDriver: true,
              });

              runningAnimRef.current.start(({ finished: f2 }) => {
                if (f2) dismissCharacter(false);
              });
            }, 2400);
          });
        } else if (runPattern === 'walk_patrol') {
          // パターン⑤ 見回りパトロール:
          // 歩く (1700ms) → 少し立ち止まる (600ms) → 歩く (1700ms) → 少し立ち止まる (600ms) → 画面外へ (1700ms)
          animTranslateX.setValue(-80);
          runningAnimRef.current = Animated.timing(animTranslateX, {
            toValue: screenWidth * 0.28,
            duration: 1700,
            easing: Easing.linear,
            useNativeDriver: true,
          });

          runningAnimRef.current.start(({ finished }) => {
            if (!finished) return;
            if (bounceAnimRef.current) {
              bounceAnimRef.current.stop();
              bounceAnimRef.current = null;
            }
            animBounceY.setValue(0);

            setTimeout(() => {
              startBobbing();
              runningAnimRef.current = Animated.timing(animTranslateX, {
                toValue: screenWidth * 0.62,
                duration: 1700,
                easing: Easing.linear,
                useNativeDriver: true,
              });

              runningAnimRef.current.start(({ finished: f2 }) => {
                if (!f2) return;
                if (bounceAnimRef.current) {
                  bounceAnimRef.current.stop();
                  bounceAnimRef.current = null;
                }
                animBounceY.setValue(0);

                setTimeout(() => {
                  startBobbing();
                  runningAnimRef.current = Animated.timing(animTranslateX, {
                    toValue: screenWidth + 80,
                    duration: 1700,
                    easing: Easing.linear,
                    useNativeDriver: true,
                  });

                  runningAnimRef.current.start(({ finished: f3 }) => {
                    if (f3) dismissCharacter(false);
                  });
                }, 600);
              });
            }, 600);
          });
        } else {
          // パターン① walk_slow (のんびりお散歩: 7500ms)
          // パターン③ walk_stretch (体操ウォーク: 6500ms)
          // パターン④ walk_countdown (カウントダウン連動歩行)
          let walkDuration = 7500;
          if (runPattern === 'walk_stretch') {
            walkDuration = 6500;
          } else if (runPattern === 'walk_countdown') {
            walkDuration = prepSeconds ? Math.min(Math.max(prepSeconds * 850, 4500), 9000) : 7500;
          }

          animTranslateX.setValue(-80);
          runningAnimRef.current = Animated.timing(animTranslateX, {
            toValue: screenWidth + 80,
            duration: walkDuration,
            easing: Easing.linear,
            useNativeDriver: true,
          });

          runningAnimRef.current.start(({ finished }) => {
            if (finished) dismissCharacter(false);
          });
        }
      } else {
        // ---- タイム中ランナー（走る演出）----
        if (runPattern === 'left_to_right') {
          // 1. 左から右へ駆け抜け（初期位置-80から即座に画面内に進入）
          animFlipX.setValue(1); // 右向き
          animTranslateX.setValue(-80);
          animOpacity.setValue(1);

          runningAnimRef.current = Animated.timing(animTranslateX, {
            toValue: screenWidth + 80,
            duration: 4000,
            easing: Easing.linear,
            useNativeDriver: true,
          });

          runningAnimRef.current.start(({ finished }) => {
            if (finished) dismissCharacter(false);
          });
        } else if (runPattern === 'right_to_left') {
          // 2. 右から左へ駆け抜け（初期位置screenWidth + 80から即座に画面内に進入）
          animFlipX.setValue(-1); // 左向きに反転
          animTranslateX.setValue(screenWidth + 80);
          animOpacity.setValue(1);

          runningAnimRef.current = Animated.timing(animTranslateX, {
            toValue: -80,
            duration: 4000,
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

          // 1. フェードインしながら右へ小走り
          Animated.parallel([
            Animated.timing(animOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
            Animated.timing(animTranslateX, {
              toValue: screenWidth * 0.65,
              duration: 1200,
              easing: Easing.linear,
              useNativeDriver: true,
            }),
          ]).start(({ finished }) => {
            if (!finished) return;
            // 2. ちょっと立ち止まった後、左向きに反転して左へ小走り
            setTimeout(() => {
              animFlipX.setValue(-1);
              Animated.timing(animTranslateX, {
                toValue: screenWidth * 0.15,
                duration: 1400,
                easing: Easing.linear,
                useNativeDriver: true,
              }).start(({ finished: f2 }) => {
                if (!f2) return;
                // 3. ちょっと立ち止まった後、右向きに反転して右へ小走り
                setTimeout(() => {
                  animFlipX.setValue(1);
                  Animated.timing(animTranslateX, {
                    toValue: screenWidth * 0.60,
                    duration: 1100,
                    easing: Easing.linear,
                    useNativeDriver: true,
                  }).start(({ finished: f3 }) => {
                    if (!f3) return;
                    // 4. 左向きに反転して画面外へ駆け去る
                    animFlipX.setValue(-1);
                    Animated.timing(animTranslateX, {
                      toValue: -130,
                      duration: 1200,
                      easing: Easing.in(Easing.quad),
                      useNativeDriver: true,
                    }).start(({ finished: f4 }) => {
                      if (f4) dismissCharacter(false);
                    });
                  });
                }, 180);
              });
            }, 180);
          });
        }
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
  // バナー上ランナー・ウォーキング用吹き出し
  speechBubbleBannerRun: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    marginBottom: 4,
    maxWidth: 220,
  },
  speechTextBannerRun: {
    fontSize: 11,
    lineHeight: 15,
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
