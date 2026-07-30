// Customer-facing DPDP notice + itemised consent purposes (Digital Personal Data Protection Rules,
// 2025 — Rule 3). Served over the API rather than hardcoded in the Android app, for the same reason
// as data/onboardingAgreements.ts: this copy WILL need correcting by a lawyer, and it must be
// fixable without shipping an app release.
//
// ⚠️ NOT LAWYER-REVIEWED. The *structure* below is what Rule 3 mandates (identity, itemised
// purposes, categories, retention, recipients, rights, withdrawal, grievance route, DPB route,
// language availability) and is accurate to the Rules. The *wording* is a working draft. Have it
// reviewed before 13 May 2027, when Rule 3 becomes enforceable.
//
// Bumping NOTICE_VERSION re-gates EVERY customer — the app compares the version they last accepted
// against this one and re-shows the notice on next launch. Bump it whenever a purpose is added,
// removed, or materially reworded. Do NOT bump it for a typo fix; a re-prompt for no real change
// trains people to tap through without reading, which is the opposite of informed consent.

export const NOTICE_VERSION = "customer-privacy-notice-v1";

/** Rule 3 requires a contactable person or role title — a generic mailbox alone is not enough. */
export const GRIEVANCE_OFFICER = {
  // ⚠️ Replace with the real person's name once appointed. A role title is legally acceptable, but
  // a name is better. This same human may also serve as the Consumer Protection (E-Commerce)
  // Rules, 2020 grievance officer — the two roles are separate obligations, one person can hold both.
  name: "Grievance Officer, Oneshelf",
  email: "oneshelfstore@gmail.com",
  phone: "",
  /** Days we commit to. The DPDP statutory ceiling is 90; committing to less is a promise we keep. */
  responseDays: 30,
};

export type ConsentPurpose = {
  /** Stable id — maps 1:1 onto a ConsentType enum value for the optional ones. */
  key: "MARKETING_COMMS" | "LOCATION_USE" | "DIAGNOSTICS";
  title: string;
  /** What is processed and why — Rule 3 wants purpose stated per category, not bundled. */
  description: string;
  /** Data categories touched by this purpose. */
  data: string;
};

/**
 * The purposes a customer can individually accept or refuse. Everything NOT listed here (account,
 * order fulfilment, payment, tax invoices, support) is processed because it is the very thing the
 * customer voluntarily provided their data for — it is notice-only and there is no toggle, because
 * offering a toggle we would have to ignore is worse than being honest that it is not optional.
 */
export const OPTIONAL_PURPOSES: ConsentPurpose[] = [
  {
    key: "MARKETING_COMMS",
    title: "Offers and promotions",
    description:
      "Send you notifications about discounts, coupons and new products. Turning this off does not affect order or delivery updates, which we always send.",
    data: "Your notification token and order history",
  },
  {
    key: "LOCATION_USE",
    title: "Use my location to fill in addresses",
    description:
      "When you tap \"Use my current location\" while adding an address, read your device location to fill in the address for you. We never read your location in the background.",
    data: "Approximate or precise device location, only in the moment you tap it",
  },
  {
    key: "DIAGNOSTICS",
    title: "Crash and performance reports",
    description:
      "Send anonymous crash and performance data so we can find and fix bugs. This does not include your name, phone number or order contents.",
    data: "Device model, app version, crash traces",
  },
];

/** Purposes we process regardless — shown, never toggled. Rule 3 still requires stating them. */
export const ESSENTIAL_PURPOSES: ConsentPurpose[] = [
  {
    key: "MARKETING_COMMS", // key unused for essentials; kept for a single shared shape on the client
    title: "Running your account and your orders",
    description:
      "Create and secure your account, take and deliver your orders, take payment, issue GST tax invoices, and answer your support requests.",
    data: "Name, phone number, optional email, delivery addresses, cart and order history, payment status",
  },
];

export const NOTICE = {
  version: NOTICE_VERSION,
  /** Rule 3(a) — who is processing the data. */
  fiduciary: {
    name: "Oneshelf",
    contactEmail: "oneshelfstore@gmail.com",
  },
  summary:
    "We collect only what we need to run your account and deliver your orders. We never sell your personal data. You can change or withdraw the optional permissions below at any time from Settings → Privacy & data.",
  essentialPurposes: ESSENTIAL_PURPOSES,
  optionalPurposes: OPTIONAL_PURPOSES,
  /** Rule 3 — retention. Plain-language, and it must match what accountDeletion.ts actually does. */
  retention:
    "We keep your account data for as long as your account exists. If you delete your account we remove or anonymise your name, email, phone, photos, addresses and cart after a roughly 15-day recovery window. Order and tax-invoice records are kept in anonymised form for the period Indian tax law requires.",
  /**
   * Rule 3 — recipients AND cross-border transfer. Naming them is the point; "trusted partners" is
   * not a disclosure, and omitting where the data physically sits is not one either.
   *
   * ⚠️ These are facts about the live infrastructure, not boilerplate — keep them true:
   *  - Railway app + Postgres are in the **Southeast Asia (Singapore)** region (`railway status`).
   *    The backend reaches the DB over `postgres.railway.internal`, and Railway private networking
   *    is region-scoped, so both services are necessarily in the same region.
   *  - Razorpay is an Indian entity and keeps payment data in India (RBI localisation).
   *  - Google Firebase runs on Google's global infrastructure, which includes servers outside India.
   * If the hosting region ever moves, this sentence has to move with it.
   */
  recipients:
    "Your delivery address and phone number are shared with the delivery agent assigned to your order, and with the seller fulfilling it. Payments are processed by Razorpay, which keeps payment data in India. Sign-in, notifications, file storage and crash reporting use Google Firebase. We do not share your data with anyone else except where the law requires it.",
  /** Rule 3 — the transfer-outside-India disclosure, stated separately so it cannot be skimmed past. */
  crossBorder:
    "Where your data is kept: our app servers and database are hosted in Singapore, and Google Firebase processes sign-in, notification, file-storage and crash data on Google's global infrastructure, which includes servers outside India. Your data is therefore stored and processed outside India. We use only providers permitted under Indian law and require them to protect your data to the same standard we do.",
  /** Rule 3 / §11-14 — the rights we must both state and actually implement. */
  rights: [
    "Ask us what personal data we hold about you and who we have shared it with (Settings → Privacy & data → Download my data).",
    "Correct anything that is wrong (Profile → Edit).",
    "Delete your account and have your personal data erased (Settings → Delete account).",
    "Nominate someone to exercise these rights for you if you die or cannot act (Settings → Privacy & data).",
    "Withdraw any optional permission at any time — it is as easy to switch off as it was to switch on.",
    "Complain to us, and if we do not resolve it, to the Data Protection Board of India.",
  ],
  grievance: GRIEVANCE_OFFICER,
  /** Rule 3 — escalation route must be stated, not just implied. */
  boardEscalation:
    "If we do not resolve your complaint within the time above, you may complain to the Data Protection Board of India.",
  /** Rule 3 — the Eighth Schedule language-availability statement. */
  languageNote:
    "This notice is available in English and Hindi in the app. Write to us and we will provide it in any of the 22 languages listed in the Eighth Schedule to the Constitution.",
  /** §9 — we do not knowingly serve under-18s; this is the confirmation the app asks for. */
  ageConfirmation:
    "I confirm I am 18 years of age or older.",
};
