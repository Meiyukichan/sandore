/**
 * M 层公共动作：用 mock LLM 造一个真实跑起来的 prompt 步实例。
 *
 * 这一层把「导入定义 → 开席位 → 真实 UI 建实例」的样板收敛到一处：
 * M1–M6 的差异只在**提示词里内嵌的 `[[e2e-mock …]]` 指令**与断言。
 *
 * @module e2e/fixtures/mock-run
 */
import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import {
  createInstanceFromUi, ensureDefinition, openSeat, switchListMode,
} from './harness.ts'
import { mockPromptWorkflow, mockThreePromptWorkflow, mockTwoPromptWorkflow, realPromptWorkflow } from './mock-workflows.ts'

/** 一次 mock 实例的句柄（供用例做 RPC/SSE 对账）。 */
export interface MockInstance {
  /** 运行实例 id（`listInstances` 反查得到）。 */
  readonly instanceId: string
  /** 定义名（UI 列表里显示的名字）。 */
  readonly definitionName: string
  /** prompt 步的定义 id（`executedSteps[].stepId` / 重试行 `data-step-chat-retry-step`）。 */
  readonly stepId: string
  /** 作业需求文本（本轮唯一）。 */
  readonly requirement: string
}

/**
 * 造一个 prompt 步实例并等 RunView 出现。
 *
 * 定义名/需求都带随机后缀：定义名唯一 → `importDefinitionFromYaml` 必然 `created`
 * （不同名不会命中 `skipped`），也避免与同 worker 内其它用例的定义互相干扰。
 *
 * @param page - 已就绪页面（harness 的 `page` fixture）。
 * @param options.promptText - Step 提示词（含 `mockDirective(...)`）。
 * @param options.cwd - 实例工作目录（用 `workspace` fixture 的临时目录）。
 * @param options.label - 定义名/需求的可读前缀（默认 `e2e-m`）。
 * @param options.stepExtraYaml - 追加到 `steps[]` 项末尾的 YAML 片段。
 * @returns 实例句柄。
 */
export async function createMockInstance(page: Page, options: {
  promptText: string
  cwd: string
  label?: string
  stepExtraYaml?: string
}): Promise<MockInstance> {
  const suffix = randomUUID().slice(0, 8)
  const definitionName = `${options.label ?? 'e2e-m'}-${suffix}`
  const definition = mockPromptWorkflow({
    name: definitionName,
    promptText: options.promptText,
    ...options.stepExtraYaml === undefined ? {} : { stepExtraYaml: options.stepExtraYaml },
  })
  await ensureDefinition(page, definition.yaml, definitionName)
  await openSeat(page)
  await switchListMode(page, '实例')

  const requirement = `${definitionName}-req`
  const instanceId = await createInstanceFromUi(page, {
    workflowName: definitionName,
    requirement,
    cwd: options.cwd,
  })
  return { instanceId, definitionName, stepId: definition.stepId, requirement }
}

/**
 * 造一个**两步 prompt** 实例（同 Stage 线性两步；**专供 M7② 的主代理卡片位置断言**）。
 *
 * 与 {@link createMockInstance} 的唯一差别是定义有两个 prompt 步（见
 * `mockTwoPromptWorkflow`）：第一步短 hold 很快 completed、第二步长 hold 保持 running，
 * 于是「主代理卡片紧跟**正在执行**的那条 step」可以被真正区分出来（不会与「贴在已完成
 * 那条后面」混淆）。
 * @param page - 已就绪页面。
 * @param options - 两步提示词 / cwd / 定义名前缀。
 * @returns 实例句柄 + 两步定义 id。
 */
export async function createMockTwoStepInstance(page: Page, options: {
  firstPromptText: string
  secondPromptText: string
  cwd: string
  label?: string
}): Promise<MockInstance & { readonly stepIds: readonly [string, string] }> {
  const suffix = randomUUID().slice(0, 8)
  const definitionName = `${options.label ?? 'e2e-m2step'}-${suffix}`
  const definition = mockTwoPromptWorkflow({
    name: definitionName,
    firstPromptText: options.firstPromptText,
    secondPromptText: options.secondPromptText,
  })
  await ensureDefinition(page, definition.yaml, definitionName)
  await openSeat(page)
  await switchListMode(page, '实例')

  const requirement = `${definitionName}-req`
  const instanceId = await createInstanceFromUi(page, {
    workflowName: definitionName,
    requirement,
    cwd: options.cwd,
  })
  return {
    instanceId,
    definitionName,
    // `stepId` 取第一步（多数断言用不到；两步都在 `stepIds` 里）。
    stepId: definition.stepIds[0],
    stepIds: definition.stepIds,
    requirement,
  }
}

/**
 * 造一个**三步 prompt** 实例（同 Stage 线性三步；**专供「主代理卡片全局唯一」取证**）。
 *
 * 与 {@link createMockTwoStepInstance} 的差别只在于 step 数量：两步只够区分「插在正在
 * 执行的那条之后」与「贴在已完成那条之后」；要证明（或证伪）「每个 step 下面都塞了一张
 * 主代理卡片」，需要 ≥3 个 step 都真实进入过 running/completed，才能把「全局 1 张」与
 * 「每步 1 张（= 3 张）」在计数上分开。
 * @param page - 已就绪页面。
 * @param options - 三步提示词 / cwd / 定义名前缀。
 * @returns 实例句柄 + 三步定义 id。
 */
export async function createMockThreeStepInstance(page: Page, options: {
  promptTexts: readonly [string, string, string]
  cwd: string
  label?: string
}): Promise<MockInstance & { readonly stepIds: readonly [string, string, string] }> {
  const suffix = randomUUID().slice(0, 8)
  const definitionName = `${options.label ?? 'e2e-m3step'}-${suffix}`
  const definition = mockThreePromptWorkflow({ name: definitionName, promptTexts: options.promptTexts })
  await ensureDefinition(page, definition.yaml, definitionName)
  await openSeat(page)
  await switchListMode(page, '实例')

  const requirement = `${definitionName}-req`
  const instanceId = await createInstanceFromUi(page, {
    workflowName: definitionName,
    requirement,
    cwd: options.cwd,
  })
  return {
    instanceId,
    definitionName,
    stepId: definition.stepIds[0],
    stepIds: definition.stepIds,
    requirement,
  }
}

/**
 * 造一个**真模型** prompt 步实例并等 RunView 出现（R 层专用）。
 *
 * 与 {@link createMockInstance} 的唯一差别：定义**不写** L1 路由 → prompt 步继承宿主
 * `agent-default-model`（真 provider）。其余流程（唯一化定义名 → 导入 → 打开席位 →
 * 建实例 → 拿 instanceId）完全一致，故 R 层与 M 层的页面侧断言可一一对应。
 *
 * @param page - 已就绪页面。
 * @param options.promptText - Step 提示词（**不要**内嵌 `[[e2e-mock …]]` 指令）。
 * @param options.cwd - 实例工作目录。
 * @param options.label - 定义名/需求前缀（默认 `e2e-r`）。
 * @returns 实例句柄。
 */
export async function createRealInstance(page: Page, options: {
  promptText: string
  cwd: string
  label?: string
}): Promise<MockInstance> {
  const suffix = randomUUID().slice(0, 8)
  const definitionName = `${options.label ?? 'e2e-r'}-${suffix}`
  const definition = realPromptWorkflow({ name: definitionName, promptText: options.promptText })
  await ensureDefinition(page, definition.yaml, definitionName)
  await openSeat(page)
  await switchListMode(page, '实例')

  const requirement = `${definitionName}-req`
  const instanceId = await createInstanceFromUi(page, {
    workflowName: definitionName,
    requirement,
    cwd: options.cwd,
  })
  return { instanceId, definitionName, stepId: definition.stepId, requirement }
}
