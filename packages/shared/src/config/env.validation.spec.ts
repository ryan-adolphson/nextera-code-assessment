import 'reflect-metadata';
import { IsString, MinLength } from 'class-validator';
import {
  CommonEnvironmentVariables,
  validateEnvironment,
} from './env.validation.js';

/** A service's variables: the common ones, its PORT default and one of its own. */
class ServiceEnvironment extends CommonEnvironmentVariables {
  override PORT: number = 3000;

  @IsString({ message: 'TOKEN must be set' })
  @MinLength(4, { message: 'TOKEN must be at least 4 characters' })
  TOKEN: string;
}

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
  REDIS_URL: 'redis://localhost:6380',
  TOKEN: 'abcd',
};

describe('validateEnvironment', () => {
  it('returns an instance of the service class with the common and its own defaults', () => {
    const env = validateEnvironment(ServiceEnvironment, valid);

    expect(env).toBeInstanceOf(ServiceEnvironment);
    expect(env).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      DB_POOL_MAX: 5,
      ...valid,
    });
  });

  it('converts numeric strings of inherited variables, over the subclass default', () => {
    const env = validateEnvironment(ServiceEnvironment, {
      ...valid,
      PORT: '8080',
      DB_POOL_MAX: '10',
    });

    expect(env.PORT).toBe(8080);
    expect(env.DB_POOL_MAX).toBe(10);
  });

  it('lists every invalid variable, inherited or not, one per line', () => {
    const run = () =>
      validateEnvironment(ServiceEnvironment, {
        NODE_ENV: 'staging',
        PORT: 'abc',
        DATABASE_URL: 'mysql://x',
        DB_POOL_MAX: '0',
        REDIS_URL: 'http://x',
        TOKEN: 'abc',
      });

    expect(run).toThrow(
      [
        'Invalid environment configuration:',
        '  NODE_ENV: NODE_ENV must be one of the following values: development, test, production',
        '  PORT: PORT must not be greater than 65535, PORT must not be less than 1, PORT must be an integer number',
        '  DATABASE_URL: DATABASE_URL must be a postgresql:// URL',
        '  DB_POOL_MAX: DB_POOL_MAX must not be less than 1',
        '  REDIS_URL: REDIS_URL must be a redis:// URL',
        '  TOKEN: TOKEN must be at least 4 characters',
      ].join('\n'),
    );
  });

  it.each([
    ['DATABASE_URL', 'DATABASE_URL must be a postgresql:// URL'],
    ['REDIS_URL', 'REDIS_URL must be a redis:// URL'],
  ])('requires %s', (name, message) => {
    const run = () =>
      validateEnvironment(ServiceEnvironment, { ...valid, [name]: undefined });

    expect(run).toThrow(message);
  });

  it('has no PORT default of its own: a service must choose one', () => {
    expect(() =>
      validateEnvironment(CommonEnvironmentVariables, valid),
    ).toThrow(/PORT: .*PORT must be an integer number/);
  });

  it.each([0, 65536, 1.5])('rejects PORT %s', (port) => {
    expect(() =>
      validateEnvironment(ServiceEnvironment, { ...valid, PORT: port }),
    ).toThrow(/PORT/);
  });
});
