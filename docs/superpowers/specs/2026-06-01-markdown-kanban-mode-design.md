# Markdown Kanban Mode

**Date:** 2026-06-01  
**Status:** Design Approved  
**Feature:** File-backed markdown storage mode for Kanban cards

## Overview

Add a second Kanban storage mode where cards are markdown files in user-configured folders. Markdown mode makes board cards readable, editable, version-controlled, and accessible to coding agents as ordinary project files. It is mutually exclusive with the existing internal SQLite-backed mode on a per-project basis.

## Goals

- Let teams store Kanban cards as markdown files committed with their project.
- Let agents create, edit, and move cards through normal file operations.
- Keep card metadata human-readable through YAML frontmatter.
- Preserve the existing board UI and workflows where possible.
- Let users choose markdown mode for clean boards without forcing a migration workflow.

## Non-Goals

- Continuous mirroring between SQLite and markdown files.
- Automatic or assisted migration between internal and markdown modes for populated boards.
- Resolving git merge conflicts inside Hive.
- Preserving logical card identity if a user deliberately changes a card's frontmatter `id`.
- Guaranteeing version control for folders outside the selected project or outside any git repository.

## Architecture

Each project has a Kanban storage mode:

- `internal`: current SQLite-backed `kanban_tickets` behavior.
- `markdown`: cards are loaded from and written to markdown files.

The renderer should continue using the Kanban store as the UI boundary, but the preload and IPC contract must become project-scoped for ticket-scoped mutations. Markdown card IDs are stable only within a project, and the router also needs the project to select the correct storage mode. The main process should route every Kanban operation through a project-mode-aware backend surface, not just the basic CRUD path. The backend surface must cover the existing workflows promised by the UI and IPC handlers: lifecycle, ordering, archive actions, session lookups, token accounting, PR metadata, and dependencies.

```ts
interface KanbanBackend {
  // Ticket lifecycle and ordering
  get(projectId, ticketId): Promise<KanbanTicket | null>
  list(projectId, includeArchived): Promise<KanbanTicket[]>
  create(projectId, data): Promise<KanbanTicket>
  createBatch(projectId, data): Promise<KanbanTicketBatchCreateResult>
  update(projectId, ticketId, data): Promise<KanbanTicket | null>
  move(projectId, ticketId, column, sortOrder): Promise<KanbanTicket | null>
  reorder(projectId, ticketId, sortOrder): Promise<void>
  delete(projectId, ticketId): Promise<boolean>
  archive(projectId, ticketId): Promise<KanbanTicket | null>
  archiveAllDone(projectId): Promise<number>
  unarchive(projectId, ticketId): Promise<KanbanTicket | null>

  // Local runtime links and accounting
  getBySession(sessionId): Promise<KanbanTicket[]>
  addTokens(projectId, ticketId, tokens): Promise<KanbanTicket | null>
  detachWorktree(worktreeId): Promise<number>

  // Public PR metadata
  syncPR(worktreeId, prNumber, prUrl): Promise<void>
  clearPR(worktreeId): Promise<void>
  attachPR(projectId, ticketId, prNumber, prUrl): Promise<void>
  detachPR(projectId, ticketId): Promise<void>

  // Dependencies
  addDependency(projectId, dependentId, blockerId): Promise<{ success: boolean; error?: string }>
  removeDependency(projectId, dependentId, blockerId): Promise<boolean>
  getBlockers(projectId, ticketId): Promise<KanbanTicket[]>
  getDependents(projectId, ticketId): Promise<KanbanTicket[]>
  getDependenciesForProject(projectId): Promise<TicketDependency[]>
  removeAllDependencies(projectId, ticketId): Promise<number>
}
```

In markdown mode, `ticketId` is the frontmatter `id`. The markdown backend keeps an in-memory project index of `id -> file path -> parsed card`. Indexes are watched while their board is active, but they must also be loadable on demand for background workflows. The backend should expose an internal `ensureMarkdownIndex(projectId)` operation that performs a full scan when a needed project index is absent or stale.

Markdown mode has two persistence targets: markdown files for public, team-authored card state, and local Hive storage for private/runtime state. The canonical field mapping is defined in KanbanTicket Shape Parity, with local persistence details in Local Runtime State.

Operations that combine both targets must define routing explicitly. Direct ticket mutations use the project mode to select the backend, while session- or worktree-keyed APIs resolve local links to project/card references before touching markdown. Background workflows must call `ensureMarkdownIndex(projectId)` as needed and must not depend on the board being open. If an operation cannot resolve a card unambiguously because of duplicate IDs, it should fail with the duplicate-ID error state defined in Card Identity rather than guessing.

## Preload And IPC Contract

The existing renderer store already knows `projectId` for most ticket-scoped mutations, but several preload and IPC methods currently accept only `ticketId`. Markdown mode must change those calls to pass `projectId` explicitly.

Required project-scoped ticket APIs:

```ts
ticket.create(projectId, data)
ticket.createBatch(projectId, data)
ticket.get(projectId, ticketId)
ticket.update(projectId, ticketId, data)
ticket.delete(projectId, ticketId)
ticket.archive(projectId, ticketId)
ticket.unarchive(projectId, ticketId)
ticket.move(projectId, ticketId, column, sortOrder)
ticket.reorder(projectId, ticketId, sortOrder)
ticket.addTokens(projectId, ticketId, tokens)
dependency.add(projectId, dependentId, blockerId)
dependency.remove(projectId, dependentId, blockerId)
dependency.getBlockers(projectId, ticketId)
dependency.getDependents(projectId, ticketId)
dependency.removeAll(projectId, ticketId)
```

APIs that are already project-scoped should remain project-scoped, such as `getByProject`, `archiveAllDone`, `getDependenciesForProject`, board export, and board import.

APIs that resolve by local runtime linkage can stay keyed by their natural local handle, but their implementation must resolve through the runtime-state table and active markdown indexes in markdown mode:

```ts
ticket.getBySession(sessionId)
ticket.detachWorktree(worktreeId)
ticket.syncPR(worktreeId, prNumber, prUrl)
ticket.clearPR(worktreeId)
```

This is an intentional breaking internal preload/renderer-store change. Implementation should update preload types, handler schemas, store calls, and tests together instead of adding markdown-only overloads.

`KanbanTicketCreate` and `KanbanTicketBatchCreateItem` currently carry `project_id`. The project-scoped preload contract should still pass `projectId` as the routing key. Payload `project_id` may remain for compatibility during the refactor, but handlers must validate it matches the path-level `projectId` when both are present.

## Card Diagnostics

Markdown mode needs a renderer-visible diagnostics side channel for parse errors, duplicate IDs, and blocked cards. These diagnostics should not be added to `KanbanTicket`, because shape parity keeps `KanbanTicket` aligned with the existing app model.

Add a project-scoped diagnostics store/API keyed by `TicketRef` when a card has a usable ID, and by file path when it does not:

```ts
type MarkdownCardDiagnosticKind = 'parse_error' | 'invalid_frontmatter' | 'duplicate_id'

interface MarkdownCardDiagnostic {
  projectId: string
  ticketId: string | null
  filePath: string
  kind: MarkdownCardDiagnosticKind
  message: string
  blocking: true
}
```

Backend list/load operations should return or publish both hydrated tickets and diagnostics. The renderer store should expose diagnostics by project so cards and invalid placeholders can show warning/error states, tooltips, and disabled controls. Any action targeting a diagnostic card with `blocking: true` must follow the blocking behavior defined in Card Identity before mutating markdown or local runtime state.

Invalid files that cannot hydrate into `KanbanTicket` should appear as invalid-card placeholders driven by diagnostics, not as partial `KanbanTicket` objects.

## Renderer Identity

Markdown card IDs are only guaranteed unique within a project. Renderer state must stop treating bare `ticket.id` as a globally unique key.

Introduce a shared ticket reference shape for renderer state and component props where identity crosses a single project boundary:

```ts
interface TicketRef {
  projectId: string
  ticketId: string
}
```

Required renderer identity changes:

- Replace modal selection state like `selectedTicketId: string | null` with `selectedTicketRef: TicketRef | null`.
- Replace dependency mode state like `sourceTicketId` with `sourceTicketRef`.
- Key dependency maps by project-scoped identity. Either use nested maps (`Map<projectId, Map<dependentId, Set<blockerId>>>`) or a stable composite key helper.
- In pinned and connection boards, find cards by `(project_id, id)`, not by `id` alone.
- DOM IDs, drag payloads, animation layout IDs, dependency line keys, and test IDs that need card identity across multi-project boards should include both project ID and ticket ID.

Dependencies remain project-local in v1, matching the existing database rule that dependent and blocker tickets must be in the same project. Cross-project dependency lines are out of scope.

## Local Runtime State

Markdown mode needs an explicit local persistence table for card state that must not be written to markdown. The table should be keyed by `(project_id, card_id)`, where `card_id` is the markdown frontmatter `id`.

Suggested shape:

```sql
CREATE TABLE markdown_kanban_card_state (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  current_session_id TEXT DEFAULT NULL REFERENCES sessions(id) ON DELETE SET NULL,
  worktree_id TEXT DEFAULT NULL REFERENCES worktrees(id) ON DELETE SET NULL,
  note TEXT DEFAULT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  plan_ready INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  pending_launch_config TEXT DEFAULT NULL,
  last_seen_path TEXT DEFAULT NULL,
  orphaned_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, card_id)
);

CREATE INDEX idx_markdown_kanban_card_state_session
  ON markdown_kanban_card_state(current_session_id);
CREATE INDEX idx_markdown_kanban_card_state_worktree
  ON markdown_kanban_card_state(worktree_id);
```

Hydration rules:

- Markdown parsing produces public card data from files.
- Hive joins local runtime state by `(project_id, id)` before returning `KanbanTicket` objects to the existing renderer.
- Local runtime state is created lazily when a workflow needs it, such as session launch, note edit, prompt attachment edit, plan-ready update, token update, or pending launch setup.
- Duplicate-ID cards must not hydrate or mutate local runtime state, because the key is ambiguous.

Operation rules:

- Session launch or continuation updates `current_session_id`, `worktree_id`, and any pending launch fields in `markdown_kanban_card_state`.
- `getBySession(sessionId)` queries `markdown_kanban_card_state`, then resolves each `(project_id, card_id)` against the current markdown index.
- `addTokens(projectId, ticketId, tokens)` increments `total_tokens` in local state only.
- `detachWorktree(worktreeId)` clears `worktree_id` from local state only.
- `syncPR(worktreeId, ...)` finds local rows linked to the worktree and writes public PR metadata to those cards' markdown frontmatter.
- Ticket prompt attachment edits, plan review completion, and personal note edits write only to local state. Markdown files should not embed Hive's prompt attachment JSON, plan-ready state, or personal notes.

Cleanup rules:

- On a successful full reload of a markdown board, Hive updates `last_seen_path` and clears `orphaned_at` for visible non-duplicate cards.
- Local rows whose `(project_id, card_id)` no longer exist in the full reload result are ignored by the board and marked with `orphaned_at`.
- A later successful full reload that still does not see the card should delete the orphaned row. This gives temporary editor writes and folder moves one full-scan grace cycle before local state is removed.
- Cleanup should not run from a single watcher delete event.
- If a file is renamed but keeps the same `id`, local state follows the card and `last_seen_path` is updated.
- If a file's `id` changes, Hive treats it as a different card; the old local row is marked with `orphaned_at` and then deleted by the subsequent full-reload cleanup rule.
- If a missing card later reappears before cleanup with the same `id`, its local state can be reused.

## Storage Configuration

The default markdown storage path is:

```text
docs/kanban/
```

Projects can override this with either:

- one custom folder containing all cards, or
- three status folders keyed by Hive column groups: `todo`, `in_progress`, and `done`.

Kanban storage mode and markdown folder configuration must persist in SQLite so board behavior survives app restart. Add project-level configuration to the `projects` table or an equivalent project settings table.

Suggested project columns:

```sql
ALTER TABLE projects ADD COLUMN kanban_storage_mode TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE projects ADD COLUMN kanban_markdown_config TEXT DEFAULT NULL;
```

`kanban_storage_mode` values:

- `internal`
- `markdown`

`kanban_markdown_config` stores a JSON object:

```json
{
  "layout": "single-folder",
  "singleFolder": "docs/kanban",
  "statusFolders": {
    "todo": "docs/kanban/todo",
    "in_progress": "docs/kanban/in-progress",
    "done": "docs/kanban/done"
  }
}
```

For `single-folder`, Hive uses `singleFolder` and ignores `statusFolders`. For `status-folders`, Hive uses all three `statusFolders` entries. Paths may be relative to the project path or absolute. Relative paths are resolved from the project root. The default config is `layout: "single-folder"` with `singleFolder: "docs/kanban"`.

Filesystem policy for markdown folders:

- Canonicalize every configured folder with `realpath` before scanning, watching, reading, writing, or moving files.
- Store the user-provided path in config, but use canonical paths for duplicate detection and access decisions.
- Reject configs where two logical folders resolve to the same canonical directory.
- Reject configs where one configured folder is nested inside another configured folder, to avoid double indexing and duplicate watcher events.
- Follow symlinks only for the configured folder root during canonicalization. Do not recurse into symlinked child directories.
- Scan markdown files only one directory deep within each configured folder in v1. Recursive board folders are out of scope.
- Accept only `.md` and `.markdown` files as card candidates.
- Ignore hidden files, temporary editor files, and files whose basename starts with `.` or ends with common transient suffixes such as `.tmp`, `.swp`, `.bak`, or `~`.
- Enforce a conservative file size limit for card parsing, for example 1 MB per card.
- Enforce a per-project watcher limit equal to the configured folder count: one watcher for single-folder mode and three watchers for status-folder mode.
- If canonicalization, permission checks, or watcher setup fails, keep the project in an explicit configuration error state rather than scanning a broader parent directory.

Mode/config APIs should be explicit and project-scoped:

```ts
kanban.config.get(projectId): Promise<KanbanStorageConfig>
kanban.config.update(projectId, config): Promise<KanbanStorageConfig>
kanban.config.setMode(projectId, mode): Promise<{ success: boolean; error?: string }>
```

`setMode` must enforce the clean-board rule: switch immediately for empty boards and reject populated boards without changing persisted mode. The Project Settings UI should surface that rejection as an inline notice or dialog explaining why the mode cannot be changed.

Status folders may be outside the current project workspace. Hive should allow that, but should warn that cards outside the project may not be versioned with the project.

Hive's workflow state remains frontmatter-driven. Folders are physical organization:

- `todo` maps to `statusFolders.todo`.
- `in_progress` maps to `statusFolders.in_progress`.
- `review` maps to `statusFolders.in_progress`.
- `done` maps to `statusFolders.done`.

When a card's `column` changes in Hive:

- single-folder mode updates frontmatter only.
- status-folder mode updates frontmatter and moves the file to the matching folder.

## Markdown Format

Each card is a markdown file. The markdown body is the card description.

Minimum frontmatter:

```yaml
---
id: implementation-kanban-board-f90
title: Implementation Kanban Board
column: todo
mode: build
sort_order: 1000
archived_at: null
created_at: 2026-06-01T10:00:00.000Z
---
```

Hive should not write `updated_at` to frontmatter, because it would add noisy git churn on normal edits and drags.

Known fields owned by Hive:

- `id`
- `title`
- `column`
- `mode`
- `sort_order`
- `archived_at`
- `created_at`
- `dependencies`
- supported public metadata such as `mark`, external ticket fields, PR fields, `goal_mode`, and `goal_success_criteria`

When rewriting frontmatter, Hive must update only fields it owns and preserve unknown frontmatter fields.

## KanbanTicket Shape Parity

Markdown mode should preserve the full existing `KanbanTicket` shape at the renderer and preload boundary. That does not mean every field lives in markdown. It means every field has an explicit source when Hive hydrates a markdown card into a `KanbanTicket`.

Field ownership:

| Field | Source in markdown mode |
| --- | --- |
| `id` | Frontmatter `id` |
| `project_id` | Current project, not stored in markdown |
| `title` | Frontmatter `title` |
| `description` | Markdown body |
| `attachments` | `markdown_kanban_card_state.attachments` |
| `column` | Frontmatter `column` |
| `sort_order` | Frontmatter `sort_order` |
| `current_session_id` | `markdown_kanban_card_state.current_session_id` |
| `worktree_id` | `markdown_kanban_card_state.worktree_id` |
| `mode` | Frontmatter `mode` |
| `plan_ready` | `markdown_kanban_card_state.plan_ready` |
| `created_at` | Frontmatter `created_at` |
| `updated_at` | Derived value; use the later of file `mtime` and local runtime-state `updated_at`, falling back to `created_at` |
| `archived_at` | Frontmatter `archived_at` |
| `external_provider` | Frontmatter `external_provider` |
| `external_id` | Frontmatter `external_id` |
| `external_url` | Frontmatter `external_url` |
| `github_pr_number` | Frontmatter `github_pr_number` |
| `github_pr_url` | Frontmatter `github_pr_url` |
| `mark` | Frontmatter `mark` |
| `total_tokens` | `markdown_kanban_card_state.total_tokens` |
| `pending_launch_config` | `markdown_kanban_card_state.pending_launch_config` |
| `goal_mode` | Frontmatter `goal_mode` |
| `goal_success_criteria` | Frontmatter `goal_success_criteria` |
| `note` | `markdown_kanban_card_state.note` |

Default hydration values for missing optional data should match internal-mode behavior where possible: nullable fields hydrate as `null`, booleans hydrate as `false`, arrays hydrate as `[]`, and token totals hydrate as `0`.

Fields omitted from this matrix are unsupported in v1 and must be added to the matrix before implementation relies on them.

## Card Identity

Cards have generated frontmatter IDs. The ID is human-readable but stable enough for dependencies and local session links.

ID generation:

- derive a lowercase ASCII slug from title or filename.
- append a short random suffix of 3-5 `a-z0-9` characters.
- example: `implementation-kanban-board-f90`.

On create, Hive generates the ID. On load, if a file is missing `id`, Hive auto-generates one and writes it back only when the frontmatter can be parsed and the file can be safely rewritten. Malformed frontmatter, invalid known fields, or unwritable files are diagnostic-only states; Hive must not mutate those files as part of missing-field repair.

Duplicate IDs are not supported. If duplicate IDs are found, Hive keeps the affected cards visible with a warning marker so the user can find the files, but the affected cards are read-only in Hive. Hive should block all actions on those cards, including edit, move, archive, delete, dependency changes, session launch, PR updates, and local runtime-link updates, until one of the duplicated frontmatter IDs is changed.

Other blocking diagnostics follow the same no-mutation rule.

If a file is renamed but keeps the same `id`, the card remains the same logical card at a new path. If the `id` changes, Hive treats it as a different card.

## Sync And Editing

Markdown mode treats disk as the source of truth.

Hive reloads markdown cards:

- when the board opens.
- when the app regains focus.
- when the user triggers explicit refresh.
- through configured folder watchers while the board is active.

External changes from agents or teammates are reparsed and reflected in the board. New valid markdown files in configured folders appear as cards automatically.

Write behavior:

- update only Hive-owned frontmatter fields.
- preserve unknown frontmatter fields.
- preserve markdown body unless editing the description.
- write files atomically enough to avoid treating half-written content as final.
- debounce or suppress watcher reactions to Hive's own writes to avoid flicker.

If a watched file has invalid frontmatter, invalid known fields, or cannot be safely written, Hive keeps the last valid in-memory card visible when available and marks it with a parse/error state. If no prior valid card exists, Hive shows an invalid-card placeholder with the file path and parse error. These states are diagnostic-only: Hive should not attempt automatic frontmatter repair until the file is parseable and writable.

If a file disappears, the card disappears from markdown mode after reload or watcher update.

## Mode Switching

Mode switching is intentionally narrow in the first version.

The clean-board rule is based on persisted Hive board data, not just the currently visible unarchived board. A project can switch modes only when the current persisted backend has no active or archived cards, and when the internal SQLite backend has no active or archived tickets. Target markdown folders are not required to be empty when switching from `internal` to `markdown`; existing markdown files there are adopted as the markdown board contents.

Exact checks:

- Always query SQLite tickets for the project with `includeArchived: true`. If any internal ticket exists, including an archived ticket, block the mode change.
- Current mode `markdown`: perform a full scan of the configured markdown folders, including archived cards and invalid card placeholders. If any card-like markdown files exist, block switching away from markdown mode.

If all applicable checks pass, Hive switches modes immediately.

Target-backend behavior:

- Switching to markdown from internal mode does not require target markdown folders to be empty. Existing markdown files in the configured folders are allowed and become the markdown board contents after the switch; this adoption is not a migration or import from the internal backend.
- When adopting existing parseable and writable markdown files, Hive repairs missing app-owned frontmatter fields using defaults: generated `id`, filename-derived or heading-derived `title`, `column: todo`, `sort_order` appended after existing cards, `mode: build`, `archived_at: null`, and `created_at` from file birthtime when available or current time otherwise.
- Existing valid frontmatter values are preserved. Unknown frontmatter fields are preserved.
- Switching to internal does not import markdown files. It simply changes the active backend to the empty internal persisted board, after markdown folders and internal SQLite tickets both pass the clean-board rule.

If any clean-board check fails, Hive does not switch modes. The Project Settings UI should show a blocking notice explaining that changing storage mode for a populated board is not supported yet. The notice should tell the user to clear or delete the persisted cards that failed the check, or create/select a clean board before changing modes. Archiving cards is not sufficient because archived cards still count as persisted board data.

Mode switching must not invoke board export/import, create markdown files from internal tickets, import markdown files into SQLite, or otherwise convert cards between backends.

## Board Behavior

Markdown mode should preserve existing Kanban workflows where possible:

- create card.
- edit title and description.
- edit frontmatter-backed properties.
- drag between columns.
- archive and unarchive.
- archive all done cards.
- delete.
- sort within columns.
- create dependencies.
- create board assistant draft tickets.
- launch or continue local sessions linked to a card ID.
- attach, detach, sync, and clear public PR metadata.

Dependencies are stored in frontmatter by stable card ID:

```yaml
dependencies:
  - blocker_id: setup-auth-flow-a91
    created_at: 2026-06-01T10:00:00.000Z
```

For backward-compatible human authoring, Hive may also accept a simple `depends_on` string array on read. When reading legacy `depends_on`, Hive should synthesize `created_at` from the dependent card's `created_at`, falling back to file `mtime` or current time. When Hive writes dependencies, it should normalize to `dependencies` entries with `blocker_id` and `created_at`, because the backend contract returns `TicketDependency[]` and the existing `TicketDependency` type requires `created_at`.

Local-only integrations remain local. Session links, worktree links, personal notes, token totals, pending launch config, and selected state stay in Hive's local runtime state and are not written to markdown.

PR and external ticket metadata may be preserved in markdown when present or explicitly set, because those fields are public workflow metadata.

## Non-Ticket Kanban APIs

Not every existing Kanban API belongs in the ticket backend, but each must have mode-aware behavior.

- `simpleMode.toggle(projectId, enabled)` remains project-scoped database state. It is independent of storage mode and should work in both internal and markdown modes.
- `board.export(projectId, projectName)` must export the visible board from the selected backend. In markdown mode, it reads parsed markdown cards plus frontmatter dependencies and local runtime fields that belong in the existing Hive JSON shape, such as attachments and plan-ready state when applicable.
- `board.openImportFile()` can stay storage-neutral because it only opens and parses a Hive JSON file.
- `board.importTickets(projectId, tickets, dependencies)` must target the selected backend. In internal mode, it keeps the current SQLite behavior. In markdown mode, it creates or updates markdown card files in the configured folder layout, writes public fields to frontmatter/body, writes local-only fields such as attachments into `markdown_kanban_card_state`, and writes dependencies to `dependencies`.

Board import is a manual board write operation, not a mode-switching mechanism. It should not be invoked by `setMode`, silently switch storage modes, or migrate an existing board between modes.

## Error Handling

- Missing configured folder: offer to create it. If declined, show an empty/error board state.
- Folder outside project: allow it, with a warning that cards may not be versioned with the project.
- Invalid or missing markdown storage config: fall back to the default `docs/kanban` single-folder config only after persisting that default, or keep the board in an explicit configuration error state if persistence fails.
- Invalid frontmatter, invalid known fields, or unwritable file: keep the last valid card visible if available; otherwise show an invalid-card placeholder. Do not mutate the file as part of automatic repair.
- Missing `id`: auto-generate and write it back only when the frontmatter is parseable and the file is writable; otherwise treat it as a diagnostic-only invalid-card state.
- Duplicate `id`: show warning markers and block all actions on affected cards until resolved.
- File move failure during drag: revert optimistic UI and show an error.
- Populated-board mode switch: keep the original mode and explain that switching modes with existing cards is not supported yet.
- Partial write/watch race: ignore self-triggered watcher events briefly, then reload from disk.

## Testing

Automated tests should cover:

- frontmatter parse/serialize with unknown-field preservation.
- renderer-visible markdown diagnostics for invalid frontmatter, parse failures, duplicate IDs, placeholders, and action blocking.
- full `KanbanTicket` shape hydration from frontmatter, markdown body, derived values, and local runtime state.
- single-folder column changes.
- status-folder column changes and file moves.
- ID generation, missing ID repair, and duplicate-ID read-only blocking.
- backend routing based on project Kanban mode.
- on-demand markdown index loading for background `getBySession`, `syncPR`, `clearPR`, and worktree-detach workflows.
- renderer project-scoped card identity in modal selection, dependency mode, pinned boards, connection boards, drag payloads, and dependency line rendering.
- parity coverage for every existing Kanban ticket IPC path against the selected backend.
- markdown-mode local-only handling for session links, worktree links, token updates, and session lookups.
- markdown-mode handling for local attachments and plan-ready state.
- local runtime-state hydration, duplicate-ID blocking, and cleanup for missing or changed card IDs.
- markdown-mode PR attach, detach, sync, and clear semantics.
- persistent project storage-mode and markdown-folder configuration.
- mode-aware `simpleMode`, board export, board import, and import-file behavior.
- mode switching only when internal SQLite has no active or archived tickets and the current markdown backend, when active, has no card-like files.
- blocked mode switching when internal SQLite has archived-only tickets.
- blocked mode switching when the current markdown backend has archived-only cards.
- markdown target-folder adoption with default frontmatter repair.
- watcher reload behavior for create, update, delete, and rename.
- renderer store compatibility with both backends.
- dependency persistence through `dependencies` with `created_at`, plus read compatibility for simple `depends_on`.
- filesystem policy enforcement for canonical paths, duplicate/nested folders, symlink child directories, accepted extensions, file size limits, and watcher limits.

Manual verification should include:

- switching an empty board between modes.
- attempting to switch a populated or archived-only board and confirming no mode change occurs.
- switching a clean project to markdown when target folders already contain markdown files and confirming those files are adopted with default frontmatter where needed.
- editing a markdown card from an external editor or agent while the board is open.
- dragging a card in status-folder mode and confirming both frontmatter and file location update.
