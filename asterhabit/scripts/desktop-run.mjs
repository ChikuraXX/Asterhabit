import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertApplicationProtocol} from '../companion/application-migration.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assertApplicationProtocol(path.join(root,'state'));
const executable=path.join(root,'desktop','src-tauri','target','release','letta-companion-desktop'+(process.platform==='win32'?'.exe':''));
if(!existsSync(executable))throw new Error('尚未生成桌面应用，请先运行 node scripts/desktop-build.mjs');
const environment={...process.env,COMPANION_ROOT:root,COMPANION_NODE:process.execPath};
// 普通启动不继承验收浏览器参数；发行程序也没有 desktop-testing feature。
delete environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
delete environment.NODE_OPTIONS;
const child=spawn(executable,[],{cwd:root,env:environment,detached:true,stdio:'ignore',windowsHide:false});
child.once('error',()=>{console.error('桌面应用启动失败');process.exitCode=1;});
child.once('spawn',()=>{child.unref();console.log('Asterhabit 已启动');});

