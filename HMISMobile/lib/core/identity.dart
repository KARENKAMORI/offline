/// Normalised phone numbers and names, used to recognise the same patient.
///
/// A port of HMIS/patients/identity.py ("Duplicate patients" in
/// HMIS/DOCUMENT_SCHEMA.md); the server, HMISWeb and this app must agree, so a
/// change here needs a matching change in both.
library;

const kenyaPrefix = '+254';

/// Kenyan numbers become +2547XXXXXXXX / +2541XXXXXXXX; others keep their
/// digits.
///
/// 0712111222, 712111222, 254712111222, +254712111222 and 00254712111222 all
/// give +254712111222. A number already in `+<country>` form is kept as given.
String normalizePhone(String raw) {
  var number = raw.replaceAll(RegExp(r'[\s\-().]'), '');
  if (number.startsWith('00')) number = '+${number.substring(2)}';
  if (number.startsWith('+')) return number;
  if (number.length == 12 && number.startsWith('254')) return '+$number';
  if (number.length == 10 && number[0] == '0' && '17'.contains(number[1])) {
    return '$kenyaPrefix${number.substring(1)}';
  }
  if (number.length == 9 && '17'.contains(number[0])) {
    return '$kenyaPrefix$number';
  }
  return number;
}

/// Case, accents, punctuation, spacing and word order do not matter.
///
/// "Grace Njeri", "njeri  GRACE" and "Grace-Njeri" all give "grace njeri".
///
/// Dart has no Unicode NFKD or casefold, so this folds Latin-1, Latin
/// Extended-A/B and Latin Extended Additional, the Latin ligatures, ß and
/// fullwidth ASCII by table, which matches the server for Latin-script names.
/// Other scripts keep their letters but can still differ from Python, e.g.
/// Greek accents, Hangul syllables, Arabic presentation forms or Indic
/// spacing marks.
String normalizeName(String raw) {
  final folded = StringBuffer();
  for (final rune in raw.toLowerCase().runes) {
    final ch = String.fromCharCode(rune);
    if (rune >= 0xFF10 && rune <= 0xFF19 || rune >= 0xFF41 && rune <= 0xFF5A) {
      folded.writeCharCode(rune - 0xFEE0); // Fullwidth digit or letter.
    } else {
      folded.write(_folds[ch] ?? ch);
    }
  }
  final words =
      RegExp(r'[\p{L}\p{N}]+', unicode: true)
          .allMatches(folded.toString().replaceAll(_combining, ''))
          .map((m) => m[0]!)
          .toList()
        ..sort();
  return words.join(' ');
}

final _combining = RegExp(r'\p{Mn}', unicode: true);

/// Lower-case letter to what NFKD, dropping combining marks and casefold make
/// of it. Upper case is lowered before the lookup.
final Map<String, String> _folds = {
  for (final MapEntry(key: base, value: letters) in {
    'a': 'àáâãäåāăąǎǟǡǻȁȃȧḁạảấầẩẫậắằẳẵặ',
    'b': 'ḃḅḇ',
    'c': 'çćĉċčḉ',
    'd': 'ďḋḍḏḑḓ',
    'e': 'èéêëēĕėęěȅȇȩḕḗḙḛḝẹẻẽếềểễệ',
    'f': 'ḟ',
    'g': 'ĝğġģǧǵḡ',
    'h': 'ĥȟḣḥḧḩḫẖ',
    'i': 'ìíîïĩīĭįǐȉȋḭḯỉị',
    'j': 'ĵǰ',
    'k': 'ķǩḱḳḵ',
    'l': 'ĺļľḷḹḻḽ',
    'm': 'ḿṁṃ',
    'n': 'ñńņňǹṅṇṉṋ',
    'o': 'òóôõöōŏőơǒǫǭȍȏȫȭȯȱṍṏṑṓọỏốồổỗộớờởỡợ',
    'p': 'ṕṗ',
    'r': 'ŕŗřȑȓṙṛṝṟ',
    's': 'śŝşšſșṡṣṥṧṩẛ',
    't': 'ţťțṫṭṯṱẗ',
    'u': 'ùúûüũūŭůűųưǔǖǘǚǜȕȗṳṵṷṹṻụủứừửữự',
    'v': 'ṽṿ',
    'w': 'ŵẁẃẅẇẉẘ',
    'x': 'ẋẍ',
    'y': 'ýÿŷȳẏẙỳỵỷỹ',
    'z': 'źżžẑẓẕ',
  }.entries)
    for (final letter in letters.split('')) letter: base,
  'ª': 'a',
  'º': 'o',
  '¹': '1',
  '²': '2',
  '³': '3',
  '¼': '1⁄4',
  '½': '1⁄2',
  '¾': '3⁄4',
  'µ': 'μ',
  'ß': 'ss',
  'ǣ': 'æ',
  'ǽ': 'æ',
  'ǿ': 'ø',
  'ǯ': 'ʒ',
  'ς': 'σ',
  'ĳ': 'ij',
  'ŀ': 'l·',
  'ŉ': 'ʼn',
  'ǆ': 'dz',
  'ǉ': 'lj',
  'ǌ': 'nj',
  'ǳ': 'dz',
  'ẚ': 'aʾ',
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'st',
  'ﬆ': 'st',
};
