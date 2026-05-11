import * as http from "node:http";
import { createRequire } from "node:module";
import { MemoryStore } from "./store.js";

const _require = createRequire(import.meta.url);
const VERSION: string = (_require("../package.json") as { version: string }).version;

// ── Helpers ────────────────────────────────────────────────────────────────

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  setCors(res);
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB — generous for memory payloads

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      size += Buffer.byteLength(chunk as string);
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large (limit: 1 MiB)"));
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(url.slice(idx + 1))) {
    params[k] = v;
  }
  return params;
}

function parsePath(url: string): string {
  const idx = url.indexOf("?");
  return idx === -1 ? url : url.slice(0, idx);
}

function checkAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  apiKey: string | undefined,
): boolean {
  if (!apiKey) return true;
  const auth = req.headers["authorization"] ?? "";
  if (auth === `Bearer ${apiKey}`) return true;
  json(res, 401, { error: "Unauthorized" });
  return false;
}

// ── Server factory ─────────────────────────────────────────────────────────

export function startHttpServer(
  store: MemoryStore,
  opts: { port: number; apiKey?: string },
): http.Server {
  const server = http.createServer(async (req, res) => {
    const method = req.method?.toUpperCase() ?? "GET";
    const rawUrl = req.url ?? "/";
    const path = parsePath(rawUrl);
    const query = parseQuery(rawUrl);

    // CORS preflight
    if (method === "OPTIONS") {
      setCors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check — no auth required
    if (method === "GET" && path === "/health") {
      json(res, 200, { ok: true, version: VERSION });
      return;
    }

    // Auth check for all other routes
    if (!checkAuth(req, res, opts.apiKey)) return;

    try {
      // GET /memories/search
      if (method === "GET" && path === "/memories/search") {
        const q = query["q"] ?? "";
        const limit = query["limit"] ? parseInt(query["limit"], 10) : 10;
        const tags = query["tags"] ? query["tags"].split(",").filter(Boolean) : undefined;
        const memories = store.search(q, { limit, tags });
        json(res, 200, { found: memories.length, memories });
        return;
      }

      // GET /memories/stats
      if (method === "GET" && path === "/memories/stats") {
        const s = store.stats();
        json(res, 200, {
          total_memories: s.total,
          oldest: s.oldest ? new Date(s.oldest).toISOString() : null,
          newest: s.newest ? new Date(s.newest).toISOString() : null,
        });
        return;
      }

      // GET /export
      if (method === "GET" && path === "/export") {
        const memories = store.exportAll();
        json(res, 200, {
          version: VERSION,
          exported_at: new Date().toISOString(),
          count: memories.length,
          memories,
        });
        return;
      }

      // POST /import
      if (method === "POST" && path === "/import") {
        const body = await readBody(req) as Record<string, unknown>;
        const entries = Array.isArray(body["memories"]) ? body["memories"] : [];
        const result = store.importAll(
          entries as Array<{
            content: string;
            tags?: string[];
            importance?: number;
            metadata?: Record<string, unknown>;
            created_at?: number;
          }>,
        );
        json(res, 200, result);
        return;
      }

      // GET /memories
      if (method === "GET" && path === "/memories") {
        const limit = query["limit"] ? parseInt(query["limit"], 10) : 20;
        const tags = query["tags"] ? query["tags"].split(",").filter(Boolean) : undefined;
        const memories = store.list({ limit, tags });
        json(res, 200, { total: memories.length, memories });
        return;
      }

      // POST /memories
      if (method === "POST" && path === "/memories") {
        const body = await readBody(req) as Record<string, unknown>;
        const content = String(body["content"] ?? "").trim();
        if (!content) {
          json(res, 400, { error: "content is required" });
          return;
        }
        const memory = store.add(content, {
          tags: Array.isArray(body["tags"]) ? (body["tags"] as string[]) : undefined,
          importance: typeof body["importance"] === "number" ? body["importance"] : undefined,
          metadata:
            body["metadata"] && typeof body["metadata"] === "object"
              ? (body["metadata"] as Record<string, unknown>)
              : undefined,
        });
        json(res, 201, { stored: true, memory });
        return;
      }

      // Routes with :id
      const idMatch = path.match(/^\/memories\/([^/]+)$/);
      if (idMatch) {
        const id = idMatch[1];

        // GET /memories/:id
        if (method === "GET") {
          const memory = store.get(id);
          if (!memory) { json(res, 404, { error: "Not found" }); return; }
          json(res, 200, memory);
          return;
        }

        // PATCH /memories/:id
        if (method === "PATCH") {
          const body = await readBody(req) as Record<string, unknown>;
          const updated = store.update(id, {
            content: typeof body["content"] === "string" ? body["content"] : undefined,
            tags: Array.isArray(body["tags"]) ? (body["tags"] as string[]) : undefined,
            importance: typeof body["importance"] === "number" ? body["importance"] : undefined,
          });
          if (!updated) { json(res, 404, { error: "Not found" }); return; }
          json(res, 200, updated);
          return;
        }

        // DELETE /memories/:id
        if (method === "DELETE") {
          const deleted = store.delete(id);
          if (!deleted) { json(res, 404, { error: "Not found" }); return; }
          json(res, 200, { deleted: true });
          return;
        }
      }

      json(res, 404, { error: "Not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(opts.port);
  return server;
}
