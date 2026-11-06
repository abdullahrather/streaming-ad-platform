-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('STARTER', 'GROWTH', 'ENTERPRISE');

-- AlterTable
ALTER TABLE "balance_entries" ADD COLUMN     "paid_cents" INTEGER,
ADD COLUMN     "paid_currency" CHAR(3),
ADD COLUMN     "stripe_session_id" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "buyer_address" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "buyer_vat_id" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "eur_subtotal_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "eur_tax_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "eur_total_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "exchange_rate" DECIMAL(14,6) NOT NULL DEFAULT 1,
ADD COLUMN     "seller_address" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "seller_name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "seller_vat_id" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "vat_note" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "vat_rate_bp" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "address_line1" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "address_line2" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "billing_name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "city" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "country" VARCHAR(2) NOT NULL DEFAULT '',
ADD COLUMN     "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
ADD COLUMN     "plan" "Plan" NOT NULL DEFAULT 'STARTER',
ADD COLUMN     "postal_code" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "vat_id" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "vat_id_verified_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "rate" DECIMAL(14,6) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("date","currency")
);

-- CreateIndex
CREATE UNIQUE INDEX "balance_entries_stripe_session_id_key" ON "balance_entries"("stripe_session_id");


-- Organisations from before plans keep working as they did: Growth covers what they had.
UPDATE "organisations" SET "plan" = 'GROWTH';

-- Invoices from before currencies and VAT were in euros, with no VAT.
UPDATE "invoices"
SET "eur_subtotal_cents" = "subtotal_cents",
    "eur_tax_cents" = "tax_cents",
    "eur_total_cents" = "total_cents",
    "seller_name" = 'Campaign Analytics';
