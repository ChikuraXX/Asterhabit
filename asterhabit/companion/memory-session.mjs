import {releaseNativeExecution,confirmNativeExecution,discardNativeExecution} from './native-execution-lifecycle.mjs';
import { createDialogueInput,dialogueHistoryHash } from './dialogue-input.mjs';
import { ModelRefusalError } from './reply-suppression.mjs';
import { containsSecret, MemoryError } from './memory-store.mjs';
import { randomUUID } from 'node:crypto';

/** 可信宿主编排。scope 来自已认证身份；普通文字、外部证据、模型输出均不能创建授权。 */
export class MemorySession {
  #store; #scope; #gateway; #commitGuard; #reserveCall; #busy=false;#candidateRuntime=null;
  constructor({store,scope,gateway,commitGuard=operation=>operation(),reserveCall=()=>{}}) {
    store.revision(scope);if(typeof commitGuard!=='function')throw new MemoryError('提交门无效');
    this.#store=store;this.#scope=scope;this.#gateway=gateway;this.#commitGuard=commitGuard;this.#reserveCall=reserveCall;
  }
  /** 每个推理使用独立无工具 Agent；删除确认后才将回复交给调用者。 */
  async #infer(prompt,kind,signal) {
    this.#checkSignal(signal);
    this.#reserveCall(kind);
    const lease=this.#store.beginNativeLease(this.#scope);
    let runtime;
    try {
      runtime=await this.#gateway.create({lease,onCreationFailed:()=>this.#store.finishNativeLease(this.#scope,lease),kind,...(kind==='dialogue'?{conversation:{scopeId:this.#scope.id,fence:String(this.#store.revision(this.#scope)),historyHash:dialogueHistoryHash(this.#store.history(this.#scope))}}:{})});
      this.#store.bindNativeLease(this.#scope,lease,runtime);
      this.#checkSignal(signal);
      const output=await this.#gateway.complete(runtime,prompt,lease,{signal});if(kind==='dialogue')this.#candidateRuntime=runtime;return output;
    } catch(error) {
      if(signal?.aborted&&runtime)throw new MemoryError('本轮已停止');
      throw error;
    } finally {
      if(runtime) {
        try {await releaseNativeExecution(this.#gateway,this.#store,this.#scope,lease,runtime,{signal});this.#store.finishNativeLease(this.#scope,lease);}
        catch {throw new MemoryError('临时执行会话清理未确认，请先恢复清理');}
      }
      // 创建请求失败可能已在服务端落盘，保留未知租约，禁止静默忽略。
    }
  }
  /** 只恢复本 scope 记录的临时 Agent；未知创建结果需运维确认后处理。 */
  async recover() {
    if(this.#busy)throw new MemoryError('当前对话仍在运行');
    this.#busy=true;
    try {
      for(const lease of this.#store.nativeLeases(this.#scope)) {
        if(!lease.agentId)throw new MemoryError('创建结果未知，须按租约核实原生 Agent 后恢复');
        await releaseNativeExecution(this.#gateway,this.#store,this.#scope,lease.id,{agent_id:lease.agentId,conversation_id:lease.conversationId},{recover:true,remoteDeleted:lease.status==='remote_deleted'});
        this.#store.finishNativeLease(this.#scope,lease.id);
      }
      return this.#store.growth.recoverInterrupted(this.#scope,'crashed');
    } finally {this.#busy=false;}
  }
  /** 取消由可信宿主 AbortController 产生，不接受模型构造的控制对象。 */
  #checkSignal(signal) {
    if(signal!==undefined&&!(signal instanceof AbortSignal))throw new MemoryError('停止信号无效');
    if(signal?.aborted)throw new MemoryError('本轮已停止');
  }
  /** learn 只能由可信本地配置启用，origin 只能由来源适配层指定。 */
  async reply(text,{learn=false,grow=false,origin='user',signal,onCommitted=()=>{}}={}) {
    this.#checkSignal(signal);
    if(this.#busy)throw new MemoryError('当前联系人已有运行中的对话');
    if(typeof text!=='string'||!text.trim()||text.length>6000)throw new MemoryError('消息长度须为 1–6000 个字符');
    if(containsSecret(text))throw new MemoryError('消息含疑似敏感凭据，未发送');
    if(typeof learn!=='boolean'||typeof grow!=='boolean'||!['user','external'].includes(origin))throw new MemoryError('来源配置无效');
    if(this.#store.nativeLeases(this.#scope).length)throw new MemoryError('有待清理的原生会话，请先恢复');
    this.#busy=true;
    this.#candidateRuntime=null;let didCommit=false;
    try {
      const revision=this.#store.revision(this.#scope),growthPolicy=this.#store.growth.turnPolicy();
      let candidates=[],preview=null,learningError=null;
      const source={origin,text,allowLearning:true};
      if(learn) {
        const extraction=await this.#infer(JSON.stringify({source:{origin,text}}),'extract',signal);
        this.#checkSignal(signal);
        if(this.#store.revision(this.#scope)!==revision)throw new MemoryError('记忆已变化，旧学习结果已拒绝');
        try {
          preview=this.#store.previewLearning(this.#scope,revision,JSON.parse(extraction),source,text);
          candidates=preview.candidates;
        } catch(error) {
          if(error instanceof SyntaxError||error instanceof MemoryError)learningError='学习候选未通过验证，未保存';
          else throw error;
        }
      }
      const prompt=createDialogueInput({
        memory:preview?.context??this.#store.context(this.#scope,text),
        character:this.#store.growth.context(this.#scope,text),
        history:preview?.clearsHistory?[]:this.#store.history(this.#scope),
        message:{origin,text}
      });
      const reply=await this.#infer(prompt,'dialogue',signal);
      this.#checkSignal(signal);
      const previousIndex=await this.#store.sync(this.#scope);
      this.#checkSignal(signal);
      // 此同步事务是完成线性化点：此前取消不会写入任何学习或历史，此后不能取消已完成结果。
      const committed=this.#commitGuard(()=>this.#store.completeTurn(this.#scope,revision,text,reply,candidates,source,{
        learn,grow,eventKey:randomUUID(),growthRevision:growthPolicy.growthRevision
      }));
      if(committed&&typeof committed.then==='function')throw new MemoryError('提交门必须同步执行');
      didCommit=true;confirmNativeExecution(this.#gateway,this.#candidateRuntime,reply,this.#store.history(this.#scope));
      onCommitted();
      const characterIndex=this.#store.growth.sync(this.#scope);
      let index=previousIndex;
      if(committed.learned) {
        try{index=await this.#store.sync(this.#scope);}
        catch(error) {
          console.error('已提交回合的派生索引更新异常：'+(error?.name??'Error'));
          index={status:'error'};
        }
      }
      // 后续遗忘不能推翻已经提交的成功结果，也不能让旧回复重新显示。
      const superseded=this.#store.revision(this.#scope)!==committed.revision;
      return {text:superseded?'':reply,learned:committed.learned,learningError,index,characterIndex,superseded,growth:committed.growth};
    } catch(error) {
      if(!didCommit&&error instanceof ModelRefusalError) {
        this.#checkSignal(signal);
        return {text:'',learned:0,learningError:null,index:{status:'skipped'},superseded:false,suppressed:true};
      }
      throw error;
    } finally {if(!didCommit)discardNativeExecution(this.#gateway,this.#candidateRuntime);this.#busy=false;}
  }
}

