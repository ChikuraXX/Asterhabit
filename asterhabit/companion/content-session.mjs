import {releaseNativeExecution,confirmNativeExecution,discardNativeExecution} from './native-execution-lifecycle.mjs';
import {MemoryError} from './memory-store.mjs';
import {ModelRefusalError,isRefusalText} from './reply-suppression.mjs';

const MODEL_KINDS=Object.freeze({select:'content_select',interpret:'content_interpret'});
const MATERIAL_KINDS=new Set(['description','subtitle','comment']);
const BVID=/^BV[A-Za-z0-9]{10}$/u;

function exactObject(value,fields,label) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new MemoryError(label+'无效');
  const keys=Object.keys(value);
  if(keys.length!==fields.length||keys.some(key=>!fields.includes(key)))throw new MemoryError(label+'含未允许字段');
  return value;
}
function nonEmpty(value,label) {
  if(typeof value!=='string'||!value.trim())throw new MemoryError(label+'无效');
  return value.trim();
}
function boundedText(value,max,label) {
  const result=nonEmpty(value,label);
  if(value.length>max)throw new MemoryError(label+'无效');
  return result;
}
function checkSignal(signal) {
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw new MemoryError('停止信号无效');
  if(signal?.aborted)throw new MemoryError('本轮已停止');
}
function waitWithSignal(value,signal) {
  checkSignal(signal);const pending=Promise.resolve(value);
  if(!signal)return pending;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(operation,result)=>{if(settled)return;settled=true;signal.removeEventListener('abort',aborted);operation(result);};
    const aborted=()=>finish(reject,new MemoryError('本轮已停止'));
    signal.addEventListener('abort',aborted,{once:true});
    pending.then(value=>finish(resolve,value),error=>finish(reject,error));
    if(signal.aborted)aborted();
  });
}
function reservation(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='runId')||typeof value.runId!=='string'||!value.runId.trim())throw new MemoryError('应用内容模型额度预留未确认');
  return value.runId;
}
function candidate(value,creatorIds) {
  exactObject(value,['bvid','title','creatorId','durationSeconds'],'候选');
  if(!BVID.test(value.bvid))throw new MemoryError('候选 BVID 无效');
  const result={bvid:value.bvid,title:boundedText(value.title,300,'候选标题'),creatorId:boundedText(value.creatorId,200,'候选作者'),durationSeconds:value.durationSeconds};
  if(!Number.isInteger(result.durationSeconds)||result.durationSeconds<1||result.durationSeconds>86400)throw new MemoryError('候选时长无效');
  if(creatorIds.length&&!creatorIds.includes(result.creatorId))throw new MemoryError('候选作者不在读取范围');
  return Object.freeze(result);
}
function candidates(value,creatorIds) {
  exactObject(value,['candidates'],'发现结果');
  if(!Array.isArray(value.candidates)||value.candidates.length>10)throw new MemoryError('候选列表无效');
  const result=value.candidates.map(item=>candidate(item,creatorIds));
  if(new Set(result.map(item=>item.bvid)).size!==result.length)throw new MemoryError('候选 BVID 重复');
  return Object.freeze(result);
}
function material(value,durationSeconds) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new MemoryError('观察材料无效');
  const allowed=['id','kind','text','startSeconds','endSeconds'];
  if(Object.keys(value).some(key=>!allowed.includes(key)))throw new MemoryError('观察材料含未允许字段');
  const result={id:boundedText(value.id,100,'材料标识'),kind:value.kind,text:boundedText(value.text,6000,'材料正文')};
  if(!MATERIAL_KINDS.has(result.kind))throw new MemoryError('材料类型无效');
  const hasStart=Object.hasOwn(value,'startSeconds'),hasEnd=Object.hasOwn(value,'endSeconds');
  if(hasStart!==hasEnd)throw new MemoryError('材料时间范围无效');
  if(hasStart) {
    if(!Number.isFinite(value.startSeconds)||!Number.isFinite(value.endSeconds)||value.startSeconds<0||value.endSeconds<value.startSeconds||value.endSeconds>durationSeconds)throw new MemoryError('材料时间范围无效');
    result.startSeconds=value.startSeconds;result.endSeconds=value.endSeconds;
  }
  return Object.freeze(result);
}
function observed(value,expectedCandidate) {
  exactObject(value,['bvid','materials'],'观察结果');
  if(value.bvid!==expectedCandidate.bvid)throw new MemoryError('观察结果与候选不一致');
  if(!Array.isArray(value.materials)||value.materials.length>20)throw new MemoryError('观察材料列表无效');
  const result=value.materials.map(value=>material(value,expectedCandidate.durationSeconds));
  if(new Set(result.map(item=>item.id)).size!==result.length||result.map(item=>item.text).join('\n').length>6000)throw new MemoryError('观察材料列表无效');
  return Object.freeze(result);
}
function feedbackPreferences(value,allowed) {
  if(!Array.isArray(value)||value.length>10)throw new MemoryError('内容反馈上下文无效');
  return Object.freeze(value.map(item=>{
    exactObject(item,['bvid','creatorId','scope','value'],'内容反馈');
    const candidate=allowed.find(candidate=>candidate.bvid===item.bvid&&candidate.creatorId===item.creatorId);
    if(!candidate||!['content','creator'].includes(item.scope)||!['like','less'].includes(item.value))throw new MemoryError('内容反馈上下文无效');
    return Object.freeze({bvid:item.bvid,creatorId:item.creatorId,scope:item.scope,value:item.value});
  }));
}
function parseJson(raw,label) {
  if(typeof raw!=='string')throw new MemoryError(label+'不是有效 JSON');
  try{return JSON.parse(raw);}catch{throw new MemoryError(label+'不是有效 JSON');}
}
function selectDecision(raw,allowed) {
  const value=parseJson(raw,'内容选择结果');
  if(value?.decision==='skip'){exactObject(value,['decision'],'内容选择结果');return Object.freeze({decision:'skip'});}
  exactObject(value,['decision','bvid'],'内容选择结果');
  if(value.decision!=='select'||typeof value.bvid!=='string'||!allowed.some(item=>item.bvid===value.bvid))throw new MemoryError('内容选择结果无效');
  return Object.freeze({decision:'select',bvid:value.bvid});
}
function interpretDecision(raw,materials) {
  const value=parseJson(raw,'内容理解结果');
  if(value?.decision==='skip'){exactObject(value,['decision'],'内容理解结果');return Object.freeze({decision:'skip'});}
  exactObject(value,['decision','summary','viewpoint','evidenceIds','share'],'内容理解结果');
  if(value.decision!=='observe'||typeof value.share!=='boolean')throw new MemoryError('内容理解结果无效');
  const summary=boundedText(value.summary,600,'观察摘要'),viewpoint=boundedText(value.viewpoint,600,'观察观点');
  if(!Array.isArray(value.evidenceIds)||value.evidenceIds.length<1||value.evidenceIds.length>20||new Set(value.evidenceIds).size!==value.evidenceIds.length)throw new MemoryError('观察证据无效');
  const allowed=new Set(materials.map(item=>item.id));
  if(value.evidenceIds.some(id=>typeof id!=='string'||!allowed.has(id)))throw new MemoryError('观察证据无效');
  if(isRefusalText(summary)||isRefusalText(viewpoint))throw new ModelRefusalError();
  return Object.freeze({decision:'observe',summary,viewpoint,evidenceIds:Object.freeze([...value.evidenceIds]),share:value.share});
}
function providerAccount(provider) {
  exactObject(provider.account,['id','label'],'内容账号');
  return {id:nonEmpty(provider.account.id,'内容账号标识'),label:nonEmpty(provider.account.label,'内容账号名称')};
}

/** 固定 B 站适配器的单次读取编排；外部材料与模型输出均不能扩展权限或网络能力。 */
export class ContentSession {
  #store;#content;#scope;#gateway;#owner;#provider;#busy=false;
  constructor({store,scope,gateway,owner,provider}) {
    store.revision(scope);
    if(!store.content||typeof store.content.settings!=='function')throw new MemoryError('内容存储无效');
    store.content.settings(owner);
    if(!gateway||typeof gateway.create!=='function'||typeof gateway.complete!=='function'||typeof gateway.destroy!=='function')throw new MemoryError('内容模型网关无效');
    if(provider!==null&&provider!==undefined&&(typeof provider.discover!=='function'||typeof provider.observe!=='function'))throw new MemoryError('内容适配器无效');
    if(provider)providerAccount(provider);
    this.#store=store;this.#content=store.content;this.#scope=scope;this.#gateway=gateway;this.#owner=owner;this.#provider=provider??null;
  }
  #policy() {
    const policy=this.#content.settings(this.#owner);
    if(this.#provider&&providerAccount(this.#provider).id!==policy.accountId)throw new MemoryError('内容账号与读取策略不一致');
    return policy;
  }
  #characterStates() {
    const result=[];
    for(const state of this.#store.growth.context(this.#scope,'',{kinds:['interest','preference']})) {
      if(!['interest','preference'].includes(state.kind))continue;
      const item={id:state.id,topic:state.topic,statement:state.statement,revision:state.revision};
      if(result.length>=6||JSON.stringify([...result,item]).length>4000)break;
      result.push(Object.freeze(item));
    }
    return Object.freeze(result);
  }
  async #infer(stage,prompt,claim,signal,reserveCall) {
    checkSignal(signal);
    this.#content.assertCurrent(this.#scope,claim);this.#policy();
    const callRunId=reservation(await waitWithSignal(reserveCall({stage}),signal));
    checkSignal(signal);
    this.#content.reserveModel(this.#scope,claim,stage);
    const lease=this.#store.beginNativeLease(this.#scope);let runtime;
    try {
      runtime=await this.#gateway.create({lease,onCreationFailed:()=>this.#store.finishNativeLease(this.#scope,lease),kind:MODEL_KINDS[stage]});
      this.#store.bindNativeLease(this.#scope,lease,runtime);checkSignal(signal);
      const output=await this.#gateway.complete(runtime,JSON.stringify(prompt),callRunId,{signal});
      checkSignal(signal);return output;
    } catch(error) {
      if(signal?.aborted)throw new MemoryError('本轮已停止');
      throw error;
    } finally {
      if(runtime)try {
        await releaseNativeExecution(this.#gateway,this.#store,this.#scope,lease,runtime,{signal});
        this.#store.finishNativeLease(this.#scope,lease);
      } catch {throw new MemoryError('临时执行会话清理未确认，请先恢复清理');}
    }
  }
  #interrupt(claim,reason) {
    return this.#content.interrupt(this.#scope,claim,reason);
  }
  #commit(claim,payload,commitGuard) {
    this.#content.assertCurrent(this.#scope,claim);this.#policy();
    const result=commitGuard(()=>this.#content.commit(this.#scope,claim,payload));
    if(result&&typeof result.then==='function')throw new MemoryError('内容提交门必须同步执行');
    return result;
  }
  /** 先清理本 scope 原生租约，再终结崩溃遗留读取；绝不自动重发平台或模型调用。 */
  async recover() {
    if(this.#busy)throw new MemoryError('当前内容读取仍在运行');this.#busy=true;
    try {
      for(const lease of this.#store.nativeLeases(this.#scope)) {
        if(!lease.agentId)throw new MemoryError('创建结果未知，须按租约核实原生 Agent 后恢复');
        await releaseNativeExecution(this.#gateway,this.#store,this.#scope,lease.id,{agent_id:lease.agentId,conversation_id:lease.conversationId},{recover:true,remoteDeleted:lease.status==='remote_deleted'});
        this.#store.finishNativeLease(this.#scope,lease.id);
      }
      return this.#content.recoverInterrupted(this.#scope);
    } finally {this.#busy=false;}
  }
  /** 每阶段先预留宿主模型额度，再扣本地额度；最终提交只在同步 guard 中发生。 */
  async run({runId,signal,reserveCall,commitGuard}={}) {
    checkSignal(signal);
    if(this.#busy)throw new MemoryError('当前范围已有运行中的内容读取');
    if(typeof runId!=='string'||!runId.trim()||typeof reserveCall!=='function'||typeof commitGuard!=='function')throw new MemoryError('内容宿主门无效');
    if(!this.#provider||!this.#content.next(this.#scope))return {done:true,outcome:'not_due'};
    const policy=this.#policy();this.#busy=true;let claim;
    try {
      claim=this.#content.begin(this.#scope,{runId});
      this.#content.reserveRead(this.#scope,claim,'discover');checkSignal(signal);
      const discovered=candidates(await waitWithSignal(this.#provider.discover({keywords:[...policy.keywords],creatorIds:[...policy.creatorIds],limit:10,signal,commitGuard}),signal),policy.creatorIds);
      checkSignal(signal);
      const seen=new Set(this.#content.seenBvids(this.#scope)),unseen=discovered.filter(item=>!seen.has(item.bvid));
      if(!unseen.length){const reason=discovered.length?'already_seen':'empty';this.#interrupt(claim,reason);return {done:true,outcome:'skipped',reason};}
      const applied=this.#content.applyFeedback(this.#scope,unseen),found=candidates({candidates:applied.candidates},policy.creatorIds),preferences=feedbackPreferences(applied.preferences,found);
      if(!found.length){this.#interrupt(claim,'feedback_filtered');return {done:true,outcome:'skipped',reason:'feedback_filtered'};}
      const selected=selectDecision(await this.#infer('select',{candidates:found,characterStates:this.#characterStates(),preferences},claim,signal,reserveCall),found);
      checkSignal(signal);
      if(selected.decision==='skip') {
        const result=this.#commit(claim,{candidate:null,materials:[],decision:selected},commitGuard);
        return {done:true,outcome:result?.outcome??'skipped'};
      }
      const chosen=found.find(item=>item.bvid===selected.bvid);
      this.#content.assertCurrent(this.#scope,claim);this.#policy();
      this.#content.reserveRead(this.#scope,claim,'observe');checkSignal(signal);
      const materials=observed(await waitWithSignal(this.#provider.observe({bvid:chosen.bvid,signal,commitGuard}),signal),chosen);
      checkSignal(signal);
      if(!materials.length){this.#interrupt(claim,'no_material');return {done:true,outcome:'no_material'};}
      const decision=interpretDecision(await this.#infer('interpret',{candidate:chosen,materials},claim,signal,reserveCall),materials);
      checkSignal(signal);
      const result=this.#commit(claim,{candidate:chosen,materials,decision},commitGuard);
      return {done:true,outcome:result.outcome,...(result.observationId?{observationId:result.observationId}:{})};
    } catch(error) {
      if(claim)this.#interrupt(claim,error instanceof ModelRefusalError?'suppressed':signal?.aborted?'interrupted':/清理未确认/.test(error?.message??'')?'cleanup_failed':'rejected');
      if(error instanceof ModelRefusalError)return {done:true,outcome:'suppressed'};
      if(signal?.aborted)throw new MemoryError('本轮已停止');
      throw error;
    } finally {this.#busy=false;}
  }
}
