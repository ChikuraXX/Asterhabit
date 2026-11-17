import {execFileSync} from 'node:child_process';
import {getProcessStart} from '../scripts/process-start.mjs';
/** 复用现有进程创建时间算法；Windows仅用主人配置的PowerShell路径，未知身份一律按存活处理。 */
export function processIdentityProbe(powershell) {
  const read=pid=>getProcessStart(pid,process.platform,(executable,args,options)=>execFileSync(process.platform==='win32'&&powershell?powershell:executable,args,{...options,encoding:'utf8',windowsHide:true}),2000);
  const identity={pid:process.pid,start:read(process.pid)};
  return {identity,isAlive(owner){
    if(owner.pid===identity.pid)return owner.start===null||identity.start===null||owner.start===identity.start;
    try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')return false;return true;}
    const actual=read(owner.pid);return actual===null||owner.start===null||actual===owner.start;
  }};
}
