-- Migration 008 (5 Nov 2026): vendor v2, vendors resell (docs/VENDOR.md §v2, API.md §15).
-- The SAME QR sticker now works twice:
--   factory       registered by admin, nobody has it         owner NULL, vendor NULL, code set
--   vendor_stock  a vendor scanned it: in the vendor's stock  owner NULL, vendor set,  code KEPT
--   owned         a customer scanned it: the customer owns it owner set,  vendor kept if sold by a vendor,
--                                                             code cleared
-- A vendor device that is sold keeps vendor_id ("sold by"), so the vendor
-- team keeps its device permissions (no privacy limit for now, owner decision).
-- stocked_at = when the vendor added it to stock; claimed_at = when the
-- current holder claimed it (the customer, once sold).
BEGIN;

ALTER TABLE devices
  ADD COLUMN claim_stage TEXT NOT NULL DEFAULT 'factory',
  ADD COLUMN stocked_at  TIMESTAMPTZ;

UPDATE devices SET claim_stage = CASE
    WHEN owner_id IS NOT NULL THEN 'owned'
    WHEN vendor_id IS NOT NULL THEN 'vendor_stock'
    ELSE 'factory' END,
  stocked_at = CASE WHEN vendor_id IS NOT NULL THEN claimed_at END;

ALTER TABLE devices DROP CONSTRAINT devices_claim_consistent;
ALTER TABLE devices ADD CONSTRAINT devices_claim_stage CHECK (claim_stage IN ('factory', 'vendor_stock', 'owned'));
ALTER TABLE devices ADD CONSTRAINT devices_claim_consistent CHECK (
     (claim_stage = 'factory'      AND owner_id IS NULL     AND vendor_id IS NULL     AND claimed_at IS NULL)
  OR (claim_stage = 'vendor_stock' AND owner_id IS NULL     AND vendor_id IS NOT NULL AND claimed_at IS NOT NULL)
  OR (claim_stage = 'owned'        AND owner_id IS NOT NULL AND claimed_at IS NOT NULL));
CREATE INDEX devices_vendor_owner_idx ON devices (vendor_id, owner_id) WHERE vendor_id IS NOT NULL AND owner_id IS NOT NULL;

COMMIT;
