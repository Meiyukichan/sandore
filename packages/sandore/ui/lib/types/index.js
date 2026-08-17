/**
 * sandore UI 插件的 Host 半。
 *
 * 纯 UI 插件的 Node 半是一个空 apply——仅为了让插件出现在宿主 cordis.yml / Loader 里；
 * 浏览器半经 package.json 的 `exports["./client"]` 与 `dsh.client` 声明被发现并加载。
 */
export function apply() { }
//# sourceMappingURL=index.js.map