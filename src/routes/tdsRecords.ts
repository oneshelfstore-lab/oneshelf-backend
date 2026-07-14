import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError, sendError } from "../lib/errors.js";
import { panSchema, nonNegativeAmountSchema, dateStringSchema, paginationSchema } from "../validators/index.js";
import { getCurrentFinancialYear } from "../services/invoiceNumbering.js";

const router = Router();

// ─── Validation ──────────────────────────────────────────────────────

// SELLER = Sec 194-O marketplace withholding — usually auto-logged by services/sellerPayout.ts (one
// row per payout batch), listed here too so the dashboard can manually add/correct an entry.
const deducteeTypeSchema = z.enum(["VENDOR", "EMPLOYEE", "LANDLORD", "SELLER"]);
const quarterSchema = z.enum(["Q1", "Q2", "Q3", "Q4"]);

const tdsBaseSchema = z.object({
  deducteeType: deducteeTypeSchema,
  deducteeId: z.string().min(1),
  deducteeName: z.string().min(1).max(200),
  deducteePan: panSchema.optional().nullable(),
  section: z.string().min(1).max(20), // e.g. "194C", "194I", "192"
  paymentDate: dateStringSchema,
  paymentAmount: nonNegativeAmountSchema,
  tdsRate: z.number().min(0).max(30),
  challanNumber: z.string().max(50).optional().nullable(),
  challanDate: dateStringSchema.optional().nullable(),
  depositedToGovt: z.boolean().default(false),
  depositDate: dateStringSchema.optional().nullable(),
  returnFiled: z.boolean().default(false),
});

const createTdsSchema = tdsBaseSchema;
const updateTdsSchema = tdsBaseSchema.partial();

const listTdsSchema = paginationSchema.extend({
  deducteeType: deducteeTypeSchema.optional(),
  quarter: quarterSchema.optional(),
  financialYear: z.string().optional(),
  deposited: z.coerce.boolean().optional(),
});

function money(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Indian FY quarter (Apr–Mar FY): Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar. */
function quarterFor(date: Date): "Q1" | "Q2" | "Q3" | "Q4" {
  const month = date.getMonth() + 1; // 1-indexed
  if (month >= 4 && month <= 6) return "Q1";
  if (month >= 7 && month <= 9) return "Q2";
  if (month >= 10 && month <= 12) return "Q3";
  return "Q4";
}

// ─── POST /api/tds-records ───────────────────────────────────────────
// quarter/financialYear are derived from paymentDate (not caller-supplied) — the whole point of a TDS
// register is that its quarter bucket is a legal fact, not a free-text field someone can mis-key.

router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createTdsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid TDS record data", parsed.error.errors);
    }
    const input = parsed.data;
    const paymentDate = new Date(input.paymentDate);
    const tdsAmount = money((input.paymentAmount * input.tdsRate) / 100);

    const record = await prisma.tdsRecord.create({
      data: {
        deducteeType: input.deducteeType,
        deducteeId: input.deducteeId,
        deducteeName: input.deducteeName,
        deducteePan: input.deducteePan ?? undefined,
        section: input.section,
        paymentDate,
        paymentAmount: input.paymentAmount,
        tdsRate: input.tdsRate,
        tdsAmount,
        challanNumber: input.challanNumber ?? undefined,
        challanDate: input.challanDate ? new Date(input.challanDate) : undefined,
        depositedToGovt: input.depositedToGovt,
        depositDate: input.depositDate ? new Date(input.depositDate) : undefined,
        quarter: quarterFor(paymentDate),
        financialYear: getCurrentFinancialYear(paymentDate),
        returnFiled: input.returnFiled,
      },
    });

    res.status(201).json({ success: true, data: record });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/tds-records ─────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const parsed = listTdsSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.errors);
    }
    const { page, limit, deducteeType, quarter, financialYear, deposited } = parsed.data;

    const where: Record<string, unknown> = {};
    if (deducteeType) where.deducteeType = deducteeType;
    if (quarter) where.quarter = quarter;
    if (financialYear) where.financialYear = financialYear;
    if (deposited !== undefined) where.depositedToGovt = deposited;

    const [records, total] = await Promise.all([
      prisma.tdsRecord.findMany({
        where,
        orderBy: { paymentDate: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.tdsRecord.count({ where }),
    ]);

    res.json({
      success: true,
      data: records,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/tds-records/:id ─────────────────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const record = await prisma.tdsRecord.findUnique({ where: { id: req.params.id } });
    if (!record) throw new NotFoundError("TdsRecord", req.params.id!);
    res.json({ success: true, data: record });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── PUT /api/tds-records/:id ─────────────────────────────────────────

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.tdsRecord.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("TdsRecord", req.params.id!);
    if (existing.returnFiled) {
      throw new ValidationError("This TDS record's return has already been filed and can't be edited.");
    }

    const parsed = updateTdsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid TDS record data", parsed.error.errors);
    }
    const input = parsed.data;

    const paymentAmount = input.paymentAmount ?? Number(existing.paymentAmount);
    const tdsRate = input.tdsRate ?? Number(existing.tdsRate);
    const tdsAmount = money((paymentAmount * tdsRate) / 100);
    const paymentDate = input.paymentDate ? new Date(input.paymentDate) : existing.paymentDate;

    const record = await prisma.tdsRecord.update({
      where: { id: req.params.id },
      data: {
        deducteeType: input.deducteeType ?? undefined,
        deducteeId: input.deducteeId ?? undefined,
        deducteeName: input.deducteeName ?? undefined,
        deducteePan: input.deducteePan === null ? null : (input.deducteePan ?? undefined),
        section: input.section ?? undefined,
        paymentDate,
        paymentAmount,
        tdsRate,
        tdsAmount,
        challanNumber: input.challanNumber === null ? null : (input.challanNumber ?? undefined),
        challanDate: input.challanDate ? new Date(input.challanDate) : undefined,
        depositedToGovt: input.depositedToGovt ?? undefined,
        depositDate: input.depositDate ? new Date(input.depositDate) : undefined,
        // Re-derive the quarter/FY bucket if paymentDate moved.
        quarter: input.paymentDate ? quarterFor(paymentDate) : undefined,
        financialYear: input.paymentDate ? getCurrentFinancialYear(paymentDate) : undefined,
        returnFiled: input.returnFiled ?? undefined,
      },
    });

    res.json({ success: true, data: record });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── DELETE /api/tds-records/:id ──────────────────────────────────────
// Once the return is filed (or deposited to govt) this is a real regulatory record — block deletion.

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.tdsRecord.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("TdsRecord", req.params.id!);
    if (existing.returnFiled || existing.depositedToGovt) {
      throw new ValidationError("A deposited/filed TDS record can't be deleted.");
    }

    await prisma.tdsRecord.delete({ where: { id: req.params.id } });

    res.json({ success: true, message: "TDS record deleted" });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
