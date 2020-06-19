'use strict';

const utils = require('@iobroker/adapter-core');
const adapterName = require('./package.json').name.split('.').pop();
const decrypt = require('./inc/crypt');

let adapter = null;
let states = {};
let server = null;

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {name: adapterName});
    if (typeof (utils) !== "undefined") {
        adapter = new utils.Adapter(options);
        adapter.config.iobroker = 1;
    } else {
        adapter = {
            config: require('./io-package.json').native,
            event: {},
            on: function (action, callback) {
                this.event[action] = callback;
                return this;
            },
            emit(action, params) {
                return this.event[action].call(params);
            }
        };
        adapter.config.iobroker = 0;
    }
    adapter.on('message', function (obj) {
        console.log(JSON.stringify(obj));
    });
    adapter.on('ready', () => {
        if (adapter.config.iobroker) {
            adapter.config.password = decrypt('Zgfr56gFe87jJOM', adapter.config.password);
        }
        server = require('./inc/mqttserver')(adapter.config);
        server.on('publish', (topic, state) => {
            adapter.setForeignState(topic, state);
        });
        server.listenSocketServer(adapter.config.port, adapter.config.host);
        server.listenHttpServer(adapter.config.port + 1, adapter.config.host);
    });
    adapter.on('unload', () => {
        server && server.destroy();
    });
    adapter.on('stateChange', (id, state) => {
        if (!state) {
            delete states[id];
            server && server.sendMessage(id, null);
            return;
        }
        const oldVal = states.hasOwnProperty(id) ? states[id].val : null;
        const oldAck = states.hasOwnProperty(id) ? states[id].ack : null;
        states[id] = state;
        if (oldVal !== state.val || oldAck !== state.ack) {
            server && server.sendMessage(id, state.val);
        }
    });
    return adapter;
}

startAdapter();
if (!adapter.config.iobroker) {
    console.log('Running outside of ioBroker. Fake ready event.');
    adapter.emit('ready');
    setInterval(() => {
        server.sendMessage('ntpdate/interval', Date.now());
    }, 2000);
}
