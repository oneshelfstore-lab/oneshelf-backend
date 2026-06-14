import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";

// ─── Public router (no auth, mounted at /api/app/brands) ─────────────
//
// Lists brands (id, name, logoUrl) so the app can show brand logos. The owner product editor
// also reads this to populate the brand dropdown.

export const publicBrandRouter = Router();

publicBrandRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const brands = await prisma.brand.findMany({ orderBy: { name: "asc" } });
    res.json({ success: true, data: brands });
  } catch (e) {
    sendError(res, e);
  }
});

const brandSchema = z.object({
  name: z.string().min(1).max(80),
  logoUrl: z.string().max(500).optional().nullable(),
});

// ─── Owner router (FIREBASE auth, mounted at /api/app/owner/brands) ───
//
// The Android owner app authenticates with Firebase (like ownerCatalog/ownerBanners), so it needs
// a Firebase-auth write path. Products store the brand NAME (a string) — this table just carries
// each brand's logo, looked up by name, so adding brands needs no product migration.

export const ownerBrandRouter = Router();
ownerBrandRouter.use(firebaseAuthMiddleware as any);
ownerBrandRouter.use(requireAppRole("OWNER") as any);

ownerBrandRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const brands = await prisma.brand.findMany({ orderBy: { name: "asc" } });
    res.json({ success: true, data: brands });
  } catch (e) {
    sendError(res, e);
  }
});

ownerBrandRouter.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = brandSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid brand data", parsed.error.errors);

    // Upsert by the unique name: re-adding an existing brand updates its logo instead of failing
    // on the unique constraint. Lets the owner refresh a brand's logo from the same "add" flow.
    const brand = await prisma.brand.upsert({
      where: { name: parsed.data.name },
      update: { logoUrl: parsed.data.logoUrl ?? undefined },
      create: { name: parsed.data.name, logoUrl: parsed.data.logoUrl ?? null },
    });
    res.status(201).json({ success: true, data: brand });
  } catch (e) {
    sendError(res, e);
  }
});

ownerBrandRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.brand.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Brand", req.params.id!);

    await prisma.brand.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: "Brand deleted" });
  } catch (e) {
    sendError(res, e);
  }
});
