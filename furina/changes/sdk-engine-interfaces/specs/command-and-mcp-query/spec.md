## ADDED Requirements

### Requirement: Command list

系统 SHALL 在客户端对象上提供 `client.command` 命名空间，包含 `list(options?)` 方法。`client.command.list()` MUST 返回可用的斜杠命令（slash commands）列表。每个命令元素 MUST 包含命令名称；MAY 包含描述。该方法支撑引擎的 `getCommands` 直通能力。

#### Scenario: 列出可用命令

- **WHEN** 调用 `client.command.list()`
- **THEN** 返回一个数组，包含当前可用的斜杠命令
- **AND** 每个元素包含命令名称字段

#### Scenario: 无可用命令时返回空数组

- **WHEN** 当前无斜杠命令可用，调用 `client.command.list()`
- **THEN** 返回空数组

### Requirement: MCP status

系统 SHALL 在客户端对象上提供 `client.mcp` 命名空间，包含 `status(options?)` 方法。`client.mcp.status()` MUST 返回已注册的 MCP（Model Context Protocol）服务器状态列表。每个状态元素 MUST 包含服务器名称与连接状态；MAY 包含工具列表。该方法支撑引擎的 `listHooks` 直通能力。

#### Scenario: 查询 MCP 服务器状态

- **WHEN** 调用 `client.mcp.status()`
- **THEN** 返回一个数组，包含已注册的 MCP 服务器状态
- **AND** 每个元素包含服务器名称与连接状态

#### Scenario: 无 MCP 服务器时返回空数组

- **WHEN** 当前无注册的 MCP 服务器，调用 `client.mcp.status()`
- **THEN** 返回空数组
