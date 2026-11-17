import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {DAILY_BUDGET,budgetSummary} from './daily-budget.mjs';
import {AGENT_ROLE_FIELDS,AgentError,exactFields,validateAgentRoleFields,validateBoundedAgentText} from './agent-role-fields.mjs';
export {AgentError,exactFields} from './agent-role-fields.mjs';
const profileKeys=['name','nickname','persona','model','dialogueModel','dialogueReasoningEffort'];
const roleProfileKeys=AGENT_ROLE_FIELDS.filter(key=>!['name','nickname','persona'].includes(key));
const optionalProfile=['reflectionModel','reflectionReasoningEffort',...roleProfileKeys];
/** 模型句柄上限包含53字符连接ID、分隔符和最多300字符的模型ID。 */
const MODEL_HANDLE_LIMIT=354;
const efforts=new Set(['none','minimal','low','medium','high','xhigh','max']);
/** 主人配置中的模型与角色合同；更新省略新增角色字段时保留旧值。 */
function profile(input,updating=false,previous=null){
  exactFields(input,updating?[...profileKeys,'expectedRevision']:profileKeys,optionalProfile);
  if(updating&&(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0))throw new AgentError('Agent修订无效');
  if(!efforts.has(input.dialogueReasoningEffort)||input.reflectionReasoningEffort!=null&&!efforts.has(input.reflectionReasoningEffort))throw new AgentError('推理档位无效');
  const roleInput={name:input.name,nickname:input.nickname,persona:input.persona};
  for(const key of roleProfileKeys)if(Object.hasOwn(input,key))roleInput[key]=input[key];else if(updating)roleInput[key]=previous[key];
  const roles=validateAgentRoleFields(roleInput);
  return {...roles,model:validateBoundedAgentText(input.model,MODEL_HANDLE_LIMIT,'提取模型'),dialogueModel:validateBoundedAgentText(input.dialogueModel,MODEL_HANDLE_LIMIT,'对话模型'),dialogueReasoningEffort:input.dialogueReasoningEffort,reflectionModel:input.reflectionModel==null?null:validateBoundedAgentText(input.reflectionModel,MODEL_HANDLE_LIMIT,'反思模型'),reflectionReasoningEffort:input.reflectionReasoningEffort??null};
}
/** 从SQLite行生成无路径、无凭据的Agent描述符。 */
function publicAgent(row){if(!row)throw new AgentError('Agent不存在','NOT_FOUND');const stored=JSON.parse(row.profile);for(const key of roleProfileKeys){if(!Object.hasOwn(stored,key))stored[key]='';else if(typeof stored[key]!=='string')throw new AgentError('Agent角色配置无效');}return {id:row.id,...stored,profileRevision:row.revision,archived:Boolean(row.archived),paused:Boolean(row.paused),legacy:Boolean(row.legacy)};}
/** 应用级唯一写入权威；各Agent的事实、成长和动作授权仍由各自私有库持有。 */
export class AgentRegistry {
  #db;#owner=Object.freeze(Object.create(null));#issued=false;#now;#identity;#alive;#instance=randomUUID();#closed=false;
  constructor(filename,{legacy,now=Date.now,identity={pid:process.pid,start:null},isAlive=()=>true,initialPaused=false}={}) {
    mkdirSync(path.dirname(path.resolve(filename)),{recursive:true,mode:0o700});
    this.#db=new DatabaseSync(filename);if(process.platform!=='win32')chmodSync(filename,0o600);
    this.#now=now;this.#identity=identity;this.#alive=isAlive;
    this.#db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS application_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,daily_limit INTEGER NOT NULL DEFAULT 2,min_gap INTEGER NOT NULL DEFAULT 1800,last_activity INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO application_state(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,profile TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,legacy INTEGER NOT NULL DEFAULT 0,last_reflection INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS model_configuration_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO model_configuration_state(id) VALUES(1);
      CREATE UNIQUE INDEX IF NOT EXISTS one_legacy_agent ON agents(legacy) WHERE legacy=1;
      CREATE TABLE IF NOT EXISTS model_slot(id INTEGER PRIMARY KEY CHECK(id=1),task_id TEXT UNIQUE NOT NULL,agent_id TEXT NOT NULL REFERENCES agents(id),kind TEXT NOT NULL,pid INTEGER NOT NULL,process_start TEXT,instance TEXT NOT NULL,cancelled INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reflection_reservations(run_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduler_leader(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,process_start TEXT,instance TEXT NOT NULL);
    `);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS proactive_call_reservations(run_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS contact_deliveries(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,scope_id TEXT,created INTEGER NOT NULL,status TEXT NOT NULL);`);
    const applicationColumns=new Set(this.#db.prepare('PRAGMA table_info(application_state)').all().map(row=>row.name));
    if(!applicationColumns.has('background_limit')){this.#db.exec('ALTER TABLE application_state ADD COLUMN background_limit INTEGER NOT NULL DEFAULT 6');this.#db.exec('UPDATE application_state SET background_limit=max(background_limit,daily_limit)');}
    if(!applicationColumns.has('proactive_message_limit'))this.#db.exec('ALTER TABLE application_state ADD COLUMN proactive_message_limit INTEGER NOT NULL DEFAULT 2');
    for(const [column,definition]of [['keep_running','INTEGER NOT NULL DEFAULT 0'],['total_model_limit','INTEGER'],['dialogue_model_limit','INTEGER']])if(!applicationColumns.has(column))this.#db.exec('ALTER TABLE application_state ADD COLUMN '+column+' '+definition);
    this.#db.exec('CREATE TABLE IF NOT EXISTS dialogue_call_reservations(run_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,created INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS dialogue_reservation_time ON dialogue_call_reservations(created); CREATE INDEX IF NOT EXISTS background_reservation_time ON proactive_call_reservations(created); CREATE INDEX IF NOT EXISTS reflection_reservation_time ON reflection_reservations(created);');
    const slotColumns=new Set(this.#db.prepare('PRAGMA table_info(model_slot)').all().map(row=>row.name));
    for(const column of ['scope_id','contact_id'])if(!slotColumns.has(column))this.#db.exec('ALTER TABLE model_slot ADD COLUMN '+column+' TEXT');
    this.#transaction(()=>{if(!this.#db.prepare('SELECT id FROM agents WHERE legacy=1').get()){const value=profile(legacy);this.#db.prepare('INSERT INTO agents(id,profile,legacy) VALUES(?,?,1)').run(randomUUID(),JSON.stringify(value));this.#db.prepare('UPDATE application_state SET paused=?,last_activity=? WHERE id=1').run(initialPaused?1:0,this.#now());}});
  }
  /** 只有宿主初始化时可领取一次管理能力，无法通过JSON伪造。 */
  ownerAuthority(){if(this.#issued)throw new AgentError('管理能力已领取');this.#issued=true;return this.#owner;}
  #authorize(owner){if(owner!==this.#owner)throw new AgentError('缺少主人管理能力','FORBIDDEN');}
  #transaction(operation){this.#db.exec('BEGIN IMMEDIATE');try{const result=operation();if(result&&typeof result.then==='function')throw new AgentError('管理事务不能等待异步操作');this.#db.exec('COMMIT');return result;}catch(error){this.#db.exec('ROLLBACK');throw error;}}
  #row(id){if(typeof id!=='string'||!id)throw new AgentError('Agent标识无效');return this.#db.prepare('SELECT * FROM agents WHERE id=?').get(id);}
  #writable(id){const a=publicAgent(this.#row(id));if(a.archived)throw new AgentError('Agent已归档','ARCHIVED');if(a.paused||this.#db.prepare('SELECT paused FROM application_state WHERE id=1').get().paused)throw new AgentError('当前已暂停','PAUSED');return a;}
  #slot(){const row=this.#db.prepare('SELECT * FROM model_slot WHERE id=1').get();if(row&&!this.#alive({pid:row.pid,start:row.process_start})){if(row.kind==='model_connection'){this.#db.prepare('DELETE FROM model_slot WHERE task_id=?').run(row.task_id);this.#db.exec('UPDATE model_configuration_state SET revision=revision+1 WHERE id=1');return null;}this.#db.prepare("UPDATE model_slot SET kind='recovery_pending',cancelled=1 WHERE task_id=?").run(row.task_id);return {...row,kind:'recovery_pending',cancelled:1};}return row??null;}
  /** 模型配置代次不含秘密；异步目录验证须在提交Agent配置时核对同一代次。 */
  modelConfigurationRevision(owner){this.#authorize(owner);return this.#db.prepare('SELECT revision FROM model_configuration_state WHERE id=1').get().revision;}
  /** 原生凭据文件与Agent库之间用既有全局槽封锁新绑定，不跨数据库伪造事务。 */
  #modelConfigurationGuard(expected){if(this.#slot()?.kind==='model_connection')throw new AgentError('模型连接正在更新','BUSY');if(expected!==undefined&&expected!==this.#db.prepare('SELECT revision FROM model_configuration_state WHERE id=1').get().revision)throw new AgentError('模型连接已变化，请重新选择','CONFLICT');}
  list(owner){this.#authorize(owner);return this.#db.prepare('SELECT * FROM agents ORDER BY legacy DESC,rowid').all().map(publicAgent);}
  get(owner,id){this.#authorize(owner);return publicAgent(this.#row(id));}
  legacyId(owner){this.#authorize(owner);return this.#db.prepare('SELECT id FROM agents WHERE legacy=1').get().id;}
  create(owner,input,{expectedModelRevision}={}){this.#authorize(owner);const value=profile(input);return this.#transaction(()=>{this.#modelConfigurationGuard(expectedModelRevision);const id=randomUUID();this.#db.prepare('INSERT INTO agents(id,profile) VALUES(?,?)').run(id,JSON.stringify(value));return publicAgent(this.#row(id));});}
  update(owner,id,input,{expectedModelRevision}={}){this.#authorize(owner);return this.#transaction(()=>{this.#modelConfigurationGuard(expectedModelRevision);const old=publicAgent(this.#row(id));if(old.profileRevision!==input.expectedRevision)throw new AgentError('Agent配置已变化','CONFLICT');const value=profile(input,true,old);this.#db.prepare('UPDATE agents SET profile=?,revision=revision+1 WHERE id=?').run(JSON.stringify(value),id);this.#db.prepare('UPDATE model_slot SET cancelled=1 WHERE agent_id=?').run(id);return publicAgent(this.#row(id));});}
  #flag(owner,id,expectedRevision,key,value){this.#authorize(owner);if(typeof value!=='boolean'||!Number.isSafeInteger(expectedRevision))throw new AgentError('Agent状态配置无效');return this.#transaction(()=>{const a=publicAgent(this.#row(id));if(a.profileRevision!==expectedRevision)throw new AgentError('Agent配置已变化','CONFLICT');this.#db.prepare(`UPDATE agents SET ${key}=?,revision=revision+1 WHERE id=?`).run(value?1:0,id);this.#db.prepare('UPDATE model_slot SET cancelled=1 WHERE agent_id=?').run(id);return publicAgent(this.#row(id));});}
  archive(owner,id,expectedRevision,archived){return this.#flag(owner,id,expectedRevision,'archived',archived);}
  pause(owner,id,expectedRevision,paused){return this.#flag(owner,id,expectedRevision,'paused',paused);}
  /** 全局暂停不能被任何Agent局部恢复覆盖。 */
  setPaused(owner,paused){this.#authorize(owner);if(typeof paused!=='boolean')throw new AgentError('暂停参数无效');return this.#transaction(()=>{this.#db.prepare('UPDATE application_state SET paused=?,revision=revision+1 WHERE id=1').run(paused?1:0);if(paused)this.#db.prepare('UPDATE model_slot SET cancelled=1').run();return this.#snapshot();});}
  /** 主人后台总额与反思子额度；旧调用省略新增字段时保留已有值。 */
  configure(owner,input){
    this.#authorize(owner);exactFields(input,['expectedRevision','reflectionDailyCallLimit','minGapSeconds'],['backgroundDailyCallLimit','proactiveDailyMessageLimit','dailyModelCallLimit','dialogueDailyCallLimit','keepRunningOnClose']);
    if(!Number.isSafeInteger(input.expectedRevision)||!Number.isInteger(input.reflectionDailyCallLimit)||input.reflectionDailyCallLimit<0||input.reflectionDailyCallLimit>DAILY_BUDGET.modelCallMaximum||!Number.isInteger(input.minGapSeconds)||input.minGapSeconds<1800||input.minGapSeconds>86400)throw new AgentError('应用配置无效');
    for(const [field,max]of[['backgroundDailyCallLimit',DAILY_BUDGET.modelCallMaximum],['proactiveDailyMessageLimit',DAILY_BUDGET.messageMaximum]])if(Object.hasOwn(input,field)&&(!Number.isInteger(input[field])||input[field]<0||input[field]>max))throw new AgentError('应用额度无效');
    for(const field of ['dailyModelCallLimit','dialogueDailyCallLimit'])if(Object.hasOwn(input,field)&&input[field]!==null&&(!Number.isInteger(input[field])||input[field]<0||input[field]>DAILY_BUDGET.modelCallMaximum))throw new AgentError('应用额度无效');
    if(Object.hasOwn(input,'keepRunningOnClose')&&typeof input.keepRunningOnClose!=='boolean')throw new AgentError('后台运行设置无效');
    return this.#transaction(()=>{const state=this.#db.prepare('SELECT * FROM application_state WHERE id=1').get();if(state.revision!==input.expectedRevision)throw new AgentError('应用配置已变化','CONFLICT');
      this.#db.prepare('UPDATE application_state SET daily_limit=?,min_gap=?,background_limit=?,proactive_message_limit=?,revision=revision+1 WHERE id=1').run(input.reflectionDailyCallLimit,input.minGapSeconds,input.backgroundDailyCallLimit??state.background_limit,input.proactiveDailyMessageLimit??state.proactive_message_limit);
      this.#db.prepare('UPDATE application_state SET keep_running=?,total_model_limit=?,dialogue_model_limit=? WHERE id=1').run(Object.hasOwn(input,'keepRunningOnClose')?Number(input.keepRunningOnClose):state.keep_running,Object.hasOwn(input,'dailyModelCallLimit')?input.dailyModelCallLimit:state.total_model_limit,Object.hasOwn(input,'dialogueDailyCallLimit')?input.dialogueDailyCallLimit:state.dialogue_model_limit);
      this.#db.prepare("UPDATE model_slot SET cancelled=1 WHERE kind IN ('reflection','proactive_plan','proactive_contact','content_browse')").run();return this.#snapshot();});
  }
  #snapshot(){const a=this.#db.prepare('SELECT * FROM application_state WHERE id=1').get(),slot=this.#slot();return {revision:a.revision,paused:Boolean(a.paused),reflectionDailyCallLimit:a.daily_limit,backgroundDailyCallLimit:a.background_limit,proactiveDailyMessageLimit:a.proactive_message_limit,dailyModelCallLimit:a.total_model_limit,dialogueDailyCallLimit:a.dialogue_model_limit,keepRunningOnClose:Boolean(a.keep_running),budgets:this.#budgets(a),minGapSeconds:a.min_gap,lastActivity:a.last_activity,busy:Boolean(slot),active:slot?{agentId:slot.agent_id,taskId:slot.task_id,kind:slot.kind,contactId:slot.contact_id}:null};}
  #budgets(a){const now=this.#now(),times=table=>this.#db.prepare('SELECT created FROM '+table+' WHERE created>?').all(now-DAILY_BUDGET.windowMilliseconds).map(row=>row.created),reflection=times('reflection_reservations'),background=[...reflection,...times('proactive_call_reservations')],dialogue=times('dialogue_call_reservations');return {total:budgetSummary(a.total_model_limit,[...background,...dialogue],now),dialogue:budgetSummary(a.dialogue_model_limit,dialogue,now),background:budgetSummary(a.background_limit,background,now),reflection:budgetSummary(a.daily_limit,reflection,now),proactiveMessages:budgetSummary(a.proactive_message_limit,times('contact_deliveries'),now)};}
  #totalAvailable(){const a=this.#db.prepare('SELECT * FROM application_state WHERE id=1').get();if(a.total_model_limit!==null&&this.#budgets(a).total.remaining===0)throw new AgentError('应用模型总额度已用完','BUDGET');}
  /** 聊天回答和可选学习提取各预留一个业务阶段；失败不返还，旧聊天历史不追溯收费。 */
  reserveDialogueCall(owner,taskId,stage){this.#authorize(owner);if(!['extract','dialogue'].includes(stage))throw new AgentError('聊天模型阶段无效');return this.#transaction(()=>{const slot=this.#db.prepare("SELECT * FROM model_slot WHERE task_id=? AND instance=? AND kind='dialogue'").get(taskId,this.#instance);if(!slot||slot.cancelled)throw new AgentError('聊天任务已取消','CANCELLED');this.#writable(slot.agent_id);const runId=taskId+':'+stage;if(this.#db.prepare('SELECT run_id FROM dialogue_call_reservations WHERE run_id=?').get(runId))return {runId};this.#totalAvailable();const a=this.#db.prepare('SELECT * FROM application_state WHERE id=1').get();if(a.dialogue_model_limit!==null&&this.#budgets(a).dialogue.remaining===0)throw new AgentError('聊天模型子额度已用完','BUDGET');this.#db.prepare('INSERT INTO dialogue_call_reservations VALUES(?,?,?)').run(runId,slot.agent_id,this.#now());return {runId};});}
  snapshot(owner){this.#authorize(owner);return this.#transaction(()=>this.#snapshot());}
  activity(owner){this.#authorize(owner);this.#db.prepare('UPDATE application_state SET last_activity=? WHERE id=1').run(this.#now());return {recorded:true};}
  /** 应用单模型槽：进程仍可能存活时不因超时抢占，fence为每次新taskId。 */
  claim(owner,agentId,kind,{scopeId=null,contactId=null}={}){this.#authorize(owner);if(!['dialogue','reflection','proactive_plan','proactive_contact','content_browse','platform_bind','platform_read','qq_bind','qq_receive','qq_lookup','qq_draft','qq_send','recovery','model_connection'].includes(kind))throw new AgentError('任务类型无效');return this.#transaction(()=>{if(kind==='recovery'||kind==='model_connection')publicAgent(this.#row(agentId));else this.#writable(agentId);const previous=this.#slot();if(previous){if(kind==='recovery'&&previous.kind==='recovery_pending'&&previous.agent_id===agentId&&previous.scope_id===scopeId)this.#db.prepare('DELETE FROM model_slot WHERE task_id=?').run(previous.task_id);else throw new AgentError(previous.kind==='recovery_pending'?'有待清理的原生会话，请先恢复':'已有会话正在运行','BUSY');}const taskId=randomUUID();this.#db.prepare('INSERT INTO model_slot(id,task_id,agent_id,kind,pid,process_start,instance,created,scope_id,contact_id) VALUES(1,?,?,?,?,?,?,?,?,?)').run(taskId,agentId,kind,this.#identity.pid,this.#identity.start,this.#instance,this.#now(),scopeId,contactId);return {taskId,agentId,kind};});}
  cancel(owner,agentId,taskId){this.#authorize(owner);this.get(owner,agentId);if(typeof taskId!=='string')throw new AgentError('任务标识无效');return this.#db.prepare('UPDATE model_slot SET cancelled=1 WHERE agent_id=? AND task_id=?').run(agentId,taskId).changes===1;}
  cancelled(owner,taskId){this.#authorize(owner);const row=this.#db.prepare('SELECT cancelled FROM model_slot WHERE task_id=? AND instance=?').get(taskId,this.#instance);return !row||Boolean(row.cancelled);}
  release(owner,taskId,{modelConfigurationChanged=true}={}){this.#authorize(owner);return this.#transaction(()=>{const slot=this.#db.prepare('SELECT kind FROM model_slot WHERE task_id=? AND instance=?').get(taskId,this.#instance);this.#db.prepare('DELETE FROM model_slot WHERE task_id=? AND instance=?').run(taskId,this.#instance);if(slot?.kind==='model_connection'&&modelConfigurationChanged)this.#db.exec('UPDATE model_configuration_state SET revision=revision+1 WHERE id=1');});}
  /** 原生清理未确认时保留全局槽，避免另一个Agent继续占用未知的模型运行。 */
  retainForRecovery(owner,taskId){this.#authorize(owner);this.#db.prepare("UPDATE model_slot SET kind='recovery_pending',cancelled=1 WHERE task_id=? AND instance=?").run(taskId,this.#instance);}
  /** 同步提交门；持应用库写锁检查有效身份/版本/暂停/任务，回调只能做有界本地事务。 */
  guard(owner,id,expectedRevision,operation,{taskId,allowPaused=false,allowArchived=false}={}){this.#authorize(owner);return this.#transaction(()=>{const a=publicAgent(this.#row(id));if(a.archived&&!allowArchived)throw new AgentError('Agent已归档','ARCHIVED');if(!allowPaused&&(a.paused||this.#db.prepare('SELECT paused FROM application_state WHERE id=1').get().paused))throw new AgentError('当前已暂停','PAUSED');if(a.profileRevision!==expectedRevision)throw new AgentError('Agent配置已变化','CONFLICT');if(taskId){const slot=this.#db.prepare('SELECT * FROM model_slot WHERE task_id=? AND agent_id=? AND instance=?').get(taskId,id,this.#instance);if(!slot)throw new AgentError('任务已失效','STALE');if(slot.cancelled)throw new AgentError('任务已取消','CANCELLED');}return operation();});}
  /** 总调用额度提前预留，失败不退款；与Agent库不假设分布式事务。 */
  reserveReflection(owner,taskId){this.#authorize(owner);return this.#transaction(()=>{const slot=this.#db.prepare("SELECT * FROM model_slot WHERE task_id=? AND instance=? AND kind='reflection'").get(taskId,this.#instance);if(!slot||slot.cancelled)throw new AgentError('反思任务已取消');this.#writable(slot.agent_id);if(this.#db.prepare('SELECT run_id FROM reflection_reservations WHERE run_id=?').get(taskId))return true;const now=this.#now(),a=this.#db.prepare('SELECT * FROM application_state WHERE id=1').get();this.#backgroundAvailable(now,a.background_limit);const count=this.#db.prepare('SELECT count(*) AS count FROM reflection_reservations WHERE created>?').get(now-86400000).count;const latest=this.#db.prepare('SELECT max(created) AS latest FROM reflection_reservations').get().latest;if(count>=a.daily_limit)throw new AgentError('应用反思额度已用完','BUDGET');if(latest!==null&&now-latest<a.min_gap*1000)throw new AgentError('尚未达到应用反思间隔','COOLDOWN');this.#db.prepare('INSERT INTO reflection_reservations VALUES(?,?,?)').run(taskId,slot.agent_id,now);this.#db.prepare('UPDATE agents SET last_reflection=? WHERE id=?').run(now,slot.agent_id);return true;});}
  #backgroundAvailable(now,limit){this.#totalAvailable();const used=this.#db.prepare('SELECT (SELECT count(*) FROM reflection_reservations WHERE created>?)+(SELECT count(*) FROM proactive_call_reservations WHERE created>?) AS count').get(now-86400000,now-86400000).count;if(used>=limit)throw new AgentError('后台模型总额度已用完','BUDGET');}
  /** 主动规划/联系提前预留应用调用额度，不改旧反思表格式，失败不退款。 */
  reserveProactiveCall(owner,taskId){this.#authorize(owner);return this.#transaction(()=>{
    const slot=this.#db.prepare("SELECT * FROM model_slot WHERE task_id=? AND instance=? AND kind IN ('proactive_plan','proactive_contact')").get(taskId,this.#instance);if(!slot||slot.cancelled)throw new AgentError('主动任务已取消','CANCELLED');this.#writable(slot.agent_id);
    if(this.#db.prepare('SELECT run_id FROM proactive_call_reservations WHERE run_id=?').get(taskId))return true;
    const now=this.#now(),limit=this.#db.prepare('SELECT background_limit FROM application_state WHERE id=1').get().background_limit;this.#backgroundAvailable(now,limit);
    this.#db.prepare('INSERT INTO proactive_call_reservations VALUES(?,?,?)').run(taskId,slot.agent_id,now);this.#db.prepare('UPDATE agents SET last_reflection=? WHERE id=?').run(now,slot.agent_id);return true;
  });}
  /** 内容选择和理解分别计入共享后台预算；阶段名固定，不能伪造任意调用标识。 */
  reserveContentCall(owner,taskId,stage){this.#authorize(owner);if(!['select','interpret'].includes(stage))throw new AgentError('内容调用阶段无效');return this.#transaction(()=>{
    const slot=this.#db.prepare("SELECT * FROM model_slot WHERE task_id=? AND instance=? AND kind='content_browse'").get(taskId,this.#instance);
    if(!slot||slot.cancelled)throw new AgentError('内容任务已取消','CANCELLED');this.#writable(slot.agent_id);
    const runId=taskId+':'+stage;if(this.#db.prepare('SELECT run_id FROM proactive_call_reservations WHERE run_id=?').get(runId))return {runId};
    const now=this.#now(),limit=this.#db.prepare('SELECT background_limit FROM application_state WHERE id=1').get().background_limit;this.#backgroundAvailable(now,limit);
    this.#db.prepare('INSERT INTO proactive_call_reservations VALUES(?,?,?)').run(runId,slot.agent_id,now);this.#db.prepare('UPDATE agents SET last_reflection=? WHERE id=?').run(now,slot.agent_id);return {runId};
  });}
  /** QQ草稿每个模型阶段分别预留共享后台额度，阶段和任务归属固定。 */
  reserveQQReplyCall(owner,taskId,stage){this.#authorize(owner);if(!['extract','draft'].includes(stage))throw new AgentError('QQ模型阶段无效');return this.#transaction(()=>{
    const slot=this.#db.prepare("SELECT * FROM model_slot WHERE task_id=? AND instance=? AND kind='qq_draft'").get(taskId,this.#instance);
    if(!slot||slot.cancelled)throw new AgentError('QQ草稿任务已取消','CANCELLED');this.#writable(slot.agent_id);
    const runId=taskId+':'+stage;if(this.#db.prepare('SELECT run_id FROM proactive_call_reservations WHERE run_id=?').get(runId))return {runId};
    const now=this.#now(),limit=this.#db.prepare('SELECT background_limit FROM application_state WHERE id=1').get().background_limit;this.#backgroundAvailable(now,limit);
    this.#db.prepare('INSERT INTO proactive_call_reservations VALUES(?,?,?)').run(runId,slot.agent_id,now);return {runId};
  });}
  /** 全局消息预留先落库：崩溃时宁多计额度，不允许并发突破未读上限。 */
  reserveContact(owner,taskId,id){this.#authorize(owner);return this.#transaction(()=>{
    const slot=this.#db.prepare("SELECT * FROM model_slot WHERE task_id=? AND instance=? AND kind='proactive_contact'").get(taskId,this.#instance);
    if(!slot||slot.cancelled||id!==taskId)throw new AgentError('主动投递任务已取消或标识无效','CANCELLED');this.#writable(slot.agent_id);
    if(this.#db.prepare('SELECT id FROM contact_deliveries WHERE id=? AND agent_id=?').get(id,slot.agent_id))return true;
    const state=this.#db.prepare('SELECT proactive_message_limit FROM application_state WHERE id=1').get(),used=this.#db.prepare('SELECT count(*) AS count FROM contact_deliveries WHERE created>?').get(this.#now()-86400000).count;
    if(used>=state.proactive_message_limit)throw new AgentError('主动消息总额度已用完','BUDGET');
    if(this.#db.prepare("SELECT id FROM contact_deliveries WHERE status IN ('reserved','delivered') LIMIT 1").get())throw new AgentError('还有未读主动消息','UNREAD');
    this.#db.prepare("INSERT INTO contact_deliveries VALUES(?,?,?,?,'reserved')").run(id,slot.agent_id,slot.scope_id,this.#now());return true;
  });}
  /** 非消耗性检查，用于唤醒前避免在未读阻塞时调用模型。 */
  contactAvailable(owner){this.#authorize(owner);const state=this.#db.prepare('SELECT paused,proactive_message_limit FROM application_state WHERE id=1').get();if(state.paused)return false;const used=this.#db.prepare('SELECT count(*) AS count FROM contact_deliveries WHERE created>?').get(this.#now()-86400000).count;return used<state.proactive_message_limit&&!this.#db.prepare("SELECT 1 FROM contact_deliveries WHERE status IN ('reserved','delivered') LIMIT 1").get();}
  /** 返回需与Agent库对账的元数据，绝不返回消息正文。 */
  contactReservations(owner,agentId){this.#authorize(owner);this.get(owner,agentId);return this.#db.prepare("SELECT id,status FROM contact_deliveries WHERE agent_id=? AND status IN ('reserved','delivered') ORDER BY created").all(agentId);}
  /** 对账只能推进本Agent预留状态；缺失落地消息终结但仍计入原预算。 */
  reconcileContact(owner,agentId,id,state){this.#authorize(owner);if(!['missing','delivered','read','withdrawn'].includes(state))throw new AgentError('投递回执状态无效');return this.#transaction(()=>{
    const row=this.#db.prepare('SELECT * FROM contact_deliveries WHERE id=?').get(id);if(!row||row.agent_id!==agentId)throw new AgentError('消息归属无效');if(!['reserved','delivered'].includes(row.status))return;
    this.#db.prepare('UPDATE contact_deliveries SET status=? WHERE id=?').run(state==='missing'?'cancelled':state,id);
  });}
  /** 侧栏只接收各Agent未读数量，不混入私有消息内容。 */
  unreadCounts(owner){this.#authorize(owner);return Object.fromEntries(this.#db.prepare("SELECT agent_id,count(*) AS count FROM contact_deliveries WHERE status='delivered' GROUP BY agent_id").all().map(row=>[row.agent_id,row.count]));}
  /** 多宿主只允许一个调度领导者；存活证明不明时保持原持有者。 */
  lead(owner){this.#authorize(owner);return this.#transaction(()=>{const row=this.#db.prepare('SELECT * FROM scheduler_leader WHERE id=1').get();if(row&&row.instance!==this.#instance&&this.#alive({pid:row.pid,start:row.process_start}))return false;this.#db.prepare('INSERT OR REPLACE INTO scheduler_leader VALUES(1,?,?,?)').run(this.#identity.pid,this.#identity.start,this.#instance);return true;});}
  /** 按最近反思时间轮转，避免一个Agent占尽应用预算。 */
  reflectionOrder(owner){this.#authorize(owner);return this.#db.prepare('SELECT * FROM agents WHERE archived=0 AND paused=0 ORDER BY last_reflection,rowid').all().map(publicAgent);}
  close(){if(this.#closed)return;this.#db.prepare('DELETE FROM scheduler_leader WHERE instance=?').run(this.#instance);this.#db.close();this.#closed=true;}
}
