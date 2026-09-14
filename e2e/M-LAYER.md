# M 层 e2e（mock LLM）交付说明

本文件记录 M 层端到端测试的**契约探索结论、mock 基建写法、用例清单与已知缺口**。
用例本体在 `e2e/m0-*.e2e.ts` … `e2e/m6-*.e2e.ts`，共用基建在 `e2e/fixtures/`，
mock 模型插件在 `e2e/mock-llm/`。

## 1. mock adapter 契约探索结论（`@deepseek-ai/dsh-llm`）

源码：`deepseek-harness/packages/llm/llm/src/index.ts`（`LlmRuntime` / `LlmAdapter`）+ `types.ts`。

- 注册：`ctx.llm.registerAdapter(providers: string[], adapter)`。返回 disposer（带 `replace()`），
  随 fiber 释放即注销；同一 provider 重复注册抛 `DUPLICATE_ADAPTER`。
- `providerInfo(provider)` **必须**回 `{ id: provider, name }`（`id` 恒等于注册名，否则
  `INVALID_ADAPTER`）。这是唯一被校验的元数据。
- **唯一抽象方法 `stream(options): AsyncIterable<StreamChunk>`**（没有 chat 方法）。
  chunk 语法（顺序即契约）：
  ```
  {type:'block-start', index, blockType}
  {type:'text-delta', index, text} ×N
  {type:'block-end', index, block:{type:'text', text}}
  {type:'usage', usage:{inputTokens, outputTokens, totalTokens?}}   // 可选，finish 之前
  {type:'finish', reason:{kind:'stop'|'tool-calls'|'max-tokens'|'aborted'|'error'}}
  ```
  适配器抛错会被 `LlmRuntime` 归一为终止 chunk（`error`/`aborted`）；本 mock 显式产出
  `finish{kind:'error', failure:{message, code}}` 以让失败文案可控。
- `GenerateOptions`：`{ provider, model, messages, system?, tools?, temperature?, maxTokens?,
  signal?, sessionId?, purpose? }`。`signal` 必须被尊重；`sessionId` 可用于**按会话**脚本化。
- **坑（实测踩到，务必记）**：`providerInfo`/`listModels`/`resolveModel`/`providerRetryPolicy`
  在基类 `LlmAdapter` 上都有默认实现，**但 `prepareCall` 是有实现体的具体方法**。
  若 adapter 是**纯对象**（不继承基类，mock 就是这么写的），**必须自己实现 `prepareCall`**，
  否则 `LlmRuntime.prepareCall()` / `adapterStream()` 抛
  `adapter.prepareCall is not a function` —— 表现为「子代理 turn 连一次模型调用都没有就
  settle error」，且 `llm/stream` 瀑布事件都不出现（因为装配期就炸了）。mock 内已补同形实现。
- `providerRetryPolicy()` 的返回值会被注册表**当作已解析策略直接用**（不再解析），所以要么
  返回 `undefined`，要么给全字段（`mode/maxRetries/retryableCodes/initialDelayMs/maxDelayMs/jitterRatio`）。
  mock 返回 `maxRetries: 0`，保证 `fail=1` 的脚本化失败不被 `llm-retry` 静默重放成成功。

## 2. mock 插件与 profile patch 写法

`e2e/mock-llm/`（纯 JS、零 import 的 Cordis 插件包，`name`/`inject`/`apply(ctx, config)`）：

```js
export const name = 'e2e-mock-llm'
export const inject = ['llm']
export function apply(ctx, config) { ctx.llm.registerAdapter(['e2e-mock'], adapter) }
```

挂接（`e2e/fixtures/harness.ts` 的 `prepareHome()`）：临时 `DSH_HOME` 的 **profile 自带 patch 层**
`profiles/e2e/cordis.patch.yml`（组合顺序：空表 → 各 bundle patch(base/web-app/sandore) →
**profile 自身 patch** → `--patch`）：

```yaml
- insert:
    - id: e2e-mock-llm
      name: '@sandore-e2e/mock-llm'
      config: { provider: e2e-mock, model: mock-1 }
- id: agent-default-model        # 宿主默认模型（RunView 底部 DiscussionInput 那条宿主会话用）
  config: { provider: e2e-mock, model: mock-1 }
```

模块解析：插件行 `name` 从 **临时 profile 的 `node_modules`** 解析 —— harness 用
`mklink /J` 把 `e2e/mock-llm` junction 到 `profiles/e2e/node_modules/@sandore-e2e/mock-llm`，
并在 profile `package.json` 的 `dependencies` 里同时写 `link:`（与 sandore 包自身同款双保险）。
`healProfilesModuleFallback` 只清理它自己拥有的 `.dsh-module-fallback` 投影，不会动这两个 junction。

**Step 子代理的模型路由**用 **L1**（YAML 里成对写 `providerId`/`modelId`），不依赖宿主默认：

```yaml
command:
  type: prompt
  value:
    promptText: "…[[e2e-mock text=… hold=…]]"
    providerId: e2e-mock
    modelId: mock-1
```

### mock 行为指令（随 Step 提示词走，不用 env）

e2e 的 `dsh` fixture 是 worker-scoped（`workers: 1` → 全轮共享一个实例），boot 期 env 对同
worker 的所有用例只有一份，所以行为由**提示词内嵌指令**决定（天然按用例隔离）：

```
[[e2e-mock text=<文本> chunks=<分片数> delay=<片间ms> hold=<内容就绪后再等ms>
             fail=0|1 failfirst=0|1 tools=<K> tool=<工具名> toolargs='<JSON>']]
```

- `hold`：内容**完整可见后**仍保持 turn 未结束的窗口 —— 面板只在 running/paused/failed 挂载，
  不 hold 就会与 turn 结束赛跑（M1/M3/M5 的 UI 断言都靠它）。只作用于最终文本轮。
- `tools=K`：按**会话**计数，前 K 次调用各回一个 tool-call，第 K+1 次回文本 —— 用来把会话
  撑成多轮/多消息（M1 的「>10 条消息」、M2 的进程折叠都靠它）。
- `fail=1`（或 `failfirst=1`）：不产出内容块、直接 `finish{kind:'error'}`（M6 造 failed 段）。
- 值以 `{` 开头时按**花括号配平**读取（早期按空白裸分词会把带空格的 JSON 截断 → 工具收到
  `invalid arguments: "arguments" must be an object`）。
- 每次调用都往 **stderr** 打一行 `[e2e-mock] call#N sessionTurn=… tools=…`；`apply()` 顶部
  还有一行 `[e2e-mock] applied` —— 这两行是「插件没加载 / 加载了但没被调用 / 调用了但没路由到
  本 adapter」三态的分叉诊断（`dsh.logMark()` + `dsh.countSince()` 做**自本用例起见**的计数）。

## 3. 用例清单与断言点

**实跑结果（`pnpm build` → `npx playwright test`，未用 `SANDBORE_E2E_ALLOW_STALE_BUILD`）：
20 passed / 0 failed，7.4m。** 其中 F 层 10 条（2.8m，未受 mock 挂接影响）、M 层 10 条
（≈4.6m，含各用例共享的实例冷启）。

> ⚠️ 上表那一轮的实跑数字属于「入口归一 + 呈现层统一」**之前**的基线。
>
> **当前 HEAD 的实跑数字（呈现层统一 + 入口归一落地后，`pnpm build` → `npx playwright test`，
> 未用 `SANDBORE_E2E_ALLOW_STALE_BUILD`）：23 passed / 1 skipped / 0 failed，7.4m**
> （24 条用例 = F 层 10 + M 层 13 + R 层 1 条默认 skip；M 层新增 `m7-main-agent-seat` 3 条）。

## 3.0 宿主主代理的「照办」分支（e2e 基建，`e2e/mock-llm/index.js`）

入口归一后**唯一启动入口**是宿主主代理（LLM）调用 `sandore_workflow_run`；
mock adapter 默认只回文本 ⇒ e2e 里没有任何 step 会跑起来。故 mock 增加一个**三重门控**分支：
① 该会话尚未服务过这条注入（常态 = 第 1 次调用）；② 扫描文本里**没有**任何 `[[e2e-mock …]]`
指令（step 子代理的提示词总带指令 ⇒ 永不误命中）；③ 扫描文本含宿主协作上下文标记
（`请调用 sandore_workflow_run` + 可解析的 `workflowId = "…"`，**原样解析、不硬编码**）。
命中时产出一个 `sandore_workflow_run` 的 tool-call，并打一行
`[e2e-mock] host-run session=<id> workflowId=<id> turn=<n>`（M4① 用它锁「照办恰一次、且发生在
宿主会话而非任何 step 子代理上」）。
**注意**：不要改走「把指令塞进 requirement/originalInput」——step 提示词里
`## 用户指令`（step 自己的 promptText）在前、「用户原始需求」（originalInput）在后，
而 mock 的指令解析是后者覆盖前者，会把每个 step 的指令覆盖掉。

| 文件 | 断言点 |
|---|---|
| `m0-mock-smoke.e2e.ts` | 金路径：`[data-step-chat]` 挂载 → 面板内出现 mock 文本 → `getInstanceState=completed` 且 executedSteps.stepId 一致 → host stderr 含 `[e2e-mock] call#` → 页面 `problems`（console error/pageerror）为空 |
| `m1-embedded-render.e2e.ts` | `tools=6` 会话：**本 step 的**模型调用数=7（按该 step 的 mock 指令文本计数——入口归一后宿主主代理自己也会产生调用，全局 `call#` 计数不再等于本 step 次数）↔ 6 个工具文件真实落盘 ↔ DOM 渲染 6 条 `tool-call` 行且总行数 ≥ 14（>旧「最新 10 条」上限）；首条（提示词 user 行）与末条（assistant-step 答复）都在 DOM；本会话未触发分页 → `[data-step-chat-autofill]`/`.stepChatOlder` 计数为 0 |
| `m2-turn-process-fold.e2e.ts` | 对照态（turn 未闭合）：`[data-turn-process-member]`/`[data-turn-process-answer]` 计数 0、turn-process 行 `hidden`；**经运行页主代理输入框（独立实现，`[data-main-agent-input]`）用自然语言 + 主代理工具调用**（`sandore_workflow_send_message`）排入第二条消息后（host `userMessages` 恰一条 `{kind:'message'}` 对账），前一轮闭合 → 成员行 ≥1 且全部带 `hidden`、答复行恰 1 且可见并含第一轮文本、披露头 `data-turn-process-tool-calls=3` 且 `aria-expanded=false`；展开后成员行不再 hidden（折叠可逆）；实例仍在 running（同一次挂载内完成全部断言） |
| `m3-composer.e2e.ts` | ① 面板内无任何输入面（`[data-step-chat-composer-seat]`/`[data-composer-input]`/`[data-composer-send]`/`[data-composer-queue-hint]`/`[data-composer-menu-anchor]`/`textarea` 计数 0，去 `+` 号断言继续成立）；② 运行页输入框 = **独立实现**（`[data-sandore-main-input]` + 原生 `textarea[data-main-agent-input]` + `[data-main-agent-send]`；**无** `[data-composer-kernel]`/`[data-composer-owner]`/`contenteditable`/`[data-composer-input]`/`[data-composer-menu-anchor]`；**标签行已删除**（`[data-sandore-main-input-label]` 计数 0）；席位：左 `[data-main-agent-access]`、右 `[data-main-agent-model-trigger]`；**运行中动作按钮恰 1 个**（`[data-sandore-stop]` = DSH 停止席位，`aria-label="停止生成"`；旧的「暂停/中止」两个圆钮计数 0，实例中止已移到标题栏 `[data-sandore-abort]`）；空草稿发送钮禁用）；**宽度真值断言（真机反馈修正）**：卡宽 == 消息列内容宽 + 24px（严格相等）且与消息列同轴心（中心 x 差 ≤1px），宽度基准 `--sandore-msg-content-width` 为 px；③ `[data-sandore-step-picker]` 计数 0（需求 2），同时断言独立输入框真的在（非恒真对照）；**②b 接管卡同宽同轴心**：用 mock 的 `once=1 tool=sandore_ask_user_question` 让 step 真的提问 → ask 接管卡宽 == 基准 + 24px（严格）且与输入卡同宽同轴心（实测两者都 669px、中心 x 都是 1354）。取证：`e2e/.artifacts/m3-main-agent-input-dom.txt` + `e2e/.artifacts/m3-takeover-width.txt` |
| `m5-pause-resume.e2e.ts` | 暂停：输入框旁**唯一**的 `[data-sandore-stop]`（DSH 停止席位）→ SSE `sandore/step-paused` 恰 1（args[1]=stepId）+ `getInstanceState=paused` + run view 文案「已暂停」+ `[data-step-chat]` 仍挂载（该按钮的**双语义**另一半——中止主代理当前 turn——由 M7③ 在真实运行中的主代理现场断言）；恢复：**走引擎侧通路**（主代理的 `sandore_workflow_control` → 同一 RPC `resumeAll`）→ SSE `sandore/step-resumed` 恰 1 → running 分支断言「模型被再次调用」，否则断言「仍 paused 且页面未把失败伪装成成功」；中止（**时序 flake 修复后**）：先 `waitForAnyFrame` 确认 SSE 通道已就绪 → 标题栏 `[data-sandore-abort]` → `aborted` → `waitForFrameCount('sandore/aborted', { exactly: 1 })` **有界等待**（超时给「类型序列 + 帧数 + 实例状态 + mock 日志」诊断；出现第 2 帧立刻失败），随后 1s 稳定期复查仍恰 1 且不发 `sandore/end`；另断言暂停后运行页主代理输入框仍可用（`[data-main-agent-input]` enabled——它是主代理的输入框，不再是工作流控件） |
| `m6-step-retry.e2e.ts` | failed 段：复试行锚点 `[data-step-chat-retry-row]` + `data-step-chat-retry-step=stepId` + 三模式（继续/回退/分叉）全可用 + 提交按钮在 composer seat 内；提交 continue → 引擎 fail-fast 文案原样出现在 `[data-step-chat-retry-error]` + `[data-step-chat-retry-disposed]` 引导；事件对账：`step-failed` 恰 1（args[1]=stepId）、`step-retried` 恰 0、实例仍 failed；revert 模式出现回退点选择位（候选空时禁用 + 空选项），fork 模式该位消失，提交同样落引擎语义 |
| `m7-main-agent-seat.e2e.ts`（呈现层统一新增） | ① **独立输入框**：`[data-main-agent-input]`（原生 `textarea`，无 `[data-composer-input]`/`[data-composer-kernel]`/`[data-composer-took-root]`/`contenteditable`）、打字使发送钮由禁用到可用、点发送后**草稿清空**且宿主主代理会话真的被驱动（mock 日志 `text="<唯一句柄>"` 恰 1，句柄只出现在用户敲进输入框的那条消息里）+ 卡片出现并含该回复；**草稿独立**：先往 DSH 中心列自己的输入框敲一串草稿（运行视图关闭时可见可输入）→ 打开运行视图后运行页输入框**是空的**（不共享/不同步）→ 关闭运行视图后中心列草稿仍在且仍能打字；② **主代理独立卡片（三轮真机修正后的规格）**：`[data-sandore-timeline] > [data-tl-main-agent]` 恰 1 且 `[data-tl-step] [data-tl-main-agent]` 计数 0（**不是**任何 step 卡片的后代）；**位置 = 步骤列表最后一张**（真机反馈：「主代理只有一个，一直放到最下面的 step」）；**默认折叠**（`aria-expanded=false`、卡体不渲染）→ 新消息到达**自动展开**并显示新回复（仍是同一张卡片）；**出现条件 = 主代理有助手消息**（启动汇报即出现，不再要求用户先发过消息）；**卡头 = 头像字母 `M` + 标题「主代理」**（与 step 头像同一套 class `avatar avatarAgent`，24px/50%/11px-600 逐值一致）；dump → `e2e/.artifacts/m7-main-agent-card-dom.txt`（含头像/标题 computed style 对照 + 是否最后一张 + 折叠态）；③ **停止按钮双语义**：输入框旁**唯一**的 `[data-sandore-stop]` → 实例 `paused` + SSE `sandore/step-paused` 恰 1 + 主代理「运行中」状态行消失（`hold` 未满 ⇒ turn 被 abort）；④ **与 DSH 中心列隔离**：运行视图打开期间 `[data-composer-took-root]` 计数 0、中心列草稿原地不动，关闭后仍可编辑可打字；⑤ **下拉真功能**：模型下拉选中第二个模型（mock provider 广告 `mock-1`/`mock-1-2`）→ 触发器文案变化 **且 mock 日志同一行出现 `model=mock-1-2` 与那句唯一句柄**（证明主代理会话的下一次调用真的用了新模型）；权限下拉选中「仅可查看」→ 触发器文案变化 **且引擎实例快照 `permission === 'read-only'`**（DSH `/permission` 命令 + 引擎 `updateInstancePermissionMode` 双通路） |
| `m8-main-agent-uniqueness.e2e.ts`（呈现层统一新增） | **三步**（≥3 step，前两步 completed、第三步 running）工作流上的**真机取证 + 回归护栏**：`[data-tl-main-agent]` 全局恰 1、`[data-main-agent-chat]` 恰 1、每张 step 卡片内主代理锚点/面板计数恒 0（不是「每步一张」）、卡片父节点 === `[data-sandore-timeline]` **且是最后一张**；**每个 step 面板显示的是它自己的会话**（含 `你正在执行工作流中的一个 Step`、**不含**主代理汇报标记），主代理卡片面板才含主代理会话标记。取证 dump（全局计数 + 每卡计数/是否最后一张/折叠态 + 每面板首行 + `executedSteps[].sessionMeta` 的 childId/hostSessionId 对照）→ `e2e/.artifacts/m8-main-agent-uniqueness.txt` |
| `m4-step-mention.e2e.ts` | ① **自然语言 + 主代理工具调用**：运行页主代理输入框里输入消息（内含 mock 指令驱动宿主主代理调用 `sandore_workflow_send_message`）→ SSE `sandore/step-message` 恰 1（`args[1]`=stepId、`args[3]`=文本）+ host `userMessages` 里恰一条 `{kind:'message', target:stepId, content}`（证明**定点**而非广播）+ mock 日志 `[e2e-mock] host-run session=<instanceId>` 恰 1（宿主主代理真的被驱动、且发生在宿主会话而非任何 step 子代理）；② 静态入口已删除：运行页 `[data-sandore-step-picker]` 计数 0、面板内无输入面/触发菜单，同时断言运行页主代理输入框真的在（原生 `textarea` 恰 1、无 `[data-composer-input]`/`[data-composer-kernel]`，非恒真对照） |

## 3.1 面板内 `@step` 菜单的实现（**已退役**；本节保留为历史记录）

> **现状（呈现层统一）**：`@step` 结构化引用**全部退役**——运行页的 step 选择器
> （`data-sandore-step-picker`）已删除，`step-mention-source.ts` 与
> `step-view/composer-trigger-menu*.ts` 保留为**未挂载的恢复入口**（`packages/client/index.ts`
> 不再注册 mention source、不再安装触发词控制器；运行页**根本不复用** `ComposerBar`
> ⇒ 菜单不可能挂载）。
> 替代路径：用户在**独立的主代理输入框**里用自然语言说「给 xx 步骤发消息」，由主代理调用引擎侧的
> `sandore_workflow_send_message`（M4① / M2 已按此改写）。下面这段是当年「面板内 `@` 菜单」
> 的实现记录，仅供恢复时参考。

结论：**`@step` 管线一直是通的，缺的只是「没人渲染菜单」**——
`ui-conversation` 的输入内核在每次编辑器提交后自己调 `inputTriggers.track(...)`
（`facade.ts` 的 `onEditorUpdate`），`arbitrate`/`onSpace`/`pick` 也早已转发到 controller，
chip 插入由内核的 `slash/input-insert-reference` 监听完成（`hub.ts`）；但 DSH 的 `MenuView`
注册在 session-scoped slot `conversation.input.overlay` 上、只有 DSH InputBar 骨架会渲染它，
而本面板是**无头复用内核的自绘壳**，所以菜单状态开合正常、DOM 永不出现（且无任何报错）。

补齐方式（`packages/client/step-view/`）：`composer-trigger-menu.ts`（行模型纯函数 + 控制器解析
单例，逐阶梯降级不抛）+ `ComposerTriggerMenu.tsx`（DSH `MenuView` 同款 DOM/交互：`role="listbox"`
+ `role="option"` + `mousedown` pick + `mousemove` hover + 外点 dismiss）+ 逐值抄录的 CSS +
`reference-glyph-data.ts`（字形数据内联，避免 import `dsh-client-ui-primitives` 产物——其顶层
`import '*.module.css'` 会让 vitest 整文件报 `Unknown file extension ".css"`）；`ComposerBar.tsx`
新增定位锚并渲染菜单；`packages/client/index.ts` 安装单例，并把 `@step` source 的注册从 apply 期
一次性读取改为 `ctx.inject(['inputTriggers'], …)`（否则本插件早于 ui-input-trigger 装载时会把
「晚到」永久当成「没有」，候选恒空）。

单测：新增 23 例（`composer-trigger-menu.spec.ts` 15 + `composer-trigger-menu-render.spec.ts` 8），
`npx vitest run` 全量 1333 passed / 2 skipped。

**有意偏离 DSH 一处**：菜单 320px 上限未照搬 DSH 的「视口顶钳制」（面板自身在滚动容器里，照搬会
把菜单压成 0 高），改为固定上限并在 CSS 文件头写明理由。

## 4. M 层 e2e 抓到的真实缺陷（真机才暴露，单测桩抓不到）

1. **mock adapter 缺 `prepareCall`**（本次交付自身踩到，已修）：见 §1 最后一条。
2. **引擎投递通道丢接收者**（由 M 层真机首次暴露，已由并行子代理修复）：
   `packages/workflow/subagent-delivery.ts` 把 `runtime[Symbol.for('dsh.subagent.…')]` 解下来
   裸调用 → `this` 为 `undefined` → DSH 侧 ``requireContinuations()`` 读到 undefined →
   页面报 `gateway/internal: Cannot read properties of undefined (reading 'requireContinuations')`，
   消息没投进去、`sandore/step-message` 一次都没有。修法：`.call(runtime, …)`。
   为什么单测漏掉：`FakeSubagents` 桩的符号位是**已绑定**的箭头函数，`this` 无关；
   R 层探针只覆盖 open 会话、不覆盖投递。
3. **恢复（resume）停在 paused**（待引擎侧确认）：见 §5 第 3 条的现状断言。
4. **主代理卡片在「宿主会话没在中心列打开」时永不出现**（M7② 真机暴露，已修）：
   卡片的出现条件是「宿主会话新增了一条助手输出」，而这个条数读的是 DSH 的 ChatSnapshot
   （`uiConversation.binding(binding).target('chat')`）——**只有会话窗被打开过**，app 级会话视图
   才会装配历史与 mux 帧。M7① 先在中心列打开过宿主会话，所以卡片照常出现；M7② 从头到尾没开过
   那个窗 ⇒ `read().ok` 恒假、条数恒 0 ⇒ 卡片永不出现（页面无任何报错，纯静默）。
   修法：`packages/client/main-agent-card.ts` 的探测钩子在挂载时走与面板**同一条**开窗路径
   （`Session.open()`，幂等、失败静默），于是「发送那一刻的基线条数」也是真实值。

## 5. 已知缺口与取舍

1. **`[data-step-chat]` 只在真实子代理 step 的 running/paused/failed 挂载** → M 层全部用例都必须
   用 mock LLM；F 层的 shell 步断言「不挂载」仍然成立（两者互补）。
2. **重试成功路径在本 DSH 版本不可达**：`recovery-manager.retryStep` 在提交任何新段/事件之前
   fail-fast（DSH 0.1.2-rc.1 对**已结算**子代理 dispose，continuable 状态已注销）。因此 M6
   断言的是「入口齐全 + 提交手势可达 + 引擎语义原样可见 + 事件不伪造」，而**不是**「重试成功」。
   这是仓库自身 F1 结论（`step-chat-retry.ts` 文件头）在真机上的体现，不是放宽成恒真断言。
3. **恢复（resume）目前停在 paused**：`resumeAll` 已完成投递并发 `sandore/step-resumed`，但实例状态
   未翻回 running（页面无任何错误提示）。用例对两态都做实质断言（成功分支要证明模型被再次调用；
   当前分支要断言状态确为 paused 且 UI 不伪装成功），引擎修好后本用例会走成功分支——**不会悄悄放过**。
4. **分页（「加载更早」/自动补齐）未在 M 层构造**：DSH 会话加载窗约一页 50 条消息，而 mock 会话
   （6 轮工具 ≈ 14 条消息）远小于该窗口；强行构造 50+ 条消息会让单用例时长与脆弱性都不可接受。
   因此 M1 改用**三条真值互证**（模型调用数 ↔ 工具落盘文件 ↔ DOM 行数）证明「不受 10 条限制」，
   并断言「本会话不应出现分页提示」。分页 UI 本身由 F3（外层时间线窗口）与 client 单测覆盖。
5. **未覆盖**：真机 IME 组合期行为（e2e 只断言 Enter/Shift+Enter 两条）；chip 视觉细节（颜色/图标）
   依赖 DSH 主题，e2e 只断言结构锚点与序列化文本；`[data-composer-host-claimed]` 的宿主根守卫
   竞态（取决于宿主对话页是否正显示该子代理会话，M 层无法稳定构造两侧）。
6. **主代理卡片的基线在「发送时视图还没就绪」这一竞态下取「就绪那一刻」的条数**（保守取向）：
   此时无法区分历史回复与刚刚的回应，故宁可暂时不出现（等**下一次**新增输出），也不冒
   「打开运行页就冒出一张卡片」的假阳性。挂载即开窗后，用户打字→点发送之间视图早已就绪，
   该竞态实际不可达（client 单测 `main-agent-card.spec.ts` 用 cold 桩把它锁成两态断言）。
7. **SSE 帧与 RPC 响应的到达顺序无保证（时序 flake 的成因）**：`sandore/*` 广播走 SSE 推流，
   而 `getInstanceState`/`abortInstance` 等走 RPC——**两条独立通路**。因此「先轮询 RPC 状态、
   再一次性读采集器」会偶发读到「状态已翻、帧还在路上」。修法：`e2e/fixtures/sse.ts` 提供
   **有界等待** `waitForFrameCount`（轮询到目标计数，超时给「类型序列 + 帧数 + 现场」诊断，
   并在 `exactly` 下出现第 2 帧立刻失败 ⇒ 断言强度不变）与 **通道就绪闸门** `waitForAnyFrame`；
   每次等待的「首次看到该帧的耗时」与「从手势算起的端到端延迟」追加写进
   `e2e/.artifacts/sse-frame-timing.log`。实测中止路径端到端延迟 ≈ **170–250ms**、每次都到达
   （判定为**延迟而非丢帧**；机制层依据：`/sandore/events` 在订阅时重放历史事件，重连窗口内
   发出的事件也会补到）。M5（中止）、F2（中止）、M6（step-failed 恰一次）已改用该等待。

## 5.8 运行页的「暂停 / 停止 / 中止」入口（真机反馈第三轮后的最终形态）

用户三轮反馈把输入框区的动作按钮逐步收敛到**零**：「模型下拉左边有两个暂停按钮，不要多此一举」
→「还是有个暂停按钮在输入框那里（tooltip：暂停工作流实例，并中止主代理当前回复），**去掉这个按钮**」。
现在：

| 动作 | 入口 | 真机断言 |
|---|---|---|
| **暂停工作流实例** | **DSH 中心列输入框自带的「停止生成」**（取消宿主主代理当前 turn → 引擎按 `turn/end` + `reason.kind==='aborted'` 判定 → 实例 `paused`，架构决策 6） | M5 第一条（`button[aria-label="停止生成"]` → SSE `sandore/step-paused` 恰 1 + `paused`）、M7③（同一入口 + 主代理「运行中」状态行消失） |
| **中止实例** | 运行视图**标题栏**的 `[data-sandore-abort]`（`aria-label="中止"`） | F2⑪、M5 第二条 |
| **输入框区** | 只剩：左 = 权限下拉、右 = 模型下拉 + 发送钮（**零**动作按钮） | M3（`[data-sandore-stop]` 计数 0 + 逐按钮文案扫描无「暂停/停止/中止」）、F2 |

## 5.9 主代理卡片的两条真机缺陷

1. **终态后卡体为空**（已修）：旧实现里卡片在终态那次重挂后停在「默认折叠」态（卡头在、卡体不渲染），
   表现就是「完成后下面的消息为空」。修法：终态（completed/failed/aborted）**强制展开**
   （`RunView` 传 `terminal` → `MainAgentChatBlock` 的终态 effect），且终态后不再自动折叠。
   断言：M11（终态 `aria-expanded=true`、卡体文本含「已结束」、文本长度 > 20）。
   折叠状态机（用户规格）：有新消息 → 展开；**消息停更 3 秒 → 自动折叠**（常量
   `MAIN_AGENT_AUTO_COLLAPSE_MS`）；终态 → 强制展开；**手动操作优先**（手动折叠后不被同一条
   消息弹开，只有新消息才再展开）。单测在 `unified-timeline-remount.spec.ts`（假定时器）。
2. **卡片里的巨大空白**（**本轮在 mock 环境未能复现**）：真机怀疑「旧的 user 消息泡占位」。
   `e2e/.artifacts/main-agent-gap.txt` 实测：可见行行距全部 **8–16px**（最大 16px = 正常行节奏）、
   **没有**「有高度无内容」的行、没有行内大段空白、上下文注入行左边界与普通行一致
   （`align-self: auto`，不是右贴靠气泡）；注入行在当前引擎形态下就是 `kind=context`
   （dump 第 [9] 行 = 「工作流「X」已结束（status=completed）」）。
   M11 已把「不许出现空壳行 / 空 user 气泡 / 行距超常」写成回归断言；若其它会话仍能看到，
   需要该实例的 `instanceId` 做现场 dump（M11 的 probe 可直接复用）。
3. **折叠后点不开（已修）**：真机「点击没法展开」。根因是卡头的 onClick **只绑在窄窄的状态 chip
   那个 `<button>` 上**（头像/标题/整条空白都没有 handler）。修法：整条卡头换成真正的
   `<button aria-expanded>`（含头像 M、标题、状态 chip（降级为 span）、会旋转的折叠箭头），
   `width: 100%` 让空白处也可点，Enter/Space 原生可用 + 焦点环；`toggle` 仍先取消自动折叠计时
   （手动优先）。断言：M11 第二条真机逐区域点击（整行/头像/标题/状态/箭头 → 全部
   `aria-expanded=true` 且卡体有消息行；`elementFromPoint` 记录真实命中元素）+ **等 3.5s 仍展开**
   （无竞态）；单测 2 条（另见本节第 4 条：卡头点击的「先量后点」竞态加固）。取证 `e2e/.artifacts/main-agent-card-head-click.txt`。

4. **卡头点击的「先量坐标、后点击」竞态（测试侧加固，非产品缺陷）**：引擎侧全量跑报第 3 条
   用例失败，`elementFromPoint` 命中的是 **`div.stepChatColumn`**（不是卡头按钮）。自查：当前
   源码 + 全新 `pnpm build` 下 **4 次复现尝试全部通过**（单跑 ×2、6 进程 CPU 压满 ×1、全量 ×1）：
   卡头 `box=(1031,414,645×24)`、2.5s×100ms **位移极差 0.0px**、五个区域**全部第 1 次尝试**
   就命中 `button.agentHeadButton`、展开后卡体 7 行、>3.5s 仍展开；产品侧也没有能遮挡卡头的
   路径（无 z-index/绝对定位/负 margin/`pointer-events:none`）。故该签名只能是**坐标在测量与
   点击之间失效**（上方内容增长/贴底跟随重排，或量到退化框），此时按旧坐标点击必然落到别的
   元素上。加固（判据不放宽）：① 先等卡头停住（连续 3 次采样一致 + 框未退化 + 无面板在自动
   补齐更早历史）；② 用 `elementFromPoint` 核对命中确实落在 `[data-tl-main-agent-toggle]` 内才
   真点；③ 命中不对或点击后 `aria-expanded` 没翻 → 重测坐标重试（≤3 次，每次连命中链写进
   取证）；④ 取证文件每次点击前就落盘；⑤ 失败信息自带命中元素/尝试次数/命中链/元素体检/卡头框。
   分析见 `e2e/.artifacts/m11-head-click-forensics.txt`。

## 5.10 进入子代理会话页的历史加载（已修）

真机：「从 step 标题点进去，最开头显示 **历史加载失败：subagent Sessions require their durable
parent address（session/agent-busy）**」。根因：step 标题入口走普通 `sessions.open(childId)`，
宿主的 `manager.select()` 会把面板先前装配的 subagent 地址清成 `undefined`
（`session-controller/src/client/sessions/manager.ts:168-179`），而历史请求用的地址来自
`session.ts:763`（`this.address === undefined` ⇒ 普通地址），普通地址访问子代理会话被
`history.ts:273-279` 直接拒（`session/agent-busy`）。修法：打开与 transport 装配收进同一个函数
`openStepChatSessionInHost`（`packages/client/step-chat-source.ts`）：先按 durable 地址开
（`openSubagent`，被拒则回落普通 open），**打开后再装配同一个地址**；step 标题回调把
`item.parentSessionId`（`sessionMeta.hostSessionId`）一并传下去。断言：M12（无禁止文案、
错误行 0、首屏有真实消息、「加载更早」点击不报错）+ 单测（`step-chat-source.spec.ts`
「打开与历史加载装配同一个 durable 地址」）。

## 5.11 旧实例的遗留「指令性用户消息」行（已修）

真机：老实例的讨论页里多出右侧「用户消息」气泡（继续/重试/讨论/回答），文本是**引擎自己造的
指令**，不是用户说的话。根因：`buildTimeline` 的用户消息来源只挡了 `kind:'answer'` 一种，
而旧版本引擎把 resume/retry/message 也写进了 `state.userMessages`（引擎现在只在
`makeInitialState` 写 `kind:'input'`，见 `packages/workflow/workflow-engine.ts:360`）。
修法：改成白名单 `if (message.kind !== 'input') continue`（`RENDERED_USER_MESSAGE_KIND`），
旧实例已落盘的那些行一并隐藏；`UnifiedTimeline` 的 5 分支徽标映射随之收成 `input` 一支并加
`data-tl-user-kind` 便于断言，`locales.ts` 里那 4 个不可达文案键删除。断言：单测
（`run-view-model.spec.ts` 白名单 4 条：4 种遗留 kind 不渲染 / 最早遗留行不占位 / 未知 kind
也不渲染 / 全遗留时无用户行；`unified-timeline-remount.spec.ts` 徽标 3 条；`locales.spec.ts`
死键 1 条）+ 真机 M13（`[data-tl-user]` 恰 1 行且该行 `data-tl-user-kind="input"`，
不存在带遗留 kind 的行）。**覆盖边界**：真机造不出遗留行（引擎不再写、也没有任何 RPC 能往
状态里塞 `userMessages`），遗留数据这条口径由单测锁；取证见 `e2e/.artifacts/task1-legacy-user-rows.txt`。

## 5.12 harness 收尾必须等到 DSH 子进程真退出（已修）

真机症状：上一轮 e2e 跑完，端口还被一个 `--profile e2e` 的 dsh 占着，下一轮要么被占用顶掉、
要么连到上一轮的临时 `DSH_HOME` 上（最难排查的一类假失败）。根因：`killTree` 的 8s 超时
「到点就当它死了」直接返回，既没有二次强杀也没有告警。修法（`e2e/fixtures/harness.ts`）：
先挂 `exit` 监听再 kill、`await exit`（10s 有界），超时再强杀一轮（Windows
`taskkill /PID <pid> /T /F` + `SIGKILL` 兜底；`shell:true` 下真正监听端口的 node 是 cmd 包装
的子进程，所以必须 `/T`），仍不退则告警并打印可直接粘贴的 taskkill 命令；`stop()` 末尾再用
`portOccupied`/`waitPortFree` 做**端口收尾验收**（只告警不抛：占用方也可能是用户自己的 dev
实例）。实测：一轮全量跑完日志为 `dsh 进程树已退出（pid 1920，75ms）` + `端口 3092 已释放
（无残留监听）`，且 3090/3092 空闲、无 `--profile e2e` 残留进程；取证见
`e2e/.artifacts/task2-dsh-stop-forensics.txt`。

## 6. R 层（真模型）如何复用同一 fixture

- 闸门沿用仓库既有拼写 **`SANDBORE_E2E_REAL`**（见 `e2e/fixtures/harness.ts` 头注释；
  `e2e/**` 内已无 `SANDORE_E2E_*` 旧拼写）。
- 复用点：`dsh` fixture（临时 home + profile patch + token URL + RPC 面 + 干净关停）、`page`
  fixture（SSE 采集器 + onboarding + 席位就绪）、`createMockInstance()`（导入定义 → 真实 UI 建实例）、
  `sandoreRpc()` / `getInstanceState()` / SSE 对账工具全部与模型无关。
- 切真模型只需两步：① 不注入 mock 指令（`mockDirective` 不写进 `promptText`），
  ② 把 Step 的 `providerId`/`modelId` 指到真 provider（或干脆删掉 L1 字段走宿主默认
  `agent-default-model`）。`SANDBORE_E2E_MOCK=0` 可完全关掉 mock 行与 junction（此时
  `agent-default-model` 也不覆盖，宿主默认模型即真 provider）。
- 真模型的断言面会不同：M1 的「调用次数」不可预测 → 改为断言行数与状态；M5/M6 的慢窗口用真模型
  的自然延迟而非 `hold`；M0 的「mock 文本」改为断言非空 assistant 文本。
