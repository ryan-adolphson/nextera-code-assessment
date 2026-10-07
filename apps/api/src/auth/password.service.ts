import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PASSWORD_HASH_OPTIONS } from '@nextera/shared';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

/** argon2id password hashing (the same parameters as the seed script, from @nextera/shared). */
@Injectable()
export class PasswordService implements OnModuleInit {
  /** A hash of a random password, verified for unknown emails so they take as long as known ones. */
  private dummyHash?: Promise<string>;

  /** Computed at startup, so even the first unknown email costs one verify, not a hash + verify. */
  async onModuleInit() {
    this.dummyHash ??= this.hash(randomUUID());
    await this.dummyHash;
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, PASSWORD_HASH_OPTIONS);
  }

  /** False for a wrong password or a malformed hash (never throws). */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Does the work of a verify for a user that doesn't exist (no user enumeration by timing). */
  async verifyDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash(randomUUID());
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
