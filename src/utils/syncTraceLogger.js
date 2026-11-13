import { AppState, Share } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';

const STORAGE_KEY_TRACE_LOGS = '@assist_timer_sync_trace_v1';
const STORAGE_KEY_DIAG_BAR_VISIBLE = '@assist_timer_diag_bar_visible_v1';
const STORAGE_KEY_DIAG_SCENE = '@assist_timer_diag_scene_v1';

const MAX_TRACE_ENTRIES = 450;
const PERSIST_DEBOUNCE_MS = 1200;
const MODULE_BOOT_WALL_MS = Date.now();

const randomHex4 = () =>
  Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');

let sessionFallbackDevId = `d#${randomHex4()}`;
let currentMaskedDevId = sessionFallbackDevId;
let currentScene = 'S1';
let diagBarVisible = true;
let serverOffsetMs = 0;
let lastClockSyncMeta = null;
let nextSeq = 1;

const ringBuffer = [];
let hydrated = false;
let persistTimer = null;

const sceneSubscribers = new Set();
const visibilitySubscribers = new Set();

let watchBridge = null;

export const registerWatchTraceBridge = (bridge) => {
  watchBridge = bridge || null;
};

const getMonoMs = () => {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return Math.round(performance.now());
    }
  } catch {}
  return Math.max(0, Date.now() - MODULE_BOOT_WALL_MS);
};

const getCurrentAppState = () => {
  try {
    return (AppState && AppState.currentState) ? String(AppState.currentState) : 'unknown';
  } catch {
    return 'unknown';
  }
};

/**
 * Surrogate-pair-safe UTF-8 32-bit FNV-1a hash (8-char lowercase hex).
 * Bit-for-bit identical across iPhone JS, Watch Swift, Widget Swift, and Supabase Edge TS.
 */
export const fnv1a32HexUtf8 = (input) => {
  const str = String(input ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    let cp = str.codePointAt(i);
    if (cp === undefined) continue;
    if (cp > 0xffff) {
      i += 1; // skip trail surrogate
    }
    if (cp <= 0x7f) {
      hash ^= cp;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    } else if (cp <= 0x7ff) {
      hash ^= 0xc0 | (cp >> 6);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= 0x80 | (cp & 0x3f);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    } else if (cp <= 0xffff) {
      hash ^= 0xe0 | (cp >> 12);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= 0x80 | ((cp >> 6) & 0x3f);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= 0x80 | (cp & 0x3f);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    } else {
      hash ^= 0xf0 | (cp >> 18);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= 0x80 | ((cp >> 12) & 0x3f);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= 0x80 | ((cp >> 6) & 0x3f);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= 0x80 | (cp & 0x3f);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const normalizeStaffTokenForMask = (raw) => {
  if (raw == null) return '';
  let s = String(raw);
  try {
    s = s.normalize('NFKC');
  } catch {}
  return s.replace(/[\s\u3000\ufeff]+/g, '').toLowerCase();
};

/**
 * One-way PII mask for staff display names (4-layer identical).
 */
export const maskStaffName = (raw) => {
  const norm = normalizeStaffTokenForMask(raw);
  if (!norm) return 'empty';
  if (norm === '未定') return 'unset';
  if (norm === 'ヘルプなし' || norm === 'none') return 'none';
  if (norm === '募集中') return 'recruit';
  if (norm === 'スタイリスト' || norm === 'スタッフ') return 'default_stylist';
  return `stf#${fnv1a32HexUtf8(norm).slice(0, 4)}`;
};

/**
 * Mask salonId / userId / UUID timerId (first 6 chars only; local unpromoted IDs like "seat-1" kept as-is).
 */
export const maskEntityId = (raw, prefix = '') => {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s);
  if (prefix === 'u' || prefix === 's') {
    return `${prefix}#${s.slice(0, 6).toLowerCase()}`;
  }
  if (isUuid) {
    const p = prefix || 't';
    return `${p}#${s.slice(0, 6).toLowerCase()}`;
  }
  return s.slice(0, 24);
};

/**
 * Mask Expo Push Token (last 4 chars only).
 */
export const maskPushToken = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const m = s.match(/\[([^\]]+)\]/);
  const inner = m ? m[1] : s;
  return `tok#${inner.slice(-4)}`;
};

export const setTraceDeviceUserId = (userId) => {
  const s = String(userId ?? '').trim();
  if (s) {
    const nextDev = maskEntityId(s, 'u');
    currentMaskedDevId = nextDev;
    for (let i = 0; i < ringBuffer.length; i += 1) {
      const prevDev = String(ringBuffer[i].dev || '');
      if (!prevDev || prevDev.startsWith('d#') || prevDev.startsWith('w#') || prevDev === 'wg') {
        ringBuffer[i].dev = nextDev;
      }
    }
  } else {
    currentMaskedDevId = sessionFallbackDevId;
  }
};

export const getTraceDeviceId = () => currentMaskedDevId;

/**
 * Explicit operation correlation ID: "tr_" + base36(nowMs) + "_" + randHex4
 */
export const createSyncTraceId = (nowMs = Date.now()) => {
  const ts = Math.max(0, Math.round(Number(nowMs) || Date.now())).toString(36);
  return `tr_${ts}_${randomHex4()}`;
};

/**
 * Normalize seat key identically across iPhone, Watch, WidgetKit, and Cloud Edge Function.
 */
export const normalizeSeatKeyForStateRev = (seatNumber, seatLabel) => {
  let lbl = String(seatLabel ?? '');
  try {
    lbl = lbl.normalize('NFKC');
  } catch {}
  lbl = lbl
    .replace(/[\(（]サンプル[\)）]/g, '')
    .replace(/[\s\u3000\ufeff]+/g, '')
    .replace(/席$/u, '')
    .replace(/^(\d+)番$/u, '$1')
    .toLowerCase();

  if (/^[1-9]\d*$/.test(lbl)) {
    return `s${parseInt(lbl, 10)}`;
  }
  if (lbl.length > 0) {
    return lbl;
  }
  const num = Math.round(Number(seatNumber || 0));
  if (Number.isFinite(num) && num > 0) {
    return `s${num}`;
  }
  return 's0';
};

const toMillisSafe = (rawVal) => {
  const n = Number(rawVal || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 10000000000 ? Math.round(n * 1000) : Math.round(n);
};

export const isCustomPostStopProcessLabel = (rawProc) => {
  const p = String(rawProc ?? '').trim();
  if (!p) return false;
  const lower = p.toLowerCase();
  return (
    p !== 'シャンプー' &&
    p !== 'ヘルプなし' &&
    lower !== 'none' &&
    p !== '募集中' &&
    p !== '未定'
  );
};

export const computeStateRevFromFields = ({
  seatNumber = 0,
  seatLabel = '',
  isRunning = false,
  targetEndMs = 0,
  pausedRemainingSeconds = 0,
  hasActiveCheck = false,
  checkTargetEndMs = 0,
  isPostStopProcessActive = false,
  assistToken = '',
  checkToken = '',
}) => {
  const seatKey = normalizeSeatKeyForStateRev(seatNumber, seatLabel);
  const endMs = toMillisSafe(targetEndMs);
  const runFlag = isRunning && endMs > 0 ? 1 : 0;
  const pausedSec = !runFlag
    ? Math.max(0, Math.round(Number(pausedRemainingSeconds || 0)))
    : 0;
  const shampooFlag = runFlag === 0 && pausedSec <= 0 && isPostStopProcessActive ? 1 : 0;
  const endBucket5s = runFlag
    ? Math.round(endMs / 5000)
    : shampooFlag === 0 && pausedSec > 0
      ? pausedSec
      : 0;
  const chkEndMs = toMillisSafe(checkTargetEndMs);
  const chkFlag = runFlag === 1 && hasActiveCheck && chkEndMs > 0 ? 1 : 0;
  const checkEndBucket5s = chkFlag ? Math.round(chkEndMs / 5000) : 0;
  const shouldKeepAssist = runFlag === 1 || shampooFlag === 1 || pausedSec > 0;
  const assistMasked = shouldKeepAssist ? maskStaffName(assistToken) : 'empty';
  const checkMasked = chkFlag === 1 ? maskStaffName(checkToken) : 'empty';
  const canonical = `${seatKey}|${runFlag}|${endBucket5s}|${chkFlag}|${checkEndBucket5s}|${shampooFlag}|${assistMasked}|${checkMasked}`;
  return fnv1a32HexUtf8(canonical);
};

/**
 * Deterministic 8-char hex stateRev from a local iPhone Seat item (or seatSnapshot).
 */
export const computeSeatStateRev = (seat) => {
  if (!seat || typeof seat !== 'object') return '00000000';
  const targetEndMs = toMillisSafe(seat.targetEndTimestamp ?? seat.endTime ?? 0);
  const hasExplicitStatus = typeof seat.status === 'string' && seat.status.length > 0;
  const isRunning =
    (hasExplicitStatus ? seat.status === 'running' : Boolean(seat.isRunning)) &&
    targetEndMs > 0;
  const rawActionStatus = String(seat.actionStatus ?? '').trim();
  const hasActiveActionStatus =
    Boolean(rawActionStatus) && rawActionStatus !== 'normal';
  const hasExplicitPostStopFlag = Boolean(
    seat.isShampooing ||
      hasActiveActionStatus ||
      (hasExplicitStatus && (seat.status === 'shampoo' || seat.status === 'combing' || seat.status === 'post_process'))
  );
  const rawPausedSec = Math.max(
    0,
    Math.round(Number(seat.pausedRemainingSeconds ?? seat.pausedRemaining ?? 0))
  );
  const pausedSec =
    !isRunning &&
    !seat.isReset &&
    (!hasExplicitStatus || seat.status === 'paused') &&
    rawPausedSec > 0
      ? rawPausedSec
      : 0;
  const checkTotalSec = Number(
    seat.checkTotalSeconds ?? seat.checkTargetSeconds ?? seat.checkInterval ?? 0
  );
  const checkEndMs = toMillisSafe(
    seat.checkEndTimestamp ?? seat.checkTargetEndTimestamp ?? seat.nextCheckEndTime ?? 0
  );
  const isCheckDone = Boolean(seat.isCheckCompleted || seat.checkStatus === 'completed');
  const hasActiveCheck =
    isRunning && !isCheckDone && checkTotalSec > 0 && checkEndMs > 0;
  const isPostStopProcessActive =
    !isRunning &&
    pausedSec <= 0 &&
    Boolean(
      hasExplicitPostStopFlag ||
        isCustomPostStopProcessLabel(seat.helpProcess)
    );
  const assistToken = seat.isRecruiting
    ? '募集中'
    : seat.isNoHelpNeeded
    ? 'ヘルプなし'
    : String(seat.assistantStaffName ?? seat.shampooStaff ?? '');
  const checkToken = hasActiveCheck
    ? String(seat.checkStaffName ?? seat.checkStaff ?? '')
    : '';

  return computeStateRevFromFields({
    seatNumber: seat.seatNumber ?? seat.number ?? 0,
    seatLabel: seat.seatLabel ?? seat.name ?? '',
    isRunning,
    targetEndMs,
    pausedRemainingSeconds: pausedSec,
    hasActiveCheck,
    checkTargetEndMs: checkEndMs,
    isPostStopProcessActive,
    assistToken,
    checkToken,
  });
};

/**
 * Deterministic 8-char hex stateRev directly from a Supabase `salon_timers` row.
 */
export const computeCloudRowStateRev = (row) => {
  if (!row || typeof row !== 'object') return '00000000';
  const targetEndMs = toMillisSafe(row.target_end_timestamp ?? 0);
  const statusStr = String(row.status || '');
  const isRunning = statusStr === 'running' && targetEndMs > 0;
  const rawShampoo = Boolean(row.is_shampooing);
  const rawPausedSec = Math.max(0, Math.round(Number(row.paused_remaining_seconds ?? 0)));
  const pausedSec =
    !isRunning && statusStr === 'paused' && rawPausedSec > 0
      ? rawPausedSec
      : 0;
  const checkTotalSec = Number(row.check_total_seconds ?? 0);
  const checkEndMs = toMillisSafe(row.check_target_end_timestamp ?? 0);
  const isCheckDone = Boolean(row.is_check_completed);
  const hasActiveCheck = isRunning && !isCheckDone && checkTotalSec > 0 && checkEndMs > 0;
  const isPostStopProcessActive =
    !isRunning &&
    pausedSec <= 0 &&
    (rawShampoo || isCustomPostStopProcessLabel(row.help_process));
  const assistToken = String(row.assistant_staff_name ?? '');
  const checkToken = hasActiveCheck ? String(row.check_staff_name ?? '') : '';

  return computeStateRevFromFields({
    seatNumber: 0,
    seatLabel: row.seat_label ?? '',
    isRunning,
    targetEndMs,
    pausedRemainingSeconds: pausedSec,
    hasActiveCheck,
    checkTargetEndMs: checkEndMs,
    isPostStopProcessActive,
    assistToken,
    checkToken,
  });
};

/**
 * Composite stateRev across all seats ("s1:a1b2c3d4,s2:e5f60718") for UI commit / WCSession / Widget tracking.
 */
export const computeSeatsCompositeStateRev = (seats) => {
  if (!Array.isArray(seats) || seats.length === 0) return 'empty000';
  const parts = seats
    .filter((s) => s && typeof s === 'object' && !s.isMainTimer)
    .map((s) => {
      const key = normalizeSeatKeyForStateRev(
        s.seatNumber ?? s.number ?? 0,
        s.seatLabel ?? s.name ?? ''
      );
      return `${key}:${computeSeatStateRev(s)}`;
    })
    .sort();
  if (parts.length === 0) return 'empty000';
  return parts.join(',').slice(0, 200);
};

export const formatDiagSeatRef = (seatOrId, fallbackNum = null) => {
  if (!seatOrId) {
    return fallbackNum != null ? `s${fallbackNum}` : '';
  }
  if (typeof seatOrId === 'string' || typeof seatOrId === 'number') {
    return maskEntityId(String(seatOrId), 't');
  }
  if (typeof seatOrId === 'object') {
    const key = normalizeSeatKeyForStateRev(
      seatOrId.seatNumber ?? seatOrId.number ?? fallbackNum ?? 0,
      seatOrId.seatLabel ?? seatOrId.seat_label ?? seatOrId.name ?? ''
    );
    const rawId = seatOrId.cloudTimerId || seatOrId.id || '';
    const maskedId = rawId ? maskEntityId(rawId, 't') : '';
    return maskedId ? `${key}(${maskedId})` : key;
  }
  return '';
};

const FORBIDDEN_PII_META_KEYS = new Set([
  'comment',
  'memo',
  'note',
  'customerName',
  'body',
  'title',
  'expoPushToken',
  'expo_push_token',
]);

const sanitizeMetaValue = (key, val, depth = 0) => {
  if (val === undefined) return undefined;
  if (val === null || typeof val === 'boolean') return val;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'string') {
    if (FORBIDDEN_PII_META_KEYS.has(key)) return undefined;
    if (/Staff|Creator|userName|stylist|actorName/i.test(key)) {
      return maskStaffName(val);
    }
    if (/Token/i.test(key)) {
      return maskPushToken(val);
    }
    if (/salonId|salon_id/i.test(key)) {
      return maskEntityId(val, 's');
    }
    if (/userId|user_id|createdBy|created_by|updatedBy|updated_by|actorId/i.test(key)) {
      return maskEntityId(val, 'u');
    }
    if (/timerId|cloudTimerId|seatId/i.test(key)) {
      return maskEntityId(val, 't');
    }
    const maxLen = /Rev$/i.test(key) ? 200 : 96;
    return val.length > maxLen ? `${val.slice(0, maxLen)}…` : val;
  }
  if (depth >= 2) return undefined;
  if (Array.isArray(val)) {
    return val.slice(0, 12).map((item) => sanitizeMetaValue(key, item, depth + 1));
  }
  if (typeof val === 'object') {
    const out = {};
    Object.keys(val)
      .slice(0, 20)
      .forEach((k) => {
        if (FORBIDDEN_PII_META_KEYS.has(k)) return;
        const v = sanitizeMetaValue(k, val[k], depth + 1);
        if (v !== undefined) out[k] = v;
      });
    return out;
  }
  return undefined;
};

const schedulePersist = () => {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const payload = JSON.stringify({
        savedAt: Date.now(),
        serverOffsetMs,
        scene: currentScene,
        entries: ringBuffer.slice(-MAX_TRACE_ENTRIES),
      });
      AsyncStorage.setItem(STORAGE_KEY_TRACE_LOGS, payload).catch(() => {});
    } catch {}
  }, PERSIST_DEBOUNCE_MS);
};

const pushEntryInternal = (entry) => {
  ringBuffer.push(entry);
  if (ringBuffer.length > MAX_TRACE_ENTRIES) {
    ringBuffer.splice(0, ringBuffer.length - MAX_TRACE_ENTRIES);
  }
  schedulePersist();
};

/**
 * Append a trace entry to the in-memory ring buffer (zero network / IPC side-effects).
 */
export const logSyncTrace = ({
  hop,
  ch = '',
  seat = '',
  act = '',
  res = 'ok',
  rsn = '',
  traceId = '',
  stateRev = '',
  ms = null,
  appState = null,
  layer = 'ios_js',
  wallMs = null,
  monoMs = null,
  scene = null,
  dev = null,
  meta = null,
} = {}) => {
  if (!hop) return null;
  const wMs = wallMs != null && Number.isFinite(Number(wallMs)) ? Math.round(Number(wallMs)) : Date.now();
  const mMs = monoMs != null && Number.isFinite(Number(monoMs)) ? Math.round(Number(monoMs)) : getMonoMs();
  const entry = {
    seq: nextSeq++,
    dev: dev || currentMaskedDevId,
    layer: layer || 'ios_js',
    wallMs: wMs,
    adjMs: Math.round(wMs + serverOffsetMs),
    monoMs: mMs,
    scene: scene || currentScene,
    traceId: traceId ? String(traceId).slice(0, 40) : '',
    stateRev: stateRev ? String(stateRev).slice(0, 200) : '',
    hop: String(hop),
    ch: ch ? String(ch) : '',
    seat: typeof seat === 'object' ? formatDiagSeatRef(seat) : String(seat || ''),
    act: act ? String(act) : '',
    res: res ? String(res) : 'ok',
    rsn: rsn ? String(rsn) : '',
    ms: ms != null && Number.isFinite(Number(ms)) ? Math.round(Number(ms)) : null,
    appState: appState ? String(appState) : getCurrentAppState(),
    meta: meta && typeof meta === 'object' ? sanitizeMetaValue('meta', meta, 0) : undefined,
  };
  pushEntryInternal(entry);
  return entry;
};

const resolveStoredIdentityFallback = async () => {
  try {
    const [rawUid, rawSalonId, rawCurrentSalonId, rawRole, rawSavedSalons] = await Promise.all([
      AsyncStorage.getItem('@assist_timer_user_id').catch(() => null),
      AsyncStorage.getItem('@assist_timer_salon_id').catch(() => null),
      AsyncStorage.getItem('@salon_current_salon_id').catch(() => null),
      AsyncStorage.getItem('@assist_timer_user_role').catch(() => null),
      AsyncStorage.getItem('@salon_saved_salons').catch(() => null),
    ]);
    const uid = String(rawUid || '').trim();
    const sid = String(rawSalonId || rawCurrentSalonId || '').trim();
    let role = String(rawRole || '').trim();
    if (!role && sid && rawSavedSalons) {
      try {
        const salons = JSON.parse(rawSavedSalons);
        if (Array.isArray(salons)) {
          const matched = salons.find((s) => s && String(s.id || '') === sid);
          if (matched) {
            role = matched.role
              ? String(matched.role)
              : matched.isOwner === true
              ? 'owner'
              : matched.isOwner === false
              ? 'guest'
              : '';
          }
        }
      } catch {}
    }
    return { userId: uid, salonId: sid, staffRole: role };
  } catch {
    return { userId: '', salonId: '', staffRole: '' };
  }
};

const hydrateOnce = async () => {
  if (hydrated) return;
  hydrated = true;
  try {
    const [rawLogs, rawVis, rawScene, storedIdentity] = await Promise.all([
      AsyncStorage.getItem(STORAGE_KEY_TRACE_LOGS).catch(() => null),
      AsyncStorage.getItem(STORAGE_KEY_DIAG_BAR_VISIBLE).catch(() => null),
      AsyncStorage.getItem(STORAGE_KEY_DIAG_SCENE).catch(() => null),
      resolveStoredIdentityFallback(),
    ]);
    if (storedIdentity.userId && currentMaskedDevId.startsWith('d#')) {
      setTraceDeviceUserId(storedIdentity.userId);
    }
    if (rawVis === 'false') {
      diagBarVisible = false;
      visibilitySubscribers.forEach((cb) => {
        try { cb(diagBarVisible); } catch {}
      });
    } else if (rawVis === 'true') {
      diagBarVisible = true;
    }
    if (rawScene && /^S[0-9]+$/.test(rawScene)) {
      currentScene = rawScene;
      sceneSubscribers.forEach((cb) => {
        try { cb(currentScene); } catch {}
      });
    }
    if (rawLogs) {
      const parsed = JSON.parse(rawLogs);
      if (parsed && typeof parsed === 'object') {
        if (Number.isFinite(Number(parsed.serverOffsetMs)) && serverOffsetMs === 0) {
          serverOffsetMs = Math.round(Number(parsed.serverOffsetMs));
        }
        if (Array.isArray(parsed.entries) && parsed.entries.length > 0) {
          const currentSnapshot = ringBuffer.splice(0, ringBuffer.length);
          const merged = [...parsed.entries, ...currentSnapshot].slice(-MAX_TRACE_ENTRIES);
          merged.forEach((e, idx) => {
            const prevDev = String(e.dev || '');
            const normDev =
              !prevDev || prevDev.startsWith('d#') || prevDev.startsWith('w#') || prevDev === 'wg'
                ? currentMaskedDevId
                : prevDev;
            ringBuffer.push({
              ...e,
              dev: normDev,
              seq: idx + 1,
            });
          });
          nextSeq = ringBuffer.length + 1;
        }
      }
    }
  } catch {}
};

hydrateOnce();

// ---------------------------------------------------------------------------
// Diag Bar Visibility & Scene Pub/Sub
// ---------------------------------------------------------------------------

export const getDiagBarVisible = () => diagBarVisible;

export const setDiagBarVisible = async (visible) => {
  diagBarVisible = Boolean(visible);
  visibilitySubscribers.forEach((cb) => {
    try { cb(diagBarVisible); } catch {}
  });
  try {
    await AsyncStorage.setItem(STORAGE_KEY_DIAG_BAR_VISIBLE, diagBarVisible ? 'true' : 'false');
  } catch {}
  return diagBarVisible;
};

export const subscribeDiagBarVisible = (cb) => {
  if (typeof cb !== 'function') return () => {};
  visibilitySubscribers.add(cb);
  try { cb(diagBarVisible); } catch {}
  return () => {
    visibilitySubscribers.delete(cb);
  };
};

export const getDiagScene = () => currentScene;

export const getSyncTraceStatusSummary = () => ({
  bufferCount: ringBuffer.length,
  serverOffsetMs,
  lastClockSyncMeta,
  currentScene,
  dev: currentMaskedDevId,
});

export const subscribeDiagScene = (cb) => {
  if (typeof cb !== 'function') return () => {};
  sceneSubscribers.add(cb);
  try { cb(currentScene); } catch {}
  return () => {
    sceneSubscribers.delete(cb);
  };
};

export const setDiagSceneMarker = (sceneLabel, options = {}) => {
  const clean = String(sceneLabel || 'S1').trim().toUpperCase();
  currentScene = clean || 'S1';
  sceneSubscribers.forEach((cb) => {
    try { cb(currentScene); } catch {}
  });
  AsyncStorage.setItem(STORAGE_KEY_DIAG_SCENE, currentScene).catch(() => {});
  logSyncTrace({
    hop: 'SCENE_MARKER',
    ch: 'diag',
    act: currentScene,
    res: 'ok',
    rsn: options.reason || 'manual_switch',
  });
  if (options.syncWatch !== false && watchBridge && typeof watchBridge.setWatchDiagScene === 'function') {
    try {
      watchBridge.setWatchDiagScene(currentScene).catch(() => {});
    } catch {}
  }
  return currentScene;
};

const SCENE_RING = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];

export const cycleDiagSceneMarker = () => {
  const idx = SCENE_RING.indexOf(currentScene);
  const next = idx >= 0 ? SCENE_RING[(idx + 1) % SCENE_RING.length] : 'S1';
  return setDiagSceneMarker(next, { reason: 'pill_cycle' });
};

// ---------------------------------------------------------------------------
// Clock Skew Measurement (ONLY invoked on explicit user tap: Init or Export)
// ---------------------------------------------------------------------------

export const measureSupabaseClockOffset = async () => {
  const endpoint = `${SUPABASE_URL}/rest/v1/salons?select=id&limit=1`;
  let bestSample = null;
  let probesOk = 0;

  for (let i = 0; i < 3; i += 1) {
    const t0 = Date.now();
    let timer = null;
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (controller) {
        timer = setTimeout(() => controller.abort(), 2500);
      }
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Accept: 'application/json',
        },
        signal: controller ? controller.signal : undefined,
      });
      const t1 = Date.now();
      const rtt = Math.max(0, t1 - t0);
      const dateHdr = res && res.headers ? res.headers.get('date') : null;
      const serverMs = dateHdr ? Date.parse(dateHdr) : NaN;
      if (Number.isFinite(serverMs) && serverMs > 0) {
        probesOk += 1;
        const offset = Math.round(serverMs - (t0 + rtt / 2));
        if (!bestSample || rtt < bestSample.rtt) {
          bestSample = { offset, rtt, status: res.status };
        }
      }
    } catch {
      // ignore probe failure
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (bestSample) {
    const prevOffset = serverOffsetMs;
    serverOffsetMs = bestSample.offset;
    const delta = serverOffsetMs - prevOffset;
    if (delta !== 0) {
      for (let i = 0; i < ringBuffer.length; i += 1) {
        ringBuffer[i].adjMs = Math.round(Number(ringBuffer[i].wallMs || 0) + serverOffsetMs);
      }
    }
    lastClockSyncMeta = {
      serverOffsetMs,
      minRttMs: bestSample.rtt,
      probesOk,
      httpDateResolutionMs: 1000,
    };
    logSyncTrace({
      hop: 'CLOCK_SYNC',
      ch: 'supabase_http_date',
      act: 'measure_offset',
      res: 'ok',
      ms: bestSample.rtt,
      meta: lastClockSyncMeta,
    });
    return { ok: true, ...lastClockSyncMeta };
  }

  logSyncTrace({
    hop: 'CLOCK_SYNC',
    ch: 'supabase_http_date',
    act: 'measure_offset',
    res: 'err',
    rsn: 'no_valid_date_header',
    meta: { probesOk },
  });
  return { ok: false, serverOffsetMs, minRttMs: null, probesOk };
};

// ---------------------------------------------------------------------------
// Native Log Ingestion & Reset / Export
// ---------------------------------------------------------------------------

export const ingestNativeDiagLogs = (nativeEntries) => {
  if (!Array.isArray(nativeEntries) || nativeEntries.length === 0) return 0;
  let added = 0;
  nativeEntries.forEach((raw) => {
    if (!raw || typeof raw !== 'object') return;
    const wMs = Number(raw.wallMs || Date.now());
    const entry = {
      seq: nextSeq++,
      dev: currentMaskedDevId,
      layer: 'ios_native',
      wallMs: Math.round(wMs),
      adjMs: Math.round(wMs + serverOffsetMs),
      monoMs: Number.isFinite(Number(raw.monoMs)) ? Math.round(Number(raw.monoMs)) : 0,
      scene: raw.scene ? String(raw.scene) : currentScene,
      traceId: raw.traceId ? String(raw.traceId).slice(0, 40) : '',
      stateRev: raw.stateRev ? String(raw.stateRev).slice(0, 200) : '',
      hop: String(raw.hop || 'N_WC_EVENT'),
      ch: raw.ch ? String(raw.ch) : 'wc_native',
      seat: raw.seat ? maskEntityId(String(raw.seat), 't') : '',
      act: raw.act ? String(raw.act) : '',
      res: raw.res ? String(raw.res) : 'ok',
      rsn: raw.rsn ? String(raw.rsn) : '',
      ms: raw.ms != null && Number.isFinite(Number(raw.ms)) ? Math.round(Number(raw.ms)) : null,
      appState: raw.appState ? String(raw.appState) : 'unknown',
      meta: raw.meta && typeof raw.meta === 'object' ? sanitizeMetaValue('meta', raw.meta, 0) : undefined,
    };
    pushEntryInternal(entry);
    added += 1;
  });
  return added;
};

export const resetSyncTraceLogsAndSyncClock = async () => {
  await hydrateOnce();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  ringBuffer.splice(0, ringBuffer.length);
  nextSeq = 1;
  await AsyncStorage.removeItem(STORAGE_KEY_TRACE_LOGS).catch(() => {});

  if (watchBridge && typeof watchBridge.clearNativeDiagLogs === 'function') {
    try {
      watchBridge.clearNativeDiagLogs();
    } catch {}
  }

  let watchClearResult = 'skipped';
  if (watchBridge && typeof watchBridge.clearWatchDiagLogs === 'function') {
    try {
      const res = await watchBridge.clearWatchDiagLogs(currentScene);
      watchClearResult = res && res.ok ? 'ok' : (res?.reason || 'unreachable');
    } catch {
      watchClearResult = 'err';
    }
  }

  const clockRes = await measureSupabaseClockOffset();

  logSyncTrace({
    hop: 'SESSION_START',
    ch: 'diag',
    act: 'reset_and_clock_sync',
    res: 'ok',
    meta: {
      scene: currentScene,
      serverOffsetMs: clockRes.serverOffsetMs,
      minRttMs: clockRes.minRttMs,
      watchClearResult,
    },
  });

  return {
    ok: true,
    scene: currentScene,
    serverOffsetMs: clockRes.serverOffsetMs,
    minRttMs: clockRes.minRttMs,
    watchClearResult,
  };
};

export const collectAndExportMergedTraceLogs = async ({
  salonId = '',
  userId = '',
  staffRole = '',
  openShareSheet = true,
} = {}) => {
  await hydrateOnce();
  const storedFallback =
    !userId || !salonId || !staffRole ? await resolveStoredIdentityFallback() : { userId: '', salonId: '', staffRole: '' };
  const effectiveUserId = String(userId || storedFallback.userId || '').trim();
  const effectiveSalonId = String(salonId || storedFallback.salonId || '').trim();
  const effectiveStaffRole = String(staffRole || storedFallback.staffRole || '').trim();
  if (effectiveUserId) {
    setTraceDeviceUserId(effectiveUserId);
  }

  // 1. Flush iOS Native WCSession ring buffer
  let nativeFlushedCount = 0;
  if (watchBridge && typeof watchBridge.flushNativeDiagLogs === 'function') {
    try {
      const nativeItems = watchBridge.flushNativeDiagLogs();
      nativeFlushedCount = ingestNativeDiagLogs(nativeItems);
    } catch {}
  }

  // 2. Refresh Supabase clock offset on-demand before export
  const clockSync = await measureSupabaseClockOffset();

  // 3. Pull paired Watch + WidgetKit trace logs on-demand (2.5s timeout)
  let watchPullResult = 'bridge_unavailable';
  let watchEntriesNormalized = [];
  let wcStatus = null;
  if (watchBridge && typeof watchBridge.getStatus === 'function') {
    try {
      wcStatus = watchBridge.getStatus();
    } catch {}
  }
  if (watchBridge && typeof watchBridge.pullWatchDiagLogs === 'function') {
    const pullT0 = Date.now();
    try {
      const pullResp = await watchBridge.pullWatchDiagLogs();
      const pullRtt = Date.now() - pullT0;
      if (pullResp && pullResp.ok && Array.isArray(pullResp.entries)) {
        watchPullResult = `ok(${pullResp.entries.length}rows,${pullRtt}ms)`;
        const watchNowMs = Number(pullResp.watchNowMs || 0);
        // Estimate Watch -> Server clock offset via Phone-Watch midpoint + Phone serverOffsetMs
        const phoneMidMs = pullT0 + pullRtt / 2;
        const watchToPhoneOffsetMs =
          watchNowMs > 0 ? Math.round(phoneMidMs - watchNowMs) : 0;
        const effectiveWatchOffsetMs = watchToPhoneOffsetMs + serverOffsetMs;

        watchEntriesNormalized = pullResp.entries.map((w, idx) => {
          const wWall = Number(w.wallMs || phoneMidMs);
          return {
            seq: Number(w.seq || idx + 1),
            // Unify paired Watch / Widget entries under the same staff device ID (`u#xxxxxx`);
            // `layer` ('watch_app' vs 'watch_widget' vs 'ios_js' vs 'ios_native') preserves exact source.
            dev: currentMaskedDevId,
            layer: w.layer ? String(w.layer) : 'watch_app',
            wallMs: Math.round(wWall),
            adjMs: Math.round(wWall + effectiveWatchOffsetMs),
            monoMs: Number.isFinite(Number(w.monoMs)) ? Math.round(Number(w.monoMs)) : 0,
            scene: w.scene ? String(w.scene) : currentScene,
            traceId: w.traceId ? String(w.traceId).slice(0, 40) : '',
            stateRev: w.stateRev ? String(w.stateRev).slice(0, 200) : '',
            hop: String(w.hop || 'W_EVENT'),
            ch: w.ch ? String(w.ch) : '',
            seat: w.seat ? maskEntityId(String(w.seat), 't') : '',
            act: w.act ? String(w.act) : '',
            res: w.res ? String(w.res) : 'ok',
            rsn: w.rsn ? String(w.rsn) : '',
            ms: w.ms != null && Number.isFinite(Number(w.ms)) ? Math.round(Number(w.ms)) : null,
            appState: w.appState ? String(w.appState) : 'unknown',
            meta: w.meta && typeof w.meta === 'object' ? sanitizeMetaValue('meta', w.meta, 0) : undefined,
          };
        });
      } else {
        watchPullResult = pullResp?.reason || 'empty_or_timeout';
      }
    } catch (e) {
      watchPullResult = `err:${String(e?.message || e).slice(0, 40)}`;
    }
  }

  // 4. Merge & sort chronologically by adjMs -> wallMs -> seq
  const phoneEntriesSnapshot = ringBuffer.map((e) => ({
    ...e,
    dev: currentMaskedDevId,
    adjMs: Math.round(Number(e.wallMs || 0) + serverOffsetMs),
  }));
  const merged = [...phoneEntriesSnapshot, ...watchEntriesNormalized].sort((a, b) => {
    if (a.adjMs !== b.adjMs) return a.adjMs - b.adjMs;
    if (a.wallMs !== b.wallMs) return a.wallMs - b.wallMs;
    return (a.seq || 0) - (b.seq || 0);
  });

  // 5. Build summary header lines
  const sceneCounts = {};
  const layerCounts = {};
  const dropSummary = {};
  merged.forEach((e) => {
    const sc = e.scene || 'S?';
    sceneCounts[sc] = (sceneCounts[sc] || 0) + 1;
    layerCounts[e.layer] = (layerCounts[e.layer] || 0) + 1;
    if (e.res === 'drop' || e.res === 'skip' || e.res === 'err') {
      const k = `${e.hop}:${e.res}:${e.rsn || 'unspecified'}`;
      dropSummary[k] = (dropSummary[k] || 0) + 1;
    }
  });

  const metaHeader = {
    schema: 'assist_timer_sync_trace_v1',
    exportedAtIso: new Date().toISOString(),
    dev: currentMaskedDevId,
    salon: effectiveSalonId ? maskEntityId(effectiveSalonId, 's') : 'none',
    role: effectiveStaffRole || 'unspecified',
    currentScene,
    serverOffsetMs,
    clockMinRttMs: clockSync.minRttMs,
    nativeFlushedCount,
    watchPullResult,
    complicationEnabled: wcStatus?.isComplicationEnabled ?? null,
    remainingComplicationTransfers: wcStatus?.remainingComplicationTransfers ?? null,
    wcReachable: wcStatus?.isReachable ?? null,
    totalEntries: merged.length,
    layerCounts,
    sceneCounts,
    dropsAndSkips: dropSummary,
  };

  const lines = [
    `# ${JSON.stringify(metaHeader)}`,
    ...merged.map((entry) => JSON.stringify(entry)),
  ];
  const text = lines.join('\n');

  if (openShareSheet) {
    try {
      await Share.share({
        title: `AssistTimer SyncTrace (${currentMaskedDevId})`,
        message: text,
      });
    } catch {}
  }

  return {
    ok: true,
    totalEntries: merged.length,
    watchPullResult,
    metaHeader,
    text,
  };
};
