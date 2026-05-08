/**
 * Integration test for knol-local MemoryStore.
 * Runs against a temp DB, exercises every public method,
 * and prints PASS / FAIL per assertion.
 */

import { MemoryStore } from "../dist/store.js";
import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";

const DB = `/tmp/knol-local-test-${randomUUID()}.db`;
const store = new MemoryStore(DB);

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

// ── 1. remember ─────────────────────────────────────────────────────────────
console.log("\n── remember ────────────────────────────────────────────────");

const m1 = store.add("User prefers TypeScript strict mode", {
  tags: ["preference", "coding"],
  importance: 0.9,
});
assert("returns a memory object",          typeof m1 === "object");
assert("has a UUID id",                    /^[0-9a-f-]{36}$/.test(m1.id));
assert("content is stored",               m1.content === "User prefers TypeScript strict mode");
assert("tags are stored",                 JSON.stringify(m1.tags) === '["preference","coding"]');
assert("importance is stored",            m1.importance === 0.9);
assert("created_at is a number",          typeof m1.created_at === "number");

const m2 = store.add("Project uses pnpm as package manager", { tags: ["tooling"] });
const m3 = store.add("Favourite colour is dark navy blue",    { tags: ["preference"], importance: 0.3 });
const m4 = store.add("Deploy target is Fly.io",               { tags: ["infra", "deploy"] });
const m5 = store.add("Running tests with Vitest",             { tags: ["tooling", "testing"] });

assert("5 memories added", store.stats().total === 5);

// ── 2. get ───────────────────────────────────────────────────────────────────
console.log("\n── get ─────────────────────────────────────────────────────");

const fetched = store.get(m1.id);
assert("get by id returns memory",         fetched !== undefined);
assert("get returns correct content",      fetched?.content === m1.content);
assert("get returns undefined for unknown", store.get("00000000-0000-0000-0000-000000000000") === undefined);

// ── 3. recall (FTS search) ───────────────────────────────────────────────────
console.log("\n── recall ──────────────────────────────────────────────────");

const r1 = store.search("TypeScript");
assert("finds TypeScript memory",          r1.length >= 1);
assert("top result is correct memory",     r1[0]?.id === m1.id);

const r2 = store.search("running tests");
assert("porter stemming: 'running' finds 'Vitest' memory", r2.some(r => r.id === m5.id));

const r3 = store.search("deploy fly");
assert("finds deploy/Fly.io memory",       r3.some(r => r.id === m4.id));

const r4 = store.search("preference", { tags: ["preference"] });
assert("tag filter works",                 r4.every(r => r.tags.includes("preference")));

const r5 = store.search("", { limit: 3 });
assert("empty query returns recent memories", r5.length === 3);

const r6 = store.search("TypeScript", { limit: 1 });
assert("limit is respected",              r6.length === 1);

// ── 4. update_memory ─────────────────────────────────────────────────────────
console.log("\n── update_memory ───────────────────────────────────────────");

const updated = store.update(m3.id, {
  content: "Favourite colour is deep ocean blue",
  importance: 0.7,
  tags: ["preference", "personal"],
});
assert("update returns updated memory",    updated !== undefined);
assert("content is changed",              updated?.content === "Favourite colour is deep ocean blue");
assert("importance is changed",           updated?.importance === 0.7);
assert("tags are changed",                updated?.tags.includes("personal"));
assert("updated_at bumped",               (updated?.updated_at ?? 0) >= m3.updated_at);

const notFound = store.update("00000000-0000-0000-0000-000000000000", { content: "ghost" });
assert("update of unknown id returns undefined", notFound === undefined);

// ── 5. list_memories ─────────────────────────────────────────────────────────
console.log("\n── list_memories ───────────────────────────────────────────");

const all = store.list({ limit: 10 });
assert("list returns all 5 memories",     all.length === 5);

const tooling = store.list({ tags: ["tooling"] });
assert("tag filter returns correct subset", tooling.every(m => m.tags.includes("tooling")));
assert("tooling subset has >=2 entries",   tooling.length >= 2);

// ── 6. memory_stats ───────────────────────────────────────────────────────────
console.log("\n── memory_stats ────────────────────────────────────────────");

const stats = store.stats();
assert("total is 5",    stats.total === 5);
assert("oldest is set", stats.oldest !== null);
assert("newest is set", stats.newest !== null);
assert("oldest <= newest", (stats.oldest ?? 0) <= (stats.newest ?? 0));

// ── 7. forget ────────────────────────────────────────────────────────────────
console.log("\n── forget ──────────────────────────────────────────────────");

const deleted = store.delete(m2.id);
assert("delete returns true",             deleted === true);
assert("memory is gone",                  store.get(m2.id) === undefined);
assert("total drops to 4",               store.stats().total === 4);
assert("double-delete returns false",    store.delete(m2.id) === false);

// ── edge cases ────────────────────────────────────────────────────────────────
console.log("\n── edge cases ──────────────────────────────────────────────");

// Importance clamped to [0,1]
const hi = store.add("high importance", { importance: 99 });
const lo = store.add("low importance",  { importance: -5 });
assert("importance clamped to 1.0",  hi.importance === 1.0);
assert("importance clamped to 0.0",  lo.importance === 0.0);

// FTS special chars don't crash
const weird = store.search('OR AND "NOT" NEAR*');
assert("weird FTS query doesn't throw", Array.isArray(weird));

// Empty content guard handled by caller (store stores empty, server rejects)
const empty = store.add("   ");
assert("whitespace-only content gets trimmed to empty string", empty.content === "");

// ── summary ──────────────────────────────────────────────────────────────────
store.close();
if (existsSync(DB)) unlinkSync(DB);

console.log(`\n${"─".repeat(50)}`);
console.log(`  ${passed} passed  |  ${failed} failed`);
console.log("─".repeat(50));

if (failed > 0) process.exit(1);
