/**
 * workflow-store.ts（工作流 overlay 模块级状态）的单元测试：listCollapsed 初始值、
 * toggleListCollapse 翻转、跨 overlay 开合保留，以及切换不影响其余状态（列宽等）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/workflow-store.spec
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  closeWorkflowOverlay, getWorkflowState, openWorkflowOverlay, setWorkflowState, toggleListCollapse,
} from './workflow-store.ts'

/** 模块加载时的初始快照（vitest 每个 spec 文件独立模块注册表；测试间经此重置）。 */
const initial = getWorkflowState()

beforeEach(() => {
  // 恢复初始状态（含 listCollapsed: false），避免测试间互相污染。
  setWorkflowState({ ...initial })
})

describe('listCollapsed', () => {
  it('默认展开（listCollapsed = false）', () => {
    expect(getWorkflowState().listCollapsed).toBe(false)
  })

  it('toggleListCollapse 在收起/展开间翻转', () => {
    toggleListCollapse()
    expect(getWorkflowState().listCollapsed).toBe(true)
    toggleListCollapse()
    expect(getWorkflowState().listCollapsed).toBe(false)
  })

  it('收起状态跨 overlay 开合保留', () => {
    openWorkflowOverlay()
    toggleListCollapse()
    closeWorkflowOverlay()
    expect(getWorkflowState().open).toBe(false)
    expect(getWorkflowState().listCollapsed).toBe(true)
    openWorkflowOverlay()
    expect(getWorkflowState().open).toBe(true)
    expect(getWorkflowState().listCollapsed).toBe(true)
  })

  it('toggleListCollapse 不影响其余状态（如左列表列宽）', () => {
    const widthBefore = getWorkflowState().listWidth
    toggleListCollapse()
    expect(getWorkflowState().listCollapsed).toBe(true)
    expect(getWorkflowState().listWidth).toBe(widthBefore)
  })
})
