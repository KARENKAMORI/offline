import { Pipe, PipeTransform } from '@angular/core';
import type { Vitals } from '../core/db/models';

/** "38.4 °C · 72 bpm · BP 120/80 mmHg · RR 18 · SpO₂ 97% · 64.5 kg", or '' when none recorded. */
export function vitalsSummary(v: Vitals): string {
  const parts: string[] = [];
  if (v.temperatureC) parts.push(`${v.temperatureC} °C`);
  if (v.pulseBpm) parts.push(`${v.pulseBpm} bpm`);
  if (v.systolicMmhg || v.diastolicMmhg) {
    parts.push(`BP ${v.systolicMmhg || '–'}/${v.diastolicMmhg || '–'} mmHg`);
  }
  if (v.respiratoryRate) parts.push(`RR ${v.respiratoryRate}`);
  if (v.spo2Pct) parts.push(`SpO₂ ${v.spo2Pct}%`);
  if (v.weightKg) parts.push(`${v.weightKg} kg`);
  return parts.join(' · ');
}

@Pipe({ name: 'vitals' })
export class VitalsPipe implements PipeTransform {
  transform(value: Vitals): string {
    return vitalsSummary(value);
  }
}
