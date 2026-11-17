<script setup lang="ts">
import {
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  watch,
  type ComponentPublicInstance,
} from "vue";

import { createAgentUiState } from "../agentUiState";
import { uiText } from "../i18n";
import { desktopApi, type AgentProfile, type AppSnapshot, type ChatMessage, type Contact } from "../api";
import { createLatestRequestGuard } from "../requestGuard";
import { createProactiveReadCoordinator } from "../proactiveUiState";

const props = defineProps<{ agent: AgentProfile; contact: Contact | null; runtime: AppSnapshot["runtime"]; active: boolean }>();
const emit = defineEmits<{ "snapshot-changed": []; "busy-changed": [busy: boolean] }>();
const messages = ref<ChatMessage[]>([]);
const text = ref("");
const learn = ref(false);
const loading = ref(false);
const sending = ref(false);
const error = ref("");
const learningNotice = ref("");
const transcript = useTemplateRef<HTMLElement>("transcript");
const historyRequests = createLatestRequestGuard<string>();
const uiState = createAgentUiState();
const messageElements = new Map<string, HTMLElement>();
const visibleProactiveIds = new Set<string>();
const readCoordinator = createProactiveReadCoordinator();
let intersectionObserver: IntersectionObserver | undefined;
let historyRefreshPending = false;

function scopeKey(agentId = props.agent.id, contactId = props.contact?.id ?? ""): string {
  return `${agentId}\u0000${contactId}`;
}
function messageOf(value: unknown): string { return uiText(value instanceof Error ? value.message : String(value)); }
async function scrollToLatest(): Promise<void> {
  await nextTick();
  transcript.value?.scrollTo({ top: transcript.value.scrollHeight });
}
function canMarkProactiveRead(contactId: string): boolean {
  if (!props.active || contactId !== "owner") return false;
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  return true;
}
async function markVisibleProactiveRead(): Promise<void> {
  const agentId = props.agent.id;
  const contactId = props.contact?.id ?? "";
  if (!canMarkProactiveRead(contactId)) return;
  const attempt = readCoordinator.begin(scopeKey(agentId, contactId), [...visibleProactiveIds]);
  if (!attempt) return;
  try {
    const result = await desktopApi.readProactiveInbox(agentId, attempt.ids);
    if (readCoordinator.complete(attempt) && result.readIds.length) emit("snapshot-changed");
  } catch (reason) {
    if (readCoordinator.fail(attempt)) error.value = messageOf(reason);
  }
}
function registerProactiveMessage(element: Element | ComponentPublicInstance | null, proactiveId?: string): void {
  if (!proactiveId) return;
  const previous = messageElements.get(proactiveId);
  if (previous) {
    intersectionObserver?.unobserve(previous);
    messageElements.delete(proactiveId);
    visibleProactiveIds.delete(proactiveId);
  }
  if (!(element instanceof HTMLElement)) return;
  messageElements.set(proactiveId, element);
  intersectionObserver?.observe(element);
}
function setupVisibilityObserver(): void {
  intersectionObserver?.disconnect();
  if (!transcript.value) return;
  intersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const proactiveId = (entry.target as HTMLElement).dataset.proactiveId;
      if (!proactiveId) continue;
      if (entry.isIntersecting && entry.intersectionRatio > 0) visibleProactiveIds.add(proactiveId);
      else visibleProactiveIds.delete(proactiveId);
    }
    void markVisibleProactiveRead();
  }, { root: transcript.value, threshold: 0.01 });
  messageElements.forEach((element) => intersectionObserver?.observe(element));
}
/** 外部快照刷新在发送期间合并排队，保留本轮草稿、乐观消息与发送状态。 */
function refreshHistory(): void {
  if (sending.value) { historyRefreshPending = true; return; }
  void loadHistory({ preserveFeedback: true });
}
async function loadHistory({ preserveFeedback = false }: { preserveFeedback?: boolean } = {}): Promise<void> {
  const contactId = props.contact?.id;
  const agentId = props.agent.id;
  const request = historyRequests.begin(scopeKey(agentId, contactId));
  if (!contactId) { messages.value = []; loading.value = false; return; }
  loading.value = true;
  if (!preserveFeedback) error.value = "";
  try {
    const result = await desktopApi.chatHistory(agentId, contactId);
    if (!historyRequests.isCurrent(request, scopeKey())) return;
    messages.value = result.messages;
    await scrollToLatest();
    void markVisibleProactiveRead();
  } catch (reason) {
    if (historyRequests.isCurrent(request, scopeKey()) && (!preserveFeedback || !error.value)) error.value = messageOf(reason);
  } finally {
    if (historyRequests.isCurrent(request, scopeKey())) loading.value = false;
  }
}
async function sendMessage(): Promise<void> {
  const content = text.value.trim();
  if (!props.contact || !content || sending.value) return;
  const agentId = props.agent.id;
  const contactId = props.contact.id;
  const request = uiState.beginRequest(agentId, contactId);
  historyRequests.invalidate();
  sending.value = true;
  loading.value = false;
  emit("busy-changed", true);
  error.value = "";
  learningNotice.value = "";
  text.value = "";
  uiState.saveDraft(agentId, contactId, "", learn.value);
  messages.value.push({ role: "user", content });
  await scrollToLatest();
  try {
    const reply = await desktopApi.sendChat(agentId, contactId, content, learn.value);
    if (!uiState.isCurrent(request)) return;
    if (reply.suppressed) {
      await loadHistory();
    } else if (reply.superseded) {
      await loadHistory();
      learningNotice.value = uiText("记忆或角色状态已更新，本轮旧回复已隐藏。");
    } else {
      messages.value.push({ role: "assistant", content: reply.text });
      if (reply.learningError) learningNotice.value = reply.learningError;
      else if (["error", "cleanup-pending"].includes(reply.index.status)) learningNotice.value = uiText("本轮内容已保存，关联索引暂未更新。");
      else if (reply.learned) learningNotice.value = uiText("本轮内容已写入记忆。");
    }
    await scrollToLatest();
  } catch (reason) {
    if (!uiState.isCurrent(request)) return;
    messages.value.pop();
    text.value = content;
    uiState.saveDraft(agentId, contactId, content, learn.value);
    error.value = messageOf(reason);
  } finally {
    if (uiState.isCurrent(request)) {
      sending.value = false;
      if (historyRefreshPending) {
        historyRefreshPending = false;
        refreshHistory();
      }
    }
    emit("busy-changed", false);
    emit("snapshot-changed");
  }
}
async function cancelMessage(): Promise<void> {
  if (!props.runtime.taskId) return;
  error.value = "";
  try { await desktopApi.cancelChat(props.agent.id, props.runtime.taskId); }
  catch (reason) { error.value = messageOf(reason); }
  finally { emit("snapshot-changed"); }
}
function onAttentionChanged(): void { void markVisibleProactiveRead(); }
watch([() => props.agent.id, () => props.contact?.id], (next, previous) => {
  const [previousAgentId, previousContactId] = previous;
  if (previousAgentId && previousContactId) uiState.saveDraft(previousAgentId, previousContactId, text.value, learn.value);
  const [agentId, contactId] = next;
  uiState.activate(agentId, contactId ?? "");
  const draft = contactId ? uiState.draft(agentId, contactId) : { text: "", learn: false };
  text.value = draft.text;
  learn.value = draft.learn;
  sending.value = false;
  messages.value = [];
  messageElements.clear();
  visibleProactiveIds.clear();
  readCoordinator.activate(scopeKey(agentId, contactId));
  historyRefreshPending = false;
  intersectionObserver?.disconnect();
  error.value = "";
  learningNotice.value = "";
  void loadHistory().then(setupVisibilityObserver);
}, { immediate: true });
watch(() => props.agent.unreadCount, (next, previous) => {
  if (next > previous && props.contact?.id === "owner") refreshHistory();
});
watch(() => props.runtime.historyRevisions?.[props.contact?.id ?? ""], (next, previous) => {
  if (next !== previous) refreshHistory();
});
watch(() => props.active, (active) => {
  if (active) { readCoordinator.activate(scopeKey()); refreshHistory(); void markVisibleProactiveRead(); }
});
watch([text, learn], () => {
  if (props.contact) uiState.saveDraft(props.agent.id, props.contact.id, text.value, learn.value);
});
onMounted(() => {
  setupVisibilityObserver();
  window.addEventListener("focus", onAttentionChanged);
  document.addEventListener("visibilitychange", onAttentionChanged);
});
onUnmounted(() => {
  historyRequests.invalidate();
  uiState.invalidate();
  readCoordinator.activate("");
  intersectionObserver?.disconnect();
  window.removeEventListener("focus", onAttentionChanged);
  document.removeEventListener("visibilitychange", onAttentionChanged);
});
</script>

<template>
  <section class="page page-chat">
    <header class="chat-heading"><div class="agent-title-line"><h1>{{ agent.name }}</h1><span v-if="agent.nickname">{{ agent.nickname }}</span></div><span v-if="runtime.busy" class="busy-label" aria-live="polite">{{ uiText("正在回复") }}</span></header>
    <p v-if="error" class="inline-error" role="alert">{{ uiText(error) }}</p>
    <p v-if="learningNotice" class="inline-notice" aria-live="polite">{{ uiText(learningNotice) }}</p>
    <div ref="transcript" class="transcript" aria-live="polite" :aria-label="uiText('聊天记录')">
      <p v-if="loading" class="empty-state">{{ uiText("正在读取聊天记录…") }}</p>
      <p v-else-if="messages.length === 0" class="empty-state">{{ uiText("还没有消息。") }}</p>
      <article
        v-for="(message, index) in messages"
        :key="message.proactiveId ?? `${message.role}-${index}-${message.content.slice(0, 16)}`"
        :ref="(element) => registerProactiveMessage(element, message.role === 'assistant' ? message.proactiveId : undefined)"
        class="message"
        :class="[message.role, { proactive: message.role === 'assistant' && message.proactiveId }]"
        :data-proactive-id="message.role === 'assistant' ? message.proactiveId : undefined"
      >
        <span>{{ message.role === "user" ? (message.origin === "external" ? uiText("外部资料") : contact?.label ?? uiText("你")) : `${agent.name}${message.proactiveId ? uiText(" · 主动消息") : ""}` }}</span>
        <p>{{ message.content }}</p>
      </article>
      <article v-if="sending" class="message assistant pending"><span>{{ agent.name }}</span><p>{{ uiText("正在回复…") }}</p></article>
    </div>
    <form class="composer" @submit.prevent="sendMessage">
      <label class="sr-only" for="chat-message">{{ uiText("消息") }}</label>
      <textarea id="chat-message" v-model="text" rows="3" maxlength="6000" :placeholder="runtime.paused || agent.paused ? uiText('已暂停') : uiText('和{0}聊聊…', agent.name)" :disabled="!contact || runtime.paused || runtime.busy || agent.paused || sending" @keydown.ctrl.enter.prevent="sendMessage" @keydown.meta.enter.prevent="sendMessage" />
      <div class="composer-actions"><label class="checkbox-label"><input v-model="learn" type="checkbox" :disabled="sending" />{{ uiText("本轮学习") }}</label><div class="button-row"><button v-if="runtime.taskId" type="button" class="button" @click="cancelMessage">{{ uiText("停止") }}</button><button type="submit" class="button primary" :disabled="!contact || runtime.paused || runtime.busy || agent.paused || sending || !text.trim()">{{ uiText("发送") }}</button></div></div>
    </form>
  </section>
</template>
