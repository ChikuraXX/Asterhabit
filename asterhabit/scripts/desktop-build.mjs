import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const localCargo=path.join(root,'tools','cargo','bin');
const environment={...process.env,NPM_CONFIG_CACHE:path.join(root,'cache','npm')};
if(existsSync(path.join(localCargo,process.platform==='win32'?'cargo.exe':'cargo'))) {
  const inherited=Object.entries(environment).find(([key])=>key.toLowerCase()==='path')?.[1]??'';
  for(const key of Object.keys(environment))if(key.toLowerCase()==='path')delete environment[key];
  environment[process.platform==='win32'?'Path':'PATH']=localCargo+path.delimiter+inherited;
  environment.CARGO_HOME=path.join(root,'tools','cargo');
  environment.RUSTUP_HOME=path.join(root,'tools','rustup');
}
delete environment.NODE_OPTIONS;
const cli=path.join(root,'desktop','node_modules','@tauri-apps','cli','tauri.js');
if(!existsSync(cli))throw new Error('请先在 desktop 目录执行 npm ci');
const child=spawn(process.execPath,[cli,'build','--no-bundle','--config',path.join(root,'desktop','src-tauri','tauri.conf.json'),'--','--locked'],{cwd:root,env:environment,stdio:'inherit',windowsHide:true});
child.once('error',()=>{console.error('构建工具启动失败');process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});

