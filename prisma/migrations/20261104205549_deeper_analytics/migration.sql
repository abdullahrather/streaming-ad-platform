-- CreateEnum
CREATE TYPE "ReportGrouping" AS ENUM ('DAY', 'CAMPAIGN', 'SLOT', 'COUNTRY', 'DEVICE', 'SHOW');

-- CreateEnum
CREATE TYPE "ReportSchedule" AS ENUM ('NONE', 'DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('UNDER_DELIVERY', 'BUDGET_BURN', 'SUDDEN_DROP');

-- AlterTable
ALTER TABLE "captured_emails" ADD COLUMN     "attachments" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "alert_emails" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "campaign_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "group_by" "ReportGrouping" NOT NULL DEFAULT 'DAY',
    "columns" TEXT[],
    "range_days" INTEGER NOT NULL DEFAULT 7,
    "schedule" "ReportSchedule" NOT NULL DEFAULT 'NONE',
    "send_weekday" INTEGER NOT NULL DEFAULT 1,
    "send_hour" INTEGER NOT NULL DEFAULT 8,
    "recipient_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "next_run_at" TIMESTAMPTZ(3),
    "last_sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_organisation_id_idx" ON "reports"("organisation_id");

-- CreateIndex
CREATE INDEX "reports_next_run_at_idx" ON "reports"("next_run_at");

-- CreateIndex
CREATE INDEX "alerts_organisation_id_opened_at_idx" ON "alerts"("organisation_id", "opened_at");

-- CreateIndex
CREATE INDEX "alerts_campaign_id_idx" ON "alerts"("campaign_id");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one open alert per campaign and type. Whichever process inserts it first
-- sends the email, so running several API processes never sends it twice.
CREATE UNIQUE INDEX "alerts_one_open_per_type" ON "alerts"("campaign_id", "type") WHERE "resolved_at" IS NULL;
