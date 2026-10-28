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

/**
 * サロン・招待コードをSupabaseクラウドに登録（または既存を取得）
 */
export const syncOrCreateSalonInCloud = async ({ salonName, inviteCode, isPro, userName }) => {
  if (!inviteCode) return null;
  const userId = await getOrCreateUserId();
  const cleanCode = inviteCode.replace(/\s+/g, '').toUpperCase();

  try {
    const { data: existing, error: searchErr } = await supabase
      .from('salons')
      .select('*')
      .eq('invite_code', cleanCode)
      .maybeSingle();

    if (searchErr) {
      console.warn('Error searching salon by code:', searchErr);
    }

    let salonData = existing;

    if (!salonData) {
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

    const role = salonData.owner_user_id === userId ? 'owner' : 'stylist';
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

/**
 * ローカルのSeatItemをクラウドsalon_timersのレコード形式にマッピング
 */
export const mapSeatToCloudTimer = (seat, salonId, userId) => {
  const seatLabel = (seat.seatLabel || seat.name || '席').trim();
  const targetSeconds = Math.round(Number(seat.targetSeconds || seat.targetTime || 0));
  const checkTotalSeconds = Math.round(Number(seat.checkTargetSeconds || seat.checkTotalSeconds || 0));
  const targetEndTs = Math.round(Number(seat.targetEndTimestamp || 0));
  const pausedRemSec = Math.round(Number(seat.pausedRemainingSeconds || 0));
  const checkEndTs = seat.checkEndTimestamp ? Math.round(Number(seat.checkEndTimestamp)) : null;

  return {
    salon_id: salonId,
    seat_label: seatLabel,
    color_staff_name: seat.colorStaffName || 'スタッフ',
    assistant_staff_name: seat.assistantStaffName || null,
    help_process: seat.helpProcess || null,
    is_shampooing: !!seat.isShampooing,
    status: seat.status || 'idle',
    target_seconds: targetSeconds,
    target_end_timestamp: targetEndTs,
    paused_remaining_seconds: pausedRemSec,
    comment: seat.comment || null,
    sort_order: typeof seat.sortOrder === 'number' ? Math.round(seat.sortOrder) : 0,
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
export const mapCloudTimerToSeat = (cloudTimer, index = 0) => {
  const name = cloudTimer.seat_label || '席';
  const targetSeconds = Math.round(Number(cloudTimer.target_seconds || 0));
  const checkSec = cloudTimer.check_total_seconds ? Math.round(Number(cloudTimer.check_total_seconds)) : 0;
  const checkEndTs = cloudTimer.check_target_end_timestamp ? Math.round(Number(cloudTimer.check_target_end_timestamp)) : null;
  const status = cloudTimer.status || 'idle';
  const hasActiveCheck = status === 'running' && checkSec > 0 && checkEndTs && checkEndTs > 0;
  const numMatch = String(name).match(/\d+/);
  const seatNumber = numMatch ? parseInt(numMatch[0], 10) : (index + 1);

  return {
    id: cloudTimer.id,
    cloudTimerId: cloudTimer.id,
    seatNumber: seatNumber,
    seatLabel: name,
    name: name,
    targetSeconds: targetSeconds,
    targetTime: targetSeconds,
    initialMinutes: targetSeconds > 0 ? Math.max(1, Math.round(targetSeconds / 60)) : 20,
    targetEndTimestamp: Math.round(Number(cloudTimer.target_end_timestamp || 0)),
    pausedRemainingSeconds: Math.round(Number(cloudTimer.paused_remaining_seconds || 0)),
    status: status,
    colorStaffName: cloudTimer.color_staff_name || 'スタッフ',
    assistantStaffName: cloudTimer.assistant_staff_name || '',
    helpProcess: cloudTimer.help_process || '',
    isShampooing: !!cloudTimer.is_shampooing,
    comment: cloudTimer.comment || '',
    sortOrder: cloudTimer.sort_order || 0,
    createdBy: cloudTimer.created_by,
    checkEndTimestamp: checkEndTs,
    checkTargetSeconds: checkSec > 0 ? checkSec : null,
    checkTotalSeconds: checkSec > 0 ? checkSec : null,
    checkInitialMinutes: checkSec > 0 ? Math.max(1, Math.round(checkSec / 60)) : null,
    checkProcess: cloudTimer.check_process || 'チェック',
    checkStaffName: cloudTimer.check_staff_name || '',
    checkStaff: cloudTimer.check_staff_name || '',
    checkStatus: hasActiveCheck ? 'running' : 'stopped',
    isCheckCompleted: !hasActiveCheck && checkSec > 0,
    updatedAt: cloudTimer.updated_at ? new Date(cloudTimer.updated_at).getTime() : Date.now(),
  };
};

/**
 * サロンに所属する全客席タイマーを取得
 */
export const fetchSalonTimers = async (salonId) => {
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
      return [];
    }
    return (data || []).map(mapCloudTimerToSeat);
  } catch (e) {
    console.warn('fetchSalonTimers failed:', e);
    return [];
  }
};

/**
 * 1席のタイマー状態をクラウドへ保存/更新（UPSERT）
 */
export const upsertCloudTimer = async (salonId, seat) => {
  if (!salonId || !seat) return null;
  const userId = await getOrCreateUserId();
  const payload = mapSeatToCloudTimer(seat, salonId, userId);

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
export const deleteCloudTimer = async (salonId, timerIdOrLabel) => {
  if (!salonId || !timerIdOrLabel) return;
  try {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(timerIdOrLabel);
    if (isUUID) {
      await supabase.from('salon_timers').delete().eq('salon_id', salonId).eq('id', timerIdOrLabel);
    } else {
      await supabase.from('salon_timers').delete().eq('salon_id', salonId).eq('seat_label', timerIdOrLabel);
    }
  } catch (e) {
    console.warn('deleteCloudTimer failed:', e);
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
          onTimerEvent({
            eventType,
            newSeat: newRec ? mapCloudTimerToSeat(newRec) : null,
            oldSeat: oldRec ? mapCloudTimerToSeat(oldRec) : null,
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
