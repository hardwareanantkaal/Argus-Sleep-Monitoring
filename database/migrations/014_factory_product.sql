-- Migration 014: the manufacturing station knows the product (19 Nov 2026).
-- Each bench run is for a sleep monitor or a fall detector: it flashes only that
-- product's firmware, runs that product's tests, and registers that product.
BEGIN;

ALTER TABLE factory_runs ADD COLUMN product TEXT NOT NULL DEFAULT 'sleep'
  CONSTRAINT factory_runs_product CHECK (product IN ('sleep', 'fall'));
CREATE INDEX factory_runs_product_idx ON factory_runs (product, started_at DESC);

COMMIT;
