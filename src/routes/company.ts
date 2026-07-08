import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, NotFoundError } from "../lib/errors.js";
import { requireRole, type AuthRequest } from "../middleware/auth.js";
import { isUpGstin } from "../validators/index.js";
import { bustStoreState } from "../lib/stateCodes.js";

const router = Router();

const companySchema = z.object({
  legalName: z.string().min(1).max(200),
  tradeName: z.string().min(1).max(200),
  pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, "Invalid PAN format"),
  gstin: z.string().length(15).refine(
    (v) => isUpGstin(v).valid,
    (v) => ({ message: isUpGstin(v).error || "Invalid GSTIN" }),
  ),
  address: z.any(),
  phone: z.string().regex(/^[6-9]\d{9}$/, "Invalid phone"),
  email: z.string().email(),
  logoUrl: z.string().optional().nullable(),
  financialYearStart: z.number().int().min(1).max(12).default(4),
});

// GET /api/company — get company profile (or empty)
router.get("/", async (_req: Request, res: Response) => {
  try {
    const company = await prisma.company.findFirst();
    res.json({ success: true, data: company });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/company — create company profile (owner only)
router.post("/", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.company.findFirst();
    if (existing) {
      return res.status(409).json({
        success: false,
        error: { code: "ALREADY_EXISTS", message: "Company profile already exists. Use PUT to update.", details: [] },
      });
    }

    const data = companySchema.parse(req.body);
    const company = await prisma.company.create({ data });
    bustStoreState(); // GSTIN → state code is derived; refresh the memo
    res.status(201).json({ success: true, data: company });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /api/company — update company profile (owner only)
router.put("/", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.company.findFirst();
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "No company profile found. Use POST to create.", details: [] },
      });
    }

    const data = companySchema.partial().parse(req.body);
    const company = await prisma.company.update({ where: { id: existing.id }, data });
    bustStoreState(); // GSTIN → state code is derived; refresh the memo
    res.json({ success: true, data: company });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
