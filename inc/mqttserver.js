const ws = require('ws');
const net = require('net');
const http = require('http');
const uuid = require('uuid').v4;
const mqtt = require('mqtt-connection');
const websocketStream = require('websocket-stream');
const value2string = require('./value2string');
const string2value = require('./string2value');
const hasSubscribed = require('./hasSubscribed');
const topic2regex = require('./topic2regex');
//const cTable = require('console.table');

/**
 * @see https://github.com/ioBroker/ioBroker.mqtt/blob/master/lib/server.js#L1171
 */
function MQTTServer(config) {
    if (!(this instanceof MQTTServer)) {
        return new MQTTServer(config);
    }

    this.config = config;
    this.config.debug = !!this.config.debug;
    this.config.cleanup_interval = this.config.cleanup_interval || 90000;
    this.config.max_retries = this.config.max_retries || 10;
    this.config.resend_interval = this.config.resend_interval || 2000;

    this.messageId = 1;
    this.retains = {};
    this.clients = {};
    this.events = {
        publish: {}
    };
    this.sockServer = null;
    this.httpServer = null;

    this.cleanupInterval = setInterval(() => {
        Object.values(this.clients).forEach((client) => {
            if (client._lastSeen <= Date.now() - this.config.cleanup_interval) {
                this._onClose(client, 'cleanup');
            }
        });
    }, this.config.cleanup_interval);

    this.resendInterval = setInterval(() => {
        Object.values(this.clients).forEach((client) => {
            Object.values(client._messages).forEach((message) => {
                if (this.clients[client._id]._messages[message.messageId].cmd !== 'publish') {
                    return;
                }

                this.clients[client._id]._messages[message.messageId].count++;
                if (this.clients[client._id]._messages[message.messageId].count >= this.config.max_retries) {
                    delete this.clients[client._id]._messages[message.messageId];
                    return;
                }

                if (this.clients[client._id]._messages[message.messageId].ts >= Date.now() - this.config.resend_interval) {
                    return;
                }

                this.clients[client._id]._messages[message.messageId].ts = Date.now();
                this.clients[client._id].publish(
                    this.clients[client._id]._messages[message.messageId]
                );
            });
        });
    }, this.config.resend_interval);

    /*if (this.config.debug) {
        setInterval(() => {
            let now = Date.now();
            console.clear();
            console.log('Date: '+parseInt(now/1000).toString());
            console.table('Clients',
                Object.values(this.clients).map((client) => {
                    return {
                        id: client._id,
                        keepalice: client._keepalice,
                        lastSeen: (now - client._lastSeen)/1000,
                        connected: client._connected,
                        persistent: client._persistent,
                        messages: Object.values(client._messages).length,
                        subscriptions: Object.values(client._subscriptions).length,
                    };
                })
            );
        }, 1000)
    }*/
}

MQTTServer.prototype.on = function(event, callback) {
    if (!this.events.hasOwnProperty(event)) {
        return null;
    }
    let id = uuid();
    this.events[event][id] = callback;
    return id;
};

MQTTServer.prototype.emit = function(event, parameters) {
    if (!this.events.hasOwnProperty(event)) {
        return this;
    }
    Object.values(this.events[event]).forEach(callback => {
        callback.call(parameters);
    })
    return this;
};

MQTTServer.prototype.off = function(event, id) {
    if (!this.events.hasOwnProperty(event)) {
        return this;
    }
    if (!this.events[event].hasOwnProperty(id)) {
        return this;
    }
    delete this.events[event][id];
    return id;
};

MQTTServer.prototype.listenSocketServer = function (port = 1883, bind = '0.0.0.0', callback) {
    callback = callback || function () {
    };
    this.sockServer = new net.Server();
    this.sockServer.on('connection', stream => this._onConnection(stream, false));
    this.sockServer.listen(port, bind, callback);
    return this;
};

MQTTServer.prototype.listenHttpServer = function (port = 1884, bind = '0.0.0.0', callback) {
    callback = callback || function () {
    };
    this.httpServer = http.createServer();
    let websocketServer = new ws.Server({server: this.httpServer});
    websocketServer.on('connection', stream => this._onConnection(stream, true));
    this.httpServer.listen(port, bind, callback);
    return this;
};

MQTTServer.prototype.getMessageId = function () {
    const msgId = this.messageId;
    this.messageId++;
    this.messageId &= 0xFFFFFFFF;
    return msgId;
};

MQTTServer.prototype._onConnection = function (stream, ws = false) {
    let client = ws ? mqtt(websocketStream(stream)) : mqtt(stream);
    client = hasSubscribed(client);
    client._id = client._id ||null;
    client._keepalice = client._keepalice || null;
    client._lastSeen = Date.now();
    client._messages = client._messages || {};
    client._secret = client._secret || uuid();
    client._subscriptions = client._subscriptions || {}; // {topic: qos}
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
    client.on('pingreq', packet => this._onPingReq(client));
    client.on('close', with_error => this._onClose(client, with_error ? 'unknown error' : 'closed'));
    client.on('error', error => this._onClose(client, error));
    client.on('disconnect', () => this._onClose(client, 'disconnected'));
    stream.on('timeout', () => this._onTimeout(client));
};

MQTTServer.prototype._onConnect = function (client, packet) {
    if (!!this.config.username && !!this.config.password) {
        let username = (packet.username || null).toString('utf8');
        let password = (packet.password || null).toString('utf8');
        if (this.config.username !== username || this.config.password !== password) {
            client.connack({returnCode: 4});
            client.destroy();
            return;
        }
    }

    client._id = packet.clientId;
    client._keepalice = packet.keepalive || 0;
    if (!!packet.will) {
        let will = JSON.parse(JSON.stringify(packet.will));
        will.payload = string2value(will.payload);
        client._will = will;
    }

    client.connack({returnCode: 0, sessionPresent: !client.cleanSession});
    if (!packet.clean) {
        client._persistent = true;
        client._messages = (this.clients[client._id] || {})._messages || {}; // {messageId: message}
        client._subscriptions = (this.clients[client._id] || {})._subscriptions || {}; // {topic: {qos, regex}}}
    } else {
        client._persistent = false;
        client._messages = {};
        client._subscriptions = {};
    }
    client._connected = true;
    this.clients[client._id] = client;
};

MQTTServer.prototype._onPublish = function (client, packet) {
    this.clients[client._id]._lastSeen = Date.now();

    if (packet.qos === 1) {
        client.puback({messageId: packet.messageId});
    } else if (packet.qos === 2) {
        client.pubrec({messageId: packet.messageId});
        return;
    }

    const topic = packet.topic;
    const state = string2value(packet.payload);

    if (packet.retain) {
        this.retains[topic] = state;
    }

    this.emit('publish', [topic, state]);
    this.sendMessage(topic, state);
};

MQTTServer.prototype._onPubAck = function (client, packet) {
    client._lastSeen = Date.now();
    if (client._messages.hasOwnProperty(packet.messageId)) {
        delete client._messages[packet.messageId];
    }
};

MQTTServer.prototype._onPubRec = function (client, packet) {
    client._lastSeen = Date.now();
    if (client._messages.hasOwnProperty(packet.messageId)) {
        client.pubrel({messageId: packet.messageId});
    }
};

MQTTServer.prototype._onPubComp = function (client, packet) {
    client._lastSeen = Date.now();
    if (client._messages.hasOwnProperty(packet.messageId)) {
        delete client._messages[packet.messageId];
    }
};

MQTTServer.prototype._onPubRel = function (client, packet) {
    client._lastSeen = Date.now();
    if (client._messages.hasOwnProperty(packet.messageId)) {
        client.pubcomp({messageId: packet.messageId});
        // @TODO receivedTopic
    }
};

MQTTServer.prototype._onSubscribe = function (client, packet) {
    client._lastSeen = Date.now();
    let granted = [];
    for (let i = 0; i < packet.subscriptions.length; i++) {
        const topic = packet.subscriptions[i].topic;
        const qos = packet.subscriptions[i].qos;
        if (true) { // if allowed
            granted.push(qos);
            client._subscriptions[topic] = {regex: topic2regex(topic), qos: qos};

            if (this.retains.hasOwnProperty(topic)) {
                this.sendMessageToClient(client, topic, this.retains[topic], false, qos);
            }
        } else {
            granted.push(128); // Failed
        }
    }
    client.suback({granted: granted, messageId: packet.messageId});
};

MQTTServer.prototype._onUnsubscribe = function (client, packet) {
    client._lastSeen = Date.now();
    for (let i = 0; i < packet.unsubscriptions.length; i++) {
        const topic = packet.unsubscriptions[i];
        if (client._subscriptions.hasOwnProperty(topic)) {
            delete client._subscriptions[topic];
        }
    }
    client.unsuback({messageId: packet.messageId});
};

MQTTServer.prototype._onPingReq = function (client) {
    client._lastSeen = Date.now();
    client.pingresp();
};

MQTTServer.prototype._onClose = function (client, error = null) {
    if (!this.clients.hasOwnProperty(client._id)) {
        return;
    }
    error = error !== null && typeof (error) !== "string" ? error.toString('utf8') : error;
    if (this.clients.hasOwnProperty(client._id)) {
        if (this.clients[client._id]._persistent && error !== 'cleanup') {
            this.clients[client._id]._connected = false;
        } else {
            this._sendWillMessage(client);
            delete this.clients[client._id];
        }
    }
};

MQTTServer.prototype._onTimeout = function (client) {
    this._onClose(client, 'timeout');
};

MQTTServer.prototype._sendWillMessage = function (client) {
    if (!client._will) {
        return;
    }
    this.sendMessage(client._will.topic, client._will.payload);
};

MQTTServer.prototype.sendMessage = function (topic, payload, retain = false, qos = 0) {
    setImmediate(() => { // start new thread
        Object.values(this.clients).forEach((client) => {
            this.sendMessageToClient(client, topic, payload, retain, qos);
        });
    });
};

MQTTServer.prototype.sendMessageToClient = function (client, topic, payload, retain = false, qos = 0) {
    if (!client.hasSubscribed(topic)) {
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
        payload: value2string(payload),
    }

    if (message.qos > 0) {
        client._messages[message.messageId] = message;
    }

    client.publish(message);
    return message;
};

MQTTServer.prototype.destroy = function () {
    this.resendInterval && clearInterval(this.resendInterval);
    this.cleanupInterval && clearInterval(this.cleanupInterval);
    Object.values(this.clients).forEach((client) => {
        client.destroy();
        delete this.clients[client._id];
    });
    this.sockServer && this.sockServer.close();
    this.httpServer && this.httpServer.close();
};

module.exports = MQTTServer;
