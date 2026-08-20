import { BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SandoreError } from "./errors.js";
import { replacePassThroughVars } from "./file-utils.js";
import { buildShellEnv, resolvePassThroughVars, resolveProviderModel as resolveModelRoute, textSummary, } from "./internal.js";
/** 结构化分支评估提示词主头部。 */
const BRANCH_PROMPT_HEADER = '你是严谨准确的DAG分支评估Agent，你的任务是根据分支条件与上下文，判断本次执行应路由到哪个分支。';
/** 分支评估红线规则（只读，禁止文件改动与过度思考）。 */
const BRANCH_RED_LINES = [
    '禁止编辑、创建或删除任何文件',
    '禁止过度思考，你的职责是尽快判断分支并返回结果',
];
/** 条件分支 AI 评估解析失败重试上限（首次评估 + 最多 N 次 follow-up 纠正重试）。 */
const MAX_BRANCH_EVAL_RETRIES = 2;
/** 重试时附给 AI 的纠正提示（要求仅返回合法 shouldExecute JSON）。 */
const SHOULD_EXECUTE_CORRECTION_HINT = '未能从你的上一轮输出中解析出 shouldExecute 布尔值，请仅返回 JSON：{"shouldExecute": true} 或 {"shouldExecute": false}。';
/** 构建结构化分支评估提示词（主头部 + 任务 + 上下文 + 分支列表 + 返回格式 + 红线规则）。 */
function buildBranchPrompt(taskText, contextMessage, branches) {
    const sections = [BRANCH_PROMPT_HEADER];
    sections.push('');
    sections.push('## 你的任务');
    sections.push(taskText);
    sections.push('');
    sections.push('## 参考信息');
    sections.push('### 前置上下文');
    sections.push(contextMessage);
    sections.push('');
    sections.push('## 候选分支');
    if (branches.length === 0) {
        sections.push('（无显式分支，请依据任务判断返回 shouldExecute）');
    }
    for (const branch of branches) {
        const label = branch.label ?? branch.next;
        sections.push(`- ${label}`);
    }
    sections.push('');
    sections.push('## 返回格式');
    sections.push('请仅返回 JSON，格式为：{"shouldExecute": true} 或 {"shouldExecute": false}，其中 shouldExecute 表示是否执行当前候选分支。');
    sections.push('');
    sections.push('## 红线规则');
    for (const rule of BRANCH_RED_LINES) {
        sections.push(`- ${rule}`);
    }
    return sections.join('\n');
}
/** 解析外部输出 JSON 为对象；解析失败或非对象返回 undefined。 */
function parseJsonObject(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    // raw 已收窄为非空 object，转换为可索引访问的 Record 以读取字段。
    return raw;
}
/**
 * 三级解析循环跳出结果（public）。
 *
 * ① JSON 解析取 `shouldBreak`（布尔转字符串，字符串 `"true"`/`"false"` 转小写）；
 * ② regex 回退 `/"shouldBreak"\s*:\s*(true|false)/i`（匹配后转小写）；③ `raw.trim()`。
 */
export function extractBreakResult(raw) {
    const parsed = parseJsonObject(raw);
    if (parsed !== undefined) {
        const shouldBreak = parsed['shouldBreak'];
        if (typeof shouldBreak === 'boolean') {
            return String(shouldBreak);
        }
        if (typeof shouldBreak === 'string' && /^(true|false)$/i.test(shouldBreak)) {
            return shouldBreak.toLowerCase();
        }
    }
    const match = raw.match(/"shouldBreak"\s*:\s*(true|false)/i);
    const extracted = match?.[1];
    if (extracted !== undefined) {
        return extracted.toLowerCase();
    }
    return raw.trim();
}
/**
 * 两层解析条件分支 shouldExecute 布尔（public）。
 *
 * ① JSON 解析取 `shouldExecute`（布尔直接返回；字符串 `"true"`/`"false"` 大小写
 * 不敏感转布尔）；② regex 回退 `/\{"shouldExecute"\s*:\s*(true|false)/i`（匹配后
 * 转小写判定）。两层均不满足返回 undefined（解析失败，触发
 * {@link BranchEvaluator.evaluateCondition} 重试或由调用方按 false 处理）。
 * **仅条件分支使用**——循环跳出走 {@link extractBreakResult} 的 shouldBreak 字段，
 * 两者分场景字段互不复用。
 */
export function extractShouldExecute(raw) {
    const parsed = parseJsonObject(raw);
    if (parsed !== undefined) {
        const shouldExecute = parsed['shouldExecute'];
        if (typeof shouldExecute === 'boolean') {
            return shouldExecute;
        }
        if (typeof shouldExecute === 'string' && /^(true|false)$/i.test(shouldExecute)) {
            return shouldExecute.toLowerCase() === 'true';
        }
    }
    const match = raw.match(/\{"shouldExecute"\s*:\s*(true|false)/i);
    const extracted = match?.[1];
    if (extracted !== undefined) {
        return extracted.toLowerCase() === 'true';
    }
    return undefined;
}
/**
 * 判定分支评估结果是否匹配 expectation。
 *
 * 语义对齐基准 `workflow-engine-helpers.matchesExpectation`：默认大小写不敏感 +
 * 包含匹配（宽松，便于迁移工作流）。需正则时用**显式定界符**——expectation 以
 * `/` 起始且以 `/` 结尾（如 `/build-[0-9]+/`）才视为正则，取中间 inner 用
 * `new RegExp(inner)` 匹配；非法正则返回 false。无定界符一律走包含匹配，此时
 * 字面量含 `.`、`\`、`%`、括号等不会被启发式误判为正则（废除旧
 * `hasRegexMetacharacters` 启发式）。expectation 为 undefined 时返回 false（守卫，
 * 避免静默变并行分支）。
 */
export function matchesExpectation(result, expectation) {
    if (expectation === undefined) {
        return false;
    }
    // 显式正则：`/pattern/` 定界（首尾均为 `/` 且长度 ≥ 2）。仅此形态走正则路径。
    if (expectation.length >= 2 && expectation.startsWith('/') && expectation.endsWith('/')) {
        const inner = expectation.slice(1, -1);
        let regex;
        try {
            regex = new RegExp(inner);
        }
        catch {
            return false;
        }
        return regex.test(result);
    }
    // 默认路径：大小写不敏感 + 包含匹配（与基准一致）。
    const normalizedOutput = result.trim().toLowerCase();
    const normalizedExpectation = expectation.trim().toLowerCase();
    return normalizedOutput === normalizedExpectation || normalizedOutput.includes(normalizedExpectation);
}
/**
 * 分支条件两阶段评估器。
 *
 * 构造时绑定 `ctx` 与引擎级配置；`start()` 按 `condition.type` 分发（shell 直接
 * 执行，其余四类走 `ctx.llm.stream()` 临时会话），`collect()` 聚合输出文本，
 * `evaluate()` 一步完成。AI 会话失败（error/aborted）抛 `SandoreError`。
 */
export class BranchEvaluator {
    ctx;
    config;
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
    }
    /** 启动评估，返回中间态；AI 会话带 sessionHandle，shell 直接执行完成。 */
    async start(condition, contextMessage, options = {}) {
        switch (condition.type) {
            case 'shell':
                return await this.startShell(condition, options);
            case 'agent':
            case 'prompt':
            case 'skill':
            case 'mcp':
                return await this.startAi(condition, contextMessage, options);
            default:
                // 穷尽 5 类型后 `condition` 已收窄为 never；此处仅防御运行期注入的未知命令类型。
                throw new SandoreError(`unsupported branch condition type '${condition.type}'`, 'STEP_EXECUTION');
        }
    }
    /** 收集评估结果：聚合 AI 输出文本（shell 直接返回 stdout）。 */
    async collect(partial) {
        const output = await partial.outputPromise;
        return { output, sessionHandle: partial.sessionHandle };
    }
    /** 一步完成两阶段评估。 */
    async evaluate(condition, contextMessage, options = {}) {
        const partial = await this.start(condition, contextMessage, options);
        return await this.collect(partial);
    }
    /**
     * 条件分支评估（带解析失败重试）。
     *
     * shell 条件直接委托 {@link evaluate}（走 matchesExpectation，无重试）；AI 条件
     * （agent/prompt/skill/mcp）首轮发送分支评估提示词，若 {@link extractShouldExecute}
     * 解析失败（undefined），则把上一轮 AI 输出 + {@link SHOULD_EXECUTE_CORRECTION_HINT}
     * 构造为 follow-up 多轮消息重新评估，最多重试 {@link MAX_BRANCH_EVAL_RETRIES} 次；
     * 重试耗尽记日志（条件不通过由调用方 decideCondition 的 `extractShouldExecute === true`
     * 判定兜底为 false）。仅条件分支使用——循环跳出仍走 {@link evaluate} +
     * extractBreakResult（shouldBreak 字段，缺陷 4 范畴）。
     */
    async evaluateCondition(condition, contextMessage, options = {}) {
        if (condition.type === 'shell') {
            return this.evaluate(condition, contextMessage, options);
        }
        const route = await this.resolveProviderModel(condition.value);
        const taskText = replacePassThroughVars(condition.value.promptText, resolvePassThroughVars(options.passThroughVars, options.loopTurn, options.loopMaxIterations));
        const basePrompt = buildBranchPrompt(taskText, contextMessage, options.branches ?? []);
        const sessionHandle = this.newSessionHandle();
        const messages = [
            createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: basePrompt }] }),
        ];
        let output = await this.streamAi(route, messages, options.signal);
        let attempts = 0;
        while (extractShouldExecute(output) === undefined && attempts < MAX_BRANCH_EVAL_RETRIES) {
            attempts++;
            messages.push(createAssistantMessage({
                content: [{ type: 'text', text: output }],
                source: { provider: route.provider, model: route.model },
            }));
            messages.push(createUserMessage({
                source: { kind: 'user' },
                content: [{ type: 'text', text: SHOULD_EXECUTE_CORRECTION_HINT }],
            }));
            output = await this.streamAi(route, messages, options.signal);
        }
        if (extractShouldExecute(output) === undefined) {
            this.ctx.logger.warn(`sandore: branch condition shouldExecute unparseable after ${attempts} retry attempt(s); last output: ${output.slice(0, 200)}`);
        }
        return { output, sessionHandle };
    }
    async startAi(condition, contextMessage, options) {
        const route = await this.resolveProviderModel(condition.value);
        const taskText = replacePassThroughVars(condition.value.promptText, resolvePassThroughVars(options.passThroughVars, options.loopTurn, options.loopMaxIterations));
        const promptText = buildBranchPrompt(taskText, contextMessage, options.branches ?? []);
        const message = createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: promptText }],
        });
        const sessionHandle = this.newSessionHandle();
        return {
            sessionHandle,
            outputPromise: this.streamAi(route, [message], options.signal),
        };
    }
    /** 单轮 AI 临时会话流式评估：聚合输出文本；error/aborted 抛 SandoreError。 */
    async streamAi(route, messages, signal) {
        const generateOptions = {
            provider: route.provider,
            model: route.model,
            messages,
            ...(signal === undefined ? {} : { signal }),
        };
        const assembler = new BlockAssembler();
        const stream = this.ctx.llm.stream(generateOptions);
        return this.aggregate(stream, assembler);
    }
    async startShell(condition, options) {
        const command = replacePassThroughVars(condition.value.command, resolvePassThroughVars(options.passThroughVars, options.loopTurn, options.loopMaxIterations));
        const env = buildShellEnv(options.passThroughVars, options.loopTurn, options.loopMaxIterations);
        const output = await this.runShellCommand(command, options, env);
        return { sessionHandle: null, outputPromise: Promise.resolve(output) };
    }
    /** 聚合 AI 临时会话输出为文本；error/aborted 抛 SandoreError。 */
    async aggregate(stream, assembler) {
        for await (const chunk of stream) {
            assembler.push(chunk);
        }
        const finish = assembler.finish;
        if (finish.kind === 'error') {
            throw new SandoreError(`branch evaluation failed: ${finish.failure.message}`, 'STEP_EXECUTION');
        }
        if (finish.kind === 'aborted') {
            throw new SandoreError(`branch evaluation aborted: ${finish.failure.message}`, 'STEP_EXECUTION');
        }
        return textSummary(assembler.blocks());
    }
    async runShellCommand(command, options, env) {
        // 统一经 `ctx.shell`（平台 shell 解释器）执行：env/stdin 由 ShellExecRequest
        // 携带。不要用 `ctx.subprocess.spawn` 直接执行——subprocess 不做 shell 解释，
        // PowerShell cmdlet 等内建命令不是可执行文件，条件命令会失败。
        const request = {
            command,
            timeoutMs: this.config.defaultTimeoutMs,
            ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
            ...(env === undefined ? {} : { env }),
        };
        const spec = this.ctx.shell.resolve(request);
        const result = await this.ctx.shell.run(spec);
        return this.toStdout(result);
    }
    /** shell 结果 → 输出文本：成功返回 stdout，非零退出/超时/中止抛 SandoreError。 */
    toStdout(result) {
        if (result.exitCode === 0 && !result.timedOut && !result.aborted) {
            return result.stdout.text;
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
    /** 生成临时会话标识（随机 8 位 hex）。 */
    newSessionHandle() {
        const random = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
        return `eval-${random}`;
    }
    /** provider/model 三层回退：条件定义 → 引擎配置 → ctx.llm 目录兜底。 */
    async resolveProviderModel(value) {
        return resolveModelRoute(value, this.config, this.ctx.llm);
    }
}
//# sourceMappingURL=branch-evaluator.js.map