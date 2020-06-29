# ioBroker.mqtt-broker

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
- Topic: `rpc`

### rpc
- Value: `get_states`

## MQTT WebSocket Client
```bash
npm install mqtt --save
npm install uuid --save
```
```javascript
const uuid = require('uuid').v4;
const mqtt = require('mqtt');
const client = mqtt.connect({
     clientId: uuid(),
     keepalive: 60, // in sec
     reconnectPeriod: 10 * 1000, // in ms
     connectTimeout: 10 * 1000, // in ms
     protocol: 'ws',
     hostname: '127.0.0.1',
     port: 1884,
     path: '/mqtt',
     username: 'iobroker-username',
     password: 'iobroker-password',
     clean: true,
     qos: 0,
});
client.on('message', (topic, message) => {
    
});
```
