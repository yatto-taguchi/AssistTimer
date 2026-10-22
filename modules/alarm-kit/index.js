import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

// ★ iOS 26 の AlarmKit（純正アラーム：マナーモードでも止めるまで鳴り続ける）の JS ラッパー
// iOS 26 未満・Android・モジュール未読込の場合は何もしない（安全にフォールバック）

let NativeModule = null;
if (Platform.OS === 'ios') {
  try {
    NativeModule = requireNativeModule('ExpoAlarmKit');
  } catch (e) {
    console.warn('[AlarmKit] Native module not found:', e);
  }
}

export const AlarmKit = {
  isModuleLoaded: () => !!NativeModule,

  isAvailable: () => {
    if (!NativeModule) return false;
    try { return !!NativeModule.isAvailable(); } catch { return false; }
  },

  getAuthorizationStatus: () => {
    if (!NativeModule) return 'unavailable';
    try { return NativeModule.getAuthorizationStatus(); } catch (e) { return `error: ${e?.message}`; }
  },

  requestAuthorization: async () => {
    if (!NativeModule) return 'unavailable';
    try { return await NativeModule.requestAuthorization(); } catch (e) { return `error: ${e?.message}`; }
  },

  // key: 任意の文字列ID / timestampMs: 鳴らす時刻(ミリ秒) / title: アラーム画面の表示 / soundOn: 音を鳴らすか
  // 戻り値: "ok" / "past" / "denied" / "unavailable" / "error: …"
  schedule: async (key, timestampMs, title, soundOn) => {
    if (!NativeModule) return 'unavailable';
    try {
      return await NativeModule.schedule(String(key), Number(timestampMs), String(title || 'タイマー終了'), !!soundOn);
    } catch (e) {
      return `error: ${e?.message}`;
    }
  },

  // 予約の取り消し（鳴っている最中なら停止）
  cancel: (key) => {
    if (!NativeModule) return false;
    try { return !!NativeModule.cancel(String(key)); } catch { return false; }
  },

  // 初回同期時に過去の残留アラームや孤立した予約を一括停止・消去
  cleanupOnSourceInit: (source, keepKeys = []) => {
    if (!NativeModule || typeof NativeModule.cleanupOnSourceInit !== 'function') return 0;
    try {
      return Number(NativeModule.cleanupOnSourceInit(String(source), Array.isArray(keepKeys) ? keepKeys.map(String) : [])) || 0;
    } catch {
      return 0;
    }
  },

  // ユーザーがアラーム画面で「停止」した予約（鳴る時刻を過ぎて AlarmKit の一覧から消えたもの）を取り出す
  // 戻り値: [{ key, timestamp(ms) }]。一度返したものは記録から消える
  takeUserStoppedAlarms: () => {
    if (!NativeModule || typeof NativeModule.takeUserStoppedAlarms !== 'function') return [];
    try {
      const list = NativeModule.takeUserStoppedAlarms();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  },
};

export default AlarmKit;
