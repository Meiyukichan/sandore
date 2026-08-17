import { SandoreError } from "./errors.js";
/** 渲染任意抛出值为可读消息（诊断用，永不按消息路由）。 */
export function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 判定错误是否为「取消类错误」（`interrupt` 打断 `whenIdle`/执行 Promise 时以取消
 * 结束）。`SandoreError` 按稳定 `code === 'CANCELLED'` 路由；非 SandoreError 回退
 * 识别 `AbortError` 名称或含 `cancel` 的消息（兼容 DSH 原生取消错误的形状）。
 */
export function isCancellationError(error) {
    if (error instanceof SandoreError) {
        return error.code === 'CANCELLED';
    }
    if (error instanceof Error) {
        return error.name === 'AbortError' || /cancel/i.test(error.message);
    }
    return false;
}
/** 提取 ContentBlock[] 的纯文本摘要（仅 text 块，按序拼接）。 */
export function textSummary(output) {
    if (output === undefined) {
        return '';
    }
    const texts = [];
    for (const block of output) {
        if (block.type === 'text') {
            texts.push(block.text);
        }
    }
    return texts.join('\n');
}
/**
 * 将命令串拆分为 argv（subprocess 不 shell 解释）。
 *
 * 仅做最简空白分词并支持单引号/双引号包裹含空格的单个 token（引号本身不保留，
 * 不做嵌套/转义/变量展开）。因此本函数仅适用于「无空格程序名 + 无特殊字符参数」
 * 的命令；含重定向、管道、变量展开等复杂命令应经 schema 层显式提供 `argv`。
 */
export function splitCommand(command) {
    const tokens = [];
    let current = '';
    let quote = null;
    for (const ch of command) {
        if (quote !== null) {
            if (ch === quote) {
                quote = null;
            }
            else {
                current += ch;
            }
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
        }
        else if (/\s/.test(ch)) {
            if (current !== '') {
                tokens.push(current);
                current = '';
            }
        }
        else {
            current += ch;
        }
    }
    if (current !== '') {
        tokens.push(current);
    }
    return tokens;
}
/** 解析透传变量 + 循环上下文特殊变量（`in-loop-turn`/`all-loop-turn`）。 */
export function resolvePassThroughVars(passThroughVars, loopTurn, loopMaxIterations) {
    const vars = { ...(passThroughVars ?? {}) };
    vars['in-loop-turn'] = String(loopTurn ?? 0);
    vars['all-loop-turn'] = String(loopMaxIterations ?? 0);
    return vars;
}
/** 组装 shell 注入用环境变量（非空透传变量 + 循环上下文；无需求返回 undefined）。 */
export function buildShellEnv(passThroughVars, loopTurn, loopMaxIterations) {
    const env = {};
    for (const [key, value] of Object.entries(passThroughVars ?? {})) {
        if (value !== '') {
            env[key] = value;
        }
    }
    const turn = loopTurn ?? 0;
    if (turn > 0) {
        env['in-loop-turn'] = String(turn);
        env['all-loop-turn'] = String(loopMaxIterations ?? 0);
    }
    return Object.keys(env).length === 0 ? undefined : env;
}
/**
 * provider/model 三层回退：L1 定义 `providerId`+`modelId` 成对提供 → L2 引擎默认
 * `defaultProvider`+`defaultModel` 成对配置 → L3 `llm` 目录兜底（`listProviders`
 * 同步、`listModels` 异步）。L3 命中时可选回调 `onDirectoryFallback`（记录告警）。
 */
export async function resolveProviderModel(value, defaults, llm, onDirectoryFallback) {
    if (value.providerId !== undefined && value.modelId !== undefined) {
        return { provider: value.providerId, model: value.modelId };
    }
    if (defaults.defaultProvider !== undefined && defaults.defaultModel !== undefined) {
        return { provider: defaults.defaultProvider, model: defaults.defaultModel };
    }
    const provider = llm.listProviders()[0];
    if (provider === undefined) {
        throw new SandoreError('no LLM provider available', 'STEP_EXECUTION');
    }
    const models = await llm.listModels(provider.id);
    const model = models[0];
    if (model === undefined) {
        throw new SandoreError(`no LLM model available for provider '${provider.id}'`, 'STEP_EXECUTION');
    }
    onDirectoryFallback?.(provider.id, model.id);
    return { provider: provider.id, model: model.id };
}
//# sourceMappingURL=internal.js.map