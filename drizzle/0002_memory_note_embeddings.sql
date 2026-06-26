-- T12 vector memory fallback.
-- sqlite-vec is not installed in this checkout, so this table is the local vector seam:
-- one serialized 384-dimensional embedding per memory note. The retrieval layer can
-- switch to a vec0 virtual table later without changing callers.
CREATE TABLE IF NOT EXISTS memory_note_embeddings (
  note_id text PRIMARY KEY NOT NULL,
  embedding text NOT NULL,
  embedding_model text NOT NULL,
  created_at text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS memory_note_embeddings_ad AFTER DELETE ON memory_notes BEGIN
  DELETE FROM memory_note_embeddings WHERE note_id = old.id;
END;
