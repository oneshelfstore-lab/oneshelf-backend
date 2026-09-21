/**
 * Where a payout's money actually goes.
 *
 * ⚠️ Be honest about what this is: ONE interface with ONE implementation that moves no money. It
 * earns its place not by abstracting over alternatives that exist, but by marking the single seam
 * where a real transfer would happen — after the ledger commits, outside the transaction — so that
 * adding one later does not mean reopening payoutSellerInTx, which is where the exactly-once claim
 * lives and the one function in this codebase that must not be casually edited.
 *
 * There is no second rail today and there may not be for a while: Razorpay Route is gated behind the
 * RBI's Sep 2025 payment-aggregator rules, which want ₹40 lakh of domestic turnover evidenced by
 * GSTR-3B before a platform may route funds to third parties. Until then a human makes the transfer.
 *
 * ⚠️ WHAT THIS DELIBERATELY DOES NOT SOLVE. The ledger commits BEFORE the rail is asked to send, so
 * a rail that genuinely moves money and then fails leaves a recorded payout that never went out.
 * That is exactly right for ManualRail — recording is the whole job — and exactly wrong for a real
 * rail, which needs a status on SellerPayout and a reconciliation pass, the same shape the Razorpay
 * order flow already uses for customer payments. Do not ship a sending rail without that first.
 */

/** What the rail is asked to move. */
export interface PayoutInstruction {
  payoutId: string;
  sellerId: string;
  sellerName: string;
  /** Net amount, already floored at zero by the adjustment planner. */
  amount: number;
  /** Seller.payoutAccountRef — whatever handle this rail understands, null if never set. */
  accountRef: string | null;
}

export interface PayoutRailResult {
  /**
   * RECORDED — the ledger is written and a human moves the money. Not a failure.
   * SENT — the rail transferred it. FAILED — it tried and could not.
   */
  status: "RECORDED" | "SENT" | "FAILED";
  /** A transfer id from the rail, written onto the payout when present. */
  reference?: string | null;
  note?: string | null;
}

export interface PayoutRail {
  readonly name: string;
  /**
   * Copy for a payout nobody clicked — the cron's note. It lives on the rail because the rail is
   * the thing that knows whether money actually moved, and the cron was hardcoding an answer to
   * that question.
   */
  readonly unattendedNote: string;
  send(instruction: PayoutInstruction): Promise<PayoutRailResult>;
}

/** Records the payout and does nothing else. The owner transfers the funds themselves. */
export const ManualRail: PayoutRail = {
  name: "MANUAL",
  unattendedNote: "Automatic scheduled payout (owner still transfers funds manually)",
  async send(): Promise<PayoutRailResult> {
    return { status: "RECORDED" };
  },
};

const RAILS: Record<string, PayoutRail> = { MANUAL: ManualRail };

/**
 * ⚠️ An unrecognised name falls back to ManualRail rather than throwing, and that is only safe
 * while every rail is manual: falling back cannot fail to move money that would otherwise have
 * moved, because nothing moves money. The moment a sending rail exists this must THROW instead —
 * otherwise a typo in StoreConfig.payoutRail silently stops transfers while the owner believes
 * they are going out.
 */
export function resolvePayoutRail(name: string | null | undefined): PayoutRail {
  const key = (name ?? "MANUAL").toUpperCase();
  const rail = RAILS[key];
  if (!rail) {
    console.warn(`[payoutRail] unknown rail "${name}" — falling back to MANUAL (no funds will move)`);
    return ManualRail;
  }
  return rail;
}
