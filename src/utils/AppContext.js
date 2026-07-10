import React, { createContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const AppContext = createContext();

export const AppProvider = ({ children }) => {
  const [isEcoMode, setIsEcoMode] = useState(false);
  const [isProMode, setIsProMode] = useState(false); // 課金・広告デモ用
  const [isColorIndicator, setIsColorIndicator] = useState(true); // カラーインジケーター（10分以下タイマー用）
  const [isCountdownEnabled, setIsCountdownEnabled] = useState(false); // スタート前カウントダウン
  const [countdownSeconds, setCountdownSeconds] = useState(10); // カウントダウン秒数

  // 初期ロード時にAsyncStorageから設定を読み込む
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const ecoVal = await AsyncStorage.getItem('isEcoMode');
        const proVal = await AsyncStorage.getItem('isProMode');
        const colorVal = await AsyncStorage.getItem('isColorIndicator');
        const countdownEnabledVal = await AsyncStorage.getItem('isCountdownEnabled');
        const countdownSecVal = await AsyncStorage.getItem('countdownSeconds');
        
        if (ecoVal !== null) setIsEcoMode(JSON.parse(ecoVal));
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
    <AppContext.Provider value={{ 
      isEcoMode, toggleEcoMode, 
      isProMode, toggleProMode, 
      isColorIndicator, toggleColorIndicator,
      isCountdownEnabled, toggleCountdownEnabled,
      countdownSeconds, saveCountdownSeconds
    }}>
      {children}
    </AppContext.Provider>
  );
};
