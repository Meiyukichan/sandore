/**
 * locales.ts 的文案回归测试：zh/en 键集对齐 + 本次「新增实例 → 运行工作流」
 * 文案迁移 + 目录路径编辑器标签（键级断言，防误改回退）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/locales.spec
 */
import { describe, expect, it } from 'vitest'

import { en, zh } from './locales.ts'

describe('locales', () => {
  it('keeps the zh/en dictionaries key-for-key aligned', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('renames the instance entry into Run workflow（任务 A 文案）', () => {
    expect(zh['panel.add.instance']).toBe('运行工作流')
    expect(zh['panel.add.instance.hint']).toBe('选择工作流并填写需求后运行')
    expect(zh['panel.empty.instances.hint']).toBe('点击「运行工作流」选择工作流并填写需求后运行')
    expect(zh['instance.create.title']).toBe('运行工作流')
    expect(en['panel.add.instance']).toBe('Run workflow')
    expect(en['panel.add.instance.hint']).toBe('Pick a workflow, describe the task, and run')
    expect(en['panel.empty.instances.hint']).toBe('Click "Run workflow" to pick a workflow, describe the task, and run')
    expect(en['instance.create.title']).toBe('Run workflow')
  })

  it('adds the cwd path-editor label（任务 B）', () => {
    expect(zh['cwdBrowse.editPath']).toBe('编辑路径')
    expect(en['cwdBrowse.editPath']).toBe('Edit path')
  })

  it('repurposes the permission default key to Full access（任务 D 死键防误用）', () => {
    expect(zh['instance.create.permission.default']).toBe('Full access')
    expect(en['instance.create.permission.default']).toBe('Full access')
  })
})
