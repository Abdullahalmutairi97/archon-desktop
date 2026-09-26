# Frozen v1 migration fixture

`published_v1_db.py` is the byte-for-byte `backend/archon_server/db.py` from the Phase 1C.1 publication boundary, PR #16, checkpoint `64cd75ae12bebb660e0c1f2796fab9d3eef5a580`.

- `published_v1_db.py` SHA-256: `53e5be5b82a00cec36945d936efe7030f958c5bc5e9675032f75e8bf11e4fd8c`
- Its imported `migrations/v001.py` is kept as the immutable current source and must retain SHA-256 `7d8a115753c61aff3eadc4058a2e0cd9482d88f6149359931697cd81a7581cf6`.

The fixture lets the migration regression test run in fresh clones and CI without relying on local Git ancestry. It is test-only compatibility evidence; production code does not load it.
