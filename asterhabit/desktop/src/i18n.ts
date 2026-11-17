import { computed, ref, watch } from "vue";
import { componentEnglish } from "./componentMessages";

/** 界面语言只影响本地显示，不改变人格、模型输入或回复语言。 */
export type UiLocale = "zh-CN" | "en";
/** 保存的界面偏好；system 不会被解析结果覆盖。 */
export type UiLocalePreference = UiLocale | "system";
const storageKey = "asterhabit.ui.locale";
/** 保留旧手动选择；无有效偏好时跟随系统。 */
export function readUiLocale(storage?: Pick<Storage, "getItem">): UiLocalePreference {
  try {
    const value = (storage ?? globalThis.localStorage)?.getItem(storageKey);
    return value === "en" || value === "zh-CN" ? value : "system";
  } catch { return "system"; }
}
/** 仅支持现有简体中文和英语资源；未知、缺失或其他语言回退英语。 */
export function resolveUiLocale(preference: UiLocalePreference, systemLanguage?: string): UiLocale {
  if (preference !== "system") return preference;
  return /^zh(?:-CN|-SG|-Hans(?:-[a-z]+)?)?$/i.test(systemLanguage ?? "") ? "zh-CN" : "en";
}
/** 浏览器/WebView 提供当前系统首选语言；访问失败时使用英语回退。 */
function readSystemLanguage(): string {
  try { return globalThis.navigator?.language ?? ""; } catch { return ""; }
}
/** 仅保存界面语言，不将任何账号或业务内容写入浏览器存储。 */
export function saveUiLocale(locale: UiLocalePreference, storage?: Pick<Storage, "setItem">): void {
  try { (storage ?? globalThis.localStorage)?.setItem(storageKey, locale); } catch { /* 受限WebView仍可在当前窗口切换。 */ }
}
export const uiLocalePreference = ref<UiLocalePreference>(readUiLocale());
const systemLanguage = ref(readSystemLanguage());
if (typeof window !== "undefined") window.addEventListener("languagechange", () => { systemLanguage.value = readSystemLanguage(); });
/** 显示语言独立解析；旧调用者显式赋值仍代表手动选择。 */
export const uiLocale = computed<UiLocale>({
  get: () => resolveUiLocale(uiLocalePreference.value, systemLanguage.value),
  set: (locale) => { uiLocalePreference.value = locale; },
});
watch(uiLocalePreference, (preference) => saveUiLocale(preference), { flush: "sync" });
watch(uiLocale, (locale) => {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}, { flush: "sync", immediate: true });

const applicationEnglish: Record<string, string> = {
  "跟随系统": "System",
  "官方 QQ 机器人": "Official QQ Bot", "连接异常": "Connection error", "正在连接…": "Connecting…",
  "正在监听": "Listening", "已绑定": "Bound", "自动回复运行中": "Automatic replies running",
  "自动回复运行中，无需手动接收": "Automatic replies are running; manual receiving is unavailable",
  "自动回复正在连接，无需手动接收": "Automatic replies are connecting; manual receiving is unavailable",
  "自动回复连接异常": "Automatic reply connection error", "自动回复已开启，等待连接": "Automatic replies enabled; waiting to connect",
  "生成绑定码": "Generate pairing code", "请用要授权的 QQ 向机器人发送绑定码：{0}": "Send this pairing code to the bot from the QQ account to authorize: {0}",
  "允许的用户 OpenID": "Allowed user OpenIDs", "允许的群 OpenID": "Allowed group OpenIDs",
  "每行一个用户 OpenID": "One user OpenID per line", "每行一个群 OpenID": "One group OpenID per line",
  "群聊消息": "Group messages", "仅接收 @ 机器人的消息": "Receive only messages that mention the bot",
  "QQ 回复": "QQ replies", "启用回复": "Enable replies", "回复模式": "Reply mode",
  "审核后发送": "Review before sending", "自动回复": "Automatic replies",
  "收到白名单消息后自动生成并发送": "Generate and send automatically after an allowed message arrives",
  "生成草稿后由主人审核发送": "Generate a draft for the owner to review and send",
  "自动回复模式已开启": "Automatic reply mode is enabled",
  "当前为自动回复模式": "Automatic reply mode is active", "QQ正在监听": "QQ is listening",
  "QQ自动回复授权已变化": "QQ automatic reply authorization changed",
  "QQ回复消息已过期": "The QQ reply window has expired", "QQ群仅支持@机器人消息": "QQ groups support messages that mention the bot only",
  "QQ主动发送不能开启": "QQ proactive sending cannot be enabled", "QQ回复模式不能同时开启": "QQ reply modes cannot be enabled together",
  "QQ回复配置已变化": "QQ reply settings changed",
  "QQ机器人连接参数无效": "QQ Bot connection settings are invalid", "QQ机器人操作已取消": "QQ Bot operation was cancelled",
  "QQ机器人请求超时": "QQ Bot request timed out", "QQ机器人身份验证失败": "QQ Bot authentication failed",
  "QQ机器人平台拒绝了请求": "The QQ Bot platform rejected the request", "QQ机器人协议响应无效": "The QQ Bot protocol response is invalid",
  "QQ机器人数据帧过大": "The QQ Bot data frame is too large", "QQ机器人连接失败": "QQ Bot connection failed",
  "QQ机器人事件处理失败": "QQ Bot event handling failed", "QQ机器人发送结果未确认": "QQ Bot send result is unconfirmed",
  "角色设置": "Character settings", "性格": "Personality", "表达偏好": "Expression style",
  "默认回复语言": "Default reply language", "红线规则": "Content boundaries",
  "常用填写": "Quick fill", "跟随对话": "Follow conversation",
  "例如：主要中文，技术术语保留英文。": "For example: mainly Chinese, keeping technical terms in English.",
  "这里只授权 sandbox 模拟动作，不授予 QQ、BiliBili 或系统权限。": "This grants synthetic sandbox actions only; it does not grant QQ, BiliBili, or system permissions.",
  "sandbox 授权": "Sandbox grants", "撤销中…": "Revoking…",
  "请先开启并保存回复草稿": "Enable and save reply drafts first",
  "请先开启并保存手动确认发送": "Enable and save manual send confirmation first",
  "发送状态未确认，不能再次发送": "Send status is unconfirmed; it cannot be sent again",
  "请先保存修改": "Save your changes first", "当前草稿不可发送": "This draft cannot be sent",
  "聊天": "Chat", "消息": "Messages", "记忆": "Memory", "成长": "Growth", "权限": "Permissions", "活动": "Activity", "配置": "Settings",
  "界面语言": "Interface language", "展开 Agent 栏": "Expand agent sidebar", "收起 Agent 栏": "Collapse agent sidebar", "创建 Agent": "Create agent", "Agent 列表": "Agents", "{0} 条未读主动消息": "{0} unread messages", "应用设置": "Application settings", "恢复全部": "Resume all", "暂停全部": "Pause all", "已归档": "Archived", "{0} 个 Agent": "{0} agents", "联系人": "Contact", "需要清理": "Cleanup required", "已暂停": "Paused", "可用": "Available", "前往清理": "Open cleanup", "恢复 {0}": "Resume {0}", "暂停 {0}": "Pause {0}", "Agent 页面": "Agent pages", "正在连接桌面服务…": "Connecting to the desktop service…", "桌面连接不可用": "Desktop connection unavailable", "请在 Asterhabit 桌面应用中打开。": "Open this in the Asterhabit desktop app.", "重新连接": "Reconnect", "关闭": "Close", "名字": "Name", "昵称 / 英文名": "Nickname / English name", "基础人格": "Base persona", "推理档位": "Reasoning effort", "取消": "Cancel", "创建中…": "Creating…", "创建": "Create", "24 小时后台调用总额度": "Total background calls per 24 hours", "24 小时主动消息总额度": "Total proactive messages per 24 hours", "24 小时反思子额度": "Reflection calls per 24 hours", "反思最小间隔（秒）": "Minimum reflection interval (seconds)", "保存": "Save", "已归档 Agent": "Archived agents", "没有已归档 Agent。": "No archived agents.", "恢复": "Restore", "Agent 状态归属不一致，请重新连接。": "The returned agent does not match this view. Reconnect.", "主人": "Owner", "桌面连接不可用，请在 Asterhabit 桌面应用中打开。": "Desktop connection unavailable. Open this in the Asterhabit desktop app.", "操作未完成，请稍后重试。": "The operation could not be completed. Try again shortly.",
};
const englishToChinese = new Map([...Object.entries(componentEnglish), ...Object.entries(applicationEnglish)].map(([chinese, english]) => [english, chinese]));
/** 只翻译显式界面文案，插值里的姓名、正文和模型ID原样保留。 */
export function uiText(source: string, ...values: unknown[]): string {
  let text = source;
  if (uiLocale.value === "en") text = applicationEnglish[source] ?? componentEnglish[source] ?? source;
  else {
    // 瞬时结果可能在英文界面产生；仅反查已注册文案，不接触用户正文。
    text = englishToChinese.get(source) ?? source;
  }
  // 单次替换模板占位符，用户原文中类似{1}的字符不会被二次解释。
  return text.replace(/\{(\d+)\}/g, (placeholder, index: string) => Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}
