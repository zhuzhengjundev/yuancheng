const fs = require('fs');
const src = fs.readFileSync('index.html', 'utf8');
const start = src.indexOf('<script>') + 8;
const end = src.lastIndexOf('</script>');
const script = src.substring(start, end);

const stubs = `
var __listeners = {};
var window = { 
  remoteAPI: {
    onCaptureStats: function(cb) { __listeners.capture = cb; return function(){}; },
    onRobotStatus: function(cb) { __listeners.robot = cb; return function(){}; },
    getDeviceInfo: function() { return Promise.resolve({deviceCode:'123 456 789',password:'test',serverConnected:false,session:null}); },
    refreshPassword: function() { return Promise.resolve({}); },
    connectDevice: function() { return Promise.resolve({}); },
    disconnect: function() { return Promise.resolve({}); },
    openScreenRecordSettings: function() { return Promise.resolve({}); },
    validateWsUrl: function() { return Promise.resolve({valid:false}); },
    saveWsUrl: function() { return Promise.resolve({}); },
    getWsUrl: function() { return Promise.resolve(null); },
    gotoHome: function() { return Promise.resolve({}); },
    gotoSetup: function() { return Promise.resolve({}); },
    onAppStatus: function() { return function(){}; },
    onDeviceInfo: function() { return function(){}; },
    onConnectError: function() { return function(){}; },
    onConnectOk: function() { return function(){}; },
    onIncomingControl: function() { return function(){}; },
    onCaptureStatus: function() { return function(){}; },
    onScreenFrameHeader: function() { return function(){}; },
    onScreenFrameChunk: function() { return function(){}; },
    onScreenFrame: function() { return function(){}; },
    onSessionEnded: function() { return function(){}; },
    onDiagStats: function() { return function(){}; }
  } 
};
var document = { 
  getElementById: function(id) { 
    return { 
      get textContent() { return ''; }, 
      set textContent(v) {},
      get innerHTML() { return ''; },
      set innerHTML(v) {},
      classList: { add: function(){}, remove: function(){}, toggle: function(){} },
      appendChild: function(){},
      removeChild: function(){},
      style: {}
    };
  },
  addEventListener: function() {}
};
var navigator = { clipboard: { writeText: function() { return Promise.resolve(true); } } };
var setTimeout = function() { return 0; };
var clearTimeout = function() {};
var console = { log: function(){ process.stdout.write('[LOG] ' + Array.prototype.join.call(arguments, ' ') + '\\n'); } };
`;

const combined = stubs + '\n' + script;
const tmp = 'test-html-tmp.js';
fs.writeFileSync(tmp, combined);
console.log('Written ' + combined.length + ' bytes to ' + tmp);
