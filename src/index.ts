import "dotenv/config";
import { randomUUID } from "crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import authRoutes from "./routes/auth.js";
import productRoutes from "./routes/products.js";
import customerRoutes from "./routes/customers.js";
import invoiceRoutes from "./routes/invoices.js";
import paymentRoutes from "./routes/payments.js";
import vendorRoutes from "./routes/vendors.js";
import purchaseBillRoutes from "./routes/purchaseBills.js";
import reportRoutes from "./routes/reports.js";
import companyRoutes from "./routes/company.js";
import storeConfigRoutes from "./routes/storeConfig.js";
import fcmTokenRoutes from "./routes/fcmTokens.js";
import { publicCategoryRouter, adminCategoryRouter, publicSuperCategoryRouter } from "./routes/categories.js";
import ownerSuperCategoryRoutes from "./routes/ownerSuperCategories.js";
import { publicCatalogRouter, adminCatalogRouter } from "./routes/catalog.js";
import { publicBannerRouter, adminBannerRouter, ownerBannerRouter } from "./routes/banners.js";
import { publicDealCollageRouter, ownerDealCollageRouter } from "./routes/dealCollages.js";
import { publicBrandRouter, ownerBrandRouter, sellerBrandRouter } from "./routes/brands.js";
import cartRoutes from "./routes/cart.js";
import { appCouponRouter, adminCouponRouter, ownerCouponRouter } from "./routes/coupons.js";
import orderRoutes from "./routes/orders.js";
import ownerOrderRoutes from "./routes/ownerOrders.js";
import adminOrderRoutes from "./routes/adminOrders.js";
import deliveryRoutes from "./routes/delivery.js";
import ownerCatalogRoutes from "./routes/ownerCatalog.js";
import ownerStaffRoutes from "./routes/ownerStaff.js";
import ownerComplaintRoutes from "./routes/ownerComplaints.js";
import ownerQuoteRoutes from "./routes/ownerQuotes.js";
import partnerApplicationRoutes from "./routes/partnerApplications.js";
import ownerPartnerApplicationRoutes from "./routes/ownerPartnerApplications.js";
import ownerBroadcastRoutes from "./routes/ownerBroadcast.js";
import ownerUsersRoutes from "./routes/ownerUsers.js";
import ownerSellersRoutes from "./routes/ownerSellers.js";
import ownerAnalyticsRoutes from "./routes/ownerAnalytics.js";
import ownerGstr8Routes from "./routes/ownerGstr8.js";
import ownerReportsRoutes from "./routes/ownerReports.js";
import sellerReportsRoutes from "./routes/sellerReports.js";
import sellerCatalogRoutes from "./routes/sellerCatalog.js";
import sellerOrdersRoutes from "./routes/sellerOrders.js";
import sellerAccountRoutes from "./routes/sellerAccount.js";
import sellerQuoteRoutes from "./routes/sellerQuotes.js";
import appUserRoutes from "./routes/appUser.js";
import subscriptionRoutes from "./routes/subscriptions.js";
import ownerSubscriptionRoutes from "./routes/ownerSubscriptions.js";
import ownerMembershipRoutes from "./routes/ownerMembership.js";
import { ownerFreeGiftRouter } from "./routes/ownerFreeGifts.js";
import sellerSubscriptionRoutes from "./routes/sellerSubscriptions.js";
import internalRoutes from "./routes/internal.js";
import webhookRoutes from "./routes/webhooks.js";
import productIntakeRoutes from "./routes/productIntake.js";
import ownerProductIntakeRoutes from "./routes/ownerProductIntake.js";
import onboardingAgreementRoutes from "./routes/onboardingAgreements.js";
import deliveryOnboardingRoutes from "./routes/deliveryOnboarding.js";
import ownerOnboardingQueueRoutes from "./routes/ownerOnboardingQueue.js";
import { authMiddleware } from "./middleware/auth.js";
import { auditLoggerMiddleware } from "./middleware/auditLogger.js";
import { globalErrorHandler } from "./middleware/errorHandler.js";
import { initFirebase } from "./lib/firebase.js";
import { startOrderExpirySweeper } from "./services/orderExpiry.js";
import { startAbandonedCartSweeper } from "./services/abandonedCart.js";
import { startSubscriptionSweeper } from "./services/subscriptionEngine.js";
import { startQuotePaymentSweeper } from "./services/quotePayment.js";
import { startAccountDeletionSweeper } from "./services/accountDeletion.js";
import prisma from "./lib/prisma.js";

const app = express();
const PORT = parseInt(process.env.PORT || "4000", 10);

// Behind Nginx/Cloud load balancer: trust the first proxy so req.ip and
// express-rate-limit see the real client IP (not the proxy's).
app.set("trust proxy", 1);

// Explicit alongside helmet()'s hidePoweredBy (which already strips this) — Express sets
// "X-Powered-By: Express" by default, revealing the framework to anyone probing headers.
app.disable("x-powered-by");

// ─── Security headers + gzip ────────────────────────────────────────
//
// This server only ever emits JSON (or a PDF byte stream for invoices/reports) — it never
// renders HTML, and it loads no scripts/styles/fonts/images of its own. So the CSP below is
// deliberately close to deny-everything: there is no legitimate script/style/resource origin
// to allow, trusted or otherwise. Every directive is listed explicitly (useDefaults: false)
// so nothing is silently inherited from helmet's own defaults.
//
// CSP_REPORT_ONLY=true switches this to `Content-Security-Policy-Report-Only`, which only
// logs violations (via the report-uri below) instead of blocking anything — useful for a
// dry run against real traffic before enforcing. Defaults to enforcing (false) because this
// policy has no reason to ever legitimately fire here; flip the env var if a rollout wants
// to watch for violations first.
const CSP_REPORT_ONLY = process.env.CSP_REPORT_ONLY === "true";

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      reportOnly: CSP_REPORT_ONLY,
      directives: {
        // Deny-all baseline — every other directive below narrows a specific category, so
        // nothing falls through to an implicit default.
        defaultSrc: ["'none'"],
        // No inline or externally-sourced scripts of any kind (this server serves none).
        scriptSrc: ["'none'"],
        scriptSrcAttr: ["'none'"],
        scriptSrcElem: ["'none'"],
        // No stylesheets — no 'unsafe-inline', no wildcard https:.
        styleSrc: ["'none'"],
        styleSrcAttr: ["'none'"],
        styleSrcElem: ["'none'"],
        imgSrc: ["'none'"],
        fontSrc: ["'none'"],
        // A browser page that fetches this API is a different origin's concern (its own CSP
        // governs connect-src there); this only covers documents this server itself renders,
        // of which there are none — 'self' is a harmless, correctly-scoped floor.
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'none'"],
        frameSrc: ["'none'"],
        workerSrc: ["'none'"],
        manifestSrc: ["'none'"],
        // Never allow this origin to be embedded in a frame anywhere.
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        upgradeInsecureRequests: [],
        "report-uri": ["/api/csp-report"],
      },
    },
    // Also a pure-API concern, but keep the browser defaults for the rest (HSTS,
    // X-Content-Type-Options, Referrer-Policy, COOP/CORP, X-Frame-Options, etc.).
  })
);
app.use(compression()); // gzip JSON responses (~70% smaller over mobile networks)

// Sensitive browser features this API never needs — disable them all so an embedder can't
// request camera/mic/geolocation/payment access "on behalf of" this origin.
app.use((_req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    [
      "accelerometer=()", "camera=()", "geolocation=()", "gyroscope=()",
      "magnetometer=()", "microphone=()", "payment=()", "usb=()",
      "interest-cohort=()", "browsing-topics=()",
    ].join(", ")
  );
  next();
});

// ─── CORS ───────────────────────────────────────────────────────────
// Allowed origins come from env (comma-separated) so production dashboard
// domains work without code changes. Falls back to local dev origins.

const allowedOrigins = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : ["http://localhost:5173", "http://localhost:3000"]);

// Public product-intake endpoint accepts ANY origin (the form may be hosted on Netlify, served
// locally as a file://, or sent via WhatsApp — we can't enumerate origins ahead of time).
// All other endpoints keep the strict allowlist.
const PUBLIC_OPEN_PATHS = ["/api/app/public/product-intake"];

app.use(cors((req, callback) => {
  const isPublic = PUBLIC_OPEN_PATHS.some((p) => req.path.startsWith(p));
  if (isPublic) {
    callback(null, { origin: true, credentials: false });
    return;
  }
  callback(null, {
    origin: (origin, cb) => {
      // Allow same-origin/non-browser clients (no Origin header) and whitelisted origins.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  });
}));

// Capture the raw request body so the Razorpay webhook can verify its HMAC signature against the
// exact bytes Razorpay signed (a parsed-then-restringified body would not match).
app.use(express.json({
  limit: "10mb",
  verify: (req, _res, buf) => { (req as any).rawBody = buf; },
}));

// ─── Request ID + structured access log ────────────────────────────
// Assigns/propagates a request id and emits one JSON line per request on finish
// (method, path, status, latency). Enables tracing a request across logs.

app.use((req, res, next) => {
  const reqId = (req.headers["x-request-id"] as string) || randomUUID();
  (req as any).id = reqId;
  res.setHeader("X-Request-Id", reqId);
  const start = Date.now();

  // Capture response body for error responses (4xx/5xx) so logs show what went wrong.
  const originalJson = res.json.bind(res);
  (res as any).json = (body: any) => {
    (res as any)._body = body;
    return originalJson(body);
  };

  res.on("finish", () => {
    const logEntry: any = {
      level: res.statusCode >= 400 ? "error" : "info",
      reqId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - start,
    };
    if (res.statusCode >= 400 && (res as any)._body) {
      logEntry.error = (res as any)._body;
    }
    console.log(JSON.stringify(logEntry));
  });
  next();
});

// ─── Firebase Admin SDK ────────────────────────────────────────────

initFirebase();

// ─── Rate Limiting ──────────────────────────────────────────────────

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many requests, try again later", details: [] } },
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many login attempts, try again later", details: [] } },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many write operations, slow down", details: [] } },
});

app.use("/api", generalLimiter);

// ─── Health (no auth) ───────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "2.0.0", timestamp: new Date().toISOString() });
});

// CSP violation reports land here in report-only mode (or if a future relaxation of the
// policy ever misfires). Body is `application/csp-report` — a tiny dedicated json parser
// (not the shared 10mb express.json() above) keeps this cheap and isolated. Registered
// after generalLimiter (like every other /api route) so it can't be used to flood logs.
app.post("/api/csp-report", express.json({ type: ["application/csp-report", "application/json"] }), (req, res) => {
  console.log(JSON.stringify({ level: "warn", type: "csp-violation", report: req.body }));
  res.status(204).end();
});

// ─── App routes (public or Firebase-auth) ──────────────────────────

app.use("/api/app/config", storeConfigRoutes);
app.use("/api/app/me/fcm-token", fcmTokenRoutes);

// Public app endpoints (no auth)
app.use("/api/app/categories", publicCategoryRouter);
app.use("/api/app/super-categories", publicSuperCategoryRouter);
app.use("/api/app/products", publicCatalogRouter);
app.use("/api/app/banners", publicBannerRouter);
app.use("/api/app/deal-collages", publicDealCollageRouter);
app.use("/api/app/brands", publicBrandRouter);
// Public — submitted from the login page, before the user has an account.
app.use("/api/app/partner-applications", partnerApplicationRoutes);
// Public — static onboarding consent/agreement copy (nothing sensitive; see the file's own note
// on why this is server-served rather than hardcoded in the app).
app.use("/api/app/onboarding", onboardingAgreementRoutes);
// Internal automation (subscriptions engine) — shared-secret header, no user auth. Must stay BEFORE
// the global JWT guard so an external scheduler with no identity can reach it.
app.use("/api/app/internal", internalRoutes);
// Razorpay server-to-server payment webhook — verifies its own HMAC signature, so it must stay
// PUBLIC (before the JWT/Firebase guards). Idempotent confirmation of orders + wallet top-ups.
app.use("/api/app/webhooks", webhookRoutes);
// Public product-intake form (tools/add-products.html). Public POST has its own permissive CORS;
// admin GET/DELETE under /admin use a shared INTAKE_ADMIN_TOKEN. Must stay BEFORE the JWT guard.
app.use("/api/app/public/product-intake", productIntakeRoutes);
app.use("/api/app/cart", cartRoutes);
app.use("/api/app/coupons", appCouponRouter);
app.use("/api/app/orders", orderRoutes);
app.use("/api/app/owner/orders", ownerOrderRoutes);
app.use("/api/app/owner/catalog", ownerCatalogRoutes);
app.use("/api/app/owner/delivery-agents", ownerStaffRoutes);
app.use("/api/app/owner/complaints", ownerComplaintRoutes);
app.use("/api/app/owner/quote-requests", ownerQuoteRoutes);
app.use("/api/app/owner/partner-applications", ownerPartnerApplicationRoutes);
app.use("/api/app/owner/onboarding-queue", ownerOnboardingQueueRoutes);
app.use("/api/app/owner/broadcast", ownerBroadcastRoutes);
app.use("/api/app/owner/banners", ownerBannerRouter);
app.use("/api/app/owner/coupons", ownerCouponRouter);
app.use("/api/app/owner/deal-collages", ownerDealCollageRouter);
app.use("/api/app/owner/super-categories", ownerSuperCategoryRoutes);
app.use("/api/app/owner/brands", ownerBrandRouter);
app.use("/api/app/owner/users", ownerUsersRoutes);
app.use("/api/app/owner/sellers", ownerSellersRoutes);
app.use("/api/app/owner/analytics", ownerAnalyticsRoutes);
app.use("/api/app/owner/gstr8", ownerGstr8Routes);
app.use("/api/app/owner/reports", ownerReportsRoutes);
app.use("/api/app/owner/subscriptions", ownerSubscriptionRoutes);
app.use("/api/app/owner/membership", ownerMembershipRoutes);
app.use("/api/app/owner/free-gifts", ownerFreeGiftRouter);
// Owner review queue for the product-intake form (Firebase OWNER auth) — approve/reject/delete.
app.use("/api/app/owner/product-intake", ownerProductIntakeRoutes);
app.use("/api/app/seller/catalog", sellerCatalogRoutes);
app.use("/api/app/seller/brands", sellerBrandRouter);
app.use("/api/app/seller/orders", sellerOrdersRoutes);
app.use("/api/app/seller/subscriptions", sellerSubscriptionRoutes);
app.use("/api/app/seller/me", sellerAccountRoutes);
app.use("/api/app/seller/reports", sellerReportsRoutes);
app.use("/api/app/seller/quote-requests", sellerQuoteRoutes);
app.use("/api/app/delivery/orders", deliveryRoutes);
app.use("/api/app/delivery/onboarding", deliveryOnboardingRoutes);
// More-specific than "/api/app/me" → MUST be mounted before it (Express matches prefixes in order).
app.use("/api/app/me/subscriptions", subscriptionRoutes);
app.use("/api/app/me", appUserRoutes);

// ─── Auth routes (no auth middleware) ───────────────────────────────

app.use("/api/auth/login", authLimiter);
app.use("/api/auth", authRoutes);

// ─── Protected routes ───────────────────────────────────────────────

app.use("/api", authMiddleware as any);
app.use("/api", auditLoggerMiddleware as any);

app.use("/api/company", companyRoutes);
app.use("/api/categories", adminCategoryRouter);
app.use("/api/catalog", adminCatalogRouter);
app.use("/api/banners", adminBannerRouter);
app.use("/api/coupons", adminCouponRouter);
app.use("/api/orders", adminOrderRoutes);
app.use("/api/products", productRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/invoices", writeLimiter, invoiceRoutes);
app.use("/api/payments", writeLimiter, paymentRoutes);
app.use("/api/vendors", vendorRoutes);
app.use("/api/purchase-bills", purchaseBillRoutes);
app.use("/api/reports", reportRoutes);

// ─── Audit Log viewer endpoint ──────────────────────────────────────

app.get("/api/audit-logs", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const entityType = (req.query.entityType as string || "").slice(0, 50) || undefined;
    const userId = (req.query.userId as string || "").slice(0, 100) || undefined;
    const fromDate = req.query.fromDate as string | undefined;
    const toDate = req.query.toDate as string | undefined;

    const where: any = {};
    if (entityType) where.entityType = entityType;
    if (userId) where.userId = { contains: userId, mode: "insensitive" };
    if (fromDate || toDate) {
      where.timestamp = {};
      if (fromDate) where.timestamp.gte = new Date(fromDate);
      if (toDate) {
        const to = new Date(toDate);
        to.setHours(23, 59, 59, 999);
        where.timestamp.lte = to;
      }
    }

    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      success: true,
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: "Failed to fetch audit logs", details: [] } });
  }
});

// ─── Global error handler (must be last) ────────────────────────────

app.use(globalErrorHandler as any);

// ─── Start ──────────────────────────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Billing server running on http://0.0.0.0:${PORT}`);
  // Periodically release stock held by unpaid/abandoned online orders.
  startOrderExpirySweeper();
  // Nudge users who left items in cart (every 15 min, max 1 push per user per 24h).
  startAbandonedCartSweeper();
  // Generate due subscription orders + close monthly statements (backup driver — the external cron
  // hitting POST /api/app/internal/subscriptions/run is the reliable one on the free tier).
  startSubscriptionSweeper();
  // Recover bulk-quote payments captured at Razorpay but whose /pay confirmation never reached us.
  startQuotePaymentSweeper();
  // Permanently purge soft-deleted accounts whose grace window has elapsed (refund wallet + scrub PII).
  startAccountDeletionSweeper();
});

// Guard against slow-rate/low-and-slow DoS (e.g. Slowloris): cap how long a client can take to
// finish sending headers, and how long a whole request can stay open. Node's own defaults (60s /
// 300s) leave a connection tying up a worker far longer than any real client on this API needs.
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
