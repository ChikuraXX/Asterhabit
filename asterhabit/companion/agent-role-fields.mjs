import {readFileSync} from 'node:fs';
import {containsSecret} from './memory-store.mjs';

const contract=JSON.parse(readFileSync(new URL('../shared/agent-role-contract.json',import.meta.url),'utf8'));

/** Agent管理边界错误；不携带私人正文、数据库路径或凭据。 */
export class AgentError extends Error {constructor(message,code='INVALID_REQUEST'){super(message);this.name='AgentError';this.code=code;}}

/** 严格对象白名单；普通文字不能合并成管理参数。 */
export function exactFields(value,required,optional=[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).some(key=>![...required,...optional].includes(key))||required.some(key=>!Object.hasOwn(value,key)))throw new AgentError('请求字段无效');
}

export const AGENT_ROLE_SCHEMA_VERSION=contract.schemaVersion;
export const AGENT_ROLE_MAX_FILE_BYTES=contract.maxFileBytes;
export const AGENT_ROLE_FIELDS=Object.freeze([...contract.fields]);
export const AGENT_ROLE_LIMITS=Object.freeze({...contract.limits});
export const OPTIONAL_AGENT_ROLE_FIELDS=Object.freeze(AGENT_ROLE_FIELDS.filter(key=>!contract.requiredFields.includes(key)));

/** 保持现有Agent文本语义：UTF-16长度、trim及疑似凭据拒绝。 */
export function validateBoundedAgentText(value,max,label,{empty=false}={}) {
  if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||containsSecret(value))throw new AgentError(label+'无效');
  return value.trim();
}

/** 按共享字段合同验证可移植字段。 */
export function validateAgentText(value,key,{empty=key!=='name'}={}) {
  const max=AGENT_ROLE_LIMITS[key];
  if(!Number.isSafeInteger(max))throw new AgentError('角色字段无效');
  return validateBoundedAgentText(value,max,key==='name'?'名字':'角色配置',{empty});
}

/** 角色可移植字段的唯一规范化边界；缺省可选字段为空，不接受null。 */
export function validateAgentRoleFields(input,{allowMissing=true}={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new AgentError('角色配置无效');
  const result={};
  for(const key of AGENT_ROLE_FIELDS) {
    if(!Object.hasOwn(input,key)) {
      if(key==='name'||!allowMissing)throw new AgentError('角色配置缺少必要字段');
      result[key]='';
      continue;
    }
    result[key]=validateAgentText(input[key],key);
  }
  return result;
}
