import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const RUN_MARKS=new Set(['draftReady',...['extract','draft','group'].flatMap(p=>['PreflightStart','PreflightEnd','CreateStart','CreateEnd','StreamStart','FirstText','StreamEnd','CleanupStart','CleanupEnd'].map(s=>p+s))]);
const OUTCOMES=new Set(['completed','quiet','suppressed','failed','cancelled']);
function identifier(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(value))throw new TypeError('耗时关联标识无效');}
function span(a,b){if(!a||!b||a.domain!==b.domain||!Number.isFinite(a.mono)||!Number.isFinite(b.mono)||b.mono<a.mono)return null;return Math.round((b.mono-a.mono)*1000)/1000;}
function times(marks){return Object.fromEntries(Object.entries(marks).filter(([,p])=>p&&typeof p==='object'&&Number.isFinite(p.wall)).map(([k,p])=>[k,p.wall]));}
/** 只读投影；null表示缺失或跨实例，不能用墙钟差值伪装精确耗时。 */
function report(db,limit){
 if(!Number.isInteger(limit)||limit<1||limit>50)throw new TypeError('耗时记录数量无效');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='qq_latency_runs'").get())return {available:false,entries:[]};
 const rows=db.prepare('SELECT r.*,e.marks AS event_marks,e.cooldown FROM qq_latency_runs r JOIN qq_latency_events e ON e.event_id=r.event_id ORDER BY r.rowid DESC LIMIT ?').all(limit);
 return {available:true,entries:rows.map(row=>{
  const event=JSON.parse(row.event_marks),run=JSON.parse(row.marks),stages={};
  for(const phase of ['extract','draft','group'])stages[phase]={preflight:span(run[phase+'PreflightStart'],run[phase+'PreflightEnd']),nativeCreate:span(run[phase+'CreateStart'],run[phase+'CreateEnd']),firstText:span(run[phase+'StreamStart'],run[phase+'FirstText']),stream:span(run[phase+'StreamStart'],run[phase+'StreamEnd']),cleanup:span(run[phase+'CleanupStart'],run[phase+'CleanupEnd'])};
  const sends=db.prepare('SELECT * FROM qq_latency_sends WHERE run_id=? ORDER BY rowid').all(row.run_id).map(s=>{const marks=JSON.parse(s.marks);return {attemptId:s.attempt_id,mode:s.mode,outcome:s.outcome,timestamps:times(marks),durationMs:{draftToSendRequest:span(run.draftReady,marks.requested),requestToPrepared:span(marks.requested,marks.prepared),preparedToDispatch:span(marks.prepared,marks.dispatched),dispatchToResult:span(marks.dispatched,marks.result),receivedToResult:s.outcome==='sent'?span(event.received,marks.result):null}};});
  return {runId:row.run_id,eventId:row.event_id,draftId:row.draft_id,mode:row.mode,outcome:row.outcome,timestamps:{...times(event),...times(run)},cooldownRemainingAtQueueMs:row.cooldown,modelStagesMs:stages,durationMs:{receivedToQueue:span(event.received,event.queued),receivedToGenerationRequest:span(event.received,run.requested),queueToGenerationRequest:span(event.queued,run.requested),requestToGenerationStart:span(run.requested,run.started),generation:span(run.started,run.finished),receivedToDraft:span(event.received,run.draftReady)},sends};
 })};
}

/** 每Agent同库业务时间线，仅持久化本地标识、固定枚举和时钟值，不保存消息或凭据。 */
export class QQReplyTimings {
 #db;#now;#clock;#domain=randomUUID();#checkpoints=new WeakSet();#warned=false;
 constructor(db,{now=Date.now,clock=()=>performance.now()}={}){
  this.#db=db;this.#now=now;this.#clock=clock;
  db.exec(`CREATE TABLE IF NOT EXISTS qq_latency_events(event_id TEXT PRIMARY KEY REFERENCES qq_events(id) ON DELETE CASCADE,marks TEXT NOT NULL,cooldown REAL);
   CREATE TABLE IF NOT EXISTS qq_latency_runs(run_id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES qq_latency_events(event_id) ON DELETE CASCADE,draft_id TEXT,mode TEXT NOT NULL,outcome TEXT NOT NULL,marks TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS qq_latency_draft ON qq_latency_runs(draft_id);
   CREATE TABLE IF NOT EXISTS qq_latency_sends(attempt_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES qq_latency_runs(run_id) ON DELETE CASCADE,mode TEXT NOT NULL,outcome TEXT NOT NULL,marks TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS qq_latency_forget AFTER UPDATE OF status ON qq_events WHEN NEW.status IN ('forgotten','expired') BEGIN DELETE FROM qq_latency_events WHERE event_id=NEW.id;END;`);
 }
 #safe(fn){try{return fn();}catch{if(!this.#warned){this.#warned=true;console.error('QQ耗时诊断写入失败；业务继续，缺失阶段不会填零');}return null;}}
 /** 检查点仅供可信调用链传递，不接受renderer提交的时间。 */
 checkpoint(){return this.#safe(()=>{const point={wall:this.#now(),mono:this.#clock(),domain:this.#domain};if(!Number.isFinite(point.wall)||!Number.isFinite(point.mono)||point.mono<0)throw new TypeError('耗时时钟无效');Object.freeze(point);this.#checkpoints.add(point);return point;});}
 #point(provided){if(provided===undefined)return this.checkpoint();return provided&&this.#checkpoints.has(provided)?provided:null;}
 received(eventId){return this.#safe(()=>{identifier(eventId);this.#db.prepare('INSERT OR IGNORE INTO qq_latency_events VALUES(?,?,NULL)').run(eventId,JSON.stringify({received:this.checkpoint()}));this.#db.exec('DELETE FROM qq_latency_events WHERE rowid NOT IN (SELECT rowid FROM qq_latency_events ORDER BY rowid DESC LIMIT 512)');});}
 /** 冷却值是入队时观察到的剩余毫秒，不是另一个可相加的实测阶段。 */
 queued(eventId,cooldown=null){return this.#safe(()=>{const row=this.#db.prepare('SELECT marks FROM qq_latency_events WHERE event_id=?').get(eventId);if(!row)return;const marks=JSON.parse(row.marks);if(marks.queued)return;marks.queued=this.checkpoint();this.#db.prepare('UPDATE qq_latency_events SET marks=?,cooldown=? WHERE event_id=?').run(JSON.stringify(marks),typeof cooldown==='number'&&Number.isFinite(cooldown)&&cooldown>=0?cooldown:null,eventId);});}
 beginRun(runId,eventId,mode,requested){return this.#safe(()=>{identifier(runId);identifier(eventId);if(!['manual','automatic'].includes(mode))throw new TypeError('耗时模式无效');this.#db.prepare("INSERT OR IGNORE INTO qq_latency_events VALUES(?,'{}',NULL)").run(eventId);this.#db.prepare('INSERT INTO qq_latency_runs VALUES(?,?,NULL,?,\'running\',?)').run(runId,eventId,mode,JSON.stringify({requested:this.#point(requested),started:this.checkpoint()}));this.#db.exec('DELETE FROM qq_latency_runs WHERE rowid NOT IN (SELECT rowid FROM qq_latency_runs ORDER BY rowid DESC LIMIT 256)');});}
 markRun(runId,stage){return this.#safe(()=>{if(!RUN_MARKS.has(stage))throw new TypeError('耗时阶段无效');const row=this.#db.prepare('SELECT marks FROM qq_latency_runs WHERE run_id=?').get(runId);if(!row)return;const marks=JSON.parse(row.marks);if(marks[stage])return;marks[stage]=this.checkpoint();this.#db.prepare('UPDATE qq_latency_runs SET marks=? WHERE run_id=?').run(JSON.stringify(marks),runId);});}
 finishRun(runId,outcome,draftId=null){return this.#safe(()=>{if(!OUTCOMES.has(outcome))throw new TypeError('耗时结果无效');const row=this.#db.prepare("SELECT marks FROM qq_latency_runs WHERE run_id=? AND outcome='running'").get(runId);if(!row)return;const marks=JSON.parse(row.marks);marks.finished=this.checkpoint();if(draftId!==null)identifier(draftId);this.#db.prepare('UPDATE qq_latency_runs SET outcome=?,draft_id=?,marks=? WHERE run_id=?').run(outcome,draftId,JSON.stringify(marks),runId);});}
 beginSend(attemptId,draftId,mode,requested){return this.#safe(()=>{identifier(attemptId);if(!['manual','automatic'].includes(mode))throw new TypeError('耗时模式无效');const run=this.#db.prepare('SELECT run_id FROM qq_latency_runs WHERE draft_id=?').get(draftId);if(!run)return;this.#db.prepare("INSERT INTO qq_latency_sends VALUES(?,?,?,'prepared',?)").run(attemptId,run.run_id,mode,JSON.stringify({requested:this.#point(requested),prepared:this.checkpoint()}));this.#db.exec('DELETE FROM qq_latency_sends WHERE rowid NOT IN (SELECT rowid FROM qq_latency_sends ORDER BY rowid DESC LIMIT 256)');});}
 dispatched(attemptId){return this.#safe(()=>{const row=this.#db.prepare('SELECT marks FROM qq_latency_sends WHERE attempt_id=?').get(attemptId);if(!row)return;const marks=JSON.parse(row.marks);if(marks.dispatched)return;marks.dispatched=this.checkpoint();this.#db.prepare("UPDATE qq_latency_sends SET marks=?,outcome='dispatched' WHERE attempt_id=?").run(JSON.stringify(marks),attemptId);});}
 finishSend(attemptId,outcome,point){return this.#safe(()=>{if(!['sent','failed','unknown'].includes(outcome))throw new TypeError('耗时回执无效');const row=this.#db.prepare("SELECT marks FROM qq_latency_sends WHERE attempt_id=? AND outcome IN ('prepared','dispatched')").get(attemptId);if(!row)return;const marks=JSON.parse(row.marks);marks.result=this.#point(point);this.#db.prepare('UPDATE qq_latency_sends SET marks=?,outcome=? WHERE attempt_id=?').run(JSON.stringify(marks),outcome,attemptId);});}
 /** 崩溃恢复不补造终结时间；已派发仍未确认的诊断标记unknown。 */
 recover(){return this.#safe(()=>{this.#db.exec("UPDATE qq_latency_runs SET outcome='interrupted' WHERE outcome='running';UPDATE qq_latency_sends SET outcome='unknown' WHERE outcome='dispatched';UPDATE qq_latency_sends SET outcome='failed' WHERE outcome='prepared';");});}
 /** 只读查询当前Agent最新记录；查询错误不会伪装为空列表。 */
 list({limit=20}={}){return report(this.#db,limit);}
}

/** 离线报告直接只读SQLite，不启动后台、模型或平台连接。 */
export function readQQReplyTimings(filename,{limit=20}={}){const db=new DatabaseSync(filename,{readOnly:true});try{return report(db,limit);}finally{db.close();}}
