# Markdown Kanban Folder Picker

**Date:** 2026-06-01
**Status:** Approved for implementation planning
**Feature:** Native folder picker buttons for Markdown Kanban card folders

## Overview

Project Settings currently lets users configure Markdown Kanban card folders only by typing paths into text inputs. That is flexible, but awkward when users want to select an existing folder. Add a compact native folder picker button beside each Markdown Kanban folder input while preserving direct text editing.

The picker should improve setup without changing the Markdown Kanban storage model, folder validation, missing-folder recovery, or save flow from the main Markdown Kanban mode design.

## Goals

- Let users select existing Markdown Kanban card folders through a native directory picker.
- Preserve editable text inputs for fast relative-path edits, copy/paste, and advanced external paths.
- Store folders inside the project as project-relative paths.
- Store folders outside the project as absolute paths.
- Keep the current one-folder and status-folders configuration model.

## Non-Goals

- Replacing path text inputs with picker-only fields.
- Adding a base-folder shortcut that auto-populates `todo`, `in-progress`, and `done`.
- Changing folder validation, creation, layout migration, or watcher behavior.
- Changing how Markdown Kanban card files are parsed, written, or moved.

## UX Design

Use the existing Project Settings Kanban Storage section. When Markdown mode is selected:

- Single-folder layout shows the current folder input plus a compact folder icon button on the right.
- Status-folder layout shows the current To Do, In Progress / Review, and Done inputs, each with its own folder icon button.
- The icon button opens a native directory picker.
- Cancelling the picker leaves the current input unchanged.
- Picker errors show a toast and leave the current input unchanged.

The text input remains the source of truth for the draft config. The picker only writes a selected path into the corresponding input state.

## Path Handling

When a directory is selected, normalize the value before placing it in the input:

- If the selected directory is equal to or inside `project.path`, store a relative path from `project.path`.
- If the selected directory is outside `project.path`, store the absolute selected path.
- Use forward slashes in the stored text to match the current UI and backend expectations.
- Do not modify any other folder field when one picker completes.

Examples:

- Project path `/Users/me/app`, selected `/Users/me/app/docs/kanban` stores `docs/kanban`.
- Project path `/Users/me/app`, selected `/Users/me/app` stores `.`.
- Project path `/Users/me/app`, selected `/Users/me/shared/cards` stores `/Users/me/shared/cards`.

## Architecture

The renderer change belongs in `ProjectSettingsDialog`.

Add a small helper that converts a selected absolute path into the input value for the active project. The helper should be pure and independently testable.

```ts
function formatSelectedKanbanFolder(projectPath: string, selectedPath: string): string
```

Add a folder-picker handler that receives the target field setter:

```ts
async function handlePickKanbanFolder(setFolder: (value: string) => void): Promise<void>
```

The handler should call a folder-selection IPC exposed on `window.projectOps` or a Kanban-specific equivalent if the existing project picker remains too project-branded. The native dialog title/button label should communicate folder selection for Kanban cards, not adding a project.

No backend storage API changes are required. Saving still uses `window.kanban.config.update`, `setMode`, and the existing create-folders recovery flow.

## Error Handling

- User cancellation is not an error and should not show a toast.
- IPC or dialog failures show a concise toast such as `Failed to choose Kanban folder`.
- Invalid path combinations are still reported by the existing save-time Kanban config validation.
- Missing selected folders are not expected from the native picker, but manually typed missing folders keep the existing create-and-retry behavior.

## Testing

Add focused tests in `ProjectSettingsDialog.test.tsx`:

- Single-folder picker stores an inside-project selection as a relative path.
- Single-folder picker stores an outside-project selection as an absolute path.
- Cancelling the picker leaves the current input unchanged.
- Picker failure leaves the current input unchanged and reports a toast error.
- Status-folder layout exposes one picker for each status folder and updates only the selected field.
- Saving after picker use sends the normalized paths through the existing Kanban config API.

If the IPC surface changes, update preload declaration tests to cover the new method shape.
