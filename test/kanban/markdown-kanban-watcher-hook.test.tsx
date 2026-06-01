import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { useMarkdownKanbanWatcher } from '@/hooks/useMarkdownKanbanWatcher'
import { useKanbanStore } from '@/stores/useKanbanStore'

describe('useMarkdownKanbanWatcher', () => {
  let onChangedCallback: ((event: { projectId: string; paths: string[]; eventTypes: Array<'add' | 'change' | 'unlink'> }) => void) | null
  const start = vi.fn()
  const stop = vi.fn()
  const unsubscribe = vi.fn()
  const loadTickets = vi.fn()
  const reloadProject = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    onChangedCallback = null
    start.mockResolvedValue({ success: true, value: { success: true } })
    stop.mockResolvedValue({ success: true, value: { success: true } })
    reloadProject.mockResolvedValue(undefined)
    Object.defineProperty(window, 'kanban', {
      configurable: true,
      writable: true,
      value: {
        watch: {
          start,
          stop,
          onChanged: vi.fn((callback) => {
            onChangedCallback = callback
            return unsubscribe
          })
        }
      }
    })
    useKanbanStore.setState({ loadTickets })
  })

  test('starts, updates, reloads, and stops watched project scopes', async () => {
    const { rerender, unmount } = renderHook(
      ({ projectIds }) => useMarkdownKanbanWatcher(projectIds),
      { initialProps: { projectIds: ['project-a'] } }
    )

    await waitFor(() => {
      expect(start).toHaveBeenCalledWith('project-a')
    })

    rerender({ projectIds: ['project-b', 'project-c'] })

    await waitFor(() => {
      expect(stop).toHaveBeenCalledWith('project-a')
      expect(start).toHaveBeenCalledWith('project-b')
      expect(start).toHaveBeenCalledWith('project-c')
    })

    act(() => {
      onChangedCallback?.({ projectId: 'project-a', paths: ['/repo/a.md'], eventTypes: ['change'] })
      onChangedCallback?.({ projectId: 'project-b', paths: ['/repo/b.md'], eventTypes: ['change'] })
    })

    expect(loadTickets).toHaveBeenCalledTimes(1)
    expect(loadTickets).toHaveBeenCalledWith('project-b')

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(stop).toHaveBeenCalledWith('project-b')
      expect(stop).toHaveBeenCalledWith('project-c')
    })
  })

  test('uses the scoped reload callback for watched project changes', async () => {
    renderHook(
      ({ projectIds, reload }) => useMarkdownKanbanWatcher(projectIds, reload),
      { initialProps: { projectIds: ['project-a'], reload: reloadProject } }
    )

    await waitFor(() => {
      expect(start).toHaveBeenCalledWith('project-a')
    })

    act(() => {
      onChangedCallback?.({ projectId: 'project-a', paths: ['/repo/a.md'], eventTypes: ['change'] })
      onChangedCallback?.({ projectId: 'project-b', paths: ['/repo/b.md'], eventTypes: ['change'] })
    })

    expect(reloadProject).toHaveBeenCalledTimes(1)
    expect(reloadProject).toHaveBeenCalledWith('project-a')
    expect(loadTickets).not.toHaveBeenCalled()
  })
})
