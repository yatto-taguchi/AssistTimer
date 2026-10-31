import React, { useState, useEffect, useContext, useRef, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Modal,
  Alert,
  SafeAreaView,
  Platform,
  Vibration,
  LayoutAnimation,
  Share,
  KeyboardAvoidingView,
  AppState,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import WatchConnectivity from 'watch-connectivity';
import { AppContext } from '../utils/AppContext';
import WatchDiagnosticsBar from '../components/WatchDiagnosticsBar';
import { setAlarms, stopAlarm, stopAllAlarms, subscribeUserStoppedAlarms } from '../utils/alarmScheduler';
import {
  getOrCreateUserId,
  normalizeInviteCode,
  generateRandomInviteCode as generateCloudSafeRandomInviteCode,
  isDummyExampleInviteCode,
  isLegacyExposedInviteCode,
  syncOrCreateSalonInCloud,
  updateSalonInviteCode,
  joinSalonByInviteCode,
  fetchSalonMembers,
  deleteSalonMember,
  subscribeSalonMembers,
  updateMemberDisplayName,
  fetchSalonTimers,
  upsertCloudTimer,
  deleteCloudTimer,
  subscribeSalonTimers,
  isRecentLocalActorEcho,
} from '../utils/salonCloudService';
import {
  configurePushNotificationHandler,
  buildPeerEventSemanticKey,
  hasHandledPeerNotification,
  markPeerNotificationHandled,
  registerAndSyncSalonPushToken,
  removeSalonPushToken,
  subscribeRemotePushEvents,
} from '../utils/pushNotificationService';

const playTimeUpSound = async () => {
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
    const { sound: newSound } = await Audio.Sound.createAsync(
      require('../../assets/alarm_digital.wav')
    );
    newSound.setOnPlaybackStatusUpdate((status) => {
      if (status.didJustFinish) {
        newSound.unloadAsync().catch(() => {});
      }
    });
    await newSound.playAsync();
  } catch (e) {
    console.log('[SalonWorkScreen] playTimeUpSound error:', e);
  }
};

// サロン施術ステータス定義（呼び出し、コーミング、チェック、シャンプー、その他）
export const SALON_ACTION_STATUS_OPTIONS = [
  { id: 'call', label: '呼び出し', badge: '🔔 呼び出し中', icon: 'notifications', color: '#FF9500', bg: '#FFF5E5', border: '#FED7AA', desc: 'ヘルプやアシスタントを呼び出し' },
  { id: 'combing', label: 'コーミング', badge: '🪮 コーミング中', icon: 'git-commit', color: '#007AFF', bg: '#EFF6FF', border: '#BFDBFE', desc: 'コーミング・なじませ中' },
  { id: 'check', label: 'チェック', badge: '🔍 チェック中', icon: 'checkmark-circle', color: '#34C759', bg: '#ECFDF5', border: '#A7F3D0', desc: '発色・放置状態の確認中' },
  { id: 'shampoo', label: 'シャンプー', badge: '💧 シャンプー中', icon: 'water', color: '#AF52DE', bg: '#FBF2FF', border: '#E9D5FF', desc: 'シャンプー台で流し・施術中' },
  { id: 'other', label: 'その他', badge: '💬 その他', icon: 'chatbubble-ellipses', color: '#6B7280', bg: '#F3F4F6', border: '#E5E7EB', desc: 'トリートメント浸透・その他' },
];

export const getActionStatusInfo = (statusId, isShampooing) => {
  const actualId = statusId || (isShampooing ? 'shampoo' : null);
  if (!actualId) return null;
  return SALON_ACTION_STATUS_OPTIONS.find((opt) => opt.id === actualId || opt.label === actualId) || null;
};

// チェックタイマー（中間タイマー）専用工程リスト（シャンプーは完全除外：4種のみ）
export const CHECK_PROCESS_OPTIONS = ['チェック', 'コーミング', '1液2液', '担当を呼ぶ'];

export const sanitizeCheckProcess = (raw) => {
  const trimmed = String(raw || '').trim();
  return CHECK_PROCESS_OPTIONS.includes(trimmed) ? trimmed : 'チェック';
};

// ランダムな6桁（3桁-3桁）の安全な招待コード生成関数（入力例 000-000 や過去露出コードは完全除外）
export const generateRandomInviteCode = () => generateCloudSafeRandomInviteCode();

// 共有コード・招待コードの共通正規化・サニタイズ関数（全角英数の半角化、各種ハイフン・長音記号の統一、空白除去、6桁自動整形）
export const sanitizeInviteCode = (input) => normalizeInviteCode(input);

// デフォルトのワークスペース（タイマー同期モード・2人まで同期無料・1名利用中）
export const createDefaultFreeSalon = (customCode) => ({
  id: 'workspace-free',
  name: 'タイマー同期モード (無料)',
  type: 'pair',
  inviteCode: customCode || generateRandomInviteCode(),
  isPro: false,
  role: 'owner',
  memberCount: 1,
  description: '2人までタイマー同期無料 (1名利用中 / ペア招待可能)',
});

export const DEFAULT_FREE_SALON = createDefaultFreeSalon();

// デフォルトの初期座席マスター（メインタイマー連動＋1番席のみ）
// ★ 初回起動・TestFlightアップデート直後に20分等が入って「タイマーを止める」操作が必要にならないよう、00:00（status: 'idle' の待機スリムバー）で初期化
export const getDefaultInitialSeats = (staffName = 'スタイリスト') => [
  {
    id: 'seat-1',
    seatNumber: 1,
    seatLabel: '1番席',
    status: 'idle',
    colorStaffName: staffName,
    assistantStaffName: '',
    actionStatus: null,
    isShampooing: false,
    targetSeconds: 0,
    initialMinutes: 0,
    pausedRemainingSeconds: 0,
    targetEndTimestamp: null,
    isReset: true,
    isOver: false,
    checkTargetSeconds: 0,
    checkInitialMinutes: 0,
    checkEndTimestamp: null,
    checkStatus: 'stopped',
    checkProcess: 'チェック',
    checkStaffName: '',
    watchAlarmSoundEnabled: false,
    alarmSoundEnabled: false,
    comment: '',
    timeUpTimestamp: null,
    mainStaffConfirmed: true,
    assistantStaffConfirmed: false,
    sosTriggered: false,
    escalationLevel: 0,
    history: [],
  },
];

// ★ TestFlight / App Store ビルド更新の1回限り検知ヘルパー（ネイティブ CFBundleVersion 基準・オフライン起動後の次回クラウド同期リトライ保護付き）
const SALON_LAST_BUILD_VERSION_KEY = '@assist_timer_last_salon_build_version';
const SALON_PENDING_CLOUD_BUILD_NORMALIZE_KEY = '@assist_timer_pending_cloud_build_normalize';
let _salonBuildUpdateCheckPromise = null;
let _wasSalonBuildUpdatedThisLaunch = false;
let _hasPendingCloudBuildNormalize = false;

export const detectSalonBuildUpdateOnce = () => {
  if (_salonBuildUpdateCheckPromise) return _salonBuildUpdateCheckPromise;
  _salonBuildUpdateCheckPromise = (async () => {
    try {
      let currentBuild = '';
      if (Platform.OS === 'ios' && WatchConnectivity && typeof WatchConnectivity.getAppBuildVersion === 'function') {
        currentBuild = WatchConnectivity.getAppBuildVersion();
      }
      if (!currentBuild) {
        const appCfg = require('../../app.json')?.expo;
        currentBuild = `${appCfg?.version || '1.0.0'} (${appCfg?.ios?.buildNumber || appCfg?.android?.versionCode || '0'})`;
      }
      const [prevBuild, pendingCloudFlag] = await Promise.all([
        AsyncStorage.getItem(SALON_LAST_BUILD_VERSION_KEY),
        AsyncStorage.getItem(SALON_PENDING_CLOUD_BUILD_NORMALIZE_KEY),
      ]);
      if (prevBuild !== currentBuild) {
        _wasSalonBuildUpdatedThisLaunch = true;
        _hasPendingCloudBuildNormalize = true;
        await Promise.all([
          AsyncStorage.setItem(SALON_LAST_BUILD_VERSION_KEY, currentBuild),
          AsyncStorage.setItem(SALON_PENDING_CLOUD_BUILD_NORMALIZE_KEY, '1'),
        ]);
        return true;
      }
      if (pendingCloudFlag === '1') {
        _hasPendingCloudBuildNormalize = true;
      }
      return false;
    } catch (e) {
      console.warn('[SalonWorkScreen] detectSalonBuildUpdateOnce error:', e);
      return false;
    }
  })();
  return _salonBuildUpdateCheckPromise;
};

// ★ 施術履歴（塗布〜放置完了・タイマー停止/シャンプー移行まで）の時刻・差分・ライフサイクル共通ヘルパー
export const formatHistoryTimeHHMM = (tsMs = Date.now()) => {
  const d = new Date(tsMs);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};

export const formatDeltaSecondsLabel = (deltaSec) => {
  const absDelta = Math.abs(Math.round(Number(deltaSec) || 0));
  const dm = Math.floor(absDelta / 60);
  const ds = absDelta % 60;
  if (dm > 0 && ds > 0) return `${dm}分${ds}秒`;
  if (dm > 0) return `${dm}分`;
  return `${ds}秒`;
};

// ★ 施術履歴はそのお客さんの「塗ってからタイマー停止・シャンプーに入るまでの間」のみ保持・表示する
export const shouldRetainSeatHistory = (seat) =>
  !!seat && seat.status === 'running' && !seat.isShampooing;

export const buildStartHistoryEntryFromSeat = (seat, timeStr = null) => {
  const totalSec = Math.max(10, Math.round(Number(seat?.targetSeconds || seat?.targetTime || 600)));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const mainLabel = mins === 0 ? `${secs}秒` : (secs === 0 ? `${mins}分` : `${mins}分${secs}秒`);
  const chkSec = Math.round(Number(seat?.checkTargetSeconds || seat?.checkTotalSeconds || 0));
  const hasActiveChk =
    chkSec > 0 &&
    !seat?.isCheckCompleted &&
    seat?.checkStatus !== 'completed' &&
    seat?.checkStatus !== 'stopped' &&
    Number(seat?.checkEndTimestamp) > 0;
  const chkMins = Math.floor(chkSec / 60);
  const chkRemSecs = chkSec % 60;
  const chkLabel = chkMins === 0 ? `${chkRemSecs}秒` : (chkRemSecs === 0 ? `${chkMins}分` : `${chkMins}分${chkRemSecs}秒`);
  const startEstimateMs =
    Number(seat?.targetEndTimestamp) > 0
      ? Number(seat.targetEndTimestamp) - totalSec * 1000
      : Date.now();
  return {
    id: `h-start-${seat?.id || 'seat'}-${Math.round(Number(seat?.targetEndTimestamp) || Date.now())}`,
    time: timeStr || formatHistoryTimeHHMM(startEstimateMs),
    text: hasActiveChk ? `${mainLabel}放置 (チェック: ${chkLabel})` : `${mainLabel}放置`,
    type: 'timer',
  };
};

export const reconcileRealtimeSeatHistory = (prevItem, newSeat, nowStr = formatHistoryTimeHHMM()) => {
  if (!shouldRetainSeatHistory(newSeat)) {
    return [];
  }
  if (!prevItem || !shouldRetainSeatHistory(prevItem)) {
    return [buildStartHistoryEntryFromSeat(newSeat, nowStr)];
  }
  const baseHist =
    Array.isArray(prevItem.history) && prevItem.history.length > 0
      ? [...prevItem.history]
      : [buildStartHistoryEntryFromSeat(newSeat, nowStr)];

  const wasCheckCompleted = !!prevItem.isCheckCompleted || prevItem.checkStatus === 'completed';
  const isNowCheckCompleted = !!newSeat.isCheckCompleted || newSeat.checkStatus === 'completed';
  if (!wasCheckCompleted && isNowCheckCompleted) {
    const checker = (newSeat.checkStaffName || prevItem.checkStaffName || 'スタッフ').trim();
    const chkProc = (newSeat.checkProcess || prevItem.checkProcess || 'チェック').trim() || 'チェック';
    baseHist.push({
      id: `h-chkdone-${Date.now()}`,
      time: nowStr,
      text: `${checker}${chkProc}完了`,
      type: 'check',
    });
  } else {
    const prevHadActiveCheck = Number(prevItem.checkEndTimestamp) > 0 && !wasCheckCompleted;
    const newHasActiveCheck = Number(newSeat.checkEndTimestamp) > 0 && !isNowCheckCompleted;
    if (!prevHadActiveCheck && newHasActiveCheck) {
      const chkSec = Math.max(60, Math.round(Number(newSeat.checkTargetSeconds || newSeat.checkTotalSeconds || 60)));
      const chkMins = Math.max(1, Math.round(chkSec / 60));
      const chkProc = (newSeat.checkProcess || 'チェック').trim() || 'チェック';
      const chkStaff = (newSeat.checkStaffName || '').trim();
      const staffNote = chkStaff ? ` (${chkStaff === '募集中' ? '全員募集' : `担当:${chkStaff}`})` : '';
      baseHist.push({
        id: `h-chkadd-${Date.now()}`,
        time: nowStr,
        text: `チェックタイマー追加 (${chkMins}分 / ${chkProc}${staffNote})`,
        type: 'check',
      });
    }
  }

  const endDiffMs = Number(newSeat.targetEndTimestamp || 0) - Number(prevItem.targetEndTimestamp || 0);
  if (Math.abs(endDiffMs) >= 25000) {
    const deltaSec = Math.round(endDiffMs / 1000);
    const deltaLabel = formatDeltaSecondsLabel(deltaSec);
    baseHist.push({
      id: `h-ext-${Date.now()}`,
      time: nowStr,
      text: deltaSec > 0 ? `${deltaLabel}追加放置` : `${deltaLabel}短縮`,
      type: 'extend',
    });
  }

  return baseHist;
};

// ★ アプリ起動時（TestFlightアップデート後や再起動時）の共通サニタイズ関数:
//   1. 現在稼働中のタイマー（status === 'running' かつ3時間以内のカウントダウン・超過カウントアップ）はそのまま完全継続させる
//   2. 3時間以上前の古い放置タイマー、旧20分サンプル席、および新しいビルド更新時の非稼働席はすべて 00:00（status: 'idle' 待機スリムバー）へ正規化する
//   3. 非稼働席（停止中・待機中）またはシャンプー中の席に残っていた過去の施術履歴はクリアし、カード肥大化を防止する
export const sanitizeLoadedSeats = (seatsList, options = {}) => {
  if (!Array.isArray(seatsList)) return { seats: [], didSanitize: false };
  const { isAppBuildUpdate = false } = options || {};
  const now = Date.now();
  const abandonedCutoff = now - 3 * 3600 * 1000; // 3時間以内の稼働・超過カウントアップは完全維持
  let didSanitize = false;
  const seats = seatsList.map(( rawSeat, index ) => {
    if (!rawSeat || typeof rawSeat !== 'object') return rawSeat;
    let seat = rawSeat;
    const rawLabel = String(seat.seatLabel || seat.name || '');
    if (rawLabel.includes('サンプル')) {
      const cleanedLabel = rawLabel.replace(/\s*[\(（]サンプル[\)）]/g, '').replace(/サンプル/g, '').trim() || `${seat.seatNumber || index + 1}番席`;
      didSanitize = true;
      seat = {
        ...seat,
        seatLabel: cleanedLabel,
        name: cleanedLabel,
      };
    }
    if (seat.status === 'running') {
      const endTs = Number(seat.targetEndTimestamp) || 0;
      // 終了時刻が無効、または3時間以上前の古い放置タイマーのみ00:00待機状態へ正規化（稼働中・超過カウントアップ中は完全保護）
      if (endTs <= 0 || endTs <= abandonedCutoff) {
        didSanitize = true;
        return {
          ...seat,
          status: 'idle',
          pausedRemainingSeconds: 0,
          targetSeconds: 0,
          initialMinutes: 0,
          targetEndTimestamp: null,
          isReset: true,
          isOver: false,
          timeUpTimestamp: null,
          escalationLevel: 0,
          actionStatus: null,
          isShampooing: false,
          assistantStaffName: '',
          helpProcess: null,
          isRecruiting: false,
          isNoHelpNeeded: false,
          checkStatus: 'stopped',
          checkTargetSeconds: null,
          checkTotalSeconds: null,
          checkInitialMinutes: null,
          checkEndTimestamp: null,
          checkPausedRemainingSeconds: null,
          checkStaffName: '',
          isCheckCompleted: false,
          collapsedAtEnd: null,
          history: [],
        };
      }
      if (seat.isShampooing && Array.isArray(seat.history) && seat.history.length > 0) {
        didSanitize = true;
        seat = { ...seat, history: [] };
      }
      // 途中チェックタイマーも3時間以内の稼働・超過カウントアップは維持し、3時間以上前の古い放置データのみ完了扱いに正規化
      if (seat.checkStatus === 'running' && seat.checkEndTimestamp && Number(seat.checkEndTimestamp) <= abandonedCutoff) {
        didSanitize = true;
        return {
          ...seat,
          checkStatus: 'completed',
        };
      }
      return seat;
    }

    // 非稼働席（paused / idle）: 新規アップデート起動時または旧20分初期サンプル席は 00:00（status: 'idle' 待機スリムバー）へ正規化
    const rawComment = String(seat.comment || '').trim();
    const isLegacySampleSeat =
      rawComment === 'タップして操作・編集できます' ||
      (seat.status === 'paused' &&
        Number(seat.targetSeconds) === 1200 &&
        Number(seat.pausedRemainingSeconds) === 1200 &&
        !seat.targetEndTimestamp &&
        !seat.stoppedBy &&
        (!Array.isArray(seat.history) || seat.history.length === 0));

    if (isAppBuildUpdate || isLegacySampleSeat) {
      const needsZeroReset =
        isAppBuildUpdate ||
        seat.status !== 'idle' ||
        Number(seat.pausedRemainingSeconds) > 0 ||
        Number(seat.targetSeconds) > 0 ||
        !seat.isReset ||
        rawComment === 'タップして操作・編集できます' ||
        !!seat.actionStatus ||
        !!seat.isShampooing ||
        Number(seat.checkTargetSeconds) > 0 ||
        (Array.isArray(seat.history) && seat.history.length > 0);
      if (needsZeroReset) {
        didSanitize = true;
        return {
          ...seat,
          status: 'idle',
          pausedRemainingSeconds: 0,
          targetSeconds: 0,
          initialMinutes: 0,
          targetEndTimestamp: null,
          isOver: false,
          isReset: true,
          timeUpTimestamp: null,
          escalationLevel: 0,
          actionStatus: null,
          isShampooing: false,
          assistantStaffName: '',
          assistantStaffConfirmed: false,
          helpProcess: null,
          isRecruiting: false,
          isNoHelpNeeded: false,
          checkStatus: 'stopped',
          checkTargetSeconds: null,
          checkTotalSeconds: null,
          checkInitialMinutes: null,
          checkEndTimestamp: null,
          checkPausedRemainingSeconds: null,
          checkStaffName: '',
          isCheckCompleted: false,
          collapsedAtEnd: null,
          comment: rawComment === 'タップして操作・編集できます' ? '' : (seat.comment || ''),
          history: [],
          buildUpdateNormalized: true,
        };
      }
    }
    if (Array.isArray(seat.history) && seat.history.length > 0) {
      didSanitize = true;
      return {
        ...seat,
        history: [],
      };
    }
    return seat;
  });
  return { seats, didSanitize };
};

// ★ スタッフメンバーの正規化ヘルパー（一意のID管理・相手ニックネーム・任意設定の呼び名を両立）
export const normalizeStaffMembers = (list, currentUserId = null, existingMembers = null) => {
  if (!Array.isArray(list)) return [];
  const prevList = Array.isArray(existingMembers) ? existingMembers : _cachedStaffMembers;
  return list.map((m, idx) => {
    if (!m) return null;
    if (typeof m === 'string') {
      return {
        id: `mem_legacy_${idx}_${m}`,
        originalNickname: m,
        customNickname: m,
        role: 'assistant',
        joinedAt: Date.now(),
      };
    }
    const uid = m.user_id || m.id || `mem_${Date.now()}_${idx}`;
    const name = m.display_name || m.originalNickname || m.customNickname || m.name || m.nickname || 'スタッフ';
    const isMe = currentUserId ? (m.user_id === currentUserId || uid === currentUserId) : !!m.isMe;
    const prevMatch = Array.isArray(prevList)
      ? prevList.find(
          (p) =>
            p &&
            typeof p === 'object' &&
            ((uid && (p.id === uid || p.user_id === uid)) ||
              (m.id && p.cloudMemberId === m.id) ||
              (p.originalNickname && p.originalNickname === name))
        )
      : null;
    const preservedCustom =
      m.customNickname ||
      (prevMatch && prevMatch.customNickname && prevMatch.customNickname !== prevMatch.originalNickname
        ? prevMatch.customNickname
        : name);
    return {
      id: uid,
      cloudMemberId: m.id || prevMatch?.cloudMemberId,
      user_id: m.user_id || prevMatch?.user_id,
      originalNickname: name,
      customNickname: preservedCustom,
      inviteCode: m.inviteCode || prevMatch?.inviteCode || '',
      role: m.role || prevMatch?.role || 'assistant',
      isMe: isMe,
      joinedAt: m.joined_at ? new Date(m.joined_at).getTime() : (m.joinedAt || prevMatch?.joinedAt || Date.now()),
    };
  }).filter(Boolean);
};

export const getMemberDisplayName = (m) => {
  if (!m) return '';
  if (typeof m === 'string') return m;
  return m.customNickname || m.display_name || m.originalNickname || m.name || 'スタッフ';
};

// キャッシュされた最新スタッフメンバー・座席・ユーザー名・メインタイマー一覧
let _cachedStaffMembers = [];
let _cachedCurrentSeats = [];
let _cachedUserName = 'スタイリスト';
let _cachedMyUserId = null;
let _cachedIsSalonOwner = true;
let _cachedActiveSalonId = 'workspace-free';
let _cachedMainTimerState = null;
let _syncDebounceTimer = null;
let _pendingWatchPayload = null;
// Watch 側アラーム音の設定（設定画面の値を SYNC_SEATS に含めて Watch へ届ける）
let _watchAlarmSound = false;

export const updateCachedMainTimerState = (state) => {
  _cachedMainTimerState = state;
};

const isCloudUUID = (val) =>
  typeof val === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

// ★ 自他判定・サロンオーナー権限判定の共通純粋関数（スマホ画面・Watchペイロード双方で使用）
export const checkIsStaffNameMe = (
  name,
  currentUserName = _cachedUserName,
  currentMyUserId = _cachedMyUserId,
  currentStaffMembers = _cachedStaffMembers
) => {
  const n = (name || '').trim();
  if (!n || n === 'ヘルプなし' || n === 'none' || n === '未定' || n === '募集中') return false;
  if (n === '自分' || n === 'あなた') return true;
  const me = (currentUserName || 'スタイリスト').trim();
  if (me && n === me) return true;
  if (Array.isArray(currentStaffMembers)) {
    const myMember = currentStaffMembers.find(
      (m) =>
        m &&
        (m.isMe ||
          (currentMyUserId &&
            (m.userId === currentMyUserId || m.user_id === currentMyUserId || m.id === currentMyUserId)))
    );
    if (myMember) {
      if (myMember.originalNickname && n === myMember.originalNickname.trim()) return true;
      if (myMember.customNickname && n === myMember.customNickname.trim()) return true;
      if (myMember.name && n === myMember.name.trim()) return true;
    }
  }
  return false;
};

export const checkIsMainStaffOfSeat = (
  seat,
  currentUserName = _cachedUserName,
  currentMyUserId = _cachedMyUserId,
  currentStaffMembers = _cachedStaffMembers
) => {
  if (!seat) return false;
  // createdBy と自分の userId が両方ある場合は UUID 照合を最優先（同名の初期表示名「スタイリスト」同士でも他人の席を誤って「自分」にしない）
  if (seat.createdBy && currentMyUserId) {
    return seat.createdBy === currentMyUserId;
  }
  const creator = (seat.colorStaffName || '').trim();
  if (!creator) return false;
  return checkIsStaffNameMe(creator, currentUserName, currentMyUserId, currentStaffMembers);
};

export const checkIsSalonOwner = (salon, uid = _cachedMyUserId) => {
  if (!salon) return true;
  if (salon.id === 'workspace-free' || salon.id === 'workspace-pro-demo') return true;
  if (salon.ownerUserId && uid) {
    return salon.ownerUserId === uid;
  }
  if (salon.role) {
    return salon.role === 'owner';
  }
  return true;
};

// ★ サロンID別の席データ保存キー＆オフライン削除待ちキュー（アップデート・再起動・サロン切替時の席消失を完全防止）
const SALON_SEATS_MIGRATED_KEY = '@salon_seats_migrated_v2';
export const getSalonSeatsStorageKey = (salonId) => `@salon_saved_seats_${salonId || 'workspace-free'}`;
export const getPendingDeletedSeatsKey = (salonId) => `@salon_pending_deleted_seats_${salonId || 'workspace-free'}`;

export const persistSeatsForSalonId = async (salonId, seatsList, isOwner = true) => {
  const resolvedId = salonId || 'workspace-free';
  const safeList = Array.isArray(seatsList) ? seatsList : [];
  await AsyncStorage.setItem(getSalonSeatsStorageKey(resolvedId), JSON.stringify(safeList));
  // オーナーサロンの有効席データは旧キーにもミラー保持（ゲストの空配列や他サロンの席で上書き汚染しない）
  if (isOwner && safeList.length > 0) {
    await AsyncStorage.setItem('@salon_saved_seats', JSON.stringify(safeList));
  }
};

export const readSeatsForSalonFromStorage = async (
  salon,
  activeUserName = 'スタイリスト',
  activeUserId = null,
  savedCurrentSalonId = null
) => {
  const salonId = salon?.id || 'workspace-free';
  const isOwner = checkIsSalonOwner(salon, activeUserId);
  const perSalonKey = getSalonSeatsStorageKey(salonId);

  try {
    const perSalonJson = await AsyncStorage.getItem(perSalonKey);
    if (perSalonJson !== null) {
      const parsed = JSON.parse(perSalonJson);
      if (Array.isArray(parsed) && (parsed.length > 0 || !isOwner)) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('Failed to parse per-salon saved seats:', e);
  }

  // オーナーサロンで workspace-free → クラウドUUID 昇格前後や並行マウント時の引き継ぎ保護
  if (isOwner && salonId !== 'workspace-free') {
    try {
      const freeKeyJson = await AsyncStorage.getItem(getSalonSeatsStorageKey('workspace-free'));
      if (freeKeyJson) {
        const freeParsed = JSON.parse(freeKeyJson);
        if (Array.isArray(freeParsed) && freeParsed.length > 0) {
          const migratedTarget = await AsyncStorage.getItem(SALON_SEATS_MIGRATED_KEY);
          if (!migratedTarget || migratedTarget === 'workspace-free' || migratedTarget === salonId) {
            await AsyncStorage.setItem(perSalonKey, JSON.stringify(freeParsed));
            await AsyncStorage.setItem(SALON_SEATS_MIGRATED_KEY, salonId);
            return freeParsed;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to migrate workspace-free saved seats:', e);
    }
  }

  // サロン別キーが未作成の場合: 旧バージョン @salon_saved_seats からの安全な初回マイグレーション
  try {
    const legacyJson = await AsyncStorage.getItem('@salon_saved_seats');
    if (legacyJson) {
      const legacyParsed = JSON.parse(legacyJson);
      if (Array.isArray(legacyParsed) && legacyParsed.length > 0) {
        if (isOwner) {
          const migratedTarget = await AsyncStorage.getItem(SALON_SEATS_MIGRATED_KEY);
          if (!migratedTarget || migratedTarget === salonId || migratedTarget === 'workspace-free' || salonId === 'workspace-free') {
            await AsyncStorage.setItem(perSalonKey, JSON.stringify(legacyParsed));
            await AsyncStorage.setItem(SALON_SEATS_MIGRATED_KEY, salonId);
            return legacyParsed;
          }
        } else if (
          savedCurrentSalonId === salonId &&
          legacyParsed.some((s) => isCloudUUID(s?.cloudTimerId || s?.id))
        ) {
          // ゲスト参加中でアップデート直後の場合、クラウドUUID席キャッシュのみ安全に引き継ぐ（サンプル席は除外）
          const cloudCachedOnly = legacyParsed.filter((s) => isCloudUUID(s?.cloudTimerId || s?.id));
          await AsyncStorage.setItem(perSalonKey, JSON.stringify(cloudCachedOnly));
          return cloudCachedOnly;
        }
      }
    }
  } catch (e) {
    console.warn('Failed to migrate legacy @salon_saved_seats:', e);
  }

  // ゲスト（参加者）は初期サンプル「1番席」を絶対に生成せず空配列でクラウド同期を待つ
  if (!isOwner) {
    return [];
  }
  return getDefaultInitialSeats(activeUserName);
};

export const readPendingDeletedSeats = async (salonId) => {
  try {
    const raw = await AsyncStorage.getItem(getPendingDeletedSeatsKey(salonId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const writePendingDeletedSeats = async (salonId, list) => {
  try {
    const key = getPendingDeletedSeatsKey(salonId);
    if (!Array.isArray(list) || list.length === 0) {
      await AsyncStorage.removeItem(key);
    } else {
      await AsyncStorage.setItem(key, JSON.stringify(list));
    }
  } catch {}
};

export const formatSeatsPayload = (seatsList) => {
  if (!Array.isArray(seatsList) || seatsList.length === 0) return [];
  const validItems = seatsList.filter((s) => s && typeof s === 'object' && s.id);
  const usedNums = new Set();
  let maxUsed = 0;
  const resolvedSeatNumbers = new Array(validItems.length).fill(0);

  // 第1パス: 席名に数字を含む席（「1番席」など）の番号を優先予約
  validItems.forEach((s, idx) => {
    const match = s.seatLabel ? String(s.seatLabel).match(/\d+/) : null;
    if (match) {
      const n = parseInt(match[0], 10);
      if (n > 0 && !usedNums.has(n)) {
        resolvedSeatNumbers[idx] = n;
        usedNums.add(n);
        if (n > maxUsed) maxUsed = n;
      }
    }
  });

  // 第2パス: 数字を含まない席（「個室」「フリー枠」など）や重複番号席に衝突しない一意の seatNumber を割り当て
  validItems.forEach((s, idx) => {
    if (resolvedSeatNumbers[idx] > 0) return;
    const explicitNum = Number(s.seatNumber);
    if (Number.isInteger(explicitNum) && explicitNum > 0 && !usedNums.has(explicitNum)) {
      resolvedSeatNumbers[idx] = explicitNum;
      usedNums.add(explicitNum);
      if (explicitNum > maxUsed) maxUsed = explicitNum;
    } else {
      maxUsed += 1;
      resolvedSeatNumbers[idx] = maxUsed;
      usedNums.add(maxUsed);
    }
  });

  return validItems
    .map((s, index) => {
      const seatNum = resolvedSeatNumbers[index];

      const rawTargetEnd = Number(s.targetEndTimestamp) || 0;
      const isRunning = s.status === 'running' && rawTargetEnd > 0;
      const targetEnd = isRunning ? rawTargetEnd : 0;
      const pausedRem = !isRunning
        ? (typeof s.pausedRemainingSeconds === 'number' ? Math.max(0, Math.floor(s.pausedRemainingSeconds)) : 0)
        : Math.max(0, Math.floor((targetEnd - Date.now()) / 1000));

      const isZero = !isRunning && pausedRem <= 0;
      const isCollapsedSeat = !isRunning && (s.status === 'idle' || isZero || s.collapsedAtEnd != null);
      const isNoHelp = !isZero && !isCollapsedSeat && (!!s.isNoHelpNeeded || s.assistantStaffName === 'ヘルプなし' || s.assistantStaffName === 'none');
      const actionInfo = getActionStatusInfo(s.actionStatus, s.isShampooing);

      return {
        id: String(s.id),
        seatNumber: seatNum,
        seatLabel: s.seatLabel || `${seatNum}番席`,
        creatorName: s.colorStaffName || 'スタイリスト',
        totalSeconds: isZero ? 0 : (s.targetSeconds || 600),
        targetEndTimestamp: targetEnd,
        isRunning: isRunning,
        pausedRemainingSeconds: pausedRem,
        helpProcess: (isZero || isCollapsedSeat || isNoHelp) ? '' : (actionInfo ? actionInfo.label : (s.helpProcess || (s.assistantStaffName ? 'シャンプー' : ''))),
        shampooStaff: (isNoHelp || isZero || isCollapsedSeat) ? '' : (s.assistantStaffName || ''),
        isRecruiting: !isNoHelp && !isZero && !isCollapsedSeat && !!s.isRecruiting && !s.assistantStaffName && isRunning,
        isNoHelpNeeded: isNoHelp,
        status: (isZero || isCollapsedSeat) ? 'normal' : (actionInfo ? actionInfo.id : 'normal'),
        checkTargetSeconds: s.checkTargetSeconds ? Number(s.checkTargetSeconds) : 0,
        checkEndTimestamp: isRunning && s.checkEndTimestamp ? Number(s.checkEndTimestamp) : 0,
        checkProcess: sanitizeCheckProcess(s.checkProcess),
        checkStaffName: s.checkStaffName || '',
        isCheckCompleted: s.checkStatus === 'completed',
        watchAlarmSoundEnabled: !!s.watchAlarmSoundEnabled,
        alarmSoundEnabled: !!s.alarmSoundEnabled,
        isCollapsed: isCollapsedSeat,
        isCreatorMe: checkIsMainStaffOfSeat(s, _cachedUserName, _cachedMyUserId, _cachedStaffMembers),
        lastStoppedAt: !isRunning ? Math.round(Number(s.lastStoppedAt) || 0) : 0,
        lastStoppedTargetEndTimestamp: !isRunning ? Math.round(Number(s.lastStoppedTargetEndTimestamp) || 0) : 0,
      };
    })
    .filter(Boolean);
};

// ★ アプリ起動時（サロンタブ未選択時）でも客席キャッシュを確実に用意するヘルパー（並行呼び出しの競合防止ガード付き）
let _ensureSeatsInFlightPromise = null;

export const ensureSalonSeatsCached = async () => {
  if (Array.isArray(_cachedCurrentSeats) && _cachedCurrentSeats.length > 0) {
    return _cachedCurrentSeats;
  }
  if (_ensureSeatsInFlightPromise) {
    return _ensureSeatsInFlightPromise;
  }
  _ensureSeatsInFlightPromise = (async () => {
    try {
      const [activeUserId, isAppBuildUpdate] = await Promise.all([
        getOrCreateUserId(),
        detectSalonBuildUpdateOnce(),
      ]);
      _cachedMyUserId = activeUserId;

      const savedName = (await AsyncStorage.getItem('@assist_timer_user_name')) || (await AsyncStorage.getItem('@salon_user_name'));
      const activeUserName = (savedName && savedName.trim()) ? savedName.trim() : 'スタイリスト';
      _cachedUserName = activeUserName;

      let activeSalon = null;
      const savedCurrentSalonId = await AsyncStorage.getItem('@salon_current_salon_id');
      try {
        const savedSalonsJson = await AsyncStorage.getItem('@salon_saved_salons');
        if (savedSalonsJson) {
          const parsedSalons = JSON.parse(savedSalonsJson);
          if (Array.isArray(parsedSalons) && parsedSalons.length > 0) {
            activeSalon = parsedSalons.find((s) => s.id === savedCurrentSalonId) || parsedSalons[0];
          }
        }
      } catch {}
      const isOwner = checkIsSalonOwner(activeSalon, activeUserId);
      _cachedIsSalonOwner = isOwner;
      _cachedActiveSalonId = activeSalon?.id || 'workspace-free';

      const savedMembersJson = await AsyncStorage.getItem('@salon_staff_members');
      if (savedMembersJson) {
        try {
          const parsed = JSON.parse(savedMembersJson);
          if (Array.isArray(parsed)) {
            _cachedStaffMembers = normalizeStaffMembers(parsed, activeUserId);
          }
        } catch (e) {
          console.warn('Failed to parse saved staff members in ensureSalonSeatsCached', e);
        }
      }

      let loadedSeats = await readSeatsForSalonFromStorage(
        activeSalon,
        activeUserName,
        activeUserId,
        savedCurrentSalonId
      );

      // ★ 安全サニタイズ: 稼働中タイマー（3時間以内）はそのまま保護し、新規アップデート時の非稼働席・旧20分サンプル・3時間超過放置席のみ 00:00 へ正規化
      const { seats: sanitizedSeats, didSanitize } = sanitizeLoadedSeats(loadedSeats, { isAppBuildUpdate });
      loadedSeats = sanitizedSeats;
      if (didSanitize) {
        persistSeatsForSalonId(_cachedActiveSalonId, loadedSeats, isOwner).catch(() => {});
      }

      _cachedCurrentSeats = loadedSeats;
      return loadedSeats;
    } catch (e) {
      console.warn('[SalonWorkScreen] ensureSalonSeatsCached failed:', e);
      const defaultSeats = _cachedIsSalonOwner ? getDefaultInitialSeats(_cachedUserName || 'スタイリスト') : [];
      _cachedCurrentSeats = defaultSeats;
      return defaultSeats;
    } finally {
      _ensureSeatsInFlightPromise = null;
    }
  })();
  return _ensureSeatsInFlightPromise;
};

// ★ サロンタブ未マウント時（HomeScreen表示直後）に Watch から REQUEST_SYNC（watchActiveSeats 同梱）が届いた場合も、
//   客席キャッシュとストレージへ即時引き継ぎ、SYNC_MAIN_TIMER の返信で Watch 側の稼働中客席を 00:00 上書きしないよう保証
export const adoptWatchActiveSeatsIntoCache = async (payload) => {
  try {
    const incomingWatchSeats = payload?.watchActiveSeats || payload?.extra?.watchActiveSeats;
    if (!Array.isArray(incomingWatchSeats) || incomingWatchSeats.length === 0) return false;
    const baseSeats = await ensureSalonSeatsCached();
    if (!Array.isArray(baseSeats) || baseSeats.length === 0) return false;

    const nowMs = Date.now();
    const cutoffMs = nowMs - 3 * 3600 * 1000;
    const watchUser = (payload?.userName || payload?.extra?.userName || _cachedUserName || 'スタイリスト').trim();
    const nextSeats = [...baseSeats];
    let didAdopt = false;

    incomingWatchSeats.forEach((ws) => {
      if (!ws || typeof ws !== 'object') return;
      const wsEnd = Math.round(Number(ws.targetEndTimestamp || 0));
      if (wsEnd <= cutoffMs) return;
      const wsId = String(ws.id || '');
      const wsNum = Number(ws.seatNumber) || 0;
      if (
        WatchConnectivity?.isSeatTimerEndStopped &&
        ((wsId && WatchConnectivity.isSeatTimerEndStopped(wsId, wsEnd)) ||
          (wsNum > 0 && WatchConnectivity.isSeatTimerEndStopped(`seat-${wsNum}`, wsEnd)))
      ) {
        return;
      }
      const idx = nextSeats.findIndex((s) => {
        if (!s) return false;
        if (wsId && (s.id === wsId || s.cloudTimerId === wsId)) return true;
        if (wsNum > 0 && Number(s.seatNumber) === wsNum) return true;
        const sDigits = String(s.seatLabel || '').match(/\d+/);
        return wsNum > 0 && sDigits && parseInt(sDigits[0], 10) === wsNum;
      });
      if (idx >= 0 && nextSeats[idx].status !== 'running') {
        const targetSec = Math.max(10, Math.round(Number(ws.totalSeconds) || 600));
        const chkSec = Math.round(Number(ws.checkTargetSeconds || 0));
        const chkEnd = Math.round(Number(ws.checkEndTimestamp || 0));
        const hasActiveChk = chkSec > 0 && chkEnd > cutoffMs;
        const prevSeat = nextSeats[idx];
        nextSeats[idx] = {
          ...prevSeat,
          status: 'running',
          colorStaffName: watchUser || 'スタイリスト',
          createdBy: _cachedMyUserId || null,
          targetSeconds: targetSec,
          initialMinutes: Math.max(1, Math.round(targetSec / 60)),
          targetEndTimestamp: wsEnd,
          pausedRemainingSeconds: null,
          isReset: false,
          isOver: wsEnd <= nowMs,
          timeUpTimestamp: wsEnd <= nowMs ? wsEnd : null,
          escalationLevel: 0,
          collapsedAtEnd: null,
          buildUpdateNormalized: false,
          dirtySync: true,
          history: [
            {
              id: `h-${nowMs}-${idx}`,
              time: formatHistoryTimeHHMM(nowMs),
              text: hasActiveChk
                ? `Apple Watchからタイマー開始 (${Math.max(1, Math.round(targetSec / 60))}分 / チェック${Math.max(1, Math.round(chkSec / 60))}分)`
                : `Apple Watchからタイマー開始 (${Math.max(1, Math.round(targetSec / 60))}分)`,
              type: 'timer',
            },
          ],
          ...(hasActiveChk
            ? {
                checkTargetSeconds: chkSec,
                checkTotalSeconds: chkSec,
                checkInitialMinutes: Math.max(1, Math.round(chkSec / 60)),
                checkEndTimestamp: chkEnd,
                checkStatus: chkEnd <= nowMs ? 'timeup' : 'running',
                isCheckCompleted: false,
                checkProcess: ws.checkProcess || prevSeat.checkProcess || 'チェック',
                checkStaffName: ws.checkStaffName || prevSeat.checkStaffName || '',
              }
            : {}),
        };
        didAdopt = true;
      }
    });

    if (didAdopt) {
      _cachedCurrentSeats = nextSeats;
      await persistSeatsForSalonId(_cachedActiveSalonId, nextSeats, _cachedIsSalonOwner).catch(() => {});
    }
    return didAdopt;
  } catch (e) {
    console.warn('[SalonWorkScreen] adoptWatchActiveSeatsIntoCache error:', e);
    return false;
  }
};

// ★ Apple Watchへのメインタイマー専用同期ヘルパー（最新客席キャッシュを保持してコンテキスト上書き消失を完全防止）
export const syncMainTimerToWatch = async (mainState = null, options = {}) => {
  if (Platform.OS !== 'ios') return;
  try {
    const state = mainState || _cachedMainTimerState;
    if (!state) return;

    // ★ サロンタブをまだ開いていない場合でも、客席キャッシュ（保存データまたは1番席サンプル）を自動事前ロード！
    if (!Array.isArray(_cachedCurrentSeats) || _cachedCurrentSeats.length === 0) {
      await ensureSalonSeatsCached();
    }

    const isCountUpEnabled = state.isCountUpEnabled !== undefined ? !!state.isCountUpEnabled : true;
    const isPreCountingDown = !!state.isPreCountingDown;
    let isRunning = !!state.isRunning;
    let isCountUp = isRunning && !!state.isCountUp && isCountUpEnabled;
    const prepEnd = isPreCountingDown
      ? (state.prepEndTimestamp || (Date.now() + (state.preCountdownSeconds || state.countdownConfigSeconds || 5) * 1000))
      : 0;
    let isAutoFinished = !!state.isAutoFinished;
    let targetEnd = isRunning
      ? (state.targetEndTimestamp || (
          isCountUp ? Date.now() - (state.remainingTime || 0) * 1000 : Date.now() + (state.remainingTime || 0) * 1000
        ))
      : (isPreCountingDown
          ? (state.targetEndTimestamp || (prepEnd + (state.targetTime || state.remainingTime || 600) * 1000))
          : (isAutoFinished ? (state.targetEndTimestamp || 0) : 0));

    if (isRunning && !isPreCountingDown && !isCountUpEnabled && targetEnd > 0 && targetEnd <= Date.now()) {
      isRunning = false;
      isCountUp = false;
      isAutoFinished = true;
    }

    const resetAgeMs = state.lastResetAt ? (Date.now() - Number(state.lastResetAt)) : Infinity;
    const isExplicitReset = !isRunning && !isPreCountingDown && !!state.isExplicitReset && resetAgeMs < 5000;
    const isExplicitStop = !isRunning && !isPreCountingDown && !!state.explicitStop && resetAgeMs < 5000;
    const isPausedMidCountdown = !isRunning && !isPreCountingDown && !!state.isPaused && !isExplicitReset && !isAutoFinished;
    const pausedRem = !isRunning
      ? (isPausedMidCountdown && state.remainingTime != null
          ? Math.max(0, state.remainingTime)
          : (isPreCountingDown ? (state.targetTime || 600) : 0))
      : Math.max(0, Math.floor((targetEnd - Date.now()) / 1000));

    const mainTimerPayload = {
      id: 'main-timer',
      seatNumber: 0,
      seatLabel: 'メインタイマー',
      isMainTimer: true,
      creatorName: (_cachedUserName || 'スタイリスト').trim(),
      totalSeconds: state.targetTime || 600,
      targetEndTimestamp: Math.round(targetEnd || 0),
      lastResetTargetEndTimestamp: Math.round(state.lastResetTargetEndTimestamp || 0),
      lastResetAt: Math.round(state.lastResetAt || 0),
      isRunning: isRunning,
      pausedRemainingSeconds: pausedRem,
      isCountUp: isCountUp,
      isCountUpEnabled: isCountUpEnabled,
      isAutoFinished: isAutoFinished,
      isExplicitReset: isExplicitReset,
      genre: state.genre || '',
      isPreCountingDown: isPreCountingDown,
      preCountdownSeconds: state.preCountdownSeconds || 0,
      isCountdownConfigEnabled: !!state.isCountdownConfigEnabled,
      countdownConfigSeconds: state.countdownConfigSeconds || 5,
      prepEndTimestamp: Math.round(isPreCountingDown ? prepEnd : (state.prepEndTimestamp || 0)),
      isPaused: !!state.isPaused,
      explicitStop: isExplicitStop,
    };

    const flatMembers = Array.isArray(_cachedStaffMembers)
      ? _cachedStaffMembers.map((m) => (typeof m === 'string' ? m : (m.customNickname || m.originalNickname || m.name || 'スタッフ')))
      : [];

    const watchPayload = {
      type: 'SYNC_MAIN_TIMER',
      userName: (_cachedUserName || 'スタイリスト').trim(),
      members: flatMembers,
      isSalonOwner: _cachedIsSalonOwner,
      watchAlarmSound: _watchAlarmSound,
      timestamp: Date.now(),
      mainTimer: mainTimerPayload,
      ...(options.highPriorityWake || isExplicitStop || isExplicitReset ? { highPriorityWake: true } : {}),
      ...(Array.isArray(_cachedCurrentSeats) && _cachedCurrentSeats.length > 0
        ? { _contextSeats: formatSeatsPayload(_cachedCurrentSeats) }
        : {}),
    };

    // ★ 安全設計: メインタイマー同期時は客席（seats）キーを含めない。
    //   Watch側は seats キーが無い場合、既存の客席タイマーを維持したままメインタイマーのみを安全更新するため、
    //   客席タイマーの上書き停止・強制消火を完全に防止できる。

    WatchConnectivity.syncData(watchPayload).catch(() => {});
  } catch (e) {
    console.warn('[WatchConnectivity] syncMainTimerToWatch failed:', e);
  }
};

// ★ Apple Watchへの客席・メインタイマー・スタッフ名リアルタイム同期ヘルパー（即時送信対応＆デバウンス両立）
export const syncSeatsToWatch = async (currentSeats = null, currentName = null, currentMembers = null, options = {}) => {
  if (Platform.OS !== 'ios') return;
  try {
    let validSeats = null;
    if (options.forceEmpty) {
      validSeats = [];
      _cachedCurrentSeats = [];
    } else if (Array.isArray(currentSeats) && currentSeats.length > 0) {
      _cachedCurrentSeats = currentSeats;
      validSeats = currentSeats;
    } else if (Array.isArray(_cachedCurrentSeats) && _cachedCurrentSeats.length > 0) {
      // currentSeats が空配列や未初期化でも、既存の有効な客席キャッシュがあるなら絶対に消さず保持！
      validSeats = _cachedCurrentSeats;
    } else if (currentSeats !== null && Array.isArray(currentSeats) && _cachedCurrentSeats.length === 0) {
      validSeats = [];
      _cachedCurrentSeats = [];
    }

    if (currentName) {
      _cachedUserName = currentName;
    } else {
      currentName = _cachedUserName;
    }

    let finalMembers = currentMembers;
    if (Array.isArray(finalMembers)) {
      _cachedStaffMembers = finalMembers;
    } else if (_cachedStaffMembers.length > 0) {
      finalMembers = _cachedStaffMembers;
    } else {
      try {
        const saved = await AsyncStorage.getItem('@salon_staff_members');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            finalMembers = parsed;
            _cachedStaffMembers = parsed;
          }
        }
      } catch {}
    }

    let mainTimerPayload = null;
    if (_cachedMainTimerState) {
      const isCountUpEnabled = _cachedMainTimerState.isCountUpEnabled !== undefined ? !!_cachedMainTimerState.isCountUpEnabled : true;
      const isPreCountingDown = !!_cachedMainTimerState.isPreCountingDown;
      let isRunning = !!_cachedMainTimerState.isRunning;
      let isCountUp = isRunning && !!_cachedMainTimerState.isCountUp && isCountUpEnabled;
      const prepEnd = isPreCountingDown
        ? (_cachedMainTimerState.prepEndTimestamp || (Date.now() + (_cachedMainTimerState.preCountdownSeconds || _cachedMainTimerState.countdownConfigSeconds || 5) * 1000))
        : 0;
      let isAutoFinished = !!_cachedMainTimerState.isAutoFinished;
      let targetEnd = isRunning
        ? (_cachedMainTimerState.targetEndTimestamp || (
            isCountUp ? Date.now() - (_cachedMainTimerState.remainingTime || 0) * 1000 : Date.now() + (_cachedMainTimerState.remainingTime || 0) * 1000
          ))
        : (isPreCountingDown
            ? (_cachedMainTimerState.targetEndTimestamp || (prepEnd + (_cachedMainTimerState.targetTime || _cachedMainTimerState.remainingTime || 600) * 1000))
            : (isAutoFinished ? (_cachedMainTimerState.targetEndTimestamp || 0) : 0));

      if (isRunning && !isPreCountingDown && !isCountUpEnabled && targetEnd > 0 && targetEnd <= Date.now()) {
        isRunning = false;
        isCountUp = false;
        isAutoFinished = true;
      }

      // ★ SYNC_SEATS は客席同期パケットであるため、過去のメインタイマー停止フラグ（isExplicitReset / explicitStop）が
      //   クラウド同期のたびに再送されてWatch主導のメインタイマーを強制停止させないよう、直近2秒以内のリセット時のみ有効化する
      const resetAgeMs = _cachedMainTimerState.lastResetAt ? (Date.now() - Number(_cachedMainTimerState.lastResetAt)) : Infinity;
      const isRecentExplicitReset = !isRunning && !isPreCountingDown && !!_cachedMainTimerState.isExplicitReset && resetAgeMs < 2000;
      const isRecentExplicitStop = !isRunning && !isPreCountingDown && !!_cachedMainTimerState.explicitStop && resetAgeMs < 2000;
      const isPausedMidCountdown = !isRunning && !isPreCountingDown && !!_cachedMainTimerState.isPaused && !isRecentExplicitReset && !isAutoFinished;
      const pausedRem = !isRunning
        ? (isPausedMidCountdown && _cachedMainTimerState.remainingTime != null
            ? Math.max(0, _cachedMainTimerState.remainingTime)
            : (isPreCountingDown ? (_cachedMainTimerState.targetTime || 600) : 0))
        : Math.max(0, Math.floor((targetEnd - Date.now()) / 1000));

      mainTimerPayload = {
        id: 'main-timer',
        seatNumber: 0,
        seatLabel: 'メインタイマー',
        isMainTimer: true,
        creatorName: (currentName || 'スタイリスト').trim(),
        totalSeconds: _cachedMainTimerState.targetTime || 600,
        targetEndTimestamp: Math.round(targetEnd || 0),
        lastResetTargetEndTimestamp: Math.round(_cachedMainTimerState.lastResetTargetEndTimestamp || 0),
        lastResetAt: Math.round(_cachedMainTimerState.lastResetAt || 0),
        isRunning: isRunning,
        pausedRemainingSeconds: pausedRem,
        isCountUp: isCountUp,
        isCountUpEnabled: isCountUpEnabled,
        isAutoFinished: isAutoFinished,
        isExplicitReset: isRecentExplicitReset,
        genre: _cachedMainTimerState.genre || '',
        isPreCountingDown: isPreCountingDown,
        preCountdownSeconds: _cachedMainTimerState.preCountdownSeconds || 0,
        isCountdownConfigEnabled: !!_cachedMainTimerState.isCountdownConfigEnabled,
        countdownConfigSeconds: _cachedMainTimerState.countdownConfigSeconds || 5,
        prepEndTimestamp: Math.round(isPreCountingDown ? prepEnd : (_cachedMainTimerState.prepEndTimestamp || 0)),
        isPaused: !!_cachedMainTimerState.isPaused,
        explicitStop: isRecentExplicitStop,
      };
    }

    const flatMembers = Array.isArray(finalMembers)
      ? finalMembers.map((m) => (typeof m === 'string' ? m : (m.customNickname || m.originalNickname || m.name || 'スタッフ')))
      : [];

    const watchPayload = {
      type: 'SYNC_SEATS',
      userName: (currentName || 'スタイリスト').trim(),
      members: flatMembers,
      isSalonOwner: _cachedIsSalonOwner,
      watchAlarmSound: _watchAlarmSound,
      timestamp: Date.now(),
      ...(options.highPriorityWake ? { highPriorityWake: true } : {}),
      ...(mainTimerPayload ? { mainTimer: mainTimerPayload } : {}),
    };

    // ★ 相手へのリアルタイム通知（タイマー停止、チェック完了、アラーム停止、シャンプー/コーミング移行等）
    if (options.notification && typeof options.notification === 'object') {
      watchPayload.notification = {
        id: String(options.notification.id || ''),
        text: String(options.notification.text || ''),
        color: String(options.notification.color || '#30D158'),
        sourceUser: String(options.notification.sourceUser || currentName || 'スタイリスト').trim(),
      };
    }

    // ★ 客席データが有効な場合のみ seats を追加。未指定（null）の時は seats を含めず客席タイマーを保護
    if (validSeats !== null) {
      watchPayload.seats = formatSeatsPayload(validSeats);
      if (options.forceEmpty && validSeats.length === 0) {
        watchPayload.clearAllSeats = true;
      }
    }

    if (options.immediate || options.notification || options.highPriorityWake) {
      if (_syncDebounceTimer) {
        clearTimeout(_syncDebounceTimer);
        _syncDebounceTimer = null;
      }
      _pendingWatchPayload = null;
      WatchConnectivity.syncData(watchPayload).catch(() => {});
      return;
    }

    _pendingWatchPayload = watchPayload;
    if (_syncDebounceTimer) {
      clearTimeout(_syncDebounceTimer);
    }
    _syncDebounceTimer = setTimeout(() => {
      if (_pendingWatchPayload) {
        WatchConnectivity.syncData(_pendingWatchPayload).catch(() => {});
        _pendingWatchPayload = null;
      }
    }, 150);
  } catch (e) {
    console.warn('[WatchConnectivity] syncSeatsToWatch failed:', e);
  }
};

// サロン・グループ・個人無料枠の切り替え可能な固定席マルチタイマー画面
export default function SalonWorkScreen() {
  const { 
    isEcoMode,
    mainTimerState,
    requestMainTimerAction,
    showGlobalPeerToast,
    isAlarmSoundEnabled,
    isWatchAlarmSoundEnabled,
    isPhoneAlarmForWatchSeats,
  } = useContext(AppContext);

  // テーマカラー設定
  const theme = {
    bg: isEcoMode ? '#000000' : '#F5F5F7',
    cardBg: isEcoMode ? '#1C1C1E' : '#FFFFFF',
    cardBorder: isEcoMode ? '#2C2C2E' : '#E5E5EA',
    textPrimary: isEcoMode ? '#FFFFFF' : '#1C1C1E',
    textSecondary: isEcoMode ? '#8E8E93' : '#687076',
    textTertiary: isEcoMode ? '#636366' : '#8E8E93',
    accent: isEcoMode ? '#64D2FF' : '#007AFF',
    accentLight: isEcoMode ? '#15232D' : '#F0F8FF',
    accentBorder: isEcoMode ? '#1E3A4C' : '#B9DCFF',
    success: '#34C759',
    successLight: isEcoMode ? '#132B1A' : '#EBFCEF',
    warning: '#FF9500',
    warningLight: isEcoMode ? '#2B2011' : '#FFF8EB',
    danger: '#FF3B30',
    dangerLight: isEcoMode ? '#2B1313' : '#FFEEEE',
    shampoo: '#AF52DE',
    shampooLight: isEcoMode ? '#2A1838' : '#F8EEFF',
    shampooBorder: isEcoMode ? '#4F236E' : '#DDB8FF',
    inputBg: isEcoMode ? '#2C2C2E' : '#F2F2F7',
    idleRowBg: isEcoMode ? '#161618' : '#FFFFFF',
    idleRowBorder: isEcoMode ? '#262628' : '#EAEAEF',
  };

  // ユーザー・サロン状態
  const [userName, setUserName] = useState('スタイリスト');
  const [myUserId, setMyUserId] = useState(null);
  const [initialFreeSalon] = useState(() => createDefaultFreeSalon());
  const [currentSalon, setCurrentSalon] = useState(initialFreeSalon);
  const [savedSalons, setSavedSalons] = useState([initialFreeSalon]);
  const [filterMode, setFilterMode] = useState('all'); // 'all' | 'my'
  const [now, setNow] = useState(Date.now());

  // 固定席マスター＆タイマーリスト
  // status: 'idle' (待機中/最小化) | 'running' (放置中) | 'paused' (一時停止) | 'over' (超過)
  const [seats, setSeats] = useState([]);

  // モーダル表示状態
  const [isSwitcherModalVisible, setIsSwitcherModalVisible] = useState(false);
  const [switcherSubView, setSwitcherSubView] = useState('list'); // 'list' | 'inviteCode' (モーダル内画面切り替え)
  const [editingSalonForCode, setEditingSalonForCode] = useState(null); // コード変更対象のサロン
  const [inputNewInviteCode, setInputNewInviteCode] = useState(''); // 新しいコード入力バッファ
  const [isJoinCodeModalVisible, setIsJoinCodeModalVisible] = useState(false);
  const [isSetTimerModalVisible, setIsSetTimerModalVisible] = useState(false);
  const [isAddSeatModalVisible, setIsAddSeatModalVisible] = useState(false);
  const [isAssignMainTimerModalVisible, setIsAssignMainTimerModalVisible] = useState(false);
  const [isProModalVisible, setIsProModalVisible] = useState(false);
  // 🧪 開発・テスト用サロン共有モードフラグ（__DEV__ 時は初期値 true、本番リリースビルドでは自動非表示）
  const [isDevTestMode, setIsDevTestMode] = useState(typeof __DEV__ !== 'undefined' ? __DEV__ : false);
  const [isTimeActionModalVisible, setIsTimeActionModalVisible] = useState(false); // 時間変更 & タイマー停止確認モーダル
  const [actionTargetSeat, setActionTargetSeat] = useState(null); // 時間変更/停止の対象席
  // ヘルプ（アシスタント）柔軟指定・変更モーダル用
  const [isHelpAssignModalVisible, setIsHelpAssignModalVisible] = useState(false);
  const [helpAssignTargetSeat, setHelpAssignTargetSeat] = useState(null);
  const [helpInputStaffName, setHelpInputStaffName] = useState('');
  const [selectedHelpAction, setSelectedHelpAction] = useState(null); // 希望するヘルプ内容（シャンプー/コーミング/チェック等）

  // 第三者・代理確認モーダル用ステート
  const [isConfirmProxyModalVisible, setIsConfirmProxyModalVisible] = useState(false);
  const [confirmProxyTargetSeat, setConfirmProxyTargetSeat] = useState(null);

  // ★ サロン所属スタッフメンバー管理（一意ID・相手登録名・任意カスタム呼び名を保持）
  const [staffMembers, setStaffMembers] = useState([]);
  // ★ 席データ等の初期読み込み完了フラグ（Watchからの操作の受け取り開始条件）
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const [isMemberManageModalVisible, setIsMemberManageModalVisible] = useState(false);
  const [memberManageSection, setMemberManageSection] = useState('list'); // 'list' | 'join'
  const [inputJoinMemberCode, setInputJoinMemberCode] = useState('');
  const [inputJoinMemberNickname, setInputJoinMemberNickname] = useState('');
  const [editingMemberForNickname, setEditingMemberForNickname] = useState(null);
  const [inputMemberCustomNickname, setInputMemberCustomNickname] = useState('');
  const [isEditNicknameModalVisible, setIsEditNicknameModalVisible] = useState(false);

  // 施術履歴（タイムライン）手動追加モーダル用ステート
  const [isAddHistoryModalVisible, setIsAddHistoryModalVisible] = useState(false);
  const [addHistoryTargetSeat, setAddHistoryTargetSeat] = useState(null);
  const [inputHistoryText, setInputHistoryText] = useState('');

  // メインタイマー時間設定モーダル（共有タイマーと同じ分・秒トグルUI・サブタイマーなし）
  const [isMainTimerEditModalVisible, setIsMainTimerEditModalVisible] = useState(false);

  // 現在時刻HH:MMフォーマットヘルパー
  const getCurrentTimeFormatted = () => formatHistoryTimeHHMM();

  // ★ ユーザー指定: 全体タイマー右側ヘルプ担当ボタンの表示ラベル（「チェック未定」ではなく「ヘルプ未定 ▾」）
  const getHelpHeaderButtonLabel = (seat, isAlert) => {
    // ★ 00:00席・リセット席・未稼働停止席はヘルプを待機中として扱う（過去のヘルプ固定残り防止）
    const isZeroSeat = seat?.isReset || (seat?.status === 'paused' && (seat?.pausedRemainingSeconds <= 0 || seat?.pausedRemainingSeconds == null));
    if (isZeroSeat) {
      return '待機中 ▾';
    }

    const staff = (seat?.assistantStaffName || '').trim();
    const isNoHelp = staff === 'ヘルプなし' || staff === 'none';
    const actionInfo = getActionStatusInfo(seat?.actionStatus, seat?.isShampooing);
    const actionLabel = actionInfo ? actionInfo.label : null; // "コーミング", "シャンプー", "チェック", "呼び出し", "その他"

    if (isNoHelp) {
      return 'ヘルプなし ▾';
    }

    if (isAlert) {
      if (actionLabel && actionLabel !== 'チェック') {
        return `${actionLabel}未定 (あと1分) ▾`;
      }
      return 'ヘルプ未定 (あと1分) ▾';
    }

    // スタッフが決まっている場合（自分が担当の場合は2文字の「自分」に統一）
    if (staff && staff !== '') {
      const dispStaff = formatStaffForDisplay(staff);
      if (actionLabel && actionLabel !== 'チェック') {
        return `${actionLabel} ${dispStaff} ▾`;
      }
      return `${dispStaff} ▾`;
    }

    // スタッフが未定で、工程だけ指定されている場合（シャンプー、コーミング等。※チェックの場合は全体ヘルプと紛らわしいためヘルプ未定）
    if (actionLabel && actionLabel !== 'チェック') {
      return `${actionLabel}未定 ▾`;
    }

    // ★ ユーザー指定: チェック未定ではなく「ヘルプ未定」にする
    return 'ヘルプ未定 ▾';
  };

  // 表示名（ニックネーム）編集用ステート
  const [isEditingUserName, setIsEditingUserName] = useState(false);
  const [inputUserName, setInputUserName] = useState('');

  // 停止時アコーディオン展開管理用ステート（seatId: boolean）
  const [expandedPausedSeatIds, setExpandedPausedSeatIds] = useState({});

  // 施術工程・ステータス選択モーダル用ステート（呼び出し・コーミング・チェック・シャンプー・その他）
  const [isActionStatusModalVisible, setIsActionStatusModalVisible] = useState(false);
  const [actionStatusTargetSeat, setActionStatusTargetSeat] = useState(null);

  // タイム設定モーダル用ステート（対象の席情報）
  const [targetSeatId, setTargetSeatId] = useState(null);
  const [modalSeatLabel, setModalSeatLabel] = useState('');
  const [modalTargetMinutes, setModalTargetMinutes] = useState(20);
  const [modalTargetSeconds, setModalTargetSeconds] = useState(0);
  // ★ ユーザー指定: チェックタイマー用ステート（途中の発色・薬剤確認）
  const [modalCheckMinutes, setModalCheckMinutes] = useState(0); // 0は「なし」
  const [modalCheckSeconds, setModalCheckSeconds] = useState(0);
  const [modalCheckStaffName, setModalCheckStaffName] = useState(''); // チェック担当スタッフ
  const [modalCheckProcess, setModalCheckProcess] = useState('チェック'); // チェック時のヘルプ内容（既定: チェック）
  // ★ ユーザー指定: 共有タイマー入力画面一番下のウォッチ＆スマホアラーム音ON/OFF（どちらもデフォルトOFF）
  const [modalWatchAlarmSoundEnabled, setModalWatchAlarmSoundEnabled] = useState(false);
  const [modalAlarmSoundEnabled, setModalAlarmSoundEnabled] = useState(false);
  // ★ ユーザー指定: 稼働中の共有タイマーの「タイマーを止める」画面一番下から「チェックタイマーを追加」するステート
  const [isAddingLateCheck, setIsAddingLateCheck] = useState(false);
  const [lateCheckMinutes, setLateCheckMinutes] = useState(5);
  const [lateCheckProcess, setLateCheckProcess] = useState('チェック');
  const [lateCheckStaffName, setLateCheckStaffName] = useState('');
  const [modalColorStaff, setModalColorStaff] = useState('');
  const [modalAssistantStaff, setModalAssistantStaff] = useState('');
  const [modalComment, setModalComment] = useState('');
  const [isEditingExistingTimer, setIsEditingExistingTimer] = useState(false); // 時間変更モードか否か
  const [timerSetupMode, setTimerSetupMode] = useState('default'); // 'default' | 'new' (新しく測る) | 'additional' (追加タイム)
  // ★ ユーザー指定: タイム設定モーダルでの席名変更ステート
  const [isEditingSeatLabel, setIsEditingSeatLabel] = useState(false);
  // ★ 席名ダイレクト変更モーダル用ステート（待機席・稼働席・停止中席いつでも変更可能）
  const [isRenameSeatModalVisible, setIsRenameSeatModalVisible] = useState(false);
  const [renameTargetSeat, setRenameTargetSeat] = useState(null);
  const [renameSeatLabelInput, setRenameSeatLabelInput] = useState('');

  // ★ 放置タイムのお気に入りパネル用ステート（全体タイム＋チェックタイムのペアも保存可能）
  const [favoritePresets, setFavoritePresets] = useState([
    { id: 'fav-1', minutes: 3, seconds: 0, label: '乳化', checkMinutes: 0 },
    { id: 'fav-2', minutes: 7, seconds: 0, label: 'チェック', checkMinutes: 0 },
    { id: 'fav-3', minutes: 10, seconds: 0, label: 'リタッチ', checkMinutes: 0 },
    { id: 'fav-4', minutes: 15, seconds: 0, label: '全体', checkMinutes: 0 },
    { id: 'fav-5', minutes: 20, seconds: 0, label: '白髪染め', checkMinutes: 7 }, // 白髪染めは20分放置＋7分チェック
    { id: 'fav-6', minutes: 30, seconds: 0, label: 'マニキュア', checkMinutes: 0 },
  ]);
  const [isAddingFavorite, setIsAddingFavorite] = useState(false);
  const [newFavoriteLabel, setNewFavoriteLabel] = useState('');

  // カード画面からの直接メモ編集モーダル用ステート
  const [isEditCommentModalVisible, setIsEditCommentModalVisible] = useState(false);
  const [commentTargetSeat, setCommentTargetSeat] = useState(null);
  const [editCommentText, setEditCommentText] = useState('');

  // ★ チェック担当スタッフ指定モーダル用ステート
  const [isCheckStaffModalVisible, setIsCheckStaffModalVisible] = useState(false);
  const [checkStaffTargetSeat, setCheckStaffTargetSeat] = useState(null);
  const [inputCheckStaffName, setInputCheckStaffName] = useState('');

  // ★ ユーザー指定: チェックタイマー停止確認モーダル用ステート（タイマー設定者へ通知）
  const [isCheckStopModalVisible, setIsCheckStopModalVisible] = useState(false);
  const [checkStopTargetSeat, setCheckStopTargetSeat] = useState(null);

  // ★ ユーザー指定: クイックタイム変更モーダル用ステート（+30秒, +1分, +3分, +5分 & ±30秒）
  const [isQuickAdjustModalVisible, setIsQuickAdjustModalVisible] = useState(false);
  const [quickAdjustTargetSeat, setQuickAdjustTargetSeat] = useState(null);
  const [quickAdjustDeltaSeconds, setQuickAdjustDeltaSeconds] = useState(0);

  // 招待コード参加・新規作成フォーム用
  const [inputInviteCode, setInputInviteCode] = useState('');
  const [inputSalonName, setInputSalonName] = useState('');
  const [inputStaffName, setInputStaffName] = useState('');
  const [newSeatName, setNewSeatName] = useState('');

  // エスカレーション用アラート重複発火ガード
  const escalatedAlertRef = useRef({});
  // 1分前ヘルプ未定アラート重複発火ガード
  const oneMinuteHelpAlertRef = useRef({});
  // チェックタイマー用アラート重複発火ガード
  const checkAlertedRef = useRef({});
  // メイン放置タイマー用アラート重複発火ガード
  const mainTimeupAlertedRef = useRef({});
  // ヘルプ担当指定モーダル用ScrollViewの参照
  const helpModalScrollViewRef = useRef(null);
  // チェック担当指定モーダル用ScrollViewの参照
  const checkStaffModalScrollViewRef = useRef(null);

  // ★ Apple Watch と連動中か（ペアリング済み＋Watchアプリ導入済み）
  const [watchLinked, setWatchLinked] = useState(false);
  const watchLinkedRef = useRef(false);
  watchLinkedRef.current = watchLinked;

  // ★ 現在のサロンで自分が招待元（オーナー）かどうか（席の追加・削除・リネーム・招待コード変更はオーナーのみ可能）
  const isSalonOwner = useMemo(() => checkIsSalonOwner(currentSalon, myUserId), [currentSalon, myUserId]);
  const isSalonOwnerRef = useRef(isSalonOwner);
  isSalonOwnerRef.current = isSalonOwner;
  _cachedIsSalonOwner = isSalonOwner;
  _cachedMyUserId = myUserId;
  _cachedActiveSalonId = currentSalon?.id || 'workspace-free';

  const seatsRef = useRef(seats);
  seatsRef.current = seats;
  const pendingDeletedSeatsRef = useRef([]);
  const reconcileInFlightRef = useRef(false);
  const reconcileCloudTimersRef = useRef(null);

  // ★ スマホ画面の開閉状態（フォアグラウンド 'active' か、ロック中・バックグラウンド・別アプリか）を常時追跡
  //   バックグラウンドから 'active' に復帰した際、クラウドの最新席一覧を自動再同期してリアルタイム取りこぼしを防ぐ
  const appStateRef = useRef(AppState.currentState || 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextAppState) => {
      const prevAppState = appStateRef.current;
      appStateRef.current = nextAppState || 'active';
      if (
        prevAppState &&
        prevAppState !== 'active' &&
        nextAppState === 'active' &&
        typeof reconcileCloudTimersRef.current === 'function'
      ) {
        reconcileCloudTimersRef.current();
      }
    });
    return () => {
      if (sub?.remove) sub.remove();
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    // スマホ閉鎖時（Watch未連動時）のOS標準バナー通知用に通知権限を確認・リクエスト
    WatchConnectivity.requestNotificationPermission().catch(() => {});
    const apply = (st) => {
      if (st && typeof st === 'object' && !st.error) {
        const linked = !!(st.isPaired && st.isWatchAppInstalled);
        watchLinkedRef.current = linked;
        setWatchLinked(linked);
      }
    };
    apply(WatchConnectivity.getStatus());
    const sub = WatchConnectivity.addStatusListener(apply);
    return () => { if (sub?.remove) sub.remove(); };
  }, []);

  // ★ サロン席のタイムアップを iPhone でも鳴らすか
  // Watch 連動中は既定で「Watch のみ」。設定「Watch連動中もiPhoneで鳴らす」が ON なら iPhone も鳴らす。
  const phoneAlarmAllowed = !watchLinked || !!isPhoneAlarmForWatchSeats;
  const phoneAlarmAllowedRef = useRef(phoneAlarmAllowed);
  phoneAlarmAllowedRef.current = phoneAlarmAllowed;

  // ★ 最新のユーザー情報・メンバー一覧へのRef（500ms監視＆Realtimeコールバック用）
  const userNameRef = useRef(userName);
  userNameRef.current = userName;
  const myUserIdRef = useRef(myUserId);
  myUserIdRef.current = myUserId;
  const staffMembersRef = useRef(staffMembers);
  staffMembersRef.current = staffMembers;

  // ★ 共有相手の操作によるリアルタイム通知バナー（全タブ共通トースト通知＋バイブレーションへ一元化）
  const [peerBanner, setPeerBanner] = useState(null);
  const showPeerActionBanner = (text, color = '#30D158', id = undefined) => {
    if (!text) return;
    if (typeof showGlobalPeerToast === 'function') {
      showGlobalPeerToast(text, color, { id, vibrate: true });
    }
  };

  // ★ 席の関係者判定ヘルパー（自分以外の無関係な席のタイマー通知・アラームが来ないようにフィルタリング）
  const isStaffNameMe = (
    name,
    currentUserName = userNameRef.current,
    currentMyUserId = myUserIdRef.current,
    currentStaffMembers = staffMembersRef.current
  ) => checkIsStaffNameMe(name, currentUserName, currentMyUserId, currentStaffMembers);

  const isMainStaffOfSeat = (
    seat,
    currentUserName = userNameRef.current,
    currentMyUserId = myUserIdRef.current,
    currentStaffMembers = staffMembersRef.current
  ) => checkIsMainStaffOfSeat(seat, currentUserName, currentMyUserId, currentStaffMembers);

  // ★ UI表示用: 該当スタッフ・作成者が自分自身なら「自分」（2文字のみ）に統一表示（内部データ・通信値は本人の名前のまま保持）
  const formatStaffForDisplay = (name, fallback = '') => {
    const trimmed = (name || '').trim();
    if (!trimmed) return fallback;
    if (trimmed === 'ヘルプなし' || trimmed === 'none' || trimmed === '未定' || trimmed === '募集中') {
      return trimmed;
    }
    return isStaffNameMe(trimmed) ? '自分' : trimmed;
  };

  const formatCreatorForDisplay = (seat, fallback = '') => {
    if (!seat) return fallback;
    if (isMainStaffOfSeat(seat)) return '自分';
    const raw = (seat.colorStaffName || '').trim();
    return raw || fallback;
  };

  // 全体タイマーの関係者か（主担当・全体ヘルプ担当・または「ヘルプなし」以外で全体ヘルプが未定/募集中のため自分がヘルプに入る可能性がある場合）
  const shouldAlertMainTimerForUser = (seat, currentUserName = userNameRef.current, currentMyUserId = myUserIdRef.current, currentStaffMembers = staffMembersRef.current) => {
    if (!seat) return false;
    if (isMainStaffOfSeat(seat, currentUserName, currentMyUserId, currentStaffMembers)) return true;
    const assist = (seat.assistantStaffName || '').trim();
    if (isStaffNameMe(assist, currentUserName, currentMyUserId, currentStaffMembers)) return true;
    const isNoHelp = seat.isNoHelpNeeded || assist === 'ヘルプなし' || assist === 'none';
    if (isNoHelp) return false;
    if (seat.isRecruiting || !assist || assist === '未定' || assist === '募集中') {
      return true;
    }
    return false;
  };

  // 中間チェックタイマーの関係者か（主担当・チェック担当・またはチェック担当が未定/募集中のため自分がチェックに入る可能性がある場合）
  const shouldAlertCheckTimerForUser = (seat, currentUserName = userNameRef.current, currentMyUserId = myUserIdRef.current, currentStaffMembers = staffMembersRef.current) => {
    if (!seat) return false;
    if (isMainStaffOfSeat(seat, currentUserName, currentMyUserId, currentStaffMembers)) return true;
    const chkStaff = (seat.checkStaffName || seat.checkStaff || '').trim();
    if (isStaffNameMe(chkStaff, currentUserName, currentMyUserId, currentStaffMembers)) return true;
    if (!chkStaff || chkStaff === '未定' || chkStaff === '募集中') {
      return true;
    }
    return false;
  };

  // 500msごとの時計同期 & タイムアップ監視 & エスカレーションチェック
  useEffect(() => {
    const timer = setInterval(() => {
      const currentNow = Date.now();
      setNow(currentNow);
      const activeUser = userNameRef.current;
      const activeUserId = myUserIdRef.current;
      const activeMembers = staffMembersRef.current;

      // タイムアップ席の監視 & エスカレーション通知（関係者＋ヘルプに入る可能性がある人のみ通知）
      setSeats((prevSeats) => {
        let hasChanges = false;
        const updated = prevSeats.map((s) => {
          if (s.status !== 'running') return s;

          const isOver = currentNow >= s.targetEndTimestamp;
          const remainingSec = Math.floor((s.targetEndTimestamp - currentNow) / 1000);
          const shouldAlertMain = shouldAlertMainTimerForUser(s, activeUser, activeUserId, activeMembers);
          const shouldAlertCheck = shouldAlertCheckTimerForUser(s, activeUser, activeUserId, activeMembers);

          // ★ ユーザー指定: 1分前でもヘルプ担当が決まっていなければ全員にアラートを出す（ヘルプなしを除く）
          const isNoHelp = s.isNoHelpNeeded || s.assistantStaffName === 'ヘルプなし' || s.assistantStaffName === 'none';
          const isHelpUndecided = !s.assistantStaffName || s.assistantStaffName.trim() === '';

          if (!isOver && (s.targetSeconds || 600) > 60 && remainingSec <= 60 && remainingSec > 0 && isHelpUndecided && !isNoHelp && shouldAlertMain) {
            // ★ どの終了時刻に対する通知かを記録（Watch からの再スタート後も自動で再び通知できるように）
            if (oneMinuteHelpAlertRef.current[s.id] !== s.targetEndTimestamp) {
              oneMinuteHelpAlertRef.current[s.id] = s.targetEndTimestamp;
              if (Platform.OS !== 'web' && phoneAlarmAllowedRef.current) {
                Vibration.vibrate([0, 500, 150, 500, 150, 500]);
              }
              const sActionInfo = getActionStatusInfo(s.actionStatus, s.isShampooing);
              const helpActionMsg = sActionInfo
                ? `「${s.seatLabel}」の放置タイム終了まであと1分ですが、【${sActionInfo.label}】のヘルプ担当が未定です！\n至急ヘルプに入ってください！`
                : `「${s.seatLabel}」の放置タイム終了まであと1分ですが、ヘルプ担当が決まっていません（未定）！\n至急ヘルプに入ってください！`;

              Alert.alert(
                '⚠️【サロン全員ヘルプ募集】',
                helpActionMsg,
                [
                  {
                    text: '私がヘルプに入る',
                    onPress: () => handleAssignAssistantDirectly(s.id, activeUser || '自分'),
                  },
                  {
                    text: '確認',
                    style: 'cancel',
                  },
                ]
              );
            }
          }

          // ★ ユーザー指定: チェックタイマー（途中の発色・薬剤確認）の監視（主担当・チェック担当・チェック未定時のみ通知）
          let checkStatusChanged = false;
          let newCheckStatus = s.checkStatus;
          if (s.checkTargetSeconds > 0 && s.checkStatus === 'running' && s.checkEndTimestamp) {
            if (currentNow >= s.checkEndTimestamp) {
              newCheckStatus = 'timeup';
              checkStatusChanged = true;
              hasChanges = true;
              if (checkAlertedRef.current[s.id] !== s.checkEndTimestamp) {
                checkAlertedRef.current[s.id] = s.checkEndTimestamp;
                if (shouldAlertCheck) {
                  // ★ 仕様書40.1準拠: バイブレーションは常時ON（Watch未連携時またはiPhone鳴動許可時、もしくはスマホ音ON時に振動）、アラーム音はON時のみ再生
                  if (Platform.OS !== 'web') {
                    if (phoneAlarmAllowedRef.current || !!s.alarmSoundEnabled) {
                      Vibration.vibrate([0, 500, 150, 500]);
                    }
                    if (!!s.alarmSoundEnabled) {
                      playTimeUpSound();
                    }
                  }
                  const chkMins = s.checkInitialMinutes || Math.round(s.checkTargetSeconds / 60);
                  const chkProc = (s.checkProcess || 'チェック').trim() || 'チェック';
                  const hasExplicitChkProc = chkProc !== 'チェック';
                  const chkAlertTitle = hasExplicitChkProc ? `🔍【${chkProc}の時間です】` : '🔍【チェック時間です】';
                  const chkActionBtnLabel =
                    chkProc === '担当を呼ぶ'
                      ? '🔔 担当を呼ぶ（完了）'
                      : hasExplicitChkProc
                      ? `✓ ${chkProc}に入る（完了）`
                      : '⏹ タイマーを止める';
                  Alert.alert(
                    chkAlertTitle,
                    `「${s.seatLabel}」の${hasExplicitChkProc ? `${chkProc}（中間チェック）` : 'チェック'}時間（${chkMins}分）になりました！\n発色や薬剤の反応を確認してください。\n\n（※全体放置タイマーは計測を継続しています）`,
                    [
                      {
                        text: chkActionBtnLabel,
                        onPress: () => handleCompleteCheck(s.id),
                      },
                      {
                        text: '超過カウント続行',
                        style: 'cancel',
                      },
                    ]
                  );
                }
              }
            }
          }

          if (!isOver) {
            if (checkStatusChanged) {
              return {
                ...s,
                checkStatus: newCheckStatus,
              };
            }
            return s;
          }

          // タイムアップ時刻の記録
          let timeUpTs = s.timeUpTimestamp;
          let escLevel = s.escalationLevel || 0;
          // ★ 終了時刻が変わっていれば（再スタート・時間変更後の）新しいタイムアップとして扱う。
          //   以前は記録が残ったままで、同じ席の2回目以降のタイムアップで振動・エスカレーションが起きなかった
          if (timeUpTs && timeUpTs !== s.targetEndTimestamp) {
            timeUpTs = null;
            escLevel = 0;
            escalatedAlertRef.current[s.id] = false;
          }
          if (!timeUpTs) {
            timeUpTs = s.targetEndTimestamp;
            hasChanges = true;
            if (mainTimeupAlertedRef.current[s.id] !== s.targetEndTimestamp) {
              mainTimeupAlertedRef.current[s.id] = s.targetEndTimestamp;
              if (shouldAlertMain) {
                // ★ 仕様書40.1準拠: バイブレーションは常時ON（Watch未連携時またはiPhone鳴動許可時、もしくはスマホ音ON時に振動）、アラーム音はON時のみ再生
                if (Platform.OS !== 'web') {
                  if (phoneAlarmAllowedRef.current || !!s.alarmSoundEnabled) {
                    Vibration.vibrate([0, 500, 200, 500, 200, 500]);
                  }
                  if (!!s.alarmSoundEnabled) {
                    playTimeUpSound();
                  }
                }
                const mins = s.initialMinutes || Math.round((s.targetSeconds || 600) / 60);
                Alert.alert(
                  '⏰【放置タイム終了】',
                  `「${s.seatLabel}」の放置タイム（${mins}分）が終了しました！\n確認または次の工程に進んでください。`,
                  [{ text: '確認' }]
                );
              }
            }
          }

          const elapsedOverSec = Math.floor((currentNow - timeUpTs) / 1000);

          // ヘルプ確認（またはヘルプなし確認）に達していない場合の段階的エスカレーション（関係者のみ振動・通知）
          const isConfirmed = isNoHelp || !s.assistantStaffName || s.assistantStaffConfirmed;

          // ① 30秒リマインド（強い振動）
          if (elapsedOverSec >= 30 && escLevel < 1 && !isConfirmed) {
            escLevel = 1;
            hasChanges = true;
            if (shouldAlertMain && Platform.OS !== 'web' && (phoneAlarmAllowedRef.current || !!s.alarmSoundEnabled)) {
              Vibration.vibrate([0, 400, 150, 400]);
            }
          }
          // ② 1分リマインド（強い振動）
          else if (elapsedOverSec >= 60 && escLevel < 2 && !isConfirmed) {
            escLevel = 2;
            hasChanges = true;
            if (shouldAlertMain && Platform.OS !== 'web' && (phoneAlarmAllowedRef.current || !!s.alarmSoundEnabled)) {
              Vibration.vibrate([0, 400, 150, 400, 150, 400]);
            }
          }
          // ③ 3分経過: 確認されない場合、その席の関係者（＋ヘルプ未定時）にチェックアラート発動！
          else if (elapsedOverSec >= 180 && escLevel < 3 && !isConfirmed) {
            escLevel = 3;
            hasChanges = true;
            if (!escalatedAlertRef.current[s.id]) {
              escalatedAlertRef.current[s.id] = true;
              if (shouldAlertMain) {
                if (Platform.OS !== 'web' && (phoneAlarmAllowedRef.current || !!s.alarmSoundEnabled)) {
                  Vibration.vibrate([0, 800, 200, 800, 200, 800]);
                }
                Alert.alert(
                  '🚨【至急チェック確認】',
                  `「${s.seatLabel}」がタイムアップ後3分間確認されていません！\n至急チェックしてください！`,
                  [{ text: '確認して対応する' }]
                );
              }
            }
          }

          if (hasChanges) {
            return {
              ...s,
              timeUpTimestamp: timeUpTs,
              escalationLevel: escLevel,
              checkStatus: newCheckStatus,
            };
          }
          return s;
        });

        if (hasChanges) {
          saveSeatsToStorage(updated);
          return updated;
        }
        return prevSeats;
      });
    }, 500);

    return () => clearInterval(timer);
  }, []);

  // サロン内で利用可能なスタッフ候補リスト（登録メンバーリストを優先、初期値は空）
  const salonStaffList = useMemo(() => {
    const list = new Set();
    staffMembers.forEach((m) => {
      const name = getMemberDisplayName(m);
      if (name && name.trim()) list.add(name.trim());
    });
    seats.forEach((s) => {
      if (s.colorStaffName) list.add(s.colorStaffName);
      if (s.assistantStaffName && s.assistantStaffName !== 'ヘルプなし' && s.assistantStaffName !== 'none') {
        list.add(s.assistantStaffName);
      }
    });
    return Array.from(list);
  }, [staffMembers, seats]);

  // ★ クラウド同期制御用Ref（他端末からの受信時ループ防止＆差分検知）
  const isRemoteSyncRef = useRef(false);
  const lastSyncedSeatsStateRef = useRef({});
  const currentSalonRef = useRef(currentSalon);
  currentSalonRef.current = currentSalon;
  const savedSalonsRef = useRef(savedSalons);
  savedSalonsRef.current = savedSalons;
  const cloudSalonIdRef = useRef(null);
  const didSwitchSalonRef = useRef(false);

  const buildSalonMemberDescription = (salonObj, count, activeUid = myUserIdRef.current || myUserId) => {
    if (!salonObj) return 'オンライン中';
    if (salonObj.id === 'workspace-pro-demo') return salonObj.description || 'オンライン中';
    const isOwner = checkIsSalonOwner(salonObj, activeUid);
    if (!salonObj.isPro && isOwner && count <= 1) {
      return '2人までタイマー同期無料 (1名利用中 / ペア招待可能)';
    }
    if (count > 0) {
      return `${count}名参加中 (クラウド同期中)`;
    }
    return salonObj.description || 'オンライン中';
  };

  const updateCloudSalonMemberCountDescription = (targetSalonId, count) => {
    if (!targetSalonId) return;
    const activeUid = myUserIdRef.current || myUserId;
    setCurrentSalon((prev) => {
      if (!prev || prev.id !== targetSalonId) return prev;
      const nextDesc = buildSalonMemberDescription(prev, count, activeUid);
      if (prev.description === nextDesc) return prev;
      const updated = { ...prev, description: nextDesc };
      currentSalonRef.current = updated;
      return updated;
    });
    setSavedSalons((prev) => {
      let changed = false;
      const next = prev.map((s) => {
        if (!s || s.id !== targetSalonId) return s;
        const nextDesc = buildSalonMemberDescription(s, count, activeUid);
        if (s.description === nextDesc) return s;
        changed = true;
        return { ...s, description: nextDesc };
      });
      if (changed) {
        AsyncStorage.setItem('@salon_saved_salons', JSON.stringify(next)).catch(() => {});
        return next;
      }
      return prev;
    });
  };

  const detachFromRemovedGuestSalon = async (removedSalonId, reasonMessage = null) => {
    const activeUid = myUserIdRef.current || myUserId;
    if (removedSalonId && isCloudUUID(removedSalonId)) {
      removeSalonPushToken({ salonId: removedSalonId, userId: activeUid, onlyCurrentDevice: false }).catch(() => {});
    }
    const activeName = userNameRef.current || userName || 'スタイリスト';
    const prevList = Array.isArray(savedSalonsRef.current) ? savedSalonsRef.current : [];
    const remainingSalons = prevList.filter((s) => s && s.id !== removedSalonId);
    const fallbackSalon =
      remainingSalons.find((s) => checkIsSalonOwner(s, activeUid)) ||
      remainingSalons[0] ||
      createDefaultFreeSalon();
    const nextSalons = remainingSalons.length > 0 ? remainingSalons : [fallbackSalon];

    resetSalonRuntimeStateForSwitch();
    didSwitchSalonRef.current = true;
    cloudSalonIdRef.current =
      fallbackSalon.id && fallbackSalon.id !== 'workspace-free' && fallbackSalon.id !== 'workspace-pro-demo'
        ? fallbackSalon.id
        : null;
    const fallbackIsOwner = checkIsSalonOwner(fallbackSalon, activeUid);
    _cachedIsSalonOwner = fallbackIsOwner;
    _cachedActiveSalonId = fallbackSalon.id || 'workspace-free';

    const selfOnlyMembers = activeUid
      ? [
          {
            id: activeUid,
            user_id: activeUid,
            originalNickname: activeName,
            customNickname: activeName,
            role: fallbackIsOwner ? 'owner' : 'assistant',
            isMe: true,
            joinedAt: Date.now(),
          },
        ]
      : [];

    setSavedSalons(nextSalons);
    savedSalonsRef.current = nextSalons;
    setCurrentSalon(fallbackSalon);
    currentSalonRef.current = fallbackSalon;
    setStaffMembers(selfOnlyMembers);
    staffMembersRef.current = selfOnlyMembers;
    setIsMemberManageModalVisible(false);
    await saveSalonsToStorage(nextSalons, fallbackSalon.id);
    await AsyncStorage.setItem('@salon_staff_members', JSON.stringify(selfOnlyMembers)).catch(() => {});

    pendingDeletedSeatsRef.current = await readPendingDeletedSeats(fallbackSalon.id);
    const rawFallbackSeats = await readSeatsForSalonFromStorage(
      fallbackSalon,
      activeName,
      activeUid,
      fallbackSalon.id
    );
    const { seats: fallbackSeats } = sanitizeLoadedSeats(rawFallbackSeats);
    setSeats(fallbackSeats);
    syncSeatsToWatch(fallbackSeats, activeName, selfOnlyMembers, {
      immediate: true,
      forceEmpty: fallbackSeats.length === 0,
    });

    if (reasonMessage) {
      Alert.alert('サロン共有の解除', reasonMessage);
    }
  };

  const resetSalonRuntimeStateForSwitch = () => {
    lastSyncedSeatsStateRef.current = {};
    mainTimeupAlertedRef.current = {};
    checkAlertedRef.current = {};
    oneMinuteHelpAlertRef.current = {};
    escalatedAlertRef.current = {};
    stopAllAlarms('salon');
  };

  // ★ 席の状態変化を検知して Supabase クラウドへ差分同期
  const getSeatCloudSignature = (seat) => {
    if (!seat) return '';
    const label = (seat.seatLabel || seat.name || '').replace(/\s*[\(（]サンプル[\)）]/g, '').trim();
    return `${label}_${seat.colorStaffName || ''}_${seat.createdBy || ''}_${seat.status}_${seat.targetSeconds || seat.targetTime}_${seat.targetEndTimestamp}_${seat.pausedRemainingSeconds}_${seat.assistantStaffName}_${seat.helpProcess}_${seat.actionStatus}_${seat.isRecruiting}_${seat.isNoHelpNeeded}_${seat.checkEndTimestamp}_${seat.checkPausedRemainingSeconds}_${seat.checkTotalSeconds || seat.checkTargetSeconds}_${seat.checkStatus}_${seat.checkProcess}_${seat.checkStaffName}_${seat.comment}_${seat.isShampooing}`;
  };

  const getActiveStorageSalonId = () =>
    cloudSalonIdRef.current || currentSalonRef.current?.id || 'workspace-free';

  const enqueuePendingDeletedSeat = async (salonId, seatItem) => {
    if (!seatItem) return;
    const resolvedSalonId = salonId || getActiveStorageSalonId();
    const entry = {
      id: seatItem.id || null,
      cloudTimerId: seatItem.cloudTimerId || (isCloudUUID(seatItem.id) ? seatItem.id : null),
      seatLabel: (seatItem.seatLabel || seatItem.name || '').trim() || null,
      deletedAt: Date.now(),
    };
    const nextList = [
      ...pendingDeletedSeatsRef.current.filter(
        (x) =>
          !(
            (entry.cloudTimerId && x.cloudTimerId === entry.cloudTimerId) ||
            (entry.id && x.id === entry.id) ||
            (!entry.cloudTimerId && entry.seatLabel && x.seatLabel === entry.seatLabel)
          )
      ),
      entry,
    ];
    pendingDeletedSeatsRef.current = nextList;
    await writePendingDeletedSeats(resolvedSalonId, nextList);
  };

  const removePendingDeletedSeat = async (salonId, seatIdOrCloudId, seatLabel = null) => {
    const resolvedSalonId = salonId || getActiveStorageSalonId();
    const nextList = pendingDeletedSeatsRef.current.filter((x) => {
      if (seatIdOrCloudId && (x.id === seatIdOrCloudId || x.cloudTimerId === seatIdOrCloudId)) return false;
      if (!isCloudUUID(seatIdOrCloudId) && seatLabel && x.seatLabel === seatLabel) return false;
      return true;
    });
    pendingDeletedSeatsRef.current = nextList;
    await writePendingDeletedSeats(resolvedSalonId, nextList);
  };

  const isSeatInPendingDeleted = (seatObj, list = pendingDeletedSeatsRef.current) => {
    if (!seatObj || !Array.isArray(list) || list.length === 0) return false;
    const targetUuid = seatObj.cloudTimerId || (isCloudUUID(seatObj.id) ? seatObj.id : null);
    const targetLabel = (seatObj.seatLabel || seatObj.name || '').trim();
    return list.some((x) => {
      if (targetUuid && (x.cloudTimerId === targetUuid || x.id === targetUuid)) return true;
      if (!x.cloudTimerId && targetLabel && x.seatLabel === targetLabel) return true;
      return false;
    });
  };

  const syncChangedSeatsToCloud = async (newSeats) => {
    if (isRemoteSyncRef.current) return;
    const targetSalonId =
      cloudSalonIdRef.current ||
      (currentSalonRef.current?.id &&
      currentSalonRef.current.id !== 'workspace-free' &&
      currentSalonRef.current.id !== 'workspace-pro-demo'
        ? currentSalonRef.current.id
        : null);
    if (!targetSalonId) return;

    for (const seat of newSeats) {
      if (!seat || !seat.id) continue;
      // ゲスト端末からはクラウドにまだ存在しない非UUID新規席のINSERTを行わない（オーナーの席マスターのみを基準とする）
      if (!isSalonOwnerRef.current && !isCloudUUID(seat.cloudTimerId || seat.id)) continue;
      const sig = getSeatCloudSignature(seat);
      if (lastSyncedSeatsStateRef.current[seat.id] !== sig || seat.dirtySync) {
        lastSyncedSeatsStateRef.current[seat.id] = sig;
        upsertCloudTimer(targetSalonId, seat)
          .then((savedCloudSeat) => {
            if (savedCloudSeat?.id) {
              lastSyncedSeatsStateRef.current[savedCloudSeat.id] = sig;
              if (seat.id !== savedCloudSeat.id || seat.dirtySync) {
                setSeats((curr) => {
                  const next = curr.map((item) =>
                    item.id === seat.id
                      ? { ...item, id: savedCloudSeat.id, cloudTimerId: savedCloudSeat.id, dirtySync: false }
                      : item
                  );
                  persistSeatsForSalonId(targetSalonId, next, isSalonOwnerRef.current).catch(() => {});
                  return next;
                });
              }
            } else if (lastSyncedSeatsStateRef.current[seat.id] === sig) {
              // オフライン等で送信失敗した場合はシグネチャを戻し、次回再送を保証
              delete lastSyncedSeatsStateRef.current[seat.id];
            }
          })
          .catch((e) => {
            if (lastSyncedSeatsStateRef.current[seat.id] === sig) {
              delete lastSyncedSeatsStateRef.current[seat.id];
            }
            console.warn('upsertCloudTimer error:', e);
          });
      }
    }
  };

  // ストレージ保存ヘルパー（サロンID別キーへ保存し、サロン間の席上書き・消失を防止）
  const saveSeatsToStorage = async (newSeats) => {
    try {
      const storageSalonId = getActiveStorageSalonId();
      await persistSeatsForSalonId(storageSalonId, newSeats, isSalonOwnerRef.current);
      // ★ Apple Watchへ即時同期 (登録メンバーも含めて送信)
      syncSeatsToWatch(newSeats, userName, staffMembers);
      // ★ クラウド（Supabase）へ差分同期！
      syncChangedSeatsToCloud(newSeats);
    } catch (e) {
      console.warn('Failed to save seats to AsyncStorage', e);
    }
  };

  const saveSalonsToStorage = async (newSalons, activeSalonId) => {
    try {
      await AsyncStorage.setItem('@salon_saved_salons', JSON.stringify(newSalons));
      if (activeSalonId) {
        await AsyncStorage.setItem('@salon_current_salon_id', activeSalonId);
      }
    } catch (e) {
      console.warn('Failed to save salons to AsyncStorage', e);
    }
  };

  // ★ 席を 0:00 の停止にする共通処理（Watch の「止める」系操作・アラームの「止める」で使用）
  //   チェックタイマーも解除する（Q3）
  const buildStoppedSeat = (s, staff, _historyText) => ({
    ...s,
    status: 'paused',
    pausedRemainingSeconds: 0,
    targetSeconds: 0,
    initialMinutes: 0,
    targetEndTimestamp: null,
    lastStoppedAt: Date.now(),
    lastStoppedTargetEndTimestamp: Number(s.targetEndTimestamp) || Number(s.lastStoppedTargetEndTimestamp) || 0,
    isOver: false,
    isReset: true,
    timeUpTimestamp: null,
    escalationLevel: 0,
    mainStaffConfirmed: true,
    assistantStaffConfirmed: true,
    stoppedBy: staff,
    assistantStaffName: '',
    isShampooing: false,
    actionStatus: null,
    helpProcess: null,
    isRecruiting: false,
    isNoHelpNeeded: false,
    checkTargetSeconds: null,
    checkTotalSeconds: null,
    checkEndTimestamp: null,
    checkPausedRemainingSeconds: null,
    checkInitialMinutes: null,
    checkStaffName: '',
    checkProcess: 'チェック',
    checkStatus: 'stopped',
    isCheckCompleted: false,
    watchAlarmSoundEnabled: false,
    alarmSoundEnabled: false,
    collapsedAtEnd: Date.now(),
    history: [],
  });

  // ★ 処理済みの Watch 操作（操作名＋席ID＋送信時刻）。即時ルートと予備ルートで同じ操作が2回届いても1回だけ反映する
  const processedWatchActionsRef = useRef([]);

  // ★ Apple Watchからの操作受信ハンドラ
  const handleWatchAction = (message) => {
    if (!message || !message.action) return;
    const { action, seatId, userName: watchUser } = message;
    // ★ Watch は追加値（targetSeconds / totalSeconds / secondsToAdd など）を extra に包まずメッセージ直下に入れて送る。
    //   以前は message.extra だけを読んでいたため常に既定値（START_TIMER=10分 等）になっていた。
    const extra = (message.extra && typeof message.extra === 'object') ? message.extra : message;

    // ★ 二重適用の防止（REQUEST_SYNC は何度来ても害がないので対象外）
    if (action !== 'REQUEST_SYNC' && message.timestamp != null) {
      const dedupeKey = `${action}|${seatId || ''}|${message.timestamp}`;
      const processed = processedWatchActionsRef.current;
      if (processed.includes(dedupeKey)) return;
      processed.push(dedupeKey);
      if (processed.length > 100) processed.shift();
    }

    // ① 同期リクエスト (Watch側から「最新の客席データをちょうだい」と要求された時)
    if (action === 'REQUEST_SYNC') {
      const rawStopped = extra?.watchMainTimerStopped ?? message?.watchMainTimerStopped;
      const hasStoppedWatchMain = rawStopped === true || rawStopped === 1 || rawStopped === 'true';
      if (hasStoppedWatchMain && (_cachedMainTimerState?.isRunning || _cachedMainTimerState?.isPreCountingDown || _cachedMainTimerState?.isCountUp)) {
        stopAlarm('main', 'main-timer');
        const stoppedEnd = _cachedMainTimerState?.targetEndTimestamp || 0;
        WatchConnectivity.notifyLocalStopOrReset('main-timer', stoppedEnd);
        const resetTarget = _cachedMainTimerState?.targetTime || 600;
        updateCachedMainTimerState({
          ...(_cachedMainTimerState || {}),
          remainingTime: resetTarget,
          targetTime: resetTarget,
          targetEndTimestamp: 0,
          lastResetTargetEndTimestamp: stoppedEnd,
          lastResetAt: Date.now(),
          isRunning: false,
          isPaused: false,
          isCountUp: false,
          isExplicitReset: true,
          explicitStop: true,
          isAutoFinished: false,
          isPreCountingDown: false,
          prepEndTimestamp: 0,
        });
      } else {
        const rawActive = extra?.watchMainTimerActive ?? message?.watchMainTimerActive;
        const hasActiveWatchMain = rawActive === true || rawActive === 1 || rawActive === 'true';
        if (hasActiveWatchMain && !_cachedMainTimerState?.isRunning && !_cachedMainTimerState?.isPreCountingDown) {
          const nowMs = Date.now();
          const allowCountUp = !!_cachedMainTimerState?.isCountUpEnabled;
          const incomingSec = Number(extra?.totalSeconds || message?.totalSeconds || 600);
          const incomingPrepEnd = Number(extra?.prepEndTimestamp || message?.prepEndTimestamp || 0);
          const incomingTargetEnd = Number(extra?.targetEndTimestamp || message?.targetEndTimestamp || 0);
          const isStoppedTarget = WatchConnectivity.isMainTimerEndStopped(incomingTargetEnd);
          const isPrep = incomingPrepEnd > nowMs;
          const isNewFutureTimer = !isStoppedTarget && (incomingTargetEnd > nowMs + 2000 || isPrep);
          const isRecentlyStopped = !isNewFutureTimer && (nowMs - WatchConnectivity.getLastLocalMainTimerStopAt() < 15000);
          const isPast = !isPrep && incomingTargetEnd > nowMs - 3 * 3600 * 1000 && incomingTargetEnd <= nowMs;
          const isOvertime = isPast && allowCountUp;
          if (!isStoppedTarget && !isRecentlyStopped && isPast && !allowCountUp) {
            updateCachedMainTimerState({
              ...(_cachedMainTimerState || {}),
              targetEndTimestamp: incomingTargetEnd,
              isAutoFinished: true,
              isExplicitReset: false,
              explicitStop: false,
            });
          } else if (!isStoppedTarget && !isRecentlyStopped && !(isPast && !allowCountUp)) {
            const targetEnd = (incomingTargetEnd > nowMs || isOvertime)
              ? incomingTargetEnd
              : (isPrep ? (incomingPrepEnd + incomingSec * 1000) : (nowMs + incomingSec * 1000));
            const syncedRem = isPrep
              ? incomingSec
              : (isOvertime
                ? Math.max(0, Math.floor((nowMs - targetEnd) / 1000))
                : Math.max(1, Math.ceil((targetEnd - nowMs) / 1000)));
            updateCachedMainTimerState({
              ...(_cachedMainTimerState || {}),
              remainingTime: syncedRem,
              targetTime: incomingSec,
              targetEndTimestamp: targetEnd,
              lastResetTargetEndTimestamp: 0,
              lastResetAt: 0,
              isRunning: !isPrep,
              isPaused: false,
              isCountUp: isOvertime,
              isAutoFinished: false,
              isExplicitReset: false,
              explicitStop: false,
              isPreCountingDown: isPrep,
              prepEndTimestamp: isPrep ? incomingPrepEnd : 0,
            });
          }
        }
      }
      const rawWatchActiveSeats = extra?.watchActiveSeats ?? message?.watchActiveSeats;
      setSeats((currentSeats) => {
        let nextSeats = currentSeats;
        let didAdoptWatchSeats = false;
        if (Array.isArray(rawWatchActiveSeats) && rawWatchActiveSeats.length > 0 && Array.isArray(currentSeats)) {
          const nowMs = Date.now();
          const cutoffMs = nowMs - 3 * 3600 * 1000;
          nextSeats = [...currentSeats];
          rawWatchActiveSeats.forEach((ws) => {
            if (!ws || typeof ws !== 'object') return;
            const wsEnd = Math.round(Number(ws.targetEndTimestamp || 0));
            if (wsEnd <= cutoffMs) return;
            const wsId = String(ws.id || '');
            const wsNum = Number(ws.seatNumber) || 0;
            if (
              (wsId && WatchConnectivity.isSeatTimerEndStopped(wsId, wsEnd)) ||
              (wsNum > 0 && WatchConnectivity.isSeatTimerEndStopped(`seat-${wsNum}`, wsEnd))
            ) {
              return;
            }
            const idx = nextSeats.findIndex((s) => {
              if (!s) return false;
              if (wsId && (s.id === wsId || s.cloudTimerId === wsId)) return true;
              if (wsNum > 0 && Number(s.seatNumber) === wsNum) return true;
              const sDigits = String(s.seatLabel || '').match(/\d+/);
              return wsNum > 0 && sDigits && parseInt(sDigits[0], 10) === wsNum;
            });
            if (idx >= 0 && nextSeats[idx].status !== 'running') {
              const targetSec = Math.max(10, Math.round(Number(ws.totalSeconds) || 600));
              const chkSec = Math.round(Number(ws.checkTargetSeconds || 0));
              const chkEnd = Math.round(Number(ws.checkEndTimestamp || 0));
              const hasActiveChk = chkSec > 0 && chkEnd > cutoffMs;
              const prevSeat = nextSeats[idx];
              nextSeats[idx] = {
                ...prevSeat,
                status: 'running',
                colorStaffName: watchUser || userNameRef.current || userName || 'スタイリスト',
                createdBy: myUserIdRef.current || myUserId || null,
                targetSeconds: targetSec,
                initialMinutes: Math.max(1, Math.round(targetSec / 60)),
                targetEndTimestamp: wsEnd,
                pausedRemainingSeconds: null,
                isReset: false,
                isOver: wsEnd <= nowMs,
                timeUpTimestamp: wsEnd <= nowMs ? wsEnd : null,
                escalationLevel: 0,
                collapsedAtEnd: null,
                buildUpdateNormalized: false,
                dirtySync: true,
                history: [
                  {
                    id: `h-${nowMs}-${idx}`,
                    time: formatHistoryTimeHHMM(nowMs),
                    text: hasActiveChk
                      ? `Apple Watchからタイマー開始 (${Math.max(1, Math.round(targetSec / 60))}分 / チェック${Math.max(1, Math.round(chkSec / 60))}分)`
                      : `Apple Watchからタイマー開始 (${Math.max(1, Math.round(targetSec / 60))}分)`,
                    type: 'timer',
                  },
                ],
                ...(hasActiveChk
                  ? {
                      checkTargetSeconds: chkSec,
                      checkTotalSeconds: chkSec,
                      checkInitialMinutes: Math.max(1, Math.round(chkSec / 60)),
                      checkEndTimestamp: chkEnd,
                      checkStatus: chkEnd <= nowMs ? 'timeup' : 'running',
                      isCheckCompleted: false,
                      checkProcess: ws.checkProcess || prevSeat.checkProcess || 'チェック',
                      checkStaffName: ws.checkStaffName || prevSeat.checkStaffName || '',
                    }
                  : {}),
              };
              didAdoptWatchSeats = true;
            }
          });
        }
        if (didAdoptWatchSeats) {
          saveSeatsToStorage(nextSeats);
        }
        syncSeatsToWatch(
          nextSeats,
          userNameRef.current || userName,
          staffMembersRef.current || staffMembers,
          { immediate: true }
        );
        return nextSeats;
      });
      return;
    }

    // ★ メインタイマーのWatch操作受信時のキャッシュ即時保護＆HomeScreenへの確実な転送
    if (action.startsWith('MAIN_TIMER_')) {
      if (action === 'MAIN_TIMER_RESET') {
        stopAlarm('main', 'main-timer');
        const incomingStopEnd = Number(extra?.targetEndTimestamp || message?.targetEndTimestamp || extra?.expectedEnd || message?.expectedEnd || _cachedMainTimerState?.targetEndTimestamp || 0);
        const resetTarget = _cachedMainTimerState?.targetTime || 600;
        updateCachedMainTimerState({
          ...(_cachedMainTimerState || {}),
          remainingTime: resetTarget,
          targetTime: resetTarget,
          targetEndTimestamp: 0,
          lastResetTargetEndTimestamp: incomingStopEnd,
          lastResetAt: Date.now(),
          isRunning: false,
          isPaused: false,
          isCountUp: false,
          isExplicitReset: true,
          explicitStop: true,
          isAutoFinished: false,
          isPreCountingDown: false,
        });
      } else if (action === 'MAIN_TIMER_PAUSE') {
        const wasOverOrZero = !!_cachedMainTimerState?.isCountUp || (_cachedMainTimerState?.remainingTime != null && _cachedMainTimerState.remainingTime <= 0);
        const incomingStopEnd = Number(extra?.targetEndTimestamp || message?.targetEndTimestamp || extra?.expectedEnd || message?.expectedEnd || _cachedMainTimerState?.targetEndTimestamp || 0);
        const resetTarget = _cachedMainTimerState?.targetTime || 600;
        updateCachedMainTimerState({
          ...(_cachedMainTimerState || {}),
          remainingTime: wasOverOrZero ? resetTarget : (_cachedMainTimerState?.remainingTime ?? resetTarget),
          targetEndTimestamp: 0,
          lastResetTargetEndTimestamp: incomingStopEnd,
          lastResetAt: Date.now(),
          isRunning: false,
          isPaused: !wasOverOrZero,
          isCountUp: false,
          isExplicitReset: wasOverOrZero,
          explicitStop: true,
          isAutoFinished: false,
          isPreCountingDown: false,
        });
      } else if (action === 'MAIN_TIMER_START') {
        if (!_cachedMainTimerState?.isRunning && !_cachedMainTimerState?.isPreCountingDown) {
          const incomingTotal = Number(extra?.totalSeconds || message?.totalSeconds || extra?.seconds || message?.seconds || 0);
          const curTarget = incomingTotal > 0 ? incomingTotal : (_cachedMainTimerState?.targetTime || 600);
          const curRem = _cachedMainTimerState?.remainingTime != null ? _cachedMainTimerState.remainingTime : curTarget;
          const incomingPrepEnd = Number(extra?.prepEndTimestamp || message?.prepEndTimestamp || 0);
          const incomingTargetEnd = Number(extra?.targetEndTimestamp || message?.targetEndTimestamp || 0);
          const isPrep = incomingPrepEnd > Date.now();
          const defaultEnd = isPrep ? (incomingPrepEnd + curTarget * 1000) : (Date.now() + curRem * 1000);
          const targetEnd = (incomingTargetEnd > Date.now() && incomingTargetEnd <= Date.now() + (curTarget + 3600) * 1000)
            ? incomingTargetEnd
            : defaultEnd;
          const syncedRem = (!isPrep && incomingTargetEnd > Date.now())
            ? Math.max(1, Math.ceil((targetEnd - Date.now()) / 1000))
            : curRem;
          updateCachedMainTimerState({
            ...(_cachedMainTimerState || {}),
            remainingTime: syncedRem,
            targetTime: curTarget,
            targetEndTimestamp: targetEnd,
            lastResetTargetEndTimestamp: 0,
            lastResetAt: 0,
            isRunning: !isPrep,
            isPaused: false,
            isCountUp: false,
            isAutoFinished: false,
            isExplicitReset: false,
            explicitStop: false,
            isPreCountingDown: isPrep,
            prepEndTimestamp: isPrep ? incomingPrepEnd : 0,
          });
        }
      } else if (action === 'MAIN_TIMER_SET_TIME') {
        const incomingSec = Number(extra?.totalSeconds || message?.totalSeconds || extra?.seconds || message?.seconds || 0);
        if (incomingSec > 0) {
          const rawAuto = extra?.autoStart ?? message?.autoStart;
          const incomingTargetEnd = Number(extra?.targetEndTimestamp || message?.targetEndTimestamp || 0);
          const autoStart = rawAuto === true || rawAuto === 1 || rawAuto === 'true' || (rawAuto == null && incomingTargetEnd > Date.now());
          const incomingPrepEnd = Number(extra?.prepEndTimestamp || message?.prepEndTimestamp || 0);
          const isPrep = autoStart && incomingPrepEnd > Date.now();
          const defaultEnd = autoStart ? (isPrep ? (incomingPrepEnd + incomingSec * 1000) : (Date.now() + incomingSec * 1000)) : 0;
          const targetEnd = autoStart
            ? ((incomingTargetEnd > Date.now() && incomingTargetEnd <= Date.now() + (incomingSec + 3600) * 1000) ? incomingTargetEnd : defaultEnd)
            : 0;
          const syncedRem = (autoStart && !isPrep && targetEnd > Date.now())
            ? Math.max(1, Math.ceil((targetEnd - Date.now()) / 1000))
            : incomingSec;
          updateCachedMainTimerState({
            ...(_cachedMainTimerState || {}),
            remainingTime: syncedRem,
            targetTime: incomingSec,
            targetEndTimestamp: targetEnd,
            lastResetTargetEndTimestamp: 0,
            lastResetAt: 0,
            isRunning: autoStart && !isPrep,
            isPaused: false,
            isCountUp: false,
            isAutoFinished: false,
            isExplicitReset: false,
            explicitStop: false,
            isPreCountingDown: isPrep,
            prepEndTimestamp: isPrep ? incomingPrepEnd : 0,
          });
        }
      } else if (action === 'MAIN_TIMER_ADJUST') {
        const delta = Number(extra?.secondsToAdd || message?.secondsToAdd || 0);
        const incomingEndMs = Number(extra?.targetEndTimestamp || message?.targetEndTimestamp || 0);
        if (delta && _cachedMainTimerState) {
          const isRunning = !!_cachedMainTimerState.isRunning || (incomingEndMs > Date.now() && delta > 0);
          if (isRunning) {
            const baseEnd = (_cachedMainTimerState.isRunning && !_cachedMainTimerState.isCountUp && _cachedMainTimerState.targetEndTimestamp > Date.now())
              ? _cachedMainTimerState.targetEndTimestamp
              : Date.now();
            const computedEnd = Math.max(Date.now() + 5000, baseEnd + delta * 1000);
            const newEnd = (incomingEndMs > Date.now() && Math.abs(incomingEndMs - computedEnd) <= 15000)
              ? incomingEndMs
              : computedEnd;
            const nextRem = Math.max(0, Math.ceil((newEnd - Date.now()) / 1000));
            updateCachedMainTimerState({
              ..._cachedMainTimerState,
              isRunning: true,
              isPaused: false,
              isCountUp: false,
              isAutoFinished: false,
              isExplicitReset: false,
              explicitStop: false,
              lastResetTargetEndTimestamp: 0,
              lastResetAt: 0,
              remainingTime: nextRem,
              targetEndTimestamp: newEnd,
            });
          } else {
            const isPaused = !!_cachedMainTimerState.isPaused;
            const baseSec = (isPaused && _cachedMainTimerState.remainingTime > 0)
              ? _cachedMainTimerState.remainingTime
              : (_cachedMainTimerState.targetTime || 600);
            const nextRem = Math.max(10, baseSec + delta);
            const nextTarget = isPaused ? Math.max(_cachedMainTimerState.targetTime || 600, nextRem) : nextRem;
            updateCachedMainTimerState({
              ..._cachedMainTimerState,
              remainingTime: nextRem,
              targetTime: nextTarget,
              isPaused: isPaused && nextRem !== nextTarget,
            });
          }
        }
      }
      // ★ HomeScreen の直接購読に加えて Context 経由でも同一 actionId で橋渡し（HomeScreen 側の processedMainActionIdsRef で1回のみ実行保証）
      const resolvedActionId = message.actionId || extra?.actionId || `${action}_${Math.round(Number(message.timestamp || Date.now()))}`;
      if (requestMainTimerAction) {
        requestMainTimerAction(action, message, resolvedActionId);
      }
      return;
    }

    // ② Watch側での新規席追加
    if (action === 'ADD_SEAT') {
      const seatNum = extra?.seatNumber || 1;
      const totalSec = extra?.totalSeconds || 900;
      const rawCheckSec = extra?.checkTotalSeconds && Number(extra.checkTotalSeconds) > 0
        ? Number(extra.checkTotalSeconds)
        : null;
      // ★ 安全ガード: チェック時間は全体タイムより短い場合のみ有効
      const checkSec = (rawCheckSec && rawCheckSec < totalSec) ? rawCheckSec : null;
      const defaultTargetEnd = Date.now() + totalSec * 1000;
      const incomingTargetEnd = Number(extra?.targetEndTimestamp || 0);
      const targetEnd = (incomingTargetEnd > Date.now() && Math.abs(incomingTargetEnd - defaultTargetEnd) <= 15000)
        ? incomingTargetEnd
        : defaultTargetEnd;
      const defaultCheckEnd = checkSec ? Date.now() + checkSec * 1000 : null;
      const incomingCheckEnd = Number(extra?.checkEndTimestamp || 0);
      const checkEnd = checkSec
        ? ((incomingCheckEnd > Date.now() && Math.abs(incomingCheckEnd - defaultCheckEnd) <= 15000) ? incomingCheckEnd : defaultCheckEnd)
        : null;

      const newSeatObj = {
        id: seatId || String(Date.now()),
        seatNumber: seatNum,
        seatLabel: `${seatNum}番席`,
        status: 'running',
        colorStaffName: watchUser || userName || 'スタイリスト',
        createdBy: myUserIdRef.current || myUserId || null,
        dirtySync: true,
        targetSeconds: totalSec,
        initialMinutes: Math.max(1, Math.round(totalSec / 60)),
        targetEndTimestamp: targetEnd,
        pausedRemainingSeconds: null,
        isReset: false,
        isOver: false,
        timeUpTimestamp: null,
        escalationLevel: 0,
        collapsedAtEnd: null,
        checkTargetSeconds: checkSec,
        checkTotalSeconds: checkSec,
        checkInitialMinutes: checkSec ? Math.max(1, Math.round(checkSec / 60)) : null,
        checkEndTimestamp: checkEnd,
        checkPausedRemainingSeconds: null,
        checkStaffName: checkSec ? (extra?.checkStaffName || '') : '',
        checkProcess: checkSec ? (extra?.checkProcess || 'チェック') : 'チェック',
        checkStatus: checkSec ? 'running' : 'stopped',
        isCheckCompleted: false,
        checkAlerted: false,
        watchAlarmSoundEnabled: !!extra?.watchAlarmSoundEnabled,
        alarmSoundEnabled: !!extra?.alarmSoundEnabled,
        actionStatus: null,
        helpProcess: '',
        isShampooing: false,
        isRecruiting: false,
        isNoHelpNeeded: false,
        assistantStaffName: '',
        history: [
          {
            id: String(Date.now()),
            type: 'start',
            text: checkSec
              ? `Apple Watchからタイマー開始 (${Math.round(totalSec / 60)}分 / チェック${Math.round(checkSec / 60)}分)`
              : `Apple Watchからタイマー開始 (${Math.round(totalSec / 60)}分)`,
            time: getCurrentTimeFormatted(),
            staff: watchUser || userName || 'スタイリスト',
          },
        ],
      };

      setSeats((prevSeats) => {
        const existingIdx = prevSeats.findIndex((s) => {
          if (!s) return false;
          if (String(s.id) === String(newSeatObj.id) || (s.cloudTimerId && String(s.cloudTimerId) === String(newSeatObj.id))) {
            return true;
          }
          if (Number(s.seatNumber) === Number(seatNum)) return true;
          const cleanLabel = String(s.seatLabel || s.name || '').replace(/席$/, '').trim();
          return cleanLabel === `${seatNum}番`;
        });
        let updated;
        if (existingIdx >= 0) {
          const existing = prevSeats[existingIdx];
          const resolvedId = existing.id;
          if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[resolvedId] = false;
          if (checkAlertedRef.current) checkAlertedRef.current[resolvedId] = false;
          if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[resolvedId] = false;
          if (escalatedAlertRef.current) escalatedAlertRef.current[resolvedId] = false;
          updated = prevSeats.map((s, idx) =>
            idx === existingIdx
              ? {
                  ...s,
                  ...newSeatObj,
                  id: existing.id,
                  cloudTimerId: existing.cloudTimerId || existing.id,
                  seatLabel: existing.seatLabel || newSeatObj.seatLabel,
                  name: existing.name || existing.seatLabel || newSeatObj.seatLabel,
                  history: shouldRetainSeatHistory(existing)
                    ? [...(existing.history || []), ...newSeatObj.history]
                    : newSeatObj.history,
                }
              : s
          );
        } else {
          // 参加者（ゲスト）側では新規席の追加をブロック（招待元の席マスターのみ使用）
          if (!isSalonOwnerRef.current) {
            syncSeatsToWatch(prevSeats, userName, staffMembers, { immediate: true });
            return prevSeats;
          }
          updated = [...prevSeats, newSeatObj];
        }
        saveSeatsToStorage(updated);
        syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });
        return updated;
      });
      return;
    }

    // ★ Watch でアラームを止めた → iPhone 側で鳴っている同じ席のアラームも止める
    // 放置タイム終了のアラーム（kind: 'main'）なら席を停止、チェックアラーム（kind: 'check'）ならチェック完了にする
    if (action === 'STOP_ALARM') {
      if (seatId === 'main-timer' || seatId === '-1' || Number(seatId) === -1) {
        stopAlarm('main', 'main-timer');
        const resetTarget = _cachedMainTimerState?.targetTime || 600;
        updateCachedMainTimerState({
          ...(_cachedMainTimerState || {}),
          remainingTime: resetTarget,
          targetTime: resetTarget,
          targetEndTimestamp: 0,
          isRunning: false,
          isPaused: false,
          isCountUp: false,
          isPreCountingDown: false,
        });
        return;
      }
      if (!seatId) return;
    }

    if (!seatId) return;

    // ★ Watch からの「止める」系操作で共通の停止状態（Watch の表示と同じ 0:00 の停止）
    const stopSeat = (s, label) => {
      const staff = watchUser || userName || 'スタッフ';
      return buildStoppedSeat(s, staff, `${staff} ${label}（Apple Watch）`);
    };

    // ★ 遅れて届いた停止系操作か（Watch が操作した時に見ていた終了時刻 expectedEnd と照合）
    //   iPhone アプリが動いていない間に予備ルートで待たされ、その間に再スタートした席を止めないようにする。
    //   expectedEnd: 稼働中だった時はその終了時刻(ms)、停止中だった時は 0。古い Watch アプリ（値なし）は従来どおり反映。
    const STOP_ACTIONS = ['STOP_TIMER', 'FINISH_MEASURE', 'ENTER_HELP', 'RESET_ZERO', 'STOP_ALARM'];
    const isStaleStop = (s) => {
      if (!STOP_ACTIONS.includes(action)) return false;
      if (extra?.expectedEnd === undefined || extra?.expectedEnd === null) return false;
      const expected = Number(extra.expectedEnd);
      if (!Number.isFinite(expected)) return false;
      if (s.status !== 'running') return false; // すでに止まっている席はそのまま反映
      if (expected <= 0) return true; // Watch では停止中だった席が、今は稼働中 → 後から再スタートされた
      // Watch と iPhone の時計・通信のずれを考えて 15 秒まで同じ終了時刻とみなす（Watch側の15秒許容幅と完全統一）
      return Math.abs((Number(s.targetEndTimestamp) || 0) - expected) > 15000;
    };

    setSeats((prevSeats) => {
      // ★ Watch側が未同期のローカルID（"1" 等）で送ってきた場合も、ID・cloudTimerId・席番号・席ラベルで確実に照合する
      let matchedIdx = prevSeats.findIndex(
        (s) => s && (String(s.id) === String(seatId) || (s.cloudTimerId && String(s.cloudTimerId) === String(seatId)))
      );
      if (matchedIdx < 0) {
        const rawLabel = String(extra?.seatLabel || message?.seatLabel || '').trim();
        if (rawLabel) {
          const cleanRaw = rawLabel.replace(/席$/, '');
          matchedIdx = prevSeats.findIndex((s) => {
            if (!s) return false;
            const sl = String(s.seatLabel || s.name || '').trim();
            return sl === rawLabel || sl.replace(/席$/, '') === cleanRaw;
          });
        }
      }
      if (matchedIdx < 0) {
        const numMatch = String(extra?.seatNumber || message?.seatNumber || seatId || '').match(/\d+/);
        const targetNum = numMatch ? parseInt(numMatch[0], 10) : null;
        if (targetNum != null) {
          matchedIdx = prevSeats.findIndex((s, i) => {
            if (!s) return false;
            if (Number(s.seatNumber) === targetNum) return true;
            const labelNum = String(s.seatLabel || s.name || '').match(/\d+/);
            if (labelNum && parseInt(labelNum[0], 10) === targetNum) return true;
            return i + 1 === targetNum;
          });
        }
      }
      // ★ 万が一該当席が存在しない状態で START_TIMER が来た場合は、オーナー時のみその番号の席を自動生成して開始（ゲストによる勝手な席増加を防止）
      let baseSeats = prevSeats;
      if (matchedIdx < 0 && action === 'START_TIMER' && isSalonOwnerRef.current) {
        const numMatch = String(extra?.seatNumber || message?.seatNumber || seatId || '').match(/\d+/);
        const newNum = numMatch ? parseInt(numMatch[0], 10) : prevSeats.length + 1;
        const autoSeat = {
          id: String(seatId || `seat-${Date.now()}`),
          seatNumber: newNum,
          seatLabel: extra?.seatLabel || `${newNum}番席`,
          status: 'idle',
          colorStaffName: watchUser || userName || 'スタイリスト',
          createdBy: myUserIdRef.current || myUserId || null,
          dirtySync: true,
          targetSeconds: 0,
          targetEndTimestamp: 0,
          pausedRemainingSeconds: 0,
          comment: '',
          history: [],
        };
        baseSeats = [...prevSeats, autoSeat];
        matchedIdx = baseSeats.length - 1;
      }

      if (matchedIdx < 0 && STOP_ACTIONS.includes(action)) {
        // すでに削除済みの席に対する停止通知の場合は、孤立したAlarmKit予約のみ安全に消火して終了
        const stopKind = String(extra?.kind || message?.kind || '').toLowerCase();
        if (action === 'STOP_ALARM' && stopKind !== 'main') {
          stopAlarm('salon', `${seatId}-check`);
        } else {
          stopAlarm('salon', `${seatId}-main`);
          stopAlarm('salon', `${seatId}-check`);
        }
        return prevSeats;
      }

      let hasChanged = false;
      const updated = baseSeats.map((s, idx) => {
        if (idx !== matchedIdx) return s;
        if (isStaleStop(s)) return s;
        hasChanged = true;

        switch (action) {
          case 'START_SHAMPOO': {
            stopAlarm('salon', `${s.id}-main`);
            stopAlarm('salon', `${s.id}-check`);
            if (String(s.id) !== String(seatId)) {
              stopAlarm('salon', `${seatId}-main`);
              stopAlarm('salon', `${seatId}-check`);
            }
            if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[s.id] = false;
            if (checkAlertedRef.current) checkAlertedRef.current[s.id] = false;
            if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[s.id] = false;
            if (escalatedAlertRef.current) escalatedAlertRef.current[s.id] = false;
            const staff = watchUser || s.assistantStaffName || userName || 'スタッフ';
            return {
              ...s,
              status: 'paused',
              pausedRemainingSeconds: 0,
              targetSeconds: 0,
              initialMinutes: 0,
              targetEndTimestamp: null,
              lastStoppedAt: Date.now(),
              lastStoppedTargetEndTimestamp: Number(s.targetEndTimestamp) || Number(s.lastStoppedTargetEndTimestamp) || 0,
              isOver: false,
              isReset: true,
              timeUpTimestamp: null,
              escalationLevel: 0,
              mainStaffConfirmed: true,
              assistantStaffConfirmed: true,
              stoppedBy: staff,
              collapsedAtEnd: Date.now(),
              isShampooing: true,
              actionStatus: 'shampoo',
              helpProcess: 'シャンプー',
              assistantStaffName: staff,
              isRecruiting: false,
              isNoHelpNeeded: false,
              checkTargetSeconds: null,
              checkTotalSeconds: null,
              checkEndTimestamp: null,
              checkPausedRemainingSeconds: null,
              checkInitialMinutes: null,
              checkStaffName: '',
              checkProcess: 'チェック',
              checkStatus: 'stopped',
              isCheckCompleted: false,
              checkAlerted: false,
              history: [],
            };
          }
          case 'FINISH_SHAMPOO': {
            return {
              ...s,
              isShampooing: false,
              actionStatus: null,
              helpProcess: '',
            };
          }
          case 'UPDATE_STATUS': {
            const nextStatus = extra?.actionStatus;
            const isNormal = !nextStatus || nextStatus === 'normal';
            const isShampoo = isNormal ? false : (extra?.isShampooing ?? (nextStatus === 'shampoo'));
            const matchedInfo = isNormal ? null : getActionStatusInfo(nextStatus, isShampoo);
            return {
              ...s,
              isShampooing: isShampoo,
              actionStatus: isNormal ? null : (matchedInfo?.id || nextStatus || null),
              helpProcess: isNormal ? '' : (matchedInfo?.label || s.helpProcess || ''),
              assistantStaffName: isNormal ? s.assistantStaffName : (s.assistantStaffName || watchUser || ''),
              ...(isShampoo ? { history: [] } : {}),
            };
          }
          case 'ENTER_HELP': {
            stopAlarm('salon', `${s.id}-main`);
            stopAlarm('salon', `${s.id}-check`);
            if (String(s.id) !== String(seatId)) {
              stopAlarm('salon', `${seatId}-main`);
              stopAlarm('salon', `${seatId}-check`);
            }
            if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[s.id] = false;
            if (checkAlertedRef.current) checkAlertedRef.current[s.id] = false;
            if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[s.id] = false;
            if (escalatedAlertRef.current) escalatedAlertRef.current[s.id] = false;
            const rawProcess = extra?.helpProcess || s.helpProcess || s.actionStatus || 'シャンプー';
            const matchedInfo = getActionStatusInfo(rawProcess, rawProcess === 'シャンプー' || rawProcess === 'shampoo');
            const resolvedActionId = matchedInfo ? matchedInfo.id : 'shampoo';
            const process = matchedInfo ? matchedInfo.label : (String(rawProcess).trim() || 'シャンプー');
            const existingAssist =
              s.assistantStaffName && s.assistantStaffName !== 'ヘルプなし' && s.assistantStaffName !== 'none'
                ? s.assistantStaffName
                : '';
            const staff = watchUser || existingAssist || userName || 'スタッフ';
            return {
              ...s,
              status: 'paused',
              // Watch側の表示（大元・チェック共に00:00リセット＆カード折りたたみ）と一致させつつ、入った工程・担当者をクラウド共有相手に正確に伝える
              pausedRemainingSeconds: 0,
              targetSeconds: 0,
              initialMinutes: 0,
              targetEndTimestamp: null,
              lastStoppedAt: Date.now(),
              lastStoppedTargetEndTimestamp: Number(s.targetEndTimestamp) || Number(s.lastStoppedTargetEndTimestamp) || 0,
              isOver: false,
              isReset: true,
              timeUpTimestamp: null,
              escalationLevel: 0,
              mainStaffConfirmed: true,
              assistantStaffConfirmed: true,
              stoppedBy: staff,
              collapsedAtEnd: Date.now(),
              assistantStaffName: staff,
              isShampooing: resolvedActionId === 'shampoo',
              actionStatus: resolvedActionId,
              helpProcess: process,
              isRecruiting: false,
              isNoHelpNeeded: false,
              checkTargetSeconds: null,
              checkTotalSeconds: null,
              checkEndTimestamp: null,
              checkPausedRemainingSeconds: null,
              checkInitialMinutes: null,
              checkStaffName: '',
              checkProcess: 'チェック',
              checkStatus: 'stopped',
              isCheckCompleted: false,
              checkAlerted: false,
              history: [],
            };
          }
          case 'ASSIGN_HELP': {
            const hasCheckStaff = extra?.checkStaffName !== undefined;
            const hasAssistantStaff = extra?.assistantStaffName !== undefined;
            const isSubCheckOnly = extra?.isSubCheck === true || (hasCheckStaff && !hasAssistantStaff);
            const rawStaff = hasCheckStaff ? extra.checkStaffName : (hasAssistantStaff ? extra.assistantStaffName : watchUser);
            const staff = (rawStaff !== undefined && rawStaff !== null) ? rawStaff : '';
            if (isSubCheckOnly) {
              return {
                ...s,
                checkStaffName: staff,
                checkProcess: sanitizeCheckProcess(extra?.checkProcess || s.checkProcess),
              };
            }
            const process = extra?.helpProcess ?? '';
            if (staff === 'ヘルプなし' || staff === 'none' || process === 'ヘルプなし') {
              return {
                ...s,
                isRecruiting: false,
                isNoHelpNeeded: true,
                assistantStaffName: 'ヘルプなし',
                helpProcess: '',
                actionStatus: null,
                isShampooing: false,
              };
            }
            const matchedInfo = getActionStatusInfo(process, process === 'シャンプー' || process === 'shampoo');
            const canonicalStatus = matchedInfo ? matchedInfo.id : (process ? 'shampoo' : null);
            const isCheck = canonicalStatus === 'check';
            return {
              ...s,
              isRecruiting: false,
              isNoHelpNeeded: false,
              helpProcess: process,
              assistantStaffName: staff,
              actionStatus: canonicalStatus,
              isShampooing: s.status !== 'running' && canonicalStatus === 'shampoo',
              ...(isCheck ? { checkStaffName: staff } : {}),
            };
          }
          case 'RECRUIT_HELP': {
            if (extra?.isSubCheck === true) {
              return {
                ...s,
                checkStaffName: '募集中',
                checkProcess: sanitizeCheckProcess(extra?.checkProcess || extra?.helpProcess || s.checkProcess),
              };
            }
            const process = extra?.helpProcess || s.helpProcess || s.actionStatus || 'シャンプー';
            const matchedInfo = getActionStatusInfo(process, process === 'シャンプー' || process === 'shampoo');
            const canonicalStatus = matchedInfo ? matchedInfo.id : 'shampoo';
            const isCheck = canonicalStatus === 'check';
            return {
              ...s,
              isRecruiting: true,
              isNoHelpNeeded: false,
              helpProcess: process,
              ...(isCheck
                ? { checkStaffName: '', assistantStaffName: '', actionStatus: canonicalStatus, isShampooing: false }
                : {
                    assistantStaffName: '',
                    actionStatus: canonicalStatus,
                    isShampooing: s.status !== 'running' && canonicalStatus === 'shampoo',
                  }),
            };
          }
          case 'CLAIM_CHECK': {
            return {
              ...s,
              checkStaffName: watchUser || 'チェック担当',
            };
          }
          case 'COMPLETE_CHECK': {
            stopAlarm('salon', `${s.id}-check`);
            if (String(s.id) !== String(seatId)) {
              stopAlarm('salon', `${seatId}-check`);
            }
            if (checkAlertedRef.current) {
              checkAlertedRef.current[s.id] = false;
            }
            const prevHist = s.history || [];
            const chkStaff = watchUser || s.checkStaffName || 'スタッフ';
            const chkProcLabel = sanitizeCheckProcess(s.checkProcess);
            const preservedCheckSec = s.checkTargetSeconds || s.checkTotalSeconds || 60;
            return {
              ...s,
              isCheckCompleted: true,
              checkStatus: 'completed',
              checkEndTimestamp: null,
              checkTargetSeconds: preservedCheckSec,
              checkTotalSeconds: preservedCheckSec,
              checkStaffName: chkStaff,
              checkProcess: chkProcLabel,
              history: [
                ...prevHist,
                {
                  id: `h-${Date.now()}`,
                  time: getCurrentTimeFormatted(),
                  text: `${chkStaff} ${chkProcLabel}完了（Apple Watch）`,
                  type: 'check',
                },
              ],
            };
          }
          case 'CANCEL_CHECK': {
            stopAlarm('salon', `${s.id}-check`);
            if (String(s.id) !== String(seatId)) {
              stopAlarm('salon', `${seatId}-check`);
            }
            if (checkAlertedRef.current) {
              checkAlertedRef.current[s.id] = false;
            }
            return {
              ...s,
              checkTargetSeconds: null,
              checkTotalSeconds: null,
              checkEndTimestamp: null,
              checkStaffName: '',
              checkProcess: 'チェック',
              checkStatus: 'stopped',
              isCheckCompleted: false,
            };
          }
          case 'SET_CHECK_TIMER': {
            const rawCheckSec = Number(extra?.checkTotalSeconds || extra?.checkSeconds || 0);
            if (rawCheckSec <= 0) {
              hasChanged = false;
              return s;
            }
            const defaultCheckEnd = Date.now() + rawCheckSec * 1000;
            const incomingCheckEnd = Number(extra?.checkEndTimestamp || 0);
            const checkEnd = (incomingCheckEnd > Date.now() && Math.abs(incomingCheckEnd - defaultCheckEnd) <= 15000)
              ? incomingCheckEnd
              : defaultCheckEnd;
            const chkProcess = sanitizeCheckProcess(extra?.checkProcess);
            const chkStaff = extra?.checkStaffName !== undefined && extra?.checkStaffName !== null
              ? String(extra.checkStaffName)
              : '';
            const prevHist = s.history || [];
            const chkMins = Math.max(1, Math.round(rawCheckSec / 60));
            const staffNote = chkStaff ? ` (${chkStaff === '募集中' ? '全員募集' : `担当:${chkStaff}`})` : '';
            if (checkAlertedRef.current) {
              checkAlertedRef.current[s.id] = false;
            }
            return {
              ...s,
              checkTargetSeconds: rawCheckSec,
              checkTotalSeconds: rawCheckSec,
              checkInitialMinutes: chkMins,
              checkEndTimestamp: checkEnd,
              checkPausedRemainingSeconds: null,
              checkStatus: 'running',
              isCheckCompleted: false,
              checkProcess: chkProcess,
              checkStaffName: chkStaff,
              checkAlerted: false,
              history: [
                ...prevHist,
                {
                  id: `h-${Date.now()}`,
                  time: getCurrentTimeFormatted(),
                  text: `チェックタイマー追加 (${chkMins}分 / ${chkProcess}${staffNote})`,
                  type: 'check',
                },
              ],
            };
          }
          case 'RESET_ZERO': {
            stopAlarm('salon', `${s.id}-main`);
            stopAlarm('salon', `${s.id}-check`);
            if (String(s.id) !== String(seatId)) {
              stopAlarm('salon', `${seatId}-main`);
              stopAlarm('salon', `${seatId}-check`);
            }
            if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[s.id] = false;
            if (checkAlertedRef.current) checkAlertedRef.current[s.id] = false;
            if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[s.id] = false;
            if (escalatedAlertRef.current) escalatedAlertRef.current[s.id] = false;
            return { ...stopSeat(s, 'タイマーを止める'), collapsedAtEnd: Date.now() };
          }
          case 'STOP_TIMER': {
            stopAlarm('salon', `${s.id}-main`);
            stopAlarm('salon', `${s.id}-check`);
            if (String(s.id) !== String(seatId)) {
              stopAlarm('salon', `${seatId}-main`);
              stopAlarm('salon', `${seatId}-check`);
            }
            if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[s.id] = false;
            if (checkAlertedRef.current) checkAlertedRef.current[s.id] = false;
            if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[s.id] = false;
            if (escalatedAlertRef.current) escalatedAlertRef.current[s.id] = false;
            return { ...stopSeat(s, 'タイマーを止める'), collapsedAtEnd: Date.now() };
          }
          case 'FINISH_MEASURE': {
            // ★ 以前は未対応だったため、Watch で計測終了しても次の同期で「超過」に戻っていた
            // ★ カードの収納は、停止している間だけ保つ（再スタートで自動的に解除）
            stopAlarm('salon', `${s.id}-main`);
            stopAlarm('salon', `${s.id}-check`);
            if (String(s.id) !== String(seatId)) {
              stopAlarm('salon', `${seatId}-main`);
              stopAlarm('salon', `${seatId}-check`);
            }
            if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[s.id] = false;
            if (checkAlertedRef.current) checkAlertedRef.current[s.id] = false;
            if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[s.id] = false;
            if (escalatedAlertRef.current) escalatedAlertRef.current[s.id] = false;
            return { ...stopSeat(s, 'タイマーを止める'), collapsedAtEnd: Date.now() };
          }
          case 'STOP_ALARM': {
            // ★ チェック時間のアラーム停止ならチェックを完了にする（全体タイマーは終了前でも反映）
            const stopKind = String(extra?.kind || message?.kind || '').toLowerCase();
            if (stopKind === 'check') {
              // すでに新しく未来のチェックタイマーが稼働中の場合は、遅れて届いた古いチェック停止通知なので無視
              if (s.status === 'running' && s.checkStatus === 'running' && Number(s.checkEndTimestamp) > Date.now() + 15000) {
                hasChanged = false;
                return s;
              }
              stopAlarm('salon', `${s.id}-check`);
              if (String(s.id) !== String(seatId)) {
                stopAlarm('salon', `${seatId}-check`);
              }
              if (checkAlertedRef.current) checkAlertedRef.current[s.id] = false;
              if (s.checkStatus === 'completed') {
                hasChanged = false;
                return s;
              }
              const prevHist = s.history || [];
              const chkStaff = watchUser || s.checkStaffName || 'スタッフ';
              const chkProcLabel = sanitizeCheckProcess(s.checkProcess);
              const preservedCheckSec = s.checkTargetSeconds || s.checkTotalSeconds || 60;
              return {
                ...s,
                isCheckCompleted: true,
                checkStatus: 'completed',
                checkEndTimestamp: null,
                checkTargetSeconds: preservedCheckSec,
                checkTotalSeconds: preservedCheckSec,
                checkStaffName: chkStaff,
                checkProcess: chkProcLabel,
                history: [
                  ...prevHist,
                  {
                    id: `h-${Date.now()}`,
                    time: getCurrentTimeFormatted(),
                    text: `${chkStaff} ${chkProcLabel}完了（Apple Watch）`,
                    type: 'check',
                  },
                ],
              };
            }
            // 終了時刻に達している（またはWatchとiPhoneの時計差15秒以内で稼働中の）席だけ止める（すでに新しく未来へ再入力済みならAlarmKit予約も含め消さない）
            if (s.status !== 'running' || !s.targetEndTimestamp || Date.now() + 15000 < s.targetEndTimestamp) {
              if (s.status !== 'running') {
                stopAlarm('salon', `${s.id}-main`);
                stopAlarm('salon', `${s.id}-check`);
                if (String(s.id) !== String(seatId)) {
                  stopAlarm('salon', `${seatId}-main`);
                  stopAlarm('salon', `${seatId}-check`);
                }
              }
              hasChanged = false;
              return s;
            }
            stopAlarm('salon', `${s.id}-main`);
            stopAlarm('salon', `${s.id}-check`);
            if (String(s.id) !== String(seatId)) {
              stopAlarm('salon', `${seatId}-main`);
              stopAlarm('salon', `${seatId}-check`);
            }
            if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[s.id] = false;
            if (checkAlertedRef.current) checkAlertedRef.current[s.id] = false;
            if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[s.id] = false;
            if (escalatedAlertRef.current) escalatedAlertRef.current[s.id] = false;
            return { ...stopSeat(s, 'アラーム停止'), collapsedAtEnd: Date.now() };
          }
          case 'START_TIMER': {
            const targetSec = Math.round(Number(extra?.targetSeconds) || 600);
            const rawCheckSec = extra?.checkTotalSeconds && Number(extra.checkTotalSeconds) > 0
              ? Math.round(Number(extra.checkTotalSeconds))
              : null;
            // ★ 安全ガード: チェック時間は全体タイムより短い場合のみ有効
            const checkSec = (rawCheckSec && rawCheckSec < targetSec) ? rawCheckSec : null;
            const defaultTargetEnd = Date.now() + targetSec * 1000;
            const incomingTargetEnd = Math.round(Number(extra?.targetEndTimestamp || 0));
            const targetEnd = Math.round(
              (incomingTargetEnd > Date.now() && Math.abs(incomingTargetEnd - defaultTargetEnd) <= 15000)
                ? incomingTargetEnd
                : defaultTargetEnd
            );
            const defaultCheckEnd = checkSec ? Date.now() + checkSec * 1000 : null;
            const incomingCheckEnd = Math.round(Number(extra?.checkEndTimestamp || 0));
            const checkEnd = checkSec
              ? Math.round((incomingCheckEnd > Date.now() && Math.abs(incomingCheckEnd - defaultCheckEnd) <= 15000) ? incomingCheckEnd : defaultCheckEnd)
              : null;
            const wasActivelyPlacing = shouldRetainSeatHistory(s);
            const prevHistory = wasActivelyPlacing ? (s.history || []) : [];
            const historyText = checkSec
              ? `Apple Watchからタイマー${wasActivelyPlacing ? '変更' : '開始'} (${Math.round(targetSec / 60)}分 / チェック${Math.round(checkSec / 60)}分)`
              : `Apple Watchからタイマー${wasActivelyPlacing ? '変更' : '開始'} (${Math.round(targetSec / 60)}分)`;
            const watchOperatorName =
              (watchUser && String(watchUser).trim()) || userNameRef.current || userName || 'スタイリスト';
            const matchedWatchMember = Array.isArray(staffMembersRef.current)
              ? staffMembersRef.current.find((m) => {
                  if (!m || typeof m !== 'object') return false;
                  const nick = String(m.customNickname || m.originalNickname || m.name || '').trim();
                  return nick && nick === watchOperatorName && m.user_id && !String(m.user_id).startsWith('mem_');
                })
              : null;
            const watchOperatorUserId = matchedWatchMember?.user_id || myUserIdRef.current || myUserId || null;
            const newHistoryItem = {
              id: `h-${Date.now()}`,
              time: getCurrentTimeFormatted(),
              text: historyText,
              type: 'timer',
              staff: watchOperatorName,
            };

            return {
              ...s,
              status: 'running',
              targetSeconds: targetSec,
              initialMinutes: Math.round(targetSec / 60),
              targetEndTimestamp: targetEnd,
              lastStoppedAt: 0,
              lastStoppedTargetEndTimestamp: 0,
              pausedRemainingSeconds: null,
              colorStaffName: watchOperatorName,
              createdBy: watchOperatorUserId,
              dirtySync: true,
              assistantStaffName: '',
              helpProcess: '',
              actionStatus: null,
              isShampooing: false,
              isRecruiting: false,
              isNoHelpNeeded: false,
              // ★ Watch から指定された途中チェック（サブタイマー）を反映（前回のコーミング等の幽霊残りをリセット）
              checkTargetSeconds: checkSec,
              checkTotalSeconds: checkSec,
              checkInitialMinutes: checkSec ? Math.round(checkSec / 60) : null,
              checkEndTimestamp: checkEnd,
              checkPausedRemainingSeconds: null,
              checkStaffName: checkSec ? (extra?.checkStaffName || '') : '',
              checkProcess: checkSec ? sanitizeCheckProcess(extra?.checkProcess) : 'チェック',
              checkStatus: checkSec ? 'running' : 'stopped',
              isCheckCompleted: false,
              checkAlerted: false,
              watchAlarmSoundEnabled: extra?.watchAlarmSoundEnabled !== undefined ? !!extra.watchAlarmSoundEnabled : !!s.watchAlarmSoundEnabled,
              alarmSoundEnabled: extra?.alarmSoundEnabled !== undefined ? !!extra.alarmSoundEnabled : false,
              // 前回のタイムアップ記録を消す（新しいタイマーとして扱う）
              timeUpTimestamp: null,
              escalationLevel: 0,
              isReset: false,
              isOver: false,
              stoppedBy: null,
              collapsedAtEnd: null,
              history: [...prevHistory, newHistoryItem],
            };
          }
          case 'ADJUST_TIME': {
            // ★ 0 を 5 分に変えないよう、数値かどうかで判定する
            const rawAdd = Number(extra?.secondsToAdd);
            const secondsToAdd = Number.isFinite(rawAdd) ? rawAdd : 300;
            if (secondsToAdd === 0) {
              hasChanged = false;
              return s;
            }
            if (extra?.isSubCheck) {
              const currentCheckEnd = s.checkEndTimestamp || Date.now();
              const computedCheckEnd = Math.max(Date.now() + 5000, currentCheckEnd + secondsToAdd * 1000);
              const incomingCheckEnd = Math.round(Number(extra?.checkEndTimestamp || 0));
              const newCheckEnd = Math.round(
                (incomingCheckEnd > Date.now() && Math.abs(incomingCheckEnd - computedCheckEnd) <= 15000)
                  ? incomingCheckEnd
                  : computedCheckEnd
              );
              const nextCheckSec = Math.max(10, (s.checkTargetSeconds || s.checkTotalSeconds || 0) + secondsToAdd);
              stopAlarm('salon', `${s.id}-check`);
              if (checkAlertedRef.current) {
                checkAlertedRef.current[s.id] = false;
              }
              return {
                ...s,
                checkTargetSeconds: nextCheckSec,
                checkTotalSeconds: nextCheckSec,
                checkInitialMinutes: Math.max(1, Math.round(nextCheckSec / 60)),
                checkEndTimestamp: newCheckEnd,
                checkStatus: 'running',
                isCheckCompleted: false,
                checkAlerted: false,
              };
            }
            if (s.status !== 'running') {
              // ★ 停止中は残り時間だけ変えて停止のまま（Watch の表示と同じ。以前は勝手に再開していた）
              const newRemaining = Math.round(Math.max(0, (s.pausedRemainingSeconds || 0) + secondsToAdd));
              const nextTargetSec = Math.round(Math.max(newRemaining, (s.targetSeconds || 0) + secondsToAdd));
              return {
                ...s,
                targetSeconds: nextTargetSec,
                initialMinutes: nextTargetSec > 0 ? Math.max(1, Math.round(nextTargetSec / 60)) : 0,
                pausedRemainingSeconds: newRemaining,
                // 残りが入ったら「リセット済 (0:00)」表示をやめる
                isReset: newRemaining > 0 ? false : s.isReset,
                collapsedAtEnd: null,
                history: [],
              };
            }
            const currentEnd = s.targetEndTimestamp || Date.now();
            const computedEnd = Math.max(Date.now(), currentEnd) + secondsToAdd * 1000;
            const incomingEnd = Math.round(Number(extra?.targetEndTimestamp || 0));
            const newEnd = Math.round(
              (incomingEnd > Date.now() && Math.abs(incomingEnd - computedEnd) <= 15000)
                ? incomingEnd
                : computedEnd
            );
            const nextTargetSec = Math.max(10, (s.targetSeconds || 0) + secondsToAdd);
            if (newEnd > Date.now()) {
              stopAlarm('salon', `${s.id}-main`);
              if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[s.id] = false;
              if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[s.id] = false;
              if (escalatedAlertRef.current) escalatedAlertRef.current[s.id] = false;
            }
            const deltaLabel = formatDeltaSecondsLabel(secondsToAdd);
            const adjustHistoryItem = {
              id: `h-${Date.now()}`,
              time: getCurrentTimeFormatted(),
              text: secondsToAdd > 0 ? `${deltaLabel}追加放置（Apple Watch）` : `${deltaLabel}短縮（Apple Watch）`,
              type: 'extend',
            };
            const prevActiveHistory = shouldRetainSeatHistory(s) ? (s.history || []) : [];
            return {
              ...s,
              status: 'running',
              targetSeconds: nextTargetSec,
              initialMinutes: Math.max(1, Math.round(nextTargetSec / 60)),
              targetEndTimestamp: newEnd,
              isOver: newEnd <= Date.now(),
              timeUpTimestamp: newEnd <= Date.now() ? s.timeUpTimestamp : null,
              escalationLevel: newEnd <= Date.now() ? s.escalationLevel : 0,
              collapsedAtEnd: null,
              history: [...prevActiveHistory, adjustHistoryItem],
            };
          }
          case 'CLEAR_STAFF': {
            return {
              ...s,
              assistantStaffName: '',
              helpProcess: '',
              isRecruiting: false,
              isNoHelpNeeded: false,
              checkStaffName: '',
              checkProcess: 'チェック',
              isShampooing: false,
              actionStatus: null,
            };
          }
          case 'UPDATE_SOUND_SETTINGS': {
            return {
              ...s,
              watchAlarmSoundEnabled: extra?.watchAlarmSoundEnabled !== undefined ? !!extra.watchAlarmSoundEnabled : !!s.watchAlarmSoundEnabled,
              alarmSoundEnabled: extra?.alarmSoundEnabled !== undefined ? !!extra.alarmSoundEnabled : !!s.alarmSoundEnabled,
            };
          }
          default:
            hasChanged = false;
            return s;
        }
      });

      // ★ 何も変わらなければ元の配列を返す（不要な保存・Watch への同期を起こさない）
      if (!hasChanged) return prevSeats;
      const changedSeat = updated[matchedIdx];
      if (
        changedSeat?.id &&
        (action === 'START_SHAMPOO' ||
          action === 'ENTER_HELP' ||
          action === 'RESET_ZERO' ||
          action === 'STOP_TIMER' ||
          action === 'FINISH_MEASURE' ||
          action === 'START_TIMER' ||
          (action === 'STOP_ALARM' && String(extra?.kind || message?.kind || '').toLowerCase() !== 'check'))
      ) {
        setExpandedPausedSeatIds((prevExp) =>
          prevExp[changedSeat.id] ? { ...prevExp, [changedSeat.id]: false } : prevExp
        );
      }
      // ★ saveSeatsToStorage 内で syncChangedSeatsToCloud(updated) が呼ばれ、Supabase クラウドへ差分同期される（二重UPSERT防止）
      //   また、自分のWatchから来た操作に対して自分自身のWatchへ通知（watchNotif）を送り返すと二重通知になるため、データ同期のみ即時送信する
      saveSeatsToStorage(updated);
      syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });

      return updated;
    });
  };

  // ★ iPhone のアラーム画面（AlarmKit）や通知から「開く」・閉じるが押された場合:
  //   システムのアラーム音・通知のみが消火され、超過カウントアップ（超過 00:01...）は自動終了させない！
  //   アプリ内で「タイマーを止める」「シャンプーに入る」「施術終了」「リセット」等を明示的に選んだ時のみ 00:00 に戻る仕様。
  const handleUserStoppedAlarms = (_stopped) => {
    // 超過カウントアップを継続するため、席データの 0:00 リセット（buildStoppedSeat）は行わない
  };
  const handleUserStoppedAlarmsRef = useRef(null);
  handleUserStoppedAlarmsRef.current = handleUserStoppedAlarms;

  // ★ リスナーから常に「最新の」handleWatchAction を呼ぶための参照（stale closure 防止）
  const handleWatchActionRef = useRef(null);
  handleWatchActionRef.current = handleWatchAction;

  // 初期ロード
  useEffect(() => {
    loadInitialData();
  }, []);

  // ★ Apple Watchとの接続（画面表示時に1回）
  useEffect(() => {
    if (Platform.OS === 'ios') {
      WatchConnectivity.activate().catch(() => {});
    }
  }, []);

  // ★ Watchからの操作の受け取り（席データの読み込み完了後に開始）
  // 読み込み完了前・サロン画面を開く前に届いた操作は watch-connectivity 側で保留され、
  // ここで購読を始めた瞬間に古い順にまとめて反映される（取りこぼし・空データへの適用を防止）
  useEffect(() => {
    if (Platform.OS !== 'ios' || !isDataLoaded) return undefined;

    const unsubscribeActions = WatchConnectivity.subscribeActions((payload) => {
      if (payload && payload.action && handleWatchActionRef.current) {
        handleWatchActionRef.current(payload);
      }
    });

    // ★ Watchと通信可能になった瞬間に、iPhone側からも最新の席データを即時送信（Watch側の要求が届かなくても同期させる保険）
    let wasReachable = false;
    const subStatus = WatchConnectivity.addStatusListener((status) => {
      const reachable = !!(status && status.isReachable);
      if (reachable && !wasReachable && handleWatchActionRef.current) {
        handleWatchActionRef.current({ action: 'REQUEST_SYNC' });
      }
      wasReachable = reachable;
    });

    return () => {
      if (unsubscribeActions) unsubscribeActions();
      if (subStatus?.remove) subStatus.remove();
    };
  }, [isDataLoaded]);

  // ★ iPhone のアラーム画面で止められたアラームの検出（アプリが前面に戻った時と、前面にいる間の数秒ごと）
  useEffect(() => {
    if (Platform.OS !== 'ios' || !isDataLoaded) return undefined;
    return subscribeUserStoppedAlarms((stopped) => {
      if (handleUserStoppedAlarmsRef.current) handleUserStoppedAlarmsRef.current(stopped);
    });
  }, [isDataLoaded]);

  // ★ メインタイマー状態が更新された際はキャッシュの更新のみ行い、客席同期は巻き込まない（毎秒の不要通信を完全根絶）
  useEffect(() => {
    updateCachedMainTimerState(mainTimerState);
  }, [mainTimerState]);

  // ★ seats または staffMembers が更新された際のみ、Watch へ客席データを同期（データロード完了後のみ）
  useEffect(() => {
    if (!isDataLoaded) return;
    _watchAlarmSound = !!isWatchAlarmSoundEnabled;
    _cachedIsSalonOwner = isSalonOwner;
    _cachedMyUserId = myUserId;
    if (Platform.OS === 'ios') {
      syncSeatsToWatch(seats, userName, staffMembers);
    }
  }, [isDataLoaded, seats, userName, staffMembers, isWatchAlarmSoundEnabled, isSalonOwner, myUserId]);

  // ★ サロン席の終了時刻を iPhone 純正アラーム（AlarmKit）に予約
  // 共有タイマーはデフォルトでスマホから音が鳴らないようにし、入力画面で「アラーム音 ON」にした席（alarmSoundEnabled === true）かつ自分が関係者の席のみ予約する。
  useEffect(() => {
    if (Platform.OS !== 'ios' || !isDataLoaded) return;
    const desired = [];
    if (Array.isArray(seats)) {
      seats.forEach((s) => {
        if (!s || !s.id || !s.alarmSoundEnabled) return;
        const label = s.seatLabel || '席';
        if (s.status === 'running' && s.targetEndTimestamp && shouldAlertMainTimerForUser(s, userName, myUserId, staffMembers)) {
          desired.push({ key: `${s.id}-main`, timestamp: Number(s.targetEndTimestamp), title: `${label} 放置タイム終了` });
        }
        if (
          s.checkTargetSeconds > 0 &&
          (s.checkStatus === 'running' || s.checkStatus === 'timeup') &&
          s.checkEndTimestamp &&
          shouldAlertCheckTimerForUser(s, userName, myUserId, staffMembers)
        ) {
          desired.push({ key: `${s.id}-check`, timestamp: Number(s.checkEndTimestamp), title: `${label} チェック時間` });
        }
      });
    }
    setAlarms('salon', desired, { soundOn: true, stopPassedOnRemove: true });
  }, [seats, isDataLoaded, userName, myUserId, staffMembers]);

  // ★ クラウド客席タイマーとの完全整合同期（初回接続時 ＆ バックグラウンドからの 'active' 復帰時の双方で実行）
  //   - オーナー（招待元）: ローカル追加・編集席と削除待ちキューを絶対保護し、「1番席」への勝手なリセットを一切行わない
  //   - ゲスト（参加者）  : 招待元のクラウド席一覧を唯一のマスターとして完全同期する
  const reconcileCloudTimers = async (explicitSalonId = null, explicitOwnerUserId = null) => {
    const targetSalonId =
      explicitSalonId ||
      cloudSalonIdRef.current ||
      (isCloudUUID(currentSalonRef.current?.id) ? currentSalonRef.current.id : null);
    if (!targetSalonId || !myUserIdRef.current) return;
    if (reconcileInFlightRef.current) return;
    reconcileInFlightRef.current = true;

    try {
      const resolvedOwnerId = explicitOwnerUserId || currentSalonRef.current?.ownerUserId || null;
      const isOwnerOfSalon = resolvedOwnerId
        ? resolvedOwnerId === myUserIdRef.current
        : checkIsSalonOwner(currentSalonRef.current, myUserIdRef.current);

      // 1. オーナーの場合: オフライン中に削除された席の削除待ちキューを先にクラウドへ反映
      if (isOwnerOfSalon && pendingDeletedSeatsRef.current.length > 0) {
        const snapshotQueue = [...pendingDeletedSeatsRef.current];
        for (const delItem of snapshotQueue) {
          const ok = await deleteCloudTimer(
            targetSalonId,
            delItem.cloudTimerId || delItem.id,
            delItem.seatLabel
          );
          if (ok) {
            await removePendingDeletedSeat(targetSalonId, delItem.cloudTimerId || delItem.id, delItem.seatLabel);
          }
        }
      }

      // 2. クラウドの最新席一覧を取得（通信エラー時は null が返るため、ローカル席を消さずに保護して終了）
      const cloudTimers = await fetchSalonTimers(targetSalonId, { returnNullOnError: true });
      if (cloudTimers === null) {
        return;
      }

      const wasSwitchedSalon = didSwitchSalonRef.current;
      didSwitchSalonRef.current = false;

      // 3. ゲスト（参加者）の場合: 招待元のクラウド席を唯一のマスターとして100%追従同期（ローカルサンプル席は一切混入させない）
      if (!isOwnerOfSalon) {
        isRemoteSyncRef.current = true;
        setSeats((prevLocalSeats) => {
          const syncedGuestSeats = cloudTimers.map((ct) => {
            const prevMatch = Array.isArray(prevLocalSeats)
              ? prevLocalSeats.find((ls) => ls && (ls.id === ct.id || ls.cloudTimerId === ct.id))
              : null;
            const resolvedGuestHistory = shouldRetainSeatHistory(ct)
              ? (Array.isArray(prevMatch?.history) && prevMatch.history.length > 0
                  ? prevMatch.history
                  : [buildStartHistoryEntryFromSeat(ct)])
              : [];
            const item = prevMatch
              ? {
                  ...ct,
                  alarmSoundEnabled: prevMatch.alarmSoundEnabled ?? ct.alarmSoundEnabled,
                  watchAlarmSoundEnabled: prevMatch.watchAlarmSoundEnabled ?? ct.watchAlarmSoundEnabled,
                  history: resolvedGuestHistory,
                  collapsedAtEnd: ct.status === 'running' ? null : (prevMatch.collapsedAtEnd ?? ct.collapsedAtEnd),
                }
              : {
                  ...ct,
                  history: resolvedGuestHistory,
                };
            lastSyncedSeatsStateRef.current[item.id] = getSeatCloudSignature(item);
            return item;
          });
          persistSeatsForSalonId(targetSalonId, syncedGuestSeats, false).catch(() => {});
          syncSeatsToWatch(
            syncedGuestSeats,
            userNameRef.current || userName,
            staffMembersRef.current || staffMembers,
            { immediate: true, forceEmpty: syncedGuestSeats.length === 0 }
          );
          return syncedGuestSeats;
        });
        setTimeout(() => {
          isRemoteSyncRef.current = false;
        }, 300);
        return;
      }

      // 4. オーナー（招待元）の場合: 削除待ちキュー内の席を除外した上で、ローカル未同期の追加/編集席を完全保護マージ
      const activeCloudTimers = cloudTimers.filter((ct) => !isSeatInPendingDeleted(ct));

      if (activeCloudTimers.length > 0) {
        isRemoteSyncRef.current = true;
        const seatsToPushBack = [];
        const activeMyUid = myUserIdRef.current || myUserId || null;
        const activeMyName = userNameRef.current || userName || 'スタイリスト';
        const activeMembers = staffMembersRef.current || staffMembers || [];
        const shouldNormalizeCloudOnBuildUpdate =
          _wasSalonBuildUpdatedThisLaunch || _hasPendingCloudBuildNormalize;

        setSeats((prevLocalSeats) => {
          const nowMs = Date.now();
          const safePrev = Array.isArray(prevLocalSeats)
            ? prevLocalSeats.filter((ls) => !isSeatInPendingDeleted(ls))
            : [];
          const matchedLocalIds = new Set();

          const merged = activeCloudTimers.map((ct) => {
            const ctCleanLabel = String(ct.seatLabel || ct.name || '').replace(/席$/, '').trim();
            const isCloudActivelyRunning =
              ct.status === 'running' &&
              Number(ct.targetEndTimestamp) > nowMs - 3 * 3600 * 1000;
            const isUpdatedWithin3h =
              Number(ct.updatedAt || 0) > nowMs - 3 * 3600 * 1000;
            const isPeerCreator = !checkIsMainStaffOfSeat(ct, activeMyName, activeMyUid, activeMembers);
            const isPeerAssistant =
              !!ct.assistantStaffName &&
              !ct.isNoHelpNeeded &&
              ct.assistantStaffName !== 'ヘルプなし' &&
              ct.assistantStaffName !== 'none' &&
              !checkIsStaffNameMe(ct.assistantStaffName, activeMyName, activeMyUid, activeMembers);
            const isPeerInvolved = isPeerCreator || isPeerAssistant;
            const hasActiveShampooOrTreatment =
              !!ct.isShampooing || (!!ct.actionStatus && ct.actionStatus !== 'normal');
            // ★ 複数スタッフ共有時のアップデート保護（Q3 案A）:
            //   稼働中（isCloudActivelyRunning）に加え、他スタッフが直近（3時間以内）に「一時停止中」または「💧シャンプー中・施術ステータス中」にしている席も保護し、
            //   旧20:00サンプル席や古い停止残り・自分の非稼働停止席のみ 00:00（status: 'idle'）へ揃える
            const isCloudProtectedPeerSeat =
              !ct.isLegacySampleSeat &&
              isUpdatedWithin3h &&
              ((ct.status === 'paused' && Number(ct.pausedRemainingSeconds) > 0 && isPeerInvolved) ||
                (hasActiveShampooOrTreatment && (isPeerInvolved || (Array.isArray(activeMembers) && activeMembers.length > 1))));

            const localMatch = safePrev.find((ls) => {
              if (!ls || matchedLocalIds.has(ls.id)) return false;
              if (ls.id === ct.id || ls.cloudTimerId === ct.id) return true;
              const lsUuid = isCloudUUID(ls.cloudTimerId) ? ls.cloudTimerId : (isCloudUUID(ls.id) ? ls.id : null);
              if (lsUuid && isCloudUUID(ct.id) && lsUuid !== ct.id) return false;
              const lsCleanLabel = String(ls.seatLabel || ls.name || '').replace(/席$/, '').trim();
              if (ctCleanLabel && lsCleanLabel === ctCleanLabel) return true;
              const lsDigits = lsCleanLabel.match(/\d+/);
              const ctDigits = ctCleanLabel.match(/\d+/);
              if (lsDigits && ctDigits && parseInt(lsDigits[0], 10) === parseInt(ctDigits[0], 10)) return true;
              return false;
            });

            if (localMatch) {
              matchedLocalIds.add(localMatch.id);
              const isLocalRunningAhead =
                localMatch.status === 'running' &&
                Number(localMatch.targetEndTimestamp) > nowMs &&
                ct.status !== 'running';
              const cloudNeedsZeroNormalize =
                ct.status !== 'idle' ||
                Number(ct.pausedRemainingSeconds) > 0 ||
                Number(ct.targetSeconds) > 0 ||
                !ct.isReset ||
                !!ct.isShampooing ||
                !!ct.actionStatus;
              const shouldPushBuildNormalizedZero =
                (!!localMatch.buildUpdateNormalized ||
                  (shouldNormalizeCloudOnBuildUpdate && localMatch.status === 'idle' && localMatch.isReset)) &&
                !isCloudActivelyRunning &&
                !isCloudProtectedPeerSeat &&
                cloudNeedsZeroNormalize;
              // ローカルで稼働中、オフライン未同期編集（dirtySync）、またはアップデート直後の00:00正規化（クラウド非稼働・他スタッフ施術保護対象外）はローカル状態を優先保護してクラウドへ送信
              if (
                isLocalRunningAhead ||
                (localMatch.dirtySync && !isCloudActivelyRunning && !isCloudProtectedPeerSeat) ||
                shouldPushBuildNormalizedZero
              ) {
                const preserved = {
                  ...ct,
                  ...localMatch,
                  id: ct.id,
                  cloudTimerId: ct.id,
                  seatNumber: localMatch.seatNumber || ct.seatNumber,
                  seatLabel: localMatch.dirtySync
                    ? (localMatch.seatLabel || ct.seatLabel)
                    : (ct.seatLabel || localMatch.seatLabel),
                  name: localMatch.dirtySync
                    ? (localMatch.name || localMatch.seatLabel || ct.seatLabel)
                    : (ct.seatLabel || localMatch.seatLabel),
                  history: shouldRetainSeatHistory(localMatch)
                    ? (Array.isArray(localMatch.history) ? localMatch.history : [])
                    : [],
                  dirtySync: false,
                  buildUpdateNormalized: false,
                };
                seatsToPushBack.push(preserved);
                lastSyncedSeatsStateRef.current[preserved.id] = getSeatCloudSignature(preserved);
                return preserved;
              }

              const mergedItem = {
                ...ct,
                alarmSoundEnabled: localMatch.alarmSoundEnabled ?? ct.alarmSoundEnabled,
                watchAlarmSoundEnabled: localMatch.watchAlarmSoundEnabled ?? ct.watchAlarmSoundEnabled,
                history: shouldRetainSeatHistory(ct)
                  ? (Array.isArray(localMatch.history) && localMatch.history.length > 0
                      ? localMatch.history
                      : [buildStartHistoryEntryFromSeat(ct)])
                  : [],
                collapsedAtEnd: ct.status === 'running' ? null : (localMatch.collapsedAtEnd ?? ct.collapsedAtEnd),
                buildUpdateNormalized: false,
              };
              lastSyncedSeatsStateRef.current[mergedItem.id] = getSeatCloudSignature(mergedItem);
              return mergedItem;
            }

            // TestFlightアップデート初回同期時: ローカル未存在の非稼働クラウド席（他スタッフの一時停止・シャンプー保護対象外）も 00:00（status: 'idle'）へ正規化して同期
            if (
              shouldNormalizeCloudOnBuildUpdate &&
              !isCloudActivelyRunning &&
              !isCloudProtectedPeerSeat &&
              ct.status !== 'running' &&
              (ct.status !== 'idle' || Number(ct.pausedRemainingSeconds) > 0 || Number(ct.targetSeconds) > 0 || !ct.isReset || !!ct.isShampooing || !!ct.actionStatus)
            ) {
              const normalizedCloudSeat = {
                ...ct,
                status: 'idle',
                pausedRemainingSeconds: 0,
                targetSeconds: 0,
                targetTime: 0,
                initialMinutes: 0,
                targetEndTimestamp: null,
                isReset: true,
                isOver: false,
                actionStatus: null,
                isShampooing: false,
                assistantStaffName: '',
                helpProcess: '',
                isRecruiting: false,
                isNoHelpNeeded: false,
                checkTargetSeconds: null,
                checkTotalSeconds: null,
                checkEndTimestamp: null,
                checkPausedRemainingSeconds: null,
                checkStatus: 'stopped',
                isCheckCompleted: false,
                history: [],
              };
              seatsToPushBack.push(normalizedCloudSeat);
              lastSyncedSeatsStateRef.current[normalizedCloudSeat.id] = getSeatCloudSignature(normalizedCloudSeat);
              return normalizedCloudSeat;
            }

            const hydratedCloudSeat = shouldRetainSeatHistory(ct)
              ? {
                  ...ct,
                  history:
                    Array.isArray(ct.history) && ct.history.length > 0
                      ? ct.history
                      : [buildStartHistoryEntryFromSeat(ct)],
                }
              : {
                  ...ct,
                  history: [],
                };
            lastSyncedSeatsStateRef.current[hydratedCloudSeat.id] = getSeatCloudSignature(hydratedCloudSeat);
            return hydratedCloudSeat;
          });

          // オフライン中や通信前にオーナーが追加したローカル未同期席（非UUID席または dirtySync 席）を絶対に消さず保持＆クラウドへ追加
          if (!wasSwitchedSalon) {
            safePrev.forEach((ls) => {
              if (!ls || matchedLocalIds.has(ls.id)) return;
              const hasCloudId = isCloudUUID(ls.cloudTimerId || ls.id);
              if (!hasCloudId || ls.dirtySync) {
                merged.push(ls);
                seatsToPushBack.push(ls);
              }
            });
          }

          persistSeatsForSalonId(targetSalonId, merged, true).catch(() => {});
          syncSeatsToWatch(merged, userNameRef.current || userName, staffMembersRef.current || staffMembers);
          return merged;
        });

        if (seatsToPushBack.length > 0) {
          Promise.all(
            seatsToPushBack.map((seatToSync) =>
              upsertCloudTimer(targetSalonId, seatToSync)
                .then((saved) => {
                  if (saved?.id) {
                    lastSyncedSeatsStateRef.current[saved.id] = getSeatCloudSignature(saved);
                    if (seatToSync.id !== saved.id || seatToSync.dirtySync) {
                      setSeats((curr) => {
                        const next = curr.map((item) =>
                          item.id === seatToSync.id
                            ? { ...item, id: saved.id, cloudTimerId: saved.id, dirtySync: false }
                            : item
                        );
                        persistSeatsForSalonId(targetSalonId, next, true).catch(() => {});
                        return next;
                      });
                    }
                    return true;
                  }
                  return false;
                })
                .catch(() => false)
            )
          ).then((results) => {
            if (results.every(Boolean)) {
              _wasSalonBuildUpdatedThisLaunch = false;
              _hasPendingCloudBuildNormalize = false;
              AsyncStorage.removeItem(SALON_PENDING_CLOUD_BUILD_NORMALIZE_KEY).catch(() => {});
            }
          });
        } else {
          _wasSalonBuildUpdatedThisLaunch = false;
          _hasPendingCloudBuildNormalize = false;
          AsyncStorage.removeItem(SALON_PENDING_CLOUD_BUILD_NORMALIZE_KEY).catch(() => {});
        }
        setTimeout(() => {
          isRemoteSyncRef.current = false;
        }, 300);
      } else {
        _wasSalonBuildUpdatedThisLaunch = false;
        _hasPendingCloudBuildNormalize = false;
        AsyncStorage.removeItem(SALON_PENDING_CLOUD_BUILD_NORMALIZE_KEY).catch(() => {});
        // クラウドが0席の初回登録時: 「1番席」への強制リセットは行わず、オーナー現在の全ローカル席をそのままクラウドへ登録する
        const currentOwnerSeats = (Array.isArray(seatsRef.current) ? seatsRef.current : []).filter(
          (ls) => ls && !isSeatInPendingDeleted(ls)
        );
        for (const s of currentOwnerSeats) {
          upsertCloudTimer(targetSalonId, s)
            .then((savedCloudSeat) => {
              if (savedCloudSeat?.id) {
                lastSyncedSeatsStateRef.current[savedCloudSeat.id] = getSeatCloudSignature(savedCloudSeat);
                setSeats((curr) => {
                  const next = curr.map((item) =>
                    item.id === s.id
                      ? { ...item, id: savedCloudSeat.id, cloudTimerId: savedCloudSeat.id, dirtySync: false }
                      : item
                  );
                  persistSeatsForSalonId(targetSalonId, next, true).catch(() => {});
                  return next;
                });
              }
            })
            .catch(() => {});
        }
      }
    } finally {
      reconcileInFlightRef.current = false;
    }
  };
  reconcileCloudTimersRef.current = reconcileCloudTimers;

  // ★ サロンのクラウド登録＆メンバーリアルタイム同期 (Supabase Realtime)
  useEffect(() => {
    if (!isDataLoaded || (!currentSalon?.inviteCode && !isCloudUUID(currentSalon?.id)) || !myUserId) return;
    if (currentSalon?.id === 'workspace-pro-demo') return;

    let isMounted = true;
    let unsubscribeMembers = null;

    const initCloudSalon = async () => {
      try {
        const localIsOwner = checkIsSalonOwner(currentSalon, myUserId);
        // 1. サロンをSupabaseクラウドへ確保・取得（ゲスト参加サロンでは allowCreate: false で勝手な空サロン新規作成を禁止）
        const cloudSalon = await syncOrCreateSalonInCloud({
          salonId: isCloudUUID(currentSalon.id) ? currentSalon.id : null,
          salonName: currentSalon.name,
          inviteCode: currentSalon.inviteCode,
          isPro: currentSalon.isPro,
          userName: userName,
          allowCreate: localIsOwner,
        });

        if (!cloudSalon || !isMounted) return;
        if (cloudSalon._removedFromMembers) {
          await detachFromRemovedGuestSalon(cloudSalon.id);
          return;
        }
        cloudSalonIdRef.current = cloudSalon.id;
        // ★ サロン接続・切替・起動時に Expo Push Token を Supabase へ登録（バックグラウンドPush通知配信用）
        registerAndSyncSalonPushToken({ salonId: cloudSalon.id, userId: myUserId }).catch(() => {});
        const resolvedIsOwner = cloudSalon.owner_user_id === myUserId;
        const resolvedRole = resolvedIsOwner ? 'owner' : 'assistant';

        // クラウド側UUID・最新招待コード・オーナーIDをローカルサロン情報へ同期（workspace-free昇格時は席データも引き継ぐ）
        if (
          currentSalon.id !== cloudSalon.id ||
          currentSalon.ownerUserId !== cloudSalon.owner_user_id ||
          (cloudSalon.invite_code && currentSalon.inviteCode !== cloudSalon.invite_code) ||
          currentSalon.role !== resolvedRole
        ) {
          const prevSalonId = currentSalon.id;
          if (prevSalonId && prevSalonId !== cloudSalon.id) {
            await persistSeatsForSalonId(cloudSalon.id, seatsRef.current, resolvedIsOwner);
            if (resolvedIsOwner) {
              await AsyncStorage.setItem(SALON_SEATS_MIGRATED_KEY, cloudSalon.id).catch(() => {});
            }
            const prevPending = await readPendingDeletedSeats(prevSalonId);
            if (prevPending.length > 0) {
              pendingDeletedSeatsRef.current = prevPending;
              await writePendingDeletedSeats(cloudSalon.id, prevPending);
              await writePendingDeletedSeats(prevSalonId, []);
            }
          }
          const updatedSalon = {
            ...currentSalon,
            id: cloudSalon.id,
            inviteCode: cloudSalon.invite_code || currentSalon.inviteCode,
            ownerUserId: cloudSalon.owner_user_id,
            role: resolvedRole,
          };
          setCurrentSalon(updatedSalon);
          currentSalonRef.current = updatedSalon;
          setSavedSalons((prev) => {
            const next = prev.map((s) => (s.id === prevSalonId || s.id === cloudSalon.id ? updatedSalon : s));
            saveSalonsToStorage(next, cloudSalon.id);
            return next;
          });
        }

        // 2. クラウド上のメンバー一覧を取得して反映
        const cloudMembers = await fetchSalonMembers(cloudSalon.id, { returnNullOnError: true });
        if (isMounted && Array.isArray(cloudMembers)) {
          if (
            !resolvedIsOwner &&
            cloudMembers.length > 0 &&
            !cloudMembers.some((m) => m && m.user_id === myUserId)
          ) {
            await detachFromRemovedGuestSalon(cloudSalon.id);
            return;
          }
          if (cloudMembers.length > 0) {
            const normalized = normalizeStaffMembers(cloudMembers, myUserId, staffMembersRef.current);
            setStaffMembers(normalized);
            staffMembersRef.current = normalized;
            updateCloudSalonMemberCountDescription(cloudSalon.id, normalized.length);
            AsyncStorage.setItem('@salon_staff_members', JSON.stringify(normalized)).catch(() => {});
            syncSeatsToWatch(_cachedCurrentSeats || seatsRef.current, userNameRef.current || userName, normalized);
          }
        }

        // 3. Supabase Realtimeでメンバー変更（参加・更新・解除）をリアルタイム監視
        unsubscribeMembers = subscribeSalonMembers(cloudSalon.id, (updatedMembers) => {
          if (!isMounted || !Array.isArray(updatedMembers)) return;
          if (
            !resolvedIsOwner &&
            updatedMembers.length > 0 &&
            !updatedMembers.some((m) => m && m.user_id === myUserId)
          ) {
            detachFromRemovedGuestSalon(
              cloudSalon.id,
              'サロン共有のメンバーから解除されたため、個人タイマー画面に戻りました。'
            );
            return;
          }
          const prevMembers = staffMembersRef.current || [];
          const normalized = normalizeStaffMembers(updatedMembers, myUserId, prevMembers);
          const renamedMap = {};
          let nextSyncedMyUserName = null;
          normalized.forEach((nm) => {
            const oldMem = prevMembers.find(
              (pm) => pm && typeof pm === 'object' && ((nm.id && pm.id === nm.id) || (nm.user_id && pm.user_id === nm.user_id))
            );
            if (oldMem) {
              const oldDisp = getMemberDisplayName(oldMem);
              const newDisp = getMemberDisplayName(nm);
              if (oldDisp && newDisp && oldDisp !== newDisp) {
                renamedMap[oldDisp] = newDisp;
              }
              if (oldMem.originalNickname && nm.originalNickname && oldMem.originalNickname !== nm.originalNickname) {
                renamedMap[oldMem.originalNickname] = getMemberDisplayName(nm);
              }
            }
            if (
              nm &&
              nm.isMe &&
              nm.originalNickname &&
              nm.originalNickname.trim() &&
              nm.originalNickname.trim() !== (userNameRef.current || '').trim() &&
              (!oldMem || oldMem.originalNickname !== nm.originalNickname)
            ) {
              nextSyncedMyUserName = nm.originalNickname.trim();
            }
          });
          if (nextSyncedMyUserName) {
            setUserName(nextSyncedMyUserName);
            userNameRef.current = nextSyncedMyUserName;
            _cachedUserName = nextSyncedMyUserName;
            AsyncStorage.setItem('@assist_timer_user_name', nextSyncedMyUserName).catch(() => {});
          }
          const effectiveWatchUserName = nextSyncedMyUserName || userNameRef.current || userName;
          setStaffMembers(normalized);
          staffMembersRef.current = normalized;
          updateCloudSalonMemberCountDescription(cloudSalon.id, normalized.length);
          AsyncStorage.setItem('@salon_staff_members', JSON.stringify(normalized)).catch(() => {});
          if (Object.keys(renamedMap).length > 0) {
            setSeats((prevSeats) => {
              let seatRenamed = false;
              const nextSeats = prevSeats.map((s) => {
                if (!s) return s;
                const nextColor = renamedMap[s.colorStaffName] || s.colorStaffName;
                const nextAssist = renamedMap[s.assistantStaffName] || s.assistantStaffName;
                const nextCheck = renamedMap[s.checkStaffName] || s.checkStaffName;
                if (nextColor !== s.colorStaffName || nextAssist !== s.assistantStaffName || nextCheck !== s.checkStaffName) {
                  seatRenamed = true;
                  return {
                    ...s,
                    colorStaffName: nextColor,
                    assistantStaffName: nextAssist,
                    checkStaffName: nextCheck,
                  };
                }
                return s;
              });
              if (seatRenamed) {
                persistSeatsForSalonId(cloudSalon.id, nextSeats, resolvedIsOwner).catch(() => {});
                syncSeatsToWatch(nextSeats, effectiveWatchUserName, normalized, { immediate: true });
                return nextSeats;
              }
              syncSeatsToWatch(_cachedCurrentSeats || prevSeats, effectiveWatchUserName, normalized, { immediate: true });
              return prevSeats;
            });
          } else {
            syncSeatsToWatch(_cachedCurrentSeats || seatsRef.current, effectiveWatchUserName, normalized, { immediate: true });
          }
        });

        // 4. クラウド上の客席タイマーを取得・マージ同期
        if (isMounted) {
          await reconcileCloudTimers(cloudSalon.id, cloudSalon.owner_user_id);
        }

        // 5. Supabase Realtimeで客席タイマーの変更（開始・延長・停止・ヘルプ指定）をリアルタイム監視！
        unsubscribeTimers = subscribeSalonTimers(cloudSalon.id, ({ eventType, newSeat, oldSeat, isSelfEcho }) => {
          if (!isMounted) return;

          if (eventType === 'INSERT' || eventType === 'UPDATE') {
            if (!newSeat) return;
            isRemoteSyncRef.current = true;
            lastSyncedSeatsStateRef.current[newSeat.id] = getSeatCloudSignature(newSeat);

            // 他端末でタイマー停止・チェック完了された場合、自端末のAlarmKit予約も即座に消火
            if (newSeat.status !== 'running') {
              stopAlarm('salon', `${newSeat.id}-main`);
              stopAlarm('salon', `${newSeat.id}-check`);
            } else if (!newSeat.checkEndTimestamp || newSeat.isCheckCompleted || newSeat.checkStatus === 'completed' || newSeat.checkStatus === 'stopped') {
              stopAlarm('salon', `${newSeat.id}-check`);
            }

            setSeats((prev) => {
              const newCleanLabel = String(newSeat.seatLabel || newSeat.name || '').replace(/席$/, '').trim();
              const idx = prev.findIndex((s) => {
                if (!s) return false;
                if (s.id === newSeat.id || s.cloudTimerId === newSeat.id) return true;
                const sUuid = isCloudUUID(s.cloudTimerId) ? s.cloudTimerId : (isCloudUUID(s.id) ? s.id : null);
                if (sUuid && isCloudUUID(newSeat.id) && sUuid !== newSeat.id) return false;
                const sClean = String(s.seatLabel || s.name || '').replace(/席$/, '').trim();
                if (newCleanLabel && sClean === newCleanLabel) return true;
                const sDigits = sClean.match(/\d+/);
                const newDigits = newCleanLabel.match(/\d+/);
                if (sDigits && newDigits && parseInt(sDigits[0], 10) === parseInt(newDigits[0], 10)) return true;
                return false;
              });

              let peerNotification = null;
              let updated;
              const activeUser = userNameRef.current;
              const activeUserId = myUserIdRef.current;
              const activeMembers = staffMembersRef.current;

              if (idx >= 0) {
                const prevItem = prev[idx];
                const shouldClearCollapsed = newSeat.status === 'running' || newSeat.isReset;

                // 他端末で既に停止・完了された場合、自端末の古い確認フラグもリセット
                if (prevItem.id && prevItem.id !== newSeat.id && newSeat.status !== 'running') {
                  stopAlarm('salon', `${prevItem.id}-main`);
                  stopAlarm('salon', `${prevItem.id}-check`);
                }

                // ★ 共有相手の操作による差分を検知し、自分がその席の関係者（＋ヘルプに入る可能性がある場合）のみ通知を生成
                const effectiveIsSelfEcho =
                  isSelfEcho || isRecentLocalActorEcho(newSeat, activeUserId);
                if (!effectiveIsSelfEcho) {
                  const label = newSeat.seatLabel || newSeat.name || prevItem.seatLabel || '席';
                  const prevHadActiveCheck =
                    prevItem.status === 'running' &&
                    (prevItem.checkStatus === 'running' || prevItem.checkStatus === 'timeup' || Number(prevItem.checkEndTimestamp) > 0) &&
                    !prevItem.isCheckCompleted;
                  const newHasActiveCheck =
                    newSeat.status === 'running' &&
                    (newSeat.checkStatus === 'running' || newSeat.checkStatus === 'timeup' || Number(newSeat.checkEndTimestamp) > 0) &&
                    !newSeat.isCheckCompleted;

                  const isPrevMainMe = isMainStaffOfSeat(prevItem, activeUser, activeUserId, activeMembers);
                  const isNewMainMe = isMainStaffOfSeat(newSeat, activeUser, activeUserId, activeMembers);
                  const isPrevAssistMe = isStaffNameMe(prevItem.assistantStaffName, activeUser, activeUserId, activeMembers);
                  const isNewAssistMe =
                    !newSeat.isRecruiting &&
                    isStaffNameMe(newSeat.assistantStaffName, activeUser, activeUserId, activeMembers);
                  const isPrevCheckMe = isStaffNameMe(prevItem.checkStaffName || prevItem.checkStaff, activeUser, activeUserId, activeMembers);
                  const isNewCheckMe = isStaffNameMe(newSeat.checkStaffName || newSeat.checkStaff, activeUser, activeUserId, activeMembers);

                  const isAssignedStakeholder =
                    isPrevMainMe ||
                    isNewMainMe ||
                    isPrevAssistMe ||
                    isNewAssistMe ||
                    isPrevCheckMe ||
                    isNewCheckMe;

                  const prevAssist = (prevItem.assistantStaffName || '').trim();
                  const newAssist = (newSeat.assistantStaffName || '').trim();
                  const prevCheck = (prevItem.checkStaffName || prevItem.checkStaff || '').trim();
                  const newCheck = (newSeat.checkStaffName || newSeat.checkStaff || '').trim();
                  const prevActionInfo = getActionStatusInfo(prevItem.actionStatus, prevItem.isShampooing);
                  const newActionInfo = getActionStatusInfo(newSeat.actionStatus, newSeat.isShampooing);
                  const prevActionId = prevActionInfo ? prevActionInfo.id : null;
                  const newActionId = newActionInfo ? newActionInfo.id : null;
                  const helpProcLabel =
                    newSeat.helpProcess ||
                    newActionInfo?.label ||
                    prevItem.helpProcess ||
                    'ヘルプ';
                  const checkProcLabel = newSeat.checkProcess || prevItem.checkProcess || 'チェック';
                  const isStartingMain = prevItem.status !== 'running' && newSeat.status === 'running';
                  const isAddingCheck = !prevHadActiveCheck && newHasActiveCheck;

                  const getActionVisualMeta = (actionId) => {
                    switch (actionId) {
                      case 'shampoo':
                        return { emoji: '💧', label: 'シャンプー', color: '#AF52DE' };
                      case 'combing':
                        return { emoji: '🪮', label: 'コーミング', color: '#0A84FF' };
                      case 'check':
                        return { emoji: '🔍', label: 'チェック', color: '#30D158' };
                      case 'call':
                        return { emoji: '🔔', label: '呼び出し', color: '#FF9500' };
                      case 'other':
                        return { emoji: '💬', label: newSeat.helpProcess || 'その他工程', color: '#5E5CE6' };
                      default:
                        return null;
                    }
                  };

                  const validNewAssistActor =
                    newAssist && newAssist !== 'ヘルプなし' && newAssist !== 'none' && newAssist !== '募集中' && newAssist !== '未定'
                      ? newAssist
                      : '';

                  const wasPausedActiveSeat =
                    prevItem.status === 'paused' &&
                    !prevItem.isReset &&
                    (Number(prevItem.pausedRemainingSeconds || 0) > 0 || !!prevActionId || !!prevItem.isShampooing);
                  const didResetOrFinishPaused =
                    wasPausedActiveSeat &&
                    (newSeat.isReset ||
                      newSeat.status === 'idle' ||
                      (Number(newSeat.pausedRemainingSeconds || 0) <= 0 && !newActionId && !newSeat.isShampooing));

                  // ① チェックタイマー完了・解除（主担当・ヘルプ担当・チェック担当・チェック未定時のみ通知）
                  if (prevHadActiveCheck && !newHasActiveCheck && newSeat.status === 'running') {
                    const isCheckStakeholder =
                      isAssignedStakeholder ||
                      shouldAlertCheckTimerForUser(prevItem, activeUser, activeUserId, activeMembers) ||
                      shouldAlertCheckTimerForUser(newSeat, activeUser, activeUserId, activeMembers);
                    if (isCheckStakeholder) {
                      const isCompleted = newSeat.isCheckCompleted || newSeat.checkStatus === 'completed';
                      const staffSuffix = newCheck && newCheck !== '未定' && newCheck !== '募集中' ? `（${newCheck}）` : '';
                      peerNotification = {
                        eventType: 'check_done',
                        text: isCompleted
                          ? `✓ ${label}の${checkProcLabel}完了${staffSuffix}`
                          : `⏹ ${label}の${checkProcLabel}タイマーが解除されました`,
                        color: isCompleted ? '#30D158' : '#8E8E93',
                        sourceUser: '__remote__',
                      };
                    }
                  }
                  // ② 全体タイマー停止・施術工程移行・リセット（稼働中・超過中・一時停止中からの停止/リセットで関係者へ即時通知）
                  else if ((prevItem.status === 'running' && newSeat.status !== 'running') || didResetOrFinishPaused) {
                    const isStopStakeholder =
                      newActionId === 'call' ||
                      isAssignedStakeholder ||
                      shouldAlertMainTimerForUser(prevItem, activeUser, activeUserId, activeMembers) ||
                      shouldAlertMainTimerForUser(newSeat, activeUser, activeUserId, activeMembers);
                    if (isStopStakeholder) {
                      const actionMeta = getActionVisualMeta(newActionId);
                      if (actionMeta) {
                        // タイマーを止めて「コーミング」「シャンプー」「チェック」「呼び出し」等の施術工程に入った場合、単なる停止ではなく工程移行を最優先で通知！
                        if (newActionId === 'call') {
                          peerNotification = {
                            eventType: 'stop',
                            text: isNewAssistMe
                              ? `🔔 ${label}からあなたへ呼び出しがあります！`
                              : `🔔 ${label}から呼び出しがあります${validNewAssistActor ? `（${validNewAssistActor}）` : ''}`,
                            color: actionMeta.color,
                            sourceUser: '__remote__',
                          };
                        } else if (isNewAssistMe && !isPrevAssistMe) {
                          peerNotification = {
                            eventType: 'assign_assist',
                            text: `${actionMeta.emoji} ${label}の${actionMeta.label}担当に指定されました`,
                            color: actionMeta.color,
                            sourceUser: '__remote__',
                          };
                        } else if (validNewAssistActor && !isNewAssistMe) {
                          peerNotification = {
                            eventType: 'stop',
                            text: `${actionMeta.emoji} ${label}の${actionMeta.label}に ${validNewAssistActor} さんが入りました`,
                            color: actionMeta.color,
                            sourceUser: '__remote__',
                          };
                        } else {
                          peerNotification = {
                            eventType: 'stop',
                            text: `${actionMeta.emoji} ${label}が${actionMeta.label}に入りました${validNewAssistActor ? `（${validNewAssistActor}）` : ''}`,
                            color: actionMeta.color,
                            sourceUser: '__remote__',
                          };
                        }
                      } else {
                        peerNotification = {
                          eventType: 'stop',
                          text: didResetOrFinishPaused
                            ? `⏹ ${label}のタイマーがリセットされました`
                            : `⏹ ${label}のタイマーが停止されました`,
                          color: '#FF9500',
                          sourceUser: '__remote__',
                        };
                      }
                    }
                  }
                  // ②-b 【最優先】他スタッフから「自分の名前」が担当（チェック担当・ヘルプ担当・主担当）に設定／開始された場合、
                  //     他のステータス変更や別スタッフ指名の分岐に絶対に吸われないよう本人へ確実に指名通知を送出する！
                  else if (isNewCheckMe && (!isPrevCheckMe || isAddingCheck || (isStartingMain && newHasActiveCheck))) {
                    const chkMins =
                      newSeat.checkInitialMinutes || Math.max(1, Math.round((newSeat.checkTargetSeconds || 300) / 60));
                    peerNotification = {
                      eventType: 'assign_check',
                      text: newHasActiveCheck
                        ? `🔍 ${label}の${checkProcLabel}（${chkMins}分）担当に指定されました`
                        : `🔍 ${label}の${checkProcLabel}担当に指定されました`,
                      color: '#FF9F0A',
                      sourceUser: '__remote__',
                    };
                  } else if (isNewAssistMe && (!isPrevAssistMe || isStartingMain || (prevActionId !== newActionId && !!newActionId))) {
                    const mins = newSeat.initialMinutes || Math.max(1, Math.round((newSeat.targetSeconds || 600) / 60));
                    peerNotification = {
                      eventType: 'assign_assist',
                      text:
                        newActionId === 'call'
                          ? `🔔 ${label}からあなたへ呼び出しがあります！`
                          : isStartingMain
                          ? `🙋‍♂️ ${label}の${helpProcLabel}（${mins}分）担当に指定されました`
                          : `🙋‍♂️ ${label}の${helpProcLabel}担当に指定されました`,
                      color: newActionId === 'call' ? '#FF9500' : '#0A84FF',
                      sourceUser: '__remote__',
                    };
                  } else if (isNewMainMe && (!isPrevMainMe || isStartingMain) && !!(newSeat.colorStaffName || '').trim()) {
                    const mins = newSeat.initialMinutes || Math.max(1, Math.round((newSeat.targetSeconds || 600) / 60));
                    peerNotification = {
                      eventType: 'assign_main',
                      text:
                        newSeat.status === 'running'
                          ? `🎨 ${label}のタイマー（${mins}分）があなた主担当で設定されました`
                          : `🎨 ${label}の主担当に設定されました`,
                      color: '#AF52DE',
                      sourceUser: '__remote__',
                    };
                  }
                  // ③ 全体ヘルプまたはチェックの「全員募集」開始（ヘルプに入る可能性がある全員へ通知）
                  else if (!prevItem.isRecruiting && newSeat.isRecruiting) {
                    peerNotification = {
                      eventType: 'recruit',
                      text: `📢 ${label}が${helpProcLabel}担当を募集しています！`,
                      color: '#FF453A',
                      sourceUser: '__remote__',
                    };
                  } else if (prevCheck !== '募集中' && newCheck === '募集中') {
                    peerNotification = {
                      eventType: 'recruit',
                      text: `📢 ${label}が${checkProcLabel}担当を募集しています！`,
                      color: '#FF9F0A',
                      sourceUser: '__remote__',
                    };
                  }
                  // ④ タイマー停止を伴わない施術ステータス（コーミング・シャンプー・チェック・呼び出し等）の開始・変更・完了
                  else if (
                    !newSeat.isRecruiting &&
                    (prevActionId !== newActionId || !!prevItem.isShampooing !== !!newSeat.isShampooing) &&
                    !isStartingMain &&
                    !(newSeat.status === 'running' && prevAssist !== newAssist && newAssist && newAssist !== 'ヘルプなし' && newAssist !== 'none' && newActionId !== 'call') &&
                    !(prevCheck !== newCheck && newCheck && newCheck !== '未定' && newCheck !== '募集中')
                  ) {
                    const isStatusStakeholder =
                      newActionId === 'call' ||
                      isAssignedStakeholder ||
                      shouldAlertMainTimerForUser(prevItem, activeUser, activeUserId, activeMembers) ||
                      shouldAlertMainTimerForUser(newSeat, activeUser, activeUserId, activeMembers);
                    if (isStatusStakeholder) {
                      if (newActionId) {
                        const actionMeta = getActionVisualMeta(newActionId);
                        if (actionMeta) {
                          if (newActionId === 'call') {
                            peerNotification = {
                              eventType: 'status_change',
                              text: `🔔 ${label}から呼び出しがあります！`,
                              color: actionMeta.color,
                              sourceUser: '__remote__',
                            };
                          } else if (newSeat.status === 'running' && !newSeat.isShampooing) {
                            peerNotification = {
                              eventType: 'status_change',
                              text: `${actionMeta.emoji} ${label}のヘルプ内容が「${actionMeta.label}」に変更されました`,
                              color: actionMeta.color,
                              sourceUser: '__remote__',
                            };
                          } else if (validNewAssistActor && !isNewAssistMe) {
                            peerNotification = {
                              eventType: 'status_change',
                              text: `${actionMeta.emoji} ${label}の${actionMeta.label}に ${validNewAssistActor} さんが入りました`,
                              color: actionMeta.color,
                              sourceUser: '__remote__',
                            };
                          } else {
                            peerNotification = {
                              eventType: 'status_change',
                              text: `${actionMeta.emoji} ${label}が${actionMeta.label}に入りました`,
                              color: actionMeta.color,
                              sourceUser: '__remote__',
                            };
                          }
                        }
                      } else if (prevActionId && prevItem.status !== 'running' && newSeat.status !== 'running' && !newSeat.isReset) {
                        const prevMeta = getActionVisualMeta(prevActionId);
                        if (prevMeta) {
                          peerNotification = {
                            eventType: 'status_change',
                            text: `✅ ${label}の${prevMeta.label}が完了しました`,
                            color: '#30D158',
                            sourceUser: '__remote__',
                          };
                        }
                      }
                    }
                  }

                  // ⑤ 他スタッフのヘルプ担当・チェック担当への参戦／指名共有（主担当・関係者へ通知。else if で互いを潰さない）
                  if (
                    !peerNotification &&
                    !isStartingMain &&
                    prevAssist !== newAssist &&
                    newAssist &&
                    newAssist !== 'ヘルプなし' &&
                    newAssist !== 'none' &&
                    !newSeat.isRecruiting
                  ) {
                    if (isNewMainMe || isAssignedStakeholder) {
                      peerNotification = {
                        eventType: 'assign_assist',
                        text: `🤝 ${label}の${helpProcLabel}に ${newAssist} さんが入りました`,
                        color: '#30D158',
                        sourceUser: '__remote__',
                      };
                    }
                  }
                  if (
                    !peerNotification &&
                    !isStartingMain &&
                    prevCheck !== newCheck &&
                    newCheck &&
                    newCheck !== '未定' &&
                    newCheck !== '募集中'
                  ) {
                    if (isNewMainMe || isAssignedStakeholder) {
                      peerNotification = {
                        eventType: 'assign_check',
                        text: `🔍 ${label}の${checkProcLabel}に ${newCheck} さんが入りました`,
                        color: '#30D158',
                        sourceUser: '__remote__',
                      };
                    }
                  }

                  // ⑥ 自分以外が設定した新規タイマー開始・途中チェック追加・残り時間変更（関係者＋ヘルプ/チェック未定時のみ通知）
                  if (!peerNotification) {
                    if (isStartingMain) {
                      const canAlertMain = shouldAlertMainTimerForUser(newSeat, activeUser, activeUserId, activeMembers);
                      const canAlertCheck = newHasActiveCheck && shouldAlertCheckTimerForUser(newSeat, activeUser, activeUserId, activeMembers);
                      if (canAlertMain || canAlertCheck || isAssignedStakeholder) {
                        const mins = newSeat.initialMinutes || Math.max(1, Math.round((newSeat.targetSeconds || 600) / 60));
                        peerNotification = {
                          eventType: 'timer_start',
                          text: `▶️ ${label}のタイマー（${mins}分）が開始されました`,
                          color: '#0A84FF',
                          sourceUser: '__remote__',
                        };
                      }
                    } else if (isAddingCheck && prevItem.status === 'running' && newSeat.status === 'running') {
                      if (shouldAlertCheckTimerForUser(newSeat, activeUser, activeUserId, activeMembers) || isAssignedStakeholder) {
                        const chkMins = newSeat.checkInitialMinutes || Math.max(1, Math.round((newSeat.checkTargetSeconds || 300) / 60));
                        const staffSuffix = newCheck && newCheck !== '未定' && newCheck !== '募集中' ? `（担当: ${newCheck}）` : '';
                        peerNotification = {
                          eventType: 'add_check',
                          text: `🔍 ${label}に${checkProcLabel}（${chkMins}分）が追加されました${staffSuffix}`,
                          color: '#FF9F0A',
                          sourceUser: '__remote__',
                        };
                      }
                    } else if (
                      prevItem.status === 'running' &&
                      newSeat.status === 'running' &&
                      Math.abs(Number(newSeat.targetEndTimestamp || 0) - Number(prevItem.targetEndTimestamp || 0)) >= 25000
                    ) {
                      if (shouldAlertMainTimerForUser(newSeat, activeUser, activeUserId, activeMembers) || isAssignedStakeholder) {
                        peerNotification = {
                          eventType: 'time_adjust',
                          text: `⏱ ${label}の残り時間が変更されました`,
                          color: '#0A84FF',
                          sourceUser: '__remote__',
                        };
                      }
                    }
                  }
                }

                const didStopRunningTimer = prevItem.status === 'running' && newSeat.status !== 'running';
                const didResetPausedTimer =
                  prevItem.status === 'paused' &&
                  !prevItem.isReset &&
                  (newSeat.isReset || newSeat.status === 'idle' || (Number(newSeat.pausedRemainingSeconds || 0) <= 0 && Number(prevItem.pausedRemainingSeconds || 0) > 0));
                const didStopRunningCheck =
                  prevItem.status === 'running' &&
                  !prevItem.isCheckCompleted &&
                  Number(prevItem.checkEndTimestamp) > 0 &&
                  (newSeat.isCheckCompleted || newSeat.checkStatus === 'completed' || newSeat.checkStatus === 'stopped' || !newSeat.checkEndTimestamp);
                if (didStopRunningTimer || didResetPausedTimer) {
                  WatchConnectivity.notifyLocalStopOrReset(newSeat.id || prevItem.id, prevItem.targetEndTimestamp || 0);
                }
                const targetCollapseSeatId = newSeat.id || prevItem.id;
                if (targetCollapseSeatId && (didStopRunningTimer || didResetPausedTimer || newSeat.status === 'running')) {
                  setExpandedPausedSeatIds((prevExp) =>
                    prevExp[targetCollapseSeatId] ? { ...prevExp, [targetCollapseSeatId]: false } : prevExp
                  );
                }

                const resolvedSeatNum =
                  Number(newSeat.seatNumber) > 0
                    ? Number(newSeat.seatNumber)
                    : (Number(prevItem.seatNumber) > 0 ? Number(prevItem.seatNumber) : idx + 1);
                const nextRealtimeHistory = didStopRunningTimer || didResetPausedTimer
                  ? []
                  : reconcileRealtimeSeatHistory(prevItem, newSeat, getCurrentTimeFormatted());
                updated = [...prev];
                updated[idx] = {
                  ...prevItem,
                  ...newSeat,
                  checkProcess: sanitizeCheckProcess(newSeat.checkProcess || prevItem.checkProcess),
                  seatNumber: resolvedSeatNum,
                  // 自分がスマホ・ウォッチで設定していた端末別アラーム音ON/OFF設定を保持
                  alarmSoundEnabled: prevItem.alarmSoundEnabled ?? newSeat.alarmSoundEnabled,
                  watchAlarmSoundEnabled: prevItem.watchAlarmSoundEnabled ?? newSeat.watchAlarmSoundEnabled,
                  collapsedAtEnd:
                    didStopRunningTimer || didResetPausedTimer
                      ? Date.now()
                      : (shouldClearCollapsed ? null : prevItem.collapsedAtEnd),
                  history: nextRealtimeHistory,
                  ...(didStopRunningTimer || didResetPausedTimer
                    ? {
                        lastStoppedAt: Date.now(),
                        lastStoppedTargetEndTimestamp: Number(prevItem.targetEndTimestamp) || Number(prevItem.lastStoppedTargetEndTimestamp) || 0,
                      }
                    : newSeat.status === 'running'
                    ? {
                        lastStoppedAt: 0,
                        lastStoppedTargetEndTimestamp: 0,
                      }
                    : {}),
                };
              } else {
                const hasConflictOrZero =
                  !(Number(newSeat.seatNumber) > 0) ||
                  prev.some((s) => s && Number(s.seatNumber) === Number(newSeat.seatNumber));
                const nextSeatNum = hasConflictOrZero
                  ? prev.reduce((maxN, s, i) => {
                      const m = String(s?.seatLabel || '').match(/\d+/);
                      const n = Number(s?.seatNumber) || (m ? parseInt(m[0], 10) : i + 1);
                      return Math.max(maxN, n);
                    }, 0) + 1
                  : Number(newSeat.seatNumber);
                const addedSeat = {
                  ...newSeat,
                  seatNumber: nextSeatNum,
                  history: shouldRetainSeatHistory(newSeat)
                    ? [buildStartHistoryEntryFromSeat(newSeat, getCurrentTimeFormatted())]
                    : [],
                };
                updated = [...prev, addedSeat];
                const effectiveIsSelfEchoForAdd =
                  isSelfEcho || isRecentLocalActorEcho(addedSeat, activeUserId);
                if (!effectiveIsSelfEchoForAdd && addedSeat.status === 'running') {
                  const label = (addedSeat.seatLabel || addedSeat.name || `${nextSeatNum}番席`).trim();
                  const mins = addedSeat.initialMinutes || Math.max(1, Math.round((addedSeat.targetSeconds || 600) / 60));
                  const addedHasActiveCheck =
                    (addedSeat.checkStatus === 'running' || addedSeat.checkStatus === 'timeup' || Number(addedSeat.checkEndTimestamp) > 0) &&
                    !addedSeat.isCheckCompleted;
                  const addedCheck = (addedSeat.checkStaffName || addedSeat.checkStaff || '').trim();
                  const addedAssist = (addedSeat.assistantStaffName || '').trim();
                  const addedCheckProc = addedSeat.checkProcess || 'チェック';
                  const addedActionInfo = getActionStatusInfo(addedSeat.actionStatus, addedSeat.isShampooing);
                  const addedHelpProc = addedSeat.helpProcess || addedActionInfo?.label || 'ヘルプ';

                  if (addedHasActiveCheck && isStaffNameMe(addedCheck, activeUser, activeUserId, activeMembers)) {
                    const chkMins = addedSeat.checkInitialMinutes || Math.max(1, Math.round((addedSeat.checkTargetSeconds || 300) / 60));
                    peerNotification = {
                      eventType: 'assign_check',
                      text: `🔍 ${label}の${addedCheckProc}（${chkMins}分）担当に指定されました`,
                      color: '#FF9F0A',
                      sourceUser: '__remote__',
                    };
                  } else if (!addedSeat.isRecruiting && isStaffNameMe(addedAssist, activeUser, activeUserId, activeMembers)) {
                    peerNotification = {
                      eventType: 'assign_assist',
                      text: `🙋‍♂️ ${label}の${addedHelpProc}（${mins}分）担当に指定されました`,
                      color: '#0A84FF',
                      sourceUser: '__remote__',
                    };
                  } else if (isMainStaffOfSeat(addedSeat, activeUser, activeUserId, activeMembers) && !!(addedSeat.colorStaffName || '').trim()) {
                    peerNotification = {
                      eventType: 'assign_main',
                      text: `🎨 ${label}のタイマー（${mins}分）があなた主担当で設定されました`,
                      color: '#AF52DE',
                      sourceUser: '__remote__',
                    };
                  } else {
                    const canAlertNew =
                      shouldAlertMainTimerForUser(addedSeat, activeUser, activeUserId, activeMembers) ||
                      (addedHasActiveCheck && shouldAlertCheckTimerForUser(addedSeat, activeUser, activeUserId, activeMembers));
                    if (canAlertNew) {
                      peerNotification = {
                        eventType: 'timer_start',
                        text: `▶️ ${label}のタイマー（${mins}分）が開始されました`,
                        color: '#0A84FF',
                        sourceUser: '__remote__',
                      };
                    }
                  }
                }
              }
              const didRemoteStopAlarmTarget = !!(
                idx >= 0 &&
                prev[idx] &&
                ((prev[idx].status === 'running' && newSeat.status !== 'running') ||
                  (prev[idx].status === 'running' &&
                    !prev[idx].isCheckCompleted &&
                    Number(prev[idx].checkEndTimestamp) > 0 &&
                    (newSeat.isCheckCompleted || newSeat.checkStatus === 'completed' || newSeat.checkStatus === 'stopped' || !newSeat.checkEndTimestamp)))
              );
              persistSeatsForSalonId(cloudSalon.id, updated, resolvedIsOwner).catch(() => {});
              if (peerNotification) {
                const enrichedNotif = {
                  ...peerNotification,
                  id: peerNotification.id || `peer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                };
                const targetTimerKey = newSeat?.id || (idx >= 0 ? prev[idx]?.id : '') || newSeat?.seatLabel || '';
                const semanticKey = buildPeerEventSemanticKey(
                  targetTimerKey,
                  peerNotification.eventType || 'status_change'
                );
                const alreadyDeliveredViaPush = hasHandledPeerNotification({
                  notifId: enrichedNotif.id,
                  semanticKey,
                  channel: 'realtime',
                });
                markPeerNotificationHandled({
                  notifId: enrichedNotif.id,
                  semanticKey,
                  channel: 'realtime',
                });

                const currentAppState = appStateRef.current || AppState.currentState || 'active';
                const isPhoneForeground = currentAppState === 'active';
                const isWatchCurrentlyLinked =
                  Platform.OS === 'ios' &&
                  (watchLinkedRef.current || (WatchConnectivity.isPaired() && WatchConnectivity.isWatchAppInstalled()));

                if (isPhoneForeground) {
                  // ★ パターン①: スマホを開いている時（フォアグラウンド）
                  //   スマホに「全タブ共通トースト通知 ＋ 振動」を表示し、さらに Watch連動ありの場合は
                  //   施術中でスマホ画面を見ていないケース（ワゴン・充電台放置など）でも手首で確実に気づけるよう
                  //   Apple Watch側にも notification + highPriorityWake を同時送信して振動＆通知バナーを表示する！
                  syncSeatsToWatch(updated, activeUser, activeMembers, {
                    immediate: true,
                    ...(isWatchCurrentlyLinked && !alreadyDeliveredViaPush ? { notification: enrichedNotif } : {}),
                    highPriorityWake: didRemoteStopAlarmTarget || isWatchCurrentlyLinked,
                  });
                  if (!alreadyDeliveredViaPush) {
                    setTimeout(() => {
                      if (isMounted) {
                        showPeerActionBanner(enrichedNotif.text, enrichedNotif.color, enrichedNotif.id);
                      }
                    }, 0);
                  }
                } else if (isWatchCurrentlyLinked) {
                  // ★ パターン②: スマホを開いていない時（ロック中 / バックグラウンド / 別アプリ） × Watch連動あり
                  //   Apple Watch側に通知（振動＋画面表示）を出し、スマホOSローカルバナーやトーストは出さない
                  syncSeatsToWatch(updated, activeUser, activeMembers, {
                    immediate: true,
                    ...(alreadyDeliveredViaPush ? {} : { notification: enrichedNotif }),
                    highPriorityWake: true,
                  });
                } else {
                  // ★ パターン③: スマホを開いていない時（ロック中 / バックグラウンド / 別アプリ） × Watch連動なし
                  //   スマホのOS標準バナー通知（ロック画面／システム通知バナー）で表示する
                  syncSeatsToWatch(updated, activeUser, activeMembers, {
                    immediate: true,
                    highPriorityWake: didRemoteStopAlarmTarget,
                  });
                  if (Platform.OS === 'ios' && !alreadyDeliveredViaPush) {
                    WatchConnectivity.presentLocalNotification('サロン共有通知', enrichedNotif.text).catch(() => {});
                  }
                }
              } else {
                syncSeatsToWatch(
                  updated,
                  activeUser,
                  activeMembers,
                  didRemoteStopAlarmTarget ? { immediate: true, highPriorityWake: true } : {}
                );
              }
              return updated;
            });
            setTimeout(() => {
              isRemoteSyncRef.current = false;
            }, 300);
          } else if (eventType === 'DELETE') {
            const delId = oldSeat?.id || oldSeat?.cloudTimerId || null;
            const delLabel = oldSeat?.seatLabel || oldSeat?.name || null;
            if (delId || delLabel) {
              isRemoteSyncRef.current = true;
              if (delId) {
                stopAlarm('salon', `${delId}-main`);
                stopAlarm('salon', `${delId}-check`);
                WatchConnectivity.notifyLocalStopOrReset(delId, oldSeat?.targetEndTimestamp || 0);
              }
              setSeats((prev) => {
                const updated = prev.filter((s) => {
                  if (!s) return false;
                  if (delId && (s.id === delId || s.cloudTimerId === delId)) return false;
                  if (delLabel && !isCloudUUID(s.cloudTimerId || s.id)) {
                    if (s.seatLabel === delLabel || s.name === delLabel) return false;
                  } else if (!delId && delLabel && (s.seatLabel === delLabel || s.name === delLabel)) {
                    return false;
                  }
                  return true;
                });
                persistSeatsForSalonId(cloudSalon.id, updated, resolvedIsOwner).catch(() => {});
                syncSeatsToWatch(updated, userNameRef.current, staffMembersRef.current, {
                  immediate: true,
                  highPriorityWake: true,
                  forceEmpty: updated.length === 0,
                });
                return updated;
              });
              setTimeout(() => {
                isRemoteSyncRef.current = false;
              }, 300);
            }
          }
        });
      } catch (err) {
        console.warn('initCloudSalon failed:', err);
      }
    };

    let unsubscribeTimers = null;
    initCloudSalon();

    return () => {
      isMounted = false;
      if (typeof unsubscribeMembers === 'function') {
        unsubscribeMembers();
      }
      if (typeof unsubscribeTimers === 'function') {
        unsubscribeTimers();
      }
    };
  }, [currentSalon?.id, currentSalon?.inviteCode, isDataLoaded, myUserId]);

  // ★ リモートプッシュ通知（APNs / Expo Push）バックグラウンド受信時の最新タイマー同期＆Apple Watch高優先度ウェイク中継
  useEffect(() => {
    configurePushNotificationHandler();
    const unsubscribePush = subscribeRemotePushEvents(async ({ title, body, data, appState }) => {
      const pushSalonId = data?.salonId ? String(data.salonId) : '';
      const activeCloudId =
        cloudSalonIdRef.current ||
        (isCloudUUID(currentSalonRef.current?.id) ? currentSalonRef.current.id : '');
      if (pushSalonId && activeCloudId && pushSalonId !== activeCloudId) {
        return;
      }
      const targetSalonId = pushSalonId || activeCloudId;
      if (!isCloudUUID(targetSalonId)) return;

      const notifId = data?.notifId ? String(data.notifId) : `push_${Date.now()}`;
      const eventType = data?.eventType ? String(data.eventType) : 'status_change';
      const timerKey = data?.timerId || data?.seatLabel || '';
      const semanticKey = buildPeerEventSemanticKey(timerKey, eventType);
      const pushColor = data?.color ? String(data.color) : '#FF9500';
      const notifText = (body || title || '').trim();

      // フォアグラウンド（active）時は Supabase Realtime 側でアプリ内トースト＋Watch同時通知を行うため重複送出を抑止
      if (appState === 'active') {
        return;
      }

      const alreadyHandled = hasHandledPeerNotification({ notifId, semanticKey, channel: 'push' });
      markPeerNotificationHandled({ notifId, semanticKey, channel: 'push' });

      const latestCloudSeats = await fetchSalonTimers(targetSalonId, { returnNullOnError: true });
      if (!Array.isArray(latestCloudSeats)) return;

      const prevSeats = Array.isArray(seatsRef.current) ? seatsRef.current : [];
      const mergedSeats = latestCloudSeats.map((cloudSeat) => {
        const prevMatch = prevSeats.find(
          (p) =>
            p &&
            (p.id === cloudSeat.id ||
              p.cloudTimerId === cloudSeat.id ||
              Number(p.seatNumber) === Number(cloudSeat.seatNumber))
        );
        if (!prevMatch) {
          return shouldRetainSeatHistory(cloudSeat)
            ? { ...cloudSeat, history: [buildStartHistoryEntryFromSeat(cloudSeat)] }
            : { ...cloudSeat, history: [] };
        }
        const didStopMain =
          (prevMatch.status === 'running' && cloudSeat.status !== 'running') ||
          (prevMatch.status === 'paused' && !prevMatch.isReset && (cloudSeat.isReset || cloudSeat.status === 'idle'));
        const didStopCheck =
          prevMatch.status === 'running' &&
          !prevMatch.isCheckCompleted &&
          Number(prevMatch.checkEndTimestamp) > 0 &&
          (cloudSeat.isCheckCompleted ||
            cloudSeat.checkStatus === 'completed' ||
            cloudSeat.checkStatus === 'stopped' ||
            !cloudSeat.checkEndTimestamp);

        if (didStopMain) {
          stopAlarm('salon', `${prevMatch.id}-main`);
          stopAlarm('salon', `${prevMatch.id}-check`);
          if (cloudSeat.id !== prevMatch.id) {
            stopAlarm('salon', `${cloudSeat.id}-main`);
            stopAlarm('salon', `${cloudSeat.id}-check`);
          }
          WatchConnectivity.notifyLocalStopOrReset(
            cloudSeat.id || prevMatch.id,
            prevMatch.targetEndTimestamp || 0
          );
          setExpandedPausedSeatIds((prevExp) =>
            prevExp[cloudSeat.id] ? { ...prevExp, [cloudSeat.id]: false } : prevExp
          );
        } else if (didStopCheck) {
          stopAlarm('salon', `${prevMatch.id}-check`);
          if (cloudSeat.id !== prevMatch.id) {
            stopAlarm('salon', `${cloudSeat.id}-check`);
          }
        }

        return {
          ...prevMatch,
          ...cloudSeat,
          checkProcess: sanitizeCheckProcess(cloudSeat.checkProcess || prevMatch.checkProcess),
          alarmSoundEnabled: prevMatch.alarmSoundEnabled ?? cloudSeat.alarmSoundEnabled,
          watchAlarmSoundEnabled: prevMatch.watchAlarmSoundEnabled ?? cloudSeat.watchAlarmSoundEnabled,
          collapsedAtEnd: didStopMain
            ? Date.now()
            : (cloudSeat.status === 'running' || cloudSeat.isReset ? null : prevMatch.collapsedAtEnd),
          history: didStopMain
            ? []
            : reconcileRealtimeSeatHistory(prevMatch, cloudSeat, getCurrentTimeFormatted()),
          ...(didStopMain
            ? {
                lastStoppedAt: Date.now(),
                lastStoppedTargetEndTimestamp:
                  Number(prevMatch.targetEndTimestamp) || Number(prevMatch.lastStoppedTargetEndTimestamp) || 0,
              }
            : {}),
        };
      });

      mergedSeats.forEach((ct) => {
        if (ct?.id) {
          lastSyncedSeatsStateRef.current[ct.id] = getSeatCloudSignature(ct);
        }
      });

      isRemoteSyncRef.current = true;
      setSeats(mergedSeats);
      persistSeatsForSalonId(targetSalonId, mergedSeats, isSalonOwnerRef.current).catch(() => {});
      setTimeout(() => {
        isRemoteSyncRef.current = false;
      }, 300);

      const isWatchCurrentlyLinked =
        Platform.OS === 'ios' &&
        (watchLinkedRef.current || (WatchConnectivity.isPaired() && WatchConnectivity.isWatchAppInstalled()));

      syncSeatsToWatch(
        mergedSeats,
        userNameRef.current || _cachedUserName || 'スタイリスト',
        staffMembersRef.current || _cachedStaffMembers,
        {
          immediate: true,
          highPriorityWake: true,
          ...(isWatchCurrentlyLinked && !alreadyHandled && notifText
            ? {
                notification: {
                  id: notifId,
                  text: notifText,
                  color: pushColor,
                  sourceUser: '__remote__',
                },
              }
            : {}),
        }
      );
    });

    return () => {
      unsubscribePush();
    };
  }, []);

  const loadInitialData = async () => {
    try {
      const activeUserId = await getOrCreateUserId();
      myUserIdRef.current = activeUserId;
      setMyUserId(activeUserId);

      const savedName = await AsyncStorage.getItem('@assist_timer_user_name');
      const activeUserName = savedName || 'スタイリスト';
      if (savedName) setUserName(savedName);

      const savedFavs = await AsyncStorage.getItem('@salon_favorite_timer_presets');
      if (savedFavs) {
        const parsed = JSON.parse(savedFavs);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setFavoritePresets(parsed);
        }
      }

      // 1. サロンデータの読み込み・初期化（デフォルトは「タイマー同期モード (無料)」のみ。架空のサロン・チームはなし）
      const savedSalonsJson = await AsyncStorage.getItem('@salon_saved_salons');
      let loadedSalons = [createDefaultFreeSalon()];
      if (savedSalonsJson) {
        try {
          const parsed = JSON.parse(savedSalonsJson);
          if (Array.isArray(parsed) && parsed.length > 0) {
            // 古いデモコード・例文露出コード・ダミーコード等があれば、ローカルサロン（オーナー分）は自動でランダムな6桁安全コードへアップグレード
            loadedSalons = parsed.map((s) => {
              let updated = { ...s };
              const cleanExisting = sanitizeInviteCode(updated.inviteCode);
              const isLocalOwnerSalon = checkIsSalonOwner(updated, activeUserId);
              if (
                !cleanExisting ||
                isDummyExampleInviteCode(cleanExisting) ||
                (isLocalOwnerSalon && !isCloudUUID(updated.id) && isLegacyExposedInviteCode(cleanExisting))
              ) {
                updated.inviteCode = generateRandomInviteCode();
              }
              if (updated.id === 'workspace-free') {
                updated.name = 'タイマー同期モード (無料)';
                updated.description = '2人までタイマー同期無料 (1名利用中 / ペア招待可能)';
              }
              return updated;
            });
            saveSalonsToStorage(loadedSalons);
          } else {
            saveSalonsToStorage(loadedSalons);
          }
        } catch (e) {
          console.warn('Failed to parse saved salons', e);
          saveSalonsToStorage(loadedSalons);
        }
      } else {
        saveSalonsToStorage(loadedSalons);
      }
      setSavedSalons(loadedSalons);

      const savedCurrentSalonId = await AsyncStorage.getItem('@salon_current_salon_id');
      const foundSalon = loadedSalons.find((s) => s.id === savedCurrentSalonId) || loadedSalons[0];
      const foundIsOwner = checkIsSalonOwner(foundSalon, activeUserId);
      _cachedMyUserId = activeUserId;
      _cachedIsSalonOwner = foundIsOwner;
      _cachedActiveSalonId = foundSalon?.id || 'workspace-free';
      cloudSalonIdRef.current =
        foundSalon?.id && foundSalon.id !== 'workspace-free' && foundSalon.id !== 'workspace-pro-demo'
          ? foundSalon.id
          : null;
      setCurrentSalon(foundSalon);

      // オフライン削除待ちキューを復元
      pendingDeletedSeatsRef.current = await readPendingDeletedSeats(foundSalon?.id);

      // 2. 席データの読み込み・初期化（オーナーはサロン別保存席または初期1番席、ゲストはサンプル席を作らずクラウド同期）
      let loadedSeats = await readSeatsForSalonFromStorage(
        foundSalon,
        activeUserName,
        activeUserId,
        savedCurrentSalonId
      );
      if (foundIsOwner && pendingDeletedSeatsRef.current.length > 0) {
        loadedSeats = loadedSeats.filter((s) => !isSeatInPendingDeleted(s));
      }
      // ★ アプリ起動時（TestFlight更新後・再起動時）に稼働中タイマーはそのまま継続させ、新規更新時の非稼働席・旧20分サンプル・過去放置席のみ00:00へ正規化
      const isAppBuildUpdate = await detectSalonBuildUpdateOnce();
      const { seats: sanitizedSeats, didSanitize } = sanitizeLoadedSeats(loadedSeats, { isAppBuildUpdate });
      loadedSeats = sanitizedSeats;
      const launchNow = Date.now();
      loadedSeats.forEach((s) => {
        if (!s || !s.id) return;
        // すでに起動時点でチェック時間を過ぎている・残り1分以内の席は、起動直後の初回監視ループで重複バイブしないよう記録
        if (s.checkEndTimestamp && Number(s.checkEndTimestamp) <= launchNow) {
          checkAlertedRef.current[s.id] = s.checkEndTimestamp;
        }
        if (s.status === 'running' && s.targetEndTimestamp) {
          const endMs = Number(s.targetEndTimestamp);
          const remSec = Math.floor((endMs - launchNow) / 1000);
          if (remSec <= 60) {
            oneMinuteHelpAlertRef.current[s.id] = s.targetEndTimestamp;
          }
          // ★ 起動時点ですでにタイム終了（超過カウントアップ中）の席は、起動直後にタイム終了ポップアップやチャイムが再暴発しないよう記録しつつ超過表示を継続
          if (endMs <= launchNow) {
            mainTimeupAlertedRef.current[s.id] = s.targetEndTimestamp;
            if (!s.timeUpTimestamp) {
              s.timeUpTimestamp = s.targetEndTimestamp;
            }
            const elapsedOverSec = Math.floor((launchNow - endMs) / 1000);
            if (elapsedOverSec >= 180) {
              s.escalationLevel = Math.max(s.escalationLevel || 0, 3);
              escalatedAlertRef.current[s.id] = true;
            } else if (elapsedOverSec >= 60) {
              s.escalationLevel = Math.max(s.escalationLevel || 0, 2);
            } else if (elapsedOverSec >= 30) {
              s.escalationLevel = Math.max(s.escalationLevel || 0, 1);
            }
          }
        }
      });
      if (didSanitize) {
        persistSeatsForSalonId(foundSalon?.id, loadedSeats, foundIsOwner).catch(() => {});
      }
      setSeats(loadedSeats);

      // 3. スタッフメンバー一覧の読み込み（初期値は空 []）
      const savedMembersJson = await AsyncStorage.getItem('@salon_staff_members');
      let loadedMembers = [];
      if (savedMembersJson) {
        try {
          const parsed = JSON.parse(savedMembersJson);
          if (Array.isArray(parsed)) {
            loadedMembers = normalizeStaffMembers(parsed, activeUserId);
          }
        } catch (e) {
          console.warn('Failed to parse saved staff members', e);
        }
      }
      setStaffMembers(loadedMembers);

      // ★ 初回ロード時にもWatchへ最新客席データ＆メンバーを即時プッシュ！
      syncSeatsToWatch(loadedSeats, activeUserName, loadedMembers, { immediate: true });

      // ★ Bluetooth接続確立のタイムラグ（1〜2.5秒）をカバーする全自動バックアップ再送（常に最新のRef状態を送出し、クラウド同期後の席上書きを防止）
      if (Platform.OS === 'ios') {
        setTimeout(() => {
          syncSeatsToWatch(
            Array.isArray(seatsRef.current) ? seatsRef.current : loadedSeats,
            userNameRef.current || activeUserName,
            Array.isArray(staffMembersRef.current) ? staffMembersRef.current : loadedMembers,
            { immediate: true }
          );
        }, 1200);
        setTimeout(() => {
          syncSeatsToWatch(
            Array.isArray(seatsRef.current) ? seatsRef.current : loadedSeats,
            userNameRef.current || activeUserName,
            Array.isArray(staffMembersRef.current) ? staffMembersRef.current : loadedMembers,
            { immediate: true }
          );
        }, 2500);
      }
    } catch (e) {
      console.warn('Failed to load initial salon data', e);
    } finally {
      setIsDataLoaded(true);
    }
  };

  // 表示名（ニックネーム）の保存・更新
  const handleSaveUserName = async () => {
    const trimmed = inputUserName.trim();
    if (!trimmed) {
      Alert.alert('入力エラー', '表示名（ニックネーム）を入力してください。');
      return;
    }
    try {
      await AsyncStorage.setItem('@assist_timer_user_name', trimmed);
      const oldName = userName;
      setUserName(trimmed);
      setIsEditingUserName(false);

      // Supabaseクラウド上のメンバー表示名も同期更新（未参加のローカルworkspace-free時はスキップ）
      const targetSalonId =
        cloudSalonIdRef.current ||
        (currentSalon?.id && currentSalon.id !== 'workspace-free' ? currentSalon.id : null);
      if (targetSalonId) {
        updateMemberDisplayName({
          salonId: targetSalonId,
          displayName: trimmed,
        }).catch((e) => console.warn('updateMemberDisplayName error:', e));
      }

      // 既存席の担当者名に旧名が設定されていた場合、新名へ同期（メイン・ヘルプ・チェックすべて更新）
      const updatedSeats = seats.map((s) => ({
        ...s,
        colorStaffName: s.colorStaffName === oldName ? trimmed : s.colorStaffName,
        assistantStaffName: s.assistantStaffName === oldName ? trimmed : s.assistantStaffName,
        checkStaffName: s.checkStaffName === oldName ? trimmed : s.checkStaffName,
        checkStaff: s.checkStaff === oldName ? trimmed : s.checkStaff,
      }));
      setSeats(updatedSeats);
      saveSeatsToStorage(updatedSeats);
      syncSeatsToWatch(updatedSeats, trimmed, staffMembers);

      if (Platform.OS !== 'web') {
        Vibration.vibrate([0, 100, 50, 100]);
      }
      Alert.alert(
        '👤 表示名を更新しました',
        `表示名を「${trimmed}」に設定しました。\n\nサロン全体の担当者名、通知、およびApple Watchでの表示に即時反映されます。`
      );
    } catch (e) {
      console.warn('Failed to save user name', e);
    }
  };

  // ★ 共有コードによるメンバー接続参加・手動追加
  const handleJoinMemberByCode = async () => {
    const staffNick = (inputJoinMemberNickname || '').trim();
    if (!staffNick) {
      Alert.alert('入力エラー', 'スタッフのお名前（ニックネーム）を入力してください');
      return;
    }

    const currentMyName = (userName || 'スタイリスト').trim();
    if (staffNick.toLowerCase() === currentMyName.toLowerCase()) {
      Alert.alert(
        '確認',
        `「${staffNick}」はあなたの現在の表示名と同じです。\nサロンで一緒に働く相手スタッフのお名前を入力してください。`
      );
      return;
    }

    // 重複チェック（名前）
    const isDup = staffMembers.some(
      (m) => getMemberDisplayName(m).toLowerCase() === staffNick.toLowerCase()
    );
    if (isDup) {
      Alert.alert('確認', `「${staffNick}」さんは既にメンバー登録されています。`);
      return;
    }

    const code = sanitizeInviteCode(inputJoinMemberCode);
    const newMemberId = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newMember = {
      id: newMemberId,
      originalNickname: staffNick,
      customNickname: staffNick,
      inviteCode: code,
      joinedAt: Date.now(),
    };

    const updated = [...staffMembers, newMember];
    setStaffMembers(updated);
    setInputJoinMemberCode('');
    setInputJoinMemberNickname('');
    setMemberManageSection('list');

    try {
      await AsyncStorage.setItem('@salon_staff_members', JSON.stringify(updated));
      // Apple Watchへ即時同期
      syncSeatsToWatch(seats, userName, updated, { immediate: true });
    } catch (e) {
      console.warn('Failed to save staff members', e);
    }

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 100, 50, 100]);
    }
    Alert.alert(
      '🎉 メンバー登録完了',
      code
        ? `共有コード「${code}」で「${staffNick}」さんを連携登録しました！\n\n・メンバーID: #${newMemberId.slice(-6)}\n\n客席タイマーやApple Watchで担当者として選択・リアルタイム共有できるようになりました。`
        : `「${staffNick}」さんをサロンメンバーに追加しました！\n\n・メンバーID: #${newMemberId.slice(-6)}\n\n客席タイマーやApple Watchで担当者として選択・共有できるようになりました。`
    );
  };

  // ★ メンバーのカスタム呼び名（表示名）変更
  const handleOpenEditNicknameModal = (member) => {
    setEditingMemberForNickname(member);
    setInputMemberCustomNickname(getMemberDisplayName(member));
    setIsEditNicknameModalVisible(true);
  };

  const handleSaveMemberCustomNickname = async () => {
    if (!editingMemberForNickname) return;
    const trimmed = (inputMemberCustomNickname || '').trim();
    if (!trimmed) {
      Alert.alert('入力エラー', '呼び名を入力してください');
      return;
    }

    const targetId = editingMemberForNickname.id;
    const oldDisplayName = getMemberDisplayName(editingMemberForNickname);
    const oldOriginalName = editingMemberForNickname.originalNickname || '';
    const updated = staffMembers.map((m) => {
      const match = (typeof m === 'object' && m.id === targetId) || (typeof m === 'string' && m === targetId);
      if (!match) return m;
      if (typeof m === 'string') {
        return {
          id: `mem_${Date.now()}`,
          originalNickname: m,
          customNickname: trimmed,
          joinedAt: Date.now(),
        };
      }
      return {
        ...m,
        customNickname: trimmed,
      };
    });

    const updatedSeats = seats.map((s) => {
      if (!s) return s;
      const matchOld = (val) => val && (val === oldDisplayName || (oldOriginalName && val === oldOriginalName));
      const nextColor = matchOld(s.colorStaffName) ? trimmed : s.colorStaffName;
      const nextAssist = matchOld(s.assistantStaffName) ? trimmed : s.assistantStaffName;
      const nextCheck = matchOld(s.checkStaffName) ? trimmed : s.checkStaffName;
      if (nextColor !== s.colorStaffName || nextAssist !== s.assistantStaffName || nextCheck !== s.checkStaffName) {
        return {
          ...s,
          colorStaffName: nextColor,
          assistantStaffName: nextAssist,
          checkStaffName: nextCheck,
        };
      }
      return s;
    });

    setStaffMembers(updated);
    setSeats(updatedSeats);
    setIsEditNicknameModalVisible(false);
    setEditingMemberForNickname(null);
    setInputMemberCustomNickname('');

    try {
      await AsyncStorage.setItem('@salon_staff_members', JSON.stringify(updated));
      await persistSeatsForSalonId(getActiveStorageSalonId(), updatedSeats, isSalonOwnerRef.current);
      const targetCloudSalonId =
        cloudSalonIdRef.current ||
        (isCloudUUID(currentSalon?.id) ? currentSalon.id : null);
      if (targetCloudSalonId && typeof editingMemberForNickname === 'object') {
        updateMemberDisplayName({
          salonId: targetCloudSalonId,
          displayName: trimmed,
          targetUserId: editingMemberForNickname.user_id || editingMemberForNickname.id || null,
          cloudMemberId: editingMemberForNickname.cloudMemberId || null,
        }).catch((err) => console.warn('Failed to sync member custom nickname to cloud:', err));
      }
      syncChangedSeatsToCloud(updatedSeats);
      // Apple Watchへ即時同期
      syncSeatsToWatch(updatedSeats, userName, updated, { immediate: true });
    } catch (e) {
      console.warn('Failed to save custom nickname', e);
    }

    if (Platform.OS !== 'web') {
      Vibration.vibrate(40);
    }
  };

  // ★ スタッフメンバーの削除・共有連携解除（Supabaseクラウド連動）
  const handleRemoveStaffMember = (memberItem) => {
    if (!memberItem) return;
    if (typeof memberItem === 'object' && memberItem.role === 'owner') {
      Alert.alert('解除できません', 'サロン作成者（オーナー）はメンバーから削除できません。');
      return;
    }

    const displayName = getMemberDisplayName(memberItem);
    const targetId = typeof memberItem === 'object' ? memberItem.id : memberItem;
    const targetCloudMemberId = typeof memberItem === 'object' ? memberItem.cloudMemberId : null;
    const targetUserId =
      typeof memberItem === 'object'
        ? memberItem.user_id || (isCloudUUID(memberItem.id) ? memberItem.id : null)
        : (isCloudUUID(memberItem) ? memberItem : null);
    const isSelfLeave =
      typeof memberItem === 'object' && !!memberItem.isMe && !isSalonOwnerRef.current;

    Alert.alert(
      isSelfLeave ? 'サロンからの退出' : 'メンバーの解除',
      isSelfLeave
        ? `「${currentSalon?.name || 'このサロン'}」から退出して共有連携を解除しますか？`
        : `「${displayName}」さんとの共有連携を解除しますか？`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: isSelfLeave ? '退出する' : '解除する',
          style: 'destructive',
          onPress: async () => {
            const activeCloudSalonId =
              cloudSalonIdRef.current ||
              (isCloudUUID(currentSalonRef.current?.id) ? currentSalonRef.current.id : null);
            const isCloudMember = !!(isCloudUUID(targetCloudMemberId) || targetUserId);

            if (activeCloudSalonId && isCloudMember) {
              const ok = await deleteSalonMember({
                salonId: activeCloudSalonId,
                cloudMemberId: targetCloudMemberId,
                targetUserId: targetUserId,
              });
              if (!ok) {
                Alert.alert('通信エラー', 'クラウドからのメンバー解除に失敗しました。通信環境をご確認のうえ再度お試しください。');
                return;
              }
            }

            if (isSelfLeave && activeCloudSalonId) {
              await detachFromRemovedGuestSalon(activeCloudSalonId);
              return;
            }

            const prevList = Array.isArray(staffMembersRef.current) ? staffMembersRef.current : staffMembers;
            const updated = prevList.filter((m) => {
              if (!m) return false;
              if (typeof m === 'object') {
                if (targetId && m.id === targetId) return false;
                if (targetCloudMemberId && m.cloudMemberId === targetCloudMemberId) return false;
                if (targetUserId && (m.user_id === targetUserId || m.id === targetUserId)) return false;
                return true;
              }
              return m !== targetId;
            });

            setStaffMembers(updated);
            staffMembersRef.current = updated;
            if (activeCloudSalonId) {
              updateCloudSalonMemberCountDescription(activeCloudSalonId, updated.length);
            }
            try {
              await AsyncStorage.setItem('@salon_staff_members', JSON.stringify(updated));
              // Apple Watchへ即時同期
              syncSeatsToWatch(
                seatsRef.current || seats,
                userNameRef.current || userName,
                updated,
                { immediate: true }
              );
            } catch (e) {
              console.warn('Failed to save staff members after remove', e);
            }
          },
        },
      ]
    );
  };

  // サロン・グループ切り替え（切り替え先サロンの専用ストレージから席を復元し、別サロンの席混入・消失を防止）
  const handleSelectSalon = async (salon) => {
    if (!salon) return;
    setIsSwitcherModalVisible(false);
    if (salon.id !== currentSalon?.id) {
      resetSalonRuntimeStateForSwitch();
      didSwitchSalonRef.current = true;
      cloudSalonIdRef.current =
        salon.id && salon.id !== 'workspace-free' && salon.id !== 'workspace-pro-demo' ? salon.id : null;
      const targetIsOwner = checkIsSalonOwner(salon, myUserIdRef.current || myUserId);
      _cachedIsSalonOwner = targetIsOwner;
      _cachedActiveSalonId = salon.id || 'workspace-free';
      pendingDeletedSeatsRef.current = await readPendingDeletedSeats(salon.id);
      const rawSwitchedSeats = await readSeatsForSalonFromStorage(
        salon,
        userNameRef.current || userName,
        myUserIdRef.current || myUserId,
        salon.id
      );
      const { seats: switchedSeats, didSanitize: didSanitizeSwitched } = sanitizeLoadedSeats(rawSwitchedSeats);
      if (didSanitizeSwitched) {
        persistSeatsForSalonId(salon.id, switchedSeats, targetIsOwner).catch(() => {});
      }
      setSeats(switchedSeats);
      syncSeatsToWatch(switchedSeats, userNameRef.current || userName, staffMembersRef.current || staffMembers, {
        immediate: true,
        forceEmpty: switchedSeats.length === 0,
      });
    }
    setCurrentSalon(salon);
    currentSalonRef.current = salon;
    AsyncStorage.setItem('@salon_current_salon_id', salon.id).catch((e) => console.warn(e));
  };

  // 招待コードの共有・コピー（OS標準の共有シート / LINE・メッセージ等）
  const handleShareInviteCode = async (salon) => {
    let targetSalon = salon || currentSalon;
    if (!targetSalon) return;
    let code = sanitizeInviteCode(targetSalon.inviteCode);
    if (!code) {
      code = generateRandomInviteCode();
      const updatedSalons = savedSalons.map((s) => (s.id === targetSalon.id ? { ...s, inviteCode: code } : s));
      setSavedSalons(updatedSalons);
      targetSalon = { ...targetSalon, inviteCode: code };
      if (currentSalon?.id === targetSalon.id) {
        setCurrentSalon(targetSalon);
      }
      saveSalonsToStorage(updatedSalons, targetSalon.id);
    }

    const isPair = targetSalon.type === 'pair';
    const name = targetSalon.name || (isPair ? 'タイマー同期モード' : 'サロン');
    try {
      const message = `【Assist Timer】サロンタイマー共有の招待コードです。\n\n🔑 招待コード: ${code}\n\n▼ 参加手順:\n① Assist Timer アプリを開き、上部の「サロン同期」を開きます。\n② ヘッダー右上の「参加」ボタンをタップ。\n③ あなたの名前と招待コード【${code}】を入力して「このサロンに参加する」を押すだけ！\n\nリアルタイムで客席タイマーが相互同期されます。`;
      await Share.share({
        message,
        title: isPair ? `タイマー同期の共有コード: ${code}` : `${name}の共有コード: ${code}`,
      });
    } catch (e) {
      Alert.alert('共有コード', `共有コード: ${code}`);
    }
  };

  // 招待コードの直接変更・保存（オーナー専用：既存クラウドサロンの invite_code を更新して全席・全メンバーを引き継ぐ）
  const handleSaveCustomInviteCode = async () => {
    if (!editingSalonForCode) return;
    if (!checkIsSalonOwner(editingSalonForCode, myUserIdRef.current || myUserId)) {
      Alert.alert('権限エラー', '招待コードの変更はサロン作成者（オーナー）のみ行えます。');
      return;
    }
    const clean = sanitizeInviteCode(inputNewInviteCode);
    if (!clean) {
      Alert.alert('入力エラー', '招待コードを入力してください');
      return;
    }
    if (clean.length < 4 || clean.length > 15) {
      Alert.alert('入力エラー', '招待コードは4〜15文字で入力してください');
      return;
    }
    if (isDummyExampleInviteCode(clean)) {
      Alert.alert('入力エラー', '入力例（000-000 などのサンプル番号）は招待コードに設定できません。別のコードを指定してください。');
      return;
    }

    const targetId = editingSalonForCode.id;
    let finalCode = clean;
    if (isCloudUUID(targetId)) {
      try {
        const updatedCloudSalon = await updateSalonInviteCode({
          salonId: targetId,
          newInviteCode: clean,
        });
        if (updatedCloudSalon?.invite_code) {
          finalCode = updatedCloudSalon.invite_code;
        }
      } catch (err) {
        Alert.alert('招待コード更新エラー', err.message || 'クラウド上の招待コード更新に失敗しました');
        return;
      }
    }

    const updated = savedSalons.map((s) => (s.id === targetId ? { ...s, inviteCode: finalCode } : s));
    setSavedSalons(updated);
    setEditingSalonForCode((prev) => (prev ? { ...prev, inviteCode: finalCode } : prev));
    if (currentSalon?.id === targetId) {
      const nextCurrent = { ...currentSalon, inviteCode: finalCode };
      setCurrentSalon(nextCurrent);
      currentSalonRef.current = nextCurrent;
    }
    saveSalonsToStorage(updated, currentSalon?.id);
    setSwitcherSubView('list');
    Alert.alert('招待コードを更新しました', `招待コード: ${finalCode}\n\n既存の客席とメンバーを維持したまま更新しました。パートナーにこのコードを共有してご参加ください。`);
  };

  // ランダムコード再生成
  const handleRegenerateRandomCode = () => {
    const newCode = generateRandomInviteCode();
    setInputNewInviteCode(newCode);
  };

  // 招待コードで新規参加（Supabaseクラウド連携）
  const handleJoinByCode = async () => {
    const code = sanitizeInviteCode(inputInviteCode);
    if (!code) {
      Alert.alert('入力エラー', '6桁の招待コードを入力してください');
      return;
    }
    if (isDummyExampleInviteCode(code)) {
      Alert.alert('入力エラー', '「000-000」などの番号は入力例です。親端末に表示されている実際の6桁の招待コードを入力してください。');
      return;
    }

    const staffName = (inputStaffName || userName || 'アシスタント').trim();
    if (!staffName) {
      Alert.alert('入力エラー', 'あなたのお名前（スタッフ名）を入力してください');
      return;
    }

    // 現在のサロンと同じコードかチェック
    if (currentSalon?.inviteCode === code) {
      Alert.alert('確認', `現在開いている「${currentSalon.name || 'サロン'}」と同じ招待コードです。`);
      setIsJoinCodeModalVisible(false);
      return;
    }

    try {
      // Supabaseクラウドへ招待コードで参加！
      const { salon, members } = await joinSalonByInviteCode({
        inviteCode: code,
        userName: staffName,
      });

      // ユーザー名を保存＆更新
      setUserName(staffName);
      AsyncStorage.setItem('@assist_timer_user_name', staffName).catch(() => {});

      const uid = myUserId || (await getOrCreateUserId());
      const isJoinedSalonOwner = salon.owner_user_id === uid;
      const newSalonItem = {
        id: salon.id,
        name: salon.name || (inputSalonName || '').trim() || `サロン (${code})`,
        type: 'salon',
        inviteCode: salon.invite_code,
        ownerUserId: salon.owner_user_id,
        isPro: !!salon.is_pro,
        role: isJoinedSalonOwner ? 'owner' : 'assistant',
        description: `${members.length}名参加中 (クラウド同期中)`,
      };

      _cachedIsSalonOwner = isJoinedSalonOwner;
      _cachedActiveSalonId = newSalonItem.id;
      pendingDeletedSeatsRef.current = await readPendingDeletedSeats(newSalonItem.id);

      const updatedSalons = [newSalonItem, ...savedSalons.filter((s) => s.id !== salon.id && s.inviteCode !== salon.invite_code)];
      setSavedSalons(updatedSalons);
      setCurrentSalon(newSalonItem);
      currentSalonRef.current = newSalonItem;
      saveSalonsToStorage(updatedSalons, newSalonItem.id);

      // クラウドのメンバー一覧を即時反映
      const normalizedMembers = normalizeStaffMembers(members, uid);
      setStaffMembers(normalizedMembers);
      AsyncStorage.setItem('@salon_staff_members', JSON.stringify(normalizedMembers)).catch(() => {});

      // 前のサロンの同期キャッシュやAlarmKit予約をリセットしてから切り替え
      resetSalonRuntimeStateForSwitch();
      didSwitchSalonRef.current = true;

      // クラウドサロンIDを即時保持＆プッシュ通知トークンを登録
      cloudSalonIdRef.current = salon.id;
      registerAndSyncSalonPushToken({ salonId: salon.id, userId: uid }).catch(() => {});

      // 親サロンの客席タイマーを即時取得して自分のローカル席を100%上書き置換（0件の場合も旧サロン席やサンプル席を残さない）
      const cloudTimers = await fetchSalonTimers(salon.id, { returnNullOnError: true });
      isRemoteSyncRef.current = true;
      const initialJoinedSeats = (Array.isArray(cloudTimers) ? cloudTimers : []).map((ct) =>
        shouldRetainSeatHistory(ct)
          ? { ...ct, history: [buildStartHistoryEntryFromSeat(ct)] }
          : { ...ct, history: [] }
      );
      initialJoinedSeats.forEach((ct) => {
        if (ct?.id) {
          lastSyncedSeatsStateRef.current[ct.id] = getSeatCloudSignature(ct);
        }
      });
      setSeats(initialJoinedSeats);
      persistSeatsForSalonId(salon.id, initialJoinedSeats, isJoinedSalonOwner).catch(() => {});
      syncSeatsToWatch(initialJoinedSeats, staffName, normalizedMembers, {
        immediate: true,
        forceEmpty: initialJoinedSeats.length === 0,
      });
      setTimeout(() => {
        isRemoteSyncRef.current = false;
      }, 500);

      setIsJoinCodeModalVisible(false);
      setInputInviteCode('');
      setInputSalonName('');

      if (Platform.OS !== 'web') {
        Vibration.vibrate([0, 100, 50, 100]);
      }
      Alert.alert(
        '🎉 サロン参加完了',
        `「${newSalonItem.name}」に「${staffName}」として参加しました！\n\n現在 ${members.length} 名のスタッフとリアルタイムにタイマーを共有できます。`
      );
    } catch (err) {
      Alert.alert('参加エラー', err.message || 'サロンへの接続に失敗しました');
    }
  };

  // 🧪 サロン共有モード（PRO）テスト用サロンの作成・切り替え
  const handleCreateTestProSalon = () => {
    const testId = 'workspace-pro-demo';
    const exists = savedSalons.find((s) => s.id === testId);

    const testSalonItem = exists || {
      id: testId,
      name: '表参道店 (PROサロン共有)',
      type: 'salon',
      inviteCode: generateRandomInviteCode(),
      isPro: true,
      role: 'owner',
      memberCount: 5,
      description: 'PROサロン共有中 (5名オンライン / 店舗全体同期)',
    };

    let updatedSalons = savedSalons;
    if (!exists) {
      updatedSalons = [...savedSalons, testSalonItem];
      setSavedSalons(updatedSalons);
      saveSalonsToStorage(updatedSalons, testSalonItem.id);
    }

    setCurrentSalon(testSalonItem);
    AsyncStorage.setItem('@salon_current_salon_id', testSalonItem.id).catch((e) => console.warn(e));

    // サンプルスタッフ・座席の追加（複数人共有のリアルなシミュレーション）
    setSeats((prev) => {
      const hasStaffSeats = prev.some((s) => s.id === 'seat-test-2');
      if (hasStaffSeats) return prev;
      const testSeats = [
        ...prev,
        {
          id: 'seat-test-2',
          seatLabel: '2番席',
          status: 'running',
          colorStaffName: '佐藤',
          assistantStaffName: '渡辺',
          actionStatus: null,
          isShampooing: false,
          targetSeconds: 1500,
          initialMinutes: 25,
          targetEndTimestamp: Date.now() + 14 * 60 * 1000 + 20 * 1000,
          checkTargetSeconds: 420,
          checkStatus: 'running',
          checkEndTimestamp: Date.now() + 4 * 60 * 1000 + 15 * 1000,
          comment: '白髪染めリタッチ (チェック後乳化)',
          history: [
            {
              id: 'h-test-2-1',
              time: getCurrentTimeFormatted(),
              text: '25分放置 (チェック: 7分)',
              type: 'timer',
            },
          ],
        },
        {
          id: 'seat-test-3',
          seatLabel: '3番席 (個室)',
          status: 'paused',
          pausedRemainingSeconds: 0,
          colorStaffName: '田中',
          assistantStaffName: '伊藤',
          actionStatus: 'shampoo',
          isShampooing: true,
          targetSeconds: 1800,
          initialMinutes: 30,
          targetEndTimestamp: null,
          comment: 'シャンプー中',
          history: [],
        },
      ];
      saveSeatsToStorage(testSeats);
      return testSeats;
    });

    setIsSwitcherModalVisible(false);
    setIsProModalVisible(false);
    Alert.alert(
      '🧪 サロン共有モード（PRO）に切り替えました',
      'テスト用「表参道店 (PROサロン共有)」を開始しました。\n\n・5名オンライン、3席稼働のサロン現場をシミュレートしています。\n・上部バーからいつでも「タイマー同期モード (無料)」に戻せます。\n・長押しまたはゴミ箱でこのテストサロンを削除できます。'
    );
  };

  // サロン・ワークスペースの削除（テスト用サロンや参加サロンの退出用）
  const handleDeleteSalon = (salonToDelete) => {
    if (salonToDelete.id === 'workspace-free') {
      Alert.alert('削除不可', 'デフォルトの「タイマー同期モード」は削除できません');
      return;
    }
    Alert.alert(
      'サロンの削除',
      `「${salonToDelete.name}」を削除しますか？\n（いつでも「コードで参加」またはテストボタンから再追加できます）`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除する',
          style: 'destructive',
          onPress: async () => {
            const updated = savedSalons.filter((s) => s.id !== salonToDelete.id);
            setSavedSalons(updated);
            let nextSalon = currentSalon;
            if (currentSalon?.id === salonToDelete.id) {
              resetSalonRuntimeStateForSwitch();
              didSwitchSalonRef.current = true;
              nextSalon = updated[0] || createDefaultFreeSalon();
              const nextIsOwner = checkIsSalonOwner(nextSalon, myUserIdRef.current || myUserId);
              _cachedIsSalonOwner = nextIsOwner;
              _cachedActiveSalonId = nextSalon.id || 'workspace-free';
              cloudSalonIdRef.current =
                nextSalon.id && nextSalon.id !== 'workspace-free' && nextSalon.id !== 'workspace-pro-demo'
                  ? nextSalon.id
                  : null;
              pendingDeletedSeatsRef.current = await readPendingDeletedSeats(nextSalon.id);
              const rawRestoredSeats = await readSeatsForSalonFromStorage(
                nextSalon,
                userNameRef.current || userName,
                myUserIdRef.current || myUserId,
                nextSalon.id
              );
              const { seats: restoredSeats, didSanitize: didSanitizeRestored } = sanitizeLoadedSeats(rawRestoredSeats);
              if (didSanitizeRestored) {
                persistSeatsForSalonId(nextSalon.id, restoredSeats, nextIsOwner).catch(() => {});
              }
              setSeats(restoredSeats);
              syncSeatsToWatch(
                restoredSeats,
                userNameRef.current || userName,
                staffMembersRef.current || staffMembers,
                { immediate: true, forceEmpty: restoredSeats.length === 0 }
              );
              setCurrentSalon(nextSalon);
              currentSalonRef.current = nextSalon;
              AsyncStorage.setItem('@salon_current_salon_id', nextSalon.id).catch((e) => console.warn(e));
            }
            saveSalonsToStorage(updated, nextSalon.id);
          },
        },
      ]
    );
  };

  // ★ ユーザー指定: タイム設定モーダルでの席名変更の保存（オーナーのみ）
  const handleSaveSeatLabel = () => {
    if (!isSalonOwnerRef.current) {
      setIsEditingSeatLabel(false);
      return;
    }
    const trimmed = (modalSeatLabel || '').trim() || '席';
    setModalSeatLabel(trimmed);
    setIsEditingSeatLabel(false);
    if (targetSeatId) {
      const oldSeat = seats.find((s) => s.id === targetSeatId);
      const oldLabel = (oldSeat?.seatLabel || oldSeat?.name || '').trim();
      setSeats((prev) => {
        const updated = prev.map((s) =>
          s.id === targetSeatId ? { ...s, seatLabel: trimmed, name: trimmed, dirtySync: true } : s
        );
        saveSeatsToStorage(updated);
        syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });
        return updated;
      });
      const targetSalonId =
        cloudSalonIdRef.current ||
        (currentSalon?.id && currentSalon.id !== 'workspace-free' && currentSalon.id !== 'workspace-pro-demo'
          ? currentSalon.id
          : null);
      if (targetSalonId && oldSeat && oldLabel && oldLabel !== trimmed) {
        upsertCloudTimer(targetSalonId, {
          ...oldSeat,
          seatLabel: trimmed,
          name: trimmed,
          oldSeatLabel: oldLabel,
        }).catch(() => {});
      }
    }
  };

  // ★ 席名ダイレクト変更モーダルを開く（オーナーのみ）
  const handleOpenSeatRenameModal = (seat) => {
    if (!seat || !isSalonOwnerRef.current) return;
    setRenameTargetSeat(seat);
    const cleanLabel = (seat.seatLabel || '').replace(/^[🪑⌚️⏱️]\s*/, '').trim();
    setRenameSeatLabelInput(cleanLabel);
    setIsRenameSeatModalVisible(true);
  };

  // ★ 席名変更の確定保存（オーナーのみ：ローカル保存・Watch同期・Supabaseリアルタイム同期）
  const handleSaveSeatRename = async () => {
    if (!renameTargetSeat || !isSalonOwnerRef.current) {
      setIsRenameSeatModalVisible(false);
      return;
    }
    const oldLabel = (renameTargetSeat.seatLabel || renameTargetSeat.name || '').trim();
    const trimmed = (renameSeatLabelInput || '').trim();
    const finalLabel = trimmed || `${renameTargetSeat.seatNumber || 1}番席`;
    const targetId = renameTargetSeat.id;

    // まずモーダルを即座に閉じる（UI応答性100%保証）
    setIsRenameSeatModalVisible(false);
    setRenameTargetSeat(null);
    setRenameSeatLabelInput('');

    let renamedSeatObj = null;
    const updatedSeats = seats.map((s) => {
      if (s.id === targetId) {
        renamedSeatObj = { ...s, seatLabel: finalLabel, name: finalLabel, dirtySync: true };
        return renamedSeatObj;
      }
      return s;
    });

    setSeats(updatedSeats);
    saveSeatsToStorage(updatedSeats);
    syncSeatsToWatch(updatedSeats, userName, staffMembers, { immediate: true });

    const targetSalonId =
      cloudSalonIdRef.current ||
      (currentSalonRef.current?.id &&
      currentSalonRef.current.id !== 'workspace-free' &&
      currentSalonRef.current.id !== 'workspace-pro-demo'
        ? currentSalonRef.current.id
        : null);
    if (targetSalonId && renamedSeatObj) {
      upsertCloudTimer(targetSalonId, { ...renamedSeatObj, oldSeatLabel: oldLabel }).catch((e) =>
        console.warn('Supabase update seat_label failed:', e)
      );
    }
  };

  // 待機席・00:00リセット席タップ → タイム設定モーダルを開く（新規設定・Watch側と統一のフル設定）
  const handleOpenSetTimerModal = (seat) => {
    setIsEditingSeatLabel(false);
    setTargetSeatId(seat.id);
    setModalSeatLabel(seat.seatLabel);
    setModalTargetMinutes(20);
    setModalTargetSeconds(0);
    setModalCheckMinutes(0);
    setModalCheckSeconds(0);
    setModalCheckStaffName('');
    setModalCheckProcess('チェック');
    setModalWatchAlarmSoundEnabled(false);
    setModalAlarmSoundEnabled(false);
    setModalColorStaff(userName || 'スタイリスト');
    setModalAssistantStaff('');
    setModalComment(seat.status === 'idle' ? '' : (seat.comment || ''));
    setIsEditingExistingTimer(false);
    setTimerSetupMode('default');
    setIsSetTimerModalVisible(true);
  };

  // タイマーの数字部分を押した時: 時間変更＆タイマー停止アクションモーダルを開く
  const handlePressSeatTimerDigits = (seat) => {
    // 待機中またはリセット状態（00:00）の場合はApple Watch側と統一してフルタイム設定モーダルを直接開く
    if (
      seat.status === 'idle' ||
      seat.isReset ||
      (seat.status === 'paused' && (seat.pausedRemainingSeconds === 0 || !seat.pausedRemainingSeconds))
    ) {
      handleOpenSetTimerModal(seat);
      return;
    }
    setIsAddingLateCheck(false);
    setActionTargetSeat(seat);
    setIsTimeActionModalVisible(true);
  };

  // ★ ユーザー指定: 稼働中の共有タイマーの「タイマーを止める」画面一番下から「チェックタイマーを追加」を開く
  const handleOpenLateCheckPanel = () => {
    if (!actionTargetSeat) return;
    const existingMins = actionTargetSeat.checkTargetSeconds > 0
      ? Math.max(1, Math.round(actionTargetSeat.checkTargetSeconds / 60))
      : 5;
    setLateCheckMinutes(existingMins);
    setLateCheckProcess(sanitizeCheckProcess(actionTargetSeat.checkProcess));
    setLateCheckStaffName(actionTargetSeat.checkStaffName || '');
    setIsAddingLateCheck(true);
  };

  // ★ ユーザー指定: 後から追加したチェックタイマー（分数・ヘルプ内容・担当者）を確定反映
  const handleApplyLateCheckTimer = () => {
    if (!actionTargetSeat) return;
    const seat = actionTargetSeat;
    const mins = Math.max(1, Number(lateCheckMinutes) || 5);
    const checkSec = mins * 60;
    const checkEndTs = Date.now() + checkSec * 1000;
    const chkProcess = sanitizeCheckProcess(lateCheckProcess);
    const chkStaff = (lateCheckStaffName || '').trim();
    const currentUser = (userName || 'スタッフ').trim();
    const nowStr = getCurrentTimeFormatted();
    const staffNote = chkStaff ? ` (${chkStaff === '募集中' ? '全員募集' : `担当:${chkStaff}`})` : '';

    if (checkAlertedRef.current) {
      checkAlertedRef.current[seat.id] = false;
    }

    const updatedSeats = seats.map((s) => {
      if (s.id !== seat.id) return s;
      const prevHist = s.history || [];
      return {
        ...s,
        checkTargetSeconds: checkSec,
        checkInitialMinutes: mins,
        checkEndTimestamp: checkEndTs,
        checkPausedRemainingSeconds: null,
        checkStatus: 'running',
        isCheckCompleted: false,
        checkProcess: chkProcess,
        checkStaffName: chkStaff || null,
        checkAlerted: false,
        history: [
          ...prevHist,
          {
            id: `h-${Date.now()}`,
            time: nowStr,
            text: `チェックタイマー追加 (${mins}分 / ${chkProcess}${staffNote})`,
            type: 'check',
          },
        ],
      };
    });

    setSeats(updatedSeats);
    saveSeatsToStorage(updatedSeats);
    syncSeatsToWatch(updatedSeats, userName, staffMembers, { immediate: true });

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 80, 50, 80]);
    }
    setIsAddingLateCheck(false);
    setIsTimeActionModalVisible(false);
  };

  // モーダルから「変更する」を選択した時（稼働中のタイマー変更）
  const handleProceedToEditTimer = () => {
    if (!actionTargetSeat) return;
    setIsTimeActionModalVisible(false);
    setIsEditingSeatLabel(false);
    const seat = actionTargetSeat;
    setTargetSeatId(seat.id);
    setModalSeatLabel(seat.seatLabel);
    const initialSec = seat.targetSeconds || (20 * 60);
    setModalTargetMinutes(Math.floor(initialSec / 60));
    setModalTargetSeconds(initialSec % 60);
    const chkSec = seat.checkTargetSeconds || 0;
    setModalCheckMinutes(Math.floor(chkSec / 60));
    setModalCheckSeconds(chkSec % 60);
    setModalCheckStaffName(seat.checkStaffName || '');
    setModalCheckProcess(sanitizeCheckProcess(seat.checkProcess));
    setModalWatchAlarmSoundEnabled(!!seat.watchAlarmSoundEnabled);
    setModalAlarmSoundEnabled(!!seat.alarmSoundEnabled);
    setModalColorStaff(seat.colorStaffName || userName || 'スタイリスト');
    setModalAssistantStaff(seat.assistantStaffName || '');
    setModalComment(seat.comment || '');
    setIsEditingExistingTimer(true);
    setTimerSetupMode('edit');
    setIsSetTimerModalVisible(true);
  };

  // 停止中席から「新しく測る」を選択した時（新しく測る時は新しく）
  const handleProceedToNewTimer = () => {
    if (!actionTargetSeat) return;
    setIsTimeActionModalVisible(false);
    setIsEditingSeatLabel(false);
    const seat = actionTargetSeat;
    setTargetSeatId(seat.id);
    setModalSeatLabel(seat.seatLabel);
    setModalTargetMinutes(20);
    setModalTargetSeconds(0);
    setModalCheckMinutes(0);
    setModalCheckSeconds(0);
    setModalCheckStaffName('');
    setModalCheckProcess('チェック');
    setModalWatchAlarmSoundEnabled(false);
    setModalAlarmSoundEnabled(false);
    setModalColorStaff(seat.colorStaffName || userName || 'スタイリスト');
    setModalAssistantStaff('');
    setModalComment('');
    setIsEditingExistingTimer(false);
    setTimerSetupMode('new');
    setIsSetTimerModalVisible(true);
  };

  // 停止中席から「追加タイム」を選択した時（追加の時は履歴に続きを入れる）
  const handleProceedToAddTimer = () => {
    if (!actionTargetSeat) return;
    setIsTimeActionModalVisible(false);
    setIsEditingSeatLabel(false);
    const seat = actionTargetSeat;
    setTargetSeatId(seat.id);
    setModalSeatLabel(seat.seatLabel);
    setModalTargetMinutes(7);
    setModalTargetSeconds(0);
    setModalCheckMinutes(0);
    setModalCheckSeconds(0);
    setModalCheckStaffName('');
    setModalCheckProcess('チェック');
    setModalWatchAlarmSoundEnabled(!!seat.watchAlarmSoundEnabled);
    setModalAlarmSoundEnabled(!!seat.alarmSoundEnabled);
    setModalColorStaff(seat.colorStaffName || userName || 'スタイリスト');
    setModalAssistantStaff(seat.assistantStaffName || '');
    setModalComment(seat.comment || '');
    setIsEditingExistingTimer(false);
    setTimerSetupMode('additional');
    setIsSetTimerModalVisible(true);
  };

  // モーダルから「タイマーを止める / 施術状態（シャンプー・コーミング・チェック・呼び出し・その他）に変更」を押した時
  // ★ 大元の共有タイマーはどの停止・工程移行ボタンでも大元・チェック共に00:00にリセットして終了し、席カードを折りたたむ（iPhone/Watch完全統一）
  const handleStopTimerWithNotification = (newActionStatusOverride) => {
    if (!actionTargetSeat) return;
    const seat = actionTargetSeat;
    setIsTimeActionModalVisible(false);

    const currentUser = (userName || 'スタッフ').trim();
    // ヘルプ指定された項目（引数で上書き指定があればそれ、なければ席のヘルプ指定値、なければnull）
    const determinedActionId =
      newActionStatusOverride !== undefined
        ? newActionStatusOverride
        : seat.actionStatus || (seat.isShampooing ? 'shampoo' : null);

    const actionInfo = getActionStatusInfo(determinedActionId, determinedActionId === 'shampoo');

    // ★ どの工程移行・停止ボタンでも必ず席カードを折りたたむ（スリムバー状態）
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedPausedSeatIds((prev) => ({ ...prev, [seat.id]: false }));

    const actionLabel = actionInfo ? actionInfo.label : null;

    stopAlarm('salon', `${seat.id}-main`);
    stopAlarm('salon', `${seat.id}-check`);
    WatchConnectivity.notifyLocalStopOrReset(seat.id, seat.targetEndTimestamp || 0);
    if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[seat.id] = false;
    if (checkAlertedRef.current) checkAlertedRef.current[seat.id] = false;
    if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[seat.id] = false;
    if (escalatedAlertRef.current) escalatedAlertRef.current[seat.id] = false;

    const updatedSeats = seats.map((s) => {
      if (s.id !== seat.id) return s;
      const preservedAssistOnAction =
        s.assistantStaffName && s.assistantStaffName !== 'ヘルプなし' && s.assistantStaffName !== 'none'
          ? s.assistantStaffName
          : currentUser;
      return {
        ...s,
        status: 'paused',
        pausedRemainingSeconds: 0,
        targetSeconds: 0,
        initialMinutes: 0,
        targetEndTimestamp: null,
        isOver: false,
        isReset: true,
        timeUpTimestamp: null,
        escalationLevel: 0,
        collapsedAtEnd: Date.now(),
        lastStoppedAt: Date.now(),
        lastStoppedTargetEndTimestamp: Number(s.targetEndTimestamp) || Number(s.lastStoppedTargetEndTimestamp) || 0,
        checkTargetSeconds: null,
        checkTotalSeconds: null,
        checkEndTimestamp: null,
        checkPausedRemainingSeconds: null,
        checkInitialMinutes: null,
        checkStaffName: '',
        checkProcess: 'チェック',
        checkStatus: 'stopped',
        isCheckCompleted: false,
        checkAlerted: false,
        actionStatus: determinedActionId || null,
        isShampooing: determinedActionId === 'shampoo',
        mainStaffConfirmed: true,
        assistantStaffConfirmed: true,
        stoppedBy: currentUser,
        ...(determinedActionId
          ? {
              assistantStaffName: preservedAssistOnAction,
              helpProcess: actionLabel || s.helpProcess || null,
              isRecruiting: false,
              isNoHelpNeeded: false,
            }
          : {
              assistantStaffName: '',
              helpProcess: null,
              isRecruiting: false,
              isNoHelpNeeded: false,
            }),
        history: [],
      };
    });
    setSeats(updatedSeats);
    saveSeatsToStorage(updatedSeats);

    // 強い確認振動
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 250, 100, 250]);
    }

    syncSeatsToWatch(updatedSeats, userName, staffMembers, { immediate: true, highPriorityWake: true });

    const mainStaff = (seat.colorStaffName || '').trim();
    const assistStaff = (seat.assistantStaffName || '').trim();
    const isMain = isMainStaffOfSeat(seat, userName, myUserId, staffMembers);
    const isAssist = isStaffNameMe(assistStaff, userName, myUserId, staffMembers);
    const isThirdParty = !isMain && !isAssist;

    const statusBadgeText = actionInfo ? `【${actionInfo.badge}】` : 'タイマー停止';

    if (isThirdParty) {
      // 第3者が止めた場合 -> メイン担当・ヘルプ担当・停止した第3者の3名に通知！
      Alert.alert(
        `🔔 第3者による停止・${actionLabel ? `${actionLabel}移行` : '停止'}通知 (3名共有)`,
        `「${seat.seatLabel}」のタイマーを【${currentUser}】（第3者）さんが停止し、${statusBadgeText}に変更しました。\n\n【関係者3名へリアルタイム通知完了】\n・🎨 ${mainStaff || 'メイン担当'}\n・🤝 ${assistStaff || 'ヘルプ担当'}\n・👤 ${currentUser}（操作者）\n\n関係者3名全員の端末およびApple Watchに通知が届きました。`,
        [{ text: 'OK' }]
      );
    } else {
      // メイン担当またはヘルプ担当が止めた場合 -> 2名お互いに通知
      Alert.alert(
        `🔔 タイマー停止 ＆ ${actionLabel ? `${actionLabel}移行` : '確認'}通知`,
        `「${seat.seatLabel}」のタイマーを停止し、${statusBadgeText}に変更しました。\n\n【お互いへの確認通知】\n・🎨 ${mainStaff || 'メイン担当'} に通知\n・🤝 ${assistStaff || 'ヘルプ担当'} に通知\n\n両者の端末およびApple Watchにリアルタイム通知されました。`,
        [{ text: 'OK' }]
      );
    }
  };

  // 本人による直接確認の反映
  const performDirectConfirm = (seatId, role) => {
    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== seatId) return s;
        const isNoHelp = !!s.isNoHelpNeeded || s.assistantStaffName === 'ヘルプなし' || s.assistantStaffName === 'none';
        let newMain = s.mainStaffConfirmed;
        let newAssist = s.assistantStaffConfirmed;

        if (role === 'main') {
          newMain = true;
          if (isNoHelp) newAssist = true;
        } else if (role === 'assistant') {
          newAssist = true;
        }

        return {
          ...s,
          mainStaffConfirmed: newMain,
          assistantStaffConfirmed: newAssist,
        };
      });
      saveSeatsToStorage(updated);
      return updated;
    });

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 150]);
    }
  };

  // スタッフによるタイム確認（ヘルプ担当本人の直接確認、または代理確認モーダル起動）
  const handlePressConfirmButton = (seat) => {
    const isNoHelp = !!seat.isNoHelpNeeded || seat.assistantStaffName === 'ヘルプなし' || seat.assistantStaffName === 'none';
    const isAssistant = isStaffNameMe(seat.assistantStaffName, userName, myUserId, staffMembers);

    // ① ヘルプ担当本人の場合 ➔ ワンタップで直接ヘルプ確認完了
    if (isAssistant && !seat.assistantStaffConfirmed && !isNoHelp) {
      performDirectConfirm(seat.id, 'assistant');
      return;
    }

    // ② ヘルプなし（ワンマン）の場合 ➔ ワンタップで直接完了
    if (isNoHelp) {
      performDirectConfirm(seat.id, 'main');
      return;
    }

    // ③ それ以外のスタッフ（指定したタイマー作成者または第三者）➔ 代理確認モーダルを表示
    setConfirmProxyTargetSeat(seat);
    setIsConfirmProxyModalVisible(true);
  };

  // 後方互換（ID指定呼び出し対応）
  const handleConfirmSeat = (seatId) => {
    const seat = seats.find((s) => s.id === seatId);
    if (seat) {
      handlePressConfirmButton(seat);
    }
  };

  // 第三者による代理確認の実行（メイン代行、ヘルプ代行、両者代行）
  const handleExecuteProxyConfirm = (seatId, targetRole) => {
    setIsConfirmProxyModalVisible(false);
    const targetSeat = seats.find((s) => s.id === seatId);
    if (!targetSeat) return;

    const currentOperator = userName || '第三者スタッフ';
    const colorName = targetSeat.colorStaffName || '未設定';
    const assistName = targetSeat.assistantStaffName || '未設定';

    let roleLabel = '';
    if (targetRole === 'main') {
      roleLabel = `メイン担当（${colorName}）`;
    } else if (targetRole === 'assistant') {
      roleLabel = `ヘルプ担当（${assistName}）`;
    } else {
      roleLabel = `メイン（${colorName}）およびヘルプ（${assistName}）の両者`;
    }

    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== seatId) return s;
        let newMain = s.mainStaffConfirmed;
        let newAssist = s.assistantStaffConfirmed;

        if (targetRole === 'main') {
          newMain = true;
        } else if (targetRole === 'assistant') {
          newAssist = true;
        } else if (targetRole === 'both') {
          newMain = true;
          newAssist = true;
        }

        return {
          ...s,
          mainStaffConfirmed: newMain,
          assistantStaffConfirmed: newAssist,
          proxyConfirmedBy: currentOperator,
        };
      });
      saveSeatsToStorage(updated);
      return updated;
    });

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 150, 80, 150]);
    }

    const message = `【${targetSeat.seatLabel}】のタイム確認について、${currentOperator}さんが${roleLabel}の代わりに代理確認を行いました。`;
    if (Platform.OS === 'web') {
      window.alert(message);
    } else {
      Alert.alert(
        '🤝 代理確認の完了・関係者共有',
        message + '\n\n（メイン担当・ヘルプ担当・自分の3名にリアルタイム共有されました）',
        [{ text: 'OK' }]
      );
    }
  };

  // SOS要請発信
  const handleTriggerSOS = (seatId) => {
    const targetSeat = seats.find((s) => s.id === seatId);
    setSeats((prev) => {
      const updated = prev.map((s) => (s.id === seatId ? { ...s, sosTriggered: true } : s));
      saveSeatsToStorage(updated);
      return updated;
    });

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 300, 100, 300, 100, 300]);
    }

    Alert.alert(
      '🚨 SOSヘルプ要請を発信しました',
      `「${targetSeat?.seatLabel || '対象席'}」へのヘルプ要請をサロンスタッフ全員に一斉発信しました！`
    );
  };

  // メインタイマーウィジェットの数字部分を押した時（共有タイマーと同じ分・秒トグル設定モーダルを開く・サブタイマーなし）
  const handlePressMainTimerDigits = () => {
    const nowMs = Date.now();
    let baseSec = mainTimerState?.targetTime || 600;
    if (mainTimerState?.isRunning && !mainTimerState?.isCountUp && mainTimerState?.targetEndTimestamp > nowMs) {
      baseSec = Math.max(10, Math.ceil((mainTimerState.targetEndTimestamp - nowMs) / 1000));
    } else if (!mainTimerState?.isCountUp && mainTimerState?.remainingTime > 0) {
      baseSec = mainTimerState.remainingTime;
    }
    setModalTargetMinutes(Math.floor(baseSec / 60));
    setModalTargetSeconds(baseSec % 60);
    setIsAddingFavorite(false);
    setNewFavoriteLabel('');
    setIsMainTimerEditModalVisible(true);
    if (Platform.OS !== 'web') {
      Vibration.vibrate(25);
    }
  };

  // メインタイマー時間変更モーダルから時間を適用・開始する
  const handleApplyMainTimerEditModal = (autoStart = false) => {
    const mins = Number(modalTargetMinutes) || 0;
    const secs = Number(modalTargetSeconds) || 0;
    const totalSeconds = Math.max(10, mins * 60 + secs);
    setIsMainTimerEditModalVisible(false);
    if (requestMainTimerAction) {
      requestMainTimerAction(
        'MAIN_TIMER_SET_TIME',
        {
          totalSeconds,
          seconds: totalSeconds,
          autoStart,
          playSoundOnPhone: true,
          fromPhone: true,
          timestamp: Date.now(),
        },
        `salon_main_set_${Date.now()}`
      );
    }
    if (Platform.OS !== 'web') {
      Vibration.vibrate(40);
    }
  };

  // お気に入りタイマーの保存
  const saveFavoritePresets = async (newList) => {
    setFavoritePresets(newList);
    try {
      await AsyncStorage.setItem('@salon_favorite_timer_presets', JSON.stringify(newList));
    } catch (e) {
      console.warn('Failed to save favorite presets', e);
    }
  };

  // 放置タイムの文字列表現ヘルパー（例: "7分", "7分30秒", "30秒"）
  const formatModalTargetTime = (mins, secs) => {
    const m = Number(mins) || 0;
    const s = Number(secs) || 0;
    if (m === 0 && s === 0) return '0秒';
    if (m === 0) return `${s}秒`;
    if (s === 0) return `${m}分`;
    return `${m}分${s}秒`;
  };

  // 秒単位の微調整（-30秒, -10秒, +10秒, +30秒）
  const handleAdjustTargetSeconds = (deltaSec) => {
    const currentTotal = (Number(modalTargetMinutes) || 0) * 60 + (Number(modalTargetSeconds) || 0);
    const newTotal = Math.max(10, Math.min(999 * 60, currentTotal + deltaSec));
    setModalTargetMinutes(Math.floor(newTotal / 60));
    setModalTargetSeconds(newTotal % 60);
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 30]);
    }
  };

  // 分単位の微調整（-5分, -1分, +1分, +5分）
  const handleAdjustTargetMinutes = (deltaMin) => {
    const currentTotal = (Number(modalTargetMinutes) || 0) * 60 + (Number(modalTargetSeconds) || 0);
    const newTotal = Math.max(10, Math.min(999 * 60, currentTotal + deltaMin * 60));
    setModalTargetMinutes(Math.floor(newTotal / 60));
    setModalTargetSeconds(newTotal % 60);
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 30]);
    }
  };

  // クイック分選択ピル
  const handleSelectQuickMinute = (min) => {
    setModalTargetMinutes(min);
    setModalTargetSeconds(0);
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 30]);
    }
  };

  // ★ ユーザー指定: チェックタイマーのクイック分選択ピル
  const handleSelectCheckMinute = (min) => {
    setModalCheckMinutes(min);
    setModalCheckSeconds(0);
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 30]);
    }
  };

  // ★ ユーザー指定: チェックタイマーの微調整（-1分, +1分）
  const handleAdjustCheckMinutes = (deltaMin) => {
    const currentTotal = (Number(modalCheckMinutes) || 0) * 60 + (Number(modalCheckSeconds) || 0);
    const newTotal = Math.max(0, Math.min(999 * 60, currentTotal + deltaMin * 60));
    setModalCheckMinutes(Math.floor(newTotal / 60));
    setModalCheckSeconds(newTotal % 60);
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 30]);
    }
  };

  // ★ ユーザー指定: 席のチェックタイマー停止・完了（大元タイマーは一切止めずカードも閉じない・タイマー設定者へ通知送信）
  const handleCompleteCheck = (seatId) => {
    stopAlarm('salon', `${seatId}-check`);
    if (checkAlertedRef.current) {
      checkAlertedRef.current[seatId] = false;
    }
    const targetSeat = seats.find((s) => s.id === seatId);
    const nowStr = getCurrentTimeFormatted();
    const currentUser = (userName || 'スタッフ').trim();
    const creatorName = (targetSeat?.colorStaffName || 'タイマー作成者').trim();
    const checker = (targetSeat?.checkStaffName || currentUser).trim();
    const targetChkProc = sanitizeCheckProcess(targetSeat?.checkProcess);

    const updatedSeats = seats.map((s) => {
      if (s.id !== seatId) return s;
      const prevHistory = s.history || [];
      const chkProcLabel = sanitizeCheckProcess(s.checkProcess);
      const chkText = `${checker}${chkProcLabel}完了`;
      const historyItem = {
        id: `h-${Date.now()}`,
        time: nowStr,
        text: chkText,
        type: 'check',
      };
      const preservedCheckSec = s.checkTargetSeconds || s.checkTotalSeconds || 60;
      return {
        ...s,
        isCheckCompleted: true,
        checkStatus: 'completed',
        checkEndTimestamp: null,
        checkPausedRemainingSeconds: null,
        checkTargetSeconds: preservedCheckSec,
        checkTotalSeconds: preservedCheckSec,
        checkProcess: chkProcLabel,
        history: [...prevHistory, historyItem],
      };
    });
    setSeats(updatedSeats);
    saveSeatsToStorage(updatedSeats);

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 150, 80, 150]);
    }

    syncSeatsToWatch(updatedSeats, userName, staffMembers, { immediate: true, highPriorityWake: true });

    // ★ ユーザー指定: 「そしたらタイマー設定者の方に通知が送られる」
    const isSelf = targetSeat
      ? isMainStaffOfSeat(targetSeat, userName, myUserId, staffMembers)
      : (creatorName && creatorName.toLowerCase() === currentUser.toLowerCase());

    if (isSelf) {
      Alert.alert(
        `🔔 ${targetChkProc}タイマー停止・完了`,
        `「${targetSeat?.seatLabel || '対象席'}」の${targetChkProc}タイマーを停止しました（全体放置タイマーは継続します）。\n施術履歴に「${checker}${targetChkProc}完了」と記録されました。`,
        [{ text: 'OK' }]
      );
    } else {
      // 第3者またはチェック担当が止めた場合 -> タイマー設定者（creatorName）へ通知が送られる！
      Alert.alert(
        `🔔 タイマー設定者へ${targetChkProc}完了通知を送信`,
        `「${targetSeat?.seatLabel || '対象席'}」の${targetChkProc}タイマーを停止しました（全体放置タイマーは継続します）。\n\n【リアルタイム通知送信完了】\n・📝 タイマー設定者: 【${creatorName}】さん\n・🔍 実施者: 【${checker}】さん\n\n設定者の端末およびApple Watchに${targetChkProc}完了通知が届きました。`,
        [{ text: 'OK' }]
      );
    }
  };

  // ★ ユーザー指定: チェックタイマー部分を押した時、「チェックタイマーを止めますか？」モーダルを開く
  const handlePressCheckTimer = (seat) => {
    if (seat.checkStatus === 'completed') {
      Alert.alert('チェック確認済み', `「${seat.seatLabel}」のチェックは既に完了しています。`);
      return;
    }
    setCheckStopTargetSeat(seat);
    setIsCheckStopModalVisible(true);
  };

  // ★ ユーザー指定: モーダルから「タイマーを止める」確定時
  const handleConfirmStopCheckTimer = () => {
    if (!checkStopTargetSeat) return;
    const seatId = checkStopTargetSeat.id;
    setIsCheckStopModalVisible(false);
    handleCompleteCheck(seatId);
  };

  // 現在の放置タイムをお気に入りに追加（チェックタイムも同時保存）
  const handleAddCurrentAsFavorite = (customLabel = '') => {
    const mins = Number(modalTargetMinutes) || 0;
    const secs = Number(modalTargetSeconds) || 0;
    const totalSec = mins * 60 + secs;
    if (totalSec < 10) {
      Alert.alert('登録エラー', '10秒以上の有効な時間を設定してください。');
      return;
    }
    const chkMins = Number(modalCheckMinutes) || 0;
    const chkSecs = Number(modalCheckSeconds) || 0;
    const label = (customLabel || newFavoriteLabel || '').trim();
    const timeLabel = formatModalTargetTime(mins, secs);
    // 既存に同じ分数・秒数・チェックタイムかつ同じラベルがあれば重複登録しない
    const isDuplicate = favoritePresets.some(
      (f) =>
        f.minutes === mins &&
        (f.seconds || 0) === secs &&
        (f.checkMinutes || 0) === chkMins &&
        (label ? f.label === label : !f.label)
    );
    if (isDuplicate) {
      Alert.alert('登録済み', `${timeLabel}のお気に入りは既に登録されています。`);
      return;
    }

    const newFav = {
      id: `fav-${Date.now()}`,
      minutes: mins,
      seconds: secs,
      checkMinutes: chkMins,
      checkSeconds: chkSecs,
      label: label,
    };
    const updated = [...favoritePresets, newFav];
    saveFavoritePresets(updated);
    setIsAddingFavorite(false);
    setNewFavoriteLabel('');
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 50]);
    }
  };

  // お気に入りを削除
  const handleDeleteFavoritePreset = (favId) => {
    const updated = favoritePresets.filter((f) => f.id !== favId);
    saveFavoritePresets(updated);
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 30]);
    }
  };

  // お気に入りを選択（チェックタイムも同時反映）
  const handleSelectFavoritePreset = (fav) => {
    setModalTargetMinutes(fav.minutes);
    setModalTargetSeconds(fav.seconds || 0);
    setModalCheckMinutes(fav.checkMinutes || 0);
    setModalCheckSeconds(fav.checkSeconds || 0);
    if (fav.label && !modalComment.trim()) {
      setModalComment(fav.label);
    }
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 40]);
    }
  };

  // タイム開始・時間変更の確定適用（新規開始、追加タイム、または稼働中席の時間変更）
  const handleStartSeatTimer = () => {
    const mins = Number(modalTargetMinutes) || 0;
    const secs = Number(modalTargetSeconds) || 0;
    const targetSec = mins * 60 + secs;
    if (targetSec < 10) {
      Alert.alert('タイム指定エラー', '10秒以上の数値を入力してください。');
      return;
    }

    const checkMins = Number(modalCheckMinutes) || 0;
    const checkSecs = Number(modalCheckSeconds) || 0;
    const checkTargetSec = checkMins * 60 + checkSecs;
    const hasCheckTimer = checkTargetSec > 0;

    // チェック時間が全体タイム以上になっていないかバリデーション
    if (hasCheckTimer && checkTargetSec >= targetSec) {
      Alert.alert(
        'チェック時間エラー',
        `チェックタイマーは全体の放置タイム（${formatModalTargetTime(mins, secs)}）より短い時間を指定してください。`
      );
      return;
    }

    const endTs = Date.now() + targetSec * 1000;
    const checkEndTs = hasCheckTimer ? Date.now() + checkTargetSec * 1000 : null;
    const nowStr = getCurrentTimeFormatted();
    const timeDisplay = formatModalTargetTime(mins, secs);
    const checkTimeDisplay = hasCheckTimer ? formatModalTargetTime(checkMins, checkSecs) : '';

    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== targetSeatId) return s;

        // ① 新しく測る時（新しく測る時は新しく・履歴リセット）
        if (timerSetupMode === 'new') {
          const newHistory = [
            {
              id: `h-${Date.now()}`,
              time: nowStr,
              text: hasCheckTimer
                ? `${timeDisplay}放置 (チェック: ${checkTimeDisplay})`
                : `${timeDisplay}放置 (新規)`,
              type: 'timer',
            },
          ];
          return {
            ...s,
            seatLabel: modalSeatLabel.trim() || s.seatLabel,
            status: 'running',
            colorStaffName: userName || 'スタイリスト',
            createdBy: myUserIdRef.current || myUserId || null,
            dirtySync: true,
            // ★ 新しく測る時は前の施術のヘルプを勝手に引き継がない
            assistantStaffName: (modalAssistantStaff || '').trim() || '',
            actionStatus: null,
            helpProcess: (modalAssistantStaff && modalAssistantStaff !== 'ヘルプなし' && modalAssistantStaff !== 'none') ? 'シャンプー' : '',
            isRecruiting: false,
            isNoHelpNeeded: modalAssistantStaff === 'ヘルプなし' || modalAssistantStaff === 'none',
            isShampooing: false,
            targetSeconds: targetSec,
            initialMinutes: mins > 0 ? mins : Math.round(targetSec / 60),
            targetEndTimestamp: endTs,
            pausedRemainingSeconds: null,
            isReset: false,
            isOver: false,
            timeUpTimestamp: null,
            escalationLevel: 0,
            collapsedAtEnd: null,
            checkTargetSeconds: hasCheckTimer ? checkTargetSec : null,
            checkTotalSeconds: hasCheckTimer ? checkTargetSec : null,
            checkInitialMinutes: hasCheckTimer ? (checkMins > 0 ? checkMins : Math.round(checkTargetSec / 60)) : null,
            checkEndTimestamp: checkEndTs,
            checkPausedRemainingSeconds: null,
            checkStatus: hasCheckTimer ? 'running' : null,
            isCheckCompleted: false,
            checkStaffName: hasCheckTimer ? (modalCheckStaffName || null) : null,
            checkProcess: hasCheckTimer ? sanitizeCheckProcess(modalCheckProcess) : 'チェック',
            checkAlerted: false,
            watchAlarmSoundEnabled: !!modalWatchAlarmSoundEnabled,
            alarmSoundEnabled: !!modalAlarmSoundEnabled,
            stoppedBy: null,
            mainStaffConfirmed: true,
            assistantStaffConfirmed: false,
            comment: modalComment !== undefined ? modalComment.trim() : (s.comment || ''),
            history: newHistory,
          };
        }

        // ② 追加タイムの時（追加の時は履歴に続きを入れる）
        if (timerSetupMode === 'additional') {
          const prevHistory = s.history || [];
          const additionalHistoryItem = {
            id: `h-${Date.now()}`,
            time: nowStr,
            text: hasCheckTimer
              ? `${timeDisplay}追加放置 (チェック: ${checkTimeDisplay})`
              : `${timeDisplay}追加放置`,
            type: 'timer',
          };
          const resolvedAssist = (modalAssistantStaff !== undefined && modalAssistantStaff !== '')
            ? modalAssistantStaff.trim()
            : (s.assistantStaffName || '');
          const resolvedIsNoHelp = resolvedAssist === 'ヘルプなし' || resolvedAssist === 'none';
          return {
            ...s,
            seatLabel: modalSeatLabel.trim() || s.seatLabel,
            status: 'running',
            colorStaffName: userName || 'スタイリスト',
            createdBy: myUserIdRef.current || myUserId || null,
            dirtySync: true,
            assistantStaffName: resolvedAssist,
            isNoHelpNeeded: resolvedIsNoHelp,
            isShampooing: false,
            targetSeconds: targetSec,
            initialMinutes: mins > 0 ? mins : Math.round(targetSec / 60),
            targetEndTimestamp: endTs,
            pausedRemainingSeconds: null,
            isReset: false,
            isOver: false,
            timeUpTimestamp: null,
            escalationLevel: 0,
            collapsedAtEnd: null,
            checkTargetSeconds: hasCheckTimer ? checkTargetSec : null,
            checkTotalSeconds: hasCheckTimer ? checkTargetSec : null,
            checkInitialMinutes: hasCheckTimer ? (checkMins > 0 ? checkMins : Math.round(checkTargetSec / 60)) : null,
            checkEndTimestamp: checkEndTs,
            checkPausedRemainingSeconds: null,
            checkStatus: hasCheckTimer ? 'running' : null,
            isCheckCompleted: false,
            checkStaffName: hasCheckTimer ? (modalCheckStaffName || s.checkStaffName || null) : null,
            checkProcess: hasCheckTimer ? sanitizeCheckProcess(modalCheckProcess || s.checkProcess) : 'チェック',
            checkAlerted: false,
            watchAlarmSoundEnabled: !!modalWatchAlarmSoundEnabled,
            alarmSoundEnabled: !!modalAlarmSoundEnabled,
            stoppedBy: null,
            mainStaffConfirmed: true,
            assistantStaffConfirmed: false,
            comment: modalComment !== undefined && modalComment.trim() !== '' ? modalComment.trim() : (s.comment || ''),
            history: [...prevHistory, additionalHistoryItem],
          };
        }

        // ③ 稼働中の時間変更時
        if (isEditingExistingTimer || timerSetupMode === 'edit') {
          const prevHistory = s.history || [];
          const historyItem = {
            id: `h-${Date.now()}`,
            time: nowStr,
            text: hasCheckTimer
              ? `${timeDisplay}に変更 (チェック: ${checkTimeDisplay})`
              : `${timeDisplay}に変更`,
            type: 'timer',
          };
          const resolvedAssist = (modalAssistantStaff !== undefined && modalAssistantStaff !== '')
            ? modalAssistantStaff.trim()
            : (s.assistantStaffName || '');
          const resolvedIsNoHelp = resolvedAssist === 'ヘルプなし' || resolvedAssist === 'none';
          const isRestartFromInactive = s.status !== 'running';
          return {
            ...s,
            seatLabel: modalSeatLabel.trim() || s.seatLabel,
            status: 'running',
            colorStaffName: isRestartFromInactive
              ? (userName || 'スタイリスト')
              : (s.colorStaffName || userName || 'スタイリスト'),
            createdBy: isRestartFromInactive
              ? (myUserIdRef.current || myUserId || null)
              : (s.createdBy || myUserIdRef.current || myUserId || null),
            dirtySync: true,
            assistantStaffName: resolvedAssist,
            isNoHelpNeeded: resolvedIsNoHelp,
            isShampooing: false,
            targetSeconds: targetSec,
            initialMinutes: s.initialMinutes || (mins > 0 ? mins : Math.round(targetSec / 60)),
            targetEndTimestamp: endTs,
            pausedRemainingSeconds: null,
            isReset: false,
            isOver: false,
            timeUpTimestamp: null,
            escalationLevel: 0,
            collapsedAtEnd: null,
            checkTargetSeconds: hasCheckTimer ? checkTargetSec : null,
            checkTotalSeconds: hasCheckTimer ? checkTargetSec : null,
            checkInitialMinutes: hasCheckTimer ? (checkMins > 0 ? checkMins : Math.round(checkTargetSec / 60)) : null,
            checkEndTimestamp: checkEndTs,
            checkPausedRemainingSeconds: null,
            checkStatus: hasCheckTimer ? 'running' : null,
            isCheckCompleted: false,
            checkStaffName: hasCheckTimer ? (modalCheckStaffName || s.checkStaffName || null) : null,
            checkProcess: hasCheckTimer ? sanitizeCheckProcess(modalCheckProcess || s.checkProcess) : 'チェック',
            checkAlerted: false,
            watchAlarmSoundEnabled: !!modalWatchAlarmSoundEnabled,
            alarmSoundEnabled: !!modalAlarmSoundEnabled,
            comment: modalComment !== undefined ? modalComment.trim() : (s.comment || ''),
            history: [...prevHistory, historyItem],
          };
        }

        // ④ 通常の新規開始（待機中・00:00リセット席からスタート：前回の履歴を引き継がず新規1件で開始）
        const historyItem = {
          id: `h-${Date.now()}`,
          time: nowStr,
          text: hasCheckTimer
            ? `${timeDisplay}放置 (チェック: ${checkTimeDisplay})`
            : `${timeDisplay}放置`,
          type: 'timer',
        };
        return {
          ...s,
          seatLabel: modalSeatLabel.trim() || s.seatLabel,
          status: 'running',
          colorStaffName: userName || 'スタイリスト',
          createdBy: myUserIdRef.current || myUserId || null,
          dirtySync: true,
          // ★ 新規開始時はモーダルの指定がなければ空文字
          assistantStaffName: (modalAssistantStaff || '').trim() || '',
          actionStatus: null,
          helpProcess: (modalAssistantStaff && modalAssistantStaff !== 'ヘルプなし' && modalAssistantStaff !== 'none') ? 'シャンプー' : '',
          isRecruiting: false,
          isNoHelpNeeded: modalAssistantStaff === 'ヘルプなし' || modalAssistantStaff === 'none',
          isShampooing: false,
          targetSeconds: targetSec,
          initialMinutes: mins > 0 ? mins : Math.round(targetSec / 60),
          targetEndTimestamp: endTs,
          lastStoppedAt: 0,
          lastStoppedTargetEndTimestamp: 0,
          pausedRemainingSeconds: null,
          isReset: false,
          isOver: false,
          timeUpTimestamp: null,
          escalationLevel: 0,
          collapsedAtEnd: null,
          checkTargetSeconds: hasCheckTimer ? checkTargetSec : null,
          checkTotalSeconds: hasCheckTimer ? checkTargetSec : null,
          checkInitialMinutes: hasCheckTimer ? (checkMins > 0 ? checkMins : Math.round(checkTargetSec / 60)) : null,
          checkEndTimestamp: checkEndTs,
          checkPausedRemainingSeconds: null,
          checkStatus: hasCheckTimer ? 'running' : null,
          isCheckCompleted: false,
          checkStaffName: hasCheckTimer ? (modalCheckStaffName || null) : null,
          checkProcess: hasCheckTimer ? sanitizeCheckProcess(modalCheckProcess) : 'チェック',
          checkAlerted: false,
          watchAlarmSoundEnabled: !!modalWatchAlarmSoundEnabled,
          alarmSoundEnabled: !!modalAlarmSoundEnabled,
          stoppedBy: null,
          mainStaffConfirmed: true,
          assistantStaffConfirmed: false,
          comment: modalComment !== undefined && modalComment.trim() !== '' ? modalComment.trim() : (s.comment || ''),
          history: [historyItem],
        };
      });
      saveSeatsToStorage(updated);
      syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });
      return updated;
    });
    if (targetSeatId) {
      setExpandedPausedSeatIds((prev) =>
        prev[targetSeatId] ? { ...prev, [targetSeatId]: false } : prev
      );
      oneMinuteHelpAlertRef.current[targetSeatId] = false;
      if (checkAlertedRef.current) {
        checkAlertedRef.current[targetSeatId] = false;
      }
      if (mainTimeupAlertedRef.current) {
        mainTimeupAlertedRef.current[targetSeatId] = false;
      }
    }
    setIsSetTimerModalVisible(false);
    setIsEditingExistingTimer(false);
    setTimerSetupMode('default');
  };

  // カード画面から直接メモを編集するモーダルを開く
  const handleOpenEditCommentModal = (seat) => {
    setCommentTargetSeat(seat);
    setEditCommentText(seat.comment || '');
    setIsEditCommentModalVisible(true);
  };

  // メモを確定保存
  const handleSaveComment = () => {
    if (!commentTargetSeat) return;
    const newComment = editCommentText.trim();
    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== commentTargetSeat.id) return s;
        return {
          ...s,
          comment: newComment,
        };
      });
      saveSeatsToStorage(updated);
      return updated;
    });
    setIsEditCommentModalVisible(false);
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 40]);
    }
  };

  // ヘルプ（アシスタント）柔軟指定・変更モーダルを開く
  const handleOpenHelpAssignModal = (seat) => {
    setHelpAssignTargetSeat(seat);
    setHelpInputStaffName('');
    // 既存の希望ヘルプがあればそれをセット、なければ未選択(null)にして「希望ヘルプ一覧」をまず選ばせる
    setSelectedHelpAction(seat.actionStatus || (seat.isShampooing ? 'shampoo' : null));
    setIsHelpAssignModalVisible(true);
  };

  // 希望するヘルプ内容（コーミング、シャンプー等）を選択（タップでスタッフ一覧を展開）
  const handleSelectHelpAction = (actionId) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSelectedHelpAction(actionId);
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 50]);
    }
    if (actionId) {
      setTimeout(() => {
        helpModalScrollViewRef.current?.scrollTo({ y: 150, animated: true });
      }, 80);
    }
  };

  // 1分前アラート等のクイック立候補から直接ヘルプを指定
  const handleAssignAssistantDirectly = (seatId, newHelpName) => {
    const targetHelp = (newHelpName || '自分').trim();
    oneMinuteHelpAlertRef.current[seatId] = false;
    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== seatId) return s;
        return {
          ...s,
          assistantStaffName: targetHelp,
          assistantStaffConfirmed: true,
          isRecruiting: false,
          isNoHelpNeeded: false,
        };
      });
      saveSeatsToStorage(updated);
      syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });
      return updated;
    });
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 150, 80, 150]);
    }
    Alert.alert(
      '🤝 ヘルプ参戦完了',
      `あなたがヘルプ担当として入りました。\nメイン担当者およびサロン全体へリアルタイム共有されました。`,
      [{ text: 'OK' }]
    );
  };

  // ヘルプ担当の指定（3名への通知共有付き ＆ 希望ヘルプ内容連動 ＆ ヘルプなし対応）
  const handleAssignAssistant = (newAssistantName, actionStatusOverride) => {
    if (!helpAssignTargetSeat) return;
    const seat = helpAssignTargetSeat;
    setIsHelpAssignModalVisible(false);

    const assigner = (userName || 'スタッフ').trim();
    const mainStaff = (seat.colorStaffName || '').trim();
    const newHelp = (newAssistantName || '').trim();
    const chosenAction = actionStatusOverride !== undefined ? actionStatusOverride : selectedHelpAction;
    const actionInfo = getActionStatusInfo(chosenAction, chosenAction === 'shampoo');
    const actionBadgeLabel = actionInfo ? `【${actionInfo.badge}】` : '';

    // 1分前アラートの再発動制御をリセット
    oneMinuteHelpAlertRef.current[seat.id] = false;

    // ★ ユーザー指定: 「ヘルプなし」を選択した場合
    if (newHelp === 'ヘルプなし') {
      setSeats((prev) => {
        const updated = prev.map((s) => {
          if (s.id !== seat.id) return s;
          return {
            ...s,
            assistantStaffName: 'ヘルプなし',
            assistantStaffConfirmed: true,
            actionStatus: null,
            helpProcess: '',
            isShampooing: false,
            isNoHelpNeeded: true,
            isRecruiting: false,
          };
        });
        saveSeatsToStorage(updated);
        syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });
        return updated;
      });
      if (Platform.OS !== 'web') {
        Vibration.vibrate([0, 80]);
      }
      Alert.alert(
        '👤 ヘルプなし設定完了',
        `「${seat.seatLabel}」はヘルプ担当なし（1人で施術・ワンマン）に設定されました。\n1分前ヘルプ未定アラートはスキップされます。`,
        [{ text: 'OK' }]
      );
      return;
    }

    // 席のヘルプ担当および希望ヘルプ内容（ステータス）を更新
    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== seat.id) return s;
        const resolvedAction = chosenAction || s.actionStatus || null;
        const resolvedInfo = getActionStatusInfo(resolvedAction, resolvedAction === 'shampoo');
        const resolvedHelpLabel = resolvedInfo ? resolvedInfo.label : (s.helpProcess || '');
        return {
          ...s,
          assistantStaffName: newHelp || null,
          actionStatus: resolvedAction,
          helpProcess: resolvedHelpLabel,
          isShampooing: s.status !== 'running' && (resolvedAction === 'shampoo' || (resolvedAction ? false : s.isShampooing)),
          isNoHelpNeeded: false,
          isRecruiting: false,
          // もし本人が入った場合はアシスタント確認フラグをONに
          assistantStaffConfirmed:
            isStaffNameMe(newHelp, userName, myUserId, staffMembers)
              ? true
              : s.assistantStaffConfirmed,
        };
      });
      saveSeatsToStorage(updated);
      syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });
      return updated;
    });

    // 触覚振動
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 150, 80, 150]);
    }

    if (!newHelp) {
      // ヘルプ解除の場合
      Alert.alert(
        '🤝 ヘルプ解除',
        `「${seat.seatLabel}」のヘルプ担当が未定（立候補待ち）に更新されました。\n※放置終了1分前に未定の場合はサロン全員へアラートが届きます。`,
        [{ text: 'OK' }]
      );
      return;
    }

    const isAssignerMain = isMainStaffOfSeat(seat, userName, myUserId, staffMembers);
    const isAssignerNewHelp = isStaffNameMe(newHelp, userName, myUserId, staffMembers);
    const isThirdParty = !isAssignerMain && !isAssignerNewHelp;

    if (isThirdParty) {
      // 第3者が指定した場合 -> メイン担当 ＋ ヘルプ担当 ＋ 指定した人 の3名に通知！
      Alert.alert(
        '🤝 ヘルプ指定完了 (関係者3名へ通知共有)',
        `「${seat.seatLabel}」の${actionBadgeLabel}ヘルプ担当が、【${assigner}】さんにより【${newHelp}】さんに指定されました。\n\n【3名へリアルタイム通知完了】\n・🎨 ${mainStaff || 'メイン担当'}\n・🤝 ${newHelp}（指定されたヘルプ）\n・👤 ${assigner}（指定した人）\n\n関係者3名の端末およびApple Watchに通知が届きました。`,
        [{ text: 'OK' }]
      );
    } else if (isAssignerMain) {
      // メイン担当本人が指定した場合 -> メイン ＋ 指定されたヘルプ の2名に通知
      Alert.alert(
        '🤝 ヘルプ指名通知',
        `「${seat.seatLabel}」の${actionBadgeLabel}ヘルプ担当に【${newHelp}】さんを指名しました。\n\n【お互いへの通知完了】\n・🎨 自分（メイン担当）\n・🤝 ${newHelp}（指定されたヘルプ）\n\n両者の端末およびApple Watchに通知が届きました。`,
        [{ text: 'OK' }]
      );
    } else {
      // 本人が立候補した場合
      Alert.alert(
        '🤝 ヘルプ参戦通知',
        `「${seat.seatLabel}」の${actionBadgeLabel}ヘルプ担当に【自分】が入りました。\n\n【お互いへの通知完了】\n・🎨 ${mainStaff || 'メイン担当'}\n・🤝 自分（ヘルプ担当）\n\n両者の端末およびApple Watchに通知が届きました。`,
        [{ text: 'OK' }]
      );
    }
  };

  // 停止席のアコーディオン開閉トグル
  const handleToggleExpandPausedSeat = (seatId) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedPausedSeatIds((prev) => ({
      ...prev,
      [seatId]: !prev[seatId],
    }));
  };

  // ★ ユーザー指定: チェック担当スタッフ指定モーダルを開く
  const handleOpenCheckStaffModal = (seat) => {
    setCheckStaffTargetSeat(seat);
    setInputCheckStaffName(seat.checkStaffName || '');
    setIsCheckStaffModalVisible(true);
  };

  // ★ ユーザー指定: チェック担当スタッフを指定・保存
  const handleAssignCheckStaff = (seatId, staffName) => {
    const trimmed = (staffName || '').trim();
    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== seatId) return s;
        return {
          ...s,
          checkStaffName: trimmed || null,
          checkProcess: sanitizeCheckProcess(s.checkProcess),
        };
      });
      saveSeatsToStorage(updated);
      syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });
      return updated;
    });
    setIsCheckStaffModalVisible(false);
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 80]);
    }
  };

  // ★ チェックタイマー（中間タイマー）の工程（4種・シャンプー完全除外）を変更・保存
  const handleSelectCheckProcess = (seatId, nextProcess) => {
    if (!seatId) return;
    const sanitized = sanitizeCheckProcess(nextProcess);
    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== seatId) return s;
        return {
          ...s,
          checkProcess: sanitized,
        };
      });
      saveSeatsToStorage(updated);
      syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });
      return updated;
    });
    setCheckStaffTargetSeat((prev) => (prev && prev.id === seatId ? { ...prev, checkProcess: sanitized } : prev));
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 40]);
    }
  };

  // 施術工程・ステータス選択モーダルを開く
  const handleOpenActionStatusModal = (seat) => {
    setActionStatusTargetSeat(seat);
    setIsActionStatusModalVisible(true);
  };

  // 施術工程・ステータスを選択・更新
  const handleSelectActionStatus = (statusId) => {
    if (!actionStatusTargetSeat) return;
    const seat = actionStatusTargetSeat;
    setIsActionStatusModalVisible(false);

    const isShampoo = statusId === 'shampoo';
    const actionInfo = getActionStatusInfo(statusId, isShampoo);
    const nextHelpProcess = actionInfo ? actionInfo.label : '';
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (seat.status === 'paused') {
      // ★ 停止中スリムバー上でステータスを変更しても勝手にカードが開かないよう折りたたみ状態を維持
      setExpandedPausedSeatIds((prev) => ({ ...prev, [seat.id]: false }));
    }

    setSeats((prev) => {
      const currentUser = (userName || 'スタッフ').trim();
      const updated = prev.map((s) => {
        if (s.id !== seat.id) return s;
        const existingAssist = (s.assistantStaffName || '').trim();
        const shouldFillOperator =
          !!statusId &&
          s.status !== 'running' &&
          (!existingAssist || existingAssist === '未定' || existingAssist === '募集中' || existingAssist === 'ヘルプなし' || existingAssist === 'none');
        const nextIsShampooing = s.status !== 'running' && isShampoo;
        return {
          ...s,
          actionStatus: statusId || null,
          helpProcess: nextHelpProcess,
          isShampooing: nextIsShampooing,
          ...(s.status !== 'running' || nextIsShampooing ? { history: [] } : {}),
          ...(shouldFillOperator
            ? {
                assistantStaffName: currentUser,
                isRecruiting: false,
                isNoHelpNeeded: false,
              }
            : {}),
        };
      });
      saveSeatsToStorage(updated);
      syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });
      return updated;
    });

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 80]);
    }
  };

  // 停止 / 再開（大元タイマー停止時は00:00リセット＆チェック解除＆カード折りたたみに統一）
  const handleTogglePause = (seatId) => {
    const seat = seats.find((s) => s.id === seatId);
    if (!seat) return;
    const isStopping = seat.status === 'running';
    if (!isStopping && (seat.status === 'idle' || seat.isReset || (seat.pausedRemainingSeconds ?? 0) <= 0)) {
      handleOpenSetTimerModal(seat);
      return;
    }
    const currentUser = (userName || 'スタッフ').trim();

    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (isStopping) {
      stopAlarm('salon', `${seatId}-main`);
      stopAlarm('salon', `${seatId}-check`);
      WatchConnectivity.notifyLocalStopOrReset(seatId, seat.targetEndTimestamp || 0);
      if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[seatId] = false;
      if (checkAlertedRef.current) checkAlertedRef.current[seatId] = false;
      if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[seatId] = false;
      if (escalatedAlertRef.current) escalatedAlertRef.current[seatId] = false;
      setExpandedPausedSeatIds((prev) => ({ ...prev, [seatId]: false }));
    }

    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== seatId) return s;
        if (s.status === 'running') {
          return {
            ...s,
            status: 'paused',
            pausedRemainingSeconds: 0,
            targetSeconds: 0,
            initialMinutes: 0,
            targetEndTimestamp: null,
            isOver: false,
            isReset: true,
            timeUpTimestamp: null,
            escalationLevel: 0,
            collapsedAtEnd: Date.now(),
            lastStoppedAt: Date.now(),
            lastStoppedTargetEndTimestamp: Number(s.targetEndTimestamp) || Number(s.lastStoppedTargetEndTimestamp) || 0,
            mainStaffConfirmed: true,
            assistantStaffConfirmed: true,
            stoppedBy: currentUser,
            assistantStaffName: '',
            actionStatus: null,
            isShampooing: false,
            helpProcess: null,
            isRecruiting: false,
            isNoHelpNeeded: false,
            checkTargetSeconds: null,
            checkTotalSeconds: null,
            checkEndTimestamp: null,
            checkPausedRemainingSeconds: null,
            checkInitialMinutes: null,
            checkStaffName: '',
            checkProcess: 'チェック',
            checkStatus: 'stopped',
            isCheckCompleted: false,
            checkAlerted: false,
            history: [],
          };
        } else {
          const endTs = Date.now() + (s.pausedRemainingSeconds || 0) * 1000;
          let checkEndTs = s.checkEndTimestamp;
          if (s.checkTargetSeconds > 0 && (s.checkStatus === 'running' || s.checkStatus === 'timeup') && s.checkPausedRemainingSeconds !== null) {
            checkEndTs = Date.now() + s.checkPausedRemainingSeconds * 1000;
          }
          return {
            ...s,
            status: 'running',
            targetEndTimestamp: endTs,
            lastStoppedAt: 0,
            lastStoppedTargetEndTimestamp: 0,
            checkEndTimestamp: checkEndTs,
            checkPausedRemainingSeconds: null,
            stoppedBy: null,
          };
        }
      });
      saveSeatsToStorage(updated);
      syncSeatsToWatch(updated, userName, staffMembers, { immediate: true, highPriorityWake: isStopping });
      return updated;
    });

    if (isStopping) {
      if (Platform.OS !== 'web') {
        Vibration.vibrate([0, 200, 100, 200]);
      }
      const mainStaff = (seat.colorStaffName || '').trim();
      const assistStaff = (seat.assistantStaffName || '').trim();
      const isMain = isMainStaffOfSeat(seat, userName, myUserId, staffMembers);
      const isAssist = isStaffNameMe(assistStaff, userName, myUserId, staffMembers);
      const isThirdParty = !isMain && !isAssist;

      if (isThirdParty) {
        Alert.alert(
          '🔔 第3者によるタイマー停止通知 (3名共有)',
          `「${seat.seatLabel}」のタイマーを【${currentUser}】（第3者）さんが停止しました。\n\n【関係者3名へリアルタイム通知完了】\n・🎨 ${mainStaff || 'メイン担当'}\n・🤝 ${assistStaff || 'ヘルプ担当'}\n・👤 ${currentUser}（停止操作者）\n\n関係者3名全員の端末およびApple Watchに通知が届きました。`,
          [{ text: 'OK' }]
        );
      } else {
        Alert.alert(
          '🔔 タイマー停止・確認通知',
          `「${seat.seatLabel}」のタイマーを停止しました。\n\n【お互いへの確認通知】\n・🎨 ${mainStaff || 'メイン担当'} に通知\n・🤝 ${assistStaff || 'ヘルプ担当'} に通知\n\n両者の端末およびApple Watchに通知が届きました。`,
          [{ text: 'OK' }]
        );
      }
    }
  };

  // ★ 大元タイマーの「リセット」: 大元・チェックタイマー両方を00:00にリセットし、席カードを折りたたみ、自分以外の関係者へ通知（iPhone/Watch完全統一）
  const handleConfirmResetSeatTimer = (seat) => {
    Alert.alert(
      'タイマーをリセットしますか？',
      `「${seat.seatLabel}」のタイマーとチェックタイマーを00:00に戻し、席カードを閉じます。`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: 'リセットする',
          style: 'destructive',
          onPress: () => handleExecuteResetSeatTimer(seat.id),
        },
      ]
    );
  };

  const handleExecuteResetSeatTimer = (seatId) => {
    const seat = seats.find((s) => s.id === seatId);
    if (!seat) return;
    stopAlarm('salon', `${seatId}-main`);
    stopAlarm('salon', `${seatId}-check`);
    WatchConnectivity.notifyLocalStopOrReset(seatId, seat.targetEndTimestamp || 0);

    const currentUser = (userName || 'スタッフ').trim();

    // ★ 席カードを折りたたむ（スリムバー状態）
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedPausedSeatIds((prev) => ({ ...prev, [seatId]: false }));

    const updatedSeats = seats.map((s) => {
      if (s.id !== seatId) return s;
      return {
        ...s,
        status: 'paused',
        targetEndTimestamp: null,
        lastStoppedAt: Date.now(),
        lastStoppedTargetEndTimestamp: Number(s.targetEndTimestamp) || Number(s.lastStoppedTargetEndTimestamp) || 0,
        pausedRemainingSeconds: 0,
        initialMinutes: 0,
        targetSeconds: 0,
        isOver: false,
        isReset: true,
        timeUpTimestamp: null,
        escalationLevel: 0,
        collapsedAtEnd: Date.now(),
        // ★ 00:00席のヘルプ・助手・希望プロセスを完全解除（固定残り防止）
        assistantStaffName: '',
        assistantStaffConfirmed: false,
        actionStatus: null,
        isShampooing: false,
        helpProcess: null,
        isRecruiting: false,
        isNoHelpNeeded: false,
        // ★ チェックタイマーも完全解除
        checkTargetSeconds: null,
        checkTotalSeconds: null,
        checkEndTimestamp: null,
        checkPausedRemainingSeconds: null,
        checkStatus: 'stopped',
        isCheckCompleted: false,
        checkInitialMinutes: null,
        checkStaffName: '',
        checkProcess: 'チェック',
        checkAlerted: false,
        watchAlarmSoundEnabled: false,
        alarmSoundEnabled: false,
        // 停止・確認情報
        stoppedBy: currentUser,
        mainStaffConfirmed: true,
        assistantStaffConfirmed: true,
        history: [],
      };
    });
    setSeats(updatedSeats);
    saveSeatsToStorage(updatedSeats);
    syncSeatsToWatch(updatedSeats, userName, staffMembers, { immediate: true, highPriorityWake: true });

    if (mainTimeupAlertedRef.current) {
      mainTimeupAlertedRef.current[seatId] = false;
    }
    if (checkAlertedRef.current) {
      checkAlertedRef.current[seatId] = false;
    }
    if (oneMinuteHelpAlertRef.current) {
      oneMinuteHelpAlertRef.current[seatId] = false;
    }
    if (escalatedAlertRef.current) {
      escalatedAlertRef.current[seatId] = false;
    }

    // 触覚振動
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 150, 100, 150]);
    }

    // ★ 自分以外の関係者には通知する
    const mainStaff = (seat.colorStaffName || '').trim();
    const assistStaff = (seat.assistantStaffName || '').trim();
    const checkStaff = (seat.checkStaffName || '').trim();
    const isMainMe = isMainStaffOfSeat(seat, userName, myUserId, staffMembers);

    const otherRecipients = [];
    if ((mainStaff || seat.createdBy) && !isMainMe) {
      otherRecipients.push(`・🎨 メイン担当: ${mainStaff || 'タイマー作成者'}`);
    }
    if (
      assistStaff &&
      assistStaff !== 'ヘルプなし' &&
      assistStaff !== 'none' &&
      !isStaffNameMe(assistStaff, userName, myUserId, staffMembers) &&
      !otherRecipients.some((r) => r.includes(assistStaff))
    ) {
      otherRecipients.push(`・🤝 ヘルプ担当: ${assistStaff}`);
    }
    if (
      checkStaff &&
      checkStaff !== '未定' &&
      !isStaffNameMe(checkStaff, userName, myUserId, staffMembers) &&
      !otherRecipients.some((r) => r.includes(checkStaff))
    ) {
      otherRecipients.push(`・🔍 チェック担当: ${checkStaff}`);
    }

    if (otherRecipients.length > 0) {
      Alert.alert(
        '🔔 タイマーリセット通知 (関係者共有)',
        `「${seat.seatLabel}」のタイマーを【${currentUser}】さんがリセットしました（タイム00:00・チェック解除・カード折りたたみ）。\n\n【自分以外の関係者へリアルタイム通知完了】\n${otherRecipients.join('\n')}\n\n関係者全員の端末およびApple Watchに通知が届きました。`,
        [{ text: 'OK' }]
      );
    } else {
      Alert.alert(
        '🔄 タイマーをリセットしました',
        `「${seat.seatLabel}」のタイマーとチェックタイマーを00:00に戻し、カードを閉じました。\n\nスリムバーをタップするとすぐに新しいタイムを入れ直せます。`,
        [{ text: 'OK' }]
      );
    }
  };

  // ＋5分延長（互換性保持）
  const handleExtend5Min = (seatId) => {
    const nowStr = getCurrentTimeFormatted();
    const now = Date.now();
    stopAlarm('salon', `${seatId}-main`);
    if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[seatId] = false;
    if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[seatId] = false;
    if (escalatedAlertRef.current) escalatedAlertRef.current[seatId] = false;
    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== seatId) return s;
        const historyItem = {
          id: `h-${Date.now()}`,
          time: nowStr,
          text: '5分追加放置',
          type: 'extend',
        };
        const prevHist = s.history || [];
        const baseEnd = Math.max(now, Number(s.targetEndTimestamp) || now);
        const nextTargetSec = (s.targetSeconds || 0) + 5 * 60;
        return {
          ...s,
          status: 'running',
          targetSeconds: nextTargetSec,
          initialMinutes: Math.max(1, Math.round(nextTargetSec / 60)),
          targetEndTimestamp: baseEnd + 5 * 60 * 1000,
          isOver: false,
          timeUpTimestamp: null,
          escalationLevel: 0,
          history: [...prevHist, historyItem],
        };
      });
      saveSeatsToStorage(updated);
      return updated;
    });
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 60]);
    }
  };

  // ★ ユーザー指定: クイックタイム変更モーダルを開く
  const handleOpenQuickTimeAdjustModal = (seat) => {
    setQuickAdjustTargetSeat(seat);
    setQuickAdjustDeltaSeconds(0);
    setIsQuickAdjustModalVisible(true);
    if (Platform.OS !== 'web') {
      Vibration.vibrate(20);
    }
  };

  // クイック加算・微調整ハンドラー (+30秒, +1分, +3分, +5分, ±30秒)
  const handleAddQuickAdjustDelta = (seconds) => {
    setQuickAdjustDeltaSeconds((prev) => prev + seconds);
    if (Platform.OS !== 'web') {
      Vibration.vibrate(25);
    }
  };

  // クイックタイム変更プレビュー計算
  const getQuickAdjustPreview = () => {
    if (!quickAdjustTargetSeat) {
      return { currentStr: '0:00', nextStr: '0:00', deltaStr: '±0秒', isOver: false };
    }
    const now = Date.now();
    let currentRemainingSec = 0;
    let isCurrentOver = false;

    if (quickAdjustTargetSeat.status === 'paused' || quickAdjustTargetSeat.isPaused) {
      currentRemainingSec = quickAdjustTargetSeat.pausedRemainingSeconds || 0;
    } else if (quickAdjustTargetSeat.targetEndTimestamp) {
      const diffSec = Math.floor((quickAdjustTargetSeat.targetEndTimestamp - now) / 1000);
      if (diffSec < 0) {
        isCurrentOver = true;
        currentRemainingSec = Math.abs(diffSec);
      } else {
        currentRemainingSec = diffSec;
      }
    }

    const cM = Math.floor(currentRemainingSec / 60);
    const cS = currentRemainingSec % 60;
    const currentStr = `${isCurrentOver ? '+' : ''}${cM}:${cS < 10 ? '0' : ''}${cS}`;

    let nextSec = 0;
    let nextIsOver = false;
    if (isCurrentOver) {
      if (quickAdjustDeltaSeconds === 0) {
        nextSec = currentRemainingSec;
        nextIsOver = true;
      } else {
        nextSec = Math.max(0, quickAdjustDeltaSeconds);
        nextIsOver = false;
      }
    } else {
      const calcSec = currentRemainingSec + quickAdjustDeltaSeconds;
      nextSec = Math.max(0, calcSec);
    }
    const nM = Math.floor(nextSec / 60);
    const nS = nextSec % 60;
    const nextStr = `${nextIsOver ? '+' : ''}${nM}:${nS < 10 ? '0' : ''}${nS}`;

    const absD = Math.abs(quickAdjustDeltaSeconds);
    const dM = Math.floor(absD / 60);
    const dS = absD % 60;
    let deltaStr = '';
    if (dM > 0 && dS > 0) {
      deltaStr = `${quickAdjustDeltaSeconds > 0 ? '+' : '-'}${dM}分${dS}秒`;
    } else if (dM > 0) {
      deltaStr = `${quickAdjustDeltaSeconds > 0 ? '+' : '-'}${dM}分`;
    } else if (dS > 0) {
      deltaStr = `${quickAdjustDeltaSeconds > 0 ? '+' : '-'}${dS}秒`;
    } else {
      deltaStr = '±0秒';
    }

    return { currentStr, nextStr, deltaStr, isOver: isCurrentOver };
  };

  // クイックタイム変更の確定適用
  const handleConfirmQuickTimeAdjust = () => {
    if (!quickAdjustTargetSeat) return;
    const seatId = quickAdjustTargetSeat.id;
    const deltaSec = quickAdjustDeltaSeconds;
    if (deltaSec === 0) {
      setIsQuickAdjustModalVisible(false);
      return;
    }

    const now = Date.now();
    const nowStr = getCurrentTimeFormatted();

    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== seatId) return s;

        let newTargetEnd = s.targetEndTimestamp;
        let newPausedRemaining = s.pausedRemainingSeconds;
        let newStatus = s.status;
        let nextTargetSeconds = s.targetSeconds || 0;
        const isPausedState = s.status === 'paused' || s.isPaused;

        if (isPausedState) {
          const baseRemaining = s.pausedRemainingSeconds || 0;
          const totalRemaining = Math.max(0, baseRemaining + deltaSec);
          if (totalRemaining > 0) {
            newTargetEnd = now + totalRemaining * 1000;
            newPausedRemaining = null;
            newStatus = 'running';
            nextTargetSeconds = Math.max(totalRemaining, (s.targetSeconds || 0) + deltaSec);
          } else {
            newPausedRemaining = 0;
          }
        } else {
          const currentDiffSec = Math.floor((s.targetEndTimestamp - now) / 1000);
          if (currentDiffSec < 0) {
            newTargetEnd = now + Math.max(0, deltaSec) * 1000;
          } else {
            newTargetEnd = Math.max(now, s.targetEndTimestamp + deltaSec * 1000);
          }
          nextTargetSeconds = Math.max(10, (s.targetSeconds || 0) + deltaSec);
        }

        if (newStatus === 'running' && newTargetEnd && newTargetEnd > now) {
          stopAlarm('salon', `${s.id}-main`);
          if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[s.id] = false;
          if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[s.id] = false;
          if (escalatedAlertRef.current) escalatedAlertRef.current[s.id] = false;
        }

        const absDelta = Math.abs(deltaSec);
        const dm = Math.floor(absDelta / 60);
        const ds = absDelta % 60;
        let deltaText = '';
        if (dm > 0 && ds > 0) {
          deltaText = `${dm}分${ds}秒`;
        } else if (dm > 0) {
          deltaText = `${dm}分`;
        } else {
          deltaText = `${ds}秒`;
        }
        const historyText = deltaSec > 0 ? `${deltaText}追加放置` : `${deltaText}短縮`;

        const historyItem = {
          id: `h-${Date.now()}`,
          time: nowStr,
          text: historyText,
          type: 'extend',
        };
        const prevHist = shouldRetainSeatHistory(s) ? (s.history || []) : [];
        const nextHistory = newStatus === 'running' && !s.isShampooing ? [...prevHist, historyItem] : [];

        return {
          ...s,
          status: newStatus,
          targetSeconds: nextTargetSeconds,
          initialMinutes: nextTargetSeconds > 0 ? Math.max(1, Math.round(nextTargetSeconds / 60)) : 0,
          targetEndTimestamp: newTargetEnd,
          ...(newStatus === 'running' ? { lastStoppedAt: 0, lastStoppedTargetEndTimestamp: 0 } : {}),
          pausedRemainingSeconds: newPausedRemaining,
          isReset: false,
          isOver: false,
          timeUpTimestamp: null,
          escalationLevel: 0,
          collapsedAtEnd: null,
          history: nextHistory,
        };
      });
      saveSeatsToStorage(updated);
      return updated;
    });

    setIsQuickAdjustModalVisible(false);
    setQuickAdjustDeltaSeconds(0);
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 70]);
    }
  };

  // 施術履歴手動追加モーダルを開く
  const handleOpenAddHistoryModal = (seat) => {
    setAddHistoryTargetSeat(seat);
    setInputHistoryText('');
    setIsAddHistoryModalVisible(true);
  };

  // 施術履歴の手動確定追加
  const handleConfirmAddHistory = (customText) => {
    const targetText = (customText || inputHistoryText || '').trim();
    if (!targetText || !addHistoryTargetSeat) return;

    const nowStr = getCurrentTimeFormatted();
    const historyItem = {
      id: `h-${Date.now()}`,
      time: nowStr,
      text: targetText,
      type: 'action',
    };

    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== addHistoryTargetSeat.id) return s;
        if (!shouldRetainSeatHistory(s)) return { ...s, history: [] };
        const prevHist = s.history || [];
        return {
          ...s,
          history: [...prevHist, historyItem],
        };
      });
      saveSeatsToStorage(updated);
      return updated;
    });

    setIsAddHistoryModalVisible(false);
    setInputHistoryText('');
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 50]);
    }
  };

  // 施術終了（固定席なら待機中スリムバーに戻し、フリータイマーかつオーナーならボードから削除）
  const handleFinishSeat = (seatId) => {
    const targetSeat = seats.find((s) => s.id === seatId);
    const isFree = !!(targetSeat?.isFreeTimer && isSalonOwnerRef.current);

    Alert.alert(
      '施術終了の確認',
      isFree
        ? 'このタイマーを終了し、サロンボードから完了削除しますか？'
        : 'この席の施術を終了し、空席（待機中）に戻しますか？',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: isFree ? '終了して削除' : '終了して空席に戻す',
          style: isFree ? 'destructive' : 'default',
          onPress: async () => {
            stopAlarm('salon', `${seatId}-main`);
            stopAlarm('salon', `${seatId}-check`);
            WatchConnectivity.notifyLocalStopOrReset(seatId, targetSeat?.targetEndTimestamp || 0);
            if (isFree) {
              const storageSalonId = getActiveStorageSalonId();
              await enqueuePendingDeletedSeat(storageSalonId, targetSeat);
              setSeats((prev) => {
                const updated = prev.filter((s) => s.id !== seatId);
                saveSeatsToStorage(updated);
                syncSeatsToWatch(updated, userName, staffMembers, { immediate: true, highPriorityWake: true, forceEmpty: updated.length === 0 });
                return updated;
              });
              const targetSalonId =
                cloudSalonIdRef.current ||
                (currentSalon?.id && currentSalon.id !== 'workspace-free' && currentSalon.id !== 'workspace-pro-demo'
                  ? currentSalon.id
                  : null);
              if (targetSalonId) {
                const ok = await deleteCloudTimer(targetSalonId, targetSeat?.cloudTimerId || seatId, targetSeat?.seatLabel);
                if (ok) {
                  await removePendingDeletedSeat(targetSalonId, targetSeat?.cloudTimerId || seatId, targetSeat?.seatLabel);
                }
              }
            } else {
              setExpandedPausedSeatIds((prevExp) =>
                prevExp[seatId] ? { ...prevExp, [seatId]: false } : prevExp
              );
              setSeats((prev) => {
                const updated = prev.map((s) => {
                  if (s.id !== seatId) return s;
                  return {
                    ...s,
                    status: 'idle',
                    pausedRemainingSeconds: 0,
                    isOver: false,
                    isReset: true,
                    timeUpTimestamp: null,
                    escalationLevel: 0,
                    colorStaffName: '',
                    createdBy: null,
                    dirtySync: true,
                    assistantStaffName: null,
                    actionStatus: null,
                    helpProcess: null,
                    isRecruiting: false,
                    isNoHelpNeeded: false,
                    isShampooing: false,
                    targetSeconds: 0,
                    targetEndTimestamp: 0,
                    lastStoppedAt: Date.now(),
                    lastStoppedTargetEndTimestamp: Number(s.targetEndTimestamp) || Number(s.lastStoppedTargetEndTimestamp) || 0,
                    checkTargetSeconds: null,
                    checkTotalSeconds: null,
                    checkInitialMinutes: null,
                    checkEndTimestamp: null,
                    checkPausedRemainingSeconds: null,
                    checkStatus: null,
                    isCheckCompleted: false,
                    checkStaffName: null,
                    checkProcess: 'チェック',
                    checkAlerted: false,
                    watchAlarmSoundEnabled: false,
                    alarmSoundEnabled: false,
                    collapsedAtEnd: Date.now(),
                    comment: '',
                    history: [],
                  };
                });
                saveSeatsToStorage(updated);
                syncSeatsToWatch(updated, userName, staffMembers, { immediate: true, highPriorityWake: true });
                return updated;
              });
            }
          },
        },
      ]
    );
  };

  // 待機席の削除（オーナー専用：席マスターから削除＆オフライン削除キュー記録）
  const handleDeleteSeat = (seatId, seatLabel) => {
    if (!isSalonOwnerRef.current) return;
    const targetSeatObj = seats.find((s) => s.id === seatId) || { id: seatId, seatLabel };
    Alert.alert(
      '席の削除確認',
      `「${seatLabel}」をサロンボードから削除しますか？`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除する',
          style: 'destructive',
          onPress: async () => {
            if (!isSalonOwnerRef.current) return;
            stopAlarm('salon', `${seatId}-main`);
            stopAlarm('salon', `${seatId}-check`);
            WatchConnectivity.notifyLocalStopOrReset(seatId, targetSeatObj?.targetEndTimestamp || 0);
            const storageSalonId = getActiveStorageSalonId();
            await enqueuePendingDeletedSeat(storageSalonId, targetSeatObj);
            setSeats((prev) => {
              const updated = prev.filter((s) => s.id !== seatId);
              saveSeatsToStorage(updated);
              syncSeatsToWatch(updated, userName, staffMembers, { immediate: true, highPriorityWake: true, forceEmpty: updated.length === 0 });
              return updated;
            });
            const targetSalonId =
              cloudSalonIdRef.current ||
              (currentSalon?.id && currentSalon.id !== 'workspace-free' && currentSalon.id !== 'workspace-pro-demo'
                ? currentSalon.id
                : null);
            if (targetSalonId) {
              const delKey = targetSeatObj.cloudTimerId || seatId;
              const ok = await deleteCloudTimer(targetSalonId, delKey, seatLabel);
              if (ok) {
                await removePendingDeletedSeat(targetSalonId, delKey, seatLabel);
              }
            }
          },
        },
      ]
    );
  };

  const getNextSuggestedSeatNumber = (seatList = seats) =>
    (Array.isArray(seatList) ? seatList : []).reduce((maxN, s, idx) => {
      const m = String(s?.seatLabel || '').match(/\d+/);
      const n = Number(s?.seatNumber) || (m ? parseInt(m[0], 10) : idx + 1);
      return Math.max(maxN, n);
    }, 0) + 1;

  // 新規固定席の追加（オーナー専用：席マスターを増やす）
  const handleAddNewSeatMaster = () => {
    if (!isSalonOwnerRef.current) {
      setIsAddSeatModalVisible(false);
      return;
    }
    const nextSuggestedNum = getNextSuggestedSeatNumber(seats);
    const trimmedInput = newSeatName.trim();
    const inputNumMatch = trimmedInput.match(/\d+/);
    const seatNumber = inputNumMatch ? parseInt(inputNumMatch[0], 10) : nextSuggestedNum;
    const label = trimmedInput || `${seatNumber}番席`;
    const newSeat = {
      id: `seat-${Date.now()}`,
      seatNumber: seatNumber,
      seatLabel: label,
      name: label,
      status: 'idle',
      colorStaffName: '',
      createdBy: null,
      dirtySync: true,
      assistantStaffName: null,
      actionStatus: null,
      helpProcess: null,
      isRecruiting: false,
      isNoHelpNeeded: false,
      isShampooing: false,
      targetSeconds: 0,
      pausedRemainingSeconds: 0,
      targetEndTimestamp: 0,
      checkProcess: 'チェック',
      watchAlarmSoundEnabled: false,
      alarmSoundEnabled: false,
      comment: '',
      history: [],
    };
    setSeats((prev) => {
      const updated = [...prev, newSeat];
      saveSeatsToStorage(updated);
      syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });
      return updated;
    });
    setNewSeatName('');
    setIsAddSeatModalVisible(false);
  };

  // メインタイマーを空席にアサイン
  const handleAssignMainTimerToSeat = (seatId) => {
    const target = mainTimerState?.targetTime || 180;
    const remaining = (!mainTimerState?.isCountUp && mainTimerState?.remainingTime > 0)
      ? mainTimerState.remainingTime
      : target;
    const endTs = Date.now() + remaining * 1000;

    setSeats((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== seatId) return s;
        return {
          ...s,
          status: 'running',
          colorStaffName: userName || 'スタイリスト',
          createdBy: myUserIdRef.current || myUserId || null,
          dirtySync: true,
          assistantStaffName: '',
          actionStatus: null,
          helpProcess: '',
          isShampooing: false,
          isRecruiting: false,
          isNoHelpNeeded: false,
          targetSeconds: target,
          initialMinutes: Math.max(1, Math.round(target / 60)),
          targetEndTimestamp: endTs,
          pausedRemainingSeconds: null,
          isReset: false,
          isOver: false,
          timeUpTimestamp: null,
          escalationLevel: 0,
          collapsedAtEnd: null,
          checkTargetSeconds: null,
          checkTotalSeconds: null,
          checkEndTimestamp: null,
          checkPausedRemainingSeconds: null,
          checkInitialMinutes: null,
          checkStaffName: '',
          checkProcess: 'チェック',
          checkStatus: 'stopped',
          isCheckCompleted: false,
          checkAlerted: false,
          comment: mainTimerState?.genre ? `ジャンル: ${mainTimerState.genre}` : '',
          history: [
            {
              id: `h-${Date.now()}`,
              time: getCurrentTimeFormatted(),
              text: `メインタイマー連動セット (${Math.max(1, Math.round(target / 60))}分)`,
              type: 'timer',
            },
          ],
        };
      });
      saveSeatsToStorage(updated);
      syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });
      return updated;
    });
    if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[seatId] = false;
    if (checkAlertedRef.current) checkAlertedRef.current[seatId] = false;
    if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[seatId] = false;
    if (escalatedAlertRef.current) escalatedAlertRef.current[seatId] = false;
    setIsAssignMainTimerModalVisible(false);
    Alert.alert('割り当て完了', `メインタイマーを「${seats.find((s) => s.id === seatId)?.seatLabel}」にセットしました！`);
  };

  // メインタイマーを席に割り当てずにセット（オーナー専用：席指定なし・フリータイマーとしてサロンボードに追加）
  const handleAssignMainTimerWithoutSeat = () => {
    if (!isSalonOwnerRef.current) {
      setIsAssignMainTimerModalVisible(false);
      return;
    }
    const target = mainTimerState?.targetTime || 180;
    const remaining = (!mainTimerState?.isCountUp && mainTimerState?.remainingTime > 0)
      ? mainTimerState.remainingTime
      : target;
    const endTs = Date.now() + remaining * 1000;
    const genreText = mainTimerState?.genre ? ` (${mainTimerState.genre})` : '';
    const freeId = `free-${Date.now()}`;
    const freeLabel = `フリー${genreText || '枠'}`;
    const nextSeatNum = getNextSuggestedSeatNumber(seats);
    const initialMins = Math.max(1, Math.round(target / 60));

    const freeSeatItem = {
      id: freeId,
      seatNumber: nextSeatNum,
      seatLabel: freeLabel,
      name: freeLabel,
      isFreeTimer: true, // 席マスター外のフリータイマーフラグ
      status: 'running',
      colorStaffName: userName || 'スタイリスト',
      createdBy: myUserIdRef.current || myUserId || null,
      dirtySync: true,
      assistantStaffName: '',
      actionStatus: null,
      helpProcess: '',
      isShampooing: false,
      isRecruiting: false,
      isNoHelpNeeded: false,
      targetSeconds: target,
      initialMinutes: initialMins,
      targetEndTimestamp: endTs,
      pausedRemainingSeconds: null,
      isReset: false,
      isOver: false,
      timeUpTimestamp: null,
      escalationLevel: 0,
      collapsedAtEnd: null,
      checkTargetSeconds: null,
      checkTotalSeconds: null,
      checkEndTimestamp: null,
      checkPausedRemainingSeconds: null,
      checkInitialMinutes: null,
      checkStaffName: '',
      checkProcess: 'チェック',
      checkStatus: 'stopped',
      isCheckCompleted: false,
      checkAlerted: false,
      watchAlarmSoundEnabled: false,
      alarmSoundEnabled: false,
      mainStaffConfirmed: true,
      assistantStaffConfirmed: false,
      comment: mainTimerState?.genre ? `ジャンル: ${mainTimerState.genre}` : 'メインタイマー連動 (席指定なし)',
      history: [
        {
          id: `h-${Date.now()}`,
          time: getCurrentTimeFormatted(),
          text: `メインタイマー連動セット (${initialMins}分)`,
          type: 'timer',
        },
      ],
    };

    if (mainTimeupAlertedRef.current) mainTimeupAlertedRef.current[freeId] = false;
    if (checkAlertedRef.current) checkAlertedRef.current[freeId] = false;
    if (oneMinuteHelpAlertRef.current) oneMinuteHelpAlertRef.current[freeId] = false;
    if (escalatedAlertRef.current) escalatedAlertRef.current[freeId] = false;

    setSeats((prev) => {
      const updated = [freeSeatItem, ...prev];
      saveSeatsToStorage(updated);
      syncSeatsToWatch(updated, userName, staffMembers, { immediate: true });
      return updated;
    });
    setIsAssignMainTimerModalVisible(false);
    Alert.alert('セット完了', 'メインタイマーを席に割り当てずにサロンボードへセットしました！');
  };

  // フィルタリング処理
  const filteredSeats = seats.filter((s) => {
    if (filterMode === 'all') return true;
    if (filterMode === 'my') {
      if (s.status === 'idle') return false; // 待機席は除外
      const isMyColor = isMainStaffOfSeat(s, userName, myUserId, staffMembers);
      const isMyAssistant = isStaffNameMe(s.assistantStaffName, userName, myUserId, staffMembers);
      const isMyCheck = isStaffNameMe(s.checkStaffName || s.checkStaff, userName, myUserId, staffMembers);
      return isMyColor || isMyAssistant || isMyCheck;
    }
    return true;
  });

  // 待機中の空席リスト（マイタイマー割り当て用・00:00停止席も対象に含める）
  const idleSeats = seats.filter(
    (s) => s.status === 'idle' || (s.status === 'paused' && (s.isReset || (s.pausedRemainingSeconds ?? 0) <= 0))
  );

  // マイタイマーの分秒フォーマット
  const formatSec = (seconds) => {
    const abs = Math.abs(seconds);
    const m = Math.floor(abs / 60);
    const s = abs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.bg }]}>
      {/* ★ Apple Watch 通信状態の常時表示（診断用。不要になったらこの1行を削除） */}
      <WatchDiagnosticsBar theme={theme} />
      {peerBanner ? (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => setPeerBanner(null)}
          style={{
            marginHorizontal: 12,
            marginTop: 6,
            marginBottom: 4,
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderRadius: 12,
            backgroundColor: peerBanner.color || '#30D158',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.25,
            shadowRadius: 4,
            elevation: 4,
          }}
        >
          <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '800', flex: 1 }}>
            {peerBanner.text}
          </Text>
          <Ionicons name="close-circle" size={18} color="rgba(255,255,255,0.85)" style={{ marginLeft: 8 }} />
        </TouchableOpacity>
      ) : null}
      {/* 1. 上部サロンヘッダー（タップでサロン・グループ・個人無料枠を切り替え！） */}
      <View style={[styles.headerContainer, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}>
        <TouchableOpacity
          style={styles.headerTitleButton}
          onPress={() => setIsSwitcherModalVisible(true)}
          activeOpacity={0.7}
        >
          <View style={styles.salonTitleRow}>
            <Ionicons
              name={
                currentSalon?.type === 'group'
                  ? 'people'
                  : currentSalon?.type === 'pair'
                  ? 'person-add'
                  : 'business'
              }
              size={18}
              color={theme.accent}
              style={{ marginRight: 6 }}
            />
            <Text style={[styles.salonTitle, { color: theme.textPrimary }]} numberOfLines={1}>
              {currentSalon?.name || 'サロン未設定'}
            </Text>
            <Ionicons name="chevron-down" size={16} color={theme.textSecondary} style={{ marginLeft: 4 }} />
          </View>

          <View style={styles.subInfoRow}>
            <View style={[styles.liveDot, { backgroundColor: theme.success }]} />
            <Text style={[styles.subInfoText, { color: theme.textSecondary }]}>
              {currentSalon?.type === 'pair'
                ? '2人までタイマー同期無料 (ペア招待可能)'
                : isCloudUUID(currentSalon?.id) && staffMembers.length > 0
                  ? buildSalonMemberDescription(currentSalon, staffMembers.length)
                  : (currentSalon?.description || 'オンライン中')}
            </Text>
            {currentSalon?.isPro ? (
              <View style={[styles.proBadge, { backgroundColor: '#FFD700' }]}>
                <Text style={styles.proBadgeText}>PRO</Text>
              </View>
            ) : null}
          </View>
        </TouchableOpacity>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          {/* ★ 招待コードで参加ボタン */}
          <TouchableOpacity
            style={[
              styles.addSeatHeaderButton,
              {
                backgroundColor: theme.accent,
                borderColor: theme.accent,
                paddingHorizontal: 8,
              },
            ]}
            onPress={() => {
              setInputInviteCode('');
              setInputStaffName(userName || 'アシスタント');
              setIsJoinCodeModalVisible(true);
            }}
            activeOpacity={0.7}
          >
            <Ionicons name="enter-outline" size={14} color="#FFFFFF" />
            <Text style={[styles.addSeatHeaderText, { color: '#FFFFFF', marginLeft: 2, fontSize: 11 }]}>参加</Text>
          </TouchableOpacity>

          {/* ★ メンバー管理ボタン */}
          <TouchableOpacity
            style={[
              styles.addSeatHeaderButton,
              {
                backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7',
                borderColor: theme.cardBorder,
                paddingHorizontal: 7,
              },
            ]}
            onPress={() => setIsMemberManageModalVisible(true)}
            activeOpacity={0.7}
          >
            <Ionicons name="people" size={14} color={theme.textPrimary} />
            <Text style={[styles.addSeatHeaderText, { color: theme.textPrimary, marginLeft: 2, fontSize: 11 }]}>
              メンバー{staffMembers.length > 0 ? `(${staffMembers.length})` : ''}
            </Text>
          </TouchableOpacity>

          {/* 席追加（席マスターを増やす）ボタン（招待元オーナーのみ表示） */}
          {isSalonOwner ? (
            <TouchableOpacity
              style={[
                styles.addSeatHeaderButton,
                {
                  backgroundColor: theme.accentLight,
                  borderColor: theme.accentBorder,
                  paddingHorizontal: 7,
                },
              ]}
              onPress={() => {
                setNewSeatName(`${getNextSuggestedSeatNumber()}番席`);
                setIsAddSeatModalVisible(true);
              }}
            >
              <Ionicons name="add" size={15} color={theme.accent} />
              <Text style={[styles.addSeatHeaderText, { color: theme.accent, fontSize: 11 }]}>席追加</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* 2. 最上部・メインタイマー連動ウィジェット (HomeScreen連携) */}
      <View
        style={[
          styles.mainTimerWidget,
          {
            backgroundColor: (mainTimerState?.isRunning || mainTimerState?.isPreCountingDown) ? theme.accentLight : theme.cardBg,
            borderColor: (mainTimerState?.isRunning || mainTimerState?.isPreCountingDown) ? theme.accentBorder : theme.cardBorder,
          },
        ]}
      >
        {/* 上段: タイトル ＆ ステータス ＆ 計測ジャンル（横幅いっぱい使って重なりを完全防止） */}
        <View style={styles.mainTimerHeaderRow}>
          <View style={styles.mainTimerBadgeRow}>
            <Ionicons
              name={(mainTimerState?.isRunning || mainTimerState?.isPreCountingDown) ? 'timer' : 'timer-outline'}
              size={15}
              color={(mainTimerState?.isRunning || mainTimerState?.isPreCountingDown) ? theme.accent : theme.textSecondary}
              style={{ marginRight: 5 }}
            />
            <Text style={[styles.mainTimerLabel, { color: (mainTimerState?.isRunning || mainTimerState?.isPreCountingDown) ? theme.accent : theme.textPrimary }]}>
              {mainTimerState?.isPreCountingDown
                ? 'メインタイマー (準備カウント中)'
                : mainTimerState?.isRunning
                ? 'メインタイマー稼働中'
                : mainTimerState?.isPaused
                ? 'メインタイマー (一時停止)'
                : 'メインタイマー (00:00)'}
            </Text>
            {mainTimerState?.genre ? (
              <View style={[styles.mainTimerGenrePill, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}>
                <Text style={[styles.mainTimerGenreText, { color: theme.textSecondary }]}>
                  🏷️ {mainTimerState.genre}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* 下段: 大きなタイマー数字 ＆ 操作ボタングループ */}
        <View style={styles.mainTimerControlsRow}>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={handlePressMainTimerDigits}
            style={styles.mainTimerDigitsTouchable}
          >
            <Text
              style={[
                styles.mainTimerDigits,
                {
                  color: mainTimerState?.isCountUp
                    ? theme.danger
                    : (mainTimerState?.isRunning || mainTimerState?.isPreCountingDown)
                    ? theme.accent
                    : theme.textPrimary,
                },
              ]}
            >
              {mainTimerState?.isCountUp ? '+' : ''}
              {formatSec(
                mainTimerState?.isPreCountingDown
                  ? (mainTimerState?.preCountdownSeconds ?? 0)
                  : (mainTimerState?.remainingTime ?? 180)
              )}
            </Text>
          </TouchableOpacity>

          <View style={styles.mainTimerRightActions}>
            <TouchableOpacity
              style={[
                styles.mainTimerBtn,
                {
                  backgroundColor: (mainTimerState?.isRunning || mainTimerState?.isPreCountingDown) ? theme.warningLight : theme.accent,
                  borderColor: (mainTimerState?.isRunning || mainTimerState?.isPreCountingDown) ? theme.warning : theme.accent,
                },
              ]}
              onPress={() => requestMainTimerAction('toggle', { fromPhone: true, playSoundOnPhone: true })}
            >
              <Ionicons
                name={(mainTimerState?.isRunning || mainTimerState?.isPreCountingDown) ? 'pause' : 'play'}
                size={13}
                color={(mainTimerState?.isRunning || mainTimerState?.isPreCountingDown) ? theme.warning : '#FFFFFF'}
              />
              <Text
                style={[
                  styles.mainTimerBtnText,
                  { color: (mainTimerState?.isRunning || mainTimerState?.isPreCountingDown) ? theme.warning : '#FFFFFF' },
                ]}
              >
                {mainTimerState?.isRunning && mainTimerState?.isCountUp
                  ? 'タイマーを止める'
                  : (mainTimerState?.isRunning || mainTimerState?.isPreCountingDown)
                  ? '一時停止'
                  : 'スタート'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.mainTimerBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
              onPress={() => requestMainTimerAction('reset', { fromPhone: true })}
            >
              <Text style={[styles.mainTimerBtnText, { color: theme.textSecondary }]}>タイマーを止める</Text>
            </TouchableOpacity>

            {/* タイムを空席またはフリー枠にセットするショートカット */}
            <TouchableOpacity
              style={[styles.mainTimerAssignBtn, { backgroundColor: theme.accent }]}
              onPress={() => setIsAssignMainTimerModalVisible(true)}
            >
              <Ionicons name="arrow-down" size={13} color="#FFFFFF" />
              <Text style={styles.mainTimerAssignBtnText}>割当て</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* 3. フィルタセグメント（サロン全体 / 自分担当） */}
      <View style={[styles.filterBarContainer, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}>
        <TouchableOpacity
          style={[
            styles.filterPill,
            filterMode === 'all' && [styles.filterPillActive, { backgroundColor: theme.accent }],
          ]}
          onPress={() => setFilterMode('all')}
        >
          <Text
            style={[
              styles.filterPillText,
              { color: filterMode === 'all' ? '#FFFFFF' : theme.textSecondary },
            ]}
          >
            サロン全体 (全{seats.length}席)
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.filterPill,
            filterMode === 'my' && [styles.filterPillActive, { backgroundColor: theme.accent }],
          ]}
          onPress={() => setFilterMode('my')}
        >
          <Text
            style={[
              styles.filterPillText,
              { color: filterMode === 'my' ? '#FFFFFF' : theme.textSecondary },
            ]}
          >
            👤 自分担当のみ
          </Text>
        </TouchableOpacity>
      </View>

      {/* 4. 席タイマーリスト（待機中は最小化スリムバー ⇄ 稼働中はフル展開カード） */}
      <ScrollView
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {filteredSeats.map((item) => {
          const isIdle = item.status === 'idle';

          // ==============================
          // 【パターンA: 待機中（最小化スリムバー）】
          // ==============================
          if (isIdle) {
            return (
              <TouchableOpacity
                key={item.id}
                style={[
                  styles.idleRow,
                  {
                    backgroundColor: theme.idleRowBg,
                    borderColor: theme.idleRowBorder,
                  },
                ]}
                onPress={() => handleOpenSetTimerModal(item)}
                onLongPress={isSalonOwner ? () => handleDeleteSeat(item.id, item.seatLabel) : undefined}
                activeOpacity={0.7}
              >
                <View style={styles.idleRowLeft}>
                  {isSalonOwner ? (
                    <TouchableOpacity
                      style={[styles.idleSeatBadge, { backgroundColor: theme.inputBg, flexDirection: 'row', alignItems: 'center' }]}
                      onPress={(e) => {
                        e.stopPropagation();
                        handleOpenSeatRenameModal(item);
                      }}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.idleSeatBadgeText, { color: theme.textPrimary }]}>
                        ⌚️ {item.seatLabel.replace(/^[🪑⌚️⏱️]\s*/, '')}
                      </Text>
                      <Ionicons name="pencil" size={11} color={theme.accent} style={{ marginLeft: 4 }} />
                    </TouchableOpacity>
                  ) : (
                    <View style={[styles.idleSeatBadge, { backgroundColor: theme.inputBg, flexDirection: 'row', alignItems: 'center' }]}>
                      <Text style={[styles.idleSeatBadgeText, { color: theme.textPrimary }]}>
                        ⌚️ {item.seatLabel.replace(/^[🪑⌚️⏱️]\s*/, '')}
                      </Text>
                    </View>
                  )}
                  <Text style={[styles.idleStatusText, { color: theme.textTertiary }]}>
                    00:00（待機中）
                  </Text>
                </View>

                <View style={[styles.idleActionPill, { backgroundColor: theme.accentLight, borderColor: theme.accentBorder }]}>
                  <Ionicons name="add" size={14} color={theme.accent} style={{ marginRight: 2 }} />
                  <Text style={[styles.idleActionText, { color: theme.accent }]}>タイム設定</Text>
                </View>
              </TouchableOpacity>
            );
          }

          // ==============================
          // 【パターンB: 停止中 ＆ アコーディオン閉じ状態（スリムバー）】
          // ==============================
          const isPaused = item.status === 'paused';
          // ★ 大元の共有タイマーはどの停止・工程移行・リセットでもカードを折りたたむ（手動タップ展開時のみ開く）
          const isExpanded = !!expandedPausedSeatIds[item.id];

          let remainingSec = 0;
          let isOver = false;

          if (isPaused) {
            remainingSec = item.pausedRemainingSeconds || 0;
          } else {
            const diffMs = item.targetEndTimestamp - now;
            remainingSec = Math.floor(diffMs / 1000);
            if (remainingSec < 0) {
              isOver = true;
              remainingSec = Math.abs(remainingSec);
            }
          }

          const m = Math.floor(remainingSec / 60);
          const s = remainingSec % 60;
          const currentStatusInfo = getActionStatusInfo(item.actionStatus, item.isShampooing);
          const isZeroPaused = isPaused && (remainingSec <= 0 || item.isReset || (item.pausedRemainingSeconds !== null && item.pausedRemainingSeconds <= 0));
          const timeString = isZeroPaused ? '00:00' : `${isOver ? '+' : ''}${m}:${s < 10 ? '0' : ''}${s}`;

          // 停止中かつ手動展開されていない場合は、アコーディオンで閉まったスリムバーを表示
          if (isPaused && !isExpanded) {
            return (
              <TouchableOpacity
                key={item.id}
                style={[
                  styles.pausedRow,
                  {
                    backgroundColor: isEcoMode ? '#1C1C1E' : '#FFFFFF',
                    borderColor: currentStatusInfo ? currentStatusInfo.color : theme.cardBorder,
                  },
                ]}
                onPress={() => handleToggleExpandPausedSeat(item.id)}
                activeOpacity={0.7}
              >
                {/* 左側: 席ラベル ＆ 停止時タイム（最後に入れられたタイム） */}
                <View style={styles.pausedRowLeft}>
                  {isSalonOwner ? (
                    <TouchableOpacity
                      style={[styles.pausedSeatBadge, { backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7', flexDirection: 'row', alignItems: 'center' }]}
                      onPress={(e) => {
                        e.stopPropagation();
                        handleOpenSeatRenameModal(item);
                      }}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.pausedSeatBadgeText, { color: theme.textPrimary }]}>
                        ⌚️ {item.seatLabel.replace(/^[🪑⌚️⏱️]\s*/, '')}
                      </Text>
                      <Ionicons name="pencil" size={11} color={theme.accent} style={{ marginLeft: 4 }} />
                    </TouchableOpacity>
                  ) : (
                    <View style={[styles.pausedSeatBadge, { backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7', flexDirection: 'row', alignItems: 'center' }]}>
                      <Text style={[styles.pausedSeatBadgeText, { color: theme.textPrimary }]}>
                        ⌚️ {item.seatLabel.replace(/^[🪑⌚️⏱️]\s*/, '')}
                      </Text>
                    </View>
                  )}
                  <View style={styles.pausedTimeContainer}>
                    <Text style={[styles.pausedTimeText, { color: theme.warning }]}>
                      ⏸️ {timeString}
                    </Text>
                  </View>
                </View>

                {/* 右側: 施術ステータス ＆ ヘルプ担当 ＆ 担当者 ＆ 開くアイコン */}
                <View style={styles.pausedRowRight}>
                  {currentStatusInfo ? (
                    <TouchableOpacity
                      style={[
                        styles.pausedStatusBadge,
                        {
                          backgroundColor: isEcoMode ? 'rgba(0,0,0,0.4)' : currentStatusInfo.bg,
                          borderColor: currentStatusInfo.border,
                        },
                      ]}
                      onPress={(e) => {
                        e.stopPropagation();
                        handleOpenActionStatusModal(item);
                      }}
                    >
                      <Text style={[styles.pausedStatusBadgeText, { color: currentStatusInfo.color }]}>
                        {currentStatusInfo.badge}
                      </Text>
                    </TouchableOpacity>
                  ) : null}

                  {/* ヘルプ担当バッジ */}
                  <TouchableOpacity
                    style={[
                      styles.pausedHelpBadge,
                      {
                        backgroundColor: isZeroPaused
                          ? (isEcoMode ? '#2C2C2E' : '#F3F4F6')
                          : item.assistantStaffName === 'ヘルプなし'
                          ? (isEcoMode ? '#2C2C2E' : '#F3F4F6')
                          : item.assistantStaffName
                          ? theme.accentLight
                          : (isEcoMode ? '#2C2C2E' : '#FFF7ED'),
                        borderColor: isZeroPaused
                          ? theme.cardBorder
                          : item.assistantStaffName === 'ヘルプなし'
                          ? theme.cardBorder
                          : item.assistantStaffName
                          ? theme.accentBorder
                          : '#FED7AA',
                      },
                    ]}
                    onPress={(e) => {
                      e.stopPropagation();
                      handleOpenHelpAssignModal(item);
                    }}
                  >
                    <Text
                      style={[
                        styles.pausedHelpBadgeText,
                        {
                          color: isZeroPaused
                            ? theme.textTertiary
                            : item.assistantStaffName === 'ヘルプなし'
                            ? theme.textSecondary
                            : item.assistantStaffName
                            ? theme.accent
                            : '#EA580C',
                        },
                      ]}
                    >
                      {isZeroPaused
                        ? '00:00'
                        : item.assistantStaffName === 'ヘルプなし'
                        ? 'ヘルプなし'
                        : item.assistantStaffName
                        ? formatStaffForDisplay(item.assistantStaffName)
                        : '未定'}
                    </Text>
                  </TouchableOpacity>

                  <Text style={[styles.pausedStaffText, { color: theme.textSecondary }]} numberOfLines={1}>
                    📝 {item.colorStaffName ? formatCreatorForDisplay(item, '未') : '未'}
                  </Text>

                  <Ionicons name="chevron-down" size={18} color={theme.textTertiary} style={{ marginLeft: 4 }} />
                </View>
              </TouchableOpacity>
            );
          }

          // ==============================
          // 【パターンC: フル展開カード（稼働中 または 手動展開された停止席）】
          // ==============================
          const isNoHelp = item.assistantStaffName === 'ヘルプなし' || item.assistantStaffName === 'none';
          const isHelpUndecided = !item.assistantStaffName || item.assistantStaffName.trim() === '';
          const isOneMinBeforeHelpAlert = !isPaused && !isOver && remainingSec <= 60 && remainingSec > 0 && isHelpUndecided && !isNoHelp;

          // 確認状態の判定（指定した人＝タイマー作成者は自分で入れているので確認不要。ヘルプ担当がいる場合はヘルプの確認で安全完了）
          const isSafetyConfirmed = isNoHelp || !item.assistantStaffName || item.assistantStaffConfirmed;

          // カードの動的境界線＆背景色（緑/赤/SOS/1分前未定警告/施術ステータスカラー）
          let cardBgColor = theme.cardBg;
          let cardBorderColor = currentStatusInfo ? currentStatusInfo.color : theme.cardBorder;
          let cardBorderWidth = currentStatusInfo ? 1.5 : 1;

          if (item.sosTriggered) {
            cardBorderColor = '#AF52DE';
            cardBorderWidth = 2.5;
            cardBgColor = isEcoMode ? '#281136' : '#FAF0FF';
          } else if (isOver) {
            if (isSafetyConfirmed) {
              cardBorderColor = theme.success;
              cardBorderWidth = 2.5;
              cardBgColor = isEcoMode ? '#0B2413' : '#F0FDF4';
            } else {
              cardBorderColor = theme.danger;
              cardBorderWidth = 2.5;
              cardBgColor = isEcoMode ? '#2B0E0E' : '#FEF2F2';
            }
          } else if (isOneMinBeforeHelpAlert) {
            // ★ 1分前でもヘルプ担当が決まっていない警告ボーダー
            cardBorderColor = theme.danger;
            cardBorderWidth = 2.5;
            cardBgColor = isEcoMode ? '#2B0E0E' : '#FFF5F5';
          }

          return (
            <View
              key={item.id}
              style={[
                styles.card,
                {
                  backgroundColor: cardBgColor,
                  borderColor: cardBorderColor,
                  borderWidth: cardBorderWidth,
                },
              ]}
            >
              {/* カード上段: 席名 ＆ タイマー作成者 ＆ 状態ステータスバッジ（放置中 / 停止中 / タイム超過 / ヘルプ未定 等） ＆ 折りたたみボタン */}
              <View style={styles.cardHeader}>
                <View style={styles.cardHeaderLeft}>
                  <TouchableOpacity
                    style={[styles.seatLabelContainer, item.isFreeTimer && { backgroundColor: theme.accentLight }, { flexDirection: 'row', alignItems: 'center' }]}
                    onPress={isSalonOwner ? () => handleOpenSeatRenameModal(item) : undefined}
                    disabled={!isSalonOwner}
                    activeOpacity={isSalonOwner ? 0.7 : 1}
                  >
                    <Text style={[styles.seatLabelText, { color: item.isFreeTimer ? theme.accent : theme.textPrimary }]}>
                      ⌚️ {item.seatLabel.replace(/^[🪑⌚️⏱️]\s*/, '')}
                    </Text>
                    {isSalonOwner ? (
                      <Ionicons name="pencil" size={11} color={theme.accent} style={{ marginLeft: 4 }} />
                    ) : null}
                  </TouchableOpacity>

                  {/* ★ ユーザー指定: 1番席の右の所にタイマー作成者の名前を表示（自分が作成者なら「📝 自分」） */}
                  {item.colorStaffName ? (
                    <View
                      style={[
                        styles.headerCreatorBadge,
                        {
                          backgroundColor: isEcoMode ? '#252528' : '#F2F2F7',
                          borderColor: theme.cardBorder,
                        },
                      ]}
                    >
                      <Text style={[styles.headerCreatorText, { color: theme.textSecondary }]}>
                        📝 {formatCreatorForDisplay(item)}
                      </Text>
                    </View>
                  ) : null}
                </View>

                <View style={styles.cardHeaderRight}>
                  {/* ★ ユーザー指定: ステータスバッジを右上に配置（今放置中のマークがある所から移動） */}
                  <View
                    style={[
                      styles.headerStatusBadge,
                      {
                        backgroundColor: isPaused
                          ? (isEcoMode ? 'rgba(245, 158, 11, 0.15)' : '#FEF3C7')
                          : isOver
                          ? (isEcoMode ? 'rgba(239, 68, 68, 0.18)' : '#FEE2E2')
                          : isOneMinBeforeHelpAlert
                          ? (isEcoMode ? 'rgba(239, 68, 68, 0.18)' : '#FEE2E2')
                          : (isEcoMode ? '#252528' : '#F2F2F7'),
                        borderColor: isPaused
                          ? '#F59E0B'
                          : isOver || isOneMinBeforeHelpAlert
                          ? '#EF4444'
                          : theme.cardBorder,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.timerStatusBadge,
                        {
                          color: isPaused
                            ? '#D97706'
                            : isOver || isOneMinBeforeHelpAlert
                            ? theme.danger
                            : theme.textSecondary,
                        },
                      ]}
                    >
                      {isPaused
                        ? item.isReset || remainingSec === 0
                          ? '🔄 リセット済 (0:00)'
                          : item.stoppedBy
                          ? `⏸️ 停止中 (🛑 ${formatStaffForDisplay(item.stoppedBy)})`
                          : '⏸️ 一時停止中'
                        : isOver
                        ? '🚨 全体タイム超過'
                        : isOneMinBeforeHelpAlert
                        ? '⚠️ ヘルプ未定 (あと1分)'
                        : '⏳ 放置中'}
                    </Text>
                  </View>

                  {/* 停止中なら閉じるボタン */}
                  {isPaused ? (
                    <TouchableOpacity
                      style={[
                        styles.collapseBtn,
                        { backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7', borderColor: theme.cardBorder },
                      ]}
                      onPress={() => handleToggleExpandPausedSeat(item.id)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="chevron-up" size={13} color={theme.textSecondary} style={{ marginRight: 2 }} />
                      <Text style={[styles.collapseBtnText, { color: theme.textSecondary }]}>閉じる</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>

              {/* カード中段: 全体タイマー大表示（タップで時間変更＆停止） ＆ 全体ヘルプ担当（シャンプータグチ等） */}
              {/* ★ ユーザー指定: チェックタイマーは緑のカードになっているので、全体のタイマーはブルーのカードにする */}
              <View
                style={[
                  styles.mainTimerSubCard,
                  {
                    backgroundColor: isOver || isOneMinBeforeHelpAlert
                      ? (isEcoMode ? '#331214' : '#FEE2E2')
                      : isPaused
                      ? (isEcoMode ? '#2B200A' : '#FEF3C7')
                      : (isEcoMode ? '#0A1C30' : '#EFF6FF'),
                    borderColor: isOver || isOneMinBeforeHelpAlert
                      ? '#EF4444'
                      : isPaused
                      ? '#F59E0B'
                      : (isEcoMode ? '#1D4ED8' : '#3B82F6'),
                  },
                ]}
              >
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => handlePressSeatTimerDigits(item)}
                  style={styles.timerDigitsTouchable}
                >
                  <Text
                    style={[
                      styles.timerDigits,
                      {
                        color: isOver
                          ? theme.danger
                          : isOneMinBeforeHelpAlert
                          ? theme.danger
                          : remainingSec <= 180
                          ? theme.warning
                          : '#2563EB',
                      },
                    ]}
                  >
                    {timeString}
                  </Text>
                  {/* ★ ユーザー指定: カウントタイマーに最初の時間も下に小さく表示（何分で測ったのか一目でわかる） */}
                  <View
                    style={[
                      styles.initialTimePill,
                      {
                        backgroundColor: isEcoMode ? 'rgba(0,0,0,0.3)' : 'rgba(255, 255, 255, 0.85)',
                        borderColor: isOver || isOneMinBeforeHelpAlert
                          ? '#FCA5A5'
                          : isPaused
                          ? '#FDE68A'
                          : (isEcoMode ? '#1D4ED8' : '#BFDBFE'),
                      },
                    ]}
                  >
                    <Ionicons
                      name="timer-outline"
                      size={11}
                      color={isEcoMode ? '#93C5FD' : '#2563EB'}
                      style={{ marginRight: 3 }}
                    />
                    <Text
                      style={[
                        styles.initialTimePillText,
                        { color: isEcoMode ? '#93C5FD' : '#1D4ED8' },
                      ]}
                    >
                      {item.isReset || (isPaused && remainingSec === 0)
                        ? '🔄 0分 (タイム入れ直し)'
                        : `全体初期設定: ${item.initialMinutes || Math.round((item.targetSeconds || 1200) / 60)}分`}
                    </Text>
                  </View>
                </TouchableOpacity>

                {/* ★ ユーザー指定: 「今放置中のマークがある所にシャンプータグチが来るようにする」 */}
                <TouchableOpacity
                  style={[
                    styles.helpHeaderButton,
                    isOneMinBeforeHelpAlert
                      ? { backgroundColor: isEcoMode ? 'rgba(239, 68, 68, 0.25)' : '#FEE2E2', borderColor: theme.danger, borderWidth: 1.5 }
                      : isNoHelp
                      ? { backgroundColor: isEcoMode ? '#2C2C2E' : '#F3F4F6', borderColor: theme.cardBorder }
                      : item.assistantStaffName
                      ? { backgroundColor: isEcoMode ? '#0B243B' : '#DBEAFE', borderColor: '#3B82F6' }
                      : { backgroundColor: isEcoMode ? '#2C2C2E' : '#FFF7ED', borderColor: '#FED7AA' },
                  ]}
                  onPress={() => handleOpenHelpAssignModal(item)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.helpHeaderButtonText,
                      {
                        color: isOneMinBeforeHelpAlert
                          ? theme.danger
                          : isNoHelp
                          ? theme.textSecondary
                          : item.assistantStaffName
                          ? '#2563EB'
                          : '#EA580C',
                        fontWeight: isOneMinBeforeHelpAlert || item.assistantStaffName ? '700' : '600',
                      },
                    ]}
                  >
                    {getHelpHeaderButtonLabel(item, isOneMinBeforeHelpAlert)}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* ★ ユーザー指定: チェックタイマー（全体のタイマーと同じような左右配置: 左にタイマー、右にチェックスタッフ指定＆完了） */}
              {item.checkTargetSeconds > 0 ? (() => {
                let checkRemainingSec = 0;
                let isCheckOver = false;
                if (isPaused) {
                  checkRemainingSec = item.checkPausedRemainingSeconds || 0;
                } else if (item.checkEndTimestamp) {
                  const checkDiffMs = item.checkEndTimestamp - now;
                  checkRemainingSec = Math.floor(checkDiffMs / 1000);
                  if (checkRemainingSec < 0) {
                    isCheckOver = true;
                    checkRemainingSec = Math.abs(checkRemainingSec);
                  }
                }
                const chkM = Math.floor(checkRemainingSec / 60);
                const chkS = checkRemainingSec % 60;
                const checkTimeString = `${isCheckOver ? '+' : ''}${chkM}:${chkS < 10 ? '0' : ''}${chkS}`;

                const isCompleted = item.checkStatus === 'completed';
                const isTimeUp = !isCompleted && (item.checkStatus === 'timeup' || isCheckOver);
                const chkProcDisp = sanitizeCheckProcess(item.checkProcess);

                return (
                  <View
                    style={[
                      styles.checkTimerSubCard,
                      {
                        backgroundColor: isCompleted
                          ? (isEcoMode ? '#1C1C1E' : '#F3F4F6')
                          : isTimeUp
                          ? (isEcoMode ? '#331B05' : '#FEF3C7')
                          : (isEcoMode ? '#0E2417' : '#ECFDF5'),
                        borderColor: isCompleted
                          ? theme.cardBorder
                          : isTimeUp
                          ? '#F59E0B'
                          : '#10B981',
                      },
                    ]}
                  >
                    {/* ★ ユーザー指定: チェックタイマー部分を押したら「タイマーを止めますか？」モーダルを開く */}
                    <TouchableOpacity
                      style={styles.checkTimerSubLeft}
                      activeOpacity={0.7}
                      onPress={() => handlePressCheckTimer(item)}
                    >
                      <Ionicons
                        name={isCompleted ? 'checkmark-circle' : isTimeUp ? 'alert-circle' : 'search'}
                        size={15}
                        color={isCompleted ? theme.textTertiary : isTimeUp ? '#D97706' : '#059669'}
                      />
                      <Text
                        style={[
                          styles.checkTimerSubLabel,
                          {
                            color: isCompleted
                              ? theme.textSecondary
                              : isTimeUp
                              ? '#B45309'
                              : '#065F46',
                          },
                        ]}
                      >
                        {isCompleted
                          ? `${chkProcDisp}確認済み`
                          : isTimeUp
                          ? `${chkProcDisp}時間！`
                          : `${chkProcDisp}まで あと`}
                      </Text>

                      {!isCompleted && (
                        <Text
                          style={[
                            styles.checkTimerSubDigits,
                            {
                              color: isTimeUp ? '#DC2626' : '#059669',
                            },
                          ]}
                        >
                          {checkTimeString}
                        </Text>
                      )}

                      <View
                        style={[
                          styles.checkTimerInitialBadge,
                          {
                            backgroundColor: isEcoMode ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.7)',
                            borderColor: isCompleted ? theme.cardBorder : isTimeUp ? '#F59E0B' : '#A7F3D0',
                          },
                        ]}
                      >
                        <Text style={{ fontSize: 10, color: theme.textSecondary, fontWeight: '600' }}>
                          {item.checkInitialMinutes || Math.round(item.checkTargetSeconds / 60)}分設定
                        </Text>
                      </View>
                    </TouchableOpacity>

                    {/* ★ ユーザー指定: 右側アクション: チェック担当スタッフ指定ボタンのみ（完了ボタンは撤廃） */}
                    <View style={styles.checkTimerSubRight}>
                      {/* チェック担当スタッフ指定ボタン */}
                      <TouchableOpacity
                        style={[
                          styles.checkStaffButton,
                          isCompleted
                            ? { backgroundColor: isEcoMode ? '#252528' : '#F3F4F6', borderColor: theme.cardBorder }
                            : item.checkStaffName
                            ? { backgroundColor: isEcoMode ? '#0B2416' : '#D1FAE5', borderColor: '#10B981' }
                            : { backgroundColor: isEcoMode ? '#2C2C2E' : '#FFF7ED', borderColor: '#FED7AA' },
                        ]}
                        onPress={() => handleOpenCheckStaffModal(item)}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            styles.checkStaffButtonText,
                            {
                              color: isCompleted
                                ? theme.textSecondary
                                : item.checkStaffName
                                ? '#059669'
                                : '#EA580C',
                              fontWeight: isCompleted || item.checkStaffName ? '700' : '600',
                            },
                          ]}
                        >
                          {isCompleted
                            ? (item.checkStaffName ? `${formatStaffForDisplay(item.checkStaffName)}済 ▾` : 'チェック済 ▾')
                            : (item.checkStaffName ? `チェック: ${formatStaffForDisplay(item.checkStaffName)} ▾` : 'チェック未定 ▾')}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })() : null}

              {/* 超過中の安全確認ステータスバッジ ＆ アクション（確認・SOS） */}
              {isOver ? (
                <View style={[styles.safetyStatusBox, { borderColor: cardBorderColor, backgroundColor: isEcoMode ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.6)' }]}>
                  <View style={styles.safetyStatusHeader}>
                    <Text style={[styles.safetyStatusTitle, { color: cardBorderColor }]}>
                      {item.sosTriggered
                        ? '🚨 SOSヘルプ要請中'
                        : isSafetyConfirmed
                        ? (isNoHelp ? '🟢 確認完了 (安全)' : '🟢 ヘルプ確認完了 (安全)')
                        : (!item.assistantStaffName ? '⚠️ ヘルプ未定 (確認待ち)' : '🔴 ヘルプ確認待ち')}
                    </Text>

                    <View style={styles.safetyStatusRoles}>
                      {isNoHelp ? (
                        <Text style={[styles.safetyRoleText, { color: theme.textSecondary }]}>
                          👤 ワンマン施術
                        </Text>
                      ) : item.assistantStaffName ? (
                        <Text style={[styles.safetyRoleText, { color: item.assistantStaffConfirmed ? theme.success : theme.danger }]}>
                          ヘルプ（{formatStaffForDisplay(item.assistantStaffName)}）: {item.assistantStaffConfirmed ? '✓済' : '✕未'}
                        </Text>
                      ) : (
                        <Text style={[styles.safetyRoleText, { color: theme.warning }]}>
                          ヘルプ: 未定
                        </Text>
                      )}
                    </View>
                  </View>

                  {/* アクションボタン（確認する ＆ SOS） */}
                  <View style={styles.safetyActionRow}>
                    {!isSafetyConfirmed ? (() => {
                      const isAssistant = isStaffNameMe(item.assistantStaffName, userName, myUserId, staffMembers);
                      const isMyAssistPending = isAssistant && !item.assistantStaffConfirmed && !isNoHelp;

                      // ヘルプ担当本人なら緑色の直接確認、それ以外（指定したメイン担当または第三者）は代理確認
                      const isDirectAction = isMyAssistPending || isNoHelp;
                      const btnLabel = isMyAssistPending
                        ? '✓ ヘルプ確認する'
                        : isNoHelp
                        ? '✓ 確認する'
                        : 'ヘルプを代理確認 ▾';

                      return (
                        <TouchableOpacity
                          style={[
                            styles.safetyConfirmBtn,
                            {
                              backgroundColor: isDirectAction ? theme.success : '#FF9500',
                            },
                          ]}
                          onPress={() => handlePressConfirmButton(item)}
                          activeOpacity={0.7}
                        >
                          <Ionicons
                            name={isDirectAction ? 'checkmark-circle' : 'shield-checkmark'}
                            size={15}
                            color="#FFFFFF"
                            style={{ marginRight: 4 }}
                          />
                          <Text style={styles.safetyConfirmBtnText}>{btnLabel}</Text>
                        </TouchableOpacity>
                      );
                    })() : (
                      <View style={[styles.safetyConfirmedPill, { backgroundColor: theme.successLight, borderColor: theme.success }]}>
                        <Ionicons name="checkmark-done" size={14} color={theme.success} style={{ marginRight: 4 }} />
                        <Text style={[styles.safetyConfirmedPillText, { color: theme.success }]}>確認完了・施術進行中</Text>
                      </View>
                    )}

                    {!item.sosTriggered ? (
                      <TouchableOpacity
                        style={[styles.safetySosBtn, { backgroundColor: '#AF52DE' }]}
                        onPress={() => handleTriggerSOS(item.id)}
                      >
                        <Ionicons name="alert-circle" size={14} color="#FFFFFF" style={{ marginRight: 3 }} />
                        <Text style={styles.safetySosBtnText}>SOS</Text>
                      </TouchableOpacity>
                    ) : (
                      <View style={[styles.safetySosPill, { backgroundColor: '#AF52DE' }]}>
                        <Text style={styles.safetySosPillText}>SOS発信済</Text>
                      </View>
                    )}
                  </View>
                </View>
              ) : null}

              {/* ★ ユーザー指定: タイマー稼働中（塗布〜タイマーストップ・シャンプーに入るまで）のみタイマーの下に施術履歴を表示 */}
              {shouldRetainSeatHistory(item) && item.history && item.history.length > 0 ? (
                <View style={[styles.historyContainer, { backgroundColor: isEcoMode ? '#1C1C1E' : '#F8F9FA', borderColor: theme.cardBorder }]}>
                  <View style={styles.historyHeaderRow}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Ionicons name="git-commit-outline" size={13} color={theme.accent} style={{ marginRight: 4 }} />
                      <Text style={[styles.historyHeaderTitle, { color: theme.textSecondary }]}>
                        施術履歴
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => handleOpenAddHistoryModal(item)}
                      style={styles.addHistoryBtn}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="add-circle-outline" size={13} color={theme.accent} style={{ marginRight: 2 }} />
                      <Text style={[styles.addHistoryBtnText, { color: theme.accent }]}>履歴追加</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.historyTimelineList}>
                    {item.history.map((h, idx) => {
                      const isLast = idx === item.history.length - 1;
                      return (
                        <View key={h.id || idx} style={styles.historyItemRow}>
                          <View style={styles.timelineIndicatorColumn}>
                            <View style={[
                              styles.timelineDot,
                              { backgroundColor: isLast ? theme.accent : (isEcoMode ? '#5E5E62' : '#C7C7CC') }
                            ]} />
                            {!isLast && <View style={[styles.timelineLine, { backgroundColor: isEcoMode ? '#38383A' : '#E5E5EA' }]} />}
                          </View>
                          <View style={styles.historyItemContent}>
                            <Text style={[styles.historyItemTime, { color: theme.textTertiary }]}>
                              {h.time}
                            </Text>
                            <Text style={[
                              styles.historyItemText,
                              {
                                color: isLast ? theme.textPrimary : theme.textSecondary,
                                fontWeight: isLast ? '700' : '500',
                              }
                            ]}>
                              {h.text}
                            </Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </View>
              ) : null}


              {/* コメント行（カード画面から直接タップで編集可能） */}
              <TouchableOpacity
                style={[
                  styles.commentContainer,
                  {
                    backgroundColor: item.comment ? theme.inputBg : (isEcoMode ? '#222225' : '#F9F9FB'),
                    borderColor: item.comment ? 'transparent' : theme.cardBorder,
                    borderWidth: item.comment ? 0 : 1,
                    borderStyle: item.comment ? 'solid' : 'dashed',
                  },
                ]}
                onPress={() => handleOpenEditCommentModal(item)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={item.comment ? "chatbubble-ellipses-outline" : "add-circle-outline"}
                  size={13}
                  color={item.comment ? theme.textTertiary : theme.accent}
                  style={{ marginRight: 5 }}
                />
                <Text
                  style={[
                    styles.commentText,
                    {
                      color: item.comment ? theme.textSecondary : theme.accent,
                      fontStyle: item.comment ? 'normal' : 'italic',
                    },
                  ]}
                  numberOfLines={2}
                >
                  {item.comment ? item.comment : '＋ 施術メモを追加'}
                </Text>
                <Ionicons
                  name="pencil"
                  size={12}
                  color={theme.textTertiary}
                  style={{ marginLeft: 'auto' }}
                />
              </TouchableOpacity>

              {/* 操作ボタングループ */}
              <View style={[styles.cardActionRow, { borderColor: theme.cardBorder }]}>
                {/* ★ ユーザー指定: 左下「＋5分」を「タイム変更」にし、タップでモーダルを起動（00:00リセット時はフルタイム設定モーダルへ統一） */}
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() =>
                    isZeroPaused || item.status === 'idle'
                      ? handleOpenSetTimerModal(item)
                      : handleOpenQuickTimeAdjustModal(item)
                  }
                >
                  <Text style={[styles.actionBtnText, { color: theme.textSecondary }]}>タイム変更</Text>
                </TouchableOpacity>

                <View style={[styles.actionDivider, { backgroundColor: theme.cardBorder }]} />

                {/* ★ ユーザー指定: 一時停止を「リセット」に変更。タイムを0に戻し、カードは開いたまま、チェックも消え、自分以外の関係者へ通知 */}
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => handleConfirmResetSeatTimer(item)}
                >
                  <Text style={[styles.actionBtnText, { color: theme.textSecondary }]}>
                    リセット
                  </Text>
                </TouchableOpacity>

                <View style={[styles.actionDivider, { backgroundColor: theme.cardBorder }]} />

                {/* 施術終了（削除せず待機中スリムバーに戻す） */}
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => handleFinishSeat(item.id)}
                >
                  <Text style={[styles.actionBtnText, { color: theme.danger }]}>施術終了</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })}

        {/* 席マスター追加ボタン（一番下：招待元オーナーのみ表示。ゲストで0席時は同期案内を表示） */}
        {isSalonOwner ? (
          <TouchableOpacity
            style={[styles.bottomAddSeatBar, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}
            onPress={() => {
              setNewSeatName(`${getNextSuggestedSeatNumber()}番席`);
              setIsAddSeatModalVisible(true);
            }}
          >
            <Ionicons name="add-circle-outline" size={18} color={theme.accent} style={{ marginRight: 6 }} />
            <Text style={[styles.bottomAddSeatText, { color: theme.accent }]}>
              新しい席番号を追加する
            </Text>
          </TouchableOpacity>
        ) : seats.length === 0 ? (
          <View
            style={[
              styles.bottomAddSeatBar,
              {
                backgroundColor: theme.cardBg,
                borderColor: theme.cardBorder,
                flexDirection: 'column',
                paddingVertical: 18,
              },
            ]}
          >
            <Ionicons name="sync-outline" size={20} color={theme.textSecondary} style={{ marginBottom: 6 }} />
            <Text style={{ fontSize: 13, fontWeight: '700', color: theme.textPrimary, marginBottom: 3 }}>
              招待元の客席データを同期中
            </Text>
            <Text style={{ fontSize: 11.5, color: theme.textSecondary, textAlign: 'center' }}>
              サロン作成者（招待元）側で登録された席が自動的に表示されます
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {/* ======================================================== */}
      {/* モーダル群                                                */}
      {/* ======================================================== */}

      {/* ① サロン・グループ・個人無料枠 切り替えシート */}
      <Modal
        visible={isSwitcherModalVisible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => {
          if (switcherSubView === 'inviteCode') {
            setSwitcherSubView('list');
          } else {
            setIsSwitcherModalVisible(false);
          }
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalCard, { backgroundColor: theme.cardBg }]}>
            <View style={styles.modalHeader}>
              {switcherSubView === 'inviteCode' ? (
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center' }}
                  onPress={() => setSwitcherSubView('list')}
                  activeOpacity={0.7}
                >
                  <Ionicons name="chevron-back" size={22} color={theme.accent} style={{ marginRight: 4 }} />
                  <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>
                    招待コードの確認・共有
                  </Text>
                </TouchableOpacity>
              ) : (
                <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>
                  ワークスペースの切り替え
                </Text>
              )}
              <TouchableOpacity
                onPress={() => {
                  setSwitcherSubView('list');
                  setIsSwitcherModalVisible(false);
                }}
              >
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            {switcherSubView === 'list' ? (
              <>
                {/* 👤 あなたの表示名（ニックネーム）設定カード */}
                <View
                  style={[
                    styles.userNameCard,
                    {
                      backgroundColor: isEcoMode ? '#252528' : '#F6F8FA',
                      borderColor: isEditingUserName ? theme.accent : theme.cardBorder,
                    },
                  ]}
                >
                  {!isEditingUserName ? (
                    <View style={styles.userNameDisplayRow}>
                      <View style={styles.userNameLeft}>
                        <Ionicons
                          name="person-circle"
                          size={32}
                          color={theme.accent}
                          style={{ marginRight: 8 }}
                        />
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.userNameSectionLabel, { color: theme.textTertiary }]}>
                            あなたの表示名（サロン・Watch共通）
                          </Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 1 }}>
                            <Text style={[styles.userNameValue, { color: theme.textPrimary }]}>
                              {userName || '未設定'}
                            </Text>
                            <Text style={[styles.userNameHintSmall, { color: theme.textTertiary }]}>
                              （推奨: 3〜5文字）
                            </Text>
                          </View>
                        </View>
                      </View>
                      <TouchableOpacity
                        style={[
                          styles.userNameEditBtn,
                          { backgroundColor: theme.cardBg, borderColor: theme.cardBorder },
                        ]}
                        onPress={() => {
                          setInputUserName(userName || '');
                          setIsEditingUserName(true);
                        }}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="pencil" size={13} color={theme.accent} style={{ marginRight: 4 }} />
                        <Text style={[styles.userNameEditBtnText, { color: theme.accent }]}>変更</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={styles.userNameEditBox}>
                      <View style={styles.userNameEditHeader}>
                        <Text style={[styles.userNameSectionLabel, { color: theme.textTertiary }]}>
                          表示名（ニックネーム）の変更
                        </Text>
                        <Text style={[styles.userNameWatchHint, { color: theme.accent }]}>
                          Watch推奨: 3〜5文字
                        </Text>
                      </View>
                      <View style={styles.userNameInputRow}>
                        <TextInput
                          style={[
                            styles.userNameTextInput,
                            {
                              backgroundColor: theme.cardBg,
                              color: theme.textPrimary,
                              borderColor: theme.cardBorder,
                            },
                          ]}
                          value={inputUserName}
                          onChangeText={setInputUserName}
                          placeholder="例: タグチ、KEN、サトウ"
                          placeholderTextColor={theme.textTertiary}
                          maxLength={10}
                          autoFocus={true}
                        />
                        <TouchableOpacity
                          style={[styles.userNameSaveBtn, { backgroundColor: theme.accent }]}
                          onPress={handleSaveUserName}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.userNameSaveBtnText}>保存</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[
                            styles.userNameCancelBtn,
                            { backgroundColor: theme.cardBg, borderColor: theme.cardBorder },
                          ]}
                          onPress={() => setIsEditingUserName(false)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.userNameCancelBtnText, { color: theme.textSecondary }]}>✕</Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={[styles.userNameCharCount, { color: theme.textTertiary }]}>
                        {inputUserName.length}/10文字 （カタカナ・英字・漢字対応）
                      </Text>
                    </View>
                  )}
                </View>

                <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 340 }}>
                  <Text style={[styles.sheetSectionTitle, { color: theme.textSecondary }]}>ワークスペース / サロン</Text>
                  {savedSalons.map((salon) => {
                    const isSelected = salon.id === currentSalon?.id;
                    return (
                      <TouchableOpacity
                        key={salon.id}
                        style={[
                          styles.salonSelectItem,
                          {
                            backgroundColor: isSelected ? theme.accentLight : theme.inputBg,
                            borderColor: isSelected ? theme.accent : theme.cardBorder,
                          },
                        ]}
                        onPress={() => handleSelectSalon(salon)}
                        onLongPress={() => {
                          if (salon.id !== 'workspace-free') {
                            handleDeleteSalon(salon);
                          }
                        }}
                        activeOpacity={0.7}
                      >
                        <View style={styles.salonSelectLeft}>
                          <Ionicons
                            name={
                              salon.type === 'group'
                                ? 'people'
                                : salon.type === 'pair'
                                ? 'person-add'
                                : 'business'
                            }
                            size={22}
                            color={isSelected ? theme.accent : theme.textSecondary}
                            style={{ marginRight: 10 }}
                          />
                          <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                              <Text style={[styles.salonSelectName, { color: theme.textPrimary }]} numberOfLines={1}>
                                {salon.name}
                              </Text>
                              {salon.isPro ? (
                                <View style={[styles.proBadge, { backgroundColor: '#FFD700', marginLeft: 6 }]}>
                                  <Text style={styles.proBadgeText}>PRO</Text>
                                </View>
                              ) : null}
                            </View>
                            <Text style={[styles.salonSelectDesc, { color: theme.textSecondary }]} numberOfLines={1}>
                              {salon.description}
                            </Text>
                          </View>
                        </View>

                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          {/* 🔑 招待コードボタン（押した後にモーダル内でコード確認・共有画面にスムーズ切り替え） */}
                          <TouchableOpacity
                            style={[
                              styles.inviteCodeTriggerBtn,
                              {
                                backgroundColor: isSelected ? theme.cardBg : (isEcoMode ? '#2C2C2E' : '#FFFFFF'),
                                borderColor: isSelected ? theme.accent : theme.cardBorder,
                              },
                            ]}
                            onPress={(e) => {
                              e.stopPropagation();
                              setEditingSalonForCode(salon);
                              setInputNewInviteCode(salon.inviteCode);
                              setSwitcherSubView('inviteCode');
                            }}
                            activeOpacity={0.7}
                          >
                            <Ionicons name="key-outline" size={13} color={theme.accent} style={{ marginRight: 4 }} />
                            <Text style={[styles.inviteCodeTriggerBtnText, { color: theme.accent }]}>招待コード</Text>
                          </TouchableOpacity>

                          {/* 🗑️ 削除ボタン（デフォルトのタイマー同期モード以外） */}
                          {salon.id !== 'workspace-free' && (
                            <TouchableOpacity
                              style={{ padding: 4 }}
                              onPress={(e) => {
                                e.stopPropagation();
                                handleDeleteSalon(salon);
                              }}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            >
                              <Ionicons name="trash-outline" size={17} color={theme.textTertiary} />
                            </TouchableOpacity>
                          )}

                          {isSelected ? (
                            <Ionicons name="checkmark-circle" size={20} color={theme.accent} />
                          ) : null}
                        </View>
                      </TouchableOpacity>
                    );
                  })}

                  {/* サロン共有モード（3人以上の店舗・チーム共有）が未登録の場合の対比案内 */}
                  {savedSalons.filter((s) => s.type === 'salon' || s.type === 'group').length === 0 && (
                    <View
                      style={{
                        padding: 14,
                        borderRadius: 12,
                        backgroundColor: isEcoMode ? '#222225' : '#F8F9FA',
                        borderColor: theme.cardBorder,
                        borderWidth: 1,
                        marginTop: 10,
                        marginBottom: 10,
                        alignItems: 'center',
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                        <Ionicons name="business-outline" size={17} color={theme.textTertiary} style={{ marginRight: 6 }} />
                        <Text style={{ fontSize: 13, fontWeight: '700', color: theme.textPrimary }}>
                          サロン共有モード（3人以上）
                        </Text>
                        <View style={[styles.proBadge, { backgroundColor: '#FFD700', marginLeft: 6 }]}>
                          <Text style={styles.proBadgeText}>PRO</Text>
                        </View>
                      </View>
                      <Text style={{ fontSize: 11, color: theme.textSecondary, textAlign: 'center', lineHeight: 16 }}>
                        3人以上のスタッフでタイマーをリアルタイム同期する場合は、PROプランのサロン共有モードをご利用ください。
                      </Text>
                      <View
                        style={{
                          marginTop: 8,
                          paddingVertical: 4,
                          paddingHorizontal: 10,
                          borderRadius: 6,
                          backgroundColor: theme.accentLight,
                        }}
                      >
                        <Text style={{ fontSize: 10, color: theme.accent, fontWeight: '600', textAlign: 'center' }}>
                          💡 2人までのタイマー同期はずっと完全無料です
                        </Text>
                      </View>

                      {/* 🧪 開発・テスト用ボタン（本番リリースビルドでは自動非表示） */}
                      {(typeof __DEV__ !== 'undefined' && __DEV__ || isDevTestMode) && (
                        <TouchableOpacity
                          style={{
                            marginTop: 10,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: '#10B981',
                            paddingVertical: 7,
                            paddingHorizontal: 12,
                            borderRadius: 8,
                          }}
                          onPress={handleCreateTestProSalon}
                          activeOpacity={0.7}
                        >
                          <Ionicons name="flask" size={14} color="#FFFFFF" style={{ marginRight: 6 }} />
                          <Text style={{ fontSize: 11, fontWeight: '700', color: '#FFFFFF' }}>
                            🧪 サロン共有モードをテスト作成（開発用）
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </ScrollView>

                <View style={styles.switcherActionRow}>
                  <TouchableOpacity
                    style={[styles.switcherActionBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                    onPress={() => {
                      setIsSwitcherModalVisible(false);
                      setInputInviteCode('');
                      setInputStaffName(userName || 'アシスタント');
                      setIsJoinCodeModalVisible(true);
                    }}
                  >
                    <Ionicons name="key-outline" size={16} color={theme.accent} style={{ marginRight: 4 }} />
                    <Text style={[styles.switcherActionBtnText, { color: theme.accent }]}>コードで参加</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.switcherActionBtn, { backgroundColor: theme.accentLight, borderColor: theme.accentBorder }]}
                    onPress={() => {
                      setIsSwitcherModalVisible(false);
                      setIsProModalVisible(true);
                    }}
                  >
                    <Ionicons name="star-outline" size={16} color={theme.accent} style={{ marginRight: 4 }} />
                    <Text style={[styles.switcherActionBtnText, { color: theme.accent }]}>PROプラン</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              /* 🔑 招待コードの確認・共有・変更ビュー（押した後に確実に表示される！） */
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 6 }}>
                {/* 対象サロンの概要 */}
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: isEcoMode ? '#252528' : '#F6F8FA',
                    padding: 12,
                    borderRadius: 12,
                    borderColor: theme.cardBorder,
                    borderWidth: 1,
                    marginBottom: 14,
                  }}
                >
                  <Ionicons
                    name={
                      editingSalonForCode?.type === 'group'
                        ? 'people'
                        : editingSalonForCode?.type === 'pair'
                        ? 'person-add'
                        : 'business'
                    }
                    size={26}
                    color={theme.accent}
                    style={{ marginRight: 10 }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: theme.textPrimary }} numberOfLines={1}>
                      {editingSalonForCode?.name || 'サロン'}
                    </Text>
                    <Text style={{ fontSize: 11, color: theme.textSecondary }}>
                      {editingSalonForCode?.description}
                    </Text>
                  </View>
                </View>

                <Text style={[styles.codeModalHintText, { color: theme.textSecondary }]}>
                  {editingSalonForCode?.type === 'pair'
                    ? 'ペア相手にこの招待コードを伝えると、2人でタイマーをリアルタイム同期（無料）できます。'
                    : 'スタッフにこの招待コードを伝えてサロンに参加してもらいます。'}
                </Text>

                {/* 🔑 大きな招待コード表示ボックス */}
                <View
                  style={{
                    backgroundColor: isEcoMode ? '#1C1C1E' : '#F0F8FF',
                    borderColor: theme.accent,
                    borderWidth: 1.5,
                    borderRadius: 16,
                    paddingVertical: 18,
                    alignItems: 'center',
                    marginBottom: 14,
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '600', color: theme.textSecondary, marginBottom: 4 }}>
                    {editingSalonForCode?.type === 'pair' ? 'タイマー同期のペア招待コード（無料）' : 'このサロンの招待コード'}
                  </Text>
                  <Text style={{ fontSize: 32, fontWeight: '800', letterSpacing: 3, color: theme.accent }}>
                    {editingSalonForCode?.inviteCode || '---'}
                  </Text>
                </View>

                {/* 📤 共有 / コピー ボタン */}
                <TouchableOpacity
                  style={[styles.codeShareFullBtn, { backgroundColor: theme.accent, borderColor: theme.accent }]}
                  onPress={() => handleShareInviteCode(editingSalonForCode)}
                  activeOpacity={0.7}
                >
                  <Ionicons name="share-outline" size={18} color="#FFFFFF" style={{ marginRight: 6 }} />
                  <Text style={[styles.codeShareFullBtnText, { color: '#FFFFFF' }]}>
                    {editingSalonForCode?.type === 'pair' ? 'ペア招待コードを共有 / コピー' : '招待コードを共有 / コピー'}
                  </Text>
                </TouchableOpacity>

                {/* コードの直接変更・再生成セクション（招待元オーナーのみ編集可） */}
                {checkIsSalonOwner(editingSalonForCode, myUserId) ? (
                  <View
                    style={{
                      marginTop: 12,
                      paddingTop: 12,
                      borderTopWidth: 1,
                      borderTopColor: theme.cardBorder,
                    }}
                  >
                    <Text style={[styles.inputLabel, { color: theme.textSecondary, marginBottom: 6 }]}>
                      コードの変更・再発行（任意）
                    </Text>
                    <View style={styles.codeModalInputRow}>
                      <TextInput
                        style={[
                          styles.codeModalTextInput,
                          {
                            backgroundColor: theme.inputBg,
                            color: theme.accent,
                            borderColor: theme.cardBorder,
                          },
                        ]}
                        placeholder="例: 000-000"
                        placeholderTextColor={theme.textTertiary}
                        value={inputNewInviteCode}
                        onChangeText={setInputNewInviteCode}
                        autoCapitalize="characters"
                        maxLength={15}
                      />
                      <TouchableOpacity
                        style={[styles.codeRandomBtn, { backgroundColor: theme.accentLight, borderColor: theme.accentBorder }]}
                        onPress={handleRegenerateRandomCode}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="shuffle" size={16} color={theme.accent} style={{ marginRight: 4 }} />
                        <Text style={[styles.codeRandomBtnText, { color: theme.accent }]}>再生成</Text>
                      </TouchableOpacity>
                    </View>

                    <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                      <TouchableOpacity
                        style={[styles.submitButton, { flex: 1, backgroundColor: theme.cardBg, borderColor: theme.cardBorder, borderWidth: 1 }]}
                        onPress={() => setSwitcherSubView('list')}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.submitButtonText, { color: theme.textSecondary }]}>戻る</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.submitButton, { flex: 2, backgroundColor: theme.accent }]}
                        onPress={handleSaveCustomInviteCode}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.submitButtonText}>保存する</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View
                    style={{
                      marginTop: 12,
                      paddingTop: 12,
                      borderTopWidth: 1,
                      borderTopColor: theme.cardBorder,
                    }}
                  >
                    <Text style={{ fontSize: 11.5, color: theme.textTertiary, textAlign: 'center', marginBottom: 10 }}>
                      ※招待コードの変更・再発行はサロン作成者（招待元）のみ行えます
                    </Text>
                    <TouchableOpacity
                      style={[styles.submitButton, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, borderWidth: 1 }]}
                      onPress={() => setSwitcherSubView('list')}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.submitButtonText, { color: theme.textSecondary }]}>戻る</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ② 招待コードで参加モーダル */}
      <Modal
        visible={isJoinCodeModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsJoinCodeModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalCard, { backgroundColor: theme.cardBg, maxWidth: 400, borderRadius: 16, padding: 20 }]}>
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="enter-outline" size={22} color={theme.accent} style={{ marginRight: 8 }} />
                <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>サロンに参加する</Text>
              </View>
              <TouchableOpacity onPress={() => setIsJoinCodeModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              bounces={false}
            >
              <Text style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 14, lineHeight: 17 }}>
                親端末（オーナー）に表示されている6桁の招待コードを入力すると、同じサロンの客席タイマーをリアルタイム共有できます。
              </Text>

              {/* 1. あなたのお名前（スタッフ名） */}
              <Text style={[styles.inputLabel, { color: theme.textPrimary, fontWeight: '700' }]}>
                あなたのスタッフ名 <Text style={{ color: '#FF3B30', fontSize: 11 }}>*</Text>
              </Text>
              <TextInput
                style={[
                  styles.textInput,
                  {
                    backgroundColor: theme.inputBg,
                    color: theme.textPrimary,
                    borderColor: theme.cardBorder,
                    marginBottom: 12,
                    fontSize: 15,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                  },
                ]}
                placeholder="例: アシスタント田中、スタイリスト佐藤"
                placeholderTextColor={theme.textTertiary}
                value={inputStaffName}
                onChangeText={setInputStaffName}
                maxLength={15}
                returnKeyType="next"
              />

              {/* 2. 6桁の招待コード */}
              <Text style={[styles.inputLabel, { color: theme.textPrimary, fontWeight: '700' }]}>
                6桁の招待コード <Text style={{ color: '#FF3B30', fontSize: 11 }}>*</Text>
              </Text>
              <TextInput
                style={[
                  styles.textInput,
                  {
                    backgroundColor: theme.inputBg,
                    color: theme.accent,
                    borderColor: theme.cardBorder,
                    marginBottom: 12,
                    fontSize: inputInviteCode ? 22 : 17,
                    fontWeight: inputInviteCode ? '800' : '500',
                    letterSpacing: inputInviteCode ? 2 : 1,
                    textAlign: 'center',
                    paddingVertical: 10,
                  },
                ]}
                placeholder="例: 000-000"
                placeholderTextColor={theme.textTertiary}
                value={inputInviteCode}
                onChangeText={setInputInviteCode}
                autoCapitalize="characters"
                returnKeyType="next"
              />

              {/* 3. サロンの表示名（任意） */}
              <Text style={[styles.inputLabel, { color: theme.textSecondary }]}>サロンの表示名 (任意)</Text>
              <TextInput
                style={[
                  styles.textInput,
                  {
                    backgroundColor: theme.inputBg,
                    color: theme.textPrimary,
                    borderColor: theme.cardBorder,
                    marginBottom: 18,
                    fontSize: 14,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                  },
                ]}
                placeholder="例: メインサロン、2Fチームなど (未入力可)"
                placeholderTextColor={theme.textTertiary}
                value={inputSalonName}
                onChangeText={setInputSalonName}
                returnKeyType="done"
                onSubmitEditing={handleJoinByCode}
              />

              <TouchableOpacity
                style={[
                  styles.submitButton,
                  {
                    backgroundColor: theme.accent,
                    paddingVertical: 13,
                    borderRadius: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                ]}
                onPress={handleJoinByCode}
                activeOpacity={0.8}
              >
                <Ionicons name="checkmark-circle-outline" size={18} color="#FFFFFF" style={{ marginRight: 6 }} />
                <Text style={[styles.submitButtonText, { fontSize: 15, fontWeight: '700' }]}>このサロンに参加する</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ③ 待機席のタイム設定モーダル */}
      <Modal
        visible={isSetTimerModalVisible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setIsSetTimerModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalCard, { backgroundColor: theme.cardBg }]}>
            <View style={styles.modalHeader}>
              {isEditingSeatLabel ? (
                <View style={styles.modalSeatLabelInputRow}>
                  <Ionicons name="pencil" size={15} color={theme.accent} style={{ marginRight: 6 }} />
                  <TextInput
                    style={[
                      styles.modalSeatLabelInput,
                      {
                        backgroundColor: theme.inputBg,
                        color: theme.textPrimary,
                        borderColor: theme.accent,
                      },
                    ]}
                    value={modalSeatLabel}
                    onChangeText={setModalSeatLabel}
                    placeholder="席名を入力"
                    placeholderTextColor={theme.textTertiary}
                    autoFocus={true}
                    maxLength={20}
                    returnKeyType="done"
                    onSubmitEditing={handleSaveSeatLabel}
                    selectTextOnFocus={true}
                  />
                  <TouchableOpacity
                    style={[styles.modalSeatLabelSaveBtn, { backgroundColor: theme.accent }]}
                    onPress={handleSaveSeatLabel}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="checkmark" size={16} color="#FFFFFF" style={{ marginRight: 2 }} />
                    <Text style={styles.modalSeatLabelSaveBtnText}>保存</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.modalHeaderLeftGroup}>
                  {/* ★ ユーザー指定: タイム設定画面で「2番席」等の名前を変更できるようにする（オーナーのみ編集可） */}
                  {isSalonOwner ? (
                    <TouchableOpacity
                      style={[
                        styles.modalSeatLabelPill,
                        {
                          backgroundColor: isEcoMode ? '#1E293B' : '#EFF6FF',
                          borderColor: theme.accent,
                        },
                      ]}
                      onPress={() => setIsEditingSeatLabel(true)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="pencil" size={13} color={theme.accent} style={{ marginRight: 4 }} />
                      <Text style={[styles.modalSeatLabelPillText, { color: theme.accent }]} numberOfLines={1}>
                        {modalSeatLabel || '席名'}
                      </Text>
                      <Text style={[styles.modalSeatLabelEditHint, { color: theme.accent }]}>編集</Text>
                    </TouchableOpacity>
                  ) : (
                    <View
                      style={[
                        styles.modalSeatLabelPill,
                        {
                          backgroundColor: isEcoMode ? '#1E293B' : '#EFF6FF',
                          borderColor: theme.accent,
                        },
                      ]}
                    >
                      <Text style={[styles.modalSeatLabelPillText, { color: theme.accent }]} numberOfLines={1}>
                        {modalSeatLabel || '席名'}
                      </Text>
                    </View>
                  )}

                  <Text style={[styles.modalTitleSuffix, { color: theme.textPrimary }]}>
                    {timerSetupMode === 'additional'
                      ? 'の追加タイム設定'
                      : timerSetupMode === 'new'
                      ? 'の新規タイマー設定'
                      : isEditingExistingTimer
                      ? 'のタイマー変更'
                      : 'のタイム設定'}
                  </Text>
                </View>
              )}

              <TouchableOpacity
                onPress={() => {
                  setIsEditingSeatLabel(false);
                  setIsSetTimerModalVisible(false);
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* 放置タイム設定（直接入力 ＆ クイックピル ＆ 微調整 ＆ お気に入りパネル） */}
              <View style={styles.timeSettingHeaderRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={[styles.inputLabel, { color: theme.textSecondary, marginBottom: 0 }]}>放置タイム</Text>
                  <Text style={{ fontSize: 11, color: theme.textTertiary }}>(直接入力可)</Text>
                </View>
                <View style={styles.customTimeInputContainer}>
                  <TextInput
                    style={[
                      styles.customTimeNumberInput,
                      {
                        backgroundColor: theme.inputBg,
                        color: theme.accent,
                        borderColor: theme.accent,
                      },
                    ]}
                    keyboardType="number-pad"
                    maxLength={3}
                    value={modalTargetMinutes !== '' && modalTargetMinutes !== undefined && modalTargetMinutes !== null ? String(modalTargetMinutes) : ''}
                    onChangeText={(val) => {
                      const clean = val.replace(/[^0-9]/g, '');
                      setModalTargetMinutes(clean === '' ? '' : parseInt(clean, 10));
                      setModalTargetSeconds(0);
                    }}
                    placeholder="0"
                    placeholderTextColor={theme.textTertiary}
                    selectTextOnFocus={true}
                  />
                  <Text style={[styles.customTimeUnitText, { color: theme.textPrimary }]}>分</Text>
                  <View style={[styles.timeCurrentBadge, { backgroundColor: theme.accentLight, borderColor: theme.accentBorder, marginLeft: 6 }]}>
                    <Text style={[styles.timeCurrentBadgeText, { color: theme.accent }]}>
                      現在: {formatModalTargetTime(modalTargetMinutes, modalTargetSeconds)}
                    </Text>
                  </View>
                </View>
              </View>

              {/* クイック選択ピル（1分、3分、5分、7分、10分、15分、20分、30分） */}
              <View style={styles.timePillRow}>
                {[1, 3, 5, 7, 10, 15, 20, 30].map((min) => {
                  const isPillSelected = Number(modalTargetMinutes) === min && (Number(modalTargetSeconds) || 0) === 0;
                  return (
                    <TouchableOpacity
                      key={min}
                      style={[
                        styles.timePill,
                        {
                          backgroundColor: isPillSelected ? theme.accent : theme.inputBg,
                          borderColor: isPillSelected ? theme.accent : theme.cardBorder,
                        },
                      ]}
                      onPress={() => handleSelectQuickMinute(min)}
                    >
                      <Text
                        style={[
                          styles.timePillText,
                          { color: isPillSelected ? '#FFFFFF' : theme.textPrimary },
                        ]}
                      >
                        {min}分
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* 1分・5分単位の微調整ボタンバー */}
              <View style={styles.timeAdjustBar}>
                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetMinutes(-5)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.textPrimary }]}>-5分</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetMinutes(-1)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.textPrimary }]}>-1分</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetMinutes(1)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.textPrimary }]}>+1分</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetMinutes(5)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.textPrimary }]}>+5分</Text>
                </TouchableOpacity>
              </View>

              {/* ★ ユーザー指定: 10秒・30秒単位の微調整ボタンバー（1段追加: -30秒, -10秒, +10秒, +30秒） */}
              <View style={[styles.timeAdjustBar, { marginTop: 4, marginBottom: 8 }]}>
                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetSeconds(-30)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.textSecondary }]}>-30秒</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetSeconds(-10)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.textSecondary }]}>-10秒</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetSeconds(10)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.accent }]}>+10秒</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetSeconds(30)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.accent }]}>+30秒</Text>
                </TouchableOpacity>
              </View>

              {/* ★ ユーザー指定: チェックタイマーのクイックチップ選択（なし、3分、5分、7分、10分、15分） */}
              <View
                style={[
                  styles.checkSettingSection,
                  {
                    backgroundColor: isEcoMode ? '#1C1C1E' : '#F8FAF9',
                    borderColor: modalCheckMinutes > 0 ? '#10B981' : theme.cardBorder,
                  },
                ]}
              >
                <View style={styles.checkSettingHeader}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <Ionicons
                      name="search-outline"
                      size={14}
                      color={modalCheckMinutes > 0 ? '#10B981' : theme.textSecondary}
                    />
                    <Text
                      style={[
                        styles.checkSettingTitle,
                        {
                          color: modalCheckMinutes > 0 ? theme.textPrimary : theme.textSecondary,
                          fontWeight: '700',
                        },
                      ]}
                    >
                      チェックタイマー
                    </Text>
                    <Text style={{ fontSize: 11, color: theme.textTertiary }}>
                      (途中の発色確認)
                    </Text>
                  </View>

                  <View
                    style={[
                      styles.checkCurrentBadge,
                      {
                        backgroundColor: modalCheckMinutes > 0 ? (isEcoMode ? '#0B2416' : '#ECFDF5') : theme.inputBg,
                        borderColor: modalCheckMinutes > 0 ? '#10B981' : theme.cardBorder,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.checkCurrentBadgeText,
                        {
                          color: modalCheckMinutes > 0 ? '#059669' : theme.textTertiary,
                        },
                      ]}
                    >
                      {modalCheckMinutes > 0
                        ? `チェック: ${formatModalTargetTime(modalCheckMinutes, modalCheckSeconds)}`
                        : 'チェック: なし'}
                    </Text>
                  </View>
                </View>

                {/* クイックチップ選択 */}
                <View style={styles.checkChipsRow}>
                  {[
                    { min: 0, label: 'なし' },
                    { min: 3, label: '3分' },
                    { min: 5, label: '5分' },
                    { min: 7, label: '7分' },
                    { min: 10, label: '10分' },
                    { min: 15, label: '15分' },
                  ].map((chip) => {
                    const isSelected =
                      (chip.min === 0 && (Number(modalCheckMinutes) === 0 || !modalCheckMinutes)) ||
                      (chip.min > 0 && Number(modalCheckMinutes) === chip.min && (Number(modalCheckSeconds) || 0) === 0);

                    return (
                      <TouchableOpacity
                        key={chip.min}
                        style={[
                          styles.checkChip,
                          {
                            backgroundColor: isSelected
                              ? (chip.min === 0 ? theme.textSecondary : '#10B981')
                              : theme.inputBg,
                            borderColor: isSelected
                              ? (chip.min === 0 ? theme.textSecondary : '#10B981')
                              : theme.cardBorder,
                          },
                        ]}
                        onPress={() => handleSelectCheckMinute(chip.min)}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            styles.checkChipText,
                            {
                              color: isSelected ? '#FFFFFF' : theme.textPrimary,
                              fontWeight: isSelected ? '700' : '500',
                            },
                          ]}
                        >
                          {chip.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}

                  {/* チェックタイマー微調整ボタン（-1分 / +1分） */}
                  {modalCheckMinutes > 0 && (
                    <View style={{ flexDirection: 'row', gap: 4, marginLeft: 'auto' }}>
                      <TouchableOpacity
                        style={[styles.checkAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                        onPress={() => handleAdjustCheckMinutes(-1)}
                      >
                        <Text style={[styles.checkAdjustBtnText, { color: theme.textSecondary }]}>-1分</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.checkAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                        onPress={() => handleAdjustCheckMinutes(1)}
                      >
                        <Text style={[styles.checkAdjustBtnText, { color: '#059669' }]}>+1分</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>

                {/* ★ チェックタイマー設定時、チェック内容（4種・シャンプー完全除外）とチェック担当スタッフを同時に指定可能 */}
                {modalCheckMinutes > 0 && (
                  <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderColor: isEcoMode ? '#2C2C2E' : '#E5E7EB' }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textSecondary, marginBottom: 6 }}>
                      🔍 チェック内容（中間工程）:
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      {CHECK_PROCESS_OPTIONS.map((proc) => {
                        const isProcSelected = sanitizeCheckProcess(modalCheckProcess) === proc;
                        return (
                          <TouchableOpacity
                            key={`modal-chk-proc-${proc}`}
                            style={[
                              styles.checkStaffChip,
                              {
                                backgroundColor: isProcSelected ? '#0EA5E9' : theme.inputBg,
                                borderColor: isProcSelected ? '#0EA5E9' : theme.cardBorder,
                              },
                            ]}
                            onPress={() => setModalCheckProcess(proc)}
                            activeOpacity={0.7}
                          >
                            <Text
                              style={{
                                fontSize: 11,
                                fontWeight: isProcSelected ? '700' : '600',
                                color: isProcSelected ? '#FFFFFF' : theme.textPrimary,
                              }}
                            >
                              {proc}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textSecondary }}>
                        🔍 チェック担当スタッフ（省略可）:
                      </Text>
                      {modalCheckStaffName ? (
                        <TouchableOpacity onPress={() => setModalCheckStaffName('')}>
                          <Text style={{ fontSize: 11, color: theme.accent }}>未定に戻す</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      {salonStaffList.map((staff) => {
                        const isSelected = modalCheckStaffName === staff;
                        return (
                          <TouchableOpacity
                            key={staff}
                            style={[
                              styles.checkStaffChip,
                              {
                                backgroundColor: isSelected ? '#10B981' : theme.inputBg,
                                borderColor: isSelected ? '#10B981' : theme.cardBorder,
                              },
                            ]}
                            onPress={() => setModalCheckStaffName(isSelected ? '' : staff)}
                            activeOpacity={0.7}
                          >
                            <Text
                              style={{
                                fontSize: 11,
                                fontWeight: isSelected ? '700' : '600',
                                color: isSelected ? '#FFFFFF' : theme.textPrimary,
                              }}
                            >
                              {formatStaffForDisplay(staff)}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}
              </View>

              {/* ★ お気に入りパネル */}
              <View style={[styles.favPanelContainer, { backgroundColor: isEcoMode ? '#1C1C1E' : '#F7F8FC', borderColor: theme.cardBorder }]}>
                <View style={styles.favPanelHeaderRow}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <Ionicons name="star" size={14} color="#FFB800" />
                    <Text style={[styles.favPanelTitle, { color: theme.textPrimary }]}>お気に入りパネル</Text>
                  </View>
                  {!isAddingFavorite ? (
                    <TouchableOpacity
                      style={[styles.favAddQuickBtn, { borderColor: theme.accent, backgroundColor: theme.accentLight }]}
                      onPress={() => {
                        setIsAddingFavorite(true);
                        setNewFavoriteLabel('');
                      }}
                    >
                      <Ionicons name="add" size={13} color={theme.accent} />
                      <Text style={[styles.favAddQuickBtnText, { color: theme.accent }]}>
                        ★ {formatModalTargetTime(modalTargetMinutes, modalTargetSeconds)}
                        {modalCheckMinutes > 0 ? `+C${modalCheckMinutes}分` : ''}を登録
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>

                {/* お気に入り新規登録のインラインフォーム */}
                {isAddingFavorite && (
                  <View style={[styles.favInlineAddForm, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}>
                    <Text style={[styles.favInlineAddTitle, { color: theme.textSecondary }]}>
                      【{formatModalTargetTime(modalTargetMinutes, modalTargetSeconds)}
                      {modalCheckMinutes > 0 ? ` + チェック${formatModalTargetTime(modalCheckMinutes, modalCheckSeconds)}` : ''}】のお気に入り名 (省略可)
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
                      <TextInput
                        style={[styles.favInlineInput, { backgroundColor: theme.inputBg, color: theme.textPrimary, borderColor: theme.cardBorder }]}
                        placeholder="例: 乳化、白髪染め、酸熱など"
                        placeholderTextColor={theme.textTertiary}
                        value={newFavoriteLabel}
                        onChangeText={setNewFavoriteLabel}
                        autoFocus={true}
                      />
                      <TouchableOpacity
                        style={[styles.favInlineSubmitBtn, { backgroundColor: theme.accent }]}
                        onPress={() => handleAddCurrentAsFavorite()}
                      >
                        <Text style={styles.favInlineSubmitBtnText}>登録</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.favInlineCancelBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                        onPress={() => setIsAddingFavorite(false)}
                      >
                        <Text style={[styles.favInlineCancelBtnText, { color: theme.textSecondary }]}>取消</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {/* お気に入りチップ一覧 */}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.favChipsScroll}
                >
                  {favoritePresets.map((fav) => {
                    const isSelected =
                      Number(modalTargetMinutes) === fav.minutes &&
                      (Number(modalTargetSeconds) || 0) === (fav.seconds || 0) &&
                      (Number(modalCheckMinutes) || 0) === (fav.checkMinutes || 0) &&
                      (Number(modalCheckSeconds) || 0) === (fav.checkSeconds || 0);
                    return (
                      <View
                        key={fav.id}
                        style={[
                          styles.favChipWrapper,
                          {
                            backgroundColor: isSelected ? theme.accent : (isEcoMode ? '#28282B' : '#FFFFFF'),
                            borderColor: isSelected ? theme.accent : theme.cardBorder,
                          },
                        ]}
                      >
                        <TouchableOpacity
                          style={styles.favChipPressable}
                          onPress={() => handleSelectFavoritePreset(fav)}
                        >
                          <Ionicons
                            name={isSelected ? 'star' : 'star'}
                            size={12}
                            color={isSelected ? '#FFFFFF' : '#FFB800'}
                            style={{ marginRight: 3 }}
                          />
                          <Text
                            style={[
                              styles.favChipMinutes,
                              { color: isSelected ? '#FFFFFF' : theme.textPrimary },
                            ]}
                          >
                            {formatModalTargetTime(fav.minutes, fav.seconds || 0)}
                            {fav.checkMinutes ? ` (C${fav.checkMinutes}分)` : ''}
                          </Text>
                          {fav.label ? (
                            <Text
                              style={[
                                styles.favChipLabel,
                                { color: isSelected ? '#FFFFFF' : theme.textSecondary },
                              ]}
                              numberOfLines={1}
                            >
                              {fav.label}
                            </Text>
                          ) : null}
                        </TouchableOpacity>
                        <TouchableOpacity
                          hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
                          style={styles.favChipDeleteBtn}
                          onPress={() => handleDeleteFavoritePreset(fav.id)}
                        >
                          <Ionicons
                            name="close-circle"
                            size={14}
                            color={isSelected ? 'rgba(255,255,255,0.7)' : theme.textTertiary}
                          />
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </ScrollView>
              </View>

              {/* ★ ユーザー指定: 共有タイマーのタイマー入力画面一番下に、上段「ウォッチのアラーム音 ON/OFF」、下段「スマホのアラーム音 ON/OFF」を並べて配置（どちらもデフォルトOFF） */}
              <TouchableOpacity
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 14,
                  paddingVertical: 11,
                  paddingHorizontal: 14,
                  borderRadius: 12,
                  backgroundColor: modalWatchAlarmSoundEnabled
                    ? (isEcoMode ? 'rgba(14, 165, 233, 0.16)' : '#F0F9FF')
                    : theme.inputBg,
                  borderWidth: 1.5,
                  borderColor: modalWatchAlarmSoundEnabled ? '#0EA5E9' : theme.cardBorder,
                }}
                onPress={() => {
                  setModalWatchAlarmSoundEnabled((prev) => !prev);
                  if (Platform.OS !== 'web') Vibration.vibrate(25);
                }}
                activeOpacity={0.75}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 10 }}>
                  <Ionicons
                    name={modalWatchAlarmSoundEnabled ? 'watch' : 'watch-outline'}
                    size={20}
                    color={modalWatchAlarmSoundEnabled ? '#0EA5E9' : theme.textSecondary}
                    style={{ marginRight: 10 }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13.5, fontWeight: '700', color: theme.textPrimary }}>
                      ウォッチのアラーム音
                    </Text>
                    <Text style={{ fontSize: 11, color: theme.textSecondary, marginTop: 2 }}>
                      {modalWatchAlarmSoundEnabled
                        ? '消音モードでもウォッチから強制的に音が鳴ります（＋振動）'
                        : 'ウォッチから音は出さず、振動のみでお知らせ（デフォルト）'}
                    </Text>
                  </View>
                </View>
                <View
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 5,
                    borderRadius: 999,
                    backgroundColor: modalWatchAlarmSoundEnabled ? '#0EA5E9' : (isEcoMode ? '#3A3A3C' : '#E5E7EB'),
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: '800',
                      color: modalWatchAlarmSoundEnabled ? '#FFFFFF' : theme.textSecondary,
                    }}
                  >
                    {modalWatchAlarmSoundEnabled ? 'ON' : 'OFF'}
                  </Text>
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 8,
                  paddingVertical: 11,
                  paddingHorizontal: 14,
                  borderRadius: 12,
                  backgroundColor: modalAlarmSoundEnabled
                    ? (isEcoMode ? 'rgba(16, 185, 129, 0.16)' : '#ECFDF5')
                    : theme.inputBg,
                  borderWidth: 1.5,
                  borderColor: modalAlarmSoundEnabled ? '#10B981' : theme.cardBorder,
                }}
                onPress={() => {
                  setModalAlarmSoundEnabled((prev) => !prev);
                  if (Platform.OS !== 'web') Vibration.vibrate(25);
                }}
                activeOpacity={0.75}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 10 }}>
                  <Ionicons
                    name={modalAlarmSoundEnabled ? 'volume-high' : 'volume-mute'}
                    size={20}
                    color={modalAlarmSoundEnabled ? '#10B981' : theme.textSecondary}
                    style={{ marginRight: 10 }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13.5, fontWeight: '700', color: theme.textPrimary }}>
                      スマホのアラーム音
                    </Text>
                    <Text style={{ fontSize: 11, color: theme.textSecondary, marginTop: 2 }}>
                      {modalAlarmSoundEnabled
                        ? 'タイム終了時にスマホからも音が鳴ります（Watchも振動）'
                        : 'スマホは消音・Apple Watchの振動でお知らせ（デフォルト）'}
                    </Text>
                  </View>
                </View>
                <View
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 5,
                    borderRadius: 999,
                    backgroundColor: modalAlarmSoundEnabled ? '#10B981' : (isEcoMode ? '#3A3A3C' : '#E5E7EB'),
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: '800',
                      color: modalAlarmSoundEnabled ? '#FFFFFF' : theme.textSecondary,
                    }}
                  >
                    {modalAlarmSoundEnabled ? 'ON' : 'OFF'}
                  </Text>
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.submitButton, { backgroundColor: theme.accent, marginTop: 14 }]}
                onPress={handleStartSeatTimer}
              >
                <Text style={styles.submitButtonText}>
                  {timerSetupMode === 'additional'
                    ? '追加タイムを開始する'
                    : timerSetupMode === 'new'
                    ? '新しくタイマーを開始する'
                    : isEditingExistingTimer
                    ? '変更を適用する'
                    : 'タイマーを開始する'}
                </Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ④ メインタイマーを空席に割り当てるモーダル */}
      <Modal
        visible={isAssignMainTimerModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsAssignMainTimerModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.cardBg }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>
                メインタイマーを割り当てる席を選択
              </Text>
              <TouchableOpacity onPress={() => setIsAssignMainTimerModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={[styles.proModalSubText, { color: theme.textSecondary, marginBottom: 14 }]}>
              現在のメインタイマー（{formatSec((!mainTimerState?.isCountUp && mainTimerState?.remainingTime > 0) ? mainTimerState.remainingTime : (mainTimerState?.targetTime || 180))}）をセットしてサロンボードで稼働開始します。
            </Text>

            {/* ★ ユーザー指定: 席に割り当てずにセットするボタン（席追加にあたるためオーナーのみ表示） */}
            {isSalonOwner ? (
              <>
                <TouchableOpacity
                  style={[
                    styles.assignWithoutSeatCard,
                    { backgroundColor: theme.accentLight, borderColor: theme.accentBorder },
                  ]}
                  onPress={handleAssignMainTimerWithoutSeat}
                  activeOpacity={0.7}
                >
                  <View style={styles.assignWithoutSeatLeft}>
                    <Ionicons name="timer" size={22} color={theme.accent} style={{ marginRight: 10 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.assignWithoutSeatTitle, { color: theme.accent }]}>
                        席を指定しない (フリー)
                      </Text>
                      <Text style={[styles.assignWithoutSeatDesc, { color: theme.textSecondary }]}>
                        固定席を使わず、そのままボードに追加
                      </Text>
                    </View>
                  </View>
                  <View style={[styles.assignSeatBtn, { backgroundColor: theme.accent }]}>
                    <Text style={styles.assignSeatBtnText}>割り当てずにセット</Text>
                  </View>
                </TouchableOpacity>

                {idleSeats.length > 0 ? (
                  <View style={styles.assignDividerRow}>
                    <View style={[styles.assignDividerLine, { backgroundColor: theme.cardBorder }]} />
                    <Text style={[styles.assignDividerText, { color: theme.textTertiary }]}>または空席に割り当てる</Text>
                    <View style={[styles.assignDividerLine, { backgroundColor: theme.cardBorder }]} />
                  </View>
                ) : null}
              </>
            ) : idleSeats.length === 0 ? (
              <Text style={{ fontSize: 12.5, color: theme.textTertiary, textAlign: 'center', paddingVertical: 14 }}>
                現在割り当て可能な空席がありません
              </Text>
            ) : null}

            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 260 }}>
              {idleSeats.map((seat) => (
                <TouchableOpacity
                  key={seat.id}
                  style={[styles.assignSeatItem, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAssignMainTimerToSeat(seat.id)}
                >
                  <Text style={[styles.assignSeatName, { color: theme.textPrimary }]}>
                    ⌚️ {seat.seatLabel.replace(/^[🪑⌚️⏱️]\s*/, '')}
                  </Text>
                  <View style={[styles.assignSeatBtn, { backgroundColor: theme.accent }]}>
                    <Text style={styles.assignSeatBtnText}>この席にセット</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ④-B メインタイマー時間設定モーダル（共有タイマーと同じ分・秒トグルUI・サブタイマーなし） */}
      <Modal
        visible={isMainTimerEditModalVisible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setIsMainTimerEditModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalCard, { backgroundColor: theme.cardBg }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>
                メインタイマー 時間設定
              </Text>
              <TouchableOpacity onPress={() => setIsMainTimerEditModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* 見出し＆カスタム数値直接入力ボックス */}
              <View style={styles.timeSectionHeader}>
                <Text style={[styles.inputLabel, { color: theme.textSecondary, marginTop: 0, marginBottom: 0 }]}>
                  タイマー時間
                </Text>

                <View style={styles.customTimeInputRow}>
                  <TextInput
                    style={[
                      styles.customTimeTextInput,
                      {
                        backgroundColor: theme.inputBg,
                        color: theme.textPrimary,
                        borderColor: theme.accent,
                      },
                    ]}
                    keyboardType="number-pad"
                    maxLength={3}
                    value={modalTargetMinutes !== '' && modalTargetMinutes !== undefined && modalTargetMinutes !== null ? String(modalTargetMinutes) : ''}
                    onChangeText={(val) => {
                      const clean = val.replace(/[^0-9]/g, '');
                      setModalTargetMinutes(clean === '' ? '' : parseInt(clean, 10));
                      setModalTargetSeconds(0);
                    }}
                    placeholder="0"
                    placeholderTextColor={theme.textTertiary}
                    selectTextOnFocus={true}
                  />
                  <Text style={[styles.customTimeUnitText, { color: theme.textPrimary }]}>分</Text>
                  <View style={[styles.timeCurrentBadge, { backgroundColor: theme.accentLight, borderColor: theme.accentBorder, marginLeft: 6 }]}>
                    <Text style={[styles.timeCurrentBadgeText, { color: theme.accent }]}>
                      現在: {formatModalTargetTime(modalTargetMinutes, modalTargetSeconds)}
                    </Text>
                  </View>
                </View>
              </View>

              {/* クイック選択ピル（1分、3分、5分、7分、10分、15分、20分、30分） */}
              <View style={styles.timePillRow}>
                {[1, 3, 5, 7, 10, 15, 20, 30].map((min) => {
                  const isPillSelected = Number(modalTargetMinutes) === min && (Number(modalTargetSeconds) || 0) === 0;
                  return (
                    <TouchableOpacity
                      key={min}
                      style={[
                        styles.timePill,
                        {
                          backgroundColor: isPillSelected ? theme.accent : theme.inputBg,
                          borderColor: isPillSelected ? theme.accent : theme.cardBorder,
                        },
                      ]}
                      onPress={() => handleSelectQuickMinute(min)}
                    >
                      <Text
                        style={[
                          styles.timePillText,
                          { color: isPillSelected ? '#FFFFFF' : theme.textPrimary },
                        ]}
                      >
                        {min}分
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* 1分・5分単位の微調整ボタンバー（-5分, -1分, +1分, +5分） */}
              <View style={styles.timeAdjustBar}>
                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetMinutes(-5)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.textPrimary }]}>-5分</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetMinutes(-1)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.textPrimary }]}>-1分</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetMinutes(1)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.textPrimary }]}>+1分</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetMinutes(5)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.textPrimary }]}>+5分</Text>
                </TouchableOpacity>
              </View>

              {/* 10秒・30秒単位の微調整ボタンバー（-30秒, -10秒, +10秒, +30秒） */}
              <View style={[styles.timeAdjustBar, { marginTop: 4, marginBottom: 8 }]}>
                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetSeconds(-30)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.textSecondary }]}>-30秒</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetSeconds(-10)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.textSecondary }]}>-10秒</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetSeconds(10)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.accent }]}>+10秒</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeAdjustBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
                  onPress={() => handleAdjustTargetSeconds(30)}
                >
                  <Text style={[styles.timeAdjustBtnText, { color: theme.accent }]}>+30秒</Text>
                </TouchableOpacity>
              </View>

              {/* お気に入りパネル（サブタイマー表示なし） */}
              <View style={[styles.favPanelContainer, { backgroundColor: isEcoMode ? '#1C1C1E' : '#F7F8FC', borderColor: theme.cardBorder }]}>
                <View style={styles.favPanelHeaderRow}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <Ionicons name="star" size={14} color="#FFB800" />
                    <Text style={[styles.favPanelTitle, { color: theme.textPrimary }]}>お気に入りパネル</Text>
                  </View>
                </View>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.favChipsScroll}
                >
                  {favoritePresets.map((fav) => {
                    const isSelected =
                      Number(modalTargetMinutes) === fav.minutes &&
                      (Number(modalTargetSeconds) || 0) === (fav.seconds || 0);
                    return (
                      <View
                        key={fav.id}
                        style={[
                          styles.favChipWrapper,
                          {
                            backgroundColor: isSelected ? theme.accent : (isEcoMode ? '#28282B' : '#FFFFFF'),
                            borderColor: isSelected ? theme.accent : theme.cardBorder,
                          },
                        ]}
                      >
                        <TouchableOpacity
                          style={styles.favChipPressable}
                          onPress={() => {
                            setModalTargetMinutes(fav.minutes);
                            setModalTargetSeconds(fav.seconds || 0);
                            if (Platform.OS !== 'web') Vibration.vibrate(25);
                          }}
                        >
                          <Ionicons
                            name="star"
                            size={12}
                            color={isSelected ? '#FFFFFF' : '#FFB800'}
                            style={{ marginRight: 3 }}
                          />
                          <Text
                            style={[
                              styles.favChipMinutes,
                              { color: isSelected ? '#FFFFFF' : theme.textPrimary },
                            ]}
                          >
                            {formatModalTargetTime(fav.minutes, fav.seconds || 0)}
                          </Text>
                          {fav.label ? (
                            <Text
                              style={[
                                styles.favChipLabel,
                                { color: isSelected ? '#FFFFFF' : theme.textSecondary },
                              ]}
                              numberOfLines={1}
                            >
                              {fav.label}
                            </Text>
                          ) : null}
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </ScrollView>
              </View>

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
                <TouchableOpacity
                  style={[styles.submitButton, { flex: 1, backgroundColor: isEcoMode ? '#2C2C2E' : '#E5E7EB', marginTop: 0 }]}
                  onPress={() => handleApplyMainTimerEditModal(false)}
                >
                  <Text style={[styles.submitButtonText, { color: theme.textPrimary }]}>時間をセット</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.submitButton, { flex: 1.3, backgroundColor: theme.accent, marginTop: 0 }]}
                  onPress={() => handleApplyMainTimerEditModal(true)}
                >
                  <Text style={styles.submitButtonText}>開始する</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ⑤ 新規席マスター追加モーダル */}
      <Modal
        visible={isAddSeatModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsAddSeatModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <TouchableOpacity
            style={{ flex: 1 }}
            activeOpacity={1}
            onPress={() => setIsAddSeatModalVisible(false)}
          />
          <View style={[styles.modalCard, { backgroundColor: theme.cardBg }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>新しい席を追加</Text>
              <TouchableOpacity onPress={() => setIsAddSeatModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              bounces={false}
            >
              <Text style={[styles.inputLabel, { color: theme.textSecondary }]}>席の名前・番号</Text>
              <TextInput
                style={[styles.textInput, { backgroundColor: theme.inputBg, color: theme.textPrimary, borderColor: theme.accent, borderWidth: 1.5 }]}
                placeholder="例: 6番席, 個室B, セット面C"
                placeholderTextColor={theme.textTertiary}
                value={newSeatName}
                onChangeText={setNewSeatName}
                maxLength={20}
                autoFocus={true}
                selectTextOnFocus={true}
                returnKeyType="done"
                onSubmitEditing={handleAddNewSeatMaster}
              />

              {/* 定番の席名クイックチップ */}
              <View style={{ marginTop: 10, marginBottom: 4 }}>
                <Text style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>よく使う席名（タップで入力）:</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {[`${getNextSuggestedSeatNumber()}番席`, 'セット面', '個室', 'VIP席', 'シャンプー台'].map((preset) => (
                    <TouchableOpacity
                      key={preset}
                      style={{
                        paddingHorizontal: 9,
                        paddingVertical: 5,
                        borderRadius: 6,
                        backgroundColor: isEcoMode ? '#2C2C2E' : '#EFF6FF',
                        borderWidth: 1,
                        borderColor: newSeatName === preset ? theme.accent : (isEcoMode ? '#3C3C3E' : '#BFDBFE'),
                      }}
                      onPress={() => setNewSeatName(preset)}
                    >
                      <Text style={{ fontSize: 11.5, color: newSeatName === preset ? theme.accent : theme.textPrimary, fontWeight: newSeatName === preset ? '700' : '500' }}>
                        {preset}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <TouchableOpacity
                style={[styles.submitButton, { backgroundColor: theme.accent, marginTop: 12 }]}
                onPress={handleAddNewSeatMaster}
              >
                <Text style={styles.submitButtonText}>席を追加する</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ⑥ PROサロンプラン案内モーダル */}
      <Modal
        visible={isProModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsProModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.cardBg }]}>
            <View style={styles.modalHeader}>
              <TouchableOpacity
                activeOpacity={0.8}
                onLongPress={() => {
                  setIsDevTestMode((prev) => {
                    const next = !prev;
                    Alert.alert('デバッグモード', next ? '🧪 テストボタンを表示しました' : 'テストボタンを非表示にしました');
                    return next;
                  });
                }}
              >
                <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>PRO サロンプランのご案内</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setIsProModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.proModalContent}>
              <Ionicons name="people-circle" size={54} color={theme.accent} style={{ alignSelf: 'center', marginBottom: 10 }} />
              <Text style={[styles.proModalText, { color: theme.textPrimary }]}>
                1対1の「タイマー同期モード」は<Text style={{ fontWeight: 'bold', color: theme.success }}>完全無料</Text>で無期限にご利用いただけます。
              </Text>
              <Text style={[styles.proModalSubText, { color: theme.textSecondary }]}>
                3人以上のスタッフでタイマーをリアルタイム同期する場合は、サロン共有モード（PROプラン）をご利用いただくことで、全スタッフが無制限に同一サロンボードへ参加・同期可能になります。
              </Text>
            </View>

            {/* 🧪 開発・テスト用ボタン（本番リリースビルドでは自動非表示） */}
            {(typeof __DEV__ !== 'undefined' && __DEV__ || isDevTestMode) && (
              <TouchableOpacity
                style={[styles.submitButton, { backgroundColor: '#10B981', marginBottom: 8 }]}
                onPress={handleCreateTestProSalon}
                activeOpacity={0.7}
              >
                <Ionicons name="flask" size={16} color="#FFFFFF" style={{ marginRight: 6 }} />
                <Text style={styles.submitButtonText}>🧪 サロン共有モードをテスト体験（開発用）</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[styles.submitButton, { backgroundColor: theme.accent }]}
              onPress={() => setIsProModalVisible(false)}
            >
              <Text style={styles.submitButtonText}>閉じる</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ⑦ 時間変更 ＆ タイマー停止確認モーダル（お互いに通知確認を送信） */}
      <Modal
        visible={isTimeActionModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsTimeActionModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.actionModalOverlay}
          activeOpacity={1}
          onPress={() => setIsTimeActionModalVisible(false)}
        >
          <View
            style={[styles.actionModalCard, { backgroundColor: theme.cardBg }]}
            onStartShouldSetResponder={() => true}
          >
            {actionTargetSeat?.status === 'paused' ? (
              // ★ タイマーを止めた状態: 「新しく測る」「追加タイム」の2つのみ表示（キャンセルと変更は不要）
              <>
                <View style={styles.actionModalHeaderRow}>
                  <Text style={[styles.actionModalTitle, { color: theme.textPrimary, marginBottom: 0 }]}>
                    タイマー操作を選択
                  </Text>
                  <TouchableOpacity
                    onPress={() => setIsTimeActionModalVisible(false)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons name="close" size={22} color={theme.textSecondary} />
                  </TouchableOpacity>
                </View>

                <Text style={[styles.actionModalMessage, { color: theme.textSecondary }]}>
                  「{actionTargetSeat?.seatLabel || '対象席'}」は現在停止中です。
                </Text>

                <View style={styles.pausedActionButtonsCol}>
                  {/* ① 新しく測る */}
                  <TouchableOpacity
                    style={[
                      styles.pausedActionCardBtn,
                      {
                        backgroundColor: isEcoMode ? '#1E293B' : '#EFF6FF',
                        borderColor: theme.accent,
                      },
                    ]}
                    onPress={handleProceedToNewTimer}
                    activeOpacity={0.75}
                  >
                    <View style={[styles.pausedActionIconCircle, { backgroundColor: theme.accent }]}>
                      <Ionicons name="refresh" size={20} color="#FFFFFF" />
                    </View>
                    <View style={styles.pausedActionTextCol}>
                      <Text style={[styles.pausedActionBtnTitle, { color: theme.accent }]}>
                        新しく測る
                      </Text>
                      <Text style={[styles.pausedActionBtnSub, { color: theme.textSecondary }]}>
                        履歴を新しくして最初から計測
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={theme.accent} />
                  </TouchableOpacity>

                  {/* ② 追加タイム */}
                  <TouchableOpacity
                    style={[
                      styles.pausedActionCardBtn,
                      {
                        backgroundColor: isEcoMode ? '#281B3C' : '#FAF5FF',
                        borderColor: '#A855F7',
                      },
                    ]}
                    onPress={handleProceedToAddTimer}
                    activeOpacity={0.75}
                  >
                    <View style={[styles.pausedActionIconCircle, { backgroundColor: '#A855F7' }]}>
                      <Ionicons name="add-circle" size={20} color="#FFFFFF" />
                    </View>
                    <View style={styles.pausedActionTextCol}>
                      <Text style={[styles.pausedActionBtnTitle, { color: '#A855F7' }]}>
                        追加タイム
                      </Text>
                      <Text style={[styles.pausedActionBtnSub, { color: theme.textSecondary }]}>
                        履歴に続きを入れて追加放置
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#A855F7" />
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              // ★ タイマー稼働中（通常時）: キャンセル / 変更する / タイマーを止める
              <>
                <Text style={[styles.actionModalTitle, { color: theme.textPrimary }]}>
                  時間変更しますか？
                </Text>
                <Text style={[styles.actionModalMessage, { color: theme.textSecondary }]}>
                  「{actionTargetSeat?.seatLabel || '対象席'}」のタイマー時間を変更しますか？
                </Text>

                {/* 上段: キャンセル / 変更する */}
                <View style={styles.actionModalTopButtonsRow}>
                  <TouchableOpacity
                    style={[
                      styles.actionModalCancelBtn,
                      { backgroundColor: isEcoMode ? '#2C2C2E' : '#E5E5EA' },
                    ]}
                    onPress={() => setIsTimeActionModalVisible(false)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.actionModalCancelBtnText, { color: theme.textPrimary }]}>
                      キャンセル
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.actionModalChangeBtn,
                      { backgroundColor: isEcoMode ? '#3A3A3C' : '#E5E5EA' },
                    ]}
                    onPress={handleProceedToEditTimer}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.actionModalChangeBtnText, { color: theme.textPrimary }]}>
                      変更する
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* 下段: タイマー停止 ＆ 施術ステータス変更（ヘルプ指定項目に自動連動） */}
                {(() => {
                  const targetHelpActionId =
                    actionTargetSeat?.actionStatus ||
                    (actionTargetSeat?.isShampooing ? 'shampoo' : null);
                  const targetHelpActionInfo = getActionStatusInfo(
                    targetHelpActionId,
                    actionTargetSeat?.isShampooing
                  );

                  return (
                    <>
                      <TouchableOpacity
                        style={[
                          styles.actionModalStopBtn,
                          targetHelpActionInfo
                            ? {
                                backgroundColor: isEcoMode
                                  ? 'rgba(0,0,0,0.3)'
                                  : targetHelpActionInfo.bg,
                                borderColor: targetHelpActionInfo.color,
                              }
                            : {
                                backgroundColor: isEcoMode
                                  ? 'rgba(239, 68, 68, 0.18)'
                                  : '#FEE2E2',
                                borderColor: theme.danger,
                              },
                        ]}
                        onPress={() => handleStopTimerWithNotification(targetHelpActionId)}
                        activeOpacity={0.7}
                      >
                        <Ionicons
                          name={
                            targetHelpActionInfo
                              ? targetHelpActionInfo.icon
                              : 'stop-circle'
                          }
                          size={20}
                          color={
                            targetHelpActionInfo
                              ? targetHelpActionInfo.color
                              : theme.danger
                          }
                          style={{ marginRight: 6 }}
                        />
                        <Text
                          style={[
                            styles.actionModalStopBtnText,
                            {
                              color: targetHelpActionInfo
                                ? targetHelpActionInfo.color
                                : theme.danger,
                            },
                          ]}
                        >
                          {targetHelpActionInfo
                            ? `タイマーを止めて${targetHelpActionInfo.label}する`
                            : 'タイマーを止める'}
                        </Text>
                      </TouchableOpacity>

                      {/* 他の施術状態に変更して停止できるクイックピル */}
                      <View style={styles.actionModalStatusPillsSection}>
                        <Text
                          style={[
                            styles.actionModalStatusPillsTitle,
                            { color: theme.textSecondary },
                          ]}
                        >
                          状態を変更して停止:
                        </Text>
                        <View style={styles.actionModalStatusPillsRow}>
                          {SALON_ACTION_STATUS_OPTIONS.map((opt) => {
                            const isSelected = targetHelpActionId === opt.id;
                            return (
                              <TouchableOpacity
                                key={opt.id}
                                style={[
                                  styles.actionModalStatusPill,
                                  {
                                    backgroundColor: isSelected
                                      ? opt.color
                                      : isEcoMode
                                      ? '#2C2C2E'
                                      : '#F2F2F7',
                                    borderColor: opt.color,
                                  },
                                ]}
                                onPress={() => handleStopTimerWithNotification(opt.id)}
                                activeOpacity={0.7}
                              >
                                <Ionicons
                                  name={opt.icon}
                                  size={12}
                                  color={isSelected ? '#FFFFFF' : opt.color}
                                  style={{ marginRight: 3 }}
                                />
                                <Text
                                  style={[
                                    styles.actionModalStatusPillText,
                                    {
                                      color: isSelected
                                        ? '#FFFFFF'
                                        : theme.textPrimary,
                                    },
                                  ]}
                                >
                                  {opt.label}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                          {targetHelpActionInfo && (
                            <TouchableOpacity
                              style={[
                                styles.actionModalStatusPill,
                                {
                                  backgroundColor: isEcoMode
                                    ? '#2C2C2E'
                                    : '#F2F2F7',
                                  borderColor: theme.danger,
                                },
                              ]}
                              onPress={() => handleStopTimerWithNotification(null)}
                              activeOpacity={0.7}
                            >
                              <Ionicons
                                name="stop"
                                size={11}
                                color={theme.danger}
                                style={{ marginRight: 2 }}
                              />
                              <Text
                                style={[
                                  styles.actionModalStatusPillText,
                                  { color: theme.danger },
                                ]}
                              >
                                通常停止
                              </Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
                    </>
                  );
                })()}

                <Text style={[styles.actionModalNote, { color: theme.textTertiary }]}>
                  ※停止するとメイン担当・ヘルプ担当の両者に停止・確認通知が届きます
                </Text>

                {/* ★ ユーザー指定: 共有タイマーの止める画面の一番下に「＋ チェックタイマーを追加」ボタン＆追加フォームを配置 */}
                <View
                  style={{
                    marginTop: 12,
                    paddingTop: 12,
                    borderTopWidth: 1,
                    borderTopColor: theme.cardBorder,
                  }}
                >
                  {!isAddingLateCheck ? (
                    <TouchableOpacity
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingVertical: 11,
                        paddingHorizontal: 14,
                        borderRadius: 12,
                        backgroundColor: isEcoMode ? 'rgba(14, 165, 233, 0.16)' : '#F0F9FF',
                        borderWidth: 1.5,
                        borderColor: '#0EA5E9',
                      }}
                      onPress={handleOpenLateCheckPanel}
                      activeOpacity={0.75}
                    >
                      <Ionicons name="add-circle" size={19} color="#0EA5E9" style={{ marginRight: 6 }} />
                      <Text style={{ fontSize: 13.5, fontWeight: '800', color: '#0EA5E9' }}>
                        {actionTargetSeat?.checkTargetSeconds > 0 && actionTargetSeat?.checkStatus === 'running'
                          ? 'チェックタイマーを変更・再設定'
                          : '＋ チェックタイマーを追加'}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <View
                      style={{
                        padding: 12,
                        borderRadius: 12,
                        backgroundColor: isEcoMode ? '#1C1C1E' : '#F8FAFC',
                        borderWidth: 1,
                        borderColor: '#0EA5E9',
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <Text style={{ fontSize: 13.5, fontWeight: '800', color: '#0EA5E9' }}>
                          🔍 チェックタイマーを追加
                        </Text>
                        <TouchableOpacity onPress={() => setIsAddingLateCheck(false)}>
                          <Text style={{ fontSize: 12, fontWeight: '600', color: theme.textSecondary }}>閉じる</Text>
                        </TouchableOpacity>
                      </View>

                      {/* ① 分数選択 */}
                      <Text style={{ fontSize: 11.5, fontWeight: '700', color: theme.textSecondary, marginBottom: 6 }}>
                        1. チェック分数（現在: {lateCheckMinutes}分後）
                      </Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                        {[3, 5, 7, 10, 15].map((m) => {
                          const isSel = Number(lateCheckMinutes) === m;
                          return (
                            <TouchableOpacity
                              key={m}
                              style={{
                                paddingHorizontal: 11,
                                paddingVertical: 6,
                                borderRadius: 8,
                                backgroundColor: isSel ? '#0EA5E9' : theme.inputBg,
                                borderWidth: 1,
                                borderColor: isSel ? '#0EA5E9' : theme.cardBorder,
                              }}
                              onPress={() => setLateCheckMinutes(m)}
                            >
                              <Text style={{ fontSize: 12.5, fontWeight: '700', color: isSel ? '#FFFFFF' : theme.textPrimary }}>
                                {m}分
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                        <TouchableOpacity
                          style={{
                            paddingHorizontal: 9,
                            paddingVertical: 6,
                            borderRadius: 8,
                            backgroundColor: theme.inputBg,
                            borderWidth: 1,
                            borderColor: theme.cardBorder,
                          }}
                          onPress={() => setLateCheckMinutes((prev) => Math.max(1, (Number(prev) || 5) - 1))}
                        >
                          <Text style={{ fontSize: 12, fontWeight: '700', color: theme.textSecondary }}>-1分</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={{
                            paddingHorizontal: 9,
                            paddingVertical: 6,
                            borderRadius: 8,
                            backgroundColor: theme.inputBg,
                            borderWidth: 1,
                            borderColor: theme.cardBorder,
                          }}
                          onPress={() => setLateCheckMinutes((prev) => Math.min(90, (Number(prev) || 5) + 1))}
                        >
                          <Text style={{ fontSize: 12, fontWeight: '700', color: '#0EA5E9' }}>+1分</Text>
                        </TouchableOpacity>
                      </View>

                      {/* ② ヘルプ内容（工程）選択（4種・シャンプー完全除外） */}
                      <Text style={{ fontSize: 11.5, fontWeight: '700', color: theme.textSecondary, marginBottom: 6 }}>
                        2. チェック内容（任意）
                      </Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                        {CHECK_PROCESS_OPTIONS.map((proc) => {
                          const isSel = sanitizeCheckProcess(lateCheckProcess) === proc;
                          return (
                            <TouchableOpacity
                              key={proc}
                              style={{
                                paddingHorizontal: 10,
                                paddingVertical: 5,
                                borderRadius: 8,
                                backgroundColor: isSel ? '#0EA5E9' : theme.inputBg,
                                borderWidth: 1,
                                borderColor: isSel ? '#0EA5E9' : theme.cardBorder,
                              }}
                              onPress={() => setLateCheckProcess(proc)}
                            >
                              <Text style={{ fontSize: 12, fontWeight: '700', color: isSel ? '#FFFFFF' : theme.textPrimary }}>
                                {proc}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>

                      {/* ③ 誰にヘルプに入ってもらうか */}
                      <Text style={{ fontSize: 11.5, fontWeight: '700', color: theme.textSecondary, marginBottom: 6 }}>
                        3. 誰にヘルプに入ってもらうか
                      </Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                        {[
                          { label: '指定なし', value: '' },
                          { label: '📢 全員に募集', value: '募集中' },
                          { label: '🙋 自分', value: userName || 'スタイリスト' },
                          ...staffMembers
                            .filter((m) => !m?.isMe && !isStaffNameMe(getMemberDisplayName(m)))
                            .map((m) => {
                              const name = getMemberDisplayName(m);
                              return { label: `👤 ${name}`, value: name };
                            }),
                        ].map((opt) => {
                          const isSel = (lateCheckStaffName || '') === opt.value;
                          return (
                            <TouchableOpacity
                              key={`late-chk-staff-${opt.label}`}
                              style={{
                                paddingHorizontal: 10,
                                paddingVertical: 5,
                                borderRadius: 8,
                                backgroundColor: isSel ? '#10B981' : theme.inputBg,
                                borderWidth: 1,
                                borderColor: isSel ? '#10B981' : theme.cardBorder,
                              }}
                              onPress={() => setLateCheckStaffName(opt.value)}
                            >
                              <Text style={{ fontSize: 12, fontWeight: '700', color: isSel ? '#FFFFFF' : theme.textPrimary }}>
                                {opt.label}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>

                      <TouchableOpacity
                        style={{
                          paddingVertical: 10,
                          borderRadius: 10,
                          backgroundColor: '#0EA5E9',
                          alignItems: 'center',
                        }}
                        onPress={handleApplyLateCheckTimer}
                        activeOpacity={0.8}
                      >
                        <Text style={{ fontSize: 13.5, fontWeight: '800', color: '#FFFFFF' }}>
                          この内容でチェックタイマーを開始 ({lateCheckMinutes}分)
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              </>
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ⑦-B ★ ユーザー指定: チェックタイマー停止確認モーダル（タイマー設定者へ通知） */}
      <Modal
        visible={isCheckStopModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsCheckStopModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.actionModalOverlay}
          activeOpacity={1}
          onPress={() => setIsCheckStopModalVisible(false)}
        >
          <View
            style={[styles.actionModalCard, { backgroundColor: theme.cardBg }]}
            onStartShouldSetResponder={() => true}
          >
            {(() => {
              const modalChkProc = sanitizeCheckProcess(checkStopTargetSeat?.checkProcess);
              const hasExplicitModalChkProc = ['コーミング', '1液2液', '担当を呼ぶ'].includes(modalChkProc);
              const procBtnColor =
                modalChkProc === 'コーミング'
                  ? '#0A84FF'
                  : modalChkProc === '1液2液'
                  ? '#8B5CF6'
                  : modalChkProc === '担当を呼ぶ'
                  ? '#F59E0B'
                  : '#10B981';
              const procBtnIcon =
                modalChkProc === 'コーミング'
                  ? 'cut-outline'
                  : modalChkProc === '1液2液'
                  ? 'water-outline'
                  : modalChkProc === '担当を呼ぶ'
                  ? 'notifications'
                  : 'checkmark-circle';
              const procBtnLabel =
                modalChkProc === '担当を呼ぶ'
                  ? '担当を呼ぶ（完了・本タイマー続行）'
                  : `${modalChkProc}に入る（完了・本タイマー続行）`;

              return (
                <>
                  <View style={styles.actionModalHeaderRow}>
                    <Text style={[styles.actionModalTitle, { color: theme.textPrimary, marginBottom: 0 }]}>
                      {hasExplicitModalChkProc ? `${modalChkProc}タイマーの確認` : 'チェックタイマーを止めますか？'}
                    </Text>
                    <TouchableOpacity
                      onPress={() => setIsCheckStopModalVisible(false)}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Ionicons name="close" size={22} color={theme.textSecondary} />
                    </TouchableOpacity>
                  </View>

                  <Text style={[styles.actionModalMessage, { color: theme.textSecondary, marginTop: 8 }]}>
                    「{checkStopTargetSeat?.seatLabel || '対象席'}」の{hasExplicitModalChkProc ? `${modalChkProc}（中間チェック）` : 'チェック'}タイマーを止めて完了にしますか？（※全体放置タイマーはそのまま続行します）
                  </Text>

                  {/* タイマー設定者への通知案内バッジ */}
                  <View
                    style={[
                      styles.notificationNoteBox,
                      {
                        backgroundColor: isEcoMode ? 'rgba(16, 185, 129, 0.12)' : '#ECFDF5',
                        borderColor: '#10B981',
                        borderWidth: 1,
                        marginVertical: 14,
                      },
                    ]}
                  >
                    <Ionicons name="notifications-outline" size={18} color="#059669" style={{ marginRight: 8 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#059669' }}>
                        {isMainStaffOfSeat(checkStopTargetSeat)
                          ? 'タイマー設定者: 📝 自分'
                          : `タイマー設定者（📝 ${formatCreatorForDisplay(checkStopTargetSeat, '担当')} さん）へ通知`}
                      </Text>
                      <Text style={{ fontSize: 11, color: theme.textSecondary, marginTop: 2 }}>
                        停止すると、設定者の端末およびApple Watchに{modalChkProc}完了の通知がリアルタイム送信されます。
                      </Text>
                    </View>
                  </View>

                  {/* ① 明示的に「コーミング」「1液2液」「担当を呼ぶ」が選ばれている場合のみ工程ボタンを表示（未選択時は表示しない） */}
                  {hasExplicitModalChkProc && (
                    <TouchableOpacity
                      style={{
                        width: '100%',
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: procBtnColor,
                        paddingVertical: 13,
                        paddingHorizontal: 14,
                        borderRadius: 12,
                        marginBottom: 10,
                      }}
                      onPress={handleConfirmStopCheckTimer}
                      activeOpacity={0.75}
                    >
                      <Ionicons name={procBtnIcon} size={18} color="#FFFFFF" style={{ marginRight: 6 }} />
                      <Text style={{ color: '#FFFFFF', fontSize: 14.5, fontWeight: '800' }}>
                        {procBtnLabel}
                      </Text>
                    </TouchableOpacity>
                  )}

                  {/* ② 仕様書40.4準拠: 赤い「⏹️ タイマーを止める」ボタンを大きく表示（1タップでチェックのみ完了・本タイマー継続） */}
                  <TouchableOpacity
                    style={{
                      width: '100%',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: '#EF4444',
                      paddingVertical: 13,
                      paddingHorizontal: 14,
                      borderRadius: 12,
                      marginBottom: 10,
                    }}
                    onPress={handleConfirmStopCheckTimer}
                    activeOpacity={0.75}
                  >
                    <Ionicons name="stop-circle" size={19} color="#FFFFFF" style={{ marginRight: 6 }} />
                    <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '800' }}>
                      タイマーを止める
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={{
                      width: '100%',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: isEcoMode ? '#2C2C2E' : '#E5E5EA',
                      paddingVertical: 11,
                      borderRadius: 10,
                    }}
                    onPress={() => setIsCheckStopModalVisible(false)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.actionModalCancelBtnText, { color: theme.textPrimary }]}>
                      キャンセル
                    </Text>
                  </TouchableOpacity>
                </>
              );
            })()}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ★ ユーザー指定: クイックタイム変更モーダル（左下「タイム変更」から起動: +30秒, +1分, +3分, +5分 & -30秒/+30秒） */}
      <Modal
        visible={isQuickAdjustModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsQuickAdjustModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.actionModalOverlay}
          activeOpacity={1}
          onPress={() => setIsQuickAdjustModalVisible(false)}
        >
          <View
            style={[styles.actionModalCard, { backgroundColor: theme.cardBg, width: '92%', maxWidth: 360, padding: 20, alignItems: 'stretch' }]}
            onStartShouldSetResponder={() => true}
          >
            {/* ヘッダー */}
            <View style={[styles.actionModalHeaderRow, { width: '100%', marginBottom: 4 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="timer" size={20} color={theme.accent} />
                <Text style={[styles.actionModalTitle, { color: theme.textPrimary, marginBottom: 0 }]}>
                  {quickAdjustTargetSeat?.seatLabel || '対象席'} のタイム変更
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setIsQuickAdjustModalVisible(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={22} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* タイム比較プレビューカード */}
            {(() => {
              const preview = getQuickAdjustPreview();
              return (
                <View
                  style={[
                    styles.quickTimePreviewBox,
                    {
                      backgroundColor: isEcoMode ? '#1C1C1E' : '#F8FAFC',
                      borderColor: quickAdjustDeltaSeconds !== 0 ? theme.accent : theme.cardBorder,
                      width: '100%',
                    },
                  ]}
                >
                  <View style={styles.quickTimePreviewCol}>
                    <Text style={[styles.quickTimePreviewSubLabel, { color: theme.textTertiary }]}>
                      現在の残り
                    </Text>
                    <Text
                      style={[
                        styles.quickTimePreviewDigits,
                        { color: preview.isOver ? theme.danger : theme.textPrimary },
                      ]}
                    >
                      {preview.currentStr}
                    </Text>
                  </View>

                  <View style={{ alignItems: 'center', paddingHorizontal: 6 }}>
                    <Ionicons
                      name="arrow-forward"
                      size={20}
                      color={quickAdjustDeltaSeconds !== 0 ? theme.accent : theme.textTertiary}
                    />
                    <View
                      style={[
                        styles.quickTimeDeltaBadge,
                        {
                          backgroundColor:
                            quickAdjustDeltaSeconds > 0
                              ? (isEcoMode ? '#0B243B' : '#DBEAFE')
                              : quickAdjustDeltaSeconds < 0
                              ? (isEcoMode ? '#331214' : '#FEE2E2')
                              : (isEcoMode ? '#2C2C2E' : '#E5E5EA'),
                          borderColor:
                            quickAdjustDeltaSeconds > 0
                              ? '#3B82F6'
                              : quickAdjustDeltaSeconds < 0
                              ? '#EF4444'
                              : 'transparent',
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.quickTimeDeltaText,
                          {
                            color:
                              quickAdjustDeltaSeconds > 0
                                ? '#2563EB'
                                : quickAdjustDeltaSeconds < 0
                                ? theme.danger
                                : theme.textSecondary,
                          },
                        ]}
                      >
                        {preview.deltaStr}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.quickTimePreviewCol}>
                    <Text style={[styles.quickTimePreviewSubLabel, { color: theme.textTertiary }]}>
                      変更後
                    </Text>
                    <Text
                      style={[
                        styles.quickTimePreviewDigits,
                        {
                          color:
                            quickAdjustDeltaSeconds !== 0
                              ? theme.accent
                              : preview.isOver
                              ? theme.danger
                              : theme.textPrimary,
                          fontWeight: '800',
                        },
                      ]}
                    >
                      {preview.nextStr}
                    </Text>
                  </View>
                </View>
              );
            })()}

            {/* ★ ユーザー指定: プラス３０秒、１分、３分、５分を作る */}
            <View style={{ width: '100%', marginTop: 14 }}>
              <Text style={[styles.quickTimeSectionTitle, { color: theme.textSecondary }]}>
                ⚡ クイック追加
              </Text>
              <View style={[styles.quickTimeButtonRow, { width: '100%' }]}>
                {[
                  { sec: 30, label: '+30秒' },
                  { sec: 60, label: '+1分' },
                  { sec: 180, label: '+3分' },
                  { sec: 300, label: '+5分' },
                ].map((btn) => (
                  <TouchableOpacity
                    key={btn.sec}
                    style={[
                      styles.quickTimeAddPill,
                      {
                        backgroundColor: isEcoMode ? '#1E293B' : '#EFF6FF',
                        borderColor: isEcoMode ? '#3B82F6' : '#93C5FD',
                      },
                    ]}
                    activeOpacity={0.7}
                    onPress={() => handleAddQuickAdjustDelta(btn.sec)}
                  >
                    <Text
                      style={[
                        styles.quickTimeAddPillText,
                        { color: isEcoMode ? '#93C5FD' : '#1D4ED8' },
                      ]}
                    >
                      {btn.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* ★ ユーザー指定: そして−３０秒と＋３０秒できるボタンもつけて */}
            <View style={{ width: '100%', marginTop: 14 }}>
              <Text style={[styles.quickTimeSectionTitle, { color: theme.textSecondary }]}>
                ⚙️ 30秒単位で微調整
              </Text>
              <View style={[styles.quickTimeAdjustRow, { width: '100%' }]}>
                <TouchableOpacity
                  style={[
                    styles.quickTimeStepBtn,
                    {
                      backgroundColor: isEcoMode ? '#2C2C2E' : '#F3F4F6',
                      borderColor: theme.cardBorder,
                    },
                  ]}
                  activeOpacity={0.7}
                  onPress={() => handleAddQuickAdjustDelta(-30)}
                >
                  <Ionicons name="remove-circle-outline" size={17} color={theme.textPrimary} style={{ marginRight: 4 }} />
                  <Text style={[styles.quickTimeStepBtnText, { color: theme.textPrimary }]}>-30秒</Text>
                </TouchableOpacity>

                {quickAdjustDeltaSeconds !== 0 ? (
                  <TouchableOpacity
                    style={[
                      styles.quickTimeResetBtn,
                      {
                        backgroundColor: isEcoMode ? '#252528' : '#F2F2F7',
                        borderColor: theme.cardBorder,
                      },
                    ]}
                    activeOpacity={0.7}
                    onPress={() => setQuickAdjustDeltaSeconds(0)}
                  >
                    <Ionicons name="refresh" size={13} color={theme.textSecondary} style={{ marginRight: 2 }} />
                    <Text style={{ fontSize: 11, color: theme.textSecondary, fontWeight: '600' }}>リセット</Text>
                  </TouchableOpacity>
                ) : null}

                <TouchableOpacity
                  style={[
                    styles.quickTimeStepBtn,
                    {
                      backgroundColor: isEcoMode ? '#0B243B' : '#EFF6FF',
                      borderColor: '#93C5FD',
                    },
                  ]}
                  activeOpacity={0.7}
                  onPress={() => handleAddQuickAdjustDelta(30)}
                >
                  <Ionicons name="add-circle-outline" size={17} color={theme.accent} style={{ marginRight: 4 }} />
                  <Text style={[styles.quickTimeStepBtnText, { color: theme.accent }]}>+30秒</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* ボタングループ */}
            <View style={[styles.actionModalTopButtonsRow, { width: '100%', marginTop: 20 }]}>
              <TouchableOpacity
                style={[
                  styles.actionModalCancelBtn,
                  { backgroundColor: isEcoMode ? '#2C2C2E' : '#E5E5EA' },
                ]}
                onPress={() => setIsQuickAdjustModalVisible(false)}
                activeOpacity={0.7}
              >
                <Text style={[styles.actionModalCancelBtnText, { color: theme.textPrimary }]}>
                  キャンセル
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.actionModalChangeBtn,
                  {
                    backgroundColor: quickAdjustDeltaSeconds !== 0 ? theme.accent : (isEcoMode ? '#3A3A3C' : '#CBD5E1'),
                  },
                ]}
                onPress={handleConfirmQuickTimeAdjust}
                disabled={quickAdjustDeltaSeconds === 0}
                activeOpacity={0.7}
              >
                <Ionicons name="checkmark-sharp" size={16} color="#FFFFFF" style={{ marginRight: 4 }} />
                <Text style={[styles.actionModalChangeBtnText, { color: '#FFFFFF', fontWeight: '700' }]}>
                  変更を適用する
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ⑧ ヘルプ（アシスタント）柔軟指定・変更モーダル（3名共有通知） */}
      <Modal
        visible={isHelpAssignModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsHelpAssignModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
        <TouchableOpacity
          style={styles.actionModalOverlay}
          activeOpacity={1}
          onPress={() => setIsHelpAssignModalVisible(false)}
        >
          <View
            style={[styles.helpAssignModalCard, { backgroundColor: theme.cardBg }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.helpAssignHeader}>
              <View style={{ flex: 1, marginRight: 8 }}>
                <Text style={[styles.helpAssignTitle, { color: theme.textPrimary }]}>
                  🤝 ヘルプ担当の指定・変更
                </Text>
                <Text style={[styles.helpAssignSubtitle, { color: theme.textSecondary }]}>
                  {helpAssignTargetSeat?.seatLabel} （作成者: 📝 {helpAssignTargetSeat?.colorStaffName ? formatCreatorForDisplay(helpAssignTargetSeat, '未設定') : '未設定'}）
                </Text>
              </View>
              <TouchableOpacity onPress={() => setIsHelpAssignModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              ref={helpModalScrollViewRef}
              showsVerticalScrollIndicator={true}
              style={{ width: '100%' }}
              contentContainerStyle={{ paddingBottom: 16 }}
              keyboardShouldPersistTaps="handled"
            >
              {/* ① ワンタップで自分がヘルプに入る */}
              {/* ① ヘルプ不要（1人で施術・ワンマン）のクイック選択 */}
              <TouchableOpacity
                style={[
                  styles.selfTakeBtn,
                  {
                    backgroundColor: helpAssignTargetSeat?.assistantStaffName === 'ヘルプなし'
                      ? (isEcoMode ? 'rgba(255,255,255,0.08)' : theme.accentLight)
                      : (isEcoMode ? '#252528' : '#F9FAFB'),
                    borderColor: helpAssignTargetSeat?.assistantStaffName === 'ヘルプなし'
                      ? theme.accent
                      : theme.cardBorder,
                    borderWidth: helpAssignTargetSeat?.assistantStaffName === 'ヘルプなし' ? 2 : 1,
                    marginBottom: 12,
                  },
                ]}
                onPress={() => handleAssignAssistant('ヘルプなし')}
                activeOpacity={0.7}
              >
                <Ionicons
                  name="person"
                  size={20}
                  color={helpAssignTargetSeat?.assistantStaffName === 'ヘルプなし' ? theme.accent : theme.textSecondary}
                  style={{ marginRight: 10 }}
                />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text
                      style={[
                        styles.selfTakeBtnTitle,
                        { color: helpAssignTargetSeat?.assistantStaffName === 'ヘルプなし' ? theme.accent : theme.textPrimary },
                      ]}
                    >
                      👤 ヘルプなし（1人で施術）
                    </Text>
                    {helpAssignTargetSeat?.assistantStaffName === 'ヘルプなし' && (
                      <View style={[styles.currentSelectedBadge, { backgroundColor: theme.accent, marginLeft: 6 }]}>
                        <Text style={styles.currentSelectedBadgeText}>選択中</Text>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.selfTakeBtnSub, { color: theme.textSecondary }]}>
                    ワンマン施術のためヘルプ不要（1分前アラート対象外）
                  </Text>
                </View>
                <Ionicons
                  name={helpAssignTargetSeat?.assistantStaffName === 'ヘルプなし' ? "checkmark-circle" : "chevron-forward"}
                  size={18}
                  color={helpAssignTargetSeat?.assistantStaffName === 'ヘルプなし' ? theme.accent : theme.textTertiary}
                />
              </TouchableOpacity>

              {/* ★ ユーザー指定: スタッフ一覧の前に希望するヘルプ一覧（コーミング、シャンプー等）を出す */}
              <View style={styles.helpActionHeaderRow}>
                <Text style={[styles.helpSectionLabel, { color: theme.textPrimary, fontWeight: '700', fontSize: 13, marginBottom: 0 }]}>
                  {selectedHelpAction ? '① 希望するヘルプ（選択中）' : '① まず希望するヘルプを選択してください'}
                </Text>
                {selectedHelpAction ? (
                  <TouchableOpacity onPress={() => handleSelectHelpAction(null)}>
                    <Text style={{ fontSize: 11, color: theme.accent, fontWeight: '600' }}>選び直す ▾</Text>
                  </TouchableOpacity>
                ) : null}
              </View>

              <View style={styles.helpActionChipsGrid}>
                {SALON_ACTION_STATUS_OPTIONS.map((opt) => {
                  const isSelected = selectedHelpAction === opt.id;
                  return (
                    <TouchableOpacity
                      key={opt.id}
                      style={[
                        styles.helpActionChip,
                        {
                          backgroundColor: isSelected ? opt.color : (isEcoMode ? '#2C2C2E' : opt.bg),
                          borderColor: isSelected ? opt.color : opt.border,
                          borderWidth: isSelected ? 2 : 1,
                        },
                      ]}
                      onPress={() => handleSelectHelpAction(opt.id)}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name={opt.icon}
                        size={15}
                        color={isSelected ? '#FFFFFF' : opt.color}
                        style={{ marginRight: 5 }}
                      />
                      <Text
                        style={[
                          styles.helpActionChipText,
                          {
                            color: isSelected ? '#FFFFFF' : opt.color,
                            fontWeight: isSelected ? '700' : '600',
                          },
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* ★ ユーザー指定: それを押したら、任せるスタッフ一覧が出る！ */}
              {selectedHelpAction ? (
                <View style={styles.assignStaffSection}>
                  <View
                    style={[
                      styles.selectedActionBanner,
                      {
                        backgroundColor: getActionStatusInfo(selectedHelpAction)?.bg || theme.accentLight,
                        borderColor: getActionStatusInfo(selectedHelpAction)?.color || theme.accent,
                      },
                    ]}
                  >
                    <Ionicons
                      name={getActionStatusInfo(selectedHelpAction)?.icon || 'people'}
                      size={20}
                      color={getActionStatusInfo(selectedHelpAction)?.color || theme.accent}
                      style={{ marginRight: 10 }}
                    />
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          styles.selectedActionBannerTitle,
                          { color: getActionStatusInfo(selectedHelpAction)?.color || theme.accent },
                        ]}
                      >
                        【{getActionStatusInfo(selectedHelpAction)?.label}】を任せるスタッフを選択
                      </Text>
                      <Text
                        style={[
                          styles.selectedActionBannerSub,
                          { color: theme.textSecondary },
                        ]}
                      >
                        下のスタッフ一覧または直接入力から指名
                      </Text>
                    </View>
                  </View>

                  {/* ① 私が【選択中ヘルプ】に入ります（立候補） */}
                  <TouchableOpacity
                    style={[styles.selfTakeBtn, { backgroundColor: theme.accentLight, borderColor: theme.accentBorder, marginTop: 4, marginBottom: 8 }]}
                    onPress={() => handleAssignAssistant(userName || '自分', selectedHelpAction)}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="hand-right" size={20} color={theme.accent} style={{ marginRight: 10 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.selfTakeBtnTitle, { color: theme.accent }]}>
                        自分が【{getActionStatusInfo(selectedHelpAction)?.label}】に入ります（立候補）
                      </Text>
                      <Text style={[styles.selfTakeBtnSub, { color: theme.textSecondary }]}>
                        担当表示: 自分
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={theme.accent} />
                  </TouchableOpacity>

                  {/* ★ 担当者未定のまま【選択中ヘルプ】を依頼・登録する */}
                  <TouchableOpacity
                    style={[styles.selfTakeBtn, { backgroundColor: isEcoMode ? '#2C2C2E' : '#FFF7ED', borderColor: '#FED7AA', marginTop: 0, marginBottom: 8 }]}
                    onPress={() => handleAssignAssistant('', selectedHelpAction)}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="help-circle-outline" size={20} color="#EA580C" style={{ marginRight: 10 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.selfTakeBtnTitle, { color: '#EA580C' }]}>
                        担当者未定のまま【{getActionStatusInfo(selectedHelpAction)?.label}】を依頼する
                      </Text>
                      <Text style={[styles.selfTakeBtnSub, { color: theme.textSecondary }]}>
                        カード右上に「{getActionStatusInfo(selectedHelpAction)?.label}未定」と表示・1分前アラート対象
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color="#EA580C" />
                  </TouchableOpacity>

                  {/* ② スタッフ一覧から指名 */}
                  <Text style={[styles.helpSectionLabel, { color: theme.textTertiary, marginTop: 8, marginBottom: 6 }]}>
                    スタッフ一覧から指名（タップで指定）
                  </Text>
                  {salonStaffList.length === 0 ? (
                    <View style={{ paddingVertical: 12, alignItems: 'center' }}>
                      <Text style={{ fontSize: 12, color: theme.textTertiary, textAlign: 'center', lineHeight: 18 }}>
                        スタッフがまだ登録されていません{'\n'}ヘッダーの「メンバー」ボタンからスタッフを追加できます
                      </Text>
                    </View>
                  ) : (
                    <View style={styles.staffChipsContainer}>
                      {salonStaffList.map((staff) => {
                        const isCurrent = helpAssignTargetSeat?.assistantStaffName === staff;
                        return (
                          <TouchableOpacity
                            key={staff}
                            style={[
                              styles.staffChip,
                              {
                                backgroundColor: isCurrent ? theme.accent : (isEcoMode ? '#2C2C2E' : '#F2F2F7'),
                                borderColor: isCurrent ? theme.accent : theme.cardBorder,
                              },
                            ]}
                            onPress={() => handleAssignAssistant(staff, selectedHelpAction)}
                            activeOpacity={0.7}
                          >
                            <Text
                              style={[
                                styles.staffChipText,
                                { color: isCurrent ? '#FFFFFF' : theme.textPrimary, fontWeight: isCurrent ? '700' : '600' },
                              ]}
                            >
                              🤝 {formatStaffForDisplay(staff)} {isCurrent ? '（現在）' : ''}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}

                  {/* ③ 直接入力して指名 */}
                  <Text style={[styles.helpSectionLabel, { color: theme.textTertiary, marginTop: 10 }]}>
                    直接入力して指名
                  </Text>
                  <View style={styles.helpInputRow}>
                    <TextInput
                      style={[
                        styles.helpTextInput,
                        { backgroundColor: theme.inputBg, color: theme.textPrimary, borderColor: theme.cardBorder },
                      ]}
                      placeholder="スタッフ名を入力..."
                      placeholderTextColor={theme.textTertiary}
                      value={helpInputStaffName}
                      onChangeText={setHelpInputStaffName}
                      returnKeyType="done"
                      onFocus={() => {
                        setTimeout(() => {
                          helpModalScrollViewRef.current?.scrollToEnd({ animated: true });
                        }, 150);
                      }}
                      onSubmitEditing={() => {
                        if (helpInputStaffName.trim()) {
                          handleAssignAssistant(helpInputStaffName, selectedHelpAction);
                        }
                      }}
                    />
                    <TouchableOpacity
                      style={[
                        styles.helpSubmitBtn,
                        { backgroundColor: helpInputStaffName.trim() ? theme.accent : (isEcoMode ? '#3A3A3C' : '#D1D1D6') },
                      ]}
                      disabled={!helpInputStaffName.trim()}
                      onPress={() => handleAssignAssistant(helpInputStaffName, selectedHelpAction)}
                    >
                      <Text style={styles.helpSubmitBtnText}>指定する</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <View style={[styles.helpSelectPromptBox, { backgroundColor: isEcoMode ? '#252528' : '#F8F9FA', borderColor: theme.cardBorder }]}>
                  <Ionicons name="arrow-up-circle-outline" size={20} color={theme.accent} style={{ marginRight: 8 }} />
                  <Text style={[styles.helpSelectPromptText, { color: theme.textSecondary }]}>
                    上のリストから希望するヘルプ（シャンプーやコーミング等）をタップすると、任せるスタッフ一覧が表示されます。
                  </Text>
                </View>
              )}

              {/* ④ ヘルプ解除ボタン */}
              {helpAssignTargetSeat?.assistantStaffName && helpAssignTargetSeat?.assistantStaffName !== 'ヘルプなし' ? (
                <TouchableOpacity
                  style={[styles.helpClearBtn, { borderColor: theme.cardBorder, marginTop: 14 }]}
                  onPress={() => handleAssignAssistant('')}
                >
                  <Ionicons name="close-circle-outline" size={16} color={theme.textTertiary} style={{ marginRight: 4 }} />
                  <Text style={[styles.helpClearBtnText, { color: theme.textSecondary }]}>
                    ヘルプ担当を解除する（未定に戻す）
                  </Text>
                </TouchableOpacity>
              ) : null}

              {/* 3名通知の注記 */}
              <View style={[styles.notificationNoteBox, { backgroundColor: isEcoMode ? 'rgba(0,0,0,0.3)' : '#F8F9FA', marginTop: 12 }]}>
                <Ionicons name="information-circle-outline" size={15} color={theme.accent} style={{ marginRight: 6 }} />
                <Text style={[styles.notificationNoteText, { color: theme.textSecondary }]}>
                  指定すると、メイン担当・指名されたヘルプ・指定した自分（第3者）の【関係者3名全員】にリアルタイム通知が届きます。
                </Text>
              </View>
            </ScrollView>
          </View>
        </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* ⑧-B ★ ユーザー指定: チェック担当スタッフ指定・変更モーダル */}
      <Modal
        visible={isCheckStaffModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsCheckStaffModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
        <TouchableOpacity
          style={styles.actionModalOverlay}
          activeOpacity={1}
          onPress={() => setIsCheckStaffModalVisible(false)}
        >
          <View
            style={[styles.helpAssignModalCard, { backgroundColor: theme.cardBg }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.helpAssignHeader}>
              <View style={{ flex: 1, marginRight: 8 }}>
                <Text style={[styles.helpAssignTitle, { color: theme.textPrimary }]}>
                  🔍 チェック担当の指定・確認
                </Text>
                <Text style={[styles.helpAssignSubtitle, { color: theme.textSecondary }]}>
                  {checkStaffTargetSeat?.seatLabel} （予定: {checkStaffTargetSeat?.checkInitialMinutes || Math.round((checkStaffTargetSeat?.checkTargetSeconds || 0) / 60)}分チェック）
                </Text>
              </View>
              <TouchableOpacity onPress={() => setIsCheckStaffModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              ref={checkStaffModalScrollViewRef}
              showsVerticalScrollIndicator={true}
              style={{ width: '100%' }}
              contentContainerStyle={{ paddingBottom: 16 }}
              keyboardShouldPersistTaps="handled"
            >
              {/* ⓪ チェック内容（工程）選択（4種・シャンプー完全除外） */}
              <Text style={[styles.helpSectionLabel, { color: theme.textTertiary, marginTop: 2, marginBottom: 6 }]}>
                チェック内容（中間工程）
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                {CHECK_PROCESS_OPTIONS.map((proc) => {
                  const currentChkProc = sanitizeCheckProcess(checkStaffTargetSeat?.checkProcess);
                  const isProcCurrent = currentChkProc === proc;
                  return (
                    <TouchableOpacity
                      key={`chk-staff-modal-proc-${proc}`}
                      style={[
                        styles.staffChip,
                        {
                          backgroundColor: isProcCurrent ? '#0EA5E9' : (isEcoMode ? '#2C2C2E' : '#F2F2F7'),
                          borderColor: isProcCurrent ? '#0EA5E9' : theme.cardBorder,
                        },
                      ]}
                      onPress={() => handleSelectCheckProcess(checkStaffTargetSeat?.id, proc)}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={[
                          styles.staffChipText,
                          {
                            color: isProcCurrent ? '#FFFFFF' : theme.textPrimary,
                            fontWeight: isProcCurrent ? '700' : '600',
                          },
                        ]}
                      >
                        {proc}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* ① ワンタップで自分がチェックに入る */}
              <TouchableOpacity
                style={[
                  styles.selfTakeBtn,
                  {
                    backgroundColor: isStaffNameMe(checkStaffTargetSeat?.checkStaffName)
                      ? (isEcoMode ? 'rgba(16, 185, 129, 0.2)' : '#D1FAE5')
                      : (isEcoMode ? '#252528' : '#ECFDF5'),
                    borderColor: isStaffNameMe(checkStaffTargetSeat?.checkStaffName)
                      ? '#10B981'
                      : '#A7F3D0',
                    borderWidth: isStaffNameMe(checkStaffTargetSeat?.checkStaffName) ? 2 : 1,
                    marginBottom: 10,
                  },
                ]}
                onPress={() => handleAssignCheckStaff(checkStaffTargetSeat?.id, userName || '自分')}
                activeOpacity={0.7}
              >
                <Ionicons name="search" size={20} color="#059669" style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.selfTakeBtnTitle, { color: '#059669' }]}>
                    自分がチェックに入ります
                  </Text>
                  <Text style={[styles.selfTakeBtnSub, { color: theme.textSecondary }]}>
                    ワンタップでチェック担当として立候補（表示: 自分）
                  </Text>
                </View>
                {isStaffNameMe(checkStaffTargetSeat?.checkStaffName) && (
                  <Ionicons name="checkmark-circle" size={20} color="#10B981" />
                )}
              </TouchableOpacity>

              {/* ② スタッフ一覧からワンタップ指名 */}
              <Text style={[styles.helpSectionLabel, { color: theme.textTertiary, marginTop: 6, marginBottom: 6 }]}>
                サロン参加スタッフから指名（タップで指定）
              </Text>
              {salonStaffList.length === 0 ? (
                <View style={{ paddingVertical: 12, alignItems: 'center' }}>
                  <Text style={{ fontSize: 12, color: theme.textTertiary, textAlign: 'center', lineHeight: 18 }}>
                    スタッフがまだ登録されていません{'\n'}ヘッダーの「メンバー」ボタンからスタッフを追加できます
                  </Text>
                </View>
              ) : (
                <View style={styles.staffChipsContainer}>
                  {salonStaffList.map((staff) => {
                    const isCurrent = checkStaffTargetSeat?.checkStaffName === staff;
                    return (
                      <TouchableOpacity
                        key={staff}
                        style={[
                          styles.staffChip,
                          {
                            backgroundColor: isCurrent ? '#10B981' : (isEcoMode ? '#2C2C2E' : '#F2F2F7'),
                            borderColor: isCurrent ? '#10B981' : theme.cardBorder,
                          },
                        ]}
                        onPress={() => handleAssignCheckStaff(checkStaffTargetSeat?.id, staff)}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            styles.staffChipText,
                            {
                              color: isCurrent ? '#FFFFFF' : theme.textPrimary,
                              fontWeight: isCurrent ? '700' : '600',
                            },
                          ]}
                        >
                          🔍 {formatStaffForDisplay(staff)} {isCurrent ? '（現在）' : ''}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}

              {/* ③ 直接名前入力フォーム */}
              <Text style={[styles.helpSectionLabel, { color: theme.textTertiary, marginTop: 12 }]}>
                名前を直接入力して指名
              </Text>
              <View style={styles.helpInputRow}>
                <TextInput
                  style={[
                    styles.helpTextInput,
                    { backgroundColor: theme.inputBg, color: theme.textPrimary, borderColor: theme.cardBorder },
                  ]}
                  placeholder="チェック担当者名を入力..."
                  placeholderTextColor={theme.textTertiary}
                  value={inputCheckStaffName}
                  onChangeText={setInputCheckStaffName}
                  returnKeyType="done"
                  onFocus={() => {
                    setTimeout(() => {
                      checkStaffModalScrollViewRef.current?.scrollToEnd({ animated: true });
                    }, 150);
                  }}
                  onSubmitEditing={() => {
                    if (inputCheckStaffName.trim()) {
                      handleAssignCheckStaff(checkStaffTargetSeat?.id, inputCheckStaffName);
                    }
                  }}
                />
                <TouchableOpacity
                  style={[
                    styles.helpSubmitBtn,
                    { backgroundColor: inputCheckStaffName.trim() ? '#10B981' : (isEcoMode ? '#3A3A3C' : '#D1D1D6') },
                  ]}
                  disabled={!inputCheckStaffName.trim()}
                  onPress={() => handleAssignCheckStaff(checkStaffTargetSeat?.id, inputCheckStaffName)}
                >
                  <Text style={styles.helpSubmitBtnText}>指定する</Text>
                </TouchableOpacity>
              </View>

              {/* ④ この場でチェック完了にするクイックボタン */}
              {checkStaffTargetSeat?.checkStatus !== 'completed' && (
                <TouchableOpacity
                  style={[
                    styles.selfTakeBtn,
                    {
                      backgroundColor: isEcoMode ? 'rgba(16, 185, 129, 0.15)' : '#ECFDF5',
                      borderColor: '#10B981',
                      marginTop: 14,
                    },
                  ]}
                  onPress={() => {
                    const seatId = checkStaffTargetSeat?.id;
                    setIsCheckStaffModalVisible(false);
                    handleCompleteCheck(seatId);
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="checkmark-done-circle" size={22} color="#10B981" style={{ marginRight: 10 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.selfTakeBtnTitle, { color: '#059669' }]}>
                      ✓ この場でチェックを完了にする
                    </Text>
                    <Text style={[styles.selfTakeBtnSub, { color: theme.textSecondary }]}>
                      発色や状態の確認が済みました（履歴に記録されます）
                    </Text>
                  </View>
                </TouchableOpacity>
              )}

              {/* ⑤ チェック担当を解除（未定に戻す） */}
              {checkStaffTargetSeat?.checkStaffName ? (
                <TouchableOpacity
                  style={[styles.helpClearBtn, { borderColor: theme.cardBorder, marginTop: 12 }]}
                  onPress={() => handleAssignCheckStaff(checkStaffTargetSeat?.id, '')}
                >
                  <Ionicons name="close-circle-outline" size={16} color={theme.textTertiary} style={{ marginRight: 4 }} />
                  <Text style={[styles.helpClearBtnText, { color: theme.textSecondary }]}>
                    チェック担当を解除する（未定に戻す）
                  </Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          </View>
        </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* ⑨ 施術工程・ステータス選択モーダル（呼び出し、コーミング、チェック、シャンプー、その他、解除） */}
      <Modal
        visible={isActionStatusModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsActionStatusModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.actionModalOverlay}
          activeOpacity={1}
          onPress={() => setIsActionStatusModalVisible(false)}
        >
          <View
            style={[styles.statusModalCard, { backgroundColor: theme.cardBg }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.statusModalHeader}>
              <View style={{ flex: 1, marginRight: 8 }}>
                <Text style={[styles.statusModalTitle, { color: theme.textPrimary }]}>
                  施術工程・状態を選択
                </Text>
                <Text style={[styles.statusModalSubtitle, { color: theme.textSecondary }]}>
                  {actionStatusTargetSeat?.seatLabel || '対象席'}（現在の状態: {
                    getActionStatusInfo(actionStatusTargetSeat?.actionStatus, actionStatusTargetSeat?.isShampooing)?.badge || '未設定'
                  }）
                </Text>
              </View>
              <TouchableOpacity onPress={() => setIsActionStatusModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} style={{ width: '100%', maxHeight: 380 }}>
              <View style={styles.statusOptionsList}>
                {SALON_ACTION_STATUS_OPTIONS.map((opt) => {
                  const isCurrent = (actionStatusTargetSeat?.actionStatus === opt.id) ||
                    (!actionStatusTargetSeat?.actionStatus && opt.id === 'shampoo' && actionStatusTargetSeat?.isShampooing);
                  return (
                    <TouchableOpacity
                      key={opt.id}
                      style={[
                        styles.statusOptionItem,
                        {
                          backgroundColor: isCurrent ? (isEcoMode ? 'rgba(255,255,255,0.08)' : opt.bg) : (isEcoMode ? '#2C2C2E' : '#F9FAFB'),
                          borderColor: isCurrent ? opt.color : theme.cardBorder,
                          borderWidth: isCurrent ? 2 : 1,
                        },
                      ]}
                      onPress={() => handleSelectActionStatus(opt.id)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.statusOptionLeft}>
                        <View style={[styles.statusOptionIconBox, { backgroundColor: opt.color }]}>
                          <Ionicons name={opt.icon} size={18} color="#FFFFFF" />
                        </View>
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={[styles.statusOptionLabel, { color: theme.textPrimary, fontWeight: isCurrent ? '700' : '600' }]}>
                              {opt.label}
                            </Text>
                            {isCurrent && (
                              <View style={[styles.currentSelectedBadge, { backgroundColor: opt.color }]}>
                                <Text style={styles.currentSelectedBadgeText}>選択中</Text>
                              </View>
                            )}
                          </View>
                          <Text style={[styles.statusOptionDesc, { color: theme.textSecondary }]}>
                            {opt.desc}
                          </Text>
                        </View>
                      </View>
                      <Ionicons
                        name={isCurrent ? "checkmark-circle" : "chevron-forward"}
                        size={20}
                        color={isCurrent ? opt.color : theme.textTertiary}
                      />
                    </TouchableOpacity>
                  );
                })}

                {/* 状態解除ボタン（未設定に戻す） */}
                {(actionStatusTargetSeat?.actionStatus || actionStatusTargetSeat?.isShampooing) ? (
                  <TouchableOpacity
                    style={[styles.statusClearItem, { borderColor: theme.cardBorder }]}
                    onPress={() => handleSelectActionStatus(null)}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="close-circle-outline" size={18} color={theme.textTertiary} style={{ marginRight: 6 }} />
                    <Text style={[styles.statusClearText, { color: theme.textSecondary }]}>
                      状態を解除する（未設定に戻す）
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ⑨-B 施術メモ編集モーダル（カード画面から直接タップで編集） */}
      <Modal
        visible={isEditCommentModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsEditCommentModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
        <TouchableOpacity
          style={styles.actionModalOverlay}
          activeOpacity={1}
          onPress={() => setIsEditCommentModalVisible(false)}
        >
          <View
            style={[styles.actionModalCard, { backgroundColor: theme.cardBg }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.actionModalHeaderRow}>
              <Text style={[styles.actionModalTitle, { color: theme.textPrimary, marginBottom: 0 }]}>
                💬 施術メモの編集
              </Text>
              <TouchableOpacity
                onPress={() => setIsEditCommentModalVisible(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={22} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={[styles.actionModalMessage, { color: theme.textSecondary, marginBottom: 14 }]}>
              「{commentTargetSeat?.seatLabel || '対象席'}」の施術メモを入力
            </Text>

            <TextInput
              style={[
                styles.textInput,
                {
                  backgroundColor: theme.inputBg,
                  color: theme.textPrimary,
                  borderColor: theme.cardBorder,
                  height: 70,
                  textAlignVertical: 'top',
                  width: '100%',
                  marginBottom: 14,
                },
              ]}
              placeholder="例: 根元チェック後乳化、耳カバー注意など"
              placeholderTextColor={theme.textTertiary}
              value={editCommentText}
              onChangeText={setEditCommentText}
              multiline={true}
              autoFocus={true}
            />

            <View style={{ flexDirection: 'row', width: '100%', gap: 10 }}>
              <TouchableOpacity
                style={[
                  styles.actionModalCancelBtn,
                  { backgroundColor: isEcoMode ? '#2C2C2E' : '#E5E5EA' },
                ]}
                onPress={() => setIsEditCommentModalVisible(false)}
              >
                <Text style={[styles.actionModalCancelBtnText, { color: theme.textPrimary }]}>
                  キャンセル
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionModalChangeBtn, { backgroundColor: theme.accent }]}
                onPress={handleSaveComment}
              >
                <Text style={[styles.actionModalChangeBtnText, { color: '#FFFFFF' }]}>
                  保存する
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* ⑩ 第三者・代理確認モーダル */}
      <Modal
        visible={isConfirmProxyModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsConfirmProxyModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.actionModalOverlay}
          activeOpacity={1}
          onPress={() => setIsConfirmProxyModalVisible(false)}
        >
          <View
            style={[styles.proxyConfirmModalCard, { backgroundColor: theme.cardBg }]}
            onStartShouldSetResponder={() => true}
          >
            {/* ヘッダー */}
            <View style={styles.proxyConfirmHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={[styles.proxyIconCircle, { backgroundColor: isEcoMode ? 'rgba(255, 149, 0, 0.2)' : '#FFF7ED' }]}>
                  <Ionicons name="shield-checkmark" size={22} color="#FF9500" />
                </View>
                <View style={{ marginLeft: 10 }}>
                  <Text style={[styles.proxyConfirmTitle, { color: theme.textPrimary }]}>
                    タイムの代理確認
                  </Text>
                  <Text style={[styles.proxyConfirmSubtitle, { color: theme.textSecondary }]}>
                    {confirmProxyTargetSeat?.seatLabel}
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => setIsConfirmProxyModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* 現在の担当者 ＆ 確認ステータス表示ボックス */}
            <View style={[styles.proxyStatusCard, { backgroundColor: isEcoMode ? '#252528' : '#F2F2F7', borderColor: theme.cardBorder }]}>
              <Text style={[styles.proxyStatusCardLabel, { color: theme.textTertiary }]}>
                現在の担当者と確認状況
              </Text>

              {/* タイマー作成者（メイン）行 */}
              <View style={styles.proxyStatusRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, marginRight: 6 }}>📝</Text>
                  <Text style={[styles.proxyStaffName, { color: theme.textPrimary }]}>
                    {confirmProxyTargetSeat?.colorStaffName ? formatCreatorForDisplay(confirmProxyTargetSeat, '未設定') : '未設定'}
                    <Text style={{ fontSize: 11, color: theme.textTertiary }}>（タイマー作成）</Text>
                  </Text>
                </View>
                <View style={[
                  styles.proxyStatusBadge,
                  { backgroundColor: 'rgba(52, 199, 89, 0.15)' }
                ]}>
                  <Text style={{
                    fontSize: 12,
                    fontWeight: '700',
                    color: theme.success
                  }}>
                    ✓ 設定済 (確認不要)
                  </Text>
                </View>
              </View>

              {/* ヘルプ担当行 */}
              <View style={[styles.proxyStatusRow, { marginTop: 8 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, marginRight: 6 }}>🤝</Text>
                  <Text style={[styles.proxyStaffName, { color: theme.textPrimary }]}>
                    {formatStaffForDisplay(confirmProxyTargetSeat?.assistantStaffName, '未定')}
                    <Text style={{ fontSize: 11, color: theme.textTertiary }}>（ヘルプ）</Text>
                  </Text>
                </View>
                <View style={[
                  styles.proxyStatusBadge,
                  {
                    backgroundColor: confirmProxyTargetSeat?.assistantStaffName === 'ヘルプなし'
                      ? 'rgba(128, 128, 128, 0.15)'
                      : confirmProxyTargetSeat?.assistantStaffConfirmed
                      ? 'rgba(52, 199, 89, 0.15)'
                      : 'rgba(255, 59, 48, 0.15)'
                  }
                ]}>
                  <Text style={{
                    fontSize: 12,
                    fontWeight: '700',
                    color: confirmProxyTargetSeat?.assistantStaffName === 'ヘルプなし'
                      ? theme.textSecondary
                      : confirmProxyTargetSeat?.assistantStaffConfirmed
                      ? theme.success
                      : theme.danger
                  }}>
                    {confirmProxyTargetSeat?.assistantStaffName === 'ヘルプなし'
                      ? 'ヘルプ不要'
                      : confirmProxyTargetSeat?.assistantStaffConfirmed
                      ? '✓ 確認済み'
                      : '✕ 未確認'}
                  </Text>
                </View>
              </View>
            </View>

            <Text style={[styles.proxyExplanationText, { color: theme.textSecondary }]}>
              タイマー作成者は自分でタイムを入れているため確認不要です。{'\n'}
              ヘルプ担当者（{formatStaffForDisplay(confirmProxyTargetSeat?.assistantStaffName, 'ヘルプ担当')}）の代わりに代理確認を行いますか？
            </Text>

            {/* 選択肢ボタン群 */}
            <View style={styles.proxyActionButtonsContainer}>
              {/* ヘルプの代わりに確認 */}
              <TouchableOpacity
                style={[styles.proxyConfirmOptionBtn, { backgroundColor: isEcoMode ? '#2C2C2E' : '#FFFFFF', borderColor: theme.cardBorder }]}
                onPress={() => handleExecuteProxyConfirm(confirmProxyTargetSeat?.id, 'assistant')}
                activeOpacity={0.7}
              >
                <Text style={{ fontSize: 18, marginRight: 10 }}>🤝</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.proxyConfirmOptionTitle, { color: theme.textPrimary }]}>
                    ヘルプ（{formatStaffForDisplay(confirmProxyTargetSeat?.assistantStaffName, 'ヘルプ担当')}）の代わりに確認
                  </Text>
                  <Text style={[styles.proxyConfirmOptionSub, { color: theme.textTertiary }]}>
                    ヘルプ担当者の確認を代行します（関係者に通知記録）
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={theme.textTertiary} />
              </TouchableOpacity>
            </View>

            {/* キャンセルボタン */}
            <TouchableOpacity
              style={[styles.proxyCancelBtn, { backgroundColor: isEcoMode ? '#2C2C2E' : '#E5E5EA' }]}
              onPress={() => setIsConfirmProxyModalVisible(false)}
              activeOpacity={0.7}
            >
              <Text style={[styles.proxyCancelBtnText, { color: theme.textPrimary }]}>
                キャンセル
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ⑪ 施術履歴手動追加モーダル */}
      <Modal
        visible={isAddHistoryModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsAddHistoryModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
        <TouchableOpacity
          style={styles.actionModalOverlay}
          activeOpacity={1}
          onPress={() => setIsAddHistoryModalVisible(false)}
        >
          <View
            style={[styles.addHistoryModalCard, { backgroundColor: theme.cardBg }]}
            onStartShouldSetResponder={() => true}
          >
            {/* ヘッダー */}
            <View style={styles.proxyConfirmHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={[styles.proxyIconCircle, { backgroundColor: theme.accentLight }]}>
                  <Ionicons name="list-outline" size={22} color={theme.accent} />
                </View>
                <View style={{ marginLeft: 10 }}>
                  <Text style={[styles.proxyConfirmTitle, { color: theme.textPrimary }]}>
                    施術履歴の追加
                  </Text>
                  <Text style={[styles.proxyConfirmSubtitle, { color: theme.textSecondary }]}>
                    {addHistoryTargetSeat?.seatLabel} （{getCurrentTimeFormatted()} 記録）
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => setIsAddHistoryModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* クイックサジェストチップ群 */}
            <Text style={[styles.proxyStatusCardLabel, { color: theme.textTertiary, marginBottom: 6 }]}>
              よく使う工程（ワンタップで追加）
            </Text>
            <View style={styles.quickHistoryChipsContainer}>
              {[
                '10分放置',
                `${userName || '担当'}チェック`,
                '7分追加放置',
                '伊藤シャンプー',
                'コーミング完了',
                '乳化チェック',
                'トリートメント塗布',
              ].map((itemText) => (
                <TouchableOpacity
                  key={itemText}
                  style={[styles.quickHistoryChip, { backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7', borderColor: theme.cardBorder }]}
                  onPress={() => handleConfirmAddHistory(itemText)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.quickHistoryChipText, { color: theme.textPrimary }]}>
                    ＋ {itemText}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* 自由入力フォーム */}
            <Text style={[styles.proxyStatusCardLabel, { color: theme.textTertiary, marginTop: 10, marginBottom: 6 }]}>
              直接入力して追加
            </Text>
            <View style={styles.helpInputRow}>
              <TextInput
                style={[
                  styles.helpTextInput,
                  { backgroundColor: theme.inputBg, color: theme.textPrimary, borderColor: theme.cardBorder },
                ]}
                placeholder="例: カラー塗布完了、5分延長など..."
                placeholderTextColor={theme.textTertiary}
                value={inputHistoryText}
                onChangeText={setInputHistoryText}
                returnKeyType="done"
                onSubmitEditing={() => {
                  if (inputHistoryText.trim()) {
                    handleConfirmAddHistory(inputHistoryText);
                  }
                }}
              />
              <TouchableOpacity
                style={[
                  styles.helpSubmitBtn,
                  { backgroundColor: inputHistoryText.trim() ? theme.accent : (isEcoMode ? '#3A3A3C' : '#D1D1D6') },
                ]}
                disabled={!inputHistoryText.trim()}
                onPress={() => handleConfirmAddHistory(inputHistoryText)}
              >
                <Text style={styles.helpSubmitBtnText}>追加</Text>
              </TouchableOpacity>
            </View>

            {/* 閉じるボタン */}
            <TouchableOpacity
              style={[styles.proxyCancelBtn, { backgroundColor: isEcoMode ? '#2C2C2E' : '#E5E5EA', marginTop: 10 }]}
              onPress={() => setIsAddHistoryModalVisible(false)}
              activeOpacity={0.7}
            >
              <Text style={[styles.proxyCancelBtnText, { color: theme.textPrimary }]}>
                閉じる
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* ★ 共有スタッフメンバー管理モーダル */}
      <Modal
        visible={isMemberManageModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIsMemberManageModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, maxHeight: '88%' }]}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="people" size={20} color={theme.accent} style={{ marginRight: 8 }} />
                <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>共有メンバー管理</Text>
              </View>
              <TouchableOpacity onPress={() => setIsMemberManageModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 12, lineHeight: 17 }}>
              招待コードで接続したメンバーのみが連動します。{'\n'}
              IDで管理されるため、相手の登録名とこちらでの呼び名が違っても安全に同期されます。
            </Text>

            {/* あなたの共有コード表示エリア */}
            <View
              style={{
                backgroundColor: isEcoMode ? '#1C1C1E' : '#F2F2F7',
                borderRadius: 10,
                padding: 12,
                marginBottom: 12,
                borderWidth: 1,
                borderColor: theme.cardBorder,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textSecondary }}>
                  このサロンの招待コード（親コード）
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    setIsMemberManageModalVisible(false);
                    setInputInviteCode('');
                    setInputStaffName(userName || 'アシスタント');
                    setIsJoinCodeModalVisible(true);
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '700', color: theme.accent }}>＋ 別のサロンに参加</Text>
                </TouchableOpacity>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text
                  style={{
                    fontSize: 20,
                    fontWeight: '800',
                    color: theme.accent,
                    letterSpacing: 2,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {currentSalon?.inviteCode || '---'}
                </Text>
                <TouchableOpacity
                  style={{
                    backgroundColor: theme.accent,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                  }}
                  onPress={() => handleShareInviteCode(currentSalon)}
                >
                  <Ionicons name="share-outline" size={14} color="#fff" style={{ marginRight: 4 }} />
                  <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 12 }}>コード共有</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* セクション切り替えタブ */}
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              <TouchableOpacity
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 8,
                  backgroundColor: memberManageSection === 'list' ? theme.accent : theme.inputBg,
                  alignItems: 'center',
                }}
                onPress={() => setMemberManageSection('list')}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: 'bold',
                    color: memberManageSection === 'list' ? '#fff' : theme.textSecondary,
                  }}
                >
                  メンバー一覧 ({staffMembers.length})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 8,
                  backgroundColor: memberManageSection === 'join' ? theme.accent : theme.inputBg,
                  alignItems: 'center',
                }}
                onPress={() => setMemberManageSection('join')}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: 'bold',
                    color: memberManageSection === 'join' ? '#fff' : theme.textSecondary,
                  }}
                >
                  ＋ メンバー追加・連携
                </Text>
              </TouchableOpacity>
            </View>

            {/* セクション1: スタッフメンバー追加・連携フォーム */}
            {memberManageSection === 'join' ? (
              <View style={{ backgroundColor: theme.inputBg, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: theme.cardBorder, marginBottom: 12 }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: theme.textPrimary, marginBottom: 6 }}>
                  スタッフメンバーを追加・連携
                </Text>

                <Text style={{ fontSize: 11, color: theme.textSecondary, marginBottom: 4 }}>
                  スタッフのお名前・ニックネーム（必須）
                </Text>
                <TextInput
                  style={[
                    styles.modalInput,
                    {
                      backgroundColor: theme.cardBg,
                      color: theme.textPrimary,
                      borderColor: theme.cardBorder,
                      marginBottom: 8,
                      fontSize: 14,
                    },
                  ]}
                  placeholder="例: 佐藤、田中、アシスタント"
                  placeholderTextColor={theme.textTertiary}
                  value={inputJoinMemberNickname}
                  onChangeText={setInputJoinMemberNickname}
                  maxLength={12}
                  returnKeyType="next"
                />

                <Text style={{ fontSize: 11, color: theme.textSecondary, marginBottom: 4 }}>
                  相手の共有コード（任意・コード連携時に入力）
                </Text>
                <TextInput
                  style={[
                    styles.modalInput,
                    {
                      backgroundColor: theme.cardBg,
                      color: theme.textPrimary,
                      borderColor: theme.cardBorder,
                      marginBottom: 12,
                      fontSize: 14,
                    },
                  ]}
                  placeholder="例: 000-000 (未入力でも追加可能)"
                  placeholderTextColor={theme.textTertiary}
                  value={inputJoinMemberCode}
                  onChangeText={setInputJoinMemberCode}
                  autoCapitalize="characters"
                  returnKeyType="done"
                />

                <TouchableOpacity
                  style={{
                    backgroundColor: theme.accent,
                    paddingVertical: 10,
                    borderRadius: 8,
                    alignItems: 'center',
                  }}
                  onPress={handleJoinMemberByCode}
                >
                  <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 13 }}>メンバーを追加・連携する</Text>
                </TouchableOpacity>
              </View>
            ) : (
              /* セクション2: 登録メンバー一覧 */
              <ScrollView style={{ maxHeight: 220 }} showsVerticalScrollIndicator={false}>
                {staffMembers.length === 0 ? (
                  <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                    <Ionicons name="people-outline" size={32} color={theme.textTertiary} style={{ marginBottom: 6 }} />
                    <Text style={{ fontSize: 12, color: theme.textTertiary, textAlign: 'center', lineHeight: 18 }}>
                      まだ共有メンバーがいません{'\n'}上の共有コードをスタッフに渡すか、{'\n'}「＋ メンバー追加・連携」から登録してください
                    </Text>
                  </View>
                ) : (
                  <View style={{ gap: 8 }}>
                    {staffMembers.map((member, idx) => {
                      const displayName = getMemberDisplayName(member);
                      const origName = typeof member === 'object' ? member.originalNickname : member;
                      const memberId = typeof member === 'object' && member.id ? member.id.slice(-6) : `L${idx + 1}`;
                      const hasCustom = typeof member === 'object' && member.customNickname && member.customNickname !== member.originalNickname;

                      return (
                        <View
                          key={typeof member === 'object' && member.id ? member.id : `mem-${idx}`}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            backgroundColor: theme.inputBg,
                            borderRadius: 10,
                            borderColor: theme.cardBorder,
                            borderWidth: 1,
                          }}
                        >
                          <View style={{ flex: 1, marginRight: 8 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                              <Ionicons
                                name={member.role === 'owner' ? 'ribbon' : 'person'}
                                size={14}
                                color={member.role === 'owner' ? '#FF9500' : theme.accent}
                                style={{ marginRight: 2 }}
                              />
                              <Text style={{ fontSize: 15, fontWeight: '700', color: theme.textPrimary }}>
                                {displayName}
                              </Text>
                              {member.isMe ? (
                                <View style={{ backgroundColor: theme.accent, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                                  <Text style={{ color: '#fff', fontSize: 9, fontWeight: 'bold' }}>自分</Text>
                                </View>
                              ) : null}
                              {member.role === 'owner' ? (
                                <View style={{ backgroundColor: '#FF9500', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                                  <Text style={{ color: '#fff', fontSize: 9, fontWeight: 'bold' }}>オーナー</Text>
                                </View>
                              ) : null}
                            </View>
                            <Text style={{ fontSize: 10, color: theme.textTertiary, marginTop: 2, marginLeft: 20 }}>
                              登録名: {origName} {hasCustom ? '(呼び名変更中)' : ''} | ID: #{memberId}
                            </Text>
                          </View>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <TouchableOpacity
                              onPress={() => handleOpenEditNicknameModal(member)}
                              style={{
                                paddingHorizontal: 8,
                                paddingVertical: 4,
                                backgroundColor: isEcoMode ? '#2C2C2E' : '#E5E5EA',
                                borderRadius: 6,
                              }}
                            >
                              <Text style={{ fontSize: 11, fontWeight: '600', color: theme.accent }}>呼び名</Text>
                            </TouchableOpacity>
                            {member.role !== 'owner' ? (
                              <TouchableOpacity
                                onPress={() => handleRemoveStaffMember(member)}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                style={{ padding: 4 }}
                              >
                                <Ionicons name="trash-outline" size={17} color={theme.danger} />
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </ScrollView>
            )}

            <TouchableOpacity
              style={[styles.modalButtonPrimary, { backgroundColor: theme.accent, marginTop: 16 }]}
              onPress={() => setIsMemberManageModalVisible(false)}
            >
              <Text style={styles.modalButtonPrimaryText}>完了</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ★ 呼び名（カスタムニックネーム）変更モーダル */}
      <Modal
        visible={isEditNicknameModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIsEditNicknameModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}>
            <View style={styles.modalHeaderRow}>
              <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>呼び名（表示名）の変更</Text>
              <TouchableOpacity onPress={() => setIsEditNicknameModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 8, lineHeight: 17 }}>
              相手の登録名: 【{typeof editingMemberForNickname === 'object' ? editingMemberForNickname?.originalNickname : editingMemberForNickname}】{'\n'}
              あなた側から見える呼びやすい名前を設定できます。{'\n'}
              IDで紐づいているため、呼び名を変えても連動は維持されます。
            </Text>

            <TextInput
              style={[
                styles.modalInput,
                {
                  backgroundColor: theme.inputBg,
                  color: theme.textPrimary,
                  borderColor: theme.cardBorder,
                  marginBottom: 16,
                  fontSize: 15,
                },
              ]}
              placeholder="呼び名 (例: 田中 店長)"
              placeholderTextColor={theme.textTertiary}
              value={inputMemberCustomNickname}
              onChangeText={setInputMemberCustomNickname}
              maxLength={12}
              returnKeyType="done"
              onSubmitEditing={handleSaveMemberCustomNickname}
            />

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                style={[styles.proxyCancelBtn, { flex: 1, backgroundColor: isEcoMode ? '#2C2C2E' : '#E5E5EA' }]}
                onPress={() => setIsEditNicknameModalVisible(false)}
              >
                <Text style={[styles.proxyCancelBtnText, { color: theme.textPrimary }]}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButtonPrimary, { flex: 1, backgroundColor: theme.accent, marginTop: 0 }]}
                onPress={handleSaveMemberCustomNickname}
              >
                <Text style={styles.modalButtonPrimaryText}>保存する</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ★ 席名変更モーダル（カード・スリムバーからいつでも変更可能） */}
      <Modal
        visible={isRenameSeatModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIsRenameSeatModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, maxWidth: 360 }]}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="pencil" size={18} color={theme.accent} style={{ marginRight: 6 }} />
                <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>席名の変更</Text>
              </View>
              <TouchableOpacity onPress={() => setIsRenameSeatModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 10, lineHeight: 17 }}>
              現在の席名: 【{renameTargetSeat?.seatLabel?.replace(/^[🪑⌚️⏱️]\s*/, '') || '席'}】{'\n'}
              サロンボードおよびApple Watchに表示される席名を変更できます。（※タイマーは停止せず計測を継続します）
            </Text>

            <TextInput
              style={[
                styles.modalInput,
                {
                  backgroundColor: theme.inputBg,
                  color: theme.textPrimary,
                  borderColor: theme.accent,
                  borderWidth: 1.5,
                  marginBottom: 10,
                  fontSize: 16,
                  fontWeight: '600',
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderRadius: 10,
                },
              ]}
              placeholder="例: 1番席、個室VIP、セット面3"
              placeholderTextColor={theme.textTertiary}
              value={renameSeatLabelInput}
              onChangeText={setRenameSeatLabelInput}
              maxLength={20}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              onSubmitEditing={handleSaveSeatRename}
            />

            {/* 定番の席名クイックチップ */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>よく使う席名（タップで入力）:</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {['1番席', '2番席', '3番席', '4番席', '5番席', 'セット面', '個室', 'VIP席', 'シャンプー台'].map((preset) => (
                  <TouchableOpacity
                    key={preset}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 5,
                      borderRadius: 6,
                      backgroundColor: isEcoMode ? '#2C2C2E' : '#EFF6FF',
                      borderWidth: 1,
                      borderColor: renameSeatLabelInput === preset ? theme.accent : (isEcoMode ? '#3C3C3E' : '#BFDBFE'),
                    }}
                    onPress={() => setRenameSeatLabelInput(preset)}
                  >
                    <Text style={{ fontSize: 11.5, color: renameSeatLabelInput === preset ? theme.accent : theme.textPrimary, fontWeight: renameSeatLabelInput === preset ? '700' : '500' }}>
                      {preset}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                style={[styles.proxyCancelBtn, { flex: 1, backgroundColor: isEcoMode ? '#2C2C2E' : '#E5E5EA' }]}
                onPress={() => setIsRenameSeatModalVisible(false)}
              >
                <Text style={[styles.proxyCancelBtnText, { color: theme.textPrimary }]}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButtonPrimary, { flex: 1, backgroundColor: theme.accent, marginTop: 0 }]}
                onPress={handleSaveSeatRename}
              >
                <Text style={styles.modalButtonPrimaryText}>変更を保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  headerContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitleButton: {
    flex: 1,
    marginRight: 8,
  },
  salonTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },
  salonTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  subInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginRight: 6,
  },
  subInfoText: {
    fontSize: 11,
    marginRight: 6,
  },
  proBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 4,
  },
  proBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#000000',
  },
  freeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 4,
    borderWidth: 1,
  },
  freeBadgeText: {
    fontSize: 9,
    fontWeight: '600',
  },
  addSeatHeaderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
  },
  addSeatHeaderText: {
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 2,
  },
  // メインタイマー連動ウィジェット
  mainTimerWidget: {
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'column', // 縦2段構成で文字重なりを完全排除
  },
  mainTimerHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  mainTimerBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  mainTimerLabel: {
    fontSize: 12,
    fontWeight: '700',
    marginRight: 6,
  },
  mainTimerGenrePill: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  mainTimerGenreText: {
    fontSize: 10,
    fontWeight: '600',
  },
  mainTimerControlsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 2,
  },
  mainTimerDigitsTouchable: {
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 8,
  },
  mainTimerDigits: {
    fontSize: 28,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
  },
  mainTimerRightActions: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  mainTimerBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    flexDirection: 'row',
    gap: 3,
  },
  mainTimerBtnText: {
    fontSize: 11,
    fontWeight: '700',
  },
  mainTimerAssignBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 2,
  },
  mainTimerAssignBtnText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  // フィルタバー
  filterBarContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  filterPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  filterPillActive: {},
  filterPillText: {
    fontSize: 12,
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
    paddingBottom: 40,
  },
  // 待機中（最小化スリムバー）
  idleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
  },
  idleRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  idleSeatBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginRight: 10,
  },
  idleSeatBadgeText: {
    fontSize: 13,
    fontWeight: '700',
  },
  idleStatusText: {
    fontSize: 12,
    fontWeight: '500',
  },
  idleActionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  idleActionText: {
    fontSize: 12,
    fontWeight: '700',
  },
  // 稼働中フルカード
  card: {
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 5,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  cardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  seatLabelContainer: {
    backgroundColor: 'rgba(128, 128, 128, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  seatLabelText: {
    fontSize: 14,
    fontWeight: '700',
  },
  // ★ ユーザー指定: 1番席の右にタイマー作成者を表示するバッジ
  headerCreatorBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  headerCreatorText: {
    fontSize: 12,
    fontWeight: '600',
  },
  shampooButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  shampooButtonText: {
    fontSize: 11,
    fontWeight: '700',
  },
  timerDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 4,
  },
  // ★ ユーザー指定: 全体タイマー用サブカード（ブルーのカード）
  mainTimerSubCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1.2,
    marginTop: 4,
    marginBottom: 4,
  },
  headerStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3.5,
    borderRadius: 8,
    borderWidth: 1,
  },
  timerDigitsTouchable: {
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 8,
  },
  timerDigits: {
    fontSize: 32,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
  },
  timerStatusBadge: {
    fontSize: 11,
    fontWeight: '600',
  },
  // ★ ユーザー指定: チェックタイマー用カードスタイル（上下2段）
  checkTimerSubCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1.2,
    marginTop: 6,
    marginBottom: 4,
  },
  checkTimerSubLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  checkTimerSubRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  checkStaffButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4.5,
    borderRadius: 8,
    borderWidth: 1,
  },
  checkStaffButtonText: {
    fontSize: 11,
    fontWeight: '700',
  },
  checkStaffChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  checkTimerSubLabel: {
    fontSize: 11,
    fontWeight: '700',
  },
  checkTimerSubDigits: {
    fontSize: 15,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  checkTimerInitialBadge: {
    borderWidth: 1,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 6,
  },
  checkTimerCompleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  checkTimerCompleteBtnText: {
    fontSize: 11,
    fontWeight: '700',
  },
  pausedCheckPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 6,
  },
  staffRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128, 128, 128, 0.15)',
  },
  staffItem: {
    flex: 1,
  },
  staffRoleLabel: {
    fontSize: 10,
    marginBottom: 2,
  },
  staffNameText: {
    fontSize: 12,
    fontWeight: '600',
  },
  takeAssistantButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 2,
  },
  takeAssistantText: {
    fontSize: 11,
    fontWeight: '700',
  },
  commentContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 7,
    borderRadius: 8,
    marginTop: 8,
  },
  commentText: {
    fontSize: 11,
    flex: 1,
  },
  cardActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 3,
  },
  actionBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
  actionDivider: {
    width: StyleSheet.hairlineWidth,
    height: 12,
  },
  bottomAddSeatBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    marginTop: 8,
    marginBottom: 20,
  },
  bottomAddSeatText: {
    fontSize: 13,
    fontWeight: '700',
  },
  // モーダル
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    marginHorizontal: 16,
    marginBottom: 20,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalInput: {
    height: 42,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  modalButtonPrimary: {
    height: 44,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalButtonPrimaryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  modalCard: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  modalHeaderLeftGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
    flexWrap: 'wrap',
  },
  modalSeatLabelPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1.2,
    maxWidth: 160,
  },
  modalSeatLabelPillText: {
    fontSize: 15,
    fontWeight: '700',
  },
  modalSeatLabelEditHint: {
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 4,
    opacity: 0.8,
  },
  modalTitleSuffix: {
    fontSize: 16,
    fontWeight: '700',
    marginLeft: 4,
  },
  modalSeatLabelInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  modalSeatLabelInput: {
    flex: 1,
    height: 38,
    borderWidth: 1.5,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 14,
    fontWeight: '600',
  },
  modalSeatLabelSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: 38,
    borderRadius: 8,
    marginLeft: 6,
  },
  modalSeatLabelSaveBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  sheetSectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
  },
  salonSelectItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
  },
  salonSelectLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  salonSelectName: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  salonSelectDesc: {
    fontSize: 11,
  },
  switcherActionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  switcherActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  switcherActionBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 10,
  },
  textInput: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    borderWidth: 1,
  },
  timeSettingHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
    marginBottom: 6,
  },
  timeCurrentBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  timeCurrentBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  customTimeInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  customTimeNumberInput: {
    width: 48,
    height: 32,
    borderRadius: 8,
    borderWidth: 1.5,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '800',
    paddingVertical: 2,
    paddingHorizontal: 2,
  },
  customTimeUnitText: {
    fontSize: 13,
    fontWeight: '700',
    marginLeft: 4,
  },
  // ★ ユーザー指定: モーダル内チェックタイマー設定スタイル
  checkSettingSection: {
    marginTop: 10,
    marginBottom: 6,
    borderRadius: 12,
    borderWidth: 1,
    padding: 10,
  },
  checkSettingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  checkSettingTitle: {
    fontSize: 12,
  },
  checkCurrentBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  checkCurrentBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  checkChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  checkChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkChipText: {
    fontSize: 12,
  },
  checkAdjustBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkAdjustBtnText: {
    fontSize: 11,
    fontWeight: '700',
  },
  favPanelContainer: {
    marginTop: 10,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
    padding: 10,
  },
  favPanelHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  favPanelTitle: {
    fontSize: 12,
    fontWeight: '700',
  },
  favAddQuickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  favAddQuickBtnText: {
    fontSize: 11,
    fontWeight: '700',
    marginLeft: 2,
  },
  favInlineAddForm: {
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
  },
  favInlineAddTitle: {
    fontSize: 11,
    fontWeight: '600',
  },
  favInlineInput: {
    flex: 1,
    height: 32,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    fontSize: 12,
  },
  favInlineSubmitBtn: {
    paddingHorizontal: 12,
    height: 32,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  favInlineSubmitBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  favInlineCancelBtn: {
    paddingHorizontal: 10,
    height: 32,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
  },
  favInlineCancelBtnText: {
    fontSize: 12,
  },
  favChipsScroll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
  },
  favChipWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    paddingLeft: 8,
    paddingRight: 4,
    paddingVertical: 5,
  },
  favChipPressable: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 2,
  },
  favChipMinutes: {
    fontSize: 12,
    fontWeight: '800',
    marginRight: 4,
  },
  favChipLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginRight: 4,
    maxWidth: 80,
  },
  favChipDeleteBtn: {
    padding: 2,
    marginLeft: 2,
  },
  timePillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 4,
  },
  timePill: {
    minWidth: '22%',
    flexGrow: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
  },
  timePillText: {
    fontSize: 13,
    fontWeight: '700',
  },
  timeAdjustBar: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 6,
    marginBottom: 4,
  },
  timeAdjustBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
  },
  timeAdjustBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  submitButton: {
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 10,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  assignWithoutSeatCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    marginBottom: 8,
  },
  assignWithoutSeatLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  assignWithoutSeatTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  assignWithoutSeatDesc: {
    fontSize: 11,
  },
  assignDividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 10,
  },
  assignDividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  assignDividerText: {
    fontSize: 11,
    fontWeight: '600',
    marginHorizontal: 8,
  },
  assignSeatItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
  },
  assignSeatName: {
    fontSize: 14,
    fontWeight: '700',
  },
  assignSeatBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  assignSeatBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  proModalContent: {
    paddingVertical: 12,
  },
  proModalText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 8,
  },
  proModalSubText: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  // 安全確認シグナル ＆ アクションスタイル
  safetyStatusBox: {
    borderWidth: 1.5,
    borderRadius: 10,
    padding: 8,
    marginVertical: 6,
  },
  safetyStatusHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  safetyStatusTitle: {
    fontSize: 12,
    fontWeight: '700',
  },
  safetyStatusRoles: {
    flexDirection: 'row',
    gap: 8,
  },
  safetyRoleText: {
    fontSize: 11,
    fontWeight: '700',
  },
  safetyActionRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  safetyConfirmBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    borderRadius: 8,
  },
  safetyConfirmBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  safetyConfirmedPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  safetyConfirmedPillText: {
    fontSize: 11,
    fontWeight: '700',
  },
  safetySosBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  safetySosBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  safetySosPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  safetySosPillText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  // 時間変更 ＆ タイマー停止確認モーダルスタイル
  actionModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  actionModalCard: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 22,
    padding: 22,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 10,
  },
  actionModalTitle: {
    fontSize: 19,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  actionModalMessage: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 20,
  },
  actionModalTopButtonsRow: {
    flexDirection: 'row',
    width: '100%',
    gap: 10,
    marginBottom: 12,
  },
  actionModalCancelBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionModalCancelBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
  actionModalChangeBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionModalChangeBtnText: {
    fontSize: 15,
    fontWeight: '700',
  },
  actionModalStopBtn: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  actionModalStopBtnText: {
    fontSize: 15,
    fontWeight: '700',
  },
  // ★ クイックタイム変更モーダル用スタイル
  quickTimePreviewBox: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    marginTop: 10,
  },
  quickTimePreviewCol: {
    alignItems: 'center',
    flex: 1,
  },
  quickTimePreviewSubLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
  quickTimePreviewDigits: {
    fontSize: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  quickTimeDeltaBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    marginTop: 3,
  },
  quickTimeDeltaText: {
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  quickTimeSectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  quickTimeButtonRow: {
    width: '100%',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'space-between',
  },
  quickTimeAddPill: {
    flex: 1,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 2,
    borderRadius: 10,
    borderWidth: 1.2,
  },
  quickTimeAddPillText: {
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  quickTimeAdjustRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  quickTimeStepBtn: {
    flex: 1,
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 10,
    borderWidth: 1,
  },
  quickTimeStepBtnText: {
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  quickTimeResetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  actionModalStatusPillsSection: {
    width: '100%',
    marginTop: 10,
    marginBottom: 4,
  },
  actionModalStatusPillsTitle: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 6,
    textAlign: 'center',
  },
  actionModalStatusPillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 6,
  },
  actionModalStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  actionModalStatusPillText: {
    fontSize: 11,
    fontWeight: '700',
  },
  actionModalNote: {
    fontSize: 11,
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 15,
  },
  actionModalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    marginBottom: 8,
  },
  pausedActionButtonsCol: {
    width: '100%',
    gap: 12,
    marginTop: 4,
    marginBottom: 4,
  },
  pausedActionCardBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 16,
    borderWidth: 1.5,
  },
  pausedActionIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  pausedActionTextCol: {
    flex: 1,
  },
  pausedActionBtnTitle: {
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 2,
  },
  pausedActionBtnSub: {
    fontSize: 12,
  },
  // ヘルプ担当指定・変更スタイル
  staffRoleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  changeHelpChip: {
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  changeHelpChipText: {
    fontSize: 10,
    fontWeight: '700',
  },
  assistantAssignedBox: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  helpAssignModalCard: {
    width: '100%',
    maxWidth: 360,
    maxHeight: '88%',
    borderRadius: 24,
    padding: 20,
    paddingBottom: 14,
    alignItems: 'stretch',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 10,
  },
  helpAssignHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128, 128, 128, 0.25)',
    paddingBottom: 10,
  },
  helpAssignTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 4,
  },
  helpAssignSubtitle: {
    fontSize: 12,
  },
  selfTakeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    marginBottom: 14,
  },
  selfTakeBtnTitle: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  selfTakeBtnSub: {
    fontSize: 11,
  },
  helpSectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 8,
    marginTop: 4,
  },
  staffChipsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  staffChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
  },
  staffChipText: {
    fontSize: 12,
  },
  helpInputRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  helpTextInput: {
    flex: 1,
    height: 42,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 13,
  },
  helpSubmitBtn: {
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
  },
  helpSubmitBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  helpClearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 12,
  },
  helpClearBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
  notificationNoteBox: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 10,
    marginTop: 4,
    marginBottom: 6,
  },
  notificationNoteText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
  },
  // 表示名（ニックネーム）設定カードスタイル
  userNameCard: {
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    marginBottom: 14,
  },
  userNameDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  userNameLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  userNameSectionLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  userNameValue: {
    fontSize: 16,
    fontWeight: '700',
  },
  userNameHintSmall: {
    fontSize: 10,
    marginLeft: 6,
  },
  userNameEditBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
  },
  userNameEditBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  userNameEditBox: {
    paddingVertical: 2,
  },
  userNameEditHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  userNameWatchHint: {
    fontSize: 11,
    fontWeight: '700',
  },
  userNameInputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  userNameTextInput: {
    flex: 1,
    height: 40,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    fontWeight: '600',
  },
  userNameSaveBtn: {
    paddingHorizontal: 14,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
  },
  userNameSaveBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  userNameCancelBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
  },
  userNameCancelBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  userNameCharCount: {
    fontSize: 10,
    marginTop: 6,
    textAlign: 'right',
  },
  // アコーディオン停止スリムバー
  pausedRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1.5,
    marginBottom: 8,
  },
  pausedRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pausedSeatBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  pausedSeatBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  pausedTimeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  pausedTimeText: {
    fontSize: 15,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  pausedRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pausedStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  pausedStatusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  pausedStatusAddBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  pausedStatusAddText: {
    fontSize: 10,
    fontWeight: '600',
  },
  pausedStaffText: {
    fontSize: 11,
    fontWeight: '600',
    maxWidth: 70,
  },
  // カードヘッダー右側＆ステータスボタン
  cardHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionStatusButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  actionStatusButtonText: {
    fontSize: 11,
    fontWeight: '700',
  },
  collapseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  collapseBtnText: {
    fontSize: 10,
    fontWeight: '600',
  },
  // 施術工程・ステータス選択モーダル
  statusModalCard: {
    width: '90%',
    maxWidth: 420,
    borderRadius: 20,
    padding: 18,
    alignItems: 'center',
  },
  statusModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    width: '100%',
    marginBottom: 14,
  },
  statusModalTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  statusModalSubtitle: {
    fontSize: 12,
    marginTop: 3,
  },
  statusOptionsList: {
    gap: 8,
    paddingBottom: 6,
  },
  statusOptionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: 12,
  },
  statusOptionLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
    marginRight: 8,
  },
  statusOptionIconBox: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statusOptionLabel: {
    fontSize: 14,
  },
  currentSelectedBadge: {
    marginLeft: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  currentSelectedBadgeText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '700',
  },
  statusOptionDesc: {
    fontSize: 11,
    marginTop: 2,
  },
  statusClearItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    marginTop: 6,
  },
  statusClearText: {
    fontSize: 12,
    fontWeight: '600',
  },
  // ヘルプ担当ボタン（カード右上）
  helpHeaderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4.5,
    borderRadius: 8,
    borderWidth: 1,
  },
  helpHeaderButtonText: {
    fontSize: 11,
  },
  // 停止中スリムバーのヘルプバッジ
  pausedHelpBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  pausedHelpBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  // クイックスタッフ選択チップ
  quickStaffChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  quickStaffChipText: {
    fontSize: 11,
    fontWeight: '600',
  },
  // 希望ヘルプ選択グリッド ＆ スタッフ展開エリア
  helpActionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    marginTop: 4,
  },
  helpActionChipsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  helpActionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 10,
  },
  helpActionChipText: {
    fontSize: 12,
  },
  assignStaffSection: {
    marginTop: 4,
  },
  selectedActionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    marginBottom: 8,
  },
  selectedActionBannerTitle: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  selectedActionBannerSub: {
    fontSize: 11,
  },
  helpSelectPromptBox: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    marginTop: 8,
  },
  helpSelectPromptText: {
    fontSize: 12,
    lineHeight: 18,
    flex: 1,
  },
  // 第三者・代理確認モーダルスタイル
  proxyConfirmModalCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 24,
    padding: 20,
    alignItems: 'stretch',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 10,
  },
  proxyConfirmHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128, 128, 128, 0.25)',
  },
  proxyIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
  },
  proxyConfirmTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  proxyConfirmSubtitle: {
    fontSize: 12,
    marginTop: 1,
  },
  proxyStatusCard: {
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 12,
  },
  proxyStatusCardLabel: {
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  proxyStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  proxyStaffName: {
    fontSize: 13,
    fontWeight: '600',
  },
  proxyStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  proxyExplanationText: {
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 14,
    textAlign: 'center',
  },
  proxyActionButtonsContainer: {
    gap: 8,
    marginBottom: 14,
  },
  proxyConfirmOptionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  proxyConfirmOptionTitle: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  proxyConfirmOptionSub: {
    fontSize: 11,
  },
  proxyCancelBtn: {
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  proxyCancelBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  // 初期設定時間ピル（何分で測ったのか一目でわかる表示）
  initialTimePill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2.5,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 4,
  },
  initialTimePillText: {
    fontSize: 11,
    fontWeight: '600',
  },
  // 施術履歴（タイムライン）スタイル
  historyContainer: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    marginBottom: 12,
  },
  historyHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128, 128, 128, 0.2)',
  },
  historyHeaderTitle: {
    fontSize: 12,
    fontWeight: '700',
  },
  addHistoryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  addHistoryBtnText: {
    fontSize: 11,
    fontWeight: '600',
  },
  historyTimelineList: {
    paddingLeft: 4,
  },
  historyItemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minHeight: 24,
  },
  timelineIndicatorColumn: {
    width: 16,
    alignItems: 'center',
    paddingTop: 3,
  },
  timelineDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    zIndex: 2,
  },
  timelineLine: {
    width: 1.5,
    flex: 1,
    minHeight: 16,
    marginTop: -1,
  },
  historyItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingLeft: 6,
    paddingBottom: 6,
  },
  historyItemTime: {
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    marginRight: 8,
    width: 36,
  },
  historyItemText: {
    fontSize: 12,
    flex: 1,
  },
  // 施術履歴追加モーダル
  addHistoryModalCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 24,
    padding: 20,
    alignItems: 'stretch',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 10,
  },
  quickHistoryChipsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  quickHistoryChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  quickHistoryChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  // 招待コード関連スタイル
  inviteCodeTriggerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  inviteCodeTriggerBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  codeModalHintText: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 14,
  },
  codeModalInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  codeModalTextInput: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    borderWidth: 1.5,
    paddingHorizontal: 12,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 2,
    textAlign: 'center',
  },
  codeRandomBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
  },
  codeRandomBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
  codeShareFullBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 10,
  },
  codeShareFullBtnText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
