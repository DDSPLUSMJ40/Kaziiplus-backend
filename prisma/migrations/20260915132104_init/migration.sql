-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('CREATOR', 'SUPPLIER', 'MANUFACTURER');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'LIVE');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'FULFILLED', 'SHIPPED');

-- CreateEnum
CREATE TYPE "FulfillmentProvider" AS ENUM ('PRINTFUL');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "FulfillmentOrderStatus" AS ENUM ('PENDING', 'SUBMITTED', 'IN_PRODUCTION', 'SHIPPED', 'CANCELED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "accountType" "AccountType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "brandName" TEXT,
    "storefrontSlug" TEXT,
    "followers" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "moqUnits" INTEGER,
    "leadTimeDays" INTEGER,
    "reliability" INTEGER NOT NULL DEFAULT 85,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manufacturer_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "moqUnits" INTEGER NOT NULL,
    "leadTimeDays" INTEGER NOT NULL,
    "reliability" INTEGER NOT NULL DEFAULT 85,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manufacturer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "color" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "price" DECIMAL(10,2),
    "designJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "customerHandle" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_connections" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "provider" "FulfillmentProvider" NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "supplier_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "synced_products" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "FulfillmentProvider" NOT NULL,
    "externalProductId" TEXT NOT NULL,
    "kaziiProductId" TEXT,
    "cachedCatalogJson" JSONB,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "synced_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_orders" (
    "id" TEXT NOT NULL,
    "kaziiOrderId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "FulfillmentProvider" NOT NULL,
    "providerOrderId" TEXT,
    "status" "FulfillmentOrderStatus" NOT NULL DEFAULT 'PENDING',
    "lastWebhookAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fulfillment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "creator_profiles_userId_key" ON "creator_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "creator_profiles_storefrontSlug_key" ON "creator_profiles"("storefrontSlug");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_profiles_userId_key" ON "supplier_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "manufacturer_profiles_userId_key" ON "manufacturer_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_connections_creatorId_provider_key" ON "supplier_connections"("creatorId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "synced_products_connectionId_externalProductId_key" ON "synced_products"("connectionId", "externalProductId");

-- AddForeignKey
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_profiles" ADD CONSTRAINT "supplier_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturer_profiles" ADD CONSTRAINT "manufacturer_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_connections" ADD CONSTRAINT "supplier_connections_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synced_products" ADD CONSTRAINT "synced_products_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "supplier_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synced_products" ADD CONSTRAINT "synced_products_kaziiProductId_fkey" FOREIGN KEY ("kaziiProductId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_kaziiOrderId_fkey" FOREIGN KEY ("kaziiOrderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "supplier_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
