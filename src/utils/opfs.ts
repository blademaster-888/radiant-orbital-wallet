import { logger } from '../logger';

export async function getFile(dirname: string, filename: string): Promise<Uint8Array | undefined> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(dirname, { create: true });
  try {
    const fileHandle = await dir.getFileHandle(filename);
    const buf = await (await fileHandle.getFile()).arrayBuffer();
    return new Uint8Array(buf);
  } catch (error) {
    logger.debug(`OPFS get failed`);
    return undefined;
  }
}

export async function putFile(dirname: string, filename: string, bytes: Uint8Array) {
  logger.debug(`OPFS put ${filename}`);
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(dirname, { create: true });
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  // @ts-ignore need definitions
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return true;
}
