import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import WatchConnectivity from 'watch-connectivity';
import { getAlarmDiagnostics, subscribeAlarmDiagnostics } from '../utils/alarmScheduler';

// ★ Apple Watch 通信状態の常時表示（診断用）
// どこで同期が止まっているかを画面上で確認するための小さなカード。
// 邪魔になったら SalonWorkScreen から <WatchDiagnosticsBar /> を外すだけで非表示にできる。

const fmtTime = (ms) => {
  if (!ms) return '--:--:--';
  const d = new Date(ms);
  const p = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const yesNo = (v) => (v === true ? '○' : v === false ? '×' : '?');

const activationLabel = (s) => {
  switch (s) {
    case 'activated': return '有効';
    case 'inactive': return '一時停止';
    case 'notActivated': return '未有効化';
    default: return s || '不明';
  }
};

const authLabel = (s) => {
  switch (s) {
    case 'authorized': return '許可済';
    case 'denied': return '拒否（設定アプリで許可が必要）';
    case 'notDetermined': return '未確認';
    case 'unavailable': return '利用不可';
    default: return s || '不明';
  }
};

function AlarmLine({ alarm, color }) {
  if (!alarm) return null;
  const text = !alarm.moduleLoaded
    ? '⏰ iPhoneアラーム: ネイティブモジュール未読込'
    : !alarm.available
    ? '⏰ iPhoneアラーム: このiOSでは利用不可（iOS 26以降が必要）'
    : `⏰ iPhoneアラーム: ${authLabel(alarm.authorization)} / 予約${alarm.scheduledCount}件${alarm.lastResult ? ` / 最終:${alarm.lastResult}` : ''}`;
  const bad = !alarm.moduleLoaded || !alarm.available || alarm.authorization === 'denied';
  return <Text style={[styles.line, { color: bad ? '#FF453A' : color }]}>{text}</Text>;
}

export default function WatchDiagnosticsBar({ theme }) {
  const [status, setStatus] = useState(() => WatchConnectivity.getStatus());
  const [diag, setDiag] = useState(() => WatchConnectivity.getDiagnostics());
  const [alarm, setAlarm] = useState(() => getAlarmDiagnostics());

  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    const refresh = () => {
      setStatus(WatchConnectivity.getStatus());
      setAlarm(getAlarmDiagnostics());
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    const sub = WatchConnectivity.addStatusListener((s) => setStatus(s));
    const unsubscribe = WatchConnectivity.subscribeDiagnostics((d) => setDiag(d));
    const unsubscribeAlarm = subscribeAlarmDiagnostics((a) => setAlarm(a));
    return () => {
      clearInterval(timer);
      if (sub?.remove) sub.remove();
      if (unsubscribe) unsubscribe();
      if (unsubscribeAlarm) unsubscribeAlarm();
    };
  }, []);

  if (Platform.OS !== 'ios') return null;

  const textColor = theme?.textPrimary || '#1C1C1E';
  const subColor = theme?.textSecondary || '#687076';

  if (!status) {
    return (
      <View style={[styles.card, { backgroundColor: theme?.cardBg, borderColor: theme?.cardBorder }]}>
        <Text style={[styles.title, { color: textColor }]}>⌚ Watch通信状態: ネイティブモジュール未読込</Text>
        <AlarmLine alarm={alarm} color={subColor} />
      </View>
    );
  }

  const linkColor = status.isReachable
    ? '#30D158'
    : status.activationState === 'activated'
    ? '#FFD60A'
    : '#8E8E93';
  const linkText = status.isReachable
    ? 'Watchと通信可能'
    : status.activationState === 'activated'
    ? '有効化済み・Watch画面未接続'
    : '未接続';

  const nativeCount = status.nativeReceivedCount || 0;
  const jsCount = diag.jsReceivedCount || 0;
  const bridgeMismatch = nativeCount !== jsCount;

  return (
    <View style={[styles.card, { backgroundColor: theme?.cardBg, borderColor: theme?.cardBorder }]}>
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: linkColor }]} />
        <Text style={[styles.title, { color: textColor }]}>⌚ {linkText}</Text>
      </View>

      <Text style={[styles.line, { color: subColor }]}>
        ペアリング{yesNo(status.isPaired)} / Watchアプリ{yesNo(status.isWatchAppInstalled)} / 状態:{activationLabel(status.activationState)} / 受信設定{yesNo(status.delegateOk)}
      </Text>
      {!!status.activationError && (
        <Text style={[styles.line, styles.error]}>有効化エラー: {status.activationError}</Text>
      )}
      {!!status.error && (
        <Text style={[styles.line, styles.error]}>状態取得エラー: {status.error}</Text>
      )}

      <Text style={[styles.line, { color: subColor }]}>
        送信 {fmtTime(diag.lastSendAt)}（{diag.sendCount || 0}回・{diag.lastSendSeatCount ?? '-'}席）即時:{diag.lastSendMessageResult || '-'} / 保存:{diag.lastSendContextResult || '-'}
      </Text>
      <Text style={[styles.line, { color: bridgeMismatch ? '#FF453A' : subColor }]}>
        受信(本体) {nativeCount}回 {fmtTime(status.lastNativeReceivedAt)} {status.lastNativeReceivedKind || ''} {status.lastNativeReceivedAction || ''}
      </Text>
      <Text style={[styles.line, { color: bridgeMismatch ? '#FF453A' : subColor }]}>
        受信(JS) {jsCount}回 {fmtTime(diag.lastJsReceivedAt)} {diag.lastJsReceivedKind || ''} {diag.lastJsReceivedAction || ''}{diag.queuedActions ? ` / 画面準備待ち ${diag.queuedActions}件` : ''}
      </Text>
      <AlarmLine alarm={alarm} color={subColor} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginTop: 6,
    marginBottom: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  title: {
    fontSize: 12,
    fontWeight: '700',
  },
  line: {
    fontSize: 10,
    lineHeight: 14,
  },
  error: {
    color: '#FF453A',
  },
});
