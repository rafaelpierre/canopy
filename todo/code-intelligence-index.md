# Code Intelligence Index — Lightweight PRD

**Goal:** Build a structured, queryable index of the open project that gives Canopy (and any embedded coding agent) precise, low-token answers to navigation, impact, and grounding questions — outperforming both `ripgrep` and standard LSP for the queries that matter in monorepo Python work.

**Non-goals (yet):** Cross-language indexing. Distributed indexes. Hosted/cloud sync. Multi-project federation.

---

## Guiding principles

- **Pre-compute structure, query at agent time.** Every grep an agent does is a token tax — replace those with one structured query.
- **Determinism > recall > precision** for symbolic queries; **precision > recall** for intent queries.
- **Build on the LSP, don't reinvent it.** Use `documentSymbol`, `references`, `definition`, `hover` to populate; let basedpyright do the typing.
- **One SQLite file as substrate.** Symbols + edges + FTS + (later) vectors. No new daemons, no new install steps.
- **Ship Tier 1 before Tier 2.** Don't build embeddings before BM25 demonstrably fails.
- **Build standalone, plug in later.** The indexer is a separate repo with its own CLI and tests. Canopy adopts it through a thin IPC layer; the indexer never imports anything from Canopy.

---

## Repo & integration model

The indexer ships as a **standalone Python package** (`canopy-index`) developed in its own repo. Canopy consumes it via a **read-only SQLite contract** — Canopy's renderer/main process reads the same `.db` file the indexer writes. Two processes, one file, no RPC needed for queries.

**Why Python for the writer:**
- [`multilspy`](https://github.com/microsoft/multilspy) (Microsoft Research) drives basedpyright in 3 lines instead of 100. Async-friendly, supports basedpyright/pyright/jedi/gopls/etc. out of the box.
- Python's stdlib `ast` complements LSP for things basedpyright doesn't expose cleanly (decorator scans for Tier 3, comment/string-literal extraction for Tier 5).
- Canopy already bundles a Python venv for basedpyright/ty under `~/Library/Application Support/canopy/lsp/`. Adding `canopy-index` to that same venv (or a sibling one) is zero new install pain for the user.
- [`scip-python`](https://github.com/sourcegraph/scip-python) is the prior art — a Python-side indexer built on pyright. Read its source before designing edges/symbol IDs.

**Why SQLite as the integration contract:**
- Canopy reads via `better-sqlite3` (Node native, already used in many Electron apps) — single in-process call, zero IPC cost per query, sub-ms reads.
- Indexer can run as one-shot CLI, long-lived sidecar, or inline library — Canopy doesn't care; it just opens the file.
- Standalone development unblocked: build + test the indexer entirely outside Canopy, validate against fixture repos via the CLI, then wire Canopy's IPC last.

**Bundling plan when Canopy adopts it:**
- Ship the indexer as a wheel installed into Canopy's existing LSP venv on first project open (mirrors how basedpyright is installed today via `install_ty` / setup IPC).
- No PyInstaller, no extra binary download — just `pip install canopy-index` into the venv we already have.
- Indexer process runs as a long-lived sidecar spawned by Canopy's main process (same lifecycle pattern as the LSP); subscribes to file-change events via stdin JSON-RPC, writes to SQLite. Renderer queries SQLite directly.

**Standalone-repo layout:**

```
canopy-index/
├── canopy_index/
│   ├── indexer.py          # walks files, drives LSP via multilspy, writes SQLite
│   ├── schema.sql          # the schema sketched below
│   ├── extractors/
│   │   ├── symbols.py      # documentSymbol → rows
│   │   ├── edges.py        # references / callHierarchy → edges
│   │   └── patterns.py     # ast.parse for decorator scans (Tier 3)
│   ├── query.py            # public Python API: callers_of, refs_of, tests_covering, ...
│   └── cli.py              # `canopy-index build|query|watch`
├── tests/
│   └── fixtures/           # known small repos + golden expected outputs
├── pyproject.toml
└── README.md
```

The CLI (`canopy-index query 'callers of pay_invoice'`) is the testability spine. CI pre-warming, scripting, and "use it without Canopy at all" all fall out of it for free.

---

## Use case tiers

Each tier is independently shippable. Numbers in `[P/C]` = Priority (1=highest) / Complexity (S/M/L).

### Tier 1 — Symbolic navigation `[P1 / S]`
*The 80% daily use case. Must beat PyCharm on completeness.*

| Query | Tech | Latency | P/R |
|---|---|---|---|
| Where is `X` defined? | symbol kv lookup | <20ms | 100% precision |
| All references to `X` | graph (def→ref) | <50ms | **100% recall** |
| Subclasses of `Foo` / impls of `Protocol P` | graph (inheritance) | <50ms | **100% recall** |
| Callers of `f()` | graph (call edges) | <50ms | **100% recall** |
| Override chain for method | graph (MRO) | <50ms | **100% recall** |

**Build:** populate `symbols` + `edges(kind=defines|references|calls|subclasses)` from LSP per file. No FTS needed.
**Why first:** highest-frequency query, easiest to evaluate (compare against `textDocument/references`), unblocks Tier 4.

---

### Tier 2 — Identifier discovery `[P2 / S]`
*"I almost remember the name."*

| Query | Tech | Latency | P/R |
|---|---|---|---|
| Function named like `process_*_payment` | FTS5 over qualified names | <30ms | recall |
| Anything in `billing.invoice.*` namespace | trigram/prefix on qualified name | <10ms | recall |
| Class fuzzy `OrderHist…` | BM25 + edit distance | <50ms | recall |

**Build:** FTS5 virtual table over `symbols.qualified_name`.
**Why second:** trivial to add once Tier 1 symbols table exists; immediate UX value (Cmd+T everywhere).

---

### Tier 3 — Pattern queries `[P2 / M]`
*"Show me all the X" — where neither IDE nor agent does well today.*

| Query | Tech | Latency | P/R |
|---|---|---|---|
| All HTTP endpoints | AST decorator scan | <100ms | high precision |
| All SQL queries in code | FTS5 on string literals + regex filter | <100ms | recall |
| All Pydantic models / Celery tasks / CLI commands | graph (decorator + subclass edges) | <50ms | **100% recall** |
| Retry/circuit-breaker usages | BM25 + AST decorator filter | <100ms | precision |

**Build:** add `decorators` edge kind during indexing; expose pattern presets.
**Why P2:** unique value (PyCharm can't do this) but only after Tier 1 graph exists.

---

### Tier 4 — Cross-cutting impact `[P1 / M]`
*The "should I touch this?" class. Single biggest argument for graph storage.*

| Query | Tech | Latency | P/R |
|---|---|---|---|
| What tests cover this function/module? | graph (imports from `tests/` ∪ calls) | <100ms | **100% recall** |
| What changes if I modify this signature? | graph multi-hop callers | <500ms | **100% recall** |
| Transitive deps of this module | graph import closure | <200ms | **100% recall** |
| Dead code (zero in-degree) | offline graph scan | <1s | recall (~95% precision; dynamic loads = false-positives) |
| Package import cycles | graph SCC | offline | 100% precision |

**Build:** SQLite recursive CTEs on `edges` table. Move to Ladybug only if hop depth >3 measurably hurts.
**Why P1:** biggest agent-token saver — "what tests cover X?" today burns thousands of tokens via grep.

---

### Tier 5 — Free-text / unstructured `[P3 / S]`
*ripgrep's home turf, but column-restricted FTS5 wins on precision.*

| Query | Tech | Latency | P/R |
|---|---|---|---|
| Search docstrings | FTS5 on `chunk.docstring` | <50ms | balanced |
| Find error string `'connection refused'` | FTS5 on string literals | <50ms | recall |
| Find config key `'DATABASE_URL'` | FTS5 on strings | <50ms | recall |
| TODO/FIXME mentioning `auth` | FTS5 on comments | <50ms | recall |
| References to `JIRA-1234` | FTS5 on comments + commit msgs | <50ms | recall |

**Build:** add `docstring`, `comments_concat`, `string_literals_concat` columns to `chunks`; FTS5 over them.
**Why P3:** ripgrep is "good enough" today; only worth building once chunks exist for Tiers 6/7.

---

### Tier 6 — Intent / concept search `[P3 / L]`
*Vector embeddings. Easy to over-build.*

| Query | Tech | Latency | P/R |
|---|---|---|---|
| Code that handles user authentication | vector over symbol-bounded chunks | <200ms | **precision >> recall** |
| Similar to this function | vector with chunk as query | <200ms | precision |
| How we usually retry HTTP calls | vector + BM25 rerank | <200ms | precision |

**Build:** sqlite-vec table; embed each chunk on indexing. Use a small local model (bge-small / nomic-embed) so no network calls.
**Why P3:** don't build until Tier 5 BM25 demonstrably misses on real queries you've logged. Most code search is symbolic, not intent-based.

---

### Tier 7 — Agent-specific grounding `[P1 / M]`
*Doesn't exist in any IDE today. The Trojan horse.*

| Query | Tech | Latency | P/R |
|---|---|---|---|
| Minimal context for changing `X` | graph (1-hop callers + signature types) + summarize | <200ms | precision (token budget) |
| Files most likely relevant to issue text | BM25 over chunks + vector rerank | <300ms | precision |
| Public API of package P | graph (`__all__` + non-underscore module-level defs) | <100ms | 100% precision |

**Build:** thin convenience layer on top of Tiers 1+4 (+6 for the issue-text case).
**Why P1:** this is the *unique* value over PyCharm/VSCode. A demo of "agent answers in 500 tokens what Cursor takes 15K to answer" is the adoption story.

---

## Schema sketch

One SQLite file at `~/.canopy/projects/<project-hash>/index.db` (decided — see Open Questions). Python writer, Node reader; same file, opened read-only from Canopy via `better-sqlite3`.

```sql
CREATE TABLE symbols (
  id            INTEGER PRIMARY KEY,
  qualified_name TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,    -- class, function, method, var, ...
  file          TEXT NOT NULL,
  line_start    INTEGER, line_end INTEGER,
  signature     TEXT,
  docstring     TEXT,
  body_hash     TEXT,             -- detect content changes
  UNIQUE (qualified_name, file)
);

CREATE TABLE edges (
  from_symbol   INTEGER NOT NULL REFERENCES symbols(id),
  to_symbol     INTEGER NOT NULL REFERENCES symbols(id),
  kind          TEXT NOT NULL,    -- defines, references, calls, subclasses, imports, decorates, returns_type
  PRIMARY KEY (from_symbol, to_symbol, kind)
);
CREATE INDEX edges_to_kind ON edges(to_symbol, kind);   -- "who points at me?"
CREATE INDEX edges_from_kind ON edges(from_symbol, kind);

-- Tier 2 + 5
CREATE VIRTUAL TABLE symbols_fts USING fts5(
  qualified_name, name, docstring, content=symbols, content_rowid=id
);

-- Tier 5 — file-level chunks for free-text queries that don't fit symbol shape
CREATE TABLE chunks (
  symbol_id    INTEGER PRIMARY KEY REFERENCES symbols(id),
  body         TEXT,
  comments     TEXT,
  strings      TEXT
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(body, comments, strings, content=chunks, content_rowid=symbol_id);

-- Tier 6 (later)
-- CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[384]);
```

Edge kinds covered for Tier 1 + 4 + 7. Add more (`raises`, `mutates`, `awaits`) as use cases prove them out.

---

## Index lifecycle

- **Cold build:** walk project, `documentSymbol` per file, populate symbols + chunks. Edges populated lazily (Tier 1+ queries trigger their own `references` calls; cache in `edges` table).
- **Incremental update:** indexer sidecar receives a JSON line on stdin per file change (Canopy's main process forwards from `lsp:watched-files-changed` events that already exist today). On Changed/Created → re-index that file in one txn. On Deleted → cascade delete from symbols (edges drop via FK). Zero new fs-watching infra.
- **Stale-detection:** `body_hash` mismatch triggers reindex on next access; covers cases where the watcher missed a change (NFS).
- **Standalone mode:** run `canopy-index watch <project>` and the same logic applies, driven by the indexer's own LSP-spawned `workspace/didChangeWatchedFiles` registrations. No Canopy needed for development or CI.

---

## Non-functional requirements

| NFR | Target | Enforcement |
|---|---|---|
| p99 Tier 1 latency | <100ms | benchmark suite |
| Cold build (100K symbols) | <30s | benchmark suite |
| Incremental file update | <200ms | benchmark suite |
| Tier 1 & 4 precision | 100% | regression tests against known fixtures |
| Tier 4 recall | 100% | regression tests; missed caller = bug |
| Tier 6 top-5 relevance | ≥80% on logged queries | manual eval against query log |
| Memory | <500MB resident @ 100K symbols | monitor |
| Disk index size | <2× source size | monitor |
| Determinism | same query → same result | regression tests; pin embedding model version |

---

## Build order recommendation

All phases happen **in the standalone `canopy-index` repo**. Canopy integration is a single late-stage step (Phase 2.5) once Phases 1–2 are validated via the CLI.

1. **Phase 0 (~2 days):** repo scaffolding, `multilspy` smoke test, schema.sql + migrations, CLI skeleton (`build`, `query`, `watch`). Goal: `canopy-index build /path/to/fixture-repo` produces a populated `.db` with one symbol kind. No real value yet, just the spine.
2. **Phase 1 (1–2 weeks):** Tier 1 + Tier 2. Indexer driven by `documentSymbol`, FTS5 on names, basic graph queries via SQL CTEs. Validated entirely via `canopy-index query …` against fixture repos with golden expected outputs.
3. **Phase 2 (1–2 weeks):** Tier 4 + Tier 7. Add edge collection from `references`/`callHierarchy`; CLI exposes `tests-covering`, `impact-of`, `minimal-context-for`.
4. **Phase 2.5 (2–3 days):** Canopy integration. New IPC handlers (`index_query`, `index_status`) in `app/modules/`. Renderer wires a "References" panel + agent tool. Indexer sidecar spawned from main process; subscribes to existing `lsp:watched-files-changed` events. **No code from Canopy is needed in the indexer repo** — only the indexer is added as a dep.
5. **Phase 3 (~1 week):** Tier 3 + Tier 5. Decorator/pattern presets, FTS over chunks. Mostly schema additions.
6. **Phase 4 (~2 weeks, defer until P3 queries log real misses):** Tier 6. sqlite-vec, local embedding model, hybrid BM25→vector rerank.

Adoption pitch lands at end of Phase 2.5: side-by-side demo of an agent inside Canopy answering "who calls X / what tests cover Y" using ~500 tokens vs Cursor/Copilot's 5–15K.

---

## Decisions taken

- **Index location:** `~/.canopy/projects/<sha1(absolute_path)>/index.db`. Keeps repos clean (no `.canopy/` to gitignore), survives `git clean -fdx`, and is trivially portable across project moves via a re-hash.
- **CLI ships in the standalone repo.** `canopy-index build|query|watch|status`. Mandatory for testability before Canopy integration; useful long-term for CI pre-warming and headless agent use.
- **Indexer language: Python.** Driven by `multilspy` + stdlib `ast`. Bundled into Canopy's existing LSP venv at adoption time.
- **Query-side: Node reads SQLite directly via `better-sqlite3`.** No RPC for queries; sub-ms reads. Indexer process is only consulted for writes/lifecycle.
- **Primary LSP: basedpyright.** Already bundled. ty is a possible secondary once its references resolution stabilizes.

## Open questions

- **Indexer sidecar lifecycle inside Canopy.** Spawn-on-project-open vs spawn-on-first-query vs always-running. Lean toward spawn-on-project-open (mirrors LSP lifecycle, predictable warm state).
- **Dependency coverage.** basedpyright lazy-parses `site-packages`; deep dep search may need a parallel `ast.parse` pass over `site-packages`. Defer until a user actually asks "what does fastapi.Response inherit from".
- **Multi-process write safety.** SQLite WAL handles single-writer/multi-reader fine, but if a user opens the same project in two Canopy windows we'd have two indexers writing. Solution: file-lock on `index.db` so the second window sees a "another session is indexing" status and just reads.
- **Indexer crash isolation.** If `multilspy` or basedpyright dies mid-build, partial state in SQLite. Use a `meta` table with `(project_path, last_complete_build_at, schema_version)` and treat absence/staleness as "rebuild on next open".
- **Versioned schema migration.** Embed a `PRAGMA user_version` and ship migrations in `schema.sql`; refuse to read an index built by a newer indexer than the consumer expects.
