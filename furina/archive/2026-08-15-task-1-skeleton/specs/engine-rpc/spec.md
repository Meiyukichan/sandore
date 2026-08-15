# Spec: engine-rpc — sandore.ping Host RPC

## ADDED Requirements

### Requirement: TypertRemoteService 生产范式 RPC
`packages/sandore/workflow/src/remote.ts` SHALL 定义 `class SandoreRemote extends TypertRemoteService`，构造函数 `super(ctx, 'sandore')`，以 `@Remote('ping')` 装饰器暴露 `sandore.ping` 端点，返回桩数据 JSON。

#### Scenario: 端点命名
- **WHEN** 检查 `remote.ts` 的 Remote 类
- **THEN** 存在 `extends TypertRemoteService` 的类，命名空间为 `super(ctx, 'sandore')`，`@Remote('ping')` 装饰的方法构成完整端点名 `sandore.ping`

#### Scenario: ping 返回桩数据
- **WHEN** Client 通过 `host.call('sandore.ping')` 调用
- **THEN** RPC 往返成功，返回可 JSON 序列化的桩数据（非真实引擎状态），typecheck 下类型正确

#### Scenario: 不使用动态原型捷径
- **WHEN** 检查 Task 1 产出代码
- **THEN** RPC 实现不含 `harness.handle` 动态原型写法（`cordis_define`/`cordis_run` 不进入产出）

### Requirement: RPC 类型与依赖正确
`remote.ts` SHALL 从 `@deepseek-ai/dsh-typert-protocol` 导入 `TypertRemoteService` 与 `Remote`（peerDependency `0.1.0-rc.5`，npm 解析），不引入运行时外部 SDK。

#### Scenario: 依赖声明
- **WHEN** 检查 `packages/sandore/workflow/package.json`
- **THEN** peerDependencies 含 `@deepseek-ai/dsh-typert-protocol: "0.1.0-rc.5"`，devDependencies 同名同版本供 typecheck
