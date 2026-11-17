import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),state=path.join(root,'state');
import {migrateApplication} from '../companion/application-migration.mjs';
/** 枚举失败时停止，不将未知状态视为没有旧写者。 */
function assertOffline(){if(process.platform!=='win32')throw new Error('当前离线迁移检查仅在Windows验收，未迁移。');const config=JSON.parse(readFileSync(path.join(root,'local-runtime.json'),'utf8'));const raw=execFileSync(path.join(config.powershellDirectory,'pwsh.exe'),['-NoProfile','-NonInteractive','-File',path.join(root,'scripts','find-application-writers.ps1'),'-ProjectRoot',root],{encoding:'utf8',timeout:15000,windowsHide:true});const writers=JSON.parse(raw);if(!Array.isArray(writers))throw new Error('无法确认旧写者状态');if(writers.length)throw new Error('请先关闭旧控制台/聊天CLI；仍运行的PID：'+writers.map(w=>w.pid).join(', '));}
try{const result=migrateApplication({root,state,assertOffline});console.log(JSON.stringify({protocol:result.protocol,completed:true,alreadyComplete:result.alreadyComplete,backup:result.backup}));}catch(error){console.error(error.message);process.exitCode=1;}
