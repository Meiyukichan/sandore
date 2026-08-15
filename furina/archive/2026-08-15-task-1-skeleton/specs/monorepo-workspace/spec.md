# Spec: monorepo-workspace — 根 monorepo 工作区

## ADDED Requirements

### Requirement: 根工作区配置文件存在且正确
仓库根目录 SHALL 存在 `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`，使 `packages/sandore/*` 下所有包构成一个 pnpm workspace。

#### Scenario: 根 package.json 声明
- **WHEN** 检查仓库根 `package.json`
- **THEN** 其包含 `name: "sandore"`、`private: true`、`packageManager: "pnpm@11.7.0"`、`engines.node >= 22`、`type: "module"`、`scripts.typecheck` 与 `scripts.build`，devDependencies 含 `typescript`/`tsdown`/`tsx`

#### Scenario: workspace 覆盖 4 个包
- **WHEN** 检查 `pnpm-workspace.yaml`
- **THEN** 其 `packages` 列表包含 `packages/sandore/*`，使 workflow/microflow/tool/ui 4 个包均在 workspace 内

#### Scenario: tsconfig 基座被各包继承
- **WHEN** 检查各包的 `tsconfig.json`
- **THEN** 每个包的 tsconfig `extends` 根 `tsconfig.base.json`

### Requirement: typecheck 通过
根级 `pnpm run typecheck` SHALL 对 workspace 内所有包执行 TypeScript 类型检查并通过，作为 Task 1 的自动化验证门槛。

#### Scenario: 全量类型检查
- **WHEN** 在仓库根执行 `pnpm install` 后执行 `pnpm run typecheck`
- **THEN** 命令退出码为 0，无类型错误

### Requirement: 依赖从 npm 解析且不 link 本地 DSH
所有 sandore 包对 `@deepseek-ai/*` 的依赖 SHALL 以 peerDependencies（版本 `0.1.0-rc.5`）声明并从 npm 解析，MUST NOT 使用 `file:`/`link:` 指向本地 DSH 源码。

#### Scenario: peerDependencies 声明
- **WHEN** 检查 `packages/sandore/workflow/package.json`
- **THEN** peerDependencies 含 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-storage`，版本均为 `0.1.0-rc.5`，且无任何 `file:`/`link:` 协议依赖

#### Scenario: 无 DSH 源码修改
- **WHEN** 检查 git 状态中 DSH 仓库（`D:\project-code\llm\deepseek-harness`）
- **THEN** 无任何由本任务引起的修改
