// ============================================================================
// Supabase Edge Function: notify-salon-event
// デプロイコマンド例:
//   supabase functions deploy notify-salon-event --no-verify-jwt
//
// 役割:
//   salon_timers の INSERT / UPDATE トリガーから新旧レコードを受け取り、
//   操作者（updated_by）を除外した該当席の関係者（主担当 created_by / color_staff_name、
//   ヘルプ担当 assistant_staff_name、チェック担当 check_staff_name、募集時はサロン全員）の
//   Expo Push Token を検索し、APNs / Expo Push API へ Time-Sensitive + content-available: 1
//   のリモートプッシュ通知を即時配信する。
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface SalonTimerRecord {
  id: string;
  salon_id: string;
  seat_label?: string | null;
  color_staff_name?: string | null;
  assistant_staff_name?: string | null;
  help_process?: string | null;
  is_shampooing?: boolean | null;
  status?: string | null;
  target_seconds?: number | null;
  target_end_timestamp?: number | null;
  paused_remaining_seconds?: number | null;
  created_by?: string | null;
  updated_by?: string | null;
  check_target_end_timestamp?: number | null;
  check_total_seconds?: number | null;
  check_process?: string | null;
  check_staff_name?: string | null;
  updated_at?: string | null;
}

interface SalonMemberRow {
  user_id: string;
  display_name: string | null;
}

interface PushTokenRow {
  id: string;
  user_id: string;
  expo_push_token: string;
  platform: string | null;
}

interface NotificationPlan {
  userIds: Set<string>;
  eventType: string;
  body: string;
  color: string;
}

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

const cleanSeatLabel = (raw?: string | null): string =>
  String(raw || '席')
    .replace(/\s*[\(（]サンプル[\)）]/g, '')
    .trim() || '席';

const isNamedAssistant = (name?: string | null): boolean => {
  const s = String(name || '').trim();
  return Boolean(s && s !== '募集中' && s !== 'ヘルプなし' && s !== 'none' && s !== '未定');
};

const isNamedCheckStaff = (name?: string | null): boolean => {
  const s = String(name || '').trim();
  return Boolean(s && s !== '募集中' && s !== '未定');
};

const isNoHelp = (name?: string | null): boolean => {
  const s = String(name || '').trim();
  return s === 'ヘルプなし' || s === 'none';
};

const resolveActionMeta = (rec?: SalonTimerRecord | null) => {
  if (!rec) return null;
  if (rec.is_shampooing || rec.help_process === 'シャンプー') {
    return { id: 'shampoo', emoji: '💧', label: 'シャンプー', color: '#AF52DE' };
  }
  switch (String(rec.help_process || '').trim()) {
    case 'コーミング':
      return { id: 'combing', emoji: '🪮', label: 'コーミング', color: '#0A84FF' };
    case 'チェック':
      return { id: 'check', emoji: '🔍', label: 'チェック', color: '#30D158' };
    case '呼び出し':
      return { id: 'call', emoji: '🔔', label: '呼び出し', color: '#FF9500' };
    case '':
      return null;
    default:
      return { id: 'other', emoji: '💬', label: String(rec.help_process || 'その他工程').trim(), color: '#5E5CE6' };
  }
};

const hasActiveCheckTimer = (rec?: SalonTimerRecord | null): boolean =>
  Boolean(
    rec &&
      rec.status === 'running' &&
      Number(rec.check_total_seconds || 0) > 0 &&
      Number(rec.check_target_end_timestamp || 0) > 0
  );

const isSeatResetOrIdle = (rec?: SalonTimerRecord | null): boolean => {
  if (!rec) return true;
  const status = String(rec.status || 'idle');
  if (status === 'idle') return true;
  if (status !== 'paused') return false;
  return (
    Number(rec.paused_remaining_seconds || 0) <= 0 &&
    Number(rec.target_end_timestamp || 0) <= 0 &&
    !rec.is_shampooing &&
    !String(rec.help_process || '').trim()
  );
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200 });
  }

  try {
    const payload = await req.json();
    const curr: SalonTimerRecord | null = payload?.record || null;
    const prev: SalonTimerRecord | null = payload?.old_record || null;

    if (!curr || !curr.salon_id) {
      return Response.json({ ok: true, skipped: 'no_record' });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!supabaseUrl || !serviceRoleKey) {
      return Response.json({ ok: false, error: 'missing_supabase_env' }, { status: 500 });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const salonId = curr.salon_id;
    const actorUserId = String(curr.updated_by || '').trim();
    const label = cleanSeatLabel(curr.seat_label || prev?.seat_label);

    // サロン所属メンバー一覧を取得（表示名⇔user_id解決および全員募集通知用）
    const { data: memberRows, error: memberErr } = await supabase
      .from('salon_members')
      .select('user_id, display_name')
      .eq('salon_id', salonId);

    if (memberErr) {
      console.warn('[notify-salon-event] fetch salon_members error:', memberErr);
    }

    const members: SalonMemberRow[] = Array.isArray(memberRows) ? memberRows : [];
    const allMemberUserIds = new Set<string>(
      members.map((m) => String(m.user_id || '').trim()).filter(Boolean)
    );

    const resolveUserIdsByName = (rawName?: string | null): string[] => {
      const target = String(rawName || '').trim();
      if (!target || target === 'スタッフ' || target === '募集中' || target === '未定' || isNoHelp(target)) {
        return [];
      }
      return members
        .filter((m) => String(m.display_name || '').trim() === target)
        .map((m) => String(m.user_id || '').trim())
        .filter(Boolean);
    };

    const collectMainStaffIds = (rec?: SalonTimerRecord | null): Set<string> => {
      const ids = new Set<string>();
      if (!rec) return ids;
      const createdBy = String(rec.created_by || '').trim();
      if (createdBy) ids.add(createdBy);
      for (const uid of resolveUserIdsByName(rec.color_staff_name)) {
        ids.add(uid);
      }
      return ids;
    };

    const collectAssignedStakeholders = (rec?: SalonTimerRecord | null): Set<string> => {
      const ids = collectMainStaffIds(rec);
      if (!rec) return ids;
      if (isNamedAssistant(rec.assistant_staff_name)) {
        for (const uid of resolveUserIdsByName(rec.assistant_staff_name)) ids.add(uid);
      }
      if (isNamedCheckStaff(rec.check_staff_name)) {
        for (const uid of resolveUserIdsByName(rec.check_staff_name)) ids.add(uid);
      }
      return ids;
    };

    const mergeSets = (...sets: Set<string>[]): Set<string> => {
      const out = new Set<string>();
      for (const s of sets) {
        for (const v of s) {
          if (v) out.add(v);
        }
      }
      return out;
    };

    const collectMainTimerAlertCandidates = (rec?: SalonTimerRecord | null): Set<string> => {
      if (!rec) return new Set<string>();
      const assigned = collectAssignedStakeholders(rec);
      const assist = String(rec.assistant_staff_name || '').trim();
      if (isNoHelp(assist)) {
        return assigned;
      }
      if (!assist || assist === '募集中' || assist === '未定') {
        return mergeSets(assigned, allMemberUserIds);
      }
      return assigned;
    };

    const collectCheckTimerAlertCandidates = (rec?: SalonTimerRecord | null): Set<string> => {
      if (!rec) return new Set<string>();
      const assigned = collectAssignedStakeholders(rec);
      const chk = String(rec.check_staff_name || '').trim();
      if (!chk || chk === '募集中' || chk === '未定') {
        return mergeSets(assigned, allMemberUserIds);
      }
      return assigned;
    };

    const prevAssist = String(prev?.assistant_staff_name || '').trim();
    const currAssist = String(curr.assistant_staff_name || '').trim();
    const prevCheck = String(prev?.check_staff_name || '').trim();
    const currCheck = String(curr.check_staff_name || '').trim();
    const prevMeta = resolveActionMeta(prev);
    const currMeta = resolveActionMeta(curr);
    const prevActionId = prevMeta?.id || null;
    const currActionId = currMeta?.id || null;
    const helpProcLabel = String(curr.help_process || currMeta?.label || prev?.help_process || 'シャンプー').trim();
    const checkProcLabel = String(curr.check_process || prev?.check_process || 'チェック').trim();
    const prevHadActiveCheck = hasActiveCheckTimer(prev);
    const currHasActiveCheck = hasActiveCheckTimer(curr);
    const wasPausedActive = Boolean(prev && prev.status === 'paused' && !isSeatResetOrIdle(prev));
    const didResetOrFinishPaused = Boolean(wasPausedActive && isSeatResetOrIdle(curr));

    const plans: NotificationPlan[] = [];

    // ① チェックタイマー完了・解除（大元タイマー稼働継続中）
    if (prevHadActiveCheck && !currHasActiveCheck && curr.status === 'running') {
      const isCompleted = Number(curr.check_total_seconds || 0) > 0;
      const staffSuffix = isNamedCheckStaff(currCheck) ? `（${currCheck}）` : '';
      const targets = mergeSets(
        collectAssignedStakeholders(prev),
        collectAssignedStakeholders(curr),
        collectCheckTimerAlertCandidates(prev)
      );
      plans.push({
        userIds: targets,
        eventType: 'check_done',
        body: isCompleted
          ? `✓ ${label}の${checkProcLabel}完了${staffSuffix}`
          : `⏹ ${label}の${checkProcLabel}タイマーが解除されました`,
        color: isCompleted ? '#30D158' : '#8E8E93',
      });
    }
    // ② 稼働中・超過中・一時停止中タイマーの停止・リセット・施術工程移行（シャンプー・コーミング・呼び出し等）
    else if ((prev?.status === 'running' && curr.status !== 'running') || didResetOrFinishPaused) {
      const targets =
        currActionId === 'call'
          ? mergeSets(allMemberUserIds, collectAssignedStakeholders(prev), collectAssignedStakeholders(curr))
          : mergeSets(
              collectAssignedStakeholders(prev),
              collectAssignedStakeholders(curr),
              collectMainTimerAlertCandidates(prev)
            );

      const namedActor = isNamedAssistant(currAssist) ? currAssist : '';
      let body = didResetOrFinishPaused
        ? `⏹ ${label}のタイマーがリセットされました`
        : `⏹ ${label}のタイマーが停止されました`;
      let color = '#FF9500';

      if (currMeta) {
        color = currMeta.color;
        if (currMeta.id === 'call') {
          body = `🔔 ${label}から呼び出しがあります${namedActor ? `（${namedActor}）` : ''}`;
        } else if (namedActor) {
          body = `${currMeta.emoji} ${label}の${currMeta.label}に ${namedActor} さんが入りました`;
        } else {
          body = `${currMeta.emoji} ${label}が${currMeta.label}に入りました`;
        }
      }

      plans.push({
        userIds: targets,
        eventType: 'stop',
        body,
        color,
      });
    }
    // ③ ヘルプ募集・チェック募集の開始（募集中）
    else if (prevAssist !== '募集中' && currAssist === '募集中') {
      plans.push({
        userIds: new Set(allMemberUserIds),
        eventType: 'recruit',
        body: `📢 ${label}が${helpProcLabel}担当を募集しています！`,
        color: '#FF453A',
      });
    } else if (prevCheck !== '募集中' && currCheck === '募集中') {
      plans.push({
        userIds: new Set(allMemberUserIds),
        eventType: 'recruit',
        body: `📢 ${label}が${checkProcLabel}担当を募集しています！`,
        color: '#FF9F0A',
      });
    }
    // ④ 新規タイマー開始時（担当同時指名＋主担当設定＋関係者/ヘルプ未定メンバーへの開始通知をすべて独立判定）
    else if ((!prev || prev.status !== 'running') && curr.status === 'running') {
      const mins = Math.max(1, Math.round(Number(curr.target_seconds || 600) / 60));
      const notified = new Set<string>();

      if (currHasActiveCheck && isNamedCheckStaff(currCheck)) {
        const chkMins = Math.max(1, Math.round(Number(curr.check_total_seconds || 300) / 60));
        const chkUsers = new Set(resolveUserIdsByName(currCheck));
        if (chkUsers.size > 0) {
          for (const u of chkUsers) notified.add(u);
          plans.push({
            userIds: chkUsers,
            eventType: 'assign_check',
            body: `🔍 ${label}の${checkProcLabel}（${chkMins}分）担当に指定されました`,
            color: '#FF9F0A',
          });
        }
      }
      if (isNamedAssistant(currAssist)) {
        const assistUsers = new Set(resolveUserIdsByName(currAssist).filter((u) => !notified.has(u)));
        if (assistUsers.size > 0) {
          for (const u of assistUsers) notified.add(u);
          plans.push({
            userIds: assistUsers,
            eventType: 'assign_assist',
            body:
              currActionId === 'call'
                ? `🔔 ${label}からあなたへ呼び出しがあります！`
                : `🙋‍♂️ ${label}の${helpProcLabel}（${mins}分）担当に指定されました`,
            color: currActionId === 'call' ? '#FF9500' : '#0A84FF',
          });
        }
      }
      const mainStaffUsers = new Set(Array.from(collectMainStaffIds(curr)).filter((u) => !notified.has(u)));
      if (mainStaffUsers.size > 0) {
        for (const u of mainStaffUsers) notified.add(u);
        plans.push({
          userIds: mainStaffUsers,
          eventType: 'assign_main',
          body: `🎨 ${label}のタイマー（${mins}分）があなた主担当で設定されました`,
          color: '#AF52DE',
        });
      }
      const startCandidates = mergeSets(
        collectMainTimerAlertCandidates(curr),
        currHasActiveCheck ? collectCheckTimerAlertCandidates(curr) : new Set<string>()
      );
      for (const u of notified) startCandidates.delete(u);
      if (startCandidates.size > 0) {
        plans.push({
          userIds: startCandidates,
          eventType: 'timer_start',
          body: `▶️ ${label}のタイマー（${mins}分）が開始されました`,
          color: '#0A84FF',
        });
      }
    }
    // ⑤ 稼働中・停止中における担当者指名・途中チェック追加・施術ステータス変更・残り時間変更
    else {
      const prevColor = String(prev?.color_staff_name || '').trim();
      const currColor = String(curr.color_staff_name || '').trim();
      const isAddingCheck = !prevHadActiveCheck && currHasActiveCheck && prev?.status === 'running' && curr.status === 'running';

      // 5-1. 本人への担当指名通知を最優先でプラン登録（sentTokens により本人へ確実に「担当に指定されました」が届く）
      if ((prevCheck !== currCheck || isAddingCheck) && isNamedCheckStaff(currCheck)) {
        const assignedCheckIds = new Set(resolveUserIdsByName(currCheck));
        if (assignedCheckIds.size > 0) {
          const chkMins = Math.max(1, Math.round(Number(curr.check_total_seconds || 300) / 60));
          plans.push({
            userIds: assignedCheckIds,
            eventType: 'assign_check',
            body: currHasActiveCheck
              ? `🔍 ${label}の${checkProcLabel}（${chkMins}分）担当に指定されました`
              : `🔍 ${label}の${checkProcLabel}担当に指定されました`,
            color: '#FF9F0A',
          });
        }
      }

      if (
        (prevAssist !== currAssist || (prevActionId !== currActionId && Boolean(currActionId))) &&
        isNamedAssistant(currAssist)
      ) {
        const assignedAssistIds = new Set(resolveUserIdsByName(currAssist));
        if (assignedAssistIds.size > 0) {
          plans.push({
            userIds: assignedAssistIds,
            eventType: 'assign_assist',
            body:
              currActionId === 'call'
                ? `🔔 ${label}からあなたへ呼び出しがあります！`
                : `🙋‍♂️ ${label}の${helpProcLabel}担当に指定されました`,
            color: currActionId === 'call' ? '#FF9500' : '#0A84FF',
          });
        }
      }

      if (prevColor !== currColor && currColor && currColor !== 'スタッフ') {
        const assignedMainIds = new Set(resolveUserIdsByName(currColor));
        if (assignedMainIds.size > 0) {
          const mins = Math.max(1, Math.round(Number(curr.target_seconds || 600) / 60));
          plans.push({
            userIds: assignedMainIds,
            eventType: 'assign_main',
            body:
              curr.status === 'running'
                ? `🎨 ${label}のタイマー（${mins}分）があなた主担当で設定されました`
                : `🎨 ${label}の主担当に設定されました`,
            color: '#AF52DE',
          });
        }
      }

      // 5-2. 稼働中席への途中チェック追加（担当者以外の主担当・関係者・未定時の全員へ共有）
      if (isAddingCheck) {
        const chkMins = Math.max(1, Math.round(Number(curr.check_total_seconds || 300) / 60));
        const targets = collectCheckTimerAlertCandidates(curr);
        const staffSuffix = isNamedCheckStaff(currCheck) ? `（担当: ${currCheck}）` : '';
        plans.push({
          userIds: targets,
          eventType: 'add_check',
          body: `🔍 ${label}に${checkProcLabel}（${chkMins}分）が追加されました${staffSuffix}`,
          color: '#FF9F0A',
        });
      }

      // 5-3. タイマー停止を伴わない施術ステータス（呼び出し・コーミング・シャンプー等）の変更
      if (
        currAssist !== '募集中' &&
        (prevActionId !== currActionId || Boolean(prev?.is_shampooing) !== Boolean(curr.is_shampooing)) &&
        !(curr.status === 'running' && prevAssist !== currAssist && isNamedAssistant(currAssist) && currActionId !== 'call')
      ) {
        const targets =
          currActionId === 'call'
            ? mergeSets(allMemberUserIds, collectAssignedStakeholders(prev), collectAssignedStakeholders(curr))
            : mergeSets(
                collectAssignedStakeholders(prev),
                collectAssignedStakeholders(curr),
                collectMainTimerAlertCandidates(prev)
              );
        const namedActor = isNamedAssistant(currAssist) ? currAssist : '';

        if (currMeta) {
          let body = `${currMeta.emoji} ${label}が${currMeta.label}に入りました`;
          if (currMeta.id === 'call') {
            body = `🔔 ${label}から呼び出しがあります！`;
          } else if (curr.status === 'running' && !curr.is_shampooing) {
            body = `${currMeta.emoji} ${label}のヘルプ内容が「${currMeta.label}」に変更されました`;
          } else if (namedActor) {
            body = `${currMeta.emoji} ${label}の${currMeta.label}に ${namedActor} さんが入りました`;
          }
          plans.push({
            userIds: targets,
            eventType: 'status_change',
            body,
            color: currMeta.color,
          });
        } else if (prevMeta && prev?.status !== 'running' && curr.status !== 'running' && !isSeatResetOrIdle(curr)) {
          plans.push({
            userIds: targets,
            eventType: 'status_change',
            body: `✅ ${label}の${prevMeta.label}が完了しました`,
            color: '#30D158',
          });
        }
      }

      // 5-4. ヘルプ担当・チェック担当への参戦／指名共有（主担当・既存関係者へ通知）
      if (prevAssist !== currAssist && isNamedAssistant(currAssist)) {
        const stakeholderIds = mergeSets(collectMainStaffIds(curr), collectAssignedStakeholders(prev));
        for (const uid of resolveUserIdsByName(currAssist)) stakeholderIds.delete(uid);
        if (stakeholderIds.size > 0) {
          plans.push({
            userIds: stakeholderIds,
            eventType: 'assign_assist',
            body: `🤝 ${label}の${helpProcLabel}に ${currAssist} さんが入りました`,
            color: '#30D158',
          });
        }
      }

      if (prevCheck !== currCheck && isNamedCheckStaff(currCheck)) {
        const stakeholderIds = mergeSets(collectMainStaffIds(curr), collectAssignedStakeholders(prev));
        for (const uid of resolveUserIdsByName(currCheck)) stakeholderIds.delete(uid);
        if (stakeholderIds.size > 0) {
          plans.push({
            userIds: stakeholderIds,
            eventType: 'assign_check',
            body: `🔍 ${label}の${checkProcLabel}に ${currCheck} さんが入りました`,
            color: '#30D158',
          });
        }
      }

      // 5-5. 稼働中タイマーの残り時間変更（25秒以上の変更時）
      if (
        prev?.status === 'running' &&
        curr.status === 'running' &&
        Math.abs(Number(curr.target_end_timestamp || 0) - Number(prev.target_end_timestamp || 0)) >= 25000
      ) {
        const targets = mergeSets(collectMainTimerAlertCandidates(curr), collectAssignedStakeholders(curr));
        plans.push({
          userIds: targets,
          eventType: 'time_adjust',
          body: `⏱ ${label}の残り時間が変更されました`,
          color: '#0A84FF',
        });
      }
    }

    // 操作実行者自身（actorUserId）を全プランから除外（自己エコー通知の完全防止）
    const activePlans = plans
      .map((p) => {
        if (actorUserId) {
          p.userIds.delete(actorUserId);
        }
        return p;
      })
      .filter((p) => p.userIds.size > 0);

    if (activePlans.length === 0) {
      return Response.json({ ok: true, sent: 0, reason: 'no_target_recipients' });
    }

    const allTargetUserIds = Array.from(mergeSets(...activePlans.map((p) => p.userIds)));
    const { data: tokenRows, error: tokenErr } = await supabase
      .from('salon_member_push_tokens')
      .select('id, user_id, expo_push_token, platform')
      .eq('salon_id', salonId)
      .in('user_id', allTargetUserIds);

    if (tokenErr) {
      console.error('[notify-salon-event] fetch push tokens error:', tokenErr);
      return Response.json({ ok: false, error: tokenErr.message }, { status: 500 });
    }

    const tokens: PushTokenRow[] = Array.isArray(tokenRows) ? tokenRows : [];
    if (tokens.length === 0) {
      return Response.json({ ok: true, sent: 0, reason: 'no_registered_tokens' });
    }

    const updatedTsMs = curr.updated_at ? new Date(curr.updated_at).getTime() : Date.now();
    const messages: Record<string, unknown>[] = [];
    const sentTokens = new Set<string>();

    for (const plan of activePlans) {
      const notifId = `push_${curr.id}_${plan.eventType}_${updatedTsMs}`;
      for (const row of tokens) {
        if (!plan.userIds.has(String(row.user_id))) continue;
        const expoToken = String(row.expo_push_token || '').trim();
        if (!expoToken || sentTokens.has(expoToken)) continue;
        sentTokens.add(expoToken);

        messages.push({
          to: expoToken,
          title: 'サロン共有通知',
          body: plan.body,
          sound: 'default',
          priority: 'high',
          interruptionLevel: 'time-sensitive',
          channelId: 'salon-shared-events',
          _contentAvailable: true,
          data: {
            salonId,
            timerId: curr.id,
            seatLabel: label,
            notifId,
            eventType: plan.eventType,
            color: plan.color,
          },
        });
      }
    }

    if (messages.length === 0) {
      return Response.json({ ok: true, sent: 0 });
    }

    const invalidTokens: string[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const expoRes = await fetch(EXPO_PUSH_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chunk),
      });

      const expoJson = await expoRes.json().catch(() => null);
      const tickets: Array<{ status?: string; details?: { error?: string } }> = Array.isArray(expoJson?.data)
        ? expoJson.data
        : [];

      tickets.forEach((ticket, idx) => {
        if (ticket?.status === 'error' && ticket?.details?.error === 'DeviceNotRegistered') {
          const badToken = String(chunk[idx]?.to || '');
          if (badToken) invalidTokens.push(badToken);
        }
      });
    }

    // 無効化された古いトークン（DeviceNotRegistered）を自動クリーンアップ
    if (invalidTokens.length > 0) {
      await supabase
        .from('salon_member_push_tokens')
        .delete()
        .in('expo_push_token', invalidTokens);
    }

    return Response.json({
      ok: true,
      sent: messages.length,
      cleanedInvalidTokens: invalidTokens.length,
    });
  } catch (err) {
    console.error('[notify-salon-event] unexpected error:', err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
});
