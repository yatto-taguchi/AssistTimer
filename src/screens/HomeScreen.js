import React, { useState, useEffect, useRef, useContext, useCallback } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Modal, TextInput, Alert, ScrollView, Switch, Animated, TouchableWithoutFeedback, Image, FlatList, Dimensions, AppState, Vibration, LayoutAnimation, KeyboardAvoidingView, Platform } from 'react-native';
const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
import { useIsFocused } from '@react-navigation/native';
import ImageViewer from 'react-native-image-zoom-viewer';
import AsyncStorage from '@react-native-async-storage/async-storage';
// 必要なモジュールのインポート
import { Audio } from 'expo-av';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import RingProgress from '../components/RingProgress';
import HomeStatsSummary from '../components/HomeStatsSummary';
import { AppContext } from '../utils/AppContext';
import { saveRecord, getRecords, formatRecordDateTime } from '../utils/recordStorage';
import { recordInterruption, getFullPracticeStats, getQuickStatsSummary } from '../utils/practiceStats';
import AdBannerComponent from '../components/AdBannerComponent';
import ProSubscriptionModal from '../components/ProSubscriptionModal';
import CheerYamaimoOverlay from '../components/CheerYamaimoOverlay';
import NewsBadge from '../components/NewsBadge';
import NewsModal from '../components/NewsModal';
import { getUnreadNewsCount } from '../data/newsData';
import { setAlarms, stopAllAlarms, subscribeUserStoppedAlarms } from '../utils/alarmScheduler';
import WatchConnectivity from 'watch-connectivity';
import { syncSeatsToWatch, syncMainTimerToWatch, updateCachedMainTimerState, ensureSalonSeatsCached } from './SalonWorkScreen';

const MAIN_ALARM_KEY = 'main-timer';

const SILENT_LOOP_SOUND = require('../../assets/silent_loop.wav');

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
  const soundRef = useRef(null);
  const voiceSoundRef = useRef(null);

  // 記録・保存用State
  const [saveModalVisible, setSaveModalVisible] = useState(false);
  const [saveModalSnapshot, setSaveModalSnapshot] = useState(null);
  const [saveIsFavorite, setSaveIsFavorite] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [savedCategories, setSavedCategories] = useState(['カット', 'カラー', 'ワインディング', 'アップスタイル']);
  const [lastUsedCategory, setLastUsedCategory] = useState('');
  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [photoUris, setPhotoUris] = useState([]);
  const [fullScreenIndex, setFullScreenIndex] = useState(null);
  const [forceTargetTime, setForceTargetTime] = useState(false);
  const [selectedTags, setSelectedTags] = useState([]);
  const [recordDate, setRecordDate] = useState(null);

  // ホーム画面ジャンル選択モーダル用State
  const [genreModalVisible, setGenreModalVisible] = useState(false);
  const [isAddingGenreModal, setIsAddingGenreModal] = useState(false);
  const [newGenreNameInput, setNewGenreNameInput] = useState('');
  const [genreStatsMap, setGenreStatsMap] = useState({});
  const [homeQuickStats, setHomeQuickStats] = useState(null);

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
    isNormalTargetTimeEnabled,
    isEcoTargetTimeEnabled,
    isHomeStatsEnabled,
    isHomeStatsCollapsed,
    toggleHomeStatsCollapsed,
    isQuickAccessBarEnabled,
    controlsOpacity,
    controlsVisible,
    showControls,
    resetControlsVisible,
    isCheerModeEnabled,
    isCheerInEcoEnabled,
    isCheerSoundEnabled,
    readNewsIds,
    isNewsHiddenUntilNext,
    markNewsAsRead,
    markAllNewsAsRead,
    hideNewsUntilNextUpdate,
    restoreNewsIcon,
    setMainTimerState,
    mainTimerActionRequest
  } = useContext(AppContext);
  const isFocused = useIsFocused();

  // NEWS（お知らせ）用State
  const [newsModalVisible, setNewsModalVisible] = useState(false);
  const unreadNewsCount = getUnreadNewsCount(readNewsIds);

  // 応援キャラクター【やまいも】Ref
  const cheerOverlayRef = useRef(null);
  const saveModalCheerRef = useRef(null);
  const lastCheerTriggerTimeRef = useRef(0);
  const nextCheerIntervalMsRef = useRef(0);
  const isFirstCheerTriggeredRef = useRef(false);

  // 記録保存モーダル（SaveModal）オープン時のやまいも連動
  useEffect(() => {
    if (saveModalVisible) {
      const timer = setTimeout(() => {
        const snapIsCountUp = saveModalSnapshot ? saveModalSnapshot.isCountUp : isCountUp;
        const isOver = snapIsCountUp && !forceTargetTime;
        if (isOver) {
          saveModalCheerRef.current?.trigger('overtime_start', 0.65);
        } else {
          saveModalCheerRef.current?.trigger('finish_success', 0.65);
        }
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [saveModalVisible, saveModalSnapshot, isCountUp, forceTargetTime]);

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
  const lastIdleCheerTimeRef = useRef(0);
  const idleCheerTimeoutRef = useRef(null);
  const lastAutoFinishedAtRef = useRef(0);
  const lastAutoFinishedEndTimestampRef = useRef(0);

  // ★ Watch主導タイマー操作によるiPhone消音管理（Watchから開始時はデフォルト消音、ウォッチ振動のみ）
  const [isWatchMuted, setIsWatchMuted] = useState(false);
  const isWatchMutedRef = useRef(false);
  const setWatchMutedState = useCallback((muted) => {
    isWatchMutedRef.current = muted;
    setIsWatchMuted(muted);
  }, []);

  // 待機中（Idle）やまいもウォーキング演出のトリガーヘルパー
  const triggerIdleCheer = useCallback((chance = 0.85, delayMs = 1500) => {
    if (idleCheerTimeoutRef.current) {
      clearTimeout(idleCheerTimeoutRef.current);
    }
    idleCheerTimeoutRef.current = setTimeout(() => {
      // タイマーが動いていない（待機中）ことを確認
      if (!isRunningRef.current && !isPreCountingDownRef.current) {
        const todayCount = (homeQuickStats?.todaySessions || 0) + 1;
        lastIdleCheerTimeRef.current = Date.now();
        console.log('[HomeScreen] Idle cheer walker triggered! todayCount:', todayCount);
        cheerOverlayRef.current?.trigger('idle', chance, { todayCount });
      }
    }, delayMs);
  }, [homeQuickStats?.todaySessions]);

  // バイブレーション制御ヘルパー（強度およびタイミング個別設定対応）
  // ※ Watch側の「携帯の音 OFF（isWatchMuted）」は音声・アラーム音のみをミュートし、バイブレーションは設定に従い常に作動させる
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

  const silentSoundRef = useRef(null);
  const shouldPlaySilentAudioRef = useRef(false);
  const isLoadingSilentAudioRef = useRef(false);

  // バックグラウンドでのJSサスペンド防止用無音オーディオ再生（レースコンディション防止ガード付き）
  const startSilentBackgroundAudio = async () => {
    shouldPlaySilentAudioRef.current = true;
    if (silentSoundRef.current || isLoadingSilentAudioRef.current) return;
    isLoadingSilentAudioRef.current = true;
    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: playsInSilentMode,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      const { sound: s } = await Audio.Sound.createAsync(
        SILENT_LOOP_SOUND,
        { isLooping: true, volume: 0.001 }
      );
      // ロード中に一時停止やリセットが押されていた場合は即アンロード
      if (!shouldPlaySilentAudioRef.current) {
        await s.stopAsync().catch(() => {});
        await s.unloadAsync().catch(() => {});
        silentSoundRef.current = null;
      } else {
        silentSoundRef.current = s;
        await s.playAsync();
      }
    } catch (err) {
      console.log('startSilentBackgroundAudio error', err);
    } finally {
      isLoadingSilentAudioRef.current = false;
    }
  };

  const stopSilentBackgroundAudio = async () => {
    shouldPlaySilentAudioRef.current = false;
    try {
      if (silentSoundRef.current) {
        const s = silentSoundRef.current;
        silentSoundRef.current = null;
        await s.stopAsync().catch(() => {});
        await s.unloadAsync().catch(() => {});
      }
    } catch (err) {
      console.log('stopSilentBackgroundAudio error', err);
    }
  };

  // タイマー進行中のみ画面スリープ防止（常時点灯）およびバックグラウンド音声維持を完全連動（準備→本番の無瞬断化）
  useEffect(() => {
    const isTimerActive = isPreCountingDown || isRunning;
    if (isTimerActive) {
      activateKeepAwakeAsync();
      startSilentBackgroundAudio();
    } else {
      deactivateKeepAwake();
      stopSilentBackgroundAudio();
    }
  }, [isPreCountingDown, isRunning, playsInSilentMode]);

  // 初回起動時のサウンドロード等と再生用関数
  const playAlarm = async () => {
    triggerVibration('finish');
    if (isWatchMutedRef.current) {
      console.log('[HomeScreen] Alarm sound suppressed (Watch muted)');
      return;
    }
    if (!isAlarmSoundEnabled || alarmSoundType === 'none') {
      console.log('Alarm sound is muted or set to none (silent)');
      return;
    }
    try {
      console.log('Play Alarm trigger: 0 seconds reached');
      if (soundRef.current) {
        await soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      } else if (sound) {
        await sound.unloadAsync().catch(() => {});
      }
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: playsInSilentMode,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      const soundFile = ALARM_SOUNDS[alarmSoundType] || ALARM_SOUNDS.digital;
      const { sound: newSound } = await Audio.Sound.createAsync(soundFile);
      soundRef.current = newSound;
      setSound(newSound);
      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) {
          if (soundRef.current === newSound) soundRef.current = null;
          newSound.unloadAsync().catch(() => {});
        }
      });
      await newSound.playAsync();
    } catch (e) {
      console.log("Audio play error", e);
    }
  };

  const playVoice = async (key) => {
    if (isWatchMutedRef.current) {
      console.log('[HomeScreen] Voice announcement suppressed (Watch muted)');
      return;
    }
    if (!isVoiceMasterEnabled) {
      console.log('Voice announcement is muted by master switch');
      return;
    }
    try {
      if (voiceSoundRef.current) {
        await voiceSoundRef.current.unloadAsync().catch(() => {});
        voiceSoundRef.current = null;
      } else if (voiceSound) {
        await voiceSound.unloadAsync().catch(() => {});
      }
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: playsInSilentMode,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      const soundFile = VOICE_SOUNDS[key];
      if (!soundFile) return;
      const { sound: newVoice } = await Audio.Sound.createAsync(soundFile);
      voiceSoundRef.current = newVoice;
      setVoiceSound(newVoice);
      newVoice.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) {
          if (voiceSoundRef.current === newVoice) voiceSoundRef.current = null;
          newVoice.unloadAsync().catch(() => {});
        }
      });
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
    cancelVibration();
    return () => {
      cancelVibration();
      deactivateKeepAwake();
      stopSilentBackgroundAudio();
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
            const endedPrepAt = prepEndTimeRef.current;
            isPreCountingDownRef.current = false;
            setIsPreCountingDown(false);
            prepEndTimeRef.current = null;
            // 準備カウント終了、本番タイマー開始（スリープ中の経過時間も正確に考慮）
            const finalTarget = targetTimeRef.current || targetTime || 600;
            const newTargetEnd = endedPrepAt + finalTarget * 1000;
            targetEndTimeRef.current = newTargetEnd;
            triggeredVoicesRef.current.clear();
            const nextRem = Math.max(0, Math.ceil((newTargetEnd - now) / 1000));
            remainingTimeRef.current = nextRem;
            setRemainingTime(nextRem);
            isRunningRef.current = true;
            setIsRunning(true);
          }
        }
        if (!isPreCountingDownRef.current && isRunningRef.current) {
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
                lastAutoFinishedAtRef.current = now;
                lastAutoFinishedEndTimestampRef.current = targetEndTimeRef.current || now;
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
  }, [targetTime, isCountUpEnabled]);

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

        // カウント進行中の経過コール（スロットリングによるスキップ防止のレンジ判定）
        if (countdownSeconds > 900 && nextTime <= 900 && nextTime > 600 && isPrepVoice15MinEnabled && !triggeredPrepVoicesRef.current.has(900)) {
          triggeredPrepVoicesRef.current.add(900);
          playVoice('prep_15min');
        } else if (countdownSeconds > 600 && nextTime <= 600 && nextTime > 300 && isPrepVoice10MinEnabled && !triggeredPrepVoicesRef.current.has(600)) {
          triggeredPrepVoicesRef.current.add(600);
          playVoice('prep_10min');
        } else if (countdownSeconds > 300 && nextTime <= 300 && nextTime > 240 && isPrepVoice5MinEnabled && !triggeredPrepVoicesRef.current.has(300)) {
          triggeredPrepVoicesRef.current.add(300);
          playVoice('prep_5min');
        } else if (countdownSeconds > 240 && nextTime <= 240 && nextTime > 180 && isPrepVoice4MinEnabled && !triggeredPrepVoicesRef.current.has(240)) {
          triggeredPrepVoicesRef.current.add(240);
          playVoice('prep_4min');
        } else if (countdownSeconds > 180 && nextTime <= 180 && nextTime > 120 && isPrepVoice3MinEnabled && !triggeredPrepVoicesRef.current.has(180)) {
          triggeredPrepVoicesRef.current.add(180);
          playVoice('prep_3min');
        } else if (countdownSeconds > 120 && nextTime <= 120 && nextTime > 60 && isPrepVoice2MinEnabled && !triggeredPrepVoicesRef.current.has(120)) {
          triggeredPrepVoicesRef.current.add(120);
          playVoice('prep_2min');
        } else if (countdownSeconds > 60 && nextTime <= 60 && nextTime > 30 && isPrepVoice1MinEnabled && !triggeredPrepVoicesRef.current.has(60)) {
          triggeredPrepVoicesRef.current.add(60);
          playVoice('prep_1min');
        } else if (countdownSeconds > 30 && nextTime <= 30 && nextTime > 10 && isPrepVoice30SecEnabled && !triggeredPrepVoicesRef.current.has(30)) {
          triggeredPrepVoicesRef.current.add(30);
          playVoice('prep_30sec');
        } else if (countdownSeconds > 10 && nextTime <= 10 && nextTime > 5 && isPrepVoice10SecEnabled && !triggeredPrepVoicesRef.current.has(10)) {
          triggeredPrepVoicesRef.current.add(10);
          playVoice('prep_10sec');
          triggerVibration('prep');
        } else if (countdownSeconds > 5 && nextTime <= 5 && nextTime > 0 && isPrepVoiceCountdownEnabled && !triggeredPrepVoicesRef.current.has(5)) {
          triggeredPrepVoicesRef.current.add(5);
          playVoice('prep_countdown_5'); // 5秒前から「5,4,3,2,1 スタート！」
          triggerVibration('countdown');
        }

        // 準備時間中のやまいもウォーキング応援
        // 開始1秒後（最初の秒数カウントダウン時）に100%確定で即座に歩き出す！
        const prepElapsedSec = countdownSeconds - nextTime;
        if (prepElapsedSec >= 1 && !triggeredPrepVoicesRef.current.has('cheer_prep_first')) {
          triggeredPrepVoicesRef.current.add('cheer_prep_first');
          console.log('[HomeScreen] Prep cheer walker triggered! elapsed:', prepElapsedSec);
          cheerOverlayRef.current?.trigger('prep', 1.0, { prepSeconds: countdownSeconds });
        } else if (countdownSeconds >= 30 && nextTime === Math.floor(countdownSeconds / 2) && !triggeredPrepVoicesRef.current.has('cheer_prep_mid')) {
          triggeredPrepVoicesRef.current.add('cheer_prep_mid');
          cheerOverlayRef.current?.trigger('prep', 0.65, { prepSeconds: countdownSeconds });
        }

        if (diffMs <= 0) {
          clearInterval(interval);
          const finishedPrepEnd = prepEndTimeRef.current || now;
          prepEndTimeRef.current = null;
          isPreCountingDownRef.current = false;
          setIsPreCountingDown(false);
          cheerOverlayRef.current?.dismiss(); // 準備中のやまいもが残っていればスッと消去
          // カウントダウン終了後、メインタイマー開始（準備開始時に予約した finishedPrepEnd + finalTarget * 1000 と完全一致させる）
          const finalTarget = targetTimeRef.current || targetTime || 600;
          targetEndTimeRef.current = finishedPrepEnd + finalTarget * 1000;
          triggeredVoicesRef.current.clear();
          remainingTimeRef.current = finalTarget;
          setRemainingTime(finalTarget);
          lastCheerTriggerTimeRef.current = now;
          isFirstCheerTriggeredRef.current = false;
          nextCheerIntervalMsRef.current = 0;
          isRunningRef.current = true;
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

          // 音声アナウンス＆バイブレーションのトリガー（スロットリングによるスキップ防止のレンジ判定）
          if (targetTime > 300 && nextTime <= 300 && nextTime > 180 && isVoice5MinEnabled && !triggeredVoicesRef.current.has(300)) {
            triggeredVoicesRef.current.add(300);
            playVoice('v_5min');
          } else if (targetTime > 180 && nextTime <= 180 && nextTime > 60 && isVoice3MinEnabled && !triggeredVoicesRef.current.has(180)) {
            triggeredVoicesRef.current.add(180);
            playVoice('v_3min');
          } else if (targetTime > 60 && nextTime <= 60 && nextTime > 30 && isVoice1MinEnabled && !triggeredVoicesRef.current.has(60)) {
            triggeredVoicesRef.current.add(60);
            playVoice('v_1min');
            triggerVibration('warning');
          } else if (targetTime > 30 && nextTime <= 30 && nextTime > 10 && isVoice30SecEnabled && !triggeredVoicesRef.current.has(30)) {
            triggeredVoicesRef.current.add(30);
            playVoice('v_30sec');
            triggerVibration('warning');
          } else if (targetTime > 10 && nextTime <= 10 && nextTime > 5 && isVoice10SecEnabled && !triggeredVoicesRef.current.has(10)) {
            triggeredVoicesRef.current.add(10);
            playVoice('v_10sec');
            triggerVibration('warning');
          } else if (targetTime > 5 && nextTime <= 5 && nextTime > 0 && isVoiceFinishEnabled && !triggeredVoicesRef.current.has(5)) {
            triggeredVoicesRef.current.add(5);
            playVoice('v_finish'); // 「5,4,3,2,1 終了」カウントダウン開始
            triggerVibration('countdown');
          }

          // 計測中のランダムやまいも登場
          // ① 初回確定演出: スタート後わずか3〜5秒で即座に「走るやつ」が100%確定駆け抜け！
          //    （5秒や3秒などの極短タイマーでも開始1秒後・0秒直前まで確実に駆け抜ける）
          // ② 2回目以降: タイマー長さに応じたインテリジェント・インターバル
          const elapsedSec = targetTime - nextTime;
          const minElapsedBeforeFirst = 1; // スタート後わずか1秒で即時確定発動！
          const minRemainingSec = targetTime <= 3 ? 0 : 1;

          if (!isFirstCheerTriggeredRef.current) {
            if (elapsedSec >= minElapsedBeforeFirst && nextTime >= minRemainingSec) {
              isFirstCheerTriggeredRef.current = true;
              lastCheerTriggerTimeRef.current = now;
              // 次回インターバルをタイマー長さに応じて設定
              if (targetTime <= 180) {
                // 3分以下: 30〜50秒
                nextCheerIntervalMsRef.current = (Math.floor(Math.random() * (50 - 30 + 1)) + 30) * 1000;
              } else if (targetTime <= 600) {
                // 3〜10分: 60〜100秒
                nextCheerIntervalMsRef.current = (Math.floor(Math.random() * (100 - 60 + 1)) + 60) * 1000;
              } else {
                // 10分以上: 120〜240秒（2〜4分）
                nextCheerIntervalMsRef.current = (Math.floor(Math.random() * (240 - 120 + 1)) + 120) * 1000;
              }
              // 初回は100%確実に出現し、走るやつ（広告バナー上ランナー）を優先確定発動！（序盤フェーズ: スタート・ファイト等）
              console.log('[HomeScreen] First cheer runner triggered! elapsedSec:', elapsedSec);
              cheerOverlayRef.current?.trigger('running', 1.0, { forceBannerRunner: true, phase: 'early' });
            }
          } else {
            const cheerIntervalMs = nextCheerIntervalMsRef.current || 60000;
            if (now - lastCheerTriggerTimeRef.current >= cheerIntervalMs && nextTime >= minRemainingSec) {
              lastCheerTriggerTimeRef.current = now;
              if (targetTime <= 180) {
                nextCheerIntervalMsRef.current = (Math.floor(Math.random() * (50 - 30 + 1)) + 30) * 1000;
              } else if (targetTime <= 600) {
                nextCheerIntervalMsRef.current = (Math.floor(Math.random() * (100 - 60 + 1)) + 60) * 1000;
              } else {
                nextCheerIntervalMsRef.current = (Math.floor(Math.random() * (240 - 120 + 1)) + 120) * 1000;
              }
              // タイマー進行フェーズを判定（残り60秒以内または70%以上はlate、30%未満はearly、それ以外はmid）
              const progress = targetTime > 0 ? (targetTime - nextTime) / targetTime : 0;
              const phase = nextTime <= 60 || progress >= 0.70 ? 'late' : (progress < 0.30 ? 'early' : 'mid');
              cheerOverlayRef.current?.trigger('running', 0.85, { phase });
            }
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
              cheerOverlayRef.current?.trigger('overtime_start', 0.85);
            } else {
              lastAutoFinishedAtRef.current = now;
              lastAutoFinishedEndTimestampRef.current = targetEndTimeRef.current || now;
              isCountUpRef.current = false;
              setIsCountUp(false);
              isRunningRef.current = false;
              setIsRunning(false);
              targetEndTimeRef.current = null;
              overStartTimeRef.current = null;
              remainingTimeRef.current = 0;
              setRemainingTime(0);
              resetControlsVisible();
              cheerOverlayRef.current?.trigger('finish_success', 0.85);
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

          // カウントアップ（超過時間中）のランダムやまいも登場（超過時演出：最低45秒インターバル＋超過開始直後を避ける）
          if (now - lastCheerTriggerTimeRef.current >= 45000 && nextTime >= 20) {
            lastCheerTriggerTimeRef.current = now;
            cheerOverlayRef.current?.trigger('overtime_start', 0.65);
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
    vibrationIntensity, isVibWarningEnabled, isVibFinishEnabled, isVibOvertimeEnabled, targetTime
  ]);

  // ★ メインタイマーの終了時刻を iPhone 純正アラーム（AlarmKit）に予約
  // 画面ロック中・バックグラウンドでも、ユーザーが止めるまで鳴り続ける。
  // 終了時刻は複数箇所（開始・再開・準備カウント終了・復帰時など）で ref が更新されるため、
  // 動作中は1秒ごとに現在値を渡し、alarmScheduler 側で差分がある時だけ予約し直す。
  useEffect(() => {
    const soundOn = isAlarmSoundEnabled && !isWatchMuted;
    const buildDesired = () => {
      let ts = null;
      if (isPreCountingDown && prepEndTimeRef.current) {
        ts = prepEndTimeRef.current + targetTime * 1000;
      } else if (isRunning && !isCountUp && targetEndTimeRef.current) {
        ts = targetEndTimeRef.current;
      } else if (isRunning && isCountUp && overStartTimeRef.current) {
        // 超過中は「鳴っているアラーム」を一覧に残しておく（過去時刻なので再予約はされない）
        ts = overStartTimeRef.current;
      }
      return ts ? [{ key: MAIN_ALARM_KEY, timestamp: ts, title: '⏰ タイマー終了' }] : [];
    };
    const apply = () => setAlarms('main', buildDesired(), { soundOn, stopPassedOnRemove: false });
    apply();
    if (!isRunning && !isPreCountingDown) return undefined;
    const id = setInterval(apply, 1000);
    return () => clearInterval(id);
  }, [isRunning, isCountUp, isPreCountingDown, isAlarmSoundEnabled, targetTime, isWatchMuted]);

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

  const formatTargetTime = (timeInSeconds) => {
    const absTime = Math.abs(timeInSeconds);
    const h = Math.floor(absTime / 3600);
    const m = Math.floor((absTime % 3600) / 60);
    const s = absTime % 60;
    
    if (h > 0) {
      // 1時間以上の場合： h:mm:ss （時は0埋めなし、分と秒は2桁）
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    // 1時間未満の場合： m:ss （分は0埋めなし、秒は2桁）
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const toggleTimer = (isFromWatch = false, watchTiming = null) => {
    const fromWatch = isFromWatch === true;
    if (!fromWatch) {
      setWatchMutedState(false);
    }
    const currentIsRunning = isRunningRef.current;
    const currentIsPreCountdown = isPreCountingDownRef.current;
    const currentIsCountUp = isCountUpRef.current;
    const currentRemaining = remainingTimeRef.current;
    const currentTarget = targetTimeRef.current || targetTime || 600;
    const effectiveRemaining = (!currentIsRunning && !currentIsCountUp && currentRemaining <= 0)
      ? currentTarget
      : currentRemaining;

    // ★ カウントダウン有効時はWatchからの開始でも準備カウントダウンを正常に発動
    //   ただしWatch側がすでに本番カウントダウン中（targetEndTimestamp > now かつ prepEndTimestamp <= now）なら直接本番カウントダウンへ合流
    const isInitialStart = (effectiveRemaining === currentTarget) || (!currentIsCountUp && effectiveRemaining >= currentTarget);
    const cfgCountdownEnabled = !!isCountdownEnabledRef.current;
    const cfgCountdownSec = countdownSecondsRef.current || countdownSeconds || 5;
    const incomingMainEndTs = Number(watchTiming?.targetEndTimestamp || 0);
    const watchHasDirectMainEnd = fromWatch
      && incomingMainEndTs > Date.now() - 3 * 3600 * 1000
      && Number(watchTiming?.prepEndTimestamp || 0) <= Date.now();
    if (!currentIsRunning && !currentIsPreCountdown && isInitialStart && cfgCountdownEnabled && cfgCountdownSec > 0 && !watchHasDirectMainEnd) {
      // 初期状態からのスタートでカウントダウン有効の場合、準備カウントダウンを開始
      const defaultPrepEndMs = Date.now() + cfgCountdownSec * 1000;
      const incomingPrepEndMs = Number(watchTiming?.prepEndTimestamp || 0);
      prepEndTimeRef.current = (incomingPrepEndMs > Date.now() && Math.abs(incomingPrepEndMs - defaultPrepEndMs) <= 15000)
        ? incomingPrepEndMs
        : defaultPrepEndMs;
      const defaultMainEndMs = prepEndTimeRef.current + currentTarget * 1000;
      const incomingMainEndMs = Number(watchTiming?.targetEndTimestamp || 0);
      const effectivePrepMainEndMs = (incomingMainEndMs > Date.now() && Math.abs(incomingMainEndMs - defaultMainEndMs) <= 15000)
        ? incomingMainEndMs
        : defaultMainEndMs;
      lastAutoFinishedAtRef.current = 0;
      lastAutoFinishedEndTimestampRef.current = 0;
      lastResetTargetEndRef.current = 0;
      lastMainTimerResetAtRef.current = 0;
      triggeredPrepVoicesRef.current.clear();
      remainingTimeRef.current = currentTarget;
      setRemainingTime(currentTarget);
      preCountdownTimeRef.current = cfgCountdownSec;
      setPreCountdownTime(cfgCountdownSec);
      isPreCountingDownRef.current = true;
      setIsPreCountingDown(true);

      if (Platform.OS === 'ios') {
        const prepState = {
          explicitStop: false,
          isExplicitReset: false,
          isAutoFinished: false,
          remainingTime: currentTarget,
          targetTime: currentTarget,
          targetEndTimestamp: effectivePrepMainEndMs,
          lastResetTargetEndTimestamp: 0,
          lastResetAt: 0,
          isRunning: false,
          isPaused: false,
          isCountUp: false,
          isCountUpEnabled: !!isCountUpEnabledRef.current,
          genre: selectedCategoryRef.current || selectedCategory || '',
          isPreCountingDown: true,
          preCountdownSeconds: cfgCountdownSec,
          isCountdownConfigEnabled: cfgCountdownEnabled,
          countdownConfigSeconds: cfgCountdownSec,
          prepEndTimestamp: prepEndTimeRef.current,
        };
        if (setMainTimerState) {
          setMainTimerState(prepState);
        }
        updateCachedMainTimerState(prepState);
        syncMainTimerToWatch(prepState, { immediate: true });
      }

      // カウント開始時のアナウンス
      if (cfgCountdownSec === 5 && isPrepVoiceCountdownEnabled) {
        playVoice('prep_countdown_5');
      } else if (cfgCountdownSec === 10 && isPrepVoice10SecEnabled) {
        playVoice('prep_start_10sec');
      } else if (cfgCountdownSec === 30 && isPrepVoice30SecEnabled) {
        playVoice('prep_start_30sec');
      } else if (cfgCountdownSec === 60 && isPrepVoice1MinEnabled) {
        playVoice('prep_start_1min');
      } else if (cfgCountdownSec === 120 && isPrepVoice2MinEnabled) {
        playVoice('prep_2min');
      } else if (cfgCountdownSec === 180 && isPrepVoice3MinEnabled) {
        playVoice('prep_start_3min');
      } else if (cfgCountdownSec === 240 && isPrepVoice4MinEnabled) {
        playVoice('prep_4min');
      } else if (cfgCountdownSec === 300 && isPrepVoice5MinEnabled) {
        playVoice('prep_start_5min');
      } else if (cfgCountdownSec === 600 && isPrepVoice10MinEnabled) {
        playVoice('prep_start_10min');
      } else if (cfgCountdownSec === 900 && isPrepVoice15MinEnabled) {
        playVoice('prep_start_15min');
      } else if (cfgCountdownSec > 5) {
        playVoice('prep_start_generic');
      }
    } else {
      if (currentIsPreCountdown) {
        // カウントダウン中ならキャンセル
        const stoppedPrepMainEnd = prepEndTimeRef.current
          ? (prepEndTimeRef.current + currentTarget * 1000)
          : (targetEndTimeRef.current || 0);
        if (stoppedPrepMainEnd > 0) {
          lastResetTargetEndRef.current = stoppedPrepMainEnd;
        }
        lastMainTimerResetAtRef.current = Date.now();
        lastAutoFinishedAtRef.current = 0;
        WatchConnectivity.notifyLocalStopOrReset('main-timer', stoppedPrepMainEnd);
        isPreCountingDownRef.current = false;
        setIsPreCountingDown(false);
        prepEndTimeRef.current = null;
        if (Platform.OS === 'ios') {
          const cancelState = { explicitStop: true,
            remainingTime: currentRemaining,
            targetTime: currentTarget,
            targetEndTimestamp: 0,
            lastResetTargetEndTimestamp: lastResetTargetEndRef.current || 0,
            lastResetAt: lastMainTimerResetAtRef.current || 0,
            isRunning: false,
            isPaused: false,
            isCountUp: false,
            isCountUpEnabled: !!isCountUpEnabledRef.current,
            isExplicitReset: true,
            isAutoFinished: false,
            genre: selectedCategoryRef.current || selectedCategory || '',
            isPreCountingDown: false,
            preCountdownSeconds: 0,
            isCountdownConfigEnabled: cfgCountdownEnabled,
            countdownConfigSeconds: cfgCountdownSec,
            prepEndTimestamp: 0,
          };
          if (setMainTimerState) {
            setMainTimerState(cancelState);
          }
          updateCachedMainTimerState(cancelState);
          syncMainTimerToWatch(cancelState, { immediate: true });
        }
        cancelVibration();
        cheerOverlayRef.current?.dismiss();
        if (voiceSoundRef.current) {
          voiceSoundRef.current.stopAsync().catch(() => {});
        } else if (voiceSound) {
          voiceSound.stopAsync().catch(() => {});
        }
      } else {
        // 通常のタイマートグル
        if (!currentIsRunning) {
          lastAutoFinishedAtRef.current = 0;
          lastAutoFinishedEndTimestampRef.current = 0;
          lastResetTargetEndRef.current = 0;
          lastMainTimerResetAtRef.current = 0;
          // スタート/再開
          if (!currentIsCountUp) {
            const nowMs = Date.now();
            const defaultEndMs = nowMs + effectiveRemaining * 1000;
            const incomingEndMs = Number(watchTiming?.targetEndTimestamp || 0);
            const useIncoming = incomingEndMs > nowMs && incomingEndMs <= nowMs + (currentTarget + 3600) * 1000;
            const isPastIncoming = incomingEndMs > nowMs - 3 * 3600 * 1000 && incomingEndMs <= nowMs;
            const isIncomingOvertime = isPastIncoming && !!isCountUpEnabledRef.current;
            if (isPastIncoming && !isCountUpEnabledRef.current) {
              // ★ カウントアップOFF時にWatch側で既に終了時刻を過ぎたタイマーが届いた場合は超過させず終了・待機状態にする
              isRunningRef.current = false;
              setIsRunning(false);
              isCountUpRef.current = false;
              setIsCountUp(false);
              targetEndTimeRef.current = null;
              overStartTimeRef.current = null;
              remainingTimeRef.current = currentTarget;
              setRemainingTime(currentTarget);
            } else if (isIncomingOvertime) {
              // ★ Watch側ですでにタイムアップして超過カウントアップ中のタイマーを引き継ぐ場合:
              //   フル時間に戻さず、そのまま超過状態（isCountUp = true）として合流する
              isRunningRef.current = true;
              setIsRunning(true);
              isCountUpRef.current = true;
              setIsCountUp(true);
              targetEndTimeRef.current = incomingEndMs;
              overStartTimeRef.current = incomingEndMs;
              triggeredVoicesRef.current.add('alarm');
              triggeredOverVoicesRef.current.clear();
              const overSec = Math.max(0, Math.floor((nowMs - incomingEndMs) / 1000));
              remainingTimeRef.current = overSec;
              setRemainingTime(overSec);
            } else {
              isRunningRef.current = true;
              setIsRunning(true);
              targetEndTimeRef.current = useIncoming ? incomingEndMs : defaultEndMs;
              if (useIncoming) {
                const syncedRem = Math.max(1, Math.ceil((incomingEndMs - nowMs) / 1000));
                remainingTimeRef.current = syncedRem;
                setRemainingTime(syncedRem);
              } else if (currentRemaining <= 0) {
                remainingTimeRef.current = effectiveRemaining;
                setRemainingTime(effectiveRemaining);
              }
              if (effectiveRemaining === currentTarget) {
                triggeredVoicesRef.current.clear();
                lastCheerTriggerTimeRef.current = nowMs;
                isFirstCheerTriggeredRef.current = false;
                nextCheerIntervalMsRef.current = 0;
              }
            }
          } else {
            isRunningRef.current = true;
            setIsRunning(true);
            overStartTimeRef.current = Date.now() - currentRemaining * 1000;
          }
        } else {
          // 一時停止（超過中または残り0秒以下で停止した場合は設定時間へ戻し、Watch側の00:00折りたたみを防止）
          const wasOverOrZero = currentIsCountUp || currentRemaining <= 0;
          const stoppedEndTs = targetEndTimeRef.current || overStartTimeRef.current || 0;
          if (stoppedEndTs > 0) {
            lastResetTargetEndRef.current = stoppedEndTs;
          }
          lastMainTimerResetAtRef.current = Date.now();
          lastAutoFinishedAtRef.current = 0;
          WatchConnectivity.notifyLocalStopOrReset('main-timer', stoppedEndTs);
          isRunningRef.current = false;
          setIsRunning(false);
          isCountUpRef.current = false;
          setIsCountUp(false);
          targetEndTimeRef.current = null;
          overStartTimeRef.current = null;
          if (wasOverOrZero) {
            remainingTimeRef.current = currentTarget;
            setRemainingTime(currentTarget);
            if (Platform.OS === 'ios') {
              const stoppedOverState = {
                explicitStop: true,
                isExplicitReset: true,
                isAutoFinished: false,
                remainingTime: currentTarget,
                targetTime: currentTarget,
                targetEndTimestamp: 0,
                lastResetTargetEndTimestamp: lastResetTargetEndRef.current || 0,
                lastResetAt: lastMainTimerResetAtRef.current || 0,
                isRunning: false,
                isPaused: false,
                isCountUp: false,
                isCountUpEnabled: !!isCountUpEnabledRef.current,
                genre: selectedCategoryRef.current || selectedCategory || '',
                isPreCountingDown: false,
                preCountdownSeconds: 0,
                isCountdownConfigEnabled: !!isCountdownEnabledRef.current,
                countdownConfigSeconds: countdownSecondsRef.current || 5,
                prepEndTimestamp: null,
              };
              if (setMainTimerState) {
                setMainTimerState(stoppedOverState);
              }
              updateCachedMainTimerState(stoppedOverState);
              syncMainTimerToWatch(stoppedOverState, { immediate: true });
            }
          }
          cancelVibration();
          stopAllAlarms('main');
          if (soundRef.current) {
            soundRef.current.stopAsync().catch(() => {});
          } else if (sound) {
            sound.stopAsync().catch(() => {});
          }
          if (voiceSoundRef.current) {
            voiceSoundRef.current.stopAsync().catch(() => {});
          } else if (voiceSound) {
            voiceSound.stopAsync().catch(() => {});
          }
        }
      }
    }
  };

  const resetTimer = (isFromSave = false) => {
    const fromSave = isFromSave === true;
    setWatchMutedState(false);
    // タイマーが10秒以上進行した状態での直接リセットは「途中終了（中断）」として自動カウント
    if (!fromSave) {
      const elapsedSeconds = isCountUp 
        ? targetTime + remainingTime 
        : targetTime - remainingTime;
      if (elapsedSeconds >= 10) {
        recordInterruption(selectedCategory || null);
      }
    }

    cheerOverlayRef.current?.dismiss(); // やまいも表示をリセット時にスッとクリア
    isFirstCheerTriggeredRef.current = false;
    lastCheerTriggerTimeRef.current = 0;
    nextCheerIntervalMsRef.current = 0;
    isRunningRef.current = false;
    isPreCountingDownRef.current = false;
    isCountUpRef.current = false;
    setIsRunning(false);
    setIsPreCountingDown(false);
    setIsCountUp(false);
    cancelVibration();
    stopAllAlarms('main');
    if (targetEndTimeRef.current) {
      lastResetTargetEndRef.current = targetEndTimeRef.current;
    } else if (overStartTimeRef.current) {
      lastResetTargetEndRef.current = overStartTimeRef.current;
    }
    lastMainTimerResetAtRef.current = Date.now();
    lastAutoFinishedAtRef.current = 0;
    WatchConnectivity.notifyLocalStopOrReset('main-timer', lastResetTargetEndRef.current || 0);
    targetEndTimeRef.current = null;
    prepEndTimeRef.current = null;
    overStartTimeRef.current = null;
    triggeredVoicesRef.current.clear();
    triggeredPrepVoicesRef.current.clear();
    triggeredOverVoicesRef.current.clear();
    const finalTarget = targetTimeRef.current || targetTime || 600;
    remainingTimeRef.current = finalTarget;
    setRemainingTime(finalTarget);
    if (soundRef.current) {
      soundRef.current.stopAsync().catch(() => {});
    } else if (sound) {
      sound.stopAsync().catch(() => {});
    }
    if (voiceSoundRef.current) {
      voiceSoundRef.current.stopAsync().catch(() => {});
    } else if (voiceSound) {
      voiceSound.stopAsync().catch(() => {});
    }

    // ★ リセット時はWatchへクリーンな初期待機状態を即座に伝達（超過の復活を根絶）
    if (Platform.OS === 'ios') {
      const resetState = { explicitStop: true,
        remainingTime: finalTarget,
        targetTime: finalTarget,
        targetEndTimestamp: 0,
        lastResetTargetEndTimestamp: lastResetTargetEndRef.current || 0,
        lastResetAt: lastMainTimerResetAtRef.current || 0,
        isRunning: false,
        isPaused: false,
        isCountUp: false,
        isCountUpEnabled: !!isCountUpEnabledRef.current,
        isExplicitReset: true,
        isAutoFinished: false,
        genre: selectedCategoryRef.current || selectedCategory || '',
        isPreCountingDown: false,
        preCountdownSeconds: 0,
        isCountdownConfigEnabled: !!isCountdownEnabledRef.current,
        countdownConfigSeconds: countdownSecondsRef.current || 5,
        prepEndTimestamp: null,
      };
      if (setMainTimerState) {
        setMainTimerState(resetState);
      }
      updateCachedMainTimerState(resetState);
      syncMainTimerToWatch(resetState, { immediate: true });
    }

    // リセットボタン押下後の待機中やまいもウォーキング演出（クールダウン30秒、出現率50%）
    if (!fromSave) {
      const now = Date.now();
      if (now - lastIdleCheerTimeRef.current >= 30000) {
        triggerIdleCheer(0.50, 1800);
      }
    }
  };

  // サロン画面等へのメインタイマー状態のリアルタイム同期 ＆ Apple Watchへの即時同期
  const prevIsRunningForWatchRef = useRef(isRunning);
  const prevTargetTimeForWatchRef = useRef(targetTime);
  const prevRemainingTimeForWatchRef = useRef(remainingTime);
  const prevIsPreCountdownForWatchRef = useRef(isPreCountingDown);
  const prevIsCountdownConfigEnabledRef = useRef(isCountdownEnabled);
  const prevCountdownConfigSecondsRef = useRef(countdownSeconds);
  const prevIsCountUpForWatchRef = useRef(isCountUp);
  const prevIsCountUpEnabledForWatchRef = useRef(isCountUpEnabled);

  useEffect(() => {
    // ★ 保存モーダル表示中は計測終了済みの待機状態として扱い、超過中・残り0秒の状態がWatchへ再送されるのを防止
    const effectiveIsRunning = saveModalVisible ? false : isRunning;
    const effectiveIsPre = saveModalVisible ? false : !!isPreCountingDown;
    const effectiveIsCountUp = saveModalVisible ? false : isCountUp;
    const effectiveRemaining = saveModalVisible ? targetTime : remainingTime;

    let endMs = null;
    if (effectiveIsRunning) {
      if (effectiveIsCountUp) {
        if (!overStartTimeRef.current) {
          overStartTimeRef.current = Date.now() - effectiveRemaining * 1000;
        }
        endMs = overStartTimeRef.current;
      } else {
        endMs = targetEndTimeRef.current || (Date.now() + effectiveRemaining * 1000);
      }
    } else if (effectiveIsPre) {
      const prepEnd = prepEndTimeRef.current || (Date.now() + (preCountdownTime || 0) * 1000);
      endMs = prepEnd + (targetTime || 600) * 1000;
    }

    const isAutoFinishedNow = !effectiveIsRunning && !effectiveIsPre && !saveModalVisible
      && lastAutoFinishedAtRef.current > 0 && lastAutoFinishedAtRef.current > lastMainTimerResetAtRef.current;
    const isExplicitResetNow = !effectiveIsRunning && !effectiveIsPre && !isAutoFinishedNow
      && (Date.now() - lastMainTimerResetAtRef.current < 5000);

    if (!endMs && isAutoFinishedNow && lastAutoFinishedEndTimestampRef.current > 0) {
      endMs = lastAutoFinishedEndTimestampRef.current;
    }

    const newState = {
      explicitStop: isExplicitResetNow || !!saveModalVisible,
      lastResetTargetEndTimestamp: lastResetTargetEndRef.current || 0,
      lastResetAt: lastMainTimerResetAtRef.current || 0,
      remainingTime: effectiveRemaining,
      targetTime,
      targetEndTimestamp: endMs,
      isRunning: effectiveIsRunning,
      isPaused: !effectiveIsRunning && !effectiveIsPre && effectiveRemaining > 0 && effectiveRemaining !== targetTime && !effectiveIsCountUp,
      isCountUp: effectiveIsCountUp,
      isCountUpEnabled: !!isCountUpEnabled,
      isAutoFinished: isAutoFinishedNow,
      isExplicitReset: isExplicitResetNow,
      genre: selectedCategory || '',
      isPreCountingDown: effectiveIsPre,
      preCountdownSeconds: effectiveIsPre ? (preCountdownTime || 0) : 0,
      isCountdownConfigEnabled: !!isCountdownEnabled,
      countdownConfigSeconds: countdownSeconds || 5,
      prepEndTimestamp: effectiveIsPre ? (prepEndTimeRef.current || (Date.now() + (preCountdownTime || 0) * 1000)) : null,
    };

    if (setMainTimerState) {
      setMainTimerState(newState);
    }
    updateCachedMainTimerState(newState);

    // ★ Watchへの即時同期: スタート/ストップの切り替わり、設定時間変更、準備中カウントダウンの開始/終了、設定の変更、超過状態の変化、または停止中の秒数変化時に送信
    const isStateToggled = prevIsRunningForWatchRef.current !== effectiveIsRunning;
    const isTargetChanged = prevTargetTimeForWatchRef.current !== targetTime;
    const isPreCountdownToggled = prevIsPreCountdownForWatchRef.current !== effectiveIsPre;
    const isCountdownConfigToggled = prevIsCountdownConfigEnabledRef.current !== isCountdownEnabled || prevCountdownConfigSecondsRef.current !== countdownSeconds;
    const isCountUpToggled = prevIsCountUpForWatchRef.current !== effectiveIsCountUp;
    const isCountUpEnabledToggled = prevIsCountUpEnabledForWatchRef.current !== isCountUpEnabled;
    const isRemainingChangedWhileStopped = !effectiveIsRunning && !effectiveIsPre && prevRemainingTimeForWatchRef.current !== effectiveRemaining;

    if (isStateToggled || isTargetChanged || isPreCountdownToggled || isCountdownConfigToggled || isCountUpToggled || isCountUpEnabledToggled || isRemainingChangedWhileStopped) {
      prevIsRunningForWatchRef.current = effectiveIsRunning;
      prevTargetTimeForWatchRef.current = targetTime;
      prevRemainingTimeForWatchRef.current = effectiveRemaining;
      prevIsPreCountdownForWatchRef.current = effectiveIsPre;
      prevIsCountdownConfigEnabledRef.current = isCountdownEnabled;
      prevCountdownConfigSecondsRef.current = countdownSeconds;
      prevIsCountUpForWatchRef.current = effectiveIsCountUp;
      prevIsCountUpEnabledForWatchRef.current = isCountUpEnabled;
      if (Platform.OS === 'ios') {
        syncMainTimerToWatch(newState, { immediate: true });
      }
    } else {
      prevRemainingTimeForWatchRef.current = effectiveRemaining;
    }
  }, [remainingTime, targetTime, isRunning, isCountUp, isCountUpEnabled, selectedCategory, isPreCountingDown, preCountdownTime, isCountdownEnabled, countdownSeconds, saveModalVisible]);

  // ★ Watchからのメインタイマー操作の直接受信（サロン画面を開いていなくても即座に操作を受け付ける）
  const toggleTimerRef = useRef(toggleTimer);
  toggleTimerRef.current = toggleTimer;
  const resetTimerRef = useRef(resetTimer);
  resetTimerRef.current = resetTimer;
  const applyTimeInSecondsRef = useRef(null);
  const targetTimeRef = useRef(targetTime);
  targetTimeRef.current = targetTime;
  const selectedCategoryRef = useRef(selectedCategory);
  selectedCategoryRef.current = selectedCategory;
  const isCountdownEnabledRef = useRef(isCountdownEnabled);
  isCountdownEnabledRef.current = isCountdownEnabled;
  const countdownSecondsRef = useRef(countdownSeconds);
  countdownSecondsRef.current = countdownSeconds;
  const isCountUpEnabledRef = useRef(isCountUpEnabled);
  isCountUpEnabledRef.current = isCountUpEnabled;
  const lastMainTimerResetAtRef = useRef(0);
  const lastResetTargetEndRef = useRef(0);

  // ★ メインタイマー操作（Watch直接受信 ＆ サロン画面等のUIリクエスト）の共通実行ハンドラ
  const processedMainActionIdsRef = useRef(new Set());
  const lastMainActionTimestampRef = useRef(0);
  const lastDispatchedActionInfoRef = useRef({ key: '', time: 0 });

  const handleMainTimerActionDispatch = useCallback((action, payload = {}, actionId = null) => {
    const rawAction = String(action || '');
    const cleanAction = rawAction.replace(/^MAIN_TIMER_/, '').toLowerCase(); // 'start', 'pause', 'toggle', 'reset', 'set_time', 'adjust'
    const dedupeId = actionId || `${cleanAction}_${Math.floor((payload?.timestamp || Date.now()) / 1500)}`;

    if (dedupeId) {
      if (processedMainActionIdsRef.current.has(dedupeId)) {
        return; // すでに処理済みの同一操作
      }
      processedMainActionIdsRef.current.add(dedupeId);
      if (processedMainActionIdsRef.current.size > 50) {
        const first = processedMainActionIdsRef.current.values().next().value;
        processedMainActionIdsRef.current.delete(first);
      }
    }

    // ★ 短時間（500ms以内）の同一アクション重複実行を完全ブロック（adjust以外の操作で別ルートからの二重到達を防止）
    if (cleanAction !== 'adjust') {
      const secParam = Number(payload?.totalSeconds || payload?.extra?.totalSeconds || 0);
      const actionSignature = `${cleanAction}_${secParam}`;
      const nowMs = Date.now();
      if (
        lastDispatchedActionInfoRef.current.key === actionSignature &&
        nowMs - lastDispatchedActionInfoRef.current.time < 500
      ) {
        return;
      }
      lastDispatchedActionInfoRef.current = { key: actionSignature, time: nowMs };
    }

    if (cleanAction === 'start') {
      const isFromPhone = payload?.fromPhone === true;
      const rawSound = payload?.playSoundOnPhone ?? payload?.extra?.playSoundOnPhone;
      const playPhoneSound = isFromPhone || (rawSound === true || rawSound === 1 || rawSound === 'true');
      setWatchMutedState(!playPhoneSound);
      console.log('[HomeScreen] MAIN_TIMER_START received. playSoundOnPhone:', playPhoneSound, 'isMuted:', !playPhoneSound);
      const watchTiming = {
        targetEndTimestamp: Number(payload?.targetEndTimestamp || payload?.extra?.targetEndTimestamp || 0),
        prepEndTimestamp: Number(payload?.prepEndTimestamp || payload?.extra?.prepEndTimestamp || 0),
      };
      // Watch側で設定されたtotalSecondsまたはsecondsが同梱されていれば開始前に同期反映
      const incomingTotal = Number(payload?.totalSeconds || payload?.seconds || payload?.extra?.totalSeconds || payload?.extra?.seconds || 0);
      const isFromOvertime = isCountUpRef.current || isCountUp || remainingTimeRef.current <= 0;
      if (!isRunningRef.current && !isPreCountingDownRef.current && incomingTotal > 0) {
        const isAtInitial = remainingTimeRef.current === targetTimeRef.current || isFromOvertime;
        if (isAtInitial && incomingTotal !== targetTimeRef.current) {
          targetTimeRef.current = incomingTotal;
          setTargetTime(incomingTotal);
          remainingTimeRef.current = incomingTotal;
          setRemainingTime(incomingTotal);
        }
      }
      // 超過中（カウントアップ中）または残り時間が0秒以下の場合はカウントアップ解除＆設定時間にリセットしてから開始
      if (isFromOvertime) {
        isCountUpRef.current = false;
        setIsCountUp(false);
        overStartTimeRef.current = null;
        isRunningRef.current = false;
        setIsRunning(false);
        const resetTarget = (targetTimeRef.current && targetTimeRef.current > 0) ? targetTimeRef.current : (targetTime || 600);
        remainingTimeRef.current = resetTarget;
        setRemainingTime(resetTarget);
      }
      if (!isRunningRef.current && !isPreCountingDownRef.current && toggleTimerRef.current) {
        toggleTimerRef.current(true, watchTiming); // ★ Watch主導フラグおよびWatch側の予定時刻を伝達
      }
      if (Platform.OS === 'ios') {
        // toggleTimer内で準備カウントダウンが発動した場合は、toggleTimer側がprepStateを送信済みのため二重・矛盾送信を抑制
        const isPrep = !!isPreCountingDownRef.current;
        if (!isPrep) {
          const isRunningNow = !!isRunningRef.current;
          const isOverNow = isRunningNow && !!isCountUpRef.current;
          const startState = {
            explicitStop: false,
            isExplicitReset: false,
            isAutoFinished: false,
            remainingTime: remainingTimeRef.current,
            targetTime: targetTimeRef.current || targetTime,
            targetEndTimestamp: isRunningNow
              ? (isOverNow
                  ? (overStartTimeRef.current || targetEndTimeRef.current || Date.now())
                  : (targetEndTimeRef.current || (Date.now() + remainingTimeRef.current * 1000)))
              : 0,
            lastResetTargetEndTimestamp: 0,
            lastResetAt: 0,
            isRunning: isRunningNow,
            isPaused: false,
            isCountUp: isOverNow,
            isCountUpEnabled: !!isCountUpEnabledRef.current,
            genre: selectedCategoryRef.current || '',
            isPreCountingDown: false,
            preCountdownSeconds: 0,
            isCountdownConfigEnabled: !!isCountdownEnabledRef.current,
            countdownConfigSeconds: countdownSecondsRef.current || 5,
            prepEndTimestamp: null,
          };
          if (setMainTimerState) {
            setMainTimerState(startState);
          }
          updateCachedMainTimerState(startState);
          syncMainTimerToWatch(startState, { immediate: true });
        }
      }
    } else if (cleanAction === 'pause') {
      const wasOvertime = isCountUpRef.current || remainingTimeRef.current <= 0;
      isCountUpRef.current = false;
      setIsCountUp(false);
      overStartTimeRef.current = null;
      if (wasOvertime) {
        // ★ 超過中または0秒終了後に停止された場合は、中途半端な超過経過秒数を残さず設定時間へクリーンにリセット停止
        if (resetTimerRef.current) {
          resetTimerRef.current(true);
        }
      } else {
        if ((isRunningRef.current || isPreCountingDownRef.current) && toggleTimerRef.current) {
          toggleTimerRef.current(true);
        }
        if (Platform.OS === 'ios') {
          const pauseTarget = targetTimeRef.current || targetTime;
          const pauseState = {
            remainingTime: remainingTimeRef.current,
            targetTime: pauseTarget,
            targetEndTimestamp: 0,
            lastResetTargetEndTimestamp: lastResetTargetEndRef.current || 0,
            lastResetAt: lastMainTimerResetAtRef.current || 0,
            isRunning: false,
            isPaused: remainingTimeRef.current > 0 && remainingTimeRef.current !== pauseTarget,
            isCountUp: false,
            isCountUpEnabled: !!isCountUpEnabledRef.current,
            isExplicitReset: true,
            isAutoFinished: false,
            genre: selectedCategoryRef.current || selectedCategory || '',
            isPreCountingDown: false,
            preCountdownSeconds: 0,
            isCountdownConfigEnabled: !!isCountdownEnabledRef.current,
            countdownConfigSeconds: countdownSecondsRef.current || 5,
            prepEndTimestamp: null,
          };
          if (setMainTimerState) {
            setMainTimerState(pauseState);
          }
          updateCachedMainTimerState(pauseState);
          syncMainTimerToWatch(pauseState, { immediate: true });
        }
      }
    } else if (cleanAction === 'toggle') {
      if (isCountUpRef.current || (isRunningRef.current && remainingTimeRef.current <= 0)) {
        if (resetTimerRef.current) {
          resetTimerRef.current(true);
        }
      } else if (toggleTimerRef.current) {
        toggleTimerRef.current(true);
      }
    } else if (cleanAction === 'reset') {
      const incomingStopEnd = Number(payload?.targetEndTimestamp || payload?.extra?.targetEndTimestamp || payload?.expectedEnd || payload?.extra?.expectedEnd || 0);
      if (incomingStopEnd > 0) {
        lastResetTargetEndRef.current = incomingStopEnd;
      }
      lastMainTimerResetAtRef.current = Date.now();
      lastAutoFinishedAtRef.current = 0;
      setWatchMutedState(false);
      isCountUpRef.current = false;
      setIsCountUp(false);
      overStartTimeRef.current = null;
      if (resetTimerRef.current) {
        resetTimerRef.current(true);
      }
      if (Platform.OS === 'ios') {
        const finalTarget = targetTimeRef.current || targetTime || 600;
        const resetState = {
          explicitStop: true,
          remainingTime: finalTarget,
          targetTime: finalTarget,
          targetEndTimestamp: 0,
          lastResetTargetEndTimestamp: lastResetTargetEndRef.current || 0,
          lastResetAt: lastMainTimerResetAtRef.current || 0,
          isRunning: false,
          isPaused: false,
          isCountUp: false,
          isCountUpEnabled: !!isCountUpEnabledRef.current,
          isExplicitReset: true,
          isAutoFinished: false,
          genre: selectedCategoryRef.current || selectedCategory || '',
          isPreCountingDown: false,
          preCountdownSeconds: 0,
          isCountdownConfigEnabled: !!isCountdownEnabledRef.current,
          countdownConfigSeconds: countdownSecondsRef.current || 5,
          prepEndTimestamp: null,
        };
        if (setMainTimerState) {
          setMainTimerState(resetState);
        }
        updateCachedMainTimerState(resetState);
        syncMainTimerToWatch(resetState, { immediate: true });
      }
    } else if (cleanAction === 'set_time') {
      const sec = Number(payload?.totalSeconds || payload?.extra?.totalSeconds || payload?.seconds || payload?.extra?.seconds);
      const rawAuto = payload?.autoStart ?? payload?.extra?.autoStart;
      // ★ WCSession ブリッジで Bool(true) が 1 や 'true' に変換された場合や、targetEndTimestamp が有効時刻として同梱されている場合も確実にスタート判定
      const incomingEndTs = Number(payload?.targetEndTimestamp || payload?.extra?.targetEndTimestamp || 0);
      const hasValidEnd = incomingEndTs > Date.now() - 3 * 3600 * 1000;
      const autoStart = rawAuto === true || rawAuto === 1 || rawAuto === 'true' || (rawAuto == null && hasValidEnd);
      if (sec > 0 && applyTimeInSecondsRef.current) {
        const isFromPhone = payload?.fromPhone === true;
        const rawSound = payload?.playSoundOnPhone ?? payload?.extra?.playSoundOnPhone;
        const playPhoneSound = isFromPhone || (rawSound === true || rawSound === 1 || rawSound === 'true');
        setWatchMutedState(!playPhoneSound);
        console.log('[HomeScreen] MAIN_TIMER_SET_TIME applied:', sec, 'autoStart:', autoStart, 'playSoundOnPhone:', playPhoneSound);

        if (autoStart) {
          const watchTiming = {
            targetEndTimestamp: Number(payload?.targetEndTimestamp || payload?.extra?.targetEndTimestamp || 0),
            prepEndTimestamp: Number(payload?.prepEndTimestamp || payload?.extra?.prepEndTimestamp || 0),
          };
          // ★ タイム入力＋即時スタート: 既存の稼働・超過・準備カウントダウン・アラーム音を一旦クリーンにしてから新タイムで直ちに開始！
          cancelVibration();
          stopAllAlarms('main');
          if (soundRef.current) soundRef.current.stopAsync().catch(() => {});
          if (voiceSoundRef.current) voiceSoundRef.current.stopAsync().catch(() => {});
          isRunningRef.current = false;
          setIsRunning(false);
          isPreCountingDownRef.current = false;
          setIsPreCountingDown(false);
          isCountUpRef.current = false;
          setIsCountUp(false);
          targetEndTimeRef.current = null;
          prepEndTimeRef.current = null;
          overStartTimeRef.current = null;

          // 途中の停止状態（isRunning: false）をWatchへ誤送信しないよう skipWatchSync: true で秒数をセット
          applyTimeInSecondsRef.current(sec, { skipWatchSync: true, fromWatch: !isFromPhone });

          // 直ちにタイマー（または準備カウントダウン）を開始
          if (toggleTimerRef.current) {
            toggleTimerRef.current(!isFromPhone, watchTiming);
          }

          // 準備カウントダウンでない通常スタート・超過合流時は、確定した稼働状態を即座にWatchへ返信
          if (Platform.OS === 'ios' && !isPreCountingDownRef.current) {
            const isRunningNow = !!isRunningRef.current;
            const isOverNow = isRunningNow && !!isCountUpRef.current;
            const startState = {
              explicitStop: false,
              isExplicitReset: false,
              isAutoFinished: false,
              remainingTime: remainingTimeRef.current,
              targetTime: targetTimeRef.current || sec,
              targetEndTimestamp: isRunningNow
                ? (isOverNow
                    ? (overStartTimeRef.current || targetEndTimeRef.current || Date.now())
                    : (targetEndTimeRef.current || (Date.now() + sec * 1000)))
                : 0,
              lastResetTargetEndTimestamp: 0,
              lastResetAt: 0,
              isRunning: isRunningNow,
              isPaused: false,
              isCountUp: isOverNow,
              isCountUpEnabled: !!isCountUpEnabledRef.current,
              genre: selectedCategoryRef.current || '',
              isPreCountingDown: false,
              preCountdownSeconds: 0,
              isCountdownConfigEnabled: !!isCountdownEnabledRef.current,
              countdownConfigSeconds: countdownSecondsRef.current || 5,
              prepEndTimestamp: null,
            };
            if (setMainTimerState) {
              setMainTimerState(startState);
            }
            updateCachedMainTimerState(startState);
            syncMainTimerToWatch(startState, { immediate: true });
          }
        } else {
          applyTimeInSecondsRef.current(sec, { fromWatch: !isFromPhone });
        }
      }
    } else if (cleanAction === 'adjust') {
      const delta = Number(payload?.secondsToAdd || payload?.extra?.secondsToAdd);
      if (delta) {
        const isFromPhone = payload?.fromPhone === true;
        console.log('[HomeScreen] MAIN_TIMER_ADJUST applied:', delta);
        let nextRem = 0;
        const incomingEndMs = Number(payload?.targetEndTimestamp || payload?.extra?.targetEndTimestamp || 0);
        // ★ Watch側で超過中（+00:xx）に「+1分」「+5分」等の延長が行われた場合、
        //   iPhone側でカウントアップOFFにより自動終了していた場合でも稼働状態（isRunning = true）へ復帰させて同期する
        const shouldResumeFromWatchOvertime = !isFromPhone && !isRunningRef.current && delta > 0 && (
          incomingEndMs > Date.now() || lastAutoFinishedAtRef.current > 0
        );
        if (isRunningRef.current || shouldResumeFromWatchOvertime) {
          const wasOverOrRinging = isCountUpRef.current || triggeredVoicesRef.current.has('alarm') || shouldResumeFromWatchOvertime;
          const baseEnd = (isRunningRef.current && !isCountUpRef.current && targetEndTimeRef.current) ? targetEndTimeRef.current : Date.now();
          const computedEnd = Math.max(Date.now() + 5000, baseEnd + delta * 1000);
          targetEndTimeRef.current = (incomingEndMs > Date.now() && Math.abs(incomingEndMs - computedEnd) <= 15000)
            ? incomingEndMs
            : computedEnd;
          if (shouldResumeFromWatchOvertime) {
            isRunningRef.current = true;
            setIsRunning(true);
            lastAutoFinishedAtRef.current = 0;
            lastAutoFinishedEndTimestampRef.current = 0;
            lastResetTargetEndRef.current = 0;
            lastMainTimerResetAtRef.current = 0;
            if (!targetTimeRef.current || targetTimeRef.current <= 0) {
              targetTimeRef.current = Math.max(60, delta);
              setTargetTime(targetTimeRef.current);
            }
          }
          isCountUpRef.current = false;
          setIsCountUp(false);
          overStartTimeRef.current = null;
          nextRem = Math.max(0, Math.ceil((targetEndTimeRef.current - Date.now()) / 1000));
          remainingTimeRef.current = nextRem;
          setRemainingTime(nextRem);
          if (wasOverOrRinging) {
            cancelVibration();
            stopAllAlarms('main');
            if (soundRef.current) soundRef.current.stopAsync().catch(() => {});
            if (voiceSoundRef.current) voiceSoundRef.current.stopAsync().catch(() => {});
          }
          // ★ 延長により再び未来になった秒数コールおよび0秒アラームフラグをクリアし、延長後の再到達時に確実に鳴らす
          triggeredOverVoicesRef.current.clear();
          triggeredVoicesRef.current.delete('alarm');
          [300, 180, 60, 30, 10, 5].forEach((secThreshold) => {
            if (nextRem > secThreshold) {
              triggeredVoicesRef.current.delete(secThreshold);
            }
          });
        } else {
          const baseSec = (remainingTimeRef.current > 0 && remainingTimeRef.current !== targetTimeRef.current)
            ? remainingTimeRef.current
            : (targetTimeRef.current || 600);
          nextRem = Math.max(10, baseSec + delta);
          remainingTimeRef.current = nextRem;
          targetTimeRef.current = nextRem;
          setRemainingTime(nextRem);
          setTargetTime(nextRem);
        }
        if (Platform.OS === 'ios') {
          const finalTargetSec = isRunningRef.current ? targetTimeRef.current : nextRem;
          const prepEndMs = isPreCountingDownRef.current
            ? (prepEndTimeRef.current || (Date.now() + (preCountdownTimeRef.current || countdownSecondsRef.current || 5) * 1000))
            : null;
          const adjustedEndMs = isRunningRef.current
            ? targetEndTimeRef.current
            : (isPreCountingDownRef.current && prepEndMs ? (prepEndMs + finalTargetSec * 1000) : 0);
          const updated = {
            remainingTime: nextRem,
            targetTime: finalTargetSec,
            targetEndTimestamp: adjustedEndMs,
            lastResetTargetEndTimestamp: isRunningRef.current ? 0 : (lastResetTargetEndRef.current || 0),
            lastResetAt: isRunningRef.current ? 0 : (lastMainTimerResetAtRef.current || 0),
            isRunning: isRunningRef.current,
            isPaused: !isRunningRef.current && !isPreCountingDownRef.current && nextRem > 0 && nextRem !== finalTargetSec,
            isCountUp: false,
            isCountUpEnabled: !!isCountUpEnabledRef.current,
            genre: selectedCategoryRef.current || '',
            isPreCountingDown: !!isPreCountingDownRef.current,
            preCountdownSeconds: preCountdownTimeRef.current || 0,
            isCountdownConfigEnabled: !!isCountdownEnabledRef.current,
            countdownConfigSeconds: countdownSecondsRef.current || 5,
            prepEndTimestamp: prepEndMs,
          };
          if (setMainTimerState) {
            setMainTimerState(updated);
          }
          updateCachedMainTimerState(updated);
          syncMainTimerToWatch(updated, { immediate: true });
        }
      }
    }
  }, [setWatchMutedState]);

  const handleMainTimerActionDispatchRef = useRef(handleMainTimerActionDispatch);
  handleMainTimerActionDispatchRef.current = handleMainTimerActionDispatch;

  const getLatestMainTimerState = useCallback(() => {
    const now = Date.now();
    let isRunning = isRunningRef.current;
    let isPre = !!isPreCountingDownRef.current;
    let isOver = !!isCountUpRef.current;
    let currentRemaining = remainingTimeRef.current;
    const currentTarget = targetTimeRef.current || 180;
    const allowCountUp = !!isCountUpEnabledRef.current;
    let endMs = 0;

    // ★ バックグラウンド中に準備カウントダウンが終了していた場合は、本番稼働・超過（または終了）へ正規化
    if (isPre && prepEndTimeRef.current) {
      const prepEnd = prepEndTimeRef.current;
      if (prepEnd <= now) {
        isPre = false;
        isPreCountingDownRef.current = false;
        endMs = prepEnd + currentTarget * 1000;
        if (endMs <= now) {
          if (allowCountUp) {
            isRunning = true;
            isOver = true;
            currentRemaining = Math.max(0, Math.floor((now - endMs) / 1000));
          } else {
            lastAutoFinishedAtRef.current = now;
            lastAutoFinishedEndTimestampRef.current = endMs;
            isRunning = false;
            isRunningRef.current = false;
            isOver = false;
            isCountUpRef.current = false;
            targetEndTimeRef.current = null;
            prepEndTimeRef.current = null;
            currentRemaining = 0;
            remainingTimeRef.current = 0;
            setIsPreCountingDown(false);
            setIsRunning(false);
            setIsCountUp(false);
            setRemainingTime(0);
          }
        } else {
          isRunning = true;
          isOver = false;
          currentRemaining = Math.max(0, Math.ceil((endMs - now) / 1000));
        }
      } else {
        endMs = prepEnd + currentTarget * 1000;
      }
    } else if (isRunning) {
      if (isOver) {
        if (!allowCountUp) {
          const finishedEnd = overStartTimeRef.current || targetEndTimeRef.current || now;
          lastAutoFinishedAtRef.current = now;
          lastAutoFinishedEndTimestampRef.current = finishedEnd;
          isRunning = false;
          isRunningRef.current = false;
          isOver = false;
          isCountUpRef.current = false;
          targetEndTimeRef.current = null;
          overStartTimeRef.current = null;
          currentRemaining = 0;
          endMs = finishedEnd;
          setIsRunning(false);
          setIsCountUp(false);
          setRemainingTime(0);
        } else {
          if (!overStartTimeRef.current) {
            overStartTimeRef.current = now - currentRemaining * 1000;
          }
          endMs = overStartTimeRef.current;
          currentRemaining = Math.max(0, Math.floor((now - endMs) / 1000));
        }
      } else {
        endMs = targetEndTimeRef.current || (now + currentRemaining * 1000);
        if (endMs <= now) {
          if (allowCountUp) {
            isOver = true;
            currentRemaining = Math.max(0, Math.floor((now - endMs) / 1000));
          } else {
            lastAutoFinishedAtRef.current = now;
            lastAutoFinishedEndTimestampRef.current = endMs;
            isRunning = false;
            isRunningRef.current = false;
            isOver = false;
            isCountUpRef.current = false;
            targetEndTimeRef.current = null;
            currentRemaining = 0;
            setIsRunning(false);
            setIsCountUp(false);
            setRemainingTime(0);
          }
        } else {
          currentRemaining = Math.max(0, Math.ceil((endMs - now) / 1000));
        }
      }
      remainingTimeRef.current = currentRemaining;
    } else if (isPre) {
      const prepEnd = prepEndTimeRef.current || (now + (preCountdownTimeRef.current || countdownSecondsRef.current || 5) * 1000);
      endMs = prepEnd + currentTarget * 1000;
    }
    const isAutoFinishedNow = !isRunning && !isPre && lastAutoFinishedAtRef.current > 0 && lastAutoFinishedAtRef.current > lastMainTimerResetAtRef.current;
    const isExplicitResetNow = !isRunning && !isPre && !isAutoFinishedNow && (now - lastMainTimerResetAtRef.current < 5000);
    if (!endMs && isAutoFinishedNow && lastAutoFinishedEndTimestampRef.current > 0) {
      endMs = lastAutoFinishedEndTimestampRef.current;
    }
    return {
      explicitStop: isExplicitResetNow,
      lastResetTargetEndTimestamp: lastResetTargetEndRef.current || 0,
      lastResetAt: lastMainTimerResetAtRef.current || 0,
      remainingTime: currentRemaining,
      targetTime: currentTarget,
      targetEndTimestamp: endMs,
      isRunning,
      isPaused: !isRunning && !isPre && currentRemaining > 0 && currentRemaining !== currentTarget && !isOver,
      isCountUp: isOver,
      isCountUpEnabled: allowCountUp,
      isAutoFinished: isAutoFinishedNow,
      isExplicitReset: isExplicitResetNow,
      genre: selectedCategoryRef.current || '',
      isPreCountingDown: isPre,
      preCountdownSeconds: isPre ? (preCountdownTimeRef.current || 0) : 0,
      isCountdownConfigEnabled: !!isCountdownEnabledRef.current,
      countdownConfigSeconds: countdownSecondsRef.current || 5,
      prepEndTimestamp: isPre ? prepEndTimeRef.current : null,
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;

    const unsubscribe = WatchConnectivity.subscribeActions((payload) => {
      if (!payload || !payload.action) return;
      const { action, actionId, seatId } = payload;
      const resolvedActionId = actionId || payload?.extra?.actionId || `${action}_${Math.round(Number(payload?.timestamp || Date.now()))}`;

      // ★ Watchからの同期要求（REQUEST_SYNC）に対し、Watch主導で稼働中または停止済みのメインタイマーがあればiPhone側も即座に反映してから最新状態を返送！
      if (action === 'REQUEST_SYNC') {
        const rawStopped = payload?.watchMainTimerStopped ?? payload?.extra?.watchMainTimerStopped;
        const hasStoppedWatchMain = rawStopped === true || rawStopped === 1 || rawStopped === 'true';
        const stoppedWatchEndTs = Number(payload?.targetEndTimestamp || payload?.extra?.targetEndTimestamp || 0);
        const curActiveEndTs = targetEndTimeRef.current || overStartTimeRef.current || 0;
        const isDifferentNewTimerOnPhone =
          stoppedWatchEndTs > 0 && curActiveEndTs > Date.now() + 2000 && Math.abs(curActiveEndTs - stoppedWatchEndTs) > 15000;
        if (
          hasStoppedWatchMain &&
          !isDifferentNewTimerOnPhone &&
          (isRunningRef.current || isPreCountingDownRef.current || isCountUpRef.current) &&
          handleMainTimerActionDispatchRef.current
        ) {
          handleMainTimerActionDispatchRef.current(
            'MAIN_TIMER_RESET',
            payload,
            `sync_stop_${Math.round(Number(payload?.timestamp || Date.now()) / 1000)}`
          );
        } else {
          const rawActive = payload?.watchMainTimerActive ?? payload?.extra?.watchMainTimerActive;
          const hasActiveWatchMain = rawActive === true || rawActive === 1 || rawActive === 'true';
          const incomingEndTs = Number(payload?.targetEndTimestamp || payload?.extra?.targetEndTimestamp || 0);
          const incomingPrepTs = Number(payload?.prepEndTimestamp || payload?.extra?.prepEndTimestamp || 0);
          const nowMs = Date.now();
          const isSameAsLastReset =
            (lastResetTargetEndRef.current > 0 && incomingEndTs > 0 && Math.abs(incomingEndTs - lastResetTargetEndRef.current) <= 15000) ||
            WatchConnectivity.isMainTimerEndStopped(incomingEndTs);
          const isNewFutureWatchTimer = !isSameAsLastReset && (incomingEndTs > nowMs + 2000 || incomingPrepTs > nowMs);
          const isRecentlyReset =
            !isNewFutureWatchTimer && (
              nowMs - lastMainTimerResetAtRef.current < 15000 ||
              nowMs - WatchConnectivity.getLastLocalMainTimerStopAt() < 15000
            );
          const isExpiredWithoutCountUp = !isCountUpEnabledRef.current && incomingEndTs > 0 && incomingEndTs <= nowMs && incomingPrepTs <= nowMs;
          const isSameAsLastAutoFinished =
            lastAutoFinishedEndTimestampRef.current > 0 &&
            incomingEndTs > 0 &&
            Math.abs(incomingEndTs - lastAutoFinishedEndTimestampRef.current) <= 15000;
          if (
            hasActiveWatchMain &&
            !isRunningRef.current &&
            !isPreCountingDownRef.current &&
            !isSameAsLastReset &&
            !isSameAsLastAutoFinished &&
            !isRecentlyReset &&
            handleMainTimerActionDispatchRef.current
          ) {
            if (isExpiredWithoutCountUp) {
              lastAutoFinishedAtRef.current = nowMs;
              lastAutoFinishedEndTimestampRef.current = incomingEndTs;
            } else {
              handleMainTimerActionDispatchRef.current(
                'MAIN_TIMER_SET_TIME',
                { ...payload, autoStart: true },
                `sync_adopt_${Math.round(Number(payload?.targetEndTimestamp || Date.now()) / 1000)}`
              );
            }
          }
        }
        ensureSalonSeatsCached().then(() => {
          const latest = getLatestMainTimerState();
          updateCachedMainTimerState(latest);
          syncMainTimerToWatch(latest, { immediate: true });
        }).catch(() => {
          const latest = getLatestMainTimerState();
          updateCachedMainTimerState(latest);
          syncMainTimerToWatch(latest, { immediate: true });
        });
        return;
      }

      // ★ Watchでメインタイマーのアラーム停止が押された場合もリセット反映
      if (action === 'STOP_ALARM' && (seatId === 'main-timer' || seatId === '-1' || Number(seatId) === -1)) {
        if (handleMainTimerActionDispatchRef.current) {
          handleMainTimerActionDispatchRef.current('MAIN_TIMER_RESET', payload, resolvedActionId);
        }
        return;
      }

      if (action.startsWith('MAIN_TIMER_') && handleMainTimerActionDispatchRef.current) {
        handleMainTimerActionDispatchRef.current(action, payload, resolvedActionId);
      }
    });

    // ★ マウント直後（アプリ起動時）に客席キャッシュ（1番席サンプル等）を確実に準備し、メインタイマー＆客席をWatchへ送信
    //   （WatchConnectivity.subscribeActions 登録後に実行することで、起動時の保留アクションを先に反映した最新状態を送る）
    ensureSalonSeatsCached().then(() => {
      const initialState = getLatestMainTimerState();
      updateCachedMainTimerState(initialState);
      syncMainTimerToWatch(initialState, { immediate: true });
    }).catch(() => {
      const initialState = getLatestMainTimerState();
      updateCachedMainTimerState(initialState);
      syncMainTimerToWatch(initialState, { immediate: true });
    });

    // ★ iPhoneロック画面（AlarmKit）や通知から「開く」・閉じるが押された場合:
    //   超過カウントアップ（+00:01...）が自動的に終了して00:00に戻らないよう、MAIN_TIMER_RESET は呼ばない！
    //   アプリ画面で「終了」や「リセット」ボタンを明示的に押した時のみ停止・リセットされる仕様。
    const unsubAlarmStopped = subscribeUserStoppedAlarms((_stopped) => {
      // アラーム通知の確認・開く操作では超過カウントアップを継続させる
    });

    return () => {
      if (unsubscribe) unsubscribe();
      if (unsubAlarmStopped) unsubAlarmStopped();
    };
  }, [getLatestMainTimerState]);

  // サロン画面等からの操作リクエスト（一時停止/再開/リセット/時間変更/微調整）の実行
  useEffect(() => {
    if (mainTimerActionRequest && mainTimerActionRequest.timestamp > lastMainActionTimestampRef.current) {
      lastMainActionTimestampRef.current = mainTimerActionRequest.timestamp;
      const { action, payload, actionId } = mainTimerActionRequest;
      handleMainTimerActionDispatch(action, payload, actionId || `req_${mainTimerActionRequest.timestamp}`);
    }
  }, [mainTimerActionRequest, handleMainTimerActionDispatch]);

  // ---- 待機放置中（待合室モード）のやまいも気まぐれお散歩演出 ----
  useEffect(() => {
    let idleTimer = null;
    if (!isRunning && !isPreCountingDown && !saveModalVisible && !isCountUp) {
      // 待機放置中: 60〜90秒おきにふらっとお散歩（出現率40%）
      const intervalMs = (Math.floor(Math.random() * (90 - 60 + 1)) + 60) * 1000;
      idleTimer = setTimeout(() => {
        const now = Date.now();
        if (now - lastIdleCheerTimeRef.current >= 45000) {
          triggerIdleCheer(0.40, 0);
        }
      }, intervalMs);
    }
    return () => {
      if (idleTimer) clearTimeout(idleTimer);
    };
  }, [isRunning, isPreCountingDown, saveModalVisible, isCountUp, triggerIdleCheer]);

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
    if (isPreCountingDown) {
      showControls(true);
      return;
    }
    // 稼働中で操作ボタン・タブバーが自動非表示になっている時は、まず操作ボタンを3秒間再表示する（表示中または停止中のタップで時間設定モーダルを起動）
    if (isRunning && !controlsVisible) {
      showControls(true);
      return;
    }
    const baseSecs = (isRunning && !isCountUp && remainingTime > 0) ? remainingTime : targetTime;
    const m = Math.floor(baseSecs / 60);
    const s = baseSecs % 60;
    setManualInputMinStr(m > 0 ? m.toString() : '0');
    setManualInputSecStr(s > 0 ? s.toString() : '0');
    setTimeModalKeypadActive(null);
    setCountdownKeypadActive(null);
    setIsKeypadNewInput(true);
    setIsEditingFavorites(false);
    setTimeModalMode('time');
    setTimeModalVisible(true);
  };

  // ★ 共有タイマーと同じ分・秒トグル調整ヘルパー（サブタイマーなし）
  const handleQuickSelectTimeModalMinute = (min) => {
    setManualInputMinStr(String(min));
    setManualInputSecStr('0');
    setTimeModalKeypadActive(null);
    if (Platform.OS !== 'web') {
      Vibration.vibrate(25);
    }
  };

  const handleAdjustTimeModalMinutes = (deltaMin) => {
    const curMin = parseInt(manualInputMinStr, 10) || 0;
    const curSec = parseInt(manualInputSecStr, 10) || 0;
    const currentTotal = curMin * 60 + curSec;
    const nextTotal = Math.max(10, Math.min(999 * 60, currentTotal + deltaMin * 60));
    const nextMin = Math.floor(nextTotal / 60);
    const nextSec = nextTotal % 60;
    setManualInputMinStr(String(nextMin));
    setManualInputSecStr(String(nextSec));
    setTimeModalKeypadActive(null);
    if (Platform.OS !== 'web') {
      Vibration.vibrate(25);
    }
  };

  const handleAdjustTimeModalSeconds = (deltaSec) => {
    const curMin = parseInt(manualInputMinStr, 10) || 0;
    const curSec = parseInt(manualInputSecStr, 10) || 0;
    const currentTotal = curMin * 60 + curSec;
    const nextTotal = Math.max(10, Math.min(999 * 60, currentTotal + deltaSec));
    const nextMin = Math.floor(nextTotal / 60);
    const nextSec = nextTotal % 60;
    setManualInputMinStr(String(nextMin));
    setManualInputSecStr(String(nextSec));
    setTimeModalKeypadActive(null);
    if (Platform.OS !== 'web') {
      Vibration.vibrate(25);
    }
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

  const applyTimeInSeconds = (secs, options = {}) => {
    if (!options?.fromWatch && !options?.skipWatchSync) {
      setWatchMutedState(false);
    }
    cancelVibration();
    stopAllAlarms('main');
    if (soundRef.current) {
      soundRef.current.stopAsync().catch(() => {});
    } else if (sound) {
      sound.stopAsync().catch(() => {});
    }
    if (voiceSoundRef.current) {
      voiceSoundRef.current.stopAsync().catch(() => {});
    } else if (voiceSound) {
      voiceSound.stopAsync().catch(() => {});
    }
    targetTimeRef.current = secs;
    setTargetTime(secs);
    remainingTimeRef.current = secs;
    setRemainingTime(secs);
    isCountUpRef.current = false;
    setIsCountUp(false);
    if (isRunningRef.current) {
      targetEndTimeRef.current = Date.now() + secs * 1000;
    } else {
      targetEndTimeRef.current = null;
    }
    overStartTimeRef.current = null;
    triggeredVoicesRef.current.clear();
    triggeredOverVoicesRef.current.clear();
    isFirstCheerTriggeredRef.current = false;
    lastCheerTriggerTimeRef.current = 0;
    nextCheerIntervalMsRef.current = 0;
    setTimeModalKeypadActive(null);
    setIsEditingFavorites(false);
    setTimeModalVisible(false);
    if (Platform.OS === 'ios' && !options?.skipWatchSync) {
      const updated = {
        remainingTime: secs,
        targetTime: secs,
        targetEndTimestamp: isRunningRef.current ? targetEndTimeRef.current : 0,
        isRunning: isRunningRef.current,
        isPaused: false,
        isCountUp: false,
        isCountUpEnabled: !!isCountUpEnabledRef.current,
        genre: selectedCategoryRef.current || selectedCategory || '',
        isPreCountingDown: !!isPreCountingDownRef.current,
        preCountdownSeconds: preCountdownTimeRef.current || 0,
        isCountdownConfigEnabled: !!isCountdownEnabledRef.current,
        countdownConfigSeconds: countdownSecondsRef.current || 5,
        prepEndTimestamp: isPreCountingDownRef.current ? prepEndTimeRef.current : null,
      };
      if (setMainTimerState) {
        setMainTimerState(updated);
      }
      updateCachedMainTimerState(updated);
      syncMainTimerToWatch(updated, { immediate: true });
    }
  };
  applyTimeInSecondsRef.current = applyTimeInSeconds;

  const applyTime = (minutes) => {
    applyTimeInSeconds(Math.max(1, Math.floor(minutes * 60)));
  };

  const handleManualApply = () => {
    const min = parseInt(manualInputMinStr, 10) || 0;
    const sec = parseInt(manualInputSecStr, 10) || 0;
    const totalSecs = min * 60 + sec;
    
    if (totalSecs > 0) {
      applyTimeInSeconds(totalSecs);
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
    const snapTarget = targetTimeRef.current || targetTime || 600;
    const snapIsCountUp = !!isCountUpRef.current || !!isCountUp;
    const snapRem = remainingTimeRef.current ?? remainingTime ?? 0;
    setSaveModalSnapshot({
      targetTime: snapTarget,
      isCountUp: snapIsCountUp,
      remainingTime: snapRem,
    });
    setWatchMutedState(false);
    isRunningRef.current = false;
    isPreCountingDownRef.current = false;
    isCountUpRef.current = false;
    setIsRunning(false); // タイマーを止める
    setIsPreCountingDown(false);
    setIsCountUp(false);
    remainingTimeRef.current = snapTarget;
    setRemainingTime(snapTarget);
    cancelVibration();
    stopAllAlarms('main');
    if (soundRef.current) {
      soundRef.current.stopAsync().catch(() => {});
    } else if (sound) {
      sound.stopAsync().catch(() => {});
    }
    if (voiceSoundRef.current) {
      voiceSoundRef.current.stopAsync().catch(() => {});
    } else if (voiceSound) {
      voiceSound.stopAsync().catch(() => {});
    }
    if (targetEndTimeRef.current) {
      lastResetTargetEndRef.current = targetEndTimeRef.current;
    } else if (overStartTimeRef.current) {
      lastResetTargetEndRef.current = overStartTimeRef.current;
    }
    lastMainTimerResetAtRef.current = Date.now();
    lastAutoFinishedAtRef.current = 0;
    WatchConnectivity.notifyLocalStopOrReset('main-timer', lastResetTargetEndRef.current || 0);
    targetEndTimeRef.current = null;
    prepEndTimeRef.current = null;
    overStartTimeRef.current = null;
    triggeredVoicesRef.current.clear();
    triggeredPrepVoicesRef.current.clear();
    triggeredOverVoicesRef.current.clear();
    setForceTargetTime(false);
    if (!selectedCategory && lastUsedCategory) {
      setSelectedCategory(lastUsedCategory); // ホームで未設定の場合のみ前回のカテゴリをセット
    }
    setSaveIsFavorite(false);
    setSelectedTags([]); // タグを初期化
    setRecordDate(new Date().toISOString()); // 計測終了日時を記録
    setSaveModalVisible(true);
    // ★ 保存モーダル表示中もWatchへは停止（待機状態）として即座に同期し、超過カウントの復活・続き表示を防止
    if (Platform.OS === 'ios') {
      const stoppedState = {
        explicitStop: true,
        isExplicitReset: true,
        isAutoFinished: false,
        remainingTime: snapTarget,
        targetTime: snapTarget,
        targetEndTimestamp: 0,
        isRunning: false,
        isPaused: false,
        isCountUp: false,
        isCountUpEnabled: !!isCountUpEnabled,
        genre: selectedCategory || '',
        isPreCountingDown: false,
        preCountdownSeconds: 0,
        isCountdownConfigEnabled: !!isCountdownEnabled,
        countdownConfigSeconds: countdownSeconds || 5,
        prepEndTimestamp: null,
      };
      if (setMainTimerState) {
        setMainTimerState(stoppedState);
      }
      updateCachedMainTimerState(stoppedState);
      syncMainTimerToWatch(stoppedState, { immediate: true });
    }
  };

  const handleOpenSaveInTimeModal = () => {
    const snapTarget = targetTimeRef.current || targetTime || 600;
    const snapIsCountUp = !!isCountUpRef.current || !!isCountUp;
    const snapRem = remainingTimeRef.current ?? remainingTime ?? 0;
    setSaveModalSnapshot({
      targetTime: snapTarget,
      isCountUp: snapIsCountUp,
      remainingTime: snapRem,
    });
    setWatchMutedState(false);
    isRunningRef.current = false;
    isPreCountingDownRef.current = false;
    isCountUpRef.current = false;
    setIsRunning(false); // タイマーを止める
    setIsPreCountingDown(false);
    setIsCountUp(false);
    remainingTimeRef.current = snapTarget;
    setRemainingTime(snapTarget);
    cancelVibration();
    stopAllAlarms('main');
    if (soundRef.current) {
      soundRef.current.stopAsync().catch(() => {});
    } else if (sound) {
      sound.stopAsync().catch(() => {});
    }
    if (voiceSoundRef.current) {
      voiceSoundRef.current.stopAsync().catch(() => {});
    } else if (voiceSound) {
      voiceSound.stopAsync().catch(() => {});
    }
    if (targetEndTimeRef.current) {
      lastResetTargetEndRef.current = targetEndTimeRef.current;
    } else if (overStartTimeRef.current) {
      lastResetTargetEndRef.current = overStartTimeRef.current;
    }
    lastMainTimerResetAtRef.current = Date.now();
    lastAutoFinishedAtRef.current = 0;
    WatchConnectivity.notifyLocalStopOrReset('main-timer', lastResetTargetEndRef.current || 0);
    targetEndTimeRef.current = null;
    prepEndTimeRef.current = null;
    overStartTimeRef.current = null;
    triggeredVoicesRef.current.clear();
    triggeredPrepVoicesRef.current.clear();
    triggeredOverVoicesRef.current.clear();
    setForceTargetTime(true); // 時間内に終わったことにしてターゲットタイムを記録する
    if (!selectedCategory && lastUsedCategory) {
      setSelectedCategory(lastUsedCategory); // ホームで未設定の場合のみ前回のカテゴリをセット
    }
    setSaveIsFavorite(false);
    setSelectedTags([]); // タグを初期化
    setRecordDate(new Date().toISOString()); // 計測終了日時を記録
    setSaveModalVisible(true);
    // ★ 保存モーダル表示中もWatchへは停止（待機状態）として即座に同期
    if (Platform.OS === 'ios') {
      const stoppedState = {
        explicitStop: true,
        isExplicitReset: true,
        isAutoFinished: false,
        remainingTime: snapTarget,
        targetTime: snapTarget,
        targetEndTimestamp: 0,
        isRunning: false,
        isPaused: false,
        isCountUp: false,
        isCountUpEnabled: !!isCountUpEnabled,
        genre: selectedCategory || '',
        isPreCountingDown: false,
        preCountdownSeconds: 0,
        isCountdownConfigEnabled: !!isCountdownEnabled,
        countdownConfigSeconds: countdownSeconds || 5,
        prepEndTimestamp: null,
      };
      if (setMainTimerState) {
        setMainTimerState(stoppedState);
      }
      updateCachedMainTimerState(stoppedState);
      syncMainTimerToWatch(stoppedState, { immediate: true });
    }
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

    // 経過秒数の計算（保存モーダル起動時にキャプチャしたスナップショットを優先使用）
    const snapTarget = saveModalSnapshot?.targetTime ?? targetTime;
    const snapIsCountUp = saveModalSnapshot ? saveModalSnapshot.isCountUp : isCountUp;
    const snapRem = saveModalSnapshot ? saveModalSnapshot.remainingTime : remainingTime;
    let duration = snapIsCountUp ? snapTarget + snapRem : snapTarget - snapRem;
    
    if (forceTargetTime) {
      duration = snapTarget; // タイム内に入って終了した場合はターゲットタイムをそのまま記録
    }
    
    // タイム内達成判定（タイム内ボタン押下またはカウントアップ前終了）
    const isCompletedInTime = forceTargetTime || !snapIsCountUp;

    let finalTags = [...selectedTags];
    if (saveIsFavorite && !finalTags.includes('お気に入り')) {
      finalTags.push('お気に入り');
    } else if (!saveIsFavorite && finalTags.includes('お気に入り')) {
      finalTags = finalTags.filter(t => t !== 'お気に入り');
    }

    await saveRecord({
      date: recordDate || new Date().toISOString(),
      duration: duration,
      category: selectedCategory || '未分類',
      photoUris: photoUris,
      tags: finalTags,
      isFavorite: saveIsFavorite,
      isCompletedInTime: isCompletedInTime,
    });
    
    if (selectedCategory) {
      await AsyncStorage.setItem('lastUsedCategory', selectedCategory);
      setLastUsedCategory(selectedCategory);
    }
    
    Alert.alert("保存完了", "練習記録を保存しました！");
    
    // モーダルを閉じ、タイマーをリセットする（保存によるリセットのため中断カウントは行わない）
    setSaveModalVisible(false);
    setSaveModalSnapshot(null);
    setPhotoUris([]);
    setSaveIsFavorite(false);
    resetTimer(true);
    loadGenreStats();
    loadHomeQuickStats();

    // 記録保存完了後、ホームに戻ってきた直後にトコトコ歩いて労い・次の気合を声掛け（出現率85%）
    triggerIdleCheer(0.85, 1500);
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

  // ジャンル別統計の取得
  const loadGenreStats = async () => {
    try {
      const stats = await getFullPracticeStats();
      if (stats && stats.genreMap) {
        setGenreStatsMap(stats.genreMap);
      }
    } catch (e) {
      console.error('Failed to load genre stats', e);
    }
  };

  // ホーム画面クイック練習統計サマリーの取得
  const loadHomeQuickStats = useCallback(async (cat = selectedCategory) => {
    try {
      const stats = await getQuickStatsSummary(cat || null);
      setHomeQuickStats(stats);
    } catch (e) {
      console.error('Failed to load home quick stats', e);
    }
  }, [selectedCategory]);

  useEffect(() => {
    if (isFocused) {
      loadGenreStats();
      loadHomeQuickStats();
    }
  }, [isFocused, selectedCategory, loadHomeQuickStats]);

  // ---- ホーム画面ジャンル選択モーダル操作ハンドラー ----
  const handleOpenGenreModal = () => {
    Vibration.vibrate(30);
    loadGenreStats();
    setIsAddingGenreModal(false);
    setNewGenreNameInput('');
    setGenreModalVisible(true);
  };

  const handleSelectGenre = async (category) => {
    Vibration.vibrate(30);
    setSelectedCategory(category);
    setGenreModalVisible(false);
    loadHomeQuickStats(category);
    try {
      await AsyncStorage.setItem('lastUsedCategory', category);
      setLastUsedCategory(category);
    } catch (e) {
      console.error('Error saving lastUsedCategory', e);
    }
  };

  const handleClearGenre = async () => {
    Vibration.vibrate(30);
    setSelectedCategory('');
    setGenreModalVisible(false);
    loadHomeQuickStats('');
    try {
      await AsyncStorage.removeItem('lastUsedCategory');
      setLastUsedCategory('');
    } catch (e) {
      console.error('Error clearing lastUsedCategory', e);
    }
  };

  const handleAddGenreFromModal = async () => {
    const trimmed = newGenreNameInput.trim();
    if (trimmed) {
      Vibration.vibrate(30);
      const newCats = [...savedCategories, trimmed];
      const uniqueCats = Array.from(new Set(newCats));
      setSavedCategories(uniqueCats);
      setSelectedCategory(trimmed);
      setNewGenreNameInput('');
      setIsAddingGenreModal(false);
      setGenreModalVisible(false);
      loadHomeQuickStats(trimmed);
      try {
        await AsyncStorage.setItem('savedCategories', JSON.stringify(uniqueCats));
        await AsyncStorage.setItem('lastUsedCategory', trimmed);
        setLastUsedCategory(trimmed);
      } catch (e) {
        console.error('Error saving new category', e);
      }
    }
  };

  // インジケーター（プログレスリング）の進捗およびカラー計算
  let ringColor = '#007AFF'; // デフォルト: ブルー
  let activeProgress = 0;

  if (isPreCountingDown) {
    // 準備カウントダウン中はMAXブルー固定
    activeProgress = 1;
    ringColor = '#007AFF';
  } else if (!isCountUp) {
    // 通常タイマー計測中（カウントダウン）
    activeProgress = Math.max(0, targetTime > 0 ? remainingTime / targetTime : 0);

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
    // タイム終了後のカウントアップ中（超過時間計測）: 赤のインジケーター（3分で1周、以降ループ）
    ringColor = '#FF3B30';
    const COUNT_UP_CYCLE_SECONDS = 180; // 3分（180秒）で1周
    const safeRemaining = Math.max(0, remainingTime || 0);
    if (safeRemaining === 0) {
      activeProgress = 0;
    } else {
      activeProgress = (((safeRemaining - 1) % COUNT_UP_CYCLE_SECONDS) + 1) / COUNT_UP_CYCLE_SECONDS;
    }
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
    const nextVal = !isCountdownEnabled;
    toggleCountdownEnabled();
    if (nextVal) {
      cheerOverlayRef.current?.trigger('setting', 0.7);
    }
  };

  const handleOpenCountdownDirectly = () => {
    Vibration.vibrate(50);
    setTimeModalMode('countdown');
    setTimeModalVisible(true);
  };

  const handleToggleCountUp = () => {
    Vibration.vibrate(30);
    const nextVal = !isCountUpEnabled;
    toggleCountUpEnabled();
    if (nextVal) {
      cheerOverlayRef.current?.trigger('setting', 0.7);
    }
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

  // 小型端末（iPhone SE等の screenHeight < 720 / 680）でも下部操作ボタンが広告バナーと重ならず
  // 完全に見切れない安全な余白・スケーリングを自動算出
  const isSmallDevice = screenHeight < 720;
  const isTinyDevice = screenHeight < 680;

  // 上部バランサー領域の高さ（クイックアクセスバー、ジャンル選択バッジ、統計サマリーの収容領域）
  const topBalanceHeight = isTinyDevice ? 130 : (isSmallDevice ? 126 : 138);

  // インジケーター（タイマー円）の位置：
  // 統計サマリー展開時でもタイマー円との安全なクリアランス（標準11px、小型3〜5px）を維持し、端末サイズ別に最適固定
  const contentTopShift = isTinyDevice ? 18 : (isSmallDevice ? 20 : 26);

  // 上側コントロール群（クイックアクセスバー・ジャンルバッジ・サマリー）の垂直シフト：
  // 標準端末（iPhone 16 Pro等）は常に0固定（タブバー裏への潜り込み・見切れを根本解消）。
  // 小型端末（iPhone SE等）のみ、サマリー展開時の高さ増加を吸収するため微小スライド（-10px）を適用。
  const topControlsShift = (isHomeStatsEnabled && !isHomeStatsCollapsed)
    ? (isSmallDevice ? -10 : 0)
    : 0;

  // ボタン群（スタート・リセット・記録保存）の垂直位置も完全固定
  const timerMarginBottom = isTinyDevice ? 12 : (isSmallDevice ? 14 : 22);
  const controlsTopShift = isTinyDevice ? 10 : (isSmallDevice ? 8 : 16);

  // NEWSバッジの垂直位置（タブバー下線との干渉を防ぐ安全クリアランス）
  const newsBadgeTop = isTinyDevice ? 10 : 14;

  // 小型端末でのタイマー円半径（超小型端末では240px、小型端末では250px、通常は280px）
  const timerRadius = isTinyDevice ? 120 : (isSmallDevice ? 125 : 140);
  const timerContainerSize = timerRadius * 2;

  return (
    <TouchableWithoutFeedback onPress={handleScreenPress}>
      <View style={[styles.container, { backgroundColor: bgColor }]}>
        {/* 画面左上 NEWS バッジ */}
        <Animated.View 
          style={[
            styles.newsBadgeContainer, 
            { 
              top: newsBadgeTop,
              opacity: controlsOpacity 
            }
          ]} 
          pointerEvents={controlsVisible ? 'auto' : 'none'}
        >
          <NewsBadge
            unreadCount={unreadNewsCount}
            isHiddenUntilNext={isNewsHiddenUntilNext}
            onPress={() => setNewsModalVisible(true)}
          />
        </Animated.View>

        <View style={styles.content}>
          {/* タイマー上部クイックアクセスバー ＆ バランサー領域 */}
          <View style={[styles.topBalanceContainer, { height: topBalanceHeight }]}>
            <Animated.View 
              style={[
                styles.quickAccessBarWrapper, 
                { 
                  top: topControlsShift,
                  opacity: controlsOpacity 
                }
              ]} 
              pointerEvents={controlsVisible ? 'auto' : 'none'}
            >
              {isQuickAccessBarEnabled ? (
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
            ) : (
              <View style={styles.quickAccessBarPlaceholder} />
            )}

              {/* 計測ジャンル表示・選択バッジ */}
              <TouchableOpacity
                style={[
                  styles.genreBadge,
                  selectedCategory
                    ? (isEcoMode ? styles.genreBadgeSelectedEco : styles.genreBadgeSelected)
                    : (isEcoMode ? styles.genreBadgeEco : styles.genreBadgeNormal)
                ]}
                onPress={handleOpenGenreModal}
                activeOpacity={0.7}
                disabled={!controlsVisible}
                hitSlop={{ top: 10, bottom: 10, left: 16, right: 16 }}
              >
                <Ionicons
                  name={selectedCategory ? "pricetag" : "pricetag-outline"}
                  size={19}
                  color={
                    selectedCategory
                      ? (isEcoMode ? '#64D2FF' : '#007AFF')
                      : (isEcoMode ? '#8E8E93' : '#687076')
                  }
                  style={{ marginRight: 7 }}
                />
                <Text
                  style={[
                    styles.genreBadgeText,
                    selectedCategory
                      ? (isEcoMode ? styles.genreBadgeTextSelectedEco : styles.genreBadgeTextSelected)
                      : (isEcoMode ? styles.genreBadgeTextEco : styles.genreBadgeTextNormal)
                  ]}
                  numberOfLines={1}
                >
                  {selectedCategory || 'ジャンル未設定'}
                </Text>
                <Ionicons
                  name="chevron-down"
                  size={16}
                  color={
                    selectedCategory
                      ? (isEcoMode ? '#64D2FF' : '#007AFF')
                      : (isEcoMode ? '#666' : '#8E8E93')
                  }
                  style={{ marginLeft: 6 }}
                />
              </TouchableOpacity>

              {/* 計測ジャンル直下の練習統計サマリー */}
              {isHomeStatsEnabled && homeQuickStats && (
                <HomeStatsSummary
                  stats={homeQuickStats}
                  isEcoMode={isEcoMode}
                  isCollapsed={isHomeStatsCollapsed}
                  onToggleCollapse={toggleHomeStatsCollapsed}
                  disabled={!controlsVisible}
                />
              )}
            </Animated.View>
          </View>
          <View style={[
            styles.timerContainer, 
            { 
              width: timerContainerSize,
              height: timerContainerSize,
              top: contentTopShift, 
              marginBottom: timerMarginBottom 
            }
          ]}>
          {(isEcoMode ? isEcoIndicatorEnabled : isNormalIndicatorEnabled) && (
            <RingProgress 
              radius={timerRadius} 
              strokeWidth={isTinyDevice ? 13 : 15} 
              progress={activeProgress} 
              color={ringColor}
              backgroundColor={ringBgColor}
              fillColor="transparent"
              isIdle={!isRunning && !isPreCountingDown && !isCountUp && remainingTime === targetTime}
              isEcoMode={isEcoMode}
            />
          )}
          {/* インジケーター内部全体の円形タップ領域（時間設定モーダル呼出・稼働中ボタン非表示時はボタン再表示） */}
          <TouchableOpacity
            style={[
              styles.timerTouchArea,
              {
                width: timerContainerSize,
                height: timerContainerSize,
                borderRadius: timerRadius,
              }
            ]}
            onPress={handleOpenTimeModal}
            activeOpacity={0.7}
          >
            <View style={styles.timeTextContainer} pointerEvents="none">
              {isPreCountingDown ? (
                <Text 
                  style={[preCountdownTime <= 10 ? styles.preCountdownText : styles.timeText, { color: mainTextColor }]}
                  allowFontScaling={false}
                >
                  {preCountdownTime <= 10 ? preCountdownTime : formatTime(preCountdownTime)}
                </Text>
              ) : (
                <Text 
                  style={[styles.timeText, { color: isCountUp ? '#FF3B30' : mainTextColor, fontSize: isTinyDevice ? 42 : 48 }]}
                  allowFontScaling={false}
                >
                  {isCountUp ? '+' : ''}{formatTime(remainingTime)}
                </Text>
              )}
              {(isEcoMode ? isEcoTargetTimeEnabled : isNormalTargetTimeEnabled) && !isPreCountingDown && (isRunning || remainingTime !== targetTime || isCountUp) && (
                <View 
                  style={[
                    styles.targetTimePill,
                    isEcoMode ? styles.targetTimePillEco : styles.targetTimePillNormal
                  ]}
                  pointerEvents="none"
                >
                  <Text 
                    style={[
                      styles.targetTimePillText,
                      { color: isEcoMode ? '#8E8E93' : '#3A3A3C' }
                    ]}
                    numberOfLines={1}
                    allowFontScaling={false}
                  >
                    {formatTargetTime(targetTime)}
                  </Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        </View>

        <Animated.View 
          style={[
            styles.bottomControlsWrapper, 
            { top: controlsTopShift, opacity: controlsOpacity }
          ]} 
          pointerEvents={controlsVisible ? 'auto' : 'none'}
        >
          <View style={styles.controlsContainer}>
            <TouchableOpacity style={styles.button} onPress={() => toggleTimer(false)} disabled={!controlsVisible}>
              <Text style={styles.buttonText} allowFontScaling={false}>{isRunning || isPreCountingDown ? '一時停止' : 'スタート'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.resetButton]} onPress={() => resetTimer(false)} disabled={!controlsVisible}>
              <Text style={[styles.buttonText, { color: '#000' }]} allowFontScaling={false}>リセット</Text>
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
                    <Text style={styles.splitEndButtonMainText}>タイマーを止める</Text>
                    <Text style={styles.splitEndButtonSubText}>タイム内</Text>
                  </TouchableOpacity>
                  
                  <View style={styles.splitEndButtonDivider} />

                  <TouchableOpacity 
                    style={[styles.splitEndButtonHalf, { backgroundColor: '#FF3B30' }]} 
                    onPress={handleOpenSaveModal}
                  >
                    <Text style={styles.splitEndButtonMainText}>タイマーを止める</Text>
                    <Text style={styles.splitEndButtonSubText}>タイムオーバー</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.endMeasurementButton} onPress={handleOpenSaveModal}>
                  <Text style={[styles.buttonText, { fontWeight: 'bold' }]}>タイマーを止める</Text>
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
        <KeyboardAvoidingView 
          style={{ flex: 1 }} 
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView contentContainerStyle={[styles.modalContainer, { paddingBottom: 60 }]}>
            <Text style={styles.modalTitle}>練習結果の記録</Text>

          {/* 計測時間の詳細表示 */}
          <View style={{ backgroundColor: isEcoMode ? '#333' : '#F2F2F7', padding: 15, borderRadius: 10, width: '100%', marginBottom: 20, alignItems: 'center' }}>
            {(() => {
              const snapTarget = saveModalSnapshot?.targetTime ?? targetTime;
              const snapIsCountUp = saveModalSnapshot ? saveModalSnapshot.isCountUp : isCountUp;
              const snapRem = saveModalSnapshot ? saveModalSnapshot.remainingTime : remainingTime;
              let actualDuration = snapIsCountUp ? snapTarget + snapRem : snapTarget - snapRem;
              if (forceTargetTime) actualDuration = snapTarget;
              
              const isOver = snapIsCountUp && !forceTargetTime;
              const overSeconds = snapIsCountUp && !forceTargetTime ? snapRem : 0;
              
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
            <Text style={{ fontSize: 13, color: isEcoMode ? '#aaa' : '#666', marginTop: 8 }}>
              練習日時: {formatRecordDateTime(recordDate || new Date().toISOString())}
            </Text>
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

          {/* お気に入り登録トグルカード */}
          <TouchableOpacity
            style={[
              styles.favoriteToggleCard,
              saveIsFavorite && styles.favoriteToggleCardActive,
              isEcoMode && (saveIsFavorite ? styles.favoriteToggleCardActiveEco : styles.favoriteToggleCardEco)
            ]}
            onPress={() => {
              const nextFav = !saveIsFavorite;
              setSaveIsFavorite(nextFav);
              if (nextFav) {
                if (!selectedTags.includes('お気に入り')) {
                  setSelectedTags([...selectedTags, 'お気に入り']);
                }
              } else {
                setSelectedTags(selectedTags.filter(t => t !== 'お気に入り'));
              }
            }}
            activeOpacity={0.7}
          >
            <Ionicons 
              name={saveIsFavorite ? "star" : "star-outline"} 
              size={24} 
              color={saveIsFavorite ? "#FFB800" : (isEcoMode ? "#888" : "#8E8E93")} 
              style={{ marginRight: 10 }}
            />
            <View style={{ flex: 1 }}>
              <Text style={[
                styles.favoriteToggleTitle, 
                saveIsFavorite && styles.favoriteToggleTitleActive,
                isEcoMode && { color: saveIsFavorite ? '#FFD60A' : '#FFF' }
              ]}>
                {saveIsFavorite ? '★ お気に入りに登録中' : '☆ お気に入りに登録する'}
              </Text>
              <Text style={[styles.favoriteToggleSubtitle, isEcoMode && { color: '#888' }]}>
                {saveIsFavorite ? '記録一覧でお気に入りフィルターや優先並び替えができます' : 'タップしてこの練習をお気に入りに指定'}
              </Text>
            </View>
          </TouchableOpacity>

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
                      if (tag === 'お気に入り') setSaveIsFavorite(false);
                    } else {
                      setSelectedTags([...selectedTags, tag]);
                      if (tag === 'お気に入り') setSaveIsFavorite(true);
                    }
                  }}
                >
                  <Text style={[styles.categoryChipText, isSelected && styles.categoryChipTextSelected]}>{tag}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity style={[styles.saveActionButton, {marginTop: 35}]} onPress={handleSaveRecord}>
             <Text style={styles.saveActionText}>記録を保存してリセット</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={[styles.resetButton, {marginTop: 15, padding: 15, borderRadius: 10}]} 
            onPress={() => {
              setSaveModalVisible(false);
              setSaveModalSnapshot(null);
              setSaveIsFavorite(false);
              resetTimer(true);
            }}
          >
             <Text style={{textAlign: 'center', color: '#000', fontWeight: 'bold'}}>キャンセル</Text>
          </TouchableOpacity>
        </ScrollView>
        </KeyboardAvoidingView>
        
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

        {/* 記録保存モーダル用 応援キャラクター【やまいも】オーバーレイ */}
        <CheerYamaimoOverlay
          ref={saveModalCheerRef}
          isCheerModeEnabled={isCheerModeEnabled}
          isCheerInEcoEnabled={isCheerInEcoEnabled}
          isCheerSoundEnabled={isCheerSoundEnabled}
          playsInSilentMode={playsInSilentMode}
          isEcoMode={isEcoMode}
        />
      </Modal>

      {/* タイマー・カウントダウン設定モーダル（1つのモーダルで中身を切り替える） */}
      <Modal visible={timeModalVisible} animationType="fade" transparent={true}>
        <View style={styles.timeModalOverlay}>
          <View style={[styles.timeModalContent, { backgroundColor: isEcoMode ? '#222' : '#fff' }]}>
            <ScrollView 
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ alignItems: 'center', width: '100%', paddingBottom: 10 }}
              style={{ width: '100%' }}
              nestedScrollEnabled={true}
            >
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

                {/* ★ 共有タイマーと同じ分・秒トグル調整バー ＆ クイック選択ピル（サブタイマーなし） */}
                {!timeModalKeypadActive && (
                  <View style={{ width: '100%', marginTop: 10 }}>
                    {/* クイック選択ピル（1分、3分、5分、7分、10分、15分、20分、30分） */}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8, justifyContent: 'center' }}>
                      {[1, 3, 5, 7, 10, 15, 20, 30].map((min) => {
                        const isPillSelected =
                          (parseInt(manualInputMinStr, 10) || 0) === min &&
                          (parseInt(manualInputSecStr, 10) || 0) === 0;
                        return (
                          <TouchableOpacity
                            key={min}
                            activeOpacity={0.7}
                            style={{
                              paddingHorizontal: 11,
                              paddingVertical: 6,
                              borderRadius: 16,
                              borderWidth: 1,
                              backgroundColor: isPillSelected
                                ? '#007AFF'
                                : (isEcoMode ? '#2C2C2E' : '#F2F2F7'),
                              borderColor: isPillSelected
                                ? '#007AFF'
                                : (isEcoMode ? '#3A3A3C' : '#E0E0E5'),
                            }}
                            onPress={() => handleQuickSelectTimeModalMinute(min)}
                          >
                            <Text
                              style={{
                                fontSize: 13,
                                fontWeight: isPillSelected ? '700' : '600',
                                color: isPillSelected ? '#FFFFFF' : (isEcoMode ? '#FFFFFF' : '#1C1C1E'),
                              }}
                            >
                              {min}分
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    {/* 1分・5分単位の微調整トグルバー（-5分, -1分, +1分, +5分） */}
                    <View style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}>
                      {[-5, -1, 1, 5].map((deltaMin) => (
                        <TouchableOpacity
                          key={`min-${deltaMin}`}
                          activeOpacity={0.7}
                          style={{
                            flex: 1,
                            paddingVertical: 8,
                            borderRadius: 8,
                            borderWidth: 1,
                            alignItems: 'center',
                            backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7',
                            borderColor: isEcoMode ? '#3A3A3C' : '#E0E0E5',
                          }}
                          onPress={() => handleAdjustTimeModalMinutes(deltaMin)}
                        >
                          <Text
                            style={{
                              fontSize: 13,
                              fontWeight: '700',
                              color: deltaMin > 0 ? '#007AFF' : (isEcoMode ? '#E5E5EA' : '#1C1C1E'),
                            }}
                          >
                            {deltaMin > 0 ? `+${deltaMin}分` : `${deltaMin}分`}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    {/* 10秒・30秒単位の微調整トグルバー（-30秒, -10秒, +10秒, +30秒） */}
                    <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10 }}>
                      {[-30, -10, 10, 30].map((deltaSec) => (
                        <TouchableOpacity
                          key={`sec-${deltaSec}`}
                          activeOpacity={0.7}
                          style={{
                            flex: 1,
                            paddingVertical: 8,
                            borderRadius: 8,
                            borderWidth: 1,
                            alignItems: 'center',
                            backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7',
                            borderColor: isEcoMode ? '#3A3A3C' : '#E0E0E5',
                          }}
                          onPress={() => handleAdjustTimeModalSeconds(deltaSec)}
                        >
                          <Text
                            style={{
                              fontSize: 13,
                              fontWeight: '700',
                              color: deltaSec > 0 ? '#007AFF' : (isEcoMode ? '#AEAEB2' : '#636366'),
                            }}
                          >
                            {deltaSec > 0 ? `+${deltaSec}秒` : `${deltaSec}秒`}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    <TouchableOpacity 
                      style={[styles.applyButton, { alignSelf: 'center', width: '100%', marginTop: 2, marginBottom: 14, paddingVertical: 11 }]} 
                      onPress={handleManualApply}
                    >
                      <Text style={styles.applyButtonText}>決定</Text>
                    </TouchableOpacity>
                  </View>
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
            </ScrollView>
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

      {/* ホーム画面 ジャンル選択モーダル */}
      <Modal
        visible={genreModalVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setGenreModalVisible(false)}
      >
        <TouchableWithoutFeedback onPress={() => setGenreModalVisible(false)}>
          <View style={styles.genreModalOverlay}>
            <KeyboardAvoidingView 
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={{ width: '100%', alignItems: 'center' }}
            >
              <TouchableWithoutFeedback onPress={() => {}}>
                <View style={[
                styles.genreModalContent,
                { 
                  backgroundColor: isEcoMode ? '#1C1C1E' : '#FFFFFF', 
                  borderColor: isEcoMode ? '#2C2C2E' : '#E5E5EA' 
                }
              ]}>
                {/* モーダルヘッダー */}
                <View style={styles.genreModalHeader}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons 
                      name="pricetag-outline" 
                      size={18} 
                      color={isEcoMode ? '#64D2FF' : '#007AFF'} 
                      style={{ marginRight: 8 }}
                    />
                    <Text style={[styles.genreModalTitle, { color: isEcoMode ? '#FFFFFF' : '#000000' }]}>
                      ジャンルの選択
                    </Text>
                  </View>
                  <TouchableOpacity 
                    onPress={() => setGenreModalVisible(false)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons name="close" size={22} color={isEcoMode ? '#8E8E93' : '#8E8E93'} />
                  </TouchableOpacity>
                </View>

                {/* 現在選択中のステータス ＆ 解除ボタン */}
                <View style={[
                  styles.genreModalCurrentBox,
                  { backgroundColor: isEcoMode ? '#252528' : '#F2F2F7' }
                ]}>
                  <Text style={[styles.genreModalCurrentLabel, { color: isEcoMode ? '#AAA' : '#666' }]}>
                    現在:
                  </Text>
                  <Text style={[
                    styles.genreModalCurrentValue,
                    { color: selectedCategory ? (isEcoMode ? '#64D2FF' : '#007AFF') : (isEcoMode ? '#888' : '#8E8E93') }
                  ]}>
                    {selectedCategory || '未設定'}
                  </Text>
                  {selectedCategory ? (
                    <TouchableOpacity 
                      style={styles.genreModalClearBtn}
                      onPress={handleClearGenre}
                    >
                      <Text style={styles.genreModalClearBtnText}>未設定に戻す</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>

                {/* 登録済みジャンルチップ一覧 */}
                <Text style={[styles.genreModalSectionTitle, { color: isEcoMode ? '#8E8E93' : '#8E8E93' }]}>
                  登録ジャンルから選択
                </Text>
                <ScrollView style={{ maxHeight: 240 }} contentContainerStyle={styles.genreModalListContainer} showsVerticalScrollIndicator={true}>
                  {savedCategories.map((cat, index) => {
                    const isSelected = selectedCategory === cat;
                    const stat = genreStatsMap && genreStatsMap[cat];
                    const completedCount = stat ? stat.completed : 0;
                    const lastDate = stat ? stat.lastPracticedRelative : '未実施';
                    const streak = stat ? stat.streakDays : 0;

                    return (
                      <TouchableOpacity
                        key={`modal-genre-${index}-${cat}`}
                        style={[
                          styles.genreListItem,
                          isSelected
                            ? (isEcoMode ? styles.genreListItemSelectedEco : styles.genreListItemSelected)
                            : (isEcoMode ? styles.genreListItemEco : styles.genreListItemNormal)
                        ]}
                        onPress={() => handleSelectGenre(cat)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.genreListItemLeft}>
                          <View style={styles.genreListItemHeader}>
                            {isSelected && (
                              <Ionicons 
                                name="checkmark-circle" 
                                size={16} 
                                color={isEcoMode ? '#64D2FF' : '#007AFF'} 
                                style={{ marginRight: 6 }} 
                              />
                            )}
                            <Text style={[
                              styles.genreListItemTitle,
                              isSelected
                                ? (isEcoMode ? styles.genreListItemTitleSelectedEco : styles.genreListItemTitleSelected)
                                : (isEcoMode ? styles.genreListItemTitleEco : styles.genreListItemTitleNormal)
                            ]}>
                              {cat}
                            </Text>
                          </View>
                          
                          <View style={styles.genreListItemSubRow}>
                            <Text style={[styles.genreListItemSubText, { color: isEcoMode ? '#888' : '#8E8E93' }]}>
                              📅 最終: {lastDate}
                            </Text>
                            {streak > 0 ? (
                              <Text style={[styles.genreListItemSubText, { color: '#FF9500', fontWeight: '600' }]}>
                                🔥 {streak}日連続
                              </Text>
                            ) : null}
                          </View>
                        </View>

                        <View style={styles.genreListItemRight}>
                          <Text style={[
                            styles.genreListItemCountNum,
                            { color: isSelected ? (isEcoMode ? '#64D2FF' : '#007AFF') : (isEcoMode ? '#AAA' : '#444') }
                          ]}>
                            {completedCount}
                          </Text>
                          <Text style={[styles.genreListItemCountUnit, { color: isEcoMode ? '#777' : '#8E8E93' }]}>回</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>

                {/* 新規ジャンル追加エリア */}
                {isAddingGenreModal ? (
                  <View style={styles.genreModalAddInputRow}>
                    <TextInput
                      style={[
                        styles.genreModalInput,
                        { 
                          backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7',
                          color: isEcoMode ? '#FFF' : '#000',
                          borderColor: isEcoMode ? '#3A3A3C' : '#E5E5EA'
                        }
                      ]}
                      placeholder="新しいジャンル名を入力"
                      placeholderTextColor={isEcoMode ? '#666' : '#999'}
                      value={newGenreNameInput}
                      onChangeText={setNewGenreNameInput}
                      autoFocus={true}
                      onSubmitEditing={handleAddGenreFromModal}
                    />
                    <TouchableOpacity
                      style={[
                        styles.genreModalAddConfirmBtn,
                        { opacity: newGenreNameInput.trim() ? 1 : 0.5 }
                      ]}
                      onPress={handleAddGenreFromModal}
                      disabled={!newGenreNameInput.trim()}
                    >
                      <Text style={styles.genreModalAddConfirmBtnText}>追加</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.genreModalAddCancelBtn}
                      onPress={() => {
                        setIsAddingGenreModal(false);
                        setNewGenreNameInput('');
                      }}
                    >
                      <Text style={[styles.genreModalAddCancelBtnText, { color: isEcoMode ? '#8E8E93' : '#8E8E93' }]}>取消</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[
                      styles.genreModalAddToggleBtn,
                      { 
                        borderColor: isEcoMode ? '#3A3A3C' : '#D1D1D6',
                        backgroundColor: isEcoMode ? 'transparent' : '#FAFAFA'
                      }
                    ]}
                    onPress={() => setIsAddingGenreModal(true)}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="add" size={16} color={isEcoMode ? '#64D2FF' : '#007AFF'} style={{ marginRight: 4 }} />
                    <Text style={[styles.genreModalAddToggleText, { color: isEcoMode ? '#64D2FF' : '#007AFF' }]}>
                      新しいジャンルを追加
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </TouchableWithoutFeedback>
            </KeyboardAvoidingView>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* Proプラン（月額100円）購入モーダル */}
      <ProSubscriptionModal visible={proModalVisible} onClose={() => setProModalVisible(false)} />

      {/* 応援キャラクター【やまいも】オーバーレイ */}
      <CheerYamaimoOverlay
        ref={cheerOverlayRef}
        isCheerModeEnabled={isCheerModeEnabled}
        isCheerInEcoEnabled={isCheerInEcoEnabled}
        isCheerSoundEnabled={isCheerSoundEnabled && !isWatchMuted}
        playsInSilentMode={playsInSilentMode}
        isEcoMode={isEcoMode}
      />

      {/* NEWS（お知らせ）モーダル */}
      <NewsModal
        visible={newsModalVisible}
        onClose={() => setNewsModalVisible(false)}
        readNewsIds={readNewsIds}
        onMarkAsRead={markNewsAsRead}
        onMarkAllAsRead={markAllNewsAsRead}
        onHideUntilNextUpdate={() => {
          hideNewsUntilNextUpdate();
          setNewsModalVisible(false);
        }}
        onRestoreNewsIcon={restoreNewsIcon}
        isNewsHiddenUntilNext={isNewsHiddenUntilNext}
        isEcoMode={isEcoMode}
      />

    </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  newsBadgeContainer: {
    position: 'absolute',
    left: 10,
    zIndex: 100,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topBalanceContainer: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-start', // 上端基準にすることで、サマリーの有無（ON/OFF）による重心変動・位置ズレを完全排除
  },
  quickAccessBarWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickAccessBar: {
    height: 47,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderRadius: 22,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  quickAccessBarPlaceholder: {
    height: 47,
    width: '100%',
  },
  quickAccessButton: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 16,
    minWidth: 42,
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
  genreBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    marginTop: 10,
    maxWidth: 280,
  },
  genreBadgeNormal: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E5EA',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2.5,
    elevation: 2,
  },
  genreBadgeSelected: {
    backgroundColor: '#F0F8FF',
    borderColor: '#B9DCFF',
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2.5,
    elevation: 2,
  },
  genreBadgeEco: {
    backgroundColor: '#1C1C1E',
    borderColor: '#2C2C2E',
  },
  genreBadgeSelectedEco: {
    backgroundColor: '#15232D',
    borderColor: '#1E3A4C',
  },
  genreBadgeText: {
    fontSize: 18,
    letterSpacing: 0.2,
  },
  genreBadgeTextNormal: {
    color: '#687076',
    fontWeight: '600',
  },
  genreBadgeTextSelected: {
    color: '#007AFF',
    fontWeight: '700',
  },
  genreBadgeTextEco: {
    color: '#8E8E93',
    fontWeight: '600',
  },
  genreBadgeTextSelectedEco: {
    color: '#64D2FF',
    fontWeight: '700',
  },
  timerContainer: {
    top: 20,
    width: 280,
    height: 280, // RingProgress (radius 140 * 2) と同寸に保つことで、インジケーター非表示時でもスイッチバーやボタンとのバランス・配置を完全維持
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: screenHeight < 700 ? 30 : 60,
  },
  timerTouchArea: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
  },
  bottomControlsWrapper: {
    top: 20,
    width: '100%',
    alignItems: 'center',
  },
  timeTextContainer: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 200, // 1文字（0秒や1桁秒など）時でもコンテナ幅が極端に縮小して下部ピルが縦潰れするのを防止
  },
  timeText: {
    fontSize: 48,
    fontWeight: '500',
    fontVariant: ['tabular-nums'], // 数字の幅を等間隔にして揺れを防止
    textAlign: 'center',
  },
  preCountdownText: {
    fontSize: 120, // 枠いっぱいの大きなサイズ
    fontWeight: 'bold',
    fontVariant: ['tabular-nums'], // こちらも揺れを防止
    textAlign: 'center',
  },
  targetTimePill: {
    position: 'absolute',
    bottom: -32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 3,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignSelf: 'center',
  },
  targetTimePillNormal: {
    backgroundColor: '#EBECEF',
    borderWidth: 0.5,
    borderColor: '#DFE0E5',
  },
  targetTimePillEco: {
    backgroundColor: '#1C1C1E',
    borderWidth: 0.5,
    borderColor: '#2C2C2E',
  },
  targetTimePillText: {
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    flexShrink: 0, // テキストの改行・縦潰れを防止
    textAlign: 'center',
  },
  controlsContainer: {
    flexDirection: 'row',
    gap: 20,
    marginBottom: 16, // saveボタンなどとの余白を最適化して上に調整
  },
  bottomActionArea: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    height: 64, // 計測終了ボタンの高さに合わせて固定領域を確保し、スタート前後の位置ズレを防止
    marginTop: 10,
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
  favoriteToggleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F2F2F7',
    borderWidth: 1.5,
    borderColor: '#E5E5EA',
    borderRadius: 12,
    padding: 12,
    marginTop: 15,
    marginBottom: 5,
  },
  favoriteToggleCardActive: {
    backgroundColor: '#FFF9E6',
    borderColor: '#FFB800',
  },
  favoriteToggleCardEco: {
    backgroundColor: '#1C1C1E',
    borderColor: '#333333',
  },
  favoriteToggleCardActiveEco: {
    backgroundColor: '#2A2410',
    borderColor: '#FFB800',
  },
  favoriteToggleTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#333',
  },
  favoriteToggleTitleActive: {
    color: '#B27B00',
  },
  favoriteToggleSubtitle: {
    fontSize: 11,
    color: '#8E8E93',
    marginTop: 2,
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
    maxHeight: '88%',
    borderRadius: 15,
    padding: 16,
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

  // ジャンル選択モーダル スタイル
  genreModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  genreModalContent: {
    width: '100%',
    maxWidth: 340,
    maxHeight: '90%',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  genreModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  genreModalTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  genreModalCurrentBox: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 14,
  },
  genreModalCurrentLabel: {
    fontSize: 12,
    marginRight: 6,
  },
  genreModalCurrentValue: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  genreModalClearBtn: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 59, 48, 0.1)',
  },
  genreModalClearBtnText: {
    fontSize: 11,
    color: '#FF3B30',
    fontWeight: '600',
  },
  genreModalSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  genreModalListContainer: {
    paddingBottom: 4,
    gap: 8,
  },
  genreListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  genreListItemNormal: {
    backgroundColor: '#F8F9FA',
    borderColor: '#E5E5EA',
  },
  genreListItemSelected: {
    backgroundColor: '#EBF4FF',
    borderColor: '#007AFF',
  },
  genreListItemEco: {
    backgroundColor: '#252528',
    borderColor: '#3A3A3C',
  },
  genreListItemSelectedEco: {
    backgroundColor: '#1E3A4C',
    borderColor: '#64D2FF',
  },
  genreListItemLeft: {
    flex: 1,
  },
  genreListItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },
  genreListItemTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  genreListItemTitleNormal: {
    color: '#000000',
  },
  genreListItemTitleSelected: {
    color: '#007AFF',
  },
  genreListItemTitleEco: {
    color: '#FFFFFF',
  },
  genreListItemTitleSelectedEco: {
    color: '#64D2FF',
  },
  genreListItemSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  genreListItemSubText: {
    fontSize: 11,
  },
  genreListItemRight: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginLeft: 8,
  },
  genreListItemCountNum: {
    fontSize: 17,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  genreListItemCountUnit: {
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 2,
  },
  genreChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    paddingHorizontal: 13,
    borderRadius: 16,
    borderWidth: 1,
  },
  genreChipNormal: {
    backgroundColor: '#F2F2F7',
    borderColor: '#E5E5EA',
  },
  genreChipSelected: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  genreChipEco: {
    backgroundColor: '#2C2C2E',
    borderColor: '#3A3A3C',
  },
  genreChipSelectedEco: {
    backgroundColor: '#1E3A4C',
    borderColor: '#64D2FF',
  },
  genreChipText: {
    fontSize: 13,
  },
  genreChipTextNormal: {
    color: '#1C1C1E',
    fontWeight: '500',
  },
  genreChipTextSelected: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  genreChipTextEco: {
    color: '#E5E5EA',
    fontWeight: '500',
  },
  genreChipTextSelectedEco: {
    color: '#64D2FF',
    fontWeight: '700',
  },
  genreModalAddToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  genreModalAddToggleText: {
    fontSize: 12,
    fontWeight: '600',
  },
  genreModalAddInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    gap: 8,
  },
  genreModalInput: {
    flex: 1,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 13,
  },
  genreModalAddConfirmBtn: {
    backgroundColor: '#007AFF',
    paddingVertical: 9,
    paddingHorizontal: 13,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  genreModalAddConfirmBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  genreModalAddCancelBtn: {
    paddingVertical: 9,
    paddingHorizontal: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  genreModalAddCancelBtnText: {
    fontSize: 12,
  },
});
