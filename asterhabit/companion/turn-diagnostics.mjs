import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {assistantDeltaText} from '../scripts/dialogue-protocol.mjs';
import {classifyGenerationFailure} from './generation-failure.mjs';

const KINDS=new Set(['dialogue','extract','reflection','proactive_plan','proactive_contact','content_select','content_interpret','qq_draft','qq_group_reply','qq_contact_plan']);
const STOPS=new Set(['llm_api_error','end_turn','max_tokens_exceeded','max_steps','requires_approval','cancelled','error','sensitive','content_filter','refusal','tool_calls']);
const ERRORS=new Set(['llm_error','local_backend_error','content_filter','rate_limit_exceeded','context_length_exceeded','invalid_api_key','insufficient_quota','model_not_found','authentication_error','permission_denied','invalid_request_error','server_error','timeout','ETIMEDOUT','ECONNRESET','ECONNREFUSED']);
const EVENTS=new Set(['stream_delta','turn_finished']);
const DELTAS=new Set(['assistant_message','reasoning_message','stop_reason','error_message','usage_statistics','client_tool_start','tool_call_message','refusal','response.refusal.delta','response.refusal.done']);
const BLOCKS=new Set(['text','reasoning','refusal','output_text']);
const OUTCOMES=new Set(['completed','suppressed','incomplete','ack_failed','timeout','cancelled','input_failed','tool_request','too_long']);
const records=new WeakSet();
function allowed(value,values){return value===undefined||value===null?null:values.has(value)?value:'unknown';}
function increment(counts,key){const name=key??'unknown';counts[name]=Math.min((counts[name]??0)+1,Number.MAX_SAFE_INTEGER);}

/**
 * 每次生成的脱敏计数器；只观察已由网关核对会话归属的事件。
 * 外部字符串只允许有限枚举；不保留消息、推理、ID、凭据或原始错误对象。
 * 正文长度为收到的可解析助手文本的UTF-16码元数，含空白/静默标记，不含推理。
 */
export function createTurnDiagnostics(kind,{operationId,model,reasoningEffort,timings={},streamStarted=true,clock=()=>performance.now()}={}){
 const started=clock();let firstAssistantTextMs=null;
 const duration=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.round(value*1000)/1000:null;
 const id=randomUUID(),eventTypes={},deltaTypes={},contentTypes={};
 let stopReason=null,hasError=false,errorCode=null,streamErrorCode=null,assistantTextLength=0,hasNonWhitespaceText=false,terminalSeen=false,snapshot=null;
 let failure=null;
 const observeFailure=value=>{const next=classifyGenerationFailure(value);if(!failure||['generation_failed','local_backend_error'].includes(failure.code))failure=next;};
 return {
  /** 记录本地预检失败；没有收到服务事件时不制造stream_delta或终结计数。 */
  recordFailure(value){if(snapshot)return;hasError=true;observeFailure(value);},
  observe(message){
   if(snapshot)return;
   increment(eventTypes,allowed(message.type,EVENTS));
   if(message.type==='stream_delta'){
    const delta=message.delta;increment(deltaTypes,allowed(delta?.message_type??delta?.type,DELTAS));
    if(Array.isArray(delta?.content))for(const block of delta.content)increment(contentTypes,allowed(block?.type,BLOCKS));
    const text=assistantDeltaText(delta);assistantTextLength=Math.min(assistantTextLength+text.length,Number.MAX_SAFE_INTEGER);hasNonWhitespaceText ||= Boolean(text.trim());
    if(text.trim()&&firstAssistantTextMs===null)firstAssistantTextMs=duration(clock()-started);
    if(delta?.message_type==='error_message'){streamErrorCode=allowed(delta.code??delta.error_type??delta.error?.code,ERRORS);observeFailure(delta);}
   }
   if(message.type==='turn_finished'){
    terminalSeen=true;stopReason=allowed(message.stop_reason,STOPS);hasError=Boolean(message.error);
    errorCode=hasError?allowed(message.error?.code??message.error?.error_type,ERRORS)??'unknown':null;
    if(hasError)observeFailure(message.error);
   }
  },
  /** outcome只由宿主分支决定；重复调用返回同一不可修改快照。 */
  finish(outcome){
   if(snapshot)return snapshot;
   if(!OUTCOMES.has(outcome))throw new TypeError('诊断结果类型无效');
   snapshot=Object.freeze({schemaVersion:2,id,timestamp:new Date().toISOString(),kind:allowed(kind,KINDS)??'unknown',operationId:typeof operationId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(operationId)?operationId:null,modelHash:typeof model==='string'?createHash('sha256').update(model).digest('hex'):null,reasoningEffort:allowed(reasoningEffort,new Set(['none','minimal','low','medium','high','xhigh','max'])),stage:terminalSeen?'terminal':outcome==='timeout'?'timeout':outcome==='cancelled'?'cancelled':outcome==='input_failed'||!streamStarted?'input':'stream',outcome,stopReason,hasError,errorCode:outcome==='timeout'&&!terminalSeen?'ETIMEDOUT':errorCode,streamErrorCode,failureCode:failure?.code??(outcome==='timeout'?'generation_timeout':outcome==='incomplete'&&streamStarted?hasNonWhitespaceText?'incomplete_response':'empty_response':null),httpStatus:failure?.httpStatus??null,retryable:failure?.retryable??null,errorFingerprint:failure?.fingerprint??null,assistantTextLength,hasNonWhitespaceText,eventTypes:Object.freeze({...eventTypes}),deltaTypes:Object.freeze({...deltaTypes}),contentTypes:Object.freeze({...contentTypes})});
   snapshot=Object.freeze({...snapshot,timings:Object.freeze({authenticationSyncMs:duration(timings.authenticationSyncMs),preflightMs:duration(timings.preflightMs),connectionPrepareMs:duration(timings.connectionPrepareMs),sessionCreateMs:duration(timings.sessionCreateMs),firstAssistantTextMs,streamMs:outcome==='input_failed'||!streamStarted?null:duration(clock()-started),cleanupMs:null})});records.add(snapshot);return snapshot;
  },
 };
}

/** 原生清理完成后补充同一条诊断，毫秒使用单调时钟；不新增正文或错误原文。 */
export function withCleanupTiming(record,elapsed){if(!records.has(record)||typeof elapsed!=='number'||!Number.isFinite(elapsed)||elapsed<0)throw new TypeError('清理计时无效');const next=Object.freeze({...record,timings:Object.freeze({...record.timings,cleanupMs:Math.round(elapsed*1000)/1000})});records.add(next);return next;}

/**
 * 同步保存已脱敏的不可伪造快照，SQLite事务保证多宿主写入和最近256条保留一致。
 * filename由宿主固定配置；不接受外部记录。失败交给网关发一次固定告警，不改变生成结果。
 */
export function writeTurnDiagnostic(filename,record){
 if(!records.has(record))throw new TypeError('未知诊断快照');
 mkdirSync(path.dirname(filename),{recursive:true});
 const db=new DatabaseSync(filename);
 try{
  db.exec('PRAGMA busy_timeout=200; CREATE TABLE IF NOT EXISTS turn_diagnostics(sequence INTEGER PRIMARY KEY AUTOINCREMENT, record_json TEXT NOT NULL);');
  db.exec('BEGIN IMMEDIATE');
  try{const existing=db.prepare("SELECT sequence FROM turn_diagnostics WHERE json_extract(record_json,'$.id')=? LIMIT 1").get(record.id);if(existing)db.prepare('UPDATE turn_diagnostics SET record_json=? WHERE sequence=?').run(JSON.stringify(record),existing.sequence);else db.prepare('INSERT INTO turn_diagnostics(record_json) VALUES (?)').run(JSON.stringify(record));db.exec('DELETE FROM turn_diagnostics WHERE sequence NOT IN (SELECT sequence FROM turn_diagnostics ORDER BY sequence DESC LIMIT 256)');db.exec('COMMIT');}
  catch(error){db.exec('ROLLBACK');throw error;}
 }finally{db.close();}
}
