import {StringDecoder} from 'node:string_decoder';
/** 私有stdio代理：关联原生窗口请求ID；EOF仅脱离，完全退出须显式host.shutdown。 */
export function runDesktopProxy({client,input=process.stdin,output=process.stdout}){
 const decoder=new StringDecoder('utf8'),ids=new Set();let buffer='',closing=false,closePromise;
 const send=frame=>{if(!output.destroyed)output.write(JSON.stringify(frame)+'\n');};
 const detach=()=>{if(closePromise)return closePromise;closing=true;closePromise=(async()=>{try{await client.request('host.detach',{});}finally{client.close();}})();return closePromise;};
 const dispatch=async frame=>{
  if(!frame||typeof frame.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(frame.id)||typeof frame.operation!=='string'||Object.keys(frame).some(key=>!['id','operation','payload'].includes(key))||!frame.payload||typeof frame.payload!=='object'||Array.isArray(frame.payload)){send({id:null,ok:false,error:'请求格式无效',code:'INVALID_REQUEST'});return;}
  if(ids.has(frame.id)||ids.size>=32&&!['host.detach','host.shutdown','chat.cancel','runtime.pause','agent.pause'].includes(frame.operation)){send({id:frame.id,ok:false,error:'请求过多或编号重复',code:'BUSY'});return;}
  ids.add(frame.id);
  try{
   const reply=await client.request(frame.operation,frame.payload);send({...reply,id:frame.id});
   if(['host.detach','host.shutdown'].includes(frame.operation)&&reply.ok){closing=true;client.close();input.destroy();}
  }catch{send({id:frame.id,ok:false,error:'后台已断开，请重新打开应用',code:'BACKEND_UNAVAILABLE'});}
  finally{ids.delete(frame.id);}
 };
 input.on('data',chunk=>{if(closing)return;buffer+=decoder.write(chunk);let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(Buffer.byteLength(line)>1048576){input.destroy();void detach().catch(()=>{});return;}if(!line.trim())continue;try{void dispatch(JSON.parse(line));}catch{send({id:null,ok:false,error:'请求JSON无效',code:'INVALID_REQUEST'});}}if(Buffer.byteLength(buffer)>1048576){input.destroy();void detach().catch(()=>{});}});
 input.on('end',()=>{if(!closing)void detach().catch(()=>{process.exitCode=1;});});input.on('error',()=>{void detach().catch(()=>{process.exitCode=1;});});
 return {detach};
}
