import { PrismaClient } from '@prisma/client';

/**
 * Base Repository with common CRUD operations
 * All specific repositories should extend this class
 */
export abstract class BaseRepository<T> {
  protected prisma: PrismaClient;

  constructor(prismaClient: PrismaClient) {
    this.prisma = prismaClient;
  }

  /**
   * Get Prisma client instance
   * Useful for transactions and complex queries
   */
  protected getPrisma(): PrismaClient {
    return this.prisma;
  }

  /**
   * Execute a function within a Prisma transaction
   */
  protected async transaction<R>(
    fn: (tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>) => Promise<R>
  ): Promise<R> {
    return this.prisma.$transaction(fn);
  }
}
