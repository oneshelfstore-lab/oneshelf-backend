// Placeholder partner-agreement / consent copy for Phase 1 of the Seller & Delivery-Partner
// Onboarding flow (SELLER_DELIVERY_ONBOARDING_PLAN.md §7): "the actual seller/delivery partner
// agreement text ... needs to come from you or a lawyer, not be drafted by an agent." This text
// is NOT legal advice and has NOT been reviewed by a lawyer — it exists only so the consent
// screens + versioned-consent MECHANISM can be built, tested, and shipped now.
//
// ⚠️ Replace the *_TEXT constants below with real legal copy before relying on this for anything
// beyond internal testing. When you do, bump the matching *_VERSION string — Phase 2's
// version-re-prompt logic (not yet built) will use a version bump to re-gate every existing
// partner until they re-accept the new text, exactly like a T&C update should work.
//
// Served over the API (not hardcoded in the Android app) specifically so this text can be fixed
// without an app release.

export const PARTNER_AGREEMENT_VERSION = "seller-agreement-v1";
export const DELIVERY_AGREEMENT_VERSION = "delivery-agreement-v1";
export const SENSITIVE_DATA_CONSENT_VERSION = "sensitive-data-v1";
export const LOCATION_CONSENT_VERSION = "location-tracking-v1";

export const SELLER_PARTNER_AGREEMENT_TEXT = `Oneshelf Seller Partner Agreement (draft)

By submitting your shop for review, you agree to sell products through the Oneshelf app under
these terms:

1. You are responsible for the accuracy of the legal name, GSTIN, and other business details you
   provide, and for keeping your GST registration current for as long as you sell through Oneshelf.
2. Oneshelf charges a commission on each sale, shown to you before you accept it, deducted from
   your payout.
3. You are responsible for packing and handing over orders accurately and on time.
4. Either party may end this partnership with notice; Oneshelf may suspend a shop immediately for
   a serious violation (e.g. repeated wrong/missing items, expired-goods complaints, fraud).
5. A designated grievance officer (named in your onboarding form) is the contact point for
   customer complaints about your shop, per the Consumer Protection (E-Commerce) Rules, 2020.

This is placeholder text pending final legal review — do not treat it as a complete or binding
agreement.`;

export const DELIVERY_PARTNER_AGREEMENT_TEXT = `Oneshelf Delivery Partner Agreement (draft)

By completing this onboarding, you agree to deliver/pick up orders for Oneshelf under these terms:

1. You are responsible for the accuracy of the identity, vehicle, and license details you provide.
2. You will handle cash-on-delivery collections honestly and settle them as directed in the app.
3. You will follow the handover verification steps (OTP / photo) for every order.
4. Either party may end this partnership with notice; Oneshelf may suspend your account
   immediately for a serious violation (e.g. mishandled cash, unsafe conduct, fraud).

This is placeholder text pending final legal review — do not treat it as a complete or binding
agreement, and it does not by itself determine your employment/worker classification.`;

export const SENSITIVE_DATA_CONSENT_TEXT = `We need to collect some sensitive documents to verify
your identity and business (e.g. PAN, GSTIN certificate, bank proof, and — for delivery partners —
a government ID photo, driving licence, and vehicle papers). We use these ONLY to verify you and
run your account, keep them only as long as your partnership is active or as required by law, and
never store a full Aadhaar number even if you upload an Aadhaar photo — it's used only for a human
visual check. You can ask us what we hold about you at any time.`;

export const LOCATION_TRACKING_CONSENT_TEXT = `While you're on an active delivery, Oneshelf uses
your device's location to show your live position to the customer and to the store, and to confirm
you've reached the pickup/drop point. Location is not tracked when you're not on an active order.`;
