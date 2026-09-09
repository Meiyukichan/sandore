/**
 * `model-faces.ts` 的单元测试：模型目录桥接（直通 / 不可用占位的快照引用稳定性与
 * routable 语义）与 `/permission` 报告解析。全 mock，无宿主依赖。
 * @module @meiyukichan/dsh-sandore/client/src/model-faces.spec
 */
import { describe, expect, it } from 'vitest';

import { bridgeModelDirectory, parsePermissionReport } from './model-faces.ts';
import type { ModelDirectoryState } from './model-faces.ts';

/** 最小宿主目录（对齐 rc.1 ui-model-selection 的 ModelDirectory 面）。 */
function makeHostDirectory(state: ModelDirectoryState = {
  current: null,
  routable: true,
  groups: [],
  failures: [],
  status: 'ready',
  error: null,
}) {
  return {
    store: {
      getSnapshot: () => state,
      subscribe: () => () => {},
    },
    load: async () => {},
    select: async () => {},
    dispose: () => {},
  };
}

describe('bridgeModelDirectory', () => {
  it('passes the host store through untouched when the directory service exists', async () => {
    const hostDirectory = makeHostDirectory();
    const face = bridgeModelDirectory({ modelDirectories: { directoryFor: () => hostDirectory } }, 'inst-1');
    expect(face.store).toBe(hostDirectory.store);
    // wrapper 的 load/select/dispose 转发到 host 目录。
    await expect(face.load()).resolves.toBeUndefined();
    await expect(face.select({ provider: 'p', model: 'm' })).resolves.toBeUndefined();
    expect(() => face.dispose()).not.toThrow();
  });

  it('falls back to a stable unavailable directory when the service is absent', async () => {
    const face = bridgeModelDirectory({}, 'inst-1');
    // useSyncExternalStore 硬性要求：getSnapshot 必须返回引用稳定（缓存）的快照，
    // 否则 React 判定 store 持续变化 → Maximum update depth exceeded（#185）。
    expect(face.store.getSnapshot()).toBe(face.store.getSnapshot());
    expect(face.store.getSnapshot()).toMatchObject({ routable: false, status: 'error' });
    // routable:false → ModelSelectSandore 渲染 null（隐藏选择器而非错误触发器）。
    expect(face.store.getSnapshot().routable).toBe(false);
    await expect(face.load()).rejects.toThrow('model selection is unavailable');
  });

  it('falls back when accessing the service throws (cordis un-injected property access)', () => {
    const hostile = { get modelDirectories(): never { throw new Error('cannot get property "modelDirectories" without inject'); } };
    const face = bridgeModelDirectory(hostile, 'inst-1');
    expect(face.store.getSnapshot()).toBe(face.store.getSnapshot());
    expect(face.store.getSnapshot().error).toContain('model selection is unavailable');
  });

  it('falls back when directoryFor throws (session has no client scope/binding)', () => {
    const host = {
      modelDirectories: {
        directoryFor: () => { throw new Error('ui-model-selection: session resolved no scope'); },
      },
    };
    const face = bridgeModelDirectory(host, 'inst-1');
    expect(face.store.getSnapshot()).toBe(face.store.getSnapshot());
    expect(face.store.getSnapshot()).toMatchObject({ routable: false });
  });

  it('self-heals when a resolver function starts unavailable and the service/session appears later (client B)', () => {
    const hostDirectory = makeHostDirectory();
    let service: unknown;
    const face = bridgeModelDirectory(
      () => ({ modelDirectories: service as { directoryFor(): unknown } }),
      'inst-1',
    );
    // 未就绪：引用稳定占位 + routable false（不崩渲染）。
    const before = face.store.getSnapshot();
    expect(face.store.getSnapshot()).toBe(before);
    expect(before).toMatchObject({ routable: false });
    // 服务/会话晚出现：下一次读取自动切换到 host 快照（自愈）。
    service = { directoryFor: () => hostDirectory };
    const after = face.store.getSnapshot();
    expect(after).toMatchObject({ routable: true });
    // 后续操作转发到 host。
    void expect(face.load()).resolves.toBeUndefined();
  });
});

describe('parsePermissionReport', () => {
  it('parses the /permission report shape', () => {
    expect(parsePermissionReport('current preset workspace-write (available: workspace-write, danger-full-access)')).toEqual({
      currentValue: 'workspace-write',
      options: [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
    });
  });

  it('returns undefined for malformed reports', () => {
    expect(parsePermissionReport('no such preset (available: )')).toBeUndefined();
    expect(parsePermissionReport('random text')).toBeUndefined();
  });
});
