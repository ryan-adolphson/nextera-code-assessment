-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "external_id" TEXT;

-- CreateTable
CREATE TABLE "ingested_messages" (
    "message_id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingested_messages_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE INDEX "ingested_messages_received_at_idx" ON "ingested_messages"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_external_id_key" ON "orders"("external_id");

