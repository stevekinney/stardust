import { defineConfig } from 'drizzle-kit';
import { DATABASE_URL } from './src/lib/server/config';

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	dialect: 'sqlite',
	dbCredentials: { url: DATABASE_URL },
	verbose: true,
	strict: true
});
