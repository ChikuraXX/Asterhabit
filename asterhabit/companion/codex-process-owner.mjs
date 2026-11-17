import {execFileSync} from 'node:child_process';
import path from 'node:path';

/** 获取Windows进程创建标识；无法证明身份时返回null，恢复方不得按PID猜测。 */
export function codexProcessIdentity(pid,powershellDirectory){
 if(!Number.isInteger(pid)||pid<1||process.platform!=='win32'||!powershellDirectory)return null;
 try{return execFileSync(path.join(powershellDirectory,'pwsh.exe'),['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById(${pid});$p.StartTime.ToUniversalTime().Ticks.ToString()`],{encoding:'utf8',windowsHide:true,timeout:3000}).trim();}catch{return null;}
}
/** 精确匹配进程创建标识后通过同一Process对象终止孤儿，PID复用不终止新进程。 */
export function stopOwnedCodexProcess(owner,powershellDirectory){
 if(!Number.isInteger(owner.childPid)||!/^\d+$/.test(owner.childStart??'')||!powershellDirectory)throw new Error('Codex旧进程身份不完整，需人工核实恢复');
 const result=execFileSync(path.join(powershellDirectory,'pwsh.exe'),['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop';try{$p=[Diagnostics.Process]::GetProcessById(${owner.childPid})}catch [ArgumentException]{'absent';exit 0};if($p.StartTime.ToUniversalTime().Ticks.ToString() -ne '${owner.childStart}'){'reused';exit 0};$p.Kill();if(!$p.WaitForExit(5000)){throw 'Exit not confirmed'};'stopped'`],{encoding:'utf8',windowsHide:true,timeout:8000}).trim();
 if(!['absent','reused','stopped'].includes(result))throw new Error('Codex旧进程退出未确认');
}
