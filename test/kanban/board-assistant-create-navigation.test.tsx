import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BoardAssistantView } from '../../src/renderer/src/components/kanban/BoardAssistantView'
import {
  useBoardChatStore,
  type TicketDraft
} from '../../src/renderer/src/stores/useBoardChatStore'
import { useProjectStore } from '../../src/renderer/src/stores/useProjectStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'
import { useKanbanStore } from '../../src/renderer/src/stores/useKanbanStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'
import { useSessionStore, BOARD_TAB_ID } from '../../src/renderer/src/stores/useSessionStore'

vi.mock('../../src/renderer/src/hooks/useSessionStream', () => ({
  useSessionStream: () => ({
    messages: [],
    streamingParts: [],
    streamingContent: '',
    isStreaming: false,
    isLoading: false
  })
}))

vi.mock('../../src/renderer/src/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

const projectId = 'proj-1'
const secondProjectId = 'proj-2'
const assistantMessageId = 'assistant-msg-1'

const boardDraft: TicketDraft = {
  id: `${assistantMessageId}:draft-1:${projectId}`,
  draftKey: 'draft-1',
  title: 'Create persistence ticket',
  description: 'Persist the board assistant state',
  dependsOn: [],
  resolvedDependsOnTitles: [],
  warnings: [],
  validationIssues: [],
  projectId,
  projectName: 'Project One',
  selected: true,
  createdAt: null
}

const secondProjectDraft: TicketDraft = {
  id: `${assistantMessageId}:draft-2:${secondProjectId}`,
  draftKey: 'draft-2',
  title: 'Create connection ticket',
  description: 'Track the second project work',
  dependsOn: ['draft-1'],
  resolvedDependsOnTitles: ['Create persistence ticket'],
  warnings: [],
  validationIssues: [],
  projectId: secondProjectId,
  projectName: 'Project Two',
  selected: true,
  createdAt: null
}

function seedStores(
  boardMode: 'sticky-tab' | 'toggle',
  seededDrafts: TicketDraft[] = [boardDraft]
) {
  useBoardChatStore.setState(useBoardChatStore.getInitialState())

  useProjectStore.setState({
    selectedProjectId: projectId,
    projects: [
      {
        id: projectId,
        name: 'Project One',
        path: '/tmp/proj-1',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        sort_order: 0,
        created_at: '2026-04-15T00:00:00.000Z',
        last_accessed_at: '2026-04-15T00:00:00.000Z'
      },
      {
        id: secondProjectId,
        name: 'Project Two',
        path: '/tmp/proj-2',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        detected_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        sort_order: 1,
        created_at: '2026-04-15T00:00:00.000Z',
        last_accessed_at: '2026-04-15T00:00:00.000Z'
      }
    ]
  })

  useWorktreeStore.setState({
    selectedWorktreeId: 'wt-1',
    worktreesByProject: new Map([
      [
        projectId,
        [
          {
            id: 'wt-1',
            project_id: projectId,
            name: 'main',
            branch_name: 'main',
            path: '/tmp/proj-1',
            status: 'active',
            is_default: true,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: '[]',
            last_model_provider_id: null,
            last_model_id: null,
            last_model_variant: null,
            created_at: '2026-04-15T00:00:00.000Z',
            last_accessed_at: '2026-04-15T00:00:00.000Z',
            github_pr_number: null,
            github_pr_url: null
          }
        ]
      ],
      [
        secondProjectId,
        [
          {
            id: 'wt-2',
            project_id: secondProjectId,
            name: 'main',
            branch_name: 'main',
            path: '/tmp/proj-2',
            status: 'active',
            is_default: true,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: '[]',
            last_model_provider_id: null,
            last_model_id: null,
            last_model_variant: null,
            created_at: '2026-04-15T00:00:00.000Z',
            last_accessed_at: '2026-04-15T00:00:00.000Z',
            github_pr_number: null,
            github_pr_url: null
          }
        ]
      ]
    ])
  })

  const createBatch = vi.fn(
    (
      batchProjectId: string,
      data: { drafts: Array<{ draft_key: string; depends_on?: string[] }> }
    ) => {
      const localDraftKeys = new Set(data.drafts.map((draft) => draft.draft_key))
      return Promise.resolve({
        tickets: data.drafts.map((draft) => ({ id: `${batchProjectId}:${draft.draft_key}` })),
        dependencies: data.drafts.flatMap((draft) =>
          (draft.depends_on ?? [])
            .filter((dependency) => localDraftKeys.has(dependency))
            .map((dependency) => ({
              dependent_id: draft.draft_key,
              blocker_id: dependency,
              created_at: '2026-04-15T00:00:00.000Z'
            }))
        )
      })
    }
  )

  useKanbanStore.setState({
    tickets: new Map([[projectId, []]]),
    isBoardViewActive: false,
    isPinnedBoardActive: false,
    loadTickets: vi.fn().mockResolvedValue(undefined),
    loadDependencies: vi.fn().mockResolvedValue(undefined)
  })

  useSettingsStore.setState({
    boardMode,
    defaultAgentSdk: 'opencode'
  })

  useSessionStore.setState({
    activeSessionId: null,
    activeBoardAssistantProjectId: projectId,
    activePinnedSessionId: null,
    inlineConnectionSessionId: null
  })

  Object.defineProperty(window, 'kanban', {
    writable: true,
    configurable: true,
    value: {
      ticket: {
        createBatch
      }
    }
  })

  Object.defineProperty(window, 'opencodeOps', {
    writable: true,
    configurable: true,
    value: {
      listModels: vi.fn().mockResolvedValue({ success: true, providers: [] })
    }
  })

  const store = useBoardChatStore.getState()
  const scope = {
    kind: 'project' as const,
    projectId,
    projectName: 'Project One',
    projectPath: '/tmp/proj-1'
  }
  store.activateScope(scope, { scope })
  const messages = [
    {
      id: assistantMessageId,
      role: 'assistant' as const,
      content: [
        'Ready.',
        '```board-ticket-drafts',
        JSON.stringify({
          drafts: seededDrafts.map((draft) => ({
            draftKey: draft.draftKey,
            title: draft.title,
            description: draft.description,
            projectId: draft.projectId,
            dependsOn: draft.dependsOn,
            warnings: draft.warnings
          }))
        }),
        '```'
      ].join('\n'),
      timestamp: '2026-04-15T00:00:00.000Z',
      kind: 'transcript' as const
    }
  ]
  const seededSnapshot = {
    scope,
    messages,
    drafts: seededDrafts,
    createdDraftIds: [],
    draftSourceMessageId: assistantMessageId,
    status: 'awaiting_confirmation' as const,
    selectedTargetProjectId: projectId,
    error: null,
    sessionId: null,
    opencodeSessionId: null,
    runtimePath: null,
    selectedAgentSdkOverride: null,
    selectedModelOverride: null,
    composerValue: ''
  }
  useBoardChatStore.setState({
    scope,
    messages,
    drafts: seededDrafts,
    draftSourceMessageId: assistantMessageId,
    status: 'awaiting_confirmation',
    snapshots: {
      [`project:${projectId}`]: seededSnapshot
    }
  })
}

describe('board assistant create navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('switches to the sticky board tab after creating tickets', async () => {
    seedStores('sticky-tab')

    render(<BoardAssistantView projectId={projectId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create all' }))

    await waitFor(() => {
      expect(useSessionStore.getState().activeSessionId).toBe(BOARD_TAB_ID)
    })
    expect(useSessionStore.getState().activeBoardAssistantProjectId).toBeNull()
  })

  test('switches back to the toggle board view after creating tickets', async () => {
    seedStores('toggle')

    render(<BoardAssistantView projectId={projectId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create all' }))

    await waitFor(() => {
      expect(useKanbanStore.getState().isBoardViewActive).toBe(true)
    })
    expect(useSessionStore.getState().activeBoardAssistantProjectId).toBeNull()
  })

  test('creates mixed-project drafts in project-scoped batches', async () => {
    seedStores('sticky-tab', [boardDraft, secondProjectDraft])
    const createBatch = window.kanban.ticket.createBatch as ReturnType<typeof vi.fn>
    const loadTickets = useKanbanStore.getState().loadTickets as ReturnType<typeof vi.fn>
    const loadDependencies = useKanbanStore.getState().loadDependencies as ReturnType<typeof vi.fn>

    render(<BoardAssistantView projectId={projectId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create all' }))

    await waitFor(() => {
      expect(createBatch).toHaveBeenCalledTimes(2)
    })
    expect(createBatch).toHaveBeenCalledWith(projectId, {
      drafts: [
        {
          draft_key: 'draft-1',
          project_id: projectId,
          title: boardDraft.title,
          description: boardDraft.description,
          column: 'todo',
          depends_on: []
        }
      ]
    })
    expect(createBatch).toHaveBeenCalledWith(secondProjectId, {
      drafts: [
        {
          draft_key: 'draft-2',
          project_id: secondProjectId,
          title: secondProjectDraft.title,
          description: secondProjectDraft.description,
          column: 'todo',
          depends_on: []
        }
      ]
    })
    expect(loadTickets).toHaveBeenCalledWith(projectId)
    expect(loadTickets).toHaveBeenCalledWith(secondProjectId)
    expect(loadDependencies).toHaveBeenCalledWith(projectId)
    expect(loadDependencies).toHaveBeenCalledWith(secondProjectId)
    expect(useBoardChatStore.getState().messages.at(-1)?.content).toBe(
      'Created 2 tickets and 0 dependencies.'
    )
  })

  test('store creation marks successful project batches before reporting partial failures', async () => {
    seedStores('sticky-tab', [boardDraft, secondProjectDraft])
    const createBatch = window.kanban.ticket.createBatch as ReturnType<typeof vi.fn>
    const loadTickets = useKanbanStore.getState().loadTickets as ReturnType<typeof vi.fn>
    const loadDependencies = useKanbanStore.getState().loadDependencies as ReturnType<typeof vi.fn>

    createBatch.mockImplementation(
      (
        batchProjectId: string,
        data: { drafts: Array<{ draft_key: string; depends_on?: string[] }> }
      ) => {
        if (batchProjectId === secondProjectId) {
          return Promise.reject(new Error('Kanban folder missing'))
        }

        return Promise.resolve({
          tickets: data.drafts.map((draft) => ({ id: `${batchProjectId}:${draft.draft_key}` })),
          dependencies: []
        })
      }
    )

    await useBoardChatStore.getState().createSelected()

    await waitFor(() => expect(createBatch).toHaveBeenCalledTimes(2))
    expect(loadTickets).toHaveBeenCalledWith(projectId)
    expect(loadTickets).not.toHaveBeenCalledWith(secondProjectId)
    expect(loadDependencies).toHaveBeenCalledWith(projectId)
    expect(loadDependencies).not.toHaveBeenCalledWith(secondProjectId)

    const partiallyCreatedState = useBoardChatStore.getState()
    expect(partiallyCreatedState.status).toBe('error')
    expect(partiallyCreatedState.error).toContain('Project Two: Kanban folder missing')
    expect(
      partiallyCreatedState.drafts.find((draft) => draft.id === boardDraft.id)?.createdAt
    ).not.toBeNull()
    expect(
      partiallyCreatedState.drafts.find((draft) => draft.id === secondProjectDraft.id)?.createdAt
    ).toBeNull()

    createBatch.mockClear()
    createBatch.mockImplementation(
      (
        batchProjectId: string,
        data: { drafts: Array<{ draft_key: string; depends_on?: string[] }> }
      ) =>
        Promise.resolve({
          tickets: data.drafts.map((draft) => ({ id: `${batchProjectId}:${draft.draft_key}` })),
          dependencies: []
        })
    )

    await useBoardChatStore.getState().createSelected()

    await waitFor(() => expect(createBatch).toHaveBeenCalledTimes(1))
    expect(createBatch).toHaveBeenCalledWith(secondProjectId, {
      drafts: [
        expect.objectContaining({
          draft_key: 'draft-2',
          project_id: secondProjectId,
          depends_on: []
        })
      ]
    })
    expect(
      useBoardChatStore.getState().drafts.find((draft) => draft.id === secondProjectDraft.id)
        ?.createdAt
    ).not.toBeNull()
  })

  test('store creation filters dependencies to each project batch', async () => {
    seedStores('sticky-tab', [boardDraft, secondProjectDraft])
    const createBatch = window.kanban.ticket.createBatch as ReturnType<typeof vi.fn>

    await useBoardChatStore.getState().createSelected()

    await waitFor(() => {
      expect(createBatch).toHaveBeenCalledTimes(2)
    })
    expect(createBatch).toHaveBeenCalledWith(projectId, {
      drafts: [
        expect.objectContaining({
          draft_key: 'draft-1',
          project_id: projectId,
          depends_on: []
        })
      ]
    })
    expect(createBatch).toHaveBeenCalledWith(secondProjectId, {
      drafts: [
        expect.objectContaining({
          draft_key: 'draft-2',
          project_id: secondProjectId,
          depends_on: []
        })
      ]
    })
  })
})
