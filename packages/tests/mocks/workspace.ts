/**
 * 内存 mock workspace（测试专用，非发布面）。
 *
 * 对齐引擎接缝类型 `WorkspaceRegistrySeam`/`WorkspaceSeam`（签名同 DSH
 * `WorkspaceRegistry.resolveByPath` / `WorkspaceRegistry.create` /
 * `Workspace.attachSession`）：FakeWorkspaceRegistry 按路径 Map 解析，
 * `create` 把路径登记为新 workspace（mock 不做目录存在性校验——校验是 DSH
 * 真实实体职责），FakeWorkspace 只记录 attach 的会话 id（不做 header cwd
 * 校验——校验是 DSH 真实实体职责，mock 只验证引擎的 attach 调用面）。以
 * `ctx.provide('workspaceRegistry', …)` 注入。
 * @module @meiyukichan/dsh-sandore/workflow/tests/mocks/workspace
 */
import type { SessionId } from '@deepseek-ai/dsh-session';

/** 单个 fake workspace：`attachSession` 记录会话 id（不校验 header cwd）。 */
export class FakeWorkspace {
  /** 已 attach 的会话 id（按调用顺序）。 */
  readonly attached: SessionId[] = [];

  /** @param path - 该 workspace 的规范目录路径（`resolveByPath` 的匹配键）。 */
  constructor(readonly path: string) {}

  attachSession(sessionId: SessionId): Promise<void> {
    this.attached.push(sessionId);
    return Promise.resolve();
  }
}

/** fake workspace 注册表：按路径 Map 解析（未命中返回 undefined）。 */
export class FakeWorkspaceRegistry {
  private readonly byPath = new Map<string, FakeWorkspace>();

  /** @param workspaces - 登记进注册表的 fake workspace 列表。 */
  constructor(workspaces: readonly FakeWorkspace[]) {
    for (const workspace of workspaces) {
      this.byPath.set(workspace.path, workspace);
    }
  }

  resolveByPath(path: string): Promise<FakeWorkspace | undefined> {
    return Promise.resolve(this.byPath.get(path));
  }

  /** 按路径登记一个新 workspace（已存在则返回原实体，对齐 DSH create 语义）。 */
  create(path: string): Promise<FakeWorkspace> {
    const existing = this.byPath.get(path);
    if (existing !== undefined) return Promise.resolve(existing);
    const workspace = new FakeWorkspace(path);
    this.byPath.set(path, workspace);
    return Promise.resolve(workspace);
  }
}
