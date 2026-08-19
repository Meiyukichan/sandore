/** sandore 存储域声明：两表 `definitions`/`state`，Zod 校验每一条记录（去 job 概念）。 */
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
        state: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, {
            taskId: string;
            workflowId: string;
            cwd: string;
            status: "pending" | "running" | "interacting" | "completed" | "failed" | "aborted" | "paused";
            originalInput: string;
            currentStageId: string;
            executedSteps: {
                id: string;
                stageId: string;
                name: string;
                status: "running" | "interacting" | "completed" | "failed" | "paused" | "blocked" | "ready";
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
                    command: "shell" | "agent" | "prompt" | "skill" | "mcp";
                    hostSessionId?: string | undefined;
                } | undefined;
                finalizeMeta?: {
                    status: "completed" | "evaluating" | "ask";
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
                createdAt?: string | undefined;
                attemptIndex?: number | undefined;
                startedAt?: string | undefined;
                updatedAt?: string | undefined;
                branchMeta?: {
                    status: "completed" | "evaluating";
                    result?: string | undefined;
                    sessionId?: string | undefined;
                    directory?: string | undefined;
                    expectation?: string | undefined;
                } | undefined;
                error?: string | undefined;
                pausedAt?: string | undefined;
                sessionMessages?: {
                    type: "text" | "tool" | "reasoning";
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
                    result: "running" | "completed" | "failed";
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
                status: "running" | "interacting" | "completed" | "failed" | "paused" | "blocked" | "ready";
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
                status: "running" | "interacting" | "completed" | "failed" | "paused" | "blocked" | "ready";
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
            jobId?: string | undefined;
            workflowName?: string | undefined;
            description?: string | undefined;
            modelSelection?: {
                provider: string;
                model: string;
                reasoningEffort?: string | undefined;
            } | undefined;
            permission?: string | undefined;
            userMessages?: {
                id: string;
                kind: "input" | "answer" | "resume" | "retry";
                target: string;
                content: string;
                createdAt: string;
            }[] | undefined;
        }>;
    };
};
//# sourceMappingURL=domain.d.ts.map