-- T12 vector memory metadata. Embeddings are mirrored into a sqlite-vec vec0
-- virtual table when the extension is available; this table keeps the durable
-- note mapping and serialized fallback copy for degraded lexical-only operation.
CREATE TABLE IF NOT EXISTS memory_note_embeddings (
  note_id text PRIMARY KEY NOT NULL,
  embedding text NOT NULL,
  embedding_model text NOT NULL,
  vec_rowid integer UNIQUE,
  created_at text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS memory_note_embeddings_ad AFTER DELETE ON memory_notes BEGIN
  DELETE FROM memory_note_embeddings WHERE note_id = old.id;
END;
