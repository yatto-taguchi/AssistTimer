import React, { createContext, useState, useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const AppContext = createContext();

export const AppProvider = ({ children }) => {
  const [isEcoMode, setIsEcoMode] = useState(false);
  const [isEcoClockEnabled, setIsEcoClockEnabled] = useState(true);
  const [isEcoBatteryEnabled, setIsEcoBatteryEnabled] = useState(true);
  const [isEcoNavIconEnabled, setIsEcoNavIconEnabled] = useState(false); // trueでアイコン、falseで点
  const [isEcoNavActiveDot, setIsEcoNavActiveDot] = useState(false); // アイコン表示時、選択中のみ点にする
  const [isEcoBorderEnabled, setIsEcoBorderEnabled] = useState(false); // trueで境界線あり、falseでなし
  const [isEcoIndicatorEnabled, setIsEcoIndicatorEnabled] = useState(true); // エコモードでのタイマーリング表示
  const [isNormalClockEnabled, setIsNormalClockEnabled] = useState(false); // 通常モードでの時計表示
  const [isNormalBatteryEnabled, setIsNormalBatteryEnabled] = useState(false); // 通常モードでの電池表示
  const [isNormalIndicatorEnabled, setIsNormalIndicatorEnabled] = useState(true); // 通常モードでのタイマーリング表示
  const [isProMode, setIsProMode] = useState(false); // 課金・広告デモ用
  const [isColorIndicator, setIsColorIndicator] = useState(true); // カラーインジケーター（10分以下タイマー用）
  const [isCountdownEnabled, setIsCountdownEnabled] = useState(false); // スタート前カウントダウン
  const [countdownSeconds, setCountdownSeconds] = useState(10); // カウントダウン秒数
  const [hasSeenEcoExplanation, setHasSeenEcoExplanation] = useState(false); // エコモード説明モーダル閲覧済みフラグ

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
        const normalClockVal = await AsyncStorage.getItem('isNormalClockEnabled');
        const normalBatteryVal = await AsyncStorage.getItem('isNormalBatteryEnabled');
        const normalIndicatorVal = await AsyncStorage.getItem('isNormalIndicatorEnabled');
        const proVal = await AsyncStorage.getItem('isProMode');
        const colorVal = await AsyncStorage.getItem('isColorIndicator');
        const countdownEnabledVal = await AsyncStorage.getItem('isCountdownEnabled');
        const countdownSecVal = await AsyncStorage.getItem('countdownSeconds');
        const seenEcoVal = await AsyncStorage.getItem('hasSeenEcoExplanation');
        
        if (ecoVal !== null) setIsEcoMode(JSON.parse(ecoVal));
        if (ecoClockVal !== null) setIsEcoClockEnabled(JSON.parse(ecoClockVal));
        if (ecoBatteryVal !== null) setIsEcoBatteryEnabled(JSON.parse(ecoBatteryVal));
        if (ecoNavIconVal !== null) setIsEcoNavIconEnabled(JSON.parse(ecoNavIconVal));
        if (ecoNavActiveDotVal !== null) setIsEcoNavActiveDot(JSON.parse(ecoNavActiveDotVal));
        if (ecoBorderVal !== null) setIsEcoBorderEnabled(JSON.parse(ecoBorderVal));
        if (ecoIndicatorVal !== null) setIsEcoIndicatorEnabled(JSON.parse(ecoIndicatorVal));
        if (normalClockVal !== null) setIsNormalClockEnabled(JSON.parse(normalClockVal));
        if (normalBatteryVal !== null) setIsNormalBatteryEnabled(JSON.parse(normalBatteryVal));
        if (normalIndicatorVal !== null) setIsNormalIndicatorEnabled(JSON.parse(normalIndicatorVal));
        if (proVal !== null) setIsProMode(JSON.parse(proVal));
        if (colorVal !== null) setIsColorIndicator(JSON.parse(colorVal));
        if (countdownEnabledVal !== null) setIsCountdownEnabled(JSON.parse(countdownEnabledVal));
        if (countdownSecVal !== null) setCountdownSeconds(parseInt(countdownSecVal, 10));
        if (seenEcoVal !== null) setHasSeenEcoExplanation(JSON.parse(seenEcoVal));
      } catch (e) {
        console.error("Failed to load settings.", e);
      }
    };
    loadSettings();
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

  const toggleNormalClock = async (value) => {
    setIsNormalClockEnabled(value);
    await AsyncStorage.setItem('isNormalClockEnabled', JSON.stringify(value));
  };

  const toggleNormalBattery = async (value) => {
    setIsNormalBatteryEnabled(value);
    await AsyncStorage.setItem('isNormalBatteryEnabled', JSON.stringify(value));
  };

  const toggleNormalIndicator = async (value) => {
    setIsNormalIndicatorEnabled(value);
    await AsyncStorage.setItem('isNormalIndicatorEnabled', JSON.stringify(value));
  };

  // Proモード切替と保存
  const toggleProMode = async (value) => {
    setIsProMode(value);
    await AsyncStorage.setItem('isProMode', JSON.stringify(value));
  };

  // カラーインジケーター切替と保存
  const toggleColorIndicator = async (value) => {
    setIsColorIndicator(value);
    await AsyncStorage.setItem('isColorIndicator', JSON.stringify(value));
  };

  // カウントダウン機能切替と保存
  const toggleCountdownEnabled = async (value) => {
    setIsCountdownEnabled(value);
    await AsyncStorage.setItem('isCountdownEnabled', JSON.stringify(value));
  };

  // カウントダウン秒数保存
  const saveCountdownSeconds = async (value) => {
    setCountdownSeconds(value);
    await AsyncStorage.setItem('countdownSeconds', value.toString());
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
        isNormalClockEnabled,
        toggleNormalClock,
        isNormalBatteryEnabled,
        toggleNormalBattery,
        isNormalIndicatorEnabled,
        toggleNormalIndicator,
        isProMode,
        toggleProMode,
        isColorIndicator,
        toggleColorIndicator,
        isCountdownEnabled,
        toggleCountdownEnabled,
        countdownSeconds,
        saveCountdownSeconds,
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
