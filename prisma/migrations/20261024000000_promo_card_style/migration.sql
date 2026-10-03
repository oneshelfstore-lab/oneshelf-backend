-- Promo-card styling for deal collages: grid width, card template, gradient angle, per-card pill label/caption/2nd colour.
ALTER TABLE "DealCollage" ADD COLUMN "template" TEXT NOT NULL DEFAULT 'COLLAGE',
ADD COLUMN "columns" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN "bgAngle" INTEGER NOT NULL DEFAULT 135;

ALTER TABLE "DealCollageCard" ADD COLUMN "label" TEXT,
ADD COLUMN "caption" TEXT,
ADD COLUMN "bgColorTo" TEXT;
