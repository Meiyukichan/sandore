# 测试 mocks 与 rc.1 真机的差异盲区（单测覆盖不到的路径）

> 来源：2026 rc.1 兼容性四片审计（microflow/workflow/client/外围）——mocks 差异清单。
> 目的：记录「单测全绿但真机可能行为不同」的盲区，作为补测与人工验收清单，不是缺陷清单。

| # | Mock 差异 | 影响路径 | 建议 |
|---|---|---|---|
| 1 | `FakeSession` 不追加 DSH 真 Session 的 seed 回放 end-seed marker（真机 `session/src/index.ts:575-577`） | 凡依赖 `seed.length`/`inheritedEventCount` 计数、fork 默认 boundary 取末事件的路径，真机比 mock 多 1 个事件 | fork/revert/重试相关单测补「真机事件数语义」用例或专用 fixture |
| 2 | `FakeSession.append` 全收，真机有 JSON-lossless/header/seed 校验 | 非法事件在真机提前抛错，mock 静默 | 构造非法事件验证引擎在真机侧报错面（低优先） |
| 3 | `FakeSubagents` 无 `Symbol.for('dsh.subagent.queuePrompt')` 通道 → 引擎投递恒走降级 followup 鸭子通道 | **引擎 queue 投递通道从未被单测覆盖**（仅真实 e2e 会命中 rc.1 queuePrompt） | 给 mock 实现 queue 符号通道或加真实 continuation 集成测试 |
| 4 | user-questions mock 无 EMPTY_QUESTIONS/BAD_INTENT/CALLER_NOT_LIVE 校验与 waterfall | ask 路由的宿主侧拒绝语义未覆盖 | 引擎级 ask 补宿主拒绝态用例 |
| 5 | workspace mock 不校验目录存在；真机 `resolveByPath` 对不存在路径 reject，`engine.attachHostAgentToWorkspace` 无 catch | 无效 cwd 在真机可能抛未包装错误 | attach 路径补 try/catch + 可读错误（待办） |
| 6 | session-title mock 无 maxTitleBytes 截断 | engine 已 try/catch 兜底，无运行风险 | — |
| 7 | shell/subprocess mock 形状与 rc.1 逐字段一致；差异仅在语义层（无折叠上限/dshEnv/sandboxPolicy 回填、FakeShell.start 直接 throw） | 超长输出折叠、sandboxPolicy 生效路径未覆盖 | 真机 shell 冒烟时覆盖长输出 |
| 8 | agents mock 缺 session/created 等发布事件与 cwd/origin 校验子集 | agents.create 发布时序、header 校验真机差异 | engine e2e 覆盖创建时序 |

**结构层结论（已由审计核实，无需重复修复）**：sessions mock 未建模「子代理 settle→dispose→移出 registry」语义，
retryStep 的 dispose fail-fast 预检（RecoveryManager.getAgent 注入）已在 recovery-manager.spec 以纯依赖形式覆盖；
engine 侧 retry 用例仍基于「child live」的 mock 语义，真机已 dispose 场景统一走 fail-fast（见
`docs/bugfix/bugfix-2026-08-25-retrystep-dsh-continuation.md` 更新节）。

**验收建议**：下次真机冒烟覆盖 —— ① 失败 step 后点「重试」（应快速失败并给出可读错误，不挂起）；
② 运行中超长 shell 输出；③ 复用宿主会话模式运行后重启 dsh → recoverOrphanedInstances（F2 修复路径）。
