-- LibreCorsa online leaderboard on Supabase: the same rules as scripts/leaderboard-worker, as Postgres
-- functions the browser calls through PostgREST with the project's publishable (anon) key.
--   POST /rest/v1/rpc/submit_lap   { "rec": LapRecording }               -> { ok, rank } | { ok: false, error }
--   GET  /rest/v1/rpc/leaderboard?track=&vehicle=&lim=                  -> { laps: [...] } (no samples)
--   GET  /rest/v1/rpc/get_lap?lap_id=                                     -> LapRecording | null
-- The tables are locked (RLS on, no policies); only these functions can read or write them.
-- Validation and plausibility checks are heuristics, not cheat-proof. Safe to run again.

create table if not exists public.laps (
  id uuid primary key default gen_random_uuid(),
  track_id text not null,
  vehicle text not null,
  driver_name text not null,
  driver_code text not null,
  lap_time_ms double precision not null,
  sector_times_ms double precision[] not null,
  recorded_at double precision not null,
  rec jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists laps_board_idx on public.laps (track_id, vehicle, lap_time_ms, created_at);

-- Uploads per client per hour (the client address is stored hashed)
create table if not exists public.lap_posts (
  client_hash text not null,
  hour bigint not null,
  count int not null default 0,
  primary key (client_hash, hour)
);

alter table public.laps enable row level security;
alter table public.lap_posts enable row level security;
revoke all on public.laps, public.lap_posts from anon, authenticated;

-- Shape and plausibility of an uploaded LapRecording; null when it is fine, else the reason
create or replace function public.lap_problem(rec jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  stride constant int := 14; -- t, s, x, y, z, qx, qy, qz, qw, speedKmh, throttle, brake, steer, gear
  max_speed constant double precision := 420;
  data jsonb;
  n int;
  cnt int;
  i int;
  o int;
  t double precision;
  prev_t double precision := '-infinity';
  v double precision;
  dt double precision;
  dist double precision;
  lap double precision;
  s jsonb;
begin
  if jsonb_typeof(rec) <> 'object' then return 'Recording must be an object'; end if;
  if rec->'version' is distinct from '1'::jsonb then return 'Unsupported version'; end if;
  if jsonb_typeof(rec->'trackId') <> 'string' or (rec->>'trackId') !~ '^[A-Za-z0-9_-]{1,64}$' then
    return 'Invalid trackId';
  end if;
  if coalesce(rec->>'vehicle', '') not in ('vf26', 'f12026-car', 'amg-gt3') then return 'Invalid vehicle'; end if;
  if jsonb_typeof(rec->'driverName') <> 'string' or length(btrim(rec->>'driverName')) not between 1 and 64 then
    return 'Invalid driverName';
  end if;
  if jsonb_typeof(rec->'driverCode') <> 'string' or length(btrim(rec->>'driverCode')) not between 1 and 16 then
    return 'Invalid driverCode';
  end if;
  if jsonb_typeof(rec->'lapTimeMs') <> 'number' then return 'Invalid lapTimeMs'; end if;
  lap := (rec->>'lapTimeMs')::double precision;
  if lap <= 0 or lap > 3600000 then return 'Invalid lapTimeMs'; end if;
  if jsonb_typeof(rec->'recordedAt') <> 'number' or (rec->>'recordedAt')::double precision <= 0 then
    return 'Invalid recordedAt';
  end if;
  if jsonb_typeof(rec->'sampleHz') <> 'number' or (rec->>'sampleHz')::double precision not between 0.001 and 1000 then
    return 'Invalid sampleHz';
  end if;

  s := rec->'sectorTimesMs';
  if jsonb_typeof(s) <> 'array' or jsonb_array_length(s) <> 3
     or exists (select 1 from jsonb_array_elements(s) e where jsonb_typeof(e) <> 'number' or e::text::double precision < 0) then
    return 'Invalid sectorTimesMs';
  end if;
  if abs((s->>0)::double precision + (s->>1)::double precision + (s->>2)::double precision - lap) > 50 then
    return 'Sector times do not add up to the lap time';
  end if;

  data := rec->'data';
  if jsonb_typeof(data) <> 'array' then return 'Invalid data'; end if;
  n := jsonb_array_length(data);
  if n % stride <> 0 or exists (select 1 from jsonb_array_elements(data) e where jsonb_typeof(e) <> 'number') then
    return 'Invalid data';
  end if;
  cnt := n / stride;
  if cnt < 10 or cnt > 20000 then return 'Recording has too few or too many samples'; end if;

  for i in 0 .. cnt - 1 loop
    o := i * stride;
    t := (data->>o)::double precision;
    if t < prev_t then return 'Sample times must not go backwards'; end if;
    v := (data->>(o + 9))::double precision;
    if v < 0 or v > max_speed then return 'Sample speed out of range'; end if;
    if (data->>(o + 10))::double precision not between 0 and 1 or (data->>(o + 11))::double precision not between 0 and 1 then
      return 'Pedal value out of range';
    end if;
    if (data->>(o + 12))::double precision not between -1 and 1 then return 'Steering value out of range'; end if;
    v := (data->>(o + 13))::double precision;
    if v <> trunc(v) or v < -1 or v > 8 then return 'Gear out of range'; end if;
    -- Consecutive positions must not imply a teleport
    if i > 0 then
      dt := t - prev_t;
      if dt >= 0.02 then
        dist := sqrt(
          ((data->>(o + 2))::double precision - (data->>(o - stride + 2))::double precision) ^ 2 +
          ((data->>(o + 3))::double precision - (data->>(o - stride + 3))::double precision) ^ 2 +
          ((data->>(o + 4))::double precision - (data->>(o - stride + 4))::double precision) ^ 2);
        if dist / dt * 3.6 > max_speed then return 'Positions imply a speed above 420 km/h'; end if;
      end if;
    end if;
    prev_t := t;
  end loop;

  if abs(lap / 1000 - prev_t) > 1.5 then return 'Lap time does not match the samples'; end if;
  return null;
end;
$$;

-- Board row for the client: a lap without its samples
create or replace function public.lap_entry(l public.laps)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', l.id, 'name', l.driver_name, 'code', l.driver_code, 'lapTimeMs', l.lap_time_ms,
    'sectorTimesMs', to_jsonb(l.sector_times_ms), 'vehicle', l.vehicle, 'trackId', l.track_id,
    'recordedAt', l.recorded_at);
$$;

create or replace function public.submit_lap(rec jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  max_posts_per_hour constant int := 10;
  max_board constant int := 100;
  problem text;
  headers json := nullif(current_setting('request.headers', true), '')::json;
  client text;
  hr bigint := floor(extract(epoch from now()) / 3600);
  used int;
  t_id text;
  veh text;
  d_name text;
  d_code text;
  lap double precision;
  prev public.laps;
  new_id uuid;
  rnk int;
begin
  -- Rate limit by the client's address (Cloudflare's, else the first in X-Forwarded-For), hashed
  client := md5(coalesce(
    nullif(btrim(headers->>'cf-connecting-ip'), ''),
    nullif(btrim(split_part(headers->>'x-forwarded-for', ',', 1)), ''),
    'unknown'));
  insert into public.lap_posts as p (client_hash, hour, count) values (client, hr, 1)
    on conflict (client_hash, hour) do update set count = p.count + 1
    returning p.count into used;
  delete from public.lap_posts where hour < hr - 1;
  if used > max_posts_per_hour then
    return jsonb_build_object('ok', false, 'error', 'Too many uploads, try again later');
  end if;
  if pg_column_size(rec) > 2 * 1024 * 1024 then
    return jsonb_build_object('ok', false, 'error', 'Recording is larger than 2 MB');
  end if;

  problem := public.lap_problem(rec);
  if problem is not null then return jsonb_build_object('ok', false, 'error', problem); end if;

  t_id := rec->>'trackId';
  veh := rec->>'vehicle';
  d_name := btrim(rec->>'driverName');
  d_code := btrim(rec->>'driverCode');
  lap := (rec->>'lapTimeMs')::double precision;

  -- One row per driver: a slower lap from the same name and code does not replace their best
  select * into prev from public.laps
    where track_id = t_id and vehicle = veh and driver_name = d_name and driver_code = d_code
    order by lap_time_ms limit 1;
  if prev.id is not null and prev.lap_time_ms <= lap then
    return jsonb_build_object('ok', false, 'error', 'Not faster than your best lap on this board');
  end if;

  select count(*) + 1 into rnk from public.laps
    where track_id = t_id and vehicle = veh and lap_time_ms <= lap and id is distinct from prev.id;
  if rnk > max_board then
    return jsonb_build_object('ok', false, 'error', 'Lap is not fast enough for the top 100');
  end if;

  delete from public.laps where track_id = t_id and vehicle = veh and driver_name = d_name and driver_code = d_code;
  insert into public.laps (track_id, vehicle, driver_name, driver_code, lap_time_ms, sector_times_ms, recorded_at, rec)
    values (
      t_id, veh, d_name, d_code, lap,
      array[(rec->'sectorTimesMs'->>0)::double precision, (rec->'sectorTimesMs'->>1)::double precision,
            (rec->'sectorTimesMs'->>2)::double precision],
      (rec->>'recordedAt')::double precision,
      jsonb_build_object(
        'version', 1, 'trackId', t_id, 'vehicle', veh, 'driverName', d_name, 'driverCode', d_code,
        'lapTimeMs', rec->'lapTimeMs', 'sectorTimesMs', rec->'sectorTimesMs', 'recordedAt', rec->'recordedAt',
        'sampleHz', rec->'sampleHz', 'data', rec->'data'))
    returning id into new_id;

  -- Keep the board at its top 100
  delete from public.laps where id in (
    select id from public.laps where track_id = t_id and vehicle = veh
    order by lap_time_ms, created_at offset max_board);
  return jsonb_build_object('ok', true, 'rank', rnk);
end;
$$;

create or replace function public.leaderboard(track text, vehicle text, lim int default 20)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('laps', coalesce(jsonb_agg(public.lap_entry(b) order by b.lap_time_ms, b.created_at), '[]'::jsonb))
  from (
    select * from public.laps l
    where l.track_id = leaderboard.track and l.vehicle = leaderboard.vehicle
    order by l.lap_time_ms, l.created_at
    limit least(greatest(coalesce(lim, 20), 1), 100)
  ) b;
$$;

create or replace function public.get_lap(lap_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select rec from public.laps where id = lap_id;
$$;

revoke all on function public.lap_problem(jsonb), public.lap_entry(public.laps) from public, anon, authenticated;
revoke all on function public.submit_lap(jsonb), public.leaderboard(text, text, int), public.get_lap(uuid) from public;
grant execute on function public.submit_lap(jsonb), public.leaderboard(text, text, int), public.get_lap(uuid)
  to anon, authenticated;
