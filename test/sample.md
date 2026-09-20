---
page_id: "2647654401"
title: "Product Note Sample"
space: "PN"
status: "current"
version: 4
created_at: "2022-06-08T06:26:52.167Z"
updated_at: "2022-06-08T07:56:55.453Z"
fetched_at: "2026-09-19T08:45:54.965867+00:00"
parent_id: "2625536257"
source_url: "https://creditsaison-in.atlassian.net/wiki/spaces/PN/pages/2647654401/Product+Note+Sample"
evidence_role: "product-intent-and-history; implementation requires code/runtime corroboration"
labels:
  - product
  - note
---

# Product Note Sample

The upload failed with `Invalid file id - UNKNOWN_MEDIA_ID`. The page depends on
those records in this snapshot, so the import has to be replayed before the
attachment resolves.

## Reproduction

```js
async function fetchPage(id) {
  const res = await client.get(`/wiki/api/v2/pages/${id}`, { expand: 'body.storage' });
  if (res.status !== 200) throw new Error(`page ${id} returned ${res.status}`);
  return res.data;   // caller normalises the storage format
}
```

```python
def replay(snapshot: Path, *, dry_run: bool = False) -> int:
    records = json.loads(snapshot.read_text())
    return sum(1 for r in records if not dry_run and upload(r))
```

```sql
SELECT page_id, COUNT(*) AS attachments
FROM   confluence_media
WHERE  media_id IS NULL
GROUP  BY page_id
ORDER  BY attachments DESC;
```

| Field | Value | Notes |
|---|---|---|
| `page_id` | 2647654401 | stable across versions |
| `version` | 4 | bumped on every publish |
| `media_id` | *missing* | the cause of the failure |

> The snapshot is authoritative for product intent, not for implementation.

- First item in a list
- Second item, which is longer and wraps onto another line so the gutter button
  has something taller to sit against
- Third item

## Flow

```mermaid
graph TD
  A[Confluence page] --> B{Has attachments?}
  B -->|yes| C[Resolve media ids]
  B -->|no| D[Emit note]
  C --> E[(Snapshot store)]
  C --> F[Retry queue]
  F --> C
  E --> G[Review preview]
  D --> G
```
