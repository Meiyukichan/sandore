/**
 * YAML 解析与定义校验的浏览器安全错误类型。
 *
 * 与 Host 侧 `SandoreError`（继承 `@deepseek-ai/dsh-llm` 的 `HarnessError`）解耦：
 * `yaml-parser.ts` 抛此轻量错误，使 `./yaml` 子路径可在浏览器侧导入而无需
 * 拉起 `dsh-llm`/`cordis` 依赖链。Host 侧 RPC 层按其稳定的 `code` 路由，
 * 与 `SandoreErrorCode` 中的 `YAML_PARSE`/`DEFINITION_INVALID` 保持一致。
 * @module dsh-sandore/workflow/src/yaml-error
 */

/** YAML 解析/定义校验失败的稳定机器码（`SandoreErrorCode` 子集）。 */
export type WorkflowYamlErrorCode = 'YAML_PARSE' | 'DEFINITION_INVALID'

/**
 * YAML 解析或工作流定义校验失败（浏览器安全，仅继承 `Error`）。
 *
 * `code` 为稳定机器码（`YAML_PARSE` 语法错误 / `DEFINITION_INVALID` Zod 或引用
 * 完整性校验失败），`cause` 挂原始 `ZodError` 供诊断。
 */
export class WorkflowYamlError extends Error {
  /** 稳定机器可路由错误码。 */
  readonly code: WorkflowYamlErrorCode

  constructor(message: string, code: WorkflowYamlErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkflowYamlError'
    this.code = code
  }
}
