import type { ContentObservation, ContentFeedbackValue } from "./api";
import { uiLocale } from "./i18n";

const english: Record<string, string> = {
  "观察记录": "Observations", "刷新": "Refresh", "刷新中…": "Refreshing…", "观察一次": "Observe once", "观察中…": "Observing…",
  "暂无观察记录": "No observations yet", "查看详情": "View details", "加载更多": "Load more", "加载中…": "Loading…",
  "来源": "Source", "实际覆盖": "Actual coverage", "简介 {0} · 字幕 {1} · 评论 {2}": "Description {0} · subtitles {1} · comments {2}",
  "材料事实": "Material facts", "观察摘要": "Observation summary", "Agent 看法": "Agent viewpoint", "处理状态": "Status",
  "有效": "Active", "已过期": "Expired", "已遗忘": "Forgotten", "简介": "Description", "字幕片段": "Subtitle excerpt", "评论样本": "Comment sample",
  "{0}–{1} 秒": "{0}–{1} seconds", "喜欢 · 当前内容": "Like · this content", "少推荐 · 当前内容": "Recommend less · this content",
  "不再推荐 · 当前内容": "Do not recommend · this content", "喜欢 · 当前作者": "Like · this creator", "少推荐 · 当前作者": "Recommend less · this creator",
  "不再推荐 · 当前作者": "Do not recommend · this creator", "撤销当前内容反馈": "Remove content feedback", "撤销当前作者反馈": "Remove creator feedback",
  "当前内容": "This content", "当前作者": "This creator", "喜欢": "Like", "少推荐": "Recommend less", "不再推荐": "Do not recommend",
  "遗忘此观察": "Forget this observation", "确认遗忘": "Confirm forget", "取消": "Cancel", "遗忘会清除本地材料及其派生内容。": "Forgetting clears local materials and their derived content.",
  "读取失败": "Load failed", "操作失败": "Action failed", "观察已保存": "Observation saved", "本轮没有保存观察": "No observation was saved this time",
  "观察已不可用": "This observation is no longer available", "作者信息不可用": "Creator information is unavailable",
  "观察列表响应无效": "The observation list response is invalid",
  "没有可读取的材料": "No readable materials were available",
  "当前读取条件、间隔或额度不满足": "Reading is unavailable under the current settings, interval or budget",
  "候选内容均已处理": "All candidates have already been processed",
  "没有找到候选内容": "No candidate content was found",
  "候选内容已被反馈规则排除": "Candidates were excluded by feedback rules",
};

/** 观察界面的小型双语资源；只影响显示，不进入模型或 Agent 配置。 */
export function observationText(source: string, ...values: unknown[]): string {
  let result = uiLocale.value === "en" ? english[source] ?? source : source;
  values.forEach((value, index) => { result = result.replaceAll(`{${index}}`, String(value)); });
  return result;
}

/** 跨页按稳定观察标识去重，保留先到页面的顺序。 */
export function appendUniqueObservations(current: ContentObservation[], incoming: ContentObservation[]): ContentObservation[] {
  const seen = new Set(current.map(item => item.id));
  return [...current, ...incoming.filter(item => !seen.has(item.id) && seen.add(item.id))];
}

/** 反馈值只用于简短状态显示；null 表示该层级没有规则。 */
export function feedbackLabel(value: ContentFeedbackValue): string {
  return value === "like" ? observationText("喜欢") : value === "less" ? observationText("少推荐") : value === "block" ? observationText("不再推荐") : "";
}
