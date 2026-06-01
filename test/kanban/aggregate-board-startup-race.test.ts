import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { KanbanTicket } from '../../src/main/db/types'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { setKanbanDragData, ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

const mockKanban = {
  ticket: {
    getByProject: vi.fn(),
    getBySession: vi.fn(),
    update: vi.fn()
  },
  dependency: {
    getForProject: vi.fn()
  },
  diagnostics: {
    get: vi.fn()
  }
}

const mockConnectionOps = {
  getAll: vi.fn(),
  getPinned: vi.fn()
}

const mockDb = {
  worktree: {
    getPinned: vi.fn()
  }
}

Object.defineProperty(window, 'kanban', {
  writable: true,
  configurable: true,
  value: mockKanban
})

Object.defineProperty(window, 'connectionOps', {
  writable: true,
  configurable: true,
  value: mockConnectionOps
})

Object.defineProperty(window, 'db', {
  writable: true,
  configurable: true,
  value: mockDb
})

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Startup ticket',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-05-05T00:00:00.000Z',
    updated_at: '2026-05-05T00:00:00.000Z',
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    note: null,
    ...overrides
  }
}

const connection = {
  id: 'conn-1',
  name: 'Connection One',
  custom_name: null,
  status: 'active',
  path: '/tmp/conn-1',
  color: null,
  created_at: '2026-05-05T00:00:00.000Z',
  updated_at: '2026-05-05T00:00:00.000Z',
  members: [
    {
      id: 'member-1',
      connection_id: 'conn-1',
      worktree_id: 'wt-1',
      project_id: 'proj-1',
      symlink_name: 'wt-1',
      added_at: '2026-05-05T00:00:00.000Z',
      worktree_name: 'Worktree One',
      worktree_branch: 'main',
      worktree_path: '/tmp/proj-1/wt-1',
      project_name: 'Project One'
    }
  ]
}

const pinnedWorktree = {
  id: 'wt-1',
  project_id: 'proj-1',
  name: 'Worktree One',
  branch_name: 'main',
  path: '/tmp/proj-1/wt-1',
  status: 'active',
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  created_at: '2026-05-05T00:00:00.000Z',
  last_accessed_at: '2026-05-05T00:00:00.000Z',
  github_pr_number: null,
  github_pr_url: null
}

describe('aggregate kanban board startup hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useKanbanStore.setState({
      tickets: new Map(),
      isLoading: false,
      isDragging: false,
      draggingTicketKey: null,
      showArchivedByProject: {},
      markdownDiagnostics: new Map(),
      markdownPlaceholders: new Map(),
      dependencyMap: new Map()
    })
    useConnectionStore.setState({
      connections: [],
      isLoading: false,
      error: null,
      selectedConnectionId: null,
      loaded: false
    } as never)
    usePinnedStore.setState({
      loaded: false,
      pinnedWorktreeIds: new Set(),
      pinnedConnectionIds: new Set(),
      pinnedProjectIds: new Set()
    })
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj-1', [pinnedWorktree]]])
    } as never)

    mockKanban.ticket.getByProject.mockResolvedValue([makeTicket()])
    mockKanban.ticket.getBySession.mockResolvedValue([])
    mockKanban.ticket.update.mockResolvedValue(null)
    mockKanban.dependency.getForProject.mockResolvedValue([])
    mockKanban.diagnostics.get.mockResolvedValue([])
    mockConnectionOps.getAll.mockResolvedValue({ success: true, connections: [connection] })
    mockConnectionOps.getPinned.mockResolvedValue([])
    mockDb.worktree.getPinned.mockResolvedValue([pinnedWorktree])
  })

  test('loadTicketsForConnection hydrates connections and retries when called before connections load', async () => {
    await useKanbanStore.getState().loadTicketsForConnection('conn-1')

    expect(mockConnectionOps.getAll).toHaveBeenCalledTimes(1)
    expect(mockKanban.ticket.getByProject).toHaveBeenCalledWith('proj-1', false)
    expect(useKanbanStore.getState().tickets.get('proj-1')).toEqual([makeTicket()])
  })

  test('loadTicketsForPinnedProjects hydrates pinned state and retries when called before pinned projects load', async () => {
    await useKanbanStore.getState().loadTicketsForPinnedProjects()

    expect(mockDb.worktree.getPinned).toHaveBeenCalledTimes(1)
    expect(mockKanban.ticket.getByProject).toHaveBeenCalledWith('proj-1', false)
    expect(useKanbanStore.getState().tickets.get('proj-1')).toEqual([makeTicket()])
  })

  test('aggregate project reload uses the global archived fallback and updates only the changed project', async () => {
    const existingOtherProjectTicket = makeTicket({ id: 'other-ticket', project_id: 'proj-2' })
    useKanbanStore.setState({
      tickets: new Map([['proj-2', [existingOtherProjectTicket]]]),
      showArchivedByProject: { '': true }
    })
    const archivedTicket = makeTicket({
      id: 'archived-ticket',
      archived_at: '2026-05-06T00:00:00.000Z'
    })
    mockKanban.ticket.getByProject.mockResolvedValueOnce([archivedTicket])

    await useKanbanStore.getState().loadTicketsForProjectInAggregate('proj-1')

    expect(mockKanban.ticket.getByProject).toHaveBeenCalledWith('proj-1', true)
    expect(useKanbanStore.getState().tickets.get('proj-1')).toEqual([archivedTicket])
    expect(useKanbanStore.getState().tickets.get('proj-2')).toEqual([existingOtherProjectTicket])
  })

  test('loadTickets exposes invalid markdown diagnostics as project placeholders', async () => {
    mockKanban.diagnostics.get.mockResolvedValueOnce([
      {
        projectId: 'proj-1',
        ticketId: null,
        filePath: '/tmp/proj-1/docs/kanban/broken.md',
        kind: 'parse_error',
        message: 'YAML parse failed',
        blocking: true
      }
    ])

    await useKanbanStore.getState().loadTickets('proj-1')

    expect(useKanbanStore.getState().getInvalidPlaceholdersForProject('proj-1')).toEqual([
      {
        projectId: 'proj-1',
        filePath: '/tmp/proj-1/docs/kanban/broken.md',
        kind: 'parse_error',
        message: 'YAML parse failed',
        blocking: true
      }
    ])
  })

  test('dependencies are keyed by project and ticket to avoid aggregate board collisions', async () => {
    mockKanban.dependency.getForProject
      .mockResolvedValueOnce([{ dependent_id: 'shared', blocker_id: 'block-a', created_at: '2026-05-05T00:00:00.000Z' }])
      .mockResolvedValueOnce([{ dependent_id: 'shared', blocker_id: 'block-b', created_at: '2026-05-05T00:00:00.000Z' }])

    await useKanbanStore.getState().loadDependencies('proj-1')
    await useKanbanStore.getState().loadDependencies('proj-2')

    const dependencyMap = useKanbanStore.getState().dependencyMap
    expect(dependencyMap.get(ticketKey('proj-1', 'shared'))).toEqual(new Set([ticketKey('proj-1', 'block-a')]))
    expect(dependencyMap.get(ticketKey('proj-2', 'shared'))).toEqual(new Set([ticketKey('proj-2', 'block-b')]))
  })

  test('drag state is keyed by project and ticket to avoid aggregate board collisions', () => {
    const requestAnimationFrameSpy = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    const cancelAnimationFrameSpy = vi
      .spyOn(globalThis, 'cancelAnimationFrame')
      .mockImplementation(() => undefined)

    setKanbanDragData({
      projectId: 'proj-1',
      ticketId: 'shared',
      sourceColumn: 'todo',
      sourceIndex: 0
    })

    expect(useKanbanStore.getState().draggingTicketKey).toBe(ticketKey('proj-1', 'shared'))
    expect(useKanbanStore.getState().draggingTicketKey).not.toBe(ticketKey('proj-2', 'shared'))

    setKanbanDragData(null)
    expect(useKanbanStore.getState().draggingTicketKey).toBeNull()

    requestAnimationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
  })

  test('handoff relinking patches renderer tickets by project and ticket key', async () => {
    const linkedTicket = makeTicket({
      id: 'shared',
      project_id: 'proj-1',
      current_session_id: 'old-session',
      worktree_id: 'wt-1',
      mode: 'plan',
      goal_success_criteria: 'Ship it'
    })
    const unrelatedSameIdTicket = makeTicket({
      id: 'shared',
      project_id: 'proj-2',
      current_session_id: 'other-session',
      worktree_id: 'wt-2',
      mode: 'plan',
      goal_success_criteria: 'Leave alone'
    })

    useKanbanStore.setState({
      tickets: new Map([
        ['proj-1', [linkedTicket]],
        ['proj-2', [unrelatedSameIdTicket]]
      ]),
      boardTelegramTarget: {
        projectId: 'proj-1',
        ticketId: 'shared',
        worktreeId: 'wt-1',
        sessionId: 'old-session'
      }
    })
    mockKanban.ticket.getBySession.mockResolvedValueOnce([linkedTicket])

    await useKanbanStore.getState().relinkTicketsForHandoff('old-session', 'new-session', true)

    const projectOneTicket = useKanbanStore.getState().tickets.get('proj-1')?.[0]
    const projectTwoTicket = useKanbanStore.getState().tickets.get('proj-2')?.[0]

    expect(projectOneTicket).toMatchObject({
      id: 'shared',
      project_id: 'proj-1',
      current_session_id: 'new-session',
      mode: 'build',
      goal_mode: true,
      goal_success_criteria: 'Ship it'
    })
    expect(projectTwoTicket).toMatchObject({
      id: 'shared',
      project_id: 'proj-2',
      current_session_id: 'other-session',
      mode: 'plan',
      goal_mode: false,
      goal_success_criteria: 'Leave alone'
    })
    expect(useKanbanStore.getState().boardTelegramTarget).toMatchObject({
      projectId: 'proj-1',
      ticketId: 'shared',
      sessionId: 'new-session'
    })
  })
})
