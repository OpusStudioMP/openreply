-- Add follow-gate skip status
ALTER TYPE "DmStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_NOT_FOLLOWING';
