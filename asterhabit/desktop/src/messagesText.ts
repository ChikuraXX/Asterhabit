import { uiLocale, uiText } from "./i18n";
import generationFailureContract from "../../shared/generation-failure-contract.json";
import type { GenerationFailureReason } from "./api";

const english: Record<string, string> = {
  "回复生成失败：{0}（未发送）": "Reply generation failed: {0} (not sent)",
  "正在生成回复…": "Generating reply…",
  "回复生成已停止（未发送）": "Reply generation stopped (not sent)",
  "AI 选择保持安静": "The AI chose to stay quiet",
  "消息": "Messages",
  "仅显示已经接入的平台和本地保留的短期记录": "Shows connected platforms and locally retained short-term records only",
  "正在读取消息…": "Loading messages…",
  "刷新消息": "Refresh messages",
  "QQ 尚未绑定": "QQ is not bound",
  "绑定后，已授权范围内的消息会显示在这里。": "Messages from the authorized scope will appear here after binding.",
  "暂无会话": "No conversations",
  "QQ 私聊": "QQ private chat",
  "QQ群聊": "QQ group chat",
  "返回会话": "Back to conversations",
  "选择一个会话": "Select a conversation",
  "收件": "Received",
  "未发送草稿": "Unsent draft",
  "发送详情": "Send details",
  "发言者 {0}": "Sender {0}",
  "自动回复已开启，手动生成和发送暂不可用": "Automatic replies are enabled; manual generation and sending are unavailable",
  "自动回复关闭时，可在这里生成、编辑并确认发送": "When automatic replies are off, generate, edit, and confirm replies here",
  "当前设置未启用回复草稿": "Reply drafts are disabled in the current settings",
  "当前设置未启用手动确认发送": "Manual send confirmation is disabled in the current settings",
  "滚动 24 小时：业务阶段预留不等同实际 provider 请求次数；发送按提交尝试计数，间隔适用于此 Agent 全部 QQ 目标。": "Rolling 24 hours: reserved business stages are not the same as actual provider requests; sends count submission attempts, and the gap applies to every QQ target of this Agent.",
  "业务阶段 {0}/{1} · 发送 {2}/{3} · 间隔 {4} 秒": "Business stages {0}/{1} · Sends {2}/{3} · Gap {4}s",
  "近 24 小时业务阶段额度已用尽": "The business-stage quota for the last 24 hours is exhausted",
  "机器人 {0}": "Bot {0}",
  "私聊目标 {0}": "Private target {0}",
  "群聊目标 {0}": "Group target {0}",
  "已提交正文": "Submitted text",
  "本地短期消息记录，不代表完整 QQ 历史": "Local short-term records; this is not complete QQ history",
  "刷新失败，稍后自动重试：{0}": "Refresh failed; retrying later: {0}",
};

/** 只展示合同中的固定原因；不把宿主未知字段作为界面文本回显。 */
export function generationFailureText(reason: GenerationFailureReason): string {
  const entry = Object.hasOwn(generationFailureContract.reasons, reason)
    ? generationFailureContract.reasons[reason]
    : generationFailureContract.reasons.generation_failed;
  return entry[uiLocale.value];
}

/** 消息工作区独立文案；共享入口合并后可迁移到全局词典。 */
export function messagesText(source: string, ...values: unknown[]): string {
  const translated = uiLocale.value === "en" ? (english[source] ?? uiText(source)) : uiText(source);
  return translated.replace(/\{(\d+)\}/g, (placeholder, index: string) => Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}
