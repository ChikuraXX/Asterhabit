import {QQBotSendClient} from './qqbot-send-client.mjs';
import {QQService} from './qq-service.mjs';
import {QQBotClient} from './qqbot-client.mjs';
import {BilibiliAccountService} from './bilibili-account-service.mjs';
import {BilibiliReadonlyClient} from './bilibili-readonly.mjs';
import {createWindowsCredentialCodec} from './windows-credential-codec.mjs';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {AgentRegistry} from './agent-registry.mjs';
import {ApplicationHost} from './application-host.mjs';
import {MemoryStore} from './memory-store.mjs';
import {ControlStore} from './control-store.mjs';
import {GraphifyIndex} from './graphify-index.mjs';
import {DesktopHost} from './desktop-host.mjs';
import {PersistentCodexRuntime} from './codex-persistent-runtime.mjs';
import {ReflectionSession} from './reflection-session.mjs';
import {ProactiveSession} from './proactive-session.mjs';
import {ContentSession} from './content-session.mjs';
import {processIdentityProbe} from './process-identity.mjs';
import {assertApplicationProtocol} from './application-migration.mjs';
import {agentInstructions,agentReplyLanguage} from './agent-profile.mjs';
import {CodexAuthentication} from './codex-authentication.mjs';

/** 固定路径和主人配置建立真实应用。这里没有从renderer传路径、命令或凭据的接口。 */
export function createApplication({root,state,schedule=true,now=Date.now,contacts,contextName='private',modelOverride,reasoningOverride,python,contentProvider=null,snapshotSource,authentication:providedAuthentication,runtimeFactory=options=>new PersistentCodexRuntime(options)}) {
  assertApplicationProtocol(state);
  const config=JSON.parse(readFileSync(path.join(root,'local-runtime.json'),'utf8'));
  const probe=processIdentityProbe(process.platform==='win32'?path.join(config.powershellDirectory,'pwsh.exe'):undefined);
  const registry=new AgentRegistry(path.join(state,'application.sqlite'),{now,...probe});
  const owner=registry.ownerAuthority(),legacy=registry.get(owner,registry.legacyId(owner));
  const sourceAuthPath=snapshotSource??path.join(process.env.CODEX_HOME??path.join(process.env.USERPROFILE??process.env.HOME??state,'.codex'),'auth.json');
  const authentication=providedAuthentication??new CodexAuthentication({state,sourceAuthPath,codexExecutable:config.codexExecutable,codexExecutableSha256:config.codexExecutableSha256});
  const catalogueRuntime=runtimeFactory({root,state,...legacy,runtimeRole:'catalogue',authentication,sourceAuthPath,codexExecutable:config.codexExecutable,codexExecutableSha256:config.codexExecutableSha256,powershellDirectory:config.powershellDirectory});
  return new ApplicationHost({registry,owner,now,schedule,authentication,catalogue:()=>catalogueRuntime.listModels(),nativeModelConnection:(action,input)=>catalogueRuntime.modelConnection(action,input),dispose:async()=>{const outcomes=await Promise.allSettled([catalogueRuntime.close(),authentication.close()]);const failures=outcomes.filter(value=>value.status==='rejected');if(failures.length)throw new AggregateError(failures.map(value=>value.reason),'执行后端关闭未完成');},factory:(profile,guards)=>{
    const directory=profile.legacy?path.join(state,'memory'):path.join(state,'agents',profile.id);
    const index=new GraphifyIndex({directory:path.join(directory,'graphs'),...(python?{python}:{})});
    const store=new MemoryStore(path.join(directory,'memory.sqlite'),{index});
    const control=new ControlStore(profile.legacy?path.join(state,'control','control.sqlite'):path.join(directory,'control.sqlite'));
    const runtime=runtimeFactory({root,state,...profile,authorizationRevision:()=>control.snapshot(control.ownerAuthority()).revision,authentication,sourceAuthPath,codexExecutable:config.codexExecutable,codexExecutableSha256:config.codexExecutableSha256,powershellDirectory:config.powershellDirectory,persona:agentInstructions(profile),replyLanguage:agentReplyLanguage(profile),...(modelOverride?{model:modelOverride,dialogueModel:modelOverride,dialogueReasoningEffort:reasoningOverride??'low'}:reasoningOverride?{dialogueReasoningEffort:reasoningOverride}:{})});
    const host=new DesktopHost({store,index,control,gateway:runtime,connect:signal=>runtime.prepare(signal),connected:()=>runtime.connected,model:modelOverride??profile.dialogueModel,contacts,contextName,...guards});
    const growthOwner=store.growth.ownerAuthority(),proactiveOwner=store.proactive.ownerAuthority(),proactiveScope=store.bind({platform:'local',subject:'owner',context:'private'});
    const contentOwner=store.content.ownerAuthority();if(contentProvider)store.content.bindAccount(contentOwner,contentProvider.account);
    const codec=createWindowsCredentialCodec({powershell:path.join(config.powershellDirectory,'pwsh.exe'),scriptPath:path.join(root,'scripts','credential-codec.ps1'),purpose:'asterhabit:bilibili:'+profile.id});
    const bilibili=new BilibiliAccountService({store,codec,client:new BilibiliReadonlyClient()});
    const qqCodec=createWindowsCredentialCodec({powershell:path.join(config.powershellDirectory,'pwsh.exe'),scriptPath:path.join(root,'scripts','credential-codec.ps1'),purpose:'asterhabit:qq:'+profile.id});
    const qq=new QQService({store,codec:qqCodec,client:new QQBotClient(),agentId:profile.id,gateway:runtime,leaseScope:proactiveScope,profileRevision:profile.profileRevision,sender:new QQBotSendClient(),now});
    return {host,store,index,runtime,growthOwner,proactiveOwner,proactiveScope,contentOwner,bilibili,qq,contentFor:scope=>new ContentSession({store,scope,gateway:runtime,owner:contentOwner,provider:contentProvider??bilibili.contentProvider()}),proactiveFor:scope=>new ProactiveSession({store,scope,gateway:runtime,owner:proactiveOwner,profileRevision:profile.profileRevision}),reflectionFor:scope=>new ReflectionSession({store,scope,gateway:runtime,owner:growthOwner,leaseScope:store.reply?.ownsScope(scope)?proactiveScope:scope})};
  }});
}
