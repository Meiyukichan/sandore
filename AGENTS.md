# 关键事项
- UI能够复用DSH就复用，不能复用就照着风格做成一模一样
- 引擎和后端尽量复用DSH组件
- 所有代码参考DSH的代码风格
- 不要创建分支，直接在main分支上开发
- 永远用中文回答
- DSH 源码路径 = `D:\project-code\llm\deepseek-harness` 或 `D:\projects-code\llm\deepseek-harness`，但禁止修改DSH源码
- 重要功能点，新增或者修改时，也需要新增或者修正对于的单元测试

# 仓库结构（单包 dsh-sandore）
- 本仓库 = 单个 npm 包 `dsh-sandore`（host 引擎 + client UI 双端合一，对齐 DSH-better-sidebar 的 bundle 模式），**不再是 monorepo**
- 源码目录：
  - `packages/microflow/` —— 引擎库（step-runner / branch-evaluator / finalize-manager / stage-executor 等，被 workflow import，非独立插件）
  - `packages/workflow/` —— host 引擎插件（DAG 导航、引擎、RPC、Schema/YAML、`sandore_workflow*` 工具面；`index.ts` 为插件主入口）
  - `packages/client/` —— client 半（TreeNav、RunView、DagEditor 等；经 `dsh.client` + `exports["./client"]` 被发现）
  - `packages/tests/` —— 测试 mocks / fixtures（spec 与被测源码同目录）
  - `packages/workflow/typert/` —— 手写固化 typert 产物（构建时拷贝到 `lib/`，勿改格式）
- 工具面（`sandore_workflow*`，前缀统一）：`sandore_workflow`（定义 / Step 库 / Microflow 库读写）、`sandore_workflow_run`（唯一启动入口）、`sandore_workflow_status`、`sandore_workflow_send_message`、`sandore_workflow_control`（暂停/继续）——全局注册在 `packages/workflow/host-tools.ts`，execute 期 gate 仅顶层主代理会话
- 实例身份恒等式：`hostAgent.id ≡ 宿主会话 id ≡ instanceId（taskId）≡ 调用 sandore_workflow_run 的会话`（入口归一；无 `hostSessionId` 入参、无复用/新建分流）
- 构建（`pnpm build`）：tsc 双编译图（`tsconfig.json` host → `lib/{microflow,workflow}`；`tsconfig.client.json` client → `lib/client`，client 经 references 消费 host 产物类型，避免 client-runtime 与 dsh-session 的 `ctx.sessions` 类型污染）+ tsdown 多 bundle（`lib/index.js` / `lib/schema.js` / `lib/yaml.js` / `lib/yaml-error.js` / `lib/client.js`）+ typert 拷贝（`lib/typert.*`）。**无 `lib/types` 目录**：声明（.d.ts）与 tsc 的 .js 平铺在 `lib/` 对应子目录，发布面只带 bundle .js + `lib/**/*.d.ts`，不产 .map（tsconfig.base 关闭 sourceMap/declarationMap）
- 测试（`pnpm test`）：vitest，`packages/**/*.spec.ts`
