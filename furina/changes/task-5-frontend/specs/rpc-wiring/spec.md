# Spec: rpc-wiring

## ADDED Requirements

### Requirement: workflow 包导出 Typert 远程客户端贡献
`packages/sandore/workflow` 包 SHALL 通过构建产物提供 `./remote` 子路径导出（`lib/typert.remote-client.js` + `.d.ts`），内容为从 `SandoreRemote` 的 `@Remote` 装饰器生成的 `TypertRemoteContribution`，覆盖全部 27 个 RPC 方法的调用描述符。`package.json` 的 `exports` MUST 含 `"./remote"` 条目，`files` 含生成物路径。

#### Scenario: 构建产出 ./remote 导出
- **WHEN** 在 `packages/sandore/workflow` 执行构建（tsdown + typert generator）
- **THEN** `lib/typert.remote-client.js` 存在，默认导出为 `TypertRemoteContribution`（`package: '@deepseek-ai/dsh-sandore-workflow'`，`descriptors` 覆盖 `listInstances`/`startInstance`/`getInstanceState`/`updateYaml`/`retryStep` 等全部 `@Remote` 方法）

#### Scenario: 类型可解析
- **WHEN** 消费方 `import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote'`
- **THEN** TypeScript 解析到 `lib/types/typert.remote-client.d.ts`，无类型错误

### Requirement: ui 插件挂载 sandore 命名空间并暴露类型化调用面
`ui` Client 插件 SHALL 在 `apply(ctx)` 内 `ctx.remote.$mount(sandoreRemote)`（disposer 经插件生命周期管理），使 `ctx.remote.sandore.*` 命名空间可用；`inject` 数组 MUST 含 `'remote'`，`dsh.client.inject` MUST 含 `@deepseek-ai/dsh-api-remotes`。

#### Scenario: 挂载后命名空间可调用
- **WHEN** `ui` Client 插件 apply 完成
- **THEN** `ctx.remote.sandore` 命名空间就绪，调用 `ctx.remote.sandore.ping()` 返回 `RemoteResult`（`{ok:true, value}` 形态）

#### Scenario: 卸载时清理
- **WHEN** `ui` Client 插件卸载
- **THEN** `$mount` 返回的 disposer 被执行，`sandore` 命名空间从 `ctx.remote` 移除

### Requirement: 移除动态插件 RPC 桩
Task 1 的本地 JSON 桩（`ui/src/client/host.ts` 的 `HostCall.call` 仅响应 `sandore.ping` 字面量实现）SHALL 被删除，`ui` 全部组件的数据调用 MUST 经 `ctx.remote.sandore.*`，仓库内 SHALL NOT 残留 `host.call` 动态插件原型路径。

#### Scenario: 桩代码移除
- **WHEN** Task 5 完成后在 `packages/sandore/ui/src` 内搜索 `sandore.ping` 字面量桩实现
- **THEN** 无本地桩命中（`ping` 仅作为真实 RPC 方法名出现于调用处）

### Requirement: RemoteResult 解包错误处理
ui 组件层调用 RPC SHALL 统一经薄封装解包 `RemoteResult`：`ok:true` 取 `value`，`ok:false` 抛出/呈现错误信息（Toast 或行内提示），SHALL NOT 静默吞错。

#### Scenario: RPC 失败可见
- **WHEN** 任一 `ctx.remote.sandore.*` 调用返回 `{ok:false, error}`
- **THEN** 对应 UI 呈现错误提示（不静默），列表/编辑器不渲染伪造数据
