import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, NotFoundError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import { istMidnight, isValidDeliveryDay, type CadenceLike } from "../services/subscriptionEngine.js";
import { markStatementInvoicePaid } from "../services/orderInvoice.js";
import { notifySubscriptionStatement } from "../services/fcmNotifier.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

const MS_DAY = 24 * 60 * 60 * 1000;

function toCadence(row: {
  frequency: string;
  intervalDays: number | null;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  startDate: Date;
  endDate: Date | null;
}): CadenceLike {
  return {
    frequency: row.frequency as CadenceLike["frequency"],
    intervalDays: row.intervalDays,
    daysOfWeek: row.daysOfWeek,
    dayOfMonth: row.dayOfMonth,
    startDate: row.startDate,
    endDate: row.endDate,
  };
}

// ─── GET /  — all active subscriptions ───────────────────────────────
router.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const subs = await prisma.subscription.findMany({
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      include: { customer: { select: { name: true, phone: true } } },
    });
    res.json({
      success: true,
      data: subs.map((s) => ({
        ...s,
        quantity: Number(s.quantity),
        stepSize: s.stepSize == null ? null : Number(s.stepSize),
        customerName: s.customer?.name ?? null,
        customerPhone: s.customer?.phone ?? null,
      })),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /upcoming?date=tomorrow|YYYY-MM-DD  — per-variant planning totals ──
// "Tomorrow: 40× Milk 500ml, 12× Newspaper" — how many of each to stock.
router.get("/upcoming", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const dateParam = (req.query.date as string | undefined) ?? "tomorrow";
    let target: Date;
    if (dateParam === "today") target = istMidnight(new Date());
    else if (dateParam === "tomorrow") target = istMidnight(new Date(Date.now() + MS_DAY));
    else {
      const parsed = new Date(dateParam);
      if (isNaN(parsed.getTime())) throw new ValidationError("Invalid date");
      target = istMidnight(parsed);
    }

    const now = new Date();
    const subs = await prisma.subscription.findMany({
      where: {
        status: "ACTIVE",
        startDate: { lte: target },
        OR: [{ pausedUntil: null }, { pausedUntil: { lte: now } }],
        AND: [{ OR: [{ endDate: null }, { endDate: { gte: target } }] }],
      },
    });

    const byVariant = new Map<
      string,
      { variantId: string; productName: string; unit: string; isLoose: boolean; totalQty: number; customerCount: number }
    >();
    for (const sub of subs) {
      if (!isValidDeliveryDay(toCadence(sub), target)) continue;
      const row = byVariant.get(sub.variantId) ?? {
        variantId: sub.variantId,
        productName: sub.productName,
        unit: sub.stepUnit ?? "",
        isLoose: sub.isLoose,
        totalQty: 0,
        customerCount: 0,
      };
      row.totalQty = +(row.totalQty + Number(sub.quantity)).toFixed(3);
      row.customerCount += 1;
      byVariant.set(sub.variantId, row);
    }

    res.json({
      success: true,
      data: {
        date: target.toISOString(),
        items: [...byVariant.values()].sort((a, b) => b.totalQty - a.totalQty),
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /statements?status=  — monthly subscription bills ───────────
router.get("/statements", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const where: any = {};
    if (status) where.status = status;
    const statements = await prisma.subscriptionStatement.findMany({
      where,
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
      include: { customer: { select: { name: true, phone: true } } },
    });
    res.json({
      success: true,
      data: statements.map((s) => ({
        ...s,
        totalAmount: Number(s.totalAmount),
        customerName: s.customer?.name ?? null,
        customerPhone: s.customer?.phone ?? null,
      })),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /settings  — owner subscription controls ────────────────────
// The three StoreConfig knobs that govern subscriptions: master on/off, the day the prior month's
// statements close, and an optional default delivery agent that generated orders auto-assign to.
router.get("/settings", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const config = await prisma.storeConfig.findFirst();
    res.json({
      success: true,
      data: {
        subscriptionsEnabled: config?.subscriptionsEnabled ?? true,
        subscriptionCutoffHour: config?.subscriptionCutoffHour ?? 21,
        defaultSubscriptionAgentId: config?.defaultSubscriptionAgentId ?? null,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PUT /settings  — update owner subscription controls ─────────────
const settingsSchema = z.object({
  subscriptionsEnabled: z.boolean().optional(),
  // IST hour (0..23) after which the NEXT day's delivery is locked — a skip/cancel must happen before it.
  subscriptionCutoffHour: z.number().int().min(0).max(23).optional(),
  // "" or null clears the default agent (back to manual assignment). A non-empty id must be a
  // real DELIVERY-role user. Changing it only affects FUTURE generated orders — existing ones keep
  // their assignment (owner reassigns those via the normal assign-delivery dropdown if needed).
  defaultSubscriptionAgentId: z.string().nullable().optional(),
});

router.put("/settings", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid settings", parsed.error.errors);
    const d = parsed.data;

    const config = await prisma.storeConfig.findFirst();
    if (!config) throw new NotFoundError("StoreConfig", "store");

    const data: {
      subscriptionsEnabled?: boolean;
      subscriptionCutoffHour?: number;
      defaultSubscriptionAgentId?: string | null;
    } = {};
    if (d.subscriptionsEnabled !== undefined) data.subscriptionsEnabled = d.subscriptionsEnabled;
    if (d.subscriptionCutoffHour !== undefined) data.subscriptionCutoffHour = d.subscriptionCutoffHour;
    if (d.defaultSubscriptionAgentId !== undefined) {
      const agentId = d.defaultSubscriptionAgentId?.trim() || null;
      if (agentId) {
        const agent = await prisma.user.findFirst({ where: { id: agentId, role: "DELIVERY" } });
        if (!agent) throw new ValidationError("That delivery agent doesn't exist");
      }
      data.defaultSubscriptionAgentId = agentId;
    }

    const updated = await prisma.storeConfig.update({ where: { id: config.id }, data });
    res.json({
      success: true,
      data: {
        subscriptionsEnabled: updated.subscriptionsEnabled,
        subscriptionCutoffHour: updated.subscriptionCutoffHour,
        defaultSubscriptionAgentId: updated.defaultSubscriptionAgentId,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /statements/:id/mark-paid  — COD monthly settlement (D6) ───
router.post("/statements/:id/mark-paid", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const statement = await prisma.subscriptionStatement.findUnique({ where: { id: req.params.id as string } });
    if (!statement) throw new NotFoundError("Statement", req.params.id as string);
    if (statement.status === "PAID") {
      return res.json({ success: true, data: { id: statement.id, status: "PAID" } });
    }

    await prisma.$transaction(async (tx) => {
      await tx.subscriptionStatement.update({
        where: { id: statement.id },
        data: { status: "PAID", paidAt: new Date() },
      });
      await tx.order.updateMany({ where: { statementId: statement.id }, data: { paymentStatus: "PAID" } });
    });

    // Mark the consolidated invoice PAID + record the cash receipt (store revenue). Best-effort.
    await markStatementInvoicePaid(statement.id, "CASH").catch((e) => console.error("statement invoice mark-paid failed:", e));
    await notifySubscriptionStatement(statement.customerId, {
      amount: Number(statement.totalAmount),
      periodLabel: `${statement.periodMonth}/${statement.periodYear}`,
      autoPaid: true,
    }).catch(() => {});

    res.json({ success: true, data: { id: statement.id, status: "PAID" } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
