import { dialog } from 'electron'
import { writeFile, readFile } from 'node:fs/promises'
import { Data, Effect } from 'effect'
import { z } from 'zod'

import { getDatabase } from '../db'
import { createLogger } from '../services/logger'
import type {
  KanbanTicketBatchCreate,
  KanbanTicketCreate,
  KanbanTicketUpdate,
  KanbanMarkdownConfig
} from '../db'
import {
  clearPRFromAllKanbanBackends,
  createConfiguredMarkdownFolders,
  getAllKanbanTicketsBySession,
  getDefaultMarkdownConfig,
  getKanbanBackendForProject,
  getKanbanStorageConfig,
  getMarkdownKanbanBackend,
  setKanbanStorageMode,
  syncPRToAllKanbanBackends,
  updateKanbanMarkdownConfig,
  detachWorktreeFromAllKanbanBackends
} from '../services/kanban-backend'
import {
  startMarkdownKanbanProjectWatch,
  stopMarkdownKanbanProjectWatch
} from '../services/markdown-kanban-watcher'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'KanbanHandlers' })

class KanbanHandlerFailed extends Data.TaggedError('KanbanHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const kanbanFailed = (operation: string, cause: unknown): KanbanHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new KanbanHandlerFailed({ operation, reason, message: reason })
}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))

const tryKanban = <A>(operation: string, fn: () => A): Effect.Effect<A, KanbanHandlerFailed> =>
  Effect.try({
    try: fn,
    catch: (error) => {
      log.error(`${operation} failed`, toError(error))
      return kanbanFailed(operation, error)
    }
  })

const tryKanbanPromise = <A>(
  operation: string,
  fn: () => Promise<A>
): Effect.Effect<A, KanbanHandlerFailed> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) => {
      log.error(`${operation} failed`, toError(error))
      return kanbanFailed(operation, error)
    }
  })

const stringArgSchema = z.string()
const stringPairSchema = z.tuple([z.string(), z.string()])
const projectTicketPairSchema = z.tuple([z.string(), z.string()])
const ticketColumnSchema = z.enum(['todo', 'in_progress', 'review', 'done'])
const sessionModeSchema = z.enum(['build', 'plan', 'super-plan'])
const ticketMarkSchema = z.enum(['common', 'rare', 'epic', 'legendary'])
const kanbanStorageModeSchema = z.enum(['internal', 'markdown'])
const nonEmptyString = (field: string): z.ZodType<string> =>
  z.string().refine((value) => value.trim().length > 0, {
    message: `${field} must be a non-empty string`
  })
const kanbanMarkdownConfigSchema = z.discriminatedUnion('layout', [
  z.object({
    layout: z.literal('single-folder'),
    singleFolder: z.string().min(1),
    statusFolders: z
      .object({
        todo: z.string(),
        in_progress: z.string(),
        done: z.string()
      })
      .optional()
  }),
  z.object({
    layout: z.literal('status-folders'),
    singleFolder: z.string().optional(),
    statusFolders: z.object({
      todo: z.string().min(1),
      in_progress: z.string().min(1),
      done: z.string().min(1)
    })
  })
]) satisfies z.ZodType<KanbanMarkdownConfig>
const createFoldersSchema = z.union([
  z.string(),
  z.tuple([z.string(), kanbanMarkdownConfigSchema.optional()])
])

const kanbanTicketCreateSchema = z.object({
  id: nonEmptyString('id').optional(),
  project_id: z.string(),
  title: nonEmptyString('title'),
  description: z.string().nullable().optional(),
  attachments: z.array(z.unknown()).optional(),
  column: ticketColumnSchema.optional(),
  sort_order: z.number().optional(),
  current_session_id: z.string().nullable().optional(),
  worktree_id: z.string().nullable().optional(),
  mode: sessionModeSchema.nullable().optional(),
  plan_ready: z.boolean().optional(),
  external_provider: z.string().nullable().optional(),
  external_id: z.string().nullable().optional(),
  external_url: z.string().nullable().optional(),
  github_pr_number: z.number().nullable().optional(),
  github_pr_url: z.string().nullable().optional(),
  mark: ticketMarkSchema.nullable().optional()
}) satisfies z.ZodType<KanbanTicketCreate>

const kanbanTicketUpdateSchema = z.object({
  title: nonEmptyString('title').optional(),
  description: z.string().nullable().optional(),
  attachments: z.array(z.unknown()).optional(),
  column: ticketColumnSchema.optional(),
  sort_order: z.number().optional(),
  current_session_id: z.string().nullable().optional(),
  worktree_id: z.string().nullable().optional(),
  mode: sessionModeSchema.nullable().optional(),
  plan_ready: z.boolean().optional(),
  github_pr_number: z.number().nullable().optional(),
  github_pr_url: z.string().nullable().optional(),
  mark: ticketMarkSchema.nullable().optional(),
  archived_at: z.string().nullable().optional(),
  pending_launch_config: z.string().nullable().optional(),
  goal_mode: z.boolean().optional(),
  goal_success_criteria: z.string().nullable().optional(),
  note: z.string().nullable().optional()
}) satisfies z.ZodType<KanbanTicketUpdate>

const kanbanTicketBatchCreateItemSchema = kanbanTicketCreateSchema
  .extend({
    draft_key: nonEmptyString('draft_key'),
    project_id: z.string(),
    title: nonEmptyString('title'),
    depends_on: z.array(nonEmptyString('depends_on')).optional()
  })
  .omit({ id: true })

const kanbanTicketBatchCreateSchema = z.object({
  drafts: z.array(kanbanTicketBatchCreateItemSchema)
}) satisfies z.ZodType<KanbanTicketBatchCreate>

const importTicketSchema = z.object({
  id: nonEmptyString('id'),
  title: nonEmptyString('title'),
  description: z.string().nullable().optional(),
  attachments: z.array(z.unknown()).nullable().optional(),
  column: z.string().optional()
})

const importDependencySchema = z.object({
  dependentId: nonEmptyString('dependentId'),
  blockerId: nonEmptyString('blockerId')
})

type ImportTicket = z.infer<typeof importTicketSchema>
type ImportDependency = z.infer<typeof importDependencySchema>

export function registerKanbanHandlers(): void {
  log.info('Registering kanban handlers')

  defineHandler('kanban:ticket:create', z.tuple([z.string(), kanbanTicketCreateSchema]), ([projectId, data]) =>
    tryKanbanPromise('kanban:ticket:create', () =>
      getKanbanBackendForProject(projectId).create(projectId, data)
    )
  )

  defineHandler('kanban:ticket:createBatch', z.tuple([z.string(), kanbanTicketBatchCreateSchema]), ([projectId, data]) =>
    tryKanbanPromise('kanban:ticket:createBatch', () =>
      getKanbanBackendForProject(projectId).createBatch(projectId, data)
    )
  )

  defineHandler('kanban:ticket:get', projectTicketPairSchema, ([projectId, id]) =>
    tryKanbanPromise('kanban:ticket:get', () =>
      getKanbanBackendForProject(projectId).get(projectId, id)
    )
  )

  defineHandler(
    'kanban:ticket:getByProject',
    z.tuple([z.string(), z.boolean().optional()]),
    ([projectId, includeArchived]) =>
      tryKanbanPromise('kanban:ticket:getByProject', () =>
        getKanbanBackendForProject(projectId).list(projectId, includeArchived ?? false)
      )
  )

  defineHandler(
    'kanban:ticket:update',
    z.tuple([z.string(), z.string(), kanbanTicketUpdateSchema]),
    ([projectId, id, data]) =>
      tryKanbanPromise('kanban:ticket:update', () =>
        getKanbanBackendForProject(projectId).update(projectId, id, data)
      )
  )

  defineHandler('kanban:ticket:delete', projectTicketPairSchema, ([projectId, id]) =>
    tryKanbanPromise('kanban:ticket:delete', () =>
      getKanbanBackendForProject(projectId).delete(projectId, id)
    )
  )

  defineHandler('kanban:ticket:archive', projectTicketPairSchema, ([projectId, id]) =>
    tryKanbanPromise('kanban:ticket:archive', () =>
      getKanbanBackendForProject(projectId).archive(projectId, id)
    )
  )

  defineHandler('kanban:ticket:archiveAllDone', stringArgSchema, (projectId) =>
    tryKanbanPromise('kanban:ticket:archiveAllDone', () =>
      getKanbanBackendForProject(projectId).archiveAllDone(projectId)
    )
  )

  defineHandler('kanban:ticket:unarchive', projectTicketPairSchema, ([projectId, id]) =>
    tryKanbanPromise('kanban:ticket:unarchive', () =>
      getKanbanBackendForProject(projectId).unarchive(projectId, id)
    )
  )

  defineHandler(
    'kanban:ticket:move',
    z.tuple([z.string(), z.string(), ticketColumnSchema, z.number()]),
    ([projectId, id, column, sortOrder]) =>
      tryKanbanPromise('kanban:ticket:move', () =>
        getKanbanBackendForProject(projectId).move(projectId, id, column, sortOrder)
      )
  )

  defineHandler('kanban:ticket:reorder', z.tuple([z.string(), z.string(), z.number()]), ([projectId, id, sortOrder]) =>
    tryKanbanPromise('kanban:ticket:reorder', () =>
      getKanbanBackendForProject(projectId).reorder(projectId, id, sortOrder)
    )
  )

  defineHandler('kanban:ticket:getBySession', stringArgSchema, (sessionId) =>
    tryKanbanPromise('kanban:ticket:getBySession', () =>
      getAllKanbanTicketsBySession(sessionId)
    )
  )

  defineHandler('kanban:ticket:addTokens', z.tuple([z.string(), z.string(), z.number()]), ([projectId, id, tokens]) =>
    tryKanbanPromise('kanban:ticket:addTokens', () =>
      getKanbanBackendForProject(projectId).addTokens(projectId, id, tokens)
    )
  )

  defineHandler(
    'kanban:ticket:syncPR',
    z.tuple([z.string(), z.number(), z.string()]),
    ([worktreeId, prNumber, prUrl]) =>
      tryKanbanPromise('kanban:ticket:syncPR', () =>
        syncPRToAllKanbanBackends(worktreeId, prNumber, prUrl)
      )
  )

  defineHandler('kanban:ticket:clearPR', stringArgSchema, (worktreeId) =>
    tryKanbanPromise('kanban:ticket:clearPR', () => clearPRFromAllKanbanBackends(worktreeId))
  )

  defineHandler(
    'kanban:ticket:attachPR',
    z.tuple([z.string(), z.string(), z.number(), z.string()]),
    ([projectId, ticketId, prNumber, prUrl]) =>
      tryKanbanPromise('kanban:ticket:attachPR', () =>
        getKanbanBackendForProject(projectId).attachPR(projectId, ticketId, prNumber, prUrl)
      )
  )

  defineHandler('kanban:ticket:detachPR', stringPairSchema, ([projectId, ticketId]) =>
    tryKanbanPromise('kanban:ticket:detachPR', () =>
      getKanbanBackendForProject(projectId).detachPR(projectId, ticketId)
    )
  )

  defineHandler('kanban:ticket:detachWorktree', stringArgSchema, (worktreeId) =>
    tryKanbanPromise('kanban:ticket:detachWorktree', () => detachWorktreeFromAllKanbanBackends(worktreeId))
  )

  defineHandler(
    'kanban:simpleMode:toggle',
    z.tuple([z.string(), z.boolean()]),
    ([projectId, enabled]) =>
      tryKanban('kanban:simpleMode:toggle', () =>
        getDatabase().updateProjectSimpleMode(projectId, enabled)
      )
  )

  // Dependency handlers
  defineHandler('kanban:dependency:add', z.tuple([z.string(), z.string(), z.string()]), ([projectId, dependentId, blockerId]) =>
    tryKanbanPromise('kanban:dependency:add', () =>
      getKanbanBackendForProject(projectId).addDependency(projectId, dependentId, blockerId)
    )
  )

  defineHandler('kanban:dependency:remove', z.tuple([z.string(), z.string(), z.string()]), ([projectId, dependentId, blockerId]) =>
    tryKanbanPromise('kanban:dependency:remove', () =>
      getKanbanBackendForProject(projectId).removeDependency(projectId, dependentId, blockerId)
    )
  )

  defineHandler('kanban:dependency:getBlockers', projectTicketPairSchema, ([projectId, ticketId]) =>
    tryKanbanPromise('kanban:dependency:getBlockers', () =>
      getKanbanBackendForProject(projectId).getBlockers(projectId, ticketId)
    )
  )

  defineHandler('kanban:dependency:getDependents', projectTicketPairSchema, ([projectId, ticketId]) =>
    tryKanbanPromise('kanban:dependency:getDependents', () =>
      getKanbanBackendForProject(projectId).getDependents(projectId, ticketId)
    )
  )

  defineHandler('kanban:dependency:getForProject', stringArgSchema, (projectId) =>
    tryKanbanPromise('kanban:dependency:getForProject', () =>
      getKanbanBackendForProject(projectId).getDependenciesForProject(projectId)
    )
  )

  defineHandler('kanban:dependency:removeAll', projectTicketPairSchema, ([projectId, ticketId]) =>
    tryKanbanPromise('kanban:dependency:removeAll', () =>
      getKanbanBackendForProject(projectId).removeAllDependencies(projectId, ticketId)
    )
  )

  defineHandler(
    'kanban:board:export',
    z.tuple([z.string(), z.string()]),
    ([projectId, projectName]) =>
      Effect.gen(function* () {
        const { exportData, ticketCount } = yield* tryKanbanPromise('kanban:board:export:read', async () => {
          const { tickets, dependencies } = await getKanbanBackendForProject(projectId).exportBoard(projectId)

          return {
            ticketCount: tickets.length,
            exportData: {
              projectName,
              exportedAt: new Date().toISOString(),
              tickets: tickets.map((ticket) => ({
                id: ticket.id,
                title: ticket.title,
                description: ticket.description,
                attachments: ticket.attachments,
                column: ticket.column
              })),
              dependencies: dependencies.map((dependency) => ({
                dependentId: dependency.dependent_id,
                blockerId: dependency.blocker_id
              }))
            }
          }
        })

        const { canceled, filePath } = yield* tryKanbanPromise('kanban:board:export:dialog', () =>
          dialog.showSaveDialog({
            defaultPath: `board-${projectName}.hive.json`,
            filters: [{ name: 'Hive Board', extensions: ['hive.json'] }]
          })
        )

        if (canceled || !filePath) {
          return { success: false, ticketCount: 0 }
        }

        yield* tryKanbanPromise('kanban:board:export:write', () =>
          writeFile(filePath, JSON.stringify(exportData, null, 2), 'utf-8')
        )

        return { success: true, ticketCount, path: filePath }
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({ success: false, ticketCount: 0, error: error.reason })
        )
      )
  )

  defineHandler('kanban:board:openImportFile', z.tuple([]), () =>
    Effect.gen(function* () {
      const { canceled, filePaths } = yield* tryKanbanPromise(
        'kanban:board:openImportFile:dialog',
        () =>
          dialog.showOpenDialog({
            filters: [{ name: 'Hive Board', extensions: ['json'] }],
            properties: ['openFile']
          })
      )

      if (canceled || filePaths.length === 0) {
        return null
      }

      const raw = yield* tryKanbanPromise('kanban:board:openImportFile:read', () =>
        readFile(filePaths[0], 'utf-8')
      )

      return yield* tryKanban('kanban:board:openImportFile:parse', () => {
        const parsed = JSON.parse(raw)

        if (
          !parsed ||
          !Array.isArray(parsed.tickets) ||
          !parsed.tickets.every(
            (ticket: unknown) =>
              typeof ticket === 'object' && ticket !== null && 'id' in ticket && 'title' in ticket
          )
        ) {
          throw new Error('Invalid Hive board file: missing tickets array or tickets lack id/title')
        }

        return {
          tickets: parsed.tickets as ImportTicket[],
          dependencies: Array.isArray(parsed.dependencies)
            ? parsed.dependencies.filter(
                (dependency: unknown): dependency is ImportDependency =>
                  typeof dependency === 'object' &&
                  dependency !== null &&
                  typeof (dependency as { dependentId?: unknown }).dependentId === 'string' &&
                  typeof (dependency as { blockerId?: unknown }).blockerId === 'string'
              )
            : [],
          projectName: parsed.projectName ?? null
        }
      })
    }).pipe(Effect.catchAll(() => Effect.succeed(null)))
  )

  defineHandler(
    'kanban:board:importTickets',
    z.tuple([z.string(), z.array(importTicketSchema), z.array(importDependencySchema).optional()]),
    ([projectId, tickets, dependencies]) =>
      tryKanbanPromise('kanban:board:importTickets', () =>
        getKanbanBackendForProject(projectId).importTickets(projectId, tickets, dependencies)
      )
  )

  defineHandler('kanban:config:get', stringArgSchema, (projectId) =>
    tryKanban('kanban:config:get', () => getKanbanStorageConfig(projectId))
  )

  defineHandler(
    'kanban:config:update',
    z.tuple([z.string(), kanbanMarkdownConfigSchema]),
    ([projectId, config]) =>
      tryKanbanPromise('kanban:config:update', () => updateKanbanMarkdownConfig(projectId, config))
  )

  defineHandler(
    'kanban:config:setMode',
    z.tuple([z.string(), kanbanStorageModeSchema]),
    ([projectId, mode]) =>
      tryKanbanPromise('kanban:config:setMode', () => setKanbanStorageMode(projectId, mode))
  )

  defineHandler(
    'kanban:config:createFolders',
    createFoldersSchema,
    (input) =>
      tryKanbanPromise('kanban:config:createFolders', async () => {
        const [projectId, config] = typeof input === 'string' ? [input, undefined] : input
        await createConfiguredMarkdownFolders(projectId, config)
        return getKanbanStorageConfig(projectId)
      })
  )

  defineHandler('kanban:config:defaultMarkdown', z.tuple([]), () =>
    tryKanban('kanban:config:defaultMarkdown', () => getDefaultMarkdownConfig())
  )

  defineHandler('kanban:diagnostics:get', stringArgSchema, (projectId) =>
    tryKanbanPromise('kanban:diagnostics:get', () => getMarkdownKanbanBackend().getDiagnostics(projectId))
  )

  defineHandler('kanban:watch:start', stringArgSchema, (projectId) =>
    tryKanbanPromise('kanban:watch:start', () => startMarkdownKanbanProjectWatch(projectId))
  )

  defineHandler('kanban:watch:stop', stringArgSchema, (projectId) =>
    tryKanbanPromise('kanban:watch:stop', () => stopMarkdownKanbanProjectWatch(projectId))
  )
}
