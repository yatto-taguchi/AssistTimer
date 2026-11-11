import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { dispatchSalonTimerEventPush } from './pushNotificationService';

const _lastKnownCloudSeatBySalonKey = new Map();

const buildSalonSeatCacheKeys = (salonId, seat) => {
  const keys = [];
  if (!salonId || !seat || typeof seat !== 'object') return keys;
  const sid = String(salonId).trim();
  const id = String(seat.cloudTimerId || seat.id || '').trim();
  if (id) keys.push(`${sid}|id:${id}`);
  const num = Number(seat.seatNumber || 0);
  if (Number.isInteger(num) && num > 0) keys.push(`${sid}|num:${num}`);
  const lbl = String(seat.seatLabel || seat.seat_label || seat.name || '')
    .replace(/\s*[\(（]サンプル[\)）]/g, '')
    .replace(/席$/, '')
    .trim();
  if (lbl) keys.push(`${sid}|lbl:${lbl}`);
  return keys;
};

const getLastKnownCloudSeat = (salonId, seat) => {
  const keys = buildSalonSeatCacheKeys(salonId, seat);
  for (const k of keys) {
    if (_lastKnownCloudSeatBySalonKey.has(k)) {
      return _lastKnownCloudSeatBySalonKey.get(k);
    }
  }
  return null;
};

const setLastKnownCloudSeat = (salonId, seat) => {
  if (!salonId || !seat || typeof seat !== 'object') return;
  const snapshot = { ...seat };
  const keys = buildSalonSeatCacheKeys(salonId, snapshot);
  for (const k of keys) {
    _lastKnownCloudSeatBySalonKey.set(k, snapshot);
  }
};

const USER_ID_KEY = '@assist_timer_user_id';
let _cachedLocalUserId = null;

/**
 * 端末固有の一意UUIDを生成または取得
 */
export const getOrCreateUserId = async () => {
  if (_cachedLocalUserId) return _cachedLocalUserId;
  try {
    let uid = await AsyncStorage.getItem(USER_ID_KEY);
    if (!uid) {
      uid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      await AsyncStorage.setItem(USER_ID_KEY, uid);
    }
    _cachedLocalUserId = uid;
    return uid;
  } catch (e) {
    console.warn('Failed to getOrCreateUserId', e);
    return 'user-' + Date.now();
  }
};

export const isValidUUID = (val) =>
  typeof val === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

/**
 * 共有コード・招待コードの共通正規化関数（全角英数の半角化、各種ハイフン統一、空白除去、6桁数字の XXX-XXX 自動整形）
 */
export const normalizeInviteCode = (input) => {
  if (!input) return '';
  let s = String(input).replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/[\s\u3000]+/g, '').toUpperCase();
  s = s.replace(/[ー−―‐—ｰ〜~]/g, '-');
  if (/^\d{6}$/.test(s)) {
    s = `${s.slice(0, 3)}-${s.slice(3)}`;
  }
  return s;
};

// UIのプレースホルダー（入力例）やダミー文字列として予約し、実サロンコードとしての生成・変更保存・参加を禁止するコード群
export const DUMMY_EXAMPLE_INVITE_CODES = new Set([
  '000-000',
  '000000',
  'XXX-XXX',
  'XXXXXX',
  'ABC-DEF',
  'ABCDEF',
  '123-456',
  '123456',
]);

// 過去ビルドでプレースホルダーやテスト固定値として露出していたコード群（新規生成から完全除外し、オーナー端末の同期時に自動で新しいランダムコードへローテーション）
export const LEGACY_EXPOSED_INVITE_CODES = new Set([
  'FREE-01',
  '358-220',
  '738-921',
  '888-999',
]);

export const isDummyExampleInviteCode = (code) => {
  const clean = normalizeInviteCode(code);
  if (!clean) return false;
  if (DUMMY_EXAMPLE_INVITE_CODES.has(clean)) return true;
  const digitsOnly = clean.replace(/-/g, '');
  if (/^0+$/.test(digitsOnly)) return true;
  if (/^(\d)\1{5}$/.test(digitsOnly)) return true;
  return false;
};

export const isLegacyExposedInviteCode = (code) => {
  const clean = normalizeInviteCode(code);
  return !!clean && LEGACY_EXPOSED_INVITE_CODES.has(clean);
};

const getSecureRandomInt = (maxExclusive) => {
  try {
    if (
      typeof globalThis !== 'undefined' &&
      globalThis.crypto &&
      typeof globalThis.crypto.getRandomValues === 'function'
    ) {
      const arr = new Uint32Array(1);
      globalThis.crypto.getRandomValues(arr);
      return arr[0] % maxExclusive;
    }
  } catch (e) {
    // Math.random フォールバック
  }
  return Math.floor(Math.random() * maxExclusive);
};

/**
 * ランダムな6桁（100〜999 - 100〜999）の安全な招待コード生成関数
 * 入力例（000-000 等）・単純ゾロ目・過去ビルド露出コード（358-220 等）を完全除外
 */
export const generateRandomInviteCode = () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const part1 = 100 + getSecureRandomInt(900); // 100〜999
    const part2 = 100 + getSecureRandomInt(900); // 100〜999
    if (part1 === part2) continue;
    const candidate = `${part1}-${part2}`;
    if (!isDummyExampleInviteCode(candidate) && !isLegacyExposedInviteCode(candidate)) {
      return candidate;
    }
  }
  const fallback1 = 100 + ((Date.now() + Math.floor(Math.random() * 899)) % 900);
  const fallback2 = 100 + ((Math.floor(Math.random() * 899) + 37) % 900);
  return `${fallback1}-${fallback2}`;
};

/**
 * Supabaseクラウド上で未使用のランダム招待コードを取得
 */
const findUnusedRandomInviteCode = async (maxAttempts = 8) => {
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = generateRandomInviteCode();
    const { data: conflict, error } = await supabase
      .from('salons')
      .select('id')
      .eq('invite_code', candidate)
      .maybeSingle();
    if (!error && !conflict) {
      return candidate;
    }
  }
  return generateRandomInviteCode();
};

/**
 * サロン・招待コードをSupabaseクラウドに登録（または既存を取得）
 * - salonId(UUID)が既知の場合はまずIDで検索し、招待コード変更後の再起動でも同一サロンを確実に維持する
 * - オーナー自身のサロンが過去の例文露出コード・ダミーコードだった場合は、席とメンバーを維持したまま自動で未使用ランダムコードへローテーションする
 * - 新規サロン作成時に万一コードが他ユーザーのサロンと衝突した場合は、絶対に他人のサロンへ混入させず新しい未使用コードを再発行して独立作成する
 * - allowCreate === false（ゲスト参加サロン）の場合は、サロン未発見時に勝手な新規空サロン作成を行わない
 */
export const syncOrCreateSalonInCloud = async ({
  salonId = null,
  salonName,
  inviteCode,
  isPro,
  userName,
  allowCreate = true,
}) => {
  const hasValidSalonId = isValidUUID(salonId);
  if (!inviteCode && !hasValidSalonId && allowCreate === false) return null;
  const userId = await getOrCreateUserId();
  let cleanCode = normalizeInviteCode(inviteCode);

  try {
    let salonData = null;

    if (hasValidSalonId) {
      const { data: existingById, error: idErr } = await supabase
        .from('salons')
        .select('*')
        .eq('id', salonId)
        .maybeSingle();
      if (idErr) {
        console.warn('Error searching salon by id:', idErr);
      }
      if (existingById) {
        salonData = existingById;
        const currentCloudCode = normalizeInviteCode(salonData.invite_code);
        if (
          salonData.owner_user_id === userId &&
          (!currentCloudCode ||
            isDummyExampleInviteCode(currentCloudCode) ||
            isLegacyExposedInviteCode(currentCloudCode))
        ) {
          const rotatedCode = await findUnusedRandomInviteCode();
          const { data: rotatedSalon, error: rotateErr } = await supabase
            .from('salons')
            .update({ invite_code: rotatedCode })
            .eq('id', salonData.id)
            .select()
            .single();
          if (!rotateErr && rotatedSalon) {
            salonData = rotatedSalon;
          }
        }
      }
    }

    if (!salonData && cleanCode) {
      if (allowCreate === false) {
        const { data: existing, error: searchErr } = await supabase
          .from('salons')
          .select('*')
          .eq('invite_code', cleanCode)
          .maybeSingle();
        if (searchErr) {
          console.warn('Error searching salon by code:', searchErr);
        }
        salonData = existing;
      } else if (!isDummyExampleInviteCode(cleanCode) && !isLegacyExposedInviteCode(cleanCode)) {
        const { data: existing, error: searchErr } = await supabase
          .from('salons')
          .select('*')
          .eq('invite_code', cleanCode)
          .maybeSingle();
        if (searchErr) {
          console.warn('Error searching salon by code:', searchErr);
        }
        if (existing) {
          if (existing.owner_user_id === userId) {
            salonData = existing;
          } else {
            // 他ユーザーのサロンとコードが偶然衝突した場合は絶対に合流せず新しい未使用コードへ差し替える
            cleanCode = '';
          }
        }
      } else {
        cleanCode = '';
      }
    }

    if (!salonData) {
      if (allowCreate === false) {
        return null;
      }
      let candidateCode =
        cleanCode && !isDummyExampleInviteCode(cleanCode) && !isLegacyExposedInviteCode(cleanCode)
          ? cleanCode
          : await findUnusedRandomInviteCode();

      for (let attempt = 0; attempt < 4 && !salonData; attempt += 1) {
        const { data: created, error: insertErr } = await supabase
          .from('salons')
          .insert({
            name: salonName || 'サロン',
            owner_user_id: userId,
            invite_code: candidateCode,
            is_pro: !!isPro,
          })
          .select()
          .single();

        if (!insertErr && created) {
          salonData = created;
          break;
        }
        console.warn('Error creating salon (retrying with fresh code):', insertErr);
        candidateCode = await findUnusedRandomInviteCode();
      }
    }

    if (!salonData) return null;

    const isOwner = salonData.owner_user_id === userId;
    if (isOwner) {
      await supabase
        .from('salon_members')
        .upsert(
          {
            salon_id: salonData.id,
            user_id: userId,
            display_name: (userName || 'スタイリスト').trim(),
            role: 'owner',
          },
          { onConflict: 'salon_id,user_id' }
        );
    } else {
      // ゲスト起動時: すでにオーナー側からメンバー解除（削除）されている場合は勝手に再登録せず解除状態を返す
      const { data: existingMember, error: memberCheckErr } = await supabase
        .from('salon_members')
        .select('id, display_name, role')
        .eq('salon_id', salonData.id)
        .eq('user_id', userId)
        .maybeSingle();

      if (!memberCheckErr && !existingMember) {
        return { ...salonData, _removedFromMembers: true };
      }

      const trimmedName = (userName || '').trim();
      if (existingMember && trimmedName && existingMember.display_name !== trimmedName) {
        await supabase
          .from('salon_members')
          .update({ display_name: trimmedName })
          .eq('id', existingMember.id);
      }
    }

    return salonData;
  } catch (e) {
    console.warn('syncOrCreateSalonInCloud failed:', e);
    return null;
  }
};

/**
 * 既存サロンの招待コードを更新（オーナー専用：既存の席と参加メンバーを維持したままコードのみ変更）
 */
export const updateSalonInviteCode = async ({ salonId, newInviteCode }) => {
  if (!isValidUUID(salonId) || !newInviteCode) return null;
  const cleanCode = normalizeInviteCode(newInviteCode);
  if (!cleanCode) {
    throw new Error('招待コードを入力してください');
  }
  if (isDummyExampleInviteCode(cleanCode)) {
    throw new Error('入力例（000-000 などのサンプルコード）は設定できません。別の招待コードを指定してください。');
  }

  const { data: conflict, error: conflictErr } = await supabase
    .from('salons')
    .select('id')
    .eq('invite_code', cleanCode)
    .neq('id', salonId)
    .maybeSingle();

  if (conflictErr) {
    throw new Error(`招待コードの確認に失敗しました: ${conflictErr.message}`);
  }
  if (conflict) {
    throw new Error('この招待コードは既に使用されています。別のコードを指定してください。');
  }

  const { data: updated, error: updateErr } = await supabase
    .from('salons')
    .update({ invite_code: cleanCode })
    .eq('id', salonId)
    .select()
    .single();

  if (updateErr) {
    throw new Error(`招待コードの更新に失敗しました: ${updateErr.message}`);
  }
  return updated;
};

/**
 * 招待コードでサロンを検索して参加登録する
 */
export const joinSalonByInviteCode = async ({ inviteCode, userName }) => {
  if (!inviteCode) {
    throw new Error('招待コードを入力してください');
  }

  const userId = await getOrCreateUserId();
  const cleanCode = normalizeInviteCode(inviteCode);
  if (!cleanCode) {
    throw new Error('招待コードを入力してください');
  }
  if (isDummyExampleInviteCode(cleanCode)) {
    throw new Error('「000-000」などのサンプル番号は入力例です。親端末に表示されている実際の招待コードを入力してください。');
  }

  const { data: salon, error: searchErr } = await supabase
    .from('salons')
    .select('*')
    .eq('invite_code', cleanCode)
    .maybeSingle();

  if (searchErr) {
    throw new Error(`サロンの検索に失敗しました: ${searchErr.message}`);
  }

  if (!salon) {
    throw new Error('該当するサロンが見つかりませんでした。招待コードをご確認ください。');
  }

  const role = salon.owner_user_id === userId ? 'owner' : 'assistant';
  const { error: joinErr } = await supabase
    .from('salon_members')
    .upsert(
      {
        salon_id: salon.id,
        user_id: userId,
        display_name: (userName || 'アシスタント').trim(),
        role: role,
      },
      { onConflict: 'salon_id,user_id' }
    );

  if (joinErr) {
    throw new Error(`メンバー登録に失敗しました: ${joinErr.message}`);
  }

  const members = await fetchSalonMembers(salon.id);
  return { salon, members };
};

/**
 * サロンに所属するメンバー一覧を取得
 */
export const fetchSalonMembers = async (salonId, options = {}) => {
  const { returnNullOnError = false } = options || {};
  if (!salonId) return [];
  try {
    const { data, error } = await supabase
      .from('salon_members')
      .select('*')
      .eq('salon_id', salonId)
      .order('joined_at', { ascending: true });

    if (error) {
      console.warn('fetchSalonMembers error:', error);
      return returnNullOnError ? null : [];
    }
    return data || [];
  } catch (e) {
    console.warn('fetchSalonMembers failed:', e);
    return returnNullOnError ? null : [];
  }
};

/**
 * サロンメンバーをクラウド（salon_members）から削除・連携解除
 */
export const deleteSalonMember = async ({ salonId, cloudMemberId = null, targetUserId = null }) => {
  if (!isValidUUID(salonId) || (!cloudMemberId && !targetUserId)) return false;
  try {
    let deletedAny = false;
    let resolvedTargetUserId = targetUserId && !String(targetUserId).startsWith('mem_') ? String(targetUserId) : null;
    if (isValidUUID(cloudMemberId)) {
      if (!resolvedTargetUserId) {
        try {
          const { data: memberRow } = await supabase
            .from('salon_members')
            .select('user_id')
            .eq('salon_id', salonId)
            .eq('id', cloudMemberId)
            .maybeSingle();
          if (memberRow?.user_id) {
            resolvedTargetUserId = String(memberRow.user_id);
          }
        } catch {}
      }
      const { error } = await supabase
        .from('salon_members')
        .delete()
        .eq('salon_id', salonId)
        .eq('id', cloudMemberId);
      if (error) {
        console.warn('deleteSalonMember by id error:', error);
        return false;
      }
      deletedAny = true;
    }
    if (targetUserId && !String(targetUserId).startsWith('mem_')) {
      const { error } = await supabase
        .from('salon_members')
        .delete()
        .eq('salon_id', salonId)
        .eq('user_id', String(targetUserId));
      if (error) {
        console.warn('deleteSalonMember by user_id error:', error);
        return deletedAny;
      }
      deletedAny = true;
    }
    if (deletedAny && resolvedTargetUserId) {
      try {
        await supabase
          .from('salon_member_push_tokens')
          .delete()
          .eq('salon_id', salonId)
          .eq('user_id', resolvedTargetUserId);
      } catch {}
    }
    return deletedAny;
  } catch (e) {
    console.warn('deleteSalonMember failed:', e);
    return false;
  }
};

/**
 * サロンメンバーの変更をリアルタイム（Realtime WebSocket）で監視
 */
export const subscribeSalonMembers = (salonId, onMembersChange) => {
  if (!salonId) return () => {};

  const channel = supabase
    .channel(`salon_members_${salonId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'salon_members',
        filter: `salon_id=eq.${salonId}`,
      },
      async (payload) => {
        const updatedMembers = await fetchSalonMembers(salonId, { returnNullOnError: true });
        if (Array.isArray(updatedMembers) && typeof onMembersChange === 'function') {
          onMembersChange(updatedMembers, payload);
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
};

/**
 * メンバー表示名の更新（自分のニックネーム変更、またはオーナーによるメンバー呼び名のクラウド同期）
 */
export const updateMemberDisplayName = async ({
  salonId,
  displayName,
  targetUserId = null,
  cloudMemberId = null,
}) => {
  if (!salonId || !displayName) return;
  const trimmed = displayName.trim();
  if (!trimmed) return;
  try {
    if (cloudMemberId && isValidUUID(cloudMemberId)) {
      await supabase
        .from('salon_members')
        .update({ display_name: trimmed })
        .eq('salon_id', salonId)
        .eq('id', cloudMemberId);
      return;
    }
    const resolvedUserId =
      targetUserId && !String(targetUserId).startsWith('mem_')
        ? String(targetUserId)
        : await getOrCreateUserId();
    if (!resolvedUserId) return;
    await supabase
      .from('salon_members')
      .update({ display_name: trimmed })
      .eq('salon_id', salonId)
      .eq('user_id', resolvedUserId);
  } catch (e) {
    console.warn('updateMemberDisplayName failed:', e);
  }
};

// ============================================================================
// ★ 客席タイマー（salon_timers）クラウド同期機能
// ============================================================================

const ACTION_ID_TO_LABEL = {
  call: '呼び出し',
  combing: 'コーミング',
  check: 'チェック',
  shampoo: 'シャンプー',
  other: 'その他',
};

const LABEL_TO_ACTION_ID = {
  呼び出し: 'call',
  コーミング: 'combing',
  チェック: 'check',
  シャンプー: 'shampoo',
  その他: 'other',
  call: 'call',
  combing: 'combing',
  check: 'check',
  shampoo: 'shampoo',
  other: 'other',
};

/**
 * ローカルのSeatItemをクラウドsalon_timersのレコード形式にマッピング
 */
export const mapSeatToCloudTimer = (seat, salonId, userId) => {
  const rawLabel = (seat.seatLabel || seat.name || '1番席').trim();
  const seatLabel = rawLabel.replace(/\s*[\(（]サンプル[\)）]/g, '').trim() || '1番席';
  const rawTargetEndTs = Math.round(Number(seat.targetEndTimestamp || 0));
  const rawPausedRemSec = Math.round(Number(seat.pausedRemainingSeconds || 0));
  const isStoppedZero =
    seat.status !== 'running' &&
    (!!seat.isReset || (rawPausedRemSec <= 0 && rawTargetEndTs <= 0));
  const rawTargetSecVal =
    seat.targetSeconds !== undefined && seat.targetSeconds !== null
      ? Number(seat.targetSeconds)
      : Number(seat.targetTime || 0);
  const targetSeconds = isStoppedZero ? 0 : Math.max(0, Math.round(rawTargetSecVal || 0));
  const rawCheckSec = isStoppedZero ? 0 : Math.round(Number(seat.checkTargetSeconds || seat.checkTotalSeconds || 0));
  const checkPausedRem = isStoppedZero ? 0 : Math.round(Number(seat.checkPausedRemainingSeconds || 0));
  const hasRunningCheck =
    !isStoppedZero &&
    (seat.checkStatus === 'running' || seat.checkStatus === 'timeup') &&
    (Number(seat.checkEndTimestamp) > 0 || checkPausedRem > 0);
  const isCheckDone = !isStoppedZero && !hasRunningCheck && (seat.checkStatus === 'completed' || !!seat.isCheckCompleted);
  const checkTotalSeconds = isStoppedZero
    ? 0
    : isCheckDone
    ? (rawCheckSec > 0 ? rawCheckSec : Math.max(60, Math.round(Number(seat.checkInitialMinutes || 1) * 60)))
    : (seat.checkStatus === 'stopped' && !seat.checkEndTimestamp && checkPausedRem <= 0 ? 0 : rawCheckSec);
  const targetEndTs = isStoppedZero ? 0 : rawTargetEndTs;
  const pausedRemSec = isStoppedZero ? 0 : rawPausedRemSec;
  const checkEndTs = !isStoppedZero && !isCheckDone
    ? (seat.checkEndTimestamp
        ? Math.round(Number(seat.checkEndTimestamp))
        : (checkPausedRem > 0 ? Date.now() + checkPausedRem * 1000 : null))
    : null;

  const isShampooing =
    !!seat.isShampooing || (seat.status !== 'running' && seat.actionStatus === 'shampoo');
  const actionLabel = seat.actionStatus ? (ACTION_ID_TO_LABEL[seat.actionStatus] || seat.actionStatus) : '';
  const resolvedHelpProcess =
    actionLabel || seat.helpProcess || (isShampooing ? 'シャンプー' : null);
  const resolvedAssistant = seat.isRecruiting
    ? '募集中'
    : (seat.isNoHelpNeeded ? 'ヘルプなし' : (seat.assistantStaffName || null));

  const resolvedSortOrder =
    typeof seat.sortOrder === 'number' && seat.sortOrder > 0
      ? Math.round(seat.sortOrder)
      : (Number(seat.seatNumber) > 0 ? Math.round(Number(seat.seatNumber)) : 0);

  const isIdleEmpty = (seat.status === 'idle') && !seat.colorStaffName;
  const trimmedCreatedBy = String(seat.createdBy || '').trim();
  // ★ タイマー停止・リセット・施術終了(idle)時に、停止操作者の userId で元の主担当(created_by)が上書きされないよう保護。
  //   稼働開始(status === 'running')かつ createdBy 未設定時のみ操作者の userId をフォールバック使用する。
  //   ※ createdBy 未設定の既存席を停止・リセットする場合は UPDATE クエリ側で created_by カラム自体を省略し、
  //     PostgreSQL の NOT NULL 制約違反 (23502) を回避しつつ DB 上の既存 created_by を保持する。
  const resolvedCreatedBy = trimmedCreatedBy
    ? trimmedCreatedBy
    : (seat.status === 'running' ? (userId || 'unknown') : null);

  return {
    salon_id: salonId,
    seat_label: seatLabel,
    color_staff_name: isIdleEmpty ? '' : (seat.colorStaffName || 'スタッフ'),
    assistant_staff_name: resolvedAssistant,
    help_process: resolvedHelpProcess,
    is_shampooing: isShampooing,
    status: seat.status || 'idle',
    target_seconds: targetSeconds,
    target_end_timestamp: targetEndTs,
    paused_remaining_seconds: pausedRemSec,
    comment: seat.comment || null,
    sort_order: resolvedSortOrder,
    created_by: resolvedCreatedBy,
    updated_by: userId || null,
    check_target_end_timestamp: checkEndTs,
    check_total_seconds: checkTotalSeconds > 0 ? checkTotalSeconds : null,
    check_process: seat.checkProcess || null,
    check_staff_name: seat.checkStaffName || seat.checkStaff || null,
    updated_at: new Date().toISOString(),
  };
};

/**
 * クラウドsalon_timersのレコードをローカルSeatItem形式にマッピング
 */
export const mapCloudTimerToSeat = (cloudTimer, index = null) => {
  const rawName = cloudTimer.seat_label || '1番席';
  const name = String(rawName).replace(/\s*[\(（]サンプル[\)）]/g, '').trim() || '1番席';
  const rawTargetSeconds = Math.round(Number(cloudTimer.target_seconds || 0));
  const checkSec = cloudTimer.check_total_seconds ? Math.round(Number(cloudTimer.check_total_seconds)) : 0;
  const checkEndTs = cloudTimer.check_target_end_timestamp ? Math.round(Number(cloudTimer.check_target_end_timestamp)) : null;
  const status = cloudTimer.status || 'idle';
  const rawTargetEndTs = Math.round(Number(cloudTimer.target_end_timestamp || 0));
  const rawPausedRemSec = Math.round(Number(cloudTimer.paused_remaining_seconds || 0));
  const hasActiveCheck = checkSec > 0 && checkEndTs && checkEndTs > 0;
  const isCheckCompleted = !hasActiveCheck && checkSec > 0;
  const numMatch = String(name).match(/\d+/);
  const sortOrderNum = Number(cloudTimer.sort_order);
  const seatNumber = numMatch
    ? parseInt(numMatch[0], 10)
    : (sortOrderNum > 0
        ? Math.round(sortOrderNum)
        : (typeof index === 'number' ? index + 1 : 0));

  const rawAssist = cloudTimer.assistant_staff_name || '';
  const isRecruiting = rawAssist === '募集中';
  const isNoHelpNeeded = rawAssist === 'ヘルプなし' || rawAssist === 'none';
  const assistantStaffName = isRecruiting ? '' : rawAssist;
  const helpProcess = cloudTimer.help_process || '';
  const isShampooing = !!cloudTimer.is_shampooing;
  const actionStatus = isShampooing
    ? 'shampoo'
    : status !== 'running' && helpProcess === 'シャンプー'
    ? null
    : (LABEL_TO_ACTION_ID[helpProcess] || null);
  const rawComment = String(cloudTimer.comment || '').trim();
  const nowMs = Date.now();
  const abandonedCutoffMs = nowMs - 3 * 3600 * 1000;
  // 終了時刻が無効、または3時間以上前の古い放置稼働データは00:00待機状態へ正規化し、無限超過カウントアップを防止
  const isAbandonedRunningSeat =
    status === 'running' &&
    (rawTargetEndTs <= 0 || rawTargetEndTs <= abandonedCutoffMs);
  const isLegacySampleSeat =
    status !== 'running' &&
    (rawComment === 'タップして操作・編集できます' ||
      (status === 'paused' &&
        rawTargetSeconds === 1200 &&
        rawPausedRemSec === 1200 &&
        rawTargetEndTs <= 0 &&
        !rawAssist &&
        !helpProcess &&
        !isShampooing &&
        checkSec <= 0));

  const shouldForceIdleZero = isLegacySampleSeat || isAbandonedRunningSeat;
  const targetSeconds = shouldForceIdleZero ? 0 : rawTargetSeconds;
  const targetEndTs = shouldForceIdleZero ? 0 : rawTargetEndTs;
  const pausedRemSec = shouldForceIdleZero ? 0 : rawPausedRemSec;
  const normalizedStatus = shouldForceIdleZero ? 'idle' : status;
  const isReset =
    shouldForceIdleZero || ((normalizedStatus === 'paused' || normalizedStatus === 'idle') && pausedRemSec <= 0 && targetEndTs <= 0);
  const effectiveCheckSec = shouldForceIdleZero ? 0 : checkSec;
  const effectiveCheckEndTs = shouldForceIdleZero ? null : checkEndTs;
  const effectiveHasActiveCheck = !shouldForceIdleZero && hasActiveCheck;
  const effectiveIsCheckCompleted = !shouldForceIdleZero && isCheckCompleted;
  const isOver = normalizedStatus === 'running' && targetEndTs > 0 && targetEndTs <= nowMs;
  const elapsedOverSec = isOver ? Math.floor((nowMs - targetEndTs) / 1000) : 0;
  const initialEscalationLevel = !isOver
    ? 0
    : elapsedOverSec >= 195
    ? 3
    : elapsedOverSec >= 75
    ? 2
    : elapsedOverSec >= 45
    ? 1
    : 0;
  const checkPausedRemainingSeconds =
    normalizedStatus === 'paused' && effectiveHasActiveCheck
      ? Math.max(0, Math.round((effectiveCheckEndTs - nowMs) / 1000))
      : null;
  const isCleanEmptyIdleSeat =
    shouldForceIdleZero ||
    (normalizedStatus === 'idle' &&
      isReset &&
      !cloudTimer.color_staff_name &&
      !rawAssist &&
      !helpProcess &&
      !isShampooing &&
      !effectiveHasActiveCheck &&
      !cloudTimer.check_staff_name);

  return {
    id: cloudTimer.id,
    cloudTimerId: cloudTimer.id,
    seatNumber: seatNumber,
    seatLabel: name,
    name: name,
    targetSeconds: targetSeconds,
    targetTime: targetSeconds,
    initialMinutes: targetSeconds > 0 ? Math.max(1, Math.round(targetSeconds / 60)) : 0,
    targetEndTimestamp: targetEndTs,
    pausedRemainingSeconds: pausedRemSec,
    status: normalizedStatus,
    isReset: isReset,
    isLegacySampleSeat: isLegacySampleSeat,
    isAbandonedRunningSeat: isAbandonedRunningSeat,
    isOver: isOver,
    timeUpTimestamp: isOver ? targetEndTs : null,
    escalationLevel: initialEscalationLevel,
    colorStaffName:
      isCleanEmptyIdleSeat
        ? ''
        : (cloudTimer.color_staff_name || 'スタッフ'),
    assistantStaffName: shouldForceIdleZero ? '' : assistantStaffName,
    helpProcess: shouldForceIdleZero ? '' : helpProcess,
    actionStatus: shouldForceIdleZero ? null : actionStatus,
    isShampooing: shouldForceIdleZero ? false : isShampooing,
    isRecruiting: shouldForceIdleZero ? false : isRecruiting,
    isNoHelpNeeded: shouldForceIdleZero ? false : isNoHelpNeeded,
    comment: isLegacySampleSeat ? '' : (cloudTimer.comment || ''),
    sortOrder: cloudTimer.sort_order || 0,
    createdBy: isCleanEmptyIdleSeat ? null : (cloudTimer.created_by || null),
    updatedBy: cloudTimer.updated_by || null,
    checkEndTimestamp: effectiveCheckEndTs,
    checkPausedRemainingSeconds: checkPausedRemainingSeconds,
    checkTargetSeconds: effectiveCheckSec > 0 ? effectiveCheckSec : null,
    checkTotalSeconds: effectiveCheckSec > 0 ? effectiveCheckSec : null,
    checkInitialMinutes: effectiveCheckSec > 0 ? Math.max(1, Math.round(effectiveCheckSec / 60)) : null,
    checkProcess: shouldForceIdleZero ? 'チェック' : (cloudTimer.check_process || 'チェック'),
    checkStaffName: shouldForceIdleZero ? '' : (cloudTimer.check_staff_name || ''),
    checkStaff: shouldForceIdleZero ? '' : (cloudTimer.check_staff_name || ''),
    checkStatus: effectiveHasActiveCheck
      ? (normalizedStatus === 'running' && effectiveCheckEndTs <= nowMs ? 'timeup' : 'running')
      : (effectiveIsCheckCompleted ? 'completed' : 'stopped'),
    isCheckCompleted: effectiveIsCheckCompleted,
    history: [],
    updatedAt: cloudTimer.updated_at ? new Date(cloudTimer.updated_at).getTime() : nowMs,
  };
};

/**
 * サロンに所属する全客席タイマーを取得
 */
export const fetchSalonTimers = async (salonId, options = {}) => {
  const { returnNullOnError = false } = options || {};
  if (!salonId) return [];
  try {
    const { data, error } = await supabase
      .from('salon_timers')
      .select('*')
      .eq('salon_id', salonId)
      .order('sort_order', { ascending: true })
      .order('updated_at', { ascending: false });

    if (error) {
      console.warn('fetchSalonTimers error:', error);
      return returnNullOnError ? null : [];
    }

    const rawMapped = (data || []).map((row, idx) => mapCloudTimerToSeat(row, idx));

    // 同一サロン内で同じ席名（「1番」と「1番席」の表記ゆれ含む）の重複レコードが存在する場合は、
    // 最終更新日時（updatedAt）が最も新しいレコードを最優先（停止操作が古いrunning重複行に負けないようにする）＞ 稼働中 ＞ sortOrder設定済みの順で正規の1席に統合
    const dedupedByLabel = new Map();
    const duplicateIdsByLabel = new Map();
    const unkeyedSeats = [];
    rawMapped.forEach((seat) => {
      const labelKey = String(seat.seatLabel || seat.name || '')
        .replace(/\s*[\(（]サンプル[\)）]/g, '')
        .replace(/席$/, '')
        .trim();
      if (!labelKey) {
        unkeyedSeats.push(seat);
        return;
      }
      const existing = dedupedByLabel.get(labelKey);
      if (!existing) {
        dedupedByLabel.set(labelKey, seat);
        duplicateIdsByLabel.set(labelKey, []);
        return;
      }
      const dups = duplicateIdsByLabel.get(labelKey) || [];
      const existingUpdated = Number(existing.updatedAt || 0);
      const candidateUpdated = Number(seat.updatedAt || 0);
      let candidateWins = false;
      if (candidateUpdated !== existingUpdated) {
        candidateWins = candidateUpdated > existingUpdated;
      } else {
        const existingRunning = existing.status === 'running' ? 1 : 0;
        const candidateRunning = seat.status === 'running' ? 1 : 0;
        if (candidateRunning !== existingRunning) {
          candidateWins = candidateRunning > existingRunning;
        } else {
          const existingHasOrder = Number(existing.sortOrder) > 0 ? 1 : 0;
          const candidateHasOrder = Number(seat.sortOrder) > 0 ? 1 : 0;
          candidateWins = candidateHasOrder > existingHasOrder;
        }
      }
      if (candidateWins) {
        if (existing.id && existing.id !== seat.id) dups.push(existing.id);
        dedupedByLabel.set(labelKey, seat);
      } else if (seat.id && seat.id !== existing.id) {
        dups.push(seat.id);
      }
      duplicateIdsByLabel.set(labelKey, dups);
    });

    for (const [labelKey, winningSeat] of dedupedByLabel.entries()) {
      const dups = duplicateIdsByLabel.get(labelKey) || [];
      if (dups.length > 0) {
        dedupedByLabel.set(labelKey, {
          ...winningSeat,
          duplicateCloudTimerIds: dups,
        });
      }
    }

    const mapped = [...dedupedByLabel.values(), ...unkeyedSeats].sort((a, b) => {
      const orderA = Number(a.sortOrder) > 0 ? Number(a.sortOrder) : (Number(a.seatNumber) > 0 ? Number(a.seatNumber) : 999999);
      const orderB = Number(b.sortOrder) > 0 ? Number(b.sortOrder) : (Number(b.seatNumber) > 0 ? Number(b.seatNumber) : 999999);
      if (orderA !== orderB) return orderA - orderB;
      const numA = Number(a.seatNumber || 0);
      const numB = Number(b.seatNumber || 0);
      if (numA !== numB) return numA - numB;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });

    const usedNums = new Set();
    let maxUsed = 0;
    mapped.forEach((seat) => {
      if (/\d+/.test(String(seat.seatLabel || ''))) {
        const n = Number(seat.seatNumber);
        if (n > 0 && !usedNums.has(n)) {
          usedNums.add(n);
          if (n > maxUsed) maxUsed = n;
        }
      }
    });
    const finalSeats = mapped.map((seat) => {
      if (/\d+/.test(String(seat.seatLabel || ''))) {
        return seat;
      }
      const n = Number(seat.seatNumber);
      if (n > 0 && !usedNums.has(n)) {
        usedNums.add(n);
        if (n > maxUsed) maxUsed = n;
        return seat;
      }
      maxUsed += 1;
      usedNums.add(maxUsed);
      return { ...seat, seatNumber: maxUsed };
    });
    finalSeats.forEach((seat) => setLastKnownCloudSeat(salonId, seat));
    return finalSeats;
  } catch (e) {
    console.warn('fetchSalonTimers failed:', e);
    return returnNullOnError ? null : [];
  }
};

/**
 * 自端末から直近に送信したクラウド更新のシグネチャと送信時刻を記録し、Realtimeエコーバック（自己通知）を判定
 * ※ 旧ビルド（Build ≤97）の端末が updated_by カラムを含めずに UPSERT した場合、PostgreSQL 上の既存 updated_by が保持されるため、
 *   無期限に updated_by === localUserId だけで判定すると相手端末の停止・変更通知まで自己エコーと誤認してしまう。
 *   そのため自端末が実際にクラウド更新を送信した直近ウィンドウ（LOCAL_ACTOR_ECHO_WINDOW_MS）内のみ自己エコーと判定する。
 */
const _recentLocalPayloadSigs = new Map();
const _recentLocalSeatWriteAt = new Map();
let _lastLocalAnyCloudWriteAt = 0;
const LOCAL_ACTOR_ECHO_WINDOW_MS = 12000;

const getCloudPayloadSignature = (p) => {
  if (!p) return '';
  return `${p.seat_label || ''}|${p.color_staff_name || ''}|${p.status || ''}|${Number(p.target_seconds || 0)}|${Number(p.target_end_timestamp || 0)}|${Number(p.paused_remaining_seconds || 0)}|${p.assistant_staff_name || ''}|${p.help_process || ''}|${p.is_shampooing ? 1 : 0}|${p.comment || ''}|${Number(p.check_target_end_timestamp || 0)}|${Number(p.check_total_seconds || 0)}|${p.check_process || ''}|${p.check_staff_name || ''}`;
};

const collectLocalSeatWriteKeys = (seatOrId) => {
  const keys = new Set();
  if (!seatOrId) return keys;

  const addNumberKeys = (n) => {
    const num = Number(n);
    if (Number.isInteger(num) && num > 0 && num < 1000) {
      keys.add(`num:${num}`);
      keys.add(`id:seat-${num}`);
      keys.add(`lbl:${num}`);
      keys.add(`lbl:${num}番`);
    }
  };

  const addRawStringKeys = (rawStr, isIdCandidate = false) => {
    const trimmed = String(rawStr || '').trim();
    if (!trimmed) return;
    if (isIdCandidate) {
      keys.add(`id:${trimmed}`);
      const seatIdMatch = trimmed.match(/^seat-(\d+)$/i);
      if (seatIdMatch) {
        addNumberKeys(parseInt(seatIdMatch[1], 10));
      } else if (/^\d+$/.test(trimmed)) {
        addNumberKeys(parseInt(trimmed, 10));
      }
    }
    const cleanLbl = trimmed
      .replace(/\s*[\(（]サンプル[\)）]/g, '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/席$/, '')
      .trim();
    if (cleanLbl) {
      keys.add(`lbl:${cleanLbl}`);
      const baseLbl = cleanLbl.replace(/番$/, '').trim();
      if (baseLbl) {
        keys.add(`lbl:${baseLbl}`);
        if (/^\d+$/.test(baseLbl)) {
          addNumberKeys(parseInt(baseLbl, 10));
        }
      }
      const seatIdInLbl = cleanLbl.match(/^seat-(\d+)$/i);
      if (seatIdInLbl) {
        addNumberKeys(parseInt(seatIdInLbl[1], 10));
      }
    }
  };

  if (typeof seatOrId === 'string' || typeof seatOrId === 'number') {
    addRawStringKeys(seatOrId, true);
  } else if (typeof seatOrId === 'object') {
    const candidateIds = [seatOrId.id, seatOrId.cloudTimerId].filter(Boolean);
    for (const cid of candidateIds) {
      addRawStringKeys(cid, true);
    }
    const candidateLabels = [
      seatOrId.seat_label,
      seatOrId.seatLabel,
      seatOrId.name,
      seatOrId.oldSeatLabel,
    ].filter(Boolean);
    for (const rawLbl of candidateLabels) {
      addRawStringKeys(rawLbl, false);
    }
    if (seatOrId.seatNumber !== undefined && seatOrId.seatNumber !== null) {
      addNumberKeys(seatOrId.seatNumber);
    }
  }
  return keys;
};

const markLocalSeatWriteTimestamp = (p) => {
  const now = Date.now();
  _lastLocalAnyCloudWriteAt = now;
  const keys = collectLocalSeatWriteKeys(p);
  for (const k of keys) {
    _recentLocalSeatWriteAt.set(k, now);
  }
  if (_recentLocalSeatWriteAt.size > 150) {
    for (const [k, ts] of _recentLocalSeatWriteAt.entries()) {
      if (now - ts > LOCAL_ACTOR_ECHO_WINDOW_MS * 2) _recentLocalSeatWriteAt.delete(k);
    }
  }
};

const recordLocalCloudPayload = (p) => {
  markLocalSeatWriteTimestamp(p);
  const sig = getCloudPayloadSignature(p);
  if (!sig) return;
  const now = Date.now();
  _recentLocalPayloadSigs.set(sig, now);
  if (_recentLocalPayloadSigs.size > 100) {
    for (const [k, ts] of _recentLocalPayloadSigs.entries()) {
      if (now - ts > 15000) _recentLocalPayloadSigs.delete(k);
    }
  }
};

const isRecentLocalCloudPayload = (rec, windowMs = 6000) => {
  const sig = getCloudPayloadSignature(rec);
  if (!sig || !_recentLocalPayloadSigs.has(sig)) return false;
  return Date.now() - _recentLocalPayloadSigs.get(sig) < windowMs;
};

export const isRecentLocalActorEcho = (rec, localUserId, windowMs = LOCAL_ACTOR_ECHO_WINDOW_MS) => {
  const recUpdatedBy = rec?.updated_by || rec?.updatedBy || null;
  if (!recUpdatedBy || !localUserId || recUpdatedBy !== localUserId) return false;
  const now = Date.now();
  const lookupKeys = collectLocalSeatWriteKeys(rec);
  for (const k of lookupKeys) {
    if (_recentLocalSeatWriteAt.has(k) && now - _recentLocalSeatWriteAt.get(k) < windowMs) {
      return true;
    }
  }
  // ★ 自端末ペアリング中のApple Watchから直接Supabase REST更新された場合も自己エコーとして判定し、自端末への誤通知を防止
  const rawUpdatedAt = rec?.updated_at ?? rec?.updatedAt ?? null;
  if (rawUpdatedAt) {
    const parsedUpdatedMs =
      typeof rawUpdatedAt === 'number' ? rawUpdatedAt : new Date(rawUpdatedAt).getTime();
    if (Number.isFinite(parsedUpdatedMs) && Math.abs(now - parsedUpdatedMs) < 25000) {
      return true;
    }
  }
  return _lastLocalAnyCloudWriteAt > 0 && now - _lastLocalAnyCloudWriteAt < 6000;
};

/**
 * 指定された席（ID文字列または席オブジェクト）が直近 windowMs ミリ秒以内に
 * 自端末ローカルからクラウド保存要求されたかどうかを判定する。
 * ポーリング（reconcileCloudTimers）での自己エコー通知抑止および非同期UPSERT中の巻き戻り保護に使用。
 * ただし cloudSeat が別スタッフによるさらに新しい更新である場合は false を返し、他スタッフ操作を握り潰さない。
 */
export const isSeatRecentlyModifiedLocally = (
  seatOrId,
  windowMs = 10000,
  cloudSeat = null,
  localUserId = null
) => {
  if (!seatOrId) return false;
  const now = Date.now();
  const safeWindow = Number(windowMs) > 0 ? Number(windowMs) : 10000;
  let matchedWriteAt = 0;

  const lookupKeys = collectLocalSeatWriteKeys(seatOrId);
  for (const k of lookupKeys) {
    if (_recentLocalSeatWriteAt.has(k)) {
      const ts = _recentLocalSeatWriteAt.get(k);
      if (now - ts < safeWindow) matchedWriteAt = Math.max(matchedWriteAt, ts);
    }
  }

  if (matchedWriteAt <= 0) return false;

  if (cloudSeat && typeof cloudSeat === 'object') {
    const cloudUpdatedBy = String(cloudSeat.updated_by || cloudSeat.updatedBy || '').trim();
    const myUid = String(localUserId || '').trim();
    const isUpdatedByOtherPeer =
      Boolean(cloudUpdatedBy && myUid && cloudUpdatedBy.toLowerCase() !== myUid.toLowerCase());
    const rawCloudUpdatedAt = cloudSeat.updated_at ?? cloudSeat.updatedAt ?? 0;
    const cloudUpdatedMs =
      typeof rawCloudUpdatedAt === 'number'
        ? rawCloudUpdatedAt
        : new Date(rawCloudUpdatedAt).getTime();
    if (
      isUpdatedByOtherPeer &&
      Number.isFinite(cloudUpdatedMs) &&
      cloudUpdatedMs > matchedWriteAt + 1000
    ) {
      return false;
    }
  }

  return true;
};

/**
 * updated_by カラム未マイグレーション環境でも失敗しない後方互換 UPSERT ヘルパー
 */
let _updatedByColumnUnsupported = false;

const executeSalonTimerUpsert = async (rawPayload, fallbackUserId = null) => {
  const safePayload = {
    ...rawPayload,
    created_by: String(rawPayload.created_by || '').trim() || fallbackUserId || 'unknown',
  };
  const payloadToSend = _updatedByColumnUnsupported
    ? (() => {
        const { updated_by, ...rest } = safePayload;
        return rest;
      })()
    : safePayload;

  const res = await supabase
    .from('salon_timers')
    .upsert(payloadToSend)
    .select()
    .single();

  if (
    res.error &&
    !_updatedByColumnUnsupported &&
    Object.prototype.hasOwnProperty.call(payloadToSend, 'updated_by') &&
    (res.error.code === 'PGRST204' ||
      res.error.code === '42703' ||
      String(res.error.message || '').includes('updated_by'))
  ) {
    _updatedByColumnUnsupported = true;
    const { updated_by, ...fallbackPayload } = safePayload;
    return supabase
      .from('salon_timers')
      .upsert(fallbackPayload)
      .select()
      .single();
  }

  return res;
};

/**
 * 既存席の停止・リセット・施術終了時など、ローカルに createdBy が欠落している場合に
 * created_by カラム自体を更新対象から省略して DB 上の既存 created_by を保護し、
 * PostgreSQL の NOT NULL 制約違反 (23502) を完全に防ぐ UPDATE ヘルパー
 */
const executeSalonTimerUpdateById = async (salonId, timerId, rawPayload) => {
  const { id, salon_id, created_by, ...restCols } = rawPayload;
  const trimmedCb = String(created_by || '').trim();
  const baseUpdateBody = trimmedCb ? { ...restCols, created_by: trimmedCb } : restCols;

  const payloadToSend = _updatedByColumnUnsupported
    ? (() => {
        const { updated_by, ...rest } = baseUpdateBody;
        return rest;
      })()
    : baseUpdateBody;

  const res = await supabase
    .from('salon_timers')
    .update(payloadToSend)
    .eq('salon_id', salonId)
    .eq('id', timerId)
    .select()
    .maybeSingle();

  if (
    res.error &&
    !_updatedByColumnUnsupported &&
    Object.prototype.hasOwnProperty.call(payloadToSend, 'updated_by') &&
    (res.error.code === 'PGRST204' ||
      res.error.code === '42703' ||
      String(res.error.message || '').includes('updated_by'))
  ) {
    _updatedByColumnUnsupported = true;
    const { updated_by, ...fallbackBody } = baseUpdateBody;
    return supabase
      .from('salon_timers')
      .update(fallbackBody)
      .eq('salon_id', salonId)
      .eq('id', timerId)
      .select()
      .maybeSingle();
  }

  return res;
};

/**
 * 1席のタイマー状態をクラウドへ保存/更新（UPSERT / UPDATE）
 * 保存完了後、状態変化があればクライアントから直接 Expo Push API（+ Edge Function フォールバック）へ即時通知を配信する
 */
export const upsertCloudTimer = async (salonId, seat, options = {}) => {
  if (!salonId || !seat) return null;
  const prevSeatSnapshot =
    options?.prevSeatOverride ||
    options?.prevSeat ||
    seat?._preActionSeatSnapshot ||
    getLastKnownCloudSeat(salonId, seat) ||
    null;
  markLocalSeatWriteTimestamp(seat);
  const userId = await getOrCreateUserId();
  const payload = mapSeatToCloudTimer(seat, salonId, userId);
  recordLocalCloudPayload(payload);

  const finalizeUpsertResult = (mappedSeat) => {
    const resolvedSeat = mappedSeat || seat;
    if (resolvedSeat) {
      setLastKnownCloudSeat(salonId, resolvedSeat);
    }
    const shouldSkipDirectPush =
      options?.skipDirectPush === true ||
      options?.skipPushDispatch === true ||
      seat?.skipDirectPushOnce === true;
    if (!shouldSkipDirectPush && resolvedSeat) {
      const inferredActorName =
        String(
          options?.actorName ||
            seat?.stoppedBy ||
            (seat?.status === 'running' && (!prevSeatSnapshot || prevSeatSnapshot.status !== 'running')
              ? seat?.colorStaffName || ''
              : '')
        ).trim();
      dispatchSalonTimerEventPush({
        salonId,
        actorUserId: userId,
        actorName: inferredActorName,
        prevSeat: prevSeatSnapshot,
        nextSeat: resolvedSeat,
        staffMembers: Array.isArray(options?.staffMembers) ? options.staffMembers : [],
      }).catch(() => {});
    }
    return mappedSeat;
  };

  try {
    const isUUID = (seat.cloudTimerId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seat.cloudTimerId))
      || (seat.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seat.id));

    if (isUUID) {
      payload.id = seat.cloudTimerId || seat.id;
      markLocalSeatWriteTimestamp(payload);
      if (!payload.created_by) {
        const updRes = await executeSalonTimerUpdateById(salonId, payload.id, payload);
        if (!updRes.error && updRes.data) {
          return finalizeUpsertResult(mapCloudTimerToSeat(updRes.data));
        }
        if (updRes.error) {
          console.warn('upsertCloudTimer update-by-id error:', updRes.error);
          return null;
        }
      }
      const { data, error } = await executeSalonTimerUpsert(payload, userId);
      if (error) console.warn('upsertCloudTimer update error:', error);
      return data ? finalizeUpsertResult(mapCloudTimerToSeat(data)) : null;
    } else {
      // 席名（変更前ラベルおよび「1番」⇔「1番席」表記ゆれ含む）で同一サロン内の席を検索して既存があればIDを再利用
      const baseLabel = payload.seat_label;
      const altLabel1 = baseLabel.endsWith('席') ? baseLabel.slice(0, -1) : `${baseLabel}席`;
      const oldLabel = seat.oldSeatLabel ? String(seat.oldSeatLabel).trim() : null;
      const candidates = Array.from(new Set([oldLabel, baseLabel, altLabel1].filter(Boolean)));

      const { data: existingList } = await supabase
        .from('salon_timers')
        .select('id, seat_label, created_by')
        .eq('salon_id', salonId)
        .in('seat_label', candidates);

      if (Array.isArray(existingList) && existingList.length > 0) {
        const matched = (oldLabel && existingList.find((r) => r.seat_label === oldLabel))
          || existingList.find((r) => r.seat_label === baseLabel)
          || existingList[0];
        if (matched?.id) {
          payload.id = matched.id;
          if (!payload.created_by && matched.created_by) {
            payload.created_by = matched.created_by;
          }
          markLocalSeatWriteTimestamp(payload);
          if (!payload.created_by) {
            const updRes = await executeSalonTimerUpdateById(salonId, payload.id, payload);
            if (!updRes.error && updRes.data) {
              return finalizeUpsertResult(mapCloudTimerToSeat(updRes.data));
            }
          }
        }
      }
      const { data, error } = await executeSalonTimerUpsert(payload, userId);

      if (error) console.warn('upsertCloudTimer insert error:', error);
      return data ? finalizeUpsertResult(mapCloudTimerToSeat(data)) : null;
    }
  } catch (e) {
    console.warn('upsertCloudTimer failed:', e);
    return null;
  }
};

/**
 * 客席タイマーの削除（席マスター削除時）
 */
export const deleteCloudTimer = async (salonId, timerIdOrLabel, fallbackSeatLabel = null) => {
  if (!salonId || (!timerIdOrLabel && !fallbackSeatLabel)) return false;
  try {
    const isUUID = isValidUUID(String(timerIdOrLabel || ''));
    if (isUUID) {
      const { error } = await supabase
        .from('salon_timers')
        .delete()
        .eq('salon_id', salonId)
        .eq('id', timerIdOrLabel);
      if (error) {
        console.warn('deleteCloudTimer by id error:', error);
        return false;
      }
      return true;
    } else {
      const targetLabel = (fallbackSeatLabel || timerIdOrLabel || '').trim();
      if (targetLabel) {
        const { error } = await supabase
          .from('salon_timers')
          .delete()
          .eq('salon_id', salonId)
          .eq('seat_label', targetLabel);
        if (error) {
          console.warn('deleteCloudTimer by label error:', error);
          return false;
        }
        return true;
      }
      return false;
    }
  } catch (e) {
    console.warn('deleteCloudTimer failed:', e);
    return false;
  }
};

/**
 * 客席タイマー（salon_timers）の変更をリアルタイム（Realtime WebSocket）で監視
 */
export const subscribeSalonTimers = (salonId, onTimerEvent) => {
  if (!salonId) return () => {};

  let localUserId = null;
  getOrCreateUserId()
    .then((uid) => {
      localUserId = uid;
    })
    .catch(() => {});

  const channel = supabase
    .channel(`salon_timers_${salonId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'salon_timers',
        filter: `salon_id=eq.${salonId}`,
      },
      (payload) => {
        if (typeof onTimerEvent === 'function') {
          const { eventType, new: newRec, old: oldRec } = payload;
          const isUpdatedByMe = isRecentLocalActorEcho(newRec, localUserId);
          const isSelfEcho = newRec ? (isUpdatedByMe || isRecentLocalCloudPayload(newRec)) : false;
          const rawOldLabel = oldRec?.seat_label
            ? String(oldRec.seat_label).replace(/\s*[\(（]サンプル[\)）]/g, '').trim()
            : null;
          const resolvedOldSeat =
            eventType === 'DELETE'
              ? (oldRec
                  ? {
                      id: oldRec.id || null,
                      cloudTimerId: oldRec.id || null,
                      seatLabel: rawOldLabel || null,
                      name: rawOldLabel || null,
                    }
                  : null)
              : (oldRec ? mapCloudTimerToSeat(oldRec) : null);
          const mappedNewSeat = newRec ? mapCloudTimerToSeat(newRec) : null;
          if (mappedNewSeat) {
            setLastKnownCloudSeat(salonId, mappedNewSeat);
          }
          onTimerEvent({
            eventType,
            newSeat: mappedNewSeat,
            oldSeat: resolvedOldSeat,
            isSelfEcho,
            rawPayload: payload,
          });
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
};
