<script setup lang="ts">
import { DAILY_BUDGET } from "./api";
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { desktopApi, ROLE_FIELD_LIMITS, roleConfigurationOf, type AgentProfile, type AppSnapshot, type ModelConnection, type ModelEntry, type RoleTransferConfiguration } from "./api";
import ActivityPage from "./components/ActivityPage.vue";
import AgentSettingsPage from "./components/AgentSettingsPage.vue";
import AgentRoleFields from "./components/AgentRoleFields.vue";
import RoleTransferStart from "./components/RoleTransferStart.vue";
import ChatPage from "./components/ChatPage.vue";
import MessagesPage from "./components/MessagesPage.vue";
import GrowthPage from "./components/GrowthPage.vue";
import MemoryPage from "./components/MemoryPage.vue";
import PermissionsPage from "./components/PermissionsPage.vue";
import ModelConnectionsPage from "./components/ModelConnectionsPage.vue";
import ModelBindingSelect from "./components/ModelBindingSelect.vue";
import { modelText, modelAuthenticationText } from "./modelConnectionMessages";
import { uiLocalePreference, uiText } from "./i18n";
import { createLatestRequestGuard } from "./requestGuard";
import { createRevisionCapture, normalizedReasoningEffort } from "./uiState";
import { permissionText } from "./permissionMessages";
import type { PermissionSettingsTab } from "./permissionOverview";

type PageId = "chat" | "messages" | "memory" | "growth" | "permissions" | "activity" | "settings" | "model-services";
const pages: Array<{ id: PageId; label: string }> = [
  { id: "chat", label: "聊天" }, { id: "messages", label: "消息" }, { id: "memory", label: "记忆" }, { id: "growth", label: "成长" },
  { id: "permissions", label: "权限" }, { id: "activity", label: "活动" }, { id: "settings", label: "配置" },
];
const activePage = ref<PageId>("chat");
const settingsNavigation = ref<{ tab: PermissionSettingsTab; requestId: number }>();
/** 从权限概览进入同一 Agent 的权威设置，不更改配置或丢弃页面草稿。 */
function openPermissionSettings(tab: PermissionSettingsTab): void {
  settingsNavigation.value = { tab, requestId: (settingsNavigation.value?.requestId ?? 0) + 1 };
  activePage.value = "settings";
}
const snapshot = ref<AppSnapshot | null>(null);
const selectedAgentId = ref("");
const selectedContactId = ref("owner");
const models = ref<ModelEntry[]>([]);
const modelConnections = ref<ModelConnection[]>([]);
const createDialogueValid = ref(false);
const createExtractValid = ref(false);
const modelRequests = createLatestRequestGuard<string>();
const loading = ref(true);
const pausePending = ref(false);
const chatBusy = ref(false);
const connectionError = ref("");
const compactLayout = window.matchMedia("(max-width: 560px)");
const railCollapsed = ref(compactLayout.matches);
function onCompactLayout(event: MediaQueryListEvent): void { if (event.matches) railCollapsed.value = true; }
const showCreate = ref(false);
const createDraftPending = ref(false);
const showApplication = ref(false);
const showArchived = ref(false);
const modalPending = ref(false);
const createForm = reactive({ name: "", nickname: "", persona: "", model: "", dialogueModel: "", dialogueReasoningEffort: "" });
const createRoleForm = ref(roleConfigurationOf());
const applicationForm = reactive<{ reflectionDailyCallLimit: number; backgroundDailyCallLimit: number; proactiveDailyMessageLimit: number; minGapSeconds: number; dailyModelCallLimit: number | string; dialogueDailyCallLimit: number | string; keepRunningOnClose: boolean }>({
  reflectionDailyCallLimit: 2,
  backgroundDailyCallLimit: 6,
  proactiveDailyMessageLimit: 2,
  minGapSeconds: 1800,
  dailyModelCallLimit: "",
  dialogueDailyCallLimit: "",
  keepRunningOnClose: false,
});
const applicationRevision = createRevisionCapture();
const snapshotRequests = createLatestRequestGuard<string>();
const visibleAgents = computed(() => snapshot.value?.agents.filter((agent) => !agent.archived) ?? []);
const archivedAgents = computed(() => snapshot.value?.agents.filter((agent) => agent.archived) ?? []);
const activeAgent = computed(() => snapshot.value?.agent ?? null);
const switchingAgent = computed(() => Boolean(snapshot.value && selectedAgentId.value !== snapshot.value.agent.id));
const selectedContact = computed(() => snapshot.value?.contacts.find((contact) => contact.id === selectedContactId.value) ?? null);
const recoveryPending = computed(() => snapshot.value?.application.active?.kind === "recovery_pending" ? snapshot.value.application.active : null);
let lastActivityAt = 0;
let snapshotTimer: ReturnType<typeof setInterval> | undefined;
let snapshotsPending = 0;
let snapshotFailures = 0;
let nextSnapshotAt = 0;
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function avatarText(agent: AgentProfile): string { return agent.name.trim().slice(0, 1) || "?"; }

async function loadSnapshot(agentId = selectedAgentId.value, { background = false } = {}): Promise<void> {
  if (background && (snapshotsPending > 0 || Date.now() < nextSnapshotAt)) return;
  snapshotsPending += 1;
  const isInitialLoad = snapshot.value === null;
  const request = snapshotRequests.begin(agentId);
  if (isInitialLoad) loading.value = true;
  try {
    let next = await desktopApi.snapshot(agentId || undefined);
    if (!snapshotRequests.isCurrent(request, selectedAgentId.value)) return;
    const target = next.agents.find((agent) => agent.id === next.agent.id && !agent.archived)
      ?? next.agents.find((agent) => !agent.archived) ?? next.agent;
    if (target.id !== next.agent.id) {
      next = await desktopApi.snapshot(target.id);
      if (!snapshotRequests.isCurrent(request, selectedAgentId.value)) return;
    }
    if (next.agent.id !== target.id) throw new Error("Agent 状态归属不一致，请重新连接。");
    snapshot.value = next;
    snapshotFailures = 0;
    nextSnapshotAt = 0;
    selectedAgentId.value = target.id;
    connectionError.value = "";
    if (!next.contacts.some((contact) => contact.id === selectedContactId.value)) {
      selectedContactId.value = next.contacts.find((contact) => contact.id === "owner")?.id ?? next.contacts[0]?.id ?? "";
    }
  } catch (error) {
    if (!snapshotRequests.isCurrent(request, selectedAgentId.value)) return;
    // 后台失败按2至30秒退避；显式切换和重连不受后台退避限制。
    snapshotFailures += 1;
    nextSnapshotAt = Date.now() + Math.min(30_000, 2_000 * 2 ** Math.min(snapshotFailures - 1, 4));
    connectionError.value = messageOf(error);
    if (snapshot.value) selectedAgentId.value = snapshot.value.agent.id;
  } finally {
    snapshotsPending -= 1;
    if (isInitialLoad) loading.value = false;
  }
}
async function switchAgent(agentId: string): Promise<void> {
  if (agentId === selectedAgentId.value) {
    if (window.matchMedia("(max-width: 560px)").matches) railCollapsed.value = true;
    return;
  }
  selectedAgentId.value = agentId;
  selectedContactId.value = "owner";
  await loadSnapshot(agentId);
  if (window.matchMedia("(max-width: 560px)").matches) railCollapsed.value = true;
}
async function openRecovery(): Promise<void> {
  const recovery = recoveryPending.value;
  if (!recovery) return;
  activePage.value = "memory";
  await switchAgent(recovery.agentId);
  if (recovery.contactId && snapshot.value?.contacts.some((contact) => contact.id === recovery.contactId)) selectedContactId.value = recovery.contactId;
}
function recordActivity(): void {
  const now = Date.now();
  if (now - lastActivityAt < 30_000) return;
  lastActivityAt = now;
  void desktopApi.recordActivity().catch((error) => { connectionError.value = messageOf(error); });
}
async function toggleGlobalPause(): Promise<void> {
  if (!snapshot.value || pausePending.value) return;
  pausePending.value = true;
  try {
    const result = await desktopApi.setPaused(!snapshot.value.application.paused);
    snapshot.value = { ...snapshot.value, runtime: { ...snapshot.value.runtime, paused: result.application.paused }, application: result.application };
  } catch (error) { connectionError.value = messageOf(error); }
  finally { pausePending.value = false; }
}
async function toggleAgentPause(): Promise<void> {
  if (!activeAgent.value || pausePending.value) return;
  pausePending.value = true;
  try {
    await desktopApi.pauseAgent(activeAgent.value.id, activeAgent.value.profileRevision, !activeAgent.value.paused);
    await loadSnapshot(activeAgent.value.id);
  } catch (error) { connectionError.value = messageOf(error); }
  finally { pausePending.value = false; }
}
/** 关闭创建窗口保留当前草稿；成功创建后才清理。 */
function closeCreate(): void {
  if (modalPending.value) return;
  createDraftPending.value = true;
  showCreate.value = false;
}
function openCreate(): void {
  const first = models.value[0];
  if (!createDraftPending.value) {
    Object.assign(createForm, { name: "", nickname: "", persona: "", model: first?.handle ?? "", dialogueModel: first?.handle ?? "", dialogueReasoningEffort: first?.reasoningEfforts[0] ?? "" });
    createRoleForm.value = roleConfigurationOf();
  }
  createDraftPending.value = false;
  showCreate.value = true;
  void loadModelOptions();
}
/** 连接变更后同步重读目录，旧响应不能覆盖较新的连接选项。 */
async function loadModelOptions(): Promise<void> {
  const request = modelRequests.begin("models");
  try {
    const [catalogue, connections] = await Promise.all([desktopApi.listModels(), desktopApi.listModelConnections()]);
    if (!modelRequests.isCurrent(request, "models")) return;
    models.value = catalogue.entries;
    modelConnections.value = connections.connections;
  } catch (error) { if (modelRequests.isCurrent(request, "models")) connectionError.value = messageOf(error); }
}
/** 应用级服务入口在窄屏关闭侧栏，保留当前 Agent 和联系人。 */
function openModelServices(): void {
  if (showCreate.value) createDraftPending.value = true;
  closeApplication(); showCreate.value = false; activePage.value = "model-services";
  if (compactLayout.matches) railCollapsed.value = true;
}
function normalizeCreateDialogueEffort(): void {
  createForm.dialogueReasoningEffort = normalizedReasoningEffort(
    models.value,
    createForm.dialogueModel,
    createForm.dialogueReasoningEffort,
  );
}
/** 模板和导入只填写角色草稿；模型始终要求使用当前机器的显式选择。 */
function applyRoleTransfer(configuration: RoleTransferConfiguration): void {
  Object.assign(createForm, {
    name: configuration.name,
    nickname: configuration.nickname,
    persona: configuration.persona,
    model: "",
    dialogueModel: "",
    dialogueReasoningEffort: "",
  });
  createRoleForm.value = roleConfigurationOf(configuration);
  createDialogueValid.value = false;
  createExtractValid.value = false;
  connectionError.value = "";
}
async function createAgent(): Promise<void> {
  if (modalPending.value || !createForm.name.trim() || !createForm.dialogueModel || !createDialogueValid.value || !createExtractValid.value) return;
  modalPending.value = true;
  connectionError.value = "";
  try {
    const result = await desktopApi.createAgent({
      name: createForm.name.trim(), nickname: createForm.nickname.trim(), persona: createForm.persona.trim(),
      ...createRoleForm.value,
      model: createForm.model, dialogueModel: createForm.dialogueModel,
      dialogueReasoningEffort: createForm.dialogueReasoningEffort, reflectionModel: null, reflectionReasoningEffort: null,
    });
    showCreate.value = false;
    selectedAgentId.value = result.agent.id;
    activePage.value = "settings";
    await loadSnapshot(result.agent.id);
  } catch (error) { connectionError.value = messageOf(error); }
  finally { modalPending.value = false; }
}
function openApplication(): void {
  if (!snapshot.value) return;
  applicationRevision.begin(snapshot.value.application.revision);
  applicationForm.reflectionDailyCallLimit = snapshot.value.application.reflectionDailyCallLimit;
  applicationForm.backgroundDailyCallLimit = snapshot.value.application.backgroundDailyCallLimit;
  applicationForm.proactiveDailyMessageLimit = snapshot.value.application.proactiveDailyMessageLimit;
  applicationForm.minGapSeconds = snapshot.value.application.minGapSeconds;
  applicationForm.dailyModelCallLimit = snapshot.value.application.dailyModelCallLimit ?? "";
  applicationForm.dialogueDailyCallLimit = snapshot.value.application.dialogueDailyCallLimit ?? "";
  applicationForm.keepRunningOnClose = snapshot.value.application.keepRunningOnClose ?? false;
  showApplication.value = true;
}
function closeApplication(): void {
  showApplication.value = false;
  applicationRevision.clear();
}
async function saveApplication(): Promise<void> {
  if (!snapshot.value || modalPending.value) return;
  const expectedRevision = applicationRevision.current();
  if (expectedRevision === null) return;
  modalPending.value = true;
  try {
    const result = await desktopApi.configureApplication(
      expectedRevision,
      applicationForm.reflectionDailyCallLimit,
      applicationForm.minGapSeconds,
      applicationForm.backgroundDailyCallLimit,
      applicationForm.proactiveDailyMessageLimit,
      { dailyModelCallLimit: optionalDailyLimit(applicationForm.dailyModelCallLimit), dialogueDailyCallLimit: optionalDailyLimit(applicationForm.dialogueDailyCallLimit), keepRunningOnClose: applicationForm.keepRunningOnClose },
    );
    snapshot.value = { ...snapshot.value, application: result.application };
    closeApplication();
  } catch (error) { connectionError.value = messageOf(error); }
  finally { modalPending.value = false; }
}
/** 数字输入框空值为未设限，零明确禁止；无效值不能被JSON转换为null。 */
function optionalDailyLimit(value: number | string): number | null {
  if (value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > DAILY_BUDGET.modelCallMaximum) throw new Error(uiText("额度必须是有效的非负整数。"));
  return value;
}
async function quitApplication(): Promise<void> {
  if (modalPending.value) return;
  modalPending.value = true;
  try { await desktopApi.quitApplication(); }
  catch (error) { connectionError.value = messageOf(error); }
  finally { modalPending.value = false; }
}
async function restoreAgent(agent: AgentProfile): Promise<void> {
  try {
    await desktopApi.archiveAgent(agent.id, agent.profileRevision, false);
    showArchived.value = false;
    await loadSnapshot();
  } catch (error) { connectionError.value = messageOf(error); }
}
onMounted(async () => {
  compactLayout.addEventListener("change", onCompactLayout);
  window.addEventListener("pointerdown", recordActivity, { passive: true });
  window.addEventListener("keydown", recordActivity);
  snapshotTimer = setInterval(() => { void loadSnapshot(selectedAgentId.value, { background: true }); }, 2000);
  await Promise.all([loadSnapshot(), loadModelOptions()]);
});
onUnmounted(() => {
  compactLayout.removeEventListener("change", onCompactLayout);
  clearInterval(snapshotTimer);
  snapshotRequests.invalidate();
  modelRequests.invalidate();
  window.removeEventListener("pointerdown", recordActivity);
  window.removeEventListener("keydown", recordActivity);
});
</script>

<template>
  <div class="app-shell" :class="{ 'agent-rail-collapsed': railCollapsed }">
    <aside class="agent-rail">
      <div class="brand-row">
        <button type="button" class="brand-button" :aria-label="uiText(railCollapsed ? '展开 Agent 栏' : '收起 Agent 栏')" :title="uiText(railCollapsed ? '展开 Agent 栏' : '收起 Agent 栏')" @click="railCollapsed = !railCollapsed"><span class="brand-mark">A</span><strong>Asterhabit</strong></button>
        <button type="button" class="icon-button" :aria-label="uiText('创建 Agent')" :title="uiText('创建 Agent')" @click="openCreate">＋</button>
      </div>
      <div class="agent-list" :aria-label="uiText('Agent 列表')">
        <button v-for="agent in visibleAgents" :key="agent.id" type="button" class="agent-item" :class="{ active: agent.id === activeAgent?.id }" :aria-pressed="agent.id === activeAgent?.id" :title="agent.name" @click="switchAgent(agent.id)">
          <span class="agent-avatar-wrap"><span class="agent-avatar">{{ avatarText(agent) }}</span><span v-if="agent.unreadCount" class="unread-badge" :aria-label="uiText('{0} 条未读主动消息', agent.unreadCount)">{{ agent.unreadCount > 99 ? "99+" : agent.unreadCount }}</span></span><span class="agent-meta"><strong>{{ agent.name }}</strong><small>{{ agent.nickname || "Agent" }}</small></span><i v-if="agent.id === activeAgent?.id" aria-hidden="true" />
        </button>
      </div>
      <div class="rail-footer">
        <button type="button" :aria-label="uiText('应用设置')" :title="uiText('应用设置')" @click="openApplication"><span aria-hidden="true">⚙</span><span class="rail-label">{{ uiText("应用设置") }}</span></button>
        <button type="button" @click="toggleGlobalPause"><span>{{ snapshot?.application.paused ? "▶" : "Ⅱ" }}</span><span class="rail-label">{{ uiText(snapshot?.application.paused ? "恢复全部" : "暂停全部") }}</span></button>
        <button v-if="archivedAgents.length" type="button" @click="showArchived = true"><span>⌁</span><span class="rail-label">{{ uiText("已归档") }}</span></button>
        <small class="rail-label">{{ uiText('{0} 个 Agent', visibleAgents.length) }}</small>
      </div>
    </aside>
    <section class="main-shell">
      <header class="topbar">
        <button type="button" class="mobile-agent-button" :title="activeAgent?.name ?? 'Agent'" @click="railCollapsed = false"><span class="agent-avatar">{{ activeAgent ? avatarText(activeAgent) : "?" }}</span><span class="mobile-agent-name">{{ activeAgent?.name ?? "Agent" }}</span></button>
        <div class="breadcrumb"><strong>{{ activeAgent?.name ?? "Agent" }}</strong><span>/</span><span>{{ activePage === "model-services" ? modelText("title") : uiText(pages.find((page) => page.id === activePage)?.label ?? "") }}</span></div>
        <div class="runtime-actions">
          <label v-if="['chat', 'memory', 'growth'].includes(activePage)" class="contact-picker"><span>{{ uiText("联系人") }}</span><select v-model="selectedContactId" :disabled="switchingAgent || chatBusy || snapshot?.runtime.busy"><option v-for="contact in snapshot?.contacts ?? []" :key="contact.id" :value="contact.id">{{ contact.id === "owner" ? uiText("主人") : contact.label }}</option></select></label>
          <span class="availability" :class="{ paused: recoveryPending || snapshot?.application.paused || activeAgent?.paused }">{{ uiText(recoveryPending ? "需要清理" : snapshot?.application.paused || activeAgent?.paused ? "已暂停" : "可用") }}</span>
          <button v-if="recoveryPending" type="button" class="button quiet" @click="openRecovery">{{ uiText("前往清理") }}</button>
          <button type="button" class="button quiet" :disabled="!activeAgent || pausePending || switchingAgent" @click="toggleAgentPause">{{ uiText(activeAgent?.paused ? '恢复 {0}' : '暂停 {0}', activeAgent?.name ?? 'Agent') }}</button>
        </div>
      </header>
      <nav class="page-nav" :aria-label="uiText('Agent 页面')">
        <button v-for="page in pages" :key="page.id" type="button" :class="{ active: activePage === page.id }" :aria-current="activePage === page.id ? 'page' : undefined" @click="activePage = page.id">{{ uiText(page.label) }}</button>
      </nav>
      <main class="content" :inert="switchingAgent" :class="{ 'chat-content': activePage === 'chat' }">
        <section v-if="loading" class="state-block" aria-live="polite">{{ uiText("正在连接桌面服务…") }}</section>
        <section v-else-if="!snapshot || !activeAgent" class="state-block error-state" role="alert"><h1>{{ uiText("桌面连接不可用") }}</h1><p>{{ uiText(connectionError || "请在 Asterhabit 桌面应用中打开。") }}</p><button type="button" class="button primary" @click="loadSnapshot()">{{ uiText("重新连接") }}</button></section>
        <template v-else>
          <p v-if="connectionError" class="inline-error global-error" role="alert">{{ uiText(connectionError) }}</p>
          <p v-if="snapshot.modelAuthentication?.state === 'stopped' && snapshot.modelAuthentication.code" class="inline-error global-error" role="alert">{{ uiText("Codex 登录自动同步已停止：{0}", modelAuthenticationText(snapshot.modelAuthentication.code)) }}</p>
          <ChatPage v-show="activePage === 'chat'" :active="activePage === 'chat'" :agent="activeAgent" :contact="selectedContact" :runtime="{ ...snapshot.runtime, busy: snapshot.runtime.busy || chatBusy }" @busy-changed="chatBusy = $event; loadSnapshot()" @snapshot-changed="loadSnapshot(activeAgent.id)" />
          <MemoryPage v-if="activePage === 'memory'" :agent="activeAgent" :contact="selectedContact" />
          <MessagesPage v-else-if="activePage === 'messages'" :agent-id="activeAgent.id" />
          <GrowthPage v-else-if="activePage === 'growth'" :agent-id="activeAgent.id" :contact="selectedContact" />
          <PermissionsPage v-else-if="activePage === 'permissions'" :agent-id="activeAgent.id" :control="snapshot.control" :paused="snapshot.application.paused || activeAgent.paused" @snapshot-changed="loadSnapshot(activeAgent.id)" @open-settings="openPermissionSettings" />
          <ActivityPage v-else-if="activePage === 'activity'" :agent-id="activeAgent.id" :actions="snapshot.control.actions" @snapshot-changed="loadSnapshot(activeAgent.id)" />
          <KeepAlive><AgentSettingsPage v-if="activePage === 'settings'" :key="activeAgent.id" :agent="activeAgent" :navigation="settingsNavigation" @snapshot-changed="(!$event || $event === selectedAgentId) && loadSnapshot($event)" @manage-models="openModelServices" /></KeepAlive>
          <template v-if="activePage === 'model-services'"><button v-if="createDraftPending" type="button" class="button resume-create" @click="openCreate">{{ modelText('resumeCreate') }}</button><ModelConnectionsPage :agents="snapshot.agents" @changed="loadModelOptions" /></template>
        </template>
      </main>
    </section>

    <div v-if="showCreate" class="modal-backdrop" @click.self="closeCreate"><form class="modal create-modal" role="dialog" aria-modal="true" :aria-label="uiText('创建 Agent')" @submit.prevent="createAgent"><header><h2>{{ uiText("创建 Agent") }}</h2><button type="button" class="icon-button" :aria-label="uiText('关闭')" @click="closeCreate">×</button></header><div class="modal-body"><RoleTransferStart :disabled="modalPending" @apply="applyRoleTransfer" /><label><span>{{ uiText("名字") }}</span><input v-model="createForm.name" :maxlength="ROLE_FIELD_LIMITS.name" required autofocus /></label><label><span>{{ uiText("昵称 / 英文名") }}</span><input v-model="createForm.nickname" :maxlength="ROLE_FIELD_LIMITS.nickname" /></label><label><span>{{ uiText("基础人格") }}</span><textarea v-model="createForm.persona" rows="5" :maxlength="ROLE_FIELD_LIMITS.persona" /><small>{{ uiText("与角色设置一起用于后续生成；保存不会重写已有记忆。") }}</small></label><details class="settings-section role-options"><summary>{{ uiText("角色设置") }}</summary><AgentRoleFields v-model="createRoleForm" :disabled="modalPending" :show-heading="false" /></details><ModelBindingSelect v-model="createForm.dialogueModel" :connections="modelConnections" :models="models" :label="modelText('dialogue')" required @change="normalizeCreateDialogueEffort" @validity-change="createDialogueValid = $event" /><ModelBindingSelect v-model="createForm.model" :connections="modelConnections" :models="models" :label="modelText('extract')" required-effort="none" required @validity-change="createExtractValid = $event" /><button type="button" class="button quiet" @click="openModelServices">{{ modelText('manage') }}</button><label v-if="models.find((entry) => entry.handle === createForm.dialogueModel)?.reasoningEfforts.length"><span>{{ uiText("推理档位") }}</span><select v-model="createForm.dialogueReasoningEffort"><option v-for="effort in models.find((entry) => entry.handle === createForm.dialogueModel)?.reasoningEfforts ?? []" :key="effort" :value="effort">{{ effort }}</option></select></label><p v-if="connectionError" class="inline-error" role="alert">{{ uiText(connectionError) }}</p></div><footer><button type="button" class="button" @click="closeCreate">{{ uiText("取消") }}</button><button type="submit" class="button primary" :disabled="modalPending || !createForm.name.trim() || !createDialogueValid || !createExtractValid">{{ uiText(modalPending ? "创建中…" : "创建") }}</button></footer></form></div>
    <div v-if="showApplication" class="modal-backdrop" @click.self="closeApplication">
      <form class="modal application-modal" role="dialog" aria-modal="true" :aria-label="uiText('应用设置')" @submit.prevent="saveApplication">
        <header><h2>{{ uiText("应用设置") }}</h2><button type="button" class="icon-button" :aria-label="uiText('关闭')" @click="closeApplication">×</button></header>
        <div class="modal-body">
          <label><span>{{ uiText("界面语言") }}</span><select v-model="uiLocalePreference"><option value="system">{{ uiText("跟随系统") }}</option><option value="zh-CN">简体中文</option><option value="en">English</option></select><small>{{ permissionText("languageHelp") }}</small></label>
          <button type="button" class="button" @click="openModelServices">{{ modelText("title") }}</button>
          <label class="setting-row"><span>{{ uiText("关闭窗口后后台继续运行") }}</span><input v-model="applicationForm.keepRunningOnClose" type="checkbox" /></label>
          <label><span>{{ uiText("24 小时模型阶段总额度") }}</span><input v-model.number="applicationForm.dailyModelCallLimit" type="number" min="0" :max="DAILY_BUDGET.modelCallMaximum" /><small>{{ uiText("留空不设限，0 禁止。聊天与后台生成共用，按业务阶段计数。") }}</small></label>
          <label><span>{{ uiText("24 小时聊天阶段子额度") }}</span><input v-model.number="applicationForm.dialogueDailyCallLimit" type="number" min="0" :max="DAILY_BUDGET.modelCallMaximum" /><small>{{ uiText("回答与学习提取分别计数，留空不设限。") }}</small></label>
          <label><span>{{ uiText("24 小时后台调用总额度") }}</span><input v-model.number="applicationForm.backgroundDailyCallLimit" type="number" min="0" :max="DAILY_BUDGET.modelCallMaximum" required /><small>{{ permissionText("backgroundHelp") }}</small></label>
          <label><span>{{ uiText("24 小时主动消息总额度") }}</span><input v-model.number="applicationForm.proactiveDailyMessageLimit" type="number" min="0" :max="DAILY_BUDGET.messageMaximum" required /><small>{{ permissionText("messageHelp") }}</small></label>
          <label><span>{{ uiText("24 小时反思子额度") }}</span><input v-model.number="applicationForm.reflectionDailyCallLimit" type="number" min="0" :max="DAILY_BUDGET.modelCallMaximum" required /><small>{{ permissionText("reflectionHelp") }}</small></label>
          <label><span>{{ uiText("反思最小间隔（秒）") }}</span><input v-model.number="applicationForm.minGapSeconds" type="number" min="1800" max="86400" step="60" required /><small>{{ permissionText("gapHelp") }}</small></label>
          <div v-if="snapshot?.application.budgets" class="budget-summary" aria-live="polite">
            <p>{{ uiText("模型阶段已用") }}：{{ snapshot.application.budgets.total.used }} / {{ snapshot.application.budgets.total.limit ?? uiText("未设限") }}</p>
            <p>{{ uiText("聊天阶段已用") }}：{{ snapshot.application.budgets.dialogue.used }} / {{ snapshot.application.budgets.dialogue.limit ?? uiText("未设限") }}</p>
            <p>{{ uiText("后台阶段已用") }}：{{ snapshot.application.budgets.background.used }} / {{ snapshot.application.budgets.background.limit }}</p>
            <template v-for="(budget, name) in snapshot.application.budgets" :key="name"><p v-if="budget.limit !== null && budget.remaining === 0">{{ uiText(name === 'total' ? '应用总额度' : name === 'dialogue' ? '聊天子额度' : name === 'background' ? '后台子额度' : name === 'reflection' ? '反思子额度' : '主动消息额度') }}：{{ budget.limit === 0 ? uiText('已关闭') : uiText('额度已用完') }}<template v-if="budget.nextAvailableAt"> · {{ uiText('下次可用') }} {{ new Date(budget.nextAvailableAt).toLocaleString() }}</template></p></template>
          </div>
          <p v-if="connectionError" class="inline-error" role="alert">{{ uiText(connectionError) }}</p>
        </div>
        <footer><button type="button" class="button" :disabled="modalPending" @click="quitApplication">{{ uiText("完全退出") }}</button><button type="button" class="button" @click="closeApplication">{{ uiText("取消") }}</button><button type="submit" class="button primary" :disabled="modalPending">{{ uiText("保存") }}</button></footer>
      </form>
    </div>
    <div v-if="showArchived" class="modal-backdrop" @click.self="showArchived = false"><section class="modal"><header><h2>{{ uiText("已归档 Agent") }}</h2><button type="button" class="icon-button" :aria-label="uiText('关闭')" @click="showArchived = false">×</button></header><p v-if="!archivedAgents.length" class="empty-state">{{ uiText("没有已归档 Agent。") }}</p><div class="archived-list"><div v-for="agent in archivedAgents" :key="agent.id"><span class="agent-avatar">{{ avatarText(agent) }}</span><strong>{{ agent.name }}</strong><button type="button" class="button" @click="restoreAgent(agent)">{{ uiText("恢复") }}</button></div></div></section></div>
  </div>
</template>
