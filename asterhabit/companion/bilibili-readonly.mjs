import {createHash} from 'node:crypto';

const API_ORIGIN='https://api.bilibili.com';
const BILIBILI_REFERER='https://www.bilibili.com/';
const BILIBILI_USER_AGENT='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_RESPONSE_BYTES=1024*1024;
const REQUEST_TIMEOUT_MS=10_000;
const MAX_MATERIAL_CHARACTERS=6000;
const MAX_MATERIALS=20;
const BVID_PATTERN=/^BV[A-Za-z0-9]{10}$/u;
const ACCOUNT_PATTERN=/^bilibili:([1-9]\d*)$/u;
const COOKIE_VALUE_PATTERN=/^[\x21-\x3a\x3c-\x7e]+$/u;
const RATE_LIMIT_CODES=new Set([-352,-412,-509]);
const AUTH_CODES=new Set([-101]);
const IDENTITY_PROOF=Symbol('bilibili-identity-proof');
const MIXIN_KEY_ENC_TAB=Object.freeze([46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]);
const SAFE_MESSAGES=Object.freeze({
  INVALID_REQUEST:'B站请求参数无效',
  AUTH_REQUIRED:'B站账号认证已失效',
  RATE_LIMITED:'B站暂时限制了读取',
  TIMEOUT:'B站读取超时',
  NETWORK_ERROR:'B站读取暂时失败',
  INVALID_RESPONSE:'B站返回了无效数据',
  CANCELLED:'B站读取已取消'
});

/** B站只读边界的固定安全错误；消息不会包含上游正文、网址、查询参数或凭据。 */
export class BilibiliError extends Error {
  constructor(code) {
    if(!Object.hasOwn(SAFE_MESSAGES,code))throw new TypeError('未知的B站错误代码');
    super(SAFE_MESSAGES[code]);
    this.name='BilibiliError';
    this.code=code;
  }
}

function fail(code){throw new BilibiliError(code);}
function exactObject(value,fields){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_REQUEST');
  const keys=Object.keys(value);
  if(keys.length!==fields.length||keys.some(key=>!fields.includes(key)))fail('INVALID_REQUEST');
  return value;
}
function credentialValue(value,{required,max}){
  if(value===undefined&&!required)return '';
  if(typeof value!=='string'||value.length>(max??0)||(required&&value.length===0)||(!required&&value.length===0?false:!COOKIE_VALUE_PATTERN.test(value)))fail('INVALID_REQUEST');
  return value;
}

/** 校验字段值而非整串Cookie；严格拒绝分号、空白、CRLF、非ASCII和额外字段。 */
export function validateBilibiliCredentials(input) {
  exactObject(input,['sessdata','buvid3']);
  return {
    sessdata:credentialValue(input.sessdata,{required:true,max:4096}),
    buvid3:credentialValue(input.buvid3,{required:false,max:256})
  };
}

function validateSignal(signal){
  if(signal!==undefined&&(!signal||typeof signal!=='object'||typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'))fail('INVALID_REQUEST');
  if(signal?.aborted)fail('CANCELLED');
}
function validateBeforeRequest(callback){if(typeof callback!=='function')fail('INVALID_REQUEST');return callback;}
function cookieHeader(credentials){return `SESSDATA=${credentials.sessdata}${credentials.buvid3?`; buvid3=${credentials.buvid3}`:''}`;}
function boundedString(value,{max,empty=false}={}){
  if(typeof value!=='string')fail('INVALID_RESPONSE');
  const result=value.trim();
  if((!empty&&!result)||result.length>(max??Number.MAX_SAFE_INTEGER))fail('INVALID_RESPONSE');
  return result;
}
function positiveInteger(value,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(value)||value<=0||value>max)fail('INVALID_RESPONSE');return value;}
function mapApiPayload(payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||!Number.isInteger(payload.code))fail('INVALID_RESPONSE');
  if(payload.code===0)return payload.data;
  if(AUTH_CODES.has(payload.code))fail('AUTH_REQUIRED');
  if(RATE_LIMIT_CODES.has(payload.code))fail('RATE_LIMITED');
  fail('INVALID_RESPONSE');
}
function readIdentity(data,{wbi=false}={}){
  if(!data||typeof data!=='object'||Array.isArray(data))fail('INVALID_RESPONSE');
  if(data.isLogin!==true)fail('AUTH_REQUIRED');
  const mid=positiveInteger(data.mid),label=boundedString(data.uname,{max:100});
  const result={mid,label};
  if(wbi)result.mixinKey=readMixinKey(data.wbi_img);
  return result;
}
function wbiKey(urlValue){
  if(typeof urlValue!=='string')fail('INVALID_RESPONSE');
  let url;
  try{url=new URL(urlValue);}catch{fail('INVALID_RESPONSE');}
  if(url.protocol!=='https:'||url.hostname!=='i0.hdslb.com'||url.port||url.username||url.password||url.search||url.hash||!/^\/bfs\/wbi\/[A-Za-z0-9]+\.(?:png|jpg)$/u.test(url.pathname))fail('INVALID_RESPONSE');
  return url.pathname.slice(url.pathname.lastIndexOf('/')+1,url.pathname.lastIndexOf('.'));
}
function readMixinKey(value){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_RESPONSE');
  const source=wbiKey(value.img_url)+wbiKey(value.sub_url);
  if(source.length<64)fail('INVALID_RESPONSE');
  return MIXIN_KEY_ENC_TAB.map(index=>source[index]).join('').slice(0,32);
}
function wbiUrl({bvid,cid,wts,mixinKey}){
  const entries={bvid,cid,wts};
  const query=Object.keys(entries).sort().map(key=>`${encodeURIComponent(key)}=${encodeURIComponent(String(entries[key]).replace(/[!'()*]/gu,''))}`).join('&');
  const signature=createHash('md5').update(query+mixinKey,'utf8').digest('hex');
  return `${API_ORIGIN}/x/player/wbi/v2?${query}&w_rid=${signature}`;
}
function apiUrl(path,params=undefined){
  const url=new URL(path,API_ORIGIN);
  if(params)for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
  if(url.protocol!=='https:'||url.origin!==API_ORIGIN)fail('INVALID_REQUEST');
  return url.toString();
}
function subtitleUrl(raw){
  if(typeof raw!=='string'||!raw)fail('INVALID_RESPONSE');
  let url;
  try{url=new URL(raw.startsWith('//')?`https:${raw}`:raw);}catch{fail('INVALID_RESPONSE');}
  const normalPath=/^\/bfs\/subtitle\/[A-Za-z0-9/_-]+\.json$/u.test(url.pathname);
  const aiPath=/^\/bfs\/ai_subtitle\/prod\/[A-Za-z0-9/_-]+\.json$/u.test(url.pathname);
  const allowed=(url.hostname==='i0.hdslb.com'&&normalPath)||(url.hostname==='aisubtitle.hdslb.com'&&aiPath);
  const rawQuery=url.search.startsWith('?')?url.search.slice(1):url.search;
  if(rawQuery){
    const separator=rawQuery.indexOf('='),rawName=separator<0?rawQuery:rawQuery.slice(0,separator);
    const entries=[...url.searchParams.entries()];
    if(rawQuery.includes('&')||rawName!=='auth_key'||separator<0||entries.length!==1||entries[0][0]!=='auth_key'||!(/^[A-Za-z0-9_-]{1,256}$/u.test(entries[0][1])))fail('INVALID_RESPONSE');
  }
  if(url.protocol!=='https:'||!allowed||url.port||url.username||url.password||url.hash)fail('INVALID_RESPONSE');
  return url.toString();
}
function responseStatus(response){
  if(!response||typeof response!=='object'||!Number.isInteger(response.status))fail('INVALID_RESPONSE');
  if(response.redirected===true||(response.status>=300&&response.status<400))fail('INVALID_RESPONSE');
  if(response.status===401||response.status===403)fail('AUTH_REQUIRED');
  if(response.status===412||response.status===429)fail('RATE_LIMITED');
  if(response.status<200||response.status>=300)fail('INVALID_RESPONSE');
  const rawLength=response.headers?.get?.('content-length');
  if(rawLength!==null&&rawLength!==undefined&&rawLength!==''){
    const length=Number(rawLength);
    if(!Number.isSafeInteger(length)||length<0||length>MAX_RESPONSE_BYTES)fail('INVALID_RESPONSE');
  }
}
async function responseBytes(response){
  if(response.body&&typeof response.body.getReader==='function'){
    const reader=response.body.getReader(),chunks=[];let total=0;
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      if(!(value instanceof Uint8Array))fail('INVALID_RESPONSE');
      total+=value.byteLength;
      if(total>MAX_RESPONSE_BYTES){await reader.cancel().catch(()=>{});fail('INVALID_RESPONSE');}
      chunks.push(value);
    }
    const bytes=new Uint8Array(total);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return bytes;
  }
  if(typeof response.arrayBuffer==='function'){
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.byteLength>MAX_RESPONSE_BYTES)fail('INVALID_RESPONSE');
    return bytes;
  }
  fail('INVALID_RESPONSE');
}
async function responseJson(response){
  responseStatus(response);
  const bytes=await responseBytes(response);
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('INVALID_RESPONSE');}
  try{return JSON.parse(text);}catch{fail('INVALID_RESPONSE');}
}
function normalizeCreatorIds(value){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>100)fail('INVALID_REQUEST');
  const result=value.map(item=>{if(typeof item!=='string'||!(/^[1-9]\d*$/u.test(item)))fail('INVALID_REQUEST');return item;});
  if(new Set(result).size!==result.length)fail('INVALID_REQUEST');
  return result;
}
function normalizeKeywords(value){
  if(!Array.isArray(value)||value.length>20)fail('INVALID_REQUEST');
  const result=value.map(item=>{if(typeof item!=='string'||!item.trim()||item.trim().length>100)fail('INVALID_REQUEST');return item.trim();});
  if(new Set(result).size!==result.length)fail('INVALID_REQUEST');
  return result;
}
function discoveryLimit(value){if(!Number.isInteger(value)||value<1||value>10)fail('INVALID_REQUEST');return value;}
function creatorId(value){
  const result=typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;
  if(typeof result!=='string'||!(/^[1-9]\d{0,19}$/u.test(result)))fail('INVALID_RESPONSE');
  return result;
}
function videoDuration(value){
  if(Number.isSafeInteger(value))return positiveInteger(value,86400);
  if(typeof value==='string'&&/^\d{1,5}$/u.test(value))return positiveInteger(Number(value),86400);
  if(typeof value!=='string'||!(/^\d{1,3}(?::\d{1,2}){1,2}$/u.test(value)))fail('INVALID_RESPONSE');
  const parts=value.split(':').map(Number);
  if(parts.slice(1).some(part=>part>59))fail('INVALID_RESPONSE');
  const seconds=parts.reduce((total,part)=>total*60+part,0);
  return positiveInteger(seconds,86400);
}
function discoveryTitle(value){
  if(typeof value!=='string')fail('INVALID_RESPONSE');
  return boundedString(value.replace(/<\/?em(?: class="keyword")?>/gu,''),{max:300});
}
function discoveryCandidate(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.bvid!=='string'||!BVID_PATTERN.test(value.bvid))fail('INVALID_RESPONSE');
  const candidate={bvid:value.bvid,title:discoveryTitle(value.title),creatorId:creatorId(value.mid),durationSeconds:videoDuration(value.duration??value.length)};
  return candidate;
}
function descriptionMaterial(bvid,description){
  const text=typeof description==='string'?description.trim():'';
  return text?{id:`description-${bvid}`,kind:'description',text:text.slice(0,MAX_MATERIAL_CHARACTERS)}:null;
}
function subtitleMaterials(payload,track,durationSeconds,description){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||!Array.isArray(payload.body))fail('INVALID_RESPONSE');
  const materials=description?[description]:[];let characters=description?.text.length??0;
  const trackId=String(track.id??'track').replace(/[^A-Za-z0-9_-]/gu,'').slice(0,50)||'track';
  for(let index=0;index<payload.body.length&&materials.length<MAX_MATERIALS;index++){
    const cue=payload.body[index];
    if(!cue||typeof cue!=='object'||Array.isArray(cue)||typeof cue.content!=='string'||!Number.isFinite(cue.from)||!Number.isFinite(cue.to)||cue.from<0||cue.to<cue.from)fail('INVALID_RESPONSE');
    if(cue.from>durationSeconds)continue;
    const raw=cue.content.trim();if(!raw)continue;
    const remaining=MAX_MATERIAL_CHARACTERS-characters-1;if(remaining<=0)break;
    const text=raw.slice(0,remaining);if(!text)break;
    materials.push({id:`subtitle-${trackId}-${index+1}`,kind:'subtitle',text,startSeconds:cue.from,endSeconds:Math.min(cue.to,durationSeconds)});
    characters+=text.length+1;
  }
  return materials;
}

/** 固定B站只读transport；所有目的地、请求次数、Cookie去向与返回结构均由代码约束。 */
export class BilibiliReadonlyClient {
  #transport;#now;#requestTimeoutMs;#usedProofs=new WeakSet();
  constructor({transport=fetch,now=Date.now,requestTimeoutMs=REQUEST_TIMEOUT_MS}={}){
    if(typeof transport!=='function'||typeof now!=='function'||!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>REQUEST_TIMEOUT_MS)fail('INVALID_REQUEST');
    this.#transport=transport;this.#now=now;this.#requestTimeoutMs=requestTimeoutMs;
  }
  async #request({url,operation,credentials=null,signal,beforeRequest}){
    validateSignal(signal);validateBeforeRequest(beforeRequest);
    await beforeRequest({operation});
    validateSignal(signal);
    const controller=new AbortController();let timedOut=false;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},this.#requestTimeoutMs);
    const headers={accept:'application/json',referer:BILIBILI_REFERER,'user-agent':BILIBILI_USER_AGENT};
    if(credentials)headers.cookie=cookieHeader(credentials);
    try{
      const response=await this.#transport(url,{method:'GET',headers,redirect:'error',credentials:'omit',signal:controller.signal});
      return await responseJson(response);
    }catch(error){
      if(error instanceof BilibiliError)throw error;
      if(signal?.aborted)fail('CANCELLED');
      if(timedOut)fail('TIMEOUT');
      fail('NETWORK_ERROR');
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
    }
  }
  async #nav({credentials,signal,beforeRequest,wbi=false}){
    const payload=await this.#request({url:apiUrl('/x/web-interface/nav'),operation:'identity',credentials,signal,beforeRequest});
    return readIdentity(mapApiPayload(payload),{wbi});
  }
  /** 用一次nav验证登录身份，不返回凭据或WBI原始响应。 */
  async identity({credentials,signal,beforeRequest}={}){
    const checked=validateBilibiliCredentials(credentials);
    const identity=await this.#nav({credentials:checked,signal,beforeRequest,wbi:false});
    return {id:`bilibili:${identity.mid}`,label:identity.label};
  }
  /** 先以nav核对当前账号，再执行一个固定关键词或UP主候选请求。 */
  async discover({credentials,expectedAccountId,keywords=[],creatorIds=[],limit=10,signal,beforeRequest}={}){
    const checked=validateBilibiliCredentials(credentials);
    if(typeof expectedAccountId!=='string'||!ACCOUNT_PATTERN.test(expectedAccountId))fail('INVALID_REQUEST');
    const selectedKeywords=normalizeKeywords(keywords),allowedCreators=normalizeCreatorIds(creatorIds),selectedLimit=discoveryLimit(limit);
    if(!selectedKeywords.length&&!allowedCreators.length)fail('INVALID_REQUEST');
    const identity=await this.#nav({credentials:checked,signal,beforeRequest,wbi:true});
    if(`bilibili:${identity.mid}`!==expectedAccountId)fail('AUTH_REQUIRED');
    let payload,rows;
    if(selectedKeywords.length){
      payload=await this.#request({url:apiUrl('/x/web-interface/search/type',{search_type:'video',keyword:selectedKeywords.join(' '),page:'1',page_size:String(selectedLimit),order:'pubdate'}),operation:'search',credentials:checked,signal,beforeRequest});
      const data=mapApiPayload(payload);if(!data||typeof data!=='object'||Array.isArray(data)||!Array.isArray(data.result))fail('INVALID_RESPONSE');rows=data.result;
    }else{
      payload=await this.#request({url:apiUrl('/x/space/arc/search',{mid:allowedCreators[0],pn:'1',ps:String(selectedLimit),order:'pubdate'}),operation:'creator',credentials:checked,signal,beforeRequest});
      const data=mapApiPayload(payload);if(!data||typeof data!=='object'||Array.isArray(data)||!data.list||typeof data.list!=='object'||Array.isArray(data.list)||!Array.isArray(data.list.vlist))fail('INVALID_RESPONSE');rows=data.list.vlist;
    }
    const candidates=[];
    for(const row of rows){
      const item=discoveryCandidate(row);
      if(allowedCreators.length&&!allowedCreators.includes(item.creatorId)){if(selectedKeywords.length)continue;fail('INVALID_RESPONSE');}
      if(candidates.some(candidate=>candidate.bvid===item.bvid))continue;
      candidates.push(item);if(candidates.length===selectedLimit)break;
    }
    const result={candidates,requestsUsed:2};
    Object.defineProperty(result,IDENTITY_PROOF,{value:Object.freeze({accountId:expectedAccountId,mixinKey:identity.mixinKey,credentialHash:createHash('sha256').update(JSON.stringify(checked),'utf8').digest('hex'),verifiedAt:this.#now()})});
    return result;
  }
  async #readVideo({credentials,bvid,allowedCreators,mixinKey,signal,beforeRequest}){
    const viewPayload=await this.#request({url:apiUrl('/x/web-interface/view',{bvid}),operation:'view',credentials,signal,beforeRequest});
    const viewData=mapApiPayload(viewPayload);
    if(!viewData||typeof viewData!=='object'||Array.isArray(viewData)||viewData.bvid!==bvid||!viewData.owner||typeof viewData.owner!=='object'||Array.isArray(viewData.owner))fail('INVALID_RESPONSE');
    const cid=positiveInteger(viewData.cid),creatorMid=positiveInteger(viewData.owner.mid),selectedCreatorId=String(creatorMid);
    const title=boundedString(viewData.title,{max:300}),creatorName=boundedString(viewData.owner.name,{max:200}),durationSeconds=positiveInteger(viewData.duration,86400);
    if(allowedCreators.length&&!allowedCreators.includes(selectedCreatorId))fail('INVALID_REQUEST');
    const wts=Math.floor(this.#now()/1000);if(!Number.isSafeInteger(wts)||wts<=0)fail('INVALID_REQUEST');
    const playerPayload=await this.#request({url:wbiUrl({bvid,cid,wts,mixinKey}),operation:'player',credentials,signal,beforeRequest});
    const playerData=mapApiPayload(playerPayload);
    if(!playerData||typeof playerData!=='object'||Array.isArray(playerData))fail('INVALID_RESPONSE');
    const description=descriptionMaterial(bvid,viewData.desc),base={bvid,title,creatorId:selectedCreatorId,creatorName,durationSeconds,url:`https://www.bilibili.com/video/${bvid}`},descriptionCount=description?1:0;
    const tracks=playerData.subtitle?.subtitles;
    if(tracks===undefined||tracks===null||Array.isArray(tracks)&&tracks.length===0)return {...base,coverage:{description:descriptionCount,subtitle:0,comment:0},materials:description?[description]:[],requestsUsed:2,subtitleStatus:'missing'};
    if(!Array.isArray(tracks)||!tracks.length)fail('INVALID_RESPONSE');
    const track=tracks[0];if(!track||typeof track!=='object'||Array.isArray(track))fail('INVALID_RESPONSE');
    const subtitleEndpoint=subtitleUrl(track.subtitle_url);
    const subtitlePayload=await this.#request({url:subtitleEndpoint,operation:'subtitle',signal,beforeRequest});
    const materials=subtitleMaterials(subtitlePayload,track,durationSeconds,description),subtitleCount=materials.length-descriptionCount;
    return {...base,coverage:{description:descriptionCount,subtitle:subtitleCount,comment:0},materials,requestsUsed:3,subtitleStatus:'available'};
  }
  /** 只供已在同一可信服务会话完成账号核身的观察阶段；renderer没有此入口。 */
  async observe({credentials,expectedAccountId,identityProof,bvid,creatorIds=[],signal,beforeRequest}={}){
    const checked=validateBilibiliCredentials(credentials);
    if(typeof expectedAccountId!=='string'||!ACCOUNT_PATTERN.test(expectedAccountId)||typeof bvid!=='string'||!BVID_PATTERN.test(bvid))fail('INVALID_REQUEST');
    const proof=identityProof?.[IDENTITY_PROOF],credentialHash=createHash('sha256').update(JSON.stringify(checked),'utf8').digest('hex');
    const age=proof?this.#now()-proof.verifiedAt:Number.POSITIVE_INFINITY;
    if(!proof||proof.accountId!==expectedAccountId||proof.credentialHash!==credentialHash||!Number.isFinite(age)||age<0||age>120_000||this.#usedProofs.has(identityProof))fail('AUTH_REQUIRED');
    this.#usedProofs.add(identityProof);
    return this.#readVideo({credentials:checked,bvid,allowedCreators:normalizeCreatorIds(creatorIds),mixinKey:proof.mixinKey,signal,beforeRequest});
  }
  /** 最多使用nav、view、player和一个字幕JSON，返回有限且可追溯的只读材料。 */
  async inspect({credentials,expectedAccountId,bvid,creatorIds=[],signal,beforeRequest}={}){
    const checked=validateBilibiliCredentials(credentials);
    if(typeof expectedAccountId!=='string'||!ACCOUNT_PATTERN.test(expectedAccountId)||typeof bvid!=='string'||!BVID_PATTERN.test(bvid))fail('INVALID_REQUEST');
    const allowedCreators=normalizeCreatorIds(creatorIds);
    const identity=await this.#nav({credentials:checked,signal,beforeRequest,wbi:true});
    if(`bilibili:${identity.mid}`!==expectedAccountId)fail('AUTH_REQUIRED');
    const result=await this.#readVideo({credentials:checked,bvid,allowedCreators,mixinKey:identity.mixinKey,signal,beforeRequest});
    return {...result,requestsUsed:result.requestsUsed+1};
  }
}


