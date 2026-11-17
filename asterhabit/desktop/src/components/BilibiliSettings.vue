<script setup lang="ts">
import { DAILY_BUDGET } from "../api";
import { computed, onUnmounted, ref, watch } from "vue";

import {
  desktopApi,
  type BilibiliAccountStatus,
  type BilibiliVerifyResult,
  type ContentSettings,
} from "../api";
import { createLatestRequestGuard } from "../requestGuard";
import { uiText } from "../i18n";
import ObservationsPanel from "./ObservationsPanel.vue";

const props = defineProps<{ agentId: string }>();
const accountStatus = ref<BilibiliAccountStatus | null>(null);
const content = ref<ContentSettings | null>(null);
const contentAvailable = ref(false);
const sessdata = ref("");
const buvid3 = ref("");
const keywordsText = ref("");
const creatorIdsText = ref("");
const bvid = ref("");
const verification = ref<BilibiliVerifyResult | null>(null);
const accountLoading = ref(false);
const contentLoading = ref(false);
const binding = ref(false);
const unbinding = ref(false);
const saving = ref(false);
const verifying = ref(false);
const accountError = ref("");
const contentError = ref("");
const verifyError = ref("");
const saved = ref("");

const accountRequests = createLatestRequestGuard<string>();
const contentRequests = createLatestRequestGuard<string>();
const bindRequests = createLatestRequestGuard<string>();
const unbindRequests = createLatestRequestGuard<string>();
const saveRequests = createLatestRequestGuard<string>();
const verifyRequests = createLatestRequestGuard<string>();
const bvidPattern = /^BV[A-Za-z0-9]{10}$/u;

const accountUid = computed(() => accountStatus.value?.account?.id.replace(/^bilibili:/u, "") ?? "");
const verifyDisabledReason = computed(() => {
  if (!accountStatus.value?.account) return uiText("请先绑定 BiliBili 账号");
  if (!content.value?.readEnabled) return uiText("请先开启内容读取");
  if (accountStatus.value.network.remaining < 4) return uiText("剩余网络请求不足 4 次");
  if (accountStatus.value.network.blockedUntil !== null && accountStatus.value.network.blockedUntil > Date.now()) return uiText("平台暂时限制请求");
  if (!bvidPattern.test(bvid.value.trim())) return uiText("请输入有效的 BV 号");
  return "";
});

function messageOf(value: unknown): string {
  return uiText(value instanceof Error ? value.message : String(value));
}
function splitList(value: string): string[] {
  return value.split(/[，,\n]/u).map((item) => item.trim()).filter(Boolean);
}
function applyContentSettings(settings: ContentSettings): void {
  content.value = settings;
  keywordsText.value = settings.keywords.join("\n");
  creatorIdsText.value = settings.creatorIds.join("\n");
}
function clearSecrets(): void {
  sessdata.value = "";
  buvid3.value = "";
}
function invalidateRequests(): void {
  accountRequests.invalidate();
  contentRequests.invalidate();
  bindRequests.invalidate();
  unbindRequests.invalidate();
  saveRequests.invalidate();
  verifyRequests.invalidate();
}

async function loadAccount(agentId: string): Promise<void> {
  const request = accountRequests.begin(agentId);
  accountLoading.value = true;
  accountError.value = "";
  try {
    const result = await desktopApi.getBilibiliAccount(agentId);
    if (!accountRequests.isCurrent(request, props.agentId)) return;
    accountStatus.value = result;
  } catch (reason) {
    if (accountRequests.isCurrent(request, props.agentId)) accountError.value = messageOf(reason);
  } finally {
    if (accountRequests.isCurrent(request, props.agentId)) accountLoading.value = false;
  }
}

async function loadContent(agentId: string): Promise<void> {
  const request = contentRequests.begin(agentId);
  contentLoading.value = true;
  contentError.value = "";
  try {
    const result = await desktopApi.getContentSettings(agentId);
    if (!contentRequests.isCurrent(request, props.agentId)) return;
    contentAvailable.value = result.available;
    applyContentSettings(result.settings);
  } catch (reason) {
    if (contentRequests.isCurrent(request, props.agentId)) contentError.value = messageOf(reason);
  } finally {
    if (contentRequests.isCurrent(request, props.agentId)) contentLoading.value = false;
  }
}

async function bindAccount(): Promise<void> {
  const status = accountStatus.value;
  if (!status || status.storage !== "windows-user" || !sessdata.value || binding.value) return;
  const agentId = props.agentId;
  const request = bindRequests.begin(agentId);
  binding.value = true;
  accountError.value = "";
  saved.value = "";
  const credentials = { sessdata: sessdata.value, buvid3: buvid3.value };
  try {
    const result = await desktopApi.bindBilibiliAccount({
      agentId,
      expectedRevision: status.revision,
      ...credentials,
    });
    if (!bindRequests.isCurrent(request, props.agentId)) return;
    accountStatus.value = result;
    verification.value = null;
    saved.value = uiText("账号已绑定，内容读取保持关闭");
    await loadContent(agentId);
  } catch (reason) {
    if (bindRequests.isCurrent(request, props.agentId)) accountError.value = messageOf(reason);
  } finally {
    // 切换 Agent 时 watcher 已清除旧秘密；迟到的旧请求不能擦除新 Agent 正在输入的凭据。
    if (bindRequests.isCurrent(request, props.agentId)) {
      clearSecrets();
      binding.value = false;
    }
  }
}

async function unbindAccount(): Promise<void> {
  const status = accountStatus.value;
  if (!status?.account || unbinding.value) return;
  const agentId = props.agentId;
  const request = unbindRequests.begin(agentId);
  unbinding.value = true;
  accountError.value = "";
  saved.value = "";
  try {
    const result = await desktopApi.unbindBilibiliAccount(agentId, status.revision);
    if (!unbindRequests.isCurrent(request, props.agentId)) return;
    accountStatus.value = result;
    verification.value = null;
    bvid.value = "";
    saved.value = uiText("账号已解绑");
    await loadContent(agentId);
  } catch (reason) {
    if (unbindRequests.isCurrent(request, props.agentId)) accountError.value = messageOf(reason);
  } finally {
    if (unbindRequests.isCurrent(request, props.agentId)) unbinding.value = false;
  }
}

async function saveContent(): Promise<void> {
  const settings = content.value;
  if (!settings || saving.value) return;
  const agentId = props.agentId;
  const request = saveRequests.begin(agentId);
  saving.value = true;
  contentError.value = "";
  saved.value = "";
  try {
    const result = await desktopApi.configureContentSettings({
      agentId,
      expectedRevision: settings.revision,
      readEnabled: settings.readEnabled,
      allowLearning: settings.allowLearning,
      publishEnabled: false,
      keywords: splitList(keywordsText.value),
      creatorIds: splitList(creatorIdsText.value),
      dailyReadLimit: settings.dailyReadLimit,
      dailyModelLimit: settings.dailyModelLimit,
      dailySessionLimit: settings.dailySessionLimit,
      minGapSeconds: settings.minGapSeconds,
      idleSeconds: settings.idleSeconds,
    });
    if (!saveRequests.isCurrent(request, props.agentId)) return;
    contentAvailable.value = result.available;
    applyContentSettings(result.settings);
    verification.value = null;
    saved.value = uiText("内容设置已保存");
  } catch (reason) {
    if (saveRequests.isCurrent(request, props.agentId)) contentError.value = messageOf(reason);
  } finally {
    if (saveRequests.isCurrent(request, props.agentId)) saving.value = false;
  }
}

async function verifyVideo(): Promise<void> {
  const status = accountStatus.value;
  if (!status || verifyDisabledReason.value || verifying.value) return;
  const agentId = props.agentId;
  const request = verifyRequests.begin(agentId);
  verifying.value = true;
  verifyError.value = "";
  verification.value = null;
  try {
    const result = await desktopApi.verifyBilibiliVideo(agentId, status.revision, bvid.value.trim());
    if (!verifyRequests.isCurrent(request, props.agentId)) return;
    verification.value = result;
    await loadAccount(agentId);
  } catch (reason) {
    if (verifyRequests.isCurrent(request, props.agentId)) {
      verifyError.value = messageOf(reason);
      await loadAccount(agentId);
    }
  } finally {
    if (verifyRequests.isCurrent(request, props.agentId)) verifying.value = false;
  }
}

watch(() => props.agentId, (agentId) => {
  invalidateRequests();
  clearSecrets();
  accountStatus.value = null;
  content.value = null;
  contentAvailable.value = false;
  keywordsText.value = "";
  creatorIdsText.value = "";
  bvid.value = "";
  verification.value = null;
  accountError.value = "";
  contentError.value = "";
  verifyError.value = "";
  saved.value = "";
  accountLoading.value = false;
  contentLoading.value = false;
  binding.value = false;
  unbinding.value = false;
  saving.value = false;
  verifying.value = false;
  void loadAccount(agentId);
  void loadContent(agentId);
}, { immediate: true, flush: "sync" });

onUnmounted(() => {
  invalidateRequests();
  clearSecrets();
});
</script>

<template>
  <div class="settings-form bilibili-settings">
    <section class="settings-section bilibili-account-section">
      <h2>{{ uiText("本地账号") }}</h2>
      <p v-if="accountLoading" class="status-line">{{ uiText("正在读取账号…") }}</p>
      <p v-if="accountError" class="inline-error" role="alert">{{ uiText(accountError) }}</p>
      <template v-if="accountStatus">
        <div v-if="accountStatus.account" class="bilibili-account-row">
          <span><strong>{{ accountStatus.account.label }}</strong><small>UID {{ accountUid }}</small></span>
          <button type="button" class="button danger-text" :disabled="unbinding" @click="unbindAccount">{{ uiText(unbinding ? "解绑中…" : "解绑") }}</button>
        </div>
        <form v-else class="bilibili-credentials" @submit.prevent="bindAccount">
          <div class="field-grid">
            <label><span>SESSDATA</span><input v-model="sessdata" name="sessdata" type="password" autocomplete="new-password" maxlength="4096" required /></label>
            <label><span>{{ uiText("buvid3（可选）") }}</span><input v-model="buvid3" name="buvid3" type="password" autocomplete="new-password" maxlength="256" /></label>
          </div>
          <p v-if="accountStatus.storage === 'unavailable'" class="inline-error">{{ uiText("当前系统不支持安全凭据存储") }}</p>
          <div class="button-row bilibili-button-row">
            <button type="submit" class="button primary" :disabled="binding || !sessdata || accountStatus.storage !== 'windows-user'">{{ uiText(binding ? "验证中…" : "绑定并验证") }}</button>
          </div>
        </form>
        <p class="form-hint">{{ uiText("网络额度：{0}/{1}，剩余 {2}", accountStatus.network.used, accountStatus.network.limit, accountStatus.network.remaining) }}</p>
        <p class="form-hint">{{ uiText("账号网络额度按实际平台请求计数，与下方读取、模型和会话业务额度分开。") }}</p>
      </template>
    </section>

    <form v-if="content" @submit.prevent="saveContent">
      <section class="settings-section">
        <h2>{{ uiText("内容读取") }}</h2>
        <label class="setting-row toggle-row"><span><strong>{{ uiText("读取 BiliBili 内容") }}</strong><small>{{ uiText("保存后仅在空闲且满足范围、间隔和额度时读取；关闭会阻止新读取。") }}</small></span><input v-model="content.readEnabled" name="readEnabled" type="checkbox" role="switch" :disabled="!accountStatus?.account" /></label>
        <label class="setting-row toggle-row"><span><strong>{{ uiText("浏览学习") }}</strong><small>{{ uiText("只控制观察是否成为此 Agent 的成长来源；角色成长也必须开启。") }}</small></span><input v-model="content.allowLearning" type="checkbox" role="switch" /></label>
        <div class="setting-row"><span><strong>{{ uiText("发布") }}</strong><small>{{ uiText("平台发布能力尚未接入，当前始终关闭。") }}</small></span><span class="subtle-status">{{ uiText("关闭") }}</span></div>
        <label class="bilibili-list-field"><span>{{ uiText("关键词") }}</span><small class="form-hint">{{ uiText("用于发现候选内容；关键词和 UP 主 UID 至少填写一项。") }}</small><textarea v-model="keywordsText" name="keywords" rows="3" maxlength="2019" :placeholder="uiText('每行一个关键词')" /></label>
        <label class="bilibili-list-field"><span>{{ uiText("UP 主 UID") }}</span><small class="form-hint">{{ uiText("填写后仅接受这些作者的候选内容。") }}</small><textarea v-model="creatorIdsText" name="creatorIds" rows="3" maxlength="4019" :placeholder="uiText('每行一个 UID')" /></label>
      </section>
      <section class="settings-section">
        <h2>{{ uiText("读取节奏") }}</h2>
        <label class="setting-row"><span><strong>{{ uiText("滚动 24 小时读取阶段上限") }}</strong><small>{{ uiText("发现和观察各按一个业务阶段计数，不等于账号实际网络请求次数。") }}</small></span><input v-model.number="content.dailyReadLimit" type="number" min="0" :max="DAILY_BUDGET.readMaximum" required /></label>
        <label class="setting-row"><span><strong>{{ uiText("滚动 24 小时模型阶段上限") }}</strong><small>{{ uiText("选择和解读各按一个业务阶段计数，不等于实际 provider 请求次数。") }}</small></span><input v-model.number="content.dailyModelLimit" type="number" min="0" :max="DAILY_BUDGET.modelCallMaximum" required /></label>
        <label class="setting-row"><span><strong>{{ uiText("滚动 24 小时浏览会话上限") }}</strong><small>{{ uiText("每次完整浏览流程计一个会话。") }}</small></span><input v-model.number="content.dailySessionLimit" type="number" min="0" :max="DAILY_BUDGET.sessionMaximum" required /></label>
        <label class="setting-row"><span><strong>{{ uiText("最小间隔") }}</strong><small>{{ uiText("两次浏览会话之间的最短秒数。") }}</small></span><input v-model.number="content.minGapSeconds" type="number" min="300" max="86400" step="60" required /></label>
        <label class="setting-row"><span><strong>{{ uiText("空闲时长") }}</strong><small>{{ uiText("应用最后活动后需空闲的秒数；保存后用于后续调度。") }}</small></span><input v-model.number="content.idleSeconds" type="number" min="300" max="3600" step="60" required /></label>
      </section>
      <p v-if="contentLoading" class="status-line">{{ uiText("正在读取内容设置…") }}</p>
      <p v-if="contentError" class="inline-error" role="alert">{{ uiText(contentError) }}</p>
      <footer class="settings-footer"><span role="status">{{ uiText(saved) }}</span><button type="submit" class="button primary" :disabled="saving">{{ uiText(saving ? "保存中…" : "保存内容设置") }}</button></footer>
    </form>
    <p v-else-if="contentLoading" class="status-line">{{ uiText("正在读取内容设置…") }}</p>
    <p v-else-if="contentError" class="inline-error" role="alert">{{ uiText(contentError) }}</p>

    <section class="settings-section bilibili-verify-section">
      <h2>{{ uiText("读取验证") }}</h2>
      <p class="form-hint">{{ uiText("最多4个请求，不调用模型、不学习") }}</p>
      <form class="bilibili-verify-form" @submit.prevent="verifyVideo">
        <label><span>{{ uiText("BV 号") }}</span><input v-model="bvid" name="bvid" maxlength="12" placeholder="BV1234567890" /></label>
        <button type="submit" class="button" :disabled="Boolean(verifyDisabledReason) || verifying">{{ uiText(verifying ? "验证中…" : "只读验证") }}</button>
      </form>
      <p v-if="verifyDisabledReason" class="form-hint">{{ uiText(verifyDisabledReason) }}</p>
      <p v-if="verifyError" class="inline-error" role="alert">{{ uiText(verifyError) }}</p>
      <div v-if="verification" class="bilibili-verification" aria-live="polite">
        <h3>{{ verification.title }}</h3>
        <p>{{ uiText("{0} · UID {1} · {2} 秒", verification.creatorName, verification.creatorId, verification.durationSeconds) }}</p>
        <p>{{ uiText("实际覆盖：简介 {0} · 字幕 {1} · 评论 {2}；使用 {3} 次请求", verification.coverage.description, verification.coverage.subtitle, verification.coverage.comment, verification.requestsUsed) }}</p>
        <article v-for="material in verification.materials" :key="material.id">
          <strong>{{ uiText(material.kind === "description" ? "简介" : "字幕") }}</strong>
          <span v-if="material.startSeconds !== undefined">{{ uiText("{0}–{1} 秒", material.startSeconds, material.endSeconds) }}</span>
          <p>{{ material.text }}</p>
        </article>
      </div>
    </section>
    <ObservationsPanel :agent-id="agentId" />
  </div>
</template>
