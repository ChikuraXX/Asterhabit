import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectOrStartBackend} from '../companion/backend-launcher.mjs';
import {runDesktopProxy} from '../companion/desktop-proxy.mjs';

// 桌面仅持有私有连接，应用与调度由独立后台拥有。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{const client=await connectOrStartBackend({root});const proxy=runDesktopProxy({client});for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{process.stdin.destroy();void proxy.detach().catch(()=>{process.exitCode=1;});});}
catch{console.error('后台连接未完成，请检查运行状态');process.exitCode=1;}
