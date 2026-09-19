import React, { useState, useEffect, useRef, useContext } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Modal, TextInput, Alert, ScrollView, Switch, Animated, TouchableWithoutFeedback, Image, FlatList, Dimensions, AppState, Vibration, LayoutAnimation } from 'react-native';
const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
import { useIsFocused } from '@react-navigation/native';
import ImageViewer from 'react-native-image-zoom-viewer';
import AsyncStorage from '@react-native-async-storage/async-storage';
// 必要なモジュールのインポート
import { Audio } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import RingProgress from '../components/RingProgress';
import { AppContext } from '../utils/AppContext';
import { saveRecord, getRecords } from '../utils/recordStorage';
import AdBannerComponent from '../components/AdBannerComponent';
import ProSubscriptionModal from '../components/ProSubscriptionModal';

const ALARM_SOUNDS = {
  kitchen: require('../../assets/alarm_kitchen.wav'),
  fast: require('../../assets/alarm_fast.wav'),
  digital: require('../../assets/alarm_digital.wav'),
  buzzer: require('../../assets/alarm_buzzer.wav'),
  bell: require('../../assets/alarm_bell.wav'),
  gong: require('../../assets/alarm_gong.wav'),
};

const VOICE_SOUNDS = {
  // タイマー計測中用
  v_5min: require('../../assets/voice_5min.wav'),
  v_3min: require('../../assets/voice_3min.wav'),
  v_1min: require('../../assets/voice_1min.wav'),
  v_30sec: require('../../assets/voice_30sec.wav'),
  v_10sec: require('../../assets/voice_10sec.wav'),
  v_finish: require('../../assets/voice_finish.wav'),
  // スタート前コール（開始時：計測開始、〜）
  prep_start_15min: require('../../assets/voice_prep_start_15min.wav'),
  prep_start_10min: require('../../assets/voice_prep_start_10min.wav'),
  prep_start_5min: require('../../assets/voice_prep_start_5min.wav'),
  prep_start_3min: require('../../assets/voice_prep_start_3min.wav'),
  prep_start_1min: require('../../assets/voice_prep_start_1min.wav'),
  prep_start_30sec: require('../../assets/voice_prep_start_30sec.wav'),
  prep_start_10sec: require('../../assets/voice_prep_start_10sec.wav'),
  prep_start_generic: require('../../assets/voice_prep_start_generic.wav'),
  // スタート前コール（途中経過：〜前）
  prep_15min: require('../../assets/voice_prep_15min.wav'),
  prep_10min: require('../../assets/voice_prep_10min.wav'),
  prep_5min: require('../../assets/voice_prep_5min.wav'),
  prep_4min: require('../../assets/voice_prep_4min.wav'),
  prep_3min: require('../../assets/voice_prep_3min.wav'),
  prep_2min: require('../../assets/voice_prep_2min.wav'),
  prep_1min: require('../../assets/voice_prep_1min.wav'),
  prep_30sec: require('../../assets/voice_prep_30sec.wav'),
  prep_10sec: require('../../assets/voice_prep_10sec.wav'),
  // スタート前コール（直前カウントダウン）
  prep_countdown_5: require('../../assets/voice_prep_countdown_5.wav'),
  // カウントアップ（超過時間）コール
  over_start: require('../../assets/voice_over_start.wav'),
  over_1min: require('../../assets/voice_over_1min.wav'),
  over_3min: require('../../assets/voice_over_3min.wav'),
  over_5min: require('../../assets/voice_over_5min.wav'),
  over_10min: require('../../assets/voice_over_10min.wav'),
  over_15min: require('../../assets/voice_over_15min.wav'),
};

export default function HomeScreen({ navigation }) {
  const DEFAULT_SECONDS = 180; // モック: 3分のテスト用
  const [targetTime, setTargetTime] = useState(DEFAULT_SECONDS);
  const [remainingTime, setRemainingTime] = useState(DEFAULT_SECONDS);
  const [isRunning, setIsRunning] = useState(false);
  const [isCountUp, setIsCountUp] = useState(false);
  const [sound, setSound] = useState(null);
  const [voiceSound, setVoiceSound] = useState(null);

  // 記録・保存用State
  const [saveModalVisible, setSaveModalVisible] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [savedCategories, setSavedCategories] = useState(['カット', 'カラー', 'ワインディング', 'アップスタイル']);
  const [lastUsedCategory, setLastUsedCategory] = useState('');
  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [photoUris, setPhotoUris] = useState([]);
  const [fullScreenIndex, setFullScreenIndex] = useState(null);
  const [forceTargetTime, setForceTargetTime] = useState(false);
  const [selectedTags, setSelectedTags] = useState([]);

  const DEFAULT_TAGS = ['お気に入り', 'タイム'];

  // 時間設定モーダル用State
  const [timeModalVisible, setTimeModalVisible] = useState(false);
  const [timeModalMode, setTimeModalMode] = useState('time'); // 'time' or 'countdown'
  const [manualInputMinStr, setManualInputMinStr] = useState('');
  const [manualInputSecStr, setManualInputSecStr] = useState('');
  const [timeModalKeypadActive, setTimeModalKeypadActive] = useState(null); // 'min' | 'sec' | null
  const [countdownKeypadActive, setCountdownKeypadActive] = useState(null); // 'min' | 'sec' | null
  const [isKeypadNewInput, setIsKeypadNewInput] = useState(true);
  const DEFAULT_FAVORITE_TIMES = [60, 180, 300, 600, 900, 1200, 1800, 3600, 5400]; // 1, 3, 5, 10, 15, 20, 30, 60, 90分 (秒数)
  const [favoriteTimes, setFavoriteTimes] = useState(DEFAULT_FAVORITE_TIMES);
  const [isFavoritesOpen, setIsFavoritesOpen] = useState(false); // お気に入りアコーディオン開閉（黄色）
  const [isEditingFavorites, setIsEditingFavorites] = useState(false);
  const favScrollY = useRef(new Animated.Value(0)).current;
  const [favContentHeight, setFavContentHeight] = useState(1);
  const [favContainerHeight, setFavContainerHeight] = useState(1);

  // 準備時間のお気に入り用State
  const DEFAULT_COUNTDOWN_FAVORITES = [0, 5, 10, 30, 60, 180, 300, 600, 900]; // 0=無し, 5秒, 10秒, 30秒, 1分, 3分, 5分, 10分, 15分
  const [countdownFavoriteTimes, setCountdownFavoriteTimes] = useState(DEFAULT_COUNTDOWN_FAVORITES);
  const [isCountdownFavoritesOpen, setIsCountdownFavoritesOpen] = useState(true); // 準備時間お気に入りアコーディオン開閉（黄色）
  const [isEditingCountdownFavorites, setIsEditingCountdownFavorites] = useState(false);
  const countdownFavScrollY = useRef(new Animated.Value(0)).current;
  const [countdownFavContentHeight, setCountdownFavContentHeight] = useState(1);
  const [countdownFavContainerHeight, setCountdownFavContainerHeight] = useState(1);
  const [addFavTarget, setAddFavTarget] = useState('time'); // 'time' or 'countdown'

  const [addFavModalVisible, setAddFavModalVisible] = useState(false);
  const [newFavMinStr, setNewFavMinStr] = useState('0');
  const [newFavSecStr, setNewFavSecStr] = useState('0');
  const [addFavKeypadActive, setAddFavKeypadActive] = useState('min'); // 'min' | 'sec'
  const [isAddFavNewInput, setIsAddFavNewInput] = useState(true);

  // 準備時間入力用State
  const [countdownInputMinStr, setCountdownInputMinStr] = useState('');
  const [countdownInputSecStr, setCountdownInputSecStr] = useState('');
  const [proModalVisible, setProModalVisible] = useState(false);

  const { 
    isEcoMode, toggleEcoMode, isProMode, isColorIndicator, 
    isCountdownEnabled, toggleCountdownEnabled, 
    countdownSeconds, saveCountdownSeconds,
    alarmSoundType, playsInSilentMode,
    isAlarmSoundEnabled, toggleAlarmSoundEnabled,
    isVoiceMasterEnabled, toggleVoiceMasterEnabled,
    isCountUpEnabled, toggleCountUpEnabled,
    isVibrationEnabled, isVibration3SecOnly,
    vibrationIntensity,
    isVibPrepEnabled, isVibWarningEnabled,
    isVibFinishEnabled, isVibOvertimeEnabled,
    isVoice5MinEnabled, isVoice3MinEnabled,
    isVoice1MinEnabled, isVoice30SecEnabled,
    isVoice10SecEnabled, isVoiceFinishEnabled,
    isPrepVoice15MinEnabled, isPrepVoice10MinEnabled,
    isPrepVoice5MinEnabled, isPrepVoice4MinEnabled,
    isPrepVoice3MinEnabled, isPrepVoice2MinEnabled,
    isPrepVoice1MinEnabled, isPrepVoice30SecEnabled,
    isPrepVoice10SecEnabled, isPrepVoiceCountdownEnabled,
    isOverVoiceStartEnabled, isOverVoice1MinEnabled,
    isOverVoice3MinEnabled, isOverVoice5MinEnabled,
    isOverVoice10MinEnabled, isOverVoice15MinEnabled,
    isEcoNavActiveDot,
    isEcoIndicatorEnabled,
    isNormalIndicatorEnabled,
    controlsOpacity,
    controlsVisible,
    showControls,
    resetControlsVisible
  } = useContext(AppContext);
  
  const isFocused = useIsFocused();

  // スタート前カウントダウン用State
  const [isPreCountingDown, setIsPreCountingDown] = useState(false);
  const [preCountdownTime, setPreCountdownTime] = useState(0);

  const timerRef = useRef(null);
  const targetEndTimeRef = useRef(null);
  const prepEndTimeRef = useRef(null);
  const overStartTimeRef = useRef(null);
  const remainingTimeRef = useRef(DEFAULT_SECONDS);
  const preCountdownTimeRef = useRef(0);
  const isRunningRef = useRef(false);
  const isCountUpRef = useRef(false);
  const isPreCountingDownRef = useRef(false);
  const triggeredVoicesRef = useRef(new Set());
  const triggeredPrepVoicesRef = useRef(new Set());
  const triggeredOverVoicesRef = useRef(new Set());
  const vibrationTimeoutRef = useRef(null);

  // バイブレーション制御ヘルパー（強度およびタイミング個別設定対応）
  const triggerVibration = (type) => {
    if (!isVibrationEnabled) return;
    try {
      if (type === 'finish') {
        if (!isVibFinishEnabled) return;
        if (vibrationTimeoutRef.current) {
          clearTimeout(vibrationTimeoutRef.current);
          vibrationTimeoutRef.current = null;
        }
        let pattern;
        if (vibrationIntensity === 'strong') {
          pattern = [0, 800, 150, 800, 150, 800]; // 激しい強力パルス
        } else if (vibrationIntensity === 'gentle') {
          pattern = [0, 250, 250, 250, 250, 250]; // 控えめ
        } else {
          pattern = [0, 500, 200, 500, 200, 500]; // 標準
        }

        if (isVibration3SecOnly) {
          // 3秒間だけ振動して自動停止
          Vibration.vibrate(pattern);
          vibrationTimeoutRef.current = setTimeout(() => {
            Vibration.cancel();
            vibrationTimeoutRef.current = null;
          }, 3000);
        } else {
          // 停止操作があるまでリピート継続
          Vibration.vibrate(pattern, true);
        }
      } else if (type === 'warning') {
        if (!isVibWarningEnabled) return;
        // 残り時間警告（2回パルス）
        if (vibrationIntensity === 'strong') {
          Vibration.vibrate([0, 350, 120, 350]);
        } else if (vibrationIntensity === 'gentle') {
          Vibration.vibrate([0, 100, 100, 100]);
        } else {
          Vibration.vibrate([0, 200, 100, 200]);
        }
      } else if (type === 'prep') {
        if (!isVibPrepEnabled) return;
        // 準備時間コール時の振動
        if (vibrationIntensity === 'strong') {
          Vibration.vibrate([0, 300, 120, 300]);
        } else if (vibrationIntensity === 'gentle') {
          Vibration.vibrate(80);
        } else {
          Vibration.vibrate([0, 150, 80, 150]);
        }
      } else if (type === 'countdown') {
        // カウントダウン微振動（5,4,3,2,1）
        const dur = vibrationIntensity === 'strong' ? 150 : (vibrationIntensity === 'gentle' ? 40 : 80);
        Vibration.vibrate(dur);
      } else if (type === 'overtime') {
        if (!isVibOvertimeEnabled) return;
        // 超過時間コール時の振動
        if (vibrationIntensity === 'strong') {
          Vibration.vibrate([0, 400, 120, 400]);
        } else if (vibrationIntensity === 'gentle') {
          Vibration.vibrate([0, 100, 100, 100]);
        } else {
          Vibration.vibrate([0, 200, 100, 200]);
        }
      }
    } catch (e) {
      console.log("Vibration trigger error", e);
    }
  };

  const cancelVibration = () => {
    if (vibrationTimeoutRef.current) {
      clearTimeout(vibrationTimeoutRef.current);
      vibrationTimeoutRef.current = null;
    }
    try {
      Vibration.cancel();
    } catch (e) {}
  };

  // 初回起動時のサウンドロード等と再生用関数
  const playAlarm = async () => {
    triggerVibration('finish');
    if (!isAlarmSoundEnabled || alarmSoundType === 'none') {
      console.log('Alarm sound is muted or set to none (silent)');
      return;
    }
    try {
      console.log('Play Alarm trigger: 0 seconds reached');
      if (sound) {
        await sound.unloadAsync();
      }
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: playsInSilentMode,
        shouldDuckAndroid: true,
      });
      const soundFile = ALARM_SOUNDS[alarmSoundType] || ALARM_SOUNDS.digital;
      const { sound: newSound } = await Audio.Sound.createAsync(soundFile);
      setSound(newSound);
      await newSound.playAsync();
    } catch (e) {
      console.log("Audio play error", e);
    }
  };

  const playVoice = async (key) => {
    if (!isVoiceMasterEnabled) {
      console.log('Voice announcement is muted by master switch');
      return;
    }
    try {
      if (voiceSound) {
        await voiceSound.unloadAsync();
      }
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: playsInSilentMode,
        shouldDuckAndroid: true,
      });
      const soundFile = VOICE_SOUNDS[key];
      if (!soundFile) return;
      const { sound: newVoice } = await Audio.Sound.createAsync(soundFile);
      setVoiceSound(newVoice);
      await newVoice.playAsync();
    } catch (e) {
      console.log("Voice play error", e);
    }
  };

  useEffect(() => {
    return sound ? () => sound.unloadAsync() : undefined;
  }, [sound]);

  useEffect(() => {
    return voiceSound ? () => voiceSound.unloadAsync() : undefined;
  }, [voiceSound]);

  useEffect(() => {
    return () => {
      cancelVibration();
    };
  }, []);

  // ジャンル履歴のロード
  useEffect(() => {
    const loadCategoryData = async () => {
      try {
        const storedCategories = await AsyncStorage.getItem('savedCategories');
        if (storedCategories) {
          const parsed = JSON.parse(storedCategories);
          // 新しいデフォルトを確実に追加するためマージして重複排除する
          const merged = Array.from(new Set(['カット', 'カラー', 'ワインディング', 'アップスタイル', ...parsed]));
          setSavedCategories(merged);
        }

        const lastCat = await AsyncStorage.getItem('lastUsedCategory');
        if (lastCat) {
          setLastUsedCategory(lastCat);
          // 初期状態としてセット
          setSelectedCategory(lastCat);
        }

        // お気に入りタイマー時間のロード
        const storedFavs = await AsyncStorage.getItem('@timer_favorite_times');
        if (storedFavs) {
          const parsedFavs = JSON.parse(storedFavs);
          if (Array.isArray(parsedFavs) && parsedFavs.length > 0) {
            setFavoriteTimes(parsedFavs);
          }
        }

        // お気に入りアコーディオン開閉状態のロード（初期値: false でコンパクトに表示）
        const storedAccordion = await AsyncStorage.getItem('@timer_favorites_accordion_open');
        if (storedAccordion !== null) {
          setIsFavoritesOpen(JSON.parse(storedAccordion));
        }

        // 準備時間のお気に入りロード
        const storedCountdownFavs = await AsyncStorage.getItem('@timer_countdown_favorite_times');
        if (storedCountdownFavs) {
          const parsed = JSON.parse(storedCountdownFavs);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setCountdownFavoriteTimes(parsed);
          }
        }

        // 準備時間お気に入りアコーディオン開閉状態のロード
        const storedCountdownAccordion = await AsyncStorage.getItem('@timer_countdown_favorites_accordion_open');
        if (storedCountdownAccordion !== null) {
          setIsCountdownFavoritesOpen(JSON.parse(storedCountdownAccordion));
        }
      } catch (e) {
        console.error("Failed to load category or favorites data", e);
      }
    };
    loadCategoryData();
  }, []);

  // Stateと同期するRefの更新
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    isCountUpRef.current = isCountUp;
  }, [isCountUp]);

  useEffect(() => {
    isPreCountingDownRef.current = isPreCountingDown;
  }, [isPreCountingDown]);

  useEffect(() => {
    remainingTimeRef.current = remainingTime;
  }, [remainingTime]);

  useEffect(() => {
    preCountdownTimeRef.current = preCountdownTime;
  }, [preCountdownTime]);

  // バックグラウンド・スリープ復帰（AppState）検知時のタイムスタンプ即時同期
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'active') {
        const now = Date.now();
        if (isPreCountingDownRef.current && prepEndTimeRef.current) {
          const diffMs = prepEndTimeRef.current - now;
          const nextPrep = Math.max(0, Math.ceil(diffMs / 1000));
          preCountdownTimeRef.current = nextPrep;
          setPreCountdownTime(nextPrep);

          if (diffMs <= 0) {
            setIsPreCountingDown(false);
            prepEndTimeRef.current = null;
            // 準備カウント終了、本番タイマー開始
            const newTargetEnd = now + targetTime * 1000;
            targetEndTimeRef.current = newTargetEnd;
            triggeredVoicesRef.current.clear();
            remainingTimeRef.current = targetTime;
            setRemainingTime(targetTime);
            setIsRunning(true);
          }
        } else if (isRunningRef.current) {
          if (!isCountUpRef.current && targetEndTimeRef.current) {
            const diffMs = targetEndTimeRef.current - now;
            const nextTime = Math.max(0, Math.ceil(diffMs / 1000));

            if (diffMs <= 0) {
              if (!triggeredVoicesRef.current.has('alarm')) {
                triggeredVoicesRef.current.add('alarm');
                playAlarm();
              }
              if (isCountUpEnabled) {
                isCountUpRef.current = true;
                setIsCountUp(true);
                overStartTimeRef.current = targetEndTimeRef.current;
                triggeredOverVoicesRef.current.clear();
                const overTime = Math.max(0, Math.floor((now - targetEndTimeRef.current) / 1000));
                remainingTimeRef.current = overTime;
                setRemainingTime(overTime);
              } else {
                isCountUpRef.current = false;
                setIsCountUp(false);
                isRunningRef.current = false;
                setIsRunning(false);
                targetEndTimeRef.current = null;
                overStartTimeRef.current = null;
                remainingTimeRef.current = 0;
                setRemainingTime(0);
                resetControlsVisible();
              }
            } else {
              remainingTimeRef.current = nextTime;
              setRemainingTime(nextTime);
            }
          } else if (isCountUpRef.current && overStartTimeRef.current) {
            const overTime = Math.max(0, Math.floor((now - overStartTimeRef.current) / 1000));
            remainingTimeRef.current = overTime;
            setRemainingTime(overTime);
          }
        }
      }
    });

    return () => {
      subscription.remove();
    };
  }, [targetTime]);

  // 準備カウントダウン進行のロジック（タイムスタンプ基準）
  useEffect(() => {
    let interval;
    if (isPreCountingDown) {
      if (!prepEndTimeRef.current) {
        prepEndTimeRef.current = Date.now() + preCountdownTimeRef.current * 1000;
      }
      interval = setInterval(() => {
        const now = Date.now();
        const diffMs = prepEndTimeRef.current - now;
        const nextTime = Math.max(0, Math.ceil(diffMs / 1000));

        if (nextTime !== preCountdownTimeRef.current) {
          preCountdownTimeRef.current = nextTime;
          setPreCountdownTime(nextTime);
        }

        // カウント進行中の経過コール
        if (nextTime === 900 && countdownSeconds > 900 && isPrepVoice15MinEnabled && !triggeredPrepVoicesRef.current.has(900)) {
          triggeredPrepVoicesRef.current.add(900);
          playVoice('prep_15min');
        } else if (nextTime === 600 && countdownSeconds > 600 && isPrepVoice10MinEnabled && !triggeredPrepVoicesRef.current.has(600)) {
          triggeredPrepVoicesRef.current.add(600);
          playVoice('prep_10min');
        } else if (nextTime === 300 && countdownSeconds > 300 && isPrepVoice5MinEnabled && !triggeredPrepVoicesRef.current.has(300)) {
          triggeredPrepVoicesRef.current.add(300);
          playVoice('prep_5min');
        } else if (nextTime === 240 && countdownSeconds > 240 && isPrepVoice4MinEnabled && !triggeredPrepVoicesRef.current.has(240)) {
          triggeredPrepVoicesRef.current.add(240);
          playVoice('prep_4min');
        } else if (nextTime === 180 && countdownSeconds > 180 && isPrepVoice3MinEnabled && !triggeredPrepVoicesRef.current.has(180)) {
          triggeredPrepVoicesRef.current.add(180);
          playVoice('prep_3min');
        } else if (nextTime === 120 && countdownSeconds > 120 && isPrepVoice2MinEnabled && !triggeredPrepVoicesRef.current.has(120)) {
          triggeredPrepVoicesRef.current.add(120);
          playVoice('prep_2min');
        } else if (nextTime === 60 && countdownSeconds > 60 && isPrepVoice1MinEnabled && !triggeredPrepVoicesRef.current.has(60)) {
          triggeredPrepVoicesRef.current.add(60);
          playVoice('prep_1min');
        } else if (nextTime === 30 && countdownSeconds > 30 && isPrepVoice30SecEnabled && !triggeredPrepVoicesRef.current.has(30)) {
          triggeredPrepVoicesRef.current.add(30);
          playVoice('prep_30sec');
        } else if (nextTime === 10 && countdownSeconds > 10 && isPrepVoice10SecEnabled && !triggeredPrepVoicesRef.current.has(10)) {
          triggeredPrepVoicesRef.current.add(10);
          playVoice('prep_10sec');
          triggerVibration('prep');
        } else if (nextTime === 5 && countdownSeconds > 5 && isPrepVoiceCountdownEnabled && !triggeredPrepVoicesRef.current.has(5)) {
          triggeredPrepVoicesRef.current.add(5);
          playVoice('prep_countdown_5'); // 5秒前から「5,4,3,2,1 スタート！」
          triggerVibration('countdown');
        }

        if (diffMs <= 0) {
          clearInterval(interval);
          prepEndTimeRef.current = null;
          setIsPreCountingDown(false);
          // カウントダウン終了後、メインタイマー開始
          targetEndTimeRef.current = now + targetTime * 1000;
          triggeredVoicesRef.current.clear();
          remainingTimeRef.current = targetTime;
          setRemainingTime(targetTime);
          setIsRunning(true);
        }
      }, 250);
    } else {
      prepEndTimeRef.current = null;
    }
    return () => clearInterval(interval);
  }, [
    isPreCountingDown, countdownSeconds, targetTime,
    isPrepVoice15MinEnabled, isPrepVoice10MinEnabled,
    isPrepVoice5MinEnabled, isPrepVoice4MinEnabled, isPrepVoice3MinEnabled, isPrepVoice2MinEnabled,
    isPrepVoice1MinEnabled, isPrepVoice30SecEnabled, isPrepVoice10SecEnabled, isPrepVoiceCountdownEnabled,
    playsInSilentMode, isVibrationEnabled, isVibPrepEnabled, vibrationIntensity
  ]);

  // メインタイマー進行のロジック（タイムスタンプ基準）
  useEffect(() => {
    if (isRunning) {
      if (!isCountUp) {
        if (!targetEndTimeRef.current) {
          targetEndTimeRef.current = Date.now() + remainingTimeRef.current * 1000;
        }
      } else {
        if (!overStartTimeRef.current) {
          overStartTimeRef.current = Date.now() - remainingTimeRef.current * 1000;
        }
      }

      timerRef.current = setInterval(() => {
        const now = Date.now();

        if (!isCountUpRef.current) {
          const diffMs = targetEndTimeRef.current - now;
          const nextTime = Math.max(0, Math.ceil(diffMs / 1000));

          if (nextTime !== remainingTimeRef.current) {
            remainingTimeRef.current = nextTime;
            setRemainingTime(nextTime);
          }

          // 音声アナウンス＆バイブレーションのトリガー（残り時間到達時）
          if (nextTime === 300 && isVoice5MinEnabled && !triggeredVoicesRef.current.has(300)) {
            triggeredVoicesRef.current.add(300);
            playVoice('v_5min');
          } else if (nextTime === 180 && isVoice3MinEnabled && !triggeredVoicesRef.current.has(180)) {
            triggeredVoicesRef.current.add(180);
            playVoice('v_3min');
          } else if (nextTime === 60 && isVoice1MinEnabled && !triggeredVoicesRef.current.has(60)) {
            triggeredVoicesRef.current.add(60);
            playVoice('v_1min');
            triggerVibration('warning');
          } else if (nextTime === 30 && isVoice30SecEnabled && !triggeredVoicesRef.current.has(30)) {
            triggeredVoicesRef.current.add(30);
            playVoice('v_30sec');
            triggerVibration('warning');
          } else if (nextTime === 10 && isVoice10SecEnabled && !triggeredVoicesRef.current.has(10)) {
            triggeredVoicesRef.current.add(10);
            playVoice('v_10sec');
            triggerVibration('warning');
          } else if (nextTime === 5 && isVoiceFinishEnabled && !triggeredVoicesRef.current.has(5)) {
            triggeredVoicesRef.current.add(5);
            playVoice('v_finish'); // 「5,4,3,2,1 終了」カウントダウン開始
            triggerVibration('countdown');
          }

          // 0秒到達（タイムアップ）
          if (diffMs <= 0) {
            if (!triggeredVoicesRef.current.has('alarm')) {
              triggeredVoicesRef.current.add('alarm');
              playAlarm();
            }
            if (isCountUpEnabled) {
              isCountUpRef.current = true;
              setIsCountUp(true);
              overStartTimeRef.current = targetEndTimeRef.current || now;
              triggeredOverVoicesRef.current.clear();
              remainingTimeRef.current = 0;
              setRemainingTime(0);
            } else {
              isCountUpRef.current = false;
              setIsCountUp(false);
              isRunningRef.current = false;
              setIsRunning(false);
              targetEndTimeRef.current = null;
              overStartTimeRef.current = null;
              remainingTimeRef.current = 0;
              setRemainingTime(0);
              resetControlsVisible();
            }
          }
        } else {
          const overMs = now - (overStartTimeRef.current || now);
          const nextTime = Math.max(0, Math.floor(overMs / 1000));

          if (nextTime !== remainingTimeRef.current) {
            remainingTimeRef.current = nextTime;
            setRemainingTime(nextTime);
          }

          // カウントアップ（超過時間）アナウンス＆バイブレーションのトリガー
          if (nextTime >= 2 && isOverVoiceStartEnabled && !triggeredOverVoicesRef.current.has('start')) {
            triggeredOverVoicesRef.current.add('start');
            playVoice('over_start'); // アラーム音終了直後（+2秒）に「カウントアップを始めます」
            triggerVibration('overtime');
          } else if (nextTime >= 60 && isOverVoice1MinEnabled && !triggeredOverVoicesRef.current.has(60)) {
            triggeredOverVoicesRef.current.add(60);
            playVoice('over_1min');
            triggerVibration('overtime');
          } else if (nextTime >= 180 && isOverVoice3MinEnabled && !triggeredOverVoicesRef.current.has(180)) {
            triggeredOverVoicesRef.current.add(180);
            playVoice('over_3min');
            triggerVibration('overtime');
          } else if (nextTime >= 300 && isOverVoice5MinEnabled && !triggeredOverVoicesRef.current.has(300)) {
            triggeredOverVoicesRef.current.add(300);
            playVoice('over_5min');
            triggerVibration('overtime');
          } else if (nextTime >= 600 && isOverVoice10MinEnabled && !triggeredOverVoicesRef.current.has(600)) {
            triggeredOverVoicesRef.current.add(600);
            playVoice('over_10min');
            triggerVibration('overtime');
          } else if (nextTime >= 900 && isOverVoice15MinEnabled && !triggeredOverVoicesRef.current.has(900)) {
            triggeredOverVoicesRef.current.add(900);
            playVoice('over_15min');
            triggerVibration('overtime');
          }
        }
      }, 250);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    }
    return () => clearInterval(timerRef.current);
  }, [
    isRunning, isCountUp, isCountUpEnabled, isVoiceMasterEnabled, isAlarmSoundEnabled,
    isVoice5MinEnabled, isVoice3MinEnabled, isVoice1MinEnabled, isVoice30SecEnabled, isVoice10SecEnabled, isVoiceFinishEnabled,
    isOverVoiceStartEnabled, isOverVoice1MinEnabled, isOverVoice3MinEnabled, isOverVoice5MinEnabled, isOverVoice10MinEnabled, isOverVoice15MinEnabled,
    alarmSoundType, playsInSilentMode, isVibrationEnabled, isVibration3SecOnly,
    vibrationIntensity, isVibWarningEnabled, isVibFinishEnabled, isVibOvertimeEnabled
  ]);

  const formatTime = (timeInSeconds) => {
    const isNegative = timeInSeconds < 0;
    const absTime = Math.abs(timeInSeconds);
    const h = Math.floor(absTime / 3600);
    const m = Math.floor((absTime % 3600) / 60);
    const s = absTime % 60;
    
    let formatted;
    if (h > 0) {
      // 1時間以上の場合： h:mm:ss （時は0埋めなし、分と秒は2桁）
      formatted = `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    } else if (m > 0) {
      // 1時間未満・1分以上の場合： m:ss （分は0埋めなし、秒は2桁）
      formatted = `${m}:${s.toString().padStart(2, '0')}`;
    } else {
      // 1分未満の場合： s （分を非表示、秒も0埋めなしでそのまま表示）
      formatted = `${s}`;
    }
    
    return isNegative ? `-${formatted}` : formatted;
  };

  const toggleTimer = () => {
    if (!isRunning && !isPreCountingDown && remainingTime === targetTime && isCountdownEnabled && countdownSeconds > 0) {
      // 初期状態からのスタートでカウントダウン有効の場合、準備カウントダウンを開始
      prepEndTimeRef.current = Date.now() + countdownSeconds * 1000;
      triggeredPrepVoicesRef.current.clear();
      preCountdownTimeRef.current = countdownSeconds;
      setPreCountdownTime(countdownSeconds);
      setIsPreCountingDown(true);

      // カウント開始時のアナウンス
      if (countdownSeconds === 5 && isPrepVoiceCountdownEnabled) {
        playVoice('prep_countdown_5');
      } else if (countdownSeconds === 10 && isPrepVoice10SecEnabled) {
        playVoice('prep_start_10sec');
      } else if (countdownSeconds === 30 && isPrepVoice30SecEnabled) {
        playVoice('prep_start_30sec');
      } else if (countdownSeconds === 60 && isPrepVoice1MinEnabled) {
        playVoice('prep_start_1min');
      } else if (countdownSeconds === 120 && isPrepVoice2MinEnabled) {
        playVoice('prep_2min');
      } else if (countdownSeconds === 180 && isPrepVoice3MinEnabled) {
        playVoice('prep_start_3min');
      } else if (countdownSeconds === 240 && isPrepVoice4MinEnabled) {
        playVoice('prep_4min');
      } else if (countdownSeconds === 300 && isPrepVoice5MinEnabled) {
        playVoice('prep_start_5min');
      } else if (countdownSeconds === 600 && isPrepVoice10MinEnabled) {
        playVoice('prep_start_10min');
      } else if (countdownSeconds === 900 && isPrepVoice15MinEnabled) {
        playVoice('prep_start_15min');
      } else if (countdownSeconds > 5) {
        playVoice('prep_start_generic');
      }
    } else {
      if (isPreCountingDown) {
        // カウントダウン中ならキャンセル
        setIsPreCountingDown(false);
        prepEndTimeRef.current = null;
        cancelVibration();
        if (voiceSound) {
          voiceSound.stopAsync().catch(() => {});
        }
      } else {
        // 通常のタイマートグル
        if (!isRunning) {
          // スタート/再開
          if (!isCountUp) {
            targetEndTimeRef.current = Date.now() + remainingTimeRef.current * 1000;
            if (remainingTimeRef.current === targetTime) {
              triggeredVoicesRef.current.clear();
            }
          } else {
            overStartTimeRef.current = Date.now() - remainingTimeRef.current * 1000;
          }
          setIsRunning(true);
        } else {
          // 一時停止
          targetEndTimeRef.current = null;
          overStartTimeRef.current = null;
          cancelVibration();
          setIsRunning(false);
        }
      }
    }
  };

  const resetTimer = () => {
    setIsRunning(false);
    setIsPreCountingDown(false);
    setIsCountUp(false);
    cancelVibration();
    targetEndTimeRef.current = null;
    prepEndTimeRef.current = null;
    overStartTimeRef.current = null;
    triggeredVoicesRef.current.clear();
    triggeredPrepVoicesRef.current.clear();
    triggeredOverVoicesRef.current.clear();
    remainingTimeRef.current = targetTime;
    setRemainingTime(targetTime);
    if (sound) {
      sound.stopAsync().catch(() => {});
    }
    if (voiceSound) {
      voiceSound.stopAsync().catch(() => {});
    }
  };

  // ---- 操作ボタン・ナビゲーションの自動非表示ロジック ----
  const handleScreenPress = () => {
    showControls(isRunning || isPreCountingDown);
  };

  useEffect(() => {
    if (!isFocused) {
      resetControlsVisible();
    } else {
      if (isRunning || isPreCountingDown) {
        showControls(true); // 進行中は3秒後に隠す
      } else {
        resetControlsVisible(); // 停止中・準備前は常に表示
      }
    }
  }, [isFocused, isRunning, isPreCountingDown]);

  // ---- 時間設定機能 ----
  const handleOpenTimeModal = () => {
    if (isRunning || isPreCountingDown) return;
    const m = Math.floor(targetTime / 60);
    const s = targetTime % 60;
    setManualInputMinStr(m > 0 ? m.toString() : '');
    setManualInputSecStr(s > 0 ? s.toString() : '');
    setTimeModalKeypadActive(null);
    setCountdownKeypadActive(null);
    setIsKeypadNewInput(true);
    setIsEditingFavorites(false);
    setTimeModalMode('time');
    setTimeModalVisible(true);
  };

  // ---- お気に入りタイマー時間管理 ----
  const toggleFavoritesAccordion = async () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const nextState = !isFavoritesOpen;
    setIsFavoritesOpen(nextState);
    try {
      await AsyncStorage.setItem('@timer_favorites_accordion_open', JSON.stringify(nextState));
    } catch (e) {
      console.log('Failed to save favorites accordion state:', e);
    }
  };

  const saveFavorites = async (newFavs) => {
    try {
      setFavoriteTimes(newFavs);
      await AsyncStorage.setItem('@timer_favorite_times', JSON.stringify(newFavs));
    } catch (e) {
      console.error("Failed to save favorite times", e);
    }
  };

  const handleDeleteFavorite = (secToDelete) => {
    const updated = favoriteTimes.filter((s) => s !== secToDelete);
    saveFavorites(updated);
  };

  const handleAddFavorite = () => {
    const min = parseInt(newFavMinStr, 10) || 0;
    const sec = parseInt(newFavSecStr, 10) || 0;
    const totalSec = min * 60 + sec;

    if (totalSec <= 0) {
      Alert.alert("エラー", "1秒以上の有効な時間を入力してください。");
      return;
    }
    if (favoriteTimes.includes(totalSec)) {
      Alert.alert("確認", "その時間はすでにお気に入りに登録されています。");
      return;
    }
    if (favoriteTimes.length >= 18) {
      Alert.alert("上限", "お気に入りは最大18個まで登録できます。不要な時間を削除してから追加してください。");
      return;
    }

    const updated = [...favoriteTimes, totalSec].sort((a, b) => a - b);
    saveFavorites(updated);
    setAddFavModalVisible(false);
    setNewFavMinStr('');
    setNewFavSecStr('');
  };

  const handleResetFavorites = () => {
    Alert.alert(
      "初期値に戻す",
      "お気に入り時間を初期の9種類（1分〜90分）に戻しますか？",
      [
        { text: "キャンセル", style: "cancel" },
        { 
          text: "戻す", 
          style: "destructive", 
          onPress: () => saveFavorites(DEFAULT_FAVORITE_TIMES) 
        }
      ]
    );
  };

  const formatFavoriteLabel = (totalSec) => {
    if (totalSec >= 60) {
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return s === 0 ? `${m}分` : `${m}分${s}秒`;
    }
    return `${totalSec}秒`;
  };

  // ---- 準備時間のお気に入り管理 ----
  const toggleCountdownFavoritesAccordion = async () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const nextState = !isCountdownFavoritesOpen;
    setIsCountdownFavoritesOpen(nextState);
    try {
      await AsyncStorage.setItem('@timer_countdown_favorites_accordion_open', JSON.stringify(nextState));
    } catch (e) {
      console.log('Failed to save countdown favorites accordion state:', e);
    }
  };

  const saveCountdownFavorites = async (newFavs) => {
    try {
      setCountdownFavoriteTimes(newFavs);
      await AsyncStorage.setItem('@timer_countdown_favorite_times', JSON.stringify(newFavs));
    } catch (e) {
      console.error("Failed to save countdown favorite times", e);
    }
  };

  const handleDeleteCountdownFavorite = (secToDelete) => {
    if (secToDelete === 0) return; // 「無し」は保護
    const updated = countdownFavoriteTimes.filter((s) => s !== secToDelete);
    saveCountdownFavorites(updated);
  };

  const handleResetCountdownFavorites = () => {
    Alert.alert(
      "初期値に戻す",
      "準備時間のお気に入りを初期値に戻しますか？",
      [
        { text: "キャンセル", style: "cancel" },
        { 
          text: "戻す", 
          style: "destructive", 
          onPress: () => {
            saveCountdownFavorites(DEFAULT_COUNTDOWN_FAVORITES);
            setIsEditingCountdownFavorites(false);
          }
        }
      ]
    );
  };

  const handleAddCountdownFavorite = () => {
    const min = parseInt(newFavMinStr, 10) || 0;
    const sec = parseInt(newFavSecStr, 10) || 0;
    const totalSec = min * 60 + sec;

    if (totalSec <= 0) {
      Alert.alert("エラー", "1秒以上の有効な時間を入力してください。（0秒の「無し」はすでに存在します）");
      return;
    }
    if (countdownFavoriteTimes.includes(totalSec)) {
      Alert.alert("確認", "その時間はすでに準備時間のお気に入りに登録されています。");
      return;
    }
    if (countdownFavoriteTimes.length >= 18) {
      Alert.alert("上限", "お気に入りは最大18個まで登録できます。不要な時間を削除してから追加してください。");
      return;
    }

    const updated = [...countdownFavoriteTimes, totalSec].sort((a, b) => a - b);
    saveCountdownFavorites(updated);
    setAddFavModalVisible(false);
    setNewFavMinStr('');
    setNewFavSecStr('');
  };

  const applyCountdownFavorite = (sec) => {
    if (sec === 0) {
      toggleCountdownEnabled(false);
    } else {
      toggleCountdownEnabled(true);
      saveCountdownSeconds(sec);
    }
    setTimeModalMode('time');
  };

  const formatCountdownFavoriteLabel = (sec) => {
    if (sec === 0) return '無し';
    if (sec < 60) return `${sec}秒`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (s === 0) return `${m}分`;
    return `${m}分${s}秒`;
  };

  const applyTimeInSeconds = (secs) => {
    setTargetTime(secs);
    remainingTimeRef.current = secs;
    setRemainingTime(secs);
    setIsCountUp(false);
    targetEndTimeRef.current = null;
    overStartTimeRef.current = null;
    triggeredVoicesRef.current.clear();
    triggeredOverVoicesRef.current.clear();
    setTimeModalKeypadActive(null);
    setIsEditingFavorites(false);
    setTimeModalVisible(false);
  };

  const applyTime = (minutes) => {
    applyTimeInSeconds(Math.max(1, Math.floor(minutes * 60)));
  };

  const handleManualApply = () => {
    const min = parseInt(manualInputMinStr, 10) || 0;
    const sec = parseInt(manualInputSecStr, 10) || 0;
    const totalSecs = min * 60 + sec;
    
    if (totalSecs > 0) {
      setTargetTime(totalSecs);
      remainingTimeRef.current = totalSecs;
      setRemainingTime(totalSecs);
      setIsCountUp(false);
      targetEndTimeRef.current = null;
      overStartTimeRef.current = null;
      triggeredVoicesRef.current.clear();
      triggeredOverVoicesRef.current.clear();
      setTimeModalKeypadActive(null);
      setTimeModalVisible(false);
    } else {
      Alert.alert("エラー", "有効な時間を入力してください。");
    }
  };

  const handleCountdownApply = () => {
    const m = parseInt(countdownInputMinStr, 10) || 0;
    const s = parseInt(countdownInputSecStr, 10) || 0;
    const totalSeconds = (m * 60) + s;
    if (totalSeconds > 0) {
      toggleCountdownEnabled(true);
      saveCountdownSeconds(totalSeconds);
    } else {
      toggleCountdownEnabled(false);
    }
    setCountdownKeypadActive(null);
    setTimeModalMode('time');
  };

  const handleSelectInputBox = (field, isCountdown = false) => {
    if (isCountdown) {
      setCountdownKeypadActive(field);
    } else {
      setTimeModalKeypadActive(field);
    }
    setIsKeypadNewInput(true);
  };

  const handleKeypadPress = (key, isCountdown = false) => {
    const activeField = isCountdown ? countdownKeypadActive : timeModalKeypadActive;
    if (!activeField) return;

    const currentStr = isCountdown
      ? (activeField === 'min' ? countdownInputMinStr : countdownInputSecStr)
      : (activeField === 'min' ? manualInputMinStr : manualInputSecStr);

    const setStr = isCountdown
      ? (activeField === 'min' ? setCountdownInputMinStr : setCountdownInputSecStr)
      : (activeField === 'min' ? setManualInputMinStr : setManualInputSecStr);

    if (key === 'clear') {
      setStr('0');
      setIsKeypadNewInput(true);
      return;
    }

    if (key === 'backspace') {
      if (!currentStr || currentStr.length <= 1) {
        setStr('0');
        setIsKeypadNewInput(true);
      } else {
        setStr(currentStr.slice(0, -1));
        setIsKeypadNewInput(false);
      }
      return;
    }

    // 数字キー (0-9)
    const digit = key.toString();
    if (isKeypadNewInput || currentStr === '0' || currentStr === '') {
      setStr(digit);
      setIsKeypadNewInput(false);
    } else {
      if (currentStr.length < 2) {
        const nextVal = currentStr + digit;
        if (activeField === 'sec' && parseInt(nextVal, 10) > 59) {
          setStr('59');
        } else {
          setStr(nextVal);
        }
      }
    }
  };

  const handleAddFavKeypadPress = (key) => {
    const currentStr = addFavKeypadActive === 'min' ? newFavMinStr : newFavSecStr;
    const setStr = addFavKeypadActive === 'min' ? setNewFavMinStr : setNewFavSecStr;

    if (key === 'clear') {
      setStr('0');
      setIsAddFavNewInput(true);
      return;
    }

    if (key === 'backspace') {
      if (!currentStr || currentStr.length <= 1) {
        setStr('0');
        setIsAddFavNewInput(true);
      } else {
        setStr(currentStr.slice(0, -1));
        setIsAddFavNewInput(false);
      }
      return;
    }

    // 数字キー (0-9)
    const digit = key.toString();
    if (isAddFavNewInput || currentStr === '0' || currentStr === '') {
      setStr(digit);
      setIsAddFavNewInput(false);
    } else {
      if (currentStr.length < 2) {
        const nextVal = currentStr + digit;
        if (addFavKeypadActive === 'sec' && parseInt(nextVal, 10) > 59) {
          setStr('59');
        } else {
          setStr(nextVal);
        }
      }
    }
  };

  // ---- 記録・保存機能 ----
  const handleOpenSaveModal = () => {
    setIsRunning(false); // タイマーを止める
    setIsPreCountingDown(false);
    cancelVibration();
    targetEndTimeRef.current = null;
    prepEndTimeRef.current = null;
    overStartTimeRef.current = null;
    setForceTargetTime(false);
    setSelectedCategory(lastUsedCategory); // デフォルトで前回のカテゴリをセット
    setSelectedTags([]); // タグを初期化
    setSaveModalVisible(true);
  };

  const handleOpenSaveInTimeModal = () => {
    setIsRunning(false); // タイマーを止める
    setIsPreCountingDown(false);
    cancelVibration();
    targetEndTimeRef.current = null;
    prepEndTimeRef.current = null;
    overStartTimeRef.current = null;
    setForceTargetTime(true); // 時間内に終わったことにしてターゲットタイムを記録する
    setSelectedCategory(lastUsedCategory); // デフォルトで前回のカテゴリをセット
    setSelectedTags([]); // タグを初期化
    setSaveModalVisible(true);
  };

  const handleTakePhoto = async () => {
    if (photoUris.length >= 4) {
      Alert.alert('制限', '写真は最大4枚までです。');
      return;
    }
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('カメラの許可', '設定からカメラへのアクセスを許可してください。');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: false, // 複数対応のために一旦false
      quality: 0.8,
    });
    if (!result.canceled && result.assets && result.assets.length > 0) {
      setPhotoUris([...photoUris, result.assets[0].uri]);
    }
  };

  const handlePickPhoto = async () => {
    if (photoUris.length >= 4) {
      Alert.alert('制限', '写真は最大4枚までです。');
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('写真の許可', '設定から写真へのアクセスを許可してください。');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: false,
      allowsMultipleSelection: true,
      selectionLimit: 4 - photoUris.length,
      quality: 0.8,
    });
    if (!result.canceled && result.assets) {
      const newUris = result.assets.map(a => a.uri);
      const combined = [...photoUris, ...newUris].slice(0, 4);
      setPhotoUris(combined);
    }
  };

  const handleSaveRecord = async () => {
    // 無料ユーザーの50件保存上限チェック
    if (!isProMode) {
      try {
        const currentRecords = await getRecords();
        if (currentRecords && currentRecords.length >= 50) {
          Alert.alert(
            "無料枠の上限（50件）に達しました",
            "練習記録の保存は無料版では50件までとなります。Proプラン（月額100円）にご加入いただくと、広告が非表示になり、記録を無制限に保存できるようになります。",
            [
              { text: "キャンセル", style: "cancel" },
              { text: "Proプランを見る", onPress: () => setProModalVisible(true) }
            ]
          );
          return;
        }
      } catch (e) {
        console.error("Error checking records count", e);
      }
    }

    // 経過秒数の計算
    let duration = isCountUp ? targetTime + remainingTime : targetTime - remainingTime;
    
    if (forceTargetTime) {
      duration = targetTime; // タイム内に入って終了した場合はターゲットタイムをそのまま記録
    }
    
    await saveRecord({
      duration: duration,
      category: selectedCategory || '未分類',
      photoUris: photoUris,
      tags: selectedTags,
    });
    
    if (selectedCategory) {
      await AsyncStorage.setItem('lastUsedCategory', selectedCategory);
      setLastUsedCategory(selectedCategory);
    }
    
    Alert.alert("保存完了", "練習記録を保存しました！");
    
    // モーダルを閉じ、タイマーをリセットする
    setSaveModalVisible(false);
    setPhotoUris([]);
    resetTimer();
  };

  const handleAddCategory = async () => {
    if (newCategoryName.trim()) {
      const newCats = [...savedCategories, newCategoryName.trim()];
      const uniqueCats = Array.from(new Set(newCats));
      setSavedCategories(uniqueCats);
      setSelectedCategory(newCategoryName.trim());
      setNewCategoryName('');
      setIsAddingCategory(false);
      try {
        await AsyncStorage.setItem('savedCategories', JSON.stringify(uniqueCats));
      } catch (e) {
        console.error(e);
      }
    }
  };

  const progress = isCountUp ? 0 : Math.max(0, remainingTime / targetTime);

  // カラーインジケーターのロジック
  let ringColor = '#007AFF'; // デフォルト: ブルー
  let activeProgress = progress;

  if (isPreCountingDown) {
    // 準備カウントダウン中はMAXブルー固定
    activeProgress = 1;
    ringColor = '#007AFF';
  } else if (!isCountUp) {
    if (isColorIndicator && targetTime <= 600) {
      // 残量パーセントに基づく色変更
      const remainingPercent = targetTime > 0 ? remainingTime / targetTime : 0;
      if (remainingPercent <= 0.10) {
        ringColor = '#FF3B30'; // レッド（残り10%以下）
      } else if (remainingPercent <= 0.30) {
        ringColor = '#FFCC00'; // イエロー（残り30%以下）
      } else {
        ringColor = '#007AFF'; // ブルー（残り30%超）
      }
    } else {
      // 従来のロジック（固定秒数ベース）
      if (remainingTime <= 60) ringColor = '#FF3B30';
      else if (remainingTime <= 300) ringColor = '#FFCC00';
    }
  } else {
    ringColor = '#FF3B30';
  }

  // エコモードによるテーマ設定
  const bgColor = isEcoMode ? '#000' : '#F5F5F5';
  const mainTextColor = isEcoMode ? '#fff' : '#000';
  const ringBgColor = isEcoMode ? '#333' : '#E5E5EA';

  // お気に入りタイマーのカスタムスクロールバー計算（10個以上時用）
  const favTrackHeight = Math.max(0, favContainerHeight - 16);
  const favThumbHeight = Math.max(20, (favContainerHeight / Math.max(1, favContentHeight)) * favTrackHeight);
  const favThumbY = favScrollY.interpolate({
    inputRange: [0, Math.max(1, favContentHeight - favContainerHeight)],
    outputRange: [0, Math.max(0, favTrackHeight - favThumbHeight)],
    extrapolate: 'clamp',
  });

  // 準備時間お気に入りのカスタムスクロールバー計算（10個以上時用）
  const countdownFavTrackHeight = Math.max(0, countdownFavContainerHeight - 16);
  const countdownFavThumbHeight = Math.max(20, (countdownFavContainerHeight / Math.max(1, countdownFavContentHeight)) * countdownFavTrackHeight);
  const countdownFavThumbY = countdownFavScrollY.interpolate({
    inputRange: [0, Math.max(1, countdownFavContentHeight - countdownFavContainerHeight)],
    outputRange: [0, Math.max(0, countdownFavTrackHeight - countdownFavThumbHeight)],
    extrapolate: 'clamp',
  });

  // クイックアクセスボタン用ハンドラー（触覚フィードバック＋トグル）
  const handleToggleCountdown = () => {
    Vibration.vibrate(30);
    toggleCountdownEnabled();
  };

  const handleOpenCountdownDirectly = () => {
    Vibration.vibrate(50);
    setTimeModalMode('countdown');
    setTimeModalVisible(true);
  };

  const handleToggleCountUp = () => {
    Vibration.vibrate(30);
    toggleCountUpEnabled();
  };

  const handleToggleVoice = () => {
    Vibration.vibrate(30);
    toggleVoiceMasterEnabled();
  };

  const handleToggleAlarm = () => {
    Vibration.vibrate(30);
    toggleAlarmSoundEnabled();
  };

  const handleToggleEco = () => {
    Vibration.vibrate(30);
    toggleEcoMode(!isEcoMode);
  };

  const handleLongPressToSettings = (targetSection) => {
    Vibration.vibrate(50);
    if (navigation && navigation.navigate) {
      navigation.navigate('Settings', { scrollTo: targetSection });
    }
  };

  return (
    <TouchableWithoutFeedback onPress={handleScreenPress}>
      <View style={[styles.container, { backgroundColor: bgColor }]}>
        <View style={styles.content}>
          {/* タイマー上部クイックアクセスバー ＆ バランサー領域 */}
          <View style={styles.topBalanceContainer}>
            <Animated.View 
              style={[
                styles.quickAccessBarWrapper, 
                { opacity: controlsOpacity }
              ]} 
              pointerEvents={controlsVisible ? 'auto' : 'none'}
            >
              <View style={[
                styles.quickAccessBar, 
                { 
                  backgroundColor: isEcoMode ? '#1C1C1E' : '#F2F2F7', 
                  borderColor: isEcoMode ? '#2C2C2E' : '#E5E5EA' 
                }
              ]}>
                {/* 1. 準備時間 */}
                <TouchableOpacity 
                  style={[
                    styles.quickAccessButton, 
                    isCountdownEnabled && (isEcoMode ? styles.quickAccessButtonActiveEco : styles.quickAccessButtonActive)
                  ]} 
                  onPress={handleToggleCountdown} 
                  onLongPress={handleOpenCountdownDirectly}
                  delayLongPress={350}
                  activeOpacity={0.7}
                  disabled={!controlsVisible || isRunning || isPreCountingDown}
                >
                  <Ionicons 
                    name="hourglass-outline" 
                    size={17} 
                    color={isCountdownEnabled ? (isEcoMode ? '#64D2FF' : '#007AFF') : (isEcoMode ? '#666' : '#8E8E93')} 
                  />
                  <Text style={[
                    styles.quickAccessLabel, 
                    { color: isCountdownEnabled ? (isEcoMode ? '#64D2FF' : '#007AFF') : (isEcoMode ? '#666' : '#8E8E93') }
                  ]}>
                    準備
                  </Text>
                </TouchableOpacity>

                <View style={[styles.quickAccessDivider, { backgroundColor: isEcoMode ? '#2C2C2E' : '#E0E0E5' }]} />

                {/* 2. カウントアップ */}
                <TouchableOpacity 
                  style={[
                    styles.quickAccessButton, 
                    isCountUpEnabled && (isEcoMode ? styles.quickAccessButtonActiveEco : styles.quickAccessButtonActive)
                  ]} 
                  onPress={handleToggleCountUp} 
                  onLongPress={() => handleLongPressToSettings('overtime')}
                  delayLongPress={350}
                  activeOpacity={0.7}
                  disabled={!controlsVisible || isRunning || isPreCountingDown}
                >
                  <Ionicons 
                    name="trending-up-outline" 
                    size={17} 
                    color={isCountUpEnabled ? (isEcoMode ? '#64D2FF' : '#007AFF') : (isEcoMode ? '#666' : '#8E8E93')} 
                  />
                  <Text style={[
                    styles.quickAccessLabel, 
                    { color: isCountUpEnabled ? (isEcoMode ? '#64D2FF' : '#007AFF') : (isEcoMode ? '#666' : '#8E8E93') }
                  ]}>
                    アップ
                  </Text>
                </TouchableOpacity>

                <View style={[styles.quickAccessDivider, { backgroundColor: isEcoMode ? '#2C2C2E' : '#E0E0E5' }]} />

                {/* 3. 音声 */}
                <TouchableOpacity 
                  style={[
                    styles.quickAccessButton, 
                    isVoiceMasterEnabled && (isEcoMode ? styles.quickAccessButtonActiveEco : styles.quickAccessButtonActive)
                  ]} 
                  onPress={handleToggleVoice} 
                  onLongPress={() => handleLongPressToSettings('voice')}
                  delayLongPress={350}
                  activeOpacity={0.7}
                  disabled={!controlsVisible}
                >
                  <Ionicons 
                    name={isVoiceMasterEnabled ? "megaphone-outline" : "volume-mute-outline"} 
                    size={17} 
                    color={isVoiceMasterEnabled ? (isEcoMode ? '#64D2FF' : '#007AFF') : (isEcoMode ? '#666' : '#8E8E93')} 
                  />
                  <Text style={[
                    styles.quickAccessLabel, 
                    { color: isVoiceMasterEnabled ? (isEcoMode ? '#64D2FF' : '#007AFF') : (isEcoMode ? '#666' : '#8E8E93') }
                  ]}>
                    音声
                  </Text>
                </TouchableOpacity>

                <View style={[styles.quickAccessDivider, { backgroundColor: isEcoMode ? '#2C2C2E' : '#E0E0E5' }]} />

                {/* 4. アラーム */}
                <TouchableOpacity 
                  style={[
                    styles.quickAccessButton, 
                    (isAlarmSoundEnabled && alarmSoundType !== 'none') && (isEcoMode ? styles.quickAccessButtonActiveEco : styles.quickAccessButtonActive)
                  ]} 
                  onPress={handleToggleAlarm} 
                  onLongPress={() => handleLongPressToSettings('alarm')}
                  delayLongPress={350}
                  activeOpacity={0.7}
                  disabled={!controlsVisible}
                >
                  <Ionicons 
                    name={(isAlarmSoundEnabled && alarmSoundType !== 'none') ? "notifications-outline" : "notifications-off-outline"} 
                    size={17} 
                    color={(isAlarmSoundEnabled && alarmSoundType !== 'none') ? (isEcoMode ? '#64D2FF' : '#007AFF') : (isEcoMode ? '#666' : '#8E8E93')} 
                  />
                  <Text style={[
                    styles.quickAccessLabel, 
                    { color: (isAlarmSoundEnabled && alarmSoundType !== 'none') ? (isEcoMode ? '#64D2FF' : '#007AFF') : (isEcoMode ? '#666' : '#8E8E93') }
                  ]}>
                    アラーム
                  </Text>
                </TouchableOpacity>

                <View style={[styles.quickAccessDivider, { backgroundColor: isEcoMode ? '#2C2C2E' : '#E0E0E5' }]} />

                {/* 5. エコモード */}
                <TouchableOpacity 
                  style={[
                    styles.quickAccessButton, 
                    isEcoMode && styles.quickAccessButtonActiveEco
                  ]} 
                  onPress={handleToggleEco} 
                  onLongPress={() => handleLongPressToSettings('eco')}
                  delayLongPress={350}
                  activeOpacity={0.7}
                  disabled={!controlsVisible}
                >
                  <Ionicons 
                    name={isEcoMode ? "leaf" : "leaf-outline"} 
                    size={17} 
                    color={isEcoMode ? '#34C759' : '#8E8E93'} 
                  />
                  <Text style={[
                    styles.quickAccessLabel, 
                    { color: isEcoMode ? '#34C759' : '#8E8E93' }
                  ]}>
                    エコ
                  </Text>
                </TouchableOpacity>
              </View>
            </Animated.View>
          </View>
          <View style={styles.timerContainer}>
          {(isEcoMode ? isEcoIndicatorEnabled : isNormalIndicatorEnabled) && (
            <RingProgress 
              radius={140} 
              strokeWidth={15} 
              progress={activeProgress} 
              color={ringColor}
              backgroundColor={ringBgColor}
              fillColor="transparent"
              isIdle={!isRunning && !isPreCountingDown && !isCountUp && remainingTime === targetTime}
              isEcoMode={isEcoMode}
            />
          )}
          <View style={styles.timeTextContainer}>
            {isPreCountingDown ? (
              <Text style={[preCountdownTime <= 10 ? styles.preCountdownText : styles.timeText, { color: mainTextColor }]}>
                {preCountdownTime <= 10 ? preCountdownTime : formatTime(preCountdownTime)}
              </Text>
            ) : (
              <TouchableOpacity onPress={handleOpenTimeModal} disabled={isRunning}>
                <Text style={[styles.timeText, { color: isCountUp ? '#FF3B30' : mainTextColor }]}>
                  {isCountUp ? '+' : ''}{formatTime(remainingTime)}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        <Animated.View style={[{ opacity: controlsOpacity, width: '100%', alignItems: 'center' }]} pointerEvents={controlsVisible ? 'auto' : 'none'}>
          <View style={styles.controlsContainer}>
            <TouchableOpacity style={styles.button} onPress={toggleTimer} disabled={!controlsVisible}>
              <Text style={styles.buttonText}>{isRunning || isPreCountingDown ? '一時停止' : 'スタート'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.resetButton]} onPress={resetTimer} disabled={!controlsVisible}>
              <Text style={[styles.buttonText, { color: '#000' }]}>リセット</Text>
            </TouchableOpacity>
          </View>
          
          {/* 下部アクションボタン領域（スタート前後・一時停止時で位置がずれないよう高さを常に確保） */}
          <View style={styles.bottomActionArea} pointerEvents="box-none">
            {isRunning ? (
              isCountUp ? (
                <View style={styles.splitEndButtonContainer}>
                  <TouchableOpacity 
                    style={[styles.splitEndButtonHalf, { backgroundColor: '#34C759' }]} 
                    onPress={handleOpenSaveInTimeModal}
                  >
                    <Text style={styles.splitEndButtonMainText}>計測終了</Text>
                    <Text style={styles.splitEndButtonSubText}>タイム内</Text>
                  </TouchableOpacity>
                  
                  <View style={styles.splitEndButtonDivider} />

                  <TouchableOpacity 
                    style={[styles.splitEndButtonHalf, { backgroundColor: '#FF3B30' }]} 
                    onPress={handleOpenSaveModal}
                  >
                    <Text style={styles.splitEndButtonMainText}>計測終了</Text>
                    <Text style={styles.splitEndButtonSubText}>タイムオーバー</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.endMeasurementButton} onPress={handleOpenSaveModal}>
                  <Text style={[styles.buttonText, { fontWeight: 'bold' }]}>計測終了</Text>
                </TouchableOpacity>
              )
            ) : !isPreCountingDown && remainingTime !== targetTime ? (
              <TouchableOpacity style={styles.saveActionButton} onPress={handleOpenSaveModal}>
                <Text style={styles.saveActionText}>記録・保存する</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </Animated.View>

      </View>

      {/* 広告バナー（AdMob / Proモード時は非表示） */}
      <AdBannerComponent />

      {/* 記録保存用モーダル */}
      <Modal visible={saveModalVisible} animationType="slide">
        <ScrollView contentContainerStyle={styles.modalContainer}>
          <Text style={styles.modalTitle}>練習結果の記録</Text>

          {/* 計測時間の詳細表示 */}
          <View style={{ backgroundColor: isEcoMode ? '#333' : '#F2F2F7', padding: 15, borderRadius: 10, width: '100%', marginBottom: 20, alignItems: 'center' }}>
            {(() => {
              let actualDuration = isCountUp ? targetTime + remainingTime : targetTime - remainingTime;
              if (forceTargetTime) actualDuration = targetTime;
              
              const isOver = isCountUp && !forceTargetTime;
              const overSeconds = isCountUp && !forceTargetTime ? remainingTime : 0;
              
              const m = Math.floor(actualDuration / 60);
              const s = actualDuration % 60;
              const timeStr = `${m}分${s}秒`;

              if (isOver) {
                const om = Math.floor(overSeconds / 60);
                const os = overSeconds % 60;
                const overStr = `+${om > 0 ? om + '分' : ''}${os}秒`;
                return (
                  <>
                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#FF3B30', marginBottom: 5 }}>タイムオーバー</Text>
                    <Text style={{ fontSize: 24, fontWeight: 'bold', color: isEcoMode ? '#fff' : '#000' }}>{timeStr} <Text style={{ fontSize: 16, color: '#FF3B30' }}>({overStr})</Text></Text>
                  </>
                );
              } else {
                return (
                  <>
                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#34C759', marginBottom: 5 }}>タイム内</Text>
                    <Text style={{ fontSize: 24, fontWeight: 'bold', color: isEcoMode ? '#fff' : '#000' }}>{timeStr}</Text>
                  </>
                );
              }
            })()}
          </View>

          <Text style={styles.label}>選択中のジャンル</Text>
          <TextInput 
            style={[styles.input, { backgroundColor: '#f0f0f0', color: '#333', marginBottom: 20 }]} 
            placeholder="未選択"
            value={selectedCategory}
            editable={false}
          />

          <Text style={[styles.label, {alignSelf: 'flex-start', color: isEcoMode ? '#aaa' : '#666'}]}>ジャンルを選択</Text>
          <View style={styles.categoryChipsContainer}>
            {/* 選択中のものを先頭に並び替えて表示 */}
            {[...savedCategories].sort((a, b) => a === selectedCategory ? -1 : b === selectedCategory ? 1 : 0).map((cat, index) => (
              <TouchableOpacity 
                key={index}
                style={[styles.categoryChip, selectedCategory === cat && styles.categoryChipSelected]}
                onPress={() => setSelectedCategory(cat)}
              >
                <Text style={[styles.categoryChipText, selectedCategory === cat && styles.categoryChipTextSelected]}>{cat}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity 
              style={[styles.categoryChip, styles.categoryChipAdd]}
              onPress={() => setIsAddingCategory(!isAddingCategory)}
            >
              <Text style={styles.categoryChipTextAdd}>＋ 追加</Text>
            </TouchableOpacity>
          </View>

          {isAddingCategory && (
            <View style={styles.addCategoryContainer}>
              <TextInput 
                style={[styles.input, { flex: 1, marginBottom: 0, marginRight: 10 }]} 
                placeholder="新しいジャンル名を入力"
                value={newCategoryName}
                onChangeText={setNewCategoryName}
                onSubmitEditing={handleAddCategory}
              />
              <TouchableOpacity style={styles.addCategoryButton} onPress={handleAddCategory}>
                <Text style={styles.addCategoryButtonText}>決定</Text>
              </TouchableOpacity>
            </View>
          )}
          
          <Text style={styles.label}>写真を追加（最大4枚）</Text>
          <View style={styles.photoActionBox}>
             <TouchableOpacity style={styles.photoButton} onPress={handleTakePhoto}>
               <Text style={styles.photoButtonText}>カメラで撮影</Text>
             </TouchableOpacity>
             <TouchableOpacity style={styles.photoButton} onPress={handlePickPhoto}>
               <Text style={styles.photoButtonText}>ギャラリーから選択</Text>
             </TouchableOpacity>
          </View>

          {photoUris.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginVertical: 10, justifyContent: 'center' }}>
              {photoUris.map((uri, index) => (
                <View key={`photo-${index}`} style={{ margin: 5 }}>
                  <TouchableOpacity onPress={() => setFullScreenIndex(index)}>
                    <Image source={{ uri }} style={{ width: 80, height: 80, borderRadius: 8 }} />
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={{ position: 'absolute', top: -8, right: -8, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 12, width: 24, height: 24, justifyContent: 'center', alignItems: 'center' }}
                    onPress={() => {
                      setPhotoUris(photoUris.filter((_, i) => i !== index));
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>×</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          <Text style={[styles.label, { marginTop: 20 }]}>タグをつける</Text>
          <View style={styles.categoryChipsContainer}>
            {DEFAULT_TAGS.map((tag, index) => {
              const isSelected = selectedTags.includes(tag);
              return (
                <TouchableOpacity
                  key={`tag-${index}`}
                  style={[styles.categoryChip, isSelected && styles.categoryChipSelected]}
                  onPress={() => {
                    if (isSelected) {
                      setSelectedTags(selectedTags.filter(t => t !== tag));
                    } else {
                      setSelectedTags([...selectedTags, tag]);
                    }
                  }}
                >
                  <Text style={[styles.categoryChipText, isSelected && styles.categoryChipTextSelected]}>{tag}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity style={[styles.saveActionButton, {marginTop: 40}]} onPress={handleSaveRecord}>
             <Text style={styles.saveActionText}>記録を保存してリセット</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.resetButton, {marginTop: 20, padding: 15, borderRadius: 10}]} onPress={() => setSaveModalVisible(false)}>
             <Text style={{textAlign: 'center', color: '#000', fontWeight: 'bold'}}>キャンセル</Text>
          </TouchableOpacity>
        </ScrollView>
        
        {/* 写真の全画面プレビュー用オーバーレイ（二重Modalを避けるためViewの絶対配置を使用） */}
        {fullScreenIndex !== null && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'black', zIndex: 1000, elevation: 100 }}>
            <ImageViewer 
              imageUrls={photoUris.map(uri => ({ url: uri }))}
              index={fullScreenIndex}
              onSwipeDown={() => setFullScreenIndex(null)}
              onClick={() => setFullScreenIndex(null)}
              enableSwipeDown={true}
              renderIndicator={() => null}
            />
          </View>
        )}
      </Modal>

      {/* タイマー・カウントダウン設定モーダル（1つのモーダルで中身を切り替える） */}
      <Modal visible={timeModalVisible} animationType="fade" transparent={true}>
        <View style={styles.timeModalOverlay}>
          <View style={[styles.timeModalContent, { backgroundColor: isEcoMode ? '#222' : '#fff' }]}>
            {timeModalMode === 'time' ? (
              <>
                <Text style={[styles.timeModalTitle, { color: isEcoMode ? '#fff' : '#000' }]}>タイマー時間の設定</Text>
                
                {/* スタート前準備時間設定への導線（最上部に配置） */}
                {!timeModalKeypadActive && (
                  <>
                    <TouchableOpacity 
                      style={[styles.countdownSettingCard, { backgroundColor: '#007AFF', paddingVertical: 12, marginTop: 4, marginBottom: 2 }]} 
                      onPress={() => {
                        const m = Math.floor(countdownSeconds / 60);
                        const s = countdownSeconds % 60;
                        setCountdownInputMinStr(m > 0 ? m.toString() : '');
                        setCountdownInputSecStr(s > 0 ? s.toString() : '');
                        setCountdownKeypadActive(null);
                        setIsKeypadNewInput(true);
                        setTimeModalMode('countdown');
                      }}
                    >
                      <Text style={[styles.countdownSettingCardTitle, { color: '#fff', marginBottom: 2 }]}>
                        スタート前カウントダウン
                      </Text>
                      <Text style={[styles.countdownSettingCardStatus, { color: '#E5F1FF', fontSize: 13, fontWeight: 'normal' }]}>
                        ({isCountdownEnabled ? `現在${countdownSeconds >= 60 ? (countdownSeconds % 60 === 0 ? `${countdownSeconds / 60}分` : `${Math.floor(countdownSeconds / 60)}分${countdownSeconds % 60}秒`) : `${countdownSeconds}秒`}` : 'オフ'})
                      </Text>
                    </TouchableOpacity>
                    <Text style={{textAlign: 'center', fontSize: 12, color: isEcoMode ? '#888' : '#666', marginTop: 2, marginBottom: 14}}>
                      準備時間を設定できます
                    </Text>
                  </>
                )}

                {/* 案B: デジタル液晶ディスプレイ風タイマーパネル（薄めブラック） */}
                <View style={[
                  styles.timerDisplayCard,
                  {
                    backgroundColor: isEcoMode ? '#161B24' : '#222834',
                    borderColor: timeModalKeypadActive ? '#0284C7' : (isEcoMode ? '#2A3444' : '#3A475C'),
                  }
                ]}>
                  {/* パネル上部インフォ */}
                  <View style={styles.timerDisplayHeader}>
                    <Text style={[styles.timerDisplayLabel, { color: '#94A3B8' }]}>
                      ⏱️ 直接入力
                    </Text>
                    <View style={styles.timerDisplayEditBadge}>
                      <Text style={[styles.timerDisplayEditText, { color: timeModalKeypadActive ? '#38BDF8' : '#7DD3FC' }]}>
                        {timeModalKeypadActive ? '● 入力中' : '✎ タップして変更'}
                      </Text>
                    </View>
                  </View>

                  {/* デジタル時間表示エリア */}
                  <View style={styles.timerDisplayDigitsRow}>
                    {/* 分セグメント */}
                    <TouchableOpacity 
                      activeOpacity={0.7}
                      style={[
                        styles.timerDigitSegment,
                        timeModalKeypadActive === 'min' && styles.timerDigitSegmentActive
                      ]}
                      onPress={() => handleSelectInputBox('min', false)}
                    >
                      <Text style={[
                        styles.timerDigitNumber,
                        { color: timeModalKeypadActive === 'min' ? '#38BDF8' : '#F8FAFC' }
                      ]}>
                        {manualInputMinStr !== '' ? manualInputMinStr : '0'}
                      </Text>
                      <Text style={[styles.timerDigitUnit, { color: timeModalKeypadActive === 'min' ? '#7DD3FC' : '#94A3B8' }]}>
                        分
                      </Text>
                      {timeModalKeypadActive === 'min' && <View style={styles.timerActiveBar} />}
                    </TouchableOpacity>

                    {/* セパレータ */}
                    <Text style={styles.timerDigitSeparator}>:</Text>

                    {/* 秒セグメント */}
                    <TouchableOpacity 
                      activeOpacity={0.7}
                      style={[
                        styles.timerDigitSegment,
                        timeModalKeypadActive === 'sec' && styles.timerDigitSegmentActive
                      ]}
                      onPress={() => handleSelectInputBox('sec', false)}
                    >
                      <Text style={[
                        styles.timerDigitNumber,
                        { color: timeModalKeypadActive === 'sec' ? '#38BDF8' : '#F8FAFC' }
                      ]}>
                        {manualInputSecStr !== '' ? manualInputSecStr : '0'}
                      </Text>
                      <Text style={[styles.timerDigitUnit, { color: timeModalKeypadActive === 'sec' ? '#7DD3FC' : '#94A3B8' }]}>
                        秒
                      </Text>
                      {timeModalKeypadActive === 'sec' && <View style={styles.timerActiveBar} />}
                    </TouchableOpacity>
                  </View>
                </View>

                {/* テンキー非展開時の決定ボタン */}
                {!timeModalKeypadActive && (
                  <TouchableOpacity 
                    style={[styles.applyButton, { alignSelf: 'center', minWidth: 120, marginTop: 10, marginBottom: 14, paddingVertical: 10 }]} 
                    onPress={handleManualApply}
                  >
                    <Text style={styles.applyButtonText}>決定</Text>
                  </TouchableOpacity>
                )}

                {timeModalKeypadActive ? (
                  /* テンキー数字タイル表示時 */
                  <View style={styles.keypadWrapper}>
                    <View style={styles.keypadGrid}>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 'clear', 0, 'backspace'].map((key) => {
                        const isClear = key === 'clear';
                        const isBackspace = key === 'backspace';
                        let label = key;
                        if (isClear) label = 'C';
                        if (isBackspace) label = '⌫';

                        return (
                          <TouchableOpacity
                            key={key}
                            activeOpacity={0.6}
                            style={[
                              styles.keypadKey,
                              {
                                backgroundColor: (isClear || isBackspace)
                                  ? (isEcoMode ? '#2C2C2E' : '#E5E5EA')
                                  : (isEcoMode ? '#333333' : '#F2F2F7')
                              }
                            ]}
                            onPress={() => handleKeypadPress(key, false)}
                          >
                            <Text
                              style={[
                                styles.keypadKeyText,
                                {
                                  color: isClear 
                                    ? '#FF3B30' 
                                    : (isEcoMode ? '#ffffff' : '#000000'),
                                  fontSize: (isClear || isBackspace) ? 20 : 22,
                                }
                              ]}
                            >
                              {label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <TouchableOpacity 
                      style={[styles.applyButton, { width: '100%', marginTop: 14, marginBottom: 6 }]} 
                      onPress={handleManualApply}
                    >
                      <Text style={styles.applyButtonText}>決定</Text>
                    </TouchableOpacity>

                    <TouchableOpacity 
                      style={{ paddingVertical: 10 }} 
                      onPress={() => setTimeModalKeypadActive(null)}
                    >
                      <Text style={[styles.closeTimeModalText, { fontSize: 14, color: isEcoMode ? '#888' : '#666' }]}>
                        テンキーを閉じる
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  /* 通常（お気に入り一覧）表示時 */
                  <>

                    {/* お気に入りエリア（黄色アコーディオン枠線カード） */}
                    <View style={[
                      styles.favoritesCard, 
                      { 
                        backgroundColor: isEcoMode ? '#221C0E' : '#FFFDF0',
                        borderColor: isEcoMode ? '#B45309' : '#FACC15',
                        borderWidth: 1.5,
                        marginBottom: isFavoritesOpen ? 16 : 14,
                      }
                    ]}>
                      {/* お気に入りヘッダー（タップでアコーディオン開閉） */}
                      <TouchableOpacity 
                        activeOpacity={0.7}
                        onPress={toggleFavoritesAccordion}
                        style={[
                          styles.favoritesHeader,
                          { marginBottom: isFavoritesOpen ? 10 : 0 }
                        ]}
                      >
                        {/* 左側：タイトルと件数 */}
                        <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1, marginRight: 6 }}>
                          <Text style={{ fontSize: 15, marginRight: 4 }}>⭐</Text>
                          <Text style={[styles.favoritesTitle, { color: isEcoMode ? '#FDE68A' : '#78350F' }]}>
                            お気に入り
                          </Text>
                          <Text style={{ fontSize: 11, color: isEcoMode ? '#D97706' : '#92400E', marginLeft: 4, fontWeight: '600' }}>
                            ({favoriteTimes.length}件)
                          </Text>
                        </View>

                        {/* 右側：操作ボタンと開閉アコーディオン表示 */}
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          {isFavoritesOpen && (
                            <TouchableOpacity 
                              onPress={() => setIsEditingFavorites(!isEditingFavorites)}
                              style={[
                                styles.favoritesEditBtn,
                                { backgroundColor: isEditingFavorites ? '#007AFF' : (isEcoMode ? '#382C14' : '#FEF08A') }
                              ]}
                            >
                              <Text style={[
                                styles.favoritesEditBtnText,
                                { color: isEditingFavorites ? '#fff' : (isEcoMode ? '#FDE68A' : '#854D0E') }
                              ]}>
                                {isEditingFavorites ? '完了' : '編集'}
                              </Text>
                            </TouchableOpacity>
                          )}

                          {/* 開閉バッジ（▲ / ▼） */}
                          <View style={[
                            styles.accordionToggleBadge,
                            { backgroundColor: isEcoMode ? '#382C14' : '#FEF08A' }
                          ]}>
                            <Text style={[
                              styles.accordionToggleText,
                              { color: isEcoMode ? '#FDE68A' : '#854D0E' }
                            ]}>
                              {isFavoritesOpen ? '▲' : '▼'}
                            </Text>
                          </View>
                        </View>
                      </TouchableOpacity>

                      {/* タイル一覧（展開時のみ表示） */}
                      {isFavoritesOpen && (
                        <View style={{ width: '100%', position: 'relative' }}>
                          <Animated.ScrollView 
                            style={{ maxHeight: 165, width: '100%' }}
                            contentContainerStyle={styles.favoritesTilesGrid}
                            showsVerticalScrollIndicator={false}
                            nestedScrollEnabled={true}
                            scrollEventThrottle={16}
                            onScroll={Animated.event(
                              [{ nativeEvent: { contentOffset: { y: favScrollY } } }],
                              { useNativeDriver: false }
                            )}
                            onContentSizeChange={(_, h) => setFavContentHeight(h)}
                            onLayout={(e) => setFavContainerHeight(e.nativeEvent.layout.height)}
                          >
                            {favoriteTimes.map((sec) => (
                              <View key={sec} style={styles.favoriteTileWrapper}>
                                <TouchableOpacity 
                                  style={[
                                    styles.favoriteTile, 
                                    { 
                                      backgroundColor: isEcoMode ? '#2A2210' : '#FFFFFF',
                                      borderColor: isEcoMode ? '#4A3B18' : '#FDE047',
                                    }
                                  ]} 
                                  disabled={isEditingFavorites}
                                  onPress={() => applyTimeInSeconds(sec)}
                                >
                                  <Text style={[
                                    styles.favoriteTileText, 
                                    { color: isEcoMode ? '#FEF9C3' : '#1F2937' }
                                  ]}>
                                    {formatFavoriteLabel(sec)}
                                  </Text>
                                </TouchableOpacity>
                                {/* 編集モード時の削除バッジ */}
                                {isEditingFavorites && (
                                  <TouchableOpacity 
                                    style={styles.favoriteDeleteBadge} 
                                    onPress={() => handleDeleteFavorite(sec)}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                  >
                                    <Text style={styles.favoriteDeleteBadgeText}>✕</Text>
                                  </TouchableOpacity>
                                )}
                              </View>
                            ))}
                          </Animated.ScrollView>

                          {/* 10個以上（9個超）の時に常時表示されるカスタムスクロールインジケーターバー */}
                          {favoriteTimes.length > 9 && favContentHeight > favContainerHeight && (
                            <View style={styles.customScrollTrack} pointerEvents="none">
                              <Animated.View style={[
                                styles.customScrollThumb,
                                {
                                  backgroundColor: isEcoMode ? 'rgba(253, 230, 138, 0.7)' : 'rgba(217, 119, 6, 0.55)',
                                  height: favThumbHeight,
                                  transform: [{ translateY: favThumbY }],
                                }
                              ]} />
                            </View>
                          )}
                        </View>
                      )}

                      {/* カード下部の固定操作エリア（スクロール外） */}
                      {isFavoritesOpen && (
                        <View style={[
                          styles.favoritesBottomActionsRow,
                          { justifyContent: isEditingFavorites ? 'center' : 'flex-end' }
                        ]}>
                          {favoriteTimes.length < 18 && (
                            <TouchableOpacity 
                              activeOpacity={0.7}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              style={[
                                styles.favoritesBottomBtn,
                                { 
                                  backgroundColor: isEcoMode ? '#322610' : '#FEF08A',
                                  borderColor: isEcoMode ? '#D97706' : '#EAB308',
                                }
                              ]}
                              onPress={() => {
                                setNewFavMinStr('0');
                                setNewFavSecStr('0');
                                setAddFavKeypadActive('min');
                                setIsAddFavNewInput(true);
                                setAddFavTarget('time');
                                setAddFavModalVisible(true);
                              }}
                            >
                              <Text style={[styles.favoritesBottomBtnText, { color: isEcoMode ? '#FDE68A' : '#854D0E' }]}>
                                ＋ 追加
                              </Text>
                            </TouchableOpacity>
                          )}

                          {isEditingFavorites && (
                            <TouchableOpacity 
                              activeOpacity={0.7}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              onPress={handleResetFavorites}
                              style={[
                                styles.favoritesBottomBtn,
                                {
                                  backgroundColor: isEcoMode ? '#351C1C' : '#FFF0F0',
                                  borderColor: isEcoMode ? '#6B2020' : '#FFD5D5',
                                }
                              ]}
                            >
                              <Text style={[styles.favoritesBottomBtnText, { color: '#FF3B30' }]}>
                                ↺ 初期値に戻す
                              </Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      )}
                    </View>

                    <TouchableOpacity style={styles.closeTimeModalButton} onPress={() => setTimeModalVisible(false)}>
                      <Text style={styles.closeTimeModalText}>閉じる</Text>
                    </TouchableOpacity>
                  </>
                )}
              </>
            ) : (
              <>
                <Text style={[styles.timeModalTitle, { color: isEcoMode ? '#fff' : '#000' }]}>準備時間の設定</Text>

                {/* 案B: デジタル液晶ディスプレイ風タイマーパネル（薄めブラック） */}
                <View style={[
                  styles.timerDisplayCard,
                  {
                    backgroundColor: isEcoMode ? '#161B24' : '#222834',
                    borderColor: countdownKeypadActive ? '#0284C7' : (isEcoMode ? '#2A3444' : '#3A475C'),
                    marginTop: countdownKeypadActive ? 0 : 4,
                  }
                ]}>
                  {/* パネル上部インフォ */}
                  <View style={styles.timerDisplayHeader}>
                    <Text style={[styles.timerDisplayLabel, { color: '#94A3B8' }]}>
                      ⏱️ 直接入力
                    </Text>
                    <View style={styles.timerDisplayEditBadge}>
                      <Text style={[styles.timerDisplayEditText, { color: countdownKeypadActive ? '#38BDF8' : '#7DD3FC' }]}>
                        {countdownKeypadActive ? '● 入力中' : '✎ タップして変更'}
                      </Text>
                    </View>
                  </View>

                  {/* デジタル時間表示エリア */}
                  <View style={styles.timerDisplayDigitsRow}>
                    {/* 分セグメント */}
                    <TouchableOpacity 
                      activeOpacity={0.7}
                      style={[
                        styles.timerDigitSegment,
                        countdownKeypadActive === 'min' && styles.timerDigitSegmentActive
                      ]}
                      onPress={() => handleSelectInputBox('min', true)}
                    >
                      <Text style={[
                        styles.timerDigitNumber,
                        { color: countdownKeypadActive === 'min' ? '#38BDF8' : '#F8FAFC' }
                      ]}>
                        {countdownInputMinStr !== '' ? countdownInputMinStr : '0'}
                      </Text>
                      <Text style={[styles.timerDigitUnit, { color: countdownKeypadActive === 'min' ? '#7DD3FC' : '#94A3B8' }]}>
                        分
                      </Text>
                      {countdownKeypadActive === 'min' && <View style={styles.timerActiveBar} />}
                    </TouchableOpacity>

                    {/* セパレータ */}
                    <Text style={styles.timerDigitSeparator}>:</Text>

                    {/* 秒セグメント */}
                    <TouchableOpacity 
                      activeOpacity={0.7}
                      style={[
                        styles.timerDigitSegment,
                        countdownKeypadActive === 'sec' && styles.timerDigitSegmentActive
                      ]}
                      onPress={() => handleSelectInputBox('sec', true)}
                    >
                      <Text style={[
                        styles.timerDigitNumber,
                        { color: countdownKeypadActive === 'sec' ? '#38BDF8' : '#F8FAFC' }
                      ]}>
                        {countdownInputSecStr !== '' ? countdownInputSecStr : '0'}
                      </Text>
                      <Text style={[styles.timerDigitUnit, { color: countdownKeypadActive === 'sec' ? '#7DD3FC' : '#94A3B8' }]}>
                        秒
                      </Text>
                      {countdownKeypadActive === 'sec' && <View style={styles.timerActiveBar} />}
                    </TouchableOpacity>
                  </View>
                </View>

                {/* テンキー非展開時の決定ボタン */}
                {!countdownKeypadActive && (
                  <TouchableOpacity 
                    style={[styles.applyButton, { alignSelf: 'center', minWidth: 120, marginTop: 10, marginBottom: 14, paddingVertical: 10 }]} 
                    onPress={handleCountdownApply}
                  >
                    <Text style={styles.applyButtonText}>決定</Text>
                  </TouchableOpacity>
                )}

                {countdownKeypadActive ? (
                  /* テンキー表示時 */
                  <View style={styles.keypadWrapper}>
                    <View style={styles.keypadGrid}>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 'clear', 0, 'backspace'].map((key) => {
                        const isClear = key === 'clear';
                        const isBackspace = key === 'backspace';
                        let label = key;
                        if (isClear) label = 'C';
                        if (isBackspace) label = '⌫';

                        return (
                          <TouchableOpacity
                            key={key}
                            activeOpacity={0.6}
                            style={[
                              styles.keypadKey,
                              {
                                backgroundColor: (isClear || isBackspace)
                                  ? (isEcoMode ? '#2C2C2E' : '#E5E5EA')
                                  : (isEcoMode ? '#333333' : '#F2F2F7')
                              }
                            ]}
                            onPress={() => handleKeypadPress(key, true)}
                          >
                            <Text
                              style={[
                                styles.keypadKeyText,
                                {
                                  color: isClear 
                                    ? '#FF3B30' 
                                    : (isEcoMode ? '#ffffff' : '#000000'),
                                  fontSize: (isClear || isBackspace) ? 20 : 22,
                                }
                              ]}
                            >
                              {label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <TouchableOpacity 
                      style={[styles.applyButton, { width: '100%', marginTop: 14, marginBottom: 6 }]} 
                      onPress={handleCountdownApply}
                    >
                      <Text style={styles.applyButtonText}>決定</Text>
                    </TouchableOpacity>

                    <TouchableOpacity 
                      style={{ paddingVertical: 10 }} 
                      onPress={() => setCountdownKeypadActive(null)}
                    >
                      <Text style={[styles.closeTimeModalText, { fontSize: 14, color: isEcoMode ? '#888' : '#666' }]}>
                        テンキーを閉じる
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  /* 通常表示時：準備時間のお気に入り（黄色アコーディオン枠線カード） */
                  <>
                    <View style={[
                      styles.favoritesCard, 
                      { 
                        backgroundColor: isEcoMode ? '#221C0E' : '#FFFDF0',
                        borderColor: isEcoMode ? '#B45309' : '#FACC15',
                        borderWidth: 1.5,
                        marginBottom: isCountdownFavoritesOpen ? 16 : 14,
                      }
                    ]}>
                      {/* お気に入りヘッダー（タップでアコーディオン開閉） */}
                      <TouchableOpacity 
                        activeOpacity={0.7}
                        onPress={toggleCountdownFavoritesAccordion}
                        style={[
                          styles.favoritesHeader,
                          { marginBottom: isCountdownFavoritesOpen ? 10 : 0 }
                        ]}
                      >
                        {/* 左側：タイトルと件数 */}
                        <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1, marginRight: 6 }}>
                          <Text style={{ fontSize: 15, marginRight: 4 }}>⭐</Text>
                          <Text 
                            numberOfLines={1}
                            style={[styles.favoritesTitle, { color: isEcoMode ? '#FDE68A' : '#78350F' }]}
                          >
                            準備時間のお気に入り
                          </Text>
                          <Text style={{ fontSize: 11, color: isEcoMode ? '#D97706' : '#92400E', marginLeft: 4, fontWeight: '600' }}>
                            ({countdownFavoriteTimes.length}件)
                          </Text>
                        </View>

                        {/* 右側：操作ボタンと開閉アコーディオン表示 */}
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          {isCountdownFavoritesOpen && (
                            <TouchableOpacity 
                              onPress={() => setIsEditingCountdownFavorites(!isEditingCountdownFavorites)}
                              style={[
                                styles.favoritesEditBtn,
                                { backgroundColor: isEditingCountdownFavorites ? '#007AFF' : (isEcoMode ? '#382C14' : '#FEF08A') }
                              ]}
                            >
                              <Text style={[
                                styles.favoritesEditBtnText,
                                { color: isEditingCountdownFavorites ? '#fff' : (isEcoMode ? '#FDE68A' : '#854D0E') }
                              ]}>
                                {isEditingCountdownFavorites ? '完了' : '編集'}
                              </Text>
                            </TouchableOpacity>
                          )}

                          {/* 開閉バッジ（▲ / ▼） */}
                          <View style={[
                            styles.accordionToggleBadge,
                            { backgroundColor: isEcoMode ? '#382C14' : '#FEF08A' }
                          ]}>
                            <Text style={[
                              styles.accordionToggleText,
                              { color: isEcoMode ? '#FDE68A' : '#854D0E' }
                            ]}>
                              {isCountdownFavoritesOpen ? '▲' : '▼'}
                            </Text>
                          </View>
                        </View>
                      </TouchableOpacity>

                      {/* タイル一覧（展開時のみ表示） */}
                      {isCountdownFavoritesOpen && (
                        <View style={{ width: '100%', position: 'relative' }}>
                          <Animated.ScrollView 
                            style={{ maxHeight: 165, width: '100%' }}
                            contentContainerStyle={styles.favoritesTilesGrid}
                            showsVerticalScrollIndicator={false}
                            nestedScrollEnabled={true}
                            scrollEventThrottle={16}
                            onScroll={Animated.event(
                              [{ nativeEvent: { contentOffset: { y: countdownFavScrollY } } }],
                              { useNativeDriver: false }
                            )}
                            onContentSizeChange={(_, h) => setCountdownFavContentHeight(h)}
                            onLayout={(e) => setCountdownFavContainerHeight(e.nativeEvent.layout.height)}
                          >
                            {countdownFavoriteTimes.map((sec) => {
                              const isCurrentActive = sec === 0 ? !isCountdownEnabled : (isCountdownEnabled && countdownSeconds === sec);
                              return (
                                <View key={sec} style={styles.favoriteTileWrapper}>
                                  <TouchableOpacity 
                                    style={[
                                      styles.favoriteTile, 
                                      { 
                                        backgroundColor: isCurrentActive 
                                          ? '#007AFF' 
                                          : (isEcoMode ? '#2A2210' : '#FFFFFF'),
                                        borderColor: isCurrentActive
                                          ? '#0056B3'
                                          : (isEcoMode ? '#4A3B18' : '#FDE047'),
                                      }
                                    ]} 
                                    disabled={isEditingCountdownFavorites}
                                    onPress={() => applyCountdownFavorite(sec)}
                                  >
                                    <Text style={[
                                      styles.favoriteTileText, 
                                      { color: isCurrentActive ? '#FFFFFF' : (isEcoMode ? '#FEF9C3' : '#1F2937') }
                                    ]}>
                                      {formatCountdownFavoriteLabel(sec)}
                                    </Text>
                                  </TouchableOpacity>

                                  {/* 編集モード時の削除バッジ（「無し(0秒)」は安全のため保護） */}
                                  {isEditingCountdownFavorites && sec !== 0 && (
                                    <TouchableOpacity 
                                      style={styles.favoriteDeleteBadge} 
                                      onPress={() => handleDeleteCountdownFavorite(sec)}
                                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    >
                                      <Text style={styles.favoriteDeleteBadgeText}>✕</Text>
                                    </TouchableOpacity>
                                  )}
                                </View>
                              );
                            })}
                          </Animated.ScrollView>

                          {/* 10個以上（9個超）の時に常時表示されるカスタムスクロールインジケーターバー */}
                          {countdownFavoriteTimes.length > 9 && countdownFavContentHeight > countdownFavContainerHeight && (
                            <View style={styles.customScrollTrack} pointerEvents="none">
                              <Animated.View style={[
                                styles.customScrollThumb,
                                {
                                  backgroundColor: isEcoMode ? 'rgba(253, 230, 138, 0.7)' : 'rgba(217, 119, 6, 0.55)',
                                  height: countdownFavThumbHeight,
                                  transform: [{ translateY: countdownFavThumbY }],
                                }
                              ]} />
                            </View>
                          )}
                        </View>
                      )}

                        {/* カード下部の固定操作エリア（スクロール外） */}
                        {isCountdownFavoritesOpen && (
                          <View style={[
                            styles.favoritesBottomActionsRow,
                            { justifyContent: isEditingCountdownFavorites ? 'center' : 'flex-end' }
                          ]}>
                            {countdownFavoriteTimes.length < 18 && (
                              <TouchableOpacity 
                                activeOpacity={0.7}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                style={[
                                  styles.favoritesBottomBtn,
                                  { 
                                    backgroundColor: isEcoMode ? '#322610' : '#FEF08A',
                                    borderColor: isEcoMode ? '#D97706' : '#EAB308',
                                  }
                                ]}
                                onPress={() => {
                                  setNewFavMinStr('0');
                                  setNewFavSecStr('0');
                                  setAddFavKeypadActive('min');
                                  setIsAddFavNewInput(true);
                                  setAddFavTarget('countdown');
                                  setAddFavModalVisible(true);
                                }}
                              >
                                <Text style={[styles.favoritesBottomBtnText, { color: isEcoMode ? '#FDE68A' : '#854D0E' }]}>
                                  ＋ 追加
                                </Text>
                              </TouchableOpacity>
                            )}

                            {isEditingCountdownFavorites && (
                              <TouchableOpacity 
                                activeOpacity={0.7}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                onPress={handleResetCountdownFavorites}
                                style={[
                                  styles.favoritesBottomBtn,
                                  {
                                    backgroundColor: isEcoMode ? '#351C1C' : '#FFF0F0',
                                    borderColor: isEcoMode ? '#6B2020' : '#FFD5D5',
                                  }
                                ]}
                              >
                                <Text style={[styles.favoritesBottomBtnText, { color: '#FF3B30' }]}>
                                  ↺ 初期値に戻す
                                </Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        )}
                      </View>

                    <TouchableOpacity style={styles.closeTimeModalButton} onPress={() => {
                      setCountdownKeypadActive(null);
                      setTimeModalMode('time');
                    }}>
                      <Text style={styles.closeTimeModalText}>戻る</Text>
                    </TouchableOpacity>
                  </>
                )}
              </>
            )}
          </View>

          {/* お気に入り時間追加ポップアップ（二重Modalを回避するインモーダル・オーバーレイ ＆ テンキー入力） */}
          {addFavModalVisible && (
            <View style={[StyleSheet.absoluteFill, styles.addFavOverlayWrapper]}>
              <View style={[styles.addFavModalContent, { backgroundColor: isEcoMode ? '#1C1C1E' : '#fff' }]}>
                <Text style={[styles.timeModalTitle, { color: isEcoMode ? '#fff' : '#000', fontSize: 17, marginBottom: 4 }]}>
                  {addFavTarget === 'countdown' ? '準備時間のお気に入り追加' : 'お気に入り時間の追加'}
                </Text>

                <Text style={{ fontSize: 12, color: isEcoMode ? '#aaa' : '#666', marginBottom: 12, textAlign: 'center' }}>
                  登録したい時間を数字タイルで入力してください
                </Text>

                {/* 分・秒の選択ボックス（タップで切り替え） */}
                <View style={styles.addFavDisplayRow}>
                  <TouchableOpacity 
                    activeOpacity={0.7}
                    onPress={() => {
                      setAddFavKeypadActive('min');
                      setIsAddFavNewInput(true);
                    }}
                    style={[
                      styles.addFavDisplayBox,
                      { 
                        borderColor: addFavKeypadActive === 'min' ? '#007AFF' : (isEcoMode ? '#444' : '#E5E5EA'),
                        backgroundColor: addFavKeypadActive === 'min' 
                          ? (isEcoMode ? 'rgba(0, 122, 255, 0.2)' : 'rgba(0, 122, 255, 0.08)')
                          : (isEcoMode ? '#2C2C2E' : '#F2F2F7'),
                      }
                    ]}
                  >
                    <Text style={[
                      styles.addFavDisplayNumber,
                      { color: addFavKeypadActive === 'min' ? '#007AFF' : (isEcoMode ? '#fff' : '#000') }
                    ]}>
                      {newFavMinStr || '0'}
                    </Text>
                    <Text style={[
                      styles.addFavDisplayUnit,
                      { color: addFavKeypadActive === 'min' ? '#007AFF' : (isEcoMode ? '#aaa' : '#666') }
                    ]}>
                      分
                    </Text>
                  </TouchableOpacity>

                  <Text style={{ fontSize: 22, fontWeight: '700', color: isEcoMode ? '#666' : '#999', marginHorizontal: 6 }}>:</Text>

                  <TouchableOpacity 
                    activeOpacity={0.7}
                    onPress={() => {
                      setAddFavKeypadActive('sec');
                      setIsAddFavNewInput(true);
                    }}
                    style={[
                      styles.addFavDisplayBox,
                      { 
                        borderColor: addFavKeypadActive === 'sec' ? '#007AFF' : (isEcoMode ? '#444' : '#E5E5EA'),
                        backgroundColor: addFavKeypadActive === 'sec' 
                          ? (isEcoMode ? 'rgba(0, 122, 255, 0.2)' : 'rgba(0, 122, 255, 0.08)')
                          : (isEcoMode ? '#2C2C2E' : '#F2F2F7'),
                      }
                    ]}
                  >
                    <Text style={[
                      styles.addFavDisplayNumber,
                      { color: addFavKeypadActive === 'sec' ? '#007AFF' : (isEcoMode ? '#fff' : '#000') }
                    ]}>
                      {newFavSecStr || '0'}
                    </Text>
                    <Text style={[
                      styles.addFavDisplayUnit,
                      { color: addFavKeypadActive === 'sec' ? '#007AFF' : (isEcoMode ? '#aaa' : '#666') }
                    ]}>
                      秒
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* テンキーパッド（3×4グリッド） */}
                <View style={styles.addFavKeypadGrid}>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 'clear', 0, 'backspace'].map((key) => {
                    const isClear = key === 'clear';
                    const isBackspace = key === 'backspace';
                    let label = key;
                    if (isClear) label = 'C';
                    if (isBackspace) label = '⌫';

                    return (
                      <TouchableOpacity
                        key={key}
                        activeOpacity={0.6}
                        style={[
                          styles.addFavKeypadKey,
                          {
                            backgroundColor: (isClear || isBackspace)
                              ? (isEcoMode ? '#2C2C2E' : '#E5E5EA')
                              : (isEcoMode ? '#333333' : '#F2F2F7')
                          }
                        ]}
                        onPress={() => handleAddFavKeypadPress(key)}
                      >
                        <Text
                          style={[
                            styles.addFavKeypadKeyText,
                            {
                              color: isClear 
                                ? '#FF3B30' 
                                : (isEcoMode ? '#ffffff' : '#000000'),
                              fontSize: (isClear || isBackspace) ? 18 : 20,
                            }
                          ]}
                        >
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <View style={{ flexDirection: 'row', gap: 12, width: '100%', marginTop: 14 }}>
                  <TouchableOpacity 
                    style={[styles.addFavCancelBtn, { backgroundColor: isEcoMode ? '#333' : '#E5E5EA' }]} 
                    onPress={() => setAddFavModalVisible(false)}
                  >
                    <Text style={[styles.addFavCancelBtnText, { color: isEcoMode ? '#fff' : '#333' }]}>キャンセル</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={[styles.addFavSubmitBtn, { backgroundColor: '#007AFF' }]} 
                    onPress={addFavTarget === 'countdown' ? handleAddCountdownFavorite : handleAddFavorite}
                  >
                    <Text style={styles.addFavSubmitBtnText}>追加する</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
        </View>
      </Modal>

      {/* Proプラン（月額100円）購入モーダル */}
      <ProSubscriptionModal visible={proModalVisible} onClose={() => setProModalVisible(false)} />

    </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topBalanceContainer: {
    height: screenHeight < 700 ? 54 : 84, // bottomActionArea (height 64 + marginTop 20 = 84) と釣り合わせ、タイマー位置をスタート前の中央位置に完全一致させる
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickAccessBarWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickAccessBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 22,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  quickAccessButton: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 16,
    minWidth: 48,
  },
  quickAccessButtonActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  quickAccessButtonActiveEco: {
    backgroundColor: '#2C2C2E',
  },
  quickAccessLabel: {
    fontSize: 10,
    fontWeight: '600',
    marginTop: 2,
  },
  quickAccessDivider: {
    width: 1,
    height: 18,
    marginHorizontal: 1,
  },
  timerContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: screenHeight < 700 ? 30 : 60,
  },
  timeTextContainer: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
  },
  timeText: {
    fontSize: 48,
    fontWeight: '500',
    fontVariant: ['tabular-nums'], // 数字の幅を等間隔にして揺れを防止
  },
  preCountdownText: {
    fontSize: 120, // 枠いっぱいの大きなサイズ
    fontWeight: 'bold',
    fontVariant: ['tabular-nums'], // こちらも揺れを防止
  },
  controlsContainer: {
    flexDirection: 'row',
    gap: 20,
    marginBottom: 30, // saveボタンなどの余白
  },
  bottomActionArea: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    height: 64, // 計測終了ボタンの高さに合わせて固定領域を確保し、スタート前後の位置ズレを防止
    marginTop: 20,
  },
  button: {
    backgroundColor: '#007AFF', // ブルー
    paddingVertical: 15,
    paddingHorizontal: 30,
    borderRadius: 30,
  },
  resetButton: {
    backgroundColor: '#E5E5EA',
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  saveActionButton: {
    backgroundColor: '#34C759', // グリーン
    height: 54,
    paddingHorizontal: 40,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveActionText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  endMeasurementButton: {
    backgroundColor: '#FF3B30', // 赤色
    height: 64,
    paddingHorizontal: 40,
    borderRadius: 10,
    width: 280, // 上のボタン2つ分と左右の幅を揃える
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  splitEndButtonContainer: {
    flexDirection: 'row',
    width: 280,
    height: 64,
    borderRadius: 10,
    overflow: 'hidden',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  splitEndButtonHalf: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  splitEndButtonDivider: {
    width: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
  },
  splitEndButtonMainText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  splitEndButtonSubText: {
    color: '#fff',
    fontSize: 11,
    marginTop: 2,
    fontWeight: '600',
  },
  endMeasurementText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  adBanner: {
    height: 50,
    backgroundColor: '#D1D1D6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  adText: {
    color: '#333',
    fontWeight: 'bold',
    fontSize: 16,
  },
  // モーダル用
  modalContainer: {
    padding: 30,
    marginTop: 50,
    backgroundColor: '#fff',
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 30,
    textAlign: 'center',
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
    fontSize: 16,
  },
  categoryChipsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 5,
  },
  categoryChip: {
    paddingVertical: 8,
    paddingHorizontal: 15,
    backgroundColor: '#E5E5EA',
    borderRadius: 20,
    marginRight: 10,
    marginBottom: 10,
  },
  categoryChipSelected: {
    backgroundColor: '#007AFF',
  },
  categoryChipText: {
    fontSize: 14,
    color: '#333',
  },
  categoryChipTextSelected: {
    color: '#fff',
    fontWeight: 'bold',
  },
  categoryChipAdd: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  categoryChipTextAdd: {
    color: '#007AFF',
    fontWeight: 'bold',
  },
  addCategoryContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 15,
  },
  addCategoryButton: {
    backgroundColor: '#34C759',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  addCategoryButtonText: {
    color: '#fff',
    fontWeight: 'bold',
  },
  photoActionBox: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  photoButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
  },
  photoButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  // 時間設定モーダル用スタイル
  timeModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  timeModalContent: {
    width: '90%',
    borderRadius: 15,
    padding: 20,
    alignItems: 'center',
    maxWidth: 400,
  },
  timeModalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  manualInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 25,
    justifyContent: 'center',
  },
  timeInput: {
    borderWidth: 1,
    borderRadius: 8,
    width: 80,
    height: 45,
    textAlign: 'center',
    fontSize: 20,
  },
  timeInputLabel: {
    fontSize: 18,
    marginHorizontal: 10,
    fontWeight: 'bold',
  },
  applyButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  applyButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
    textAlign: 'center',
  },
  presetTilesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10,
  },
  presetTile: {
    width: '30%',
    aspectRatio: 2,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
    marginBottom: 10,
  },
  presetTileText: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  closeTimeModalButton: {
    marginTop: 15,
    padding: 10,
  },
  closeTimeModalText: {
    fontSize: 16,
    color: '#007AFF',
    fontWeight: 'bold',
  },
  countdownSettingCard: {
    marginTop: 20,
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  countdownSettingCardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 6,
  },
  countdownSettingCardSub: {
    fontSize: 14,
    marginBottom: 6,
  },
  countdownSettingCardStatus: {
    fontSize: 14,
    fontWeight: '600',
  },
  countdownSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  countdownSectionLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 15,
    marginBottom: 10,
    color: '#888',
  },
  // テンキー用スタイル
  keypadInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    marginBottom: 15,
  },
  keypadInputBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: 100,
    height: 50,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  keypadInputValue: {
    fontSize: 24,
    fontWeight: 'bold',
    marginRight: 6,
  },
  keypadInputUnit: {
    fontSize: 15,
    fontWeight: 'bold',
  },
  keypadWrapper: {
    width: '100%',
    alignItems: 'center',
    marginTop: 5,
  },
  keypadGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    width: '100%',
    gap: 8,
  },
  keypadKey: {
    width: '31%',
    height: 48,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  keypadKeyText: {
    fontSize: 22,
    fontWeight: '600',
  },
  // お気に入り枠用スタイル（黄色アコーディオン）
  favoritesCard: {
    width: '100%',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  favoritesHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 2,
    paddingVertical: 2,
  },
  favoritesTitle: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  favoritesEditBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  favoritesEditBtnText: {
    fontSize: 12,
    fontWeight: 'bold',
  },
  accordionToggleBadge: {
    width: 26,
    height: 24,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accordionToggleText: {
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  favoritesTilesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    gap: 8,
    paddingTop: 8,
    paddingHorizontal: 4,
    paddingBottom: 6,
  },
  favoriteTileWrapper: {
    width: '31%',
    marginBottom: 0,
    position: 'relative',
  },
  customScrollTrack: {
    position: 'absolute',
    right: 2,
    top: 8,
    bottom: 8,
    width: 3.5,
    borderRadius: 2,
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
  },
  customScrollThumb: {
    width: 3.5,
    borderRadius: 2,
  },
  favoriteTile: {
    width: '100%',
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
  },
  favoriteTileText: {
    fontSize: 15,
    fontWeight: 'bold',
  },
  favoriteDeleteBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: '#FF3B30',
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#fff',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
  },
  favoriteDeleteBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: 'bold',
    lineHeight: 13,
  },
  favoritesBottomActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
    paddingTop: 2,
    paddingHorizontal: 4,
  },
  favoritesBottomBtn: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  favoritesBottomBtnText: {
    fontSize: 12,
    fontWeight: 'bold',
  },
  addFavoriteTile: {
    borderStyle: 'dashed',
    width: '31%',
    height: 44,
    marginBottom: 6,
  },
  addFavoriteTileText: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  addFavOverlayWrapper: {
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
    elevation: 10,
    borderRadius: 20, // 親モーダルの角丸に合わせる
  },
  addFavModalContent: {
    width: '88%',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    maxWidth: 360,
  },
  addFavDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  addFavDisplayBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: 96,
    height: 44,
    borderRadius: 10,
    borderWidth: 1.5,
    paddingHorizontal: 8,
  },
  addFavDisplayNumber: {
    fontSize: 22,
    fontWeight: 'bold',
    marginRight: 4,
  },
  addFavDisplayUnit: {
    fontSize: 13,
    fontWeight: '600',
  },
  addFavKeypadGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    width: '100%',
    gap: 8,
  },
  addFavKeypadKey: {
    width: '31%',
    height: 42,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addFavKeypadKeyText: {
    fontSize: 20,
    fontWeight: '600',
  },
  addFavCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  addFavCancelBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
  addFavSubmitBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  addFavSubmitBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold',
  },
  // 直接入力枠用スタイル（案A用・保持）
  directInputCard: {
    width: '100%',
    borderWidth: 1.5,
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
  },
  directInputHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  directInputTitle: {
    fontSize: 15,
    fontWeight: 'bold',
  },
  directInputSubtitle: {
    fontSize: 12,
    fontWeight: '600',
  },
  // 案B: デジタル液晶ディスプレイ風タイマーパネル用スタイル
  timerDisplayCard: {
    width: '100%',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 2,
    marginBottom: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 4,
  },
  timerDisplayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  timerDisplayLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  timerDisplayEditBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
  },
  timerDisplayEditText: {
    fontSize: 11,
    fontWeight: '700',
  },
  timerDisplayDigitsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 2,
  },
  timerDigitSegment: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 12,
    position: 'relative',
    minWidth: 92,
  },
  timerDigitSegmentActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.16)',
  },
  timerDigitNumber: {
    fontSize: 38,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  timerDigitUnit: {
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 4,
  },
  timerDigitSeparator: {
    fontSize: 32,
    fontWeight: '800',
    color: '#64748B',
    marginHorizontal: 4,
    marginBottom: 4,
  },
  timerActiveBar: {
    position: 'absolute',
    bottom: 2,
    left: 12,
    right: 12,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#38BDF8',
  },
});
