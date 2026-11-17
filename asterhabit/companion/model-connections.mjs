import {AgentError} from './agent-registry.mjs';
import {containsSecret} from './memory-store.mjs';

const OPERATIONS=new Set(['model.connection.list','model.connection.save','model.connection.test','model.connection.remove','model.catalogue.refresh']);
const PROVIDER_KINDS=new Set(['openai','deepseek','openai-compatible']);
const CATALOGUE_STATES=new Set(['unverified','ready','unavailable']);
const NATIVE_CODES=new Set(['INVALID_REQUEST','NOT_FOUND','CONFLICT','AUTH_FAILED','TIMEOUT','UNAVAILABLE','CATALOGUE_UNAVAILABLE','CANCELLED','NOT_READY']);
const CONNECTION_ID=/^model-connection-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL=/[\u0000-\u001f\u007f]/;
const ERROR_MESSAGES={
 INVALID_REQUEST:'模型连接请求无效',NOT_FOUND:'模型连接不存在',CONFLICT:'模型连接已被更新，请刷新后重试',
 AUTH_FAILED:'模型服务凭据检查未通过',TIMEOUT:'模型服务响应超时',UNAVAILABLE:'模型连接操作暂时不可用',
 CATALOGUE_UNAVAILABLE:'模型目录暂时不可用',CANCELLED:'模型连接操作已停止',NOT_READY:'模型连接服务尚未就绪',
 CLOSING:'模型连接服务正在关闭',MODEL_CONNECTION_IN_USE:'模型连接仍被Agent使用',
};

/** 模型连接管理边界错误；只包含稳定错误码和不含上游正文的固定说明。 */
export class ModelConnectionError extends AgentError {
 constructor(code='INVALID_REQUEST'){super(ERROR_MESSAGES[code]??ERROR_MESSAGES.UNAVAILABLE,code);this.name='ModelConnectionError';}
}

function exact(value,required,optional=[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new ModelConnectionError();
 const allowed=new Set([...required,...optional]);
 if(required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!allowed.has(key)))throw new ModelConnectionError();
}
function finiteText(value,max,code='INVALID_REQUEST'){if(typeof value!=='string'||value.length>max||CONTROL.test(value)||!value.trim())throw new ModelConnectionError(code);return value.trim();}
function visibleText(value,max,code='INVALID_REQUEST'){const result=finiteText(value,max,code);if(containsSecret(result))throw new ModelConnectionError(code);return result;}
function connectionId(value){if(typeof value!=='string'||!CONNECTION_ID.test(value))throw new ModelConnectionError();return value;}
function revision(value,{create=false}={}){if(!Number.isSafeInteger(value)||value<0||create&&value!==0||!create&&value<1)throw new ModelConnectionError();return value;}
function baseUrl(value,code='INVALID_REQUEST'){
 const text=visibleText(value,2048,code);let parsed;try{parsed=new URL(text);}catch{throw new ModelConnectionError(code);}
 if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)throw new ModelConnectionError(code);
 return parsed.toString().replace(/\/$/,'');
}
function apiKey(value){if(typeof value!=='string'||value.length<1||value.length>8192||CONTROL.test(value)||!value.trim())throw new ModelConnectionError();return value;}
function modelId(value,code='INVALID_REQUEST'){return visibleText(value,300,code);}
function modelIds(value,{code='INVALID_REQUEST'}={}){
 if(!Array.isArray(value)||value.length>256)throw new ModelConnectionError(code);
 const result=[];for(const candidate of value){const id=modelId(candidate,code);if(!result.includes(id))result.push(id);}return result;
}
function providerKind(value){if(!PROVIDER_KINDS.has(value))throw new ModelConnectionError();return value;}
function changeTarget(payload){return Object.hasOwn(payload,'id')?connectionId(payload.id):null;}

function saveInput(payload){
 exact(payload,['expectedRevision','label','providerKind','baseUrl','enabled','manualModelIds'],['id','apiKey']);
 const id=changeTarget(payload);revision(payload.expectedRevision,{create:id===null});
 if(typeof payload.enabled!=='boolean')throw new ModelConnectionError();
 if(id===null&&!Object.hasOwn(payload,'apiKey'))throw new ModelConnectionError();
 const key=Object.hasOwn(payload,'apiKey')?apiKey(payload.apiKey):null;
 const label=visibleText(payload.label,80),url=baseUrl(payload.baseUrl),manualModelIds=modelIds(payload.manualModelIds);
 if(key&&[label,url,...manualModelIds].some(value=>value.includes(key)))throw new ModelConnectionError();
 return {
  ...(id?{id}:{}),expectedRevision:payload.expectedRevision,label,
  providerKind:providerKind(payload.providerKind),baseUrl:url,enabled:payload.enabled,
  manualModelIds,...(key!==null?{apiKey:key}:{}),
 };
}
function existingInput(payload){exact(payload,['id','expectedRevision']);return {id:connectionId(payload.id),expectedRevision:revision(payload.expectedRevision)};}

/** 在宿主取消任务或取得管理租约前同步完成与正式请求相同的严格校验。 */
export function preflightModelConnectionRequest(operation,payload={}){
 if(!OPERATIONS.has(operation))throw new ModelConnectionError();
 if(operation==='model.connection.list'){exact(payload,[]);return {};}
 if(operation==='model.connection.save')return saveInput(payload);
 return existingInput(payload);
}

function safeCatalogue(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!CATALOGUE_STATES.has(value.status))throw new ModelConnectionError('UNAVAILABLE');
 const errorCode=value.errorCode===null?null:(typeof value.errorCode==='string'&&NATIVE_CODES.has(value.errorCode)?value.errorCode:'UNAVAILABLE');
 return {status:value.status,modelIds:modelIds(value.modelIds,{code:'UNAVAILABLE'}),errorCode};
}
function safeConnection(value,secret=null){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ModelConnectionError('UNAVAILABLE');
 if(typeof value.enabled!=='boolean'||typeof value.credentialConfigured!=='boolean'||typeof value.revision!=='number')throw new ModelConnectionError('UNAVAILABLE');
 if(!Number.isSafeInteger(value.revision)||value.revision<0)throw new ModelConnectionError('UNAVAILABLE');
 const kind=visibleText(value.providerKind,80,'UNAVAILABLE'),protocol=visibleText(value.protocol,80,'UNAVAILABLE');
 if(!PROVIDER_KINDS.has(kind)||protocol!=='openai-compatible')throw new ModelConnectionError('UNAVAILABLE');
 const result={
  id:connectionId(value.id),label:visibleText(value.label,80,'UNAVAILABLE'),providerKind:kind,protocol,baseUrl:baseUrl(value.baseUrl,'UNAVAILABLE'),
  revision:value.revision,enabled:value.enabled,credentialConfigured:value.credentialConfigured,
  manualModelIds:modelIds(value.manualModelIds,{code:'UNAVAILABLE'}),catalogue:safeCatalogue(value.catalogue),
 };
 const visible=[result.id,result.label,result.providerKind,result.protocol,result.baseUrl,...result.manualModelIds,...result.catalogue.modelIds];
 if(secret&&visible.some(item=>item.includes(secret)))throw new ModelConnectionError('UNAVAILABLE');
 return result;
}
function safeReferences(value){
 if(!Array.isArray(value))throw new ModelConnectionError('UNAVAILABLE');
 const unique=new Map();
 for(const item of value){
  if(!item||typeof item!=='object'||Array.isArray(item))throw new ModelConnectionError('UNAVAILABLE');
  const agentId=visibleText(item.agentId,200,'UNAVAILABLE'),slot=visibleText(item.slot,40,'UNAVAILABLE'),key=agentId+'\0'+slot;
  unique.set(key,{agentId,slot});
 }
 return [...unique.values()].sort((a,b)=>a.agentId.localeCompare(b.agentId)||a.slot.localeCompare(b.slot));
}
function translated(error){if(error instanceof ModelConnectionError)return error;return new ModelConnectionError(NATIVE_CODES.has(error?.code)?error.code:'UNAVAILABLE');}

/** 应用侧模型连接管理器；秘密只转交原生凭据存储，返回值始终重新序列化。 */
export class ModelConnections {
 #native;#references;#beforeChange;#closing=false;#pending=new Set();#changes=Promise.resolve();
 constructor({native,references=async()=>[],beforeChange=async()=>{}}={}){
  if(typeof native!=='function'||typeof references!=='function'||typeof beforeChange!=='function')throw new TypeError('模型连接依赖无效');
  this.#native=native;this.#references=references;this.#beforeChange=beforeChange;
 }
 request(operation,payload={}){
  if(this.#closing)return Promise.reject(new ModelConnectionError('CLOSING'));
  let input;try{input=preflightModelConnectionRequest(operation,payload);}catch(error){return Promise.reject(translated(error));}
  const task=this.#dispatch(operation,input).catch(error=>{throw translated(error);});
  this.#pending.add(task);task.then(()=>this.#pending.delete(task),()=>this.#pending.delete(task));return task;
 }
 async #dispatch(operation,payload){
  if(operation==='model.connection.list'){
   const result=await this.#native('list',{});
   if(!Array.isArray(result?.connections))throw new ModelConnectionError('UNAVAILABLE');
   return {connections:result.connections.map(value=>safeConnection(value)),...(result.available===false?{available:false}:{})};
  }
  if(operation==='model.connection.test')return await this.#readConnection('test',payload);
  if(operation==='model.connection.save'){
   return await this.#change(payload.id??null,async()=>this.#readConnection('save',payload));
  }
  if(operation==='model.catalogue.refresh'){
   return await this.#change(payload.id,async()=>this.#readConnection('refresh',payload));
  }
  return await this.#change(payload.id,async()=>{
   const references=safeReferences(await this.#references(payload.id));
   if(references.length)return {removed:false,references,errorCode:'MODEL_CONNECTION_IN_USE'};
   await this.#beforeChange(payload.id);const result=await this.#native('remove',payload);
   if(result?.removed!==true)throw new ModelConnectionError('UNAVAILABLE');return {removed:true};
  },{prepare:false});
 }
 async #readConnection(action,input){const result=await this.#native(action,input);return {connection:safeConnection(result?.connection,input.apiKey??null)};}
 #change(id,operation,{prepare=true}={}){
  const run=async()=>{if(prepare&&id)await this.#beforeChange(id);return await operation();};
  const next=this.#changes.then(run,run);this.#changes=next.catch(()=>{});return next;
 }
 async close(){if(this.#closing){await Promise.allSettled([...this.#pending]);return;}this.#closing=true;await Promise.allSettled([...this.#pending]);}
}

/** 连接ID与模型ID共同构成稳定模型身份；相同模型ID不会跨连接合并。 */
export function modelBinding(connectionIdValue,modelIdValue){return {connectionId:connectionId(connectionIdValue),modelId:modelId(modelIdValue)};}

/** 仅迁移显式含受管理连接ID的句柄；旧品牌/OAuth句柄保持原值等待主人处理。 */
export function legacyModelBinding(handle,connections){
 if(typeof handle!=='string'||CONTROL.test(handle)||!handle.trim()||!Array.isArray(connections))return null;
 const candidates=[];
 for(const candidate of connections){
  let safe;try{safe=safeConnection(candidate);}catch{continue;}
  const prefix=safe.id+'/';if(!handle.startsWith(prefix))continue;const legacyId=handle.slice(prefix.length);if(!legacyId)continue;
  const available=new Set([...safe.manualModelIds,...safe.catalogue.modelIds]);
  if(available.has(legacyId))candidates.push({connection:safe,modelId:legacyId});
 }
 if(candidates.length!==1)return null;
 return {...modelBinding(candidates[0].connection.id,candidates[0].modelId),legacyHandle:handle,status:'mapped'};
}
