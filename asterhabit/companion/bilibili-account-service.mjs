import {BilibiliAccountError} from './bilibili-account-store.mjs';
import {validateBilibiliCredentials} from './bilibili-readonly.mjs';

function exact(value,fields){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(field=>!Object.hasOwn(value,field)))throw new BilibiliAccountError('账号请求字段无效');}
function signalCheck(signal){if(signal?.aborted)throw new BilibiliAccountError('本轮已停止','CANCELLED');}
/** 账号操作服务：凭据仅经DPAPI与固定只读客户端流动，从不交给模型或观察存储。 */
export class BilibiliAccountService {
 #store;#owner;#contentOwner;#codec;#client;
 constructor({store,owner=store.bilibili.ownerAuthority(),codec,client}){this.#store=store;this.#owner=owner;this.#contentOwner=store.content.ownerAuthority();this.#codec=codec;this.#client=client;}
 /** 不解密的本地状态读取，不访问网络或模型。 */
 status(){return {...this.#store.bilibili.status(this.#owner),storage:this.#codec.available?'windows-user':'unavailable'};}
 #supported(){if(!this.#codec.available)throw new BilibiliAccountError('当前系统尚不支持安全凭据保管','STORAGE_UNAVAILABLE');}
 #guard(commitGuard,fn){if(typeof commitGuard!=='function')throw new BilibiliAccountError('缺少账号宿主门');const result=commitGuard(fn);if(result&&typeof result.then==='function')throw new BilibiliAccountError('账号提交门必须同步执行');return result;}
 #blocked(error){if(error?.code==='RATE_LIMITED')this.#store.bilibili.blockNetwork(this.#owner);}
 #contentCheck(accountRevision,policy){
  this.#store.bilibili.assertRevision(this.#owner,accountRevision);
  const current=this.#store.content.settings(this.#contentOwner);
  if(!current.readEnabled||current.revision!==policy.revision||current.accountId!==policy.accountId)throw new BilibiliAccountError('读取策略或账号已变化','CONFLICT');
 }
 async #contentCredentials(accountRevision,policy,{signal,commitGuard}){
  this.#supported();signalCheck(signal);
  const sealed=this.#guard(commitGuard,()=>{this.#contentCheck(accountRevision,policy);return this.#store.bilibili.encrypted(this.#owner,accountRevision);});
  let plaintext;
  try{plaintext=await this.#codec.unprotect(sealed.ciphertext,{signal});return validateBilibiliCredentials(JSON.parse(plaintext));}
  catch(error){if(error?.code==='CANCELLED'||signal?.aborted)throw new BilibiliAccountError('本轮已停止','CANCELLED');throw new BilibiliAccountError('本地凭据无法读取，请重新绑定','STORAGE_UNAVAILABLE');}
 }
 /** 为单次ContentSession创建可信只读适配器；discover核身证据只在本对象内供紧随的observe使用。 */
 contentProvider(){
  const accountState=this.status();if(!accountState.account)return null;
  const accountRevision=accountState.revision,account=Object.freeze({...accountState.account}),policy=this.#store.content.settings(this.#contentOwner);let identityProof=null;
  const service=this;
  return Object.freeze({account,
   async discover(input){
    exact(input,['keywords','creatorIds','limit','signal','commitGuard']);if(identityProof)throw new BilibiliAccountError('本轮候选已读取','CONFLICT');
    const {keywords,creatorIds,limit,signal,commitGuard}=input,credentials=await service.#contentCredentials(accountRevision,policy,{signal,commitGuard});let requests=0;
    try{
     const result=await service.#client.discover({credentials,expectedAccountId:account.id,keywords,creatorIds,limit,signal,beforeRequest:({operation})=>service.#guard(commitGuard,()=>{service.#contentCheck(accountRevision,policy);if(!['identity','search','creator'].includes(operation)||requests>=2)throw new BilibiliAccountError('候选读取请求超出本轮范围');service.#store.bilibili.reserveNetwork(service.#owner,operation);requests++;})});
     if(requests!==2||result?.requestsUsed!==requests||!Array.isArray(result.candidates))throw new BilibiliAccountError('候选读取未执行预期请求','INVALID_RESPONSE');
     return service.#guard(commitGuard,()=>{service.#contentCheck(accountRevision,policy);identityProof=result;return {candidates:result.candidates};});
    }catch(error){service.#blocked(error);throw error;}
   },
   async observe(input){
    exact(input,['bvid','signal','commitGuard']);if(!identityProof)throw new BilibiliAccountError('请先完成本轮候选核身','CONFLICT');
    const {bvid,signal,commitGuard}=input,selected=identityProof.candidates.find(candidate=>candidate.bvid===bvid);
    if(!selected)throw new BilibiliAccountError('观察内容不在本轮候选中','INVALID_RESPONSE');
    const credentials=await service.#contentCredentials(accountRevision,policy,{signal,commitGuard});let requests=0;
    try{
     const proof=identityProof;identityProof=null;
     const result=await service.#client.observe({credentials,expectedAccountId:account.id,identityProof:proof,bvid,creatorIds:[...policy.creatorIds],signal,beforeRequest:({operation})=>service.#guard(commitGuard,()=>{service.#contentCheck(accountRevision,policy);if(!['view','player','subtitle'].includes(operation)||requests>=3)throw new BilibiliAccountError('材料读取请求超出本轮范围');service.#store.bilibili.reserveNetwork(service.#owner,operation);requests++;})});
     if(requests<2||requests>3||result?.requestsUsed!==requests||result?.bvid!==bvid||result?.creatorId!==selected.creatorId||result?.durationSeconds!==selected.durationSeconds||!Array.isArray(result.materials))throw new BilibiliAccountError('材料读取未执行预期请求','INVALID_RESPONSE');
     return service.#guard(commitGuard,()=>{service.#contentCheck(accountRevision,policy);return {bvid:result.bvid,materials:result.materials};});
    }catch(error){service.#blocked(error);throw error;}
   }
  });
 }
 /** 本地凭据经身份验证与加密后提交；任何失败都不覆盖既有绑定。 */
 async bind(input,{signal,commitGuard}={}){
  exact(input,['expectedRevision','sessdata','buvid3']);this.#supported();const credentials=validateBilibiliCredentials({sessdata:input.sessdata,buvid3:input.buvid3});
  const check=()=>{signalCheck(signal);this.#store.bilibili.assertRevision(this.#owner,input.expectedRevision);};let requests=0;
  this.#guard(commitGuard,check);
  try{
   const account=await this.#client.identity({credentials,signal,beforeRequest:({operation})=>this.#guard(commitGuard,()=>{check();if(operation!=='identity'||requests>=1)throw new BilibiliAccountError('绑定只允许一次身份读取');this.#store.bilibili.reserveNetwork(this.#owner,operation);requests++;})});
   assertRequests(requests,1);this.#guard(commitGuard,check);
   const ciphertext=await this.#codec.protect(JSON.stringify(credentials),{signal});
   return this.#guard(commitGuard,()=>{check();this.#store.bilibili.bind(this.#owner,{expectedRevision:input.expectedRevision,account,ciphertext});return this.status();});
  }catch(error){this.#blocked(error);throw error;}
 }
 /** 解绑不需网络，暂停时仍可执行；不更改主动联系/发布/成长开关。 */
 unbind(input,{commitGuard}={}){exact(input,['expectedRevision']);return this.#guard(commitGuard,()=>{this.#store.bilibili.unbind(this.#owner,input);return this.status();});}
 /** 有上限的单视频只读验证：不写观察、聊天或成长，不调用模型。 */
 async verify(input,{signal,commitGuard}={}){
  exact(input,['expectedRevision','bvid']);this.#supported();if(typeof input.bvid!=='string'||!/^BV[A-Za-z0-9]{10}$/.test(input.bvid))throw new BilibiliAccountError('请输入有效BV号');
  const policy=this.#store.content.settings(this.#contentOwner);if(!policy.readEnabled)throw new BilibiliAccountError('请先开启B站读取权限','FORBIDDEN');
  const check=()=>{signalCheck(signal);this.#store.bilibili.assertRevision(this.#owner,input.expectedRevision);const current=this.#store.content.settings(this.#contentOwner);if(!current.readEnabled||current.revision!==policy.revision||current.accountId!==policy.accountId)throw new BilibiliAccountError('读取策略或账号已变化','CONFLICT');};
  const sealed=this.#guard(commitGuard,()=>{check();const current=this.status();if(current.network.remaining<4)throw new BilibiliAccountError('剩余只读额度不足4次','BUDGET');return this.#store.bilibili.encrypted(this.#owner,input.expectedRevision);});
  const plaintext=await this.#codec.unprotect(sealed.ciphertext,{signal});let credentials;try{credentials=validateBilibiliCredentials(JSON.parse(plaintext));}catch{throw new BilibiliAccountError('本地凭据无法读取，请重新绑定','STORAGE_UNAVAILABLE');}
  let requests=0;
  try{
   const result=await this.#client.inspect({credentials,expectedAccountId:sealed.account.id,bvid:input.bvid,creatorIds:[...policy.creatorIds],signal,beforeRequest:({operation})=>this.#guard(commitGuard,()=>{check();if(!['identity','view','player','subtitle'].includes(operation)||requests>=4)throw new BilibiliAccountError('只读验证请求超出本轮范围');this.#store.bilibili.reserveNetwork(this.#owner,operation);requests++;})});
   if(requests<2||requests>4)throw new BilibiliAccountError('只读验证未执行预期请求','INVALID_RESPONSE');
   return this.#guard(commitGuard,()=>{check();return {...result,requestsUsed:requests};});
  }catch(error){this.#blocked(error);throw error;}
 }
}
function assertRequests(actual,expected){if(actual!==expected)throw new BilibiliAccountError('身份验证未执行预期请求','INVALID_RESPONSE');}
