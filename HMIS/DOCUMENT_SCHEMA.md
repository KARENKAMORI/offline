# Patient document schema (shared contract)

The HMIS server (`patients/crdt.py`), HMISWeb and HMISMobile all read and write the
same Automerge document, one per patient. A change to this file needs a matching
change in all three.

```
{
  patient: {
    name, phone, status, location,      Str
    head_of_household,                  Boolean
    registered_at,                      Str, ISO-8601
    merged_into                         Str, patient uuid; written only by the
                                        server, missing or "" when not merged
  },
  visits: {
    "<visit uuid>": {
      visit_type,                       Str, required
      timestamp,                        Str, ISO-8601, required
      reason,                           Str, free text, max 200 chars
      temperature_c,                    Str decimal, 30.0 to 45.0
      pulse_bpm,                        Str integer, 20 to 250
      systolic_mmhg,                    Str integer, 50 to 260
      diastolic_mmhg,                   Str integer, 30 to 160
      respiratory_rate,                 Str integer, 5 to 80 (breaths/min)
      spo2_pct,                         Str integer, 50 to 100
      weight_kg,                        Str decimal, 0.5 to 400
      deleted_at                        Str, ISO-8601, or "" when not deleted
    }
  }
}
```

## Rules

- **Every value is a last-writer-wins scalar.** Strings are Automerge `Str`
  scalars (`ImmutableString` in JS, `ScalarType.Str` in Python,
  `ScalarValue::Str` in Rust), never collaborative `Text`. Readers should
  still accept `Text` and convert it to a plain string.
- **Empty string means "not recorded".** Optional visit keys may also be
  missing entirely (documents written before these fields existed). Treat a
  missing key the same as `""`.
- **Numbers are stored as decimal strings** (`"38.4"`, `"72"`), not Automerge
  numbers, so JS, Python and Rust agree on the type. The server validates the
  ranges above when it projects the document into rows; an invalid value is
  reported in `problems` and left out of the row, like any other invalid value.
- **Vitals are flat keys on the visit, not a nested map.** If two devices each
  created a `vitals` map on the same visit while offline, they would be two
  different objects and one device's readings would silently disappear.
  The same rule is why only the device that registers a patient creates the
  `patient` and `visits` maps.
- **Only write keys that changed**, so concurrent edits to other fields on
  other devices survive the merge.
- **Visits are never removed from the map.** Deleting a visit sets
  `deleted_at`; restoring it sets `deleted_at` back to `""`. Removing the key
  would discard a concurrent edit made on another device, and the server keeps
  every record. Lists hide visits whose `deleted_at` is not empty.

## Duplicate patients

Two devices offline can each register the same person. The server recognises
this when the documents sync (`patients/duplicates.py`):

- **Same normalised phone and same normalised name:** the newer record is
  merged into the one the server already had. The server copies the
  duplicate's visits (same visit uuids) into the canonical document, keeps
  the canonical record's own details, and writes `patient.merged_into` =
  canonical uuid into the duplicate's document. Visits a device adds to the
  duplicate later are copied across on each later sync.
- **Same phone, different name:** never merged automatically (households share
  phones). The server flags the pair for review in the admin.

Clients:

- Treat a patient whose `merged_into` is not empty as merged: leave it out of
  patient lists and pickers, and open the `merged_into` patient instead
  (follow the chain if that one is merged too). Write new visits for a merged
  patient into the `merged_into` patient's document.
- Never write `merged_into`.
- Save `phone` normalised, and warn at registration when a local, unmerged
  patient has the same normalised phone (same name: offer to open the
  existing record; different name: note who else uses the number).

Normalisation (keep `patients/identity.py` and both clients identical):

- **Phone:** remove spaces, `-`, `(`, `)` and `.`. A leading `00` becomes `+`.
  A number starting with `+` is kept. Otherwise `254` + 9 digits (12 digits)
  gets a `+`; `0` + `7`/`1` + 8 digits (10 digits) becomes `+254` + the last
  9; `7`/`1` + 8 digits (9 digits) becomes `+254` + the digits. Anything else
  is kept as is. `0712 111-222` → `+254712111222`.
- **Name:** Unicode NFKD, drop combining marks, case-fold, split into runs of
  letters/digits (anything else separates words, `_` included), sort the
  words, join with one space. `"Njeri-GRACE "` → `"grace njeri"`.

## Change messages

Clients that can set a commit message write a JSON object, so other devices can
show who made a change ("A newer edit from Clinic Tablet 2...") and the app can
list pending changes in plain words:

```json
{"device_id": "<uuid>", "device_name": "Clinic Tablet 2",
 "kind": "visit.create", "summary": "Visit: Grace Njeri"}
```

`kind` is one of `patient.create`, `patient.update`, `visit.create`,
`visit.update`, `visit.vitals`, `visit.delete`, `visit.restore`,
`conflict.resolve`. All fields are optional for readers: messages may be
missing (the Python binding cannot write them, so REST edits made on the
server have none) or not JSON. Treat a change without a usable message as
coming from "the server".
