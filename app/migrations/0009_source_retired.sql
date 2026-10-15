-- B40: retire superseded agent-reported sources (additive; clear retired_at to restore)
ALTER TABLE source_health ADD COLUMN retired_at TEXT;
UPDATE source_health SET retired_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE source IN ('calendar', 'gmail', 'messages', 'messenger') AND retired_at IS NULL;
