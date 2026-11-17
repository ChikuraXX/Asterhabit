import {
  AGENT_ROLE_FIELDS,
  AGENT_ROLE_MAX_FILE_BYTES,
  AGENT_ROLE_SCHEMA_VERSION,
  AgentError,
  exactFields,
  validateAgentRoleFields,
} from './agent-role-fields.mjs';

const transferFields=['schemaVersion',...AGENT_ROLE_FIELDS];

/** 导入只解析固定角色字段；不接受路径、模型、权限或任意对象合并。 */
export function parseAgentProfile(text) {
  if(typeof text!=='string')throw new AgentError('角色配置文件内容无效','INVALID_FILE');
  if(Buffer.byteLength(text,'utf8')>AGENT_ROLE_MAX_FILE_BYTES)throw new AgentError('角色配置文件超过大小限制','FILE_TOO_LARGE');
  let parsed;
  try{parsed=JSON.parse(text);}catch{throw new AgentError('角色配置JSON损坏','INVALID_JSON');}
  exactFields(parsed,['schemaVersion','name'],transferFields.filter(key=>!['schemaVersion','name'].includes(key)));
  if(parsed.schemaVersion!==AGENT_ROLE_SCHEMA_VERSION)throw new AgentError('角色配置版本不受支持','UNSUPPORTED_SCHEMA');
  const {schemaVersion:_,...fields}=parsed;
  return {schemaVersion:AGENT_ROLE_SCHEMA_VERSION,...validateAgentRoleFields(fields)};
}

/** 导出显式投影白名单，绝不序列化完整Agent或运行状态。 */
export function exportAgentProfile(agent) {
  const configuration={schemaVersion:AGENT_ROLE_SCHEMA_VERSION,...validateAgentRoleFields(agent)};
  const basename=configuration.name.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'-').replace(/[. ]+$/g,'').slice(0,48)||'agent-role';
  return {configuration,json:JSON.stringify(configuration,null,2)+'\n',filename:`Asterhabit-${basename}.asterhabit-role.json`};
}

/** 内置模板仅是中性可编辑起点，不包含用户数据、模型或权限。 */
export const AGENT_ROLE_TEMPLATES=Object.freeze([
  Object.freeze({id:'blank',label:Object.freeze({'zh-CN':'空白模板',en:'Blank'}),configuration:Object.freeze({schemaVersion:AGENT_ROLE_SCHEMA_VERSION,name:'新角色',nickname:'',persona:'',personality:'',expressionStyle:'',replyLanguage:'',contentBoundaries:''})}),
  Object.freeze({id:'reading',label:Object.freeze({'zh-CN':'阅读伙伴',en:'Reading companion'}),configuration:Object.freeze({schemaVersion:AGENT_ROLE_SCHEMA_VERSION,name:'阅读伙伴',nickname:'',persona:'',personality:'耐心、好奇，能够表达不同理解',expressionStyle:'围绕文本具体讨论，避免空泛总结',replyLanguage:'',contentBoundaries:''})}),
  Object.freeze({id:'concise',label:Object.freeze({'zh-CN':'简洁伙伴',en:'Concise companion'}),configuration:Object.freeze({schemaVersion:AGENT_ROLE_SCHEMA_VERSION,name:'简洁伙伴',nickname:'',persona:'',personality:'坦率、稳重',expressionStyle:'先说结论，使用简洁自然的表达',replyLanguage:'',contentBoundaries:''})}),
]);

/** 返回独立副本，避免调用方修改进程内模板。 */
export function agentRoleTemplates(){return AGENT_ROLE_TEMPLATES.map(template=>({id:template.id,label:{...template.label},configuration:{...template.configuration}}));}
