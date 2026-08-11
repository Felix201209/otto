import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiModeGuide } from './UiModeGuide.js';

afterEach(cleanup);

describe('UiModeGuide', () => {
  it('shows both official UI names and returns the selected mode', () => {
    const onSelect = vi.fn();
    render(<UiModeGuide onSelect={onSelect} />);

    expect(screen.getAllByText('对话式 UI').length).toBeGreaterThan(0);
    expect(screen.getAllByText('工作式 UI').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /选择工作式 UI/ }));
    expect(onSelect).toHaveBeenCalledWith('work');
  });
});
