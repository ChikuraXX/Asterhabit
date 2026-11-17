const DAY=86_400_000,LIMIT=5;
const OPERATIONS=new Set(['identity','view','player','subtitle','search','creator']);
/** 账号业务错误仅含固定描述，不回显凭据或网络输入。 */
export class BilibiliAccountError extends Error {constructor(message,code='INVALID_REQUEST'){super(message);this.name='BilibiliAccountError';this.code=code;}}
function fields(input,required){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==required.length||required.some(key=>!Object.hasOwn(input,key)))throw new BilibiliAccountError('账号请求字段无效');}
function revision(value){if(!Number.isSafeInteger(value)||value<0)throw new BilibiliAccountError('账号修订无效');}
function accountValue(account){fields(account,['id','label']);if(typeof account.id!=='string'||!/^bilibili:[1-9][0-9]{0,19}$/.test(account.id)||typeof account.label!=='string'||!account.label.trim()||account.label.length>100)throw new BilibiliAccountError('验证后的账号信息无效');return {id:account.id,label:account.label.trim()};}
/** 每Agent同库密文保管与只读请求账本；明文加解密只发生在外部可信服务。 */
export class BilibiliAccountStore {
 #db;#content;#contentOwner;#now;#owners=new WeakSet();
 constructor(db,{content,now=Date.now}){this.#db=db;this.#content=content;this.#contentOwner=content.ownerAuthority();this.#now=now;
  db.exec(`CREATE TABLE IF NOT EXISTS bilibili_account(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,account_id TEXT,label TEXT,ciphertext TEXT,bound_at INTEGER,blocked_until INTEGER NOT NULL);
   INSERT OR IGNORE INTO bilibili_account VALUES(1,0,NULL,NULL,NULL,NULL,0);
   CREATE TABLE IF NOT EXISTS bilibili_network_attempts(id INTEGER PRIMARY KEY,operation TEXT NOT NULL,created INTEGER NOT NULL);`);
 }
 /** 只由可信宿主领取，JSON不能伪造。 */
 ownerAuthority(){const owner=Object.freeze(Object.create(null));this.#owners.add(owner);return owner;}
 #owner(owner){if(!this.#owners.has(owner))throw new BilibiliAccountError('缺少账号管理权限','FORBIDDEN');}
 #tx(fn){this.#db.exec('BEGIN IMMEDIATE');try{const result=fn();this.#db.exec('COMMIT');return result;}catch(error){this.#db.exec('ROLLBACK');throw error;}}
 #row(){return this.#db.prepare('SELECT * FROM bilibili_account WHERE id=1').get();}
 #current(expectedRevision){revision(expectedRevision);const row=this.#row();if(row.revision!==expectedRevision)throw new BilibiliAccountError('账号绑定已变化，请重新读取','CONFLICT');return row;}
 /** 安全状态仅含公开账号标识及配额，永不返回密文或原始凭据。 */
 status(owner){this.#owner(owner);const row=this.#row(),used=this.#db.prepare('SELECT count(*) AS n FROM bilibili_network_attempts WHERE created>?').get(this.#now()-DAY).n;return {revision:row.revision,account:row.account_id?{id:row.account_id,label:row.label}:null,network:{limit:LIMIT,used,remaining:Math.max(0,LIMIT-used),blockedUntil:row.blocked_until>this.#now()?row.blocked_until:null}};}
 /** 请求与结果提交前检查同一账号版本。 */
 assertRevision(owner,expectedRevision){this.#owner(owner);this.#current(expectedRevision);return true;}
 /** 仅服务层可取密文，调用方还须用Agent绑定的DPAPI purpose解密。 */
 encrypted(owner,expectedRevision){this.#owner(owner);const row=this.#current(expectedRevision);if(!row.account_id||!row.ciphertext)throw new BilibiliAccountError('尚未绑定B站账号','NOT_READY');return {revision:row.revision,account:{id:row.account_id,label:row.label},ciphertext:row.ciphertext};}
 /** 加密完成后同步CAS提交；账号与读取权限在同一SQLite事务更新。 */
 bind(owner,input){this.#owner(owner);fields(input,['expectedRevision','account','ciphertext']);const account=accountValue(input.account);if(typeof input.ciphertext!=='string'||!input.ciphertext.length||input.ciphertext.length>32768||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.ciphertext))throw new BilibiliAccountError('加密凭据格式无效');return this.#tx(()=>{this.#current(input.expectedRevision);this.#content.installAccountInTransaction(this.#contentOwner,account);this.#db.prepare('UPDATE bilibili_account SET revision=revision+1,account_id=?,label=?,ciphertext=?,bound_at=? WHERE id=1').run(account.id,account.label,input.ciphertext,this.#now());return this.status(owner);});}
 /** 解绑清除密文并关闭读取，不重置请求预算或改变成长/联系开关。 */
 unbind(owner,input){this.#owner(owner);fields(input,['expectedRevision']);return this.#tx(()=>{this.#current(input.expectedRevision);this.#content.installAccountInTransaction(this.#contentOwner,null);this.#db.prepare('UPDATE bilibili_account SET revision=revision+1,account_id=NULL,label=NULL,ciphertext=NULL,bound_at=NULL WHERE id=1').run();return this.status(owner);});}
 /** 每次真实HTTP之前预留一次尝试；失败不退款、换号与解绑不重置。 */
 reserveNetwork(owner,operation){this.#owner(owner);if(!OPERATIONS.has(operation))throw new BilibiliAccountError('只读操作无效');return this.#tx(()=>{const state=this.status(owner);if(state.network.blockedUntil)throw new BilibiliAccountError('平台读取暂时停止，请稍后再试','RATE_LIMITED');if(!state.network.remaining)throw new BilibiliAccountError('本轮只读试运行额度已用完','BUDGET');if(operation==='identity'){const last=this.#db.prepare("SELECT max(created) AS created FROM bilibili_network_attempts WHERE operation='identity'").get().created;if(last!==null&&this.#now()-last<5000)throw new BilibiliAccountError('请等待5秒后再验证账号','COOLDOWN');}this.#db.prepare('INSERT INTO bilibili_network_attempts(operation,created) VALUES (?,?)').run(operation,this.#now());return true;});}
 /** 平台限流后设置固定30分钟暂停，不能由请求参数缩短。 */
 blockNetwork(owner){this.#owner(owner);this.#db.prepare('UPDATE bilibili_account SET blocked_until=max(blocked_until,?) WHERE id=1').run(this.#now()+30*60_000);}
}
