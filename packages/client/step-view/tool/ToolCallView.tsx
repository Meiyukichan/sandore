/**
 * ToolCallView（B2b step-view 版）：抄自 DSH 0.1.2-rc.1
 * `ui-tool/src/client/tool/ToolCallTree.tsx` + ToolCallTree.module.css（只读参考
 * deepseek-harness）。
 *
 * 根 Tool call 与其递归子调用的组成：每个 block 一行（名称/icon/状态色/可折叠
 * 展开），子调用按 dispatch 顺序嵌套在左竖线缩进组下。rc.1 中每一行经
 * `tool.call.toolview` keyed slot 分发给工具自有 atomic 视图，无 occupant 时落到
 * GenericToolCard——sandore 不注册任何 atomic toolview，因此每行都走 GenericToolCard
 * fallback（与 rc.1 无 occupant 行为 1:1，报告中说明）。
 *
 * 显式裁剪：selectedCallId/inspectCall（详情抽屉联动，data-selected 不再使用）、
 * cwd/home（home 无 host description 面；cwd 仅文件链接摘要用）按面板能力收窄；
 * 子调用树的递归、subCalls 边框几何与每行视觉逐字保留。展开折叠均为行本地
 * useState（rc.1 同），无宿主 details 抽屉。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/tool/ToolCallView
 */
import { memo } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { OrchestrationToolCard } from '../../orchestration-tool-card.tsx'
import { orchestrationToolTargetOf } from '../../orchestration-tool-model.ts'
import { stepChatToolCallPayloadOf, type StepToolCallBlock } from '../step-row-data.ts'
import { GenericToolCard } from './GenericToolCard.tsx'
import css from './tool-call.module.css'

/** 从任一生命周期形式解析 Tool call 的 wire 名。 */
export function stepToolCallName(block: StepToolCallBlock): string {
  return 'kind' in block ? block.call?.name ?? '' : block.name
}

/** 一个原子调用行（无 keyed slot 注册时 = GenericToolCard fallback）。 */
const StepToolCall = memo(function StepToolCall({
  toolName, block, cwd, openFile, t, onOpenChild, instanceId, children,
}: {
  toolName: string
  block: StepToolCallBlock
  /** 会话工作区根（路径摘要相对显示；面板未知时省略）。 */
  cwd?: string | undefined
  /** 打开文件路径（面板 workspaces 通道）。 */
  openFile?: ((path: string) => void) | undefined
  /** 跳 step 子代理会话（工具行内嵌导航的 Step 行跳转；缺省不显示跳转按钮）。 */
  onOpenChild?: ((childId: string) => void) | undefined
  /** 面板所在实例/宿主会话 id（control 工具省略 instanceId 时的恒等式兜底）。 */
  instanceId?: string | undefined
  t: TranslateNS<'sandore'>
  children?: ReactNode
}) {
  // run / control 三个工具：默认文本结果**照旧**，额外在其下内嵌工作流导航 UI
  // （数据面 = orchestration-tool-store：getInstanceState + sandore/* SSE）。
  const target = orchestrationToolTargetOf(block, instanceId ?? '')
  return (
    <div className={css.callRow} data-chat-anchor-key={`call:${block.callId}`} data-chat-call-id={block.callId}>
      <GenericToolCard toolName={toolName} block={block} cwd={cwd} openFile={openFile} t={t} />
      {target !== undefined && (
        <OrchestrationToolCard
          target={target}
          t={t}
          {...(onOpenChild === undefined ? {} : { onOpenChild })}
        />
      )}
      {children}
    </div>
  )
})

const StepToolCallBranch = memo(function StepToolCallBranch({
  block, cwd, openFile, t, onOpenChild, instanceId,
}: {
  block: StepToolCallBlock
  cwd?: string | undefined
  openFile?: ((path: string) => void) | undefined
  onOpenChild?: ((childId: string) => void) | undefined
  instanceId?: string | undefined
  t: TranslateNS<'sandore'>
}) {
  return (
    <StepToolCall
      toolName={stepToolCallName(block)}
      block={block}
      cwd={cwd}
      openFile={openFile}
      t={t}
      {...(onOpenChild === undefined ? {} : { onOpenChild })}
      {...(instanceId === undefined ? {} : { instanceId })}
    >
      {block.subCalls.length > 0 ? (
        <div className={css.subCalls} data-subcalls>
          {block.subCalls.map(child => (
            <StepToolCallBranch
              key={child.callId}
              block={child}
              cwd={cwd}
              openFile={openFile}
              t={t}
              {...(onOpenChild === undefined ? {} : { onOpenChild })}
              {...(instanceId === undefined ? {} : { instanceId })}
            />
          ))}
        </div>
      ) : null}
    </StepToolCall>
  )
})

/**
 * 渲染一个根 Tool call 及其递归子调用（本地 payload 面）。
 * @param props - root block 与 locale seat。
 * @returns Tool call 树。
 */
export function ToolCallView({ root, cwd, openFile, onOpenChild, instanceId, t }: {
  /** data.root（本地断言面；undefined = 形状不符 → 空行不渲染）。 */
  root: StepToolCallBlock | undefined
  cwd?: string | undefined
  openFile?: ((path: string) => void) | undefined
  /** 跳 step 子代理会话（内嵌导航的 Step 行）。 */
  onOpenChild?: ((childId: string) => void) | undefined
  /** 面板所在实例/宿主会话 id（control 的 instanceId 兜底）。 */
  instanceId?: string | undefined
  t: TranslateNS<'sandore'>
}) {
  return root === undefined
    ? null
    : (
      <StepToolCallBranch
        block={root}
        cwd={cwd}
        openFile={openFile}
        t={t}
        {...(onOpenChild === undefined ? {} : { onOpenChild })}
        {...(instanceId === undefined ? {} : { instanceId })}
      />
    )
}

/** tool-call 行的 keyed 渲染器（B2b StepChatViewRow 分发目标）。 */
export const StepChatToolCallView = memo(function StepChatToolCallView({ data, cwd, onOpenFile, onOpenChild, instanceId, t }: {
  /** ChatNode.data（live；读取层防御归一，root 不可读 → 空行，不抛）。 */
  data: unknown
  /** 会话工作区根（路径摘要相对显示；面板未知时省略）。 */
  cwd?: string | undefined
  /** 打开文件路径（面板 workspaces 通道）。 */
  onOpenFile?: ((path: string) => void) | undefined
  /** 跳 step 子代理会话（工具行内嵌导航）。 */
  onOpenChild?: ((childId: string) => void) | undefined
  /** 面板所在实例/宿主会话 id（control 的 instanceId 兜底）。 */
  instanceId?: string | undefined
  /** 该行的 locale seat。 */
  t: TranslateNS<'sandore'>
}) {
  const payload = stepChatToolCallPayloadOf(data)
  return (
    <ToolCallView
      root={payload.root}
      cwd={cwd}
      openFile={onOpenFile}
      t={t}
      {...(onOpenChild === undefined ? {} : { onOpenChild })}
      {...(instanceId === undefined ? {} : { instanceId })}
    />
  )
})
