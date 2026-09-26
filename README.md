# Homebridge Omlet Multi

Control any number of Omlet Smart Autodoors, including their coop lights, and monitor Omlet Smart Feeders from Apple HomeKit.

This is a fork of [homebridge-omlet](https://github.com/cantcodewontcode/homebridge-omlet-coop) by cantcodewontcode (Bill Spry). That plugin handles one coop door. This version handles every door and feeder on your Omlet account. The door and light control, stuck-state recovery and credential handling are carried over from the original.

## What you get in HomeKit

Each **coop door** becomes one accessory, named after the door in the Omlet app, with:

- a garage door control for opening and closing, which shows an obstruction when the door reports it is blocked
- a light, if a Coop Light is fitted to that door
- a battery level, when the door is running on batteries

Each **feeder** becomes one accessory. Omlet's API cannot control feeders, so everything here is read-only:

- a contact sensor for the feeder door, showing **Open** while the hens can reach the feed, with a fault warning if the feeder reports one
- **Feed Level**, a percentage. HomeKit has no feed sensor, so this uses a humidity sensor and the Home app shows it with a droplet icon
- **Feed Low**, an occupancy sensor that triggers when the level drops below the Feed Low Threshold. Use it for a notification or an automation
- a battery level, when the feeder is running on batteries

Omlet fans are listed in the log but not added yet.

## Requirements

- One or more Omlet Smart Autodoors and/or Smart Feeders, on the Omlet Wi-Fi module
- Omlet Coop Light (optional)
- Homebridge v1.6.0 or later (v2 supported)
- Node.js v20.0.0 or later

## Installation

This plugin is not published to npm, so install it from GitHub. Open the Homebridge UI, go to the Terminal (top-right menu; turn on terminal access in Homebridge Settings if you cannot see it), and run:

```bash
npm install github:stevendark-TSD/homebridge-omlet-multi#v1.0.0
```

Then restart Homebridge. To update, run the same command with the new version tag.

### Switching from the original Omlet Coop plugin

1. Uninstall **Omlet Coop** (`homebridge-omlet`) from the Plugins tab. Running both would mean two plugins controlling the same doors.
2. Install this plugin as above and restart Homebridge.
3. Open this plugin's settings. The API key saved by the original plugin is picked up automatically, so you should not need to log in again.

Because this is a different plugin, HomeKit sees your doors as new accessories. After switching, put each one back in its room and reattach any scenes or automations.

## Configuration

Open **Plugin Settings** in the Homebridge web interface and pick one of two ways to connect.

### Option 1: Developer API key

This is the recommended setup method, and the one officially supported by Omlet.

1. Go to [smart.omlet.com/developers/login](https://smart.omlet.com/developers/login) and login with your Omlet email address and password.
2. Open **API Keys** and click **Generate Key**, then copy it.
3. In Homebridge plugin settings, choose **Developer API key**, paste the key, and click **Login**.

Your coop and accessories are auto-discovered, and the key is saved to the Homebridge storage directory rather than `config.json`.

### Option 2: Omlet account

This is the simplest setup option, and does not require the manual generation of an API key.

1. In Homebridge plugin settings, choose **Omlet account**.
2. Enter your email address and password, and select your country.
3. Click **Login**.

Logging in generates an Omlet API key, which is saved to the Homebridge storage directory rather than `config.json`. Your coop and accessories are auto-discovered. This method impersonates the login process used by the official Omlet mobile app, so the key it generates is not visible in the Omlet Developer console and cannot be revoked.

### Advanced Settings

Rarely needed:

- **API Server**: Override the default API server hostname (if ever needed)
- **Poll Interval**: How often coop doors are checked (30 to 300 seconds). Feeders are checked every 5 minutes at most, as their feed level changes slowly
- **Feed Low Threshold**: The feed level below which a feeder reports Feed Low (default 20%)
- **Debug Mode**: Enable detailed logging for troubleshooting

### Where credentials are kept

Your API key is written to the Homebridge storage directory, not to `config.json`. Your email address and password are never saved anywhere: they are used once to obtain a key and then discarded.

`config.json` is only ever a way to hand the plugin a credential, never a place it keeps one. If you put an API key, or an email address and password, into `config.json` by hand, the plugin uses it, saves what it needs to storage, and then removes all three fields from `config.json`. This happens only after the credential has actually worked - an invalid one is left in place so you can correct it.

If you have upgraded from an older version, any password sitting in your config is removed automatically the first time the plugin connects.

Because no password is kept, a token that stops working cannot be refreshed on its own. If that happens the accessory shows **No Response** in the Home app, and opening the plugin settings will tell you the session has expired. Complete the sign-in process again to restore your accessories.

### Config.json Example (Alternative Method)

If you prefer to edit `config.json` directly:

```json
{
  "platforms": [
    {
      "platform": "OmletMulti",
      "name": "Omlet",
      "email": "YOUR_EMAIL_ADDRESS",
      "password": "YOUR_PASSWORD",
      "countryCode": "US",
      "apiServer": "x107.omlet.co.uk",
      "bearerToken": "YOUR_DEVELOPER_API_KEY",
      "pollInterval": 30,
      "enableLight": "auto",
      "excludeDevices": [],
      "feedLowThreshold": 20,
      "debug": false
    }
  ]
}
```

**Note:** At minimum, you must provide one of:
- **Developer API key** (`bearerToken`), OR
- **Email address and password**

Both are consumed the same way: the plugin uses the credential, saves it to the
Homebridge storage directory, and removes it from `config.json`. A key you generate
and a key issued by logging in are the same thing, so both go in `bearerToken`.

Coop lights are detected automatically. Set `enableLight` to `"off"` to hide every light accessory.

## Multiple devices

Every coop door and feeder on your Omlet account is found automatically, so there is nothing to configure.

- **Adding a device.** A new door or feeder is picked up within the hour, or at once if you restart Homebridge.
- **Hiding a device.** Untick **Show in HomeKit** next to it in the plugin settings, click Save and restart Homebridge. In `config.json`, add its device ID to `excludeDevices`.
- **Replacing a device.** Replacement or factory-reset hardware comes back with a new device ID. If exactly one door (or feeder) has gone and exactly one new one has appeared, the existing HomeKit accessory is moved onto the new device, keeping its room and automations. If several have changed at once, the plugin does not guess. The old accessories are removed and the new ones added.
- **Removing a device.** A device that is no longer on your account is removed from HomeKit the next time Homebridge starts. It is never removed while Homebridge is running, so a brief Omlet outage cannot wipe your setup.
- If Omlet cannot be reached when Homebridge starts, your devices carry on from the last known setup and discovery keeps retrying every minute.

Every log line for a device starts with its name, for example `[Green Coop] [Door] Opening door`.

### A note on feeders

The feeder fields are not in Omlet's published API specification. This plugin uses the field names from Omlet's own TypeScript SDK (`state`, `fault`, `feedLevel`), which other integrations also rely on. Nobody has confirmed that `feedLevel` is always a 0 to 100 percentage, so the first reading from each feeder is written to the log in full. If Feed Level looks wrong, please [open an issue](https://github.com/stevendark-TSD/homebridge-omlet-multi/issues) with that log line.

## Troubleshooting

### Plugin doesn't start

- Verify your Omlet account credentials are correct
- Check that your Omlet device has internet connectivity via the Wi-Fi module
- Enable **Debug Mode** in Advanced Settings to see detailed logs
- Check Homebridge logs for error messages

### Accessories not responding

- Verify your Omlet device has internet connectivity
- Check Homebridge logs for authentication errors
- Try restarting Homebridge

### Door status not updating

- Check the Poll Interval setting (minimum 30 seconds; feeders update every 5 minutes)
- Verify network connectivity between Homebridge and the Omlet API
- Enable Debug Mode to see polling activity in the logs

### Accessory shows "No Response" / session expired

Because your password is not stored, the plugin cannot silently log in again if its
saved key stops working.

- Open the plugin settings. If the session has expired, a message at the top will say so
- Enter your password and click **Login** to get a new token, then restart Homebridge
- If you are using a Developer API key, the key has been revoked — generate a new one
  at [smart.omlet.com/developers](https://smart.omlet.com/developers) and paste it in
- Check the Homebridge log for the specific authentication error

## Development

Tests run the plugin against a fake Homebridge, HomeKit and Omlet API, covering several doors and feeders, device replacement, outages and migration from the original plugin. They need no dependencies. On macOS they run on the built-in JavaScriptCore engine if Node is not installed.

```bash
sh test/run.sh
```

## Support

Please [open an issue on GitHub](https://github.com/stevendark-TSD/homebridge-omlet-multi/issues). For problems that also affect a single door, the [original plugin](https://github.com/cantcodewontcode/homebridge-omlet-coop/issues) may already have an answer.

## Credits

Originally developed by Bill Spry ([cantcodewontcode](https://github.com/cantcodewontcode)) as homebridge-omlet. Multiple-device and feeder support added in this fork. Thanks to the Homebridge community, and to Omlet for supporting our backyard chickens.

## Licence

Apache License 2.0. See [LICENSE](LICENSE). This is a modified version of the original work; the changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

This plugin controls your chicken coop doors. By using it, you accept sole responsibility for the safety of your flock. Always check your coop doors are working correctly, and never rely on this plugin alone. This plugin is not affiliated with, endorsed by, or supported by Omlet Ltd.
