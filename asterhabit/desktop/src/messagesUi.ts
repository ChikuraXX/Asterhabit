import type { QQDraft, QQMessageEntry, QQSendRecord } from "./api";

/** 一个已接入平台中的稳定会话身份；不包含未读等无可靠来源的状态。 */
export interface MessageConversation {
  key: string;
  platform: "qq";
  agentId: string;
  accountId: string;
  kind: "private" | "group";
  targetId: string;
  lastActivityAt: number;
}

/** 消息流中的可见事件；草稿与发送记录分开，避免把结果未知误写成未发送。 */
export type MessageTimelineItem =
  | { kind: "received"; at: number; id: string; entry: QQMessageEntry }
  | { kind: "draft"; at: number; id: string; draft: QQDraft }
  | { kind: "sent"; at: number; id: string; record: QQSendRecord };

/** 会话键包含Agent、平台、绑定账号和平台目标，避免切换身份后错误合并。 */
export function messageConversationKey(
  agentId: string,
  accountId: string,
  kind: "private" | "group",
  targetId: string,
): string {
  return [agentId, "qq", accountId, kind, targetId].join("\0");
}

/** 从平台收件提取会话目标；缺失群OpenID时拒绝构造不稳定会话。 */
function entryTarget(entry: QQMessageEntry): { kind: "private" | "group"; id: string } | null {
  if (entry.kind === "private") return { kind: "private", id: entry.senderId };
  return entry.groupId ? { kind: "group", id: entry.groupId } : null;
}

/** 从短期收件、未发送草稿和本地发送记录投影当前可见会话。 */
export function buildMessageConversations(input: {
  agentId: string;
  accountId: string;
  entries: QQMessageEntry[];
  drafts: QQDraft[];
  records: QQSendRecord[];
}): MessageConversation[] {
  const conversations = new Map<string, MessageConversation>();
  const upsert = (kind: "private" | "group", targetId: string, at: number) => {
    const key = messageConversationKey(input.agentId, input.accountId, kind, targetId);
    const previous = conversations.get(key);
    conversations.set(key, {
      key,
      platform: "qq",
      agentId: input.agentId,
      accountId: input.accountId,
      kind,
      targetId,
      lastActivityAt: Math.max(previous?.lastActivityAt ?? 0, at),
    });
  };
  for (const entry of input.entries) {
    const target = entryTarget(entry);
    if (target) upsert(target.kind, target.id, entry.receivedAt);
  }
  for (const draft of input.drafts) {
    if (!["cancelled", "expired", "sent"].includes(draft.status)) upsert(draft.target.kind, draft.target.id, draft.createdAt);
  }
  for (const record of input.records) {
    const latest = record.attempts.at(-1);
    upsert(record.target.kind, record.target.id, latest?.submittedAt ?? latest?.createdAt ?? record.createdAt);
  }
  return [...conversations.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.key.localeCompare(right.key));
}

/** 合并收件、明确标记的未发送草稿和发送记录，并保持稳定时间顺序。 */
export function buildMessageTimeline(input: {
  conversation: MessageConversation;
  entries: QQMessageEntry[];
  drafts: QQDraft[];
  records: QQSendRecord[];
}): MessageTimelineItem[] {
  const { conversation } = input;
  const matchesTarget = (kind: "private" | "group", id: string) => kind === conversation.kind && id === conversation.targetId;
  const received: MessageTimelineItem[] = input.entries.flatMap((entry) => {
    const target = entryTarget(entry);
    return target && matchesTarget(target.kind, target.id)
      ? [{ kind: "received" as const, at: entry.receivedAt, id: `received:${entry.id}`, entry }]
      : [];
  });
  const drafts: MessageTimelineItem[] = input.drafts
    // unknown/sending 已进入发送尝试语义；只把尚未提交或明确失败可重审的正文标为“未发送草稿”。
    .filter((draft) => matchesTarget(draft.target.kind, draft.target.id) && ["ready", "failed"].includes(draft.status))
    .map((draft) => ({ kind: "draft" as const, at: draft.createdAt, id: `draft:${draft.id}`, draft }));
  const sent: MessageTimelineItem[] = input.records
    .filter((record) => matchesTarget(record.target.kind, record.target.id))
    .map((record) => {
      const latest = record.attempts.at(-1);
      return { kind: "sent" as const, at: latest?.submittedAt ?? latest?.createdAt ?? record.createdAt, id: `sent:${record.id}`, record };
    });
  return [...received, ...drafts, ...sent].sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
}
