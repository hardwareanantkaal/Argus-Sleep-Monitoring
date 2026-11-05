-- Migration 009 (5 Nov 2026): clean vendor usage (docs/VENDOR.md §v2.1, API.md §15).
-- Owner decisions after v2 (008):
--   * New stage vendor_use: the vendor uses the sensor itself ("Use here", or put
--     in a group). Its QR is locked (code kept, so "back to stock" unlocks it).
--   * vendor_stock: only "this is my stock". No sleep sessions saved, no history,
--     no alerts; the team only sees live values and connection (to test it).
--   * owned (sold): the vendor keeps a RECORD only ("sold to X on date": vendor_id
--     stays) but has no access at all, and its temporary access grants end.
--   * Groups only hold in-use devices.
BEGIN;

ALTER TABLE devices DROP CONSTRAINT devices_claim_stage;
ALTER TABLE devices DROP CONSTRAINT devices_claim_consistent;
ALTER TABLE devices DROP CONSTRAINT devices_group_needs_vendor;
ALTER TABLE devices ADD CONSTRAINT devices_claim_stage
  CHECK (claim_stage IN ('factory', 'vendor_stock', 'vendor_use', 'owned'));

-- Existing vendor devices that were already being used (in a group, or with
-- temporary access) are in use.
UPDATE devices d SET claim_stage = 'vendor_use'
 WHERE d.claim_stage = 'vendor_stock'
   AND (d.group_id IS NOT NULL OR EXISTS (SELECT 1 FROM device_access_grants g WHERE g.device_id = d.id));

-- Sold devices: no group, vendor grants end.
UPDATE devices SET group_id = NULL WHERE claim_stage = 'owned' AND group_id IS NOT NULL;
UPDATE device_access_grants g SET revoked_at = now()
  FROM devices d WHERE d.id = g.device_id AND d.claim_stage = 'owned' AND g.revoked_at IS NULL;

ALTER TABLE devices ADD CONSTRAINT devices_claim_consistent CHECK (
     (claim_stage = 'factory'                     AND owner_id IS NULL     AND vendor_id IS NULL     AND claimed_at IS NULL)
  OR (claim_stage IN ('vendor_stock', 'vendor_use') AND owner_id IS NULL   AND vendor_id IS NOT NULL AND claimed_at IS NOT NULL)
  OR (claim_stage = 'owned'                       AND owner_id IS NOT NULL AND claimed_at IS NOT NULL));
ALTER TABLE devices ADD CONSTRAINT devices_group_needs_vendor CHECK (group_id IS NULL OR claim_stage = 'vendor_use');

-- Vendor team: every device permission except sharing.manage on in-use devices;
-- only live.view + settings.edit on stock (test it, no history / alerts);
-- nothing on sold devices. Grants only on in-use devices.
CREATE OR REPLACE VIEW device_user_permissions AS
  SELECT d.id AS device_id, d.owner_id AS user_id, p.code AS permission, 'owner'::TEXT AS via
    FROM devices d CROSS JOIN permissions p
   WHERE d.owner_id IS NOT NULL AND p.scope = 'device'
  UNION ALL
  SELECT sp.device_id, sp.user_id, sp.permission, 'share'::TEXT
    FROM device_share_permissions sp
  UNION ALL
  SELECT d.id, m.user_id, p.code, 'vendor'::TEXT
    FROM devices d
    JOIN vendors v ON v.id = d.vendor_id AND v.status = 'active'
    JOIN vendor_members m ON m.vendor_id = v.id
    JOIN permissions p ON p.scope = 'device' AND p.code <> 'sharing.manage'
   WHERE d.claim_stage = 'vendor_use'
      OR (d.claim_stage = 'vendor_stock' AND p.code IN ('live.view', 'settings.edit'))
  UNION ALL
  SELECT g.device_id, g.user_id, perm, 'grant'::TEXT
    FROM device_access_grants g
    JOIN devices d ON d.id = g.device_id AND d.vendor_id = g.vendor_id AND d.claim_stage = 'vendor_use'
    JOIN vendors v ON v.id = g.vendor_id AND v.status = 'active'
    CROSS JOIN unnest(g.permissions) perm
   WHERE g.user_id IS NOT NULL AND g.revoked_at IS NULL
     AND now() >= g.starts_at AND now() < g.ends_at;

COMMIT;
