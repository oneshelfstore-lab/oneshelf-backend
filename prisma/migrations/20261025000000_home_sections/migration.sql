-- Studio-built page sections (web builder -> app). One row = one section on a page ("HOME" or "dept:<slug>").
-- draftConfig is what the Studio edits; publishedConfig is what customers see (copied on Publish).
CREATE TABLE "HomeSection" (
    "id" TEXT NOT NULL,
    "page" TEXT NOT NULL DEFAULT 'HOME',
    "type" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "draftConfig" JSONB NOT NULL DEFAULT '{}',
    "publishedConfig" JSONB,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeSection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HomeSection_page_isActive_displayOrder_idx" ON "HomeSection"("page", "isActive", "displayOrder");
