import path from 'node:path';import {fileURLToPath} from 'node:url';import {readFileSync} from 'node:fs';
import {createApplication} from '../companion/application-runtime.mjs';
import {createBackendService} from '../companion/backend-service.mjs';
import {processIdentityProbe} from '../companion/process-identity.mjs';

// 固定应用入口持有数据库与调度；不继承GUI的stdio生命周期，不安装系统服务。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),state=path.join(root,'state');
let service;
try{
 const config=JSON.parse(readFileSync(path.join(root,'local-runtime.json'),'utf8')),powershell=path.join(config.powershellDirectory,'pwsh.exe');
 const probe=processIdentityProbe(process.platform==='win32'?powershell:undefined);
 service=await createBackendService({state,powershell,...probe,applicationFactory:()=>createApplication({root,state})});
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void service.close().catch(()=>{process.exitCode=1;});});
 const result=await service.closed;if(result.cleanupFailed)process.exitCode=1;
}catch(error){process.exitCode=error.code==='BACKEND_ALREADY_RUNNING'?0:1;console.error(error.code==='BACKEND_ALREADY_RUNNING'?'后台已在运行':'后台启动或清理未完成');}
