import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { admin, isFirebaseInitialized } from "../lib/firebase.js";
import { sendError, ValidationError } from "../lib/errors.js";
import { requireRole } from "../middleware/auth.js";

// Image upload for the web admin (category and collection pictures). The Android app uploads straight to
// Firebase Storage; the dashboard has no Firebase client, so it sends the (already downscaled) image here
// and gets back the same kind of public catalog URL the app's product photos use.
// ⚠️ Public catalogue art ONLY — private customer media (gate photos, voice notes) goes through
// lib/storageUrls.ts signed URLs instead, never a permanent token URL like this one.

export const adminUploadRouter = Router();

const MAX_BYTES = 2_000_000;
const FOLDERS = ["categories", "collections"] as const;

/** The real type of an image from its first bytes (never trust the declared type). Pure. */
export function sniffImage(b: Buffer): { mime: string; ext: string } | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

adminUploadRouter.post("/image", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const parsed = z.object({ dataBase64: z.string().min(100).max(2_800_000), folder: z.enum(FOLDERS) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid upload", parsed.error.errors);
    const buf = Buffer.from(parsed.data.dataBase64, "base64");
    if (buf.length > MAX_BYTES) throw new ValidationError("Image is too large (2 MB max)");
    const kind = sniffImage(buf);
    if (!kind) throw new ValidationError("Only JPEG, PNG or WebP images are allowed");

    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (!bucketName || !isFirebaseInitialized()) {
      return void res.status(503).json({ success: false, error: "Image upload isn't available right now." });
    }
    const token = randomUUID();
    const path = `catalog-admin/${parsed.data.folder}/${randomUUID()}.${kind.ext}`;
    await admin.storage().bucket(bucketName).file(path).save(buf, {
      contentType: kind.mime,
      metadata: { cacheControl: "public, max-age=31536000", metadata: { firebaseStorageDownloadTokens: token } },
    });
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
    res.status(201).json({ success: true, data: { url } });
  } catch (e) {
    sendError(res, e);
  }
});
