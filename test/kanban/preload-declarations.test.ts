import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('preload declaration contract', () => {
  test('keeps the hand-authored window API surface', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/preload/index.d.ts'), 'utf-8')

    expect(source).toContain('declare global')
    expect(source).toContain('interface Window')
    expect(source).toContain('db:')
    expect(source).toContain('kanban:')
    expect(source).toContain('config:')
    expect(source).toContain('diagnostics:')
    expect(source).toContain('watch:')
    expect(source).toContain('onChanged: (callback: (event: MarkdownKanbanChangedEvent) => void) => () => void')
    expect(source).toContain('createFolders: (')
    expect(source).toContain('config?: KanbanMarkdownConfig')
    expect(source).toContain('blocking: true')
  })
})
