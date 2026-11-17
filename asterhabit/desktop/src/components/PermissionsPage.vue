<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";

import {
  desktopApi,
  type ActionKind,
  type ControlSnapshot,
  type Grant,
  type GrantInput,
} from "../api";
import { createLatestRequestGuard } from "../requestGuard";
import { uiText } from "../i18n";
import { createRevisionCapture } from "../uiState";
import { loadPermissionOverview, type PermissionSettingsTab } from "../permissionOverview";
import { permissionText } from "../permissionMessages";

const props = defineProps<{ agentId: string; control: ControlSnapshot; paused?: boolean }>();
const emit = defineEmits<{ "snapshot-changed": []; "open-settings": [tab: PermissionSettingsTab] }>();
const overview = ref<Awaited<ReturnType<typeof loadPermissionOverview>> | null>(null);
const overviewLoading = ref(false);
const overviewRequests = createLatestRequestGuard<string>();
/** 部分读取失败时保留其他独立配置的结果，不将失败显示为关闭。 */
function valueOf<T>(result: PromiseSettledResult<T> | undefined): T | null {
  return result?.status === "fulfilled" ? result.value : null;
}
const qqConnection = computed(() => valueOf(overview.value?.qqConnection));
const qqSettings = computed(() => valueOf(overview.value?.qqSettings)?.settings);
const qqReply = computed(() => valueOf(overview.value?.qqReply));
const content = computed(() => valueOf(overview.value?.content));
const bilibiliAccount = computed(() => valueOf(overview.value?.bilibiliAccount));
const growth = computed(() => valueOf(overview.value?.growth));
const proactive = computed(() => valueOf(overview.value?.proactive));
const stateText = (enabled: boolean) => permissionText(enabled ? "on" : "off");
/** 仅在进入页面、切换 Agent 或显式刷新时读回，不启动额外轮询或平台请求。 */
async function refreshOverview(): Promise<void> {
  const agentId = props.agentId;
  const request = overviewRequests.begin(agentId);
  overviewLoading.value = true;
  try {
    const result = await loadPermissionOverview(agentId);
    if (overviewRequests.isCurrent(request, props.agentId)) overview.value = result;
  } finally {
    if (overviewRequests.isCurrent(request, props.agentId)) overviewLoading.value = false;
  }
}

const actionOptions: Array<{ value: ActionKind; label: string }> = [
  { value: "read_post", label: "读取合成帖子" },
  { value: "draft_reply", label: "起草模拟回复" },
  { value: "submit_reply", label: "提交模拟回复" },
];

const form = reactive({
  id: undefined as string | undefined,
  account: "sandbox" as const,
  target: "",
  action: "read_post" as ActionKind,
  limit: 1,
  windowSeconds: 3600,
  expiresAt: "",
  enabled: false,
});
const saving = ref(false);
const revokingId = ref<string | null>(null);
const error = ref("");
const formRevision = createRevisionCapture();
const saveRequests = createLatestRequestGuard<string>();
const revokeRequests = createLatestRequestGuard<string>();

function messageOf(value: unknown): string {
  return uiText(value instanceof Error ? value.message : String(value));
}
function actionLabel(action: ActionKind): string {
  return uiText(actionOptions.find((option) => option.value === action)?.label ?? action);
}

function toLocalDateTime(iso: string): string {
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(uiText("zh-CN"), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function resetForm(): void {
  form.id = undefined;
  form.target = "";
  form.action = "read_post";
  form.limit = 1;
  form.windowSeconds = 3600;
  form.expiresAt = "";
  form.enabled = false;
  formRevision.clear();
  error.value = "";
}

function beginFormEdit(): void {
  if (formRevision.current() === null) formRevision.begin(props.control.revision);
}

function editGrant(grant: Grant): void {
  formRevision.begin(props.control.revision);
  form.id = grant.id;
  form.target = grant.target;
  form.action = grant.action;
  form.limit = grant.limit;
  form.windowSeconds = grant.windowSeconds;
  form.expiresAt = toLocalDateTime(grant.expiresAt);
  form.enabled = grant.enabled;
  error.value = "";
}

async function saveGrant(): Promise<void> {
  if (saving.value) return;
  const agentId = props.agentId;
  const revision = formRevision.current() ?? props.control.revision;
  const request = saveRequests.begin(agentId);
  saving.value = true;
  error.value = "";
  try {
    const grant: GrantInput = {
      account: "sandbox",
      target: form.target.trim(),
      action: form.action,
      limit: Number(form.limit),
      windowSeconds: Number(form.windowSeconds),
      expiresAt: new Date(form.expiresAt).toISOString(),
      enabled: form.enabled,
    };
    if (form.id) grant.id = form.id;
    await desktopApi.savePermission(agentId, revision, grant);
    if (!saveRequests.isCurrent(request, props.agentId)) return;
    resetForm();
    emit("snapshot-changed");
  } catch (reason) {
    if (saveRequests.isCurrent(request, props.agentId)) error.value = messageOf(reason);
  } finally {
    if (saveRequests.isCurrent(request, props.agentId)) saving.value = false;
  }
}

async function revokeGrant(grant: Grant): Promise<void> {
  if (revokingId.value || !window.confirm(uiText("确认撤销“{0}”的授权吗？", grant.target))) return;
  const agentId = props.agentId;
  const revision = props.control.revision;
  const request = revokeRequests.begin(agentId);
  revokingId.value = grant.id;
  error.value = "";
  try {
    await desktopApi.revokePermission(agentId, grant.id, revision);
    if (!revokeRequests.isCurrent(request, props.agentId)) return;
    emit("snapshot-changed");
  } catch (reason) {
    if (revokeRequests.isCurrent(request, props.agentId)) error.value = messageOf(reason);
  } finally {
    if (revokeRequests.isCurrent(request, props.agentId)) revokingId.value = null;
  }
}

watch(() => props.agentId, () => {
  overviewRequests.invalidate();
  overview.value = null;
  void refreshOverview();
  saveRequests.invalidate();
  revokeRequests.invalidate();
  saving.value = false;
  revokingId.value = null;
  resetForm();
}, { flush: "sync", immediate: true });
onUnmounted(() => {
  overviewRequests.invalidate();
  saveRequests.invalidate();
  revokeRequests.invalidate();
});
</script>

<template>
  <section class="page">
    <header class="page-heading">
      <div>
        <h1>{{ uiText("权限") }}</h1>
        <p>{{ permissionText("scope") }}</p>
      </div>
    </header>

    <p v-if="error" class="inline-error" role="alert">{{ uiText(error) }}</p>
    <section class="settings-section permission-overview" :aria-label="permissionText('overview')" :aria-busy="overviewLoading">
      <div class="section-heading-row"><h2>{{ permissionText("overview") }}</h2><button class="button" type="button" :disabled="overviewLoading" @click="refreshOverview">{{ permissionText("retry") }}</button></div>
      <p v-if="paused" class="muted">{{ permissionText("paused") }}</p>
      <p v-if="overviewLoading" role="status">{{ permissionText("loading") }}</p>
      <template v-else>
        <div class="setting-row">
          <div><h3>{{ permissionText("qq") }} · {{ qqSettings ? stateText(qqSettings.receiveEnabled) : permissionText("unavailable") }}</h3><p v-if="qqSettings">{{ permissionText("qqScope", qqSettings.allowedUserIds.length, qqSettings.allowedGroupIds.length, permissionText(qqSettings.groupMentionsOnly ? 'mentions' : 'allGroup')) }}</p><p v-if="qqConnection">{{ permissionText(qqConnection.appId ? 'bound' : 'unbound') }} · {{ permissionText("listener", permissionText(qqConnection.listener.state)) }}</p><p v-else class="inline-error" role="alert">{{ permissionText("unavailable") }} · QQ</p></div>
          <a class="button" href="#settings/qq" @click.prevent="emit('open-settings', 'qq')">{{ permissionText("open") }}</a>
        </div>
        <div class="setting-row">
          <div><h3>{{ permissionText("reply") }}</h3><template v-if="qqReply"><p>{{ permissionText("replyScope", stateText(qqReply.settings.enabled), stateText(qqReply.settings.manualSendEnabled), stateText(qqReply.settings.autoReplyEnabled)) }}</p><p>{{ permissionText("replyQuota", qqReply.status.usedModelCalls24h, qqReply.settings.dailyModelLimit, qqReply.status.usedSends24h, qqReply.settings.dailySendLimit) }}</p></template><p v-else class="inline-error" role="alert">{{ permissionText("unavailable") }}</p></div>
          <a class="button" href="#settings/qq" @click.prevent="emit('open-settings', 'qq')">{{ permissionText("open") }}</a>
        </div>
        <div class="setting-row">
          <div><h3>{{ permissionText("bili") }}</h3><p v-if="bilibiliAccount">{{ permissionText(bilibiliAccount.account ? 'bound' : 'unbound') }}</p><p v-else class="inline-error" role="alert">{{ permissionText("unavailable") }} · BiliBili</p><p v-if="content">{{ permissionText("biliScope", stateText(content.settings.readEnabled), stateText(content.settings.allowLearning), content.settings.keywords.length, content.settings.creatorIds.length) }}</p><p v-else class="inline-error" role="alert">{{ permissionText("unavailable") }}</p></div>
          <a class="button" href="#settings/bilibili" @click.prevent="emit('open-settings', 'bilibili')">{{ permissionText("open") }}</a>
        </div>
        <div class="setting-row">
          <div><h3>{{ permissionText("growth") }} · {{ growth ? stateText(growth.growth.enabled) : permissionText("unavailable") }}</h3><p v-if="growth">{{ permissionText("growthScope", growth.growth.dailyCallLimit) }}</p></div>
          <a class="button" href="#settings/growth" @click.prevent="emit('open-settings', 'growth')">{{ permissionText("open") }}</a>
        </div>
        <div class="setting-row">
          <div><h3>{{ permissionText("proactive") }} · {{ proactive ? stateText(proactive.settings.enabled) : permissionText("unavailable") }}</h3><p v-if="proactive">{{ permissionText("proactiveScope", proactive.status.usedMessages24h, proactive.settings.dailyMessageLimit, proactive.status.usedCalls24h, proactive.settings.dailyCallLimit) }}</p></div>
          <a class="button" href="#settings/proactive" @click.prevent="emit('open-settings', 'proactive')">{{ permissionText("open") }}</a>
        </div>
        <div class="setting-row"><div><h3>{{ permissionText("platformSend") }} · {{ permissionText("unsupported") }}</h3><p>{{ permissionText("sendScope") }}</p></div></div>
      </template>
    </section>
    <h2>{{ permissionText("sandbox") }}</h2>
    <p class="permission-boundary">{{ permissionText("sandboxHelp") }}</p>

    <form class="form-panel permission-form" @input="beginFormEdit" @submit.prevent="saveGrant">
      <label>
        <span>{{ uiText("账号") }}</span>
        <select v-model="form.account" disabled>
          <option value="sandbox">sandbox</option>
        </select>
      </label>
      <label>
        <span>{{ uiText("目标") }}</span>
        <input v-model="form.target" required maxlength="200" :placeholder="uiText('合成目标标识')" />
      </label>
      <label>
        <span>{{ uiText("动作") }}</span>
        <select v-model="form.action">
          <option v-for="option in actionOptions" :key="option.value" :value="option.value">
            {{ uiText(option.label) }}
          </option>
        </select>
      </label>
      <div class="field-grid permission-limits">
        <label>
          <span>{{ uiText("额度") }}</span>
          <input v-model.number="form.limit" type="number" min="1" max="1000" required />
          <small>{{ permissionText("quotaHelp") }}</small>
        </label>
        <label>
          <span>{{ uiText("窗口（秒）") }}</span>
          <input v-model.number="form.windowSeconds" type="number" min="1" max="86400" required />
        </label>
      </div>
      <label>
        <span>{{ uiText("到期时间") }}</span>
        <input v-model="form.expiresAt" type="datetime-local" required />
        <small>{{ permissionText("expiryHelp") }}</small>
      </label>
      <label class="checkbox-label permission-toggle">
        <input v-model="form.enabled" type="checkbox" />
        {{ uiText("显式启用授权") }}
      </label>
      <div class="button-row form-actions">
        <button v-if="form.id" type="button" class="button ghost" @click="resetForm">{{ uiText("取消修改") }}</button>
        <button type="submit" class="button primary" :disabled="saving">
          {{ uiText(saving ? "保存中…" : form.id ? "保存修改" : "保存授权") }}
        </button>
      </div>
    </form>

    <div class="section-heading-row permission-list-heading"><h2>{{ uiText("sandbox 授权") }}</h2><span>{{ uiText("{0} 条", control.grants.length) }}</span></div>
    <div class="table-wrap permission-table">
      <table>
        <thead>
          <tr>
            <th>{{ uiText("状态") }}</th>
            <th>{{ uiText("目标 / 动作") }}</th>
            <th>{{ uiText("额度") }}</th>
            <th>{{ uiText("到期") }}</th>
            <th><span class="sr-only">{{ uiText("操作") }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="control.grants.length === 0">
            <td colspan="5" class="empty-cell">{{ uiText("尚未创建授权。") }}</td>
          </tr>
          <tr v-for="grant in control.grants" :key="grant.id">
            <td><span class="state-pill" :class="{ enabled: grant.enabled }">{{ uiText(grant.enabled ? "启用" : "关闭") }}</span></td>
            <td>
              <strong>{{ grant.target }}</strong>
              <span>{{ actionLabel(grant.action) }}</span>
            </td>
            <td>{{ uiText("{0} 次 / {1} 秒", grant.limit, grant.windowSeconds) }}</td>
            <td>{{ formatDate(grant.expiresAt) }}</td>
            <td>
              <div class="button-row table-actions">
                <button type="button" class="button quiet" :disabled="Boolean(revokingId)" @click="editGrant(grant)">{{ uiText("修改") }}</button>
                <button type="button" class="button quiet danger-text" :disabled="Boolean(revokingId)" @click="revokeGrant(grant)">{{ uiText(revokingId === grant.id ? "撤销中…" : "撤销") }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.permission-boundary { margin-bottom: 18px; }
.permission-overview h2 { margin: 0; font-size: 16px; }
.permission-overview h3 { margin: 0 0 6px; font-size: 14px; }
.permission-overview p { margin: 4px 0; overflow-wrap: anywhere; }
.permission-overview .setting-row > div { min-width: 0; }
.permission-overview a { flex-shrink: 0; text-align: center; text-decoration: none; }
.permission-form,
.permission-form label,
.permission-table { min-width: 0; }
.permission-limits { margin: 0; }
.permission-list-heading { margin: 28px 0 10px; }
.permission-list-heading h2 { margin: 0; font-size: 15px; }
.permission-table strong,
.permission-table span { overflow-wrap: anywhere; }
.permission-table .table-actions { justify-content: flex-end; flex-wrap: wrap; }
@media (max-width: 520px) {
  .permission-limits { grid-template-columns: 1fr; }
  .permission-table table { min-width: 680px; }
}
</style>
