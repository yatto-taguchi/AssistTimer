-- ============================================================================
-- Issue #6: 他端末でのタイマー停止・操作時の関係者Watch通知保証＆バックグラウンドプッシュ通知導入
-- 1. salon_timers.updated_by カラム追加 & REPLICA IDENTITY FULL 設定
-- 2. salon_member_push_tokens テーブル作成・インデックス・RLSポリシー設定
-- 3. pg_net トリガーによる Edge Function (notify-salon-event) 非同期呼び出し
-- ============================================================================

-- pg_net 拡張を有効化（DBトリガーから Edge Function を非同期HTTP呼び出しするため）
create extension if not exists pg_net with schema extensions;

-- Realtime UPDATE / DELETE イベントで old レコード全カラム（created_by 等）を確実に配信するため FULL に設定
alter table public.salon_timers replica identity full;

-- 操作実行者の user_id を記録し、元のタイマー作成者（created_by）を上書きせず保持するためのカラム
alter table public.salon_timers
  add column if not exists updated_by text;

-- サロン参加メンバーごとの Expo Push Token 管理テーブル
create table if not exists public.salon_member_push_tokens (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  user_id text not null,
  expo_push_token text not null,
  platform text not null default 'ios',
  updated_at timestamptz not null default now(),
  unique (salon_id, user_id, expo_push_token)
);

create index if not exists idx_salon_member_push_tokens_salon_id
  on public.salon_member_push_tokens (salon_id);

create index if not exists idx_salon_member_push_tokens_salon_user
  on public.salon_member_push_tokens (salon_id, user_id);

create index if not exists idx_salon_member_push_tokens_token
  on public.salon_member_push_tokens (expo_push_token);

-- RLS（Row Level Security）設定（端末固有UUIDベースの匿名クライアント構成に準拠）
alter table public.salon_member_push_tokens enable row level security;

drop policy if exists "Allow anon and authenticated select push tokens" on public.salon_member_push_tokens;
create policy "Allow anon and authenticated select push tokens"
  on public.salon_member_push_tokens
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Allow anon and authenticated insert push tokens" on public.salon_member_push_tokens;
create policy "Allow anon and authenticated insert push tokens"
  on public.salon_member_push_tokens
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Allow anon and authenticated update push tokens" on public.salon_member_push_tokens;
create policy "Allow anon and authenticated update push tokens"
  on public.salon_member_push_tokens
  for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Allow anon and authenticated delete push tokens" on public.salon_member_push_tokens;
create policy "Allow anon and authenticated delete push tokens"
  on public.salon_member_push_tokens
  for delete
  to anon, authenticated
  using (true);

-- ============================================================================
-- salon_timers INSERT / UPDATE 時に Edge Function (notify-salon-event) を呼び出すトリガー関数
-- ※ プロジェクトURLが異なる環境へデプロイする場合は v_edge_function_url を変更してください。
-- ============================================================================
create or replace function public.notify_salon_timer_event()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_edge_function_url text := 'https://hcmjcwcmvcwicjmnhtdc.supabase.co/functions/v1/notify-salon-event';
  v_payload jsonb;
begin
  -- UPDATE 時に通知判定へ関係するカラムが一切変化していない場合は呼び出しをスキップ
  if (TG_OP = 'UPDATE') then
    if (
      OLD.status is not distinct from NEW.status and
      OLD.target_seconds is not distinct from NEW.target_seconds and
      OLD.target_end_timestamp is not distinct from NEW.target_end_timestamp and
      OLD.paused_remaining_seconds is not distinct from NEW.paused_remaining_seconds and
      OLD.assistant_staff_name is not distinct from NEW.assistant_staff_name and
      OLD.help_process is not distinct from NEW.help_process and
      OLD.is_shampooing is not distinct from NEW.is_shampooing and
      OLD.check_target_end_timestamp is not distinct from NEW.check_target_end_timestamp and
      OLD.check_total_seconds is not distinct from NEW.check_total_seconds and
      OLD.check_process is not distinct from NEW.check_process and
      OLD.check_staff_name is not distinct from NEW.check_staff_name
    ) then
      return NEW;
    end if;
  end if;

  v_payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', to_jsonb(NEW),
    'old_record', case when TG_OP = 'UPDATE' then to_jsonb(OLD) else null end
  );

  begin
    perform net.http_post(
      url := v_edge_function_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json'
      ),
      body := v_payload,
      timeout_milliseconds := 5000
    );
  exception when others then
    -- Edge Function 未デプロイ・一時通信障害時でもタイマー更新トランザクション自体は絶対に失敗させない
    raise warning 'notify_salon_timer_event http_post skipped: %', SQLERRM;
  end;

  return NEW;
end;
$$;

drop trigger if exists on_salon_timers_push_notify on public.salon_timers;
create trigger on_salon_timers_push_notify
  after insert or update on public.salon_timers
  for each row
  execute function public.notify_salon_timer_event();
