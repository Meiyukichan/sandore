## Exploration Result

### 需求理解

- **What**：探索「为 sandore `ui` 包新增 DagEditor 组件（Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存），并将 `workflow` 包的定义层 zod schema 与 YAML 解析/序列化拆分为浏览器安全模块导出」所需的全部参考实现现状。
- **Boundaries**：sandore 仓库 `packages/sandore/workflow`、`packages/sandore/ui`、`packages/sandore/microflow` 三个包的源码/package.json/构建产物，以及 DSH 参考仓库 `D:\project-code\llm\deepseek-harness` 中的 `packages/client/ui-primitives`、`packages/client/ui-workflow-run`、`packages/client/ui-trajectory`、`packages/storage/storage-domain`、`packages/llm/llm`。
- **Goal**：摸清定义层 schema 与存储层（Node 侧）的耦合点、YAML 解析/序列化签名与依赖、workflow 包 exports 现状、DSH 可复用的 UI 基元、ui 包现有组件范式、DSH 简化可视化参考，以及 `ctx.remote.sandore.*` 的 wire 类型，为 editor-01 的编码提供事实依据。

> 注：`furina config show exploration.reference` 返回空数组 `[]`（无外部参考材料配置）。因此本探索直接针对 exploreContent 明确点名的 sandore 包文件与 DSH 参考仓库展开，均基于实际源码，无臆造。

---

### 1. `workflow/src/schema.ts` 当前结构

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`（444 行）。注释自述为「三层 Zod Schema」：定义层 / 运行时层 / 存储层。

**顶部共享枚举（非导出，纯 zod）**
- `StepStatusSchema = z.enum(['blocked','ready','interacting','running','completed','failed','paused'])`
- `DagRunStatusSchema = z.enum(['pending','running','interacting','completed','failed','aborted','paused'])`
- `ContentBlockSchema = z.looseObject({ type: z.string() })`

**定义层（纯 zod，仅 import `zod`）**
- `CommandConfigSchema`：`z.discriminatedUnion('type', [...])`，五种变体（`agent`/`prompt`/`shell`/`skill`/`mcp`），判别字段为顶层 `type`，变体字段整体嵌套于 `value`（对齐 `command: { type, value }`）。agent value 含 `promptText/agentParamsTemplate?/providerId?/modelId?`；prompt value 含 `promptText/providerId?/modelId?`；shell value 含 `command`；skill value 含 `promptText/providerId?`；mcp value 含 `promptText`。
- `InputFromItemSchema`：`{ id, path?, regex? }`
- `OutputToItemSchema`：`{ id, path?, regex? }`
- `PassThroughVarSchema`：`{ name, value, description, refresh? }`
- `PassThroughVarValueSchema`（非导出）：`{ value, description, refresh? }`
- `DagBranchSchema`：`{ expectation?, next, label? }`（省略 expectation = 并行分支）
- `DagLoopSchema`：`{ breakCondition?, breakExpectation?, next?, maxIterations, exitTo? }`
- `GatesSchema`：`{ maxRetries?, maxTokens?, primary?{enabled}, secondary?{enabled,prompt?}, need_confirm? }`
- `WorkflowSettingsSchema`：`{ defaultTimeout: default 120, maxConcurrentAgents: default 4 }`
- `WorkflowStepSchema`：`{ id, name?, command?, inputFrom?, outputTo?, passThroughVars?, timeout?, next?, defaultExpectation?, condition?, branches?, loop?, rules?, gates? }`
- `WorkflowStageSchema`：`{ id, name, rules?, gates?, steps（必填数组）, next?, defaultExpectation?, condition?, branches?, loop? }`
- `WorkflowDefinitionSchema`：`{ id, name, version, description?, engine?, skills(default []), mcps(default []), agents(default []), settings(default), rules?(record), gates?, stages(必填), steps? }`

**运行时层（纯 zod，状态快照/交互/收尾/产物契约）**
`StepSessionMetaSchema`、`AskUserQuestionPayloadSchema`、`PendingQuestionEntrySchema`、`PendingPermissionEntrySchema`、`FinalizeAssessResultSchema`、`GateEvalResultSchema`、`FinalizeMetaSchema`、`BranchMetaSchema`、`SessionMessageSchema`、`RetryRecordSchema`、`ExecutedStepDefaultSchema`、`StageInfoSchema`、`StageContractSchema`、`WorkflowTaskStateSchema`。

**存储层（依赖 Node 侧 `@deepseek-ai/dsh-storage-domain`）**
- `WorkflowDefinitionRecordSchema`：`{ yaml: z.string().max(65536), name, version, description?, createdAt, updatedAt }`
- `JobRecordSchema`：`{ name, workflowId, cwd?, createdAt, updatedAt }`
- `sandoreDomainSpec = defineDomain({ name:'sandore', version:1, tables: { definitions, jobs, state } })`（三表，逐条 zod 校验）

**派生 TS 类型**：`z.infer` 生成 `CommandConfig`、`InputFromItem`、`OutputToItem`、`PassThroughVar`、`DagBranch`、`DagLoop`、`Gates`、`WorkflowSettings`、`WorkflowStep`、`WorkflowStage`、`WorkflowDefinition`、`WorkflowTaskState`、`WorkflowDefinitionRecord`、`JobRecord` 等。

**耦合点（关键事实）**：定义层与运行时层只依赖 `zod`；文件顶部仅一处 Node 侧 import——`import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'`（第 11 行），**仅被存储层的 `sandoreDomainSpec` 使用**。`@deepseek-ai/dsh-storage-domain` 是 host 侧 cordis 插件：`src/index.ts` import cordis/schemastery/`@deepseek-ai/dsh-storage` 并挂载 `storageDomain` 表单，`src/spec.ts` 的 `defineDomain`/`domainTable` 还 `import { UNIT_NAME_RE, type KvUnitDescriptor } from '@deepseek-ai/dsh-storage'`；其 package.json peerDependencies 含 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-storage`。故 `schema.ts` 作为整体不是浏览器安全的，但「定义层（+运行时层）schema」本身无 Node 依赖，仅与存储层 `sandoreDomainSpec` 同文件混合才被污染。

---

### 2. `workflow/src/yaml-parser.ts` 当前签名与依赖

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\yaml-parser.ts`（234 行）。

**依赖**
- `import { parseDocument, stringify, type YAMLError } from 'yaml'`（`yaml` 是纯 JS 库，浏览器可用）
- `import { SandoreError } from './errors.ts'`
- `import { WorkflowDefinitionSchema, type DagBranch, type DagLoop, type WorkflowDefinition } from './schema.ts'`

**导出函数**
- `parseWorkflowYaml(text: string): WorkflowDefinition` — `parseDocument(text, { prettyErrors: true })` → 语法错误抛 `SandoreError('YAML_PARSE')`（附行列）→ `convertLegacyToV2(document.toJS())` → `WorkflowDefinitionSchema.parse`（失败抛 `SandoreError('DEFINITION_INVALID', { cause })`）→ `validateReferences(definition)`。
- `serializeWorkflowYaml(definition: WorkflowDefinition): string` — 直接 `stringify(definition)`（可被 parse 再次解析且深层相等）。
- `convertLegacyToV2(raw: unknown): unknown`（导出）— 检测 V1 三级结构 `stages[].scenarios[]` 并转两级 `stages[].steps[]`；同一 Stage 混用 `steps`/`scenarios` 抛 `DEFINITION_INVALID`。

**V1→V2 转换细节**：`PROMPT_TYPE_TO_COMMAND_TYPE` 映射 `{ Bash→shell, PromptTemplate→prompt, AgentTemplate→agent, SkillTemplate→skill, McpTemplate→mcp }`（未知回退 `prompt`）；同一 Scenario 相邻 Task 依次接 `next`，Scenario 的 `next` 落到其最后一个 Step（指向下一 Scenario 首个 Task），显式 `next` 不覆盖。

**`validateReferences` 引用校验**：`next`/`branches[].next`/`loop.next`/`loop.exitTo` 目标必须存在；`stage.next` 必须指向 stage（指向 step 抛错）；`inputFrom[].path` 的 `stageId[.stepId[.outputToId]]` 前两段存在（`${...}` 契约引用与缺失 path 跳过）。不满足抛 `DEFINITION_INVALID`。

**错误类型依赖链（浏览器安全拆分的隐性事实）**：`yaml-parser.ts` → `errors.ts`（re-export）→ `../../microflow/src/errors.ts` → `import { HarnessError } from '@deepseek-ai/dsh-llm'`。`SandoreError extends HarnessError`。`@deepseek-ai/dsh-llm` 的 package.json exports 只有 `.`、`./invariant`、`./types`、`./brand`、`./message`、`./src/*`（**无 `./error` 子路径**），主入口是 host 侧 cordis 插件（peerDeps cordis/schemastery）。即当前 `SandoreError` 会拉起 `@deepseek-ai/dsh-llm` 主入口。

**YAML 结构（V2 格式，来自 `yaml-parser.spec.ts` 内的完整附录 A.1 示例）**：顶层为 `id/name/version/description/engine/skills[]/mcps[]/agents[]/settings/rules(键值对)/gates`；`stages[].steps[]` 仅含 `id` + 流控字段（`next/defaultExpectation/condition/branches/loop`）；顶层 `steps[]` 为完整 Step 定义（`command/inputFrom/outputTo/passThroughVars/timeout/rules/gates`），与 `stages[].steps[]` 通过 id 交叉引用。ID 格式 `wfl-{uuid}`/`stg-{uuid}`/`step-{uuid}`/`ipt-{uuid}`/`opt-{uuid}`。

---

### 3. `workflow/package.json` exports 现状

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\package.json`。

- 名称 `@deepseek-ai/dsh-sandore-workflow`，`"type": "module"`，`main`/`types` 指向 `lib/index.js` / `lib/types/index.d.ts`。
- `exports` 现状：
  - `"."` → types `./lib/types/index.d.ts`，default `./lib/index.js`
  - `"./types"` → `./lib/types/types.d.ts` / `./lib/types/types.js`
  - `"./typert"` → `./lib/typert.host.d.ts` / `./lib/typert.host.js`
  - `"./remote"` → `./lib/typert.remote-client.d.ts` / `./lib/typert.remote-client.js`
  - `"./src/*"` → `./src/*`（源码直出通配，供 bundler 引 `.ts`）
  - `"./package.json"`
- **无 `./schema`、`./yaml` 子路径。**
- `dependencies`：`yaml ^2.9.0`、`zod ^4.4.3`（均浏览器安全）。
- `peerDependencies`（全部 host 侧）：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-sandore-microflow(workspace:*)`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-title`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-storage`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-subagent`、`@deepseek-ai/dsh-subprocess`、`@deepseek-ai/schemastery`。
- 构建：`tsdown.config.ts` — `entry: ['src/index.ts']`、`outDir: 'lib'`、`format: ['esm']`、`platform: 'node'`、`target: 'es2024'`、`dts: false`、`clean: false`、`plugins: [typertPlugin({ faces: ['host'] })]`。typert generator 从 `SandoreRemote` 的 `@Remote` 装饰器生成 `lib/typert.host.js/.d.ts` 与 `lib/typert.remote-client.js/.d.ts`。
- 现状备注：已提交的 `lib/` 仅含 `index.js` + 4 个 typert 文件（`git ls-files` 确认）；exports 引用的 `lib/types/*` 目录当前不存在（`dts:false` 的 tsdown 不产出，`typecheck` 是 `tsc --noEmit`）。`tsconfig.json` 的 `outDir` 为 `lib/types`、`declaration:true`（继承自 `tsconfig.base.json`），即 `.d.ts` 理论上由 tsc 产出，但 `build` 脚本只跑 tsdown。

---

### 4. DSH `ui-primitives` 可用组件与 icons

包：`D:\project-code\llm\deepseek-harness\packages\client\ui-primitives`，包名 `@deepseek-ai/dsh-client-ui-primitives`，自述「Cordis-free React primitives styled only through `--dsw-*` tokens」，exports 为 `.` + `./invariant` + `./src/*`。`src/index.ts` 的导出清单：

- `StateDot`（`StateDotState = 'done' | 'warning' | 'ongoing' | 'error'`；props `{ state, size?=10, className? }`；ongoing 是像素动画，其余是 10x10 halo + 6x6 核心，aria-hidden）
- `DisclosureRow`（`DisclosureRowProps`：`icon, title, open, expandable, onToggle, expandOnRowClick?, previewChevron?, keepContentWhenOpen?, collapsedContent?, children?, className?, rowClassName?, leadingClassName?, chevronClassName?, titleClassName?`；展开用 `IconChevronDownOutline14`，支持整行点击展开）
- `Button`（`ButtonVariant = 'primary'|'ghost'|'outline'|'toolbar'`；props `{ variant?='ghost', size?='md'|'sm', icon?, className?, children? } & ButtonHTMLAttributes<HTMLButtonElement>`；md=36px 胶囊 / sm=28px 紧凑）
- `Input`（props `{ icon?, className? } & InputHTMLAttributes<HTMLInputElement>`；包装 span + 原生 input）
- `Pill`（props `{ active?, className?, children? } & ButtonHTMLAttributes`；无 onClick 渲染 span，有 onClick 渲染 button）
- `Menu`（类型 `MenuItem/MenuSeparator/MenuLabel/MenuEntry`；props `open/anchor/items/footer?/selectedId?/selectedIds?/onSelect/onClose/align?('start'|'end')/side?('bottom'|'top'|'right')/portal?/closeOnPointerLeave?/dense?/compact?/getAnchorRect?/className?`；受控下拉，支持子菜单、portal 模式）
- `Modal`（props `open/onClose/title/closeLabel?/description?/children?/footer?/className?/contentClassName?/headless?`；portal 到 body 的居中对话框）
- `MarkdownText`（props `{ text, streaming?=false, codeLabels?, fileMentions? }`；memo 化，流式增量解析）
- `CodeBlock`（props `{ code, lang?, className?, copyLabel?='复制', copiedLabel?='复制成功' }`；shiki 高亮 + 未知语言 plain `<pre>` 回退 + 复制按钮）
- 其他：`HoverCard`、`Tooltip`、`Toast`、`JsonTree`、`OnboardingSurface`、`RiskConfirmation`、`ConnectionBanner`、`FishLogo`、`BrandWordmark`、`MessageText`、`JsonBlock`、`writeClipboard`、`useAnchoredMaxHeight`、`extractMarkdownPlainText`、`TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock`、`WebBlock`。

**Icons**（`export * from './icons/index.tsx'`，全量 `Icon*` 导出，均 `{ size=默认, className }`、`fill="currentColor"`）：`IconNewChatOutline16`、`IconSearchOutline16`、`IconGlobeOutline14`、`IconSettingsOutline14/16`、`IconPanelLeftOutline16`、`IconEllipsisOutline16`、`IconPlusOutline16`、`IconCheckOutline16/14`、`IconBranchOutline16`、`IconChevronDownOutline14`、`IconChevronLeftOutline14`、`IconChevronRightOutline14`、`IconTriangleRightFill14`、`IconChevronUpOutline14`、`IconCloseOutline16`、`IconCloseFill14`、`IconCopyOutline16`、`IconRefreshOutline16/14`、`IconLikeOutline16`、`IconLikeFill16`、`IconDislikeOutline16`、`IconDislikeFill16`、`IconShareOutline16`、`IconEditOutline16`、`IconThinkOutline14/16`、`IconAgentPresetOutline16`、`IconBrowseOutline16`、`IconLinkOutline14/16`、`IconRightUpOutline14/16`、`IconEnhanceOutline16`、`IconTrashOutline16`、`IconWarningOutline16`、`IconUserOutline16`、`IconSendOutline16/14`、`IconStopFill16`、`IconPaperclipOutline16`、`IconLoadingOutline16`、`IconDownloadOutline16`、`IconPlayOutline16`、`IconPauseOutline16`、`IconFullscreenOutline16`、`IconCodeOutline16`、`IconCordisPluginOutline14`、`IconApiOutline14`、`IconPersonalizationOutline16`、`IconProjectAddOutline16`、`IconFolderOpenOutline16`、`IconFolderOpen16`、`IconFolderClose16`、`IconTreeCorner8x10`、`IconLightOutline16`、`IconDarkOutline16`、`IconFollowsystemOutline16`、`IconDataOutline16`、`IconQueueOutline14`、`IconChecklistOutline14`、`IconListPenOutline16`、`IconGoalOutline16`、`IconSparkle16`、`IconInspectOutline12`、`IconSkillOutline16`、`IconQuestionOutline14`、`IconArchiveOutline20`。

样式全部走 CSS Modules + `--dsw-*` theme token（`--dsw-alias-*`、`--dsw-shadow-*`、`--dsh-font-mono`），组件自身不硬编码颜色。

---

### 5. `ui` 包现有组件结构范式

包：`D:\project-code\llm\sandore\packages\sandore\ui`，包名 `@deepseek-ai/dsh-client-ui-sandore`。

**package.json 关键字段**：exports `.`（lib/types/index.d.ts + lib/index.js）/ `./client`（lib/types/client/index.d.ts + lib/client.js）/ `./src/*` / `./package.json`；`dsh.client = { inject: ['@deepseek-ai/dsh-api-remotes','@deepseek-ai/dsh-client-runtime','@deepseek-ai/dsh-client-locale','@deepseek-ai/dsh-client-ui-sidebar'], platform: 'web' }`；peerDependencies 含 `react ^18.2.0`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-sidebar`、`@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-sandore-workflow(workspace:*)`、`@deepseek-ai/dsh-typert-protocol`。无 build 脚本，仅 `typecheck: tsc --noEmit`（lib/ 未提交，靠 bundler + `./src/*`）。

**Host 半 `src/index.ts`**：纯 UI 插件，Node 半是空 `export function apply(): void {}`。

**Client 入口 `src/client/index.ts`**：`export const inject = ['slots','locale','remote']`；`apply(ctx)` 内 `ctx.locale.register(NS, { zh, en })` → `ctx.remote.$mount(sandoreRemote)` → `ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name, id:'sandore-btn', locale: NS, inject: () => sandore }, WorkflowButton))`。

**remote 薄封装 `src/client/remote.ts`**：`import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote'`（default import，typert 生成贡献）；`SandoreRemoteError extends Error`（保留 `code`/`details`）；`unwrap<T>(result: RemoteResult<T>): T`（`ok:true` 取 value，`ok:false` 抛 SandoreRemoteError）；类型 `PingResponse` 从 `@deepseek-ai/dsh-sandore-workflow/remote` re-export。

**WorkflowButton.tsx 范式**：
- `WorkflowButtonFace { ping(): Promise<PingResponse> }`（业务 face，RemoteResult 已解包）
- `WorkflowButtonProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>`（`PropsRuntime`/`InjectFace`/`PropsLocale` 来自 `@deepseek-ai/dsh-client-ui-slots`）
- 组件用 `useState(open)`，`import css from './WorkflowButton.module.css'`，图标 `IconBranchOutline16`，`data-sandore-btn` 测试锚点。

**WorkflowPanel.tsx 范式**：props 是普通接口 `WorkflowPanelProps { t: TranslateNS<'sandore'>; ping(): Promise<PingResponse> }`（`TranslateNS` 来自 `@deepseek-ai/dsh-client-ui-slots`）；用 `Button`/`StateDot`/`IconPlusOutline16`；本地状态机 `PingState = idle|pending|ok|error`（discriminated union）。

**locales.ts 范式**：`export const NS = 'sandore'`；`zh`/`en` 字典（`en` 用 `satisfies Record<SandoreKey, string>` 强制逐键对齐）；`export type SandoreKey = keyof typeof zh`；`declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { sandore: SandoreKey } }`。

**css-modules**：`src/css-modules.d.ts` 声明 `declare module '*.module.css'`（返回 `Record<string,string>`）与 `'*.css'`；组件 `import css from './X.module.css'` 后以 `css.xxx` 使用，多类名用模板串拼接（如 `` `${css.layer} ${css.rail}` ``）；颜色用 `var(--dsw-alias-*)`。

---

### 6. DSH `ui-workflow-run` / `ui-trajectory` 的「节点列表 + 连线示意」参考

**ui-workflow-run**（`D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\src\client\WorkflowRunPanel.tsx`）：
- 纯「节点列表 + 状态点」式简化可视化：`RunHeader`（`DisclosureRow` 包裹，`icon=IconChevronRightOutline14`，`expandOnRowClick`，`collapsedContent` 放 `StateDot` + 计数 + 状态文本）→ 内层 `PhaseSection`（嵌套 `DisclosureRow`）→ 内层 `MemberRow`（`StateDot` + label + status 文本，可导航时为 `<button>`）。
- `dotState(status)` 把 `running/completed/failed/cancelled/interrupted` 映射为 `StateDotState`（ongoing/done/error/warning）。
- `StatusDisclosure` 依据 `requiresExpansion` 决定「强制展开（`expandable=false`）」还是「手动展开（`ManualDisclosure` 包一层 useState）」。无任何连线/边渲染。

**ui-trajectory**（`D:\project-code\llm\deepseek-harness\packages\client\ui-trajectory\src\client\TrajectoryTimeline.tsx` + `timeline.ts`）：
- Chrome-Network 风格的水平时间轴，是「lane + span」定位示意而非 DAG 边。`deriveTrajectoryTimeline(turns, mode)` 把记录投影为 `TrajectoryTimelineModel { spans, turnBoundaries }`，三 lane（`laneFor`: tool/subtool→2，message/compacted→1，其余→0，对应 Input/Model/Tools 标签）。
- span 用 CSS 变量定位（`--trajectory-span-left` / `--trajectory-span-width` / `--trajectory-span-lane` / `--trajectory-domain-left` 等），外包 `Tooltip`；支持拖拽选区、滚轮缩放、右键平移。`TrajectoryTable.tsx` 用 `@tanstack/react-virtual` 做虚拟化账本（KIND_ICON + JsonTree + MarkdownText）。

**结论（事实）**：DSH 仓库内**没有**现成的 DAG 边/连线渲染组件；`IconTreeCorner8x10` 图标存在但仅被定义（全仓库无使用点，唯一另一处是 docs 的 spec-icon-set.md）。最接近的参考是：节点列表 = `ui-workflow-run` 的 `DisclosureRow` + `StateDot` 嵌套；连线/布局示意 = `ui-trajectory` 的 `lanes + spans` 用 CSS 变量定位 + `Tooltip` 的方式。

---

### 7. `ctx.remote.sandore.*` 的 wire 类型

客户端 wire 类型由 typert generator 生成于 `D:\project-code\llm\sandore\packages\sandore\workflow\lib\typert.remote-client.d.ts`（`declare module '@deepseek-ai/dsh-typert-protocol'` 注入 `TypertRemoteNamespace$73616e646f7265` / `TypertRemoteMap` / `TypertRemoteNamespaceMap`，默认导出 `TypertRemoteContribution`）。与探索直接相关的签名：

- `createDefinition: (input: { yaml: string }) => Promise<RemoteResult<WorkflowDefinitionEntry>>`
- `updateYaml: (id: string, yaml: string) => Promise<RemoteResult<WorkflowDefinitionEntry>>` —— **注意是两个位置参数 `(id, yaml)`，不是 `{ id, yaml }` 对象**
- `getYaml: (id: string) => Promise<RemoteResult<string>>`
- `listDefinitions: () => Promise<RemoteResult<WorkflowDefinitionEntry[]>>`
- `updateDefinition: (id: string, input: { name?: string; version?: string; description?: string }) => Promise<RemoteResult<WorkflowDefinitionEntry>>`
- `deleteDefinition: (id: string) => Promise<RemoteResult<boolean>>`

wire 类型：`WorkflowDefinitionRecord = { yaml, name, version, description?, createdAt, updatedAt }`；`WorkflowDefinitionEntry extends WorkflowDefinitionRecord { id }`；另有 `JobRecord/JobEntry/InstanceSummary/ArtifactEntry/DagRun` 等（`InstanceSummary.status`、`DagRun.status` 在 wire 上退化为 `string`）。

Host 源侧（`src/remote.ts`）对应：`CreateDefinitionInput = z.infer<typeof CreateDefinitionInputSchema>`（`{ yaml: string }`）；`updateYaml(id: string, yaml: string)` 直取两参（内部先 `parseWorkflowYaml(yaml)` 再覆盖存储）；`getYaml(id)` 返回 `requireDefinition(id).yaml`；`WorkflowDefinitionEntry extends WorkflowDefinitionRecord { id: string }`。

**关键事实**：客户端 wire 类型只暴露存储记录形状（`yaml/name/version/...`），**不暴露** `WorkflowDefinition/WorkflowStage/WorkflowStep` 等 zod 派生类型。故浏览器侧 DagEditor 若要解析/校验/编辑/序列化 YAML，需要浏览器安全的 schema + yaml 导出，而不能仅依赖 `@deepseek-ai/dsh-sandore-workflow/remote` 的 wire 类型。

---

## Supplementary Exploration Result

`furina config show experimental.websearch experimental.context7` 返回 `websearch=true`、`context7=true`。本次 Phase 3 已直接从 sandore 与 deepseek-harness 源码获得充分且相互印证的信息（schema/yaml-parser/package.json/ui-primitives/ui 范式/wire 类型均已落到具体文件与代码行），信息充分，未触发补充探索（websearch/context7 无需额外查询）。
