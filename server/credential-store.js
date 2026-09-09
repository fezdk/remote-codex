import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

// Refuse links and special files before reading or changing their permissions.
export async function loadAccessKey(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const directory = await open(stateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await directory.stat();
    if (!info.isDirectory() || info.uid !== process.getuid()) throw new Error('Access-key directory must belong to the current user.');
    await directory.chmod(0o700);
    const path = resolve(stateDir, 'access-key');
    let key, created = false;
    try { key = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      key = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    try {
      const info = await key.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || info.size > 4096) throw new Error('Access key must be a small regular file owned by the current user, without links.');
      await key.chmod(0o600);
      if (created) {
        const token = randomBytes(32).toString('base64url');
        await key.writeFile(`${token}\n`);
        return token;
      }
      return (await key.readFile('utf8')).trim();
    } finally { await key.close(); }
  } finally { await directory.close(); }
}
