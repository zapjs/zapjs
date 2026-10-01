import { expect, test, spyOn } from 'bun:test';
import { actionFailure } from './errors.js';

test('all action failures expose only a generic message and opaque log correlation', () => {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const thrown of ['private token', { secret: 'private token' }, new Error('private token'), null, 42]) {
      const error = actionFailure(thrown);
      expect(error.message).toBe('Server action failed');
      expect(JSON.stringify(error)).not.toContain('private token');
      expect(error.digest).toMatch(/^[0-9a-f-]{36}$/);
      expect(log.mock.calls.at(-1)?.[1]).toBe(thrown);
    }
  } finally { log.mockRestore(); }
});
