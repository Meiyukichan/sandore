# Spec: engine-seam — ctx.sandoreEngine Service seam

## ADDED Requirements

### Requirement: SandoreEngine 抽象类定义
`packages/sandore/workflow` SHALL 导出抽象类 `SandoreEngine extends Service`，构造函数以 `super(ctx, 'sandoreEngine')` 注册 service key，并通过 `declare module '@deepseek-ai/cordis'` 将 `sandoreEngine: SandoreEngine` 合并进 `Context` 接口。

#### Scenario: service key 注册
- **WHEN** 检查 `packages/sandore/workflow/src/index.ts`
- **THEN** 存在 `export abstract class SandoreEngine extends Service`，其构造函数调用 `super(ctx, 'sandoreEngine')`，且 `declare module '@deepseek-ai/cordis'` 块声明 `interface Context { sandoreEngine: SandoreEngine }`

### Requirement: 11 个实例级抽象方法
`SandoreEngine` SHALL 声明 11 个实例级抽象方法：`startInstance`/`recoverInstance`/`abortInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`/`getState`，签名与权威规格 `docs/design/task-1-skeleton/design.md` §5.1 一致。

#### Scenario: 方法清单完整
- **WHEN** 检查 `SandoreEngine` 的抽象方法列表
- **THEN** 恰好包含上述 11 个方法，签名与权威规格一致（如 `startInstance(request: DagStartRequest): DagRun`、`retryStep(instanceId: string, stepId: string, mode: 'continue'|'revert'|'fork', message: string): Promise<void>`、`getState(instanceId: string): DagInstanceState`）

#### Scenario: 无 permissionMode
- **WHEN** 检查 `DagStartRequest` 类型与 Provider 桩的 `static Config`
- **THEN** 二者均不含 `permissionMode` 字段（权限由宿主 Session permission preset 决定）

### Requirement: sandore/* 13 事件双声明
`sandore/*` 事件 SHALL 同时声明两套：Cordis `Events`（首参 `info: DagRunInfo`）与 Session `SessionEventMap`（纯数据载荷），均为 13 个事件：`sandore/start`、`sandore/stage-start`、`sandore/stage-completed`、`sandore/step-start`、`sandore/step-completed`、`sandore/step-failed`、`sandore/step-paused`、`sandore/step-resumed`、`sandore/step-retried`、`sandore/question`、`sandore/permission`、`sandore/end`、`sandore/aborted`。

#### Scenario: Cordis Events 声明
- **WHEN** 检查 `declare module '@deepseek-ai/cordis'` 的 `interface Events`
- **THEN** 13 个 `sandore/*` 事件均已声明，首参均为 `info: DagRunInfo`（如 `'sandore/step-completed'(info: DagRunInfo, stepId: string, childId: string, output: ContentBlock[]): void`）

#### Scenario: SessionEventMap 声明
- **WHEN** 检查 `declare module '@deepseek-ai/dsh-session/types'` 的 `interface SessionEventMap`
- **THEN** 13 个同名事件均已声明为纯数据载荷（如 `'sandore/step-completed': { stepId: string; childId: string; output: ContentBlock[] }`），无 `DagRunInfo` 首参包装

#### Scenario: 禁止的虚构事件不存在
- **WHEN** 检查两套事件声明
- **THEN** 不存在 `default-session-mounted` 事件（D9 修正）与 `user-message` 事件（用户消息由 DSH 原生承载）

#### Scenario: output 类型对齐 DSH 先例
- **WHEN** 检查 `sandore/step-completed` 的 `output` 字段
- **THEN** 其类型为 `ContentBlock[]`，`ContentBlock` 以 `import type { ContentBlock } from '@deepseek-ai/dsh-llm'` 引入（type-only）

### Requirement: 13 个基础类型定义
`packages/sandore/workflow` SHALL 导出 13 个基础类型：`DagRunInfo`/`DagStartRequest`/`DagRun`/`DagRunStatus`/`DagInstanceState`/`ExecutedStepDefault`/`StageInfo`/`StepStatus`/`StageContract`/`PendingQuestion`/`AskUserQuestionPayload`/`PendingPermission`/`DagResultInfo`，结构以权威规格 §5.3 为准。

#### Scenario: 类型可编译且被引用
- **WHEN** 执行 `pnpm run typecheck`
- **THEN** 13 个类型全部导出且被事件声明/抽象方法签名正确引用，无类型错误

### Requirement: 空 Provider 桩
`packages/sandore/workflow` SHALL 提供 default export 的空 Provider 桩（`extends SandoreEngine`），11 个方法为最小桩（抛不支持错误或返回占位值），带 schemastery `static Config`（`defaultTimeoutMs`/`maxConcurrentSteps`，无 `permissionMode`）与 `static inject`（`sessions`/`sessionPersistence`/`subagents`/`llm`/`shell`/`fs`/`storageDomain`）。

#### Scenario: Provider 桩可实例化
- **WHEN** 检查 Provider 桩类声明
- **THEN** 其 `extends SandoreEngine`、default export、`static Config` 用 schemastery 声明且无 `permissionMode`、`static inject` 覆盖 7 个 DSH 服务

### Requirement: microflow 与 tool 空占位
`packages/sandore/microflow` 与 `packages/sandore/tool` SHALL 各含 `package.json` + `tsconfig.json` 空占位（无业务源码），包名分别为 `@deepseek-ai/dsh-sandore-microflow`、`@deepseek-ai/dsh-sandore-tool`。

#### Scenario: 占位包结构
- **WHEN** 检查 `packages/sandore/microflow/` 与 `packages/sandore/tool/`
- **THEN** 各含 `package.json`（正确包名、`type: "module"`）与 `tsconfig.json`（extends 根 tsconfig.base.json），无 StageExecutor/StepRunner/模型工具实现
