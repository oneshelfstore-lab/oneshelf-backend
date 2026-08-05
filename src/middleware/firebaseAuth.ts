import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "@prisma/client";
import { admin, isFirebaseInitialized } from "../lib/firebase.js";
import prisma from "../lib/prisma.js";

export interface FirebaseAuthUser {
  id: string;
  firebaseUid: string;
  email: string | null;
  name: string;
  role: UserRole;
  phone: string | null;
  // The phone number THIS Firebase Auth session's ID token actually proves ownership of right
  // now (bare 10 digits, null if this account has no phone credential attached). Distinct from
  // `phone` above (the value on file in Postgres) — routes that let a client change the profile
  // phone (appUser.ts PUT /me) compare the two so a phone change can only be saved once Firebase
  // itself has verified it, not on the strength of an arbitrary client-submitted string.
  tokenPhone: string | null;
}

export interface FirebaseAuthRequest extends Request {
  appUser?: FirebaseAuthUser;
}

// ─── Phone-on-file gate: allowlist ───────────────────────────────────────────────────────────
//
// Paths a CUSTOMER with no phone on file may still reach. Everything needed to ADD a phone (and
// the setup screen's own supporting calls) stays open; everything else — cart, orders, wallet,
// subscriptions — is refused until a number is on file.
//
// `GET /api/app/config` and `/api/app/privacy-notice` are absent deliberately: both are mounted
// WITHOUT this middleware (the notice must be readable before signup), so the gate can never fire
// on them and an entry here would be dead weight.
//
// ⚠️ `/api/app/me` is EXACT, not a prefix. As a prefix it would re-open every /me/* sub-resource
// (wallet, orders, data-export, subscriptions) that this gate exists to close.
const PHONELESS_EXACT = new Set(["/api/app/me"]);
const PHONELESS_PREFIXES = [
  "/api/app/me/consents", // the DPDP notice gate can run before setup completes
  "/api/app/me/fcm-token", // device push registration happens at app start
  "/api/app/me/referral", // ProfileSetupScreen renders its referral field ABOVE the phone step
];

/**
 * True when [originalUrl] is reachable by a customer who has no phone number yet.
 * Pure (no request object) so it can be unit-tested without mocking Express or Prisma.
 */
export function isPhonelessAllowedPath(originalUrl: string): boolean {
  const path = (originalUrl.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
  if (PHONELESS_EXACT.has(path)) return true;
  return PHONELESS_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

// Play Integrity, via Firebase App Check. The Android app attaches a token as
// `X-Firebase-AppCheck` (release builds only — see app/src/release/.../AppCheckInit.kt) proving
// the request comes from a genuine, unmodified install of this app on a genuine device.
//
// ⚠️ Starts in LOG-ONLY mode by design, matching Firebase's own recommended rollout: watch the
// App Check "Metrics" tab (or these warn logs) for a stretch with real traffic BEFORE flipping
// APP_CHECK_ENFORCE=true — enforcing on day one with no verification data risks locking out
// debug builds whose device hasn't been registered with a debug token in Firebase Console, or
// any client whose Play Integrity attestation fails because the GCP project isn't linked yet in
// Play Console → Play Integrity API → Project configuration.
const APP_CHECK_ENFORCE = process.env.APP_CHECK_ENFORCE === "true";

export async function firebaseAuthMiddleware(
  req: FirebaseAuthRequest,
  res: Response,
  next: NextFunction,
) {
  if (!isFirebaseInitialized()) {
    return res.status(503).json({
      success: false,
      error: {
        code: "FIREBASE_NOT_CONFIGURED",
        message: "Firebase is not configured on the server",
        details: [],
      },
    });
  }

  const appCheckHeader = req.headers["x-firebase-appcheck"];
  const appCheckToken = Array.isArray(appCheckHeader) ? appCheckHeader[0] : appCheckHeader;
  if (appCheckToken) {
    try {
      await admin.appCheck().verifyToken(appCheckToken);
    } catch (e) {
      console.warn(
        `App Check REJECTED for ${req.method} ${req.originalUrl}: ${(e as Error).message}`,
      );
      if (APP_CHECK_ENFORCE) {
        return res.status(401).json({
          success: false,
          error: {
            code: "APP_CHECK_INVALID",
            message: "Failed device/app integrity check",
            details: [],
          },
        });
      }
    }
  } else if (APP_CHECK_ENFORCE) {
    // No header at all — either a pre-App-Check app build, or a debug build (App Check is
    // release-only client-side). Only rejected once enforcement is actually on.
    return res.status(401).json({
      success: false,
      error: {
        code: "APP_CHECK_MISSING",
        message: "Missing device/app integrity token",
        details: [],
      },
    });
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid authorization header",
        details: [],
      },
    });
  }

  try {
    const idToken = header.slice(7);
    const decoded = await admin.auth().verifyIdToken(idToken);

    // Bare-10-digit phone the TOKEN claims for this session (matches how we store it: strip
    // +91 / spaces / dashes). Hoisted above the user lookup — needed both for first-login
    // auto-linking below AND for req.appUser.tokenPhone on every request, new user or not.
    const phone10 = decoded.phone_number
      ? decoded.phone_number.replace(/\D/g, "").slice(-10)
      : null;

    let user = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
    });

    // Second lookup: this uid may be a SECONDARY credential linked to a row whose primary
    // firebaseUid is something else (see the phone-takeover branch below). Only checked when
    // the direct hit above misses — the common case never pays for this extra query.
    if (!user) {
      const linked = await prisma.linkedCredential.findUnique({
        where: { firebaseUid: decoded.uid },
        include: { user: true },
      });
      if (linked) user = linked.user;
    }

    // Restore-on-login: a soft-deleted account still within its grace window is reactivated the
    // moment the user signs back in — this is how "sign in again to cancel deletion" works. (A
    // fully purged account has firebaseUid=null, so it isn't found here and gets a fresh row below.)
    if (user && user.deletionStatus === "PENDING_DELETION") {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { deletionStatus: "ACTIVE", deletedAt: null },
      });
    }

    if (!user) {
      const email = decoded.email ?? null;

      // 1) Link by PHONE — this is what lets the owner PRE-REGISTER a delivery agent
      //    (or any role) by phone number before that person has ever logged in. On
      //    their first phone-OTP login we attach this Firebase account to the row the
      //    owner created, keeping the pre-assigned role (e.g. DELIVERY).
      //    Two rows qualify: a genuinely UNCLAIMED row (firebaseUid: null), or a
      //    CUSTOMER row whose phone was never actually proven (phoneVerified: false —
      //    e.g. a Google-signed-in account that once had a number typed into its
      //    profile but never ran it through real Firebase phone verification). A live
      //    phone-OTP token is stronger proof of that number than an unverified field,
      //    so it takes over the row instead of spawning a duplicate. Scoped to
      //    CUSTOMER + same-phone only — a SELLER/DELIVERY/OWNER row, or a row whose
      //    phone IS already verified (a real second person legitimately sharing a
      //    number), is never silently repointed here.
      // When the matched row already answers to a DIFFERENT firebaseUid (the takeover case),
      // that credential is recorded as a LinkedCredential instead of overwriting the row's
      // primary firebaseUid — so the original sign-in method (e.g. Google) keeps resolving to
      // this same row too, rather than getting silently orphaned into re-creating a duplicate.
      //
      // ⚠️ TWO SEPARATE LOOKUPS, and the role scoping differs between them. Collapsing them into
      // one `role: "CUSTOMER"` query is what made an approved delivery applicant log in as a
      // brand-new CUSTOMER instead of reaching their onboarding form:
      //
      // (a) UNCLAIMED row (firebaseUid: null) — ANY role. This IS the pre-registration mechanism.
      //     ownerStaff.ts POST /, provisionDeliveryRider and provisionSeller all create a row
      //     carrying the partner's role and NO firebase account, precisely so that person's first
      //     phone-OTP login attaches to it and keeps that role. Scoping this to CUSTOMER made every
      //     one of those paths silently mint a duplicate customer account instead, leaving the real
      //     DELIVERY/SELLER row unclaimed and permanently unreachable by its owner.
      // (b) TAKEOVER of a row that ALREADY answers to another credential — CUSTOMER only, and that
      //     restriction is load-bearing: a live phone-OTP token must never be able to walk into an
      //     unverified SELLER/DELIVERY/OWNER account on the strength of holding the number.
      //
      // Ordered (a) then (b) rather than one OR'd query on purpose: with both a pre-registered
      // partner row and an old unverified customer row on the same number, findFirst's row order is
      // arbitrary — and losing that coin flip reproduces this exact bug intermittently.
      const phoneVariants = phone10 ? [phone10, `+91${phone10}`, `91${phone10}`] : [];
      const unclaimed = phone10
        ? await prisma.user.findFirst({
            where: { phone: { in: phoneVariants }, firebaseUid: null },
            orderBy: { createdAt: "asc" },
          })
        : null;
      const byPhone =
        unclaimed ??
        (phone10
          ? await prisma.user.findFirst({
              where: {
                role: "CUSTOMER",
                phone: { in: phoneVariants },
                phoneVerified: false,
              },
            })
          : null);

      if (byPhone && !byPhone.firebaseUid) {
        // Genuinely unclaimed row (e.g. owner pre-registered this phone) — first claim.
        user = await prisma.user.update({
          where: { id: byPhone.id },
          data: { firebaseUid: decoded.uid, phone: phone10, phoneVerified: true },
        });
      } else if (byPhone) {
        // Already answers to another credential (its phone was just never verified there).
        // Link this uid alongside it rather than reassigning — both sign-ins keep working.
        await prisma.linkedCredential.upsert({
          where: { firebaseUid: decoded.uid },
          create: { firebaseUid: decoded.uid, userId: byPhone.id },
          update: {},
        });
        user = await prisma.user.update({
          where: { id: byPhone.id },
          data: { phone: phone10, phoneVerified: true },
        });
      } else {
        // 2) Link by e-mail (Google). User.email is @unique, so a row may already hold
        //    this e-mail (a seeded dashboard user, or a phone-auth account that saved the
        //    same e-mail). A blind create would throw P2002 and surface as a bogus 401.
        const byEmail = email
          ? await prisma.user.findUnique({ where: { email } })
          : null;

        if (byEmail && !byEmail.firebaseUid && decoded.email_verified) {
          // The Google token proves ownership of the e-mail — link the Firebase
          // account to the existing row (keeps role, orders, addresses).
          user = await prisma.user.update({
            where: { id: byEmail.id },
            data: { firebaseUid: decoded.uid },
          });
        } else {
          // 3) No match — create a fresh customer row.
          user = await prisma.user.create({
            data: {
              firebaseUid: decoded.uid,
              // If the e-mail is taken by a row we can't link to, create without it.
              email: byEmail ? null : email,
              // Leave blank (not "App User"/the phone number) when Firebase gave no real name —
              // decoded.name is always null for phone auth. A blank name is what makes the app's
              // `user.name.isBlank()` check route a brand-new phone-OTP signup into Profile Setup
              // ONCE to collect a real name; falling back to the phone number here (as before) made
              // the name look non-blank, so setup was silently skipped and the phone number itself
              // got stored as the customer's "name" forever (ownerSellers.ts's `looksLikePhone`
              // helper exists because of this exact same failure mode elsewhere).
              name: decoded.name ?? "",
              phone: phone10,
              role: "CUSTOMER",
              phoneVerified: !!decoded.phone_number,
            },
          });
        }
      }
    }

    // ─── Mirror the Postgres role into a Firebase custom claim ────────────────────────────────
    //
    // firestore.rules and storage.rules used to identify the owner by a HARDCODED uid string, while
    // this API's authority is User.role in Postgres — two sources of truth that could disagree, and
    // which made rotating or adding an owner a rules edit + redeploy. The rules now read
    // request.auth.token.role instead, and this is what puts it there.
    //
    // Done HERE rather than at the ~8 places role changes (ownerUsers, ownerStaff, ownerSellers,
    // partner-application provisioning, the phone-link branch above, …) because a sync that has to
    // be remembered at N call sites is a sync that eventually gets missed. This runs on every
    // authenticated request, sees the authoritative row, and self-heals: existing users get their
    // claim on their next API call, so no backfill script is needed.
    //
    // The write only fires when the claim actually differs from the DB — `decoded` already carries
    // the token's current custom claims, so steady state costs one string comparison and no I/O.
    //
    // ⚠️ The claim reaches the RULES only after the client's next ID-token refresh (Firebase does
    // this roughly hourly; the app can force it with getIdToken(true)). So there is a window where
    // the DB says OWNER and the token does not yet. That is exactly why the rules accept the legacy
    // hardcoded uid as well for now — see the comment in firestore.rules.
    //
    // Best-effort: a claim write must never turn a working request into a 401.
    if ((decoded as Record<string, unknown>).role !== user.role) {
      try {
        await admin.auth().setCustomUserClaims(decoded.uid, { role: user.role });
      } catch (e) {
        console.error("setCustomUserClaims failed for", decoded.uid, e);
      }
    }

    req.appUser = {
      id: user.id,
      firebaseUid: user.firebaseUid!,
      email: user.email,
      name: user.name,
      role: user.role,
      phone: user.phone,
      tokenPhone: phone10,
    };

    // ─── Phone-on-file gate ───────────────────────────────────────────────────────────────────
    //
    // "A customer cannot use the app without a phone number; Gmail is optional." Until now that
    // rule lived ONLY in the Android UI (ProfileSetupScreen + SplashViewModel routing), so a
    // phone-less token could still call every endpoint directly. Mirrors the dashboard's
    // requirePasswordChanged gate (middleware/auth.ts): refuse with a distinct code the client can
    // route on, while leaving the endpoints needed to FIX it reachable (see the allowlist above).
    //
    // Done HERE rather than as an `app.use`: every /api/app/* router mounts this middleware itself
    // and there is no single parent mount, so one check covers all ~40 routers with no mount-order
    // surgery — and a router added later is gated automatically instead of being forgotten.
    //
    // ⚠️ CUSTOMER ONLY, and that is load-bearing. Owner/seller/delivery rows legitimately exist
    // with no phone (a seeded owner, dashboard-only staff), and gating them is the owner-lockout
    // trap this codebase has been bitten by before. Partner rows are provisioned BY phone anyway.
    if (user.role === "CUSTOMER" && !user.phone && !isPhonelessAllowedPath(req.originalUrl)) {
      return res.status(403).json({
        success: false,
        error: {
          code: "PHONE_REQUIRED",
          message: "Add and verify your phone number to continue.",
          details: [],
        },
      });
    }

    next();
  } catch (e) {
    // Not only bad tokens land here — DB failures during the auto-create do too.
    console.error("firebaseAuthMiddleware error:", e);
    return res.status(401).json({
      success: false,
      error: {
        code: "TOKEN_INVALID",
        message: "Firebase ID token is invalid or expired",
        details: [],
      },
    });
  }
}

export function requireAppRole(...roles: UserRole[]) {
  return (req: FirebaseAuthRequest, res: Response, next: NextFunction) => {
    if (!req.appUser) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Not authenticated", details: [] },
      });
    }
    if (!roles.includes(req.appUser.role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: `This action requires one of these roles: ${roles.join(", ")}`,
          details: [],
        },
      });
    }
    next();
  };
}
