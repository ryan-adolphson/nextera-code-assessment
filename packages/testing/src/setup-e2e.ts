import 'reflect-metadata';
import { inject } from 'vitest';

// Point the app at the Testcontainers instances. Real env vars win over the repo .env.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = inject('databaseUrl');
process.env.REDIS_URL = inject('redisUrl');
// Fixed values so tests don't depend on a developer's .env.
process.env.CORS_ORIGINS = 'http://localhost:4200';
// Test-only JWT settings (the API refuses to start without a JWT_SECRET of 32+ characters).
process.env.JWT_SECRET = 'e2e-only-jwt-secret-not-used-anywhere-else-0123456789';
process.env.JWT_ISSUER = 'nextera-api';
process.env.JWT_AUDIENCE = 'nextera-web';
