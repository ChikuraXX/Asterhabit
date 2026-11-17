<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";

import { desktopApi, type CharacterState, type Contact, type GrowthSource, type ReflectionStatus } from "../api";
import { createLatestRequestGuard } from "../requestGuard";
import { uiText } from "../i18n";
import { contactDisplayLabel } from "../contactDisplayLabel";
import { isGrowthSourceRequeueable } from "../uiState";

const props = defineProps<{ agentId: string; contact: Contact | null }>();
const sources = ref<GrowthSource[]>([]);
const states = ref<CharacterState[]>([]);
const sourceRevision = ref(0);
// 撤下操作使用角色列表所属范围的CAS版本，不是单条状态自身的revision。
const stateScopeRevision = ref(0);
const status = ref<ReflectionStatus | null>(null);
const sourceCursor = ref<string | null>(null);
const stateCursor = ref<string | null>(null);
const loading = ref(false);
const loadingSources = ref(false);
const loadingStates = ref(false);
const mutatingKey = ref<string | null>(null);
const error = ref("");
const scopeRequests = createLatestRequestGuard<string>();
const sourcePageRequests = createLatestRequestGuard<string>();
const statePageRequests = createLatestRequestGuard<string>();
const mutationRequests = createLatestRequestGuard<string>();

function currentScopeKey(): string {
  return `${props.agentId}\u0000${props.contact?.id ?? ""}`;
}
function messageOf(value: unknown): string { return uiText(value instanceof Error ? value.message : String(value)); }
function formatTime(timestamp: number | null): string {
  if (timestamp === null) return uiText("尚未运行");
  return new Intl.DateTimeFormat(uiText("zh-CN"), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}
function statusLabel(value: string): string {
  const label = ({ queued: "等待反思", claimed: "处理中", consumed: "已处理", cancelled: "已取消", invalidated: "已失效", tentative: "形成中", established: "较稳定", retired: "已撤下", open: "待探索", resolved: "已解决", dismissed: "已撤下" } as Record<string, string>)[value];
  return label ? uiText(label) : value;
}
function uniqueEntries<Entry extends { id: string }>(entries: Entry[]): Entry[] {
  const known = new Set<string>();
  return entries.filter((entry) => {
    if (known.has(entry.id)) return false;
    known.add(entry.id);
    return true;
  });
}
function appendUnique<Entry extends { id: string }>(current: Entry[], next: Entry[]): Entry[] {
  return uniqueEntries([...current, ...next]);
}
async function loadGrowth(): Promise<void> {
  const contactId = props.contact?.id;
  const agentId = props.agentId;
  const scope = currentScopeKey();
  const request = scopeRequests.begin(scope);
  sourcePageRequests.invalidate();
  statePageRequests.invalidate();
  loadingSources.value = false;
  loadingStates.value = false;
  if (!contactId) { loading.value = false; return; }
  loading.value = true;
  error.value = "";
  try {
    const [sourceResult, stateResult, reflection] = await Promise.all([
      desktopApi.listGrowthSources(agentId, contactId),
      desktopApi.listCharacterStates(agentId, contactId),
      desktopApi.reflectionStatus(agentId),
    ]);
    if (!scopeRequests.isCurrent(request, currentScopeKey())) return;
    sources.value = uniqueEntries(sourceResult.entries);
    sourceRevision.value = sourceResult.scopeRevision;
    sourceCursor.value = sourceResult.nextCursor;
    states.value = uniqueEntries(stateResult.entries);
    stateScopeRevision.value = stateResult.scopeRevision;
    stateCursor.value = stateResult.nextCursor;
    status.value = reflection;
  } catch (reason) {
    if (scopeRequests.isCurrent(request, currentScopeKey())) error.value = messageOf(reason);
  } finally {
    if (scopeRequests.isCurrent(request, currentScopeKey())) loading.value = false;
  }
}
async function loadMoreSources(): Promise<void> {
  const cursor = sourceCursor.value;
  const contactId = props.contact?.id;
  if (!cursor || !contactId) return;
  const agentId = props.agentId;
  const scope = currentScopeKey();
  const request = sourcePageRequests.begin(scope);
  loadingSources.value = true;
  try {
    const result = await desktopApi.listGrowthSources(agentId, contactId, cursor);
    if (!sourcePageRequests.isCurrent(request, currentScopeKey())) return;
    sources.value = appendUnique(sources.value, result.entries);
    sourceRevision.value = result.scopeRevision;
    sourceCursor.value = result.nextCursor;
  } catch (reason) {
    if (sourcePageRequests.isCurrent(request, currentScopeKey())) error.value = messageOf(reason);
  } finally {
    if (sourcePageRequests.isCurrent(request, currentScopeKey())) loadingSources.value = false;
  }
}
async function loadMoreStates(): Promise<void> {
  const cursor = stateCursor.value;
  const contactId = props.contact?.id;
  if (!cursor || !contactId) return;
  const agentId = props.agentId;
  const scope = currentScopeKey();
  const request = statePageRequests.begin(scope);
  loadingStates.value = true;
  try {
    const result = await desktopApi.listCharacterStates(agentId, contactId, undefined, cursor);
    if (!statePageRequests.isCurrent(request, currentScopeKey())) return;
    states.value = appendUnique(states.value, result.entries);
    stateScopeRevision.value = result.scopeRevision;
    stateCursor.value = result.nextCursor;
  } catch (reason) {
    if (statePageRequests.isCurrent(request, currentScopeKey())) error.value = messageOf(reason);
  } finally {
    if (statePageRequests.isCurrent(request, currentScopeKey())) loadingStates.value = false;
  }
}
async function forgetSource(source: GrowthSource): Promise<void> {
  if (!props.contact || mutatingKey.value || !window.confirm(uiText("遗忘这条成长来源吗？依赖它的角色状态也会失效。"))) return;
  const agentId = props.agentId;
  const contactId = props.contact.id;
  const request = mutationRequests.begin(currentScopeKey());
  mutatingKey.value = `source:${source.id}`;
  try {
    await desktopApi.forgetGrowthSource({ agentId, contactId, id: source.id, expectedRevision: sourceRevision.value });
    if (mutationRequests.isCurrent(request, currentScopeKey())) await loadGrowth();
  } catch (reason) {
    if (mutationRequests.isCurrent(request, currentScopeKey())) error.value = messageOf(reason);
  } finally {
    if (mutationRequests.isCurrent(request, currentScopeKey())) mutatingKey.value = null;
  }
}
async function requeueSource(source: GrowthSource): Promise<void> {
  if (!props.contact || mutatingKey.value || !isGrowthSourceRequeueable(source)) return;
  const agentId = props.agentId;
  const contactId = props.contact.id;
  const request = mutationRequests.begin(currentScopeKey());
  mutatingKey.value = `source:${source.id}`;
  try {
    await desktopApi.requeueGrowthSources({ agentId, contactId, sourceIds: [source.id], learn: true, expectedRevision: sourceRevision.value });
    if (mutationRequests.isCurrent(request, currentScopeKey())) await loadGrowth();
  } catch (reason) {
    if (mutationRequests.isCurrent(request, currentScopeKey())) error.value = messageOf(reason);
  } finally {
    if (mutationRequests.isCurrent(request, currentScopeKey())) mutatingKey.value = null;
  }
}
async function dismissState(state: CharacterState): Promise<void> {
  if (!props.contact || mutatingKey.value) return;
  const agentId = props.agentId;
  const contactId = props.contact.id;
  const request = mutationRequests.begin(currentScopeKey());
  mutatingKey.value = `state:${state.id}`;
  try {
    await desktopApi.dismissCharacterState({ agentId, contactId, id: state.id, expectedRevision: stateScopeRevision.value });
    if (mutationRequests.isCurrent(request, currentScopeKey())) await loadGrowth();
  } catch (reason) {
    if (mutationRequests.isCurrent(request, currentScopeKey())) error.value = messageOf(reason);
  } finally {
    if (mutationRequests.isCurrent(request, currentScopeKey())) mutatingKey.value = null;
  }
}
watch([() => props.agentId, () => props.contact?.id], () => {
  scopeRequests.invalidate();
  sourcePageRequests.invalidate();
  statePageRequests.invalidate();
  mutationRequests.invalidate();
  sources.value = [];
  states.value = [];
  status.value = null;
  sourceCursor.value = null;
  stateCursor.value = null;
  sourceRevision.value = 0;
  stateScopeRevision.value = 0;
  error.value = "";
  loading.value = false;
  loadingSources.value = false;
  loadingStates.value = false;
  mutatingKey.value = null;
  void loadGrowth();
}, { immediate: true, flush: "sync" });
onUnmounted(() => {
  scopeRequests.invalidate();
  sourcePageRequests.invalidate();
  statePageRequests.invalidate();
  mutationRequests.invalidate();
});
</script>

<template>
  <section class="page growth-page">
    <header class="page-heading"><div><h1>{{ uiText("成长") }}</h1><p>{{ uiText("{0}范围内的来源与角色状态", contactDisplayLabel(contact)) }}</p></div><button type="button" class="button" :disabled="loading || !contact" @click="loadGrowth">{{ uiText(loading ? "加载中…" : "刷新") }}</button></header>
    <p class="form-hint">{{ uiText("这里只显示明确授权的成长来源和由其形成的角色状态；24 小时调用按反思运行计数，不等于 provider 请求次数。") }}</p>
    <p v-if="error" class="inline-error" role="alert">{{ uiText(error) }}</p>
    <p v-if="loading && !states.length && !sources.length" class="status-line">{{ uiText("正在读取成长记录…") }}</p>
    <div v-if="status" class="metric-strip">
      <span><strong>{{ status.usedCalls24h }} / {{ status.dailyCallLimit }}</strong>{{ uiText("24 小时调用") }}</span>
      <span><strong>{{ status.pendingEvents }}</strong>{{ uiText("等待事件") }}</span>
      <span><strong>{{ status.activeRuns }}</strong>{{ uiText("进行中") }}</span>
      <span><strong>{{ formatTime(status.nextEligibleAt) }}</strong>{{ uiText("下次可运行") }}</span>
    </div>
    <section class="list-section">
      <div class="section-heading-row"><h2>{{ uiText("角色状态") }}</h2><span>{{ uiText("{0} 条", states.length) }}</span></div>
      <p v-if="!loading && states.length === 0" class="empty-state">{{ uiText("还没有形成角色状态。") }}</p>
      <div class="record-list">
        <article v-for="state in states" :key="state.id" class="record-card">
          <div class="record-card-heading"><div><span class="state-pill enabled">{{ statusLabel(state.status) }}</span><strong>{{ state.topic }}</strong></div><button v-if="!['retired', 'dismissed'].includes(state.status)" type="button" class="button quiet danger-text" :disabled="Boolean(mutatingKey)" @click="dismissState(state)">{{ uiText("撤下") }}</button></div>
          <p>{{ state.statement }}</p><small>{{ state.briefReason }}</small>
        </article>
      </div>
      <button v-if="stateCursor" type="button" class="button load-more" :disabled="loadingStates" @click="loadMoreStates">{{ uiText(loadingStates ? "加载中…" : "加载更多角色状态") }}</button>
    </section>
    <section class="list-section">
      <div class="section-heading-row"><h2>{{ uiText("成长来源") }}</h2><span>{{ uiText("{0} 条", sources.length) }}</span></div>
      <p v-if="!loading && sources.length === 0" class="empty-state">{{ uiText("没有已授权的成长来源。") }}</p>
      <div class="record-list">
        <article v-for="source in sources" :key="source.id" class="record-card">
          <div class="record-card-heading"><div><span class="state-pill">{{ statusLabel(source.status) }}</span><time>{{ formatTime(source.createdAt) }}</time></div></div>
          <p>{{ source.excerpt }}</p>
          <div class="button-row record-actions"><button v-if="source.requeueable" type="button" class="button quiet" :disabled="Boolean(mutatingKey)" @click="requeueSource(source)">{{ uiText("重新排队") }}</button><button type="button" class="button quiet danger-text" :disabled="Boolean(mutatingKey)" @click="forgetSource(source)">{{ uiText("遗忘") }}</button></div>
        </article>
      </div>
      <button v-if="sourceCursor" type="button" class="button load-more" :disabled="loadingSources" @click="loadMoreSources">{{ uiText(loadingSources ? "加载中…" : "加载更多成长来源") }}</button>
    </section>
  </section>
</template>

<style scoped>
.growth-page .record-list { display: grid; gap: 10px; }
.growth-page .record-card { min-width: 0; }
.growth-page .record-card-heading > div { min-width: 0; flex-wrap: wrap; }
.growth-page .record-card-heading strong,
.growth-page .record-card p,
.growth-page .record-card small { overflow-wrap: anywhere; }
.growth-page .record-actions { justify-content: flex-end; flex-wrap: wrap; }
@media (max-width: 520px) {
  .growth-page .record-card-heading { align-items: flex-start; }
  .growth-page .record-card-heading > div { align-items: flex-start; flex-direction: column; }
}
</style>
