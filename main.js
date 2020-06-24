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
                states = states || {};
                Object.keys(res)
                    .filter(id => !messageboxRegex.test(id))
                    .forEach(id => states[id] = res[id]);
            }
        });

        server = require('./inc/mqttserver')(adapter.config, adapter.log.info);
        server.on('publish', (client, topic, value) => {
            let topicParts = topic.split('/');
            if (topicParts.length === 2 && topicParts[0] === 'rpc') {
                if (topicParts[2] === "get_states") {
                    setImmediate(() => {
                        Object.keys(states).forEach((id) => {
                            server && server.sendMessageToClient(
                                id2topic(id),
                                states[id].val
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
