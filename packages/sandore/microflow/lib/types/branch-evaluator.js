import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SandoreError } from "./errors.js";
import { replacePassThroughVars } from "./file-utils.js";
import { buildShellEnv, resolvePassThroughVars, resolveProviderModel as resolveModelRoute, splitCommand, textSummary, } from "./internal.js";
/** 结构化分支评估提示词主头部。 */
const BRANCH_PROMPT_HEADER = '你是严谨准确的DAG分支评估Agent，你的任务是根据分支条件与上下文，判断本次执行应路由到哪个分支。';
/** 分支评估红线规则（只读，禁止文件改动与过度思考）。 */
const BRANCH_RED_LINES = [
    '禁止编辑、创建或删除任何文件',
    '禁止过度思考，你的职责是尽快判断分支并返回结果',
];
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
        sections.push('（无显式分支，请依据任务判断返回 expectation）');
    }
    for (const branch of branches) {
        const label = branch.label ?? branch.next;
        const expectation = branch.expectation ?? '(并行分支，无 expectation)';
        sections.push(`- ${label}: expectation=${expectation}`);
    }
    sections.push('');
    sections.push('## 返回格式');
    sections.push('请仅返回 JSON，格式为：{"branchExpectation": "..."}，其中 branchExpectation 为命中分支的 expectation 值。');
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
 * 三级解析分支 expectation。
 *
 * ① JSON 解析取 `branchExpectation` 字段；② regex 回退
 * `/"branchExpectation"\s*:\s*"([^"]+)"/`；③ 原始输出 `raw.trim()`。
 */
export function extractExpectation(raw) {
    const parsed = parseJsonObject(raw);
    if (parsed !== undefined) {
        const branchExpectation = parsed['branchExpectation'];
        if (typeof branchExpectation === 'string') {
            return branchExpectation;
        }
    }
    const match = raw.match(/"branchExpectation"\s*:\s*"([^"]+)"/);
    const extracted = match?.[1];
    if (extracted !== undefined) {
        return extracted;
    }
    return raw.trim();
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
/** 含 regex 元字符时判定 expectation 为正则，否则视为字面字符串。 */
function hasRegexMetacharacters(value) {
    return /[\\^$.*+?()[\]{}|]/.test(value);
}
/**
 * 判定分支评估结果是否匹配 expectation：expectation 含 regex 特征时做正则匹配
 * （正则非法视为不匹配），否则字符串相等比较。
 */
export function matchesExpectation(result, expectation) {
    if (hasRegexMetacharacters(expectation)) {
        let regex;
        try {
            regex = new RegExp(expectation);
        }
        catch {
            return false;
        }
        return regex.test(result);
    }
    return result === expectation;
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
    async startAi(condition, contextMessage, options) {
        const route = await this.resolveProviderModel(condition.value);
        const taskText = replacePassThroughVars(condition.value.promptText, resolvePassThroughVars(options.passThroughVars, options.loopTurn, options.loopMaxIterations));
        const promptText = buildBranchPrompt(taskText, contextMessage, options.branches ?? []);
        const message = createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: promptText }],
        });
        const sessionHandle = this.newSessionHandle();
        const generateOptions = {
            provider: route.provider,
            model: route.model,
            messages: [message],
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        };
        const assembler = new BlockAssembler();
        const stream = this.ctx.llm.stream(generateOptions);
        return {
            sessionHandle,
            outputPromise: this.aggregate(stream, assembler),
        };
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
        if (options.stdin === undefined && env === undefined) {
            return await this.runShellSimple(command, options);
        }
        return await this.runShellSubprocess(command, options, env);
    }
    async runShellSimple(command, options) {
        const request = {
            command,
            timeoutMs: this.config.defaultTimeoutMs,
            ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        };
        const spec = this.ctx.shell.resolve(request);
        const result = await this.ctx.shell.run(spec);
        return this.toStdout(result);
    }
    async runShellSubprocess(command, options, env) {
        const tokens = splitCommand(command);
        const program = tokens[0] ?? command;
        const args = tokens.slice(1);
        const executable = await this.ctx.subprocess.resolveExecutable(program, env, options.signal);
        const spec = {
            argv: [executable, ...args],
            cwd: options.workdir ?? '',
            stdio: {
                stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
                stdout: { maxBytes: 1024 * 1024 },
                stderr: { maxBytes: 1024 * 1024 },
            },
            graceMs: this.config.defaultTimeoutMs,
            ...(env === undefined ? {} : { env }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        };
        const handle = this.ctx.subprocess.spawn(spec);
        const outcome = await handle.done;
        const stdout = handle.collected.stdout?.readFrom(0);
        const stderr = handle.collected.stderr?.readFrom(0);
        const result = {
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            timedOut: outcome.timedOut ?? false,
            aborted: options.signal?.aborted ?? false,
            timeoutMs: this.config.defaultTimeoutMs,
            stdout: { text: stdout?.text ?? '', truncated: stdout?.lossy ?? false },
            stderr: { text: stderr?.text ?? '', truncated: stderr?.lossy ?? false },
        };
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