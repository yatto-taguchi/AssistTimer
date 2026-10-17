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

// ★ 診断用ストア（画面の通信状態表示で使用）
const diagnostics = {
  lastSendAt: 0,
  lastSendSeatCount: null,
  lastSendMessageResult: '',
  lastSendContextResult: '',
  sendCount: 0,
  jsReceivedCount: 0,
  lastJsReceivedAt: 0,
  lastJsReceivedKind: '',
  lastJsReceivedAction: '',
};
const diagnosticsSubscribers = new Set();
const updateDiagnostics = (patch) => {
  Object.assign(diagnostics, patch);
  const snapshot = { ...diagnostics };
  diagnosticsSubscribers.forEach((cb) => {
    try { cb(snapshot); } catch {}
  });
};
const recordJsReceived = (kind, body) => {
  updateDiagnostics({
    jsReceivedCount: diagnostics.jsReceivedCount + 1,
    lastJsReceivedAt: Date.now(),
    lastJsReceivedKind: kind,
    lastJsReceivedAction: (body && (body.action || body.type)) || '?',
  });
};
const errorText = (e) => (e && (e.message || e.code)) ? String(e.message || e.code) : String(e);

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

  // ★ 診断用: ネイティブ層の通信状態（有効化・ペアリング・受信回数など）
  getStatus: () => {
    if (!NativeModule || Platform.OS !== 'ios') return null;
    try {
      return typeof NativeModule.getStatus === 'function' ? NativeModule.getStatus() : null;
    } catch (e) {
      return { error: errorText(e) };
    }
  },

  addStatusListener: (callback) => {
    return safeAddListener('onStatusChanged', (event) => {
      if (event) callback(event);
    });
  },

  getDiagnostics: () => ({ ...diagnostics }),

  subscribeDiagnostics: (callback) => {
    diagnosticsSubscribers.add(callback);
    return () => diagnosticsSubscribers.delete(callback);
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

  // ★ 同期送信（①Watch画面が開いていれば即時送信 ＋ ②次回起動・復帰用の最新状態保存）
  // 結果は診断ストアに記録し、画面の通信状態表示で確認できる
  syncData: async (data) => {
    if (!NativeModule || Platform.OS !== 'ios') return null;
    const seatCount = data && Array.isArray(data.seats) ? data.seats.length : null;
    let messageResult = '';
    let contextResult = '';
    try {
      let reachable = false;
      try {
        reachable = typeof NativeModule.isReachable === 'function'
          ? NativeModule.isReachable()
          : !!NativeModule.isReachable;
      } catch {}

      if (reachable) {
        try {
          await NativeModule.sendMessage(data);
          messageResult = '即時OK';
        } catch (sendErr) {
          messageResult = `失敗: ${errorText(sendErr)}`;
        }
      } else {
        messageResult = '未接続のため即時送信なし';
      }

      try {
        const ok = await NativeModule.updateApplicationContext(data);
        contextResult = ok ? '保存OK' : '保存されず';
      } catch (ctxErr) {
        contextResult = `失敗: ${errorText(ctxErr)}`;
      }
    } catch (e) {
      messageResult = messageResult || `失敗: ${errorText(e)}`;
    }

    updateDiagnostics({
      lastSendAt: Date.now(),
      lastSendSeatCount: seatCount,
      lastSendMessageResult: messageResult,
      lastSendContextResult: contextResult,
      sendCount: diagnostics.sendCount + 1,
    });
    return { messageResult, contextResult };
  },

  addMessageListener: (callback) => {
    return safeAddListener('onMessageReceived', (event) => {
      if (event && event.message) {
        recordJsReceived('message', event.message);
        callback(event.message);
      }
    });
  },

  addApplicationContextListener: (callback) => {
    return safeAddListener('onApplicationContextReceived', (event) => {
      if (event && event.context) {
        recordJsReceived('context', event.context);
        callback(event.context);
      }
    });
  },

  addUserInfoListener: (callback) => {
    return safeAddListener('onUserInfoReceived', (event) => {
      if (event && event.userInfo) {
        recordJsReceived('userInfo', event.userInfo);
        callback(event.userInfo);
      }
    });
  },
};

export default WatchConnectivity;
