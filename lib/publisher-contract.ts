import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const guideUrl = z.string().url().refine((value) => {
  const u = new URL(value);
  return u.origin === "https://opus-studio.xyz" && /^\/hr\/vodici\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(u.pathname) && !u.search && !u.hash;
});
export const prepareSchema = z.object({
  key: z.string().min(1).max(160),
  instagramId: z.string().regex(/^\d+$/),
  name: z.string().trim().min(1).max(100),
  guideUrl,
  keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(10),
  dmMessage: z.string().trim().min(1).max(1000).refine((v) => v.includes("{link}")),
}).strict();
export const activateSchema = z.object({
  key: z.string().min(1).max(160),
  instagramId: z.string().regex(/^\d+$/),
  postId: z.string().regex(/^\d+$/),
}).strict();

export function publisherId(key: string) {
  return `publisher-${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}
export function authorizedPublisher(header: string | null, secret: string | undefined) {
  if (!secret || secret.length < 32 || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function publisherSecret() {
  if (process.env.PUBLISHER_SECRET) return process.env.PUBLISHER_SECRET;
  const parent = process.env.CRON_SECRET;
  // The publisher receives only this purpose-specific child key, never the
  // cron credential itself. Rotation of CRON_SECRET rotates the child key too.
  return parent && parent.length >= 16 ? createHmac("sha256", parent).update("opus-publisher-v1").digest("hex") : undefined;
}

export async function verifyGuide(url: string) {
  if (!guideUrl.safeParse(url).success) throw new Error("Invalid guide URL");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000), cache: "no-store" });
  const html = await response.text();
  const canonical = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0];
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")
    || !canonical?.includes(url) || !html.includes("cx-prose") || !html.includes("<h1")) {
    throw new Error("Guide is not publicly ready");
  }
}
