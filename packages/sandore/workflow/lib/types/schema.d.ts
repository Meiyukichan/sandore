/**
 * 工作流引擎的 Zod Schema 与派生 TS 类型（浏览器安全）。
 *
 * 记录 schema（存储域 value / 业务数据模型）用真实 `zod`（`z.infer` 保持类型不重复，
 * 同一 schema 后续可投影为 RPC wire schema）；插件 `Config` 才用 schemastery（见
 * `index.ts`）。分三层：定义层（`WorkflowDefinition`/`WorkflowStage`/`WorkflowStep`/
 * `CommandConfig` 五类型 discriminated union）、运行时层（`WorkflowTaskState`，无
 * `permissionMode`）、记录层（`WorkflowDefinitionRecord`/`JobRecord`）。
 *
 * 本模块仅依赖 `zod`（浏览器安全），存储域声明 `sandoreDomainSpec`（依赖 Node 侧
 * `@deepseek-ai/dsh-storage-domain`）已拆至 `./domain.ts`，故可作为 `./schema`
 * 子路径在浏览器侧安全导入。
 * @module @deepseek-ai/dsh-sandore-workflow/src/schema
 */
import { z } from 'zod';
/**
 * 五种 Step 命令的 discriminated union。判别字段为顶层 `type`，变体字段整体
 * 嵌套于 `value`（对齐权威 YAML 示例 `command: { type: shell, value: { command } }`）。
 */
export declare const CommandConfigSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"agent">;
    value: z.ZodObject<{
        promptText: z.ZodString;
        agentParamsTemplate: z.ZodOptional<z.ZodString>;
        providerId: z.ZodOptional<z.ZodString>;
        modelId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"prompt">;
    value: z.ZodObject<{
        promptText: z.ZodString;
        providerId: z.ZodOptional<z.ZodString>;
        modelId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"shell">;
    value: z.ZodObject<{
        command: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"skill">;
    value: z.ZodObject<{
        promptText: z.ZodString;
        providerId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"mcp">;
    value: z.ZodObject<{
        promptText: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>], "type">;
/** Step 输入绑定项：`path` 为引用的 Step id（简化格式，单段），`regex` 对 Step 输出文本做正则匹配。 */
export declare const InputFromItemSchema: z.ZodObject<{
    id: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
    regex: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** Step 输出绑定项：`path`/`regex` 为产物文件路径（支持 glob/regex）。 */
export declare const OutputToItemSchema: z.ZodObject<{
    id: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
    regex: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** Step 透传变量。 */
export declare const PassThroughVarSchema: z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
    description: z.ZodString;
    refresh: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
/** DAG 循环控制（挂在分支上的可选属性：该分支 next 指向更早节点 = 回边）。 */
export declare const DagLoopSchema: z.ZodObject<{
    breakCondition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"agent">;
        value: z.ZodObject<{
            promptText: z.ZodString;
            agentParamsTemplate: z.ZodOptional<z.ZodString>;
            providerId: z.ZodOptional<z.ZodString>;
            modelId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"prompt">;
        value: z.ZodObject<{
            promptText: z.ZodString;
            providerId: z.ZodOptional<z.ZodString>;
            modelId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"shell">;
        value: z.ZodObject<{
            command: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"skill">;
        value: z.ZodObject<{
            promptText: z.ZodString;
            providerId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"mcp">;
        value: z.ZodObject<{
            promptText: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>], "type">>;
    breakExpectation: z.ZodOptional<z.ZodString>;
    next: z.ZodOptional<z.ZodString>;
    maxIterations: z.ZodNumber;
    exitTo: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * DAG 分支：分支是唯一出边单元，统一 `{ next, condition?, loop? }` 三并列字段。
 * - 无 `condition` = 并行分支（始终纳入下一批，多条并发）；
 * - 有 `condition` = 条件分支（布尔判定：AI 输出 true/false，shell 走
 *   `matchesExpectation(breakExpectation)`，true 才走）；
 * - 有 `loop` = 循环分支（该分支 `next` 为回边，`loop` 控制迭代/跳出/exitTo）。
 */
export declare const DagBranchSchema: z.ZodObject<{
    next: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    condition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"agent">;
        value: z.ZodObject<{
            promptText: z.ZodString;
            agentParamsTemplate: z.ZodOptional<z.ZodString>;
            providerId: z.ZodOptional<z.ZodString>;
            modelId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"prompt">;
        value: z.ZodObject<{
            promptText: z.ZodString;
            providerId: z.ZodOptional<z.ZodString>;
            modelId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"shell">;
        value: z.ZodObject<{
            command: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"skill">;
        value: z.ZodObject<{
            promptText: z.ZodString;
            providerId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"mcp">;
        value: z.ZodObject<{
            promptText: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>], "type">>;
    loop: z.ZodOptional<z.ZodObject<{
        breakCondition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"agent">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                agentParamsTemplate: z.ZodOptional<z.ZodString>;
                providerId: z.ZodOptional<z.ZodString>;
                modelId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"prompt">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                providerId: z.ZodOptional<z.ZodString>;
                modelId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"shell">;
            value: z.ZodObject<{
                command: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"skill">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                providerId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"mcp">;
            value: z.ZodObject<{
                promptText: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>], "type">>;
        breakExpectation: z.ZodOptional<z.ZodString>;
        next: z.ZodOptional<z.ZodString>;
        maxIterations: z.ZodNumber;
        exitTo: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** 门控配置（Workflow/Stage/Step 三级合并）。 */
export declare const GatesSchema: z.ZodObject<{
    maxRetries: z.ZodOptional<z.ZodNumber>;
    maxTokens: z.ZodOptional<z.ZodNumber>;
    primary: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
    }, z.core.$strip>>;
    secondary: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
        prompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    need_confirm: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
/** 工作流设置：`defaultTimeout`（分钟）默认 120，`maxConcurrentAgents` 默认 4。 */
export declare const WorkflowSettingsSchema: z.ZodObject<{
    defaultTimeout: z.ZodDefault<z.ZodNumber>;
    maxConcurrentAgents: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
/** 单个 Step 定义（V2 顶层 `steps[]` 完整定义：命令 + 映射 + 透传变量 + 门控）。 */
export declare const WorkflowStepSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    command: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"agent">;
        value: z.ZodObject<{
            promptText: z.ZodString;
            agentParamsTemplate: z.ZodOptional<z.ZodString>;
            providerId: z.ZodOptional<z.ZodString>;
            modelId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"prompt">;
        value: z.ZodObject<{
            promptText: z.ZodString;
            providerId: z.ZodOptional<z.ZodString>;
            modelId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"shell">;
        value: z.ZodObject<{
            command: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"skill">;
        value: z.ZodObject<{
            promptText: z.ZodString;
            providerId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"mcp">;
        value: z.ZodObject<{
            promptText: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>], "type">>;
    inputFrom: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        path: z.ZodOptional<z.ZodString>;
        regex: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    outputTo: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        path: z.ZodOptional<z.ZodString>;
        regex: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    passThroughVars: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
        description: z.ZodString;
        refresh: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>>;
    timeout: z.ZodOptional<z.ZodNumber>;
    defaultExpectation: z.ZodOptional<z.ZodString>;
    rules: z.ZodOptional<z.ZodArray<z.ZodString>>;
    gates: z.ZodOptional<z.ZodObject<{
        maxRetries: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
        primary: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
        }, z.core.$strip>>;
        secondary: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
            prompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        need_confirm: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Stage 内 Step 位置（V2 分离式：仅 id + 流控 branches；完整定义在顶层 `steps[]`
 * 按 id 交叉引用）。
 */
export declare const StageStepSchema: z.ZodObject<{
    id: z.ZodString;
    branches: z.ZodOptional<z.ZodArray<z.ZodObject<{
        next: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        condition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"agent">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                agentParamsTemplate: z.ZodOptional<z.ZodString>;
                providerId: z.ZodOptional<z.ZodString>;
                modelId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"prompt">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                providerId: z.ZodOptional<z.ZodString>;
                modelId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"shell">;
            value: z.ZodObject<{
                command: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"skill">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                providerId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"mcp">;
            value: z.ZodObject<{
                promptText: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>], "type">>;
        loop: z.ZodOptional<z.ZodObject<{
            breakCondition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"agent">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                    agentParamsTemplate: z.ZodOptional<z.ZodString>;
                    providerId: z.ZodOptional<z.ZodString>;
                    modelId: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"prompt">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                    providerId: z.ZodOptional<z.ZodString>;
                    modelId: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"shell">;
                value: z.ZodObject<{
                    command: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"skill">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                    providerId: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"mcp">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>], "type">>;
            breakExpectation: z.ZodOptional<z.ZodString>;
            next: z.ZodOptional<z.ZodString>;
            maxIterations: z.ZodNumber;
            exitTo: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
/** 单个 Stage 定义：内部 Step 流控（轻量）+ Stage 级 DAG 字段（出边统一进 branches）。 */
export declare const WorkflowStageSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    rules: z.ZodOptional<z.ZodArray<z.ZodString>>;
    gates: z.ZodOptional<z.ZodObject<{
        maxRetries: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
        primary: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
        }, z.core.$strip>>;
        secondary: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
            prompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        need_confirm: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    steps: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        branches: z.ZodOptional<z.ZodArray<z.ZodObject<{
            next: z.ZodString;
            label: z.ZodOptional<z.ZodString>;
            condition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"agent">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                    agentParamsTemplate: z.ZodOptional<z.ZodString>;
                    providerId: z.ZodOptional<z.ZodString>;
                    modelId: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"prompt">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                    providerId: z.ZodOptional<z.ZodString>;
                    modelId: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"shell">;
                value: z.ZodObject<{
                    command: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"skill">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                    providerId: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"mcp">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>], "type">>;
            loop: z.ZodOptional<z.ZodObject<{
                breakCondition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"agent">;
                    value: z.ZodObject<{
                        promptText: z.ZodString;
                        agentParamsTemplate: z.ZodOptional<z.ZodString>;
                        providerId: z.ZodOptional<z.ZodString>;
                        modelId: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"prompt">;
                    value: z.ZodObject<{
                        promptText: z.ZodString;
                        providerId: z.ZodOptional<z.ZodString>;
                        modelId: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"shell">;
                    value: z.ZodObject<{
                        command: z.ZodString;
                    }, z.core.$strip>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"skill">;
                    value: z.ZodObject<{
                        promptText: z.ZodString;
                        providerId: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"mcp">;
                    value: z.ZodObject<{
                        promptText: z.ZodString;
                    }, z.core.$strip>;
                }, z.core.$strip>], "type">>;
                breakExpectation: z.ZodOptional<z.ZodString>;
                next: z.ZodOptional<z.ZodString>;
                maxIterations: z.ZodNumber;
                exitTo: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    defaultExpectation: z.ZodOptional<z.ZodString>;
    branches: z.ZodOptional<z.ZodArray<z.ZodObject<{
        next: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        condition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"agent">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                agentParamsTemplate: z.ZodOptional<z.ZodString>;
                providerId: z.ZodOptional<z.ZodString>;
                modelId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"prompt">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                providerId: z.ZodOptional<z.ZodString>;
                modelId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"shell">;
            value: z.ZodObject<{
                command: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"skill">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                providerId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"mcp">;
            value: z.ZodObject<{
                promptText: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>], "type">>;
        loop: z.ZodOptional<z.ZodObject<{
            breakCondition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"agent">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                    agentParamsTemplate: z.ZodOptional<z.ZodString>;
                    providerId: z.ZodOptional<z.ZodString>;
                    modelId: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"prompt">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                    providerId: z.ZodOptional<z.ZodString>;
                    modelId: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"shell">;
                value: z.ZodObject<{
                    command: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"skill">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                    providerId: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"mcp">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>], "type">>;
            breakExpectation: z.ZodOptional<z.ZodString>;
            next: z.ZodOptional<z.ZodString>;
            maxIterations: z.ZodNumber;
            exitTo: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
/** 工作流定义（V2 两级 Stage → Step）。 */
export declare const WorkflowDefinitionSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    version: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    engine: z.ZodOptional<z.ZodString>;
    skills: z.ZodDefault<z.ZodArray<z.ZodString>>;
    mcps: z.ZodDefault<z.ZodArray<z.ZodString>>;
    agents: z.ZodDefault<z.ZodArray<z.ZodString>>;
    settings: z.ZodDefault<z.ZodObject<{
        defaultTimeout: z.ZodDefault<z.ZodNumber>;
        maxConcurrentAgents: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    rules: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    gates: z.ZodOptional<z.ZodObject<{
        maxRetries: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
        primary: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
        }, z.core.$strip>>;
        secondary: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
            prompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        need_confirm: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    stages: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        rules: z.ZodOptional<z.ZodArray<z.ZodString>>;
        gates: z.ZodOptional<z.ZodObject<{
            maxRetries: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
            primary: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodBoolean;
            }, z.core.$strip>>;
            secondary: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodBoolean;
                prompt: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            need_confirm: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        steps: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            branches: z.ZodOptional<z.ZodArray<z.ZodObject<{
                next: z.ZodString;
                label: z.ZodOptional<z.ZodString>;
                condition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"agent">;
                    value: z.ZodObject<{
                        promptText: z.ZodString;
                        agentParamsTemplate: z.ZodOptional<z.ZodString>;
                        providerId: z.ZodOptional<z.ZodString>;
                        modelId: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"prompt">;
                    value: z.ZodObject<{
                        promptText: z.ZodString;
                        providerId: z.ZodOptional<z.ZodString>;
                        modelId: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"shell">;
                    value: z.ZodObject<{
                        command: z.ZodString;
                    }, z.core.$strip>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"skill">;
                    value: z.ZodObject<{
                        promptText: z.ZodString;
                        providerId: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"mcp">;
                    value: z.ZodObject<{
                        promptText: z.ZodString;
                    }, z.core.$strip>;
                }, z.core.$strip>], "type">>;
                loop: z.ZodOptional<z.ZodObject<{
                    breakCondition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"agent">;
                        value: z.ZodObject<{
                            promptText: z.ZodString;
                            agentParamsTemplate: z.ZodOptional<z.ZodString>;
                            providerId: z.ZodOptional<z.ZodString>;
                            modelId: z.ZodOptional<z.ZodString>;
                        }, z.core.$strip>;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"prompt">;
                        value: z.ZodObject<{
                            promptText: z.ZodString;
                            providerId: z.ZodOptional<z.ZodString>;
                            modelId: z.ZodOptional<z.ZodString>;
                        }, z.core.$strip>;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"shell">;
                        value: z.ZodObject<{
                            command: z.ZodString;
                        }, z.core.$strip>;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"skill">;
                        value: z.ZodObject<{
                            promptText: z.ZodString;
                            providerId: z.ZodOptional<z.ZodString>;
                        }, z.core.$strip>;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"mcp">;
                        value: z.ZodObject<{
                            promptText: z.ZodString;
                        }, z.core.$strip>;
                    }, z.core.$strip>], "type">>;
                    breakExpectation: z.ZodOptional<z.ZodString>;
                    next: z.ZodOptional<z.ZodString>;
                    maxIterations: z.ZodNumber;
                    exitTo: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>>;
            }, z.core.$strip>>>;
        }, z.core.$strip>>;
        defaultExpectation: z.ZodOptional<z.ZodString>;
        branches: z.ZodOptional<z.ZodArray<z.ZodObject<{
            next: z.ZodString;
            label: z.ZodOptional<z.ZodString>;
            condition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"agent">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                    agentParamsTemplate: z.ZodOptional<z.ZodString>;
                    providerId: z.ZodOptional<z.ZodString>;
                    modelId: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"prompt">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                    providerId: z.ZodOptional<z.ZodString>;
                    modelId: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"shell">;
                value: z.ZodObject<{
                    command: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"skill">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                    providerId: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"mcp">;
                value: z.ZodObject<{
                    promptText: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>], "type">>;
            loop: z.ZodOptional<z.ZodObject<{
                breakCondition: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"agent">;
                    value: z.ZodObject<{
                        promptText: z.ZodString;
                        agentParamsTemplate: z.ZodOptional<z.ZodString>;
                        providerId: z.ZodOptional<z.ZodString>;
                        modelId: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"prompt">;
                    value: z.ZodObject<{
                        promptText: z.ZodString;
                        providerId: z.ZodOptional<z.ZodString>;
                        modelId: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"shell">;
                    value: z.ZodObject<{
                        command: z.ZodString;
                    }, z.core.$strip>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"skill">;
                    value: z.ZodObject<{
                        promptText: z.ZodString;
                        providerId: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"mcp">;
                    value: z.ZodObject<{
                        promptText: z.ZodString;
                    }, z.core.$strip>;
                }, z.core.$strip>], "type">>;
                breakExpectation: z.ZodOptional<z.ZodString>;
                next: z.ZodOptional<z.ZodString>;
                maxIterations: z.ZodNumber;
                exitTo: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        command: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"agent">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                agentParamsTemplate: z.ZodOptional<z.ZodString>;
                providerId: z.ZodOptional<z.ZodString>;
                modelId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"prompt">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                providerId: z.ZodOptional<z.ZodString>;
                modelId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"shell">;
            value: z.ZodObject<{
                command: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"skill">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                providerId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"mcp">;
            value: z.ZodObject<{
                promptText: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>], "type">>;
        inputFrom: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            path: z.ZodOptional<z.ZodString>;
            regex: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        outputTo: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            path: z.ZodOptional<z.ZodString>;
            regex: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        passThroughVars: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
            description: z.ZodString;
            refresh: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>>;
        timeout: z.ZodOptional<z.ZodNumber>;
        defaultExpectation: z.ZodOptional<z.ZodString>;
        rules: z.ZodOptional<z.ZodArray<z.ZodString>>;
        gates: z.ZodOptional<z.ZodObject<{
            maxRetries: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
            primary: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodBoolean;
            }, z.core.$strip>>;
            secondary: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodBoolean;
                prompt: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            need_confirm: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
/** Step 会话合成占位元数据（替代 SDK 时代的 `{sessionId,inputJson,outputJson,partsJson}`）。 */
export declare const StepSessionMetaSchema: z.ZodObject<{
    childId: z.ZodString;
    synthetic: z.ZodBoolean;
    command: z.ZodEnum<{
        agent: "agent";
        prompt: "prompt";
        shell: "shell";
        skill: "skill";
        mcp: "mcp";
    }>;
    hostSessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** 向用户提问的载荷（对齐 DSH `ask_user_question`）。 */
export declare const AskUserQuestionPayloadSchema: z.ZodObject<{
    questions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        question: z.ZodString;
        header: z.ZodOptional<z.ZodString>;
        options: z.ZodOptional<z.ZodArray<z.ZodObject<{
            label: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        multi_select: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** 待回复问答条目（`pendingInteractions` 的 question 变体）。 */
export declare const PendingQuestionEntrySchema: z.ZodObject<{
    id: z.ZodString;
    stageId: z.ZodString;
    stepId: z.ZodString;
    sessionId: z.ZodString;
    requestId: z.ZodString;
    kind: z.ZodLiteral<"question">;
    status: z.ZodEnum<{
        pending: "pending";
        replied: "replied";
        rejected: "rejected";
    }>;
    payload: z.ZodObject<{
        questions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            question: z.ZodString;
            header: z.ZodOptional<z.ZodString>;
            options: z.ZodOptional<z.ZodArray<z.ZodObject<{
                label: z.ZodString;
                description: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            multi_select: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    answer: z.ZodOptional<z.ZodArray<z.ZodArray<z.ZodString>>>;
    createdAt: z.ZodString;
}, z.core.$strip>;
/** 待回复权限条目（`pendingInteractions` 的 permission 变体）。 */
export declare const PendingPermissionEntrySchema: z.ZodObject<{
    id: z.ZodString;
    stageId: z.ZodString;
    stepId: z.ZodString;
    sessionId: z.ZodString;
    requestId: z.ZodString;
    kind: z.ZodLiteral<"permission">;
    status: z.ZodEnum<{
        pending: "pending";
        replied: "replied";
        rejected: "rejected";
    }>;
    payload: z.ZodObject<{
        permission: z.ZodString;
        patterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        tool: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    answer: z.ZodOptional<z.ZodEnum<{
        once: "once";
        always: "always";
        reject: "reject";
    }>>;
    createdAt: z.ZodString;
}, z.core.$strip>;
/** 收尾第 1 部分（Assessor）结果。 */
export declare const FinalizeAssessResultSchema: z.ZodObject<{
    completionType: z.ZodEnum<{
        completed: "completed";
        ask: "ask";
    }>;
    passThroughVars: z.ZodRecord<z.ZodString, z.ZodString>;
    askQuestion: z.ZodOptional<z.ZodObject<{
        questions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            question: z.ZodString;
            header: z.ZodOptional<z.ZodString>;
            options: z.ZodOptional<z.ZodArray<z.ZodObject<{
                label: z.ZodString;
                description: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            multi_select: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    errorDetail: z.ZodOptional<z.ZodString>;
    forkSessionId: z.ZodString;
    assessmentRaw: z.ZodString;
}, z.core.$strip>;
/** 收尾第 2 部分（GateEvaluator）结果。 */
export declare const GateEvalResultSchema: z.ZodObject<{
    gatesPassed: z.ZodBoolean;
    primaryPassed: z.ZodOptional<z.ZodBoolean>;
    secondaryPassed: z.ZodOptional<z.ZodBoolean>;
    gateDetails: z.ZodOptional<z.ZodObject<{
        primary: z.ZodObject<{
            enabled: z.ZodBoolean;
            passed: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>;
        secondary: z.ZodObject<{
            enabled: z.ZodBoolean;
            passed: z.ZodOptional<z.ZodBoolean>;
            prompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    errorDetail: z.ZodOptional<z.ZodString>;
    gateSessionId: z.ZodString;
    assessmentRaw: z.ZodString;
}, z.core.$strip>;
/** Step 收尾状态元数据。 */
export declare const FinalizeMetaSchema: z.ZodObject<{
    status: z.ZodEnum<{
        completed: "completed";
        ask: "ask";
        evaluating: "evaluating";
    }>;
    sessionId: z.ZodOptional<z.ZodString>;
    gateSessionId: z.ZodOptional<z.ZodString>;
    directory: z.ZodOptional<z.ZodString>;
    errorDetail: z.ZodOptional<z.ZodString>;
    completionType: z.ZodOptional<z.ZodEnum<{
        completed: "completed";
        ask: "ask";
    }>>;
    assessResult: z.ZodOptional<z.ZodObject<{
        completionType: z.ZodEnum<{
            completed: "completed";
            ask: "ask";
        }>;
        passThroughVars: z.ZodRecord<z.ZodString, z.ZodString>;
        askQuestion: z.ZodOptional<z.ZodObject<{
            questions: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                question: z.ZodString;
                header: z.ZodOptional<z.ZodString>;
                options: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    label: z.ZodString;
                    description: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>>>;
                multi_select: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        errorDetail: z.ZodOptional<z.ZodString>;
        forkSessionId: z.ZodString;
        assessmentRaw: z.ZodString;
    }, z.core.$strip>>;
    gateResult: z.ZodOptional<z.ZodObject<{
        gatesPassed: z.ZodBoolean;
        primaryPassed: z.ZodOptional<z.ZodBoolean>;
        secondaryPassed: z.ZodOptional<z.ZodBoolean>;
        gateDetails: z.ZodOptional<z.ZodObject<{
            primary: z.ZodObject<{
                enabled: z.ZodBoolean;
                passed: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>;
            secondary: z.ZodObject<{
                enabled: z.ZodBoolean;
                passed: z.ZodOptional<z.ZodBoolean>;
                prompt: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>>;
        errorDetail: z.ZodOptional<z.ZodString>;
        gateSessionId: z.ZodString;
        assessmentRaw: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** 分支/循环评估元数据。 */
export declare const BranchMetaSchema: z.ZodObject<{
    result: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    directory: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<{
        completed: "completed";
        evaluating: "evaluating";
    }>;
    expectation: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** 会话消息记录。 */
export declare const SessionMessageSchema: z.ZodObject<{
    type: z.ZodEnum<{
        tool: "tool";
        text: "text";
        reasoning: "reasoning";
    }>;
    text: z.ZodOptional<z.ZodString>;
    tool: z.ZodOptional<z.ZodString>;
    args: z.ZodOptional<z.ZodUnknown>;
    output: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
/** 重试历史记录。 */
export declare const RetryRecordSchema: z.ZodObject<{
    mode: z.ZodEnum<{
        continue: "continue";
        revert: "revert";
        fork: "fork";
    }>;
    timestamp: z.ZodString;
    userMessage: z.ZodString;
    revertMessageId: z.ZodOptional<z.ZodString>;
    result: z.ZodEnum<{
        completed: "completed";
        running: "running";
        failed: "failed";
    }>;
}, z.core.$strip>;
/** 已执行 Step 的默认实现快照。 */
export declare const ExecutedStepDefaultSchema: z.ZodObject<{
    type: z.ZodLiteral<"default">;
    id: z.ZodString;
    stepId: z.ZodOptional<z.ZodString>;
    stageId: z.ZodString;
    name: z.ZodString;
    status: z.ZodEnum<{
        completed: "completed";
        running: "running";
        failed: "failed";
        blocked: "blocked";
        ready: "ready";
        interacting: "interacting";
        paused: "paused";
    }>;
    command: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"agent">;
        value: z.ZodObject<{
            promptText: z.ZodString;
            agentParamsTemplate: z.ZodOptional<z.ZodString>;
            providerId: z.ZodOptional<z.ZodString>;
            modelId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"prompt">;
        value: z.ZodObject<{
            promptText: z.ZodString;
            providerId: z.ZodOptional<z.ZodString>;
            modelId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"shell">;
        value: z.ZodObject<{
            command: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"skill">;
        value: z.ZodObject<{
            promptText: z.ZodString;
            providerId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"mcp">;
        value: z.ZodObject<{
            promptText: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>], "type">>;
    inputFrom: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        path: z.ZodOptional<z.ZodString>;
        regex: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    outputTo: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        path: z.ZodOptional<z.ZodString>;
        regex: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    passThroughVars: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
        description: z.ZodString;
        refresh: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>>;
    sessionMeta: z.ZodOptional<z.ZodObject<{
        childId: z.ZodString;
        synthetic: z.ZodBoolean;
        command: z.ZodEnum<{
            agent: "agent";
            prompt: "prompt";
            shell: "shell";
            skill: "skill";
            mcp: "mcp";
        }>;
        hostSessionId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    finalizeMeta: z.ZodOptional<z.ZodObject<{
        status: z.ZodEnum<{
            completed: "completed";
            ask: "ask";
            evaluating: "evaluating";
        }>;
        sessionId: z.ZodOptional<z.ZodString>;
        gateSessionId: z.ZodOptional<z.ZodString>;
        directory: z.ZodOptional<z.ZodString>;
        errorDetail: z.ZodOptional<z.ZodString>;
        completionType: z.ZodOptional<z.ZodEnum<{
            completed: "completed";
            ask: "ask";
        }>>;
        assessResult: z.ZodOptional<z.ZodObject<{
            completionType: z.ZodEnum<{
                completed: "completed";
                ask: "ask";
            }>;
            passThroughVars: z.ZodRecord<z.ZodString, z.ZodString>;
            askQuestion: z.ZodOptional<z.ZodObject<{
                questions: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    question: z.ZodString;
                    header: z.ZodOptional<z.ZodString>;
                    options: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        label: z.ZodString;
                        description: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>>>;
                    multi_select: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strip>>;
            }, z.core.$strip>>;
            errorDetail: z.ZodOptional<z.ZodString>;
            forkSessionId: z.ZodString;
            assessmentRaw: z.ZodString;
        }, z.core.$strip>>;
        gateResult: z.ZodOptional<z.ZodObject<{
            gatesPassed: z.ZodBoolean;
            primaryPassed: z.ZodOptional<z.ZodBoolean>;
            secondaryPassed: z.ZodOptional<z.ZodBoolean>;
            gateDetails: z.ZodOptional<z.ZodObject<{
                primary: z.ZodObject<{
                    enabled: z.ZodBoolean;
                    passed: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strip>;
                secondary: z.ZodObject<{
                    enabled: z.ZodBoolean;
                    passed: z.ZodOptional<z.ZodBoolean>;
                    prompt: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>>;
            errorDetail: z.ZodOptional<z.ZodString>;
            gateSessionId: z.ZodString;
            assessmentRaw: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    visitCount: z.ZodNumber;
    branchMeta: z.ZodOptional<z.ZodObject<{
        result: z.ZodOptional<z.ZodString>;
        sessionId: z.ZodOptional<z.ZodString>;
        directory: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<{
            completed: "completed";
            evaluating: "evaluating";
        }>;
        expectation: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodString>;
    pausedAt: z.ZodOptional<z.ZodString>;
    resumedAt: z.ZodOptional<z.ZodString>;
    resumePrompt: z.ZodOptional<z.ZodString>;
    sessionMessages: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<{
            tool: "tool";
            text: "text";
            reasoning: "reasoning";
        }>;
        text: z.ZodOptional<z.ZodString>;
        tool: z.ZodOptional<z.ZodString>;
        args: z.ZodOptional<z.ZodUnknown>;
        output: z.ZodOptional<z.ZodUnknown>;
    }, z.core.$strip>>>;
    pauseEntryId: z.ZodOptional<z.ZodString>;
    loopIteration: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
    loopMeta: z.ZodOptional<z.ZodObject<{
        result: z.ZodOptional<z.ZodString>;
        sessionId: z.ZodOptional<z.ZodString>;
        directory: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<{
            completed: "completed";
            evaluating: "evaluating";
        }>;
        expectation: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    retryHistory: z.ZodOptional<z.ZodArray<z.ZodObject<{
        mode: z.ZodEnum<{
            continue: "continue";
            revert: "revert";
            fork: "fork";
        }>;
        timestamp: z.ZodString;
        userMessage: z.ZodString;
        revertMessageId: z.ZodOptional<z.ZodString>;
        result: z.ZodEnum<{
            completed: "completed";
            running: "running";
            failed: "failed";
        }>;
    }, z.core.$strip>>>;
    parentSessionId: z.ZodOptional<z.ZodString>;
    output: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
    }, z.core.$loose>>>;
}, z.core.$strip>;
/** 单个 Stage 的状态快照。 */
export declare const StageInfoSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    status: z.ZodEnum<{
        completed: "completed";
        running: "running";
        failed: "failed";
        blocked: "blocked";
        ready: "ready";
        interacting: "interacting";
        paused: "paused";
    }>;
}, z.core.$strip>;
/** Stage 完成时对外暴露的产物契约。 */
export declare const StageContractSchema: z.ZodObject<{
    stageId: z.ZodString;
    stageName: z.ZodString;
    status: z.ZodEnum<{
        completed: "completed";
        running: "running";
        failed: "failed";
        blocked: "blocked";
        ready: "ready";
        interacting: "interacting";
        paused: "paused";
    }>;
    artifacts: z.ZodArray<z.ZodObject<{
        stepId: z.ZodString;
        outputToId: z.ZodString;
        files: z.ZodArray<z.ZodString>;
        returnPrompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    passThroughVars: z.ZodRecord<z.ZodString, z.ZodObject<{
        value: z.ZodString;
        description: z.ZodString;
        refresh: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    contractArtifacts: z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>;
    completedAt: z.ZodString;
    errorDetail: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** 工作流实例的持久化状态快照（存储域 `state` 表 value）。 */
export declare const WorkflowTaskStateSchema: z.ZodObject<{
    taskId: z.ZodString;
    jobId: z.ZodString;
    workflowId: z.ZodString;
    cwd: z.ZodString;
    status: z.ZodEnum<{
        pending: "pending";
        completed: "completed";
        running: "running";
        failed: "failed";
        interacting: "interacting";
        paused: "paused";
        aborted: "aborted";
    }>;
    originalInput: z.ZodString;
    currentStageId: z.ZodString;
    executedSteps: z.ZodArray<z.ZodObject<{
        type: z.ZodLiteral<"default">;
        id: z.ZodString;
        stepId: z.ZodOptional<z.ZodString>;
        stageId: z.ZodString;
        name: z.ZodString;
        status: z.ZodEnum<{
            completed: "completed";
            running: "running";
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            interacting: "interacting";
            paused: "paused";
        }>;
        command: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"agent">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                agentParamsTemplate: z.ZodOptional<z.ZodString>;
                providerId: z.ZodOptional<z.ZodString>;
                modelId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"prompt">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                providerId: z.ZodOptional<z.ZodString>;
                modelId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"shell">;
            value: z.ZodObject<{
                command: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"skill">;
            value: z.ZodObject<{
                promptText: z.ZodString;
                providerId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"mcp">;
            value: z.ZodObject<{
                promptText: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>], "type">>;
        inputFrom: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            path: z.ZodOptional<z.ZodString>;
            regex: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        outputTo: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            path: z.ZodOptional<z.ZodString>;
            regex: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        passThroughVars: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
            description: z.ZodString;
            refresh: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>>;
        sessionMeta: z.ZodOptional<z.ZodObject<{
            childId: z.ZodString;
            synthetic: z.ZodBoolean;
            command: z.ZodEnum<{
                agent: "agent";
                prompt: "prompt";
                shell: "shell";
                skill: "skill";
                mcp: "mcp";
            }>;
            hostSessionId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        finalizeMeta: z.ZodOptional<z.ZodObject<{
            status: z.ZodEnum<{
                completed: "completed";
                ask: "ask";
                evaluating: "evaluating";
            }>;
            sessionId: z.ZodOptional<z.ZodString>;
            gateSessionId: z.ZodOptional<z.ZodString>;
            directory: z.ZodOptional<z.ZodString>;
            errorDetail: z.ZodOptional<z.ZodString>;
            completionType: z.ZodOptional<z.ZodEnum<{
                completed: "completed";
                ask: "ask";
            }>>;
            assessResult: z.ZodOptional<z.ZodObject<{
                completionType: z.ZodEnum<{
                    completed: "completed";
                    ask: "ask";
                }>;
                passThroughVars: z.ZodRecord<z.ZodString, z.ZodString>;
                askQuestion: z.ZodOptional<z.ZodObject<{
                    questions: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        question: z.ZodString;
                        header: z.ZodOptional<z.ZodString>;
                        options: z.ZodOptional<z.ZodArray<z.ZodObject<{
                            label: z.ZodString;
                            description: z.ZodOptional<z.ZodString>;
                        }, z.core.$strip>>>;
                        multi_select: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strip>>;
                }, z.core.$strip>>;
                errorDetail: z.ZodOptional<z.ZodString>;
                forkSessionId: z.ZodString;
                assessmentRaw: z.ZodString;
            }, z.core.$strip>>;
            gateResult: z.ZodOptional<z.ZodObject<{
                gatesPassed: z.ZodBoolean;
                primaryPassed: z.ZodOptional<z.ZodBoolean>;
                secondaryPassed: z.ZodOptional<z.ZodBoolean>;
                gateDetails: z.ZodOptional<z.ZodObject<{
                    primary: z.ZodObject<{
                        enabled: z.ZodBoolean;
                        passed: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strip>;
                    secondary: z.ZodObject<{
                        enabled: z.ZodBoolean;
                        passed: z.ZodOptional<z.ZodBoolean>;
                        prompt: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>>;
                errorDetail: z.ZodOptional<z.ZodString>;
                gateSessionId: z.ZodString;
                assessmentRaw: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        visitCount: z.ZodNumber;
        branchMeta: z.ZodOptional<z.ZodObject<{
            result: z.ZodOptional<z.ZodString>;
            sessionId: z.ZodOptional<z.ZodString>;
            directory: z.ZodOptional<z.ZodString>;
            status: z.ZodEnum<{
                completed: "completed";
                evaluating: "evaluating";
            }>;
            expectation: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        error: z.ZodOptional<z.ZodString>;
        pausedAt: z.ZodOptional<z.ZodString>;
        resumedAt: z.ZodOptional<z.ZodString>;
        resumePrompt: z.ZodOptional<z.ZodString>;
        sessionMessages: z.ZodOptional<z.ZodArray<z.ZodObject<{
            type: z.ZodEnum<{
                tool: "tool";
                text: "text";
                reasoning: "reasoning";
            }>;
            text: z.ZodOptional<z.ZodString>;
            tool: z.ZodOptional<z.ZodString>;
            args: z.ZodOptional<z.ZodUnknown>;
            output: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$strip>>>;
        pauseEntryId: z.ZodOptional<z.ZodString>;
        loopIteration: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
        loopMeta: z.ZodOptional<z.ZodObject<{
            result: z.ZodOptional<z.ZodString>;
            sessionId: z.ZodOptional<z.ZodString>;
            directory: z.ZodOptional<z.ZodString>;
            status: z.ZodEnum<{
                completed: "completed";
                evaluating: "evaluating";
            }>;
            expectation: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        retryHistory: z.ZodOptional<z.ZodArray<z.ZodObject<{
            mode: z.ZodEnum<{
                continue: "continue";
                revert: "revert";
                fork: "fork";
            }>;
            timestamp: z.ZodString;
            userMessage: z.ZodString;
            revertMessageId: z.ZodOptional<z.ZodString>;
            result: z.ZodEnum<{
                completed: "completed";
                running: "running";
                failed: "failed";
            }>;
        }, z.core.$strip>>>;
        parentSessionId: z.ZodOptional<z.ZodString>;
        output: z.ZodOptional<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
        }, z.core.$loose>>>;
    }, z.core.$strip>>;
    stageInfos: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        status: z.ZodEnum<{
            completed: "completed";
            running: "running";
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            interacting: "interacting";
            paused: "paused";
        }>;
    }, z.core.$strip>>;
    pendingInteractions: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        id: z.ZodString;
        stageId: z.ZodString;
        stepId: z.ZodString;
        sessionId: z.ZodString;
        requestId: z.ZodString;
        kind: z.ZodLiteral<"question">;
        status: z.ZodEnum<{
            pending: "pending";
            replied: "replied";
            rejected: "rejected";
        }>;
        payload: z.ZodObject<{
            questions: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                question: z.ZodString;
                header: z.ZodOptional<z.ZodString>;
                options: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    label: z.ZodString;
                    description: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>>>;
                multi_select: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        answer: z.ZodOptional<z.ZodArray<z.ZodArray<z.ZodString>>>;
        createdAt: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        stageId: z.ZodString;
        stepId: z.ZodString;
        sessionId: z.ZodString;
        requestId: z.ZodString;
        kind: z.ZodLiteral<"permission">;
        status: z.ZodEnum<{
            pending: "pending";
            replied: "replied";
            rejected: "rejected";
        }>;
        payload: z.ZodObject<{
            permission: z.ZodString;
            patterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
            metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            tool: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        answer: z.ZodOptional<z.ZodEnum<{
            once: "once";
            always: "always";
            reject: "reject";
        }>>;
        createdAt: z.ZodString;
    }, z.core.$strip>]>>;
    pendingQueue: z.ZodArray<z.ZodString>;
    visitCounts: z.ZodRecord<z.ZodString, z.ZodNumber>;
    passThroughVars: z.ZodRecord<z.ZodString, z.ZodObject<{
        value: z.ZodString;
        description: z.ZodString;
        refresh: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    activeLoopIterationStack: z.ZodArray<z.ZodNumber>;
    activeLoopNodeId: z.ZodNullable<z.ZodString>;
    activeLoopStack: z.ZodArray<z.ZodString>;
    pausedChildIds: z.ZodArray<z.ZodString>;
    stageContracts: z.ZodRecord<z.ZodString, z.ZodObject<{
        stageId: z.ZodString;
        stageName: z.ZodString;
        status: z.ZodEnum<{
            completed: "completed";
            running: "running";
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            interacting: "interacting";
            paused: "paused";
        }>;
        artifacts: z.ZodArray<z.ZodObject<{
            stepId: z.ZodString;
            outputToId: z.ZodString;
            files: z.ZodArray<z.ZodString>;
            returnPrompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        passThroughVars: z.ZodRecord<z.ZodString, z.ZodObject<{
            value: z.ZodString;
            description: z.ZodString;
            refresh: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        contractArtifacts: z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>;
        completedAt: z.ZodString;
        errorDetail: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>;
/** 工作流定义记录（`definitions` 表 value）：YAML 文本封顶 65536 字符防失控。 */
export declare const WorkflowDefinitionRecordSchema: z.ZodObject<{
    yaml: z.ZodString;
    name: z.ZodString;
    version: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>;
/** Job 记录（`jobs` 表 value）。 */
export declare const JobRecordSchema: z.ZodObject<{
    name: z.ZodString;
    workflowId: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>;
export type CommandConfig = z.infer<typeof CommandConfigSchema>;
export type InputFromItem = z.infer<typeof InputFromItemSchema>;
export type OutputToItem = z.infer<typeof OutputToItemSchema>;
export type PassThroughVar = z.infer<typeof PassThroughVarSchema>;
export type DagBranch = z.infer<typeof DagBranchSchema>;
export type DagLoop = z.infer<typeof DagLoopSchema>;
export type Gates = z.infer<typeof GatesSchema>;
export type WorkflowSettings = z.infer<typeof WorkflowSettingsSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type StepSessionMeta = z.infer<typeof StepSessionMetaSchema>;
export type FinalizeMeta = z.infer<typeof FinalizeMetaSchema>;
export type FinalizeAssessResult = z.infer<typeof FinalizeAssessResultSchema>;
export type GateEvalResult = z.infer<typeof GateEvalResultSchema>;
export type AskUserQuestionPayload = z.infer<typeof AskUserQuestionPayloadSchema>;
export type PendingQuestionEntry = z.infer<typeof PendingQuestionEntrySchema>;
export type PendingPermissionEntry = z.infer<typeof PendingPermissionEntrySchema>;
export type BranchMeta = z.infer<typeof BranchMetaSchema>;
export type SessionMessage = z.infer<typeof SessionMessageSchema>;
export type RetryRecord = z.infer<typeof RetryRecordSchema>;
export type WorkflowTaskState = z.infer<typeof WorkflowTaskStateSchema>;
export type WorkflowDefinitionRecord = z.infer<typeof WorkflowDefinitionRecordSchema>;
export type JobRecord = z.infer<typeof JobRecordSchema>;
//# sourceMappingURL=schema.d.ts.map