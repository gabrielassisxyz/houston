-- Refs cited by notes: which beads and tickets a note is about.
--
-- A note's frontmatter can carry a kind and a list of references, so one
-- request can answer which planning, implementation and evidence notes cite an
-- epic and its descendants. Refs are compared without regard to case
-- (hou-4kz and HOU-4KZ are one row) because identifiers are typed both ways.
-- Like tag rows, refs rows survive a soft delete, so a revived note comes
-- back whole; every query against this table joins live nodes only.
CREATE TABLE note_refs (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    ref TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (node_id, ref)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_note_refs_ref ON note_refs(ref COLLATE NOCASE);
