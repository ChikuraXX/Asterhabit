<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";

import {
  desktopApi,
  type QQConnectionStatus,
  type QQDraft,
  type QQMessageEntry,
  type QQReplySettings,
  type QQReplyStatus,
  type QQSendRecord,
} from "../api";
import { buildMessageConversations, type MessageConversation } from "../messagesUi";
import { messagesText } from "../messagesText";
import { createLatestRequestGuard } from "../requestGuard";
import QQReplies from "./QQReplies.vue";

const props = defineProps<{ agentId: string }>();
const connection = ref<QQConnectionStatus | null>(null);
const entries = ref<QQMessageEntry[]>([]);
const drafts = ref<QQDraft[]>([]);
const records = ref<QQSendRecord[]>([]);
const replySettings = ref<QQReplySettings | null>(null);
const replyStatus = ref<QQReplyStatus | null>(null);
const selectedKey = ref("");
const conversationOpen = ref(false);
const loading = ref(false);
const refreshing = ref(false);
const recordsLoading = ref(false);
const recordsCursor = ref<number | null>(null);
const error = ref("");
const requests = createLatestRequestGuard<string>();
const recordPageRequests = createLatestRequestGuard<string>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;
let disposed = false;
const loaded = ref(false);
let loadedRecordPages = 1;

const accountId = computed(() => connection.value?.selfId ?? connection.value?.appId ?? "unbound");
const conversations = computed(() => buildMessageConversations({
  agentId: props.agentId,
  accountId: accountId.value,
  entries: entries.value,
  drafts: drafts.value,
  records: records.value,
}));
const selectedConversation = computed<MessageConversation | null>(() => conversations.value.find((item) => item.key === selectedKey.value) ?? null);

/** 将未知异常收敛为可展示文本，不把失败伪装为空结果。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
/** 会话标题只展示平台身份，不据名称猜测普通QQ号或群号。 */
function conversationLabel(conversation: MessageConversation): string {
  return conversation.kind === "private" ? `QQ ${conversation.targetId}` : messagesText("群聊 {0}", conversation.targetId);
}
/** 明确区分私聊和群聊，防止同值OpenID在界面中合并。 */
function conversationKindLabel(conversation: MessageConversation): string {
  return messagesText(conversation.kind === "private" ? "QQ 私聊" : "QQ群聊");
}
/** 按当前系统区域显示Unix毫秒时间，不改变存储时区语义。 */
function formatDate(value: number): string {
  return new Date(value).toLocaleString(undefined, { hour12: false });
}
/** 选择已投影的稳定会话键；窄屏同时进入第二级消息流。 */
function selectConversation(key: string): void {
  selectedKey.value = key;
  conversationOpen.value = true;
}
/** 清除页面级刷新计时器，组件销毁或Agent切换后不得继续请求。 */
function cancelRefreshTimer(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
}
/** 按连续失败次数有界退避；成功后恢复四秒的页面增量刷新。 */
function scheduleRefresh(): void {
  cancelRefreshTimer();
  if (disposed) return;
  const delay = Math.min(30_000, 4_000 * (2 ** Math.min(retryCount, 3)));
  refreshTimer = setTimeout(() => { void refreshData(props.agentId, true); }, delay);
}
/** 账号作用域以绑定修订和官方身份共同判定，监听状态变化不构成换号。 */
function sameConnection(left: QQConnectionStatus, right: QQConnectionStatus): boolean {
  return left.revision === right.revision && left.appId === right.appId && left.selfId === right.selfId;
}
/** 校验发送记录游标单调前进，拒绝异常响应造成无限分页。 */
function validateRecordPage(response: { entries: QQSendRecord[]; nextCursor: number | null }, cursor?: number): void {
  if (!Array.isArray(response.entries)
    || response.nextCursor !== null && (!Number.isSafeInteger(response.nextCursor) || response.nextCursor < 1 || response.nextCursor === cursor)) {
    throw new Error(messagesText("发送记录响应无效"));
  }
}
/** 清空与绑定账号相关的全部投影，同时收回已展开的历史页范围。 */
function clearMessageData(): void {
  entries.value = [];
  drafts.value = [];
  records.value = [];
  replySettings.value = null;
  replyStatus.value = null;
  recordsCursor.value = null;
  loadedRecordPages = 1;
  selectedKey.value = "";
  conversationOpen.value = false;
}
/** 只重读主人已明确展开的记录页数；整体替换使遗忘和账号隔离及时生效。 */
async function loadRecordWindow(
  agentId: string,
  pageCount: number,
  request: ReturnType<typeof requests.begin>,
): Promise<{ entries: QQSendRecord[]; nextCursor: number | null }> {
  const entries: QQSendRecord[] = [];
  const known = new Set<string>();
  let cursor: number | undefined;
  let nextCursor: number | null = null;
  for (let page = 0; page < pageCount; page += 1) {
    const response = await desktopApi.listQQSendRecords(agentId, cursor, 20);
    if (!requests.isCurrent(request, props.agentId)) return { entries: [], nextCursor: null };
    validateRecordPage(response, cursor);
    for (const record of response.entries) if (!known.has(record.id)) { known.add(record.id); entries.push(record); }
    nextCursor = response.nextCursor;
    if (nextCursor === null) break;
    cursor = nextCursor;
  }
  return { entries, nextCursor };
}
/** 操作成功后先移除本地敏感投影，再用权威数据刷新，避免遗忘期间回显。 */
function handleContentChanged(change?: { forgottenEventId?: string; forgottenRecordId?: string }): void {
  if (change?.forgottenRecordId) records.value = records.value.filter((record) => record.id !== change.forgottenRecordId);
  if (change?.forgottenEventId) {
    const draftIds = new Set(drafts.value.filter((draft) => draft.eventId === change.forgottenEventId).map((draft) => draft.id));
    entries.value = entries.value.filter((entry) => entry.id !== change.forgottenEventId);
    drafts.value = drafts.value.filter((draft) => draft.eventId !== change.forgottenEventId);
    records.value = records.value.filter((record) => !draftIds.has(record.draftId));
  }
  void refreshData(props.agentId, true);
}

/** 后台刷新只替换已确认服务端数据，不重建页面或清空审核输入。 */
async function refreshData(agentId: string, background = false): Promise<void> {
  if (refreshing.value || disposed) return;
  const request = requests.begin(agentId);
  refreshing.value = true;
  if (!background && !loaded.value) loading.value = true;
  let retryImmediately = false;
  try {
    const startedConnection = await desktopApi.getQQConnection(agentId);
    if (!requests.isCurrent(request, props.agentId)) return;
    if (!startedConnection.appId) {
      connection.value = startedConnection;
      clearMessageData();
      loaded.value = true;
      error.value = "";
      retryCount = 0;
      return;
    }
    if (!startedConnection.selfId) {
      connection.value = startedConnection;
      clearMessageData();
      retryImmediately = true;
      return;
    }
    if (connection.value && !sameConnection(connection.value, startedConnection)) {
      connection.value = startedConnection;
      clearMessageData();
    }
    const [nextMessages, nextReply, nextDrafts, nextRecordPage] = await Promise.all([
      desktopApi.listQQMessages(agentId),
      desktopApi.getQQReplySettings(agentId),
      desktopApi.listQQDrafts(agentId),
      loadRecordWindow(agentId, loadedRecordPages, request),
    ]);
    if (!requests.isCurrent(request, props.agentId)) return;
    const completedConnection = await desktopApi.getQQConnection(agentId);
    if (!requests.isCurrent(request, props.agentId)) return;
    if (!sameConnection(startedConnection, completedConnection)) {
      connection.value = completedConnection;
      clearMessageData();
      retryImmediately = true;
      return;
    }
    connection.value = completedConnection;
    if (!completedConnection.appId || !completedConnection.selfId) {
      clearMessageData();
      loaded.value = true;
      return;
    }
    entries.value = [...nextMessages.entries];
    replySettings.value = { ...nextReply.settings };
    replyStatus.value = { ...nextReply.status };
    drafts.value = nextDrafts.entries.filter((draft) => draft.selfId === completedConnection.selfId);
    records.value = nextRecordPage.entries.filter((record) => record.selfId === completedConnection.selfId);
    recordsCursor.value = nextRecordPage.nextCursor;
    loaded.value = true;
    error.value = "";
    retryCount = 0;
    const available = buildMessageConversations({ agentId, accountId: completedConnection.selfId, entries: entries.value, drafts: drafts.value, records: records.value });
    if (!available.some((item) => item.key === selectedKey.value)) {
      selectedKey.value = available[0]?.key ?? "";
      if (!selectedKey.value) conversationOpen.value = false;
    }
  } catch (reason) {
    if (requests.isCurrent(request, props.agentId)) {
      error.value = messagesText("刷新失败，稍后自动重试：{0}", messageOf(reason));
      retryCount += 1;
    }
  } finally {
    if (requests.isCurrent(request, props.agentId)) {
      refreshing.value = false;
      loading.value = retryImmediately && !loaded.value;
      if (retryImmediately) {
        cancelRefreshTimer();
        refreshTimer = setTimeout(() => { void refreshData(props.agentId, true); }, 250);
      } else scheduleRefresh();
    }
  }
}

/** 主人显式加载更早的本地发送记录；不在后台轮询中反复读取历史页。 */
async function loadMoreRecords(): Promise<void> {
  const cursor = recordsCursor.value;
  const current = connection.value;
  if (cursor === null || recordsLoading.value || !current?.selfId) return;
  const agentId = props.agentId;
  const key = `${agentId}\0${current.revision}\0${current.selfId}\0${cursor}`;
  const request = recordPageRequests.begin(key);
  recordsLoading.value = true;
  error.value = "";
  try {
    const startedConnection = await desktopApi.getQQConnection(agentId);
    if (!recordPageRequests.isCurrent(request, key)) return;
    const response = await desktopApi.listQQSendRecords(agentId, cursor, 20);
    validateRecordPage(response, cursor);
    const completedConnection = await desktopApi.getQQConnection(agentId);
    if (!recordPageRequests.isCurrent(request, key)) return;
    if (!sameConnection(startedConnection, completedConnection) || !completedConnection.selfId || !sameConnection(current, completedConnection)) {
      connection.value = completedConnection;
      clearMessageData();
      void refreshData(agentId, true);
      return;
    }
    const known = new Set(records.value.map((record) => record.id));
    records.value = [...records.value, ...response.entries.filter((record) => record.selfId === completedConnection.selfId && !known.has(record.id))];
    recordsCursor.value = response.nextCursor;
    loadedRecordPages += 1;
  } catch (reason) {
    if (recordPageRequests.isCurrent(request, key)) error.value = messageOf(reason);
  } finally {
    if (recordPageRequests.isCurrent(request, key)) recordsLoading.value = false;
  }
}

watch(() => props.agentId, (agentId) => {
  requests.invalidate();
  recordPageRequests.invalidate();
  cancelRefreshTimer();
  retryCount = 0;
  connection.value = null;
  entries.value = [];
  drafts.value = [];
  records.value = [];
  recordsCursor.value = null;
  replySettings.value = null;
  replyStatus.value = null;
  selectedKey.value = "";
  conversationOpen.value = false;
  error.value = "";
  loading.value = false;
  refreshing.value = false;
  recordsLoading.value = false;
  loaded.value = false;
  loadedRecordPages = 1;
  void refreshData(agentId);
}, { immediate: true, flush: "sync" });

onUnmounted(() => {
  disposed = true;
  requests.invalidate();
  recordPageRequests.invalidate();
  cancelRefreshTimer();
});
</script>

<template>
  <div class="messages-page" :class="{ 'conversation-open': conversationOpen }">
    <header class="messages-header">
      <h1>{{ messagesText("消息") }}</h1>
      <button type="button" class="button quiet" :disabled="refreshing" @click="refreshData(agentId)">{{ messagesText("刷新消息") }}</button>
    </header>
    <p v-if="error" class="inline-error messages-error" role="alert">{{ error }}</p>
    <p v-if="loading" class="status-line">{{ messagesText("正在读取消息…") }}</p>
    <div v-else-if="loaded && !connection?.appId" class="empty-state messages-empty"><strong>{{ messagesText("QQ 尚未绑定") }}</strong><span>{{ messagesText("绑定后，已授权范围内的消息会显示在这里。") }}</span></div>
    <div v-else-if="connection?.appId" class="messages-workspace">
      <aside class="conversation-list" :aria-label="messagesText('消息')">
        <div class="platform-heading"><strong>QQ</strong><small>{{ connection.label || connection.selfId || connection.appId }}</small></div>
        <p v-if="!conversations.length" class="empty-state">{{ messagesText("暂无会话") }}</p>
        <button
          v-for="conversation in conversations"
          :key="conversation.key"
          type="button"
          class="conversation-item"
          :class="{ selected: conversation.key === selectedKey }"
          @click="selectConversation(conversation.key)"
        >
          <span><strong>{{ conversationLabel(conversation) }}</strong><small>{{ conversationKindLabel(conversation) }}</small></span>
          <time>{{ formatDate(conversation.lastActivityAt) }}</time>
        </button>
        <div v-if="recordsCursor !== null" class="conversation-record-more"><button type="button" class="button quiet" :disabled="recordsLoading" @click="loadMoreRecords">{{ messagesText(recordsLoading ? "加载中…" : "加载更多记录") }}</button></div>
      </aside>
      <main class="message-thread">
        <template v-if="selectedConversation && replySettings && replyStatus">
          <header class="thread-heading">
            <button type="button" class="thread-back button quiet" @click="conversationOpen = false">{{ messagesText("返回会话") }}</button>
            <span><strong>{{ conversationLabel(selectedConversation) }}</strong><small>QQ · {{ selectedConversation.accountId }}</small></span>
          </header>
          <QQReplies
            :agent-id="agentId"
            :connected="Boolean(connection.appId)"
            :conversation="selectedConversation"
            :entries="entries"
            :drafts="drafts"
            :records="records"
            :settings="replySettings"
            :status="replyStatus"
            @changed="handleContentChanged"
          />
        </template>
        <p v-else class="empty-state">{{ messagesText("选择一个会话") }}</p>
      </main>
    </div>
    <p v-if="connection?.appId" class="messages-retention-note">{{ messagesText("本地短期消息记录，不代表完整 QQ 历史") }}</p>
  </div>
</template>

<style scoped>
.messages-page { display: grid; min-height: 0; gap: 12px; }
.messages-header { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.messages-header h1 { font-size: 22px; margin: 0; }
.messages-header p { color: var(--muted); font-size: 12px; margin: 5px 0 0; }
.messages-error { margin: 0; }
.messages-empty { align-items: flex-start; display: flex; flex-direction: column; gap: 6px; }
.messages-workspace { border: 1px solid var(--line); border-radius: 12px; display: grid; grid-template-columns: minmax(210px, 30%) minmax(0, 1fr); min-height: 560px; overflow: hidden; }
.conversation-list { border-right: 1px solid var(--line); min-width: 0; overflow: auto; }
.platform-heading { border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 3px; padding: 13px 14px; }
.platform-heading small { color: var(--muted); overflow-wrap: anywhere; }
.conversation-item { align-items: flex-start; background: transparent; border: 0; border-bottom: 1px solid var(--line); color: inherit; cursor: pointer; display: flex; font: inherit; gap: 8px; justify-content: space-between; padding: 13px 14px; text-align: left; width: 100%; }
.conversation-item:hover, .conversation-item.selected { background: #f3f4f5; }
.conversation-item > span { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.conversation-item strong, .conversation-item small { overflow-wrap: anywhere; }
.conversation-item small, .conversation-item time { color: var(--muted); font-size: 10px; }
.conversation-item time { flex: 0 0 auto; max-width: 86px; text-align: right; }
.conversation-record-more { display: flex; justify-content: center; padding: 12px; }
.message-thread { min-width: 0; overflow: auto; }
.thread-heading { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 10px; padding: 13px 16px; }
.thread-heading > span { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.thread-heading strong, .thread-heading small { overflow-wrap: anywhere; }
.thread-heading small { color: var(--muted); }
.thread-back { display: none; }
.messages-retention-note { color: var(--muted); font-size: 11px; margin: 0; }
@media (max-width: 520px) {
  .messages-header { align-items: stretch; flex-direction: column; }
  .messages-header > button { align-self: flex-end; }
  .messages-workspace { display: block; min-height: 480px; }
  .conversation-list { border-right: 0; }
  .message-thread { display: none; }
  .conversation-open .conversation-list { display: none; }
  .conversation-open .message-thread { display: block; }
  .thread-back { display: inline-flex; flex: 0 0 auto; }
}
</style>
