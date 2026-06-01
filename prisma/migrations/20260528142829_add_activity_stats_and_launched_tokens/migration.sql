-- CreateTable
CREATE TABLE "AgentActivityStats" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL DEFAULT 30,
    "txCount" INTEGER NOT NULL DEFAULT 0,
    "volumeSolLamports" BIGINT NOT NULL DEFAULT 0,
    "uniqueCounterparties" INTEGER NOT NULL DEFAULT 0,
    "activeDays" INTEGER NOT NULL DEFAULT 0,
    "oldestSeen" TIMESTAMP(3),
    "latestSeen" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'alchemy',

    CONSTRAINT "AgentActivityStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LaunchedToken" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "agentWallet" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenSlot" BIGINT,
    "priceUsd" DOUBLE PRECISION,
    "marketCapUsd" DOUBLE PRECISION,
    "liquidityUsd" DOUBLE PRECISION,
    "volume24hUsd" DOUBLE PRECISION,
    "volumeLifetimeUsd" DOUBLE PRECISION,
    "dexId" TEXT,
    "enrichedAt" TIMESTAMP(3),

    CONSTRAINT "LaunchedToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentActivityStats_wallet_key" ON "AgentActivityStats"("wallet");

-- CreateIndex
CREATE INDEX "AgentActivityStats_latestSeen_idx" ON "AgentActivityStats"("latestSeen");

-- CreateIndex
CREATE UNIQUE INDEX "LaunchedToken_mint_key" ON "LaunchedToken"("mint");

-- CreateIndex
CREATE INDEX "LaunchedToken_agentWallet_idx" ON "LaunchedToken"("agentWallet");

-- CreateIndex
CREATE INDEX "LaunchedToken_enrichedAt_idx" ON "LaunchedToken"("enrichedAt");

