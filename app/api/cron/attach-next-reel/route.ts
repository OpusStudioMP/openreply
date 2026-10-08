import { NextRequest, NextResponse } from "next/server";
import { attachNextReels } from "@/lib/polling/attach-next-reel";

/**
 * Binds "next reel" campaigns to a real post (see lib/polling/attach-next-reel).
 *
 * The worker runs the same pass every 5 minutes; this daily cron (vercel.json)
 * is only a backstop for when the worker is down.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const data = await attachNextReels();
  return NextResponse.json({ success: true, data });
}
