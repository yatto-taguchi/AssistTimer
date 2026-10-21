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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import WatchConnectivity from 'watch-connectivity';
import { AppContext } from '../utils/AppContext';
import WatchDiagnosticsBar from '../components/WatchDiagnosticsBar';
import { setAlarms, stopAlarm, subscribeUserStoppedAlarms } from '../utils/alarmScheduler';

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
  return SALON_ACTION_STATUS_OPTIONS.find((opt) => opt.id === actualId) || null;
};

// ランダムな6桁（3桁-3桁）の安全な招待コード生成関数（例: 738-921）
export const generateRandomInviteCode = () => {
  const part1 = Math.floor(100 + Math.random() * 900); // 100〜999
  const part2 = Math.floor(100 + Math.random() * 900); // 100〜999
  return `${part1}-${part2}`;
};

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

// デフォルトの初期座席マスター（メインタイマー連動＋1番席サンプルのみ）
export const getDefaultInitialSeats = (staffName = 'スタイリスト') => [
  {
    id: 'seat-1',
    seatLabel: '1番席 (サンプル)',
    status: 'running',
    colorStaffName: staffName,
    assistantStaffName: '',
    actionStatus: null,
    isShampooing: false,
    targetSeconds: 1200,
    initialMinutes: 20,
    targetEndTimestamp: Date.now() + 19 * 60 * 1000 + 54 * 1000, // 残り19分54秒
    checkTargetSeconds: 600, // 10分チェック
    checkInitialMinutes: 10,
    checkEndTimestamp: Date.now() + 9 * 60 * 1000 + 54 * 1000, // チェックまで残り9分54秒
    checkStatus: 'running',
    checkStaffName: '',
    comment: 'サンプルタイマー (タップして操作・編集できます)',
    timeUpTimestamp: null,
    mainStaffConfirmed: true,
    assistantStaffConfirmed: false,
    sosTriggered: false,
    escalationLevel: 0,
    history: [
      { id: 'h-1-1', time: '18:49', text: '20分放置 (チェック: 10分)', type: 'timer' },
    ],
  },
];

// ★ スタッフメンバーの正規化ヘルパー（一意のID管理・相手ニックネーム・任意設定の呼び名を両立）
export const normalizeStaffMembers = (list) => {
  if (!Array.isArray(list)) return [];
  return list.map((m, idx) => {
    if (!m) return null;
    if (typeof m === 'string') {
      return {
        id: `mem_legacy_${idx}_${m}`,
        originalNickname: m,
        customNickname: m,
        joinedAt: Date.now(),
      };
    }
    return {
      id: m.id || `mem_${Date.now()}_${idx}`,
      originalNickname: m.originalNickname || m.name || m.nickname || 'スタッフ',
      customNickname: m.customNickname || m.originalNickname || m.name || m.nickname || 'スタッフ',
      inviteCode: m.inviteCode || '',
      joinedAt: m.joinedAt || Date.now(),
    };
  }).filter(Boolean);
};

export const getMemberDisplayName = (m) => {
  if (!m) return '';
  if (typeof m === 'string') return m;
  return m.customNickname || m.originalNickname || m.name || 'スタッフ';
};

// キャッシュされた最新スタッフメンバー・座席・ユーザー名・メインタイマー一覧
let _cachedStaffMembers = [];
let _cachedCurrentSeats = [];
let _cachedUserName = 'スタイリスト';
let _cachedMainTimerState = null;
let _syncDebounceTimer = null;
let _pendingWatchPayload = null;
// Watch 側アラーム音の設定（設定画面の値を SYNC_SEATS に含めて Watch へ届ける）
let _watchAlarmSound = false;

export const updateCachedMainTimerState = (state) => {
  _cachedMainTimerState = state;
};

// ★ Apple Watchへのメインタイマー専用同期ヘルパー（客席seatsを絶対に含めず、各タイマーの完全独立を保証）
export const syncMainTimerToWatch = async (mainState = null, options = {}) => {
  if (Platform.OS !== 'ios') return;
  try {
    const state = mainState || _cachedMainTimerState;
    if (!state) return;

    const isRunning = !!state.isRunning;
    const isCountUp = !!state.isCountUp;
    const targetEnd = state.targetEndTimestamp || (
      isRunning 
        ? (isCountUp ? Date.now() - (state.remainingTime || 0) * 1000 : Date.now() + (state.remainingTime || 0) * 1000)
        : 0
    );
    
    const pausedRem = !isRunning
      ? (isCountUp ? -Math.max(0, state.remainingTime || 0) : (state.remainingTime != null ? state.remainingTime : (state.targetTime || 600)))
      : Math.max(0, Math.floor((targetEnd - Date.now()) / 1000));

    const mainTimerPayload = {
      id: 'main-timer',
      seatNumber: 0,
      seatLabel: 'メインタイマー',
      isMainTimer: true,
      creatorName: (_cachedUserName || 'スタイリスト').trim(),
      totalSeconds: state.targetTime || 600,
      targetEndTimestamp: targetEnd,
      isRunning: isRunning,
      pausedRemainingSeconds: pausedRem,
      isCountUp: isCountUp,
      genre: state.genre || '',
      isPreCountingDown: !!state.isPreCountingDown,
      preCountdownSeconds: state.preCountdownSeconds || 0,
      isCountdownConfigEnabled: !!state.isCountdownConfigEnabled,
      countdownConfigSeconds: state.countdownConfigSeconds || 5,
      prepEndTimestamp: state.prepEndTimestamp || 0,
    };

    // ★ seats キーは絶対に含めない。Watch 側の timers 配列に1ミリも触れさせない！
    const watchPayload = {
      type: 'SYNC_MAIN_TIMER',
      timestamp: Date.now(),
      mainTimer: mainTimerPayload,
    };

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
    if (Array.isArray(currentSeats) && currentSeats.length > 0) {
      _cachedCurrentSeats = currentSeats;
      validSeats = currentSeats;
    } else if (Array.isArray(_cachedCurrentSeats) && _cachedCurrentSeats.length > 0) {
      validSeats = _cachedCurrentSeats;
    } else if (currentSeats !== null && Array.isArray(currentSeats)) {
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
      const isRunning = !!_cachedMainTimerState.isRunning;
      const isCountUp = !!_cachedMainTimerState.isCountUp;
      const targetEnd = _cachedMainTimerState.targetEndTimestamp || (
        isRunning 
          ? (isCountUp ? Date.now() - (_cachedMainTimerState.remainingTime || 0) * 1000 : Date.now() + (_cachedMainTimerState.remainingTime || 0) * 1000)
          : 0
      );
      
      const pausedRem = !isRunning
        ? (isCountUp ? -Math.max(0, _cachedMainTimerState.remainingTime || 0) : (_cachedMainTimerState.remainingTime != null ? _cachedMainTimerState.remainingTime : (_cachedMainTimerState.targetTime || 600)))
        : Math.max(0, Math.floor((targetEnd - Date.now()) / 1000));

      mainTimerPayload = {
        id: 'main-timer',
        seatNumber: 0,
        seatLabel: 'メインタイマー',
        isMainTimer: true,
        creatorName: (currentName || 'スタイリスト').trim(),
        totalSeconds: _cachedMainTimerState.targetTime || 600,
        targetEndTimestamp: targetEnd,
        isRunning: isRunning,
        pausedRemainingSeconds: pausedRem,
        isCountUp: isCountUp,
        genre: _cachedMainTimerState.genre || '',
      };
    }

    const flatMembers = Array.isArray(finalMembers)
      ? finalMembers.map((m) => (typeof m === 'string' ? m : (m.customNickname || m.originalNickname || m.name || 'スタッフ')))
      : [];

    const watchPayload = {
      type: 'SYNC_SEATS',
      userName: (currentName || 'スタイリスト').trim(),
      members: flatMembers,
      watchAlarmSound: _watchAlarmSound,
      timestamp: Date.now(),
      mainTimer: mainTimerPayload,
    };

    // ★ 相手へのリアルタイム通知（タイマー停止、チェック完了、アラーム停止等）
    if (options.notification && typeof options.notification === 'object') {
      watchPayload.notification = {
        text: String(options.notification.text || ''),
        color: String(options.notification.color || '#30D158'),
        sourceUser: String(options.notification.sourceUser || currentName || 'スタイリスト').trim(),
      };
    }

    // ★ 客席データが有効な場合のみ seats を追加。未指定（null）の時は seats を含めず客席タイマーを保護
    if (validSeats !== null) {
      watchPayload.seats = validSeats.map((s, index) => {
        let seatNum = index + 1;
        if (s.seatLabel) {
          const match = s.seatLabel.match(/\d+/);
          if (match) seatNum = parseInt(match[0], 10);
        }

        const isRunning = s.status === 'running';
        const targetEnd = s.targetEndTimestamp || Date.now();
        // ★ 停止中は保存済みの残り秒数を送る（終了時刻から計算すると、止めた後も Watch 側で残りが減っていった）
        const pausedRem = !isRunning && typeof s.pausedRemainingSeconds === 'number'
          ? Math.max(0, Math.floor(s.pausedRemainingSeconds))
          : Math.max(0, Math.floor((targetEnd - Date.now()) / 1000));

        const isZero = !isRunning && pausedRem <= 0;
        const isCollapsedSeat = !isRunning && !s.isReset && s.collapsedAtEnd != null
          && Number(s.collapsedAtEnd) === Number(s.targetEndTimestamp || 0);
        const isNoHelp = !isZero && !isCollapsedSeat && (s.assistantStaffName === 'ヘルプなし' || s.assistantStaffName === 'none');

        return {
          id: String(s.id),
          seatNumber: seatNum,
          seatLabel: s.seatLabel || `${seatNum}番席`,
          creatorName: s.colorStaffName || 'スタイリスト',
          totalSeconds: s.targetSeconds || 600,
          targetEndTimestamp: targetEnd,
          isRunning: isRunning,
          pausedRemainingSeconds: pausedRem,
          helpProcess: (isZero || isCollapsedSeat) ? '' : (s.actionStatus === 'shampoo' || s.isShampooing ? 'シャンプー' : (s.actionStatus || 'シャンプー')),
          shampooStaff: (isNoHelp || isZero || isCollapsedSeat) ? '' : (s.assistantStaffName || ''),
          isRecruiting: !isNoHelp && !isZero && !isCollapsedSeat && !s.assistantStaffName && isRunning,
          isNoHelpNeeded: isNoHelp,
          status: (isZero || isCollapsedSeat) ? 'normal' : (s.isShampooing || s.actionStatus === 'shampoo' ? 'shampoo' : (s.actionStatus || 'normal')),
          checkTargetSeconds: s.checkTargetSeconds ? Number(s.checkTargetSeconds) : 0,
          checkEndTimestamp: s.checkEndTimestamp ? Number(s.checkEndTimestamp) : 0,
          checkStaffName: s.checkStaffName || '',
          isCheckCompleted: s.checkStatus === 'completed',
          // ★ Watch の「計測終了」で収納したカード。その時の終了時刻のまま停止している間だけ収納を保つ
          //   （以前は常に false を送っていたため、次の同期でカードが開いてしまっていた）
          isCollapsed: isCollapsedSeat,
        };
      });
    }

    if (options.immediate || options.notification) {
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
  const [currentSalon, setCurrentSalon] = useState(DEFAULT_FREE_SALON);
  const [savedSalons, setSavedSalons] = useState([DEFAULT_FREE_SALON]);
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

  // 現在時刻HH:MMフォーマットヘルパー
  const getCurrentTimeFormatted = () => {
    const d = new Date();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  };

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

    // スタッフが決まっている場合
    if (staff && staff !== '') {
      if (actionLabel && actionLabel !== 'チェック') {
        return `${actionLabel} ${staff} ▾`;
      }
      return `${staff} ▾`;
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
  const [modalColorStaff, setModalColorStaff] = useState('');
  const [modalAssistantStaff, setModalAssistantStaff] = useState('');
  const [modalComment, setModalComment] = useState('');
  const [isEditingExistingTimer, setIsEditingExistingTimer] = useState(false); // 時間変更モードか否か
  const [timerSetupMode, setTimerSetupMode] = useState('default'); // 'default' | 'new' (新しく測る) | 'additional' (追加タイム)
  // ★ ユーザー指定: タイム設定モーダルでの席名変更ステート
  const [isEditingSeatLabel, setIsEditingSeatLabel] = useState(false);

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

  // ★ Apple Watch と連動中か（ペアリング済み＋Watchアプリ導入済み）
  const [watchLinked, setWatchLinked] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    const apply = (st) => {
      if (st && typeof st === 'object' && !st.error) {
        setWatchLinked(!!(st.isPaired && st.isWatchAppInstalled));
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

  // 500msごとの時計同期 & タイムアップ監視 & エスカレーションチェック
  useEffect(() => {
    const timer = setInterval(() => {
      const currentNow = Date.now();
      setNow(currentNow);

      // タイムアップ席の監視 & エスカレーション通知（強い振動・3分サロン全員アラート）
      setSeats((prevSeats) => {
        let hasChanges = false;
        const updated = prevSeats.map((s) => {
          if (s.status !== 'running') return s;

          const isOver = currentNow >= s.targetEndTimestamp;
          const remainingSec = Math.floor((s.targetEndTimestamp - currentNow) / 1000);

          // ★ ユーザー指定: 1分前でもヘルプ担当が決まっていなければ全員にアラートを出す（ヘルプなしを除く）
          const isNoHelp = s.assistantStaffName === 'ヘルプなし' || s.assistantStaffName === 'none';
          const isHelpUndecided = !s.assistantStaffName || s.assistantStaffName.trim() === '';

          if (!isOver && remainingSec <= 60 && remainingSec > 0 && isHelpUndecided && !isNoHelp) {
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
                    onPress: () => handleAssignAssistantDirectly(s.id, userName || '自分'),
                  },
                  {
                    text: '確認',
                    style: 'cancel',
                  },
                ]
              );
            }
          }

          // ★ ユーザー指定: チェックタイマー（途中の発色・薬剤確認）の監視
          let checkStatusChanged = false;
          let newCheckStatus = s.checkStatus;
          if (s.checkTargetSeconds > 0 && s.checkStatus === 'running' && s.checkEndTimestamp) {
            if (currentNow >= s.checkEndTimestamp) {
              newCheckStatus = 'timeup';
              checkStatusChanged = true;
              hasChanges = true;
              if (checkAlertedRef.current[s.id] !== s.checkEndTimestamp) {
                checkAlertedRef.current[s.id] = s.checkEndTimestamp;
                if (Platform.OS !== 'web' && phoneAlarmAllowedRef.current) {
                  Vibration.vibrate([0, 500, 150, 500]);
                }
                const chkMins = s.checkInitialMinutes || Math.round(s.checkTargetSeconds / 60);
                Alert.alert(
                  '🔍【チェック時間です】',
                  `「${s.seatLabel}」のチェック時間（${chkMins}分）になりました！\n発色や薬剤の反応を確認してください。\n\n（※全体放置タイマーは計測を継続しています）`,
                  [
                    {
                      text: '✓ チェック完了',
                      onPress: () => handleCompleteCheck(s.id),
                    },
                    {
                      text: '後で確認',
                      style: 'cancel',
                    },
                  ]
                );
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
            // 初回タイムアップ時の強い振動
            if (Platform.OS !== 'web' && phoneAlarmAllowedRef.current) {
              Vibration.vibrate([0, 500, 200, 500, 200, 500]);
            }
            if (mainTimeupAlertedRef.current[s.id] !== s.targetEndTimestamp) {
              mainTimeupAlertedRef.current[s.id] = s.targetEndTimestamp;
              playTimeUpSound();
              const mins = s.initialMinutes || Math.round((s.targetSeconds || 600) / 60);
              Alert.alert(
                '⏰【放置タイム終了】',
                `「${s.seatLabel}」の放置タイム（${mins}分）が終了しました！\n確認または次の工程に進んでください。`,
                [{ text: '確認' }]
              );
            }
          }

          const elapsedOverSec = Math.floor((currentNow - timeUpTs) / 1000);

          // ヘルプ確認（またはヘルプなし確認）に達していない場合の段階的エスカレーション
          const isConfirmed = isNoHelp || !s.assistantStaffName || s.assistantStaffConfirmed;

          // ① 30秒リマインド（強い振動）
          if (elapsedOverSec >= 30 && escLevel < 1 && !isConfirmed) {
            escLevel = 1;
            hasChanges = true;
            if (Platform.OS !== 'web' && phoneAlarmAllowedRef.current) {
              Vibration.vibrate([0, 400, 150, 400]);
            }
          }
          // ② 1分リマインド（強い振動）
          else if (elapsedOverSec >= 60 && escLevel < 2 && !isConfirmed) {
            escLevel = 2;
            hasChanges = true;
            if (Platform.OS !== 'web' && phoneAlarmAllowedRef.current) {
              Vibration.vibrate([0, 400, 150, 400, 150, 400]);
            }
          }
          // ③ 3分経過: 確認されない場合、サロン全員にチェックアラート発動！
          else if (elapsedOverSec >= 180 && escLevel < 3 && !isConfirmed) {
            escLevel = 3;
            hasChanges = true;
            if (Platform.OS !== 'web' && phoneAlarmAllowedRef.current) {
              Vibration.vibrate([0, 800, 200, 800, 200, 800]);
            }
            if (!escalatedAlertRef.current[s.id]) {
              escalatedAlertRef.current[s.id] = true;
              Alert.alert(
                '🚨【サロン全員至急チェック】',
                `「${s.seatLabel}」がタイムアップ後3分間確認されていません！\n至急チェックしてください！`,
                [{ text: '確認して対応する' }]
              );
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

        return hasChanges ? updated : prevSeats;
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

  // ストレージ保存ヘルパー
  const saveSeatsToStorage = async (newSeats) => {
    try {
      await AsyncStorage.setItem('@salon_saved_seats', JSON.stringify(newSeats));
      // ★ Apple Watchへ即時同期 (登録メンバーも含めて送信)
      syncSeatsToWatch(newSeats, userName, staffMembers);
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
  const buildStoppedSeat = (s, staff, historyText) => ({
    ...s,
    status: 'paused',
    pausedRemainingSeconds: 0,
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
    checkEndTimestamp: null,
    checkPausedRemainingSeconds: null,
    checkStaffName: '',
    checkStatus: 'stopped',
    collapsedAtEnd: null,
    history: [
      ...(s.history || []),
      {
        id: `h-${Date.now()}`,
        time: getCurrentTimeFormatted(),
        text: historyText,
        type: 'status',
      },
    ],
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
      setSeats((currentSeats) => {
        syncSeatsToWatch(currentSeats, userName, staffMembers, { immediate: true });
        return currentSeats;
      });
      return;
    }

    // （※ メインタイマーのWatch操作はHomeScreenが一元受信・実行するため、二重トグル防止のためここでは処理しない）

    // ② Watch側での新規席追加
    if (action === 'ADD_SEAT') {
      const seatNum = extra?.seatNumber || 1;
      const totalSec = extra?.totalSeconds || 900;
      const rawCheckSec = extra?.checkTotalSeconds && Number(extra.checkTotalSeconds) > 0
        ? Number(extra.checkTotalSeconds)
        : null;
      // ★ 安全ガード: チェック時間は全体タイムより短い場合のみ有効
      const checkSec = (rawCheckSec && rawCheckSec < totalSec) ? rawCheckSec : null;
      const targetEnd = Date.now() + totalSec * 1000;
      const checkEnd = checkSec ? Date.now() + checkSec * 1000 : null;

      const newSeatObj = {
        id: seatId || String(Date.now()),
        seatNumber: seatNum,
        seatLabel: `${seatNum}番席`,
        status: 'running',
        colorStaffName: watchUser || userName || 'スタイリスト',
        targetSeconds: totalSec,
        initialMinutes: Math.round(totalSec / 60),
        targetEndTimestamp: targetEnd,
        pausedRemainingSeconds: null,
        checkTargetSeconds: checkSec,
        checkInitialMinutes: checkSec ? Math.round(checkSec / 60) : null,
        checkEndTimestamp: checkEnd,
        checkPausedRemainingSeconds: null,
        checkStaffName: '',
        checkStatus: checkSec ? 'running' : 'stopped',
        checkAlerted: false,
        actionStatus: null,
        isShampooing: false,
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
        if (prevSeats.some((s) => s.id === newSeatObj.id)) return prevSeats;
        const updated = [...prevSeats, newSeatObj];
        saveSeatsToStorage(updated);
        syncSeatsToWatch(updated, userName, staffMembers);
        return updated;
      });
      return;
    }

    // ★ Watch でアラームを止めた → iPhone 側で鳴っている同じ席のアラームも止める
    // 放置タイム終了のアラーム（kind: 'main'）なら席を停止、チェックアラーム（kind: 'check'）ならチェック完了にする
    if (action === 'STOP_ALARM') {
      if (seatId) {
        const stopKind = String(extra?.kind || message?.kind || '').toLowerCase();
        if (stopKind === 'main') {
          stopAlarm('salon', `${seatId}-main`);
        } else if (stopKind === 'check') {
          stopAlarm('salon', `${seatId}-check`);
        } else {
          // kindが未指定の場合はメインタイマーを誤消火せず、チェックアラームのみ消火する
          stopAlarm('salon', `${seatId}-check`);
        }
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
      // Watch と iPhone の時計・通信のずれを考えて 5 秒まで同じ終了時刻とみなす
      return Math.abs((Number(s.targetEndTimestamp) || 0) - expected) > 5000;
    };

    setSeats((prevSeats) => {
      let hasChanged = false;
      const updated = prevSeats.map((s) => {
        if (s.id !== seatId) return s;
        if (isStaleStop(s)) return s;
        hasChanged = true;

        switch (action) {
          case 'START_SHAMPOO': {
            return {
              ...s,
              isShampooing: true,
              actionStatus: 'shampoo',
              assistantStaffName: watchUser || s.assistantStaffName,
            };
          }
          case 'FINISH_SHAMPOO': {
            return {
              ...s,
              isShampooing: false,
              actionStatus: null,
            };
          }
          case 'UPDATE_STATUS': {
            const nextStatus = extra?.actionStatus;
            const isShampoo = extra?.isShampooing ?? (nextStatus === 'shampoo');
            return {
              ...s,
              isShampooing: isShampoo,
              actionStatus: nextStatus === 'normal' ? null : (nextStatus || null),
            };
          }
          case 'ENTER_HELP': {
            const process = s.helpProcess || s.actionStatus || '';
            const isCheck = process === 'チェック';
            return {
              ...s,
              status: 'paused',
              // 止めた時点の残り秒数を記録（超過中なら 0）
              pausedRemainingSeconds: s.status === 'running' && s.targetEndTimestamp
                ? Math.max(0, Math.floor((s.targetEndTimestamp - Date.now()) / 1000))
                : 0,
              timeUpTimestamp: null,
              escalationLevel: 0,
              collapsedAtEnd: null,
              assistantStaffName: null,
              isShampooing: false,
              actionStatus: null,
              helpProcess: null,
              isRecruiting: false,
              ...(isCheck ? { isCheckCompleted: true, checkStaffName: watchUser || 'スタッフ' } : {}),
            };
          }
          case 'ASSIGN_HELP': {
            const hasCheckStaff = extra?.checkStaffName !== undefined;
            const hasAssistantStaff = extra?.assistantStaffName !== undefined;
            const rawStaff = hasCheckStaff ? extra.checkStaffName : (hasAssistantStaff ? extra.assistantStaffName : watchUser);
            const staff = (rawStaff !== undefined && rawStaff !== null) ? rawStaff : '';
            const process = extra?.helpProcess || 'シャンプー';
            const isCheck = process === 'チェック';
            return {
              ...s,
              isRecruiting: false,
              ...(isCheck
                ? { checkStaffName: staff }
                : {
                    assistantStaffName: staff,
                    actionStatus: process === 'シャンプー' ? 'shampoo' : process,
                    isShampooing: process === 'シャンプー',
                  }),
            };
          }
          case 'RECRUIT_HELP': {
            const process = extra?.helpProcess || s.helpProcess || s.actionStatus;
            const isCheck = process === 'チェック';
            return {
              ...s,
              isRecruiting: true,
              ...(isCheck ? { checkStaffName: '' } : { assistantStaffName: '' }),
            };
          }
          case 'CLAIM_CHECK': {
            return {
              ...s,
              checkStaffName: watchUser || 'チェック担当',
            };
          }
          case 'COMPLETE_CHECK': {
            const prevHist = s.history || [];
            const chkStaff = watchUser || s.checkStaffName || 'スタッフ';
            return {
              ...s,
              checkStatus: 'completed',
              checkStaffName: chkStaff,
              history: [
                ...prevHist,
                {
                  id: `h-${Date.now()}`,
                  time: getCurrentTimeFormatted(),
                  text: `${chkStaff} チェック完了（Apple Watch）`,
                  type: 'check',
                },
              ],
            };
          }
          case 'CANCEL_CHECK': {
            return {
              ...s,
              checkTargetSeconds: null,
              checkEndTimestamp: null,
              checkStaffName: '',
              checkStatus: 'stopped',
            };
          }
          case 'RESET_ZERO': {
            // ★ iPhone 自身のリセットと同じ状態にする。以前は status: 'stopped' にしていたため、
            //   iPhone の席カードが「稼働中」扱いで超過時間を数え続けていた
            return {
              ...s,
              status: 'paused',
              isReset: true,
              targetSeconds: 0,
              initialMinutes: 0,
              targetEndTimestamp: null,
              pausedRemainingSeconds: 0,
              isOver: false,
              timeUpTimestamp: null,
              escalationLevel: 0,
              checkTargetSeconds: null,
              checkEndTimestamp: null,
              checkPausedRemainingSeconds: null,
              checkStaffName: '',
              checkStatus: 'stopped',
              actionStatus: null,
              isShampooing: false,
              assistantStaffName: '',
              stoppedBy: watchUser || userName || 'スタッフ',
              collapsedAtEnd: null,
            };
          }
          case 'STOP_TIMER': {
            return stopSeat(s, 'タイマー停止');
          }
          case 'FINISH_MEASURE': {
            // ★ 以前は未対応だったため、Watch で計測終了しても次の同期で「超過」に戻っていた
            // ★ カードの収納は、この終了時刻のまま停止している間だけ保つ（再スタートで自動的に解除）
            return { ...stopSeat(s, '計測終了'), collapsedAtEnd: s.targetEndTimestamp || 0 };
          }
          case 'STOP_ALARM': {
            // ★ チェック時間のアラーム停止ならチェックを完了にする（全体タイマーは終了前でも反映）
            const stopKind = String(extra?.kind || message?.kind || '').toLowerCase();
            if (stopKind === 'check') {
              if (s.checkStatus === 'completed') {
                hasChanged = false;
                return s;
              }
              const prevHist = s.history || [];
              const chkStaff = watchUser || s.checkStaffName || 'スタッフ';
              return {
                ...s,
                checkStatus: 'completed',
                checkStaffName: chkStaff,
                history: [
                  ...prevHist,
                  {
                    id: `h-${Date.now()}`,
                    time: getCurrentTimeFormatted(),
                    text: `${chkStaff} チェック完了（Apple Watch）`,
                    type: 'check',
                  },
                ],
              };
            }
            // 終了時刻を過ぎて稼働中の席だけ止める（すでに停止・タイム再入力済みなら何もしない）
            if (s.status !== 'running' || !s.targetEndTimestamp || Date.now() < s.targetEndTimestamp) {
              hasChanged = false;
              return s;
            }
            return stopSeat(s, 'アラーム停止');
          }
          case 'START_TIMER': {
            const targetSec = Number(extra?.targetSeconds) || 600;
            const rawCheckSec = extra?.checkTotalSeconds && Number(extra.checkTotalSeconds) > 0
              ? Number(extra.checkTotalSeconds)
              : null;
            // ★ 安全ガード: チェック時間は全体タイムより短い場合のみ有効
            const checkSec = (rawCheckSec && rawCheckSec < targetSec) ? rawCheckSec : null;
            const checkEnd = checkSec ? Date.now() + checkSec * 1000 : null;
            const prevHistory = s.history || [];
            const historyText = checkSec
              ? `Apple Watchからタイマー開始 (${Math.round(targetSec / 60)}分 / チェック${Math.round(checkSec / 60)}分)`
              : `Apple Watchからタイマー開始 (${Math.round(targetSec / 60)}分)`;
            const newHistoryItem = {
              id: `h-${Date.now()}`,
              time: getCurrentTimeFormatted(),
              text: historyText,
              type: 'timer',
              staff: watchUser || userName || 'スタイリスト',
            };

            return {
              ...s,
              status: 'running',
              targetSeconds: targetSec,
              initialMinutes: Math.round(targetSec / 60),
              targetEndTimestamp: Date.now() + targetSec * 1000,
              pausedRemainingSeconds: null,
              colorStaffName: watchUser || s.colorStaffName,
              // ★ Watch から指定された途中チェック（サブタイマー）を反映
              checkTargetSeconds: checkSec,
              checkInitialMinutes: checkSec ? Math.round(checkSec / 60) : null,
              checkEndTimestamp: checkEnd,
              checkPausedRemainingSeconds: null,
              checkStaffName: '',
              checkStatus: checkSec ? 'running' : 'stopped',
              checkAlerted: false,
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
            if (s.status !== 'running') {
              // ★ 停止中は残り時間だけ変えて停止のまま（Watch の表示と同じ。以前は勝手に再開していた）
              const newRemaining = Math.max(0, (s.pausedRemainingSeconds || 0) + secondsToAdd);
              return {
                ...s,
                targetSeconds: Math.max(0, (s.targetSeconds || 0) + secondsToAdd),
                pausedRemainingSeconds: newRemaining,
                // 残りが入ったら「リセット済 (0:00)」表示をやめる
                isReset: newRemaining > 0 ? false : s.isReset,
                collapsedAtEnd: null,
              };
            }
            const currentEnd = s.targetEndTimestamp || Date.now();
            const newEnd = Math.max(Date.now(), currentEnd) + secondsToAdd * 1000;
            return {
              ...s,
              status: 'running',
              targetSeconds: (s.targetSeconds || 0) + secondsToAdd,
              targetEndTimestamp: newEnd,
              collapsedAtEnd: null,
            };
          }
          case 'CLEAR_STAFF': {
            return {
              ...s,
              assistantStaffName: '',
              checkStaffName: '',
              isShampooing: false,
              actionStatus: null,
            };
          }
          default:
            hasChanged = false;
            return s;
        }
      });

      // ★ 何も変わらなければ元の配列を返す（不要な保存・Watch への同期を起こさない）
      if (!hasChanged) return prevSeats;
      saveSeatsToStorage(updated);

      // ★ 誰かが止めた・変更したアクションを関係者のApple Watchへ即時ブロードキャスト通知
      let watchNotif = null;
      const targetS = prevSeats.find((s) => s.id === seatId);
      const seatLabel = targetS?.seatLabel || '席';
      const actor = (watchUser || 'スタッフ').trim();
      switch (action) {
        case 'STOP_TIMER':
          watchNotif = { text: `⏹️ ${actor}が【${seatLabel}】のタイマーを停止しました`, color: '#FF9500', sourceUser: actor };
          break;
        case 'STOP_ALARM':
          if (extra?.kind === 'check') {
            watchNotif = { text: `✅ ${actor}が【${seatLabel}】のチェックを完了しました`, color: '#30D158', sourceUser: actor };
          } else {
            watchNotif = { text: `🔕 ${actor}が【${seatLabel}】のアラームを停止しました`, color: '#FF9500', sourceUser: actor };
          }
          break;
        case 'COMPLETE_CHECK':
          watchNotif = { text: `✅ ${actor}が【${seatLabel}】のチェックを完了しました`, color: '#30D158', sourceUser: actor };
          break;
        case 'FINISH_MEASURE':
          watchNotif = { text: `🏁 ${actor}が【${seatLabel}】の計測を終了しました`, color: '#30D158', sourceUser: actor };
          break;
        case 'ENTER_HELP':
          watchNotif = { text: `🤝 ${actor}が【${seatLabel}】のヘルプ対応を開始しました`, color: '#30D158', sourceUser: actor };
          break;
        case 'START_SHAMPOO':
          watchNotif = { text: `🧴 ${actor}が【${seatLabel}】のシャンプーを開始しました`, color: '#0A84FF', sourceUser: actor };
          break;
        case 'ASSIGN_HELP':
          watchNotif = { text: `👤 【${seatLabel}】にヘルプ担当が指定されました`, color: '#30D158', sourceUser: actor };
          break;
        case 'RECRUIT_HELP':
          watchNotif = { text: `📢 【${seatLabel}】がヘルプを募集中です！`, color: '#FF453A', sourceUser: actor };
          break;
        default:
          break;
      }
      if (watchNotif) {
        syncSeatsToWatch(updated, userName, staffMembers, { immediate: true, notification: watchNotif });
      }

      return updated;
    });
  };

  // ★ iPhone のアラーム画面（AlarmKit）で「停止」が押された → 放置タイム終了のアラームなら席も 0:00 で停止（Q5）
  //   key: "<席ID>-main" / "<席ID>-check"、timestamp: そのアラームの鳴る時刻(ms)
  const handleUserStoppedAlarms = (stopped) => {
    if (!Array.isArray(stopped) || stopped.length === 0) return;
    const mainStops = new Map();
    stopped.forEach((a) => {
      const key = String(a?.key || '');
      if (!key.endsWith('-main')) return; // チェック時間のアラームは音を止めるだけ
      mainStops.set(key.slice(0, -'-main'.length), Number(a.timestamp));
    });
    if (mainStops.size === 0) return;
    setSeats((prevSeats) => {
      let hasChanged = false;
      const staff = userName || 'スタッフ';
      const updated = prevSeats.map((s) => {
        if (!mainStops.has(String(s.id))) return s;
        const alarmTime = mainStops.get(String(s.id));
        // 同じタイマーのアラームだった時だけ止める（その後にタイム再入力・延長していたら何もしない）
        if (s.status !== 'running' || !s.targetEndTimestamp || !Number.isFinite(alarmTime)) return s;
        if (Math.abs(Number(s.targetEndTimestamp) - alarmTime) > 2000) return s;
        hasChanged = true;
        return buildStoppedSeat(s, staff, `${staff} アラーム停止（iPhone）`);
      });
      if (!hasChanged) return prevSeats;
      saveSeatsToStorage(updated);
      syncSeatsToWatch(updated, userName, staffMembers, {
        immediate: true,
        notification: {
          text: `🔕 ${staff}がアラームを停止しました`,
          color: '#FF9500',
          sourceUser: staff,
        },
      });
      return updated;
    });
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

  // ★ seats または staffMembers または mainTimerState が更新された際、Watch へ最新データを同期
  useEffect(() => {
    updateCachedMainTimerState(mainTimerState);
    _watchAlarmSound = !!isWatchAlarmSoundEnabled;
    if (Platform.OS === 'ios') {
      syncSeatsToWatch(seats, userName, staffMembers);
    }
  }, [seats, userName, staffMembers, isWatchAlarmSoundEnabled, mainTimerState]);

  // ★ サロン席の終了時刻を iPhone 純正アラーム（AlarmKit）に予約
  // 画面ロック中・バックグラウンドでも、止めるまで鳴り続ける。
  // 席の停止・リセット・チェック完了で一覧から消えると、鳴っているアラームも止める。
  // Watch 連動中（かつ「Watch連動中もiPhoneで鳴らす」が OFF）は iPhone では鳴らさない。
  useEffect(() => {
    if (Platform.OS !== 'ios' || !isDataLoaded) return;
    const desired = [];
    if (phoneAlarmAllowed && Array.isArray(seats)) {
      seats.forEach((s) => {
        if (!s || !s.id) return;
        const label = s.seatLabel || '席';
        if (s.status === 'running' && s.targetEndTimestamp) {
          desired.push({ key: `${s.id}-main`, timestamp: Number(s.targetEndTimestamp), title: `${label} 放置タイム終了` });
        }
        if (s.checkTargetSeconds > 0 && (s.checkStatus === 'running' || s.checkStatus === 'timeup') && s.checkEndTimestamp) {
          desired.push({ key: `${s.id}-check`, timestamp: Number(s.checkEndTimestamp), title: `${label} チェック時間` });
        }
      });
    }
    setAlarms('salon', desired, { soundOn: isAlarmSoundEnabled, stopPassedOnRemove: true });
  }, [seats, phoneAlarmAllowed, isAlarmSoundEnabled, isDataLoaded]);

  const loadInitialData = async () => {
    try {
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
            // 古いデモコード「FREE-01」があれば自動でランダムな6桁安全コードへアップグレード
            // かつ「マイサロン」「二人通信モード」等があれば「タイマー同期モード (無料)」へ自動更新
            loadedSalons = parsed.map((s) => {
              let updated = { ...s };
              if (updated.inviteCode === 'FREE-01' || !updated.inviteCode) {
                updated.inviteCode = generateRandomInviteCode();
              }
              if (updated.id === 'workspace-free') {
                updated.name = 'タイマー同期モード (無料)';
                updated.description = '2人までタイマー同期無料 (1名利用中 / ペア招待可能)';
              }
              return updated;
            });
            saveSalonsToStorage(loadedSalons);
          }
        } catch (e) {
          console.warn('Failed to parse saved salons', e);
        }
      }
      setSavedSalons(loadedSalons);

      const savedCurrentSalonId = await AsyncStorage.getItem('@salon_current_salon_id');
      const foundSalon = loadedSalons.find((s) => s.id === savedCurrentSalonId) || loadedSalons[0];
      setCurrentSalon(foundSalon);

      // 2. 席データの読み込み・初期化（デフォルトはメインタイマと1番席サンプルのみ。余計な席は排除し本人が追加）
      const savedSeatsJson = await AsyncStorage.getItem('@salon_saved_seats');
      let loadedSeats = getDefaultInitialSeats(activeUserName);
      if (savedSeatsJson) {
        try {
          const parsed = JSON.parse(savedSeatsJson);
          if (Array.isArray(parsed) && parsed.length > 0) {
            loadedSeats = parsed;
          }
        } catch (e) {
          console.warn('Failed to parse saved seats', e);
        }
      }
      setSeats(loadedSeats);

      // 3. スタッフメンバー一覧の読み込み（初期値は空 []）
      const savedMembersJson = await AsyncStorage.getItem('@salon_staff_members');
      let loadedMembers = [];
      if (savedMembersJson) {
        try {
          const parsed = JSON.parse(savedMembersJson);
          if (Array.isArray(parsed)) {
            loadedMembers = normalizeStaffMembers(parsed);
          }
        } catch (e) {
          console.warn('Failed to parse saved staff members', e);
        }
      }
      setStaffMembers(loadedMembers);

      // ★ 初回ロード時にもWatchへ最新客席データ＆メンバーを即時プッシュ！
      syncSeatsToWatch(loadedSeats, activeUserName, loadedMembers, { immediate: true });

      // ★ Bluetooth接続確立のタイムラグ（1〜2.5秒）をカバーする全自動バックアップ再送
      if (Platform.OS === 'ios') {
        setTimeout(() => {
          syncSeatsToWatch(loadedSeats, activeUserName, loadedMembers, { immediate: true });
        }, 1200);
        setTimeout(() => {
          syncSeatsToWatch(loadedSeats, activeUserName, loadedMembers, { immediate: true });
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

      // 既存席の担当者名に旧名が設定されていた場合、新名へ同期
      const updatedSeats = seats.map((s) => ({
        ...s,
        colorStaffName: s.colorStaffName === oldName ? trimmed : s.colorStaffName,
        assistantStaffName: s.assistantStaffName === oldName ? trimmed : s.assistantStaffName,
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

  // ★ 共有コードによるメンバー接続参加
  const handleJoinMemberByCode = async () => {
    const rawCode = (inputJoinMemberCode || '').trim().toUpperCase();
    if (!rawCode) {
      Alert.alert('入力エラー', '共有コード（招待コード）を入力してください');
      return;
    }
    let code = rawCode;
    if (/^\d{6}$/.test(rawCode)) {
      code = `${rawCode.slice(0, 3)}-${rawCode.slice(3)}`;
    }

    const myNick = (inputJoinMemberNickname || userName || 'スタッフ').trim();
    const newMemberId = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newMember = {
      id: newMemberId,
      originalNickname: myNick,
      customNickname: myNick,
      inviteCode: code,
      joinedAt: Date.now(),
    };

    // 重複チェック
    const isDup = staffMembers.some(
      (m) => (m.inviteCode === code || m.id === newMemberId) && getMemberDisplayName(m) === myNick
    );
    if (isDup) {
      Alert.alert('確認', 'このメンバーは既に連携登録されています。');
      return;
    }

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
      '🎉 共有メンバー接続完了',
      `共有コード「${code}」で連携しました！\n\n・登録名: 【${myNick}】\n・メンバーID: #${newMemberId.slice(-6)}\n\nタイマーの開始・停止やチェック完了がリアルタイムに共有されます。`
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

    setStaffMembers(updated);
    setIsEditNicknameModalVisible(false);
    setEditingMemberForNickname(null);
    setInputMemberCustomNickname('');

    try {
      await AsyncStorage.setItem('@salon_staff_members', JSON.stringify(updated));
      // Apple Watchへ即時同期
      syncSeatsToWatch(seats, userName, updated, { immediate: true });
    } catch (e) {
      console.warn('Failed to save custom nickname', e);
    }

    if (Platform.OS !== 'web') {
      Vibration.vibrate(40);
    }
  };

  // ★ スタッフメンバーの削除
  const handleRemoveStaffMember = (memberItem) => {
    const displayName = getMemberDisplayName(memberItem);
    const targetId = typeof memberItem === 'object' ? memberItem.id : memberItem;

    Alert.alert(
      'メンバーの解除',
      `「${displayName}」さんとの共有連携を解除しますか？`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '解除する',
          style: 'destructive',
          onPress: async () => {
            const updated = staffMembers.filter((m) => {
              if (typeof m === 'object') return m.id !== targetId;
              return m !== targetId;
            });
            setStaffMembers(updated);
            try {
              await AsyncStorage.setItem('@salon_staff_members', JSON.stringify(updated));
              // Apple Watchへ即時同期
              syncSeatsToWatch(seats, userName, updated, { immediate: true });
            } catch (e) {
              console.warn('Failed to save staff members after remove', e);
            }
          },
        },
      ]
    );
  };

  // サロン・グループ切り替え
  const handleSelectSalon = (salon) => {
    setCurrentSalon(salon);
    AsyncStorage.setItem('@salon_current_salon_id', salon.id).catch((e) => console.warn(e));
    setIsSwitcherModalVisible(false);
  };

  // 招待コードの共有・コピー（OS標準の共有シート / LINE・メッセージ等）
  const handleShareInviteCode = async (salon) => {
    const targetSalon = salon || currentSalon;
    if (!targetSalon) return;
    const code = targetSalon.inviteCode || generateRandomInviteCode();
    const isPair = targetSalon.type === 'pair';
    const name = targetSalon.name || (isPair ? 'タイマー同期モード' : 'サロン');
    try {
      const message = isPair
        ? `【Assist Timer】タイマー同期モード（完全無料）の招待コードです。\n\n🔑 ペア招待コード: ${code}\n\nアプリを開き、サロン画面 > ワークスペース切り替え > 「コードで参加」に入力すると、2人でタイマーをリアルタイム同期（無料）できます！`
        : `【Assist Timer】サロン「${name}」の招待コードです。\n\n🔑 招待コード: ${code}\n\nアプリを開き、サロン画面 > ワークスペース切り替え > 「コードで参加」に入力して参加してください。`;
      await Share.share({
        message,
        title: isPair ? `タイマー同期の招待コード: ${code}` : `${name}の招待コード: ${code}`,
      });
    } catch (e) {
      Alert.alert('招待コード', `招待コード: ${code}`);
    }
  };

  // 招待コードの直接変更・保存
  const handleSaveCustomInviteCode = () => {
    const clean = (inputNewInviteCode || '').trim().toUpperCase();
    if (!clean) {
      Alert.alert('入力エラー', '招待コードを入力してください');
      return;
    }
    if (clean.length < 4 || clean.length > 15) {
      Alert.alert('入力エラー', '招待コードは4〜15文字で入力してください');
      return;
    }
    if (!editingSalonForCode) return;

    const targetId = editingSalonForCode.id;
    const updated = savedSalons.map((s) => (s.id === targetId ? { ...s, inviteCode: clean } : s));
    setSavedSalons(updated);
    if (currentSalon?.id === targetId) {
      setCurrentSalon({ ...currentSalon, inviteCode: clean });
    }
    saveSalonsToStorage(updated, currentSalon?.id);
    setSwitcherSubView('list');
    Alert.alert('招待コードを更新しました', `招待コード: ${clean}\n\nパートナーにこのコードを共有してご参加ください。`);
  };

  // ランダムコード再生成
  const handleRegenerateRandomCode = () => {
    const newCode = generateRandomInviteCode();
    setInputNewInviteCode(newCode);
  };

  // 招待コードで新規参加
  const handleJoinByCode = () => {
    const rawCode = inputInviteCode.trim().toUpperCase();
    if (!rawCode) {
      Alert.alert('入力エラー', '招待コードを入力してください');
      return;
    }
    // 6桁数字のみで打たれた場合は自動で3桁-3桁にフォーマット
    let code = rawCode;
    if (/^\d{6}$/.test(rawCode)) {
      code = `${rawCode.slice(0, 3)}-${rawCode.slice(3)}`;
    }

    const newSalonItem = {
      id: `salon-${Date.now()}`,
      name: inputSalonName.trim() || `サロン (${code})`,
      type: 'salon',
      inviteCode: code,
      isPro: false,
      role: 'assistant',
      description: 'コード参加サロン (メンバー共有中)',
    };
    const updatedSalons = [newSalonItem, ...savedSalons];
    setSavedSalons(updatedSalons);
    setCurrentSalon(newSalonItem);
    saveSalonsToStorage(updatedSalons, newSalonItem.id);
    setIsJoinCodeModalVisible(false);
    setInputInviteCode('');
    setInputSalonName('');
    Alert.alert('参加完了', `「${newSalonItem.name}」に接続しました！`);
  };

  // 🧪 サロン共有モード（PRO）テスト用サロンの作成・切り替え
  const handleCreateTestProSalon = () => {
    const testId = 'workspace-pro-demo';
    const exists = savedSalons.find((s) => s.id === testId);

    const testSalonItem = exists || {
      id: testId,
      name: '表参道店 (PROサロン共有)',
      type: 'salon',
      inviteCode: '888-999',
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
          history: ['25分放置開始 (担当: 佐藤)', '7分チェックセット'],
        },
        {
          id: 'seat-test-3',
          seatLabel: '3番席 (個室)',
          status: 'running',
          colorStaffName: '田中',
          assistantStaffName: '',
          actionStatus: null,
          isShampooing: true,
          targetSeconds: 1800,
          initialMinutes: 30,
          targetEndTimestamp: Date.now() + 2 * 60 * 1000 + 10 * 1000,
          comment: 'シャンプー中',
          history: ['30分放置開始 (担当: 田中)', 'シャンプー台移動'],
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
          onPress: () => {
            const updated = savedSalons.filter((s) => s.id !== salonToDelete.id);
            setSavedSalons(updated);
            let nextSalon = currentSalon;
            if (currentSalon?.id === salonToDelete.id) {
              nextSalon = updated[0] || createDefaultFreeSalon();
              setCurrentSalon(nextSalon);
              AsyncStorage.setItem('@salon_current_salon_id', nextSalon.id).catch((e) => console.warn(e));
            }
            saveSalonsToStorage(updated, nextSalon.id);
          },
        },
      ]
    );
  };

  // ★ ユーザー指定: タイム設定モーダルでの席名変更の保存
  const handleSaveSeatLabel = () => {
    const trimmed = (modalSeatLabel || '').trim() || '席';
    setModalSeatLabel(trimmed);
    setIsEditingSeatLabel(false);
    if (targetSeatId) {
      setSeats((prev) => {
        const updated = prev.map((s) => (s.id === targetSeatId ? { ...s, seatLabel: trimmed } : s));
        saveSeatsToStorage(updated);
        return updated;
      });
    }
  };

  // 待機席タップ → タイム設定モーダルを開く（新規設定）
  const handleOpenSetTimerModal = (seat) => {
    setIsEditingSeatLabel(false);
    setTargetSeatId(seat.id);
    setModalSeatLabel(seat.seatLabel);
    setModalTargetMinutes(20);
    setModalTargetSeconds(0);
    setModalCheckMinutes(0);
    setModalCheckSeconds(0);
    setModalCheckStaffName('');
    setModalColorStaff(userName || 'スタイリスト');
    setModalAssistantStaff('');
    setModalComment('');
    setIsEditingExistingTimer(false);
    setTimerSetupMode('default');
    setIsSetTimerModalVisible(true);
  };

  // タイマーの数字部分を押した時: 時間変更＆タイマー停止アクションモーダルを開く
  const handlePressSeatTimerDigits = (seat) => {
    // リセット状態（0:00）の場合は直接タイム入れ直し（クイックタイム変更）を開く
    if (seat.isReset || (seat.status === 'paused' && (seat.pausedRemainingSeconds === 0 || !seat.pausedRemainingSeconds))) {
      handleOpenQuickTimeAdjustModal(seat);
      return;
    }
    setActionTargetSeat(seat);
    setIsTimeActionModalVisible(true);
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
    setModalColorStaff(seat.colorStaffName || userName || 'スタイリスト');
    setModalAssistantStaff(seat.assistantStaffName || '');
    setModalComment(seat.comment || '');
    setIsEditingExistingTimer(false);
    setTimerSetupMode('additional');
    setIsSetTimerModalVisible(true);
  };

  // モーダルから「タイマーを止める / 施術状態（コーミング/シャンプー等）に変更」を押した時
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

    // ★ ユーザー指定: シャンプーの場合はアコーディオンをしまう。シャンプー以外（コーミング、チェック等）の場合は開けたままにしておく
    const isShampoo = determinedActionId === 'shampoo';
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedPausedSeatIds((prev) => ({ ...prev, [seat.id]: !isShampoo }));

    const nowStr = getCurrentTimeFormatted();
    // 担当スタッフ名（アシスタント担当がいればその名前、いなければ操作者）
    const staffName =
      determinedActionId === 'shampoo' || determinedActionId === 'combing'
        ? seat.assistantStaffName || currentUser
        : currentUser;

    const actionLabel = actionInfo ? actionInfo.label : null;
    const historyText = actionLabel ? `${staffName} ${actionLabel}` : `${currentUser} 停止`;

    const historyItem = {
      id: `h-${Date.now()}`,
      time: nowStr,
      text: historyText,
      type: 'status',
    };

    // タイマーを一時停止状態にし、指定されたステータスに変更、確認フラグをON（緑色シグナルへ移行）、停止者を記録、履歴追記
    const updatedSeats = seats.map((s) => {
      if (s.id !== seat.id) return s;
      const remaining = Math.max(0, Math.floor((s.targetEndTimestamp - Date.now()) / 1000));
      const prevHistory = s.history || [];
      const isZeroRem = remaining <= 0;
      return {
        ...s,
        status: 'paused',
        pausedRemainingSeconds: remaining,
        actionStatus: determinedActionId || null,
        isShampooing: determinedActionId === 'shampoo',
        mainStaffConfirmed: true,
        assistantStaffConfirmed: true,
        stoppedBy: currentUser,
        ...(isZeroRem ? {
          assistantStaffName: '',
          helpProcess: null,
          isRecruiting: false,
          isNoHelpNeeded: false,
        } : {}),
        history: [...prevHistory, historyItem],
      };
    });
    setSeats(updatedSeats);
    saveSeatsToStorage(updatedSeats);

    // 強い確認振動
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 250, 100, 250]);
    }

    // ★ 相手のApple Watchへ即時ブロードキャスト通知
    const notifTitle = actionLabel ? `${actionLabel}移行` : 'タイマー停止';
    const notifText = `⏹️ ${currentUser}が【${seat.seatLabel || '席'}】の${notifTitle}を行いました`;
    syncSeatsToWatch(updatedSeats, userName, staffMembers, {
      immediate: true,
      notification: {
        text: notifText,
        color: '#FF9500',
        sourceUser: currentUser,
      },
    });

    const mainStaff = (seat.colorStaffName || '').trim();
    const assistStaff = (seat.assistantStaffName || '').trim();
    const isMain = mainStaff && mainStaff.toLowerCase() === currentUser.toLowerCase();
    const isAssist = assistStaff && assistStaff.toLowerCase() === currentUser.toLowerCase();
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
    setSeats((prev) =>
      prev.map((s) => {
        if (s.id !== seatId) return s;
        const isNoHelp = s.assistantStaffName === 'ヘルプなし' || s.assistantStaffName === 'none';
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
      })
    );

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 150]);
    }
  };

  // スタッフによるタイム確認（ヘルプ担当本人の直接確認、または代理確認モーダル起動）
  const handlePressConfirmButton = (seat) => {
    const myName = (userName || '').trim().toLowerCase();
    const isNoHelp = seat.assistantStaffName === 'ヘルプなし' || seat.assistantStaffName === 'none';
    const isAssistant = myName.length > 0 && (seat.assistantStaffName || '').toLowerCase().includes(myName);

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

    setSeats((prev) =>
      prev.map((s) => {
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
      })
    );

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 150, 80, 150]);
    }

    const message = `【${targetSeat.seatLabel}】のタイム確認について、${currentOperator}さんが${roleLabel}の代わりに代理確認を行いました。`;
    if (Platform.OS === 'web') {
      window.alert(message);
    } else {
      Alert.alert(
        '🤝 代理確認の完了・関係者共有',
        message + '\n\n（メイン担当・ヘルプ担当・あなたの3名にリアルタイム共有されました）',
        [{ text: 'OK' }]
      );
    }
  };

  // SOS要請発信
  const handleTriggerSOS = (seatId) => {
    const targetSeat = seats.find((s) => s.id === seatId);
    setSeats((prev) =>
      prev.map((s) => (s.id === seatId ? { ...s, sosTriggered: true } : s))
    );

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 300, 100, 300, 100, 300]);
    }

    Alert.alert(
      '🚨 SOSヘルプ要請を発信しました',
      `「${targetSeat?.seatLabel || '対象席'}」へのヘルプ要請をサロンスタッフ全員に一斉発信しました！`
    );
  };

  // メインタイマーウィジェットの数字部分を押した時
  const handlePressMainTimerDigits = () => {
    Alert.alert(
      '時間変更しますか？',
      'メインタイマーの時間を変更しますか？\n（画面上部の「タイマー」タブにて詳細な時間変更が可能です）',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '変更する',
          onPress: () => {
            if (idleSeats.length > 0) {
              setIsAssignMainTimerModalVisible(true);
            } else {
              Alert.alert('時間設定について', '上部ナビゲーションの「タイマー」タブを開くと、テンキーやお気に入りから自由に時間変更できます。');
            }
          },
        },
      ]
    );
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

  // ★ ユーザー指定: 席のチェックタイマー停止・完了（タイマー設定者へ通知送信）
  const handleCompleteCheck = (seatId) => {
    const targetSeat = seats.find((s) => s.id === seatId);
    const nowStr = getCurrentTimeFormatted();
    const currentUser = (userName || 'スタッフ').trim();
    const creatorName = (targetSeat?.colorStaffName || 'タイマー作成者').trim();
    const checker = (targetSeat?.checkStaffName || currentUser).trim();

    const updatedSeats = seats.map((s) => {
      if (s.id !== seatId) return s;
      const prevHistory = s.history || [];
      const chkText = `${checker}チェック完了`;
      const historyItem = {
        id: `h-${Date.now()}`,
        time: nowStr,
        text: chkText,
        type: 'check',
      };
      return {
        ...s,
        checkStatus: 'completed',
        history: [...prevHistory, historyItem],
      };
    });
    setSeats(updatedSeats);
    saveSeatsToStorage(updatedSeats);

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 150, 80, 150]);
    }

    // ★ 相手のApple Watchへ即時ブロードキャスト通知
    const seatLabel = targetSeat?.seatLabel || '対象席';
    const notifText = `✅ ${checker}が【${seatLabel}】のチェックを完了しました`;
    syncSeatsToWatch(updatedSeats, userName, staffMembers, {
      immediate: true,
      notification: {
        text: notifText,
        color: '#30D158',
        sourceUser: currentUser,
      },
    });

    // ★ ユーザー指定: 「そしたらタイマー設定者の方に通知が送られる」
    const isSelf = creatorName && creatorName.toLowerCase() === currentUser.toLowerCase();

    if (isSelf) {
      Alert.alert(
        '🔔 チェックタイマー停止・完了',
        `「${targetSeat?.seatLabel || '対象席'}」のチェックタイマーを停止しました。\n施術履歴に「${checker}チェック完了」と記録されました。`,
        [{ text: 'OK' }]
      );
    } else {
      // 第3者またはチェック担当が止めた場合 -> タイマー設定者（creatorName）へ通知が送られる！
      Alert.alert(
        '🔔 タイマー設定者へチェック完了通知を送信',
        `「${targetSeat?.seatLabel || '対象席'}」のチェックタイマーを停止しました。\n\n【リアルタイム通知送信完了】\n・📝 タイマー設定者: 【${creatorName}】さん\n・🔍 チェック実施者: 【${checker}】さん\n\n設定者の端末およびApple Watchにチェック完了通知が届きました。`,
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

    setSeats((prev) =>
      prev.map((s) => {
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
            // ★ 新しく測る時は前の施術のヘルプを勝手に引き継がない
            assistantStaffName: (modalAssistantStaff || '').trim() || '',
            isShampooing: false,
            targetSeconds: targetSec,
            initialMinutes: mins > 0 ? mins : Math.round(targetSec / 60),
            targetEndTimestamp: endTs,
            pausedRemainingSeconds: null,
            checkTargetSeconds: hasCheckTimer ? checkTargetSec : null,
            checkInitialMinutes: hasCheckTimer ? (checkMins > 0 ? checkMins : Math.round(checkTargetSec / 60)) : null,
            checkEndTimestamp: checkEndTs,
            checkPausedRemainingSeconds: null,
            checkStatus: hasCheckTimer ? 'running' : null,
            checkStaffName: hasCheckTimer ? (modalCheckStaffName || null) : null,
            checkAlerted: false,
            stoppedBy: null,
            mainStaffConfirmed: true,
            assistantStaffConfirmed: false,
            comment: s.comment || '',
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
          return {
            ...s,
            seatLabel: modalSeatLabel.trim() || s.seatLabel,
            status: 'running',
            colorStaffName: userName || s.colorStaffName || 'スタイリスト',
            assistantStaffName: (modalAssistantStaff !== undefined && modalAssistantStaff !== '') ? modalAssistantStaff.trim() : (s.assistantStaffName || ''),
            isShampooing: s.isShampooing,
            targetSeconds: targetSec,
            initialMinutes: mins > 0 ? mins : Math.round(targetSec / 60),
            targetEndTimestamp: endTs,
            pausedRemainingSeconds: null,
            checkTargetSeconds: hasCheckTimer ? checkTargetSec : null,
            checkInitialMinutes: hasCheckTimer ? (checkMins > 0 ? checkMins : Math.round(checkTargetSec / 60)) : null,
            checkEndTimestamp: checkEndTs,
            checkPausedRemainingSeconds: null,
            checkStatus: hasCheckTimer ? 'running' : null,
            checkStaffName: hasCheckTimer ? (modalCheckStaffName || s.checkStaffName || null) : null,
            checkAlerted: false,
            stoppedBy: null,
            mainStaffConfirmed: true,
            assistantStaffConfirmed: false,
            comment: s.comment || '',
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
          return {
            ...s,
            seatLabel: modalSeatLabel.trim() || s.seatLabel,
            status: 'running',
            colorStaffName: userName || s.colorStaffName || 'スタイリスト',
            assistantStaffName: (modalAssistantStaff !== undefined && modalAssistantStaff !== '') ? modalAssistantStaff.trim() : (s.assistantStaffName || ''),
            isShampooing: s.isShampooing,
            targetSeconds: targetSec,
            initialMinutes: s.initialMinutes || (mins > 0 ? mins : Math.round(targetSec / 60)),
            targetEndTimestamp: endTs,
            checkTargetSeconds: hasCheckTimer ? checkTargetSec : null,
            checkInitialMinutes: hasCheckTimer ? (checkMins > 0 ? checkMins : Math.round(checkTargetSec / 60)) : null,
            checkEndTimestamp: checkEndTs,
            checkPausedRemainingSeconds: null,
            checkStatus: hasCheckTimer ? 'running' : null,
            checkStaffName: hasCheckTimer ? (modalCheckStaffName || s.checkStaffName || null) : null,
            checkAlerted: false,
            comment: s.comment || '',
            history: [...prevHistory, historyItem],
          };
        }

        // ④ 通常の新規開始（待機中空席からスタート）
        const prevHistory = s.history || [];
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
          // ★ 新規開始時はモーダルの指定がなければ空文字
          assistantStaffName: (modalAssistantStaff || '').trim() || '',
          isShampooing: false,
          targetSeconds: targetSec,
          initialMinutes: mins > 0 ? mins : Math.round(targetSec / 60),
          targetEndTimestamp: endTs,
          pausedRemainingSeconds: null,
          checkTargetSeconds: hasCheckTimer ? checkTargetSec : null,
          checkInitialMinutes: hasCheckTimer ? (checkMins > 0 ? checkMins : Math.round(checkTargetSec / 60)) : null,
          checkEndTimestamp: checkEndTs,
          checkPausedRemainingSeconds: null,
          checkStatus: hasCheckTimer ? 'running' : null,
          checkStaffName: hasCheckTimer ? (modalCheckStaffName || null) : null,
          checkAlerted: false,
          stoppedBy: null,
          mainStaffConfirmed: true,
          assistantStaffConfirmed: false,
          comment: s.comment || '',
          history: [...prevHistory, historyItem],
        };
      })
    );
    if (targetSeatId) {
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
    setSeats((prev) =>
      prev.map((s) => {
        if (s.id !== commentTargetSeat.id) return s;
        return {
          ...s,
          comment: newComment,
        };
      })
    );
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
    setSeats((prev) =>
      prev.map((s) => {
        if (s.id !== seatId) return s;
        return {
          ...s,
          assistantStaffName: targetHelp,
          assistantStaffConfirmed: true,
        };
      })
    );
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
      setSeats((prev) =>
        prev.map((s) => {
          if (s.id !== seat.id) return s;
          return {
            ...s,
            assistantStaffName: 'ヘルプなし',
            assistantStaffConfirmed: true,
            actionStatus: null,
            isShampooing: false,
          };
        })
      );
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
    setSeats((prev) =>
      prev.map((s) => {
        if (s.id !== seat.id) return s;
        return {
          ...s,
          assistantStaffName: newHelp || null,
          actionStatus: chosenAction || s.actionStatus || null,
          isShampooing: chosenAction === 'shampoo' || (chosenAction ? false : s.isShampooing),
          // もし本人が入った場合はアシスタント確認フラグをONに
          assistantStaffConfirmed:
            newHelp && newHelp.toLowerCase() === assigner.toLowerCase()
              ? true
              : s.assistantStaffConfirmed,
        };
      })
    );

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

    const isAssignerMain = mainStaff && mainStaff.toLowerCase() === assigner.toLowerCase();
    const isAssignerNewHelp = newHelp && newHelp.toLowerCase() === assigner.toLowerCase();
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
        `「${seat.seatLabel}」の${actionBadgeLabel}ヘルプ担当に【${newHelp}】さんを指名しました。\n\n【お互いへの通知完了】\n・🎨 ${mainStaff}（あなた・メイン担当）\n・🤝 ${newHelp}（指定されたヘルプ）\n\n両者の端末およびApple Watchに通知が届きました。`,
        [{ text: 'OK' }]
      );
    } else {
      // 本人が立候補した場合
      Alert.alert(
        '🤝 ヘルプ参戦通知',
        `「${seat.seatLabel}」の${actionBadgeLabel}ヘルプ担当に【${newHelp}】（あなた）が入りました。\n\n【お互いへの通知完了】\n・🎨 ${mainStaff || 'メイン担当'}\n・🤝 ${newHelp}（あなた・ヘルプ担当）\n\n両者の端末およびApple Watchに通知が届きました。`,
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
    setSeats((prev) =>
      prev.map((s) => {
        if (s.id !== seatId) return s;
        return {
          ...s,
          checkStaffName: trimmed || null,
        };
      })
    );
    setIsCheckStaffModalVisible(false);
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 80]);
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
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (seat.status === 'paused') {
      // ★ ユーザー指定: 停止中席の場合、シャンプーならしまう、シャンプー以外なら開けたままにする
      setExpandedPausedSeatIds((prev) => ({ ...prev, [seat.id]: !isShampoo }));
    }

    setSeats((prev) =>
      prev.map((s) => {
        if (s.id !== seat.id) return s;
        return {
          ...s,
          actionStatus: statusId || null,
          isShampooing: isShampoo,
        };
      })
    );

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 80]);
    }
  };

  // 一時停止 / 再開（第3者停止時の3名通知 & アコーディオン折りたたみ連動）
  const handleTogglePause = (seatId) => {
    const seat = seats.find((s) => s.id === seatId);
    if (!seat) return;
    const isStopping = seat.status === 'running';
    const currentUser = (userName || 'スタッフ').trim();
    const isShampoo = seat.actionStatus === 'shampoo' || seat.isShampooing;

    // アコーディオン開閉アニメーション
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (isStopping) {
      // ★ ユーザー指定: 停止時、シャンプーならアコーディオンをしまい、シャンプー以外なら開けたままにする
      setExpandedPausedSeatIds((prev) => ({ ...prev, [seatId]: !isShampoo }));
    }

    setSeats((prev) =>
      prev.map((s) => {
        if (s.id !== seatId) return s;
        if (s.status === 'running') {
          const remaining = Math.max(0, Math.floor((s.targetEndTimestamp - Date.now()) / 1000));
          const isZeroRem = remaining <= 0;
          let checkRemaining = null;
          if (s.checkTargetSeconds > 0 && s.checkStatus === 'running' && s.checkEndTimestamp) {
            checkRemaining = Math.max(0, Math.floor((s.checkEndTimestamp - Date.now()) / 1000));
          }
          return {
            ...s,
            status: 'paused',
            pausedRemainingSeconds: remaining,
            checkPausedRemainingSeconds: checkRemaining,
            mainStaffConfirmed: true,
            assistantStaffConfirmed: true,
            stoppedBy: currentUser,
            ...(isZeroRem ? {
              assistantStaffName: '',
              assistantStaffConfirmed: false,
              actionStatus: null,
              isShampooing: false,
              helpProcess: null,
              isRecruiting: false,
              isNoHelpNeeded: false,
            } : {}),
          };
        } else {
          const endTs = Date.now() + (s.pausedRemainingSeconds || 0) * 1000;
          let checkEndTs = s.checkEndTimestamp;
          if (s.checkTargetSeconds > 0 && s.checkStatus === 'running' && s.checkPausedRemainingSeconds !== null) {
            checkEndTs = Date.now() + s.checkPausedRemainingSeconds * 1000;
          }
          return {
            ...s,
            status: 'running',
            targetEndTimestamp: endTs,
            checkEndTimestamp: checkEndTs,
            stoppedBy: null,
          };
        }
      })
    );

    if (isStopping) {
      if (Platform.OS !== 'web') {
        Vibration.vibrate([0, 200, 100, 200]);
      }
      const mainStaff = (seat.colorStaffName || '').trim();
      const assistStaff = (seat.assistantStaffName || '').trim();
      const isMain = mainStaff && mainStaff.toLowerCase() === currentUser.toLowerCase();
      const isAssist = assistStaff && assistStaff.toLowerCase() === currentUser.toLowerCase();
      const isThirdParty = !isMain && !isAssist;

      if (isThirdParty) {
        // 第3者が一時停止した場合 -> 3名に通知
        Alert.alert(
          '🔔 第3者によるタイマー一時停止通知 (3名共有)',
          `「${seat.seatLabel}」のタイマーを【${currentUser}】（第3者）さんが一時停止しました。\n\n【関係者3名へリアルタイム通知完了】\n・🎨 ${mainStaff || 'メイン担当'}\n・🤝 ${assistStaff || 'ヘルプ担当'}\n・👤 ${currentUser}（停止操作者）\n\n関係者3名全員の端末およびApple Watchに通知が届きました。`,
          [{ text: 'OK' }]
        );
      } else {
        Alert.alert(
          '🔔 タイマー一時停止・確認通知',
          `「${seat.seatLabel}」のタイマーを一時停止しました。\n\n【お互いへの確認通知】\n・🎨 ${mainStaff || 'メイン担当'} に通知\n・🤝 ${assistStaff || 'ヘルプ担当'} に通知\n\n両者の端末およびApple Watchに通知が届きました。`,
          [{ text: 'OK' }]
        );
      }
    }
  };

  // ★ ユーザー指定: カードの一時停止を「リセット」に変更。タイムを0に戻し、カードは開いたまま、チェックも消え、自分以外の関係者へ通知
  const handleConfirmResetSeatTimer = (seat) => {
    Alert.alert(
      'タイマーをリセットしますか？',
      `「${seat.seatLabel}」のタイマーを0:00に戻し、チェックタイマーを解除します。\n※カードは開いたまま保持され、すぐに新しいタイムを入れ直せます。`,
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

    const currentUser = (userName || 'スタッフ').trim();
    const nowStr = getCurrentTimeFormatted();

    // ★ ユーザー指定: カードは開いたまま保持する
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedPausedSeatIds((prev) => ({ ...prev, [seatId]: true }));

    const historyItem = {
      id: `h-${Date.now()}`,
      time: nowStr,
      text: `${currentUser} タイマーリセット (0:00)`,
      type: 'reset',
    };

    const updatedSeats = seats.map((s) => {
      if (s.id !== seatId) return s;
      const prevHist = s.history || [];
      return {
        ...s,
        status: 'paused',
        targetEndTimestamp: null,
        pausedRemainingSeconds: 0,
        initialMinutes: 0,
        targetSeconds: 0,
        isOver: false,
        isReset: true,
        // ★ 00:00席のヘルプ・助手・希望プロセスを完全解除（固定残り防止）
        assistantStaffName: '',
        assistantStaffConfirmed: false,
        actionStatus: null,
        isShampooing: false,
        helpProcess: null,
        isRecruiting: false,
        isNoHelpNeeded: false,
        // ★ ユーザー指定: チェックも消える
        checkTargetSeconds: null,
        checkEndTimestamp: null,
        checkPausedRemainingSeconds: null,
        checkStatus: null,
        checkInitialMinutes: null,
        checkStaffName: null,
        checkAlerted: false,
        // 停止・確認情報
        stoppedBy: currentUser,
        mainStaffConfirmed: true,
        assistantStaffConfirmed: true,
        history: [...prevHist, historyItem],
      };
    });
    setSeats(updatedSeats);
    saveSeatsToStorage(updatedSeats);

    // ★ 相手のApple Watchへ即時ブロードキャスト通知
    const resetNotifText = `🔄 ${currentUser}が【${seat.seatLabel || '席'}】のタイマーをリセットしました`;
    syncSeatsToWatch(updatedSeats, userName, staffMembers, {
      immediate: true,
      notification: {
        text: resetNotifText,
        color: '#FF9500',
        sourceUser: currentUser,
      },
    });

    if (mainTimeupAlertedRef.current) {
      mainTimeupAlertedRef.current[seatId] = false;
    }
    if (checkAlertedRef.current) {
      checkAlertedRef.current[seatId] = false;
    }
    if (oneMinuteHelpAlertRef.current) {
      oneMinuteHelpAlertRef.current[seatId] = false;
    }

    // 触覚振動
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 150, 100, 150]);
    }

    // ★ ユーザー指定: 自分以外の関係者には通知する
    const mainStaff = (seat.colorStaffName || '').trim();
    const assistStaff = (seat.assistantStaffName || '').trim();
    const checkStaff = (seat.checkStaffName || '').trim();

    const otherRecipients = [];
    if (mainStaff && mainStaff.toLowerCase() !== currentUser.toLowerCase()) {
      otherRecipients.push(`・🎨 メイン担当: ${mainStaff}`);
    }
    if (
      assistStaff &&
      assistStaff !== 'ヘルプなし' &&
      assistStaff !== 'none' &&
      assistStaff.toLowerCase() !== currentUser.toLowerCase() &&
      !otherRecipients.some((r) => r.includes(assistStaff))
    ) {
      otherRecipients.push(`・🤝 ヘルプ担当: ${assistStaff}`);
    }
    if (
      checkStaff &&
      checkStaff !== '未定' &&
      checkStaff.toLowerCase() !== currentUser.toLowerCase() &&
      !otherRecipients.some((r) => r.includes(checkStaff))
    ) {
      otherRecipients.push(`・🔍 チェック担当: ${checkStaff}`);
    }

    if (otherRecipients.length > 0) {
      Alert.alert(
        '🔔 タイマーリセット通知 (関係者共有)',
        `「${seat.seatLabel}」のタイマーを【${currentUser}】さんがリセットしました（タイム0:00・チェック解除）。\n\n【自分以外の関係者へリアルタイム通知完了】\n${otherRecipients.join('\n')}\n\n関係者全員の端末およびApple Watchに通知が届きました。`,
        [{ text: 'OK' }]
      );
    } else {
      Alert.alert(
        '🔄 タイマーをリセットしました',
        `「${seat.seatLabel}」のタイマーを0:00に戻しました（チェックタイマーも解除されました）。\n\nカードは開いたままですので、「タイム変更」や数字タップですぐに新しいタイムを入れ直せます。`,
        [{ text: 'OK' }]
      );
    }
  };

  // ＋5分延長（互換性保持）
  const handleExtend5Min = (seatId) => {
    const nowStr = getCurrentTimeFormatted();
    setSeats((prev) =>
      prev.map((s) => {
        if (s.id !== seatId) return s;
        const historyItem = {
          id: `h-${Date.now()}`,
          time: nowStr,
          text: '5分追加放置',
          type: 'extend',
        };
        const prevHist = s.history || [];
        return {
          ...s,
          targetEndTimestamp: s.targetEndTimestamp + 5 * 60 * 1000,
          history: [...prevHist, historyItem],
        };
      })
    );
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

    setSeats((prev) =>
      prev.map((s) => {
        if (s.id !== seatId) return s;

        let newTargetEnd = s.targetEndTimestamp;
        let newPausedRemaining = s.pausedRemainingSeconds;
        let newStatus = s.status;
        const isPausedState = s.status === 'paused' || s.isPaused;

        if (isPausedState) {
          const baseRemaining = s.pausedRemainingSeconds || 0;
          const totalRemaining = Math.max(0, baseRemaining + deltaSec);
          if (totalRemaining > 0) {
            newTargetEnd = now + totalRemaining * 1000;
            newPausedRemaining = null;
            newStatus = 'running';
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
        const prevHist = s.history || [];

        return {
          ...s,
          status: newStatus,
          targetEndTimestamp: newTargetEnd,
          pausedRemainingSeconds: newPausedRemaining,
          isReset: false,
          isOver: false,
          history: [...prevHist, historyItem],
        };
      })
    );

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

    setSeats((prev) =>
      prev.map((s) => {
        if (s.id !== addHistoryTargetSeat.id) return s;
        const prevHist = s.history || [];
        return {
          ...s,
          history: [...prevHist, historyItem],
        };
      })
    );

    setIsAddHistoryModalVisible(false);
    setInputHistoryText('');
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 50]);
    }
  };

  // 施術終了（固定席なら待機中スリムバーに戻し、フリータイマーならボードから削除）
  const handleFinishSeat = (seatId) => {
    const targetSeat = seats.find((s) => s.id === seatId);
    const isFree = targetSeat?.isFreeTimer;

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
          onPress: () => {
            if (isFree) {
              setSeats((prev) => {
                const updated = prev.filter((s) => s.id !== seatId);
                saveSeatsToStorage(updated);
                return updated;
              });
            } else {
              setSeats((prev) => {
                const updated = prev.map((s) => {
                  if (s.id !== seatId) return s;
                  return {
                    ...s,
                    status: 'idle',
                    colorStaffName: '',
                    assistantStaffName: null,
                    isShampooing: false,
                    targetSeconds: 0,
                    targetEndTimestamp: 0,
                    checkTargetSeconds: null,
                    checkInitialMinutes: null,
                    checkEndTimestamp: null,
                    checkPausedRemainingSeconds: null,
                    checkStatus: null,
                    checkAlerted: false,
                    comment: '',
                  };
                });
                saveSeatsToStorage(updated);
                return updated;
              });
            }
          },
        },
      ]
    );
  };

  // 待機席の削除（席マスターから削除）
  const handleDeleteSeat = (seatId, seatLabel) => {
    Alert.alert(
      '席の削除確認',
      `「${seatLabel}」をサロンボードから削除しますか？`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除する',
          style: 'destructive',
          onPress: () => {
            setSeats((prev) => {
              const updated = prev.filter((s) => s.id !== seatId);
              saveSeatsToStorage(updated);
              return updated;
            });
          },
        },
      ]
    );
  };

  // 新規固定席の追加（席マスターを増やす）
  const handleAddNewSeatMaster = () => {
    const label = newSeatName.trim() || `${seats.length + 1}番席`;
    const newSeat = {
      id: `seat-${Date.now()}`,
      seatLabel: label,
      status: 'idle',
      colorStaffName: '',
      assistantStaffName: null,
      isShampooing: false,
      targetSeconds: 0,
      targetEndTimestamp: 0,
      comment: '',
    };
    setSeats((prev) => {
      const updated = [...prev, newSeat];
      saveSeatsToStorage(updated);
      return updated;
    });
    setNewSeatName('');
    setIsAddSeatModalVisible(false);
  };

  // メインタイマーを空席にアサイン
  const handleAssignMainTimerToSeat = (seatId) => {
    const remaining = mainTimerState?.remainingTime || 1200;
    const target = mainTimerState?.targetTime || 1200;
    const endTs = Date.now() + remaining * 1000;

    setSeats((prev) =>
      prev.map((s) => {
        if (s.id !== seatId) return s;
        return {
          ...s,
          status: 'running',
          colorStaffName: userName || 'スタイリスト',
          assistantStaffName: null,
          isShampooing: false,
          targetSeconds: target,
          targetEndTimestamp: endTs,
          comment: mainTimerState?.genre ? `ジャンル: ${mainTimerState.genre}` : '',
        };
      })
    );
    oneMinuteHelpAlertRef.current[seatId] = false;
    setIsAssignMainTimerModalVisible(false);
    Alert.alert('割り当て完了', `メインタイマーを「${seats.find((s) => s.id === seatId)?.seatLabel}」にセットしました！`);
  };

  // メインタイマーを席に割り当てずにセット（席指定なし・フリータイマーとしてサロンボードに追加）
  const handleAssignMainTimerWithoutSeat = () => {
    const remaining = mainTimerState?.remainingTime ?? 180;
    const target = mainTimerState?.targetTime ?? 180;
    const endTs = Date.now() + remaining * 1000;
    const genreText = mainTimerState?.genre ? ` (${mainTimerState.genre})` : '';

    const freeSeatItem = {
      id: `free-${Date.now()}`,
      seatLabel: `フリー${genreText || '枠'}`,
      isFreeTimer: true, // 席マスター外のフリータイマーフラグ
      status: 'running',
      colorStaffName: userName || 'スタイリスト',
      assistantStaffName: null,
      isShampooing: false,
      targetSeconds: target,
      targetEndTimestamp: endTs,
      comment: mainTimerState?.genre ? `ジャンル: ${mainTimerState.genre}` : 'メインタイマー連動 (席指定なし)',
    };

    setSeats((prev) => [freeSeatItem, ...prev]);
    setIsAssignMainTimerModalVisible(false);
    Alert.alert('セット完了', 'メインタイマーを席に割り当てずにサロンボードへセットしました！');
  };

  // フィルタリング処理
  const filteredSeats = seats.filter((s) => {
    if (filterMode === 'all') return true;
    if (filterMode === 'my') {
      if (s.status === 'idle') return false; // 待機席は除外
      const my = (userName || '').trim().toLowerCase();
      const isMyColor = (s.colorStaffName || '').toLowerCase().includes(my);
      const isMyAssistant = (s.assistantStaffName || '').toLowerCase().includes(my);
      return isMyColor || isMyAssistant;
    }
    return true;
  });

  // 待機中の空席リスト（マイタイマー割り当て用）
  const idleSeats = seats.filter((s) => s.status === 'idle');

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
                : (currentSalon?.description || 'オンライン中')}
            </Text>
            {currentSalon?.isPro ? (
              <View style={[styles.proBadge, { backgroundColor: '#FFD700' }]}>
                <Text style={styles.proBadgeText}>PRO</Text>
              </View>
            ) : null}
          </View>
        </TouchableOpacity>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {/* ★ メンバー管理ボタン */}
          <TouchableOpacity
            style={[styles.addSeatHeaderButton, { backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7', borderColor: theme.cardBorder }]}
            onPress={() => setIsMemberManageModalVisible(true)}
            activeOpacity={0.7}
          >
            <Ionicons name="people" size={15} color={theme.textPrimary} />
            <Text style={[styles.addSeatHeaderText, { color: theme.textPrimary, marginLeft: 2 }]}>
              メンバー{staffMembers.length > 0 ? ` (${staffMembers.length})` : ''}
            </Text>
          </TouchableOpacity>

          {/* 席追加（席マスターを増やす）ボタン */}
          <TouchableOpacity
            style={[styles.addSeatHeaderButton, { backgroundColor: theme.accentLight, borderColor: theme.accentBorder }]}
            onPress={() => {
              setNewSeatName(`${seats.length + 1}番席`);
              setIsAddSeatModalVisible(true);
            }}
          >
            <Ionicons name="add" size={17} color={theme.accent} />
            <Text style={[styles.addSeatHeaderText, { color: theme.accent }]}>席追加</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* 2. 最上部・メインタイマー連動ウィジェット (HomeScreen連携) */}
      <View
        style={[
          styles.mainTimerWidget,
          {
            backgroundColor: mainTimerState?.isRunning ? theme.accentLight : theme.cardBg,
            borderColor: mainTimerState?.isRunning ? theme.accentBorder : theme.cardBorder,
          },
        ]}
      >
        {/* 上段: タイトル ＆ ステータス ＆ 計測ジャンル（横幅いっぱい使って重なりを完全防止） */}
        <View style={styles.mainTimerHeaderRow}>
          <View style={styles.mainTimerBadgeRow}>
            <Ionicons
              name={mainTimerState?.isRunning ? 'timer' : 'timer-outline'}
              size={15}
              color={mainTimerState?.isRunning ? theme.accent : theme.textSecondary}
              style={{ marginRight: 5 }}
            />
            <Text style={[styles.mainTimerLabel, { color: mainTimerState?.isRunning ? theme.accent : theme.textPrimary }]}>
              {mainTimerState?.isRunning
                ? 'メインタイマー稼働中'
                : mainTimerState?.isPaused
                ? 'メインタイマー (一時停止)'
                : 'メインタイマー (待機中)'}
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
                    : mainTimerState?.isRunning
                    ? theme.accent
                    : theme.textPrimary,
                },
              ]}
            >
              {mainTimerState?.isCountUp ? '+' : ''}
              {formatSec(mainTimerState?.remainingTime ?? 180)}
            </Text>
          </TouchableOpacity>

          <View style={styles.mainTimerRightActions}>
            <TouchableOpacity
              style={[
                styles.mainTimerBtn,
                {
                  backgroundColor: mainTimerState?.isRunning ? theme.warningLight : theme.accent,
                  borderColor: mainTimerState?.isRunning ? theme.warning : theme.accent,
                },
              ]}
              onPress={() => requestMainTimerAction('toggle')}
            >
              <Ionicons
                name={mainTimerState?.isRunning ? 'pause' : 'play'}
                size={13}
                color={mainTimerState?.isRunning ? theme.warning : '#FFFFFF'}
              />
              <Text
                style={[
                  styles.mainTimerBtnText,
                  { color: mainTimerState?.isRunning ? theme.warning : '#FFFFFF' },
                ]}
              >
                {mainTimerState?.isRunning ? '一時停止' : 'スタート'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.mainTimerBtn, { backgroundColor: theme.inputBg, borderColor: theme.cardBorder }]}
              onPress={() => requestMainTimerAction('reset')}
            >
              <Text style={[styles.mainTimerBtnText, { color: theme.textSecondary }]}>リセット</Text>
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
                onLongPress={() => handleDeleteSeat(item.id, item.seatLabel)}
                activeOpacity={0.7}
              >
                <View style={styles.idleRowLeft}>
                    <View style={[styles.idleSeatBadge, { backgroundColor: theme.inputBg }]}>
                      <Text style={[styles.idleSeatBadgeText, { color: theme.textPrimary }]}>
                        ⌚️ {item.seatLabel.replace(/^[🪑⌚️⏱️]\s*/, '')}
                      </Text>
                    </View>
                  <Text style={[styles.idleStatusText, { color: theme.textTertiary }]}>
                    空席・待機中
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
          const isShampoo = item.isShampooing || item.actionStatus === 'shampoo';
          // ★ ユーザー指定: シャンプー以外の場合は開けたままにしておく。シャンプーの場合はアコーディオンをしまう。
          const isExpanded =
            expandedPausedSeatIds[item.id] !== undefined
              ? !!expandedPausedSeatIds[item.id]
              : !isShampoo;

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
          const timeString = `${isOver ? '+' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
          const currentStatusInfo = getActionStatusInfo(item.actionStatus, item.isShampooing);
          const isZeroPaused = isPaused && (remainingSec <= 0 || item.isReset || (item.pausedRemainingSeconds !== null && item.pausedRemainingSeconds <= 0));

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
                  <View style={[styles.pausedSeatBadge, { backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7' }]}>
                    <Text style={[styles.pausedSeatBadgeText, { color: theme.textPrimary }]}>
                      ⌚️ {item.seatLabel.replace(/^[🪑⌚️⏱️]\s*/, '')}
                    </Text>
                  </View>
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
                        ? '待機中'
                        : item.assistantStaffName === 'ヘルプなし'
                        ? 'ヘルプなし'
                        : item.assistantStaffName
                        ? item.assistantStaffName
                        : '未定'}
                    </Text>
                  </TouchableOpacity>

                  <Text style={[styles.pausedStaffText, { color: theme.textSecondary }]} numberOfLines={1}>
                    📝 {item.colorStaffName || '未'}
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
                  <View style={[styles.seatLabelContainer, item.isFreeTimer && { backgroundColor: theme.accentLight }]}>
                    <Text style={[styles.seatLabelText, { color: item.isFreeTimer ? theme.accent : theme.textPrimary }]}>
                      ⌚️ {item.seatLabel.replace(/^[🪑⌚️⏱️]\s*/, '')}
                    </Text>
                  </View>

                  {/* ★ ユーザー指定: 1番席の右の所にタイマー作成者の名前を表示（絵文字は📝） */}
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
                        📝 {item.colorStaffName}
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
                          ? `⏸️ 停止中 (🛑 ${item.stoppedBy})`
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
                          ? 'チェック確認済み'
                          : isTimeUp
                          ? 'チェック時間！'
                          : 'チェックまで あと'}
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
                            ? (item.checkStaffName ? `${item.checkStaffName}済 ▾` : 'チェック済 ▾')
                            : (item.checkStaffName ? `チェック: ${item.checkStaffName} ▾` : 'チェック未定 ▾')}
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
                          ヘルプ（{item.assistantStaffName}）: {item.assistantStaffConfirmed ? '✓済' : '✕未'}
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
                      const myName = (userName || '').trim().toLowerCase();
                      const isAssistant = myName.length > 0 && (item.assistantStaffName || '').toLowerCase().includes(myName);
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

              {/* ★ ユーザー指定: タイマーの下に履歴が出るようにする（例: 10分放置 / 田口チェック / 7追加放置 / 伊藤シャンプー） */}
              {item.history && item.history.length > 0 ? (
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
                {/* ★ ユーザー指定: 左下「＋5分」を「タイム変更」にし、タップでモーダルを起動 */}
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => handleOpenQuickTimeAdjustModal(item)}
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

        {/* 席マスター追加ボタン（一番下） */}
        <TouchableOpacity
          style={[styles.bottomAddSeatBar, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}
          onPress={() => {
            setNewSeatName(`${seats.length + 1}番席`);
            setIsAddSeatModalVisible(true);
          }}
        >
          <Ionicons name="add-circle-outline" size={18} color={theme.accent} style={{ marginRight: 6 }} />
          <Text style={[styles.bottomAddSeatText, { color: theme.accent }]}>
            新しい席番号を追加する
          </Text>
        </TouchableOpacity>
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
        <View style={styles.modalOverlay}>
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

                {/* コードの直接変更・再生成セクション */}
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
                      placeholder="例: 738-921"
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
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* ② 招待コードで参加モーダル */}
      <Modal
        visible={isJoinCodeModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsJoinCodeModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.cardBg }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>招待コードで参加</Text>
              <TouchableOpacity onPress={() => setIsJoinCodeModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={[styles.inputLabel, { color: theme.textSecondary }]}>6桁の招待コード</Text>
            <TextInput
              style={[styles.textInput, { backgroundColor: theme.inputBg, color: theme.textPrimary, borderColor: theme.cardBorder }]}
              placeholder="例: 738-921"
              placeholderTextColor={theme.textTertiary}
              value={inputInviteCode}
              onChangeText={setInputInviteCode}
              autoCapitalize="characters"
            />

            <Text style={[styles.inputLabel, { color: theme.textSecondary }]}>サロンの表示名 (任意)</Text>
            <TextInput
              style={[styles.textInput, { backgroundColor: theme.inputBg, color: theme.textPrimary, borderColor: theme.cardBorder }]}
              placeholder="例: 表参道店、2Fチームなど"
              placeholderTextColor={theme.textTertiary}
              value={inputSalonName}
              onChangeText={setInputSalonName}
            />

            <TouchableOpacity
              style={[styles.submitButton, { backgroundColor: theme.accent }]}
              onPress={handleJoinByCode}
            >
              <Text style={styles.submitButtonText}>サロンに参加する</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ③ 待機席のタイム設定モーダル */}
      <Modal
        visible={isSetTimerModalVisible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setIsSetTimerModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
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
                  {/* ★ ユーザー指定: タイム設定画面で「2番席」等の名前を変更できるようにする */}
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

            <ScrollView showsVerticalScrollIndicator={false}>
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

                {/* ★ ユーザー指定: チェックタイマー設定時、チェック担当スタッフも同時に指定可能 */}
                {modalCheckMinutes > 0 && (
                  <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderColor: isEcoMode ? '#2C2C2E' : '#E5E7EB' }}>
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
                              {staff}
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

              <TouchableOpacity
                style={[styles.submitButton, { backgroundColor: theme.accent, marginTop: 18 }]}
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
        </View>
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
              現在のメインタイマー（{formatSec(mainTimerState?.remainingTime ?? 180)}）をセットしてサロンボードで稼働開始します。
            </Text>

            {/* ★ ユーザー指定: 席に割り当てずにセットするボタン */}
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

      {/* ⑤ 新規席マスター追加モーダル */}
      <Modal
        visible={isAddSeatModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsAddSeatModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.cardBg }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>新しい席を追加</Text>
              <TouchableOpacity onPress={() => setIsAddSeatModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={[styles.inputLabel, { color: theme.textSecondary }]}>席の名前・番号</Text>
            <TextInput
              style={[styles.textInput, { backgroundColor: theme.inputBg, color: theme.textPrimary, borderColor: theme.cardBorder }]}
              placeholder="例: 6番席, 個室B, セット面C"
              placeholderTextColor={theme.textTertiary}
              value={newSeatName}
              onChangeText={setNewSeatName}
            />

            <TouchableOpacity
              style={[styles.submitButton, { backgroundColor: theme.accent }]}
              onPress={handleAddNewSeatMaster}
            >
              <Text style={styles.submitButtonText}>席を追加する</Text>
            </TouchableOpacity>
          </View>
        </View>
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
                            : 'タイマーを止める。'}
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
            <View style={styles.actionModalHeaderRow}>
              <Text style={[styles.actionModalTitle, { color: theme.textPrimary, marginBottom: 0 }]}>
                チェックタイマーを止めますか？
              </Text>
              <TouchableOpacity
                onPress={() => setIsCheckStopModalVisible(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={22} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={[styles.actionModalMessage, { color: theme.textSecondary, marginTop: 8 }]}>
              「{checkStopTargetSeat?.seatLabel || '対象席'}」のチェックタイマーを止めて完了にしますか？
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
                  タイマー設定者（📝 {checkStopTargetSeat?.colorStaffName || '担当'} さん）へ通知
                </Text>
                <Text style={{ fontSize: 11, color: theme.textSecondary, marginTop: 2 }}>
                  停止すると、設定者の端末およびApple Watchにチェック完了の通知がリアルタイム送信されます。
                </Text>
              </View>
            </View>

            {/* ボタングループ */}
            <View style={styles.actionModalTopButtonsRow}>
              <TouchableOpacity
                style={[
                  styles.actionModalCancelBtn,
                  { backgroundColor: isEcoMode ? '#2C2C2E' : '#E5E5EA' },
                ]}
                onPress={() => setIsCheckStopModalVisible(false)}
                activeOpacity={0.7}
              >
                <Text style={[styles.actionModalCancelBtnText, { color: theme.textPrimary }]}>
                  キャンセル
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.actionModalChangeBtn,
                  { backgroundColor: '#10B981' },
                ]}
                onPress={handleConfirmStopCheckTimer}
                activeOpacity={0.7}
              >
                <Ionicons name="checkmark-circle" size={16} color="#FFFFFF" style={{ marginRight: 4 }} />
                <Text style={[styles.actionModalChangeBtnText, { color: '#FFFFFF', fontWeight: '700' }]}>
                  タイマーを止める
                </Text>
              </TouchableOpacity>
            </View>
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
                  {helpAssignTargetSeat?.seatLabel} （作成者: 📝 {helpAssignTargetSeat?.colorStaffName || '未設定'}）
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
                        私が【{getActionStatusInfo(selectedHelpAction)?.label}】に入ります（立候補）
                      </Text>
                      <Text style={[styles.selfTakeBtnSub, { color: theme.textSecondary }]}>
                        ログイン中: {userName || '自分'}
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
                              🤝 {staff} {isCurrent ? '（現在）' : ''}
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
                  指定すると、メイン担当・指名されたヘルプ・指定したあなた（第3者）の【関係者3名全員】にリアルタイム通知が届きます。
                </Text>
              </View>
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ⑧-B ★ ユーザー指定: チェック担当スタッフ指定・変更モーダル */}
      <Modal
        visible={isCheckStaffModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsCheckStaffModalVisible(false)}
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
              showsVerticalScrollIndicator={true}
              style={{ width: '100%' }}
              contentContainerStyle={{ paddingBottom: 16 }}
              keyboardShouldPersistTaps="handled"
            >
              {/* ① ワンタップで自分がチェックに入る */}
              <TouchableOpacity
                style={[
                  styles.selfTakeBtn,
                  {
                    backgroundColor: checkStaffTargetSeat?.checkStaffName === (userName || '自分')
                      ? (isEcoMode ? 'rgba(16, 185, 129, 0.2)' : '#D1FAE5')
                      : (isEcoMode ? '#252528' : '#ECFDF5'),
                    borderColor: checkStaffTargetSeat?.checkStaffName === (userName || '自分')
                      ? '#10B981'
                      : '#A7F3D0',
                    borderWidth: checkStaffTargetSeat?.checkStaffName === (userName || '自分') ? 2 : 1,
                    marginBottom: 10,
                  },
                ]}
                onPress={() => handleAssignCheckStaff(checkStaffTargetSeat?.id, userName || '自分')}
                activeOpacity={0.7}
              >
                <Ionicons name="search" size={20} color="#059669" style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.selfTakeBtnTitle, { color: '#059669' }]}>
                    私（{userName || '自分'}）がチェックに入ります
                  </Text>
                  <Text style={[styles.selfTakeBtnSub, { color: theme.textSecondary }]}>
                    ワンタップでチェック担当として立候補
                  </Text>
                </View>
                {checkStaffTargetSeat?.checkStaffName === (userName || '自分') && (
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
                          🔍 {staff} {isCurrent ? '（現在）' : ''}
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
                    {confirmProxyTargetSeat?.colorStaffName || '未設定'}
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
                    {confirmProxyTargetSeat?.assistantStaffName || '未定'}
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
              ヘルプ担当者（{confirmProxyTargetSeat?.assistantStaffName || 'ヘルプ担当'}）の代わりに代理確認を行いますか？
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
                    ヘルプ（{confirmProxyTargetSeat?.assistantStaffName || 'ヘルプ担当'}）の代わりに確認
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
              <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textSecondary, marginBottom: 4 }}>
                あなたの共有コード（サロン / ペア）
              </Text>
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
                  ＋ コードで参加
                </Text>
              </TouchableOpacity>
            </View>

            {/* セクション1: 共有コードで参加フォーム */}
            {memberManageSection === 'join' ? (
              <View style={{ backgroundColor: theme.inputBg, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: theme.cardBorder, marginBottom: 12 }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: theme.textPrimary, marginBottom: 6 }}>
                  相手の共有コードを入力して連携
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
                  placeholder="共有コード (例: 123-456)"
                  placeholderTextColor={theme.textTertiary}
                  value={inputJoinMemberCode}
                  onChangeText={setInputJoinMemberCode}
                  autoCapitalize="characters"
                  returnKeyType="next"
                />
                <Text style={{ fontSize: 11, color: theme.textSecondary, marginBottom: 4 }}>
                  相手に通知されるあなたのニックネーム
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
                  placeholder={`あなたのニックネーム (例: ${userName || '田中'})`}
                  placeholderTextColor={theme.textTertiary}
                  value={inputJoinMemberNickname}
                  onChangeText={setInputJoinMemberNickname}
                  maxLength={12}
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
                  <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 13 }}>連携してメンバーに参加</Text>
                </TouchableOpacity>
              </View>
            ) : (
              /* セクション2: 登録メンバー一覧 */
              <ScrollView style={{ maxHeight: 220 }} showsVerticalScrollIndicator={false}>
                {staffMembers.length === 0 ? (
                  <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                    <Ionicons name="people-outline" size={32} color={theme.textTertiary} style={{ marginBottom: 6 }} />
                    <Text style={{ fontSize: 12, color: theme.textTertiary, textAlign: 'center', lineHeight: 18 }}>
                      まだ共有メンバーがいません{'\n'}上の共有コードをスタッフに渡すか、{'\n'}「＋ コードで参加」から連携してください
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
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                              <Ionicons name="person" size={14} color={theme.accent} style={{ marginRight: 6 }} />
                              <Text style={{ fontSize: 15, fontWeight: '700', color: theme.textPrimary }}>
                                {displayName}
                              </Text>
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
                            <TouchableOpacity
                              onPress={() => handleRemoveStaffMember(member)}
                              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                              style={{ padding: 4 }}
                            >
                              <Ionicons name="trash-outline" size={17} color={theme.danger} />
                            </TouchableOpacity>
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
