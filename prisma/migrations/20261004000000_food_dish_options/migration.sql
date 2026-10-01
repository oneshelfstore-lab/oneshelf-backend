-- Food seller F3: dish sizes / add-ons / customizations, and what the customer chose. Additive.
ALTER TABLE "MenuItem" ADD COLUMN "variants" JSONB,
ADD COLUMN "addOns" JSONB,
ADD COLUMN "optionGroups" JSONB;

ALTER TABLE "OrderItem" ADD COLUMN "selections" JSONB;
