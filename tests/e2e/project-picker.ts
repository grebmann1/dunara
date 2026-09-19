import { expect, type Page } from '@playwright/test';

export async function selectProject(page: Page, projectId: string) {
  const picker = page.getByRole('combobox', { name: 'Project', exact: true });
  await picker.click();
  const option = page.getByRole('listbox', { name: 'Projects', exact: true }).locator(`[role="option"][data-project-id="${projectId}"]`);
  const name = await option.innerText();
  await option.click();
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(picker).toHaveText(name);
}
