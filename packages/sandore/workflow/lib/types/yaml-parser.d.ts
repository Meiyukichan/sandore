import { type WorkflowDefinition } from './schema.ts';
/**
 * 检测 V1 三级结构（`stages[].scenarios[]`）并自动转换为 V2 两级结构
 * （`stages[].steps[]`）。同一 Stage 同时含 `steps[]` 与 `scenarios[]` 视为混合格式，
 * 抛 `WorkflowYamlError('DEFINITION_INVALID')`。
 */
export declare function convertLegacyToV2(raw: unknown): unknown;
/**
 * 解析工作流 YAML 文本为 `WorkflowDefinition`。
 *
 * 流程：YAML 语法解析（错误 → `YAML_PARSE`）→ V1 自动转换 → Zod 验证（失败 →
 * `DEFINITION_INVALID`，`cause` 挂原始 `ZodError`）→ `next` 引用完整性校验。
 * @param text - YAML 文本（V1 三级或 V2 两级格式）。
 * @returns 验证通过的 `WorkflowDefinition`。
 */
export declare function parseWorkflowYaml(text: string): WorkflowDefinition;
/**
 * 序列化 `WorkflowDefinition` 为 YAML 文本（DagEditor 保存 / round-trip 测试用）。
 * 序列化结果可被 {@link parseWorkflowYaml} 再次解析且深层相等。
 * @param definition - 规范化后的工作流定义。
 * @returns YAML 文本。
 */
export declare function serializeWorkflowYaml(definition: WorkflowDefinition): string;
//# sourceMappingURL=yaml-parser.d.ts.map