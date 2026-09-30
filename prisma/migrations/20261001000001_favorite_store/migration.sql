-- Saved shops (favourite stores). Additive: one new table.
CREATE TABLE "FavoriteStore" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FavoriteStore_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FavoriteStore_userId_idx" ON "FavoriteStore"("userId");

CREATE UNIQUE INDEX "FavoriteStore_userId_sellerId_key" ON "FavoriteStore"("userId", "sellerId");

ALTER TABLE "FavoriteStore" ADD CONSTRAINT "FavoriteStore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FavoriteStore" ADD CONSTRAINT "FavoriteStore_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;
