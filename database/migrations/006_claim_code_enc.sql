-- Migration 006 (5 Nov 2026): reprintable QR stickers.
-- The claim code is ALSO stored encrypted (AES-256-GCM, key from HASH_PEPPER
-- via HKDF "claim-sticker"), so admins can reprint the same sticker later.
-- claim_code_hash still does the checking. Both are cleared on claim.
BEGIN;
ALTER TABLE devices ADD COLUMN claim_code_enc BYTEA;
COMMIT;
