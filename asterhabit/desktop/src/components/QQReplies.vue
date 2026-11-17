<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";

import {
  desktopApi,
  type QQDraft,
  type QQMessageEntry,
  type QQReplySettings,
  type QQReplyStatus,
  type QQSendAttempt,
  type QQSendRecord,
} from "../api";
import { messagesText, generationFailureText } from "../messagesText";
import { buildMessageTimeline, type MessageConversation } from "../messagesUi";
import { createLatestRequestGuard } from "../requestGuard";
import { uiText } from "../i18n";

/** 确认弹窗冻结的发送声明；后续提交必须使用同一修订、目标和确认摘要。 */
interface SendConfirmation {
  id: string;
  revision: number;
  confirmationHash: string;
  text: string;
  target: QQDraft["target"];
}

const props = defineProps<{
  agentId: string;
  connected: boolean;
  conversation: MessageConversation;
  entries: QQMessageEntry[];
  drafts: QQDraft[];
  records: QQSendRecord[];
  settings: QQReplySettings;
  status: QQReplyStatus;
}>();
const emit = defineEmits<{ changed: [change?: { forgottenEventId?: string; forgottenRecordId?: string }] }>();
const draftText = ref<Record<string, string>>({});
const serverDraftText = ref<Record<string, string>>({});
const learnByEvent = ref<Record<string, boolean>>({});
const generationResult = ref<Record<string, { kind: "failed" | "suppressed"; text: string }>>({});
const confirmation = ref<SendConfirmation | null>(null);
const forgetEventId = ref<string | null>(null);
const forgetRecordId = ref<string | null>(null);
const generatingEventId = ref<string | null>(null);
const busyDraftId = ref<string | null>(null);
const forgettingId = ref<string | null>(null);
const recordForgettingId = ref<string | null>(null);
const error = ref("");
const sendStatusReason = ref("");
const generateRequests = createLatestRequestGuard<string>();
const draftRequests = createLatestRequestGuard<string>();
const forgetRequests = createLatestRequestGuard<string>();
const recordRequests = createLatestRequestGuard<string>();

const timeline = computed(() => buildMessageTimeline({
  conversation: props.conversation,
  entries: props.entries,
  drafts: props.drafts,
  records: props.records,
}));
const generationDisabledReason = computed(() => {
  if (!props.connected) return uiText("请先绑定 QQ");
  if (!props.settings.enabled) return messagesText("当前设置未启用回复草稿");
  if (props.settings.autoReplyEnabled) return messagesText("自动回复已开启，手动生成和发送暂不可用");
  if (props.status.usedModelCalls24h >= props.settings.dailyModelLimit) return messagesText("近 24 小时业务阶段额度已用尽");
  return "";
});

/** 将操作异常转换为既有本地化错误文本，保留后端给出的原因。 */
function messageOf(value: unknown): string {
  return uiText(value instanceof Error ? value.message : String(value));
}
/** 按当前系统区域展示Unix毫秒时间，不改写记录本身。 */
function formatDate(value: number): string {
  return new Date(value).toLocaleString(undefined, { hour12: false });
}
/** 将持久草稿状态映射为明确结果，unknown不归类为可重发失败。 */
function statusLabel(draft: QQDraft): string {
  return uiText({ ready: "待确认", sending: "发送中", sent: "已发送", failed: "发送失败，可重新确认", unknown: "发送结果未知", cancelled: "已丢弃", expired: "已过期" }[draft.status]);
}
/** 按单次发送尝试的权威结果显示，不从HTTP字段反推成功。 */
function attemptOutcomeLabel(attempt: QQSendAttempt): string {
  return uiText({ prepared: "已准备，尚未提交", dispatched: "已提交，结果待确认", sent: "平台接口确认发送成功", failed: "发送失败", unknown: "发送结果未知" }[attempt.outcome]);
}
/** 取得最后一次平台提交尝试；无尝试时保留null语义。 */
function latestAttempt(record: QQSendRecord): QQSendAttempt | null {
  return record.attempts.at(-1) ?? null;
}
/** 发送结果使用最后一次尝试，不从草稿状态推断平台回执。 */
function recordOutcomeLabel(record: QQSendRecord): string {
  const latest = latestAttempt(record);
  return latest ? attemptOutcomeLabel(latest) : uiText("尚未提交");
}
/** 消息流只展示实际提交正文；未提交时明确返回占位文案。 */
function recordSubmittedText(record: QQSendRecord): string {
  return latestAttempt(record)?.submittedText ?? uiText("尚未提交");
}
/** 确认摘要保留目标类型与OpenID，不使用显示名称替代授权身份。 */
function confirmationTargetLabel(): string {
  const target = confirmation.value?.target;
  if (!target) return "";
  return messagesText(target.kind === "private" ? "私聊目标 {0}" : "群聊目标 {0}", target.id);
}
/** 回执缺失保持“未提供”，不合成平台代码或消息ID。 */
function receiptValue(value: number | string | null): string {
  return value === null ? uiText("未提供") : String(value);
}
/** 只有未提交或明确失败的草稿允许继续编辑。 */
function isEditable(draft: QQDraft): boolean {
  return draft.status === "ready" || draft.status === "failed";
}
/** 比较主人本地输入与已保存正文，刷新不得覆盖未保存差异。 */
function isDirty(draft: QQDraft): boolean {
  return (draftText.value[draft.id] ?? "") !== draft.text;
}
/** 汇总发送确认的本地前提；后端仍负责最终授权和时窗校验。 */
function canConfirm(draft: QQDraft): boolean {
  return Boolean(props.connected
    && props.settings.enabled
    && !props.settings.autoReplyEnabled
    && props.settings.manualSendEnabled
    && isEditable(draft)
    && draft.confirmationHash
    && !isDirty(draft)
    && busyDraftId.value !== draft.id);
}
/** 就近解释当前草稿不可确认的首个可操作原因。 */
function confirmationDisabledReason(draft: QQDraft): string {
  if (!isEditable(draft) || busyDraftId.value === draft.id) return "";
  if (!props.connected) return uiText("请先绑定 QQ");
  if (!props.settings.enabled) return messagesText("当前设置未启用回复草稿");
  if (props.settings.autoReplyEnabled) return messagesText("自动回复已开启，手动生成和发送暂不可用");
  if (!props.settings.manualSendEnabled) return messagesText("当前设置未启用手动确认发送");
  if (isDirty(draft)) return uiText("请先保存修改");
  if (!draft.confirmationHash) return uiText("当前草稿不可发送");
  return "";
}

/** 为一种可并行职责建立迟到响应门，Agent或会话切换后不得提交旧结果。 */
async function runAction(
  guard: ReturnType<typeof createLatestRequestGuard<string>>,
  scope: string,
  action: (isCurrent: () => boolean) => Promise<void>,
): Promise<void> {
  const key = `${props.agentId}\0${scope}`;
  const request = guard.begin(key);
  error.value = "";
  try {
    await action(() => guard.isCurrent(request, `${props.agentId}\0${scope}`));
  } catch (reason) {
    if (guard.isCurrent(request, `${props.agentId}\0${scope}`)) error.value = messageOf(reason);
  }
}

/** 为指定来源生成一次审核草稿；静默拒答和运行失败保持不同结果。 */
async function generateDraft(entry: QQMessageEntry): Promise<void> {
  if (generationDisabledReason.value || generatingEventId.value) return;
  const scope = `generate:${entry.id}`;
  const request = generateRequests.begin(`${props.agentId}\0${scope}`);
  generatingEventId.value = entry.id;
  error.value = "";
  const results = { ...generationResult.value };
  delete results[entry.id];
  generationResult.value = results;
  try {
    const result = await desktopApi.generateQQDraft(props.agentId, entry.id, learnByEvent.value[entry.id] ?? false);
    if (!generateRequests.isCurrent(request, `${props.agentId}\0${scope}`)) return;
    if (result.outcome === "suppressed") generationResult.value = { ...generationResult.value, [entry.id]: { kind: "suppressed", text: uiText("已静默拒答，本次未生成草稿") } };
    else if (result.outcome !== "drafted" || !result.draft) throw new Error(uiText("草稿响应无效"));
    emit("changed");
  } catch (reason) {
    if (generateRequests.isCurrent(request, `${props.agentId}\0${scope}`)) generationResult.value = { ...generationResult.value, [entry.id]: { kind: "failed", text: uiText("运行失败：{0}。本次未生成草稿。", messageOf(reason)) } };
  } finally {
    if (generateRequests.isCurrent(request, `${props.agentId}\0${scope}`)) generatingEventId.value = null;
  }
}

/** 保存主人编辑后的正文；空值和过期修订继续交由既有后端合同拒绝。 */
async function saveDraft(draft: QQDraft): Promise<void> {
  const text = draftText.value[draft.id] ?? "";
  if (!isEditable(draft) || !isDirty(draft) || !text.trim() || busyDraftId.value) return;
  busyDraftId.value = draft.id;
  await runAction(draftRequests, `draft:${draft.id}`, async (isCurrent) => {
    const result = await desktopApi.updateQQDraft(props.agentId, draft.id, draft.revision, text);
    if (!isCurrent()) return;
    draftText.value = { ...draftText.value, [draft.id]: result.draft.text };
    serverDraftText.value = { ...serverDraftText.value, [draft.id]: result.draft.text };
    emit("changed");
  });
  busyDraftId.value = null;
}
/** 丢弃尚可编辑的本地草稿，不影响平台消息或其它会话。 */
async function cancelDraft(draft: QQDraft): Promise<void> {
  if (!isEditable(draft) || busyDraftId.value) return;
  busyDraftId.value = draft.id;
  await runAction(draftRequests, `draft:${draft.id}`, async (isCurrent) => {
    const result = await desktopApi.cancelQQDraft(props.agentId, draft.id, draft.revision);
    if (!isCurrent()) return;
    if (result.cancelled) emit("changed");
  });
  busyDraftId.value = null;
}
/** 用当前草稿修订冻结确认内容，避免弹窗期间继续编辑造成摘要失真。 */
function openConfirmation(draft: QQDraft): void {
  if (!canConfirm(draft) || !draft.confirmationHash) return;
  confirmation.value = { id: draft.id, revision: draft.revision, confirmationHash: draft.confirmationHash, text: draft.text, target: { ...draft.target } };
}
/** 按冻结的确认摘要提交一次；结果unknown仅展示，不自动重试。 */
async function sendDraft(): Promise<void> {
  const approved = confirmation.value;
  if (!approved || busyDraftId.value) return;
  busyDraftId.value = approved.id;
  sendStatusReason.value = "";
  await runAction(draftRequests, `send:${approved.id}`, async (isCurrent) => {
    const result = await desktopApi.sendQQDraft(props.agentId, approved.id, approved.revision, approved.confirmationHash);
    if (!isCurrent()) return;
    confirmation.value = null;
    if (result.outcome === "unknown") sendStatusReason.value = uiText("发送结果未知，不能再次发送");
    emit("changed");
  });
  confirmation.value = null;
  busyDraftId.value = null;
}
/** 遗忘来源消息及其本地派生记录，并通知父页先移除敏感投影。 */
async function forgetMessage(eventId: string): Promise<void> {
  if (forgettingId.value) return;
  forgettingId.value = eventId;
  await runAction(forgetRequests, `forget:${eventId}`, async (isCurrent) => {
    const result = await desktopApi.forgetQQMessage(props.agentId, eventId);
    if (!isCurrent()) return;
    if (result.forgotten) emit("changed", { forgottenEventId: eventId });
    forgetEventId.value = null;
  });
  forgettingId.value = null;
}
/** 删除单条本地发送记录；不声称撤回已经送达平台的消息。 */
async function forgetRecord(id: string): Promise<void> {
  if (recordForgettingId.value) return;
  recordForgettingId.value = id;
  await runAction(recordRequests, `record:${id}`, async (isCurrent) => {
    const result = await desktopApi.forgetQQSendRecord(props.agentId, id);
    if (!isCurrent()) return;
    if (result.forgotten) emit("changed", { forgottenRecordId: id });
    forgetRecordId.value = null;
  });
  recordForgettingId.value = null;
}

watch(() => props.drafts, (drafts) => {
  const nextText: Record<string, string> = {};
  const nextServer: Record<string, string> = {};
  for (const draft of drafts) {
    const previousServer = serverDraftText.value[draft.id];
    const currentLocal = draftText.value[draft.id];
    nextText[draft.id] = currentLocal === undefined || currentLocal === previousServer ? draft.text : currentLocal;
    nextServer[draft.id] = draft.text;
  }
  draftText.value = nextText;
  serverDraftText.value = nextServer;
  if (confirmation.value && !drafts.some((draft) => draft.id === confirmation.value?.id && draft.revision === confirmation.value.revision)) confirmation.value = null;
}, { immediate: true });
watch(() => props.entries, (entries) => {
  learnByEvent.value = Object.fromEntries(entries.map((entry) => [entry.id, learnByEvent.value[entry.id] ?? false]));
  generationResult.value = Object.fromEntries(Object.entries(generationResult.value).filter(([id]) => entries.some((entry) => entry.id === id)));
}, { immediate: true });
watch(() => [props.agentId, props.conversation.key] as const, () => {
  generateRequests.invalidate();
  draftRequests.invalidate();
  forgetRequests.invalidate();
  recordRequests.invalidate();
  confirmation.value = null;
  forgetEventId.value = null;
  forgetRecordId.value = null;
  generatingEventId.value = null;
  busyDraftId.value = null;
  forgettingId.value = null;
  recordForgettingId.value = null;
  error.value = "";
  sendStatusReason.value = "";
}, { flush: "sync" });
onUnmounted(() => {
  generateRequests.invalidate();
  draftRequests.invalidate();
  forgetRequests.invalidate();
  recordRequests.invalidate();
});
</script>

<template>
  <section class="reply-summary">
    <strong>{{ messagesText("业务阶段 {0}/{1} · 发送 {2}/{3} · 间隔 {4} 秒", status.usedModelCalls24h, settings.dailyModelLimit, status.usedSends24h, settings.dailySendLimit, settings.minSendGapSeconds) }}</strong>
    <p>{{ messagesText("滚动 24 小时：业务阶段预留不等同实际 provider 请求次数；发送按提交尝试计数，间隔适用于此 Agent 全部 QQ 目标。") }}</p>
  </section>
  <p v-if="error" class="inline-error thread-error" role="alert">{{ error }}</p>
  <p v-if="sendStatusReason" class="inline-error thread-error" role="alert">{{ sendStatusReason }}</p>
  <p v-if="!timeline.length" class="empty-state">{{ messagesText("暂无会话") }}</p>
  <div v-else class="message-timeline" aria-live="polite">
    <article v-for="item in timeline" :key="item.id" class="timeline-item" :class="`timeline-${item.kind}`">
      <template v-if="item.kind === 'received'">
        <header><span><strong>{{ messagesText("收件") }}</strong><small v-if="item.entry.kind === 'group'">{{ messagesText("发言者 {0}", item.entry.senderId) }}</small></span><time>{{ formatDate(item.at) }}</time></header>
        <p class="message-body">{{ item.entry.text }}</p>
        <p v-if="item.entry.automaticDecision === 'quiet'" class="form-hint action-reason">{{ messagesText("AI 选择保持安静") }}</p>
        <p v-if="item.entry.replyGeneration?.status === 'failed'" class="inline-error action-reason" role="status">{{ messagesText("回复生成失败：{0}（未发送）", generationFailureText(item.entry.replyGeneration.reason)) }}</p>
        <p v-else-if="item.entry.replyGeneration?.status === 'generating'" class="form-hint action-reason" role="status">{{ messagesText("正在生成回复…") }}</p>
        <p v-else-if="item.entry.replyGeneration?.status === 'cancelled'" class="form-hint action-reason">{{ messagesText("回复生成已停止（未发送）") }}</p>
        <p v-if="generationResult[item.entry.id]" :class="generationResult[item.entry.id]?.kind === 'failed' ? 'inline-error' : 'status-line'">{{ generationResult[item.entry.id]?.text }}</p>
        <div class="message-actions">
          <label><input v-model="learnByEvent[item.entry.id]" type="checkbox" />{{ uiText("本轮学习") }}</label>
          <button type="button" class="button quiet danger-text" :disabled="Boolean(forgettingId)" @click="forgetEventId = item.entry.id">{{ uiText(forgettingId === item.entry.id ? "遗忘中…" : "遗忘") }}</button>
          <button type="button" class="button" :disabled="Boolean(generationDisabledReason) || Boolean(generatingEventId)" @click="generateDraft(item.entry)">{{ uiText(generatingEventId === item.entry.id ? "生成中…" : "生成回复草稿") }}</button>
        </div>
        <p v-if="generationDisabledReason" class="form-hint action-reason">{{ generationDisabledReason }}</p>
      </template>
      <template v-else-if="item.kind === 'draft'">
        <header><span><strong>{{ messagesText("未发送草稿") }}</strong><small>{{ statusLabel(item.draft) }}</small></span><time>{{ formatDate(item.at) }}</time></header>
        <div class="draft-source"><strong>{{ uiText("源消息") }}</strong><p>{{ item.draft.sourceText }}</p></div>
        <label class="draft-editor"><span>{{ uiText("回复正文") }}</span><textarea v-model="draftText[item.draft.id]" rows="4" :disabled="!isEditable(item.draft) || busyDraftId === item.draft.id" /></label>
        <div class="message-actions">
          <button type="button" class="button quiet danger-text" :disabled="!isEditable(item.draft) || Boolean(busyDraftId)" @click="cancelDraft(item.draft)">{{ uiText("丢弃") }}</button>
          <button type="button" class="button" :disabled="!isEditable(item.draft) || !isDirty(item.draft) || !draftText[item.draft.id]?.trim() || Boolean(busyDraftId)" @click="saveDraft(item.draft)">{{ uiText("保存修改") }}</button>
          <button type="button" class="button primary" :disabled="!canConfirm(item.draft)" @click="openConfirmation(item.draft)">{{ uiText("确认发送") }}</button>
        </div>
        <p v-if="confirmationDisabledReason(item.draft)" class="form-hint action-reason">{{ confirmationDisabledReason(item.draft) }}</p>
      </template>
      <template v-else>
        <header><span><strong>{{ recordOutcomeLabel(item.record) }}</strong><small>{{ messagesText("机器人 {0}", item.record.selfId) }}</small></span><time>{{ formatDate(item.at) }}</time></header>
        <p class="message-body"><strong>{{ messagesText("已提交正文") }}</strong><br />{{ recordSubmittedText(item.record) }}</p>
        <details class="send-details">
          <summary><span><strong>{{ messagesText("发送详情") }}</strong><small>{{ recordOutcomeLabel(item.record) }}</small></span></summary>
          <div class="record-body">
            <div><strong>{{ uiText("模型原稿") }}</strong><p>{{ item.record.originalText ?? uiText("未记录") }}</p></div>
            <section v-for="(attempt, index) in item.record.attempts" :key="attempt.id" class="send-attempt">
              <header><strong>{{ uiText("发送尝试 {0}", index + 1) }}</strong><small>{{ attemptOutcomeLabel(attempt) }} · {{ formatDate(attempt.createdAt) }}</small></header>
              <div><strong>{{ uiText("实际提交正文") }}</strong><p>{{ attempt.submittedText ?? uiText("尚未提交") }}</p></div>
              <div v-if="attempt.receipt" class="platform-receipt"><strong>{{ uiText("平台接口回执") }}</strong><p><span>HTTP {{ receiptValue(attempt.receipt.httpStatus) }}</span><span>{{ uiText("平台代码 {0}", receiptValue(attempt.receipt.platformCode)) }}</span><span>{{ uiText("消息 ID {0}", receiptValue(attempt.receipt.messageId)) }}</span><span>Trace ID {{ receiptValue(attempt.receipt.traceId) }}</span></p></div>
              <p v-else class="status-line">{{ uiText("未收到平台回执") }}</p>
              <p v-if="attempt.errorCode" class="inline-error">{{ uiText("错误代码 {0}", attempt.errorCode) }}</p>
            </section>
            <div class="message-actions"><button type="button" class="button quiet danger-text" :disabled="Boolean(recordForgettingId)" @click="forgetRecordId = item.record.id">{{ uiText(recordForgettingId === item.record.id ? "删除中…" : "删除记录") }}</button></div>
          </div>
        </details>
      </template>
    </article>
  </div>

  <div v-if="confirmation" class="modal-backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="message-send-title"><header><h2 id="message-send-title">{{ uiText("确认发送这条回复") }}</h2></header><div><strong>{{ uiText("目标") }}</strong><p>QQ · {{ messagesText("机器人 {0}", conversation.accountId) }} · {{ confirmationTargetLabel() }}</p></div><div><strong>{{ uiText("已保存全文") }}</strong><p class="confirmation-text">{{ confirmation.text }}</p></div><footer><button type="button" class="button" :disabled="busyDraftId === confirmation.id" @click="confirmation = null">{{ uiText("返回修改") }}</button><button type="button" class="button primary" :disabled="busyDraftId === confirmation.id" @click="sendDraft">{{ uiText(busyDraftId === confirmation.id ? "发送中…" : "发送这条回复") }}</button></footer></section></div>
  <div v-if="forgetEventId" class="modal-backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="message-forget-title"><header><h2 id="message-forget-title">{{ uiText("确认本地遗忘") }}</h2></header><p>{{ uiText("将清除本地收件、草稿/发送记录和本轮学习；不会撤回已发送的 QQ 消息。") }}</p><footer><button type="button" class="button" :disabled="forgettingId === forgetEventId" @click="forgetEventId = null">{{ uiText("取消") }}</button><button type="button" class="button primary danger-text" :disabled="forgettingId === forgetEventId" @click="forgetMessage(forgetEventId)">{{ uiText(forgettingId === forgetEventId ? "遗忘中…" : "确认本地遗忘") }}</button></footer></section></div>
  <div v-if="forgetRecordId" class="modal-backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="message-record-forget-title"><header><h2 id="message-record-forget-title">{{ uiText("确认删除发送记录") }}</h2></header><p>{{ uiText("只删除本地发送记录，不会撤回 QQ 消息。") }}</p><footer><button type="button" class="button" :disabled="recordForgettingId === forgetRecordId" @click="forgetRecordId = null">{{ uiText("取消") }}</button><button type="button" class="button primary danger-text" :disabled="recordForgettingId === forgetRecordId" @click="forgetRecord(forgetRecordId)">{{ uiText(recordForgettingId === forgetRecordId ? "删除中…" : "确认删除记录") }}</button></footer></section></div>
</template>

<style scoped>
.reply-summary { background: #f6f7f8; border-bottom: 1px solid var(--line); display: grid; gap: 4px; padding: 11px 16px; }
.reply-summary p, .reply-summary strong { font-size: 11px; margin: 0; }
.reply-summary p { color: var(--muted); }
.thread-error { margin: 10px 16px 0; }
.message-timeline { display: grid; min-width: 0; padding: 10px 16px 22px; }
.timeline-item { border-bottom: 1px solid var(--line); min-width: 0; padding: 16px 0; }
.timeline-item > header, .send-details > summary, .send-attempt > header { align-items: flex-start; display: flex; gap: 12px; justify-content: space-between; }
.timeline-item > header > span, .send-details > summary > span { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.timeline-item small, .timeline-item time { color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
.message-body, .draft-source p, .record-body p, .confirmation-text { line-height: 1.65; overflow-wrap: anywhere; white-space: pre-wrap; }
.message-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; margin-top: 12px; }
.message-actions label { align-items: center; color: var(--muted); display: inline-flex; font-size: 11px; gap: 5px; }
.action-reason { margin: 7px 0 0; text-align: right; }
.draft-source { background: #f1f1f2; border-radius: 8px; margin-top: 10px; padding: 10px 12px; }
.draft-source p { margin: 5px 0 0; }
.draft-editor { display: grid; gap: 6px; margin-top: 10px; }
.draft-editor > span, .draft-source > strong, .record-body strong { color: var(--muted); font-size: 10px; }
.draft-editor textarea { resize: vertical; width: 100%; }
.send-details > summary { cursor: pointer; }
.record-body { display: grid; gap: 14px; padding: 14px 0 0 16px; }
.send-attempt { border-top: 1px solid var(--line); display: grid; gap: 10px; padding-top: 12px; }
.send-attempt > header { flex-direction: column; gap: 3px; }
.platform-receipt > p { display: flex; flex-wrap: wrap; gap: 5px 14px; }
@media (max-width: 520px) {
  .message-actions { align-items: stretch; flex-direction: column; }
  .message-actions .button { width: 100%; }
  .action-reason { text-align: left; }
  .timeline-item > header, .send-details > summary { flex-direction: column; }
  .record-body { padding-left: 0; }
}
</style>
