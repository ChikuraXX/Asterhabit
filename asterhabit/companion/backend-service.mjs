import net from 'node:net';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readdirSync,readFileSync,writeFileSync,unlinkSync,rmdirSync,chmodSync,existsSync,lstatSync,openSync,closeSync,fsyncSync,renameSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {fileURLToPath} from 'node:url';
import {AgentError} from './agent-registry.mjs';
import {DesktopError} from './desktop-host.mjs';
import {MemoryError} from './memory-store.mjs';
import {ControlError} from './control-store.mjs';
import {CharacterError} from './character-store.mjs';
import {ContentError} from './content-store.mjs';
import {BilibiliAccountError} from './bilibili-account-store.mjs';
import {BilibiliError} from './bilibili-readonly.mjs';
import {QQError} from './qq-store.mjs';
import {OneBotError} from './onebot-client.mjs';
import {QQBotError} from './qqbot-client.mjs';

const MAX_FRAME=1048576;
const OWNER=/^owner-[0-9a-f-]{36}\.json$/;
/** 传输错误使用固定信息，不回显请求、令牌、路径或系统异常。 */
export function backendError(code){const messages={BACKEND_ALREADY_RUNNING:'后台已在运行',BACKEND_STARTING:'后台启动尚未确认',BACKEND_AUTH_FAILED:'后台连接认证失败',BACKEND_UNAVAILABLE:'后台已断开，请重新打开应用',BACKEND_PROTOCOL_ERROR:'后台通信格式无效',BACKEND_TIMEOUT:'后台操作超时',BACKEND_CLEANUP_FAILED:'后台清理未完成，请检查恢复状态'};const error=new Error(messages[code]??messages.BACKEND_UNAVAILABLE);error.code=code;return error;}
/** 地址只由可信状态目录生成，不接受renderer指定地址或端口。 */
export function backendLocation(state){const directory=path.join(path.resolve(state),'runtime','backend'),key=createHash('sha256').update(process.platform==='win32'?path.resolve(state).toLowerCase():path.resolve(state)).digest('hex').slice(0,24);return {directory,lock:path.join(directory,'owner'),endpoint:process.platform==='win32'?`\\\\.\\pipe\\asterhabit-${key}`:path.join(directory,'control.sock')};}
/** Windows令牌继承用户/SYSTEM专用ACL；Unix使用0700目录。 */
export function secureBackendDirectory(directory,powershell){mkdirSync(directory,{recursive:true,mode:0o700});if(process.platform==='win32'){if(!powershell)throw backendError('BACKEND_STARTING');execFileSync(powershell,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../scripts/protect-backend-directory.ps1',import.meta.url)),'-Directory',directory],{windowsHide:true,timeout:10000,stdio:'pipe'});}else chmodSync(directory,0o700);}
function validOwner(value){return value&&value.protocol===1&&Number.isInteger(value.pid)&&value.pid>0&&(value.start===null||typeof value.start==='string')&&/^[a-f0-9]{64}$/.test(value.token)&&/^[0-9a-f-]{36}$/.test(value.instance);}
/** 仅读取固定私有目录的一份不可变所有权记录；空目录不被当成死亡进程。 */
export function readBackendOwner(state){const location=backendLocation(state);try{const names=readdirSync(location.lock);if(names.length!==1||!OWNER.test(names[0]))throw backendError('BACKEND_STARTING');const file=path.join(location.lock,names[0]);if(lstatSync(file).size>4096)throw backendError('BACKEND_PROTOCOL_ERROR');const value=JSON.parse(readFileSync(file,'utf8'));if(!validOwner(value))throw backendError('BACKEND_PROTOCOL_ERROR');return {...value,endpoint:location.endpoint,file};}catch(error){if(error.code==='ENOENT')return null;if(error.code?.startsWith('BACKEND_'))throw error;throw backendError('BACKEND_PROTOCOL_ERROR');}}
function writeFrame(socket,frame){if(!socket.destroyed)socket.write(JSON.stringify(frame)+'\n');}
function readFrames(socket,accept,fail){let buffer='';const decoder=new StringDecoder('utf8');socket.on('data',chunk=>{buffer+=decoder.write(chunk);let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(Buffer.byteLength(line)>MAX_FRAME){fail();return;}try{accept(JSON.parse(line));}catch{fail();return;}if(socket.destroyed)return;}if(Buffer.byteLength(buffer)>MAX_FRAME)fail();});}
function alive(owner){try{process.kill(owner.pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
function safeFailure(error,operation){const safe=[AgentError,DesktopError,MemoryError,ControlError,CharacterError,ContentError,BilibiliAccountError,BilibiliError,QQError,QQBotError,OneBotError].some(type=>error instanceof type);const code=safe?error.code??'OPERATION_FAILED':'INTERNAL',message=safe?error.message:'本次操作未完成，请检查后台状态';return {ok:false,error:message,code,...(operation?.startsWith('model.connection.')||operation==='model.catalogue.refresh'?{modelConnectionError:{modelConnectionError:true,code,message}}:{})};}

/** 后台独占应用实例，认证客户端可共享；窗口断开是否停止由持久化配置决定。 */
export async function createBackendService({state,app,applicationFactory,identity={pid:process.pid,start:null},isAlive=alive,secureDirectory=secureBackendDirectory,powershell,startupIdleMs=15000}){
 const location=backendLocation(state);mkdirSync(location.directory,{recursive:true,mode:0o700});await secureDirectory(location.directory,powershell);
 const instance=randomUUID(),token=randomBytes(32).toString('hex'),file=path.join(location.lock,`owner-${instance}.json`);
 let claimed=false;
 try{mkdirSync(location.lock,{mode:0o700});claimed=true;}catch(error){
  if(error.code!=='EEXIST')throw error;const previous=readBackendOwner(state);
  if(!previous||isAlive(previous))throw backendError(previous?'BACKEND_ALREADY_RUNNING':'BACKEND_STARTING');
  // 只删除自己验证过的唯一旧文件；失败者不再删除目录，避免移除新拥有者的发布窗口。
  try{unlinkSync(previous.file);rmdirSync(location.lock);mkdirSync(location.lock,{mode:0o700});claimed=true;}catch{throw backendError('BACKEND_STARTING');}
 }
 const metadata={protocol:1,pid:identity.pid,start:identity.start,instance,token,endpoint:location.endpoint};
 const temporary=path.join(location.lock,`publishing-${instance}.tmp`);
 try{const handle=openSync(temporary,'wx',0o600);try{writeFileSync(handle,JSON.stringify({protocol:1,pid:identity.pid,start:identity.start,instance,token}));fsyncSync(handle);}finally{closeSync(handle);}renameSync(temporary,file);}
 catch(error){if(existsSync(temporary))unlinkSync(temporary);rmdirSync(location.lock);throw error;}
 const release=()=>{try{unlinkSync(file);rmdirSync(location.lock);}catch(error){if(error.code!=='ENOENT')throw error;}};
 let application;try{application=app??await applicationFactory();}catch(error){release();throw error;}
 const clients=new Set(),sockets=new Set();let closing=null,resolveClosed,idleTimer;
 const closed=new Promise(resolve=>{resolveClosed=resolve;});
 const server=net.createServer(socket=>{
  if(closing||sockets.size>=32){socket.destroy();return;}sockets.add(socket);let authenticated=false;const ids=new Set();
  const timer=setTimeout(()=>socket.destroy(),3000);timer.unref();
  const fail=()=>socket.destroy();socket.on('error',()=>{});
  socket.on('close',()=>{clearTimeout(timer);sockets.delete(socket);if(authenticated){clients.delete(socket);void idle();}});
  readFrames(socket,frame=>{
   if(!authenticated){
    const valid=frame&&frame.type==='hello'&&frame.protocol===1&&typeof frame.token==='string'&&frame.token.length===64&&Object.keys(frame).every(key=>['type','protocol','token'].includes(key))&&timingSafeEqual(Buffer.from(frame.token),Buffer.from(token));
    if(!valid){writeFrame(socket,{type:'rejected',code:'BACKEND_AUTH_FAILED'});socket.end();return;}
    authenticated=true;clearTimeout(timer);clearTimeout(idleTimer);clients.add(socket);writeFrame(socket,{type:'ready',protocol:1,instance});return;
   }
   if(!frame||typeof frame!=='object'||Array.isArray(frame)||Object.keys(frame).some(key=>!['id','operation','payload'].includes(key))||typeof frame.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(frame.id)||typeof frame.operation!=='string'||!frame.payload||typeof frame.payload!=='object'||Array.isArray(frame.payload)){fail();return;}
   const max=['agent.create','agent.update','agent.profile.parse'].includes(frame.operation)?MAX_FRAME:131072;
   if(Buffer.byteLength(JSON.stringify(frame))>max){writeFrame(socket,{id:frame.id,ok:false,code:'INVALID_REQUEST',error:'请求内容过长'});return;}
   if(ids.has(frame.id)||ids.size>=32&&!['chat.cancel','runtime.pause','agent.pause','host.shutdown','host.detach'].includes(frame.operation)){writeFrame(socket,{id:frame.id,ok:false,code:'BUSY',error:'请求过多或编号重复'});return;}
   ids.add(frame.id);void dispatch(frame,socket).catch(()=>{writeFrame(socket,{id:frame.id,ok:false,code:'INTERNAL',error:'后台操作未完成'});}).finally(()=>ids.delete(frame.id));
  },fail);
 });
 async function idle(){if(closing||clients.size)return;try{const snapshot=await application.request('app.snapshot',{});if(!clients.size&&!snapshot.application.keepRunningOnClose)await close();}catch{if(!closing)await close().catch(()=>{});}}
 async function dispatch(frame,socket){
  if(closing){writeFrame(socket,{id:frame.id,ok:false,code:'CLOSING',error:'后台正在退出'});return;}
  if(['host.shutdown','host.detach'].includes(frame.operation)){
   if(Object.keys(frame.payload).length){writeFrame(socket,{id:frame.id,ok:false,code:'INVALID_REQUEST',error:'退出参数无效'});return;}
   if(frame.operation==='host.shutdown'){await close(error=>writeFrame(socket,{id:frame.id,ok:!error,...(error?{code:'BACKEND_CLEANUP_FAILED',error:'后台清理未完成'}:{result:{closed:true}})}));return;}
   clients.delete(socket);const snapshot=await application.request('app.snapshot',{});
   if(!clients.size&&!snapshot.application.keepRunningOnClose){await close(error=>writeFrame(socket,{id:frame.id,ok:!error,...(error?{code:'BACKEND_CLEANUP_FAILED',error:'后台清理未完成'}:{result:{detached:true,backgroundRunning:false}})}));}
   else{writeFrame(socket,{id:frame.id,ok:true,result:{detached:true,backgroundRunning:true}});socket.end();}return;
  }
  try{const result=await application.request(frame.operation,frame.payload);writeFrame(socket,{id:frame.id,ok:true,result});}catch(error){writeFrame(socket,{id:frame.id,...safeFailure(error,frame.operation)});}
 }
 function close(beforeDisconnect=()=>{}){
  if(closing)return closing;
  closing=(async()=>{
   clearTimeout(idleTimer);const listenerClosed=new Promise(resolve=>server.close(resolve));let error;
   try{await application.close();}catch(cause){error=cause;}
   beforeDisconnect(error);for(const socket of sockets)socket.end();
   const timer=setTimeout(()=>{for(const socket of sockets)socket.destroy();},1000);
   try{await listenerClosed;release();}finally{clearTimeout(timer);resolveClosed({closed:true,cleanupFailed:Boolean(error)});}
   if(error)throw backendError('BACKEND_CLEANUP_FAILED');
  })();return closing;
 }
 try{
  if(process.platform!=='win32'&&existsSync(location.endpoint)){if(!lstatSync(location.endpoint).isSocket())throw backendError('BACKEND_PROTOCOL_ERROR');unlinkSync(location.endpoint);}
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(location.endpoint,()=>{server.removeListener('error',reject);resolve();});});
 }catch(error){await application.close();if(claimed)release();throw error;}
 server.on('error',()=>{void close().catch(()=>{});});idleTimer=setTimeout(()=>{void idle();},startupIdleMs);idleTimer.unref();
 return {metadata,closed,close};
}

/** 已认证IPC客户端；断开时不自动重发，避免副作用结果未知后重复执行。 */
export async function connectBackend(metadata,{timeoutMs=15000}={}){
 const socket=net.createConnection(metadata.endpoint),pending=new Map();let ready=false,failed=false,resolveReady,rejectReady;
 const connected=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const failure=error=>{if(failed)return;failed=true;clearTimeout(timer);if(!ready)rejectReady(error);for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error);}pending.clear();socket.destroy();};
 const timer=setTimeout(()=>failure(backendError('BACKEND_TIMEOUT')),timeoutMs);
 socket.on('error',()=>failure(backendError('BACKEND_UNAVAILABLE')));socket.on('close',()=>failure(backendError('BACKEND_UNAVAILABLE')));
 socket.on('connect',()=>writeFrame(socket,{type:'hello',protocol:1,token:metadata.token}));
 readFrames(socket,frame=>{
  if(!ready){if(frame?.type==='rejected'){failure(backendError('BACKEND_AUTH_FAILED'));return;}if(frame?.type!=='ready'||frame.protocol!==1||frame.instance!==metadata.instance){failure(backendError('BACKEND_PROTOCOL_ERROR'));return;}ready=true;clearTimeout(timer);resolveReady();return;}
  const entry=pending.get(frame.id);if(!entry)return;pending.delete(frame.id);clearTimeout(entry.timer);entry.resolve(frame);
 },()=>failure(backendError('BACKEND_PROTOCOL_ERROR')));
 await connected;
 return {instance:metadata.instance,request(operation,payload={}){if(failed)return Promise.reject(backendError('BACKEND_UNAVAILABLE'));const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(backendError('BACKEND_TIMEOUT'));},operation.startsWith('host.')?65000:210000);pending.set(id,{resolve,reject,timer});writeFrame(socket,{id,operation,payload});});},close(){socket.end();}};
}
