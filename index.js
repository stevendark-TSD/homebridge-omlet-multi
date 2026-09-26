const https = require('https');
const fs = require('fs');

// Homebridge exposes api.serverVersion (its own version), never the plugin's, and
// has no notion of "what version of this plugin ran last time". Recording it here
// is the only way a future release can tell what it is upgrading from.
//
// Prefer shape detection where the data is self-describing - the tri-state
// migration keys off boolean-vs-string and needs no version at all. This is for
// future migrations where the shape cannot discriminate.
const PLUGIN_VERSION = (() => {
  try {
    return require('./package.json').version || null;
  } catch (error) {
    return null;
  }
})();

let hap;

const PLUGIN_NAME = 'homebridge-omlet-multi';
const PLATFORM_NAME = 'OmletMulti';
const STORAGE_FILE = 'omlet-multi-tokens.json';
// The single-device plugin this is forked from. Its saved API key is imported on
// first run so switching over does not mean generating a new one.
const LEGACY_STORAGE_FILE = 'omlet-coop-tokens.json';

// deviceType values seen from the API: "Autodoor", "Feeder", "Fan". Only the first
// two are supported. Matched loosely, with the state sections as a fallback, since
// the published spec does not enumerate them.
const KIND_AUTODOOR = 'autodoor';
const KIND_FEEDER = 'feeder';

function deviceKind(device) {
  const type = String(device.type || '').toLowerCase();

  if (type.includes('door')) {
    return KIND_AUTODOOR;
  }
  if (type.includes('feeder')) {
    return KIND_FEEDER;
  }
  if (!type || type === 'unknown') {
    if (device.hasDoor) {
      return KIND_AUTODOOR;
    }
    if (device.hasFeeder) {
      return KIND_FEEDER;
    }
  }
  return null;
}

// Periodic rediscovery picks up a newly added door or feeder without a restart.
const REDISCOVERY_INTERVAL_MS = 60 * 60 * 1000;
const DISCOVERY_RETRY_MS = 60 * 1000;
// A device that 404s is re-checked against the account at most this often.
const MISSING_RECHECK_MS = 10 * 60 * 1000;
// Spread the first polls out so several devices do not hit the API in one burst.
const POLL_STAGGER_MS = 3000;
// Feed level moves slowly and feeders only check in with Omlet every few minutes.
const MIN_FEEDER_POLL_MS = 5 * 60 * 1000;
const DEFAULT_FEED_LOW_THRESHOLD = 20;

const SERVICE_LABELS = { light: 'Coop light', battery: 'Battery', feed: 'Feed level' };

// Door state vocabulary, confirmed against a live Autodoor (firmware 1.0.53).
// While moving, the API reports `openpending` / `closepending` - taken from each
// action's pendingValue - NOT `opening` / `closing`. The latter are kept in case
// other firmware reports them; an unknown value falls back to STOPPED.
const DOOR_OPENING_STATES = ['openpending', 'opening'];
const DOOR_CLOSING_STATES = ['closepending', 'closing'];
// Confirmed by obstructing a live door: a blocked close sets door.fault to
// "blocked". Other fault values are presumed to exist (motor, calibration) but are
// unknown, and they would not mean "something is in the doorway" - so only "blocked"
// drives ObstructionDetected, and anything else is logged so we learn the vocabulary.
const DOOR_FAULT_NONE = 'none';
const DOOR_FAULT_BLOCKED = 'blocked';

const DOOR_TRANSITION_STATES = DOOR_OPENING_STATES.concat(DOOR_CLOSING_STATES, ['stopping']);
const LIGHT_TRANSITION_STATES = ['onpending', 'offpending'];
const LIGHT_ON_STATES = ['on', 'onpending'];
const LIGHT_OFF_STATES = ['off', 'offpending'];

// Only the "*pending" states mean "command accepted but not acted on" - the state a
// dropped command leaves behind. `opening` / `closing` are the door genuinely in
// motion, and a door still moving after 90s is a mechanical problem, not a lost
// command: forcing the opposite there would be wrong and potentially unsafe.
const STUCK_RECOVERY = {
  door: {
    label: 'Door',
    section: 'door',
    stuckStates: ['openpending', 'closepending'],
    intentOf: (state) => (state === 'openpending' ? 'open' : 'close'),
    oppositeOf: (state) => (state === 'openpending' ? 'close' : 'open'),
    settledMatches: (action, state) => (action === 'open' ? state === 'open' : state === 'closed')
  },
  light: {
    label: 'Light',
    section: 'light',
    stuckStates: LIGHT_TRANSITION_STATES,
    intentOf: (state) => (state === 'onpending' ? 'on' : 'off'),
    oppositeOf: (state) => (state === 'onpending' ? 'off' : 'on'),
    settledMatches: (action, state) => (action === 'on' ? state === 'on' : state === 'off')
  }
};
const FAST_POLL_MS = 5000;
// How many consecutive connection failures get logged normally. After this the
// plugin goes quiet until the connection recovers: an Omlet outage is not made more
// diagnosable by repeating the same line every 30 seconds for an hour.
const MAX_LOGGED_FAILURES = 3;
const MAX_FAST_POLLS = 18; // ~90s at 5s, well past the ~16s a healthy door takes

const DOOR_OPEN_STATES = ['open'].concat(DOOR_OPENING_STATES);
const DOOR_CLOSED_STATES = ['closed'].concat(DOOR_CLOSING_STATES);

// HomeKit's own way of saying "not reachable". Throwing a plain Error instead makes
// Homebridge log "This plugin threw an error from the characteristic ..." for every
// characteristic it reads, which is noise, not information.
function unavailable() {
  if (hap.HapStatusError && hap.HAPStatus) {
    return new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
  return new Error('Device unavailable');
}

function mapDoorState(state) {
  if (state === 'open') {
    return hap.Characteristic.CurrentDoorState.OPEN;
  }
  if (state === 'closed') {
    return hap.Characteristic.CurrentDoorState.CLOSED;
  }
  if (DOOR_OPENING_STATES.includes(state)) {
    return hap.Characteristic.CurrentDoorState.OPENING;
  }
  if (DOOR_CLOSING_STATES.includes(state)) {
    return hap.Characteristic.CurrentDoorState.CLOSING;
  }
  return hap.Characteristic.CurrentDoorState.STOPPED;
}

// Every line a device logs is prefixed with its name, so two doors are
// distinguishable in the Homebridge log.
function prefixedLog(log, prefix) {
  const wrap = (level) => (message, ...rest) => {
    const text = (typeof message === 'string') ? `[${prefix}] ${message}` : message;
    return log[level](text, ...rest);
  };

  return {
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    debug: wrap('debug')
  };
}

module.exports = (api) => {
  hap = api.hap;
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, OmletCoopPlatform);
};

class OmletCoopPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    
    this.email = this.validateEmail(config.email);
    this.password = config.password || undefined;
    this.countryCode = this.validateCountryCode(config.countryCode);
    this.bearerToken = this.validateToken(config.bearerToken, 'bearerToken');
    this.excludeDevices = this.validateDeviceList(config.excludeDevices, 'excludeDevices');
    this.feedLowThreshold = this.validatePercent(config.feedLowThreshold, 'feedLowThreshold', DEFAULT_FEED_LOW_THRESHOLD);
    this.baseUrl = this.validateHostname(config.apiServer) || 'x107.omlet.co.uk';
    this.pollInterval = this.validatePollInterval(config.pollInterval);
    // "auto" (the default, and what an absent setting means) lets the device decide.
    // An explicit true/false is an override and is always obeyed.
    this.rawEnableLight = config.enableLight;
    this.rawEnableBattery = config.enableBattery;
    this.enableLight = this.normalizeTriState(config.enableLight, 'enableLight');
    
    // Forcing the light on is not offered, and is not honoured if hand-edited in:
    // publishing a Lightbulb for a module that is not fitted produces an accessory
    // whose every command fails. Auto-discovery is the only sane "show it" option.
    if (this.enableLight === true) {
      // Only complain about a deliberate "on". A legacy boolean is just the old
      // default and is handled silently by migrateTriState - warning about it
      // would alarm every upgrading user who had the light switched on.
      if (typeof config.enableLight === 'string') {
        this.log.warn('enableLight "on" is not supported - the coop light is auto-discovered. Using "auto".');
      }
      
      this.enableLight = 'auto';
    }
    this.enableBattery = this.normalizeTriState(config.enableBattery, 'enableBattery');
    this.triStateMigrated = false;
    this.credentialsSettled = false;
    this.credentialVerified = false;
    this.authFailedDiscovery = false;
    this.wasDisconnected = false;
    this.previousVersion = null;
    this.storedToken = null;
    this.debug = config.debug || false;
    
    this.currentToken = null;
    this.authMode = null;
    this.storage = this.api.user.storagePath() + '/' + STORAGE_FILE;
    this.legacyStorage = this.api.user.storagePath() + '/' + LEGACY_STORAGE_FILE;
    this.authFailedPermanently = false;
    this.reloginAttempts = 0;
    this.maxReloginAttempts = 3;
    this.authFailures = 0;

    // Cached accessories as restored by Homebridge, and the live handler for each
    // device, keyed by Omlet device ID.
    this.accessories = [];
    this.handlers = new Map();
    this.initialSyncDone = false;
    this.discoveryTimer = null;
    this.missingQueue = Promise.resolve();
    this.reportedUnsupported = new Set();
    this.reportedExcluded = new Set();

    this.log.info('Omlet platform loaded');
    if (this.debug) {
      this.log.info('Debug mode enabled');
    }
    
    this.api.on('didFinishLaunching', async () => {
      await this.loadStoredCredentials();
      await this.initialize();
    });
  }
  
  // input validation
  
  validatePollInterval(value) {
    // Convert to integer, handling strings and other types
    const interval = parseInt(value);
    
    // If NaN or invalid, use default
    if (isNaN(interval)) {
      if (value !== undefined && value !== null) {
        this.log.warn(`Invalid pollInterval "${value}", using default 30 seconds`);
      }
      return 30 * 1000;
    }
    
    // Enforce min 30 seconds
    if (interval < 30) {
      this.log.warn(`pollInterval ${interval} is too low, enforcing minimum of 30 seconds`);
      return 30 * 1000;
    }
    
    // Enforce max 300 seconds (5 minutes)
    if (interval > 300) {
      this.log.warn(`pollInterval ${interval} is too high, enforcing maximum of 300 seconds`);
      return 300 * 1000;
    }
    
    return interval * 1000;
  }
  
  validateEmail(email) {
    if (!email) {
      return undefined;
    }
    
    // Basic email validation: has @ and . in the right places
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (!emailRegex.test(email)) {
      this.log.error(`Invalid email format: "${email}"`);
      return undefined;
    }
    
    return email;
  }
  
  validateCountryCode(code) {
    if (!code) {
      return 'US';
    }
    
    // Omlet's own sign-in form uses GB for the United Kingdom. Older configs of
    // ours used UK, which is not a code Omlet issues - translate rather than reject.
    if (code === 'UK') {
      return 'GB';
    }
    
    // Must be exactly 2 uppercase letters
    const codeRegex = /^[A-Z]{2}$/;
    
    if (!codeRegex.test(code)) {
      this.log.warn(`Invalid country code "${code}", using default "US"`);
      return 'US';
    }
    
    return code;
  }
  
  validateToken(token, fieldName = 'token') {
    if (!token) {
      return undefined;
    }
    
    // A developer console key and a login-issued token are the same credential and
    // go in the same field. Console keys are not strictly alphanumeric - Omlet's own
    // published examples contain underscores - so allow underscore and hyphen too.
    const tokenRegex = /^[A-Za-z0-9_\-]{1,128}$/;
    
    if (!tokenRegex.test(token)) {
      this.log.error(`Invalid ${fieldName}: must be 1-128 characters, letters, digits, underscore or hyphen`);
      return undefined;
    }
    
    return token;
  }
  
  normalizeTriState(value, fieldName) {
    if (value === undefined || value === null || value === '' || value === 'auto') {
      return 'auto';
    }
    
    if (value === true || value === 'true' || value === 'on' || value === 'yes') {
      return true;
    }
    
    if (value === false || value === 'false' || value === 'off' || value === 'no') {
      return false;
    }
    
    this.log.warn(`Invalid ${fieldName} "${value}", using "auto"`);
    return 'auto';
  }
  
  validateDeviceId(deviceId, fieldName = 'deviceId') {
    if (!deviceId) {
      return undefined;
    }
    
    // Must be alphanumeric, max 32 characters
    const deviceIdRegex = /^[a-zA-Z0-9]{1,32}$/;
    
    if (!deviceIdRegex.test(deviceId)) {
      this.log.error(`Invalid ${fieldName}: must be alphanumeric and less than 32 characters`);
      return undefined;
    }
    
    return deviceId;
  }

  validateDeviceList(value, fieldName) {
    if (value === undefined || value === null || value === '') {
      return [];
    }

    const list = Array.isArray(value) ? value : [value];

    return list
      .map(item => (typeof item === 'string' ? item.trim() : item))
      .filter(item => this.validateDeviceId(item, fieldName));
  }

  validatePercent(value, fieldName, fallback) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    const parsed = parseInt(value, 10);

    if (isNaN(parsed) || parsed < 0 || parsed > 100) {
      this.log.warn(`Invalid ${fieldName} "${value}", using ${fallback}`);
      return fallback;
    }

    return parsed;
  }

  isExcluded(deviceId) {
    return this.excludeDevices.includes(deviceId);
  }

  validateHostname(hostname) {
    if (!hostname) {
      return undefined;
    }
    
    // Basic hostname validation: letters, digits, dots, hyphens
    const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    
    if (!hostnameRegex.test(hostname)) {
      this.log.error(`Invalid API server hostname: "${hostname}"`);
      return undefined;
    }
    
    return hostname;
  }
  
  // credential storage
  
  async loadStoredCredentials() {
    try {
      if (fs.existsSync(this.storage)) {
        const data = JSON.parse(fs.readFileSync(this.storage, 'utf8'));
        
        // Set by the Disconnect button in the settings page.
        if (data.disconnected) {
          this.wasDisconnected = true;
          return;
        }
        
        // Storage holds the working credential. A token in config.json is something
        // the user handed us that we have not consumed yet, so it is tried first -
        // but it is always kept separately, so a bad one cannot lock us out of a
        // good stored credential.
        if (data.bearerToken) {
          const validToken = this.validateToken(data.bearerToken, 'stored bearerToken');
          
          if (validToken) {
            this.storedToken = validToken;
            
            if (!this.bearerToken) {
              this.bearerToken = validToken;
            }
            
            if (this.debug) {
              this.log.info('Loaded stored API token');
            }
          } else {
            this.log.warn('Stored API token is invalid, ignoring');
          }
        }
        
        // Whatever ran last time. null on a fresh install, and on any install that
        // predates this field - both mean "older than the first version to record it".
        this.previousVersion = data.lastVersion || null;
      } else {
        this.importLegacyToken();
      }
    } catch (error) {
      this.log.error('Failed to load stored credentials:', error.message);
    }
  }
  
  // First run only: reuse the key saved by the single-door Omlet Coop plugin, if
  // it is installed alongside or was until recently. It is treated exactly like a
  // stored credential - tried, and only persisted here once it has worked.
  importLegacyToken() {
    try {
      if (!fs.existsSync(this.legacyStorage)) {
        return;
      }
      
      const legacy = JSON.parse(fs.readFileSync(this.legacyStorage, 'utf8'));
      
      if (!legacy || legacy.disconnected || !legacy.bearerToken) {
        return;
      }
      
      const validToken = this.validateToken(legacy.bearerToken, 'Omlet Coop plugin API key');
      
      if (!validToken) {
        return;
      }
      
      this.storedToken = validToken;
      
      if (!this.bearerToken) {
        this.bearerToken = validToken;
      }
      
      this.log.info('Found an API key saved by the Omlet Coop plugin, using it');
    } catch (error) {
      if (this.debug) {
        this.log.warn('Could not read the Omlet Coop plugin credentials:', error.message);
      }
    }
  }
  
  async saveStoredCredentials() {
    try {
      // Merge rather than overwrite. Writing this object wholesale meant a run
      // with no usable token could erase a perfectly good stored one, leaving no
      // way back: the bad credential then became the only copy.
      let existing = {};
      
      try {
        if (fs.existsSync(this.storage)) {
          existing = JSON.parse(fs.readFileSync(this.storage, 'utf8')) || {};
        }
      } catch (error) {
        existing = {};
      }
      
      const data = Object.assign({}, existing, {
        lastVersion: PLUGIN_VERSION,
        lastUpdated: new Date().toISOString()
      });
      
      // Written by the single-device versions this was forked from. Device IDs
      // now live on each cached accessory instead.
      delete data.deviceId;
      
      // Only a credential that has actually worked may be written here.
      if (this.credentialVerified && this.bearerToken) {
        data.bearerToken = this.bearerToken;
      }
      
      if (!data.bearerToken) {
        delete data.bearerToken;
      }
      
      fs.writeFileSync(this.storage, JSON.stringify(data, null, 2));
      if (this.debug) {
        this.log.info('Saved credentials to storage');
      }
      
      return true;
    } catch (error) {
      this.log.error('Failed to save API token:', error.message);
      return false;
    }
  }
  
  // config.json is a way to hand us credentials, not a place to keep them. Once a
  // credential has actually worked and is safely in the storage directory, take it
  // out of config along with any email and password.
  //
  // Order is deliberate: storage write first, purge only if it succeeded. Purging
  // first and then failing to save would leave no working credential anywhere.
  async settleCredentials() {
    // Nothing may be persisted or purged until an API call has actually succeeded
    // with this credential. Do not latch the flag before that, or the real chance
    // to clean up later is lost.
    if (this.credentialsSettled || !this.credentialVerified) {
      return;
    }
    
    this.credentialsSettled = true;
    
    const saved = await this.saveStoredCredentials();
    
    if (!saved) {
      this.log.warn('Could not save credentials to storage, leaving config.json untouched');
      return;
    }
    
    const removed = this.updateConfigBlocks((block) => {
      let touched = false;
      
      ['password', 'email', 'bearerToken'].forEach((field) => {
        if (block[field] !== undefined) {
          delete block[field];
          touched = true;
        }
      });
      
      return touched;
    });
    
    if (removed) {
      this.password = undefined;
      this.email = undefined;
      this.log.info('Credentials moved out of config.json into Homebridge storage');
    }
  }
  
  // Removes a saved password from config.json once we hold a working token.
  // API keys and bearer tokens are deliberately left untouched - only the password
  // goes, because it is the one credential we no longer need to keep.
  // Applies a mutation to our own platform block(s) in config.json and writes it
  // back atomically. Returns true if anything changed.
  updateConfigBlocks(mutate) {
    let configPath;
    
    try {
      configPath = this.api.user.configPath();
    } catch (error) {
      return false;
    }
    
    try {
      if (!configPath || !fs.existsSync(configPath)) {
        return false;
      }
      
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      if (!Array.isArray(config.platforms)) {
        return false;
      }
      
      let changed = false;
      
      config.platforms.forEach((block) => {
        if (block && block.platform === PLATFORM_NAME && mutate(block)) {
          changed = true;
        }
      });
      
      if (!changed) {
        return false;
      }
      
      const tmpPath = configPath + '.omlet-tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 4));
      fs.renameSync(tmpPath, configPath);
      
      return true;
    } catch (error) {
      this.log.warn('Could not update config.json:', error.message);
      return false;
    }
  }
  
  // "auto" is new. Convert the old booleans once, the first time we have real device
  // data to compare against. A boolean means not yet migrated; a string means done.
  migrateTriState(status) {
    if (this.triStateMigrated) {
      return;
    }
    
    this.triStateMigrated = true;
    
    const lightWasBoolean = typeof this.rawEnableLight === 'boolean';
    const batteryWasBoolean = typeof this.rawEnableBattery === 'boolean';
    
    if (!lightWasBoolean && !batteryWasBoolean) {
      return;
    }
    
    const equipped = status?.configuration?.light?.equipped;
    const lightPresent = (equipped !== undefined && equipped !== null)
      ? Number(equipped) > 0
      : (status?.state?.light !== undefined && status?.state?.light !== null);
    
    const source = status?.state?.general?.powerSource;
    const onMains = (typeof source === 'string' && source.toLowerCase() === 'external');
    
    const next = {};
    
    if (lightWasBoolean) {
      // Only an explicit "off" on a door that HAS a light is a real decision that
      // auto would contradict. "on" was the old default, so it carries no intent.
      next.enableLight = (this.rawEnableLight === false && lightPresent) ? 'off' : 'auto';
    }
    
    if (batteryWasBoolean) {
      // Mirror image: "off" was the old default here, so only an explicit "on" on a
      // mains-powered door is a decision worth preserving.
      next.enableBattery = (this.rawEnableBattery === true && onMains) ? 'on' : 'auto';
    }
    
    const wrote = this.updateConfigBlocks((block) => {
      let touched = false;
      Object.keys(next).forEach((key) => {
        if (block[key] !== next[key]) {
          block[key] = next[key];
          touched = true;
        }
      });
      return touched;
    });
    
    Object.keys(next).forEach((key) => {
      this[key] = this.normalizeTriState(next[key], key);
    });
    
    if (wrote) {
      const parts = Object.keys(next).map(key => `${key}: ${next[key]}`);
      this.log.info(`Migrated settings to the new Auto options (${parts.join(', ')})`);
    }
  }
  
  async initialize() {
    try {
      // One credential, two ways of getting it: generated in the developer console,
      // or issued by logging in. Either way it lands in bearerToken.
      if (this.bearerToken) {
        this.log.info('Using saved API key');
        this.authMode = 'token';
        this.currentToken = this.bearerToken;
      } else if (this.email && this.password) {
        this.log.info('Logging into Omlet API');
        this.authMode = 'password';
        await this.login();
      } else {
        // An explicit disconnect should take the accessories with it. Anything
        // else - a credential that has gone missing for another reason - leaves
        // them in place, so a user does not lose their rooms and automations to a
        // transient problem.
        if (this.wasDisconnected) {
          this.removeAllAccessories();
        }
        
        this.log.error('Not configured. Open the Omlet plugin settings and log in.');
        return;
      }
      
      if (this.debug && this.previousVersion !== PLUGIN_VERSION) {
        this.log.info(`Upgraded from ${this.previousVersion || 'an earlier version'} to ${PLUGIN_VERSION}`);
      }
      
      await this.syncDevices();
      
      if (this.authFailedDiscovery) {
        return;
      }
      
      // New doors and feeders are picked up without a restart. Removals are only
      // acted on at startup - see applyDiscovery.
      this.discoveryTimer = setInterval(() => {
        this.syncDevices().catch(error => this.log.warn('Rediscovery failed:', error.message));
      }, REDISCOVERY_INTERVAL_MS);
      
    } catch (error) {
      this.log.error('Initialization failed:', error.message);
    }
  }
  
  async login() {
    try {
      const apiKey = await this.performLogin();
      
      this.currentToken = apiKey;
      this.bearerToken = apiKey; // keep in sync with stored value
      await this.saveStoredCredentials();
      
      this.log.info('Login successful');
      
      return apiKey;
      
    } catch (error) {
      if (error.statusCode === 401 || error.statusCode === 403) {
        this.log.error('Login failed. Please check credentials and try again.');
      } else {
        this.log.error('Login failed:', error.message);
      }
      
      throw error;
    }
  }
  
  performLogin() {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        emailAddress: this.email,
        password: this.password,
        cc: this.countryCode
      });
      
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: '/api/v1/login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Accept': 'application/json'
        },
        timeout: 10000
      };
      
      if (this.debug) {
        this.log.info('[Auth] POST /api/v1/login');
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (this.debug) {
            this.log.info('[Auth] Response status:', res.statusCode);
          }
          
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              if (json.apiKey) {
                if (this.debug) {
                  this.log.info('[Auth] Bearer token received (' + json.apiKey.length + ' chars)');
                }
                resolve(json.apiKey);
              } else {
                reject(new Error('No apiKey in response'));
              }
            } catch (error) {
              reject(new Error('Failed to parse login response'));
            }
          } else {
            const error = new Error(`HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            error.response = data;
            reject(error);
          }
        });
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Login request timeout'));
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.write(postData);
      req.end();
    });
  }
  
  // Fetches the device list, retrying once through handleAuthError on a rejected
  // credential. Discovery runs before any polling, so this is the first place a bad
  // credential shows up. Without the retry, a rejected key from config.json stops
  // setup dead: no devices, no polling, and therefore no chance to fall back to the
  // working credential in storage or to clean config.json up afterwards.
  async discoverWithAuthRetry() {
    try {
      return await this.discoverAllDevices();
    } catch (error) {
      if (error.statusCode === 401 || error.statusCode === 403) {
        const recovered = await this.handleAuthError();
        
        if (recovered) {
          return this.discoverAllDevices();
        }
      }
      
      throw error;
    }
  }
  
  async syncDevices() {
    if (this.syncing) {
      return this.syncing;
    }
    
    this.syncing = this.runSync().finally(() => {
      this.syncing = null;
    });
    
    return this.syncing;
  }
  
  async runSync() {
    if (this.authFailedPermanently) {
      return;
    }
    
    let devices;
    
    try {
      if (!this.initialSyncDone) {
        this.log.info('Discovering devices on your account...');
      }
      
      devices = await this.discoverWithAuthRetry();
      this.credentialVerified = true;
      this.authFailedDiscovery = false;
    } catch (error) {
      // Point at the actual cause. "Check your coop is connected" sends someone to
      // the wrong place entirely when the real problem is a rejected credential.
      if (error.statusCode === 401 || error.statusCode === 403) {
        this.authFailedDiscovery = true;
        this.log.error('Could not sign in to Omlet. Open the plugin settings and log in again.');
        return;
      }
      
      this.log.error('Device discovery failed:', error.message);
      
      // Omlet being unreachable at startup must not leave working accessories
      // dead until the next restart. Bring back what we had last time, and keep
      // trying discovery until it succeeds.
      if (!this.initialSyncDone) {
        this.startCachedAccessories();
        
        if (!this.discoveryRetryTimer) {
          this.discoveryRetryTimer = setTimeout(() => {
            this.discoveryRetryTimer = null;
            this.syncDevices();
          }, DISCOVERY_RETRY_MS);
        }
      }
      
      return;
    }
    
    // Discovery succeeding is proof the credential works, so clean config.json now
    // rather than after the first poll - the settings UI cannot reliably delete a
    // key, so this is the mechanism users actually depend on.
    await this.settleCredentials();
    
    this.applyDiscovery(devices);
  }
  
  accessoryUuid(deviceId) {
    return this.api.hap.uuid.generate('omlet-multi-' + deviceId);
  }
  
  // A swapped-in device leaves its accessory holding another device's UUID. If
  // that device later reappears, its natural UUID is taken, and Homebridge refuses
  // two accessories with the same UUID - so pick the next free one.
  freeUuid(deviceId) {
    const taken = new Set(this.accessories.map(accessory => accessory.UUID));
    let uuid = this.accessoryUuid(deviceId);
    
    for (let n = 2; taken.has(uuid); n++) {
      uuid = this.api.hap.uuid.generate(`omlet-multi-${deviceId}-${n}`);
    }
    
    return uuid;
  }
  
  handlerForAccessory(accessory) {
    for (const handler of this.handlers.values()) {
      if (handler.accessory === accessory) {
        return handler;
      }
    }
    return null;
  }
  
  startHandler(accessory, device) {
    const delay = this.handlers.size * POLL_STAGGER_MS;
    const Handler = (device.kind === KIND_FEEDER) ? FeederAccessory : AutodoorAccessory;
    const handler = new Handler(this, accessory, device, delay);
    this.handlers.set(device.deviceId, handler);
    return handler;
  }
  
  // Only used when discovery fails at startup. Everything needed to poll a device
  // was recorded on its accessory the last time it was set up.
  startCachedAccessories() {
    this.accessories.forEach((accessory) => {
      const context = accessory.context || {};
      
      if (!context.deviceId || !context.kind || this.handlerForAccessory(accessory)) {
        return;
      }
      
      if (this.isExcluded(context.deviceId)) {
        return;
      }
      
      this.startHandler(accessory, {
        deviceId: context.deviceId,
        name: context.name || accessory.displayName,
        kind: context.kind
      });
    });
    
    if (this.handlers.size > 0) {
      this.log.info(`Started ${this.handlers.size} device(s) from cache until Omlet can be reached`);
    }
  }
  
  // Works out which HomeKit accessory belongs to which Omlet device.
  //
  // Additions happen on every discovery. Removals, and re-pointing an accessory at
  // replacement hardware, only happen on the first successful discovery after a
  // restart: an accessory that disappears mid-run is far more likely to be a blip
  // than a device genuinely removed, and removing one destroys the user's room,
  // name, automations and scenes along with it.
  applyDiscovery(devices) {
    const allowRemoval = !this.initialSyncDone;
    this.initialSyncDone = true;
    
    const onAccount = new Set(devices.map(device => device.deviceId));
    const wanted = [];
    
    devices.forEach((device) => {
      const kind = deviceKind(device);
      
      if (!kind) {
        if (!this.reportedUnsupported.has(device.deviceId)) {
          this.reportedUnsupported.add(device.deviceId);
          this.log.info(`Skipping "${device.name}" (${device.deviceId}): ${device.type || 'unknown'} devices are not supported yet`);
        }
        return;
      }
      
      if (this.isExcluded(device.deviceId)) {
        if (!this.reportedExcluded.has(device.deviceId)) {
          this.reportedExcluded.add(device.deviceId);
          this.log.info(`Skipping "${device.name}" (${device.deviceId}): excluded in settings`);
        }
        return;
      }
      
      wanted.push(Object.assign({}, device, { kind: kind }));
    });
    
    // Devices we are already running need nothing more than a name refresh.
    wanted.forEach((device) => {
      const handler = this.handlers.get(device.deviceId);
      if (handler) {
        handler.noteDiscovered(device);
      }
    });
    
    const idle = this.accessories.filter(accessory => !this.handlerForAccessory(accessory));
    const fresh = [];
    
    wanted.filter(device => !this.handlers.has(device.deviceId)).forEach((device) => {
      // The recorded device ID is what counts. The UUID only identifies an
      // accessory that has never recorded one: after a swap, an accessory keeps the
      // UUID of the device it was created for, and matching on that would hand it
      // back to the old device if its ID ever reappeared.
      const uuid = this.accessoryUuid(device.deviceId);
      let index = idle.findIndex(accessory => accessory.context && accessory.context.deviceId === device.deviceId);
      
      if (index < 0) {
        index = idle.findIndex(accessory => !(accessory.context && accessory.context.deviceId) && accessory.UUID === uuid);
      }
      
      if (index >= 0) {
        const accessory = idle.splice(index, 1)[0];
        this.startHandler(accessory, device);
        return;
      }
      
      fresh.push(device);
    });
    
    if (allowRemoval) {
      const wantedIds = new Set(wanted.map(device => device.deviceId));
      
      const orphans = idle.map(accessory => ({
        accessory: accessory,
        handler: null,
        deviceId: accessory.context && accessory.context.deviceId,
        kind: accessory.context && accessory.context.kind
      }));
      
      this.handlers.forEach((handler) => {
        if (!wantedIds.has(handler.deviceId)) {
          orphans.push({ accessory: handler.accessory, handler: handler, deviceId: handler.deviceId, kind: handler.kind });
        }
      });
      
      // A replaced door or feeder comes back with a new device ID. When exactly one
      // device of a kind has gone and exactly one new one of that kind has arrived,
      // that is a swap: keep the HomeKit accessory and point it at the new device.
      // With more than one of either, guessing could hand one coop's automations to
      // another, so it is left alone.
      [KIND_AUTODOOR, KIND_FEEDER].forEach((kind) => {
        const gone = orphans.filter(orphan => orphan.kind === kind && !onAccount.has(orphan.deviceId));
        const arrived = fresh.filter(device => device.kind === kind);
        
        if (gone.length !== 1 || arrived.length !== 1) {
          return;
        }
        
        const orphan = gone[0];
        const device = arrived[0];
        
        this.log.info(`"${orphan.accessory.displayName}" has been replaced by "${device.name}" (${device.deviceId}); keeping the existing HomeKit accessory`);
        
        if (orphan.handler) {
          orphan.handler.retarget(device);
        } else {
          this.startHandler(orphan.accessory, device);
        }
        
        orphans.splice(orphans.indexOf(orphan), 1);
        fresh.splice(fresh.indexOf(device), 1);
      });
      
      const removals = orphans.map((orphan) => {
        const reason = (orphan.deviceId && this.isExcluded(orphan.deviceId))
          ? 'excluded in settings'
          : 'no longer on this Omlet account';
        this.log.warn(`Removing "${orphan.accessory.displayName}" from HomeKit: ${reason}`);
        
        if (orphan.handler) {
          orphan.handler.stop();
          this.handlers.delete(orphan.handler.deviceId);
        }
        
        return orphan.accessory;
      });
      
      if (removals.length > 0) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, removals);
        this.accessories = this.accessories.filter(accessory => !removals.includes(accessory));
      }
    }
    
    fresh.forEach((device) => {
      this.log.info(`Adding new accessory: ${device.name} (${device.kind === KIND_FEEDER ? 'feeder' : 'coop door'})`);
      
      const category = (device.kind === KIND_FEEDER)
        ? this.api.hap.Categories.SENSOR
        : this.api.hap.Categories.GARAGE_DOOR_OPENER;
      const accessory = new this.api.platformAccessory(device.name, this.freeUuid(device.deviceId), category);
      
      this.startHandler(accessory, device);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    });
    
    if (this.handlers.size === 0 && allowRemoval) {
      this.log.warn('No coop doors or feeders found on your account. Check they appear in the Omlet app.');
    }
  }
  
  // A device's own poll got a 404. Either it was replaced (new device ID) or it
  // has been removed from the account. Queued, so two devices going missing at once
  // cannot both claim the same replacement.
  handleDeviceMissing(handler) {
    const check = this.missingQueue.then(() => this.resolveMissing(handler));
    this.missingQueue = check.catch(() => {});
    return check;
  }
  
  async resolveMissing(handler) {
    let devices;
    
    try {
      devices = await this.discoverWithAuthRetry();
    } catch (error) {
      handler.log.error('Could not check the account for this device:', error.message);
      return false;
    }
    
    // Present after all - the 404 was transient.
    if (devices.some(device => device.deviceId === handler.deviceId)) {
      return true;
    }
    
    const onAccount = new Set(devices.map(device => device.deviceId));
    const candidates = devices.filter(device =>
      deviceKind(device) === handler.kind
      && !this.handlers.has(device.deviceId)
      && !this.isExcluded(device.deviceId));
    
    // The same rule as at startup: only a clean one-gone, one-new swap is adopted.
    // With two doors missing, whichever polled first would otherwise take the new
    // one, and with it the other coop's automations.
    let missing = 0;
    this.handlers.forEach((other) => {
      if (other.kind === handler.kind && !onAccount.has(other.deviceId)) {
        missing++;
      }
    });
    
    if (missing > 1) {
      handler.log.error(`Device ID ${handler.deviceId} no longer exists, and neither do ${missing - 1} other device(s) of the same kind. Restart Homebridge to sort out which is which.`);
      return false;
    }
    
    if (candidates.length === 1) {
      const device = Object.assign({}, candidates[0], { kind: handler.kind });
      handler.log.info(`Device ID ${handler.deviceId} no longer exists; now using "${device.name}" (${device.deviceId})`);
      handler.retarget(device);
      return true;
    }
    
    if (candidates.length > 1) {
      handler.log.error(`Device ID ${handler.deviceId} no longer exists, and there is more than one new device it could be. Restart Homebridge to sort out which is which.`);
    } else {
      handler.log.error(`Device ID ${handler.deviceId} no longer exists on this account. Check the Omlet app; it will be removed from HomeKit at the next restart if it is still missing.`);
    }
    
    return false;
  }
  
  rekeyHandler(handler, oldDeviceId) {
    if (this.handlers.get(oldDeviceId) === handler) {
      this.handlers.delete(oldDeviceId);
    }
    this.handlers.set(handler.deviceId, handler);
  }
  
  discoverAllDevices() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: '/api/v1/group',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.currentToken}`,
          'Accept': 'application/json'
        },
        timeout: 10000
      };
      
      if (this.debug) {
        this.log.info('[Discovery] GET /api/v1/group');
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (this.debug) {
            this.log.info('[Discovery] Response status:', res.statusCode);
          }
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              const devices = [];
              
              // The API returns an array of groups directly
              const groups = Array.isArray(json) ? json : (json.groups || []);
              
              const seen = new Set();
              
              groups.forEach(group => {
                if (group.devices && Array.isArray(group.devices)) {
                  group.devices.forEach(device => {
                    // A device shared into more than one group is listed in each.
                    if (!device.deviceId || seen.has(device.deviceId)) {
                      return;
                    }
                    seen.add(device.deviceId);
                    
                    devices.push({
                      deviceId: device.deviceId,
                      name: device.name || 'Omlet Device',
                      type: device.deviceType || 'unknown',
                      hasDoor: !!(device.state && device.state.door),
                      hasFeeder: !!(device.state && device.state.feeder)
                    });
                  });
                }
              });
              
              if (this.debug) {
                this.log.info('[Discovery] Found', devices.length, 'device(s):', devices.map(d => `${d.name} (${d.deviceId})`).join(', '));
              }
              
              resolve(devices);
            } catch (error) {
              reject(new Error('Failed to parse device list'));
            }
          } else {
            const error = new Error(`HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            reject(error);
          }
        });
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.end();
    });
  }
  
  async handleAuthError() {
    // Already latched - report it to the caller instead of throwing. Every caller
    // reaches this from inside its own catch block, so a throw here escapes that
    // handler entirely rather than falling through to the error handling below it.
    if (this.authFailedPermanently) {
      return false;
    }

    // A credential from config.json that does not work must never block a working
    // one in storage - otherwise a typo'd key jams the plugin permanently, because
    // config is only cleaned up after a successful poll.
    if (this.storedToken && this.currentToken !== this.storedToken) {
      this.log.warn('The API key in config.json was rejected; falling back to the saved credential');
      this.bearerToken = this.storedToken;
      this.currentToken = this.storedToken;
      this.authFailures = 0;
      return true;
    }
    
    // No password is persisted, so a dead key cannot be refreshed automatically.
    // It may have been revoked in the developer console, or the login session behind
    // it may have ended - the plugin cannot tell which, so cover both. A couple of
    // failures could still be a server blip, so give it a few tries before giving up.
    if (!this.email || !this.password) {
      this.authFailures++;
      
      if (this.authFailures < this.maxReloginAttempts) {
        if (this.debug) {
          this.log.warn(`Authentication failed (${this.authFailures}/${this.maxReloginAttempts}), will retry`);
        }
        return false;
      }
      
      this.log.error('Saved API key is no longer valid. Open the Omlet plugin settings and log in again, or paste a new developer API key.');
      this.authFailedPermanently = true;
      return false;
    }
    
    this.reloginAttempts++;
    this.log.warn(`Authentication error detected, attempting to re-login (attempt ${this.reloginAttempts}/${this.maxReloginAttempts})...`);
    
    try {
      await this.login();
      this.log.info('Re-login successful');
      
      // Reset counter on success
      this.reloginAttempts = 0;
      
      return true;
    } catch (error) {
      this.log.error('Failed to re-login:', error.message);
      
      if (this.reloginAttempts >= this.maxReloginAttempts) {
        this.log.error(`Re-login failed ${this.maxReloginAttempts} times. Accessory will show "No Response" until Homebridge is restarted with valid credentials.`);
        this.authFailedPermanently = true;
      } else {
        this.log.warn(`Will retry on next operation (${this.maxReloginAttempts - this.reloginAttempts} attempts remaining)`);
      }
      
      return false;
    }
  }
  
  removeAllAccessories() {
    this.handlers.forEach(handler => handler.stop());
    this.handlers.clear();
    
    if (this.accessories.length > 0) {
      this.log.info(`Disconnected: removing ${this.accessories.length} accessory(s) from HomeKit`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.accessories);
      this.accessories = [];
    }
    
    // Clear the marker so this happens once.
    try {
      if (fs.existsSync(this.storage)) {
        fs.unlinkSync(this.storage);
      }
    } catch (error) {
      this.log.warn('Could not clear the disconnect marker:', error.message);
    }
    
    this.wasDisconnected = false;
  }
  
  configureAccessory(accessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }
  
  getCurrentToken() {
    return this.currentToken;
  }
}

// What every Omlet device has in common: an accessory, a device ID, one polling
// chain, and the HTTP plumbing to read its status.
class OmletDevice {
  constructor(platform, accessory, device, kind, model) {
    this.platform = platform;
    this.accessory = accessory;
    this.kind = kind;
    this.deviceId = device.deviceId;
    this.name = device.name || accessory.displayName;
    this.log = prefixedLog(platform.log, this.name);
    
    this.baseUrl = platform.baseUrl;
    this.pollInterval = platform.pollInterval;
    this.debug = platform.debug;
    
    this.accessoryInfoUpdated = false;
    this.cachedStatus = null;
    this.pollTimer = null;
    this.pollGeneration = 0;
    this.pendingServiceChange = {};
    this.firstReconcileDone = false;
    this.pollingHalted = false;
    this.consecutiveFailures = 0;
    this.batteryOverrideRefused = false;
    this.lastMissingCheck = null;
    this.stopped = false;
    
    // Recorded on the accessory so it can be matched to its device on the next
    // start, and polled from cache if Omlet cannot be reached then.
    this.accessory.context.deviceId = this.deviceId;
    this.accessory.context.kind = kind;
    this.accessory.context.name = this.name;
    
    // serial and firmware get updated after the first successful poll
    this.accessory.getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Omlet')
      .setCharacteristic(hap.Characteristic.Model, model)
      .setCharacteristic(hap.Characteristic.SerialNumber, this.deviceId)
      .setCharacteristic(hap.Characteristic.FirmwareRevision, '0.0.0');
  }
  
  // Discovery saw this device again. The Omlet name is recorded, but services are
  // not renamed: the user may have renamed them in the Home app.
  noteDiscovered(device) {
    if (device.name && device.name !== this.accessory.context.name) {
      this.accessory.context.name = device.name;
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }
  }
  
  // Replacement hardware: same HomeKit accessory, new Omlet device ID. The UUID
  // becomes historical, which costs nothing; the context is what matching uses.
  retarget(device) {
    const oldDeviceId = this.deviceId;
    
    this.deviceId = device.deviceId;
    this.accessory.context.deviceId = device.deviceId;
    this.accessory.context.name = device.name || this.accessory.context.name;
    this.accessoryInfoUpdated = false;
    this.cachedStatus = null;
    this.lastMissingCheck = null;
    
    this.platform.rekeyHandler(this, oldDeviceId);
    this.platform.api.updatePlatformAccessories([this.accessory]);
    this.scheduleNextPoll(0);
  }
  
  stop() {
    this.stopped = true;
    this.stopPolling();
  }
  
  startPolling(delayMs = 0) {
    this.log.info(`Polling every ${this.pollInterval / 1000}s`);
    this.scheduleNextPoll(delayMs);
  }
  
  updateAccessoryInfo(status) {
    if (this.accessoryInfoUpdated) {
      return;
    }
    
    const deviceSerial = status.deviceSerial || this.deviceId;
    const firmware = status.state?.general?.firmwareVersionCurrent || '0.0.0';
    this.accessory.getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.SerialNumber, deviceSerial)
      .setCharacteristic(hap.Characteristic.FirmwareRevision, firmware);
    if (this.debug) {
      this.log.info('[Info] Updated accessory info: Serial=' + deviceSerial + ', Firmware=' + firmware);
    }
    this.accessoryInfoUpdated = true;
  }
  
  // Everything that must happen after a poll succeeds, whatever route got us
  // there. Keeping this in one place matters: the retry-after-recovery paths used
  // to skip it, so a credential that only worked on the second attempt never got
  // marked as verified and config.json was never cleaned up.
  async handlePollSuccess(status) {
    this.noteRequestSuccess();
    this.cachedStatus = status;
    this.lastMissingCheck = null;
    this.platform.authFailures = 0;
    this.platform.credentialVerified = true;
    
    await this.platform.settleCredentials();
    this.updateAccessoryInfo(status);
    
    return status;
  }
  
  async pollDeviceState() {
    try {
      return await this.handlePollSuccess(await this.getDeviceStatus('Poll'));
    } catch (error) {
      // A saved device ID can outlive the device: replacing a coop door issues a
      // new ID, and every request then 404s against one that no longer exists.
      // The platform decides what it has become, and not on every single poll.
      if (error.statusCode === 404) {
        const now = Date.now();
        
        if (!this.lastMissingCheck || now - this.lastMissingCheck >= MISSING_RECHECK_MS) {
          this.lastMissingCheck = now;
          this.log.warn(`[Device] Device ID ${this.deviceId} was not found, checking the account`);
          
          const found = await this.platform.handleDeviceMissing(this);
          
          if (found) {
            return this.handlePollSuccess(await this.getDeviceStatus('Poll'));
          }
        }
        
        throw error;
      }
      
      if (error.statusCode === 401 || error.statusCode === 403) {
        const refreshed = await this.platform.handleAuthError();
        
        if (refreshed) {
          try {
            return await this.handlePollSuccess(await this.getDeviceStatus('Poll'));
          } catch (retryError) {
            this.log.error('[Poll] Retry after token refresh failed:', retryError.message);
            throw retryError;
          }
        }
      }
      
      if (this.debug) {
        this.log.warn('[Poll] Failed to get device status:', error.message);
      }
      
      throw error;
    }
  }
  
  pushBatteryToHomeKit(status) {
    if (!this.batteryService) {
      return;
    }
    
    const batteryLevel = status.state?.general?.batteryLevel;
    if (batteryLevel !== undefined && batteryLevel !== null) {
      this.batteryService.getCharacteristic(hap.Characteristic.BatteryLevel).updateValue(batteryLevel);
      const isLow = (batteryLevel < 20) ? 1 : 0;
      this.batteryService.getCharacteristic(hap.Characteristic.StatusLowBattery).updateValue(isLow);
      if (this.debug) {
        this.log.info('[Poll] Battery:', batteryLevel + '%, low:', isLow);
      }
    }
  }
  
  // Nothing will change until someone fixes the credentials, so stop asking.
  haltIfAuthDead() {
    if (!this.platform.authFailedPermanently) {
      return false;
    }
    
    if (!this.pollingHalted) {
      this.pollingHalted = true;
      this.log.error('[Poll] Polling stopped. Update your credentials in the plugin settings, then restart Homebridge.');
    }
    this.stopPolling();
    return true;
  }
  
  // One line per failure while something is clearly wrong, then silence until it
  // recovers - and one line to say it did.
  noteRequestFailure(context, message) {
    this.consecutiveFailures++;
    
    if (this.consecutiveFailures < MAX_LOGGED_FAILURES) {
      this.log.error(`[${context}] ${message}`);
      return;
    }
    
    if (this.consecutiveFailures === MAX_LOGGED_FAILURES) {
      this.log.error(`[${context}] ${message}`);
      this.log.warn(`[${context}] Further connection errors will be logged only in debug mode until the connection recovers.`);
      return;
    }
    
    if (this.debug) {
      this.log.warn(`[${context}] ${message}`);
    }
  }
  
  noteRequestSuccess() {
    if (this.consecutiveFailures === 0) {
      return;
    }
    
    if (this.consecutiveFailures >= MAX_LOGGED_FAILURES) {
      this.log.info(`Connection to Omlet recovered after ${this.consecutiveFailures} failed attempts`);
    }
    
    this.consecutiveFailures = 0;
  }
  
  describePref(pref) {
    return pref === 'auto' ? 'auto' : (pref ? 'on' : 'off');
  }
  
  hasBatteryService() {
    return !!this.accessory.getService(hap.Service.Battery);
  }
  
  applyBatteryService(enabled) {
    const existing = this.accessory.getService(hap.Service.Battery);
    
    if (!enabled) {
      if (existing) {
        this.primaryService.removeLinkedService(existing);
        this.accessory.removeService(existing);
      }
      this.batteryService = null;
      return;
    }
    
    const service = existing || this.accessory.addService(hap.Service.Battery);
    service.setCharacteristic(hap.Characteristic.Name, `${this.name} Battery`);
    service
      .getCharacteristic(hap.Characteristic.BatteryLevel)
      .onGet(this.getBatteryLevel.bind(this));
    service
      .getCharacteristic(hap.Characteristic.ChargingState)
      .setValue(2); // NOT_CHARGEABLE - Omlet devices use non-rechargeable cells
    service
      .getCharacteristic(hap.Characteristic.StatusLowBattery)
      .onGet(this.getStatusLowBattery.bind(this));
    this.primaryService.addLinkedService(service);
    this.batteryService = service;
  }
  
  desiredBattery(status) {
    const count = status?.batteryCount;
    const source = status?.state?.general?.powerSource;
    const onMains = (typeof source === 'string' && source.toLowerCase() === 'external');
    
    // If the device states it is on mains with no cells fitted, there is no battery,
    // and "Always on" cannot conjure one. A 0% tile on a mains-powered device is worse
    // than no tile: it is wrong, and HomeKit will eventually warn about it.
    if (onMains && count === 0) {
      if (this.platform.enableBattery === true && !this.batteryOverrideRefused) {
        this.batteryOverrideRefused = true;
        this.log.warn('Battery Status is set to "Always on", but this device reports mains power with no batteries fitted, so no battery accessory is shown.');
      }
      return false;
    }
    
    if (this.platform.enableBattery !== 'auto') {
      return this.platform.enableBattery;
    }
    
    if (typeof count === 'number' && count > 0) {
      return true;
    }
    
    if (typeof source === 'string' && source.length > 0) {
      return !onMains;
    }
    
    return false;
  }
  
  // Require two consecutive polls to agree before adding or removing a service, so a
  // single odd reading cannot make an accessory appear and disappear in the Home app.
  reconcileService(kind, desired, has, apply) {
    if (desired === has()) {
      this.pendingServiceChange[kind] = null;
      return;
    }
    
    const pending = this.pendingServiceChange[kind];
    
    // On the very first reading there is nothing to debounce against - apply it now
    // rather than making a fresh install wait a poll cycle for its accessories.
    if (!this.firstReconcileDone) {
      this.pendingServiceChange[kind] = null;
      this.log.info(`${SERVICE_LABELS[kind] || kind} ${desired ? 'detected, adding accessory' : 'not present, no accessory added'}`);
      apply(desired);
      return;
    }
    
    if (!pending || pending.desired !== desired) {
      this.pendingServiceChange[kind] = { desired: desired, count: 1 };
      return;
    }
    
    pending.count++;
    
    if (pending.count >= 2) {
      this.pendingServiceChange[kind] = null;
      this.log.info(`${SERVICE_LABELS[kind] || kind} ${desired ? 'detected, adding accessory' : 'no longer present, removing accessory'}`);
      apply(desired);
    }
  }
  
  async getBatteryLevel() {
    const batteryLevel = this.cachedStatus?.state?.general?.batteryLevel;
    
    if (batteryLevel === undefined || batteryLevel === null) {
      throw unavailable();
    }
    
    return batteryLevel;
  }
  
  async getStatusLowBattery() {
    const batteryLevel = this.cachedStatus?.state?.general?.batteryLevel;
    
    if (batteryLevel === undefined || batteryLevel === null) {
      throw unavailable();
    }
    
    return (batteryLevel < 20) ? 1 : 0;
  }
  
  getDeviceStatus(context = 'Status') {
    return new Promise((resolve, reject) => {
      const token = this.platform.getCurrentToken();
      
      if (!token) {
        reject(new Error('No auth token available'));
        return;
      }
      
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: `/api/v1/device/${this.deviceId}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        },
        timeout: 10000
      };
      
      if (this.debug) {
        this.log.info(`[${context}] GET`, options.path);
      }

      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (this.debug) {
            this.log.info(`[${context}] Response status:`, res.statusCode);
          }
          
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              if (this.debug) {
                this.log.info(`[${context}] Full response:`, JSON.stringify(json, null, 2));
              }
              resolve(json);
            } catch (error) {
              this.log.error(`[${context}] Failed to parse JSON:`, error.message);
              this.log.error(`[${context}] Response was:`, data);
              reject(new Error('Failed to parse JSON response'));
            }
          } else {
            const isAuthError = (res.statusCode === 401 || res.statusCode === 403);
            
            // Auth failures are reported once, in context, by handleAuthError -
            // repeating the same 401 every cycle is noise. Everything else is a
            // real problem and must not be swallowed.
            if (this.debug || !isAuthError) {
              this.log.error(`[${context}] HTTP Error`, res.statusCode, data || '');
            }
            const error = new Error(`HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            error.response = data;
            reject(error);
          }
        });
      });
      
      let timedOut = false;
      
      req.on('timeout', () => {
        timedOut = true;
        req.destroy();
        this.noteRequestFailure(context, 'Request timeout after 10 seconds');
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        // destroy() from the timeout above also emits 'error'. Reporting both turned
        // a single failed request into two error lines.
        if (timedOut) {
          return;
        }
        
        this.noteRequestFailure(context, `Network error: ${error.message}`);
        reject(error);
      });
      
      req.end();
    });
  }
  
  // door
  
  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // A single self-rescheduling timer rather than a fixed interval, for two reasons:
  // a slow cycle (timeout -> re-login -> retry) can outlast the interval and stack
  // overlapping polls, and a separate transition watcher would double up on requests
  // against a backend that only refreshes every ~600s anyway.
  //
  // The generation counter is what makes it safe: if something reschedules while a
  // poll is already in flight, that poll finds its generation stale and declines to
  // schedule a successor, so exactly one chain survives.
  scheduleNextPoll(delayMs) {
    if (this.stopped) {
      return;
    }
    
    this.pollGeneration++;
    
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    
    const generation = this.pollGeneration;
    this.pollTimer = setTimeout(() => this.runPoll(generation), delayMs);
  }
}

// A coop door, with the light and battery as linked services
class AutodoorAccessory extends OmletDevice {
  constructor(platform, accessory, device, startDelay = 0) {
    super(platform, accessory, device, KIND_AUTODOOR, 'Smart Autodoor');
    
    this.fastPollCount = 0;
    this.pendingServiceChange = { light: null, battery: null };
    this.lastFault = null;
    this.recoveryAttempted = { door: false, light: false };
    this.intents = { door: null, light: null };
    this.reapply = { door: null, light: null };
    
    this.doorService = this.accessory.getService(hap.Service.GarageDoorOpener) 
      || this.accessory.addService(hap.Service.GarageDoorOpener);
    this.primaryService = this.doorService;
    
    this.doorService.setCharacteristic(hap.Characteristic.Name, this.name);
    this.doorService.setPrimaryService(true);
    
    this.doorService
      .getCharacteristic(hap.Characteristic.CurrentDoorState)
      .onGet(this.getCurrentDoorState.bind(this));
    
    this.doorService
      .getCharacteristic(hap.Characteristic.TargetDoorState)
      .onGet(this.getTargetDoorState.bind(this))
      .onSet(this.setTargetDoorState.bind(this));
    
    this.doorService
      .getCharacteristic(hap.Characteristic.ObstructionDetected)
      .onGet(this.getObstructionDetected.bind(this));
    
    // An explicit true/false is applied immediately. Under "auto" we keep whatever
    // the cached accessory already had and let the first poll decide, so the service
    // does not flicker away and back on every restart.
    this.applyLightService(platform.enableLight === 'auto' ? this.hasLightService() : platform.enableLight);
    this.applyBatteryService(platform.enableBattery === 'auto' ? this.hasBatteryService() : platform.enableBattery);
    
    this.log.info(`Coop door initialized (light: ${this.describePref(platform.enableLight)}, battery: ${this.describePref(platform.enableBattery)})`);
    
    this.startPolling(startDelay);
  }
  
  // Read-only status: HomeKit cannot use this to block the door control, and we
  // would not want it to. It self-clears - the fault drops back to "none" within a
  // few seconds of the next close attempt, including the door's own dusk close.
  getObstructionDetected() {
    return this.cachedStatus?.state?.door?.fault === DOOR_FAULT_BLOCKED;
  }
  
  // Faults we do not recognise are surfaced once each, rather than silently ignored
  // or wrongly reported as an obstruction.
  noteDoorFault(fault) {
    if (!fault || fault === DOOR_FAULT_NONE) {
      this.lastFault = fault;
      return;
    }
    
    if (fault === this.lastFault) {
      return;
    }
    
    this.lastFault = fault;
    
    if (fault === DOOR_FAULT_BLOCKED) {
      this.log.warn('[Door] Door reported blocked - something is in the doorway. It will clear on the next close attempt.');
      return;
    }
    
    this.log.warn(`[Door] Door reported an unrecognised fault: "${fault}". Please report this at https://github.com/stevendark-TSD/homebridge-omlet-multi/issues`);
  }
  
  // After a command, HomeKit immediately re-reads the characteristic. The getters
  // read the cache, and the cache still holds the pre-command state until the next
  // poll - so the control visibly snaps back before correcting itself seconds later.
  // Record the expected pending state so reads agree with what was just asked for.
  setCachedState(section, value) {
    if (!this.cachedStatus || !this.cachedStatus.state || !this.cachedStatus.state[section]) {
      return;
    }
    
    // A null clears it, so the next poll's real value is used rather than a guess.
    if (value === null) {
      delete this.cachedStatus.state[section].state;
      return;
    }
    
    this.cachedStatus.state[section].state = value;
  }
  
  hasLightService() {
    return !!this.accessory.getService(hap.Service.Lightbulb);
  }
  
  applyLightService(enabled) {
    const existing = this.accessory.getService(hap.Service.Lightbulb);
    
    if (!enabled) {
      if (existing) {
        this.doorService.removeLinkedService(existing);
        this.accessory.removeService(existing);
      }
      this.lightService = null;
      return;
    }
    
    const service = existing || this.accessory.addService(hap.Service.Lightbulb);
    service.setCharacteristic(hap.Characteristic.Name, `${this.name} Light`);
    service
      .getCharacteristic(hap.Characteristic.On)
      .onGet(this.getLightOn.bind(this))
      .onSet(this.setLightOn.bind(this));
    this.doorService.addLinkedService(service);
    this.lightService = service;
  }
  
  // Under "auto" the hardware decides, and it is re-evaluated on every poll rather
  // than latched at discovery. Moving a coop from mains to batteries, or fitting a
  // light module, is picked up without anyone touching the config.
  desiredLight(status) {
    if (this.platform.enableLight !== 'auto') {
      return this.platform.enableLight;
    }
    
    const equipped = status?.configuration?.light?.equipped;
    if (equipped !== undefined && equipped !== null) {
      return Number(equipped) > 0;
    }
    
    const lightState = status?.state?.light;
    return lightState !== undefined && lightState !== null;
  }
  
  reconcileServices(status) {
    const before = `${this.hasLightService()}|${this.hasBatteryService()}`;
    
    this.reconcileService('light', this.desiredLight(status),
      () => this.hasLightService(), (v) => this.applyLightService(v));
    this.reconcileService('battery', this.desiredBattery(status),
      () => this.hasBatteryService(), (v) => this.applyBatteryService(v));
    
    this.firstReconcileDone = true;
    
    if (before !== `${this.hasLightService()}|${this.hasBatteryService()}`) {
      // Without this the added or removed service is not published, and the tile
      // only appears (or disappears) after the next Homebridge restart.
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }
  }
  
  // light
  
  async getLightOn() {
    const lightState = this.cachedStatus?.state?.light?.state;
    
    if (!lightState) {
      throw unavailable();
    }
    
    return (lightState === 'on' || lightState === 'onpending');
  }
  
  // A command the coop cannot service is accepted by the API - the state flips to
  // "*pending" - and then dropped by the device. The pending state does not resolve;
  // Omlet's own service can take an hour to clear it.
  //
  // The fix is the OPPOSITE command, never a retry. A dropped "on" means the light
  // never came on, so "off" makes the reported state true again, and clears the jam
  // in about three seconds. Re-sending the same command would itself be a redundant
  // command, which is the thing that causes this in the first place.
  async recoverStuck(kind) {
    const spec = STUCK_RECOVERY[kind];
    const state = this.cachedStatus?.state?.[spec.section]?.state;
    
    if (!spec.stuckStates.includes(state)) {
      this.recoveryAttempted[kind] = false;
      return false;
    }
    
    // One attempt per stuck episode - never a loop.
    if (this.recoveryAttempted[kind]) {
      return false;
    }
    
    this.recoveryAttempted[kind] = true;
    
    const action = spec.oppositeOf(state);
    const original = spec.intentOf(state);
    const intent = this.intents[kind];
    
    // Only re-apply our own command, and only once. Re-applying a pending state we
    // did not cause would act on somebody else's intention.
    const shouldReapply = intent && intent.action === original && !intent.reapplied;
    
    this.log.warn(`[${spec.label}] ${spec.label} stuck in ${state} state, forcing a ${kind} ${action} command to resolve`);
    
    try {
      await this.sendAction(action, spec.label);
      
      if (shouldReapply) {
        intent.reapplied = true;
        this.reapply[kind] = original;
      }
      
      this.setCachedState(spec.section, null);
      this.scheduleNextPoll(FAST_POLL_MS);
      return true;
    } catch (error) {
      this.log.error(`[${spec.label}] Could not settle the stuck state:`, error.message);
      return false;
    }
  }
  
  // Sends the original command again once the stuck state has cleared.
  async maybeReapply(kind) {
    const spec = STUCK_RECOVERY[kind];
    
    if (!this.reapply[kind]) {
      return;
    }
    
    const state = this.cachedStatus?.state?.[spec.section]?.state;
    
    // Wait for the forced command to finish before acting again.
    if (spec.stuckStates.includes(state) || DOOR_TRANSITION_STATES.includes(state)) {
      return;
    }
    
    const action = this.reapply[kind];
    this.reapply[kind] = null;
    
    // It may already be where the user wanted it.
    if (spec.settledMatches(action, state)) {
      return;
    }
    
    this.log.info(`[${spec.label}] Re-applying ${action} now the ${kind} has unstuck`);
    
    try {
      await this.sendAction(action, spec.label);
      this.scheduleNextPoll(FAST_POLL_MS);
    } catch (error) {
      this.log.error(`[${spec.label}] Could not re-apply the command:`, error.message);
    }
  }
  
  async setLightOn(value) {
    const action = value ? 'on' : 'off';
    
    // Same guard as the door: a command putting the light into the state it is
    // already in can leave the coop stuck in "*pending". Read fresh rather than
    // trusting the cache, which can be a poll interval out of date.
    let lightState = null;
    
    try {
      const status = await this.pollDeviceState();
      lightState = status?.state?.light?.state ?? null;
    } catch (error) {
      lightState = this.cachedStatus?.state?.light?.state ?? null;
      
      if (this.debug) {
        this.log.warn(`[Light] Could not refresh state before ${action}, using last known state: ${lightState ?? 'unknown'}`);
      }
    }
    
    const alreadyThere = value
      ? LIGHT_ON_STATES.includes(lightState)
      : LIGHT_OFF_STATES.includes(lightState);
    
    if (alreadyThere) {
      this.log.info(`[Light] Light is already ${value ? 'on' : 'off'}`);
      
      if (this.lightService) {
        this.lightService.getCharacteristic(hap.Characteristic.On).updateValue(value);
      }
      
      return;
    }
    
    try {
      await this.sendAction(action, 'Light');
      this.log.info('[Light]', action === 'on' ? 'Turning on light' : 'Turning off light');
      
      this.intents.light = { action: action, reapplied: false };
      this.setCachedState('light', value ? 'onpending' : 'offpending');
      
      if (this.lightService) {
        this.lightService.getCharacteristic(hap.Characteristic.On).updateValue(value);
      }
      
      // Drop to the fast cadence so the change is reflected promptly.
      this.scheduleNextPoll(FAST_POLL_MS);
      
    } catch (error) {
      this.log.error('[Light] Failed to set light state:', error.message);
      
      if (error.statusCode === 401 || error.statusCode === 403) {
        const refreshed = await this.platform.handleAuthError();
        if (refreshed) {
          try {
            await this.sendAction(action, 'Light');
            this.log.info('[Light]', action === 'on' ? 'Turning on light' : 'Turning off light', '(after token refresh)');
            return;
          } catch (retryError) {
            this.log.error('[Light] Retry after token refresh also failed');
          }
        }
      }
      
      throw new Error('Failed to set light state');
    }
  }
  
  // battery
  
  sendAction(action, context = 'Action') {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({});
      const token = this.platform.getCurrentToken();
      
      if (!token) {
        reject(new Error('No auth token available'));
        return;
      }
      
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: `/api/v1/device/${this.deviceId}/action/${action}`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Accept': 'application/json'
        },
        timeout: 10000
      };
      
      if (this.debug) {
        this.log.info(`[${context}] POST`, options.path);
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (this.debug) {
            this.log.info(`[${context}] Response status:`, res.statusCode);
            if (data) {
              this.log.info(`[${context}] Response body:`, data);
            }
          }
          
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve();
          } else {
            this.log.error(`[${context}] HTTP Error`, res.statusCode, data || '');
            const error = new Error(`HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            error.response = data;
            reject(error);
          }
        });
      });
      
      let timedOut = false;
      
      req.on('timeout', () => {
        timedOut = true;
        req.destroy();
        this.noteRequestFailure(context, 'Request timeout after 10 seconds');
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        // destroy() from the timeout above also emits 'error'. Reporting both turned
        // a single failed request into two error lines.
        if (timedOut) {
          return;
        }
        
        this.noteRequestFailure(context, `Network error: ${error.message}`);
        reject(error);
      });
      
      req.write(postData);
      req.end();
    });
  }
  
  async getCurrentDoorState() {
    const doorState = this.cachedStatus?.state?.door?.state;
    
    if (!doorState) {
      throw unavailable();
    }
    
    return mapDoorState(doorState);
  }
  
  async getTargetDoorState() {
    const doorState = this.cachedStatus?.state?.door?.state;
    
    if (!doorState) {
      throw unavailable();
    }
    
    return DOOR_OPEN_STATES.includes(doorState)
      ? hap.Characteristic.TargetDoorState.OPEN
      : hap.Characteristic.TargetDoorState.CLOSED;
  }
  
  async setTargetDoorState(value) {
    const wantOpen = (value === hap.Characteristic.TargetDoorState.OPEN);
    const action = wantOpen ? 'open' : 'close';
    
    // Telling the Omlet API to open an already-open door (or close an already-closed
    // one) upsets the server, so never send a redundant command. A person tapping the
    // tile in the Home app cannot cause this because the tile shows the real state,
    // but a scheduled automation - "open at sunrise" - fires regardless of state and
    // hits it every single day.
    //
    // Deliberately a fresh read rather than the cache: acting on a stale cache is
    // wrong in both directions - a redundant command if it says closed when the door
    // is open, or a door that never opens if it says open when the door is shut.
    let doorState = null;
    
    try {
      const status = await this.pollDeviceState();
      doorState = status?.state?.door?.state ?? null;
    } catch (error) {
      doorState = this.cachedStatus?.state?.door?.state ?? null;
      
      if (doorState) {
        this.log.warn(`[Door] Could not refresh state before ${action}, using last known state: ${doorState}`);
      } else {
        this.log.warn(`[Door] Could not determine door state before ${action}, sending anyway`);
      }
    }
    
    const alreadyThere = wantOpen
      ? DOOR_OPEN_STATES.includes(doorState)
      : DOOR_CLOSED_STATES.includes(doorState);
    
    if (alreadyThere) {
      this.log.info(`[Door] Door is already ${wantOpen ? 'open' : 'closed'}`);
      
      // Report the real state back. From HomeKit's point of view the request
      // succeeded - the door is where it was asked to be.
      const currentState = mapDoorState(doorState);
      
      this.doorService
        .getCharacteristic(hap.Characteristic.CurrentDoorState)
        .updateValue(currentState);
      
      this.doorService
        .getCharacteristic(hap.Characteristic.TargetDoorState)
        .updateValue(value);
      
      return;
    }
    
    try {
      await this.sendAction(action, 'Door');
      this.log.info('[Door]', action === 'open' ? 'Opening door' : 'Closing door');
      
      this.intents.door = { action: action, reapplied: false };
      this.setCachedState('door', wantOpen ? 'openpending' : 'closepending');
      
      const newCurrentState = wantOpen
        ? hap.Characteristic.CurrentDoorState.OPENING
        : hap.Characteristic.CurrentDoorState.CLOSING;
      
      this.doorService
        .getCharacteristic(hap.Characteristic.CurrentDoorState)
        .updateValue(newCurrentState);
      
      // Drop to the fast cadence. The loop stays fast until the door settles, so a
      // stiff or obstructed track that takes longer than usual is still tracked.
      this.scheduleNextPoll(FAST_POLL_MS);
        
    } catch (error) {
      this.log.error('[Door] Failed to set door state:', error.message);
      
      if (error.statusCode === 401 || error.statusCode === 403) {
        const refreshed = await this.platform.handleAuthError();
        if (refreshed) {
          try {
            await this.sendAction(action, 'Door');
            this.log.info('[Door]', action === 'open' ? 'Opening door' : 'Closing door', '(after token refresh)');
            
            const newCurrentState = (action === 'open') 
              ? hap.Characteristic.CurrentDoorState.OPENING
              : hap.Characteristic.CurrentDoorState.CLOSING;
            
            this.doorService
              .getCharacteristic(hap.Characteristic.CurrentDoorState)
              .updateValue(newCurrentState);
            
            return;
          } catch (retryError) {
            this.log.error('[Door] Retry after token refresh also failed');
          }
        }
      }
      
      throw new Error('Failed to set door state');
    }
  }
  
  // polling
  
  async handlePollSuccess(status) {
    await super.handlePollSuccess(status);
    
    // The legacy light/battery booleans describe a door, so only a door's status
    // can decide how they migrate.
    this.platform.migrateTriState(status);
    this.reconcileServices(status);
    await this.maybeReapply('door');
    await this.maybeReapply('light');
    
    return status;
  }
  
  pushStateToHomeKit() {
    try {
      const status = this.cachedStatus;
      if (!status) return;

      // Door state
      const doorState = status.state?.door?.state;
      if (doorState) {
        const currentState = mapDoorState(doorState);
        this.doorService.getCharacteristic(hap.Characteristic.CurrentDoorState).updateValue(currentState);

        const targetState = DOOR_OPEN_STATES.includes(doorState)
          ? hap.Characteristic.TargetDoorState.OPEN
          : hap.Characteristic.TargetDoorState.CLOSED;
        this.doorService.getCharacteristic(hap.Characteristic.TargetDoorState).updateValue(targetState);

        if (!STUCK_RECOVERY.door.stuckStates.includes(doorState)) {
          this.recoveryAttempted.door = false;
          
          if (this.intents.door && STUCK_RECOVERY.door.settledMatches(this.intents.door.action, doorState)) {
            this.intents.door = null;
          }
        }
        
        if (this.debug) {
          this.log.info('[Poll] Door:', doorState, '-> HomeKit:', currentState);
        }
      }
      
      const fault = status.state?.door?.fault;
      if (fault !== undefined) {
        this.noteDoorFault(fault);
        this.doorService
          .getCharacteristic(hap.Characteristic.ObstructionDetected)
          .updateValue(fault === DOOR_FAULT_BLOCKED);
      }

      // Light state
      if (this.lightService) {
        const lightState = status.state?.light?.state;
        if (lightState !== undefined) {
          const isOn = (lightState === 'on' || lightState === 'onpending');
          this.lightService.getCharacteristic(hap.Characteristic.On).updateValue(isOn);
          
          if (!LIGHT_TRANSITION_STATES.includes(lightState)) {
            this.recoveryAttempted.light = false;
            
            if (this.intents.light && (this.intents.light.action === 'on') === (lightState === 'on')) {
              this.intents.light = null;
            }
          }
          if (this.debug) {
            this.log.info('[Poll] Light:', lightState, '-> isOn:', isOn);
          }
        }
      }

      this.pushBatteryToHomeKit(status);
    } catch (error) {
      this.log.error('[Poll] Failed to push state to HomeKit:', error.message);
    }
  }

  isTransitioning() {
    const doorState = this.cachedStatus?.state?.door?.state;
    const lightState = this.cachedStatus?.state?.light?.state;
    
    return DOOR_TRANSITION_STATES.includes(doorState)
      || LIGHT_TRANSITION_STATES.includes(lightState);
  }

  async runPoll(generation) {
    try {
      await this.pollDeviceState();
      this.pushStateToHomeKit();
    } catch (error) {
      if (this.debug) {
        this.log.warn('[Poll] Poll cycle failed:', error.message);
      }
    }
    
    // Superseded while we were in flight - the newer timer owns the chain now.
    if (generation !== this.pollGeneration) {
      return;
    }
    
    if (this.haltIfAuthDead()) {
      return;
    }
    
    if (this.isTransitioning()) {
      this.fastPollCount++;
      
      if (this.fastPollCount <= MAX_FAST_POLLS) {
        this.scheduleNextPoll(FAST_POLL_MS);
        return;
      }
      
      const doorState = this.cachedStatus?.state?.door?.state ?? 'unknown';
      const lightState = this.cachedStatus?.state?.light?.state ?? 'unknown';
      const stuck = [];
      
      if (DOOR_TRANSITION_STATES.includes(doorState)) {
        stuck.push(`door: ${doorState}`);
      }
      
      if (LIGHT_TRANSITION_STATES.includes(lightState)) {
        stuck.push(`light: ${lightState}`);
      }
      
      this.log.warn(`[Poll] Still mid-change after ${Math.round(MAX_FAST_POLLS * FAST_POLL_MS / 1000)}s (${stuck.join(', ') || `door: ${doorState}, light: ${lightState}`}), returning to normal polling`);
      
      // recoverStuck schedules its own fast poll to confirm the fix; falling
      // through here would immediately overwrite it with the slow one.
      const recovered = (await this.recoverStuck('door')) || (await this.recoverStuck('light'));
      
      this.fastPollCount = 0;
      
      if (recovered) {
        return;
      }
    }
    
    this.fastPollCount = 0;
    this.scheduleNextPoll(this.pollInterval);
  }
}

// A Smart Feeder. Read-only: Omlet's API offers no actions for it. HomeKit has no
// feeder service, so it is expressed with stock sensors:
//
//   Contact sensor   the feeder door - "Open" while the hens can get at the feed
//   Feed Level       a humidity sensor, the only stock service the Home app shows
//                    as a plain percentage (it shows a droplet icon, sadly)
//   Feed Low         an occupancy sensor that trips below feedLowThreshold, so it
//                    can drive a notification or an automation
//   Battery          on the same auto rules as the doors
//
// The feeder section is not in Omlet's published API spec. Field names come from
// Omlet's own TypeScript SDK (state, fault, feedLevel, lightLevel, mode).
// feedLevel is a 0-100 percentage, confirmed against the Omlet app on a real
// feeder. The first reading is still logged in full, as a diagnostic.
class FeederAccessory extends OmletDevice {
  constructor(platform, accessory, device, startDelay = 0) {
    super(platform, accessory, device, KIND_FEEDER, 'Smart Feeder');
    
    this.pollInterval = Math.max(platform.pollInterval, MIN_FEEDER_POLL_MS);
    this.pendingServiceChange = { feed: null, battery: null };
    this.lastFault = null;
    this.stateLogged = false;
    
    this.feederService = this.accessory.getService(hap.Service.ContactSensor)
      || this.accessory.addService(hap.Service.ContactSensor);
    this.primaryService = this.feederService;
    
    this.feederService.setCharacteristic(hap.Characteristic.Name, this.name);
    this.feederService.setPrimaryService(true);
    
    this.feederService
      .getCharacteristic(hap.Characteristic.ContactSensorState)
      .onGet(this.getFeederDoorState.bind(this));
    
    this.feederService
      .getCharacteristic(hap.Characteristic.StatusFault)
      .onGet(this.getFeederFault.bind(this));
    
    // As with the door's light: keep what the cached accessory had until the first
    // poll says whether this feeder reports a feed level at all.
    this.applyFeedServices(this.hasFeedServices());
    this.applyBatteryService(platform.enableBattery === 'auto' ? this.hasBatteryService() : platform.enableBattery);
    
    this.log.info(`Feeder initialized (Feed Low alert threshold: ${platform.feedLowThreshold}%, battery: ${this.describePref(platform.enableBattery)})`);
    
    this.startPolling(startDelay);
  }
  
  feedLevel(status = this.cachedStatus) {
    const raw = status?.state?.feeder?.feedLevel;
    
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    
    const level = Number(raw);
    
    if (!Number.isFinite(level)) {
      return null;
    }
    
    return Math.min(100, Math.max(0, Math.round(level)));
  }
  
  isFeedLow(level) {
    return level < this.platform.feedLowThreshold;
  }
  
  hasFeedServices() {
    return !!this.accessory.getService(hap.Service.HumiditySensor);
  }
  
  applyFeedServices(enabled) {
    const existingLevel = this.accessory.getService(hap.Service.HumiditySensor);
    const existingLow = this.accessory.getService(hap.Service.OccupancySensor);
    
    if (!enabled) {
      [existingLevel, existingLow].forEach((service) => {
        if (service) {
          this.feederService.removeLinkedService(service);
          this.accessory.removeService(service);
        }
      });
      this.levelService = null;
      this.lowService = null;
      return;
    }
    
    const level = existingLevel || this.accessory.addService(hap.Service.HumiditySensor);
    level.setCharacteristic(hap.Characteristic.Name, `${this.name} Feed Level`);
    level
      .getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getFeedLevel.bind(this));
    this.feederService.addLinkedService(level);
    this.levelService = level;
    
    const low = existingLow || this.accessory.addService(hap.Service.OccupancySensor);
    low.setCharacteristic(hap.Characteristic.Name, `${this.name} Feed Low`);
    low
      .getCharacteristic(hap.Characteristic.OccupancyDetected)
      .onGet(this.getFeedLow.bind(this));
    this.feederService.addLinkedService(low);
    this.lowService = low;
  }
  
  reconcileServices(status) {
    const before = `${this.hasFeedServices()}|${this.hasBatteryService()}`;
    
    this.reconcileService('feed', this.feedLevel(status) !== null,
      () => this.hasFeedServices(), (v) => this.applyFeedServices(v));
    this.reconcileService('battery', this.desiredBattery(status),
      () => this.hasBatteryService(), (v) => this.applyBatteryService(v));
    
    this.firstReconcileDone = true;
    
    if (before !== `${this.hasFeedServices()}|${this.hasBatteryService()}`) {
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }
  }
  
  // "closed" is the only state in which the hens cannot feed. Mid-movement and
  // stopped states count as open, which is the safe reading for a feeder.
  getFeederDoorState() {
    const state = this.cachedStatus?.state?.feeder?.state;
    
    if (!state) {
      throw unavailable();
    }
    
    return state === 'closed'
      ? hap.Characteristic.ContactSensorState.CONTACT_DETECTED
      : hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }
  
  getFeederFault() {
    if (!this.cachedStatus) {
      throw unavailable();
    }
    
    const fault = this.cachedStatus.state?.feeder?.fault;
    
    return (fault && fault !== DOOR_FAULT_NONE)
      ? hap.Characteristic.StatusFault.GENERAL_FAULT
      : hap.Characteristic.StatusFault.NO_FAULT;
  }
  
  getFeedLevel() {
    const level = this.feedLevel();
    
    if (level === null) {
      throw unavailable();
    }
    
    return level;
  }
  
  getFeedLow() {
    const level = this.feedLevel();
    
    if (level === null) {
      throw unavailable();
    }
    
    return this.isFeedLow(level)
      ? hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }
  
  noteFeederFault(fault) {
    if (!fault || fault === DOOR_FAULT_NONE) {
      this.lastFault = fault;
      return;
    }
    
    if (fault === this.lastFault) {
      return;
    }
    
    this.lastFault = fault;
    this.log.warn(`[Feeder] Feeder reported a fault: "${fault}"`);
  }
  
  async handlePollSuccess(status) {
    await super.handlePollSuccess(status);
    
    if (!this.stateLogged) {
      this.stateLogged = true;
      const level = this.feedLevel(status);
      const door = status.state?.feeder?.state || 'unknown';
      this.log.info(`[Feeder] Feed level ${level === null ? 'unknown' : level + '%'}, door ${door}. Full state:`,
        JSON.stringify(status.state?.feeder ?? null));
    }
    
    this.reconcileServices(status);
    
    return status;
  }
  
  pushStateToHomeKit() {
    try {
      const status = this.cachedStatus;
      if (!status) return;
      
      const state = status.state?.feeder?.state;
      if (state) {
        this.feederService
          .getCharacteristic(hap.Characteristic.ContactSensorState)
          .updateValue(this.getFeederDoorState());
      }
      
      const fault = status.state?.feeder?.fault;
      if (fault !== undefined) {
        this.noteFeederFault(fault);
        this.feederService
          .getCharacteristic(hap.Characteristic.StatusFault)
          .updateValue(this.getFeederFault());
      }
      
      const level = this.feedLevel(status);
      if (level !== null && this.levelService && this.lowService) {
        this.levelService.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).updateValue(level);
        this.lowService.getCharacteristic(hap.Characteristic.OccupancyDetected).updateValue(this.getFeedLow());
      }
      
      if (this.debug) {
        this.log.info('[Poll] Feeder:', state, 'feed level:', level);
      }
      
      this.pushBatteryToHomeKit(status);
    } catch (error) {
      this.log.error('[Poll] Failed to push state to HomeKit:', error.message);
    }
  }
  
  // No commands and no transitions to watch, so a plain fixed cadence.
  async runPoll(generation) {
    try {
      await this.pollDeviceState();
      this.pushStateToHomeKit();
    } catch (error) {
      if (this.debug) {
        this.log.warn('[Poll] Poll cycle failed:', error.message);
      }
    }
    
    if (generation !== this.pollGeneration) {
      return;
    }
    
    if (this.haltIfAuthDead()) {
      return;
    }
    
    this.scheduleNextPoll(this.pollInterval);
  }
}
