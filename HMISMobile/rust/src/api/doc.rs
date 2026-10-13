//! One Automerge document per patient, in the shape shared with the HMIS
//! server and HMISWeb (HMIS/DOCUMENT_SCHEMA.md):
//!
//! ```text
//! { patient: { name, phone, status, location, head_of_household, registered_at },
//!   visits:  { "<visit uuid>": { visit_type, timestamp, reason, <vitals>, deleted_at } } }
//! ```
//!
//! This layer knows the two root maps and nothing about individual fields, so
//! adding a field is a Dart-only change. Strings are written as `Str` scalars
//! (last writer wins), never collaborative `Text`.

use std::str::FromStr;

use anyhow::{anyhow, bail, Result};
use automerge::{
    sync::{self, SyncDoc},
    transaction::{CommitOptions, Transactable},
    ActorId, AutoCommit, ChangeHash, ObjId, ObjType, ReadDoc, ScalarValue, Value, ROOT,
};
use flutter_rust_bridge::frb;

const NOT_DOWNLOADED: &str = "This patient has not finished downloading. Sync and try again.";

/// A value to write. Exactly one of `text` or `flag` is set.
pub struct DocField {
    pub key: String,
    pub text: Option<String>,
    pub flag: Option<bool>,
}

pub struct DocChange {
    pub hash: String,
    pub actor: String,
    /// Seconds since the epoch, as recorded by the device that made the change.
    pub time_secs: i64,
    pub message: Option<String>,
}

/// A key that two devices wrote concurrently. Every replica shows `winner`;
/// `others` are the values that lost.
pub struct DocConflict {
    /// `["patient"]` or `["visits", "<visit uuid>"]`.
    pub path: Vec<String>,
    pub key: String,
    pub winner: ConflictValue,
    pub others: Vec<ConflictValue>,
}

pub struct ConflictValue {
    pub value: String,
    pub actor: String,
}

#[frb(opaque)]
pub struct PatientDoc {
    doc: AutoCommit,
    /// Per-session sync state with the server. The server keeps none between
    /// requests, so this starts fresh for every sync run.
    sync_state: sync::State,
}

impl PatientDoc {
    /// A blank document for a patient this device has never seen; the server's
    /// changes create its maps during sync.
    #[frb(sync)]
    pub fn empty(actor_hex: String) -> Result<PatientDoc> {
        Ok(Self::wrap(AutoCommit::new().with_actor(actor(&actor_hex)?)))
    }

    #[frb(sync)]
    pub fn load(bytes: Vec<u8>, actor_hex: String) -> Result<PatientDoc> {
        Ok(Self::wrap(
            AutoCommit::load(&bytes)?.with_actor(actor(&actor_hex)?),
        ))
    }

    /// Registers a new patient. Only the registering device creates the
    /// `patient` and `visits` maps: if two replicas each created them, they
    /// would be different objects and one would silently win.
    #[frb(sync)]
    pub fn create(
        actor_hex: String,
        patient: Vec<DocField>,
        message: String,
        time_secs: i64,
    ) -> Result<PatientDoc> {
        let mut doc = AutoCommit::new().with_actor(actor(&actor_hex)?);
        let obj = doc.put_object(ROOT, "patient", ObjType::Map)?;
        for field in &patient {
            doc.put(&obj, field.key.as_str(), scalar(field)?)?;
        }
        doc.put_object(ROOT, "visits", ObjType::Map)?;
        doc.commit_with(options(message, time_secs));
        Ok(Self::wrap(doc))
    }

    /// Writes the fields that differ from the stored value (or are in
    /// conflict) at `path`, as one change. Returns false when nothing changed.
    /// With `create_visit`, a missing `["visits", id]` map is created.
    #[frb(sync)]
    pub fn update(
        &mut self,
        path: Vec<String>,
        fields: Vec<DocField>,
        create_visit: bool,
        message: String,
        time_secs: i64,
    ) -> Result<bool> {
        let (obj, created) = match path.as_slice() {
            [root] if root == "patient" => (self.root_map("patient")?, false),
            [root, id] if root == "visits" => {
                let visits = self.root_map("visits")?;
                match child_map(&self.doc, &visits, id) {
                    Some(obj) => (obj, false),
                    None if create_visit => (
                        self.doc.put_object(&visits, id.as_str(), ObjType::Map)?,
                        true,
                    ),
                    None => bail!("Visit not found."),
                }
            }
            _ => bail!("Unsupported path {path:?}"),
        };
        let mut changed = created;
        for field in &fields {
            let value = scalar(field)?;
            let current = self.doc.get_all(&obj, field.key.as_str())?;
            let same = current.len() == 1
                && matches!(&current[0].0, Value::Scalar(s) if s.as_ref() == &value);
            if !same {
                self.doc.put(&obj, field.key.as_str(), value)?;
                changed = true;
            }
        }
        if changed {
            self.doc.commit_with(options(message, time_secs));
        }
        Ok(changed)
    }

    #[frb(sync)]
    pub fn save(&mut self) -> Vec<u8> {
        self.doc.save()
    }

    /// Sorted hex change hashes, comparable with the server manifest.
    #[frb(sync)]
    pub fn heads(&mut self) -> Vec<String> {
        let mut heads: Vec<String> = self.doc.get_heads().iter().map(|h| h.to_string()).collect();
        heads.sort();
        heads
    }

    #[frb(sync)]
    pub fn actor_hex(&self) -> String {
        self.doc.get_actor().to_hex_string()
    }

    /// The whole document as JSON. Text objects written by other clients are
    /// read as plain strings.
    #[frb(sync)]
    pub fn to_json(&self) -> String {
        to_json(&self.doc, &ROOT, ObjType::Map).to_string()
    }

    /// Changes not covered by `heads`, oldest first. Empty `heads` lists every change.
    #[frb(sync)]
    pub fn changes_since(&mut self, heads: Vec<String>) -> Result<Vec<DocChange>> {
        let heads = heads
            .iter()
            .map(|h| ChangeHash::from_str(h).map_err(|e| anyhow!("bad head {h}: {e}")))
            .collect::<Result<Vec<_>>>()?;
        Ok(self
            .doc
            .get_changes(&heads)
            .iter()
            .map(|c| DocChange {
                hash: c.hash().to_string(),
                actor: c.actor_id().to_hex_string(),
                time_secs: c.timestamp(),
                message: c.message().map(str::to_owned),
            })
            .collect())
    }

    /// Every key in the patient map and the visit maps that holds more than
    /// one concurrent value.
    #[frb(sync)]
    pub fn conflicts(&self) -> Vec<DocConflict> {
        let mut out = Vec::new();
        if let Some(patient) = child_map(&self.doc, &ROOT, "patient") {
            self.collect_conflicts(&patient, vec!["patient".into()], &mut out);
        }
        if let Some(visits) = child_map(&self.doc, &ROOT, "visits") {
            for id in self.doc.keys(&visits).collect::<Vec<_>>() {
                if let Some(visit) = child_map(&self.doc, &visits, &id) {
                    self.collect_conflicts(&visit, vec!["visits".into(), id], &mut out);
                }
            }
        }
        out
    }

    /// Merges another copy of this patient's document into this one.
    #[frb(sync)]
    pub fn merge(&mut self, other: &mut PatientDoc) -> Result<()> {
        self.doc.merge(&mut other.doc)?;
        Ok(())
    }

    #[frb(sync)]
    pub fn reset_sync_state(&mut self) {
        self.sync_state = sync::State::new();
    }

    /// The next message for the server, or None when it has everything.
    #[frb(sync)]
    pub fn generate_sync_message(&mut self) -> Option<Vec<u8>> {
        self.doc
            .sync()
            .generate_sync_message(&mut self.sync_state)
            .map(|m| m.encode())
    }

    #[frb(sync)]
    pub fn receive_sync_message(&mut self, message: Vec<u8>) -> Result<()> {
        let message =
            sync::Message::decode(&message).map_err(|e| anyhow!("bad sync message: {e}"))?;
        self.doc
            .sync()
            .receive_sync_message(&mut self.sync_state, message)?;
        Ok(())
    }
}

impl PatientDoc {
    fn wrap(doc: AutoCommit) -> Self {
        Self {
            doc,
            sync_state: sync::State::new(),
        }
    }

    fn root_map(&self, key: &str) -> Result<ObjId> {
        child_map(&self.doc, &ROOT, key).ok_or_else(|| anyhow!(NOT_DOWNLOADED))
    }

    fn collect_conflicts(&self, obj: &ObjId, path: Vec<String>, out: &mut Vec<DocConflict>) {
        for key in self.doc.keys(obj).collect::<Vec<_>>() {
            let Ok(all) = self.doc.get_all(obj, key.as_str()) else {
                continue;
            };
            if all.len() < 2 {
                continue;
            }
            let Ok(Some((_, winner_id))) = self.doc.get(obj, key.as_str()) else {
                continue;
            };
            let mut winner = None;
            let mut others = Vec::new();
            for (value, id) in &all {
                let entry = ConflictValue {
                    value: value_string(&self.doc, value, id),
                    actor: actor_of(id),
                };
                if *id == winner_id {
                    winner = Some(entry);
                } else {
                    others.push(entry);
                }
            }
            if let Some(winner) = winner {
                out.push(DocConflict {
                    path: path.clone(),
                    key,
                    winner,
                    others,
                });
            }
        }
    }
}

fn actor(hex_str: &str) -> Result<ActorId> {
    let bytes = hex::decode(hex_str).map_err(|e| anyhow!("bad actor id {hex_str}: {e}"))?;
    if bytes.is_empty() {
        bail!("empty actor id");
    }
    Ok(ActorId::from(bytes))
}

fn options(message: String, time_secs: i64) -> CommitOptions {
    let options = CommitOptions::default().with_time(time_secs);
    if message.is_empty() {
        options
    } else {
        options.with_message(message)
    }
}

fn scalar(field: &DocField) -> Result<ScalarValue> {
    match (&field.text, field.flag) {
        (Some(text), None) => Ok(ScalarValue::Str(text.as_str().into())),
        (None, Some(flag)) => Ok(ScalarValue::Boolean(flag)),
        _ => bail!("field {} must set exactly one of text or flag", field.key),
    }
}

fn child_map(doc: &AutoCommit, obj: &ObjId, key: &str) -> Option<ObjId> {
    match doc.get(obj, key) {
        Ok(Some((Value::Object(ObjType::Map), id))) => Some(id),
        _ => None,
    }
}

fn actor_of(id: &ObjId) -> String {
    match id {
        ObjId::Id(_, actor, _) => actor.to_hex_string(),
        ObjId::Root => String::new(),
    }
}

fn value_string(doc: &AutoCommit, value: &Value<'_>, id: &ObjId) -> String {
    match value {
        Value::Scalar(s) => match s.as_ref() {
            ScalarValue::Str(s) => s.to_string(),
            other => other.to_string(),
        },
        Value::Object(ObjType::Text) => doc.text(id).unwrap_or_default(),
        Value::Object(_) => String::new(),
    }
}

fn to_json(doc: &AutoCommit, obj: &ObjId, kind: ObjType) -> serde_json::Value {
    use serde_json::Value as J;
    match kind {
        ObjType::Map | ObjType::Table => {
            let mut map = serde_json::Map::new();
            for key in doc.keys(obj).collect::<Vec<_>>() {
                if let Ok(Some((value, id))) = doc.get(obj, key.as_str()) {
                    map.insert(key, value_json(doc, &value, &id));
                }
            }
            J::Object(map)
        }
        ObjType::List => J::Array(
            (0..doc.length(obj))
                .filter_map(|i| doc.get(obj, i).ok().flatten())
                .map(|(value, id)| value_json(doc, &value, &id))
                .collect(),
        ),
        ObjType::Text => J::String(doc.text(obj).unwrap_or_default()),
    }
}

fn value_json(doc: &AutoCommit, value: &Value<'_>, id: &ObjId) -> serde_json::Value {
    use serde_json::Value as J;
    match value {
        Value::Object(kind) => to_json(doc, id, *kind),
        Value::Scalar(s) => match s.as_ref() {
            ScalarValue::Str(s) => J::String(s.to_string()),
            ScalarValue::Boolean(b) => J::Bool(*b),
            ScalarValue::Int(n) => J::from(*n),
            ScalarValue::Uint(n) => J::from(*n),
            ScalarValue::F64(n) => J::from(*n),
            ScalarValue::Counter(c) => J::from(i64::from(c)),
            ScalarValue::Timestamp(t) => J::from(*t),
            ScalarValue::Null => J::Null,
            other => J::String(other.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHONE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TABLET: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn text(key: &str, value: &str) -> DocField {
        DocField {
            key: key.into(),
            text: Some(value.into()),
            flag: None,
        }
    }

    fn register() -> PatientDoc {
        PatientDoc::create(
            PHONE.into(),
            vec![
                text("name", "Amina Wanjiru"),
                text("status", "active"),
                DocField {
                    key: "head_of_household".into(),
                    text: None,
                    flag: Some(true),
                },
            ],
            r#"{"kind":"patient.create"}"#.into(),
            1_700_000_000,
        )
        .unwrap()
    }

    fn json(doc: &PatientDoc) -> serde_json::Value {
        serde_json::from_str(&doc.to_json()).unwrap()
    }

    /// Runs the sync protocol between two in-memory replicas until both are idle.
    fn sync_pair(a: &mut PatientDoc, b: &mut PatientDoc) {
        for _ in 0..20 {
            let to_b = a.generate_sync_message();
            let to_a = b.generate_sync_message();
            if to_b.is_none() && to_a.is_none() {
                return;
            }
            if let Some(m) = to_b {
                b.receive_sync_message(m).unwrap();
            }
            if let Some(m) = to_a {
                a.receive_sync_message(m).unwrap();
            }
        }
        panic!("sync did not settle");
    }

    #[test]
    fn create_writes_maps_and_scalars() {
        let doc = register();
        let j = json(&doc);
        assert_eq!(j["patient"]["name"], "Amina Wanjiru");
        assert_eq!(j["patient"]["head_of_household"], true);
        assert_eq!(j["visits"], serde_json::json!({}));
    }

    #[test]
    fn update_skips_unchanged_values() {
        let mut doc = register();
        let before = doc.heads();
        assert!(!doc
            .update(
                vec!["patient".into()],
                vec![text("name", "Amina Wanjiru")],
                false,
                "".into(),
                1
            )
            .unwrap());
        assert_eq!(doc.heads(), before);
        assert!(doc
            .update(
                vec!["patient".into()],
                vec![text("name", "Amina W.")],
                false,
                "".into(),
                1
            )
            .unwrap());
        assert_ne!(doc.heads(), before);
    }

    #[test]
    fn visit_is_created_once_and_missing_visit_is_an_error() {
        let mut doc = register();
        let path = vec!["visits".into(), "v1".into()];
        assert!(doc
            .update(
                path.clone(),
                vec![text("visit_type", "outpatient")],
                true,
                "".into(),
                1
            )
            .unwrap());
        assert_eq!(json(&doc)["visits"]["v1"]["visit_type"], "outpatient");
        let missing = doc.update(
            vec!["visits".into(), "nope".into()],
            vec![text("reason", "x")],
            false,
            "".into(),
            1,
        );
        assert!(missing.is_err());
    }

    #[test]
    fn blank_doc_refuses_edits_until_synced() {
        let mut doc = PatientDoc::empty(PHONE.into()).unwrap();
        let err = doc
            .update(
                vec!["patient".into()],
                vec![text("name", "x")],
                false,
                "".into(),
                1,
            )
            .unwrap_err();
        assert_eq!(err.to_string(), NOT_DOWNLOADED);
    }

    #[test]
    fn save_load_round_trip_keeps_actor_and_messages() {
        let mut doc = register();
        let mut loaded = PatientDoc::load(doc.save(), PHONE.into()).unwrap();
        assert_eq!(loaded.actor_hex(), PHONE);
        let changes = loaded.changes_since(vec![]).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes[0].message.as_deref(),
            Some(r#"{"kind":"patient.create"}"#)
        );
        assert_eq!(changes[0].time_secs, 1_700_000_000);
        assert_eq!(changes[0].actor, PHONE);
    }

    #[test]
    fn changes_since_lists_only_newer_changes() {
        let mut doc = register();
        let synced = doc.heads();
        doc.update(
            vec!["patient".into()],
            vec![text("phone", "0711")],
            false,
            "edit".into(),
            2,
        )
        .unwrap();
        let pending = doc.changes_since(synced).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].message.as_deref(), Some("edit"));
    }

    #[test]
    fn concurrent_edits_converge_and_report_the_conflict() {
        let mut phone = register();
        let mut tablet = PatientDoc::empty(TABLET.into()).unwrap();
        sync_pair(&mut phone, &mut tablet);
        let path = vec!["patient".into()];
        phone
            .update(
                path.clone(),
                vec![text("status", "inactive"), text("phone", "0711")],
                false,
                "".into(),
                2,
            )
            .unwrap();
        tablet
            .update(
                path.clone(),
                vec![text("status", "suspended")],
                false,
                "".into(),
                2,
            )
            .unwrap();
        phone.reset_sync_state();
        tablet.reset_sync_state();
        sync_pair(&mut phone, &mut tablet);

        assert_eq!(phone.to_json(), tablet.to_json());
        assert_eq!(json(&phone)["patient"]["phone"], "0711");
        let conflicts = phone.conflicts();
        assert_eq!(conflicts.len(), 1);
        let c = &conflicts[0];
        assert_eq!((c.path.clone(), c.key.as_str()), (path.clone(), "status"));
        assert_eq!(json(&phone)["patient"]["status"], c.winner.value.as_str());
        assert_eq!(c.others.len(), 1);
        let mut actors = vec![c.winner.actor.clone(), c.others[0].actor.clone()];
        actors.sort();
        assert_eq!(actors, vec![PHONE.to_string(), TABLET.to_string()]);

        // Writing the winning value again resolves the conflict on every replica.
        let winner = c.winner.value.clone();
        assert!(phone
            .update(path, vec![text("status", &winner)], false, "".into(), 3)
            .unwrap());
        assert!(phone.conflicts().is_empty());
        sync_pair(&mut phone, &mut tablet);
        assert!(tablet.conflicts().is_empty());
    }

    #[test]
    fn merge_combines_offline_visits() {
        let mut phone = register();
        let mut tablet = PatientDoc::load(phone.save(), TABLET.into()).unwrap();
        phone
            .update(
                vec!["visits".into(), "a".into()],
                vec![text("visit_type", "outpatient")],
                true,
                "".into(),
                2,
            )
            .unwrap();
        tablet
            .update(
                vec!["visits".into(), "b".into()],
                vec![text("visit_type", "home_visit")],
                true,
                "".into(),
                2,
            )
            .unwrap();
        phone.merge(&mut tablet).unwrap();
        let visits = json(&phone)["visits"].as_object().unwrap().len();
        assert_eq!(visits, 2);
    }

    #[test]
    fn text_objects_from_other_clients_read_as_strings() {
        let mut doc = register();
        let patient = doc.root_map("patient").unwrap();
        let name = doc
            .doc
            .put_object(&patient, "location", ObjType::Text)
            .unwrap();
        doc.doc.splice_text(&name, 0, 0, "Kibera").unwrap();
        doc.doc.commit();
        assert_eq!(json(&doc)["patient"]["location"], "Kibera");
    }

    #[test]
    fn bad_input_is_an_error_not_a_panic() {
        assert!(PatientDoc::load(vec![1, 2, 3], PHONE.into()).is_err());
        assert!(PatientDoc::empty("zz".into()).is_err());
        let mut doc = register();
        assert!(doc.receive_sync_message(vec![9, 9]).is_err());
        assert!(doc.changes_since(vec!["nothex".into()]).is_err());
    }
}
