import {DAILY_BUDGET} from './daily-budget.mjs';
import {randomUUID} from 'node:crypto';

const DAY=86_400_000;
const BVID=/^BV[A-Za-z0-9]{10}$/u;

/** 平台内容观察合同错误；不回显外部正文。 */
export class ContentError extends Error {
  constructor(message){super(message);this.name='ContentError';}
}
function object(value,keys,label) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new ContentError(label+'字段无效');
  return value;
}
function text(value,max,label) {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new ContentError(label+'无效');
  return value.trim();
}
function integer(value,min,max,label) {
  if(!Number.isInteger(value)||value<min||value>max)throw new ContentError(label+'无效');
  return value;
}
function bool(value,label){if(typeof value!=='boolean')throw new ContentError(label+'无效');return value;}
function strings(value,{limit,max,label}) {
  if(!Array.isArray(value)||value.length>limit||new Set(value).size!==value.length)throw new ContentError(label+'无效');
  return value.map(item=>text(item,max,label));
}
function deepFreeze(value) {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))deepFreeze(item);Object.freeze(value);}
  return value;
}

/** 与 MemoryStore 共库的平台观察存储；不持有网络、模型或发布执行器。 */
export class ContentStore {
  #db;#resolveScope;#growth;#growthAuthority;#now;#owners=new WeakSet();#claims=new WeakMap();
  constructor(db,{resolveScope,growth,now=Date.now}={}) {
    if(!db||typeof resolveScope!=='function'||!growth||typeof now!=='function')throw new TypeError('内容存储依赖无效');
    this.#db=db;this.#resolveScope=resolveScope;this.#growth=growth;this.#now=now;this.#growthAuthority=growth.externalSourceAuthority();
    db.exec([
      "CREATE TABLE IF NOT EXISTS content_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,read_enabled INTEGER NOT NULL,allow_learning INTEGER NOT NULL,publish_enabled INTEGER NOT NULL CHECK(publish_enabled=0),keywords_json TEXT NOT NULL,creator_ids_json TEXT NOT NULL,daily_read_limit INTEGER NOT NULL,daily_model_limit INTEGER NOT NULL,daily_session_limit INTEGER NOT NULL,min_gap_seconds INTEGER NOT NULL,idle_seconds INTEGER NOT NULL,account_id TEXT,account_label TEXT);",
      "INSERT OR IGNORE INTO content_settings VALUES(1,0,0,0,0,'[]','[]',20,2,1,3600,300,NULL,NULL);",
      "CREATE TABLE IF NOT EXISTS content_runs(run_id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),account_id TEXT NOT NULL,policy_revision INTEGER NOT NULL,growth_revision INTEGER NOT NULL,growth_enabled INTEGER NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,finished INTEGER,reason TEXT);",
      "CREATE UNIQUE INDEX IF NOT EXISTS content_one_claimed_scope ON content_runs(scope_id) WHERE status='claimed';",
      "CREATE TABLE IF NOT EXISTS content_read_attempts(run_id TEXT NOT NULL REFERENCES content_runs(run_id),scope_id TEXT NOT NULL REFERENCES scopes(id),operation TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(run_id,operation));",
      "CREATE TABLE IF NOT EXISTS content_model_attempts(run_id TEXT NOT NULL REFERENCES content_runs(run_id),scope_id TEXT NOT NULL REFERENCES scopes(id),stage TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(run_id,stage));",
      "CREATE TABLE IF NOT EXISTS content_observations(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),account_id TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,bvid TEXT NOT NULL,title TEXT NOT NULL,creator_id TEXT NOT NULL DEFAULT '',url TEXT NOT NULL,coverage_json TEXT NOT NULL,summary TEXT NOT NULL,viewpoint TEXT NOT NULL,share INTEGER NOT NULL,materials_json TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,learned INTEGER NOT NULL);",
      "CREATE INDEX IF NOT EXISTS content_observation_scope_account ON content_observations(scope_id,account_id,created DESC);",
      "CREATE UNIQUE INDEX IF NOT EXISTS content_observation_seen_bvid ON content_observations(scope_id,account_id,bvid);",
      "CREATE TABLE IF NOT EXISTS content_observation_sources(observation_id TEXT NOT NULL REFERENCES content_observations(id),source_id TEXT NOT NULL UNIQUE REFERENCES growth_sources(id),PRIMARY KEY(observation_id,source_id));",
      "CREATE TABLE IF NOT EXISTS content_feedback_state(scope_id TEXT NOT NULL REFERENCES scopes(id),account_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(scope_id,account_id));",
      "CREATE TABLE IF NOT EXISTS content_feedback(scope_id TEXT NOT NULL REFERENCES scopes(id),account_id TEXT NOT NULL,target_scope TEXT NOT NULL CHECK(target_scope IN ('content','creator')),target_id TEXT NOT NULL,value TEXT NOT NULL CHECK(value IN ('like','less','block')),source_observation_id TEXT NOT NULL REFERENCES content_observations(id),updated INTEGER NOT NULL,PRIMARY KEY(scope_id,account_id,target_scope,target_id));",
      `CREATE TRIGGER IF NOT EXISTS content_observation_feedback_invalidated AFTER UPDATE OF status ON content_observations
       WHEN NEW.status='forgotten' AND OLD.status!='forgotten'
       BEGIN
         INSERT OR IGNORE INTO content_feedback_state(scope_id,account_id,revision)
         SELECT NEW.scope_id,NEW.account_id,0 WHERE EXISTS (SELECT 1 FROM content_feedback WHERE source_observation_id=NEW.id);
         UPDATE content_feedback_state SET revision=revision+1
         WHERE scope_id=NEW.scope_id AND account_id=NEW.account_id AND EXISTS (SELECT 1 FROM content_feedback WHERE source_observation_id=NEW.id);
         DELETE FROM content_feedback WHERE source_observation_id=NEW.id;
       END;`,
      `CREATE TRIGGER IF NOT EXISTS content_growth_source_invalidated AFTER UPDATE OF status,excerpt ON growth_sources
       WHEN (NEW.status!='active' OR NEW.excerpt='')
       BEGIN
         UPDATE content_observations SET revision=revision+1,status='forgotten',title='',coverage_json='{"description":0,"subtitle":0,"comment":0}',summary='',viewpoint='',share=0,materials_json='[]'
         WHERE id IN (SELECT observation_id FROM content_observation_sources WHERE source_id=NEW.id) AND status!='forgotten';
       END;`
    ].join('\n'));
    const columns=db.prepare('PRAGMA table_info(content_observations)').all();
    if(!columns.some(column=>column.name==='creator_id'))db.exec("ALTER TABLE content_observations ADD COLUMN creator_id TEXT NOT NULL DEFAULT ''");
  }
  /** 为可信应用宿主签发不可序列化且与其他 owner 分离的权限。 */
  ownerAuthority(){const owner=Object.freeze(Object.create(null));this.#owners.add(owner);return owner;}
  #owner(owner){if(!this.#owners.has(owner))throw new ContentError('缺少内容观察主人权限');}
  #scope(scope) {
    const known=this.#resolveScope(scope);
    if(known.platform!=='local'||known.subject!=='owner'||known.context!=='private')throw new ContentError('内容观察仅允许本机主人私聊范围');
    return known;
  }
  #tx(operation){this.#db.exec('BEGIN IMMEDIATE');try{const result=operation();this.#db.exec('COMMIT');return result;}catch(error){this.#db.exec('ROLLBACK');throw error;}}
  #settings() {
    const row=this.#db.prepare(`SELECT revision,read_enabled AS readEnabled,allow_learning AS allowLearning,publish_enabled AS publishEnabled,keywords_json AS keywordsJson,creator_ids_json AS creatorIdsJson,daily_read_limit AS dailyReadLimit,daily_model_limit AS dailyModelLimit,daily_session_limit AS dailySessionLimit,min_gap_seconds AS minGapSeconds,idle_seconds AS idleSeconds,account_id AS accountId FROM content_settings WHERE id=1`).get();
    return {revision:row.revision,readEnabled:Boolean(row.readEnabled),allowLearning:Boolean(row.allowLearning),publishEnabled:Boolean(row.publishEnabled),keywords:JSON.parse(row.keywordsJson),creatorIds:JSON.parse(row.creatorIdsJson),dailyReadLimit:row.dailyReadLimit,dailyModelLimit:row.dailyModelLimit,dailySessionLimit:row.dailySessionLimit,minGapSeconds:row.minGapSeconds,idleSeconds:row.idleSeconds,accountId:row.accountId??null};
  }
  /** 返回不含账号标签和外部正文的全 Agent 读取策略。 */
  settings(owner){this.#owner(owner);return this.#settings();}
  /** 策略或账号边界变化时撤销当前可分享资格；保留观察正文和已授权成长来源。 */
  #revokeShares(accountId) {
    if(!accountId)return 0;
    return this.#db.prepare("UPDATE content_observations SET revision=revision+1,share=0 WHERE account_id=? AND status='active' AND share=1").run(accountId).changes;
  }
  /** 用完整字段 CAS 替换读取策略；发布执行器未接入，true 始终拒绝。 */
  configure(owner,input) {
    this.#owner(owner);object(input,['expectedRevision','readEnabled','allowLearning','publishEnabled','keywords','creatorIds','dailyReadLimit','dailyModelLimit','dailySessionLimit','minGapSeconds','idleSeconds'],'内容配置');
    integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER,'配置修订');bool(input.readEnabled,'读取开关');bool(input.allowLearning,'学习开关');bool(input.publishEnabled,'发布开关');
    if(input.publishEnabled)throw new ContentError('真实发布尚未接入');
    const keywords=strings(input.keywords,{limit:20,max:100,label:'关键词'}),creatorIds=strings(input.creatorIds,{limit:20,max:200,label:'UP主标识'});
    integer(input.dailyReadLimit,0,DAILY_BUDGET.readMaximum,'每日读取额度');integer(input.dailyModelLimit,0,DAILY_BUDGET.modelCallMaximum,'每日模型额度');integer(input.dailySessionLimit,0,DAILY_BUDGET.sessionMaximum,'每日会话额度');integer(input.minGapSeconds,300,86400,'会话间隔');integer(input.idleSeconds,300,3600,'空闲时间');
    return this.#tx(()=>{
      const old=this.#settings();if(old.revision!==input.expectedRevision)throw new ContentError('内容配置已变化');
      const changed=old.readEnabled!==input.readEnabled||old.allowLearning!==input.allowLearning||JSON.stringify(old.keywords)!==JSON.stringify(keywords)||JSON.stringify(old.creatorIds)!==JSON.stringify(creatorIds)||old.dailyReadLimit!==input.dailyReadLimit||old.dailyModelLimit!==input.dailyModelLimit||old.dailySessionLimit!==input.dailySessionLimit||old.minGapSeconds!==input.minGapSeconds||old.idleSeconds!==input.idleSeconds;
      if(changed)this.#revokeShares(old.accountId);
      this.#db.prepare(`UPDATE content_settings SET revision=revision+1,read_enabled=?,allow_learning=?,publish_enabled=0,keywords_json=?,creator_ids_json=?,daily_read_limit=?,daily_model_limit=?,daily_session_limit=?,min_gap_seconds=?,idle_seconds=? WHERE id=1`).run(Number(input.readEnabled),Number(input.allowLearning),JSON.stringify(keywords),JSON.stringify(creatorIds),input.dailyReadLimit,input.dailyModelLimit,input.dailySessionLimit,input.minGapSeconds,input.idleSeconds);
      return this.#settings();
    });
  }
  /** 绑定可信 provider 返回的账号元数据；换号时保守关闭读取并失效旧工作。 */
  bindAccount(owner,input) {
    this.#owner(owner);object(input,['id','label'],'账号绑定');const id=text(input.id,200,'账号标识'),label=text(input.label,200,'账号标签');
    return this.#tx(()=>{const old=this.#db.prepare('SELECT account_id AS accountId,account_label AS accountLabel FROM content_settings WHERE id=1').get();if(old.accountId===id&&old.accountLabel===label)return this.#settings();const switched=old.accountId!==id;if(switched)this.#revokeShares(old.accountId);this.#db.prepare('UPDATE content_settings SET revision=revision+1,read_enabled=CASE WHEN ? THEN 0 ELSE read_enabled END,account_id=?,account_label=? WHERE id=1').run(Number(switched),id,label);return this.#settings();});
  }
  /** 账号库的同事务钩子：验证后安装或解除绑定，始终关闭读取，不触碰其他权限。 */
  installAccountInTransaction(owner,input){
    this.#owner(owner);let id=null,label=null;
    if(input!==null){object(input,['id','label'],'账号安装');id=text(input.id,200,'账号标识');label=text(input.label,200,'账号标签');}
    this.#revokeShares(this.#settings().accountId);
    this.#db.prepare('UPDATE content_settings SET revision=revision+1,read_enabled=0,account_id=?,account_label=? WHERE id=1').run(id,label);
    return this.#settings();
  }
  #expire() {this.#db.prepare(`UPDATE content_observations SET revision=revision+1,status='expired',title='',coverage_json='{"description":0,"subtitle":0,"comment":0}',summary='',viewpoint='',share=0,materials_json='[]' WHERE status='active' AND expires<=?`).run(this.#now());}
  #counts(now) {
    return {sessions:this.#db.prepare('SELECT count(*) AS n FROM content_runs WHERE created>=?').get(now-DAY).n,reads:this.#db.prepare('SELECT count(*) AS n FROM content_read_attempts WHERE created>=?').get(now-DAY).n,models:this.#db.prepare('SELECT count(*) AS n FROM content_model_attempts WHERE created>=?').get(now-DAY).n};
  }
  #feedbackRevision(scopeId,accountId) {
    return this.#db.prepare('SELECT revision FROM content_feedback_state WHERE scope_id=? AND account_id=?').get(scopeId,accountId)?.revision??0;
  }
  #due(known,now) {
    const policy=this.#settings(),counts=this.#counts(now);
    if(!policy.readEnabled||!policy.accountId||(!policy.keywords.length&&!policy.creatorIds.length)||policy.dailySessionLimit===0||policy.dailyReadLimit===0||policy.dailyModelLimit===0)return false;
    if(counts.sessions>=policy.dailySessionLimit||counts.reads>=policy.dailyReadLimit||counts.models>=policy.dailyModelLimit)return false;
    if(this.#db.prepare("SELECT 1 FROM content_runs WHERE status='claimed' LIMIT 1").get())return false;
    const last=this.#db.prepare('SELECT max(created) AS value FROM content_runs WHERE scope_id=?').get(known.id).value;
    return last===null||now-last>=policy.minGapSeconds*1000;
  }
  /** 只回答当前 owner scope 是否具备至少一次读取和模型尝试额度。 */
  next(scope){const known=this.#scope(scope);this.#expire();return this.#due(known,this.#now());}
  /** 声明一次浏览会话并冻结策略、成长开关与账号；claim 不能由 JSON 伪造。 */
  begin(scope,input) {
    const known=this.#scope(scope);object(input,['runId'],'浏览声明');const runId=text(input.runId,120,'浏览任务标识'),now=this.#now();
    return this.#tx(()=>{
      if(!this.#due(known,now))throw new ContentError('当前没有可运行的内容观察');
      const policy=this.#settings(),growth=this.#growth.turnPolicy();
      this.#db.prepare("INSERT INTO content_runs VALUES (?,?,?,?,?,?,'claimed',?,NULL,NULL)").run(runId,known.id,policy.accountId,policy.revision,growth.growthRevision,Number(growth.enabled),now);
      const claim=deepFreeze({runId,accountId:policy.accountId,feedbackRevision:this.#feedbackRevision(known.id,policy.accountId),policy:{...policy},growth:{growthRevision:growth.growthRevision,enabled:Boolean(growth.enabled)}});
      this.#claims.set(claim,{scopeId:known.id,runId});return claim;
    });
  }
  #claim(claim,scopeId) {const known=this.#claims.get(claim);if(!known||known.scopeId!==scopeId||known.runId!==claim.runId)throw new ContentError('内容观察任务无效');return known;}
  #assertCurrent(known,claim) {
    this.#claim(claim,known.id);
    const run=this.#db.prepare("SELECT status FROM content_runs WHERE run_id=? AND scope_id=?").get(claim.runId,known.id),policy=this.#settings(),growth=this.#growth.turnPolicy();
    if(!run||run.status!=='claimed')throw new ContentError('内容观察任务不再有效');
    if(!policy.readEnabled||policy.revision!==claim.policy.revision||policy.accountId!==claim.accountId)throw new ContentError('内容读取策略或账号已变化');
    if(this.#feedbackRevision(known.id,claim.accountId)!==claim.feedbackRevision)throw new ContentError('内容反馈已变化');
    if(growth.growthRevision!==claim.growth.growthRevision||Boolean(growth.enabled)!==claim.growth.enabled)throw new ContentError('角色成长配置已变化');
    return true;
  }
  /** 外部调用前复核 policy、账号、成长配置和 claim。 */
  assertCurrent(scope,claim){return this.#assertCurrent(this.#scope(scope),claim);}
  #reserve(scope,claim,value,{allowed,table,column,limitKey,label}) {
    const known=this.#scope(scope);if(!allowed.includes(value))throw new ContentError(label+'无效');
    return this.#tx(()=>{this.#assertCurrent(known,claim);if(this.#db.prepare(`SELECT 1 FROM ${table} WHERE run_id=? AND ${column}=?`).get(claim.runId,value))throw new ContentError(label+'阶段已预留');const policy=this.#settings(),used=this.#db.prepare(`SELECT count(*) AS n FROM ${table} WHERE created>=?`).get(this.#now()-DAY).n;if(used>=policy[limitKey])throw new ContentError(label+'额度已用完');this.#db.prepare(`INSERT INTO ${table}(run_id,scope_id,${column},created) VALUES (?,?,?,?)`).run(claim.runId,known.id,value,this.#now());return true;});
  }
  /** 在 provider 请求前永久预留一次读取尝试。 */
  reserveRead(scope,claim,operation){return this.#reserve(scope,claim,operation,{allowed:['discover','observe'],table:'content_read_attempts',column:'operation',limitKey:'dailyReadLimit',label:'读取'});}
  /** 在模型 create 前永久预留一次模型尝试。 */
  reserveModel(scope,claim,stage){return this.#reserve(scope,claim,stage,{allowed:['select','interpret'],table:'content_model_attempts',column:'stage',limitKey:'dailyModelLimit',label:'模型'});}
  #candidate(value,claim) {
    object(value,['bvid','title','creatorId','durationSeconds'],'候选');const bvid=text(value.bvid,12,'BV号');if(!BVID.test(bvid))throw new ContentError('BV号无效');
    const item={bvid,title:text(value.title,300,'标题'),creatorId:text(value.creatorId,200,'UP主标识'),durationSeconds:integer(value.durationSeconds,1,86400,'视频时长')};
    if(claim.policy.creatorIds.length&&!claim.policy.creatorIds.includes(item.creatorId))throw new ContentError('候选UP主不在读取范围');
    return item;
  }
  #materials(values,durationSeconds) {
    if(!Array.isArray(values)||values.length<1||values.length>20)throw new ContentError('观察材料数量无效');
    const ids=new Set(),items=values.map(value=>{object(value,['id','kind','text','startSeconds','endSeconds'],'观察材料');const id=text(value.id,100,'材料标识');if(ids.has(id))throw new ContentError('材料标识重复');ids.add(id);if(!['description','subtitle','comment'].includes(value.kind))throw new ContentError('材料类型无效');const item={id,kind:value.kind,text:text(value.text,6000,'材料正文')};const hasStart=value.startSeconds!==undefined,hasEnd=value.endSeconds!==undefined;if(hasStart!==hasEnd)throw new ContentError('材料时间范围无效');if(hasStart){if(!Number.isFinite(value.startSeconds)||!Number.isFinite(value.endSeconds)||value.startSeconds<0||value.endSeconds<value.startSeconds||value.endSeconds>durationSeconds)throw new ContentError('材料时间范围无效');item.startSeconds=value.startSeconds;item.endSeconds=value.endSeconds;}return item;});
    if(items.map(item=>item.text).join('\n').length>6000)throw new ContentError('观察材料总长度无效');return items;
  }
  #decision(value,materials) {
    if(value?.decision==='skip'){object(value,['decision'],'观察决定');return {decision:'skip'};}
    object(value,['decision','summary','viewpoint','evidenceIds','share'],'观察决定');if(value.decision!=='observe')throw new ContentError('观察决定无效');
    const item={decision:'observe',summary:text(value.summary,600,'观察摘要'),viewpoint:text(value.viewpoint,600,'观察观点'),share:bool(value.share,'分享决定')};
    const allowed=new Set(materials.map(row=>row.id));if(!Array.isArray(value.evidenceIds)||value.evidenceIds.length<1||value.evidenceIds.length>20||new Set(value.evidenceIds).size!==value.evidenceIds.length||value.evidenceIds.some(id=>!allowed.has(id)))throw new ContentError('观察证据无效');item.evidenceIds=[...value.evidenceIds];return item;
  }
  /** 原子保存观察；仅双开关快照均为 true 时调用成长库的 external 同事务入口。 */
  commit(scope,claim,input) {
    const known=this.#scope(scope);object(input,['candidate','materials','decision'],'观察提交');
    if(input.decision?.decision==='skip') {
      const decision=this.#decision(input.decision,[]);
      return this.#tx(()=>{this.#assertCurrent(known,claim);this.#db.prepare("UPDATE content_runs SET status='committed',finished=?,reason='skipped' WHERE run_id=? AND scope_id=? AND status='claimed'").run(this.#now(),claim.runId,known.id);return {outcome:decision.decision==='skip'?'skipped':'skipped'};});
    }
    const candidate=this.#candidate(input.candidate,claim),materials=this.#materials(input.materials,candidate.durationSeconds),decision=this.#decision(input.decision,materials),coverage={description:0,subtitle:0,comment:0};for(const item of materials)coverage[item.kind]++;
    const raw=materials.map(item=>item.text).join('\n'),now=this.#now(),observationId=randomUUID();
    return this.#tx(()=>{
      this.#assertCurrent(known,claim);
      if(this.#db.prepare('SELECT 1 FROM content_observations WHERE scope_id=? AND account_id=? AND bvid=?').get(known.id,claim.accountId,candidate.bvid)){
        this.#db.prepare("UPDATE content_runs SET status='committed',finished=?,reason='duplicate' WHERE run_id=? AND scope_id=? AND status='claimed'").run(this.#now(),claim.runId,known.id);
        return {outcome:'skipped'};
      }
      this.#db.prepare('INSERT INTO content_observations(id,scope_id,account_id,revision,status,bvid,title,creator_id,url,coverage_json,summary,viewpoint,share,materials_json,created,expires,learned) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(observationId,known.id,claim.accountId,0,'active',candidate.bvid,candidate.title,candidate.creatorId,'https://www.bilibili.com/video/'+candidate.bvid,JSON.stringify(coverage),decision.summary,decision.viewpoint,Number(decision.share),JSON.stringify(materials),now,now+DAY,0);
      const growth=this.#growth.acceptTurn(scope,{text:raw,origin:'external',learn:claim.policy.allowLearning,grow:claim.growth.enabled,eventKey:'content-observation:'+observationId,growthRevision:claim.growth.growthRevision});
      if(growth.saved){this.#db.prepare('INSERT INTO content_observation_sources VALUES (?,?)').run(observationId,growth.id);this.#db.prepare('UPDATE content_observations SET learned=1 WHERE id=?').run(observationId);}
      this.#db.prepare("UPDATE content_runs SET status='committed',finished=?,reason='observed' WHERE run_id=? AND scope_id=? AND status='claimed'").run(now,claim.runId,known.id);
      return {outcome:'observed',observationId};
    });
  }
  /** 终结已声明会话；已预留尝试不退款。 */
  interrupt(scope,claim,reason='interrupted') {
    const known=this.#scope(scope);this.#claim(claim,known.id);reason=text(reason,40,'终止原因');
    return this.#tx(()=>Boolean(this.#db.prepare("UPDATE content_runs SET status='interrupted',finished=?,reason=? WHERE run_id=? AND scope_id=? AND status='claimed'").run(this.#now(),reason,claim.runId,known.id).changes));
  }
  /** 重启后仅终结遗留 claim，不重试 provider 或模型调用。 */
  recoverInterrupted(scope) {const known=this.#scope(scope);return this.#tx(()=>this.#db.prepare("UPDATE content_runs SET status='interrupted',finished=?,reason='crashed' WHERE scope_id=? AND status='claimed'").run(this.#now(),known.id).changes);}
  /** 返回整个 Agent 尚未终结的浏览 claim 数量。 */
  activeRuns(){return this.#db.prepare("SELECT count(*) AS n FROM content_runs WHERE status='claimed'").get().n;}
  #cursor(scopeId,accountId,cursor) {if(cursor===undefined)return null;try{const [scope,account,created,rowId]=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(scope!==scopeId||account!==accountId||!Number.isSafeInteger(created)||!Number.isSafeInteger(rowId)||created<0||rowId<1)throw new Error();return {created,rowId};}catch{throw new ContentError('分页游标无效');}}
  #feedbackValues(scopeId,accountId,bvid,creatorId) {
    const rows=this.#db.prepare("SELECT target_scope AS targetScope,value FROM content_feedback WHERE scope_id=? AND account_id=? AND ((target_scope='content' AND target_id=?) OR (target_scope='creator' AND target_id=?))").all(scopeId,accountId,bvid,creatorId);
    const feedback={content:null,creator:null};for(const row of rows)feedback[row.targetScope]=row.value;return feedback;
  }
  #public(row,scopeId,accountId) {return {id:row.id,revision:row.revision,feedbackRevision:this.#feedbackRevision(scopeId,accountId),bvid:row.bvid,title:row.title,creatorId:row.creatorId,url:row.url,coverage:JSON.parse(row.coverageJson),summary:row.summary,viewpoint:row.viewpoint,share:Boolean(row.share),status:row.status,createdAt:row.createdAt,expiresAt:row.expiresAt,learned:Boolean(row.learned),feedback:this.#feedbackValues(scopeId,accountId,row.bvid,row.creatorId)};}
  /** 按当前账号分页列出观察；换号后不暴露旧账号条目。 */
  list(scope,{cursor,limit=20}={}) {
    const known=this.#scope(scope);integer(limit,1,50,'分页数量');this.#expire();const accountId=this.#settings().accountId;if(!accountId)return {entries:[],nextCursor:null};const anchor=this.#cursor(known.id,accountId,cursor);
    const select=`SELECT rowid AS rowId,id,revision,bvid,title,creator_id AS creatorId,url,coverage_json AS coverageJson,summary,viewpoint,share,status,created AS createdAt,expires AS expiresAt,learned FROM content_observations WHERE scope_id=? AND account_id=?${anchor?' AND (created<? OR (created=? AND rowid<?))':''} ORDER BY created DESC,rowid DESC LIMIT ?`;
    const rows=this.#db.prepare(select).all(known.id,accountId,...(anchor?[anchor.created,anchor.created,anchor.rowId]:[]),limit+1),page=rows.slice(0,limit),entries=page.map(row=>this.#public(row,known.id,accountId));
    const last=page.at(-1);return {entries,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify([known.id,accountId,last.createdAt,last.rowId])).toString('base64url'):null};
  }
  /** 读取当前账号单条观察详情；遗忘墓碑和其他 scope/账号不返回材料。 */
  get(scope,id) {
    const known=this.#scope(scope);id=text(id,100,'观察标识');this.#expire();const accountId=this.#settings().accountId;if(!accountId)return null;
    const row=this.#db.prepare(`SELECT id,revision,bvid,title,creator_id AS creatorId,url,coverage_json AS coverageJson,summary,viewpoint,share,status,materials_json AS materialsJson,created AS createdAt,expires AS expiresAt,learned FROM content_observations WHERE id=? AND scope_id=? AND account_id=? AND status!='forgotten'`).get(id,known.id,accountId);
    return row?{...this.#public(row,known.id,accountId),materials:JSON.parse(row.materialsJson)}:null;
  }
  /** 应用当前 Agent 的显式反馈：内容层优先于作者层，block 硬过滤，其余影响顺序并进入选择上下文。 */
  applyFeedback(scope,candidates) {
    const known=this.#scope(scope);if(!Array.isArray(candidates)||candidates.length>10)throw new ContentError('候选反馈输入无效');const accountId=this.#settings().accountId;if(!accountId)return {candidates:[...candidates],preferences:[],feedbackRevision:0};
    const mapped=candidates.map((candidate,index)=>{const bvid=text(candidate?.bvid,12,'候选BV号'),creatorId=text(candidate?.creatorId,200,'候选UP主'),feedback=this.#feedbackValues(known.id,accountId,bvid,creatorId),blocked=feedback.content==='block'||feedback.creator==='block',feedbackScope=blocked?(feedback.content==='block'?'content':'creator'):feedback.content?'content':feedback.creator?'creator':null,value=blocked?'block':feedbackScope?feedback[feedbackScope]:null;return {candidate,index,bvid,creatorId,feedbackScope,value};});
    const rank=value=>value==='like'?0:value==='less'?2:1,kept=mapped.filter(item=>item.value!=='block').sort((left,right)=>rank(left.value)-rank(right.value)||left.index-right.index);
    return {candidates:kept.map(item=>item.candidate),preferences:kept.filter(item=>item.value==='like'||item.value==='less').map(item=>({bvid:item.bvid,creatorId:item.creatorId,scope:item.feedbackScope,value:item.value})),feedbackRevision:this.#feedbackRevision(known.id,accountId)};
  }
  /** 对当前内容或作者保存主人反馈；独立代次 CAS 不改变观察及平台权限修订。 */
  feedback(scope,input) {
    const known=this.#scope(scope);object(input,['id','expectedRevision','expectedFeedbackRevision','scope','value'],'观察反馈');const id=text(input.id,100,'观察标识');integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER,'观察修订');integer(input.expectedFeedbackRevision,0,Number.MAX_SAFE_INTEGER,'反馈修订');if(!['content','creator'].includes(input.scope))throw new ContentError('反馈范围无效');if(input.value!==null&&!['like','less','block'].includes(input.value))throw new ContentError('反馈值无效');const accountId=this.#settings().accountId;if(!accountId)throw new ContentError('观察不存在或已遗忘');
    this.#tx(()=>{const row=this.#db.prepare("SELECT revision,status,bvid,creator_id AS creatorId FROM content_observations WHERE id=? AND scope_id=? AND account_id=?").get(id,known.id,accountId);if(!row||row.status==='forgotten')throw new ContentError('观察不存在或已遗忘');if(row.revision!==input.expectedRevision)throw new ContentError('观察已变化');const current=this.#feedbackRevision(known.id,accountId);if(current!==input.expectedFeedbackRevision)throw new ContentError('内容反馈已变化');const targetId=input.scope==='content'?row.bvid:row.creatorId;if(!targetId)throw new ContentError('观察作者不可用于反馈');if(input.value===null)this.#db.prepare('DELETE FROM content_feedback WHERE scope_id=? AND account_id=? AND target_scope=? AND target_id=?').run(known.id,accountId,input.scope,targetId);else this.#db.prepare(`INSERT INTO content_feedback(scope_id,account_id,target_scope,target_id,value,source_observation_id,updated) VALUES (?,?,?,?,?,?,?) ON CONFLICT(scope_id,account_id,target_scope,target_id) DO UPDATE SET value=excluded.value,source_observation_id=excluded.source_observation_id,updated=excluded.updated`).run(known.id,accountId,input.scope,targetId,input.value,id,this.#now());this.#db.prepare(`INSERT INTO content_feedback_state(scope_id,account_id,revision) VALUES (?,?,1) ON CONFLICT(scope_id,account_id) DO UPDATE SET revision=revision+1`).run(known.id,accountId);});
    return this.get(scope,id);
  }
  /** 返回当前账号已观察的稳定 BV 号；包含 expired 与 forgotten 墓碑以阻止自动复活。 */
  seenBvids(scope) {
    const known=this.#scope(scope),accountId=this.#settings().accountId;
    if(!accountId)return [];
    return this.#db.prepare('SELECT bvid FROM content_observations WHERE scope_id=? AND account_id=? ORDER BY created,rowid').all(known.id,accountId).map(row=>row.bvid);
  }
  #excerpt(row) {const coverage=JSON.stringify(JSON.parse(row.coverageJson));return `[外部来源：哔哩哔哩]\nURL: ${row.url}\n覆盖: ${coverage}\n摘要: ${row.summary}\n观点: ${row.viewpoint}`;}
  /** 精确读取一个仍可分享的观察，供延迟计划重新验证。 */
  sharingRead(scope,id,revision) {
    const known=this.#scope(scope);id=text(id,100,'观察标识');integer(revision,0,Number.MAX_SAFE_INTEGER,'观察修订');this.#expire();const policy=this.#settings();if(!policy.readEnabled||!policy.accountId)return null;
    const row=this.#db.prepare(`SELECT id,revision,url,coverage_json AS coverageJson,summary,viewpoint FROM content_observations WHERE id=? AND scope_id=? AND account_id=? AND revision=? AND status='active' AND share=1 AND expires>?`).get(id,known.id,policy.accountId,revision,this.#now());
    return row?{id:row.id,revision:row.revision,excerpt:this.#excerpt(row)}:null;
  }
  /** 列出当前账号所有仍可分享的有限外部来源标注。 */
  sharingCandidates(scope) {
    const known=this.#scope(scope);this.#expire();const policy=this.#settings();if(!policy.readEnabled||!policy.accountId)return [];
    return this.#db.prepare(`SELECT id,revision,url,coverage_json AS coverageJson,summary,viewpoint FROM content_observations WHERE scope_id=? AND account_id=? AND status='active' AND share=1 AND expires>? ORDER BY created,rowid`).all(known.id,policy.accountId,this.#now()).map(row=>({id:row.id,revision:row.revision,excerpt:this.#excerpt(row)}));
  }
  /** 只复用精确分享读取的当前性判断。 */
  sharingValid(scope,id,revision){return this.sharingRead(scope,id,revision)!==null;}
  /** 返回成长来源对应的稳定观察根，不跨 capability 泄露。 */
  sourceObservation(scope,sourceId) {const known=this.#scope(scope);sourceId=text(sourceId,100,'成长来源标识');const row=this.#db.prepare(`SELECT o.id,o.revision FROM content_observation_sources x JOIN content_observations o ON o.id=x.observation_id WHERE x.source_id=? AND o.scope_id=?`).get(sourceId,known.id);return row??null;}
  /** 普通来源始终允许；观察成长来源只有当前可分享时才允许用于主动分享。 */
  linkedSourceAllowed(scope,sourceId) {const linked=this.sourceObservation(scope,sourceId);return linked===null||this.sharingValid(scope,linked.id,linked.revision);}
  /** 判断当前 scope 是否曾有观察，遗忘和换号不重置历史。 */
  hasHistory(scope){const known=this.#scope(scope);return Boolean(this.#db.prepare('SELECT 1 FROM content_observations WHERE scope_id=? LIMIT 1').get(known.id));}
  /** 显式遗忘观察正文，并在同一 SQLite 事务撤销映射成长来源及派生状态。 */
  forget(scope,input) {
    const known=this.#scope(scope);object(input,['id','expectedRevision'],'观察遗忘');const id=text(input.id,100,'观察标识');integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER,'观察修订');const accountId=this.#settings().accountId;
    return this.#tx(()=>{
      const row=this.#db.prepare('SELECT revision,status FROM content_observations WHERE id=? AND scope_id=? AND account_id=?').get(id,known.id,accountId);if(!row)return {forgotten:false};if(row.revision!==input.expectedRevision)throw new ContentError('观察已变化');if(row.status==='forgotten')return {forgotten:false};
      this.#db.prepare(`UPDATE content_observations SET revision=revision+1,status='forgotten',title='',coverage_json='{"description":0,"subtitle":0,"comment":0}',summary='',viewpoint='',share=0,materials_json='[]' WHERE id=?`).run(id);
      const removed=this.#db.prepare('DELETE FROM content_feedback WHERE scope_id=? AND account_id=? AND source_observation_id=?').run(known.id,accountId,id).changes;
      if(removed)this.#db.prepare(`INSERT INTO content_feedback_state(scope_id,account_id,revision) VALUES (?,?,1) ON CONFLICT(scope_id,account_id) DO UPDATE SET revision=revision+1`).run(known.id,accountId);
      for(const source of this.#db.prepare('SELECT source_id AS id FROM content_observation_sources WHERE observation_id=?').all(id))this.#growth.invalidateExternalSource(this.#growthAuthority,known.id,source.id);
      return {forgotten:true};
    });
  }
}
