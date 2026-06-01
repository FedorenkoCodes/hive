import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { formatSelectedKanbanFolder } from './kanban-folder-paths'

const mocks = vi.hoisted(() => ({
  updateProject: vi.fn(),
  loadProjects: vi.fn(),
  loadTickets: vi.fn(),
  kanbanConfigGet: vi.fn(),
  kanbanConfigUpdate: vi.fn(),
  kanbanConfigSetMode: vi.fn(),
  kanbanConfigCreateFolders: vi.fn(),
  kanbanConfigPickMarkdownFolder: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@/stores/useProjectStore', () => ({
  useProjectStore: () => ({
    updateProject: mocks.updateProject,
    loadProjects: mocks.loadProjects
  })
}))

vi.mock('@/stores/useKanbanStore', () => ({
  useKanbanStore: {
    getState: () => ({
      loadTickets: mocks.loadTickets
    })
  }
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess
  }
}))

type Project = ComponentProps<typeof ProjectSettingsDialog>['project']

const baseProject: Project = {
  id: 'project-1',
  name: 'Hive',
  path: '/tmp/hive',
  language: 'typescript',
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  worktree_create_script: null,
  custom_commands: null,
  auto_assign_port: false
}

function renderDialog(projectOverrides: Partial<Project> = {}) {
  return render(
    <ProjectSettingsDialog
      project={{ ...baseProject, ...projectOverrides }}
      open={true}
      onOpenChange={vi.fn()}
    />
  )
}

describe('ProjectSettingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateProject.mockResolvedValue(true)
    mocks.loadProjects.mockResolvedValue(undefined)
    mocks.loadTickets.mockResolvedValue(undefined)
    mocks.kanbanConfigGet.mockResolvedValue({
      success: true,
      value: {
        mode: 'internal',
        markdown: {
          layout: 'single-folder',
          singleFolder: 'docs/kanban',
          statusFolders: {
            todo: 'docs/kanban/todo',
            in_progress: 'docs/kanban/in-progress',
            done: 'docs/kanban/done'
          }
        }
      }
    })
    mocks.kanbanConfigUpdate.mockResolvedValue({
      success: true,
      value: {
        mode: 'internal',
        markdown: {
          layout: 'single-folder',
          singleFolder: 'docs/kanban'
        }
      }
    })
    mocks.kanbanConfigSetMode.mockResolvedValue({
      success: true,
      value: { success: true }
    })
    mocks.kanbanConfigCreateFolders.mockResolvedValue({
      success: true,
      value: {
        mode: 'markdown',
        markdown: {
          layout: 'single-folder',
          singleFolder: 'docs/kanban'
        }
      }
    })

    Object.defineProperty(window, 'projectOps', {
      writable: true,
      configurable: true,
      value: {
        detectSetupSuggestions: vi.fn().mockResolvedValue({ success: true, value: [] }),
        loadLanguageIcons: vi.fn().mockResolvedValue({ success: true, value: {} }),
        getProjectIconPath: vi.fn().mockResolvedValue({ success: true, value: null }),
        getAbsoluteIconDataUrl: vi.fn().mockResolvedValue({ success: true, value: null }),
        pickProjectIcon: vi.fn(),
        removeProjectIcon: vi.fn()
      }
    })

    Object.defineProperty(window, 'kanban', {
      writable: true,
      configurable: true,
      value: {
        config: {
          get: mocks.kanbanConfigGet,
          update: mocks.kanbanConfigUpdate,
          setMode: mocks.kanbanConfigSetMode,
          createFolders: mocks.kanbanConfigCreateFolders,
          pickMarkdownFolder: mocks.kanbanConfigPickMarkdownFolder
        }
      }
    })
  })

  it('formats selected Kanban folders for project-relative and absolute storage', () => {
    expect(formatSelectedKanbanFolder('/tmp/hive', '/tmp/hive/docs/kanban')).toBe('docs/kanban')
    expect(formatSelectedKanbanFolder('/tmp/hive', '/tmp/shared/cards')).toBe('/tmp/shared/cards')
    expect(formatSelectedKanbanFolder('/tmp/hive', '/tmp/hive')).toBe('.')
    expect(formatSelectedKanbanFolder('/tmp/hive/', '/tmp/hive/docs/kanban/')).toBe('docs/kanban')
    expect(formatSelectedKanbanFolder('/tmp/hive', '/tmp/hive-other/cards')).toBe(
      '/tmp/hive-other/cards'
    )
    expect(formatSelectedKanbanFolder('C:\\repo', 'C:\\repo\\cards')).toBe('cards')
  })

  it('collapses the worktree create script section by default when no script is configured', async () => {
    renderDialog({ worktree_create_script: null })

    await waitFor(() => expect(window.projectOps.detectSetupSuggestions).toHaveBeenCalled())

    expect(
      screen.getByRole('button', { name: /worktree create script/i })
    ).toHaveProperty('ariaExpanded', 'false')
    expect(screen.queryByText(/Advanced\. When set/)).toBeNull()
    expect(screen.queryByPlaceholderText(/git worktree add --no-checkout/)).toBeNull()
  })

  it('expands the worktree create script section by default when a script is configured', async () => {
    renderDialog({ worktree_create_script: 'echo custom-create' })

    await waitFor(() => expect(window.projectOps.detectSetupSuggestions).toHaveBeenCalled())

    expect(
      screen.getByRole('button', { name: /worktree create script/i })
    ).toHaveProperty('ariaExpanded', 'true')
    expect(screen.getByDisplayValue('echo custom-create')).toBeTruthy()
  })

  it('lets users expand the worktree create script section when it starts collapsed', async () => {
    const user = userEvent.setup()
    renderDialog({ worktree_create_script: null })

    await waitFor(() => expect(window.projectOps.detectSetupSuggestions).toHaveBeenCalled())

    await user.click(screen.getByRole('button', { name: /worktree create script/i }))

    expect(
      screen.getByRole('button', { name: /worktree create script/i })
    ).toHaveProperty('ariaExpanded', 'true')
    expect(screen.getByPlaceholderText(/git worktree add --no-checkout/)).toBeTruthy()
  })

  it('does not validate or save markdown config when saving internal-mode project settings', async () => {
    const user = userEvent.setup()
    renderDialog()

    await waitFor(() => expect(mocks.kanbanConfigGet).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalled())
    expect(mocks.kanbanConfigUpdate).not.toHaveBeenCalled()
    expect(mocks.kanbanConfigSetMode).toHaveBeenCalledWith('project-1', 'internal')
    expect(mocks.loadProjects).toHaveBeenCalled()
    expect(mocks.loadTickets).toHaveBeenCalledWith('project-1')
    expect(mocks.updateProject.mock.calls[0][1]).not.toHaveProperty('kanban_storage_mode')
    expect(mocks.updateProject.mock.calls[0][1]).not.toHaveProperty('kanban_markdown_config')
  })

  it('hides markdown folder controls while internal mode is selected', async () => {
    renderDialog()

    await waitFor(() => expect(mocks.kanbanConfigGet).toHaveBeenCalled())

    expect(screen.getByRole('button', { name: 'Internal' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Markdown' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'One folder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Status folders' })).toBeNull()
    expect(screen.queryByText('Folder')).toBeNull()
  })

  it('reveals markdown folder controls as soon as markdown mode is selected', async () => {
    const user = userEvent.setup()
    renderDialog()

    await waitFor(() => expect(mocks.kanbanConfigGet).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Markdown' }))

    expect(screen.getByRole('button', { name: 'One folder' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Status folders' })).toBeTruthy()
    expect(screen.getByText('Folder')).toBeTruthy()
    expect(screen.getByDisplayValue('docs/kanban')).toBeTruthy()
  })

  it('hides markdown folder controls again without clearing draft values when internal is reselected', async () => {
    const user = userEvent.setup()
    renderDialog()

    await waitFor(() => expect(mocks.kanbanConfigGet).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Markdown' }))
    const folderInput = screen.getByDisplayValue('docs/kanban')
    await user.clear(folderInput)
    await user.type(folderInput, 'docs/hive-board')
    await user.click(screen.getByRole('button', { name: 'Internal' }))

    expect(screen.queryByRole('button', { name: 'One folder' })).toBeNull()
    expect(screen.queryByText('Folder')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Markdown' }))

    expect(screen.getByDisplayValue('docs/hive-board')).toBeTruthy()
  })

  it('saves markdown config through Kanban APIs when markdown mode is selected', async () => {
    const user = userEvent.setup()
    renderDialog()

    await waitFor(() => expect(mocks.kanbanConfigGet).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Markdown' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalled())
    expect(mocks.kanbanConfigUpdate).toHaveBeenCalledWith('project-1', {
      layout: 'single-folder',
      singleFolder: 'docs/kanban',
      statusFolders: {
        todo: 'docs/kanban/todo',
        in_progress: 'docs/kanban/in-progress',
        done: 'docs/kanban/done'
      }
    })
    expect(mocks.kanbanConfigSetMode).toHaveBeenCalledWith('project-1', 'markdown')
    expect(mocks.loadProjects).toHaveBeenCalled()
    expect(mocks.loadTickets).toHaveBeenCalledWith('project-1')
    expect(mocks.updateProject.mock.calls[0][1]).not.toHaveProperty('kanban_storage_mode')
    expect(mocks.updateProject.mock.calls[0][1]).not.toHaveProperty('kanban_markdown_config')
  })

  it('stores an inside-project folder picker selection as a relative path', async () => {
    const user = userEvent.setup()
    mocks.kanbanConfigPickMarkdownFolder.mockResolvedValue({
      success: true,
      value: '/tmp/hive/docs/picked'
    })
    renderDialog()

    await waitFor(() => expect(mocks.kanbanConfigGet).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Markdown' }))
    await user.click(screen.getByRole('button', { name: 'Choose Kanban folder' }))

    expect(await screen.findByDisplayValue('docs/picked')).toBeTruthy()
    expect(screen.queryByDisplayValue('docs/kanban')).toBeNull()
  })

  it('stores an outside-project folder picker selection as an absolute path', async () => {
    const user = userEvent.setup()
    mocks.kanbanConfigPickMarkdownFolder.mockResolvedValue({
      success: true,
      value: '/tmp/shared/cards'
    })
    renderDialog()

    await waitFor(() => expect(mocks.kanbanConfigGet).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Markdown' }))
    await user.click(screen.getByRole('button', { name: 'Choose Kanban folder' }))

    expect(await screen.findByDisplayValue('/tmp/shared/cards')).toBeTruthy()
  })

  it('leaves the current markdown folder unchanged when folder picking is cancelled', async () => {
    const user = userEvent.setup()
    mocks.kanbanConfigPickMarkdownFolder.mockResolvedValue({ success: true, value: null })
    renderDialog()

    await waitFor(() => expect(mocks.kanbanConfigGet).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Markdown' }))
    await user.click(screen.getByRole('button', { name: 'Choose Kanban folder' }))

    expect(screen.getByDisplayValue('docs/kanban')).toBeTruthy()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('leaves the current markdown folder unchanged and reports picker failures', async () => {
    const user = userEvent.setup()
    mocks.kanbanConfigPickMarkdownFolder.mockResolvedValue({
      success: false,
      errorCode: 'KanbanHandlerFailed',
      error: 'Dialog failed'
    })
    renderDialog()

    await waitFor(() => expect(mocks.kanbanConfigGet).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Markdown' }))
    await user.click(screen.getByRole('button', { name: 'Choose Kanban folder' }))

    expect(screen.getByDisplayValue('docs/kanban')).toBeTruthy()
    expect(mocks.toastError).toHaveBeenCalledWith('Failed to choose Kanban folder')
  })

  it('updates only the selected status folder after picking a folder', async () => {
    const user = userEvent.setup()
    mocks.kanbanConfigPickMarkdownFolder.mockResolvedValue({
      success: true,
      value: '/tmp/hive/cards/in-progress'
    })
    renderDialog()

    await waitFor(() => expect(mocks.kanbanConfigGet).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Markdown' }))
    await user.click(screen.getByRole('button', { name: 'Status folders' }))

    expect(screen.getByRole('button', { name: 'Choose To Do Kanban folder' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Choose In Progress / Review Kanban folder' })
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose Done Kanban folder' })).toBeTruthy()

    await user.click(
      screen.getByRole('button', { name: 'Choose In Progress / Review Kanban folder' })
    )

    expect(await screen.findByDisplayValue('cards/in-progress')).toBeTruthy()
    expect(screen.getByDisplayValue('docs/kanban/todo')).toBeTruthy()
    expect(screen.getByDisplayValue('docs/kanban/done')).toBeTruthy()
  })

  it('saves normalized folder picker paths through the Kanban config API', async () => {
    const user = userEvent.setup()
    mocks.kanbanConfigPickMarkdownFolder.mockResolvedValue({
      success: true,
      value: '/tmp/hive/cards/selected'
    })
    renderDialog()

    await waitFor(() => expect(mocks.kanbanConfigGet).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Markdown' }))
    await user.click(screen.getByRole('button', { name: 'Choose Kanban folder' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalled())
    expect(mocks.kanbanConfigUpdate).toHaveBeenCalledWith('project-1', {
      layout: 'single-folder',
      singleFolder: 'cards/selected',
      statusFolders: {
        todo: 'docs/kanban/todo',
        in_progress: 'docs/kanban/in-progress',
        done: 'docs/kanban/done'
      }
    })
  })

  it('offers explicit folder creation and retries save when markdown folders are missing', async () => {
    const user = userEvent.setup()
    mocks.kanbanConfigGet.mockResolvedValue({
      success: true,
      value: {
        mode: 'markdown',
        markdown: {
          layout: 'single-folder',
          singleFolder: 'docs/kanban'
        }
      }
    })
    mocks.kanbanConfigUpdate
      .mockResolvedValueOnce({
        success: false,
        errorCode: 'KanbanHandlerFailed',
        error: 'ENOENT: no such file or directory'
      })
      .mockResolvedValueOnce({
        success: true,
        value: {
          mode: 'markdown',
          markdown: {
            layout: 'single-folder',
            singleFolder: 'docs/kanban'
          }
        }
      })
    renderDialog({ kanban_storage_mode: 'markdown' })

    await waitFor(() => expect(mocks.kanbanConfigGet).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Kanban folder needs to be created')).toBeTruthy()
    expect(screen.getByText('docs/kanban')).toBeTruthy()
    expect(screen.queryByText(/realpath/i)).toBeNull()
    expect(mocks.kanbanConfigCreateFolders).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Create folder and enable' }))

    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalled())
    expect(mocks.kanbanConfigCreateFolders).toHaveBeenCalledWith('project-1', {
      layout: 'single-folder',
      singleFolder: 'docs/kanban',
      statusFolders: {
        todo: 'docs/kanban/todo',
        in_progress: 'docs/kanban/in-progress',
        done: 'docs/kanban/done'
      }
    })
    expect(mocks.kanbanConfigUpdate).toHaveBeenCalledTimes(2)
    expect(mocks.kanbanConfigSetMode).toHaveBeenLastCalledWith('project-1', 'markdown')
  })
})
