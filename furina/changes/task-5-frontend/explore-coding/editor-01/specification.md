# 探索结果 — editor-01 DagEditor 编排器 + workflow schema/yaml 浏览器安全拆分

## 需求理解（Phase 2）

- **What**：在 sandore `ui` 包新增 `DagEditor` 组件（Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存），并把 `workflow` 包的定义层 zod schema 与 YAML 解析/序列化拆成浏览器安全模块（`./schema`、`./yaml` 子路径导出），供 UI 包复用。
- **Boundaries**：`packages/sandore/workflow`（schema.ts、yaml-parser.ts、package.json、lib 构建产物）与 `packages/sandore/ui`（现有组件范式、remote.ts）；DSH 参考 `D:\project-code\llm\deepseek-harness\packages\client\ui-primitives`、`ui-workflow-run`、`ui-trajectory`、`storage\storage-domain`。
- **Goal**：摸清「定义层 schema 与 Node 侧存储域的耦合点」「YAML 解析/序列化签名与依赖」「package.json exports 现状」「DSH 可复用组件/图标」「ui 包现有 props/样式/locale 范式」「DSH 节点列表+连线示意参考」「ctx.remote.sandore 的 wire 类型」，为后续拆分与 DagEditor 实现提供事实依据。

> 说明：`furina config show exploration.specification` 返回空数组（`exploration.specification=[]`），无外部 specification materials 配置，故全部依据项目实际代码 + DSH 源码探索。

---

## 1. `workflow/src/schema.ts` 当前结构

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`（444 行）

顶部注释明确三层：**定义层** / **运行时层** / **存储层**。

### 1.1 唯一的 Node 侧 import

```ts
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
```

`schema.ts` 只有两行 import，其中 `@deepseek-ai/dsh-storage-domain` 是 Node 侧依赖（其内部 import `@deepseek-ai/cordis`、`@deepseek-ai/dsh-storage`、`@deepseek-ai/schemastery`——见 `D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\index.ts` 与 `src\spec.ts`）。`zod` 是纯 JS，浏览器安全。

### 1.2 定义层（纯 zod，不依赖 Node 侧）

| Schema | 位置 | 说明 |
|---|---|---|
| `StepStatusSchema`（未导出 const） | L15 | Step/Stage 共用状态枚举 |
| `DagRunStatusSchema`（未导出 const） | L18 | 实例生命周期枚举 |
| `ContentBlockSchema`（未导出 const） | L24 | `z.looseObject({ type: z.string() })` |
| `CommandConfigSchema` | L32 | 5 变体 discriminated union（agent/prompt/shell/skill/mcp），判别字段 `type`，值整体嵌 `value` |
| `InputFromItemSchema` | L68 | `{ id, path?, regex? }` |
| `OutputToItemSchema` | L75 | `{ id, path?, regex? }` |
| `PassThroughVarSchema` | L82 | `{ name, value, description, refresh? }` |
| `PassThroughVarValueSchema`（未导出 const） | L90 | `{ value, description, refresh? }` |
| `DagBranchSchema` | L97 | `{ expectation?, next, label? }` |
| `DagLoopSchema` | L104 | `{ breakCondition?, breakExpectation?, next?, maxIterations, exitTo? }` |
| `GatesSchema` | L113 | `{ maxRetries?, maxTokens?, primary?, secondary?, need_confirm? }` |
| `DEFAULT_SETTINGS`（const） | L122 | `{ defaultTimeout: 120, maxConcurrentAgents: 4 }` |
| `WorkflowSettingsSchema` | L128 | `{ defaultTimeout(default 120), maxConcurrentAgents(default 4) }` |
| `WorkflowStepSchema` | L134 | Step 完整定义（id/name/command/inputFrom/outputTo/passThroughVars/timeout/next/defaultExpectation/condition/branches/loop/rules/gates） |
| `WorkflowStageSchema` | L152 | `{ id, name, rules?, gates?, steps[](必填), next?, defaultExpectation?, condition?, branches?, loop? }` |
| `WorkflowDefinitionSchema` | L166 | `{ id, name, version, description?, engine?, skills[](default []), mcps[](default []), agents[](default []), settings(default), rules?, gates?, stages[](必填), steps[]? }` |

定义层派生类型（L420-430）：`CommandConfig`、`InputFromItem`、`OutputToItem`、`PassThroughVar`、`DagBranch`、`DagLoop`、`Gates`、`WorkflowSettings`、`WorkflowStep`、`WorkflowStage`、`WorkflowDefinition`。

### 1.3 运行时层（纯 zod，不依赖 Node 侧）

`StepSessionMetaSchema`、`AskUserQuestionPayloadSchema`、`PendingInteractionStatusSchema`、`PendingQuestionEntrySchema`、`PendingPermissionPayloadSchema`、`PendingPermissionEntrySchema`、`FinalizeAssessResultSchema`、`GateEvalResultSchema`、`FinalizeMetaSchema`、`BranchMetaSchema`、`SessionMessageSchema`、`RetryRecordSchema`、`ExecutedStepDefaultSchema`、`StageInfoSchema`、`StageContractSchema`、`WorkflowTaskStateSchema`（L184-384）。

### 1.4 存储层（依赖 Node 侧）

- `WorkflowDefinitionRecordSchema`（L389）：`{ yaml: z.string().max(65536), name, version, description?, createdAt, updatedAt }` —— 纯 zod，本身不依赖 Node 侧。
- `JobRecordSchema`（L399）：`{ name, workflowId, cwd?, createdAt, updatedAt }` —— 纯 zod。
- `sandoreDomainSpec`（L408-416）：**唯一使用 `defineDomain`/`domainTable` 的位置**，声明三表：
  ```ts
  export const sandoreDomainSpec = defineDomain({
    name: 'sandore',
    version: 1,
    tables: {
      definitions: domainTable<string, WorkflowDefinitionRecord>(WorkflowDefinitionRecordSchema),
      jobs: domainTable<string, JobRecord>(JobRecordSchema),
      state: domainTable<string, WorkflowTaskState>(WorkflowTaskStateSchema),
    },
  })
  ```

### 1.5 拆分结论（事实层面）

- 定义层（§1.2）+ 运行时层（§1.3）全部是纯 `zod`，**不 import 任何 Node 侧模块**，可直接抽为浏览器安全模块。
- 存储层中 `WorkflowDefinitionRecordSchema`/`JobRecordSchema` 也纯 zod；仅 `sandoreDomainSpec`（L11 import + L408 定义）耦合 `@deepseek-ai/dsh-storage-domain`。
- `defineDomain`/`domainTable` 签名（来自 DSH `spec.ts`）：`domainTable<K extends string, V>(schema: ZodType<V>)` 返回 `DomainTableSpec<K, V>`；`defineDomain<S extends DomainSpec>(spec: S): S` 做名字/版本/表名校验并原样返回。`DomainSpec = { name, version, global?, tables: Record<string, DomainTableSpec> }`。
- 因此「定义层 schema 不依赖 Node 侧」的拆分点 = 把 `sandoreDomainSpec`（及其 `defineDomain`/`domainTable` import）留在 Node 侧入口，定义层 + 运行时层 schema 移到浏览器安全入口即可；`yaml-parser.ts` 只 import 了 `WorkflowDefinitionSchema` 与 `DagBranch`/`DagLoop`/`WorkflowDefinition` 类型，也天然可浏览器安全。

---

## 2. `workflow/src/yaml-parser.ts`

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/yaml-parser.ts`（234 行）

### 2.1 import 依赖

```ts
import { parseDocument, stringify, type YAMLError } from 'yaml'
import { SandoreError } from './errors.ts'
import { WorkflowDefinitionSchema, type DagBranch, type DagLoop, type WorkflowDefinition } from './schema.ts'
```

- `yaml`（^2.9.0）与 `zod` 都是纯 JS，浏览器安全。
- `./errors.ts` 里的 `SandoreError extends HarnessError`——需注意 `HarnessError` 来自 `@deepseek-ai/dsh-llm`。若 `./yaml` 子路径要浏览器安全，需确认 `errors.ts` 的依赖链（见 §2.5）。

### 2.2 导出函数签名

```ts
export function parseWorkflowYaml(text: string): WorkflowDefinition
export function serializeWorkflowYaml(definition: WorkflowDefinition): string
export function convertLegacyToV2(raw: unknown): unknown   // 同时导出
```

流程（`parseWorkflowYaml`）：
1. `parseDocument(text, { prettyErrors: true })`，`document.errors.length > 0` 抛 `SandoreError('YAML_PARSE')`；
2. `convertLegacyToV2(document.toJS())`——V1 `stages[].scenarios[].tasks[]` 自动转 V2 `stages[].steps[]`（`convertStage`/`convertTaskToStep`，`PromptConfig.type` 映射 `Bash→shell/PromptTemplate→prompt/AgentTemplate→agent/SkillTemplate→skill/McpTemplate→mcp`，未知回退 `prompt`）；同 Stage 混用 `steps[]`+`scenarios[]` 抛 `DEFINITION_INVALID`；
3. `WorkflowDefinitionSchema.parse(data)` 失败抛 `SandoreError('DEFINITION_INVALID', { cause })`；
4. `validateReferences(definition)`：校验 `next`/`branches[].next`/`loop.next`/`loop.exitTo` 引用完整性、`stage.next` 必须指向 Stage（指向 Step 会抛错）、`inputFrom[].path` 的 `stageId[.stepId[.outputToId]]` 前两段存在（契约引用 `${...}` 跳过）。

`serializeWorkflowYaml(definition)` = `stringify(definition)`（`yaml` 包默认 stringify）。

### 2.3 YAML 结构（实际代码，V2 两层）

`yaml-parser.spec.ts`（`D:/project-code/llm/sandore/packages/sandore/workflow/src/yaml-parser.spec.ts` L10-60）的 `v2Yaml` 为权威样例，**顶层是平铺字段、无 `workflow:` 包裹键**：

```yaml
id: wfl-...          # 顶层（对应 WorkflowDefinitionSchema.id）
name: 全字段代码审查工作流
version: "2.0.0"
description: ...
engine: v2
skills: [code-review-skill]
mcps: [filesystem-mcp]
agents: [code-reviewer]
settings: { defaultTimeout: 60, maxConcurrentAgents: 4 }
rules: { chinese-output: "所有输出必须使用中文" }
stages:
  - id: stg-1
    name: 代码分析
    steps:          # stages[].steps[]：仅 id + 流控字段（next/branches/loop/condition）
      - id: step-1
        next: step-2
      - id: step-2
  - id: stg-2
    steps: [{ id: step-3 }]
steps:              # 顶层 steps[]：完整定义（含 command/inputFrom/outputTo 等）
  - id: step-1
    name: 静态分析
    command: { type: shell, value: { command: "npm run lint 2>&1" } }
    outputTo: [{ id: opt-1, path: reports/lint.txt }]
  - id: step-2
    command: { type: agent, value: { promptText: code-reviewer, agentParamsTemplate: "审查重点" } }
  - id: step-3
    command: { type: prompt, value: { promptText: "生成报告" } }
```

命令 5 变体：`command: { type: <agent|prompt|shell|skill|mcp>, value: {...} }`；`agent.value = { promptText, agentParamsTemplate?, providerId?, modelId? }`、`prompt.value = { promptText, providerId?, modelId? }`、`shell.value = { command }`、`skill.value = { promptText, providerId? }`、`mcp.value = { promptText }`。

### 2.4 与设计文档的差异（重要事实）

`docs/design/task-5-frontend/design.md` §5.9 的 V2 YAML 示例用了一个顶层 `workflow:` 包裹键（`workflow:\n  id: wfl-xxx ...`），但**实际实现的 `WorkflowDefinitionSchema` 是平铺结构（`id`/`name`/`stages`/`steps` 为顶层字段，无 `workflow` 包裹）**，`parseWorkflowYaml` 直接对 `document.toJS()` 结果做 `WorkflowDefinitionSchema.parse`。exploreContent 里「workflow.id」应理解为「WorkflowDefinition 的 `id` 字段」，而非字面 `workflow:` YAML 键。

### 2.5 `errors.ts` 依赖链（浏览器安全需注意点）

`yaml-parser.ts` 依赖 `./errors.ts`。`lib/index.js` 打包产物首行显示 `SandoreError extends HarnessError`，`HarnessError` 来自 `@deepseek-ai/dsh-llm`。`SandoreError` 源码实际下沉在 `packages/sandore/microflow/src/errors.ts`（workflow 包经 re-export 保持 API）。`lib/index.js` 顶部 import 了 `BlockAssembler, HarnessError, createUserMessage from "@deepseek-ai/dsh-llm"` 等 Node 侧运行时。若 `./yaml` 要真正浏览器安全，`SandoreError`（或其对 `HarnessError` 的继承）是需处理的边界事实。

---

## 3. `workflow/package.json` exports 现状

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/package.json`

```json
{
  "name": "@deepseek-ai/dsh-sandore-workflow",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".":            { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./types":      { "types": "./lib/types/types.d.ts", "default": "./lib/types/types.js" },
    "./typert":     { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
    "./remote":     { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.js", "lib/types/**/*.d.ts",
            "lib/typert.host.js", "lib/typert.host.d.ts",
            "lib/typert.remote-client.js", "lib/typert.remote-client.d.ts"],
  "dependencies": { "yaml": "^2.9.0", "zod": "^4.4.3" },
  "peerDependencies": { "@deepseek-ai/cordis": "4.0.1", "@deepseek-ai/dsh-sandore-microflow": "workspace:*",
    "@deepseek-ai/dsh-session": "0.1.0-rc.6", "@deepseek-ai/dsh-session-title": "0.1.0-rc.6",
    "@deepseek-ai/dsh-llm": "0.1.0-rc.6", "@deepseek-ai/dsh-typert-protocol": "0.1.0-rc.6",
    "@deepseek-ai/dsh-agent": "0.1.0-rc.6", "@deepseek-ai/dsh-storage": "0.1.0-rc.6",
    "@deepseek-ai/dsh-storage-domain": "0.1.0-rc.6", "@deepseek-ai/dsh-subagent": "0.1.0-rc.6",
    "@deepseek-ai/dsh-subprocess": "0.1.0-rc.6", "@deepseek-ai/schemastery": "3.18.1" }
}
```

### 3.1 构建配置

- `tsdown.config.ts`：单入口 `src/index.ts` → `lib/index.js`，`format: ['esm']`、`platform: 'node'`、`dts: false`、`clean: false`，插件 `typertPlugin({ faces: ['host'] })` 生成 `lib/typert.host.js/.d.ts` 与 `lib/typert.remote-client.js/.d.ts`。
- `tsconfig.json`：`rootDir: ".."`、`outDir: "lib/types"`（`types` 字段指向的 `lib/types/index.d.ts` 由 `tsc` 产出）。
- **当前 `lib/` 实际只有 4 个文件**：`index.js`、`typert.host.js/.d.ts`、`typert.remote-client.js/.d.ts`（`lib/types` 目录当前未检出，可能 gitignore 或未构建）。`lib/index.js` 是单文件 bundle，已把 `defineDomain/domainTable`（`@deepseek-ai/dsh-storage-domain`）、`yaml` 的 `parseDocument/stringify`、`zod` 等全部打进一个文件。

### 3.2 需新增的 `./schema`、`./yaml` 子路径（事实基础）

- 现有 `./types` 子路径是「纯 type 文件」（`lib/types/types.d.ts`，`types.ts` 声明只 `import type`），可作为 `./schema`/`./yaml` 子路径的范式参考。
- 若新增 `./schema`、`./yaml`，需在 `exports` 增加对应条目，并在 `files` 补充打包产物；`tsdown` 需多入口（`entry: ['src/index.ts', 'src/schema.ts', 'src/yaml-parser.ts']`）或独立入口文件，且 `platform` 需区别于 Node 侧入口（当前整体 `platform: 'node'`）。

---

## 4. DSH `ui-primitives` 可复用组件与 icons

包位置：`D:\project-code\llm\deepseek-harness\packages\client\ui-primitives`，包名 `@deepseek-ai/dsh-client-ui-primitives`。入口 `src/index.ts` 导出全部组件。

### 4.1 可直接用于 DAG 简化的组件（props 摘要）

- **`StateDot`**（`StateDot.tsx`）：`props = { state: StateDotState; size?; className? }`，`StateDotState = 'done' | 'warning' | 'ongoing' | 'error'`（绿/琥珀/蓝运行环/红）。DAG 节点状态点可直接映射 Step/Stage 状态。
- **`DisclosureRow`**（`DisclosureRow.tsx`）：受控折叠行。`DisclosureRowProps = { icon: ReactNode; title: string; open: boolean; expandable: boolean; onToggle: () => void; expandOnRowClick?; previewChevron?; keepContentWhenOpen?; collapsedContent?; children?; className?; rowClassName?; leadingClassName?; chevronClassName?; titleClassName? }`。是「节点列表」折叠层级的核心组件（ui-workflow-run 即用它做 Stage/Step 分层）。
- **`Button`**（`Button.tsx`）：`{ variant?: 'primary'|'ghost'|'outline'|'toolbar' (default 'ghost'); size?: 'md'|'sm'; icon?: ReactNode; className?; children? } & ButtonHTMLAttributes<HTMLButtonElement>`。
- **`Input`**（`Input.tsx`）：`{ icon?: ReactNode; className? } & InputHTMLAttributes<HTMLInputElement>`，包装 `<span>` 内原生 `<input>`。
- **`Pill`**（`Pill.tsx`）：`{ active?; className?; children?; onClick? } & ButtonHTMLAttributes<HTMLButtonElement>`；有 `onClick` 渲染 `<button>`，否则静态 `<span>`。适合「命令类型/视图切换/状态徽章」。
- **`Menu`**（`Menu.tsx`）：受控下拉。`MenuEntry = MenuItem | MenuSeparator | MenuLabel`；`MenuItem = { id, label, disabled?, icon?, danger?, submenu? }`；`MenuSeparator = { type:'separator', id }`；`MenuLabel = { type:'label', id, text }`。owner 控制 `open`/`onClose`/`onSelect`，支持 `portal`、`align`、`side`、`dense`、`compact`。
- **`Modal`**（`Modal.tsx`）：`{ open; onClose; title; closeLabel?; description?; children?; footer?; className?; contentClassName?; headless? }`，portal 到 body，Escape/遮罩关闭。适合 Step 编辑弹层。
- **`CodeBlock`**（`markdown/CodeBlock.tsx`）：`CodeBlockProps = { code: string; lang?; className?; copyLabel?; copiedLabel? }`，shiki 高亮 + 复制按钮（默认文案「复制/复制成功」）。YAML 预览可直接用（`lang="yaml"`，未注册 grammar 走纯文本 fallback）。
- **`MarkdownText`**（`markdown/MarkdownText.tsx`）：`MarkdownCodeLabels`、`MarkdownFileMentions` 类型一并导出。
- **`Tooltip`**（`Tooltip.tsx`）：`TooltipSide`；`Toast`、`HoverCard`、`JsonTree`、`writeClipboard` 等也导出。

### 4.2 图标（`src/icons/index.tsx`，`export *` 全部）

`IconProps = { size?: number; className?: string }`（fill=currentColor）。与 DAG/编排相关的可用图标（完整清单 68 个，见文件，此处列关键）：

`IconBranchOutline16`（已用于 WorkflowButton）、`IconPlusOutline16`、`IconChevronDownOutline14`、`IconChevronRightOutline14`、`IconChevronLeftOutline14`、`IconChevronUpOutline14`、`IconTriangleRightFill14`（树展开箭头，open 态旋转 90°）、`IconCloseOutline16`、`IconCloseFill14`、`IconCheckOutline16`/`IconCheckOutline14`、`IconRefreshOutline16`/`IconRefreshOutline14`、`IconEditOutline16`、`IconTrashOutline16`、`IconPlayOutline16`、`IconPauseOutline16`、`IconCodeOutline16`、`IconDataOutline16`、`IconListPenOutline16`、`IconEllipsisOutline16`、`IconSearchOutline16`、`IconSettingsOutline14/16`、`IconWarningOutline16`、`IconTreeCorner8x10`、`IconLoadingOutline16`、`IconStopFill16`、`IconFolderOpenOutline16`、`IconCopyOutline16`、`IconDownloadOutline16` 等。

---

## 5. `ui` 包现有组件结构范式

包：`D:\project-code\llm\sandore\packages\sandore\ui`，包名 `@deepseek-ai/dsh-client-ui-sandore`。

### 5.1 文件结构与入口

- `src/index.ts`：Host 半空 `apply(): void {}`。
- `src/client/index.ts`：Client 入口。`inject = ['slots', 'locale', 'remote']`；`apply(ctx)` 里 `ctx.effect(() => ctx.locale.register(NS, { zh, en }))`、`ctx.effect(() => ctx.remote.$mount(sandoreRemote))`、`ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name, id:'sandore-btn', locale: NS, inject: (): WorkflowButtonFace => sandore }, WorkflowButton))`。
- `src/client/remote.ts`：`import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote'`；`SandoreRemoteError extends Error`（保留 `code`/`details`）；`unwrap<T>(result: RemoteResult<T>): T`（`ok` 取 value，否则抛）。

### 5.2 props 类型组合范式

- `WorkflowPanel.tsx`：`WorkflowPanelProps = { t: TranslateNS<'sandore'>; ping(): Promise<PingResponse> }`（最小业务 face）。
- `WorkflowButton.tsx`：`WorkflowButtonFace = { ping(): Promise<PingResponse> }`；`WorkflowButtonProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>`。
- 类型来源：`import type { TranslateNS, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'`。slot 注册的 `inject` 返回 face，`InjectFace<F>` 把 face 注入到 props。

### 5.3 locales.ts 范式

`src/client/locales.ts`：`export const NS = 'sandore'`；`zh`/`en` 两个 `Record<string, string>`（`en` 用 `satisfies Record<SandoreKey, string>` 保证逐键对齐）；`export type SandoreKey = keyof typeof zh`；并用 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { sandore: SandoreKey } }` 做模块增强，得到类型化 `t`。文案用 `t('key')` 与 `t('key', { message })` 插值。

### 5.4 css-modules 用法

- `src/css-modules.d.ts`：`declare module '*.module.css' { const classes: Record<string, string>; export default classes }` + `declare module '*.css'`。
- 组件里 `import css from './WorkflowPanel.module.css'`，用 `css.panel` 等类名；主题全走 `--dsw-*` token（如 `--dsw-alias-border-l1`、`--dsw-alias-bg-base`、`--dsw-alias-label-primary`、`--dsw-alias-state-error-primary`、`--dsw-shadow-lv2`、`--dsh-font-mono`）。
- 自定义 `data-*` 属性（`data-sandore-panel`、`data-sandore-btn`）用于样式/测试钩子。

### 5.5 构建

- `package.json`：`exports` 有 `.`（`lib/index.js`）与 `./client`（`lib/client.js` / `lib/types/client/index.d.ts`）两个子路径 + `./src/*`、`./package.json`；`dsh.client = { inject: [...], platform: 'web' }`。
- `scripts` 只有 `typecheck: tsc --noEmit`（无 build/tsdown 脚本）；`tsconfig.json` `rootDir: "src"`、`outDir: "lib/types"`、`jsx: "react-jsx"`。
- peerDependencies 含 `@deepseek-ai/dsh-sandore-workflow: workspace:*`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-sidebar`、`react ^18.2.0` 等。

---

## 6. DSH「节点列表 + 连线示意」参考

`docs/design/task-5-frontend/work.md` 明确：「**DAG 可视化**：先 `ui-primitives` 简化实现（节点列表 + 连线示意），React Flow 作为后续增强」；`design.md` §4.3 也写「简化实现：ui-primitives 节点列表 + 连线示意」。

### 6.1 ui-workflow-run 的「节点列表」参考（最直接）

文件：`D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\src\client\WorkflowRunPanel.tsx`

- 用 `DisclosureRow` + `StateDot` 做**嵌套分层节点列表**：`RunHeader`（外层 DisclosureRow，`icon=<IconChevronRightOutline14/>`、`expandOnRowClick`、`previewChevron={false}`、`keepContentWhenOpen`、`collapsedContent` 放成员数 + 状态尾缀）→ `PhaseSection`（Phase 级 DisclosureRow）→ `MemberRow`（每行 `<StateDot state={...}/>` + label + status 文本，可点击时渲染 `<button>`）。
- 状态→StateDot 映射函数 `dotState(status)`：`running→ongoing`、`completed→done`、`failed→error`、`cancelled/interrupted→warning`。
- `StatusDisclosure` 包装：非完成态需要展开时 `DisclosureRow open expandable={false}`；否则 `ManualDisclosure`（内部 `useState(open)`）。
- 数据层 `workflow-definition.ts` 定义 `WorkflowRunMemberData`/`WorkflowRunPhaseData`/`WorkflowRunChatData`，通过 `declare module` 注册 Chat node 数据映射。
- props 范式：`WorkflowRunPanelProps = PropsRuntime<'conversation.chat.node', 'workflow-run'> & PropsLocale<'workflowRun'> & WorkflowRunInjected`。
- package.json 同样有 `.`/`./client` 子路径 + `dsh.client` 声明。

### 6.2 ui-trajectory（连线示意风格参考，非 DAG）

- `TrajectoryTimeline.tsx` 是「Chrome-Network 风格横向时间轴」（lanes + span 块 + hover 竖线 + 选区），`TrajectoryTable.tsx`/`TrajectoryTurn.tsx` 是表格/回合树。**没有现成的「DAG 有向边 + 连线」组件**，DSH 里 DAG 连线的简化示意需用 CSS 自绘（如 `--dsw-*` token + 竖线/折线边框，参考 `IconTreeCorner8x10` 树形折角图标）。
- 结论：DSH 目前**无现成 DAG 连线组件可复用**；「节点列表」可复用 `DisclosureRow` + `StateDot` 模式，「连线示意」按 AGENTS.md「照着 DSH 风格自绘」。

---

## 7. `ctx.remote.sandore.*` wire 类型

### 7.1 生成的 remote client（权威 wire 类型）

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/lib/typert.remote-client.d.ts`（typert generator 从 `SandoreRemote` 的 `@Remote` 装饰器生成，勿手改）。

关键方法签名（`TypertRemoteNamespace$73616e646f7265`，即 `ctx.remote.sandore.*`，均返回 `Promise<RemoteResult<T>>`）：

```ts
listDefinitions: () => Promise<RemoteResult<WorkflowDefinitionEntry[]>>
createDefinition: (input: { yaml: string }) => Promise<RemoteResult<WorkflowDefinitionEntry>>
updateDefinition: (id: string, input: { name?: string; version?: string; description?: string }) => Promise<RemoteResult<WorkflowDefinitionEntry>>
deleteDefinition: (id: string) => Promise<RemoteResult<boolean>>
getYaml: (id: string) => Promise<RemoteResult<string>>
updateYaml: (id: string, yaml: string) => Promise<RemoteResult<WorkflowDefinitionEntry>>
```

生成的相关类型（readonly）：

```ts
interface WorkflowDefinitionRecord { yaml; name; version; description?; createdAt; updatedAt }
interface WorkflowDefinitionEntry extends WorkflowDefinitionRecord { id: string }
interface JobRecord { name; workflowId; cwd?; createdAt; updatedAt }
interface JobEntry extends JobRecord { id: string }
interface InstanceSummary { instanceId; jobId; workflowId; status: string; createdAt; updatedAt }
interface ArtifactEntry { stepId; stageId; outputToId?; files: string[]; returnPrompt? }
interface DagRun { instanceId; status: string }
```

### 7.2 Host 侧入参 schema（`src/remote.ts`）

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/remote.ts` L54-155。

- `CreateDefinitionInputSchema = z.object({ yaml: z.string() })`，`export type CreateDefinitionInput = z.infer<...>` → **`{ yaml: string }`**。
- **`updateYaml` 无独立入参 schema**：Host 签名是 `updateYaml(id: string, yaml: string)`（两个位置参数，`yaml` 直接 `parseWorkflowYaml(yaml)` 验证，非法抛 `SandoreError` 且存储保持旧值）。没有 `UpdateYamlInput` 类型。
- `getYaml(id: string): string` 返回定义原始 YAML 文本。
- 其他：`UpdateDefinitionInputSchema`（name/version/description 可选）、`CreateJobInputSchema`、`UpdateJobInputSchema`、`StartInstanceInputSchema`、`ReplyQuestionInputSchema`、`ReplyPermissionInputSchema`、`PauseStepInputSchema`、`ResumeStepInputSchema`、`PauseAllInputSchema`、`ResumeAllInputSchema`、`RetryStepInputSchema`。
- wire 层导出：`WorkflowDefinitionEntry extends WorkflowDefinitionRecord { id }`、`JobEntry extends JobRecord { id }`（L24-31）。

### 7.3 数据流接线（DSH 官方范式，非 host.call）

- `ui/src/client/index.ts`：`import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote'` + `ctx.remote.$mount(sandoreRemote)` → 之后 `ctx.remote.sandore.*` 命名空间就绪（命名空间 = `SandoreRemote` 的 `super(ctx, 'sandore')` service key）。
- 调用统一走 `unwrap(await ctx.remote.sandore.listDefinitions())`（`remote.ts` 的 `unwrap` 解包 `RemoteResult`）。
- `docs/design/task-5-frontend/work.md` L32 强调：**不用 `host.call`**（那是动态插件 Package-private RPC）；`design.md` §6.0 亦有同述。`design.md` §4.3 里的 `host.call('sandore.updateYaml')` 是早期写法，应以 typert 生成为准。

---

## 附：关键文件路径清单

- `D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/yaml-parser.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/yaml-parser.spec.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/remote.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/types.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/index.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/package.json`
- `D:/project-code/llm/sandore/packages/sandore/workflow/tsdown.config.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/lib/typert.remote-client.d.ts`
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/{index.ts,remote.ts,locales.ts,WorkflowPanel.tsx,WorkflowPanel.module.css,WorkflowButton.tsx,css-modules.d.ts}`
- `D:/project-code/llm/sandore/packages/sandore/ui/package.json`
- `D:/project-code/llm/sandore/docs/design/task-5-frontend/{design.md,work.md}`
- DSH：`D:/project-code/llm/deepseek-harness/packages/client/ui-primitives/src/{index.ts,StateDot.tsx,DisclosureRow.tsx,Button.tsx,Input.tsx,Pill.tsx,Menu.tsx,Modal.tsx,markdown/CodeBlock.tsx,icons/index.tsx}`
- DSH：`D:/project-code/llm/deepseek-harness/packages/client/ui-workflow-run/src/client/{WorkflowRunPanel.tsx,workflow-definition.ts}`
- DSH：`D:/project-code/llm/deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx`
- DSH：`D:/project-code/llm/deepseek-harness/packages/storage/storage-domain/src/{index.ts,spec.ts}`
