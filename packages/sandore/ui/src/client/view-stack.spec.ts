/**
 * view-stack.ts（WorkflowPanel 两级下钻 view 栈 reducer）的纯函数单元测试：
 * 初始态为 list，`open` 压入 editor/run，`back` 回退且不回退到栈底之下。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/view-stack.spec
 */
import { describe, expect, it } from 'vitest'

import { INITIAL_VIEW_STACK, topView, viewStackReducer, type DrilldownView } from './view-stack.ts'

/** 构造一个 editor 视图（可选 id）。 */
function editorView(definitionId?: string): DrilldownView {
  return { kind: 'editor', definitionId }
}

/** 构造一个 run 视图。 */
function runView(instanceId: string): DrilldownView {
  return { kind: 'run', instanceId }
}

describe('INITIAL_VIEW_STACK', () => {
  it('starts with a single list view on top', () => {
    expect(INITIAL_VIEW_STACK).toEqual([{ kind: 'list' }])
  })
})

describe('viewStackReducer open', () => {
  it('pushes an editor view on top of the list view', () => {
    const next = viewStackReducer(INITIAL_VIEW_STACK, { type: 'open', view: editorView('wfl-1') })

    expect(next).toEqual([{ kind: 'list' }, { kind: 'editor', definitionId: 'wfl-1' }])
  })

  it('pushes a run view on top of the list view', () => {
    const next = viewStackReducer(INITIAL_VIEW_STACK, { type: 'open', view: runView('inst-1') })

    expect(next).toEqual([{ kind: 'list' }, { kind: 'run', instanceId: 'inst-1' }])
  })

  it('does not mutate the previous stack', () => {
    const before = [{ kind: 'list' }] as const
    viewStackReducer(before, { type: 'open', view: runView('inst-1') })

    expect(before).toEqual([{ kind: 'list' }])
  })
})

describe('topView', () => {
  it('returns the list view for the initial stack', () => {
    expect(topView(INITIAL_VIEW_STACK)).toEqual({ kind: 'list' })
  })

  it('returns the topmost view after drilling down', () => {
    const drilled = viewStackReducer(INITIAL_VIEW_STACK, { type: 'open', view: runView('inst-1') })

    expect(topView(drilled)).toEqual({ kind: 'run', instanceId: 'inst-1' })
  })
})

describe('viewStackReducer back', () => {
  it('pops back from an editor view to the list view', () => {
    const drilled = viewStackReducer(INITIAL_VIEW_STACK, { type: 'open', view: editorView('wfl-1') })

    expect(viewStackReducer(drilled, { type: 'back' })).toEqual([{ kind: 'list' }])
  })

  it('pops back from a run view to the list view', () => {
    const drilled = viewStackReducer(INITIAL_VIEW_STACK, { type: 'open', view: runView('inst-1') })

    expect(viewStackReducer(drilled, { type: 'back' })).toEqual([{ kind: 'list' }])
  })

  it('is a no-op when already at the list view (never underflows)', () => {
    expect(viewStackReducer(INITIAL_VIEW_STACK, { type: 'back' })).toEqual([{ kind: 'list' }])
  })

  it('walks back one level at a time through deeper stacks', () => {
    const deep = viewStackReducer(
      viewStackReducer(INITIAL_VIEW_STACK, { type: 'open', view: editorView('wfl-1') }),
      { type: 'open', view: runView('inst-1') },
    )

    expect(deep).toEqual([
      { kind: 'list' },
      { kind: 'editor', definitionId: 'wfl-1' },
      { kind: 'run', instanceId: 'inst-1' },
    ])

    const backToEditor = viewStackReducer(deep, { type: 'back' })
    expect(backToEditor).toEqual([{ kind: 'list' }, { kind: 'editor', definitionId: 'wfl-1' }])

    const backToList = viewStackReducer(backToEditor, { type: 'back' })
    expect(backToList).toEqual([{ kind: 'list' }])

    expect(viewStackReducer(backToList, { type: 'back' })).toEqual([{ kind: 'list' }])
  })
})
