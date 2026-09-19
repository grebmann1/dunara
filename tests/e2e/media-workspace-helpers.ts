import { expect, type Page } from '@playwright/test';

export async function closeMediaDrawer(page: Page) {
  await settleMediaLayout(page);
  const drawer = page.locator('.workspace-drawer:visible').last();
  if (await drawer.isVisible()) await drawer.getByRole('button', { name: 'Close dialog', exact: true }).click();
}

export async function openIconSettings(page: Page) {
  await settleMediaLayout(page);
  const button = page.getByRole('button', { name: /^(Icon settings|Choose existing image)$/ });
  if (await button.isVisible()) await button.click();
}

async function settleMediaLayout(page: Page) {
  if (await page.locator('.media-workbench:not([hidden])').count()) {
  await expect.poll(() => page.locator('.media-workbench:not([hidden])').evaluate(node => (node.getAttribute('data-compact') === 'true') === (node.getBoundingClientRect().width / Number.parseFloat(getComputedStyle(document.documentElement).zoom || '1') < 850))).toBe(true);
  }
}
