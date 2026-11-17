import {confirmNativeExecution,discardNativeExecution} from './native-execution-lifecycle.mjs';
import {OneBotClient,validateOneBotConnection} from './onebot-client.mjs';
import {randomBytes} from 'node:crypto';
import {QQContactSession} from './qq-contact-session.mjs';
import {QQDraftSession} from './qq-draft-session.mjs';
import {QQError,decodeQQEvent} from './qq-store.mjs';
import {validateQQBotConnection} from './qqbot-client.mjs';
function fields(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new QQError('QQ请求字段无效');}
function signalCheck(signal){if(signal?.aborted)throw new QQError('QQ本轮已停止','CANCELLED');}

/** 官方QQ服务；收件不占模型槽，生成和发送必须由可信宿主调用。 */
export class QQService{
 #store;#owner;#codec;#client;#memory;#reply;#replyOwner;#gateway;#leaseScope;#profileRevision;#sender;#now;
 #listener=null;#listenerState={state:'stopped',errorCode:null};#pairing=null;#queue=[];#retryAfter=0;#manual=false;#generation=0;
 #onebot;#contactOwner;
 #targetNames=new Map();#lastNameRequest=null;
 #groupStates=new Map();#lastGroupStateRequest=null;
 #groupReads=new Set();
 constructor({store,owner=store.qq.ownerAuthority(),codec,client,gateway,leaseScope,profileRevision=0,sender,onebot=new OneBotClient(),now=Date.now}){this.#onebot=onebot;this.#contactOwner=store.contact.ownerAuthority();this.#store=store.qq;this.#owner=owner;this.#codec=codec;this.#client=client;this.#memory=store;this.#reply=store.reply;this.#replyOwner=store.reply.ownerAuthority();this.#gateway=gateway;this.#leaseScope=leaseScope??store.bind({platform:'local',subject:'owner',context:'private'});this.#profileRevision=profileRevision;this.#sender=sender;this.#now=now;}
 status(){const pairing=this.#pairing&&this.#pairing.expiresAt>this.#now()?{expiresAt:this.#pairing.expiresAt}:null;return {...this.#store.connection(this.#owner),storage:this.#codec.available?'windows-user':'unavailable',listener:{...this.#listenerState},pairing};}
 /** 可信宿主的请求时点，仅用于分段诊断。 */
 timingCheckpoint(){return this.#memory.replyTimings.checkpoint();}
 latency(input={}){if(!input||Array.isArray(input)||Object.keys(input).some(k=>k!=='limit')||input.limit!==undefined&&(!Number.isInteger(input.limit)||input.limit<1||input.limit>50))throw new QQError('耗时查询仅支持1至50条记录');return this.#memory.replyTimings.list(input);}
 settings(){return {settings:this.#store.settings(this.#owner)};}
 /** 只检查当前绑定、已保存白名单群的平台接收设置；60秒缓存，不修改任何授权。 */
 async groupState(input,{signal,commitGuard}={}){
  if(this.#groupReads.size)throw new QQError('群状态查询正在进行','BUSY');
  const controller=new AbortController();this.#groupReads.add(controller);
  try{return await this.#readGroupState(input,{signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,commitGuard});}
  finally{this.#groupReads.delete(controller);}
 }
 /** 查询有独立取消所有权；暂停下允许显式只读核验，关闭/换号仍会取消。 */
 async #readGroupState(input,{signal,commitGuard}){
  fields(input,['expectedRevision','groupOpenid']);if(typeof input.groupOpenid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.groupOpenid))throw new QQError('QQ群OpenID无效');
  const check=()=>{signalCheck(signal);this.#store.assertRevision(this.#owner,input.expectedRevision);if(!this.#store.settings(this.#owner).allowedGroupIds.includes(input.groupOpenid))throw new QQError('请先保存此群的接收范围','FORBIDDEN');};this.#guard(commitGuard,check);
  const key=input.expectedRevision+':'+input.groupOpenid,cached=this.#groupStates.get(key);if(cached&&cached.expires>this.#now())return {...cached.value};
  if(this.#lastGroupStateRequest!==null&&this.#now()-this.#lastGroupStateRequest<2000)throw new QQError('群资料查询过于频繁，请稍后重试','COOLDOWN');
  if(typeof this.#client.groupState!=='function')throw new QQError('QQ群状态查询未就绪','NOT_READY');
  const credentials=await this.#credentials(input.expectedRevision,signal);this.#guard(commitGuard,check);this.#lastGroupStateRequest=this.#now();
  if(credentials.accountId)throw new QQError('OneBot不提供官方群接收设置查询','NOT_READY');const state=await this.#client.groupState({...credentials,groupOpenid:input.groupOpenid,signal});
  return this.#guard(commitGuard,()=>{check();if(state?.openid!==input.groupOpenid||!['all','only_mention','mention_and_context','unknown'].includes(state.receiveMode))throw new QQError('QQ群状态响应无效');const value={openid:state.openid,receiveMode:state.receiveMode,reportedMode:typeof state.reportedMode==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(state.reportedMode)?state.reportedMode:state.receiveMode==='unknown'?null:state.receiveMode,checkedAt:this.#now()};if(this.#groupStates.size>=50)this.#groupStates.delete(this.#groupStates.keys().next().value);this.#groupStates.set(key,{value,expires:this.#now()+60000});return {...value};});
 }
 /** 名称只用于展示：群名来自固定资料API，用户昵称来自已授权单聊，不改变白名单。 */
 async resolveTarget(input,{signal,commitGuard}={}){
  fields(input,['expectedRevision','kind','openid']);if(!['group','user'].includes(input.kind)||typeof input.openid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.openid))throw new QQError('QQ资料查询参数无效');
  const check=()=>{signalCheck(signal);this.#store.assertRevision(this.#owner,input.expectedRevision);};this.#guard(commitGuard,check);
  if(input.kind==='user'){const name=this.#store.userName(this.#owner,input.openid);return {kind:'user',openid:input.openid,name,source:name?'message':'unavailable'};}
  const key=input.expectedRevision+':'+input.openid,cached=this.#targetNames.get(key);if(cached&&cached.expires>this.#now())return {...cached.value};
  if(this.#lastNameRequest!==null&&this.#now()-this.#lastNameRequest<2000)throw new QQError('群资料查询过于频繁，请稍后重试','COOLDOWN');
  const credentials=await this.#credentials(input.expectedRevision,signal);this.#guard(commitGuard,check);this.#lastNameRequest=this.#now();
  const info=await this.#connectionClient(credentials).groupInfo({...credentials,groupOpenid:input.openid,signal});
  return this.#guard(commitGuard,()=>{check();if(info?.openid!==input.openid||!(info.name===null||typeof info.name==='string'&&info.name.length<=200))throw new QQError('QQ资料响应无效');const value={kind:'group',openid:input.openid,name:info.name,source:info.name?'platform':'unavailable'};if(this.#targetNames.size>=50)this.#targetNames.delete(this.#targetNames.keys().next().value);this.#targetNames.set(key,{value,expires:this.#now()+600000});return {...value};});
 }
 /** 同步撤销被新消息替代的草稿缓存；不在收件事务中进行网络清理。 */
 #ingest(claim,packet){const accepted=this.#store.ingest(this.#owner,claim,packet);if(accepted){const event=decodeQQEvent(packet,this.#now());for(const runtime of this.#reply.invalidRuntimes(this.#replyOwner,{...event,selfId:claim.selfId}))discardNativeExecution(this.#gateway,runtime);}return accepted;}
 #guard(gate,fn){if(typeof gate!=='function')throw new QQError('QQ宿主门缺失');const result=gate(fn);if(result&&typeof result.then==='function')throw new QQError('QQ提交门必须同步');return result;}
 #supported(){if(!this.#codec.available)throw new QQError('本机安全凭据存储不可用','NOT_READY');}
 async #credentials(revision,signal){const sealed=this.#store.encrypted(this.#owner,revision);const appSecret=await this.#codec.unprotect(sealed.ciphertext,{signal});signalCheck(signal);return sealed.transport==='onebot'?validateOneBotConnection({endpoint:sealed.endpoint,accountId:sealed.appId,accessToken:appSecret}):validateQQBotConnection({appId:sealed.appId,appSecret});}
 /** 连接类型来自已验证持久配置，不接受模型指定传输。 */
 #connectionClient(credentials){return credentials.accountId?this.#onebot:this.#client;}
 /** 核验OneBot账号后保存令牌密文，绑定本身不会开启接收或发送。 */
 async bindOneBot(input,{signal,commitGuard}){
  fields(input,['expectedRevision','endpoint','accountId','accessToken']);this.#supported();const connection=validateOneBotConnection(input);
  const check=()=>{signalCheck(signal);this.#store.assertRevision(this.#owner,input.expectedRevision);};this.#guard(commitGuard,check);
  const identity=await this.#onebot.identity({...connection,signal});this.#guard(commitGuard,check);const ciphertext=await this.#codec.protect(connection.accessToken,{signal});
  await this.stop();return this.#guard(commitGuard,()=>{check();this.#store.bind(this.#owner,{expectedRevision:input.expectedRevision,appId:connection.accountId,label:identity.label,ciphertext,transport:'onebot',endpoint:connection.endpoint});return this.status();});
 }
 async bind(input,{signal,commitGuard}){
  fields(input,['expectedRevision','appId','appSecret']);this.#supported();const connection=validateQQBotConnection({appId:input.appId,appSecret:input.appSecret});
  const check=()=>{signalCheck(signal);this.#store.assertRevision(this.#owner,input.expectedRevision);};this.#guard(commitGuard,check);
  const identity=await this.#client.identity({...connection,signal});if(identity.id!==connection.appId)throw new QQError('QQ身份核对失败');this.#guard(commitGuard,check);
  const ciphertext=await this.#codec.protect(connection.appSecret,{signal});
  return this.#guard(commitGuard,()=>{check();this.stop();this.#store.bind(this.#owner,{expectedRevision:input.expectedRevision,appId:connection.appId,label:identity.label,ciphertext});return this.status();});
 }
 unbind(input,{commitGuard}={}){fields(input,['expectedRevision']);return this.#guard(commitGuard,()=>{this.#store.unbind(this.#owner,input.expectedRevision);this.stop();return this.status();});}
 configure(input,{commitGuard}={}){return this.#guard(commitGuard,()=>{const settings=this.#store.configure(this.#owner,input);this.stop();return {settings};});}
 messages(){return this.#store.messages(this.#owner);}
 forget(input,{commitGuard}={}){fields(input,['id']);return this.#guard(commitGuard,()=>{this.#queue=this.#queue.filter(item=>item.eventId!==input.id);return this.#store.forget(this.#owner,input.id);});}
 /** 遗忘仅同步该联系人的派生索引。 */
 async syncForgotten(eventId){const event=this.#store.event(this.#owner,eventId,{active:false});if(!event||event.status!=='forgotten')return null;const scope=this.#memory.bind({platform:'qq',subject:event.selfId+':'+event.senderId,context:event.kind==='private'?'private':'group:'+event.groupId});await this.#gateway.invalidateScope?.(scope.id);return this.#memory.refreshQQScope(scope);}
 /** 主动权限与接收权限分别管理，只允许固定的私聊目标。 */
 contactPolicies(){return this.#memory.contact.policies(this.#contactOwner);}
 configureContact(input,{commitGuard}){return this.#guard(commitGuard,()=>({policy:this.#memory.contact.configure(this.#contactOwner,input)}));}
 /** 后台仅选择待生成目标，不派发任何主动消息。 */
 nextContactTarget(){return this.#memory.contact.nextAutomaticTarget(this.#contactOwner,{profileRevision:this.#profileRevision});}
 contactPlans(){return this.#memory.contact.list(this.#contactOwner,{profileRevision:this.#profileRevision});}
 generateContact(input,options){fields(input,['targetId']);return new QQContactSession({store:this.#memory,owner:this.#contactOwner,gateway:this.#gateway,scope:this.#leaseScope,profileRevision:this.#profileRevision}).generate({...input,...options});}
 updateContact(input,{commitGuard}){fields(input,['id','expectedRevision','text']);return this.#guard(commitGuard,()=>({plan:this.#memory.contact.update(this.#contactOwner,{...input,profileRevision:this.#profileRevision})}));}
 cancelContact(input,{commitGuard}){fields(input,['id','expectedRevision']);return this.#guard(commitGuard,()=>this.#memory.contact.cancel(this.#contactOwner,input));}
 /** 审核当前计划的固定目标和全文；派发前再进入同步宿主门。 */
 async sendContact(input,{signal,commitGuard}){
  fields(input,['id','expectedRevision','confirmationHash']);this.#supported();
  const store=this.#memory.contact,claim=this.#guard(commitGuard,()=>{signalCheck(signal);return store.prepareSend(this.#contactOwner,{...input,profileRevision:this.#profileRevision});});
  let result;
  try{const credentials=await this.#credentials(claim.connectionRevision,signal);if(!credentials.accountId)throw new QQError('主动联系仅支持OneBot');result=await this.#onebot.sendText({...credentials,target:claim.target,text:claim.text,signal,dispatch:sendNow=>this.#guard(commitGuard,()=>{signalCheck(signal);return store.dispatchSend(this.#contactOwner,claim,sendNow);})});}
  catch(error){const plan=store.finishSend(this.#contactOwner,claim,{outcome:error?.dispatched&&!error?.confirmedRejected?'unknown':'failed',confirmedRejected:error?.confirmedRejected===true,errorCode:error?.code??null});return {outcome:plan.status,plan};}
  const plan=store.finishSend(this.#contactOwner,claim,{outcome:'sent',messageId:result.messageId});return {outcome:'sent',plan};
 }
 replySettings(){return {settings:this.#reply.settings(this.#replyOwner),status:this.#reply.status(this.#replyOwner)};}
 configureReplies(input,{commitGuard}={}){return this.#guard(commitGuard,()=>{this.#reply.configure(this.#replyOwner,input);this.stop();return this.replySettings();});}
 listDrafts(input={}){if(!input||Object.keys(input).some(key=>key!=='eventId'))throw new QQError('QQ草稿查询字段无效');return this.#reply.list(this.#replyOwner,{...input,profileRevision:this.#profileRevision});}
  records(input={}){return this.#reply.records(this.#replyOwner,input);}
  forgetRecord(input,{commitGuard}={}){fields(input,['id']);return this.#guard(commitGuard,()=>this.#reply.forgetRecord(this.#replyOwner,input.id));}
 updateDraft(input,{commitGuard}={}){fields(input,['id','expectedRevision','text']);return this.#guard(commitGuard,()=>{this.#reviewMode();this.#reply.list(this.#replyOwner,{profileRevision:this.#profileRevision});return {draft:this.#reply.update(this.#replyOwner,input)};});}
 cancelDraft(input,{commitGuard}={}){fields(input,['id','expectedRevision']);const result=this.#guard(commitGuard,()=>this.#reply.cancel(this.#replyOwner,input));discardNativeExecution(this.#gateway,this.#reply.runtimeForDraft(this.#replyOwner,input.id));return result;}
 #draftSession(){if(!this.#gateway)throw new QQError('QQ对话模型未就绪','NOT_READY');return new QQDraftSession({store:this.#memory,owner:this.#replyOwner,scope:this.#leaseScope,gateway:this.#gateway,profileRevision:this.#profileRevision});}
 #reviewMode(){if(this.#reply.settings(this.#replyOwner).autoReplyEnabled)throw new QQError('当前为自动回复模式','FORBIDDEN');}
 generateDraft(input,options){fields(input,['eventId','learn']);this.#reviewMode();return this.#draftSession().generate({...input,...options});}
 sendDraft(input,options={}){fields(input,['id','expectedRevision','confirmationHash']);this.#reviewMode();return this.#send(input,options,'review');}
 /** 发送全文/目标取自不可伪造claim；token准备后再次执行同步派发门。 */
 async #send(input,{signal,commitGuard,requestedAt},mode){
  this.#supported();if(!this.#sender)throw new QQError('QQ发送适配器未就绪','NOT_READY');
  const claim=this.#guard(commitGuard,()=>{signalCheck(signal);return this.#reply.prepareSend(this.#replyOwner,{...input,profileRevision:this.#profileRevision,mode});});
  const nativeRuntime=this.#reply.runtimeForDraft(this.#replyOwner,claim.id);
  this.#memory.replyTimings.beginSend(claim.attemptId,claim.id,mode==='automatic'?'automatic':'manual',requestedAt);
  let receipt,result,settledAt;
  try{const credentials=await this.#credentials(claim.connectionRevision,signal);result=await (credentials.accountId?this.#onebot:this.#sender).sendText({...credentials,target:claim.target,text:claim.text,messageId:claim.event.messageId,signal,dispatch:sendNow=>this.#guard(commitGuard,()=>{signalCheck(signal);return this.#reply.dispatchSend(this.#replyOwner,claim,()=>{this.#memory.replyTimings.dispatched(claim.attemptId);return sendNow();});})});}
  catch(error){discardNativeExecution(this.#gateway,nativeRuntime);settledAt=this.#memory.replyTimings.checkpoint();const outcome=error?.dispatched===true&&!error?.confirmedRejected?'unknown':'failed',errorCode=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code)?error.code:'UNKNOWN';receipt=this.#reply.finishSend(this.#replyOwner,claim,{outcome,confirmedRejected:error?.confirmedRejected===true,receipt:error?.receipt??null,errorCode});this.#memory.replyTimings.finishSend(claim.attemptId,receipt.draft.status==='unknown'?'unknown':outcome,settledAt);return {outcome:receipt.draft.status==='unknown'?'unknown':outcome,draft:receipt.draft};}
  settledAt=this.#memory.replyTimings.checkpoint();this.#memory.replyTimings.finishSend(claim.attemptId,'sent',settledAt);receipt=this.#reply.finishSend(this.#replyOwner,claim,{outcome:'sent',messageId:result.messageId,receipt:result.receipt??{httpStatus:null,platformCode:null,messageId:result.messageId,timestamp:null,traceId:null},errorCode:null});if(receipt.canLearn)confirmNativeExecution(this.#gateway,nativeRuntime,claim.text,this.#store.confirmedHistory(this.#owner,claim.event));else discardNativeExecution(this.#gateway,nativeRuntime);let learningError=null;
  if(receipt.canLearn){try{if(claim.groupContext)this.#reply.markLearning(this.#replyOwner,claim.id,{});else{const learning=await this.#draftSession().finishLearning(claim,{commitGuard});learningError=learning.learningError??null;}}catch(error){learningError='回复已发送，但本地学习记录未完成';console.error('QQ发送后学习记录失败：'+(error?.name??'Error'));}}
  const current=this.#reply.list(this.#replyOwner,{profileRevision:this.#profileRevision}).entries.find(draft=>draft.id===claim.id);return {outcome:'sent',draft:current??receipt.draft,learningError};
 }
 recoverReplies(){this.#memory.replyTimings.recover();this.#memory.contact.recover(this.#contactOwner);const result=this.#reply.recoverInterrupted(this.#replyOwner);for(const scope of this.#reply.knownScopes())this.#memory.growth.recoverInterrupted(scope,'crashed');return result;}
 /** 手动接收不调用模型，自动监听时拒绝另建连接。 */
 async receive(input,{signal,commitGuard}={}){
  fields(input,['expectedRevision']);this.#supported();this.#reviewMode();if(this.#manual||this.#listener)throw new QQError('QQ正在监听','BUSY');const started=Date.now();
  const claim=this.#guard(commitGuard,()=>{signalCheck(signal);if(this.#store.settings(this.#owner).revision!==input.expectedRevision)throw new QQError('QQ接收配置已变化','CONFLICT');return this.#store.beginReceive(this.#owner,this.status().revision);});
  this.#manual=true;let received=0,ignored=0;
  try{const credentials=await this.#credentials(claim.connectionRevision,signal),remaining=30000-(Date.now()-started);if(remaining<=0)throw new QQError('QQ接收准备超时','TIMEOUT');
   await this.#connectionClient(credentials).receive({...credentials,signal,durationMs:remaining,onEvent:packet=>{if(received>=20||Date.now()-started>=30000)return false;const accepted=this.#guard(commitGuard,()=>{signalCheck(signal);return this.#ingest(claim,packet);});if(accepted)received++;else ignored++;return received<20;}});
   return this.#guard(commitGuard,()=>{signalCheck(signal);this.#store.assertReceive(this.#owner,claim);return {received,ignored,durationSeconds:30};});
  }finally{this.#manual=false;}
 }
 /** 配对码有效5分钟，仅驻留内存；不触发模型或对外回复。 */
 async startPairing(input,{commitGuard}={}){fields(input,['expectedRevision']);this.#supported();this.#guard(commitGuard,()=>{this.#store.encrypted(this.#owner,input.expectedRevision);if(this.#manual)throw new QQError('QQ正在监听','BUSY');});await this.stop();return this.#guard(commitGuard,()=>{this.#store.assertRevision(this.#owner,input.expectedRevision);const code='QQ-'+randomBytes(16).toString('hex'),expiresAt=this.#now()+300000;this.#pairing={code,expiresAt,revision:input.expectedRevision};return {code,expiresAt};});}
 /** 同步撤销队列/配对并取消连接；返回清理Promise供关闭屏障等待。 */
 stop({cancelLookups=true}={}){for(const runtime of this.#reply.invalidRuntimeBindings(this.#replyOwner,this.#profileRevision))discardNativeExecution(this.#gateway,runtime);this.#store.clearFollowups(this.#owner);if(cancelLookups)for(const controller of this.#groupReads)controller.abort();this.#generation++;this.#queue=[];this.#pairing=null;this.#retryAfter=0;this.#listenerState={state:'stopped',errorCode:null};const active=this.#listener;if(active)active.controller.abort();return active?.promise??Promise.resolve();}
 /** 仅由持有调度leader的宿主启动；后台只收件，模型由宿主另行领取。 */
  async syncListener(commitGuard,onRevoked=()=>{},onQueued=()=>{}){
  if(this.#listener?.controller.signal.aborted)await this.#listener.promise;
  const status=this.status(),policy=this.#store.settings(this.#owner),reply=this.#reply.settings(this.#replyOwner);
  if(this.#pairing&&this.#pairing.expiresAt<=this.#now()){this.#pairing=null;const expired=this.#listener;expired?.controller.abort();await expired?.promise;}
  // 持续接收只由有效绑定和接收策略控制；自动回复是收件后的独立可选动作。
  const receiving=policy.receiveEnabled;
  const automatic=reply.enabled&&reply.autoReplyEnabled&&receiving;
  if(!status.selfId||!this.#pairing&&!receiving){if(this.#listener)await this.stop();return;}
  if(this.#listener||this.#manual||this.#now()<this.#retryAfter)return;
  this.#guard(commitGuard,()=>true);const controller=new AbortController(),generation=this.#generation,active={controller,promise:null};this.#listener=active;this.#listenerState={state:'connecting',errorCode:null};
  active.promise=(async()=>{let watcher;
   try{const credentials=await this.#credentials(status.revision,controller.signal),claim=receiving?this.#guard(commitGuard,()=>this.#store.beginReceive(this.#owner,status.revision)):null;
    watcher=setInterval(()=>{try{this.#guard(commitGuard,()=>{this.#store.assertRevision(this.#owner,status.revision);if(generation!==this.#generation||this.#pairing&&this.#pairing.expiresAt<=this.#now())controller.abort();});}catch{controller.abort();}},250);watcher.unref();
    await this.#connectionClient(credentials).receive({...credentials,signal:controller.signal,durationMs:Infinity,onState:state=>{if(!controller.signal.aborted)this.#listenerState={state,errorCode:null};},onEvent:packet=>this.#guard(commitGuard,()=>{
     signalCheck(controller.signal);if(generation!==this.#generation)return false;const decoded=decodeQQEvent(packet,this.#now());
     if(this.#pairing&&decoded?.kind==='private'&&decoded.text===this.#pairing.code&&this.#pairing.expiresAt>this.#now()){this.#store.addPairedUser(this.#owner,this.#pairing.revision,decoded.senderId);this.#pairing=null;controller.abort();return false;}
     if(['FRIEND_DEL','C2C_MSG_REJECT','GROUP_DEL_ROBOT','GROUP_MSG_REJECT'].includes(packet?.t)){
      const current=this.#store.settings(this.#owner),privateRevoked=['FRIEND_DEL','C2C_MSG_REJECT'].includes(packet.t),id=privateRevoked?packet.d?.openid:packet.d?.group_openid;
      if(typeof id==='string'){const users=privateRevoked?current.allowedUserIds.filter(value=>value!==id):current.allowedUserIds,groups=privateRevoked?current.allowedGroupIds:current.allowedGroupIds.filter(value=>value!==id);
       this.#store.configure(this.#owner,{expectedRevision:current.revision,receiveEnabled:current.receiveEnabled&&Boolean(users.length||groups.length),sendEnabled:false,proactiveEnabled:false,allowedUserIds:users,allowedGroupIds:groups,groupMentionsOnly:current.groupMentionsOnly});controller.abort();this.#queue=[];onRevoked();}return false;
     }
     if(!claim||!decoded||!this.#ingest(claim,packet))return true;
     // 审核模式只持久化收件；没有自动回复授权时绝不进入生成/发送队列。
     if(!automatic)return true;
     const event=this.#store.messages(this.#owner).entries.find(row=>row.messageId===decoded.messageId&&row.senderId===decoded.senderId&&row.groupId===decoded.groupId);
     // 与审核模式一致，同一会话只回复最新消息；淘汰缓存不会留下失效队列项。
     this.#queue=this.#queue.filter(item=>{const previous=this.#store.event(this.#owner,item.eventId);return previous&&this.#store.isLatestAutomaticEvent(this.#owner,previous);});
     if(event){this.#memory.replyTimings.queued(event.id,this.#reply.automaticDelay(this.#replyOwner));this.#queue.push({eventId:event.id,generation,settingsRevision:reply.revision});onQueued();}return true;
    })});
   }catch(error){if(!controller.signal.aborted){this.#retryAfter=this.#now()+60000;this.#listenerState={state:'error',errorCode:typeof error?.code==='string'&&/^(QQBOT_|ONEBOT_|CONFLICT|FORBIDDEN|PAUSED|CANCELLED)/.test(error.code)?error.code:'QQBOT_CONNECTION_FAILED'};}}
   finally{clearInterval(watcher);if(this.#listener===active){this.#listener=null;if(this.#listenerState.state!=='error')this.#listenerState={state:'stopped',errorCode:null};}}
  })();
 }
 /** 队列只含开启后新入库事件；重启不重放历史或已有草稿。 */
 hasAutomatic(){return this.nextAutomaticDelay()===0;}
 /** 只为现存、有效的待回复消息提供唤醒时间，不重放已处理事件。 */
 nextAutomaticDelay(){this.#queue=this.#queue.filter(item=>{const event=this.#store.event(this.#owner,item.eventId);return item.generation===this.#generation&&event&&event.replyExpiresAt>this.#now()&&this.#store.isLatestAutomaticEvent(this.#owner,event);});return this.#queue.length?this.#reply.automaticDelay(this.#replyOwner):null;}
 async automaticReply({signal,commitGuard,...options}){
  const item=this.#queue.shift();if(!item)return {outcome:'idle'};
  try{this.#guard(commitGuard,()=>{signalCheck(signal);const reply=this.#reply.settings(this.#replyOwner);if(item.generation!==this.#generation||!reply.enabled||!reply.autoReplyEnabled||reply.revision!==item.settingsRevision)throw new QQError('QQ自动回复授权已变化','CONFLICT');this.#store.assertReplyWindow(this.#owner,this.#store.event(this.#owner,item.eventId));});
   const event=this.#store.event(this.#owner,item.eventId);if(!this.#store.isLatestAutomaticEvent(this.#owner,event))throw new QQError('QQ群聊上下文已变化','CONFLICT');const result=await this.#draftSession().generate({eventId:item.eventId,learn:false,signal,commitGuard,...options,mode:'automatic',selectGroupReply:event.kind==='group'&&!this.#store.settings(this.#owner).groupMentionsOnly});if(result.outcome!=='drafted')return result;
   const draft=result.draft;return await this.#send({id:draft.id,expectedRevision:draft.revision,confirmationHash:draft.confirmationHash},{signal,commitGuard},'automatic');
  }catch(error){if(this.#memory.pendingNativeLeaseCount()>0||this.#reply.pendingSendCount()>0)throw error;return {outcome:'failed',errorCode:error?.code??'QQ_REPLY_FAILED'};}
 }
}
