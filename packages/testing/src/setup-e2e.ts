import 'reflect-metadata';
import { inject } from 'vitest';

// Point the app at the Testcontainers instances. Real env vars win over the repo .env.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = inject('databaseUrl');
process.env.REDIS_URL = inject('redisUrl');
// Fixed values so tests don't depend on a developer's .env.
process.env.CORS_ORIGINS = 'http://localhost:4200';
