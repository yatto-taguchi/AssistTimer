import React, { createContext, useState, useEffect, useRef } from 'react';
import { Animated, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ネイティブPurchasesモジュールの安全インポート
let Purchases = null;
try {
  Purchases = require('react-native-purchases').default;
} catch (e) {
  // ネイティブモジュール未ロード時のフォールバック
}

// Google Mobile Ads モジュールの安全インポート
let mobileAds = null;
try {
  mobileAds = require('react-native-google-mobile-ads').default;
} catch (e) {
  // ネイティブモジュール未ロード時のフォールバック
}

// RevenueCat APIキー設定
export const REVENUECAT_PUBLIC_APPLE_KEY = 'appl_jEzBjFMGADnabxXSYPQqMxFYKXJ';

// WatchConnectivityモジュールの安全インポート
let WatchConnectivity = null;
if (Platform.OS === 'ios') {
  try {
    const wc = require('watch-connectivity');
    WatchConnectivity = wc && wc.default ? wc.default : wc;
  } catch (e) {
    console.warn('[AppContext] WatchConnectivity failed to import:', e);
  }
}

// ★ アプリ全体からWatchへ最新客席データ＆スタッフメンバーをプッシュ送信するグローバルヘルパー
export const syncSeatsToWatchGlobal = async (customSeats = null, customUserName = null, customMembers = null) => {
  if (Platform.OS !== 'ios' || !WatchConnectivity) return;
  try {
    let seats = customSeats;
    let userName = customUserName;
    let members = customMembers;

    if (!seats) {
      const savedJson = await AsyncStorage.getItem('@salon_saved_seats');
      if (savedJson) {
        try {
          seats = JSON.parse(savedJson);
        } catch {}
      }
    }

    if (!userName) {
      userName = await AsyncStorage.getItem('@assist_timer_user_name');
    }

    if (!members) {
      const savedMembersJson = await AsyncStorage.getItem('@salon_staff_members');
      if (savedMembersJson) {
        try {
          members = JSON.parse(savedMembersJson);
        } catch {}
      }
    }

    const activeUser = (userName || 'スタイリスト').trim();
    const finalMembers = Array.isArray(members) ? members : [];
    const finalSeats = Array.isArray(seats) && seats.length > 0 ? seats : (seats === null ? [
      {
        id: 'seat-1',
        seatNumber: 1,
        seatLabel: '1番席 (サンプル)',
        status: 'running',
        colorStaffName: activeUser,
        targetSeconds: 1200,
        targetEndTimestamp: Date.now() + 19 * 60 * 1000 + 54 * 1000,
        checkTargetSeconds: 600,
        checkEndTimestamp: Date.now() + 9 * 60 * 1000 + 54 * 1000,
      }
    ] : []);

    const watchPayload = {
      type: 'SYNC_SEATS',
      userName: activeUser,
      members: finalMembers,
      timestamp: Date.now(),
      seats: finalSeats.map((s, index) => {
        let seatNum = s.seatNumber || (index + 1);
        if (s.seatLabel) {
          const match = s.seatLabel.match(/\d+/);
          if (match) seatNum = parseInt(match[0], 10);
        }

        const isRunning = s.status === 'running';
        const targetEnd = s.targetEndTimestamp || Date.now();
        const pausedRem = Math.max(0, Math.floor((targetEnd - Date.now()) / 1000));

        return {
          id: String(s.id),
          seatNumber: seatNum,
          seatLabel: s.seatLabel || `${seatNum}番席`,
          creatorName: s.colorStaffName || activeUser,
          totalSeconds: s.targetSeconds || 600,
          targetEndTimestamp: targetEnd,
          isRunning: isRunning,
          pausedRemainingSeconds: pausedRem,
          helpProcess: s.actionStatus === 'shampoo' || s.isShampooing ? 'シャンプー' : (s.actionStatus || 'シャンプー'),
          shampooStaff: s.assistantStaffName || '',
          isRecruiting: !s.assistantStaffName && isRunning,
          status: s.isShampooing || s.actionStatus === 'shampoo' ? 'shampoo' : (s.actionStatus || 'normal'),
          checkTargetSeconds: s.checkTargetSeconds || null,
          checkEndTimestamp: s.checkEndTimestamp || null,
          checkStaffName: s.checkStaffName || '',
          isCheckCompleted: s.checkStatus === 'completed',
          isCollapsed: false,
        };
      }),
    };

    await WatchConnectivity.syncData(watchPayload);
  } catch (e) {
    console.warn('[AppContext] syncSeatsToWatchGlobal failed:', e);
  }
};

import { NEWS_ITEMS } from '../data/newsData';

export const AppContext = createContext();

export const AppProvider = ({ children }) => {
  const [isEcoMode, setIsEcoMode] = useState(false);
  const [isEcoClockEnabled, setIsEcoClockEnabled] = useState(true);
  const [isEcoBatteryEnabled, setIsEcoBatteryEnabled] = useState(true);
  const [isEcoNavIconEnabled, setIsEcoNavIconEnabled] = useState(false); // trueでアイコン、falseで点
  const [isEcoNavActiveDot, setIsEcoNavActiveDot] = useState(false); // アイコン表示時、選択中のみ点にする
  const [isEcoBorderEnabled, setIsEcoBorderEnabled] = useState(false); // trueで境界線あり、falseでなし
  const [isEcoIndicatorEnabled, setIsEcoIndicatorEnabled] = useState(true); // エコモードでのタイマーリング表示
  const [isEcoTargetTimeEnabled, setIsEcoTargetTimeEnabled] = useState(true); // エコモードでの設定タイム表示
  const [isNormalStatusBarEnabled, setIsNormalStatusBarEnabled] = useState(true); // 通常モードでのステータスバー（時計・電池）表示
  const [isNormalStatusBarAutoHide, setIsNormalStatusBarAutoHide] = useState(true); // 通常モードでのタイマー作動中ステータスバー自動非表示
  const [isNormalIndicatorEnabled, setIsNormalIndicatorEnabled] = useState(true); // 通常モードでのタイマーリング表示
  const [isNormalTargetTimeEnabled, setIsNormalTargetTimeEnabled] = useState(true); // 通常モードでの設定タイム表示
  const [isHomeStatsEnabled, setIsHomeStatsEnabled] = useState(true); // ホーム画面での練習統計サマリー表示マスター
  const [isHomeStatsCollapsed, setIsHomeStatsCollapsed] = useState(false); // ホーム画面上での折りたたみ状態
  const [isQuickAccessBarEnabled, setIsQuickAccessBarEnabled] = useState(true); // ホーム画面でのクイック操作ボタン（5種）表示マスター
  const [isProMode, setIsProModeState] = useState(false); // 課金（Proプラン）状態
  const [isColorIndicator, setIsColorIndicator] = useState(true); // カラーインジケーター（10分以下タイマー用）
  const [isCountdownEnabled, setIsCountdownEnabled] = useState(false); // スタート前カウントダウン
  const [countdownSeconds, setCountdownSeconds] = useState(10); // カウントダウン秒数
  const [hasSeenEcoExplanation, setHasSeenEcoExplanation] = useState(false); // エコモード説明モーダル閲覧済みフラグ
  const [isCheerModeEnabled, setIsCheerModeEnabled] = useState(false); // 応援モード（キャラクター【やまいも】登場）マスター
  const [isCheerInEcoEnabled, setIsCheerInEcoEnabled] = useState(true); // エコモード中も応援モードを稼働（初期値: ON）
  const [isCheerSoundEnabled, setIsCheerSoundEnabled] = useState(true); // 応援モード登場サウンド（効果音・レアボイス）有効/無効

  // NEWS（お知らせ）関連State
  const [readNewsIds, setReadNewsIds] = useState([]);
  const [isNewsHiddenUntilNext, setIsNewsHiddenUntilNext] = useState(false);
  const [lastHiddenNewsId, setLastHiddenNewsId] = useState(null);

  const [alarmSoundType, setAlarmSoundType] = useState('digital'); // 'digital' | 'bell' | 'buzzer' | 'kitchen' | 'fast' | 'gong' | 'none'
  const [isAlarmSoundEnabled, setIsAlarmSoundEnabled] = useState(true); // アラーム音のマスター有効/無効
  const [isVoiceMasterEnabled, setIsVoiceMasterEnabled] = useState(true); // 音声アナウンス全体のマスター有効/無効
  const [isCountUpEnabled, setIsCountUpEnabled] = useState(true); // カウントアップ（超過時間計測）有効/無効
  const [playsInSilentMode, setPlaysInSilentMode] = useState(true); // マナーモード時でも鳴らす
  const [isVibrationEnabled, setIsVibrationEnabled] = useState(false); // バイブレーション（振動）全体有効/無効（初期値: OFF）
  const [isVibration3SecOnly, setIsVibration3SecOnly] = useState(true); // タイムアップ時3秒で自動停止
  const [vibrationIntensity, setVibrationIntensity] = useState('strong'); // 'strong' | 'normal' | 'gentle'
  const [isVibPrepEnabled, setIsVibPrepEnabled] = useState(true); // 事前準備時間
  const [isVibWarningEnabled, setIsVibWarningEnabled] = useState(true); // 計測中警告（1分/30秒/10秒）
  const [isVibFinishEnabled, setIsVibFinishEnabled] = useState(true); // 終了時（タイムアップ）
  const [isVibOvertimeEnabled, setIsVibOvertimeEnabled] = useState(true); // カウントアップ（超過時間）

  // 本番タイマー中の音声アナウンス個別有効/無効
  const [isVoice5MinEnabled, setIsVoice5MinEnabled] = useState(true);
  const [isVoice3MinEnabled, setIsVoice3MinEnabled] = useState(true);
  const [isVoice1MinEnabled, setIsVoice1MinEnabled] = useState(true);
  const [isVoice30SecEnabled, setIsVoice30SecEnabled] = useState(true);
  const [isVoice10SecEnabled, setIsVoice10SecEnabled] = useState(true);
  const [isVoiceFinishEnabled, setIsVoiceFinishEnabled] = useState(true);

  // スタート事前準備時間中の音声アナウンス個別有効/無効
  const [isPrepVoice15MinEnabled, setIsPrepVoice15MinEnabled] = useState(true);
  const [isPrepVoice10MinEnabled, setIsPrepVoice10MinEnabled] = useState(true);
  const [isPrepVoice5MinEnabled, setIsPrepVoice5MinEnabled] = useState(true);
  const [isPrepVoice4MinEnabled, setIsPrepVoice4MinEnabled] = useState(true);
  const [isPrepVoice3MinEnabled, setIsPrepVoice3MinEnabled] = useState(true);
  const [isPrepVoice2MinEnabled, setIsPrepVoice2MinEnabled] = useState(true);
  const [isPrepVoice1MinEnabled, setIsPrepVoice1MinEnabled] = useState(true);
  const [isPrepVoice30SecEnabled, setIsPrepVoice30SecEnabled] = useState(true);
  const [isPrepVoice10SecEnabled, setIsPrepVoice10SecEnabled] = useState(true);
  const [isPrepVoiceCountdownEnabled, setIsPrepVoiceCountdownEnabled] = useState(true);

  // カウントアップ（超過時間）中の音声アナウンス個別有効/無効
  const [isOverVoiceStartEnabled, setIsOverVoiceStartEnabled] = useState(true);
  const [isOverVoice1MinEnabled, setIsOverVoice1MinEnabled] = useState(true);
  const [isOverVoice3MinEnabled, setIsOverVoice3MinEnabled] = useState(true);
  const [isOverVoice5MinEnabled, setIsOverVoice5MinEnabled] = useState(true);
  const [isOverVoice10MinEnabled, setIsOverVoice10MinEnabled] = useState(true);
  const [isOverVoice15MinEnabled, setIsOverVoice15MinEnabled] = useState(true);

  // UI（操作ボタン・上部タブバー等）表示・フェード制御用
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const controlsTimeoutRef = useRef(null);

  const showControls = (autoHide = false) => {
    setControlsVisible(true);
    Animated.timing(controlsOpacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();

    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }

    if (autoHide) {
      controlsTimeoutRef.current = setTimeout(() => {
        Animated.timing(controlsOpacity, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }).start(() => setControlsVisible(false));
      }, 3000);
    }
  };

  const resetControlsVisible = () => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    setControlsVisible(true);
    Animated.timing(controlsOpacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  };

  // 初期ロード時にAsyncStorageから設定を読み込む
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const ecoVal = await AsyncStorage.getItem('isEcoMode');
        const ecoClockVal = await AsyncStorage.getItem('isEcoClockEnabled');
        const ecoBatteryVal = await AsyncStorage.getItem('isEcoBatteryEnabled');
        const ecoNavIconVal = await AsyncStorage.getItem('isEcoNavIconEnabled');
        const ecoNavActiveDotVal = await AsyncStorage.getItem('isEcoNavActiveDot');
        const ecoBorderVal = await AsyncStorage.getItem('isEcoBorderEnabled');
        const ecoIndicatorVal = await AsyncStorage.getItem('isEcoIndicatorEnabled');
        const normalStatusBarVal = await AsyncStorage.getItem('isNormalStatusBarEnabled');
        const normalStatusBarAutoHideVal = await AsyncStorage.getItem('isNormalStatusBarAutoHide');
        const normalIndicatorVal = await AsyncStorage.getItem('isNormalIndicatorEnabled');
        const normalTargetTimeVal = await AsyncStorage.getItem('isNormalTargetTimeEnabled');
        const ecoTargetTimeVal = await AsyncStorage.getItem('isEcoTargetTimeEnabled');
        const homeStatsEnabledVal = await AsyncStorage.getItem('isHomeStatsEnabled');
        const homeStatsCollapsedVal = await AsyncStorage.getItem('isHomeStatsCollapsed');
        const quickAccessBarVal = await AsyncStorage.getItem('isQuickAccessBarEnabled');
        const proVal = await AsyncStorage.getItem('isProMode');
        const colorVal = await AsyncStorage.getItem('isColorIndicator');
        const countdownEnabledVal = await AsyncStorage.getItem('isCountdownEnabled');
        const countdownSecVal = await AsyncStorage.getItem('countdownSeconds');
        const seenEcoVal = await AsyncStorage.getItem('hasSeenEcoExplanation');
        const cheerModeVal = await AsyncStorage.getItem('isCheerModeEnabled');
        const cheerInEcoVal = await AsyncStorage.getItem('isCheerInEcoEnabled');
        const cheerSoundVal = await AsyncStorage.getItem('isCheerSoundEnabled');
        const soundTypeVal = await AsyncStorage.getItem('alarmSoundType');
        const alarmSoundEnabledVal = await AsyncStorage.getItem('isAlarmSoundEnabled');
        const voiceMasterVal = await AsyncStorage.getItem('isVoiceMasterEnabled');
        const countUpVal = await AsyncStorage.getItem('isCountUpEnabled');
        const silentModeVal = await AsyncStorage.getItem('playsInSilentMode');
        const vibrationVal = await AsyncStorage.getItem('isVibrationEnabled');
        const vibration3SecVal = await AsyncStorage.getItem('isVibration3SecOnly');
        const vibIntensityVal = await AsyncStorage.getItem('vibrationIntensity');
        const vibPrepVal = await AsyncStorage.getItem('isVibPrepEnabled');
        const vibWarningVal = await AsyncStorage.getItem('isVibWarningEnabled');
        const vibFinishVal = await AsyncStorage.getItem('isVibFinishEnabled');
        const vibOvertimeVal = await AsyncStorage.getItem('isVibOvertimeEnabled');
        
        const voice5MinVal = await AsyncStorage.getItem('isVoice5MinEnabled');
        const voice3MinVal = await AsyncStorage.getItem('isVoice3MinEnabled');
        const voice1MinVal = await AsyncStorage.getItem('isVoice1MinEnabled');
        const voice30SecVal = await AsyncStorage.getItem('isVoice30SecEnabled');
        const voice10SecVal = await AsyncStorage.getItem('isVoice10SecEnabled');
        const voiceFinishVal = await AsyncStorage.getItem('isVoiceFinishEnabled');

        const prep15MinVal = await AsyncStorage.getItem('isPrepVoice15MinEnabled');
        const prep10MinVal = await AsyncStorage.getItem('isPrepVoice10MinEnabled');
        const prep5MinVal = await AsyncStorage.getItem('isPrepVoice5MinEnabled');
        const prep4MinVal = await AsyncStorage.getItem('isPrepVoice4MinEnabled');
        const prep3MinVal = await AsyncStorage.getItem('isPrepVoice3MinEnabled');
        const prep2MinVal = await AsyncStorage.getItem('isPrepVoice2MinEnabled');
        const prep1MinVal = await AsyncStorage.getItem('isPrepVoice1MinEnabled');
        const prep30SecVal = await AsyncStorage.getItem('isPrepVoice30SecEnabled');
        const prep10SecVal = await AsyncStorage.getItem('isPrepVoice10SecEnabled');
        const prepCdVal = await AsyncStorage.getItem('isPrepVoiceCountdownEnabled');

        const overStartVal = await AsyncStorage.getItem('isOverVoiceStartEnabled');
        const over1MinVal = await AsyncStorage.getItem('isOverVoice1MinEnabled');
        const over3MinVal = await AsyncStorage.getItem('isOverVoice3MinEnabled');
        const over5MinVal = await AsyncStorage.getItem('isOverVoice5MinEnabled');
        const over10MinVal = await AsyncStorage.getItem('isOverVoice10MinEnabled');
        const over15MinVal = await AsyncStorage.getItem('isOverVoice15MinEnabled');
        
        if (ecoVal !== null) setIsEcoMode(JSON.parse(ecoVal));
        if (ecoClockVal !== null) setIsEcoClockEnabled(JSON.parse(ecoClockVal));
        if (ecoBatteryVal !== null) setIsEcoBatteryEnabled(JSON.parse(ecoBatteryVal));
        if (ecoNavIconVal !== null) setIsEcoNavIconEnabled(JSON.parse(ecoNavIconVal));
        if (ecoNavActiveDotVal !== null) setIsEcoNavActiveDot(JSON.parse(ecoNavActiveDotVal));
        if (ecoBorderVal !== null) setIsEcoBorderEnabled(JSON.parse(ecoBorderVal));
        if (ecoIndicatorVal !== null) setIsEcoIndicatorEnabled(JSON.parse(ecoIndicatorVal));
        if (normalStatusBarVal !== null) setIsNormalStatusBarEnabled(JSON.parse(normalStatusBarVal));
        if (normalStatusBarAutoHideVal !== null) setIsNormalStatusBarAutoHide(JSON.parse(normalStatusBarAutoHideVal));
        if (normalIndicatorVal !== null) setIsNormalIndicatorEnabled(JSON.parse(normalIndicatorVal));
        if (normalTargetTimeVal !== null) setIsNormalTargetTimeEnabled(JSON.parse(normalTargetTimeVal));
        if (ecoTargetTimeVal !== null) setIsEcoTargetTimeEnabled(JSON.parse(ecoTargetTimeVal));
        if (homeStatsEnabledVal !== null) setIsHomeStatsEnabled(JSON.parse(homeStatsEnabledVal));
        if (homeStatsCollapsedVal !== null) setIsHomeStatsCollapsed(JSON.parse(homeStatsCollapsedVal));
        if (quickAccessBarVal !== null) setIsQuickAccessBarEnabled(JSON.parse(quickAccessBarVal));
        if (proVal !== null) setIsProModeState(JSON.parse(proVal));
        if (colorVal !== null) setIsColorIndicator(JSON.parse(colorVal));
        if (countdownEnabledVal !== null) setIsCountdownEnabled(JSON.parse(countdownEnabledVal));
        if (countdownSecVal !== null) setCountdownSeconds(parseInt(countdownSecVal, 10));
        if (seenEcoVal !== null) setHasSeenEcoExplanation(JSON.parse(seenEcoVal));
        const cheerMode = cheerModeVal !== null ? JSON.parse(cheerModeVal) : false;
        let cheerInEco = cheerInEcoVal !== null ? JSON.parse(cheerInEcoVal) : true;
        const cheerSound = cheerSoundVal !== null ? JSON.parse(cheerSoundVal) : true;

        // 応援モードONユーザーのエコモード自動連動マイグレーション（v1.0.4: 過去のfalseキャッシュによる遮断救済）
        const cheerEcoMigrated = await AsyncStorage.getItem('@is_cheer_in_eco_migrated_v1_0_4');
        if (cheerEcoMigrated === null) {
          if (cheerMode && !cheerInEco) {
            cheerInEco = true;
            await AsyncStorage.setItem('isCheerInEcoEnabled', JSON.stringify(true));
          }
          await AsyncStorage.setItem('@is_cheer_in_eco_migrated_v1_0_4', 'true');
        }

        setIsCheerModeEnabled(cheerMode);
        setIsCheerInEcoEnabled(cheerInEco);
        setIsCheerSoundEnabled(cheerSound);
        if (soundTypeVal !== null) setAlarmSoundType(soundTypeVal);
        if (alarmSoundEnabledVal !== null) setIsAlarmSoundEnabled(JSON.parse(alarmSoundEnabledVal));
        if (voiceMasterVal !== null) setIsVoiceMasterEnabled(JSON.parse(voiceMasterVal));
        if (countUpVal !== null) setIsCountUpEnabled(JSON.parse(countUpVal));
        if (silentModeVal !== null) setPlaysInSilentMode(JSON.parse(silentModeVal));
        // バイブレーション初期値のマイグレーション（v1.0.3: 既存端末含め初回初期値を確実にOFFにセット）
        const vibInitKey = await AsyncStorage.getItem('@is_vibration_initialized_v1_0_3');
        if (vibInitKey === null) {
          setIsVibrationEnabled(false);
          await AsyncStorage.setItem('isVibrationEnabled', JSON.stringify(false));
          await AsyncStorage.setItem('@is_vibration_initialized_v1_0_3', 'true');
        } else if (vibrationVal !== null) {
          setIsVibrationEnabled(JSON.parse(vibrationVal));
        }
        if (vibration3SecVal !== null) setIsVibration3SecOnly(JSON.parse(vibration3SecVal));
        if (vibIntensityVal !== null) setVibrationIntensity(vibIntensityVal);
        if (vibPrepVal !== null) setIsVibPrepEnabled(JSON.parse(vibPrepVal));
        if (vibWarningVal !== null) setIsVibWarningEnabled(JSON.parse(vibWarningVal));
        if (vibFinishVal !== null) setIsVibFinishEnabled(JSON.parse(vibFinishVal));
        if (vibOvertimeVal !== null) setIsVibOvertimeEnabled(JSON.parse(vibOvertimeVal));

        if (voice5MinVal !== null) setIsVoice5MinEnabled(JSON.parse(voice5MinVal));
        if (voice3MinVal !== null) setIsVoice3MinEnabled(JSON.parse(voice3MinVal));
        if (voice1MinVal !== null) setIsVoice1MinEnabled(JSON.parse(voice1MinVal));
        if (voice30SecVal !== null) setIsVoice30SecEnabled(JSON.parse(voice30SecVal));
        if (voice10SecVal !== null) setIsVoice10SecEnabled(JSON.parse(voice10SecVal));
        if (voiceFinishVal !== null) setIsVoiceFinishEnabled(JSON.parse(voiceFinishVal));

        if (prep15MinVal !== null) setIsPrepVoice15MinEnabled(JSON.parse(prep15MinVal));
        if (prep10MinVal !== null) setIsPrepVoice10MinEnabled(JSON.parse(prep10MinVal));
        if (prep5MinVal !== null) setIsPrepVoice5MinEnabled(JSON.parse(prep5MinVal));
        if (prep4MinVal !== null) setIsPrepVoice4MinEnabled(JSON.parse(prep4MinVal));
        if (prep3MinVal !== null) setIsPrepVoice3MinEnabled(JSON.parse(prep3MinVal));
        if (prep2MinVal !== null) setIsPrepVoice2MinEnabled(JSON.parse(prep2MinVal));
        if (prep1MinVal !== null) setIsPrepVoice1MinEnabled(JSON.parse(prep1MinVal));
        if (prep30SecVal !== null) setIsPrepVoice30SecEnabled(JSON.parse(prep30SecVal));
        if (prep10SecVal !== null) setIsPrepVoice10SecEnabled(JSON.parse(prep10SecVal));
        if (prepCdVal !== null) setIsPrepVoiceCountdownEnabled(JSON.parse(prepCdVal));

        if (overStartVal !== null) setIsOverVoiceStartEnabled(JSON.parse(overStartVal));
        if (over1MinVal !== null) setIsOverVoice1MinEnabled(JSON.parse(over1MinVal));
        if (over3MinVal !== null) setIsOverVoice3MinEnabled(JSON.parse(over3MinVal));
        if (over5MinVal !== null) setIsOverVoice5MinEnabled(JSON.parse(over5MinVal));
        if (over10MinVal !== null) setIsOverVoice10MinEnabled(JSON.parse(over10MinVal));
        if (over15MinVal !== null) setIsOverVoice15MinEnabled(JSON.parse(over15MinVal));

        // NEWS関連のロード＆自動復活チェック
        const readNewsIdsVal = await AsyncStorage.getItem('@assist_timer_read_news_ids');
        const newsHiddenVal = await AsyncStorage.getItem('@assist_timer_news_hidden_until_next');
        const lastHiddenIdVal = await AsyncStorage.getItem('@assist_timer_last_hidden_news_id');

        if (readNewsIdsVal !== null) {
          try {
            setReadNewsIds(JSON.parse(readNewsIdsVal));
          } catch (e) {}
        }

        const latestNewsId = NEWS_ITEMS.length > 0 ? NEWS_ITEMS[0].id : null;
        if (newsHiddenVal !== null && JSON.parse(newsHiddenVal) === true) {
          // 隠した時点の最新IDと現在の最新IDが異なる場合（新着がある場合）は自動復活
          if (lastHiddenIdVal && latestNewsId && lastHiddenIdVal !== latestNewsId) {
            setIsNewsHiddenUntilNext(false);
            await AsyncStorage.setItem('@assist_timer_news_hidden_until_next', JSON.stringify(false));
          } else {
            setIsNewsHiddenUntilNext(true);
            setLastHiddenNewsId(lastHiddenIdVal);
          }
        }
      } catch (e) {
        console.error("Failed to load settings.", e);
      }
    };
    loadSettings();
  }, []);

  // ★ Apple Watch グローバル初期化＆アプリ最上位常時同期リスナー
  useEffect(() => {
    if (Platform.OS !== 'ios' || !WatchConnectivity) return;

    let subMsg = null;
    let subCtx = null;
    let subUser = null;

    const initGlobalWatch = async () => {
      try {
        await WatchConnectivity.activate();
        // アプリ起動直後に即座にAsyncStorageの最新客席データをWatchへプッシュ！
        await syncSeatsToWatchGlobal();
      } catch (e) {
        console.warn('[AppContext] initGlobalWatch failed:', e);
      }
    };

    initGlobalWatch();

    const handleGlobalWatchAction = async (data) => {
      if (!data || !data.action) return;
      const { action, seatId, userName: watchUser, extra } = data;

      // ① 同期要求 (Watch起動時/画面表示時に最新データを求められた時)
      if (action === 'REQUEST_SYNC') {
        await syncSeatsToWatchGlobal();
        return;
      }

      // ② Watch側での新規席追加
      if (action === 'ADD_SEAT') {
        try {
          const seatNum = extra?.seatNumber || 1;
          const totalSec = extra?.totalSeconds || 900;
          const checkSec = extra?.checkTotalSeconds || null;
          const targetEnd = Date.now() + totalSec * 1000;
          const checkEnd = checkSec ? Date.now() + checkSec * 1000 : null;

          const savedJson = await AsyncStorage.getItem('@salon_saved_seats');
          let currentSeats = [];
          if (savedJson) {
            try { currentSeats = JSON.parse(savedJson) || []; } catch {}
          }
          if (currentSeats.length === 0) {
            currentSeats = [
              {
                id: 'seat-1',
                seatNumber: 1,
                seatLabel: '1番席 (サンプル)',
                status: 'running',
                colorStaffName: watchUser || 'スタイリスト',
                targetSeconds: 1200,
                targetEndTimestamp: Date.now() + 19 * 60 * 1000 + 54 * 1000,
                checkTargetSeconds: 600,
                checkEndTimestamp: Date.now() + 9 * 60 * 1000 + 54 * 1000,
              }
            ];
          }

          const newSeatObj = {
            id: seatId || String(Date.now()),
            seatNumber: seatNum,
            seatLabel: `${seatNum}番席`,
            status: 'running',
            colorStaffName: watchUser || 'スタイリスト',
            targetSeconds: totalSec,
            targetEndTimestamp: targetEnd,
            checkTargetSeconds: checkSec,
            checkEndTimestamp: checkEnd,
            checkStaffName: '',
            checkStatus: checkSec ? 'running' : 'stopped',
            actionStatus: null,
            isShampooing: false,
            assistantStaffName: '',
            history: [
              {
                id: String(Date.now()),
                type: 'start',
                text: `Apple Watchからタイマー開始 (${Math.round(totalSec / 60)}分)`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                staff: watchUser || 'スタイリスト',
              }
            ],
          };

          if (!currentSeats.some(s => s.id === newSeatObj.id)) {
            const updated = [...currentSeats, newSeatObj];
            await AsyncStorage.setItem('@salon_saved_seats', JSON.stringify(updated));
            await syncSeatsToWatchGlobal(updated, watchUser);
          }
        } catch (e) {
          console.warn('[AppContext] ADD_SEAT failed:', e);
        }
        return;
      }

      // その他の操作（シャンプー開始、タイマー操作等）もAsyncStorageの座席に反映して同期
      try {
        const savedJson = await AsyncStorage.getItem('@salon_saved_seats');
        if (!savedJson) return;
        const currentSeats = JSON.parse(savedJson);
        if (!Array.isArray(currentSeats)) return;

        let hasChanged = false;
        const updated = currentSeats.map(s => {
          if (s.id !== seatId) return s;
          hasChanged = true;
          switch (action) {
            case 'START_SHAMPOO':
              return { ...s, isShampooing: true, actionStatus: 'shampoo', assistantStaffName: watchUser || s.assistantStaffName };
            case 'FINISH_SHAMPOO':
              return { ...s, isShampooing: false, actionStatus: null };
            case 'ENTER_HELP':
              return { ...s, status: 'paused', assistantStaffName: watchUser || 'ヘルプ', isShampooing: true, actionStatus: 'shampoo' };
            case 'STOP_TIMER':
              return { ...s, status: 'paused' };
            case 'START_TIMER': {
              const targetSec = extra?.targetSeconds || 600;
              return { ...s, status: 'running', targetSeconds: targetSec, targetEndTimestamp: Date.now() + targetSec * 1000 };
            }
            case 'RESET_ZERO':
              return { ...s, status: 'stopped', targetSeconds: 0, targetEndTimestamp: Date.now(), isShampooing: false, actionStatus: null, assistantStaffName: '' };
            case 'CLAIM_CHECK':
              return { ...s, checkStaffName: watchUser || 'チェック担当' };
            case 'COMPLETE_CHECK':
              return { ...s, checkStatus: 'completed', checkStaffName: watchUser || s.checkStaffName };
            default:
              return s;
          }
        });

        if (hasChanged) {
          await AsyncStorage.setItem('@salon_saved_seats', JSON.stringify(updated));
          await syncSeatsToWatchGlobal(updated, watchUser);
        }
      } catch (e) {
        console.warn('[AppContext] handleGlobalWatchAction update seats failed:', e);
      }
    };

    subMsg = WatchConnectivity.addMessageListener(handleGlobalWatchAction);
    subCtx = WatchConnectivity.addApplicationContextListener((ctx) => {
      if (ctx && ctx.action) handleGlobalWatchAction(ctx);
    });
    if (WatchConnectivity.addUserInfoListener) {
      subUser = WatchConnectivity.addUserInfoListener((ui) => {
        if (ui && ui.action) handleGlobalWatchAction(ui);
      });
    }

    return () => {
      if (subMsg?.remove) subMsg.remove();
      if (subCtx?.remove) subCtx.remove();
      if (subUser?.remove) subUser.remove();
    };
  }, []);

  // RevenueCat の初期化とサブスクリプション状態の自動同期
  useEffect(() => {
    const initPurchases = async () => {
      if (Purchases && REVENUECAT_PUBLIC_APPLE_KEY && REVENUECAT_PUBLIC_APPLE_KEY !== 'appl_placeholder_key') {
        try {
          Purchases.configure({ apiKey: REVENUECAT_PUBLIC_APPLE_KEY });
          const customerInfo = await Purchases.getCustomerInfo();
          const isPro = typeof customerInfo.entitlements.active['pro'] !== 'undefined' ||
                        typeof customerInfo.entitlements.active['premium'] !== 'undefined';
          if (isPro) {
            setIsProModeState(true);
            await AsyncStorage.setItem('isProMode', JSON.stringify(true));
          }
        } catch (e) {
          console.log('RevenueCat init error:', e);
        }
      }
    };
    initPurchases();
  }, []);

  // Google Mobile Ads (AdMob) のSDK初期化
  useEffect(() => {
    const initAdMob = async () => {
      if (mobileAds) {
        try {
          await mobileAds().initialize();
          console.log('Google Mobile Ads initialized successfully');
        } catch (e) {
          console.log('Google Mobile Ads init error:', e);
        }
      }
    };
    initAdMob();
  }, []);

  // エコモード切替と保存
  const toggleEcoMode = async (value) => {
    setIsEcoMode(value);
    await AsyncStorage.setItem('isEcoMode', JSON.stringify(value));
  };

  // エコモード(時計)切替と保存
  const toggleEcoClock = async (value) => {
    setIsEcoClockEnabled(value);
    await AsyncStorage.setItem('isEcoClockEnabled', JSON.stringify(value));
  };

  // エコモード(バッテリー)切替と保存
  const toggleEcoBattery = async (value) => {
    setIsEcoBatteryEnabled(value);
    await AsyncStorage.setItem('isEcoBatteryEnabled', JSON.stringify(value));
  };

  // エコモード(ナビアイコン表示)切替と保存
  const toggleEcoNavIcon = async (value) => {
    setIsEcoNavIconEnabled(value);
    await AsyncStorage.setItem('isEcoNavIconEnabled', JSON.stringify(value));
  };

  // エコモード(選択中タブのみ点表示)切替と保存
  const toggleEcoNavActiveDot = async (value) => {
    setIsEcoNavActiveDot(value);
    await AsyncStorage.setItem('isEcoNavActiveDot', JSON.stringify(value));
  };

  // エコモード(境界線表示)切替と保存
  const toggleEcoBorder = async (value) => {
    setIsEcoBorderEnabled(value);
    await AsyncStorage.setItem('isEcoBorderEnabled', JSON.stringify(value));
  };

  const toggleEcoIndicator = async (value) => {
    setIsEcoIndicatorEnabled(value);
    await AsyncStorage.setItem('isEcoIndicatorEnabled', JSON.stringify(value));
  };

  const toggleNormalStatusBar = async (value) => {
    setIsNormalStatusBarEnabled(value);
    await AsyncStorage.setItem('isNormalStatusBarEnabled', JSON.stringify(value));
  };

  const toggleNormalStatusBarAutoHide = async (value) => {
    setIsNormalStatusBarAutoHide(value);
    await AsyncStorage.setItem('isNormalStatusBarAutoHide', JSON.stringify(value));
  };

  const toggleNormalIndicator = async (value) => {
    setIsNormalIndicatorEnabled(value);
    await AsyncStorage.setItem('isNormalIndicatorEnabled', JSON.stringify(value));
  };

  const toggleNormalTargetTime = async (value) => {
    setIsNormalTargetTimeEnabled(value);
    await AsyncStorage.setItem('isNormalTargetTimeEnabled', JSON.stringify(value));
  };

  const toggleEcoTargetTime = async (value) => {
    setIsEcoTargetTimeEnabled(value);
    await AsyncStorage.setItem('isEcoTargetTimeEnabled', JSON.stringify(value));
  };

  const toggleHomeStatsEnabled = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isHomeStatsEnabled;
    setIsHomeStatsEnabled(nextVal);
    await AsyncStorage.setItem('isHomeStatsEnabled', JSON.stringify(nextVal));
  };

  const toggleHomeStatsCollapsed = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isHomeStatsCollapsed;
    setIsHomeStatsCollapsed(nextVal);
    await AsyncStorage.setItem('isHomeStatsCollapsed', JSON.stringify(nextVal));
  };

  const toggleQuickAccessBar = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isQuickAccessBarEnabled;
    setIsQuickAccessBarEnabled(nextVal);
    await AsyncStorage.setItem('isQuickAccessBarEnabled', JSON.stringify(nextVal));
  };

  const toggleCheerMode = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isCheerModeEnabled;
    setIsCheerModeEnabled(nextVal);
    await AsyncStorage.setItem('isCheerModeEnabled', JSON.stringify(nextVal));
    if (nextVal) {
      // 応援モードON時は、エコモード中登場も確実にONにして黒画面でも確定演出・見守りを体験可能にする
      setIsCheerInEcoEnabled(true);
      await AsyncStorage.setItem('isCheerInEcoEnabled', JSON.stringify(true));
    }
  };

  const toggleCheerInEco = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isCheerInEcoEnabled;
    setIsCheerInEcoEnabled(nextVal);
    await AsyncStorage.setItem('isCheerInEcoEnabled', JSON.stringify(nextVal));
  };

  const toggleCheerSound = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isCheerSoundEnabled;
    setIsCheerSoundEnabled(nextVal);
    await AsyncStorage.setItem('isCheerSoundEnabled', JSON.stringify(nextVal));
  };

  // NEWS（お知らせ）操作ハンドラー
  const markNewsAsRead = async (newsId) => {
    try {
      const nextReadIds = Array.from(new Set([...readNewsIds, newsId]));
      setReadNewsIds(nextReadIds);
      await AsyncStorage.setItem('@assist_timer_read_news_ids', JSON.stringify(nextReadIds));
    } catch (e) {
      console.warn('Failed to mark news as read', e);
    }
  };

  const markAllNewsAsRead = async () => {
    try {
      const allIds = NEWS_ITEMS.map(item => item.id);
      const nextReadIds = Array.from(new Set([...readNewsIds, ...allIds]));
      setReadNewsIds(nextReadIds);
      await AsyncStorage.setItem('@assist_timer_read_news_ids', JSON.stringify(nextReadIds));
    } catch (e) {
      console.warn('Failed to mark all news as read', e);
    }
  };

  const hideNewsUntilNextUpdate = async () => {
    try {
      const allIds = NEWS_ITEMS.map(item => item.id);
      const nextReadIds = Array.from(new Set([...readNewsIds, ...allIds]));
      setReadNewsIds(nextReadIds);

      const latestNewsId = NEWS_ITEMS.length > 0 ? NEWS_ITEMS[0].id : null;
      setIsNewsHiddenUntilNext(true);
      setLastHiddenNewsId(latestNewsId);

      const storageTasks = [
        AsyncStorage.setItem('@assist_timer_read_news_ids', JSON.stringify(nextReadIds)),
        AsyncStorage.setItem('@assist_timer_news_hidden_until_next', JSON.stringify(true)),
      ];
      if (latestNewsId) {
        storageTasks.push(AsyncStorage.setItem('@assist_timer_last_hidden_news_id', latestNewsId));
      }
      await Promise.all(storageTasks);
    } catch (e) {
      console.warn('Failed to hide news until next update', e);
    }
  };

  const restoreNewsIcon = async () => {
    try {
      setIsNewsHiddenUntilNext(false);
      await AsyncStorage.setItem('@assist_timer_news_hidden_until_next', JSON.stringify(false));
    } catch (e) {
      console.warn('Failed to restore news icon', e);
    }
  };


  // Proモード明示的セット
  const setIsProMode = async (value) => {
    setIsProModeState(value);
    await AsyncStorage.setItem('isProMode', JSON.stringify(value));
  };

  // Proモード切替と保存
  const toggleProMode = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isProMode;
    await setIsProMode(nextVal);
  };

  // カラーインジケーター切替と保存
  const toggleColorIndicator = async (value) => {
    setIsColorIndicator(value);
    await AsyncStorage.setItem('isColorIndicator', JSON.stringify(value));
  };

  // カウントダウン機能切替と保存
  const toggleCountdownEnabled = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isCountdownEnabled;
    setIsCountdownEnabled(nextVal);
    await AsyncStorage.setItem('isCountdownEnabled', JSON.stringify(nextVal));
  };

  // カウントダウン秒数保存
  const saveCountdownSeconds = async (value) => {
    setCountdownSeconds(value);
    await AsyncStorage.setItem('countdownSeconds', value.toString());
  };

  // アラーム音種類変更と保存
  const toggleAlarmSoundType = async (type) => {
    setAlarmSoundType(type);
    await AsyncStorage.setItem('alarmSoundType', type);
  };

  // アラーム音全体の有効/無効切替と保存
  const toggleAlarmSoundEnabled = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isAlarmSoundEnabled;
    setIsAlarmSoundEnabled(nextVal);
    await AsyncStorage.setItem('isAlarmSoundEnabled', JSON.stringify(nextVal));
  };

  // 音声アナウンス全体の有効/無効切替と保存
  const toggleVoiceMasterEnabled = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVoiceMasterEnabled;
    setIsVoiceMasterEnabled(nextVal);
    await AsyncStorage.setItem('isVoiceMasterEnabled', JSON.stringify(nextVal));
  };

  // カウントアップ（超過時間計測）の有効/無効切替と保存
  const toggleCountUpEnabled = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isCountUpEnabled;
    setIsCountUpEnabled(nextVal);
    await AsyncStorage.setItem('isCountUpEnabled', JSON.stringify(nextVal));
  };

  // マナーモード時再生切替と保存
  const togglePlaysInSilentMode = async (value) => {
    setPlaysInSilentMode(value);
    await AsyncStorage.setItem('playsInSilentMode', JSON.stringify(value));
  };

  // バイブレーション（振動）切替と保存
  const toggleVibrationEnabled = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVibrationEnabled;
    setIsVibrationEnabled(nextVal);
    await AsyncStorage.setItem('isVibrationEnabled', JSON.stringify(nextVal));
  };

  // タイムアップ時3秒自動停止切替と保存
  const toggleVibration3SecOnly = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVibration3SecOnly;
    setIsVibration3SecOnly(nextVal);
    await AsyncStorage.setItem('isVibration3SecOnly', JSON.stringify(nextVal));
  };

  // 振動の強さ切替と保存
  const saveVibrationIntensity = async (value) => {
    setVibrationIntensity(value);
    await AsyncStorage.setItem('vibrationIntensity', value);
  };

  // タイミング別バイブレーショントグルと保存
  const toggleVibPrep = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVibPrepEnabled;
    setIsVibPrepEnabled(nextVal);
    await AsyncStorage.setItem('isVibPrepEnabled', JSON.stringify(nextVal));
  };

  const toggleVibWarning = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVibWarningEnabled;
    setIsVibWarningEnabled(nextVal);
    await AsyncStorage.setItem('isVibWarningEnabled', JSON.stringify(nextVal));
  };

  const toggleVibFinish = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVibFinishEnabled;
    setIsVibFinishEnabled(nextVal);
    await AsyncStorage.setItem('isVibFinishEnabled', JSON.stringify(nextVal));
  };

  const toggleVibOvertime = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVibOvertimeEnabled;
    setIsVibOvertimeEnabled(nextVal);
    await AsyncStorage.setItem('isVibOvertimeEnabled', JSON.stringify(nextVal));
  };

  // 本番タイマー用 音声アナウンス各トグルと保存
  const toggleVoice5Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVoice5MinEnabled;
    setIsVoice5MinEnabled(nextVal);
    await AsyncStorage.setItem('isVoice5MinEnabled', JSON.stringify(nextVal));
  };

  const toggleVoice3Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVoice3MinEnabled;
    setIsVoice3MinEnabled(nextVal);
    await AsyncStorage.setItem('isVoice3MinEnabled', JSON.stringify(nextVal));
  };

  const toggleVoice1Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVoice1MinEnabled;
    setIsVoice1MinEnabled(nextVal);
    await AsyncStorage.setItem('isVoice1MinEnabled', JSON.stringify(nextVal));
  };

  const toggleVoice30Sec = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVoice30SecEnabled;
    setIsVoice30SecEnabled(nextVal);
    await AsyncStorage.setItem('isVoice30SecEnabled', JSON.stringify(nextVal));
  };

  const toggleVoice10Sec = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVoice10SecEnabled;
    setIsVoice10SecEnabled(nextVal);
    await AsyncStorage.setItem('isVoice10SecEnabled', JSON.stringify(nextVal));
  };

  const toggleVoiceFinish = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isVoiceFinishEnabled;
    setIsVoiceFinishEnabled(nextVal);
    await AsyncStorage.setItem('isVoiceFinishEnabled', JSON.stringify(nextVal));
  };

  // スタート事前準備時間用 音声アナウンス各トグルと保存
  const togglePrepVoice15Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isPrepVoice15MinEnabled;
    setIsPrepVoice15MinEnabled(nextVal);
    await AsyncStorage.setItem('isPrepVoice15MinEnabled', JSON.stringify(nextVal));
  };

  const togglePrepVoice10Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isPrepVoice10MinEnabled;
    setIsPrepVoice10MinEnabled(nextVal);
    await AsyncStorage.setItem('isPrepVoice10MinEnabled', JSON.stringify(nextVal));
  };

  const togglePrepVoice5Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isPrepVoice5MinEnabled;
    setIsPrepVoice5MinEnabled(nextVal);
    await AsyncStorage.setItem('isPrepVoice5MinEnabled', JSON.stringify(nextVal));
  };

  const togglePrepVoice4Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isPrepVoice4MinEnabled;
    setIsPrepVoice4MinEnabled(nextVal);
    await AsyncStorage.setItem('isPrepVoice4MinEnabled', JSON.stringify(nextVal));
  };

  const togglePrepVoice3Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isPrepVoice3MinEnabled;
    setIsPrepVoice3MinEnabled(nextVal);
    await AsyncStorage.setItem('isPrepVoice3MinEnabled', JSON.stringify(nextVal));
  };

  const togglePrepVoice2Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isPrepVoice2MinEnabled;
    setIsPrepVoice2MinEnabled(nextVal);
    await AsyncStorage.setItem('isPrepVoice2MinEnabled', JSON.stringify(nextVal));
  };

  const togglePrepVoice1Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isPrepVoice1MinEnabled;
    setIsPrepVoice1MinEnabled(nextVal);
    await AsyncStorage.setItem('isPrepVoice1MinEnabled', JSON.stringify(nextVal));
  };

  const togglePrepVoice30Sec = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isPrepVoice30SecEnabled;
    setIsPrepVoice30SecEnabled(nextVal);
    await AsyncStorage.setItem('isPrepVoice30SecEnabled', JSON.stringify(nextVal));
  };

  const togglePrepVoice10Sec = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isPrepVoice10SecEnabled;
    setIsPrepVoice10SecEnabled(nextVal);
    await AsyncStorage.setItem('isPrepVoice10SecEnabled', JSON.stringify(nextVal));
  };

  const togglePrepVoiceCountdown = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isPrepVoiceCountdownEnabled;
    setIsPrepVoiceCountdownEnabled(nextVal);
    await AsyncStorage.setItem('isPrepVoiceCountdownEnabled', JSON.stringify(nextVal));
  };

  // カウントアップ（超過時間）用 音声アナウンス各トグルと保存
  const toggleOverVoiceStart = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isOverVoiceStartEnabled;
    setIsOverVoiceStartEnabled(nextVal);
    await AsyncStorage.setItem('isOverVoiceStartEnabled', JSON.stringify(nextVal));
  };

  const toggleOverVoice1Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isOverVoice1MinEnabled;
    setIsOverVoice1MinEnabled(nextVal);
    await AsyncStorage.setItem('isOverVoice1MinEnabled', JSON.stringify(nextVal));
  };

  const toggleOverVoice3Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isOverVoice3MinEnabled;
    setIsOverVoice3MinEnabled(nextVal);
    await AsyncStorage.setItem('isOverVoice3MinEnabled', JSON.stringify(nextVal));
  };

  const toggleOverVoice5Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isOverVoice5MinEnabled;
    setIsOverVoice5MinEnabled(nextVal);
    await AsyncStorage.setItem('isOverVoice5MinEnabled', JSON.stringify(nextVal));
  };

  const toggleOverVoice10Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isOverVoice10MinEnabled;
    setIsOverVoice10MinEnabled(nextVal);
    await AsyncStorage.setItem('isOverVoice10MinEnabled', JSON.stringify(nextVal));
  };

  const toggleOverVoice15Min = async (value) => {
    const nextVal = typeof value === 'boolean' ? value : !isOverVoice15MinEnabled;
    setIsOverVoice15MinEnabled(nextVal);
    await AsyncStorage.setItem('isOverVoice15MinEnabled', JSON.stringify(nextVal));
  };

  // エコモード説明モーダル閲覧済みフラグ保存
  const markEcoExplanationSeen = async () => {
    setHasSeenEcoExplanation(true);
    await AsyncStorage.setItem('hasSeenEcoExplanation', JSON.stringify(true));
  };

  // メインタイマー（HomeScreen）連動共有State
  const [mainTimerState, setMainTimerState] = useState({
    remainingTime: 180,
    targetTime: 180,
    isRunning: false,
    isPaused: false,
    isCountUp: false,
    genre: '',
  });

  // サロン画面等からのメインタイマー操作リクエスト（タイムスタンプ＋アクション名）
  const [mainTimerActionRequest, setMainTimerActionRequest] = useState(null);

  const requestMainTimerAction = (action, payload = null) => {
    // action: 'start' | 'pause' | 'reset' | 'set_time'
    setMainTimerActionRequest({ action, payload, timestamp: Date.now() });
  };

  return (
    <AppContext.Provider
      value={{
        mainTimerState,
        setMainTimerState,
        mainTimerActionRequest,
        requestMainTimerAction,
        isEcoMode,
        toggleEcoMode,
        isEcoClockEnabled,
        toggleEcoClock,
        isEcoBatteryEnabled,
        toggleEcoBattery,
        isEcoNavIconEnabled,
        toggleEcoNavIcon,
        isEcoNavActiveDot,
        toggleEcoNavActiveDot,
        isEcoBorderEnabled,
        toggleEcoBorder,
        isEcoIndicatorEnabled,
        toggleEcoIndicator,
        isNormalStatusBarEnabled,
        toggleNormalStatusBar,
        isNormalStatusBarAutoHide,
        toggleNormalStatusBarAutoHide,
        isNormalIndicatorEnabled,
        toggleNormalIndicator,
        isNormalTargetTimeEnabled,
        toggleNormalTargetTime,
        isEcoTargetTimeEnabled,
        toggleEcoTargetTime,
        isHomeStatsEnabled,
        toggleHomeStatsEnabled,
        isHomeStatsCollapsed,
        toggleHomeStatsCollapsed,
        isQuickAccessBarEnabled,
        toggleQuickAccessBar,
        isProMode,
        setIsProMode,
        toggleProMode,
        isColorIndicator,
        toggleColorIndicator,
        isCountdownEnabled,
        toggleCountdownEnabled,
        countdownSeconds,
        saveCountdownSeconds,
        alarmSoundType,
        toggleAlarmSoundType,
        isAlarmSoundEnabled,
        toggleAlarmSoundEnabled,
        isVoiceMasterEnabled,
        toggleVoiceMasterEnabled,
        isCountUpEnabled,
        toggleCountUpEnabled,
        playsInSilentMode,
        togglePlaysInSilentMode,
        isVibrationEnabled,
        toggleVibrationEnabled,
        isVibration3SecOnly,
        toggleVibration3SecOnly,
        vibrationIntensity,
        saveVibrationIntensity,
        isVibPrepEnabled,
        toggleVibPrep,
        isVibWarningEnabled,
        toggleVibWarning,
        isVibFinishEnabled,
        toggleVibFinish,
        isVibOvertimeEnabled,
        toggleVibOvertime,
        isVoice5MinEnabled,
        toggleVoice5Min,
        isVoice3MinEnabled,
        toggleVoice3Min,
        isVoice1MinEnabled,
        toggleVoice1Min,
        isVoice30SecEnabled,
        toggleVoice30Sec,
        isVoice10SecEnabled,
        toggleVoice10Sec,
        isVoiceFinishEnabled,
        toggleVoiceFinish,
        isPrepVoice15MinEnabled,
        togglePrepVoice15Min,
        isPrepVoice10MinEnabled,
        togglePrepVoice10Min,
        isPrepVoice5MinEnabled,
        togglePrepVoice5Min,
        isPrepVoice4MinEnabled,
        togglePrepVoice4Min,
        isPrepVoice3MinEnabled,
        togglePrepVoice3Min,
        isPrepVoice2MinEnabled,
        togglePrepVoice2Min,
        isPrepVoice1MinEnabled,
        togglePrepVoice1Min,
        isPrepVoice30SecEnabled,
        togglePrepVoice30Sec,
        isPrepVoice10SecEnabled,
        togglePrepVoice10Sec,
        isPrepVoiceCountdownEnabled,
        togglePrepVoiceCountdown,
        isOverVoiceStartEnabled,
        toggleOverVoiceStart,
        isOverVoice1MinEnabled,
        toggleOverVoice1Min,
        isOverVoice3MinEnabled,
        toggleOverVoice3Min,
        isOverVoice5MinEnabled,
        toggleOverVoice5Min,
        isOverVoice10MinEnabled,
        toggleOverVoice10Min,
        isOverVoice15MinEnabled,
        toggleOverVoice15Min,
        hasSeenEcoExplanation,
        markEcoExplanationSeen,
        isCheerModeEnabled,
        toggleCheerMode,
        isCheerInEcoEnabled,
        toggleCheerInEco,
        isCheerSoundEnabled,
        toggleCheerSound,
        // NEWS機能
        readNewsIds,
        isNewsHiddenUntilNext,
        markNewsAsRead,
        markAllNewsAsRead,
        hideNewsUntilNextUpdate,
        restoreNewsIcon,
        controlsOpacity,
        controlsVisible,
        showControls,
        resetControlsVisible,
        syncSeatsToWatchGlobal,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
