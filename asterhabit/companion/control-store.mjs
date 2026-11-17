import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ACTIONS=new Set(['read_post','draft_reply','submit_reply']);
const GRANT_FIELDS=new Set(['expectedRevision','id','account','target','action','limit','windowSeconds','expiresAt','enabled']);
const PROPOSAL_FIELDS=new Set(['idempotencyKey','account','target','action','content']);
const THIRTY_DAYS=30*86_400_000;

/** 权限控制的稳定业务错误，不暴露 SQL、堆栈或任意输入正文。 */
export class ControlError extends Error {
  constructor(message){super(message);this.name='ControlError';}
}

/** 拒绝数组、特殊原型和白名单之外的字段。 */
function strictObject(value,allowed,label) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ControlError(`${label}无效`);
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)throw new ControlError(`${label}无效`);
  if(Object.keys(value).some(key=>!allowed.has(key)))throw new ControlError(`${label}含未允许字段`);
  return value;
}

/** 验证必填短文本并保留缺失、空值和非字符串的区别。 */
function bounded(value,max,label) {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new ControlError(`${label}无效`);
  return value.trim();
}

/** 识别常见令牌、口令和授权头格式，避免进入动作、结果与审计链路。 */
function containsSecret(value) {
  return /(?:sk-[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{12,}\.|(?:password|passwd|cookie|authorization|access[_ -]?token|api[_ -]?key|密码|密钥|令牌)\s*[:=：]\s*\S+)/i.test(value);
}

/** 验证不应携带常见凭据的标识文本。 */
function safeBounded(value,max,label) {
  const result=bounded(value,max,label);
  if(containsSecret(result))throw new ControlError(`${label}含疑似敏感凭据`);
  return result;
}

/** 将 SQLite 整数时间转换为合同要求的 ISO 字符串。 */
function iso(value){return new Date(value).toISOString();}

/** 把数据库授权行转换为不含内部撤销字段的公开 Grant。 */
function publicGrant(row) {
  return {
    id:row.id,
    account:row.account,
    target:row.target,
    action:row.action,
    limit:row.limit_count,
    windowSeconds:row.window_seconds,
    expiresAt:iso(row.expires_at),
    enabled:Boolean(row.enabled),
    createdAt:iso(row.created_at),
    updatedAt:iso(row.updated_at),
  };
}

/** 把数据库动作行转换为公开 Action，内部 grant 与执行时间不出库。 */
function publicAction(row) {
  return {
    id:row.id,
    idempotencyKey:row.idempotency_key,
    account:row.account,
    target:row.target,
    action:row.action,
    content:row.content,
    status:row.status,
    reason:row.reason,
    result:row.result,
    createdAt:iso(row.created_at),
    updatedAt:iso(row.updated_at),
  };
}

/** 把审计行转换为公开 Audit；details 只由本模块的固定文本产生。 */
function publicAudit(row) {
  return {id:row.id,createdAt:iso(row.created_at),event:row.event,actionId:row.action_id,details:row.details};
}

/** 本地主人权限与 sandbox 模拟动作的来源权威存储。 */
export class ControlStore {
  #db;
  #now;
  #closed=false;
  #owner=Object.freeze(Object.create(null));

  /** 打开或创建控制数据库；now 仅由宿主注入以支持确定性测试。 */
  constructor(filename,{now=Date.now}={}) {
    if(typeof now!=='function')throw new ControlError('可信时间源无效');
    this.filename=path.resolve(filename);
    mkdirSync(path.dirname(this.filename),{recursive:true,mode:0o700});
    if(process.platform!=='win32')chmodSync(path.dirname(this.filename),0o700);
    this.#db=new DatabaseSync(this.filename);
    if(process.platform!=='win32')chmodSync(this.filename,0o600);
    this.#now=now;
    this.#db.exec([
      'PRAGMA busy_timeout=5000;',
      'PRAGMA foreign_keys=ON;',
      'PRAGMA secure_delete=ON;',
      'PRAGMA journal_mode=WAL;',
      'PRAGMA synchronous=FULL;',
      'CREATE TABLE IF NOT EXISTS control_state(id INTEGER PRIMARY KEY CHECK(id=1),paused INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0);',
      'INSERT OR IGNORE INTO control_state(id,paused,revision) VALUES (1,0,0);',
      'CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,account TEXT NOT NULL,target TEXT NOT NULL,action TEXT NOT NULL,limit_count INTEGER NOT NULL,window_seconds INTEGER NOT NULL,expires_at INTEGER NOT NULL,enabled INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);',
      'CREATE INDEX IF NOT EXISTS grants_match ON grants(account,target,action,enabled,revoked);',
      "CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,account TEXT NOT NULL,target TEXT NOT NULL,action TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','succeeded','denied','cancelled')),reason TEXT,result TEXT,grant_id TEXT,executed_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);",
      'CREATE INDEX IF NOT EXISTS actions_recent ON actions(created_at DESC);',
      'CREATE INDEX IF NOT EXISTS actions_quota ON actions(grant_id,status,executed_at);',
      'CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,event TEXT NOT NULL,action_id TEXT,details TEXT NOT NULL);',
      'CREATE INDEX IF NOT EXISTS audit_recent ON audit(created_at DESC);'
    ].join('\n'));
  }

  /** 同一实例始终返回唯一不透明 owner capability。 */
  ownerAuthority(){return this.#owner;}

  /** 只接受本实例创建的 owner 对象，复制字段或跨实例复用均无效。 */
  #authorize(owner) {
    if(owner!==this.#owner)throw new ControlError('缺少可信主人权限');
  }

  /** 读取宿主时间并拒绝非有限或负数结果。 */
  #timestamp() {
    const value=this.#now();
    if(!Number.isFinite(value)||value<0)throw new ControlError('可信时间源无效');
    return Math.trunc(value);
  }

  /** 使用立即写事务串行化跨实例 revision 和额度竞争。 */
  #transaction(operation) {
    let begun=false;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      begun=true;
      const result=operation();
      this.#db.exec('COMMIT');
      return result;
    } catch(error) {
      if(begun){try{this.#db.exec('ROLLBACK');}catch{}}
      throw error;
    }
  }

  /** 写入不含任意正文、凭据或异常堆栈的固定审计信息。 */
  #audit(event,actionId,details,createdAt) {
    this.#db.prepare('INSERT INTO audit(id,created_at,event,action_id,details) VALUES (?,?,?,?,?)')
      .run(randomUUID(),createdAt,event,actionId,details);
  }

  /** 验证并规范化权限保存输入，业务字段均采用精确匹配。 */
  #grantInput(input) {
    strictObject(input,GRANT_FIELDS,'权限');
    if(!Number.isInteger(input.expectedRevision)||input.expectedRevision<0)throw new ControlError('权限修订无效');
    const account=safeBounded(input.account,40,'账号');
    if(account!=='sandbox')throw new ControlError('账号必须为 sandbox');
    const target=safeBounded(input.target,200,'目标');
    if(!ACTIONS.has(input.action))throw new ControlError('动作无效');
    if(!Number.isInteger(input.limit)||input.limit<1||input.limit>1000)throw new ControlError('执行次数无效');
    if(!Number.isInteger(input.windowSeconds)||input.windowSeconds<1||input.windowSeconds>86_400)throw new ControlError('额度窗口无效');
    if(typeof input.enabled!=='boolean')throw new ControlError('启用状态必须为明确布尔值');
    if(typeof input.expiresAt!=='string'||!input.expiresAt.includes('T'))throw new ControlError('到期时间无效');
    const expiresAt=Date.parse(input.expiresAt);
    if(!Number.isFinite(expiresAt))throw new ControlError('到期时间无效');
    const id=Object.hasOwn(input,'id')?safeBounded(input.id,200,'授权标识'):randomUUID();
    return {expectedRevision:input.expectedRevision,id,account,target,action:input.action,limit:input.limit,windowSeconds:input.windowSeconds,expiresAt,enabled:input.enabled};
  }

  /** 验证模拟提案；提案不能声明权限、owner 或执行环境。 */
  #proposalInput(input) {
    strictObject(input,PROPOSAL_FIELDS,'模拟提案');
    const idempotencyKey=safeBounded(input.idempotencyKey,200,'幂等标识');
    const account=safeBounded(input.account,40,'账号');
    if(account!=='sandbox')throw new ControlError('账号必须为 sandbox');
    const target=safeBounded(input.target,200,'目标');
    if(!ACTIONS.has(input.action))throw new ControlError('动作无效');
    if(typeof input.content!=='string'||input.content.length>2000)throw new ControlError('动作内容无效');
    if(containsSecret(input.content))throw new ControlError('动作内容含疑似敏感凭据');
    return {idempotencyKey,account,target,action:input.action,content:input.content};
  }

  /** 返回最近动作与审计的有界快照。 */
  snapshot(owner) {
    this.#authorize(owner);
    const state=this.#db.prepare('SELECT paused,revision FROM control_state WHERE id=1').get();
    const grants=this.#db.prepare('SELECT * FROM grants WHERE revoked=0 ORDER BY updated_at DESC,rowid DESC').all().map(publicGrant);
    const actions=this.#db.prepare('SELECT * FROM actions ORDER BY created_at DESC,rowid DESC LIMIT 100').all().map(publicAction);
    const audit=this.#db.prepare('SELECT * FROM audit ORDER BY created_at DESC,rowid DESC LIMIT 200').all().map(publicAudit);
    return {paused:Boolean(state.paused),revision:state.revision,grants,actions,audit};
  }

  /** 仅记录安全拒答已静默这一事实，不接收或保存请求、回复、命中词。 */
  recordReplySuppressed(owner) {
    this.#authorize(owner);
    this.#transaction(()=>this.#audit('reply.suppressed',null,'模型安全拒答，已静默处理',this.#timestamp()));
  }

  /** 以乐观 revision 保存权限；创建和更新都推进全局修订。 */
  saveGrant(owner,input) {
    this.#authorize(owner);
    const value=this.#grantInput(input);
    return this.#transaction(()=>{
      const now=this.#timestamp();
      if(value.expiresAt>now+THIRTY_DAYS)throw new ControlError('到期时间不能超过 30 天');
      if(value.enabled&&value.expiresAt<=now)throw new ControlError('启用授权必须在未来到期');
      const state=this.#db.prepare('SELECT revision FROM control_state WHERE id=1').get();
      if(state.revision!==value.expectedRevision)throw new ControlError('权限修订已变化，拒绝覆盖');
      const old=this.#db.prepare('SELECT created_at FROM grants WHERE id=?').get(value.id);
      const createdAt=old?.created_at??now;
      this.#db.prepare([
        'INSERT INTO grants(id,account,target,action,limit_count,window_seconds,expires_at,enabled,revoked,created_at,updated_at)',
        'VALUES (?,?,?,?,?,?,?,?,0,?,?)',
        'ON CONFLICT(id) DO UPDATE SET account=excluded.account,target=excluded.target,action=excluded.action,limit_count=excluded.limit_count,window_seconds=excluded.window_seconds,expires_at=excluded.expires_at,enabled=excluded.enabled,revoked=0,updated_at=excluded.updated_at'
      ].join(' ')).run(value.id,value.account,value.target,value.action,value.limit,value.windowSeconds,value.expiresAt,Number(value.enabled),createdAt,now);
      this.#db.prepare('UPDATE control_state SET revision=revision+1 WHERE id=1').run();
      this.#audit('permissions.saved',null,'主人保存 sandbox 授权',now);
      return publicGrant(this.#db.prepare('SELECT * FROM grants WHERE id=?').get(value.id));
    });
  }

  /** 在 revision 一致时撤销授权；历史成功次数仍保留用于审计与重启。 */
  revokeGrant(owner,id,expectedRevision) {
    this.#authorize(owner);
    id=safeBounded(id,200,'授权标识');
    if(!Number.isInteger(expectedRevision)||expectedRevision<0)throw new ControlError('权限修订无效');
    const now=this.#timestamp();
    this.#transaction(()=>{
      const state=this.#db.prepare('SELECT revision FROM control_state WHERE id=1').get();
      if(state.revision!==expectedRevision)throw new ControlError('权限修订已变化，拒绝覆盖');
      const result=this.#db.prepare('UPDATE grants SET revoked=1,enabled=0,updated_at=? WHERE id=? AND revoked=0').run(now,id);
      if(!result.changes)throw new ControlError('授权不存在或已撤销');
      this.#db.prepare('UPDATE control_state SET revision=revision+1 WHERE id=1').run();
      this.#audit('permissions.revoked',null,'主人撤销 sandbox 授权',now);
    });
  }

  /** 暂停时原子取消全部 queued 动作；恢复不会重新排队。 */
  setPaused(owner,paused) {
    this.#authorize(owner);
    if(typeof paused!=='boolean')throw new ControlError('暂停状态必须为布尔值');
    const now=this.#timestamp();
    this.#transaction(()=>{
      this.#db.prepare('UPDATE control_state SET paused=? WHERE id=1').run(Number(paused));
      if(paused)this.#db.prepare("UPDATE actions SET status='cancelled',reason='运行已暂停',updated_at=? WHERE status='queued'").run(now);
      this.#audit(paused?'runtime.paused':'runtime.resumed',null,paused?'主人暂停模拟执行':'主人恢复模拟执行',now);
    });
    return this.snapshot(owner);
  }

  /** 持久化未授权提案；相同幂等键仅允许完全相同的业务参数。 */
  submit(input) {
    const value=this.#proposalInput(input);
    const now=this.#timestamp();
    return this.#transaction(()=>{
      const existing=this.#db.prepare('SELECT * FROM actions WHERE idempotency_key=?').get(value.idempotencyKey);
      if(existing){
        if(existing.account!==value.account||existing.target!==value.target||existing.action!==value.action||existing.content!==value.content)throw new ControlError('幂等标识已用于不同参数');
        return publicAction(existing);
      }
      const paused=Boolean(this.#db.prepare('SELECT paused FROM control_state WHERE id=1').get().paused);
      const row={id:randomUUID(),status:paused?'cancelled':'queued',reason:paused?'运行已暂停':null};
      this.#db.prepare('INSERT INTO actions(id,idempotency_key,account,target,action,content,status,reason,result,grant_id,executed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)')
        .run(row.id,value.idempotencyKey,value.account,value.target,value.action,value.content,row.status,row.reason,now,now);
      this.#audit('simulation.submitted',row.id,paused?'暂停期间提案已取消':'sandbox 提案已排队',now);
      return publicAction(this.#db.prepare('SELECT * FROM actions WHERE id=?').get(row.id));
    });
  }

  /** 只生成固定 sandbox 文本，不进行网络、Letta、浏览器或系统调用。 */
  #syntheticResult(action) {
    if(action.action==='read_post')return `sandbox 合成帖子：${action.target}`;
    if(action.action==='draft_reply')return `sandbox 合成草稿：${action.content}`;
    return `sandbox 模拟提交：${action.content}`;
  }

  /** 在同一事务中复核暂停、当前授权、到期与成功次数后执行一次合成动作。 */
  execute(owner,id) {
    this.#authorize(owner);
    id=safeBounded(id,200,'动作标识');
    return this.#transaction(()=>{
      const now=this.#timestamp();
      let action=this.#db.prepare('SELECT * FROM actions WHERE id=?').get(id);
      if(!action)throw new ControlError('动作不存在');
      if(action.status!=='queued')return publicAction(action);

      const paused=Boolean(this.#db.prepare('SELECT paused FROM control_state WHERE id=1').get().paused);
      if(paused){
        this.#db.prepare("UPDATE actions SET status='cancelled',reason='运行已暂停',updated_at=? WHERE id=?").run(now,id);
        this.#audit('simulation.cancelled',id,'暂停状态取消排队动作',now);
        return publicAction(this.#db.prepare('SELECT * FROM actions WHERE id=?').get(id));
      }

      const matching=this.#db.prepare('SELECT * FROM grants WHERE account=? AND target=? AND action=? AND enabled=1 AND revoked=0 ORDER BY updated_at DESC,rowid DESC')
        .all(action.account,action.target,action.action);
      const active=matching.filter(item=>item.expires_at>now);
      let selected=null;
      for(const candidate of active){
        const cutoff=now-candidate.window_seconds*1000;
        const used=this.#db.prepare("SELECT COUNT(*) AS count FROM actions WHERE grant_id=? AND status='succeeded' AND executed_at>?").get(candidate.id,cutoff).count;
        if(used<candidate.limit_count){selected=candidate;break;}
      }

      if(!selected){
        const reason=matching.length&&!active.length?'授权已过期':active.length?'授权额度已用尽':'没有有效授权';
        this.#db.prepare("UPDATE actions SET status='denied',reason=?,updated_at=? WHERE id=?").run(reason,now,id);
        this.#audit('simulation.denied',id,reason,now);
      } else {
        const result=this.#syntheticResult(action);
        this.#db.prepare("UPDATE actions SET status='succeeded',reason=NULL,result=?,grant_id=?,executed_at=?,updated_at=? WHERE id=?")
          .run(result,selected.id,now,now,id);
        this.#audit('simulation.succeeded',id,'sandbox 合成动作成功',now);
      }
      action=this.#db.prepare('SELECT * FROM actions WHERE id=?').get(id);
      return publicAction(action);
    });
  }

  /** 主人取消排队动作；终态动作保持原结果以维持幂等。 */
  cancel(owner,id) {
    this.#authorize(owner);
    id=safeBounded(id,200,'动作标识');
    const now=this.#timestamp();
    return this.#transaction(()=>{
      let action=this.#db.prepare('SELECT * FROM actions WHERE id=?').get(id);
      if(!action)throw new ControlError('动作不存在');
      if(action.status==='queued'){
        this.#db.prepare("UPDATE actions SET status='cancelled',reason='主人已取消',updated_at=? WHERE id=?").run(now,id);
        this.#audit('simulation.cancelled',id,'主人取消排队动作',now);
        action=this.#db.prepare('SELECT * FROM actions WHERE id=?').get(id);
      }
      return publicAction(action);
    });
  }

  /** 持策略库短事务直到记忆提交结束，暂停写者不能在检查后穿入；回调只允许同步本地操作。 */
  guard(owner,operation) {
    this.#authorize(owner);
    return this.#transaction(()=>{
      if(this.#db.prepare('SELECT paused FROM control_state WHERE id=1').get().paused)throw new ControlError('当前已暂停');
      const result=operation();
      if(result&&typeof result.then==='function')throw new ControlError('策略检查门不能等待异步操作');
      return result;
    });
  }

  /** 关闭当前 SQLite 连接；重复关闭不产生额外副作用。 */
  close(){if(!this.#closed){this.#db.close();this.#closed=true;}}
}
