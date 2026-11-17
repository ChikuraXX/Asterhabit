import {QQContactStore} from './qq-contact-store.mjs';
import {QQReplyTimings} from './qq-reply-timings.mjs';
import {QQStore} from './qq-store.mjs';
import {QQReplyStore} from './qq-reply-store.mjs';
import {BilibiliAccountStore} from './bilibili-account-store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync,chmodSync } from 'node:fs';
import path from 'node:path';
import {CharacterStore} from './character-store.mjs';
import {CharacterGraphIndex} from './character-index.mjs';
import {ContentStore} from './content-store.mjs';
import {ProactiveStore} from './proactive-store.mjs';

/** 受控记忆操作错误，不携带凭据或原始输入。 */
export class MemoryError extends Error {
  constructor(message){super(message);this.name='MemoryError';}
}
/** 仅用于常见凭据格式筛选，不能识别所有未标注的秘密。 */
export function containsSecret(value) {
  return /(?:sk-[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{12,}\.|(?:password|passwd|cookie|authorization|access[_ -]?token|api[_ -]?key|密码|密钥|令牌)\s*[:=：]\s*\S+)/i.test(value);
}
/** 有限文本验证，保留缺失与空值的区别。 */
function bounded(value, max, label) {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new MemoryError(label+'无效');
  return value.trim();
}
/** 模型候选严格按数据字段接收，不接受权限、文件路径或身份字段。 */
function candidate(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['topic','text','classification'].includes(key)))throw new MemoryError('记忆候选含未允许字段');
  const result={topic:bounded(value.topic,100,'主题'),text:bounded(value.text,600,'记忆'),classification:value.classification??'EXTRACTED'};
  if(!['EXTRACTED','INFERRED','AMBIGUOUS'].includes(result.classification))throw new MemoryError('证据分类无效');
  if(containsSecret(result.topic+'\n'+result.text))throw new MemoryError('记忆含疑似敏感凭据');
  return result;
}
/** 中文双字词与其他词用于有限文本匹配，不执行输入提供的正则表达式。 */
function terms(query) {
  if(typeof query!=='string'||query.length>6000)throw new MemoryError('检索内容无效');
  const parts=query.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
  const result=[];
  for(const part of parts){
    result.push(part);
    if(/[\p{Script=Han}]/u.test(part))for(let i=0;i<part.length-1;i++)result.push(part.slice(i,i+2));
  }
  return [...new Set(result)].slice(0,40);
}

/** 宿主的来源权威存储。权限文件、凭据和工具注册从不进入这个模块。 */
export class MemoryStore {
  #db;
  #scopes=new WeakMap();
  #index;
  #growthEventAuthority;
  #jobs=new Map();
  constructor(filename,{index,characterIndex,now=Date.now,monotonic=()=>performance.now()}={}) {
    this.filename=path.resolve(filename);
    mkdirSync(path.dirname(this.filename),{recursive:true,mode:0o700});
    if(process.platform!=='win32')chmodSync(path.dirname(this.filename),0o700);
    this.#db=new DatabaseSync(this.filename);
    if(process.platform!=='win32')chmodSync(this.filename,0o600);
    this.#index=index;
    this.#db.exec([
      'PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=3000;',
      'CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY,principal TEXT NOT NULL,context TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,indexed_revision INTEGER NOT NULL DEFAULT -1,index_error TEXT);',
      'CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),subject TEXT NOT NULL,origin TEXT NOT NULL,excerpt TEXT NOT NULL,reference TEXT NOT NULL,created INTEGER NOT NULL);',
      'CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),source_id TEXT NOT NULL UNIQUE REFERENCES sources(id),kind TEXT NOT NULL,topic TEXT NOT NULL,classification TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(scope_id,kind,topic));',
      'CREATE TABLE IF NOT EXISTS tombstones(source_id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,revision INTEGER NOT NULL);',
      'CREATE TABLE IF NOT EXISTS recent(id INTEGER PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),role TEXT NOT NULL,content TEXT NOT NULL,created INTEGER NOT NULL);',
      // 增量来源旁表：不改写旧历史；旧消息未记录来源时保持 unknown。
      "CREATE TABLE IF NOT EXISTS recent_origins(recent_id INTEGER PRIMARY KEY REFERENCES recent(id) ON DELETE CASCADE,origin TEXT NOT NULL CHECK(origin IN ('user','external')));",
      'CREATE TABLE IF NOT EXISTS native_leases(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),agent_id TEXT,conversation_id TEXT,status TEXT NOT NULL,created INTEGER NOT NULL);'
    ].join('\n'));
    const resolvedCharacterIndex=characterIndex??new CharacterGraphIndex({directory:path.join(path.dirname(this.filename),'character-graphs')});
    this.growth=new CharacterStore(this.#db,{resolveScope:scope=>this.#authorize(scope),characterIndex:resolvedCharacterIndex,now});
    this.#growthEventAuthority=this.growth.externalSourceAuthority();
    this.content=new ContentStore(this.#db,{resolveScope:scope=>this.#authorize(scope),growth:this.growth,now});
    this.bilibili=new BilibiliAccountStore(this.#db,{content:this.content,now});
    this.qq=new QQStore(this.#db,{now,onForget:event=>this.#forgetQQEvent(event),onExpire:event=>this.#expireQQEvent(event),onReceive:event=>this.replyTimings?.received(event.id)});
    this.replyTimings=new QQReplyTimings(this.#db,{now,clock:monotonic});
    const qqOwner=this.qq.ownerAuthority();
    this.reply=new QQReplyStore(this.#db,{qq:this.qq,qqOwner,growth:this.growth,bindScope:identity=>this.bind(identity),resolveScope:scope=>this.#authorize(scope),memoryRevision:scope=>this.revision(scope),now});
    this.contact=new QQContactStore(this.#db,{qq:this.qq,reply:this.reply,now});
    this.proactive=new ProactiveStore(this.#db,{resolveScope:scope=>this.#authorize(scope),growth:this.growth,content:this.content,now});
  }
  /** 仅供应用宿主判断整个Agent能否释放恢复槽，不返回其他范围的内容或标识。 */
  pendingNativeLeaseCount(){return this.#db.prepare('SELECT count(*) AS count FROM native_leases').get().count;}
  /** 关闭数据库前须完成自己的派生索引任务。 */
  close() {if(this.#jobs.size)throw new MemoryError('索引任务仍在运行');this.#db.close();}
  /** 等待本实例已提交的索引任务，失败状态另由 status 展示。 */
  async drain() {await Promise.allSettled([...this.#jobs.values()]);}
  /** 从可信接入层的稳定身份创建不透明 capability；不接收模型的身份声明。 */
  bind({platform,subject,context}) {
    platform=bounded(platform,40,'平台');subject=bounded(subject,200,'稳定身份');context=bounded(context,240,'会话范围');
    const principal=JSON.stringify([platform,subject]);
    const id=createHash('sha256').update(JSON.stringify([principal,context])).digest('hex');
    const subjectKey=createHash('sha256').update(principal).digest('hex');
    this.#db.prepare('INSERT OR IGNORE INTO scopes(id,principal,context) VALUES (?,?,?)').run(id,principal,context);
    const scope=Object.freeze({id,subjectKey});
    this.#scopes.set(scope,{id,subjectKey,platform,subject,context});
    this.growth.registerScope(scope);
    return scope;
  }
  /** 只认可由本实例绑定的对象，复制 id 或 JSON 不能伪造 capability。 */
  #authorize(scope) {
    const known=this.#scopes.get(scope);
    if(!known)throw new MemoryError('缺少可信记忆范围');
    return known;
  }
  /** QQ缓存过期只清本地近期对话，不撤销已明确授权的长期事实或成长来源。 */
  #expireQQEvent(event) {
    const context=event.kind==='private'?'private':'group:'+event.groupId,scope=this.bind({platform:'qq',subject:event.selfId+':'+event.senderId,context}),known=this.#authorize(scope);
    this.#db.prepare('DELETE FROM recent WHERE scope_id=?').run(known.id);this.#advance(known.id);
  }
  /** QQ显式遗忘的同库事务钩子：撤销事件事实、成长来源与近期副本，不触碰其他scope。 */
  #forgetQQEvent(event) {
    const context=event.kind==='private'?'private':'group:'+event.groupId;
    const scope=this.bind({platform:'qq',subject:event.selfId+':'+event.senderId,context}),known=this.#authorize(scope),reference='qq:event:'+event.id;
    const rows=this.#db.prepare('SELECT m.id,m.source_id AS sourceId FROM memories m JOIN sources s ON s.id=m.source_id WHERE m.scope_id=? AND s.reference=?').all(known.id,reference);
    for(const row of rows) {
      this.growth.invalidateMemory(known.id,row.id);
      this.#db.prepare('DELETE FROM memories WHERE id=?').run(row.id);
      this.#db.prepare('DELETE FROM sources WHERE id=?').run(row.sourceId);
    }
    this.growth.invalidateEventSource(this.#growthEventAuthority,known.id,'qq-reply:'+event.id);
    this.#db.prepare('DELETE FROM recent WHERE scope_id=?').run(known.id);
    this.#advance(known.id);
    const revision=this.revision(scope);
    for(const row of rows)this.#db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?,?,?)').run(row.sourceId,known.id,revision);
  }
  /** SQLite 短事务集中处理来源、版本和索引状态不变量。 */
  #transaction(operation) {
    this.#db.exec('BEGIN IMMEDIATE');
    try{const result=operation();this.#db.exec('COMMIT');return result;}
    catch(error){this.#db.exec('ROLLBACK');throw error;}
  }
  /** 返回当前范围的内容修订，不接受外部自报版本。 */
  revision(scope) {const {id}=this.#authorize(scope);return this.#db.prepare('SELECT revision FROM scopes WHERE id=?').get(id).revision;}
  /** 原始来源由宿主提供，模型候选仅能选取其中逐字存在的片段。 */
  #validateSource(source,item) {
    if(!source||!['user','external'].includes(source.origin))throw new MemoryError('来源类型无效');
    const original=bounded(source.text,12000,'来源');
    if(!original.includes(item.text))throw new MemoryError('记忆内容不在来源中');
    const reference=source.reference===undefined?'local:conversation':bounded(source.reference,1000,'来源标识');
    if(containsSecret(reference))throw new MemoryError('来源标识含疑似敏感凭据');
    return {origin:source.origin,reference,excerpt:item.text};
  }
  /** 新增/替换来源，外部知识与个人陈述分开，不能覆盖用户纠正。 */
  #replace(known,item,source,existing) {
    const kind=existing?.kind??(source.origin==='external'?'knowledge':'personal');
    const old=existing??this.#db.prepare('SELECT m.*,s.origin FROM memories m JOIN sources s ON s.id=m.source_id WHERE m.scope_id=? AND m.kind=? AND m.topic=?').get(known.id,kind,item.topic);
    if(old&&source.origin==='external'&&old.origin==='user')throw new MemoryError('外部内容不能覆盖用户来源');
    // updated 同时是成长授权的事实版本；同毫秒替换也必须严格单调。
    const id=old?.id??randomUUID(),sourceId=randomUUID(),now=old?Math.max(Date.now(),old.updated+1):Date.now();
    if(old){
      this.growth.invalidateMemory(known.id,old.id);
      this.#db.prepare('DELETE FROM memories WHERE id=?').run(old.id);
      this.#db.prepare('DELETE FROM sources WHERE id=?').run(old.source_id);
      this.#db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?,?,?)').run(old.source_id,known.id,this.#db.prepare('SELECT revision+1 AS next FROM scopes WHERE id=?').get(known.id).next);
      this.#db.prepare('DELETE FROM recent WHERE scope_id=?').run(known.id);
    }
    this.#db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?)').run(sourceId,known.id,known.subjectKey,source.origin,source.excerpt,source.reference,now);
    this.#db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?)').run(id,known.id,sourceId,kind,item.topic,item.classification,old?.created??now,now);
    return id;
  }
  /** 版本变化使所有旧索引和在途结果失效。 */
  #advance(id) {this.#db.prepare('UPDATE scopes SET revision=revision+1 WHERE id=?').run(id);}
  /** 派生数据错误不改变已提交来源操作的成功语义。 */
  #changed(scope) {
    if(!this.#index)return;
    try{this.#index.prune(scope.id,this.list(scope).map(row=>row.sourceId));}
    catch{this.#db.prepare('UPDATE scopes SET indexed_revision=-1,index_error=? WHERE id=?').run('派生索引清理失败，已禁止使用',scope.id);}
  }
  /** 宿主明确要求保存自己的片段；不从消息中提取授权。 */
  remember(scope,input,source) {
    const known=this.#authorize(scope),item=candidate(input),evidence=this.#validateSource(source,item);
    const id=this.#transaction(()=>{const value=this.#replace(known,item,evidence);this.#advance(known.id);return value;});
    this.#changed(scope);return this.list(scope).find(row=>row.id===id);
  }
  /** 候选预览与实际提交共享验证规则，实际提交仍在事务中核验版本。 */
  #learningItems(inputs,source) {
    if(source?.allowLearning!==true)throw new MemoryError('本次来源未允许学习');
    if(!Array.isArray(inputs)||inputs.length>3)throw new MemoryError('学习候选数量无效');
    return inputs.map(input=>{const item=candidate(input);return {item,evidence:this.#validateSource(source,item)};});
  }
  /** 将已验证候选仅覆盖到本轮内存上下文，不写数据库或 Graphify。 */
  previewLearning(scope,expectedRevision,inputs,source,query) {
    this.#authorize(scope);
    if(this.revision(scope)!==expectedRevision)throw new MemoryError('记忆已变化，旧学习结果已拒绝');
    const validated=this.#learningItems(inputs,source);
    const pending=[...new Map(validated.map(({item,evidence},i)=>[item.topic,{id:'pending-'+i,...item,origin:evidence.origin,sourceRef:evidence.reference}])).values()];
    const existing=this.list(scope);
    const kind=source.origin==='external'?'knowledge':'personal';
    const replaced=validated.map(({item})=>existing.find(row=>row.kind===kind&&row.topic===item.topic)).filter(Boolean);
    if(source.origin==='external'&&replaced.some(row=>row.origin==='user'))throw new MemoryError('外部内容不能覆盖用户来源');
    const personalTopics=new Set(existing.filter(row=>row.origin==='user').map(row=>row.topic));
    const visible=pending.filter(row=>row.origin==='user'||!personalTopics.has(row.topic));
    const base=this.context(scope,query).filter(row=>!visible.some(next=>next.topic===row.topic&&(next.origin==='user'||row.origin==='external')));
    const context=[];let length=0;
    for(const row of [...visible,...base]) {
      const size=JSON.stringify(row).length;
      if(context.length>=8||length+size>4500)break;
      context.push(row);length+=size;
    }
    return {candidates:validated.map(row=>row.item),context,hasCandidates:validated.length>0,clearsHistory:replaced.length>0};
  }
  /** 在完成点一次提交学习与历史；之前的候选始终只存在于当前进程内存。 */
  completeTurn(scope,expectedRevision,user,assistant,inputs=[],source,growth={learn:false,grow:false,eventKey:'legacy:'+randomUUID(),growthRevision:this.growth.turnPolicy().growthRevision}) {
    const known=this.#authorize(scope);
    user=bounded(user,6000,'消息');assistant=bounded(assistant,12000,'回复');
    if(containsSecret(user+'\n'+assistant))throw new MemoryError('对话含疑似敏感凭据');
    const validated=inputs.length?this.#learningItems(inputs,source):[];
    const origin=source===undefined?'user':source?.origin;
    if(!['user','external'].includes(origin))throw new MemoryError('来源类型无效');
    const committed=this.#transaction(()=>{
      if(this.revision(scope)!==expectedRevision)throw new MemoryError('记忆已变化，本轮旧上下文已丢弃');
      const ids=validated.map(({item,evidence})=>this.#replace(known,item,evidence));
      if(ids.length)this.#advance(known.id);
      this.#writeExchange(known.id,user,assistant,origin);
      const growthResult=this.growth.acceptTurn(scope,{text:user,origin,learn:growth.learn,grow:growth.grow,eventKey:growth.eventKey,growthRevision:growth.growthRevision});
      return {learned:new Set(ids).size,growth:growthResult,revision:this.revision(scope)};
    });
    if(committed.learned)this.#changed(scope);
    return committed;
  }
  /** 学习结果在同一事务核验来源、归属与版本，最多接收三个候选。 */
  learn(scope,expectedRevision,inputs,source) {
    const known=this.#authorize(scope);
    const validated=this.#learningItems(inputs,source);
    const ids=this.#transaction(()=>{
      if(this.revision(scope)!==expectedRevision)throw new MemoryError('记忆已变化，旧学习结果已拒绝');
      const result=validated.map(({item,evidence})=>this.#replace(known,item,evidence));
      if(result.length)this.#advance(known.id);
      return result;
    });
    if(ids.length)this.#changed(scope);
    return this.list(scope).filter(row=>ids.includes(row.id));
  }
  /** 纠正自己的记录；其他 scope 的 ID 一律视为不可访问。 */
  correct(scope,id,content,source) {
    const known=this.#authorize(scope);
    this.#transaction(()=>{
      const old=this.#db.prepare('SELECT m.*,s.origin FROM memories m JOIN sources s ON s.id=m.source_id WHERE m.id=? AND m.scope_id=?').get(id,known.id);
      if(!old)throw new MemoryError('记忆不存在或无权访问');
      if(source?.origin==='external')throw new MemoryError('外部内容不能主动纠正个人来源');
      const item=candidate({topic:old.topic,text:content,classification:'EXTRACTED'}),evidence=this.#validateSource(source,item);
      this.#replace(known,item,evidence,old);this.#advance(known.id);
    });
    this.#changed(scope);return this.list(scope).find(row=>row.id===id);
  }
  /** 遗忘原始片段和近期副本，仅保留无正文 tombstone 阻止旧结果发布。 */
  forget(scope,id) {
    const known=this.#authorize(scope);
    this.#transaction(()=>{
      const old=this.#db.prepare('SELECT source_id FROM memories WHERE id=? AND scope_id=?').get(id,known.id);
      if(!old)throw new MemoryError('记忆不存在或无权访问');
      this.growth.invalidateMemory(known.id,id);
      this.#db.prepare('DELETE FROM memories WHERE id=?').run(id);
      this.#db.prepare('DELETE FROM sources WHERE id=?').run(old.source_id);
      this.#db.prepare('DELETE FROM recent WHERE scope_id=?').run(known.id);
      this.#advance(known.id);
      this.#db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?,?,?)').run(old.source_id,known.id,this.revision(scope));
    });
    this.#changed(scope);
  }
  /** 仅列出 capability 所属来源，不暴露跨联系人查询或裸 SQL。 */
  list(scope) {
    const {id}=this.#authorize(scope);
    return this.#db.prepare('SELECT m.id,m.source_id AS sourceId,s.subject AS subjectKey,m.kind,m.topic,s.excerpt AS text,s.excerpt AS evidence,s.origin,s.reference AS sourceRef,m.classification,m.created AS createdAt,m.updated AS updatedAt FROM memories m JOIN sources s ON s.id=m.source_id WHERE m.scope_id=? ORDER BY m.updated DESC,m.rowid DESC').all(id);
  }
  /** 按有限词项排序来源；即使索引尚未更新，新记忆也立即可检索。 */
  search(scope,query,{limit=8}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>30)throw new MemoryError('检索预算无效');
    const parts=terms(query),rows=this.list(scope);
    const revision=this.revision(scope);
    let linked=[];
    if(this.#index&&this.status(scope).indexedRevision===revision){
      try{
        if(this.#index.indexStatus(scope.id).error)throw new MemoryError('索引不可用');
        linked=this.#index.search(scope.id,revision,rows,query,{limit,maxDepth:2});
      }
      catch{this.#db.prepare('UPDATE scopes SET indexed_revision=-1,index_error=? WHERE id=?').run('派生索引读取失败，使用原始来源',scope.id);}
    }
    return rows.map(row=>({row,score:(linked.includes(row.sourceId)?3:0)+parts.reduce((score,term)=>score+((row.topic+' '+row.text).toLowerCase().includes(term)?1:0),0)}))
      .filter(item=>!parts.length||item.score>0).sort((a,b)=>b.score-a.score||b.row.updatedAt-a.row.updatedAt).slice(0,limit).map(item=>item.row);
  }
  /** 检索后截取有限上下文；不把来源当作系统指令或授权。 */
  context(scope,query) {
    const matches=this.search(scope,query);
    const all=this.list(scope),personalTopics=new Set(all.filter(row=>row.origin==='user').map(row=>row.topic));
    const candidates=matches.length?[...matches,...all.filter(row=>row.origin==='user'&&matches.some(match=>match.topic===row.topic))]:all;
    const selected=[...new Map(candidates.filter(row=>row.origin==='user'||!personalTopics.has(row.topic)).map(row=>[row.id,row])).values()]
      .sort((a,b)=>Number(b.origin==='user')-Number(a.origin==='user')).slice(0,8);
    const result=[];let size=0;
    for(const item of selected){const row={id:item.id,topic:item.topic,text:item.text,origin:item.origin,classification:item.classification,sourceRef:item.sourceRef};const length=JSON.stringify(row).length;if(size+length>4500)break;result.push(row);size+=length;}
    return result;
  }
  /** 合并近 7 天普通历史与有效主动消息，总上下文仍限制为最近 12 条。 */
  history(scope,{includeMetadata=false}={}) {
    const known=this.#authorize(scope),{id}=known;if(typeof includeMetadata!=='boolean')throw new MemoryError('历史元数据选项无效');
    const since=Date.now()-7*86400000;this.#db.prepare('DELETE FROM recent WHERE created<?').run(since);
    const recent=this.#db.prepare('SELECT r.id,r.role,r.content,r.created,o.origin FROM recent r LEFT JOIN recent_origins o ON o.recent_id=r.id WHERE r.scope_id=? ORDER BY r.id').all(id)
      .map(row=>({createdAt:row.created,order:'recent:'+String(row.id).padStart(20,'0'),value:row.role==='assistant'?{role:row.role,content:row.content}:{role:row.role,content:row.content,origin:row.origin??'unknown'}}));
    const proactive=known.platform==='local'&&known.subject==='owner'&&known.context==='private'?this.proactive.history(scope,{since}).map(row=>({createdAt:row.createdAt,order:'proactive:'+row.id,value:includeMetadata?{role:'assistant',content:row.text,proactiveId:row.id}:{role:'assistant',content:row.text}})):[];
    return [...recent,...proactive].sort((a,b)=>a.createdAt-b.createdAt||a.order.localeCompare(b.order)).slice(-12).map(row=>row.value);
  }
  /** 调用方须持有写事务，统一限制近期历史数量。 */
  #writeExchange(id,user,assistant,origin) {
    const insert=this.#db.prepare('INSERT INTO recent(scope_id,role,content,created) VALUES (?,?,?,?)');
    const created=insert.run(id,'user',user,Date.now());
    this.#db.prepare('INSERT INTO recent_origins(recent_id,origin) VALUES (?,?)').run(created.lastInsertRowid,origin);
    insert.run(id,'assistant',assistant,Date.now());
    this.#db.prepare('DELETE FROM recent WHERE scope_id=? AND id NOT IN (SELECT id FROM recent WHERE scope_id=? ORDER BY id DESC LIMIT 12)').run(id,id);
  }
  /** 回复与当前版本一致才进入后续上下文，避免遗忘期间的旧回复复活。 */
  appendExchange(scope,expectedRevision,user,assistant,origin='user') {
    if(!['user','external'].includes(origin))throw new MemoryError('来源类型无效');
    const {id}=this.#authorize(scope);
    user=bounded(user,6000,'消息');assistant=bounded(assistant,12000,'回复');
    if(containsSecret(user+'\n'+assistant))throw new MemoryError('对话含疑似敏感凭据');
    this.#transaction(()=>{
      if(this.revision(scope)!==expectedRevision)throw new MemoryError('记忆已变化，本轮旧上下文已丢弃');
      this.#writeExchange(id,user,assistant,origin);
    });
  }
  /** QQ事实或遗忘提交后刷新自己的事实与角色派生索引；不接受local/其他平台scope。 */
  async refreshQQScope(scope) {
    const known=this.#authorize(scope);if(known.platform!=='qq')throw new MemoryError('只允许刷新QQ联系人范围');
    this.#changed(scope);const memory=await this.sync(scope),character=this.growth.sync(scope);return {memory,character};
  }
  /** 以当前原始来源批量构图；仅在短事务内确认版本后发布。 */
  sync(scope) {
    this.#authorize(scope);
    if(!this.#index)return Promise.resolve({status:'unavailable'});
    if(this.#jobs.has(scope.id))return this.#jobs.get(scope.id);
    const status=this.status(scope),indexStatus=status.index;
    if(!status.dirty&&!indexStatus.error&&indexStatus.revision===status.revision)return Promise.resolve({status:'ready',revision:status.revision});
    const snapshot={revision:this.revision(scope),records:this.list(scope)};
    let artifact;
    const job=(async()=>{
      let outcome;
      try{
        artifact=await this.#index.build(scope.id,snapshot.revision,snapshot.records);
        outcome=this.#transaction(()=>{
          if(this.revision(scope)!==snapshot.revision)return {status:'stale'};
          this.#index.publish(artifact);
          this.#db.prepare('UPDATE scopes SET indexed_revision=?,index_error=NULL WHERE id=?').run(snapshot.revision,scope.id);
          return {status:'ready',revision:snapshot.revision};
        });
      }catch{
        this.#db.prepare('UPDATE scopes SET indexed_revision=-1,index_error=? WHERE id=?').run('Graphify 更新失败，原始来源仍可用',scope.id);
        outcome={status:'error'};
      } finally {
        try {if(artifact)this.#index.discard(artifact);}
        catch {
          this.#db.prepare('UPDATE scopes SET indexed_revision=-1,index_error=? WHERE id=?').run('Graphify 暂存清理未完成，需检查派生目录',scope.id);
          outcome={status:'cleanup-pending'};
        } finally {this.#jobs.delete(scope.id);}
      }
      return outcome;
    })();
    this.#jobs.set(scope.id,job);
    return job;
  }
  /** 返回索引修订和错误状态，不暴露私人内容。 */
  status(scope) {
    const {id}=this.#authorize(scope);
    const row=this.#db.prepare('SELECT revision,indexed_revision AS indexedRevision,index_error AS indexError FROM scopes WHERE id=?').get(id);
    let index=null;
    if(this.#index) {
      try{index=this.#index.indexStatus(id);}
      catch{index={version:1,error:'unavailable'};}
    }
    return {...row,index,dirty:row.revision!==row.indexedRevision||Boolean(index&&(index.error||index.revision!==row.revision))};
  }
  /** 登记由宿主创建的临时原生 Agent，记录中不保存对话正文。 */
  beginNativeLease(scope) {
    this.#authorize(scope);const id=randomUUID();
    return this.#transaction(()=>{
      if(this.#db.prepare('SELECT id FROM native_leases WHERE scope_id=? LIMIT 1').get(scope.id))throw new MemoryError('有待清理或运行中的原生会话');
      this.#db.prepare('INSERT INTO native_leases VALUES (?,?,NULL,NULL,?,?)').run(id,scope.id,'creating',Date.now());
      return id;
    });
  }
  /** 只有宿主可绑定创建返回的实际 ID；模型候选不经过此入口。 */
  bindNativeLease(scope,leaseId,runtime) {
    this.#authorize(scope);
    if(typeof runtime?.agent_id!=='string'||typeof runtime.conversation_id!=='string')throw new MemoryError('原生会话标识无效');
    const result=this.#db.prepare('UPDATE native_leases SET agent_id=?,conversation_id=?,status=? WHERE id=? AND scope_id=?').run(runtime.agent_id,runtime.conversation_id,'active',leaseId,scope.id);
    if(!result.changes)throw new MemoryError('临时会话租约不存在');
  }
  /** 原生删除确认后先持久化阶段，重启时只重试本地副本清理。 */
  markNativeDeleted(scope,leaseId) {
    this.#authorize(scope);
    const result=this.#db.prepare('UPDATE native_leases SET status=? WHERE id=? AND scope_id=?').run('remote_deleted',leaseId,scope.id);
    if(!result.changes)throw new MemoryError('临时会话租约不存在');
  }
  /** 常驻执行已终止的确认，与持久线程删除分别记录。 */
  markNativeReleased(scope,leaseId){this.#authorize(scope);const result=this.#db.prepare("UPDATE native_leases SET status='released' WHERE id=? AND scope_id=?").run(leaseId,scope.id);if(!result.changes)throw new MemoryError('执行租约不存在');}
  /** 成功清理后移除租约；失败留作显式恢复，不假装删除完成。 */
  finishNativeLease(scope,leaseId) {this.#authorize(scope);this.#db.prepare('DELETE FROM native_leases WHERE id=? AND scope_id=?').run(leaseId,scope.id);}
  /** 仅允许管理当前范围自己创建的临时运行时。 */
  nativeLeases(scope) {this.#authorize(scope);return this.#db.prepare('SELECT id,agent_id AS agentId,conversation_id AS conversationId,status FROM native_leases WHERE scope_id=? ORDER BY created').all(scope.id);}
}

