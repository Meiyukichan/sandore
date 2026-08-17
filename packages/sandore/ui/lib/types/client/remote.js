import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote';
export { sandoreRemote };
/**
 * 一次 sandore RPC 调用失败（`RemoteFailure` 的 `Error` 子类包装）。
 *
 * 保留 `code` 与 `details`，使失败分支可被统一捕获并按 code 路由，
 * 而非静默吞掉或抛出裸对象。
 */
export class SandoreRemoteError extends Error {
    /** Host 侧报错的稳定机器码。 */
    code;
    /** Host 侧附加的错误详情（JSON 对象）。 */
    details;
    constructor(failure) {
        super(`${failure.code}: ${failure.message}`);
        this.name = 'SandoreRemoteError';
        this.code = failure.code;
        this.details = failure.details;
    }
}
/**
 * 解包 `RemoteResult`：`ok:true` 取 `value`，`ok:false` 抛 `SandoreRemoteError`。
 *
 * 载波层故障已折叠进 `error` 分支，消费者无需 try/catch 恢复；仅装配性
 * 故障（arity 不匹配、方法未挂载、缺 Context binder）仍 reject。
 */
export function unwrap(result) {
    if (result.ok)
        return result.value;
    throw new SandoreRemoteError(result.error);
}
//# sourceMappingURL=remote.js.map