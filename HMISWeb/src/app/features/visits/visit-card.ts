import { Component, computed, input } from '@angular/core';
import { visitTitle, type Visit } from '../../core/db/models';
import { timeLabel } from '../../shared/format';
import { Avatar } from '../../shared/ui/avatar';
import { RecordCard } from '../../shared/ui/record-card';
import { SyncBadge } from '../../shared/ui/sync-badge';

/** Patient avatar and name over what the visit was for, with the time and sync state. */
@Component({
  selector: 'app-visit-card',
  imports: [RecordCard, Avatar, SyncBadge],
  template: `
    <app-record-card [title]="name()" [subtitle]="title()" [trailingTop]="time()" [link]="['/visits', visit().id]">
      <app-avatar leading [name]="name()" />
      <app-sync-badge trailing [waiting]="waiting()" />
    </app-record-card>
  `,
  styles: `:host { display: block; }`,
})
export class VisitCard {
  readonly visit = input.required<Visit>();
  readonly patientName = input<string | undefined>();
  readonly waiting = input(false);
  protected readonly name = computed(() => this.patientName() ?? 'Unknown patient');
  protected readonly title = computed(() => visitTitle(this.visit()));
  protected readonly time = computed(() => timeLabel(this.visit().timestamp));
}
