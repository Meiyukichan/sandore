/**
 * e2e 工作流 fixture（无 LLM，F 层）。
 *
 * 与 `packages/tests/fixtures/test-workflow.yaml` 并列：
 * - `packages/tests/fixtures/test-workflow.yaml`：**M/R 层**用（含 5 个 prompt 步 + 循环 +
 *   分支 + secondary 门禁；prompt 步需要 mock/真模型才会产生真实子代理会话）。
 * - 本文件：**F 层**用（纯 shell 步，不建子代理、不花 token、秒级完成），用于验证
 *   页面加载 / 席位 / 列表 / 导入 / 建实例 / running / 完成 / 中止 / SSE 对账等
 *   「无 LLM 也能成立」的契约。
 *
 * ## 路由语义（写 fixture 前必读）
 * `branches[].next` **只在同一个 Stage 内生效**（`microflow/step-navigator.ts` 的
 * `sameStageStep`）；跨 Stage 推进必须由**阶段级** `branches[].next` 声明。
 * Stage 内多步按 `stages[].steps[]` 数组顺序线性兜底（`arrayNextStep`）。
 * 早期版本把跨 Stage 目标写在 Step 级分支上 → 第二步永远不会执行（F3 用例曾因此假红）。
 *
 * ## 导入幂等
 * `importDefinitionFromYaml` 默认 `matchBy:'name'`，命中/新建都走 `createDefinition`
 * → 落库键是 `wfl-{uuid}`（**不是** YAML 顶层 id）。同一 DSH_HOME 内**同名同版本**
 * 重放返回 `skipped`（幂等）；改了本文件的 YAML 内容就要 bump `FIXTURE_VERSION`。
 *
 * ## 命名空间
 * 定义名全部前缀 `e2e-f-`，避免与 dev 数据 / 其他层 fixture 撞名。
 */

/**
 * F 层定义版本。
 *
 * 导入默认按 name 匹配：**同版本**重放返回 `skipped`（幂等）；改了 fixture YAML
 * 就要同步 bump 这里，否则宿主会跳过更新。
 */
export const FIXTURE_VERSION = '1.0.0'

/** 快速定义 id（YAML 顶层 id；落库键由 host 生成，见文件头「导入幂等」）。 */
export const FAST_WORKFLOW_ID = 'wfl-e2e-f-fast-001'
/** 慢速定义 id。 */
export const SLOW_WORKFLOW_ID = 'wfl-e2e-f-slow-001'
/** 长链定义 id（时间线窗口用例）。 */
export const CHAIN_WORKFLOW_ID = 'wfl-e2e-f-chain-001'

/** 定义名（UI 断言 + 幂等导入的匹配键）。 */
export const FAST_WORKFLOW_NAME = 'e2e-f-fast'
/** 慢速定义名。 */
export const SLOW_WORKFLOW_NAME = 'e2e-f-slow'
/** 长链定义名。 */
export const CHAIN_WORKFLOW_NAME = 'e2e-f-chain'

/** 快速定义首个 shell 步的输出标记（用于「shell 输出可见」断言）。 */
export const FAST_ECHO_MARKER = 'hello-e2e-f'

/** 慢速定义总睡眠秒数（够 running 断言 + 中止，且不拖长整轮）。 */
const SLOW_SLEEP_SECONDS = 40

/**
 * 快速定义 YAML：两个 shell 步（echo 两段文本），跨 Stage 线性推进。
 *
 * stage1 内单步 → 阶段级分支推进到 stage2 → stage2 执行第二步，共 2 个 step 卡片。
 */
export const FAST_WORKFLOW_YAML = `id: ${FAST_WORKFLOW_ID}
name: ${FAST_WORKFLOW_NAME}
version: ${FIXTURE_VERSION}
stages:
  - id: stg-f-fast-1
    name: main
    steps:
      - id: stp-f-fast-1
    branches:
      - next: stg-f-fast-2
  - id: stg-f-fast-2
    name: tail
    steps:
      - id: stp-f-fast-2
steps:
  - id: stp-f-fast-1
    name: shell-echo
    command:
      type: shell
      value:
        command: echo ${FAST_ECHO_MARKER}
  - id: stp-f-fast-2
    name: shell-second
    command:
      type: shell
      value:
        command: echo second-e2e-f
`

/**
 * 慢速定义 YAML：首个 shell 步 `sleep 40s`（powershell `Start-Sleep`），第二步 echo。
 *
 * 用于：
 * - running 态断言（timeline `运行中…` + `[data-sandore-disc-input]` 的「暂停/中止」按钮）；
 * - **能力边界显式断言**：running 期间 `[data-step-chat]` 计数必须为 0
 *   （内嵌会话区只在**真实子代理 step** 的 running/paused 挂载，shell 步是合成会话 → 不挂载）；
 * - 中止（`aria-label="中止"`）→ 状态 `已中止`。
 */
export const SLOW_WORKFLOW_YAML = `id: ${SLOW_WORKFLOW_ID}
name: ${SLOW_WORKFLOW_NAME}
version: ${FIXTURE_VERSION}
stages:
  - id: stg-f-slow-1
    name: main
    steps:
      - id: stp-f-slow-1
    branches:
      - next: stg-f-slow-2
  - id: stg-f-slow-2
    name: tail
    steps:
      - id: stp-f-slow-2
steps:
  - id: stp-f-slow-1
    name: shell-sleep
    command:
      type: shell
      value:
        command: powershell -NoProfile -Command "Start-Sleep -Seconds ${SLOW_SLEEP_SECONDS}"
  - id: stp-f-slow-2
    name: shell-after
    command:
      type: shell
      value:
        command: echo done-after-sleep
`

/** 长链定义的阶段数（= step 数），大于默认窗口（5）以触发「加载更早」。 */
export const CHAIN_STAGE_COUNT = 7

/**
 * 长链定义 YAML：**7 个 Stage × 1 个 shell 步**，阶段级分支线性串联。
 *
 * 用于外层时间线窗口策略：执行完成后 timeline 有 7 个 step 卡片，超过默认
 * `TIMELINE_MAX_STEPS=5` → 顶部出现「加载更早」，点一次扩窗一页（+5）。
 * 用固定窗口构造（而非依赖真实长会话）保证秒级 + 确定性。
 */
export const CHAIN_WORKFLOW_YAML = (() => {
  const stageBlocks: string[] = []
  const stepBlocks: string[] = []
  for (let index = 1; index <= CHAIN_STAGE_COUNT; index += 1) {
    const branch = index < CHAIN_STAGE_COUNT ? `    branches:\n      - next: stg-f-chain-${index + 1}\n` : ''
    stageBlocks.push(`  - id: stg-f-chain-${index}\n    name: stage-${index}\n    steps:\n      - id: stp-f-chain-${index}\n${branch}`)
    stepBlocks.push(`  - id: stp-f-chain-${index}\n    name: shell-chain-${index}\n    command:\n      type: shell\n      value:\n        command: echo chain-${index}\n`)
  }
  return `id: ${CHAIN_WORKFLOW_ID}
name: ${CHAIN_WORKFLOW_NAME}
version: ${FIXTURE_VERSION}
stages:
${stageBlocks.join('')}steps:
${stepBlocks.join('')}`
})()

/**
 * 分层挂接说明（供 M/R 层复用本 harness）。
 *
 * - **F（本文件）**：纯 shell 步，零 token；覆盖桌面 UI 契约（席位/列表/导入/建实例/
 *   生命周期/SSE 对账/时间线窗口）。
 * - **M**：挂 mock LLM adapter（`ctx.llm.registerAdapter(['e2e-mock'], adapter)` 的本地
 *   Cordis 插件 + 临时 profile 的 `cordis.patch.yml` insert），用 prompt 步覆盖
 *   `[data-step-chat]` 内嵌会话 / @step / 重试三模式 / 暂停恢复 —— 这些在 shell 步上
 *   **不可能挂载**（见 harness 的 `[data-step-chat] === 0` 断言）。
 * - **R**：真模型，gate `SANDBORE_E2E_REAL=1`（与 vitest 侧
 *   `packages/workflow/workflow-engine-real-e2e.spec.ts` 同名约定），用
 *   `packages/tests/fixtures/test-workflow.yaml`。
 */
export const LAYER_NOTES = {
  fast: 'e2e/fixtures/workflows.ts（shell 步，零 token）',
  mock: 'packages/tests/fixtures/test-workflow.yaml + 本地 mock LlmAdapter 插件（挂临时 profile）',
  real: 'SANDBORE_E2E_REAL=1 + test-workflow.yaml + ~/.dsh/.credentials.yaml',
} as const
