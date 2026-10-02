import { prisma } from "@/lib/db/client";
import { authorizedPublisher, activateSchema, prepareSchema, publisherId, verifyGuide, publisherSecret } from "@/lib/publisher-contract";
import { CREATOR_ACCOUNT_ID } from "@/lib/publisher-scope";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { decryptToken } from "@/lib/meta/oauth";
import { getMetaGraphApiVersion } from "@/lib/env";
import type { z } from "zod";

export const dynamic = "force-dynamic";

function denied(request: Request) {
  return !authorizedPublisher(request.headers.get("authorization"), publisherSecret());
}
async function account(instagramId: string) {
  const id = process.env.PUBLISHER_INSTAGRAM_ACCOUNT_ID || CREATOR_ACCOUNT_ID;
  if (!id) return null;
  return prisma.instagramAccount.findFirst({ where: { id, instagramId, username: "markopejic.ai" } });
}
function result(automation: { id: string; isActive: boolean; postId: string | null; trackedLinks: { slug: string }[] }) {
  return { id: automation.id, active: automation.isActive, postId: automation.postId,
    trackedUrl: automation.trackedLinks[0] ? buildTrackedUrl(automation.trackedLinks[0].slug) : null };
}

// The campaign fields a package controls, in the same shape the campaign
// builder stores (follow gate only with the opening DM; first public reply
// mirrored into the legacy single-message column).
function campaignContent(b: z.infer<typeof prepareSchema>) {
  const opening = Boolean(b.openingDmMessage && b.openingDmButtonLabel);
  const replies = b.publicReplyMessages ?? [];
  return {
    name: b.name, keywords: b.keywords, dmMessage: b.dmMessage,
    openingDmEnabled: opening,
    openingDmMessage: opening ? b.openingDmMessage! : null,
    openingDmButtonLabel: opening ? b.openingDmButtonLabel! : null,
    linkButtonLabel: b.linkButtonLabel ?? null,
    followGateEnabled: opening && Boolean(b.followGateMessage),
    followGateMessage: opening && b.followGateMessage ? b.followGateMessage : null,
    publicReplyEnabled: replies.length > 0,
    publicReplyMessage: replies[0] ?? null,
    publicReplyMessages: replies,
  };
}
type CampaignContent = ReturnType<typeof campaignContent>;
function sameContent(row: Partial<Record<keyof CampaignContent, unknown>>, c: CampaignContent) {
  const norm = (r: Partial<Record<keyof CampaignContent, unknown>>) => JSON.stringify({
    name: r.name, keywords: r.keywords, dmMessage: r.dmMessage,
    openingDmEnabled: r.openingDmEnabled ?? false, openingDmMessage: r.openingDmMessage ?? null,
    openingDmButtonLabel: r.openingDmButtonLabel ?? null, linkButtonLabel: r.linkButtonLabel ?? null,
    followGateEnabled: r.followGateEnabled ?? false, followGateMessage: r.followGateMessage ?? null,
    publicReplyEnabled: r.publicReplyEnabled ?? false, publicReplyMessage: r.publicReplyMessage ?? null,
    publicReplyMessages: r.publicReplyMessages ?? [],
  });
  return norm(row) === norm(c);
}

export async function GET(request: Request) {
  if (denied(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const ig = await prisma.instagramAccount.findFirst({ where: { id: process.env.PUBLISHER_INSTAGRAM_ACCOUNT_ID || CREATOR_ACCOUNT_ID, username: "markopejic.ai" }, select: { instagramId: true, username: true } });
  if (!ig) return Response.json({ error: "Creator account is not configured" }, { status: 503 });
  return Response.json({ ready: true, username: ig.username, instagramId: ig.instagramId });
}

// Preparation never activates or guesses the next reel. The stable key is
// deterministic and unique at the database level, including concurrent retries.
export async function POST(request: Request) {
  if (denied(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = prepareSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid campaign package" }, { status: 400 });
  const b = parsed.data;
  const ig = await account(b.instagramId);
  if (!ig) return Response.json({ error: "Creator account does not match" }, { status: 403 });
  try { await verifyGuide(b.guideUrl); }
  catch { return Response.json({ error: "Guide is not publicly ready" }, { status: 409 }); }
  const id = publisherId(b.key);
  const content = campaignContent(b);
  const existing = await prisma.automation.findUnique({ where: { id }, include: { trackedLinks: true } });
  if (existing && (existing.instagramAccountId !== ig.id || existing.workspaceId !== ig.workspaceId
    || existing.trackedLinks[0]?.destinationUrl !== b.guideUrl)) {
    return Response.json({ error: "This package key already has different content" }, { status: 409 });
  }
  if (existing && !sameContent(existing, content)) {
    // A prepared campaign may still be revised (e.g. adding the follow gate)
    // until it is activated on a real post. Live campaigns never change here.
    if (existing.isActive || existing.postId) {
      return Response.json({ error: "This package key already has different content" }, { status: 409 });
    }
    const revised = await prisma.automation.update({ where: { id }, data: content, include: { trackedLinks: true } });
    return Response.json(result(revised));
  }
  const automation = await prisma.automation.upsert({
    where: { id }, update: {},
    create: { id, workspaceId: ig.workspaceId, instagramAccountId: ig.id, ...content, isActive: false,
      pendingNextReel: false, matchAnyPost: false, matchAnyWord: false, wholeWordMatch: true,
      trackedLinks: { create: { workspaceId: ig.workspaceId, slug: generateTrackedLinkSlug(), destinationUrl: b.guideUrl, label: b.name } } },
    include: { trackedLinks: true },
  });
  if (automation.instagramAccountId !== ig.id || automation.workspaceId !== ig.workspaceId
    || !sameContent(automation, content) || automation.trackedLinks[0]?.destinationUrl !== b.guideUrl) {
    return Response.json({ error: "Concurrent package content conflict" }, { status: 409 });
  }
  return Response.json(result(automation));
}

export async function PATCH(request: Request) {
  if (denied(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = activateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid published post" }, { status: 400 });
  const b = parsed.data;
  const ig = await account(b.instagramId);
  if (!ig) return Response.json({ error: "Creator account does not match" }, { status: 403 });
  const id = publisherId(b.key);
  const automation = await prisma.automation.findFirst({ where: { id, instagramAccountId: ig.id, workspaceId: ig.workspaceId }, include: { trackedLinks: true } });
  if (!automation) return Response.json({ error: "Prepared campaign not found" }, { status: 404 });
  if (automation.postId && automation.postId !== b.postId) return Response.json({ error: "Campaign is already bound to another post" }, { status: 409 });
  try {
    await verifyGuide(automation.trackedLinks[0]?.destinationUrl ?? "");
    // Confirm ownership through the account's media edge. A caller-supplied ID
    // alone must never activate a campaign for another profile's post.
    const token = decryptToken(ig.accessToken);
    const url = new URL(`https://graph.instagram.com/${getMetaGraphApiVersion()}/${ig.instagramId}/media`);
    url.searchParams.set("fields", "id,permalink");
    url.searchParams.set("limit", "100");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000), cache: "no-store" });
    const media = await response.json();
    const post = response.ok && media.data?.find((p: { id: string }) => p.id === b.postId);
    if (!post) return Response.json({ error: "Published post is not visible on the creator account yet" }, { status: 409 });
    const updated = await prisma.automation.updateMany({
      where: { id, instagramAccountId: ig.id, OR: [{ postId: null }, { postId: b.postId }] },
      data: { postId: b.postId, postUrl: post.permalink, isActive: true, pendingNextReel: false, matchAnyPost: false },
    });
    if (!updated.count) return Response.json({ error: "Campaign changed during activation" }, { status: 409 });
    return Response.json({ id, active: true, postId: b.postId, postUrl: post.permalink });
  } catch {
    return Response.json({ error: "Guide or Instagram verification failed; campaign remains unchanged" }, { status: 409 });
  }
}
