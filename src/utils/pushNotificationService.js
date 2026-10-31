import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { getOrCreateUserId, isValidUUID } from './salonCloudService';

// ネイティブ再ビルド前の既存バイナリ環境でもクラッシュしないよう安全に動的ロード
let Notifications = null;
let Device = null;
let Constants = null;

try {
  Notifications = require('expo-notifications');
} catch (e) {
  console.warn('[PushNotification] expo-notifications module is not available in this build:', e?.message || e);
}

try {
  Device = require('expo-device');
} catch (e) {
  console.warn('[PushNotification] expo-device module is not available in this build:', e?.message || e);
}

try {
  Constants = require('expo-constants');
  if (Constants?.default) {
    Constants = Constants.default;
  }
} catch (e) {
  console.warn('[PushNotification] expo-constants module is not available in this build:', e?.message || e);
}

const EXPO_PUSH_TOKEN_STORAGE_KEY = '@assist_timer_expo_push_token';
const FALLBACK_EAS_PROJECT_ID = '96db37f6-0068-4dab-8f29-1055c9915014';

let _isHandlerConfigured = false;
let _cachedExpoPushToken = null;
let _tokenFetchPromise = null;
const _recentTokenSyncMap = new Map();

// Realtime と Remote Push 間の二重通知（トースト・Watch振動）を防ぐ共通キャッシュ
// ※ 同一チャネル内（例: Realtime でタイマー開始直後にチェック追加・担当変更が連続したケース）で誤って後続通知を握り潰さないよう、
//   semanticKey はチャネル別（push / realtime）に記録し、異チャネル間の重複のみを抑止する。
const _handledNotifIds = new Map();
const _handledPushSemanticKeys = new Map();
const _handledRealtimeSemanticKeys = new Map();
const NOTIF_ID_TTL_MS = 5 * 60 * 1000;
const SEMANTIC_KEY_TTL_MS = 6500;

export const getEasProjectId = () =>
  Constants?.expoConfig?.extra?.eas?.projectId ||
  Constants?.easConfig?.projectId ||
  FALLBACK_EAS_PROJECT_ID;

/**
 * フォアグラウンド時のOSプッシュバナー二重表示を抑止する通知ハンドラを設定
 * （フォアグラウンド時は Supabase Realtime 側のアプリ内トースト＋Watch直接通知のみを発火）
 */
export const configurePushNotificationHandler = () => {
  if (_isHandlerConfigured || !Notifications || Platform.OS === 'web') return;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const reqId = String(notification?.request?.identifier || '');
        if (reqId.startsWith('assisttimer.peer.')) {
          return {
            shouldShowAlert: true,
            shouldShowBanner: true,
            shouldShowList: true,
            shouldPlaySound: true,
            shouldSetBadge: false,
          };
        }
        const isForeground = AppState.currentState === 'active';
        if (isForeground) {
          return {
            shouldShowAlert: false,
            shouldShowBanner: false,
            shouldShowList: false,
            shouldPlaySound: false,
            shouldSetBadge: false,
          };
        }
        return {
          shouldShowAlert: true,
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        };
      },
    });

    if (Platform.OS === 'android' && typeof Notifications.setNotificationChannelAsync === 'function') {
      Notifications.setNotificationChannelAsync('salon-shared-events', {
        name: 'サロン共有通知',
        importance: Notifications.AndroidImportance?.MAX ?? 5,
        vibrationPattern: [0, 200, 120, 200],
        sound: 'default',
      }).catch(() => {});
    }

    _isHandlerConfigured = true;
  } catch (e) {
    console.warn('[PushNotification] configurePushNotificationHandler failed:', e?.message || e);
  }
};

const pruneMapByTtl = (map, ttlMs, maxEntries) => {
  const now = Date.now();
  if (map.size <= maxEntries) {
    for (const [k, ts] of map.entries()) {
      if (now - ts > ttlMs) map.delete(k);
    }
    return;
  }
  for (const [k, ts] of map.entries()) {
    if (now - ts > ttlMs || map.size > maxEntries) {
      map.delete(k);
    }
  }
};

/**
 * 同一席・同一種別のイベント重複判定用セマンティックキーを生成
 */
export const buildPeerEventSemanticKey = (timerIdOrLabel, eventType) => {
  const target = String(timerIdOrLabel || '').trim();
  const ev = String(eventType || '').trim();
  if (!target || !ev) return '';
  return `${target}|${ev}`;
};

/**
 * 指定した notifId またはセマンティックキーが既に処理済みかどうか判定
 */
export const hasHandledPeerNotification = ({ notifId = '', semanticKey = '', channel = 'any' } = {}) => {
  const now = Date.now();
  if (notifId) {
    const ts = _handledNotifIds.get(String(notifId));
    if (ts && now - ts <= NOTIF_ID_TTL_MS) return true;
  }
  if (semanticKey) {
    const key = String(semanticKey);
    if (channel === 'realtime') {
      const pushTs = _handledPushSemanticKeys.get(key);
      if (pushTs && now - pushTs <= SEMANTIC_KEY_TTL_MS) return true;
    } else if (channel === 'push') {
      const rtTs = _handledRealtimeSemanticKeys.get(key);
      if (rtTs && now - rtTs <= SEMANTIC_KEY_TTL_MS) return true;
      const pushTs = _handledPushSemanticKeys.get(key);
      if (pushTs && now - pushTs <= SEMANTIC_KEY_TTL_MS) return true;
    } else {
      const pushTs = _handledPushSemanticKeys.get(key);
      const rtTs = _handledRealtimeSemanticKeys.get(key);
      if ((pushTs && now - pushTs <= SEMANTIC_KEY_TTL_MS) || (rtTs && now - rtTs <= SEMANTIC_KEY_TTL_MS)) {
        return true;
      }
    }
  }
  return false;
};

/**
 * notifId およびセマンティックキーを処理済みとして記録
 */
export const markPeerNotificationHandled = ({ notifId = '', semanticKey = '', channel = 'any' } = {}) => {
  const now = Date.now();
  if (notifId) {
    _handledNotifIds.set(String(notifId), now);
    pruneMapByTtl(_handledNotifIds, NOTIF_ID_TTL_MS, 150);
  }
  if (semanticKey) {
    const key = String(semanticKey);
    if (channel === 'push') {
      _handledPushSemanticKeys.set(key, now);
      pruneMapByTtl(_handledPushSemanticKeys, SEMANTIC_KEY_TTL_MS, 100);
    } else if (channel === 'realtime') {
      _handledRealtimeSemanticKeys.set(key, now);
      pruneMapByTtl(_handledRealtimeSemanticKeys, SEMANTIC_KEY_TTL_MS, 100);
    } else {
      _handledPushSemanticKeys.set(key, now);
      _handledRealtimeSemanticKeys.set(key, now);
      pruneMapByTtl(_handledPushSemanticKeys, SEMANTIC_KEY_TTL_MS, 100);
      pruneMapByTtl(_handledRealtimeSemanticKeys, SEMANTIC_KEY_TTL_MS, 100);
    }
  }
};

/**
 * 実機上で通知権限を確認・要求し、Expo Push Token を取得
 */
export const getOrFetchExpoPushToken = async () => {
  if (Platform.OS === 'web' || !Notifications) return null;
  if (Device && Device.isDevice === false) {
    return null;
  }
  if (_cachedExpoPushToken) return _cachedExpoPushToken;
  if (_tokenFetchPromise) return _tokenFetchPromise;

  _tokenFetchPromise = (async () => {
    try {
      configurePushNotificationHandler();

      const existingPerm = await Notifications.getPermissionsAsync();
      let finalStatus = existingPerm?.status;
      if (finalStatus !== 'granted') {
        const requestedPerm = await Notifications.requestPermissionsAsync({
          ios: {
            allowAlert: true,
            allowBadge: true,
            allowSound: true,
          },
        });
        finalStatus = requestedPerm?.status;
      }
      if (finalStatus !== 'granted') {
        return null;
      }

      const projectId = getEasProjectId();
      const tokenResp = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined
      );
      const token = tokenResp?.data ? String(tokenResp.data).trim() : '';
      if (token) {
        _cachedExpoPushToken = token;
        AsyncStorage.setItem(EXPO_PUSH_TOKEN_STORAGE_KEY, token).catch(() => {});
        return token;
      }
      return null;
    } catch (e) {
      console.warn('[PushNotification] getOrFetchExpoPushToken skipped:', e?.message || e);
      try {
        const cached = await AsyncStorage.getItem(EXPO_PUSH_TOKEN_STORAGE_KEY);
        if (cached) {
          _cachedExpoPushToken = cached;
          return cached;
        }
      } catch {}
      return null;
    } finally {
      _tokenFetchPromise = null;
    }
  })();

  return _tokenFetchPromise;
};

/**
 * サロン参加・起動・サロン切替時に Expo Push Token を Supabase (salon_member_push_tokens) へ UPSERT
 */
export const registerAndSyncSalonPushToken = async ({ salonId, userId = null } = {}) => {
  if (!isValidUUID(salonId) || Platform.OS === 'web') return null;
  try {
    const [resolvedUserId, expoPushToken] = await Promise.all([
      userId ? Promise.resolve(userId) : getOrCreateUserId(),
      getOrFetchExpoPushToken(),
    ]);
    if (!resolvedUserId || !expoPushToken) return null;

    const cacheKey = `${salonId}|${resolvedUserId}|${expoPushToken}`;
    const prevSyncedAt = _recentTokenSyncMap.get(cacheKey) || 0;
    if (Date.now() - prevSyncedAt < 60 * 1000) {
      return expoPushToken;
    }

    const { error } = await supabase
      .from('salon_member_push_tokens')
      .upsert(
        {
          salon_id: salonId,
          user_id: String(resolvedUserId),
          expo_push_token: expoPushToken,
          platform: Platform.OS,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'salon_id,user_id,expo_push_token' }
      );

    if (error) {
      // SQLマイグレーション適用前の環境でもアプリ動作を阻害しない
      console.warn('[PushNotification] upsert salon_member_push_tokens skipped:', error.message || error);
      return null;
    }

    _recentTokenSyncMap.set(cacheKey, Date.now());
    return expoPushToken;
  } catch (e) {
    console.warn('[PushNotification] registerAndSyncSalonPushToken failed:', e?.message || e);
    return null;
  }
};

/**
 * サロン退出・メンバー解除時に Supabase から該当プッシュトークンを削除
 */
export const removeSalonPushToken = async ({ salonId, userId = null, onlyCurrentDevice = true } = {}) => {
  if (!isValidUUID(salonId)) return false;
  try {
    const resolvedUserId = userId || (await getOrCreateUserId());
    if (!resolvedUserId) return false;

    let tokenToMatch = null;
    if (onlyCurrentDevice) {
      tokenToMatch = _cachedExpoPushToken || (await AsyncStorage.getItem(EXPO_PUSH_TOKEN_STORAGE_KEY));
    }

    let query = supabase
      .from('salon_member_push_tokens')
      .delete()
      .eq('salon_id', salonId)
      .eq('user_id', String(resolvedUserId));

    if (onlyCurrentDevice && tokenToMatch) {
      query = query.eq('expo_push_token', tokenToMatch);
    }

    const { error } = await query;
    if (error) {
      console.warn('[PushNotification] removeSalonPushToken skipped:', error.message || error);
      return false;
    }

    for (const k of _recentTokenSyncMap.keys()) {
      if (k.startsWith(`${salonId}|${resolvedUserId}|`)) {
        _recentTokenSyncMap.delete(k);
      }
    }
    return true;
  } catch (e) {
    console.warn('[PushNotification] removeSalonPushToken failed:', e?.message || e);
    return false;
  }
};

/**
 * リモートプッシュ受信リスナー登録（バックグラウンド起床時の最新タイマー取得＆Watch即時中継用）
 */
export const subscribeRemotePushEvents = (onRemoteSalonPush) => {
  if (!Notifications || Platform.OS === 'web' || typeof Notifications.addNotificationReceivedListener !== 'function') {
    return () => {};
  }
  configurePushNotificationHandler();

  const subscription = Notifications.addNotificationReceivedListener((notification) => {
    try {
      const reqId = String(notification?.request?.identifier || '');
      if (reqId.startsWith('assisttimer.peer.')) {
        return;
      }
      const content = notification?.request?.content || {};
      const data = content?.data && typeof content.data === 'object' ? content.data : {};
      const title = String(content?.title || '');
      const body = String(content?.body || '');
      if (typeof onRemoteSalonPush === 'function') {
        onRemoteSalonPush({
          reqId,
          title,
          body,
          data,
          appState: AppState.currentState || 'unknown',
          notification,
        });
      }
    } catch (e) {
      console.warn('[PushNotification] onRemoteSalonPush handler error:', e?.message || e);
    }
  });

  return () => {
    try {
      subscription?.remove?.();
    } catch {}
  };
};

let _lastHandledTapReqId = '';

/**
 * プッシュ通知／共有通知バナーのタップ時にサロンタブへ遷移させるリスナー登録
 */
export const subscribeNotificationTapNavigation = (onNavigateToSalon) => {
  if (!Notifications || Platform.OS === 'web') {
    return () => {};
  }
  configurePushNotificationHandler();

  const handleResponse = (response) => {
    try {
      const req = response?.notification?.request;
      const reqId = String(req?.identifier || '');
      if (!reqId || reqId === _lastHandledTapReqId) return;

      const data = req?.content?.data && typeof req.content.data === 'object' ? req.content.data : {};
      const isSalonNotification =
        reqId.startsWith('assisttimer.peer.') ||
        Boolean(data?.salonId || data?.timerId || data?.eventType || data?.notifId);

      if (isSalonNotification && typeof onNavigateToSalon === 'function') {
        _lastHandledTapReqId = reqId;
        onNavigateToSalon(data);
      }
    } catch (e) {
      console.warn('[PushNotification] handleResponse error:', e?.message || e);
    }
  };

  if (typeof Notifications.getLastNotificationResponseAsync === 'function') {
    Notifications.getLastNotificationResponseAsync()
      .then((initialResp) => {
        if (initialResp) handleResponse(initialResp);
      })
      .catch(() => {});
  }

  const subscription =
    typeof Notifications.addNotificationResponseReceivedListener === 'function'
      ? Notifications.addNotificationResponseReceivedListener(handleResponse)
      : null;

  return () => {
    try {
      subscription?.remove?.();
    } catch {}
  };
};
