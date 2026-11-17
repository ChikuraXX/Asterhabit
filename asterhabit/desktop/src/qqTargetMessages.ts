import { uiLocale } from "./i18n";
const english: Record<string, string> = {
  "QQ 号": "QQ account ID", "群号": "Group ID", "请输入有效的 QQ 号或群号": "Enter a valid numeric QQ or group ID", "号码重复": "Duplicate ID",
  "备注": "Remark",
  "允许的群": "Allowed groups", "允许的用户": "Allowed users", "添加群": "Add group", "添加用户": "Add user",
  "移除": "Remove", "群名称": "Group name", "用户昵称": "User nickname", "暂无名称": "No name available",
  "获取名称": "Get name", "读取中…": "Loading…", "请输入有效的 OpenID": "Enter a valid OpenID", "OpenID 重复": "Duplicate OpenID",
  "机器人尚未获得群资料接口权限": "The bot does not have permission to read group information",
  "群资料查询过于频繁，请稍后重试": "Group information requests are too frequent. Try again shortly",
  "QQ资料响应无效": "Invalid QQ information response", "暂无已授权的用户昵称": "No nickname from authorized messages is available",
};
/** 只翻译条目控件与状态，不修改平台返回的名称。 */
export function qqTargetText(text: string): string { return uiLocale.value === "en" ? english[text] ?? text : text; }
