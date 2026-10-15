import { EventEmitter, requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

let NativeModule = null;
let emitter = null;

if (Platform.OS === 'ios') {
  try {
    NativeModule = requireNativeModule('ExpoWatchConnectivity');
    if (NativeModule) {
      emitter = new EventEmitter(NativeModule);
    }
  } catch (e) {
    console.warn('[ExpoWatchConnectivity] Native module not found or failed to load:', e);
  }
}

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
      // Watchがスリープ/非表示時はsendMessageが届かないことがあるため、warn程度に抑える
      console.log('[WatchConnectivity] sendMessage failed (watch might be sleeping):', e?.message);
      return null;
    }
  },

  transferUserInfo: async (userInfo) => {
    if (!NativeModule || Platform.OS !== 'ios') return false;
    try {
      if (NativeModule.transferUserInfo) {
        return await NativeModule.transferUserInfo(userInfo);
      }
      return false;
    } catch (e) {
      console.warn('[WatchConnectivity] transferUserInfo failed:', e);
      return false;
    }
  },

  // ★ トリプル送信メソッド（1: 次回起動時 2: スリープ時待機キュー 3: 起動中即時）
  syncData: async (data) => {
    if (!NativeModule || Platform.OS !== 'ios') return false;
    try {
      // 1. 次回起動時・最新状態の永続保存（Apple公式推奨）
      await NativeModule.updateApplicationContext(data).catch(() => {});

      // 2. バックグラウンド・スリープ中待機キューへの確実なキューイング（キュー送信）
      if (NativeModule.transferUserInfo) {
        await NativeModule.transferUserInfo(data).catch(() => {});
      }

      // 3. 画面起動中であればリアルタイム即時送信
      let reachable = false;
      try {
        reachable = typeof NativeModule.isReachable === 'function'
          ? NativeModule.isReachable()
          : !!NativeModule.isReachable;
      } catch {}
      if (reachable) {
        await NativeModule.sendMessage(data).catch(() => {});
      }
      return true;
    } catch (e) {
      console.warn('[WatchConnectivity] syncData error:', e);
      return false;
    }
  },

  addMessageListener: (callback) => {
    if (!emitter) return { remove: () => {} };
    const subscription = emitter.addListener('onMessageReceived', (event) => {
      if (event && event.message) {
        callback(event.message);
      }
    });
    return subscription;
  },

  addApplicationContextListener: (callback) => {
    if (!emitter) return { remove: () => {} };
    const subscription = emitter.addListener('onApplicationContextReceived', (event) => {
      if (event && event.context) {
        callback(event.context);
      }
    });
    return subscription;
  },

  addUserInfoListener: (callback) => {
    if (!emitter) return { remove: () => {} };
    const subscription = emitter.addListener('onUserInfoReceived', (event) => {
      if (event && event.userInfo) {
        callback(event.userInfo);
      }
    });
    return subscription;
  },
};

export default WatchConnectivity;
