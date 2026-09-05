/**
 * LifecycleCaseReconciler — bridges the webhook pipeline to the execution
 * ledger. When a signature-verified `payment.captured` webhook proves a payment
 * was collected, it credits recovered revenue to the RecoveryCase and its action
 * and writes a `recovery.recovered` audit event.
 *
 * It credits ONLY on a genuine CAPTURED transition, is idempotent (a case
 * already RECOVERED is never re-credited, so duplicate/out-of-order webhooks are
 * safe), and never infers success from anything but the reconciled payment fact.
 */
import type { InMemoryExecutionStore, Clock } from "@recoveros/execution";
import type { CaseReconciler, PaymentRecord as WebhookPaymentRecord } from "@recoveros/webhooks";

export interface RecoveredEntry {
  caseId: string;
  actionId: string | null;
  amountMinor: number;
  evidence: string;
}

export class LifecycleCaseReconciler implements CaseReconciler {
  readonly recovered: RecoveredEntry[] = [];

  constructor(
    private readonly execStore: InMemoryExecutionStore,
    private readonly paymentToCase: Map<string, string>,
    private readonly clock: Clock,
  ) {}

  async onPaymentReconciled(input: {
    tenantId: string;
    payment: WebhookPaymentRecord;
    previousStatus: string | null;
    eventType: string;
  }): Promise<void> {
    const capturedNow = input.payment.status === "CAPTURED" && input.previousStatus !== "CAPTURED";
    if (!capturedNow) return;

    const caseId = this.paymentToCase.get(input.payment.razorpayPaymentId);
    if (!caseId) return;

    const ctx = { tenantId: input.tenantId };
    const c = await this.execStore.getCase(ctx, caseId);
    if (!c || c.status === "RECOVERED") return; // idempotent: already credited

    const action = this.execStore.actions.find(
      (a) => a.tenantId === input.tenantId && a.caseId === caseId && a.state === "SUCCEEDED",
    );

    await this.execStore.updateCase(ctx, caseId, { status: "RECOVERED", resolvedAt: this.clock.now() });
    if (action && (action.recoveredAmountMinor ?? 0) === 0) {
      await this.execStore.updateAction(ctx, action.id, {
        recoveredAmountMinor: input.payment.amountMinor,
        updatedAt: this.clock.now(),
      });
    }

    this.recovered.push({
      caseId,
      actionId: action?.id ?? null,
      amountMinor: input.payment.amountMinor,
      evidence: input.payment.razorpayPaymentId,
    });

    await this.execStore.appendAudit(ctx, {
      actorType: "SYSTEM",
      action: "recovery.recovered",
      entityType: "RecoveryCase",
      entityId: caseId,
      summary: `Recovered ${input.payment.amountMinor} via verified capture.`,
      metadata: {
        razorpayPaymentId: input.payment.razorpayPaymentId,
        amountMinor: input.payment.amountMinor,
        eventType: input.eventType,
        evidence: input.payment.razorpayPaymentId,
      },
    });
  }
}
