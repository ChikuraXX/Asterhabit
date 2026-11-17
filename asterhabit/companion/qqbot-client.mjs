import DefaultWebSocket from 'ws';

const API_ORIGIN='https://api.bot.qq.com';
const TOKEN_URL=`${API_ORIGIN}/app/getAppAccessToken`;
const MAX_BODY_BYTES=64*1024;
const MAX_FRAME_BYTES=64*1024;
const MAX_SECRET_CHARACTERS=4096;
const MESSAGE_EVENTS=new Set(['C2C_MESSAGE_CREATE','GROUP_AT_MESSAGE_CREATE','GROUP_MESSAGE_CREATE','FRIEND_DEL','C2C_MSG_REJECT','GROUP_DEL_ROBOT','GROUP_MSG_REJECT']);
const MESSAGES=Object.freeze({
  QQBOT_INVALID_CONFIG:'QQ机器人连接参数无效',
  QQBOT_ABORTED:'QQ机器人操作已取消',
  QQBOT_TIMEOUT:'QQ机器人请求超时',
  QQBOT_AUTHENTICATION_FAILED:'QQ机器人身份验证失败',
  QQBOT_PLATFORM_REJECTED:'QQ机器人平台拒绝了请求',
  QQBOT_PROTOCOL_ERROR:'QQ机器人协议响应无效',
  QQBOT_FRAME_TOO_LARGE:'QQ机器人数据帧过大',
  QQBOT_CONNECTION_FAILED:'QQ机器人连接失败',
  QQBOT_EVENT_CALLBACK_FAILED:'QQ机器人事件处理失败',
  QQBOT_GROUP_INFO_FORBIDDEN:'机器人尚未获得群资料接口权限',
  QQBOT_GROUP_STATE_FORBIDDEN:'机器人尚未获得群状态接口权限'
});

/** 不包含凭据、远端正文或URL的固定QQ机器人传输错误。 */
export class QQBotError extends Error{
  constructor(code,{confirmedRejected=false,receipt=null}={}){super(MESSAGES[code]??'QQ机器人操作失败');this.name='QQBotError';this.code=code;this.confirmedRejected=confirmedRejected;this.receipt=receipt;}
}

function fail(code,options){throw new QQBotError(code,options);}
function plain(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function exact(value,keys){return plain(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');}
function exactInput(value,required,optional=[]){
  if(!plain(value))return false;const keys=Object.keys(value),allowed=new Set([...required,...optional]);
  return required.every(key=>Object.hasOwn(value,key))&&keys.every(key=>allowed.has(key));
}
function validSignal(signal){return signal===undefined||plain(signal)&&typeof signal.aborted==='boolean'&&typeof signal.addEventListener==='function'&&typeof signal.removeEventListener==='function';}
function validMessageId(value){return typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/u.test(value);}
function headerValue(headers,names){if(!headers||typeof headers.get!=='function')return null;for(const name of names){const value=headers.get(name);if(typeof value==='string'&&value&&value.length<=256&&!/[\u0000-\u001f\u007f]/u.test(value))return value;}return null;}
function responseReceipt(response,{platformCode=null,messageId=null,timestamp=null}={}){return {httpStatus:Number.isInteger(response?.status)&&response.status>=100&&response.status<=599?response.status:null,platformCode:Number.isSafeInteger(platformCode)||typeof platformCode==='string'&&platformCode.length>0&&platformCode.length<=100&&!/[\u0000-\u001f\u007f]/u.test(platformCode)?platformCode:null,messageId:validMessageId(messageId)?messageId:null,timestamp:typeof timestamp==='string'&&timestamp.length>0&&timestamp.length<=100&&!/[\u0000-\u001f\u007f]/u.test(timestamp)?timestamp:null,traceId:headerValue(response?.headers,['x-tps-trace-id','x-trace-id','trace-id'])};}

/** 校验QQ开放平台提供的应用身份；返回独立副本。 */
export function validateQQBotConnection(value){
  if(!exact(value,['appId','appSecret']))fail('QQBOT_INVALID_CONFIG');
  const {appId,appSecret}=value;
  if(typeof appId!=='string'||!/^[1-9][0-9]{0,31}$/u.test(appId))fail('QQBOT_INVALID_CONFIG');
  if(typeof appSecret!=='string'||appSecret.length<1||appSecret.length>MAX_SECRET_CHARACTERS||/\s/u.test(appSecret))fail('QQBOT_INVALID_CONFIG');
  return {appId,appSecret};
}

function frameText(data){
  if(typeof data==='string')return data;
  if(Buffer.isBuffer(data))return data.toString('utf8');
  if(data instanceof ArrayBuffer)return Buffer.from(data).toString('utf8');
  if(ArrayBuffer.isView(data))return Buffer.from(data.buffer,data.byteOffset,data.byteLength).toString('utf8');
  fail('QQBOT_PROTOCOL_ERROR');
}
function frameBytes(data){
  if(typeof data==='string')return Buffer.byteLength(data,'utf8');
  if(Buffer.isBuffer(data)||ArrayBuffer.isView(data))return data.byteLength;
  if(data instanceof ArrayBuffer)return data.byteLength;
  return MAX_FRAME_BYTES+1;
}
function closeSocket(socket){try{socket.once?.('error',()=>{});socket.close();}catch{try{socket.terminate?.();}catch{}}}
function gatewayURL(value){
  if(typeof value!=='string')fail('QQBOT_PROTOCOL_ERROR');
  let url;try{url=new URL(value);}catch{fail('QQBOT_PROTOCOL_ERROR');}
  if(url.protocol!=='wss:'||!['api.bot.qq.com','api.sgroup.qq.com'].includes(url.hostname)||url.port||url.username||url.password||url.search||url.hash||!['/websocket','/websocket/'].includes(url.pathname))fail('QQBOT_PROTOCOL_ERROR');
  return value;
}

/** 仅暴露QQ官方固定端点所需的鉴权、读取和发送能力。 */
export class QQBotAPI{
  #fetch;#now;#timeoutMs;#tokens=new Map();
  constructor({fetch=globalThis.fetch,now=Date.now,timeoutMs=10_000}={}){
    if(typeof fetch!=='function'||typeof now!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120_000)fail('QQBOT_INVALID_CONFIG');
    this.#fetch=fetch;this.#now=now;this.#timeoutMs=timeoutMs;
  }
  async #response(url,options,{failureCode='QQBOT_PLATFORM_REJECTED'}={}){
    if(options.signal?.aborted)fail('QQBOT_ABORTED');
    const controller=new AbortController();let stop;
    const stopped=new Promise((_,reject)=>{stop=error=>{controller.abort();reject(error);};});
    const timeout=setTimeout(()=>stop(new QQBotError('QQBOT_TIMEOUT')),this.#timeoutMs);
    const abort=()=>stop(new QQBotError('QQBOT_ABORTED'));options.signal?.addEventListener('abort',abort,{once:true});
    let response,text;
    try{
      response=await Promise.race([this.#fetch(url,{...options,signal:controller.signal,redirect:'error'}),stopped]);
      if(!response||typeof response.text!=='function'||response.redirected===true)fail('QQBOT_PROTOCOL_ERROR',{receipt:responseReceipt(response)});
      text=await Promise.race([response.text(),stopped]);
    }catch(error){
      if(error instanceof QQBotError)throw error;
      if(options.signal?.aborted)fail('QQBOT_ABORTED');
      if(controller.signal.aborted)fail('QQBOT_TIMEOUT');
      fail('QQBOT_CONNECTION_FAILED');
    }finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);}
    if(Buffer.byteLength(text,'utf8')>MAX_BODY_BYTES)fail('QQBOT_PROTOCOL_ERROR',{receipt:responseReceipt(response)});
    let body;try{body=JSON.parse(text);}catch{fail('QQBOT_PROTOCOL_ERROR',{receipt:responseReceipt(response)});}
    if(!plain(body))fail('QQBOT_PROTOCOL_ERROR',{receipt:responseReceipt(response)});
    const receipt=responseReceipt(response,{platformCode:Object.hasOwn(body,'code')?body.code:null});
    if(Object.hasOwn(body,'code'))fail(failureCode,{confirmedRejected:true,receipt});
    if(!response.ok)fail(failureCode,{confirmedRejected:Number.isInteger(response.status)&&response.status>=400&&response.status<500,receipt});
    return {body,httpStatus:receipt.httpStatus,traceId:receipt.traceId};
  }
  async #json(url,options,settings){return (await this.#response(url,options,settings)).body;}
  async accessToken(credentials,{signal}={}){
    const connection=validateQQBotConnection(credentials);
    if(!validSignal(signal))fail('QQBOT_INVALID_CONFIG');if(signal?.aborted)fail('QQBOT_ABORTED');
    const cached=this.#tokens.get(connection.appId);
    if(cached&&cached.secret===connection.appSecret&&cached.refreshAt>this.#now())return cached.token;
    const body=await this.#json(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appId:connection.appId,clientSecret:connection.appSecret}),signal},{failureCode:'QQBOT_AUTHENTICATION_FAILED'});
    // 官方实际响应可能以数字字符串表示秒数；不把空值、布尔或小数默认为有效期。
    const expiresIn=typeof body.expires_in==='string'&&/^[1-9][0-9]*$/.test(body.expires_in)?Number(body.expires_in):body.expires_in;
    if(typeof body.access_token!=='string'||!body.access_token||body.access_token.length>8192||/\s/u.test(body.access_token)||!Number.isSafeInteger(expiresIn)||expiresIn<=0)fail('QQBOT_PROTOCOL_ERROR');
    const lifetime=expiresIn*1000,advance=Math.min(60_000,Math.max(1000,lifetime*.1));
    this.#tokens.set(connection.appId,{secret:connection.appSecret,token:body.access_token,refreshAt:this.#now()+Math.max(0,lifetime-advance)});
    return body.access_token;
  }
  async #authorized(credentials,path,{method='GET',body,signal,failureCode}={}){
    const token=await this.accessToken(credentials,{signal});
    return this.#json(`${API_ORIGIN}${path}`,{method,headers:{Authorization:`QQBot ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal},{failureCode});
  }
  identity(credentials,{signal}={}){return this.#authorized(credentials,'/users/@me',{signal,failureCode:'QQBOT_AUTHENTICATION_FAILED'});}
  gateway(credentials,{signal}={}){return this.#authorized(credentials,'/gateway',{signal});}
  /** 按固定群OpenID查询名称；不返回或推断普通群号，不开放任意URL。 */
  async groupInfo(credentials,{groupOpenid,signal}={}){
    if(typeof groupOpenid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(groupOpenid))fail('QQBOT_INVALID_CONFIG');
    let body;try{body=await this.#authorized(credentials,`/v2/groups/${encodeURIComponent(groupOpenid)}/info`,{signal});}catch(error){if(String(error?.receipt?.platformCode)==='11253')fail('QQBOT_GROUP_INFO_FORBIDDEN',{confirmedRejected:true,receipt:error.receipt});throw error;}
    if(body.group_openid!==groupOpenid||typeof body.group_name!=='string'||body.group_name.length>200||/[\u0000-\u001f\u007f]/u.test(body.group_name))fail('QQBOT_PROTOCOL_ERROR');
    return {openid:groupOpenid,name:body.group_name.trim()||null};
  }
  /** 固定只读群状态接口；平台接收模式只是能力信息，不授予本地接收或发送权限。 */
  async groupState(credentials,{groupOpenid,signal}={}){
    if(typeof groupOpenid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(groupOpenid))fail('QQBOT_INVALID_CONFIG');
    let body;try{body=await this.#authorized(credentials,`/v2/groups/${encodeURIComponent(groupOpenid)}/bot_state`,{signal});}catch(error){if(String(error?.receipt?.platformCode)==='11253')fail('QQBOT_GROUP_STATE_FORBIDDEN',{confirmedRejected:true,receipt:error.receipt});throw error;}
    if(typeof body.recv_msg_setting!=='string'||!body.recv_msg_setting||body.recv_msg_setting.length>100||/[\u0000-\u001f\u007f]/u.test(body.recv_msg_setting))fail('QQBOT_PROTOCOL_ERROR');
    // 未公开枚举不能猜成all；保留受限模式标识用于主人在平台核对，不解析无关权限字段。
    const receiveMode=['all','only_mention','mention_and_context'].includes(body.recv_msg_setting)?body.recv_msg_setting:'unknown';
    return {openid:groupOpenid,receiveMode,reportedMode:/^[A-Za-z0-9_-]{1,64}$/.test(body.recv_msg_setting)?body.recv_msg_setting:null};
  }
  sendTextWithToken(token,{target,text,messageId,signal}){
    if(typeof token!=='string'||!token||token.length>8192||/\s/u.test(token)||!exact(target,['kind','id'])||!['private','group'].includes(target.kind)||typeof target.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(target.id)||typeof text!=='string'||!text.trim()||text.length>2000||!validMessageId(messageId)||!validSignal(signal))fail('QQBOT_INVALID_CONFIG');
    const scene=target.kind==='private'?'users':'groups';
    return this.#response(`${API_ORIGIN}/v2/${scene}/${encodeURIComponent(target.id)}/messages`,{method:'POST',headers:{Authorization:`QQBot ${token}`,'Content-Type':'application/json'},body:JSON.stringify({content:text,msg_type:0,msg_id:messageId,msg_seq:1}),signal}).then(({body,httpStatus,traceId})=>({id:body.id,timestamp:body.timestamp,receipt:responseReceipt({status:httpStatus,headers:{get:name=>name==='x-tps-trace-id'?traceId:null}},{messageId:body.id,timestamp:body.timestamp})}));
  }
  async sendText(credentials,options){
    const token=await this.accessToken(credentials,{signal:options?.signal});
    return this.sendTextWithToken(token,options);
  }
}

/** 通过官方Gateway验证机器人并接收单聊、群@消息。 */
export class QQBotClient{
  /** 资料查询复用本实例认证缓存与固定只读API。 */
  groupInfo(input={}){if(!exactInput(input,['appId','appSecret','groupOpenid'],['signal']))fail('QQBOT_INVALID_CONFIG');const {appId,appSecret,groupOpenid,signal}=input;return this.#api.groupInfo({appId,appSecret},{groupOpenid,signal});}
  /** 群接收能力查询不允许附加URL、权限或写操作字段。 */
  groupState(input={}){if(!exactInput(input,['appId','appSecret','groupOpenid'],['signal']))fail('QQBOT_INVALID_CONFIG');const {appId,appSecret,groupOpenid,signal}=input;return this.#api.groupState({appId,appSecret},{groupOpenid,signal});}
  #api;#WebSocket;#timeoutMs;#maxReconnects;#backoffMs;
  constructor({api,fetch,WebSocket=DefaultWebSocket,now=Date.now,timeoutMs=10_000,maxReconnects=2,backoffMs=25}={}){
    if(typeof WebSocket!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120_000||!Number.isInteger(maxReconnects)||maxReconnects<0||maxReconnects>5||!Number.isInteger(backoffMs)||backoffMs<0||backoffMs>30_000)fail('QQBOT_INVALID_CONFIG');
    this.#api=api??new QQBotAPI({fetch,now,timeoutMs});if(!(this.#api instanceof QQBotAPI))fail('QQBOT_INVALID_CONFIG');
    this.#WebSocket=WebSocket;this.#timeoutMs=timeoutMs;this.#maxReconnects=maxReconnects;this.#backoffMs=backoffMs;
  }
  async identity(input={}){
    if(!exactInput(input,['appId','appSecret'],['signal']))fail('QQBOT_INVALID_CONFIG');
    const {appId,appSecret,signal}=input;
    const connection=validateQQBotConnection({appId,appSecret});if(!validSignal(signal))fail('QQBOT_INVALID_CONFIG');
    const body=await this.#api.identity(connection,{signal});
    if(typeof body.id!=='string'||!body.id||typeof body.username!=='string'||Object.hasOwn(body,'bot')&&body.bot!==true)fail('QQBOT_PROTOCOL_ERROR',{confirmedRejected:true});
    return {id:connection.appId,label:body.username.trim()||connection.appId};
  }
  async receive(input={}){
    if(!exactInput(input,['appId','appSecret','onEvent'],['signal','durationMs','onState']))fail('QQBOT_INVALID_CONFIG');
    const {appId,appSecret,signal,onEvent,onState,durationMs=30_000}=input;
    const connection=validateQQBotConnection({appId,appSecret});
    if(!validSignal(signal)||typeof onEvent!=='function'||onState!==undefined&&typeof onState!=='function'||durationMs!==Infinity&&(!Number.isInteger(durationMs)||durationMs<1||durationMs>30_000))fail('QQBOT_INVALID_CONFIG');
    if(signal?.aborted)fail('QQBOT_ABORTED');
    const started=performance.now();let token,gateway,remaining=durationMs;
    if(durationMs===Infinity){token=await this.#api.accessToken(connection,{signal});gateway=await this.#api.gateway(connection,{signal});}
    else{
      const preparation=new AbortController(),relayAbort=()=>preparation.abort();signal?.addEventListener('abort',relayAbort,{once:true});let deadlineTimer;
      const deadline=new Promise(resolve=>{deadlineTimer=setTimeout(()=>{resolve({expired:true});preparation.abort();},durationMs);});
      try{
        const prepared=(async()=>{const nextToken=await this.#api.accessToken(connection,{signal:preparation.signal}),nextGateway=await this.#api.gateway(connection,{signal:preparation.signal});return {token:nextToken,gateway:nextGateway};})();
        const result=await Promise.race([prepared.then(value=>({value})),deadline]);
        if(result.expired){if(signal?.aborted)fail('QQBOT_ABORTED');return;}
        ({token,gateway}=result.value);
      }finally{clearTimeout(deadlineTimer);signal?.removeEventListener('abort',relayAbort);}
      remaining=durationMs-(performance.now()-started);if(remaining<=0)return;
    }
    const url=gatewayURL(gateway.url),shards=Number.isInteger(gateway.shards)&&gateway.shards>=1?gateway.shards:1;
    return new Promise((resolve,reject)=>{
      let socket=null,settled=false,sessionId=null,sequence=null,reconnects=0,heartbeat=null,handshake=null,reconnectTimer=null,eventChain=Promise.resolve(),listening=false,awaitingHeartbeatAck=false;
      const duration=durationMs===Infinity?null:setTimeout(()=>finish(),remaining);
      const cleanupSocket=()=>{clearTimeout(handshake);clearInterval(heartbeat);handshake=null;heartbeat=null;awaitingHeartbeatAck=false;if(!socket)return;socket.removeAllListeners?.();closeSocket(socket);socket=null;};
      const cleanup=()=>{if(duration!==null)clearTimeout(duration);clearTimeout(reconnectTimer);signal?.removeEventListener('abort',abort);cleanupSocket();};
      const finish=error=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve();};
      const abort=()=>finish(new QQBotError('QQBOT_ABORTED'));
      const emitState=state=>{if(!onState||settled)return;try{const result=onState(state);if(result&&typeof result.then==='function')throw new Error();}catch{finish(new QQBotError('QQBOT_EVENT_CALLBACK_FAILED'));}};
      const scheduleReconnect=()=>{
        if(settled)return;listening=false;cleanupSocket();if(reconnects>=this.#maxReconnects){finish(new QQBotError('QQBOT_CONNECTION_FAILED'));return;}
        emitState('connecting');if(settled)return;
        reconnects++;reconnectTimer=setTimeout(()=>{void connect();},this.#backoffMs*reconnects);
      };
      const consume=packet=>{
        eventChain=eventChain.then(async()=>{if(settled)return;const keep=await onEvent(packet);if(Number.isInteger(packet.s))sequence=packet.s;if(keep===false)finish();}).catch(()=>finish(new QQBotError('QQBOT_EVENT_CALLBACK_FAILED')));
      };
      const checkpoint=packet=>{eventChain=eventChain.then(()=>{if(!settled&&Number.isInteger(packet.s))sequence=packet.s;}).catch(()=>finish(new QQBotError('QQBOT_EVENT_CALLBACK_FAILED')));};
      const message=(data,isBinary)=>{
        if(settled)return;if(isBinary===true){finish(new QQBotError('QQBOT_PROTOCOL_ERROR'));return;}
        if(frameBytes(data)>MAX_FRAME_BYTES){finish(new QQBotError('QQBOT_FRAME_TOO_LARGE'));return;}
        let packet;try{packet=JSON.parse(frameText(data));}catch{finish(new QQBotError('QQBOT_PROTOCOL_ERROR'));return;}
        if(!plain(packet)||!Number.isInteger(packet.op)){finish(new QQBotError('QQBOT_PROTOCOL_ERROR'));return;}
        if(packet.op===10){
          const interval=packet.d?.heartbeat_interval;if(!Number.isInteger(interval)||interval<1||interval>300_000){finish(new QQBotError('QQBOT_PROTOCOL_ERROR'));return;}
          clearTimeout(handshake);try{socket.send(JSON.stringify(sessionId?{op:6,d:{token:`QQBot ${token}`,session_id:sessionId,seq:sequence}}:{op:2,d:{token:`QQBot ${token}`,intents:1<<25,shard:[0,shards],properties:{'$os':'windows','$browser':'asterhabit','$device':'asterhabit'}}}));}catch{scheduleReconnect();return;}
          handshake=setTimeout(scheduleReconnect,this.#timeoutMs);
          clearInterval(heartbeat);heartbeat=setInterval(()=>{if(awaitingHeartbeatAck){scheduleReconnect();return;}try{socket.send(JSON.stringify({op:1,d:sequence}));awaitingHeartbeatAck=true;}catch{scheduleReconnect();}},interval);return;
        }
        if(packet.op===0&&packet.t==='READY'){
          if(typeof packet.d?.session_id!=='string'||!packet.d.session_id){finish(new QQBotError('QQBOT_PROTOCOL_ERROR'));return;}
          clearTimeout(handshake);sessionId=packet.d.session_id;if(Number.isInteger(packet.s))sequence=packet.s;listening=true;emitState('listening');return;
        }
        if(packet.op===0&&packet.t==='RESUMED'){clearTimeout(handshake);listening=true;checkpoint(packet);emitState('listening');return;}
        if(packet.op===0&&listening&&MESSAGE_EVENTS.has(packet.t)&&plain(packet.d)){consume(packet);return;}
        if(packet.op===0){checkpoint(packet);return;}
        if(packet.op===11){awaitingHeartbeatAck=false;reconnects=0;return;}
        if(packet.op===7){scheduleReconnect();return;}
        if(packet.op===9){sessionId=null;sequence=null;scheduleReconnect();}
      };
      const connect=async()=>{
        if(settled)return;clearTimeout(reconnectTimer);
        if(reconnects>0){try{token=await this.#api.accessToken(connection,{signal});}catch(error){finish(error instanceof QQBotError?error:new QQBotError('QQBOT_CONNECTION_FAILED'));return;}if(settled)return;}
        try{socket=new this.#WebSocket(url,{maxPayload:MAX_FRAME_BYTES,followRedirects:false});}catch{scheduleReconnect();return;}
        handshake=setTimeout(()=>scheduleReconnect(),this.#timeoutMs);
        socket.on('open',()=>{});socket.on('message',message);socket.on('error',scheduleReconnect);socket.on('close',scheduleReconnect);socket.on('unexpected-response',()=>finish(new QQBotError('QQBOT_AUTHENTICATION_FAILED',{confirmedRejected:true})));
      };
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}emitState('connecting');if(!settled)void connect();
    });
  }
}

