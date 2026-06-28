-- Schedule daily photo backup at 1:00 AM UTC every day
-- Requires pg_cron extension (enabled by default on Supabase)

select cron.schedule(
  'backup-daily-photos',
  '0 1 * * *',
  $$
  select net.http_post(
    url := 'https://rnkbwlxtdcmjggqfjcac.supabase.co/functions/v1/backup-daily-photos',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
    ),
    body := '{}'::jsonb
  );
  $$
);
