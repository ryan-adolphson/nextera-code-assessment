-- Sign-in: users with one role each (viewer < owner < admin). Expand-only and backward-compatible:
-- a new enum type and a new table, nothing existing is touched, so the running revision (which
-- never reads them) keeps working while this is applied. Rows come from `npm run db:seed`.

-- CreateEnum
CREATE TYPE "role" AS ENUM ('viewer', 'owner', 'admin');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
