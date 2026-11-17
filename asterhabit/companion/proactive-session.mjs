import {releaseNativeExecution,confirmNativeExecution,discardNativeExecution} from './native-execution-lifecycle.mjs';
import {MemoryError} from './memory-store.mjs';
import {ModelRefusalError,isRefusalText} from './reply-suppression.mjs';

const NETWORK_CODES=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET']);
function isNetworkFailure(error){return NETWORK_CODES.has(error?.code)||NETWORK_CODES.has(error?.cause?.code)||error?.name==='TimeoutError';}

/** 单次无工具主动规划/联系编排；模型只接触 Store 已声明的白名单数据。 */
export class ProactiveSession {
  #store;#scope;#gateway;#owner;#profileRevision;#busy=false;
  constructor({store,scope,gateway,owner,profileRevision}) {
    store.revision(scope);store.proactive.settings(owner);
    if(!gateway||typeof gateway.create!=='function'||typeof gateway.complete!=='function'||typeof gateway.destroy!=='function')throw new MemoryError('主动模型网关无效');
    if(!Number.isInteger(profileRevision)||profileRevision<0)throw new MemoryError('Agent 配置修订无效');
    this.#store=store;this.#scope=scope;this.#gateway=gateway;this.#owner=owner;this.#profileRevision=profileRevision;
  }
  #signal(signal){if(signal!==undefined&&!(signal instanceof AbortSignal))throw new MemoryError('停止信号无效');if(signal?.aborted)throw new MemoryError('本轮已停止');}
  async #infer(claim,signal) {
    this.#signal(signal);const lease=this.#store.beginNativeLease(this.#scope);let runtime;
    try {
      runtime=await this.#gateway.create({lease,onCreationFailed:()=>this.#store.finishNativeLease(this.#scope,lease),kind:claim.kind==='plan'?'proactive_plan':'proactive_contact'});
      this.#store.bindNativeLease(this.#scope,lease,runtime);this.#signal(signal);
      const prompt=claim.kind==='plan'?{roots:claim.roots,sources:claim.sources,characterStates:claim.characterStates,contactContext:claim.contactContext}:{plan:claim.plan,sources:claim.sources,characterStates:claim.characterStates,contactContext:claim.contactContext};
      const output=await this.#gateway.complete(runtime,JSON.stringify(prompt),lease,{signal});this.#signal(signal);return output;
    } catch(error) {
      if(signal?.aborted)throw new MemoryError('本轮已停止');throw error;
    } finally {
      if(runtime)try{await releaseNativeExecution(this.#gateway,this.#store,this.#scope,lease,runtime,{signal});this.#store.finishNativeLease(this.#scope,lease);}catch{throw new MemoryError('临时执行会话清理未确认，请先恢复清理');}
    }
  }
  /** 先清理当前 scope 的原生 lease，再终结重启遗留 claim，绝不自动重发。 */
  async recover() {
    if(this.#busy)throw new MemoryError('当前主动任务仍在运行');this.#busy=true;
    try {
      for(const lease of this.#store.nativeLeases(this.#scope)) {
        if(!lease.agentId)throw new MemoryError('创建结果未知，须按租约核实原生 Agent 后恢复');
        await releaseNativeExecution(this.#gateway,this.#store,this.#scope,lease.id,{agent_id:lease.agentId,conversation_id:lease.conversationId},{recover:true,remoteDeleted:lease.status==='remote_deleted'});
        this.#store.finishNativeLease(this.#scope,lease.id);
      }
      return this.#store.proactive.recoverInterrupted(this.#scope,'crashed');
    } finally {this.#busy=false;}
  }
  #dto(claim,result) {
    if(claim.kind==='plan')return result.outcome==='skipped'?{kind:'plan',runId:claim.runId,done:true,outcome:'skipped'}:{kind:'plan',runId:claim.runId,done:true,outcome:'planned',planId:result.id,dueAt:result.dueAt};
    if(result.outcome==='deferred')return {kind:'contact',runId:claim.runId,planId:claim.planId,done:true,outcome:'deferred',dueAt:result.dueAt};
    if(result.outcome==='skipped')return {kind:'contact',runId:claim.runId,planId:claim.planId,done:true,outcome:'skipped'};
    return {kind:'contact',runId:claim.runId,planId:claim.planId,done:true,outcome:'sent',messageId:result.id};
  }
  /**
   * 应用调用预留先于 Agent 本地额度；send 的应用消息预留先于最终本地事务且失败不退款。
   * commitGuard 必须同步执行 callback，模型/网络与原生清理从不在数据库事务内等待。
   */
  async run({kind,planId,signal,reserveCall,reserveMessage,commitGuard}={}) {
    this.#signal(signal);if(this.#busy)throw new MemoryError('当前联系人已有运行中的主动任务');
    if(!['plan','contact'].includes(kind)||typeof reserveCall!=='function'||typeof reserveMessage!=='function'||typeof commitGuard!=='function')throw new MemoryError('主动宿主门无效');
    const next=this.#store.proactive.next(this.#scope,{profileRevision:this.#profileRevision});
    if(!next||next.kind!==kind||(kind==='contact'&&next.planId!==planId))return {kind,planId,done:true,outcome:'not_due'};
    this.#busy=true;let claim;
    try {
      const reservation=await reserveCall({kind:kind==='plan'?'proactive_plan':'proactive_contact',...(kind==='contact'?{planId}: {})});
      if(!reservation||typeof reservation.runId!=='string'||!reservation.runId.trim())throw new MemoryError('应用主动调用额度预留未确认');this.#signal(signal);
      claim=this.#store.proactive.begin(this.#scope,{kind,planId,runId:reservation.runId,profileRevision:this.#profileRevision});
      try {
        const raw=await this.#infer(claim,signal);let decision;
        try{decision=JSON.parse(raw);}catch{throw new MemoryError('主动模型结果不是有效 JSON');}
        if(kind==='contact'&&decision?.decision==='send'&&isRefusalText(decision.text))throw new ModelRefusalError();
        this.#signal(signal);
        if(kind==='contact'&&decision?.decision==='send'){
          const messageReservation=await reserveMessage({id:claim.runId});if(messageReservation!==true)throw new MemoryError('应用主动消息额度预留未确认');this.#signal(signal);
        }
        const result=commitGuard(()=>this.#store.proactive.complete(this.#scope,claim,decision,kind==='contact'&&decision?.decision==='send'?{messageId:claim.runId}:undefined));
        if(result&&typeof result.then==='function')throw new MemoryError('主动提交门必须同步执行');return this.#dto(claim,result);
      } catch(error) {
        const reason=error instanceof ModelRefusalError?'suppressed':signal?.aborted?'interrupted':/清理未确认/.test(error?.message??'')?'cleanup_failed':isNetworkFailure(error)?'network_failed':'rejected';
        this.#store.proactive.interrupt(this.#scope,claim,reason);
        if(error instanceof ModelRefusalError)return {kind,runId:claim.runId,...(kind==='contact'?{planId:claim.planId}:{}),done:true,outcome:'suppressed'};
        if(signal?.aborted)throw new MemoryError('本轮已停止');throw error;
      }
    } finally {this.#busy=false;}
  }
}
