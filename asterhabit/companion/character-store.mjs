import {DAILY_BUDGET} from './daily-budget.mjs';
import {createHash,randomUUID} from 'node:crypto';

/** 角色成长合同错误；消息不包含来源正文。 */
export class CharacterError extends Error {
  constructor(message){super(message);this.name='CharacterError';}
}
const KINDS=new Set(['interest','preference','opinion','question']);
const STATES=new Set(['tentative','established','retired']);
const QUESTION_STATES=new Set(['open','resolved','dismissed']);
const REQUEUE_REASONS=new Set(['growth_disabled','expired','interrupted','network_failed','paused','shutdown','preempted','crashed']);
function containsSecret(value){return /(?:sk-[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{12,}\.|(?:password|passwd|cookie|authorization|access[_ -]?token|api[_ -]?key|密码|密钥|令牌)\s*[:=：]\s*\S+)/i.test(value);}
function object(value,keys,label) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new CharacterError(label+'字段无效');
  return value;
}
function text(value,max,label) {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new CharacterError(label+'无效');
  return value.trim();
}
function integer(value,min,max,label) {
  if(!Number.isInteger(value)||value<min||value>max)throw new CharacterError(label+'无效');
  return value;
}

/** 与 MemoryStore 共用连接的角色状态权威存储；不接收路径、SQL 或权限配置。 */
export class CharacterStore {
  #db;#resolveScope;#owners=new WeakSet();#externalAuthorities=new WeakSet();#knownScopes=new Map();#plans=new WeakMap();#now;#index;#indexErrors=new Map();
  constructor(db,{resolveScope,now=Date.now,characterIndex}={}) {
    if(!db||typeof resolveScope!=='function'||typeof now!=='function')throw new TypeError('角色存储依赖无效');
    this.#db=db;this.#resolveScope=resolveScope;this.#now=now;this.#index=characterIndex;
    db.exec([
      "CREATE TABLE IF NOT EXISTS growth_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,enabled INTEGER NOT NULL,daily_limit INTEGER NOT NULL,min_gap_seconds INTEGER NOT NULL,idle_seconds INTEGER NOT NULL);",
      "INSERT OR IGNORE INTO growth_settings VALUES(1,0,0,2,1800,300);",
      "CREATE TABLE IF NOT EXISTS growth_scopes(scope_id TEXT PRIMARY KEY REFERENCES scopes(id),revision INTEGER NOT NULL DEFAULT 0);",
      "CREATE TABLE IF NOT EXISTS growth_sources(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),origin TEXT NOT NULL,excerpt TEXT NOT NULL,memory_id TEXT,memory_revision INTEGER,created INTEGER NOT NULL,status TEXT NOT NULL,event_key TEXT UNIQUE);",
      "CREATE UNIQUE INDEX IF NOT EXISTS growth_source_memory_version ON growth_sources(scope_id,memory_id,memory_revision) WHERE memory_id IS NOT NULL;",
      "CREATE TABLE IF NOT EXISTS growth_events(id INTEGER PRIMARY KEY,source_id TEXT NOT NULL REFERENCES growth_sources(id),scope_id TEXT NOT NULL REFERENCES scopes(id),created INTEGER NOT NULL,status TEXT NOT NULL,run_id TEXT,reason TEXT);",
      "CREATE TABLE IF NOT EXISTS character_states(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),kind TEXT NOT NULL,topic TEXT NOT NULL,statement TEXT NOT NULL,brief_reason TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS character_state_sources(state_id TEXT NOT NULL REFERENCES character_states(id),source_id TEXT NOT NULL REFERENCES growth_sources(id),PRIMARY KEY(state_id,source_id));",
      "CREATE TABLE IF NOT EXISTS character_state_dependencies(state_id TEXT NOT NULL REFERENCES character_states(id),source_id TEXT NOT NULL REFERENCES growth_sources(id),PRIMARY KEY(state_id,source_id));",
      "CREATE TABLE IF NOT EXISTS character_state_links(state_id TEXT NOT NULL REFERENCES character_states(id),depends_on_state_id TEXT NOT NULL REFERENCES character_states(id),PRIMARY KEY(state_id,depends_on_state_id));",
      "CREATE TABLE IF NOT EXISTS character_tombstones(scope_id TEXT NOT NULL REFERENCES scopes(id),kind TEXT NOT NULL,topic TEXT NOT NULL,dependency_key TEXT NOT NULL,dismissed INTEGER NOT NULL,PRIMARY KEY(scope_id,kind,topic,dependency_key));",
      "CREATE TABLE IF NOT EXISTS reflection_runs(run_id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),status TEXT NOT NULL,created INTEGER NOT NULL,finished INTEGER,reason TEXT,policy_revision INTEGER NOT NULL,scope_revision INTEGER NOT NULL);"
    ].join('\n'));
    if(!db.prepare('PRAGMA table_info(growth_scopes)').all().some(column=>column.name==='character_revision'))db.exec('ALTER TABLE growth_scopes ADD COLUMN character_revision INTEGER NOT NULL DEFAULT 0');
    db.exec('INSERT OR IGNORE INTO character_state_dependencies SELECT state_id,source_id FROM character_state_sources');
  }
  /** 为可信宿主创建不可序列化 owner capability。 */
  ownerAuthority(){const owner=Object.freeze(Object.create(null));this.#owners.add(owner);return owner;}
  #owner(owner){if(!this.#owners.has(owner))throw new CharacterError('缺少角色成长主人权限');}
  /** 为同库可信存储签发不可序列化权限，仅允许在调用方已有事务中失效 external 来源。 */
  externalSourceAuthority(){const authority=Object.freeze(Object.create(null));this.#externalAuthorities.add(authority);return authority;}
  #scope(scope) {
    const known=this.#resolveScope(scope);
    this.#knownScopes.set(known.id,scope);
    this.#db.prepare('INSERT OR IGNORE INTO growth_scopes(scope_id) VALUES (?)').run(known.id);
    return known;
  }
  /** MemoryStore.bind 调用此方法，使调度器只遍历宿主已绑定的联系人。 */
  registerScope(scope){this.#scope(scope);}
  #tx(operation){this.#db.exec('BEGIN IMMEDIATE');try{const result=operation();this.#db.exec('COMMIT');return result;}catch(error){this.#db.exec('ROLLBACK');throw error;}}
  #settings(){return this.#db.prepare('SELECT revision AS growthRevision,enabled,daily_limit AS dailyCallLimit,min_gap_seconds AS minGapSeconds,idle_seconds AS idleSeconds FROM growth_settings WHERE id=1').get();}
  /** 返回主人可配置策略。 */
  settings(owner){this.#owner(owner);const row=this.#settings();return {...row,enabled:Boolean(row.enabled)};}
  /** 当前回合只读策略快照，不授予修改能力。 */
  turnPolicy(){const row=this.#settings();return {growthRevision:row.growthRevision,enabled:Boolean(row.enabled)};}
  /** 使用成长策略自己的修订执行完整配置 CAS。 */
  configure(owner,input) {
    this.#owner(owner);object(input,['expectedRevision','enabled','dailyCallLimit','minGapSeconds','idleSeconds'],'成长配置');
    integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER,'成长修订');
    if(typeof input.enabled!=='boolean')throw new CharacterError('成长开关无效');
    integer(input.dailyCallLimit,0,DAILY_BUDGET.modelCallMaximum,'反思次数');integer(input.minGapSeconds,1800,86400,'反思间隔');integer(input.idleSeconds,300,3600,'空闲时长');
    return this.#tx(()=>{
      const current=this.#settings();
      if(current.growthRevision!==input.expectedRevision)throw new CharacterError('成长配置已变化');
      this.#db.prepare('UPDATE growth_settings SET revision=revision+1,enabled=?,daily_limit=?,min_gap_seconds=?,idle_seconds=? WHERE id=1').run(Number(input.enabled),input.dailyCallLimit,input.minGapSeconds,input.idleSeconds);
      if(!input.enabled)this.#db.prepare("UPDATE growth_events SET status='cancelled',reason='growth_disabled' WHERE status='queued'").run();
      return this.settings(owner);
    });
  }
  #scopeRevision(id){return this.#db.prepare('SELECT revision FROM growth_scopes WHERE scope_id=?').get(id).revision;}
  #characterRevision(id){return this.#db.prepare('SELECT character_revision AS revision FROM growth_scopes WHERE scope_id=?').get(id).revision;}
  #advance(id){this.#db.prepare('UPDATE growth_scopes SET revision=revision+1 WHERE scope_id=?').run(id);}
  #advanceCharacter(id,{clearRecent=false}={}){this.#db.prepare('UPDATE growth_scopes SET revision=revision+1,character_revision=character_revision+1 WHERE scope_id=?').run(id);this.#db.prepare('UPDATE scopes SET revision=revision+1 WHERE id=?').run(id);if(clearRecent)this.#db.prepare('DELETE FROM recent WHERE scope_id=?').run(id);}
  #invalidateDialogue(id){this.#db.prepare('UPDATE scopes SET revision=revision+1 WHERE id=?').run(id);this.#db.prepare('DELETE FROM recent WHERE scope_id=?').run(id);}
  #cursor(scopeId,cursor) {
    if(cursor===undefined)return 0;
    try{const [bound,offset]=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(bound!==scopeId||!Number.isInteger(offset)||offset<0)throw new Error();return offset;}
    catch{throw new CharacterError('分页游标无效');}
  }
  #page(scopeId,rows,offset,limit){return {rows:rows.slice(offset,offset+limit),nextCursor:offset+limit<rows.length?Buffer.from(JSON.stringify([scopeId,offset+limit])).toString('base64url'):null};}
  #sourceRows(scopeId) {
    return this.#db.prepare(`SELECT s.id,s.origin,s.excerpt,s.memory_id AS memoryId,s.memory_revision AS memoryRevision,s.created AS createdAt,
      CASE WHEN s.status='invalidated' THEN 'invalidated' ELSE COALESCE((SELECT e.status FROM growth_events e WHERE e.source_id=s.id ORDER BY e.id DESC LIMIT 1),'cancelled') END AS queueStatus,
      (SELECT e.reason FROM growth_events e WHERE e.source_id=s.id ORDER BY e.id DESC LIMIT 1) AS queueReason
      FROM growth_sources s WHERE s.scope_id=? ORDER BY s.created DESC,s.rowid DESC`).all(scopeId)
      .map(row=>({id:row.id,origin:row.origin,excerpt:row.excerpt,status:row.queueStatus,requeueable:row.queueStatus==='cancelled'&&REQUEUE_REASONS.has(row.queueReason),createdAt:row.createdAt,memoryId:row.memoryId??null,memoryRevision:row.memoryRevision??null}));
  }
  /** 只列出当前 capability 范围；游标绑定 scope。 */
  sources(scope,{cursor,limit=20}={}) {
    const {id}=this.#scope(scope);integer(limit,1,50,'分页数量');const offset=this.#cursor(id,cursor),page=this.#page(id,this.#sourceRows(id),offset,limit);
    return {scopeRevision:this.#scopeRevision(id),entries:page.rows,nextCursor:page.nextCursor};
  }
  #insertSource(scopeId,{origin,excerpt,memoryId=null,memoryRevision=null,eventKey=null}) {
    const active=this.#db.prepare("SELECT count(*) AS n FROM growth_sources WHERE scope_id=? AND status='active'").get(scopeId).n;
    if(active>=500)return {saved:false,reason:'capacity'};
    const id=randomUUID(),created=this.#now();
    this.#db.prepare('INSERT INTO growth_sources VALUES (?,?,?,?,?,?,?,?,?)').run(id,scopeId,origin,excerpt,memoryId,memoryRevision,created,'active',eventKey);
    this.#db.prepare("INSERT INTO growth_events(source_id,scope_id,created,status) VALUES (?,?,?,'queued')").run(id,scopeId,created);
    this.#advance(scopeId);return {saved:true,id};
  }
  /** completeTurn 的同事务入口；双开关或配置版本不匹配时不回填。 */
  acceptTurn(scope,input) {
    const {id}=this.#scope(scope);
    object(input,['text','origin','learn','grow','eventKey','growthRevision'],'成长回合');
    if(typeof input.learn!=='boolean'||typeof input.grow!=='boolean')throw new CharacterError('成长回合开关无效');
    if(!input.learn||!input.grow)return {saved:false,reason:'disabled_for_turn'};
    const policy=this.#settings();
    if(policy.growthRevision!==input.growthRevision)return {saved:false,reason:'configuration_changed'};
    if(!policy.enabled)return {saved:false,reason:'disabled'};
    if(!['user','external'].includes(input.origin))throw new CharacterError('成长来源类型无效');
    const excerpt=text(input.text,6000,'成长来源'),eventKey=text(input.eventKey,120,'成长事件键');
    const duplicate=this.#db.prepare('SELECT id FROM growth_sources WHERE event_key=?').get(eventKey);
    if(duplicate)return {saved:true,id:duplicate.id,duplicate:true};
    return this.#insertSource(id,{origin:input.origin,excerpt,eventKey});
  }
  /** 主人从当前 scope 的有效事实版本显式授权成长来源。 */
  authorize(scope,input) {
    const {id}=this.#scope(scope);object(input,['memoryIds','learn','expectedRevision'],'来源授权');
    if(input.learn!==true||!Array.isArray(input.memoryIds)||input.memoryIds.length<1||input.memoryIds.length>3||new Set(input.memoryIds).size!==input.memoryIds.length)throw new CharacterError('来源授权无效');
    integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER,'范围修订');
    return this.#tx(()=>{
      if(!this.#settings().enabled)throw new CharacterError('角色成长未开启');
      if(this.#scopeRevision(id)!==input.expectedRevision)throw new CharacterError('角色范围已变化');
      const entries=[];
      for(const memoryId of input.memoryIds) {
        text(memoryId,100,'记忆标识');
        const row=this.#db.prepare('SELECT m.id,m.updated,s.origin,s.excerpt FROM memories m JOIN sources s ON s.id=m.source_id WHERE m.id=? AND m.scope_id=?').get(memoryId,id);
        if(!row)throw new CharacterError('记忆不存在或无权访问');
        if(this.#db.prepare("SELECT id FROM growth_sources WHERE scope_id=? AND memory_id=? AND memory_revision=? AND status='active'").get(id,row.id,row.updated))throw new CharacterError('记忆版本已授权');
        const inserted=this.#insertSource(id,{origin:row.origin,excerpt:row.excerpt,memoryId:row.id,memoryRevision:row.updated});
        if(!inserted.saved)throw new CharacterError('成长资料已满');
        entries.push(inserted.id);
      }
      const all=this.#sourceRows(id);
      return {scopeRevision:this.#scopeRevision(id),authorized:entries.length,entries:all.filter(row=>entries.includes(row.id))};
    });
  }
  /** 返回当前 scope 中仍与事实当前版本一致的成长授权记忆 ID，供列表装饰使用。 */
  authorizedMemoryIds(scope,memoryIds) {
    const {id}=this.#scope(scope);
    if(!Array.isArray(memoryIds)||memoryIds.length>30)throw new CharacterError('授权记忆查询数量无效');
    const requested=[...new Set(memoryIds.map(memoryId=>text(memoryId,100,'记忆标识')))];
    if(!requested.length)return [];
    const placeholders=requested.map(()=>'?').join(',');
    const rows=this.#db.prepare(`SELECT DISTINCT g.memory_id AS id FROM growth_sources g JOIN memories m ON m.id=g.memory_id AND m.scope_id=g.scope_id AND m.updated=g.memory_revision
      WHERE g.scope_id=? AND g.status='active' AND g.memory_id IN (${placeholders})`).all(id,...requested);
    const found=new Set(rows.map(row=>row.id));
    return requested.filter(memoryId=>found.has(memoryId));
  }
  #stateRows(scopeId) {
    return this.#db.prepare('SELECT id,kind,topic,statement,brief_reason AS briefReason,status,revision,created AS createdAt,updated AS updatedAt FROM character_states WHERE scope_id=? ORDER BY updated DESC,rowid DESC').all(scopeId)
      .map(row=>({...row,sourceIds:this.#db.prepare('SELECT source_id AS id FROM character_state_sources WHERE state_id=? ORDER BY source_id').all(row.id).map(item=>item.id)}));
  }
  #dependencySourceIds(stateId) {
    return this.#db.prepare('SELECT source_id AS id FROM character_state_dependencies WHERE state_id=? ORDER BY source_id').all(stateId).map(row=>row.id);
  }
  #dependencyKey(sourceIds) {
    return createHash('sha256').update(JSON.stringify([...new Set(sourceIds)].sort())).digest('hex');
  }
  /** 从 SQLite 当前有效状态重建独立角色图；失败只禁用派生读取，不推翻权威提交。 */
  #project(scopeId) {
    if(!this.#index)return {status:'unavailable'};
    try {
      const valid=this.#db.prepare("SELECT id FROM growth_sources WHERE scope_id=? AND status='active'").all(scopeId).map(row=>row.id);
      const records=this.#stateRows(scopeId).map(row=>({...row,dependencySourceIds:this.#dependencySourceIds(row.id)}));
      const result=this.#index.publish(scopeId,this.#characterRevision(scopeId),records,valid);
      this.#indexErrors.delete(scopeId);return {status:'ready',...result};
    } catch {this.#indexErrors.set(scopeId,'角色图更新失败，已禁止使用旧投影');return {status:'error'};}
  }
  /** 显式同步当前 capability 的角色图；相同修订不会重复启动 worker。 */
  sync(scope) {
    const {id}=this.#scope(scope),revision=this.#characterRevision(id);
    if(!this.#index)return {status:'unavailable'};
    let status;try{status=this.#index.status(id);}catch{status={revision:-1,error:'unavailable'};}
    if(status.revision===revision&&!status.error)return {status:'ready',revision};
    if(status.revision<0&&!this.#stateRows(id).length)return {status:'ready',revision,empty:true};
    return this.#project(id);
  }
  /** 返回不含正文的角色图修订状态。 */
  indexStatus(scope){const {id}=this.#scope(scope),status=this.#index?.status(id)??{revision:-1,contract:null,error:'unavailable'};return {...status,error:this.#indexErrors.get(id)??status.error??null};}
  /** 分页读取当前 scope 的角色状态。 */
  states(scope,{kind,cursor,limit=20}={}) {
    const {id}=this.#scope(scope);integer(limit,1,50,'分页数量');if(kind!==undefined&&!KINDS.has(kind))throw new CharacterError('角色类型无效');
    const offset=this.#cursor(id,cursor),rows=this.#stateRows(id).filter(row=>kind===undefined||row.kind===kind),page=this.#page(id,rows,offset,limit);
    return {scopeRevision:this.#scopeRevision(id),entries:page.rows,nextCursor:page.nextCursor};
  }
  /** 按有限文本相关性返回聊天可见状态；可在共享预算前按角色类型筛选。 */
  context(scope,query,options={}) {
    object(options,['kinds'],'角色上下文选项');let selectedKinds=null;
    if(options.kinds!==undefined) {
      if(!Array.isArray(options.kinds)||options.kinds.length<1||options.kinds.length>KINDS.size||new Set(options.kinds).size!==options.kinds.length||options.kinds.some(kind=>!KINDS.has(kind)))throw new CharacterError('角色类型无效');
      selectedKinds=new Set(options.kinds);
    }
    const {id}=this.#scope(scope);if(typeof query!=='string'||query.length>6000)throw new CharacterError('角色检索内容无效');
    const terms=(query.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).slice(0,30);
    const rows=this.#stateRows(id).filter(row=>!['retired','dismissed'].includes(row.status)&&(!selectedKinds||selectedKinds.has(row.kind)));
    const ranked=rows.map(row=>({row,score:terms.reduce((n,term)=>n+Number((row.topic+' '+row.statement).toLowerCase().includes(term)),0)})).sort((a,b)=>b.score-a.score||b.row.updatedAt-a.row.updatedAt);
    const result=[];let size=0;
    for(const {row} of ranked){const item={id:row.id,kind:row.kind,topic:row.topic,statement:row.statement,briefReason:row.briefReason,status:row.status,revision:row.revision,sourceIds:row.sourceIds};const length=JSON.stringify(item).length;if(result.length>=6||size+length>4000)break;result.push(item);size+=length;}
    return result;
  }
  #expire(now){this.#db.prepare("UPDATE growth_events SET status='cancelled',reason='expired' WHERE status='queued' AND created<?").run(now-7*86400000);}
  /** 只回答当前 scope 是否可声明一次反思，不返回正文。 */
  due(scope,now=this.#now()) {
    const {id}=this.#scope(scope);this.#expire(now);const policy=this.#settings();
    if(!policy.enabled||policy.dailyCallLimit===0)return false;
    if(this.#db.prepare("SELECT 1 FROM reflection_runs WHERE status='claimed' LIMIT 1").get())return false;
    const used=this.#db.prepare('SELECT count(*) AS n FROM reflection_runs WHERE created>=?').get(now-86400000).n;
    if(used>=policy.dailyCallLimit)return false;
    const last=this.#db.prepare('SELECT max(created) AS value FROM reflection_runs').get().value;
    if(last!==null&&now-last<policy.minGapSeconds*1000)return false;
    return Boolean(this.#db.prepare("SELECT 1 FROM growth_events WHERE scope_id=? AND status='queued' LIMIT 1").get(id));
  }
  /** 返回本实例已经绑定且有排队事件的 scope capability。 */
  pendingScopes(){return [...this.#knownScopes.entries()].filter(([id])=>this.#db.prepare("SELECT 1 FROM growth_events WHERE scope_id=? AND status='queued' LIMIT 1").get(id)).map(([,scope])=>scope);}
  /** 在应用总额度预留之后声明 Agent 额度和有限输入。 */
  beginReflection(scope,runId) {
    const {id}=this.#scope(scope);runId=text(runId,120,'反思任务标识');const now=this.#now();
    return this.#tx(()=>{
      if(!this.due(scope,now))throw new CharacterError('当前没有可运行的反思');
      const policy=this.#settings(),scopeRevision=this.#scopeRevision(id);
      const rows=this.#db.prepare(`SELECT e.id AS eventId,s.id,s.origin,s.excerpt FROM growth_events e JOIN growth_sources s ON s.id=e.source_id
        WHERE e.scope_id=? AND e.status='queued' AND s.status='active' ORDER BY e.id`).all(id);
      const selected=[];let size=0;
      for(const row of rows){if(selected.length>=8||size+row.excerpt.length>12000)break;selected.push(row);size+=row.excerpt.length;}
      if(!selected.length)throw new CharacterError('当前没有可运行的反思');
      this.#db.prepare("INSERT INTO reflection_runs VALUES (?,?,'claimed',?,NULL,NULL,?,?)").run(runId,id,now,policy.growthRevision,scopeRevision);
      const claim=this.#db.prepare("UPDATE growth_events SET status='claimed',run_id=? WHERE id=? AND status='queued'");
      for(const row of selected)if(!claim.run(runId,row.eventId).changes)throw new CharacterError('反思来源已被声明');
      const states=Object.freeze(this.context(scope,selected.map(row=>row.excerpt).join('\n')));
      const allowedSourceIds=Object.freeze([...new Set([...selected.map(row=>row.id),...states.flatMap(state=>state.sourceIds)])]);
      const dependencySourceIds=Object.freeze([...new Set([...selected.map(row=>row.id),...states.flatMap(state=>this.#dependencySourceIds(state.id))])]);
      const plan=Object.freeze({runId,scopeId:id,policyRevision:policy.growthRevision,scopeRevision,sourceIds:Object.freeze(selected.map(row=>row.id)),allowedSourceIds,dependencySourceIds,sources:Object.freeze(selected.map(({id,origin,excerpt})=>Object.freeze({id,origin,excerpt}))),states});
      this.#plans.set(plan,{scopeId:id,runId});return plan;
    });
  }
  #plan(plan,scopeId) {const known=this.#plans.get(plan);if(!known||known.scopeId!==scopeId||known.runId!==plan.runId)throw new CharacterError('反思任务无效');return known;}
  /** 严格校验一次最多三项模型候选；整个批次失败，不做部分提交。 */
  validateCandidates(plan,inputs) {
    const known=this.#plans.get(plan);if(!known)throw new CharacterError('反思任务无效');
    if(!Array.isArray(inputs)||inputs.length>3)throw new CharacterError('角色候选数量无效');
    const allowed=new Set(plan.allowedSourceIds??plan.sourceIds);
    return inputs.map(value=>{
      object(value,['kind','topic','statement','briefReason','sourceIds','existingStateId','expectedRevision','status'],'角色候选');
      if(!KINDS.has(value.kind))throw new CharacterError('角色类型无效');
      const item={kind:value.kind,topic:text(value.topic,100,'角色主题'),statement:text(value.statement,600,'角色表述'),briefReason:text(value.briefReason,300,'简短理由')};
      if(containsSecret(item.topic+'\n'+item.statement+'\n'+item.briefReason))throw new CharacterError('角色候选含疑似敏感凭据');
      if(!Array.isArray(value.sourceIds)||value.sourceIds.length<1||value.sourceIds.length>8||new Set(value.sourceIds).size!==value.sourceIds.length||value.sourceIds.some(id=>!allowed.has(id)))throw new CharacterError('角色候选来源无效');
      item.sourceIds=[...value.sourceIds];item.status=value.status;
      const statuses=item.kind==='question'?QUESTION_STATES:STATES;
      if(!statuses.has(item.status))throw new CharacterError('角色状态无效');
      if(item.status==='established'&&item.sourceIds.length<2)throw new CharacterError('established 至少需要两个不同根来源');
      if(value.existingStateId!==undefined){item.existingStateId=text(value.existingStateId,100,'角色状态标识');integer(value.expectedRevision,0,Number.MAX_SAFE_INTEGER,'角色状态修订');item.expectedRevision=value.expectedRevision;}
      else if(value.expectedRevision!==undefined)throw new CharacterError('角色状态修订无效');
      return item;
    });
  }
  /** 在 guard 持有应用控制锁时调用；原子应用候选并消费事件。 */
  commitReflection(scope,plan,inputs) {
    const {id}=this.#scope(scope);this.#plan(plan,id);const candidates=this.validateCandidates(plan,inputs);
    const result=this.#tx(()=>{
      const run=this.#db.prepare("SELECT * FROM reflection_runs WHERE run_id=? AND scope_id=? AND status='claimed'").get(plan.runId,id);
      if(!run)throw new CharacterError('反思任务不再有效');
      const policy=this.#settings();
      if(!policy.enabled||policy.growthRevision!==plan.policyRevision||this.#scopeRevision(id)!==plan.scopeRevision)throw new CharacterError('角色状态已变化，旧反思已拒绝');
      const sources=this.#db.prepare(`SELECT s.id FROM growth_sources s JOIN growth_events e ON e.source_id=s.id WHERE e.run_id=? AND e.status='claimed' AND s.status='active'`).all(plan.runId).map(row=>row.id);
      if(sources.length!==plan.sourceIds.length||plan.sourceIds.some(sourceId=>!sources.includes(sourceId)))throw new CharacterError('反思来源已失效');
      for(const sourceId of new Set([...(plan.dependencySourceIds??plan.sourceIds),...candidates.flatMap(item=>item.sourceIds)]))if(!this.#db.prepare("SELECT 1 FROM growth_sources WHERE id=? AND scope_id=? AND status='active'").get(sourceId,id))throw new CharacterError('反思来源已失效');
      const dependencies=plan.dependencySourceIds??plan.sourceIds,dependencyKey=this.#dependencyKey(dependencies);
      const now=this.#now(),changed=[];
      for(const item of candidates) {
        let stateId=item.existingStateId;
        if(stateId) {
          if(!plan.states.some(state=>state.id===stateId))throw new CharacterError('目标角色状态不在本次读取白名单');
          const current=this.#db.prepare('SELECT * FROM character_states WHERE id=? AND scope_id=?').get(stateId,id);
          if(!current||['retired','dismissed'].includes(current.status)||current.revision!==item.expectedRevision||current.kind!==item.kind||current.topic!==item.topic)throw new CharacterError('目标角色状态已变化');
          if(this.#db.prepare('SELECT 1 FROM character_tombstones WHERE scope_id=? AND kind=? AND topic=? AND dependency_key=?').get(id,item.kind,item.topic,dependencyKey))throw new CharacterError('相同输入的角色状态已撤下');
          this.#db.prepare('UPDATE character_states SET statement=?,brief_reason=?,status=?,revision=revision+1,updated=? WHERE id=?').run(item.statement,item.briefReason,item.status,now,stateId);
          this.#db.prepare('DELETE FROM character_state_sources WHERE state_id=?').run(stateId);
          this.#db.prepare('DELETE FROM character_state_dependencies WHERE state_id=?').run(stateId);
          this.#db.prepare('DELETE FROM character_state_links WHERE state_id=?').run(stateId);
        } else {
          if(this.#db.prepare('SELECT 1 FROM character_tombstones WHERE scope_id=? AND kind=? AND topic=? AND dependency_key=?').get(id,item.kind,item.topic,dependencyKey))throw new CharacterError('相同输入的角色状态已撤下');
          if(this.#db.prepare("SELECT id FROM character_states WHERE scope_id=? AND kind=? AND topic=? AND status NOT IN ('retired','dismissed')").get(id,item.kind,item.topic))throw new CharacterError('角色主题已存在，须显式修订');
          stateId=randomUUID();this.#db.prepare('INSERT INTO character_states VALUES (?,?,?,?,?,?,?,?,?,?)').run(stateId,id,item.kind,item.topic,item.statement,item.briefReason,item.status,0,now,now);
        }
        for(const sourceId of item.sourceIds)this.#db.prepare('INSERT INTO character_state_sources VALUES (?,?)').run(stateId,sourceId);
        for(const sourceId of dependencies)this.#db.prepare('INSERT INTO character_state_dependencies VALUES (?,?)').run(stateId,sourceId);
        for(const prior of plan.states)if(prior.id!==stateId)this.#db.prepare('INSERT OR IGNORE INTO character_state_links VALUES (?,?)').run(stateId,prior.id);
        changed.push(stateId);
      }
      this.#db.prepare("UPDATE growth_events SET status='consumed',reason=? WHERE run_id=? AND status='claimed'").run(candidates.length?'committed':'no_change',plan.runId);
      this.#db.prepare("UPDATE reflection_runs SET status='committed',finished=?,reason=? WHERE run_id=?").run(now,candidates.length?'committed':'no_change',plan.runId);
      if(changed.length)this.#advanceCharacter(id);
      return {committed:changed.length,scopeRevision:this.#scopeRevision(id),stateIds:changed};
    });
    return result;
  }
  /** 拒答、取消或失败终结已声明任务；不自动重排。 */
  interruptReflection(scope,plan,reason='interrupted') {
    const {id}=this.#scope(scope);this.#plan(plan,id);reason=text(reason,40,'反思终止原因');
    return this.#tx(()=>{
      const run=this.#db.prepare("SELECT status FROM reflection_runs WHERE run_id=? AND scope_id=?").get(plan.runId,id);
      if(!run||run.status!=='claimed')return false;
      this.#db.prepare("UPDATE growth_events SET status='cancelled',reason=? WHERE run_id=? AND status='claimed'").run(reason,plan.runId);
      this.#db.prepare("UPDATE reflection_runs SET status='interrupted',finished=?,reason=? WHERE run_id=?").run(this.#now(),reason,plan.runId);
      return true;
    });
  }
  /** 原生 lease 已清理后，终结重启遗留的 claimed 任务而不重发模型调用。 */
  recoverInterrupted(scope,reason='crashed') {
    const {id}=this.#scope(scope);reason=text(reason,40,'反思终止原因');
    return this.#tx(()=>{
      const runs=this.#db.prepare("SELECT run_id AS runId FROM reflection_runs WHERE scope_id=? AND status='claimed'").all(id);
      for(const {runId} of runs) {
        this.#db.prepare("UPDATE growth_events SET status='cancelled',reason=? WHERE run_id=? AND status='claimed'").run(reason,runId);
        this.#db.prepare("UPDATE reflection_runs SET status='interrupted',finished=?,reason=? WHERE run_id=?").run(this.#now(),reason,runId);
      }
      return runs.length;
    });
  }
  #dependentStateIds(rootIds) {
    const result=new Set(rootIds),queue=[...rootIds];
    while(queue.length)for(const row of this.#db.prepare('SELECT state_id AS id FROM character_state_links WHERE depends_on_state_id=?').all(queue.shift()))if(!result.has(row.id)){result.add(row.id);queue.push(row.id);}
    return [...result];
  }
  #clearStates(scopeId,stateIds,{tombstone=false}={}) {
    const ids=this.#dependentStateIds(stateIds),cleared=[];
    for(const stateId of ids) {
      const state=this.#db.prepare('SELECT id,kind,topic,status FROM character_states WHERE id=? AND scope_id=?').get(stateId,scopeId);
      if(!state)continue;
      const dependencies=this.#dependencySourceIds(state.id),status=state.kind==='question'?'dismissed':'retired';
      if(tombstone)this.#db.prepare('INSERT OR IGNORE INTO character_tombstones VALUES (?,?,?,?,?)').run(scopeId,state.kind,state.topic,this.#dependencyKey(dependencies),this.#now());
      this.#db.prepare("UPDATE character_states SET statement='',brief_reason='',status=?,revision=revision+1,updated=? WHERE id=?").run(status,this.#now(),state.id);
      this.#db.prepare('DELETE FROM character_state_sources WHERE state_id=?').run(state.id);
      this.#db.prepare('DELETE FROM character_state_dependencies WHERE state_id=?').run(state.id);
      cleared.push(state.id);
    }
    for(const stateId of ids){this.#db.prepare('DELETE FROM character_state_links WHERE state_id=? OR depends_on_state_id=?').run(stateId,stateId);}
    return cleared;
  }
  #invalidate(scopeId,sourceIds) {
    if(!sourceIds.length)return [];
    const roots=new Set();
    for(const sourceId of sourceIds) {
      this.#db.prepare("UPDATE growth_sources SET status='invalidated',excerpt='' WHERE id=? AND scope_id=?").run(sourceId,scopeId);
      this.#db.prepare("UPDATE growth_events SET status='invalidated',reason='source_invalidated' WHERE source_id=? AND status IN ('queued','claimed','cancelled')").run(sourceId);
      for(const state of this.#db.prepare('SELECT DISTINCT cs.id FROM character_states cs JOIN character_state_dependencies x ON x.state_id=cs.id WHERE x.source_id=? AND cs.scope_id=?').all(sourceId,scopeId))roots.add(state.id);
    }
    const invalidated=this.#clearStates(scopeId,[...roots]);
    if(invalidated.length)this.#advanceCharacter(scopeId,{clearRecent:true});else this.#advance(scopeId);
    return invalidated;
  }
  /** MemoryStore 的同事务钩子：事实版本变化时撤销所有直接依赖。 */
  invalidateMemory(scopeId,memoryId) {
    const ids=this.#db.prepare("SELECT id FROM growth_sources WHERE scope_id=? AND memory_id=? AND status='active'").all(scopeId,memoryId).map(row=>row.id);
    return this.#invalidate(scopeId,ids);
  }
  /** 同库事务辅助：撤销指定 external 来源及全部派生状态，不开启嵌套事务。 */
  invalidateExternalSource(authority,scopeId,sourceId) {
    if(!this.#externalAuthorities.has(authority))throw new CharacterError('缺少外部来源失效权限');
    text(scopeId,100,'范围标识');text(sourceId,100,'来源标识');
    const source=this.#db.prepare("SELECT id FROM growth_sources WHERE id=? AND scope_id=? AND origin='external' AND status='active'").get(sourceId,scopeId);
    if(!source)return {invalidated:false,invalidatedStateIds:[]};
    const invalidatedStateIds=this.#invalidate(scopeId,[source.id]);
    if(!invalidatedStateIds.length)this.#invalidateDialogue(scopeId);
    return {invalidated:true,invalidatedStateIds};
  }
  /** 同库事务辅助：按宿主事件键撤销QQ等已确认事件来源及全部派生状态。 */
  invalidateEventSource(authority,scopeId,eventKey) {
    if(!this.#externalAuthorities.has(authority))throw new CharacterError('缺少事件来源失效权限');
    text(scopeId,100,'范围标识');text(eventKey,120,'成长事件键');
    const ids=this.#db.prepare("SELECT id FROM growth_sources WHERE scope_id=? AND event_key=? AND status='active'").all(scopeId,eventKey).map(row=>row.id);
    if(!ids.length)return {invalidated:false,invalidatedStateIds:[]};
    const invalidatedStateIds=this.#invalidate(scopeId,ids);
    if(!invalidatedStateIds.length)this.#invalidateDialogue(scopeId);
    return {invalidated:true,invalidatedStateIds};
  }
  /** 遗忘成长来源正文并撤下依赖状态，不反向删除事实记忆。 */
  forget(scope,input) {
    const {id}=this.#scope(scope);object(input,['id','expectedRevision'],'来源遗忘');text(input.id,100,'来源标识');integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER,'范围修订');
    const result=this.#tx(()=>{
      if(this.#scopeRevision(id)!==input.expectedRevision)throw new CharacterError('角色范围已变化');
      const source=this.#db.prepare("SELECT id FROM growth_sources WHERE id=? AND scope_id=? AND status='active'").get(input.id,id);
      if(!source)throw new CharacterError('成长来源不存在或无权访问');
      const invalidatedStateIds=this.#invalidate(id,[source.id]);
      if(!invalidatedStateIds.length)this.#invalidateDialogue(id);
      return {scopeRevision:this.#scopeRevision(id),forgottenId:source.id,invalidatedStateIds};
    });
    return result;
  }
  /** 主人撤下当前 scope 的角色状态。 */
  dismiss(scope,input) {
    const {id}=this.#scope(scope);object(input,['id','expectedRevision'],'角色撤下');text(input.id,100,'角色状态标识');integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER,'范围修订');
    return this.#tx(()=>{
      if(this.#scopeRevision(id)!==input.expectedRevision)throw new CharacterError('角色范围已变化');
      const state=this.#db.prepare('SELECT id FROM character_states WHERE id=? AND scope_id=?').get(input.id,id);
      if(!state)throw new CharacterError('角色状态不存在或无权访问');
      const invalidatedStateIds=this.#clearStates(id,[state.id],{tombstone:true});
      if(invalidatedStateIds.length)this.#advanceCharacter(id,{clearRecent:true});
      return {scopeRevision:this.#scopeRevision(id),dismissedId:state.id,invalidatedStateIds};
    });
  }
  /** 只重排明确允许恢复且仍有效的来源，绝不复活已消费/拒答/遗忘内容。 */
  requeue(scope,input) {
    const {id}=this.#scope(scope);object(input,['sourceIds','learn','expectedRevision'],'来源重排');
    if(input.learn!==true||!Array.isArray(input.sourceIds)||input.sourceIds.length<1||input.sourceIds.length>3||new Set(input.sourceIds).size!==input.sourceIds.length)throw new CharacterError('来源重排无效');
    integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER,'范围修订');
    return this.#tx(()=>{
      const policy=this.#settings(),used=this.#db.prepare('SELECT count(*) AS n FROM reflection_runs WHERE created>=?').get(this.#now()-86400000).n;
      if(!policy.enabled)throw new CharacterError('角色成长未开启');
      if(policy.dailyCallLimit===0||used>=policy.dailyCallLimit)throw new CharacterError('反思额度已用完');
      if(this.#scopeRevision(id)!==input.expectedRevision)throw new CharacterError('角色范围已变化');
      for(const sourceId of input.sourceIds) {
        const source=this.#db.prepare("SELECT status FROM growth_sources WHERE id=? AND scope_id=?").get(sourceId,id);
        const event=this.#db.prepare('SELECT status,reason FROM growth_events WHERE source_id=? ORDER BY id DESC LIMIT 1').get(sourceId);
        if(!source||source.status!=='active'||event?.status!=='cancelled'||!REQUEUE_REASONS.has(event.reason))throw new CharacterError('来源不允许重排');
      }
      for(const sourceId of input.sourceIds)this.#db.prepare("INSERT INTO growth_events(source_id,scope_id,created,status) VALUES (?,?,?,'queued')").run(sourceId,id,this.#now());
      this.#advance(id);return {scopeRevision:this.#scopeRevision(id),queuedSourceIds:[...input.sourceIds]};
    });
  }
  /** 返回无正文的 Agent 级预算与队列状态。 */
  status() {
    const now=this.#now(),policy=this.#settings(),last=this.#db.prepare('SELECT max(created) AS value FROM reflection_runs').get().value;
    return {enabled:Boolean(policy.enabled),dailyCallLimit:policy.dailyCallLimit,usedCalls24h:this.#db.prepare('SELECT count(*) AS n FROM reflection_runs WHERE created>=?').get(now-86400000).n,
      minGapSeconds:policy.minGapSeconds,idleSeconds:policy.idleSeconds,lastRunAt:last??null,nextEligibleAt:last===null?null:last+policy.minGapSeconds*1000,
      pendingScopes:this.#db.prepare("SELECT count(DISTINCT scope_id) AS n FROM growth_events WHERE status='queued'").get().n,
      pendingEvents:this.#db.prepare("SELECT count(*) AS n FROM growth_events WHERE status='queued'").get().n,
      activeRuns:this.#db.prepare("SELECT count(*) AS n FROM reflection_runs WHERE status='claimed'").get().n};
  }
}
