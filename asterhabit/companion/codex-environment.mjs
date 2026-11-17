import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {codexAccessSnapshot} from '../scripts/model-credentials.mjs';
import {ModelGenerationError} from './generation-failure.mjs';

/** 受限文本生成配置；使用独立CODEX_HOME，禁止继承用户插件、MCP、钩子和环境工具。 */
export const CODEX_GENERATION_CONFIG=`approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
project_doc_max_bytes = 0
cli_auth_credentials_store = "file"
[history]
persistence = "none"
[analytics]
enabled = false
[agents]
enabled = false
[tools.experimental_request_user_input]
enabled = false
[tools.update_plan]
enabled = false
[features]
shell_tool = false
unified_exec = false
apply_patch_freeform = false
view_image = false
apps = false
browser_use = false
code_mode = false
multi_agent = false
multi_agent_v2 = false
hooks = false
skip_host_skill_discovery = true
skill_search = false
workspace_dependencies = false
`;

/** 定位已有Codex原生二进制，不运行shell包装器，不安装或修改全局配置。 */
export function resolveCodexExecutable(explicit){
 if(explicit){if(!path.isAbsolute(explicit)||!existsSync(explicit))throw new Error('配置的Codex程序不存在');return explicit;}
 const directories=[path.dirname(process.execPath)];
 for(const directory of directories){
  if(!directory)continue;
  if(process.platform==='win32'){
   const npm=path.join(directory,'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');if(existsSync(npm))return npm;
  }
 }
 throw new Error('未找到Codex执行程序，请先安装或配置路径');
}

/** 固定已验二进制指纹，升级后需要重新核验；在写临时凭据之前调用。 */
export function verifiedCodexExecutable(explicit,expectedSha256){
 const executable=resolveCodexExecutable(explicit);
 if(expectedSha256){if(!/^[a-f0-9]{64}$/.test(expectedSha256)||createHash('sha256').update(readFileSync(executable)).digest('hex')!==expectedSha256)throw new Error('Codex版本指纹已变化，请重新核验执行环境');}
 return executable;
}

/** 读取短期登录快照并核验账号；不读取配置，不复制refresh_token，也不写回源文件。 */
export function readCodexAuthentication(sourceAuthPath,expectedIdentity,{allowExpired=false}={}){
 let snapshot,cache,claims;
 try{cache=JSON.parse(readFileSync(sourceAuthPath,'utf8'));claims=JSON.parse(Buffer.from(cache.tokens?.access_token?.split('.')[1]??'','base64url').toString('utf8'));if(!allowExpired&&Number.isSafeInteger(claims.exp)&&claims.exp*1000<=Date.now()+120000)throw new ModelGenerationError({code:'authentication_source_expired'},null);snapshot=codexAccessSnapshot(cache,allowExpired?0:Date.now());}
 catch(error){if(error instanceof ModelGenerationError)throw error;throw new ModelGenerationError({code:'authentication_source_unavailable'},null);}
 const account=claims['https://api.openai.com/auth']?.chatgpt_account_id;
 if(typeof claims.sub!=='string'||!claims.sub||(account&&account!==snapshot.account_id))throw new ModelGenerationError({code:'authentication_account_mismatch'},null);
 const idClaims=JSON.parse(Buffer.from(snapshot.id_token.split('.')[1],'base64url').toString('utf8'));
 if(idClaims.sub!==claims.sub)throw new ModelGenerationError({code:'authentication_account_mismatch'},null);
 const digest=value=>createHash('sha256').update(value).digest('hex');
 const identity=digest(snapshot.account_id+'\0'+claims.sub);
 if(expectedIdentity&&identity!==expectedIdentity)throw new ModelGenerationError({code:'authentication_account_mismatch'},null);
 return {identity,accountHash:digest(snapshot.account_id),subjectHash:digest(claims.sub),snapshot,lastRefresh:cache.last_refresh??null};
}

/** 为一次自有后台进程建立独立目录与最小环境；directory由宿主固定生成，模型不能指定。 */
export function prepareCodexEnvironment({directory,sourceAuthPath,expectedIdentity,authorizedSnapshot,env=process.env}){
 const {identity,snapshot,lastRefresh}=authorizedSnapshot??readCodexAuthentication(sourceAuthPath,expectedIdentity);
 if(expectedIdentity&&identity!==expectedIdentity)throw new ModelGenerationError({code:'authentication_account_mismatch'},null);
 const home=path.join(directory,'home'),cwd=path.join(directory,'work');mkdirSync(home,{recursive:true,mode:0o700});mkdirSync(cwd,{recursive:true,mode:0o700});
 writeFileSync(path.join(home,'config.toml'),CODEX_GENERATION_CONFIG,{mode:0o600});
 writeFileSync(path.join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',OPENAI_API_KEY:null,last_refresh:lastRefresh,tokens:{access_token:snapshot.access_token,id_token:snapshot.id_token,account_id:snapshot.account_id,refresh_token:''}}),{mode:0o600});
 const childEnv={};for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR'])if(env[key])childEnv[key]=env[key];
 childEnv.CODEX_HOME=home;
 return {identity,expiresAt:snapshot.expires_at,home,cwd,env:childEnv};
}
