import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// opus-studio.xyz moved Croatian to the root on 2026-10-03: guides live at /vodici/<slug>
// and the old /hr/vodici/<slug> answers with a 301. Packages and prepared campaigns from
// before the move still carry the /hr form, so it is accepted and rewritten to the current
// URL (verifyGuide refuses redirects, so the old form could never be activated).
const GUIDE_PATH = /^\/(?:hr\/)?vodici\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
export function currentGuideUrl(value: string) {
  const slug = new URL(value).pathname.match(GUIDE_PATH)?.[1];
  return slug ? `https://opus-studio.xyz/vodici/${slug}` : value;
}
export function sameGuide(stored: string | undefined, guide: string) {
  if (!stored) return false;
  try { return currentGuideUrl(stored) === currentGuideUrl(guide); } catch { return false; }
}
export const guideUrl = z.string().url().refine((value) => {
  const u = new URL(value);
  return u.origin === "https://opus-studio.xyz" && GUIDE_PATH.test(u.pathname) && !u.search && !u.hash;
}).transform(currentGuideUrl);
export const prepareSchema = z.object({
  key: z.string().min(1).max(160),
  instagramId: z.string().regex(/^\d+$/),
  name: z.string().trim().min(1).max(100),
  guideUrl,
  keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(10),
  dmMessage: z.string().trim().min(1).max(1000).refine((v) => v.includes("{link}")),
  // Optional campaign flow, same fields the campaign builder writes. The follow
  // gate runs on the opening DM's button tap, so it requires the opening DM.
  openingDmMessage: z.string().trim().min(1).max(1000).optional(),
  openingDmButtonLabel: z.string().trim().min(1).max(64).optional(),
  linkButtonLabel: z.string().trim().min(1).max(20).optional(),
  followGateMessage: z.string().trim().min(1).max(1000).optional(),
  publicReplyMessages: z.array(z.string().trim().min(1).max(1000)).min(1).max(10).optional(),
}).strict()
  .refine((b) => !b.openingDmMessage === !b.openingDmButtonLabel, { message: "Opening DM needs a message and a button label" })
  .refine((b) => !b.followGateMessage || Boolean(b.openingDmMessage), { message: "Follow gate needs the opening DM" });
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
  const parsed = guideUrl.safeParse(url);
  if (!parsed.success || parsed.data !== url) throw new Error("Invalid guide URL");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000), cache: "no-store" });
  const html = await response.text();
  const canonical = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0];
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")
    || !canonical?.includes(url) || !html.includes("cx-prose") || !html.includes("<h1")) {
    throw new Error("Guide is not publicly ready");
  }
}
