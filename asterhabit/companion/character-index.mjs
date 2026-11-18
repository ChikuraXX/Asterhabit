import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Graphify 环境随 Asterhabit 工作区定位，避免依赖开发机的全局包。
const DEFAULT_PYTHON = fileURLToPath(new URL(process.platform === 'win32' ? '../../graphify/.venv/Scripts/python.exe' : '../../graphify/.venv/bin/python', import.meta.url));
const BRIDGE=fileURLToPath(new URL('./character_graphify_bridge.py',import.meta.url));
const MAX_INPUT_BYTES=1024*1024,MAX_GRAPH_BYTES=64*1024*1024;
const KINDS=new Set(['interest','preference','opinion','question']);
const STATUSES=new Set(['tentative','established','retired','open','resolved','dismissed']);
function scopeId(value){if(typeof value!=='string'||!/^[0-9a-f]{64}$/u.test(value))throw new TypeError('Invalid character scope');return value;}
function revision(value){if(!Number.isInteger(value)||value<0)throw new TypeError('Invalid character revision');return value;}
function state(value) {
  const required=['id','kind','topic','statement','briefReason','status','revision','sourceIds','createdAt','updatedAt'],fields=[...required,'dependencySourceIds'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key))||required.some(key=>!Object.hasOwn(value,key)))throw new TypeError('角色投影字段无效');
  if(typeof value.id!=='string'||!value.id||!KINDS.has(value.kind)||typeof value.topic!=='string'||typeof value.statement!=='string'||typeof value.briefReason!=='string'||!STATUSES.has(value.status)
    ||!Number.isInteger(value.revision)||value.revision<0||!Array.isArray(value.sourceIds)||value.sourceIds.some(id=>typeof id!=='string'||!id)||value.dependencySourceIds!==undefined&&(!Array.isArray(value.dependencySourceIds)||value.dependencySourceIds.some(id=>typeof id!=='string'||!id))
    ||!Number.isInteger(value.createdAt)||!Number.isInteger(value.updatedAt))throw new TypeError('角色投影记录无效');
  return {id:value.id,kind:value.kind,topic:value.topic,statement:value.statement,briefReason:value.briefReason,status:value.status,revision:value.revision,sourceIds:[...new Set(value.sourceIds)],dependencySourceIds:[...new Set(value.dependencySourceIds??value.sourceIds)],createdAt:value.createdAt,updatedAt:value.updatedAt};
}
function workerEnvironment(){const env={PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'};for(const name of ['SystemRoot','WINDIR','ComSpec','TEMP','TMP'])if(typeof process.env[name]==='string')env[name]=process.env[name];return env;}
function definitelyExited(pid){try{process.kill(pid,0);return false;}catch(error){return error?.code==='ESRCH';}}

/** 使用真实 Graphify build_merge 的独立角色投影；SQLite 始终是唯一权威。 */
export class CharacterGraphIndex {
  #directory;#staging;#python;#timeout;
  constructor({directory,python=DEFAULT_PYTHON,timeoutMs=20000}) {
    if(typeof directory!=='string'||!directory.trim()||typeof python!=='string'||!python.trim()||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw new TypeError('Invalid character graph configuration');
    this.#directory=path.resolve(directory);this.#staging=path.join(this.#directory,'.staging');this.#python=python;this.#timeout=timeoutMs;
    mkdirSync(this.#staging,{recursive:true,mode:0o700});this.#recover();
  }
  #path(scope){return path.join(this.#directory,scope+'.character.graph.json');}
  #recover() {
    for(const name of readdirSync(this.#staging).filter(value=>/^[0-9a-f]{32}\.lease\.json$/u.test(value))) {
      const leasePath=path.join(this.#staging,name);let lease;
      try{lease=JSON.parse(readFileSync(leasePath,'utf8'));}catch{continue;}
      if(lease?.version!==1||!['starting','running','artifact'].includes(lease.phase)||!Number.isInteger(lease.parentPid)||!Array.isArray(lease.files)||lease.files.some(file=>path.basename(file)!==file))continue;
      const parentExited=definitelyExited(lease.parentPid),workerExited=lease.phase==='running'&&Number.isInteger(lease.workerPid)?definitelyExited(lease.workerPid):false;
      if(!parentExited||(lease.phase==='running'&&!workerExited))continue;
      for(const file of lease.files)rmSync(path.join(this.#staging,file),{force:true});
      rmSync(leasePath,{force:true});
    }
  }
  /** 在白名单环境、无 shell、有限超时的 worker 中构建并原子发布 Graphify 图。 */
  publish(scope,storeRevision,states,validSourceIds) {
    scope=scopeId(scope);storeRevision=revision(storeRevision);
    if(!Array.isArray(states)||!Array.isArray(validSourceIds)||validSourceIds.some(id=>typeof id!=='string'||!id))throw new TypeError('角色投影输入无效');
    const normalized=states.map(state),token=randomUUID().replaceAll('-','');
    const base={contract:'character-state-v1',scopeId:scope,revision:storeRevision,states:normalized,validSourceIds:[...new Set(validSourceIds)]};
    const canonical=JSON.stringify(base),fingerprint=createHash('sha256').update(canonical,'utf8').digest('hex');
    const input=JSON.stringify({...base,fingerprint});
    if(Buffer.byteLength(input)>MAX_INPUT_BYTES)throw new Error('Character graph input too large');
    const inputName=token+'.input.json',outputName=token+'.graph.json',leaseName=token+'.lease.json';
    const inputPath=path.join(this.#staging,inputName),outputPath=path.join(this.#staging,outputName),leasePath=path.join(this.#staging,leaseName);
    writeFileSync(inputPath,input,{encoding:'utf8',mode:0o600});
    writeFileSync(leasePath,JSON.stringify({version:1,phase:'starting',parentPid:process.pid,token,files:[inputName,outputName]}),{encoding:'utf8',mode:0o600});
    try {
      const worker=spawnSync(this.#python,[BRIDGE,inputPath,outputPath,leasePath],{env:workerEnvironment(),encoding:'utf8',timeout:this.#timeout,maxBuffer:1024*1024,windowsHide:true,shell:false});
      if(worker.status!==0||worker.error||!existsSync(outputPath))throw new Error('Character Graphify worker failed');
      if(statSync(outputPath).size>MAX_GRAPH_BYTES)throw new Error('Character graph output too large');
      let report;try{report=JSON.parse((worker.stdout??'').trim().split(/\r?\n/u).at(-1));}catch{throw new Error('Character Graphify worker failed');}
      if(report?.ok!==true)throw new Error('Character Graphify worker failed');
      renameSync(outputPath,this.#path(scope));
      return {revision:storeRevision,nodes:report.nodes,edges:report.edges,fingerprint};
    } finally {
      rmSync(inputPath,{force:true});rmSync(outputPath,{force:true});rmSync(leasePath,{force:true});
    }
  }
  /** 修订不匹配时拒绝使用旧图，避免遗忘材料从派生物复活。 */
  read(scope,expectedRevision) {
    scope=scopeId(scope);expectedRevision=revision(expectedRevision);
    try {
      const graph=JSON.parse(readFileSync(this.#path(scope),'utf8')),meta=graph.graph;
      if(meta?.contract!=='character-state-v1'||meta.scope_id!==scope||meta.revision!==expectedRevision)return [];
      return graph.nodes.filter(node=>node.type==='character_state').map(node=>({id:node.id.slice('character:'.length),kind:node.character_kind,topic:node.topic,statement:node.statement,briefReason:node.brief_reason,status:node.character_status,revision:node.state_revision,sourceIds:node.source_ids,createdAt:node.created_at,updatedAt:node.updated_at}));
    } catch{return [];}
  }
  /** 返回不含正文的 Graphify 投影状态。 */
  status(scope) {
    scope=scopeId(scope);
    try{const graph=JSON.parse(readFileSync(this.#path(scope),'utf8'));return {revision:graph.graph?.revision??-1,contract:graph.graph?.contract??null,graphifyVersion:graph.graph?.graphify_version??null,error:null};}
    catch{return {revision:-1,contract:'character-state-v1',graphifyVersion:null,error:'unavailable'};}
  }
}
