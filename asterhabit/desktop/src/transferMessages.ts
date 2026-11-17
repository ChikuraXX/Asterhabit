import { uiLocale } from "./i18n";

const english: Record<string, string> = {
  "角色模板与导入": "Character templates and import",
  "选择模板": "Choose a template",
  "请选择模板": "Select a template",
  "预览模板": "Preview template",
  "从文件导入": "Import from file",
  "读取中…": "Reading…",
  "导入预览": "Import preview",
  "模板预览": "Template preview",
  "使用此配置": "Use this configuration",
  "应用后请在本机重新选择模型。": "After applying it, choose models on this device.",
  "性格": "Personality",
  "表达偏好": "Expression style",
  "默认回复语言": "Default reply language",
  "红线规则": "Content boundaries",
  "空": "Empty",
  "导出已保存配置": "Export saved configuration",
  "导出中…": "Exporting…",
  "已导出": "Exported",
  "角色配置文件内容无效": "The character configuration file is invalid",
  "角色配置文件超过大小限制": "The character configuration file exceeds the size limit",
  "角色配置JSON损坏": "The character configuration JSON is malformed",
  "请求字段无效": "The request fields are invalid",
  "角色配置版本不受支持": "This character configuration version is not supported",
  "角色配置无效": "The character configuration is invalid",
  "角色配置缺少必要字段": "The character configuration is missing required fields",
  "角色配置文件无法读取": "The character configuration file could not be read",
  "角色配置文件必须使用UTF-8": "The character configuration file must use UTF-8",
  "角色配置文件无法保存": "The character configuration file could not be saved",
  "角色配置文件名无效": "The character configuration filename is invalid",
  "角色文件对话框无法打开": "The character file dialog could not be opened",
  "角色文件操作正在进行": "A character file operation is already in progress",
  "当前系统不支持角色文件对话框": "Character file dialogs are not supported on this system",
  "名字无效": "The name is invalid",
};

/** T5 可见文案只依赖界面语言，不接触角色配置正文。 */
export function transferText(source: string): string {
  return uiLocale.value === "en" ? english[source] ?? source : source;
}
