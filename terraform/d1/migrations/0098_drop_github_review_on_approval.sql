-- The approval-triggered pre-merge review (`reviewOnApproval`) is replaced by the
-- AI Review merge gate (`mergeGate`). Stored settings are parsed strictly, so a row
-- that still carries the removed key would fail to load; drop it from the global
-- defaults and from every repository override.
UPDATE integration_settings
SET settings = json_remove(settings, '$.defaults.reviewOnApproval')
WHERE integration_id = 'github'
  AND json_type(settings, '$.defaults.reviewOnApproval') IS NOT NULL;

UPDATE integration_repo_settings
SET settings = json_remove(settings, '$.reviewOnApproval')
WHERE integration_id = 'github'
  AND json_type(settings, '$.reviewOnApproval') IS NOT NULL;
