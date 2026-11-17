const warned=new WeakSet();
/** 兼容旧临时运行时；常驻运行时只释放本轮执行，不伪称线程已删除。 */
export async function releaseNativeExecution(gateway,store,scope,lease,runtime,{signal,recover=false,remoteDeleted=false}={}){
 if(recover&&typeof gateway.recoverExecution==='function')return gateway.recoverExecution(runtime,{onReleased:()=>store.markNativeReleased(scope,lease)});
 if(!recover&&typeof gateway.release==='function')return gateway.release(runtime,{reason:signal?.aborted?'cancelled':undefined,onReleased:()=>store.markNativeReleased(scope,lease)});
 return gateway.destroy(runtime,{remoteDeleted,reason:signal?.aborted?'cancelled':undefined,onRemoteDeleted:()=>store.markNativeDeleted(scope,lease)});
}
/** 执行缓存确认不推翻已提交的业务结果；异常时旧provisional线程不得自动复用。 */
export function confirmNativeExecution(gateway,runtime,text,history){if(!runtime||typeof gateway.commit!=='function')return false;try{return gateway.commit(runtime,{text,history});}catch{try{gateway.discard?.(runtime);}catch{}if(!warned.has(gateway)){warned.add(gateway);console.error('持久线程缓存提交未确认；业务结果已保存，后续需重建上下文');}return false;}}
/** 草稿取消/未知回执只废弃执行缓存，不重发也不改变平台结果。 */
export function discardNativeExecution(gateway,runtime){if(!runtime||typeof gateway.discard!=='function')return;try{gateway.discard(runtime);}catch{if(!warned.has(gateway)){warned.add(gateway);console.error('持久线程缓存撤销未确认，后续需核验上下文');}}}
