-- Migration 012: store sleep stages as EVENTS, not one letter per minute (17 Nov 2026).
-- Owner decision: History keeps only the stage changes ("awake -> light at 00:58",
-- "light -> deep at 01:12" ...), never per-minute data.
--   sleep_sessions.stages = {"n": <epochs in the session>, "ev": [[<epoch offset>, "<D|L|A|O>"], ...]}
--   one entry per stage change; the stage lasts until the next entry (or n).
-- The per-minute `hyp` text is emptied (the column stays, always '' from now on),
-- and the copy of it inside `raw` is removed. Lossless: the events rebuild the
-- same hypnogram.
BEGIN;

ALTER TABLE sleep_sessions ADD COLUMN stages JSONB
  CONSTRAINT session_stages_object CHECK (stages IS NULL OR jsonb_typeof(stages) = 'object');

UPDATE sleep_sessions s SET stages = x.stages, hyp = ''
  FROM (
    SELECT id, jsonb_build_object('n', length(hyp),
             'ev', jsonb_agg(jsonb_build_array(off, st) ORDER BY ord)) AS stages
      FROM (
        SELECT s.id, s.hyp, m.ord, left(m.run[1], 1) AS st,
               COALESCE(sum(length(m.run[1])) OVER (PARTITION BY s.id ORDER BY m.ord
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::int AS off
          FROM sleep_sessions s, regexp_matches(s.hyp, '(D+|L+|A+|O+)', 'g') WITH ORDINALITY AS m(run, ord)
         WHERE s.hyp <> ''
      ) r
     GROUP BY id, hyp
  ) x
 WHERE s.id = x.id;

UPDATE sleep_sessions SET raw = raw - 'hyp' WHERE raw ? 'hyp';

COMMIT;
