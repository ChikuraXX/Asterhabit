import {MemorySession} from './memory-session.mjs';
import {MemoryError} from './memory-store.mjs';

/** 桌面前端可以调用的业务操作，不包含文件、进程或原生 Letta 管理命令。 */
export const DESKTOP_OPERATIONS=Object.freeze([
  'app.snapshot','chat.history','chat.send','chat.cancel',
  'memory.list','memory.status','memory.save','memory.correct','memory.forget','memory.sync','memory.recover',
  'permissions.save','permissions.revoke','runtime.pause',
  'simulation.submit','simulation.execute','simulation.cancel','audit.list'
]);

/** 边界错误只携带可展示的操作信息。 */
export class DesktopError extends Error {
  constructor(message,code='INVALID_REQUEST'){super(message);this.name='DesktopError';this.code=code;}
}
/** 只接受合同内字段，避免把普通数据透传为管理参数。 */
function fields(value,required,optional=[]) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new DesktopError('请求参数无效');
  const keys=Object.keys(value);
  if(required.some(key=>!Object.hasOwn(value,key))||keys.some(key=>![...required,...optional].includes(key)))throw new DesktopError('请求字段不符合接口');
}
/** 受限长度文本；ID 不借助路径或名称解析。 */
function text(value,max,label) {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new DesktopError(label+'无效');
  return value.trim();
}

/** 私有桌面宿主。只有此对象持有授权 owner 和记忆 scope，renderer 不持有任何 capability。 */
export class DesktopHost {
  #store; #index; #control; #owner; #gateway; #connect; #connected; #model;
  #scopes=new Map(); #sessions=new Map(); #active=null; #closing=false; #requests=new Set(); #closePromise; #commitGuard; #mutationGuard; #executeGuard;
  constructor({store,index,control,gateway,connect=async()=>{},connected=()=>false,model,commitGuard=operation=>operation(),mutationGuard=operation=>operation(),executeGuard=operation=>operation(),reserveDialogueCall=()=>{},contacts,contextName='private'}) {
    this.#commitGuard=commitGuard;this.#mutationGuard=mutationGuard;this.#executeGuard=executeGuard;
    this.#store=store;this.#index=index;this.#control=control;this.#owner=control.ownerAuthority();
    this.#gateway=gateway;this.#connect=connect;this.#connected=connected;this.#model=model;
    this.contacts=Object.freeze((contacts??[{id:'owner',label:'主人'},{id:'synthetic-alice',label:'测试联系人 A'},{id:'synthetic-bob',label:'测试联系人 B'}]).map(contact=>Object.freeze({id:text(contact.id,200,'联系人标识'),label:text(contact.label,100,'联系人名称')})));
    for(const contact of this.contacts) {
      const scope=store.bind({platform:'local',subject:contact.id,context:contextName});
      this.#scopes.set(contact.id,scope);
      this.#sessions.set(contact.id,new MemorySession({store,scope,gateway,reserveCall:reserveDialogueCall,commitGuard:operation=>this.#commitGuard(()=>this.#control.guard(this.#owner,operation))}));
    }
  }
  /** 仅供可信应用编排层复用已认证范围，不作为renderer操作导出。 */
  scopeFor(id) {return this.#scope(id);}
  policyGuard(operation) {return this.#control.guard(this.#owner,operation);}
  /** 确认固定本地联系人；不信任外部消息携带的账户或 scope。 */
  #scope(id) {
    const scope=this.#scopes.get(id);
    if(!scope)throw new DesktopError('联系人不存在');
    return scope;
  }
  /** 防止操作与此联系人正在运行的模型回合交错；遗忘可立即使旧版本失效。 */
  #idle(id) {if(this.#active?.contactId===id)throw new DesktopError('该联系人正在对话，请先停止','BUSY');}
  /** 安全快照仅包含界面所需状态。 */
  snapshot() {
    const control=this.#control.snapshot(this.#owner);
    return {runtime:{connected:this.#connected(),model:this.#model,paused:control.paused,busy:Boolean(this.#active),busyContactId:this.#active?.contactId??null},contacts:this.contacts,control};
  }
  /** 中止自己的当前请求，原生清理完成后才解除 busy。 */
  cancel() {
    if(!this.#active||this.#active.committed)return {cancelled:false};
    this.#active.controller.abort();
    return {cancelled:true};
  }
  /** 受控聊天：建立连接后再创建记忆租约，失败不会伪造学习或执行结果。 */
  async #chat(payload) {
    fields(payload,['contactId','text','learn']);
    this.#scope(payload.contactId);
    const prompt=text(payload.text,6000,'消息');
    if(typeof payload.learn!=='boolean')throw new DesktopError('学习开关无效');
    if(this.#control.snapshot(this.#owner).paused)throw new DesktopError('当前已暂停','PAUSED');
    if(this.#active)throw new DesktopError('已有对话正在运行','BUSY');
    const controller=new AbortController();
    const active={contactId:payload.contactId,controller,committed:false,promise:null};
    this.#active=active;
    active.promise=(async()=>{
      try {
        await this.#connect(controller.signal);
        if(controller.signal.aborted)throw new MemoryError('本轮已停止');
        if(this.#control.snapshot(this.#owner).paused)throw new DesktopError('当前已暂停','PAUSED');
        const result=await this.#sessions.get(payload.contactId).reply(prompt,{learn:payload.learn,grow:this.#store.growth?.turnPolicy().enabled??false,signal:controller.signal,onCommitted:()=>{active.committed=true;}});
        if(result.suppressed) {
          try{this.#control.recordReplySuppressed(this.#owner);}
          catch(error){console.error('静默回合审计写入失败：'+(error?.name??'Error'));}
        }
        return result;
      } finally {if(this.#active===active)this.#active=null;}
    })();
    return await active.promise;
  }
  /** 按 operation 分派，数据不能增添新的能力或改变执行路径。 */
  request(operation,payload) {
    if(this.#closing)return Promise.reject(new DesktopError('控制台正在关闭','CLOSING'));
    const task=this.#dispatch(operation,payload);
    this.#requests.add(task);
    return task.finally(()=>this.#requests.delete(task));
  }
  /** 具体业务分派与在途任务登记分离，使关闭能等待所有资源使用者。 */
  async #dispatch(operation,payload) {
    if(!DESKTOP_OPERATIONS.includes(operation))throw new DesktopError('不支持此操作');
    if(operation==='chat.send')return this.#chat(payload);
    if(operation==='app.snapshot'){fields(payload,[]);return this.snapshot();}
    if(operation==='chat.cancel'){fields(payload,[]);return this.cancel();}
    if(operation==='runtime.pause') {
      fields(payload,['paused']);
      if(typeof payload.paused!=='boolean')throw new DesktopError('暂停开关无效');
      const result=this.#control.setPaused(this.#owner,payload.paused);
      if(payload.paused)this.cancel();
      return result;
    }
    if(operation==='chat.history') {
      fields(payload,['contactId']);return {messages:this.#store.history(this.#scope(payload.contactId),{includeMetadata:true})};
    }
    if(operation==='memory.status'){fields(payload,['contactId']);const scope=this.#scope(payload.contactId);return {...this.#store.status(scope),records:this.#store.list(scope).length,pendingCleanup:this.#store.nativeLeases(scope).length,manualPendingTotal:this.#index?.manualPending??0};}
    if(operation==='memory.list') {
      fields(payload,['contactId'],['query']);
      if(payload.query!==undefined&&(typeof payload.query!=='string'||payload.query.length>6000))throw new DesktopError('检索内容无效');
      const scope=this.#scope(payload.contactId);
      return {records:this.#store.search(scope,payload.query??'',{limit:30}),status:this.#store.status(scope)};
    }
    if(operation==='memory.save'||operation==='memory.correct') {
      fields(payload,operation==='memory.save'?['contactId','topic','text']:['contactId','id','text']);
      const scope=this.#scope(payload.contactId);
      this.#idle(payload.contactId);
      const content=text(payload.text,600,'记忆');
      const source={origin:'user',text:content,reference:'local:desktop-owner'};
      const record=this.#mutationGuard(()=>operation==='memory.save'
        ?this.#store.remember(scope,{topic:text(payload.topic,100,'主题'),text:content},source)
        :this.#store.correct(scope,text(payload.id,100,'记忆标识'),content,source));
      await this.#gateway.invalidateScope?.(scope.id);
      await this.#store.sync(scope);
      await this.#store.growth?.sync(scope);
      return {record,status:this.#store.status(scope)};
    }
    if(operation==='memory.forget') {
      fields(payload,['contactId','id']);const scope=this.#scope(payload.contactId);
      if(this.#active?.contactId===payload.contactId)this.cancel();
      this.#mutationGuard(()=>this.#store.forget(scope,text(payload.id,100,'记忆标识')));
      await this.#gateway.invalidateScope?.(scope.id);
      await this.#store.sync(scope);
      await this.#store.growth?.sync(scope);
      return {forgotten:true,status:this.#store.status(scope)};
    }
    if(operation==='memory.sync') {
      fields(payload,['contactId']);const scope=this.#scope(payload.contactId);
      await this.#store.sync(scope);return {status:this.#store.status(scope)};
    }
    if(operation==='memory.recover') {
      fields(payload,['contactId']);this.#scope(payload.contactId);this.#idle(payload.contactId);
      await this.#connect();
      await this.#sessions.get(payload.contactId).recover();return {recovered:true};
    }
    if(operation==='permissions.save') {
      fields(payload,['expectedRevision','grant']);
      fields(payload.grant,['account','target','action','limit','windowSeconds','expiresAt','enabled'],['id']);
      return {grant:this.#control.saveGrant(this.#owner,{...payload.grant,expectedRevision:payload.expectedRevision})};
    }
    if(operation==='permissions.revoke') {
      fields(payload,['id','expectedRevision']);
      this.#control.revokeGrant(this.#owner,text(payload.id,100,'授权标识'),payload.expectedRevision);return {revoked:true};
    }
    if(operation==='simulation.submit') {
      fields(payload,['idempotencyKey','account','target','action','content']);
      return {action:this.#control.submit(payload)};
    }
    if(operation==='simulation.execute'||operation==='simulation.cancel') {
      fields(payload,['id']);const id=text(payload.id,100,'动作标识');
      return {action:operation==='simulation.execute'?this.#executeGuard(()=>this.#control.execute(this.#owner,id)):this.#control.cancel(this.#owner,id)};
    }
    if(operation==='audit.list'){fields(payload,[]);return {audit:this.#control.snapshot(this.#owner).audit};}
    throw new DesktopError('不支持此操作');
  }
  /** 先停止并等待自己的回合，再释放索引和数据库；不停止其他客户端共用的 Letta 服务。 */
  async close() {
    if(this.#closePromise)return this.#closePromise;
    this.#closing=true;
    this.cancel();
    this.#closePromise=(async()=>{
      await Promise.allSettled([...this.#requests]);
      await this.#store.drain();
      this.#index.close();this.#store.close();this.#control.close();
    })();
    return this.#closePromise;
  }
}
