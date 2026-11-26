-- updateNode reads a node's newest revision on every update, and the vault
-- writes revisions for every note it reconciles: without this index each lookup
-- scans the whole revisions table. The columns follow the lookup's own ORDER BY
-- (created_at DESC, id DESC), so the newest row is the first one the index yields.
CREATE INDEX IF NOT EXISTS idx_revisions_node_id ON revisions(node_id, created_at, id);
