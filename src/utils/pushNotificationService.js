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
//   semanticKey はチャネル別（push / realtime / os_banner）に記録し、異チャネル間の重複のみを抑止する。
const _handledNotifIds = new Map();
const _handledOsBannerNotifIds = new Map();
const _handledPushSemanticKeys = new Map();
const _handledRealtimeSemanticKeys = new Map();
const _handledOsBannerSemanticKeys = new Map();
const _handledWildcardPushSemanticKeys = new Map();
const _handledWildcardRealtimeSemanticKeys = new Map();
const _handledWildcardOsBannerSemanticKeys = new Map();
const NOTIF_ID_TTL_MS = 5 * 60 * 1000;
const SEMANTIC_KEY_TTL_MS = 45000;
const WILDCARD_SEMANTIC_KEY_TTL_MS = 3500;

export const getEasProjectId = () =>
  Constants?.expoConfig?.extra?.eas?.projectId ||
  Constants?.easConfig?.projectId ||
  FALLBACK_EAS_PROJECT_ID;

/**
 * フォアグラウンド時のOSプッシュバナー二重表示、およびバックグラウンド時の先行ローカル通知／先行Pushとの重複バナー表示を抑止する通知ハンドラを設定
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
        const content = notification?.request?.content || {};
        const data = content?.data && typeof content.data === 'object' ? content.data : {};
        const notifId = data?.notifId ? String(data.notifId) : reqId;
        const timerKey = data?.timerId || data?.seatLabel || '';
        const eventType = data?.eventType ? String(data.eventType) : '';
        const stateDisc = data?.stateDisc ? String(data.stateDisc) : '';
        const semanticKey =
          (data?.semanticKey ? String(data.semanticKey) : '') ||
          (timerKey && eventType
            ? buildPeerEventSemanticKey(timerKey, eventType, data?.actorId || data?.updatedBy || '', stateDisc)
            : '');

        if (data?.seatSnapshot && typeof data.seatSnapshot === 'object') {
          purgeStaleSemanticKeysForSeatState(null, data.seatSnapshot, {
            salonId: data?.salonId ? String(data.salonId) : '',
          });
        }

        if (hasHandledPeerNotification({ notifId, semanticKey, channel: 'os_banner' })) {
          return {
            shouldShowAlert: false,
            shouldShowBanner: false,
            shouldShowList: false,
            shouldPlaySound: false,
            shouldSetBadge: false,
          };
        }
        markPeerNotificationHandled({ notifId, semanticKey, channel: 'os_banner' });
        const isGentleUnassign =
          eventType === 'unassign_assist' || eventType === 'unassign_check';
        return {
          shouldShowAlert: true,
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: !isGentleUnassign,
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

const normalizeSemanticToken = (raw) =>
  String(raw ?? '')
    .trim()
    .replace(/[\s　]+/g, '')
    .replace(/\|/g, '_')
    .toLowerCase();

/**
 * イベント種別ごとの状態識別子（stateDisc）を3層共通ルールで生成
 * 直後に「シャンプー→コーミング」「+1分→+5分」「Bさん→Cさん」へ変更した際は stateDisc が変わるため握り潰されず通過する
 */
export const buildPeerEventStateDisc = (eventType, params = {}) => {
  const ev = normalizeSemanticToken(eventType);
  if (!ev) return '';
  const canonHelp = (p) => {
    const n = normalizeSemanticToken(p);
    return !n || n === 'ヘルプ' || n === 'ヘルプなし' || n === 'none' ? 'シャンプー' : n;
  };
  const canonCheck = (p) => {
    const n = normalizeSemanticToken(p);
    return n || 'チェック';
  };
  const canonUnassignNext = (staff, proc) => {
    const np = normalizeSemanticToken(proc);
    const ns = normalizeSemanticToken(staff);
    if (np === 'ヘルプなし' || ns === 'ヘルプなし' || ns === 'none') return 'ヘルプなし';
    if (!ns || ns === '未定') return 'none';
    return ns;
  };

  switch (ev) {
    case 'assign_assist':
      return `${normalizeSemanticToken(params.nextAssist)}:${canonHelp(params.helpProc)}`;
    case 'unassign_assist':
      return `${normalizeSemanticToken(params.prevAssist)}->${canonUnassignNext(params.nextAssist, params.nextHelpProc)}`;
    case 'assign_check':
      return `${normalizeSemanticToken(params.nextCheckStaff)}:${canonCheck(params.checkProc)}`;
    case 'unassign_check':
      return `${normalizeSemanticToken(params.prevCheckStaff)}->${canonUnassignNext(params.nextCheckStaff, '')}`;
    case 'recruit':
      return `${normalizeSemanticToken(params.recruitProc || params.helpProc || 'シャンプー')}`;
    case 'time_adjust':
    case 'timer_start':
    case 'assign_main':
      return `${Math.round((Number(params.nextEnd) || 0) / 5000)}`;
    case 'add_check':
      return `${Math.round((Number(params.nextCheckEnd) || 0) / 5000)}:${canonCheck(params.checkProc)}`;
    case 'status_change':
      return `${normalizeSemanticToken(params.procLabel || 'none')}:${normalizeSemanticToken(params.nextAssist || 'none')}`;
    case 'stop':
    case 'check_done':
      return 'stop';
    default:
      return normalizeSemanticToken(params.stateDisc || '');
  }
};

/**
 * UTF-8 バイト列に対する決定論的 FNV-1a 32bit ハッシュ（8文字16進数）
 * iPhone(JS) / Apple Watch(Swift) / Supabase Edge Function(Deno TS) で完全に同一の結果を返す
 */
const fnv1a32HexUtf8 = (input) => {
  const str = String(input || '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (code < 0x80) {
      hash ^= code;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    } else if (code < 0x800) {
      hash ^= 0xc0 | (code >> 6);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= 0x80 | (code & 0x3f);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    } else if (code < 0x10000) {
      hash ^= 0xe0 | (code >> 12);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= 0x80 | ((code >> 6) & 0x3f);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= 0x80 | (code & 0x3f);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    } else {
      hash ^= 0xf0 | (code >> 18);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= 0x80 | ((code >> 12) & 0x3f);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= 0x80 | ((code >> 6) & 0x3f);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= 0x80 | (code & 0x3f);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/**
 * APNs `apns-collapse-id` 制限（64バイトASCII以内）を100%満たす collapseId を生成
 * 形式: `at:<shortTimerId12>:<shortEvt12>:<hash8>`（最大37バイトASCII）
 */
export const buildExpoCollapseId = (timerId, eventType, stateDisc = '') => {
  const normTimer = normalizeSemanticToken(timerId);
  const normEvt = normalizeSemanticToken(eventType);
  const normDisc = normalizeSemanticToken(stateDisc);
  const shortTimer = normTimer.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'seat';
  const shortEvt = normEvt.replace(/[^a-z0-9_]/g, '').slice(0, 12) || 'evt';
  const hash8 = fnv1a32HexUtf8(`${normTimer}|${normEvt}|${normDisc}`);
  return `at:${shortTimer}:${shortEvt}:${hash8}`;
};

/**
 * イベント種別をロール系（'assist' | 'check' | 'timer' | ''）へ分類する（3層共通ルール）
 * A → B → A（45秒以内の再指名・再募集・再解除）で過去の semanticKey が再通知を握り潰さないよう、
 * 同一席・同一ロール系で状態（ev, stateDisc）が遷移した際に旧キーを即時無効化するために使用する。
 */
export const getPeerEventRoleFamily = (eventType) => {
  const ev = normalizeSemanticToken(eventType);
  switch (ev) {
    case 'assign_assist':
    case 'unassign_assist':
      return 'assist';
    case 'recruit':
      return 'recruit';
    case 'assign_check':
    case 'unassign_check':
    case 'recruit_check':
    case 'add_check':
    case 'check_done':
      return 'check';
    case 'timer_start':
    case 'time_adjust':
    case 'stop':
    case 'status_change':
    case 'shampoo':
    case 'combing':
    case 'check':
    case 'help_enter':
    case 'assign_main':
      return 'timer';
    default:
      return '';
  }
};

const parseSemanticKeyParts = (rawKey) => {
  const raw = String(rawKey || '').trim().toLowerCase();
  if (!raw) return null;
  const parts = raw.split('|');
  if (parts.length < 2) return null;
  const target = parts[0] || '';
  const ev = parts[1] || '';
  const actor = parts.length >= 3 ? (parts[2] || '') : '';
  const disc = parts.length >= 4 ? parts.slice(3).join('|') : '';
  if (!target || !ev) return null;
  return {
    target,
    ev,
    actor,
    disc,
    roleFamily: getPeerEventRoleFamily(ev),
  };
};

const parseDispatchedSemanticKeyParts = (rawKey) => {
  const raw = String(rawKey || '').trim();
  const pipeIdx = raw.indexOf('|');
  if (pipeIdx <= 0) return null;
  const salonIdPart = raw.slice(0, pipeIdx);
  const parsed = parseSemanticKeyParts(raw.slice(pipeIdx + 1));
  if (!parsed) return null;
  return { salonId: salonIdPart, ...parsed };
};

const ALL_HANDLED_SEMANTIC_MAPS = () => [
  _handledPushSemanticKeys,
  _handledRealtimeSemanticKeys,
  _handledOsBannerSemanticKeys,
  _handledWildcardPushSemanticKeys,
  _handledWildcardRealtimeSemanticKeys,
  _handledWildcardOsBannerSemanticKeys,
];

const purgeHandledMapsByTargetsAndFamily = (targetTokensSet, roleFamily, keepEvDiscPairs = new Set()) => {
  if (!roleFamily || !targetTokensSet || targetTokensSet.size === 0) return;
  for (const map of ALL_HANDLED_SEMANTIC_MAPS()) {
    for (const k of Array.from(map.keys())) {
      const p = parseSemanticKeyParts(k);
      if (!p || !targetTokensSet.has(p.target) || p.roleFamily !== roleFamily) continue;
      if (!keepEvDiscPairs.has(`${p.ev}|${p.disc}`)) {
        map.delete(k);
      }
    }
  }
};

const purgeDispatchedMapByTargetsAndFamily = (salonId, targetTokensSet, roleFamily, keepEvDiscPairs = new Set()) => {
  if (!roleFamily || !targetTokensSet || targetTokensSet.size === 0) return;
  const cleanSalonId = String(salonId || '').trim();
  for (const k of Array.from(_dispatchedSemanticKeyMap.keys())) {
    const p = parseDispatchedSemanticKeyParts(k);
    if (!p) continue;
    if (cleanSalonId && p.salonId !== cleanSalonId) continue;
    if (!targetTokensSet.has(p.target) || p.roleFamily !== roleFamily) continue;
    if (!keepEvDiscPairs.has(`${p.ev}|${p.disc}`)) {
      _dispatchedSemanticKeyMap.delete(k);
    }
  }
};

/**
 * 単発イベント到着時（または送信バッチ確定時）に、'recruit' ファミリーと 'assist' / 'check' ファミリー間の
 * 同一席・同一工程で相反する過去の semanticKey を相互に無効化する。
 * - assign_assist / assign_check (<staff>:<proc>) 到着時: 同一 <proc> の recruit / recruit_check を削除
 * - unassign_assist / unassign_check (<prev>-><next>) 到着時: <next> !== '募集中' なら recruit / recruit_check を削除
 * - recruit / recruit_check (<proc>) 到着時: 同一 <proc> の assign_assist / assign_check（別工程の担当キーは保護）および <next> !== '募集中' の unassign_* を削除
 */
const shouldDropCrossFamilySemanticKey = (incomingParsed, candidateParsed) => {
  if (!incomingParsed || !candidateParsed) return false;
  const inEv = incomingParsed.ev;
  const inDisc = incomingParsed.disc || '';
  const candEv = candidateParsed.ev;
  const candDisc = candidateParsed.disc || '';

  if (inEv === 'assign_assist' || inEv === 'assign_check') {
    const colonIdx = inDisc.indexOf(':');
    const proc = colonIdx >= 0 ? inDisc.slice(colonIdx + 1) : '';
    if (proc && (candEv === 'recruit' || candEv === 'recruit_check') && candDisc === proc) {
      return true;
    }
    return false;
  }

  if (inEv === 'unassign_assist' || inEv === 'unassign_check') {
    const arrowIdx = inDisc.indexOf('->');
    const nextPart = arrowIdx >= 0 ? inDisc.slice(arrowIdx + 2) : '';
    if (nextPart !== '募集中' && (candEv === 'recruit' || candEv === 'recruit_check')) {
      return true;
    }
    return false;
  }

  if (inEv === 'recruit' || inEv === 'recruit_check') {
    const proc = inDisc;
    if (proc && (candEv === 'assign_assist' || candEv === 'assign_check')) {
      const colonIdx = candDisc.indexOf(':');
      const candProc = colonIdx >= 0 ? candDisc.slice(colonIdx + 1) : '';
      if (candProc === proc) {
        return true;
      }
    }
    if (candEv === 'unassign_assist' || candEv === 'unassign_check') {
      const arrowIdx = candDisc.indexOf('->');
      const candNext = arrowIdx >= 0 ? candDisc.slice(arrowIdx + 2) : '';
      if (candNext !== '募集中') {
        return true;
      }
    }
    return false;
  }

  return false;
};

const purgeCrossFamilyHandledMapsByTargets = (targetTokensSet, incomingParsed) => {
  if (!incomingParsed || !targetTokensSet || targetTokensSet.size === 0) return;
  for (const map of ALL_HANDLED_SEMANTIC_MAPS()) {
    for (const k of Array.from(map.keys())) {
      const p = parseSemanticKeyParts(k);
      if (!p || !targetTokensSet.has(p.target)) continue;
      if (shouldDropCrossFamilySemanticKey(incomingParsed, p)) {
        map.delete(k);
      }
    }
  }
};

const purgeCrossFamilyDispatchedMapByTargets = (salonId, targetTokensSet, incomingParsed) => {
  if (!incomingParsed || !targetTokensSet || targetTokensSet.size === 0) return;
  const cleanSalonId = String(salonId || '').trim();
  for (const k of Array.from(_dispatchedSemanticKeyMap.keys())) {
    const p = parseDispatchedSemanticKeyParts(k);
    if (!p) continue;
    if (cleanSalonId && p.salonId !== cleanSalonId) continue;
    if (!targetTokensSet.has(p.target)) continue;
    if (shouldDropCrossFamilySemanticKey(incomingParsed, p)) {
      _dispatchedSemanticKeyMap.delete(k);
    }
  }
};

/**
 * 同一席・同一種別のイベント重複判定用セマンティックキーを生成
 * 形式: "<timerId>|<eventType>|<actorId>|<stateDisc>"（stateDisc 省略時は "<timerId>|<eventType>|<actorId>"）
 */
export const buildPeerEventSemanticKey = (timerIdOrLabel, eventType, actorId = '', stateDisc = '') => {
  const target = normalizeSemanticToken(timerIdOrLabel);
  const ev = normalizeSemanticToken(eventType);
  const actor = normalizeSemanticToken(actorId);
  const disc = normalizeSemanticToken(stateDisc);
  if (!target || !ev) return '';
  if (disc) {
    return `${target}|${ev}|${actor}|${disc}`;
  }
  return actor ? `${target}|${ev}|${actor}` : `${target}|${ev}`;
};

/**
 * セマンティックキーから完全一致キーと「片方の actorId 欠落時のみ 3.5秒間マッチする非対称ワイルドカードキー」を展開する。
 * 異なる非空 actorId 同士（例: 1次停止者Bと2次停止者A）は絶対に同一キーへ統合されない。
 */
const expandSemanticKeyVariants = (semanticKey) => {
  const raw = String(semanticKey || '').trim().toLowerCase();
  if (!raw) return { exactKeys: [], wildcardWriteKeys: [], wildcardReadKeys: [] };
  const parts = raw.split('|');
  const target = parts[0] || '';
  const ev = parts[1] || '';
  const actor = parts.length >= 3 ? (parts[2] || '') : '';
  const disc = parts.length >= 4 ? parts.slice(3).join('|') : '';
  if (!target || !ev) {
    return { exactKeys: [raw], wildcardWriteKeys: [], wildcardReadKeys: [] };
  }
  const exactKey = disc ? `${target}|${ev}|${actor}|${disc}` : (actor ? `${target}|${ev}|${actor}` : `${target}|${ev}`);
  const suffix = disc ? `|${disc}` : '';
  if (actor) {
    // 非空 actor 側: 書き込み時は actor欠落側だけが参照する `|?|` を記録し、読み取り時は actor欠落側が書いた `|*|` のみ照合する
    return {
      exactKeys: [exactKey],
      wildcardWriteKeys: [`${target}|${ev}|?${suffix}`],
      wildcardReadKeys: [`${target}|${ev}|*${suffix}`],
    };
  }
  // actor 欠落側: 書き込み時は全 actor から参照される `|*|` を記録し、読み取り時は `|*|` と `|?|` の両方を照合する
  return {
    exactKeys: [exactKey],
    wildcardWriteKeys: [`${target}|${ev}|*${suffix}`],
    wildcardReadKeys: [`${target}|${ev}|*${suffix}`, `${target}|${ev}|?${suffix}`],
  };
};

const isKeyFreshInMap = (map, key, now, ttlMs) => {
  const ts = map.get(key);
  return Boolean(ts && now - ts <= ttlMs);
};

/**
 * Realtime 側で既に同一イベント（notifId または semanticKey）を処理済みかどうかを副作用なしで照合する専用ヘルパー
 */
export const hasRealtimeHandledPeerNotification = ({ notifId = '', semanticKey = '' } = {}) => {
  const now = Date.now();
  if (notifId) {
    const ts = _handledNotifIds.get(String(notifId));
    if (ts && now - ts <= NOTIF_ID_TTL_MS) return true;
  }
  const { exactKeys, wildcardReadKeys } = expandSemanticKeyVariants(semanticKey);
  for (const key of exactKeys) {
    if (isKeyFreshInMap(_handledRealtimeSemanticKeys, key, now, SEMANTIC_KEY_TTL_MS)) return true;
  }
  for (const wKey of wildcardReadKeys) {
    if (isKeyFreshInMap(_handledWildcardRealtimeSemanticKeys, wKey, now, WILDCARD_SEMANTIC_KEY_TTL_MS)) {
      return true;
    }
  }
  return false;
};

/**
 * 指定した notifId またはセマンティックキーが既に処理済みかどうか判定
 */
export const hasHandledPeerNotification = ({ notifId = '', semanticKey = '', channel = 'any' } = {}) => {
  const now = Date.now();
  if (notifId) {
    const idStr = String(notifId);
    if (channel === 'os_banner' || channel === 'push_or_banner') {
      const bannerTs = _handledOsBannerNotifIds.get(idStr);
      if (bannerTs && now - bannerTs <= NOTIF_ID_TTL_MS) return true;
    } else {
      const ts = _handledNotifIds.get(idStr);
      if (ts && now - ts <= NOTIF_ID_TTL_MS) return true;
    }
  }
  const { exactKeys, wildcardReadKeys } = expandSemanticKeyVariants(semanticKey);
  for (const key of exactKeys) {
    if (channel === 'os_banner') {
      if (isKeyFreshInMap(_handledOsBannerSemanticKeys, key, now, SEMANTIC_KEY_TTL_MS)) return true;
    } else if (channel === 'push_or_banner') {
      if (
        isKeyFreshInMap(_handledPushSemanticKeys, key, now, SEMANTIC_KEY_TTL_MS) ||
        isKeyFreshInMap(_handledOsBannerSemanticKeys, key, now, SEMANTIC_KEY_TTL_MS)
      ) {
        return true;
      }
    } else if (channel === 'realtime') {
      if (isKeyFreshInMap(_handledPushSemanticKeys, key, now, SEMANTIC_KEY_TTL_MS)) return true;
    } else if (channel === 'push') {
      if (
        isKeyFreshInMap(_handledRealtimeSemanticKeys, key, now, SEMANTIC_KEY_TTL_MS) ||
        isKeyFreshInMap(_handledPushSemanticKeys, key, now, SEMANTIC_KEY_TTL_MS)
      ) {
        return true;
      }
    } else if (
      isKeyFreshInMap(_handledPushSemanticKeys, key, now, SEMANTIC_KEY_TTL_MS) ||
      isKeyFreshInMap(_handledRealtimeSemanticKeys, key, now, SEMANTIC_KEY_TTL_MS) ||
      isKeyFreshInMap(_handledOsBannerSemanticKeys, key, now, SEMANTIC_KEY_TTL_MS)
    ) {
      return true;
    }
  }
  for (const wKey of wildcardReadKeys) {
    if (channel === 'os_banner') {
      if (isKeyFreshInMap(_handledWildcardOsBannerSemanticKeys, wKey, now, WILDCARD_SEMANTIC_KEY_TTL_MS)) return true;
    } else if (channel === 'push_or_banner') {
      if (
        isKeyFreshInMap(_handledWildcardPushSemanticKeys, wKey, now, WILDCARD_SEMANTIC_KEY_TTL_MS) ||
        isKeyFreshInMap(_handledWildcardOsBannerSemanticKeys, wKey, now, WILDCARD_SEMANTIC_KEY_TTL_MS)
      ) {
        return true;
      }
    } else if (channel === 'realtime') {
      if (isKeyFreshInMap(_handledWildcardPushSemanticKeys, wKey, now, WILDCARD_SEMANTIC_KEY_TTL_MS)) return true;
    } else if (channel === 'push') {
      if (
        isKeyFreshInMap(_handledWildcardRealtimeSemanticKeys, wKey, now, WILDCARD_SEMANTIC_KEY_TTL_MS) ||
        isKeyFreshInMap(_handledWildcardPushSemanticKeys, wKey, now, WILDCARD_SEMANTIC_KEY_TTL_MS)
      ) {
        return true;
      }
    } else if (
      isKeyFreshInMap(_handledWildcardPushSemanticKeys, wKey, now, WILDCARD_SEMANTIC_KEY_TTL_MS) ||
      isKeyFreshInMap(_handledWildcardRealtimeSemanticKeys, wKey, now, WILDCARD_SEMANTIC_KEY_TTL_MS) ||
      isKeyFreshInMap(_handledWildcardOsBannerSemanticKeys, wKey, now, WILDCARD_SEMANTIC_KEY_TTL_MS)
    ) {
      return true;
    }
  }
  return false;
};

const extractSeatRoleStateForSemanticPurge = (seat) => {
  if (!seat || typeof seat !== 'object') return null;
  const rawSeatNum = Number(seat.seatNumber ?? seat.number ?? 0);
  const labelMatch = String(seat.seatLabel ?? seat.seat_label ?? '').match(/(\d+)/);
  const seatNum = rawSeatNum > 0 ? rawSeatNum : (labelMatch ? parseInt(labelMatch[1], 10) : 0);
  const rawLabel = String(seat.seatLabel ?? seat.seat_label ?? (seatNum > 0 ? `${seatNum}番席` : '')).trim();
  const targetEnd = Number(seat.targetEndTimestamp ?? seat.target_end_timestamp ?? seat.endTime ?? 0) || 0;
  const isRunning =
    typeof seat.isRunning === 'boolean'
      ? seat.isRunning && targetEnd > 0
      : String(seat.status || '') === 'running' && targetEnd > 0;

  const rawAssistField = String(
    seat.assistantStaffName ?? seat.assistant_staff_name ?? seat.shampooStaff ?? ''
  ).trim();
  const rawHelpProc = String(seat.helpProcess ?? seat.help_process ?? '').trim();
  const isNoHelp =
    Boolean(seat.isNoHelpNeeded) ||
    rawAssistField === 'ヘルプなし' ||
    rawAssistField === 'none' ||
    rawHelpProc === 'ヘルプなし' ||
    rawHelpProc === 'none';
  const isRecruiting =
    !isNoHelp && (Boolean(seat.isRecruiting) || rawAssistField === '募集中');
  const rawAssist = isNoHelp
    ? 'ヘルプなし'
    : isRecruiting
      ? '募集中'
      : rawAssistField;
  const isConcreteAssist =
    Boolean(rawAssist) &&
    rawAssist !== '未定' &&
    rawAssist !== '募集中' &&
    rawAssist !== 'ヘルプなし' &&
    rawAssist !== 'none' &&
    rawAssist !== 'スタイリスト' &&
    rawAssist !== 'スタッフ';
  const assistToken = isNoHelp
    ? 'ヘルプなし'
    : isRecruiting
      ? '募集中'
      : isConcreteAssist
        ? normalizeSemanticToken(rawAssist)
        : '';
  const helpProcToken = normalizeSemanticToken(
    !rawHelpProc || rawHelpProc === 'ヘルプ' || rawHelpProc === 'ヘルプなし' || rawHelpProc === 'none'
      ? 'シャンプー'
      : rawHelpProc
  );

  const checkEnd =
    Number(
      seat.checkEndTimestamp ??
        seat.checkTargetEndTimestamp ??
        seat.check_target_end_timestamp ??
        seat.nextCheckEndTime ??
        0
    ) || 0;
  const checkTotal =
    Number(
      seat.checkTargetSeconds ??
        seat.checkTotalSeconds ??
        seat.check_total_seconds ??
        seat.checkInterval ??
        0
    ) || 0;
  const isCheckCompleted =
    Boolean(seat.isCheckCompleted) || String(seat.checkStatus || '') === 'completed';
  const hasCheck = isRunning && !isCheckCompleted && (checkEnd > 0 || checkTotal > 0);
  const rawCheckStaff = String(
    seat.checkStaffName ?? seat.check_staff_name ?? seat.checkStaff ?? ''
  ).trim();
  const rawCheckProc = String(seat.checkProcess ?? seat.check_process ?? 'チェック').trim() || 'チェック';
  const isConcreteCheck =
    hasCheck &&
    Boolean(rawCheckStaff) &&
    rawCheckStaff !== '未定' &&
    rawCheckStaff !== '募集中' &&
    rawCheckStaff !== 'ヘルプなし' &&
    rawCheckStaff !== 'none' &&
    rawCheckStaff !== 'スタイリスト' &&
    rawCheckStaff !== 'スタッフ';
  const checkToken = !hasCheck
    ? ''
    : rawCheckStaff === '募集中'
      ? '募集中'
      : isConcreteCheck
        ? normalizeSemanticToken(rawCheckStaff)
        : 'unset';
  const checkProcToken = normalizeSemanticToken(rawCheckProc || 'チェック');

  const isShampooing = Boolean(seat.isShampooing ?? seat.is_shampooing);
  const actionStatus = String(seat.actionStatus ?? seat.action_status ?? '').trim();
  let actionProcLabel = '';
  if (!isRunning) {
    if (actionStatus === 'call' || rawHelpProc === '呼び出し') {
      actionProcLabel = '呼び出し';
    } else if (isShampooing || actionStatus === 'shampoo' || rawHelpProc === 'シャンプー') {
      actionProcLabel = 'シャンプー';
    } else if (actionStatus === 'combing' || rawHelpProc === 'コーミング') {
      actionProcLabel = 'コーミング';
    } else if (rawHelpProc && rawHelpProc !== 'ヘルプなし' && rawHelpProc !== 'none') {
      actionProcLabel = rawHelpProc;
    }
  }

  const rawColorStaff = String(
    seat.colorStaffName ?? seat.color_staff_name ?? seat.creatorName ?? ''
  ).trim();
  const colorStaffToken = normalizeSemanticToken(rawColorStaff);

  const targets = new Set();
  [
    seat.id,
    seat.cloudTimerId,
    rawLabel,
    seatNum > 0 ? `seat-${seatNum}` : '',
    seatNum > 0 ? `${seatNum}番席` : '',
  ].forEach((cand) => {
    const norm = normalizeSemanticToken(cand);
    if (norm) targets.add(norm);
  });

  return {
    targets,
    isRunning,
    targetEnd,
    rawAssist,
    rawAssistForUnassign: isNoHelp ? 'ヘルプなし' : (isConcreteAssist ? rawAssist : ''),
    rawHelpProc,
    rawHelpProcForUnassign: isNoHelp ? 'ヘルプなし' : rawHelpProc,
    isConcreteAssist,
    assistToken,
    helpProcToken,
    hasCheck,
    checkEnd,
    rawCheckStaff,
    rawCheckProc,
    isConcreteCheck,
    checkToken,
    checkProcToken,
    actionProcLabel,
    colorStaffToken,
  };
};

/**
 * 席の状態遷移（Realtime / ポーリング / Push fast-path / ローカル操作）が起きた際、
 * 同一席・同一ロール系（assist / check / timer）で現在の状態（および直前→現在の解除遷移）と一致しない
 * 過去の semanticKey を即時削除する。
 * これにより 45秒以内に「A → B → A」「募集 → B → 再募集」「解除 → A → 再解除」が発生しても
 * 第3者端末を含む全端末で過去のキーに握り潰されず確実に再通知される。
 */
export const purgeStaleSemanticKeysForSeatState = (prevSeat, nextSeat, { salonId = '' } = {}) => {
  const prevState = extractSeatRoleStateForSemanticPurge(prevSeat);
  const nextState = extractSeatRoleStateForSemanticPurge(nextSeat);
  if (!nextState) return;

  const targetTokensSet = new Set(nextState.targets);
  if (prevState) {
    prevState.targets.forEach((t) => targetTokensSet.add(t));
  }
  if (targetTokensSet.size === 0) return;

  const assistChanged =
    !prevState ||
    prevState.assistToken !== nextState.assistToken ||
    prevState.helpProcToken !== nextState.helpProcToken ||
    prevState.isRunning !== nextState.isRunning;

  if (assistChanged) {
    const keepAssistPairs = new Set();
    if (nextState.isRunning && nextState.isConcreteAssist) {
      keepAssistPairs.add(
        `assign_assist|${buildPeerEventStateDisc('assign_assist', {
          nextAssist: nextState.rawAssist,
          helpProc: nextState.rawHelpProc || 'シャンプー',
        })}`
      );
    }
    if (
      prevState &&
      prevState.isRunning &&
      nextState.isRunning &&
      prevState.isConcreteAssist &&
      prevState.assistToken !== nextState.assistToken
    ) {
      keepAssistPairs.add(
        `unassign_assist|${buildPeerEventStateDisc('unassign_assist', {
          prevAssist: prevState.rawAssist,
          nextAssist: nextState.rawAssistForUnassign,
          nextHelpProc: nextState.rawHelpProcForUnassign,
        })}`
      );
    }
    purgeHandledMapsByTargetsAndFamily(targetTokensSet, 'assist', keepAssistPairs);
    purgeDispatchedMapByTargetsAndFamily(salonId, targetTokensSet, 'assist', keepAssistPairs);
  }

  const recruitChanged =
    assistChanged ||
    !prevState ||
    (prevState.checkToken === '募集中') !== (nextState.checkToken === '募集中') ||
    (nextState.checkToken === '募集中' && prevState.checkProcToken !== nextState.checkProcToken);

  if (recruitChanged) {
    const keepRecruitPairs = new Set();
    if (nextState.isRunning) {
      if (nextState.assistToken === '募集中') {
        keepRecruitPairs.add(
          `recruit|${buildPeerEventStateDisc('recruit', { recruitProc: nextState.rawHelpProc || 'シャンプー' })}`
        );
      }
      if (nextState.checkToken === '募集中') {
        keepRecruitPairs.add(
          `recruit|${buildPeerEventStateDisc('recruit', { recruitProc: nextState.rawCheckProc || 'チェック' })}`
        );
      }
    }
    purgeHandledMapsByTargetsAndFamily(targetTokensSet, 'recruit', keepRecruitPairs);
    purgeDispatchedMapByTargetsAndFamily(salonId, targetTokensSet, 'recruit', keepRecruitPairs);
  }

  const checkChanged =
    !prevState ||
    prevState.hasCheck !== nextState.hasCheck ||
    prevState.checkToken !== nextState.checkToken ||
    prevState.checkProcToken !== nextState.checkProcToken ||
    Math.abs((prevState.checkEnd || 0) - (nextState.checkEnd || 0)) >= 5000;

  if (checkChanged) {
    const keepCheckPairs = new Set();
    if (nextState.hasCheck) {
      keepCheckPairs.add(
        `add_check|${buildPeerEventStateDisc('add_check', {
          nextCheckEnd: nextState.checkEnd,
          checkProc: nextState.rawCheckProc,
        })}`
      );
      if (nextState.isConcreteCheck) {
        keepCheckPairs.add(
          `assign_check|${buildPeerEventStateDisc('assign_check', {
            nextCheckStaff: nextState.rawCheckStaff,
            checkProc: nextState.rawCheckProc,
          })}`
        );
      } else if (nextState.checkToken === '募集中') {
        keepCheckPairs.add(`recruit_check|${normalizeSemanticToken(nextState.rawCheckProc || 'チェック')}`);
      }
    }
    if (prevState && prevState.hasCheck && !nextState.hasCheck) {
      keepCheckPairs.add('check_done|stop');
    }
    if (
      prevState &&
      prevState.hasCheck &&
      nextState.hasCheck &&
      prevState.isConcreteCheck &&
      prevState.checkToken !== nextState.checkToken
    ) {
      keepCheckPairs.add(
        `unassign_check|${buildPeerEventStateDisc('unassign_check', {
          prevCheckStaff: prevState.rawCheckStaff,
          nextCheckStaff: nextState.isConcreteCheck ? nextState.rawCheckStaff : '',
        })}`
      );
    }
    purgeHandledMapsByTargetsAndFamily(targetTokensSet, 'check', keepCheckPairs);
    purgeDispatchedMapByTargetsAndFamily(salonId, targetTokensSet, 'check', keepCheckPairs);
  }

  const timerChanged =
    !prevState ||
    prevState.isRunning !== nextState.isRunning ||
    Math.abs((prevState.targetEnd || 0) - (nextState.targetEnd || 0)) >= 5000 ||
    prevState.actionProcLabel !== nextState.actionProcLabel ||
    prevState.colorStaffToken !== nextState.colorStaffToken;

  if (timerChanged) {
    const keepTimerPairs = new Set();
    if (nextState.isRunning) {
      const endDisc = buildPeerEventStateDisc('timer_start', { nextEnd: nextState.targetEnd });
      keepTimerPairs.add(`timer_start|${endDisc}`);
      keepTimerPairs.add(`time_adjust|${endDisc}`);
      keepTimerPairs.add(`assign_main|${endDisc}`);
    } else {
      keepTimerPairs.add('stop|stop');
      if (nextState.actionProcLabel) {
        keepTimerPairs.add(
          `status_change|${buildPeerEventStateDisc('status_change', {
            procLabel: nextState.actionProcLabel,
            nextAssist: nextState.rawAssist,
          })}`
        );
      }
    }
    purgeHandledMapsByTargetsAndFamily(targetTokensSet, 'timer', keepTimerPairs);
    purgeDispatchedMapByTargetsAndFamily(salonId, targetTokensSet, 'timer', keepTimerPairs);
  }
};

/**
 * notifId およびセマンティックキーを処理済みとして記録
 */
export const markPeerNotificationHandled = ({ notifId = '', semanticKey = '', channel = 'any' } = {}) => {
  const now = Date.now();
  const parsedIncoming = parseSemanticKeyParts(semanticKey);
  if (parsedIncoming && parsedIncoming.roleFamily) {
    const targetSet = new Set([parsedIncoming.target]);
    purgeHandledMapsByTargetsAndFamily(
      targetSet,
      parsedIncoming.roleFamily,
      new Set([`${parsedIncoming.ev}|${parsedIncoming.disc}`])
    );
    purgeCrossFamilyHandledMapsByTargets(targetSet, parsedIncoming);
  }
  if (notifId) {
    const idStr = String(notifId);
    if (channel === 'os_banner') {
      _handledOsBannerNotifIds.set(idStr, now);
      pruneMapByTtl(_handledOsBannerNotifIds, NOTIF_ID_TTL_MS, 150);
    } else if (channel === 'push' || channel === 'realtime') {
      _handledNotifIds.set(idStr, now);
      pruneMapByTtl(_handledNotifIds, NOTIF_ID_TTL_MS, 150);
    } else {
      _handledNotifIds.set(idStr, now);
      _handledOsBannerNotifIds.set(idStr, now);
      pruneMapByTtl(_handledNotifIds, NOTIF_ID_TTL_MS, 150);
      pruneMapByTtl(_handledOsBannerNotifIds, NOTIF_ID_TTL_MS, 150);
    }
  }
  const { exactKeys, wildcardWriteKeys } = expandSemanticKeyVariants(semanticKey);
  if (exactKeys.length > 0) {
    if (channel === 'os_banner') {
      exactKeys.forEach((k) => _handledOsBannerSemanticKeys.set(k, now));
      wildcardWriteKeys.forEach((k) => _handledWildcardOsBannerSemanticKeys.set(k, now));
      pruneMapByTtl(_handledOsBannerSemanticKeys, SEMANTIC_KEY_TTL_MS, 150);
      pruneMapByTtl(_handledWildcardOsBannerSemanticKeys, WILDCARD_SEMANTIC_KEY_TTL_MS, 150);
    } else if (channel === 'push') {
      exactKeys.forEach((k) => _handledPushSemanticKeys.set(k, now));
      wildcardWriteKeys.forEach((k) => _handledWildcardPushSemanticKeys.set(k, now));
      pruneMapByTtl(_handledPushSemanticKeys, SEMANTIC_KEY_TTL_MS, 150);
      pruneMapByTtl(_handledWildcardPushSemanticKeys, WILDCARD_SEMANTIC_KEY_TTL_MS, 150);
    } else if (channel === 'realtime') {
      exactKeys.forEach((k) => _handledRealtimeSemanticKeys.set(k, now));
      wildcardWriteKeys.forEach((k) => _handledWildcardRealtimeSemanticKeys.set(k, now));
      pruneMapByTtl(_handledRealtimeSemanticKeys, SEMANTIC_KEY_TTL_MS, 150);
      pruneMapByTtl(_handledWildcardRealtimeSemanticKeys, WILDCARD_SEMANTIC_KEY_TTL_MS, 150);
    } else {
      exactKeys.forEach((k) => {
        _handledPushSemanticKeys.set(k, now);
        _handledRealtimeSemanticKeys.set(k, now);
        _handledOsBannerSemanticKeys.set(k, now);
      });
      wildcardWriteKeys.forEach((k) => {
        _handledWildcardPushSemanticKeys.set(k, now);
        _handledWildcardRealtimeSemanticKeys.set(k, now);
        _handledWildcardOsBannerSemanticKeys.set(k, now);
      });
      pruneMapByTtl(_handledPushSemanticKeys, SEMANTIC_KEY_TTL_MS, 150);
      pruneMapByTtl(_handledRealtimeSemanticKeys, SEMANTIC_KEY_TTL_MS, 150);
      pruneMapByTtl(_handledOsBannerSemanticKeys, SEMANTIC_KEY_TTL_MS, 150);
      pruneMapByTtl(_handledWildcardPushSemanticKeys, WILDCARD_SEMANTIC_KEY_TTL_MS, 150);
      pruneMapByTtl(_handledWildcardRealtimeSemanticKeys, WILDCARD_SEMANTIC_KEY_TTL_MS, 150);
      pruneMapByTtl(_handledWildcardOsBannerSemanticKeys, WILDCARD_SEMANTIC_KEY_TTL_MS, 150);
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
      if (finalStatus !== 'granted' && AppState.currentState === 'active') {
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

// ★ クライアント主導ダイレクト Expo Push 通知配信用の重複排除キャッシュ＆サロンメンバーキャッシュ
const _dispatchedSemanticKeyMap = new Map();
const _salonMembersCacheBySalon = new Map();

const normalizeNameForPushMatch = (raw) =>
  String(raw || '')
    .trim()
    .replace(/[\s　]+/g, '')
    .toLowerCase();

const isValidStaffNameForPush = (raw) => {
  const s = String(raw || '').trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (s === '募集中' || s === 'ヘルプなし' || lower === 'none' || s === '未定') return false;
  return true;
};

const isConcreteStaffNameForPush = (raw) => {
  if (!isValidStaffNameForPush(raw)) return false;
  const s = String(raw || '').trim();
  return s !== 'スタイリスト' && s !== '自分' && s !== 'あなた';
};

const parseSeatNumberFromPushLabel = (label, fallbackNum = 0) => {
  const num = Number(fallbackNum);
  if (Number.isFinite(num) && num > 0) return Math.round(num);
  const m = String(label || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
};

const normalizeSeatSnapshotForPush = (seat, fallbackActorId = '') => {
  if (!seat || typeof seat !== 'object') return null;
  const rawLabel = String(seat.seatLabel ?? seat.seat_label ?? '').trim();
  const seatNumber = parseSeatNumberFromPushLabel(rawLabel, seat.seatNumber ?? seat.seat_number ?? 0);
  const seatLabel = rawLabel
    ? (rawLabel.endsWith('席') || !/^\d+番$/.test(rawLabel) ? rawLabel : `${rawLabel}席`)
    : (seatNumber > 0 ? `${seatNumber}番席` : '客席');
  const rawStatus = String(seat.status ?? (seat.isRunning ? 'running' : 'paused')).trim();
  const targetEndTimestamp = Number(seat.targetEndTimestamp ?? seat.target_end_timestamp ?? 0) || 0;
  const status = rawStatus === 'running' && targetEndTimestamp > 0 ? 'running' : 'paused';
  const targetSeconds = Number(seat.targetSeconds ?? seat.totalSeconds ?? seat.target_seconds ?? 0) || 0;
  const pausedRemainingSeconds = Number(seat.pausedRemainingSeconds ?? seat.paused_remaining_seconds ?? 0) || 0;
  const createdBy = String(seat.createdBy ?? seat.created_by ?? '').trim() || null;
  const colorStaffName = String(seat.colorStaffName ?? seat.color_staff_name ?? seat.creatorName ?? '').trim() || null;
  const rawAssist = String(
    seat.assistantStaffName ??
      seat.assistant_staff_name ??
      (seat.isRecruiting ? '募集中' : seat.isNoHelpNeeded ? 'ヘルプなし' : seat.shampooStaff ?? '')
  ).trim();
  const assistantStaffName = rawAssist || null;
  const rawHelpProc = String(
    seat.helpProcess ??
      seat.help_process ??
      (seat.isNoHelpNeeded ? 'ヘルプなし' : '')
  ).trim();
  const helpProcess = rawHelpProc || null;
  const actionStatus = String(seat.actionStatus ?? seat.action_status ?? 'normal').trim() || 'normal';
  const isShampooing = Boolean(
    seat.isShampooing ??
      seat.is_shampooing ??
      (status !== 'running' && (actionStatus === 'shampoo' || helpProcess === 'シャンプー'))
  );
  const checkTargetEndTimestamp =
    Number(seat.checkTargetEndTimestamp ?? seat.check_target_end_timestamp ?? seat.checkEndTimestamp ?? 0) || null;
  const checkTotalSeconds =
    Number(seat.checkTotalSeconds ?? seat.check_total_seconds ?? seat.checkTargetSeconds ?? 0) || null;
  const checkProcess = String(seat.checkProcess ?? seat.check_process ?? '').trim() || null;
  const checkStaffName = String(seat.checkStaffName ?? seat.check_staff_name ?? seat.checkStaff ?? '').trim() || null;
  const updatedBy = String(seat.updatedBy ?? seat.updated_by ?? fallbackActorId ?? '').trim() || null;

  return {
    id: String(seat.id || (seatNumber > 0 ? `seat-${seatNumber}` : 'seat-unknown')),
    seatNumber,
    seatLabel,
    status,
    targetSeconds,
    targetEndTimestamp,
    pausedRemainingSeconds,
    createdBy,
    colorStaffName,
    assistantStaffName,
    helpProcess,
    isShampooing,
    actionStatus,
    checkTargetEndTimestamp,
    checkTotalSeconds,
    checkProcess,
    checkStaffName,
    updatedBy,
    updatedAt: Date.now(),
  };
};

/**
 * 客席タイマーの状態変化（開始・停止・指名・募集・チェック完了・工程移行・時間変更）を検知し、
 * クライアントから直接 Expo Push API（+ Edge Function フォールバック）へ即時配信する。
 * DB トリガー（pg_net）が未設定／URL不一致の環境でも、別デバイス・バックグラウンドWatchへ100%通知を届ける。
 */
export const dispatchSalonTimerEventPush = async ({
  salonId,
  actorUserId = null,
  actorName = '',
  prevSeat = null,
  nextSeat = null,
  staffMembers = [],
}) => {
  if (!salonId || !nextSeat) return { sent: 0 };

  try {
    let resolvedActorId = actorUserId ? String(actorUserId).trim() : '';
    if (!resolvedActorId) {
      const uid = await getOrCreateUserId();
      resolvedActorId = uid ? String(uid).trim() : '';
    }

    const prev = prevSeat ? normalizeSeatSnapshotForPush(prevSeat) : null;
    const next = normalizeSeatSnapshotForPush(nextSeat, resolvedActorId);
    if (!next) return { sent: 0 };

    // 状態遷移時点で同一席・同一ロール系の古い semanticKey を即時無効化（A→自分→A 等で中間イベントが送信0件になるケースも含め完全解放）
    purgeStaleSemanticKeysForSeatState(prev, next, { salonId });

    // サロンメンバー一覧を取得（15秒メモリキャッシュ＋forceRefresh対応＋引数 staffMembers のカスタム呼び名統合）
    const nowMs = Date.now();
    let usedCachedMembers = false;
    const fetchSalonMembersMap = async (targetSalonId, { forceRefresh = false } = {}) => {
      const cached = _salonMembersCacheBySalon.get(targetSalonId);
      if (!forceRefresh && cached && Date.now() - cached.at < 15000 && Array.isArray(cached.rows)) {
        usedCachedMembers = true;
        return cached.rows;
      }
      const { data: rows } = await supabase
        .from('salon_members')
        .select('user_id, display_name')
        .eq('salon_id', targetSalonId);
      if (Array.isArray(rows)) {
        _salonMembersCacheBySalon.set(targetSalonId, { at: Date.now(), rows });
        return rows;
      }
      return Array.isArray(cached?.rows) ? cached.rows : [];
    };
    let dbMembers = await fetchSalonMembersMap(salonId, { forceRefresh: false });

    // ローカル保存のスタッフ一覧（カスタム呼び名・user_id対応表）も補完参照
    let effectiveStaffMembers = Array.isArray(staffMembers) && staffMembers.length > 0 ? staffMembers : [];
    if (effectiveStaffMembers.length === 0) {
      try {
        const rawLocalStaff = await AsyncStorage.getItem('@salon_staff_members');
        if (rawLocalStaff) {
          const parsedStaff = JSON.parse(rawLocalStaff);
          if (Array.isArray(parsedStaff)) {
            effectiveStaffMembers = parsedStaff;
          }
        }
      } catch {}
    }

    // user_id ごとの全呼び名セットを構築
    const aliasesByUserId = new Map();
    const addAliasForUser = (uid, nameCandidate) => {
      const cleanUid = String(uid || '').trim();
      const normName = normalizeNameForPushMatch(nameCandidate);
      if (!cleanUid || !normName || normName === 'スタイリスト' || normName === '自分' || normName === 'あなた') return;
      if (!aliasesByUserId.has(cleanUid)) {
        aliasesByUserId.set(cleanUid, new Set());
      }
      aliasesByUserId.get(cleanUid).add(normName);
    };

    const allMemberIds = new Set();
    dbMembers.forEach((m) => {
      const uid = String(m?.user_id || '').trim();
      if (uid) {
        allMemberIds.add(uid);
        addAliasForUser(uid, m?.display_name);
      }
    });
    if (Array.isArray(effectiveStaffMembers)) {
      effectiveStaffMembers.forEach((m) => {
        if (!m || typeof m !== 'object') return;
        const uid = String(m.user_id || m.userId || m.id || '').trim();
        if (uid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid)) {
          allMemberIds.add(uid);
          addAliasForUser(uid, m.name);
          addAliasForUser(uid, m.display_name);
          addAliasForUser(uid, m.originalNickname);
          addAliasForUser(uid, m.customNickname);
        }
      });
    }
    if (resolvedActorId) {
      allMemberIds.add(resolvedActorId);
      addAliasForUser(resolvedActorId, actorName);
    }

    // 15秒キャッシュ参照時に、指名・解除対象の具体的なスタッフ名が未解決であれば一度だけ最新メンバーを再取得して補完
    const candidateConcreteNames = [
      prev?.assistantStaffName,
      next.assistantStaffName,
      prev?.checkStaffName,
      next.checkStaffName,
      prev?.colorStaffName,
      next.colorStaffName,
    ].filter((n) => isConcreteStaffNameForPush(n));
    const hasUnmatchedConcreteName = candidateConcreteNames.some((n) => {
      const tNorm = normalizeNameForPushMatch(n);
      if (!tNorm) return false;
      for (const aliasSet of aliasesByUserId.values()) {
        if (aliasSet.has(tNorm)) return false;
      }
      return true;
    });
    if (usedCachedMembers && hasUnmatchedConcreteName) {
      dbMembers = await fetchSalonMembersMap(salonId, { forceRefresh: true });
      dbMembers.forEach((m) => {
        const uid = String(m?.user_id || '').trim();
        if (uid) {
          allMemberIds.add(uid);
          addAliasForUser(uid, m?.display_name);
        }
      });
    }

    const actorNormName = normalizeNameForPushMatch(actorName);
    const isStaffNameSelf = (staffName) => {
      const norm = normalizeNameForPushMatch(staffName);
      if (!norm) return false;
      if (norm === '自分' || norm === 'あなた') return true;
      if (actorNormName && actorNormName !== 'スタイリスト' && norm === actorNormName) return true;
      if (resolvedActorId && aliasesByUserId.get(resolvedActorId)?.has(norm)) return true;
      return false;
    };

    const resolveStaffUserIds = (staffName) => {
      if (!isValidStaffNameForPush(staffName)) return { ids: [], unresolved: false };
      if (!isConcreteStaffNameForPush(staffName)) return { ids: [], unresolved: false };
      const targetNorm = normalizeNameForPushMatch(staffName);
      if (!targetNorm) return { ids: [], unresolved: false };
      const matched = [];
      for (const [uid, aliasSet] of aliasesByUserId.entries()) {
        if (aliasSet.has(targetNorm)) {
          matched.push(uid);
        }
      }
      if (matched.length > 0) {
        return { ids: matched, unresolved: false };
      }
      if (isStaffNameSelf(staffName)) {
        return { ids: resolvedActorId ? [resolvedActorId] : [], unresolved: false };
      }
      // 自分以外の具体的なスタッフ名が指定されているのに user_id に解決できない場合は unresolved: true としてサロン全員フォールバック対象にする
      return { ids: [], unresolved: true };
    };

    let allOtherMemberIds = Array.from(allMemberIds).filter((uid) => uid && uid !== resolvedActorId);

    const collectTargetUserIds = (staffNames = [], explicitUserIds = [], fallbackAllWhenUnresolved = true) => {
      const targets = new Set();
      let hasUnresolved = false;
      explicitUserIds.forEach((uid) => {
        const clean = String(uid || '').trim();
        if (clean) targets.add(clean);
      });
      staffNames.forEach((name) => {
        if (!isValidStaffNameForPush(name)) return;
        const { ids, unresolved } = resolveStaffUserIds(name);
        ids.forEach((id) => targets.add(id));
        if (unresolved) hasUnresolved = true;
      });
      if (hasUnresolved && fallbackAllWhenUnresolved) {
        allOtherMemberIds.forEach((id) => targets.add(id));
      }
      if (resolvedActorId) {
        targets.delete(resolvedActorId);
      }
      return {
        ids: Array.from(targets),
        hasUnresolved,
      };
    };

    const seatLabel = next.seatLabel || '客席';
    const timerId = String(next.id || `seat-${next.seatNumber || 0}`);
    const cleanActorName = String(actorName || '').trim();
    const actorDisplay =
      cleanActorName && cleanActorName !== 'スタイリスト' && cleanActorName !== '自分' && cleanActorName !== 'あなた'
        ? cleanActorName
        : '';
    const actorLabel = actorDisplay ? `${actorDisplay}さんが` : '';

    const prevStatus = String(prev?.status || 'paused');
    const nextStatus = String(next.status || 'paused');
    const prevEnd = Number(prev?.targetEndTimestamp || 0);
    const nextEnd = Number(next.targetEndTimestamp || 0);
    const prevTargetSec = Number(prev?.targetSeconds || 0);
    const nextTargetSec = Number(next.targetSeconds || 0);

    const prevCheckEnd = Number(prev?.checkTargetEndTimestamp || 0);
    const nextCheckEnd = Number(next.checkTargetEndTimestamp || 0);
    const nextCheckTotal = Number(next.checkTotalSeconds || 0);
    const prevHadCheck = prevCheckEnd > 0;
    const nextHasCheck = nextCheckEnd > 0;

    const prevAssist = String(prev?.assistantStaffName || '').trim();
    const nextAssist = String(next.assistantStaffName || '').trim();
    const prevHelpProc = String(prev?.helpProcess || '').trim();
    const nextHelpProc = String(next.helpProcess || '').trim();
    const prevCheckStaff = String(prev?.checkStaffName || '').trim();
    const nextCheckStaff = String(next.checkStaffName || '').trim();
    const prevColorStaff = String(prev?.colorStaffName || '').trim();
    const nextColorStaff = String(next.colorStaffName || '').trim();

    // 具体的な個人スタッフ名に未解決がある場合、15秒キャッシュによる取りこぼしを防ぐため一度だけ最新 salon_members を再取得して解決を試みる
    const namedCandidates = [
      prevAssist,
      nextAssist,
      prevCheckStaff,
      nextCheckStaff,
      prevColorStaff,
      nextColorStaff,
    ].filter((n) => isConcreteStaffNameForPush(n));
    if (namedCandidates.some((n) => resolveStaffUserIds(n).unresolved)) {
      const refreshedMembers = await fetchSalonMembersMap(salonId, { forceRefresh: true });
      refreshedMembers.forEach((m) => {
        const uid = String(m?.user_id || '').trim();
        if (!uid) return;
        allMemberIds.add(uid);
        addAliasForUser(uid, m?.display_name);
      });
      allOtherMemberIds = Array.from(allMemberIds).filter((uid) => uid && uid !== resolvedActorId);
    }
    const prevIsShampooing = Boolean(prev?.isShampooing);
    const nextIsShampooing = Boolean(next.isShampooing);
    const checkProc = String(next.checkProcess || prev?.checkProcess || 'チェック').trim() || 'チェック';
    const helpProc = nextHelpProc && nextHelpProc !== 'ヘルプなし' && nextHelpProc !== 'none' ? nextHelpProc : 'シャンプー';

    const isNewStart =
      nextStatus === 'running' &&
      nextEnd > 0 &&
      (prevStatus !== 'running' || (prevEnd > 0 && Math.abs(nextEnd - prevEnd) > 60000 && nextTargetSec !== prevTargetSec));

    const hasUnknownOtherCreator =
      !prev?.createdBy &&
      !next.createdBy &&
      (!nextColorStaff || nextColorStaff === 'スタイリスト') &&
      (!prevColorStaff || prevColorStaff === 'スタイリスト');

    const formatRemainingSuffix = (targetTs) => {
      const ts = Number(targetTs || 0);
      if (!(ts > 0)) return '';
      if (ts <= nowMs) return '（超過中）';
      const remMin = Math.max(1, Math.round((ts - nowMs) / 60000));
      return `（残り約${remMin}分）`;
    };

    const isSecondaryStop = Boolean(
      prev &&
        prevStatus !== 'running' &&
        nextStatus !== 'running' &&
        Number(next.targetSeconds || 0) <= 0 &&
        Number(next.pausedRemainingSeconds || 0) <= 0 &&
        Number(next.targetEndTimestamp || 0) <= 0 &&
        !prevHadCheck &&
        !nextHasCheck &&
        prevIsShampooing === nextIsShampooing &&
        prevHelpProc === nextHelpProc &&
        prevColorStaff === nextColorStaff &&
        prevAssist === nextAssist &&
        prevCheckStaff === nextCheckStaff &&
        prev.updatedBy &&
        resolvedActorId &&
        String(prev.updatedBy).toLowerCase() !== String(resolvedActorId).toLowerCase()
    );

    const candidateEvents = [];
    let hasUnresolvedPersonalTarget = false;
    const effectiveActorForKey = resolvedActorId || next.updatedBy || '';

    // 1. チェック完了 (check_done)
    if (prevHadCheck && !nextHasCheck && (nextStatus === 'running' || prevStatus === 'running') && nextCheckTotal > 0) {
      const targetStaffNames = [nextColorStaff, prevColorStaff, nextAssist, prevCheckStaff, nextCheckStaff];
      const { ids: targets, hasUnresolved } = collectTargetUserIds(
        targetStaffNames,
        [next.createdBy, prev?.createdBy]
      );
      const allowBroadcast = hasUnresolved || hasUnknownOtherCreator;
      const finalTargets = targets.length > 0 ? targets : (allowBroadcast ? allOtherMemberIds : []);
      if (finalTargets.length > 0 || allowBroadcast) {
        const stateDisc = buildPeerEventStateDisc('check_done');
        candidateEvents.push({
          eventType: 'check_done',
          stateDisc,
          targetStaffNames,
          semanticKey: buildPeerEventSemanticKey(timerId, 'check_done', effectiveActorForKey, stateDisc),
          notifId: `push_chk_${timerId}_${prevCheckEnd}_${nowMs}`,
          title: `✓ ${seatLabel} ${checkProc}完了`,
          body: `${seatLabel}: ${actorLabel}${checkProc}を完了しました（全体タイマー継続中）`,
          color: '#5E5CE6',
          targetUserIds: finalTargets,
          allowBroadcastFallback: allowBroadcast,
          priorityOrder: 2,
        });
      }
    }

    // 2. タイマー停止 / 停止と同時の施術移行 / 2人目による後追い停止 (stop)
    if ((prevStatus === 'running' && nextStatus !== 'running') || isSecondaryStop) {
      const enteredProc =
        !isSecondaryStop &&
        (nextIsShampooing ||
          (nextHelpProc &&
            nextHelpProc !== 'ヘルプなし' &&
            nextHelpProc !== 'none' &&
            isValidStaffNameForPush(nextAssist)));
      const procLabel = nextIsShampooing ? 'シャンプー' : (nextHelpProc || '施術');
      const stopTitle = enteredProc ? `⏹ ${seatLabel} ${procLabel}移行` : `⏹ ${seatLabel} タイマー停止`;
      const stopBody = enteredProc
        ? `${seatLabel}: ${actorLabel}${procLabel}に入りました`
        : `${seatLabel}: ${actorLabel}タイマーを止めました`;
      const stopColor = enteredProc
        ? procLabel === 'シャンプー'
          ? '#0A84FF'
          : procLabel === 'コーミング'
            ? '#30D158'
            : '#5E5CE6'
        : '#FF9F0A';
      const targetStaffNames = [prevColorStaff, nextColorStaff, prevAssist, nextAssist, prevCheckStaff, nextCheckStaff];
      const { ids: targets, hasUnresolved } = collectTargetUserIds(
        targetStaffNames,
        [prev?.createdBy, next.createdBy, prev?.updatedBy]
      );
      const isCallAction = !isSecondaryStop && (next.actionStatus === 'call' || nextHelpProc === '呼び出し');
      const allowBroadcast = hasUnresolved || hasUnknownOtherCreator || isCallAction;
      const finalTargets = targets.length > 0 ? targets : (allowBroadcast ? allOtherMemberIds : []);
      if (finalTargets.length > 0 || allowBroadcast) {
        const stateDisc = buildPeerEventStateDisc('stop');
        candidateEvents.push({
          eventType: 'stop',
          stateDisc,
          targetStaffNames,
          semanticKey: buildPeerEventSemanticKey(timerId, 'stop', effectiveActorForKey, stateDisc),
          notifId: `push_stop_${timerId}_${resolvedActorId || 'actor'}_${prevEnd || 0}_${nowMs}`,
          title: stopTitle,
          body: stopBody,
          color: stopColor,
          targetUserIds: finalTargets,
          allowBroadcastFallback: allowBroadcast,
          priorityOrder: 1,
        });
      }
    }

    // 3. チェック担当の指名 (assign_check) — 個人指名のため未解決時も無関係メンバーへ全体ブロードキャストしない
    if (
      nextStatus === 'running' &&
      isConcreteStaffNameForPush(nextCheckStaff) &&
      (normalizeNameForPushMatch(prevCheckStaff) !== normalizeNameForPushMatch(nextCheckStaff) || (!prevHadCheck && nextHasCheck))
    ) {
      const { ids: checkIds, unresolved } = resolveStaffUserIds(nextCheckStaff);
      if (unresolved) {
        hasUnresolvedPersonalTarget = true;
      }
      const isSelfVolunteered = isStaffNameSelf(nextCheckStaff) || (resolvedActorId && checkIds.includes(resolvedActorId));
      const targets = new Set(checkIds.filter((uid) => uid !== resolvedActorId));
      if (isSelfVolunteered) {
        const { ids: mainOwnerIds } = collectTargetUserIds([nextColorStaff, prevColorStaff], [next.createdBy, prev?.createdBy], false);
        mainOwnerIds.forEach((uid) => targets.add(uid));
      }
      const finalTargets = Array.from(targets);
      if (finalTargets.length > 0) {
        const chkMins = Math.max(1, Math.round((nextCheckTotal || (nextCheckEnd - nowMs) / 1000) / 60));
        const remSuffix = !prevHadCheck && nextHasCheck
          ? `（${chkMins}分）`
          : (nextHasCheck ? formatRemainingSuffix(nextCheckEnd) : '');
        const bodyText = isSelfVolunteered
          ? `${seatLabel}: ${nextCheckStaff}さんが${checkProc}担当に入りました${remSuffix}`
          : `${seatLabel}: ${actorLabel}${nextCheckStaff}さんを${checkProc}担当に指定しました${remSuffix}`;
        const stateDisc = buildPeerEventStateDisc('assign_check', { nextCheckStaff, checkProc });
        candidateEvents.push({
          eventType: 'assign_check',
          stateDisc,
          targetStaffNames: isSelfVolunteered ? [nextCheckStaff, nextColorStaff, prevColorStaff] : [nextCheckStaff],
          semanticKey: buildPeerEventSemanticKey(timerId, 'assign_check', effectiveActorForKey, stateDisc),
          notifId: `push_assign_check_${timerId}_${nextCheckStaff}_${nextCheckEnd || nextEnd}_${nowMs}`,
          title: `🔔 ${seatLabel} ${checkProc}担当指名`,
          body: bodyText,
          color: '#5E5CE6',
          targetUserIds: finalTargets,
          allowBroadcastFallback: false,
          priorityOrder: 5,
        });
      }
    }

    // 3.5. チェック担当の解除・別スタッフ変更 (unassign_check)
    if (
      prevStatus === 'running' &&
      nextStatus === 'running' &&
      prevHadCheck &&
      nextHasCheck &&
      isConcreteStaffNameForPush(prevCheckStaff) &&
      normalizeNameForPushMatch(prevCheckStaff) !== normalizeNameForPushMatch(nextCheckStaff)
    ) {
      const { ids: prevChkIds, unresolved: prevChkUnresolved } = resolveStaffUserIds(prevCheckStaff);
      if (prevChkUnresolved) {
        hasUnresolvedPersonalTarget = true;
      }
      const unassignChkTargets = prevChkIds.filter((uid) => uid && uid !== resolvedActorId);
      if (unassignChkTargets.length > 0) {
        const unassignChkBody = isConcreteStaffNameForPush(nextCheckStaff)
          ? `${seatLabel}: ${actorLabel}${checkProc}担当を${nextCheckStaff}さんに変更しました`
          : `${seatLabel}: ${actorLabel}${checkProc}担当から外れました`;
        const stateDisc = buildPeerEventStateDisc('unassign_check', { prevCheckStaff, nextCheckStaff });
        candidateEvents.push({
          eventType: 'unassign_check',
          stateDisc,
          targetStaffNames: [prevCheckStaff],
          semanticKey: buildPeerEventSemanticKey(timerId, 'unassign_check', effectiveActorForKey, stateDisc),
          notifId: `push_unassign_check_${timerId}_${prevCheckStaff}_${nowMs}`,
          title: `ℹ️ ${seatLabel} ${checkProc}担当解除`,
          body: unassignChkBody,
          color: '#8E8E93',
          targetUserIds: unassignChkTargets,
          allowBroadcastFallback: false,
          priorityOrder: 3,
        });
      }
    }

    // 4. ヘルプ担当の指名 (assign_assist) — 個人指名のため未解決時も無関係メンバーへ全体ブロードキャストしない
    if (
      nextStatus === 'running' &&
      isConcreteStaffNameForPush(nextAssist) &&
      (normalizeNameForPushMatch(prevAssist) !== normalizeNameForPushMatch(nextAssist) ||
        isNewStart ||
        (prevHelpProc !== nextHelpProc && Boolean(nextHelpProc) && nextHelpProc !== 'ヘルプなし' && nextHelpProc !== 'none'))
    ) {
      const { ids: assistIds, unresolved } = resolveStaffUserIds(nextAssist);
      if (unresolved) {
        hasUnresolvedPersonalTarget = true;
      }
      const isSelfVolunteered = isStaffNameSelf(nextAssist) || (resolvedActorId && assistIds.includes(resolvedActorId));
      const targets = new Set(assistIds.filter((uid) => uid !== resolvedActorId));
      if (isSelfVolunteered) {
        const { ids: mainOwnerIds } = collectTargetUserIds([nextColorStaff, prevColorStaff], [next.createdBy, prev?.createdBy], false);
        mainOwnerIds.forEach((uid) => targets.add(uid));
      }
      const finalTargets = Array.from(targets);
      if (finalTargets.length > 0) {
        const totalMin = Math.max(1, Math.round((nextTargetSec || (nextEnd - nowMs) / 1000) / 60));
        const remSuffix = isNewStart ? `（${totalMin}分）` : formatRemainingSuffix(nextEnd);
        const bodyText = isSelfVolunteered
          ? `${seatLabel}: ${nextAssist}さんが${helpProc}担当に入りました${remSuffix}`
          : `${seatLabel}: ${actorLabel}${nextAssist}さんを${helpProc}担当に指定しました${remSuffix}`;
        const stateDisc = buildPeerEventStateDisc('assign_assist', { nextAssist, helpProc });
        candidateEvents.push({
          eventType: 'assign_assist',
          stateDisc,
          targetStaffNames: isSelfVolunteered ? [nextAssist, nextColorStaff, prevColorStaff] : [nextAssist],
          semanticKey: buildPeerEventSemanticKey(timerId, 'assign_assist', effectiveActorForKey, stateDisc),
          notifId: `push_assign_assist_${timerId}_${nextAssist}_${helpProc}_${nextEnd}_${nowMs}`,
          title: `🔔 ${seatLabel} ${helpProc}担当指名`,
          body: bodyText,
          color: '#30D158',
          targetUserIds: finalTargets,
          allowBroadcastFallback: false,
          priorityOrder: 6,
        });
      }
    }

    // 4.5. ヘルプ担当の解除・別スタッフ変更 (unassign_assist)
    if (
      prevStatus === 'running' &&
      nextStatus === 'running' &&
      !isNewStart &&
      isConcreteStaffNameForPush(prevAssist) &&
      normalizeNameForPushMatch(prevAssist) !== normalizeNameForPushMatch(nextAssist)
    ) {
      const { ids: prevAssistIds, unresolved: prevAssistUnresolved } = resolveStaffUserIds(prevAssist);
      if (prevAssistUnresolved) {
        hasUnresolvedPersonalTarget = true;
      }
      const unassignTargets = prevAssistIds.filter((uid) => uid && uid !== resolvedActorId);
      if (unassignTargets.length > 0) {
        const isNoHelp = nextAssist === 'ヘルプなし' || nextAssist === 'none' || nextHelpProc === 'ヘルプなし';
        const unassignBody = isNoHelp
          ? `${seatLabel}: ${actorLabel}ヘルプ担当を解除しました（ヘルプなし）`
          : isConcreteStaffNameForPush(nextAssist)
            ? `${seatLabel}: ${actorLabel}ヘルプ担当を${nextAssist}さんに変更しました`
            : `${seatLabel}: ${actorLabel}ヘルプ担当から外れました`;
        const stateDisc = buildPeerEventStateDisc('unassign_assist', {
          prevAssist,
          nextAssist,
          nextHelpProc,
        });
        candidateEvents.push({
          eventType: 'unassign_assist',
          stateDisc,
          targetStaffNames: [prevAssist],
          semanticKey: buildPeerEventSemanticKey(timerId, 'unassign_assist', effectiveActorForKey, stateDisc),
          notifId: `push_unassign_assist_${timerId}_${prevAssist}_${nowMs}`,
          title: `ℹ️ ${seatLabel} ヘルプ担当解除`,
          body: unassignBody,
          color: '#8E8E93',
          targetUserIds: unassignTargets,
          allowBroadcastFallback: false,
          priorityOrder: 4,
        });
      }
    }

    // 5. 主担当の指名・変更 (assign_main) — 個人指名のため未解決時も無関係メンバーへ全体ブロードキャストしない
    if (
      nextStatus === 'running' &&
      isConcreteStaffNameForPush(nextColorStaff) &&
      !isStaffNameSelf(nextColorStaff) &&
      (normalizeNameForPushMatch(prevColorStaff) !== normalizeNameForPushMatch(nextColorStaff) || isNewStart)
    ) {
      const { ids: mainIds, unresolved } = resolveStaffUserIds(nextColorStaff);
      if (unresolved) {
        hasUnresolvedPersonalTarget = true;
      }
      const filteredMainIds = mainIds.filter((uid) => uid !== resolvedActorId);
      if (filteredMainIds.length > 0) {
        const stateDisc = buildPeerEventStateDisc('assign_main', { nextEnd });
        candidateEvents.push({
          eventType: 'assign_main',
          stateDisc,
          targetStaffNames: [nextColorStaff],
          semanticKey: buildPeerEventSemanticKey(timerId, 'assign_main', effectiveActorForKey, stateDisc),
          notifId: `push_assign_main_${timerId}_${nextColorStaff}_${nextEnd}_${nowMs}`,
          title: `🔔 ${seatLabel} 主担当指名`,
          body: `${seatLabel}: ${actorLabel}${nextColorStaff}さんを主担当に設定しました`,
          color: '#0A84FF',
          targetUserIds: filteredMainIds,
          allowBroadcastFallback: false,
          priorityOrder: 6.5,
        });
      }
    }

    // 6. ヘルプ募集開始 (recruit)
    const isAssistNewlyRecruit = nextStatus === 'running' && nextAssist === '募集中' && (prevAssist !== '募集中' || isNewStart);
    const isCheckNewlyRecruit = nextStatus === 'running' && nextCheckStaff === '募集中' && (prevCheckStaff !== '募集中' || !prevHadCheck);
    if (isAssistNewlyRecruit || isCheckNewlyRecruit) {
      const recruitProc = isCheckNewlyRecruit && !isAssistNewlyRecruit ? checkProc : helpProc;
      const totalMin = Math.max(1, Math.round((nextTargetSec || (nextEnd - nowMs) / 1000) / 60));
      const chkMin = Math.max(1, Math.round((nextCheckTotal || (nextCheckEnd - nowMs) / 1000) / 60));
      const remSuffix = isCheckNewlyRecruit && !isAssistNewlyRecruit
        ? (!prevHadCheck ? `（${chkMin}分）` : formatRemainingSuffix(nextCheckEnd))
        : (isNewStart ? `（${totalMin}分）` : formatRemainingSuffix(nextEnd));
      const stateDisc = buildPeerEventStateDisc('recruit', { recruitProc });
      candidateEvents.push({
        eventType: 'recruit',
        stateDisc,
        targetStaffNames: [],
        semanticKey: buildPeerEventSemanticKey(timerId, 'recruit', effectiveActorForKey, stateDisc),
        notifId: `push_recruit_${timerId}_${recruitProc}_${nextEnd}_${nowMs}`,
        title: `📢 ${seatLabel} ${recruitProc}ヘルプ募集`,
        body: `${seatLabel}: ${actorLabel}${recruitProc}のヘルプを募集しています${remSuffix}`,
        color: '#FF9F0A',
        targetUserIds: allOtherMemberIds,
        allowBroadcastFallback: true,
        priorityOrder: 7,
      });
    }

    // 7. 稼働中席へのチェックタイマー追加 (add_check)
    if (nextStatus === 'running' && !prevHadCheck && nextHasCheck) {
      const checkMin = Math.max(1, Math.round((nextCheckTotal || (nextCheckEnd - nowMs) / 1000) / 60));
      const targetStaffNames = [nextColorStaff, nextAssist, nextCheckStaff];
      const { ids: targets, hasUnresolved } = collectTargetUserIds(
        targetStaffNames,
        [next.createdBy],
        false
      );
      if (hasUnresolved) {
        hasUnresolvedPersonalTarget = true;
      }
      const finalTargets = targets;
      if (finalTargets.length > 0) {
        const stateDisc = buildPeerEventStateDisc('add_check', { nextCheckEnd, checkProc });
        candidateEvents.push({
          eventType: 'add_check',
          stateDisc,
          targetStaffNames,
          semanticKey: buildPeerEventSemanticKey(timerId, 'add_check', effectiveActorForKey, stateDisc),
          notifId: `push_add_check_${timerId}_${nextCheckEnd}_${nowMs}`,
          title: `⏱ ${seatLabel} ${checkProc}タイマー追加`,
          body: `${seatLabel}: ${actorLabel}${checkProc}タイマー（${checkMin}分）を追加しました`,
          color: '#5E5CE6',
          targetUserIds: finalTargets,
          allowBroadcastFallback: false,
          priorityOrder: 8,
        });
      }
    }

    // 8. 停止後の施術ステータス変更（シャンプー・コーミング移行）(status_change)
    if (nextStatus !== 'running' && prevStatus !== 'running' && !isSecondaryStop) {
      const enteredShampoo = nextIsShampooing && !prevIsShampooing;
      const enteredProc =
        !enteredShampoo &&
        nextHelpProc &&
        nextHelpProc !== prevHelpProc &&
        nextHelpProc !== 'ヘルプなし' &&
        nextHelpProc !== 'none' &&
        isValidStaffNameForPush(nextAssist);
      const isCallAction = next.actionStatus === 'call' || nextHelpProc === '呼び出し';
      if (enteredShampoo || enteredProc || isCallAction) {
        const procLabel = isCallAction ? '呼び出し' : (enteredShampoo ? 'シャンプー' : nextHelpProc);
        const procColor = procLabel === 'シャンプー' ? '#0A84FF' : procLabel === 'コーミング' ? '#30D158' : '#5E5CE6';
        const targetStaffNames = [prevColorStaff, nextColorStaff, prevAssist, nextAssist, prevCheckStaff];
        const { ids: targets, hasUnresolved } = collectTargetUserIds(
          targetStaffNames,
          [prev?.createdBy, next.createdBy]
        );
        const allowBroadcast = hasUnresolved || isCallAction || hasUnknownOtherCreator;
        const finalTargets = targets.length > 0 ? targets : (allowBroadcast ? allOtherMemberIds : []);
        if (finalTargets.length > 0 || allowBroadcast) {
          const stateDisc = buildPeerEventStateDisc('status_change', { procLabel, nextAssist });
          candidateEvents.push({
            eventType: 'status_change',
            stateDisc,
            targetStaffNames,
            semanticKey: buildPeerEventSemanticKey(timerId, 'status_change', effectiveActorForKey, stateDisc),
            notifId: `push_status_${timerId}_${procLabel}_${nowMs}`,
            title: isCallAction ? `🔔 ${seatLabel} 呼び出し` : `🚿 ${seatLabel} ${procLabel}開始`,
            body: isCallAction ? `${seatLabel}: ${actorLabel}呼び出しがあります` : `${seatLabel}: ${actorLabel}${procLabel}に入りました`,
            color: procColor,
            targetUserIds: finalTargets,
            allowBroadcastFallback: allowBroadcast,
            priorityOrder: 9,
          });
        }
      }
    }

    // 9. タイマー開始 (timer_start)
    if (isNewStart) {
      const totalMin = Math.max(1, Math.round((nextTargetSec || (nextEnd - nowMs) / 1000) / 60));
      const targetStaffNames = [nextColorStaff, nextAssist, nextCheckStaff];
      const { ids: targets, hasUnresolved } = collectTargetUserIds(
        targetStaffNames,
        [next.createdBy],
        false
      );
      if (hasUnresolved) {
        hasUnresolvedPersonalTarget = true;
      }
      const finalTargets = targets;
      if (finalTargets.length > 0) {
        const stateDisc = buildPeerEventStateDisc('timer_start', { nextEnd });
        candidateEvents.push({
          eventType: 'timer_start',
          stateDisc,
          targetStaffNames,
          semanticKey: buildPeerEventSemanticKey(timerId, 'timer_start', effectiveActorForKey, stateDisc),
          notifId: `push_start_${timerId}_${nextEnd}_${nowMs}`,
          title: `▶️ ${seatLabel} タイマー開始`,
          body: `${seatLabel}: ${actorLabel}タイマー（${totalMin}分）を開始しました`,
          color: '#0A84FF',
          targetUserIds: finalTargets,
          allowBroadcastFallback: false,
          priorityOrder: 10,
        });
      }
    }

    // 10. 稼働中の残り時間変更 (time_adjust: 25秒以上の変更)
    if (
      !isNewStart &&
      nextStatus === 'running' &&
      prevStatus === 'running' &&
      prevEnd > 0 &&
      nextEnd > 0 &&
      Math.abs(nextEnd - prevEnd) >= 25000
    ) {
      const diffMin = Math.round((nextEnd - prevEnd) / 60000);
      const effectiveDiffMin = diffMin !== 0 ? diffMin : (nextEnd > prevEnd ? 1 : -1);
      const sign = effectiveDiffMin > 0 ? '+' : '';
      const remSuffix = formatRemainingSuffix(nextEnd);
      const targetStaffNames = [nextColorStaff, nextAssist, nextCheckStaff];
      const { ids: targets, hasUnresolved } = collectTargetUserIds(
        targetStaffNames,
        [next.createdBy],
        false
      );
      if (hasUnresolved) {
        hasUnresolvedPersonalTarget = true;
      }
      const finalTargets = targets;
      if (finalTargets.length > 0) {
        const stateDisc = buildPeerEventStateDisc('time_adjust', { nextEnd });
        candidateEvents.push({
          eventType: 'time_adjust',
          stateDisc,
          targetStaffNames,
          semanticKey: buildPeerEventSemanticKey(timerId, 'time_adjust', effectiveActorForKey, stateDisc),
          notifId: `push_adjust_${timerId}_${nextEnd}_${nowMs}`,
          title: `⏱ ${seatLabel} 残り時間変更`,
          body: `${seatLabel}: ${actorLabel}残り時間を${sign}${effectiveDiffMin}分調整しました${remSuffix}`,
          color: '#0A84FF',
          targetUserIds: finalTargets,
          allowBroadcastFallback: false,
          priorityOrder: 11,
        });
      }
    }

    // ★ Bug 9-C.1: 「募集中 → ヘルプなし → 募集中」のように中間遷移で candidateEvents が空になるケースでも、
    //   早期リターン前に必ず現在の席状態に基づき送信履歴 (_dispatchedSemanticKeyMap) の古い状態キーを無効化する
    if (next) {
      purgeStaleSemanticKeysForSeatState(prev, next, { salonId });
    }

    if (candidateEvents.length === 0 && !hasUnresolvedPersonalTarget) {
      return { sent: 0 };
    }

    candidateEvents.sort((a, b) => a.priorityOrder - b.priorityOrder);

    // 4秒以内の同一 semanticKey 重複送信を防止（かつ同一席・同一ロール系およびクロスファミリーで今回のバッチと異なる古い状態キーを即時削除）
    for (const [k, ts] of _dispatchedSemanticKeyMap.entries()) {
      if (nowMs - ts > 15000) {
        _dispatchedSemanticKeyMap.delete(k);
      }
    }
    const normTimerTarget = normalizeSemanticToken(timerId);
    if (normTimerTarget && candidateEvents.length > 0) {
      const batchPairsByFamily = new Map();
      const targetSet = new Set([normTimerTarget]);
      for (const ev of candidateEvents) {
        const fam = getPeerEventRoleFamily(ev.eventType);
        const normEv = normalizeSemanticToken(ev.eventType);
        const normDisc = normalizeSemanticToken(ev.stateDisc || '');
        if (fam) {
          if (!batchPairsByFamily.has(fam)) {
            batchPairsByFamily.set(fam, new Set());
          }
          batchPairsByFamily.get(fam).add(`${normEv}|${normDisc}`);
        }
        purgeCrossFamilyDispatchedMapByTargets(salonId, targetSet, {
          target: normTimerTarget,
          ev: normEv,
          disc: normDisc,
          roleFamily: fam,
        });
      }
      for (const [fam, keepPairs] of batchPairsByFamily.entries()) {
        purgeDispatchedMapByTargetsAndFamily(salonId, targetSet, fam, keepPairs);
      }
    }

    // 受信者 user_id ごとに最優先の1イベントのみを割り当て
    const recipientEventMap = new Map();
    for (const ev of candidateEvents) {
      const dedupKey = `${salonId}|${ev.semanticKey}`;
      const lastSentAt = _dispatchedSemanticKeyMap.get(dedupKey) || 0;
      if (nowMs - lastSentAt < 4000) continue;

      let assignedAny = false;
      for (const uid of ev.targetUserIds) {
        if (!uid || uid === resolvedActorId) continue;
        if (!recipientEventMap.has(uid)) {
          recipientEventMap.set(uid, ev);
          assignedAny = true;
        }
      }
      if (assignedAny) {
        _dispatchedSemanticKeyMap.set(dedupKey, nowMs);
      }
    }

    let targetRecipientIds = Array.from(recipientEventMap.keys());
    const hasBroadcastEligibleEvent = candidateEvents.some((ev) => ev.allowBroadcastFallback);
    if (targetRecipientIds.length === 0 && !hasBroadcastEligibleEvent && !hasUnresolvedPersonalTarget) {
      return { sent: 0 };
    }

    let tokenRows = [];
    let hadTokenQueryError = false;
    if (targetRecipientIds.length > 0) {
      const { data: rows, error: tokenErr } = await supabase
        .from('salon_member_push_tokens')
        .select('user_id, expo_push_token')
        .eq('salon_id', salonId)
        .in('user_id', targetRecipientIds);
      if (tokenErr) {
        hadTokenQueryError = true;
      } else if (Array.isArray(rows)) {
        tokenRows = rows;
      }
    }

    // 15秒メンバーキャッシュや古いローカル user_id により新規参加メンバーを取りこぼしていた可能性に備え、一度だけ forceRefresh で個人指名も含めて再解決
    if (!hadTokenQueryError && tokenRows.length === 0 && targetRecipientIds.length > 0) {
      const freshMembers = await fetchSalonMembersMap(salonId, { forceRefresh: true });
      let discoveredNewUid = false;
      freshMembers.forEach((m) => {
        const uid = String(m?.user_id || '').trim();
        if (!uid || uid === resolvedActorId) return;
        addAliasForUser(uid, m?.display_name);
        const memberAliasSet = aliasesByUserId.get(uid);
        for (const ev of candidateEvents) {
          if (recipientEventMap.has(uid)) break;
          const matchesPersonalStaff =
            memberAliasSet &&
            Array.isArray(ev.targetStaffNames) &&
            ev.targetStaffNames.some(
              (name) =>
                isConcreteStaffNameForPush(name) &&
                memberAliasSet.has(normalizeNameForPushMatch(name))
            );
          if (ev.allowBroadcastFallback || matchesPersonalStaff) {
            recipientEventMap.set(uid, ev);
            discoveredNewUid = true;
            break;
          }
        }
      });
      if (discoveredNewUid) {
        targetRecipientIds = Array.from(recipientEventMap.keys());
        const { data: retryRows, error: retryErr } = await supabase
          .from('salon_member_push_tokens')
          .select('user_id, expo_push_token')
          .eq('salon_id', salonId)
          .in('user_id', targetRecipientIds);
        if (retryErr) {
          hadTokenQueryError = true;
        } else if (Array.isArray(retryRows)) {
          tokenRows = retryRows;
        }
      }
    }

    // サロン全員トークンへのフォールバックは allowBroadcastFallback === true のイベントが存在する場合のみ実行（特定個人のトークン未登録で無関係スタッフ全員へ誤爆させない）
    if (!hadTokenQueryError && tokenRows.length === 0 && hasBroadcastEligibleEvent) {
      const primaryBroadcastEv = candidateEvents.find((ev) => ev.allowBroadcastFallback);
      if (primaryBroadcastEv) {
        let query = supabase
          .from('salon_member_push_tokens')
          .select('user_id, expo_push_token')
          .eq('salon_id', salonId);
        if (resolvedActorId) {
          query = query.neq('user_id', resolvedActorId);
        }
        const { data: fallbackRows, error: fallbackErr } = await query;
        if (fallbackErr) {
          hadTokenQueryError = true;
        } else if (Array.isArray(fallbackRows) && fallbackRows.length > 0) {
          const dedupKey = `${salonId}|${primaryBroadcastEv.semanticKey}`;
          const lastSentAt = _dispatchedSemanticKeyMap.get(dedupKey) || 0;
          if (targetRecipientIds.length === 0 && nowMs - lastSentAt < 4000) {
            return { sent: 0 };
          }
          _dispatchedSemanticKeyMap.set(dedupKey, nowMs);
          tokenRows = fallbackRows;
          tokenRows.forEach((r) => {
            if (r?.user_id && r.user_id !== resolvedActorId && !recipientEventMap.has(r.user_id)) {
              recipientEventMap.set(r.user_id, primaryBroadcastEv);
            }
          });
        }
      }
    }

    const messages = [];
    const seenTokens = new Set();
    for (const row of tokenRows) {
      const token = String(row?.expo_push_token || '').trim();
      const uid = String(row?.user_id || '').trim();
      if (!token || !token.startsWith('ExponentPushToken[') || seenTokens.has(token)) continue;
      if (resolvedActorId && uid === resolvedActorId) continue;
      const ev = recipientEventMap.get(uid);
      if (!ev) continue;
      seenTokens.add(token);
      const effectiveActor = resolvedActorId || next.updatedBy || '';
      const resolvedSemKey =
        buildPeerEventSemanticKey(timerId, ev.eventType, effectiveActor, ev.stateDisc || '') ||
        ev.semanticKey;
      const collapseId = buildExpoCollapseId(timerId, ev.eventType, ev.stateDisc || '');
      const isGentleUnassign =
        ev.eventType === 'unassign_assist' || ev.eventType === 'unassign_check';
      messages.push({
        to: token,
        ...(isGentleUnassign ? {} : { sound: 'default' }),
        title: ev.title,
        body: ev.body,
        priority: 'high',
        _contentAvailable: true,
        interruptionLevel: isGentleUnassign ? 'active' : 'time-sensitive',
        channelId: 'salon-shared-events',
        collapseId,
        data: {
          type: 'SALON_EVENT_PUSH',
          salonId,
          timerId,
          seatNumber: next.seatNumber,
          seatLabel,
          notifId: ev.notifId,
          eventType: ev.eventType,
          isGentleInfo: isGentleUnassign,
          stateDisc: ev.stateDisc || '',
          semanticKey: resolvedSemKey,
          notifText: ev.body,
          notifColor: ev.color,
          color: ev.color,
          updatedBy: effectiveActor || null,
          actorId: effectiveActor || null,
          updatedAt: nowMs,
          seatSnapshot: next,
        },
      });
    }

    let hadExpoFetchError = false;
    const actuallySentTokens = new Set();
    if (messages.length > 0) {
      for (let i = 0; i < messages.length; i += 100) {
        const chunk = messages.slice(i, i + 100);
        try {
          const response = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Accept-encoding': 'gzip, deflate',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(chunk),
          });
          if (response.ok) {
            chunk.forEach((m) => {
              if (m?.to) actuallySentTokens.add(String(m.to).trim());
            });
          } else {
            hadExpoFetchError = true;
          }
        } catch {
          hadExpoFetchError = true;
        }
      }
      if (!hadExpoFetchError && !hasUnresolvedPersonalTarget) {
        return { sent: actuallySentTokens.size };
      }
    }

    // 正常に送信対象トークンが0件だった場合は不要な Edge Function 呼び出しを行わず終了し、
    // 未解決の個人指名ターゲットがある場合・トークン取得DBエラー・または Expo Push HTTP 通信失敗時のみ Edge Function（サーバー側最新 salon_members 解決）へフォールバックする
    if (!hadTokenQueryError && !hadExpoFetchError && !hasUnresolvedPersonalTarget) {
      return { sent: 0 };
    }

    if (typeof supabase?.functions?.invoke === 'function') {
      await supabase.functions.invoke('notify-salon-event', {
        body: {
          type: prev ? 'UPDATE' : 'INSERT',
          table: 'salon_timers',
          alreadyNotifiedTokens: Array.from(actuallySentTokens),
          record: {
            id: next.id,
            salon_id: salonId,
            seat_label: next.seatLabel,
            status: next.status,
            target_seconds: next.targetSeconds,
            target_end_timestamp: next.targetEndTimestamp,
            paused_remaining_seconds: next.pausedRemainingSeconds,
            created_by: next.createdBy,
            color_staff_name: next.colorStaffName,
            assistant_staff_name: next.assistantStaffName,
            help_process: next.helpProcess,
            is_shampooing: next.isShampooing,
            check_target_end_timestamp: next.checkTargetEndTimestamp,
            check_total_seconds: next.checkTotalSeconds,
            check_process: next.checkProcess,
            check_staff_name: next.checkStaffName,
            updated_by: resolvedActorId || next.updatedBy || null,
          },
          old_record: prev
            ? {
                id: prev.id,
                salon_id: salonId,
                seat_label: prev.seatLabel,
                status: prev.status,
                target_seconds: prev.targetSeconds,
                target_end_timestamp: prev.targetEndTimestamp,
                paused_remaining_seconds: prev.pausedRemainingSeconds,
                created_by: prev.createdBy,
                color_staff_name: prev.colorStaffName,
                assistant_staff_name: prev.assistantStaffName,
                help_process: prev.helpProcess,
                is_shampooing: prev.isShampooing,
                check_target_end_timestamp: prev.checkTargetEndTimestamp,
                check_total_seconds: prev.checkTotalSeconds,
                check_process: prev.checkProcess,
                check_staff_name: prev.checkStaffName,
                updated_by: prev.updatedBy || null,
              }
            : null,
        },
      });
    }
    return { sent: messages.length };
  } catch (e) {
    console.warn('[PushNotification] dispatchSalonTimerEventPush warning:', e?.message || e);
    return { sent: 0 };
  }
};

