import { EventEmitter, requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

let NativeModule = null;
let emitter = null;

if (Platform.OS === 'ios') {
  try {
    NativeModule = requireNativeModule('ExpoWatchConnectivity');
    if (NativeModule) {
      emitter = typeof NativeModule.addListener === 'function'
        ? NativeModule
        : new EventEmitter(NativeModule);
    }
  } catch (e) {
    console.warn('[ExpoWatchConnectivity] Native module not found or failed to load:', e);
  }
}

const safeAddListener = (eventName, callback) => {
  if (NativeModule && typeof NativeModule.addListener === 'function') {
    try {
      return NativeModule.addListener(eventName, callback);
    } catch {}
  }
  if (emitter && typeof emitter.addListener === 'function') {
    try {
      return emitter.addListener(eventName, callback);
    } catch {}
  }
  return { remove: () => {} };
};

export const WatchConnectivity = {
  isSupported: () => {
    if (!NativeModule || Platform.OS !== 'ios') return false;
    try {
      return NativeModule.isSupported();
    } catch {
      return false;
    }
  },

  isPaired: () => {
    if (!NativeModule || Platform.OS !== 'ios') return false;
    try {
      return NativeModule.isPaired();
    } catch {
      return false;
    }
  },

  isWatchAppInstalled: () => {
    if (!NativeModule || Platform.OS !== 'ios') return false;
    try {
      return NativeModule.isWatchAppInstalled();
    } catch {
      return false;
    }
  },

  isReachable: () => {
    if (!NativeModule || Platform.OS !== 'ios') return false;
    try {
      return NativeModule.isReachable();
    } catch {
      return false;
    }
  },

  activate: async () => {
    if (!NativeModule || Platform.OS !== 'ios') {
      return { supported: false, activated: false };
    }
    try {
      return await NativeModule.activate();
    } catch (e) {
      console.warn('[WatchConnectivity] activate failed:', e);
      return { supported: false, error: e?.message };
    }
  },

  updateApplicationContext: async (context) => {
    if (!NativeModule || Platform.OS !== 'ios') return false;
    try {
      return await NativeModule.updateApplicationContext(context);
    } catch (e) {
      console.warn('[WatchConnectivity] updateApplicationContext failed:', e);
      return false;
    }
  },

  sendMessage: async (message) => {
    if (!NativeModule || Platform.OS !== 'ios') return null;
    try {
      return await NativeModule.sendMessage(message);
    } catch (e) {
      console.log('[WatchConnectivity] sendMessage failed:', e?.message);
      return null;
    }
  },

  transferUserInfo: async (userInfo) => {
    if (!NativeModule || Platform.OS !== 'ios') return false;
    try {
      const isPaired = typeof NativeModule.isPaired === 'function' ? NativeModule.isPaired() : !!NativeModule.isPaired;
      if (!isPaired) {
        return false;
      }
      if (NativeModule.transferUserInfo) {
        return await NativeModule.transferUserInfo(userInfo);
      }
      return false;
    } catch (e) {
      console.warn('[WatchConnectivity] transferUserInfo failed:', e);
      return false;
    }
  },

  // ★ 安定・リアルタイム完全両立同期メソッド（最優先リアルタイム即時送信 ＋ 次回起動・消灯時永続保存）
  syncData: async (data) => {
    if (!NativeModule || Platform.OS !== 'ios') return false;
    try {
      // 1. Watch画面起動中であればリアルタイム即時送信を最優先実行！
      let reachable = false;
      try {
        reachable = typeof NativeModule.isReachable === 'function'
          ? NativeModule.isReachable()
          : !!NativeModule.isReachable;
      } catch {}
      if (reachable) {
        try {
          await NativeModule.sendMessage(data);
        } catch (sendErr) {
          console.log('[WatchConnectivity] immediate sendMessage skipped/retry via context:', sendErr?.message);
        }
      }

      // 2. 次回起動時・消灯スリープ復帰用の最新状態永続保存（Apple公式推奨）
      await NativeModule.updateApplicationContext(data).catch(() => {});
      return true;
    } catch (e) {
      console.warn('[WatchConnectivity] syncData error:', e);
      return false;
    }
  },

  addMessageListener: (callback) => {
    return safeAddListener('onMessageReceived', (event) => {
      if (event && event.message) {
        callback(event.message);
      }
    });
  },

  addApplicationContextListener: (callback) => {
    return safeAddListener('onApplicationContextReceived', (event) => {
      if (event && event.context) {
        callback(event.context);
      }
    });
  },

  addUserInfoListener: (callback) => {
    return safeAddListener('onUserInfoReceived', (event) => {
      if (event && event.userInfo) {
        callback(event.userInfo);
      }
    });
  },
};

export default WatchConnectivity;
