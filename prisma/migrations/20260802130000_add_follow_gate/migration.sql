-- Follow-gate: verify is_user_follow_business at the opening-DM button tap
ALTER TABLE "Automation" ADD COLUMN "followGateEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Automation" ADD COLUMN "followGateMessage" TEXT;
