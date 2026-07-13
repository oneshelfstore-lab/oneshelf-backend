import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError, ConflictError, sendError } from "../lib/errors.js";
import { phoneSchema, panSchema, emailSchema, nonNegativeAmountSchema, amountSchema, dateStringSchema, paginationSchema } from "../validators/index.js";

const router = Router();

// ─── Validation — Employee ───────────────────────────────────────────

const employeeBaseSchema = z.object({
  name: z.string().min(1).max(200),
  employeeCode: z.string().min(1).max(50),
  designation: z.string().min(1).max(100),
  department: z.string().min(1).max(100),
  joiningDate: dateStringSchema,
  phone: phoneSchema,
  email: emailSchema.optional().or(z.literal("")).nullable(),
  pan: panSchema.optional().nullable(),
  aadhaar: z.string().regex(/^\d{12}$/, "Aadhaar must be 12 digits").optional().nullable(),
  bankDetails: z.any().optional().nullable(),
  monthlySalary: amountSchema,
});

const createEmployeeSchema = employeeBaseSchema;
const updateEmployeeSchema = employeeBaseSchema.partial();

const listEmployeeSchema = paginationSchema.extend({
  department: z.string().optional(),
  search: z.string().max(100).optional(),
});

// ─── POST /api/employees ─────────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createEmployeeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid employee data", parsed.error.errors);
    }
    const input = parsed.data;

    const existing = await prisma.employee.findUnique({ where: { employeeCode: input.employeeCode } });
    if (existing) throw new ConflictError(`Employee code '${input.employeeCode}' is already in use`);

    const employee = await prisma.employee.create({
      data: {
        name: input.name,
        employeeCode: input.employeeCode,
        designation: input.designation,
        department: input.department,
        joiningDate: new Date(input.joiningDate),
        phone: input.phone,
        email: input.email || undefined,
        pan: input.pan ?? undefined,
        aadhaar: input.aadhaar ?? undefined,
        bankDetails: input.bankDetails ?? undefined,
        monthlySalary: input.monthlySalary,
      },
    });

    res.status(201).json({ success: true, data: employee });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/employees ──────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const parsed = listEmployeeSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.errors);
    }
    const { page, limit, department, search } = parsed.data;

    const where: Record<string, unknown> = { isActive: true };
    if (department) where.department = department;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { employeeCode: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
      ];
    }

    const [employees, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.employee.count({ where }),
    ]);

    res.json({
      success: true,
      data: employees,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/employees/:id ──────────────────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
    if (!employee || !employee.isActive) throw new NotFoundError("Employee", req.params.id!);
    res.json({ success: true, data: employee });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── PUT /api/employees/:id ──────────────────────────────────────────

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
    if (!existing || !existing.isActive) throw new NotFoundError("Employee", req.params.id!);

    const parsed = updateEmployeeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid employee data", parsed.error.errors);
    }
    const input = parsed.data;

    if (input.employeeCode && input.employeeCode !== existing.employeeCode) {
      const dupe = await prisma.employee.findUnique({ where: { employeeCode: input.employeeCode } });
      if (dupe) throw new ConflictError(`Employee code '${input.employeeCode}' is already in use`);
    }

    const employee = await prisma.employee.update({
      where: { id: req.params.id },
      data: {
        ...input,
        joiningDate: input.joiningDate ? new Date(input.joiningDate) : undefined,
        email: input.email === "" ? null : input.email,
      },
    });

    res.json({ success: true, data: employee });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── DELETE /api/employees/:id — Soft delete ─────────────────────────

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Employee", req.params.id!);

    await prisma.employee.update({ where: { id: req.params.id }, data: { isActive: false } });

    res.json({ success: true, message: "Employee deactivated" });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── Validation — Salary records ─────────────────────────────────────
// Gross/net are always SERVER-computed from the components (never trust a client-sent total) —
// grossSalary = basic + hra + otherAllowances; netSalary = gross − pf − esi − tds − otherDeductions.

const salaryComponentsSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  basicSalary: nonNegativeAmountSchema,
  hra: nonNegativeAmountSchema.default(0),
  otherAllowances: nonNegativeAmountSchema.default(0),
  pfDeduction: nonNegativeAmountSchema.default(0),
  esiDeduction: nonNegativeAmountSchema.default(0),
  tdsDeduction: nonNegativeAmountSchema.default(0),
  otherDeductions: nonNegativeAmountSchema.default(0),
});

const createSalarySchema = salaryComponentsSchema;

const updateSalarySchema = z.object({
  basicSalary: nonNegativeAmountSchema.optional(),
  hra: nonNegativeAmountSchema.optional(),
  otherAllowances: nonNegativeAmountSchema.optional(),
  pfDeduction: nonNegativeAmountSchema.optional(),
  esiDeduction: nonNegativeAmountSchema.optional(),
  tdsDeduction: nonNegativeAmountSchema.optional(),
  otherDeductions: nonNegativeAmountSchema.optional(),
  status: z.enum(["DRAFT", "APPROVED", "PAID"]).optional(),
  paymentDate: dateStringSchema.optional(),
  paymentMode: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "NEFT", "RTGS", "CREDIT"]).optional(),
  paymentRef: z.string().max(100).optional().nullable(),
});

function money(v: number): number {
  return Math.round(v * 100) / 100;
}

// ─── POST /api/employees/:id/salary — Create a salary record for a month ──

router.post("/:id/salary", async (req: Request, res: Response) => {
  try {
    const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
    if (!employee || !employee.isActive) throw new NotFoundError("Employee", req.params.id!);

    const parsed = createSalarySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid salary record data", parsed.error.errors);
    }
    const input = parsed.data;

    const dupe = await prisma.salaryRecord.findUnique({
      where: { employeeId_month_year: { employeeId: employee.id, month: input.month, year: input.year } },
    });
    if (dupe) throw new ConflictError(`A salary record for ${input.month}/${input.year} already exists for this employee`);

    const grossSalary = money(input.basicSalary + input.hra + input.otherAllowances);
    const netSalary = money(
      grossSalary - input.pfDeduction - input.esiDeduction - input.tdsDeduction - input.otherDeductions,
    );

    const record = await prisma.salaryRecord.create({
      data: {
        employeeId: employee.id,
        month: input.month,
        year: input.year,
        basicSalary: input.basicSalary,
        hra: input.hra,
        otherAllowances: input.otherAllowances,
        grossSalary,
        pfDeduction: input.pfDeduction,
        esiDeduction: input.esiDeduction,
        tdsDeduction: input.tdsDeduction,
        otherDeductions: input.otherDeductions,
        netSalary,
        status: "DRAFT",
      },
    });

    res.status(201).json({ success: true, data: record });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/employees/:id/salary — List an employee's salary records ──

router.get("/:id/salary", async (req: Request, res: Response) => {
  try {
    const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
    if (!employee) throw new NotFoundError("Employee", req.params.id!);

    const records = await prisma.salaryRecord.findMany({
      where: { employeeId: employee.id },
      orderBy: [{ year: "desc" }, { month: "desc" }],
    });

    res.json({ success: true, data: records });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── PUT /api/employees/salary/:recordId — Update / approve / mark paid ──
// Mounted at a sibling path (not nested under an employee id) since a salary record is looked up
// by its own id from here on.

router.put("/salary/:recordId", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.salaryRecord.findUnique({ where: { id: req.params.recordId } });
    if (!existing) throw new NotFoundError("SalaryRecord", req.params.recordId!);
    if (existing.status === "PAID") {
      throw new ValidationError("A paid salary record can't be edited — it's already settled.");
    }

    const parsed = updateSalarySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid salary record data", parsed.error.errors);
    }
    const input = parsed.data;

    const basicSalary = input.basicSalary ?? Number(existing.basicSalary);
    const hra = input.hra ?? Number(existing.hra);
    const otherAllowances = input.otherAllowances ?? Number(existing.otherAllowances);
    const pfDeduction = input.pfDeduction ?? Number(existing.pfDeduction);
    const esiDeduction = input.esiDeduction ?? Number(existing.esiDeduction);
    const tdsDeduction = input.tdsDeduction ?? Number(existing.tdsDeduction);
    const otherDeductions = input.otherDeductions ?? Number(existing.otherDeductions);

    const grossSalary = money(basicSalary + hra + otherAllowances);
    const netSalary = money(grossSalary - pfDeduction - esiDeduction - tdsDeduction - otherDeductions);

    if (input.status === "PAID" && !input.paymentDate && !existing.paymentDate) {
      throw new ValidationError("paymentDate is required to mark a salary record as PAID");
    }

    const record = await prisma.salaryRecord.update({
      where: { id: req.params.recordId },
      data: {
        basicSalary,
        hra,
        otherAllowances,
        grossSalary,
        pfDeduction,
        esiDeduction,
        tdsDeduction,
        otherDeductions,
        netSalary,
        status: input.status ?? existing.status,
        paymentDate: input.paymentDate ? new Date(input.paymentDate) : undefined,
        paymentMode: input.paymentMode ?? undefined,
        paymentRef: input.paymentRef === null ? null : (input.paymentRef ?? undefined),
      },
    });

    res.json({ success: true, data: record });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── DELETE /api/employees/salary/:recordId ──────────────────────────
// A PAID record is a settled, real payment — block deleting it (correct via a fresh record instead).

router.delete("/salary/:recordId", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.salaryRecord.findUnique({ where: { id: req.params.recordId } });
    if (!existing) throw new NotFoundError("SalaryRecord", req.params.recordId!);
    if (existing.status === "PAID") {
      throw new ValidationError("A paid salary record can't be deleted — it's already settled.");
    }

    await prisma.salaryRecord.delete({ where: { id: req.params.recordId } });

    res.json({ success: true, message: "Salary record deleted" });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
