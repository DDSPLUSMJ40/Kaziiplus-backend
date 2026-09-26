-- CreateEnum
CREATE TYPE "FormationStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'SUBMITTED', 'FILED', 'COMPLETED', 'FAILED', 'REFUNDED');

-- CreateTable
CREATE TABLE "formation_orders" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "companyName" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "founderName" TEXT NOT NULL,
    "founderEmail" TEXT NOT NULL,
    "mailingAddress" JSONB NOT NULL,
    "providerCostCents" INTEGER NOT NULL,
    "stateFeeCents" INTEGER NOT NULL,
    "markupCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "stripeSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "status" "FormationStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "ein" TEXT,
    "registeredAgentAssigned" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "formation_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "formation_orders_providerOrderId_key" ON "formation_orders"("providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "formation_orders_stripeSessionId_key" ON "formation_orders"("stripeSessionId");

-- AddForeignKey
ALTER TABLE "formation_orders" ADD CONSTRAINT "formation_orders_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
