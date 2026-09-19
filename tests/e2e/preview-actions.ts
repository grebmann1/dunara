import type { Page } from '@playwright/test';

export async function openPreviewTools(page: Page) {
  if (await page.locator('.preview-tools').getAttribute('open') === null) await page.getByLabel('Preview tools', { exact: true }).click();
}

export async function openProjectRoutes(page: Page) {
  if (await page.getByRole('dialog', { name: 'Project routes', exact: true }).count()) return;
  await openPreviewTools(page);
  await page.getByRole('button', { name: 'Project routes', exact: true }).click();
}
