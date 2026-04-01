# Windows Host Helper

This is the native Windows companion service for Wrangler. It exposes the same lightweight HTTP contract as the macOS helper so the Dockerized API and web app do not need platform-specific changes.

## Endpoints

- `GET /health`
- `GET /volumes`

## What it reports

The helper scans ready removable drives and returns records shaped like the shared `Volume` type:

- `id`
- `name`
- `mountPath`
- `deviceIdentifier`
- `sizeBytes`
- `removable`
- `writable`
- `fileSystem`
- `insertedAt`
- `lastSeenAt`

## Run locally

```bash
dotnet run
```

By default it listens on port `4100`. Override that with `HOST_HELPER_PORT`.

## Notes

- It uses native .NET drive enumeration plus WMI metadata from `Win32_LogicalDisk`.
- The helper is intended to stay API-compatible with `apps/host-helper`.
- It does not change the existing macOS workflow.
