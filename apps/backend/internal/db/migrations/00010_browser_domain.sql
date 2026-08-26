-- +goose Up
-- Domain as a first-class field on browser visits (F4).
--
-- Productivity classification (F6) and the websites report both group by domain.
-- Deriving it from `url` at query time means an expression scan on every
-- dashboard load, and no index can help; storing it makes both a plain lookup.
--
-- The value is computed by the backend on ingest (store.DomainOf), never taken
-- from the client, so a compromised or buggy agent cannot mislabel a visit.

ALTER TABLE browser_visits ADD COLUMN domain text;

-- Backfill existing rows. This is a best-effort SQL approximation of the Go
-- extractor: scheme, then host up to the first /?# , then the port stripped.
-- Rows it cannot parse (including the reserved on/off marker URLs, which are
-- not URLs at all) keep a NULL domain, which is the honest answer.
UPDATE browser_visits
   SET domain = lower(split_part(substring(url from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)'), ':', 1))
 WHERE domain IS NULL
   AND url ~ '^[a-zA-Z][a-zA-Z0-9+.-]*://';

-- Empty strings would otherwise masquerade as a real domain in GROUP BY.
UPDATE browser_visits SET domain = NULL WHERE domain = '';

CREATE INDEX idx_browser_biz_domain_ts ON browser_visits(business_id, domain, ts);

-- +goose Down
DROP INDEX idx_browser_biz_domain_ts;
ALTER TABLE browser_visits DROP COLUMN domain;
