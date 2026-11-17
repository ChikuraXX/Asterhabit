<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";

import { desktopApi, type ContentFeedbackScope, type ContentFeedbackValue, type ContentObservation, type ContentObservationDetail } from "../api";
import { uiLocale } from "../i18n";
import { appendUniqueObservations, feedbackLabel, observationText } from "../observationsMessages";
import { createLatestRequestGuard } from "../requestGuard";

const props = defineProps<{ agentId: string }>();
const entries = ref<ContentObservation[]>([]);
const nextCursor = ref<string | null>(null);
const selected = ref<ContentObservationDetail | null>(null);
const loading = ref(false);
const detailLoading = ref(false);
const actionLoading = ref(false);
const browseLoading = ref(false);
const error = ref("");
const actionStatus = ref("");
const confirmingForget = ref(false);
const detailUnavailable = ref(false);
const listRequests = createLatestRequestGuard<string>();
const detailRequests = createLatestRequestGuard<string>();
const actionRequests = createLatestRequestGuard<string>();

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
function invalidateRequests(): void {
  listRequests.invalidate(); detailRequests.invalidate(); actionRequests.invalidate();
}
function formatDate(value: number): string {
  return new Intl.DateTimeFormat(uiLocale.value, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
function statusLabel(value: ContentObservation["status"]): string {
  return observationText(value === "active" ? "有效" : value === "expired" ? "已过期" : "已遗忘");
}
function materialLabel(value: ContentObservationDetail["materials"][number]["kind"]): string {
  return observationText(value === "description" ? "简介" : value === "subtitle" ? "字幕片段" : "评论样本");
}

async function load(append = false, preserveSelected = false): Promise<void> {
  if (loading.value || (append && nextCursor.value === null)) return;
  if (!append && !preserveSelected) { selected.value = null; confirmingForget.value = false; detailUnavailable.value = false; }
  const agentId = props.agentId; const cursor = append ? nextCursor.value ?? undefined : undefined; const request = listRequests.begin(agentId);
  loading.value = true; error.value = "";
  try {
    const result = await desktopApi.listObservations(agentId, { cursor, limit: 20 });
    if (!listRequests.isCurrent(request, props.agentId)) return;
    if (!Array.isArray(result.entries) || !(result.nextCursor === null || typeof result.nextCursor === "string")) throw new Error(observationText("观察列表响应无效"));
    entries.value = append ? appendUniqueObservations(entries.value, result.entries) : result.entries;
    nextCursor.value = result.nextCursor;
  } catch (reason) {
    if (listRequests.isCurrent(request, props.agentId)) error.value = messageOf(reason);
  } finally {
    if (listRequests.isCurrent(request, props.agentId)) loading.value = false;
  }
}
async function openDetail(entry: ContentObservation): Promise<void> {
  const agentId = props.agentId; const request = detailRequests.begin(`${agentId}:${entry.id}`);
  detailLoading.value = true; error.value = ""; actionStatus.value = ""; confirmingForget.value = false; detailUnavailable.value = false;
  try {
    const result = await desktopApi.getObservation(agentId, entry.id);
    if (detailRequests.isCurrent(request, `${props.agentId}:${entry.id}`)) { selected.value = result.observation; detailUnavailable.value = result.observation === null; }
  } catch (reason) {
    if (detailRequests.isCurrent(request, `${props.agentId}:${entry.id}`)) error.value = messageOf(reason);
  } finally {
    if (detailRequests.isCurrent(request, `${props.agentId}:${entry.id}`)) detailLoading.value = false;
  }
}
async function observeOnce(): Promise<void> {
  if (browseLoading.value || actionLoading.value) return; const agentId = props.agentId; const request = actionRequests.begin(agentId);
  browseLoading.value = true; error.value = ""; actionStatus.value = "";
  try {
    const result = await desktopApi.browseContent(agentId);
    if (!actionRequests.isCurrent(request, props.agentId)) return;
    const status = result.outcome === "observed" ? "观察已保存"
      : result.outcome === "no_material" ? "没有可读取的材料"
      : result.outcome === "not_due" ? "当前读取条件、间隔或额度不满足"
      : result.reason === "already_seen" ? "候选内容均已处理"
      : result.reason === "empty" ? "没有找到候选内容"
      : result.reason === "feedback_filtered" ? "候选内容已被反馈规则排除"
      : "本轮没有保存观察";
    actionStatus.value = observationText(status);
    await load(false);
  } catch (reason) {
    if (actionRequests.isCurrent(request, props.agentId)) error.value = messageOf(reason);
  } finally {
    if (actionRequests.isCurrent(request, props.agentId)) browseLoading.value = false;
  }
}
async function setFeedback(scope: ContentFeedbackScope, value: ContentFeedbackValue): Promise<void> {
  const detail = selected.value; if (!detail || actionLoading.value) return; const agentId = props.agentId; const request = actionRequests.begin(`${agentId}:${detail.id}`);
  actionLoading.value = true; error.value = ""; actionStatus.value = "";
  try {
    const result = await desktopApi.feedbackObservation({ agentId, id: detail.id, expectedRevision: detail.revision, expectedFeedbackRevision: detail.feedbackRevision, scope, value });
    if (!actionRequests.isCurrent(request, `${props.agentId}:${detail.id}`)) return;
    selected.value = result.observation; await load(false, true);
  } catch (reason) {
    if (actionRequests.isCurrent(request, `${props.agentId}:${detail.id}`)) error.value = messageOf(reason);
  } finally {
    if (actionRequests.isCurrent(request, `${props.agentId}:${detail.id}`)) actionLoading.value = false;
  }
}
async function forgetSelected(): Promise<void> {
  const detail = selected.value; if (!detail || actionLoading.value) return; const agentId = props.agentId; const request = actionRequests.begin(`${agentId}:${detail.id}`);
  actionLoading.value = true; error.value = "";
  try {
    await desktopApi.forgetObservation(agentId, detail.id, detail.revision);
    if (!actionRequests.isCurrent(request, `${props.agentId}:${detail.id}`)) return;
    selected.value = null; confirmingForget.value = false; await load(false);
  } catch (reason) {
    if (actionRequests.isCurrent(request, `${props.agentId}:${detail.id}`)) error.value = messageOf(reason);
  } finally {
    if (actionRequests.isCurrent(request, `${props.agentId}:${detail.id}`)) actionLoading.value = false;
  }
}

watch(() => props.agentId, () => {
  invalidateRequests(); entries.value = []; nextCursor.value = null; selected.value = null; loading.value = false; detailLoading.value = false; actionLoading.value = false; browseLoading.value = false; error.value = ""; actionStatus.value = ""; confirmingForget.value = false; detailUnavailable.value = false; void load(false);
}, { immediate: true, flush: "sync" });
onUnmounted(invalidateRequests);
</script>

<template>
  <section class="settings-section observations-section">
    <header class="observations-header">
      <h2>{{ observationText("观察记录") }}</h2>
      <div class="button-row observations-actions">
        <button type="button" class="button" :disabled="browseLoading || actionLoading" @click="observeOnce">{{ observationText(browseLoading ? "观察中…" : "观察一次") }}</button>
        <button type="button" class="button quiet" :disabled="loading" @click="load(false)">{{ observationText(loading ? "刷新中…" : "刷新") }}</button>
      </div>
    </header>
    <p v-if="error" class="inline-error" role="alert">{{ observationText("读取失败") }}：{{ error }}</p>
    <p v-if="actionStatus" class="status-line" role="status">{{ actionStatus }}</p>
    <p v-if="detailUnavailable" class="status-line" role="status">{{ observationText("观察已不可用") }}</p>
    <p v-if="loading && entries.length === 0" class="status-line">{{ observationText("加载中…") }}</p>
    <p v-else-if="!error && entries.length === 0" class="empty-state">{{ observationText("暂无观察记录") }}</p>
    <div v-else class="observations-layout">
      <div class="observation-list">
        <article v-for="entry in entries" :key="entry.id" class="observation-row">
          <div><h3>{{ entry.title || entry.bvid }}</h3><p class="form-hint">{{ statusLabel(entry.status) }} · {{ formatDate(entry.createdAt) }}</p><p>{{ entry.summary }}</p></div>
          <button type="button" class="button quiet" :disabled="detailLoading" @click="openDetail(entry)">{{ observationText("查看详情") }}</button>
        </article>
        <button v-if="nextCursor" type="button" class="button quiet load-more" :disabled="loading" @click="load(true)">{{ observationText(loading ? "加载中…" : "加载更多") }}</button>
      </div>
      <article v-if="selected" class="observation-detail">
        <h3>{{ selected.title || selected.bvid }}</h3>
        <dl>
          <dt>{{ observationText("来源") }}</dt><dd>BiliBili · {{ selected.bvid }}<template v-if="selected.creatorId"> · UID {{ selected.creatorId }}</template><br><code>{{ selected.url }}</code></dd>
          <dt>{{ observationText("实际覆盖") }}</dt><dd>{{ observationText("简介 {0} · 字幕 {1} · 评论 {2}", selected.coverage.description, selected.coverage.subtitle, selected.coverage.comment) }}</dd>
          <dt>{{ observationText("处理状态") }}</dt><dd>{{ statusLabel(selected.status) }}</dd>
        </dl>
        <h4>{{ observationText("材料事实") }}</h4>
        <div class="observation-materials">
          <article v-for="material in selected.materials" :key="material.id"><strong>{{ materialLabel(material.kind) }}</strong><span v-if="material.startSeconds !== undefined"> · {{ observationText("{0}–{1} 秒", material.startSeconds, material.endSeconds) }}</span><p>{{ material.text }}</p></article>
        </div>
        <h4>{{ observationText("观察摘要") }}</h4><p>{{ selected.summary }}</p>
        <h4>{{ observationText("Agent 看法") }}</h4><p>{{ selected.viewpoint }}</p>
        <div class="feedback-group"><strong>{{ observationText("当前内容") }}</strong><span v-if="selected.feedback.content">{{ feedbackLabel(selected.feedback.content) }}</span><div class="button-row"><button type="button" class="button quiet" :disabled="actionLoading" @click="setFeedback('content','like')">{{ observationText("喜欢 · 当前内容") }}</button><button type="button" class="button quiet" :disabled="actionLoading" @click="setFeedback('content','less')">{{ observationText("少推荐 · 当前内容") }}</button><button type="button" class="button quiet" :disabled="actionLoading" @click="setFeedback('content','block')">{{ observationText("不再推荐 · 当前内容") }}</button><button v-if="selected.feedback.content" type="button" class="button quiet" :disabled="actionLoading" @click="setFeedback('content',null)">{{ observationText("撤销当前内容反馈") }}</button></div></div>
        <div class="feedback-group"><strong>{{ observationText("当前作者") }}<template v-if="selected.creatorId"> · UID {{ selected.creatorId }}</template></strong><span v-if="!selected.creatorId" class="form-hint">{{ observationText("作者信息不可用") }}</span><span v-else-if="selected.feedback.creator">{{ feedbackLabel(selected.feedback.creator) }}</span><div class="button-row"><button type="button" class="button quiet" :disabled="actionLoading || !selected.creatorId" @click="setFeedback('creator','like')">{{ observationText("喜欢 · 当前作者") }}</button><button type="button" class="button quiet" :disabled="actionLoading || !selected.creatorId" @click="setFeedback('creator','less')">{{ observationText("少推荐 · 当前作者") }}</button><button type="button" class="button quiet" :disabled="actionLoading || !selected.creatorId" @click="setFeedback('creator','block')">{{ observationText("不再推荐 · 当前作者") }}</button><button v-if="selected.feedback.creator" type="button" class="button quiet" :disabled="actionLoading || !selected.creatorId" @click="setFeedback('creator',null)">{{ observationText("撤销当前作者反馈") }}</button></div></div>
        <div v-if="confirmingForget" class="forget-confirmation"><p>{{ observationText("遗忘会清除本地材料及其派生内容。") }}</p><div class="button-row"><button type="button" class="button danger danger-text primary" :disabled="actionLoading" @click="forgetSelected">{{ observationText("确认遗忘") }}</button><button type="button" class="button quiet" :disabled="actionLoading" @click="confirmingForget=false">{{ observationText("取消") }}</button></div></div>
        <button v-else type="button" class="button quiet danger-text" :disabled="actionLoading" @click="confirmingForget=true">{{ observationText("遗忘此观察") }}</button>
      </article>
    </div>
  </section>
</template>

<style scoped>
.observations-header,.observation-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.observations-actions{flex-wrap:wrap}.observations-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}.observation-list,.observation-detail,.observation-materials{display:grid;gap:12px}.observation-row,.observation-detail{min-width:0}.observation-row h3,.observation-detail h3,.observation-row p,.observation-detail p,.observation-detail dd,.observation-detail code{overflow-wrap:anywhere}.observation-detail dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 12px;margin:0}.observation-detail dd{margin:0}.feedback-group{display:grid;gap:8px;padding-block:10px;border-top:1px solid var(--border-color,rgba(128,128,128,.25))}.feedback-group .button-row{flex-wrap:wrap}.load-more{justify-self:start}@media (max-width:390px){.observations-header,.observation-row{align-items:stretch;flex-direction:column}.observation-detail dl{grid-template-columns:1fr}.observation-detail dd{margin-bottom:4px}}
</style>
