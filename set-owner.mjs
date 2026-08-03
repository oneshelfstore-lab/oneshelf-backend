// Promote (or pre-register) the store owner BY PHONE, so they sign in with ordinary phone OTP
// instead of the app matching a hardcoded Firebase uid.
//
// firebaseAuth.ts links an unclaimed User row (firebaseUid: null) to the Firebase account by phone
// on first login and KEEPS its pre-assigned role — the same path ownerStaff.ts uses for delivery
// agents. So this row is all that's needed; the owner's first OTP login lands on the dashboard.
//
//   node set-owner.mjs 9876543210 "Store Owner"
//   node set-owner.mjs --demote 9999999999      → back to CUSTOMER (retire the old test number)
//
// ⚠️ Demote LAST, only after the real owner has logged in and been confirmed on the dashboard.
// Demoting first leaves nobody able to reach it.
//
// Against Railway (NOT localhost — this repo's .env DATABASE_URL points at localhost:5432):
//   railway run --service Postgres cmd /c "set DATABASE_URL=%DATABASE_PUBLIC_URL%&& node set-owner.mjs 9876543210"

import { PrismaClient } from '@prisma/client'

// Bare 10 digits is how User.phone is stored and how firebaseAuth.ts matches. Getting this wrong
// is silent: updateMany matches nothing, we create a SECOND row, and the OTP login links to it.
const normalize = (raw) => {
  const d = String(raw ?? '').replace(/\D/g, '')
  return d.length > 10 && d.startsWith('91') ? d.slice(-10) : d
}

console.assert(normalize('+91 98765 43210') === '9876543210', 'normalize: +91 with spaces')
console.assert(normalize('919876543210') === '9876543210', 'normalize: 91 prefix')
console.assert(normalize('9876543210') === '9876543210', 'normalize: bare 10')

const demote = process.argv[2] === '--demote'
const args = demote ? process.argv.slice(3) : process.argv.slice(2)
const phone = normalize(args[0])
const name = args[1] || 'Store Owner'

if (phone.length !== 10) {
  console.error(`Need a 10-digit phone number. Got: ${JSON.stringify(args[0])}`)
  process.exit(1)
}

const prisma = new PrismaClient()

const existing = await prisma.user.findFirst({ where: { phone } })

if (demote) {
  if (!existing) {
    console.error(`No user with phone ${phone} — nothing to demote.`)
    process.exit(1)
  }
  // Refuse to strip the last owner: that would leave the dashboard unreachable.
  const otherOwners = await prisma.user.count({ where: { role: 'OWNER', id: { not: existing.id } } })
  if (otherOwners === 0) {
    console.error(`${phone} is the ONLY OWNER. Promote the real owner first, then re-run.`)
    process.exit(1)
  }
  await prisma.user.update({ where: { id: existing.id }, data: { role: 'CUSTOMER' } })
  console.log(`Demoted ${existing.id} (${phone}) to CUSTOMER. ${otherOwners} owner(s) remain.`)
} else if (existing) {
  await prisma.user.update({
    where: { id: existing.id },
    // Keep a real name if they already have one (they may be an existing customer).
    data: { role: 'OWNER', name: existing.name && existing.name !== 'App User' ? existing.name : name },
  })
  console.log(`Promoted existing user ${existing.id} (${phone}) to OWNER. linked=${!!existing.firebaseUid}`)
} else {
  const created = await prisma.user.create({
    data: { name, phone, role: 'OWNER', phoneVerified: false },
  })
  console.log(`Pre-registered OWNER ${created.id} (${phone}). Links on their first OTP login.`)
}

const owners = await prisma.user.findMany({
  where: { role: 'OWNER' },
  select: { id: true, name: true, phone: true, firebaseUid: true },
})
console.log('All OWNER rows:', owners)

process.exit(0)
