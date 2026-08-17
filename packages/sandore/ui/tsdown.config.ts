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
import { existsSync } from 'node:fs'
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
    'const process = {',
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
    'export default process;',
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

/** CSS Modules 内联插件：读原始 `.module.css`，注入样式标签并导出恒等类名映射。 */
function cssModulesPlugin(): NonNullable<UserConfig['plugins']>[number] {
  return {
    name: 'sandore-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = sourceAssetPath(source, importer)
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId, 'utf8')
      const tagId = `${PLUGIN_ID}/${basename(fileId)}`
      return [
        `const css = ${JSON.stringify(source)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        'export default new Proxy({}, { get: (_target, prop) => typeof prop === \'string\' ? prop : undefined });',
      ].join('\n')
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
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
