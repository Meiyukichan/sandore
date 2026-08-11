## ADDED Requirements

### Requirement: List models

系统 SHALL 提供 `client.model.list(options?)` 方法，获取可用模型列表。返回结果 MUST 符合 opencode 结构 `{ location: LocationInfo, data: ModelV2Info[] }`。内部 MUST 调用 Claude SDK 的 `Query.supportedModels()` 或 `Query.initializationResult().models`，并将 Claude 的 `ModelInfo` 转换为 opencode 的 `ModelV2Info` 结构。

#### Scenario: 获取全部可用模型

- **WHEN** 调用 `client.model.list()`
- **THEN** 返回 `{ location, data }` 对象
- **AND** `data` 为 ModelV2Info 数组，每个元素包含 `id`、`providerID`、`name`、`status` 字段
- **AND** `location.directory` 等于客户端 cwd

#### Scenario: 按位置获取模型

- **WHEN** 调用 `client.model.list({ location: { directory: '/custom/path' } })`
- **THEN** 返回的 `location.directory` 等于 '/custom/path'

#### Scenario: 无会话时获取模型

- **WHEN** 客户端尚未创建任何会话，调用 `client.model.list()`
- **THEN** 适配层惰性初始化一个仅用于控制操作的控制 Query（`query({ prompt: <空 AsyncIterable>, options: { cwd } })`），调用其 `supportedModels()` 或 `initializationResult().models` 获取模型列表
- **AND** 该控制 Query 不 yield 用户消息，不产生对话轮次；在 `client.close()` 时关闭

### Requirement: ModelInfo to ModelV2Info mapping

系统 SHALL 将 Claude SDK 的 `ModelInfo`（`{ value, resolvedModel?, displayName, description, ... }`）映射为 opencode 的 `ModelV2Info`（`{ id, providerID, name, status, ... }`）。映射规则：`ModelInfo.value` → `ModelV2Info.id`；`ModelInfo.displayName` → `ModelV2Info.name`；providerID 固定为 `'anthropic'`；status 默认为 `'active'`。

#### Scenario: 映射单个模型

- **WHEN** Claude SDK 返回 `ModelInfo { value: 'sonnet', displayName: 'Claude Sonnet', description: '...' }`
- **THEN** 转换为 `ModelV2Info { id: 'sonnet', providerID: 'anthropic', name: 'Claude Sonnet', status: 'active' }`

#### Scenario: resolvedModel 保留

- **WHEN** ModelInfo 含 `resolvedModel` 字段（规范 wire id）
- **THEN** 该值保留在 ModelV2Info 的扩展字段或 variants 中，供消费者使用
