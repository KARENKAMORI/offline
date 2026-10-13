import { Component, ElementRef, output, viewChild } from '@angular/core';

/** showModalBottomSheet: a <dialog> pinned to the bottom with a drag handle. */
@Component({
  selector: 'app-sheet',
  template: `
    <dialog #dialog class="sheet" (close)="closed.emit()" (click)="onBackdrop($event)">
      <div class="handle" aria-hidden="true"></div>
      <div class="sheet-body"><ng-content /></div>
    </dialog>
  `,
})
export class Sheet {
  readonly closed = output<void>();
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  open(): void {
    this.dialog().nativeElement.showModal();
  }

  close(): void {
    this.dialog().nativeElement.close();
  }

  protected onBackdrop(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.close();
  }
}
