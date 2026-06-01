import { beforeEach, describe, expect, test, vi } from 'vitest'

const { handlers, backend } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const backend = {
    create: vi.fn(),
    createBatch: vi.fn(),
    update: vi.fn(),
    importTickets: vi.fn()
  }
  return { handlers, backend }
})

vi.mock('electron', () => ({
  dialog: {},
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../src/main/db', () => ({
  getDatabase: () => ({})
}))

vi.mock('../../src/main/services/markdown-kanban-watcher', () => ({
  startMarkdownKanbanProjectWatch: vi.fn(),
  stopMarkdownKanbanProjectWatch: vi.fn()
}))

vi.mock('../../src/main/services/kanban-backend', () => ({
  clearPRFromAllKanbanBackends: vi.fn(),
  createConfiguredMarkdownFolders: vi.fn(),
  detachWorktreeFromAllKanbanBackends: vi.fn(),
  getAllKanbanTicketsBySession: vi.fn(),
  getDefaultMarkdownConfig: vi.fn(),
  getKanbanBackendForProject: vi.fn(() => backend),
  getKanbanStorageConfig: vi.fn(),
  getMarkdownKanbanBackend: vi.fn(() => ({ getDiagnostics: vi.fn() })),
  setKanbanStorageMode: vi.fn(),
  syncPRToAllKanbanBackends: vi.fn(),
  updateKanbanMarkdownConfig: vi.fn()
}))

import { __resetRuntimeRegistryForTests } from '../../src/main/effect/_shared/runtime'
import { registerKanbanHandlers } from '../../src/main/ipc/kanban-handlers'

const mockEvent = {}

describe('kanban IPC validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    __resetRuntimeRegistryForTests()
    registerKanbanHandlers()
  })

  test.each([
    [
      'create rejects blank optional id',
      'kanban:ticket:create',
      [
        'project-1',
        {
          id: '   ',
          project_id: 'project-1',
          title: 'Ticket'
        }
      ],
      backend.create,
      /id must be a non-empty string/i
    ],
    [
      'create rejects blank title',
      'kanban:ticket:create',
      [
        'project-1',
        {
          project_id: 'project-1',
          title: '   '
        }
      ],
      backend.create,
      /title must be a non-empty string/i
    ],
    [
      'batch create rejects blank dependency key',
      'kanban:ticket:createBatch',
      [
        'project-1',
        {
          drafts: [
            {
              draft_key: 'draft',
              project_id: 'project-1',
              title: 'Ticket',
              depends_on: ['   ']
            }
          ]
        }
      ],
      backend.createBatch,
      /depends_on must be a non-empty string/i
    ],
    [
      'update rejects blank title',
      'kanban:ticket:update',
      [
        'project-1',
        'ticket-1',
        {
          title: '   '
        }
      ],
      backend.update,
      /title must be a non-empty string/i
    ],
    [
      'import rejects blank ticket id',
      'kanban:board:importTickets',
      [
        'project-1',
        [
          {
            id: '   ',
            title: 'Ticket'
          }
        ]
      ],
      backend.importTickets,
      /id must be a non-empty string/i
    ],
    [
      'import rejects blank ticket title',
      'kanban:board:importTickets',
      [
        'project-1',
        [
          {
            id: 'ticket-1',
            title: '   '
          }
        ]
      ],
      backend.importTickets,
      /title must be a non-empty string/i
    ],
    [
      'import rejects blank dependency id',
      'kanban:board:importTickets',
      [
        'project-1',
        [
          {
            id: 'ticket-1',
            title: 'Ticket'
          }
        ],
        [
          {
            dependentId: 'ticket-1',
            blockerId: '   '
          }
        ]
      ],
      backend.importTickets,
      /blockerId must be a non-empty string/i
    ]
  ] as Array<[string, string, unknown[], ReturnType<typeof vi.fn>, RegExp]>)(
    '%s',
    async (_name, channel, args, backendCall, errorPattern) => {
      const result = await handlers.get(channel)!(mockEvent, ...args) as {
        success: boolean
        errorCode?: string
        error?: string
      }

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('ZodDecodeError')
      expect(result.error).toMatch(errorPattern)
      expect(backendCall).not.toHaveBeenCalled()
    }
  )
})
