import { test as base, expect } from '@playwright/test';

/** Fails the test on any console error or uncaught page error. */
export const test = base.extend<{ errors: string[] }>({
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    // Chrome logs every refused WebSocket attempt (the page retries while the tool is down); expected.
    const expected = /WebSocket connection to .* failed|ERR_CONNECTION_REFUSED/;
    page.on('console', (m) => { if (m.type() === 'error' && !expected.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await use(errors);
    expect(errors, 'console errors').toEqual([]);
  },
});
export { expect };

