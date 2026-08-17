## Exploration Result

> 参考材料配置 `exploration.reference` 为空（`[]`）。DSH 参考仓库位于本机 `D:/project-code/llm/deepseek-harness`（即 monorepo 根，含 `tsdown.config.ts`、`tsconfig.host.json`、`packages/typert/generator`、`examples/web-cordis`、`packages/client/tsdown.client.ts`），sandore 目标仓库为 `D:/project-code/llm/sandore`。以下结果均来自对两仓库源码的直接读取。

### (1) DSH 的 tsdown + typert generator 构建管线精确机制

**根 `tsdown.config.ts`（workspace 模式）** — `D:/project-code/llm/deepseek-harness/tsdown.config.ts`：
- `workspace: ['vendor/*', 'packages/*/*', 'apps/cli']`（workspace 模式，tsdown 依次执行各包的包级 `tsdown.config.ts`）。
- `entry: client ? '' : ['lib/types/{index,invariant,startup}.js']`，`outDir: 'lib'`，`format: ['esm']`，`platform: 'node'`，`target: 'es2024'`，`fixedExtension: false`，`dts: false`，`clean: false`。
- 插件：`client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })]`。由 `--env.DSH_BUILD_FACE`（`host`/`client`）经 `isBuildFaceClient()` 判定。

**两阶段 build 脚本** — `D:/project-code/llm/deepseek-harness/package.json` 第 20–24 行：
- `build:lib:host` = `tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host`
- `build:lib:client` = `tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client`
- 即：**第一阶段** `tsc -b tsconfig.host.json` 先按 project references 逐包编译，emit `lib/types/*.js` + `lib/types/*.d.ts`（每包 `tsconfig.json` 为 `rootDir: "src"`、`outDir: "lib/types"`，如 `packages/core/session/tsconfig.json`）；**第二阶段** `tsdown` 从已 emit 的 `lib/types/*.js` 入口打包（包级 config 例：`packages/core/session/tsdown.config.ts` 的 `entry: ['lib/types/index.js']` → `outDir: 'lib'`），并在 `writeBundle` 阶段由 typert 插件从**源码**（以 `tsconfig.host.json` 为 program 种子）重新分析生成 `lib/typert.host.js/.d.ts` 与 `lib/typert.remote-client.js/.d.ts`。

**`typertPlugin` 实现** — `D:/project-code/llm/deepseek-harness/packages/typert/generator/src/tsdown-plugin.ts`：
- `transform` 钩子（第 43–59 行）：对含标准装饰器（正则 `DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m`，如 `@Remote`）的 `.ts/.tsx/.mts/.cts` 文件用 `ts.transpileModule` 降级为 ES2024/ESNext（含 ReactJSX）。
- `writeBundle` 钩子（第 60–88 行）：
  - `workspaceRoot(bundleOptions.dir)` 从 `options.dir`（包的绝对 `outDir`，即 `<package>/lib`）**向上查找第一个含 `tsconfig.host.json` 的目录**作为 workspace root（第 149–157 行）。
  - `mode: 'workspace'` 时走 `emitWorkspace(root, faces)`（第 91–100 行）：`new WorkspaceTypertGenerator(root).discover(faces)` → **按 `hasTypertExport(manifest.exports)` 过滤** → `generate(packages, faces)` → `emitArtifacts`。`hasTypertExport`（第 133–138 行）要求 exports 对象**含 `./typert` 或 `./client/typert` 或 `./remote` 任意一个键**。
  - 非 workspace（package 模式）走第 72–88 行：`packageRoot` 找最近 package.json，`hasTypertExport` 校验后只 emit 该包。
- `emitArtifacts`（第 103–124 行）：写 `lib/typert.{face}.js` 与 `lib/typert.{face}.d.ts`；若 `artifact.remote` 存在则写 `lib/typert.remote-client.js/.d.ts/.d.ts.map`；若无 remote 则 `rmSync` 清理旧的 remote-client 文件。

**`validateExport` 强制校验** — `D:/project-code/llm/deepseek-harness/packages/typert/generator/src/workspace.ts` 第 68–126 行：
- host face 要求 exports `./typert` = `{ types: './lib/typert.host.d.ts', default: './lib/typert.host.js' }`；client face 要求 `./client/typert` = `{ types: './lib/typert.client.d.ts', default: './lib/typert.client.js' }`。
- host 且有 remote 方法时要求 `./remote` = `{ types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' }`。
- 同时要求 `package.json#files` 数组包含对应 `lib/typert.{face}.js/.d.ts` 与 remote-client 文件；不满足即抛 `TypertAnalysisError`（`sameExport` 精确比对 types/default）。

### (2) 跨包导入重构的正确形态

**DSH 生产源码的显式包导入形态**（在 `D:/project-code/llm/deepseek-harness/packages` 下 grep `from '@deepseek-ai/dsh-.../`）：
- **wire 类型面用精确 `/types` 子路径（无扩展名）**，例：
  - `packages/api/remotes/src/client/index.ts`：`export type {} from '@deepseek-ai/dsh-commands/types'`、`export type { JsonValue } from '@deepseek-ai/dsh-session/types'` 等十余处。
  - `packages/client/connection/src/client/api.ts`：`export type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session/types'`。
  - `packages/client/runtime/src/client/sessions/conversation.ts`：`import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'`。
- **测试文件用 `/src/*.ts`（带 .ts 扩展名）**，例：`packages/core/tools/tests/ts-types.spec.ts` 的 `from '@deepseek-ai/dsh-tools/src/ts-types.ts'`。
- DSH 的源码级解析靠 `tsconfig.base.json#compilerOptions.paths`（`D:/project-code/llm/deepseek-harness/tsconfig.base.json` 第 32 行起）：把 `@deepseek-ai/dsh-xxx` → `./packages/xxx/src/index.ts`、`@deepseek-ai/dsh-xxx/types` → `./packages/xxx/src/types.ts`、`@deepseek-ai/dsh-xxx/client` → `./packages/xxx/src/client/index.ts` 等映射到源码（注释："Source-level resolution for every repo-local graph. Project references, not declaration path aliases, keep each package/vendor source compiled under its own tsconfig boundary"）。

**sandore 当前相对导入（需改）**：`D:/project-code/llm/sandore/packages/sandore/workflow/src/` 下 11 个文件的 `../../microflow/src/*`、`../../tool/src/*` 相对导入（行号已核对）：
1. `dag-navigator.ts` 13–16 行（`../../microflow/src/branch-evaluator.ts`、`../../microflow/src/loop-manager.ts`）
2. `errors.ts` 10–11 行（`../../microflow/src/errors.ts`）
3. `host-agent.ts` 12 行（`../../microflow/src/subagents.ts`）、13 行（`../../tool/src/index.ts`）
4. `host-agent.spec.ts` 9 行（`../../microflow/src/subagents.ts`）
5. `interaction-manager.ts` 16 行（`../../microflow/src/subagents.ts`）
6. `interaction-manager.spec.ts` 12 行（`../../microflow/src/subagents.ts`）
7. `lifecycle-manager.ts` 24 行（`../../microflow/src/subagents.ts`）
8. `recovery-manager.spec.ts` 10 行（`../../microflow/src/subagents.ts`）
9. `recovery-manager.ts` 29 行（`../../microflow/src/subagents.ts`）
10. `seam.ts` 13 行（`import type { Agent } from '../../microflow/src/subagents.ts'`）
11. `workflow-engine.ts` 50–54 行（`../../microflow/src/finalize-manager.ts`、`stage-executor.ts`、`step-runner.ts`、`subagents.ts`）

另：`tool/src/index.ts` 17–23 行用 `../../workflow/src/types.ts` 与 `../../workflow/src/engine-surface.ts`（反向 tool→workflow 的相对导入）。sandore `tsconfig.base.json` **无 `paths`**；microflow/tool/workflow 三个包的 `tsconfig.json` 均设 `rootDir: ".."`（`packages/sandore/microflow/tsconfig.json` 等），这是为让相对 `../../` 导入可编译的现状。`tsconfig.base.json` 已开 `allowImportingTsExtensions: true` + `rewriteRelativeImportExtensions: true`；根 `tsconfig.host.json` 额外置 `rewriteRelativeImportExtensions: false`。

### (3) `TypertAnalysisError: reference to Agent crosses a package or face without an explicit import` 的根因与修复

根因在 `D:/project-code/llm/deepseek-harness/packages/typert/generator/src/analyzer.ts` 的 `targetForReference`（第 2344–2418 行）：
- `moduleSpecifierOf(site)`（2978–3000 行）从源码 import 语句还原 import specifier；`moduleIdentity(specifier)`（3036–3046 行）对 **以 `.` 或 `/` 开头的 specifier 一律返回 `undefined`**（相对导入不产生 package 标识）。
- 当被引用符号 `Agent` 的声明文件不在当前 face 注册的任何包内（`registrationForFile(declaration)` 返回 `undefined`，第 2361 行 `owner === undefined`），且 `module === undefined`（相对导入），且 `externalModuleIdentityForFile` 也返回 undefined（声明文件不在 node_modules）时，落到第 2417 行：`this.fail(site, 'reference to Agent crosses a package or face without an explicit import')`。
- 具体触发链：sandore 根 `tsconfig.host.json` 的 `references` **只引用 `./packages/sandore/workflow`**（microflow/tool 未注册进 host face）；`seam.ts` 第 13 行 `import type { Agent } from '../../microflow/src/subagents.ts'`，`Agent` 声明于 `microflow/src/subagents.ts`（第 38 行 `export interface Agent`），通过 `UserQuestionsRequest.agent?`（seam.ts 110 行）进入类型图 → 命中上述分支。

修复语义（对应探索要求）：把相对导入改为显式包导入（如 `@deepseek-ai/dsh-sandore-microflow/src/subagents.ts`）后，`moduleIdentity` 返回 `{ package: '@deepseek-ai/dsh-sandore-microflow', subpath: './src/subagents.ts' }`，`module !== undefined`，在目标包未注册进任何 face 时返回 `{ kind: 'external' }`（2398–2405 行），不再报错。**注意**：若随后把 microflow 注册进同一 host face（`owner !== undefined` 且跨包），则走 2363–2370 行分支，`packageExportName`（2445–2461 行）要求 import subpath 与 `package.json#exports` **精确匹配**——`./src/*` 是通配符，`packageExportTargets`（2653–2672 行）不会展开，`find(subpath === module.subpath)` 匹配 `./src/subagents.ts` 会落空，届时需用精确 `./types` 等子路径（DSH 生产惯例）。

**佐证（sandore 构建当前未跑通）**：`D:/project-code/llm/sandore/packages/sandore/workflow/lib/typert.host.js` 是**占位 stub**（`schemas: [], invocations: [], model: { services: [], events: [] }`），文件内注释明写「本文件待 generator 跨包引用修复后重新生成为完整 FaceModel」；`lib/typert.host.d.ts` 仅 `export declare const TYPERT: unknown`。

### (4) wire 类型面拆分（remote.ts → ./types）

**当前 wire 类型的导出位置** — `D:/project-code/llm/sandore/packages/sandore/workflow/src/remote.ts`：
- 接口：`WorkflowDefinitionEntry`（24）、`JobEntry`（29）、`InstanceSummary`（34）、`ArtifactEntry`（44）、`PingResponse`（160）。
- 12 个 `z.infer` Input 类型（144–155 行）：`CreateDefinitionInput`/`UpdateDefinitionInput`/`CreateJobInput`/`UpdateJobInput`/`StartInstanceInput`/`ReplyQuestionInput`/`ReplyPermissionInput`/`PauseStepInput`/`ResumeStepInput`/`PauseAllInput`/`ResumeAllInput`/`RetryStepInput`。
- 这些类型目前**只从根 `.` 子路径导出**（`workflow/src/index.ts` 第 16 行 `export * from './remote.ts'`），未进 `./types` 子路径。

**为什么需要拆分到 `./types`**：
- workflow `package.json` 已有 `"./types": { "types": "./lib/types/types.d.ts", "default": "./lib/types/types.js" }`，对应源码 `workflow/src/types.ts`（当前仅含浏览器安全持久化词汇 + `./schema.ts` 重导出，无这些 RPC wire 类型）。
- 生成器 `publicRemoteType`（analyzer.ts 1768–1796 行）要求 Remote 边界引用的命名类型必须「exported from a public non-root type subpath」——它遍历 exports，**跳过 `.`、`./package.json`、`./typert`、`./client/typert`、`./remote` 与含 `*` 的 target**；找不到即 `fail`。因此这些 wire 类型需经 `./types` 子路径重导出（在 `src/types.ts` 中声明或 `export type { ... } from './remote.ts'` 即可，`resolveSymbol` 会解析到同一 symbol）。
- 生成的 `typert.remote-client.d.ts` 通过 `emitter.ts` 的 `renderRemoteDts`（331–396 行）以 `import type { PingResponse } from '@deepseek-ai/dsh-sandore-workflow/types'` 引用（`packageExportSpecifier` 拼装 `@deepseek-ai/dsh-sandore-workflow/types`）；`remoteBoundary.typeSymbol` 形如 `@deepseek-ai/dsh-sandore-workflow/types#PingResponse`（analyzer.ts 1399–1408 行）。
- **旧产物对照**：`workflow/lib/typert.remote-client.d.ts`（8 月 16 生成）把这些 wire 类型**内联展平**进 d.ts，且 `getInstanceState` 返回 `unknown`、`replyQuestion` 的 `answers` 为 `unknown`（因 `WorkflowTaskState`/`AskUserQuestionAnswer` 当时未从公开非根类型子路径导出）。

**DSH 范本**：`D:/project-code/llm/deepseek-harness/packages/api/remotes/src/types.ts` 是 type-only 的 wire 类型面（`@module @deepseek-ai/dsh-api-remotes/types`），经 `./types` 子路径导出；client 侧以 `@deepseek-ai/dsh-api-remotes/types` 消费（`src/client/index.ts` 第 19 行 `export type { ApiRemoteForwardedEvent } from '../types.ts'`）。

### (5) sandore workflow/microflow/tool 的 package.json exports 现状

- `D:/project-code/llm/sandore/packages/sandore/microflow/package.json`：exports = `.`（types→`lib/types/index.d.ts`、default→`lib/index.js`）、`./src/*`、`./package.json`。**未声明 `./types`**。
- `D:/project-code/llm/sandore/packages/sandore/tool/package.json`：exports = `.`、`./src/*`、`./package.json`。**未声明 `./types`**。
- `D:/project-code/llm/sandore/packages/sandore/workflow/package.json`：exports = `.`、`./types`、`./typert`（→`lib/typert.host.d.ts/.js`）、`./remote`（→`lib/typert.remote-client.d.ts/.js`）、`./schema`（→`src/schema.ts`）、`./yaml`（→`src/yaml-parser.ts`）、`./src/*`、`./package.json`；`files` 含 `lib/typert.host.js/.d.ts` 与 `lib/typert.remote-client.js/.d.ts`。
- `D:/project-code/llm/sandore/packages/sandore/ui/package.json`：exports = `.`、`./client`（types→`lib/types/client/index.d.ts`、default→`lib/client.js`）、`./src/*`、`./package.json`；含 `dsh.client`（`platform: 'web'` + `inject` 列表）。
- 根 `D:/project-code/llm/sandore/package.json`：devDependencies 含 `@deepseek-ai/dsh-typert-generator@0.1.0-rc.6`、`tsdown@^0.22.2`、`typescript@^6.0.3`、`vitest`；scripts `build`/`typecheck` 均为 `pnpm -r --if-present run ...`。仅 workflow 有 `"build": "tsdown"`；microflow/tool/ui 仅有 `"typecheck": "tsc --noEmit"`。

### (6) ui 包 clientBundle() 构建形态与 sandore ui 现状

**DSH `clientBundle` 辅助** — `D:/project-code/llm/deepseek-harness/packages/client/tsdown.client.ts`：
- `clientBundle(id, libEntry, options)`（93–109 行）返回 env 选择的多配置：`host` face 时若 `hostPhase === true` 才 emit Node 半，否则 `SKIP_WORKSPACE_BUILD = { entry: '' }`（跳过）；`client` face 时 emit `[...node, client]`；无 face 时 `[...node, client]`。
- Node 半 `clientLibraryConfig`（151–168 行）：`entry: libEntry`（如 `['lib/types/index.js', 'lib/types/invariant.js']`）、`outDir: 'lib'`、esm/node。
- Client 半 `clientConfig`（170–274 行）：`entry: { client: 'lib/types/client/index.js' }`（有 face）/`'src/client/index.ts'`（无 face）；`format: 'cjs'`、`platform: 'browser'`、`outDir: 'lib'`、`outputOptions.entryFileNames: 'client.js'`、`banner: window.__ModuleLoader__.load({ id, factory: (require) => {`、`footer: return module.exports; } });`、`intro: var module = { exports: {} }...`；`external: CLIENT_EXTERNALS`（平台模块表 + 运行时豁免）；`noExternal` 把非平台模块全部内联；含「client bundle purity」gate（禁止跨插件 value import，type-only 会擦除）+ CSS Modules inline（lightningcss）插件。
- 用法例：`D:/project-code/llm/deepseek-harness/packages/client/ui-conversation/tsdown.config.ts` = `export default clientBundle('@deepseek-ai/dsh-client-ui-conversation', ['lib/types/index.js', 'lib/types/invariant.js'])`；`packages/api/remotes/tsdown.config.ts` = `clientBundle('@deepseek-ai/dsh-api-remotes', [...], { hostPhase: true })`。

**sandore ui 现状**：`D:/project-code/llm/sandore/packages/sandore/ui/` **无 `tsdown.config.ts`**（仅 `package.json` + `tsconfig.json`，`tsconfig.json` 为 `rootDir: "src"`、`outDir: "lib/types"`、`jsx: "react-jsx"`）。`ui/src/index.ts` 是空 `apply()`（Host 半）；`ui/src/client/` 下是浏览器半（`WorkflowButton.tsx`、`WorkflowPanel.tsx`、`DagEditor.tsx`、`RunView.tsx`、`DagStepNodeView.tsx` 等）。`ui/src/client/remote.ts` 已用 `import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote'` + `export type { PingResponse } from '@deepseek-ai/dsh-sandore-workflow/remote'`，并暴露 `ctx.remote.$mount` 解包封装。

### (7) cordis.yml 格式

**DSH 范本** — `D:/project-code/llm/deepseek-harness/examples/web-cordis/cordis.yml`：
```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3081

- insert:
    - id: cordis-host-runner
      name: '@deepseek-ai/dsh-cordis-host-runner'
    - id: tool-cordis
      name: '@deepseek-ai/dsh-tool-cordis'
```
`insert:` 块元素为 `{ id, name: '@deepseek-ai/...', config? }`（config 可选）。

**sandore 目标静态组合** — `D:/project-code/llm/sandore/docs/design/task-5-frontend/design.md` §7.1（680–695 行）给出 `- insert:` 块四行：`workflow`（`@deepseek-ai/dsh-sandore-workflow` + `config.defaultTimeoutMs`）、`microflow`（`@deepseek-ai/dsh-sandore-microflow`）、`tool`（`@deepseek-ai/dsh-sandore-tool`）、`ui`（`@deepseek-ai/dsh-client-ui-sandore`）；§7.2 说明 `cordis_define`/`cordis_run` 是「动态 Cordis 插件机制」仅用于原型验证，非持久化挂载。

### (8) 动态插件原型残留的搜索点

在 sandore 全仓库（排除 `lib/` 产物）grep `cordis_define|cordis_run|host\.call|harness\.handle|\$mount|ctx\.remote` 的结果：
- **源码中无残留**：`host.call`/`harness.handle`/`cordis_define`/`cordis_run` 只出现在 docs 文档里，未进入 sandore `packages/*/src` 实现。
- 文档出处：`D:/project-code/llm/sandore/docs/engine/dsh-workflow.md`（141 行「动态插件（ctx.dynamicCordisRunner / cordis_define/cordis_run）…临时机制」、185/271/602/603/624/703/733/818/828/841 行的 `host.call()`/`harness.handle` 引用）；`docs/design/task-5-frontend/design.md` §6.0（518 行）、§7.2（703 行）、§6.1 等。这些 docs 均明确：`host.call('sandore.*')` / `harness.handle(method, handler)` 是 **Dynamic Plugin 机制（原型阶段）的 Package-private RPC**，生产用 Typert Remote 服务（`SandoreRemote extends TypertRemoteService` + `@Remote` → 生成 `./remote` 导出 → `ctx.remote.$mount`）。
- sandore 实际实现已走 Typert 范式：`workflow/src/remote.ts` 的 `SandoreRemote`（`super(ctx, 'sandore')` + `@Remote`）；client 消费在 `ui/src/client/remote.ts`（`import ... from '@deepseek-ai/dsh-sandore-workflow/remote'` + `ctx.remote.$mount(sandoreRemote)`，namespace = `sandore`）。

## Supplementary Exploration Result

无需补充探索。DSH 参考仓库（`D:/project-code/llm/deepseek-harness`）在本机可直接读取，上述 8 项已由本地源码完整覆盖（typert generator 的 analyzer/workspace/emitter/tsdown-plugin、根 tsdown.config.ts、tsconfig.base.json/host.json、`packages/api/remotes` 与 `packages/client/tsdown.client.ts` 范本、`examples/web-cordis/cordis.yml`，以及 sandore 侧 package.json/tsconfig/tsdown.config 与 `lib/` 现有构建产物）。`experimental.websearch`/`experimental.context7` 虽为 true，但 tsdown/typert 为 DSH 内部机制，外部检索不优于本地参考，故不补充。
