export const SILENT_REFUSAL_MARKER='[[KONATSU_SILENT_REFUSAL]]';

const REFUSAL_ERROR_MESSAGES=new Set([
  'The model refused to complete the request',
  'Provider finish_reason: content_filter',
  'Provider stopped with: sensitive'
]);

/** 表示模型明确拒绝本次请求；错误对象只保留固定诊断，不接收或保存模型正文。 */
export class ModelRefusalError extends Error {
  constructor() {
    super('模型拒绝完成本次请求');
    this.name='ModelRefusalError';
  }
}

function explicitErrorMessage(value) {
  return typeof value==='string'&&REFUSAL_ERROR_MESSAGES.has(value.trim());
}

function refusalContent(content) {
  const blocks=Array.isArray(content)?content:[content];
  return blocks.some(block=>block&&typeof block==='object'
    &&(block.type==='refusal'||block.message_type==='refusal'
      ||typeof block.refusal==='string'&&block.refusal.trim().length>0));
}

/**
 * 只识别提供方的明确结构化拒答字段；不会解析普通 content 字符串，也不会递归搜索任意元数据。
 */
export function isRefusalSignal(value) {
  if(!value||typeof value!=='object')return false;
  if(value.type==='response.refusal.delta'||value.type==='response.refusal.done'
    ||value.type==='refusal'||value.message_type==='refusal')return true;
  if(typeof value.refusal==='string'&&value.refusal.trim())return true;
  if(['content_filter','refusal'].includes(value.finish_reason)
    ||['sensitive','content_filter','refusal'].includes(value.stop_reason))return true;
  if(value.error&&typeof value.error==='object'&&value.error.code==='content_filter')return true;
  if(explicitErrorMessage(value.message)||explicitErrorMessage(value.errorMessage)
    ||explicitErrorMessage(value.error?.message)||explicitErrorMessage(value.error?.errorMessage))return true;
  return Boolean(value.content&&typeof value.content==='object'&&refusalContent(value.content));
}

function quotedRefusalExample(text) {
  const containsTemplate=/(?:不能|无法|拒绝|婉拒).{0,30}(?:请求|要求)|\b(?:can't|cannot|unable\s+to|decline|refuse)\b.{0,60}\b(?:request|help|assist|comply|provide)\b/i.test(text);
  if(!containsTemplate)return false;
  const chineseLead=/^(?:例如|举例(?:来说)?|作为例子|例句|示例|请把|请翻译|(?:这篇|该篇|这份|该份)?(?:文档|文章|指南)|我(?:之前|刚才|前面)说过|前文|上文|以下(?:是|为)?(?:引用|例句)|引用)/.test(text);
  const englishLead=/^(?:for\s+example|e\.g\.|as\s+an\s+example|in\s+this\s+example|please\s+translate|(?:the|this)\s+(?:guide|document|article)|i\s+(?:previously|earlier)\s+said|earlier|above|the\s+(?:quoted\s+)?phrase)\b/i.test(text);
  const quotedLead=/^[“"「『].{0,180}[”"」』]\s*(?:is|was|是|属于|作为).{0,60}(?:example|template|refusal|例句|示例|模板|拒答)/is.test(text);
  return chineseLead||englishLead||quotedLead;
}

/** 仅识别回复明确给出的运行能力失败原因，不按网络、工具或权限词本身推断。 */
function explicitCapabilityLimitation(text) {
  const normalized=text.replaceAll('’',"'");
  const englishCause=/\b(?:because|since|as|due\s+to)\b([\s\S]{0,180})/i.exec(normalized)?.[1];
  if(englishCause) {
    const missing=/\b(?:i|we|this\s+(?:environment|system|session)|the\s+(?:environment|system|session))\s+(?:(?:do\s+not|don't|does\s+not|doesn't)\s+have|(?:have|has)\s+no|(?:do\s+not|don't|does\s+not|doesn't|cannot|can't)\s+(?:access|use|reach|connect(?:\s+to)?)|lack(?:s|ing)?)\s+(?:the\s+)?(?:(?:required|necessary|needed|available)\s+)?(?:network(?:\s+access)?|internet(?:\s+access)?|tools?|permissions?|authorization|access)\b/i.test(englishCause);
    const unavailable=/^(?:\s*of\s+)?(?:an?\s+)?(?:network\s+|connection\s+|provider\s+)?timeout\b|\b(?:connection|network\s+request|request|service|provider)\s+(?:timed\s+out|is\s+unavailable|was\s+unavailable|failed)\b|\b(?:network|internet|tool)\s+access\s+(?:is|was)\s+unavailable\b|\bno\s+(?:(?:required|necessary|available)\s+)?tools?\s+(?:are|were)\s+available\b/i.test(englishCause);
    if(missing||unavailable)return true;
  }

  const chineseCause=/(?:因为|由于|原因是|是因为)([\s\S]{0,120})/.exec(text)?.[1];
  if(!chineseCause)return false;
  const missing=/(?:我|我们|当前|目前|本环境|这个环境|系统)?(?:没有|缺少|不具备|无).{0,16}(?:网络|联网|工具|权限|授权|访问能力)|(?:未获得|未被授予).{0,24}(?:权限|授权)|(?:当前|目前|本环境|这个环境|系统)?(?:无法|不能)(?:联网|访问网络|连接(?:网络|服务)|使用.{0,8}工具)/.test(chineseCause);
  const unavailable=/(?:连接|网络请求|网络访问|请求|服务|工具)(?:已经)?(?:超时|不可用|缺失|连接失败)/.test(chineseCause);
  return missing||unavailable;
}

/**
 * 保守识别完整回复中的规范拒答措辞。
 * 仅排除明确说明运行能力失败的文本；这不是通用语义审核，也不保证覆盖所有提供方措辞。
 */
export function isRefusalText(text) {
  if(typeof text!=='string')return false;
  const trimmed=text.trim();
  if(!trimmed)return false;
  if(trimmed===SILENT_REFUSAL_MARKER)return true;

  const normalized=trimmed.replaceAll('’',"'");
  if(explicitCapabilityLimitation(trimmed))return false;
  if(/^(?:i(?:'m| am)\s+sorry[,;:]?\s*)?(?:but\s+)?i(?:\s+can(?:not|'t)|(?:\s+am|'m)\s+unable\s+to|\s+won't)\s+(?:help|assist|comply)\s+with\s+(?:this|that)(?:\s+request)?\b/i.test(normalized)
    ||/^i\s+(?:must|have\s+to)\s+(?:decline|refuse)\s+(?:this|that|the)\s+request\b/i.test(normalized)
    ||/^i(?:\s+can(?:not|'t)|(?:\s+am|'m)\s+unable\s+to)\s+provide\s+(?:instructions?|guidance|details?|information|assistance)\s+(?:for|on|about)\s+(?:this|that|the)\s+request\b/i.test(normalized)
    ||/^(?:(?:抱歉|对不起)[，,。；;\s]*)?(?:但(?:是)?[，,\s]*)?我?(?:不能|无法|不可以)(?:为你)?(?:帮助|协助|配合|满足|回答|回应)(?:你)?(?:完成|处理)?(?:这个|该|这一|上述|这项|该项)?(?:请求|要求)/.test(trimmed)
    ||/^(?:(?:抱歉|对不起)[，,。；;\s]*)?我?(?:不能|无法)(?:帮|帮助|协助)(?:你)?(?:绕过|规避).{0,24}(?:权限|授权|校验|访问控制)/.test(trimmed)
    ||/^我(?:必须|需要|只能)(?:拒绝|婉拒)(?:这个|该|这一)?(?:请求|要求)/.test(trimmed))return true;

  if(quotedRefusalExample(trimmed))return false;

  const englishSafetyLead=/^(?:(?:because|since|as)\s+)?(?:this|that|the)?\s*(?:request|instructions?|content|topic)\b/i.test(normalized);
  const englishRequest=/\b(?:request|instructions?|content|topic)\b/i.test(normalized);
  const englishSafety=/\b(?:safety|safer|unsafe|harm|harmful|dangerous|sensitive)\b/i.test(normalized);
  const englishRefusal=/\bi(?:\s+can(?:not|'t)|(?:\s+am|'m)\s+unable\s+to|\s+won't)\s+(?:help|assist|comply|provide|continue)\b/i.test(normalized)
    ||/\bi\s+(?:must|have\s+to)\s+(?:decline|refuse)\b/i.test(normalized);
  if(englishSafetyLead&&englishRequest&&englishSafety&&englishRefusal)return true;

  const chineseSafetyLead=/^(?:(?:由于|因为)[，,\s]*)?(?:这个|该|这一)?(?:请求|要求|话题|内容)/.test(trimmed);
  const chineseRequest=/(?:请求|要求|这个话题|该话题|这一话题|相关内容)/.test(trimmed);
  const chineseSafety=/(?:安全(?:原因|风险|话题)|可能(?:会)?造成伤害|有害|危险|敏感)/.test(trimmed);
  const chineseRefusal=/(?:我)?(?:不能|无法|不可以)(?:提供|帮助|协助|继续|处理|回答)|(?:拒绝|婉拒)(?:这个|该|这一)?(?:请求|要求)/.test(trimmed);
  const chineseSwitch=/(?:换个|更换|转到|转向)(?:一个|其他|别的)?(?:更安全|安全)(?:的)?(?:话题|主题)|(?:换个|更换)(?:话题|主题)/.test(trimmed);
  return chineseSafetyLead&&chineseRequest&&chineseSafety&&(chineseRefusal||chineseSwitch);
}
