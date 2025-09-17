# AWM State Tracking (Appwrite Managed)

## Overview
AWM now keeps its migration history and locking state inside the Appwrite database that it manages. This means every Appwrite database handled by the tool contains two internal collections that AWM provisions automatically:

- `awm_state` – stores history entries (e.g. the diff applied by `awm apply`, relationship runs, etc.)
- `awm_locks` – lightweight lock records so only one migration run executes at a time

The collections live alongside your project data, so every machine (or CI runner) shares a single source of truth without any SQLite files.

## Lifecycle
1. **Initialisation** – on the first command (`plan`, `apply`, etc.) AWM creates the state and lock collections if they’re missing. Attributes and indexes are created via the Appwrite API.
2. **Apply Runs** – after a successful `awm apply`, the executed change set is recorded as a `history` document (type `apply`) with a checksum and timestamp.
3. **Relationship Runs** – `awm relationships` logs a `history` entry (type `relationships`).
4. **Rollback** – `awm rollback` pulls the most recent `history` entry with status `applied`, tears down the recorded resources, and marks the entry as `rolled_back`.
5. **Reset** – `awm reset` wipes all documents from `awm_state`, keeping collections in place.

## Locking
- Before any mutating command (`apply`, `relationships`, `rollback`, `reset`) the tool acquires a lock document in `awm_locks` (default lock id: `schema-<task>`).
- Locks expire automatically after a TTL (10 minutes by default). If a lock is stale or held by the same owner, it can be re-acquired with `--force`.
- Releasing a lock simply deletes the corresponding document.

## Document Shape (State Collection)
```json
{
  "record_type": "history",
  "record_id": "20240430abcd",
  "status": "applied",
  "payload": {
    "type": "apply",
    "databaseId": "clinical-guidelines",
    "checksum": "...",
    "changes": {
      "collections": [...],
      "attributes": [...],
      "indexes": [...]
    }
  },
  "created_at": "2024-04-30T18:00:00.000Z",
  "updated_at": "2024-04-30T18:00:00.000Z"
}
```

## Benefits
- **Machine Independent** – every environment reads/writes the same state from Appwrite.
- **Automatic Provisioning** – users don’t manage extra schema; AWM injects the internal collections.
- **Audit Trail** – `awm_state` provides a chronological log of schema changes applied by the tool.
- **Safe Concurrency** – the `awm_locks` collection prevents overlapping runs and supports manual overrides when required.

## Notes
- The internal collections are intentionally simple (string + datetime attributes). They don’t interfere with your business collections.
- History payloads are JSON strings stored in the `payload` attribute; AWM handles serialization/deserialization automatically.
- If you ever need to inspect state manually, you can query the `awm_state` collection within the Appwrite console or API.
