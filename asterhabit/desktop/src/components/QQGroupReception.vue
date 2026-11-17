<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from "vue";
import {desktopApi,type QQGroupState} from "../api";
import {qqSettingsText as t} from "../qqSettingsMessages";

/** 只核对已保存群的平台接收设置，不保存策略，也不自动请求平台。 */
const props=defineProps<{agentId:string;connectionRevision:number|null;groupIds:string[];active:boolean}>();
const states=ref<Record<string,QQGroupState>>({}),errors=ref<Record<string,string>>({}),busy=ref<string|null>(null);
let generation=0,disposed=false;
const scope=computed(()=>JSON.stringify([props.agentId,props.connectionRevision,props.groupIds,props.active]));
/** 显式读取映射自有键，合法OpenID不应命中对象原型属性。 */
const groups=computed(()=>props.groupIds.map(id=>({id,state:Object.hasOwn(states.value,id)?states.value[id]:undefined,error:Object.hasOwn(errors.value,id)?errors.value[id]:""})));
/** 平台all与仅@/上下文模式明确区分，不把查询成功当作本地授权。 */
function modeLabel(mode:QQGroupState["receiveMode"]):string{return t({all:"全部群消息",only_mention:"仅 @ 机器人",mention_and_context:"@ 及相关上下文",unknown:"未识别的平台模式"}[mode]);}
/** 单次只读核验，Agent/账号/列表/离页变化后忽略迟到结果。 */
async function check(groupId:string):Promise<void>{
  if(busy.value||!props.active||props.connectionRevision===null)return;
  const token=++generation,key=scope.value,agentId=props.agentId,revision=props.connectionRevision;
  busy.value=groupId;errors.value={...errors.value,[groupId]:""};
  const current=()=>!disposed&&props.active&&token===generation&&scope.value===key;
  try{const state=await desktopApi.getQQGroupState(agentId,revision,groupId);if(!current())return;if(state.openid!==groupId||!["all","only_mention","mention_and_context","unknown"].includes(state.receiveMode))throw new Error("QQ群状态响应无效");states.value={...states.value,[groupId]:state};}
  catch(reason){if(current())errors.value={...errors.value,[groupId]:t(reason instanceof Error?reason.message:String(reason))};}
  finally{if(current())busy.value=null;}
}
watch(scope,()=>{generation++;states.value={};errors.value={};busy.value=null;});
onUnmounted(()=>{disposed=true;generation++;});
</script>

<template>
  <div class="qq-group-reception">
    <p v-if="!groupIds.length" class="form-hint">{{ t("先保存群条目，再检查平台接收范围。") }}</p>
    <div v-for="group in groups" :key="group.id" class="group-reception-row">
      <div><small>{{ group.id }}</small><span>{{ t("QQ 平台接收范围") }}：{{ group.state ? modeLabel(group.state.receiveMode) : t("未核验") }}</span><small v-if="group.state?.receiveMode === 'unknown'">{{ t("平台返回的接收设置无法确认，请在 QQ 平台核对。") }}<span v-if="group.state.reportedMode"> {{ t("报告值：{0}",group.state.reportedMode) }}</span></small><small v-else-if="group.state && group.state.receiveMode !== 'all'">{{ t("平台尚未开启全量消息，本地选择不会开通该权限。") }}</small></div>
      <button type="button" class="button quiet" :disabled="Boolean(busy) || connectionRevision === null || !active" @click="check(group.id)">{{ t(busy === group.id ? "检查中…" : "检查平台设置") }}</button>
      <p v-if="group.error" class="inline-error" role="alert">{{ group.error }}</p>
    </div>
  </div>
</template>

<style scoped>
.qq-group-reception{display:grid;gap:12px;margin-top:12px}.group-reception-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.group-reception-row>div{display:grid;gap:5px;flex:1;min-width:0}.group-reception-row small{color:var(--muted);overflow-wrap:anywhere}.group-reception-row>p{flex-basis:100%;margin:0}.group-reception-row .button{flex-shrink:0}@media(max-width:520px){.group-reception-row{align-items:flex-start;flex-direction:column}}
</style>
