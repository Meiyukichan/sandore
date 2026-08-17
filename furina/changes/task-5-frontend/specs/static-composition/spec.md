# Spec: static-composition

## ADDED Requirements

### Requirement: 仓库根新建 cordis.yml 静态组合
sandore 仓库根 SHALL 新建 `cordis.yml`，以 `- insert:` 块静态组合 4 包（格式对齐 DSH `examples/web-cordis/cordis.yml` patch overlay）：
- `id: workflow` / `name: '@deepseek-ai/dsh-sandore-workflow'`，`config` 含 `defaultTimeoutMs: 7200000` 与 `maxConcurrentSteps: 0`
- `id: microflow` / `name: '@deepseek-ai/dsh-sandore-microflow'`
- `id: tool` / `name: '@deepseek-ai/dsh-sandore-tool'`
- `id: ui` / `name: '@deepseek-ai/dsh-client-ui-sandore'`

#### Scenario: YAML 合法且含 4 包
- **WHEN** 解析仓库根 `cordis.yml`
- **THEN** YAML 语法合法，`insert` 列表恰含上述 4 个插件行（id/name/config 正确）

### Requirement: ui 包 dsh 声明补全
`ui` 包 `package.json` 的 `dsh.client.inject` SHALL 含提供所消费客户端服务的全部装配：`@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-api-remotes`（ctx.remote）、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-sidebar`（footer slot）、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-conversation`（chat.node 契约）；`platform: 'web'` 与 `exports["./client"]` 保持；`peerDependencies` 与之一致。

#### Scenario: 声明完整
- **WHEN** 检查 `packages/sandore/ui/package.json`
- **THEN** `dsh.client.inject` 覆盖 ui 组件实际 inject 的全部客户端服务来源包，peerDeps 对应存在

### Requirement: 客户端 bundle 构建
`ui` 包 SHALL 具备 client bundle 构建配置（tsdown，照 DSH `clientBundle()` 形态），产出 `exports["./client"]` 指向的 browser 产物；`workflow` 包 SHALL 具备含 typert generator 的构建配置产出 `./remote` 与 lib 产物；两包 `typecheck` 脚本保留且通过。

#### Scenario: 构建可用
- **WHEN** 在 `workflow` 与 `ui` 包执行构建
- **THEN** 产出 `lib/**`（workflow 含 typert.remote-client、ui 含 client bundle）无错误

#### Scenario: typecheck 通过
- **WHEN** 4 个 sandore 包分别执行 `tsc --noEmit`
- **THEN** 全部无类型错误

### Requirement: 动态插件原型移除
固化后仓库内 SHALL NOT 存在动态插件原型路径（`host.call` 桩、`harness.handle` 接线、`cordis_define`/`cordis_run` 动态验证残留）；插件加载仅经 `cordis.yml` 静态组合，启动即生效。

#### Scenario: 无动态原型残留
- **WHEN** 在 `packages/sandore` 内搜索动态插件原型标识（host.call 字面桩/harness.handle）
- **THEN** 无命中，加载路径唯一为静态组合
