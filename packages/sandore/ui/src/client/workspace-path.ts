/**
 * workspace-path：DSH runtime `packages/client/runtime/src/client/workspaces/path.ts`
 * 的本地复刻。rc.6 已装版本的 `@deepseek-ai/dsh-client-runtime` 尚未导出
 * `resolveWorkspacePath`（rc.8 才有），而 sandore 编译面锁定的 rc.6 包 lib/client.js
 * 没有它，故按 DSH 源码逐字本地复刻——与 tool-call-model.ts 的 `abbreviateHomePath`
 * 复刻同法。逐字保留 DSH 逻辑、注释与参数契约。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/workspace-path
 */

/**
 * Resolve a workspace-relative path into the Host-facing spelling used by openPath.
 * @param cwd - session workspace root, when known.
 * @param path - absolute or workspace-relative path.
 * @returns an absolute path when a workspace root is available, otherwise the original path.
 */
export function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (path.startsWith('/') || isWindowsStylePath(path)) return path
  if (cwd === undefined || cwd === '') return path
  const base = cwd.replace(/[/\\]+$/, '')
  const rel = path.replace(/^[/\\]+/, '')
  return `${base}/${rel}`
}

/** Drive-letter or UNC path; Web display must not rewrite these as `~`. */
function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}
