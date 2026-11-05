-- Migration 007 (5 Nov 2026): vendors (docs/VENDOR.md, API.md §15).
-- * A vendor (hospital, mall, one person) claims devices by QR: the device
--   then belongs to the vendor (devices.vendor_id), not to a person.
-- * Vendor team: owner + staff, joined by link (like staff_invites). One
--   vendor per user.
-- * Groups: a plain named list per vendor; a device is in at most one group.
-- * Temporary access grants: one person, one device, between starts_at and
--   ends_at. The grant row is also its own link invite (token_hash) until
--   someone accepts it.
-- * device_user_permissions now also includes vendor members (4 permissions,
--   never sharing.manage) and grant holders while the grant is running.
-- * Staff permission vendors.manage (Owner role has every staff permission).
BEGIN;

CREATE TABLE vendors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  contact_name  TEXT,
  phone         TEXT,
  email         TEXT,
  status        TEXT        NOT NULL DEFAULT 'active',   -- 'active' | 'disabled'
  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vendors_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT vendors_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 80)
);

CREATE TABLE vendor_members (
  vendor_id   UUID        NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,  -- one vendor per user
  role        TEXT        NOT NULL,                                                -- 'owner' | 'staff'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, user_id),
  CONSTRAINT vendor_members_role CHECK (role IN ('owner', 'staff'))
);

-- Link-only, like staff_invites. role 'owner' is created by an admin, 'staff' by the vendor owner.
CREATE TABLE vendor_invites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    UUID        NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  role         TEXT        NOT NULL,
  label        TEXT        NOT NULL,
  token_hash   TEXT        NOT NULL UNIQUE,
  invited_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  accepted_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vendor_invites_role CHECK (role IN ('owner', 'staff')),
  CONSTRAINT vendor_invites_label_length CHECK (char_length(btrim(label)) BETWEEN 1 AND 60)
);
CREATE INDEX vendor_invites_open_idx ON vendor_invites (vendor_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE vendor_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   UUID        NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vendor_groups_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 60)
);
CREATE UNIQUE INDEX vendor_groups_name_uq ON vendor_groups (vendor_id, lower(name));

ALTER TABLE devices
  ADD COLUMN vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  ADD COLUMN group_id  UUID REFERENCES vendor_groups(id) ON DELETE SET NULL;
CREATE INDEX devices_vendor_idx ON devices (vendor_id) WHERE vendor_id IS NOT NULL;
-- Claimed = a person owner OR a vendor, never both.
ALTER TABLE devices DROP CONSTRAINT devices_claim_consistent;
ALTER TABLE devices ADD CONSTRAINT devices_claim_consistent CHECK (
  (owner_id IS NULL AND vendor_id IS NULL AND claimed_at IS NULL)
  OR (claimed_at IS NOT NULL AND (owner_id IS NULL) <> (vendor_id IS NULL)));
ALTER TABLE devices ADD CONSTRAINT devices_group_needs_vendor CHECK (group_id IS NULL OR vendor_id IS NOT NULL);

-- Temporary access to one device. user_id is NULL until the link is accepted.
CREATE TABLE device_access_grants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id          UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  vendor_id          UUID        NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id            UUID        REFERENCES users(id) ON DELETE CASCADE,
  label              TEXT        NOT NULL,                 -- "Bed 4 - Mr Shah"
  permissions        TEXT[]      NOT NULL,                 -- device permissions, never sharing.manage
  starts_at          TIMESTAMPTZ NOT NULL,
  ends_at            TIMESTAMPTZ NOT NULL,
  granted_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
  revoked_at         TIMESTAMPTZ,                          -- ended early
  -- the login invite link
  token_hash         TEXT        UNIQUE,
  invite_expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at        TIMESTAMPTZ,
  end_notified_at    TIMESTAMPTZ,                          -- access:changed sent after ends_at
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grants_period CHECK (ends_at > starts_at),
  CONSTRAINT grants_has_perms CHECK (cardinality(permissions) > 0 AND NOT ('sharing.manage' = ANY(permissions))),
  CONSTRAINT grants_label_length CHECK (char_length(btrim(label)) BETWEEN 1 AND 60)
);
CREATE INDEX grants_device_idx ON device_access_grants (device_id);
CREATE INDEX grants_user_idx ON device_access_grants (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX grants_end_idx ON device_access_grants (ends_at) WHERE end_notified_at IS NULL AND user_id IS NOT NULL;

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
  UNION ALL
  SELECT g.device_id, g.user_id, perm, 'grant'::TEXT
    FROM device_access_grants g
    JOIN devices d ON d.id = g.device_id AND d.vendor_id = g.vendor_id
    JOIN vendors v ON v.id = g.vendor_id AND v.status = 'active'
    CROSS JOIN unnest(g.permissions) perm
   WHERE g.user_id IS NOT NULL AND g.revoked_at IS NULL
     AND now() >= g.starts_at AND now() < g.ends_at;

INSERT INTO permissions (code, scope, label, sort_order) VALUES
  ('vendors.manage', 'staff', 'Manage vendors', 12);

COMMIT;
