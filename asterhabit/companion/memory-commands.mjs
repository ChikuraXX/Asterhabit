import { MemoryError } from './memory-store.mjs';

/** 仅处理可信本地终端命令；模型回复永远不送入此解析器。 */
export async function memoryCommand(text,{store,scope,session,index}) {
  const split=text.trim().indexOf(' ');
  const name=split<0?text.trim():text.trim().slice(0,split);
  const body=split<0?'':text.trim().slice(split+1).trim();
  const source=value=>({origin:'user',text:value,reference:'local:owner-command'});
  if(name==='/memory')return {records:store.search(scope,body)};
  if(name==='/status')return {...store.status(scope),records:store.list(scope).length,pendingCleanup:store.nativeLeases(scope).length,manualPendingTotal:index?.manualPending??0};
  if(name==='/sync')return await store.sync(scope);
  if(name==='/recover'){await session.recover();return {recovered:true};}
  if(name==='/forget') {
    store.forget(scope,body);
    const index=await store.sync(scope);
    return {forgotten:true,index,pendingCleanup:store.nativeLeases(scope).length};
  }
  if(name==='/remember'||name==='/correct') {
    const separator=body.indexOf('|');
    if(separator<1)throw new MemoryError('格式：'+name+' '+(name==='/remember'?'主题':'记录ID')+' | 内容');
    const key=body.slice(0,separator).trim(),value=body.slice(separator+1).trim();
    const row=name==='/remember'?store.remember(scope,{topic:key,text:value},source(value)):store.correct(scope,key,value,source(value));
    return {record:row,index:await store.sync(scope)};
  }
  throw new MemoryError('未知命令；支持 /memory /remember /correct /forget /status /sync /recover /exit');
}

