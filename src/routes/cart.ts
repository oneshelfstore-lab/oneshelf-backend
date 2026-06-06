import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { formatVariantForApp } from "../utils/looseUnitConverter.js";
import { calculateCartTotals } from "../services/cartPricing.js";

const router = Router();

router.use(firebaseAuthMiddleware as any);

// ─── Helpers ─────────────────────────────────────────────────────────

function isLooseType(t: string) { return t === "LOOSE" || t === "PRODUCE"; }

const cartItemInclude = {
  variant: {
    include: {
      product: {
        select: {
          id: true, name: true, handle: true, brand: true, productType: true,
          imageUrls: true, hsnCode: true, gstRate: true, isPackaged: true, categoryId: true,
        },
      },
    },
  },
} as const;

function formatCartItem(item: any) {
  const isLoose = isLooseType(item.variant.product.productType);
  return {
    id: item.id,
    variantId: item.variantId,
    quantity: item.quantity,
    savedForLater: item.savedForLater,
    isLoose: item.isLoose,
    stepSize: item.stepSize ? Number(item.stepSize) : null,
    stepUnit: item.stepUnit,
    product: {
      id: item.variant.product.id,
      name: item.variant.product.name,
      handle: item.variant.product.handle,
      brand: item.variant.product.brand,
      productType: item.variant.product.productType,
      imageUrl: item.variant.product.imageUrls?.[0] ?? null,
    },
    variant: formatVariantForApp(item.variant, isLoose),
  };
}

// ─── GET /api/app/cart ───────────────────────────────────────────────

router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;

    const [activeItems, savedItems] = await Promise.all([
      prisma.cartItem.findMany({
        where: { userId, savedForLater: false },
        include: cartItemInclude,
        orderBy: { createdAt: "asc" },
      }),
      prisma.cartItem.findMany({
        where: { userId, savedForLater: true },
        include: cartItemInclude,
        orderBy: { createdAt: "asc" },
      }),
    ]);

    // Calculate totals for active items
    const totals = activeItems.length > 0
      ? await calculateCartTotals(activeItems as any)
      : { subtotal: 0, discount: 0, couponCode: null, deliveryCharge: 0, taxableValue: 0, totalCgst: 0, totalSgst: 0, totalTax: 0, totalAmount: 0 };

    res.json({
      success: true,
      data: {
        items: activeItems.map(formatCartItem),
        savedForLater: savedItems.map(formatCartItem),
        totals,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/cart/quote — preview totals (stateless) ───────────
// Returns the EXACT totals the order will be charged (same calculateCartTotals as
// placeOrder), so the checkout summary never drifts from what's actually billed.
// Does NOT touch the persisted cart — the app sends its local cart contents.

const quoteSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.number().int().min(1).max(10000),
      }),
    )
    .max(200),
  couponCode: z.string().max(40).optional().nullable(),
  fulfillmentType: z.enum(["DELIVERY", "PICKUP"]).optional().nullable(),
});

router.post("/quote", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const { items, couponCode, fulfillmentType } = parsed.data;
    const userId = req.appUser!.id;

    const emptyTotals = {
      items: [], subtotal: 0, discount: 0, couponCode: null, deliveryCharge: 0,
      taxableValue: 0, totalCgst: 0, totalSgst: 0, totalTax: 0, totalAmount: 0,
    };

    if (items.length === 0) {
      return res.json({ success: true, data: emptyTotals });
    }

    // Load variants in one query, then build the pricing-input shape calculateCartTotals expects.
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: items.map((i) => i.variantId) } },
      include: {
        product: {
          select: { productType: true, gstRate: true, hsnCode: true, isPackaged: true, categoryId: true },
        },
      },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));

    const cartItems = items
      .filter((i) => byId.has(i.variantId))
      .map((i) => ({ id: i.variantId, variantId: i.variantId, quantity: i.quantity, variant: byId.get(i.variantId)! }));

    const totals = cartItems.length > 0
      ? await calculateCartTotals(cartItems as any, couponCode, userId, fulfillmentType)
      : emptyTotals;

    res.json({ success: true, data: totals });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/cart — add item ──────────────────────────────────

const addSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.number().int().min(1).max(10000),
});

router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const { variantId, quantity } = parsed.data;
    const userId = req.appUser!.id;

    const variant = await prisma.productVariant.findUnique({
      where: { id: variantId },
      include: { product: { select: { productType: true, isPackaged: true } } },
    });
    if (!variant || !variant.isActive) throw new NotFoundError("Variant", variantId);

    const isLoose = isLooseType(variant.product.productType);
    const stockNum = Number(variant.stock);
    const packageSize = Number(variant.packageSize);

    // For loose: stock is in base units, check quantity (increments) × packageSize ≤ stock
    if (isLoose) {
      if (quantity * packageSize > stockNum) {
        throw new ValidationError(`Insufficient stock. Available: ${stockNum} ${variant.packageUnit}`);
      }
    } else {
      if (quantity > stockNum) {
        throw new ValidationError(`Insufficient stock. Available: ${stockNum}`);
      }
    }

    // Upsert: if already in cart (active), increment quantity
    const existing = await prisma.cartItem.findFirst({
      where: { userId, variantId, savedForLater: false },
    });

    if (existing) {
      const newQty = existing.quantity + quantity;
      await prisma.cartItem.update({
        where: { id: existing.id },
        data: { quantity: newQty },
      });
    } else {
      await prisma.cartItem.create({
        data: {
          userId, variantId, quantity, savedForLater: false,
          isLoose, stepSize: isLoose ? packageSize : null,
          stepUnit: isLoose ? variant.packageUnit : null,
        },
      });
    }

    res.json({ success: true, message: "Item added to cart" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PUT /api/app/cart/:itemId — update quantity ────────────────────

const updateSchema = z.object({
  quantity: z.number().int().min(1).max(10000),
});

router.put("/:itemId", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const { quantity } = parsed.data;
    const userId = req.appUser!.id;

    const item = await prisma.cartItem.findFirst({
      where: { id: req.params.itemId, userId },
      include: { variant: { include: { product: { select: { productType: true } } } } },
    });
    if (!item) throw new NotFoundError("CartItem", req.params.itemId!);

    const variant = item.variant;
    const isLoose = isLooseType(variant.product.productType);
    const stockNum = Number(variant.stock);
    const packageSize = Number(variant.packageSize);

    if (isLoose) {
      if (quantity * packageSize > stockNum) throw new ValidationError(`Insufficient stock`);
    } else {
      if (quantity > stockNum) throw new ValidationError(`Insufficient stock`);
    }

    await prisma.cartItem.update({ where: { id: item.id }, data: { quantity } });
    res.json({ success: true, message: "Cart updated" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── DELETE /api/app/cart/:itemId — remove item ─────────────────────

router.delete("/:itemId", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const item = await prisma.cartItem.findFirst({ where: { id: req.params.itemId, userId } });
    if (!item) throw new NotFoundError("CartItem", req.params.itemId!);

    await prisma.cartItem.delete({ where: { id: item.id } });
    res.json({ success: true, message: "Item removed from cart" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/cart/:itemId/save-for-later ──────────────────────

router.post("/:itemId/save-for-later", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const item = await prisma.cartItem.findFirst({
      where: { id: req.params.itemId, userId, savedForLater: false },
    });
    if (!item) throw new NotFoundError("CartItem", req.params.itemId!);

    await prisma.cartItem.update({ where: { id: item.id }, data: { savedForLater: true } });
    res.json({ success: true, message: "Item saved for later" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/cart/:itemId/move-to-cart ─────────────────────────

router.post("/:itemId/move-to-cart", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const item = await prisma.cartItem.findFirst({
      where: { id: req.params.itemId, userId, savedForLater: true },
      include: { variant: { include: { product: { select: { productType: true } } } } },
    });
    if (!item) throw new NotFoundError("CartItem", req.params.itemId!);

    // Re-validate stock
    const isLoose = isLooseType(item.variant.product.productType);
    const stockNum = Number(item.variant.stock);
    const packageSize = Number(item.variant.packageSize);

    if (isLoose) {
      if (item.quantity * packageSize > stockNum) throw new ValidationError("Item is now out of stock");
    } else {
      if (item.quantity > stockNum) throw new ValidationError("Item is now out of stock");
    }

    await prisma.cartItem.update({ where: { id: item.id }, data: { savedForLater: false } });
    res.json({ success: true, message: "Item moved to cart" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── DELETE /api/app/cart/clear/all — clear active cart ──────────────

router.delete("/clear/all", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const result = await prisma.cartItem.deleteMany({
      where: { userId, savedForLater: false },
    });
    res.json({ success: true, message: `${result.count} items cleared from cart` });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
