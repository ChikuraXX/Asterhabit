import {DAILY_BUDGET} from './daily-budget.mjs';
import {randomUUID} from 'node:crypto';
import {MemoryError,containsSecret} from './memory-store.mjs';

const DAY=86_400_000,MAX_PLAN_AGE=7*DAY;
// 联系偏好没有未经验证的关键词分类：保留完整授权主人材料，超限停止而非截断。
const MAX_CONTACT_SOURCES=64,MAX_CONTACT_CHARACTERS=24_000;
function object(value,keys,label) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new MemoryError(label+'字段无效');
  return value;
}
function text(value,max,label,{empty=false}={}) {
  if(typeof value!=='string'||(!empty&&!value.trim())||value.length>max)throw new MemoryError(label+'无效');
  return value.trim();
}
function integer(value,min,max,label) {
  if(!Number.isInteger(value)||value<min||value>max)throw new MemoryError(label+'无效');
  return value;
}
function boolean(value,label){if(typeof value!=='boolean')throw new MemoryError(label+'无效');return value;}
function topicKey(value){return value.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();}
function publicPlan(row){return {id:row.id,topic:row.topic,purpose:row.purpose,completionCriterion:row.completionCriterion,dueAt:row.dueAt,expiresAt:row.expiresAt,status:row.status,deferCount:row.deferCount,createdAt:row.createdAt};}
function publicMessage(row){return {id:row.id,planId:row.planId,text:row.text,createdAt:row.createdAt,readAt:row.readAt??null,status:row.status};}

/** 与 MemoryStore 共库的主动计划权威存储；只接受本机主人私聊 capability。 */
export class ProactiveStore {
  #db;#resolveScope;#growth;#content;#knownScopes=new Map();#now;#owners=new WeakSet();#claims=new WeakMap();
  constructor(db,{resolveScope,growth,content,now=Date.now}={}) {
    if(!db||typeof resolveScope!=='function'||!growth||typeof now!=='function')throw new TypeError('主动存储依赖无效');
    this.#db=db;this.#resolveScope=resolveScope;this.#growth=growth;this.#content=content;this.#now=now;
    db.exec([
      "CREATE TABLE IF NOT EXISTS proactive_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,enabled INTEGER NOT NULL,daily_message_limit INTEGER NOT NULL,daily_call_limit INTEGER NOT NULL,min_gap_seconds INTEGER NOT NULL,idle_seconds INTEGER NOT NULL,time_zone TEXT NOT NULL,window_start_minute INTEGER NOT NULL,window_end_minute INTEGER NOT NULL);",
      "INSERT OR IGNORE INTO proactive_settings VALUES(1,0,0,2,4,7200,300,'Asia/Shanghai',540,1320);",
      "CREATE TABLE IF NOT EXISTS proactive_contexts(scope_id TEXT NOT NULL REFERENCES scopes(id),context_key TEXT NOT NULL,root_kind TEXT NOT NULL,root_id TEXT NOT NULL,profile_revision INTEGER NOT NULL,status TEXT NOT NULL,run_id TEXT,created INTEGER NOT NULL,finished INTEGER,reason TEXT,PRIMARY KEY(scope_id,context_key));",
      "CREATE TABLE IF NOT EXISTS proactive_plans(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),topic TEXT NOT NULL,purpose TEXT NOT NULL,completion_criterion TEXT NOT NULL,due_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,defer_count INTEGER NOT NULL,created INTEGER NOT NULL,profile_revision INTEGER NOT NULL,persona_root INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS proactive_plan_sources(plan_id TEXT NOT NULL REFERENCES proactive_plans(id),source_id TEXT NOT NULL,PRIMARY KEY(plan_id,source_id));",
      "CREATE TABLE IF NOT EXISTS proactive_plan_contact_sources(plan_id TEXT NOT NULL REFERENCES proactive_plans(id),source_id TEXT NOT NULL,PRIMARY KEY(plan_id,source_id));",
      `CREATE TRIGGER IF NOT EXISTS proactive_contact_context_invalidated AFTER UPDATE OF status,excerpt ON growth_sources
       WHEN NEW.status!='active' OR NEW.excerpt=''
       BEGIN
         UPDATE proactive_inbox SET text='',status='withdrawn' WHERE plan_id IN (SELECT plan_id FROM proactive_plan_contact_sources WHERE source_id=NEW.id);
         UPDATE proactive_plans SET topic='',purpose='',completion_criterion='',status='withdrawn' WHERE id IN (SELECT plan_id FROM proactive_plan_contact_sources WHERE source_id=NEW.id);
       END;`,
      "CREATE TABLE IF NOT EXISTS proactive_plan_states(plan_id TEXT NOT NULL REFERENCES proactive_plans(id),state_id TEXT NOT NULL,state_revision INTEGER NOT NULL,PRIMARY KEY(plan_id,state_id));",
      "CREATE TABLE IF NOT EXISTS proactive_runs(run_id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),kind TEXT NOT NULL,plan_id TEXT,context_key TEXT,status TEXT NOT NULL,created INTEGER NOT NULL,finished INTEGER,reason TEXT,profile_revision INTEGER NOT NULL);",
      "CREATE UNIQUE INDEX IF NOT EXISTS proactive_one_claimed_scope ON proactive_runs(scope_id) WHERE status='claimed';",
      "CREATE TABLE IF NOT EXISTS proactive_inbox(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL UNIQUE REFERENCES proactive_plans(id),scope_id TEXT NOT NULL REFERENCES scopes(id),text TEXT NOT NULL,created INTEGER NOT NULL,read_at INTEGER,status TEXT NOT NULL);",
      `CREATE TRIGGER IF NOT EXISTS proactive_growth_source_invalidated AFTER UPDATE OF status,excerpt ON growth_sources
       WHEN NEW.status!='active' OR NEW.excerpt=''
       BEGIN
         UPDATE proactive_inbox SET text='',status='withdrawn' WHERE plan_id IN (SELECT plan_id FROM proactive_plan_sources WHERE source_id=NEW.id);
         UPDATE proactive_plans SET topic='',purpose='',completion_criterion='',status='withdrawn' WHERE id IN (SELECT plan_id FROM proactive_plan_sources WHERE source_id=NEW.id) AND status IN ('pending','claimed','sent');
       END;`,
      `CREATE TRIGGER IF NOT EXISTS proactive_character_state_invalidated AFTER UPDATE OF status,statement ON character_states
       WHEN NEW.status IN ('retired','dismissed') OR NEW.statement=''
       BEGIN
         UPDATE proactive_inbox SET text='',status='withdrawn' WHERE plan_id IN (SELECT plan_id FROM proactive_plan_states WHERE state_id=NEW.id);
         UPDATE proactive_plans SET topic='',purpose='',completion_criterion='',status='withdrawn' WHERE id IN (SELECT plan_id FROM proactive_plan_states WHERE state_id=NEW.id) AND status IN ('pending','claimed','sent');
       END;`
    ].join('\n'));
    if(content)db.exec(`CREATE TABLE IF NOT EXISTS proactive_plan_observations(plan_id TEXT NOT NULL REFERENCES proactive_plans(id),observation_id TEXT NOT NULL REFERENCES content_observations(id),observation_revision INTEGER NOT NULL,PRIMARY KEY(plan_id,observation_id));
      DROP TRIGGER IF EXISTS proactive_observation_invalidated;
      CREATE TRIGGER proactive_observation_invalidated AFTER UPDATE OF status,revision ON content_observations
      WHEN NEW.status!='active' OR NEW.revision!=OLD.revision BEGIN
        UPDATE proactive_inbox SET text='',status='withdrawn' WHERE NEW.status!='active' AND plan_id IN (SELECT plan_id FROM proactive_plan_observations WHERE observation_id=NEW.id);
        UPDATE proactive_plans SET topic=CASE WHEN NEW.status!='active' THEN '' ELSE topic END,purpose=CASE WHEN NEW.status!='active' THEN '' ELSE purpose END,completion_criterion=CASE WHEN NEW.status!='active' THEN '' ELSE completion_criterion END,status='withdrawn' WHERE id IN (SELECT plan_id FROM proactive_plan_observations WHERE observation_id=NEW.id) AND (NEW.status!='active' OR status IN ('pending','claimed'));
      END;`);
  }
  /** 为应用宿主签发不可序列化且与成长权限分离的主动联系 owner。 */
  ownerAuthority(){const owner=Object.freeze(Object.create(null));this.#owners.add(owner);return owner;}
  #owner(owner){if(!this.#owners.has(owner))throw new MemoryError('缺少主动联系主人权限');}
  #scope(scope) {
    const known=this.#resolveScope(scope);
    if(known.platform!=='local'||known.subject!=='owner'||known.context!=='private')throw new MemoryError('主动联系仅允许本机主人私聊范围');
    this.#knownScopes.set(known.id,scope);return known;
  }
  #tx(operation){this.#db.exec('BEGIN IMMEDIATE');try{const result=operation();this.#db.exec('COMMIT');return result;}catch(error){this.#db.exec('ROLLBACK');throw error;}}
  #settings(){return this.#db.prepare(`SELECT revision,enabled,daily_message_limit AS dailyMessageLimit,daily_call_limit AS dailyCallLimit,min_gap_seconds AS minGapSeconds,idle_seconds AS idleSeconds,time_zone AS timeZone,window_start_minute AS windowStartMinute,window_end_minute AS windowEndMinute FROM proactive_settings WHERE id=1`).get();}
  /** 返回全 Agent 主动策略，不包含 scope 正文。 */
  settings(owner){this.#owner(owner);const row=this.#settings();return {...row,enabled:Boolean(row.enabled)};}
  /** 用 CAS 严格替换完整策略，防止旧页面覆盖新配置。 */
  configure(owner,input) {
    this.#owner(owner);object(input,['expectedRevision','enabled','dailyMessageLimit','dailyCallLimit','minGapSeconds','idleSeconds','timeZone','windowStartMinute','windowEndMinute'],'主动配置');
    integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER,'配置修订');boolean(input.enabled,'启用状态');integer(input.dailyMessageLimit,0,DAILY_BUDGET.messageMaximum,'每日消息额度');integer(input.dailyCallLimit,0,DAILY_BUDGET.modelCallMaximum,'每日调用额度');integer(input.minGapSeconds,1800,86400,'联系间隔');integer(input.idleSeconds,300,3600,'空闲时间');
    const timeZone=text(input.timeZone,100,'时区');integer(input.windowStartMinute,0,1439,'活动开始');integer(input.windowEndMinute,0,1439,'活动结束');
    try{new Intl.DateTimeFormat('en-US',{timeZone}).format(0);}catch{throw new MemoryError('时区无效');}
    return this.#tx(()=>{
      const old=this.#settings();if(old.revision!==input.expectedRevision)throw new MemoryError('主动配置已变化');
      this.#db.prepare(`UPDATE proactive_settings SET revision=revision+1,enabled=?,daily_message_limit=?,daily_call_limit=?,min_gap_seconds=?,idle_seconds=?,time_zone=?,window_start_minute=?,window_end_minute=? WHERE id=1`).run(Number(input.enabled),input.dailyMessageLimit,input.dailyCallLimit,input.minGapSeconds,input.idleSeconds,timeZone,input.windowStartMinute,input.windowEndMinute);
      if(!input.enabled)this.#db.prepare("UPDATE proactive_plans SET status='cancelled' WHERE status IN ('pending','claimed')").run();
      return this.settings(owner);
    });
  }
  #cursor(scopeId,cursor) {
    if(cursor===undefined)return 0;
    try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!Array.isArray(value)||value[0]!==scopeId||!Number.isInteger(value[1])||value[1]<0)throw new Error();return value[1];}catch{throw new MemoryError('分页游标无效');}
  }
  #page(scopeId,rows,offset,limit){return {entries:rows.slice(offset,offset+limit),nextCursor:offset+limit<rows.length?Buffer.from(JSON.stringify([scopeId,offset+limit])).toString('base64url'):null};}
  #expire(now){this.#db.prepare("UPDATE proactive_plans SET status='expired' WHERE status='pending' AND expires_at<=?").run(now);}
  #counts(now){return {usedMessages24h:this.#db.prepare("SELECT count(*) AS n FROM proactive_inbox WHERE created>=?").get(now-DAY).n,usedCalls24h:this.#db.prepare("SELECT count(*) AS n FROM proactive_runs WHERE created>=?").get(now-DAY).n};}
  #unread(scopeId){return this.#db.prepare("SELECT count(*) AS n FROM proactive_inbox WHERE scope_id=? AND status='delivered' AND read_at IS NULL").get(scopeId).n;}
  /** 返回整个 Agent 尚未终结的主动运行数，供宿主决定是否保留恢复槽。 */
  activeRuns(){return this.#db.prepare("SELECT count(*) AS n FROM proactive_runs WHERE status='claimed'").get().n;}
  /** 返回无正文的当前范围主动状态。 */
  status(scope) {
    const {id}=this.#scope(scope),now=this.#now();this.#expire(now);const counts=this.#counts(now);
    const last=this.#db.prepare("SELECT max(created) AS value FROM proactive_inbox WHERE scope_id=?").get(id).value,settings=this.#settings();
    return {unreadCount:this.#unread(id),pendingPlans:this.#db.prepare("SELECT count(*) AS n FROM proactive_plans WHERE scope_id=? AND status IN ('pending','claimed')").get(id).n,...counts,lastMessageAt:last??null,nextEligibleAt:last===null?null:last+settings.minGapSeconds*1000};
  }
  /** 分页列出计划元数据，不暴露来源正文。 */
  plans(scope,{cursor,limit=20}={}) {
    const {id}=this.#scope(scope);integer(limit,1,50,'分页数量');this.#expire(this.#now());const offset=this.#cursor(id,cursor);
    const rows=this.#db.prepare(`SELECT id,topic,purpose,completion_criterion AS completionCriterion,due_at AS dueAt,expires_at AS expiresAt,status,defer_count AS deferCount,created AS createdAt FROM proactive_plans WHERE scope_id=? ORDER BY created DESC,rowid DESC`).all(id).map(publicPlan);
    return this.#page(id,rows,offset,limit);
  }
  /** 仅取消仍未发送且未被声明的当前 scope 计划。 */
  cancel(scope,{id}={}) {
    const known=this.#scope(scope);id=text(id,120,'计划标识');const changed=this.#db.prepare("UPDATE proactive_plans SET status='cancelled' WHERE id=? AND scope_id=? AND status IN ('pending','claimed')").run(id,known.id).changes;return {cancelled:Boolean(changed)};
  }
  /** 分页列出当前 scope 主动收件箱；失效内容保留空壳用于审计。 */
  inbox(scope,{cursor,limit=20}={}) {
    const {id}=this.#scope(scope);integer(limit,1,50,'分页数量');const offset=this.#cursor(id,cursor);
    const rows=this.#db.prepare(`SELECT id,plan_id AS planId,text,created AS createdAt,read_at AS readAt,status FROM proactive_inbox WHERE scope_id=? ORDER BY created DESC,rowid DESC`).all(id).map(publicMessage),page=this.#page(id,rows,offset,limit);
    return {...page,unreadCount:this.#unread(id)};
  }
  /** 主人明确确认实际可见消息；未知或已撤回 ID 不跨 scope 泄露。 */
  markRead(scope,{ids}={}) {
    const known=this.#scope(scope);if(!Array.isArray(ids)||ids.length<1||ids.length>50||new Set(ids).size!==ids.length)throw new MemoryError('已读消息标识无效');
    const readIds=[],now=this.#now();this.#tx(()=>{for(const id of ids){text(id,120,'消息标识');const changed=this.#db.prepare("UPDATE proactive_inbox SET read_at=?,status='read' WHERE id=? AND scope_id=? AND status='delivered' AND read_at IS NULL").run(now,id,known.id).changes;if(changed)readIds.push(id);}});
    return {readIds,unreadCount:this.#unread(known.id)};
  }
  #window(settings,now) {
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:settings.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now),values=Object.fromEntries(parts.map(part=>[part.type,part.value])),minute=Number(values.hour)*60+Number(values.minute),start=settings.windowStartMinute,end=settings.windowEndMinute;
    return start===end||(start<end?minute>=start&&minute<end:minute>=start||minute<end);
  }
  #validPlan(row,profileRevision) {
    if(this.#content){
      const references=this.#db.prepare('SELECT observation_id AS id,observation_revision AS revision FROM proactive_plan_observations WHERE plan_id=?').all(row.id);
      if(references.some(ref=>!this.#content.sharingValid(this.#knownScopes.get(row.scopeId),ref.id,ref.revision)))return false;
    }
    if(row.personaRoot&&(row.profileRevision!==profileRevision||this.#hasMaterialHistory(row.scopeId)))return false;
    const badContactSource=this.#db.prepare(`SELECT 1 FROM proactive_plan_contact_sources x LEFT JOIN growth_sources s ON s.id=x.source_id AND s.scope_id=? WHERE x.plan_id=? AND (s.id IS NULL OR s.status!='active' OR s.excerpt='') LIMIT 1`).get(row.scopeId,row.id);
    if(badContactSource)return false;
    const badSource=this.#db.prepare(`SELECT 1 FROM proactive_plan_sources x LEFT JOIN growth_sources s ON s.id=x.source_id AND s.scope_id=? WHERE x.plan_id=? AND (s.id IS NULL OR s.status!='active' OR s.excerpt='') LIMIT 1`).get(row.scopeId,row.id);
    if(badSource)return false;
    const badState=this.#db.prepare(`SELECT 1 FROM proactive_plan_states x LEFT JOIN character_states s ON s.id=x.state_id AND s.scope_id=? WHERE x.plan_id=? AND (s.id IS NULL OR s.revision!=x.state_revision OR s.status IN ('retired','dismissed') OR s.statement='') LIMIT 1`).get(row.scopeId,row.id);
    return !badState;
  }
  #withdraw(id,{clear=false}={}) {
    if(clear)this.#db.prepare("UPDATE proactive_inbox SET text='',status='withdrawn' WHERE plan_id=?").run(id);
    this.#db.prepare(`UPDATE proactive_plans SET topic=CASE WHEN ? THEN '' ELSE topic END,purpose=CASE WHEN ? THEN '' ELSE purpose END,completion_criterion=CASE WHEN ? THEN '' ELSE completion_criterion END,status='withdrawn' WHERE id=? AND status IN ('pending','claimed','sent')`).run(Number(clear),Number(clear),Number(clear),id);
  }
  /** 发送/读取前重新验证 persona 修订与所有来源、状态依赖。 */
  revokeInvalid(scope,{profileRevision}={}) {
    const known=this.#scope(scope);integer(profileRevision,0,Number.MAX_SAFE_INTEGER,'Agent 配置修订');let revoked=0;
    this.#tx(()=>{for(const row of this.#db.prepare(`SELECT id,scope_id AS scopeId,profile_revision AS profileRevision,persona_root AS personaRoot FROM proactive_plans WHERE scope_id=? AND status IN ('pending','claimed')`).all(known.id))if(!this.#validPlan(row,profileRevision)){this.#withdraw(row.id);revoked++;}});
    return {revoked};
  }
  /** 拒答或结果拒绝消耗完整输入根；新角色修订不能重新包装这些根。 */
  #sourceRejected(scopeId,sourceId) {
    return Boolean(this.#db.prepare(`SELECT 1 FROM proactive_contexts c JOIN proactive_runs r ON r.run_id=c.run_id AND r.scope_id=c.scope_id WHERE c.scope_id=? AND c.root_kind='growth_source' AND c.root_id=? AND r.reason IN ('suppressed','rejected') LIMIT 1`).get(scopeId,sourceId)
      ||this.#db.prepare(`SELECT 1 FROM proactive_plan_sources x JOIN proactive_plans p ON p.id=x.plan_id JOIN proactive_runs r ON r.plan_id=p.id AND r.scope_id=p.scope_id WHERE p.scope_id=? AND x.source_id=? AND r.kind='contact' AND r.reason IN ('suppressed','rejected') LIMIT 1`).get(scopeId,sourceId));
  }
  /** 历史材料含遗忘墓碑，不能通过遗忘或改人格重新获得空白开场机会。 */
  #hasMaterialHistory(scopeId) {
    return Boolean(this.#content?.hasHistory(this.#knownScopes.get(scopeId))||this.#db.prepare('SELECT 1 FROM growth_sources WHERE scope_id=? LIMIT 1').get(scopeId)
      ||this.#db.prepare('SELECT 1 FROM character_states WHERE scope_id=? LIMIT 1').get(scopeId));
  }
  /** 当前范围的已授权主人材料，仅作联系判断数据；不读取recent或外部资料。超限返回null。 */
  #contactContext(scopeId) {
    const sources=this.#db.prepare(`SELECT id,origin,excerpt FROM growth_sources WHERE scope_id=? AND origin='user' AND status='active' AND excerpt!='' ORDER BY created,rowid LIMIT ?`).all(scopeId,MAX_CONTACT_SOURCES+1);
    if(sources.length>MAX_CONTACT_SOURCES||sources.reduce((size,row)=>size+row.excerpt.length,0)>MAX_CONTACT_CHARACTERS)return null;
    return Object.freeze({sources:Object.freeze(sources.map(row=>Object.freeze({...row})))});
  }
  /** 只绑定来源标识；源正文仍由成长库保存，遗忘通过同库触发器清理派生文本。 */
  #bindContactSources(planId,contactContext) {
    const insert=this.#db.prepare('INSERT OR IGNORE INTO proactive_plan_contact_sources VALUES (?,?)');
    for(const source of contactContext.sources)insert.run(planId,source.id);
  }
  #planningContext(scopeId,profileRevision) {
    if(this.#content)for(const observation of this.#content.sharingCandidates(this.#knownScopes.get(scopeId))){
      const key='observation:'+observation.id+':'+observation.revision;
      if(this.#db.prepare('SELECT 1 FROM proactive_contexts WHERE scope_id=? AND context_key=?').get(scopeId,key))continue;
      const sourceId='observation:'+observation.id;
      return {key,root:{id:observation.id,kind:'observation',revision:observation.revision},profileRevision,sources:[{id:sourceId,origin:'external',excerpt:observation.excerpt}],states:[],allowedSourceIds:[sourceId]};
    }
    const states=this.#db.prepare(`SELECT s.id,s.kind,s.topic,s.statement,s.brief_reason AS briefReason,s.status,s.revision FROM character_states s WHERE s.scope_id=? AND s.status NOT IN ('retired','dismissed') AND s.statement!='' AND NOT EXISTS(SELECT 1 FROM proactive_contexts c WHERE c.scope_id=s.scope_id AND c.context_key='state:'||s.id||':'||s.revision) ORDER BY s.updated,s.rowid`).all(scopeId);
    for(const state of states) {
      const dependencies=this.#db.prepare(`SELECT g.id,g.origin,g.excerpt FROM character_state_dependencies x JOIN growth_sources g ON g.id=x.source_id WHERE x.state_id=? AND g.scope_id=? AND g.status='active' AND g.excerpt!='' ORDER BY g.id`).all(state.id,scopeId),expected=this.#db.prepare('SELECT count(*) AS n FROM character_state_dependencies WHERE state_id=?').get(state.id).n;
      if(!dependencies.length||dependencies.length!==expected||dependencies.length>8||dependencies.reduce((size,row)=>size+row.excerpt.length,0)>12000)continue;
      if(dependencies.some(source=>this.#sourceRejected(scopeId,source.id)||this.#content?.sourceObservation(this.#knownScopes.get(scopeId),source.id)))continue;
      state.sourceIds=dependencies.map(row=>row.id);return {key:`state:${state.id}:${state.revision}`,root:{id:state.id,kind:'character_state',revision:state.revision},profileRevision,sources:dependencies,states:[state],allowedSourceIds:[...state.sourceIds]};
    }
    const source=this.#db.prepare(`SELECT s.id,s.origin,s.excerpt FROM growth_sources s WHERE s.scope_id=? AND s.status='active' AND s.excerpt!='' AND NOT EXISTS(SELECT 1 FROM proactive_contexts c WHERE c.scope_id=s.scope_id AND c.context_key='source:'||s.id) ORDER BY s.created,s.rowid`).all(scopeId).find(row=>!this.#content?.sourceObservation(this.#knownScopes.get(scopeId),row.id));
    if(source)return {key:'source:'+source.id,root:{id:source.id,kind:'growth_source'},profileRevision,sources:[source],states:[],allowedSourceIds:[source.id]};
    const personaKey='persona:'+profileRevision;
    if(!this.#hasMaterialHistory(scopeId)&&!this.#db.prepare('SELECT 1 FROM proactive_contexts WHERE scope_id=? LIMIT 1').get(scopeId)&&!this.#db.prepare('SELECT 1 FROM proactive_plans WHERE scope_id=? LIMIT 1').get(scopeId))return {key:personaKey,root:{id:'persona',kind:'persona'},profileRevision,sources:[],states:[],allowedSourceIds:['persona']};
    return null;
  }
  #available(known,profileRevision,now) {
    const settings=this.#settings(),counts=this.#counts(now);if(!settings.enabled||settings.dailyCallLimit===0||counts.usedCalls24h>=settings.dailyCallLimit||!this.#window(settings,now))return null;
    if(this.#db.prepare("SELECT 1 FROM proactive_runs WHERE scope_id=? AND status='claimed'").get(known.id)||this.#contactContext(known.id)===null)return null;
    const due=this.#db.prepare("SELECT id FROM proactive_plans WHERE scope_id=? AND status='pending' AND due_at<=? AND expires_at>? ORDER BY due_at,created LIMIT 1").get(known.id,now,now);
    if(due){const last=this.#db.prepare("SELECT max(created) AS value FROM proactive_inbox WHERE scope_id=?").get(known.id).value;if(settings.dailyMessageLimit===0||counts.usedMessages24h>=settings.dailyMessageLimit||this.#unread(known.id)>0||(last!==null&&now-last<settings.minGapSeconds*1000))return null;return {kind:'contact',planId:due.id};}
    return this.#planningContext(known.id,profileRevision)?{kind:'plan'}:null;
  }
  /** 在策略、时段、额度与失效检查均通过时返回唯一下一类工作，不返回正文。 */
  next(scope,{profileRevision,now=this.#now()}={}) {
    const known=this.#scope(scope);integer(profileRevision,0,Number.MAX_SAFE_INTEGER,'Agent 配置修订');integer(now,0,Number.MAX_SAFE_INTEGER,'当前时间');this.revokeInvalid(scope,{profileRevision});this.#expire(now);
    return this.#available(known,profileRevision,now);
  }
  #claim(value,scopeId){const known=this.#claims.get(value);if(!known||known.scopeId!==scopeId||known.runId!==value.runId)throw new MemoryError('主动任务无效');return known;}
  #planningInputsValid(scopeId,claim) {
    if(claim.roots.some(root=>root.kind==='persona')&&this.#hasMaterialHistory(scopeId))return false;
    for(const root of claim.roots)if(root.kind==='observation'){const observation=this.#content?.sharingRead(this.#knownScopes.get(scopeId),root.id,root.revision);if(!observation||observation.excerpt!==claim.sources.find(source=>source.id==='observation:'+root.id)?.excerpt)return false;}
    const sourceIds=claim.allowedSourceIds.filter(id=>id!=='persona'&&!id.startsWith('observation:')),rows=sourceIds.map(id=>this.#db.prepare("SELECT id,origin,excerpt FROM growth_sources WHERE id=? AND scope_id=? AND status='active' AND excerpt!=''").get(id,scopeId));
    if(rows.some((row,index)=>!row||row.origin!==claim.sources.find(source=>source.id===sourceIds[index])?.origin||row.excerpt!==claim.sources.find(source=>source.id===sourceIds[index])?.excerpt))return false;
    for(const root of claim.roots)if(root.kind==='character_state'){
      const state=this.#db.prepare("SELECT revision FROM character_states WHERE id=? AND scope_id=? AND status NOT IN ('retired','dismissed') AND statement!=''").get(root.id,scopeId);if(!state||state.revision!==root.revision)return false;
      const dependencies=this.#db.prepare('SELECT source_id AS id FROM character_state_dependencies WHERE state_id=? ORDER BY source_id').all(root.id).map(row=>row.id);if(dependencies.length!==sourceIds.length||dependencies.some(id=>!sourceIds.includes(id)))return false;
    }
    return true;
  }
  #contactInputs(scopeId,planId) {
    const expectedSources=this.#db.prepare('SELECT count(*) AS n FROM proactive_plan_sources WHERE plan_id=?').get(planId).n;
    const sources=this.#db.prepare(`SELECT s.id,s.origin,s.excerpt FROM proactive_plan_sources x JOIN growth_sources s ON s.id=x.source_id WHERE x.plan_id=? AND s.scope_id=? AND s.status='active' AND s.excerpt!='' ORDER BY s.id`).all(planId,scopeId);
    if(sources.length!==expectedSources||sources.length>8||sources.reduce((size,row)=>size+row.excerpt.length,0)>12000)throw new MemoryError('主动计划批准来源已失效或超出输入上限');
    const expectedStates=this.#db.prepare('SELECT count(*) AS n FROM proactive_plan_states WHERE plan_id=?').get(planId).n;
    const states=this.#db.prepare(`SELECT s.id,s.kind,s.topic,s.statement,s.brief_reason AS briefReason,s.status,s.revision FROM proactive_plan_states x JOIN character_states s ON s.id=x.state_id AND s.revision=x.state_revision WHERE x.plan_id=? AND s.scope_id=? AND s.status NOT IN ('retired','dismissed') AND s.statement!='' ORDER BY s.id`).all(planId,scopeId);
    if(states.length!==expectedStates)throw new MemoryError('主动计划角色状态已失效');
    for(const state of states)state.sourceIds=this.#db.prepare(`SELECT d.source_id AS id FROM character_state_dependencies d JOIN proactive_plan_sources p ON p.source_id=d.source_id AND p.plan_id=? WHERE d.state_id=? ORDER BY d.source_id`).all(planId,state.id).map(row=>row.id);
    if(this.#content){
      const references=this.#db.prepare('SELECT observation_id AS id,observation_revision AS revision FROM proactive_plan_observations WHERE plan_id=?').all(planId);
      for(const ref of references){const observation=this.#content.sharingRead(this.#knownScopes.get(scopeId),ref.id,ref.revision);if(!observation)throw new MemoryError('外部观察已失效');sources.push({id:'observation:'+ref.id,origin:'external',excerpt:observation.excerpt});}
    }
    return {sources,states};
  }
  /** 在应用调用额度预留后声明 Agent 本地额度与一次有限输入。 */
  begin(scope,{kind,planId,runId,profileRevision}={}) {
    const known=this.#scope(scope);if(!['plan','contact'].includes(kind))throw new MemoryError('主动任务类型无效');runId=text(runId,120,'主动任务标识');integer(profileRevision,0,Number.MAX_SAFE_INTEGER,'Agent 配置修订');if(kind==='plan'&&planId!==undefined)throw new MemoryError('规划任务字段无效');if(kind==='contact')planId=text(planId,120,'计划标识');
    this.revokeInvalid(scope,{profileRevision});
    return this.#tx(()=>{
      const now=this.#now();this.#expire(now);const policy=this.#settings(),next=this.#available(known,profileRevision,now);if(!next||next.kind!==kind||(kind==='contact'&&next.planId!==planId))throw new MemoryError('当前没有可运行的主动任务');
      const contactContext=this.#contactContext(known.id);if(contactContext===null)throw new MemoryError('联系上下文超过输入上限');
      let context=null,plan=null;
      if(kind==='plan'){
        context=this.#planningContext(known.id,profileRevision);if(!context)throw new MemoryError('当前没有可规划上下文');
        this.#db.prepare("INSERT INTO proactive_contexts VALUES (?,?,?,?,?,'consumed',?,?,?,?)").run(known.id,context.key,context.root.kind,context.root.id,profileRevision,runId,now,now,'claimed');
        if(context.root.kind==='character_state')for(const source of context.sources){
          // 基础键阻止裸来源重选；修订关联键保留每次输入与运行的不可变关系。
          const consume=this.#db.prepare("INSERT OR IGNORE INTO proactive_contexts VALUES (?,?,?,?,?,'consumed',?,?,?,?)");
          for(const key of ['source:'+source.id,context.key+':source:'+source.id])consume.run(known.id,key,'growth_source',source.id,profileRevision,runId,now,now,'claimed');
        }
      }else{
        plan=this.#db.prepare(`SELECT id,topic,purpose,completion_criterion AS completionCriterion,due_at AS dueAt,expires_at AS expiresAt,defer_count AS deferCount,created AS createdAt,profile_revision AS profileRevision,persona_root AS personaRoot,scope_id AS scopeId FROM proactive_plans WHERE id=? AND scope_id=? AND status='pending'`).get(planId,known.id);
        if(!plan||!this.#validPlan(plan,profileRevision))throw new MemoryError('主动计划已失效');const inputs=this.#contactInputs(known.id,plan.id);plan.sources=inputs.sources;plan.characterStates=inputs.states;this.#db.prepare("UPDATE proactive_plans SET status='claimed' WHERE id=?").run(plan.id);this.#bindContactSources(plan.id,contactContext);
      }
      this.#db.prepare("INSERT INTO proactive_runs VALUES (?,?,?,?,?,'claimed',?,NULL,NULL,?)").run(runId,known.id,kind,planId??null,context?.key??null,now,profileRevision);
      const claim=Object.freeze(kind==='plan'?{kind,runId,profileRevision,policyRevision:policy.revision,contactContext,roots:Object.freeze([Object.freeze(context.root)]),sources:Object.freeze(context.sources.map(row=>Object.freeze({...row}))),characterStates:Object.freeze(context.states.map(row=>Object.freeze({...row,sourceIds:Object.freeze([...row.sourceIds])}))),allowedSourceIds:Object.freeze([...context.allowedSourceIds]),contextKey:context.key}:{kind,runId,profileRevision,policyRevision:policy.revision,contactContext,planId:plan.id,plan:Object.freeze(publicPlan({...plan,status:'claimed'})),sources:Object.freeze(plan.sources.map(row=>Object.freeze({...row}))),characterStates:Object.freeze(plan.characterStates.map(row=>Object.freeze({...row,sourceIds:Object.freeze([...row.sourceIds])}))),allowedSourceIds:Object.freeze(this.#db.prepare('SELECT source_id AS id FROM proactive_plan_sources WHERE plan_id=? ORDER BY source_id').all(plan.id).map(row=>row.id))});
      this.#claims.set(claim,{scopeId:known.id,runId});return claim;
    });
  }
  #validatePlanning(claim,value) {
    if(value?.decision==='skip'){object(value,['decision'],'规划结果');return {decision:'skip'};}
    object(value,['decision','topic','purpose','sourceIds','delayMinutes','completionCriterion'],'规划结果');if(value.decision!=='plan')throw new MemoryError('规划决定无效');
    const item={decision:'plan',topic:text(value.topic,100,'计划主题'),purpose:text(value.purpose,300,'计划目的'),completionCriterion:text(value.completionCriterion,300,'完成条件'),delayMinutes:integer(value.delayMinutes,1,1440,'计划延迟')};
    if(containsSecret(item.topic+'\n'+item.purpose+'\n'+item.completionCriterion))throw new MemoryError('主动计划含疑似敏感凭据');
    const allowed=new Set(claim.allowedSourceIds);if(!Array.isArray(value.sourceIds)||value.sourceIds.length<1||value.sourceIds.length>8||new Set(value.sourceIds).size!==value.sourceIds.length||value.sourceIds.some(id=>!allowed.has(id)))throw new MemoryError('主动计划来源无效');item.sourceIds=[...value.sourceIds];return item;
  }
  #validateContact(value) {
    if(value?.decision==='skip'){object(value,['decision'],'联系结果');return {decision:'skip'};}
    if(value?.decision==='defer'){object(value,['decision','delayMinutes'],'联系结果');return {decision:'defer',delayMinutes:integer(value.delayMinutes,1,1440,'延期时间')};}
    object(value,['decision','text'],'联系结果');if(value.decision!=='send')throw new MemoryError('联系决定无效');const content=text(value.text,1200,'主动消息');if(containsSecret(content))throw new MemoryError('主动消息含疑似敏感凭据');return {decision:'send',text:content};
  }
  /** 在宿主同步 guard 内提交严格模型决定；不会把主动消息写成成长来源。 */
  complete(scope,claim,value,{messageId}={}) {
    const known=this.#scope(scope);this.#claim(claim,known.id);const decision=claim.kind==='plan'?this.#validatePlanning(claim,value):this.#validateContact(value);
    return this.#tx(()=>{
      const run=this.#db.prepare("SELECT * FROM proactive_runs WHERE run_id=? AND scope_id=? AND status='claimed'").get(claim.runId,known.id);if(!run)throw new MemoryError('主动任务不再有效');const now=this.#now(),policy=this.#settings();
      if(!policy.enabled||policy.revision!==claim.policyRevision||!this.#window(policy,now))throw new MemoryError('主动策略或活动窗口已变化');
      if(JSON.stringify(this.#contactContext(known.id))!==JSON.stringify(claim.contactContext))throw new MemoryError('联系上下文已变化，旧结果不得提交');
      if(claim.kind==='plan'){
        if(!this.#planningInputsValid(known.id,claim))throw new MemoryError('主动规划输入根已失效');
        if(decision.decision==='skip'){this.#db.prepare("UPDATE proactive_runs SET status='committed',finished=?,reason='skip' WHERE run_id=?").run(now,claim.runId);return {kind:'plan',runId:claim.runId,outcome:'skipped'};}
        const duplicate=this.#db.prepare('SELECT topic FROM proactive_plans WHERE scope_id=? AND created>=?').all(known.id,now-DAY).some(row=>topicKey(row.topic)===topicKey(decision.topic));
        if(duplicate){this.#db.prepare("UPDATE proactive_runs SET status='committed',finished=?,reason='duplicate_topic' WHERE run_id=?").run(now,claim.runId);return {kind:'plan',runId:claim.runId,outcome:'skipped',reason:'duplicate_topic'};}
        const id=randomUUID(),due=now+decision.delayMinutes*60_000,expires=Math.min(now+MAX_PLAN_AGE,due+MAX_PLAN_AGE);
        this.#db.prepare("INSERT INTO proactive_plans VALUES (?,?,?,?,?,? ,?,'pending',0,?,?,?)").run(id,known.id,decision.topic,decision.purpose,decision.completionCriterion,due,expires,now,claim.profileRevision,Number(claim.allowedSourceIds.includes('persona')));
        this.#bindContactSources(id,claim.contactContext);
        for(const sourceId of claim.allowedSourceIds)if(sourceId!=='persona'&&!sourceId.startsWith('observation:'))this.#db.prepare('INSERT INTO proactive_plan_sources VALUES (?,?)').run(id,sourceId);
        for(const root of claim.roots)if(root.kind==='observation')this.#db.prepare('INSERT INTO proactive_plan_observations VALUES (?,?,?)').run(id,root.id,root.revision);
        for(const root of claim.roots)if(root.kind==='character_state')this.#db.prepare('INSERT INTO proactive_plan_states VALUES (?,?,?)').run(id,root.id,root.revision);
        this.#db.prepare("UPDATE proactive_runs SET status='committed',finished=?,reason='planned' WHERE run_id=?").run(now,claim.runId);return publicPlan({id,topic:decision.topic,purpose:decision.purpose,completionCriterion:decision.completionCriterion,dueAt:due,expiresAt:expires,status:'pending',deferCount:0,createdAt:now});
      }
      const plan=this.#db.prepare(`SELECT id,scope_id AS scopeId,profile_revision AS profileRevision,persona_root AS personaRoot,defer_count AS deferCount,due_at AS dueAt,expires_at AS expiresAt FROM proactive_plans WHERE id=? AND scope_id=? AND status='claimed'`).get(claim.planId,known.id);if(!plan||plan.dueAt>now||plan.expiresAt<=now||!this.#validPlan(plan,claim.profileRevision))throw new MemoryError('主动计划未到期、已过期或失效');
      if(decision.decision==='defer'){
        if(plan.deferCount>=1)throw new MemoryError('主动计划最多延期一次');const due=Math.min(now+decision.delayMinutes*60_000,this.#db.prepare('SELECT expires_at AS value FROM proactive_plans WHERE id=?').get(plan.id).value);
        this.#db.prepare("UPDATE proactive_plans SET status='pending',due_at=?,defer_count=defer_count+1 WHERE id=?").run(due,plan.id);this.#db.prepare("UPDATE proactive_runs SET status='committed',finished=?,reason='deferred' WHERE run_id=?").run(now,claim.runId);return {...publicPlan(this.#db.prepare(`SELECT id,topic,purpose,completion_criterion AS completionCriterion,due_at AS dueAt,expires_at AS expiresAt,status,defer_count AS deferCount,created AS createdAt FROM proactive_plans WHERE id=?`).get(plan.id)),kind:'contact',runId:claim.runId,outcome:'deferred'};
      }
      if(decision.decision==='skip'){this.#db.prepare("UPDATE proactive_plans SET status='skipped' WHERE id=?").run(plan.id);this.#db.prepare("UPDATE proactive_runs SET status='committed',finished=?,reason='skip' WHERE run_id=?").run(now,claim.runId);return {kind:'contact',runId:claim.runId,planId:plan.id,outcome:'skipped'};}
      messageId=text(messageId,120,'主动消息标识');if(messageId!==claim.runId)throw new MemoryError('主动消息标识必须绑定本次运行');const settings=this.#settings(),counts=this.#counts(now),last=this.#db.prepare("SELECT max(created) AS value FROM proactive_inbox WHERE scope_id=?").get(known.id).value;
      if(!settings.enabled||settings.dailyMessageLimit===0||counts.usedMessages24h>=settings.dailyMessageLimit||this.#unread(known.id)>0||(last!==null&&now-last<settings.minGapSeconds*1000))throw new MemoryError('主动消息额度或间隔不可用');
      this.#db.prepare("INSERT INTO proactive_inbox VALUES (?,?,?,?,?,NULL,'delivered')").run(messageId,plan.id,known.id,decision.text,now);this.#db.prepare("UPDATE proactive_plans SET status='sent' WHERE id=?").run(plan.id);this.#db.prepare("UPDATE proactive_runs SET status='committed',finished=?,reason='sent' WHERE run_id=?").run(now,claim.runId);
      return publicMessage({id:messageId,planId:plan.id,text:decision.text,createdAt:now,readAt:null,status:'delivered'});
    });
  }
  /** 拒答、失败或取消都终结 claim；联系任务不自动重发。 */
  interrupt(scope,claim,reason='interrupted') {
    const known=this.#scope(scope);this.#claim(claim,known.id);reason=text(reason,40,'主动终止原因');return this.#tx(()=>{const run=this.#db.prepare("SELECT kind,plan_id AS planId,status FROM proactive_runs WHERE run_id=? AND scope_id=?").get(claim.runId,known.id);if(!run||run.status!=='claimed')return false;if(run.kind==='contact'&&run.planId)this.#withdraw(run.planId);this.#db.prepare("UPDATE proactive_runs SET status='interrupted',finished=?,reason=? WHERE run_id=?").run(this.#now(),reason,claim.runId);return true;});
  }
  /** 原生 lease 清理后终结重启遗留 claim，不重发模型调用。 */
  recoverInterrupted(scope,reason='crashed') {
    const known=this.#scope(scope);reason=text(reason,40,'主动终止原因');return this.#tx(()=>{const runs=this.#db.prepare("SELECT run_id AS runId,kind,plan_id AS planId FROM proactive_runs WHERE scope_id=? AND status='claimed'").all(known.id);for(const run of runs){if(run.kind==='contact'&&run.planId)this.#withdraw(run.planId);this.#db.prepare("UPDATE proactive_runs SET status='interrupted',finished=?,reason=? WHERE run_id=?").run(this.#now(),reason,run.runId);}return runs.length;});
  }
  /** 对账单条计划或消息，不泄露其他 scope 是否存在。 */
  deliveryState(scope,id) {
    const known=this.#scope(scope);id=text(id,120,'投递标识');const message=this.#db.prepare('SELECT status,read_at AS readAt FROM proactive_inbox WHERE id=? AND scope_id=?').get(id,known.id);if(message)return message.status==='withdrawn'?'withdrawn':message.readAt!==null?'read':'delivered';const plan=this.#db.prepare('SELECT status FROM proactive_plans WHERE id=? AND scope_id=?').get(id,known.id);if(!plan)return 'missing';if(plan.status==='sent'){const sent=this.#db.prepare('SELECT status,read_at AS readAt FROM proactive_inbox WHERE plan_id=?').get(id);return sent?.status==='withdrawn'?'withdrawn':sent?.readAt!==null?'read':'delivered';}return ['cancelled','skipped','expired','withdrawn'].includes(plan.status)?'withdrawn':'missing';
  }
  /** 供 MemoryStore.history 合并的有限主动 assistant 消息。 */
  history(scope,{since=this.#now()-MAX_PLAN_AGE}={}) {
    const known=this.#scope(scope);return this.#db.prepare("SELECT id,text,created AS createdAt FROM proactive_inbox WHERE scope_id=? AND created>=? AND status IN ('delivered','read') AND text!='' ORDER BY created,id").all(known.id,since);
  }
}
