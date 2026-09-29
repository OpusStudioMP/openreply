import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrisma,
  mockSendPrivateReply,
  mockSendPrivateReplyWithLinkButton,
  mockDecryptToken,
  mockMatchKeywords,
  mockReserveDMSlot,
  mockQueueAdd,
  mockReserveWorkspaceDMSend,
  mockReleaseWorkspaceDMReservation,
  mockSendDirectMessage,
  mockRedis,
} = vi.hoisted(() => ({
  mockPrisma: {
    automation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    dmLog: {
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    instagramAccount: {
      findUnique: vi.fn(),
    },
    operationalEvent: {
      create: vi.fn(),
    },
  },
  mockSendPrivateReply: vi.fn(),
  mockSendPrivateReplyWithLinkButton: vi.fn(),
  mockDecryptToken: vi.fn(),
  mockMatchKeywords: vi.fn(),
  mockReserveDMSlot: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockReserveWorkspaceDMSend: vi.fn(),
  mockReleaseWorkspaceDMReservation: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockRedis: {
    set: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/meta/client", () => ({
  sendPrivateReply: mockSendPrivateReply,
  sendPrivateReplyWithLinkButton: mockSendPrivateReplyWithLinkButton,
  sendPrivateReplyWithButton: vi.fn(),
  sendDirectMessage: mockSendDirectMessage,
  sendDirectMessageWithLinkButton: vi.fn(),
  sendCommentReply: vi.fn(),
  MetaApiError: class MetaApiError extends Error {
    code: number;
    constructor(
      code: number,
      _subcode: number | undefined,
      _fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.code = code;
      this.name = "MetaApiError";
    }
  },
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: mockDecryptToken,
}));

vi.mock("@/lib/utils/keyword-matcher", () => ({
  matchKeywords: mockMatchKeywords,
}));

vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: mockReserveDMSlot,
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

vi.mock("@/lib/ops/worker-health", () => ({
  recordWorkerAlert: vi.fn(),
}));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({
    add: mockQueueAdd,
  }),
  getRedisConnection: () => mockRedis,
  POSTBACK_JOB_NAME: "process-postback",
}));

vi.mock("bullmq", () => {
  function MockWorker(_name: string, processor: unknown) {
    (global as Record<string, unknown>).__dmWorkerProcessor = processor;
    return {
      on: vi.fn(),
      close: vi.fn(),
    };
  }
  return {
    Worker: MockWorker,
  };
});

import { createDMWorker } from "../lib/queue/dm-worker";

const usagePeriodStart = new Date("2026-05-01T00:00:00.000Z");

const mockAutomation = {
  id: "auto_789",
  workspaceId: "workspace_123",
  instagramAccountId: "ig_account_row_1",
  postId: "media_101",
  keywords: ["LINK", "PRICE"],
  dmMessage: "Hey {username}! Here is the link: https://example.com",
  isActive: true,
  wholeWordMatch: true,
  matchAnyPost: false,
  matchAnyWord: false,
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  publicReplyEnabled: false,
  publicReplyMessage: null,
  publicReplyMessages: [],
  instagramAccount: {
    id: "ig_account_row_1",
    instagramId: "ig_456",
    accessToken: "encrypted_token_abc",
  },
  workspace: {
    id: "workspace_123",
  },
  trackedLinks: [],
};

const mockJobData = {
  instagramAccountId: "ig_456",
  commentId: "comment_555",
  commentText: "I want the LINK!",
  commenterId: "commenter_999",
  commenterName: "commenter_user",
  mediaId: "media_101",
};

function getProcessor(): (job: {
  data: typeof mockJobData;
  id: string;
  attemptsMade: number;
}) => Promise<void> {
  createDMWorker();
  return (global as Record<string, unknown>).__dmWorkerProcessor as (job: {
    data: typeof mockJobData;
    id: string;
    attemptsMade: number;
  }) => Promise<void>;
}

function createMockJob(data = mockJobData) {
  return {
    data,
    id: "job_001",
    attemptsMade: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mockPrisma.automation.findMany.mockResolvedValue([mockAutomation]);
  mockPrisma.dmLog.findUnique.mockResolvedValue(null);
  mockPrisma.dmLog.create.mockResolvedValue({});
  mockPrisma.dmLog.upsert.mockResolvedValue({});
  mockPrisma.dmLog.update.mockResolvedValue({});
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    workspaceId: "workspace_123",
  });
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockDecryptToken.mockReturnValue("decrypted_token");
  mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
  mockReserveWorkspaceDMSend.mockResolvedValue({
    allowed: true,
    reserved: true,
    remaining: 100,
    limit: 2000,
    periodStart: usagePeriodStart,
  });
  mockReserveDMSlot.mockResolvedValue({
    allowed: true,
    currentCount: 11,
    remainingDMs: 179,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  });
  mockReleaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mockSendPrivateReply.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_001",
  });
  mockSendPrivateReplyWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_002",
  });
});

describe("DM Worker — Full Pipeline", () => {
  it("should send a private reply for a matching comment", async () => {
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ postId: "media_101" }, { matchAnyPost: true }],
        isActive: true,
        instagramAccount: { instagramId: "ig_456" },
      },
      include: {
        instagramAccount: true,
        workspace: true,
        trackedLinks: {
          select: {
            slug: true,
            destinationUrl: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(mockMatchKeywords).toHaveBeenCalledWith(
      "I want the LINK!",
      ["LINK", "PRICE"],
      true
    );
    expect(mockReserveWorkspaceDMSend).toHaveBeenCalledWith("workspace_123");
    expect(mockReserveDMSlot).toHaveBeenCalledWith("ig_456", 0);
    expect(mockDecryptToken).toHaveBeenCalledWith("encrypted_token_abc");
    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({ status: "SENT" }),
    });
  });

  it("should skip when no automations match the media", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  it("should skip when keywords do not match", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip duplicate comments already sent", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_log",
      status: "SENT",
    });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip when monthly plan limit is reached", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 100,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReserveDMSlot).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  it("should requeue and release monthly usage when rate limited", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: 1800000,
      shouldSkip: false,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-comment",
      expect.objectContaining({
        commentId: "comment_555",
        requeueAttempt: 1,
      }),
      expect.objectContaining({
        delay: 1800000,
        // BullMQ forbids ":" in custom job ids, so the id is underscore-joined.
        jobId: "comment_ig_456_comment_555_retry_1",
      })
    );
  });

  it("should skip with SKIPPED_RATE_LIMIT after max requeue attempts", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_RATE_LIMIT" }),
      })
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should log FAILED, release usage, and re-throw when private reply sending fails", async () => {
    const error = new Error("API Error");
    mockSendPrivateReply.mockRejectedValue(error);

    const processor = getProcessor();

    await expect(processor(createMockJob())).rejects.toThrow("API Error");
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: "API Error",
      }),
    });
  });

  it("should handle missing access token", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        instagramAccount: {
          ...mockAutomation.instagramAccount,
          accessToken: null,
        },
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        }),
      })
    );
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should use 'there' when commenter name is not available", async () => {
    const processor = getProcessor();
    const jobDataWithoutName = {
      instagramAccountId: mockJobData.instagramAccountId,
      commentId: mockJobData.commentId,
      commentText: mockJobData.commentText,
      commenterId: mockJobData.commenterId,
      mediaId: mockJobData.mediaId,
    };

    await processor(createMockJob(jobDataWithoutName as typeof mockJobData));

    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey there! Here is the link: https://example.com"
    );
  });

  it("should deliver tracked links as a web_url button", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      "Get offer",
      "http://localhost:3000/r/abc123"
    );
  });
});


describe("DM Worker — thread replies", () => {
  // Instagram flattens threads: a reply to the campaign's public reply arrives
  // as a new comment carrying the ORIGINAL top-level comment as its parent.
  const replyJobData = {
    ...mockJobData,
    commentId: "comment_reply_777",
    commentText: "@account thanks, got it!",
    parentCommentId: "comment_555",
  };

  /** findUnique answers per commentId so the parent lookup is distinguishable. */
  function logsByCommentId(map: Record<string, unknown>) {
    mockPrisma.dmLog.findUnique.mockImplementation(
      async ({ where }: { where: { automationId_commentId: { commentId: string } } }) =>
        map[where.automationId_commentId.commentId] ?? null
    );
  }

  it("does not re-fire when the original commenter replies in an answered thread", async () => {
    logsByCommentId({
      comment_555: { commenterId: "commenter_999", status: "SENT" },
    });

    const processor = getProcessor();
    await processor(createMockJob(replyJobData));

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        commentId: "comment_reply_777",
        status: "SKIPPED_DEDUP",
      }),
    });
  });

  it("still fires when a different person replies inside that thread", async () => {
    logsByCommentId({
      comment_555: { commenterId: "someone_else", status: "SENT" },
    });

    const processor = getProcessor();
    await processor(createMockJob(replyJobData));

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("still fires on a reply whose parent thread was never answered", async () => {
    logsByCommentId({});

    const processor = getProcessor();
    await processor(createMockJob(replyJobData));

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("leaves a top-level comment untouched by the guard", async () => {
    logsByCommentId({});

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    // No parent to look up: only the comment's own log is read.
    expect(mockPrisma.dmLog.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("DM Worker — legacy button taps", () => {
  const LEGACY_REPLY = "This button is from an old message.";

  function createPostbackJob(payload: string) {
    return {
      name: "process-postback",
      data: { instagramAccountId: "ig_456", userId: "tapper_1", payload },
      id: "job_postback",
      attemptsMade: 0,
    } as unknown as ReturnType<typeof createMockJob>;
  }

  beforeEach(() => {
    process.env.LEGACY_POSTBACK_REPLY = LEGACY_REPLY;
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      workspaceId: "workspace_123",
      instagramId: "ig_456",
      accessToken: "encrypted_token_abc",
    });
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.del.mockResolvedValue(1);
    mockSendDirectMessage.mockResolvedValue({ message_id: "msg_legacy" });
  });

  it("replies to a tap on a button OpenReply did not send", async () => {
    const processor = getProcessor();
    await processor(createPostbackJob("ACT::d7c01c11aa91befd9d1718727da6b0f1"));

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "tapper_1",
      LEGACY_REPLY
    );
    expect(mockRedis.set).toHaveBeenCalledWith(
      "legacy-postback:ig_456:tapper_1",
      "1",
      "EX",
      86400,
      "NX"
    );
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: "WARNING", source: "WORKER" }),
      })
    );
  });

  it("replies only once a day to the same person", async () => {
    mockRedis.set.mockResolvedValue(null);

    const processor = getProcessor();
    await processor(createPostbackJob("ACT::d7c01c11aa91befd9d1718727da6b0f1"));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("stays silent when no legacy reply is configured", async () => {
    delete process.env.LEGACY_POSTBACK_REPLY;

    const processor = getProcessor();
    await processor(createPostbackJob("ACT::d7c01c11aa91befd9d1718727da6b0f1"));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it("releases the claim and re-throws when the send fails", async () => {
    mockSendDirectMessage.mockRejectedValue(new Error("Meta down"));

    const processor = getProcessor();
    await expect(
      processor(createPostbackJob("ACT::d7c01c11aa91befd9d1718727da6b0f1"))
    ).rejects.toThrow("Meta down");

    expect(mockRedis.del).toHaveBeenCalledWith("legacy-postback:ig_456:tapper_1");
  });

  it("never sends the legacy reply for OpenReply's own reveal buttons", async () => {
    const processor = getProcessor();
    await processor(createPostbackJob("reveal:auto_789"));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });
});
