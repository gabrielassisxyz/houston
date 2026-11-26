-- The wikilink resolver looks every link up in four steps, and without these
-- indexes each step read the whole nodes or note_paths table, so the first
-- index of a vault grew with notes times links. The first three indexes are on
-- the exact expressions the resolver's queries use: SQLite takes an expression
-- index only when the query spells the expression the same way.
CREATE INDEX idx_nodes_lower_id ON nodes(LOWER(id));
CREATE INDEX idx_nodes_lower_title ON nodes(LOWER(title));
CREATE INDEX idx_note_paths_path_key ON note_paths(LOWER(REPLACE(path, '\', '/')));

-- A suffix comparison cannot use an index, so the bare-filename step narrows by
-- the note's basename first: lower-cased, with a trailing .md removed without
-- regard to case. The reconciler writes it with every path, and a cold start
-- fills the rows that predate this migration.
ALTER TABLE note_paths ADD COLUMN base_key TEXT;
CREATE INDEX idx_note_paths_base_key ON note_paths(base_key);
