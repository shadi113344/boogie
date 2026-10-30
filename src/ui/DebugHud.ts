/**
 * The developer overlay.
 *
 * A column of lines in the top left corner of the screen, one per number the
 * app wants to show. It never takes the pointer, so the camera still flies
 * underneath it.
 */

export class DebugHud {
  private readonly root: HTMLDivElement;

  /** The line of every key, so a value that does not change keeps its place. */
  private readonly lines = new Map<string, HTMLDivElement>();

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.style.position = 'absolute';
    this.root.style.top = '0';
    this.root.style.left = '0';
    this.root.style.padding = '6px 8px';
    this.root.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    this.root.style.fontSize = '11px';
    this.root.style.lineHeight = '1.4';
    this.root.style.color = '#fff';
    this.root.style.background = 'rgba(0, 0, 0, 0.45)';
    this.root.style.textAlign = 'left';
    this.root.style.whiteSpace = 'pre';
    this.root.style.pointerEvents = 'none';
    this.root.style.display = 'none';
    container.appendChild(this.root);
  }

  /** Show the numbers: one line per key. */
  set(data: Record<string, string | number>): void {
    for (const [key, value] of Object.entries(data)) {
      let line = this.lines.get(key);
      if (!line) {
        line = document.createElement('div');
        this.lines.set(key, line);
        this.root.appendChild(line);
      }
      line.textContent = `${key}: ${value}`;
    }
  }

  /** Show the overlay, or hide it. */
  show(on: boolean): void {
    this.root.style.display = on ? 'block' : 'none';
  }
}
