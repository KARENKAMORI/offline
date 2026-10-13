import { Component, ElementRef, input, output, viewChild } from '@angular/core';

/** AlertDialog with Cancel and a red action, as in widgets.dart confirm(). */
@Component({
  selector: 'app-confirm-dialog',
  template: `
    <dialog #dialog class="alert-dialog" aria-labelledby="confirm-title">
      <h2 id="confirm-title">{{ title() }}</h2>
      <p>{{ message() }}</p>
      <div class="actions">
        <button type="button" class="btn btn-text" (click)="dialog.close()">Cancel</button>
        <button type="button" class="btn btn-text danger" (click)="accept()">{{ action() }}</button>
      </div>
    </dialog>
  `,
  styles: `.danger { color: var(--red-strong); } .danger:hover { background: var(--red-soft) !important; }`,
})
export class ConfirmDialog {
  readonly title = input.required<string>();
  readonly message = input.required<string>();
  readonly action = input.required<string>();
  readonly confirmed = output<void>();
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  open(): void {
    this.dialog().nativeElement.showModal();
  }

  protected accept(): void {
    this.dialog().nativeElement.close();
    this.confirmed.emit();
  }
}
