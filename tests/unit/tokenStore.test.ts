import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedFileTokenStore } from '../../src/auth/tokenStore.js';
import { TEST_TOKEN, tempDir } from '../helpers.js';

const KEY = 'a-very-long-local-development-encryption-key';

describe('EncryptedFileTokenStore', () => {
  it('round-trips tokens per user', async () => {
    const store = new EncryptedFileTokenStore(tempDir(), KEY);
    await store.saveToken('alice', TEST_TOKEN);
    await store.saveToken('bob', { ...TEST_TOKEN, email: 'bob@example.com' });
    expect(await store.getToken('alice')).toMatchObject({
      refresh_token: TEST_TOKEN.refresh_token,
      email: 'owner@example.com',
    });
    expect((await store.getToken('bob'))?.email).toBe('bob@example.com');
    expect(await store.getToken('carol')).toBeNull();
    await store.deleteToken('alice');
    expect(await store.getToken('alice')).toBeNull();
  });

  it('never writes tokens in plaintext and uses owner-only permissions', async () => {
    const dir = tempDir();
    await new EncryptedFileTokenStore(dir, KEY).saveToken('alice', TEST_TOKEN);
    const file = path.join(dir, 'tokens.enc.json');
    const contents = readFileSync(file, 'utf8');
    expect(contents).not.toContain('SECRET');
    expect(contents).not.toContain('ya29');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });

  it('fails closed with the wrong key', async () => {
    const dir = tempDir();
    await new EncryptedFileTokenStore(dir, KEY).saveToken('alice', TEST_TOKEN);
    await expect(new EncryptedFileTokenStore(dir, 'x'.repeat(40)).getToken('alice')).rejects.toThrow(
      /decrypt/,
    );
  });

  it("binds ciphertext to its user: copying alice's entry to mallory does not decrypt", async () => {
    const dir = tempDir();
    const store = new EncryptedFileTokenStore(dir, KEY);
    await store.saveToken('alice', TEST_TOKEN);
    const file = path.join(dir, 'tokens.enc.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.entries.mallory = data.entries.alice;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(data));
    await expect(new EncryptedFileTokenStore(dir, KEY).getToken('mallory')).rejects.toThrow(/decrypt/);
  });

  it('rejects short keys', () => {
    expect(() => new EncryptedFileTokenStore(tempDir(), 'short')).toThrow();
  });
});
