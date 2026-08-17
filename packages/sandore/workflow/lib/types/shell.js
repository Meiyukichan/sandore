/**
 * sandore 引擎使用的 `ctx.shell` 能力接缝（本地结构类型声明）。
 *
 * `@deepseek-ai/dsh-shell` 未作为 sandore 的运行时依赖安装，本文件按 DSH 公开
 * API 复刻 Step 执行所需的最小结构类型（`resolve`/`run`/`start` + 请求/规格/
 * 结果），并声明 `ctx.shell` 上下文键。宿主运行时注入的真实 `ShellExecutor`
 * 结构兼容即可，无需包级依赖。
 * @module @deepseek-ai/dsh-sandore-workflow/src/shell
 */
export {};
//# sourceMappingURL=shell.js.map