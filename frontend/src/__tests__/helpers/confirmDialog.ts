import { expect } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

/** RUN 11: answer the shared confirmation dialog (useConfirm) the way a user would; replaces spying on window.confirm. */
export async function answerConfirm({ match, option = false, accept = true }: { match?: RegExp; option?: boolean; accept?: boolean } = {}) {
  const msg = await screen.findByTestId('confirm-dialog-message');
  if (match) expect(msg.textContent).toMatch(match);
  if (option) fireEvent.click(screen.getByTestId('confirm-dialog-option'));
  fireEvent.click(screen.getByTestId(accept ? 'confirm-dialog-confirm' : 'confirm-dialog-cancel'));
}
