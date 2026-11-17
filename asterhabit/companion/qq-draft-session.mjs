import {releaseNativeExecution,confirmNativeExecution,discardNativeExecution} from './native-execution-lifecycle.mjs';
import {createDialogueInput,dialogueHistoryHash} from './dialogue-input.mjs';
import {containsSecret,MemoryError} from './memory-store.mjs';
import {ModelRefusalError,isRefusalText} from './reply-suppression.mjs';
import {QQError} from './qq-store.mjs';
import {parseQQGroupReply} from './qq-group-reply.mjs';
import {generationFailureCode} from './generation-failure.mjs';

/** 本地主人触发的单次QQ草稿编排；生成阶段不发送、不写history、不提交学习。 */
export class QQDraftSession {
  #store;#owner;#scope;#gateway;#profileRevision;#busy=false;#qqOwner;#conversation=null;#candidateRuntime=null;
  constructor({store,owner,scope,gateway,profileRevision}={}) {
    store.revision(scope);store.reply.settings(owner);
    if(!gateway||typeof gateway.create!=='function'||typeof gateway.complete!=='function'||typeof gateway.destroy!=='function')throw new QQError('QQ草稿模型网关无效');
    if(!Number.isSafeInteger(profileRevision)||profileRevision<0)throw new QQError('Agent配置修订无效');
    this.#store=store;this.#owner=owner;this.#scope=scope;this.#gateway=gateway;this.#profileRevision=profileRevision;
    this.#qqOwner=store.qq.ownerAuthority();
  }
  #signal(signal){if(signal!==undefined&&!(signal instanceof AbortSignal))throw new QQError('停止信号无效');if(signal?.aborted)throw new QQError('本轮已停止');}
  async #infer(kind,prompt,signal,operationId,authenticationSyncMs) {
    const timing=this.#store.replyTimings,phase=kind==='extract'?'extract':kind==='qq_group_reply'?'group':'draft';
    this.#signal(signal);timing.markRun(operationId,phase+'PreflightStart');const preflightStarted=performance.now();
    try{await this.#gateway.preflight?.({kind,operationId});}finally{timing.markRun(operationId,phase+'PreflightEnd');}
    const preflightMs=performance.now()-preflightStarted;this.#signal(signal);const lease=this.#store.beginNativeLease(this.#scope);let runtime;
    try {
      timing.markRun(operationId,phase+'CreateStart');
      try{runtime=await this.#gateway.create({lease,onCreationFailed:()=>this.#store.finishNativeLease(this.#scope,lease),kind,operationId,preflightMs,authenticationSyncMs,...(kind==='qq_draft'?{conversation:this.#conversation}:{})});}finally{timing.markRun(operationId,phase+'CreateEnd');}
      this.#store.bindNativeLease(this.#scope,lease,runtime);this.#signal(signal);timing.markRun(operationId,phase+'StreamStart');let firstTextSeen=false;
      try{const output=await this.#gateway.complete(runtime,prompt,lease,{signal,onDelta:delta=>{if(!firstTextSeen&&typeof delta==='string'&&delta.trim()){firstTextSeen=true;timing.markRun(operationId,phase+'FirstText');}}});if(kind==='qq_draft')this.#candidateRuntime=runtime;return output;}finally{timing.markRun(operationId,phase+'StreamEnd');}
    } catch(error) {if(signal?.aborted)throw new QQError('本轮已停止');throw error;}
    finally {
      if(runtime){timing.markRun(operationId,phase+'CleanupStart');try{await releaseNativeExecution(this.#gateway,this.#store,this.#scope,lease,runtime,{signal});this.#store.finishNativeLease(this.#scope,lease);}catch{throw new MemoryError('临时执行会话清理未确认，请先恢复清理');}finally{timing.markRun(operationId,phase+'CleanupEnd');}}
    }
  }
  async #reserve(claim,stage,reserveCall,signal) {
    const reservation=await reserveCall({stage});if(!reservation||typeof reservation.runId!=='string'||!reservation.runId.trim())throw new QQError('应用QQ模型额度预留未确认');this.#signal(signal);
    this.#store.reply.reserveModel(this.#owner,claim,stage);
  }
  /** 每次最多extract与qq_draft各一次；commitGuard只能同步完成草稿。 */
  async generate({eventId,learn,runId,signal,reserveCall,commitGuard,selectGroupReply=false,authenticationSyncMs,requestedAt,mode='manual'}={}) {
    this.#signal(signal);if(this.#busy)throw new QQError('当前QQ联系人已有草稿任务');if(typeof reserveCall!=='function'||typeof commitGuard!=='function')throw new QQError('QQ草稿宿主门无效');
    this.#busy=true;this.#candidateRuntime=null;let claim,outcome='failed',draftId=null;
    try {
      claim=this.#store.reply.beginDraft(this.#owner,{eventId,runId,learn,profileRevision:this.#profileRevision});
      this.#conversation={scopeId:claim.scope.id,historyHash:dialogueHistoryHash(claim.history),fence:JSON.stringify({memoryRevision:claim.memoryRevision,profileRevision:this.#profileRevision,qq:this.#store.qq.revisions(this.#qqOwner),growth:claim.growthPolicy})};
      this.#store.replyTimings.beginRun(runId,eventId,mode,requestedAt);
      if(containsSecret(claim.event.text))throw new QQError('QQ消息含疑似敏感凭据，未生成草稿');
      if(selectGroupReply){
        if(claim.learn||claim.event.kind!=='group'||this.#store.qq.settings(this.#qqOwner).groupMentionsOnly)throw new QQError('QQ群聊决策范围无效');
        const context=this.#store.qq.groupContext(this.#qqOwner,claim.event),groupSources=context.messages.map(row=>row.id);
        if(context.messages.some(row=>containsSecret(row.text)))throw new QQError('QQ消息含疑似敏感凭据，未生成草稿');
        await this.#reserve(claim,'draft',reserveCall,signal);
        const prompt=JSON.stringify({groupId:claim.event.groupId,trigger:{id:claim.event.id,senderId:claim.event.senderId,text:claim.event.text,mentionedSelf:claim.event.mentionedSelf},context,memory:this.#store.context(claim.scope,claim.event.text),character:this.#store.growth.context(claim.scope,claim.event.text)});
        const raw=await this.#infer('qq_group_reply',prompt,signal,runId,authenticationSyncMs);this.#signal(signal);if(isRefusalText(raw))throw new ModelRefusalError();const decision=parseQQGroupReply(raw);
        const result=commitGuard(()=>{if(!this.#store.qq.isLatestAutomaticEvent(this.#qqOwner,claim.event))throw new QQError('QQ群聊上下文已变化','CONFLICT');this.#store.qq.assertGroupSources(this.#qqOwner,claim.event,groupSources);if(decision.decision==='quiet')return this.#store.reply.completeQuiet(this.#owner,claim,groupSources);if(isRefusalText(decision.text))throw new ModelRefusalError();if(containsSecret(decision.text))throw new QQError('QQ草稿含疑似敏感凭据，未保存');return {outcome:'drafted',draft:this.#store.reply.completeDraft(this.#owner,claim,{text:decision.text,candidates:[],learningError:null,groupSources})};});if(result&&typeof result.then==='function')throw new QQError('QQ草稿提交门必须同步执行');outcome=result.outcome==='quiet'?'quiet':'completed';draftId=result.draft?.id??null;if(draftId)this.#store.replyTimings.markRun(runId,'draftReady');return result;
      }
      let candidates=[],preview=null,learningError=null;
      if(claim.learn) {
        await this.#reserve(claim,'extract',reserveCall,signal);const extraction=await this.#infer('extract',JSON.stringify({source:{origin:'user',text:claim.event.text}}),signal,runId,authenticationSyncMs);this.#signal(signal);
        try {preview=this.#store.previewLearning(claim.scope,claim.memoryRevision,JSON.parse(extraction),claim.source,claim.event.text);candidates=preview.candidates;}
        catch(error) {if(error instanceof SyntaxError||error instanceof MemoryError)learningError='学习候选未通过验证，未保存';else throw error;}
      }
      await this.#reserve(claim,'draft',reserveCall,signal);
      const prompt=createDialogueInput({memory:preview?.context??this.#store.context(claim.scope,claim.event.text),character:this.#store.growth.context(claim.scope,claim.event.text),history:preview?.clearsHistory?[]:claim.history,message:{origin:'user',text:claim.event.text}});
      const reply=await this.#infer('qq_draft',prompt,signal,runId,authenticationSyncMs);this.#signal(signal);if(isRefusalText(reply))throw new ModelRefusalError();if(containsSecret(reply))throw new QQError('QQ草稿含疑似敏感凭据，未保存');
      const draft=commitGuard(()=>this.#store.reply.completeDraft(this.#owner,claim,{text:reply,candidates,learningError}));if(draft&&typeof draft.then==='function')throw new QQError('QQ草稿提交门必须同步执行');
      if(this.#candidateRuntime)this.#store.reply.attachRuntime(this.#owner,draft.id,this.#candidateRuntime);outcome='completed';draftId=draft.id;this.#store.replyTimings.markRun(runId,'draftReady');return {outcome:'drafted',draft};
    } catch(error) {
      let interruptError=null;
      if(claim)try{this.#store.reply.interruptDraft(this.#owner,claim,error instanceof ModelRefusalError?'suppressed':signal?.aborted?'interrupted':'failure:'+generationFailureCode(error));}catch(cause){interruptError=cause;}
      if(interruptError){const recovery=new QQError('QQ草稿任务终结失败，需恢复','RECOVERY_REQUIRED');recovery.cause=new AggregateError([error,interruptError]);throw recovery;}
      if(error instanceof ModelRefusalError){outcome='suppressed';return {outcome:'suppressed'};}if(signal?.aborted){outcome='cancelled';throw new QQError('本轮已停止');}throw error;
    } finally {if(outcome!=='completed')discardNativeExecution(this.#gateway,this.#candidateRuntime);this.#store.replyTimings.finishRun(runId,outcome,draftId);this.#busy=false;}
  }
  /** 回执已先持久化；此处失败只固定记录学习错误，绝不改写发送状态。 */
  async finishLearning(claim,{commitGuard}={}) {
    if(typeof commitGuard!=='function')throw new QQError('QQ学习宿主门无效');let result;
    try {
      result=commitGuard(()=>{this.#store.reply.assertLearningCurrent(this.#owner,claim);return this.#store.completeTurn(claim.scope,claim.memoryRevision,claim.event.text,claim.text,claim.learn?claim.candidates:[],claim.source,{learn:claim.learn,grow:claim.learn&&claim.growthPolicy.enabled,eventKey:'qq-reply:'+claim.event.id,growthRevision:claim.growthPolicy.growthRevision});});
      if(result&&typeof result.then==='function')throw new QQError('QQ学习提交门必须同步执行');
    } catch {
      const learningError='学习未保存：来源或配置已变化';try{this.#store.reply.markLearning(this.#owner,claim.id,{error:learningError});}catch(markError){console.error('QQ已发送回合学习状态记录异常：'+(markError?.name??'Error'));}return {learned:0,growth:{saved:false,reason:'learning_failed'},learningError};
    }
    let learningError=null;
    try{this.#store.reply.markLearning(this.#owner,claim.id,{});}catch(markError){console.error('QQ已发送回合学习状态记录异常：'+(markError?.name??'Error'));learningError='学习状态未记录，发送结果不受影响';}
    let indexes;
    try{indexes=await this.#store.refreshQQScope(claim.scope);if(['error','cleanup-pending'].includes(indexes.memory?.status)||indexes.character?.status==='error')console.error('QQ已发送回合派生索引刷新异常：IndexError');}
    catch(indexError){console.error('QQ已发送回合派生索引刷新异常：'+(indexError?.name??'Error'));indexes={memory:{status:'error'},character:{status:'error'}};}
    return {learned:result.learned,growth:result.growth,learningError,index:indexes.memory,characterIndex:indexes.character};
  }
}
