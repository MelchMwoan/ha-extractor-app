# Changelog

## [0.0.2] - 2026-09-28

### Added
- Added an option to retain the Chromium profile to reduce startup time, may increase memory usage
- Added ES5 fallback mechanisms to `index.html` for older android browsers

### Fixes
- Improved performance and reduced CPU usage
- Reduced docker image size
- Fixed an issue where the `index.html` didn't inject the newer version of the output
- Fixed a deprecated warning in `config.yaml` by changing `map: config:x` to the newer map layout according to the HA docs


## [0.0.1] - 2026-09-28

### Added
- Initial release of the HA Dashboard Extractor Add-on.
