'use strict';

const utils = require('@iobroker/adapter-core');
const crypto = require('crypto');
const MqttServer = require('./MqttServer');
const adapterName = require('../package.json').name.split('.').pop();

class Adapter extends utils.Adapter {

    constructor(options = {}) {
        super({...options, name: adapterName});
        this.states = {};
        this.server = null;

        this.on("ready", () => this.start());
        this.on("message", (message) => this.onMessage(message));
        this.on("stateChange", (id, state) => this.onStateChange(id, state));
        this.on("unload", (callback) => this.onUnload(callback));
    }

    start() {
        this.subscribeForeignStates('*');
        //this.subscribeForeignObjects('*');
        this._preloadingStates();
        this._startServer()
            .catch(e => this.log.info(e.toString()));
    }

    _preloadingStates() {
        this.getForeignStates('*', (err, res) => {
            if (!err && res) {
                Object.keys(res).forEach((id) => {
                    this.onStateChange(id, res[id]);
                });
                return;
            }
            this.log.error(err.toString());
        });
    }

    _startServer() {
        const thiz = this;
        this.server = new MqttServer({
            cleanup_interval: 90000,
            max_retries: 45,
            resend_interval: 2000,
            checkCredentials: (username, password) => {
                return this._checkCredentials(username, password);
            },
            canSubscribe: (client, topic, qos) => {
                return new Promise((resolve, reject) => {
                    0 <= qos && qos <= 1 ? resolve() : reject('Invalid qos level.');
                });
            },
            onPublish(client, topic, value) {
                thiz.log.info('adapter.onPublish '+client._id+' / '+topic);
                this._onClientPublish(client, topic, value);
            }
        }, this);
        return this.server.start();
    }

    onStateChange(id, state) {
        if (/\.messagebox$/.test(id)) {
            return;
        }
        if (!state) {
            delete this.states[id];
            this.server && this.server.sendMessage(this._id2topic(id), null);
            return;
        }
        const oldVal = this.states.hasOwnProperty(id) ? this.states[id].val : null;
        const oldAck = this.states.hasOwnProperty(id) ? this.states[id].ack : null;
        this.states[id] = state;
        if (oldVal !== state.val || oldAck !== state.ack) {
            this.server && this.server.sendMessage(this._id2topic(id), state.val);
        }
    }

    onMessage(message) {
        this.log.info('onMessage: ' + JSON.stringify(message));
    }

    onUnload(callback) {
        callback = !!callback ? callback : () => {
        };
        this.unsubscribeForeignObjects('*');
        this.server.stop();
        callback();
    }

    _getSecret() {
        return new Promise((resolve) => {
            this.getForeignObject('system.meta.uuid', (err, obj) => {
                resolve(((obj || {}).native || {}).secret || 'Zgfr56gFe87jJOM');
            });
        });
    }

    _encrypt(value) {
        return new Promise((resolve, reject) => {
            this._getSecret()
                .then((key) => {
                    let result = '';
                    for (let i = 0; i < value.length; ++i) {
                        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
                    }
                    resolve(result);
                })
                .catch(e => reject(e));
        });
    }

    _decrypt(value) {
        return this._encrypt(value);
    }

    _checkCredentials(username, password) {
        return new Promise((resolve, reject) => {
            username = username.replace(/\s/g, '_');
            this.getForeignObject(
                'system.user.' + username,
                (err, obj) => {
                    if (err || !obj) {
                        return reject(err || 'Unknown system user.');
                    }

                    if (!obj.common.enabled) {
                        return reject('Invalid credentials. User is disabled.');
                    }

                    /** @see https://github.com/ioBroker/ioBroker.js-controller/blob/3a3cda9ba615ed14a9a128de4379f5589f4f4b0f/lib/password.js#L72 */
                    const oldHash = obj.common.password;
                    const key = oldHash.split('$');
                    if (key.length !== 4 || !key[2] || !key[3]) {
                        return reject('Invalid credentials. Unknown password type.');
                    }
                    if (key[0] !== 'pbkdf2') {
                        return reject('Invalid credentials. Invalid password type.');
                    }

                    const salt = key[3] || crypto.randomBytes(16).toString('hex');
                    const iterations = parseInt(key[1], 10) || 10000;

                    crypto.pbkdf2(
                        password,
                        salt,
                        iterations,
                        256,
                        'sha256',
                        (err, key) => {
                            if (err || !key) {
                                return reject('Invalid credentials. ' + err.toString());
                            }

                            let newHash = "pbkdf2$" + iterations + "$" + key.toString('hex') + "$" + salt;
                            if (oldHash === newHash) {
                                return resolve();
                            }
                            return reject('Invalid credentials. Invalid Password.');
                        }
                    );
                }
            );
        });
    }

    _id2topic(id) {
        let parts = id.split('.');
        return parts.shift() + '.' + parts.shift() + '/' + parts.join('/');
    }

    _topic2id(topic) {
        return topic.split('/').join('.');
    }

    _onClientPublish(client, topic, value) {
        if (/^\$/.test(topic) || /^system/.test(topic)) {
            return;
        }
        if (/^rpc\//.test(topic)) {
            const command = topic.replace(/^rpc\//g, '');
            this._onClientCommand(client, command, value);
            return;
        }
        const id = this._topic2id(topic);
        if (!this.states.hasOwnProperty(id)) {
            this.log.warn('User ' + client._username + ' try to set unknown id ' + id);
            return;
        }
        this.log.info('User ' + client._username + ' update ' + id);
        this.setForeignState(id, value);
    }

    _onClientCommand(client, command, value = null) {
        this.log.info('Client ' + client._id + ' call function: ' + command);
        if (command === "get_states") {
            Object.keys(this.states).forEach((id) => {
                this.server.sendMessageToClient(
                    client,
                    this._id2topic(id),
                    (this.states[id] || {}).val || null
                );
            });
        }
    }

}

module.exports = Adapter;
