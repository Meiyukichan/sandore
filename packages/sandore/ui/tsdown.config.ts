/**
 * ui 包 client bundle 构建（照 DSH `clientBundle()` 形态）。
 *
 * 产出两半：
 * - Node 半：`lib/types/index.js`（tsc -b 产物）→ `lib/index.js`（esm），
 *   承载插件宿主半的空 `apply`。
 * - Client 半：`lib/types/client/index.js`（tsc -b 产物）→ `lib/client.js`（cjs），
 *   经 `window.__ModuleLoader__.load({ id, factory })` 闭包工厂产出，外部依赖
 *   （react / primitives 等平台模块）经注入的 `require` 模块表解析；本地 TS/TSX、
 *   `@deepseek-ai/dsh-sandore-workflow` 浏览器安全子路径与 CSS Modules 全部内联。
 *
 * CSS Modules 无 lightningcss 依赖，退化为「类名恒等映射 + 原始 CSS 注入
 * `<style data-plugin>`」：`css.foo` 返回 `'foo'`，与注入的原始 `.foo` 选择器
 * 精确匹配（sandore 组件 CSS 均为扁平类名，无嵌套/哈希需求）。
 * @module @deepseek-ai/dsh-client-ui-sandore/tsdown.config
 */
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import { defineConfig, type UserConfig } from 'tsdown'

/** 插件 id（包名），打进 `__ModuleLoader__.load` 交接与注入样式标签。 */
const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-sandore'

/**
 * 浏览器侧平台模块表（外置，经注入 `require` 解析）：React 运行时与 cordis/UI
 * 基元服务。本地 TS/TSX 与 `@deepseek-ai/dsh-sandore-workflow` 子路径不在表中，
 * 由 tsdown 内联进 client bundle。
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** 虚拟 id 前缀/后缀：隔离 CSS 与 tsdown 自身 css 管线（后缀避开 `.css` 命中守卫）。 */
const CSS_VIRTUAL_PREFIX = '\0sandore-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Node builtin shim 虚拟 id 前缀：拦截被内联依赖（如 yaml 的 Node dist）的 require。 */
const NODE_SHIM_PREFIX = '\0sandore-node-shim:'

/**
 * Node builtin shim 插件。
 *
 * `format: 'cjs'` 会让 tsdown 把 platform 视作 node（tsdown 的 cjs 分支强制
 * `platform = node`），于是被内联的依赖（`yaml` 包经 workflow 的 `./yaml` 子路径
 * 进入 client bundle）解析到 Node dist，其 `require("process")` / `require("buffer")`
 * 会以 external 形式残留，而浏览器模块表无这两者，启动即抛
 * `require("process") missed the module table`。
 *
 * 本插件在 resolveId 阶段拦截 `process` / `buffer`（及 `node:` 前缀），替换为
 * 浏览器安全的 shim：
 * - `process`：提供 `emitWarning`（yaml 的 warn 降级路径）等无副作用方法；
 * - `buffer`：`Buffer` 置为 `undefined`，让 yaml 的 binary 类型回退到浏览器原生
 *   `atob`（`typeof Buffer === "function"` 判否）。
 * sandore 的工作流 YAML 不涉及 binary tag，此 shim 仅保证加载不炸、语义等价。
 */
function nodeBuiltinsShimPlugin(): NonNullable<UserConfig['plugins']>[number] {
  const processShim = [
    'const _process = {',
    '  env: {},',
    '  platform: "browser",',
    '  version: "",',
    '  versions: {},',
    '  browser: true,',
    '  argv: [],',
    '  emitWarning: () => {},',
    '  nextTick: (fn) => { if (typeof queueMicrotask === "function") queueMicrotask(fn); else Promise.resolve().then(fn); },',
    '  cwd: () => "/",',
    '};',
    // default + 具名双导出：覆盖 `import process from 'node:process'`（default）
    // 与 `import * as process from 'node:process'`（命名空间，yaml 内联后访问
    // `node_process.env.LOG_TOKENS` 等具名成员）两种消费形态。
    'export default _process;',
    'export const env = _process.env;',
    'export const platform = _process.platform;',
    'export const version = _process.version;',
    'export const versions = _process.versions;',
    'export const browser = _process.browser;',
    'export const argv = _process.argv;',
    'export const emitWarning = _process.emitWarning;',
    'export const nextTick = _process.nextTick;',
    'export const cwd = _process.cwd;',
  ].join('\n')
  const bufferShim = [
    // Buffer 置 undefined：yaml binary 类型据此回退到浏览器原生 atob。
    'export default { Buffer: undefined };',
  ].join('\n')
  return {
    name: 'sandore-node-builtins-shim',
    resolveId(source: string) {
      if (source === 'process' || source === 'node:process') return NODE_SHIM_PREFIX + 'process'
      if (source === 'buffer' || source === 'node:buffer') return NODE_SHIM_PREFIX + 'buffer'
      return null
    },
    load(id: string) {
      if (id === NODE_SHIM_PREFIX + 'process') return processShim
      if (id === NODE_SHIM_PREFIX + 'buffer') return bufferShim
      return null
    },
  }
}

/** 把 emit 的 lib-relative 资源回映到 src 源码树（tsc 不拷贝 `.css`）。 */
function sourceAssetPath(source: string, importer: string | undefined): string {
  const emitted = importer === undefined ? source : resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}

/**
 * CSS Modules 内联插件：读原始 `.module.css`，注入样式标签并导出类名映射。
 *
 * 类名以「文件名短 hash 前缀 + 原名」改写（`css.foo` → `sXyzw_foo`），CSS 文本中
 * 的 `.foo` 选择器同步替换——避免多个 `.module.css` 的通用类名（`.layer`/`.header`
 * 等）与 DSH 或其他模块的全局类名冲突（此前的恒等映射会让 `.layer` 互相覆盖）。
 *
 * 另拦截第三方普通 CSS（`@xyflow/react/dist/style.css`）：原样注入 `<style>`，
 * 不提取成独立文件（ModuleLoader bundle 不加载外部 css；`@tsdown/css` 会提取）。
 */
function cssModulesPlugin(): NonNullable<UserConfig['plugins']>[number] {
  const XYFLOW_STYLE_ID = CSS_VIRTUAL_PREFIX + 'xyflow-style' + CSS_VIRTUAL_SUFFIX

  /** 从 cwd 向上找含 `node_modules/.pnpm` 的目录（workspace 根）。 */
  function findPnpmDir(): string {
    let dir = process.cwd()
    for (;;) {
      const candidate = resolvePath(dir, 'node_modules', '.pnpm')
      if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) return ''
      dir = parent
    }
  }

  /** 在 pnpm 布局下定位 @xyflow/react/dist/style.css（@xyflow+react@版本目录下的 node_modules 内）。 */
  function findXyflowStyleCss(): string {
    const pnpmDir = findPnpmDir()
    if (pnpmDir === '') return ''
    let entries: string[] = []
    try {
      entries = readdirSync(pnpmDir)
    } catch {
      return ''
    }
    for (const dir of entries) {
      if (!dir.startsWith('@xyflow+react@')) continue
      const candidate = resolvePath(pnpmDir, dir, 'node_modules', '@xyflow', 'react', 'dist', 'style.css')
      if (existsSync(candidate)) return candidate
    }
    return ''
  }

  /** 生成「注入 <style> 样式标签」的模块代码（exportCode 追加为模块导出，缺省无导出）。 */
  function inlineStyleModule(cssText: string, tagId: string, exportCode: string): string {
    return [
      `const css = ${JSON.stringify(cssText)};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
      '  const tag = document.createElement(\'style\');',
      `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      exportCode,
    ].join('\n')
  }

  return {
    name: 'sandore-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (source === '@xyflow/react/dist/style.css') return XYFLOW_STYLE_ID
      if (source.endsWith('.module.css')) {
        const abs = sourceAssetPath(source, importer)
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      }
      // 全局 CSS（如 reactflow 主题文件，类名需保持全局 .react-flow/.xy-*）原样注入。
      if (source.endsWith('.css')) {
        const abs = sourceAssetPath(source, importer)
        return CSS_VIRTUAL_PREFIX + 'global:' + abs + CSS_VIRTUAL_SUFFIX
      }
      return null
    },
    async load(virtualId: string) {
      if (virtualId === XYFLOW_STYLE_ID) {
        const css = await readFile(findXyflowStyleCss(), 'utf8')
        return inlineStyleModule(css, `${PLUGIN_ID}/xyflow-style.css`, 'export default undefined;')
      }
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      // 全局 CSS：原样注入，不 hash（类名为 .react-flow__* / .xy-* 等全局 token）。
      if (virtualId.slice(CSS_VIRTUAL_PREFIX.length).startsWith('global:')) {
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length + 'global:'.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId, 'utf8')
        return inlineStyleModule(source, `${PLUGIN_ID}/${basename(fileId)}`, 'export default undefined;')
      }
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId, 'utf8')
      const tagId = `${PLUGIN_ID}/${basename(fileId)}`
      // 文件名短 hash 前缀（稳定：同一文件类名一致；不同文件不冲突）。
      let hash = 0
      for (const char of basename(fileId)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
      const prefix = `s${hash.toString(36).slice(0, 5)}_`
      // 仅替换 `.类名` 选择器 token（伪类/属性/数字不匹配；`@keyframes` 名无点不受影响）。
      const rewritten = source.replace(/\.([A-Za-z_][A-Za-z0-9_-]*)/g, (match, name: string) => `.${prefix}${name}`)
      const exportCode = `export default new Proxy({}, { get: (_target, prop) => typeof prop === 'string' ? ${JSON.stringify(prefix)} + prop : undefined });`
      return inlineStyleModule(rewritten, tagId, exportCode)
    },
  }
}

export default defineConfig([
  {
    // Node 半：插件宿主空 apply（tsc -b 已 emit lib/types/index.js）。
    name: PLUGIN_ID,
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    // Client 半：浏览器闭包工厂产物，落地为 lib/client.js。
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id as (typeof CLIENT_EXTERNALS)[number]) ? undefined : true),
    plugins: [nodeBuiltinsShimPlugin(), cssModulesPlugin()],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      // 注入局部 `process` shim：React Flow 等内联依赖会裸引用全局 process（非 import），
      // 浏览器无该全局；局部 var 使 `process.env.NODE_ENV` 等读稳定值。
      intro: 'var module = { exports: {} }; var exports = module.exports; var process = { env: { NODE_ENV: "production" }, platform: "browser", version: "", versions: {}, browser: true, argv: [], emitWarning: function(){}, nextTick: function(fn){ if (typeof queueMicrotask === "function") queueMicrotask(fn); else Promise.resolve().then(fn); }, cwd: function(){ return "/"; } };',
    },
  },
])
