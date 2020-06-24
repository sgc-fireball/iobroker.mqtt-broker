'use strict';

const utils = require('@iobroker/adapter-core');
const adapterName = require('./package.json').name.split('.').pop();
const decrypt = require('./inc/crypt');
const encrypt = require('./inc/crypt');
const value2string = require('./inc/value2string');
const topic2id = require('./inc/topic2id');
const id2topic = require('./inc/id2topic');
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
        adapter.log.info('adapter.on.message: ' + value2string(obj));
    });

    adapter.on('ready', () => {
        adapter.config = adapter.config || {};
        adapter.config.password = decrypt(secret, adapter.config.password || encrypt(secret, 'iobroker'));

        adapter.subscribeForeignStates('*');
        adapter.getForeignStates('*', (err, res) => {
            if (!err && res) {
                Object.keys(res)
                    .filter(id => !messageboxRegex.test(id))
                    .forEach(id => states[id] = res[id]);
                adapter.log.info('Preloading states: '+Object.keys(states).length);
            }
        });

        server = require('./inc/mqttserver')(adapter.config, adapter.log.info);
        server.on('publish', (client, topic, value) => {
            if (topic === 'rpc') {
                adapter.log.info('Client ' + client._id + ' call function: ' + value);
                if (value === "get_states") {
                    setImmediate(() => {
                        Object.keys(states).forEach((id) => {
                            server && server.sendMessageToClient(
                                client,
                                id2topic(id),
                                (states[id] || {}).val || null
                            );
                        });
                    });
                }
                return;
            }
            let id = topic2id(topic);
            if (!states.hasOwnProperty(id)) {
                adapter.log.warn('User ' + client._username + ' try to set unknown id ' + id);
                return;
            }
            adapter.log.info('User ' + client._username + ' update ' + id + ' to ' + value2string(value));
            adapter.setForeignState(id, value);
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
            server && server.sendMessage(id2topic(id), null);
            return;
        }
        const oldVal = states.hasOwnProperty(id) ? states[id].val : null;
        const oldAck = states.hasOwnProperty(id) ? states[id].ack : null;
        states[id] = state;
        if (oldVal !== state.val || oldAck !== state.ack) {
            server && server.sendMessage(id2topic(id), state.val);
        }
    });
    adapter.on('unload', () => {
        server && server.destroy();
    });
    return adapter;
}

startAdapter();
