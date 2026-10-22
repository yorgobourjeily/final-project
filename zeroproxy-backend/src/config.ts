import { existsSync } from 'node:fs';
import path from 'node:path';

// Load zeroproxy-backend/.env if present (works from src/ with tsx and from dist/ with node).
const envFile = path.join(__dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const config = {
  port: Number(process.env.PORT ?? 3000),
  jwtSecret: process.env.JWT_SECRET || 'zeroproxy-dev-secret',
  /** Secret the camera machine sends in the X-Device-Key header. Scans are refused while it is empty. */
  deviceKey: process.env.DEVICE_KEY ?? '',
  db: {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? '',
    database: process.env.PGDATABASE ?? 'zeroproxy',
  },
};
