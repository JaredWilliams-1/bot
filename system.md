# System Overview

Claudia is a **local-first AI executive assistant** built on Claude Code. Rather than a traditional app, it's a behavioral layer: markdown files that instruct Claude Code to become a persistent, relationship-aware assistant. The system has five distinct components.

---

## Component 1: Installer & CLI (`bin/`)

**Tech:** Node.js, zero production dependencies

The `npx get-claudia` entry point. It:
- Copies the template to the user's machine
- Sets up a Python venv for the memory daemon
- Writes `.mcp.json` to wire up MCP servers
- Handles Google OAuth setup
- Manages upgrades with SHA256 manifest-based conflict detection (so user customizations aren't overwritten)

---

## Component 2: Template Layer (`template-v2/`)

**Tech:** Markdown, YAML frontmatter

This is the core of what makes Claude *become* Claudia. Claude Code reads these files at session start:

| File type | Location | Purpose |
|-----------|----------|---------|
| Identity | `CLAUDE.md` | Who Claudia is, how she behaves, communication style |
| Rules | `.claude/rules/` | Always-active principles (safety, honesty, no em dashes, etc.) |
| Skills | `.claude/skills/` | 41+ behaviors: proactive, contextual, and explicit commands |
| Hooks | `.claude/hooks/` | Session lifecycle (start/end triggers) |

Skills have three invocation modes: **proactive** (auto-trigger on signals like commitment language), **contextual** (natural language or `/command`), and **explicit** (slash command only).

---

## Component 3: Memory Daemon (`memory-daemon/`)

**Tech:** Python 3.10+, SQLite + sqlite-vec, Ollama, MCP protocol (stdio transport)

A background Python process that exposes ~33 MCP tools to Claude. It provides persistent memory across sessions.

**Key services:**
- **Remember/Recall** - Store and semantically search facts with hybrid ranking (60% vector similarity, 25% importance, 10% recency, 5% full-text)
- **Consolidation** - Background scheduler (APScheduler) runs nightly: importance decay, near-duplicate merging, pattern detection, prediction generation
- **VaultSync** - Exports memory to an Obsidian vault at `~/.claudia/vault/` in PARA structure (`Active/`, `Relationships/`, `Reference/`, `Archive/`)
- **Health** - HTTP endpoint on port 3848

**Data:** SQLite at `~/.claudia/memory/claudia.db` with `sqlite-vec` for 384-dimensional embeddings generated locally via Ollama (`all-minilm:l6-v2`). Everything stays on the user's machine.

---

## Component 4: Brain Visualizer (`visualizer/`)

**Tech:** Express.js, React 19, Three.js, react-three-fiber, UMAP.js, Zustand

A 3D interactive memory graph explorer, launched via the `/brain` skill.

- **Backend:** Express server on port 3849, reads SQLite in read-only WAL-safe mode, serves graph data via REST + SSE for real-time updates
- **Frontend:** React + Three.js renders a force-directed 3D graph; nodes are entities/memories, edges are relationships
- **Dimensionality reduction:** UMAP collapses 384-dim embeddings to 3D coordinates for layout

---

## Component 5: Integration Layer (MCP ecosystem)

External connections wired through `.mcp.json`:

| Integration | What it provides |
|-------------|-----------------|
| Memory daemon | ~33 tools for persistent memory |
| Gmail MCP | Email read/send |
| Google Calendar MCP | Calendar access |
| Google Workspace MCP | Gmail + Calendar + Drive + Docs + Sheets (43-111 tools) |
| Rube (Composio) | 500+ apps via one OAuth aggregator (Slack, Notion, Jira, GitHub, etc.) |
| Brave Search | Web research |

---

## Data Flow (end-to-end)

```
User says: "I'll send the proposal by Friday"
    ↓
commitment-detector (proactive skill) catches the promise
    ↓
Claudia calls memory_remember MCP tool (stdio → Python daemon)
    ↓
Daemon: stores text + generates Ollama embedding + writes to SQLite
    ↓
Nightly: consolidation runs, decay applied, patterns detected
    ↓
Next session: memory_briefing returns "proposal to [person] due Friday"
    ↓
Visualizer: entity node visible in 3D graph
```

---

## Architecture Philosophy

Three principles shape every design decision:

1. **Local-first** - SQLite + Ollama on the user's machine, no external memory APIs
2. **Progressive complexity** - Structure emerges from use, never imposed up front
3. **People as the primary organizing unit** - Relationships drive context, not files or folders
