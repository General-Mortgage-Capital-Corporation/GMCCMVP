"""The cross-LO contact cache is keyed by property only. A None for a channel
nobody asked for is not a negative result, and serving it as one told LOs
"no phone on file" for a year without PropertyRadar ever being consulted."""

from matching.refi_search import _cache_covers


def test_legacy_entry_trusted_only_where_it_holds_a_value():
    legacy = {"phone": None, "email": "a@b.com"}  # no `requested` key
    assert _cache_covers(legacy, phone=False, email=True)
    assert not _cache_covers(legacy, phone=True, email=False)
    assert not _cache_covers(legacy, phone=True, email=True)


def test_requested_channels_are_authoritative():
    entry = {"phone": None, "email": None, "requested": {"phone": True, "email": False}}
    # PR was asked for the phone and had none: that negative is real.
    assert _cache_covers(entry, phone=True, email=False)
    # Nobody asked for the email yet: a miss, not a "no email".
    assert not _cache_covers(entry, phone=False, email=True)
    assert not _cache_covers(entry, phone=True, email=True)


def test_full_entry_covers_everything():
    entry = {"phone": None, "email": None, "requested": {"phone": True, "email": True}}
    assert _cache_covers(entry, phone=True, email=True)
