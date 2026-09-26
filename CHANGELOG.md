# Changelog

## [1.0.2] - 2026-09-26

- Settings page is readable with the Homebridge dark theme. Its light panels inherited the theme's white text, so most of the page was white on white.
- Text boxes no longer overflow their panel.

## [1.0.1] - 2026-09-26

- Clearer feeder log lines. The startup line now says "Feed Low alert threshold" rather than "feed low below", which read like a current status, and the first reading states the feed level and door state before the full data.
- README: feed level confirmed as a 0 to 100 percentage matching the Omlet app.

## [1.0.0] - 2026-09-26

First release of **homebridge-omlet-multi**, forked from homebridge-omlet 0.9.9-beta.1. The package name, platform name (`OmletMulti`) and storage file are new, so it can be installed in place of the original.

### Multiple devices
- Every coop door on the account gets its own HomeKit accessory, named after the door in the Omlet app, each with its own light, battery and obstruction status. There is no longer a limit of one door.
- New devices are picked up by hourly rediscovery, without a restart.
- Devices can be hidden from HomeKit (`excludeDevices`, or the **Show in HomeKit** tick box in settings).
- Replacement hardware keeps its HomeKit accessory only when the match is unambiguous (one gone, one new, same kind). Previously a missing device ID was swapped for any other device on the account, which with two coops meant silently taking over the other coop.
- Devices no longer on the account are removed at startup only, never mid-run.
- If Omlet is unreachable at startup, cached devices keep running and discovery retries every minute.
- Device polls are staggered so several devices do not hit the API at once.
- Log lines are prefixed with the device name.
- The manual Device ID setting is removed.

### Feeders
- Omlet Smart Feeders are supported, read-only: the feeder door (contact sensor), Feed Level (percentage), Feed Low (occupancy sensor, below `feedLowThreshold`, default 20%), fault status and battery.
- Feeders are polled every 5 minutes at most.

### Migration
- The API key saved by the original plugin is imported on first run.

### Settings page
- Lists every door and feeder on the account, with a **Show in HomeKit** tick box on each.
- Adds the Feed Low Threshold setting.
- Device names from the Omlet account are shown as plain text rather than inserted as HTML.

### Development
- Adds `test/run.sh`: scenario tests against a fake Homebridge, HomeKit and Omlet API, with no dependencies.

## [0.9.9] - 2026-09-22

### Setup
- Setup adds support for the official Omlet developer API keys. This is the only officially-supported sign-in method from Omlet, and keys can be managed and revoked on their portal.
- If a coop is factory reset or replaced, the HomeKit accessories are preserved by the replacement coop (or reset coop), instead of appearing as a new coop.
- Repeated authentication failures no longer fill the log; polling stops until credentials are fixed.

### Security Enhancements
- Omlet account email and password are no longer stored in config. Existing credentials are cleared on upgrade.
- API keys in config.json are moved on upgrade to the recommended storage locations.
- It is still possible to manually add email address, password, or bearerToken to the config.json file, but once login is validated, the credentials are removed from the config.
- API tokens are no longer written to the log in debug mode.

### Accessories
- The coop light accessory is now auto-discovered at setup and periodically, so if you add the light later, Homebridge auto-adds it (and vice versa). The light accessory can still be manually disabled in advanced settings.
- The battery accessory is shown only when the door is actually running on batteries, never for a plugged-in unit.
- Obstruction is now reported to HomeKit when the door reports a blocked fault.

### Omlet Server Reliability
Workarounds implemented for a known Omlet server issue wherein a command to put an accessory in the state it is already in can cause a "stuck pending" state for the accessory. (For example, sending a command to open an already-open door causes the door to stick in a "pending open" state for ~1 hour):
- When sending a command to an accessory, the existing state is checked, and the command is aborted if the accessory is already in the correct state.
- When an accessory is detected as being in a stuck state (i.e. "pending" for over 90 seconds) the system auto-flips the accessory. (For example, if stuck in "pending on" state, the system forces an "off" command followed by an "on" command.)

### Performance Improvements
- 5-second polling interval when the door or light state is changing, to more quickly confirm when the door has finished opening or closing.
- Improved handling of door states in motion.

### Bug Fixes
- Added Spain, Norway, and Poland country support, and corrected United Kingdom entry.
- Poll interval no longer saves an out-of-range or empty value.
- Accessories report as unreachable using the proper HomeKit status instead of throwing.
- Login requests send the correct Content-Length for non-ASCII passwords.

## [0.9.7] - 2026-02-18
- Fixed config schema: moved required fields to object-level array per JSON Schema spec

## [0.9.6] - 2026-02-17
- Verified Homebridge 2.0 compatibility
- Updated minimum Node.js requirement to v20

## [0.9.5] - 2026-02-17
- Fixed minor bugs and further streamlined console logging
- Streamlined code comments
- Poll cycle errors log even without debug

## [0.9.4] - 2026-02-17
- Cleaned default console logging
- Hid verbose logging fully behind debug flag
- Eager re-poll adjustments based on door timing

## [0.9.3] - 2026-02-17
- Fixed showstopper bug in device ID auto-discovery
- Consolidated API polling — all services now share a single poll cycle and cache instead of making individual API calls per service
- Reduced API calls to 1 per poll cycle

## [0.9.2] - 2026-02-16
- Added re-login retry logic on authentication failures (up to 3 attempts before permanent failure)
- Improved error handling and user-facing error messages throughout
- Refined config UI validation and feedback

## [0.9.1] - 2026-02-16
- Refactored to linked services pattern — door is the primary service, light and battery are linked
- Fixed Save button integration in the Homebridge config UI
- Eager re-poll after user commands to confirm state changes in HomeKit

## [0.9.0] - 2026-02-16
- Complete input validation for all config fields (email, token, device ID, hostname, poll interval)
- Stored credentials now take priority over config file values on startup
- Smart credential handling — token-only mode and email/password mode both fully supported

## [0.8.0] - 2026-02-16
- Added custom Homebridge UI with automatic login and device discovery. No manual token or device ID retrieval needed for most users.
- Auto-discovers single device, prompts for device ID selection if multiple devices found

## [0.7.0] - 2026-02-15
- Initial release
