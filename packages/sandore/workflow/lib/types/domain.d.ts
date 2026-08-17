/** sandore 存储域声明：三表 `definitions`/`jobs`/`state`，Zod 校验每一条记录。 */
export declare const sandoreDomainSpec: {
    name: string;
    version: number;
    tables: {
        definitions: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, {
            yaml: string;
            name: string;
            version: string;
            createdAt: string;
            updatedAt: string;
            description?: string | undefined;
        }>;
        jobs: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, {
            name: string;
            workflowId: string;
            createdAt: string;
            updatedAt: string;
            cwd?: string | undefined;
        }>;
        state: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, {
            taskId: string;
            jobId: string;
            workflowId: string;
            cwd: string;
            status: "pending" | "completed" | "running" | "failed" | "interacting" | "paused" | "aborted";
            originalInput: string;
            currentStageId: string;
            executedSteps: {
                type: "default";
                id: string;
                stageId: string;
                name: string;
                status: "completed" | "running" | "failed" | "blocked" | "ready" | "interacting" | "paused";
                visitCount: number;
                stepId?: string | undefined;
                command?: {
                    type: "agent";
                    value: {
                        promptText: string;
                        agentParamsTemplate?: string | undefined;
                        providerId?: string | undefined;
                        modelId?: string | undefined;
                    };
                } | {
                    type: "prompt";
                    value: {
                        promptText: string;
                        providerId?: string | undefined;
                        modelId?: string | undefined;
                    };
                } | {
                    type: "shell";
                    value: {
                        command: string;
                    };
                } | {
                    type: "skill";
                    value: {
                        promptText: string;
                        providerId?: string | undefined;
                    };
                } | {
                    type: "mcp";
                    value: {
                        promptText: string;
                    };
                } | undefined;
                inputFrom?: {
                    id: string;
                    path?: string | undefined;
                    regex?: string | undefined;
                }[] | undefined;
                outputTo?: {
                    id: string;
                    path?: string | undefined;
                    regex?: string | undefined;
                }[] | undefined;
                passThroughVars?: {
                    name: string;
                    value: string;
                    description: string;
                    refresh?: boolean | undefined;
                }[] | undefined;
                sessionMeta?: {
                    childId: string;
                    synthetic: boolean;
                    command: "agent" | "prompt" | "shell" | "skill" | "mcp";
                    hostSessionId?: string | undefined;
                } | undefined;
                finalizeMeta?: {
                    status: "completed" | "ask" | "evaluating";
                    sessionId?: string | undefined;
                    gateSessionId?: string | undefined;
                    directory?: string | undefined;
                    errorDetail?: string | undefined;
                    completionType?: "completed" | "ask" | undefined;
                    assessResult?: {
                        completionType: "completed" | "ask";
                        passThroughVars: Record<string, string>;
                        forkSessionId: string;
                        assessmentRaw: string;
                        askQuestion?: {
                            questions: {
                                id: string;
                                question: string;
                                header?: string | undefined;
                                options?: {
                                    label: string;
                                    description?: string | undefined;
                                }[] | undefined;
                                multi_select?: boolean | undefined;
                            }[];
                        } | undefined;
                        errorDetail?: string | undefined;
                    } | undefined;
                    gateResult?: {
                        gatesPassed: boolean;
                        gateSessionId: string;
                        assessmentRaw: string;
                        primaryPassed?: boolean | undefined;
                        secondaryPassed?: boolean | undefined;
                        gateDetails?: {
                            primary: {
                                enabled: boolean;
                                passed?: boolean | undefined;
                            };
                            secondary: {
                                enabled: boolean;
                                passed?: boolean | undefined;
                                prompt?: string | undefined;
                            };
                        } | undefined;
                        errorDetail?: string | undefined;
                    } | undefined;
                } | undefined;
                branchMeta?: {
                    status: "completed" | "evaluating";
                    result?: string | undefined;
                    sessionId?: string | undefined;
                    directory?: string | undefined;
                    expectation?: string | undefined;
                } | undefined;
                error?: string | undefined;
                pausedAt?: string | undefined;
                resumedAt?: string | undefined;
                resumePrompt?: string | undefined;
                sessionMessages?: {
                    type: "tool" | "text" | "reasoning";
                    text?: string | undefined;
                    tool?: string | undefined;
                    args?: unknown;
                    output?: unknown;
                }[] | undefined;
                pauseEntryId?: string | undefined;
                loopIteration?: number[] | undefined;
                loopMeta?: {
                    status: "completed" | "evaluating";
                    result?: string | undefined;
                    sessionId?: string | undefined;
                    directory?: string | undefined;
                    expectation?: string | undefined;
                } | undefined;
                retryHistory?: {
                    mode: "continue" | "revert" | "fork";
                    timestamp: string;
                    userMessage: string;
                    result: "completed" | "running" | "failed";
                    revertMessageId?: string | undefined;
                }[] | undefined;
                parentSessionId?: string | undefined;
                output?: {
                    [x: string]: unknown;
                    type: string;
                }[] | undefined;
            }[];
            stageInfos: {
                id: string;
                name: string;
                status: "completed" | "running" | "failed" | "blocked" | "ready" | "interacting" | "paused";
            }[];
            pendingInteractions: ({
                id: string;
                stageId: string;
                stepId: string;
                sessionId: string;
                requestId: string;
                kind: "question";
                status: "pending" | "replied" | "rejected";
                payload: {
                    questions: {
                        id: string;
                        question: string;
                        header?: string | undefined;
                        options?: {
                            label: string;
                            description?: string | undefined;
                        }[] | undefined;
                        multi_select?: boolean | undefined;
                    }[];
                };
                createdAt: string;
                answer?: string[][] | undefined;
            } | {
                id: string;
                stageId: string;
                stepId: string;
                sessionId: string;
                requestId: string;
                kind: "permission";
                status: "pending" | "replied" | "rejected";
                payload: {
                    permission: string;
                    patterns?: string[] | undefined;
                    metadata?: Record<string, unknown> | undefined;
                    tool?: string | undefined;
                };
                createdAt: string;
                answer?: "once" | "always" | "reject" | undefined;
            })[];
            pendingQueue: string[];
            visitCounts: Record<string, number>;
            passThroughVars: Record<string, {
                value: string;
                description: string;
                refresh?: boolean | undefined;
            }>;
            activeLoopIterationStack: number[];
            activeLoopNodeId: string | null;
            activeLoopStack: string[];
            pausedChildIds: string[];
            stageContracts: Record<string, {
                stageId: string;
                stageName: string;
                status: "completed" | "running" | "failed" | "blocked" | "ready" | "interacting" | "paused";
                artifacts: {
                    stepId: string;
                    outputToId: string;
                    files: string[];
                    returnPrompt?: string | undefined;
                }[];
                passThroughVars: Record<string, {
                    value: string;
                    description: string;
                    refresh?: boolean | undefined;
                }>;
                contractArtifacts: Record<string, string[]>;
                completedAt: string;
                errorDetail?: string | undefined;
            }>;
            createdAt: string;
            updatedAt: string;
        }>;
    };
};
//# sourceMappingURL=domain.d.ts.map