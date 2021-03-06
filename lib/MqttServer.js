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
            bind: '0.0.0.0',
            port: 1883,
            broker: false,
            cleanup_interval: 90000,
            max_retries: 45,
            resend_interval: 2000,
            checkCredentials: (username, password) => {
                return Promise.reject('Missing auth provider.');
            },
            canSubscribe: (client, topic, qos) => {
                return Promise.resolve(128); // 128 = error code!
            },
            onPublish: (client, topic, value) => {
            }
        }
        this.options = {...this.options, ...options};
        this.messageId = 1;
        this.retains = {};
        this.clients = {};
        this.sockServer = null;
        this.httpServer = null;
        this.cleanupInterval = null;
        this.resendInterval = null;
    }

    log(message) {
        this.adapter && this.adapter.log && this.adapter.log.info && this.adapter.log.info(message);
    }

    start() {
        return Promise.all([
            this._startCleanupInterval(),
            this._startResendInterval(),
            this._startSocketServer(this.options.bind, this.options.port),
            this._startWebSocketServer(this.options.bind, this.options.port + 1),
        ]);
    }

    _startCleanupInterval() {
        return new Promise((resolve) => {
            if (!this.cleanupInterval) {
                this.log('Starting cleanup interval.');
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
        return new Promise((resolve) => {
            if (!this.resendInterval) {
                this.log('Starting resend interval.');
                this.resendInterval = setInterval(() => {
                    Object.values(this.clients).forEach((client) => {
                        Object.values(client._outgoing).forEach((message) => {
                            if (this.clients[client._id]._outgoing[message.messageId].cmd !== 'publish') {
                                return;
                            }

                            this.clients[client._id]._outgoing[message.messageId].count++;
                            if (this.clients[client._id]._outgoing[message.messageId].count >= this.options.max_retries) {
                                delete this.clients[client._id]._outgoing[message.messageId];
                                return;
                            }

                            if (this.clients[client._id]._outgoing[message.messageId].ts >= Date.now() - this.options.resend_interval) {
                                return;
                            }

                            this.clients[client._id]._outgoing[message.messageId].ts = Date.now();
                            this.clients[client._id].publish(
                                this.clients[client._id]._outgoing[message.messageId]
                            );
                        });
                    });
                }, this.options.resend_interval);
            }
            resolve();
        });
    }

    _stopCleanupInterval() {
        return new Promise((resolve) => {
            if (this.cleanupInterval) {
                this.log('Stopping cleanup interval.');
                clearInterval(this.cleanupInterval);
            }
            this.cleanupInterval = null;
            resolve();
        })
    }

    _stopResendInterval() {
        return new Promise((resolve) => {
            if (this.resendInterval) {
                this.log('Stopping resend interval.');
                clearInterval(this.resendInterval);
            }
            this.resendInterval = null;
            resolve();
        });
    }

    _startSocketServer(bind = '0.0.0.0', port = 1883) {
        return new Promise((resolve, reject) => {
            try {
                this.log('Starting mqtt server on ' + bind + ':' + port);
                this.sockServer = new net.Server();
                this.sockServer.on('connection', stream => this._onConnection(stream, false));
                this.sockServer.listen(port, bind, resolve);
            } catch (e) {
                reject(e);
            }
        });
    }

    _stopSocketServer() {
        return new Promise((resolve) => {
            if (this.sockServer) {
                this.log('Stopping mqtt server.');
                this.sockServer.close()
            }
            this.sockServer = null;
            resolve();
        });
    }

    _startWebSocketServer(bind = '0.0.0.0', port = 1884) {
        return new Promise((resolve, reject) => {
            try {
                this.log('Starting websocket server on ' + bind + ':' + port);
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
        return new Promise((resolve) => {
            if (this.httpServer) {
                this.log('Stopping websocket server.');
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
        let client = ws ? mqtt(websocketStream(stream)) : mqtt(stream);
        client._id = client._id || null;
        client._username = client._username || null;
        client._keepalice = client._keepalice || null;
        client._lastSeen = Date.now();
        client._outgoing = client._outgoing || {};
        client._incoming = client._incoming || {};
        client._subscriptions = client._subscriptions || {}; // {topic: {regex, qos}}
        client._will = client._will || null;
        client._persistent = client._persistent || false;
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
        const password = (packet.password || '').toString('utf8');

        this.options.checkCredentials(username, password)
            .then(() => {
                client._id = packet.clientId;
                client._username = username;
                client._keepalice = packet.keepalive || 0;
                this.log(client._id + ': Client accepted as user ' + client._username);

                if (!!packet.will) {
                    this.log(client._id + ': Update last will.');
                    let will = JSON.parse(JSON.stringify(packet.will));
                    will.payload = this._string2value(will.payload);
                    client._will = will;
                }

                client.connack({returnCode: 0, sessionPresent: !client.cleanSession});

                if (!packet.clean) {
                    client._persistent = true;
                    client._outgoing = (this.clients[client._id] || {})._outgoing || {}; // {messageId: message}
                    client._incoming = (this.clients[client._id] || {})._incoming || {}; // {messageId: message}
                    client._subscriptions = (this.clients[client._id] || {})._subscriptions || {}; // {topic: {regex, qos}}}
                } else {
                    this.log(client._id + ': Reset session.');
                    client._persistent = false;
                    client._outgoing = {};
                    client._incoming = {};
                    client._subscriptions = {};
                }
                client._connected = true;
                this.clients[client._id] = client;
            })
            .catch((e) => {
                this.log(client._id + ': Connection rejected: ' + e.toString());
                client.connack({returnCode: 4});
                client.destroy();
            });
    }

    _onPublish(client, packet) {
        client._lastSeen = Date.now();
        if (packet.topic.indexOf('$') === 0) {
            this.log(client._id + ': skip illegal topic ' + packet.topic);
            return;
        }

        if (packet.qos === 1) {
            client.puback({messageId: packet.messageId});
        } else if (packet.qos === 2) {
            if (!client._incoming.hasOwnProperty(packet.messageId)) {
                client._incoming[packet.messageId] = packet;
                client.pubrec({messageId: packet.messageId});
            } else {
                // @TODO warn - we received the packet two or more times
            }
            return;
        }

        const topic = packet.topic;
        const value = this._string2value(packet.payload);
        if (this.options.broker) {
            if (packet.retain) {
                this.retains[topic] = value;
            }
            this.sendMessage(topic, value);
        } else {
            this.options.onPublish(client, topic, value)
        }
    }

    _onPubAck(client, packet) {
        client._lastSeen = Date.now();
        if (client._outgoing.hasOwnProperty(packet.messageId)) {
            delete client._outgoing[packet.messageId];
        }
    }

    _onPubRec(client, packet) {
        client._lastSeen = Date.now();
        if (client._outgoing.hasOwnProperty(packet.messageId)) {
            client.pubrel({messageId: packet.messageId});
        }
    };

    _onPubComp(client, packet) {
        client._lastSeen = Date.now();
        if (client._outgoing.hasOwnProperty(packet.messageId)) {
            delete client._outgoing[packet.messageId];
        }
    }

    _onPubRel(client, packet) {
        client._lastSeen = Date.now();
        if (client._incoming.hasOwnProperty(packet.messageId)) {
            client.pubcomp({messageId: packet.messageId});
            this._onPublish(client, {...client._incoming[packet.messageId], qos: 0});
            delete client._incoming[packet.messageId];
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
        client._lastSeen = Date.now();
        let granted = [];
        for (let i = 0; i < packet.subscriptions.length; i++) {
            const topic = packet.subscriptions[i].topic;
            const qos = packet.subscriptions[i].qos;
            const result = await this.options.canSubscribe(client, topic, qos);
            if (result !== 128) {
                this.log(client._id + ': Subscribe topic: ' + topic);
                client._subscriptions[topic] = {regex: this._topic2regex(topic), qos: qos};
                // @TODO fix retains with regex topics!
                if (this.retains.hasOwnProperty(topic)) {
                    this.sendMessageToClient(client, topic, this.retains[topic], false, qos);
                }
            }
            granted.push(result);
        }
        client.suback({granted: granted, messageId: packet.messageId});
    }

    _onUnsubscribe(client, packet) {
        client._lastSeen = Date.now();
        for (let i = 0; i < packet.unsubscriptions.length; i++) {
            const topic = packet.unsubscriptions[i];
            if (client._subscriptions.hasOwnProperty(topic)) {
                this.log(client._id + ': Unsubscribe topic: ' + topic);
                delete client._subscriptions[topic];
            }
        }
        client.unsuback({messageId: packet.messageId});
    }

    _onPingReq(client, packet) {
        client._lastSeen = Date.now();
        client.pingresp();
    }

    _onClose(client, error = null) {
        error = error !== null && typeof (error) !== "string" ? error.toString() : error;
        error = error || 'unknown';
        if (this.clients.hasOwnProperty(client._id)) {
            if (this.clients[client._id]._connected) {
                this.log(client._id + ': Connection closed: ' + error.toString());
            }
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
        if (!client._will) {
            return;
        }
        this.log(client._id + ': Sensing last will.');
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
        let packet = {
            qos: (client._subscriptions[topic] || {}).qos || qos,
            retain: !!retain,
            messageId: this.getMessageId(),
            ts: Date.now(),
            count: 0,
            cmd: 'publish',
            topic: topic,
            payload: this._value2string(payload),
        }
        if (packet.qos > 0) {
            client._outgoing[packet.messageId] = packet;
        }
        client.publish(packet);
        return packet;
    }

    stop() {
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
            this._stopWebSocketServer(),
            this._stopSocketServer(),
        ]);
    }

}

module.exports = MqttServer;
