/* global boot, advance, flush, cloud, addDevice, door, feeder, registry, files, check, svc, val, read, byName, logHas, logs, out, failures, passes, hap */

async function main() {
  var CFG = { name: 'Omlet', bearerToken: 'good_token', countryCode: 'GB' };

  out('1. Fresh install: two doors, a feeder and a fan on one account');
  addDevice(door('DOOR1', 'Green Coop', { light: true }));
  addDevice(door('DOOR2', 'Blue Coop', { mains: true }));
  addDevice(feeder('FEED1', 'Big Feeder', 55));
  cloud.devices.FAN1 = { deviceId: 'FAN1', name: 'Coop Fan', deviceType: 'Fan', state: {} };
  var b = await boot(CFG);
  await advance(10000);
  check(registry.length === 3, 'three accessories registered (fan skipped), got ' + registry.length);
  check(logHas(/Skipping "Coop Fan".*not supported/), 'fan logged as unsupported');
  var g = byName('Green Coop'), bl = byName('Blue Coop'), f = byName('Big Feeder');
  check(g && bl && f, 'accessories named after the Omlet devices');
  check(g.context.deviceId === 'DOOR1' && bl.context.deviceId === 'DOOR2' && f.context.kind === 'feeder', 'device IDs and kinds recorded in context');
  check(!!svc(g, 'Lightbulb') && !svc(bl, 'Lightbulb'), 'light only on the door that has one');
  check(!!svc(g, 'Battery') && !svc(bl, 'Battery'), 'battery only on the battery-powered door');
  check(val(g, 'GarageDoorOpener', 'CurrentDoorState') === 1, 'Green Coop reports closed');
  check(await read(f, 'HumiditySensor', 'CurrentRelativeHumidity') === 55, 'feed level 55%');
  check(await read(f, 'OccupancySensor', 'OccupancyDetected') === 0, 'feed not low at 55%');
  check(await read(f, 'ContactSensor', 'ContactSensorState') === 0, 'feeder door closed');
  check(!!svc(f, 'Battery'), 'feeder battery shown');
  check(logHas(/\[Big Feeder\] \[Feeder\] Feed level 55%, door closed\. Full state:.*feedLevel/), 'first feeder reading logged with level, door and full state');
  check(logHas(/Feeder initialized \(Feed Low alert threshold: 20%/), 'startup line names the threshold as a threshold');
  var polled = cloud.requests.filter(function (r) { return /^GET \/api\/v1\/device\//.test(r); });
  check(polled.some(function (r) { return /DOOR1$/.test(r); }) && polled.some(function (r) { return /DOOR2$/.test(r); }) && polled.some(function (r) { return /FEED1$/.test(r); }), 'each device polled on its own ID');
  check(files['/hb/omlet-multi-tokens.json'] && JSON.parse(files['/hb/omlet-multi-tokens.json']).bearerToken === 'good_token', 'token saved to our own storage file');
  check(JSON.parse(files['/hb/config.json']).platforms[0].bearerToken === undefined, 'token removed from config.json');

  out('2. Commands go to the right door');
  cloud.requests = [];
  await svc(bl, 'GarageDoorOpener').getCharacteristic(hap.Characteristic.TargetDoorState).setter(0);
  check(cloud.requests.indexOf('POST /api/v1/device/DOOR2/action/open') >= 0, 'open sent to Blue Coop only');
  check(cloud.requests.every(function (r) { return !/DOOR1\/action/.test(r); }), 'Green Coop untouched');
  await svc(g, 'Lightbulb').getCharacteristic(hap.Characteristic.On).setter(true);
  check(cloud.devices.DOOR1.state.light.state === 'on', 'Green Coop light switched on');
  await advance(60000);
  check(val(bl, 'GarageDoorOpener', 'CurrentDoorState') === 0, 'Blue Coop now reports open');
  check(val(g, 'GarageDoorOpener', 'CurrentDoorState') === 1, 'Green Coop still closed');

  out('3. Feed runs low');
  cloud.devices.FEED1.state.feeder.feedLevel = 12;
  await advance(5 * 60 * 1000);
  check(val(f, 'HumiditySensor', 'CurrentRelativeHumidity') === 12, 'feed level updated to 12%');
  check(val(f, 'OccupancySensor', 'OccupancyDetected') === 1, 'Feed Low triggered below 20%');
  var feederPolls = cloud.requests.filter(function (r) { return r === 'GET /api/v1/device/FEED1'; }).length;
  check(feederPolls <= 2, 'feeder polled no more than every 5 minutes (' + feederPolls + ' polls in ~6 min)');

  out('4. A third door is added while running');
  addDevice(door('DOOR3', 'New Coop', { light: true }));
  await advance(60 * 60 * 1000);
  check(!!byName('New Coop') && registry.length === 4, 'picked up by hourly rediscovery without restart');

  out('5. Restart: accessories restored from cache, not duplicated');
  b.platform.handlers.forEach(function (h) { h.stop(); });
  b = await boot(CFG);
  await advance(15000);
  check(registry.length === 4, 'still four accessories, got ' + registry.length);
  check(b.platform.handlers.size === 4, 'four handlers running');
  check(logHas(/Using saved API key/), 'used the stored key after config.json was cleaned');

  out('6. One door replaced (new device ID): accessory kept and re-pointed');
  delete cloud.devices.DOOR2;
  addDevice(door('DOOR2B', 'Blue Coop', { mains: true }));
  b.platform.handlers.forEach(function (h) { h.stop(); });
  var blueBefore = byName('Blue Coop');
  b = await boot(CFG);
  await advance(15000);
  check(registry.length === 4, 'no accessory added or lost, got ' + registry.length);
  check(byName('Blue Coop') === blueBefore && blueBefore.context.deviceId === 'DOOR2B', 'same HomeKit accessory now on DOOR2B');
  check(logHas(/has been replaced by "Blue Coop" \(DOOR2B\)/), 'swap logged');

  out('7. Two doors swapped at once: no guessing');
  delete cloud.devices.DOOR1; delete cloud.devices.DOOR3;
  addDevice(door('DOOR1B', 'Green Coop 2', {})); addDevice(door('DOOR3B', 'New Coop 2', {}));
  b.platform.handlers.forEach(function (h) { h.stop(); });
  b = await boot(CFG);
  await advance(15000);
  check(!byName('Green Coop') && !byName('New Coop'), 'old accessories removed');
  check(!!byName('Green Coop 2') && !!byName('New Coop 2'), 'new accessories added');
  check(registry.length === 4, 'four accessories, got ' + registry.length);

  out('8. Excluding a device');
  b.platform.handlers.forEach(function (h) { h.stop(); });
  b = await boot(Object.assign({}, CFG, { excludeDevices: ['DOOR3B'] }));
  await advance(15000);
  check(!byName('New Coop 2') && registry.length === 3, 'excluded door removed from HomeKit');
  check(logHas(/Skipping "New Coop 2".*excluded/), 'exclusion logged');

  out('9. Omlet unreachable at startup');
  b.platform.handlers.forEach(function (h) { h.stop(); });
  cloud.failDiscovery = true;
  var EXCL = Object.assign({}, CFG, { excludeDevices: ['DOOR3B'] });
  cloud.requests = [];
  b = await boot(EXCL);
  await advance(15000);
  check(cloud.requests.indexOf('GET /api/v1/device/DOOR2B') >= 0, 'cached door polled while discovery is down');
  check(b.platform.handlers.size === 3, 'cached devices started anyway (' + b.platform.handlers.size + ')');
  check(registry.length === 3, 'nothing removed while discovery is failing');
  check(val(byName('Blue Coop'), 'GarageDoorOpener', 'CurrentDoorState') === 1, 'cached door still polled and reporting');
  cloud.failDiscovery = false;
  await advance(61000);
  check(logHas(/Found an API key|Using saved API key/) && b.platform.initialSyncDone, 'discovery retried and succeeded');
  check(!byName('New Coop 2') && registry.length === 3, 'still honours exclusion after recovery');

  out('10. Door replaced while running (404 on poll)');
  delete cloud.devices['DOOR1B'];
  addDevice(door('DOOR1C', 'Green Coop 3', {}));
  var greenAcc = byName('Green Coop 2');
  await advance(60000);
  check(greenAcc.context.deviceId === 'DOOR1C', 'running accessory re-pointed at the single new door');
  check(b.platform.handlers.get('DOOR1C') && !b.platform.handlers.get('DOOR1B'), 'handler re-keyed');

  out('11. Migration from the single-door plugin');
  b.platform.handlers.forEach(function (h) { h.stop(); });
  Object.keys(files).forEach(function (k) { delete files[k]; });
  registry.length = 0;
  files['/hb/omlet-coop-tokens.json'] = JSON.stringify({ bearerToken: 'good_token', deviceId: 'DOOR2B' });
  b = await boot({ name: 'Omlet', countryCode: 'GB' });
  await advance(15000);
  check(logHas(/Found an API key saved by the Omlet Coop plugin/), 'legacy key imported');
  check(registry.length === 4, 'all four devices set up from the imported key, got ' + registry.length);
  check(JSON.parse(files['/hb/omlet-multi-tokens.json']).bearerToken === 'good_token', 'imported key saved to our storage once it worked');


  out('12. Two doors removed at runtime, one new door added: no guessing');
  b.platform.handlers.forEach(function (h) { h.stop(); });
  Object.keys(files).forEach(function (k) { delete files[k]; });
  registry.length = 0; cloud.devices = {};
  addDevice(door('RA', 'Coop A', {})); addDevice(door('RB', 'Coop B', {}));
  b = await boot(CFG);
  await advance(15000);
  var accA = byName('Coop A'), accB = byName('Coop B');
  delete cloud.devices.RA; delete cloud.devices.RB;
  addDevice(door('RBNEW', 'Coop B replacement', {}));
  await advance(60000);
  out('   Coop A now -> ' + accA.context.deviceId + ', Coop B now -> ' + accB.context.deviceId);
  check(accA.context.deviceId !== 'RBNEW' && accB.context.deviceId !== 'RBNEW', 'neither missing door takes the new one');

  out('13. Old device ID returns after a swap');
  b.platform.handlers.forEach(function (h) { h.stop(); });
  Object.keys(files).forEach(function (k) { delete files[k]; });
  registry.length = 0; cloud.devices = {};
  addDevice(door('SA', 'Coop A', {})); addDevice(door('SB', 'Coop B', {}));
  b = await boot(CFG); await advance(15000);
  b.platform.handlers.forEach(function (h) { h.stop(); });
  delete cloud.devices.SB; addDevice(door('SBNEW', 'Coop B new', {}));
  b = await boot(CFG); await advance(15000);
  var accB2 = byName('Coop B');
  check(accB2.context.deviceId === 'SBNEW', 'swap happened');
  // old door comes back (e.g. re-shared into the account)
  cloud.devices = {}; addDevice(door('SB', 'Coop B old', {})); addDevice(door('SA', 'Coop A', {})); addDevice(door('SBNEW', 'Coop B new', {}));
  await advance(60 * 60 * 1000);
  var uuids = registry.map(function (a) { return a.UUID; });
  var dup = uuids.filter(function (u, i) { return uuids.indexOf(u) !== i; });
  check(dup.length === 0, 'no duplicate UUIDs registered (dups: ' + dup.join(',') + ')');
  b.platform.handlers.forEach(function (h) { h.stop(); });
  check(!!byName('Coop B old') && byName('Coop B old').context.deviceId === 'SB', 'returning old door gets its own accessory');
  // restart with SB listed before SBNEW
  b = await boot(CFG); await advance(15000);
  check(accB2.context.deviceId === 'SBNEW', 'swapped accessory still bound to SBNEW after restart, got ' + accB2.context.deviceId);

  out('');
  out(passes + ' passed, ' + failures + ' failed');
  if (failures) {
    out('--- log tail ---');
    logs.slice(-40).forEach(function (l) { out(l); });
  }
}
main().catch(function (e) { out('CRASH ' + e + '\n' + e.stack); });
