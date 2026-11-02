-- M5 slice 1: the ledger idempotency guard (design §5).
--
-- One index, no columns and no enum members. `@@unique([orderId, type])` is what
-- makes a double-post a database error rather than a second entry, so a second
-- worker settling the same drop cannot record a charge twice.
--
-- Postgres treats NULLs as distinct in a unique index, so drop-level rows
-- (orderId IS NULL) stay unconstrained — which is what we want for a future
-- adjustment that belongs to a drop rather than an order.
--
-- Consequence, stated so a constraint violation later is a known limit rather
-- than a surprise: V1 permits at most one CHARGE, one PLATFORM_FEE, one REFUND
-- and one ADJUSTMENT per order.

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_orderId_type_key" ON "LedgerEntry"("orderId", "type");
