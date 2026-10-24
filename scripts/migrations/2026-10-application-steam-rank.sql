ALTER TABLE recruit_applications ADD COLUMN IF NOT EXISTS steam_id text;
ALTER TABLE recruit_applications ADD COLUMN IF NOT EXISTS rank text;
ALTER TABLE division_members ADD COLUMN IF NOT EXISTS steam_id text;
