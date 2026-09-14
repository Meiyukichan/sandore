/**
 * orchestration-tool-view.tsx：把「工作流导航卡」注册进 **DSH 原生工具行**的 keyed slot
 * `tool.call.toolview`（用户明确要求：那张卡要出现在**主代理会话**的工具行里，不是只在
 * sandore 面板里）。
 *
 * ## 为什么是这条槽
 * DSH 的原子工具调用行由 `ui-tool` 的 `ToolCallTree` 按 **wire 工具名**分发到
 * `tool.call.toolview`（keyed slot，`ui-tool/src/client/contract/slots.ts:11-46`：
 * 注册 props = `{ callId, toolName, block, cwd, home, openFile, inspect }`）。
 * **命中即替换该行的通用卡片**——所以注册视图必须自带「默认文本结果」的渲染
 * （这里复用本包在 sandore 面板里用的同一张 GenericToolCard），再加导航卡；
 * 否则注册本身会把默认结果吃掉。
 *
 * ## 与 sandore 面板那条的关系（同源复用，不是两套）
 * - 卡片本体同一个：{@link ./orchestration-tool-card.tsx} 的 `OrchestrationToolCard`；
 * - 目标解析同一个：{@link ./orchestration-tool-model.ts} 的 `orchestrationToolTargetOf`；
 * - 默认结果渲染同一个：`step-view/tool/GenericToolCard.tsx`。
 * 差别只在「谁提供 props」：DSH 侧给的是它自己的 `ToolCallBlock`，面板侧给的是本包
 * `StepToolCallBlock`——两者结构同形（`kind:'tool-result'` + `call.argsRaw` + `content` + `subCalls`），
 * 故适配层只做一次结构断言转写（见下）。
 *
 * ## 依赖（本包 package.json 已登记）
 * - `@deepseek-ai/dsh-client-ui-tool`：**只取类型**（`ToolCallViewProps` 与 `SlotMap` 增强），
 *   编译期擦除 → bundle 里不留运行时 import（因此 `tsdown.config.ts` 的 `CLIENT_EXTERNALS`
 *   不需要加它：那里面列的是**运行时**要从平台模块表 require 的模块）；
 * - `dsh.client.inject` 加它：声明「本插件要求平台先装配 ui-tool（槽的声明方）」，
 *   否则 `slots.inject` 会一直挂着不注册（不报错，但也不会有卡）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/orchestration-tool-view
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
// 槽名/槽 props 的类型增强（'tool.call.toolview'）随该包的类型入口生效。
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'

import { NS } from './locales.ts'
import { OrchestrationToolCard } from './orchestration-tool-card.tsx'
import {
  ORCHESTRATION_TOOL_NAMES,
  orchestrationToolTargetOf,
} from './orchestration-tool-model.ts'
import type { StepToolCallBlock } from './step-view/step-row-data.ts'
import { GenericToolCard } from './step-view/tool/GenericToolCard.tsx'

/**
 * 注册视图的完整 props（与 DSH 既有 toolview 同款写法：运行时 props + 本命名空间 locale seat
 * ——`register({ …, locale: NS })` 会给组件补上 `t`，类型上要自己声明）。
 */
type OrchestrationToolViewProps = ToolCallViewProps & PropsLocale<'sandore'>

/**
 * DSH 原子工具行 → 我们的视图。
 *
 * 渲染顺序与 sandore 面板一致：**默认文本结果在前，导航卡在后**（用户：除了默认返回外还要有 UI）。
 * `instanceId` 解析：结果（run/control 的返回里都带）→ 调用参数（control 显式传）→ 无面板会话可兜底
 * 时就不渲染导航（只留默认结果，绝不猜实例）。
 * @param props - DSH `tool.call.toolview` 的运行时 props + locale seat。
 * @returns 默认结果卡（+ 命中时追加导航卡）。
 */
function OrchestrationToolView({ toolName, block, cwd, openFile, t }: OrchestrationToolViewProps) {
  // 结构转写：DSH 的 ToolCallBlock 与本包 StepToolCallBlock 同形（见文件头）；不适配时下方
  // `orchestrationToolTargetOf` 会因工具名/形状不符返回 undefined → 只渲染默认结果。
  const local = block as unknown as StepToolCallBlock
  const target = orchestrationToolTargetOf(local, '')
  const open = typeof openFile === 'function' ? openFile : undefined
  return (
    <>
      <GenericToolCard
        toolName={toolName}
        block={local}
        cwd={cwd}
        openFile={open}
        t={t as unknown as TranslateNS<'sandore'>}
      />
      {target !== undefined && (
        <OrchestrationToolCard target={target} t={t as unknown as TranslateNS<'sandore'>} />
      )}
    </>
  )
}

/**
 * 注册我们三个工具（run / pause+continue 同一工具）的 DSH 工具行视图。
 *
 * 走 `slots.inject` + 生成器（与 ui-tool / ui-skill 的既有注册写法一致）：槽由 ui-tool 声明，
 * 未装配时回调不执行（不报错）；每个 key 的注册各返回一个 disposer，随插件卸载一起撤下。
 * @param ctx - 本插件的 client ctx（必须已 inject `slots`）。
 */
export function registerOrchestrationToolViews(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of ORCHESTRATION_TOOL_NAMES) {
      yield ctx.slots.register(
        { name: 'tool.call.toolview', key, locale: NS },
        OrchestrationToolView,
      )
    }
  })
}
