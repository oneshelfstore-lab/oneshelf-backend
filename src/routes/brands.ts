import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { cacheControl, memoCache, PUBLIC_TTL_MS, PUBLIC_TTL_SECONDS } from "../lib/httpCache.js";

// ─── Public router (no auth, mounted at /api/app/brands) ─────────────
//
// Lists brands (id, name, logoUrl) so the app can show brand logos. The owner product editor
// also reads this to populate the brand dropdown.

export const publicBrandRouter = Router();

publicBrandRouter.get("/", cacheControl(PUBLIC_TTL_SECONDS), async (_req: Request, res: Response) => {
  try {
    const brands = await memoCache.get("brands", PUBLIC_TTL_MS, () =>
      prisma.brand.findMany({ orderBy: { name: "asc" } }),
    );
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
    memoCache.bust("brands");
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
    memoCache.bust("brands");
    res.json({ success: true, message: "Brand deleted" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Seller router (FIREBASE auth + SELLER role, mounted at /api/app/seller/brands) ──
//
// A seller (notably the in-app house co-manager) needs to add a new brand so it persists in the
// brand dropdown for future products — the owner write-path above is OWNER-only, so a seller would
// get a 403 there. Brands are global display labels (products store the brand NAME as a string and
// every catalog shares the one Brand table), so this just upserts by name; no per-seller scoping of
// the row is needed. resolveSeller still gates out suspended/unlinked sellers.

export const sellerBrandRouter = Router();
sellerBrandRouter.use(firebaseAuthMiddleware as any);
sellerBrandRouter.use(requireAppRole("SELLER") as any);
sellerBrandRouter.use(resolveSeller as any);

sellerBrandRouter.get("/", async (_req: SellerRequest, res: Response) => {
  try {
    const brands = await prisma.brand.findMany({ orderBy: { name: "asc" } });
    res.json({ success: true, data: brands });
  } catch (e) {
    sendError(res, e);
  }
});

sellerBrandRouter.post("/", async (req: SellerRequest, res: Response) => {
  try {
    const parsed = brandSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid brand data", parsed.error.errors);

    // Upsert by the unique name — re-adding an existing brand is a no-op (keeps its logo) instead of
    // failing on the unique constraint.
    const brand = await prisma.brand.upsert({
      where: { name: parsed.data.name },
      update: { logoUrl: parsed.data.logoUrl ?? undefined },
      create: { name: parsed.data.name, logoUrl: parsed.data.logoUrl ?? null },
    });
    memoCache.bust("brands");
    res.status(201).json({ success: true, data: brand });
  } catch (e) {
    sendError(res, e);
  }
});
