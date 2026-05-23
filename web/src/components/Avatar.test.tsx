import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Avatar from './Avatar';

describe('Avatar', () => {
  it('shows the uppercased first letter of the seed', () => {
    const { container } = render(<Avatar seed="addison@middleseat.vc" />);
    expect(container.textContent).toBe('A');
  });

  it('produces the same background color for the same seed (deterministic)', () => {
    const a = render(<Avatar seed="addison@middleseat.vc" />);
    const b = render(<Avatar seed="addison@middleseat.vc" />);
    const colorA = (a.container.firstElementChild as HTMLElement).style.background;
    const colorB = (b.container.firstElementChild as HTMLElement).style.background;
    expect(colorA).toBe(colorB);
  });

  it('produces different background colors for different seeds (most pairs)', () => {
    // Not guaranteed for any two strings (12-color palette), but for these
    // particular seeds we know the hash lands on different buckets.
    const a = render(<Avatar seed="alice@example.com" />);
    const b = render(<Avatar seed="bob@example.com" />);
    const colorA = (a.container.firstElementChild as HTMLElement).style.background;
    const colorB = (b.container.firstElementChild as HTMLElement).style.background;
    expect(colorA).not.toBe(colorB);
  });

  it('falls back to a single-glyph placeholder for empty/whitespace seeds', () => {
    const { container } = render(<Avatar seed="   " />);
    expect(container.textContent).toBe('·');
  });
});
