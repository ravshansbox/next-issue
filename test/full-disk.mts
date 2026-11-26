import { Writable } from 'node:stream';

export const fullDisk = (): Writable =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback(
        Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }),
      );
    },
  });
