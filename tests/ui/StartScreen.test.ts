import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StartScreen, setTiltPermissionRequester } from '@/ui/StartScreen';
import type { TiltPermission } from '@/ui/input/tilt';

/** The drop zone the screen is showing. */
const DZ = { dzName: 'Interlaken', units: 'm' as const };

/** Lets the promise of the permission dance settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

interface Built {
  root: HTMLElement;
  screen: StartScreen;
  jump: HTMLButtonElement;
  schemeButton: (scheme: 'tilt' | 'touch') => HTMLButtonElement;
}

/** Builds a start screen and the bits of it the tests poke at. */
function build(): Built {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const screen = new StartScreen(root, DZ);
  const jump = root.querySelector<HTMLButtonElement>('[data-action="jump"]');
  if (!jump) throw new Error('the start screen has no jump button');
  const schemeButton = (scheme: 'tilt' | 'touch'): HTMLButtonElement => {
    const button = root.querySelector<HTMLButtonElement>(`[data-scheme="${scheme}"]`);
    if (!button) throw new Error(`the start screen has no ${scheme} button`);
    return button;
  };
  return { root, screen, jump, schemeButton };
}

beforeEach(() => {
  window.localStorage.clear();
  setTiltPermissionRequester(null);
});

describe('StartScreen', () => {
  it('keeps the jump button disabled until the drop zone is ready', () => {
    const { screen, jump } = build();

    expect(jump.disabled).toBe(true);

    screen.setReady(true);
    expect(jump.disabled).toBe(false);

    screen.setReady(false);
    expect(jump.disabled).toBe(true);
  });

  it('shows the drop zone, the loading line and the units of the drop zone', () => {
    const { root, screen } = build();

    expect(root.textContent).toContain('Interlaken');

    screen.setLoading('Loading the drop zone… 42 tiles');
    const loading = root.querySelector<HTMLElement>('[data-role="loading"]');
    expect(loading?.textContent).toBe('Loading the drop zone… 42 tiles');
    expect(loading?.hidden).toBe(false);

    screen.setLoading(null);
    expect(loading?.hidden).toBe(true);
  });

  it('offers the tilt scheme first and explains both schemes', () => {
    const { root, schemeButton } = build();

    expect(schemeButton('tilt').getAttribute('aria-pressed')).toBe('true');
    expect(schemeButton('touch').getAttribute('aria-pressed')).toBe('false');
    expect(root.textContent).toContain('Tilt');
    expect(root.textContent).toContain('Touch');
  });

  it('jumps with touch without asking the browser for the sensor', async () => {
    const ask = vi.fn(async (): Promise<TiltPermission> => 'granted');
    setTiltPermissionRequester(ask);
    const { screen, jump, schemeButton } = build();
    const onJump = vi.fn();
    screen.onJump = onJump;
    screen.setReady(true);

    schemeButton('touch').click();
    jump.click();
    await settle();

    expect(ask).not.toHaveBeenCalled();
    expect(onJump).toHaveBeenCalledWith('touch');
  });

  it('jumps with tilt when the sensor is allowed', async () => {
    const ask = vi.fn(async (): Promise<TiltPermission> => 'granted');
    setTiltPermissionRequester(ask);
    const { screen, jump } = build();
    const onJump = vi.fn();
    screen.onJump = onJump;
    screen.setReady(true);

    jump.click();
    await settle();

    expect(ask).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith('tilt');
  });

  it('falls back to touch when the sensor is refused, and still jumps', async () => {
    setTiltPermissionRequester(async (): Promise<TiltPermission> => 'denied');
    const { root, screen, jump } = build();
    const onJump = vi.fn();
    screen.onJump = onJump;
    screen.setReady(true);

    jump.click();
    await settle();

    expect(onJump).toHaveBeenCalledWith('touch');
    expect(root.textContent).toContain('Tilt is not available on this device, using touch.');
  });

  it('falls back to touch when there is no sensor at all', async () => {
    setTiltPermissionRequester(async (): Promise<TiltPermission> => 'unavailable');
    const { root, screen, jump } = build();
    const onJump = vi.fn();
    screen.onJump = onJump;
    screen.setReady(true);

    jump.click();
    await settle();

    expect(onJump).toHaveBeenCalledWith('touch');
    expect(root.textContent).toContain('Tilt is not available on this device, using touch.');
  });

  it('does not jump before the drop zone is ready', async () => {
    const { screen, jump } = build();
    const onJump = vi.fn();
    screen.onJump = onJump;

    jump.click();
    await settle();

    expect(onJump).not.toHaveBeenCalled();
  });

  it('remembers the scheme in local storage', () => {
    const { screen, schemeButton } = build();

    schemeButton('touch').click();

    expect(window.localStorage.getItem('boogie.controlScheme')).toBe('touch');
    expect(screen).toBeDefined();
  });

  it('starts with the remembered scheme', async () => {
    window.localStorage.setItem('boogie.controlScheme', 'touch');
    const { screen, jump, schemeButton } = build();
    const onJump = vi.fn();
    screen.onJump = onJump;
    screen.setReady(true);

    expect(schemeButton('touch').getAttribute('aria-pressed')).toBe('true');
    jump.click();
    await settle();

    expect(onJump).toHaveBeenCalledWith('touch');
  });

  it('hides and shows itself', () => {
    const { root, screen } = build();

    screen.show(false);
    expect(root.querySelector<HTMLElement>('.start-screen')?.hidden).toBe(true);

    screen.show(true);
    expect(root.querySelector<HTMLElement>('.start-screen')?.hidden).toBe(false);
  });
});
