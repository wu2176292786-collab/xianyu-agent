import type { AppState, RuleKind } from "@/lib/domain/types";
import { actionKey, proposeActions, type Proposal } from "@/lib/agent/engine";

export interface SurveyItem {
  id: string;
  key: string;
  ruleKind: RuleKind;
  title: string;
  reason: string;
  risk: Proposal["risk"];
  forceApproval?: boolean;
}

export interface ShopSurvey {
  items: SurveyItem[];
  proposals: Proposal[];
}

/** 规则先算出候选，pi-agent 只能从这里面挑，不能自己发明动作。 */
export function surveyShop(state: AppState, now: number): ShopSurvey {
  const proposals = proposeActions(state, now);
  return {
    proposals,
    items: proposals.map((proposal, index) => ({
      id: `P${index + 1}`,
      key: actionKey(proposal.payload),
      ruleKind: proposal.ruleKind,
      title: proposal.title,
      reason: proposal.reason,
      risk: proposal.risk,
      forceApproval: proposal.forceApproval,
    })),
  };
}

export function pickSurveyProposals(survey: ShopSurvey, ids: string[]): Proposal[] {
  const byId = new Map(
    survey.items.map((item, index) => [item.id, survey.proposals[index]]),
  );
  const byKey = new Map(
    survey.items.map((item, index) => [item.key, survey.proposals[index]]),
  );
  const picked: Proposal[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const proposal = byId.get(id) ?? byKey.get(id);
    if (!proposal) continue;
    const key = actionKey(proposal.payload);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(proposal);
  }
  return picked;
}
