import React, { createContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const AppContext = createContext();

export const AppProvider = ({ children }) => {
  const [isEcoMode, setIsEcoMode] = useState(false);
  const [isProMode, setIsProMode] = useState(false); // 課金・広告デモ用

  // 初期ロード時にAsyncStorageから設定を読み込む
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const ecoVal = await AsyncStorage.getItem('isEcoMode');
        const proVal = await AsyncStorage.getItem('isProMode');
        if (ecoVal !== null) setIsEcoMode(JSON.parse(ecoVal));
        if (proVal !== null) setIsProMode(JSON.parse(proVal));
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

  return (
    <AppContext.Provider value={{ isEcoMode, toggleEcoMode, isProMode, toggleProMode }}>
      {children}
    </AppContext.Provider>
  );
};
