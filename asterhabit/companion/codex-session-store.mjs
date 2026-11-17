import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';import {mkdirSync} from 'node:fs';import path from 'node:path';
const hash=text=>createHash('sha256').update(text).digest('hex');
/** 执行缓存的持久映射；不存正文，只有权威业务提交后才能续用线程。 */
export class CodexSessionStore {
 #db;
 constructor(filename){mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});this.#db=new DatabaseSync(filename);this.#db.exec(`PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),fingerprint TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(scope_key TEXT PRIMARY KEY,fence TEXT NOT NULL,thread_id TEXT NOT NULL,status TEXT NOT NULL,execution_id TEXT NOT NULL,output_hash TEXT,updated INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,thread_id TEXT NOT NULL,status TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS retired(thread_id TEXT PRIMARY KEY);
 `);if(!this.#db.prepare('PRAGMA table_info(sessions)').all().some(x=>x.name==='history_hash'))this.#db.exec('ALTER TABLE sessions ADD COLUMN history_hash TEXT');if(!this.#db.prepare('PRAGMA table_info(sessions)').all().some(x=>x.name==='turn_id'))this.#db.exec('ALTER TABLE sessions ADD COLUMN turn_id TEXT');}
 #tx(fn){this.#db.exec('BEGIN IMMEDIATE');try{const result=fn();this.#db.exec('COMMIT');return result;}catch(error){this.#db.exec('ROLLBACK');throw error;}}
 /** 一个运行目录只属于一个账号指纹，不能自动换号。 */
 bindIdentity(fingerprint){if(typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint))throw Error('持久Codex账号指纹无效');this.#tx(()=>{const old=this.#db.prepare('SELECT fingerprint FROM identity WHERE id=1').get();if(old&&old.fingerprint!==fingerprint)throw Error('持久Codex账号已变化，需显式迁移');this.#db.prepare('INSERT OR IGNORE INTO identity VALUES(1,?)').run(fingerprint);});}
 /** 仅idle且修订一致的线程可复用；其他状态转入待清理集合。 */
 reusable(key,fence,historyHash){return this.#tx(()=>{const row=this.#db.prepare('SELECT * FROM sessions WHERE scope_key=?').get(key);if(!row)return null;if(row.status==='idle'&&row.fence===fence&&(historyHash===undefined||row.history_hash===historyHash))return {threadId:row.thread_id,turnId:row.turn_id,outputHash:row.output_hash};this.#invalidate(row.scope_key);return null;});}
 #invalidate(key){const row=this.#db.prepare('SELECT thread_id FROM sessions WHERE scope_key=?').get(key);if(row){this.#db.prepare('INSERT OR IGNORE INTO retired VALUES(?)').run(row.thread_id);this.#db.prepare("UPDATE sessions SET status='invalid' WHERE scope_key=?").run(key);}}
 /** 一轮开始先持久化provisional，崩溃不将未知回合当作已确认。 */
 open(key,fence,threadId,executionId){for(const x of [key,fence,threadId,executionId])if(typeof x!=='string'||!x||x.length>300)throw Error('持久会话标识无效');this.#tx(()=>{const previous=this.#db.prepare('SELECT thread_id FROM sessions WHERE scope_key=?').get(key);if(previous&&previous.thread_id!==threadId)this.#db.prepare('INSERT OR IGNORE INTO retired VALUES(?)').run(previous.thread_id);this.#db.prepare("INSERT INTO sessions(scope_key,fence,thread_id,status,execution_id,output_hash,updated) VALUES(?,?,?,'provisional',?,NULL,?) ON CONFLICT(scope_key) DO UPDATE SET fence=excluded.fence,thread_id=excluded.thread_id,status='provisional',execution_id=excluded.execution_id,output_hash=NULL,history_hash=NULL,updated=excluded.updated").run(key,fence,threadId,executionId,Date.now());this.#db.prepare("INSERT INTO executions VALUES(?,?,?,'active')").run(executionId,key,threadId);});}
 /** 记录候选全文摘要；这是生成完成，不是业务提交。 */
 provisional(executionId,text,historyHash=null,turnId=null){if(typeof text!=='string')throw Error('候选正文无效');this.#db.prepare("UPDATE sessions SET output_hash=?,history_hash=?,turn_id=? WHERE execution_id=? AND status='provisional'").run(hash(text.trim()),historyHash,turnId,executionId);}
 /** 全文一致且执行仍是当前版本时提交；编辑、旧确认或已失效一律不续用。 */
 commit(executionId,text,historyHash){return this.#tx(()=>{const row=this.#db.prepare('SELECT * FROM sessions WHERE execution_id=?').get(executionId);if(!row||row.status!=='provisional')return false;if(typeof text!=='string'||row.output_hash!==hash(text.trim())||historyHash!==undefined&&historyHash!==row.history_hash){this.#invalidate(row.scope_key);return false;}this.#db.prepare("UPDATE sessions SET status='idle',updated=? WHERE execution_id=?").run(Date.now(),executionId);return true;});}
 /** 取消或错误只撤销对应执行，不能撤销后来建立的新线程。 */
 discard(executionId){this.#tx(()=>{const row=this.#db.prepare('SELECT scope_key FROM sessions WHERE execution_id=?').get(executionId);if(row)this.#invalidate(row.scope_key);});}
 invalidateKey(key){this.#tx(()=>this.#invalidate(key));}
 /** 临时内部线程也登记执行所有权，恢复时不能误当作旧短进程。 */
 transient(executionId,threadId){if(typeof threadId!=='string'||!threadId)throw Error('临时线程标识无效');this.#db.prepare("INSERT INTO executions VALUES(?,'',?,'active')").run(executionId,threadId);}
 release(executionId){this.#db.prepare("UPDATE executions SET status='released' WHERE id=?").run(executionId);}
 execution(id){return this.#db.prepare('SELECT scope_key AS scopeKey,thread_id AS threadId,status FROM executions WHERE id=?').get(id)??null;}
 retired(){return this.#db.prepare('SELECT thread_id AS threadId FROM retired').all();}
 removed(threadId){this.#tx(()=>{this.#db.prepare("DELETE FROM sessions WHERE thread_id=? AND status='invalid'").run(threadId);this.#db.prepare('DELETE FROM retired WHERE thread_id=?').run(threadId);});}
 close(){this.#db.close();}
}
