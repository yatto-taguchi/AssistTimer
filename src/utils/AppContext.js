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

// RevenueCat APIキー設定
export const REVENUECAT_PUBLIC_APPLE_KEY = 'appl_jEzBjFMGADnabxXSYPQqMxFYKXJ';

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
  const [isProMode, setIsProModeState] = useState(false); // 課金（Proプラン）状態
  const [isColorIndicator, setIsColorIndicator] = useState(true); // カラーインジケーター（10分以下タイマー用）
  const [isCountdownEnabled, setIsCountdownEnabled] = useState(false); // スタート前カウントダウン
  const [countdownSeconds, setCountdownSeconds] = useState(10); // カウントダウン秒数
  const [hasSeenEcoExplanation, setHasSeenEcoExplanation] = useState(false); // エコモード説明モーダル閲覧済みフラグ

  const [alarmSoundType, setAlarmSoundType] = useState('digital'); // 'digital' | 'bell' | 'buzzer' | 'kitchen' | 'fast' | 'gong' | 'none'
  const [isAlarmSoundEnabled, setIsAlarmSoundEnabled] = useState(true); // アラーム音のマスター有効/無効
  const [isVoiceMasterEnabled, setIsVoiceMasterEnabled] = useState(true); // 音声アナウンス全体のマスター有効/無効
  const [isCountUpEnabled, setIsCountUpEnabled] = useState(true); // カウントアップ（超過時間計測）有効/無効
  const [playsInSilentMode, setPlaysInSilentMode] = useState(true); // マナーモード時でも鳴らす
  const [isVibrationEnabled, setIsVibrationEnabled] = useState(true); // バイブレーション（振動）全体有効/無効
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
        const proVal = await AsyncStorage.getItem('isProMode');
        const colorVal = await AsyncStorage.getItem('isColorIndicator');
        const countdownEnabledVal = await AsyncStorage.getItem('isCountdownEnabled');
        const countdownSecVal = await AsyncStorage.getItem('countdownSeconds');
        const seenEcoVal = await AsyncStorage.getItem('hasSeenEcoExplanation');
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
        if (proVal !== null) setIsProModeState(JSON.parse(proVal));
        if (colorVal !== null) setIsColorIndicator(JSON.parse(colorVal));
        if (countdownEnabledVal !== null) setIsCountdownEnabled(JSON.parse(countdownEnabledVal));
        if (countdownSecVal !== null) setCountdownSeconds(parseInt(countdownSecVal, 10));
        if (seenEcoVal !== null) setHasSeenEcoExplanation(JSON.parse(seenEcoVal));
        if (soundTypeVal !== null) setAlarmSoundType(soundTypeVal);
        if (alarmSoundEnabledVal !== null) setIsAlarmSoundEnabled(JSON.parse(alarmSoundEnabledVal));
        if (voiceMasterVal !== null) setIsVoiceMasterEnabled(JSON.parse(voiceMasterVal));
        if (countUpVal !== null) setIsCountUpEnabled(JSON.parse(countUpVal));
        if (silentModeVal !== null) setPlaysInSilentMode(JSON.parse(silentModeVal));
        if (vibrationVal !== null) setIsVibrationEnabled(JSON.parse(vibrationVal));
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
      } catch (e) {
        console.error("Failed to load settings.", e);
      }
    };
    loadSettings();
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

  return (
    <AppContext.Provider
      value={{
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
        controlsOpacity,
        controlsVisible,
        showControls,
        resetControlsVisible,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
