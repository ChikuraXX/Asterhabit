import type { ModelConnection, ModelEntry } from "./api";

const MANAGED_CONNECTION_HANDLE = /^(model-connection-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(.+)$/i;

/** 判断句柄是否声明受管理连接身份；描述符缺失时也不能降级为旧来源。 */
export function isManagedConnectionHandle(handle: string): boolean {
  return MANAGED_CONNECTION_HANDLE.test(handle);
}

export type ModelBindingSource =
  | { kind: "inherited" }
  | { kind: "connection"; connection: ModelConnection; modelId: string }
  | { kind: "legacy"; provider: string; entry: ModelEntry }
  | { kind: "missing"; handle: string };

/** 合并手填与服务目录模型，保留顺序并移除同一连接内的重复项。 */
export function connectionModelIds(connection: ModelConnection): string[] {
  return [...new Set([...connection.manualModelIds, ...connection.catalogue.modelIds])];
}

/** 连接名称和地址都可重复，短ID始终保留同名连接的可见身份。 */
export function connectionOptionLabel(connection: ModelConnection): string {
  return `${connection.label} · ${connection.baseUrl} · ${connection.id.slice(-8)}`;
}

/** 保留当前旧档位用于展示，但只有目录公开的档位可以提交。 */
export function reasoningEffortOptions(
  entry: ModelEntry | null,
  currentEffort: string,
): Array<{ value: string; supported: boolean }> {
  const supported = entry?.reasoningEfforts ?? [];
  return [
    ...(!currentEffort || supported.includes(currentEffort) ? [] : [{ value: currentEffort, supported: false }]),
    ...supported.map((value) => ({ value, supported: true })),
  ];
}

export function reasoningEffortSupported(entry: ModelEntry | null, effort: string): boolean {
  return Boolean(entry?.reasoningEfforts.includes(effort));
}

/** 反思档位为空时继承对话档位；显式值始终优先。 */
export function effectiveReflectionReasoningEffort(dialogueEffort: string, reflectionEffort: string): string {
  return reflectionEffort || dialogueEffort;
}

/** 切换反思模型时保留继承空值；只有显式档位才按新模型归一化。 */
export function normalizedReflectionReasoningEffort(entry: ModelEntry | null, currentEffort: string): string {
  if (!currentEffort) return "";
  const efforts = entry?.reasoningEfforts ?? [];
  return efforts.includes(currentEffort) ? currentEffort : efforts[0] ?? "";
}

/** 只返回后端model.list实际登记、且满足模型槽推理合同的连接模型。 */
export function availableConnectionModels(
  connection: ModelConnection,
  models: ModelEntry[],
  requiredEffort?: string,
): Array<{ modelId: string; entry: ModelEntry }> {
  const configuredIds = connection.catalogue.status === "unavailable"
    ? [...new Set(connection.manualModelIds)]
    : connectionModelIds(connection);
  return configuredIds.flatMap((modelId) => {
    const handle = `${connection.id}/${modelId}`;
    const entry = models.find((candidate) => candidate.handle === handle);
    if (!entry || (requiredEffort && !entry.reasoningEfforts.includes(requiredEffort))) return [];
    return [{ modelId, entry }];
  });
}

/**
 * 按冻结合同解析完整模型句柄。托管连接只剥离精确连接ID前缀，
 * 因此模型ID中的斜杠会原样保留；旧句柄只接受模型目录中的精确匹配。
 */
export function resolveModelBindingSource(
  handle: string,
  connections: ModelConnection[],
  models: ModelEntry[],
  allowInherited = false,
): ModelBindingSource {
  if (!handle && allowInherited) return { kind: "inherited" };
  for (const connection of connections) {
    const prefix = `${connection.id}/`;
    if (handle.startsWith(prefix) && handle.length > prefix.length) {
      return { kind: "connection", connection, modelId: handle.slice(prefix.length) };
    }
  }
  // 受管理连接的保留前缀不能因描述符暂时缺失而降级成旧OAuth来源。
  if (isManagedConnectionHandle(handle)) return { kind: "missing", handle };
  const entry = models.find((candidate) => candidate.handle === handle);
  if (entry) return { kind: "legacy", provider: entry.provider, entry };
  return { kind: "missing", handle };
}

/** 旧模型按现有provider字段分组，仅用于展示，不推断或改写其句柄。 */
export function legacyModelProviders(connections: ModelConnection[], models: ModelEntry[]): string[] {
  const managedPrefixes = connections.map((connection) => `${connection.id}/`);
  return [...new Set(models
    .filter((entry) => !isManagedConnectionHandle(entry.handle)
      && !managedPrefixes.some((prefix) => entry.handle.startsWith(prefix)))
    .map((entry) => entry.provider))];
}

export interface SubscriptionModelSource {
  /** 原生认证提供方类型；只用于识别来源，不作为模型句柄。 */
  provider: "chatgpt_oauth";
  /** 完整句柄第一个斜杠前的原生渠道标识。 */
  channel: string;
  entries: ModelEntry[];
}

/**
 * 只按原生 provider metadata 和完整句柄识别当前已有授权的 Codex 来源。
 * 托管连接即使包含同名模型，也不能按模型 ID 误归到订阅来源。
 */
export function subscriptionModelSources(
  connections: ModelConnection[],
  models: ModelEntry[],
): SubscriptionModelSource[] {
  const managedPrefixes = connections.map((connection) => `${connection.id}/`);
  const sources = new Map<string, SubscriptionModelSource>();
  for (const entry of models) {
    if (entry.provider !== "chatgpt_oauth"
      || isManagedConnectionHandle(entry.handle)
      || managedPrefixes.some((prefix) => entry.handle.startsWith(prefix))) continue;
    const separator = entry.handle.indexOf("/");
    if (separator <= 0 || separator === entry.handle.length - 1) continue;
    const channel = entry.handle.slice(0, separator);
    const source = sources.get(channel) ?? { provider: "chatgpt_oauth", channel, entries: [] };
    source.entries.push(entry);
    sources.set(channel, source);
  }
  return [...sources.values()];
}

/** 返回当前选择是否可提交，以及主人可据此处理的具体状态。 */
export type ModelBindingStateCode = "inherited" | "legacy" | "missing" | "choose-source" | "disabled"
  | "credential-missing" | "model-required" | "model-not-configured" | "model-unavailable" | "unsupported-effort"
  | "pending-selection" | "catalogue-unavailable" | "manual-unverified" | "catalogue-listed";

export function modelBindingState(
  source: ModelBindingSource,
  models: ModelEntry[] = [],
  requiredEffort?: string,
): { valid: boolean; code: ModelBindingStateCode } {
  if (source.kind === "inherited") return { valid: true, code: "inherited" };
  if (source.kind === "legacy") return requiredEffort && !source.entry.reasoningEfforts.includes(requiredEffort)
    ? { valid: false, code: "unsupported-effort" }
    : { valid: true, code: "legacy" };
  if (source.kind === "missing") return {
    valid: false,
    code: source.handle ? "missing" : "choose-source",
  };
  if (!source.connection.enabled) return { valid: false, code: "disabled" };
  if (!source.connection.credentialConfigured) return { valid: false, code: "credential-missing" };
  if (!source.modelId.trim()) return { valid: false, code: "model-required" };
  const configuredManually = source.connection.manualModelIds.includes(source.modelId);
  if (source.connection.catalogue.status === "unavailable" && !configuredManually) {
    return { valid: false, code: "model-not-configured" };
  }
  const configured = connectionModelIds(source.connection).includes(source.modelId);
  if (!configured) return { valid: false, code: "model-not-configured" };
  const entry = models.find((candidate) => candidate.handle === `${source.connection.id}/${source.modelId}`);
  if (!entry) return { valid: false, code: "model-unavailable" };
  if (requiredEffort && !entry.reasoningEfforts.includes(requiredEffort)) return { valid: false, code: "unsupported-effort" };
  if (source.connection.catalogue.status === "unavailable") return {
    valid: true,
    code: "catalogue-unavailable",
  };
  if (!source.connection.catalogue.modelIds.includes(source.modelId)) return {
    valid: true,
    code: "manual-unverified",
  };
  return { valid: true, code: "catalogue-listed" };
}

