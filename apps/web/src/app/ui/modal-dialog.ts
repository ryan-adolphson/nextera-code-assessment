import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';

let nextId = 0;

/**
 * A modal dialog on the native `<dialog>` element: `showModal()` puts it in the top layer and
 * makes the rest of the page inert (focus stays inside), Esc cancels it, and focus returns to the
 * element that was focused before it opened. Open/closed is driven by the `open` input; `closed`
 * fires when the user dismisses it (Esc or the close button), and the parent then sets `open` to
 * false. Project the body (usually a form); the first `[autofocus]` element gets focus.
 */
@Component({
  selector: 'app-modal-dialog',
  template: `
    <dialog
      #dialog
      class="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-line bg-page p-0 text-ink shadow-xl backdrop:bg-black/50"
      [attr.aria-labelledby]="titleId"
      [attr.data-testid]="testId()"
      (cancel)="onCancel($event)"
      (close)="onClose()"
    >
      <div class="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <h2 class="text-lg font-semibold" [id]="titleId">{{ title() }}</h2>
        <button
          type="button"
          class="-m-1 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-surface hover:text-ink"
          data-testid="dialog-close"
          (click)="closed.emit()"
        >
          <svg
            class="size-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
          <span class="sr-only">Close</span>
        </button>
      </div>
      <div class="px-5 py-4">
        <ng-content />
      </div>
    </dialog>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModalDialog {
  readonly open = input.required<boolean>();
  readonly title = input.required<string>();
  readonly testId = input<string | null>(null);
  /** The user dismissed the dialog (Esc or the close button). */
  readonly closed = output<void>();

  protected readonly titleId = `dialog-title-${nextId++}`;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private returnFocus: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const dialog = this.dialog().nativeElement;
      if (this.open() && !dialog.open) {
        this.returnFocus =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.showModal();
        dialog.querySelector<HTMLElement>('[autofocus]')?.focus();
      } else if (!this.open() && dialog.open) {
        dialog.close();
      }
    });
  }

  /** Esc: let the parent decide (it closes the dialog through `open`). */
  protected onCancel(event: Event): void {
    event.preventDefault();
    this.closed.emit();
  }

  /** Closed natively (e.g. a repeated Esc the browser won't let us cancel) or through `open`. */
  protected onClose(): void {
    this.returnFocus?.focus();
    this.returnFocus = null;
    if (this.open()) this.closed.emit();
  }
}
