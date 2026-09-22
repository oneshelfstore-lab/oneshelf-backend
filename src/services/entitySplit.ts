import prisma from "../lib/prisma.js";
import type { Prisma } from "@prisma/client";

/**
 * Is the house store the same legal entity as the platform? (runbook step 09)
 *
 * TODAY IT IS. Oneshelf the marketplace and Oneshelf the kirana shop are one registered business
 * with one GSTIN, so the platform charges the shop no commission, collects no Sec-52 TCS on the
 * shop's supplies and withholds no Sec 194-O TDS from it. Every one of those would be the business
 * charging itself: self-collected TCS on its own supply, and an outstandingBalance it owes itself.
 *
 * ⚠️ THIS IS WHY THE EXEMPTION IS A FLAG AND NOT A DELETION. The obvious cleanup — "the house store
 * is just another seller, drop the special case" — starts accruing all three against the shop on the
 * day it deploys. The flag makes the LEGAL date the moment it takes effect, not the deploy date.
 * It stays false until a second entity actually exists to bill (runbook step 23).
 *
 * ⚠️ AND IT IS ONE FLAG READ IN ONE PLACE, for the same reason TCS_RATE_PCT is one constant: the
 * exemption exists at five call sites, and an exemption that has to be lifted in five files is an
 * exemption that eventually gets lifted in four.
 *
 * ⚠️ WHAT THIS DELIBERATELY DOES NOT GOVERN: who ISSUES a customer invoice, and whose revenue it is.
 * Splitting the entities does not move the shop's sales off the shop's own GSTIN — the shop keeps
 * invoicing its customers exactly as it does now, under Company. What changes is that the PLATFORM
 * becomes a separate party that charges the shop for the service of selling through it. So
 * orderInvoice.ts's isStoreOwnSupply stays unconditional on purpose; flipping it would swap the
 * customer invoice onto a house Seller row that carries no GSTIN, no PAN and no address, and produce
 * a defective tax invoice the moment the flag moved. Step 23 owns that question.
 */
export async function houseSellerIsSeparateEntity(
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<boolean> {
  const cfg = await client.storeConfig.findFirst({ select: { houseSellerIsSeparateEntity: true } });
  return cfg?.houseSellerIsSeparateEntity === true;
}

/**
 * Does this seller's supply belong to the same legal entity as the platform — i.e. would charging it
 * be the business charging itself?
 *
 * ⚠️ A NULL seller is a pre-marketplace line with no seller recorded. Those are the store's own and
 * must stay exempt whatever the flag says, or a legacy row starts accruing commission to nobody.
 */
export function isSameLegalEntity(
  seller: { isHouse: boolean } | null | undefined,
  houseIsSeparate: boolean,
): boolean {
  if (!seller) return true;
  return seller.isHouse && !houseIsSeparate;
}
