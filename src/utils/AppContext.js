import React, { createContext, useState, useEffect } from 'react';
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
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
