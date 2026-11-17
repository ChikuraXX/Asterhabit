import {spawn} from 'node:child_process';

const MAX_VALUE_BYTES=32*1024;
const MAX_CIPHERTEXT_CHARACTERS=32*1024;
const MAX_OUTPUT_BYTES=64*1024;
const TIMEOUT_MS=10_000;
const PURPOSE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BASE64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function safeError(message){return new Error(message);}
function validateSignal(signal){
  if(signal!==undefined&&(!signal||typeof signal!=='object'||typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'))throw safeError('凭据停止信号无效');
  if(signal?.aborted)throw safeError('凭据操作已取消');
}
function canonicalBase64(value){return typeof value==='string'&&value.length>0&&BASE64.test(value)&&value.length%4===0&&Buffer.from(value,'base64').toString('base64')===value;}

/** 创建固定PowerShell脚本的DPAPI CurrentUser codec；非Windows平台始终关闭且没有明文降级。 */
export function createWindowsCredentialCodec({powershell,scriptPath,purpose,platform=process.platform}={}){
  if(typeof purpose!=='string'||!PURPOSE.test(purpose))throw safeError('凭据用途无效');
  const available=platform==='win32';
  if(available&&(typeof powershell!=='string'||!powershell||typeof scriptPath!=='string'||!scriptPath))throw safeError('凭据存储不可用');

  const run=(operation,value,{signal}={})=>{
    if(!available)return Promise.reject(safeError('Windows凭据存储不可用'));
    try{validateSignal(signal);}catch(error){return Promise.reject(error);}
    return new Promise((resolve,reject)=>{
      const child=spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',scriptPath],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
      let stdout=Buffer.alloc(0),stderrBytes=0,settled=false,termination=null;
      const finish=(error,result)=>{
        if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(error)reject(error);else resolve(result);
      };
      const stop=reason=>{if(termination===null)termination=reason;child.kill();};
      const abort=()=>stop('cancelled');
      const timer=setTimeout(()=>stop('timeout'),TIMEOUT_MS);
      signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',chunk=>{if(stdout.length+chunk.length>MAX_OUTPUT_BYTES){stdout=Buffer.alloc(0);stop('output');return;}stdout=Buffer.concat([stdout,chunk]);});
      child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>MAX_OUTPUT_BYTES)stop('output');});
      child.on('error',()=>finish(safeError('凭据操作失败')));
      child.on('close',code=>{
        if(termination==='cancelled'||signal?.aborted){finish(safeError('凭据操作已取消'));return;}
        if(termination!==null||code!==0){finish(safeError('凭据操作失败'));return;}
        try{
          const parsed=JSON.parse(stdout.toString('utf8'));
          if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).length!==1||typeof parsed.result!=='string')throw new Error('invalid result');
          finish(null,parsed.result);
        }catch{finish(safeError('凭据操作失败'));}
      });
      child.stdin.on('error',()=>{});
      try{child.stdin.end(JSON.stringify({operation,value,purpose}),'utf8');}catch{stop('startup');child.stdin.destroy();}
    });
  };

  return Object.freeze({
    available,
    async protect(plaintext,options){
      if(typeof plaintext!=='string')throw safeError('凭据内容无效');
      if(Buffer.byteLength(plaintext,'utf8')>MAX_VALUE_BYTES)throw safeError('凭据内容过长');
      const ciphertext=await run('protect',plaintext,options);
      if(ciphertext.length>MAX_CIPHERTEXT_CHARACTERS)throw safeError('凭据密文过长');
      if(!canonicalBase64(ciphertext))throw safeError('凭据操作失败');
      return ciphertext;
    },
    async unprotect(ciphertext,options){
      if(typeof ciphertext!=='string')throw safeError('凭据密文无效');
      if(ciphertext.length>MAX_CIPHERTEXT_CHARACTERS)throw safeError('凭据密文过长');
      if(!canonicalBase64(ciphertext))throw safeError('凭据密文无效');
      const plaintext=await run('unprotect',ciphertext,options);
      if(Buffer.byteLength(plaintext,'utf8')>MAX_VALUE_BYTES)throw safeError('凭据操作失败');
      return plaintext;
    }
  });
}

