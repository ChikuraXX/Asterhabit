import {releaseNativeExecution,confirmNativeExecution,discardNativeExecution} from './native-execution-lifecycle.mjs';
import {randomUUID} from 'node:crypto';
import {MemoryError} from './memory-store.mjs';
import {ModelRefusalError} from './reply-suppression.mjs';

const NETWORK_CODES=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET']);
function isNetworkFailure(error){return NETWORK_CODES.has(error?.code)||NETWORK_CODES.has(error?.cause?.code)||error?.name==='TimeoutError';}

/** 单次无工具反思编排；模型只接触白名单来源与当前角色状态。 */
export class ReflectionSession {
  #store;#scope;#leaseScope;#gateway;#owner;#busy=false;
  constructor({store,scope,gateway,owner,leaseScope=scope}) {
    store.revision(scope);store.revision(leaseScope);store.growth.settings(owner);
    this.#store=store;this.#scope=scope;this.#leaseScope=leaseScope;this.#gateway=gateway;this.#owner=owner;
  }
  #signal(signal){if(signal!==undefined&&!(signal instanceof AbortSignal))throw new MemoryError('停止信号无效');if(signal?.aborted)throw new MemoryError('本轮已停止');}
  async #infer(plan,signal) {
    this.#signal(signal);
    const lease=this.#store.beginNativeLease(this.#leaseScope);let runtime;
    try {
      runtime=await this.#gateway.create({lease,onCreationFailed:()=>this.#store.finishNativeLease(this.#leaseScope,lease),kind:'reflection'});
      this.#store.bindNativeLease(this.#leaseScope,lease,runtime);this.#signal(signal);
      const prompt=JSON.stringify({sources:plan.sources,characterStates:plan.states});
      const output=await this.#gateway.complete(runtime,prompt,lease,{signal});
      this.#signal(signal);return output;
    } catch(error) {
      if(signal?.aborted)throw new MemoryError('本轮已停止');
      throw error;
    } finally {
      if(runtime) {
        try {
          await releaseNativeExecution(this.#gateway,this.#store,this.#leaseScope,lease,runtime,{signal});
          this.#store.finishNativeLease(this.#leaseScope,lease);
        } catch {throw new MemoryError('临时执行会话清理未确认，请先恢复清理');}
      }
    }
  }
  /** 先确认并清理本 scope 的原生临时 Agent，再终结 claimed 任务。 */
  async recover() {
    if(this.#busy)throw new MemoryError('当前反思仍在运行');
    this.#busy=true;
    try {
      for(const lease of this.#store.nativeLeases(this.#leaseScope)) {
        if(!lease.agentId)throw new MemoryError('创建结果未知，须按租约核实原生 Agent 后恢复');
        await releaseNativeExecution(this.#gateway,this.#store,this.#leaseScope,lease.id,{agent_id:lease.agentId,conversation_id:lease.conversationId},{recover:true,remoteDeleted:lease.status==='remote_deleted'});
        this.#store.finishNativeLease(this.#leaseScope,lease.id);
      }
      return this.#store.growth.recoverInterrupted(this.#scope,'crashed');
    } finally {this.#busy=false;}
  }
  /**
   * reserve 先预留应用总额度；commitGuard 必须持应用控制锁执行传入的同步事务 callback。
   * 拒答、取消和失败均终结已声明事件，不自动重排或返还额度。
   */
  async run({signal,reserve,commitGuard=operation=>operation()}={}) {
    this.#signal(signal);
    if(this.#busy)throw new MemoryError('当前联系人已有运行中的反思');
    if(typeof reserve!=='function'||typeof commitGuard!=='function')throw new MemoryError('反思宿主门无效');
    if(!this.#store.growth.due(this.#scope))return {committed:0,skipped:true};
    this.#busy=true;let plan;
    try {
      const proposedRunId=randomUUID();
      const reservation=await reserve({runId:proposedRunId,kind:'reflection'});
      if(reservation!==true&&(!reservation||typeof reservation.runId!=='string'))throw new MemoryError('应用反思额度预留未确认');
      const runId=reservation===true?proposedRunId:reservation.runId;
      this.#signal(signal);
      plan=this.#store.growth.beginReflection(this.#scope,runId);
      let raw;
      try {raw=await this.#infer(plan,signal);}
      catch(error) {
        const reason=error instanceof ModelRefusalError?'suppressed':signal?.aborted?'interrupted':/清理未确认/.test(error?.message??'')?'cleanup_failed':isNetworkFailure(error)?'network_failed':'rejected';
        this.#store.growth.interruptReflection(this.#scope,plan,reason);
        if(error instanceof ModelRefusalError)return {committed:0,suppressed:true};
        if(signal?.aborted)throw new MemoryError('本轮已停止');
        throw error;
      }
      let candidates;
      try {candidates=JSON.parse(raw);}
      catch {this.#store.growth.interruptReflection(this.#scope,plan,'rejected');throw new MemoryError('反思候选不是有效 JSON');}
      this.#signal(signal);
      let result;
      try {
        result=commitGuard(()=>this.#store.growth.commitReflection(this.#scope,plan,candidates));
        if(result&&typeof result.then==='function')throw new MemoryError('反思提交门必须同步执行');
      } catch(error) {
        this.#store.growth.interruptReflection(this.#scope,plan,'interrupted');
        throw error;
      }
      const projection=this.#store.growth.sync(this.#scope);
      return {...result,projection};
    } finally {this.#busy=false;}
  }
}
