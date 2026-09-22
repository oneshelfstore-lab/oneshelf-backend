import { Router, type Response } from "express";
import { sendError, ValidationError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import {
  RETURN_TYPES,
  assertPeriod,
  listFiledPeriods,
  markPeriodFiled,
  unmarkPeriodFiled,
  type ReturnType as GstReturnType,
} from "../services/filedPeriods.js";

// Marking a GST period filed (runbook step 18). Mounted at /api/app/owner/filed-periods, OWNER auth.
//
// ⚠️ Deliberately a MANUAL action taken after the return has actually been submitted, never
// automatic. A period that filed itself on a schedule would freeze numbers the owner had not yet
// looked at, and un-freezing after the fact is a worse conversation than filing late.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

function parseReturnType(raw: unknown): GstReturnType {
  const t = String(raw ?? "").trim().toUpperCase();
  if (t !== RETURN_TYPES.GSTR1 && t !== RETURN_TYPES.GSTR8) {
    throw new ValidationError("returnType must be GSTR1 or GSTR8");
  }
  return t;
}

router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const raw = String(req.query.returnType ?? "").trim();
    const returnType = raw ? parseReturnType(raw) : undefined;
    res.json({ success: true, data: await listFiledPeriods(returnType) });
  } catch (e) { sendError(res, e); }
});

router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const returnType = parseReturnType(body.returnType ?? req.query.returnType);
    const period = assertPeriod(String(body.period ?? req.query.period ?? "").trim());
    const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
    const result = await markPeriodFiled(returnType, period, req.appUser?.id ?? null, note);
    res.json({ success: true, data: result });
  } catch (e) { sendError(res, e); }
});

// Un-file — for a period marked in error, before the return actually goes out.
router.delete("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const returnType = parseReturnType(req.query.returnType);
    const period = assertPeriod(String(req.query.period ?? "").trim());
    const removed = await unmarkPeriodFiled(returnType, period);
    res.json({ success: true, data: { returnType, period, removed } });
  } catch (e) { sendError(res, e); }
});

export default router;
