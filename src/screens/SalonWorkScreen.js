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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppContext } from '../utils/AppContext';

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

// サロン・グループ・個人無料枠の切り替え可能な固定席マルチタイマー画面
export default function SalonWorkScreen() {
  const { 
    isEcoMode,
    mainTimerState,
    requestMainTimerAction
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
  const [userName, setUserName] = useState('タグチ');
  const [currentSalon, setCurrentSalon] = useState(null);
  const [savedSalons, setSavedSalons] = useState([]);
  const [filterMode, setFilterMode] = useState('all'); // 'all' | 'my'
  const [now, setNow] = useState(Date.now());

  // 固定席マスター＆タイマーリスト
  // status: 'idle' (待機中/最小化) | 'running' (放置中) | 'paused' (一時停止) | 'over' (超過)
  const [seats, setSeats] = useState([]);

  // モーダル表示状態
  const [isSwitcherModalVisible, setIsSwitcherModalVisible] = useState(false);
  const [isJoinCodeModalVisible, setIsJoinCodeModalVisible] = useState(false);
  const [isSetTimerModalVisible, setIsSetTimerModalVisible] = useState(false);
  const [isAddSeatModalVisible, setIsAddSeatModalVisible] = useState(false);
  const [isAssignMainTimerModalVisible, setIsAssignMainTimerModalVisible] = useState(false);
  const [isProModalVisible, setIsProModalVisible] = useState(false);
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
  // ヘルプ担当指定モーダル用ScrollViewの参照
  const helpModalScrollViewRef = useRef(null);

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
            if (!oneMinuteHelpAlertRef.current[s.id]) {
              oneMinuteHelpAlertRef.current[s.id] = true;
              if (Platform.OS !== 'web') {
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
              if (!checkAlertedRef.current[s.id]) {
                checkAlertedRef.current[s.id] = true;
                if (Platform.OS !== 'web') {
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
          if (!timeUpTs) {
            timeUpTs = s.targetEndTimestamp;
            hasChanges = true;
            // 初回タイムアップ時の強い振動
            if (Platform.OS !== 'web') {
              Vibration.vibrate([0, 500, 200, 500, 200, 500]);
            }
          }

          const elapsedOverSec = Math.floor((currentNow - timeUpTs) / 1000);
          let escLevel = s.escalationLevel || 0;

          // ヘルプ確認（またはヘルプなし確認）に達していない場合の段階的エスカレーション
          const isConfirmed = isNoHelp || !s.assistantStaffName || s.assistantStaffConfirmed;

          // ① 30秒リマインド（強い振動）
          if (elapsedOverSec >= 30 && escLevel < 1 && !isConfirmed) {
            escLevel = 1;
            hasChanges = true;
            if (Platform.OS !== 'web') {
              Vibration.vibrate([0, 400, 150, 400]);
            }
          }
          // ② 1分リマインド（強い振動）
          else if (elapsedOverSec >= 60 && escLevel < 2 && !isConfirmed) {
            escLevel = 2;
            hasChanges = true;
            if (Platform.OS !== 'web') {
              Vibration.vibrate([0, 400, 150, 400, 150, 400]);
            }
          }
          // ③ 3分経過: 確認されない場合、サロン全員にチェックアラート発動！
          else if (elapsedOverSec >= 180 && escLevel < 3 && !isConfirmed) {
            escLevel = 3;
            hasChanges = true;
            if (Platform.OS !== 'web') {
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

  // サロン内で利用可能なスタッフ候補リスト（現在登録中のメンバー＋初期候補）
  const defaultSalonStaffs = ['タグチ', 'ヤマモト', '佐藤', '田中', '渡辺', '伊藤', '中村', '小林'];
  const salonStaffList = useMemo(() => {
    const list = new Set(defaultSalonStaffs);
    if (userName) list.add(userName);
    seats.forEach((s) => {
      if (s.colorStaffName) list.add(s.colorStaffName);
      if (s.assistantStaffName) list.add(s.assistantStaffName);
    });
    return Array.from(list);
  }, [userName, seats]);

  // 初期ロード
  useEffect(() => {
    loadInitialData();
  }, []);

  const loadInitialData = async () => {
    try {
      const savedName = await AsyncStorage.getItem('@assist_timer_user_name');
      if (savedName) setUserName(savedName);

      const savedFavs = await AsyncStorage.getItem('@salon_favorite_timer_presets');
      if (savedFavs) {
        const parsed = JSON.parse(savedFavs);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setFavoritePresets(parsed);
        }
      }

      // デモ用登録サロン一覧（本番サロン、別店舗、グループ、個人無料枠）
      const initialSalons = [
        {
          id: 'salon-01',
          name: 'LITT HAIR DESIGN 本店',
          type: 'salon', // 'salon' | 'group' | 'pair'
          inviteCode: '738-921',
          isPro: false,
          role: 'stylist',
          description: 'ペア無料枠 (2名参加中)',
        },
        {
          id: 'salon-02',
          name: 'LITT 表参道店 (ヘルプ先)',
          type: 'salon',
          inviteCode: '412-880',
          isPro: true,
          role: 'stylist',
          description: 'Proサロンプラン (8名参加中)',
        },
        {
          id: 'salon-03',
          name: '1F カラー・アシスタントチーム',
          type: 'group',
          inviteCode: 'GRP-101',
          isPro: true,
          role: 'assistant',
          description: 'フロア別グループ',
        },
        {
          id: 'salon-04',
          name: '田中 × ヤマモト ペア',
          type: 'pair',
          inviteCode: 'PAIR-55',
          isPro: false,
          role: 'stylist',
          description: '1対1 個人無料枠ペア',
        },
      ];
      setSavedSalons(initialSalons);
      setCurrentSalon(initialSalons[0]);

      // デモ用初期固定席マスター
      // 1番席: 稼働中, 2番席: 待機中(最小化), 3番席: シャンプー中(超過), 4番席: 待機中, 5番席: 待機中
      const initialSeats = [
        {
          id: 'seat-1',
          seatLabel: '1番席',
          status: 'running',
          colorStaffName: savedName || 'タグチ',
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
          comment: '',
          timeUpTimestamp: null,
          mainStaffConfirmed: true,
          assistantStaffConfirmed: false,
          sosTriggered: false,
          escalationLevel: 0,
          history: [
            { id: 'h-1-1', time: '14:15', text: '10分放置', type: 'timer' },
            { id: 'h-1-2', time: '14:25', text: '田口チェック', type: 'check' },
            { id: 'h-1-3', time: '18:49', text: 'ヤマモトチェック完了', type: 'check' },
            { id: 'h-1-4', time: '18:49', text: '20分放置 (チェック: 10分)', type: 'timer' },
          ],
        },
        {
          id: 'seat-2',
          seatLabel: '2番席',
          status: 'idle', // 待機中（最小化スリムバー）
          colorStaffName: '',
          assistantStaffName: null,
          isShampooing: false,
          targetSeconds: 0,
          initialMinutes: 0,
          targetEndTimestamp: 0,
          comment: '',
          timeUpTimestamp: null,
          mainStaffConfirmed: true,
          assistantStaffConfirmed: false,
          sosTriggered: false,
          escalationLevel: 0,
          history: [],
        },
        {
          id: 'seat-3',
          seatLabel: '3番席 (個室)',
          status: 'running',
          colorStaffName: '佐藤',
          assistantStaffName: '田中',
          isShampooing: true, // シャンプー中
          targetSeconds: 1500,
          initialMinutes: 22,
          targetEndTimestamp: Date.now() - 45 * 1000, // 超過45秒
          comment: 'トリートメント浸透中',
          timeUpTimestamp: Date.now() - 45 * 1000,
          mainStaffConfirmed: true,
          assistantStaffConfirmed: false,
          sosTriggered: false,
          escalationLevel: 1, // 30秒リマインド通過
          history: [
            { id: 'h-3-1', time: '13:55', text: '10分放置', type: 'timer' },
            { id: 'h-3-2', time: '14:05', text: '田口チェック', type: 'check' },
            { id: 'h-3-3', time: '14:10', text: '7分追加放置', type: 'extend' },
            { id: 'h-3-4', time: '14:17', text: '伊藤シャンプー', type: 'action' },
          ],
        },
        {
          id: 'seat-4',
          seatLabel: '4番席',
          status: 'running',
          colorStaffName: savedName || 'タグチ',
          assistantStaffName: 'タグチ',
          isShampooing: true,
          targetSeconds: 1200,
          initialMinutes: 20,
          targetEndTimestamp: Date.now() + 17 * 60 * 1000 + 24 * 1000, // 残り17分24秒
          checkTargetSeconds: 600, // 10分チェック
          checkInitialMinutes: 10,
          checkEndTimestamp: Date.now() + 7 * 60 * 1000 + 24 * 1000, // チェックまで残り7分24秒
          checkStatus: 'running',
          checkStaffName: 'タグチ',
          comment: '',
          timeUpTimestamp: null,
          mainStaffConfirmed: true,
          assistantStaffConfirmed: true,
          sosTriggered: false,
          escalationLevel: 0,
          history: [
            { id: 'h-4-1', time: '18:36', text: '20分放置 (チェック: 10分)', type: 'timer' },
          ],
        },
        {
          id: 'seat-5',
          seatLabel: '5番席 (シャンプー台)',
          status: 'idle', // 待機中
          colorStaffName: '',
          assistantStaffName: null,
          isShampooing: false,
          targetSeconds: 0,
          initialMinutes: 0,
          targetEndTimestamp: 0,
          comment: '',
          timeUpTimestamp: null,
          mainStaffConfirmed: true,
          assistantStaffConfirmed: false,
          sosTriggered: false,
          escalationLevel: 0,
          history: [],
        },
      ];
      setSeats(initialSeats);
    } catch (e) {
      console.warn('Failed to load initial salon data', e);
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
      setSeats((prev) =>
        prev.map((s) => ({
          ...s,
          colorStaffName: s.colorStaffName === oldName ? trimmed : s.colorStaffName,
          assistantStaffName: s.assistantStaffName === oldName ? trimmed : s.assistantStaffName,
        }))
      );

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

  // サロン・グループ切り替え
  const handleSelectSalon = (salon) => {
    setCurrentSalon(salon);
    setIsSwitcherModalVisible(false);
  };

  // 招待コードで新規参加
  const handleJoinByCode = () => {
    const code = inputInviteCode.trim();
    if (!code) {
      Alert.alert('入力エラー', '招待コードを入力してください');
      return;
    }
    const newSalonItem = {
      id: `salon-${Date.now()}`,
      name: inputSalonName.trim() || `サロン (${code})`,
      type: 'salon',
      inviteCode: code,
      isPro: false,
      role: 'assistant',
      description: 'コード参加サロン',
    };
    setSavedSalons((prev) => [newSalonItem, ...prev]);
    setCurrentSalon(newSalonItem);
    setIsJoinCodeModalVisible(false);
    setInputInviteCode('');
    setInputSalonName('');
    Alert.alert('参加完了', `「${newSalonItem.name}」に接続しました！`);
  };

  // ★ ユーザー指定: タイム設定モーダルでの席名変更の保存
  const handleSaveSeatLabel = () => {
    const trimmed = (modalSeatLabel || '').trim() || '席';
    setModalSeatLabel(trimmed);
    setIsEditingSeatLabel(false);
    if (targetSeatId) {
      setSeats((prev) =>
        prev.map((s) => (s.id === targetSeatId ? { ...s, seatLabel: trimmed } : s))
      );
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
    setSeats((prev) =>
      prev.map((s) => {
        if (s.id !== seat.id) return s;
        const remaining = Math.max(0, Math.floor((s.targetEndTimestamp - Date.now()) / 1000));
        const prevHistory = s.history || [];
        return {
          ...s,
          status: 'paused',
          pausedRemainingSeconds: remaining,
          actionStatus: determinedActionId || null,
          isShampooing: determinedActionId === 'shampoo',
          mainStaffConfirmed: true,
          assistantStaffConfirmed: true,
          stoppedBy: currentUser,
          history: [...prevHistory, historyItem],
        };
      })
    );

    // 強い確認振動
    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 250, 100, 250]);
    }

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

    setSeats((prev) =>
      prev.map((s) => {
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
      })
    );

    if (Platform.OS !== 'web') {
      Vibration.vibrate([0, 150, 80, 150]);
    }

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
            assistantStaffName: s.assistantStaffName || null,
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
            assistantStaffName: s.assistantStaffName || null,
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
            assistantStaffName: s.assistantStaffName || null,
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
          assistantStaffName: s.assistantStaffName || null,
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

    setSeats((prev) =>
      prev.map((s) => {
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
      })
    );

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
              setSeats((prev) => prev.filter((s) => s.id !== seatId));
            } else {
              setSeats((prev) =>
                prev.map((s) => {
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
                })
              );
            }
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
    setSeats((prev) => [...prev, newSeat]);
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
              {currentSalon?.type === 'pair' ? '個人無料枠' : currentSalon?.description || 'オンライン中'}
            </Text>
            {currentSalon?.isPro ? (
              <View style={[styles.proBadge, { backgroundColor: '#FFD700' }]}>
                <Text style={styles.proBadgeText}>PRO</Text>
              </View>
            ) : (
              <View style={[styles.freeBadge, { backgroundColor: theme.accentLight, borderColor: theme.accentBorder }]}>
                <Text style={[styles.freeBadgeText, { color: theme.accent }]}>無料</Text>
              </View>
            )}
          </View>
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
                        backgroundColor: item.assistantStaffName === 'ヘルプなし'
                          ? (isEcoMode ? '#2C2C2E' : '#F3F4F6')
                          : item.assistantStaffName
                          ? theme.accentLight
                          : (isEcoMode ? '#2C2C2E' : '#FFF7ED'),
                        borderColor: item.assistantStaffName === 'ヘルプなし'
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
                          color: item.assistantStaffName === 'ヘルプなし'
                            ? theme.textSecondary
                            : item.assistantStaffName
                            ? theme.accent
                            : '#EA580C',
                        },
                      ]}
                    >
                      {item.assistantStaffName === 'ヘルプなし'
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
        onRequestClose={() => setIsSwitcherModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.cardBg }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>
                ワークスペースの切り替え
              </Text>
              <TouchableOpacity onPress={() => setIsSwitcherModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

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
              <Text style={[styles.sheetSectionTitle, { color: theme.textSecondary }]}>参加中のサロン・グループ</Text>
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
                      <View>
                        <Text style={[styles.salonSelectName, { color: theme.textPrimary }]}>
                          {salon.name}
                        </Text>
                        <Text style={[styles.salonSelectDesc, { color: theme.textSecondary }]}>
                          {salon.description} • コード: {salon.inviteCode}
                        </Text>
                      </View>
                    </View>
                    {isSelected ? (
                      <Ionicons name="checkmark-circle" size={20} color={theme.accent} />
                    ) : null}
                  </TouchableOpacity>
                );
              })}
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
              <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>PRO サロンプランのご案内</Text>
              <TouchableOpacity onPress={() => setIsProModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.proModalContent}>
              <Ionicons name="people-circle" size={54} color={theme.accent} style={{ alignSelf: 'center', marginBottom: 10 }} />
              <Text style={[styles.proModalText, { color: theme.textPrimary }]}>
                1対1のペア共有は<Text style={{ fontWeight: 'bold', color: theme.success }}>完全無料</Text>で無期限にご利用いただけます。
              </Text>
              <Text style={[styles.proModalSubText, { color: theme.textSecondary }]}>
                3人以上のスタッフで店舗全体・複数フロアをリアルタイム共有する場合は、オーナーがProサロンプランにご登録いただくことで、全スタッフが無制限に同一サロンボードへ参加・同期可能になります。
              </Text>
            </View>

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
});
