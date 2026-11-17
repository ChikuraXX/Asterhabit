<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";

import { desktopApi, type AgentProfile, type Contact, type MemoryRecord, type MemoryStatus } from "../api";
import { createLatestRequestGuard } from "../requestGuard";
import { uiText } from "../i18n";
import { contactDisplayLabel } from "../contactDisplayLabel";
import { createScopedDraftStore } from "../uiState";

const props = defineProps<{ agent: AgentProfile; contact: Contact | null }>();

const records = ref<MemoryRecord[]>([]);
const status = ref<MemoryStatus | null>(null);
const query = ref("");
const topic = ref("");
const memoryText = ref("");
const editingId = ref<string | null>(null);
const editingText = ref("");
const loading = ref(false);
const saving = ref(false);
const authorizingId = ref<string | null>(null);
const growthScopeRevision = ref(0);
const error = ref("");
const listRequests = createLatestRequestGuard<string>();
const saveRequests = createLatestRequestGuard<string>();
const mutationRequests = createLatestRequestGuard<string>();
const authorizationRequests = createLatestRequestGuard<string>();
const drafts = createScopedDraftStore(() => ({ topic: "", text: "" }));

function currentContactId(): string | null {
  return props.contact?.id ?? null;
}

function currentScopeKey(): string {
  return `${props.agent.id}\u0000${currentContactId() ?? ""}`;
}

function messageOf(value: unknown): string {
  return uiText(value instanceof Error ? value.message : String(value));
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(uiText("zh-CN"), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

async function loadMemories(): Promise<void> {
  const contactId = currentContactId();
  const request = listRequests.begin(currentScopeKey());
  if (!contactId) {
    records.value = [];
    status.value = null;
    loading.value = false;
    return;
  }
  const searchQuery = query.value.trim() || undefined;
  loading.value = true;
  error.value = "";
  try {
    const [result, growthSources] = await Promise.all([
      desktopApi.listMemories(props.agent.id, contactId, searchQuery),
      desktopApi.listGrowthSources(props.agent.id, contactId, undefined, 1),
    ]);
    if (!listRequests.isCurrent(request, currentScopeKey())) return;
    records.value = result.records;
    status.value = result.status;
    growthScopeRevision.value = growthSources.scopeRevision;
  } catch (reason) {
    if (!listRequests.isCurrent(request, currentScopeKey())) return;
    error.value = messageOf(reason);
  } finally {
    if (listRequests.isCurrent(request, currentScopeKey())) loading.value = false;
  }
}

async function saveMemory(): Promise<void> {
  if (!props.contact || !topic.value.trim() || !memoryText.value.trim()) return;
  const contactId = props.contact.id;
  const agentId = props.agent.id;
  const scope = currentScopeKey();
  const request = saveRequests.begin(scope);
  const submittedDraft = { topic: topic.value, text: memoryText.value };
  drafts.write(scope, submittedDraft);
  const submittedTopic = topic.value.trim();
  const submittedText = memoryText.value.trim();
  saving.value = true;
  error.value = "";
  try {
    await desktopApi.saveMemory(agentId, contactId, submittedTopic, submittedText);
    const cleared = drafts.clearIf(scope, (draft) => draft.topic === submittedDraft.topic && draft.text === submittedDraft.text);
    if (!saveRequests.isCurrent(request, currentScopeKey())) return;
    if (cleared) { topic.value = ""; memoryText.value = ""; }
    await loadMemories();
  } catch (reason) {
    if (saveRequests.isCurrent(request, currentScopeKey())) error.value = messageOf(reason);
  } finally {
    if (saveRequests.isCurrent(request, currentScopeKey())) saving.value = false;
  }
}

function beginEdit(record: MemoryRecord): void {
  editingId.value = record.id;
  editingText.value = record.text;
}

async function applyCorrection(record: MemoryRecord): Promise<void> {
  if (!props.contact || !editingText.value.trim()) return;
  const contactId = props.contact.id;
  const agentId = props.agent.id;
  const request = mutationRequests.begin(currentScopeKey());
  error.value = "";
  try {
    await desktopApi.correctMemory(agentId, contactId, record.id, editingText.value.trim());
    if (!mutationRequests.isCurrent(request, currentScopeKey())) return;
    editingId.value = null;
    await loadMemories();
  } catch (reason) {
    if (mutationRequests.isCurrent(request, currentScopeKey())) error.value = messageOf(reason);
  }
}

async function forgetMemory(record: MemoryRecord): Promise<void> {
  if (!props.contact || !window.confirm(uiText("确认遗忘“{0}”吗？", record.topic))) return;
  const contactId = props.contact.id;
  const agentId = props.agent.id;
  const request = mutationRequests.begin(currentScopeKey());
  error.value = "";
  try {
    await desktopApi.forgetMemory(agentId, contactId, record.id);
    if (!mutationRequests.isCurrent(request, currentScopeKey())) return;
    await loadMemories();
  } catch (reason) {
    if (mutationRequests.isCurrent(request, currentScopeKey())) error.value = messageOf(reason);
  }
}

async function syncMemory(): Promise<void> {
  if (!props.contact) return;
  const contactId = props.contact.id;
  const agentId = props.agent.id;
  const request = mutationRequests.begin(currentScopeKey());
  error.value = "";
  try {
    const result = await desktopApi.syncMemory(agentId, contactId);
    if (!mutationRequests.isCurrent(request, currentScopeKey())) return;
    status.value = result.status;
    await loadMemories();
  } catch (reason) {
    if (mutationRequests.isCurrent(request, currentScopeKey())) error.value = messageOf(reason);
  }
}

async function recoverMemory(): Promise<void> {
  if (!props.contact) return;
  const contactId = props.contact.id;
  const agentId = props.agent.id;
  const request = mutationRequests.begin(currentScopeKey());
  error.value = "";
  try {
    await desktopApi.recoverMemory(agentId, contactId);
    if (!mutationRequests.isCurrent(request, currentScopeKey())) return;
    await loadMemories();
  } catch (reason) {
    if (mutationRequests.isCurrent(request, currentScopeKey())) error.value = messageOf(reason);
  }
}

async function authorizeForGrowth(record: MemoryRecord): Promise<void> {
  if (!props.contact || authorizingId.value) return;
  const agentId = props.agent.id;
  const contactId = props.contact.id;
  const request = authorizationRequests.begin(currentScopeKey());
  authorizingId.value = record.id;
  error.value = "";
  try {
    const result = await desktopApi.authorizeGrowthSources({
      agentId,
      contactId,
      memoryIds: [record.id],
      learn: true,
      expectedRevision: growthScopeRevision.value,
    });
    if (!authorizationRequests.isCurrent(request, currentScopeKey())) return;
    growthScopeRevision.value = result.scopeRevision;
    records.value = records.value.map((entry) => entry.id === record.id ? { ...entry, growthAuthorized: true } : entry);
  } catch (reason) {
    if (authorizationRequests.isCurrent(request, currentScopeKey())) error.value = messageOf(reason);
  } finally {
    if (authorizationRequests.isCurrent(request, currentScopeKey())) authorizingId.value = null;
  }
}

watch([() => props.agent.id, () => props.contact?.id], (next, previous) => {
  const [previousAgentId, previousContactId] = previous;
  if (previousAgentId && previousContactId) {
    drafts.write(`${previousAgentId}\u0000${previousContactId}`, { topic: topic.value, text: memoryText.value });
  }
  listRequests.invalidate();
  saveRequests.invalidate();
  mutationRequests.invalidate();
  authorizationRequests.invalidate();
  query.value = "";
  editingId.value = null;
  records.value = [];
  status.value = null;
  error.value = "";
  saving.value = false;
  authorizingId.value = null;
  const [agentId, contactId] = next;
  const draft = contactId ? drafts.read(`${agentId}\u0000${contactId}`) : { topic: "", text: "" };
  topic.value = draft.topic;
  memoryText.value = draft.text;
  void loadMemories();
}, { immediate: true, flush: "sync" });

watch([topic, memoryText], () => { if (props.contact) drafts.write(currentScopeKey(), { topic: topic.value, text: memoryText.value }); }, { flush: "sync" });
onUnmounted(() => {
  listRequests.invalidate();
  saveRequests.invalidate();
  mutationRequests.invalidate();
  authorizationRequests.invalidate();
});
</script>

<template>
  <section class="page">
    <header class="page-heading memory-heading">
      <div>
        <h1>{{ uiText("记忆") }}</h1>
        <p>{{ contactDisplayLabel(contact) }}</p>
      </div>
      <div class="button-row">
        <button type="button" class="button" :disabled="!contact || loading" @click="syncMemory">
          {{ uiText("同步索引") }}
        </button>
        <button type="button" class="button" :disabled="!contact || loading" @click="recoverMemory">
          {{ uiText("清理临时会话") }}
        </button>
      </div>
    </header>

    <p v-if="status" class="status-line">
      {{ uiText(status.dirty ? "记忆等待同步" : "记忆已同步") }}
    </p>
    <p v-if="status?.indexError" class="inline-error" role="alert">{{ status.indexError }}</p>
    <p v-if="error" class="inline-error" role="alert">{{ uiText(error) }}</p>

    <form class="search-row" role="search" @submit.prevent="loadMemories">
      <label class="sr-only" for="memory-search">{{ uiText("搜索记忆") }}</label>
      <input id="memory-search" v-model="query" type="search" :placeholder="uiText('搜索主题或内容')" />
      <button type="submit" class="button">{{ uiText("搜索") }}</button>
      <button v-if="query" type="button" class="button ghost" @click="query = ''; loadMemories()">{{ uiText("清除") }}</button>
    </form>

    <form class="form-panel memory-form" @submit.prevent="saveMemory">
      <label>
        <span>{{ uiText("主题") }}</span>
        <input v-model="topic" maxlength="100" required :disabled="!contact || saving" />
      </label>
      <label>
        <span>{{ uiText("内容") }}</span>
        <textarea v-model="memoryText" rows="2" maxlength="600" required :disabled="!contact || saving" />
      </label>
      <button type="submit" class="button primary" :disabled="!contact || saving">
        {{ uiText(saving ? "保存中…" : "新增记忆") }}
      </button>
    </form>

    <div class="record-list" aria-live="polite">
      <p v-if="loading" class="empty-state">{{ uiText("正在读取记忆…") }}</p>
      <p v-else-if="records.length === 0" class="empty-state">{{ uiText("没有符合条件的记忆。") }}</p>
      <article v-for="record in records" :key="record.id" class="record-row">
        <header>
          <div>
            <h2>{{ record.topic }}</h2>
            <span>{{ uiText(record.origin === "user" ? "主人记录" : "外部来源") }} · {{ formatTime(record.updatedAt) }}</span>
          </div>
          <div class="button-row">
            <button v-if="!record.growthAuthorized" type="button" class="button quiet" :disabled="authorizingId === record.id" @click="authorizeForGrowth(record)">{{ uiText(authorizingId === record.id ? "授权中…" : "用于成长") }}</button>
            <span v-else class="state-pill enabled">{{ uiText("已用于成长") }}</span>
            <button type="button" class="button quiet" @click="beginEdit(record)">{{ uiText("修改") }}</button>
            <button type="button" class="button quiet danger-text" @click="forgetMemory(record)">{{ uiText("遗忘") }}</button>
          </div>
        </header>
        <form v-if="editingId === record.id" class="inline-edit" @submit.prevent="applyCorrection(record)">
          <textarea v-model="editingText" rows="3" maxlength="600" required />
          <div class="button-row">
            <button type="button" class="button ghost" @click="editingId = null">{{ uiText("取消") }}</button>
            <button type="submit" class="button primary">{{ uiText("保存修改") }}</button>
          </div>
        </form>
        <p v-else>{{ record.text }}</p>
      </article>
    </div>
  </section>
</template>
