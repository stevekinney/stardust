-- Creates the FTS5 virtual table mirroring memory_notes.content for full-text search.
-- Triggers keep it in sync; T9 (Memory) adds sqlite-vec for hybrid retrieval.
-- Rowids are aligned: INSERT sets fts rowid = source rowid so DELETE FROM uses the stable key.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
  id UNINDEXED,
  content,
  tokenize='porter ascii'
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS memory_notes_ai AFTER INSERT ON memory_notes BEGIN
  INSERT INTO memory_notes_fts(rowid, id, content) VALUES (new.rowid, new.id, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS memory_notes_au AFTER UPDATE OF content ON memory_notes BEGIN
  DELETE FROM memory_notes_fts WHERE rowid = old.rowid;
  INSERT INTO memory_notes_fts(rowid, id, content) VALUES (new.rowid, new.id, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS memory_notes_ad AFTER DELETE ON memory_notes BEGIN
  DELETE FROM memory_notes_fts WHERE rowid = old.rowid;
END;