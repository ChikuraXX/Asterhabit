import { invoke } from "@tauri-apps/api/core";
import roleContract from "../../shared/agent-role-contract.json";
import generationFailureContract from "../../shared/generation-failure-contract.json";
import dailyBudgetContract from "../../shared/daily-budget-contract.json";
/** 与后台共用的日常预算上限，单位为业务阶段或操作次数。 */
export const DAILY_BUDGET = dailyBudgetContract;
/** 与宿主共享的固定失败原因；不包含原始错误、凭据或模型正文。 */
export type GenerationFailureReason = keyof typeof generationFailureContract.reasons;

/** 桌面联系人；标识由宿主固定分配，界面仅用于选择。 */
export interface Contact {
  id: string;
  label: string;
}

/** 沙箱中允许提案的固定动作类别。 */
export type ActionKind = "read_post" | "draft_reply" | "submit_reply";

/** 主人授予合成账号的限时、限额动作权限。 */
export interface Grant {
  id: string;
  account: "sandbox";
  target: string;
  action: ActionKind;
  /** 当前窗口内最多允许执行的次数。 */
  limit: number;
  /** 滚动额度窗口，单位为秒。 */
  windowSeconds: number;
  /** ISO 8601 到期时间。 */
  expiresAt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 一条合成动作提案及其执行结果。 */
export interface Action {
  id: string;
  idempotencyKey: string;
  account: string;
  target: string;
  action: ActionKind;
  content: string;
  status: "queued" | "succeeded" | "denied" | "cancelled";
  reason: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 权限和模拟执行的可见审计摘要。 */
export interface Audit {
  id: string;
  createdAt: string;
  event: string;
  actionId: string | null;
  details: string;
}

/** 主人控制状态；revision 用于避免覆盖并发权限修改。 */
export interface ControlSnapshot {
  paused: boolean;
  revision: number;
  grants: Grant[];
  actions: Action[];
  audit: Audit[];
}

/** 由可信记忆仓库返回的一条原始来源记录。 */
export interface MemoryRecord {
  id: string;
  sourceId: string;
  subjectKey: string;
  kind: string;
  topic: string;
  text: string;
  evidence: string;
  origin: "user" | "external";
  sourceRef: string;
  classification: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  /** 当前记忆版本是否已经明确授权为角色成长来源。 */
  growthAuthorized: boolean;
  /** Unix 毫秒时间戳。 */
  createdAt: number;
  /** Unix 毫秒时间戳。 */
  updatedAt: number;
}

/** Graphify 派生索引的非敏感状态。 */
export interface MemoryIndexStatus {
  version: number;
  revision?: number;
  nodes?: number;
  error?: string;
  manualPending?: number;
}

/** 原始记忆与派生索引的同步进度。 */
export interface MemoryStatus {
  revision: number;
  indexedRevision: number;
  indexError: string | null;
  index: MemoryIndexStatus | null;
  dirty: boolean;
}

/** 桌面运行时的最小可见状态，不含凭据和路径。 */
export interface AppSnapshot {
  /** 宿主自动同步的脱敏状态；不返回源路径、身份或令牌。时间为ISO字符串。 */
  modelAuthentication?: {
    state: "unmanaged" | "ready" | "pending" | "stopped";
    code: GenerationFailureReason | null;
    expiresAt: string | null;
    lastSyncedAt: string | null;
  };
  runtime: {
    connected: boolean;
    model: string;
    paused: boolean;
    busy: boolean;
    busyContactId: string | null;
    taskId: string | null;
    /** 当前 Agent 各联系人真实历史内容的宿主版本。 */
    historyRevisions?: Record<string, string>;
  };
  contacts: Contact[];
  control: ControlSnapshot;
  agent: AgentProfile;
  agents: AgentProfile[];
  application: ApplicationSnapshot;
}

/** 创建与编辑共用的角色字段；空字符串表示未设置，不使用null。 */
export interface RoleConfigurationFields {
  /** 角色性格，与基础人格正文独立。 */
  personality: string;
  /** 面向用户的表达偏好。 */
  expressionStyle: string;
  /** 默认回复语言自由文本；空字符串表示跟随对话。 */
  replyLanguage: string;
  /** 独立自然语言红线，不授予工具或社交权限。 */
  contentBoundaries: string;
}
/** 与现有profile后端校验一致的UTF-16字符串长度上限。 */
export const ROLE_FIELD_LIMITS = Object.freeze(roleContract.limits);

/** 可移动角色配置仅包含设定；版本不包含模型、权限或运行身份。 */
export interface RoleTransferConfiguration extends RoleConfigurationFields {
  schemaVersion: 1;
  name: string;
  nickname: string;
  persona: string;
}
/** 中性模板是可编辑的创建起点，标签遵循本机界面语言。 */
export interface RoleTemplate {
  id: string;
  label: { "zh-CN": string; en: string };
  configuration: RoleTransferConfiguration;
}

/** 读取旧资料中的可选角色字段；缺省为空，不处理或翻译用户正文。 */
export function roleConfigurationOf(profile: Partial<RoleConfigurationFields> = {}): RoleConfigurationFields {
  return {
    personality: profile.personality ?? "",
    expressionStyle: profile.expressionStyle ?? "",
    replyLanguage: profile.replyLanguage ?? "",
    contentBoundaries: profile.contentBoundaries ?? "",
  };
}

/** 主人可见的 Agent 配置；不含凭据、路径或底层存储映射。 */
export interface AgentProfile {
  id: string;
  name: string;
  nickname: string;
  persona: string;
  /** 独立性格设定，最多8000字符；旧资料缺省为空。 */
  personality?: string;
  /** 表达偏好，最多4000字符，不改写基础人格。 */
  expressionStyle?: string;
  /** 默认回复语言自由文本，最多1000字符，与界面语言无关。 */
  replyLanguage?: string;
  /** 独立内容红线，最多8000字符，不授予或替代硬权限。 */
  contentBoundaries?: string;
  profileRevision: number;
  archived: boolean;
  paused: boolean;
  model: string;
  dialogueModel: string;
  dialogueReasoningEffort: string;
  /** null 表示跟随对话模型。 */
  reflectionModel: string | null;
  /** null 表示跟随对话推理档位。 */
  reflectionReasoningEffort: string | null;
  /** 当前 Agent 尚未阅读的主动消息数。 */
  unreadCount: number;
}

/** 应用级运行状态与反思总预算。 */
export interface ApplicationSnapshot {
  /** 常驻仅由主人显式开启；关闭窗口与完全退出使用不同操作。 */
  keepRunningOnClose?: boolean;
  /** 滚动24小时业务模型阶段总额；null为未设置，0为禁止。 */
  dailyModelCallLimit?: number | null;
  dialogueDailyCallLimit?: number | null;
  budgets?: Record<"total" | "dialogue" | "background" | "reflection" | "proactiveMessages", { limit: number | null; used: number; remaining: number | null; nextAvailableAt: number | null }>;
  revision: number;
  paused: boolean;
  reflectionDailyCallLimit: number;
  /** 所有后台模型任务共享的 24 小时调用额度。 */
  backgroundDailyCallLimit: number;
  /** 所有 Agent 共享的 24 小时主动消息额度。 */
  proactiveDailyMessageLimit: number;
  minGapSeconds: number;
  busy: boolean;
  active: { agentId: string; taskId: string; contactId?: string | null; kind: string } | null;
}

export interface ModelEntry {
  handle: string;
  label: string;
  provider: string;
  reasoningEfforts: string[];
}

export interface GrowthSettings {
  growthRevision: number;
  enabled: boolean;
  dailyCallLimit: number;
  minGapSeconds: number;
  idleSeconds: number;
}

export interface ReflectionStatus {
  enabled: boolean;
  dailyCallLimit: number;
  usedCalls24h: number;
  minGapSeconds: number;
  idleSeconds: number;
  lastRunAt: number | null;
  nextEligibleAt: number | null;
  pendingScopes: number;
  pendingEvents: number;
  activeRuns: number;
}

export interface GrowthSource {
  id: string;
  origin: "user" | "external";
  excerpt: string;
  status: "queued" | "claimed" | "consumed" | "cancelled" | "invalidated";
  createdAt: number;
  memoryId: string | null;
  memoryRevision: number | null;
  /** 是否允许主人按当前来源版本显式重新排队。 */
  requeueable: boolean;
}

export interface CharacterState {
  id: string;
  kind: "interest" | "preference" | "opinion" | "question";
  topic: string;
  statement: string;
  briefReason: string;
  status: "tentative" | "established" | "retired" | "open" | "resolved" | "dismissed";
  revision: number;
  sourceIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentConfigurationInput {
  name: string;
  nickname: string;
  persona: string;
  /** 新增字段省略时保留旧值，显式空字符串清除；创建省略为空。 */
  personality?: string;
  /** 表达偏好，最多4000字符；省略保留，空字符串清除。 */
  expressionStyle?: string;
  /** 自由语言偏好，最多1000字符；本轮明确语言要求优先。 */
  replyLanguage?: string;
  /** 自然语言内容边界，最多8000字符；不改变平台或工具授权。 */
  contentBoundaries?: string;
  model: string;
  dialogueModel: string;
  dialogueReasoningEffort: string;
  reflectionModel: string | null;
  reflectionReasoningEffort: string | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** 用户消息的内容来源；旧记录未标注来源时为 unknown。 */
  origin?: "user" | "external" | "unknown";
  /** 主动消息标识；仅 assistant 主动发起的消息具有此字段。 */
  proactiveId?: string;
}

/** 单个 Agent 的主动联系权限与额度策略。 */
export interface ProactiveSettings {
  revision: number;
  enabled: boolean;
  dailyMessageLimit: number;
  dailyCallLimit: number;
  minGapSeconds: number;
  idleSeconds: number;
  timeZone: string;
  windowStartMinute: number;
  windowEndMinute: number;
}

/** 单个 Agent 的主动联系运行摘要。 */
export interface ProactiveStatus {
  unreadCount: number;
  pendingPlans: number;
  usedMessages24h: number;
  usedCalls24h: number;
  lastMessageAt: number | null;
  nextEligibleAt: number | null;
}

/** 已验证的本地 B 站账号摘要，不包含任何凭据。 */
export interface BilibiliAccount {
  id: string;
  label: string;
}

/** 当前 Agent 的 B 站网络硬额度。 */
export interface BilibiliNetworkStatus {
  limit: number;
  used: number;
  remaining: number;
  /** Unix 毫秒时间戳；null 表示当前没有平台退避。 */
  blockedUntil: number | null;
}

/** 本地 B 站绑定状态；凭据只在 Windows 当前用户范围保存。 */
export interface BilibiliAccountStatus {
  revision: number;
  account: BilibiliAccount | null;
  storage: "windows-user" | "unavailable";
  network: BilibiliNetworkStatus;
}

/** 绑定时提交的短暂凭据；调用者必须在请求结束后立即清空。 */
export interface BilibiliBindInput {
  agentId: string;
  expectedRevision: number;
  sessdata: string;
  buvid3: string;
}

/** B 站只读验证返回的有限材料。 */
export interface BilibiliMaterial {
  id: string;
  kind: "description" | "subtitle";
  text: string;
  startSeconds?: number;
  endSeconds?: number;
}

/** 单个 BV 的只读验证结果；覆盖值只代表实际取回的有限材料。 */
export interface BilibiliVerifyResult {
  bvid: string;
  title: string;
  creatorId: string;
  creatorName: string;
  durationSeconds: number;
  url: string;
  coverage: {
    description: number;
    subtitle: number;
    comment: 0;
  };
  materials: BilibiliMaterial[];
  requestsUsed: number;
  subtitleStatus: "available" | "missing";
}

/** 当前 Agent 的内容读取、模型解释和浏览学习策略。 */
export interface ContentSettings {
  revision: number;
  readEnabled: boolean;
  allowLearning: boolean;
  publishEnabled: false;
  keywords: string[];
  creatorIds: string[];
  dailyReadLimit: number;
  dailyModelLimit: number;
  dailySessionLimit: number;
  minGapSeconds: number;
  idleSeconds: number;
  accountId: string | null;
}

/** 完整替换内容策略的 CAS 载荷；发布能力固定关闭。 */
export interface ContentConfigurationInput {
  agentId: string;
  expectedRevision: number;
  readEnabled: boolean;
  allowLearning: boolean;
  publishEnabled: false;
  keywords: string[];
  creatorIds: string[];
  dailyReadLimit: number;
  dailyModelLimit: number;
  dailySessionLimit: number;
  minGapSeconds: number;
  idleSeconds: number;
}

/** 本地推荐反馈的明确目标层级；不修改平台权限。 */
export type ContentFeedbackScope = "content" | "creator";
/** null 表示撤销该层级反馈。 */
export type ContentFeedbackValue = "like" | "less" | "block" | null;
/** 观察列表摘要；覆盖数是实际材料条数，不是观看完成率。 */
export interface ContentObservation {
  id: string;
  revision: number;
  bvid: string;
  creatorId: string;
  title: string;
  url: string;
  coverage: { description: number; subtitle: number; comment: number };
  summary: string;
  viewpoint: string;
  share: boolean;
  status: "active" | "expired" | "forgotten";
  /** 创建与到期时间，Unix 毫秒。 */
  createdAt: number;
  expiresAt: number;
  learned: boolean;
  feedback: Record<ContentFeedbackScope, ContentFeedbackValue>;
  feedbackRevision: number;
}
/** 详情附带实际读取材料；摘要与观点均是模型生成，材料保留来源文本。 */
export interface ContentObservationDetail extends ContentObservation {
  materials: Array<Omit<BilibiliMaterial, "kind"> & { kind: "description" | "subtitle" | "comment" }>;
}
/** 同时核对观察和当前账号反馈代次，避免迟到修改覆盖新反馈。 */
export interface ContentFeedbackInput {
  agentId: string;
  id: string;
  expectedRevision: number;
  expectedFeedbackRevision: number;
  scope: ContentFeedbackScope;
  value: ContentFeedbackValue;
}

/** 当前 Agent 的官方 QQ 机器人连接摘要；不包含 AppSecret。 */
/** OneBot私聊目标级主动授权；时段起止相同表示全天，默认关闭。 */
export interface QQContactPolicy { /** 默认关闭的后台待审计划生成。 */ autoPlanEnabled?:boolean; /** 滚动24小时自动模型阶段上限。 */ dailyPlanLimit?:number; targetId: string; revision: number; enabled: boolean; dailyLimit: number; minGapSeconds: number; quietSeconds: number; timeZone: string; windowStartMinute: number; windowEndMinute: number; planTtlMinutes: number }
/** 主动授权采用CAS更新，QQ号保持字符串。 */
export interface QQContactConfiguration extends Omit<QQContactPolicy,"revision"> { agentId: string; expectedRevision: number }
/** 目标和来源不可编辑，确认摘要绑定当前修订及全文。 */
export interface QQContactPlan { id: string; revision: number; status: "pending"|"sending"|"sent"|"failed"|"unknown"|"invalidated"|"expired"|"cancelled"; target: {kind:"private";id:string}; selfId:string; reason:string; text:string; source:{id:string;text:string}; createdAt:number; dueAt:number; expiresAt:number; confirmationHash:string|null; remoteMessageId:string|null }

/** 业务阶段计时只含毫秒和本地关联标识，缺失或跨实例为null。 */
export interface QQReplyLatency {
 runId:string;eventId:string;draftId:string|null;mode:"manual"|"automatic";outcome:string;timestamps:Record<string,number>;cooldownRemainingAtQueueMs:number|null;
 modelStagesMs:Record<"extract"|"draft"|"group",{preflight:number|null;nativeCreate:number|null;firstText:number|null;stream:number|null;cleanup:number|null}>;
 durationMs:{receivedToQueue:number|null;receivedToGenerationRequest:number|null;queueToGenerationRequest:number|null;requestToGenerationStart:number|null;generation:number|null;receivedToDraft:number|null};
 sends:Array<{attemptId:string;mode:"manual"|"automatic";outcome:string;timestamps:Record<string,number>;durationMs:{draftToSendRequest:number|null;requestToPrepared:number|null;preparedToDispatch:number|null;dispatchToResult:number|null;receivedToResult:number|null}}>;
}
export interface QQConnectionStatus {
  /** OneBot连接额外返回协议和无凭据地址；旧官方连接省略。 */
  transport?: "onebot";
  endpoint?: string;
  revision: number;
  appId: string | null;
  selfId: string | null;
  label: string | null;
  storage: "windows-user" | "unavailable";
  listener: { state: "stopped" | "connecting" | "reconnecting" | "listening" | "error"; errorCode: string | null };
  pairing: { expiresAt: number } | null;
}

/** 绑定官方 QQ 机器人时提交的短暂凭据。 */
/** OneBot短暂绑定凭据，账号必须保持字符串。 */
export interface OneBotBindInput { agentId: string; expectedRevision: number; endpoint: string; accountId: string; accessToken: string }

export interface QQBindInput {
  agentId: string;
  expectedRevision: number;
  appId: string;
  appSecret: string;
}

/** 当前 Agent 的 QQ 白名单接收策略；发送与主动联系固定关闭。 */
export interface QQSettings {
  revision: number;
  receiveEnabled: boolean;
  sendEnabled: false;
  proactiveEnabled: false;
  allowedUserIds: string[];
  /** 当前Agent/绑定账号下的用户本地备注，最多100字符；不作为平台昵称或授权身份。旧响应省略时视为空。 */
  userRemarks?: Record<string, string>;
  allowedGroupIds: string[];
  groupMentionsOnly: boolean;
  /** OneBot点名后接话条数0—50；0关闭。 */
  groupFollowupMessages?: number;
  /** 同群接话时限，单位秒，0—600；0关闭。 */
  groupFollowupSeconds?: number;
}

/** 白名单展示资料；name缺失保持null，不把OpenID或统一账号推断成普通号码。 */
export interface QQTargetInfo {
  kind: "group" | "user";
  openid: string;
  name: string | null;
  source: "platform" | "message" | "unavailable";
}
/** QQ平台返回的群接收设置；不代表本地白名单/自动回复授权，checkedAt为Unix毫秒。 */
export interface QQGroupState {
  openid: string;
  receiveMode: "all" | "only_mention" | "mention_and_context" | "unknown";
  /** 平台模式标识；未知枚举不推断为全量权限，不符合安全显示格式时为null。 */
  reportedMode: string | null;
  checkedAt: number;
}

/** 完整替换QQ接收策略的CAS载荷；userRemarks省略时保留仍授权条目的备注，空对象清除全部备注。 */
export interface QQConfigurationInput extends Omit<QQSettings, "revision"> {
  agentId: string;
  expectedRevision: number;
}

/** QQ 回复草稿、手动发送与自动回复权限；主动发送始终关闭。 */
export interface QQReplySettings {
  revision: number;
  enabled: boolean;
  manualSendEnabled: boolean;
  autoReplyEnabled: boolean;
  proactiveEnabled: false;
  /** 当前 Agent 的 QQ 滚动24小时业务模型阶段额度（提取、草稿分别预留），不是 provider 请求计数；换绑不重置。 */
  dailyModelLimit: number;
  /** 当前 Agent 的 QQ 滚动24小时发送尝试额度，包含失败及结果未知的预留。 */
  dailySendLimit: number;
  /** 此 Agent 的所有 QQ 目标共享的发送尝试最小间隔，单位秒。 */
  minSendGapSeconds: number;
}

/** 完整替换 QQ 回复策略的 CAS 载荷。 */
export interface QQReplyConfigurationInput extends Omit<QQReplySettings, "revision"> {
  agentId: string;
  expectedRevision: number;
}

/** 当前 Agent 的 QQ 滚动24小时预算使用量；业务阶段预留不等同实际 provider 请求。 */
export interface QQReplyStatus {
  usedModelCalls24h: number;
  usedSends24h: number;
}

export type QQDraftStatus = "ready" | "sending" | "sent" | "failed" | "unknown" | "cancelled" | "expired";

/** 由收件生成且只在主人逐条确认后发送的本地 QQ 草稿。 */
export interface QQDraft {
  id: string;
  eventId: string;
  revision: number;
  status: QQDraftStatus;
  text: string;
  target: { kind: "private" | "group"; id: string };
  senderId: string;
  selfId: string;
  sourceText: string;
  learn: boolean;
  /** Unix 毫秒时间戳。 */
  createdAt: number;
  /** Unix 毫秒时间戳。 */
  expiresAt: number;
  confirmationHash: string | null;
  remoteMessageId: string | null;
  learningError: string | null;
}

/** QQ开放平台返回的单次发送回执；缺失字段保持 null，不推断接收方状态。 */
export interface QQSendReceipt {
  httpStatus: number | null;
  platformCode: number | string | null;
  messageId: string | null;
  timestamp: string | null;
  traceId: string | null;
}

/** 一次独立发送尝试；submittedText 是实际提交给平台的正文。 */
export interface QQSendAttempt {
  id: string;
  /** Unix 毫秒时间戳。 */
  createdAt: number;
  /** Unix 毫秒时间戳；null 表示尚未提交。 */
  submittedAt: number | null;
  submittedText: string | null;
  outcome: "prepared" | "dispatched" | "sent" | "failed" | "unknown";
  receipt: QQSendReceipt | null;
  errorCode: string | null;
}

/** 独立于短期收件和草稿过期策略的持久 QQ 发送记录。 */
export interface QQSendRecord {
  id: string;
  draftId: string;
  selfId: string;
  target: { kind: "private" | "group"; id: string };
  /** Unix 毫秒时间戳。 */
  createdAt: number;
  /** 模型最初输出；旧数据无法恢复时为 null。 */
  originalText: string | null;
  attempts: QQSendAttempt[];
}

/** 兼容诊断接收窗口的统计；日常持续接收由宿主维护，接收过程不调用模型。 */
export interface QQReceiveResult {
  received: number;
  ignored: number;
  durationSeconds: 30;
}

/** 当前已绑定 QQ 账号的短期文字收件。 */
export interface QQMessageEntry {
  id: string;
  messageId: string;
  kind: "private" | "group";
  senderId: string;
  groupId: string | null;
  text: string;
  /** Unix 毫秒时间戳。 */
  receivedAt: number;
  /** 仅在宿主已完成本条群消息的静默决策时出现，不推断未读或平台送达状态。 */
  automaticDecision?: "quiet";
  /** 最新回复生成状态，来自持久化运行；缺省不推断成功、失败或静默。 */
  replyGeneration?:
    | { status: "generating"; reason: null; finishedAt: null }
    | { status: "failed" | "cancelled"; reason: GenerationFailureReason; finishedAt: number | null };
}

/** 尚未完成或已终结的主动计划摘要。 */
export interface ProactivePlan {
  id: string;
  topic: string;
  purpose: string;
  completionCriterion: string;
  dueAt: number;
  expiresAt: number;
  status: "pending" | "claimed" | "sent" | "skipped" | "cancelled" | "expired" | "withdrawn";
  deferCount: number;
  createdAt: number;
}

/** 应用内主动消息及其阅读状态。 */
export interface ProactiveInboxEntry {
  id: string;
  planId: string | null;
  text: string;
  createdAt: number;
  readAt: number | null;
  status: "delivered" | "read" | "withdrawn";
}

/** 修改主动联系设置时必须完整提交的 CAS 载荷。 */
export interface ProactiveConfigurationInput extends Omit<ProactiveSettings, "revision"> {
  agentId: string;
  expectedRevision: number;
}

export interface ChatReply {
  text: string;
  /** 本轮成功写入的记忆条数。 */
  learned: number;
  /** 回合已提交，但后续记忆变化使旧回复不再展示。 */
  superseded?: boolean;
  /** 模型安全拒答：不显示、不存储任何本轮对话正文。 */
  suppressed?: boolean;
  learningError: string | null;
  index: {
    status: "unavailable" | "ready" | "stale" | "error" | "cleanup-pending" | "skipped";
    revision?: number;
  };
}

/** 保存授权时由宿主补齐标识和审计时间。 */
export interface GrantInput {
  id?: string;
  account: "sandbox";
  target: string;
  action: ActionKind;
  limit: number;
  windowSeconds: number;
  expiresAt: string;
  enabled: boolean;
}

/** 主人应用级模型连接；描述符不含密钥或凭据存储路径。 */
export interface ModelConnection {
  id: string;
  label: string;
  providerKind: "openai" | "deepseek" | "openai-compatible";
  protocol: "openai-compatible";
  baseUrl: string;
  revision: number;
  enabled: boolean;
  credentialConfigured: boolean;
  manualModelIds: string[];
  catalogue: { status: "unverified" | "ready" | "unavailable"; modelIds: string[]; errorCode: string | null };
}
/** 同名模型以连接ID区分；不按品牌隐式迁移。 */
export interface ModelBinding { connectionId: string; modelId: string }
/** 未验证的可选能力保持null，不按品牌推断。 */
export interface ModelCapabilities { chat: boolean | null; streaming: boolean | null; structuredOutput: boolean | null; vision: boolean | null; reasoning: boolean | null }
/** 创建修订为0；更新省略apiKey表示保留原钥，空字符串无效。 */
export interface ModelConnectionInput {
  id?: string;
  expectedRevision: number;
  label: string;
  providerKind: ModelConnection["providerKind"];
  baseUrl: string;
  enabled: boolean;
  manualModelIds: string[];
  apiKey?: string;
}
/** 模型连接错误的稳定业务码，供后续界面映射译文。 */
export class ModelConnectionRequestError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ModelConnectionRequestError"; }
}

/** 所有允许通过 desktop_request 发送的强类型业务操作。 */
export interface DesktopOperations {
  "agent.profile.templates": { payload: Record<string, never>; result: { templates: RoleTemplate[] } };
  "agent.profile.importFile": { payload: Record<string, never>; result: { cancelled: true } | { cancelled: false; configuration: RoleTransferConfiguration } };
  "agent.profile.exportFile": { payload: { agentId: string }; result: { cancelled: boolean } };
  "model.connection.list": { payload: Record<string, never>; result: { connections: ModelConnection[]; available?: boolean } };
  "model.connection.save": { payload: ModelConnectionInput; result: { connection: ModelConnection } };
  "model.connection.test": { payload: { id: string; expectedRevision: number }; result: { connection: ModelConnection } };
  "model.connection.remove": { payload: { id: string; expectedRevision: number }; result: { removed: true } | { removed: false; references: { agentId: string; slot: "dialogue" | "extract" | "reflection" }[]; errorCode: "MODEL_CONNECTION_IN_USE" } };
  "model.catalogue.refresh": { payload: { id: string; expectedRevision: number }; result: { connection: ModelConnection } };
  "app.snapshot": { payload: { agentId?: string }; result: AppSnapshot };
  "agent.create": { payload: AgentConfigurationInput; result: { agent: AgentProfile } };
  "agent.update": { payload: AgentConfigurationInput & { agentId: string; expectedRevision: number }; result: { agent: AgentProfile } };
  "agent.archive": { payload: { agentId: string; expectedRevision: number; archived: boolean }; result: { agent: AgentProfile } };
  "agent.pause": { payload: { agentId: string; expectedRevision: number; paused: boolean }; result: { agent: AgentProfile } };
  "model.list": { payload: Record<string, never>; result: { entries: ModelEntry[] } };
  "application.configure": { payload: { expectedRevision: number; reflectionDailyCallLimit: number; minGapSeconds: number; backgroundDailyCallLimit?: number; proactiveDailyMessageLimit?: number; dailyModelCallLimit?: number | null; dialogueDailyCallLimit?: number | null; keepRunningOnClose?: boolean }; result: { application: ApplicationSnapshot } };
  "application.quit": { payload: Record<string, never>; result: { closed: boolean } };
  "app.activity": { payload: Record<string, never>; result: { recorded: true } };
  "chat.history": { payload: { agentId: string; contactId: string }; result: { messages: ChatMessage[] } };
  "chat.send": {
    payload: { agentId: string; contactId: string; text: string; learn: boolean };
    result: ChatReply;
  };
  "chat.cancel": { payload: { agentId: string; taskId: string }; result: { cancelled: boolean } };
  "memory.list": {
    payload: { agentId: string; contactId: string; query?: string };
    result: { records: MemoryRecord[]; status: MemoryStatus };
  };
  "memory.save": {
    payload: { agentId: string; contactId: string; topic: string; text: string };
    result: { record: MemoryRecord; status: MemoryStatus };
  };
  "memory.correct": {
    payload: { agentId: string; contactId: string; id: string; text: string };
    result: { record: MemoryRecord; status: MemoryStatus };
  };
  "memory.forget": {
    payload: { agentId: string; contactId: string; id: string };
    result: { forgotten: true; status: MemoryStatus };
  };
  "memory.sync": {
    payload: { agentId: string; contactId: string };
    result: { status: MemoryStatus };
  };
  "memory.recover": { payload: { agentId: string; contactId: string }; result: { recovered: true } };
  "permissions.save": {
    payload: { agentId: string; expectedRevision: number; grant: GrantInput };
    result: { grant: Grant };
  };
  "permissions.revoke": {
    payload: { agentId: string; id: string; expectedRevision: number };
    result: { revoked: true };
  };
  "runtime.pause": { payload: { paused: boolean }; result: { application: ApplicationSnapshot } };
  "simulation.submit": {
    payload: {
      agentId: string;
      idempotencyKey: string;
      account: "sandbox";
      target: string;
      action: ActionKind;
      content: string;
    };
    result: { action: Action };
  };
  "simulation.execute": { payload: { agentId: string; id: string }; result: { action: Action } };
  "simulation.cancel": { payload: { agentId: string; id: string }; result: { action: Action } };
  "audit.list": { payload: { agentId: string }; result: { audit: Audit[] } };
  "growth.get": { payload: { agentId: string }; result: { growth: GrowthSettings; reflection: ReflectionStatus } };
  "growth.configure": { payload: { agentId: string; expectedRevision: number; enabled: boolean; dailyCallLimit: number; minGapSeconds: number; idleSeconds: number }; result: { growth: GrowthSettings } };
  "growth.sources.list": { payload: { agentId: string; contactId: string; cursor?: string; limit?: number }; result: { scopeRevision: number; entries: GrowthSource[]; nextCursor: string | null } };
  "growth.sources.authorize": { payload: { agentId: string; contactId: string; memoryIds: string[]; learn: true; expectedRevision: number }; result: { scopeRevision: number; authorized: number; entries: GrowthSource[] } };
  "growth.sources.forget": { payload: { agentId: string; contactId: string; id: string; expectedRevision: number }; result: { scopeRevision: number; forgottenId: string; invalidatedStateIds: string[] } };
  "growth.sources.requeue": { payload: { agentId: string; contactId: string; sourceIds: string[]; learn: true; expectedRevision: number }; result: { scopeRevision: number; queuedSourceIds: string[] } };
  "character.list": { payload: { agentId: string; contactId: string; kind?: CharacterState["kind"]; cursor?: string; limit?: number }; result: { scopeRevision: number; entries: CharacterState[]; nextCursor: string | null } };
  "character.dismiss": { payload: { agentId: string; contactId: string; id: string; expectedRevision: number }; result: { scopeRevision: number; dismissedId: string; invalidatedStateIds: string[] } };
  "reflection.status": { payload: { agentId: string }; result: ReflectionStatus };
  "proactive.get": { payload: { agentId: string }; result: { settings: ProactiveSettings; status: ProactiveStatus } };
  "proactive.configure": { payload: ProactiveConfigurationInput; result: { settings: ProactiveSettings; status: ProactiveStatus } };
  "bilibili.account.get": { payload: { agentId: string }; result: BilibiliAccountStatus };
  "bilibili.account.bind": { payload: BilibiliBindInput; result: BilibiliAccountStatus };
  "bilibili.account.unbind": { payload: { agentId: string; expectedRevision: number }; result: BilibiliAccountStatus };
  "bilibili.verify": { payload: { agentId: string; expectedRevision: number; bvid: string }; result: BilibiliVerifyResult };
  "content.get": { payload: { agentId: string }; result: { settings: ContentSettings; available: boolean } };
  "content.configure": { payload: ContentConfigurationInput; result: { settings: ContentSettings; available: boolean } };
  "content.browse": { payload: { agentId: string }; result: { done: boolean; outcome: string; reason?: string; observationId?: string } };
  "observations.list": { payload: { agentId: string; cursor?: string; limit?: number }; result: { entries: ContentObservation[]; nextCursor: string | null } };
  "observations.get": { payload: { agentId: string; id: string }; result: { observation: ContentObservationDetail | null } };
  "observations.feedback": { payload: ContentFeedbackInput; result: { observation: ContentObservationDetail } };
  "observations.forget": { payload: { agentId: string; id: string; expectedRevision: number }; result: { forgotten: boolean; projection: unknown } };
  "qq.contact.policies": {payload:{agentId:string};result:{entries:QQContactPolicy[]}};
  "qq.contact.configure": {payload:QQContactConfiguration;result:{policy:QQContactPolicy}};
  "qq.contact.plans": {payload:{agentId:string};result:{entries:QQContactPlan[]}};
  "qq.contact.generate": {payload:{agentId:string;targetId:string};result:{outcome:"planned"|"quiet";plan:QQContactPlan|null}};
  "qq.contact.update": {payload:{agentId:string;id:string;expectedRevision:number;text:string};result:{plan:QQContactPlan}};
  "qq.contact.cancel": {payload:{agentId:string;id:string;expectedRevision:number};result:{cancelled:boolean}};
  "qq.contact.send": {payload:{agentId:string;id:string;expectedRevision:number;confirmationHash:string};result:{outcome:"sent"|"failed"|"unknown";plan:QQContactPlan}};
  "qq.latency.list": {payload:{agentId:string;limit?:number};result:{available:boolean;entries:QQReplyLatency[]}};
  "qq.connection.get": { payload: { agentId: string }; result: QQConnectionStatus };
  "qq.connection.bind": { payload: QQBindInput; result: QQConnectionStatus };
  "qq.connection.bindOneBot": { payload: OneBotBindInput; result: QQConnectionStatus };
  "qq.pairing.start": { payload: { agentId: string; expectedRevision: number }; result: { code: string; expiresAt: number } };
  "qq.connection.unbind": { payload: { agentId: string; expectedRevision: number }; result: QQConnectionStatus };
  "qq.settings.get": { payload: { agentId: string }; result: { settings: QQSettings } };
  "qq.targets.resolve": { payload: { agentId: string; expectedRevision: number; kind: "group" | "user"; openid: string }; result: QQTargetInfo };
  "qq.groups.get": { payload: { agentId: string; expectedRevision: number; groupOpenid: string }; result: QQGroupState };
  "qq.settings.configure": { payload: QQConfigurationInput; result: { settings: QQSettings } };
  "qq.receive": { payload: { agentId: string; expectedRevision: number }; result: QQReceiveResult };
  "qq.messages.list": { payload: { agentId: string }; result: { entries: QQMessageEntry[] } };
  "qq.messages.forget": { payload: { agentId: string; id: string }; result: { forgotten: boolean } };
  "qq.reply.get": { payload: { agentId: string }; result: { settings: QQReplySettings; status: QQReplyStatus } };
  "qq.reply.configure": { payload: QQReplyConfigurationInput; result: { settings: QQReplySettings; status: QQReplyStatus } };
  "qq.drafts.generate": { payload: { agentId: string; eventId: string; learn: boolean }; result: { outcome: "drafted" | "suppressed"; draft?: QQDraft } };
  "qq.drafts.list": { payload: { agentId: string; eventId?: string }; result: { entries: QQDraft[] } };
  "qq.drafts.update": { payload: { agentId: string; id: string; expectedRevision: number; text: string }; result: { draft: QQDraft } };
  "qq.drafts.cancel": { payload: { agentId: string; id: string; expectedRevision: number }; result: { cancelled: boolean } };
  "qq.drafts.send": { payload: { agentId: string; id: string; expectedRevision: number; confirmationHash: string }; result: { outcome: "sent" | "failed" | "unknown"; draft: QQDraft; learningError?: string | null } };
  "qq.records.list": { payload: { agentId: string; cursor?: number; limit?: number }; result: { entries: QQSendRecord[]; nextCursor: number | null } };
  "qq.records.forget": { payload: { agentId: string; id: string }; result: { forgotten: boolean } };
  "plans.list": { payload: { agentId: string; cursor?: string; limit?: number }; result: { entries: ProactivePlan[]; nextCursor: string | null } };
  "plans.cancel": { payload: { agentId: string; id: string }; result: { cancelled: boolean } };
  "inbox.list": { payload: { agentId: string; cursor?: string; limit?: number }; result: { entries: ProactiveInboxEntry[]; nextCursor: string | null; unreadCount: number } };
  "inbox.read": { payload: { agentId: string; ids: string[] }; result: { readIds: string[]; unreadCount: number } };
}

/** 测试可显式注入的窄桥接；生产默认始终调用 Tauri invoke。 */
export type DesktopBridge = (command: string, args: Record<string, unknown>) => Promise<unknown>;

let testBridge: DesktopBridge | undefined;

/** 为隔离测试设置桥接；传入 undefined 可恢复生产默认。 */
export function setDesktopBridgeForTests(bridge: DesktopBridge | undefined): void {
  testBridge = bridge;
}

function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function request<Operation extends keyof DesktopOperations>(
  operation: Operation,
  payload: DesktopOperations[Operation]["payload"],
): Promise<DesktopOperations[Operation]["result"]> {
  const args = { operation, payload } as Record<string, unknown>;
  try {
    if (testBridge) return (await testBridge("desktop_request", args)) as DesktopOperations[Operation]["result"];
    if (!hasTauriRuntime()) throw new Error("桌面连接不可用，请在 Asterhabit 桌面应用中打开。");
    return await invoke<DesktopOperations[Operation]["result"]>("desktop_request", args);
  } catch (error) {
    if (operation.startsWith("model.connection.") || operation === "model.catalogue.refresh") {
      let parsed: unknown;
      if (typeof error === "string") { try { parsed = JSON.parse(error); } catch { /* 旧宿主或传输错误保留原通道。 */ } }
      if (parsed && typeof parsed === "object" && "modelConnectionError" in parsed && parsed.modelConnectionError === true && "code" in parsed && typeof parsed.code === "string" && "message" in parsed && typeof parsed.message === "string") throw new ModelConnectionRequestError(parsed.code, parsed.message);
    }
    throw error;
  }
}

/** 主人控制台使用的完整强类型业务 API。 */
export const desktopApi = {
  roleTemplates: () => request("agent.profile.templates", {}),
  importRoleFile: () => request("agent.profile.importFile", {}),
  exportRoleFile: (agentId: string) => request("agent.profile.exportFile", { agentId }),
  listModelConnections: () => request("model.connection.list", {}),
  saveModelConnection: (payload: ModelConnectionInput) => request("model.connection.save", payload),
  testModelConnection: (id: string, expectedRevision: number) => request("model.connection.test", { id, expectedRevision }),
  removeModelConnection: (id: string, expectedRevision: number) => request("model.connection.remove", { id, expectedRevision }),
  refreshModelCatalogue: (id: string, expectedRevision: number) => request("model.catalogue.refresh", { id, expectedRevision }),
  snapshot: (agentId?: string) => request("app.snapshot", agentId ? { agentId } : {}),
  createAgent: (configuration: AgentConfigurationInput) => request("agent.create", configuration),
  updateAgent: (configuration: AgentConfigurationInput & { agentId: string; expectedRevision: number }) => request("agent.update", configuration),
  archiveAgent: (agentId: string, expectedRevision: number, archived: boolean) => request("agent.archive", { agentId, expectedRevision, archived }),
  pauseAgent: (agentId: string, expectedRevision: number, paused: boolean) => request("agent.pause", { agentId, expectedRevision, paused }),
  listModels: () => request("model.list", {}),
  configureApplication: (
    expectedRevision: number,
    reflectionDailyCallLimit: number,
    minGapSeconds: number,
    backgroundDailyCallLimit?: number,
    proactiveDailyMessageLimit?: number,
    daily?: { dailyModelCallLimit: number | null; dialogueDailyCallLimit: number | null; keepRunningOnClose: boolean },
  ) => request("application.configure", {
    expectedRevision,
    reflectionDailyCallLimit,
    minGapSeconds,
    ...(backgroundDailyCallLimit === undefined ? {} : { backgroundDailyCallLimit }),
    ...(proactiveDailyMessageLimit === undefined ? {} : { proactiveDailyMessageLimit }),
    ...daily,
  }),
  quitApplication: () => request("application.quit", {}),
  recordActivity: () => request("app.activity", {}),
  chatHistory: (agentId: string, contactId: string) => request("chat.history", { agentId, contactId }),
  sendChat: (agentId: string, contactId: string, text: string, learn: boolean) =>
    request("chat.send", { agentId, contactId, text, learn }),
  cancelChat: (agentId: string, taskId: string) => request("chat.cancel", { agentId, taskId }),
  listMemories: (agentId: string, contactId: string, query?: string) =>
    request("memory.list", query ? { agentId, contactId, query } : { agentId, contactId }),
  saveMemory: (agentId: string, contactId: string, topic: string, text: string) =>
    request("memory.save", { agentId, contactId, topic, text }),
  correctMemory: (agentId: string, contactId: string, id: string, text: string) =>
    request("memory.correct", { agentId, contactId, id, text }),
  forgetMemory: (agentId: string, contactId: string, id: string) =>
    request("memory.forget", { agentId, contactId, id }),
  syncMemory: (agentId: string, contactId: string) => request("memory.sync", { agentId, contactId }),
  recoverMemory: (agentId: string, contactId: string) => request("memory.recover", { agentId, contactId }),
  savePermission: (agentId: string, expectedRevision: number, grant: GrantInput) =>
    request("permissions.save", { agentId, expectedRevision, grant }),
  revokePermission: (agentId: string, id: string, expectedRevision: number) =>
    request("permissions.revoke", { agentId, id, expectedRevision }),
  setPaused: (paused: boolean) => request("runtime.pause", { paused }),
  submitSimulation: (
    agentId: string,
    idempotencyKey: string,
    target: string,
    action: ActionKind,
    content: string,
  ) => request("simulation.submit", {
    agentId,
    idempotencyKey,
    account: "sandbox",
    target,
    action,
    content,
  }),
  executeSimulation: (agentId: string, id: string) => request("simulation.execute", { agentId, id }),
  cancelSimulation: (agentId: string, id: string) => request("simulation.cancel", { agentId, id }),
  listAudit: (agentId: string) => request("audit.list", { agentId }),
  getGrowth: (agentId: string) => request("growth.get", { agentId }),
  configureGrowth: (payload: DesktopOperations["growth.configure"]["payload"]) => request("growth.configure", payload),
  listGrowthSources: (agentId: string, contactId: string, cursor?: string, limit?: number) =>
    request("growth.sources.list", {
      agentId,
      contactId,
      ...(cursor ? { cursor } : {}),
      ...(limit === undefined ? {} : { limit }),
    }),
  authorizeGrowthSources: (payload: DesktopOperations["growth.sources.authorize"]["payload"]) => request("growth.sources.authorize", payload),
  forgetGrowthSource: (payload: DesktopOperations["growth.sources.forget"]["payload"]) => request("growth.sources.forget", payload),
  requeueGrowthSources: (payload: DesktopOperations["growth.sources.requeue"]["payload"]) => request("growth.sources.requeue", payload),
  listCharacterStates: (
    agentId: string,
    contactId: string,
    kind?: CharacterState["kind"],
    cursor?: string,
    limit?: number,
  ) => request("character.list", {
    agentId,
    contactId,
    ...(kind ? { kind } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit === undefined ? {} : { limit }),
  }),
  dismissCharacterState: (payload: DesktopOperations["character.dismiss"]["payload"]) => request("character.dismiss", payload),
  reflectionStatus: (agentId: string) => request("reflection.status", { agentId }),
  getProactive: (agentId: string) => request("proactive.get", { agentId }),
  configureProactive: (payload: ProactiveConfigurationInput) => request("proactive.configure", payload),
  getBilibiliAccount: (agentId: string) => request("bilibili.account.get", { agentId }),
  bindBilibiliAccount: (payload: BilibiliBindInput) => request("bilibili.account.bind", payload),
  unbindBilibiliAccount: (agentId: string, expectedRevision: number) => request("bilibili.account.unbind", { agentId, expectedRevision }),
  verifyBilibiliVideo: (agentId: string, expectedRevision: number, bvid: string) => request("bilibili.verify", { agentId, expectedRevision, bvid }),
  getContentSettings: (agentId: string) => request("content.get", { agentId }),
  configureContentSettings: (payload: ContentConfigurationInput) => request("content.configure", payload),
  browseContent: (agentId: string) => request("content.browse", { agentId }),
  listObservations: (agentId: string, options: { cursor?: string; limit?: number } = {}) => request("observations.list", { agentId, ...options }),
  getObservation: (agentId: string, id: string) => request("observations.get", { agentId, id }),
  feedbackObservation: (payload: ContentFeedbackInput) => request("observations.feedback", payload),
  forgetObservation: (agentId: string, id: string, expectedRevision: number) => request("observations.forget", { agentId, id, expectedRevision }),
  getQQConnection: (agentId: string) => request("qq.connection.get", { agentId }),
  bindOneBotConnection: (payload: OneBotBindInput) => request("qq.connection.bindOneBot", payload),
  getQQContactPolicies:(agentId:string)=>request("qq.contact.policies",{agentId}),
  configureQQContact:(payload:QQContactConfiguration)=>request("qq.contact.configure",payload),
  listQQContactPlans:(agentId:string)=>request("qq.contact.plans",{agentId}),
  generateQQContactPlan:(agentId:string,targetId:string)=>request("qq.contact.generate",{agentId,targetId}),
  updateQQContactPlan:(agentId:string,id:string,expectedRevision:number,text:string)=>request("qq.contact.update",{agentId,id,expectedRevision,text}),
  cancelQQContactPlan:(agentId:string,id:string,expectedRevision:number)=>request("qq.contact.cancel",{agentId,id,expectedRevision}),
  sendQQContactPlan:(agentId:string,id:string,expectedRevision:number,confirmationHash:string)=>request("qq.contact.send",{agentId,id,expectedRevision,confirmationHash}),
  bindQQConnection: (payload: QQBindInput) => request("qq.connection.bind", payload),
  startQQPairing: (agentId: string, expectedRevision: number) =>
    request("qq.pairing.start", { agentId, expectedRevision }),
  unbindQQConnection: (agentId: string, expectedRevision: number) =>
    request("qq.connection.unbind", { agentId, expectedRevision }),
  getQQReplyLatency:(agentId:string,limit?:number)=>request("qq.latency.list",{agentId,...(limit===undefined?{}:{limit})}),
  getQQSettings: (agentId: string) => request("qq.settings.get", { agentId }),
  resolveQQTarget: (payload: { agentId: string; expectedRevision: number; kind: "group" | "user"; openid: string }) => request("qq.targets.resolve", payload),
  getQQGroupState: (agentId: string, expectedRevision: number, groupOpenid: string) => request("qq.groups.get", { agentId, expectedRevision, groupOpenid }),
  configureQQSettings: (payload: QQConfigurationInput) => request("qq.settings.configure", payload),
  receiveQQMessages: (agentId: string, expectedRevision: number) =>
    request("qq.receive", { agentId, expectedRevision }),
  listQQMessages: (agentId: string) => request("qq.messages.list", { agentId }),
  forgetQQMessage: (agentId: string, id: string) => request("qq.messages.forget", { agentId, id }),
  getQQReplySettings: (agentId: string) => request("qq.reply.get", { agentId }),
  configureQQReplies: (payload: QQReplyConfigurationInput) => request("qq.reply.configure", payload),
  generateQQDraft: (agentId: string, eventId: string, learn: boolean) =>
    request("qq.drafts.generate", { agentId, eventId, learn }),
  listQQDrafts: (agentId: string, eventId?: string) => request("qq.drafts.list", {
    agentId,
    ...(eventId ? { eventId } : {}),
  }),
  updateQQDraft: (agentId: string, id: string, expectedRevision: number, text: string) =>
    request("qq.drafts.update", { agentId, id, expectedRevision, text }),
  cancelQQDraft: (agentId: string, id: string, expectedRevision: number) =>
    request("qq.drafts.cancel", { agentId, id, expectedRevision }),
  sendQQDraft: (agentId: string, id: string, expectedRevision: number, confirmationHash: string) =>
    request("qq.drafts.send", { agentId, id, expectedRevision, confirmationHash }),
  listQQSendRecords: (agentId: string, cursor?: number, limit = 10) => request("qq.records.list", {
    agentId,
    ...(cursor === undefined ? {} : { cursor }),
    limit,
  }),
  forgetQQSendRecord: (agentId: string, id: string) => request("qq.records.forget", { agentId, id }),
  listProactivePlans: (agentId: string, cursor?: string, limit?: number) => request("plans.list", {
    agentId,
    ...(cursor ? { cursor } : {}),
    ...(limit === undefined ? {} : { limit }),
  }),
  cancelProactivePlan: (agentId: string, id: string) => request("plans.cancel", { agentId, id }),
  listProactiveInbox: (agentId: string, cursor?: string, limit?: number) => request("inbox.list", {
    agentId,
    ...(cursor ? { cursor } : {}),
    ...(limit === undefined ? {} : { limit }),
  }),
  readProactiveInbox: (agentId: string, ids: string[]) => request("inbox.read", { agentId, ids }),
};
