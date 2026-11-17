import {validateOneBotConnection} from './onebot-client.mjs';
import {randomUUID} from 'node:crypto';
import {GENERATION_FAILURE_CODES} from './generation-failure.mjs';
const failureCodes=new Set(GENERATION_FAILURE_CODES);
/** 将最新回复运行投影为固定界面状态，不泄露原始reason，不把拒答或静默当作失败。 */
function replyGeneration(run){
 if(!run)return null;
 if(run.status==='claimed')return {status:'generating',reason:null,finishedAt:null};
 if(run.status!=='interrupted'||run.reason==='suppressed')return null;
 if(['interrupted','crashed'].includes(run.reason))return {status:'cancelled',reason:'cancelled',finishedAt:run.finished};
 const code=typeof run.reason==='string'&&run.reason.startsWith('failure:')?run.reason.slice(8):'details_unavailable';
 return {status:'failed',reason:failureCodes.has(code)?code:'generation_failed',finishedAt:run.finished};
}
const DAY=86_400_000,HISTORY_CHARACTERS=12_000,DEFAULT_ENDPOINT='https://api.bot.qq.com';
/** QQ业务边界错误，不包含Token或外部消息正文。 */
export class QQError extends Error{constructor(message,code='INVALID_REQUEST'){super(message);this.name='QQError';this.code=code;}}
function fields(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new QQError('QQ请求字段无效');}
function rev(value){if(!Number.isSafeInteger(value)||value<0)throw new QQError('QQ修订无效');}
function qqId(value){return typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:null;}
function ids(value){if(!Array.isArray(value)||value.length>50||new Set(value).size!==value.length||value.some(id=>!qqId(id)||typeof id!=='string'))throw new QQError('QQ白名单无效');return [...value];}
/** 本地备注只属于白名单OpenID；空白清除，最长100字符，不接收多行或控制字符。 */
function remarks(value,users){if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).length>50)throw new QQError('QQ用户备注无效');const entries=Object.entries(value);for(const [id,text]of entries)if(!users.includes(id)||typeof text!=='string'||text.trim().length>100||/[\u0000-\u001f\u007f]/u.test(text))throw new QQError('QQ用户备注无效');return Object.fromEntries(entries.map(([id,text])=>[id,text.trim()]).filter(([,text])=>text));}
/** 每Agent QQ连接与24小时外部文字缓存；不持有网络或模型能力。 */
export class QQStore{
 #db;#now;#onForget;#onExpire;#onReceive;#owners=new WeakSet();#claims=new WeakMap();
 constructor(db,{now=Date.now,onForget=()=>{},onExpire=()=>{},onReceive=()=>{}}={}){if(typeof onForget!=='function'||typeof onExpire!=='function')throw new TypeError('QQ来源失效钩子无效');this.#db=db;this.#now=now;this.#onForget=onForget;this.#onExpire=onExpire;this.#onReceive=onReceive;db.exec(`CREATE TABLE IF NOT EXISTS qq_connection(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,endpoint TEXT NOT NULL,self_id TEXT,label TEXT,ciphertext TEXT);
 INSERT OR IGNORE INTO qq_connection VALUES(1,0,'${DEFAULT_ENDPOINT}',NULL,NULL,NULL);
 CREATE TABLE IF NOT EXISTS qq_policy(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,receive_enabled INTEGER NOT NULL,send_enabled INTEGER NOT NULL CHECK(send_enabled=0),proactive_enabled INTEGER NOT NULL CHECK(proactive_enabled=0),users_json TEXT NOT NULL,groups_json TEXT NOT NULL,mentions_only INTEGER NOT NULL);
 INSERT OR IGNORE INTO qq_policy(id,revision,receive_enabled,send_enabled,proactive_enabled,users_json,groups_json,mentions_only) VALUES(1,0,0,0,0,'[]','[]',1);
 CREATE TABLE IF NOT EXISTS qq_events(id TEXT PRIMARY KEY,self_id TEXT NOT NULL,message_id TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,sender_id TEXT NOT NULL,group_id TEXT,text TEXT NOT NULL,received INTEGER NOT NULL,status TEXT NOT NULL,mentioned_self INTEGER CHECK(mentioned_self IN (0,1)),UNIQUE(self_id,kind,target_id,message_id));`);if(!db.prepare('PRAGMA table_info(qq_events)').all().some(column=>column.name==='mentioned_self'))db.exec('ALTER TABLE qq_events ADD COLUMN mentioned_self INTEGER CHECK(mentioned_self IN (0,1))');for(const column of ['sent_at','reply_expires'])if(!db.prepare('PRAGMA table_info(qq_events)').all().some(row=>row.name===column))db.exec('ALTER TABLE qq_events ADD COLUMN '+column+' INTEGER');
 for(const [name,definition] of [['followup_messages','INTEGER NOT NULL DEFAULT 0'],['followup_seconds','INTEGER NOT NULL DEFAULT 120']])if(!db.prepare('PRAGMA table_info(qq_policy)').all().some(row=>row.name===name))db.exec('ALTER TABLE qq_policy ADD COLUMN '+name+' '+definition);
 if(!db.prepare('PRAGMA table_info(qq_events)').all().some(row=>row.name==='followup_accepted'))db.exec('ALTER TABLE qq_events ADD COLUMN followup_accepted INTEGER NOT NULL DEFAULT 0');
 // 昵称仅随授权单聊来源保留；旧记录为NULL，遗忘、过期或缓存淘汰时一并清除。
 if(!db.prepare('PRAGMA table_info(qq_events)').all().some(row=>row.name==='author_name'))db.exec('ALTER TABLE qq_events ADD COLUMN author_name TEXT');
 // 备注独立于平台昵称；每Agent独立库，绑定变化时清除，旧库默认无备注。
 if(!db.prepare('PRAGMA table_info(qq_policy)').all().some(row=>row.name==='user_remarks_json'))db.exec("ALTER TABLE qq_policy ADD COLUMN user_remarks_json TEXT NOT NULL DEFAULT '{}'");
 db.exec("CREATE TRIGGER IF NOT EXISTS qq_event_name_invalidated AFTER UPDATE OF status ON qq_events WHEN NEW.status!='active' BEGIN UPDATE qq_events SET author_name=NULL WHERE id=NEW.id; END;");}
 /** 接话窗口仅进程内有效，重启不恢复旧授权。 */
 #followups=new Map();
 ownerAuthority(){const owner=Object.freeze(Object.create(null));this.#owners.add(owner);return owner;}
 /** 当前账号、仍获授权的单聊昵称；不把群成员OpenID或统一账号字段当成QQ号。 */
 userName(owner,openid){this.#owner(owner);if(!qqId(openid))throw new QQError('QQ用户OpenID无效');if(!this.settings(owner).allowedUserIds.includes(openid))return null;return this.#db.prepare("SELECT author_name AS name FROM qq_events WHERE self_id=? AND kind='private' AND sender_id=? AND status='active' AND received>? AND author_name IS NOT NULL ORDER BY received DESC,rowid DESC LIMIT 1").get(this.#row().self_id,openid,this.#now()-DAY)?.name??null;}
 #owner(owner){if(!this.#owners.has(owner))throw new QQError('缺少QQ主人管理权限','FORBIDDEN');}
 #tx(fn){this.#db.exec('BEGIN IMMEDIATE');try{const value=fn();this.#db.exec('COMMIT');return value;}catch(error){this.#db.exec('ROLLBACK');throw error;}}
 #row(){return this.#db.prepare('SELECT * FROM qq_connection WHERE id=1').get();}
 #revision(expected){rev(expected);const row=this.#row();if(row.revision!==expected)throw new QQError('QQ连接已变化','CONFLICT');return row;}
 connection(owner){this.#owner(owner);const row=this.#row(),onebot=row.self_id?.startsWith('onebot:'),appId=onebot?row.self_id.slice(7):row.self_id?.startsWith('qqbot:')?row.self_id.slice(6):null;return {revision:row.revision,appId,selfId:appId?row.self_id:null,label:appId?row.label:null,...(onebot?{transport:'onebot',endpoint:row.endpoint}:{})};}
 assertRevision(owner,expected){this.#owner(owner);this.#revision(expected);return true;}
 encrypted(owner,expected){this.#owner(owner);const row=this.#revision(expected);if((!row.self_id?.startsWith('qqbot:')&&!row.self_id?.startsWith('onebot:'))||!row.ciphertext)throw new QQError('尚未绑定QQ连接','NOT_READY');return {revision:row.revision,appId:row.self_id.startsWith('onebot:')?row.self_id.slice(7):row.self_id.slice(6),selfId:row.self_id,ciphertext:row.ciphertext,...(row.self_id.startsWith('onebot:')?{transport:'onebot',endpoint:row.endpoint}:{})};}
 /** 已核身份与DPAPI密文同事务安装；连接变化总是关闭接收。 */
 bind(owner,input){this.#owner(owner);fields(input,['expectedRevision','appId','label','ciphertext',...(input?.transport==='onebot'?['transport','endpoint']:[])]);if(input.transport==='onebot')validateOneBotConnection({endpoint:input.endpoint,accountId:input.appId,accessToken:'validation-only'});if(typeof input.appId!=='string'||!/^[1-9][0-9]{0,31}$/.test(input.appId)||typeof input.label!=='string'||!input.label.trim()||input.label.length>100||typeof input.ciphertext!=='string'||input.ciphertext.length>32768||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.ciphertext))throw new QQError('QQ验证后连接信息无效');return this.#tx(()=>{this.#revision(input.expectedRevision);this.#db.prepare('UPDATE qq_connection SET revision=revision+1,endpoint=?,self_id=?,label=?,ciphertext=? WHERE id=1').run(input.transport==='onebot'?input.endpoint:DEFAULT_ENDPOINT,(input.transport==='onebot'?'onebot:':'qqbot:')+input.appId,input.label,input.ciphertext);this.#db.prepare("UPDATE qq_policy SET revision=revision+1,receive_enabled=0,users_json='[]',groups_json='[]',user_remarks_json='{}',mentions_only=1,followup_messages=0,followup_seconds=120 WHERE id=1").run();return this.connection(owner);});}
 /** 暂停、换绑及停止监听均撤销内存接话窗口。 */
 clearFollowups(owner){this.#owner(owner);this.#followups.clear();}
 /** 配对只添加经一次性代码验证的单聊用户，不开启收件/回复权限。 */
 addPairedUser(owner,expected,userId){this.#owner(owner);this.#revision(expected);if(!qqId(userId))throw new QQError('QQ用户OpenID无效');const policy=this.settings(owner);return this.configure(owner,{expectedRevision:policy.revision,receiveEnabled:policy.receiveEnabled,sendEnabled:false,proactiveEnabled:false,allowedGroupIds:policy.allowedGroupIds,groupMentionsOnly:policy.groupMentionsOnly,allowedUserIds:[...new Set([...policy.allowedUserIds,userId])]});}
 unbind(owner,expected){this.#owner(owner);return this.#tx(()=>{this.#revision(expected);this.#db.prepare('UPDATE qq_connection SET revision=revision+1,self_id=NULL,label=NULL,ciphertext=NULL WHERE id=1').run();this.#db.prepare("UPDATE qq_policy SET revision=revision+1,receive_enabled=0,user_remarks_json='{}' WHERE id=1").run();return this.connection(owner);});}
 settings(owner){this.#owner(owner);const row=this.#db.prepare('SELECT * FROM qq_policy WHERE id=1').get();return {revision:row.revision,receiveEnabled:Boolean(row.receive_enabled),sendEnabled:false,proactiveEnabled:false,allowedUserIds:JSON.parse(row.users_json),allowedGroupIds:JSON.parse(row.groups_json),groupMentionsOnly:Boolean(row.mentions_only),userRemarks:JSON.parse(row.user_remarks_json),...(this.#row().self_id?.startsWith('onebot:')?{groupFollowupMessages:row.followup_messages,groupFollowupSeconds:row.followup_seconds}:{})};}
 /** 保存接收策略及本地备注；旧客户端省略备注时保留仍在白名单中的条目。 */
 configure(owner,input){this.#owner(owner);fields(input,['expectedRevision','receiveEnabled','sendEnabled','proactiveEnabled','allowedUserIds','allowedGroupIds','groupMentionsOnly',...(input&&Object.hasOwn(input,'userRemarks')?['userRemarks']:[]),...['groupFollowupMessages','groupFollowupSeconds'].filter(key=>Object.hasOwn(input??{},key))]);rev(input.expectedRevision);for(const key of ['receiveEnabled','sendEnabled','proactiveEnabled','groupMentionsOnly'])if(typeof input[key]!=='boolean')throw new QQError('QQ开关无效');if(input.sendEnabled||input.proactiveEnabled)throw new QQError('本阶段尚未接入QQ发送或主动联系');const users=ids(input.allowedUserIds),groups=ids(input.allowedGroupIds);if(this.#row().self_id?.startsWith('onebot:')&&[...users,...groups].some(value=>!(/^[1-9]\d{0,19}$/).test(value)))throw new QQError('OneBot白名单必须为QQ数字标识');const onebot=this.#row().self_id?.startsWith('onebot:');for(const [key,max] of [['groupFollowupMessages',50],['groupFollowupSeconds',600]])if(Object.hasOwn(input,key)&&(!onebot||!Number.isInteger(input[key])||input[key]<0||input[key]>max))throw new QQError('群接话窗口设置无效');const submitted=Object.hasOwn(input,'userRemarks')?remarks(input.userRemarks,users):null;if(input.receiveEnabled&&!users.length&&!groups.length)throw new QQError('请先配置QQ接收白名单');return this.#tx(()=>{const current=this.settings(owner);if(current.revision!==input.expectedRevision)throw new QQError('QQ接收配置已变化','CONFLICT');const userRemarks=submitted??Object.fromEntries(Object.entries(current.userRemarks).filter(([id])=>users.includes(id)));this.#db.prepare('UPDATE qq_policy SET revision=revision+1,receive_enabled=?,users_json=?,groups_json=?,mentions_only=?,user_remarks_json=? WHERE id=1').run(Number(input.receiveEnabled),JSON.stringify(users),JSON.stringify(groups),Number(input.groupMentionsOnly),JSON.stringify(userRemarks));this.#db.prepare('UPDATE qq_policy SET followup_messages=?,followup_seconds=? WHERE id=1').run(input.groupFollowupMessages??current.groupFollowupMessages??0,input.groupFollowupSeconds??current.groupFollowupSeconds??120);this.#followups.clear();return this.settings(owner);});}
 /** 接收任务持有连接/策略双修订，事件不能带入自己的授权。 */
 beginReceive(owner,expected){this.#owner(owner);const connection=this.encrypted(owner,expected),policy=this.settings(owner);if(!policy.receiveEnabled||!policy.allowedUserIds.length&&!policy.allowedGroupIds.length)throw new QQError('QQ接收尚未开启','FORBIDDEN');const claim=Object.freeze({connectionRevision:connection.revision,policyRevision:policy.revision,selfId:connection.selfId});this.#claims.set(claim,true);return claim;}
 assertReceive(owner,claim){this.#owner(owner);if(!this.#claims.has(claim))throw new QQError('QQ接收任务无效');const row=this.#revision(claim.connectionRevision),policy=this.settings(owner);if(row.self_id!==claim.selfId||!policy.receiveEnabled||policy.revision!==claim.policyRevision)throw new QQError('QQ接收权限或账号已变化','CONFLICT');return policy;}
 #expire(){const operation=()=>{const rows=this.#db.prepare("SELECT rowid AS eventOrder,id,self_id AS selfId,message_id AS messageId,kind,target_id AS targetId,sender_id AS senderId,group_id AS groupId,text,received AS receivedAt,status,mentioned_self AS mentionedSelf FROM qq_events WHERE status IN ('active','evicted') AND received<=? ORDER BY rowid").all(this.#now()-DAY);for(const event of rows)this.#onExpire(event);if(rows.length)this.#db.prepare(`UPDATE qq_events SET text='',status='expired' WHERE id IN (${rows.map(()=>'?').join(',')})`).run(...rows.map(row=>row.id));this.#db.prepare("DELETE FROM qq_events WHERE status IN ('expired','forgotten') AND received<?").run(this.#now()-7*DAY);};if(this.#db.isTransaction)return operation();return this.#tx(operation);}
 /** 只接受官方单聊与群@事件；附件和未知事件不作为指令执行。 */
 ingest(owner,claim,packet){const policy=this.assertReceive(owner,claim),event=decodeQQEvent(packet,this.#now());if(!event)return false;
  const {senderId,kind,groupId,messageId,text,sentAt}=event;const windowKey=claim.selfId+':'+groupId,window=this.#followups.get(windowKey);const followupAccepted=kind==='group'&&!event.mentionedSelf&&policy.groupMentionsOnly&&(policy.groupFollowupMessages??0)>0&&(policy.groupFollowupSeconds??0)>0&&window?.revision===policy.revision&&window.remaining>0&&window.expires>this.#now()&&sentAt>=window.started;
  if(kind==='private'&&!policy.allowedUserIds.includes(senderId)||kind==='group'&&(!policy.allowedGroupIds.includes(groupId)||policy.groupMentionsOnly&&!event.mentionedSelf&&!followupAccepted))return false;
  return this.#tx(()=>{this.assertReceive(owner,claim);this.#expire();const id=randomUUID(),inserted=Boolean(this.#db.prepare("INSERT OR IGNORE INTO qq_events(id,self_id,message_id,kind,target_id,sender_id,group_id,text,received,status,mentioned_self,sent_at,reply_expires) VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?)").run(id,claim.selfId,messageId,kind,groupId??senderId,senderId,groupId,text,this.#now(),Number(event.mentionedSelf),sentAt,sentAt+300000).changes);if(inserted){if(followupAccepted){window.remaining--;this.#db.prepare('UPDATE qq_events SET followup_accepted=1 WHERE id=?').run(id);}else if(kind==='group'&&event.mentionedSelf&&(policy.groupFollowupMessages??0)>0&&(policy.groupFollowupSeconds??0)>0){this.#followups.set(windowKey,{revision:policy.revision,remaining:policy.groupFollowupMessages,started:sentAt,expires:sentAt+policy.groupFollowupSeconds*1000});}const name=packet.d?.author?.username;if(kind==='private'&&typeof name==='string'&&name.trim()&&name.length<=100&&!/[\u0000-\u001f\u007f]/u.test(name))this.#db.prepare('UPDATE qq_events SET author_name=? WHERE id=?').run(name.trim(),id);this.#trimCache(claim.selfId);this.#onReceive({id});}return inserted;});
 }
 /** 收件展示缓存滚动保留100条；清正文留墓碑，避免满额后整天拒收。 */
 #trimCache(selfId){
  const excess=this.#db.prepare("SELECT max(count(*)-100,0) AS n FROM qq_events WHERE self_id=? AND status='active'").get(selfId).n;if(!excess)return;
  const hasReplies=Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE name='qq_reply_runs'").get());
  const exclusion=hasReplies?" AND NOT EXISTS (SELECT 1 FROM qq_reply_runs r WHERE r.event_id=e.id AND r.status='claimed') AND NOT EXISTS (SELECT 1 FROM qq_reply_drafts d WHERE d.event_id=e.id AND d.status='sending')":'';
  const rows=this.#db.prepare("SELECT e.id,e.self_id AS selfId,e.sender_id AS senderId,e.kind,e.group_id AS groupId FROM qq_events e WHERE e.self_id=? AND e.status='active'"+exclusion+' ORDER BY e.received,e.rowid LIMIT ?').all(selfId,excess);
  // 容量淘汰不等于遗忘/24小时到期，不推进scope修订；真正到期仍执行原清理钩子。
  for(const row of rows)this.#db.prepare("UPDATE qq_events SET text='',status='evicted' WHERE id=?").run(row.id);
 }
 /** 派发前检查官方来源时效；缺失时间的旧测试消息不能发送。 */
 assertReplyWindow(owner,event){this.#owner(owner);if(!event||!Number.isSafeInteger(event.replyExpiresAt)||event.replyExpiresAt<=this.#now())throw new QQError('QQ回复消息已过期','EXPIRED');}
 /** 返回经过owner验证的单条来源；active=true时遗忘/过期一律不可读。 */
 event(owner,id,{active=true}={}){this.#owner(owner);if(typeof id!=='string'||id.length>100||typeof active!=='boolean')throw new QQError('QQ消息查询无效');this.#expire();const status=active?" AND status='active'":'';const row=this.#db.prepare(`SELECT rowid AS eventOrder,id,self_id AS selfId,message_id AS messageId,kind,target_id AS targetId,sender_id AS senderId,group_id AS groupId,text,received AS receivedAt,status,mentioned_self AS mentionedSelf,sent_at AS sentAt,reply_expires AS replyExpiresAt,followup_accepted AS followupAccepted FROM qq_events WHERE id=? AND self_id=?${status}`).get(id,this.#row().self_id);return row?{...row,mentionedSelf:row.mentionedSelf===1,followupAccepted:row.followupAccepted===1}:null;}
 /** 返回连接/策略修订快照，供同库草稿绑定。 */
 revisions(owner){this.#owner(owner);return {connectionRevision:this.#row().revision,policyRevision:this.settings(owner).revision};}
 /** 目标必须仍属于当前账号与接收白名单；旧自动发送开关不参与手动逐条确认。 */
 targetAllowed(owner,event){this.#owner(owner);if(!event||typeof event!=='object')return false;const connection=this.#row(),policy=this.settings(owner);if(!policy.receiveEnabled||event.selfId!==connection.self_id)return false;return event.kind==='private'?policy.allowedUserIds.includes(event.senderId):event.kind==='group'&&policy.allowedGroupIds.includes(event.groupId)&&(!policy.groupMentionsOnly||event.mentionedSelf===true||event.followupAccepted===true&&(policy.groupFollowupMessages??0)>0&&(policy.groupFollowupSeconds??0)>0);}
 /** 同账号、同上下文、同发送人最后一条有效消息才允许生成。 */
 isLatestEvent(owner,event){this.#owner(owner);if(!event)return false;this.#expire();const row=this.#db.prepare("SELECT id FROM qq_events WHERE self_id=? AND kind=? AND target_id=? AND sender_id=? AND status='active' ORDER BY received DESC,rowid DESC LIMIT 1").get(event.selfId,event.kind,event.targetId,event.senderId);return row?.id===event.id;}
 /** 全量群自动处理合并至该群最新事件；私聊和仅@模式保留原发言者会话语义。 */
 isLatestAutomaticEvent(owner,event){this.#owner(owner);if(!event)return false;if(event.kind!=='group'||this.settings(owner).groupMentionsOnly)return this.isLatestEvent(owner,event);this.#expire();return this.#db.prepare("SELECT id FROM qq_events WHERE self_id=? AND kind='group' AND group_id=? AND status='active' ORDER BY received DESC,rowid DESC LIMIT 1").get(event.selfId,event.groupId)?.id===event.id;}
 /** 当前机器人/已授权群的近期公开文字，最多12条和12000字符；不读取其他群、私聊或备注。 */
 groupContext(owner,event){
  this.#owner(owner);if(event?.kind!=='group'||!this.targetAllowed(owner,event))throw new QQError('QQ群聊来源已失效','CONFLICT');this.#expire();
  const rows=this.#db.prepare("SELECT id,sender_id AS senderId,text,received AS receivedAt,mentioned_self AS mentionedSelf FROM qq_events WHERE self_id=? AND kind='group' AND group_id=? AND status='active' AND rowid<=? ORDER BY received DESC,rowid DESC LIMIT 12").all(event.selfId,event.groupId,event.eventOrder);
  const messages=[];let length=0;for(const row of rows){if(length+row.text.length>12000)break;length+=row.text.length;messages.push({...row,mentionedSelf:row.mentionedSelf===1});}messages.reverse();
  const lastSendAttemptAt=this.#db.prepare("SELECT max(a.created) AS at FROM qq_reply_send_attempts a JOIN qq_reply_drafts d ON d.id=a.draft_id WHERE d.self_id=? AND d.target_kind='group' AND d.target_id=?").get(event.selfId,event.groupId).at??null;
  return {messages,lastSendAttemptAt};
 }
 /** 决策输入的每个来源必须仍在同一授权群且有效；用于生成提交和发送前的遗忘/过期门。 */
 assertGroupSources(owner,event,sourceIds){
  this.#owner(owner);this.#expire();if(event?.kind!=='group'||!this.targetAllowed(owner,event)||!Array.isArray(sourceIds)||sourceIds.length<1||sourceIds.length>12||new Set(sourceIds).size!==sourceIds.length||!sourceIds.includes(event.id))throw new QQError('QQ群聊上下文已变化','CONFLICT');
  for(const id of sourceIds){const source=this.event(owner,id);if(!source||source.kind!=='group'||source.selfId!==event.selfId||source.groupId!==event.groupId)throw new QQError('QQ群聊上下文已变化','CONFLICT');}
 }
 /** 发送成功后的权威历史快照，只用于确认执行缓存，不创建虚构收件。 */
 confirmedHistory(owner,event){this.#owner(owner);return this.conversationHistory(owner,{...event,receivedAt:this.#now()+1,eventOrder:Number.MAX_SAFE_INTEGER});}
 /** 只合并此前实际收件与sent正文；ready/failed/unknown草稿从不成为已说历史。 */
 conversationHistory(owner,event,{limit=12}={}) {
  this.#owner(owner);if(!event||!Number.isInteger(limit)||limit<1||limit>12)throw new QQError('QQ历史查询无效');
  const incoming=this.#db.prepare("SELECT rowid,id,text,received FROM qq_events WHERE self_id=? AND kind=? AND target_id=? AND sender_id=? AND status='active' AND (received<? OR (received=? AND rowid<?)) ORDER BY received,rowid").all(event.selfId,event.kind,event.targetId,event.senderId,event.receivedAt,event.receivedAt,event.eventOrder).map(row=>({createdAt:row.received,eventOrder:Number(row.rowid),roleOrder:0,rowOrder:Number(row.rowid),value:{role:'user',content:row.text,origin:'user'}}));
  let sent=[];if(this.#db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='qq_reply_drafts'").get().n)sent=this.#db.prepare("SELECT d.rowid,d.text,d.updated,e.rowid AS eventOrder FROM qq_reply_drafts d JOIN qq_events e ON e.id=d.event_id WHERE d.self_id=? AND d.target_kind=? AND d.target_id=? AND d.sender_id=? AND d.status='sent' AND d.text!='' AND d.updated<=? ORDER BY d.updated,d.rowid").all(event.selfId,event.kind,event.targetId,event.senderId,event.receivedAt).map(row=>({createdAt:row.updated,eventOrder:Number(row.eventOrder),roleOrder:1,rowOrder:Number(row.rowid),value:{role:'assistant',content:row.text}}));
  const ordered=[...incoming,...sent].sort((a,b)=>a.createdAt-b.createdAt||a.eventOrder-b.eventOrder||a.roleOrder-b.roleOrder||a.rowOrder-b.rowOrder),selected=[];let characters=0;
  for(let index=ordered.length-1;index>=0&&selected.length<limit;index--){const item=ordered[index],length=item.value.content.length;if(characters+length>HISTORY_CHARACTERS)break;selected.push(item);characters+=length;}
  return selected.reverse().map(row=>row.value);
 }
 messages(owner){this.#owner(owner);this.#expire();const selfId=this.#row().self_id;if(!selfId)return {entries:[]};const rows=this.#db.prepare("SELECT id,message_id AS messageId,kind,sender_id AS senderId,group_id AS groupId,text,received AS receivedAt FROM qq_events WHERE self_id=? AND status='active' ORDER BY received DESC,rowid DESC LIMIT 100").all(selfId);let size=32;const entries=[];
  // 同时限制序列化字节，避免大量中文或转义字符超过原生IPC回复上限；不截断单条正文。
  const decisions=this.#db.prepare("SELECT 1 FROM sqlite_master WHERE name='qq_reply_runs'").get()?this.#db.prepare("SELECT status,reason,finished FROM qq_reply_runs WHERE event_id=? ORDER BY created DESC,rowid DESC LIMIT 1"):null;
  for(const row of rows){const run=decisions?.get(row.id),generation=replyGeneration(run);let entry=run?.status==='completed'&&run.reason==='group_quiet'?{...row,automaticDecision:'quiet'}:row;if(generation)entry={...entry,replyGeneration:generation};const bytes=Buffer.byteLength(JSON.stringify(entry),'utf8')+1;if(size+bytes>256*1024)break;entries.push(entry);size+=bytes;}return {entries};}
 forget(owner,id){this.#owner(owner);if(typeof id!=='string'||id.length>100)throw new QQError('QQ消息标识无效');return this.#tx(()=>{const event=this.event(owner,id,{active:false});if(!event||event.status==='forgotten')return {forgotten:false};this.#onForget(event);const changed=this.#db.prepare("UPDATE qq_events SET text='',status='forgotten' WHERE id=? AND self_id=? AND status!='forgotten'").run(id,this.#row().self_id).changes;return {forgotten:Boolean(changed)};});}
}

/** 解析官方纯文字事件；时间戳来自平台，不以本地重连时间延长回复窗口。 */
export function decodeQQEvent(packet,now=Date.now()){
 if(!packet||packet.op!==0||!['C2C_MESSAGE_CREATE','GROUP_AT_MESSAGE_CREATE','GROUP_MESSAGE_CREATE'].includes(packet.t))return null;
 const data=packet.d,kind=packet.t==='C2C_MESSAGE_CREATE'?'private':'group';if(!data||data.author?.bot===true)return null;
 const senderId=qqId(kind==='private'?data.author?.user_openid:data.author?.member_openid),groupId=kind==='group'?qqId(data.group_openid):null;
 const messageId=data.id,text=typeof data.content==='string'?data.content.trim():'',sentAt=typeof data.timestamp==='string'?Date.parse(data.timestamp):NaN;
 if(!senderId||kind==='group'&&!groupId||typeof messageId!=='string'||!messageId||messageId.length>512||/[\u0000-\u001f]/.test(messageId)||!text||text.length>6000||!Number.isSafeInteger(sentAt)||sentAt>now+60000||sentAt<now-86400000)return null;
 return {senderId,kind,groupId,messageId,text,sentAt,mentionedSelf:packet.t==='GROUP_AT_MESSAGE_CREATE'};
}
