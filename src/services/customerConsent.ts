// Customer-side DPDP consent state (Rules 2025, Rule 3). Reuses the existing append-only
// ConsentRecord ledger that the partner-onboarding flow already writes to — subjectType "USER".
//
// Why append-only rather than an upsert: §6 puts the burden of proving consent on us, so a
// withdrawal must leave the original grant intact and add a new row on top. That means every read
// has to reduce a history down to "latest wins", which is the one non-trivial bit here and is
// extracted as a pure function so it can be tested without a database.

import prisma from "../lib/prisma.js";
import { NOTICE_VERSION, OPTIONAL_PURPOSES } from "../data/customerPrivacyNotice.js";

export const OPTIONAL_CONSENT_TYPES = OPTIONAL_PURPOSES.map((p) => p.key);
export type OptionalConsentType = (typeof OPTIONAL_CONSENT_TYPES)[number];

export type ConsentRow = {
  consentType: string;
  version: string;
  granted: boolean;
  grantedAt: Date;
};

export type ConsentState = {
  /** Notice version this person last accepted, or null if they never have. */
  acceptedNoticeVersion: string | null;
  /** True when they must be re-shown the notice (never accepted, or accepted an older version). */
  needsNotice: boolean;
  /** Current answer per optional purpose. Absent = never answered = treated as NOT granted. */
  granted: Record<string, boolean>;
};

/**
 * Reduce a consent history to the current state. Latest row per consentType wins.
 *
 * ⚠️ Defaults every optional purpose to FALSE when there is no row. Rule 3 forbids pre-ticked
 * boxes, and "we have no record" must never read as "they said yes" — silence is a refusal.
 */
export function resolveConsentState(
  rows: ConsentRow[],
  currentNoticeVersion: string = NOTICE_VERSION,
): ConsentState {
  const latest = new Map<string, ConsentRow>();
  for (const r of rows) {
    const prev = latest.get(r.consentType);
    // Strictly newer wins; ties keep the first seen (callers pass newest-first).
    if (!prev || r.grantedAt.getTime() > prev.grantedAt.getTime()) latest.set(r.consentType, r);
  }

  const noticeRow = latest.get("PRIVACY_NOTICE");
  const acceptedNoticeVersion = noticeRow?.granted ? noticeRow.version : null;

  const granted: Record<string, boolean> = {};
  for (const type of OPTIONAL_CONSENT_TYPES) {
    granted[type] = latest.get(type)?.granted === true;
  }

  return {
    acceptedNoticeVersion,
    needsNotice: acceptedNoticeVersion !== currentNoticeVersion,
    granted,
  };
}

export async function getConsentState(userId: string): Promise<ConsentState> {
  const rows = await prisma.consentRecord.findMany({
    where: { subjectType: "USER", subjectId: userId },
    orderBy: { grantedAt: "desc" },
    select: { consentType: true, version: true, granted: true, grantedAt: true },
  });
  return resolveConsentState(rows);
}

/**
 * Record a consent decision set. `acceptNotice` writes the "I was shown notice vX" row; the
 * per-purpose entries write one row each. Unmentioned purposes are left alone (a Privacy-Centre
 * toggle sends only the one that changed).
 */
export async function recordConsents(
  userId: string,
  entries: { type: string; granted: boolean }[],
  acceptNotice: boolean,
): Promise<ConsentState> {
  const now = new Date();
  const rows = entries
    .filter((e) => (OPTIONAL_CONSENT_TYPES as string[]).includes(e.type))
    .map((e) => ({
      subjectType: "USER",
      subjectId: userId,
      consentType: e.type as never,
      version: NOTICE_VERSION,
      granted: e.granted,
      grantedAt: now,
      // Withdrawal is a first-class event, not an absence — stamp it so the ledger reads honestly.
      withdrawnAt: e.granted ? null : now,
    }));

  if (acceptNotice) {
    rows.push({
      subjectType: "USER",
      subjectId: userId,
      consentType: "PRIVACY_NOTICE" as never,
      version: NOTICE_VERSION,
      granted: true,
      grantedAt: now,
      withdrawnAt: null,
    });
  }

  if (rows.length > 0) await prisma.consentRecord.createMany({ data: rows });
  return getConsentState(userId);
}
