import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {CodexClient} from './codex-client.mjs';import {prepareCodexEnvironment,verifiedCodexExecutable} from './codex-environment.mjs';import {codexProcessIdentity,stopOwnedCodexProcess} from './codex-process-owner.mjs';

/** 仅回收本目录已证明失去宿主的执行进程，持久线程资料不删除。 */
export function recoverPersistentOwner(directory,powershellDirectory){const lock=path.join(directory,'owner'),file=path.join(lock,'identity.json');if(!fs.existsSync(lock))return;let owner;try{owner=JSON.parse(fs.readFileSync(file,'utf8'));if(!Number.isInteger(owner.pid)||owner.pid<1||!Number.isInteger(owner.childPid)||owner.childPid<1||!/^\d+$/.test(owner.parentStart??'')||!/^\d+$/.test(owner.childStart??''))throw Error();}catch{throw Error('持久Codex进程所有权未确认，停止恢复');}
 const parent=codexProcessIdentity(owner.pid,powershellDirectory);if(parent===owner.parentStart)throw Error('另一宿主仍持有此Agent的Codex连接');
 if(parent===null){try{process.kill(owner.pid,0);throw Error('持久Codex宿主身份不明');}catch(error){if(error.code!=='ESRCH')throw error;}}
 stopOwnedCodexProcess(owner,powershellDirectory);fs.unlinkSync(file);fs.rmdirSync(lock);fs.rmSync(path.join(directory,'home/auth.json'),{force:true});
}
/** 自有常驻进程；完全退出只移除凭据与所有权，不删除会话存储。 */
export async function openPersistentCodexProcess(directory,options,authorized){
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 if(process.platform==='win32')execFileSync(path.join(options.powershellDirectory,'pwsh.exe'),['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../scripts/protect-backend-directory.ps1',import.meta.url)),'-Directory',directory],{windowsHide:true,stdio:'pipe',timeout:10000});
 recoverPersistentOwner(directory,options.powershellDirectory);const lock=path.join(directory,'owner');fs.mkdirSync(lock);const token=randomUUID();let client,owner;
 try{const command=verifiedCodexExecutable(options.codexExecutable,options.codexExecutableSha256),prepared=prepareCodexEnvironment({directory,authorizedSnapshot:authorized,expectedIdentity:authorized.identity});client=(options.createClient??(input=>new CodexClient(input)))({command,cwd:prepared.cwd,env:prepared.env});owner={pid:process.pid,parentStart:codexProcessIdentity(process.pid,options.powershellDirectory),childPid:client.pid,childStart:codexProcessIdentity(client.pid,options.powershellDirectory),token};if(!owner.parentStart||!owner.childStart)throw Error('持久Codex进程身份未确认');const temporary=path.join(lock,'publishing.json');fs.writeFileSync(temporary,JSON.stringify(owner),{mode:0o600});fs.renameSync(temporary,path.join(lock,'identity.json'));
  return {client,cwd:prepared.cwd,cleanup:async()=>{const current=JSON.parse(fs.readFileSync(path.join(lock,'identity.json'),'utf8'));if(current.token!==token)throw Error('持久Codex所有权变化');fs.rmSync(path.join(directory,'home/auth.json'),{force:true});fs.unlinkSync(path.join(lock,'identity.json'));fs.rmdirSync(lock);}};
 }catch(error){try{if(client)await client.close();}finally{fs.rmSync(path.join(directory,'home/auth.json'),{force:true});}fs.rmSync(path.join(directory,'home/auth.json'),{force:true});if(fs.existsSync(path.join(lock,'identity.json')))fs.unlinkSync(path.join(lock,'identity.json'));if(fs.existsSync(path.join(lock,'publishing.json')))fs.unlinkSync(path.join(lock,'publishing.json'));fs.rmdirSync(lock);throw error;}
}
