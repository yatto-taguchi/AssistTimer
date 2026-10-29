import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

const USER_ID_KEY = '@assist_timer_user_id';

/**
 * 端末固有の一意UUIDを生成または取得
 */
export const getOrCreateUserId = async () => {
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
    return uid;
  } catch (e) {
    console.warn('Failed to getOrCreateUserId', e);
    return 'user-' + Date.now();
  }
};

const isValidUUID = (val) =>
  typeof val === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

/**
 * サロン・招待コードをSupabaseクラウドに登録（または既存を取得）
 * - salonId(UUID)が既知の場合はまずIDで検索し、招待コード変更後の再起動でも同一サロンを確実に維持する
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
  if (!inviteCode && !hasValidSalonId) return null;
  const userId = await getOrCreateUserId();
  const cleanCode = inviteCode ? inviteCode.replace(/\s+/g, '').toUpperCase() : '';

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
      }
    }

    if (!salonData && cleanCode) {
      const { data: existing, error: searchErr } = await supabase
        .from('salons')
        .select('*')
        .eq('invite_code', cleanCode)
        .maybeSingle();

      if (searchErr) {
        console.warn('Error searching salon by code:', searchErr);
      }
      salonData = existing;
    }

    if (!salonData) {
      if (allowCreate === false || !cleanCode) {
        return null;
      }
      const { data: created, error: insertErr } = await supabase
        .from('salons')
        .insert({
          name: salonName || 'サロン',
          owner_user_id: userId,
          invite_code: cleanCode,
          is_pro: !!isPro,
        })
        .select()
        .single();

      if (insertErr) {
        console.warn('Error creating salon:', insertErr);
        const { data: retry } = await supabase
          .from('salons')
          .select('*')
          .eq('invite_code', cleanCode)
          .maybeSingle();
        salonData = retry;
      } else {
        salonData = created;
      }
    }

    if (!salonData) return null;

    const role = salonData.owner_user_id === userId ? 'owner' : 'assistant';
    await supabase
      .from('salon_members')
      .upsert(
        {
          salon_id: salonData.id,
          user_id: userId,
          display_name: (userName || 'スタイリスト').trim(),
          role: role,
        },
        { onConflict: 'salon_id,user_id' }
      );

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
  const cleanCode = newInviteCode.replace(/\s+/g, '').toUpperCase();
  if (!cleanCode) {
    throw new Error('招待コードを入力してください');
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
  const cleanCode = inviteCode.replace(/\s+/g, '').toUpperCase();

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
export const fetchSalonMembers = async (salonId) => {
  if (!salonId) return [];
  try {
    const { data, error } = await supabase
      .from('salon_members')
      .select('*')
      .eq('salon_id', salonId)
      .order('joined_at', { ascending: true });

    if (error) {
      console.warn('fetchSalonMembers error:', error);
      return [];
    }
    return data || [];
  } catch (e) {
    console.warn('fetchSalonMembers failed:', e);
    return [];
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
        const updatedMembers = await fetchSalonMembers(salonId);
        if (typeof onMembersChange === 'function') {
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
 * メンバー表示名の更新（ニックネーム変更）
 */
export const updateMemberDisplayName = async ({ salonId, displayName }) => {
  if (!salonId || !displayName) return;
  const userId = await getOrCreateUserId();
  try {
    await supabase
      .from('salon_members')
      .update({ display_name: displayName.trim() })
      .eq('salon_id', salonId)
      .eq('user_id', userId);
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
  const targetSeconds = Math.round(Number(seat.targetSeconds || seat.targetTime || 0));
  const rawCheckSec = Math.round(Number(seat.checkTargetSeconds || seat.checkTotalSeconds || 0));
  const checkPausedRem = Math.round(Number(seat.checkPausedRemainingSeconds || 0));
  const hasRunningCheck =
    (seat.checkStatus === 'running' || seat.checkStatus === 'timeup') &&
    (Number(seat.checkEndTimestamp) > 0 || checkPausedRem > 0);
  const isCheckDone = !hasRunningCheck && (seat.checkStatus === 'completed' || !!seat.isCheckCompleted);
  const checkTotalSeconds = isCheckDone
    ? (rawCheckSec > 0 ? rawCheckSec : Math.max(60, Math.round(Number(seat.checkInitialMinutes || 1) * 60)))
    : (seat.checkStatus === 'stopped' && !seat.checkEndTimestamp && checkPausedRem <= 0 ? 0 : rawCheckSec);
  const targetEndTs = Math.round(Number(seat.targetEndTimestamp || 0));
  const pausedRemSec = Math.round(Number(seat.pausedRemainingSeconds || 0));
  const checkEndTs = !isCheckDone
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

  return {
    salon_id: salonId,
    seat_label: seatLabel,
    color_staff_name: seat.colorStaffName || 'スタッフ',
    assistant_staff_name: resolvedAssistant,
    help_process: resolvedHelpProcess,
    is_shampooing: isShampooing,
    status: seat.status || 'idle',
    target_seconds: targetSeconds,
    target_end_timestamp: targetEndTs,
    paused_remaining_seconds: pausedRemSec,
    comment: seat.comment || null,
    sort_order: resolvedSortOrder,
    created_by: seat.createdBy || userId,
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
  const targetSeconds = Math.round(Number(cloudTimer.target_seconds || 0));
  const checkSec = cloudTimer.check_total_seconds ? Math.round(Number(cloudTimer.check_total_seconds)) : 0;
  const checkEndTs = cloudTimer.check_target_end_timestamp ? Math.round(Number(cloudTimer.check_target_end_timestamp)) : null;
  const status = cloudTimer.status || 'idle';
  const targetEndTs = Math.round(Number(cloudTimer.target_end_timestamp || 0));
  const pausedRemSec = Math.round(Number(cloudTimer.paused_remaining_seconds || 0));
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
  const actionStatus = isShampooing ? 'shampoo' : (LABEL_TO_ACTION_ID[helpProcess] || null);
  const isReset = (status === 'paused' || status === 'idle') && pausedRemSec <= 0 && targetEndTs <= 0;
  const nowMs = Date.now();
  const isOver = status === 'running' && targetEndTs > 0 && targetEndTs <= nowMs;
  const checkPausedRemainingSeconds =
    status === 'paused' && hasActiveCheck ? Math.max(0, Math.round((checkEndTs - nowMs) / 1000)) : null;

  return {
    id: cloudTimer.id,
    cloudTimerId: cloudTimer.id,
    seatNumber: seatNumber,
    seatLabel: name,
    name: name,
    targetSeconds: targetSeconds,
    targetTime: targetSeconds,
    initialMinutes: targetSeconds > 0 ? Math.max(1, Math.round(targetSeconds / 60)) : 20,
    targetEndTimestamp: targetEndTs,
    pausedRemainingSeconds: pausedRemSec,
    status: status,
    isReset: isReset,
    isOver: isOver,
    timeUpTimestamp: isOver ? targetEndTs : null,
    escalationLevel: 0,
    colorStaffName: cloudTimer.color_staff_name || 'スタッフ',
    assistantStaffName: assistantStaffName,
    helpProcess: helpProcess,
    actionStatus: actionStatus,
    isShampooing: isShampooing,
    isRecruiting: isRecruiting,
    isNoHelpNeeded: isNoHelpNeeded,
    comment: cloudTimer.comment || '',
    sortOrder: cloudTimer.sort_order || 0,
    createdBy: cloudTimer.created_by,
    checkEndTimestamp: checkEndTs,
    checkPausedRemainingSeconds: checkPausedRemainingSeconds,
    checkTargetSeconds: checkSec > 0 ? checkSec : null,
    checkTotalSeconds: checkSec > 0 ? checkSec : null,
    checkInitialMinutes: checkSec > 0 ? Math.max(1, Math.round(checkSec / 60)) : null,
    checkProcess: cloudTimer.check_process || 'チェック',
    checkStaffName: cloudTimer.check_staff_name || '',
    checkStaff: cloudTimer.check_staff_name || '',
    checkStatus: hasActiveCheck ? (status === 'running' && checkEndTs <= nowMs ? 'timeup' : 'running') : (isCheckCompleted ? 'completed' : 'stopped'),
    isCheckCompleted: isCheckCompleted,
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
      .order('created_at', { ascending: true });

    if (error) {
      console.warn('fetchSalonTimers error:', error);
      return returnNullOnError ? null : [];
    }
    const mapped = (data || []).map((row, idx) => mapCloudTimerToSeat(row, idx));
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
    return mapped.map((seat) => {
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
  } catch (e) {
    console.warn('fetchSalonTimers failed:', e);
    return returnNullOnError ? null : [];
  }
};

/**
 * 自端末から直近に送信したクラウド更新のシグネチャを記録し、Realtimeエコーバック（自己通知）を判定
 */
const _recentLocalPayloadSigs = new Map();

const getCloudPayloadSignature = (p) => {
  if (!p) return '';
  return `${p.seat_label || ''}|${p.color_staff_name || ''}|${p.status || ''}|${Number(p.target_seconds || 0)}|${Number(p.target_end_timestamp || 0)}|${Number(p.paused_remaining_seconds || 0)}|${p.assistant_staff_name || ''}|${p.help_process || ''}|${p.is_shampooing ? 1 : 0}|${p.comment || ''}|${Number(p.check_target_end_timestamp || 0)}|${Number(p.check_total_seconds || 0)}|${p.check_process || ''}|${p.check_staff_name || ''}`;
};

const recordLocalCloudPayload = (p) => {
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

/**
 * 1席のタイマー状態をクラウドへ保存/更新（UPSERT）
 */
export const upsertCloudTimer = async (salonId, seat) => {
  if (!salonId || !seat) return null;
  const userId = await getOrCreateUserId();
  const payload = mapSeatToCloudTimer(seat, salonId, userId);
  recordLocalCloudPayload(payload);

  try {
    const isUUID = (seat.cloudTimerId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seat.cloudTimerId))
      || (seat.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seat.id));

    if (isUUID) {
      payload.id = seat.cloudTimerId || seat.id;
      const { data, error } = await supabase
        .from('salon_timers')
        .upsert(payload)
        .select()
        .single();
      if (error) console.warn('upsertCloudTimer update error:', error);
      return data ? mapCloudTimerToSeat(data) : null;
    } else {
      // 席名（変更前ラベルおよび「1番」⇔「1番席」表記ゆれ含む）で同一サロン内の席を検索して既存があればIDを再利用
      const baseLabel = payload.seat_label;
      const altLabel1 = baseLabel.endsWith('席') ? baseLabel.slice(0, -1) : `${baseLabel}席`;
      const oldLabel = seat.oldSeatLabel ? String(seat.oldSeatLabel).trim() : null;
      const candidates = Array.from(new Set([oldLabel, baseLabel, altLabel1].filter(Boolean)));

      const { data: existingList } = await supabase
        .from('salon_timers')
        .select('id, seat_label')
        .eq('salon_id', salonId)
        .in('seat_label', candidates);

      if (Array.isArray(existingList) && existingList.length > 0) {
        const matched = (oldLabel && existingList.find((r) => r.seat_label === oldLabel))
          || existingList.find((r) => r.seat_label === baseLabel)
          || existingList[0];
        if (matched?.id) {
          payload.id = matched.id;
        }
      }
      const { data, error } = await supabase
        .from('salon_timers')
        .upsert(payload)
        .select()
        .single();

      if (error) console.warn('upsertCloudTimer insert error:', error);
      return data ? mapCloudTimerToSeat(data) : null;
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
          const isSelfEcho = newRec ? isRecentLocalCloudPayload(newRec) : false;
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
          onTimerEvent({
            eventType,
            newSeat: newRec ? mapCloudTimerToSeat(newRec) : null,
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
