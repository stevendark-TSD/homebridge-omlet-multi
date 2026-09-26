// Minimal Homebridge / HAP / https / fs fakes, so index.js can be exercised in any
// JavaScript shell (JavaScriptCore's jsc, or node) without installing Homebridge.
// Run with: test/run.sh
/* global print, loadString, PLUGIN_SOURCE */

var out = (typeof print === 'function') ? print : console.log;

// ---------- fake clock
var clock = { now: 0, timers: [], seq: 0 };
function fakeSetTimeout(fn, ms) { var id = ++clock.seq; clock.timers.push({ id: id, at: clock.now + (ms || 0), fn: fn }); return id; }
function fakeClearTimeout(id) { clock.timers = clock.timers.filter(function (t) { return t.id !== id; }); }
function fakeSetInterval(fn, ms) { var id = ++clock.seq; var t = { id: id, at: clock.now + ms, fn: fn, every: ms }; clock.timers.push(t); return id; }
Date.now = function () { return clock.now; };
async function flush() { for (var i = 0; i < 200; i++) { await null; } }
async function advance(ms) {
  var end = clock.now + ms;
  for (;;) {
    clock.timers.sort(function (a, b) { return a.at - b.at || a.id - b.id; });
    var t = clock.timers[0];
    if (!t || t.at > end) break;
    clock.now = t.at;
    if (t.every) { t.at += t.every; } else { clock.timers.shift(); }
    t.fn();
    await flush();
  }
  clock.now = end;
  await flush();
}

// ---------- fake Omlet cloud
var cloud = {
  token: 'good_token',
  devices: {},     // deviceId -> device object as the API returns it
  requests: [],
  failDiscovery: false
};
function addDevice(d) { cloud.devices[d.deviceId] = d; }
function door(id, name, opts) {
  opts = opts || {};
  return {
    deviceId: id, name: name, deviceType: 'Autodoor',
    state: {
      general: { batteryLevel: opts.battery == null ? 80 : opts.battery, powerSource: opts.mains ? 'external' : 'internal', firmwareVersionCurrent: '1.0.53' },
      door: { state: opts.door || 'closed', fault: 'none' },
      light: opts.light ? { state: 'off' } : undefined
    },
    configuration: { light: { equipped: opts.light ? 1 : 0 } }
  };
}
function feeder(id, name, level) {
  return {
    deviceId: id, name: name, deviceType: 'Feeder',
    state: {
      general: { batteryLevel: 64, powerSource: 'internal', firmwareVersionCurrent: '2.0.1' },
      feeder: { state: 'closed', fault: 'none', feedLevel: level, lightLevel: 40, mode: 'time' }
    },
    configuration: {}
  };
}
function handle(options, body) {
  var auth = options.headers && options.headers.Authorization;
  cloud.requests.push(options.method + ' ' + options.path);
  if (auth !== 'Bearer ' + cloud.token) return [401, '{}'];
  if (options.path === '/api/v1/group') {
    if (cloud.failDiscovery) return 'neterror';
    var list = Object.keys(cloud.devices).map(function (k) { return cloud.devices[k]; });
    return [200, JSON.stringify([{ groupId: 'g1', devices: list }])];
  }
  var m = options.path.match(/^\/api\/v1\/device\/([^/]+)(\/action\/(\w+))?$/);
  if (m) {
    var dev = cloud.devices[m[1]];
    if (!dev) return [404, '{}'];
    if (m[3]) {
      var a = m[3];
      if (a === 'open') dev.state.door.state = 'open';
      if (a === 'close') dev.state.door.state = 'closed';
      if (a === 'on') dev.state.light.state = 'on';
      if (a === 'off') dev.state.light.state = 'off';
      return [200, ''];
    }
    return [200, JSON.stringify(dev)];
  }
  return [404, '{}'];
}
function Emitter() { this.h = {}; }
Emitter.prototype.on = function (e, f) { (this.h[e] = this.h[e] || []).push(f); return this; };
Emitter.prototype.emit = function (e, v) { (this.h[e] || []).forEach(function (f) { f(v); }); };
var https = {
  request: function (options, cb) {
    var req = new Emitter(); var body = '';
    req.write = function (d) { body += d; };
    req.destroy = function () {};
    req.end = function () {
      Promise.resolve().then(function () {
        var r = handle(options, body);
        if (r === 'neterror') { req.emit('error', new Error('getaddrinfo ENOTFOUND')); return; }
        var res = new Emitter(); res.statusCode = r[0];
        cb(res);
        res.emit('data', r[1]); res.emit('end');
      });
    };
    return req;
  }
};

// ---------- fake fs
var files = {};
var fs = {
  existsSync: function (p) { return Object.prototype.hasOwnProperty.call(files, p); },
  readFileSync: function (p) { if (!fs.existsSync(p)) throw new Error('ENOENT ' + p); return files[p]; },
  writeFileSync: function (p, d) { files[p] = String(d); },
  renameSync: function (a, b) { files[b] = files[a]; delete files[a]; },
  unlinkSync: function (p) { delete files[p]; }
};

// ---------- fake HAP
function Characteristic(name) { this.name = name; this.value = null; this.getter = null; this.setter = null; }
Characteristic.prototype.onGet = function (f) { this.getter = f; return this; };
Characteristic.prototype.onSet = function (f) { this.setter = f; return this; };
Characteristic.prototype.updateValue = function (v) { this.value = v; return this; };
Characteristic.prototype.setValue = function (v) { this.value = v; return this; };
function Service(type, name, subtype) { this.type = type; this.displayName = name; this.subtype = subtype; this.chars = {}; this.linked = []; this.primary = false; }
Service.prototype.getCharacteristic = function (c) { var k = c.KEY; return this.chars[k] = this.chars[k] || new Characteristic(k); };
Service.prototype.setCharacteristic = function (c, v) { this.getCharacteristic(c).value = v; return this; };
Service.prototype.setPrimaryService = function (v) { this.primary = v; };
Service.prototype.addLinkedService = function (s) { if (this.linked.indexOf(s) < 0) this.linked.push(s); };
Service.prototype.removeLinkedService = function (s) { this.linked = this.linked.filter(function (x) { return x !== s; }); };
function svcType(name) { return { KEY: name }; }
function charType(name, consts) { var c = { KEY: name }; Object.keys(consts || {}).forEach(function (k) { c[k] = consts[k]; }); return c; }
var hap = {
  Service: {}, Characteristic: {},
  Categories: { SENSOR: 10, GARAGE_DOOR_OPENER: 4 },
  HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
  HapStatusError: function (s) { this.hapStatus = s; this.message = 'HapStatusError ' + s; },
  uuid: { generate: function (s) { return 'uuid:' + s; } }
};
['AccessoryInformation', 'GarageDoorOpener', 'Lightbulb', 'Battery', 'ContactSensor', 'HumiditySensor', 'OccupancySensor'].forEach(function (n) { hap.Service[n] = svcType(n); });
[['Manufacturer'], ['Model'], ['SerialNumber'], ['FirmwareRevision'], ['Name'], ['On'], ['BatteryLevel'], ['ChargingState'], ['StatusLowBattery'], ['ObstructionDetected'], ['CurrentRelativeHumidity'],
 ['CurrentDoorState', { OPEN: 0, CLOSED: 1, OPENING: 2, CLOSING: 3, STOPPED: 4 }],
 ['TargetDoorState', { OPEN: 0, CLOSED: 1 }],
 ['ContactSensorState', { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 }],
 ['StatusFault', { NO_FAULT: 0, GENERAL_FAULT: 1 }],
 ['OccupancyDetected', { OCCUPANCY_NOT_DETECTED: 0, OCCUPANCY_DETECTED: 1 }]
].forEach(function (p) { hap.Characteristic[p[0]] = charType(p[0], p[1]); });

function PlatformAccessory(name, uuid, category) {
  this.displayName = name; this.UUID = uuid; this.category = category; this.context = {};
  this.services = [new Service('AccessoryInformation', name)];
}
PlatformAccessory.prototype.getService = function (t) { var k = t.KEY; for (var i = 0; i < this.services.length; i++) if (this.services[i].type === k) return this.services[i]; return undefined; };
PlatformAccessory.prototype.addService = function (t, name, subtype) { var s = new Service(t.KEY, name, subtype); this.services.push(s); return s; };
PlatformAccessory.prototype.removeService = function (s) { this.services = this.services.filter(function (x) { return x !== s; }); };

// ---------- fake Homebridge
var logs = [];
function makeLog() {
  var l = function () {};
  ['info', 'warn', 'error', 'debug', 'success'].forEach(function (lvl) {
    l[lvl] = function () { var line = lvl.toUpperCase() + ' ' + Array.prototype.slice.call(arguments).map(function (a) { return typeof a === 'string' ? a : JSON.stringify(a); }).join(' '); logs.push(line); if (globalThis.VERBOSE) out('    ' + line); };
  });
  return l;
}
var registry = [];   // accessories Homebridge would cache
function makeApi() {
  var listeners = {};
  var api = {
    hap: hap,
    platformAccessory: PlatformAccessory,
    user: { storagePath: function () { return '/hb'; }, configPath: function () { return '/hb/config.json'; } },
    on: function (e, f) { listeners[e] = f; },
    fire: function (e) { return listeners[e] && listeners[e](); },
    registerPlatformAccessories: function (p, n, list) { list.forEach(function (a) { a._plugin = p + '/' + n; registry.push(a); }); },
    unregisterPlatformAccessories: function (p, n, list) { registry = registry.filter(function (a) { return list.indexOf(a) < 0; }); },
    updatePlatformAccessories: function () {},
    registerPlatform: function (p, n, cls) { api._platform = { name: n, cls: cls }; }
  };
  return api;
}

function loadPlugin() {
  var module = { exports: {} };
  var req = function (name) {
    if (name === 'https') return https;
    if (name === 'fs') return fs;
    if (name === './package.json') return { version: '1.0.0-test' };
    throw new Error('unexpected require ' + name);
  };
  var fn = new Function('module', 'exports', 'require', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', PLUGIN_SOURCE);
  fn(module, module.exports, req, { byteLength: function (s) { return String(s).length; } }, fakeSetTimeout, fakeClearTimeout, fakeSetInterval);
  return module.exports;
}

// Simulates a Homebridge start: restores cached accessories, constructs the platform.
async function boot(config) {
  clock.timers = [];
  logs = [];
  var api = makeApi();
  loadPlugin()(api);
  var cached = registry.slice();
  files['/hb/config.json'] = JSON.stringify({ platforms: [Object.assign({ platform: api._platform.name }, config)] });
  var platform = new api._platform.cls(makeLog(), Object.assign({ platform: api._platform.name }, config), api);
  // Rebuild cached accessories the way Homebridge would: same UUID/context/services.
  cached.forEach(function (a) { platform.configureAccessory(a); });
  await api.fire('didFinishLaunching');
  await flush();
  return { platform: platform, api: api };
}

// ---------- assertions
var failures = 0, passes = 0;
function check(cond, msg) { if (cond) { passes++; out('  ok   ' + msg); } else { failures++; out('  FAIL ' + msg); } }
function svc(acc, type) { return acc.getService(hap.Service[type]); }
function val(acc, type, ch) { var s = svc(acc, type); return s && s.getCharacteristic(hap.Characteristic[ch]).value; }
async function read(acc, type, ch) { var s = svc(acc, type); var c = s.getCharacteristic(hap.Characteristic[ch]); try { return await c.getter(); } catch (e) { return 'ERR:' + e.message; } }
function byName(n) { return registry.filter(function (a) { return a.displayName === n; })[0]; }
function logHas(re) { return logs.some(function (l) { return re.test(l); }); }
