/** 主动计划的宿主状态；界面只允许取消仍可执行的计划。 */
const planStatusLabels: Record<string, string> = {
  pending: "待执行",
  claimed: "处理中",
  sent: "已发送",
  skipped: "已跳过",
  cancelled: "已取消",
  expired: "已过期",
  withdrawn: "已撤回",
};

/** 将主动计划状态转换为主人可读的稳定文案。 */
export function proactivePlanStatusLabel(status: string): string {
  return planStatusLabels[status] ?? status;
}

/** 仅尚未终结的待处理计划允许主人取消。 */
export function canCancelProactivePlanStatus(status: string): boolean {
  return status === "pending" || status === "claimed";
}

interface InboxState {
  status: string;
  readAt: number | null;
}

/** 只有已投递且未读的主动消息可以确认已读。 */
export function canReadProactiveInbox(entry: InboxState): boolean {
  return entry.status === "delivered" && entry.readAt === null;
}

/** 区分已撤回、未读和已读消息，避免把撤回内容当作待确认消息。 */
export function proactiveInboxStatusLabel(entry: InboxState): string {
  if (entry.status === "withdrawn") return "已撤回";
  if (entry.status === "read") return "已读";
  if (entry.status !== "delivered") return entry.status;
  return entry.readAt === null ? "未读" : "已读";
}

/** 追加游标页并按稳定业务标识去重；新页覆盖同标识的旧快照。 */
export function appendUniqueById<Entry extends { id: string }>(current: Entry[], incoming: Entry[]): Entry[] {
  const entries = new Map(current.map((entry) => [entry.id, entry]));
  incoming.forEach((entry) => entries.set(entry.id, entry));
  return [...entries.values()];
}

interface ReadGateInput {
  active: boolean;
  contactId: string;
  documentVisible: boolean;
  focused: boolean;
}

/** 自动已读必须同时满足聊天激活、主人会话、文档可见和窗口聚焦。 */
export function canMarkProactiveRead(input: ReadGateInput): boolean {
  return input.active
    && input.contactId === "owner"
    && input.documentVisible
    && input.focused;
}

export interface ProactiveReadAttempt {
  scope: string;
  generation: number;
  ids: string[];
}

interface ReadScopeState {
  generation: number;
  inFlight: boolean;
  settled: Set<string>;
}

/**
 * 以 scope 和代次隔离已读请求；旧 scope 的完成或 finally 不能修改新 scope 状态。
 * 每次尝试成功或失败均结算全部标识，避免错误重渲染或空 readIds 触发自动重试。
 * 主人重新激活聊天或切换 scope 时开启新代次，允许再次确认。
 */
export function createProactiveReadCoordinator(): {
  activate: (scope: string) => number;
  begin: (scope: string, ids: string[]) => ProactiveReadAttempt | null;
  complete: (attempt: ProactiveReadAttempt) => boolean;
  fail: (attempt: ProactiveReadAttempt) => boolean;
  isInFlight: (scope: string) => boolean;
} {
  let activeScope = "";
  let generation = 0;
  const states = new Map<string, ReadScopeState>();

  function matchingState(attempt: ProactiveReadAttempt): ReadScopeState | null {
    const state = states.get(attempt.scope);
    return state?.generation === attempt.generation ? state : null;
  }

  return {
    activate(scope) {
      activeScope = scope;
      generation += 1;
      states.set(scope, { generation, inFlight: false, settled: new Set() });
      return generation;
    },
    begin(scope, ids) {
      if (scope !== activeScope) return null;
      const state = states.get(scope);
      if (!state || state.inFlight) return null;
      const unreadIds = [...new Set(ids)].filter((id) => !state.settled.has(id));
      if (unreadIds.length === 0) return null;
      state.inFlight = true;
      return { scope, generation: state.generation, ids: unreadIds };
    },
    complete(attempt) {
      const state = matchingState(attempt);
      if (!state) return false;
      attempt.ids.forEach((id) => state.settled.add(id));
      state.inFlight = false;
      return activeScope === attempt.scope;
    },
    fail(attempt) {
      const state = matchingState(attempt);
      if (!state) return false;
      attempt.ids.forEach((id) => state.settled.add(id));
      state.inFlight = false;
      return activeScope === attempt.scope;
    },
    isInFlight(scope) {
      return states.get(scope)?.inFlight ?? false;
    },
  };
}
