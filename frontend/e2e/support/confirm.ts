import { expect, type Page } from '@playwright/test';

/** RUN 11: answer the shared confirmation dialog (useConfirm) – replaces page.once('dialog') for the former window.confirm. */
export async function answerConfirm(page: Page, { contains, option = false, accept = true }: { contains?: string; option?: boolean; accept?: boolean } = {}) {
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'alertdialog');
  if (contains) await expect(page.getByTestId('confirm-dialog-message')).toContainText(contains);
  if (option) await page.getByTestId('confirm-dialog-option').check();
  await page.getByTestId(accept ? 'confirm-dialog-confirm' : 'confirm-dialog-cancel').click();
  await expect(dialog).toHaveCount(0);
}
