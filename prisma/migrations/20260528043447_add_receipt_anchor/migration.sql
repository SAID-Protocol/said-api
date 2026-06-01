-- CreateTable
CREATE TABLE "ReceiptAnchor" (
    "id" TEXT NOT NULL,
    "pda" TEXT NOT NULL,
    "agentPda" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "startSeq" BIGINT NOT NULL,
    "endSeq" BIGINT NOT NULL,
    "root" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptAnchor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptAnchor_pda_key" ON "ReceiptAnchor"("pda");

-- CreateIndex
CREATE INDEX "ReceiptAnchor_agentPda_idx" ON "ReceiptAnchor"("agentPda");

-- CreateIndex
CREATE INDEX "ReceiptAnchor_createdAt_idx" ON "ReceiptAnchor"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptAnchor_agentPda_index_key" ON "ReceiptAnchor"("agentPda", "index");
