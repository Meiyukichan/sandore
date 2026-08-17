## Exploration Result

本阶段按 codebase.md 指令执行：`furina config show project.sourcecode codebases` 返回
`project.sourcecode=src/`、`codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`。
该 codebase 元素（`D:/project-code/llm/sandore/docs/codebase`）目录为空，故 Phase 3 无可调度内容，直接进入 Phase 4 补充探索。

补充探索的参考源码仓库为 `D:/project-code/llm/deepseek-harness`（DSH 官方 monorepo，只读）；sandore 现状位于 `D:/project-code/llm/sandore/packages/sandore/{workflow,microflow,tool,ui}`。

## Supplementary Exploration Result

### 需求理解（Phase 2）

- **What**：为 sandore 完成「挂载固化（cordis.yml 静态组合）」并让 typert 构建真正跑通。具体为：理解 DSH 的 tsdown + typert generator 构建管线精确机制（两阶段 `tsc -b` 先 emit `lib/types/*.d.ts`，再 `tsdown` bundle + typert 生成 `lib/typert.host.js`/`lib/typert.remote-client.js`）；workflow 包 11 个文件的跨包相对导入（`../../microflow/src/*`、`../../tool/src/*`）需重构为显式包导入；修复 seam.ts 的 `Agent` 跨包引用导致的 `TypertAnalysisError`；把 wire 类型拆到 `./types` 子路径；补齐 microflow/tool 的 `./types` 导出与 ui 的 `clientBundle()` 构建；确认 cordis.yml 的 `- insert:` 格式与动态插件原型残留的搜索点。
- **Boundaries**：(a) DSH 根 `tsdown.config.ts` + `packages/typert/generator` 的 `typertPlugin`/`WorkspaceTypertGenerator`/`WorkspaceAnalyzer`/`FaceModelEmitter` 全套管线；(b) DSH monorepo 显式包导入形态（`tsconfig.base.json` paths + package.json `./src/*`/`./types` 导出）；(c) sandore 四包 package.json exports 现状与 `lib/` 产物现状；(d) DSH `packages/client/tsdown.client.ts` 的 `clientBundle()`；(e) DSH `examples/web-cordis/cordis.yml` 与 sandore `design.md §7.1`；(f) sandore 源码中动态插件原型残留标识的分布。
- **Goal**：为「挂载固化 + typert 构建跑通」提供事实依据：管线机制、重构目标形态、错误根因、wire 类型拆分位置、各包 exports 现状缺口、ui 构建范式、cordis.yml 格式、残留清扫范围。
- **Project Context**：sandore 是 DSH（DeepSeek Harness）生态下的第三方插件仓库（4 包），运行在 `@deepseek-ai/cordis@4.0.1` DI 框架上；RPC 走 DSH 自研 Typert 协议（`@deepseek-ai/dsh-typert-protocol@0.1.0-rc.6`）；typert 构建依赖 `@deepseek-ai/dsh-typert-generator`（sandore 根 `package.json` 声明 `0.1.0-rc.6`）。

---

### (1) DSH 的 tsdown + typert generator 构建管线精确机制

**DSH 根构建脚本（两阶段）** — `D:/project-code/llm/deepseek-harness/package.json`：

```jsonc
"build:lib": "npm run build:lib:host && npm run build:lib:client",
"build:lib:host": "tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host",
"build:lib:client": "tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client",
```

- **阶段一**：`tsc -b tsconfig.host.json` 按 project references 递归编译各 composite 包项目，把 `src/**/*.ts` emit 成 `lib/types/**/*.js` + `lib/types/**/*.d.ts`。
- **阶段二**：`tsdown --env.DSH_BUILD_FACE host` 以 workspace 模式 bundle 各包（默认 entry 是 `lib/types/{index,invariant,startup}.js`），同时 typert 插件在 `writeBundle` 生成 `lib/typert.host.js/.d.ts` 与 `lib/typert.remote-client.js/.d.ts/.d.ts.map`。

**DSH 根 tsdown 配置** — `D:/project-code/llm/deepseek-harness/tsdown.config.ts`（完整 31 行）：

```ts
import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
```

- `workspace` glob 让 tsdown 遍历每个包；有包级 `tsdown.config.ts` 的包用它自己的配置（REPLACE 根默认），没有的用根默认 entry。
- host 面挂 `typertPlugin({ mode: 'workspace', faces: ['host'] })`，client 面不挂（`plugins: []`）。

**`typertPlugin` 实现** — `D:/project-code/llm/deepseek-harness/packages/typert/generator/src/tsdown-plugin.ts`：

- `transform(code, id)`（L43-59）：对依赖里含 `@` 装饰器语法的 `.ts/.tsx` 源用 `ts.transpileModule`（target ES2024 / module ESNext）降装饰器后交给 bundler。
- `writeBundle(options)`（L60-88）：
  - `options.dir` 是包 outDir（`<package>/lib`）；`workspaceRoot(bundleOptions.dir)`（L149-157）向上逐级找含 `tsconfig.host.json` 的目录作为 workspace 根。
  - `mode === 'workspace'` 时走 `emitWorkspace(root, faces)`（L91-100）：`new WorkspaceTypertGenerator(root)` → `generator.discover(faces)` → **按 `hasTypertExport(manifest.exports)` 过滤** → `generator.generate(packages, faces)` → 对每个 artifact 调 `emitArtifacts(join(root, artifact.packageRoot), [artifact])`。
- `hasTypertExport(exports)`（L133-138）：`exports` 对象含 `./typert`、`./client/typert` 或 `./remote` 任一即视为 typert 贡献者。
- `emitArtifacts(packageDir, artifacts)`（L103-124）：写 `lib/typert.<face>.js` + `lib/typert.<face>.d.ts`；有 `artifact.remote` 时再写 `lib/typert.remote-client.js` + `.d.ts` + `.d.ts.map`；若 host 面无 remote 方法则删除残留的 `typert.remote-client.*` 三文件。
- 包级模式（默认 `mode: 'package'`，未指定 mode 时）：`writeBundle` 找到当前包 `packageDir` 后，`generator.generate(undefined, faces)`（discover 全 workspace 的 face 贡献者）再 `filter(candidate => candidate.package === manifest.name)` 只 emit 本包。

**`validateExport` 强制校验** — `D:/project-code/llm/deepseek-harness/packages/typert/generator/src/workspace.ts` L68-126：

- host 面：`./typert` 必须为 `{ types: './lib/typert.host.d.ts', default: './lib/typert.host.js' }`；`files` 必须含 `lib/typert.host.js` + `lib/typert.host.d.ts`。
- host 面且有 remote 方法：`./remote` 必须为 `{ types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' }`；`files` 必须含 `lib/typert.remote-client.js` + `lib/typert.remote-client.d.ts`；若无 remote 方法却声明了 `./remote` 或 files 含 remote 产物则报错「publishes Remote artifacts but has no Remote methods」。
- 不满足则抛 `TypertAnalysisError: typert(<face>): <pkg> must export <subpath> as {...}`（或 files 缺失）。

**DSH 包级 tsconfig 形态**（composite + rootDir 'src' + outDir 'lib/types'）— 例 `D:/project-code/llm/deepseek-harness/packages/interaction/commands/tsconfig.json`：

```jsonc
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
  "include": ["src"],
  "references": [ { "path": "../../../vendor/cordis" }, { "path": "../../typert/protocol" }, ... ]
}
```

- `tsconfig.base.json`（DSH 根）带 `composite: true`/`incremental: true`，故 `tsc -b` 能经 references 构建；`rootDir: "src"` 保证 `src/index.ts` → `lib/types/index.js/.d.ts`（匹配 package.json 的 `types: "lib/types/index.d.ts"` 与 `./types` 子路径 `lib/types/types.d.ts`）。

**sandore 现状与 DSH 的差距（事实）**：

- sandore 根 `package.json`（`D:/project-code/llm/sandore/package.json`）只有 `typecheck`/`build`(`pnpm -r --if-present run build`)/`test`，**没有** `build:lib:host`（两阶段脚本未接入）。
- sandore 根**没有** `tsdown.config.ts`（只有 workflow 包级配置）。
- sandore `tsconfig.base.json` **没有** `composite`、**没有** `paths`；包级 tsconfig 用 `rootDir: ".."`（`packages/sandore/{workflow,microflow,tool}/tsconfig.json` 均为 `rootDir: ".."`、`outDir: "lib/types"`），与 DSH 的 `rootDir: "src"` 不一致（按 `..` 会 emit 出 `lib/types/workflow/src/...` 之类路径，不匹配 `lib/types/index.d.ts`）。
- sandore `tsconfig.host.json` 仅 `references: [{ "path": "./packages/sandore/workflow" }]` 且 `noEmit: true`（microflow/tool 未列入 host face）。
- sandore `workflow/tsdown.config.ts` 是包级配置：入口直接 bundle `src/index.ts`（不是 `lib/types/index.js`），`plugins: [typertPlugin({ faces: ['host'] })]`（未写 mode，即 package 模式），第二个配置 bundle `src/schema.ts` + `src/yaml-parser.ts`（platform neutral）。
- 当前 `packages/sandore/workflow/lib/` 仅有 `index.js`、`typert.host.js/.d.ts`、`typert.remote-client.js/.d.ts`，**没有 `lib/types/`**（`tsc` 阶段未跑，`lib/types/*.d.ts` 未产出，而 package.json 的 `types`/`./types` 都指向 `lib/types/`）。

---

### (2) 跨包导入重构的正确形态

**DSH monorepo 显式包导入的两种形态**：

1. **源码面**：`@deepseek-ai/dsh-<name>/src/<file>.ts`（如 `from '@deepseek-ai/dsh-session-stats/src/projection.ts'`）。它靠包的 `package.json` `exports["./src/*"] = "./src/*"` + pnpm workspace 软链 + `moduleResolution: bundler` 解析，**不需要** paths 别名（DSH `tsconfig.base.json` 里对绝大多数包没有 `/src/*` paths，只有少数 host 包有 `@deepseek-ai/dsh-host-*/*` → `./packages/host/*/src/*` 的显式通配）。实测 grep 到的 DSH 源码导入如 `@deepseek-ai/dsh-compaction-basic/src/config.ts`、`@deepseek-ai/dsh-mcp-client/src/tools.ts` 等。
2. **类型/契约子路径**：`@deepseek-ai/dsh-<name>/types`、`/invariant`、`/brand`、`/client`，由 `tsconfig.base.json` 的 `paths` 映射到 `./packages/<group>/<name>/src/types.ts`（或 invariant.ts/brand.ts/client.ts）。例：`"@deepseek-ai/dsh-commands/types": ["./packages/interaction/commands/src/types.ts"]`。

DSH `tsconfig.base.json`（`D:/project-code/llm/deepseek-harness/tsconfig.base.json` L30-245）的 paths 注释明确：「Source-level resolution for every repo-local graph. Project references, not declaration path aliases, keep each package/vendor source compiled under its own tsconfig boundary.」

**sandore workflow 包需重构的 11 个文件（`../../microflow/src/*`、`../../tool/src/*` 相对导入）** — 全部位于 `D:/project-code/llm/sandore/packages/sandore/workflow/`：

| 文件 | 行 | 相对导入 | 目标显式包导入 |
|---|---|---|---|
| `src/dag-navigator.ts` | 13-14 | `../../microflow/src/branch-evaluator.ts` | `@deepseek-ai/dsh-sandore-microflow/src/branch-evaluator.ts` |
| `src/dag-navigator.ts` | 15-16 | `../../microflow/src/loop-manager.ts` | `@deepseek-ai/dsh-sandore-microflow/src/loop-manager.ts` |
| `src/errors.ts` | 10-11 | `../../microflow/src/errors.ts` | `@deepseek-ai/dsh-sandore-microflow/src/errors.ts` |
| `src/host-agent.ts` | 12 | `../../microflow/src/subagents.ts` | `@deepseek-ai/dsh-sandore-microflow/src/subagents.ts` |
| `src/host-agent.ts` | 13 | `../../tool/src/index.ts` | `@deepseek-ai/dsh-sandore-tool/src/index.ts` |
| `src/host-agent.spec.ts` | 9 | `../../microflow/src/subagents.ts` | `@deepseek-ai/dsh-sandore-microflow/src/subagents.ts` |
| `src/interaction-manager.ts` | 16 | `../../microflow/src/subagents.ts` | `@deepseek-ai/dsh-sandore-microflow/src/subagents.ts` |
| `src/interaction-manager.spec.ts` | 12 | `../../microflow/src/subagents.ts` | `@deepseek-ai/dsh-sandore-microflow/src/subagents.ts` |
| `src/lifecycle-manager.ts` | 24 | `../../microflow/src/subagents.ts` | `@deepseek-ai/dsh-sandore-microflow/src/subagents.ts` |
| `src/recovery-manager.ts` | 29 | `../../microflow/src/subagents.ts` | `@deepseek-ai/dsh-sandore-microflow/src/subagents.ts` |
| `src/recovery-manager.spec.ts` | 10 | `../../microflow/src/subagents.ts` | `@deepseek-ai/dsh-sandore-microflow/src/subagents.ts` |
| `src/seam.ts` | 13 | `../../microflow/src/subagents.ts` | `@deepseek-ai/dsh-sandore-microflow/src/subagents.ts` |
| `src/workflow-engine.ts` | 50-54 | `../../microflow/src/{finalize-manager,stage-executor,step-runner,subagents}.ts` | `@deepseek-ai/dsh-sandore-microflow/src/*.ts` |

另外还有 2 个非 11 清单内、但同类相对导入的测试 mock（`../../../microflow/src/subagents.ts`）：`tests/mocks/agents.ts:25`、`tests/mocks/subagents.ts:24`。

**配套事实**：

- `microflow`/`tool` 的 `package.json` 均已声明 `"./src/*": "./src/*"`（见 §5），故显式包导入的解析目标存在。
- workflow 的 `package.json` 已声明 `@deepseek-ai/dsh-sandore-microflow`（peerDependencies + devDependencies，`workspace:*`），**未声明** `@deepseek-ai/dsh-sandore-tool`（host-agent.ts 却 `../../tool/src/index.ts` 导入它；而 tool 反向声明了 `@deepseek-ai/dsh-sandore-workflow: workspace:*`，构成 workflow→tool→workflow 方向）。
- sandore `tsconfig.base.json` 目前无 `paths`，若改走 `/types` 类子路径需要补 paths；走 `/src/*` 形态则依赖包 exports + workspace 软链（microflow/tool 已具备）。

---

### (3) `TypertAnalysisError: reference to Agent crosses a package or face without an explicit import` 根因

**错误抛出点** — `D:/project-code/llm/deepseek-harness/packages/typert/generator/src/analyzer.ts`：

- `targetForReference(symbol, site)`（L2344-2418）处理类型引用目标：
  1. `declaration = preferredDeclaration(symbol)`；`from = registrationForFile(site 所在文件)`；`owner = registrationForFile(declaration 所在文件)`。
  2. 若 `owner !== undefined` 且 `owner.name !== from.name`（声明在另一已注册包）：若 `module === undefined`（相对导入），抛 **`reference to X crosses a package without an explicit package import`**（L2365）。
  3. 若 `owner === undefined`（声明不在当前 face 的任何注册包内）且 `module !== undefined`：返回 `{ kind: 'external', module, subpath, name }`（L2398-2405）。
  4. `externalModuleIdentityForFile`（L3048-3057）只认 `/node_modules/` 下的文件；相对路径跨包的文件不在 node_modules，返回 undefined。
  5. 最终兜底抛 **`reference to X crosses a package or face without an explicit import`**（L2417）。
- `moduleIdentity(specifier)`（L3036-3046）：`specifier.startsWith('.')` 或 `'/'` 时返回 `undefined`。**相对导入 `../../microflow/src/subagents.ts` 因此永远拿不到 package identity。**
- `registrationForFile(file)`（L2483-2487）：只在 `this.allRegistrations`（由 `loadRegistrations` 从 `tsconfig.host.json` 的 `projectReferences` 读取，L455-501）里匹配 `face === this.face` 且文件在包 root 内。sandore `tsconfig.host.json` 只 reference 了 workflow，故 microflow 的 `Agent` 声明 `owner === undefined`。

**触发链路（sandore）**：`seam.ts:13` `import type { Agent } from '../../microflow/src/subagents.ts'` → `Agent` 用于 `UserQuestionsRequest.agent?: Agent`（`seam.ts:110`）→ `UserQuestionsRequest` 是 `UserQuestions.ask()` 的参数 → `UserQuestions` 作为 Cordis `Context.userQuestions` 的 service 被 `collectServices` 收集 → `ensureDeclaration(UserQuestions)` 遍历成员时对 `Agent` 引用调 `targetForReference` → 因相对导入 + microflow 未注册而命中 L2417 的兜底错误。

**根因总结**：相对导入让 `moduleIdentity` 无法识别包边界，且 microflow 未列入 host face 的 project references（`owner === undefined`），两者叠加落到「crosses a package or face without an explicit import」。改成显式包导入 `import type { Agent } from '@deepseek-ai/dsh-sandore-microflow/src/subagents.ts'` 后，`moduleIdentity` 能解析出 `@deepseek-ai/dsh-sandore-microflow`/`./src/subagents.ts`，`Agent` 会被当作 `{ kind: 'external', module: '@deepseek-ai/dsh-sandore-microflow', ... }` 外部引用处理，不再抛错（`Agent` 不进入任何 Remote 边界，无需跨 face link）。

---

### (4) wire 类型面拆分（`./types` 子路径）

**wire 类型当前导出位置** — 全部在 `D:/project-code/llm/sandore/packages/sandore/workflow/src/remote.ts`：

- `WorkflowDefinitionEntry`（L24，`extends WorkflowDefinitionRecord`，来自 `schema.ts`）
- `JobEntry`（L29，`extends JobRecord`，来自 `schema.ts`）
- `InstanceSummary`（L34，引用 `WorkflowTaskState['status']`，来自 `schema.ts`）
- `ArtifactEntry`（L44）
- `PingResponse`（L160）
- 12 个 `*Input` 类型（L144-155，`z.infer<typeof ...Schema>`，来自同文件 L54-142 的 zod schema）：`CreateDefinitionInput`/`UpdateDefinitionInput`/`CreateJobInput`/`UpdateJobInput`/`StartInstanceInput`/`ReplyQuestionInput`/`ReplyPermissionInput`/`PauseStepInput`/`ResumeStepInput`/`PauseAllInput`/`ResumeAllInput`/`RetryStepInput`。

**为何必须拆到 `./types`（typert 生成物 .d.ts 引用需求）**：

- 分析器 `publicRemoteType(symbol, site)`（`analyzer.ts` L1768-1796）要求 Remote 边界（结果/参数）类型**从一个「公共非 root 类型子路径」导出**：遍历 `packageExportTargets` 时跳过 `'.'`、`'./package.json'`、`'./typert'`、`'./client/typert'`、`'./remote'` 与含 `*` 的子路径，选不到就抛 `Remote boundary type X must be exported from a public non-root type subpath`。
- 发射器 `renderRemoteDts`（`emitter.ts` L331-396）对每个 wire 类型生成 `import type { X as X$remote } from '<specifier>'`，其中 `specifier = packageExportSpecifier(packageName, subpath)`（`emitter.ts` L913-915）= `@deepseek-ai/dsh-sandore-workflow/types`（当 subpath 为 `./types`）。
- DSH 官方包的 `./types` 导出形态（`commands`/`goal`/`plugin-inventory` 等）：`"./types": { "types": "./lib/types/types.d.ts", "default": "./lib/types/types.js" }`，由阶段一 `tsc -b` 从 `src/types.ts` 产出。

**sandore 现状（事实）**：

- workflow `package.json` **已有** `./types` 导出（`"./types": { "types": "./lib/types/types.d.ts", "default": "./lib/types/types.js" }`），但 `src/types.ts` 目前只含 browser-safe 基础词汇（`DagRun`/`DagRunInfo`/`DagStartRequest`/`AskUserQuestion*` 等，`type`/`interface` only），**不含** remote.ts 的 wire 类型。
- 当前 `lib/typert.remote-client.d.ts` 是**手工占位物**（非真实生成）：它把 `PingResponse`/`WorkflowDefinitionEntry`/`JobEntry`/`InstanceSummary`/`ArtifactEntry`/`DagRun` 等**内联**进了文件，而真实 generator 会改为 `import type ... from '@deepseek-ai/dsh-sandore-workflow/types'`；其中 `getInstanceState` 返回 `unknown`、`replyQuestion.answers` 为 `unknown`，正是「wire 类型未被识别为公共 types 子路径」的占位痕迹。
- 当前 `lib/typert.host.js` 的注释明确「本文件待 generator 跨包引用修复后重新生成为完整 FaceModel」，即 typert 生成当前因 §3 的跨包引用而**未真正跑通**。

---

### (5) sandore workflow/microflow/tool 的 package.json exports 现状

| 包 | 路径 | exports 现状 | files 现状 | scripts |
|---|---|---|---|---|
| workflow | `packages/sandore/workflow/package.json` | `.`、`./types`、`./typert`、`./remote`、`./schema`(`./src/schema.ts`)、`./yaml`(`./src/yaml-parser.ts`)、`./src/*`、`./package.json` | 含 `lib/typert.host.js/.d.ts`、`lib/typert.remote-client.js/.d.ts`、`lib/types/**` | `typecheck: tsc --noEmit`、`build: tsdown` |
| microflow | `packages/sandore/microflow/package.json` | `.`、`./src/*`、`./package.json` | `lib/index.js`、`lib/types/**` | 仅 `typecheck: tsc --noEmit`（无 build） |
| tool | `packages/sandore/tool/package.json` | `.`、`./src/*`、`./package.json` | `lib/index.js`、`lib/types/**` | 仅 `typecheck: tsc --noEmit`（无 build） |
| ui | `packages/sandore/ui/package.json` | `.`、`./client`、`./src/*`、`./package.json` | `lib/index.js`、`lib/client.js`、`lib/types/**` | 仅 `typecheck: tsc --noEmit`（无 build） |

结论（对应 exploreContent 问题）：**microflow/tool 已声明 `./src/*`，但均未声明 `./types`**；workflow 已声明 `./typert`/`./remote`/`./types`（`./types` 的产出文件 `lib/types/types.d.ts` 尚未被 `tsc` 阶段生成）。

---

### (6) ui 包 clientBundle() 构建形态与 sandore ui 现状

**DSH `clientBundle()` 辅助** — `D:/project-code/llm/deepseek-harness/packages/client/tsdown.client.ts`（`export function clientBundle(id, libEntry, options)` L93-109）：

- 返回按 `env.DSH_BUILD_FACE` 选择的配置数组：node 半（`clientLibraryConfig`，entry 为 `libEntry` 即 `lib/types/index.js` 等，outDir `lib`、esm、platform node）+ browser 半（`clientConfig`）。
- `clientConfig`（L170-274）要点：entry `{ client: 'src/client/index.ts' }`（未指定 face 时）或 `lib/types/client/index.js`（client face）；outDir `lib`、format **cjs**、platform browser、`entryFileNames: 'client.js'`（产出 `lib/client.js`）、`dts: false`、`clean: false`；`external: CLIENT_EXTERNALS`（平台模块表）；`noExternal: id => CLIENT_EXTERNALS.includes(id) ? undefined : true`（其余全部内联）；两个插件：`dsh-client-bundle-purity`（禁止跨插件 value import）与 `dsh-css-modules-inline`（lightningcss 编译 `.module.css` 并注入 `<style data-plugin="<id>">`）；`outputOptions.banner = window.__ModuleLoader__.load({ id, factory: (require) => {`、`footer = return module.exports; } });`、`intro = var module = { exports: {} }; var exports = module.exports;`。
- 调用范例：`packages/client/locale/tsdown.config.ts` = `clientBundle('@deepseek-ai/dsh-client-locale', ['lib/types/index.js', 'lib/types/invariant.js'])`；`packages/api/remotes/tsdown.config.ts` = `clientBundle('@deepseek-ai/dsh-api-remotes', ['lib/types/index.js', 'lib/types/invariant.js'], { hostPhase: true })`。

**sandore ui 现状（事实）**：

- `packages/sandore/ui/` **没有 `tsdown.config.ts`**、**没有 build 脚本**（仅 `typecheck: tsc --noEmit`）。
- `ui/tsconfig.json`：`rootDir: "src"`、`outDir: "lib/types"`、`jsx: "react-jsx"`、include `src`（与 DSH client 包 rootDir 'src' 一致）。
- 包名 `@deepseek-ai/dsh-client-ui-sandore`；`exports["./client"] = { types: "./lib/types/client/index.d.ts", default: "./lib/client.js" }`；`dsh.client = { inject: [...5 个 client 包], platform: "web" }`。
- node 半 `src/index.ts` 是空 `apply()`（L7）；browser 半 `src/client/index.ts`（`inject = ['conversationEvents','slots','locale','remote','sessions','workspaces']`，`apply` 内 `ctx.remote.$mount(sandoreRemote)` + `sidebar.footer.action` + `conversation.chat.node`）。
- 对齐 DSH 形态，ui 需要 `clientBundle('@deepseek-ai/dsh-client-ui-sandore', ['lib/types/index.js'])` 之类的 `tsdown.config.ts`（node 半 entry 为 `lib/types/index.js`，client 半 entry 由 helper 自动取 `src/client/index.ts`）。

---

### (7) cordis.yml 格式（`- insert:` 静态组合）

**DSH 权威样例** — `D:/project-code/llm/deepseek-harness/examples/web-cordis/cordis.yml`（完整 20 行）：

```yaml
# Opt-in Web composition ... PATCH OVERLAY over the web profile (dsh-base + dsh-web-app
# bundle layers), not a tree: `dsh web --patch` applies it as one more sibling patch list ...

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

- 顶层是 YAML list；`- id: <id> / config: {...}` 是覆盖某行 config 的 patch；`- insert:` 块内 `- id: <rowId>` + `name: '<包名>'` 即**插入一个插件行（静态组合挂载）**，可再带 `config`。
- 注释强调它是 **patch overlay**（非树），经 `dsh web --patch` 在同一 include 层级作为一层 sibling patch list 应用。

**sandore 设计目标形态** — `D:/project-code/llm/sandore/docs/design/task-5-frontend/design.md` §7.1（L674-699）：

```yaml
- insert:
    - id: workflow
      name: '@deepseek-ai/dsh-sandore-workflow'
      config:
        defaultTimeoutMs: 7200000
    - id: microflow
      name: '@deepseek-ai/dsh-sandore-microflow'
    - id: tool
      name: '@deepseek-ai/dsh-sandore-tool'
    - id: ui
      name: '@deepseek-ai/dsh-client-ui-sandore'
```

并注明：ui 需声明 `dsh.client`（`platform: 'web'`）+ `exports["./client"]`，bundle 由 `ctx.clientModules` 扫描组合进 `window.__DSH_BOOT__`；workflow 的 tunable 经 `static Config`（schemastery）声明，不硬编码。

---

### (8) 动态插件原型残留的搜索点

**搜索标识**：`host.call`、`harness.handle`、`cordis_define`、`cordis_run`（以及旧本地桩类名 `HostCall`）。

**当前 sandore 源码（`packages/sandore`，含 `.ts/.tsx`）搜索结果：0 命中**（`grep -rn "host\.call\|harness\.handle\|cordis_define\|cordis_run\|HostCall" packages/sandore` 退出码 1，无匹配）。

- `ui/src/client/index.ts`（当前 HEAD）已直接 `ctx.remote.$mount(sandoreRemote)` + `ctx.remote.sandore.*`（L27/L33-39），**已不是** Task 1 的 `host.call` 桩；旧桩文件 `ui/src/client/host.ts`（`HostCall`）已不在当前文件清单（`find packages/sandore/ui/src/client` 中无 host.ts）。
- `ui/src/client/remote.ts` 从 `@deepseek-ai/dsh-sandore-workflow/remote` 默认导入并 `unwrap()` 解包 `RemoteResult`（L11-46）。

**这些标识的现存位置仅在文档/归档（非源码）**，如：`docs/design/task-5-frontend/design.md:518-532`（说明 `host.call` 是动态插件 Package-private RPC，持久化插件用 Typert `ctx.remote.sandore.*`）；`docs/design/task-5-frontend/design.md:703`（§7.2 动态插件原型验证）；`furina/archive/2026-08-15-task-1-skeleton/...`（Task 1 原型）；`docs/engine/dsh-workflow.md:141,624,894`（`cordis_define`/`cordis_run` 为「模型自我修改运行时」临时机制）。

**验证标准出处**：`furina/changes/task-5-frontend/specs/static-composition/spec.md:35,38`（「固化后仓库内 SHALL NOT 存在动态插件原型路径（host.call 桩、harness.handle 接线、cordis_define/cordis_run 动态验证残留）；插件加载仅经 cordis.yml 静态组合」）；`plan.json` 的「8.4 全量清扫验证动态插件原型残留（host.call/harness.handle/cordis_define/cordis_run）」。

---

### 关键文件索引

- DSH 根构建/tsdown：`D:/project-code/llm/deepseek-harness/package.json`（build:lib:host）、`D:/project-code/llm/deepseek-harness/tsdown.config.ts`
- typert generator：`D:/project-code/llm/deepseek-harness/packages/typert/generator/src/{tsdown-plugin.ts, workspace.ts, analyzer.ts, emitter.ts, model.ts, index.ts}`
- DSH paths 别名：`D:/project-code/llm/deepseek-harness/tsconfig.base.json`（L30-245）
- DSH client bundle：`D:/project-code/llm/deepseek-harness/packages/client/tsdown.client.ts`
- DSH cordis.yml 样例：`D:/project-code/llm/deepseek-harness/examples/web-cordis/cordis.yml`
- sandore 根：`D:/project-code/llm/sandore/{package.json, tsconfig.base.json, tsconfig.host.json, pnpm-workspace.yaml}`
- sandore 包：`D:/project-code/llm/sandore/packages/sandore/{workflow,microflow,tool,ui}/{package.json,tsconfig.json}`；workflow 另有 `tsdown.config.ts`、`src/{remote.ts,types.ts,seam.ts,index.ts}` 及 lib/ 占位产物
- sandore 设计：`D:/project-code/llm/sandore/docs/design/task-5-frontend/design.md`（§7.1 L674-699）、`work.md`
