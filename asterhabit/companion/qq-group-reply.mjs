import {QQError} from './qq-store.mjs';

/** 只接受单次群聊决策；quiet不携带正文，reply仅允许最多2000字符正文，不授予目标或群管理能力。 */
export function parseQQGroupReply(value){
  let result;try{result=JSON.parse(value);}catch{throw new QQError('QQ群聊决策响应无效','INVALID_DECISION');}
  if(!result||typeof result!=='object'||Array.isArray(result))throw new QQError('QQ群聊决策响应无效','INVALID_DECISION');
  const keys=Object.keys(result);
  if(result.decision==='quiet'&&keys.length===1)return {decision:'quiet'};
  if(result.decision!=='reply'||keys.length!==2||!Object.hasOwn(result,'text')||typeof result.text!=='string'||!result.text.trim()||result.text.trim().length>2000||/<qqbot-at-everyone\b|<@all>/iu.test(result.text))throw new QQError('QQ群聊决策响应无效','INVALID_DECISION');
  return {decision:'reply',text:result.text.trim()};
}
