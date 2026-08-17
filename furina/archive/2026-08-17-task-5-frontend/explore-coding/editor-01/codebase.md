# editor-01 探索结果

## 需求理解（What / Boundaries / Goal / Project Context）

- **What**：为 sandore 仓库新增 `ui` 包中的 `DagEditor` 组件（Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存），并将 `workflow` 包的「定义层 zod schema」与「YAML 解析/序列化」拆分为可在浏览器安全导入的子路径模块。探索目的是厘清：现有 `workflow/src/schema.ts` 三层结构的边界、哪些依赖 Node 侧包（`@deepseek-ai/dsh-storage-domain` / `@deepseek-ai/dsh-llm`）、`yaml-parser.ts` 的签名与依赖、`workflow/package.json` 现有 exports、DSH `ui-primitives` 可用组件与图标、`ui` 包现有组件范式、DSH `ui-workflow-run`/`ui-trajectory` 的「节点列表 + 连线示意」参考、以及 `ctx.remote.sandore.*` 的 wire 类型。
- **Boundaries**：仅探索 `packages/sandore/workflow`、`packages/sandore/ui` 两个本地包，以及 node_modules 中已安装的 DSH 依赖（`dsh-client-ui-primitives`、`dsh-client-ui-slots`、`dsh-storage-domain`、`dsh-typert-protocol` 等）和参考源码仓库 `D:/project-code/llm/deepseek-harness`（`packages/client/ui-primitives`、`ui-workflow-run`、`ui-trajectory`）。不改任何代码。
- **Goal**：为 Task 5 前端（DagEditor + schema/yaml 浏览器安全拆分）的实现提供参考事实，包括拆分点、依赖清单、可用组件 props 与范式。
- **Project Context**：sandore 是 DSH 的插件化工作流引擎，pnpm monorepo（`packages/sandore/*`，4 个包：`workflow`/`microflow`/`tool`/`ui`）。`workflow` 是 Host 侧核心包（zod 三层 schema + YAML 解析 + 引擎 + RPC），`ui` 是 Client 侧纯 UI 插件（React + CSS Modules + DSH slots）。构建用 tsdown（workflow 有 build，ui 无 build，仅 typecheck）。

## Exploration Result

`docs/codebase` 目录为空，Phase 3（furina-codebase 探索）无任何返回结果。以下内容全部来自 Phase 4 补充探索。

## Supplementary Exploration Result

### 0. 关键结论速览

- `workflow/src/schema.ts` 当前是**单一文件**，把「定义层」「运行时层」「存储层」三层 zod schema 混在一起。唯一明确的 Node 侧运行时依赖是文件顶部 `import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'`（第 11 行），只被文件末尾的 `sandoreDomainSpec` 使用。其余 schema 全部是纯 `zod`（浏览器安全）。
- `yaml-parser.ts` 本身只 import `yaml`、`./errors.ts`、`./schema.ts`。但 `./errors.ts` 是 re-export `microflow/src/errors.ts`，而 `SandoreError extends HarnessError`（来自 `@deepseek-ai/dsh-llm`，Node 侧）。因此「浏览器安全拆分」需要同时处理 schema 顶部的 storage-domain import 与 errors 链上的 dsh-llm 依赖。
- 已确认 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-storage`、`@deepseek-ai/dsh-storage-domain` 均 peer-depend `@deepseek-ai/cordis`（Node 侧框架），不是浏览器安全包。
- `workflow/package.json` 当前 exports 没有 `./schema`、`./yaml` 子路径；`./types` 子路径目前指向不存在的 `lib/types/types.d.ts`（tsdown 配置 `dts: false`，构建产物只有 `lib/index.js` + typert 生成文件）。
- `ui` 包已有组件范式清晰：`WorkflowButton`/`WorkflowPanel` 通过 `PropsRuntime<'sidebar.footer.action'> & InjectFace<Face> & PropsLocale<'sandore'>` 组合 props，`locales.ts` 用 `NS` + `zh`/`en` + `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap }` 声明类型化 `t`，CSS 用 `import css from './X.module.css'` + `src/css-modules.d.ts`。

---

### 1. `workflow/src/schema.ts` 当前结构（三层 + 依赖）

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`（444 行）

**顶部依赖（第 11-12 行）**：
```ts
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
```
`defineDomain`/`domainTable` 只用于文件末尾的 `sandoreDomainSpec`（存储层），是唯一的 Node 侧运行时 import。`zod` 是浏览器安全纯 JS。

**三层结构划分（按文件内注释与内容）**：

- **定义层（浏览器安全，纯 zod，被运行时层引用）**：
  - `StepStatusSchema`（第 15 行，`const`，未导出）—— 7 种执行状态枚举
  - `DagRunStatusSchema`（第 18 行，`const`，未导出）—— 实例生命周期枚举
  - `ContentBlockSchema`（第 24 行，`const`，未导出）—— `z.looseObject({ type: z.string() })`
  - `CommandConfigSchema`（第 32 行，导出）—— 5 种命令 discriminated union（agent/prompt/shell/skill/mcp），判别字段 `type`，变体字段整体嵌套于 `value`
  - `InputFromItemSchema`（第 68 行，导出）—— `{ id, path?, regex? }`
  - `OutputToItemSchema`（第 75 行，导出）—— `{ id, path?, regex? }`
  - `PassThroughVarSchema`（第 82 行，导出）—— `{ name, value, description, refresh? }`
  - `PassThroughVarValueSchema`（第 90 行，`const`，未导出）—— `{ value, description, refresh? }`
  - `DagBranchSchema`（第 97 行，导出）—— `{ expectation?, next, label? }`
  - `DagLoopSchema`（第 104 行，导出）—— `{ breakCondition?, breakExpectation?, next?, maxIterations, exitTo? }`
  - `GatesSchema`（第 113 行，导出）—— `{ maxRetries?, maxTokens?, primary?, secondary?, need_confirm? }`
  - `WorkflowSettingsSchema`（第 128 行，导出）—— `{ defaultTimeout(默认120), maxConcurrentAgents(默认4) }`
  - `WorkflowStepSchema`（第 134 行，导出）—— V2 顶层 `steps[]` 完整定义（id/name/command/inputFrom/outputTo/passThroughVars/timeout/next/defaultExpectation/condition/branches/loop/rules/gates）
  - `WorkflowStageSchema`（第 152 行，导出）—— `{ id, name, rules?, gates?, steps[], next?, defaultExpectation?, condition?, branches?, loop? }`
  - `WorkflowDefinitionSchema`（第 166 行，导出）—— `{ id, name, version, description?, engine?, skills[], mcps[], agents[], settings, rules?, gates?, stages[], steps[]? }`

- **运行时层（纯 zod，但引用定义层 CommandConfigSchema/InputFromItemSchema 等）**：
  - `StepSessionMetaSchema`（第 185 行）、`AskUserQuestionPayloadSchema`（第 193 行）、`PendingQuestionEntrySchema`（第 210 行）、`PendingPermissionEntrySchema`（第 232 行，含 `PendingPermissionPayloadSchema`/`PendingInteractionStatusSchema` 两个 `const`）、`FinalizeAssessResultSchema`（第 246 行）、`GateEvalResultSchema`（第 256 行）、`FinalizeMetaSchema`（第 270 行）、`BranchMetaSchema`（第 283 行）、`SessionMessageSchema`（第 292 行）、`RetryRecordSchema`（第 301 行）、`ExecutedStepDefaultSchema`（第 310 行，引用 CommandConfigSchema）、`StageInfoSchema`（第 339 行）、`StageContractSchema`（第 346 行）、`WorkflowTaskStateSchema`（第 363 行，引用 ExecutedStepDefaultSchema 等）

- **存储层（Node 侧，依赖 storage-domain）**：
  - `WorkflowDefinitionRecordSchema`（第 389 行，导出）—— `{ yaml(max 65536), name, version, description?, createdAt, updatedAt }`
  - `JobRecordSchema`（第 399 行，导出）—— `{ name, workflowId, cwd?, createdAt, updatedAt }`
  - `sandoreDomainSpec`（第 408 行，导出）—— `defineDomain({ name: 'sandore', version: 1, tables: { definitions: domainTable<string, WorkflowDefinitionRecord>(WorkflowDefinitionRecordSchema), jobs: ..., state: domainTable<string, WorkflowTaskState>(WorkflowTaskStateSchema) } })`

- **派生 TS 类型（第 420-443 行）**：`CommandConfig`、`InputFromItem`、`OutputToItem`、`PassThroughVar`、`DagBranch`、`DagLoop`、`Gates`、`WorkflowSettings`、`WorkflowStep`、`WorkflowStage`、`WorkflowDefinition`、`StepSessionMeta`、`FinalizeMeta`、`FinalizeAssessResult`、`GateEvalResult`、`AskUserQuestionPayload`、`PendingQuestionEntry`、`PendingPermissionEntry`、`BranchMeta`、`SessionMessage`、`RetryRecord`、`WorkflowTaskState`、`WorkflowDefinitionRecord`、`JobRecord` 等（`z.infer` 派生）。

**storage-domain 的 `defineDomain`/`domainTable` 签名**（`dsh-storage-domain/lib/types/spec.d.ts`）：
```ts
export declare function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V>;
export declare function defineDomain<S extends DomainSpec>(spec: S): S;
```
该包是完整 Cordis 插件（`dsh-storage-domain/lib/types/index.d.ts` 声明了 `inject`、`apply(ctx, config)`、`DomainFacility`，declare module 扩展 `Context.storageDomain` 与 `StorageForms.domain`），peer-depend `@deepseek-ai/cordis` / `@deepseek-ai/dsh-storage` / `@deepseek-ai/dsh-invariants`，依赖 `zod` + `schemastery`。故导入它即引入 Node 侧依赖链。

**相关类型文件 `workflow/src/types.ts`**（204 行）：以 `import type { ContentBlock } from '@deepseek-ai/dsh-llm'` 做类型级 import（Node 侧），re-export 了 schema 的类型，并定义了 `AskUserQuestionOption/Item/AnswerItem/Answer`、`DagRunInfo`、`DagStartRequest`、`DagRun`、`DagRunStatus`、`DagInstanceState`、`ExecutedStepDefault`、`StageInfo`、`StepStatus`、`StageContract`、`PendingInteractionStatus`、`FinalizeOutcome`、`DagResultInfo`。文件头部注释自称「browser-safe 持久化类型」，但 `ContentBlock` 的 type-only import 仍指向 dsh-llm。

---

### 2. `workflow/src/yaml-parser.ts`（签名 / 依赖 / YAML 结构）

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/yaml-parser.ts`（234 行）

**依赖（第 11-14 行）**：
```ts
import { parseDocument, stringify, type YAMLError } from 'yaml'
import { SandoreError } from './errors.ts'
import { WorkflowDefinitionSchema, type DagBranch, type DagLoop, type WorkflowDefinition } from './schema.ts'
```
- `yaml`（^2.9.0）与 `zod`（^4.4.3）都是浏览器安全纯 JS（`workflow/package.json` 的 `dependencies`）。
- `./errors.ts` re-export `microflow/src/errors.ts`，其中 `SandoreError extends HarnessError`（`import { HarnessError } from '@deepseek-ai/dsh-llm'`）→ **Node 侧依赖**。`SandoreErrorCode` 含 `'YAML_PARSE'`、`'DEFINITION_INVALID'`、`'NODE_NOT_FOUND'`、`'CYCLE_DETECTED'`、`'STEP_TIMEOUT'`、`'STEP_EXECUTION'`、`'INVALID_OPERATION'`、`'CANCELLED'`、`'FINALIZE_FAILED'`、`'GATE_FAILED'`、`'SESSION_LOST'`、`'PERSISTENCE_FAILED'`。

**导出函数签名**：
- `convertLegacyToV2(raw: unknown): unknown`（第 112 行，导出）—— 检测 V1 `stages[].scenarios[]` 并转换；同一 Stage 同时含 `steps[]` 与 `scenarios[]` 抛 `DEFINITION_INVALID`。
- `parseWorkflowYaml(text: string): WorkflowDefinition`（第 207 行，导出）—— 流程：`parseDocument(text, { prettyErrors: true })` → 语法错误抛 `SandoreError('YAML_PARSE')` → `convertLegacyToV2` → `WorkflowDefinitionSchema.parse`（失败抛 `SandoreError('DEFINITION_INVALID', { cause: ZodError })`）→ `validateReferences`（`next`/`branches[].next`/`loop.next`/`loop.exitTo` 引用完整性 + `stage.next` 必须指向 Stage + `inputFrom[].path` 前两段存在）。
- `serializeWorkflowYaml(definition: WorkflowDefinition): string`（第 231 行，导出）—— 即 `stringify(definition)`，可 round-trip。

**YAML V2 结构（据 yaml-parser.spec.ts 中锁定样例）**：顶层 `id/name/version/description/engine/skills[]/mcps[]/agents[]/settings{defaultTimeout,maxConcurrentAgents}/rules{}/gates{}` + `stages[]`（Stage 级 rules/gates/next/defaultExpectation/condition/branches[]/loop{} + `steps[]` 仅 id+流控字段）+ 顶层 `steps[]`（完整定义：id/name/command{type,value}/inputFrom[]/outputTo[]/passThroughVars[]/timeout/rules[]/gates{}，command 5 变体）。V1 旧 `prompt.type`（Bash/PromptTemplate/AgentTemplate/SkillTemplate/McpTemplate）→ V2 `command.type`（shell/prompt/agent/skill/mcp）。

---

### 3. `workflow/package.json` exports 现状

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/package.json`

```json
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./types": { "types": "./lib/types/types.d.ts", "default": "./lib/types/types.js" },
  "./typert": { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
  "./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" },
  "./src/*": "./src/*",
  "./package.json": "./package.json"
},
"files": [
  "lib/index.js", "lib/types/**/*.js", "lib/types/**/*.d.ts",
  "lib/typert.host.js", "lib/typert.host.d.ts",
  "lib/typert.remote-client.js", "lib/typert.remote-client.d.ts"
]
```
- 目前**无** `./schema`、`./yaml` 子路径。
- `tsdown.config.ts`：`entry: ['src/index.ts']`、`outDir: 'lib'`、`format: ['esm']`、`platform: 'node'`、`target: 'es2024'`、`dts: false`、`clean: false`、`plugins: [typertPlugin({ faces: ['host'] })]`。
- 实际构建产物（`lib/`）只有：`index.js`（5431 行，tsdown 打包整个 `src/index.ts`，但 `@deepseek-ai/dsh-llm`/`dsh-storage-domain`/`zod`/`yaml`/`cordis`/`schemastery`/`dsh-typert-protocol`/`dsh-session` 均作为外部 import 保留）、`typert.host.js/.d.ts`、`typert.remote-client.js/.d.ts`。**没有 `lib/types/` 目录**，因此 `main.types`（`lib/types/index.d.ts`）与 `./types` 子路径当前指向不存在的文件（types 未生成，typecheck 脚本是 `tsc --noEmit`）。

---

### 4. DSH `ui-primitives` 可用组件与图标

已安装包：`@deepseek-ai/dsh-client-ui-primitives`（源码参考：`D:/project-code/llm/deepseek-harness/packages/client/ui-primitives/src/`）

**顶层导出（`lib/types/index.d.ts` / `src/index.ts`）**：`StateDot`（+`StateDotState`）、`DisclosureRow`（+`DisclosureRowProps`）、`Button`（+`ButtonVariant`）、`Pill`、`Input`、`Menu`（+`MenuEntry/MenuItem/MenuSeparator/MenuLabel`）、`useAnchoredMaxHeight`、`HoverCard`、`Modal`、`OnboardingSurface`、`RiskConfirmation`（+props）、`ConnectionBanner`、`FishLogo`、`BrandWordmark`、`Tooltip`（+`TooltipSide`）、`Toast`、`writeClipboard`、`JsonTree`（+props）、`TerminalBlock`/`ReadBlock`/`DiffBlock`/`SearchBlock`/`WebBlock`（各 + props/labels）、`CodeBlock`（+`CodeBlockProps`）、`JsonBlock`、`MarkdownText`（+`MarkdownCodeLabels/MarkdownFileMentions`）、`MessageText`、`extractMarkdownPlainText`、`export * from './icons/index.tsx'`。

**关键组件 props（用于 DAG 简化可视化/编辑器）**：
- `StateDot`：`{ state: 'done'|'warning'|'ongoing'|'error', size?: number(默认10), className? }`，纯 SVG/span，`aria-hidden`。
- `DisclosureRow`（`DisclosureRowProps`）：`{ icon: ReactNode, title: string, open: boolean, expandable: boolean, onToggle: () => void, expandOnRowClick?, previewChevron?, keepContentWhenOpen?, collapsedContent?, children?, className?, rowClassName?, leadingClassName?, chevronClassName?, titleClassName? }` —— 24px 折叠行 chrome，是 ui-workflow-run 列表的核心。
- `Button`：`{ variant?: 'primary'|'ghost'|'outline'|'toolbar'(默认ghost), size?: 'md'|'sm'(默认md), icon?: ReactNode(16px), className?, children? } & ButtonHTMLAttributes`。
- `Input`：`{ icon?: ReactNode, className? } & InputHTMLAttributes`（单行文本，非 composer textarea）。
- `Pill`：`{ active?: boolean(默认false), className?, children? } & ButtonHTMLAttributes`；无 `onClick` 时渲染静态 `span`，有 `onClick` 时渲染 `button`。
- `Menu`（受控下拉）：`{ open, anchor: ReactNode, items: readonly MenuEntry[], footer?, selectedId?, selectedIds?, onSelect(id), onClose(), align?: 'start'|'end', side?: 'bottom'|'top'|'right', portal?, closeOnPointerLeave?, dense?, compact?, getAnchorRect?, className? }`；`MenuItem = { id, label, disabled?, icon?, danger?, submenu? }`、`MenuSeparator = { type:'separator', id }`、`MenuLabel = { type:'label', id, text }`。
- `Modal`：`{ open, onClose, title, closeLabel?('Close'), description?, children?, footer?, className?, contentClassName?, headless? }`，portal 到 body。
- `CodeBlock`（`CodeBlockProps`）：`{ code: string, lang?, className?, copyLabel?('复制'), copiedLabel?('复制成功') }` —— shiki 高亮 + 语言 banner + 复制按钮，适合 YAML 预览（`lang="yaml"`）。
- `MarkdownText`：用于消息 markdown 渲染（导出 `MarkdownCodeLabels`/`MarkdownFileMentions` 类型）。

**图标（`src/icons/index.tsx`，`IconProps = { size?, className? }`，默认 fill=currentColor）**——与编辑器相关的现有图标：`IconBranchOutline16`、`IconEditOutline16`、`IconPlusOutline16`、`IconTrashOutline16`、`IconChevronDownOutline14`、`IconChevronLeftOutline14`、`IconChevronRightOutline14`、`IconChevronUpOutline14`、`IconTriangleRightFill14`、`IconCheckOutline14/16`、`IconCloseOutline16`/`IconCloseFill14`、`IconCopyOutline16`、`IconCodeOutline16`、`IconListPenOutline16`、`IconDataOutline16`、`IconPlayOutline16`、`IconPauseOutline16`、`IconRefreshOutline14/16`、`IconSparkle16`、`IconSearchOutline16`、`IconEllipsisOutline16`、`IconTreeCorner8x10`（会话树 "L" 连接角标，`viewBox="-0.5 0 8.5 10.5"`，专门用于层级连线示意）、`IconSendOutline14/16`、`IconQueueOutline14` 等（约 73 个）。注意 `IconTreeCorner8x10` 目前只在 ui-primitives 内部定义，未被业务包引用。

---

### 5. `ui` 包现有组件结构范式

包：`@deepseek-ai/dsh-client-ui-sandore`，目录 `D:/project-code/llm/sandore/packages/sandore/ui/`

现有文件：`src/index.ts`（Host 半空 `apply`）、`src/css-modules.d.ts`、`src/client/{index.ts, locales.ts, remote.ts, WorkflowButton.tsx, WorkflowButton.module.css, WorkflowPanel.tsx, WorkflowPanel.module.css, remote.spec.ts}`。

**Client 入口 `src/client/index.ts`**：`export const inject = ['slots', 'locale', 'remote']`；`apply(ctx)` 里 `ctx.effect(() => ctx.locale.register(NS, { zh, en }))`、`ctx.effect(() => ctx.remote.$mount(sandoreRemote))`、`ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name, id: 'sandore-btn', locale: NS, inject: () => sandore }, WorkflowButton))`，其中 `sandore = { ping: async () => unwrap(await ctx.remote.sandore.ping()) }`。

**remote 薄封装 `src/client/remote.ts`**：`import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote'`（default import typert 生成贡献）、`export class SandoreRemoteError extends Error { code, details }`、`export function unwrap<T>(result: RemoteResult<T>): T`（`ok` 取 value，否则抛 `SandoreRemoteError`）。`RemoteResult`/`RemoteFailure` 来自 `@deepseek-ai/dsh-typert-protocol`。

**Props 类型组合范式**（WorkflowButton.tsx）：
```ts
export interface WorkflowButtonFace { ping(): Promise<PingResponse> }
export type WorkflowButtonProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>
export function WorkflowButton({ wide, ping, t }: WorkflowButtonProps) { ... }
```
- `PropsRuntime<K>`/`InjectFace<I>`/`PropsLocale<N>`/`TranslateNS<N>`/`ComposedProps<...>` 均来自 `@deepseek-ai/dsh-client-ui-slots`（`lib/types/index.d.ts`）。
- `PropsLocale<N>` 注入类型化 `t: TranslateNS<N>`；`LocaleNamespaceMap` 通过 `locales.ts` 的 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { sandore: SandoreKey } }` 声明。
- `WorkflowPanel.tsx` 则不用 slot props，直接定义最小 face：`export interface WorkflowPanelProps { t: TranslateNS<'sandore'>; ping(): Promise<PingResponse> }`（由父组件把 `t`/`ping` 传下去）。

**locales 范式 `src/client/locales.ts`**：`export const NS = 'sandore'`、`export const zh = { 'button.trigger': '工作流', ... } satisfies Record<string, string>`、`export type SandoreKey = keyof typeof zh`、`declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { sandore: SandoreKey } }`、`export const en = {...} satisfies Record<SandoreKey, string>`（逐键对齐，缺一编译错）。

**CSS Modules 范式**：`import css from './WorkflowPanel.module.css'`，类名用 `css.xxx`；`src/css-modules.d.ts` 声明 `declare module '*.module.css'` 与 `declare module '*.css'`。样式全部使用 DSH theme token（`var(--dsw-alias-bg-base)`、`var(--dsw-alias-border-l2)`、`var(--dsw-alias-label-primary)`、`var(--dsw-alias-state-error-primary)`、`var(--dsh-font-mono)` 等）。`WorkflowPanel.module.css` 展示了固定定位浮出面板（`position: fixed; left: 12px; bottom: 128px; z-index: 30; width: 420px`）与三态列表行（`StateDot` + rowName + rowStatus 徽章）。

**tsconfig**：`ui/tsconfig.json` 有 `"jsx": "react-jsx"`、`rootDir: src`、`outDir: lib/types`；`ui/package.json` 无 `build` 脚本（仅 `typecheck`），exports 声明了 `./client` → `./lib/client.js`（当前无 lib 产物，由 DSH 构建系统按 `dsh.client` 声明打包）。peerDependencies 含 `react ^18.2.0` 与全套 `@deepseek-ai/dsh-client-*`。

---

### 6. DSH「节点列表 + 连线示意」参考（ui-workflow-run / ui-trajectory）

参考源码仓库：`D:/project-code/llm/deepseek-harness`

**（a）`packages/client/ui-workflow-run` —— 最贴近的「节点列表」参考**。`src/client/WorkflowRunPanel.tsx`（273 行）+ `WorkflowRunPanel.module.css`（255 行）：
- 用 `DisclosureRow` 做两级嵌套折叠：`RunHeader`（run 级，`icon={<IconChevronRightOutline14 />}` + `expandOnRowClick` + `previewChevron={false}` + `keepContentWhenOpen` + `collapsedContent` 里放「成员数 + 状态 tail」）→ `PhaseSection`（phase 级 DisclosureRow）→ `MemberRow`（成员行）。
- 状态用 `StateDot`（`dotState(status)` 映射 running→ongoing / completed→done / failed→error / cancelled·interrupted→warning）。
- **层级/连线通过 CSS 缩进表达**，不是画 SVG 边：`.phaseList { padding: 4px 0 0 16px }`、`.members { padding: 0 0 0 16px }`、`.dotSlot { width:16px; height:24px }`；`member` 可点击时用 `button` + `memberLabel` 下划线（business-primary 色），非点击用 `div`。
- props 类型：`WorkflowRunPanelProps = PropsRuntime<'conversation.chat.node', 'workflow-run'> & PropsLocale<'workflowRun'> & WorkflowRunInjected`（keyed slot 的 PropsRuntime 带第二个 EntryKey 参数），`WorkflowRunInjected = { openSession(id) }`，内部用 `useSessions(selector, shallowEqual)` 读会话状态。
- 这是 D8 决策里「复用 ui-workflow-run 的 Chat 节点机制」的直接来源，也是「列表 + 缩进层级」式简化可视化的现成范例。

**（b）`packages/client/ui-trajectory` —— 「连线示意」参考（时间轴式，非 DAG）**：
- `src/client/TrajectoryTimeline.tsx` + `.module.css`：横向 overview 时间轴，用 CSS 变量定位（`--trajectory-span-left/width/lane`）画 span 块，`turnBoundary` 是 1px 竖线（`background: var(--dsw-alias-border-l2)`），hoverLine/selection 是绝对定位竖条。适合「泳道/轨道 + 线段」示意，但不是节点 DAG。
- `src/client/layout.ts`（约 1100 行）是数据折叠层（turn → Message/Step groups → cells），不含连线绘制。
- `IconTreeCorner8x10`（ui-primitives）是会话树的 "L" 连接角标，可作层级连线示意素材（当前无业务包引用）。
- 说明：DSH 里**没有** React Flow / Dagre 依赖（设计文档 `task-5-frontend/design.md` §2 已确认「DSH 前端依赖里未必包含 React Flow」，原 sandore 前端用 React Flow+Dagre 仅作语义参考）。「节点列表 + 连线示意」的 DSH 现成做法即 ui-workflow-run 的 DisclosureRow 缩进层级 + StateDot 状态。

---

### 7. `ctx.remote.sandore.*` 的 wire 类型（定义/Job/YAML 相关）

**Host 侧定义**（`workflow/src/remote.ts`，`SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')`）：
- `WorkflowDefinitionEntry extends WorkflowDefinitionRecord { id: string }`（导出，第 24 行）
- `JobEntry extends JobRecord { id: string }`（导出，第 29 行）
- `CreateDefinitionInput = z.infer<CreateDefinitionInputSchema>`，`CreateDefinitionInputSchema = z.object({ yaml: z.string() })`（第 55-57、144 行，导出类型）
- `UpdateDefinitionInput` = `{ name?, version?, description? }`（第 60-64、145 行，导出类型）
- **`updateYaml` 没有独立入参类型**：`@Remote('updateYaml') updateYaml(id: string, yaml: string): Promise<WorkflowDefinitionEntry>`（第 257-272 行）—— 两个位置参数，非对象入参。
- 其余导出 wire 类型：`CreateJobInput`/`UpdateJobInput`/`StartInstanceInput`/`ReplyQuestionInput`/`ReplyPermissionInput`/`PauseStepInput`/`ResumeStepInput`/`PauseAllInput`/`ResumeAllInput`/`RetryStepInput`、`InstanceSummary`、`ArtifactEntry`、`PingResponse`。

**RPC 方法（`@Remote` 名称，供 `ctx.remote.sandore.*` 调用）**：`ping`、`listDefinitions(): WorkflowDefinitionEntry[]`、`createDefinition(input: { yaml }): Promise<WorkflowDefinitionEntry>`、`updateDefinition(id, input)`、`deleteDefinition(id)`、`getYaml(id): string`、`updateYaml(id, yaml): Promise<WorkflowDefinitionEntry>`、`listJobs(workflowId?)`、`createJob`/`getJob`/`updateJob`/`deleteJob`、`listInstances(jobId?)`、`startInstance(input)`、`deleteInstance`/`getInstanceState`/`abortInstance`、`replyQuestion`/`replyPermission`、`pauseStep`/`resumeStep`/`pauseAll`/`resumeAll`/`retryStep`、`getArtifacts`、`listProviders`/`listModels`。

**生成后的客户端类型**（`workflow/lib/typert.remote-client.d.ts`，`declare module '@deepseek-ai/dsh-typert-protocol'`）——这是浏览器侧 `ctx.remote.sandore.*` 的真实签名：
```ts
interface TypertRemoteNamespace$73616e646f7265 {
  listDefinitions: () => Promise<RemoteResult<WorkflowDefinitionEntry[]>>
  createDefinition: (input: { yaml: string }) => Promise<RemoteResult<WorkflowDefinitionEntry>>
  updateDefinition: (id: string, input: { name?: string; version?: string; description?: string }) => Promise<RemoteResult<WorkflowDefinitionEntry>>
  deleteDefinition: (id: string) => Promise<RemoteResult<boolean>>
  getYaml: (id: string) => Promise<RemoteResult<string>>
  updateYaml: (id: string, yaml: string) => Promise<RemoteResult<WorkflowDefinitionEntry>>
  ...
}
interface TypertRemoteNamespaceMap { 'sandore': TypertRemoteNamespace$73616e646f7265 }
```
同时生成 `TypertRemoteMap`（`'sandore/getYaml'` 等扁平 key）。生成文件里 `WorkflowDefinitionRecord`/`WorkflowDefinitionEntry`/`JobRecord`/`JobEntry`/`InstanceSummary`/`ArtifactEntry`/`DagRun`/`PingResponse` 均为 `readonly` 字段的结构类型；`getInstanceState` 返回 `unknown`、`replyQuestion.answers` 为 `unknown`（typert 生成器对复杂对象做了降级）。

**调用范式**（`ui/src/client/index.ts` + `remote.ts`）：`import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote'` → `ctx.remote.$mount(sandoreRemote)` → `unwrap(await ctx.remote.sandore.listDefinitions())`。注意设计文档中的 `host.call('sandore.*')` 是旧写法，实际持久化插件用 `ctx.remote.sandore.*`（typert 生成贡献）。

---

### 附：与拆分直接相关的依赖安全清单（事实记录）

| 依赖 | 位置 | 浏览器安全 |
|---|---|---|
| `zod` ^4.4.3 | workflow `dependencies` | 是（纯 JS） |
| `yaml` ^2.9.0 | workflow `dependencies` | 是（纯 JS） |
| `@deepseek-ai/dsh-storage-domain` | schema.ts 顶部 `defineDomain/domainTable` | 否（cordis/storage/schemastery） |
| `@deepseek-ai/dsh-llm` | errors 链（`HarnessError`）+ types.ts `ContentBlock` type-only | 否（cordis 等） |
| `@deepseek-ai/cordis` / `schemastery` / `dsh-session` / `dsh-typert-protocol` | 引擎/seam/remote 层 | 否（Host 侧） |

`workflow/lib/index.js` 打包产物把上述 Node 依赖全部保留为外部 import（tsdown 未内联），故当前 `@deepseek-ai/dsh-sandore-workflow` 的默认入口与 `./src/schema` 入口均非浏览器安全；浏览器安全拆分需要让「定义层 schema + yaml 解析」脱离 `dsh-storage-domain`（`sandoreDomainSpec`）与 `dsh-llm`（`SandoreError` 的 `HarnessError` 基类）两条依赖链。
