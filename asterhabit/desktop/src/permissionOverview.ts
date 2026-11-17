import { desktopApi } from "./api";

/** 仅汇总现有权威设置；各读取独立失败，不触发平台查询、监听或配置写入。 */
export async function loadPermissionOverview(agentId: string) {
  const [qqConnection, qqSettings, qqReply, bilibiliAccount, content, growth, proactive] = await Promise.allSettled([
    desktopApi.getQQConnection(agentId), desktopApi.getQQSettings(agentId), desktopApi.getQQReplySettings(agentId),
    desktopApi.getBilibiliAccount(agentId), desktopApi.getContentSettings(agentId), desktopApi.getGrowth(agentId),
    desktopApi.getProactive(agentId),
  ]);
  return { qqConnection, qqSettings, qqReply, bilibiliAccount, content, growth, proactive };
}

/** 权限概览使用原设置页的标签标识，不维护第二份配置。 */
export type PermissionSettingsTab = "qq" | "bilibili" | "growth" | "proactive";
