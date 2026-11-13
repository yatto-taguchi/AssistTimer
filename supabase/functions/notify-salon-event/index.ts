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
  is_check_completed?: boolean | null;
  sort_order?: number | null;
  comment?: string | null;
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
  stateDisc: string;
  title?: string;
  body: string;
  color: string;
}

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

const normalizeSemanticToken = (raw?: unknown): string =>
  String(raw ?? '')
    .trim()
    .replace(/[\s\u3000]+/g, '')
    .replace(/\|/g, '_')
    .toLowerCase();

const buildPeerEventStateDisc = (
  eventType: string,
  params: Record<string, unknown> = {}
): string => {
  const ev = normalizeSemanticToken(eventType);
  if (!ev) return '';
  const canonHelp = (p?: unknown) => {
    const n = normalizeSemanticToken(p);
    return !n || n === 'ヘルプ' || n === 'ヘルプなし' || n === 'none' ? 'シャンプー' : n;
  };
  const canonCheck = (p?: unknown) => {
    const n = normalizeSemanticToken(p);
    return n || 'チェック';
  };
  const canonUnassignNext = (staff?: unknown, proc?: unknown) => {
    const np = normalizeSemanticToken(proc);
    const ns = normalizeSemanticToken(staff);
    if (np === 'ヘルプなし' || ns === 'ヘルプなし' || ns === 'none') return 'ヘルプなし';
    if (!ns || ns === '未定') return 'none';
    return ns;
  };

  switch (ev) {
    case 'assign_assist':
      return `${normalizeSemanticToken(params.nextAssist)}:${canonHelp(params.helpProc)}`;
    case 'unassign_assist':
      return `${normalizeSemanticToken(params.prevAssist)}->${canonUnassignNext(params.nextAssist, params.nextHelpProc)}`;
    case 'assign_check':
      return `${normalizeSemanticToken(params.nextCheckStaff)}:${canonCheck(params.checkProc)}`;
    case 'unassign_check':
      return `${normalizeSemanticToken(params.prevCheckStaff)}->${canonUnassignNext(params.nextCheckStaff, '')}`;
    case 'recruit':
      return `${normalizeSemanticToken(params.recruitProc || params.helpProc || 'シャンプー')}`;
    case 'time_adjust':
    case 'timer_start':
    case 'assign_main':
      return `${Math.round((Number(params.nextEnd) || 0) / 5000)}`;
    case 'add_check':
      return `${Math.round((Number(params.nextCheckEnd) || 0) / 5000)}:${canonCheck(params.checkProc)}`;
    case 'status_change':
      return `${normalizeSemanticToken(params.procLabel || 'none')}:${normalizeSemanticToken(params.nextAssist || 'none')}`;
    case 'stop':
    case 'check_done':
      return 'stop';
    default:
      return normalizeSemanticToken(params.stateDisc || '');
  }
};

const fnv1a32HexUtf8 = (input: string): string => {
  const bytes = new TextEncoder().encode(String(input || ''));
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const normalizeStaffTokenForMask = (raw?: string | null): string => {
  if (raw == null) return '';
  let s = String(raw);
  try {
    s = s.normalize('NFKC');
  } catch {}
  return s.replace(/[\s\u3000\ufeff]+/g, '').toLowerCase();
};

const maskStaffName = (raw?: string | null): string => {
  const norm = normalizeStaffTokenForMask(raw);
  if (!norm) return 'empty';
  if (norm === '未定') return 'unset';
  if (norm === 'ヘルプなし' || norm === 'none') return 'none';
  if (norm === '募集中') return 'recruit';
  if (norm === 'スタイリスト' || norm === 'スタッフ') return 'default_stylist';
  return `stf#${fnv1a32HexUtf8(norm).slice(0, 4)}`;
};

const maskEntityId = (raw?: string | null, prefix = ''): string => {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s);
  if (prefix === 'u' || prefix === 's') {
    return `${prefix}#${s.slice(0, 6).toLowerCase()}`;
  }
  if (isUuid) {
    const p = prefix || 't';
    return `${p}#${s.slice(0, 6).toLowerCase()}`;
  }
  return s.slice(0, 24);
};

const normalizeSeatKeyForStateRev = (seatNumber: number, seatLabel?: string | null): string => {
  let lbl = String(seatLabel ?? '');
  try {
    lbl = lbl.normalize('NFKC');
  } catch {}
  lbl = lbl
    .replace(/[\(（]サンプル[\)）]/g, '')
    .replace(/[\s\u3000\ufeff]+/g, '')
    .replace(/席$/u, '')
    .replace(/^(\d+)番$/u, '$1')
    .toLowerCase();

  if (/^[1-9]\d*$/.test(lbl)) {
    return `s${parseInt(lbl, 10)}`;
  }
  if (lbl.length > 0) {
    return lbl;
  }
  const num = Math.round(Number(seatNumber || 0));
  if (Number.isFinite(num) && num > 0) {
    return `s${num}`;
  }
  return 's0';
};

const toMillisSafeForRev = (rawVal: unknown): number => {
  const n = Number(rawVal || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 10000000000 ? Math.round(n * 1000) : Math.round(n);
};

const isCustomPostStopProcessLabelForRev = (rawProc?: string | null): boolean => {
  const p = String(rawProc ?? '').trim();
  if (!p) return false;
  const lower = p.toLowerCase();
  return (
    p !== 'シャンプー' &&
    p !== 'ヘルプなし' &&
    lower !== 'none' &&
    p !== '募集中' &&
    p !== '未定'
  );
};

const computeCloudRowStateRev = (row?: SalonTimerRecord | null): string => {
  if (!row || typeof row !== 'object') return '00000000';
  const seatKey = normalizeSeatKeyForStateRev(0, row.seat_label);
  const endMs = toMillisSafeForRev(row.target_end_timestamp ?? 0);
  const statusStr = String(row.status || '');
  const runFlag = statusStr === 'running' && endMs > 0 ? 1 : 0;
  const rawShampoo = Boolean(row.is_shampooing);
  const rawPausedSec = Math.max(0, Math.round(Number(row.paused_remaining_seconds ?? 0)));
  const pausedSec =
    !runFlag && statusStr === 'paused' && rawPausedSec > 0
      ? rawPausedSec
      : 0;
  const isPostStopProcessActive =
    runFlag === 0 &&
    pausedSec <= 0 &&
    (rawShampoo || isCustomPostStopProcessLabelForRev(row.help_process));
  const shampooFlag = isPostStopProcessActive ? 1 : 0;
  const endBucket5s = runFlag
    ? Math.round(endMs / 5000)
    : shampooFlag === 0 && pausedSec > 0
      ? pausedSec
      : 0;
  const checkTotalSec = Number(row.check_total_seconds ?? 0);
  const chkEndMs = toMillisSafeForRev(row.check_target_end_timestamp ?? 0);
  const isCheckDone = Boolean(row.is_check_completed);
  const chkFlag = runFlag === 1 && !isCheckDone && checkTotalSec > 0 && chkEndMs > 0 ? 1 : 0;
  const checkEndBucket5s = chkFlag ? Math.round(chkEndMs / 5000) : 0;
  const shouldKeepAssist = runFlag === 1 || shampooFlag === 1 || pausedSec > 0;
  const assistMasked = shouldKeepAssist ? maskStaffName(row.assistant_staff_name ?? '') : 'empty';
  const checkMasked = chkFlag === 1 ? maskStaffName(row.check_staff_name ?? '') : 'empty';
  const canonical = `${seatKey}|${runFlag}|${endBucket5s}|${chkFlag}|${checkEndBucket5s}|${shampooFlag}|${assistMasked}|${checkMasked}`;
  return fnv1a32HexUtf8(canonical);
};

const buildExpoCollapseId = (timerId: string, eventType: string, stateDisc = ''): string => {
  const normTimer = normalizeSemanticToken(timerId);
  const normEvt = normalizeSemanticToken(eventType);
  const normDisc = normalizeSemanticToken(stateDisc);
  const shortTimer = normTimer.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'seat';
  const shortEvt = normEvt.replace(/[^a-z0-9_]/g, '').slice(0, 12) || 'evt';
  const hash8 = fnv1a32HexUtf8(`${normTimer}|${normEvt}|${normDisc}`);
  return `at:${shortTimer}:${shortEvt}:${hash8}`;
};

const buildPeerEventSemanticKey = (
  timerIdOrLabel: string,
  eventType: string,
  actorId = '',
  stateDisc = ''
): string => {
  const target = normalizeSemanticToken(timerIdOrLabel);
  const ev = normalizeSemanticToken(eventType);
  const actor = normalizeSemanticToken(actorId);
  const disc = normalizeSemanticToken(stateDisc);
  if (!target || !ev) return '';
  if (disc) return `${target}|${ev}|${actor}|${disc}`;
  return actor ? `${target}|${ev}|${actor}` : `${target}|${ev}`;
};

const parseSeatNumberFromLabel = (label: string, sortOrder?: number | null): number => {
  const m = String(label || '').match(/(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const so = Number(sortOrder || 0);
  return Number.isFinite(so) && so > 0 ? Math.round(so) : 0;
};

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
  if (rec.is_shampooing || (rec.status === 'running' && rec.help_process === 'シャンプー')) {
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
    const traceId =
      typeof payload?.traceId === 'string' && payload.traceId.trim()
        ? payload.traceId.trim().slice(0, 40)
        : `tr_db_${Date.now().toString(36)}`;
    const triggerType = Array.isArray(payload?.alreadyNotifiedTokens)
      ? 'client_fallback'
      : 'db_webhook';
    const stateRev = computeCloudRowStateRev(curr);
    const alreadyNotifiedCount = Array.isArray(payload?.alreadyNotifiedTokens)
      ? payload.alreadyNotifiedTokens.map((t: unknown) => String(t || '').trim()).filter(Boolean).length
      : 0;
    const emitEdgeTraceLog = (
      res: 'ok' | 'skip' | 'err',
      rsn: string,
      eventTypes: string[],
      targetCount: number,
      tokenCount: number,
      sentCount: number
    ) => {
      console.log(
        JSON.stringify({
          schema: 'salon_edge_trace_v1',
          hop: 'C_EDGE_PUSH',
          traceId,
          stateRev,
          triggerType,
          dbEvent: String(payload?.type || 'UPDATE'),
          salon: maskEntityId(salonId, 's'),
          actor: maskEntityId(actorUserId, 'u'),
          seat: `${normalizeSeatKeyForStateRev(0, label)}(${maskEntityId(curr.id, 't')})`,
          res,
          rsn,
          eventTypes,
          targetCount,
          tokenCount,
          alreadyNotifiedCount,
          sentCount,
        })
      );
    };

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

    const normalizeStaffName = (name?: string | null): string =>
      String(name || '')
        .normalize('NFKC')
        .trim()
        .replace(/[\s\u3000]+/g, '')
        .toLowerCase();

    const resolveUserIdsByName = (rawName?: string | null): string[] => {
      const target = String(rawName || '').trim();
      const normalizedTarget = normalizeStaffName(target);
      if (
        !normalizedTarget ||
        target === 'スタッフ' ||
        target === 'スタイリスト' ||
        normalizedTarget === 'スタイリスト' ||
        target === '募集中' ||
        target === '未定' ||
        isNoHelp(target)
      ) {
        return [];
      }
      return members
        .filter((m) => {
          const memberName = String(m.display_name || '').trim();
          return memberName === target || normalizeStaffName(memberName) === normalizedTarget;
        })
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

    // ★ 仕様変更（Issue #9）: アラーム・確認通知の対象を「その客席の施術担当（作成者/主担当 ＋ 明示的に指名されたヘルプ担当・チェック担当）」のみに厳密限定。
    //   ヘルプやチェックが「未定（空文字）」の場合にサロン全員へ通知を拡散するフォールバックを完全廃止し、無関係なスタッフの端末・Watchは鳴らさない。
    const collectMainTimerAlertCandidates = (rec?: SalonTimerRecord | null): Set<string> => {
      if (!rec) return new Set<string>();
      return collectAssignedStakeholders(rec);
    };

    const collectCheckTimerAlertCandidates = (rec?: SalonTimerRecord | null): Set<string> => {
      if (!rec) return new Set<string>();
      return collectAssignedStakeholders(rec);
    };

    const prevColor = String(prev?.color_staff_name || '').trim();
    const currColor = String(curr.color_staff_name || '').trim();
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
    const wasPausedActive = Boolean(prev && prev.status === 'paused' && !prevMeta && !isSeatResetOrIdle(prev));
    const didResetOrFinishPaused = Boolean(wasPausedActive && isSeatResetOrIdle(curr));

    const prevUpdatedBy = String(prev?.updated_by || '').trim();
    const prevUpdatedAtMs = prev?.updated_at ? Date.parse(String(prev.updated_at)) : 0;
    const currUpdatedAtMs = curr.updated_at ? Date.parse(String(curr.updated_at)) : Date.now();
    const isRecentPrevStopperWindow =
      Boolean(prevUpdatedBy) &&
      (prevUpdatedAtMs <= 0 ||
        !Number.isFinite(prevUpdatedAtMs) ||
        !Number.isFinite(currUpdatedAtMs) ||
        Math.abs(currUpdatedAtMs - prevUpdatedAtMs) <= 30 * 60 * 1000);

    const resolveActorDisplayName = (uid?: string | null): string => {
      const targetUid = String(uid || '').trim();
      if (!targetUid) return '';
      const found = members.find((m) => String(m.user_id || '').trim() === targetUid);
      return String(found?.display_name || '').trim();
    };

    // ★ Issue #12: 1人目が先に「タイマー停止」または「シャンプー等の工程移行」を行った後、
    //   2人目が遅れて「タイマー停止」を押した場合（二次停止: paused -> paused で工程・担当者・コメント変化なし、かつ updated_by が別スタッフへ更新）
    const isSecondaryStopTimer = Boolean(
      prev &&
        prev.status === 'paused' &&
        curr.status === 'paused' &&
        !didResetOrFinishPaused &&
        Number(curr.target_seconds || 0) <= 0 &&
        Number(curr.paused_remaining_seconds || 0) <= 0 &&
        Number(curr.target_end_timestamp || 0) <= 0 &&
        !prevHadActiveCheck &&
        !currHasActiveCheck &&
        prevActionId === currActionId &&
        Boolean(prev.is_shampooing) === Boolean(curr.is_shampooing) &&
        prevColor === currColor &&
        prevAssist === currAssist &&
        prevCheck === currCheck &&
        cleanSeatLabel(prev.seat_label) === cleanSeatLabel(curr.seat_label) &&
        String(prev.comment || '').trim() === String(curr.comment || '').trim() &&
        actorUserId &&
        prevUpdatedBy &&
        actorUserId !== prevUpdatedBy &&
        isRecentPrevStopperWindow
    );

    const nowMs = Date.now();
    const currEnd = Number(curr.target_end_timestamp || 0);
    const prevEnd = Number(prev?.target_end_timestamp || 0);
    const currCheckEnd = Number(curr.check_target_end_timestamp || 0);
    const formatRemainingSuffix = (targetTs: number): string => {
      if (!(targetTs > 0)) return '';
      if (targetTs <= nowMs) return '（超過中）';
      const remMin = Math.max(1, Math.round((targetTs - nowMs) / 60000));
      return `（残り約${remMin}分）`;
    };
    const actorDisplayName = resolveActorDisplayName(actorUserId);
    const actorPrefix =
      actorDisplayName && actorDisplayName !== 'スタイリスト' ? `${actorDisplayName}さんが` : '';

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
        stateDisc: buildPeerEventStateDisc('check_done'),
        title: `✓ ${label} ${checkProcLabel}完了`,
        body: isCompleted
          ? `✓ ${label}の${checkProcLabel}完了${staffSuffix}`
          : `⏹ ${label}の${checkProcLabel}タイマーが解除されました`,
        color: isCompleted ? '#30D158' : '#8E8E93',
      });
    }
    // ② 稼働中・超過中・一時停止中タイマーの停止・リセット・施術工程移行（シャンプー・コーミング・呼び出し等）・または2人目による後追い停止
    else if (
      (prev?.status === 'running' && curr.status !== 'running') ||
      didResetOrFinishPaused ||
      isSecondaryStopTimer
    ) {
      const prevStopperSet =
        isRecentPrevStopperWindow && prevUpdatedBy ? new Set<string>([prevUpdatedBy]) : new Set<string>();
      const targets =
        currActionId === 'call' && !isSecondaryStopTimer
          ? mergeSets(
              allMemberUserIds,
              collectAssignedStakeholders(prev),
              collectAssignedStakeholders(curr),
              prevStopperSet
            )
          : mergeSets(
              collectAssignedStakeholders(prev),
              collectAssignedStakeholders(curr),
              collectMainTimerAlertCandidates(prev),
              prevStopperSet
            );

      const stopperDisplayName = actorDisplayName;
      const namedActor = stopperDisplayName || (isNamedAssistant(currAssist) ? currAssist : '');
      let body = didResetOrFinishPaused
        ? `⏹ ${label}のタイマーがリセットされました`
        : isSecondaryStopTimer && namedActor
        ? `⏹ ${label}のタイマーを ${namedActor} さんが止めました`
        : `⏹ ${label}のタイマーが停止されました`;
      let color = '#FF9500';
      let title = `⏹ ${label} タイマー停止`;

      if (currMeta && !isSecondaryStopTimer) {
        color = currMeta.color;
        title = `⏹ ${label} ${currMeta.label}移行`;
        if (currMeta.id === 'call') {
          title = `🔔 ${label} 呼び出し`;
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
        stateDisc: buildPeerEventStateDisc('stop'),
        title,
        body,
        color,
      });
    }
    // ③ 新規タイマー開始時（担当同時指名＋主担当設定＋募集＋関係者開始通知をすべて独立判定）
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
            stateDisc: buildPeerEventStateDisc('assign_check', {
              nextCheckStaff: currCheck,
              checkProc: checkProcLabel,
            }),
            title: `🔔 ${label} ${checkProcLabel}担当指名`,
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
            stateDisc: buildPeerEventStateDisc('assign_assist', {
              nextAssist: currAssist,
              helpProc: helpProcLabel,
            }),
            title: `🔔 ${label} ${helpProcLabel}担当指名`,
            body:
              currActionId === 'call'
                ? `🔔 ${label}からあなたへ呼び出しがあります！`
                : `🙋‍♂️ ${label}の${helpProcLabel}（${mins}分）担当に指定されました`,
            color: currActionId === 'call' ? '#FF9500' : '#0A84FF',
          });
        }
      }
      const mainStaffUsers = new Set(Array.from(collectMainStaffIds(curr)).filter((u) => !notified.has(u)));
      if (mainStaffUsers.size > 0 && currColor && currColor !== 'スタッフ' && currColor !== 'スタイリスト') {
        for (const u of mainStaffUsers) notified.add(u);
        plans.push({
          userIds: mainStaffUsers,
          eventType: 'assign_main',
          stateDisc: buildPeerEventStateDisc('assign_main', { nextEnd: currEnd }),
          title: `🔔 ${label} 主担当指名`,
          body: `🎨 ${label}のタイマー（${mins}分）があなた主担当で設定されました`,
          color: '#AF52DE',
        });
      }
      if (currAssist === '募集中') {
        const recUsers = new Set(Array.from(allMemberUserIds).filter((u) => !notified.has(u)));
        for (const u of recUsers) notified.add(u);
        if (recUsers.size > 0) {
          plans.push({
            userIds: recUsers,
            eventType: 'recruit',
            stateDisc: buildPeerEventStateDisc('recruit', { recruitProc: helpProcLabel }),
            title: `📢 ${label} ${helpProcLabel}ヘルプ募集`,
            body: `📢 ${label}が${helpProcLabel}（${mins}分）担当を募集しています！`,
            color: '#FF453A',
          });
        }
      } else if (currCheck === '募集中') {
        const chkMins = Math.max(1, Math.round(Number(curr.check_total_seconds || 300) / 60));
        const recUsers = new Set(Array.from(allMemberUserIds).filter((u) => !notified.has(u)));
        for (const u of recUsers) notified.add(u);
        if (recUsers.size > 0) {
          plans.push({
            userIds: recUsers,
            eventType: 'recruit',
            stateDisc: buildPeerEventStateDisc('recruit', { recruitProc: checkProcLabel }),
            title: `📢 ${label} ${checkProcLabel}ヘルプ募集`,
            body: `📢 ${label}が${checkProcLabel}（${chkMins}分）担当を募集しています！`,
            color: '#FF9F0A',
          });
        }
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
          stateDisc: buildPeerEventStateDisc('timer_start', { nextEnd: currEnd }),
          title: `▶️ ${label} タイマー開始`,
          body: `▶️ ${label}のタイマー（${mins}分）が開始されました`,
          color: '#0A84FF',
        });
      }
    }
    // ④ 稼働中・停止中における担当者指名・解除・募集・途中チェック追加・施術ステータス変更・残り時間変更
    else {
      const isAddingCheck = !prevHadActiveCheck && currHasActiveCheck && prev?.status === 'running' && curr.status === 'running';
      const prevStopperSet =
        isRecentPrevStopperWindow && prevUpdatedBy ? new Set<string>([prevUpdatedBy]) : new Set<string>();

      // 4-1. 本人への担当指名通知を最優先でプラン登録
      if (
        (normalizeStaffName(prevCheck) !== normalizeStaffName(currCheck) || isAddingCheck) &&
        isNamedCheckStaff(currCheck) &&
        currCheck !== 'スタッフ' &&
        currCheck !== 'スタイリスト'
      ) {
        const assignedCheckIds = new Set(resolveUserIdsByName(currCheck));
        if (assignedCheckIds.size > 0) {
          const chkMins = Math.max(1, Math.round(Number(curr.check_total_seconds || 300) / 60));
          const remSuffix = isAddingCheck
            ? `（${chkMins}分）`
            : (currHasActiveCheck ? formatRemainingSuffix(currCheckEnd) : '');
          plans.push({
            userIds: assignedCheckIds,
            eventType: 'assign_check',
            stateDisc: buildPeerEventStateDisc('assign_check', {
              nextCheckStaff: currCheck,
              checkProc: checkProcLabel,
            }),
            title: `🔔 ${label} ${checkProcLabel}担当指名`,
            body: `🔍 ${label}の${checkProcLabel}担当に指定されました${remSuffix}`,
            color: '#FF9F0A',
          });
        }
      }

      // 4-1b. 稼働中のチェック担当解除・別スタッフ変更 (unassign_check)
      if (
        prev?.status === 'running' &&
        curr.status === 'running' &&
        prevHadActiveCheck &&
        currHasActiveCheck &&
        isNamedCheckStaff(prevCheck) &&
        prevCheck !== 'スタッフ' &&
        prevCheck !== 'スタイリスト' &&
        normalizeStaffName(prevCheck) !== normalizeStaffName(currCheck)
      ) {
        const prevChkUsers = new Set(resolveUserIdsByName(prevCheck));
        if (prevChkUsers.size > 0) {
          const unassignChkBody =
            isNamedCheckStaff(currCheck) && currCheck !== 'スタッフ' && currCheck !== 'スタイリスト'
              ? `${label}: ${actorPrefix}${checkProcLabel}担当を${currCheck}さんに変更しました`
              : `${label}: ${actorPrefix}${checkProcLabel}担当から外れました`;
          plans.push({
            userIds: prevChkUsers,
            eventType: 'unassign_check',
            stateDisc: buildPeerEventStateDisc('unassign_check', {
              prevCheckStaff: prevCheck,
              nextCheckStaff: currCheck,
            }),
            title: `ℹ️ ${label} ${checkProcLabel}担当解除`,
            body: unassignChkBody,
            color: '#8E8E93',
          });
        }
      }

      if (
        (curr.status === 'running' || !currMeta || currActionId === 'call') &&
        (normalizeStaffName(prevAssist) !== normalizeStaffName(currAssist) ||
          (prevActionId !== currActionId && Boolean(currActionId))) &&
        isNamedAssistant(currAssist) &&
        currAssist !== 'スタッフ' &&
        currAssist !== 'スタイリスト'
      ) {
        const assignedAssistIds = new Set(resolveUserIdsByName(currAssist));
        if (assignedAssistIds.size > 0) {
          const remSuffix = curr.status === 'running' && currActionId !== 'call' ? formatRemainingSuffix(currEnd) : '';
          plans.push({
            userIds: assignedAssistIds,
            eventType: 'assign_assist',
            stateDisc: buildPeerEventStateDisc('assign_assist', {
              nextAssist: currAssist,
              helpProc: helpProcLabel,
            }),
            title: `🔔 ${label} ${helpProcLabel}担当指名`,
            body:
              currActionId === 'call'
                ? `🔔 ${label}からあなたへ呼び出しがあります！`
                : `🙋‍♂️ ${label}の${helpProcLabel}担当に指定されました${remSuffix}`,
            color: currActionId === 'call' ? '#FF9500' : '#0A84FF',
          });
        }
      }

      // 4-1c. 稼働中のヘルプ担当解除・別スタッフ変更 (unassign_assist)
      if (
        prev?.status === 'running' &&
        curr.status === 'running' &&
        isNamedAssistant(prevAssist) &&
        prevAssist !== 'スタッフ' &&
        prevAssist !== 'スタイリスト' &&
        normalizeStaffName(prevAssist) !== normalizeStaffName(currAssist)
      ) {
        const prevAssistUsers = new Set(resolveUserIdsByName(prevAssist));
        if (prevAssistUsers.size > 0) {
          const nextHelpRaw = String(curr.help_process || '').trim();
          const isExplicitNoHelp = isNoHelp(currAssist) || nextHelpRaw === 'ヘルプなし';
          const unassignBody = isExplicitNoHelp
            ? `${label}: ${actorPrefix}ヘルプ担当を解除しました（ヘルプなし）`
            : isNamedAssistant(currAssist) && currAssist !== 'スタッフ' && currAssist !== 'スタイリスト'
              ? `${label}: ${actorPrefix}ヘルプ担当を${currAssist}さんに変更しました`
              : `${label}: ${actorPrefix}ヘルプ担当から外れました`;
          plans.push({
            userIds: prevAssistUsers,
            eventType: 'unassign_assist',
            stateDisc: buildPeerEventStateDisc('unassign_assist', {
              prevAssist,
              nextAssist: currAssist,
              nextHelpProc: nextHelpRaw,
            }),
            title: `ℹ️ ${label} ヘルプ担当解除`,
            body: unassignBody,
            color: '#8E8E93',
          });
        }
      }

      if (
        normalizeStaffName(prevColor) !== normalizeStaffName(currColor) &&
        currColor &&
        currColor !== 'スタッフ' &&
        currColor !== 'スタイリスト'
      ) {
        const assignedMainIds = new Set(resolveUserIdsByName(currColor));
        if (assignedMainIds.size > 0) {
          const mins = Math.max(1, Math.round(Number(curr.target_seconds || 600) / 60));
          plans.push({
            userIds: assignedMainIds,
            eventType: 'assign_main',
            stateDisc: buildPeerEventStateDisc('assign_main', { nextEnd: currEnd }),
            title: `🔔 ${label} 主担当指名`,
            body:
              curr.status === 'running'
                ? `🎨 ${label}のタイマー（${mins}分）があなた主担当で設定されました`
                : `🎨 ${label}の主担当に設定されました`,
            color: '#AF52DE',
          });
        }
      }

      // 4-1d. 稼働途中の全員募集への切り替え（前任者には上の unassign が優先配信され、残りのメンバーに募集が届く）
      if (prevAssist !== '募集中' && currAssist === '募集中') {
        const remSuffix = curr.status === 'running' ? formatRemainingSuffix(currEnd) : '';
        plans.push({
          userIds: new Set(allMemberUserIds),
          eventType: 'recruit',
          stateDisc: buildPeerEventStateDisc('recruit', { recruitProc: helpProcLabel }),
          title: `📢 ${label} ${helpProcLabel}ヘルプ募集`,
          body: `📢 ${label}が${helpProcLabel}担当を募集しています！${remSuffix}`,
          color: '#FF453A',
        });
      } else if (prevCheck !== '募集中' && currCheck === '募集中') {
        const chkMins = Math.max(1, Math.round(Number(curr.check_total_seconds || 300) / 60));
        const remSuffix = isAddingCheck
          ? `（${chkMins}分）`
          : (currHasActiveCheck ? formatRemainingSuffix(currCheckEnd) : '');
        plans.push({
          userIds: new Set(allMemberUserIds),
          eventType: 'recruit',
          stateDisc: buildPeerEventStateDisc('recruit', { recruitProc: checkProcLabel }),
          title: `📢 ${label} ${checkProcLabel}ヘルプ募集`,
          body: `📢 ${label}が${checkProcLabel}担当を募集しています！${remSuffix}`,
          color: '#FF9F0A',
        });
      }

      // 4-2. 稼働中席への途中チェック追加（担当者以外の主担当・関係者へ共有）
      if (isAddingCheck) {
        const chkMins = Math.max(1, Math.round(Number(curr.check_total_seconds || 300) / 60));
        const targets = collectCheckTimerAlertCandidates(curr);
        const staffSuffix = isNamedCheckStaff(currCheck) ? `（担当: ${currCheck}）` : '';
        plans.push({
          userIds: targets,
          eventType: 'add_check',
          stateDisc: buildPeerEventStateDisc('add_check', {
            nextCheckEnd: currCheckEnd,
            checkProc: checkProcLabel,
          }),
          title: `⏱ ${label} ${checkProcLabel}タイマー追加`,
          body: `🔍 ${label}に${checkProcLabel}（${chkMins}分）が追加されました${staffSuffix}`,
          color: '#FF9F0A',
        });
      }

      // 4-3. タイマー停止を伴わない施術ステータス（呼び出し・コーミング・シャンプー等）の変更
      if (
        currAssist !== '募集中' &&
        (prevActionId !== currActionId || Boolean(prev?.is_shampooing) !== Boolean(curr.is_shampooing)) &&
        !(curr.status === 'running' && prevAssist !== currAssist && isNamedAssistant(currAssist) && currActionId !== 'call')
      ) {
        const targets =
          currActionId === 'call'
            ? mergeSets(
                allMemberUserIds,
                collectAssignedStakeholders(prev),
                collectAssignedStakeholders(curr),
                prevStopperSet
              )
            : mergeSets(
                collectAssignedStakeholders(prev),
                collectAssignedStakeholders(curr),
                collectMainTimerAlertCandidates(prev),
                prevStopperSet
              );
        const namedActor = actorDisplayName || (isNamedAssistant(currAssist) ? currAssist : '');

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
            stateDisc: buildPeerEventStateDisc('status_change', {
              procLabel: currMeta.label,
              nextAssist: currAssist,
            }),
            title: currMeta.id === 'call' ? `🔔 ${label} 呼び出し` : `🚿 ${label} ${currMeta.label}開始`,
            body,
            color: currMeta.color,
          });
        } else if (prevMeta && prev?.status !== 'running' && curr.status !== 'running') {
          plans.push({
            userIds: targets,
            eventType: 'status_change',
            stateDisc: buildPeerEventStateDisc('status_change', {
              procLabel: `done_${prevMeta.label}`,
              nextAssist: currAssist,
            }),
            title: `✅ ${label} ${prevMeta.label}完了`,
            body: `✅ ${label}の${prevMeta.label}が完了しました`,
            color: '#30D158',
          });
        }
      }

      // 4-4. ヘルプ担当・チェック担当への参戦／指名共有（主担当・既存関係者・直近停止者へ通知）
      if (normalizeStaffName(prevAssist) !== normalizeStaffName(currAssist) && isNamedAssistant(currAssist)) {
        const mainStaffOfCurr = collectMainStaffIds(curr);
        const stakeholderIds = mergeSets(
          mainStaffOfCurr,
          collectAssignedStakeholders(prev),
          prevStopperSet
        );
        for (const uid of resolveUserIdsByName(currAssist)) stakeholderIds.delete(uid);
        for (const uid of resolveUserIdsByName(prevAssist)) {
          if (!mainStaffOfCurr.has(uid)) stakeholderIds.delete(uid);
        }
        if (stakeholderIds.size > 0) {
          const remSuffix = curr.status === 'running' ? formatRemainingSuffix(currEnd) : '';
          plans.push({
            userIds: stakeholderIds,
            eventType: 'assign_assist',
            stateDisc: buildPeerEventStateDisc('assign_assist', {
              nextAssist: currAssist,
              helpProc: helpProcLabel,
            }),
            title: `🔔 ${label} ${helpProcLabel}担当変更`,
            body: `🤝 ${label}の${helpProcLabel}に ${currAssist} さんが入りました${remSuffix}`,
            color: '#30D158',
          });
        }
      }

      if (normalizeStaffName(prevCheck) !== normalizeStaffName(currCheck) && isNamedCheckStaff(currCheck)) {
        const mainStaffOfCurr = collectMainStaffIds(curr);
        const stakeholderIds = mergeSets(mainStaffOfCurr, collectAssignedStakeholders(prev));
        for (const uid of resolveUserIdsByName(currCheck)) stakeholderIds.delete(uid);
        for (const uid of resolveUserIdsByName(prevCheck)) {
          if (!mainStaffOfCurr.has(uid)) stakeholderIds.delete(uid);
        }
        if (stakeholderIds.size > 0) {
          const remSuffix = currHasActiveCheck ? formatRemainingSuffix(currCheckEnd) : '';
          plans.push({
            userIds: stakeholderIds,
            eventType: 'assign_check',
            stateDisc: buildPeerEventStateDisc('assign_check', {
              nextCheckStaff: currCheck,
              checkProc: checkProcLabel,
            }),
            title: `🔔 ${label} ${checkProcLabel}担当変更`,
            body: `🔍 ${label}の${checkProcLabel}に ${currCheck} さんが入りました${remSuffix}`,
            color: '#30D158',
          });
        }
      }

      // 4-5. 稼働中タイマーの残り時間変更（25秒以上の変更時）
      if (
        prev?.status === 'running' &&
        curr.status === 'running' &&
        Math.abs(currEnd - prevEnd) >= 25000
      ) {
        const remSec = Math.max(0, Math.round((currEnd - nowMs) / 1000));
        const remMins = Math.max(1, Math.round(remSec / 60));
        const targets = mergeSets(collectMainTimerAlertCandidates(curr), collectAssignedStakeholders(curr));
        plans.push({
          userIds: targets,
          eventType: 'time_adjust',
          stateDisc: buildPeerEventStateDisc('time_adjust', { nextEnd: currEnd }),
          title: `⏱ ${label} 残り時間変更`,
          body: `⏱ ${label}の残り時間が変更されました（残り約${remMins}分）`,
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
      emitEdgeTraceLog('skip', 'no_target_recipients', [], 0, 0, 0);
      return Response.json({ ok: true, sent: 0, reason: 'no_target_recipients' });
    }

    const planEventTypes = activePlans.map((p) => p.eventType);
    const allTargetUserIds = Array.from(mergeSets(...activePlans.map((p) => p.userIds)));
    const { data: tokenRows, error: tokenErr } = await supabase
      .from('salon_member_push_tokens')
      .select('id, user_id, expo_push_token, platform')
      .eq('salon_id', salonId)
      .in('user_id', allTargetUserIds);

    if (tokenErr) {
      console.error('[notify-salon-event] fetch push tokens error:', tokenErr);
      emitEdgeTraceLog('err', 'token_query_err', planEventTypes, allTargetUserIds.length, 0, 0);
      return Response.json({ ok: false, error: tokenErr.message }, { status: 500 });
    }

    const tokens: PushTokenRow[] = Array.isArray(tokenRows) ? tokenRows : [];
    if (tokens.length === 0) {
      emitEdgeTraceLog('skip', 'no_registered_tokens', planEventTypes, allTargetUserIds.length, 0, 0);
      return Response.json({ ok: true, sent: 0, reason: 'no_registered_tokens' });
    }

    const updatedTsMs = curr.updated_at ? new Date(curr.updated_at).getTime() : nowMs;
    const seatNumber = parseSeatNumberFromLabel(label, (curr as { sort_order?: number | null }).sort_order);
    const seatSnapshot = {
      id: curr.id,
      seatNumber,
      seatLabel: label,
      status: curr.status === 'running' && currEnd > 0 ? 'running' : 'paused',
      targetSeconds: Number(curr.target_seconds || 0) || 0,
      targetEndTimestamp: currEnd,
      pausedRemainingSeconds: Number(curr.paused_remaining_seconds || 0) || 0,
      createdBy: curr.created_by || null,
      colorStaffName: curr.color_staff_name || null,
      assistantStaffName: curr.assistant_staff_name || null,
      helpProcess: curr.help_process || null,
      isShampooing: Boolean(curr.is_shampooing),
      actionStatus: currActionId || 'normal',
      checkTargetEndTimestamp: currCheckEnd > 0 ? currCheckEnd : null,
      checkTotalSeconds: Number(curr.check_total_seconds || 0) || null,
      checkProcess: curr.check_process || null,
      checkStaffName: curr.check_staff_name || null,
      updatedBy: actorUserId || null,
      updatedAt: Number.isFinite(updatedTsMs) && updatedTsMs > 0 ? updatedTsMs : nowMs,
      traceId,
    };

    const messages: Record<string, unknown>[] = [];
    const sentTokens = new Set<string>(
      Array.isArray(payload?.alreadyNotifiedTokens)
        ? payload.alreadyNotifiedTokens
            .map((t: unknown) => String(t || '').trim())
            .filter(Boolean)
        : []
    );

    for (const plan of activePlans) {
      const notifId = `push_${curr.id}_${plan.eventType}_${updatedTsMs}`;
      const semanticKey = buildPeerEventSemanticKey(
        curr.id,
        plan.eventType,
        actorUserId,
        plan.stateDisc
      );
      const collapseId = buildExpoCollapseId(curr.id, plan.eventType, plan.stateDisc);
      const isGentleUnassign =
        plan.eventType === 'unassign_assist' || plan.eventType === 'unassign_check';
      for (const row of tokens) {
        if (!plan.userIds.has(String(row.user_id))) continue;
        const expoToken = String(row.expo_push_token || '').trim();
        if (!expoToken || sentTokens.has(expoToken)) continue;
        sentTokens.add(expoToken);

        messages.push({
          to: expoToken,
          title: plan.title || 'サロン共有通知',
          body: plan.body,
          ...(isGentleUnassign ? {} : { sound: 'default' }),
          priority: 'high',
          interruptionLevel: isGentleUnassign ? 'active' : 'time-sensitive',
          channelId: 'salon-shared-events',
          _contentAvailable: true,
          collapseId,
          data: {
            type: 'SALON_EVENT_PUSH',
            salonId,
            timerId: curr.id,
            seatNumber,
            seatLabel: label,
            notifId,
            eventType: plan.eventType,
            isGentleInfo: isGentleUnassign,
            stateDisc: plan.stateDisc,
            semanticKey,
            notifText: plan.body,
            notifColor: plan.color,
            color: plan.color,
            updatedBy: actorUserId || null,
            actorId: actorUserId || null,
            updatedAt: Number.isFinite(updatedTsMs) && updatedTsMs > 0 ? updatedTsMs : nowMs,
            traceId,
            seatSnapshot,
          },
        });
      }
    }

    if (messages.length === 0) {
      emitEdgeTraceLog('skip', 'all_already_notified', planEventTypes, allTargetUserIds.length, tokens.length, 0);
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

    emitEdgeTraceLog(
      'ok',
      'expo_sent',
      planEventTypes,
      allTargetUserIds.length,
      tokens.length,
      messages.length
    );

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
