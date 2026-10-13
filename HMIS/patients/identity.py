"""Normalised phone numbers and names, used to recognise the same patient.

HMISWeb and HMISMobile apply the same rules (DOCUMENT_SCHEMA.md, "Duplicate
patients"); a change here needs a matching change in both.
"""
import re
import unicodedata

KENYA_PREFIX = '+254'


def normalize_phone(raw):
    """Kenyan numbers become +2547XXXXXXXX / +2541XXXXXXXX; others keep their digits.

    0712111222, 712111222, 254712111222, +254712111222 and 00254712111222 all
    give +254712111222. A number already in +<country> form is kept as given.
    """
    number = re.sub(r'[\s\-().]', '', raw or '')
    if number.startswith('00'):
        number = '+' + number[2:]
    if number.startswith('+'):
        return number
    if len(number) == 12 and number.startswith('254'):
        return '+' + number
    if len(number) == 10 and number[0] == '0' and number[1] in '17':
        return KENYA_PREFIX + number[1:]
    if len(number) == 9 and number[0] in '17':
        return KENYA_PREFIX + number
    return number


def normalize_name(raw):
    """Case, accents, punctuation, spacing and word order do not matter.

    "Grace Njeri", "njeri  GRACE" and "Grace-Njeri" all give "grace njeri".
    """
    text = unicodedata.normalize('NFKD', raw or '')
    text = ''.join(ch for ch in text if not unicodedata.combining(ch)).casefold()
    return ' '.join(sorted(re.findall(r'[^\W_]+', text)))
