import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '../client';
import { runs } from '../schema';

type RunInsert = typeof runs.$inferInsert;
type RunSelect = typeof runs.$inferSelect;

/** Fields required when creating a new run record. */
type InsertRunInput = Pick<RunInsert, 'id' | 'sessionId' | 'workflowId' | 'status' | 'model'> &
	Partial<Pick<RunInsert, 'input' | 'budget' | 'createdAt' | 'updatedAt'>>;

export class RunsRepository {
	constructor(private readonly db: DatabaseClient) {}

	/** Insert a new run row and return its id. */
	async insert(input: InsertRunInput): Promise<string> {
		const now = new Date().toISOString();
		await this.db.insert(runs).values({
			createdAt: now,
			updatedAt: now,
			...input
		});
		return input.id;
	}

	/** Find a single run by primary key, or null if not found. */
	async findById(id: string): Promise<RunSelect | null> {
		const rows = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
		return rows[0] ?? null;
	}

	/** All runs for a given session, newest first. */
	async findBySessionId(sessionId: string): Promise<RunSelect[]> {
		return this.db.select().from(runs).where(eq(runs.sessionId, sessionId));
	}
}
