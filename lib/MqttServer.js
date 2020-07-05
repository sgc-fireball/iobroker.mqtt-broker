'use strict';

const ws = require('ws');
const net = require('net');
const http = require('http');
const uuid = require('uuid').v4;
const mqtt = require('mqtt-connection');
const websocketStream = require('websocket-stream');

class MqttServer {

    constructor(options, adapter) {
        this.adapter = adapter;
        this.options = {
            broker: false,
            cleanup_interval: 90000,
            max_retries: 45,
            resend_interval: 2000,
            checkCredentials: (/*username, password*/) => {
                return Promise.reject('Missing auth provider.');
            },
            canSubscribe: (/*client, topic, qos*/) => {
                return Promise.reject('Reject subscribtion');
            },
            onPublish(/*client, topic, value*/) {
                // do nothing
            }
        }
        this.options = {...this.options, options};
        this.messageId = 1;
        this.retains = {};
        this.clients = {};
        this.sockServer = null;
        this.httpServer = null;
        this.cleanupInterval = null;
        this.resendInterval = null;
    }

    log(message) {
        this.adapter && this.adapter.log && this.adapter.log.info(message);
    }

    start() {
        this.log('start');
        return Promise.all([
            this._startCleanupInterval(),
            this._startResendInterval(),
            this._startSocketServer(this.options.port, this.options.bind),
            this._startWebSocketServer(this.options.port + 1, this.options.bind),
        ]);
    }

    _startCleanupInterval() {
        this.log('_startCleanupInterval');
        return new Promise((resolve) => {
            if (!this.cleanupInterval) {
                this.cleanupInterval = setInterval(() => {
                    Object.values(this.clients).forEach((client) => {
                        if (client._lastSeen <= Date.now() - this.options.cleanup_interval) {
                            this._onClose(client, 'cleanup');
                        }
                    });
                }, this.options.cleanup_interval);
            }
            resolve();
        });
    }

    _startResendInterval() {
        this.log('_startResendInterval');
        return new Promise((resolve) => {
            if (this.resendInterval) {
                this.resendInterval = setInterval(() => {
                    Object.values(this.clients).forEach((client) => {
                        Object.values(client._messages).forEach((message) => {
                            if (this.clients[client._id]._messages[message.messageId].cmd !== 'publish') {
                                return;
                            }

                            this.clients[client._id]._messages[message.messageId].count++;
                            if (this.clients[client._id]._messages[message.messageId].count >= this.options.max_retries) {
                                delete this.clients[client._id]._messages[message.messageId];
                                return;
                            }

                            if (this.clients[client._id]._messages[message.messageId].ts >= Date.now() - this.options.resend_interval) {
                                return;
                            }

                            this.clients[client._id]._messages[message.messageId].ts = Date.now();
                            this.clients[client._id].publish(
                                this.clients[client._id]._messages[message.messageId]
                            );
                        });
                    });
                }, this.options.resend_interval);
            }
            resolve();
        });
    }

    _stopCleanupInterval() {
        this.log('_stopCleanupInterval');
        return new Promise((resolve) => {
            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);
            }
            this.cleanupInterval = null;
            resolve();
        })
    }

    _stopResendInterval() {
        this.log('_stopResendInterval');
        return new Promise((resolve) => {
            if (this.resendInterval) {
                clearInterval(this.resendInterval);
            }
            this.resendInterval = null;
            resolve();
        });
    }

    _startSocketServer(bind = '0.0.0.0', port = 1883) {
        this.log('_startSocketServer');
        return new Promise((resolve, reject) => {
            try {
                this.sockServer = new net.Server();
                this.sockServer.on('connection', stream => this._onConnection(stream, false));
                this.sockServer.listen(port, bind, resolve);
            } catch (e) {
                reject(e);
            }
        });
    }

    _stopSocketServer() {
        this.log('_stopSocketServer');
        return new Promise((resolve) => {
            if (this.sockServer) {
                this.sockServer.close()
            }
            this.sockServer = null;
            resolve();
        });
    }

    _startWebSocketServer(bind = '0.0.0.0', port = 1884) {
        this.log('_startWebSocketServer');
        return new Promise((resolve, reject) => {
            try {
                this.httpServer = http.createServer();
                let websocketServer = new ws.Server({server: this.httpServer});
                websocketServer.on('connection', stream => this._onConnection(stream, true));
                this.httpServer.listen(port, bind, resolve);
            } catch (e) {
                reject(e);
            }
        });
    }

    _stopWebSocketServer() {
        this.log('_stopWebSocketServer');
        return new Promise((resolve) => {
            if (this.httpServer) {
                this.httpServer.close();
            }
            this.httpServer = null;
            resolve();
        });
    }

    getMessageId() {
        const msgId = this.messageId;
        this.messageId++;
        this.messageId &= 0xFFFFFFFF;
        return msgId;
    }

    _onConnection(stream, ws = false) {
        this.log('_onConnection');
        let client = ws ? mqtt(websocketStream(stream)) : mqtt(stream);
        client._id = client._id || uuid();
        client._username = client._username || null;
        client._keepalice = client._keepalice || null;
        client._lastSeen = Date.now();
        client._messages = client._messages || {};
        client._subscriptions = client._subscriptions || {}; // {topic: {regex, qos}}
        client._will = client._will || null;
        client._persistent = client._persistent || false;
        this.log('Incoming connection: '+ client._id+ ' / '+ client._username);
        client.on('connect', packet => this._onConnect(client, packet));
        client.on('subscribe', packet => this._onSubscribe(client, packet));
        client.on('unsubscribe', packet => this._onUnsubscribe(client, packet));
        client.on('publish', packet => this._onPublish(client, packet));
        client.on('puback', packet => this._onPubAck(client, packet)); // QoS1
        client.on('pubrec', packet => this._onPubRec(client, packet)); // QoS2
        client.on('pubcomp', packet => this._onPubComp(client, packet)); // QoS2
        client.on('pubrel', packet => this._onPubRel(client, packet)); // QoS2
        client.on('pingreq', packet => this._onPingReq(client, packet));
        client.on('close', with_error => this._onClose(client, with_error ? 'unknown error' : 'closed'));
        client.on('error', error => this._onClose(client, error));
        client.on('disconnect', () => this._onClose(client, 'disconnected'));
        stream.on('timeout', () => this._onTimeout(client));
    }

    _clientHasSubscribedTopic(client, topic) {
        let found = false;
        Object.values(client._subscriptions).forEach((subscription) => {
            if (!found) {
                if (subscription.regex.test(topic)) {
                    found = true;
                }
            }
        });
        return found;
    }

    _onConnect(client, packet) {
        const username = (packet.username || '').toString('utf8');
        this.log('_onConnect: ' + client._id + ' / ' + client._username);
        const password = (packet.password || '').toString('utf8');

        this.options.checkCredentials(username, password)
            .then(() => {
                client._id = packet.clientId;
                client._username = packet.username;
                client._keepalice = packet.keepalive || 0;
                if (!!packet.will) {
                    let will = JSON.parse(JSON.stringify(packet.will));
                    will.payload = this._string2value(will.payload);
                    client._will = will;
                }

                client.connack({returnCode: 0, sessionPresent: !client.cleanSession});

                if (!packet.clean) {
                    client._persistent = true;
                    client._messages = (this.clients[client._id] || {})._messages || {}; // {messageId: message}
                    client._subscriptions = (this.clients[client._id] || {})._subscriptions || {}; // {topic: {regex, qos}}}
                } else {
                    client._persistent = false;
                    client._messages = {};
                    client._subscriptions = {};
                }
                client._connected = true;
                this.clients[client._id] = client;
            })
            .catch((e) => {
                client.connack({returnCode: 4});
                client.destroy();
            })
    }

    _onPublish(client, packet) {
        this.log('_onSubscribe: ' + client._id + ' / ' + client._username + ' : ' + JSON.stringify(packet.topic));
        client._lastSeen = Date.now();
        if (packet.topic.indexOf('$') === 0) {
            return;
        }

        if (packet.qos === 1) {
            client.puback({messageId: packet.messageId});
        } else if (packet.qos === 2) {
            client.pubrec({messageId: packet.messageId});
            return;
        }

        const state = this._string2value(packet.payload);

        if (packet.retain) {
            this.retains[packet.topic] = state;
        }

        if (this.options.broker) {
            this.sendMessage(packet.topic, state);
        } else {
            this.options.onPublish(client, packet.topic, state)
        }
    }

    _onPubAck(client, packet) {
        this.log('_onPubAck: ' + client._id + ' / ' + client._username);
        client._lastSeen = Date.now();
        if (client._messages.hasOwnProperty(packet.messageId)) {
            delete client._messages[packet.messageId];
        }
    }

    _onPubComp(client, packet) {
        this.log('_onPubComp: ' + client._id + ' / ' + client._username);
        client._lastSeen = Date.now();
        if (client._messages.hasOwnProperty(packet.messageId)) {
            delete client._messages[packet.messageId];
        }
    }

    _onPubRel(client, packet) {
        this.log('_onPubRel: ' + client._id + ' / ' + client._username);
        client._lastSeen = Date.now();
        if (client._messages.hasOwnProperty(packet.messageId)) {
            client.pubcomp({messageId: packet.messageId});
        }
    }

    _topic2regex(pattern) {
        if (pattern === '#') {
            return new RegExp('^.*$');
        }

        let wildcardPos = pattern.indexOf('#');
        if (wildcardPos !== -1) {
            if (wildcardPos !== pattern.length - 1) {
                throw new Error('Invalid pattern.');
            }
            pattern = pattern.replace(/\$/g, '\\$');
            pattern = pattern.replace(/\./g, '\\.');
            pattern = pattern.replace(/#$/, '.*');
            return new RegExp('^' + pattern + '$');
        }

        pattern = pattern.replace(/\$/g, '\\$');
        pattern = pattern.replace(/\./g, '\\.');
        pattern = pattern.replace(/\+/, '[^/]+');
        return new RegExp('^' + pattern + '$');
    }

    async _onSubscribe(client, packet) {
        this.log('_onSubscribe: ' + client._id + ' / ' + client._username);
        client._lastSeen = Date.now();
        let granted = [];
        for (let i = 0; i < packet.subscriptions.length; i++) {
            const topic = packet.subscriptions[i].topic;
            const qos = packet.subscriptions[i].qos;
            if (await this.options.canSubscribe(client, topic, qos)) { // if allowed
                granted.push(qos);
                client._subscriptions[topic] = {regex: this._topic2regex(topic), qos: qos};

                if (this.retains.hasOwnProperty(topic)) {
                    this.sendMessageToClient(client, topic, this.retains[topic], false, qos);
                }
            } else {
                granted.push(128); // Failed
            }
        }
        this.log('_onSubscribe: ' + client._id + ' / ' + client._username + ' : ' + JSON.stringify(granted));
        client.suback({granted: granted, messageId: packet.messageId});
    }

    _onUnsubscribe(client, packet) {
        this.log('_onUnsubscribe: ' + client._id + ' / ' + client._username);
        client._lastSeen = Date.now();
        for (let i = 0; i < packet.unsubscriptions.length; i++) {
            const topic = packet.unsubscriptions[i];
            if (client._subscriptions.hasOwnProperty(topic)) {
                delete client._subscriptions[topic];
            }
        }
        client.unsuback({messageId: packet.messageId});
    }

    _onPingReq(client, packet) {
        this.log('_onPingReq: ' + client._id + ' / ' + client._username);
        client._lastSeen = Date.now();
        client.pingresp();
    }

    _onClose(client, error = null) {
        error = error !== null && typeof (error) !== "string" ? error.toString() : error;
        error = error || 'unknown';
        this.log('_onClose: ' + client._id + ' / ' + error);
        if (!this.clients.hasOwnProperty(client._id)) {
            return;
        }
        if (this.clients.hasOwnProperty(client._id)) {
            if (this.clients[client._id]._persistent && error !== 'cleanup') {
                this.clients[client._id]._connected = false;
            } else {
                this._sendWillMessage(client);
                delete this.clients[client._id];
            }
        }
    }

    _onTimeout(client) {
        this._onClose(client, 'timeout');
    }

    _sendWillMessage(client) {
        this.log('_sendWillMessage: ' + client._id + ' / ' + client._username);
        if (!client._will) {
            return;
        }
        this.sendMessage(client._will.topic, client._will.payload);
    }

    _string2value(str) {
        if (typeof (str) === "object" && Buffer.isBuffer(str)) {
            str = str.toString('utf8');
        }
        if (typeof (str) === "object" && !!str.type && str.type === "Buffer") {
            str = Buffer.from(str.data).toString('utf8');
        }
        if (str === 'null') {
            return null;
        }
        if (str === 'true') {
            return true;
        }
        if (str === 'false') {
            return false;
        }
        if (str.substr(0, 1) === '{' && str.substr(-1, 1) === '}') {
            return JSON.parse(str);
        }
        if (str.substr(0, 1) === '[' && str.substr(-1, 1) === ']') {
            return JSON.parse(str);
        }
        if (/[+|-][0-9]+\.[0-9]+/.test(str)) {
            return parseFloat(str);
        }
        if (/[+|-][0-9]+/.test(str)) {
            return parseInt(str);
        }
        return str;
    }

    _value2string(value) {
        if (value === undefined || value === null) {
            return 'null';
        }
        if (value === true) {
            return 'true';
        }
        if (value === false) {
            return 'false';
        }
        if (typeof (value) === "object") {
            return JSON.stringify(value);
        }
        if (typeof (value) === "number") {
            return value.toString(10);
        }
        return value.toString('utf8');
    }

    sendMessage(topic, payload, retain = false, qos = 0) {
        Object.values(this.clients).forEach((client) => {
            this.sendMessageToClient(client, topic, payload, retain, qos);
        });
    }

    sendMessageToClient(client, topic, payload, retain = false, qos = 0) {
        if (!this._clientHasSubscribedTopic(client, topic)) {
            return;
        }
        let message = {
            qos: (client._subscriptions[topic] || {}).qos || qos,
            retain: !!retain,
            messageId: this.getMessageId(),
            ts: Date.now(),
            count: 0,
            cmd: 'publish',
            topic: topic,
            payload: this._value2string(payload),
        }
        if (message.qos > 0) {
            client._messages[message.messageId] = message;
        }
        client.publish(message);
        return message;
    }

    stop() {
        this.log('stop');
        return Promise.all([
            this._stopCleanupInterval(),
            this._stopResendInterval(),
            new Promise((resolve) => {
                Object.values(this.clients).forEach((client) => {
                    client.destroy();
                    delete this.clients[client._id];
                });
                resolve();
            }),
            this._stopSocketServer(),
            this._stopWebSocketServer(),
        ]);
    }

}

module.exports = MqttServer;
