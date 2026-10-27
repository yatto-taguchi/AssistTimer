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
    // 1. 既存のサロンを招待コードで検索
    const { data: existing, error: searchErr } = await supabase
      .from('salons')
      .select('*')
      .eq('invite_code', cleanCode)
      .maybeSingle();

    if (searchErr) {
      console.warn('Error searching salon by code:', searchErr);
    }

    let salonData = existing;

    // 2. 存在しない場合は新規作成（自分がオーナー）
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
        // 重複などで失敗した場合は再度検索を試みる
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

    // 3. 自分を salon_members に登録/更新（UPSERT）
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

  // 1. サロンを招待コードで検索
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

  // 2. 自分を salon_members に参加登録（UPSERT）
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

  // 3. 最新のメンバー一覧を取得
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
        // メンバーに変更（追加・更新・離脱）があったら最新のメンバー一覧を再取得して通知
        const updatedMembers = await fetchSalonMembers(salonId);
        if (typeof onMembersChange === 'function') {
          onMembersChange(updatedMembers, payload);
        }
      }
    )
    .subscribe();

  // クリーンアップ関数を返却
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
