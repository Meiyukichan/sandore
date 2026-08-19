import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SandoreError } from "./errors.js";
import { idMatches, replacePassThroughVars } from "./file-utils.js";
import { buildShellEnv, describeError, resolvePassThroughVars, resolveProviderModel as resolveModelRoute, textSummary, } from "./internal.js";
import { finalAssistantOutput, collectSessionMessages } from "./subagents.js";
/** 结构化提示词主头部。 */
const PROMPT_MAIN_HEADER = '你是严谨准确的Step执行Agent，你的任务是参考`## 参考信息`和`## 前置Steps输出`中的信息，\n准确完成`## 你的任务`中的要求。';
/** fillParams 临时会话的任务指令。 */
const FILL_PARAMS_TASK = '你的唯一任务是根据这个参数模板，然后根据（## 输入信息）中的信息，\n或者你可以进行一定程度的探索后，将参数模板的内容按照模板格式填充后返回这个结果！';
/** fillParams 临时会话的红线规则（只读，禁止文件改动与过度探索）。 */
const FILL_PARAMS_RED_LINES = [
    '禁止编辑或者创建或者删除任何文件',
    '禁止过度探索，你的任务是根据已有信息，做足够探索后尽快返回这个参数模板结果',
    '不要过度思考，你的职责不是设计或者开发',
];
/** 子代理 ask 转接标记块起始定界（协议常量，与 workflow 层 interaction-manager 保持一致）。 */
const DELEGATED_ASK_MARKER = '[[SANDORE_ASK]]';
/** 子代理 ask 转接最大轮数（超过后按普通输出处理，防止无限重问）。 */
const MAX_DELEGATED_ASK_ROUNDS = 3;
/** 判定 final output 是否含子代理 ask 转接标记块（仅字符串检测，不做 JSON/schema 校验）。 */
function hasDelegatedAskMarker(output) {
    for (const block of output) {
        if (block.type === 'text' && block.text.includes(DELEGATED_ASK_MARKER)) {
            return true;
        }
    }
    return false;
}
/** 判定两轮 final output 内容是否相同（无进展检测：逐块序列化比较）。 */
function sameOutput(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i += 1) {
        if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
            return false;
        }
    }
    return true;
}
/** 构造缺省 hostAgent 时的最小 parent 桩（每次返回新对象，避免跨 run 共享可变 `session.events`）。 */
function createHostAgentStub() {
    return {
        id: 'sandore-host',
        options: {},
        session: { events: [] },
        inbox: { hasPending: false },
        status: 'idle',
        ctx: undefined,
        whenIdle: async () => { },
    };
}
/** 渲染「## 前置Steps输出与产物」子节（无前置输出返回空）。 */
function renderPreviousOutputs(previousOutputs) {
    if (previousOutputs.length === 0) {
        return [];
    }
    const sections = ['', '## 前置Steps输出与产物'];
    for (const previous of previousOutputs) {
        sections.push(`### 前置Step: ${previous.name} (${previous.id})`);
        sections.push(`<${previous.id}>`);
        sections.push('  <output>');
        for (const line of previous.returnPrompt.split('\n')) {
            sections.push(`    ${line}`);
        }
        sections.push('  </output>');
        sections.push('  <artifacts>');
        for (const file of previous.files) {
            sections.push(`    - ${file}`);
        }
        sections.push('  </artifacts>');
        sections.push(`</${previous.id}>`);
    }
    return sections;
}
/** 命中名称数组时加前缀，未命中回退纯提示词。 */
function prefixIfAllowed(resolved, prefix, name, allowed) {
    if (allowed !== undefined && allowed.includes(name)) {
        return `${prefix}${resolved}`;
    }
    return resolved;
}
/** 按命令类型构建「## 你的任务」内容（透传变量替换 + 名称校验前缀）。 */
function buildTaskText(command, vars, skills, mcps, agents) {
    const name = command.value.promptText;
    const resolved = replacePassThroughVars(name, vars);
    switch (command.type) {
        case 'agent':
            return prefixIfAllowed(resolved, '使用 Agent：', name, agents);
        case 'skill':
            return prefixIfAllowed(resolved, '使用 skill：', name, skills);
        case 'mcp':
            return prefixIfAllowed(resolved, '使用 MCP：', name, mcps);
        default:
            return resolved;
    }
}
/**
 * 构建结构化提示词（主头部 + `## 你的任务` + `## 参考信息` + 可选
 * `### 当前Step参数` + `## 前置Steps输出与产物`）。
 */
function buildPromptText(taskText, originalInput, previousOutputs, paramsText) {
    const sections = [];
    sections.push(PROMPT_MAIN_HEADER);
    sections.push('');
    sections.push('## 你的任务');
    sections.push(taskText);
    sections.push('');
    sections.push('## 参考信息');
    sections.push('### 用户原始需求');
    sections.push(originalInput);
    if (paramsText !== undefined) {
        sections.push('### 当前Step参数');
        sections.push(paramsText);
    }
    sections.push(...renderPreviousOutputs(previousOutputs));
    return sections.join('\n');
}
/** 构建 fillParams 临时会话提示词（输入信息 + 参数模板 + 任务指令 + 红线规则）。 */
function buildFillParamsPrompt(originalInput, previousOutputs, template) {
    const sections = [];
    sections.push('## 输入信息');
    sections.push('### 用户原始需求');
    sections.push(originalInput);
    sections.push(...renderPreviousOutputs(previousOutputs));
    sections.push('');
    sections.push('## 参数模板');
    sections.push(template);
    sections.push('');
    sections.push('## 你的任务');
    sections.push(FILL_PARAMS_TASK);
    sections.push('');
    sections.push('## 红线规则');
    for (const rule of FILL_PARAMS_RED_LINES) {
        sections.push(`- ${rule}`);
    }
    return sections.join('\n');
}
/** 从 `inputFrom` 的 `path` 取 Step id（简化格式：path 直接为 stepId，单段）。 */
function stepIdFromPath(path) {
    return path;
}
/** 解析 shell Step 的 stdin：`inputFrom` 命中前置输出时返回 JSON 序列化，否则 undefined。 */
function resolveShellStdin(step, previousOutputs) {
    const inputFrom = step.inputFrom;
    if (inputFrom === undefined || inputFrom.length === 0) {
        return undefined;
    }
    const matched = [];
    for (const item of inputFrom) {
        if (item.regex !== undefined) {
            let regex;
            try {
                regex = new RegExp(item.regex);
            }
            catch {
                continue;
            }
            for (const previous of previousOutputs) {
                if (regex.test(previous.returnPrompt)) {
                    matched.push(previous);
                }
            }
        }
        else if (item.path !== undefined) {
            const stepId = stepIdFromPath(item.path);
            for (const previous of previousOutputs) {
                if (idMatches(previous.id, stepId)) {
                    matched.push(previous);
                }
            }
        }
    }
    if (matched.length === 0) {
        return undefined;
    }
    return JSON.stringify(matched);
}
/**
 * 单 Step 执行器。
 *
 * 构造时绑定 `ctx` 与引擎级配置；`run()` 按 `step.command.type` 分发到
 * shell/prompt/agent/skill/mcp 五条路径。成功返回 `{ output: ContentBlock[] }`，
 * 失败抛 `SandoreError`（超时 → `STEP_TIMEOUT`，其余 → `STEP_EXECUTION`）。
 */
export class StepRunner {
    ctx;
    config;
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
    }
    /** 执行单个 Step；失败抛 `SandoreError`。 */
    async run(request) {
        const command = request.step.command;
        if (command === undefined) {
            throw new SandoreError(`step '${request.step.id}' has no command`, 'STEP_EXECUTION');
        }
        switch (command.type) {
            case 'shell':
                return await this.runShell(command, request);
            case 'prompt':
                return await this.runPrompt(command, request);
            case 'agent':
            case 'skill':
            case 'mcp':
                return await this.runSubagent(command, request);
            default:
                // 穷尽 5 类型后 `command` 已收窄为 never；此处仅防御运行期注入的未知命令类型。
                throw new SandoreError(`unsupported step command type '${command.type}'`, 'STEP_EXECUTION');
        }
    }
    async runShell(command, request) {
        const resolvedCommand = replacePassThroughVars(command.value.command, resolvePassThroughVars(request.passThroughVars, request.loopTurn, request.loopMaxIterations));
        const stdin = resolveShellStdin(request.step, request.previousOutputs);
        const env = buildShellEnv(request.passThroughVars, request.loopTurn, request.loopMaxIterations);
        // 统一经 `ctx.shell`（平台 shell 解释器，如 PowerShell/bash）执行：env/stdin
        // 由 ShellExecRequest 携带。不要在这里改用 `ctx.subprocess.spawn` 直接执行
        // 命令——subprocess 不做 shell 解释，PowerShell cmdlet（New-Item 等）不是可
        // 执行文件，带透传变量/inputFrom 的 shell 步骤会失败。
        return await this.runShellSimple(resolvedCommand, request, stdin, env);
    }
    async runShellSimple(command, request, stdin = undefined, env = undefined) {
        const shellRequest = {
            command,
            timeoutMs: this.stepTimeoutMs(request.step),
            ...(request.workdir === undefined ? {} : { workdir: request.workdir }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(stdin === undefined ? {} : { stdin }),
            ...(env === undefined ? {} : { env }),
        };
        const spec = this.ctx.shell.resolve(shellRequest);
        const result = await this.ctx.shell.run(spec);
        return this.toShellResult(result);
    }
    toShellResult(result) {
        if (result.exitCode === 0 && !result.timedOut && !result.aborted) {
            return { output: [{ type: 'text', text: result.stdout.text }] };
        }
        const stderr = result.stderr.text.trim();
        const stderrSummary = stderr === '' ? '(no stderr)' : stderr;
        if (result.timedOut) {
            throw new SandoreError(`shell command timed out: ${stderrSummary}`, 'STEP_TIMEOUT');
        }
        const reason = result.aborted
            ? 'aborted'
            : `exited with code ${result.exitCode === null ? 'signal' : String(result.exitCode)}`;
        throw new SandoreError(`shell command ${reason}: ${stderrSummary}`, 'STEP_EXECUTION');
    }
    /** 解析 Step 级 timeout（分钟）→ 毫秒；缺省回退引擎 defaultTimeoutMs。 */
    stepTimeoutMs(step) {
        return step.timeout === undefined ? this.config.defaultTimeoutMs : step.timeout * 60_000;
    }
    async runPrompt(command, request) {
        const route = await this.resolveProviderModel(command.value);
        const taskText = buildTaskText(command, resolvePassThroughVars(request.passThroughVars, request.loopTurn, request.loopMaxIterations), this.config.skills, this.config.mcps, this.config.agents);
        const promptText = buildPromptText(taskText, request.originalInput, request.previousOutputs, undefined);
        const message = createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: promptText }],
        });
        const options = {
            provider: route.provider,
            model: route.model,
            messages: [message],
            ...(request.signal === undefined ? {} : { signal: request.signal }),
        };
        const assembler = new BlockAssembler();
        for await (const chunk of this.ctx.llm.stream(options)) {
            assembler.push(chunk);
        }
        const output = assembler.blocks();
        const finish = assembler.finish;
        if (finish.kind === 'error') {
            throw new SandoreError(`prompt step failed: ${finish.failure.message}`, 'STEP_EXECUTION');
        }
        if (finish.kind === 'aborted') {
            throw new SandoreError(`prompt step aborted: ${finish.failure.message}`, 'STEP_EXECUTION');
        }
        return { output };
    }
    async runSubagent(command, request) {
        const paramsText = command.type === 'agent' && command.value.agentParamsTemplate !== undefined
            ? await this.fillParams(command, command.value.agentParamsTemplate, request)
            : undefined;
        const route = await this.resolveProviderModel(command.value);
        const taskText = buildTaskText(command, resolvePassThroughVars(request.passThroughVars, request.loopTurn, request.loopMaxIterations), this.config.skills, this.config.mcps, this.config.agents);
        const promptText = buildPromptText(taskText, request.originalInput, request.previousOutputs, paramsText);
        const started = await this.ctx.subagents.startContinuable({
            provider: route.provider,
            label: `step ${request.step.id}`,
            request: {
                prompt: [{ type: 'text', text: promptText }],
                parent: this.resolveParent(),
                agentOptions: { provider: route.provider, model: route.model },
            },
            signal: request.signal ?? new AbortController().signal,
        });
        await this.config.onChildStarted?.(request.step.id, started.childId);
        return this.collectSubagentOutput(command.type, started.childId, request.step.id, request.stageId);
    }
    /**
     * 暂停后恢复子代理 Step：重新 `whenIdle` + `finalAssistantOutput` + ask 转接循环。
     *
     * 暂停登记表命中的子代理 Step 被 `interrupt` 打断后，`resumeStep` 的 `followup` 重新
     * 驱动子代理；本方法在 `followup` 之后被引擎续跑路径调用，重新等待子代理静止并取回
     * 最终 assistant 输出（等价于首次执行时的输出收集尾段）。
     */
    async resumeSubagent(commandType, childId, stepId, stageId) {
        return this.collectSubagentOutput(commandType, childId, stepId, stageId);
    }
    /** 收集已启动子代理的最终输出（首次执行与暂停续跑共用：whenIdle + final output + ask 转接）。 */
    async collectSubagentOutput(commandType, childId, stepId, stageId) {
        const child = this.ctx.agents.get(childId);
        if (child === undefined) {
            throw new SandoreError(`subagent '${childId}' not found in registry`, 'STEP_EXECUTION');
        }
        await child.whenIdle();
        let output = finalAssistantOutput(child.session.events);
        if (output === undefined) {
            throw new SandoreError('subagent produced no assistant output', 'STEP_EXECUTION');
        }
        const onDelegatedAsk = this.config.onDelegatedAsk;
        if (onDelegatedAsk !== undefined) {
            // 子代理 ask 转接：final result 含标记块时回调 workflow 层解析/转接，答案 followup
            // 注回后子代理续跑，重新取 final output（可多轮 ask，直至无标记块或转接方放弃）。
            // 双保险守卫防无限重问：① 无进展（本轮 output 与上轮相同）即 break；② 超过最大
            // 转接轮数即 break，均按普通输出处理。
            let rounds = 0;
            while (hasDelegatedAskMarker(output) && rounds < MAX_DELEGATED_ASK_ROUNDS) {
                const delegated = await onDelegatedAsk({
                    childId,
                    output,
                    stepId,
                    stageId,
                });
                if (!delegated) {
                    break;
                }
                rounds += 1;
                await child.whenIdle();
                const next = finalAssistantOutput(child.session.events);
                if (next === undefined || sameOutput(next, output)) {
                    break;
                }
                output = next;
            }
        }
        return {
            output,
            sessionMeta: { childId, synthetic: false, command: commandType },
            // §3.8A：子代理消息持久化（whenIdle 后采集，随结果带出 → finishCommandNode 写
            // executed.sessionMessages → onPersist 定格；前端内嵌消息框/失败·暂停最近 N 条）。
            sessionMessages: collectSessionMessages(child.session.events),
        };
    }
    /** 用临时会话按模板填充参数；失败（error/aborted/抛错）回退模板原文。 */
    async fillParams(command, template, request) {
        const route = await this.resolveProviderModel(command.value);
        const promptText = buildFillParamsPrompt(request.originalInput, request.previousOutputs, template);
        const message = createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: promptText }],
        });
        const options = {
            provider: route.provider,
            model: route.model,
            messages: [message],
            ...(request.signal === undefined ? {} : { signal: request.signal }),
        };
        try {
            const assembler = new BlockAssembler();
            for await (const chunk of this.ctx.llm.stream(options)) {
                assembler.push(chunk);
            }
            const finish = assembler.finish;
            if (finish.kind === 'error' || finish.kind === 'aborted') {
                this.ctx.logger.warn(`sandore: fillParams temp session ${finish.kind}, falling back to template`);
                return template;
            }
            const text = textSummary(assembler.blocks());
            return text === '' ? template : text;
        }
        catch (error) {
            this.ctx.logger.warn(`sandore: fillParams temp session failed: ${describeError(error)}`);
            return template;
        }
    }
    async resolveProviderModel(value) {
        return resolveModelRoute(value, this.config, this.ctx.llm, (provider, model) => this.ctx.logger.warn(`sandore: step falls back to directory provider '${provider}' model '${model}'`));
    }
    /** 子代理 parent：优先 config.hostAgent，缺省用最小桩对象。 */
    resolveParent() {
        return this.config.hostAgent ?? createHostAgentStub();
    }
}
//# sourceMappingURL=step-runner.js.map