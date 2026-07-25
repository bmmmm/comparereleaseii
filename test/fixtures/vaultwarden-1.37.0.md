## Note
This update is required for support with clients with version 2026.7.0+, please update before reporting any issues with them.

## Security Fixes
This release contains security fixes for the following advisories. We strongly advice to update as soon as possible.
- SSRF via the icon endpoint [[GHSA-hw4g-2v3f-74x5]](https://github.com/dani-garcia/vaultwarden/security/advisories/GHSA-hw4g-2v3f-74x5) [[GHSA-vh5m-fc9v-m84g]](https://github.com/dani-garcia/vaultwarden/security/advisories/GHSA-vh5m-fc9v-m84g) (**Medium**, 5.8 / 6.3)
- Cross-Organization Cipher Access [[GHSA-xwf8-pjh7-h589]](https://github.com/dani-garcia/vaultwarden/security/advisories/GHSA-xwf8-pjh7-h589) (**Medium**, 5.9)
- Organization Policy Bypass on Directory Import [[GHSA-88qc-6ch9-mc3j]](https://github.com/dani-garcia/vaultwarden/security/advisories/GHSA-88qc-6ch9-mc3j) (**Medium**, 5.5)
- Send Access-Count Bypass [[GHSA-rxhg-2pw9-vf25]](https://github.com/dani-garcia/vaultwarden/security/advisories/GHSA-rxhg-2pw9-vf25) (**Medium**, 5.3)
- Unauthenticated WebSocket Flooding DDOS [[GHSA-96f7-78q5-j345]](https://github.com/dani-garcia/vaultwarden/security/advisories/GHSA-96f7-78q5-j345) (**Medium**, 5.3)
- Cross-Organization Secret Sharing [[GHSA-455c-vgg9-jxw8]](https://github.com/dani-garcia/vaultwarden/security/advisories/GHSA-455c-vgg9-jxw8) (**Medium**, 4.3)
- Organization Import Authorization [[GHSA-f3qw-qg77-hmm4]](https://github.com/dani-garcia/vaultwarden/security/advisories/GHSA-f3qw-qg77-hmm4)[[GHSA-jq2g-h4xr-4mcr]](https://github.com/dani-garcia/vaultwarden/security/advisories/GHSA-jq2g-h4xr-4mcr) (**Medium**, 4.3)
- Organization Data Enumeration via the Manager role [[GHSA-rqf8-2568-r7mc]](https://github.com/dani-garcia/vaultwarden/security/advisories/GHSA-rqf8-2568-r7mc) (**Medium**, 4.3)

These are private for now, pending CVE assignment and publishing at a later date.

## What's Changed
* OpenDAL S3 parameter support by @txase in https://github.com/dani-garcia/vaultwarden/pull/6127
* Fix SSO Cookie path by @BlackDex in https://github.com/dani-garcia/vaultwarden/pull/7187
* fix email 2fa for bw cli by @stefan0xC in https://github.com/dani-garcia/vaultwarden/pull/7225
* sso_auth improvements by @Timshel in https://github.com/dani-garcia/vaultwarden/pull/7197
* Reject unrecognised DATABASE_URL instead of silent SQLite fallback by @mfw78 in https://github.com/dani-garcia/vaultwarden/pull/7061
* Switch to `xx-cargo` by @dfunkt in https://github.com/dani-garcia/vaultwarden/pull/6640
* Updates and fixes by @BlackDex in https://github.com/dani-garcia/vaultwarden/pull/7235
* Switch to Edition 2024, more clippy lints, and less macro calls by @BlackDex in https://github.com/dani-garcia/vaultwarden/pull/7200
* Serve Apple app site association file by @user71424q in https://github.com/dani-garcia/vaultwarden/pull/7191
* Update Rust, Crates and GHA by @BlackDex in https://github.com/dani-garcia/vaultwarden/pull/7307
* Fix enforce blocked by @Timshel in https://github.com/dani-garcia/vaultwarden/pull/7246
* Admin password recovery endpoint change by @Timshel in https://github.com/dani-garcia/vaultwarden/pull/7270
* fix(sends): emit hideEmail as non-null boolean in sync response by @kvdb in https://github.com/dani-garcia/vaultwarden/pull/7283
* Org membership delete remove Invitation by @Timshel in https://github.com/dani-garcia/vaultwarden/pull/7284
* [v2026.5.0] Registration request update by @Timshel in https://github.com/dani-garcia/vaultwarden/pull/7295
* [v2026.5.0] PutPolicy now using vnext format by @Timshel in https://github.com/dani-garcia/vaultwarden/pull/7296
* 2026.6.0 send support by @Timshel in https://github.com/dani-garcia/vaultwarden/pull/7346
* Add SSO_AUTHORIZE_BODY by @Timshel in https://github.com/dani-garcia/vaultwarden/pull/7357
* Add `pm-26340-linux-biometrics-v2` feature flag by @pilotstew in https://github.com/dani-garcia/vaultwarden/pull/7358
* improve CI by @TriplEight in https://github.com/dani-garcia/vaultwarden/pull/6991
* Misc updates and fixes by @BlackDex in https://github.com/dani-garcia/vaultwarden/pull/7406
* Remove old compatibility code by @Timshel in https://github.com/dani-garcia/vaultwarden/pull/7434
* Fix compilation with newer `rust-musl` version by @dfunkt in https://github.com/dani-garcia/vaultwarden/pull/7453
* Fix Custom Role CSS for new dialog markup by @tom27052006 in https://github.com/dani-garcia/vaultwarden/pull/7442
* Remove unused fields by @Timshel in https://github.com/dani-garcia/vaultwarden/pull/7458
* Update API response, crates and GHA by @BlackDex in https://github.com/dani-garcia/vaultwarden/pull/7470
* Trusted proxy support, unauthenticated rate limit & other fixes by @dani-garcia in https://github.com/dani-garcia/vaultwarden/pull/7472

## New Contributors
* @mfw78 made their first contribution in https://github.com/dani-garcia/vaultwarden/pull/7061
* @user71424q made their first contribution in https://github.com/dani-garcia/vaultwarden/pull/7191
* @kvdb made their first contribution in https://github.com/dani-garcia/vaultwarden/pull/7283
* @pilotstew made their first contribution in https://github.com/dani-garcia/vaultwarden/pull/7358
* @TriplEight made their first contribution in https://github.com/dani-garcia/vaultwarden/pull/6991
* @tom27052006 made their first contribution in https://github.com/dani-garcia/vaultwarden/pull/7442

**Full Changelog**: https://github.com/dani-garcia/vaultwarden/compare/1.36.0...1.37.0
