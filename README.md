# ioBroker.mqtt-broker
Mit diesem Adapter ist es Möglich alle System States via MQTT
Abzufragen und zu setzen. Weiterhin ist es kein reiner klassischer
Broker. Es ist Möglich Befehle an den ioBroker zu senden
via Topic `rpc/<command>`.

## Install
```bash
./iobroker url "https://github.com/sgc-fireball/iobroker.mqtt-broker.git"
./iobroker add mqtt-broker
```

## Uninstall
```bash
./iobroker del mqtt-broker
```

## Commands

### get_states
- Topic: `rpc/get_states`
- Value: any

Wenn diese Nachricht beim Broker ankommt, republished dieser
Anschließend alle States nochmal in Richtung des Clienst,
der an dieses Topic gesendet hat.

## MQTT WebSocket Client
```bash
npm install mqtt --save
npm install uuid --save
```
```javascript
const uuid = require('uuid').v4;
const mqtt = require('mqtt');
const client = mqtt.connect({
     clientId: uuid(), // one id per device
     keepalive: 60, // in sec
     reconnectPeriod: 10 * 1000, // in ms
     connectTimeout: 10 * 1000, // in ms
     protocol: 'ws', // or wss
     hostname: '127.0.0.1',
     port: 1884,
     path: '/mqtt',
     username: 'iobroker-username',
     password: 'iobroker-password',
     clean: true, // currently recommanded
     qos: 0,
});
client.on('connect', () => {
    client.subscribe('system.0/#');
    // or
    client.subscribe('hm-rpc.0/+/+/VOLTAGE');
    client.subscribe('hm-rpc.0/+/+/POWER');
    client.subscribe('hm-rpc.0/+/+/FREQUENCY');
    // or 
    client.subscribe('#');
});
client.on('message', (topic, message) => {
    console.log('id:', topic, 'state:', message);
});
```
