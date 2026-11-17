import {readFileSync,existsSync,mkdirSync,copyFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {AgentRegistry,AgentError} from './agent-registry.mjs';
export const APPLICATION_PROTOCOL=2;
const markerName='application-protocol.json';
/** 原单Agent配置仅用于显式离线迁移，不作为新应用的第二个配置真相源。 */
function legacyConfiguration(root,state){const selected=JSON.parse(readFileSync(path.join(state,'model-selection.json'),'utf8'));return {name:'小夏',nickname:'Konatsu',persona:readFileSync(path.join(root,'characters','konatsu.txt'),'utf8'),model:selected.model,dialogueModel:selected.dialogueModel??selected.model,dialogueReasoningEffort:selected.dialogueReasoningEffort??'none',reflectionModel:null,reflectionReasoningEffort:null};}
/** 当前入口必须核对成功标记和legacy归属，数据库存在本身不是迁移完成证明。 */
export function assertApplicationProtocol(state){
  try{const marker=JSON.parse(readFileSync(path.join(state,markerName),'utf8'));if(marker.protocol!==APPLICATION_PROTOCOL||marker.complete!==true||typeof marker.legacyAgentId!=='string'||!existsSync(path.join(state,'application.sqlite')))throw new Error('marker');const db=new DatabaseSync(path.join(state,'application.sqlite'),{readOnly:true});try{if(db.prepare('SELECT id FROM agents WHERE legacy=1').get()?.id!==marker.legacyAgentId)throw new Error('identity');}finally{db.close();}return marker;}
  catch{throw new AgentError('应用数据协议未就绪；请关闭旧控制台和聊天CLI后运行 node scripts/migrate-application.mjs','MIGRATION_REQUIRED');}
}
/** 显式离线升级，确认写者停止后备份、初始化注册并原子发布成功标记，不搬移原库。 */
export function migrateApplication({root,state,assertOffline}) {
  if(typeof assertOffline!=='function')throw new AgentError('迁移必须检查旧写者');
  if(existsSync(path.join(state,markerName)))return {...assertApplicationProtocol(state),alreadyComplete:true};
  mkdirSync(state,{recursive:true,mode:0o700});const lock=path.join(state,'application-migration.lock'),token=randomUUID(),temporary=path.join(state,markerName+'.'+token+'.tmp');let handle;
  try{handle=openSync(lock,'wx',0o600);writeFileSync(handle,JSON.stringify({pid:process.pid,token}));assertOffline();
    const legacy=legacyConfiguration(root,state),backup=path.join(state,'backups','asterhabit-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+token.slice(0,8));mkdirSync(backup,{recursive:true,mode:0o700});let initialPaused=false;
    for(const [file,name]of[[path.join(state,'memory','memory.sqlite'),'memory.sqlite'],[path.join(state,'control','control.sqlite'),'control.sqlite'],[path.join(state,'application.sqlite'),'application.sqlite']]){if(!existsSync(file))continue;const db=new DatabaseSync(file,{readOnly:true});try{if(name==='memory.sqlite'){
        const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
        if(tables.has('native_leases')&&db.prepare('SELECT count(*) AS count FROM native_leases').get().count>0)throw new AgentError('原小夏仍有未清理的原生会话，请先按旧运行方式核实并恢复清理，再执行离线迁移。','MIGRATION_RECOVERY_REQUIRED');
        if(tables.has('reflection_runs')&&db.prepare("SELECT count(*) AS count FROM reflection_runs WHERE status='claimed'").get().count>0)throw new AgentError('原小夏仍有未恢复的反思任务，请先完成清理；尚未发布成功标记。','MIGRATION_RECOVERY_REQUIRED');
      }if(name==='control.sqlite')initialPaused=Boolean(db.prepare('SELECT paused FROM control_state WHERE id=1').get()?.paused);db.prepare('VACUUM INTO ?').run(path.join(backup,name));}finally{db.close();}}
    for(const [file,name]of[[path.join(state,'model-selection.json'),'model-selection.json'],[path.join(root,'characters','konatsu.txt'),'konatsu.txt']])copyFileSync(file,path.join(backup,name));assertOffline();
    const registry=new AgentRegistry(path.join(state,'application.sqlite'),{legacy,initialPaused});let legacyAgentId;try{const owner=registry.ownerAuthority();legacyAgentId=registry.legacyId(owner);if(registry.list(owner).filter(a=>a.legacy).length!==1)throw new AgentError('旧角色归属验证失败');}finally{registry.close();}
    const registered=new DatabaseSync(path.join(state,'application.sqlite'),{readOnly:true});
    try{if(registered.prepare('SELECT count(*) AS count FROM model_slot WHERE scope_id IS NULL OR contact_id IS NULL').get().count)throw new AgentError('发现旧版未完成任务但无法确定联系人范围；请保留备份并先核实该Agent的原生租约归属，完成旧版任务清理后再迁移。尚未发布成功标记。','MIGRATION_RECOVERY_REQUIRED');}finally{registered.close();}
    assertOffline();
    const marker={protocol:APPLICATION_PROTOCOL,complete:true,legacyAgentId,completedAt:new Date().toISOString(),backup:path.relative(state,backup)};writeFileSync(path.join(backup,'manifest.json'),JSON.stringify(marker,null,2),{mode:0o600});writeFileSync(temporary,JSON.stringify(marker,null,2),{flag:'wx',mode:0o600});renameSync(temporary,path.join(state,markerName));return {...assertApplicationProtocol(state),alreadyComplete:false};
  }finally{if(existsSync(temporary))unlinkSync(temporary);if(handle!==undefined){closeSync(handle);if(JSON.parse(readFileSync(lock,'utf8')).token===token)unlinkSync(lock);}}
}
