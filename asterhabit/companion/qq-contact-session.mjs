import {releaseNativeExecution,confirmNativeExecution,discardNativeExecution} from './native-execution-lifecycle.mjs';
import {QQError} from './qq-store.mjs';
import {isRefusalText} from './reply-suppression.mjs';
/** 主动计划单阶段生成；仅传入固定目标的单条来源，不读取主人私聊记忆。 */
export class QQContactSession {
 #memory;#owner;#gateway;#scope;#profileRevision;
 constructor({store,owner,gateway,scope,profileRevision}){this.#memory=store;this.#owner=owner;this.#gateway=gateway;this.#scope=scope;this.#profileRevision=profileRevision;}
 /** 计划生成与平台发送分离；quiet同样占用一次模型阶段。 */
 async generate({targetId,runId,signal,commitGuard,reserveCall,automatic=false}){
  const check=()=>{if(signal?.aborted)throw new QQError('主动计划生成已取消','CANCELLED');};let claim,lease,runtime;
  try{
   claim=commitGuard(()=>{check();return this.#memory.contact.beginGeneration(this.#owner,{targetId,runId,profileRevision:this.#profileRevision,automatic});});
   await reserveCall({stage:'draft'});check();await this.#gateway.preflight?.({kind:'qq_contact_plan'});check();
   lease=this.#memory.beginNativeLease(this.#scope);
   runtime=await this.#gateway.create({kind:'qq_contact_plan',lease,onCreationFailed:()=>this.#memory.finishNativeLease(this.#scope,lease)});
   this.#memory.bindNativeLease(this.#scope,lease,runtime);check();
   const raw=await this.#gateway.complete(runtime,JSON.stringify({target:claim.target,source:claim.source}),lease,{signal});check();
   let decision;if(isRefusalText(raw))decision={decision:'quiet'};else{try{decision=JSON.parse(raw);}catch{throw new QQError('主动计划格式无效');}}
   const plan=commitGuard(()=>{check();return this.#memory.contact.completeGeneration(this.#owner,claim,decision);});return {outcome:plan?'planned':'quiet',plan};
  }catch(error){if(claim)this.#memory.contact.interruptGeneration(this.#owner,claim);throw error;}
  finally{if(runtime){await releaseNativeExecution(this.#gateway,this.#memory,this.#scope,lease,runtime,{signal});this.#memory.finishNativeLease(this.#scope,lease);}}
 }
}
