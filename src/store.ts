import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Paths ──────────────────────────────────────────────────────────────────

const DEFAULT_DB_DIR = join(homedir(), ".knol-local");
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "memories.db");

// ── Types ──────────────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  content: string;
  tags: string[];
  importance: number; // 0 – 1
  created_at: number; // Unix ms
  updated_at: number; // Unix ms
  metadata: Record<string, unknown>;
}

export interface SearchResult extends Memory {
  score: number; // BM25 rank from FTS5 (lower = more relevant)
}

interface RawRow {
  id: string;
  content: string;
  tags: string | null;
  importance: number;
  created_at: number;
  updated_at: number;
  metadata: string | null;
}

interface StatsRow {
  total: number;
  oldest: number | null;
  newest: number | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseRow(row: RawRow): Memory {
  return {
    id: row.id,
    content: row.content,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    importance: row.importance,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {},
  };
}

/**
 * Sanitize a free-text query into a safe FTS5 MATCH expression.
 * Each whitespace-separated token is quoted to prevent injection via
 * FTS5 syntax operators (AND / OR / NOT / * / NEAR / ^).
 * Tokens are joined with implicit AND so every word must appear.
 */
function toFtsQuery(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  // Quote each token; double any interior quotes
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

// ── Store ──────────────────────────────────────────────────────────────────

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    this.db = new DatabaseSync(dbPath);

    // Performance pragmas — safe for single-writer local use
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous  = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.migrate();
  }

  // ── Schema ───────────────────────────────────────────────────────────────

  private migrate(): void {
    // Drop old triggers that used the FTS5 'delete' command (incompatible with
    // non-external-content tables). Idempotent — safe to run on every startup.
    this.db.exec(`
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id          TEXT    PRIMARY KEY,
        content     TEXT    NOT NULL,
        tags        TEXT,                        -- JSON string[]
        importance  REAL    NOT NULL DEFAULT 0.5,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        metadata    TEXT                         -- JSON object
      );

      -- FTS5 virtual table with Porter stemming for better recall
      -- (e.g. "running" matches "run", "ran")
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id       UNINDEXED,
        content,
        tags,
        tokenize = 'porter unicode61'
      );

      -- Keep FTS index in sync automatically
      CREATE TRIGGER IF NOT EXISTS memories_ai
        AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, id, content, tags)
          VALUES (new.rowid, new.id, new.content, COALESCE(new.tags, ''));
        END;

      CREATE TRIGGER IF NOT EXISTS memories_ad
        AFTER DELETE ON memories BEGIN
          DELETE FROM memories_fts WHERE rowid = old.rowid;
        END;

      CREATE TRIGGER IF NOT EXISTS memories_au
        AFTER UPDATE ON memories BEGIN
          DELETE FROM memories_fts WHERE rowid = old.rowid;
          INSERT INTO memories_fts(rowid, id, content, tags)
          VALUES (new.rowid, new.id, new.content, COALESCE(new.tags, ''));
        END;
    `);
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  add(
    content: string,
    opts: {
      tags?: string[];
      importance?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ): Memory {
    const now = Date.now();
    const memory: Memory = {
      id: randomUUID(),
      content: content.trim(),
      tags: opts.tags ?? [],
      importance: Math.min(1, Math.max(0, opts.importance ?? 0.5)),
      created_at: now,
      updated_at: now,
      metadata: opts.metadata ?? {},
    };

    this.db
      .prepare(
        `INSERT INTO memories
           (id, content, tags, importance, created_at, updated_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.content,
        memory.tags.length > 0 ? JSON.stringify(memory.tags) : null,
        memory.importance,
        memory.created_at,
        memory.updated_at,
        Object.keys(memory.metadata).length > 0 ? JSON.stringify(memory.metadata) : null,
      );

    return memory;
  }

  get(id: string): Memory | undefined {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as unknown as RawRow | undefined;
    return row ? parseRow(row) : undefined;
  }

  update(
    id: string,
    patch: {
      content?: string;
      tags?: string[];
      importance?: number;
      metadata?: Record<string, unknown>;
    },
  ): Memory | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const updated: Memory = {
      ...existing,
      content:    patch.content   !== undefined ? patch.content             : existing.content,
      tags:       patch.tags      !== undefined ? patch.tags                : existing.tags,
      metadata:   patch.metadata  !== undefined ? patch.metadata            : existing.metadata,
      importance: patch.importance !== undefined
        ? Math.min(1, Math.max(0, patch.importance))
        : existing.importance,
      updated_at: Date.now(),
    };

    this.db
      .prepare(
        `UPDATE memories
         SET content = ?, tags = ?, importance = ?, updated_at = ?, metadata = ?
         WHERE id = ?`,
      )
      .run(
        updated.content,
        updated.tags.length > 0 ? JSON.stringify(updated.tags) : null,
        updated.importance,
        updated.updated_at,
        Object.keys(updated.metadata).length > 0 ? JSON.stringify(updated.metadata) : null,
        id,
      );

    return updated;
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(id);
    return (result.changes as number) > 0;
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * Full-text search using FTS5 BM25 ranking, weighted by importance.
   * Falls back to a LIKE scan when the query is not valid FTS5 syntax.
   */
  search(
    query: string,
    opts: { limit?: number; tags?: string[] } = {},
  ): SearchResult[] {
    const limit = opts.limit ?? 10;

    let rows: (RawRow & { rank: number })[];

    if (query.trim()) {
      const ftsQuery = toFtsQuery(query);
      try {
        rows = this.db
          .prepare(
            `SELECT m.*, f.rank
             FROM   memories_fts f
             JOIN   memories     m ON m.rowid = f.rowid
             WHERE  memories_fts MATCH ?
             ORDER  BY f.rank * (1.0 / m.importance)  -- lower rank & higher importance first
             LIMIT  ?`,
          )
          .all(ftsQuery, limit) as unknown as (RawRow & { rank: number })[];
      } catch {
        // Fallback: simple LIKE search (handles edge-case queries)
        rows = this.db
          .prepare(
            `SELECT *, 0.0 as rank
             FROM memories
             WHERE content LIKE '%' || ? || '%'
             ORDER BY importance DESC, updated_at DESC
             LIMIT ?`,
          )
          .all(query.trim(), limit) as unknown as (RawRow & { rank: number })[];
      }
    } else {
      rows = this.db
        .prepare(
          `SELECT *, 0.0 as rank
           FROM memories
           ORDER BY importance DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(limit) as unknown as (RawRow & { rank: number })[];
    }

    let results: SearchResult[] = rows.map((r) => ({ ...parseRow(r), score: r.rank }));

    if (opts.tags && opts.tags.length > 0) {
      const filterTags = opts.tags;
      results = results.filter((m) => filterTags.some((t) => m.tags.includes(t)));
    }

    return results;
  }

  /**
   * Return most recent memories, optionally filtered by tags.
   */
  list(opts: { limit?: number; tags?: string[] } = {}): Memory[] {
    const limit = opts.limit ?? 20;
    const rows = this.db
      .prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as RawRow[];

    let results = rows.map(parseRow);

    if (opts.tags && opts.tags.length > 0) {
      const filterTags = opts.tags;
      results = results.filter((m) => filterTags.some((t) => m.tags.includes(t)));
    }

    return results;
  }

  stats(): { total: number; oldest: number | null; newest: number | null } {
    return this.db
      .prepare(
        "SELECT COUNT(*) as total, MIN(created_at) as oldest, MAX(created_at) as newest FROM memories",
      )
      .get() as unknown as StatsRow;
  }

  // ── Export / Import / Backup ──────────────────────────────────────────────

  exportAll(opts: { tags?: string[] } = {}): Memory[] {
    const rows = this.db
      .prepare("SELECT * FROM memories ORDER BY created_at ASC")
      .all() as unknown as RawRow[];

    let results = rows.map(parseRow);

    if (opts.tags && opts.tags.length > 0) {
      const filterTags = opts.tags;
      results = results.filter((m) => filterTags.some((t) => m.tags.includes(t)));
    }

    return results;
  }

  importAll(
    entries: Array<{
      content: string;
      tags?: string[];
      importance?: number;
      metadata?: Record<string, unknown>;
      created_at?: number;
    }>,
  ): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;

    const insert = this.db.prepare(
      `INSERT INTO memories
         (id, content, tags, importance, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec("BEGIN");
    try {
      for (const entry of entries) {
        const content = (entry.content ?? "").trim();
        if (!content) { skipped++; continue; }

        const now = Date.now();
        const tags = entry.tags ?? [];
        const importance = Math.min(1, Math.max(0, entry.importance ?? 0.5));
        const created_at = entry.created_at ?? now;
        const metadata = entry.metadata ?? {};

        insert.run(
          randomUUID(),
          content,
          tags.length > 0 ? JSON.stringify(tags) : null,
          importance,
          created_at,
          now,
          Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
        );
        imported++;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return { imported, skipped };
  }

  /**
   * Checkpoint WAL into the main file, then copy the .db file to destPath.
   * Safe for single-writer local usage.
   */
  backup(destPath: string): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(this.db.location as unknown as string, destPath);
  }

  close(): void {
    this.db.close();
  }
}
