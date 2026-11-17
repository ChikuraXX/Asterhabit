<script setup lang="ts">
import { DAILY_BUDGET } from "../api";
import { computed, onActivated, onDeactivated, onUnmounted, ref, watch } from "vue";

import {
  desktopApi,
  type QQConnectionStatus,
  type QQReplySettings,
  type QQReplyStatus,
  type QQSettings as QQPolicy,
} from "../api";
import { createLatestRequestGuard } from "../requestGuard";
import { qqSettingsText as t } from "../qqSettingsMessages";
import QQTargetRows from "./QQTargetRows.vue";
import QQGroupReception from "./QQGroupReception.vue";
import QQContactPanel from "./QQContactPanel.vue";

const props = defineProps<{ agentId: string }>();
const connection = ref<QQConnectionStatus | null>(null);
const policy = ref<QQPolicy | null>(null);
const persistedPolicy = ref<QQPolicy | null>(null);
const reply = ref<QQReplySettings | null>(null);
const persistedReply = ref<QQReplySettings | null>(null);
const replyStatus = ref<QQReplyStatus | null>(null);
const transport = ref<"qqbot" | "onebot">("onebot");
const endpoint = ref("ws://127.0.0.1:3001");
const appId = ref("");
const appSecret = ref("");
const pairingCode = ref("");
const pairingExpiresAt = ref<number | null>(null);
const allowedUserIdsText = ref("");
const userRemarks = ref<Record<string, string>>({});
const allowedGroupIdsText = ref("");
const userIdsValid = ref(true);
const groupIdsValid = ref(true);
const connectionLoading = ref(false);
const policyLoading = ref(false);
const replyLoading = ref(false);
const binding = ref(false);
const pairing = ref(false);
const unbinding = ref(false);
const savingPolicy = ref(false);
const savingReply = ref(false);
const connectionError = ref("");
const policyError = ref("");
const replyError = ref("");
const policySaved = ref("");
const replySaved = ref("");
const policySaveUncertain = ref(false);
const replySaveUncertain = ref(false);
const policyRemoteChanged = ref(false);
const replyRemoteChanged = ref(false);
const active = ref(true);
const targetRefreshKey = ref(0);

const connectionRequests = createLatestRequestGuard<string>();
const policyRequests = createLatestRequestGuard<string>();
const replyRequests = createLatestRequestGuard<string>();
const bindRequests = createLatestRequestGuard<string>();
const pairingRequests = createLatestRequestGuard<string>();
const unbindRequests = createLatestRequestGuard<string>();
const policySaveRequests = createLatestRequestGuard<string>();
const replySaveRequests = createLatestRequestGuard<string>();
let connectionPoll: ReturnType<typeof setTimeout> | null = null;
let wasDeactivated = false;
let backgroundConnectionPending = false;
let connectionFailureCount = 0;
let connectionRetryAt = 0;

function splitList(value: string): string[] {
  return [...new Set(value.split(/[，,\n]/u).map((item) => item.trim()).filter(Boolean))];
}
function sameList(left: string[], right: string[]): boolean {
  return left.join("\0") === right.join("\0");
}
/** 比较已规范化的本地备注，不把对象键顺序或空白备注视为业务变化。 */
function remarkSignature(value: Record<string, string> = {}): string {
  return JSON.stringify(Object.entries(value).map(([id,remark]) => [id,remark.trim()]).filter(([,remark]) => remark).sort(([left = ""],[right = ""]) => left.localeCompare(right)));
}
const policyDirty = computed(() => {
  if (!policy.value || !persistedPolicy.value) return false;
  return policy.value.receiveEnabled !== persistedPolicy.value.receiveEnabled
    || policy.value.groupMentionsOnly !== persistedPolicy.value.groupMentionsOnly
    || policy.value.groupFollowupMessages !== persistedPolicy.value.groupFollowupMessages
    || policy.value.groupFollowupSeconds !== persistedPolicy.value.groupFollowupSeconds
    || !sameList(splitList(allowedUserIdsText.value), persistedPolicy.value.allowedUserIds)
    || !sameList(splitList(allowedGroupIdsText.value), persistedPolicy.value.allowedGroupIds)
    || remarkSignature(userRemarks.value) !== remarkSignature(persistedPolicy.value.userRemarks);
});
const replyDirty = computed(() => {
  if (!reply.value || !persistedReply.value) return false;
  return ["enabled", "manualSendEnabled", "autoReplyEnabled", "dailyModelLimit", "dailySendLimit", "minSendGapSeconds"]
    .some((key) => reply.value?.[key as keyof QQReplySettings] !== persistedReply.value?.[key as keyof QQReplySettings]);
});
const listenerLabel = computed(() => {
  if (!connection.value?.appId) return "";
  if (!persistedPolicy.value?.receiveEnabled) return t("接收已关闭");
  if (connection.value.listener.state === "listening") return t("接收已开启，后台持续监听中");
  if (connection.value.listener.state === "connecting") return t("接收已开启，后台正在连接");
  if (connection.value.listener.state === "error") return t("接收已开启，但后台连接异常");
  return t("接收已开启，等待后台监听");
});

function messageOf(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return /配置已变化|CONFLICT/u.test(message) ? t("配置已被其他操作修改，请重新载入后再保存") : t(message);
}
function applyPolicy(settings: QQPolicy): void {
  policy.value = { ...settings, allowedUserIds: [...settings.allowedUserIds], allowedGroupIds: [...settings.allowedGroupIds] };
  persistedPolicy.value = { ...settings, allowedUserIds: [...settings.allowedUserIds], allowedGroupIds: [...settings.allowedGroupIds] };
  allowedUserIdsText.value = settings.allowedUserIds.join("\n");
  allowedGroupIdsText.value = settings.allowedGroupIds.join("\n");
  userRemarks.value = { ...settings.userRemarks };
  policyRemoteChanged.value = false;
}
function applyReply(settings: QQReplySettings, status: QQReplyStatus): void {
  reply.value = { ...settings };
  persistedReply.value = { ...settings };
  replyStatus.value = { ...status };
  replyRemoteChanged.value = false;
}
function clearSecret(): void { appSecret.value = ""; }
function stopConnectionPoll(): void {
  if (connectionPoll !== null) clearTimeout(connectionPoll);
  connectionPoll = null;
}
function ensureConnectionPoll(delay = 3000): void {
  if (!active.value || connectionPoll !== null || !connection.value?.appId) return;
  connectionPoll = setTimeout(() => {
    connectionPoll = null;
    if (!active.value) return;
    if (pairingExpiresAt.value !== null && pairingExpiresAt.value <= Date.now()) {
      pairingCode.value = "";
      pairingExpiresAt.value = null;
    }
    void loadConnection(props.agentId, { background: true });
  }, Math.max(0, delay));
}
function invalidateRequests(): void {
  connectionRequests.invalidate(); policyRequests.invalidate(); replyRequests.invalidate();
  bindRequests.invalidate(); pairingRequests.invalidate(); unbindRequests.invalidate();
  policySaveRequests.invalidate(); replySaveRequests.invalidate();
}

async function loadConnection(agentId: string, { background = false } = {}): Promise<void> {
  if (background) {
    if (backgroundConnectionPending) return;
    const remaining = connectionRetryAt - Date.now();
    if (remaining > 0) { ensureConnectionPoll(remaining); return; }
    backgroundConnectionPending = true;
  }
  const request = connectionRequests.begin(agentId);
  if (!background) connectionLoading.value = true;
  if (!background) connectionError.value = "";
  try {
    const result = await desktopApi.getQQConnection(agentId);
    if (!active.value || !connectionRequests.isCurrent(request, props.agentId)) return;
    connection.value = result;
    connectionError.value = ""; connectionFailureCount = 0; connectionRetryAt = 0;
    if (result.appId) appId.value = result.appId;
    if (result.appId && !background) ensureConnectionPoll(); else if (!result.appId) stopConnectionPoll();
    if (!result.pairing && pairingCode.value) { pairingCode.value = ""; pairingExpiresAt.value = null; }
    if (background) await Promise.all([
      loadPolicy(agentId, { preserveDraft: true, background: true }),
      loadReply(agentId, { preserveDraft: true, background: true }),
    ]);
  } catch (reason) {
    if (active.value && connectionRequests.isCurrent(request, props.agentId)) {
      connectionError.value = messageOf(reason);
      if (background) {
        connectionFailureCount += 1;
        connectionRetryAt = Date.now() + Math.min(30_000, 3000 * (2 ** Math.min(connectionFailureCount, 4)));
      }
    }
  } finally {
    if (background) backgroundConnectionPending = false;
    if (active.value && connectionRequests.isCurrent(request, props.agentId) && !background) connectionLoading.value = false;
    if (background && active.value && connection.value?.appId) ensureConnectionPoll(Math.max(3000, connectionRetryAt - Date.now()));
  }
}
async function loadPolicy(agentId: string, { preserveDraft = false, background = false } = {}): Promise<void> {
  const request = policyRequests.begin(agentId);
  if (!background) { policyLoading.value = true; policyError.value = ""; }
  try {
    const result = await desktopApi.getQQSettings(agentId);
    if (!active.value || !policyRequests.isCurrent(request, props.agentId)) return;
    const preserve = preserveDraft && (policyDirty.value || savingPolicy.value);
    if (!preserve) { applyPolicy(result.settings); policyError.value = ""; }
    else if (persistedPolicy.value && result.settings.revision !== persistedPolicy.value.revision) {
      policyRemoteChanged.value = true;
      policyError.value = t("接收设置已在其他位置变化；当前输入已保留，请重新载入后再保存");
    }
  } catch (reason) {
    if (active.value && policyRequests.isCurrent(request, props.agentId)) policyError.value = messageOf(reason);
  } finally {
    if (!background && active.value && policyRequests.isCurrent(request, props.agentId)) policyLoading.value = false;
  }
}
async function loadReply(agentId: string, { preserveDraft = false, background = false } = {}): Promise<void> {
  const request = replyRequests.begin(agentId);
  if (!background) { replyLoading.value = true; replyError.value = ""; }
  try {
    const result = await desktopApi.getQQReplySettings(agentId);
    if (!active.value || !replyRequests.isCurrent(request, props.agentId)) return;
    replyStatus.value = { ...result.status };
    const preserve = preserveDraft && (replyDirty.value || savingReply.value);
    if (!preserve) { applyReply(result.settings, result.status); replyError.value = ""; }
    else if (persistedReply.value && result.settings.revision !== persistedReply.value.revision) {
      replyRemoteChanged.value = true;
      replyError.value = t("回复设置已在其他位置变化；当前输入已保留，请重新载入后再保存");
    }
  } catch (reason) {
    if (active.value && replyRequests.isCurrent(request, props.agentId)) replyError.value = messageOf(reason);
  } finally {
    if (!background && active.value && replyRequests.isCurrent(request, props.agentId)) replyLoading.value = false;
  }
}
async function reloadSettings(): Promise<void> {
  stopConnectionPoll();
  policySaveUncertain.value = false; replySaveUncertain.value = false; policyRemoteChanged.value = false; replyRemoteChanged.value = false;
  policySaved.value = ""; replySaved.value = "";
  await Promise.all([loadPolicy(props.agentId), loadReply(props.agentId)]);
  ensureConnectionPoll();
}

async function bindConnection(): Promise<void> {
  const status = connection.value;
  if (!status || status.appId || status.storage !== "windows-user" || !appId.value.trim() || !appSecret.value || binding.value) return;
  const agentId = props.agentId, request = bindRequests.begin(agentId);
  binding.value = true; connectionError.value = ""; policySaved.value = "";
  try {
    if (transport.value === "onebot" && !/^[1-9]\d{0,19}$/.test(appId.value.trim())) throw new Error(t("请输入有效的 QQ 号"));
    const result = transport.value === "onebot"
      ? await desktopApi.bindOneBotConnection({ agentId, expectedRevision: status.revision, endpoint: endpoint.value.trim(), accountId: appId.value.trim(), accessToken: appSecret.value })
      : await desktopApi.bindQQConnection({ agentId, expectedRevision: status.revision, appId: appId.value.trim(), appSecret: appSecret.value });
    if (!active.value || !bindRequests.isCurrent(request, props.agentId)) return;
    connection.value = result; appId.value = result.appId ?? ""; policySaved.value = t("QQ 已绑定，接收保持关闭");
    await Promise.all([loadPolicy(agentId), loadReply(agentId)]); ensureConnectionPoll();
  } catch (reason) {
    if (active.value && bindRequests.isCurrent(request, props.agentId)) connectionError.value = messageOf(reason);
  } finally {
    if (active.value && bindRequests.isCurrent(request, props.agentId)) { clearSecret(); binding.value = false; }
  }
}
async function startPairing(): Promise<void> {
  const status = connection.value;
  if (!status?.appId || pairing.value) return;
  const agentId = props.agentId, request = pairingRequests.begin(agentId);
  pairing.value = true; connectionError.value = "";
  try {
    const result = await desktopApi.startQQPairing(agentId, status.revision);
    if (!active.value || !pairingRequests.isCurrent(request, props.agentId)) return;
    pairingCode.value = result.code; pairingExpiresAt.value = result.expiresAt; ensureConnectionPoll();
  } catch (reason) {
    if (active.value && pairingRequests.isCurrent(request, props.agentId)) connectionError.value = messageOf(reason);
  } finally {
    if (active.value && pairingRequests.isCurrent(request, props.agentId)) pairing.value = false;
  }
}
async function unbindConnection(): Promise<void> {
  const status = connection.value;
  if (!status?.appId || unbinding.value) return;
  const agentId = props.agentId, request = unbindRequests.begin(agentId);
  unbinding.value = true; connectionError.value = "";
  try {
    const result = await desktopApi.unbindQQConnection(agentId, status.revision);
    if (!active.value || !unbindRequests.isCurrent(request, props.agentId)) return;
    connection.value = result; transport.value = "onebot"; endpoint.value = "ws://127.0.0.1:3001"; appId.value = ""; pairingCode.value = ""; pairingExpiresAt.value = null;
    stopConnectionPoll(); policySaved.value = t("QQ 已解绑"); await loadPolicy(agentId);
  } catch (reason) {
    if (active.value && unbindRequests.isCurrent(request, props.agentId)) connectionError.value = messageOf(reason);
  } finally {
    if (active.value && unbindRequests.isCurrent(request, props.agentId)) unbinding.value = false;
  }
}
async function savePolicy(): Promise<void> {
  if (!policy.value || savingPolicy.value || policyRemoteChanged.value || !userIdsValid.value || !groupIdsValid.value) return;
  policyRequests.invalidate();
  const agentId = props.agentId, request = policySaveRequests.begin(agentId), current = policy.value;
  savingPolicy.value = true; policySaveUncertain.value = false; policyError.value = ""; policySaved.value = "";
  try {
    const result = await desktopApi.configureQQSettings({ agentId, expectedRevision: current.revision,
      receiveEnabled: current.receiveEnabled, sendEnabled: false, proactiveEnabled: false,
      allowedUserIds: splitList(allowedUserIdsText.value), allowedGroupIds: splitList(allowedGroupIdsText.value), groupMentionsOnly: current.groupMentionsOnly,
      ...(connection.value?.transport === "onebot" ? {groupFollowupMessages: current.groupFollowupMessages ?? 0, groupFollowupSeconds: current.groupFollowupSeconds ?? 120} : {}),
      userRemarks: Object.fromEntries(Object.entries(userRemarks.value).filter(([id]) => splitList(allowedUserIdsText.value).includes(id))) });
    if (!active.value || !policySaveRequests.isCurrent(request, props.agentId)) return;
    applyPolicy(result.settings); policySaved.value = t("接收设置已保存"); targetRefreshKey.value += 1;
    await loadConnection(agentId, { background: true });
  } catch (reason) {
    if (active.value && policySaveRequests.isCurrent(request, props.agentId)) policyError.value = messageOf(reason);
  } finally {
    if (active.value && policySaveRequests.isCurrent(request, props.agentId)) savingPolicy.value = false;
  }
}
function setManualReview(enabled: boolean): void {
  if (!reply.value) return;
  reply.value.manualSendEnabled = enabled;
  if (enabled) reply.value.autoReplyEnabled = false;
  reply.value.enabled = enabled || reply.value.autoReplyEnabled;
}
function setAutomatic(enabled: boolean): void {
  if (!reply.value) return;
  reply.value.autoReplyEnabled = enabled;
  if (enabled) reply.value.manualSendEnabled = false;
  else reply.value.manualSendEnabled = true;
  reply.value.enabled = reply.value.manualSendEnabled || enabled;
}
async function saveReply(): Promise<void> {
  if (!reply.value || savingReply.value || replyRemoteChanged.value) return;
  replyRequests.invalidate();
  const agentId = props.agentId, request = replySaveRequests.begin(agentId), current = { ...reply.value };
  savingReply.value = true; replySaveUncertain.value = false; replyError.value = ""; replySaved.value = "";
  try {
    const result = await desktopApi.configureQQReplies({ agentId, expectedRevision: current.revision,
      enabled: current.enabled, manualSendEnabled: current.manualSendEnabled, autoReplyEnabled: current.autoReplyEnabled,
      proactiveEnabled: false, dailyModelLimit: current.dailyModelLimit, dailySendLimit: current.dailySendLimit,
      minSendGapSeconds: current.minSendGapSeconds });
    if (!active.value || !replySaveRequests.isCurrent(request, props.agentId)) return;
    applyReply(result.settings, result.status); replySaved.value = t("回复设置已保存");
    await loadConnection(agentId, { background: true });
  } catch (reason) {
    if (active.value && replySaveRequests.isCurrent(request, props.agentId)) replyError.value = messageOf(reason);
  } finally {
    if (active.value && replySaveRequests.isCurrent(request, props.agentId)) savingReply.value = false;
  }
}

function resetForAgent(agentId: string): void {
  userRemarks.value = {};
  invalidateRequests(); stopConnectionPoll(); clearSecret(); backgroundConnectionPending = false; connectionFailureCount = 0; connectionRetryAt = 0;
  connection.value = null; policy.value = null; persistedPolicy.value = null; reply.value = null; persistedReply.value = null; replyStatus.value = null;
  appId.value = ""; pairingCode.value = ""; pairingExpiresAt.value = null; allowedUserIdsText.value = ""; allowedGroupIdsText.value = "";
  connectionLoading.value = false; policyLoading.value = false; replyLoading.value = false; binding.value = false; pairing.value = false; unbinding.value = false;
  savingPolicy.value = false; savingReply.value = false; policyRemoteChanged.value = false; replyRemoteChanged.value = false; connectionError.value = ""; policyError.value = ""; replyError.value = ""; policySaved.value = ""; replySaved.value = "";
  if (active.value) void Promise.all([loadConnection(agentId), loadPolicy(agentId), loadReply(agentId)]);
}
watch(() => props.agentId, resetForAgent, { immediate: true, flush: "sync" });
onDeactivated(() => {
  wasDeactivated = true; active.value = false;
  policySaveUncertain.value ||= savingPolicy.value; replySaveUncertain.value ||= savingReply.value;
  if (binding.value) clearSecret();
  invalidateRequests(); stopConnectionPoll(); backgroundConnectionPending = false;
  connectionLoading.value = false; policyLoading.value = false; replyLoading.value = false;
  binding.value = false; pairing.value = false; unbinding.value = false; savingPolicy.value = false; savingReply.value = false;
});
onActivated(async () => {
  if (!wasDeactivated) return;
  wasDeactivated = false;
  active.value = true;
  await Promise.all([loadConnection(props.agentId), loadPolicy(props.agentId, { preserveDraft: true }), loadReply(props.agentId, { preserveDraft: true })]);
  if (policySaveUncertain.value) policyError.value = t("页面离开时保存结果未确认，请重新载入后再继续");
  if (replySaveUncertain.value) replyError.value = t("页面离开时保存结果未确认，请重新载入后再继续");
});
onUnmounted(() => { active.value = false; invalidateRequests(); clearSecret(); stopConnectionPoll(); });
</script>

<template>
  <div class="settings-form qq-settings">
    <section class="settings-section qq-settings-block">
      <h2>{{ t("QQ 连接") }}</h2>
      <p v-if="connectionLoading" class="status-line">{{ t("正在读取连接…") }}</p>
      <p v-if="connectionError" class="inline-error" role="alert">{{ connectionError }}</p>
      <template v-if="connection">
        <div v-if="connection.appId" class="qq-connection-row qq-settings-row">
          <span><strong>{{ connection.label || `QQ Bot ${connection.appId}` }}</strong><small>{{ connection.transport === "onebot" ? "OneBot · QQ" : "AppID" }} {{ connection.appId }} · {{ listenerLabel }}</small></span>
          <div class="button-row"><button type="button" class="button" :disabled="pairing" @click="startPairing">{{ t(pairing ? "生成中…" : "生成绑定码") }}</button><button type="button" class="button danger-text" :disabled="unbinding" @click="unbindConnection">{{ t(unbinding ? "解绑中…" : "解绑") }}</button></div>
        </div>
        <p v-if="pairingCode" class="form-hint" role="status">{{ t("请用要授权的 QQ 向机器人发送绑定码：{0}", pairingCode) }}</p>
        <form v-if="!connection.appId" class="qq-connection-form" @submit.prevent="bindConnection">
          <div class="field-grid"><label><span>{{ t("接入方式") }}</span><select v-model="transport" :disabled="binding" @change="clearSecret"><option value="onebot">SnowLuma / OneBot 11</option><option value="qqbot">{{ t("官方 QQ 机器人") }}</option></select></label>
          <label v-if="transport === 'onebot'"><span>{{ t("WebSocket 地址") }}</span><input v-model.trim="endpoint" name="onebotEndpoint" type="url" maxlength="2048" required /></label></div>
          <div class="field-grid"><label><span>{{ transport === 'onebot' ? t('QQ 号') : 'AppID' }}</span><input v-model.trim="appId" name="appId" inputmode="numeric" maxlength="32" required /></label><label class="qq-secret-field"><span>{{ transport === "onebot" ? t("访问令牌") : "AppSecret" }}</span><input v-model="appSecret" name="appSecret" type="password" autocomplete="new-password" maxlength="4096" required /></label></div>
          <p v-if="connection.storage === 'unavailable'" class="inline-error">{{ t("当前系统不支持安全凭据存储") }}</p>
          <div class="button-row qq-button-row"><button type="submit" class="button primary" :disabled="binding || !appId || !appSecret || connection.storage !== 'windows-user'">{{ t(binding ? "验证中…" : "绑定并验证") }}</button></div>
        </form>
      </template>
    </section>

    <form v-if="policy" @submit.prevent="savePolicy">
      <section class="settings-section qq-settings-block">
        <h2>{{ t("白名单接收") }}</h2>
        <label class="setting-row toggle-row qq-settings-row"><span><strong>{{ t("接收 QQ 文字") }}</strong><small>{{ t("持续接收由应用后台维护，与当前页面是否打开无关。") }}</small></span><input v-model="policy.receiveEnabled" name="receiveEnabled" type="checkbox" role="switch" :disabled="!connection?.appId" /></label>
        <p v-if="!connection?.appId" class="form-hint qq-prerequisite" role="status">{{ t("请先绑定 QQ") }}</p>
        <QQTargetRows v-model="allowedUserIdsText" v-model:remarks="userRemarks" :agent-id="agentId" :numeric-ids="connection?.transport === 'onebot'" kind="user" :connected="Boolean(connection?.appId)" :connection-revision="connection?.revision ?? null" :active="active" :refresh-key="targetRefreshKey" :disabled="savingPolicy" @validity="userIdsValid = $event" />
        <QQTargetRows v-model="allowedGroupIdsText" :agent-id="agentId" :numeric-ids="connection?.transport === 'onebot'" kind="group" :connected="Boolean(connection?.appId)" :connection-revision="connection?.revision ?? null" :active="active" :disabled="savingPolicy" @validity="groupIdsValid = $event" />
        <label class="setting-row qq-settings-row"><span><strong>{{ t("群聊消息") }}</strong></span><select v-model="policy.groupMentionsOnly" name="groupMentionsOnly" :disabled="!connection?.appId || savingPolicy"><option :value="true">{{ t("仅接收 @ 机器人的消息") }}</option><option :value="false">{{ t("接收群内全部消息") }}</option></select></label>
        <div v-if="connection?.transport === 'onebot' && policy.groupMentionsOnly" class="field-grid">
          <label><span>{{ t("点名后接话条数（0关闭）") }}</span><input v-model.number="policy.groupFollowupMessages" name="groupFollowupMessages" type="number" min="0" max="50" step="1" required /></label>
          <label><span>{{ t("接话时限（秒，0关闭）") }}</span><input v-model.number="policy.groupFollowupSeconds" name="groupFollowupSeconds" type="number" min="0" max="600" step="1" required /></label>
        </div>
        <template v-if="!policy.groupMentionsOnly && connection?.transport !== 'onebot'">
          <p class="form-hint qq-prerequisite">{{ t("QQ 平台也必须开启接收所有消息；本地设置不会开通平台权限。") }}</p>
          <p class="form-hint qq-prerequisite">{{ t("自动回复开启后，AI 会选择回复或保持安静；每次判断计入业务阶段额度，保持安静不占发送额度。") }}</p>
          <QQGroupReception :agent-id="agentId" :connection-revision="connection?.revision ?? null" :group-ids="persistedPolicy?.allowedGroupIds ?? []" :active="active" />
        </template>
      </section>
      <p v-if="policyLoading" class="status-line">{{ t("正在读取接收设置…") }}</p><p v-if="policyError" class="inline-error" role="alert">{{ policyError }}</p>
      <footer class="settings-footer"><span role="status">{{ policySaved }}</span><div class="button-row"><button v-if="policyError" type="button" class="button" @click="reloadSettings">{{ t("重新载入") }}</button><button type="submit" class="button primary" :disabled="savingPolicy || policySaveUncertain || policyRemoteChanged || !policyDirty || !userIdsValid || !groupIdsValid">{{ t(savingPolicy ? "保存中…" : "保存接收设置") }}</button></div></footer>
    </form>
    <p v-else-if="policyLoading" class="status-line">{{ t("正在读取接收设置…") }}</p><p v-else-if="policyError" class="inline-error" role="alert">{{ policyError }}</p>

    <form v-if="reply" @submit.prevent="saveReply">
      <section class="settings-section qq-settings-block">
        <h2>{{ t("自动回复") }}</h2>
        <label class="setting-row toggle-row qq-settings-row"><span><strong>{{ t("自动回复") }}</strong><small>{{ t("收到合格消息后自动生成并发送") }}</small></span><input :checked="reply.autoReplyEnabled" name="autoReplyEnabled" type="checkbox" role="switch" :disabled="!connection?.appId" @change="setAutomatic(($event.target as HTMLInputElement).checked)" /></label>
        <label class="setting-row toggle-row qq-settings-row"><span><strong>{{ t("消息区审核发送") }}</strong><small>{{ t("在消息区手动生成、编辑并逐条确认") }}</small></span><input :checked="reply.manualSendEnabled" name="manualSendEnabled" type="checkbox" role="switch" :disabled="!connection?.appId" @change="setManualReview(($event.target as HTMLInputElement).checked)" /></label>
        <p class="form-hint">{{ t("关闭自动回复后保留消息区审核发送。") }}</p>
        <h3>{{ t("回复额度与间隔") }}</h3>
        <p class="form-hint qq-limit-scope">{{ t("两项额度均按当前 Agent 的所有 QQ 用户和群合计，换绑账号不重置。统计从现在往前 24 小时，不在零点清零；不影响接收消息。") }}</p>
        <div class="field-grid qq-reply-limits">
          <label><span>{{ t("滚动 24 小时业务阶段上限") }}</span><input v-model.number="reply.dailyModelLimit" name="dailyModelLimit" type="number" min="0" :max="DAILY_BUDGET.modelCallMaximum" /><small>{{ t("限制生成回复的模型处理量。普通草稿通常计 1 次；开启本轮学习时，提取和起草可各计 1 次。阶段预留后即计入，达到上限后停止新生成；手动编辑不计。这不是实际 provider 请求次数或费用上限。") }}</small></label>
          <label><span>{{ t("滚动 24 小时发送上限") }}</span><input v-model.number="reply.dailySendLimit" name="dailySendLimit" type="number" min="0" :max="DAILY_BUDGET.messageMaximum" /><small>{{ t("限制回复发送尝试次数，手动确认与自动回复共用。只生成草稿不计；失败或结果未知的已预留尝试也计入，达到上限后停止发送。") }}</small></label>
          <label><span>{{ t("此 Agent 所有 QQ 目标共用的最小发送间隔（秒）") }}</span><input v-model.number="reply.minSendGapSeconds" name="minSendGapSeconds" type="number" min="30" max="86400" /></label>
        </div>
        <p v-if="replyStatus" class="form-hint qq-limit-usage">{{ t("当前滚动 24 小时：业务阶段 {0}/{1}，发送 {2}/{3}", replyStatus.usedModelCalls24h, reply.dailyModelLimit, replyStatus.usedSends24h, reply.dailySendLimit) }}</p>
      </section>
      <p v-if="replyLoading" class="status-line">{{ t("正在读取回复设置…") }}</p><p v-if="replyError" class="inline-error" role="alert">{{ replyError }}</p>
      <footer class="settings-footer"><span role="status">{{ replySaved }}</span><div class="button-row"><button v-if="replyError" type="button" class="button" @click="reloadSettings">{{ t("重新载入") }}</button><button type="submit" class="button primary" :disabled="savingReply || replySaveUncertain || replyRemoteChanged || !replyDirty">{{ t(savingReply ? "保存中…" : "保存回复设置") }}</button></div></footer>
    </form>
    <p v-else-if="replyLoading" class="status-line">{{ t("正在读取回复设置…") }}</p><p v-else-if="replyError" class="inline-error" role="alert">{{ replyError }}</p>
    <QQContactPanel v-if="connection?.transport === 'onebot' && policy" :agent-id="agentId" :connection-revision="connection.revision" :receive-revision="policy.revision" />
  </div>
</template>

<style scoped>
.qq-settings, .qq-settings form, .qq-settings section { min-width: 0; }
.qq-settings-block { padding-top: 0; border-top: 0; }
.qq-settings-row { border-bottom: 0; }
.qq-prerequisite { margin: 8px 0 0; }
.qq-limit-usage { margin: 10px 0 0; }
.qq-connection-row strong, .qq-connection-row small, .qq-reply-limits small { overflow-wrap: anywhere; }
.qq-reply-limits label { align-content: start; }
.qq-reply-limits small { color: var(--text-muted); line-height: 1.45; }
@media (max-width: 520px) { .qq-connection-row { align-items: stretch; } .qq-connection-row .button-row { justify-content: flex-end; } }
</style>
