## 15.4.0 (2026-07-20)

### Added

- Support `--concurrency` on the importer to bound parallel writes (!4821)
- New `POST /api/v4/exports` endpoint for scheduled exports, see merge request
  platform/backend!4877

### Fixed

- `parseInterval` rejected ISO-8601 durations with fractional seconds (!4903)
- Session cookies were written without `SameSite` on the admin host
  ([!4915](https://gitlab.example.com/platform/backend/-/merge_requests/4915))
- Retry the object-store upload once before failing the job (!4930, !4931)

### Changed

- The `legacy_export` feature flag now defaults to off (!4952)
