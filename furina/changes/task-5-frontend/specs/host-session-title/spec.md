# Spec: host-session-title

## ADDED Requirements

### Requirement: 宿主会话创建后设置可辨识标题
`workflow` 包 SHALL 在 `startInstance` 创建宿主 Session 后调用 `ctx.sessionTitle.rename(handle.session, '工作流实例 ${instanceId}')`，使宿主会话在 DSH 侧边栏显示明确标题（`source=user` 优先于 DSH fallback 自动摘要）。`static inject` MUST 含 `'sessionTitle'`。

#### Scenario: 标题已设置
- **WHEN** `startInstance` 成功创建宿主 Session
- **THEN** 该 Session 标题为 `工作流实例 <instanceId>`（user-source），侧边栏列表可直接辨识

#### Scenario: 服务声明
- **WHEN** TypeScript 编译 `workflow` 包
- **THEN** `static inject` 数组含 `'sessionTitle'`，`ctx.sessionTitle` 类型可用

### Requirement: 标题设置失败不阻塞实例启动
`sessionTitle.rename` 调用失败（服务异常/标题拒绝）SHALL 仅记录 warn 日志，MUST NOT 使 `startInstance` 失败或中断实例执行。

#### Scenario: rename 抛错时实例照常启动
- **WHEN** `sessionTitle.rename` 抛出异常
- **THEN** 引擎记录 warn 日志，实例照常创建并执行，`startInstance` 返回成功
