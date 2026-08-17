# sandore 挂载固化与 typert 构建 — 探索材料

> 探索对象：`D:/project-code/llm/sandore`（当前项目）与 `D:/project-code/llm/deepseek-harness`（DSH 参考 monorepo）。
> 本文仅记录现状与机制，不包含任何实现方案。

---

## 1. DSH 的 tsdown + typert generator 构建管线精确机制

### 1.1 两阶段构建（根 `package.json` scripts）

DSH 根 `D:/project-code/llm/deepseek-harness/package.json` 定义：

```jsonc
"build:lib:host":   "tsc -b tsconfig.host.json   && tsdown --env.DSH_BUILD_FACE host",
"build:lib:client": "tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client"
```

- **第一阶段** `tsc -b tsconfig.host.json`：以 project references 聚合所有 Host 贡献包，每个包用自己的 `tsconfig.json` 编译，产出 `lib/types/*.js` + `lib/types/*.d.ts`（DSH 各包 tsconfig 均为 `"rootDir": "src"`, `"outDir": "lib/types"`，继承 `tsconfig.base.json`，`tsconfig.base.json` 打开 `declaration/composite/incremental/rewriteRelativeImportExtensions` 与 `paths` 源码解析映射）。
- **第二阶段** `tsdown --env.DSH_BUILD_FACE host`：对 `lib/types/*.js` 做 bundling，并在 `writeBundle` 阶段由 typert plugin 生成 `lib/typert.<face>.js/.d.ts` 与 `lib/typert.remote-client.js/.d.ts`。

sandore 当前**只有** workflow 包有 `tsdown.config.ts`（`"build": "tsdown"`），根 `package.json` 的 `build` 仅为 `pnpm -r --if-present run build`；根 `tsconfig.host.json` 仅 reference 了 `./packages/sandore/workflow`，且根 `tsconfig.host.json` 设 `"noEmit": true`（DSH 根 `tsconfig.host.json` 同样 `noEmit: true`，emit 由各包自己的 tsconfig 完成）。

### 1.2 根 `tsdown.config.ts` 的 workspace 模式（DSH）

`D:/project-code/llm/deepseek-harness/tsdown.config.ts`：

```ts
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

要点：
- `--env.DSH_BUILD_FACE` 决定 host/client；host 阶段才挂 `typertPlugin({ mode: 'workspace', faces: ['host'] })`。
- host 阶段 entry 是第一阶段 tsc 产出的 `lib/types/{index,invariant,startup}.js`。

### 1.3 `typertPlugin` 与 `writeBundle` 扫描（`packages/typert/generator/src/tsdown-plugin.ts`）

- `transform(code, id)`：对含 decorator 语法的 `.ts/.tsx` 源用 `ts.transpileModule`（target ES2024 / module ESNext）降级 decorator 后交给 rolldown。
- `writeBundle({ dir })`：`dir` 是包的 outDir（`<package>/lib`）。
  - `workspaceRoot(dir)`：向上找含 `tsconfig.host.json` 的目录作为 workspace root。
  - `mode === 'workspace'` 时调用 `emitWorkspace(root, faces)`：
    1. `new WorkspaceTypertGenerator(root).discover(faces)` 发现贡献包；
    2. `.filter(candidate => hasTypertExport(readManifest(join(root, candidate.root)).exports))` —— **只有 exports 里含 `./typert` 或 `./client/typert` 或 `./remote` 的包**才被生成；
    3. `generator.generate(packages, faces)` 逐包产出 artifact；
    4. `emitArtifacts(join(root, artifact.packageRoot), [artifact])`。
- `emitArtifacts(packageDir, artifacts)`：写 `<package>/lib/typert.<face>.js` 与 `typert.<face>.d.ts`；若 artifact 带 `remote`，额外写 `typert.remote-client.js`、`typert.remote-client.d.ts`、`typert.remote-client.d.ts.map`；若 host 无 Remote 方法且存在旧 remote 文件则删除。
- `hasTypertExport(exportsField)`：`Object.hasOwn(exports, './typert') || './client/typert' || './remote'`。

### 1.4 `validateExport` 强制校验（`packages/typert/generator/src/workspace.ts`）

`WorkspaceTypertGenerator.generate()` 对每个 artifact 调用 `validateExport`：

- host 面：package.json `exports["./typert"]` 必须严格等于
  `{ types: "./lib/typert.host.d.ts", default: "./lib/typert.host.js" }`，且 `files` 必须含 `lib/typert.host.js`、`lib/typert.host.d.ts`，否则抛 `TypertAnalysisError`（"must export ./typert as …" / "package files must include …"）。
- host 且有 Remote 方法时：`exports["./remote"]` 必须等于
  `{ types: "./lib/typert.remote-client.d.ts", default: "./lib/typert.remote-client.js" }`，且 `files` 含两个 remote 文件；若发布了 remote 文件但模型里没有 Remote 方法则报错。
- `sameExport` 对 `types`/`default` 两个字段做精确字符串比较（subpath 条件对象必须是 `{ types, default }` 形态）。

sandore 的 `workflow/package.json` 已按该契约声明好 `./typert` 与 `./remote`（见第 5 节），`tsdown.config.ts` 用 `typertPlugin({ faces: ['host'] })`（package 模式而非 workspace 模式）。

### 1.5 发现与注册（`packages/typert/generator/src/analyzer.ts`）

- `loadRegistrations()`：遍历 `tsconfig.host.json` / `tsconfig.client.json` 的 `projectReferences`，只取 `packages/` 下的包，读其 `package.json` 的 `name`，形成 `PackageRegistration`（face + name + root + config + manifest）。
- `isDualFacePackage(manifest)`：`manifest.dsh.client` 存在即双面包，会被拆成 host/client 两个注册（hostExportSubpaths/clientExportSubpaths 过滤 subpath）。
- 因此 **sandore 根 `tsconfig.host.json` 只 reference 了 workflow** ⇒ 只有 `@deepseek-ai/dsh-sandore-workflow` 注册进 host 面；microflow/tool 不在任何 host 注册里。

### 1.6 生成产物形态（`emitter.ts`）

- host `typert.host.js/.d.ts`：`renderDts` 对 `schemas.exports` 生成 `import type { X as X$source } from '<package><subpath>'`，末尾固定 `export declare const TYPERT: unknown`（无 service/event/schema 时 host 面 d.ts 就只有这一行——当前 sandore `lib/typert.host.d.ts` 正是这种空形态）。
- `typert.remote-client.js/.d.ts`：`renderRemoteDts` 生成 `import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'`，随后对每个 Remote boundary 引用的具名 wire 类型生成 `import type { X as X$remote } from '<package>/<subpath>'`，并把 `TypertRemoteNamespace$<hex>` / `TypertRemoteMap` / `TypertRemoteNamespaceMap` 声明合并进 `declare module '@deepseek-ai/dsh-typert-protocol'`。

---

## 2. 跨包导入重构的正确形态

### 2.1 现状：workflow 里 11 个文件的相对跨包导入

`grep '../../microflow|../../tool'` 在 `packages/sandore/workflow/src` 的命中（共 11 个文件）：

| 文件 | 相对导入 |
|---|---|
| `dag-navigator.ts` | `../../microflow/src/branch-evaluator.ts`、`../../microflow/src/loop-manager.ts` |
| `errors.ts` | `../../microflow/src/errors.ts` |
| `host-agent.spec.ts` | `../../microflow/src/subagents.ts` |
| `host-agent.ts` | `../../microflow/src/subagents.ts`、`../../tool/src/index.ts` |
| `interaction-manager.spec.ts` | `../../microflow/src/subagents.ts` |
| `interaction-manager.ts` | `../../microflow/src/subagents.ts` |
| `lifecycle-manager.ts` | `../../microflow/src/subagents.ts` |
| `recovery-manager.spec.ts` | `../../microflow/src/subagents.ts` |
| `recovery-manager.ts` | `../../microflow/src/subagents.ts` |
| `seam.ts` | `../../microflow/src/subagents.ts` |
| `workflow-engine.ts` | `../../microflow/src/finalize-manager.ts`、`stage-executor.ts`、`step-runner.ts`、`subagents.ts` |

目标形态为显式包导入：`@deepseek-ai/dsh-sandore-microflow/src/<file>`、`@deepseek-ai/dsh-sandore-tool/src/<file>`（`microflow/package.json` 与 `tool/package.json` 已声明 `"./src/*": "./src/*"`，见第 5 节）。

### 2.2 DSH 约定：显式包导入而非相对导入

- DSH 各包之间一律用 `@deepseek-ai/dsh-<name>/<subpath>` 显式导入；`tsconfig.base.json` 的 `paths` 提供源码解析（`"@deepseek-ai/dsh-*": ["./packages/*/*/src", …]`），project references 承担编译边界。
- 相对 `../../` 跨包导入在 typert 分析器里被视为「无显式 import 的跨包引用」，是第 3 节的报错来源。
- 附带影响：workflow 的 `tsconfig.json` 目前 `"rootDir": ".."`（`packages/sandore`），正是为了容纳 `../../microflow`、`../../tool` 越界导入而放宽 rootDir；DSH 标准形态是 `"rootDir": "src"` + `"outDir": "lib/types"`（见 1.1）。rootDir 设 ".." 会改变 `lib/types` 的 emit 目录结构（相对 `packages/sandore` 镜像出 `workflow/src/…`），与 `exports["./types"] = lib/types/types.d.ts`、`exports["."] = lib/types/index.d.ts` 的预期不匹配。

---

## 3. `TypertAnalysisError: reference to Agent crosses a package or face without an explicit import` 根因

### 3.1 触发点

`seam.ts:13`：`import type { Agent } from '../../microflow/src/subagents.ts'`（供 `UserQuestionsRequest.agent` 字段使用）。

### 3.2 分析器判定链路（`analyzer.ts` 的 `targetForReference`，约 2344–2418 行）

对每个被引用的具名类型 `Agent`：

1. `owner = registrationForFile(declaration.getSourceFile().fileName)` —— `Agent` 声明在 `microflow/src/subagents.ts`，而 host 面只有 workflow 被注册（见 1.5），故 `owner === undefined`。
2. `moduleSpecifierOf(site)` 取到引用处的导入路径 `'../../microflow/src/subagents.ts'`；`moduleIdentity` 对以 `.` 开头的路径返回 `undefined`（`moduleIdentity` 明确 `if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined`）。
3. `packageFaces` 因 `module === undefined` 为空，`otherFace` 为 undefined；`module !== undefined` 分支不成立。
4. `externalModuleIdentityForFile(declaration 文件)` 只在 `node_modules` 路径下命中，microflow 是 workspace 包，不命中。
5. 最终落入 `this.fail(site, "reference to ${symbol.name} crosses a package or face without an explicit import")`（第 2417 行）。

### 3.3 机制结论

- 相对 `../../microflow/src/*` 导入被 `moduleIdentity` 视为「非包导入」；当被引用类型的声明落在未注册的 workspace 包里时，分析器无法把它归为 `declaration`（owner 缺失）、`cross-face`（module 缺失）、或 `external`（不在 node_modules），于是报错。
- 显式 `import type { Agent } from '@deepseek-ai/dsh-sandore-microflow/src/subagents.ts'` 会令 `moduleSpecifier` 解析出 `module = { package: '@deepseek-ai/dsh-sandore-microflow', subpath: './src/subagents.ts' }`，走 `module !== undefined` 分支返回 `{ kind: 'external', … }`，不再报错。这正是第 2 节重构的必要性。

---

## 4. wire 类型面拆分

### 4.1 当前导出位置（`workflow/src/remote.ts`）

`remote.ts` 当前导出以下「wire 类型」（均为 `export interface` / `export type`）：

- `WorkflowDefinitionEntry extends WorkflowDefinitionRecord { id: string }`（引用 `schema.ts` 的 `WorkflowDefinitionRecord`）
- `JobEntry extends JobRecord { id: string }`（引用 `schema.ts` 的 `JobRecord`）
- `InstanceSummary`（`instanceId/jobId/workflowId/status/createdAt/updatedAt`）
- `ArtifactEntry`（`stepId/stageId/outputToId?/files/returnPrompt?`）
- `PingResponse`（`pong/service/time`）
- 12 个 Input 类型：`CreateDefinitionInput`、`UpdateDefinitionInput`、`CreateJobInput`、`UpdateJobInput`、`StartInstanceInput`、`ReplyQuestionInput`、`ReplyPermissionInput`、`PauseStepInput`、`ResumeStepInput`、`PauseAllInput`、`ResumeAllInput`、`RetryStepInput`（均为 `z.infer<typeof …Schema>`）
- 另有 zod schema `const`（`CreateDefinitionInputSchema` 等，非类型导出）。

`remote.ts` 又被 `index.ts` 的 `export * from './remote.ts'` 提升到根 `.` 子路径。

### 4.2 `types.ts` 现状（`workflow/src/types.ts`）

`types.ts` 只含基础词汇类型：`AskUserQuestionOption/Item/AnswerItem/Answer`、`DagRunInfo`、`DagStartRequest`、`DagRun`、`DagRunStatus`、`DagInstanceState`、`ExecutedStepDefault`、`StageInfo`、`StepStatus`、`StageContract`、`PendingInteractionStatus`、`FinalizeOutcome`、`DagResultInfo`，并 re-export `schema.ts` 的一组类型。**尚未包含上述 wire 类型与 Input 类型**。

### 4.3 生成器对 wire 类型子路径的规则（`analyzer.ts` 的 `publicRemoteType`，约 1768–1796 行）

Remote boundary 引用的具名类型必须满足：

- 排除子路径：`.`、`./package.json`、`./typert`、`./client/typert`、`./remote`、以及 target 含 `*` 的子路径（`./src/*` 因此不可用）；
- 否则 `this.fail(site, "Remote boundary type ${symbol.name} must be exported from a public non-root type subpath")`。

workflow 的 `exports["./types"] = lib/types/types.d.ts`（`sourcePathForExport` 将其映射回 `src/types.ts`）是唯一可承载这些 wire 类型的非 root、非通配子路径（`./schema`、`./yaml` 也可，但 DSH 约定是 `./types`）。

### 4.4 生成物引用方式

`emitter.ts` 的 `renderRemoteDts` + `remoteImports` + `renderer.renderType(…, referenceNames)`：对可定位到非 root 子路径的 wire 类型，生成

```ts
import type { WorkflowDefinitionEntry as WorkflowDefinitionEntry$remote } from '@deepseek-ai/dsh-sandore-workflow/types'
```

并在 `TypertRemoteNamespace*`/`TypertRemoteMap` 签名里用别名引用，而**不是**内联。当前 sandore 已提交的 `lib/typert.remote-client.d.ts` 把这些类型内联（`PingResponse`/`WorkflowDefinitionRecord`/`JobRecord`/`DagRun{status:string}` 等被写进文件、`getInstanceState` 返回 `RemoteResult<unknown>`），说明该产物是旧版/过期生成结果，与 rc.6 生成器的「必须从非 root 子路径导出」规则不匹配。

---

## 5. sandore 各包 package.json `exports` 现状

### 5.1 workflow（`@deepseek-ai/dsh-sandore-workflow`）

已声明：`.`（lib/types/index.d.ts + lib/index.js）、`./types`（lib/types/types.d.ts + lib/types/types.js）、`./typert`（lib/typert.host.d.ts/.js）、`./remote`（lib/typert.remote-client.d.ts/.js）、`./schema`（src/schema.ts）、`./yaml`（src/yaml-parser.ts）、`./src/*`、`./package.json`。`files` 已含 `lib/typert.host.*`、`lib/typert.remote-client.*`。有 `build: tsdown`。

### 5.2 microflow（`@deepseek-ai/dsh-sandore-microflow`）

`exports`：`.`（lib/types/index.d.ts + lib/index.js）、`./src/*`（./src/*）、`./package.json`。**未声明 `./types`**。无 `build` 脚本、无 `tsdown.config.ts`（仅 `typecheck: tsc --noEmit`）。

### 5.3 tool（`@deepseek-ai/dsh-sandore-tool`）

`exports`：`.`、`./src/*`、`./package.json`。**未声明 `./types`**。无 `build` 脚本、无 `tsdown.config.ts`。

### 5.4 ui（`@deepseek-ai/dsh-client-ui-sandore`）

`exports`：`.`（lib/types/index.d.ts + lib/index.js）、`./client`（lib/types/client/index.d.ts + lib/client.js）、`./src/*`、`./package.json`。含 `dsh.client` 字段（`inject` 列表 + `platform: "web"`）。**无 `build` 脚本、无 `tsdown.config.ts`**。

结论：`microflow`/`tool` 已声明 `./src/*`（满足第 2 节显式 `…/src/*` 导入的解析），但都未声明 `./types` 子路径。

---

## 6. ui 包 clientBundle() 构建形态与 sandore ui 现状

### 6.1 DSH `packages/client/tsdown.client.ts` 的 `clientBundle` 辅助

- `clientBundle(id, libEntry, options)`：返回按 `DSH_BUILD_FACE` 选择的 tsdown 配置数组。
  - Node 半（`lib`）：`clientLibraryConfig` —— entry=libEntry（如 `['lib/types/index.js', 'lib/types/invariant.js']`），outDir `lib`，format esm，platform node，dts false，clean false。
  - 浏览器半（`client`）：`clientConfig` —— entry `src/client/index.ts`（无 face 时）或 `lib/types/client/index.js`（client 面 tsc 后），outDir `lib`，format **cjs**，platform browser，sourcemap true，`external: CLIENT_EXTERNALS`，`noExternal` 内联一切非平台模块，`define` 注入 `process.env.NODE_ENV`/`import.meta.env.*`，`entryFileNames: 'client.js'`，`banner: window.__ModuleLoader__.load({ id, factory: (require) => {` / `footer: return module.exports; } });` / `intro: var module = { exports: {} }; var exports = module.exports;`。
  - 两个插件：`dsh-client-bundle-purity`（`@deepseek-ai/*` 非平台/非 inline-safe/非 `/remote` 的值导入直接报错，跨插件值导入必须走 cordis service）与 `dsh-css-modules-inline`（lightningcss 编译 `*.module.css` 为 hashed class map + 注入 `<style data-plugin-css>`）。
  - `CLIENT_EXTERNALS = [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client']`；`INLINE_SAFE` 匹配 `@deepseek-ai/dsh-(host-apiproxy|session|llm|tools|brand)(/|$)`；`GENERATED_REMOTE` 匹配 `@deepseek-ai/dsh-*\/remote`。
- 参考用法（`packages/client/ui-sidebar/tsdown.config.ts`）：
  ```ts
  import { clientBundle } from '../tsdown.client.ts'
  export default clientBundle('@deepseek-ai/dsh-client-ui-sidebar', ['lib/types/index.js', 'lib/types/invariant.js'])
  ```
- 配套 tsconfig（`packages/client/ui-sidebar/tsconfig.json`）：`extends ../../../tsconfig.base.client.json`，`rootDir src`、`outDir lib/types`，references 各依赖包。

### 6.2 sandore ui 现状

- `packages/sandore/ui/tsconfig.json` 仅 `{ extends ../../../tsconfig.base.json, compilerOptions: { rootDir: "src", outDir: "lib/types", jsx: "react-jsx" }, include: ["src"] }`。
- **无 `tsdown.config.ts`、无 `build` 脚本**。
- 源结构：`src/index.ts`（Host 半，`export function apply(): void {}`）+ `src/client/index.ts` 及若干 `.tsx`/`.module.css`/模型与 spec 文件。
- `src/client/remote.ts` 已按「显式包导入」形态 `import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote'`，并 `export type { PingResponse } from '@deepseek-ai/dsh-sandore-workflow/remote'`（依赖生成的 `typert.remote-client.d.ts` 顶层 re-export `PingResponse`）。
- 当前 ui 的 `lib/` 未构建（无 lib 目录）。

---

## 7. cordis.yml 格式

### 7.1 `examples/web-cordis/cordis.yml`（含 `- insert:` 块）

```yaml
# PATCH OVERLAY over the web profile …（注释）
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

要点：顶层是 YAML 列表；普通条目 `- id: <id>` + `name: '<package>'`（+ 可选 `config`）；`- insert:` 是一个「插入块」，其值为子列表，子项同样为 `{ id, name }` 形态。文件注释说明它是对 web profile（dsh-base + dsh-web-app bundle 层）的 **PATCH OVERLAY**（`dsh web --patch` 将其作为同级 patch 列表应用，patch 会整体替换目标行的 `config`）。

### 7.2 `examples/acp-agent/cordis.yml`（纯列表形态）

顶层直接是 `- id: <id>` + `name: '@deepseek-ai/dsh-…'`（+ 可选 `config:`，config 值支持 `!!js "<expression>"`）。这是「静态组合树」的完整参考：`llm-deepseek`、`sandbox`、`sandbox-policy`、`subprocess`、`bash`、`approval`、`acp-agent`、`token-meter`、`compaction-basic`、`session-projection`、`subagent*`、`tool-subagent*`、`workflow-worker-thread`、`tool-workflow`、`tool-ralph`、`tool-todo`、`repeat-tool-reminder`、`fs-sandbox`、`fs-observation-policy`、`tool-fs`、`hooks-claude-code`、`hooks-codex`。

### 7.3 sandore 现状

`find sandore -name 'cordis*.yml|yaml'`（排除 node_modules）**无任何 cordis.yml**——sandore 尚无静态组合文件。

---

## 8. 动态插件原型残留的搜索点

在 `D:/project-code/llm/sandore` 的 `packages` 与 `docs` 下搜索：

- `host\.call`、`harness\.handle`、`cordis_define`、`cordis_run`：**0 命中**。
- `harness`：仅命中 microflow 各 spec 内的本地测试 helper `function harness(config) { … }`（如 `branch-evaluator.spec.ts:20`、`finalize-manager.spec.ts:135`、`loop-manager.spec.ts:20`、`step-runner.spec.ts:104`），与「动态插件/宿主 harness」无关。

结论：sandore 当前代码与文档中**不存在** `host.call` / `harness.handle` / `cordis_define` / `cordis_run` 这类动态插件原型残留；挂载侧也尚未建立 cordis.yml 静态组合（见第 7 节）。

---

## 附：关键文件绝对路径

**DSH 参考（`D:/project-code/llm/deepseek-harness`）**
- `tsdown.config.ts`（根 workspace 模式 + typertPlugin）
- `packages/typert/generator/src/tsdown-plugin.ts`（writeBundle 扫描 / hasTypertExport / emitArtifacts）
- `packages/typert/generator/src/workspace.ts`（WorkspaceTypertGenerator / validateExport）
- `packages/typert/generator/src/analyzer.ts`（loadRegistrations / targetForReference / publicRemoteType / moduleIdentity）
- `packages/typert/generator/src/emitter.ts`（renderDts / renderRemoteDts / remoteImports）
- `packages/client/tsdown.client.ts`（clientBundle / clientLibrary / clientOnly / CLIENT_EXTERNALS）
- `packages/client/ui-sidebar/tsdown.config.ts`（clientBundle 用法示例）
- `packages/api/remotes/package.json` + `src/types.ts`（`./types` 子路径 + 类型面拆分参考）
- `packages/typert/protocol/package.json`（`./types` 子路径参考）
- `examples/web-cordis/cordis.yml`、`examples/acp-agent/cordis.yml`
- `tsconfig.host.json`、`tsconfig.base.json`、根 `package.json`（build:lib:host/client 两阶段）

**sandore（`D:/project-code/llm/sandore`）**
- 根：`package.json`、`tsconfig.host.json`、`tsconfig.base.json`、`pnpm-workspace.yaml`
- `packages/sandore/workflow/`：`package.json`、`tsconfig.json`（rootDir ".."）、`tsdown.config.ts`、`src/remote.ts`、`src/types.ts`、`src/seam.ts`、`src/index.ts`、`src/schema.ts`、`lib/`（当前仅 index.js + 4 个 typert 产物）
- `packages/sandore/microflow/package.json`、`packages/sandore/tool/package.json`、`packages/sandore/ui/package.json` + `ui/tsconfig.json` + `ui/src/client/remote.ts`
- 安装的生成器版本：`@deepseek-ai/dsh-typert-generator@0.1.0-rc.6`（node_modules 真实路径 `node_modules/.pnpm/@deepseek-ai+dsh-typert-gen_*/node_modules/@deepseek-ai/dsh-typert-generator/lib/types/`，其 `workspace.js` 的 `validateExport` 与 `analyzer.js` 的 `crosses a package or face` / `public non-root type subpath` 规则与 DSH rc.5 源码一致）
