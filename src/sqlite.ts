import { createRequire } from 'node:module';
import { ensureBetterSqlite3, getPackageDir } from './auto-setup.js';

// ── Shared interface ───────────────────────────────────────────────────────

/**
 * Minimal synchronous SQLite interface used by MemoryStore.
 * Implemented by both the built-in node:sqlite (Node 22.5+) adapter
 * and the better-sqlite3 adapter (Node 18+).
 */
export interface DbStatement {
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): { changes: number };
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  /** Absolute path to the SQLite database file. */
  readonly location: string;
  close(): void;
}

// ── Implementation selection ───────────────────────────────────────────────
//
// Prefer the built-in node:sqlite (available from Node 22.5+).
// Claude Desktop and some other environments embed Node 18, so we fall back
// to better-sqlite3 — which ships prebuilt binaries for Node 18+ — when the
// built-in module is not present.

const [major, minor] = process.versions.node.split('.').slice(0, 2).map(Number);
const supportsBuiltin = major > 22 || (major === 22 && minor >= 5);

export const openDb: (path: string) => Db = await (async (): Promise<(path: string) => Db> => {
  // ── node:sqlite (Node 22.5+) ─────────────────────────────────────────────
  if (supportsBuiltin) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      return (path: string): Db => {
        const db = new DatabaseSync(path);
        return {
          exec(sql: string) { db.exec(sql); },
          prepare(sql: string) { return db.prepare(sql) as unknown as DbStatement; },
          get location(): string { return db.location as unknown as string; },
          close() { db.close(); },
        };
      };
    } catch {
      // node:sqlite unexpectedly unavailable — fall through to better-sqlite3
    }
  }

  // ── better-sqlite3 fallback (Node 18+) ───────────────────────────────────
  const _require = createRequire(import.meta.url);
  let BetterSqlite3: any;

  const tryLoad = () => { BetterSqlite3 = _require('better-sqlite3'); };

  try {
    tryLoad();
  } catch (firstErr) {
    // The binary may be missing or compiled for a different Node ABI.
    // Attempt a fresh install before giving up.
    const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const isAbiMismatch = msg.includes('NODE_MODULE_VERSION') || msg.includes('was compiled against');
    const isMissing     = msg.includes('Cannot find module');

    if (isAbiMismatch || isMissing) {
      const ok = ensureBetterSqlite3(getPackageDir());
      if (ok) {
        try { tryLoad(); } catch { /* fall through to error below */ }
      }
    }

    if (!BetterSqlite3) {
      const nodeVer = process.versions.node;
      throw new Error(
        `knol-local: SQLite is not available.\n` +
        `  Node ${nodeVer} does not include node:sqlite (requires Node ≥ 22.5),\n` +
        `  and better-sqlite3 could not be loaded for this Node ABI.\n` +
        `\n` +
        `  This usually happens when the active Node version changed since install.\n` +
        `  Fix options:\n` +
        `    1. Switch back to Node 22+: nvm use 22\n` +
        `    2. Reinstall for current Node: npm install -g knol-local@latest`,
      );
    }
  }

  return (path: string): Db => {
    const db: any = new BetterSqlite3(path);
    return {
      exec(sql: string) { db.exec(sql); },
      prepare(sql: string) { return db.prepare(sql) as DbStatement; },
      get location(): string { return db.name as string; },
      close() { db.close(); },
    };
  };
})();
