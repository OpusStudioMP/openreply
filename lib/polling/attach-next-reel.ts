/**
 * Binds "next reel" campaigns to the real post once it is published.
 *
 * Instagram sends no webhook when new media is published, so we poll the
 * account's recent media. This used to run only from the daily Vercel cron,
 * which meant a reel posted at 17:00 got its campaign the next morning and
 * every comment in the first hours was missed. The worker now calls it on its
 * 5-minute poll, right before the comment sweep, so a freshly bound campaign
 * also catches the comments that arrived before it was bound.
 *
 * A campaign binds to the earliest reel posted after the campaign was created
 * whose caption contains one of the campaign's keywords ("Komentiraj SUSTAV").
 * A reel without the keyword never takes the campaign, so posting some other
 * reel first can no longer steal it, and several campaigns can wait at once.
 */

import { prisma } from "@/lib/db/client";
import { getUserMedia, type InstagramMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

export interface PendingCampaign {
  id: string;
  createdAt: Date;
  keywords: string[];
}

function isReel(media: InstagramMedia): boolean {
  return media.media_product_type === "REELS";
}

/**
 * The reel a waiting campaign should bind to, or null if it is not posted yet.
 * `taken` holds media already bound to another campaign on the same account.
 */
export function pickNextReel(
  campaign: PendingCampaign,
  media: InstagramMedia[],
  taken: Set<string>
): InstagramMedia | null {
  const candidates = media
    .filter(
      (m) =>
        isReel(m) &&
        !taken.has(m.id) &&
        new Date(m.timestamp).getTime() > campaign.createdAt.getTime()
    )
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  return (
    candidates.find(
      (m) => Boolean(m.caption) && matchKeywords(m.caption!, campaign.keywords, true).matched
    ) ?? null
  );
}

export interface AttachResult {
  checked: number;
  bound: number;
  failedAccounts: number;
}

/** One pass over every campaign waiting for its next reel. */
export async function attachNextReels(): Promise<AttachResult> {
  const pending = await prisma.automation.findMany({
    where: { pendingNextReel: true },
    include: { instagramAccount: true },
    orderBy: { createdAt: "asc" },
  });
  if (pending.length === 0) return { checked: 0, bound: 0, failedAccounts: 0 };

  // Group by connected account so each account's media is fetched only once.
  const byAccount = new Map<string, typeof pending>();
  for (const automation of pending) {
    const list = byAccount.get(automation.instagramAccountId);
    if (list) list.push(automation);
    else byAccount.set(automation.instagramAccountId, [automation]);
  }

  let bound = 0;
  let failedAccounts = 0;

  for (const [accountId, automations] of byAccount) {
    const account = automations[0].instagramAccount;
    if (!account?.accessToken) continue;

    let media: InstagramMedia[];
    try {
      media = await getUserMedia(decryptToken(account.accessToken), 25);
    } catch (err) {
      failedAccounts += 1;
      console.error("[attach-next-reel] media fetch failed", accountId, err);
      continue;
    }

    const boundRows = await prisma.automation.findMany({
      where: { instagramAccountId: accountId, postId: { not: null } },
      select: { postId: true },
    });
    const taken = new Set(boundRows.map((row) => row.postId!));

    for (const automation of automations) {
      const reel = pickNextReel(automation, media, taken);
      if (!reel) continue;
      // Guarded update: a concurrent cron and worker pass bind it only once.
      const updated = await prisma.automation.updateMany({
        where: { id: automation.id, pendingNextReel: true },
        data: { postId: reel.id, postUrl: reel.permalink ?? null, pendingNextReel: false },
      });
      if (updated.count) {
        taken.add(reel.id);
        bound += 1;
        console.log(`[attach-next-reel] "${automation.name}" bound to ${reel.permalink ?? reel.id}`);
      }
    }
  }

  return { checked: pending.length, bound, failedAccounts };
}
