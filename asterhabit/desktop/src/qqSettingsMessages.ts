import { uiLocale, uiText } from "./i18n";

const english: Record<string, string> = {
  "点名后接话条数（0关闭）": "Follow-up messages after mention (0 disables)", "接话时限（秒，0关闭）": "Follow-up window (seconds, 0 disables)", "群接话窗口设置无效": "Invalid group follow-up window",
  "QQ 连接": "QQ connection", "接入方式": "Connection type", "WebSocket 地址": "WebSocket URL", "QQ 号": "QQ account ID", "访问令牌": "Access token", "请输入有效的 QQ 号": "Enter a valid QQ account ID",
  "未识别的平台模式": "Unrecognized platform mode", "平台返回的接收设置无法确认，请在 QQ 平台核对。": "The returned reception mode cannot be confirmed. Check the setting on QQ.", "报告值：{0}": "Reported value: {0}",
  "群状态查询正在进行": "A group state check is already in progress",
  "接收群内全部消息": "Receive all group messages",
  "QQ 平台也必须开启接收所有消息；本地设置不会开通平台权限。": "QQ must also have receiving all messages enabled. This local setting does not grant platform permissions.",
  "自动回复开启后，AI 会选择回复或保持安静；每次判断计入业务阶段额度，保持安静不占发送额度。": "With automatic replies enabled, the AI chooses to reply or stay quiet. Each decision counts against the business-stage quota; staying quiet uses no send quota.",
  "全部群消息": "All group messages", "仅 @ 机器人": "Bot mentions only", "@ 及相关上下文": "Mentions and related context",
  "先保存群条目，再检查平台接收范围。": "Save a group entry before checking its platform reception settings.",
  "QQ 平台接收范围": "QQ platform reception", "未核验": "Not checked", "检查中…": "Checking…", "检查平台设置": "Check platform settings",
  "平台尚未开启全量消息，本地选择不会开通该权限。": "The platform is not set to all messages. The local selection cannot enable that permission.",
  "QQ群状态响应无效": "Invalid QQ group state response", "机器人尚未获得群状态接口权限": "The bot does not have access to the group state API",
  "请先保存此群的接收范围": "Save this group in the allowlist first", "QQ群状态查询未就绪": "QQ group state lookup is not ready",
  "两项额度均按当前 Agent 的所有 QQ 用户和群合计，换绑账号不重置。统计从现在往前 24 小时，不在零点清零；不影响接收消息。": "Both quotas cover all QQ users and groups for this Agent and do not reset when the bound account changes. Usage is counted over the preceding 24 hours, not reset at midnight. Receiving messages is unaffected.",
  "限制生成回复的模型处理量。普通草稿通常计 1 次；开启本轮学习时，提取和起草可各计 1 次。阶段预留后即计入，达到上限后停止新生成；手动编辑不计。这不是实际 provider 请求次数或费用上限。": "Limits model processing for replies. A normal draft usually counts once; with learning enabled, extraction and drafting can each count once. Stages count when reserved. Reaching the limit stops new generation; manual edits do not count. This is not a limit on actual provider requests or cost.",
  "限制回复发送尝试次数，手动确认与自动回复共用。只生成草稿不计；失败或结果未知的已预留尝试也计入，达到上限后停止发送。": "Limits reply send attempts, shared by manually confirmed and automatic replies. Drafting alone does not count. Reserved attempts still count if they fail or their outcome is unknown. Reaching the limit stops sending.",
  "QQ用户备注无效": "A user remark is invalid. Use up to 100 characters for an allowed OpenID.",
  "持续接收由应用后台维护，与当前页面是否打开无关。": "The application maintains continuous receiving in the background, regardless of whether this page is open.",
  "自动回复": "Automatic replies",
  "收到合格消息后自动生成并发送": "Generate and send a reply after an eligible message is received",
  "消息区审核发送": "Review and send in Messages",
  "在消息区手动生成、编辑并逐条确认": "Generate, edit, and confirm each reply in Messages",
  "关闭自动回复后保留消息区审核发送。": "Turning off automatic replies keeps review and send available in Messages.",
  "回复额度与间隔": "Reply quotas and interval",
  "滚动 24 小时业务阶段上限": "Business-stage limit in a rolling 24-hour window",
  "一次草稿可在提取和起草阶段各计 1 次；这是业务阶段预留，不等同实际 provider 请求次数。": "A draft can count once for extraction and once for drafting. This reserves business stages and is not the same as the number of actual provider requests.",
  "滚动 24 小时发送上限": "Send limit in a rolling 24-hour window",
  "按 Agent 统计，审核与自动回复共用；更换绑定账号不会重置。": "Counted per Agent and shared by reviewed and automatic replies; changing the bound account does not reset it.",
  "此 Agent 所有 QQ 目标共用的最小发送间隔（秒）": "Minimum interval shared by all QQ targets for this Agent (seconds)",
  "当前滚动 24 小时：业务阶段 {0}/{1}，发送 {2}/{3}": "Current rolling 24 hours: business stages {0}/{1}, sends {2}/{3}",
  "回复设置已保存": "Reply settings saved",
  "正在读取回复设置…": "Loading reply settings…",
  "保存回复设置": "Save reply settings",
  "接收已开启，后台正在连接": "Receiving is enabled; the background listener is connecting",
  "接收已开启，后台持续监听中": "Receiving is enabled; the background listener is active",
  "接收已开启，但后台连接异常": "Receiving is enabled, but the background connection has an error",
  "接收已开启，等待后台监听": "Receiving is enabled; waiting for the background listener",
  "接收已关闭": "Receiving is off",
  "配置已被其他操作修改，请重新载入后再保存": "The configuration changed elsewhere. Reload it before saving again",
  "重新载入": "Reload",
  "页面离开时保存结果未确认，请重新载入后再继续": "The save result was not confirmed when the page was left. Reload before continuing",
  "接收设置已在其他位置变化；当前输入已保留，请重新载入后再保存": "Receive settings changed elsewhere. Your input is preserved; reload before saving",
  "回复设置已在其他位置变化；当前输入已保留，请重新载入后再保存": "Reply settings changed elsewhere. Your input is preserved; reload before saving",
};

function interpolate(text: string, values: Array<string | number>): string {
  return values.reduce<string>((result, value, index) => result.replaceAll(`{${index}}`, String(value)), text);
}

/** QQ设置页的局部文案；未收录项继续使用全局翻译。 */
export function qqSettingsText(text: string, ...values: Array<string | number>): string {
  if (uiLocale.value === "en" && english[text]) return interpolate(english[text], values);
  return uiText(text, ...values);
}
