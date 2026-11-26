DROP INDEX IF EXISTS idx_note_paths_base_key;
DROP INDEX IF EXISTS idx_note_paths_path_key;
DROP INDEX IF EXISTS idx_nodes_lower_title;
DROP INDEX IF EXISTS idx_nodes_lower_id;
ALTER TABLE note_paths DROP COLUMN base_key;
