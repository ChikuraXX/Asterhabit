import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

/** OneBot错误只携带固定原因，不回传URL、令牌或外部正文。 */
export class OneBotError extends Error {
 constructor(code,{dispatched=false,confirmedRejected=false}={}){super(({INVALID_CONFIG:'OneBot连接配置无效',CONNECTION_FAILED:'OneBot连接失败',IDENTITY_MISMATCH:'OneBot登录账号不符',PROTOCOL_ERROR:'OneBot响应无效',TIMEOUT:'OneBot响应超时',CANCELLED:'OneBot操作已取消',DENIED:'OneBot发送许可已失效',REJECTED:'OneBot拒绝请求'})[code]??'OneBot操作未完成');this.name='OneBotError';this.code='ONEBOT_'+code;this.dispatched=dispatched;this.confirmedRejected=confirmedRejected;}
}
const fail=(code,options)=>{throw new OneBotError(code,options);};
/** QQ数字标识按字符串保存；拒绝已经损失精度的JSON数字。 */
function id(value,{message=false}={}){if(typeof value==='number'&&Number.isSafeInteger(value))value=String(value);return typeof value==='string'&&(message?/^-?\d{1,20}$/:/^[1-9]\d{0,19}$/).test(value)?value:null;}
/** 存储保持字符串；OneBot请求按integer发送，不能静默舍入。 */
function wireId(value){if(!id(value)||!Number.isSafeInteger(Number(value)))fail('INVALID_CONFIG');return Number(value);}
/** 明文连接只允许IP回环，远程需TLS；地址不得含凭据、查询串或片段。 */
export function validateOneBotConnection({endpoint,accountId,accessToken}={}){
 let url;try{url=new URL(endpoint);}catch{fail('INVALID_CONFIG');}
 if(typeof endpoint!=='string'||endpoint.length>2048||url.username||url.password||url.search||url.hash||!['ws:','wss:'].includes(url.protocol)||url.protocol==='ws:'&&!['127.0.0.1','[::1]'].includes(url.hostname)||typeof accountId!=='string'||!id(accountId)||typeof accessToken!=='string'||!accessToken||accessToken.length>4096||/[\s\u0000-\u001f\u007f]/u.test(accessToken))fail('INVALID_CONFIG');
 return {endpoint:url.href,accountId,accessToken};
}
/** 外部事件归一化为现有QQ业务事件；不接受CQ字符串或附件指令。 */
export function normalizeOneBotEvent(p,accountId){
 if(!p||id(p.self_id)!==accountId)return null;
 if(p.post_type==='notice'){
  if(p.notice_type==='group_decrease'&&id(p.user_id)===accountId&&id(p.group_id))return {t:'GROUP_DEL_ROBOT',d:{group_openid:id(p.group_id)}};
  if(p.notice_type==='group_ban'&&id(p.user_id)===accountId&&p.sub_type==='ban'&&id(p.group_id))return {t:'GROUP_MSG_REJECT',d:{group_openid:id(p.group_id)}};
  if(p.notice_type==='friend_recall')return null;
  return null;
 }
 if(p.post_type!=='message'||!['private','group'].includes(p.message_type)||!id(p.user_id)||id(p.user_id)===accountId||!id(p.message_id,{message:true})||!Number.isSafeInteger(p.time)||p.time<=0||p.time>8640000000000||!Array.isArray(p.message)||p.message.length>100)return null;
 const group=p.message_type==='group',sender=id(p.user_id),groupId=group?id(p.group_id):null;if(group&&!groupId)return null;
 let text='',mentioned=false;
 for(const segment of p.message){if(segment?.type==='text'&&typeof segment.data?.text==='string')text+=segment.data.text;else if(segment?.type==='at'&&id(segment.data?.qq)===accountId)mentioned=true;}
 if(!text.trim()||text.length>6000)return null;
 return {op:0,t:group?(mentioned?'GROUP_AT_MESSAGE_CREATE':'GROUP_MESSAGE_CREATE'):'C2C_MESSAGE_CREATE',d:{id:id(p.message_id,{message:true}),timestamp:new Date(p.time*1000).toISOString(),content:text,author:{[group?'member_openid':'user_openid']:sender,username:typeof p.sender?.nickname==='string'?p.sender.nickname.slice(0,100):undefined},...(group?{group_openid:groupId}:{})}};
}

/** 单次已鉴权连接；RPC超时不重放，发送前由调用者核验登录身份。 */
class OneBotSession {
 #socket;#pending=new Map();#timeout;#signal;#abort;#closed=false;#finish;#heartbeat;#pong=true;
 #onEvent=null;#buffer=[];#bufferBytes=0;done;
 /** 身份核验后安装处理器，按到达顺序交付握手期间的有界事件。 */
 set onEvent(callback){this.#onEvent=callback;if(callback){const buffered=this.#buffer;this.#buffer=[];this.#bufferBytes=0;for(const packet of buffered){if(this.#closed)break;callback(packet);}}}
 constructor(connection,{timeoutMs,signal}){
  this.#timeout=timeoutMs;this.#signal=signal;this.done=new Promise(resolve=>{this.#finish=resolve;});
  this.#socket=new WebSocket(connection.endpoint,{headers:{Authorization:'Bearer '+connection.accessToken},followRedirects:false,handshakeTimeout:timeoutMs,maxPayload:256*1024,perMessageDeflate:false});
  this.#socket.on('error',()=>this.close(new OneBotError('CONNECTION_FAILED')));
  this.#socket.on('close',()=>this.close(new OneBotError('CONNECTION_FAILED')));
  this.#socket.on('pong',()=>{this.#pong=true;});
  this.#socket.on('message',(raw,binary)=>{
   let packet;try{if(binary||raw.length>256*1024)throw Error();packet=JSON.parse(raw.toString());if(!packet||typeof packet!=='object'||Array.isArray(packet))throw Error();}catch{this.close(new OneBotError('PROTOCOL_ERROR'));return;}
   if(Object.hasOwn(packet,'echo')){const pending=this.#pending.get(packet.echo);if(!pending)return;this.#pending.delete(packet.echo);clearTimeout(pending.timer);if(packet.status==='ok'&&packet.retcode===0)pending.resolve(packet.data);else if(packet.status==='failed'&&Number.isInteger(packet.retcode)&&packet.retcode!==0)pending.reject(new OneBotError('REJECTED',{confirmedRejected:true}));else pending.reject(new OneBotError('PROTOCOL_ERROR'));}
   else if(this.#onEvent){try{this.#onEvent(packet);}catch{this.close(new OneBotError('PROTOCOL_ERROR'));}}
   else {this.#bufferBytes+=raw.length;if(this.#buffer.length>=64||this.#bufferBytes>256*1024)this.close(new OneBotError('PROTOCOL_ERROR'));else this.#buffer.push(packet);}
  });
  this.#abort=()=>this.close(new OneBotError('CANCELLED'));signal?.addEventListener('abort',this.#abort,{once:true});if(signal?.aborted)this.#abort();
 }
 async ready(){
  if(this.#closed)fail('CANCELLED');
  const opened=new Promise(resolve=>this.#socket.once('open',resolve));
  const result=await Promise.race([opened.then(()=>null),this.done]);if(result)throw result;
  if(this.#closed)fail('CONNECTION_FAILED');
  this.#heartbeat=setInterval(()=>{if(!this.#pong){this.close(new OneBotError('TIMEOUT'));return;}this.#pong=false;this.#socket.ping();},30000);this.#heartbeat.unref();
 }
 request(action,params={}){
  if(this.#closed||this.#socket.readyState!==WebSocket.OPEN)return Promise.reject(new OneBotError('CONNECTION_FAILED'));
  const echo=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.#pending.delete(echo);reject(new OneBotError('TIMEOUT'));},this.#timeout);this.#pending.set(echo,{resolve,reject,timer});try{this.#socket.send(JSON.stringify({action,params,echo}),error=>{if(error)this.close(new OneBotError('CONNECTION_FAILED'));});}catch{this.close(new OneBotError('CONNECTION_FAILED'));}});
 }
 close(error=new OneBotError('CANCELLED')){if(this.#closed)return;this.#closed=true;clearInterval(this.#heartbeat);this.#signal?.removeEventListener('abort',this.#abort);for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject(error);}this.#pending.clear();this.#onEvent=null;this.#buffer=[];this.#bufferBytes=0;this.#socket.terminate();this.#finish(error);}
}

/** 固定OneBot操作；每次连接先核验账号，不提供任意action或自动发送重试。 */
export class OneBotClient {
 #timeout;#backoff;
 constructor({timeoutMs=10000,backoffMs=1000}={}){if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isInteger(backoffMs)||backoffMs<1||backoffMs>30000)fail('INVALID_CONFIG');this.#timeout=timeoutMs;this.#backoff=backoffMs;}
 async #open(input){const connection=validateOneBotConnection(input);if(input.signal?.aborted)fail('CANCELLED');const session=new OneBotSession(connection,{timeoutMs:this.#timeout,signal:input.signal});try{await session.ready();const identity=await session.request('get_login_info');if(id(identity?.user_id)!==connection.accountId)fail('IDENTITY_MISMATCH');return {session,identity:{id:connection.accountId,label:typeof identity.nickname==='string'&&identity.nickname.trim()?identity.nickname.trim().slice(0,100):connection.accountId}};}catch(error){session.close();throw error;}}
 async identity(input){const {session,identity}=await this.#open(input);session.close();return identity;}
 async groupInfo(input){const groupId=wireId(input.groupOpenid);const {session}=await this.#open(input);try{const data=await session.request('get_group_info',{group_id:groupId});if(id(data?.group_id)!==input.groupOpenid||typeof data.group_name!=='string')fail('PROTOCOL_ERROR');return {openid:input.groupOpenid,name:data.group_name.slice(0,200)||null};}finally{session.close();}}
 async receive(input){
  if(typeof input.onEvent!=='function')fail('INVALID_CONFIG');validateOneBotConnection(input);
  const duration=input.durationMs??Infinity;if(duration!==Infinity&&(!Number.isInteger(duration)||duration<1||duration>30000))fail('INVALID_CONFIG');
  const controller=new AbortController(),signal=input.signal?AbortSignal.any([input.signal,controller.signal]):controller.signal;
  const timer=duration===Infinity?null:setTimeout(()=>controller.abort(),duration);let stopped=false;
  try{for(let attempt=0;attempt<3;attempt++){
   let session;
   try{({session}=await this.#open({...input,signal}));input.onState?.('listening');let chain=Promise.resolve(),queued=0,callbackError=null;
    session.onEvent=packet=>{if(packet.self_id!==undefined&&id(packet.self_id)!==input.accountId){session.close(new OneBotError('IDENTITY_MISMATCH'));return;}const event=normalizeOneBotEvent(packet,input.accountId);if(!event)return;if(++queued>64){session.close(new OneBotError('PROTOCOL_ERROR'));return;}chain=chain.then(async()=>{if(signal.aborted||stopped||callbackError)return;const keep=await input.onEvent(event);if(keep===false){stopped=true;session.close();}}).catch(error=>{callbackError=error;session.close();}).finally(()=>queued--);};
    const error=await session.done;await chain;if(callbackError)throw callbackError;if(stopped||controller.signal.aborted)return;throw error;
   }catch(error){if(controller.signal.aborted)return;if(input.signal?.aborted)fail('CANCELLED');if(!(error instanceof OneBotError)||['ONEBOT_IDENTITY_MISMATCH','ONEBOT_REJECTED','ONEBOT_PROTOCOL_ERROR'].includes(error.code)||attempt===2)throw error;input.onState?.('reconnecting');await delay(this.#backoff*(attempt+1),undefined,{signal});}finally{session?.close();}
  }}finally{clearTimeout(timer);}
 }
 async sendText(input){
  if(!input.target||!['private','group'].includes(input.target.kind)||!id(input.target.id)||typeof input.text!=='string'||!input.text.trim()||input.text.length>2000||typeof input.dispatch!=='function')fail('INVALID_CONFIG');
  const targetId=wireId(input.target.id);const {session}=await this.#open(input);let dispatched=false,pending;
  try{
   const send=()=>{if(dispatched||input.signal?.aborted)fail('DENIED',{dispatched});dispatched=true;pending=session.request(input.target.kind==='private'?'send_private_msg':'send_group_msg',{[input.target.kind==='private'?'user_id':'group_id']:targetId,message:[{type:'text',data:{text:input.text}}]});void pending.catch(()=>{});};
   const gate=input.dispatch(send);if(gate&&typeof gate.then==='function'){void Promise.resolve(gate).catch(()=>{});fail('DENIED',{dispatched});}if(!dispatched)fail('DENIED');const data=await pending;const messageId=id(data?.message_id,{message:true});if(!messageId)fail('PROTOCOL_ERROR',{dispatched:true});return {messageId};
  }catch(error){throw new OneBotError(error instanceof OneBotError?error.code.slice(7):'DENIED',{dispatched,confirmedRejected:error instanceof OneBotError&&error.confirmedRejected});}finally{session.close();}
 }
}
