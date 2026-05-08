#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { MemoryStore } from "./store.js";

// ── Config ─────────────────────────────────────────────────────────────────

const dbPath = process.env["KNOL_LOCAL_DB"]; // optional override
const store = new MemoryStore(dbPath);

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "remember",
    description:
      "Save something to long-term memory. " +
      "Use this whenever the user shares a preference, fact, decision, task, or any detail worth retaining across sessions. " +
      "Stored memories are full-text searchable.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The text to remember. Be descriptive — this is what gets searched later.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional labels for grouping (e.g. ['preference', 'coding', 'work']).",
        },
        importance: {
          type: "number",
          description: "Importance score from 0 to 1. Default 0.5. Use 0.8–1.0 for critical facts.",
        },
        metadata: {
          type: "object",
          description: "Any extra structured data to attach (e.g. {source: 'user', project: 'knol'}).",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description:
      "Search long-term memory using full-text search. " +
      "Returns the most relevant memories for the query, ranked by relevance and importance. " +
      "Call this at the start of a session or whenever context from the past may be useful.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language search query (e.g. 'user database preferences').",
        },
        limit: {
          type: "number",
          description: "Max number of results to return (default 10, max 50).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Only return memories that have at least one of these tags.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "forget",
    description: "Permanently delete a memory by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory UUID to delete (returned by remember or recall).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "update_memory",
    description: "Edit the content, tags, or importance of an existing memory.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory UUID to update.",
        },
        content: {
          type: "string",
          description: "Replacement text (leave blank to keep existing).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replacement tag list (replaces all existing tags).",
        },
        importance: {
          type: "number",
          description: "New importance score 0–1.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "list_memories",
    description:
      "List the most recently updated memories. " +
      "Useful for a quick overview of what is stored.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max results (default 20, max 100).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter to memories with at least one of these tags.",
        },
      },
    },
  },
  {
    name: "memory_stats",
    description: "Return summary statistics: total memories stored, oldest and newest timestamps.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function text(obj: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function formatDate(ms: number | null): string {
  return ms ? new Date(ms).toISOString() : "—";
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "knol-local", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } },
);

// ── Tools handler ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, unknown>;

  try {
    switch (name) {
      // ── remember ────────────────────────────────────────────────────────
      case "remember": {
        const content = String(a["content"] ?? "").trim();
        if (!content) throw new Error("content must not be empty");

        const memory = store.add(content, {
          tags: Array.isArray(a["tags"]) ? (a["tags"] as string[]) : undefined,
          importance: typeof a["importance"] === "number" ? a["importance"] : undefined,
          metadata:
            a["metadata"] && typeof a["metadata"] === "object"
              ? (a["metadata"] as Record<string, unknown>)
              : undefined,
        });

        return text({ stored: true, id: memory.id, memory });
      }

      // ── recall ───────────────────────────────────────────────────────────
      case "recall": {
        const query = String(a["query"] ?? "").trim();
        const limit = typeof a["limit"] === "number" ? clamp(a["limit"], 1, 50) : 10;
        const tags = Array.isArray(a["tags"]) ? (a["tags"] as string[]) : undefined;

        const results = store.search(query, { limit, tags });

        if (results.length === 0) {
          return text({ found: 0, memories: [], hint: "No matching memories. Try a broader query." });
        }

        return text({ found: results.length, memories: results });
      }

      // ── forget ───────────────────────────────────────────────────────────
      case "forget": {
        const id = String(a["id"] ?? "").trim();
        if (!id) throw new Error("id is required");

        const deleted = store.delete(id);
        if (!deleted) throw new Error(`No memory found with id: ${id}`);

        return text({ deleted: true, id });
      }

      // ── update_memory ────────────────────────────────────────────────────
      case "update_memory": {
        const id = String(a["id"] ?? "").trim();
        if (!id) throw new Error("id is required");

        const updated = store.update(id, {
          content: typeof a["content"] === "string" ? a["content"] : undefined,
          tags: Array.isArray(a["tags"]) ? (a["tags"] as string[]) : undefined,
          importance: typeof a["importance"] === "number" ? a["importance"] : undefined,
        });

        if (!updated) throw new Error(`No memory found with id: ${id}`);

        return text({ updated: true, memory: updated });
      }

      // ── list_memories ─────────────────────────────────────────────────────
      case "list_memories": {
        const limit = typeof a["limit"] === "number" ? clamp(a["limit"], 1, 100) : 20;
        const tags = Array.isArray(a["tags"]) ? (a["tags"] as string[]) : undefined;

        const memories = store.list({ limit, tags });
        return text({ total: memories.length, memories });
      }

      // ── memory_stats ──────────────────────────────────────────────────────
      case "memory_stats": {
        const s = store.stats();
        return text({
          total_memories: s.total,
          oldest: formatDate(s.oldest),
          newest: formatDate(s.newest),
        });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

// ── Resources ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "memory://recent",
      name: "Recent Memories",
      description: "The 20 most recently updated memories",
      mimeType: "application/json",
    },
    {
      uri: "memory://stats",
      name: "Memory Stats",
      description: "Total count and date range of stored memories",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  switch (uri) {
    case "memory://recent": {
      const memories = store.list({ limit: 20 });
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(memories, null, 2) }],
      };
    }

    case "memory://stats": {
      const s = store.stats();
      const payload = {
        total_memories: s.total,
        oldest: formatDate(s.oldest),
        newest: formatDate(s.newest),
      };
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
      };
    }

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// ── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
