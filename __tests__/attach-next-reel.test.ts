import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "test-token" }));
import { pickNextReel } from "@/lib/polling/attach-next-reel";
import type { InstagramMedia } from "@/lib/meta/client";

const armed = new Date("2026-10-08T10:00:00Z");
const campaign = { id: "c1", createdAt: armed, keywords: ["SUSTAV", "sustav", "Sustav"] };
const reel = (id: string, timestamp: string, caption?: string, type = "REELS"): InstagramMedia => ({
  id, timestamp, caption, media_type: "VIDEO", media_product_type: type, permalink: `https://www.instagram.com/reel/${id}/`,
});

describe("pickNextReel", () => {
  it("binds the reel whose caption carries the keyword, not just the first new one", () => {
    const media = [
      reel("other", "2026-10-08T12:00:00Z", "Novi web je online, pogledaj"),
      reel("ours", "2026-10-08T15:00:00Z", "Tvojoj firmi ne treba AI. Komentiraj “SUSTAV” i javim ti se."),
    ];
    expect(pickNextReel(campaign, media, new Set())?.id).toBe("ours");
  });

  it("waits while no new reel mentions the keyword", () => {
    const media = [reel("other", "2026-10-08T12:00:00Z", "Bez ključne riječi")];
    expect(pickNextReel(campaign, media, new Set())).toBeNull();
  });

  it("ignores reels from before the campaign was armed, posts that are not reels and reels already taken", () => {
    const media = [
      reel("old", "2026-10-07T12:00:00Z", "Komentiraj SUSTAV"),
      reel("carousel", "2026-10-08T11:00:00Z", "Komentiraj SUSTAV", "FEED"),
      reel("taken", "2026-10-08T12:00:00Z", "Komentiraj SUSTAV"),
      reel("free", "2026-10-08T13:00:00Z", "komentiraj sustav"),
    ];
    expect(pickNextReel(campaign, media, new Set(["taken"]))?.id).toBe("free");
  });

  it("takes the earliest matching reel when several mention the keyword", () => {
    const media = [
      reel("later", "2026-10-09T09:00:00Z", "Komentiraj SUSTAV"),
      reel("first", "2026-10-08T18:00:00Z", "Komentiraj SUSTAV"),
    ];
    expect(pickNextReel(campaign, media, new Set())?.id).toBe("first");
  });

  it("matches the keyword as a whole word only", () => {
    const media = [reel("near", "2026-10-08T12:00:00Z", "Sustavno radimo weba")];
    expect(pickNextReel(campaign, media, new Set())).toBeNull();
  });
});
