-- CreateEnum
CREATE TYPE "DeliveryType" AS ENUM ('GUARANTEED', 'AUCTION');

-- CreateEnum
CREATE TYPE "PacingMode" AS ENUM ('ASAP', 'EVEN', 'CUSTOM');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "active_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "active_hours" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "competitive_category" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "daily_budget_cents" INTEGER,
ADD COLUMN     "daily_impression_target" INTEGER,
ADD COLUMN     "delivery_type" "DeliveryType" NOT NULL DEFAULT 'GUARANTEED',
ADD COLUMN     "forecast_impressions" INTEGER,
ADD COLUMN     "forecast_reach" INTEGER,
ADD COLUMN     "frequency_cap_per_day" INTEGER,
ADD COLUMN     "pacing_mode" "PacingMode" NOT NULL DEFAULT 'ASAP',
ADD COLUMN     "target_segment_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "creatives" ADD COLUMN     "weight" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "metrics" ADD COLUMN     "cost_millicents" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "creative_metrics" (
    "creative_id" TEXT NOT NULL,
    "bucket" TIMESTAMPTZ(3) NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "completions" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "creative_metrics_pkey" PRIMARY KEY ("creative_id","bucket")
);

-- CreateTable
CREATE TABLE "audience_segments" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "genres" TEXT[],
    "min_views" INTEGER NOT NULL DEFAULT 3,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audience_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_hours" (
    "bucket" TIMESTAMPTZ(3) NOT NULL,
    "genre" TEXT NOT NULL,
    "slot" "AdSlot" NOT NULL,
    "country" CHAR(2) NOT NULL,
    "device" "Device" NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "inventory_hours_pkey" PRIMARY KEY ("bucket","genre","slot","country","device")
);

-- CreateTable
CREATE TABLE "audience_days" (
    "day" TEXT NOT NULL,
    "viewers" INTEGER NOT NULL DEFAULT 0,
    "consented" INTEGER NOT NULL DEFAULT 0,
    "all_time" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "audience_days_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE INDEX "audience_segments_organisation_id_idx" ON "audience_segments"("organisation_id");

-- AddForeignKey
ALTER TABLE "creative_metrics" ADD CONSTRAINT "creative_metrics_creative_id_fkey" FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_segments" ADD CONSTRAINT "audience_segments_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing delivery cost what its campaign charged.
UPDATE "metrics" m SET "cost_millicents" = m."impressions" * c."cpm_cents" FROM "campaigns" c WHERE c."id" = m."campaign_id";
