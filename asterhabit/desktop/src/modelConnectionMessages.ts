import { uiLocale } from "./i18n";
import failureContract from "../../shared/generation-failure-contract.json";
import type { GenerationFailureReason } from "./api";

/** 登录同步只显示共享合同中的固定原因，未知响应不作为文案回显。 */
export function modelAuthenticationText(reason: GenerationFailureReason): string {
  return (Object.hasOwn(failureContract.reasons, reason) ? failureContract.reasons[reason] : failureContract.reasons.authentication_sync_failed)[uiLocale.value];
}
import { ModelConnectionRequestError } from "./api";

/** 模型设置复用应用级语言，不另存第二份偏好。 */
export const modelSettingsLocale = uiLocale;
const zh = {
  codexOnly: "当前使用 Codex，API 连接暂不可用。",
  resumeCreate: "返回创建 Agent", dirtyHint: "请先保存或取消当前编辑，再切换连接或执行检测。",
  title: "模型服务", add: "新增连接", reload: "重新读取", empty: "尚未添加 API 连接。", connectionScope: "保存连接只会让它可供 Agent 选择，不会自动更改任何 Agent 的模型；后续任务使用各 Agent 已保存的绑定。", label: "连接名称", preset: "服务预设", address: "API 基础地址", key: "API Key", keepKey: "新 API Key（留空保留原钥）", enabled: "启用连接", manual: "手填模型 ID（每行一个）", save: "保存连接", saving: "处理中…", test: "检测连接", refresh: "刷新模型目录", remove: "删除连接", cancel: "取消", ready: "目录可用", unavailable: "目录不可用", unverified: "未验证", disabled: "已停用", configured: "已配置密钥", noKey: "未配置密钥", catalogueNote: "目录检测不验证模型生成。手填模型保持未验证状态。", addressHint: "填写基础地址；路径处理沿用服务协议。", saved: "连接已保存", tested: "目录检测完成，未调用模型生成", refreshed: "模型目录已刷新", removed: "连接已删除", inUse: "连接仍被以下 Agent 引用，请先修改对应模型槽。", confirmDelete: "确认删除此连接？", catalogue: "目录模型", dialogue: "日常对话", extract: "记忆提取", reflection: "自主反思", close: "关闭", language: "界面语言", manage: "管理模型服务", choose: "请选择", invalid: "请填写名称、基础地址和有效密钥。", conflict: "连接已被修改。请重新读取后再保存，当前输入已保留。", busy: "模型任务或清理正在进行，请稍后重试。", auth: "服务拒绝认证，请检查密钥。", timeout: "服务响应超时，请稍后重试。", offline: "暂时无法连接服务，请检查地址和服务状态。", notFound: "连接已不存在，请重新读取。", cancelled: "操作已取消，请重新读取当前状态。", generic: "模型服务操作失败，请重新读取后重试。", invalidRequest: "配置无效，请检查地址、模型 ID 和必填项。",
  authorizationTitle: "当前已有授权", authorizationName: "Codex（已有授权）", authorizationHint: "可在 Agent 的模型设置中选择以下已有授权模型。", authorizationChannel: "授权渠道", authorizationModels: "当前可选择的模型", authorizationEmpty: "未发现可用的现有 Codex 授权模型。", authorizationLoadError: "暂时无法读取已有授权模型，请重新读取。",
};
const en: Record<keyof typeof zh, string> = {
  codexOnly: "Codex is active. API connections are currently unavailable.",
  resumeCreate: "Return to agent creation", dirtyHint: "Save or cancel your edits before switching connections or running a check.",
  title: "Model services", add: "Add connection", reload: "Reload", empty: "No API connections added.", connectionScope: "Saving a connection only makes it available for Agents to select. It does not change any Agent automatically; subsequent tasks use each Agent's saved binding.", label: "Connection name", preset: "Service preset", address: "API base URL", key: "API key", keepKey: "New API key (blank keeps current key)", enabled: "Enable connection", manual: "Manual model IDs (one per line)", save: "Save connection", saving: "Working…", test: "Test connection", refresh: "Refresh catalogue", remove: "Delete connection", cancel: "Cancel", ready: "Catalogue available", unavailable: "Catalogue unavailable", unverified: "Unverified", disabled: "Disabled", configured: "Key configured", noKey: "Key missing", catalogueNote: "Catalogue checks do not verify generation. Manual models remain unverified.", addressHint: "Enter the API base URL; protocol rules handle the path.", saved: "Connection saved", tested: "Catalogue checked; no generation requested", refreshed: "Catalogue refreshed", removed: "Connection deleted", inUse: "This connection is referenced by the following agents. Change their model slots first.", confirmDelete: "Delete this connection?", catalogue: "Catalogue models", dialogue: "Dialogue", extract: "Memory extraction", reflection: "Reflection", close: "Close", language: "Interface language", manage: "Manage model services", choose: "Select", invalid: "Enter a name, base URL and valid API key.", conflict: "The connection changed. Reload before saving; your input has been preserved.", busy: "A model task or cleanup is active. Try again shortly.", auth: "Authentication failed. Check the API key.", timeout: "The service timed out. Try again shortly.", offline: "Service unavailable. Check its URL and status.", notFound: "Connection no longer exists. Reload the list.", cancelled: "Operation cancelled. Reload the current state.", generic: "Model service request failed. Reload and try again.", invalidRequest: "Invalid configuration. Check the URL, model IDs and required fields.",
  authorizationTitle: "Current authorization", authorizationName: "Codex (existing authorization)", authorizationHint: "Select the authorized models below in the Agent's model settings.", authorizationChannel: "Authorization channel", authorizationModels: "Currently selectable models", authorizationEmpty: "No models from an existing Codex authorization are available.", authorizationLoadError: "Existing authorized models are temporarily unavailable. Reload to try again.",
};
/** 按当前模型设置语言读取集中维护的文案。 */
export function modelText(key: keyof typeof zh): string { return (modelSettingsLocale.value === "en" ? en : zh)[key]; }
/** 已显示的瞬时错误与结果也随应用语言切换，且不处理任何用户内容。 */
export function modelMessage(source: string): string {
  const target = modelSettingsLocale.value === "en" ? en : zh;
  const counterpart = modelSettingsLocale.value === "en" ? zh : en;
  const found = Object.entries(counterpart).find(([, value]) => value === source);
  return found ? Object.entries(target).find(([key]) => key === found[0])?.[1] ?? source : source;
}
/** 只翻译稳定错误码，不显示可能含秘密的原始异常正文。 */
export function modelErrorMessage(error: unknown): string {
  const code = error instanceof ModelConnectionRequestError ? error.code : "";
  switch (code) {
    case "CONFLICT": return modelText("conflict");
    case "BUSY": case "NOT_READY": case "CLOSING": return modelText("busy");
    case "AUTH_FAILED": return modelText("auth");
    case "TIMEOUT": return modelText("timeout");
    case "UNAVAILABLE": case "CATALOGUE_UNAVAILABLE": return modelText("offline");
    case "NOT_FOUND": return modelText("notFound");
    case "CANCELLED": return modelText("cancelled");
    case "INVALID_REQUEST": return modelText("invalidRequest");
    default: return modelText("generic");
  }
}
