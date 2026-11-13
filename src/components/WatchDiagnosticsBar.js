import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Platform,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  AppState,
} from 'react-native';
import WatchConnectivity from 'watch-connectivity';
import { getAlarmDiagnostics, subscribeAlarmDiagnostics } from '../utils/alarmScheduler';
import {
  getDiagBarVisible,
  setDiagBarVisible,
  subscribeDiagBarVisible,
  getDiagScene,
  subscribeDiagScene,
  cycleDiagSceneMarker,
  resetSyncTraceLogsAndSyncClock,
  collectAndExportMergedTraceLogs,
  getSyncTraceStatusSummary,
} from '../utils/syncTraceLogger';

// ★ Apple Watch & 共有タイマー同期経路の診断ミニバー（Issue #13）
// 右上の「非表示」または設定タブ最下部の「共有同期の経路診断」からいつでも表示/非表示を切り替え可能。

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

export default function WatchDiagnosticsBar({
  theme,
  salonId = '',
  userId = '',
  staffRole = '',
}) {
  const [isVisible, setIsVisible] = useState(() => getDiagBarVisible());
  const [scene, setScene] = useState(() => getDiagScene());
  const [status, setStatus] = useState(() => WatchConnectivity.getStatus());
  const [diag, setDiag] = useState(() => WatchConnectivity.getDiagnostics());
  const [alarm, setAlarm] = useState(() => getAlarmDiagnostics());
  const [traceSummary, setTraceSummary] = useState(() => getSyncTraceStatusSummary());
  const [busyAction, setBusyAction] = useState(null); // 'init' | 'export' | null

  useEffect(() => {
    const unsubVis = subscribeDiagBarVisible((vis) => setIsVisible(vis));
    const unsubScene = subscribeDiagScene((sc) => setScene(sc));
    return () => {
      unsubVis();
      unsubScene();
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'ios' || !isVisible) return undefined;
    const refresh = () => {
      if (AppState.currentState !== 'active') return;
      setStatus(WatchConnectivity.getStatus());
      setAlarm(getAlarmDiagnostics());
      setTraceSummary(getSyncTraceStatusSummary());
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
  }, [isVisible]);

  if (Platform.OS !== 'ios' || !isVisible) return null;

  const textColor = theme?.textPrimary || '#1C1C1E';
  const subColor = theme?.textSecondary || '#687076';
  const accentColor = theme?.accent || '#0A84FF';

  const handleHideBar = async () => {
    await setDiagBarVisible(false);
    Alert.alert(
      '診断ミニバーを非表示にしました',
      '「設定」タブ最下部の「🔧 共有同期の経路診断」からいつでも再表示できます。'
    );
  };

  const handleInitAndSyncClock = async () => {
    if (busyAction) return;
    setBusyAction('init');
    try {
      const res = await resetSyncTraceLogsAndSyncClock();
      setTraceSummary(getSyncTraceStatusSummary());
      Alert.alert(
        '⏱ 初期化 ＆ 時計同期完了',
        `シーン: ${res.scene}\n時計オフセット: ${res.serverOffsetMs >= 0 ? `+${res.serverOffsetMs}` : res.serverOffsetMs}ms${res.minRttMs != null ? ` (最小RTT ${res.minRttMs}ms)` : ''}\nWatchログ消去: ${res.watchClearResult}`
      );
    } catch (e) {
      Alert.alert('初期化エラー', String(e?.message || e));
    } finally {
      setBusyAction(null);
    }
  };

  const handleCycleScene = () => {
    if (busyAction) return;
    const next = cycleDiagSceneMarker();
    setScene(next);
    setTraceSummary(getSyncTraceStatusSummary());
  };

  const handleExportLogs = async () => {
    if (busyAction) return;
    setBusyAction('export');
    try {
      await collectAndExportMergedTraceLogs({
        salonId,
        userId,
        staffRole,
        openShareSheet: true,
      });
      setTraceSummary(getSyncTraceStatusSummary());
    } catch (e) {
      Alert.alert('ログ書き出しエラー', String(e?.message || e));
    } finally {
      setBusyAction(null);
    }
  };

  if (!status) {
    return (
      <View style={[styles.card, { backgroundColor: theme?.cardBg, borderColor: theme?.cardBorder }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.title, { color: textColor }]}>⌚ Watch通信状態: ネイティブモジュール未読込</Text>
          <TouchableOpacity onPress={handleHideBar} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={[styles.hideBtnText, { color: subColor }]}>非表示 ×</Text>
          </TouchableOpacity>
        </View>
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
  const compEnabledText = yesNo(status.isComplicationEnabled);
  const compRem =
    typeof status.remainingComplicationTransfers === 'number' && status.remainingComplicationTransfers >= 0
      ? `${status.remainingComplicationTransfers}回`
      : '-';

  return (
    <View style={[styles.card, { backgroundColor: theme?.cardBg, borderColor: theme?.cardBorder }]}>
      <View style={styles.headerRow}>
        <View style={styles.rowTitleLeft}>
          <View style={[styles.dot, { backgroundColor: linkColor }]} />
          <Text style={[styles.title, { color: textColor }]}>⌚ {linkText}</Text>
          <Text style={[styles.traceCountBadge, { color: subColor }]}>
            ログ{traceSummary.bufferCount}件
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleHideBar}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.hideBtn}
        >
          <Text style={[styles.hideBtnText, { color: subColor }]}>非表示 ×</Text>
        </TouchableOpacity>
      </View>

      <Text style={[styles.line, { color: subColor }]}>
        ペア{yesNo(status.isPaired)} / Watchアプリ{yesNo(status.isWatchAppInstalled)} / {activationLabel(status.activationState)} / 文字盤優先{compEnabledText}(残{compRem})
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

      {/* 経路ログ診断コントロール行 */}
      <View style={[styles.actionRow, { borderTopColor: theme?.cardBorder || '#2C2C2E' }]}>
        <TouchableOpacity
          style={[styles.actionBtn, { borderColor: theme?.cardBorder || '#3A3A3C' }]}
          onPress={handleInitAndSyncClock}
          disabled={!!busyAction}
          activeOpacity={0.7}
        >
          {busyAction === 'init' ? (
            <ActivityIndicator size="small" color={accentColor} />
          ) : (
            <Text style={[styles.actionBtnText, { color: textColor }]}>⏱ 初期化</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.scenePill, { borderColor: accentColor }]}
          onPress={handleCycleScene}
          disabled={!!busyAction}
          activeOpacity={0.7}
        >
          <Text style={[styles.scenePillText, { color: accentColor }]}>🏷 {scene}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.exportBtn, { backgroundColor: accentColor }]}
          onPress={handleExportLogs}
          disabled={!!busyAction}
          activeOpacity={0.8}
        >
          {busyAction === 'export' ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.exportBtnText}>📤 ログ共有</Text>
          )}
        </TouchableOpacity>
      </View>
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
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  rowTitleLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
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
  traceCountBadge: {
    fontSize: 10,
    marginLeft: 6,
    fontWeight: '600',
  },
  hideBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  hideBtnText: {
    fontSize: 10,
    fontWeight: '600',
  },
  line: {
    fontSize: 10,
    lineHeight: 14,
  },
  error: {
    color: '#FF453A',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 5,
    paddingTop: 5,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  actionBtn: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    minWidth: 68,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {
    fontSize: 11,
    fontWeight: '700',
  },
  scenePill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scenePillText: {
    fontSize: 11,
    fontWeight: '800',
  },
  exportBtn: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  exportBtnText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
});
