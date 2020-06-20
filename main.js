'use strict';

const utils = require('@iobroker/adapter-core');
const adapterName = require('./package.json').name.split('.').pop();
const decrypt = require('./inc/crypt');
const encrypt = require('./inc/crypt');
const value2string = require('./inc/value2string');
const messageboxRegex = new RegExp('(\.messagebox$|^system\.)');

const secret = 'Zgfr56gFe87jJOM';
let adapter = null;
let states = {};
let server = null;

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {name: adapterName});
    adapter = new utils.Adapter(options);

    adapter.on('message', function (obj) {
        adapter.log.info('adapter.on.message: '+value2string(obj));
    });
    adapter.on('ready', () => {
        adapter.config = adapter.config || {};
        adapter.config.password = decrypt(secret, adapter.config.password || encrypt(secret, 'iobroker'));

        adapter.subscribeForeignStates('*');
        adapter.getForeignStates('*', (err, res) => {
            if (!err && res) {
                states = states || {};
                Object.keys(res)
                    .filter(id => !messageboxRegex.test(id))
                    .forEach(id => states[id] = res[id]);
            }
        });

        server = require('./inc/mqttserver')(adapter.config, adapter.log.info);
        server.on('publish', function(topic, state) {
            adapter.log.info('setState('+value2string(topic)+', '+ value2string(state)+')');
            adapter.setForeignState(topic, state);
        });
        server.listenSocketServer(adapter.config.port, adapter.config.host);
        server.listenHttpServer(adapter.config.port + 1, adapter.config.host);
    });
    adapter.on('stateChange', (id, state) => {
        if (messageboxRegex.test(id)) {
            return;
        }
        if (!state) {
            delete states[id];
            server && server.sendMessage(id, null);
            return;
        }
        const oldVal = states.hasOwnProperty(id) ? states[id].val : null;
        const oldAck = states.hasOwnProperty(id) ? states[id].ack : null;
        states[id] = state;
        if (oldVal !== state.val || oldAck !== state.ack && state.ack) {
            server && server.sendMessage(id, state.val);
        }
    });
    adapter.on('unload', () => {
        server && server.destroy();
    });
    return adapter;
}

startAdapter();
