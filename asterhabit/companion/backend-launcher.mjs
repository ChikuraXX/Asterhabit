import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {backendError,readBackendOwner,connectBackend} from './backend-service.mjs';
import {processIdentityProbe} from './process-identity.mjs';

/** 连接已有后台，否则有界启动一次；传输失败不重放任何业务请求。 */
export async function connectOrStartBackend({root,state=path.join(root,'state'),workerScript=path.join(root,'scripts','backend-worker.mjs'),timeoutMs=25000,spawnProcess=spawn}){
 let child=null,spawnFailed=false,probe=null;const deadline=Date.now()+timeoutMs;
 const start=()=>{if(child)return;const env={...process.env};delete env.NODE_OPTIONS;delete env.NODE_PATH;child=spawnProcess(process.execPath,[workerScript],{cwd:root,env,windowsHide:true,detached:true,stdio:'ignore'});child.on('error',()=>{spawnFailed=true;});child.unref();};
 while(Date.now()<deadline){
  let owner;try{owner=readBackendOwner(state);}catch(error){if(error.code!=='BACKEND_STARTING')throw error;}
  if(owner){
   try{return await connectBackend(owner,{timeoutMs:1000});}catch(error){if(error.code==='BACKEND_AUTH_FAILED'||error.code==='BACKEND_PROTOCOL_ERROR')throw error;}
   if(!probe){const config=JSON.parse(readFileSync(path.join(root,'local-runtime.json'),'utf8'));probe=processIdentityProbe(process.platform==='win32'?path.join(config.powershellDirectory,'pwsh.exe'):undefined);}
   if(!probe.isAlive(owner))start();
  }else start();
  if(spawnFailed||child?.exitCode!==null&&child?.exitCode!==undefined&&child.exitCode!==0)throw backendError('BACKEND_UNAVAILABLE');
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 throw backendError('BACKEND_TIMEOUT');
}
