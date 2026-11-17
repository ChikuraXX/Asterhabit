import {createTurnDiagnostics,withCleanupTiming,writeTurnDiagnostic} from './turn-diagnostics.mjs';
import {randomUUID} from 'node:crypto';
import {existsSync,readdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {CodexClient,codexError} from './codex-client.mjs';
import {prepareCodexEnvironment,readCodexAuthentication,verifiedCodexExecutable} from './codex-environment.mjs';
import {generationInstructions} from './generation-instructions.mjs';
import {dialogueMessages} from './dialogue-input.mjs';
import {ModelGenerationError,classifyGenerationFailure} from './generation-failure.mjs';
import {codexProcessIdentity,stopOwnedCodexProcess} from './codex-process-owner.mjs';
import {ModelRefusalError,isRefusalText} from './reply-suppression.mjs';

const REFLECTIVE=new Set(['reflection','proactive_plan','proactive_contact','content_browse','content_select','content_interpret']);
const RUN_ID=/^codex-([0-9a-f-]{36})$/;
const cleanCreationFailures=new WeakSet();
const activeConnections=new Set();
function modelId(handle){
 if(typeof handle!=='string'||! /^(?:openai-codex|chatgpt-plus-pro|codex)\/[^\s]+$/.test(handle))throw new Error('当前执行后端只支持Codex模型，请重新选择模型');
 return handle.slice(handle.indexOf('/')+1);
}
function alive(pid){if(!Number.isInteger(pid)||pid<1)return true;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}

/** 恢复所有自有临时连接，包含目录查询；未知身份只撤下磁盘凭据并保留恢复证据。 */
export function recoverCodexConnections({state,powershellDirectory,isAlive=alive,readIdentity=codexProcessIdentity,stopOwned=stopOwnedCodexProcess,activeIds=activeConnections}){
 const root=path.join(state,'runtime','codex');if(!existsSync(root))return;
 for(const entry of readdirSync(root,{withFileTypes:true})){
  if(!RUN_ID.test(entry.name)||!entry.isDirectory()||entry.isSymbolicLink())continue;
  const directory=path.join(root,entry.name),file=path.join(directory,'owner.json');
  if(!existsSync(file)){rmSync(path.join(directory,'home','auth.json'),{force:true});throw new Error('Codex连接创建记录不完整，请核实恢复');}
  let owner;
  try{owner=JSON.parse(readFileSync(file,'utf8'));if(!Number.isInteger(owner.pid)||owner.pid<1||!Number.isInteger(owner.childPid)||owner.childPid<1||!/^\d+$/.test(owner.parentStart??'')||!/^\d+$/.test(owner.childStart??''))throw new Error();}
  catch{rmSync(path.join(directory,'home','auth.json'),{force:true});throw new Error('Codex连接身份记录无效，请核实恢复');}
  if(!isAlive(owner.childPid)){rmSync(directory,{recursive:true,force:true});continue;}
  if(owner.pid===process.pid&&activeIds.has(entry.name))continue;
  if(owner.pid!==process.pid&&isAlive(owner.pid)){
   const actual=readIdentity(owner.pid,powershellDirectory);
   if(!actual||!owner.parentStart||actual===owner.parentStart)continue;
  }
  rmSync(path.join(directory,'home','auth.json'),{force:true});
  if(isAlive(owner.childPid))stopOwned(owner,powershellDirectory);
  rmSync(directory,{recursive:true,force:true});
 }
}

/** Codex受限生成适配器；复用原有租约接口，平台动作仍由业务宿主执行。 */
export class CodexRuntime {
 #clock;#diagnosticWriter;#diagnosticWarning=false;
 #root;#state;#options;#runs=new Map();#closed=false;#ready=false;#identity;#factory;#authenticate;#timeout;#pending=new Set();#closePromise;
 constructor({root,state,model,dialogueModel=model,dialogueReasoningEffort='low',reflectionModel=null,reflectionReasoningEffort=null,persona='',replyLanguage='',sourceAuthPath,codexExecutable,codexExecutableSha256,powershellDirectory,authentication,connectionFactory,authenticate,timeoutMs=60000,clock=()=>performance.now(),diagnosticWriter=writeTurnDiagnostic}){
  for(const handle of [model,dialogueModel,reflectionModel].filter(Boolean))if(typeof handle!=='string')throw new TypeError('模型配置无效');
  this.#clock=clock;this.#diagnosticWriter=diagnosticWriter;this.#root=root;this.#state=state;this.#timeout=timeoutMs;
  this.#options={model,dialogueModel,dialogueReasoningEffort,reflectionModel,reflectionReasoningEffort,persona,replyLanguage,codexExecutable,codexExecutableSha256,powershellDirectory,sourceAuthPath:sourceAuthPath??path.join(process.env.CODEX_HOME??path.join(process.env.USERPROFILE??process.env.HOME,'.codex'),'auth.json')};
  this.#authenticate=authenticate??(()=>{const auth=authentication?authentication.authorizeSnapshot():readCodexAuthentication(this.#options.sourceAuthPath,this.#identity);this.#identity??=auth.identity;return auth;});
  this.#factory=connectionFactory??(id=>this.#open(id));
 }
 /** 诊断失败只告警一次，不改变模型结果或资源清理。 */
 #saveDiagnostic(record){try{this.#diagnosticWriter(path.join(this.#state,'diagnostics','codex-turns.sqlite'),record);}catch{if(!this.#diagnosticWarning){this.#diagnosticWarning=true;console.error('Codex耗时诊断写入失败；生成结果不受影响');}}}
 #inputDiagnostic(kind,metrics,error,reason){const cancelled=error?.code==='CANCELLED'||reason==='cancelled';const d=createTurnDiagnostics(kind,{...metrics,streamStarted:false,model:this.modelForTask(kind),reasoningEffort:this.#effort(kind),clock:this.#clock});if(error&&!cancelled)d.recordFailure(error);const record=d.finish(cancelled?'cancelled':error?'input_failed':'incomplete');this.#saveDiagnostic(record);return record;}
 get connected(){return this.#ready&&!this.#closed;}
 modelForTask(kind){return REFLECTIVE.has(kind)?this.#options.reflectionModel??this.#options.dialogueModel:kind==='extract'?this.#options.model:this.#options.dialogueModel;}
 preflight(){if(this.#closed)throw codexError('CODEX_EXITED');this.#authenticate();}
 async prepare(signal){if(signal?.aborted)throw codexError('CANCELLED');this.preflight();this.#ready=true;}
 #directory(id){if(!RUN_ID.test(id))throw new Error('Codex租约标识无效');return path.join(this.#state,'runtime','codex',id);}
 async #open(id){
  recoverCodexConnections({state:this.#state,powershellDirectory:this.#options.powershellDirectory});
  this.preflight();const directory=this.#directory(id),command=verifiedCodexExecutable(this.#options.codexExecutable,this.#options.codexExecutableSha256);
  const authorizedSnapshot=this.#authenticate();
  const prepared=prepareCodexEnvironment({directory,sourceAuthPath:this.#options.sourceAuthPath,expectedIdentity:this.#identity,authorizedSnapshot});this.#identity??=prepared.identity;
  let client;
  try{
   client=new CodexClient({command,cwd:prepared.cwd,env:prepared.env});
   activeConnections.add(id);
   const connection={client,cwd:prepared.cwd,identity:prepared.identity,cleanup:async()=>{rmSync(directory,{recursive:true,force:true});activeConnections.delete(id);}};
   this.#runs.set(id,{...connection,id,active:false});
   const owner={pid:process.pid,parentStart:codexProcessIdentity(process.pid,this.#options.powershellDirectory),childPid:client.pid,childStart:codexProcessIdentity(client.pid,this.#options.powershellDirectory)};
   writeFileSync(path.join(directory,'owner.json'),JSON.stringify(owner),{mode:0o600});
   if(!owner.parentStart||!owner.childStart)throw new Error('Codex进程身份未确认，已停止启动');
   await client.request('initialize',{clientInfo:{name:'asterhabit',title:'Asterhabit',version:'0.1.0'},capabilities:{experimentalApi:true}});client.notify('initialized');
   return connection;
  }catch(error){try{if(client)await client.close();rmSync(directory,{recursive:true,force:true});this.#runs.delete(id);if(error&&typeof error==='object')cleanCreationFailures.add(error);}finally{activeConnections.delete(id);rmSync(path.join(directory,'home','auth.json'),{force:true});}throw error;}
 }
 /** 原none/minimal档位在Codex目录不提供；显式映射为最低low，不替换模型。 */
 #effort(kind){const value=kind==='extract'?'low':REFLECTIVE.has(kind)?this.#options.reflectionReasoningEffort??this.#options.dialogueReasoningEffort:this.#options.dialogueReasoningEffort;return ['none','minimal'].includes(value)?'low':value;}
 async create({kind,lease,onCreationFailed=()=>{},operationId,preflightMs,authenticationSyncMs}){
  const metrics={operationId,timings:{preflightMs,authenticationSyncMs,connectionPrepareMs:null,sessionCreateMs:null}};
  let instructions;
  try{modelId(this.modelForTask(kind));this.preflight();instructions=generationInstructions({kind,persona:this.#options.persona,replyLanguage:this.#options.replyLanguage});}catch(error){this.#inputDiagnostic(kind,metrics,error);onCreationFailed();throw error;}
  const id='codex-'+randomUUID();let connection;const preparing=this.#clock();
  try{connection=await this.#factory(id);metrics.timings.connectionPrepareMs=this.#clock()-preparing;}catch(error){metrics.timings.connectionPrepareMs=this.#clock()-preparing;this.#inputDiagnostic(kind,metrics,error);if(cleanCreationFailures.has(error)||!existsSync(this.#directory(id)))onCreationFailed();throw error;}
  const run={...connection,id,kind,lease,metrics,record:null,active:false,threadId:null,cancel:null};this.#runs.set(id,run);
  try{
   if(this.#closed)throw codexError('CODEX_EXITED');
   const sessionStarted=this.#clock();let result;try{result=await run.client.request('thread/start',{model:modelId(this.modelForTask(kind)),modelProvider:'openai',allowProviderModelFallback:false,cwd:run.cwd,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',baseInstructions:instructions,developerInstructions:'只完成本次文本生成任务，不调用工具。',dynamicTools:[],environments:[],config:{model_reasoning_effort:this.#effort(kind)}});}finally{metrics.timings.sessionCreateMs=this.#clock()-sessionStarted;}
   run.threadId=result.thread?.id;
   if(typeof run.threadId!=='string'||result.model!==modelId(this.modelForTask(kind))||result.approvalPolicy!=='never'||result.sandbox?.type!=='readOnly'||result.sandbox.networkAccess!==false||(result.instructionSources??[]).length)throw codexError('CODEX_PROTOCOL_ERROR');
   this.#ready=true;return {agent_id:id,conversation_id:run.threadId};
  }catch(error){run.record=this.#inputDiagnostic(kind,metrics,error);await this.destroy({agent_id:id,conversation_id:run.threadId});onCreationFailed();throw error;}
 }
 /** 只收当前线程文本；完成事件与进程状态成立后才把正文交给记忆事务。 */
 async complete(runtime,prompt,_consumer,{signal,onDelta}={}){
  const run=this.#runs.get(runtime?.agent_id);
  if(!run||run.threadId!==runtime.conversation_id||run.active)throw codexError('CODEX_PROTOCOL_ERROR');
  try{this.preflight();if(signal?.aborted)throw codexError('CANCELLED');}catch(error){run.record=this.#inputDiagnostic(run.kind,run.metrics,error);throw error;}run.active=true;
  const diagnostic=createTurnDiagnostics(run.kind,{...run.metrics,model:this.modelForTask(run.kind),reasoningEffort:this.#effort(run.kind),clock:this.#clock});
  const messages=typeof prompt==='string'?[{role:'user',content:prompt}]:dialogueMessages(prompt);
  const input=messages.map(message=>({type:'text',text:message.content,text_elements:[]}));
  const operation=new Promise((resolve,reject)=>{
   let text='',settled=false,timer,offFailure=()=>{};
   const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);off();offFailure();signal?.removeEventListener('abort',abort);run.active=false;run.cancel=null;if(error)diagnostic.recordFailure(error);const outcome=!error?'completed':error.code==='CANCELLED'?'cancelled':error.code==='CODEX_TIMEOUT'?'timeout':error instanceof ModelRefusalError?'suppressed':'incomplete';run.record=diagnostic.finish(outcome);this.#saveDiagnostic(run.record);if(error)reject(error);else resolve(text);};
   const abort=()=>finish(codexError('CANCELLED'));run.cancel=abort;
   const off=run.client.onNotification(({method,params})=>{
    if(params?.threadId!==run.threadId)return;
    if(method==='item/agentMessage/delta'){
     if(typeof params.delta==='string')diagnostic.observe({type:'stream_delta',delta:{message_type:'assistant_message',content:params.delta}});
     if(typeof params.delta!=='string')return finish(codexError('CODEX_PROTOCOL_ERROR'));
     text+=params.delta;if(text.length>12000)return finish(codexError('CODEX_PROTOCOL_ERROR'));onDelta?.(params.delta);
    }
    if(method==='item/started'&&!['userMessage','agentMessage','reasoning'].includes(params.item?.type))finish(codexError('CODEX_PROTOCOL_ERROR'));
    if(method==='turn/completed'){
     diagnostic.observe({type:'turn_finished',stop_reason:params.turn?.status==='completed'?'end_turn':'error',error:params.turn?.error??null});
     if(params.turn?.status!=='completed'||params.turn.error)return finish(new ModelGenerationError(classifyGenerationFailure(params.turn?.error??{}),null));
     if(!text.trim())return finish(new ModelGenerationError({code:'empty_output'},null));
     if(isRefusalText(text))return finish(new ModelRefusalError());
     try{this.preflight();finish();}catch(error){finish(error);}
    }
   });
   offFailure=run.client.onFailure?.(finish)??(()=>{});
   if(settled)return;
   timer=setTimeout(()=>finish(codexError('CODEX_TIMEOUT')),this.#timeout);signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted){abort();return;}
   run.client.request('turn/start',{threadId:run.threadId,input,effort:this.#effort(run.kind),environments:[]},{signal}).catch(finish);
  });
  this.#pending.add(operation);
  try{return await operation;}catch(error){await run.client.close();if(error.failureCode&&!(error instanceof ModelGenerationError))throw new ModelGenerationError({code:error.failureCode},null);throw error;}finally{this.#pending.delete(operation);}
 }
 /** 仅在自有进程退出后确认清理；未知旧租约不得被当成已删除。 */
 async destroy(runtime,{onRemoteDeleted=()=>{},reason}={}){
  const run=this.#runs.get(runtime?.agent_id);
  if(run){run.cancel?.();if(!run.record&&run.kind)run.record=this.#inputDiagnostic(run.kind,run.metrics,null,reason);const cleanupStarted=this.#clock();try{await run.client.close();await run.cleanup();this.#runs.delete(runtime.agent_id);if(run.record){const elapsed=this.#clock()-cleanupStarted;if(Number.isFinite(elapsed)&&elapsed>=0)run.record=withCleanupTiming(run.record,elapsed);this.#saveDiagnostic(run.record);}onRemoteDeleted();}finally{rmSync(path.join(this.#directory(run.id),'home','auth.json'),{force:true});}return;}
  const directory=this.#directory(runtime?.agent_id);
  if(existsSync(directory)){
   const owner=JSON.parse(readFileSync(path.join(directory,'owner.json'),'utf8'));
   if(alive(owner.childPid)){if(alive(owner.pid)){const start=codexProcessIdentity(owner.pid,this.#options.powershellDirectory);if(!start||!owner.parentStart||start===owner.parentStart)throw new Error('Codex历史执行宿主仍可能存活，请先核实恢复');}stopOwnedCodexProcess(owner,this.#options.powershellDirectory);}
   rmSync(directory,{recursive:true,force:true});
  }
  onRemoteDeleted();
 }
 /** 目录来自Codex自身，不把其他API品牌句柄自动映射到Codex。 */
 async listModels(){
  this.preflight();const id='codex-'+randomUUID(),connection=await this.#factory(id);this.#runs.set(id,{...connection,id,active:false});
  try{
   const entries=[],cursors=new Set();let cursor=null;
   do{const result=await connection.client.request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});if(!Array.isArray(result.data))throw codexError('CODEX_PROTOCOL_ERROR');
    for(const item of result.data)entries.push({handle:'openai-codex/'+item.model,label:item.displayName??item.model,provider:'chatgpt_oauth',reasoningEfforts:[...new Set(item.supportedReasoningEfforts.flatMap(option=>option.reasoningEffort==='low'?['none','minimal','low']:[option.reasoningEffort]))].filter(value=>['none','minimal','low','medium','high','xhigh','max'].includes(value))});
    cursor=result.nextCursor??null;if(cursor&&cursors.has(cursor)||entries.length>1000)throw codexError('CODEX_PROTOCOL_ERROR');if(cursor)cursors.add(cursor);
   }while(cursor);this.#ready=true;return {entries};
  }finally{await this.destroy({agent_id:id});}
 }
 async modelConnection(action){if(action==='list')return {connections:[],available:false};const error=new Error('当前后端仅支持Codex，API连接配置已保留，暂不可修改');error.code='NOT_READY';throw error;}
 close(){if(this.#closePromise)return this.#closePromise;this.#closed=true;for(const run of this.#runs.values())run.cancel?.();this.#closePromise=(async()=>{await Promise.allSettled([...this.#pending]);const results=await Promise.allSettled([...this.#runs.values()].map(run=>this.destroy({agent_id:run.id,conversation_id:run.threadId})));const failures=results.filter(result=>result.status==='rejected');if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'Codex进程清理未全部完成');})();return this.#closePromise;}
}
