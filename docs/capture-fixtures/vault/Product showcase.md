# Resource API design

A compact reference for a note resource: its shape, requests, and response contract.

%% cols %%

## Resource contract

| Field       | Purpose          |
| ----------- | ---------------- |
| `id`        | Stable identity  |
| `title`     | Display name     |
| `updatedAt` | Last change time |

```json
{
  "id": "42",
  "title": "HTTP caching",
  "updatedAt": "2026-01-15T10:00:00Z"
}
```

> [!tip] Model the resource
> Keep the URI stable when the representation changes.

%% col:60 %%

## Request lifecycle

1. Identify the resource with its URI.
2. Choose the method for the operation.
3. Return a status and a clear representation.

%% cols %%

### Read

```http
GET /notes/42
```

Retrieve the current note.

%% col %%

### Update

```http
PATCH /notes/42
```

Apply a partial change.

%% endcols %%

| Status | Meaning                         |
| ------ | ------------------------------- |
| `200`  | Representation returned         |
| `204`  | Success without a response body |
| `404`  | Resource not found              |

%% endcols %%

**Review:** validation errors · pagination · conditional requests
