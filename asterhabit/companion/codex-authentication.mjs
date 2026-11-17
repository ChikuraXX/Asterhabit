import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {readCodexAuthentication} from './codex-environment.mjs';
import {ModelGenerationError} from './generation-failure.mjs';
import {CodexClient} from './codex-client.mjs';
import {verifiedCodexExecutable} from './codex-environment.mjs';

/** 仅使用Codex原生认证操作续期源登录；不创建线程、不复制刷新令牌、不改用户配置。 */
async function refreshNative(sourceAuthPath,executable,sha256){
 const env={};for(const key of ['PATH','Path','SystemRoot','WINDIR','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP','HTTP_PROXY','HTTPS_PROXY','NO_PROXY'])if(process.env[key])env[key]=process.env[key];env.CODEX_HOME=path.dirname(sourceAuthPath);
 const client=new CodexClient({command:verifiedCodexExecutable(executable,sha256),args:['app-server','--stdio','-c','model_provider="openai"'],env,cwd:path.dirname(sourceAuthPath)});
 try{await client.request('initialize',{clientInfo:{name:'asterhabit_auth',title:'Asterhabit',version:'0.1.0'}});client.notify('initialized');await client.request('account/read',{refreshToken:true});}finally{await client.close();}
}

/** 所有角色共用的账号身份门；仅持久化指纹，不搬运Letta凭据或刷新源登录。 */
export class CodexAuthentication {
 #source;#file;#identity;#closed=false;#legacyAnchor;#refresh;#pending;#retryAt=0;#refreshFailures=0;#refreshExpiry=null;
 constructor({state,sourceAuthPath,refresh,codexExecutable,codexExecutableSha256}){this.#source=sourceAuthPath;this.#file=path.join(state,'codex-account.json');this.#refresh=refresh??(()=>refreshNative(sourceAuthPath,codexExecutable,codexExecutableSha256));if(existsSync(this.#file)){const value=JSON.parse(readFileSync(this.#file,'utf8'));if(!/^[a-f0-9]{64}$/.test(value.identity))throw new Error('Codex账号绑定记录无效');this.#identity=value.identity;}const legacy=path.join(state,'codex-session-link.json');if(existsSync(legacy))this.#legacyAnchor=JSON.parse(readFileSync(legacy,'utf8')).expectedIdentity;}
 #inspect(allowExpired=false){if(this.#closed)throw new ModelGenerationError({code:'authentication_source_unavailable'},null);const value=readCodexAuthentication(this.#source,this.#identity,{allowExpired});if(this.#legacyAnchor&&(value.accountHash!==this.#legacyAnchor.accountHash||value.subjectHash!==this.#legacyAnchor.subjectHash))throw new ModelGenerationError({code:'authentication_account_mismatch'},null);return value;}
 status(){try{const value=this.#inspect();return {state:'ready',code:null,expiresAt:new Date(value.snapshot.expires_at).toISOString(),lastSyncedAt:null};}catch(error){return {state:'stopped',code:error.failureCode??'authentication_source_unavailable',expiresAt:null,lastSyncedAt:null};}}
 async synchronize({exclusive=operation=>operation()}={}){
  if(this.#pending)return this.#pending;const status=this.status();if(status.state==='ready'){this.#refreshFailures=0;this.#retryAt=0;return status;}if(status.code!=='authentication_source_expired')return status;
  let before;try{before=this.#inspect(true);}catch{return this.status();}
  if(this.#refreshExpiry!==before.snapshot.expires_at){this.#refreshExpiry=before.snapshot.expires_at;this.#refreshFailures=0;this.#retryAt=0;}
  if(this.#refreshFailures>=3||Date.now()<this.#retryAt)return status;
  this.#pending=(async()=>{try{this.#identity??=before.identity;await exclusive(async()=>{await this.#refresh();this.#inspect();return {credentialChanged:true};});}catch{this.#refreshFailures++;this.#retryAt=Date.now()+300000;}return this.status();})();
  try{return await this.#pending;}finally{this.#pending=null;}
 }
 /** 生成进程使用同一次已授权快照，避免核验后再次读源时换号。 */
 authorizeSnapshot(){this.assertForModel('openai-codex/authentication');return this.#inspect();}
 /** 提交前再次验证源身份；首次使用以排他创建方式固定账号，换号必须显式迁移。 */
 assertForModel(model){
  if(!/^(?:openai-codex|chatgpt-plus-pro|codex)\//.test(model??''))throw new ModelGenerationError({code:'model_unavailable'},null);
  const value=this.#inspect();
  if(!existsSync(this.#file)){
   mkdirSync(path.dirname(this.#file),{recursive:true});
   try{writeFileSync(this.#file,JSON.stringify({identity:value.identity}),{flag:'wx',mode:0o600});}
   catch(error){if(error.code!=='EEXIST')throw error;const saved=JSON.parse(readFileSync(this.#file,'utf8'));if(saved.identity!==value.identity)throw new ModelGenerationError({code:'authentication_account_mismatch'},null);}
  }
  const pinned=JSON.parse(readFileSync(this.#file,'utf8'));if(pinned.identity!==value.identity)throw new ModelGenerationError({code:'authentication_account_mismatch'},null);
  this.#identity=value.identity;
 }
 async close(){this.#closed=true;await this.#pending;}
}
