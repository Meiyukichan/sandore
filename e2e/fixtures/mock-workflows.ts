/**
 * M 层工作流 fixture（**mock LLM**：prompt 步 → 真实子代理会话）。
 *
 * 与 `workflows.ts`（F 层，纯 shell 步）并列：
 * - F 层 shell 步**不建子代理**，`[data-step-chat]` 永不挂载；
 * - M 层的 prompt 步经 `ctx.subagents.startContinuable` 建**真实可续接子代理**，
 *   Step 运行/暂停/失败期间挂载内嵌会话面板 —— 这是 M1–M6 的被测对象。
 *
 * ## 模型路由：L1 显式指定（不依赖宿主默认）
 * `microflow/internal.ts resolveProviderModel` 的三层回退：
 * L1 Step 定义 `value.providerId` + `value.modelId`（**成对**才生效）→
 * L2 实例 `modelSelection` / 引擎默认 → L3 `llm.listProviders()[0]` + `listModels()[0]`。
 * 这里用 **L1**：真实、显式、与宿主 profile 解耦（临时 home 里没有任何真 provider 凭据）。
 *
 * ## mock 行为由**提示词内嵌指令**控制
 * `[[e2e-mock …]]`（见 `harness.ts` 的 `mockDirective()` 与 `e2e/mock-llm/index.js`）：
 * 同一 boot 实例（worker-scoped，`workers: 1`）内不同用例需要不同模型行为，所以指令
 * 随每个定义的 `promptText` 走，天然按用例隔离。
 *
 * ## 导入幂等
 * `importDefinitionFromYaml` 默认 `matchBy:'name'`：**同名同版本**重放 `skipped`。
 * 因此每个用例用 {@link mockPromptWorkflow} 生成**名字带短 hash 的定义**（名字里可以
 * 带随机后缀），从根本上避开「改 fixture 忘了 bump 版本」的坑。
 *
 * ## 命名空间
 * 定义名一律前缀 `e2e-m-`，与 F 层（`e2e-f-`）、dev 数据互不撞名。
 */

/** M 层定义版本（同一 name 复用时改内容需 bump）。 */
export const M_FIXTURE_VERSION = '1.0.0'

/** 生成一个「单 prompt 步」定义的 YAML（L1 路由到 mock provider）。 */
export interface MockPromptSpec {
  /** 定义名（UI 里选中的就是它；确保本轮唯一）。 */
  readonly name: string
  /** Step 提示词（可内嵌 `[[e2e-mock …]]` 行为指令）。 */
  readonly promptText: string
  /**
   * 是否写 L1 路由（`providerId`/`modelId` → mock provider）；默认 `true`。
   * R 层真模型用例传 `false`：不写这两行 → 继承宿主 `agent-default-model`（真 provider）。
   */
  readonly withRoute?: boolean
  /** Step 显示名（默认 `prompt-mock`）。 */
  readonly stepName?: string
  /** 定义版本（默认 `M_FIXTURE_VERSION`）。 */
  readonly version?: string
  /**
   * 追加的原始 YAML 片段（缩进已就位的 `steps[]` 项字段，如 `outputTo`）。
   * 留空即最简 prompt 步。
   */
  readonly stepExtraYaml?: string
}

/** 由定义名派生稳定短 id 片段（同 name → 同 id，跨轮可重复导入）。 */
function idOf(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) % 0xffff_ffff
  return hash.toString(16).padStart(8, '0')
}

/** mock provider 路由 id（与 `harness.ts` 的 `MOCK_PROVIDER` 同值；此处独立导出避免循环依赖）。 */
const PROVIDER = 'e2e-mock'
/** mock model id（与 `harness.ts` 的 `MOCK_MODEL` 同值）。 */
const MODEL = 'mock-1'

/**
 * 生成「单 Stage × 单 prompt 步」的工作流定义 YAML。
 *
 * 结构最小化（一个 Stage 一个 Step，无分支）：Step 完成 → 实例 completed。这样
 * `[data-step-chat]` 的 running 窗口（M1/M5）与 failed 态（M6）都由**模型行为**决定，
 * 不受 DAG 路由干扰。
 * @param spec - 见 {@link MockPromptSpec}。
 * @returns 可直接喂给 `importDefinitionFromYaml` 的 YAML 文本。
 */
export function mockPromptWorkflow(spec: MockPromptSpec): { yaml: string; name: string; stepId: string } {
  const id = idOf(spec.name)
  const stepId = `stp-e2e-m-${id}`
  const yaml = `id: wfl-e2e-m-${id}
name: ${spec.name}
version: ${spec.version ?? M_FIXTURE_VERSION}
stages:
  - id: stg-e2e-m-${id}
    name: main
    steps:
      - id: ${stepId}
steps:
  - id: ${stepId}
    name: ${spec.stepName ?? 'prompt-mock'}
    command:
      type: prompt
      value:
        promptText: ${JSON.stringify(spec.promptText)}${
    spec.withRoute === false ? '' : `
        providerId: ${PROVIDER}
        modelId: ${MODEL}`}
${spec.stepExtraYaml ?? ''}`
  return { yaml, name: spec.name, stepId }
}

/**
 * 生成一个「单 prompt 步」定义的 YAML（**不写 L1 路由** → 继承宿主默认模型）。
 *
 * R 层（真模型）专用：真 provider 由临时 home 的 `settings.yaml` 的
 * `agent-default-model` 决定（harness 在 `SANDBORE_E2E_REAL=1` 时写入 + 复制生产凭据）。
 *
 * @param spec - 与 {@link mockPromptWorkflow} 同形（`withRoute` 恒为 false）。
 * @returns 可直接喂给 `importDefinitionFromYaml` 的 YAML 文本。
 */
export function realPromptWorkflow(spec: Omit<MockPromptSpec, 'withRoute'>): { yaml: string; name: string; stepId: string } {
  return mockPromptWorkflow({ ...spec, withRoute: false })
}

/** {@link mockTwoPromptWorkflow} 的入参。 */
export interface MockTwoPromptSpec {
  /** 定义名（确保本轮唯一）。 */
  readonly name: string
  /** 第一步的提示词（通常短 hold → 很快 completed）。 */
  readonly firstPromptText: string
  /** 第二步的提示词（通常长 hold → 保持 running，供「卡片紧跟正在执行的 step」断言）。 */
  readonly secondPromptText: string
  /** 定义版本（默认 `M_FIXTURE_VERSION`）。 */
  readonly version?: string
}

/**
 * 生成「同 Stage × 两个 prompt 步」的定义 YAML（**专供 M7② 的主代理卡片位置断言**）。
 *
 * 为什么需要它：真机验收的 bug 是「主代理卡片落到了**已完成**的 step 上」，要在线性用例里
 * 复现「列表里同时存在一条 completed、一条 running」的现场：
 * - 两步放在**同一个 Stage**（`stages[].steps[]` 数组顺序线性兜底，见 `workflows.ts` 的
 *   路由语义说明）⇒ 第一步先跑完（completed）、第二步紧接着跑（running）；
 * - 于是「主代理卡片必须紧跟**正在执行**的那条（第二条）」与「不能夹在两条之间 /
 *   不能贴在已完成那条之后」成为**可区分**的断言。
 * L1 路由与 {@link mockPromptWorkflow} 一致（mock provider，两个 prompt 步都用）。
 * @param spec - 见 {@link MockTwoPromptSpec}。
 * @returns YAML + 两个 step 定义 id。
 */
export function mockTwoPromptWorkflow(spec: MockTwoPromptSpec): {
  yaml: string
  name: string
  stepIds: readonly [string, string]
} {
  const id = idOf(spec.name)
  const firstId = `stp-e2e-m2a-${id}`
  const secondId = `stp-e2e-m2b-${id}`
  const yaml = `id: wfl-e2e-m2-${id}
name: ${spec.name}
version: ${spec.version ?? M_FIXTURE_VERSION}
stages:
  - id: stg-e2e-m2-${id}
    name: main
    steps:
      - id: ${firstId}
      - id: ${secondId}
steps:
  - id: ${firstId}
    name: prompt-first
    command:
      type: prompt
      value:
        promptText: ${JSON.stringify(spec.firstPromptText)}
        providerId: ${PROVIDER}
        modelId: ${MODEL}
  - id: ${secondId}
    name: prompt-second
    command:
      type: prompt
      value:
        promptText: ${JSON.stringify(spec.secondPromptText)}
        providerId: ${PROVIDER}
        modelId: ${MODEL}
`
  return { yaml, name: spec.name, stepIds: [firstId, secondId] }
}

/** {@link mockThreePromptWorkflow} 的入参。 */
export interface MockThreePromptSpec {
  /** 定义名（确保本轮唯一）。 */
  readonly name: string
  /** 三步的提示词（通常前两步短 hold → 很快 completed，第三步长 hold → 保持 running）。 */
  readonly promptTexts: readonly [string, string, string]
  /** 定义版本（默认 `M_FIXTURE_VERSION`）。 */
  readonly version?: string
}

/**
 * 生成「同 Stage × 三个 prompt 步」的定义 YAML（**专供「主代理卡片全局唯一」取证/护栏**）。
 *
 * 为什么需要三步：真机反馈怀疑「每个 step 下面都被塞了一张主代理卡片」。要证伪/证实这个
 * 现象，必须让**多个** step 都真实进入过 running/completed（多于一处潜在插入点），再统计
 * `[data-tl-main-agent]` 的全局计数与每张 step 卡片内的计数——两步不够，三步才能让
 * 「每步一张」与「全局一张」在计数上明显区分（1 vs 3）。
 * L1 路由与 {@link mockTwoPromptWorkflow} 一致（mock provider）。
 * @param spec - 见 {@link MockThreePromptSpec}。
 * @returns YAML + 三个 step 定义 id。
 */
export function mockThreePromptWorkflow(spec: MockThreePromptSpec): {
  yaml: string
  name: string
  stepIds: readonly [string, string, string]
} {
  const id = idOf(spec.name)
  const ids = [`stp-e2e-m3a-${id}`, `stp-e2e-m3b-${id}`, `stp-e2e-m3c-${id}`] as const
  const names = ['prompt-one', 'prompt-two', 'prompt-three'] as const
  const steps = ids.map((stepId, index) => `  - id: ${stepId}
    name: ${names[index]!}
    command:
      type: prompt
      value:
        promptText: ${JSON.stringify(spec.promptTexts[index]!)}
        providerId: ${PROVIDER}
        modelId: ${MODEL}
`).join('')
  const yaml = `id: wfl-e2e-m3s-${id}
name: ${spec.name}
version: ${spec.version ?? M_FIXTURE_VERSION}
stages:
  - id: stg-e2e-m3s-${id}
    name: main
    steps:
      - id: ${ids[0]}
      - id: ${ids[1]}
      - id: ${ids[2]}
steps:
${steps}`
  return { yaml, name: spec.name, stepIds: ids }
}
