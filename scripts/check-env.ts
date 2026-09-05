/**
 * Validates the current environment against the shared config schema.
 * Usage: pnpm tsx scripts/check-env.ts
 */
import { loadEnv } from "@recoveros/config";

try {
  const env = loadEnv();
  console.log(
    JSON.stringify({
      ok: true,
      nodeEnv: env.NODE_ENV,
      apiPort: env.API_PORT,
      webPort: env.WEB_PORT,
      databaseConfigured: Boolean(env.DATABASE_URL),
    }),
  );
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
