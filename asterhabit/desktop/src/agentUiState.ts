export interface AgentDraft {
  text: string;
  learn: boolean;
}

export interface AgentRequestToken {
  key: string;
  generation: number;
}

function scopeKey(agentId: string, contactId: string): string {
  return `${agentId}\u0000${contactId}`;
}

/** 保存跨页面的本地草稿，并阻止已切换身份后的迟到请求更新当前视图。 */
export function createAgentUiState(): {
  activate: (agentId: string, contactId: string) => void;
  saveDraft: (agentId: string, contactId: string, text: string, learn: boolean) => void;
  draft: (agentId: string, contactId: string) => AgentDraft;
  beginRequest: (agentId: string, contactId: string) => AgentRequestToken;
  isCurrent: (request: AgentRequestToken) => boolean;
  invalidate: () => void;
} {
  const drafts = new Map<string, AgentDraft>();
  let activeKey = "";
  let generation = 0;

  return {
    activate(agentId, contactId) {
      activeKey = scopeKey(agentId, contactId);
      generation += 1;
    },
    saveDraft(agentId, contactId, text, learn) {
      drafts.set(scopeKey(agentId, contactId), { text, learn });
    },
    draft(agentId, contactId) {
      return drafts.get(scopeKey(agentId, contactId)) ?? { text: "", learn: false };
    },
    beginRequest(agentId, contactId) {
      activeKey = scopeKey(agentId, contactId);
      generation += 1;
      return { key: activeKey, generation };
    },
    isCurrent(request) {
      return request.key === activeKey && request.generation === generation;
    },
    invalidate() {
      generation += 1;
    },
  };
}
