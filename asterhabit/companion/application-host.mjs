import {createHash} from 'node:crypto';
import {parseAgentProfile,exportAgentProfile,agentRoleTemplates} from './agent-profile-transfer.mjs';
import {AgentError,exactFields} from './agent-registry.mjs';
import {DESKTOP_OPERATIONS} from './desktop-host.mjs';
import {ModelConnections,preflightModelConnectionRequest} from './model-connections.mjs';

const MODEL_CONNECTION_OPERATIONS=['model.connection.list','model.connection.save','model.connection.test','model.connection.remove','model.catalogue.refresh'];
const PROFILE_OPERATIONS=['agent.profile.parse','agent.profile.export','agent.profile.templates'];
const OBSERVATION_OPERATIONS=['observations.get','observations.feedback'];
const AUTHENTICATED_TASKS=new Set(['dialogue','reflection','proactive_plan','proactive_contact','content_browse','qq_draft','qq_send']);

const AGENT_OPERATIONS=new Set(DESKTOP_OPERATIONS.filter(name=>!['app.snapshot','runtime.pause','chat.cancel'].includes(name)));
const MANAGED=['agent.list','agent.create','agent.update','agent.archive','agent.pause','application.configure','app.activity','model.list','growth.get','growth.configure','growth.sources.list','growth.sources.authorize','growth.sources.forget','growth.sources.requeue','character.list','character.dismiss','reflection.status','proactive.get','proactive.configure','plans.list','plans.cancel','inbox.list','inbox.read','content.get','content.configure','content.browse','observations.list','observations.forget','bilibili.account.get','bilibili.account.bind','bilibili.account.unbind','bilibili.verify','qq.connection.get','qq.connection.bind','qq.pairing.start','qq.connection.unbind','qq.settings.get','qq.settings.configure','qq.receive','qq.messages.list','qq.messages.forget','qq.reply.get','qq.reply.configure','qq.drafts.generate','qq.drafts.list','qq.drafts.update','qq.drafts.cancel','qq.drafts.send','qq.records.list','qq.records.forget'];
MANAGED.push(...OBSERVATION_OPERATIONS,'qq.targets.resolve','qq.groups.get','qq.connection.bindOneBot','qq.contact.policies','qq.contact.configure','qq.contact.plans','qq.contact.generate','qq.contact.update','qq.contact.cancel','qq.contact.send');
MANAGED.push('qq.latency.list');
export const APPLICATION_OPERATIONS=Object.freeze([...new Set([...DESKTOP_OPERATIONS,...MANAGED,...MODEL_CONNECTION_OPERATIONS,...PROFILE_OPERATIONS])]);
/** 多Agent可信编排层；身份、目录、策略对象从不由模型文字创建。 */
export class ApplicationHost {
  #registry;#owner;#factory;#catalogue;#contexts=new Map();#requests=new Set();#active=new Map();#closed=false;#closing;#timer;#tickPromise;#now;#lastError=null;#dispose;#contextCleanupTimeoutMs;
  #modelConnections;
  #authentication;
  #eventWake;#wakeTimers;#wakeTimer=null;#wakeDue=null;
  constructor({registry,owner=registry.ownerAuthority(),factory,catalogue,modelConnections,nativeModelConnection,authentication,schedule=true,eventWake=schedule,wakeTimers={setTimeout,clearTimeout},now=Date.now,dispose=()=>{},contextCleanupTimeoutMs=60000}) {
    if(!Number.isInteger(contextCleanupTimeoutMs)||contextCleanupTimeoutMs<1||contextCleanupTimeoutMs>60000)throw new TypeError('上下文清理等待上限无效');this.#contextCleanupTimeoutMs=contextCleanupTimeoutMs;
    this.#registry=registry;this.#owner=owner;this.#factory=factory;this.#catalogue=catalogue;this.#now=now;this.#dispose=dispose;
    this.#authentication=authentication;
    this.#eventWake=eventWake;this.#wakeTimers=wakeTimers;
    this.#modelConnections=modelConnections??(nativeModelConnection?new ModelConnections({native:nativeModelConnection,references:async id=>this.#connectionReferences(id)}):null);
    if(schedule){this.#timer=setInterval(()=>{void this.tick().catch(error=>{const message=error instanceof AgentError?error.message:'后台反思未完成，请检查活动状态';if(message!==this.#lastError){console.error(message);this.#lastError=message;}});},15000);this.#timer.unref();}
  }
  /** 旧CLI只解析到唯一legacy身份，不能隐式选择其他Agent。 */
  legacyAgentId(){return this.#registry.legacyId(this.#owner);}
  /** 合并相同/较晚唤醒；事件回调只安排异步检查，不在收件事务内执行生成。 */
  #wakeQQ(delay=0){if(!this.#eventWake||this.#closed)return;const due=this.#now()+delay;if(this.#wakeTimer!==null&&this.#wakeDue<=due)return;if(this.#wakeTimer!==null)this.#wakeTimers.clearTimeout(this.#wakeTimer);this.#wakeDue=due;this.#wakeTimer=this.#wakeTimers.setTimeout(()=>{this.#wakeTimer=null;this.#wakeDue=null;void this.tick({qqOnly:true}).catch(error=>{const message=error instanceof AgentError?error.message:'QQ唤醒检查失败';if(message!==this.#lastError){console.error(message);this.#lastError=message;}});},delay);this.#wakeTimer?.unref?.();}
  /** 空槽时按队列最早冷却安排检查；忙碌由槽释放唤醒，15秒轮询仍作兜底。 */
  #scheduleQQ(){
    if(!this.#eventWake||this.#closed)return;
    const app=this.#registry.snapshot(this.#owner);let delay=null,budgetDelay=0;
    for(const budget of [app.budgets.total,app.budgets.background])if(budget.remaining===0){if(budget.nextAvailableAt===null){budgetDelay=null;break;}budgetDelay=Math.max(budgetDelay,budget.nextAvailableAt-this.#now());}
    if(!app.paused&&!app.busy&&app.backgroundDailyCallLimit>0&&budgetDelay!==null)for(const entry of this.#contexts.values()){
      const context=entry.context;if(!context||context.retiring)continue;const profile=this.#registry.get(this.#owner,context.profile.id);if(profile.paused||profile.archived)continue;const next=context.qq?.nextAutomaticDelay();if(next!==null&&next!==undefined){const due=Math.max(next,budgetDelay);delay=delay===null?due:Math.min(delay,due);}
    }
    if(delay!==null)this.#wakeQQ(delay);else if(this.#wakeTimer!==null){this.#wakeTimers.clearTimeout(this.#wakeTimer);this.#wakeTimer=null;this.#wakeDue=null;}
  }
  /** 可信宿主专用同步入口，复用全局模型槽；renderer不能指定来源或凭据。 */
  async synchronizeAuthentication(){
    if(!this.#authentication||this.#closed)return;
    const status=await this.#authentication.synchronize({exclusive:async operation=>{
      if(this.#registry.snapshot(this.#owner).active)return {deferred:true};
      const slot=this.#registry.claim(this.#owner,this.legacyAgentId(),'model_connection');let changed=false;
      try{const result=await operation();changed=result.credentialChanged;return result;}
      finally{this.#registry.release(this.#owner,slot.taskId,{modelConfigurationChanged:changed});this.#scheduleQQ();}
    }});
    if(status.state==='stopped')for(const [taskId,active]of this.#active){try{this.#assertAuthentication(active.context,active.kind);}catch{this.#registry.cancel(this.#owner,active.agentId,taskId);active.controller.abort();active.context.host.cancel();}}
    return status;
  }
  /** 提交及发送前重查当前源身份，保留原有权限和任务fence。 */
  #assertAuthentication(context,kind){
    if(!AUTHENTICATED_TASKS.has(kind)||!this.#authentication)return;
    const profile=context.profile,model=context.runtime?.modelForTask?.(kind)??(['reflection','proactive_plan','proactive_contact','content_browse'].includes(kind)?profile.reflectionModel??profile.dialogueModel:profile.dialogueModel);
    this.#authentication.assertForModel(model,{commit:true});
  }
  #taskPolicy(context,task,operation){const kind=this.#active.get(task.taskId)?.kind;if(kind!=='qq_draft'||context.store.reply.hasRun(task.taskId)||context.store.contact?.hasRun(task.taskId))this.#assertAuthentication(context,kind);return context.host.policyGuard(operation);}
  /** 同一Agent配置版本只构造一次资源；版本变化先关闭旧上下文并清理在途操作。 */
  #context(profile) {
    // 进入缓存前就拦住旧修订，不能先取消新任务再发现请求已过期。
    this.#registry.guard(this.#owner,profile.id,profile.profileRevision,()=>true,{allowPaused:true,allowArchived:true});
    const old=this.#contexts.get(profile.id);
    if(old?.revision===profile.profileRevision)return old.promise;
    if(old&&!old.settled){
      // 同Agent替换串行；失败后只有缓存已恢复/移除时才尝试当前修订。
      return old.promise.then(()=>this.#context(profile),error=>{if(this.#contexts.get(profile.id)!==old)return this.#context(profile);throw error;});
    }
    const entry={revision:profile.profileRevision,promise:null,settled:false};let previous=null,previousClosed=false;
    entry.promise=(async()=>{
      if(old){previous=await old.promise;previous.retiring=true;await this.#settleContext(previous);}
      this.#registry.guard(this.#owner,profile.id,profile.profileRevision,()=>true,{allowPaused:true,allowArchived:true});
      if(previous){await previous.qq?.stop();await previous.host.close();previousClosed=true;await previous.runtime?.close();}
      let context;
      const guards={reserveDialogueCall:kind=>this.#registry.reserveDialogueCall(this.#owner,context.taskId,kind),commitGuard:operation=>this.#registry.guard(this.#owner,profile.id,profile.profileRevision,()=>{this.#assertAuthentication(context,this.#active.get(context.taskId)?.kind);return operation();},{taskId:context.taskId}),mutationGuard:operation=>this.#registry.guard(this.#owner,profile.id,profile.profileRevision,operation,{allowPaused:true}),executeGuard:operation=>this.#registry.guard(this.#owner,profile.id,profile.profileRevision,operation)};
      context=await this.#factory(profile,guards);context.profile=profile;context.taskId=null;
      context.growthOwner=context.growthOwner??context.store.growth?.ownerAuthority();
      context.proactiveOwner=context.proactiveOwner??context.store.proactive?.ownerAuthority();
      context.contentOwner=context.contentOwner??context.store.content?.ownerAuthority();
      const paused=profile.paused||profile.archived||this.#registry.snapshot(this.#owner).paused;
      if(context.host.snapshot().control.paused!==paused)await context.host.request('runtime.pause',{paused});
      entry.context=context;return context;
    })();
    this.#contexts.set(profile.id,entry);
    entry.promise.then(()=>{entry.settled=true;},()=>{
      entry.settled=true;
      if(this.#contexts.get(profile.id)===entry){if(previous&&!previousClosed)this.#contexts.set(profile.id,old);else this.#contexts.delete(profile.id);}
    });
    return entry.promise;
  }
  /** 替换上下文前等待所有平台/后台任务的finally；不能只等待DesktopHost内部聊天请求。 */
  async #settleContext(context){
    await context.qq?.stop();
    const active=[...this.#active.entries()].filter(([,value])=>value.context===context);
    for(const [taskId,value] of active){this.#registry.cancel(this.#owner,value.agentId,taskId);value.controller.abort();context.host.cancel();}
    if(!active.length)return;
    let timer;
    try{await Promise.race([Promise.all(active.map(([,value])=>value.completion)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AgentError('旧任务清理尚未完成，请稍后重试','BUSY')),this.#contextCleanupTimeoutMs);})]);}
    finally{clearTimeout(timer);}
  }
  /** 私有操作都登记到关闭屏障，未观察的后台Promise不留在进程中。 */
  request(operation,payload={}) {
    if(this.#closed)return Promise.reject(new AgentError('应用正在关闭','CLOSING'));
    const task=this.#dispatch(operation,payload);this.#requests.add(task);return task.finally(()=>this.#requests.delete(task));
  }
  async #snapshot(payload) {
    exactFields(payload,[],['agentId']);await this.#reconcileContacts();const profile=this.#registry.get(this.#owner,payload.agentId??this.legacyAgentId());
    const context=await this.#context(profile),base=context.host.snapshot(),application=this.#registry.snapshot(this.#owner);
    const unread=this.#registry.unreadCounts(this.#owner);
    const historyRevisions=Object.fromEntries(context.host.contacts.map(contact=>[contact.id,createHash('sha256').update(JSON.stringify(context.store.history(context.host.scopeFor(contact.id),{includeMetadata:true}))).digest('hex')]));
    return {...base,...(this.#authentication?{modelAuthentication:this.#authentication.status()}:{}),agent:{...profile,unreadCount:unread[profile.id]??0},agents:this.#registry.list(this.#owner).map(agent=>({...agent,unreadCount:unread[agent.id]??0})),application,runtime:{...base.runtime,historyRevisions,paused:application.paused||profile.paused||base.runtime.paused,busy:application.busy,taskId:application.active?.agentId===profile.id?application.active.taskId:null,busyContactId:base.runtime.busyContactId}};
  }
  async #validateModels(input) {
    const revision=this.#registry.modelConfigurationRevision(this.#owner);
    const {entries}=await this.#catalogue();
    const check=(handle,effort)=>{const found=entries.find(entry=>entry.handle===handle);if(!found)throw new AgentError('所选模型不在当前可用目录中');if(!found.reasoningEfforts.includes(effort))throw new AgentError('模型不支持所选推理档位');};
    check(input.model,'none');check(input.dialogueModel,input.dialogueReasoningEffort);check(input.reflectionModel??input.dialogueModel,input.reflectionReasoningEffort??input.dialogueReasoningEffort);
    return revision;
  }
  /** 只从权威Agent配置解析精确连接前缀，归档Agent仍保留引用。 */
  #connectionReferences(id){return this.#registry.list(this.#owner).flatMap(agent=>[['extract',agent.model],['dialogue',agent.dialogueModel],['reflection',agent.reflectionModel]].filter(([,handle])=>typeof handle==='string'&&handle.startsWith(id+'/')).map(([slot])=>({agentId:agent.id,slot})));}
  /** 连接变化先取消并等待原生清理，再持应用全局槽进行原子凭据更新。 */
  async #manageConnection(operation,payload){
    payload=preflightModelConnectionRequest(operation,payload);
    if(!this.#modelConnections)throw new AgentError('模型连接管理尚未就绪','NOT_READY');
    if(['model.connection.list','model.connection.test'].includes(operation))return this.#modelConnections.request(operation,payload);
    const references=this.#connectionReferences(payload.id);
    if(operation==='model.connection.remove'&&references.length)return {removed:false,references,errorCode:'MODEL_CONNECTION_IN_USE'};
    const active=this.#registry.snapshot(this.#owner).active;
    if(active&&!this.#active.has(active.taskId))throw new AgentError('其他宿主或恢复任务正在使用模型，请稍后重试','BUSY');
    const affected=new Set(references.map(reference=>reference.agentId));
    for(const agentId of affected){await this.#cancelForAgent(agentId);const entry=this.#contexts.get(agentId);if(entry)await this.#settleContext(await entry.promise);}
    const slot=this.#registry.claim(this.#owner,this.legacyAgentId(),'model_connection');
    let changed=true;
    try{const result=await this.#modelConnections.request(operation,payload);if(result?.removed===false)changed=false;return result;}
    catch(error){if(['INVALID_REQUEST','NOT_FOUND','CONFLICT','AUTH_FAILED','MODEL_CONNECTION_IN_USE'].includes(error?.code))changed=false;throw error;}
    finally{this.#registry.release(this.#owner,slot.taskId,{modelConfigurationChanged:changed});this.#scheduleQQ();}
  }
  async #cancelLocal(agentId,taskId) {
    const active=this.#active.get(taskId);if(active&&active.agentId===agentId){active.controller?.abort();active.context.host.cancel();}
  }
  /** 前台聊天可中断反思；在旧原生会话清理完成前不抢占其全局槽。 */
  async #foreground() {
    const active=this.#registry.snapshot(this.#owner).active;
    if(!['reflection','proactive_plan','proactive_contact','content_browse','platform_bind','platform_read','qq_bind','qq_receive','qq_lookup','qq_draft'].includes(active?.kind))return;
    this.#registry.cancel(this.#owner,active.agentId,active.taskId);await this.#cancelLocal(active.agentId,active.taskId);
    const deadline=this.#now()+60000;
    while(this.#registry.snapshot(this.#owner).active?.taskId===active.taskId){if(this.#closed||this.#now()>=deadline)throw new AgentError('后台任务清理尚未完成，请稍后重试','BUSY');await new Promise(resolve=>setTimeout(resolve,100));}
  }
  async #run(profile,kind,operation,contactId=null) {
    if(kind==='dialogue')await this.#foreground();
    const authenticationStarted=performance.now();
    if(AUTHENTICATED_TASKS.has(kind))await this.synchronizeAuthentication();
    const authenticationSyncMs=performance.now()-authenticationStarted;
    this.#registry.guard(this.#owner,profile.id,profile.profileRevision,()=>true,{allowPaused:kind==='recovery',allowArchived:kind==='recovery'});
    const context=await this.#context(profile);if(context.retiring)throw new AgentError('Agent上下文正在更新','CONFLICT');this.#registry.guard(this.#owner,profile.id,profile.profileRevision,()=>true,{allowPaused:kind==='recovery',allowArchived:kind==='recovery'});const task=this.#registry.claim(this.#owner,profile.id,kind,{scopeId:contactId?context.host.scopeFor(contactId).id:null,contactId});context.taskId=task.taskId;
    let settled;const completion=new Promise(resolve=>{settled=resolve;});
    const controller=new AbortController(),active={agentId:profile.id,kind,context,controller,completion};this.#active.set(task.taskId,active);
    task.authenticationSyncMs=authenticationSyncMs;
    const watcher=setInterval(()=>{if(this.#registry.cancelled(this.#owner,task.taskId)){controller.abort();context.host.cancel();}},250);watcher.unref();
    try{if(kind!=='qq_draft')this.#assertAuthentication(context,kind);return await operation(context,task,controller.signal);}
    finally{
      clearInterval(watcher);
      try{const pending=(context.store.contact?.pendingCount()??0)>0||context.store.pendingNativeLeaseCount()>0||(context.store.growth?.status().activeRuns??0)>0||(context.store.proactive?.activeRuns()??0)>0||(context.store.content?.activeRuns()??0)>0||(context.store.reply?.activeRuns()??[]).length>0||(context.store.reply?.pendingSendCount()??0)>0;if(pending)this.#registry.retainForRecovery(this.#owner,task.taskId);else this.#registry.release(this.#owner,task.taskId);}
      finally{this.#active.delete(task.taskId);context.taskId=null;settled();this.#scheduleQQ();}
    }
  }
  async #dispatch(operation,payload) {
    if(!APPLICATION_OPERATIONS.includes(operation))throw new AgentError('不支持此操作');
    if(MODEL_CONNECTION_OPERATIONS.includes(operation))return this.#manageConnection(operation,payload);
    if(operation==='app.snapshot')return this.#snapshot(payload);
    if(operation==='app.activity'){exactFields(payload,[]);return this.#registry.activity(this.#owner);}
    if(operation==='agent.list'){exactFields(payload,[]);const counts=this.#registry.unreadCounts(this.#owner);return {agents:this.#registry.list(this.#owner).map(agent=>({...agent,unreadCount:counts[agent.id]??0}))};}
    if(operation==='model.list'){exactFields(payload,[]);return await this.#catalogue();}
    if(operation==='agent.profile.parse'){exactFields(payload,['text']);return {configuration:parseAgentProfile(payload.text)};}
    if(operation==='agent.profile.export'){exactFields(payload,['agentId']);return exportAgentProfile(this.#registry.get(this.#owner,payload.agentId));}
    if(operation==='agent.profile.templates'){exactFields(payload,[]);return {templates:agentRoleTemplates()};}
    if(operation==='agent.create'){const expectedModelRevision=await this.#validateModels(payload);return {agent:this.#registry.create(this.#owner,payload,{expectedModelRevision})};}
    if(operation==='agent.update') {
      const {agentId,...input}=payload;const before=this.#registry.get(this.#owner,agentId);
      const changed=['model','dialogueModel','dialogueReasoningEffort','reflectionModel','reflectionReasoningEffort'].some(k=>(input[k]??null)!==(before[k]??null));
      const expectedModelRevision=changed?await this.#validateModels(input):undefined;
      const agent=this.#registry.update(this.#owner,agentId,input,{expectedModelRevision});await this.#cancelForAgent(agentId);return {agent};
    }
    if(operation==='agent.archive'||operation==='agent.pause') {
      const field=operation==='agent.archive'?'archived':'paused';exactFields(payload,['agentId','expectedRevision',field]);
      const agent=this.#registry[field==='archived'?'archive':'pause'](this.#owner,payload.agentId,payload.expectedRevision,payload[field]);
      await this.#cancelForAgent(agent.id);
      const qqContext=this.#contexts.get(agent.id);if(qqContext)await (await qqContext.promise).qq?.stop();
      // 暂停局部动作库，以便取消排队模拟动作；归档也阻止全部新动作。
      const cached=this.#contexts.get(agent.id);if(cached){const context=await cached.promise;await context.host.request('runtime.pause',{paused:agent.archived||agent.paused||this.#registry.snapshot(this.#owner).paused});}
      this.#scheduleQQ();
      return {agent};
    }
    if(operation==='runtime.pause') {
      exactFields(payload,['paused']);const application=this.#registry.setPaused(this.#owner,payload.paused);
      for(const active of this.#active.values()){if(payload.paused){active.controller.abort();active.context.host.cancel();}}
      for(const [id,entry] of this.#contexts){const context=await entry.promise;if(payload.paused)await context.qq?.stop();const p=this.#registry.get(this.#owner,id);await context.host.request('runtime.pause',{paused:payload.paused||p.paused||p.archived});}
      this.#scheduleQQ();
      return {application};
    }
    if(operation==='application.configure'){const application=this.#registry.configure(this.#owner,payload);for(const [id,active] of this.#active)if(this.#registry.cancelled(this.#owner,id)){active.controller.abort();active.context.host.cancel();}this.#scheduleQQ();return {application};}
    if(operation==='chat.cancel'){exactFields(payload,['agentId','taskId']);const cancelled=this.#registry.cancel(this.#owner,payload.agentId,payload.taskId);if(cancelled)await this.#cancelLocal(payload.agentId,payload.taskId);return {cancelled};}
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof payload.agentId!=='string')throw new AgentError('必须指定Agent');
    const {agentId,...input}=payload;const profile=this.#registry.get(this.#owner,agentId);
    if(operation==='chat.send'){this.#registry.activity(this.#owner);return this.#run(profile,'dialogue',async context=>({...await context.host.request(operation,input),agentId}),input.contactId);}
    const context=await this.#context(profile);
    if(operation==='memory.recover')return this.#run(profile,'recovery',async ctx=>{const result=await ctx.host.request(operation,input);const scope=ctx.host.scopeFor(input.contactId);if(input.contactId==='owner'&&scope.id===this.#proactiveScope(ctx).id){ctx.store.proactive?.recoverInterrupted(scope,'crashed');ctx.store.content?.recoverInterrupted(scope);ctx.qq?.recoverReplies();}return result;},input.contactId);
    if(['qq.records.list','qq.records.forget'].includes(operation)){
      if(!context.qq)throw new AgentError('QQ服务未就绪','NOT_READY');
      if(operation==='qq.records.list'){exactFields(input,[],['cursor','limit']);return context.qq.records(input);}
      exactFields(input,['id']);return context.qq.forgetRecord(input,{commitGuard:operation=>this.#registry.guard(this.#owner,agentId,profile.profileRevision,operation,{allowPaused:true})});
    }
    if(['qq.reply.get','qq.reply.configure','qq.drafts.generate','qq.drafts.list','qq.drafts.update','qq.drafts.cancel','qq.drafts.send'].includes(operation)){
      if(!context.qq)throw new AgentError('QQ服务未就绪','NOT_READY');
      const gate=operation=>this.#registry.guard(this.#owner,agentId,profile.profileRevision,operation,{allowPaused:true});
      if(operation==='qq.reply.get'){exactFields(input,[]);return context.qq.replySettings();}
      if(operation==='qq.drafts.list'){exactFields(input,[],['eventId']);return context.qq.listDrafts(input);}
      if(operation==='qq.reply.configure'){
        const result=context.qq.configureReplies(input,{commitGuard:gate});const active=this.#registry.snapshot(this.#owner).active;
        if(active?.agentId===agentId&&['qq_draft','qq_send'].includes(active.kind))await this.#cancelForAgent(agentId);await this.#syncQQListeners();return result;
      }
      if(operation==='qq.drafts.update')return context.qq.updateDraft(input,{commitGuard:gate});
      if(operation==='qq.drafts.cancel')return context.qq.cancelDraft(input,{commitGuard:gate});
      const generating=operation==='qq.drafts.generate',requestedAt=context.qq.timingCheckpoint();
      return this.#run(profile,generating?'qq_draft':'qq_send',(ctx,task,signal)=>{
        const commitGuard=operation=>this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>this.#taskPolicy(ctx,task,operation),{taskId:task.taskId});
        return generating?ctx.qq.generateDraft(input,{runId:task.taskId,requestedAt,authenticationSyncMs:task.authenticationSyncMs,signal,commitGuard,reserveCall:({stage})=>this.#registry.reserveQQReplyCall(this.#owner,task.taskId,stage)}):ctx.qq.sendDraft(input,{signal,commitGuard,requestedAt});
      },'owner');
    }
    if(operation.startsWith('qq.contact.')){
      if(!context.qq)throw new AgentError('QQ服务未就绪','NOT_READY');
      const gate=fn=>this.#registry.guard(this.#owner,agentId,profile.profileRevision,fn,{allowPaused:true});
      if(operation==='qq.contact.policies'){exactFields(input,[]);return context.qq.contactPolicies();}
      if(operation==='qq.contact.plans'){exactFields(input,[]);return context.qq.contactPlans();}
      if(operation==='qq.contact.configure'){const result=context.qq.configureContact(input,{commitGuard:gate});const active=this.#registry.snapshot(this.#owner).active;if(active?.agentId===agentId&&['qq_draft','qq_send'].includes(active.kind))await this.#cancelForAgent(agentId);return result;}
      if(operation==='qq.contact.update')return context.qq.updateContact(input,{commitGuard:gate});
      if(operation==='qq.contact.cancel')return context.qq.cancelContact(input,{commitGuard:gate});
      const generating=operation==='qq.contact.generate';
      return this.#run(profile,generating?'qq_draft':'qq_send',(ctx,task,signal)=>{const commitGuard=fn=>this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>this.#taskPolicy(ctx,task,fn),{taskId:task.taskId});return generating?ctx.qq.generateContact(input,{runId:task.taskId,signal,commitGuard,reserveCall:({stage})=>this.#registry.reserveQQReplyCall(this.#owner,task.taskId,stage)}):ctx.qq.sendContact(input,{signal,commitGuard});},'owner');
    }
    if(operation.startsWith('qq.')){
      if(!context.qq)throw new AgentError('QQ服务未就绪','NOT_READY');
      if(operation==='qq.latency.list'){exactFields(input,[],['limit']);return context.qq.latency(input);}
      if(operation==='qq.groups.get'){
        exactFields(input,['expectedRevision','groupOpenid']);
        return context.qq.groupState(input,{commitGuard:operation=>{if(this.#closed||context.retiring)throw new AgentError('QQ查询已停止','CANCELLED');return this.#registry.guard(this.#owner,agentId,profile.profileRevision,operation,{allowPaused:true});}});
      }
      if(operation==='qq.targets.resolve'){
        exactFields(input,['expectedRevision','kind','openid']);
        return this.#run(profile,'qq_lookup',(ctx,task,signal)=>ctx.qq.resolveTarget(input,{signal,commitGuard:operation=>this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>this.#taskPolicy(ctx,task,operation),{taskId:task.taskId})}),'owner');
      }
      if(['qq.connection.get','qq.settings.get','qq.messages.list'].includes(operation)){exactFields(input,[]);return context.qq[operation==='qq.connection.get'?'status':operation==='qq.settings.get'?'settings':'messages']();}
      const gate=operation=>this.#registry.guard(this.#owner,agentId,profile.profileRevision,operation,{allowPaused:true});
      if(operation==='qq.connection.unbind'||operation==='qq.settings.configure'){
        const result=context.qq[operation==='qq.connection.unbind'?'unbind':'configure'](input,{commitGuard:gate});
        const active=this.#registry.snapshot(this.#owner).active,kinds=operation==='qq.connection.unbind'?['qq_bind','qq_receive','qq_lookup','qq_draft','qq_send']:['qq_receive','qq_draft','qq_send'];
        if(active?.agentId===agentId&&kinds.includes(active.kind))await this.#cancelForAgent(agentId);await this.#syncQQListeners();return result;
      }
      if(operation==='qq.messages.forget'){const result=context.qq.forget(input,{commitGuard:gate});const active=this.#registry.snapshot(this.#owner).active;if(result.forgotten&&active?.agentId===agentId&&active.kind==='qq_draft')await this.#cancelForAgent(agentId);if(result.forgotten)await context.qq.syncForgotten(input.id);return result;}
      if(operation==='qq.pairing.start'){
        if(!this.#registry.lead(this.#owner))throw new AgentError('另一宿主正在管理QQ连接','BUSY');
        const commitGuard=operation=>this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>context.host.policyGuard(operation));
        const result=await context.qq.startPairing(input,{commitGuard});await this.#syncQQListeners();return result;
      }
      if(['qq.connection.bind','qq.connection.bindOneBot'].includes(operation))for(const other of this.#registry.list(this.#owner)){
        if(other.id===agentId)continue;const candidate=await this.#context(other);
        if(candidate.qq?.status().selfId===(operation==='qq.connection.bindOneBot'?'onebot:'+input.accountId:'qqbot:'+input.appId))throw new AgentError('此QQ机器人已绑定其他Agent','CONFLICT');
      }
      const method=operation==='qq.connection.bind'?'bind':operation==='qq.connection.bindOneBot'?'bindOneBot':'receive';
      // 30秒接收仅保留为显式诊断：临时让出唯一持续连接，结束后恢复宿主监听。
      if(method==='receive'){
        await context.qq.stop();
        try{return await this.#run(profile,'qq_receive',(ctx,task,signal)=>ctx.qq.receive(input,{signal,commitGuard:operation=>this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>this.#taskPolicy(ctx,task,operation),{taskId:task.taskId})}),'owner');}
        finally{await this.#syncQQListeners();}
      }
      return this.#run(profile,'qq_bind',(ctx,task,signal)=>ctx.qq[method](input,{signal,commitGuard:operation=>this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>this.#taskPolicy(ctx,task,operation),{taskId:task.taskId})}),'owner');
    }
    if(['bilibili.account.get','bilibili.account.bind','bilibili.account.unbind','bilibili.verify'].includes(operation)){
      if(!context.bilibili)throw new AgentError('B站账号服务未就绪','NOT_READY');
      if(operation==='bilibili.account.get'){exactFields(input,[]);return context.bilibili.status();}
      if(operation==='bilibili.account.unbind'){
        exactFields(input,['expectedRevision']);await this.#cancelForAgent(agentId);
        return context.bilibili.unbind(input,{commitGuard:operation=>this.#registry.guard(this.#owner,agentId,profile.profileRevision,operation,{allowPaused:true})});
      }
      const binding=operation==='bilibili.account.bind';exactFields(input,binding?['expectedRevision','sessdata','buvid3']:['expectedRevision','bvid']);
      return this.#run(profile,binding?'platform_bind':'platform_read',(ctx,task,signal)=>ctx.bilibili[binding?'bind':'verify'](input,{signal,commitGuard:operation=>this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>this.#taskPolicy(ctx,task,operation),{taskId:task.taskId})}),'owner');
    }
    if(['content.get','content.configure','content.browse','observations.list','observations.forget',...OBSERVATION_OPERATIONS].includes(operation)){
      const scope=this.#proactiveScope(context),content=context.store.content;
      if(operation==='content.get'){exactFields(input,[]);return {settings:content.settings(context.contentOwner),available:Boolean(context.contentFor)};}
      if(operation==='content.configure'){
        const settings=this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>content.configure(context.contentOwner,input),{allowPaused:true});
        const active=this.#registry.snapshot(this.#owner).active;if(active?.agentId===agentId&&['content_browse','proactive_plan','proactive_contact','platform_read'].includes(active.kind))await this.#cancelForAgent(agentId);
        context.store.proactive.revokeInvalid(scope,{profileRevision:profile.profileRevision});return {settings,available:Boolean(context.contentFor)};
      }
      if(operation==='observations.list'){exactFields(input,[],['cursor','limit']);return content.list(scope,input);}
      if(operation==='observations.get'){exactFields(input,['id']);return {observation:content.get(scope,input.id)};}
      if(operation==='observations.feedback'){
        exactFields(input,['id','expectedRevision','expectedFeedbackRevision','scope','value']);
        const observation=this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>content.feedback(scope,input),{allowPaused:true});
        const active=this.#registry.snapshot(this.#owner).active;
        if(active?.agentId===agentId&&active.kind==='content_browse')await this.#cancelForAgent(agentId);
        return {observation};
      }
      if(operation==='observations.forget'){
        exactFields(input,['id','expectedRevision']);await this.#cancelForAgent(agentId);
        const result=this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>content.forget(scope,input),{allowPaused:true});return {...result,projection:await context.store.growth.sync(scope)};
      }
      exactFields(input,[]);if(!context.contentFor)throw new AgentError('B站读取适配器尚未连接','NOT_READY');
      return this.#run(profile,'content_browse',(ctx,task,signal)=>this.#browse(ctx,profile,task,signal), 'owner');
    }
    if(['proactive.get','proactive.configure','plans.list','plans.cancel','inbox.list','inbox.read'].includes(operation)){
      const scope=this.#proactiveScope(context),proactive=context.store.proactive;
      if(operation==='proactive.get'){exactFields(input,[]);return {settings:proactive.settings(context.proactiveOwner),status:proactive.status(scope)};}
      if(operation==='proactive.configure'){
        exactFields(input,['expectedRevision','enabled','dailyMessageLimit','dailyCallLimit','minGapSeconds','idleSeconds','timeZone','windowStartMinute','windowEndMinute']);
        const settings=this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>proactive.configure(context.proactiveOwner,input),{allowPaused:true});
        const active=this.#registry.snapshot(this.#owner).active;if(active?.agentId===agentId&&active.kind.startsWith('proactive_'))await this.#cancelForAgent(agentId);
        return {settings,status:proactive.status(scope)};
      }
      if(operation==='plans.list'||operation==='inbox.list'){exactFields(input,[],['cursor','limit']);return operation==='plans.list'?proactive.plans(scope,input):proactive.inbox(scope,input);}
      if(operation==='plans.cancel'){
        exactFields(input,['id']);const result=this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>proactive.cancel(scope,input),{allowPaused:true});
        const active=this.#registry.snapshot(this.#owner).active;if(result.cancelled&&active?.agentId===agentId&&active.kind.startsWith('proactive_'))await this.#cancelForAgent(agentId);return result;
      }
      exactFields(input,['ids']);const result=proactive.markRead(scope,input);await this.#reconcileContacts();return result;
    }
    if(operation==='memory.forget')await this.#cancelForAgent(agentId);
    if(AGENT_OPERATIONS.has(operation)){
      const result=await context.host.request(operation,input);
      if(operation==='memory.list'){
        const scope=context.host.scopeFor(input.contactId);
        const authorized=new Set(context.store.growth.authorizedMemoryIds(scope,result.records.map(record=>record.id)));
        return {...result,records:result.records.map(record=>({...record,growthAuthorized:authorized.has(record.id)}))};
      }
      return result;
    }
    const growth=context.store.growth;
    if(!growth)throw new AgentError('角色状态存储未就绪','NOT_READY');
    if(operation==='growth.get'){exactFields(input,[]);return {growth:growth.settings(context.growthOwner),reflection:growth.status()};}
    if(operation==='reflection.status'){exactFields(input,[]);return growth.status();}
    if(operation==='growth.configure'){
      exactFields(input,['expectedRevision','enabled','dailyCallLimit','minGapSeconds','idleSeconds']);
      const result=this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>growth.configure(context.growthOwner,input),{allowPaused:true});
      await this.#cancelForAgent(agentId);return {growth:result,reflection:growth.status()};
    }
    const scope=context.host.scopeFor(input.contactId);
    if(operation==='growth.sources.list'||operation==='character.list'){
      exactFields(input,['contactId'],operation==='character.list'?['kind','cursor','limit']:['cursor','limit']);const {contactId,...options}=input;return operation==='character.list'?growth.states(scope,options):growth.sources(scope,options);
    }
    const operations={
      'growth.sources.authorize':{keys:['memoryIds','learn','expectedRevision'],method:'authorize'},
      'growth.sources.forget':{keys:['id','expectedRevision'],method:'forget'},
      'growth.sources.requeue':{keys:['sourceIds','learn','expectedRevision'],method:'requeue'},
      'character.dismiss':{keys:['id','expectedRevision'],method:'dismiss'}
    };
    const selected=operations[operation];if(!selected)throw new AgentError('不支持此操作');exactFields(input,['contactId',...selected.keys]);const {contactId,...value}=input;
    if(['forget','dismiss'].includes(selected.method))await this.#cancelForAgent(agentId);
    const result=this.#registry.guard(this.#owner,agentId,profile.profileRevision,()=>growth[selected.method](scope,value),{allowPaused:true});
    if(['forget','dismiss'].includes(selected.method))return {...result,projection:await growth.sync(scope)};
    return result;
  }
  async #cancelForAgent(agentId){const slot=this.#registry.snapshot(this.#owner).active;if(slot?.agentId===agentId){this.#registry.cancel(this.#owner,agentId,slot.taskId);await this.#cancelLocal(agentId,slot.taskId);}}
  /** 内容阶段由同一模型槽与同步策略门编排，不向模型暴露provider或管理能力。 */
  #browse(context,profile,task,signal){
    const scope=this.#proactiveScope(context),commitGuard=operation=>this.#registry.guard(this.#owner,profile.id,profile.profileRevision,()=>context.host.policyGuard(operation),{taskId:task.taskId});
    return context.contentFor(scope).run({runId:task.taskId,signal,commitGuard,reserveCall:({stage})=>this.#registry.reserveContentCall(this.#owner,task.taskId,stage)});
  }
  /** 后台监听拥有独立连接，取消/关闭时必须在数据库释放前等待清理。 */
  async #stopQQListeners(){for(const entry of this.#contexts.values())await (await entry.promise).qq?.stop();}
  async #syncQQListeners(){
    if(this.#closed||!this.#registry.lead(this.#owner)){await this.#stopQQListeners();return;}
    const app=this.#registry.snapshot(this.#owner);
    for(const profile of this.#registry.list(this.#owner)){
      const context=await this.#context(profile);if(!context.qq)continue;
      if(app.paused||profile.paused||profile.archived||context.retiring){await context.qq.stop({cancelLookups:Boolean(profile.archived||context.retiring)});continue;}
      await context.qq.syncListener(operation=>{if(this.#closed||context.retiring)throw new AgentError('QQ监听已停止','CANCELLED');return this.#registry.guard(this.#owner,profile.id,profile.profileRevision,()=>context.host.policyGuard(operation));},()=>{for(const task of this.#active.values())if(task.context===context&&['qq_draft','qq_send'].includes(task.kind)){task.controller.abort();context.host.cancel();}},()=>this.#wakeQQ());
    }
    this.#scheduleQQ();
  }
  /** 可注入时钟的空闲检查；仅消费已有合格事件，不自动读取聊天或调用外部平台。 */
  tick({qqOnly=false}={}) {
    if(this.#closed)return Promise.resolve({status:'closed'});
    if(this.#tickPromise)return this.#tickPromise;
    this.#tickPromise=this.#tick(qqOnly).finally(()=>{this.#tickPromise=null;this.#scheduleQQ();});return this.#tickPromise;
  }
  #proactiveScope(context){return context.proactiveScope??context.host.scopeFor('owner');}
  /** 全局预留与Agent落地结果对账；运行中的缺失消息不能提前取消预留。 */
  async #reconcileContacts(){
    const active=this.#registry.snapshot(this.#owner).active;
    for(const profile of this.#registry.list(this.#owner)){
      const reservations=this.#registry.contactReservations(this.#owner,profile.id);if(!reservations.length)continue;
      const context=await this.#context(profile),scope=this.#proactiveScope(context);
      for(const item of reservations){const state=context.store.proactive.deliveryState(scope,item.id);if(state==='missing'&&active?.taskId===item.id&&active.kind!=='recovery_pending')continue;this.#registry.reconcileContact(this.#owner,profile.id,item.id,state);}
    }
  }
  async #tick(qqOnly=false) {
    await this.synchronizeAuthentication();
    if(!this.#registry.lead(this.#owner)){await this.#stopQQListeners();return {status:'follower'};}
    await this.#syncQQListeners();
    await this.#reconcileContacts();
    const app=this.#registry.snapshot(this.#owner);if(app.paused||app.busy||app.backgroundDailyCallLimit===0||app.budgets.total.remaining===0||app.budgets.background.remaining===0)return {status:'idle'};
    for(const profile of this.#registry.list(this.#owner)){
      if(profile.paused||profile.archived)continue;const context=await this.#context(profile);if(!context.qq?.hasAutomatic())continue;
      const requestedAt=context.qq.timingCheckpoint();return this.#run(profile,'qq_draft',(ctx,task,signal)=>ctx.qq.automaticReply({requestedAt,runId:task.taskId,authenticationSyncMs:task.authenticationSyncMs,signal,
        commitGuard:operation=>this.#registry.guard(this.#owner,profile.id,profile.profileRevision,()=>this.#taskPolicy(ctx,task,operation),{taskId:task.taskId}),
        reserveCall:({stage})=>this.#registry.reserveQQReplyCall(this.#owner,task.taskId,stage)}),'owner');
    }
    if(qqOnly)return {status:'idle'};
    const candidates=[];
    for(const profile of this.#registry.reflectionOrder(this.#owner)) {
      const context=await this.#context(profile),growth=context.store.growth;
      const targetId=context.qq?.nextContactTarget();if(targetId)candidates.push({profile,context,scope:this.#proactiveScope(context),kind:'qq_draft',targetId,priority:4,contactId:'owner'});
      if(context.proactiveFor&&this.#registry.contactAvailable(this.#owner)){
        const scope=this.#proactiveScope(context),policy=context.store.proactive.settings(context.proactiveOwner);
        if(policy.enabled&&this.#now()-app.lastActivity>=policy.idleSeconds*1000){
          const next=this.#registry.guard(this.#owner,profile.id,profile.profileRevision,()=>context.store.proactive.next(scope,{profileRevision:profile.profileRevision,now:this.#now()}));
          if(next)candidates.push({profile,context,scope,kind:next.kind==='contact'?'proactive_contact':'proactive_plan',planId:next.planId,priority:next.kind==='contact'?0:2,contactId:'owner'});
        }
      }
      if(context.contentFor){
        const scope=this.#proactiveScope(context),policy=context.store.content.settings(context.contentOwner);
        if(this.#now()-app.lastActivity>=policy.idleSeconds*1000&&this.#registry.guard(this.#owner,profile.id,profile.profileRevision,()=>context.store.content.next(scope)))candidates.push({profile,context,scope,kind:'content_browse',priority:3,contactId:'owner'});
      }
      if(!growth||!context.reflectionFor||app.reflectionDailyCallLimit===0)continue;
      const policy=growth.settings(context.growthOwner);
      if(!policy.enabled||this.#now()-app.lastActivity<policy.idleSeconds*1000)continue;
      const scope=growth.pendingScopes().find(value=>growth.due(value,this.#now()));
      if(scope)candidates.push({profile,context,scope,kind:'reflection',priority:1,contactId:context.host.contacts.find(contact=>context.host.scopeFor(contact.id).id===scope.id)?.id??(context.store.reply?.ownsScope(scope)?'owner':null)});
    }
    for(const candidate of candidates.sort((a,b)=>a.priority-b.priority)){
      const {profile,scope,kind,planId,contactId,targetId}=candidate;
      try{
        const result=await this.#run(profile,kind,async(ctx,task,signal)=>{
          const commitGuard=operation=>this.#registry.guard(this.#owner,profile.id,profile.profileRevision,()=>this.#taskPolicy(ctx,task,operation),{taskId:task.taskId});
          if(kind==='qq_draft')return ctx.qq.generateContact({targetId},{automatic:true,runId:task.taskId,signal,commitGuard,reserveCall:({stage})=>this.#registry.reserveQQReplyCall(this.#owner,task.taskId,stage)});
          if(kind==='content_browse')return this.#browse(ctx,profile,task,signal);
          if(kind==='reflection')return ctx.reflectionFor(scope).run({signal,reserve:()=>{this.#registry.reserveReflection(this.#owner,task.taskId);return {runId:task.taskId};},commitGuard});
          return ctx.proactiveFor(scope).run({kind:kind==='proactive_plan'?'plan':'contact',planId,signal,commitGuard,
            reserveCall:()=>{this.#registry.reserveProactiveCall(this.#owner,task.taskId);return {runId:task.taskId};},
            reserveMessage:({id})=>this.#registry.reserveContact(this.#owner,task.taskId,id)});
        },contactId);
        await this.#reconcileContacts();return result;
      }catch(error){if(error instanceof AgentError&&['BUDGET','COOLDOWN','BUSY','PAUSED','CANCELLED','UNREAD','CONFLICT'].includes(error.code))continue;throw error;}
    }
    return {status:'idle'};
  }
  /** 关闭先取消本进程任务并等待清理，最后释放各Agent资源和注册库。 */
  close(){
    if(this.#closing)return this.#closing;this.#closed=true;clearInterval(this.#timer);if(this.#wakeTimer!==null)this.#wakeTimers.clearTimeout(this.#wakeTimer);this.#wakeTimer=null;this.#wakeDue=null;
    for(const [taskId,active]of this.#active){this.#registry.cancel(this.#owner,active.agentId,taskId);active.controller.abort();active.context.host.cancel();}
    this.#closing=(async()=>{
      const failures=[];const attempt=async operation=>{try{await operation();}catch(error){failures.push(error);}};
      await attempt(()=>this.#stopQQListeners());await Promise.allSettled([...this.#requests,...(this.#tickPromise?[this.#tickPromise]:[])]);
      for(const entry of this.#contexts.values()){
        let context;try{context=await entry.promise;}catch(error){failures.push(error);continue;}
        await attempt(()=>context.qq?.stop());await attempt(()=>context.host.close());await attempt(()=>context.runtime?.close());
      }
      await attempt(()=>this.#modelConnections?.close());await attempt(()=>this.#registry.close());await attempt(()=>this.#dispose());
      if(failures.length)throw new AggregateError(failures,'应用资源未全部关闭，请检查恢复状态');
    })();return this.#closing;
  }
}
