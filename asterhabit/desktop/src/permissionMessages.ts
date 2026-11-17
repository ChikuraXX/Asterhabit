import { uiLocale } from "./i18n";

/** 权限概览与应用级参数的就近说明；插值中的用户内容保持原样。 */
const messages = {
  overview: ["当前 Agent 的权限", "Permissions for this agent"],
  scope: ["各项设置分别生效；暂停状态不会更改已保存的授权。", "Each setting applies independently. Pausing does not change saved permissions."],
  loading: ["正在读取权限设置…", "Reading permission settings…"],
  unavailable: ["读取失败", "Read failed"],
  retry: ["刷新状态", "Refresh status"],
  open: ["打开设置", "Open settings"],
  on: ["已开启", "Enabled"],
  off: ["已关闭", "Disabled"],
  paused: ["已暂停，已保存的开关暂不执行。", "Paused; saved settings are not currently executing."],
  qq: ["QQ 接收", "QQ reception"],
  qqScope: ["白名单：{0} 位用户 / {1} 个群；{2}。", "Allowlist: {0} users / {1} groups; {2}."],
  mentions: ["群内仅 @ 机器人", "group mentions only"],
  allGroup: ["群内全量接收，仍受平台权限限制", "all group messages, subject to platform permissions"],
  bound: ["已绑定", "Bound"],
  unbound: ["未绑定", "Not bound"],
  listener: ["监听状态：{0}；绑定不代表监听已启动。", "Listener: {0}; binding does not mean listening has started."],
  stopped: ["已停止", "Stopped"],
  connecting: ["连接中", "Connecting"],
  reconnecting: ["重连中", "Reconnecting"],
  listening: ["监听中", "Listening"],
  error: ["异常", "Error"],
  reply: ["QQ 回复", "QQ replies"],
  replyScope: ["草稿：{0}；审核发送：{1}；自动回复：{2}。仅限有效收件对应目标及平台回复时窗。", "Drafts: {0}; reviewed sending: {1}; automatic replies: {2}. Limited to the received message's target and platform reply window."],
  replyQuota: ["滚动 24 小时：业务模型阶段 {0}/{1}，发送尝试 {2}/{3}；各 QQ 目标共用，非 provider 请求计数。", "Rolling 24 hours: business model stages {0}/{1}, send attempts {2}/{3}; shared across QQ targets, not provider request counts."],
  bili: ["BiliBili 读取与学习", "BiliBili reading and learning"],
  biliScope: ["读取：{0}；学习：{1}；{2} 个关键词 / {3} 位作者。学习还需开启成长，不授予发布权限。", "Reading: {0}; learning: {1}; {2} keywords / {3} creators. Learning also requires growth; it does not allow publishing."],
  growth: ["学习与成长", "Learning and growth"],
  growthScope: ["仅使用当前 Agent 各联系人范围内已授权来源；聊天另有本轮学习开关。滚动 24 小时反思业务阶段上限 {0}。", "Uses authorized sources in each contact scope of this agent. Chat has a separate per-turn learning switch. Limit: {0} reflection stages per rolling 24 hours."],
  proactive: ["应用内主动联系", "In-app proactive contact"],
  proactiveScope: ["仅向应用内主人私聊投递；滚动 24 小时消息 {0}/{1}，模型业务阶段 {2}/{3}，并受应用总额度约束。", "Delivers only to the owner's private chat in this app. Rolling 24 hours: messages {0}/{1}, business model stages {2}/{3}, also subject to app-wide limits."],
  platformSend: ["平台主动发送", "Proactive platform sending"],
  unsupported: ["未实现", "Not implemented"],
  sendScope: ["QQ 主动开话题、BiliBili 私信/评论/发布尚无执行入口；应用内主动联系不会向平台发送。", "No execution entry for starting QQ conversations or BiliBili messages, comments, or publishing. In-app contact does not send to platforms."],
  sandbox: ["sandbox 模拟授权", "Sandbox simulation grants"],
  sandboxHelp: ["只作用于当前 Agent 的合成目标与动作。保存立即生效；执行时重查启用、到期、额度和暂停。", "Applies only to this agent's synthetic targets and actions. Saving takes effect immediately; execution rechecks enabled state, expiry, quota, and pause."],
  quotaHelp: ["每个窗口允许的成功执行次数；失败不计成功次数。", "Successful executions allowed per window; failures do not count as successes."],
  expiryHelp: ["按本地时间填写；启用时须在未来 30 天内。到期后拒绝执行。", "Enter local time within the next 30 days when enabling. Execution is denied after expiry."],
  languageHelp: ["立即应用，仅改变界面；跟随系统只支持简体中文和英语，其他语言使用英语。", "Applies immediately to the interface only. System mode supports Simplified Chinese and English; other languages use English."],
  backgroundHelp: ["所有 Agent 共用滚动 24 小时业务阶段预留：反思、主动规划/联系、浏览选择/理解及 QQ 回复；失败不返还，不等于 provider 请求数。保存后按新额度检查。", "All agents share rolling 24-hour stage reservations for reflection, proactive planning/contact, browsing selection/interpretation, and QQ replies. Failures are not refunded; this is not a provider request count. New limits apply after saving."],
  messageHelp: ["所有 Agent 共用应用内主动消息额度；预留与已投递计数，不含 QQ 平台回复。保存后生效。", "Shared in-app proactive message limit across all agents; counts reserved and delivered messages, excluding QQ replies. Applies after saving."],
  reflectionHelp: ["所有 Agent 共用反思子额度，同时受后台总额度限制；滚动 24 小时预留计数，保存后生效。", "Shared reflection sublimit across all agents, also capped by the background limit; counts rolling 24-hour reservations. Applies after saving."],
  gapHelp: ["所有 Agent 的反思任务共用，单位秒；与各 Agent 的反思间隔同时检查，保存后生效。", "Shared across all agents' reflection tasks, in seconds; checked alongside each agent's reflection interval. Applies after saving."],
} satisfies Record<string, readonly [string, string]>;

/** 按当前界面语言取文案，保留姓名和标识等插值。 */
export function permissionText(key: keyof typeof messages, ...values: unknown[]): string {
  return messages[key][uiLocale.value === "en" ? 1 : 0].replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ""));
}
