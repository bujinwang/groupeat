import type { Prisma } from '@prisma/client';

/**
 * Scoped "nothing writes" counts for the DB-backed suites.
 *
 * ## What the fourteen global counts were
 *
 * A dozen test files proved "this render / GET / export writes nothing" by reading
 * unscoped `prisma.X.count()` on both sides of the call and comparing the two records.
 * `fileParallelism: false` makes that safe *inside one process*; a second writer with
 * committed rows lands between the reads and becomes this file's drift. The `85d20f1`
 * `drops 3 → 9` failure was exactly that. `global-count-drift.test.ts` measures the
 * arithmetic.
 *
 * ## Why the scope is not an `id in [...]` list
 *
 * The obvious rewrite is `count({ where: { id: { in: fixtureDropIds } } })`. It buys
 * immunity to a stranger's rows and **silently breaks the assertion it was meant to
 * keep**: a row the code under test writes has a *new* id, so it is never in the list and
 * the test can no longer see its own bug. Every scope below is therefore a **namespace
 * predicate that a newly written row would also satisfy** —
 *
 *   - root rows a test could create are scoped through their fixture parent
 *     (`Drop.merchantId in fixtureMerchantIds`, `Customer.phone in issuedPhones`);
 *   - child rows carry a fixture `dropId` or `customerId`, which a new child must also
 *     carry because the operation under test has no other drop to attach it to.
 *
 * That is the difference between "ignore the stranger" and "ignore everything".
 *
 * ## What is still given up, honestly
 *
 * A row written by the code under test that has **no relation to any fixture entity**
 * (an `AuditLog` about a brand-new entity, a `Customer` with a phone this file did not
 * issue) is invisible here. The residue gate catches rows left behind at the end of the
 * suite but not a row written and cleaned up inside one call, so these tests and the gate
 * remain complementary, not redundant. `AuditLog` is the weakest link: it has no foreign
 * key and `targetId` is an untyped string, so it can only be scoped by an `in` list of
 * ids the fixture knows. Every product writer (`force-fail.ts`, `cancel.ts`,
 * `participant-refund.ts`, `impersonation.ts`) points `targetId` at a drop, participant
 * or user the fixture created, which is why that list is enough here.
 *
 * ## Why the db client is a parameter
 *
 * `CountDb` is `Prisma.TransactionClient`, which a full `PrismaClient` satisfies
 * structurally. Passing the client in lets the same helper run inside a rollback-only
 * interactive transaction — the zero-residue construction from `restrict-fk.test.ts` and
 * `global-count-drift.test.ts` — so its own test can seed rows without leaving any.
 */

/** A Prisma client or an interactive-transaction client; both expose the model delegates. */
export type CountDb = Prisma.TransactionClient;

/**
 * The ids one `settlementFixtures(prefix)` instance owns, read **live** at each call.
 *
 * It must be read at call time rather than captured in `beforeAll`: these suites create
 * drops inside `it()` blocks, so a snapshot taken before the first test would be empty.
 */
export type FixtureScope = {
  readonly dropIds: readonly string[];
  readonly merchantIds: readonly string[];
  readonly userIds: readonly string[];
  readonly customerIds: readonly string[];
  readonly participantIds: readonly string[];
  /** Users a file created outside the fixture factory (admin and organiser actors). */
  readonly extraUserIds?: readonly string[];
  /** Extra `AuditLog.targetId` values a file wants watched. */
  readonly extraAuditTargetIds?: readonly string[];
  /** Extra `AuditLog.actorEmail` values a file wants watched. */
  readonly extraAuditActorEmails?: readonly string[];
  /** `Customer.phone` values a file issued itself, e.g. `quote.test.ts`'s issuedPhones. */
  readonly extraCustomerPhones?: readonly string[];
};

/**
 * The seven row types the "nothing writes" suites actually count.
 *
 * Deliberately not a superset: each caller passes exactly the keys its old helper
 * returned, so the rewrite changes *which rows are counted*, not *how many models each
 * assertion watches*. A wider default would quietly strengthen some tests and weaken the
 * claim that this was a scoped rewrite rather than a new test.
 */
export const SCOPED_KEYS = [
  'orders',
  'drops',
  'participants',
  'shareLinks',
  'audits',
  'ledger',
  'customers',
] as const;

export type ScopedCountKey = (typeof SCOPED_KEYS)[number];
export type ScopedCounts = Record<ScopedCountKey, number>;

type Owned = {
  readonly dropIds: string[];
  readonly merchantIds: string[];
  readonly userIds: string[];
  readonly customerIds: string[];
  readonly auditTargetIds: string[];
  readonly auditActorEmails: string[];
  readonly customerPhones: string[];
};

function ownIds(scope: FixtureScope): Owned {
  const userIds = [...scope.userIds, ...(scope.extraUserIds ?? [])];
  return {
    dropIds: [...scope.dropIds],
    merchantIds: [...scope.merchantIds],
    userIds,
    customerIds: [...scope.customerIds],
    // `targetId` is untyped: one row can name a drop, a participant or a user.
    auditTargetIds: [
      ...scope.dropIds,
      ...scope.participantIds,
      ...userIds,
      ...scope.customerIds,
      ...(scope.extraAuditTargetIds ?? []),
    ],
    auditActorEmails: [...(scope.extraAuditActorEmails ?? [])],
    customerPhones: [...(scope.extraCustomerPhones ?? [])],
  };
}

const QUERIES: Record<ScopedCountKey, (db: CountDb, owned: Owned) => Promise<number>> = {
  orders: (db, owned) => db.order.count({ where: { dropId: { in: owned.dropIds } } }),

  // `publicCode` is an FNV-1a hash of the prefix, not a prefix-bearing value, so a new
  // drop cannot be recognised by its code. The merchant is the namespace: every fixture
  // drop and any drop the operation under test could create points at a fixture merchant.
  drops: (db, owned) =>
    db.drop.count({
      where: {
        OR: [{ id: { in: owned.dropIds } }, { merchantId: { in: owned.merchantIds } }],
      },
    }),

  participants: (db, owned) =>
    db.dropParticipant.count({
      where: {
        OR: [
          { dropId: { in: owned.dropIds } },
          { customerId: { in: owned.customerIds } },
        ],
      },
    }),

  shareLinks: (db, owned) =>
    db.shareLink.count({
      where: {
        OR: [
          { dropId: { in: owned.dropIds } },
          { merchantId: { in: owned.merchantIds } },
        ],
      },
    }),

  // `ledger.ts`'s captureEntries and refundEntries both stamp `dropId` on every row, so
  // no `orderId` fallback is needed.
  ledger: (db, owned) =>
    db.ledgerEntry.count({ where: { dropId: { in: owned.dropIds } } }),

  audits: (db, owned) => {
    const where: Prisma.AuditLogWhereInput[] = [
      { targetId: { in: owned.auditTargetIds } },
      { actorUserId: { in: owned.userIds } },
    ];
    if (owned.auditActorEmails.length > 0) {
      where.push({ actorEmail: { in: owned.auditActorEmails } });
    }
    return db.auditLog.count({ where: { OR: where } });
  },

  customers: (db, owned) => {
    const where: Prisma.CustomerWhereInput[] = [
      { id: { in: owned.customerIds } },
      // A diner created by `joinDrop` gets a new id but is immediately attached to a
      // fixture drop through a participant, so this arm is what keeps detection alive.
      { participants: { some: { dropId: { in: owned.dropIds } } } },
    ];
    if (owned.customerPhones.length > 0) {
      where.push({ phone: { in: owned.customerPhones } });
    }
    return db.customer.count({ where: { OR: where } });
  },
};

/**
 * Reads only the requested keys, in one `Promise.all`, against the fixture's namespace.
 *
 * `Pick<ScopedCounts, K>` matters: a caller can keep `expect(after).toEqual(before)`
 * unchanged and TypeScript still checks that the two reads name the same keys.
 */
export async function scopedCounts<K extends ScopedCountKey>(
  db: CountDb,
  scope: FixtureScope,
  keys: readonly K[],
): Promise<Pick<ScopedCounts, K>> {
  const owned = ownIds(scope);
  const entries = await Promise.all(
    keys.map(async (key) => [key, await QUERIES[key](db, owned)] as const),
  );
  const result: Partial<ScopedCounts> = {};
  for (const [key, value] of entries) {
    result[key] = value;
  }
  return result as Pick<ScopedCounts, K>;
}

/**
 * The one mutable column on the commission statement path: `ShareLink.clicks`.
 *
 * `commission-verification.test.ts` compares the whole row set rather than a count, so it
 * needs the same `dropId` scope with the original `select` and ordering preserved.
 */
export async function scopedShareLinkClicks(db: CountDb, scope: FixtureScope) {
  return db.shareLink.findMany({
    where: { dropId: { in: [...scope.dropIds] } },
    select: { id: true, clicks: true },
    orderBy: { id: 'asc' },
  });
}

/**
 * Bounds for a **global** contract read taken on both sides of a render.
 *
 * Five assertions cannot be scoped: the page genuinely prints a whole-table count, so
 * scoping only the database side would make the assertion false. Reading the total before
 * *and* after the render and asserting the rendered value lies inside the bracket keeps
 * the contract (a filtered or invented number falls outside it) while absorbing a
 * stranger's additive rows — they move both bounds in the same direction. Deletions are
 * covered too, hence `min`/`max` rather than `before`/`after`.
 */
export function observedBracket(before: number, after: number): {
  readonly min: number;
  readonly max: number;
} {
  return { min: Math.min(before, after), max: Math.max(before, after) };
}
