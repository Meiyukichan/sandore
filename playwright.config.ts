import { defineConfig } from '@playwright/test'

/**
 * sandore e2e（Playwright）配置。
 *
 * 设计要点（与 vitest 完全隔离，互不影响）：
 * - `testDir: './e2e'` + `testMatch: /.*\.e2e\.ts$/`：`vitest.config.ts` 只收集
 *   `packages/**\/*.spec.ts`，`e2e/**` 不进 vitest；本仓 `tsconfig*.json` 的 include
 *   也不含 `e2e/`（e2e 不进 `pnpm typecheck`，见 README/e2e 说明）。
 * - **不使用 `webServer`，也不设静态 `use.baseURL`**：被测实例是
 *   `DSH_HOME=<临时目录> dsh --profile e2e --port 3090 --no-open` 起的隔离实例，
 *   访问 URL 携带**每次 boot 都变化**的 `?token=`（无 token → 401），而配置文件在
 *   globalSetup 之前求值，静态 baseURL 拿不到 token。改由 worker-scoped fixture
 *   （`e2e/fixtures/harness.ts` 的 `dsh` fixture）spawn 服务并解析 stdout 的
 *   `dsh web: http://127.0.0.1:<port>/?token=<token>` 行。
 * - `workers: 1`：全局共享一个临时 DSH_HOME + 一个 3090 实例（SQLite 单写者）。
 * - 产物（trace / html 报告 / test-results）统一落 `e2e/.artifacts`，已 gitignore。
 */
/** 报告与产物根目录（相对仓库根；已加入 .gitignore）。 */
const ARTIFACTS_DIR = 'e2e/.artifacts'

export default defineConfig({
  testDir: './e2e',
  // 只有 *.e2e.ts 是用例；fixtures/ 是支撑代码（避免被当作 spec 收集）。
  testMatch: /.*\.e2e\.ts$/,
  testIgnore: /[\\/]fixtures[\\/]/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  // 冷启 3090（首次会建数百个 junction）约 15–25s，再叠用例本身；单用例上限放 90s。
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: `${ARTIFACTS_DIR}/html-report`, open: 'never' }],
  ],
  outputDir: `${ARTIFACTS_DIR}/test-results`,
  use: {
    // 不用 baseURL：token URL 由 fixture 提供，用例里显式 page.goto(dsh.url)。
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'zh-CN',
    viewport: { width: 1700, height: 1000 },
    actionTimeout: 20_000,
  },
})
