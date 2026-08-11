/**
 * 模型管理（ModelManager）—— @meiyukichan/claude-sdk 适配层（event-01）
 *
 * ModelManager.list() 返回 { location: LocationInfo, data: ModelV2Info[] }：
 *   - 内部调用 Claude SDK Query.supportedModels()（design.md D9）；
 *   - 惰性初始化并缓存一个「控制 Query」——首次调用以 query({ prompt: <永不产出的空
 *     AsyncIterable>, options: { cwd } }) 创建，复用其 supportedModels()；
 *   - ModelInfo→ModelV2Info：value→id、displayName→name、providerID 固定 'anthropic'、
 *     status 默认 'active'，resolvedModel（规范 wire id）保留在 variants；
 *   - location.directory 默认客户端 cwd，可被 options.location.directory 覆盖；
 *   - 控制 Query 在 client.close() 时关闭。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFactory, QueryLike } from './session-state';
import type { ModelListResponse, ModelV2Info } from './types';

/** ModelManager 构造参数。 */
export interface ModelManagerOptions {
  /** 客户端工作目录（控制 Query 的 options.cwd 与默认 location.directory）。 */
  cwd: string;
  /** 创建 Query 的工厂（默认 Claude SDK query）。 */
  queryFn?: QueryFactory;
}

/** 模型列表参数（model.list 入参）。 */
export interface ModelListOptions {
  /** 位置引用；省略时使用客户端 cwd 作为默认 location。 */
  location?: { directory?: string };
}

/** 含 supportedModels() 的 Query 结构子集（Claude SDK Query 满足此结构）。 */
interface ModelQuery extends QueryLike {
  supportedModels(): Promise<ModelInfo[]>;
}

const PROVIDER_ID = 'anthropic';

/**
 * 模型管理：惰性初始化并缓存控制 Query，包装 supportedModels() 为 opencode ModelListResponse。
 */
export class ModelManager {
  private readonly cwd: string;
  private readonly queryFn: QueryFactory;
  private controlQuery: ModelQuery | undefined;

  constructor(options: ModelManagerOptions) {
    this.cwd = options.cwd;
    this.queryFn = options.queryFn ?? query;
  }

  /** 获取可用模型列表，返回 { location, data }；首次调用惰性创建控制 Query。 */
  async list(options: ModelListOptions = {}): Promise<ModelListResponse> {
    const directory = options.location?.directory ?? this.cwd;
    const controlQuery = this.getControlQuery();
    const models = await controlQuery.supportedModels();
    return {
      location: {
        directory,
        project: { id: encodeProjectID(directory), directory },
      },
      data: models.map(mapModelInfo),
    };
  }

  /** 关闭缓存的控制 Query（客户端销毁时清理，终止底层 CLI 子进程）。 */
  close(): void {
    if (this.controlQuery !== undefined) {
      this.controlQuery.close();
      this.controlQuery = undefined;
    }
  }

  /** 惰性创建并缓存控制 Query（design.md D9：不 yield 用户消息、不产生对话轮次）。 */
  private getControlQuery(): ModelQuery {
    if (this.controlQuery === undefined) {
      // 真实 Claude SDK query() 返回的 Query 含 supportedModels()；测试注入的 Fake 亦提供，
      // 故断言收窄为 ModelQuery（仅补充 supportedModels 签名，运行时无额外约束）。
      this.controlQuery = this.queryFn({
        prompt: emptyPrompt(),
        options: { cwd: this.cwd },
      }) as ModelQuery;
    }
    return this.controlQuery;
  }
}

/** 永不产出的空异步生成器：控制 Query 不 yield 用户消息、不产生对话轮次（design.md D9）。 */
function emptyPrompt(): AsyncGenerator<SDKUserMessage> {
  return (async function* () {
    // 空生成器：永不产出。
  })();
}

/** ModelInfo → ModelV2Info：value→id、displayName→name、providerID 固定 'anthropic'、status 'active'。 */
function mapModelInfo(info: ModelInfo): ModelV2Info {
  const model: ModelV2Info = {
    id: info.value,
    providerID: PROVIDER_ID,
    name: info.displayName,
    status: 'active',
  };
  // resolvedModel（规范 wire id，如 'sonnet'→'claude-sonnet-5'）保留在 variants 供消费者使用。
  if (info.resolvedModel !== undefined) {
    model.variants = [{ id: info.resolvedModel, providerID: PROVIDER_ID }];
  }
  return model;
}

/** 由 cwd 编码生成 projectID（确定性：路径段 ASCII 保留，非 ASCII 按字节转 %XX，段以 - 连接）。 */
function encodeProjectID(directory: string): string {
  const separator = directory.includes('\\') ? '\\' : '/';
  const segments = directory.split(separator);
  const encoded: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    encoded.push(
      segment.replace(/[^A-Za-z0-9-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`),
    );
  }
  return encoded.join('-');
}
