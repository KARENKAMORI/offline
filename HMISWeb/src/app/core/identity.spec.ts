import { normalizeName, normalizePhone } from './identity';

/** The same vectors as HMIS/patients/identity.py; both must give the same answers. */
describe('Patient identity normalisation', () => {
  it('normalises Kenyan phone numbers and keeps others as given', () => {
    const vectors: [string, string][] = [
      ['0712 111-222', '+254712111222'],
      ['712111222', '+254712111222'],
      ['254712111222', '+254712111222'],
      ['+254712111222', '+254712111222'],
      ['00254712111222', '+254712111222'],
      ['0112345678', '+254112345678'],
      ['+256772000000', '+256772000000'],
      ['12345', '12345'],
      ['', ''],
    ];
    for (const [raw, expected] of vectors) expect(normalizePhone(raw)).withContext(raw).toBe(expected);
  });

  it('ignores case, accents, punctuation, spacing and word order in names', () => {
    const vectors: [string, string][] = [
      ['Njeri-GRACE ', 'grace njeri'],
      ['José  Ñúñez', 'jose nunez'],
      ['Grace_Njeri', 'grace njeri'],
    ];
    for (const [raw, expected] of vectors) expect(normalizeName(raw)).withContext(raw).toBe(expected);
  });
});
