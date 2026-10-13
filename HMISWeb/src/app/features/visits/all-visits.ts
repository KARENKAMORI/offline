import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NotebookPen } from 'lucide-angular';
import type { Visit } from '../../core/db/models';
import { PatientService } from '../../core/db/patient.service';
import { VisitService } from '../../core/db/visit.service';
import { SyncService } from '../../core/sync/sync.service';
import { dayLabel } from '../../shared/format';
import { EmptyState } from '../../shared/ui/empty-state';
import { FieldBar } from '../../shared/ui/field-bar';
import { SectionTitle } from '../../shared/ui/section-title';
import { VisitCard } from './visit-card';

/** Every visit, newest first, grouped by day. */
@Component({
  selector: 'app-all-visits',
  imports: [FieldBar, SectionTitle, EmptyState, VisitCard],
  template: `
    <app-field-bar title="All visits" back="/visits" />
    <div class="screen top0">
      @for (g of groups(); track g.day) {
        <app-section-title [text]="g.day" />
        <div class="cards">
          @for (v of g.visits; track v.id) {
            <app-visit-card [visit]="v" [patientName]="names().get(v.patientId)" [waiting]="pending().has(v.patientId)" />
          }
        </div>
      } @empty {
        <app-empty-state [icon]="NotebookPen" message="No visits recorded yet." />
      }
    </div>
  `,
  styles: `
    .top0 { padding-top: 0; }
    .cards { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
    @media (min-width: 1080px) {
      :host { --content-width: 1320px; }
      .cards { grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); }
    }
  `,
})
export class AllVisits {
  private readonly visits = toSignal(inject(VisitService).visits$, { initialValue: [] });
  // Merged duplicates included: a visit may still be stored under one.
  private readonly patients = toSignal(inject(PatientService).allPatients$, { initialValue: [] });
  protected readonly pending = toSignal(inject(SyncService).pendingIds$, { initialValue: new Set<string>() });
  protected readonly names = computed(() => new Map(this.patients().map((p) => [p.id, p.name])));
  protected readonly groups = computed(() => {
    const out: { day: string; visits: Visit[] }[] = [];
    for (const v of this.visits()) {
      const day = dayLabel(v.timestamp);
      if (out.at(-1)?.day !== day) out.push({ day, visits: [] });
      out.at(-1)!.visits.push(v);
    }
    return out;
  });
  protected readonly NotebookPen = NotebookPen;
}
