-- CreateEnum
CREATE TYPE "BalanceEntryKind" AS ENUM ('CREDIT', 'CHARGE');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "billed_at" TIMESTAMPTZ(3),
ADD COLUMN     "completed_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "balance_entries" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "kind" "BalanceEntryKind" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "invoice_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "organisation_name" TEXT NOT NULL,
    "campaign_title" TEXT NOT NULL,
    "advertiser" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "impressions" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "filtered_events" INTEGER NOT NULL,
    "subtotal_cents" INTEGER NOT NULL,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("year")
);

-- CreateIndex
CREATE UNIQUE INDEX "balance_entries_invoice_id_key" ON "balance_entries"("invoice_id");

-- CreateIndex
CREATE INDEX "balance_entries_organisation_id_created_at_idx" ON "balance_entries"("organisation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_campaign_id_key" ON "invoices"("campaign_id");

-- CreateIndex
CREATE INDEX "invoices_organisation_id_issued_at_idx" ON "invoices"("organisation_id", "issued_at");

-- AddForeignKey
ALTER TABLE "balance_entries" ADD CONSTRAINT "balance_entries_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_entries" ADD CONSTRAINT "balance_entries_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Campaigns that finished before billing existed are closed, not invoiced after the fact.
-- Campaigns still running are invoiced when they end.
UPDATE "campaigns" SET "billed_at" = now()
WHERE "status" = 'COMPLETED' OR "ends_at" <= now();
