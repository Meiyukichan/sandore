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

  it('adds the auto-fill progress hint and keeps the paging pair（批 A2）', () => {
    expect(zh['run.step.chat.paging.autofill']).toBe('正在加载更早的消息…')
    expect(en['run.step.chat.paging.autofill']).toBe('Loading earlier messages...')
    // 同族的分页键不得被这次新增顶掉（自动补齐结束后仍要用手动按钮文案）。
    expect(zh['run.step.chat.paging.loadOlder']).toBe('加载更早')
    expect(en['run.step.chat.paging.loadOlder']).toBe('Load earlier')
  })

  it('adds the @step mention keys（批 B1）', () => {
    expect(zh['step.mention.section']).toBe('步骤')
    expect(en['step.mention.section']).toBe('Steps')
    expect(zh['step.mention.artifacts']).toBe('{count} 个产物')
    expect(en['step.mention.artifacts']).toBe('{count} artifacts')
    expect(zh['step.mention.noArtifacts']).toBe('无产物')
    expect(en['step.mention.noArtifacts']).toBe('no artifacts')
    expect(zh['step.mention.serializeFailed']).toContain('{name}')
    expect(en['step.mention.serializeFailed']).toContain('{name}')
    // 同族的输入框键不得被这次新增顶掉——需求 1 起面板不再挂载输入框，这族键随
    // ComposerBar 保留为「恢复面板输入框」的入口，删键会让恢复时缺文案。
    expect(zh['run.step.chat.composer.placeholder']).toBe('发消息或做任务…')
    expect(en['run.step.chat.composer.send']).toBe('Send message')
  })

  it('adds the in-panel retry keys（批 B2）', () => {
    expect(zh['run.step.chat.retry.submit']).toBe('重试')
    expect(en['run.step.chat.retry.submit']).toBe('Retry')
    expect(zh['run.step.chat.retry.running']).toBe('重试中…')
    expect(en['run.step.chat.retry.running']).toBe('Retrying…')
    expect(zh['run.step.chat.retry.defaultMessage']).toBe('请重试该步骤')
    expect(en['run.step.chat.retry.defaultMessage']).toBe('Please retry this step')
    expect(zh['run.step.chat.retry.failed']).toBe('重试失败')
    expect(zh['run.step.chat.retry.boundariesFailed']).toContain('{message}')
    expect(en['run.step.chat.retry.boundariesFailed']).toContain('{message}')
    expect(zh['run.step.chat.retry.revertUnavailable']).toContain('闭合 turn')
    expect(en['run.step.chat.retry.revertUnavailable']).toContain('closed turn')
    expect(zh['run.step.chat.retry.disposed']).toContain('子代理会话已销毁')
    expect(en['run.step.chat.retry.disposed']).toContain('disposed')
    expect(zh['run.step.chat.composer.readonly']).toBe('宿主对话页正打开该子代理会话，此处只读')
    expect(en['run.step.chat.composer.readonly']).toContain('read-only')
    // 复用的既有键不得被这次新增顶掉（重试行的模式/回退点标签就取这两族）。
    expect(zh['run.retry.mode.revert']).toBe('回退')
    expect(en['run.retry.mode.fork']).toBe('Fork')
    expect(zh['run.retry.boundary.default']).toBe('默认（最后一个闭合 turn）')
    expect(en['run.retry.boundary.empty']).toBe('No revert points available')
  })

  it('adds the user fold-row title（需求 2：与思考行同源的折叠标题）', () => {
    expect(zh['run.step.chat.user.row']).toBe('用户消息')
    expect(en['run.step.chat.user.row']).toBe('User message')
    // 成对的思考行标题不得被这次新增顶掉（两条行共用同一折叠行壳）。
    expect(zh['message.think']).toBe('思考')
    expect(en['message.think']).toBe('Think')
  })

  it('adds the main-agent session tab keys（主代理会话内的「工作流」tab）', () => {
    expect(zh['tab.workflow']).toBe('工作流')
    expect(en['tab.workflow']).toBe('Workflow')
    // 空态一对象：主行（本会话没有绑定实例）+ 次级提示（无实例会话的**静态骨架**右栏说明位用它）。
    expect(zh['tab.workflow.empty']).toContain('本会话')
    expect(en['tab.workflow.empty']).toContain('this session')
    expect(zh['tab.workflow.empty.hint']).toContain('执行视图')
    expect(en['tab.workflow.empty.hint']).toContain('run view')
    // 静态骨架的两张空列表复用侧栏列表的空态键（同族文案）。
    expect(zh['panel.empty.definitions']).toBe('暂无工作流定义')
    expect(en['panel.empty.definitions']).toBe('No workflow definitions')
    // 复用的既有键不得被这次新增顶掉：列表页空态（tab 的加载态也读它那一族）与侧栏入口文案。
    expect(zh['panel.empty.instances']).toBe('暂无工作流实例')
    expect(en['panel.empty.instances']).toBe('No workflow instances')
    expect(zh['panel.loading']).toBe('加载中…')
    expect(en['panel.loading']).toBe('Loading…')
    expect(zh['button.trigger']).toBe('工作流')
    expect(en['button.trigger']).toBe('Workflow')
  })

  it('drops the unreachable user-message kind labels（遗留行不再渲染）', () => {
    // `buildTimeline` 只放行 `kind:'input'`（真实用户输入），resume/retry/answer/message
    // 的徽标文案已无引用点；留着会让人以为这些行还会渲染，所以删键——旧实例的遗留行
    // 连徽标带气泡一起不渲染，不是「渲染成没有徽标的行」。
    const zhLoose = zh as Record<string, string | undefined>
    const enLoose = en as Record<string, string | undefined>
    expect(zhLoose['run.user.kind.resume']).toBeUndefined()
    expect(enLoose['run.user.kind.resume']).toBeUndefined()
    expect(zhLoose['run.user.kind.retry']).toBeUndefined()
    expect(enLoose['run.user.kind.retry']).toBeUndefined()
    expect(zhLoose['run.user.kind.answer']).toBeUndefined()
    expect(enLoose['run.user.kind.answer']).toBeUndefined()
    expect(zhLoose['run.user.kind.message']).toBeUndefined()
    expect(enLoose['run.user.kind.message']).toBeUndefined()
    // 唯一保留的那支（input = 原始需求）不得被这次删键误伤。
    expect(zh['run.user.kind.input']).toBe('需求')
    expect(en['run.user.kind.input']).toBe('Request')
  })
})
