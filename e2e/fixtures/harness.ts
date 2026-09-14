/**
 * e2e harness：独立 DSH 实例（3090）+ 已就绪页面 + sandore 造数/查询辅助。
 *
 * ## 隔离边界（务必遵守）
 * 每次 run 都在 `%TEMP%/sandore-e2e-<uuid>/` 下建一个**全新 DSH_HOME**，其中
 * `profiles/e2e/package.json` 声明 bundle 列表 `dsh-base` + `dsh-web-app` +
 * `@meiyukichan/dsh-sandore`，并用 junction 把 sandore 仓库链进
 * `profiles/e2e/node_modules/@meiyukichan/dsh-sandore`（DSH 启动时自动补全
 * `profiles/node_modules` 的 junction，无需手拷）。
 *
 * 因此：**绝不读写生产 `~/.dsh`（3080 在线实例）**——sessions / settings /
 * credentials / storages 全部落在临时 home；进程退出即弃（`SANDBORE_E2E_KEEP_HOME=1`
 * 可保留临时 home 排错）。
 *
 * ## 为什么不用 playwright 的 webServer / 静态 baseURL
 * 访问 URL 必须携带每次 boot 都变化的 `?token=`（无 token → 401），而配置文件在
 * globalSetup 之前求值。所以由 worker-scoped fixture spawn 服务并解析 stdout 的
 * `dsh web: http://127.0.0.1:<port>/?token=<token>` 行，用例里显式 `page.goto(dsh.url)`。
 *
 * ## 关键环境变量（不加 `SSH_TTY=1` 会死锁）
 * Windows + 127.0.0.1 时 DSH 的目录选择器落到 **native** 后端（弹 OS 对话框，
 * headless 点不到 → cwd 永远为空、`创建` 永远 disabled）。`SSH_TTY=1` 逼到 **browse**
 * 后端 → 原生 picker 抛错 → sandore 自己的「选择工作目录」`DirectoryBrowserDialog`
 * 弹出，可脚本化。
 *
 * 本文件的 e2e 开关一律用 **`SANDBORE_E2E_*`** 前缀：**拼写沿用仓库既有约定**
 * （`packages/workflow/workflow-engine-real-e2e.spec.ts`、`stepchat-open-real-probe.spec.ts`、
 * `docs/e2e-real-harness.md`、`e2e/fixtures/workflows.ts` 的 `SANDBORE_E2E_REAL`），
 * 多出来的 `B` 是历史沿用——**不要**再写 `SANDORE_E2E_*`，否则同一个 R 层闸门会有两套写法。
 * 开关清单：`SANDBORE_E2E_REAL`（R 层：真模型）、`SANDBORE_E2E_PORT`、
 * `SANDBORE_E2E_HOME`、`SANDBORE_E2E_KEEP_HOME`、`SANDBORE_E2E_BOOT_TIMEOUT_MS`、
 * `SANDBORE_E2E_DSH_BIN`、`SANDBORE_E2E_ALLOW_STALE_BUILD`、`SANDBORE_E2E_MOCK`。
 *
 * @module e2e/fixtures/harness
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { test as base, expect, type Browser, type ConsoleMessage, type Page } from '@playwright/test'

import { installSseCollector } from './sse.ts'

export type { Browser, Page }

/** 仓库根（`e2e/fixtures/` 上溯两级）。 */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

/** 被测 3090 实例端口（`SANDBORE_E2E_PORT` 可覆盖以避开占用）。 */
export const DSH_PORT = Number(process.env.SANDBORE_E2E_PORT ?? '3090')

/** 临时 DSH_HOME 根（`SANDBORE_E2E_HOME` 可覆盖；默认系统临时目录）。 */
export const DSH_HOME_ROOT = process.env.SANDBORE_E2E_HOME
  ?? join(process.env.TEMP ?? process.env.TMP ?? REPO_ROOT, 'sandore-e2e')

/** 是否保留临时 home（失败排错）；`SANDBORE_E2E_KEEP_HOME=1` 开启。 */
const KEEP_HOME = process.env.SANDBORE_E2E_KEEP_HOME === '1'

/** 启动/就绪等待上限（冷启首次要建数百个 junction，给足 120s）。 */
const BOOT_TIMEOUT_MS = Number(process.env.SANDBORE_E2E_BOOT_TIMEOUT_MS ?? '120000')

/**
 * mock LLM（M 层）开关。
 *
 * 默认**开启**：同一 worker 只有一个 3090 实例（`workers: 1`），而 M 层需要真实
 * 子代理 step（`[data-step-chat]` 只在真实子代理 step 且 running/paused/failed 挂载），
 * 所以实例必须带 mock provider。F 层是纯 shell 步、不建子代理、不调模型，多一条
 * provider 路由对其无影响（用例内的 `[data-step-chat] === 0` 断言依然成立）。
 * `SANDBORE_E2E_MOCK=0` 可关（排查「mock 行是否影响启动」）。
 * 真模型模式（`SANDBORE_E2E_REAL=1`）下**强制关闭**：真实 provider 才是被测对象。
 */
const MOCK_ENABLED = process.env.SANDBORE_E2E_REAL !== '1' && process.env.SANDBORE_E2E_MOCK !== '0'

/**
 * 真模型（R 层）开关：`SANDBORE_E2E_REAL=1`。
 *
 * 开启后与 mock 模式的四处差异：
 * 1. **不装** mock provider（mock 插件行与 junction 都不做）；
 * 2. 把生产 home 的 `.credentials.yaml` **复制**进临时 home（只读源，**绝不写回**生产），
 *    使真 provider 可用（临时 home 本身没有凭据）；
 * 3. 临时 home 的 `settings.yaml` 写入与生产一致的 `agent-default-model`
 *    （`deepseek-official`/`deepseek-flash`）；
 * 4. 临时 profile 取名 `dev`（与生产 dev profile 同构：`dependencies.link` 指向本仓库）。
 *
 * **隔离纪律**：`DSH_HOME` 恒为临时目录，绝不指向生产 `~/.dsh` —— 生产 3080 在线，
 * 共享 storages/sessions 会让两个进程同写 sqlite。
 */
export const REAL_ENABLED = process.env.SANDBORE_E2E_REAL === '1'

/** 临时 profile 名（真模型模式用 `dev`，与生产 dev profile 同构）。 */
export const PROFILE_NAME = REAL_ENABLED ? 'dev' : 'e2e'

/** 真模型 provider（默认取生产 `settings.yaml` 的 agent-default-model.provider）。 */
export const REAL_PROVIDER = process.env.SANDBORE_E2E_PROVIDER ?? 'deepseek-official'

/** 真模型 model id（同上，默认生产的 `deepseek-flash`）。 */
export const REAL_MODEL = process.env.SANDBORE_E2E_MODEL ?? 'deepseek-flash'

/** 生产凭据源（只读；`SANDBORE_E2E_CREDENTIALS` 可覆盖）。 */
const PROD_CREDENTIALS = process.env.SANDBORE_E2E_CREDENTIALS
  ?? join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml')

/** mock LLM 插件包目录（纯 JS Cordis 插件，junction 进临时 profile 的 node_modules）。 */
export const MOCK_LLM_DIR = join(REPO_ROOT, 'e2e', 'mock-llm')

/** mock 插件包名（插件行的 `name`）。 */
export const MOCK_LLM_PACKAGE = '@sandore-e2e/mock-llm'

/** mock provider 路由 id。 */
export const MOCK_PROVIDER = 'e2e-mock'

/** mock model id（与 `MOCK_PROVIDER` 成对，用于 YAML 的 L1 路由 `providerId`/`modelId`）。 */
export const MOCK_MODEL = 'mock-1'

/** DSH 内测声明版本（`ui-onboarding.welcomeNoticeVersion`）；预置 settings.yaml 后不再弹。 */
const WELCOME_NOTICE_VERSION = '2026-08-13.1'

/**
 * 构建产物新鲜度检查（**只提示，绝不自动跑 `pnpm build`**）。
 *
 * profile 加载的是 **built `lib/`**（`exports["."] → lib/index.js`、`exports["./client"] → lib/client.js`），
 * 所以源码改动后必须先 `pnpm build`，否则 e2e 测到的是旧产物。本函数比对
 * `lib/index.js` + `lib/client.js` 的 mtime 与**参与编译的源码**最新 mtime：
 * 只统计 `packages/**` 下的 `.ts/.tsx`，**排除 `*.spec.ts`**（spec 不进 tsconfig 编译图，
 * 改 spec 不应要求重新构建）。
 *
 * 落后时直接 fail 并给出命令——**不自动构建**，避免与并行改 client 的 agent 抢 tsc 产物；
 * 确有需要跑旧产物时用 `SANDBORE_E2E_ALLOW_STALE_BUILD=1` 覆盖（只告警不失败）。
 */
export function ensureBuilt(): void {
  const bundlePaths = [join(REPO_ROOT, 'lib', 'index.js'), join(REPO_ROOT, 'lib', 'client.js')]
  const missing = bundlePaths.filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(
      `e2e: 缺少构建产物 ${missing.map(p => p.replace(`${REPO_ROOT}\\`, '')).join(', ')}；请先在仓库根执行 \`pnpm build\` 后重跑。`,
    )
  }
  const builtAt = Math.min(...bundlePaths.map(path => statSync(path).mtimeMs))
  const newestSource = newestSourceMtime(join(REPO_ROOT, 'packages'))
  if (newestSource <= builtAt) return
  const message = 'e2e: lib/ 构建产物落后于 packages/** 源码（被测实例加载的是 built lib）。\n'
    + `  产物最新 mtime: ${new Date(builtAt).toISOString()}\n`
    + `  源码最新 mtime: ${new Date(newestSource).toISOString()}\n`
    + '  请在仓库根执行 `pnpm build` 后重跑（e2e 不自动构建，避免与并行改动抢产物）。'
  if (process.env.SANDBORE_E2E_ALLOW_STALE_BUILD === '1') {
    console.warn(`[e2e] ${message}\n  （已由 SANDBORE_E2E_ALLOW_STALE_BUILD=1 降级为告警，测试的是旧产物）`)
    return
  }
  throw new Error(message)
}

/** 递归取 `root` 下最新**参与编译**的源文件 mtime（`.ts/.tsx`，排除 `*.spec.ts`；无源码时返回 0）。 */
function newestSourceMtime(root: string): number {
  let newest = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      // 测试/声明文件不进编译图（tsconfig 的 include/exclude 已排除 spec 与 typert 产物）。
      if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue
      const mtime = statSync(path).mtimeMs
      if (mtime > newest) newest = mtime
    }
  }
  if (!existsSync(root)) return 0
  walk(root)
  return newest
}

/**
 * 解析 dsh CLI 入口。
 *
 * 优先「node + bin.js」直接执行（无 shell，参数无引号问题）；找不到时回退到
 * `dsh.cmd` shim（需 `shell: true`，见 `startDsh`）。候选路径从 `process.execPath`
 * 逐级上溯探测 `node_modules/@deepseek-ai/dsh/lib/bin.js`（覆盖
 * `<root>/<nodever>/node_modules`、`<root>/node_modules`、pnpm 全局与 npm 全局布局）。
 *
 * `SANDBORE_E2E_DSH_BIN` 可显式指定（CI/非常规安装）。
 */
function resolveDshBin(): { command: string; args: string[]; shell: boolean } {
  const configured = process.env.SANDBORE_E2E_DSH_BIN
  if (configured !== undefined && configured.trim() !== '') {
    return { command: process.execPath, args: [configured], shell: false }
  }
  const relative = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']
  const roots: string[] = []
  let dir = dirname(process.execPath)
  for (let depth = 0; depth < 5; depth += 1) {
    roots.push(dir, join(dir, 'node_global'), join(dir, 'lib'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (process.env.APPDATA !== undefined) roots.push(join(process.env.APPDATA, 'npm'))
  for (const root of roots) {
    const candidate = join(root, ...relative)
    if (existsSync(candidate)) return { command: process.execPath, args: [candidate], shell: false }
  }
  // 回退：PATH 上的 dsh shim（Windows 是 dsh.cmd → 需要 shell 解析）。
  return { command: process.platform === 'win32' ? 'dsh.cmd' : 'dsh', args: [], shell: process.platform === 'win32' }
}

/** 用 cmd 的 `mklink /J` 建目录 junction（Node 的 symlink 在 Windows 需管理员/开发者模式）。 */
function makeJunction(linkPath: string, targetPath: string): void {
  const result = spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, targetPath], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `e2e: 建 junction 失败（${linkPath} → ${targetPath}）：${result.stdout ?? ''}${result.stderr ?? ''}`,
    )
  }
}

/**
 * profile 自带的 patch 层内容（`$DSH_HOME/profiles/e2e/cordis.patch.yml`）。
 *
 * 组合顺序（DSH `packages/boot/app-boot/src/profile.ts` 文件头）：空表 →
 * `dsh.profile.bundles` 各 bundle 的 patch（base、web-app、sandore）→ **profile 自身
 * 的 cordis.patch.yml** → `--patch` 覆盖层。所以本文件既能 insert 新行，也能按
 * `- id:` 覆盖已存在行的 config。
 *
 * 两处挂接：
 * 1. `insert` mock LLM 插件行 `e2e-mock-llm`：注册 provider `e2e-mock` / model `mock-1`，
 *    让 prompt Step 的真实子代理有模型可用（`ctx.llm.registerAdapter`）。
 * 2. `- id: agent-default-model` 覆盖宿主默认模型：RunView 底部 DiscussionInput 起的
 *    是**宿主会话**（不是 Step 子代理），它走 `agentDefaultModel.currentSelection()`，
 *    不覆盖就会去要真 provider 的凭据（临时 home 里没有）。
 *
 * 注意 Step 子代理**不读**这里：它走引擎的三层模型路由（L1 YAML `providerId`/`modelId`
 * → L2 实例/引擎默认 → L3 `llm` 目录），M 层 fixture 用 L1 显式指定。
 */
function profilePatchYaml(): string {
  return [
    '- insert:',
    '    - id: e2e-mock-llm',
    `      name: '${MOCK_LLM_PACKAGE}'`,
    '      config:',
    `        provider: ${MOCK_PROVIDER}`,
    `        model: ${MOCK_MODEL}`,
    '- id: agent-default-model',
    '  config:',
    `    provider: ${MOCK_PROVIDER}`,
    `    model: ${MOCK_MODEL}`,
    '',
  ].join('\n')
}

/**
 * 准备临时 DSH_HOME + `profiles/e2e`（package.json + sandore/mock junction
 * + profile patch 层 + 预置 settings.yaml）。
 *
 * settings.yaml 预置 `ui-onboarding.welcomeNoticeVersion` = 当前 DSH 版本常量 →
 * 首次访问不再弹「内测声明」；API Key 弹窗在未配置 provider 的临时 home 里也不会出现
 * （fixture 内仍保留一次性兜底处理）。
 *
 * @returns 临时 home 绝对路径。
 */
export function prepareHome(): string {
  const home = join(DSH_HOME_ROOT, `e2e-${randomUUID()}`)
  const profileDir = join(home, 'profiles', PROFILE_NAME)
  const scopeDir = join(profileDir, 'node_modules', '@meiyukichan')
  mkdirSync(scopeDir, { recursive: true })
  const mockScopeDir = join(profileDir, 'node_modules', '@sandore-e2e')
  mkdirSync(mockScopeDir, { recursive: true })

  // package.json 必须 UTF-8 无 BOM：DSH 用 JSON.parse 读取（BOM 会解析失败）。
  // `dependencies.link:` 让 profiles 级 node_modules 也能解析到这两个包，
  // 与下面的 junction 双保险（healProfilesModuleFallback 会自行补齐其余链接）。
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({
      name: `dsh-profile-${PROFILE_NAME}`,
      private: true,
      dependencies: {
        '@meiyukichan/dsh-sandore': `link:${REPO_ROOT.replace(/\\/g, '/')}`,
        ...MOCK_ENABLED ? { [MOCK_LLM_PACKAGE]: `link:${MOCK_LLM_DIR.replace(/\\/g, '/')}` } : {},
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@meiyukichan/dsh-sandore'],
        },
      },
    }, null, 2)}\n`,
    { encoding: 'utf8' },
  )

  const linkPath = join(scopeDir, 'dsh-sandore')
  if (!existsSync(linkPath)) makeJunction(linkPath, REPO_ROOT)

  // mock LLM 插件行（M 层）：junction 到 e2e/mock-llm（纯 JS 插件，无构建产物）。
  if (MOCK_ENABLED) {
    const mockLink = join(mockScopeDir, 'mock-llm')
    if (!existsSync(mockLink)) makeJunction(mockLink, MOCK_LLM_DIR)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), profilePatchYaml(), { encoding: 'utf8' })
  }

  // 预置已消化的 onboarding 状态（避免首次访问的两个阻塞弹窗）；真模型模式再写入
  // 与生产一致的 agent-default-model（否则 prompt 步没有可用的默认 provider）。
  writeFileSync(
    join(home, 'settings.yaml'),
    `ui-onboarding:\n  welcomeNoticeVersion: ${WELCOME_NOTICE_VERSION}\n${
      REAL_ENABLED
        ? `agent-default-model:\n  provider: ${REAL_PROVIDER}\n  model: ${REAL_MODEL}\n  reasoningEffort: high\n`
        : ''
    }`,
    { encoding: 'utf8' },
  )

  // 真模型（R 层）：把生产凭据**复制**进临时 home（只读源；生产 home 一律不写）。
  if (REAL_ENABLED) {
    if (!existsSync(PROD_CREDENTIALS)) {
      throw new Error(
        `SANDBORE_E2E_REAL=1 需要真 provider 凭据，但未找到 ${PROD_CREDENTIALS}（用 SANDBORE_E2E_CREDENTIALS 指定源路径）`,
      )
    }
    copyFileSync(PROD_CREDENTIALS, join(home, '.credentials.yaml'))
  }
  return home
}

/** 干净白名单环境：显式覆盖 DSH_HOME，且不继承宿主（生产 3080 / 当前会话）的任何 DSH_* 变量。 */
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC',
    'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE', 'LANG', 'TZ', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  ]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.DSH_HOME = home
  // 逼出 browse 目录选择器（Windows 默认落 native，headless 点不到：见文件头注释）。
  env.SSH_TTY = '1'
  // 无围栏沙箱 + 免审批：shell 步在仓库外的临时 cwd 也能直接跑，不需要人点批准。
  env.DSH_PERMISSION_MODE = 'danger-full-access'
  env.DSH_TELEMETRY_DISABLED = '1'
  // 宿主唤醒诊断（M8 取证）：把宿主会话每次 `agent/pre-step` 的归属判定打到 stderr，
  // 由 `logSince/countSince` 采集后落 `e2e/.artifacts/host-wakeups.txt`。生产路径没有这个
  // 变量 → `hostWakeupDiag` 为 no-op（连字符串都不拼）。
  if (process.env.SANDORE_WAKEUP_DIAG !== undefined) {
    env.SANDORE_WAKEUP_DIAG = process.env.SANDORE_WAKEUP_DIAG
  }
  if (KEEP_HOME) env.DSH_LOG_LEVEL = process.env.DSH_LOG_LEVEL ?? 'info'
  return env
}

/** 运行中的 DSH 实例句柄（由 `dsh` worker fixture 提供）。 */
export interface DshServer {
  /** 带 token 的访问 URL（`http://127.0.0.1:<port>/?token=<token>`）。 */
  readonly url: string
  /** 临时 DSH_HOME（数据隔离边界）。 */
  readonly home: string
  /** 实例端口。 */
  readonly port: number
  /** 实例 boot 到就绪的耗时（ms），用于报告。 */
  readonly bootMs: number
  /** dsh 进程 stdout+stderr 尾部（失败诊断用）。 */
  logTail(): string
  /**
   * 当前**全量**日志的绝对偏移（用作「自本用例开始」的计数基线）。
   *
   * 为什么需要：`dsh` fixture 是 worker-scoped（`workers: 1` → 全轮共享一个实例），
   * 日志会跨用例累积；断言「本用例触发了几次 mock 调用」必须用 `logMark()` +
   * {@link DshServer.countSince} 取差值，否则前面的用例会把计数抬高。
   */
  logMark(): number
  /** 自 `mark`（{@link DshServer.logMark}）之后的**日志原文**（供「本用例窗口内出现了什么」精确断言）。 */
  logSince(mark: number): string
  /** 自 `mark`（{@link DshServer.logMark}）之后匹配 `pattern`（需 `/g`）的次数。 */
  countSince(mark: number, pattern: RegExp): number
  /** sandore 定义导入 RPC。 */
  importDefinitionFromYaml(yaml: string): Promise<ImportResult>
  /** sandore 实例列表 RPC（对账用）。 */
  listInstances(): Promise<InstanceSummary[]>
  /** sandore 实例状态 RPC。 */
  getInstanceState(instanceId: string): Promise<InstanceState>
}

/** `importDefinitionFromYaml` 结果（对齐 host 侧 created/updated/skipped 三态）。 */
export interface ImportResult {
  readonly status: 'created' | 'updated' | 'skipped'
  readonly id: string
  readonly name: string
  readonly matchedCount: number
}

/** `listInstances` 行摘要。 */
export interface InstanceSummary {
  readonly instanceId: string
  readonly workflowId: string
  readonly originalInput: string
  readonly status: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** `getInstanceState` 的最小断言面（其余字段原样保留在 `raw`）。 */
export interface InstanceState {
  readonly instanceId: string
  readonly status: string
  readonly executedSteps: readonly {
    readonly id: string
    readonly stepId: string
    readonly stageId: string
    readonly name: string
    readonly status: string
    readonly commandType: string
    readonly outputText?: string
    /** Step 失败原因（引擎把失败详情写在这里；诊断用）。 */
    readonly error?: string
    /**
     * Step 会话元数据（schema 见 `packages/workflow/schema.ts` 的 `StepSessionMetaSchema`）。
     * `synthetic:false` + `childId` = 真实子代理会话；shell 步为合成占位（无 childId）。
     * M16（子代理身份盘面对账）据此把段与盘面会话逐一对上。
     */
    readonly sessionMeta?: {
      readonly childId?: string
      readonly synthetic: boolean
      readonly command?: string
      readonly hostSessionId?: string
    }
    /**
     * 该执行段的子代理会话消息行（`WorkflowTaskState.executedSteps[].sessionMessages`
     * 子集；由 `getInstanceState` RPC **真实返回**，schema 见
     * `packages/workflow/schema.ts` 的 `SessionMessageSchema`：type/text/tool/args/output）。
     * M9（step 子代理必须全新）据此断言「step 会话里没有主代理文本」。
     */
    readonly sessionMessages?: readonly {
      readonly type: 'text' | 'tool' | 'reasoning'
      readonly text?: string
      readonly tool?: string
      readonly args?: unknown
      readonly output?: unknown
    }[]
  }[]
  readonly raw: Record<string, unknown>
}

/** 采集到的 sandore SSE 帧（见 f3 用例的 `SseFrame` 注释：`data.args[0]` = DagRunInfo）。 */
export interface SseEvent {
  readonly type: string
  readonly data: unknown
}

/** 启动一个隔离 DSH 实例并等待就绪。 */
export async function startDsh(options: { port?: number } = {}): Promise<{ server: DshServer; stop: () => Promise<void> }> {
  ensureBuilt()
  const port = options.port ?? DSH_PORT
  const home = prepareHome()
  const { command, args: binArgs, shell } = resolveDshBin()
  const args = [...binArgs, '--profile', PROFILE_NAME, '--port', String(port), '--no-open']
  const startedAt = Date.now()
  const child: ChildProcess = spawn(command, args, {
    cwd: home,
    env: childEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell,
  })

  let log = ''
  /**
   * 已被裁剪掉的前缀长度（绝对偏移基数）。
   *
   * `mark` 用**绝对**偏移（`logBase + log.length`），所以裁剪不会让旧 mark 失效——
   * 只会在 mark 落在已裁掉区间时少统计一段（运行时把 `mark - logBase` 夹到 0）。
   */
  let logBase = 0
  const collect = (chunk: Buffer): void => {
    log += chunk.toString('utf8')
    if (log.length > 400_000) {
      const drop = log.length - 200_000
      log = log.slice(drop)
      logBase += drop
    }
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  const token = await waitForBootToken(child, () => log)
  const url = `http://127.0.0.1:${port}/?token=${token}`

  // RPC 面：用 Playwright 的 APIRequestContext（自带 cookie jar）。首访带 token 的
  // 首页会种下 httpOnly 鉴权 cookie；后续 `/api/sandore/<method>` 才有权（裸请求 → 401）。
  // readiness 与种子合二为一：GET token URL 成功（<400）即视作实例可用。
  const { request } = await import('@playwright/test')
  const api = await request.newContext({ baseURL: `http://127.0.0.1:${port}/` })
  await waitForReady(api, url, BOOT_TIMEOUT_MS, () => log)
  const bootMs = Date.now() - startedAt

  const call = async <T>(method: string, args: Record<string, unknown>): Promise<T> => {
    const rpcId = randomUUID()
    const response = await api.post(`/api/sandore/${method}`, {
      headers: { 'content-type': 'application/json' },
      data: { type: 'client-request', rpcId, method: `sandore/${method}`, payload: { args } },
    })
    if (!response.ok()) {
      throw new Error(`e2e: RPC sandore/${method} 失败（HTTP ${response.status()}）：${(await response.text()).slice(0, 400)}`)
    }
    const body = await response.json() as { ok?: boolean; value?: T; error?: { message?: string } }
    if (body.ok === false) {
      throw new Error(`e2e: RPC sandore/${method} 返回失败：${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`)
    }
    return (body.value ?? body) as T
  }

  const server: DshServer = {
    url,
    home,
    port,
    bootMs,
    logTail: () => log.slice(-8000),
    logMark: () => logBase + log.length,
    // 注意 `logTail()` 是**整个 worker**（多用例共享一个实例）的最后一段，跨用例会串台：
    // 「本用例窗口内出现了什么」必须用 logSince/countSince 划窗（见 m4 的 host-run 断言）。
    logSince: (mark: number): string => log.slice(Math.max(0, mark - logBase)),
    countSince: (mark: number, pattern: RegExp): number => {
      const from = Math.max(0, mark - logBase)
      return (log.slice(from).match(pattern) ?? []).length
    },
    importDefinitionFromYaml: (yaml: string): Promise<ImportResult> =>
      call<ImportResult>('importDefinitionFromYaml', importArgs(yaml)),
    listInstances: (): Promise<InstanceSummary[]> => call<InstanceSummary[]>('listInstances', {}),
    async getInstanceState(instanceId: string): Promise<InstanceState> {
      const raw = await call<Record<string, unknown>>('getInstanceState', { instanceId })
      return {
        instanceId: String(raw.instanceId ?? instanceId),
        status: String(raw.status ?? ''),
        executedSteps: (raw.executedSteps as InstanceState['executedSteps'] | undefined) ?? [],
        raw,
      }
    },
  }

  const stop = async (): Promise<void> => {
    await api.dispose()
    await killTree(child)
    // 收尾验收：kill 之后端口必须是空的（残留实例不仅占端口，还会让下一轮 e2e 连到上一轮的
    // DSH_HOME 上）。只告警、不抛：占用方也可能是别的进程（例如用户自己的 dev 实例），收尾
    // 探测不该把测试结论改写成失败。
    const freed = await waitPortFree(port, PORT_FREE_TIMEOUT_MS)
    if (freed) {
      console.log(`[e2e] 端口 ${port} 已释放（无残留监听）`)
    } else {
      console.warn(`[e2e] 端口 ${port} 收尾后仍被监听——疑似残留 dsh 实例，会影响下一次运行，请手动清理`)
    }
    if (KEEP_HOME) {
      console.log(`[e2e] 保留临时 DSH_HOME（SANDBORE_E2E_KEEP_HOME=1）：${home}`)
      return
    }
    // 等 sqlite 句柄释放（Windows 上顺序反了会删不掉）；`maxRetries` + `force` 让
    // 目录 junction 走 unlink（不递归进链接目标，否则会删到仓库本体）。
    await delay(500)
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      // 清理失败不影响测试结论：残留目录只在系统临时区，且不含生产数据。
      console.warn(`[e2e] 临时 DSH_HOME 清理失败（可手动删除）：${home}\n  ${String(error)}`)
    }
    if (existsSync(home)) {
      console.warn(`[e2e] 临时 DSH_HOME 残留（不影响本仓与生产）：${home}`)
    }
  }
  return { server, stop }
}

/** 等 stdout 出现 `dsh web: http://127.0.0.1:<port>/?token=<token>`（端口从 URL 反查，避免写死）。 */
async function waitForBootToken(child: ChildProcess, logOf: () => string): Promise<string> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`e2e: dsh 进程提前退出（exit ${child.exitCode}）\n--- dsh log ---\n${logOf().slice(-4000)}`)
    }
    const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s]+))/.exec(logOf())
    if (match !== null && match[3] !== undefined) return match[3]
    await delay(250)
  }
  throw new Error(`e2e: 等待 dsh web token 超时（${BOOT_TIMEOUT_MS}ms）\n--- dsh log ---\n${logOf().slice(-4000)}`)
}

/**
 * 轮询带 token 的首页直到可服务。
 *
 * `?token=` 首访 → 303 重定向（并种下鉴权 cookie），之后正常 200；因此用
 * 「状态 < 400 即成功」判定，不用 200 精确匹配。401 表示 token 无效，
 * 抛错给出明确原因（而不是傻等超时）。
 */
async function waitForReady(
  api: { get: (url: string) => Promise<{ status: () => number }> },
  url: string,
  timeoutMs: number,
  logOf: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const status = (await api.get(url)).status()
      last = `HTTP ${status}`
      if (status < 400) return
      if (status === 401) {
        throw new Error(`e2e: token 被拒绝（401）—— boot 输出的 token URL 无效：${url}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('token 被拒绝')) throw error
      last = String(error)
    }
    await delay(300)
  }
  throw new Error(`e2e: 等待 ${url} 就绪超时（最后状态 ${last}）\n--- dsh log ---\n${logOf().slice(-4000)}`)
}

/** 收尾第一轮：kill 之后等进程树真退出的预算（正常退出 ~100ms，这里只是兜底上限）。 */
const EXIT_TIMEOUT_MS = 10_000

/** 二次强杀后的收尾预算；仍不退则告警（不静默、不抛）。 */
const FORCE_EXIT_TIMEOUT_MS = 5_000

/** 收尾验收：等端口空出来的预算。 */
const PORT_FREE_TIMEOUT_MS = 5_000

/**
 * 强杀进程树。
 *
 * Windows 必须走 `taskkill /T /F`：`spawn` 带了 `shell:true`，child 是 cmd 包装进程，真正
 * 监听端口的 node 是它的**子进程**——只 kill child 会留下还在监听端口的孙子进程，也就是
 * 「上一轮 e2e 跑完端口还被占着」的成因。
 */
function forceKill(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  // 兜底（也在非 Windows 上生效）：直杀 child 本身。Windows 上它是 cmd 包装，`/T` 已覆盖全树。
  child.kill('SIGKILL')
}

/** `exit` 事件的 Promise（已退出则立即 resolve）。 */
function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>(resolveExit => { child.once('exit', () => { resolveExit() }) })
}

/** 有界等待：`promise` 先完成返回 true，超时返回 false（超时不抛）。 */
async function waitBounded(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>(resolveTimeout => { timer = setTimeout(() => { resolveTimeout(false) }, ms) }),
    ])
  } finally {
    // 计时器必须清掉：否则它会把这个 worker 的退出拖到超时之后。
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 递归杀进程树，并**等到进程真的退出**为止。
 *
 * 为什么必须等：`dsh web` 不退出就继续占着端口（默认 3090），下一轮 e2e 要么被端口占用顶掉、
 * 要么连到上一轮的残留实例上——这是最难排查的一类假失败。所以 kill 之后必须 await `exit`，
 * 有界超时后再强杀一轮，仍不退则明确告警（附带可直接粘贴的 taskkill 命令）。
 */
async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (pid === undefined) return
  const startedAt = Date.now()
  // 先挂 exit 监听再杀：顺序反了会漏掉「挂监听之前刚好退出」的窗口，白等一个超时。
  const exited = waitForExit(child)
  forceKill(child)
  if (await waitBounded(exited, EXIT_TIMEOUT_MS)) {
    console.log(`[e2e] dsh 进程树已退出（pid ${pid}，${Date.now() - startedAt}ms）`)
    return
  }
  // 第一轮没退：再强杀一次（taskkill 偶发失败/进程树未完整枚举），并给更短的等待窗口。
  console.warn(`[e2e] dsh 进程树 ${EXIT_TIMEOUT_MS}ms 内未退出（pid ${pid}）——再次强杀`)
  forceKill(child)
  if (await waitBounded(exited, FORCE_EXIT_TIMEOUT_MS)) {
    console.warn(`[e2e] dsh 进程树在二次强杀后退出（pid ${pid}，${Date.now() - startedAt}ms）`)
    return
  }
  // 仍不退：明确告警（这个残留会占着端口污染下一次运行），但不抛——收尾失败不该改变测试
  // 结论，人工排查线索就在这行日志里。
  console.warn(
    `[e2e] dsh 进程树未退出（pid ${pid}）——端口残留会影响下一次运行，请手动清理：\n`
    + `  taskkill /PID ${pid} /T /F`,
  )
}

/** 探测 127.0.0.1:<port> 是否仍被监听（connect 成功 = 有人监听；拒绝 = 空闲）。 */
function portOccupied(port: number): Promise<boolean> {
  return new Promise<boolean>(resolveProbe => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (occupied: boolean): void => {
      socket.destroy()
      resolveProbe(occupied)
    }
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
    socket.setTimeout(1_000, () => { finish(false) })
  })
}

/** 等端口空出来（收尾验收：残留实例会顶掉/污染下一轮 e2e）。 */
async function waitPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!(await portOccupied(port))) return true
    if (Date.now() >= deadline) return false
    await delay(200)
  }
}

/** sleep。 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => { setTimeout(resolveDelay, ms) })
}

/** 页面诊断：console error + pageerror 收集器。 */
export interface PageDiagnostics {
  readonly consoleErrors: readonly string[]
  readonly pageErrors: readonly string[]
  /** 允许模式之外的问题（用作断言源）。 */
  readonly problems: readonly string[]
}

/**
 * 忽略清单：**只忽略与本仓无关的环境噪音**（浏览器/网络层），业务 console error 一律不放过。
 * 目前为空——保持严格；若某条噪音被证实稳定出现且与本仓无关，在此登记并写清原因。
 */
const IGNORED_CONSOLE_PATTERNS: readonly RegExp[] = []

/** 挂 console/pageerror 收集器（返回实时视图）。 */
export function collectDiagnostics(page: Page, sink: string[]): PageDiagnostics {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (IGNORED_CONSOLE_PATTERNS.some(pattern => pattern.test(text))) return
    consoleErrors.push(text)
    sink.push(`console.error: ${text}`)
  })
  page.on('pageerror', (error: Error) => {
    pageErrors.push(error.message)
    sink.push(`pageerror: ${error.message}`)
  })
  return {
    get consoleErrors() { return consoleErrors },
    get pageErrors() { return pageErrors },
    get problems() { return sink },
  }
}

/**
 * 处理一次性 onboarding 弹窗（幂等、可重复调用）。
 *
 * 实测（隔离实例首访，未配 provider）：
 * - 「内测声明」：预置 `ui-onboarding.welcomeNoticeVersion` 后**不弹**；
 * - 「添加一个 API Key 开始使用」：**仍会弹**（与密钥有无无关），按钮
 *   `稍后配置` / `保存并继续`，点「稍后配置」关闭。
 *
 * 弹窗由 DSH 的 Modal 渲染在 `[role="presentation"]` 包装里（不是 `[role="dialog"]`），
 * 且 hydration 后才出现——所以这里按「用户可见的弹窗卡片」遍历正文匹配，并做**有界重试**
 * （默认 8s 内每 250ms 试一次；出现即点掉，始终不出现也不会白等太久）。
 *
 * @param page - 目标页面。
 * @param timeoutMs - 等待弹窗出现的上限（0 = 只快照一次，不等待）。
 */
export async function dismissOnboarding(page: Page, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let acted = false
    for (const [marker, buttonText] of [
      ['内测声明', '继续'],
      ['添加一个 API Key', '稍后配置'],
      ['API Key', '稍后配置'],
    ] as const) {
      const card = page
        .locator('[role="dialog"], [role="presentation"]')
        .filter({ hasText: marker })
        .last()
      if (await card.count() === 0) continue
      if (!(await card.isVisible().catch(() => false))) continue
      const button = card.locator('button', { hasText: buttonText }).first()
      if (await button.count() === 0) continue
      await button.click({ timeout: 5000 }).catch(() => {})
      await delay(200)
      acted = true
    }
    if (!acted && Date.now() >= deadline) return
    await delay(250)
  }
}

/**
 * 打开席位视图（**幂等**：已打开则不再点，避免把视图切回去）。
 *
 * 判定用入口自身的 `aria-expanded`（`sidebar-seat.ts` 的 `syncActive` 同步写入），
 * 再点入口并等 `data-sandore-seat-view` 可见。
 */
export async function openSeat(page: Page): Promise<void> {
  const entry = page.locator('[data-sandore-seat-entry]').first()
  const seatView = page.locator('[data-sandore-seat-view]').first()
  const expanded = await entry.getAttribute('aria-expanded')
  if (expanded !== 'true' || !(await seatView.isVisible().catch(() => false))) {
    await entry.click()
  }
  await expect(seatView).toBeVisible()
}

/** 切到实例/编排模式（`role=tab` 文本匹配）。 */
export async function switchListMode(page: Page, mode: '实例' | '编排'): Promise<void> {
  const tab = page.locator('[data-sandore-wf-list] [role="tab"]', { hasText: mode }).first()
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

/**
 * 纯 UI 建实例（**真实用户路径**，含必须走「浏览…」的 cwd 选择）。
 *
 * 流程（对齐实测）：
 * 「运行工作流」→ 选绑定工作流（`role=menuitemradio`）→ 填作业需求 →
 * 「浏览…」（`SSH_TTY=1` 才落 browse 后端）→「选择工作目录」对话框 →「编辑路径」铅笔 →
 * `input[aria-label="编辑路径"]` 填绝对路径 + Enter →「打开」→「创建」。
 *
 * @returns 创建出的 instanceId（从 `/api/sandore/listInstances` 按需求文本反查）。
 */
export async function createInstanceFromUi(page: Page, options: {
  workflowName: string
  requirement: string
  cwd: string
}): Promise<string> {
  const dialog = page.locator('[role="dialog"]').first()
  await page.locator('[data-sandore-wf-list] button', { hasText: '运行工作流' }).first().click()
  await expect(page.locator('[role="dialog"]').filter({ hasText: '运行工作流' }).first()).toBeVisible()

  // 绑定工作流：第一个 aria-haspopup="menu" 触发器即定义选择器（模型/权限在其后）。
  const trigger = page.locator('[role="dialog"] button[aria-haspopup="menu"]').first()
  await trigger.click()
  const menuItem = page.locator('[role="menu"] [role="menuitemradio"]', { hasText: options.workflowName }).first()
  await expect(menuItem).toBeVisible()
  await menuItem.click()

  // 作业需求。
  const requirement = page.locator('[role="dialog"] textarea[placeholder*="描述"]').first()
  await requirement.fill(options.requirement)

  // 工作目录：走「浏览…」（readOnly 输入框不可直接填）。
  await page.locator('[role="dialog"] button', { hasText: '浏览' }).first().click()
  const browserDialog = page.locator('[role="dialog"]').filter({ hasText: '选择工作目录' }).first()
  await expect(browserDialog).toBeVisible({ timeout: 20_000 })
  // 「编辑路径」按钮在对话框**首帧**可能被重挂（点击「浏览」后 React 切换浏览器模式），
  // 此时 click 会以 `element was detached from the DOM` 失败（全量跑偶发、单跑不复现的
  // 时序 flake）。这里做有界重试；仍失败则让真实错误抛出（不掩盖缺陷）。
  const editPathButton = browserDialog.locator('button[aria-label="编辑路径"]').first()
  let editPathClicked = false
  for (let attempt = 0; attempt < 3 && !editPathClicked; attempt += 1) {
    await expect(browserDialog).toBeVisible({ timeout: 20_000 })
    editPathClicked = await editPathButton.click({ timeout: 8_000 }).then(() => true, () => false)
  }
  if (!editPathClicked) await editPathButton.click()
  const pathInput = browserDialog.locator('input[aria-label="编辑路径"]').first()
  await pathInput.fill(options.cwd)
  await pathInput.press('Enter')
  const openButton = browserDialog.locator('button', { hasText: /^打开$/ }).first()
  await expect(openButton).toBeEnabled({ timeout: 20_000 })
  await openButton.click()
  await expect(browserDialog).toBeHidden({ timeout: 20_000 })

  // 创建（cwd + 定义 + 需求齐备才 enabled）。
  const createButton = dialog.locator('button', { hasText: /^创建$/ }).last()
  await expect(createButton).toBeEnabled({ timeout: 20_000 })
  await createButton.click()
  // 等运行视图出现。宽限到 60s（原 30s）：创建链路要起宿主会话 + 主代理首个 turn + SSE 装配，
  // 全量串跑（单机 11–12 分钟长跑、后段更拥挤）时偶发超过 30s —— 2026-09-13 的全量里
  // M6 第二条正是卡在这一步（fixture 超时，不是被测行为失败）。
  await expect(page.locator('[data-sandore-run-view]').last()).toBeVisible({ timeout: 60_000 })

  const instances = await listInstances(page)
  const created = instances.filter(instance => instance.originalInput === options.requirement)
  if (created.length === 0) {
    throw new Error(`e2e: 创建后未在 listInstances 中找到需求为「${options.requirement}」的实例`)
  }
  // 取最新一条（createdAt 降序容错：取 updatedAt 最大者）。
  return created.reduce((latest, item) => (item.updatedAt > latest.updatedAt ? item : latest)).instanceId
}

/**
 * typert 网关的 RPC 载荷形状（**每个方法不同，不能一律平铺**）。
 *
 * 依据 `packages/workflow/typert/typert.remote-client.js` 的 descriptors：
 * - 无参方法（`listInstances`/`listDefinitions`）→ `{}`；
 * - 单标量参数（`getInstanceState(instanceId)`）→ 直接平铺；
 * - 对象参数（`importDefinitionFromYaml(input)`）→ 必须包在 `{ input: {...} }` 里，
 *   平铺会报 `args fields do not match the descriptor: missing "input"`。
 */
function importArgs(yaml: string): Record<string, unknown> {
  return { input: { yaml } }
}

/** 经页面上下文调 sandore RPC（`page.request` 自动带 httpOnly 鉴权 cookie）。
 *
 * 注意：playwright 的 `use.baseURL` **刻意不设**（见 playwright.config.ts），所以
 * `page.request` 无法解析相对路径——这里用 `new URL(path, page.url())` 显式拼绝对地址。
 * 用于**前置造数**与**状态对账**（比 UI 路径快且稳）。
 */
export async function sandoreRpc<T>(page: Page, method: string, args: Record<string, unknown>): Promise<T> {
  const rpcId = randomUUID()
  const endpoint = new URL(`/api/sandore/${method}`, page.url()).toString()
  const response = await page.request.post(endpoint, {
    headers: { 'content-type': 'application/json' },
    data: { type: 'client-request', rpcId, method: `sandore/${method}`, payload: { args } },
  })
  if (!response.ok()) {
    throw new Error(`e2e: RPC sandore/${method} 失败（HTTP ${response.status()}）：${(await response.text()).slice(0, 400)}`)
  }
  // 帧格式：{ type: 'server-response', rpcId, result: { ok, value } }。
  const frame = await response.json() as {
    result?: { ok?: boolean; value?: T; error?: { message?: string } }
  }
  const result = frame.result
  if (result === undefined) {
    throw new Error(`e2e: RPC sandore/${method} 响应缺少 result 字段：${JSON.stringify(frame).slice(0, 300)}`)
  }
  if (result.ok === false) {
    throw new Error(`e2e: RPC sandore/${method} 返回失败：${result.error?.message ?? JSON.stringify(frame).slice(0, 300)}`)
  }
  return result.value as T
}

/** 导入定义（幂等；同名同版本重复导入返回 `skipped`）。 */
export function importDefinition(page: Page, yaml: string): Promise<ImportResult> {
  return sandoreRpc<ImportResult>(page, 'importDefinitionFromYaml', importArgs(yaml))
}

/** 实例列表。 */
export function listInstances(page: Page): Promise<InstanceSummary[]> {
  return sandoreRpc<InstanceSummary[]>(page, 'listInstances', {})
}

/** 定义列表（按名称反查定义 id / 版本；导入默认按 name 匹配，落库 id 是 `wfl-{uuid}`）。 */
export function listDefinitions(page: Page): Promise<DefinitionEntry[]> {
  return sandoreRpc<DefinitionEntry[]>(page, 'listDefinitions', {})
}

/**
 * 确保某 name 的定义已就绪并返回其**落库 id**。
 *
 * `importDefinitionFromYaml` 默认 `matchBy:'name'`：同版本重放返回 `skipped` 且带上
 * 既有记录的 id；首次返回 `created`（记录键是 `wfl-{uuid}`，不是 YAML 顶层 id）。
 */
export async function ensureDefinition(page: Page, yaml: string, name: string): Promise<DefinitionEntry> {
  const result = await importDefinition(page, yaml)
  const found = (await listDefinitions(page)).find(entry => entry.name === name)
  if (found === undefined) {
    throw new Error(`e2e: 导入后未找到定义「${name}」（导入结果：${JSON.stringify(result)}）`)
  }
  return found
}

/** 单条定义的摘要面（`listDefinitions` 行）。 */
export interface DefinitionEntry {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly yaml: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** 实例状态（结构面）。 */
export async function getInstanceState(page: Page, instanceId: string): Promise<InstanceState> {
  const raw = await sandoreRpc<Record<string, unknown>>(page, 'getInstanceState', { instanceId })
  return {
    instanceId: String(raw.instanceId ?? instanceId),
    status: String(raw.status ?? ''),
    executedSteps: (raw.executedSteps as InstanceState['executedSteps'] | undefined) ?? [],
    raw,
  }
}

/** 快照一个 3090 实例：worker 级 fixture（`workers: 1` → 全轮共享一个临时 home）。 */
export interface DshFixtures {
  /** 运行中的隔离实例（含 RPC 面 + 日志尾）。 */
  dsh: DshServer
  /** 每次重试/每个 worker 唯一的 cwd 目录（落在临时 home 下，绝不出仓库/生产）。 */
  workspace: string
}

/** `dsh` fixture 的 boot 预算（含首次 junction 建链）。 */
const BOOT_TIMEOUT = BOOT_TIMEOUT_MS + 60_000

/**
 * 扩展的 test 对象：`dsh`（隔离实例）+ `workspace`（临时 cwd）。
 *
 * 用例里 **不要** 用 `page.goto('/')`（无 baseURL）：显式 `page.goto(dsh.url)`。
 */
export const test = base.extend<{ problems: string[]; diagnostics: PageDiagnostics }, DshFixtures>({
  dsh: [async ({}, use) => {
    const { server, stop } = await startDsh()
    try {
      await use(server)
    } finally {
      await stop()
    }
  }, { scope: 'worker', timeout: BOOT_TIMEOUT }],

  workspace: [async ({ dsh }, use, workerInfo) => {
    const dir = join(dsh.home, 'ws', `w${workerInfo.workerIndex}-${workerInfo.parallelIndex}`)
    mkdirSync(dir, { recursive: true })
    await use(dir)
  }, { scope: 'worker' }],

  // 每个用例独立的诊断汇聚点（console error / pageerror）。
  problems: async ({}, use) => { await use([]) },

  page: async ({ page, dsh, problems }, use) => {
    collectDiagnostics(page, problems)
    // SSE 采集器要在应用建 EventSource 之前装好（否则会漏掉早于首帧的事件）——
    // 因此必须在 `goto` **之前** addInitScript。装了它，任何用例都可以用
    // `readSseFrames(page)` 做事件对账（见 fixtures/sse.ts）。
    await installSseCollector(page)
    await page.goto(dsh.url, { waitUntil: 'domcontentloaded' })
    await dismissOnboarding(page)
    // 首屏水合完成信号：侧栏席位入口出现（否则后续点击会 race）。
    await expect(page.locator('[data-sandore-seat-entry]').first()).toBeVisible({ timeout: 30_000 })
    await use(page)
    await dismissOnboarding(page)
  },
})

/** 断言用的稳定文本（避免散落魔法字符串）。 */
export const TEXT = {
  seatEntryLabel: '工作流',
  tabInstance: '实例',
  tabDefinition: '编排',
  statusRunning: '运行中',
  statusCompleted: '已完成',
  statusAborted: '已中止',
  runWorkflow: '运行工作流',
  browse: '浏览',
  open: '打开',
  create: '创建',
} as const

/** 计算一段文本的短 hash（用于生成本轮唯一的定义 id 后缀，避免跨轮撞号）。 */
export function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8)
}

/**
 * 生成 mock LLM 的**行为指令**，嵌进 Step 的 `promptText` 即可控制该次模型调用
 * （语法与语义见 `e2e/mock-llm/index.js` 模块头）。
 *
 * 为什么用提示词而不是 env：`dsh` fixture 是 worker-scoped（`workers: 1` → 全轮共享
 * 一个实例），boot 期 env 对同 worker 的所有用例只有一份；提示词按 YAML/用例隔离。
 *
 * @param options.text - 文本主体（默认按 mock 插件的 `mock-ok`）。
 * @param options.chunks - 文本分片数（>1 观察流式）。
 * @param options.delay - 内容分片之间的延迟 ms。
 * @param options.hold - 内容完整后再等 ms（撑出「文本可见 + step 仍 running」窗口）。
 * @param options.fail - true → 每次调用都以 error 终止（step → failed，M6 用）。
 * @param options.failFirst - true → 仅该会话第 1 次调用失败（重试类用例）。
 * @param options.tools - K → 该会话前 K 次调用返回 tool-call，第 K+1 次返回文本。
 * @param options.once - 1 → **一次性强制工具调用**：本指令文本一经出现在请求里，下一次调用
 *   就产出 `tool`/`toolargs` 的 tool-call（每会话一次，与调用序号无关）。用于「往主代理会话投
 *   一条消息来驱动某个工具」的场景（`tools=K` 在那里不可预知——工具结果回灌/终态通知会占号）。
 * @param options.think - 非空 → 文本轮先产出一个 reasoning 块（面板的「思考」折叠行；
 *   需求 2 的左边界对齐断言需要一条真实思考行）。**值里不能含空格**。
 * @returns 形如 `[[e2e-mock text=… chunks=… hold=…]]` 的指令串。
 */
export function mockDirective(options: {
  text?: string
  chunks?: number
  delay?: number
  hold?: number
  fail?: boolean
  failFirst?: boolean
  tools?: number
  once?: number
  tool?: string
  toolargs?: string
  think?: string
} = {}): string {
  const tokens: string[] = []
  if (options.text !== undefined) tokens.push(`text=${options.text}`)
  if (options.chunks !== undefined) tokens.push(`chunks=${options.chunks}`)
  if (options.delay !== undefined) tokens.push(`delay=${options.delay}`)
  if (options.hold !== undefined) tokens.push(`hold=${options.hold}`)
  if (options.fail !== undefined) tokens.push(`fail=${options.fail ? 1 : 0}`)
  if (options.failFirst !== undefined) tokens.push(`failfirst=${options.failFirst ? 1 : 0}`)
  if (options.tools !== undefined) tokens.push(`tools=${options.tools}`)
  if (options.once !== undefined) tokens.push(`once=${options.once}`)
  if (options.tool !== undefined) tokens.push(`tool=${options.tool}`)
  if (options.toolargs !== undefined) tokens.push(`toolargs=${options.toolargs}`)
  if (options.think !== undefined) tokens.push(`think=${options.think}`)
  return `[[e2e-mock ${tokens.join(' ')}]]`
}

export { expect }
