import {QQBotAPI,QQBotError,validateQQBotConnection} from './qqbot-client.mjs';

const MESSAGES=Object.freeze({INVALID_REQUEST:'QQ机器人发送参数无效',DENIED:'QQ机器人发送许可已失效',CANCELLED:'QQ机器人发送已取消',PREPARE:'QQ机器人发送准备失败',PLATFORM:'QQ机器人平台拒绝发送',UNKNOWN:'QQ机器人发送结果未确认'});

/** 标识发送是否已经派发以及平台是否明确拒绝，正文和凭据不会进入错误。 */
export class QQBotSendError extends Error{
  constructor(code,{dispatched=false,confirmedRejected=false,receipt=null}={}){super(MESSAGES[code]??'QQ机器人发送未完成');this.name='QQBotSendError';this.code=code;this.dispatched=dispatched;this.confirmedRejected=confirmedRejected;this.receipt=receipt;}
}
function exact(value,keys){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');}
function validMessageId(value){return typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/u.test(value);}
function validate(options){
  if(!exact(options,['appId','appSecret','target','text','messageId','signal','dispatch'].filter(key=>key!=='signal'||Object.hasOwn(options??{},'signal'))))throw new QQBotSendError('INVALID_REQUEST');
  let credentials;try{credentials=validateQQBotConnection({appId:options.appId,appSecret:options.appSecret});}catch{throw new QQBotSendError('INVALID_REQUEST');}
  const {target,text,messageId,signal,dispatch}=options;
  if(!exact(target,['kind','id'])||!['private','group'].includes(target.kind)||typeof target.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(target.id)||typeof text!=='string'||!text.trim()||text.length>2000||!validMessageId(messageId)||typeof dispatch!=='function'||signal!==undefined&&(typeof signal!=='object'||typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'))throw new QQBotSendError('INVALID_REQUEST');
  if(signal?.aborted)throw new QQBotSendError('CANCELLED');
  return {...credentials,target:{...target},text,messageId,signal,dispatch};
}

/** 官方QQ机器人纯文本被动回复适配器；不提供任意接口或内部重试。 */
export class QQBotSendClient{
  #api;
  constructor({api}={}){this.#api=api??new QQBotAPI();if(!(this.#api instanceof QQBotAPI))throw new QQBotSendError('INVALID_REQUEST');}
  async sendText(options){
    let value;try{value=validate(options);}catch(error){return Promise.reject(error);}
    let token;
    try{token=await this.#api.accessToken({appId:value.appId,appSecret:value.appSecret},{signal:value.signal});}catch(error){
      const confirmedRejected=error instanceof QQBotError&&error.confirmedRejected===true;
      throw new QQBotSendError(confirmedRejected?'PLATFORM':value.signal?.aborted?'CANCELLED':'PREPARE',{dispatched:false,confirmedRejected,receipt:error instanceof QQBotError?error.receipt:null});
    }
    let dispatched=false,requestPromise=null;
    const sendNow=()=>{
      if(dispatched||value.signal?.aborted)throw new QQBotSendError(value.signal?.aborted?'CANCELLED':'DENIED',{dispatched});
      dispatched=true;requestPromise=this.#api.sendTextWithToken(token,{target:value.target,text:value.text,messageId:value.messageId,signal:value.signal});
    };
    try{
      const gateResult=value.dispatch(sendNow);
      if(gateResult&&typeof gateResult.then==='function'){void Promise.resolve(gateResult).catch(()=>{});throw new QQBotSendError('DENIED',{dispatched});}
      if(!dispatched||!requestPromise)throw new QQBotSendError('DENIED');
    }catch(error){
      if(requestPromise)void Promise.resolve(requestPromise).catch(()=>{});
      if(error instanceof QQBotSendError)throw error;
      throw new QQBotSendError('DENIED',{dispatched});
    }
    try{
      const response=await requestPromise;
      if(typeof response.id!=='string'||!response.id||response.id.length>512)throw new QQBotSendError('UNKNOWN',{dispatched:true,receipt:response.receipt??null});
      return {messageId:response.id,receipt:response.receipt??null};
    }catch(error){
      if(error instanceof QQBotSendError)throw error;
      const confirmedRejected=error instanceof QQBotError&&error.confirmedRejected===true;
      throw new QQBotSendError(confirmedRejected?'PLATFORM':'UNKNOWN',{dispatched:true,confirmedRejected,receipt:error instanceof QQBotError?error.receipt:error?.receipt??null});
    }
  }
}

