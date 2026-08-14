## ADDED Requirements

### Requirement: Package public entry

系统 SHALL 提供 `src/index.ts` 作为包的公共入口，re-export 全部公开 API。index.ts MUST 至少 re-export `createClaudeClient` 工厂方法、`ClaudeClient` 类型，以及 `CreateClientOptions` 等公开类型。消费者 MUST 能经包名 `@meiyukichan/claude-sdk` 引入（如 `import { createClaudeClient } from '@meiyukichan/claude-sdk'`），而非源码路径。

#### Scenario: 经包名引入工厂方法

- **WHEN** 消费者编写 `import { createClaudeClient } from '@meiyukichan/claude-sdk'`
- **THEN** 可调用 `createClaudeClient({ cwd })` 创建客户端

#### Scenario: 经包名引入类型

- **WHEN** 消费者编写 `import type { ClaudeClient, CreateClientOptions } from '@meiyukichan/claude-sdk'`
- **THEN** TypeScript 类型校验通过

### Requirement: Package.json exports and build

`package.json` MUST 配置以下字段以支持包名引入与构建产物消费：`main`（指向构建产物入口，如 `dist/index.js`）、`types`（指向 `dist/index.d.ts`）、`exports`（映射 `.` 到构建产物）、`files`（含 `dist`）、`scripts.build`（执行 TypeScript 编译，如 `tsc`）。`tsconfig.json` MUST 配置 `outDir`、`declaration: true` 以产出声明文件与构建产物。

#### Scenario: 执行构建脚本产出 dist

- **WHEN** 在 `packages/sdk/claude` 目录执行 `npm run build`
- **THEN** TypeScript 编译产出 `dist/` 目录
- **AND** dist 包含 `index.js`、`index.d.ts` 及对应子模块产物

#### Scenario: package.json exports 指向 dist

- **WHEN** 消费者经包名 `@meiyukichan/claude-sdk` 引入
- **THEN** Node.js 根据 `package.json` 的 `main`/`exports` 解析到 `dist/index.js`
- **AND** TypeScript 根据 `types` 字段解析到 `dist/index.d.ts`

#### Scenario: dist 目录被 gitignore

- **WHEN** 执行构建后查看 git 状态
- **THEN** `dist/` 目录不进入版本控制（已加入 .gitignore）
