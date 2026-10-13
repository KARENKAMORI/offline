import { Component, computed, inject, output, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { LucideAngularModule, Search, UserSearch } from 'lucide-angular';
import type { Patient } from '../../core/db/models';
import { PatientService } from '../../core/db/patient.service';
import { Avatar } from '../../shared/ui/avatar';
import { EmptyState } from '../../shared/ui/empty-state';
import { RecordCard } from '../../shared/ui/record-card';
import { Sheet } from '../../shared/ui/sheet';
import { matchesSearch } from '../patients/patient-list';

/** Searchable list of patients in a bottom sheet. */
@Component({
  selector: 'app-patient-picker',
  imports: [LucideAngularModule, Sheet, RecordCard, Avatar, EmptyState],
  template: `
    <app-sheet #sheet>
      <label class="input">
        <lucide-icon [img]="Search" [size]="22" />
        <span class="sr-only">Search patients</span>
        <input #search type="search" placeholder="Search name, phone or location"
          [value]="query()" (input)="query.set($any($event.target).value)" />
      </label>
      <div class="list">
        @for (p of filtered(); track p.id) {
          <app-record-card [title]="p.name" [subtitle]="sub(p)" [button]="true" (pressed)="choose(p)">
            <app-avatar leading [name]="p.name" />
          </app-record-card>
        } @empty {
          <app-empty-state [icon]="UserSearch" message="No patients match. Register them from the Patients tab." />
        }
      </div>
    </app-sheet>
  `,
  styles: `.list { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; min-height: 50vh; }`,
})
export class PatientPicker {
  readonly picked = output<Patient>();
  private readonly sheet = viewChild.required<Sheet>('sheet');
  private readonly patients = toSignal(inject(PatientService).patients$, { initialValue: [] });
  protected readonly query = signal('');
  protected readonly filtered = computed(() => this.patients().filter((p) => matchesSearch(p, this.query())));

  open(): void {
    this.query.set('');
    this.sheet().open();
  }

  protected choose(p: Patient): void {
    this.sheet().close();
    this.picked.emit(p);
  }

  protected sub(p: Patient): string {
    return [p.location, p.phone].filter(Boolean).join(' · ');
  }

  protected readonly Search = Search;
  protected readonly UserSearch = UserSearch;
}
