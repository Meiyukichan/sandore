import { textSummary } from "./internal.js";
// ── 透传变量替换 ────────────────────────────────────────────────────────────
/** 替换 `${xxx}` 透传变量：已定义替换为值，未定义保留原文。 */
export function replacePassThroughVars(str, vars) {
    return str.replace(/\$\{([^}]+)\}/g, (whole, name) => {
        const value = vars[name];
        return value === undefined ? whole : value;
    });
}
// ── glob / regex 转换与自动区分 ─────────────────────────────────────────────
/** 转义单个正则元字符（非元字符原样返回）。 */
export function escapeRegexChar(char) {
    return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}
/** 将 glob 模式转换为锚定正则：`*`→`[^/]*`、`**`→`.*`（跳过后续 `/`）、`?`→`[^/]`。 */
export function globToRegex(glob) {
    let pattern = '^';
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i];
        if (char === '*') {
            if (glob[i + 1] === '*') {
                pattern += '.*';
                i++;
                if (glob[i + 1] === '/')
                    i++;
            }
            else {
                pattern += '[^/]*';
            }
        }
        else if (char === '?') {
            pattern += '[^/]';
        }
        else {
            pattern += escapeRegexChar(char);
        }
    }
    pattern += '$';
    return new RegExp(pattern);
}
/** 含 `*`/`?` 且无 regex 特征（反斜杠转义或 `(?`）时判定为 glob，否则视为 regex/字面路径。 */
export function isGlobPattern(pattern) {
    if (!pattern.includes('*') && !pattern.includes('?'))
        return false;
    return !/\\.|\(\?/.test(pattern);
}
/** 递归收集目录下全部文件（跳过 `.` 与 `node_modules`）。 */
async function collectFiles(fs, dir, prefix, out) {
    const entries = await fs.listDir(dir);
    for (const entry of entries) {
        if (entry.name === '.' || entry.name === 'node_modules')
            continue;
        const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.type === 'directory') {
            await collectFiles(fs, entry.target, relativePath, out);
        }
        else if (entry.type === 'file') {
            out.push({ target: entry.target, relativePath });
        }
    }
}
/** 递归遍历目录，返回全部文件的进程绝对路径数组。 */
export async function walkDir(fs, dir) {
    const out = [];
    await collectFiles(fs, dir, '', out);
    return out.map(file => fs.processPath(file.target));
}
/** 按 glob 模式搜索 `rootDir` 下匹配的文件，返回进程绝对路径数组。 */
export async function findFilesByGlob(fs, rootDir, pattern) {
    const regex = globToRegex(pattern);
    const root = await fs.resolve(rootDir);
    const out = [];
    await collectFiles(fs, root, '', out);
    return out.filter(file => regex.test(file.relativePath)).map(file => fs.processPath(file.target));
}
/** 按正则搜索 `rootDir` 下相对路径匹配的文件，返回进程绝对路径数组。 */
export async function findFilesByRegex(fs, rootDir, regex) {
    let re;
    try {
        re = new RegExp(regex);
    }
    catch (error) {
        throw new Error(`invalid regex '${regex}': ${error instanceof Error ? error.message : String(error)}`);
    }
    const root = await fs.resolve(rootDir);
    const out = [];
    await collectFiles(fs, root, '', out);
    return out.filter(file => re.test(file.relativePath)).map(file => fs.processPath(file.target));
}
/** 由 stepMessageId 推导产物文件名。 */
export function outputJsonFileName(stepMessageId) {
    return `${stepMessageId}_output.json`;
}
/** 写入 `{stepMessageId}_output.json`，返回文件进程绝对路径。 */
export async function writeOutputJson(fs, dir, stepMessageId, data) {
    const target = await fs.resolve(`${dir}/${outputJsonFileName(stepMessageId)}`);
    await fs.writeText(target, JSON.stringify(data, null, 2));
    return fs.processPath(target);
}
/** 校验并解析产物文件 JSON（`JSON.parse` 返回 unknown，逐字段校验形状）。 */
function parseOutputJson(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
        throw new Error(`malformed output json: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof raw !== 'object' || raw === null) {
        throw new Error('malformed output json: root is not an object');
    }
    const sessionId = raw.sessionId;
    const output = raw.output;
    if (typeof sessionId !== 'string') {
        throw new Error('malformed output json: sessionId is not a string');
    }
    if (typeof output !== 'object' || output === null) {
        throw new Error('malformed output json: output is not an object');
    }
    const returnPrompt = output.returnPrompt;
    const artifacts = output.artifacts;
    if (typeof returnPrompt !== 'string') {
        throw new Error('malformed output json: output.returnPrompt is not a string');
    }
    if (!Array.isArray(artifacts)) {
        throw new Error('malformed output json: output.artifacts is not an array');
    }
    const parsedArtifacts = artifacts.map((item, index) => {
        if (typeof item !== 'object' || item === null) {
            throw new Error(`malformed output json: artifacts[${index}] is not an object`);
        }
        const id = item.id;
        const value = item.value;
        if (typeof id !== 'string') {
            throw new Error(`malformed output json: artifacts[${index}].id is not a string`);
        }
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
            throw new Error(`malformed output json: artifacts[${index}].value is not a string array`);
        }
        return { id, value };
    });
    return { sessionId, output: { returnPrompt, artifacts: parsedArtifacts } };
}
/** 读回并校验 `{stepMessageId}_output.json`。 */
export async function readOutputJson(fs, dir, stepMessageId) {
    const target = await fs.resolve(`${dir}/${outputJsonFileName(stepMessageId)}`);
    const text = await fs.readText(target);
    return parseOutputJson(text);
}
// ── InputFrom 就近匹配 ──────────────────────────────────────────────────────
/** 后缀匹配：`actualId === targetId` 或 `actualId` 以 `targetId-` 开头（循环带后缀 id）。 */
export function idMatches(actualId, targetId) {
    return actualId === targetId || actualId.startsWith(`${targetId}-`);
}
/** 判断某条已执行 Step 是否匹配 `stageId.stepId`（对 `stepId ?? id` 做后缀匹配）。 */
function matchesStep(step, stageId, stepId) {
    if (step.stageId !== stageId)
        return false;
    return idMatches(step.stepId ?? step.id, stepId);
}
/**
 * 按 `path` 就近匹配已执行 Step。
 *
 * 支持三种路径：`stg-xxx`（Stage 级，倒序最近优先）、`stg-xxx.step-xxx`
 * （Step 级，自当前条目前一条起往前最近匹配，`idMatches` 支持循环后缀 id）、
 * `stg-xxx.step-xxx.opt-xxx`（OutputTo 级，先定位 Step 再过滤特定 outputTo）。
 * @param executedSteps - 扁平已执行 Step（含循环迭代条目）。
 * @param currentIndex - 当前 Step 在 `executedSteps` 中的索引。
 * @param path - `stageId[.stepId[.outputToId]]` 引用路径。
 */
export function resolvePathSegments(executedSteps, currentIndex, path) {
    const segments = path.split('.');
    if (segments.length === 1) {
        const stageId = segments[0];
        const matched = executedSteps.filter(step => step.stageId === stageId);
        return matched.reverse();
    }
    if (segments.length === 2) {
        const stageId = segments[0];
        const stepId = segments[1];
        for (let i = currentIndex - 1; i >= 0; i--) {
            const step = executedSteps[i];
            if (matchesStep(step, stageId, stepId))
                return [step];
        }
        return [];
    }
    if (segments.length === 3) {
        const stageId = segments[0];
        const stepId = segments[1];
        const outputToId = segments[2];
        for (let i = currentIndex - 1; i >= 0; i--) {
            const step = executedSteps[i];
            if (!matchesStep(step, stageId, stepId))
                continue;
            if ((step.outputTo ?? []).some(outputTo => outputTo.id === outputToId))
                return [step];
        }
        return [];
    }
    return [];
}
/**
 * 解析 `inputFromItems` 为就近命中的已执行 Step。
 *
 * 每项 `path` 走 {@link resolvePathSegments}，`regex` 遍历全部 Step 输出文本做正则
 * 匹配（倒序最近优先）；`inputFromItems` 为空时回退前一条执行条目
 * （`currentIndex - 1`）。
 */
export function resolveFromInputFrom(executedSteps, currentIndex, inputFromItems) {
    if (inputFromItems.length === 0) {
        const previous = executedSteps[currentIndex - 1];
        return previous === undefined ? [] : [previous];
    }
    const result = [];
    for (const item of inputFromItems) {
        if (item.path !== undefined) {
            result.push(...resolvePathSegments(executedSteps, currentIndex, item.path));
        }
        else if (item.regex !== undefined) {
            let regex;
            try {
                regex = new RegExp(item.regex);
            }
            catch (error) {
                throw new Error(`invalid inputFrom regex '${item.regex}': ${error instanceof Error ? error.message : String(error)}`);
            }
            const matched = executedSteps.filter(step => regex.test(textSummary(step.output)));
            result.push(...matched.reverse());
        }
    }
    return result;
}
//# sourceMappingURL=file-utils.js.map