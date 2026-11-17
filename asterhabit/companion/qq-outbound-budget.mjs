/** 主动联系的旁表保留历史消费；与既有回复账本合并计数，不迁移或清空旧记录。 */
export function ensureQQContactBudget(db){db.exec(`
 CREATE TABLE IF NOT EXISTS qq_contact_calls(run_id TEXT PRIMARY KEY,self_id TEXT NOT NULL,target_id TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS qq_contact_attempts(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL UNIQUE,self_id TEXT NOT NULL,target_id TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,finished INTEGER);
 CREATE INDEX IF NOT EXISTS qq_contact_calls_created ON qq_contact_calls(created);
 CREATE INDEX IF NOT EXISTS qq_contact_attempts_created ON qq_contact_attempts(created);
`);}
/** 滚动24小时的模型阶段和发送预留，下界now-24h不包含；失败及unknown同样计数，边界与应用总预算一致。 */
export function qqOutboundUsage(db,now){const since=now-86400000;return {usedModelCalls24h:db.prepare('SELECT (SELECT count(*) FROM qq_reply_model_calls WHERE created>?)+(SELECT count(*) FROM qq_contact_calls WHERE created>?) AS n').get(since,since).n,usedSends24h:db.prepare('SELECT (SELECT count(*) FROM qq_reply_send_attempts WHERE created>?)+(SELECT count(*) FROM qq_contact_attempts WHERE created>?) AS n').get(since,since).n};}
/** 所有QQ发送出口共用的最近预留时间，未发送过返回null。 */
export function qqLastOutbound(db){return db.prepare('SELECT max(created) AS value FROM (SELECT created FROM qq_reply_send_attempts UNION ALL SELECT created FROM qq_contact_attempts)').get().value;}
