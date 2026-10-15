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

  // 両方に送信する便利メソッド（起動中なら即時反映、スリープ中なら次回起動時に同期）
  syncData: async (data) => {
    if (!NativeModule || Platform.OS !== 'ios') return false;
    try {
      // 1. バックグラウンド永続更新（Apple公式推奨）
      await NativeModule.updateApplicationContext(data).catch(() => {});
      // 2. 画面起動中であればリアルタイム即時更新
      if (NativeModule.isReachable && NativeModule.isReachable()) {
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
