# knol-local

A lightweight, fully local memory layer for AI assistants.  
Stores memories in a SQLite database on your machine — no cloud, no accounts, no API keys.

## Features

- **Persistent memory** across Claude sessions
- **Full-text search** via SQLite FTS5 with Porter stemming (`running` matches `run`, `ran`)
- **BM25 ranking** weighted by per-memory importance scores
- **Tags** for organising memories into categories
- **Zero cloud dependencies** — everything lives in `~/.knol-local/memories.db`
- **Tiny footprint** — two runtime deps: `better-sqlite3` + MCP SDK

## Tools exposed to Claude

| Tool | What it does |
|------|-------------|
| `remember` | Save a memory (content, tags, importance, metadata) |
| `recall` | Full-text search across all memories |
| `forget` | Delete a memory by ID |
| `update_memory` | Edit content, tags, or importance |
| `list_memories` | Browse recently updated memories |
| `memory_stats` | Total count, oldest/newest timestamps |

## Installation

```bash
npm install -g knol-local   # or: npx knol-local
```

Or clone and build locally:

```bash
git clone https://github.com/your-org/knol-local
cd knol-local
npm install
npm run build
```

---

## Connecting to Claude

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)  
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["knol-local"]
    }
  }
}
```

If you built from source, point directly at the binary:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/knol-local/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop — you'll see the memory tools appear in the tool list.

---

### Claude Code (CLI)

Add the server to your Claude Code config:

```bash
claude mcp add knol-local npx knol-local
```

Or add it manually to `~/.claude/claude_code_config.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["knol-local"]
    }
  }
}
```

---

## Configuration

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `KNOL_LOCAL_DB` | `~/.knol-local/memories.db` | Custom path for the SQLite database |

Example — store memories in a project-specific file:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["knol-local"],
      "env": {
        "KNOL_LOCAL_DB": "/path/to/project/.memory.db"
      }
    }
  }
}
```

---

## Usage examples

Once connected, you can talk to Claude naturally:

> "Remember that I prefer TypeScript strict mode and always use ESM."

> "What do you know about my project preferences?"

> "Forget the memory about my old API key."

Or call tools directly from Claude Code:

```
remember: "Prefer pnpm over npm for this monorepo"  tags: ["preference","tooling"]
recall:   "monorepo tooling preferences"
```

---

## Database location

```
~/.knol-local/
└── memories.db        # SQLite database (WAL mode)
```

Back up this file to preserve your memories.  
Delete it to start fresh.

---

## License

MIT
