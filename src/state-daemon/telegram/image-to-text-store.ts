import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ImageAltTextRecord {
  imageHash: string;
  altText: string;
  altTextTokens?: number;
  stickerSetName?: string;
}

interface StoredRow {
  imageHash: string;
  altText: string;
  altTextTokens: number | null;
  stickerSetName: string | null;
}

export interface ImageAltTextStore {
  hydrate: () => void;
  lookupByHash: (hash: string) => ImageAltTextRecord | null;
  persist: (record: ImageAltTextRecord) => void;
}

export function createImageAltTextStore(dbPath = "data/memoh.db"): ImageAltTextStore {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath, { create: true });
  db.run(`
    CREATE TABLE IF NOT EXISTS image_alt_texts (
      image_hash TEXT PRIMARY KEY,
      alt_text TEXT NOT NULL,
      alt_text_tokens INTEGER,
      sticker_set_name TEXT,
      updated_at INTEGER NOT NULL
    )
  `);

  const memory = new Map<string, ImageAltTextRecord>();

  const selectAllStmt = db.query<StoredRow, []>(`
    SELECT
      image_hash AS imageHash,
      alt_text AS altText,
      alt_text_tokens AS altTextTokens,
      sticker_set_name AS stickerSetName
    FROM image_alt_texts
  `);

  const upsertStmt = db.query<void, [string, string, number | null, string | null, number]>(`
    INSERT INTO image_alt_texts (image_hash, alt_text, alt_text_tokens, sticker_set_name, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(image_hash) DO UPDATE SET
      alt_text = excluded.alt_text,
      alt_text_tokens = excluded.alt_text_tokens,
      sticker_set_name = excluded.sticker_set_name,
      updated_at = excluded.updated_at
  `);

  return {
    hydrate() {
      memory.clear();
      for (const row of selectAllStmt.all()) {
        memory.set(row.imageHash, {
          imageHash: row.imageHash,
          altText: row.altText,
          altTextTokens: row.altTextTokens ?? undefined,
          stickerSetName: row.stickerSetName ?? undefined,
        });
      }
    },

    lookupByHash(hash) {
      return memory.get(hash) ?? null;
    },

    persist(record) {
      upsertStmt.run(
        record.imageHash,
        record.altText,
        record.altTextTokens ?? null,
        record.stickerSetName ?? null,
        Date.now()
      );
      memory.set(record.imageHash, record);
    },
  };
}
