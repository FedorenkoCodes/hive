import { useEffect, useRef } from 'react'

import { useKanbanStore } from '@/stores/useKanbanStore'

function normalizeProjectIds(projectIds: string[]): string[] {
  return [...new Set(projectIds.filter(Boolean))].sort()
}

export function useMarkdownKanbanWatcher(
  projectIds: string[],
  reloadProject?: (projectId: string) => void | Promise<void>
): void {
  const watchedProjectIds = normalizeProjectIds(projectIds)
  const watchedKey = watchedProjectIds.join('\n')
  const previousProjectIdsRef = useRef<string[]>([])
  const reloadProjectRef = useRef(reloadProject)

  useEffect(() => {
    reloadProjectRef.current = reloadProject
  }, [reloadProject])

  useEffect(() => {
    const previousProjectIds = previousProjectIdsRef.current
    const previous = new Set(previousProjectIds)
    const next = new Set(watchedProjectIds)

    for (const projectId of previousProjectIds) {
      if (!next.has(projectId)) {
        window.kanban.watch.stop(projectId).catch(() => {
          // Watcher teardown is best-effort.
        })
      }
    }

    for (const projectId of watchedProjectIds) {
      if (!previous.has(projectId)) {
        window.kanban.watch.start(projectId).catch(() => {
          // Internal projects and unavailable folders should not break the board.
        })
      }
    }

    previousProjectIdsRef.current = watchedProjectIds
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedKey])

  useEffect(() => {
    const unsubscribe = window.kanban.watch.onChanged((event) => {
      if (!previousProjectIdsRef.current.includes(event.projectId)) return
      const reload = reloadProjectRef.current ?? useKanbanStore.getState().loadTickets
      void reload(event.projectId)
    })

    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    return () => {
      for (const projectId of previousProjectIdsRef.current) {
        window.kanban.watch.stop(projectId).catch(() => {
          // Watcher teardown is best-effort.
        })
      }
      previousProjectIdsRef.current = []
    }
  }, [])
}
