# Task 1：工作流引擎 DSH 插件 — 骨架

实现 sandore DAG 工作流引擎（v2.6）作为 DeepSeek Harness (DSH) 插件的第一步：仓库脚手架（4 个包）+ Service Definition + 最小端到端链路。**仅做骨架，不做真实执行逻辑。**

## 必读（按优先级）
1. `docs/design/task-1-skeleton/design.md` —— Task 1 权威规格（精确的 Service 接口、13 个事件清单、13 个基础类型、Slot 注册代码、验证标准）
2. `docs/design/overall-design.md` —— 总体设计（包结构、命名约定、D1–D9 决策、持久化三表）
3. `docs/engine/dsh-workflow.md` —— 插件化核心设计（§1.3/§1.4 硬约束、§3 插件机制、§5.1/§5.1A、§5.4、§6.1、§10.2 决策汇总）
4. DSH 源码 `D:\project-code\llm\deepseek-harness` 参考：
   - `packages/workflow/workflow/src/index.ts` —— Service Definition 范式
   - `packages/workflow/tool-workflow/src/index.ts` —— Session 事件 append 范式
   - `packages/extensions/ui-cordis` —— footer 按钮 + 展开面板
   - `packages/client/ui-workflow-run` —— `conversation.chat.node` keyed（D8 讨论面板）
   - `packages/session/session-persistence` / storageDomain 用例 —— `ctx.storageDomain.open(spec)` 范式

## 硬约束（不可违反）
- **纯插件，不改任何 DSH 源码**（要分发给其他 DSH web 用户）
- **零外部 Agent SDK**，引擎/后端全用 DSH 的 `ctx.*` 服务
- UI 能复用 DSH 就复用（`ui-primitives`/theme/locale/标准 hook），不能复用就照着 DSH 风格自绘

## 命名空间（D1）
| 概念 | 命名 |
|---|---|
| Service key | `ctx.sandoreEngine`（`abstract class SandoreEngine extends Service`，`super(ctx, 'sandoreEngine')`） |
| 事件前缀 | `sandore/*`（**Session 事件**：`session.append('sandore/…', data)` + `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`；不是纯 `ctx.emit`） |
| 模型工具 | `sandore_*`（下划线，Task 1 不实现，仅约定） |
| RPC 方法 | `sandore.*`（点号，Task 1 最小 `sandore.ping`） |
| Host 包 | `@deepseek-ai/dsh-sandore-workflow` / `@deepseek-ai/dsh-sandore-microflow` / `@deepseek-ai/dsh-sandore-tool` |
| 前端包 | `@deepseek-ai/dsh-client-ui-sandore` |

## 依赖来源（关键约定）
- `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 是 **npm public scope**（DSH 公测已开放 npm 插件生态，当前版本 `0.1.0-rc.5`）。各包用 **peerDependencies 声明**（版本 `0.1.0-rc.5`），开发/安装时从 npm 解析，**不用 `file:`/`link:` 指向本地 DSH 源码**（DSH 源码仅作参考阅读）。
- `workflow` 包 peerDependencies：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-session`（SessionEventMap 声明合并）、`@deepseek-ai/dsh-llm`（`ContentBlock` 类型）、`@deepseek-ai/dsh-typert-protocol`（`TypertRemoteService`/`Remote`）、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-storage`（后两者后续 Task 用）
- `ContentBlock` 类型：`import type { ContentBlock } from '@deepseek-ai/dsh-llm'`（type-only，无运行时依赖；DSH 先例 `dsh-workflow` 的 `output: ContentBlock[]`）

## 产出（根 monorepo 工作区 + 4 个包）
0. **根 monorepo 工作区**（前置条件，仓库当前 greenfield，无 package.json）：
   - 根 `package.json`（`private: true`、`packageManager: pnpm@11.7.0`、`engines node >=22`、scripts `typecheck`/`build`、devDependencies `typescript`/`tsdown`/`tsx`）
   - `pnpm-workspace.yaml`（`packages: ['packages/sandore/*']`）+ `tsconfig.base.json`（各包 extends）
1. `packages/sandore/workflow/`：**seam + Provider 桩 + RPC**（三者合一）
   - 抽象类 `SandoreEngine extends Service`，11 个实例级方法：`startInstance/recoverInstance/abortInstance/replyQuestion/replyPermission/pauseStep/resumeStep/pauseAllSteps/resumeAllSteps/retryStep/getState`
   - `sandore/*` 事件声明两套：Cordis `Events`（`info: DagRunInfo` 作首参，可选触发源）+ Session `SessionEventMap`（纯数据载荷，必需）
   - 类型（13 个，见 design.md §5.3）：`DagRunInfo/DagStartRequest/DagRun/DagRunStatus/DagInstanceState/ExecutedStepDefault/StageInfo/StepStatus/StageContract/PendingQuestion/AskUserQuestionPayload/PendingPermission/DagResultInfo`
   - 空 Provider 桩（`export default class ... extends SandoreEngine`，`static Config` 用 schemastery，`inject` 声明 `sessions/subagents/llm/shell/fs/storageDomain` 等）
   - 最小 RPC：`remote.ts` 用 **`TypertRemoteService + @Remote`（生产范式）**——`class SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')` + `@Remote('ping')` → 端点 `sandore.ping`；`harness.handle` 仅作动态原型验证捷径（`cordis_define`/`cordis_run`），**不进入 Task 1 产出**
2. `packages/sandore/microflow/`：空目录占位（package.json + tsconfig），后续 Task 填充 `StageExecutor`/`StepRunner`（运行时 `workflow → microflow`，`microflow → workflow` 仅 `import type`）
3. `packages/sandore/tool/`：空目录占位（package.json + tsconfig），后续 Task 填充 `sandore_*` 模型工具
4. `packages/sandore/ui/`：Client 插件，注册 `sidebar.footer.action`（工作流按钮，设置上方）+ 点击展开 WorkflowPanel 占位；`host.call('sandore.ping')` 往返

## 事件清单（13 个 `sandore/*`，Task 1 需全部声明）
```
sandore/start  sandore/stage-start  sandore/stage-completed
sandore/step-start  sandore/step-completed  sandore/step-failed
sandore/step-paused  sandore/step-resumed  sandore/step-retried
sandore/question  sandore/permission  sandore/end  sandore/aborted
```

关键点：
- `step-start`/`step-completed`/`step-failed`/`step-paused`/`step-resumed` 增补 `childId`（子代理 SessionId）；`step-completed` 增补 `output: ContentBlock[]`（`finalAssistantOutput` 子代理最终结果，内联展示用，类型来自 `@deepseek-ai/dsh-llm`）
- **D9 修正**：**无 `default-session-mounted` 事件**（宿主 Session 在 `completed` 后自然延续为自由对话，不额外挂载默认会话）
- **无 `user-message` 事件**（用户消息由 DSH 原生 turn/message 承载，讨论面板里 DSH 原生渲染）
- Session 事件（`session.append` + `SessionEventMap`）是**必需**的（驱动 D8 讨论面板折叠 + apiproxy 透传）；Cordis `Events` 声明是引擎内部可选触发源，不能替代 Session 事件

## UI 入口（D6）
工作流入口 = `sidebar.footer.action` 按钮（该 slot 在工作区下方、设置上方，是纯插件能插入的唯一合适位置）+ 点击展开 WorkflowPanel（仿 workspace 风格，ui-primitives 自绘，含「编排」toggle +「新增」按钮 + 三态列表占位）。**不要**用 `conversation.view` tab 作为主入口（D6 已收敛放弃）。

## 权限与持久化（背景，Task 1 不实现，仅约定）
- **无 `permissionMode`**：权限由宿主 Session 的 permission preset（`sandbox/mode` + `approval/policy`）决定，Step 子代理继承父级、approval 固定 `never`。`static Config` 与 `DagStartRequest` 里**不要**加 permissionMode 字段。
- **持久化 `sandore` 域三表**：`definitions`（key=workflowId）/`jobs`（key=jobId）/`state`（key=instanceId）——SQLite 两张表 + YAML 定义文件 + jobs.json 迁入 storageDomain（D4）。Task 1 不实现，仅作类型/约定背景。

## 验证标准（Task 1 完成门槛）
- `pnpm run typecheck` 通过；根 monorepo 工作区 + 4 个包目录/package.json 正确
- `ctx.sandoreEngine` 抽象类（11 方法）+ `sandore/*` 13 事件（Cordis `Events` + Session `SessionEventMap`）声明正确，`output: ContentBlock[]` 类型对齐
- 挂载后 sidebar 设置上方出现「工作流」按钮；点击展开 WorkflowPanel
- `host.call('sandore.ping')` 往返 JSON 正常
- 无对 DSH 源码的任何修改

先读 `task-1-skeleton/design.md` 全文，再开始实现。
