import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {classifyGenerationFailure} from './generation-failure.mjs';

const MESSAGES={CODEX_START_FAILED:'Codex启动失败',CODEX_EXITED:'Codex执行进程已退出',CODEX_REQUEST_FAILED:'Codex请求未完成',CODEX_PROTOCOL_ERROR:'Codex协议响应无效',CODEX_TIMEOUT:'Codex请求超时',CODEX_CLOSE_TIMEOUT:'Codex进程退出尚未确认',CANCELLED:'本轮已停止'};
/** 协议错误仅暴露固定类别，原始stderr和远端正文不越过边界。 */
export function codexError(code){const error=new Error(MESSAGES[code]??MESSAGES.CODEX_REQUEST_FAILED);error.code=code;return error;}

/** 自有Codex进程的有界JSONL传输；不连接或终止其他会话进程。 */
export class CodexClient {
 #child;#pending=new Map();#listeners=new Set();#failureListeners=new Set();#id=0;#buffer='';#decoder=new StringDecoder('utf8');#failure=null;#stopping=false;#exited=false;#exit;#resolveExit;#timeout;#maxFrame;#closeTimeout;
 constructor({command,args=['app-server','--stdio'],cwd,env,spawnProcess=spawn,requestTimeoutMs=30000,maxFrameBytes=2*1024*1024,closeTimeoutMs=5000}){
  this.#timeout=requestTimeoutMs;this.#maxFrame=maxFrameBytes;this.#closeTimeout=closeTimeoutMs;
  this.#exit=new Promise(resolve=>{this.#resolveExit=resolve;});
  this.#child=spawnProcess(command,args,{cwd,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  this.#child.on('error',()=>{this.#fail(codexError('CODEX_START_FAILED'));});
  this.#child.on('close',()=>{this.#exited=true;this.#fail(codexError('CODEX_EXITED'),false);this.#resolveExit();});
  this.#child.stdin.on('error',()=>this.#fail(codexError('CODEX_EXITED')));
  this.#child.stdout.on('data',chunk=>this.#read(chunk));
  this.#child.stdout.on('error',()=>this.#fail(codexError('CODEX_PROTOCOL_ERROR')));
  this.#child.stderr.on('data',()=>{});
  this.#child.stderr.on('error',()=>{});
 }
 get pid(){return this.#child.pid;}
 get connected(){return !this.#failure&&!this.#exited&&!this.#stopping;}
 /** 订阅只读通知；返回解除函数，观察者异常使本次执行失败。 */
 onNotification(listener){this.#listeners.add(listener);return ()=>this.#listeners.delete(listener);}
 /** 执行中的连接故障立即通知适配器，避免等待业务超时后才停止。 */
 onFailure(listener){this.#failureListeners.add(listener);if(this.#failure)listener(this.#failure);return ()=>this.#failureListeners.delete(listener);}
 #send(frame){if(!this.connected)throw this.#failure??codexError('CODEX_EXITED');this.#child.stdin.write(JSON.stringify(frame)+'\n');}
 notify(method,params={}){this.#send({method,params});}
 #read(chunk){
  if(this.#failure)return;
  this.#buffer+=this.#decoder.write(chunk);
  let end;
  while((end=this.#buffer.indexOf('\n'))>=0){
   const line=this.#buffer.slice(0,end);this.#buffer=this.#buffer.slice(end+1);
   if(Buffer.byteLength(line)>this.#maxFrame){this.#fail(codexError('CODEX_PROTOCOL_ERROR'));return;}
   if(!line.trim())continue;
   try{
    const frame=JSON.parse(line);
    if(!frame||typeof frame!=='object'||Array.isArray(frame))throw new Error();
    if(typeof frame.method==='string'){
     if(Object.hasOwn(frame,'id'))this.#send({id:frame.id,error:{code:-32601,message:'Unsupported client request'}});
     else for(const listener of this.#listeners)listener(frame);
    }else if(Object.hasOwn(frame,'id')){
     const pending=this.#pending.get(frame.id);if(!pending)continue;
     if(Object.hasOwn(frame,'error')){const error=codexError('CODEX_REQUEST_FAILED');error.failureCode=classifyGenerationFailure(frame.error).code;if(Number.isInteger(frame.error?.code))error.rpcCode=frame.error.code;const missing=/missing field `([A-Za-z][A-Za-z0-9_]{0,60})`/.exec(frame.error?.message??'');if(missing)error.missingField=missing[1];pending.finish(error);}
     else if(Object.hasOwn(frame,'result'))pending.finish(null,frame.result);else throw new Error();
    }else throw new Error();
   }catch{this.#fail(codexError('CODEX_PROTOCOL_ERROR'));return;}
  }
  if(Buffer.byteLength(this.#buffer)>this.#maxFrame)this.#fail(codexError('CODEX_PROTOCOL_ERROR'));
 }
 #fail(error,stop=true){
  if(!this.#failure){this.#failure=error;for(const listener of this.#failureListeners)listener(error);}
  for(const pending of [...this.#pending.values()])pending.finish(this.#failure);
  if(stop)this.#stop();
 }
 #stop(){if(this.#stopping||this.#exited)return;this.#stopping=true;this.#child.stdin.end();this.#child.kill();}
 /** 请求ID唯一，超时/取消终止自有进程，避免结果不明时继续复用。 */
 request(method,params={}, {signal,timeoutMs=this.#timeout}={}){
  if(signal?.aborted)return Promise.reject(codexError('CANCELLED'));
  if(!this.connected)return Promise.reject(this.#failure??codexError('CODEX_EXITED'));
  const id=++this.#id;
  return new Promise((resolve,reject)=>{
   const finish=(error,result)=>{const entry=this.#pending.get(id);if(!entry)return;this.#pending.delete(id);clearTimeout(entry.timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
   const abort=()=>this.#fail(codexError('CANCELLED'));
   const timer=setTimeout(()=>this.#fail(codexError('CODEX_TIMEOUT')),timeoutMs);
   this.#pending.set(id,{finish,timer});signal?.addEventListener('abort',abort,{once:true});
   try{this.#send({id,method,params});}catch{this.#fail(codexError('CODEX_EXITED'));}
  });
 }
 /** 幂等关闭并等待退出回执；超时不能报告清理完成。 */
 async close(){
  if(this.#exited)return;
  this.#fail(codexError('CODEX_EXITED'));
  let timer;try{await Promise.race([this.#exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(codexError('CODEX_CLOSE_TIMEOUT')),this.#closeTimeout);})]);}finally{clearTimeout(timer);}
 }
}
