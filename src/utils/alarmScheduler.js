import { Platform } from 'react-native';
import AlarmKit from 'alarm-kit';

// ★ iPhone の純正アラーム（AlarmKit）予約の一元管理
// 画面ごと（source: 'main' = メインタイマー / 'salon' = サロン席）に「鳴らしたい予定の一覧」を渡すと、
// 前回との差分だけ予約・取り消しを行う。
//
// 予定: { key: 一意な文字列, timestamp: 鳴らす時刻(ms), title: アラーム画面の表示 }

const scheduledBySource = {}; // source -> Map(key -> { timestamp, title, soundOn, result })
let lastResult = '';
const subscribers = new Set();
// 予約（async）と停止が前後して「止めたのに予約が残る」ことがないよう、すべての操作を直列化する
let chain = Promise.resolve();
const enqueue = (fn) => {
  chain = chain.then(fn).catch((e) => { lastResult = `error: ${e?.message || e}`; });
  return chain;
};

const notify = () => {
  const snapshot = getAlarmDiagnostics();
  subscribers.forEach((cb) => { try { cb(snapshot); } catch {} });
};

export const getAlarmDiagnostics = () => {
  let count = 0;
  Object.values(scheduledBySource).forEach((m) => {
    m.forEach((v) => { if (v.result === 'ok') count += 1; });
  });
  return {
    moduleLoaded: AlarmKit.isModuleLoaded(),
    available: AlarmKit.isAvailable(),
    authorization: AlarmKit.getAuthorizationStatus(),
    scheduledCount: count,
    lastResult,
  };
};

export const subscribeAlarmDiagnostics = (cb) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

/**
 * source の予約を desired に合わせる
 * @param {string} source
 * @param {Array<{key:string,timestamp:number,title:string}>} desired
 * @param {{soundOn:boolean, stopPassedOnRemove?:boolean}} options
 *   stopPassedOnRemove: 一覧から消えた予定が「すでに鳴る時刻を過ぎている」場合も停止するか
 *     - サロン席: 席の停止・リセット・終了はユーザー操作なので true（鳴っているアラームも止める）
 *     - メインタイマー: 0秒到達で自動的に状態が変わるため false（鳴っているアラームは止めない）
 */
export const setAlarms = (source, desired, options = {}) => {
  if (Platform.OS !== 'ios' || !AlarmKit.isAvailable()) return Promise.resolve();
  return enqueue(() => applyAlarms(source, desired, options));
};

const applyAlarms = async (source, desired, options) => {
  const soundOn = options.soundOn !== false;
  const stopPassedOnRemove = !!options.stopPassedOnRemove;
  const now = Date.now();

  if (!scheduledBySource[source]) scheduledBySource[source] = new Map();
  const current = scheduledBySource[source];
  const desiredMap = new Map();
  (desired || []).forEach((d) => {
    if (d && d.key && Number.isFinite(d.timestamp)) desiredMap.set(String(d.key), d);
  });

  let dirty = false;
  // ① 一覧から消えた予定を取り消す
  current.forEach((info, key) => {
    if (desiredMap.has(key)) return;
    const passed = info.timestamp <= now;
    if (!passed || stopPassedOnRemove) {
      AlarmKit.cancel(key);
    }
    current.delete(key);
    dirty = true;
  });

  // ② 新規・時刻変更・音設定変更の予定を予約
  for (const [key, d] of desiredMap) {
    const prev = current.get(key);
    const changed = !prev
      || Math.abs(prev.timestamp - d.timestamp) > 1000
      || prev.soundOn !== soundOn
      || prev.title !== d.title;
    if (!changed) continue;
    dirty = true;
    if (d.timestamp <= Date.now() + 500) {
      // すでに時刻を過ぎている予定は予約しない（記録だけ残し、繰り返し予約を防ぐ）
      // ※同じ時刻の予約がすでに鳴っている場合は、その結果（ok）を維持する
      const keepOk = prev && prev.result === 'ok' && Math.abs(prev.timestamp - d.timestamp) <= 1000;
      current.set(key, { timestamp: d.timestamp, title: d.title, soundOn, result: keepOk ? 'ok' : 'past' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await AlarmKit.schedule(key, d.timestamp, d.title, soundOn);
    current.set(key, { timestamp: d.timestamp, title: d.title, soundOn, result });
    lastResult = `${result} (${key})`;
  }
  if (dirty) notify();
};

// source の予約・鳴っているアラームをすべて止める（ユーザーが明示的に止めた時など）
export const stopAllAlarms = (source) => enqueue(() => {
  const current = scheduledBySource[source];
  if (!current) return;
  current.forEach((_, key) => AlarmKit.cancel(key));
  current.clear();
  notify();
});

// 特定のキーのアラームを止める（Watch で止めた時など）
export const stopAlarm = (source, key) => enqueue(() => {
  AlarmKit.cancel(String(key));
  const current = scheduledBySource[source];
  if (current) current.delete(String(key));
  notify();
});

// そのキーが AlarmKit に予約済みか（アプリ内の短いアラーム音との二重鳴動防止に使用）
export const isAlarmScheduled = (source, key) => {
  const info = scheduledBySource[source]?.get(String(key));
  return !!info && info.result === 'ok';
};
