# 关键事项
- UI能够复用DSH就复用，不能复用就照着风格做成一模一样
- 引擎和后端尽量复用DSH组件
- 所有代码参考DSH的代码风格
- 不要创建分支，直接在main分支上开发
- 永远用中文回答
- DSH 源码路径 = `D:\projects-code\llm\sandore`
- 重要功能点，新增或者修改时，也需要新增或者修正对于的单元测试

# 仓库结构（单包 dsh-sandore）
- 本仓库 = 单个 npm 包 `dsh-sandore`（host 引擎 + client UI 双端合一，对齐 DSH-better-sidebar 的 bundle 模式），**不再是 monorepo**
- 源码目录：
  - `packages/microflow/` —— 引擎库（step-runner / branch-evaluator / finalize-manager / stage-executor 等，被 workflow import，非独立插件）
  - `packages/workflow/` —— host 引擎插件（DAG 导航、引擎、RPC、Schema/YAML；`index.ts` 为插件主入口）
  - `packages/tool/` —— `sandore_*` 模型工具（库，被 workflow import）
  - `packages/client/` —— client 半（TreeNav、RunView、DagEditor 等；经 `dsh.client` + `exports["./client"]` 被发现）
  - `packages/tests/` —— 测试 mocks / fixtures（spec 与被测源码同目录）
  - `packages/workflow/typert/` —— 手写固化 typert 产物（构建时拷贝到 `lib/`，勿改格式）
- 构建（`pnpm build`）：tsc 双编译图（`tsconfig.json` host → `lib/{microflow,workflow,tool}`；`tsconfig.client.json` client → `lib/client`，client 经 references 消费 host 产物类型，避免 client-runtime 与 dsh-session 的 `ctx.sessions` 类型污染）+ tsdown 多 bundle（`lib/index.js` / `lib/schema.js` / `lib/yaml.js` / `lib/yaml-error.js` / `lib/client.js`）+ typert 拷贝（`lib/typert.*`）。**无 `lib/types` 目录**：声明（.d.ts）与 tsc 的 .js 平铺在 `lib/` 对应子目录，发布面只带 bundle .js + `lib/**/*.d.ts`，不产 .map（tsconfig.base 关闭 sourceMap/declarationMap）
- 测试（`pnpm test`）：vitest，`packages/**/*.spec.ts`

# 安装与启动
- **本地测试/开发用 `--patch` 方式**（插拔显式、不碰 profile bundle 层）：
  `node --import tsx/esm D:\project-code\llm\deepseek-harness\apps\cli\src\bin.ts --profile web --patch D:\project-code\llm\sandore\cordis.yml --port 3090`，访问 http://127.0.0.1:3090
  - `cordis.yml` 为本地 dev overlay（insert `sandore` 行 + storage-sqlite + storage-domain 路由）；插件行 name `dsh-sandore` 经 profile 依赖（`dsh plugin --profile web add link:D:\project-code\llm\sandore` 安装的链接）或仓库内解析
  - 改代码 → `pnpm build` → 重启 dev 实例（3090）即可
- **发布形态走 bundle 通道**（`dsh plugin --profile web add dsh-sandore` 自动把 `dsh-sandore` 加入 `dsh.profile.bundles`，启动时 merge 本仓库 `cordis.patch.yml`；更新用 `update`，卸载用 `remove`）。**本地开发不要把它留在 bundles 层**——与 `--patch` 双挂载会起两个插件实例
- 生产实例（`dsh --profile web`，端口 3080）不加载 sandore 插件，保持干净
- 调插件配置直接编辑 `D:\project-code\llm\sandore\cordis.yml`（本地 overlay；bundle 通道对应 `cordis.patch.yml`）
- 若改动了 `~/.dsh/profiles/web/cordis.patch.yml`（生产层），会触发生产实例 HMR 重载、中断对话——不要往里插开发插件
