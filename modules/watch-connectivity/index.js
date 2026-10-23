import { EventEmitter, requireNativeModule } from 'expo-modules-core';
import { AppState, Platform } from 'react-native';

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

// ★ applicationContext 永続保存用の最新客席スナップショット（メインタイマー単独同期時のコンテキスト上書き消失防止）
let lastSyncedSeats = null;

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
  queuedActions: 0,
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

// ★ Watchからの操作（action 付きの受信）の一元管理
// アプリ起動時に1回だけ受信リスナーを登録し、受け取り先（サロン画面）が準備できるまでは保留。
// サロン画面を開く前や、画面のデータ読み込み中に届いた操作も取りこぼさない。
const MAX_ACTION_QUEUE = 100;
const actionQueue = [];
const actionConsumers = new Set();

const pruneActionQueue = () => {
  const cutoff = Date.now() - 120000; // 2分以上前の古い保留を整理
  for (let i = actionQueue.length - 1; i >= 0; i -= 1) {
    const item = actionQueue[i];
    if (item.enqueuedAt < cutoff || (actionConsumers.size >= 2 && item.deliveredCount >= actionConsumers.size)) {
      actionQueue.splice(i, 1);
    }
  }
  updateDiagnostics({ queuedActions: actionQueue.length });
};

const deliverAction = (payload) => {
  const deliveredTo = new WeakSet();
  let deliveredCount = 0;

  actionConsumers.forEach((cb) => {
    try {
      cb(payload);
      deliveredTo.add(cb);
      deliveredCount += 1;
    } catch (e) {
      console.warn('[WatchConnectivity] action handler failed:', e);
    }
  });

  // HomeScreen と SalonWorkScreen の両方（2消費者以上）に渡り切るまではキューに保持し、
  // 遅れてマウント・データ読込完了した画面にも確実に取りこぼしなく届ける
  if (actionConsumers.size < 2) {
    if (payload.action === 'REQUEST_SYNC') {
      const existingIdx = actionQueue.findIndex((item) => item.payload.action === 'REQUEST_SYNC');
      if (existingIdx !== -1) {
        // 新しいREQUEST_SYNC（特にwatchMainTimerActiveまたはwatchMainTimerStopped付き）で古い保留を更新
        if (
          payload.watchMainTimerStopped ||
          payload.watchMainTimerActive ||
          !actionQueue[existingIdx].payload.watchMainTimerActive
        ) {
          actionQueue[existingIdx] = {
            payload,
            deliveredTo,
            deliveredCount,
            enqueuedAt: Date.now(),
          };
        }
        return;
      }
    }
    actionQueue.push({
      payload,
      deliveredTo,
      deliveredCount,
      enqueuedAt: Date.now(),
    });
    if (actionQueue.length > MAX_ACTION_QUEUE) {
      actionQueue.splice(0, actionQueue.length - MAX_ACTION_QUEUE);
    }
    pruneActionQueue();
  }
};

const processedEventSeqs = new Set();
const markEventSeqProcessed = (seq) => {
  if (seq == null) return true;
  if (processedEventSeqs.has(seq)) return false;
  processedEventSeqs.add(seq);
  if (processedEventSeqs.size > 300) {
    const first = processedEventSeqs.values().next().value;
    processedEventSeqs.delete(first);
  }
  return true;
};

let lastMainTimerActionTimestamp = 0;
let lastLocalMainTimerStopAt = 0;
const stoppedMainTimerRecords = []; // [{ endTs, stoppedAt }]
const lastLocalSeatStopAt = new Map(); // seatKey -> timestamp
const stoppedSeatTimerRecords = new Map(); // seatKey -> [{ endTs, stoppedAt }]
const STOP_HOLD_MS = 4 * 3600 * 1000; // 4時間保持（Watch側の3時間スナップショット保持より長くする）

const pruneStoppedRecords = () => {
  const cutoff = Date.now() - STOP_HOLD_MS;
  for (let i = stoppedMainTimerRecords.length - 1; i >= 0; i -= 1) {
    if (stoppedMainTimerRecords[i].stoppedAt < cutoff) {
      stoppedMainTimerRecords.splice(i, 1);
    }
  }
  stoppedSeatTimerRecords.forEach((list, key) => {
    const filtered = list.filter((r) => r.stoppedAt >= cutoff);
    if (filtered.length === 0) {
      stoppedSeatTimerRecords.delete(key);
    } else {
      stoppedSeatTimerRecords.set(key, filtered);
    }
  });
};

const isMainTimerEndStopped = (endTs) => {
  const num = Number(endTs || 0);
  if (!num || num <= 0) return false;
  pruneStoppedRecords();
  return stoppedMainTimerRecords.some((r) => r.endTs > 0 && Math.abs(r.endTs - num) < 15000);
};

const isSeatTimerEndStopped = (seatId, endTs) => {
  const num = Number(endTs || 0);
  if (seatId == null || !num || num <= 0) return false;
  pruneStoppedRecords();
  const list = stoppedSeatTimerRecords.get(String(seatId));
  if (!list) return false;
  return list.some((r) => r.endTs > 0 && Math.abs(r.endTs - num) < 15000);
};

const notifyLocalStopOrReset = (seatId, stoppedEndTimestamp = 0) => {
  const now = Date.now();
  const endTs = Number(stoppedEndTimestamp || 0);
  const isMain =
    seatId === 'main-timer' ||
    seatId === '-1' ||
    Number(seatId) === -1;

  pruneStoppedRecords();

  if (isMain) {
    lastLocalMainTimerStopAt = now;
    if (now > lastMainTimerActionTimestamp) {
      lastMainTimerActionTimestamp = now;
    }
    if (endTs > 0) {
      stoppedMainTimerRecords.push({ endTs, stoppedAt: now });
    }
    // キュー内の古いメインタイマー開始・時間変更アクションや、古い稼働中REQUEST_SYNCを無害化
    for (let i = actionQueue.length - 1; i >= 0; i -= 1) {
      const p = actionQueue[i].payload;
      if (!p) continue;
      if (
        p.action === 'MAIN_TIMER_START' ||
        p.action === 'MAIN_TIMER_SET_TIME' ||
        p.action === 'MAIN_TIMER_ADJUST'
      ) {
        actionQueue.splice(i, 1);
      } else if (p.action === 'REQUEST_SYNC' && (p.watchMainTimerActive || p.extra?.watchMainTimerActive)) {
        actionQueue[i].payload = {
          ...p,
          watchMainTimerActive: false,
          watchMainTimerStopped: true,
          extra: p.extra ? { ...p.extra, watchMainTimerActive: false, watchMainTimerStopped: true } : p.extra,
        };
      }
    }
  } else if (seatId != null) {
    const key = String(seatId);
    lastLocalSeatStopAt.set(key, now);
    if (endTs > 0) {
      const list = stoppedSeatTimerRecords.get(key) || [];
      list.push({ endTs, stoppedAt: now });
      stoppedSeatTimerRecords.set(key, list);
    }
    for (let i = actionQueue.length - 1; i >= 0; i -= 1) {
      const p = actionQueue[i].payload;
      if (!p) continue;
      if (
        String(p.seatId) === key &&
        (p.action === 'START_TIMER' || p.action === 'SET_TIME' || p.action === 'ADJUST_TIME' || p.action === 'RESTART_TIMER')
      ) {
        actionQueue.splice(i, 1);
      }
    }
  }
  updateDiagnostics({ queuedActions: actionQueue.length });
};

const STOP_OR_FINISH_ACTIONS = new Set([
  'MAIN_TIMER_RESET',
  'MAIN_TIMER_PAUSE',
  'STOP_TIMER',
  'FINISH_MEASURE',
  'RESET_ZERO',
  'STOP_ALARM',
  'COMPLETE_CHECK',
  'ENTER_HELP',
]);

const handleIncoming = (kind, body, seq = null) => {
  if (!body) return;
  if (!markEventSeqProcessed(seq)) return;
  recordJsReceived(kind, body);
  if (body.action) {
    const actionStr = String(body.action);
    const ts = body.timestamp != null ? Number(body.timestamp) : 0;
    const isMainAction =
      actionStr.startsWith('MAIN_TIMER_') ||
      (actionStr === 'STOP_ALARM' && (body.seatId === 'main-timer' || body.seatId === '-1' || Number(body.seatId) === -1));
    const targetEndTs = Number(body.targetEndTimestamp || body.extra?.targetEndTimestamp || 0);

    // ★ Watchから届いた停止・リセット・計測終了も即座に停止履歴へ登録し、遅延STARTパケットを遮断
    if (actionStr === 'MAIN_TIMER_RESET') {
      notifyLocalStopOrReset('main-timer', targetEndTs);
    } else if (
      (actionStr === 'STOP_TIMER' || actionStr === 'FINISH_MEASURE' || actionStr === 'RESET_ZERO') &&
      body.seatId != null
    ) {
      notifyLocalStopOrReset(body.seatId, targetEndTs);
    }

    // ★ メインタイマー操作の順序逆転・ゾンビ復活防止:
    //   1) 既に停止・計測終了・リセット済みの targetEndTimestamp と一致する開始系は破棄
    //   2) ローカル停止時刻より前のタイムスタンプを持つ開始系は破棄
    //   3) sendMessage（即時）で後から押された RESET 等が先に届き、transferUserInfo（予備）でその前の START 等が遅れて届いた場合は無視する
    if (
      actionStr === 'MAIN_TIMER_START' ||
      actionStr === 'MAIN_TIMER_SET_TIME' ||
      actionStr === 'MAIN_TIMER_ADJUST'
    ) {
      if (targetEndTs > 0 && isMainTimerEndStopped(targetEndTs)) {
        return;
      }
      if (ts > 0 && lastLocalMainTimerStopAt > 0 && ts <= lastLocalMainTimerStopAt + 500) {
        return;
      }
    }

    if (
      (actionStr === 'START_TIMER' || actionStr === 'SET_TIME' || actionStr === 'ADJUST_TIME' || actionStr === 'RESTART_TIMER') &&
      body.seatId != null
    ) {
      const seatKey = String(body.seatId);
      if (targetEndTs > 0 && isSeatTimerEndStopped(seatKey, targetEndTs)) {
        return;
      }
      const lastSeatStop = lastLocalSeatStopAt.get(seatKey) || 0;
      if (ts > 0 && lastSeatStop > 0 && ts <= lastSeatStop + 500) {
        return;
      }
    }

    if (isMainAction && ts > 0) {
      if (ts < lastMainTimerActionTimestamp - 200) {
        return;
      }
      if (ts > lastMainTimerActionTimestamp) {
        lastMainTimerActionTimestamp = ts;
      }
    }

    // ★ REQUEST_SYNC に含まれる watchMainTimerActive が既に停止済みのタイマーを指している場合は無害化
    let payloadToDeliver = body;
    const hasWatchActive = Boolean(body.watchMainTimerActive || body.extra?.watchMainTimerActive);
    if (actionStr === 'REQUEST_SYNC' && hasWatchActive) {
      const watchEndTs = Number(
        body.targetEndTimestamp ||
        body.extra?.targetEndTimestamp ||
        body.watchMainTimerTargetEnd ||
        body.extra?.watchMainTimerTargetEnd ||
        0
      );
      const isStoppedMain =
        (watchEndTs > 0 && isMainTimerEndStopped(watchEndTs)) ||
        (ts > 0 && lastLocalMainTimerStopAt > 0 && ts <= lastLocalMainTimerStopAt + 1000);
      if (isStoppedMain) {
        payloadToDeliver = {
          ...body,
          watchMainTimerActive: false,
          extra: body.extra ? { ...body.extra, watchMainTimerActive: false } : body.extra,
        };
      }
    }

    // 予備ルート(userInfo/context)で古い操作がアプリ再起動時にまとめて届いた場合のフィルタリング:
    // - 停止・終了・リセット系（STOP_OR_FINISH_ACTIONS）はiPhoneスリープ中の操作を確実に取り込むため最大3時間まで有効
    // - それ以外の開始系操作は60秒以内（ただし未終了かつ未停止の有効なtargetEndTimestampを持つMAIN_TIMER開始は3時間以内）のみ有効
    if ((kind === 'userInfo' || kind === 'context') && ts > 0) {
      const ageMs = Date.now() - ts;
      const isStopOrFinish = STOP_OR_FINISH_ACTIONS.has(actionStr);
      const hasActiveMainEnd =
        isMainAction &&
        !isStopOrFinish &&
        targetEndTs > Date.now() - 3 * 3600 * 1000 &&
        !isMainTimerEndStopped(targetEndTs) &&
        (lastLocalMainTimerStopAt === 0 || ts > lastLocalMainTimerStopAt + 500);
      const maxAgeMs = (isStopOrFinish || hasActiveMainEnd) ? 3 * 3600 * 1000 : 60000;
      if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
        return;
      }
    }
    deliverAction(payloadToDeliver);
  }
};

const EVENT_BODY_KEYS = {
  onMessageReceived: ['message', 'message'],
  onApplicationContextReceived: ['context', 'context'],
  onUserInfoReceived: ['userInfo', 'userInfo'],
};

const drainPendingNativeEvents = () => {
  if (!NativeModule || typeof NativeModule.takePendingEvents !== 'function') return;
  try {
    const pending = NativeModule.takePendingEvents() || [];
    pending.forEach((ev) => {
      const keys = ev && EVENT_BODY_KEYS[ev.name];
      if (keys) {
        const seq = ev._eventSeq ?? (ev.body && ev.body._eventSeq) ?? null;
        handleIncoming(keys[0], ev.body && ev.body[keys[1]], seq);
      }
    });
  } catch (e) {
    console.warn('[WatchConnectivity] takePendingEvents failed:', e);
  }
};

let globalListenersReady = false;
const setupGlobalListeners = () => {
  if (globalListenersReady || !NativeModule) return;
  globalListenersReady = true;
  Object.entries(EVENT_BODY_KEYS).forEach(([eventName, [kind, key]]) => {
    safeAddListener(eventName, (event) => {
      const seq = event && event._eventSeq != null ? event._eventSeq : null;
      handleIncoming(kind, event && event[key], seq);
    });
  });
  // ネイティブ側で保留していた受信を即時回収＋1秒周期およびフォアグラウンド復帰時に取りこぼしを定期回収
  drainPendingNativeEvents();
  setInterval(drainPendingNativeEvents, 1000);
  try {
    AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        drainPendingNativeEvents();
      }
    });
  } catch {}
};

if (Platform.OS === 'ios') {
  setupGlobalListeners();
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

  notifyLocalStopOrReset,
  isMainTimerEndStopped,
  isSeatTimerEndStopped,
  getLastLocalMainTimerStopAt: () => lastLocalMainTimerStopAt,

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
    if (data && Array.isArray(data.seats)) {
      lastSyncedSeats = data.seats;
    }
    const seatCount = data && Array.isArray(data.seats)
      ? data.seats.length
      : (Array.isArray(lastSyncedSeats) ? lastSyncedSeats.length : diagnostics.lastSendSeatCount);
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
          // ★ リアルタイム送信（sendMessage）は渡された data をそのまま送る
          //   （メインタイマー同期時は seats を含めないことで Watch 側の稼働中客席タイマーを絶対保護）
          await NativeModule.sendMessage(data);
          messageResult = '即時OK';
        } catch (sendErr) {
          messageResult = `失敗: ${errorText(sendErr)}`;
        }
      } else {
        messageResult = '未接続のため即時送信なし';
      }

      // ★ 相手への一時通知（タイマー停止・チェック完了）を含む場合で即時通信に失敗した時のみ
      //   バックグラウンドのWatch Extensionへ transferUserInfo で届ける
      const needUserInfoFallback = !!data?.notification && (!reachable || messageResult.startsWith('失敗'));
      if (needUserInfoFallback && typeof NativeModule.transferUserInfo === 'function') {
        try {
          await NativeModule.transferUserInfo(data);
        } catch (uErr) {
          console.warn('[WatchConnectivity] transferUserInfo fallback error:', uErr);
        }
      }

      try {
        // ★ 永続保存される applicationContext には一時通知（notification）を含めない
        //   また、WCSession.updateApplicationContext は辞書全体を置換するため、
        //   メインタイマー単独同期（data.seats 未指定）時も前回保存済みの lastSyncedSeats を引き継いで客席消失を防ぐ
        const contextPayload = data && typeof data === 'object' ? { ...data } : data;
        if (contextPayload && typeof contextPayload === 'object') {
          if ('notification' in contextPayload) {
            delete contextPayload.notification;
          }
          if (!Array.isArray(contextPayload.seats) && Array.isArray(lastSyncedSeats)) {
            contextPayload.seats = lastSyncedSeats;
          }
        }
        const ok = await NativeModule.updateApplicationContext(contextPayload);
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

  // ★ Watchからの操作を受け取る（登録時に未受領の保留操作を古い順にまとめて渡す）
  // 戻り値: 解除用の関数
  subscribeActions: (callback) => {
    setupGlobalListeners();
    actionConsumers.add(callback);
    const pendingForCallback = [];
    actionQueue.forEach((item) => {
      if (!item.deliveredTo.has(callback)) {
        item.deliveredTo.add(callback);
        item.deliveredCount += 1;
        pendingForCallback.push(item.payload);
      }
    });
    pruneActionQueue();
    pendingForCallback.forEach((payload) => {
      try { callback(payload); } catch (e) { console.warn('[WatchConnectivity] action handler failed:', e); }
    });
    return () => {
      actionConsumers.delete(callback);
    };
  },

  // ※ 以下3つは個別イベントの直接購読用（受信回数の記録は上の一元リスナーで行う）
  addMessageListener: (callback) => {
    return safeAddListener('onMessageReceived', (event) => {
      if (event && event.message) callback(event.message);
    });
  },

  addApplicationContextListener: (callback) => {
    return safeAddListener('onApplicationContextReceived', (event) => {
      if (event && event.context) callback(event.context);
    });
  },

  addUserInfoListener: (callback) => {
    return safeAddListener('onUserInfoReceived', (event) => {
      if (event && event.userInfo) callback(event.userInfo);
    });
  },
};

export default WatchConnectivity;
