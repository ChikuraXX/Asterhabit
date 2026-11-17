<script setup lang="ts">
import {computed,onActivated,onDeactivated,onUnmounted,ref,watch} from 'vue';
import {desktopApi,DAILY_BUDGET,type QQContactPolicy,type QQContactPlan} from '../api';
import {qqContactText as t} from '../qqContactMessages';

const props=defineProps<{agentId:string;connectionRevision:number;receiveRevision:number}>();
const policies=ref<QQContactPolicy[]>([]),selected=ref(''),form=ref<QQContactPolicy|null>(null),plans=ref<QQContactPlan[]>([]),edits=ref<Record<string,string>>({}),review=ref<QQContactPlan|null>(null);
const start=ref(''),end=ref(''),busy=ref(false),error=ref(''),message=ref('');let epoch=0,active=true;
const statusLabels:Record<QQContactPlan['status'],string>={pending:'待审核',sending:'发送中',sent:'已发送',failed:'失败',unknown:'结果未知',invalidated:'已失效',expired:'已过期',cancelled:'已取消'};
const selectedPolicy=computed(()=>policies.value.find(p=>p.targetId===selected.value));
/** 分钟值以本地表单字符串显示；实际时段按所选时区由后端核验。 */
function formatMinute(value:number):string{return `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;}
function parseMinute(value:string):number{if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw new Error(t('时间或数值无效'));return Number(value.slice(0,2))*60+Number(value.slice(3));}
function selectPolicy():void{const p=selectedPolicy.value;form.value=p?{...p,autoPlanEnabled:p.autoPlanEnabled??false,dailyPlanLimit:p.dailyPlanLimit??2}:null;start.value=p?formatMinute(p.windowStartMinute):'';end.value=p?formatMinute(p.windowEndMinute):'';}
watch(selected,selectPolicy);
/** 同一操作链只应用当前Agent/连接代次的结果，不重放离页时的写请求。 */
async function run(operation:()=>Promise<void>):Promise<void>{if(busy.value||!active)return;const current=epoch;busy.value=true;error.value='';message.value='';try{await operation();}catch(reason){if(current===epoch&&active)error.value=reason instanceof Error?reason.message:String(reason);}finally{if(current===epoch&&active)busy.value=false;}}
async function refresh():Promise<void>{const current=epoch,agentId=props.agentId;const [p,list]=await Promise.all([desktopApi.getQQContactPolicies(agentId),desktopApi.listQQContactPlans(agentId)]);if(current!==epoch||!active)return;policies.value=p.entries;plans.value=list.entries;edits.value=Object.fromEntries(list.entries.map(item=>[item.id,item.text]));if(!p.entries.some(item=>item.targetId===selected.value))selected.value=p.entries[0]?.targetId??'';selectPolicy();}
function reload():void{void run(refresh);}
async function savePolicy():Promise<void>{const p=form.value;if(!p)return;const values=[p.dailyPlanLimit??2,p.dailyLimit,p.minGapSeconds,p.quietSeconds,p.planTtlMinutes];if(values.some(v=>!Number.isSafeInteger(v))){error.value=t('时间或数值无效');return;}let first,last;try{first=parseMinute(start.value);last=parseMinute(end.value);}catch(reason){error.value=reason instanceof Error?reason.message:String(reason);return;}await run(async()=>{const current=epoch,{revision,...policy}=p;await desktopApi.configureQQContact({...policy,agentId:props.agentId,expectedRevision:revision,windowStartMinute:first,windowEndMinute:last});if(current!==epoch||!active)return;await refresh();if(current!==epoch||!active)return;message.value=t('主动授权已保存');});}
async function generate():Promise<void>{await run(async()=>{const current=epoch,result=await desktopApi.generateQQContactPlan(props.agentId,selected.value);if(current!==epoch||!active)return;await refresh();if(current!==epoch||!active)return;message.value=t(result.outcome==='quiet'?'本轮保持安静':'计划已生成');});}
async function update(plan:QQContactPlan):Promise<void>{await run(async()=>{const current=epoch;await desktopApi.updateQQContactPlan(props.agentId,plan.id,plan.revision,edits.value[plan.id]??'');if(current!==epoch||!active)return;await refresh();if(current!==epoch||!active)return;message.value=t('修改已保存');});}
async function cancel(plan:QQContactPlan):Promise<void>{await run(async()=>{const current=epoch;await desktopApi.cancelQQContactPlan(props.agentId,plan.id,plan.revision);if(current!==epoch||!active)return;await refresh();if(current!==epoch||!active)return;message.value=t('计划已取消');});}
function openReview(plan:QQContactPlan):void{if(edits.value[plan.id]!==plan.text){error.value=t('请先保存正文修改');return;}review.value=plan;}
async function send():Promise<void>{const plan=review.value;if(!plan?.confirmationHash)return;const hash=plan.confirmationHash;await run(async()=>{const current=epoch;const result=await desktopApi.sendQQContactPlan(props.agentId,plan.id,plan.revision,hash);if(current!==epoch||!active)return;review.value=null;await refresh();if(current!==epoch||!active)return;message.value=t(result.outcome==='sent'?'发送成功':result.outcome==='unknown'?'发送结果未知，请勿重复发送':'发送失败');});}
function reset():void{epoch++;busy.value=false;policies.value=[];form.value=null;plans.value=[];review.value=null;selected.value='';error.value='';message.value='';if(active)reload();}
watch(()=>[props.agentId,props.connectionRevision,props.receiveRevision],reset,{immediate:true});
onDeactivated(()=>{active=false;epoch++;busy.value=false;review.value=null;});onActivated(()=>{if(!active){active=true;reset();}});onUnmounted(()=>{active=false;epoch++;});
</script>

<template>
 <section class="settings-section qq-contact-panel" :aria-label="t('主动联系（私聊）')">
  <h2>{{ t('主动联系（私聊）') }}</h2>
  <p v-if="error" class="inline-error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
  <div class="button-row"><button class="button" type="button" :disabled="busy" @click="reload">{{ t('刷新') }}</button><span v-if="busy" role="status">{{ t('处理中…') }}</span></div>
  <p v-if="!policies.length && !busy">{{ t('暂无私聊目标') }}</p>
  <form v-if="form" @submit.prevent="savePolicy">
   <label class="setting-row"><span>{{ t('联系人QQ号') }}</span><select v-model="selected" :disabled="busy" name="contactTarget"><option v-for="p in policies" :key="p.targetId" :value="p.targetId">{{ p.targetId }}</option></select></label>
   <label class="setting-row toggle-row"><span>{{ t('允许主动联系（审核发送）') }}</span><input v-model="form.enabled" name="contactEnabled" type="checkbox" role="switch" :disabled="busy" /></label>
   <label class="setting-row toggle-row"><span>{{ t('后台自动生成（仍需审核）') }}</span><input v-model="form.autoPlanEnabled" name="contactAutoPlan" type="checkbox" role="switch" :disabled="busy || !form.enabled" /></label>
   <div class="field-grid">
    <label><span>{{ t('滚动24小时自动生成阶段上限') }}</span><input v-model.number="form.dailyPlanLimit" name="contactDailyPlanLimit" type="number" min="0" :max="DAILY_BUDGET.modelCallMaximum" step="1" required :disabled="busy" /></label>
    <label><span>{{ t('每日主动发送上限') }}</span><input v-model.number="form.dailyLimit" name="contactDailyLimit" type="number" min="0" :max="DAILY_BUDGET.messageMaximum" step="1" required :disabled="busy" /></label>
    <label><span>{{ t('最小主动间隔（秒）') }}</span><input v-model.number="form.minGapSeconds" name="contactMinGap" type="number" min="30" max="86400" step="1" required :disabled="busy" /></label>
    <label><span>{{ t('安静间隔（秒）') }}</span><input v-model.number="form.quietSeconds" name="contactQuiet" type="number" min="0" max="86400" step="1" required :disabled="busy" /></label>
    <label><span>{{ t('计划有效期（分钟）') }}</span><input v-model.number="form.planTtlMinutes" name="contactTtl" type="number" min="1" max="1440" step="1" required :disabled="busy" /></label>
    <label><span>{{ t('时区') }}</span><input v-model.trim="form.timeZone" name="contactTimezone" maxlength="80" required :disabled="busy" /></label>
    <label><span>{{ t('开始时间') }}</span><input v-model="start" name="contactStart" type="time" required :disabled="busy" /></label>
    <label><span>{{ t('结束时间') }}</span><input v-model="end" name="contactEnd" type="time" required :disabled="busy" /></label>
   </div>
   <footer class="settings-footer"><button class="button primary" type="submit" :disabled="busy">{{ t('保存主动授权') }}</button><button class="button" type="button" :disabled="busy || !selectedPolicy?.enabled" @click="generate">{{ t('生成计划') }}</button></footer>
  </form>
  <p v-if="!plans.length && !busy">{{ t('暂无主动计划') }}</p>
  <section v-for="plan in plans" :key="plan.id" class="contact-plan">
   <h3>{{ plan.target.id }} · {{ t(statusLabels[plan.status]) }}</h3>
   <p>{{ t('联系理由') }}：{{ plan.reason }}</p>
   <p>{{ t('预计时间') }}：{{ new Date(plan.dueAt).toLocaleString() }} · {{ t('到期时间') }}：{{ new Date(plan.expiresAt).toLocaleString() }}</p>
   <details><summary>{{ t('来源') }}</summary><p class="contact-content">{{ plan.source.text }}</p></details>
   <label><span>{{ t('计划全文') }}</span><textarea v-model="edits[plan.id]" rows="4" maxlength="2000" :readonly="plan.status !== 'pending'" :disabled="busy" /></label>
   <div v-if="plan.status === 'pending'" class="button-row"><button class="button" type="button" :disabled="busy || edits[plan.id] === plan.text" @click="update(plan)">{{ t('保存修改') }}</button><button class="button" type="button" :disabled="busy" @click="cancel(plan)">{{ t('取消计划') }}</button><button class="button primary" type="button" :disabled="busy" @click="openReview(plan)">{{ t('审核发送') }}</button></div>
  </section>
  <div v-if="review" class="modal-backdrop" @click.self="!busy && (review=null)"><section class="modal" role="dialog" aria-modal="true" :aria-label="t('审核发送')"><header><h2>{{ t('审核发送') }}</h2></header><div class="modal-body"><p>{{ t('发送目标') }}：{{ review.target.id }}</p><p class="contact-content">{{ review.text }}</p><p>{{ t('发送前请确认目标与全文') }}</p><p v-if="error" class="inline-error" role="alert">{{ error }}</p></div><footer><button class="button" type="button" :disabled="busy" @click="review=null">{{ t('取消') }}</button><button class="button primary" type="button" :disabled="busy" @click="send">{{ t('确认发送') }}</button></footer></section></div>
 </section>
</template>
<style scoped>
.qq-contact-panel,.qq-contact-panel form,.contact-plan{min-width:0}.contact-plan{border-top:1px solid var(--border);padding:18px 0;margin-top:18px}.contact-plan label{display:grid;gap:6px}.contact-plan textarea{width:100%;min-width:0}.contact-plan p,.contact-plan h3{overflow-wrap:anywhere}.contact-content{white-space:pre-wrap;overflow-wrap:anywhere}.contact-plan .button-row{margin-top:12px;flex-wrap:wrap}.qq-contact-panel .settings-footer{gap:12px;flex-wrap:wrap}
</style>
