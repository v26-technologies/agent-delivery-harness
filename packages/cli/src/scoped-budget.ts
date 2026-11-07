/** The declared pre-merge budget, enforced where a selection enters the runner, before any check starts. */
import { scopedBudgetOffenders, type HarnessConfig } from "@agent-delivery-harness/kernel";
import { CheckSnapshotError } from "./check-snapshot.ts";

/**
 * Refuses a selection whose scoped checks declare more than `scopedExecution.budgetMs` in total, or any one
 * of which declares more than `scopedExecution.checkBudgetMs`. The refusal names only the offending checks:
 * those over the cap, and those that push the running total past the budget in declaration order.
 */
export function refuseOverBudget(config: Pick<HarnessConfig, "providers" | "scopedExecution">): void {
  const { overCap, overBudget, totalMs } = scopedBudgetOffenders(config);
  if (overCap.length === 0 && overBudget.length === 0) return;
  const { budgetMs, checkBudgetMs } = config.scopedExecution!;
  const timeout = (id: string) => config.providers.find(p => p.id === id)!.check!.timeoutMs;
  const reasons = [
    ...overCap.map(id => `${id} declares timeoutMs ${timeout(id)} over checkBudgetMs ${checkBudgetMs}`),
    ...(overBudget.length ? [`${overBudget.join(", ")} ${overBudget.length === 1 ? "pushes" : "push"} the declared total to ${totalMs}ms over budgetMs ${budgetMs}`] : []),
  ];
  throw new CheckSnapshotError("scoped_budget_exceeded", `The scoped check selection exceeds its declared budget, so no check ran: ${reasons.join("; ")}.`);
}
