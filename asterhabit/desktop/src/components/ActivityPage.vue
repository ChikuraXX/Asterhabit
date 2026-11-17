<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";

import {
  desktopApi,
  type Action,
  type ActionKind,
  type Audit,
  type ProactiveInboxEntry,
  type ProactivePlan,
} from "../api";
import { createLatestRequestGuard } from "../requestGuard";
import { createScopedDraftStore } from "../uiState";
import { uiText } from "../i18n";
import {
  appendUniqueById,
  canCancelProactivePlanStatus,
  canReadProactiveInbox,
  proactiveInboxStatusLabel,
  proactivePlanStatusLabel,
} from "../proactiveUiState";

const props = defineProps<{ agentId: string; actions: Action[] }>();
const emit = defineEmits<{ "snapshot-changed": [] }>();

const actionOptions: Array<{ value: ActionKind; label: string }> = [
  { value: "read_post", label: "读取合成帖子" },
  { value: "draft_reply", label: "起草模拟回复" },
  { value: "submit_reply", label: "提交模拟回复" },
];

const target = ref("");
const actionKind = ref<ActionKind>("read_post");
const content = ref("");
const audit = ref<Audit[]>([]);
const plans = ref<ProactivePlan[]>([]);
const inbox = ref<ProactiveInboxEntry[]>([]);
const submitting = ref(false);
const auditLoading = ref(false);
const planLoading = ref(false);
const inboxLoading = ref(false);
const plansNextCursor = ref<string | null>(null);
const inboxNextCursor = ref<string | null>(null);
const planPendingId = ref("");
const inboxPendingId = ref("");
const error = ref("");
const auditRequests = createLatestRequestGuard<string>();
const planRequests = createLatestRequestGuard<string>();
const inboxRequests = createLatestRequestGuard<string>();
const planActionRequests = createLatestRequestGuard<string>();
const inboxActionRequests = createLatestRequestGuard<string>();
const actionRequests = createLatestRequestGuard<string>();
const submitRequests = createLatestRequestGuard<string>();
const drafts = createScopedDraftStore(() => ({
  target: "",
  actionKind: "read_post" as ActionKind,
  content: "",
}));

function messageOf(value: unknown): string {
  return uiText(value instanceof Error ? value.message : String(value));
}
function formatDate(value: string | number): string {
  return new Intl.DateTimeFormat(uiText("zh-CN"), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
function actionLabel(action: ActionKind): string {
  const label = actionOptions.find((option) => option.value === action)?.label;
  return label ? uiText(label) : action;
}
function statusLabel(status: Action["status"]): string {
  return uiText({
    queued: "待执行",
    succeeded: "已完成",
    denied: "已拒绝",
    cancelled: "已取消",
  }[status]);
}

async function loadAudit(): Promise<void> {
  const agentId = props.agentId;
  const request = auditRequests.begin(agentId);
  auditLoading.value = true;
  error.value = "";
  try {
    const result = await desktopApi.listAudit(agentId);
    if (auditRequests.isCurrent(request, props.agentId)) audit.value = result.audit;
  } catch (reason) {
    if (auditRequests.isCurrent(request, props.agentId)) error.value = messageOf(reason);
  } finally {
    if (auditRequests.isCurrent(request, props.agentId)) auditLoading.value = false;
  }
}
async function loadPlans(append = false): Promise<void> {
  if (append && planLoading.value) return;
  const agentId = props.agentId;
  const cursor = append ? plansNextCursor.value : null;
  if (append && cursor === null) return;
  const request = planRequests.begin(agentId);
  planLoading.value = true;
  error.value = "";
  try {
    const result = await desktopApi.listProactivePlans(agentId, cursor ?? undefined, 20);
    if (!planRequests.isCurrent(request, props.agentId)) return;
    plans.value = append ? appendUniqueById(plans.value, result.entries) : result.entries;
    plansNextCursor.value = result.nextCursor;
  } catch (reason) {
    if (planRequests.isCurrent(request, props.agentId)) error.value = messageOf(reason);
  } finally {
    if (planRequests.isCurrent(request, props.agentId)) planLoading.value = false;
  }
}
async function loadInbox(append = false): Promise<void> {
  if (append && inboxLoading.value) return;
  const agentId = props.agentId;
  const cursor = append ? inboxNextCursor.value : null;
  if (append && cursor === null) return;
  const request = inboxRequests.begin(agentId);
  inboxLoading.value = true;
  error.value = "";
  try {
    const result = await desktopApi.listProactiveInbox(agentId, cursor ?? undefined, 50);
    if (!inboxRequests.isCurrent(request, props.agentId)) return;
    inbox.value = append ? appendUniqueById(inbox.value, result.entries) : result.entries;
    inboxNextCursor.value = result.nextCursor;
  } catch (reason) {
    if (inboxRequests.isCurrent(request, props.agentId)) error.value = messageOf(reason);
  } finally {
    if (inboxRequests.isCurrent(request, props.agentId)) inboxLoading.value = false;
  }
}
async function loadProactive(): Promise<void> {
  await Promise.all([loadPlans(), loadInbox()]);
}
async function submitProposal(): Promise<void> {
  if (!target.value.trim() || !content.value.trim()) return;
  const agentId = props.agentId;
  const request = submitRequests.begin(agentId);
  const submittedDraft = { target: target.value, actionKind: actionKind.value, content: content.value };
  drafts.write(agentId, submittedDraft);
  const submittedTarget = target.value.trim();
  const submittedAction = actionKind.value;
  const submittedContent = content.value.trim();
  submitting.value = true;
  error.value = "";
  try {
    await desktopApi.submitSimulation(agentId, crypto.randomUUID(), submittedTarget, submittedAction, submittedContent);
    const cleared = drafts.clearIf(agentId, (draft) => draft.target === submittedDraft.target && draft.actionKind === submittedDraft.actionKind && draft.content === submittedDraft.content);
    if (cleared) drafts.write(agentId, { ...submittedDraft, content: "" });
    if (!submitRequests.isCurrent(request, props.agentId)) return;
    if (cleared) content.value = "";
    emit("snapshot-changed");
    await loadAudit();
  } catch (reason) {
    if (submitRequests.isCurrent(request, props.agentId)) error.value = messageOf(reason);
  } finally {
    if (submitRequests.isCurrent(request, props.agentId)) submitting.value = false;
  }
}
async function executeAction(action: Action): Promise<void> {
  const agentId = props.agentId;
  const request = actionRequests.begin(agentId);
  error.value = "";
  try {
    await desktopApi.executeSimulation(agentId, action.id);
    if (!actionRequests.isCurrent(request, props.agentId)) return;
    emit("snapshot-changed");
    await loadAudit();
  } catch (reason) {
    if (actionRequests.isCurrent(request, props.agentId)) error.value = messageOf(reason);
  }
}
async function cancelAction(action: Action): Promise<void> {
  const agentId = props.agentId;
  const request = actionRequests.begin(agentId);
  error.value = "";
  try {
    await desktopApi.cancelSimulation(agentId, action.id);
    if (!actionRequests.isCurrent(request, props.agentId)) return;
    emit("snapshot-changed");
    await loadAudit();
  } catch (reason) {
    if (actionRequests.isCurrent(request, props.agentId)) error.value = messageOf(reason);
  }
}
async function cancelProactivePlan(plan: ProactivePlan): Promise<void> {
  if (!canCancelProactivePlanStatus(plan.status)) return;
  const agentId = props.agentId;
  const request = planActionRequests.begin(agentId);
  planPendingId.value = plan.id;
  error.value = "";
  try {
    await desktopApi.cancelProactivePlan(agentId, plan.id);
    if (!planActionRequests.isCurrent(request, props.agentId)) return;
    await loadPlans();
    emit("snapshot-changed");
  } catch (reason) {
    if (planActionRequests.isCurrent(request, props.agentId)) error.value = messageOf(reason);
  } finally {
    if (planActionRequests.isCurrent(request, props.agentId)) planPendingId.value = "";
  }
}
async function readProactiveInbox(entry: ProactiveInboxEntry): Promise<void> {
  if (!canReadProactiveInbox(entry)) return;
  const agentId = props.agentId;
  const request = inboxActionRequests.begin(agentId);
  inboxPendingId.value = entry.id;
  error.value = "";
  try {
    await desktopApi.readProactiveInbox(agentId, [entry.id]);
    if (!inboxActionRequests.isCurrent(request, props.agentId)) return;
    await loadInbox();
    emit("snapshot-changed");
  } catch (reason) {
    if (inboxActionRequests.isCurrent(request, props.agentId)) error.value = messageOf(reason);
  } finally {
    if (inboxActionRequests.isCurrent(request, props.agentId)) inboxPendingId.value = "";
  }
}

watch(() => props.agentId, (agentId, previousAgentId) => {
  if (previousAgentId) drafts.write(previousAgentId, { target: target.value, actionKind: actionKind.value, content: content.value });
  auditRequests.invalidate();
  planRequests.invalidate();
  inboxRequests.invalidate();
  planActionRequests.invalidate();
  inboxActionRequests.invalidate();
  actionRequests.invalidate();
  submitRequests.invalidate();
  audit.value = [];
  plans.value = [];
  inbox.value = [];
  auditLoading.value = false;
  planLoading.value = false;
  inboxLoading.value = false;
  plansNextCursor.value = null;
  inboxNextCursor.value = null;
  planPendingId.value = "";
  inboxPendingId.value = "";
  submitting.value = false;
  error.value = "";
  const draft = drafts.read(agentId);
  target.value = draft.target;
  actionKind.value = draft.actionKind;
  content.value = draft.content;
  void Promise.all([loadAudit(), loadProactive()]);
}, { immediate: true, flush: "sync" });
watch([target, actionKind, content], () => { drafts.write(props.agentId, { target: target.value, actionKind: actionKind.value, content: content.value }); }, { flush: "sync" });
onUnmounted(() => {
  auditRequests.invalidate();
  planRequests.invalidate();
  inboxRequests.invalidate();
  planActionRequests.invalidate();
  inboxActionRequests.invalidate();
  actionRequests.invalidate();
  submitRequests.invalidate();
});
</script>

<template>
  <section class="page">
    <header class="page-heading"><div><h1>{{ uiText("活动") }}</h1><p>{{ uiText("主动联系、合成账号提案与审计") }}</p></div><span class="simulation-label">{{ uiText("应用内") }}</span></header>
    <p class="form-hint">{{ uiText("主动计划和主动消息只投递到此应用，不会发送到 QQ 或 BiliBili。下方动作提案仅在合成 sandbox 中执行。") }}</p>
    <p v-if="error" class="inline-error" role="alert">{{ uiText(error) }}</p>

    <section class="activity-section" aria-labelledby="proactive-plan-heading">
      <div class="section-heading-row"><h2 id="proactive-plan-heading">{{ uiText("主动计划") }}</h2><button type="button" class="button quiet" :disabled="planLoading" @click="loadPlans()">{{ uiText("刷新") }}</button></div>
      <p v-if="planLoading && plans.length === 0" class="empty-state">{{ uiText("正在读取主动计划…") }}</p>
      <p v-else-if="plans.length === 0" class="empty-state">{{ uiText("暂无主动计划。") }}</p>
      <div v-else class="record-list">
        <article v-for="plan in plans" :key="plan.id" class="record-row proactive-plan-row">
          <header><div><h2>{{ plan.topic }}</h2><span>{{ uiText(proactivePlanStatusLabel(plan.status)) }}</span></div><button v-if="canCancelProactivePlanStatus(plan.status)" type="button" class="button quiet danger-text" :disabled="planPendingId === plan.id" @click="cancelProactivePlan(plan)">{{ uiText(planPendingId === plan.id ? "取消中…" : "取消计划") }}</button></header>
          <p>{{ plan.purpose }}</p><small>{{ uiText("预计 {0} · 到期 {1}", formatDate(plan.dueAt), formatDate(plan.expiresAt)) }}<template v-if="plan.deferCount">{{ uiText(" · 已延期 {0} 次", plan.deferCount) }}</template></small>
        </article>
      </div>
      <button v-if="plansNextCursor !== null" type="button" class="button quiet" :disabled="planLoading" @click="loadPlans(true)">{{ uiText(planLoading ? "加载中…" : "加载更多计划") }}</button>
    </section>

    <section class="activity-section" aria-labelledby="proactive-inbox-heading">
      <div class="section-heading-row"><h2 id="proactive-inbox-heading">{{ uiText("主动消息") }}</h2><button type="button" class="button quiet" :disabled="inboxLoading" @click="loadInbox()">{{ uiText("刷新") }}</button></div>
      <p v-if="inboxLoading && inbox.length === 0" class="empty-state">{{ uiText("正在读取主动消息…") }}</p>
      <p v-else-if="inbox.length === 0" class="empty-state">{{ uiText("暂无主动消息。") }}</p>
      <div v-else class="record-list">
        <article v-for="entry in inbox" :key="entry.id" class="record-row proactive-inbox-row" :class="{ unread: canReadProactiveInbox(entry) }">
          <header><span>{{ uiText(proactiveInboxStatusLabel(entry)) }} · {{ formatDate(entry.createdAt) }}</span><button v-if="canReadProactiveInbox(entry)" type="button" class="button quiet" :disabled="inboxPendingId === entry.id" @click="readProactiveInbox(entry)">{{ uiText(inboxPendingId === entry.id ? "处理中…" : "标为已读") }}</button></header>
          <p>{{ entry.text }}</p>
        </article>
      </div>
      <button v-if="inboxNextCursor !== null" type="button" class="button quiet" :disabled="inboxLoading" @click="loadInbox(true)">{{ uiText(inboxLoading ? "加载中…" : "加载更多消息") }}</button>
    </section>

    <form class="form-panel activity-form" @submit.prevent="submitProposal">
      <label><span>{{ uiText("目标") }}</span><input v-model="target" maxlength="200" required :placeholder="uiText('合成目标标识')" /></label>
      <label><span>{{ uiText("动作") }}</span><select v-model="actionKind"><option v-for="option in actionOptions" :key="option.value" :value="option.value">{{ uiText(option.label) }}</option></select></label>
      <label class="activity-content"><span>{{ uiText("提案内容") }}</span><textarea v-model="content" rows="2" maxlength="2000" required /></label>
      <button type="submit" class="button primary" :disabled="submitting">{{ uiText(submitting ? "提交中…" : "提交模拟提案") }}</button>
    </form>

    <section class="activity-section" aria-labelledby="proposal-heading">
      <h2 id="proposal-heading">{{ uiText("动作提案") }}</h2>
      <div class="table-wrap"><table><thead><tr><th>{{ uiText("状态") }}</th><th>{{ uiText("目标 / 动作") }}</th><th>{{ uiText("内容 / 结果") }}</th><th>{{ uiText("时间") }}</th><th><span class="sr-only">{{ uiText("操作") }}</span></th></tr></thead><tbody>
        <tr v-if="actions.length === 0"><td colspan="5" class="empty-cell">{{ uiText("暂无模拟提案。") }}</td></tr>
        <tr v-for="action in actions" :key="action.id"><td><span class="state-pill" :class="action.status">{{ statusLabel(action.status) }}</span></td><td><strong>{{ action.target }}</strong><span>{{ actionLabel(action.action) }}</span></td><td class="content-cell"><span>{{ action.content }}</span><small v-if="action.reason || action.result">{{ action.reason || action.result }}</small></td><td>{{ formatDate(action.updatedAt) }}</td><td><div v-if="action.status === 'queued'" class="button-row table-actions"><button type="button" class="button quiet" @click="executeAction(action)">{{ uiText("执行") }}</button><button type="button" class="button quiet danger-text" @click="cancelAction(action)">{{ uiText("取消") }}</button></div></td></tr>
      </tbody></table></div>
    </section>

    <section class="activity-section" aria-labelledby="audit-heading">
      <div class="section-heading-row"><h2 id="audit-heading">{{ uiText("审计记录") }}</h2><button type="button" class="button quiet" :disabled="auditLoading" @click="loadAudit">{{ uiText("刷新") }}</button></div>
      <p v-if="auditLoading" class="empty-state">{{ uiText("正在读取审计记录…") }}</p><p v-else-if="audit.length === 0" class="empty-state">{{ uiText("暂无审计记录。") }}</p>
      <ol v-else class="audit-list"><li v-for="item in audit" :key="item.id"><time :datetime="item.createdAt">{{ formatDate(item.createdAt) }}</time><strong>{{ item.event }}</strong><span>{{ item.details }}</span></li></ol>
    </section>
  </section>
</template>
